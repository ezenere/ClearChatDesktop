// Chats só ao vivo — lado do HOST (docs/SYNC_PROTOCOL.md §23, desde 1.8.0): modo local do chat
// (`chats.storage`), anúncio cifrado (live.announce / live.withdraw), epoch ao vivo, `lseq` e os
// eventos `rec` no lugar do push, e os comandos history.* / chat.update / attach.* executados aqui.
// Nada desses chats vai ao servidor além do vínculo em memória (anúncio) e do que passa cifrado.
// O lado do visualizador (chats ao vivo de OUTRO dispositivo, só em memória) fica em liveViewer.ts.
// Sem Electron.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import type { AttachmentInfo } from '@shared/types'
import type { ChatStorage, NewChatStorage } from '@shared/sync'
import {
  clampLiveInfo,
  jsonBytes,
  LIVE_ATTACH_FILE_RE,
  LIVE_LIMITS,
  liveKey,
  type LiveChatInfo,
  type LiveItem,
  type LiveItemType
} from '@shared/live'
import { REMOTE_FS_LIMITS } from '@shared/remoteFs'
import { aadLiveAnnounce, sealJson, type Envelope } from './crypto'
import { buildLocal, usesLocalTools, type Plain } from './records'
import { withApply } from './schema'
import { WsRequestError } from './ws'
import type { SyncEngine } from './engine'
import {
  attachmentsDir,
  existingAttachment,
  mimeForFile,
  precheckAttachment,
  saveAttachment
} from '../attachments'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Recusa de um comando ao vivo com `code` (§23.5, §23.7). `extra` vai junto no resultado. */
export class LiveCommandError extends Error {
  code: string
  extra: Record<string, unknown>
  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.extra = extra
  }
}

interface Upload {
  chatId: string
  uploadId: string
  name: string
  mime?: string
  size: number
  sha256: string
  received: number
  lastOffset: number
  path: string
  lastAt: number
}

interface ChangeRef {
  type: LiveItemType
  id: string
  lseq: number
}

/** Mensagens de recusa do composer (mesmo texto do app, §23.7). */
const TYPE_ERROR =
  'Anexos aceitos: imagens (png, jpg, webp, gif), PDF, áudio (wav, mp3) e arquivos de texto/código.'

export class LiveHost {
  private readonly engine: SyncEngine
  /** Início do processo: base do epoch ao vivo (§23.3). */
  private readonly processStart = Date.now()
  private epochs = new Map<string, number>()
  private arevs = new Map<string, number>()
  private lseqs = new Map<string, number>()
  private changes = new Map<string, Map<string, ChangeRef>>()
  /** Chats cujo `history.changes` não cobre `since` abaixo disto (esqueceu os mais velhos). */
  private changeFloor = new Map<string, number>()
  /** Aceitos pelo servidor na conexão atual (visíveis nos outros dispositivos). */
  private announced = new Set<string>()
  /** Recusados no último anúncio (código) — ficam "Só neste dispositivo". */
  private rejected = new Map<string, string>()
  private lastSent = new Map<string, { at: number; status: string; running: boolean }>()
  private dueNow = new Set<string>()
  private dueLater = new Map<string, number>()
  private announceTimer: ReturnType<typeof setTimeout> | null = null
  private announceChain: Promise<void> = Promise.resolve()
  private needFull = false
  /** `welcome.caps` da conexão atual tem `live_chats`. */
  private caps = false
  private recPending = new Map<string, Map<string, { type: LiveItemType; id: string }>>()
  private recTimer: ReturnType<typeof setTimeout> | null = null
  private uploads = new Map<string, Upload>()
  /** Arquivos recebidos por attach.put em cada chat (attach.get pode servi-los). */
  private putFiles = new Map<string, Set<string>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  /** Tamanho do item inline num `rec` (os testes encolhem). */
  limits = { ...LIVE_LIMITS }

  constructor(engine: SyncEngine) {
    this.engine = engine
  }

  private get conn(): SyncEngine['conn'] {
    return this.engine.conn
  }

  // ---------------- modo do chat (§23.2) ----------------

  /** Modo do chat neste dispositivo; null = o chat não existe aqui. */
  storage(chatId: string): ChatStorage | null {
    // sem cache: um chat apagado pelo sync e anunciado de novo (conversão em outro dispositivo)
    // tem de deixar de ser "local" na hora — a consulta pela PK é barata
    try {
      const r = this.conn.prepare('SELECT storage FROM chats WHERE id = ?').get(chatId) as
        { storage: string | null } | undefined
      if (!r) return null
      return r.storage === 'live' || r.storage === 'live_pending' ? r.storage : 'online'
    } catch {
      return null
    }
  }

  /** Chat só ao vivo neste dispositivo (live ou live_pending — §23.2). */
  isLive(chatId: string): boolean {
    const s = this.storage(chatId)
    return s === 'live' || s === 'live_pending'
  }

  /** Grava o modo (fora dos triggers do sync). */
  setStorage(chatId: string, s: ChatStorage): void {
    withApply(this.conn, () =>
      this.conn
        .prepare('UPDATE chats SET storage = ? WHERE id = ?')
        .run(s === 'online' ? null : s, chatId)
    )
  }

  /** Chat apagado / esquecido: limpa o que é só de memória. */
  forget(chatId: string): void {
    this.announced.delete(chatId)
    this.rejected.delete(chatId)
    this.lastSent.delete(chatId)
    this.dueNow.delete(chatId)
    this.dueLater.delete(chatId)
    this.recPending.delete(chatId)
    this.putFiles.delete(chatId)
    for (const [id, u] of this.uploads) if (u.chatId === chatId) this.dropUpload(id)
  }

  /** Ids dos chats `live` (os anunciáveis), mais recentes primeiro. */
  liveChatIds(limit = LIVE_LIMITS.maxChatsPerHost): string[] {
    try {
      return (
        this.conn
          .prepare(
            "SELECT id FROM chats WHERE storage = 'live' ORDER BY updated_at DESC, id LIMIT ?"
          )
          .all(limit) as { id: string }[]
      ).map((r) => r.id)
    } catch {
      return []
    }
  }

  countLive(): number {
    try {
      return (
        this.conn
          .prepare("SELECT COUNT(*) AS n FROM chats WHERE storage IN ('live', 'live_pending')")
          .get() as { n: number }
      ).n
    } catch {
      return 0
    }
  }

  // ---------------- suporte (§23.2) ----------------

  /** O servidor entende chats ao vivo (`features.liveChats` + `welcome.caps`; último conhecido). */
  serverSupports(): boolean {
    const info = this.engine.serverInfo?.liveChats
    const known = info ?? this.engine.kv('live_info') === '1'
    if (!known) return false
    if (this.engine.ws.online) return this.caps
    return this.engine.kv('live_caps') !== '0'
  }

  /** Oferece a escolha / anuncia (conta pronta + servidor com suporte). */
  supported(): boolean {
    return this.engine.active && this.serverSupports()
  }

  canAnnounce(): boolean {
    return this.engine.active && this.engine.ws.online && this.caps && !!this.engine.sk
  }

  /** `GET /api/info` respondeu (guarda o último `liveChats`). */
  onServerInfo(liveChats: boolean): void {
    this.engine.setKv('live_info', liveChats ? '1' : '0')
  }

  /** Padrão deste dispositivo para chats novos (§23.1). */
  deviceDefault(): NewChatStorage {
    try {
      const r = this.conn
        .prepare("SELECT value FROM settings WHERE key = 'newChatStorage'")
        .get() as { value: string | null } | undefined
      const v = r?.value ? JSON.parse(r.value) : null
      return v === 'online' ? 'online' : 'live'
    } catch {
      return 'live'
    }
  }

  rememberChoice(choice: NewChatStorage): void {
    this.conn
      .prepare(
        "INSERT INTO settings (key, value) VALUES ('newChatStorage', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(JSON.stringify(choice))
  }

  /**
   * Primeira execução da versão 1.8.0: sem escolha anterior, instalação que já sincronizava →
   * "Salvar online"; instalação nova → "Só ao vivo" (§23.1). Grava o valor uma vez.
   */
  ensureDeviceDefault(): void {
    try {
      const has = this.conn.prepare("SELECT 1 FROM settings WHERE key = 'newChatStorage'").get()
      if (has) return
      const synced =
        !!this.engine.kv('user_id') ||
        !!this.conn.prepare('SELECT 1 FROM sync_records LIMIT 1').get()
      this.rememberChoice(synced ? 'online' : 'live')
    } catch (e) {
      this.engine.log('padrão de chats novos', errMsg(e))
    }
  }

  /**
   * Modo de um chat novo (§23.1): sem login, o padrão do dispositivo (vale no primeiro login);
   * servidor sem suporte → online; senão o pedido (seletor) ou o padrão.
   */
  resolveNew(requested?: NewChatStorage | null): ChatStorage {
    if (this.engine.phase() === 'signed-out') return requested ?? this.deviceDefault()
    if (!this.serverSupports()) return 'online'
    return requested ?? this.deviceDefault()
  }

  // ---------------- epoch / lseq (§23.3, §23.5) ----------------

  /** Epoch ao vivo do chat neste processo (fixo enquanto o app roda; nunca se repete). */
  epochOf(chatId: string): number {
    const cur = this.epochs.get(chatId)
    if (cur) return cur
    let last = 0
    try {
      const r = this.conn.prepare('SELECT live_epoch FROM chats WHERE id = ?').get(chatId) as
        { live_epoch: number | null } | undefined
      last = Number(r?.live_epoch ?? 0) || 0
    } catch {
      /* */
    }
    const e = Math.min(Number.MAX_SAFE_INTEGER, Math.max(this.processStart, last + 1))
    try {
      withApply(this.conn, () =>
        this.conn.prepare('UPDATE chats SET live_epoch = ? WHERE id = ?').run(e, chatId)
      )
    } catch {
      /* */
    }
    this.epochs.set(chatId, e)
    this.arevs.set(chatId, 0)
    this.lseqs.set(chatId, 0)
    this.changes.set(chatId, new Map())
    this.changeFloor.set(chatId, 0)
    return e
  }

  /** Começa um epoch novo (conversão online → ao vivo, §23.8). */
  newEpoch(chatId: string): number {
    this.epochs.delete(chatId)
    return this.epochOf(chatId)
  }

  lseqOf(chatId: string): number {
    this.epochOf(chatId)
    return this.lseqs.get(chatId) ?? 0
  }

  isAnnounced(chatId: string): boolean {
    return this.announced.has(chatId) && this.canAnnounce()
  }

  rejectedCode(chatId: string): string | null {
    return this.rejected.get(chatId) ?? null
  }

  // ---------------- anúncio (§23.4) ----------------

  /** O que o anúncio diz do chat agora (null = o chat não existe). */
  buildInfo(chatId: string): LiveChatInfo | null {
    const r = this.conn
      .prepare(
        'SELECT title, config_json, main_session_id, created_at, updated_at FROM chats WHERE id = ?'
      )
      .get(chatId) as
      | {
          title: string
          config_json: string
          main_session_id: string | null
          created_at: number
          updated_at: number
        }
      | undefined
    if (!r) return null
    let cfg: Plain = {}
    try {
      cfg = JSON.parse(r.config_json) as Plain
    } catch {
      /* */
    }
    const presetId = typeof cfg.presetId === 'string' ? cfg.presetId : null
    const preset = presetId
      ? (this.conn.prepare('SELECT name, icon FROM presets WHERE id = ?').get(presetId) as
          { name: string; icon: string } | undefined)
      : undefined
    const providerId = typeof cfg.providerId === 'string' && cfg.providerId ? cfg.providerId : null
    const provider = providerId
      ? (this.conn.prepare('SELECT name FROM providers WHERE id = ?').get(providerId) as
          { name: string } | undefined)
      : undefined
    const st = this.statusOf(chatId)
    let messageCount: number | undefined
    if (r.main_session_id) {
      try {
        messageCount = (
          this.conn
            .prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?')
            .get(r.main_session_id) as { n: number }
        ).n
      } catch {
        /* */
      }
    }
    return clampLiveInfo({
      sv: 1,
      chatId,
      title: r.title || '',
      persona: presetId
        ? { id: presetId, name: preset?.name ?? '', icon: preset?.icon ?? '' }
        : null,
      model: {
        providerId,
        providerName: provider?.name ?? null,
        model: typeof cfg.model === 'string' && cfg.model ? cfg.model : null
      },
      status: st.status,
      pending: st.pending,
      usesLocalTools: usesLocalTools(cfg),
      hostCwd: typeof cfg.cwd === 'string' && cfg.cwd ? cfg.cwd : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ...(messageCount !== undefined ? { messageCount } : {})
    })
  }

  /** Status pelo critério da §8.5 passo 4 (sessão rodando/esperando, pendências). */
  statusOf(chatId: string): {
    status: LiveChatInfo['status']
    pending: LiveChatInfo['pending']
  } {
    const runner = this.engine.deps.runner
    if (!runner) return { status: 'idle', pending: { approvals: 0, questions: 0, retries: 0 } }
    const pending = {
      approvals: runner.approvals().filter((a) => a.chatId === chatId).length,
      questions: runner.questions().filter((q) => q.chatId === chatId).length,
      retries: runner.retries().filter((x) => x.chatId === chatId).length
    }
    const waiting = pending.approvals + pending.questions + pending.retries > 0
    const busy = runner.busyChats().has(chatId)
    return { status: waiting ? 'waiting' : busy ? 'running' : 'idle', pending }
  }

  /** Atividade do runner num chat ao vivo: status/rodando mudou → anúncio na hora. */
  onActivity(chatId: string): void {
    if (this.storage(chatId) !== 'live' || !this.canAnnounce()) return
    const last = this.lastSent.get(chatId)
    const st = this.statusOf(chatId)
    if (!last || last.status !== st.status) this.schedule(chatId, true)
  }

  /** Agenda o anúncio do chat (coalescido a 1 por LIVE_ANNOUNCE_MIN_INTERVAL_S; `now` = na hora). */
  schedule(chatId: string, now = false): void {
    if (this.storage(chatId) !== 'live') return
    if (now) this.dueNow.add(chatId)
    else {
      const last = this.lastSent.get(chatId)?.at ?? 0
      const at = Math.max(Date.now(), last + this.limits.announceMinIntervalMs)
      const cur = this.dueLater.get(chatId)
      if (cur === undefined || cur > at) this.dueLater.set(chatId, at)
    }
    this.armAnnounce()
  }

  private armAnnounce(): void {
    if (this.announceTimer) return
    let next = Infinity
    if (this.dueNow.size || this.needFull) next = Date.now() + 60
    for (const at of this.dueLater.values()) next = Math.min(next, at)
    if (next === Infinity) return
    this.announceTimer = setTimeout(
      () => {
        this.announceTimer = null
        this.announceChain = this.announceChain
          .then(() => this.flushAnnounce())
          .catch((e) => this.engine.log('anúncio ao vivo', errMsg(e)))
      },
      Math.max(0, next - Date.now())
    )
    this.announceTimer.unref?.()
  }

  private async flushAnnounce(): Promise<void> {
    if (!this.canAnnounce()) {
      this.dueNow.clear()
      this.dueLater.clear()
      return
    }
    if (this.needFull) {
      this.needFull = false
      this.dueNow.clear()
      this.dueLater.clear()
      await this.sendAnnounce(this.liveChatIds(), true)
      this.armAnnounce()
      return
    }
    const now = Date.now()
    const ids = new Set(this.dueNow)
    this.dueNow.clear()
    for (const [id, at] of [...this.dueLater]) {
      if (at <= now + 20) {
        ids.add(id)
        this.dueLater.delete(id)
      }
    }
    if (ids.size) await this.sendAnnounce([...ids], false)
    this.armAnnounce()
  }

  /** Anúncio completo (depois de cada welcome, `live.refresh_request`). */
  announceFull(): void {
    this.needFull = true
    this.armAnnounce()
  }

  private itemFor(
    chatId: string
  ): { chat_id: string; epoch: number; arev: number; running: boolean; env: Envelope } | null {
    const sk = this.engine.sk
    if (!sk) return null
    const info = this.buildInfo(chatId)
    if (!info) return null
    const epoch = this.epochOf(chatId)
    const arev = (this.arevs.get(chatId) ?? 0) + 1
    const seal = (i: LiveChatInfo): Envelope =>
      sealJson(
        sk.stream,
        aadLiveAnnounce(this.engine.userId, this.engine.deviceId, chatId, epoch, arev),
        i
      )
    let env = seal(info)
    if (JSON.stringify(env).length > this.limits.announceMaxEnvBytes) {
      // textos longos (título/raiz/persona): corta mais até caber
      const short: LiveChatInfo = {
        ...info,
        hostCwd: null,
        title: Array.from(info.title).slice(0, 40).join(''),
        persona: info.persona ? { ...info.persona, name: info.persona.name.slice(0, 24) } : null,
        model: {
          ...info.model,
          providerName: (info.model.providerName ?? '').slice(0, 24) || null,
          model: (info.model.model ?? '').slice(0, 64) || null
        }
      }
      env = seal(short)
      if (JSON.stringify(env).length > this.limits.announceMaxEnvBytes) return null
    }
    this.arevs.set(chatId, arev)
    return { chat_id: chatId, epoch, arev, running: info.status !== 'idle', env }
  }

  private async sendAnnounce(ids: string[], full: boolean): Promise<void> {
    if (!this.canAnnounce()) return
    const items: NonNullable<ReturnType<LiveHost['itemFor']>>[] = []
    const status = new Map<string, { status: string; running: boolean }>()
    for (const id of ids) {
      if (this.storage(id) !== 'live') continue
      const it = this.itemFor(id)
      if (!it) continue
      items.push(it)
      status.set(id, { status: this.statusOf(id).status, running: it.running })
    }
    if (!full && !items.length) return
    let ack: Record<string, unknown>
    try {
      ack = await this.engine.ws.request('live.announce', { full, chats: items })
    } catch (e) {
      if (e instanceof WsRequestError && e.code === 'rate_limited') {
        // tenta de novo logo (o conjunto inteiro, se era completo)
        if (full) this.needFull = true
        else for (const id of ids) this.dueLater.set(id, Date.now() + 1000)
        this.armAnnounce()
        return
      }
      if (!(e instanceof WsRequestError && (e.code === 'disconnected' || e.code === 'timeout')))
        this.engine.log('live.announce falhou', errMsg(e))
      return
    }
    const accepted = new Set(
      ((ack.accepted as unknown[]) ?? []).filter((x): x is string => typeof x === 'string')
    )
    const changed = new Set<string>()
    if (full) {
      for (const id of this.announced) if (!accepted.has(id)) changed.add(id)
      this.announced.clear()
    }
    const now = Date.now()
    for (const id of accepted) {
      if (!this.announced.has(id)) changed.add(id)
      this.announced.add(id)
      if (this.rejected.delete(id)) changed.add(id)
      const s = status.get(id)
      if (s) this.lastSent.set(id, { at: now, ...s })
    }
    for (const r of (ack.rejected as Record<string, unknown>[]) ?? []) {
      const id = typeof r?.chat_id === 'string' ? r.chat_id : ''
      if (!id) continue
      const code = String(r.code ?? 'invalid_request')
      this.announced.delete(id)
      changed.add(id)
      // exists_online num live_pending = a exclusão ainda não terminou: anuncia depois do ack (§23.8)
      if (code === 'live_conflict' && this.storage(id) === 'live_pending') continue
      this.rejected.set(id, code)
      this.engine.log('anúncio ao vivo recusado', id, code, r.reason ?? '')
    }
    for (const id of changed) this.engine.host.emitInfoOf(id)
  }

  /** Tira chats da lista (§23.4). `null` = todos deste host. */
  withdraw(chatIds: string[] | null, reason: 'deleted' | 'quit' | 'withdrawn'): void {
    if (chatIds) for (const id of chatIds) this.announced.delete(id)
    else this.announced.clear()
    if (!this.canAnnounce()) return
    if (chatIds && !chatIds.length) return
    void this.engine.ws
      .request('live.withdraw', { chat_ids: chatIds, reason })
      .catch((e) => this.engine.log('live.withdraw', errMsg(e)))
  }

  /** O app vai fechar / a conta bloqueou ou saiu: some sem esperar a tolerância. */
  quit(): void {
    if (this.canAnnounce() && this.announced.size) this.withdraw(null, 'quit')
    this.announced.clear()
  }

  // ---------------- conexão ----------------

  onWelcome(w: Record<string, unknown>): void {
    this.caps = Array.isArray(w.caps) && (w.caps as unknown[]).includes('live_chats')
    this.engine.setKv('live_caps', this.caps ? '1' : '0')
    this.announced.clear()
    this.rejected.clear()
    this.lastSent.clear()
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweepUploads(), 15_000)
      this.sweepTimer.unref?.()
    }
    // §23.4: anúncio completo logo depois de CADA welcome (lista vazia se não houver chats ao vivo)
    if (this.caps) this.announceFull()
    for (const id of this.liveChatIds()) this.engine.host.emitInfoOf(id)
  }

  onDisconnect(): void {
    this.announced.clear()
  }

  stop(): void {
    this.announced.clear()
    if (this.announceTimer) clearTimeout(this.announceTimer)
    if (this.recTimer) clearTimeout(this.recTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.announceTimer = this.recTimer = this.sweepTimer = null
    this.dueNow.clear()
    this.dueLater.clear()
    this.recPending.clear()
    for (const id of [...this.uploads.keys()]) this.dropUpload(id)
  }

  onRefreshRequest(): void {
    if (this.caps) this.announceFull()
  }

  // ---------------- rec: o que iria para a outbox (§23.6) ----------------

  /**
   * Mudanças locais de chats ao vivo marcadas pelos triggers (sync_dirty): viram eventos `rec`
   * em vez de push, e saem da outbox. O tombstone de um `live_pending` fica (é a conversão, §23.8).
   */
  drainDirty(): void {
    let rows: { type: string; id: string; scope: string | null; mark: number; storage: string }[]
    try {
      rows = this.conn
        .prepare(
          `SELECT d.type, d.id, d.scope, d.mark, c.storage FROM sync_dirty d
             JOIN chats c ON c.id = (CASE WHEN d.type = 'chat' THEN d.id ELSE d.scope END)
            WHERE d.type IN ('chat', 'session', 'message') AND c.storage IN ('live', 'live_pending')`
        )
        .all() as typeof rows
    } catch {
      return
    }
    for (const r of rows) {
      if (r.type === 'chat' && r.storage === 'live_pending') continue
      const chatId = r.type === 'chat' ? r.id : (r.scope ?? '')
      if (!chatId) continue
      this.conn
        .prepare('DELETE FROM sync_dirty WHERE type = ? AND id = ? AND mark = ?')
        .run(r.type, r.id, r.mark)
      if (r.storage !== 'live') continue
      this.queueRec(chatId, r.type as LiveItemType, r.id)
      if (r.type === 'chat') this.schedule(chatId)
    }
  }

  queueRec(chatId: string, type: LiveItemType, id: string): void {
    let m = this.recPending.get(chatId)
    if (!m) {
      m = new Map()
      this.recPending.set(chatId, m)
    }
    m.set(liveKey(type, id), { type, id })
    if (!this.recTimer) {
      this.recTimer = setTimeout(() => {
        this.recTimer = null
        this.flushRecs()
      }, this.limits.recDebounceMs)
      this.recTimer.unref?.()
    }
  }

  /** Emite os `rec` pendentes (um `lseq` por evento; vários se não couber em um). */
  flushRecs(): void {
    const pending = this.recPending
    this.recPending = new Map()
    for (const [chatId, refs] of pending) {
      if (this.storage(chatId) !== 'live') continue
      this.epochOf(chatId)
      // ordem do push: chat, sessões (por profundidade), mensagens
      const order = { chat: 0, session: 1, message: 2 }
      const list = [...refs.values()].sort((a, b) => order[a.type] - order[b.type])
      let batch: LiveItem[] = []
      let bytes = 0
      const emitBatch = (): void => {
        if (!batch.length) return
        const lseq = (this.lseqs.get(chatId) ?? 0) + 1
        this.lseqs.set(chatId, lseq)
        for (const it of batch) {
          it.lseq = lseq
          this.noteChange(chatId, it.type, it.id, lseq)
        }
        this.engine.host.publishLive(chatId, { kind: 'rec', lseq, items: batch })
        batch = []
        bytes = 0
      }
      for (const ref of list) {
        const local = this.itemData(chatId, ref.type, ref.id)
        const it: LiveItem = { type: ref.type, id: ref.id, lseq: 0 }
        let size = 64
        if (!local) it.deleted = true
        else {
          const n = jsonBytes(local)
          if (n > this.limits.recInlineMaxBytes) it.omitted = true
          else {
            it.data = local
            size += n
          }
        }
        if (batch.length && bytes + size > this.limits.streamEventMaxBytes / 1.5) emitBatch()
        batch.push(it)
        bytes += size
      }
      emitBatch()
    }
  }

  private noteChange(chatId: string, type: LiveItemType, id: string, lseq: number): void {
    let m = this.changes.get(chatId)
    if (!m) {
      m = new Map()
      this.changes.set(chatId, m)
    }
    const k = liveKey(type, id)
    m.delete(k)
    m.set(k, { type, id, lseq })
    // memória: esquece as mais velhas (o visualizador recebe `reset` se pedir abaixo do piso)
    if (m.size > this.limits.historyChangesMax * 4) {
      let n = m.size - this.limits.historyChangesMax * 2
      for (const [key, c] of m) {
        if (n-- <= 0) break
        m.delete(key)
        this.changeFloor.set(chatId, Math.max(this.changeFloor.get(chatId) ?? 0, c.lseq))
      }
    }
  }

  /** Plaintext do registro (§4.3.6 sem cwd, §4.3.7, §4.3.8) se o item é deste chat. */
  private itemData(chatId: string, type: LiveItemType, id: string): Plain | null {
    const l = buildLocal(this.conn, type, id)
    if (!l) return null
    if (type === 'chat') return id === chatId ? l.plain : null
    return l.scope === chatId ? l.plain : null
  }

  // ---------------- comandos (§23.5, §23.7) ----------------

  /** Executa um comando só de chats ao vivo. Lança LiveCommandError (recusa com `code`). */
  async execute(
    chatId: string,
    kind: string,
    p: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (p.chatId !== chatId) throw new LiveCommandError('invalid', 'Pedido inválido (chat).')
    if (this.storage(chatId) !== 'live')
      throw new LiveCommandError('not_live', 'Este chat não é só ao vivo neste dispositivo.')
    switch (kind) {
      case 'history.list':
        return { ...this.base(chatId), ...this.historyList(chatId, p) }
      case 'history.changes':
        return { ...this.base(chatId), ...this.historyChanges(chatId, p) }
      case 'history.item':
        return { ...this.base(chatId), ...this.historyItem(chatId, p) }
      case 'chat.update':
        return this.chatUpdate(chatId, p)
      case 'attach.put':
        return this.attachPut(chatId, p)
      case 'attach.get':
        return this.attachGet(chatId, p)
    }
    throw new LiveCommandError('invalid', `comando desconhecido: ${kind}`)
  }

  private base(chatId: string): { epoch: number; lseq: number } {
    return { epoch: this.epochOf(chatId), lseq: this.lseqOf(chatId) }
  }

  private itemOf(chatId: string, type: LiveItemType, id: string): LiveItem {
    const lseq = this.changes.get(chatId)?.get(liveKey(type, id))?.lseq ?? 0
    const data = this.itemData(chatId, type, id)
    if (!data) return { type, id, lseq, deleted: true }
    return { type, id, lseq, data }
  }

  private page(
    items: LiveItem[],
    budget: number
  ): { items: LiveItem[]; full: boolean; used: number } {
    const out: LiveItem[] = []
    let used = 0
    for (const it of items) {
      let size = 64
      let x = it
      if (it.data) {
        const n = jsonBytes(it.data)
        if (n > this.limits.itemInlineMaxBytes) {
          x = { type: it.type, id: it.id, lseq: it.lseq, large: n }
        } else size += n
      }
      if (out.length && used + size > budget) return { items: out, full: true, used }
      out.push(x)
      used += size
    }
    return { items: out, full: false, used }
  }

  private historyList(chatId: string, p: Record<string, unknown>): Record<string, unknown> {
    const type = p.type
    const limit = Math.max(
      1,
      Math.min(
        this.limits.historyPageMaxItems,
        typeof p.limit === 'number' && p.limit > 0
          ? Math.floor(p.limit)
          : this.limits.historyPageMaxItems
      )
    )
    const after = typeof p.after === 'string' ? p.after : null
    if (type === 'chat') return { items: [this.itemOf(chatId, 'chat', chatId)], next: null }
    if (type === 'session') {
      let rows: { id: string; created_at: number }[]
      const m = after ? /^s:(\d+):(.+)$/.exec(after) : null
      if (after && !m) throw new LiveCommandError('invalid', 'Cursor inválido.')
      if (m)
        rows = this.conn
          .prepare(
            'SELECT id, created_at FROM sessions WHERE chat_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?'
          )
          .all(chatId, Number(m[1]), Number(m[1]), m[2], limit + 1) as typeof rows
      else
        rows = this.conn
          .prepare(
            'SELECT id, created_at FROM sessions WHERE chat_id = ? ORDER BY created_at, id LIMIT ?'
          )
          .all(chatId, limit + 1) as typeof rows
      const more = rows.length > limit
      rows = rows.slice(0, limit)
      const pg = this.page(
        rows.map((r) => this.itemOf(chatId, 'session', r.id)),
        this.limits.historyPageMaxBytes
      )
      const last = rows[pg.items.length - 1]
      return {
        items: pg.items,
        next: (pg.full || more) && last ? `s:${last.created_at}:${last.id}` : null
      }
    }
    if (type === 'message') {
      const sid = typeof p.sessionId === 'string' ? p.sessionId : ''
      const own = this.conn.prepare('SELECT chat_id FROM sessions WHERE id = ?').get(sid) as
        { chat_id: string } | undefined
      if (!own || own.chat_id !== chatId)
        throw new LiveCommandError('missing', 'Sessão não encontrada neste chat.')
      const m = after ? /^m:(-?\d+):(.+)$/.exec(after) : null
      if (after && !m) throw new LiveCommandError('invalid', 'Cursor inválido.')
      let rows: { id: string; seq: number }[]
      if (m)
        rows = this.conn
          .prepare(
            'SELECT id, seq FROM messages WHERE session_id = ? AND (seq > ? OR (seq = ? AND id > ?)) ORDER BY seq, id LIMIT ?'
          )
          .all(sid, Number(m[1]), Number(m[1]), m[2], limit + 1) as typeof rows
      else
        rows = this.conn
          .prepare('SELECT id, seq FROM messages WHERE session_id = ? ORDER BY seq, id LIMIT ?')
          .all(sid, limit + 1) as typeof rows
      const more = rows.length > limit
      rows = rows.slice(0, limit)
      const pg = this.page(
        rows.map((r) => this.itemOf(chatId, 'message', r.id)),
        this.limits.historyPageMaxBytes
      )
      const last = rows[pg.items.length - 1]
      return {
        items: pg.items,
        next: (pg.full || more) && last ? `m:${last.seq}:${last.id}` : null
      }
    }
    throw new LiveCommandError('invalid', 'Tipo inválido.')
  }

  private historyChanges(chatId: string, p: Record<string, unknown>): Record<string, unknown> {
    const since = typeof p.since === 'number' && Number.isFinite(p.since) ? p.since : -1
    if (since < 0) throw new LiveCommandError('invalid', 'since inválido.')
    if (since < (this.changeFloor.get(chatId) ?? 0)) return { reset: true }
    const list = [...(this.changes.get(chatId)?.values() ?? [])]
      .filter((c) => c.lseq > since)
      .sort((a, b) => a.lseq - b.lseq)
    if (list.length > this.limits.historyChangesMax) return { reset: true }
    return {
      changes: list.map((c) => ({
        type: c.type,
        id: c.id,
        lseq: c.lseq,
        ...(this.itemData(chatId, c.type, c.id) ? {} : { deleted: true })
      }))
    }
  }

  private historyItem(chatId: string, p: Record<string, unknown>): Record<string, unknown> {
    const isType = (t: unknown): t is LiveItemType =>
      t === 'chat' || t === 'session' || t === 'message'
    if (p.piece && typeof p.piece === 'object') {
      const pc = p.piece as Record<string, unknown>
      const offset = typeof pc.offset === 'number' && pc.offset >= 0 ? Math.floor(pc.offset) : -1
      if (!isType(pc.type) || typeof pc.id !== 'string' || offset < 0)
        throw new LiveCommandError('invalid', 'Pedido inválido.')
      const it = this.itemOf(chatId, pc.type, pc.id)
      if (!it.data) throw new LiveCommandError('missing', 'Item não encontrado.')
      const buf = Buffer.from(JSON.stringify(it.data), 'utf8')
      if (buf.length > this.limits.historyItemMaxBytes)
        throw new LiveCommandError('too_large', 'Item grande demais.')
      const chunk = buf.subarray(offset, offset + this.limits.historyChunkBytes)
      return {
        piece: {
          type: it.type,
          id: it.id,
          lseq: it.lseq,
          total: buf.length,
          offset,
          data: chunk.toString('base64')
        }
      }
    }
    if (!Array.isArray(p.items) || p.items.length > 200)
      throw new LiveCommandError('invalid', 'Pedido inválido.')
    const all: LiveItem[] = []
    for (const x of p.items as Record<string, unknown>[]) {
      if (!x || !isType(x.type) || typeof x.id !== 'string') continue
      all.push(this.itemOf(chatId, x.type, x.id))
    }
    const pg = this.page(all, this.limits.historyPageMaxBytes)
    const out = [...pg.items]
    for (const it of all.slice(pg.items.length))
      out.push({ type: it.type, id: it.id, lseq: it.lseq, omitted: true })
    return { items: out }
  }

  private async chatUpdate(
    chatId: string,
    p: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const runner = this.engine.deps.runner
    if (!runner?.updateChat)
      throw new LiveCommandError('invalid', 'Este dispositivo não edita chats.')
    const patch: { title?: string; config?: Record<string, unknown> } = {}
    if (p.title !== undefined) {
      if (typeof p.title !== 'string') throw new LiveCommandError('invalid', 'Título inválido.')
      patch.title = p.title.slice(0, 500)
    }
    if (p.config !== undefined) {
      if (!p.config || typeof p.config !== 'object' || Array.isArray(p.config))
        throw new LiveCommandError('invalid', 'Configuração inválida.')
      const cfg = { ...(p.config as Record<string, unknown>) }
      delete cfg.cwd
      patch.config = cfg
    }
    if (patch.title === undefined && !patch.config) return {}
    await runner.updateChat(chatId, patch)
    this.schedule(chatId, true)
    return {}
  }

  // ---------------- anexos (§23.7) ----------------

  private uploadsOf(chatId: string): Upload[] {
    return [...this.uploads.values()].filter((u) => u.chatId === chatId)
  }

  private dropUpload(uploadId: string): void {
    const u = this.uploads.get(uploadId)
    if (!u) return
    this.uploads.delete(uploadId)
    try {
      rmSync(u.path, { force: true })
    } catch {
      /* */
    }
  }

  private sweepUploads(): void {
    const now = Date.now()
    for (const [id, u] of [...this.uploads])
      if (now - u.lastAt > this.limits.attachUploadIdleMs) this.dropUpload(id)
  }

  /** O arquivo foi recebido por attach.put neste chat (o GC do host o poupa por 24 h). */
  receivedIn(chatId: string, file: string): boolean {
    return !!this.putFiles.get(chatId)?.has(file)
  }

  private notePut(chatId: string, file: string): void {
    let s = this.putFiles.get(chatId)
    if (!s) {
      s = new Set()
      this.putFiles.set(chatId, s)
    }
    s.add(file)
  }

  private attachPut(chatId: string, p: Record<string, unknown>): Record<string, unknown> {
    this.sweepUploads()
    const uploadId = typeof p.uploadId === 'string' ? p.uploadId : ''
    if (!uploadId || uploadId.length > 100)
      throw new LiveCommandError('invalid', 'Upload inválido.')
    if (p.cancel === true) {
      this.dropUpload(uploadId)
      return { cancelled: true }
    }
    const name = typeof p.name === 'string' ? p.name : ''
    const mime = typeof p.mime === 'string' ? p.mime : undefined
    const size = typeof p.size === 'number' && Number.isInteger(p.size) ? p.size : -1
    const sha = typeof p.sha256 === 'string' ? p.sha256 : ''
    const offset = typeof p.offset === 'number' && Number.isInteger(p.offset) ? p.offset : -1
    if (
      !name ||
      size <= 0 ||
      !/^[0-9a-f]{64}$/.test(sha) ||
      offset < 0 ||
      typeof p.data !== 'string'
    )
      throw new LiveCommandError('invalid', 'Pedaço inválido.')
    const data = Buffer.from(p.data, 'base64')
    if (data.length > this.limits.attachChunkBytes)
      throw new LiveCommandError('invalid', 'Pedaço grande demais.')
    let u = this.uploads.get(uploadId)
    if (
      u &&
      (u.chatId !== chatId ||
        u.name !== name ||
        u.size !== size ||
        u.sha256 !== sha ||
        (u.mime ?? '') !== (mime ?? ''))
    )
      throw new LiveCommandError('invalid', 'Os campos mudaram entre os pedaços.')
    if (!u) {
      if (offset !== 0)
        throw new LiveCommandError('expired', 'O envio expirou — comece de novo.', { received: 0 })
      if (size > this.limits.attachMaxFileBytes)
        throw new LiveCommandError(
          'too_large',
          `"${name}" passa do limite de ${Math.round(this.limits.attachMaxFileBytes / 1024 / 1024)} MB por arquivo.`
        )
      const pre = precheckAttachment(name, mime)
      if (!pre.kind)
        throw new LiveCommandError('type', `Tipo não suportado: "${name}". ${TYPE_ERROR}`)
      // content-addressed: já existe → pronto (o visualizador para de enviar)
      const have = existingAttachment(name, mime, sha, size)
      if (have) {
        this.notePut(chatId, have.file)
        return { received: size, done: true, attachment: have }
      }
      const open = this.uploadsOf(chatId)
      if (
        open.length >= this.limits.attachMaxUploads ||
        open.reduce((s, x) => s + x.size, 0) + size > this.limits.attachMaxPendingBytes
      )
        throw new LiveCommandError('busy', 'Envios demais em andamento neste chat — aguarde.')
      mkdirSync(attachmentsDir(), { recursive: true })
      u = {
        chatId,
        uploadId,
        name,
        mime,
        size,
        sha256: sha,
        received: 0,
        lastOffset: -1,
        path: join(attachmentsDir(), `.tmp-${randomUUID()}`),
        lastAt: Date.now()
      }
      this.uploads.set(uploadId, u)
    }
    u.lastAt = Date.now()
    // retentativa do mesmo pedaço (timeout / remote.failed): idempotente pelo offset
    if (offset === u.lastOffset && offset + data.length === u.received)
      return { received: u.received, done: false }
    if (offset !== u.received)
      throw new LiveCommandError('offset', 'Pedaço fora de ordem.', { received: u.received })
    if (u.received + data.length > u.size) {
      this.dropUpload(uploadId)
      throw new LiveCommandError('invalid', 'O arquivo passou do tamanho anunciado.')
    }
    const fd = openSync(u.path, u.received === 0 ? 'w' : 'a')
    try {
      writeSync(fd, data)
    } finally {
      closeSync(fd)
    }
    u.received += data.length
    u.lastOffset = offset
    if (u.received < u.size) return { received: u.received, done: false }
    // último pedaço: confere tamanho + SHA-256 e salva como anexo local normal
    const bytes = readFileSync(u.path)
    this.dropUpload(uploadId)
    const got = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== size || got !== sha)
      throw new LiveCommandError('hash', 'O arquivo chegou diferente do enviado — envie de novo.')
    let info: AttachmentInfo
    try {
      info = saveAttachment({ name, mime, data: new Uint8Array(bytes) })
    } catch (e) {
      throw new LiveCommandError('type', errMsg(e))
    }
    this.notePut(chatId, info.file)
    return { received: size, done: true, attachment: info }
  }

  /** O host serve o arquivo? (citado por mensagens deste chat ou recebido por attach.put nele) */
  private fileInChat(chatId: string, file: string): boolean {
    if (this.receivedIn(chatId, file)) return true
    const like = `%clearchat-attachment://${file}%`
    return !!this.conn
      .prepare(
        `SELECT 1 FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE s.chat_id = ? AND (m.message_json LIKE ? OR m.meta_json LIKE ?) LIMIT 1`
      )
      .get(chatId, like, like)
  }

  /** Arquivo do store usável num `send` deste chat ao vivo (existe com aquele sha256). */
  hasStoreFile(a: { file?: unknown; sha256?: unknown }): boolean {
    const file = typeof a.file === 'string' ? a.file : ''
    if (!LIVE_ATTACH_FILE_RE.test(file)) return false
    if (typeof a.sha256 === 'string' && !file.startsWith(a.sha256 + '.')) return false
    try {
      return statSync(join(attachmentsDir(), file)).isFile()
    } catch {
      return false
    }
  }

  private attachGet(chatId: string, p: Record<string, unknown>): Record<string, unknown> {
    const file = typeof p.file === 'string' ? p.file : ''
    const offset = typeof p.offset === 'number' && Number.isInteger(p.offset) ? p.offset : -1
    const length = typeof p.length === 'number' && Number.isInteger(p.length) ? p.length : -1
    if (!LIVE_ATTACH_FILE_RE.test(file) || offset < 0 || length < 0)
      throw new LiveCommandError('invalid', 'Pedido inválido.')
    if (!this.fileInChat(chatId, file))
      throw new LiveCommandError('missing', 'Anexo não encontrado neste chat.')
    const path = join(attachmentsDir(), file)
    let size: number
    try {
      const st = statSync(path)
      if (!st.isFile()) throw new Error('não é arquivo')
      size = st.size
    } catch {
      throw new LiveCommandError('missing', 'O arquivo não está neste dispositivo.')
    }
    if (offset >= REMOTE_FS_LIMITS.maxFileBytes)
      throw new LiveCommandError('too_large', 'Arquivo grande demais.')
    const want = Math.max(
      0,
      Math.min(
        length,
        this.limits.attachChunkBytes,
        size - offset,
        REMOTE_FS_LIMITS.maxFileBytes - offset
      )
    )
    let data = Buffer.alloc(0)
    if (want > 0) {
      const buf = Buffer.alloc(want)
      const fd = openSync(path, 'r')
      try {
        const n = readSync(fd, buf, 0, want, offset)
        data = buf.subarray(0, n)
      } finally {
        closeSync(fd)
      }
    }
    return {
      file,
      size,
      ...(offset === 0 ? { mime: mimeForFile(file).split(';')[0] } : {}),
      offset,
      data: data.toString('base64')
    }
  }
}
