/* eslint-disable @typescript-eslint/no-explicit-any */
// Servidor de sync FALSO (em processo) para testes — implementa docs/SYNC_PROTOCOL.md (REST +
// WebSocket) com a semântica do contrato: feed por `seq`, push atômico com idempotência, revisões,
// tombstones/cascatas, blobs, host de execução (lease, janela, tolerância de queda, troca de host),
// retransmissão de comandos remotos e do stream ao vivo, divergência e resolução. Nunca decifra nada
// (só o helper `createAccount` usa a cripto de referência para criar as chaves como o site faria).
//
// Roda em Node puro (type stripping): só `import type`, sem enums/namespaces, imports com `.ts`.
//
// Uso:
//   const srv = await startFakeSyncServer({ hostDropGraceMs: 500 })
//   await srv.createAccount({ email: 'a@b.c', password: 'senha-bem-longa' })
//   … app com CLEARCHAT_SYNC_URL=srv.url …
//   await srv.close()
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  aadWrap,
  b64u,
  deriveSubkeys,
  formatRecoveryKey,
  keyProof,
  passwordKek,
  recoveryKek,
  wrapDek,
  type KdfParams
} from '../../docs/test-vectors/generate.ts'

// ============================================================================================
// Tipos públicos
// ============================================================================================

export interface FakeSyncOptions {
  name?: string
  signupOpen?: boolean
  /** true → features.captcha = { provider: 'turnstile', siteKey: 'fake' }; tokens válidos: 'fake-…'. */
  captcha?: boolean
  protocol?: { min: number; max: number }
  /** Ex.: '/clearchat' → base = http://127.0.0.1:<porta>/clearchat. */
  basePath?: string
  hostDropGraceMs?: number
  commandTimeoutMs?: number
  handoverForceTimeoutMs?: number
  helloTimeoutMs?: number
  idleTimeoutMs?: number
  accessTtlS?: number
  /** true → features.push = { providers: ['fcm'] } e POST /push grava os avisos (§22). */
  push?: boolean
  /** true → features.liveChats e os frames live.* (chats só ao vivo, §23, desde 1.8.0). */
  liveChats?: boolean
  log?: (line: string) => void
}

/** Aviso recebido em POST /push (o que o servidor repassaria ao FCM), com os destinos resolvidos. */
export interface FakePush {
  at: number
  fromDeviceId: string
  kind: string
  tag: string
  to: 'all' | string[]
  env: any
  /** device_ids que receberiam (com token). */
  targets: string[]
}

export interface FakeSyncServer {
  url: string
  close(): Promise<void>
  lastCode(email: string): string | undefined
  createAccount(input: {
    email: string
    name?: string
    password: string
    kdf?: KdfParams
  }): Promise<{ userId: string; recoveryKey: string; dek: Uint8Array }>
  createUser(input: { email: string; name?: string }): { userId: string }
  userIdOf(email: string): string | undefined
  dropDevice(deviceId: string): void
  closeDevice(deviceId: string, code: number, reason?: string): void
  /** Simula o dispositivo sem rede: WS recusado no hello e REST autenticado derrubado. */
  setRefuseConnections(deviceId: string, refuse: boolean): void
  setTombstoneFloor(userId: string, seq: number): void
  chatState(userId: string, chatId: string): any
  records(userId: string): any[]
  devices(userId: string): any[]
  connections(userId: string): { deviceId: string; subscriptions: string[] }[]
  requests: { method: string; path: string; status: number; deviceId?: string }[]
  /** Avisos push recebidos (§22.3). */
  pushes: FakePush[]
  /** Define/remove o token de push de um dispositivo (como o app móvel faria). */
  setPushToken(deviceId: string, token: string | null): void
  wsLog: { dir: 'in' | 'out'; deviceId?: string; t: string; frame: any }[]
  /** Vínculos ao vivo em memória do usuário (§23.3). */
  liveBindings(userId: string): {
    chat_id: string
    host_device_id: string
    epoch: number
    arev: number
    running: boolean
  }[]
}

// ============================================================================================
// Modelo interno
// ============================================================================================

interface Rec {
  type: string
  id: string
  scope: string | null
  rev: number
  seq: number
  deleted: boolean
  env?: any
  size: number
  blobs: string[]
  device_id: string
  updated_at: string
}

interface ChatSt {
  chat_id: string
  host_device_id: string | null
  epoch: number
  pinned: boolean
  window: { purpose: string; since: string; device_id: string } | null
  head: number
  handover: {
    to_device_id: string
    mode: 'next_turn' | 'force'
    requested_at: string
    timer?: ReturnType<typeof setTimeout>
  } | null
  diverged: {
    divergence_id: string
    device_id: string
    base: number
    head: number
    since: string
  } | null
  ssq: number
}

interface KeysRow {
  key_version: number
  keys_rev: number
  password: { kdf: any; salt: string; wrap: { n: string; c: string } }
  recovery: { kdf: any; salt: string; wrap: { n: string; c: string } }
  verifier: string
}

interface User {
  id: string
  email: string
  name: string
  created_at: string
  keys: KeysRow | null
  seq: number
  ssq: number
  tombstoneFloor: number
  records: Map<string, Rec>
  chats: Map<string, ChatSt>
  blobs: Map<string, Buffer>
  receipts: Map<string, any>
  discards: { chat_id: string; device_id: string; base: number }[]
  /** Vínculos ao vivo (§23.3) — só memória. */
  live: Map<string, LiveBinding>
}

interface LiveBinding {
  chat_id: string
  host_device_id: string
  epoch: number
  arev: number
  running: boolean
  env: any
  announced_at: string
}

interface Device {
  id: string
  userId: string
  name: string
  platform: string
  client: string
  app_version: string
  can_host: boolean
  created_at: string
  last_seen_at: string
  last_ip: string
  revoked: boolean
  pushToken?: string | null
  inGrace: boolean
  graceTimer?: ReturnType<typeof setTimeout>
  /** Já ficou offline (tolerância esgotada) desde a última conexão (volta → `host_back`, como da tolerância). */
  wentOffline: boolean
  /** Chats em que deixou de ser host enquanto desconectado → `host.revoked` após o welcome. */
  pendingRevoked: { chat_id: string; epoch: number; reason: string }[]
}

interface Conn {
  ws: WebSocket
  deviceId: string | null
  userId: string | null
  subscriptions: Set<string>
  lastFrameAt: number
  helloTimer?: ReturnType<typeof setTimeout>
  /** Fechada por outra conexão do mesmo dispositivo (não conta como queda). */
  superseded: boolean
  closed: boolean
  /** `hello.caps` aceitas (§10.3). */
  caps: Set<string>
}

interface PendingCmd {
  userId: string
  chat_id: string
  cmd_id: string
  fromDeviceId: string
  hostDeviceId: string
  timer: ReturnType<typeof setTimeout>
}

class ApiError extends Error {
  status: number
  code: string
  details: any
  constructor(status: number, code: string, message?: string, details: any = {}) {
    super(message ?? MESSAGES[code] ?? code)
    this.status = status
    this.code = code
    this.details = details
  }
}

const MESSAGES: Record<string, string> = {
  invalid_request: 'Requisição inválida.',
  captcha_failed: 'Verificação anti-robô falhou.',
  signup_closed: 'O cadastro está fechado nesta instância.',
  invite_invalid: 'Convite inválido ou expirado.',
  code_invalid: 'Código inválido ou expirado.',
  unauthorized: 'Sessão expirada ou inválida.',
  refresh_reused: 'Sessão reutilizada: o dispositivo foi desconectado.',
  forbidden: 'Sem permissão.',
  device_revoked: 'Este dispositivo foi desconectado.',
  key_proof_invalid: 'Prova de posse da chave inválida.',
  not_found: 'Não encontrado.',
  keys_not_ready: 'As chaves da conta ainda não foram definidas.',
  keys_already_set: 'As chaves da conta já foram definidas.',
  conflict: 'Conflito de revisão.',
  blob_missing: 'Arquivo cifrado ausente no servidor.',
  chat_busy: 'O chat está sendo executado em outro dispositivo.',
  chat_diverged: 'O chat está divergente.',
  divergence_discarded: 'Esta versão do chat foi descartada.',
  divergence_mismatch: 'Divergência desatualizada.',
  stale_base: 'Base do chat à frente do servidor.',
  not_host: 'Este dispositivo não é o host do chat.',
  no_host: 'O chat não tem host.',
  cannot_host: 'Este dispositivo não pode executar chats.',
  host_offline: 'O host do chat está offline.',
  host_pinned: 'O host deste chat está fixado.',
  handover_pending: 'Troca de host em andamento.',
  cursor_expired: 'Cursor expirado: faça um resync completo.',
  payload_too_large: 'Dados grandes demais.',
  quota_exceeded: 'Cota excedida.',
  protocol_unsupported: 'Versão do protocolo não suportada.',
  internal: 'Erro interno.',
  push_unavailable: 'Notificações push não estão configuradas nesta instância.'
}

const STATUS: Record<string, number> = {
  invalid_request: 400,
  captcha_failed: 400,
  signup_closed: 403,
  invite_invalid: 400,
  code_invalid: 400,
  unauthorized: 401,
  refresh_reused: 401,
  forbidden: 403,
  account_disabled: 403,
  device_revoked: 403,
  key_proof_invalid: 403,
  not_found: 404,
  keys_not_ready: 409,
  keys_already_set: 409,
  conflict: 409,
  blob_missing: 409,
  chat_busy: 409,
  chat_diverged: 409,
  divergence_discarded: 409,
  divergence_mismatch: 409,
  stale_base: 409,
  not_host: 409,
  no_host: 409,
  cannot_host: 409,
  host_offline: 409,
  host_pinned: 409,
  handover_pending: 409,
  cursor_expired: 410,
  payload_too_large: 413,
  quota_exceeded: 413,
  protocol_unsupported: 426,
  internal: 500,
  push_unavailable: 503
}

const err = (code: string, details: any = {}, message?: string): ApiError =>
  new ApiError(STATUS[code] ?? 400, code, message, details)

const TYPES = new Set([
  'provider',
  'setting',
  'preset',
  'memory_collection',
  'memory',
  'chat',
  'session',
  'message',
  'skill'
])
const CONTENT = new Set(['session', 'message'])
const COMMAND_KINDS = new Set([
  'send',
  'force',
  'queue.force',
  'queue.remove',
  'stop',
  'stop_subagents',
  'approval',
  'smart_override',
  'question',
  'retry',
  'regenerate',
  'message.edit',
  'message.delete',
  'compact',
  'memory.extract',
  'branch.edit',
  'branch.regenerate',
  'branch.select',
  // desde 1.3.0: arquivos do host (só leitura, §8.6)
  'fs.list',
  'fs.read',
  // desde 1.8.0: chats só ao vivo (§23.5, §23.7)
  'history.list',
  'history.changes',
  'history.item',
  'chat.update',
  'attach.put',
  'attach.get'
])
const LIVE_ONLY_KINDS = new Set([
  'history.list',
  'history.changes',
  'history.item',
  'chat.update',
  'attach.put',
  'attach.get'
])
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/
const BLOB_RE = /^[0-9a-f]{64}$/
const B64U_RE = /^[A-Za-z0-9_-]*$/
const ARGON2_BOUNDS = { mMin: 19456, mMax: 1048576, tMin: 2, tMax: 10, pMin: 1, pMax: 4 }
const DEFAULT_TEST_KDF: KdfParams = { alg: 'argon2id', v: 19, m: 19456, t: 2, p: 1, len: 32 }
const MAX_PUSH_ITEMS = 500
const PULL_MAX_BYTES = 8 * 1024 * 1024
const STREAM_MAX = 256 * 1024
const COMMAND_MAX = 1024 * 1024

const nowIso = (): string => new Date().toISOString()
const sha256hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const b64uLen = (s: unknown): number => {
  if (typeof s !== 'string' || !B64U_RE.test(s)) return -1
  return Buffer.from(s, 'base64url').length
}
const isInt = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min

function validEnvelope(env: any): boolean {
  return (
    !!env &&
    typeof env === 'object' &&
    env.v === 1 &&
    isInt(env.k, 1) &&
    b64uLen(env.n) === 12 &&
    b64uLen(env.c) >= 17
  )
}

// ============================================================================================
// Servidor
// ============================================================================================

export async function startFakeSyncServer(opts: FakeSyncOptions = {}): Promise<FakeSyncServer> {
  const o = {
    name: opts.name ?? 'ClearChat (fake)',
    signupOpen: opts.signupOpen ?? true,
    captcha: !!opts.captcha,
    protocol: opts.protocol ?? { min: 1, max: 1 },
    basePath: (opts.basePath ?? '').replace(/\/+$/, ''),
    hostDropGraceMs: opts.hostDropGraceMs ?? 10_000,
    commandTimeoutMs: opts.commandTimeoutMs ?? 30_000,
    handoverForceTimeoutMs: opts.handoverForceTimeoutMs ?? 20_000,
    helloTimeoutMs: opts.helloTimeoutMs ?? 10_000,
    idleTimeoutMs: opts.idleTimeoutMs ?? 30_000,
    accessTtlS: opts.accessTtlS ?? 3600,
    push: !!opts.push,
    liveChats: !!opts.liveChats,
    log: opts.log ?? ((): void => {})
  }

  const users = new Map<string, User>()
  const usersByEmail = new Map<string, string>()
  const devices = new Map<string, Device>()
  const access = new Map<string, { deviceId: string; exp: number }>()
  const refresh = new Map<string, { deviceId: string; used: boolean }>()
  const codes = new Map<
    string,
    { code: string; exp: number; attempts: number; name?: string; userId?: string }
  >()
  const lastCodes = new Map<string, string>()
  const refused = new Set<string>()
  const conns = new Set<Conn>()
  const pendingCmds = new Map<string, PendingCmd>()
  const requests: FakeSyncServer['requests'] = []
  const pushes: FakePush[] = []
  const wsLog: FakeSyncServer['wsLog'] = []
  let url = ''

  const normEmail = (e: unknown): string => (typeof e === 'string' ? e.trim().toLowerCase() : '')

  // ---------------- usuários / tokens ----------------

  function newUser(email: string, name: string): User {
    const u: User = {
      id: randomUUID(),
      email,
      name,
      created_at: nowIso(),
      keys: null,
      seq: 0,
      ssq: 0,
      tombstoneFloor: 0,
      records: new Map(),
      chats: new Map(),
      blobs: new Map(),
      receipts: new Map(),
      discards: [],
      live: new Map()
    }
    users.set(u.id, u)
    usersByEmail.set(email, u.id)
    return u
  }

  function issueTokens(deviceId: string): any {
    const a = 'cca_' + randomBytes(32).toString('base64url')
    const r = 'ccr_' + randomBytes(32).toString('base64url')
    access.set(a, { deviceId, exp: Date.now() + o.accessTtlS * 1000 })
    refresh.set(r, { deviceId, used: false })
    return {
      access_token: a,
      access_expires_in: o.accessTtlS,
      refresh_token: r,
      refresh_expires_in: 60 * 86400
    }
  }

  function keysResponse(u: User): any {
    if (!u.keys) return null
    const k = u.keys
    return {
      key_version: k.key_version,
      keys_rev: k.keys_rev,
      password: k.password,
      recovery: k.recovery
    }
  }

  function issueCode(purpose: string, email: string, extra: { name?: string } = {}): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    codes.set(`${purpose}|${email}`, {
      code,
      exp: Date.now() + 600_000,
      attempts: 0,
      ...extra
    })
    lastCodes.set(email, code)
    o.log(`[fake-sync] código ${purpose} para ${email}: ${code}`)
    return code
  }

  function consumeCode(purpose: string, email: string, code: unknown): { name?: string } {
    const key = `${purpose}|${email}`
    const c = codes.get(key)
    if (!c || c.exp < Date.now()) {
      codes.delete(key)
      throw err('code_invalid')
    }
    if (typeof code !== 'string' || code.trim() !== c.code) {
      c.attempts++
      if (c.attempts >= 5) codes.delete(key)
      throw err('code_invalid')
    }
    codes.delete(key)
    return c
  }

  function checkCaptcha(token: unknown): void {
    if (!o.captcha) return
    if (typeof token !== 'string' || !token.startsWith('fake-')) throw err('captcha_failed')
  }

  function newDevice(userId: string, d: any, ip: string): Device {
    if (!d || typeof d !== 'object') throw err('invalid_request', { field: 'device' })
    const client = ['desktop', 'mobile', 'web'].includes(d.client) ? d.client : null
    if (!client) throw err('invalid_request', { field: 'device.client' })
    const dev: Device = {
      id: randomUUID(),
      userId,
      name: String(d.name ?? 'Dispositivo').slice(0, 64),
      platform: String(d.platform ?? 'linux'),
      client,
      app_version: String(d.app_version ?? ''),
      can_host: client === 'web' ? false : d.can_host !== false,
      created_at: nowIso(),
      last_seen_at: nowIso(),
      last_ip: ip,
      revoked: false,
      inGrace: false,
      wentOffline: false,
      pendingRevoked: []
    }
    devices.set(dev.id, dev)
    return dev
  }

  function authResult(u: User, dev: Device): any {
    return {
      ...issueTokens(dev.id),
      user: { id: u.id, email: u.email, name: u.name },
      device_id: dev.id,
      keys_ready: !!u.keys,
      keys: keysResponse(u)
    }
  }

  function authFromToken(token: string | undefined): { user: User; device: Device } {
    if (!token) throw err('unauthorized')
    const a = access.get(token)
    if (!a) throw err('unauthorized')
    const device = devices.get(a.deviceId)
    if (!device) throw err('unauthorized')
    if (device.revoked) throw err('device_revoked')
    if (a.exp < Date.now()) throw err('unauthorized', { reason: 'expired' })
    const user = users.get(device.userId)
    if (!user) throw err('unauthorized')
    device.last_seen_at = nowIso()
    return { user, device }
  }

  function revokeDevice(dev: Device, reason = 'device_revoked'): void {
    if (dev.revoked) return
    dev.revoked = true
    dev.pushToken = null
    for (const [k, v] of access) if (v.deviceId === dev.id) access.delete(k)
    for (const [k, v] of refresh) if (v.deviceId === dev.id) refresh.delete(k)
    const c = connOf(dev.id)
    if (c) closeConn(c, 4403, reason)
    if (dev.graceTimer) clearTimeout(dev.graceTimer)
    const lu = users.get(dev.userId)
    if (lu) liveRemove(lu, dev.id, liveOf(lu, dev.id), 'device_revoked')
    dev.inGrace = false
    failPendingForHost(dev.id)
    const u = users.get(dev.userId)
    if (!u) return
    for (const st of u.chats.values()) {
      if (st.host_device_id !== dev.id) continue
      st.host_device_id = null
      st.epoch++
      st.window = null
      clearHandover(st)
      emitState(u, st, { kind: 'host_changed', reason: 'device_revoked' })
    }
  }

  // ---------------- conexões ----------------

  const connOf = (deviceId: string): Conn | undefined => {
    for (const c of conns) if (c.deviceId === deviceId && !c.closed) return c
    return undefined
  }
  const userConns = (userId: string): Conn[] =>
    [...conns].filter((c) => c.userId === userId && !c.closed)

  function send(c: Conn, frame: any): void {
    if (c.closed) return
    wsLog.push({ dir: 'out', deviceId: c.deviceId ?? undefined, t: frame.t, frame })
    try {
      c.ws.send(JSON.stringify(frame))
    } catch {
      /* fechada */
    }
  }
  const sendDevice = (deviceId: string, frame: any): boolean => {
    const c = connOf(deviceId)
    if (!c) return false
    send(c, frame)
    return true
  }
  const broadcast = (userId: string, frame: any): void => {
    for (const c of userConns(userId)) send(c, frame)
  }

  function closeConn(c: Conn, code: number, reason = ''): void {
    if (c.closed) return
    try {
      c.ws.close(code, reason)
    } catch {
      /* */
    }
    onConnGone(c)
  }

  // ---------------- estado de host ----------------

  function devStatus(deviceId: string): 'online' | 'grace' | 'offline' {
    if (connOf(deviceId)) return 'online'
    const d = devices.get(deviceId)
    if (d?.inGrace) return 'grace'
    return 'offline'
  }

  function chatOf(u: User, chatId: string, create = true): ChatSt | undefined {
    let st = u.chats.get(chatId)
    if (!st && create) {
      st = {
        chat_id: chatId,
        host_device_id: null,
        epoch: 0,
        pinned: false,
        window: null,
        head: 0,
        handover: null,
        diverged: null,
        ssq: 0
      }
      u.chats.set(chatId, st)
    }
    return st
  }

  function toChatState(st: ChatSt): any {
    const host = st.host_device_id ? devices.get(st.host_device_id) : undefined
    const to = st.handover ? devices.get(st.handover.to_device_id) : undefined
    const dd = st.diverged ? devices.get(st.diverged.device_id) : undefined
    return {
      chat_id: st.chat_id,
      ssq: st.ssq,
      epoch: st.epoch,
      head: st.head,
      pinned: st.pinned,
      host: host
        ? {
            device_id: host.id,
            name: host.name,
            platform: host.platform,
            status: devStatus(host.id)
          }
        : null,
      window: st.window ? { purpose: st.window.purpose, since: st.window.since } : null,
      handover: st.handover
        ? {
            to_device_id: st.handover.to_device_id,
            to_name: to?.name ?? '',
            mode: st.handover.mode,
            requested_at: st.handover.requested_at
          }
        : null,
      diverged: st.diverged
        ? {
            divergence_id: st.diverged.divergence_id,
            device_id: st.diverged.device_id,
            device_name: dd?.name ?? '',
            base: st.diverged.base,
            head: st.diverged.head,
            since: st.diverged.since
          }
        : null
    }
  }

  function emitState(u: User, st: ChatSt, event?: any): void {
    st.ssq = ++u.ssq
    if (!u.chats.has(st.chat_id)) return
    broadcast(u.id, { t: 'chat.state', ...toChatState(st), ...(event ? { event } : {}) })
  }

  function clearHandover(st: ChatSt): void {
    if (st.handover?.timer) clearTimeout(st.handover.timer)
    st.handover = null
  }

  /** Concede o host a `to` (epoch+1) e repassa os comandos encaminhados pelo antigo. */
  function grant(
    u: User,
    st: ChatSt,
    toId: string,
    reason: 'handover' | 'takeover',
    forwarded: { cmd_id: string; env: any }[] = []
  ): void {
    const old = st.host_device_id
    clearHandover(st)
    st.host_device_id = toId
    st.epoch++
    st.window = null
    sendDevice(toId, { t: 'host.granted', chat_id: st.chat_id, epoch: st.epoch, head: st.head })
    for (const f of forwarded) {
      if (!f || typeof f.cmd_id !== 'string') continue
      if (!old) continue
      relayCommand(u, st, old, toId, f.cmd_id, 'send', f.env)
    }
    if (old && old !== toId) {
      const revoked = { t: 'host.revoked', chat_id: st.chat_id, epoch: st.epoch, reason }
      if (!sendDevice(old, revoked)) {
        const d = devices.get(old)
        d?.pendingRevoked.push({ chat_id: st.chat_id, epoch: st.epoch, reason })
      }
    }
    emitState(u, st, { kind: 'host_changed', device_id: toId, reason })
  }

  function relayCommand(
    u: User,
    st: ChatSt,
    fromId: string,
    hostId: string,
    cmdId: string,
    kind: string,
    env: any
  ): boolean {
    const c = connOf(hostId)
    if (!c) {
      sendDevice(fromId, {
        t: 'remote.failed',
        chat_id: st.chat_id,
        cmd_id: cmdId,
        code: 'host_offline'
      })
      return false
    }
    const key = `${u.id}|${cmdId}`
    const prev = pendingCmds.get(key)
    if (prev) clearTimeout(prev.timer)
    const timer = setTimeout(() => {
      if (pendingCmds.get(key)?.timer !== timer) return
      pendingCmds.delete(key)
      sendDevice(fromId, {
        t: 'remote.failed',
        chat_id: st.chat_id,
        cmd_id: cmdId,
        code: 'command_timeout'
      })
    }, o.commandTimeoutMs)
    pendingCmds.set(key, {
      userId: u.id,
      chat_id: st.chat_id,
      cmd_id: cmdId,
      fromDeviceId: fromId,
      hostDeviceId: hostId,
      timer
    })
    send(c, {
      t: 'remote.command',
      chat_id: st.chat_id,
      cmd_id: cmdId,
      kind,
      env,
      from_device_id: fromId,
      created_at: nowIso()
    })
    return true
  }

  function failPendingForHost(hostId: string): void {
    for (const [k, p] of pendingCmds) {
      if (p.hostDeviceId !== hostId) continue
      clearTimeout(p.timer)
      pendingCmds.delete(k)
      sendDevice(p.fromDeviceId, {
        t: 'remote.failed',
        chat_id: p.chat_id,
        cmd_id: p.cmd_id,
        code: 'host_offline'
      })
    }
  }

  /** Conexão caiu/fechou: tolerância do host (ou nada, se substituída). */
  function onConnGone(c: Conn): void {
    if (c.closed) return
    c.closed = true
    conns.delete(c)
    if (c.helloTimer) clearTimeout(c.helloTimer)
    if (!c.deviceId || !c.userId || c.superseded) return
    const dev = devices.get(c.deviceId)
    const u = users.get(c.userId)
    if (!dev || !u) return
    failPendingForHost(dev.id)
    if (dev.revoked) return
    dev.inGrace = true
    if (dev.graceTimer) clearTimeout(dev.graceTimer)
    dev.graceTimer = setTimeout(() => graceExpired(dev), o.hostDropGraceMs)
    for (const st of u.chats.values()) if (st.host_device_id === dev.id) emitState(u, st)
    if (liveOf(u, dev.id).length)
      for (const o2 of liveConns(u.id, dev.id))
        send(o2, { t: 'live.host', host_device_id: dev.id, status: 'grace' })
  }

  function graceExpired(dev: Device): void {
    dev.graceTimer = undefined
    if (!dev.inGrace) return
    dev.inGrace = false
    dev.wentOffline = true
    const u = users.get(dev.userId)
    if (!u) return
    for (const st of [...u.chats.values()]) {
      if (st.host_device_id !== dev.id) continue
      st.window = null
      emitState(u, st, { kind: 'host_dropped', device_id: dev.id })
      if (st.handover) grant(u, st, st.handover.to_device_id, 'takeover')
    }
    liveRemove(u, dev.id, liveOf(u, dev.id), 'host_dropped')
  }

  // ---------------- chats só ao vivo (§23) ----------------

  const liveConns = (userId: string, exceptDevice?: string): Conn[] =>
    userConns(userId).filter((c) => c.caps.has('live_chats') && c.deviceId !== exceptDevice)

  function toLiveChat(b: LiveBinding): any {
    const host = devices.get(b.host_device_id)
    return {
      chat_id: b.chat_id,
      epoch: b.epoch,
      arev: b.arev,
      running: b.running,
      env: b.env,
      host: {
        device_id: b.host_device_id,
        name: host?.name ?? '',
        platform: host?.platform ?? '',
        status: devStatus(b.host_device_id) === 'online' ? 'online' : 'grace'
      },
      announced_at: b.announced_at
    }
  }

  function liveRemove(u: User, hostId: string, ids: string[], reason: string): void {
    const gone = ids.filter((id) => u.live.get(id)?.host_device_id === hostId)
    for (const id of gone) u.live.delete(id)
    if (!gone.length) return
    for (const c of liveConns(u.id, hostId))
      send(c, { t: 'live.removed', host_device_id: hostId, chat_ids: gone, reason })
  }

  const liveOf = (u: User, hostId: string): string[] =>
    [...u.live.values()].filter((b) => b.host_device_id === hostId).map((b) => b.chat_id)

  function liveAnnounce(c: Conn, u: User, dev: Device, f: any): any {
    const accepted: string[] = []
    const rejected: any[] = []
    const changed: LiveBinding[] = []
    const items = Array.isArray(f.chats) ? f.chats : []
    for (const it of items) {
      const chatId = typeof it?.chat_id === 'string' ? it.chat_id : ''
      if (
        !chatId ||
        !ID_RE.test(chatId) ||
        !Number.isSafeInteger(it.epoch) ||
        it.epoch < 1 ||
        !Number.isSafeInteger(it.arev) ||
        it.arev < 1 ||
        !validEnvelope(it.env) ||
        JSON.stringify(it.env).length > 2048
      ) {
        rejected.push({ chat_id: chatId, code: 'invalid_request' })
        continue
      }
      const rec = u.records.get(recKey('chat', chatId))
      if ((rec && !rec.deleted) || u.chats.has(chatId)) {
        rejected.push({ chat_id: chatId, code: 'live_conflict', reason: 'exists_online' })
        continue
      }
      const cur = u.live.get(chatId)
      if (cur && cur.host_device_id !== dev.id) {
        rejected.push({ chat_id: chatId, code: 'live_conflict', reason: 'other_host' })
        continue
      }
      if (cur && cur.epoch === it.epoch && it.arev <= cur.arev) {
        accepted.push(chatId)
        continue
      }
      const b: LiveBinding = {
        chat_id: chatId,
        host_device_id: dev.id,
        epoch: it.epoch,
        arev: it.arev,
        running: it.running === true,
        env: it.env,
        announced_at: nowIso()
      }
      u.live.set(chatId, b)
      accepted.push(chatId)
      changed.push(b)
    }
    if (f.full === true) {
      const keep = new Set(accepted)
      liveRemove(
        u,
        dev.id,
        liveOf(u, dev.id).filter((id) => !keep.has(id)),
        'withdrawn'
      )
    }
    if (changed.length)
      for (const o2 of liveConns(u.id, dev.id))
        send(o2, { t: 'live.update', chats: changed.map(toLiveChat) })
    void c
    return { accepted, rejected }
  }

  // ---------------- registros ----------------

  const recKey = (type: string, id: string): string => `${type}|${id}`

  function toChange(r: Rec, payload = true): any {
    const out: any = {
      seq: r.seq,
      type: r.type,
      id: r.id,
      scope: r.scope,
      rev: r.rev,
      deleted: r.deleted,
      size: r.size,
      blobs: r.blobs,
      device_id: r.device_id,
      updated_at: r.updated_at
    }
    if (!r.deleted && r.env) {
      if (payload) out.env = r.env
      else out.omitted = true
    }
    return out
  }

  function changesSince(u: User, since: number, limit: number, payload: boolean): any {
    if (!isInt(since)) throw err('invalid_request', { field: 'since' })
    if (since < u.tombstoneFloor) throw err('cursor_expired', { floor: u.tombstoneFloor })
    const lim = Math.min(1000, Math.max(1, isInt(limit, 1) ? limit : 500))
    const all = [...u.records.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq)
    const out: any[] = []
    let bytes = 0
    for (const r of all) {
      if (out.length >= lim) break
      const ch = toChange(r, payload)
      bytes += JSON.stringify(ch).length
      if (out.length && bytes > PULL_MAX_BYTES) break
      out.push(ch)
    }
    const hasMore = out.length < all.length
    return {
      changes: out,
      next: out.length ? out[out.length - 1].seq : u.seq,
      has_more: hasMore,
      head: u.seq
    }
  }

  function recordsList(u: User, q: URLSearchParams): any {
    const type = q.get('type')
    const scope = q.get('scope')
    const after = Number(q.get('after') ?? 0) || 0
    const lim = Math.min(1000, Math.max(1, Number(q.get('limit') ?? 500) || 500))
    const payload = q.get('payload') !== '0'
    const all = [...u.records.values()]
      .filter(
        (r) =>
          !r.deleted &&
          r.seq > after &&
          (!type || r.type === type) &&
          (scope == null || r.scope === scope)
      )
      .sort((a, b) => a.seq - b.seq)
    const out = all.slice(0, lim).map((r) => toChange(r, payload))
    return {
      records: out,
      next: out.length ? out[out.length - 1].seq : after,
      has_more: all.length > out.length,
      head: u.seq
    }
  }

  function validateItem(it: any): void {
    if (!it || typeof it !== 'object') throw err('invalid_request', { reason: 'item' })
    if (typeof it.type !== 'string' || !TYPES.has(it.type))
      throw err('invalid_request', { reason: 'unknown_type', type: it.type })
    if (typeof it.id !== 'string' || !ID_RE.test(it.id))
      throw err('invalid_request', { reason: 'id', id: it.id })
    const scope = it.scope ?? null
    if (it.type === 'chat') {
      if (scope !== it.id) throw err('invalid_request', { reason: 'scope', id: it.id })
    } else if (CONTENT.has(it.type) || it.type === 'memory') {
      if (typeof scope !== 'string' || !ID_RE.test(scope))
        throw err('invalid_request', { reason: 'scope', id: it.id })
    } else if (scope !== null) throw err('invalid_request', { reason: 'scope', id: it.id })
    if (!isInt(it.base_rev) || !isInt(it.rev, 1) || it.rev !== it.base_rev + 1)
      throw err('invalid_request', { reason: 'rev', id: it.id })
    if (typeof it.deleted !== 'boolean') throw err('invalid_request', { reason: 'deleted' })
    const blobs = it.blobs ?? []
    if (
      !Array.isArray(blobs) ||
      blobs.some((b: unknown) => typeof b !== 'string' || !BLOB_RE.test(b))
    )
      throw err('invalid_request', { reason: 'blobs', id: it.id })
    if (it.deleted) {
      if (it.env != null || blobs.length) throw err('invalid_request', { reason: 'tombstone' })
      if (it.type === 'setting') throw err('invalid_request', { reason: 'setting_tombstone' })
    } else if (!validEnvelope(it.env))
      throw err('invalid_request', { reason: 'envelope', id: it.id })
  }

  /** Checagens de revisão/escopo (sem aplicar). Retorna os conflitos. */
  function checkRevsAndScopes(u: User, items: any[]): any[] {
    const conflicts: any[] = []
    const inBatch = new Map<string, any>()
    for (const it of items) inBatch.set(recKey(it.type, it.id), it)
    for (const it of items) {
      const cur = u.records.get(recKey(it.type, it.id))
      const curRev = cur?.rev ?? 0
      if (cur?.deleted) {
        if (it.base_rev !== cur.rev)
          conflicts.push({ type: it.type, id: it.id, reason: 'gone', current: toChange(cur) })
      } else if (curRev !== it.base_rev) {
        conflicts.push({
          type: it.type,
          id: it.id,
          reason: 'rev_mismatch',
          ...(cur ? { current: toChange(cur) } : {})
        })
      }
      // escopo
      let parentType: string | null = null
      if (CONTENT.has(it.type)) parentType = 'chat'
      else if (it.type === 'memory') parentType = 'memory_collection'
      if (parentType && !it.deleted) {
        const k = recKey(parentType, it.scope)
        const b = inBatch.get(k)
        const p = u.records.get(k)
        if (b) {
          if (b.deleted) conflicts.push({ type: it.type, id: it.id, reason: 'scope_deleted' })
        } else if (!p) conflicts.push({ type: it.type, id: it.id, reason: 'scope_missing' })
        else if (p.deleted) conflicts.push({ type: it.type, id: it.id, reason: 'scope_deleted' })
      }
    }
    return conflicts
  }

  function applyItems(
    u: User,
    dev: Device,
    items: any[]
  ): { results: any[]; changes: any[]; chatHeads: Record<string, number> } {
    const results: any[] = []
    const changed: Rec[] = []
    const chatHeads: Record<string, number> = {}
    for (const it of items) {
      const seq = ++u.seq
      const blobs: string[] = it.deleted ? [] : [...new Set<string>(it.blobs ?? [])]
      const rec: Rec = {
        type: it.type,
        id: it.id,
        scope: it.scope ?? null,
        rev: it.rev,
        seq,
        deleted: it.deleted,
        ...(it.deleted ? {} : { env: it.env }),
        size: it.deleted ? 0 : b64uLen(it.env.c),
        blobs,
        device_id: dev.id,
        updated_at: nowIso()
      }
      u.records.set(recKey(it.type, it.id), rec)
      changed.push(rec)
      results.push({ type: it.type, id: it.id, rev: it.rev, seq })
      if (CONTENT.has(it.type)) {
        const st = chatOf(u, it.scope)!
        st.head = seq
        chatHeads[it.scope] = seq
      }
      if (it.type === 'chat') {
        if (it.deleted) {
          for (const [k, r] of u.records)
            if (r.scope === it.id && r.type !== 'chat') u.records.delete(k)
          const st = u.chats.get(it.id)
          if (st) clearHandover(st)
          u.chats.delete(it.id)
        } else chatOf(u, it.id)
      }
      if (it.type === 'memory_collection' && it.deleted) {
        for (const [k, r] of u.records)
          if (r.type === 'memory' && r.scope === it.id) u.records.delete(k)
      }
    }
    // registros removidos fisicamente por cascata no mesmo lote não vão ao feed
    const live = changed.filter((r) => u.records.get(recKey(r.type, r.id)) === r)
    return { results, changes: live.map((r) => toChange(r)), chatHeads }
  }

  function doPush(u: User, dev: Device, body: any): any {
    if (!body || typeof body !== 'object') throw err('invalid_request')
    if (typeof body.push_id !== 'string' || !body.push_id)
      throw err('invalid_request', { field: 'push_id' })
    const items = body.items
    if (!Array.isArray(items)) throw err('invalid_request', { field: 'items' })
    // como o servidor real: itens demais = corpo inválido (o 413 é para bytes)
    if (items.length > MAX_PUSH_ITEMS)
      throw err('invalid_request', { field: 'items', reason: 'too_many', limit: MAX_PUSH_ITEMS })
    for (const it of items) validateItem(it)
    const seen = new Set<string>()
    for (const it of items) {
      const k = recKey(it.type, it.id)
      if (seen.has(k)) throw err('invalid_request', { reason: 'duplicate', id: it.id })
      seen.add(k)
    }
    // 2. idempotência
    const receipt = u.receipts.get(body.push_id)
    if (receipt) return receipt
    // 3. blobs
    const missing = [
      ...new Set(
        items.flatMap((it: any) => (it.blobs ?? []) as string[]).filter((b) => !u.blobs.has(b))
      )
    ]
    if (missing.length) throw err('blob_missing', { missing })
    // 7. conteúdo do chat (host / replay / divergência) — como o servidor real, ANTES das revisões
    // (replay offline → divergência, não rev_mismatch)
    const chatBases = (body.chat_bases ?? {}) as Record<string, unknown>
    const hostEpochs = (body.host_epochs ?? {}) as Record<string, unknown>
    const contentChats = new Set<string>()
    for (const it of items) if (CONTENT.has(it.type)) contentChats.add(it.scope)
    const becameHost: ChatSt[] = []
    for (const it of items) {
      if (it.type !== 'chat') continue
      const st = u.chats.get(it.id)
      if (!st) continue
      if (st.diverged && !it.deleted)
        throw err('chat_diverged', { chat_id: it.id, diverged: toChatState(st).diverged })
      if (it.deleted && st.window) throw err('chat_busy', { chat_id: it.id })
    }
    for (const chatId of contentChats) {
      const b = chatBases[chatId]
      if (!isInt(b)) throw err('invalid_request', { reason: 'chat_bases', chat_id: chatId })
      const st = chatOf(u, chatId)!
      if (st.diverged)
        throw err('chat_diverged', { chat_id: chatId, diverged: toChatState(st).diverged })
      let he = hostEpochs[chatId]
      // servidor real: host_epochs com a janela fechada = replay; push durante a tolerância do
      // WS do host → chat_busy; push do host sem host_epochs com a janela aberta (dele) = aceito
      if (st.host_device_id && devStatus(st.host_device_id) === 'grace')
        throw err('chat_busy', { chat_id: chatId })
      if (he !== undefined && !st.window) he = undefined
      const ownWindow =
        !!st.window &&
        st.window.device_id === dev.id &&
        st.host_device_id === dev.id &&
        !!connOf(dev.id)
      if (he !== undefined) {
        if (!ownWindow || he !== st.epoch)
          throw err('not_host', { chat_id: chatId, state: toChatState(st) })
      } else if (st.window && !ownWindow) {
        throw err('chat_busy', { chat_id: chatId })
      }
      if (b > st.head) throw err('stale_base', { chat_id: chatId, head: st.head })
      if (b < st.head) {
        const disc = u.discards.find(
          (d) => d.chat_id === chatId && d.device_id === dev.id && d.base === b
        )
        if (disc) throw err('divergence_discarded', { chat_id: chatId, divergence_id: null })
        st.diverged = {
          divergence_id: randomUUID(),
          device_id: dev.id,
          base: b,
          head: st.head,
          since: nowIso()
        }
        emitState(u, st, { kind: 'diverged', device_id: dev.id })
        throw err('chat_diverged', { chat_id: chatId, diverged: toChatState(st).diverged })
      }
      if (he === undefined && !st.host_device_id && dev.can_host) becameHost.push(st)
    }
    // §23.3: chat com vínculo ao vivo — de outro dispositivo, recusa o lote; do host, é a conversão
    const liveTouched = new Set<string>()
    for (const it of items) {
      const cid = it.type === 'chat' ? it.id : CONTENT.has(it.type) ? it.scope : null
      const b = cid ? u.live.get(cid) : undefined
      if (!b) continue
      if (b.host_device_id !== dev.id) throw err('live_conflict', { chat_id: cid, reason: 'live' })
      if (it.type === 'chat' && !it.deleted) liveTouched.add(cid)
    }
    // 4–6. revisões e escopos
    const conflicts = checkRevsAndScopes(u, items)
    if (conflicts.length) throw err('conflict', { conflicts })
    // 9. aplica
    const { results, changes, chatHeads } = applyItems(u, dev, items)
    for (const cid of liveTouched) liveRemove(u, dev.id, [cid], 'saved_online')
    for (const st of becameHost) {
      if (!u.chats.has(st.chat_id)) continue
      st.host_device_id = dev.id
      st.epoch++
      emitState(u, st, { kind: 'host_changed', device_id: dev.id, reason: 'replay' })
    }
    for (const chatId of Object.keys(chatHeads)) {
      const st = u.chats.get(chatId)
      if (st && !becameHost.includes(st)) st.ssq = ++u.ssq
    }
    const resp = { results, head: u.seq, chat_heads: chatHeads }
    u.receipts.set(body.push_id, resp)
    if (changes.length) broadcast(u.id, { t: 'sync.changes', changes, head: u.seq })
    return resp
  }

  function resolveDivergence(u: User, dev: Device, chatId: string, body: any): any {
    const st = u.chats.get(chatId)
    if (!body || typeof body !== 'object') throw err('invalid_request')
    if (!st?.diverged || body.divergence_id !== st.diverged.divergence_id)
      throw err('divergence_mismatch', { chat_id: chatId })
    const d = st.diverged
    if (body.keep === 'online') {
      u.discards.push({ chat_id: chatId, device_id: d.device_id, base: d.base })
      st.diverged = null
      emitState(u, st, { kind: 'resolved', device_id: dev.id, reason: 'online' })
      return { state: toChatState(st) }
    }
    if (body.keep !== 'local') throw err('invalid_request', { field: 'keep' })
    if (dev.id !== d.device_id) throw err('divergence_mismatch', { chat_id: chatId })
    if (typeof body.push_id === 'string' && u.receipts.has(body.push_id))
      return u.receipts.get(body.push_id)
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length > MAX_PUSH_ITEMS)
      throw err('invalid_request', { field: 'items', reason: 'too_many', limit: MAX_PUSH_ITEMS })
    for (const it of items) {
      validateItem(it)
      if (it.scope !== chatId) throw err('invalid_request', { reason: 'scope', id: it.id })
      if (it.type === 'chat' && it.deleted) throw err('invalid_request', { reason: 'chat_delete' })
    }
    const missing = [
      ...new Set(
        items.flatMap((it: any) => (it.blobs ?? []) as string[]).filter((b) => !u.blobs.has(b))
      )
    ]
    if (missing.length) throw err('blob_missing', { missing })
    const conflicts = checkRevsAndScopes(u, items)
    if (conflicts.length) throw err('conflict', { conflicts })
    const { results, changes, chatHeads } = applyItems(u, dev, items)
    st.diverged = null
    if (!st.host_device_id && dev.can_host) {
      st.host_device_id = dev.id
      st.epoch++
    }
    const resp: any = { results, head: u.seq, chat_heads: { [chatId]: st.head, ...chatHeads } }
    if (changes.length) broadcast(u.id, { t: 'sync.changes', changes, head: u.seq })
    emitState(u, st, { kind: 'resolved', device_id: dev.id, reason: 'local' })
    resp.state = toChatState(st)
    if (typeof body.push_id === 'string') u.receipts.set(body.push_id, resp)
    return resp
  }

  // ---------------- chaves ----------------

  function validWrap(w: any): boolean {
    return !!w && b64uLen(w.n) === 12 && b64uLen(w.c) === 48
  }
  function validPasswordSlot(p: any): boolean {
    const k = p?.kdf
    return (
      !!k &&
      k.alg === 'argon2id' &&
      k.v === 19 &&
      k.len === 32 &&
      isInt(k.m) &&
      k.m >= ARGON2_BOUNDS.mMin &&
      k.m <= ARGON2_BOUNDS.mMax &&
      isInt(k.t) &&
      k.t >= ARGON2_BOUNDS.tMin &&
      k.t <= ARGON2_BOUNDS.tMax &&
      isInt(k.p) &&
      k.p >= ARGON2_BOUNDS.pMin &&
      k.p <= ARGON2_BOUNDS.pMax &&
      b64uLen(p.salt) === 16 &&
      validWrap(p.wrap)
    )
  }
  function validRecoverySlot(r: any): boolean {
    return !!r && r.kdf?.alg === 'hkdf-sha256' && b64uLen(r.salt) === 16 && validWrap(r.wrap)
  }
  function checkProof(u: User, proof: unknown): void {
    if (!u.keys) throw err('keys_not_ready')
    if (typeof proof !== 'string' || b64uLen(proof) < 1) throw err('key_proof_invalid')
    const h = createHash('sha256').update(Buffer.from(proof, 'base64url')).digest('base64url')
    if (h !== u.keys.verifier) throw err('key_proof_invalid')
  }

  function wipeUserData(u: User): void {
    for (const st of u.chats.values()) clearHandover(st)
    u.records.clear()
    u.chats.clear()
    u.blobs.clear()
    u.receipts.clear()
    u.discards = []
    for (const [k, p] of pendingCmds) {
      if (p.userId !== u.id) continue
      clearTimeout(p.timer)
      pendingCmds.delete(k)
    }
  }

  // ---------------- REST ----------------

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  const html = (title: string, body: string): string =>
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;background:#111;color:#ddd">${body}</body></html>`

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<number> {
    const full = new URL(req.url ?? '/', 'http://x')
    let path = full.pathname
    if (o.basePath) {
      if (path !== o.basePath && !path.startsWith(o.basePath + '/')) throw err('not_found')
      path = path.slice(o.basePath.length) || '/'
    }
    const method = req.method ?? 'GET'
    const q = full.searchParams
    const ip = req.socket.remoteAddress ?? ''
    const json = (status: number, body: any): number => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(body === undefined ? '' : JSON.stringify(body))
      return status
    }
    const page = (body: string): number => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(body)
      return 200
    }

    // páginas
    if (method === 'GET' && path === '/captcha') {
      const nonce = JSON.stringify(q.get('nonce') ?? '')
      const done = JSON.stringify(`${url}/captcha/done`)
      return page(
        html(
          'Verificação',
          `<p>Verificando…</p><script>setTimeout(function(){location.href=${done}+'#token=fake-'+Math.random().toString(36).slice(2)+'&nonce='+encodeURIComponent(${nonce})},200)</script>`
        )
      )
    }
    if (method === 'GET' && path === '/captcha/done') return page(html('Pronto', '<p>Pronto.</p>'))
    if (method === 'GET' && (path === '/signup' || path === '/setup' || path === '/'))
      return page(html(o.name, `<h1>${o.name}</h1><p>${path}</p>`))

    if (method === 'GET' && path === '/api/info') {
      return json(200, {
        name: o.name,
        server_version: '0.0.0-fake',
        base_url: url,
        protocol: { min: o.protocol.min, max: o.protocol.max, version: `${o.protocol.max}.0.0` },
        features: {
          signupOpen: o.signupOpen,
          captcha: o.captcha ? { provider: 'turnstile', siteKey: 'fake' } : null,
          landing: true,
          gateway: false,
          push: o.push ? { providers: ['fcm'] } : null,
          liveChats: o.liveChats
        },
        links: {
          download: 'https://github.com/ezenere/ClearChatDesktop/releases',
          ...(o.signupOpen ? { signup: `${url}/signup` } : {})
        }
      })
    }

    if (!path.startsWith('/api/v1/')) throw err('not_found')
    const p = path.slice('/api/v1'.length)
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req)
    const isBlobPut = method === 'PUT' && p.startsWith('/blobs/')
    let body: any = {}
    if (!isBlobPut && raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        throw err('invalid_request', { reason: 'json' })
      }
    }

    // ---- auth (sem token) ----
    if (method === 'GET' && p.startsWith('/auth/invite/')) return json(200, { valid: false })
    if (method === 'POST' && p === '/auth/signup/start') {
      const email = normEmail(body.email)
      if (!email.includes('@')) throw err('invalid_request', { field: 'email' })
      checkCaptcha(body.turnstile_token)
      if (body.invite_token != null) throw err('invite_invalid')
      if (!o.signupOpen) throw err('signup_closed')
      if (!usersByEmail.has(email))
        issueCode('signup', email, { name: String(body.name ?? '').slice(0, 64) })
      return json(202, { ok: true })
    }
    if (method === 'POST' && p === '/auth/signup/verify') {
      const email = normEmail(body.email)
      if (usersByEmail.has(email)) throw err('code_invalid')
      const c = consumeCode('signup', email, body.code)
      const u = newUser(email, c.name || email.split('@')[0])
      const dev = newDevice(u.id, body.device, ip)
      return json(201, authResult(u, dev))
    }
    if (method === 'POST' && p === '/auth/code/request') {
      const email = normEmail(body.email)
      if (!email) throw err('invalid_request', { field: 'email' })
      checkCaptcha(body.turnstile_token)
      if (usersByEmail.has(email)) issueCode('login', email)
      return json(202, { ok: true })
    }
    if (method === 'POST' && p === '/auth/code/verify') {
      const email = normEmail(body.email)
      const uid = usersByEmail.get(email)
      if (!uid) throw err('code_invalid')
      consumeCode('login', email, body.code)
      const u = users.get(uid)!
      const dev = newDevice(u.id, body.device, ip)
      return json(200, authResult(u, dev))
    }
    if (method === 'POST' && p === '/auth/refresh') {
      const t = typeof body.refresh_token === 'string' ? body.refresh_token : ''
      const r = refresh.get(t)
      if (!r) throw err('unauthorized')
      const dev = devices.get(r.deviceId)
      if (!dev || dev.revoked) throw err('device_revoked')
      if (r.used) {
        revokeDevice(dev)
        throw err('refresh_reused')
      }
      r.used = true
      return json(200, issueTokens(dev.id))
    }

    // ---- autenticado ----
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const { user: u, device: dev } = authFromToken(token)
    ;(res as any).__deviceId = dev.id
    // dispositivo "sem rede" (setRefuseConnections): REST também não chega
    if (refused.has(dev.id)) {
      req.socket.destroy()
      return 0
    }

    if (method === 'POST' && p === '/auth/logout') {
      revokeDevice(dev, 'logout')
      return json(204, undefined)
    }
    if (method === 'POST' && p === '/auth/reauth/request') {
      if (body.purpose !== 'delete_account' && body.purpose !== 'reset_keys')
        throw err('invalid_request', { field: 'purpose' })
      issueCode(body.purpose, u.email)
      return json(202, { ok: true })
    }

    // conta
    const accountBody = (): any => {
      const recs = [...u.records.values()]
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        created_at: u.created_at,
        keys_ready: !!u.keys,
        usage: {
          record_bytes: recs.reduce((s, r) => s + r.size, 0),
          records: recs.filter((r) => !r.deleted).length,
          blob_bytes: [...u.blobs.values()].reduce((s, b) => s + b.length, 0),
          blobs: u.blobs.size,
          devices: [...devices.values()].filter((d) => d.userId === u.id && !d.revoked).length
        },
        quotas: { record_bytes: null, records: null, blob_bytes: null, devices: null }
      }
    }
    if (method === 'GET' && p === '/account') return json(200, accountBody())
    if (method === 'PATCH' && p === '/account') {
      if (typeof body.name === 'string' && body.name.trim()) u.name = body.name.trim().slice(0, 64)
      return json(200, accountBody())
    }
    if (method === 'DELETE' && p === '/account') {
      consumeCode('delete_account', u.email, body.code)
      broadcast(u.id, { t: 'account.deleted' })
      for (const c of userConns(u.id)) closeConn(c, 4403, 'account_deleted')
      wipeUserData(u)
      for (const d of devices.values()) if (d.userId === u.id) revokeDevice(d)
      users.delete(u.id)
      usersByEmail.delete(u.email)
      return json(204, undefined)
    }

    // chaves
    if (method === 'GET' && p === '/keys') {
      if (!u.keys) throw err('keys_not_ready')
      return json(200, keysResponse(u))
    }
    if (method === 'POST' && p === '/keys/setup') {
      if (u.keys) throw err('keys_already_set')
      if (!validPasswordSlot(body.password) || !validRecoverySlot(body.recovery))
        throw err('invalid_request', { reason: 'keys' })
      if (b64uLen(body.verifier) !== 32) throw err('invalid_request', { field: 'verifier' })
      u.keys = {
        key_version: 1,
        keys_rev: 1,
        password: body.password,
        recovery: body.recovery,
        verifier: body.verifier
      }
      return json(200, keysResponse(u))
    }
    if (method === 'PUT' && (p === '/keys/password' || p === '/keys/recovery')) {
      checkProof(u, body.key_proof)
      const slot = p === '/keys/password' ? 'password' : 'recovery'
      const ok =
        slot === 'password' ? validPasswordSlot(body.password) : validRecoverySlot(body.recovery)
      if (!ok) throw err('invalid_request', { reason: slot })
      u.keys![slot] = body[slot]
      u.keys!.keys_rev++
      broadcast(u.id, { t: 'keys.changed', keys_rev: u.keys!.keys_rev })
      return json(200, keysResponse(u))
    }
    if (method === 'POST' && p === '/keys/reset') {
      consumeCode('reset_keys', u.email, body.code)
      wipeUserData(u)
      u.keys = null
      broadcast(u.id, { t: 'keys.reset' })
      for (const c of userConns(u.id)) closeConn(c, 4403, 'keys_reset')
      return json(204, undefined)
    }

    // dispositivos
    if (method === 'GET' && p === '/devices') {
      return json(
        200,
        [...devices.values()]
          .filter((d) => d.userId === u.id && !d.revoked)
          .map((d) => ({
            id: d.id,
            name: d.name,
            platform: d.platform,
            client: d.client,
            app_version: d.app_version,
            can_host: d.can_host,
            created_at: d.created_at,
            last_seen_at: d.last_seen_at,
            last_ip: d.last_ip,
            online: !!connOf(d.id),
            current: d.id === dev.id,
            push: !!d.pushToken
          }))
      )
    }
    // notificações push (§22)
    if (p === '/devices/current/push') {
      if (method === 'PUT') {
        if (body.provider !== 'fcm') throw err('invalid_request', { field: 'provider' })
        if (typeof body.token !== 'string' || !body.token || body.token.length > 4096)
          throw err('invalid_request', { field: 'token' })
        for (const d of devices.values()) if (d.pushToken === body.token) d.pushToken = null
        dev.pushToken = body.token
        return json(204, undefined)
      }
      if (method === 'DELETE') {
        dev.pushToken = null
        return json(204, undefined)
      }
    }
    if (method === 'POST' && p === '/push') {
      if (!o.push) throw err('push_unavailable')
      const kinds = ['approval', 'question', 'retry', 'reply', 'error', 'dismiss']
      if (!kinds.includes(body.kind)) throw err('invalid_request', { field: 'kind' })
      if (typeof body.tag !== 'string' || !/^[0-9a-f]{32}$/.test(body.tag))
        throw err('invalid_request', { field: 'tag' })
      const to = body.to
      if (
        to !== 'all' &&
        !(Array.isArray(to) && to.length <= 20 && to.every((x: unknown) => typeof x === 'string'))
      )
        throw err('invalid_request', { field: 'to' })
      if (body.kind === 'dismiss') {
        if (body.env != null) throw err('invalid_request', { field: 'env' })
      } else if (!validEnvelope(body.env) || JSON.stringify(body.env).length > 2048) {
        throw err('invalid_request', { field: 'env' })
      }
      const targets = [...devices.values()]
        .filter(
          (d) =>
            d.userId === u.id &&
            !d.revoked &&
            !!d.pushToken &&
            (to === 'all' ? d.id !== dev.id : to.includes(d.id))
        )
        .map((d) => d.id)
      pushes.push({
        at: Date.now(),
        fromDeviceId: dev.id,
        kind: body.kind,
        tag: body.tag,
        to,
        env: body.env ?? null,
        targets
      })
      return json(200, { sent: targets.length })
    }
    const devMatch = /^\/devices\/([^/]+)$/.exec(p)
    if (devMatch) {
      const target = devices.get(decodeURIComponent(devMatch[1]))
      if (!target || target.userId !== u.id || target.revoked) throw err('not_found')
      if (method === 'PATCH') {
        if (typeof body.name === 'string' && body.name.trim())
          target.name = body.name.trim().slice(0, 64)
        return json(200, { id: target.id, name: target.name })
      }
      if (method === 'DELETE') {
        revokeDevice(target)
        return json(204, undefined)
      }
    }

    // sync
    if (method === 'GET' && p === '/sync/changes') {
      return json(
        200,
        changesSince(
          u,
          Number(q.get('since') ?? 0),
          Number(q.get('limit') ?? 500),
          q.get('payload') !== '0'
        )
      )
    }
    if (method === 'POST' && p === '/sync/push') return json(200, doPush(u, dev, body))
    if (method === 'GET' && p === '/records') return json(200, recordsList(u, q))
    if (method === 'POST' && p === '/records/fetch') {
      const items = Array.isArray(body.items) ? body.items : null
      if (!items || items.length > 500) throw err('invalid_request', { field: 'items' })
      const out: any[] = []
      for (const it of items) {
        const r = u.records.get(recKey(String(it?.type), String(it?.id)))
        if (r) out.push(toChange(r))
      }
      return json(200, { records: out })
    }
    if (method === 'GET' && p === '/chat-states') {
      const since = Number(q.get('since') ?? 0) || 0
      return json(200, {
        chat_states: [...u.chats.values()].filter((s) => s.ssq > since).map(toChatState),
        state_cursor: u.ssq
      })
    }
    const resolveMatch = /^\/chats\/([^/]+)\/divergence\/resolve$/.exec(p)
    if (method === 'POST' && resolveMatch)
      return json(200, resolveDivergence(u, dev, decodeURIComponent(resolveMatch[1]), body))

    // blobs
    if (method === 'POST' && p === '/blobs/check') {
      const ids = Array.isArray(body.ids) ? body.ids : null
      if (
        !ids ||
        ids.length > 1000 ||
        ids.some((i: unknown) => typeof i !== 'string' || !BLOB_RE.test(i))
      )
        throw err('invalid_request', { field: 'ids' })
      return json(200, {
        present: ids.filter((i: string) => u.blobs.has(i)),
        missing: ids.filter((i: string) => !u.blobs.has(i))
      })
    }
    const blobMatch = /^\/blobs\/([^/]+)$/.exec(p)
    if (blobMatch) {
      const id = blobMatch[1]
      if (!BLOB_RE.test(id)) throw err('invalid_request', { field: 'blob_id' })
      if (method === 'PUT') {
        const want = String(req.headers['x-content-sha256'] ?? '').toLowerCase()
        if (!want || sha256hex(raw) !== want) throw err('invalid_request', { reason: 'sha256' })
        if (raw.length < 37 || raw.subarray(0, 4).toString('latin1') !== 'CCB1')
          throw err('invalid_request', { reason: 'magic' })
        const existed = u.blobs.has(id)
        if (!existed) u.blobs.set(id, Buffer.from(raw))
        return json(existed ? 200 : 201, { blob_id: id, created: !existed })
      }
      if (method === 'GET') {
        const b = u.blobs.get(id)
        if (!b) throw err('not_found')
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'X-Content-SHA256': sha256hex(b),
          'Content-Length': String(b.length)
        })
        res.end(b)
        return 200
      }
    }
    throw err('not_found')
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    handle(req, res)
      .then((status) => {
        requests.push({
          method: req.method ?? 'GET',
          path,
          status,
          deviceId: (res as any).__deviceId
        })
      })
      .catch((e: unknown) => {
        const ae =
          e instanceof ApiError ? e : new ApiError(500, 'internal', (e as Error)?.message ?? 'erro')
        if (!(e instanceof ApiError)) o.log(`[fake-sync] erro interno: ${(e as Error)?.stack}`)
        requests.push({
          method: req.method ?? 'GET',
          path,
          status: ae.status,
          deviceId: (res as any).__deviceId
        })
        if (res.headersSent) {
          res.end()
          return
        }
        res.writeHead(ae.status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({ error: { code: ae.code, message: ae.message, details: ae.details } })
        )
      })
  })

  // ---------------- WebSocket ----------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path !== `${o.basePath}/ws`) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws))
  })

  function onConnection(ws: WebSocket): void {
    const c: Conn = {
      ws,
      deviceId: null,
      userId: null,
      subscriptions: new Set(),
      lastFrameAt: Date.now(),
      superseded: false,
      closed: false,
      caps: new Set()
    }
    conns.add(c)
    c.helloTimer = setTimeout(() => {
      if (!c.deviceId) closeConn(c, 4002, 'hello_timeout')
    }, o.helloTimeoutMs)
    ws.on('message', (data) => {
      c.lastFrameAt = Date.now()
      let frame: any
      try {
        frame = JSON.parse(String(data))
      } catch {
        closeConn(c, 4000, 'protocol_error')
        return
      }
      wsLog.push({ dir: 'in', deviceId: c.deviceId ?? undefined, t: frame?.t, frame })
      try {
        onFrame(c, frame)
      } catch (e) {
        const ae =
          e instanceof ApiError ? e : new ApiError(500, 'internal', (e as Error)?.message ?? 'erro')
        if (!(e instanceof ApiError)) o.log(`[fake-sync] erro interno (ws): ${(e as Error)?.stack}`)
        if (frame && frame.id != null)
          send(c, {
            t: 'error',
            re: frame.id,
            code: ae.code,
            message: ae.message,
            details: ae.details
          })
      }
    })
    ws.on('close', () => onConnGone(c))
    ws.on('error', () => onConnGone(c))
  }

  const ack = (c: Conn, frame: any, fields: any = {}): void =>
    send(c, { t: 'ack', re: frame.id, ...fields })

  function onHello(c: Conn, f: any): void {
    if (c.deviceId) throw err('invalid_request', { reason: 'hello_twice' })
    if (
      typeof f.protocol !== 'number' ||
      f.protocol < o.protocol.min ||
      f.protocol > o.protocol.max
    ) {
      closeConn(c, 4001, 'unsupported_protocol')
      return
    }
    let auth: { user: User; device: Device }
    try {
      auth = authFromToken(typeof f.access_token === 'string' ? f.access_token : undefined)
    } catch (e) {
      const code = (e as ApiError).code === 'device_revoked' ? 4403 : 4401
      closeConn(c, code, (e as ApiError).code)
      return
    }
    const { user: u, device: dev } = auth
    if (refused.has(dev.id)) {
      try {
        c.ws.terminate()
      } catch {
        /* */
      }
      onConnGone(c)
      return
    }
    // uma conexão por dispositivo
    const old = connOf(dev.id)
    if (old && old !== c) {
      old.superseded = true
      closeConn(old, 4409, 'superseded')
    }
    if (c.helloTimer) clearTimeout(c.helloTimer)
    c.deviceId = dev.id
    c.userId = u.id
    if (o.liveChats && Array.isArray(f.caps) && f.caps.includes('live_chats'))
      c.caps.add('live_chats')
    const liveBack = (dev.inGrace || dev.wentOffline) && liveOf(u, dev.id).length > 0
    for (const id of Array.isArray(f.subscriptions) ? f.subscriptions : [])
      if (typeof id === 'string') c.subscriptions.add(id)
    // backend real: `host_back` ao voltar da tolerância OU de offline (entrar na tolerância não tem evento)
    const wasOffline = dev.wentOffline || dev.inGrace
    if (dev.graceTimer) clearTimeout(dev.graceTimer)
    dev.graceTimer = undefined
    dev.inGrace = false
    dev.wentOffline = false
    // janelas ativas
    const active = new Map<string, number>()
    for (const w of Array.isArray(f.active_windows) ? f.active_windows : [])
      if (w && typeof w.chat_id === 'string') active.set(w.chat_id, Number(w.epoch))
    const resumed: string[] = []
    const lost: string[] = []
    const touched = new Set<ChatSt>()
    for (const st of u.chats.values()) {
      const mine = st.window?.device_id === dev.id
      if (active.has(st.chat_id)) {
        const ok = st.host_device_id === dev.id && mine && active.get(st.chat_id) === st.epoch
        if (ok) resumed.push(st.chat_id)
        else {
          lost.push(st.chat_id)
          if (mine) {
            st.window = null
            touched.add(st)
          }
        }
      } else if (mine) {
        st.window = null
        touched.add(st)
      }
    }
    for (const chatId of active.keys())
      if (!u.chats.has(chatId) && !lost.includes(chatId)) lost.push(chatId)
    const cursor = Number(f.state_cursor ?? 0) || 0
    // estados que mudaram por causa desta volta (antes do welcome, para irem nele)
    for (const st of u.chats.values()) {
      if (st.host_device_id !== dev.id) continue
      touched.delete(st)
      emitState(u, st, wasOffline ? { kind: 'host_back', device_id: dev.id } : undefined)
    }
    for (const st of touched) emitState(u, st)
    send(c, {
      t: 'welcome',
      re: f.id,
      protocol: o.protocol.max,
      user_id: u.id,
      device_id: dev.id,
      head: u.seq,
      server_time: nowIso(),
      chat_states: [...u.chats.values()].filter((s) => s.ssq > cursor).map(toChatState),
      state_cursor: u.ssq,
      resumed_windows: resumed,
      lost_windows: lost,
      keys_rev: u.keys?.keys_rev ?? 0,
      caps: [...c.caps]
    })
    if (liveBack)
      for (const o2 of liveConns(u.id, dev.id))
        send(o2, { t: 'live.host', host_device_id: dev.id, status: 'online' })
    // host.revoked guardados
    for (const r of dev.pendingRevoked.splice(0)) send(c, { t: 'host.revoked', ...r })
    // pedido de troca pendente (o host voltou da tolerância)
    for (const st of u.chats.values()) {
      if (st.host_device_id === dev.id && st.handover) {
        const to = devices.get(st.handover.to_device_id)
        send(c, {
          t: 'host.handover_request',
          chat_id: st.chat_id,
          epoch: st.epoch,
          to_device_id: st.handover.to_device_id,
          to_name: to?.name ?? '',
          mode: st.handover.mode
        })
      }
    }
    // inscrições → snapshot dos hosts
    for (const chatId of c.subscriptions) requestSnapshot(u, chatId, dev.id)
  }

  function requestSnapshot(u: User, chatId: string, requester: string): void {
    const b = u.live.get(chatId)
    if (b) {
      if (b.host_device_id !== requester)
        sendDevice(b.host_device_id, {
          t: 'stream.resync_request',
          chat_id: chatId,
          requester_device_id: requester
        })
      return
    }
    const st = u.chats.get(chatId)
    if (!st?.host_device_id || st.host_device_id === requester) return
    sendDevice(st.host_device_id, {
      t: 'stream.resync_request',
      chat_id: chatId,
      requester_device_id: requester
    })
  }

  function onFrame(c: Conn, f: any): void {
    if (!f || typeof f !== 'object' || typeof f.t !== 'string') {
      closeConn(c, 4000, 'protocol_error')
      return
    }
    if (f.t === 'hello') return onHello(c, f)
    if (!c.deviceId || !c.userId) {
      closeConn(c, 4000, 'protocol_error')
      return
    }
    const u = users.get(c.userId)
    const dev = devices.get(c.deviceId)
    if (!u || !dev || dev.revoked) {
      closeConn(c, 4403, 'forbidden')
      return
    }
    dev.last_seen_at = nowIso()
    const chatId = typeof f.chat_id === 'string' ? f.chat_id : ''
    switch (f.t) {
      case 'ping':
        send(c, { t: 'pong', ...(f.id != null ? { re: f.id } : {}), ts: f.ts ?? Date.now() })
        return
      case 'sync.pull':
        return ack(
          c,
          f,
          changesSince(
            u,
            Number(f.since ?? 0),
            Number(f.limit ?? 500),
            f.payload !== 0 && f.payload !== false
          )
        )
      case 'sync.fetch': {
        const items = Array.isArray(f.items) ? f.items : []
        const out: any[] = []
        for (const it of items) {
          const r = u.records.get(recKey(String(it?.type), String(it?.id)))
          if (r) out.push(toChange(r))
        }
        return ack(c, f, { records: out })
      }
      case 'sync.push': {
        const body = { ...f }
        delete body.t
        delete body.id
        return ack(c, f, doPush(u, dev, body))
      }
      case 'host.begin': {
        if (!chatId) throw err('invalid_request', { field: 'chat_id' })
        if (u.live.has(chatId)) throw err('live_conflict', { chat_id: chatId, reason: 'live' })
        const st = chatOf(u, chatId)!
        if (st.diverged)
          throw err('chat_diverged', { chat_id: chatId, diverged: toChatState(st).diverged })
        const purpose = ['run', 'edit', 'replay'].includes(f.purpose) ? f.purpose : 'run'
        let became = false
        if (!st.host_device_id) {
          if (!dev.can_host) throw err('cannot_host', { chat_id: chatId })
          st.host_device_id = dev.id
          st.epoch++
          became = true
        } else if (st.host_device_id !== dev.id) {
          throw err('not_host', { chat_id: chatId, state: toChatState(st) })
        } else if (f.epoch != null && f.epoch !== st.epoch) {
          throw err('not_host', { chat_id: chatId, state: toChatState(st) })
        }
        if (st.handover && !became)
          throw err('handover_pending', { chat_id: chatId, state: toChatState(st) })
        const opened = !st.window
        if (!st.window) st.window = { purpose, since: nowIso(), device_id: dev.id }
        if (became) emitState(u, st, { kind: 'host_changed', device_id: dev.id, reason: 'begin' })
        if (opened) emitState(u, st, { kind: 'turn_started', device_id: dev.id })
        return ack(c, f, { epoch: st.epoch, head: st.head, became_host: became })
      }
      case 'host.end': {
        const st = u.chats.get(chatId)
        if (!st || st.host_device_id !== dev.id || f.epoch !== st.epoch)
          throw err('not_host', { chat_id: chatId, state: st ? toChatState(st) : null })
        if (st.window) {
          st.window = null
          emitState(u, st, { kind: 'turn_ended', device_id: dev.id })
        }
        return ack(c, f, { handover_pending: !!st.handover })
      }
      case 'host.takeover': {
        if (!chatId) throw err('invalid_request', { field: 'chat_id' })
        if (u.live.has(chatId)) throw err('live_conflict', { chat_id: chatId, reason: 'live' })
        const mode: 'next_turn' | 'force' = f.mode === 'force' ? 'force' : 'next_turn'
        if (!dev.can_host) throw err('cannot_host', { chat_id: chatId })
        const st = chatOf(u, chatId)!
        if (st.diverged)
          throw err('chat_diverged', { chat_id: chatId, diverged: toChatState(st).diverged })
        if (st.host_device_id === dev.id)
          return ack(c, f, { status: 'granted', epoch: st.epoch, head: st.head })
        if (st.pinned && f.confirm_pinned !== true) throw err('host_pinned', { chat_id: chatId })
        if (st.handover && st.handover.to_device_id !== dev.id)
          throw err('handover_pending', { chat_id: chatId, state: toChatState(st) })
        const status = st.host_device_id ? devStatus(st.host_device_id) : 'offline'
        if (!st.host_device_id || status === 'offline') {
          grant(u, st, dev.id, 'takeover')
          return ack(c, f, { status: 'granted', epoch: st.epoch, head: st.head })
        }
        const prevMode = st.handover?.mode
        if (st.handover) {
          if (mode === 'force') st.handover.mode = 'force'
        } else {
          st.handover = { to_device_id: dev.id, mode, requested_at: nowIso() }
        }
        const h = st.handover
        if (h.mode === 'force' && !h.timer && status === 'online') {
          h.timer = setTimeout(() => {
            if (st.handover === h && u.chats.get(chatId) === st) grant(u, st, dev.id, 'takeover')
          }, o.handoverForceTimeoutMs)
        }
        if (status === 'online' && prevMode !== h.mode) {
          sendDevice(st.host_device_id, {
            t: 'host.handover_request',
            chat_id: chatId,
            epoch: st.epoch,
            to_device_id: dev.id,
            to_name: dev.name,
            mode: h.mode
          })
        }
        ack(c, f, { status: 'pending' })
        if (prevMode !== h.mode)
          emitState(u, st, { kind: 'handover_requested', device_id: dev.id, reason: h.mode })
        return
      }
      case 'host.handover_cancel': {
        const st = u.chats.get(chatId)
        if (!st?.handover) return ack(c, f, {})
        if (st.handover.to_device_id !== dev.id && st.host_device_id !== dev.id)
          throw err('forbidden', { chat_id: chatId })
        clearHandover(st)
        ack(c, f, {})
        emitState(u, st, { kind: 'handover_cancelled', device_id: dev.id })
        return
      }
      case 'host.release': {
        const st = u.chats.get(chatId)
        if (!st || st.host_device_id !== dev.id || f.epoch !== st.epoch)
          throw err('not_host', { chat_id: chatId, state: st ? toChatState(st) : null })
        const forwarded = Array.isArray(f.forwarded) ? f.forwarded : []
        ack(c, f, {})
        if (st.handover) grant(u, st, st.handover.to_device_id, 'handover', forwarded)
        else {
          st.host_device_id = null
          st.epoch++
          st.window = null
          emitState(u, st, { kind: 'host_changed', device_id: dev.id, reason: 'released' })
        }
        return
      }
      case 'host.pin': {
        if (u.live.has(chatId)) throw err('live_conflict', { chat_id: chatId, reason: 'live' })
        const st = chatOf(u, chatId)!
        st.pinned = !!f.pinned
        emitState(u, st, { kind: st.pinned ? 'pinned' : 'unpinned', device_id: dev.id })
        return ack(c, f, { ssq: st.ssq })
      }
      case 'remote.send': {
        if (typeof f.cmd_id !== 'string' || !f.cmd_id || !COMMAND_KINDS.has(f.kind))
          throw err('invalid_request', { reason: 'command' })
        if (!validEnvelope(f.env)) throw err('invalid_request', { reason: 'envelope' })
        if (JSON.stringify(f.env).length > COMMAND_MAX) throw err('payload_too_large')
        const lb = u.live.get(chatId)
        if (lb) {
          if (lb.host_device_id === dev.id) throw err('invalid_request', { reason: 'self_host' })
          if (devStatus(lb.host_device_id) !== 'online')
            throw err('host_offline', { chat_id: chatId })
          relayCommand(
            u,
            { chat_id: chatId } as ChatSt,
            dev.id,
            lb.host_device_id,
            f.cmd_id,
            f.kind,
            f.env
          )
          return ack(c, f, { status: 'delivered' })
        }
        if (LIVE_ONLY_KINDS.has(f.kind)) throw err('invalid_request', { reason: 'not_live' })
        const st = u.chats.get(chatId)
        if (st?.diverged)
          throw err('chat_diverged', { chat_id: chatId, diverged: toChatState(st).diverged })
        if (!st?.host_device_id) throw err('no_host', { chat_id: chatId })
        if (st.host_device_id === dev.id) throw err('invalid_request', { reason: 'self_host' })
        if (devStatus(st.host_device_id) !== 'online')
          throw err('host_offline', { chat_id: chatId })
        relayCommand(u, st, dev.id, st.host_device_id, f.cmd_id, f.kind, f.env)
        return ack(c, f, { status: 'delivered' })
      }
      case 'remote.result': {
        // mesmo teto do remote.send (COMMAND_MAX_BYTES do servidor real vale para o resultado)
        if (JSON.stringify(f.env).length > COMMAND_MAX) throw err('payload_too_large')
        const key = `${u.id}|${f.cmd_id}`
        const p = pendingCmds.get(key)
        if (p && p.hostDeviceId === dev.id) {
          clearTimeout(p.timer)
          pendingCmds.delete(key)
          sendDevice(p.fromDeviceId, {
            t: 'remote.result',
            chat_id: p.chat_id,
            cmd_id: p.cmd_id,
            env: f.env
          })
        }
        return ack(c, f, {})
      }
      case 'stream.subscribe':
      case 'stream.unsubscribe': {
        const ids = Array.isArray(f.chat_ids)
          ? f.chat_ids.filter((x: unknown) => typeof x === 'string')
          : []
        for (const id of ids) {
          if (f.t === 'stream.subscribe') {
            const isNew = !c.subscriptions.has(id)
            c.subscriptions.add(id)
            if (isNew) requestSnapshot(u, id, dev.id)
          } else c.subscriptions.delete(id)
        }
        return ack(c, f, {})
      }
      case 'stream.resync': {
        requestSnapshot(u, chatId, dev.id)
        return ack(c, f, {})
      }
      case 'stream.event': {
        const lb = u.live.get(chatId)
        const st = u.chats.get(chatId)
        if (lb) {
          if (lb.host_device_id !== dev.id || f.epoch !== lb.epoch) return
        } else if (!st || st.host_device_id !== dev.id || f.epoch !== st.epoch) return
        if (!validEnvelope(f.env) || JSON.stringify(f.env).length > STREAM_MAX) return
        for (const o2 of userConns(u.id)) {
          if (o2 === c || !o2.subscriptions.has(chatId)) continue
          send(o2, {
            t: 'stream.event',
            chat_id: chatId,
            epoch: f.epoch,
            n: f.n,
            env: f.env,
            device_id: dev.id
          })
        }
        return
      }
      case 'live.announce':
      case 'live.withdraw':
      case 'live.list':
      case 'live.refresh': {
        if (!c.caps.has('live_chats')) throw err('invalid_request', { reason: 'caps_required' })
        if (f.t === 'live.announce') return ack(c, f, liveAnnounce(c, u, dev, f))
        if (f.t === 'live.withdraw') {
          const reason =
            f.reason === 'deleted' ? 'deleted' : f.reason === 'quit' ? 'host_quit' : 'withdrawn'
          const ids = Array.isArray(f.chat_ids)
            ? f.chat_ids.filter((x: unknown) => typeof x === 'string')
            : liveOf(u, dev.id)
          liveRemove(u, dev.id, ids, reason)
          return ack(c, f, {})
        }
        if (f.t === 'live.list')
          return ack(c, f, {
            chats: [...u.live.values()].filter((b) => b.host_device_id !== dev.id).map(toLiveChat),
            settling_s: 0
          })
        const target = typeof f.host_device_id === 'string' ? f.host_device_id : null
        const hosts = new Set([...u.live.values()].map((b) => b.host_device_id))
        for (const h of hosts)
          if (!target || h === target)
            sendDevice(h, { t: 'live.refresh_request', requester_device_id: dev.id })
        return ack(c, f, {})
      }
      default:
        throw err('invalid_request', { reason: 'unknown_frame', t: f.t })
    }
  }

  // conexão morta: sem frames por idleTimeoutMs
  const idleTimer = setInterval(
    () => {
      const now = Date.now()
      for (const c of [...conns]) {
        if (now - c.lastFrameAt <= o.idleTimeoutMs) continue
        try {
          c.ws.terminate()
        } catch {
          /* */
        }
        onConnGone(c)
      }
    },
    Math.min(1000, Math.max(50, Math.floor(o.idleTimeoutMs / 4)))
  )

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${o.basePath}`
  o.log(`[fake-sync] ouvindo em ${url}`)

  // ---------------- API de teste ----------------

  const api: FakeSyncServer = {
    get url() {
      return url
    },
    requests,
    wsLog,
    async close() {
      clearInterval(idleTimer)
      for (const d of devices.values()) if (d.graceTimer) clearTimeout(d.graceTimer)
      for (const u of users.values()) for (const st of u.chats.values()) clearHandover(st)
      for (const p of pendingCmds.values()) clearTimeout(p.timer)
      pendingCmds.clear()
      for (const c of [...conns]) {
        c.superseded = true
        try {
          c.ws.terminate()
        } catch {
          /* */
        }
        onConnGone(c)
      }
      wss.close()
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
    },
    lastCode: (email) => lastCodes.get(normEmail(email)),
    async createAccount(input) {
      const email = normEmail(input.email)
      if (usersByEmail.has(email)) throw new Error(`conta já existe: ${email}`)
      const u = newUser(email, input.name ?? email.split('@')[0])
      const kdf = input.kdf ?? DEFAULT_TEST_KDF
      const dek = new Uint8Array(randomBytes(32))
      const saltPw = new Uint8Array(randomBytes(16))
      const saltRk = new Uint8Array(randomBytes(16))
      const entropy = new Uint8Array(randomBytes(20))
      const allowTest = kdf.m < ARGON2_BOUNDS.mMin || kdf.t < ARGON2_BOUNDS.tMin
      const kekPw = await passwordKek(input.password, saltPw, kdf, allowTest)
      const kekRk = recoveryKek(entropy, saltRk)
      const wrapPw = wrapDek(kekPw, dek, aadWrap(u.id, 'password'), new Uint8Array(randomBytes(12)))
      const wrapRk = wrapDek(kekRk, dek, aadWrap(u.id, 'recovery'), new Uint8Array(randomBytes(12)))
      u.keys = {
        key_version: 1,
        keys_rev: 1,
        password: { kdf, salt: b64u(saltPw), wrap: wrapPw },
        recovery: { kdf: { alg: 'hkdf-sha256' }, salt: b64u(saltRk), wrap: wrapRk },
        verifier: keyProof(deriveSubkeys(dek)).verifier
      }
      return { userId: u.id, recoveryKey: formatRecoveryKey(entropy), dek }
    },
    createUser(input) {
      const email = normEmail(input.email)
      if (usersByEmail.has(email)) throw new Error(`conta já existe: ${email}`)
      return { userId: newUser(email, input.name ?? email.split('@')[0]).id }
    },
    userIdOf: (email) => usersByEmail.get(normEmail(email)),
    pushes,
    setPushToken(deviceId, token) {
      const d = devices.get(deviceId)
      if (d) d.pushToken = token
    },
    dropDevice(deviceId) {
      const c = connOf(deviceId)
      if (!c) return
      try {
        c.ws.terminate()
      } catch {
        /* */
      }
      onConnGone(c)
    },
    closeDevice(deviceId, code, reason) {
      const c = connOf(deviceId)
      if (c) closeConn(c, code, reason)
    },
    setRefuseConnections(deviceId, refuse) {
      if (refuse) refused.add(deviceId)
      else refused.delete(deviceId)
    },
    setTombstoneFloor(userId, seq) {
      const u = users.get(userId)
      if (u) u.tombstoneFloor = seq
    },
    chatState(userId, chatId) {
      const st = users.get(userId)?.chats.get(chatId)
      return st ? toChatState(st) : null
    },
    records(userId) {
      const u = users.get(userId)
      return u ? [...u.records.values()].sort((a, b) => a.seq - b.seq).map((r) => toChange(r)) : []
    },
    devices(userId) {
      return [...devices.values()]
        .filter((d) => d.userId === userId)
        .map((d) => ({
          id: d.id,
          name: d.name,
          platform: d.platform,
          client: d.client,
          can_host: d.can_host,
          revoked: d.revoked,
          status: devStatus(d.id)
        }))
    },
    connections(userId) {
      return userConns(userId).map((c) => ({
        deviceId: c.deviceId ?? '',
        subscriptions: [...c.subscriptions]
      }))
    },
    liveBindings(userId) {
      const u = users.get(userId)
      return u
        ? [...u.live.values()].map((b) => ({
            chat_id: b.chat_id,
            host_device_id: b.host_device_id,
            epoch: b.epoch,
            arev: b.arev,
            running: b.running
          }))
        : []
    }
  }
  return api
}
