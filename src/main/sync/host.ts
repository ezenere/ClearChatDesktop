// Host de execução por chat (docs/SYNC_PROTOCOL.md §8), comandos remotos (§8.6) e streaming ao vivo
// (§11). O host roda os turnos (janela de escrita host.begin … host.end); os outros dispositivos
// são controles remotos: os comandos vão cifrados ao host e o stream volta cifrado. Sem Electron.
import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  ApiMessage,
  ApprovalRequest,
  AttachmentInfo,
  MessageMeta,
  ProcessInfo,
  QuestionAnswer,
  QuestionRequest,
  QueuedMessage,
  RetryRequest,
  Session,
  StoredMessage,
  StreamDraft
} from '@shared/types'
import type { MemoryExtractionResult } from '@shared/memory'
import { isBranchEditable, toBranchSel } from '@shared/branches'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import { parseInterChatSendMeta, type InterChatSendMeta } from '@shared/interChat'
import type { ChatHostInfo, ChatHostMode, HostStatus, TakeoverOptions } from '@shared/sync'
import {
  REMOTE_FS_LIMITS,
  type RemoteDirResult,
  type RemoteFsEntry,
  type RemoteFsFailure,
  type RemoteReadResult
} from '@shared/remoteFs'
import {
  aadCommand,
  aadCommandResult,
  aadStream,
  openJson,
  sealJson,
  type Envelope
} from './crypto'
import { WsRequestError } from './ws'
import { TRANSIENT_STATUS, usesLocalTools, type Plain } from './records'
import {
  applyDraftDelta,
  diffDraft,
  draftMatchesMessage,
  toStreamDraft,
  type DraftDelta,
  type DraftState
} from './stream'
import type { SyncEngine } from './engine'
import { TURN_COMMANDS, type TurnEndInfo } from './push'
import {
  chatRootFrom,
  hostListDir,
  hostReadFile,
  RemoteFsError,
  type RemoteFsLimits
} from './remoteFs'

/** O que o host precisa do runner (o app liga em sync/index.ts; os testes usam um stub). */
export interface RunnerAdapter {
  /** Chats com sessões rodando/esperando ou aprovação/questionário/retry pendente. */
  busyChats(): Set<string>
  /** `meta` = origem entre chats (§8.6, ≥ 1.6.0): grava como mensagem entre chats. */
  send(
    sessionId: string,
    text: string,
    attachments: AttachmentInfo[],
    skills: string[],
    meta?: InterChatSendMeta | null
  ): Promise<{ queued: boolean }>
  forceSend(queuedId: string): void
  removeQueued(queuedId: string): void
  getQueue(sessionId: string): QueuedMessage[]
  /** Tira (sem entregar) os itens da fila de todas as sessões do chat — repasse na troca de host. */
  takeChatQueues(chatId: string): QueuedMessage[]
  stop(sessionId: string): Promise<void>
  /** Para tudo do chat (principal + subagentes), parciais persistidos. */
  stopChat(chatId: string): Promise<void>
  stopSubagents(chatId: string): Promise<void>
  approve(id: string, decision: 'allow' | 'deny', items?: ApprovalItemDecision[]): void
  smartOverride(messageId: string): void
  answerQuestion(id: string, answers: QuestionAnswer[]): void
  cancelQuestion(id: string): Promise<void>
  retry(id: string): void
  cancelRetry(id: string): void
  /** Regenerar em ramo (nova versão da resposta do turno que contém `messageId`; padrão: o último). */
  regenerate(sessionId: string, messageId?: string): Promise<void>
  /** Nova versão (irmã) de uma mensagem digitada pelo usuário na sessão principal, e roda o turno. */
  editBranch(messageId: string, message: ApiMessage): Promise<void>
  /** Torna `messageId` a versão ativa (lança, em pt-BR, com a sessão ocupada). */
  selectBranch(messageId: string): Promise<Session>
  editMessage(id: string, message: ApiMessage): StoredMessage
  deleteMessage(id: string): Promise<void>
  compact(sessionId: string, opts?: { retry?: boolean }): { scheduled: boolean }
  extractMemory(sessionId: string): Promise<MemoryExtractionResult>
  approvals(): ApprovalRequest[]
  questions(): QuestionRequest[]
  retries(): RetryRequest[]
  processes(chatId: string): ProcessInfo[]
  skillsFor(chatId: string): Promise<{ name: string; description: string }[]>
  /** Fim de cada turno do runner (avisos push, §22.5). Opcional (stubs de teste). */
  onTurnEnd?(fn: (info: TurnEndInfo) => void): () => void
}

interface ServerChatState {
  chat_id: string
  ssq: number
  epoch: number
  head: number
  pinned: boolean
  host: { device_id: string; name: string; platform?: string; status: HostStatus } | null
  window: { purpose: string; since: string } | null
  handover: {
    to_device_id: string
    to_name: string
    mode: 'next_turn' | 'force'
    requested_at?: string
  } | null
  diverged: {
    divergence_id: string
    device_id: string
    device_name: string
    base: number
    head: number
    since: string
  } | null
  event?: { kind: string; device_id?: string; cmd_id?: string; reason?: string }
}

interface ToolRun {
  running: boolean
  output?: string
  judging?: boolean
}

/** Estado ao vivo espelhado de um chat cujo host é outro dispositivo. */
interface Mirror {
  epoch: number
  lastN: number
  sessions: Map<string, string>
  drafts: Map<string, DraftState>
  /**
   * Drafts já encerrados (`draft.end`) cuja mensagem persistida ainda não chegou pelo sync: seguem
   * na tela (o 1º da fila) até ela chegar — o stream é mais rápido que o push/pull dos registros e,
   * sem isso, o texto sumia entre o fim da resposta e a chegada da mensagem (ex.: durante a tool call).
   */
  ended: Map<string, StreamDraft[]>
  endedTimers: Map<string, ReturnType<typeof setTimeout>>
  tools: Map<string, Map<string, ToolRun>>
  compaction: Map<string, { state: 'scheduled' | 'running'; text?: string }>
  queues: Map<string, QueuedMessage[]>
  approvals: Map<string, ApprovalRequest>
  questions: Map<string, QuestionRequest>
  retries: Map<string, RetryRequest>
  processes: ProcessInfo[]
  skills: { name: string; description: string }[]
  resyncAt: number
}

/** Estado do publicador (host) por chat. */
interface Publisher {
  drafts: Map<string, DraftState>
  pendingDraft: Map<string, StreamDraft | null>
  draftTimer: ReturnType<typeof setTimeout> | null
  tools: Map<string, Map<string, ToolRun>>
  compaction: Map<string, { state: 'scheduled' | 'running'; text?: string }>
  sinceSnapshot: number
  lastSnapshot: number
}

interface PendingCmd {
  chatId: string
  resolve: (r: Record<string, unknown>) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Comando cujo host não existe (o controle remoto pode rodar localmente). */
export class NoHostError extends Error {}

/** O comando não teve resultado: o host caiu antes (`host_offline`) ou não respondeu a tempo. */
export class RemoteFailedError extends Error {
  code: 'host_offline' | 'command_timeout'
  constructor(code: 'host_offline' | 'command_timeout', message: string) {
    super(message)
    this.code = code
  }
}

const BUSY_STATUS = new Set([
  'running',
  'waiting',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_retry'
])
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const MAX_STREAM_ENV = 200 * 1024
/** Teto para um draft encerrado esperar a mensagem persistida (o push leva ~1 s; rede lenta, mais). */
export const ENDED_DRAFT_HOLD_MS = 8_000

/** Tipos de comando que mudam conteúdo (precisam da janela do host). */
const CONTENT_CMDS = new Set([
  'send',
  'force',
  'queue.force',
  'regenerate',
  'message.edit',
  'message.delete',
  'compact',
  'memory.extract',
  'smart_override',
  'approval',
  'question',
  'retry',
  'branch.edit',
  'branch.regenerate',
  'branch.select'
])

/**
 * Comandos de arquivos do host (§8.6, desde 1.3.0): só leitura, sem janela (nem dedupe — repetir
 * é inofensivo), aceitos com o agente rodando. Mesmas regras de raiz/confinamento da aba Arquivos.
 */
export const FS_CMDS = new Set(['fs.list', 'fs.read'])

/**
 * Janela de cada ação de conteúdo (§8.6) — no host (comando remoto) e no portão local (gateChat,
 * quando quem chama não diz): edições no lugar e trocar de versão = 'edit'; o resto roda turno.
 */
export const cmdPurpose = (kind: string): 'run' | 'edit' =>
  kind.startsWith('message.') || kind === 'branch.select' ? 'edit' : 'run'

/**
 * Kind da ação → kind do comando remoto (§8.6). Controles remotos ≥ 1.2.0 nunca mandam o
 * `regenerate` antigo: um host < 0.7 recusa `branch.regenerate` (kind desconhecido) em vez de
 * apagar as outras versões. Os demais (inclusive `branch.edit` / `branch.select`) vão como estão.
 */
export const remoteKind = (kind: string): string =>
  kind === 'regenerate' ? 'branch.regenerate' : kind

/** Resposta do host 0.7 a um `message.edit` de controle remoto antigo numa mensagem do usuário. */
export const EDIT_NEEDS_UPDATE =
  'Editar uma mensagem sua agora cria uma nova versão da conversa — atualize o ClearChat neste aparelho para editar.'

export class HostController {
  private states = new Map<string, ServerChatState>()
  private windows = new Map<string, { epoch: number; purpose: string }>()
  private beginning = new Map<string, Promise<void>>()
  private ending = new Set<string>()
  private idleSeen = new Map<string, number>()
  private handoverOut = new Map<
    string,
    { to: string; toName: string; mode: string; items: QueuedMessage[]; releasing: boolean }
  >()
  private pendingCmds = new Map<string, PendingCmd>()
  private mirrors = new Map<string, Mirror>()
  private publishers = new Map<string, Publisher>()
  private counters = new Map<string, number>()
  private reqChat = new Map<string, string>()
  private sessionChat = new Map<string, string>()
  /** Chats em que "o dispositivo remoto caiu" foi mostrado (para avisar a volta). */
  private dropShown = new Set<string>()
  private active: string | null = null
  private connected = false
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private snapTimer: ReturnType<typeof setInterval> | null = null
  private unsubAgent: (() => void) | null = null
  private skillsCache = new Map<
    string,
    { at: number; list: { name: string; description: string }[] }
  >()
  /** Tetos de fs.list/fs.read no host (os testes encolhem). */
  fsLimits: RemoteFsLimits = { ...REMOTE_FS_LIMITS }

  private engine: SyncEngine

  constructor(engine: SyncEngine) {
    this.engine = engine
  }

  private get me(): string {
    return this.engine.deviceId
  }

  private get runner(): RunnerAdapter | null {
    return this.engine.deps.runner
  }

  start(): void {
    this.loadStates()
    if (!this.unsubAgent)
      this.unsubAgent = this.engine.deps.onAgentEvent((e) => this.onAgentEvent(e))
    if (!this.idleTimer) this.idleTimer = setInterval(() => void this.idleTick(), 300)
    if (!this.snapTimer) this.snapTimer = setInterval(() => this.periodicSnapshots(), 10_000)
  }

  stop(): void {
    this.unsubAgent?.()
    this.unsubAgent = null
    if (this.idleTimer) clearInterval(this.idleTimer)
    if (this.snapTimer) clearInterval(this.snapTimer)
    this.idleTimer = this.snapTimer = null
    this.connected = false
    for (const [, p] of this.pendingCmds) {
      clearTimeout(p.timer)
      p.reject(new Error('Sync encerrado.'))
    }
    this.pendingCmds.clear()
    for (const id of [...this.mirrors.keys()]) this.clearMirror(id)
  }

  reset(): void {
    this.stop()
    this.states.clear()
    this.windows.clear()
    this.handoverOut.clear()
    this.counters.clear()
    this.publishers.clear()
  }

  private loadStates(): void {
    const rows = this.engine.conn
      .prepare('SELECT chat_id, state FROM sync_chat WHERE state IS NOT NULL')
      .all() as { chat_id: string; state: string }[]
    for (const r of rows) {
      try {
        const s = JSON.parse(r.state) as ServerChatState
        if (!this.states.has(r.chat_id)) this.states.set(r.chat_id, s)
      } catch {
        /* */
      }
    }
  }

  // ---------------- estado / modo ----------------

  private chatOfSession(sessionId: string): string | null {
    const hit = this.sessionChat.get(sessionId)
    if (hit) return hit
    const r = this.engine.conn
      .prepare('SELECT chat_id FROM sessions WHERE id = ?')
      .get(sessionId) as { chat_id: string } | undefined
    if (r) this.sessionChat.set(sessionId, r.chat_id)
    return r?.chat_id ?? null
  }

  chatIdOfSession(sessionId: string): string | null {
    return this.chatOfSession(sessionId)
  }

  mode(chatId: string): ChatHostMode {
    if (!this.engine.active) return 'off'
    const st = this.states.get(chatId)
    if (st?.diverged) return 'diverged'
    if (!this.connected) return 'offline'
    if (!st?.host || st.host.device_id === this.me) return 'local'
    if (st.host.status === 'online') return 'remote'
    return 'host-offline'
  }

  isDiverged(chatId: string): boolean {
    return !!this.states.get(chatId)?.diverged
  }

  isDivergedSelf(chatId: string): boolean {
    return this.states.get(chatId)?.diverged?.device_id === this.me
  }

  divergedState(chatId: string): ServerChatState['diverged'] {
    return this.states.get(chatId)?.diverged ?? null
  }

  windowOpen(chatId: string): boolean {
    return !!this.states.get(chatId)?.window
  }

  /** O chat é executado em OUTRO dispositivo (o banco local não tem o status ao vivo). */
  hostedElsewhere(chatId: string): boolean {
    const h = this.states.get(chatId)?.host
    return !!h && h.device_id !== this.me
  }

  /** Status gravado no último registro `session` recebido (o banco guarda transitório como interrupted). */
  private recordStatus(sessionId: string): string | null {
    const st = this.engine.basePlain(this.engine.record('session', sessionId))?.status
    return typeof st === 'string' ? st : null
  }

  /**
   * Sessão com o status a EXIBIR (§4.3.7). Chat executado em outro dispositivo: o status ao vivo do
   * espelho (chat aberto) → com a janela do host aberta, o transitório do último registro (ex.:
   * `running` de um chat que não está aberto aqui) → o do banco (transitório sem janela =
   * `interrupted`). No host (e sem sync), o banco já é o ao vivo.
   */
  displaySession(s: Session): Session {
    if (!this.engine.active || !this.hostedElsewhere(s.chatId)) return s
    const live = this.mirrors.get(s.chatId)?.sessions.get(s.id)
    if (live) return live === s.status ? s : { ...s, status: live as Session['status'] }
    if (!this.windowOpen(s.chatId)) return s
    const rec = this.recordStatus(s.id)
    if (rec && TRANSIENT_STATUS.has(rec) && rec !== s.status)
      return { ...s, status: rec as Session['status'] }
    return s
  }

  hostName(chatId: string): string {
    return this.states.get(chatId)?.host?.name ?? 'outro dispositivo'
  }

  info(chatId: string): ChatHostInfo {
    const st = this.states.get(chatId)
    const row = this.engine.chatRow(chatId)
    let cfg: Plain = {}
    try {
      const r = this.engine.conn
        .prepare('SELECT config_json FROM chats WHERE id = ?')
        .get(chatId) as { config_json: string } | undefined
      cfg = r ? (JSON.parse(r.config_json) as Plain) : {}
    } catch {
      /* */
    }
    let hostCwd: ChatHostInfo['hostCwd'] = null
    try {
      hostCwd = row.host_cwd ? JSON.parse(row.host_cwd) : null
    } catch {
      /* */
    }
    return {
      chatId,
      mode: this.mode(chatId),
      host: st?.host
        ? {
            deviceId: st.host.device_id,
            name: st.host.name,
            status: st.host.device_id === this.me && this.connected ? 'online' : st.host.status,
            self: st.host.device_id === this.me
          }
        : null,
      running: !!st?.window || (this.runner?.busyChats().has(chatId) ?? false),
      pinned: !!st?.pinned,
      epoch: st?.epoch ?? 0,
      handover: st?.handover
        ? {
            toDeviceId: st.handover.to_device_id,
            toName: st.handover.to_name,
            mode: st.handover.mode,
            self: st.handover.to_device_id === this.me
          }
        : null,
      diverged: st?.diverged
        ? {
            divergenceId: st.diverged.divergence_id,
            deviceId: st.diverged.device_id,
            deviceName: st.diverged.device_name,
            since: st.diverged.since,
            self: st.diverged.device_id === this.me
          }
        : null,
      usesLocalTools: usesLocalTools(cfg),
      hostCwd,
      needsCwd: row.cwd_confirmed === -1
    }
  }

  allInfos(): ChatHostInfo[] {
    const ids = (this.engine.conn.prepare('SELECT id FROM chats').all() as { id: string }[]).map(
      (r) => r.id
    )
    return ids.map((id) => this.info(id))
  }

  private emitInfo(chatId: string): void {
    this.engine.emit({ type: 'sync-chat-state', info: this.info(chatId) })
  }

  /** ChatState vindo do servidor (welcome, chat.state, erros, GET /chat-states). */
  onChatState(raw: Record<string, unknown>, live: boolean): void {
    const s = raw as unknown as ServerChatState
    if (!s?.chat_id) return
    const id = s.chat_id
    const prev = this.states.get(id)
    if (prev && typeof s.ssq === 'number' && s.ssq < prev.ssq) return
    const { event, ...state } = s
    this.states.set(id, state as ServerChatState)
    try {
      this.engine.setChatRow(id, { state: JSON.stringify(state) })
    } catch {
      /* chat sem linha */
    }
    if (typeof s.head === 'number' && s.head) this.engine.bumpHead(id, s.head, false)
    if (
      this.windows.has(id) &&
      (s.host?.device_id !== this.me || (!s.window && !this.beginning.has(id)))
    ) {
      // janela perdida (tolerância expirou / outro host): conteúdo pendente vira replay
      this.windows.delete(id)
    }
    if (!s.window) {
      this.endMirrorTurn(id)
      // janela fechou sem o status final (host caiu): o que aparecia como transitório vira o gravado
      if (prev?.window && this.hostedElsewhere(id)) this.emitStaleTransient(id)
      // a janela de outro fechou: conteúdo local que esperava pode subir agora (replay)
      if (prev?.window && this.engine.hasPendingContent(id)) this.engine.schedulePush()
    }
    if (live && event) this.onStateEvent(id, s, prev, event)
    this.emitInfo(id)
  }

  private emitStaleTransient(chatId: string): void {
    for (const s of this.engine.sessionsOf(chatId)) {
      const rec = this.recordStatus(s.id)
      if (rec && TRANSIENT_STATUS.has(rec)) this.emitM({ type: 'session-updated', session: s })
    }
  }

  private onStateEvent(
    id: string,
    s: ServerChatState,
    prev: ServerChatState | undefined,
    ev: NonNullable<ServerChatState['event']>
  ): void {
    const title = (): string =>
      (
        this.engine.conn.prepare('SELECT title FROM chats WHERE id = ?').get(id) as
          { title: string } | undefined
      )?.title || 'chat'
    switch (ev.kind) {
      case 'host_dropped':
        if (s.host && s.host.device_id !== this.me) {
          this.dropShown.add(id)
          this.engine.emit({
            type: 'sync-notice',
            kind: 'error',
            text: `O dispositivo remoto (${s.host.name}) caiu.`,
            chatId: id
          })
        }
        break
      case 'host_back': {
        // `host_back` também vem depois de uma piscada na tolerância (sem "caiu" antes): só avisa a
        // volta se a queda foi mostrada (ou o estado anterior já era offline)
        const shown = this.dropShown.delete(id) || prev?.host?.status === 'offline'
        if (shown && s.host && s.host.device_id !== this.me)
          this.engine.emit({
            type: 'sync-notice',
            kind: 'info',
            text: `${s.host.name} voltou a ficar online.`,
            chatId: id
          })
        break
      }
      case 'host_changed':
        this.dropShown.delete(id)
        if (s.host?.device_id === this.me && prev?.host?.device_id !== this.me)
          this.onBecameHost(id)
        else if (prev?.host?.device_id === this.me && s.host?.device_id !== this.me) {
          this.windows.delete(id)
          this.engine.emit({
            type: 'sync-notice',
            kind: 'info',
            text: `“${title()}” agora é executado em ${s.host?.name ?? 'outro dispositivo'}.`,
            chatId: id
          })
        }
        this.clearMirror(id)
        if (this.active === id) this.resync(id)
        break
      case 'diverged':
        this.engine.emit({
          type: 'sync-notice',
          kind: 'error',
          text: `“${title()}” ficou divergente: escolha qual versão manter.`,
          chatId: id
        })
        break
      case 'resolved':
        if (prev?.diverged?.device_id === this.me && ev.device_id !== this.me)
          void this.engine
            .discardLocalVersion(id)
            .catch((e) => this.engine.log('descartar versão', errMsg(e)))
        break
    }
  }

  markDiverged(chatId: string, d: Record<string, unknown> | null): void {
    const st = this.states.get(chatId) ?? this.blankState(chatId)
    if (d) st.diverged = d as ServerChatState['diverged']
    else if (!st.diverged)
      st.diverged = {
        divergence_id: '',
        device_id: this.me,
        device_name: this.engine.deviceName,
        base: 0,
        head: 0,
        since: new Date().toISOString()
      }
    this.states.set(chatId, { ...st })
    this.engine.setChatRow(chatId, { state: JSON.stringify(st) })
    this.emitInfo(chatId)
    void this.engine.loadChatStates().catch(() => undefined)
  }

  clearDiverged(chatId: string): void {
    const st = this.states.get(chatId)
    if (!st) return
    st.diverged = null
    this.engine.setChatRow(chatId, { state: JSON.stringify(st) })
    this.emitInfo(chatId)
  }

  forgetChat(chatId: string): void {
    this.states.delete(chatId)
    this.windows.delete(chatId)
    this.clearMirror(chatId)
  }

  private blankState(chatId: string): ServerChatState {
    return {
      chat_id: chatId,
      ssq: 0,
      epoch: 0,
      head: 0,
      pinned: false,
      host: null,
      window: null,
      handover: null,
      diverged: null
    }
  }

  // ---------------- conexão ----------------

  onConnection(online: boolean): void {
    const was = this.connected
    this.connected = online
    if (was !== online) for (const id of this.states.keys()) this.emitInfo(id)
    if (!online) {
      for (const [, p] of this.pendingCmds) {
        clearTimeout(p.timer)
        p.reject(
          new Error('Conexão com o servidor perdida — o comando pode não ter sido entregue.')
        )
      }
      this.pendingCmds.clear()
    }
  }

  activeWindows(): { chat_id: string; epoch: number }[] {
    return [...this.windows].map(([chat_id, w]) => ({ chat_id, epoch: w.epoch }))
  }

  /** Epoch da janela aberta por este dispositivo no chat (null = sem janela → replay). */
  windowEpoch(chatId: string): number | null {
    return this.windows.get(chatId)?.epoch ?? null
  }

  subscriptions(): string[] {
    return this.active ? [this.active] : []
  }

  onWelcome(w: Record<string, unknown>): void {
    this.connected = true
    for (const s of (w.chat_states as Record<string, unknown>[]) ?? []) this.onChatState(s, false)
    for (const id of (w.lost_windows as string[]) ?? []) this.windows.delete(id)
    for (const id of this.states.keys()) this.emitInfo(id)
    if (this.active && this.mode(this.active) === 'remote') this.resync(this.active)
  }

  // ---------------- janela de escrita ----------------

  private busy(chatId: string): boolean {
    return this.runner?.busyChats().has(chatId) ?? false
  }

  /**
   * Garante a janela do host antes de rodar/editar (§8.5). Sem conexão: execução offline (nada a
   * fazer). Erros legíveis quando outro dispositivo é o host.
   */
  async ensureWindow(chatId: string, purpose: 'run' | 'edit' | 'replay' = 'run'): Promise<void> {
    if (!this.engine.active || !this.connected) return
    if (this.windows.has(chatId)) return
    const cur = this.beginning.get(chatId)
    if (cur) return cur
    const p = (async () => {
      const st = this.states.get(chatId)
      const epoch = st?.host?.device_id === this.me ? st.epoch : null
      let ack: Record<string, unknown>
      try {
        ack = await this.engine.ws.request('host.begin', { chat_id: chatId, epoch, purpose })
      } catch (e) {
        if (e instanceof WsRequestError) {
          if (e.code === 'disconnected' || e.code === 'timeout') return
          if (e.details.state) this.onChatState(e.details.state as Record<string, unknown>, false)
          if (e.code === 'not_host')
            throw new Error(`Este chat é executado em ${this.hostName(chatId)}.`, { cause: e })
          if (e.code === 'chat_diverged') {
            this.markDiverged(chatId, (e.details.diverged as Record<string, unknown>) ?? null)
            throw new Error('Este chat está divergente: escolha qual versão manter.', { cause: e })
          }
          if (e.code === 'handover_pending')
            throw new Error('Há uma troca de host em andamento neste chat.', { cause: e })
          if (e.code === 'cannot_host')
            throw new Error('Este dispositivo não pode executar chats.', { cause: e })
        }
        throw e
      }
      const ep = Number(ack.epoch ?? 0)
      this.windows.set(chatId, { epoch: ep, purpose })
      const st2 = this.states.get(chatId) ?? this.blankState(chatId)
      const became = !!ack.became_host || st2.host?.device_id !== this.me
      this.states.set(chatId, {
        ...st2,
        epoch: ep,
        host: { device_id: this.me, name: this.engine.deviceName, status: 'online' },
        window: { purpose, since: new Date().toISOString() }
      })
      if (became) this.onBecameHost(chatId)
      const head = Number(ack.head ?? 0)
      if (head > this.engine.cursor()) await this.engine.pullUntil(head).catch(() => undefined)
      await this.engine.prefetchChatAttachments(chatId).catch(() => undefined)
      this.emitInfo(chatId)
    })().finally(() => this.beginning.delete(chatId))
    this.beginning.set(chatId, p)
    return p
  }

  /** Virou host: grava a raiz local no chat (hostCwd, informativo). */
  private onBecameHost(chatId: string): void {
    try {
      const r = this.engine.conn
        .prepare('SELECT config_json FROM chats WHERE id = ?')
        .get(chatId) as { config_json: string } | undefined
      const cwd = r ? (JSON.parse(r.config_json) as Plain).cwd : null
      if (typeof cwd === 'string' && cwd) {
        const hc = JSON.stringify({ deviceId: this.me, path: cwd })
        if (this.engine.chatRow(chatId).host_cwd !== hc) {
          this.engine.setChatRow(chatId, { host_cwd: hc })
          this.engine.markDirty('chat', chatId, chatId)
        }
      }
    } catch {
      /* */
    }
  }

  dropWindow(chatId: string): void {
    this.windows.delete(chatId)
  }

  /** Modo do próximo push de conteúdo do chat: com janela (epoch) / replay (null) / esperar. */
  async pushModeFor(chatId: string): Promise<{ epoch: number | null } | null> {
    if (this.isDiverged(chatId)) return null
    const w = this.windows.get(chatId)
    if (w) return { epoch: w.epoch }
    if (!this.connected) return { epoch: null }
    const st = this.states.get(chatId)
    const canHost = !st?.host || st.host.device_id === this.me
    if (st?.window && st.host?.device_id !== this.me) return null // janela de outro → chat_busy
    if (canHost && (this.busy(chatId) || st?.window)) {
      try {
        await this.ensureWindow(chatId, 'run')
      } catch {
        return null
      }
      const w2 = this.windows.get(chatId)
      return w2 ? { epoch: w2.epoch } : null
    }
    return { epoch: null }
  }

  private async idleTick(): Promise<void> {
    if (!this.connected) return
    const now = Date.now()
    for (const [chatId, w] of [...this.windows]) {
      if (this.ending.has(chatId) || this.beginning.has(chatId)) continue
      if (this.busy(chatId)) {
        this.idleSeen.delete(chatId)
        continue
      }
      if (this.engine.hasPendingContent(chatId)) {
        this.engine.schedulePush()
        this.idleSeen.delete(chatId)
        continue
      }
      const seen = this.idleSeen.get(chatId)
      if (!seen) {
        this.idleSeen.set(chatId, now)
        continue
      }
      if (now - seen < 700) continue
      this.idleSeen.delete(chatId)
      this.ending.add(chatId)
      try {
        const ack = await this.engine.ws.request('host.end', { chat_id: chatId, epoch: w.epoch })
        this.windows.delete(chatId)
        const st = this.states.get(chatId)
        if (st) this.states.set(chatId, { ...st, window: null })
        this.emitInfo(chatId)
        if (ack.handover_pending || this.handoverOut.has(chatId)) await this.release(chatId)
      } catch (e) {
        if (e instanceof WsRequestError && e.code === 'not_host') this.windows.delete(chatId)
      } finally {
        this.ending.delete(chatId)
      }
    }
    for (const [chatId, h] of [...this.handoverOut]) {
      if (h.releasing || this.windows.has(chatId) || this.busy(chatId)) continue
      if (this.engine.hasPendingContent(chatId)) {
        this.engine.schedulePush()
        continue
      }
      await this.release(chatId)
    }
  }

  // ---------------- troca de host ----------------

  async takeover(chatId: string, opts: TakeoverOptions): Promise<ChatHostInfo> {
    if (!this.engine.active) throw new Error('Entre na conta para trocar o host.')
    if (!this.connected) throw new Error('Sem conexão com o servidor.')
    let ack: Record<string, unknown>
    try {
      ack = await this.engine.ws.request('host.takeover', {
        chat_id: chatId,
        mode: opts.mode,
        confirm_pinned: !!opts.confirmPinned
      })
    } catch (e) {
      if (e instanceof WsRequestError) {
        if (e.details.state) this.onChatState(e.details.state as Record<string, unknown>, false)
        if (e.code === 'host_pinned')
          throw new Error(
            'O host deste chat está fixado — confirme para executar aqui mesmo assim.',
            { cause: e }
          )
        if (e.code === 'chat_diverged')
          throw new Error('Este chat está divergente: escolha a versão antes.', { cause: e })
        if (e.code === 'handover_pending')
          throw new Error('Já há uma troca de host em andamento.', { cause: e })
        if (e.code === 'cannot_host')
          throw new Error('Este dispositivo não pode executar chats.', { cause: e })
      }
      throw e
    }
    if (ack.status === 'granted') {
      const st = this.states.get(chatId) ?? this.blankState(chatId)
      this.states.set(chatId, {
        ...st,
        epoch: Number(ack.epoch ?? st.epoch),
        host: { device_id: this.me, name: this.engine.deviceName, status: 'online' },
        window: null,
        handover: null
      })
      this.onBecameHost(chatId)
      this.clearMirror(chatId)
      if (Number(ack.head ?? 0) > this.engine.cursor())
        await this.engine.pullUntil(Number(ack.head)).catch(() => undefined)
    } else {
      const st = this.states.get(chatId) ?? this.blankState(chatId)
      this.states.set(chatId, {
        ...st,
        handover: { to_device_id: this.me, to_name: this.engine.deviceName, mode: opts.mode }
      })
    }
    this.emitInfo(chatId)
    return this.info(chatId)
  }

  async cancelHandover(chatId: string): Promise<void> {
    await this.engine.ws.request('host.handover_cancel', { chat_id: chatId })
    const h = this.handoverOut.get(chatId)
    if (h && !h.releasing) {
      // volta os itens repassáveis para a fila local (reenviados como mensagens)
      this.handoverOut.delete(chatId)
      for (const it of h.items)
        void this.runner
          ?.send(it.sessionId, it.text, it.attachments ?? [], skillNames(it))
          .catch(() => undefined)
    }
  }

  async setPinned(chatId: string, pinned: boolean): Promise<void> {
    await this.engine.ws.request('host.pin', { chat_id: chatId, pinned })
    const st = this.states.get(chatId)
    if (st) this.states.set(chatId, { ...st, pinned })
    this.emitInfo(chatId)
  }

  /** Pedido de troca chegou (somos o host): para de puxar a fila; force = para tudo. */
  private async onHandoverRequest(f: Record<string, unknown>): Promise<void> {
    const chatId = String(f.chat_id)
    const mode = String(f.mode ?? 'next_turn')
    const items = this.runner?.takeChatQueues(chatId) ?? []
    const cur = this.handoverOut.get(chatId)
    this.handoverOut.set(chatId, {
      to: String(f.to_device_id),
      toName: String(f.to_name ?? ''),
      mode,
      items: [...(cur?.items ?? []), ...items],
      releasing: false
    })
    this.engine.emit({
      type: 'sync-notice',
      kind: 'info',
      text:
        mode === 'force'
          ? `${String(f.to_name ?? 'Outro dispositivo')} assumiu o chat agora — parando o turno.`
          : `${String(f.to_name ?? 'Outro dispositivo')} vai assumir o chat ao fim do turno.`,
      chatId
    })
    if (mode === 'force') await this.runner?.stopChat(chatId).catch(() => undefined)
  }

  /** Libera o host (repassando a fila local como comandos `send`, §8.8). */
  private async release(chatId: string): Promise<void> {
    const h = this.handoverOut.get(chatId)
    const st = this.states.get(chatId)
    if (h) h.releasing = true
    const sk = this.engine.sk
    const forwarded: { cmd_id: string; env: Envelope }[] = []
    if (h && sk) {
      for (const it of h.items) {
        const cmd_id = randomUUID()
        forwarded.push({
          cmd_id,
          env: sealJson(sk.stream, aadCommand(this.engine.userId, chatId, cmd_id), {
            sv: 1,
            kind: 'send',
            sessionId: it.sessionId,
            text: it.text,
            attachments: it.attachments ?? [],
            skills: skillNames(it),
            createdAt: it.createdAt
          })
        })
      }
    }
    try {
      await this.engine.ws.request('host.release', {
        chat_id: chatId,
        epoch: st?.epoch ?? 0,
        forwarded
      })
      this.handoverOut.delete(chatId)
      this.windows.delete(chatId)
    } catch (e) {
      if (h) h.releasing = false
      this.engine.log('host.release falhou', errMsg(e))
      if (e instanceof WsRequestError && (e.code === 'not_host' || e.code === 'invalid_request'))
        this.handoverOut.delete(chatId)
    }
  }

  /** Mensagem enviada aqui enquanto o host está sendo repassado: vai junto na troca. */
  forwardOnHandover(chatId: string, item: Omit<QueuedMessage, 'id' | 'createdAt'>): boolean {
    const h = this.handoverOut.get(chatId)
    if (!h || h.releasing) return false
    h.items.push({ ...item, id: randomUUID(), createdAt: Date.now() })
    return true
  }

  // ---------------- eventos do servidor ----------------

  onEvent(f: Record<string, unknown>): void {
    switch (f.t) {
      case 'chat.state':
        this.onChatState(f, true)
        return
      case 'host.granted': {
        const chatId = String(f.chat_id)
        const st = this.states.get(chatId) ?? this.blankState(chatId)
        this.states.set(chatId, {
          ...st,
          epoch: Number(f.epoch ?? st.epoch),
          host: { device_id: this.me, name: this.engine.deviceName, status: 'online' },
          window: null,
          handover: null
        })
        this.onBecameHost(chatId)
        this.clearMirror(chatId)
        void this.engine.pullUntil(Number(f.head ?? 0)).catch(() => undefined)
        this.engine.emit({
          type: 'sync-notice',
          kind: 'success',
          text: 'Este dispositivo agora executa o chat.',
          chatId
        })
        this.emitInfo(chatId)
        return
      }
      case 'host.revoked': {
        const chatId = String(f.chat_id)
        this.windows.delete(chatId)
        this.handoverOut.delete(chatId)
        if (f.reason !== 'handover' && this.busy(chatId))
          void this.runner?.stopChat(chatId).catch(() => undefined)
        this.emitInfo(chatId)
        return
      }
      case 'host.handover_request':
        void this.onHandoverRequest(f)
        return
      case 'remote.command':
        void this.onRemoteCommand(f)
        return
      case 'remote.result':
      case 'remote.failed':
        this.onRemoteResult(f)
        return
      case 'stream.event':
        this.onStreamEvent(f)
        return
      case 'stream.resync_request':
        void this.sendSnapshot(String(f.chat_id))
        return
    }
  }

  // ---------------- comandos remotos: controle remoto → host ----------------

  /**
   * Cifra e envia um comando ao host e espera o `remote.result` decifrado. Erros crus: o
   * `WsRequestError` do `remote.send`, ou `RemoteFailedError` (host caiu / sem resposta).
   */
  private async commandResult(
    chatId: string,
    kind: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    timeoutText: string
  ): Promise<Record<string, unknown>> {
    const sk = this.engine.sk
    if (!sk) throw new Error('Conta bloqueada.')
    const cmd_id = randomUUID()
    const env = sealJson(sk.stream, aadCommand(this.engine.userId, chatId, cmd_id), {
      sv: 1,
      kind,
      ...payload
    })
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(cmd_id)
        reject(new RemoteFailedError('command_timeout', timeoutText))
      }, timeoutMs)
      this.pendingCmds.set(cmd_id, { chatId, resolve, reject, timer })
    })
    result.catch(() => undefined)
    try {
      await this.engine.ws.request('remote.send', { chat_id: chatId, cmd_id, kind, env })
    } catch (e) {
      const p = this.pendingCmds.get(cmd_id)
      if (p) clearTimeout(p.timer)
      this.pendingCmds.delete(cmd_id)
      throw e
    }
    return result
  }

  /** Envia um comando ao host do chat e espera o resultado (accepted / rejected / falha). */
  async sendCommand(
    chatId: string,
    kind: string,
    payload: Record<string, unknown>
  ): Promise<{ status: string; queued?: boolean; error?: string }> {
    const k = remoteKind(kind)
    const name = this.hostName(chatId)
    let r: { status: string; queued?: boolean; error?: string }
    try {
      r = (await this.commandResult(
        chatId,
        k,
        payload,
        40_000,
        `O host (${name}) não respondeu a tempo — o comando pode não ter sido entregue.`
      )) as typeof r
    } catch (e) {
      if (e instanceof WsRequestError) {
        if (e.code === 'host_offline')
          throw new Error(`O host (${name}) está offline.`, { cause: e })
        if (e.code === 'no_host') throw new NoHostError('Este chat não tem host.')
        if (e.code === 'chat_diverged') {
          this.markDiverged(chatId, (e.details.diverged as Record<string, unknown>) ?? null)
          throw new Error('Este chat está divergente: escolha a versão antes.', { cause: e })
        }
        if (e.code === 'disconnected' || e.code === 'timeout')
          throw new Error('Sem conexão com o servidor — não foi possível enviar ao host.', {
            cause: e
          })
      }
      throw e
    }
    if (r.status === 'rejected') throw new Error(rejectText(r.error, name))
    return r
  }

  // ---------------- arquivos do host (controle remoto → host, §8.6 fs.*) ----------------

  /** Aba Arquivos do host: lista `path` (vazio = raiz do chat no host). Nunca lança. */
  async fsList(chatId: string, path: string): Promise<RemoteDirResult> {
    const pre = this.fsPrecheck(chatId)
    if (pre) return pre
    try {
      const r = await this.fsCommand(chatId, 'fs.list', { chatId, path: String(path ?? '') })
      if (r.status !== 'accepted') return this.fsRejected(chatId, r)
      if (typeof r.dir !== 'string' || !Array.isArray(r.entries))
        throw new Error('Resposta inválida do host.')
      const entries: RemoteFsEntry[] = []
      for (const x of r.entries as Record<string, unknown>[]) {
        const name = x && typeof x.name === 'string' ? x.name : ''
        // nome com separador / NUL / . / .. não vira caminho no controle remoto
        if (!name || /[/\\\0]/.test(name) || name === '.' || name === '..') continue
        const num = (v: unknown): number | undefined =>
          typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
        const size = num(x.size)
        const mtime = num(x.mtime)
        entries.push({
          name,
          kind: x.kind === 'dir' ? 'dir' : 'file',
          ...(size !== undefined ? { size } : {}),
          ...(mtime !== undefined ? { mtime } : {})
        })
      }
      return {
        ok: true,
        dir: r.dir,
        root: typeof r.root === 'string' && r.root ? r.root : r.dir,
        confine: r.confine !== false,
        truncated: r.truncated === true,
        entries
      }
    } catch (e) {
      return this.fsFailure(chatId, e)
    }
  }

  /** Um pedaço (até REMOTE_FS_LIMITS.chunkBytes) de um arquivo do host. Nunca lança. */
  async fsRead(
    chatId: string,
    path: string,
    offset: number,
    length: number
  ): Promise<RemoteReadResult> {
    const pre = this.fsPrecheck(chatId)
    if (pre) return pre
    try {
      const r = await this.fsCommand(chatId, 'fs.read', { chatId, path, offset, length })
      if (r.status !== 'accepted') return this.fsRejected(chatId, r)
      const size = r.size
      const mtime = r.mtime
      if (
        typeof size !== 'number' ||
        typeof mtime !== 'number' ||
        r.offset !== offset ||
        typeof r.data !== 'string'
      )
        throw new Error('Resposta inválida do host.')
      const data = Buffer.from(r.data, 'base64')
      if (data.length > Math.max(length, 0)) throw new Error('Resposta inválida do host.')
      return {
        ok: true,
        size,
        mtime,
        ...(typeof r.mime === 'string' && r.mime ? { mime: r.mime } : {}),
        offset,
        data: new Uint8Array(data.buffer, data.byteOffset, data.length)
      }
    } catch (e) {
      return this.fsFailure(chatId, e)
    }
  }

  private fsCommand(
    chatId: string,
    kind: 'fs.list' | 'fs.read',
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.commandResult(
      chatId,
      kind,
      payload,
      REMOTE_FS_LIMITS.timeoutMs,
      `O host (${this.hostName(chatId)}) não respondeu a tempo.`
    )
  }

  private fsFail(
    chatId: string,
    reason: RemoteFsFailure['reason'],
    message: string
  ): RemoteFsFailure {
    return { ok: false, reason, message, deviceName: this.hostName(chatId) }
  }

  /** Só com o host online (§8.6): offline/sem conexão viram "Host offline" sem ir à rede. */
  private fsPrecheck(chatId: string): RemoteFsFailure | null {
    const mode = this.mode(chatId)
    const name = this.hostName(chatId)
    switch (mode) {
      case 'remote':
        return null
      case 'host-offline':
        return this.fsFail(chatId, 'host-offline', `O host (${name}) está offline.`)
      case 'offline':
        return this.fsFail(chatId, 'host-offline', 'Sem conexão com o servidor do sync.')
      case 'diverged':
        return this.fsFail(chatId, 'error', 'Este chat está divergente: escolha a versão antes.')
      case 'local':
        return this.fsFail(chatId, 'error', 'Este dispositivo executa o chat.')
      default:
        return this.fsFail(chatId, 'error', 'Sync desligado.')
    }
  }

  private fsRejected(chatId: string, r: Record<string, unknown>): RemoteFsFailure {
    const name = this.hostName(chatId)
    const error = typeof r.error === 'string' ? r.error : ''
    // host < 1.3.0 (app 0.7) não conhece fs.*
    if (/^comando desconhecido: fs\./.test(error))
      return this.fsFail(
        chatId,
        'unsupported',
        `O host (${name}) usa uma versão antiga do ClearChat — atualize o app nele para ver os arquivos.`
      )
    if (error === 'not_host')
      return this.fsFail(chatId, 'host-offline', `${name} não é mais o host deste chat.`)
    if (r.code === 'denied') return this.fsFail(chatId, 'denied', error || 'Acesso negado.')
    if (r.code === 'missing')
      return this.fsFail(chatId, 'missing', error || 'Arquivo não encontrado.')
    return this.fsFail(chatId, 'error', error || `O host (${name}) recusou o pedido.`)
  }

  private fsFailure(chatId: string, e: unknown): RemoteFsFailure {
    const name = this.hostName(chatId)
    if (e instanceof RemoteFailedError)
      return e.code === 'host_offline'
        ? this.fsFail(chatId, 'host-offline', `O host (${name}) caiu antes de responder.`)
        : this.fsFail(chatId, 'error', `O host (${name}) não respondeu a tempo.`)
    if (e instanceof WsRequestError) {
      if (e.code === 'host_offline')
        return this.fsFail(chatId, 'host-offline', `O host (${name}) está offline.`)
      if (e.code === 'no_host')
        return this.fsFail(chatId, 'host-offline', 'Este chat não tem host.')
      if (e.code === 'chat_diverged') {
        this.markDiverged(chatId, (e.details.diverged as Record<string, unknown>) ?? null)
        return this.fsFail(chatId, 'error', 'Este chat está divergente: escolha a versão antes.')
      }
      // servidor < 1.3.0 recusa o kind desconhecido
      if (e.code === 'invalid_request')
        return this.fsFail(
          chatId,
          'unsupported',
          'O servidor do sync ainda não permite ver arquivos do host — atualize o servidor.'
        )
      if (e.code === 'disconnected' || e.code === 'timeout')
        return this.fsFail(
          chatId,
          'host-offline',
          'Sem conexão com o servidor — não foi possível falar com o host.'
        )
    }
    return this.fsFail(chatId, 'error', errMsg(e))
  }

  private onRemoteResult(f: Record<string, unknown>): void {
    const cmd = String(f.cmd_id)
    const p = this.pendingCmds.get(cmd)
    if (!p) return
    this.pendingCmds.delete(cmd)
    clearTimeout(p.timer)
    const name = this.hostName(p.chatId)
    if (f.t === 'remote.failed') {
      p.reject(
        f.code === 'command_timeout'
          ? new RemoteFailedError(
              'command_timeout',
              `O host (${name}) não respondeu a tempo — a mensagem pode não ter sido entregue.`
            )
          : new RemoteFailedError(
              'host_offline',
              `O host (${name}) caiu antes de confirmar — a mensagem pode não ter sido entregue.`
            )
      )
      return
    }
    try {
      const sk = this.engine.sk!
      const r = openJson(
        sk.stream,
        aadCommandResult(this.engine.userId, p.chatId, cmd),
        f.env as Envelope
      )
      p.resolve(r)
    } catch (e) {
      p.reject(new Error(`Resposta inválida do host: ${errMsg(e)}`))
    }
  }

  // ---------------- comandos remotos: host executa ----------------

  private async onRemoteCommand(f: Record<string, unknown>): Promise<void> {
    const chatId = String(f.chat_id)
    const cmdId = String(f.cmd_id)
    const kind = String(f.kind)
    const sk = this.engine.sk
    if (!sk) return
    const reply = async (r: Record<string, unknown>): Promise<void> => {
      try {
        await this.engine.ws.request('remote.result', {
          chat_id: chatId,
          cmd_id: cmdId,
          env: sealJson(sk.stream, aadCommandResult(this.engine.userId, chatId, cmdId), {
            sv: 1,
            ...r
          })
        })
      } catch (e) {
        this.engine.log('remote.result falhou', errMsg(e))
      }
    }
    const conn = this.engine.conn
    const isFs = FS_CMDS.has(kind)
    // fs.* são leituras: sem dedupe (repetir é inofensivo; um arquivo grande são centenas de pedaços)
    if (!isFs) {
      const seen = conn
        .prepare('SELECT result FROM sync_commands_seen WHERE cmd_id = ?')
        .get(cmdId) as { result: string | null } | undefined
      if (seen) return reply({ status: 'duplicate' })
      conn
        .prepare('INSERT OR IGNORE INTO sync_commands_seen (cmd_id, at) VALUES (?, ?)')
        .run(cmdId, Date.now())
      conn.prepare('DELETE FROM sync_commands_seen WHERE at < ?').run(Date.now() - 7 * 86_400_000)
    }
    let payload: Record<string, unknown>
    try {
      payload = openJson(
        sk.stream,
        aadCommand(this.engine.userId, chatId, cmdId),
        f.env as Envelope
      )
    } catch (e) {
      return reply({ status: 'rejected', error: `comando ilegível: ${errMsg(e)}` })
    }
    const st = this.states.get(chatId)
    if (st?.host && st.host.device_id !== this.me)
      return reply({ status: 'rejected', error: 'not_host' })
    if (isFs) {
      try {
        await reply({ status: 'accepted', ...(await this.executeFs(chatId, kind, payload)) })
      } catch (e) {
        await reply({
          status: 'rejected',
          error: errMsg(e),
          ...(e instanceof RemoteFsError ? { code: e.code } : {})
        })
      }
      return
    }
    // turno vindo de outro dispositivo: o aviso push de resposta/pendência vai para ele se for um
    // celular (§22.5) — anotado antes de executar (o turno começa dentro do execute)
    const from = typeof f.from_device_id === 'string' ? f.from_device_id : null
    const turn = TURN_COMMANDS.has(kind)
    if (turn) this.engine.push.noteTurnOrigin(chatId, from)
    try {
      const r = await this.execute(chatId, kind, payload)
      await reply({ status: 'accepted', ...(r.queued !== undefined ? { queued: r.queued } : {}) })
    } catch (e) {
      if (turn && !this.runner?.busyChats().has(chatId))
        this.engine.push.dropTurnOrigin(chatId, from)
      await reply({ status: 'rejected', error: errMsg(e) })
    }
  }

  /**
   * fs.list / fs.read no host: sem janela nem runner; raiz e confinamento do chat NESTE
   * dispositivo (as regras da aba Arquivos / tools de leitura — sync/remoteFs.ts).
   */
  private async executeFs(
    chatId: string,
    kind: string,
    p: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (p.chatId !== undefined && p.chatId !== chatId)
      throw new RemoteFsError('invalid', 'Pedido inválido (chat).')
    const row = this.engine.conn
      .prepare('SELECT config_json FROM chats WHERE id = ?')
      .get(chatId) as { config_json: string } | undefined
    if (!row) throw new RemoteFsError('missing', 'Chat não encontrado neste dispositivo.')
    const root = chatRootFrom(row.config_json)
    if (kind === 'fs.list') return hostListDir(root, p.path, this.fsLimits)
    return hostReadFile(root, p.path, p.offset, p.length, this.fsLimits)
  }

  private sessionInChat(sessionId: unknown, chatId: string): string {
    const sid = String(sessionId ?? '')
    if (this.chatOfSession(sid) !== chatId) throw new Error('Sessão não pertence a este chat.')
    return sid
  }

  /** Mensagem do chat (com a profundidade da sessão) — senão lança. */
  private messageInChat(
    messageId: unknown,
    chatId: string
  ): { id: string; seq: number; message: ApiMessage; meta: MessageMeta; depth: number } {
    const id = String(messageId ?? '')
    const r = this.engine.conn
      .prepare(
        `SELECT m.seq, m.message_json, m.meta_json, s.chat_id, s.depth
           FROM messages m JOIN sessions s ON s.id = m.session_id WHERE m.id = ?`
      )
      .get(id) as
      | { seq: number; message_json: string; meta_json: string; chat_id: string; depth: number }
      | undefined
    if (!r || r.chat_id !== chatId) throw new Error('Mensagem não pertence a este chat.')
    const parse = <T>(s: string, d: T): T => {
      try {
        return JSON.parse(s) as T
      } catch {
        return d
      }
    }
    return {
      id,
      seq: r.seq,
      message: parse<ApiMessage>(r.message_json, { role: 'user', content: '' }),
      meta: parse<MessageMeta>(r.meta_json, {}),
      depth: r.depth
    }
  }

  /** Checagens antes de abrir a janela (um comando recusado não abre janela à toa). */
  private validate(chatId: string, kind: string, p: Record<string, unknown>): void {
    switch (kind) {
      case 'message.edit': {
        // §8.6: mensagem digitada pelo usuário na sessão principal só muda como nova versão
        // (branch.edit) — um controle remoto antigo não pode sobrescrever o histórico
        const m = this.messageInChat(p.messageId, chatId)
        if (isBranchEditable(m, m.depth)) throw new Error(EDIT_NEEDS_UPDATE)
        return
      }
      case 'branch.edit': {
        if (!p.message || typeof p.message !== 'object') throw new Error('Mensagem inválida.')
        const m = this.messageInChat(p.messageId, chatId)
        if (!isBranchEditable(m, m.depth))
          throw new Error('Só mensagens digitadas na conversa principal viram nova versão.')
        return
      }
      case 'branch.regenerate':
        this.sessionInChat(p.sessionId, chatId)
        if (p.messageId != null) this.messageInChat(p.messageId, chatId)
        return
      case 'branch.select':
        this.messageInChat(p.messageId, chatId)
        return
    }
  }

  private async execute(
    chatId: string,
    kind: string,
    p: Record<string, unknown>
  ): Promise<{ queued?: boolean }> {
    const runner = this.runner
    if (!runner) throw new Error('Este dispositivo não executa chats.')
    this.validate(chatId, kind, p)
    if (CONTENT_CMDS.has(kind)) await this.ensureWindow(chatId, cmdPurpose(kind))
    switch (kind) {
      case 'send':
      case 'force': {
        const sid = this.sessionInChat(p.sessionId, chatId)
        const atts = (Array.isArray(p.attachments) ? p.attachments : []) as AttachmentInfo[]
        for (const a of atts) {
          if (!(await this.engine.ensureAttachment(a.file))) throw new Error('attachment_missing')
        }
        const skills = Array.isArray(p.skills) ? (p.skills as string[]) : []
        const r = await runner.send(
          sid,
          String(p.text ?? ''),
          atts,
          skills,
          parseInterChatSendMeta(p.meta)
        )
        if (kind === 'force' && r.queued) {
          const q = runner.getQueue(sid)
          const last = q[q.length - 1]
          if (last) runner.forceSend(last.id)
        }
        return { queued: r.queued }
      }
      case 'queue.force':
        runner.forceSend(String(p.queuedId))
        return {}
      case 'queue.remove':
        runner.removeQueued(String(p.queuedId))
        return {}
      case 'stop':
        await runner.stop(this.sessionInChat(p.sessionId, chatId))
        return {}
      case 'stop_subagents':
        await runner.stopSubagents(chatId)
        return {}
      case 'approval':
        runner.approve(
          String(p.requestId),
          p.decision === 'allow' ? 'allow' : 'deny',
          Array.isArray(p.items) ? (p.items as ApprovalItemDecision[]) : undefined
        )
        return {}
      case 'smart_override':
        runner.smartOverride(String(p.messageId))
        return {}
      case 'question':
        if (p.cancel) await runner.cancelQuestion(String(p.requestId))
        else runner.answerQuestion(String(p.requestId), (p.answers ?? []) as QuestionAnswer[])
        return {}
      case 'retry':
        if (p.action === 'cancel') runner.cancelRetry(String(p.requestId))
        else runner.retry(String(p.requestId))
        return {}
      case 'regenerate':
        // desde 1.2.0: regenerar EM RAMO do último turno (= branch.regenerate sem messageId)
        await runner.regenerate(this.sessionInChat(p.sessionId, chatId))
        return {}
      case 'branch.regenerate':
        await runner.regenerate(
          this.sessionInChat(p.sessionId, chatId),
          typeof p.messageId === 'string' && p.messageId ? p.messageId : undefined
        )
        return {}
      case 'branch.edit':
        await runner.editBranch(String(p.messageId), p.message as ApiMessage)
        return {}
      case 'branch.select':
        await runner.selectBranch(String(p.messageId))
        return {}
      case 'message.edit':
        runner.editMessage(String(p.messageId), p.message as ApiMessage)
        return {}
      case 'message.delete':
        await runner.deleteMessage(String(p.messageId))
        return {}
      case 'compact': {
        const r = runner.compact(
          this.sessionInChat(p.sessionId, chatId),
          (p.opts ?? {}) as { retry?: boolean }
        )
        return { queued: r.scheduled }
      }
      case 'memory.extract':
        // pode demorar mais que o timeout do comando: aceita e roda em segundo plano
        void runner
          .extractMemory(this.sessionInChat(p.sessionId, chatId))
          .catch((e) => this.engine.log('extração remota', errMsg(e)))
        return {}
    }
    throw new Error(`comando desconhecido: ${kind}`)
  }

  // ---------------- streaming: host publica ----------------

  private chatOfEvent(e: AgentEvent): string | null {
    switch (e.type) {
      case 'session-created':
      case 'session-updated':
        this.sessionChat.set(e.session.id, e.session.chatId)
        return e.session.chatId
      case 'session-deleted':
        return e.chatId
      case 'draft':
      case 'tool-running':
      case 'queue-updated':
      case 'compaction':
      case 'error':
        return this.chatOfSession(e.sessionId)
      case 'approval-requested':
      case 'question-requested':
      case 'retry-requested':
        this.reqChat.set(e.request.id, e.request.chatId)
        return e.request.chatId
      case 'approval-resolved':
      case 'question-resolved':
      case 'retry-resolved':
        return this.reqChat.get(e.id) ?? null
      case 'processes-updated':
        return e.chatId
      default:
        return null
    }
  }

  private publisher(chatId: string): Publisher {
    let p = this.publishers.get(chatId)
    if (!p) {
      p = {
        drafts: new Map(),
        pendingDraft: new Map(),
        draftTimer: null,
        tools: new Map(),
        compaction: new Map(),
        sinceSnapshot: 0,
        lastSnapshot: 0
      }
      this.publishers.set(chatId, p)
    }
    return p
  }

  /** Este dispositivo executa o chat agora (é o host com conexão, ou tem a janela aberta)? */
  hostsHere(chatId: string): boolean {
    return this.isHostHere(chatId)
  }

  private isHostHere(chatId: string): boolean {
    if (!this.engine.active || !this.connected) return false
    const st = this.states.get(chatId)
    return st?.host?.device_id === this.me || this.windows.has(chatId)
  }

  /** Eventos do runner local (main). Mantém o estado ao vivo e publica se somos o host. */
  private onAgentEvent(e: AgentEvent): void {
    // eventos emitidos pelo espelho (controle remoto) não são republicados
    if (this.emittingMirror) return
    const chatId = this.chatOfEvent(e)
    if (!chatId) return
    try {
      this.engine.push.onAgentEvent(e)
    } catch (err) {
      this.engine.log('push', errMsg(err))
    }
    const pub = this.publisher(chatId)
    // estado local para snapshots
    switch (e.type) {
      case 'tool-running': {
        const runs = pub.tools.get(e.sessionId) ?? new Map<string, ToolRun>()
        if (e.running)
          runs.set(e.toolCallId, { running: !e.judging, output: e.output, judging: e.judging })
        else runs.delete(e.toolCallId)
        pub.tools.set(e.sessionId, runs)
        break
      }
      case 'compaction':
        if (e.state) pub.compaction.set(e.sessionId, { state: e.state, text: e.text })
        else pub.compaction.delete(e.sessionId)
        break
      case 'session-deleted':
        pub.drafts.delete(e.sessionId)
        pub.tools.delete(e.sessionId)
        break
    }
    if (e.type === 'draft') {
      if (!e.draft) {
        // o último pedaço (ainda esperando o temporizador) vai antes do fim: o controle remoto
        // mostra o draft encerrado até a mensagem persistida chegar
        this.flushDrafts(chatId)
        pub.pendingDraft.set(e.sessionId, null)
        this.flushDrafts(chatId)
        return
      }
      pub.pendingDraft.set(e.sessionId, e.draft)
      if (!pub.draftTimer) pub.draftTimer = setTimeout(() => this.flushDrafts(chatId), 100)
      return
    }
    if (!this.isHostHere(chatId)) return
    let payload: Record<string, unknown> | null = null
    switch (e.type) {
      case 'session-created':
      case 'session-updated':
        payload = { kind: 'session', session: e.session }
        break
      case 'tool-running':
        payload = {
          kind: 'tool',
          sessionId: e.sessionId,
          toolCallId: e.toolCallId,
          running: e.running,
          ...(e.output !== undefined ? { output: e.output.slice(-32_000) } : {}),
          ...(e.judging ? { judging: true } : {})
        }
        break
      case 'queue-updated':
        payload = { kind: 'queue', sessionId: e.sessionId, queue: e.queue }
        break
      case 'approval-requested':
        payload = { kind: 'approval.requested', request: e.request }
        break
      case 'approval-resolved':
        payload = { kind: 'approval.resolved', id: e.id }
        break
      case 'question-requested':
        payload = { kind: 'question.requested', request: e.request }
        break
      case 'question-resolved':
        payload = { kind: 'question.resolved', id: e.id }
        break
      case 'retry-requested':
        payload = { kind: 'retry.requested', request: e.request }
        break
      case 'retry-resolved':
        payload = { kind: 'retry.resolved', id: e.id }
        break
      case 'compaction':
        payload = {
          kind: 'compaction',
          sessionId: e.sessionId,
          state: e.state,
          ...(e.text ? { text: e.text } : {})
        }
        break
      case 'processes-updated':
        payload = { kind: 'processes', processes: e.processes }
        break
      case 'error':
        payload = { kind: 'error', sessionId: e.sessionId, error: e.error }
        break
    }
    if (payload) this.publish(chatId, payload)
  }

  private flushDrafts(chatId: string): void {
    const pub = this.publisher(chatId)
    if (pub.draftTimer) clearTimeout(pub.draftTimer)
    pub.draftTimer = null
    const host = this.isHostHere(chatId)
    for (const [sid, d] of pub.pendingDraft) {
      if (!d) {
        const had = pub.drafts.get(sid)
        pub.drafts.delete(sid)
        if (host && had)
          this.publish(chatId, { kind: 'draft.end', sessionId: sid, streamId: had.streamId })
        continue
      }
      const { delta, state } = diffDraft(sid, pub.drafts.get(sid) ?? null, d)
      pub.drafts.set(sid, state)
      if (host && delta) this.publish(chatId, { kind: 'draft.delta', ...delta })
    }
    pub.pendingDraft.clear()
  }

  private publish(chatId: string, payload: Record<string, unknown>): void {
    const sk = this.engine.sk
    const st = this.states.get(chatId)
    if (!sk || !st) return
    const epoch = this.windows.get(chatId)?.epoch ?? st.epoch
    const ck = `${chatId}:${epoch}`
    const n = (this.counters.get(ck) ?? 0) + 1
    const env = sealJson(sk.stream, aadStream(this.engine.userId, chatId, epoch, n), {
      sv: 1,
      ...payload
    })
    if (env.c.length > MAX_STREAM_ENV && payload.kind !== 'snapshot') return
    if (!this.engine.ws.send('stream.event', { chat_id: chatId, epoch, n, env })) return
    this.counters.set(ck, n)
    const pub = this.publisher(chatId)
    if (payload.kind !== 'snapshot' && ++pub.sinceSnapshot >= 50) void this.sendSnapshot(chatId)
  }

  private periodicSnapshots(): void {
    for (const chatId of this.windows.keys()) {
      const pub = this.publisher(chatId)
      if (Date.now() - pub.lastSnapshot >= 9_500) void this.sendSnapshot(chatId)
    }
  }

  /** Estado completo do host para o chat (resync / periódico). */
  async sendSnapshot(chatId: string): Promise<void> {
    if (!this.isHostHere(chatId) || !this.runner) return
    const runner = this.runner
    const pub = this.publisher(chatId)
    this.flushDrafts(chatId)
    pub.sinceSnapshot = 0
    pub.lastSnapshot = Date.now()
    const sessions: Record<string, unknown> = {}
    const queues: Record<string, QueuedMessage[]> = {}
    for (const s of this.engine.sessionsOf(chatId)) {
      const tools: Record<string, ToolRun> = {}
      for (const [id, r] of pub.tools.get(s.id) ?? [])
        tools[id] = { ...r, output: r.output?.slice(-16_000) }
      const d = pub.drafts.get(s.id)
      sessions[s.id] = {
        status: s.status,
        draft: d ? toStreamDraft(d) : null,
        tools,
        compaction: pub.compaction.get(s.id) ?? null
      }
      const q = runner.getQueue(s.id)
      if (q.length) queues[s.id] = q
    }
    let skills = this.skillsCache.get(chatId)
    if (!skills || Date.now() - skills.at > 30_000) {
      try {
        skills = { at: Date.now(), list: await runner.skillsFor(chatId) }
        this.skillsCache.set(chatId, skills)
      } catch {
        skills = { at: Date.now(), list: [] }
      }
    }
    this.publish(chatId, {
      kind: 'snapshot',
      sessions,
      queues,
      approvals: runner.approvals().filter((a) => a.chatId === chatId),
      questions: runner.questions().filter((q) => q.chatId === chatId),
      retries: runner.retries().filter((r) => r.chatId === chatId),
      processes: runner.processes(chatId),
      skills: skills.list
    })
  }

  // ---------------- streaming: controle remoto espelha ----------------

  /** Chat aberto na tela (inscrição no stream). */
  setActive(chatId: string | null): void {
    if (this.active === chatId) return
    const prev = this.active
    this.active = chatId
    if (prev) {
      this.clearMirror(prev)
      void this.engine.ws.request('stream.unsubscribe', { chat_ids: [prev] }).catch(() => undefined)
    }
    if (chatId && this.connected) {
      void this.engine.ws.request('stream.subscribe', { chat_ids: [chatId] }).catch(() => undefined)
    }
  }

  private resync(chatId: string): void {
    const m = this.mirrors.get(chatId)
    if (m && Date.now() - m.resyncAt < 1500) return
    if (m) m.resyncAt = Date.now()
    void this.engine.ws.request('stream.resync', { chat_id: chatId }).catch(() => undefined)
  }

  private mirror(chatId: string, epoch: number): Mirror {
    let m = this.mirrors.get(chatId)
    if (!m || m.epoch !== epoch) {
      if (m) this.clearMirror(chatId)
      m = {
        epoch,
        lastN: 0,
        sessions: new Map(),
        drafts: new Map(),
        ended: new Map(),
        endedTimers: new Map(),
        tools: new Map(),
        compaction: new Map(),
        queues: new Map(),
        approvals: new Map(),
        questions: new Map(),
        retries: new Map(),
        processes: [],
        skills: [],
        resyncAt: 0
      }
      this.mirrors.set(chatId, m)
    }
    return m
  }

  private emittingMirror = false
  private emitM(e: AgentEvent): void {
    this.emittingMirror = true
    try {
      this.engine.emit(e)
    } finally {
      this.emittingMirror = false
    }
  }

  private sessionWithStatus(sessionId: string, status: string): Session | null {
    const s = this.engine
      .sessionsOf(this.chatOfSession(sessionId) ?? '')
      .find((x) => x.id === sessionId)
    return s ? { ...s, status: status as Session['status'] } : null
  }

  private onStreamEvent(f: Record<string, unknown>): void {
    const chatId = String(f.chat_id)
    if (this.active !== chatId || this.mode(chatId) !== 'remote') return
    const sk = this.engine.sk
    if (!sk) return
    const epoch = Number(f.epoch)
    const n = Number(f.n)
    let p: Record<string, unknown>
    try {
      p = openJson(sk.stream, aadStream(this.engine.userId, chatId, epoch, n), f.env as Envelope)
    } catch (e) {
      this.engine.log('stream ilegível', errMsg(e))
      return
    }
    const m = this.mirror(chatId, epoch)
    const kind = String(p.kind)
    if (kind !== 'snapshot' && n !== m.lastN + 1) {
      if (n > m.lastN) this.resync(chatId)
      if (n <= m.lastN) return
      if (!m.lastN) {
        // ainda sem snapshot: aplica o que for idempotente e pede o estado completo
        this.resync(chatId)
      }
    }
    m.lastN = n
    this.applyStream(chatId, m, kind, p)
  }

  private applyStream(chatId: string, m: Mirror, kind: string, p: Record<string, unknown>): void {
    switch (kind) {
      case 'snapshot':
        this.applySnapshot(chatId, m, p)
        return
      case 'draft.delta': {
        const d = p as unknown as DraftDelta
        const next = applyDraftDelta(m.drafts.get(d.sessionId) ?? null, d)
        if (next === 'resync') {
          this.resync(chatId)
          return
        }
        m.drafts.set(d.sessionId, next)
        // um draft encerrado ainda na tela: a resposta nova aparece quando a mensagem dele chegar
        if (!m.ended.get(d.sessionId)?.length)
          this.emitM({ type: 'draft', sessionId: d.sessionId, draft: toStreamDraft(next) })
        return
      }
      case 'draft.end':
        this.endLiveDraft(m, String(p.sessionId))
        return
      case 'session': {
        const s = p.session as Session
        if (!s?.id) return
        m.sessions.set(s.id, s.status)
        this.sessionChat.set(s.id, chatId)
        const local = this.sessionWithStatus(s.id, s.status)
        // a versão ativa ao vivo do host (o registro `session` chega logo depois pelo sync)
        const live =
          local && s.branchSel ? { ...local, branchSel: toBranchSel(s.branchSel) } : local
        this.emitM({ type: 'session-updated', session: live ?? s })
        return
      }
      case 'tool': {
        const sid = String(p.sessionId)
        const tcid = String(p.toolCallId)
        const runs = m.tools.get(sid) ?? new Map<string, ToolRun>()
        if (p.running)
          runs.set(tcid, { running: !p.judging, output: p.output as string, judging: !!p.judging })
        else runs.delete(tcid)
        m.tools.set(sid, runs)
        this.emitM({
          type: 'tool-running',
          sessionId: sid,
          toolCallId: tcid,
          running: !!p.running,
          ...(p.output !== undefined ? { output: String(p.output) } : {}),
          ...(p.judging ? { judging: true } : {})
        })
        return
      }
      case 'queue': {
        const sid = String(p.sessionId)
        const q = (p.queue ?? []) as QueuedMessage[]
        m.queues.set(sid, q)
        this.emitM({ type: 'queue-updated', sessionId: sid, queue: q })
        return
      }
      case 'approval.requested': {
        const r = p.request as ApprovalRequest
        m.approvals.set(r.id, r)
        this.emitM({ type: 'approval-requested', request: r })
        return
      }
      case 'approval.resolved':
        m.approvals.delete(String(p.id))
        this.emitM({ type: 'approval-resolved', id: String(p.id) })
        return
      case 'question.requested': {
        const r = p.request as QuestionRequest
        m.questions.set(r.id, r)
        this.emitM({ type: 'question-requested', request: r })
        return
      }
      case 'question.resolved':
        m.questions.delete(String(p.id))
        this.emitM({ type: 'question-resolved', id: String(p.id) })
        return
      case 'retry.requested': {
        const r = p.request as RetryRequest
        m.retries.set(r.id, r)
        // falha de rede: o parcial foi descartado no host (nada será persistido)
        if (this.dropEnded(m, r.sessionId)) this.emitShown(m, r.sessionId)
        this.emitM({ type: 'retry-requested', request: r })
        return
      }
      case 'retry.resolved':
        m.retries.delete(String(p.id))
        this.emitM({ type: 'retry-resolved', id: String(p.id) })
        return
      case 'compaction': {
        const sid = String(p.sessionId)
        const state = (p.state ?? null) as 'scheduled' | 'running' | null
        if (state) m.compaction.set(sid, { state, text: p.text as string })
        else m.compaction.delete(sid)
        this.emitM({
          type: 'compaction',
          sessionId: sid,
          state,
          ...(p.text ? { text: String(p.text) } : {})
        })
        return
      }
      case 'processes':
        m.processes = (p.processes ?? []) as ProcessInfo[]
        this.emitM({ type: 'processes-updated', chatId, processes: m.processes })
        return
      case 'error':
        this.emitM({ type: 'error', sessionId: String(p.sessionId), error: String(p.error) })
        return
    }
  }

  private applySnapshot(chatId: string, m: Mirror, p: Record<string, unknown>): void {
    const sessions = (p.sessions ?? {}) as Record<
      string,
      {
        status: string
        draft: StreamDraft | null
        tools: Record<string, ToolRun>
        compaction: { state: 'scheduled' | 'running'; text?: string } | null
      }
    >
    // sessões: status ao vivo
    for (const [sid, s] of Object.entries(sessions)) {
      this.sessionChat.set(sid, chatId)
      if (m.sessions.get(sid) !== s.status) {
        m.sessions.set(sid, s.status)
        const local = this.sessionWithStatus(sid, s.status)
        if (local) this.emitM({ type: 'session-updated', session: local })
      }
      // draft
      if (s.draft) {
        const cur = m.drafts.get(sid)
        const st: DraftState = { streamId: cur?.streamId ?? '', ...s.draft }
        m.drafts.set(sid, st)
        if (!m.ended.get(sid)?.length) this.emitM({ type: 'draft', sessionId: sid, draft: s.draft })
      } else if (m.drafts.has(sid)) {
        // o `draft.end` se perdeu: como se tivesse chegado
        this.endLiveDraft(m, sid)
      }
      // tools
      const old = m.tools.get(sid) ?? new Map<string, ToolRun>()
      const next = new Map(Object.entries(s.tools ?? {}))
      for (const id of old.keys())
        if (!next.has(id))
          this.emitM({ type: 'tool-running', sessionId: sid, toolCallId: id, running: false })
      for (const [id, r] of next)
        this.emitM({
          type: 'tool-running',
          sessionId: sid,
          toolCallId: id,
          running: true,
          ...(r.output !== undefined ? { output: r.output } : {}),
          ...(r.judging ? { judging: true } : {})
        })
      m.tools.set(sid, next)
      // compactação
      if (s.compaction) {
        m.compaction.set(sid, s.compaction)
        this.emitM({
          type: 'compaction',
          sessionId: sid,
          state: s.compaction.state,
          ...(s.compaction.text ? { text: s.compaction.text } : {})
        })
      } else if (m.compaction.has(sid)) {
        m.compaction.delete(sid)
        this.emitM({ type: 'compaction', sessionId: sid, state: null })
      }
    }
    // drafts de sessões que sumiram do snapshot
    // filas
    const queues = (p.queues ?? {}) as Record<string, QueuedMessage[]>
    for (const sid of new Set([...m.queues.keys(), ...Object.keys(queues)])) {
      const q = queues[sid] ?? []
      m.queues.set(sid, q)
      this.emitM({ type: 'queue-updated', sessionId: sid, queue: q })
    }
    const sync = <T extends { id: string }>(
      map: Map<string, T>,
      list: T[],
      added: (r: T) => AgentEvent,
      removed: (id: string) => AgentEvent
    ): void => {
      const ids = new Set(list.map((x) => x.id))
      for (const id of [...map.keys()])
        if (!ids.has(id)) {
          map.delete(id)
          this.emitM(removed(id))
        }
      for (const r of list) {
        map.set(r.id, r)
        this.emitM(added(r))
      }
    }
    sync(
      m.approvals,
      (p.approvals ?? []) as ApprovalRequest[],
      (r) => ({ type: 'approval-requested', request: r }),
      (id) => ({ type: 'approval-resolved', id })
    )
    sync(
      m.questions,
      (p.questions ?? []) as QuestionRequest[],
      (r) => ({ type: 'question-requested', request: r }),
      (id) => ({ type: 'question-resolved', id })
    )
    sync(
      m.retries,
      (p.retries ?? []) as RetryRequest[],
      (r) => ({ type: 'retry-requested', request: r }),
      (id) => ({ type: 'retry-resolved', id })
    )
    m.processes = (p.processes ?? []) as ProcessInfo[]
    this.emitM({ type: 'processes-updated', chatId, processes: m.processes })
    m.skills = (p.skills ?? []) as { name: string; description: string }[]
  }

  /** Fim do turno no host: some o que é só ao vivo e volta o status gravado. */
  private endMirrorTurn(chatId: string): void {
    const m = this.mirrors.get(chatId)
    if (!m) return
    for (const t of m.endedTimers.values()) clearTimeout(t)
    m.endedTimers.clear()
    for (const sid of new Set([...m.drafts.keys(), ...m.ended.keys()]))
      this.emitM({ type: 'draft', sessionId: sid, draft: null })
    m.drafts.clear()
    m.ended.clear()
    for (const [sid, runs] of m.tools)
      for (const id of runs.keys())
        this.emitM({ type: 'tool-running', sessionId: sid, toolCallId: id, running: false })
    m.tools.clear()
    // sem o espelho, vale o status gravado — com a janela ainda aberta (saiu do chat no meio do
    // turno), o transitório do registro: o chat continua aparecendo como "executando"
    const sids = [...m.sessions.keys()]
    m.sessions.clear()
    if (!sids.length) return
    const all = this.engine.sessionsOf(chatId)
    for (const sid of sids) {
      const s = all.find((x) => x.id === sid)
      if (s) this.emitM({ type: 'session-updated', session: this.displaySession(s) })
    }
  }

  /** Esquece o espelho do chat (emite as resoluções para a UI limpar). */
  clearMirror(chatId: string): void {
    const m = this.mirrors.get(chatId)
    if (!m) return
    this.endMirrorTurn(chatId)
    for (const id of m.approvals.keys()) this.emitM({ type: 'approval-resolved', id })
    for (const id of m.questions.keys()) this.emitM({ type: 'question-resolved', id })
    for (const id of m.retries.keys()) this.emitM({ type: 'retry-resolved', id })
    for (const sid of m.queues.keys())
      this.emitM({ type: 'queue-updated', sessionId: sid, queue: [] })
    for (const sid of m.compaction.keys())
      this.emitM({ type: 'compaction', sessionId: sid, state: null })
    this.mirrors.delete(chatId)
  }

  /**
   * Mensagem assistant persistida chegou: some o draft daquela sessão (§11) — o encerrado que ela
   * substitui (e os mais velhos que ele); o ao vivo só se for a resposta dela (`draft.end` perdido).
   * Uma mensagem de uma resposta anterior não apaga o draft da resposta nova.
   */
  onPersistedAssistant(msg: StoredMessage): void {
    const sid = msg.sessionId
    const synthetic = !!msg.meta.synthetic
    for (const m of this.mirrors.values()) {
      const list = m.ended.get(sid)
      if (list?.length) {
        const i = synthetic
          ? list.length - 1
          : list.findIndex((d) => draftMatchesMessage(d, msg.message))
        if (i < 0) continue
        list.splice(0, i + 1)
        if (list.length) this.armEnded(m, sid)
        else this.dropEnded(m, sid)
        this.emitShown(m, sid)
        continue
      }
      const live = m.drafts.get(sid)
      if (live && (synthetic || draftMatchesMessage(toStreamDraft(live), msg.message))) {
        m.drafts.delete(sid)
        this.emitM({ type: 'draft', sessionId: sid, draft: null })
      }
    }
  }

  /** O que a tela mostra como draft da sessão: o 1º encerrado ainda sem mensagem, senão o ao vivo. */
  private shownDraft(m: Mirror, sid: string): StreamDraft | null {
    const ended = m.ended.get(sid)
    if (ended?.length) return ended[0]
    const live = m.drafts.get(sid)
    return live ? toStreamDraft(live) : null
  }

  private emitShown(m: Mirror, sid: string): void {
    this.emitM({ type: 'draft', sessionId: sid, draft: this.shownDraft(m, sid) })
  }

  /**
   * Fim da resposta ao vivo (`draft.end`): com texto/tool calls, o draft continua na tela até a
   * mensagem persistida chegar (ou o teto `ENDED_DRAFT_HOLD_MS`, o fim do turno, a falha de rede).
   */
  private endLiveDraft(m: Mirror, sid: string): void {
    const had = m.drafts.get(sid)
    m.drafts.delete(sid)
    if (had && (had.content.trim() || had.toolCalls.length)) {
      const list = m.ended.get(sid) ?? []
      list.push(toStreamDraft(had))
      m.ended.set(sid, list)
      this.armEnded(m, sid)
      return // a tela já mostra este (ou um encerrado mais velho)
    }
    this.emitShown(m, sid)
  }

  private armEnded(m: Mirror, sid: string): void {
    const old = m.endedTimers.get(sid)
    if (old) clearTimeout(old)
    const t = setTimeout(() => {
      if (m.endedTimers.get(sid) !== t) return
      m.endedTimers.delete(sid)
      if (m.ended.delete(sid) && [...this.mirrors.values()].includes(m)) this.emitShown(m, sid)
    }, ENDED_DRAFT_HOLD_MS)
    t.unref?.()
    m.endedTimers.set(sid, t)
  }

  /** Esquece os drafts encerrados da sessão (sem emitir); true se havia algum. */
  private dropEnded(m: Mirror, sid: string): boolean {
    const t = m.endedTimers.get(sid)
    if (t) clearTimeout(t)
    m.endedTimers.delete(sid)
    return m.ended.delete(sid)
  }

  // ---------------- consultas do espelho (IPC) ----------------

  mirrorApprovals(): ApprovalRequest[] {
    return [...this.mirrors.values()].flatMap((m) => [...m.approvals.values()])
  }
  mirrorQuestions(): QuestionRequest[] {
    return [...this.mirrors.values()].flatMap((m) => [...m.questions.values()])
  }
  mirrorRetries(): RetryRequest[] {
    return [...this.mirrors.values()].flatMap((m) => [...m.retries.values()])
  }
  mirrorQueue(sessionId: string): QueuedMessage[] | null {
    for (const m of this.mirrors.values()) {
      const q = m.queues.get(sessionId)
      if (q) return q
    }
    return null
  }
  mirrorRunning(): string[] {
    const out: string[] = []
    for (const m of this.mirrors.values())
      for (const [sid, st] of m.sessions) if (BUSY_STATUS.has(st)) out.push(sid)
    return out
  }
  mirrorProcesses(chatId: string): ProcessInfo[] | null {
    return this.mirrors.get(chatId)?.processes ?? null
  }
  mirrorSkills(chatId: string): { name: string; description: string }[] | null {
    const m = this.mirrors.get(chatId)
    return m ? m.skills : null
  }
  findApproval(id: string): string | null {
    for (const [chatId, m] of this.mirrors) if (m.approvals.has(id)) return chatId
    return null
  }
  findQuestion(id: string): string | null {
    for (const [chatId, m] of this.mirrors) if (m.questions.has(id)) return chatId
    return null
  }
  findRetry(id: string): string | null {
    for (const [chatId, m] of this.mirrors) if (m.retries.has(id)) return chatId
    return null
  }
  findQueued(id: string): { chatId: string; sessionId: string } | null {
    for (const [chatId, m] of this.mirrors)
      for (const [sid, q] of m.queues)
        if (q.some((x) => x.id === id)) return { chatId, sessionId: sid }
    return null
  }
}

function skillNames(it: QueuedMessage): string[] {
  return (it.skillParts ?? []).flatMap((p) =>
    p.type === 'text' && p._skill ? [p._skill.name] : []
  )
}

function rejectText(error: string | undefined, host: string): string {
  if (!error) return `O host (${host}) recusou o comando.`
  if (error === 'attachment_missing') return `O host (${host}) não conseguiu baixar um dos anexos.`
  if (error === 'not_host') return `${host} não é mais o host deste chat.`
  // host < 0.7 não conhece os comandos de versões (§8.6) — e nunca cai no regenerar destrutivo
  if (/^comando desconhecido: branch\./.test(error))
    return `O host (${host}) usa uma versão antiga do ClearChat — atualize o app nele para usar versões de mensagens.`
  return error
}
