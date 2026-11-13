// Liga o motor do sync (engine.ts / host.ts, sem Electron) ao app: safeStorage, janela do captcha,
// runner, skills, handlers IPC `sync:*` e o "portão" das ações do agente (host local × controle
// remoto). Ver docs/SYNC_PROTOCOL.md.
import { withoutStaleNative } from '@shared/toolSearch'
import { app, BrowserWindow, powerMonitor, safeStorage, session, shell } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { IPC } from '@shared/ipc'
import type { AttachmentInfo, ChatConfig, QueuedMessage } from '@shared/types'
import type { SyncServerKind, TakeoverOptions } from '@shared/sync'
import { REMOTE_FS_LIMITS, type RemoteDirResult, type RemoteReadResult } from '@shared/remoteFs'
import { emit, onAgentEvent } from '../events'
import { installContextMenu } from '../contextMenu'
import { getDb } from '../db'
import { chatsRepo, messagesRepo, sessionsRepo } from '../repo'
import * as runner from '../agent/runner'
import { drainQueue } from '../agent/queue'
import { answerQuestion } from '../agent/questions'
import { listProcesses } from '../tools/processes'
import * as memory from '../memory'
import * as skills from '../skills'
import { clearSkillsCache } from '../skills/discovery'
import { SyncEngine, type SecretStore } from './engine'
import { cmdPurpose, NoHostError, type RunnerAdapter } from './host'
import type { Presence } from './push'
import { AWAY_IDLE_S } from '@shared/push'

let engine: SyncEngine | null = null

const SYNC_OFF = { ok: false as const, reason: 'error' as const, message: 'Sync desligado.' }

export function syncEngine(): SyncEngine | null {
  return engine
}

// ---------------- segredos (safeStorage) ----------------

function secretStore(dir: string): SecretStore {
  const file = join(dir, 'sync-secrets.json')
  const mem = new Map<string, string>()
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  const write = (o: Record<string, string>): void => {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 })
    renameSync(tmp, file)
  }
  const available = (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }
  return {
    available,
    get(key) {
      if (mem.has(key)) return mem.get(key)!
      const v = read()[key]
      if (!v || !available()) return null
      try {
        const out = safeStorage.decryptString(Buffer.from(v, 'base64'))
        mem.set(key, out)
        return out
      } catch {
        return null
      }
    },
    set(key, value) {
      const o = read()
      if (value === null) {
        mem.delete(key)
        delete o[key]
      } else {
        mem.set(key, value)
        // sem chaveiro do SO: só em memória (pede login/senha de novo ao reabrir)
        if (available()) o[key] = safeStorage.encryptString(value).toString('base64')
      }
      write(o)
    }
  }
}

// ---------------- captcha (§15) ----------------

function captchaWindow(base: string, action: 'login' | 'signup'): Promise<string> {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(18).toString('base64url')
    const origin = new URL(base).origin
    const donePath = new URL(`${base}/captcha/done`).pathname
    const win = new BrowserWindow({
      width: 420,
      height: 560,
      title: 'Verificação',
      autoHideMenuBar: true,
      backgroundColor: '#0b0b0f',
      parent: BrowserWindow.getFocusedWindow() ?? undefined,
      modal: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        session: session.fromPartition('clearchat-captcha')
      }
    })
    let settled = false
    const finish = (token: string | null, err?: string): void => {
      if (settled) return
      settled = true
      if (!win.isDestroyed()) win.close()
      if (token) resolve(token)
      else reject(new Error(err ?? 'Verificação cancelada.'))
    }
    const check = (e: { preventDefault(): void } | null, url: string): boolean => {
      let u: URL
      try {
        u = new URL(url)
      } catch {
        return false
      }
      if (u.origin === origin && u.pathname === donePath) {
        e?.preventDefault()
        const params = new URLSearchParams(u.hash.replace(/^#/, ''))
        if (params.get('nonce') !== nonce) finish(null, 'Verificação inválida (nonce).')
        else finish(params.get('token'))
        return true
      }
      if (u.origin !== origin) {
        e?.preventDefault()
        return true
      }
      return false
    }
    win.webContents.on('will-navigate', (e, url) => void check(e, url))
    win.webContents.on('did-navigate', (_e, url) => void check(null, url))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // botão direito: menu básico (campos, seleção, links) — sem as ações do app
    installContextMenu(win, { appActions: false })
    win.on('closed', () => finish(null))
    void win.loadURL(
      `${base}/captcha?client=app&nonce=${encodeURIComponent(nonce)}&action=${action}`
    )
  })
}

// ---------------- runner / skills ----------------

function runnerAdapter(): RunnerAdapter {
  return {
    busyChats() {
      const out = new Set<string>()
      for (const sid of runner.runningSessions()) {
        const s = sessionsRepo.get(sid)
        if (s) out.add(s.chatId)
      }
      for (const a of runner.pendingApprovals()) out.add(a.chatId)
      for (const q of runner.pendingQuestions()) out.add(q.chatId)
      for (const r of runner.pendingRetries()) out.add(r.chatId)
      return out
    },
    send: (sid, text, atts, sk, meta) =>
      meta
        ? Promise.resolve(runner.deliverInterChat(sid, text, meta))
        : sk.length
          ? runner.sendWithSkills(sid, text, atts, sk)
          : Promise.resolve(runner.send(sid, text, atts)),
    forceSend: (id) => runner.forceSend(id),
    removeQueued: (id) => runner.removeQueued(id),
    getQueue: (sid) => runner.getQueue(sid),
    takeChatQueues(chatId) {
      const out: QueuedMessage[] = []
      for (const s of sessionsRepo.list(chatId)) out.push(...drainQueue(s.id))
      return out
    },
    stop: (sid) => runner.stop(sid),
    async stopChat(chatId) {
      await runner.stopSubagents(chatId)
      for (const s of sessionsRepo.list(chatId)) if (s.depth === 0) await runner.stop(s.id)
    },
    stopSubagents: (chatId) => runner.stopSubagents(chatId),
    approve: (id, d, items) => runner.approve(id, d, items),
    smartOverride: (id) => runner.smartOverride(id),
    answerQuestion: (id, answers) => answerQuestion(id, answers),
    cancelQuestion: (id) => runner.cancelQuestionRequest(id),
    retry: (id) => runner.retryRequest(id),
    cancelRetry: (id) => runner.cancelRetryRequest(id),
    regenerate: (sid, messageId) => runner.regenerate(sid, messageId),
    editBranch: (id, message) => runner.editBranch(id, message),
    selectBranch: (id) => runner.selectBranch(id),
    editMessage(id, message) {
      // `native` (1.12.0) que não bate mais com o texto editado sai (§4.3.8)
      const m = messagesRepo.update(id, withoutStaleNative(message))
      emit({ type: 'message-updated', message: m })
      return m
    },
    deleteMessage: (id) => runner.deleteMessage(id),
    compact: (sid, opts) => runner.compact(sid, opts ?? {}),
    extractMemory: (sid) => memory.extractNow(sid),
    approvals: () => runner.pendingApprovals(),
    questions: () => runner.pendingQuestions(),
    retries: () => runner.pendingRetries(),
    processes: (chatId) => listProcesses(chatId),
    async skillsFor(chatId) {
      const chat = chatsRepo.get(chatId)
      if (!chat) return []
      const list = await skills.activeSkillsFor(chat.config)
      return list.map((s) => ({ name: s.name, description: s.description }))
    },
    onTurnEnd: (fn) => runner.onTurnEnd(fn),
    // chat.update de um chat ao vivo (§23.7): como a edição local na tela de configuração
    updateChat(chatId, patch) {
      const { chat, modelChanged } = chatsRepo.update(chatId, {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.config ? { config: patch.config as Partial<ChatConfig> } : {})
      })
      if (modelChanged && chat.mainSessionId) {
        const s = sessionsRepo.setModel(chat.mainSessionId, chat.config.model)
        if (s) emit({ type: 'session-updated', session: s })
      }
      emit({ type: 'chat-updated', chat })
    }
  }
}

// ---------------- presença (avisos push, §22.5) ----------------

/**
 * "Ausente" = tela bloqueada, sem interação há ≥ AWAY_IDLE_S (como o "ausente" do Discord) ou
 * suspenso. O Electron não informa "tela desligada"; quando o sistema desliga a tela por
 * ociosidade, o tempo ocioso já passou do limite. Sem como saber (ex.: Wayland sem suporte →
 * 'unknown') = presente. CLEARCHAT_FORCE_AWAY=1|0 força (testes / depuração).
 */
let screenLocked = false
let suspended = false
function presence(): Presence {
  const forced = process.env['CLEARCHAT_FORCE_AWAY']
  if (forced === '1') return 'away'
  if (forced === '0') return 'present'
  if (screenLocked || suspended) return 'away'
  try {
    const s = powerMonitor.getSystemIdleState(AWAY_IDLE_S)
    if (s === 'idle' || s === 'locked') return 'away'
    return s === 'active' ? 'present' : 'unknown'
  } catch {
    return 'unknown'
  }
}

function watchPresence(): void {
  try {
    powerMonitor.on('lock-screen', () => (screenLocked = true))
    powerMonitor.on('unlock-screen', () => (screenLocked = false))
    powerMonitor.on('suspend', () => (suspended = true))
    powerMonitor.on('resume', () => (suspended = false))
  } catch {
    /* plataforma sem os eventos: fica só o estado ocioso */
  }
}

const platformName = (): string =>
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

// ---------------- inicialização ----------------

export async function initSync(): Promise<void> {
  const userData = app.getPath('userData')
  const syncedDir = join(userData, 'synced-skills')
  skills.setSyncedSkillsDir(syncedDir)
  watchPresence()
  engine = new SyncEngine({
    conn: getDb(),
    emit,
    onAgentEvent,
    secrets: secretStore(userData),
    appVersion: app.getVersion(),
    deviceName: (process.env['CLEARCHAT_DEVICE_NAME'] || hostname() || 'Computador').slice(0, 64),
    platform: platformName(),
    runner: runnerAdapter(),
    skills: {
      syncedDir,
      async list() {
        const d = await skills.discover({})
        return d.skills
          .filter((s) => !s.dir.startsWith(syncedDir))
          .map((s) => ({ name: s.name, description: s.description, dir: s.dir, meta: s.meta }))
      },
      changed() {
        clearSkillsCache()
        emit({ type: 'skills-changed' })
      }
    },
    captcha: captchaWindow,
    openExternal: (url) => void shell.openExternal(url),
    envUrl: process.env['CLEARCHAT_SYNC_URL'] || null,
    presence,
    pushGraceMs: Number(process.env['CLEARCHAT_PUSH_GRACE_MS']) || undefined,
    timing: process.env['CLEARCHAT_SYNC_FAST']
      ? {
          ws: { backoffBaseMs: 150, backoffMaxMs: 1500, pingMs: 3000, pongTimeoutMs: 3000 },
          retryMs: 500
        }
      : undefined
  })
  // "Reescanear" / locais mudaram → confere as skills acompanhadas
  onAgentEvent((e) => {
    if (e.type === 'skills-changed') void engine?.checkTrackedSkills().catch(() => undefined)
  })
  await engine.init()
}

export function shutdownSync(): void {
  engine?.destroy()
}

// ---------------- portão das ações do agente ----------------

const offlineHostText = (name: string): string =>
  `O host (${name}) está offline — use “Executar neste dispositivo” para continuar aqui.`

/**
 * Executa uma ação de chat no lugar certo: localmente (este dispositivo é/será o host — abre a
 * janela de escrita antes) ou como comando remoto ao host (controle remoto).
 */
export async function gateChat<T>(
  chatId: string | null,
  kind: string,
  payload: Record<string, unknown>,
  local: () => T | Promise<T>,
  opts: {
    purpose?: 'run' | 'edit'
    content?: boolean
    remote?: (r: { queued?: boolean }) => T
  } = {}
): Promise<T> {
  const e = engine
  if (!e || !chatId || !e.active) {
    if (chatId && e?.host.isViewerChat(chatId))
      throw new Error('Entre na conta para usar este chat.')
    return local()
  }
  const mode = e.host.mode(chatId)
  // chat só ao vivo de outro dispositivo (§23.7): só comandos ao host; nunca roda aqui
  if (e.host.isViewerChat(chatId)) {
    if (mode !== 'remote')
      throw new Error(
        mode === 'offline'
          ? 'Sem conexão com o servidor — o chat ao vivo volta quando reconectar.'
          : `Reconectando a ${e.host.hostName(chatId)}…`
      )
    const r = await e.host.sendCommand(chatId, kind, payload)
    return opts.remote ? opts.remote(r) : (undefined as T)
  }
  if (mode === 'remote') {
    try {
      const r = await e.host.sendCommand(chatId, kind, payload)
      return opts.remote ? opts.remote(r) : (undefined as T)
    } catch (err) {
      if (!(err instanceof NoHostError)) throw err
    }
  } else if (mode === 'host-offline') {
    throw new Error(offlineHostText(e.host.hostName(chatId)))
  } else if (mode === 'diverged' && opts.content !== false) {
    throw new Error('Este chat está divergente: escolha qual versão manter antes de continuar.')
  }
  if (opts.content !== false && (mode === 'local' || mode === 'remote'))
    await e.host.ensureWindow(chatId, opts.purpose ?? cmdPurpose(kind))
  return local()
}

/**
 * send_to_chat do agente (runner) → o chat de destino roda aqui ou em outro dispositivo? Mesmo
 * portão das mensagens do usuário: host remoto online recebe um comando `send`; host offline,
 * chat divergente ou sem conexão com o chat rodando em outro lugar → recusa (entregar aqui criaria
 * conteúdo só deste dispositivo). O celular recusa comandos remotos nos chats que ele executa — o
 * motivo volta para o agente.
 */
runner.setInterChatRouter(async (chatId, sessionId, text, meta) => {
  const e = engine
  if (!e || !e.active) return { kind: 'local' }
  const mode = e.host.mode(chatId)
  const name = e.host.hostName(chatId)
  if (mode === 'remote') {
    try {
      const r = await e.host.sendCommand(chatId, 'send', {
        sessionId,
        text,
        attachments: [],
        skills: [],
        createdAt: Date.now(),
        meta
      })
      return { kind: 'remote', queued: !!r.queued, hostName: name }
    } catch (err) {
      if (!(err instanceof NoHostError)) throw err
      return { kind: 'local' }
    }
  }
  if (mode === 'host-offline')
    throw new Error(`o dispositivo que executa esse chat (${name}) está offline.`)
  if (mode === 'diverged')
    throw new Error('esse chat está divergente (o usuário precisa escolher a versão).')
  if (mode === 'offline' && e.host.hostedElsewhere(chatId))
    throw new Error(`sem conexão com o servidor, e esse chat roda em outro dispositivo (${name}).`)
  return { kind: 'local' }
})

export function chatOfSession(sessionId: string): string | null {
  return sessionsRepo.get(sessionId)?.chatId ?? engine?.liveViewer.chatOfSession(sessionId) ?? null
}

export function chatOfMessage(messageId: string): string | null {
  const m = messagesRepo.get(messageId)
  if (m) return chatOfSession(m.sessionId)
  return engine?.liveViewer.chatOfMessage(messageId) ?? null
}

/** agent.send com o portão (anexos sobem antes quando vai ao host). */
export async function gatedSend(
  sessionId: string,
  text: string,
  attachments: AttachmentInfo[] | undefined,
  skillNames: string[] | undefined
): Promise<{ queued: boolean }> {
  const chatId = chatOfSession(sessionId)
  const e = engine
  const local = (): Promise<{ queued: boolean }> =>
    skillNames?.length
      ? runner.sendWithSkills(sessionId, text, attachments, skillNames)
      : Promise.resolve(runner.send(sessionId, text, attachments))
  if (e && chatId && e.active) {
    // troca de host em andamento (somos o host): a mensagem vai junto para o novo host
    if (
      e.host.forwardOnHandover(chatId, {
        sessionId,
        text,
        ...(attachments?.length ? { attachments } : {})
      })
    )
      return { queued: true }
    // chat ao vivo de outro dispositivo: os anexos já estão no host (attach.put), nada de blob
    if (e.host.mode(chatId) === 'remote' && attachments?.length && !e.host.isViewerChat(chatId))
      await e.ensureBlobs(new Map([['send', attachments.map((a) => a.sha256)]]))
  }
  return gateChat(
    chatId,
    'send',
    {
      sessionId,
      text,
      attachments: attachments ?? [],
      skills: skillNames ?? [],
      createdAt: Date.now()
    },
    local,
    { remote: (r) => ({ queued: !!r.queued }) }
  )
}

/** Ações por id de pedido (aprovação, questionário, retry, item da fila) do espelho remoto. */
export async function gateById<T>(
  find: (e: SyncEngine) => string | null,
  kind: string,
  payload: Record<string, unknown>,
  local: () => T | Promise<T>,
  localChat?: () => string | null
): Promise<T> {
  const e = engine
  if (e?.active) {
    const chatId = find(e)
    if (chatId) {
      await e.host.sendCommand(chatId, kind, payload)
      return undefined as T
    }
    const lc = localChat?.()
    if (lc && e.host.mode(lc) === 'local') await e.host.ensureWindow(lc, 'run')
  }
  return local()
}

// ---------------- handlers IPC `sync:*` ----------------

type Handler = (...args: never[]) => unknown

const need = (): SyncEngine => {
  if (!engine) throw new Error('Sync indisponível.')
  return engine
}

export function syncHandlers(): Record<string, Handler> {
  return {
    [IPC.sync.status]: () => need().status(),
    [IPC.sync.probeServer]: (url?: string) => need().probeServer(url),
    [IPC.sync.setServer]: (kind: SyncServerKind, url?: string) => need().setServer(kind, url),
    [IPC.sync.requestCode]: (email: string) => need().requestCode(email),
    [IPC.sync.verifyCode]: (email: string, code: string) => need().verifyCode(email, code),
    [IPC.sync.refreshKeys]: () => need().refreshKeys(),
    [IPC.sync.unlock]: (pw: string, remember: boolean) => need().unlock(pw, remember !== false),
    [IPC.sync.unlockWithRecovery]: (key: string, pw: string, remember: boolean) =>
      need().unlockWithRecovery(key, pw, remember !== false),
    [IPC.sync.resolveMerge]: (p: 'online' | 'local') =>
      need().resolveMerge(p === 'local' ? 'local' : 'online'),
    [IPC.sync.lock]: () => need().lock(),
    [IPC.sync.logout]: () => need().logout(),
    [IPC.sync.changePassword]: (pw: string) => need().changePassword(pw),
    [IPC.sync.newRecoveryKey]: () => need().newRecoveryKey(),
    [IPC.sync.devices]: () => need().devices(),
    [IPC.sync.renameDevice]: (id: string, name: string) => need().renameDevice(id, name),
    [IPC.sync.revokeDevice]: (id: string) => need().revokeDevice(id),
    [IPC.sync.syncNow]: () => need().syncNow(),
    [IPC.sync.setPushNotify]: (on: boolean) => need().setPushNotify(!!on),
    [IPC.sync.openSignup]: () => need().openSignup(),
    [IPC.sync.openSetup]: () => need().openSetup(),
    [IPC.sync.chatStates]: () => need().chatInfos(),
    [IPC.sync.takeover]: (chatId: string, opts: TakeoverOptions) =>
      need().takeover(chatId, {
        mode: opts?.mode === 'force' ? 'force' : 'next_turn',
        confirmPinned: !!opts?.confirmPinned
      }),
    [IPC.sync.cancelHandover]: (chatId: string) => need().host.cancelHandover(chatId),
    [IPC.sync.setPinned]: (chatId: string, pinned: boolean) =>
      need().host.setPinned(chatId, !!pinned),
    [IPC.sync.confirmCwd]: (chatId: string, cwd: string) => {
      const e = need()
      if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Escolha uma pasta.')
      const { chat } = chatsRepo.update(chatId, { config: { cwd } })
      e.setChatRow(chatId, { cwd_confirmed: 1 })
      emit({ type: 'chat-updated', chat })
      emit({ type: 'sync-chat-state', info: e.chatInfo(chatId) })
    },
    [IPC.sync.divergence]: (chatId: string) => need().divergence(chatId),
    [IPC.sync.resolveDivergence]: (chatId: string, keep: 'online' | 'local') =>
      need().resolveDivergence(chatId, keep === 'local' ? 'local' : 'online'),
    [IPC.sync.setActiveChat]: (chatId: string | null) => need().host.setActive(chatId || null),
    [IPC.sync.answerPrompt]: (chatId: string, keep: boolean) => need().answerPrompt(chatId, !!keep),
    [IPC.sync.cloudSkills]: () => need().cloudSkills(),
    [IPC.sync.trackedSkills]: () => need().trackedSourceSkills(),
    [IPC.sync.setSkillSync]: (name: string, on: boolean) => need().setSkillSync(name, !!on),
    [IPC.sync.downloadSkills]: (names?: string[]) => need().downloadSkills(names),
    [IPC.sync.removeCloudSkill]: (name: string) => need().removeCloudSkill(name),
    [IPC.sync.stopTrackingSkill]: (name: string) => need().stopTrackingSkill(name),
    [IPC.sync.hostSkills]: (chatId: string) => {
      const e = engine
      if (!e?.active || e.host.mode(chatId) !== 'remote') return null
      return e.host.mirrorSkills(chatId) ?? []
    },
    // arquivos do host (controle remoto, §8.6 fs.*): resultado estruturado, nunca lança
    [IPC.sync.remoteListDir]: (
      chatId: string,
      path: string
    ): Promise<RemoteDirResult> | RemoteDirResult =>
      engine && typeof chatId === 'string'
        ? engine.host.fsList(chatId, typeof path === 'string' ? path : '')
        : SYNC_OFF,
    // ---- chats só ao vivo (§23) ----
    [IPC.sync.liveChats]: () => engine?.liveViewer.views() ?? [],
    [IPC.sync.liveOpen]: (chatId: string) => need().liveViewer.open(String(chatId)),
    [IPC.sync.liveAttach]: (
      chatId: string,
      name: string,
      mime: string | undefined,
      data: Uint8Array
    ) => {
      if (!(data instanceof Uint8Array)) throw new Error('Arquivo inválido.')
      return need().liveViewer.upload(String(chatId), {
        name: String(name ?? 'arquivo'),
        ...(typeof mime === 'string' && mime ? { mime } : {}),
        data
      })
    },
    [IPC.sync.liveStats]: (chatId: string) => need().liveStats(String(chatId)),
    [IPC.sync.saveOnline]: (chatId: string) => need().saveOnline(String(chatId)),
    [IPC.sync.takeOffServer]: (chatId: string) => need().takeOffServer(String(chatId)),
    [IPC.sync.remoteReadFile]: (
      chatId: string,
      path: string,
      offset: number,
      length: number
    ): Promise<RemoteReadResult> | RemoteReadResult =>
      engine && typeof chatId === 'string' && typeof path === 'string'
        ? engine.host.fsRead(
            chatId,
            path,
            Number(offset),
            Math.min(Number(length), REMOTE_FS_LIMITS.chunkBytes)
          )
        : SYNC_OFF
  }
}
