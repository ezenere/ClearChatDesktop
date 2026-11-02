// Motor do sync (cliente de docs/SYNC_PROTOCOL.md): conta/chaves, pull/push de registros, merge do
// primeiro login, divergência, anexos (blobs) e skills. O host de execução, comandos remotos e o
// streaming ao vivo ficam em host.ts. Sem Electron: dependências injetadas (SyncDeps) — o app liga
// em sync/index.ts; os testes usam banco temporário + servidor falso (e2e/fakes/syncServer.ts).
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, MessageMeta, Session, StoredMessage } from '@shared/types'
import {
  OFFICIAL_SYNC_URL,
  type ChatHostInfo,
  type CloudSkill,
  type DivergenceDetails,
  type DivergenceVersion,
  type SyncConnection,
  type SyncDevice,
  type SyncMergeInfo,
  type SyncPhase,
  type SyncPrompt,
  type SyncScope,
  type SyncServerInfo,
  type SyncServerKind,
  type SyncStatus,
  type TakeoverOptions
} from '@shared/sync'
import { ATTACHMENT_FILE_RE } from '@shared/attachments'
import { removeChatToolOutputs } from '../tools/toolOutputs'
import { ROOT_KEY, type BranchSel } from '@shared/branches'
import { compareVersions, parseVersion } from '@shared/updates'
import {
  aadRecord,
  aadWrap,
  ARGON2_DEFAULT,
  b64u,
  blobIdFromSha256,
  checkKdfParams,
  decryptBlob,
  deriveSubkeys,
  encryptBlob,
  fromB64u,
  fromHex,
  hex,
  keyProof,
  newPasswordWrap,
  newRecoveryWrap,
  openJson,
  parseRecoveryKey,
  passwordKek,
  recoveryKek,
  sealJson,
  sha256,
  skillRecordId,
  UnsupportedEnvelopeError,
  unwrapDek,
  type Envelope,
  type KdfParams,
  type Subkeys,
  type Wrap
} from './crypto'
import {
  fetchServerInfo,
  normalizeBaseUrl,
  protocolMismatch,
  SyncApiError,
  SyncHttp,
  SyncNetworkError,
  type Tokens
} from './http'
import { RealtimeClient, type WsState, DEFAULT_TIMING } from './ws'
import { ensureSyncSchema, setTracking, wipeSyncState, withApply } from './schema'
import {
  applyRemote,
  attachmentFiles,
  branchSelFromColumn,
  buildLocal,
  canonical,
  deleteLocal,
  existsLocal,
  FIELD_LWW,
  isContent,
  isRecordType,
  listLocalIds,
  merge3,
  messageFromPlain,
  normalizeNegativeSeqs,
  parentIdFromColumn,
  parentIdToColumn,
  rowMessage,
  sameJson,
  sameRecordPlain,
  sessionFromPlain,
  SETTINGS_BACKFILL,
  type ApplyResult,
  type LocalRecord,
  type Plain,
  type RecordType
} from './records'
import { HostController, type RunnerAdapter } from './host'
import { buildBundle, extractBundle, folderContentHash, parseBundle } from './skillsBundle'
import { attachmentsDir, saveStoreFile } from '../attachments'

// ---------------- tipos ----------------

export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string | null): void
  /** O chaveiro do SO está disponível (senão a DEK fica só em memória). */
  available(): boolean
}

export interface SkillsAdapter {
  /** Skills locais efetivas (nome → pasta). */
  list(): Promise<{ name: string; description: string; dir: string; meta?: unknown }[]>
  /** Pasta das skills baixadas (`<userData>/synced-skills`). */
  syncedDir: string
  changed(): void
}

export interface SyncDeps {
  conn: Database.Database
  emit: (e: AgentEvent) => void
  onAgentEvent: (fn: (e: AgentEvent) => void) => () => void
  secrets: SecretStore
  appVersion: string
  deviceName: string
  platform: string
  runner: RunnerAdapter | null
  skills?: SkillsAdapter
  captcha?: (base: string, action: 'login' | 'signup') => Promise<string>
  openExternal?: (url: string) => void
  /** CLEARCHAT_SYNC_URL (sobrepõe o servidor escolhido). */
  envUrl?: string | null
  timing?: {
    ws?: Partial<typeof DEFAULT_TIMING>
    pollMs?: number
    pushDebounceMs?: number
    retryMs?: number
  }
  log?: (...a: unknown[]) => void
}

export interface Change {
  seq: number
  type: string
  id: string
  scope: string | null
  rev: number
  deleted: boolean
  env?: Envelope
  omitted?: true
  size?: number
  blobs?: string[]
  device_id?: string
  updated_at?: string
}

interface PushItem {
  type: string
  id: string
  scope: string | null
  base_rev: number
  rev: number
  deleted: boolean
  env?: Envelope
  blobs: string[]
}

interface PushBody {
  push_id: string
  items: PushItem[]
  chat_bases?: Record<string, number>
  host_epochs?: Record<string, number>
}

interface ItemMeta {
  type: string
  id: string
  scope: string | null
  rev: number
  mark: number
  deleted: boolean
  plain: Plain | null
}

interface RecordRow {
  type: string
  id: string
  scope: string | null
  rev: number
  seq: number
  deleted: number
  base: string | null
  opaque: string | null
}

interface KeysResponse {
  key_version: number
  keys_rev: number
  password: { kdf: KdfParams; salt: string; wrap: Wrap }
  recovery: { kdf: { alg: string }; salt: string; wrap: Wrap }
}

interface DownloadedRecord {
  change: Change
  plain: Plain | null
}

interface OnlineSnapshot {
  records: Map<string, DownloadedRecord>
  head: number
  states: Record<string, unknown>[]
  stateCursor: number
}

const key = (type: string, id: string): string => `${type}|${id}`
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const normName = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
const normBase = (u: unknown): string => {
  const s = String(u ?? '').trim()
  try {
    const x = new URL(s)
    return `${x.protocol.toLowerCase()}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}${x.search}`
  } catch {
    return s.replace(/\/+$/, '').toLowerCase()
  }
}

const CONTENT_ORDER = (a: PushItem, b: PushItem): number => {
  const rank = (i: PushItem): number =>
    i.type === 'message' && i.deleted
      ? 0
      : i.type === 'session' && !i.deleted
        ? 1
        : i.type === 'message'
          ? 2
          : 3
  return rank(a) - rank(b)
}

/** branchSel com os ids de mensagem trocados (cópia de chat); entradas de fora da cópia saem. */
function remapBranchSel(sel: BranchSel, msgMap: Map<string, string>): BranchSel {
  const out: BranchSel = {}
  for (const [k, v] of Object.entries(sel)) {
    const nk = k === ROOT_KEY ? k : msgMap.get(k)
    if (!nk) continue
    if (v === null) out[nk] = null
    else {
      const nv = msgMap.get(v)
      if (nv) out[nk] = nv
    }
  }
  return out
}

/** meta_json com `subSessionId` (delegate_task) apontando para a sessão copiada. */
function remapSubSession(metaJson: string, idMap: Map<string, string>): string {
  try {
    const meta = JSON.parse(metaJson) as MessageMeta
    const sub = meta?.subSessionId ? idMap.get(meta.subSessionId) : undefined
    return sub ? JSON.stringify({ ...meta, subSessionId: sub }) : metaJson
  } catch {
    return metaJson
  }
}

/** Primeira versão do app que conhece versões de mensagens (ramos) — protocolo 1.2.0. */
export const BRANCHING_MIN_VERSION = '0.7.0'

/**
 * Aparelhos que podem hospedar chats (desktop com can_host, fora este) numa versão do app anterior
 * aos ramos (§4.3.8: como host, o regenerar antigo apaga as outras versões). Versão ilegível não
 * conta (sem falso alarme).
 */
export function outdatedHosts(devices: SyncDevice[]): { name: string; appVersion: string }[] {
  return devices
    .filter(
      (d) =>
        !d.current &&
        d.canHost &&
        d.client === 'desktop' &&
        parseVersion(d.appVersion) !== null &&
        compareVersions(d.appVersion, BRANCHING_MIN_VERSION) < 0
    )
    .map((d) => ({ name: d.name, appVersion: d.appVersion }))
}

/** Releitura da lista de aparelhos (aviso de host desatualizado): no máx. 1×/min; periódica a cada 15 min. */
const DEVICES_MIN_MS = 60_000
const DEVICES_EVERY_MS = 15 * 60_000

const MAX_ITEMS = 500
const MAX_BATCH_BYTES = 6 * 1024 * 1024

// ---------------- engine ----------------

export class SyncEngine {
  readonly conn: Database.Database
  readonly http: SyncHttp
  readonly ws: RealtimeClient
  readonly host: HostController
  sk: Subkeys | null = null
  private dek: Uint8Array | null = null
  private tokens: Tokens | null = null
  private info: SyncServerInfo | null = null
  connection: SyncConnection = 'disabled'
  private error: string | null = null
  private quota: string | null = null
  private protocolError: string | null = null
  private mergeInfo: SyncMergeInfo | null = null
  private mergeSnapshot: OnlineSnapshot | null = null
  private prompts: SyncPrompt[] = []
  private cycle: Promise<void> | null = null
  private cycleAgain = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = 0
  private dirtySig = ''
  private inflight = new Set<string>()
  private started = false
  private destroyed = false
  private skillsBusy: Promise<void> | null = null
  private outdated: { name: string; appVersion: string }[] = []
  private devicesAt = 0
  private devicesTimer: ReturnType<typeof setInterval> | null = null

  readonly deps: SyncDeps

  constructor(deps: SyncDeps) {
    this.deps = deps
    this.conn = deps.conn
    ensureSyncSchema(this.conn)
    this.http = new SyncHttp({
      base: () => this.baseUrl(),
      tokens: {
        get: () => this.tokens,
        set: (t) => this.saveTokens(t)
      },
      appVersion: deps.appVersion,
      onSignedOut: (code) => void this.onSignedOut(code)
    })
    this.ws = new RealtimeClient({
      url: () => this.baseUrl().replace(/^http/, 'ws') + '/ws',
      hello: async () => {
        await this.http.ensureFresh()
        return {
          access_token: this.tokens?.access_token ?? '',
          cursor: this.cursor(),
          state_cursor: Number(this.kv('state_cursor') ?? 0),
          active_windows: this.host.activeWindows(),
          subscriptions: this.host.subscriptions()
        }
      },
      onWelcome: (w) => this.onWelcome(w),
      onEvent: (f) => this.onWsEvent(f),
      onState: (s, info) => this.onWsState(s, info),
      onUnauthorized: async () => {
        try {
          return await this.http.refresh()
        } catch {
          return false
        }
      },
      onFatal: (code, reason) => void this.onWsFatal(code, reason),
      timing: deps.timing?.ws
    })
    this.host = new HostController(this)
    this.tokens = this.loadTokens()
  }

  log(...a: unknown[]): void {
    ;(this.deps.log ?? ((...x: unknown[]) => console.log('[clearchat:sync]', ...x)))(...a)
  }

  // ---------------- kv / estado ----------------

  kv(k: string): string | null {
    const r = this.conn.prepare('SELECT value FROM sync_state WHERE key = ?').get(k) as
      { value: string | null } | undefined
    return r?.value ?? null
  }

  setKv(k: string, v: string | number | null): void {
    if (v === null) this.conn.prepare('DELETE FROM sync_state WHERE key = ?').run(k)
    else
      this.conn
        .prepare(
          'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        )
        .run(k, String(v))
  }

  cursor(): number {
    return Number(this.kv('cursor') ?? 0)
  }

  get userId(): string {
    return this.kv('user_id') ?? ''
  }

  get deviceId(): string {
    return this.kv('device_id') ?? ''
  }

  get deviceName(): string {
    return this.kv('device_name') ?? this.deps.deviceName
  }

  serverKind(): SyncServerKind {
    return (this.kv('server_kind') as SyncServerKind) || 'official'
  }

  baseUrl(): string {
    if (this.deps.envUrl) return normalizeBaseUrl(this.deps.envUrl)
    if (this.serverKind() === 'self' && this.kv('server_url')) return this.kv('server_url')!
    return OFFICIAL_SYNC_URL
  }

  private loadTokens(): Tokens | null {
    try {
      const raw = this.deps.secrets.get('tokens')
      return raw ? (JSON.parse(raw) as Tokens) : null
    } catch {
      return null
    }
  }

  private saveTokens(t: Tokens | null): void {
    this.tokens = t
    this.deps.secrets.set('tokens', t ? JSON.stringify(t) : null)
  }

  private storedKeys(): KeysResponse | null {
    try {
      const raw = this.kv('keys')
      return raw ? (JSON.parse(raw) as KeysResponse) : null
    } catch {
      return null
    }
  }

  get unlocked(): boolean {
    return !!this.sk
  }

  /** Conta pronta e desbloqueada (sincronizando ou tentando). */
  get active(): boolean {
    return this.phase() === 'ready'
  }

  phase(): SyncPhase {
    if (!this.tokens || !this.userId) return 'signed-out'
    if (!this.storedKeys()) return 'keys-not-ready'
    if (!this.sk) return 'locked'
    if (this.kv('merge_done') !== '1') return 'merge'
    return 'ready'
  }

  pendingCount(): number {
    return (this.conn.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get() as { n: number }).n
  }

  status(): SyncStatus {
    const phase = this.phase()
    return {
      phase,
      server: {
        kind: this.serverKind(),
        url: this.baseUrl(),
        name: this.info?.name ?? this.kv('server_name'),
        envOverride: !!this.deps.envUrl
      },
      account: this.userId
        ? {
            userId: this.userId,
            email: this.kv('email') ?? '',
            name: this.kv('account_name') ?? ''
          }
        : null,
      device: this.deviceId ? { id: this.deviceId, name: this.deviceName } : null,
      connection: phase === 'signed-out' ? 'disabled' : this.connection,
      lastSyncAt: this.kv('last_sync_at') ? Number(this.kv('last_sync_at')) : null,
      pending: phase === 'signed-out' ? 0 : this.pendingCount(),
      error: this.error,
      quota: this.quota,
      remember: this.kv('remember') !== '0',
      merge: phase === 'merge' ? this.mergeInfo : null,
      prompts: [...this.prompts],
      protocolError: this.protocolError,
      outdatedHosts: phase === 'signed-out' ? [] : this.outdated.map((d) => ({ ...d }))
    }
  }

  private statusTimer: ReturnType<typeof setTimeout> | null = null
  emitStatus(): void {
    if (this.statusTimer || this.destroyed) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      if (!this.destroyed) this.deps.emit({ type: 'sync-status', status: this.status() })
    }, 30)
  }

  emit(e: AgentEvent): void {
    if (!this.destroyed) this.deps.emit(e)
  }

  // ---------------- ciclo de vida ----------------

  /** Inicialização do app: retoma a sessão salva (DEK lembrada → sincroniza). */
  async init(): Promise<void> {
    if (this.tokens && this.userId) {
      const dek = this.kv('remember') !== '0' ? this.deps.secrets.get('dek') : null
      if (dek) {
        try {
          this.setDek(fromB64u(dek), true)
        } catch (e) {
          this.log('DEK guardada inválida', errMsg(e))
          this.deps.secrets.set('dek', null)
        }
      }
      if (this.kv('merge_done') === '1') setTracking(this.conn, true)
      if (this.sk) {
        if (this.kv('merge_done') === '1') this.start()
        else void this.enterMerge().catch((e) => this.setError(errMsg(e)))
      } else {
        this.connection = 'offline'
      }
    }
    this.emitStatus()
  }

  /** Liga o sync (pull/push + WebSocket). */
  start(): void {
    if (this.started || this.destroyed) return
    if (this.phase() !== 'ready') return
    this.started = true
    setTracking(this.conn, true)
    this.connection = 'connecting'
    this.host.start()
    void this.checkServer()
    this.ws.start()
    const poll = this.deps.timing?.pollMs ?? 400
    this.pollTimer = setInterval(() => this.pollDirty(), poll)
    this.devicesTimer = setInterval(() => void this.refreshDevices(), DEVICES_EVERY_MS)
    this.scheduleCycle(0)
    this.emitStatus()
  }

  /** Para o sync (logout, bloqueio). Não apaga nada. */
  stop(): void {
    this.started = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.pushTimer) clearTimeout(this.pushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.devicesTimer) clearInterval(this.devicesTimer)
    this.pollTimer = this.pushTimer = this.retryTimer = this.devicesTimer = null
    this.ws.stop()
    this.host.stop()
  }

  destroy(): void {
    this.destroyed = true
    this.stop()
  }

  private async checkServer(): Promise<void> {
    try {
      const info = await fetchServerInfo(this.baseUrl())
      this.info = info
      this.setKv('server_name', info.name)
      this.protocolError = protocolMismatch(info)
      if (this.protocolError) {
        this.ws.stop()
        this.connection = 'error'
      }
      this.emitStatus()
    } catch {
      /* offline: o ciclo trata */
    }
  }

  // ---------------- servidor / conta ----------------

  async probeServer(url?: string): Promise<SyncServerInfo> {
    const base = url ? normalizeBaseUrl(url) : this.baseUrl()
    const info = await fetchServerInfo(base)
    const mismatch = protocolMismatch(info)
    if (mismatch) throw new Error(mismatch)
    if (!url || base === this.baseUrl()) this.info = info
    return info
  }

  async setServer(kind: SyncServerKind, url?: string): Promise<SyncStatus> {
    if (this.phase() !== 'signed-out')
      throw new Error('Saia da conta antes de trocar de servidor (os dados locais ficam).')
    if (kind === 'self') {
      const base = normalizeBaseUrl(url ?? '')
      const info = await this.probeServer(base)
      this.setKv('server_kind', 'self')
      this.setKv('server_url', base)
      this.setKv('server_name', info.name)
      this.info = info
    } else {
      this.setKv('server_kind', 'official')
      this.setKv('server_url', null)
      this.info = null
      this.setKv('server_name', null)
    }
    this.emitStatus()
    return this.status()
  }

  async requestCode(email: string): Promise<void> {
    const e = String(email ?? '')
      .trim()
      .toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('E-mail inválido.')
    const info = await this.probeServer()
    let token: string | undefined
    if (info.captcha) {
      if (!this.deps.captcha) throw new Error('Este servidor exige captcha.')
      token = await this.deps.captcha(this.baseUrl(), 'login')
    }
    await this.http.post(
      '/api/v1/auth/code/request',
      { email: e, ...(token ? { turnstile_token: token } : {}) },
      false
    )
  }

  async verifyCode(email: string, code: string): Promise<SyncStatus> {
    const e = String(email ?? '')
      .trim()
      .toLowerCase()
    const c = String(code ?? '').replace(/\D/g, '')
    if (c.length !== 6) throw new Error('O código tem 6 dígitos.')
    let r: {
      access_token: string
      access_expires_in: number
      refresh_token: string
      user: { id: string; email: string; name: string }
      device_id: string
      keys_ready: boolean
      keys: KeysResponse | null
    }
    try {
      r = await this.http.post(
        '/api/v1/auth/code/verify',
        {
          email: e,
          code: c,
          device: {
            name: this.deps.deviceName.slice(0, 64),
            platform: this.deps.platform,
            client: 'desktop',
            app_version: this.deps.appVersion,
            can_host: true
          }
        },
        false
      )
    } catch (err) {
      if (err instanceof SyncApiError && err.code === 'code_invalid')
        throw new Error('Código incorreto ou expirado.', { cause: err })
      throw err
    }
    const prevUser = this.kv('last_user_id')
    if (prevUser && prevUser !== r.user.id) wipeSyncState(this.conn)
    this.saveTokens({
      access_token: r.access_token,
      access_expires_at: Date.now() + (r.access_expires_in ?? 3600) * 1000,
      refresh_token: r.refresh_token
    })
    this.setKv('user_id', r.user.id)
    this.setKv('last_user_id', r.user.id)
    this.setKv('email', r.user.email)
    this.setKv('account_name', r.user.name ?? '')
    this.setKv('device_id', r.device_id)
    this.setKv('device_name', this.deps.deviceName.slice(0, 64))
    this.setKv('server_name', this.info?.name ?? null)
    this.setKv('keys', r.keys_ready && r.keys ? JSON.stringify(r.keys) : null)
    if (r.keys) this.setKv('keys_rev', r.keys.keys_rev)
    this.error = null
    this.emitStatus()
    return this.status()
  }

  /** "Já defini a senha" (conta sem chaves): busca as chaves de novo. */
  async refreshKeys(): Promise<SyncStatus> {
    try {
      const k = await this.http.get<KeysResponse>('/api/v1/keys')
      this.setKv('keys', JSON.stringify(k))
      this.setKv('keys_rev', k.keys_rev)
    } catch (e) {
      if (e instanceof SyncApiError && e.code === 'keys_not_ready')
        throw new Error(
          'A conta ainda não tem senha de criptografia. Defina-a no site e tente de novo.',
          { cause: e }
        )
      throw e
    }
    this.emitStatus()
    return this.status()
  }

  private setDek(dek: Uint8Array, remember: boolean): void {
    this.dek = dek
    this.sk = deriveSubkeys(dek)
    this.setKv('remember', remember ? 1 : 0)
    if (remember && this.deps.secrets.available()) this.deps.secrets.set('dek', b64u(dek))
    else this.deps.secrets.set('dek', null)
  }

  async unlock(password: string, remember = true): Promise<SyncStatus> {
    let keys = this.storedKeys()
    try {
      const fresh = await this.http.get<KeysResponse>('/api/v1/keys')
      keys = fresh
      this.setKv('keys', JSON.stringify(fresh))
      this.setKv('keys_rev', fresh.keys_rev)
    } catch (e) {
      if (!(e instanceof SyncNetworkError) || !keys) throw e
    }
    if (!keys) throw new Error('A conta ainda não tem senha de criptografia.')
    checkKdfParams(keys.password.kdf)
    const kek = await passwordKek(password, fromB64u(keys.password.salt), keys.password.kdf)
    let dek: Uint8Array
    try {
      dek = unwrapDek(kek, keys.password.wrap, aadWrap(this.userId, 'password'))
    } catch {
      throw new Error('Senha de criptografia incorreta.')
    }
    this.setDek(dek, remember)
    // parâmetros antigos (abaixo do padrão atual): regrava a wrap (§3.4)
    const k = keys.password.kdf
    if (k.m < ARGON2_DEFAULT.m || k.t < ARGON2_DEFAULT.t) {
      void this.rewrapPassword(password).catch((e) =>
        this.log('não foi possível regravar a wrap:', errMsg(e))
      )
    }
    await this.afterUnlock()
    return this.status()
  }

  private async rewrapPassword(password: string): Promise<void> {
    if (!this.dek || !this.sk) return
    const pw = await newPasswordWrap(this.userId, this.dek, password)
    const r = await this.http.put<{ keys_rev?: number }>('/api/v1/keys/password', {
      key_proof: keyProof(this.sk).key_proof,
      password: pw
    })
    if (r?.keys_rev) this.setKv('keys_rev', r.keys_rev)
    await this.refreshKeys().catch(() => undefined)
  }

  async unlockWithRecovery(
    recoveryKey: string,
    newPassword: string,
    remember = true
  ): Promise<SyncStatus> {
    this.checkPasswordPolicy(newPassword)
    const entropy = parseRecoveryKey(recoveryKey)
    const keys = await this.http.get<KeysResponse>('/api/v1/keys')
    const kek = recoveryKek(entropy, fromB64u(keys.recovery.salt))
    let dek: Uint8Array
    try {
      dek = unwrapDek(kek, keys.recovery.wrap, aadWrap(this.userId, 'recovery'))
    } catch {
      throw new Error('Chave de recuperação incorreta.')
    }
    this.setDek(dek, remember)
    await this.rewrapPassword(newPassword)
    await this.afterUnlock()
    return this.status()
  }

  private checkPasswordPolicy(pw: string): void {
    if (typeof pw !== 'string' || pw.length < 10)
      throw new Error('A senha de criptografia precisa ter pelo menos 10 caracteres.')
    if (pw.trim().toLowerCase() === (this.kv('email') ?? '').toLowerCase())
      throw new Error('A senha não pode ser igual ao e-mail.')
  }

  async changePassword(newPassword: string): Promise<void> {
    if (!this.dek || !this.sk) throw new Error('Desbloqueie a conta primeiro.')
    this.checkPasswordPolicy(newPassword)
    await this.rewrapPassword(newPassword)
  }

  async newRecoveryKey(): Promise<{ recoveryKey: string }> {
    if (!this.dek || !this.sk) throw new Error('Desbloqueie a conta primeiro.')
    const r = newRecoveryWrap(this.userId, this.dek)
    await this.http.put('/api/v1/keys/recovery', {
      key_proof: keyProof(this.sk).key_proof,
      recovery: r.recovery
    })
    await this.refreshKeys().catch(() => undefined)
    return { recoveryKey: r.formatted }
  }

  /** Esquece a DEK neste computador (continua logado; pede a senha de novo). */
  lock(): SyncStatus {
    this.stop()
    this.dek = null
    this.sk = null
    this.deps.secrets.set('dek', null)
    this.connection = 'offline'
    this.emitStatus()
    return this.status()
  }

  async logout(): Promise<SyncStatus> {
    try {
      if (this.tokens) await this.http.post('/api/v1/auth/logout', {})
    } catch {
      /* offline: só local */
    }
    this.localSignOut()
    return this.status()
  }

  private localSignOut(): void {
    this.stop()
    this.host.reset()
    this.dek = null
    this.sk = null
    this.saveTokens(null)
    this.deps.secrets.set('dek', null)
    const kind = this.kv('server_kind')
    const url = this.kv('server_url')
    const last = this.kv('last_user_id')
    wipeSyncState(this.conn)
    if (kind) this.setKv('server_kind', kind)
    if (url) this.setKv('server_url', url)
    if (last) this.setKv('last_user_id', last)
    this.connection = 'disabled'
    this.error = null
    this.quota = null
    this.mergeInfo = null
    this.mergeSnapshot = null
    this.prompts = []
    this.outdated = []
    this.devicesAt = 0
    this.emitStatus()
    this.emit({ type: 'sync-data-changed', scopes: ['chats'] })
  }

  private async onSignedOut(code: string): Promise<void> {
    this.log('sessão encerrada pelo servidor:', code)
    this.localSignOut()
    this.emit({
      type: 'sync-notice',
      kind: 'error',
      text:
        code === 'device_revoked' || code === 'refresh_reused'
          ? 'Este dispositivo foi desconectado da conta. Entre de novo para sincronizar.'
          : 'Sessão do sync encerrada. Entre de novo para sincronizar.'
    })
  }

  /**
   * `keys.reset` (§5.5): o servidor apagou os dados e voltou a `keys_ready: false`, mas a sessão do
   * dispositivo continua válida (o servidor fecha o WS com 4403 logo depois). Apaga a DEK e o estado
   * de sync (os dados locais ficam) e volta para "definir senha de criptografia"; depois do novo
   * setup, desbloquear refaz o merge do primeiro login. Isolado para adaptar se o servidor passar a
   * usar outro código de fechamento.
   */
  private keysResetAt = 0
  private resetForKeys(): void {
    this.keysResetAt = Date.now()
    this.stop()
    this.host.reset()
    this.dek = null
    this.sk = null
    this.deps.secrets.set('dek', null)
    const keep = [
      'server_kind',
      'server_url',
      'server_name',
      'user_id',
      'last_user_id',
      'email',
      'account_name',
      'device_id',
      'device_name',
      'remember'
    ]
    const saved = keep.map((k) => [k, this.kv(k)] as const)
    wipeSyncState(this.conn)
    for (const [k, v] of saved) if (v !== null) this.setKv(k, v)
    this.connection = 'offline'
    this.emitStatus()
    this.emit({
      type: 'sync-notice',
      kind: 'error',
      text: 'As chaves da conta foram redefinidas. Defina a nova senha de criptografia no site e desbloqueie de novo (os dados deste computador voltam para a nuvem).'
    })
  }

  private async onWsFatal(code: number, reason: string): Promise<void> {
    if (code === 4403 && Date.now() - this.keysResetAt < 30_000) {
      // fechamento logo depois de keys.reset: não é revogação (ver resetForKeys)
      this.emitStatus()
      return
    }
    if (code === 4403) {
      await this.onSignedOut(reason || 'forbidden')
      return
    }
    if (code === 4001) {
      this.protocolError =
        'Este servidor usa uma versão incompatível do protocolo — atualize o app/servidor.'
      this.connection = 'error'
    } else if (code === 4409) {
      this.connection = 'error'
      this.error = 'Outra instância deste dispositivo assumiu a conexão do sync.'
    }
    this.emitStatus()
  }

  async devices(): Promise<SyncDevice[]> {
    const list = await this.http.get<Record<string, unknown>[]>('/api/v1/devices')
    const out: SyncDevice[] = (Array.isArray(list) ? list : []).map((d) => ({
      id: String(d.id),
      name: String(d.name ?? ''),
      platform: String(d.platform ?? ''),
      client: String(d.client ?? ''),
      appVersion: String(d.app_version ?? ''),
      canHost: d.can_host !== false,
      createdAt: String(d.created_at ?? ''),
      lastSeenAt: (d.last_seen_at as string) ?? null,
      lastIp: (d.last_ip as string) ?? null,
      online: !!d.online,
      current: !!d.current || d.id === this.deviceId
    }))
    this.devicesAt = Date.now()
    // renomeado em outro aparelho (PATCH /devices/{id}): o servidor é a fonte do nome — sem isso
    // este app continuava mostrando o nome antigo para si mesmo
    const me = out.find((d) => d.current)
    if (me && me.name && me.name !== this.deviceName) {
      this.setKv('device_name', me.name.slice(0, 64))
      this.emitStatus()
    }
    const outdated = outdatedHosts(out)
    if (!sameJson(outdated, this.outdated)) {
      this.outdated = outdated
      this.emitStatus()
    }
    return out
  }

  /** Relê a lista de aparelhos para o aviso de host desatualizado (falha = tenta na próxima). */
  private async refreshDevices(): Promise<void> {
    if (this.phase() !== 'ready' || Date.now() - this.devicesAt < DEVICES_MIN_MS) return
    this.devicesAt = Date.now()
    try {
      await this.devices()
    } catch (e) {
      this.log('lista de aparelhos falhou', errMsg(e))
    }
  }

  async renameDevice(id: string, name: string): Promise<void> {
    const n = String(name ?? '')
      .trim()
      .slice(0, 64)
    if (!n) throw new Error('Nome vazio.')
    await this.http.patch(`/api/v1/devices/${encodeURIComponent(id)}`, { name: n })
    if (id === this.deviceId) {
      this.setKv('device_name', n)
      this.emitStatus()
    }
  }

  async revokeDevice(id: string): Promise<void> {
    await this.http.del(`/api/v1/devices/${encodeURIComponent(id)}`)
    if (id === this.deviceId) this.localSignOut()
  }

  openSignup(): void {
    const url = this.info?.signupUrl ?? `${this.baseUrl()}/signup`
    this.deps.openExternal?.(`${url}${url.includes('?') ? '&' : '?'}from=app`)
  }

  openSetup(): void {
    this.deps.openExternal?.(`${this.baseUrl()}/setup`)
  }

  private setError(e: string | null): void {
    this.error = e
    this.emitStatus()
  }

  // ---------------- cifragem de registros ----------------

  encryptRecord(
    type: string,
    id: string,
    scope: string | null,
    rev: number,
    plain: Plain
  ): Envelope {
    if (!this.sk) throw new Error('Conta bloqueada.')
    return sealJson(this.sk.record, aadRecord(this.userId, type, id, scope, rev), plain)
  }

  decryptChange(c: Change): Plain {
    if (!this.sk) throw new Error('Conta bloqueada.')
    if (!c.env) throw new Error('registro sem envelope')
    return openJson(this.sk.record, aadRecord(this.userId, c.type, c.id, c.scope, c.rev), c.env)
  }

  // ---------------- sync_records ----------------

  record(type: string, id: string): RecordRow | null {
    return (
      (this.conn.prepare('SELECT * FROM sync_records WHERE type = ? AND id = ?').get(type, id) as
        RecordRow | undefined) ?? null
    )
  }

  basePlain(r: RecordRow | null): Plain | null {
    if (!r?.base) return null
    try {
      return JSON.parse(r.base) as Plain
    } catch {
      return null
    }
  }

  private putRecord(r: {
    type: string
    id: string
    scope: string | null
    rev: number
    seq?: number
    deleted: boolean
    base: Plain | null
    opaque?: unknown
  }): void {
    this.conn
      .prepare(
        `INSERT INTO sync_records (type, id, scope, rev, seq, deleted, base, opaque) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(type, id) DO UPDATE SET scope = excluded.scope, rev = excluded.rev,
         seq = MAX(excluded.seq, sync_records.seq), deleted = excluded.deleted, base = excluded.base, opaque = excluded.opaque`
      )
      .run(
        r.type,
        r.id,
        r.scope,
        r.rev,
        r.seq ?? 0,
        r.deleted ? 1 : 0,
        r.base ? JSON.stringify(r.base) : null,
        r.opaque ? JSON.stringify(r.opaque) : null
      )
  }

  /**
   * Ids de `setting` novos (SETTINGS_BACKFILL, protocolo 1.4.0/1.5.0) num dispositivo que já
   * sincronizava: depois do 1º pull, o valor local que ainda não tem registro online é marcado para
   * envio (uma vez por versão). Se outro dispositivo já enviou o seu, o pull acabou de aplicá-lo
   * (registro existe → nada a enviar: vale o que chegou primeiro ao servidor, como no LWW).
   * Desde 1.5.0 também a `voice` de chats/personas (antes local): o registro online sem `voice` e o
   * local com → o chat/persona é marcado (o merge por chave da config envia só o que mudou; um
   * `voice` que já está online vence).
   */
  private backfillSettings(): void {
    if (!this.started || this.kv('settings_backfill') === SETTINGS_BACKFILL.version) return
    for (const id of SETTINGS_BACKFILL.ids) {
      if (this.record('setting', id)) continue
      const l = buildLocal(this.conn, 'setting', id)
      if (l && l.plain.value != null) this.markDirty('setting', id)
    }
    for (const [type, table] of [
      ['chat', 'chats'],
      ['preset', 'presets']
    ] as const) {
      const rows = this.conn
        .prepare(`SELECT id, config_json FROM ${table} WHERE config_json LIKE '%"voice"%'`)
        .all() as { id: string; config_json: string }[]
      for (const r of rows) {
        const rec = this.record(type, r.id)
        if (!rec || rec.deleted) continue // nunca enviado: vai inteiro no envio normal
        let voice: unknown
        try {
          voice = (JSON.parse(r.config_json) as Plain).voice
        } catch {
          continue
        }
        if (voice == null) continue
        const base = this.basePlain(rec)
        const online = (base?.config as Plain | undefined)?.voice
        if (online === undefined) this.markDirty(type, r.id, type === 'chat' ? r.id : null)
      }
    }
    this.setKv('settings_backfill', SETTINGS_BACKFILL.version)
  }

  markDirty(type: string, id: string, scope: string | null = null): void {
    this.conn
      .prepare(
        `INSERT INTO sync_dirty (type, id, scope, mark) VALUES (?, ?, ?, 1)
         ON CONFLICT(type, id) DO UPDATE SET mark = mark + 1, scope = COALESCE(excluded.scope, scope)`
      )
      .run(type, id, scope)
  }

  private isDirty(type: string, id: string): boolean {
    return (
      !!this.conn.prepare('SELECT 1 FROM sync_dirty WHERE type = ? AND id = ?').get(type, id) ||
      this.inflight.has(key(type, id))
    )
  }

  // ---------------- sync_chat ----------------

  chatRow(chatId: string): {
    head: number
    base_head: number
    state: string | null
    needs_refetch: number
    host_cwd: string | null
    cwd_confirmed: number
  } {
    const r = this.conn.prepare('SELECT * FROM sync_chat WHERE chat_id = ?').get(chatId) as
      | {
          head: number
          base_head: number
          state: string | null
          needs_refetch: number
          host_cwd: string | null
          cwd_confirmed: number
        }
      | undefined
    return (
      r ?? {
        head: 0,
        base_head: 0,
        state: null,
        needs_refetch: 0,
        host_cwd: null,
        cwd_confirmed: 0
      }
    )
  }

  setChatRow(chatId: string, patch: Partial<Record<string, string | number | null>>): void {
    this.conn.prepare('INSERT OR IGNORE INTO sync_chat (chat_id) VALUES (?)').run(chatId)
    for (const [k, v] of Object.entries(patch)) {
      if (!/^[a-z_]+$/.test(k)) continue
      this.conn.prepare(`UPDATE sync_chat SET ${k} = ? WHERE chat_id = ?`).run(v ?? null, chatId)
    }
  }

  /** Avança o head conhecido de um chat (e o base_head quando o conteúdo local o reflete). */
  bumpHead(chatId: string, head: number, alsoBase: boolean): void {
    const r = this.chatRow(chatId)
    this.setChatRow(chatId, {
      head: Math.max(r.head, head),
      ...(alsoBase ? { base_head: Math.max(r.base_head, head) } : {})
    })
  }

  /** O chat tem conteúdo local ainda não aceito (dirty/em voo)? */
  hasPendingContent(chatId: string): boolean {
    if (
      this.conn
        .prepare(
          "SELECT 1 FROM sync_dirty WHERE scope = ? AND type IN ('session', 'message') LIMIT 1"
        )
        .get(chatId)
    )
      return true
    for (const k of this.inflight) {
      if (k.startsWith('content|') && k.endsWith(`|${chatId}`)) return true
    }
    return false
  }

  // ---------------- loop ----------------

  private pollDirty(): void {
    try {
      const r = this.conn
        .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(mark), 0) AS s FROM sync_dirty')
        .get() as { n: number; s: number }
      const sig = `${r.n}:${r.s}`
      if (sig !== this.dirtySig) {
        this.dirtySig = sig
        this.emitStatus()
        if (r.n > 0) this.schedulePush()
      }
    } catch {
      /* banco fechando */
    }
  }

  schedulePush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.scheduleCycle(0)
    }, this.deps.timing?.pushDebounceMs ?? 250)
  }

  scheduleCycle(delay = 0): void {
    if (!this.started) return
    if (delay) {
      if (this.retryTimer) return
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.scheduleCycle(0)
      }, delay)
      return
    }
    if (this.cycle) {
      this.cycleAgain = true
      return
    }
    this.cycle = this.runCycle().finally(() => {
      this.cycle = null
      if (this.cycleAgain) {
        this.cycleAgain = false
        this.scheduleCycle(0)
      }
    })
  }

  /** "Sincronizar agora": espera um ciclo completo. */
  async syncNow(): Promise<SyncStatus> {
    if (this.phase() !== 'ready') throw new Error('Entre e desbloqueie a conta para sincronizar.')
    if (!this.started) this.start()
    this.ws.reconnectNow()
    if (this.cycle) await this.cycle
    this.cycleAgain = false
    this.cycle = this.runCycle().finally(() => (this.cycle = null))
    await this.cycle
    void this.checkTrackedSkills().catch(() => undefined)
    return this.status()
  }

  private async runCycle(): Promise<void> {
    if (!this.started || !this.sk || this.protocolError) return
    try {
      await this.pullAll()
      this.backfillSettings()
      await this.pushAll()
      await this.refetchPending()
      this.error = null
      this.retryDelay = 0
      if (this.connection !== 'online' && this.ws.online) this.connection = 'online'
      if (this.connection === 'offline' || this.connection === 'error')
        this.connection = this.ws.online ? 'online' : 'connecting'
      this.setKv('last_sync_at', Date.now())
    } catch (e) {
      if (e instanceof SyncNetworkError) {
        this.connection = 'offline'
      } else {
        this.log('ciclo falhou:', errMsg(e))
        this.error = errMsg(e)
      }
      this.retryDelay = Math.min(
        60_000,
        Math.max(this.deps.timing?.retryMs ?? 2000, this.retryDelay * 2)
      )
      this.scheduleCycle(this.retryDelay)
    } finally {
      this.emitStatus()
    }
  }

  // ---------------- pull ----------------

  private pulling: Promise<void> | null = null

  /** Puxa até não haver mais mudanças (serializado). */
  pullAll(): Promise<void> {
    if (this.pulling) return this.pulling
    this.pulling = (async () => {
      for (;;) {
        if (!this.started && this.phase() === 'ready') return
        let res: { changes: Change[]; next: number; has_more: boolean; head: number }
        try {
          res = await this.http.get(
            `/api/v1/sync/changes?since=${this.cursor()}&limit=500&payload=1`
          )
        } catch (e) {
          if (e instanceof SyncApiError && e.code === 'cursor_expired') {
            await this.fullResync()
            return
          }
          throw e
        }
        await this.applyChanges(res.changes ?? [])
        this.setKv('cursor', Math.max(this.cursor(), res.next ?? res.head ?? 0))
        if (!res.has_more) break
      }
    })().finally(() => (this.pulling = null))
    return this.pulling
  }

  /** Pull até pelo menos `head` (antes de rodar como host, §8.3). */
  async pullUntil(head: number): Promise<void> {
    for (let i = 0; i < 5 && this.cursor() < head; i++) {
      await this.pullAll()
      if (this.cursor() < head) await sleep(100)
    }
  }

  /**
   * Busca o payload dos registros `omitted` (§7.2) em `records/fetch`. A rota também tem o orçamento
   * de ~8 MiB por página: o que passar dele volta `omitted` de novo — repete só com esses até não
   * sobrar nenhum (o servidor sempre devolve o primeiro pedido com payload). Rodada sem nenhum payload
   * novo: para (defesa contra laço); o que sobrar segue `omitted` e a aplicação fica adiada.
   */
  private async fillOmitted(changes: Change[]): Promise<void> {
    let need = changes.filter((c) => c.omitted && !c.deleted)
    while (need.length) {
      const again: Change[] = []
      let filled = 0
      for (let i = 0; i < need.length; i += 500) {
        const part = need.slice(i, i + 500)
        const r = await this.http.post<{ records: Change[] }>('/api/v1/records/fetch', {
          items: part.map((c) => ({ type: c.type, id: c.id }))
        })
        const map = new Map((r.records ?? []).map((x) => [key(x.type, x.id), x]))
        for (const c of part) {
          const full = map.get(key(c.type, c.id))
          if (!full || full.rev !== c.rev) continue // sumiu ou mudou: a nova revisão vem no pull
          if (full.env && !full.omitted) {
            c.env = full.env
            delete c.omitted
            filled++
          } else again.push(c)
        }
      }
      if (!filled) {
        if (again.length) this.log('records/fetch sem progresso; adiando', again.length)
        return
      }
      need = again
    }
  }

  /** Aplica um lote de mudanças (página do pull) numa transação. */
  async applyChanges(changes: Change[]): Promise<void> {
    if (!changes.length) return
    await this.fillOmitted(changes)
    const acc: ApplyResult = { events: [], scopes: new Set(), redirty: [] }
    const skills: { id: string; plain: Plain | null }[] = []
    withApply(this.conn, () => {
      for (const c of changes) {
        try {
          this.applyChange(c, acc, skills)
        } catch (e) {
          this.log('aplicação adiada', c.type, c.id, errMsg(e))
          this.conn
            .prepare(
              'INSERT INTO sync_pending_apply (type, id, change) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET change = excluded.change'
            )
            .run(c.type, c.id, JSON.stringify(c))
        }
      }
      this.retryPendingApplies(acc, skills)
      acc.events.push(...normalizeNegativeSeqs(this.conn))
    })
    for (const r of acc.redirty) this.markDirty(r.type, r.id)
    this.flushApply(acc)
    for (const s of skills)
      void this.onRemoteSkill(s.id, s.plain).catch((e) => this.log('skill', errMsg(e)))
  }

  private retryPendingApplies(
    acc: ApplyResult,
    skills: { id: string; plain: Plain | null }[]
  ): void {
    for (let round = 0; round < 4; round++) {
      const rows = this.conn.prepare('SELECT * FROM sync_pending_apply').all() as {
        type: string
        id: string
        change: string
      }[]
      if (!rows.length) return
      let progress = false
      for (const r of rows) {
        try {
          const c = JSON.parse(r.change) as Change
          this.applyChange(c, acc, skills)
          this.conn
            .prepare('DELETE FROM sync_pending_apply WHERE type = ? AND id = ?')
            .run(r.type, r.id)
          progress = true
        } catch {
          /* continua adiado */
        }
      }
      if (!progress) return
    }
  }

  private flushApply(acc: ApplyResult): void {
    const seen = new Set<string>()
    for (const ev of acc.events) {
      // registro `session` atrasado (push leva ~1 s) não sobrepõe o status ao vivo do espelho
      const e: AgentEvent =
        ev.type === 'session-updated'
          ? { ...ev, session: this.host.displaySession(ev.session) }
          : ev
      // eventos repetidos do mesmo registro no lote: só o último importa
      this.emit(e)
      if (e.type === 'message-added' && e.message.message.role === 'assistant')
        this.host.onPersistedAssistant(e.message)
      if (e.type === 'chat-deleted') {
        this.host.forgetChat(e.chatId)
        removeChatToolOutputs(e.chatId) // saídas salvas de tools (só locais)
      }
      seen.add(e.type)
    }
    if (acc.scopes.size) this.emit({ type: 'sync-data-changed', scopes: [...acc.scopes] })
    if (acc.scopes.has('skills')) this.deps.skills?.changed()
  }

  /** Aplica uma mudança remota (dentro de withApply). Lança se faltar referência (FK). */
  private applyChange(
    c: Change,
    acc: ApplyResult,
    skills: { id: string; plain: Plain | null }[]
  ): void {
    const rec = this.record(c.type, c.id)
    if (rec && c.rev < rec.rev) {
      this.log('revisão antiga ignorada', c.type, c.id, c.rev, '<', rec.rev)
      return
    }
    if (rec && c.rev === rec.rev && !!rec.deleted === !!c.deleted && !rec.opaque) {
      if (c.seq > rec.seq)
        this.conn
          .prepare('UPDATE sync_records SET seq = ? WHERE type = ? AND id = ?')
          .run(c.seq, c.type, c.id)
      if (isContent(c.type) && c.scope)
        this.bumpHead(c.scope, c.seq, !this.hasPendingContent(c.scope))
      return
    }
    if (!isRecordType(c.type)) {
      this.putRecord({ ...c, deleted: c.deleted, base: null, opaque: c })
      return
    }
    const type = c.type as RecordType
    if (isContent(type)) {
      const chatId = c.scope ?? ''
      this.bumpHead(chatId, c.seq, false)
      if (this.hasPendingContent(chatId) || this.host.isDivergedSelf(chatId)) {
        this.setChatRow(chatId, { needs_refetch: 1 })
        return
      }
    }
    if (c.deleted) {
      if (type === 'chat' && this.hasPendingContent(c.id) && existsLocal(this.conn, 'chat', c.id)) {
        this.addPrompt(c.id)
        this.putRecord({
          type,
          id: c.id,
          scope: c.scope,
          rev: c.rev,
          seq: c.seq,
          deleted: true,
          base: null
        })
        return
      }
      const r = deleteLocal(this.conn, type, c.id)
      this.mergeResult(acc, r)
      this.conn.prepare('DELETE FROM sync_dirty WHERE type = ? AND id = ?').run(type, c.id)
      this.putRecord({
        type,
        id: c.id,
        scope: c.scope,
        rev: c.rev,
        seq: c.seq,
        deleted: true,
        base: null
      })
      if (type === 'chat') this.dropChatState(c.id)
      if (type === 'memory_collection')
        this.conn.prepare("DELETE FROM sync_records WHERE type = 'memory' AND scope = ?").run(c.id)
      if (type === 'skill') skills.push({ id: c.id, plain: null })
      if (isContent(type) && c.scope) this.bumpHead(c.scope, c.seq, true)
      return
    }
    let plain: Plain
    try {
      plain = this.decryptChange(c)
    } catch (e) {
      if (e instanceof UnsupportedEnvelopeError) {
        this.putRecord({ ...c, deleted: false, base: null, opaque: c })
        return
      }
      throw new Error(`não foi possível decifrar ${c.type}/${c.id}: ${errMsg(e)}`, { cause: e })
    }
    const dirty = this.isDirty(type, c.id)
    if (type === 'skill') {
      skills.push({ id: c.id, plain })
    } else if (dirty && FIELD_LWW.includes(type)) {
      const local = buildLocal(this.conn, type, c.id, this.chatExtra(type, c.id))
      const merged = local ? merge3(plain, this.basePlain(rec), local.plain) : plain
      this.mergeResult(acc, this.applyPlain(type, c.id, merged))
      this.markDirty(type, c.id, c.scope)
    } else if (dirty && type === 'setting') {
      this.markDirty(type, c.id)
    } else {
      this.mergeResult(acc, this.applyPlain(type, c.id, plain))
    }
    this.putRecord({
      type,
      id: c.id,
      scope: c.scope,
      rev: c.rev,
      seq: c.seq,
      deleted: false,
      base: plain
    })
    if (isContent(type) && c.scope) this.bumpHead(c.scope, c.seq, true)
  }

  private applyPlain(type: string, id: string, plain: Plain): ApplyResult {
    const isNewChat = type === 'chat' && !existsLocal(this.conn, 'chat', id)
    const r = applyRemote(this.conn, type, id, plain, {
      windowOpen: (chatId) => this.host.windowOpen(chatId),
      defaultCwd: () => {
        const r = this.conn.prepare("SELECT value FROM settings WHERE key = 'defaultCwd'").get() as
          { value: string } | undefined
        try {
          const v = r ? JSON.parse(r.value) : null
          return typeof v === 'string' && v ? v : homedir()
        } catch {
          return homedir()
        }
      }
    })
    if (type === 'chat')
      this.setChatRow(id, {
        host_cwd: r.hostCwd ? JSON.stringify(r.hostCwd) : null,
        ...(isNewChat ? { cwd_confirmed: -1 } : {})
      })
    return r
  }

  private mergeResult(acc: ApplyResult, r: ApplyResult): void {
    acc.events.push(...r.events)
    for (const s of r.scopes) acc.scopes.add(s)
    acc.redirty.push(...r.redirty)
  }

  /** hostCwd do chat (informativo) para o plaintext. */
  chatExtra(type: string, id: string): { hostCwd?: unknown } {
    if (type !== 'chat') return {}
    const r = this.chatRow(id)
    if (!r.host_cwd) return {}
    try {
      return { hostCwd: JSON.parse(r.host_cwd) }
    } catch {
      return {}
    }
  }

  private dropChatState(chatId: string): void {
    this.conn
      .prepare("DELETE FROM sync_records WHERE scope = ? AND type IN ('session', 'message')")
      .run(chatId)
    this.conn.prepare('DELETE FROM sync_dirty WHERE scope = ?').run(chatId)
    this.conn.prepare('DELETE FROM sync_chat WHERE chat_id = ?').run(chatId)
  }

  private addPrompt(chatId: string): void {
    if (this.prompts.some((p) => p.chatId === chatId)) return
    const r = this.conn.prepare('SELECT title FROM chats WHERE id = ?').get(chatId) as
      { title: string } | undefined
    this.prompts.push({ kind: 'chat-gone', chatId, title: r?.title || 'Chat sem título' })
    this.emitStatus()
  }

  /** "Este chat foi apagado em outro dispositivo…": manter como novo chat / descartar. */
  async answerPrompt(chatId: string, keep: boolean): Promise<SyncStatus> {
    this.prompts = this.prompts.filter((p) => p.chatId !== chatId)
    if (keep) {
      this.copyChatAsNew(chatId)
    }
    const r = withApply(this.conn, () => deleteLocal(this.conn, 'chat', chatId))
    this.dropChatState(chatId)
    this.conn.prepare("DELETE FROM sync_dirty WHERE type = 'chat' AND id = ?").run(chatId)
    this.flushApply(r)
    this.emit({ type: 'sync-data-changed', scopes: ['chats'] })
    this.schedulePush()
    return this.status()
  }

  /**
   * Cópia local de um chat com ids novos (enviada como chat novo pelos triggers). A árvore de
   * mensagens é remapeada (parent_id, chaves/valores de branch_sel_json), assim como o
   * `meta.subSessionId` das mensagens de delegate_task; parent_id NULL (legado) continua NULL.
   */
  private copyChatAsNew(chatId: string): string {
    const db = this.conn
    const newChat = randomUUID()
    const idMap = new Map<string, string>()
    const msgMap = new Map<string, string>()
    db.transaction(() => {
      const c = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as Record<
        string,
        unknown
      >
      if (!c) return
      const sessions = db
        .prepare('SELECT * FROM sessions WHERE chat_id = ? ORDER BY depth, created_at')
        .all(chatId) as Record<string, unknown>[]
      for (const s of sessions) idMap.set(String(s.id), randomUUID())
      const msgsBySession = new Map<string, Record<string, unknown>[]>()
      for (const s of sessions) {
        const msgs = db
          .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
          .all(s.id) as Record<string, unknown>[]
        msgsBySession.set(String(s.id), msgs)
        for (const m of msgs) msgMap.set(String(m.id), randomUUID())
      }
      db.prepare(
        'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(
        newChat,
        `${c.title || 'Chat'} (cópia)`,
        c.config_json,
        idMap.get(String(c.main_session_id)) ?? null,
        c.created_at,
        Date.now()
      )
      for (const s of sessions) {
        db.prepare(
          `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, provider_id, title, task, status, created_at, memory_json, branch_sel_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          idMap.get(String(s.id)),
          newChat,
          s.parent_session_id ? (idMap.get(String(s.parent_session_id)) ?? null) : null,
          s.parent_tool_call_id,
          s.depth,
          s.model,
          s.provider_id,
          s.title,
          s.task,
          s.status === 'running' ? 'interrupted' : s.status,
          s.created_at,
          s.memory_json ?? null,
          JSON.stringify(remapBranchSel(branchSelFromColumn(s.branch_sel_json as string), msgMap))
        )
        for (const m of msgsBySession.get(String(s.id)) ?? []) {
          // mãe: '' (raiz) fica ''; NULL (legado) fica NULL; id de fora da cópia → NULL (derivar)
          const parent = parentIdFromColumn(m.parent_id as string | null)
          const meta = m.meta_json as string
          db.prepare(
            'INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(
            msgMap.get(String(m.id)),
            idMap.get(String(s.id)),
            m.seq,
            m.message_json,
            remapSubSession(meta, idMap),
            m.created_at,
            parent === undefined
              ? null
              : parent === null
                ? parentIdToColumn(null)
                : (msgMap.get(parent) ?? null)
          )
        }
      }
    })()
    return newChat
  }

  // ---------------- resync completo (§7.9) ----------------

  private async downloadRecords(): Promise<{ changes: Change[]; head: number }> {
    const out: Change[] = []
    let head = 0
    let after = 0
    for (;;) {
      const r = await this.http.get<{
        records: Change[]
        next?: number
        has_more?: boolean
        head?: number
      }>(`/api/v1/records?after=${after}&limit=1000&payload=1`)
      const list = r.records ?? []
      if (!head) head = r.head ?? 0
      out.push(...list)
      if (!r.has_more || !list.length) break
      after = r.next ?? list[list.length - 1].seq
    }
    return { changes: out, head }
  }

  private async fullResync(): Promise<void> {
    this.log('cursor expirado: resync completo')
    const { changes, head } = await this.downloadRecords()
    const online = new Set(changes.map((c) => key(c.type, c.id)))
    const acc: ApplyResult = { events: [], scopes: new Set(), redirty: [] }
    withApply(this.conn, () => {
      const known = this.conn
        .prepare('SELECT type, id FROM sync_records WHERE deleted = 0 AND rev > 0')
        .all() as { type: string; id: string }[]
      for (const k of known) {
        if (online.has(key(k.type, k.id)) || !isRecordType(k.type)) continue
        if (k.type === 'setting') continue
        this.mergeResult(acc, deleteLocal(this.conn, k.type, k.id))
        this.conn.prepare('DELETE FROM sync_records WHERE type = ? AND id = ?').run(k.type, k.id)
        this.conn.prepare('DELETE FROM sync_dirty WHERE type = ? AND id = ?').run(k.type, k.id)
      }
    })
    this.flushApply(acc)
    await this.applyChanges(changes)
    this.setKv('cursor', head)
    await this.loadChatStates(0)
  }

  async loadChatStates(since = Number(this.kv('state_cursor') ?? 0)): Promise<void> {
    const r = await this.http.get<{
      chat_states?: Record<string, unknown>[]
      state_cursor?: number
    }>(`/api/v1/chat-states?since=${since}`)
    for (const s of r.chat_states ?? []) this.host.onChatState(s, false)
    if (r.state_cursor != null) this.setKv('state_cursor', r.state_cursor)
  }

  // ---------------- push ----------------

  private async pushAll(): Promise<void> {
    if (this.quota) return
    // 1) lotes já gravados (mesmo push_id nas tentativas)
    const rows = this.conn.prepare('SELECT * FROM sync_outbox ORDER BY created_at').all() as {
      push_id: string
      kind: string
      chat_id: string | null
      body: string
      meta: string
    }[]
    for (const r of rows) {
      if (!this.started) return
      await this.sendBatch(r)
    }
    // 2) lotes novos a partir do que mudou
    for (let round = 0; round < 50; round++) {
      if (!this.started) return
      const batches = await this.buildBatches()
      if (!batches.length) return
      let progressed = false
      for (const b of batches) {
        if (!this.started) return
        const row = {
          push_id: b.body.push_id,
          kind: b.kind,
          chat_id: b.chatId,
          body: JSON.stringify(b.body),
          meta: JSON.stringify(b.meta)
        }
        this.conn
          .prepare(
            'INSERT INTO sync_outbox (push_id, kind, chat_id, body, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(row.push_id, row.kind, row.chat_id, row.body, row.meta, Date.now())
        if (await this.sendBatch(row)) progressed = true
      }
      if (!progressed) return
    }
  }

  /** Monta os lotes: registros LWW juntos; conteúdo um chat por lote (§7.4). */
  private async buildBatches(): Promise<
    { kind: 'lww' | 'content'; chatId: string | null; body: PushBody; meta: ItemMeta[] }[]
  > {
    const dirty = this.conn
      .prepare('SELECT type, id, scope, mark FROM sync_dirty ORDER BY rowid')
      .all() as { type: string; id: string; scope: string | null; mark: number }[]
    if (!dirty.length) return []
    const lww: { item: PushItem; meta: ItemMeta; bytes: number }[] = []
    const content = new Map<string, { item: PushItem; meta: ItemMeta; bytes: number }[]>()
    const blobShas = new Map<string, string[]>()
    const drop = (type: string, id: string, mark: number): void => {
      this.conn
        .prepare('DELETE FROM sync_dirty WHERE type = ? AND id = ? AND mark = ?')
        .run(type, id, mark)
    }
    for (const d of dirty) {
      if (!isRecordType(d.type) || this.inflight.has(key(d.type, d.id))) continue
      const rec = this.record(d.type, d.id)
      if (rec?.opaque) {
        drop(d.type, d.id, d.mark)
        continue
      }
      let chatId: string | null = null
      if (isContent(d.type)) {
        chatId = d.scope ?? rec?.scope ?? null
        if (!chatId) {
          drop(d.type, d.id, d.mark)
          continue
        }
        // chat apagado localmente: o tombstone do chat leva o conteúdo (cascata no servidor)
        if (!existsLocal(this.conn, 'chat', chatId)) {
          drop(d.type, d.id, d.mark)
          continue
        }
        if (this.host.isDiverged(chatId)) continue
      }
      if (d.type === 'chat' && this.host.isDiverged(d.id) && existsLocal(this.conn, 'chat', d.id))
        continue
      const local =
        d.type === 'skill'
          ? this.buildSkillLocal(d.id)
          : buildLocal(this.conn, d.type, d.id, this.chatExtra(d.type, d.id))
      let item: PushItem
      let plain: Plain | null = null
      if (!local) {
        if (!rec || rec.deleted || d.type === 'setting') {
          drop(d.type, d.id, d.mark)
          continue
        }
        item = {
          type: d.type,
          id: d.id,
          scope: rec.scope,
          base_rev: rec.rev,
          rev: rec.rev + 1,
          deleted: true,
          blobs: []
        }
      } else {
        const base = rec && !rec.deleted ? this.basePlain(rec) : null
        plain = base ? { ...base, ...local.plain } : local.plain
        if (base && sameRecordPlain(this.conn, d.type, plain, base) && rec!.scope === local.scope) {
          drop(d.type, d.id, d.mark)
          continue
        }
        if (d.type === 'setting' && !rec && (plain.value ?? null) === null) {
          drop(d.type, d.id, d.mark)
          continue
        }
        const baseRev = rec?.rev ?? 0
        let blobs: string[] = []
        if (d.type === 'message' && local.shas?.length && this.sk) {
          blobShas.set(key(d.type, d.id), local.shas)
          blobs = local.shas.map((s) => blobIdFromSha256(this.sk!, fromHex(s)))
        }
        if (d.type === 'skill') {
          const b = (plain.bundle ?? {}) as { blobId?: string }
          if (b.blobId) blobs = [b.blobId]
        }
        item = {
          type: d.type,
          id: d.id,
          scope: local.scope,
          base_rev: baseRev,
          rev: baseRev + 1,
          deleted: false,
          env: this.encryptRecord(d.type, d.id, local.scope, baseRev + 1, plain),
          blobs
        }
      }
      const meta: ItemMeta = {
        type: d.type,
        id: d.id,
        scope: item.scope,
        rev: item.rev,
        mark: d.mark,
        deleted: item.deleted,
        plain
      }
      const bytes = item.env ? item.env.c.length : 64
      if (chatId) {
        const list = content.get(chatId) ?? []
        list.push({ item, meta, bytes })
        content.set(chatId, list)
      } else lww.push({ item, meta, bytes })
    }

    const out: {
      kind: 'lww' | 'content'
      chatId: string | null
      body: PushBody
      meta: ItemMeta[]
    }[] = []
    // anexos: sobe os blobs antes dos registros
    const uploadedOk = await this.ensureBlobs(blobShas)
    const fixBlobs = (e: { item: PushItem }): void => {
      if (e.item.type !== 'message') return
      e.item.blobs = e.item.blobs.filter((b) => uploadedOk.has(b))
    }
    const chunks = <T extends { bytes: number }>(list: T[]): T[][] => {
      const res: T[][] = []
      let cur: T[] = []
      let size = 0
      for (const x of list) {
        if (cur.length && (cur.length >= MAX_ITEMS || size + x.bytes > MAX_BATCH_BYTES)) {
          res.push(cur)
          cur = []
          size = 0
        }
        cur.push(x)
        size += x.bytes
      }
      if (cur.length) res.push(cur)
      return res
    }
    // LWW: chats novos primeiro (o conteúdo precisa do chat no servidor)
    lww.sort((a, b) => (a.item.type === 'chat' ? -1 : 0) - (b.item.type === 'chat' ? -1 : 0))
    for (const part of chunks(lww)) {
      part.forEach(fixBlobs)
      out.push({
        kind: 'lww',
        chatId: null,
        body: { push_id: randomUUID(), items: part.map((x) => x.item) },
        meta: part.map((x) => x.meta)
      })
    }
    for (const [chatId, list] of content) {
      const chatRec = this.record('chat', chatId)
      if (!chatRec || chatRec.deleted) {
        // o chat ainda não está no servidor: vai no lote LWW (este ciclo) — conteúdo no próximo
        if (!lww.some((x) => x.item.type === 'chat' && x.item.id === chatId))
          this.markDirty('chat', chatId, chatId)
        continue
      }
      const mode = await this.host.pushModeFor(chatId)
      if (!mode) {
        // janela de outro dispositivo aberta (ou divergente): tenta de novo depois
        if (!this.host.isDiverged(chatId)) this.scheduleCycle(1500)
        continue
      }
      list.sort((a, b) => CONTENT_ORDER(a.item, b.item))
      list.forEach(fixBlobs)
      const sessDepth = (i: PushItem): number => {
        if (i.type !== 'session') return 0
        const p = (list.find((x) => x.item === i)?.meta.plain ?? {}) as { depth?: number }
        return p.depth ?? 0
      }
      list.sort((a, b) =>
        a.item.type === 'session' && b.item.type === 'session' && !a.item.deleted && !b.item.deleted
          ? sessDepth(a.item) - sessDepth(b.item)
          : 0
      )
      for (const part of chunks(list)) {
        const body: PushBody = {
          push_id: randomUUID(),
          items: part.map((x) => x.item),
          chat_bases: { [chatId]: this.chatRow(chatId).base_head }
        }
        if (mode.epoch != null) body.host_epochs = { [chatId]: mode.epoch }
        out.push({ kind: 'content', chatId, body, meta: part.map((x) => x.meta) })
      }
    }
    return out
  }

  /** Envia um lote gravado. true = aceito. Erro de rede propaga (o ciclo tenta de novo). */
  private async sendBatch(row: {
    push_id: string
    kind: string
    chat_id: string | null
    body: string
    meta: string
  }): Promise<boolean> {
    const body = JSON.parse(row.body) as PushBody
    const meta = JSON.parse(row.meta) as ItemMeta[]
    if (row.kind === 'content' && row.chat_id) this.refreshContentBody(body, row.chat_id)
    const deleteRow = (): void => {
      this.conn.prepare('DELETE FROM sync_outbox WHERE push_id = ?').run(row.push_id)
    }
    const keys = meta.map((m) => key(m.type, m.id))
    const flightKey = row.chat_id ? `content|${row.push_id}|${row.chat_id}` : null
    for (const k of keys) this.inflight.add(k)
    if (flightKey) this.inflight.add(flightKey)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await this.http.post<{
            results: { type: string; id: string; rev: number; seq: number }[]
            head: number
            chat_heads?: Record<string, number>
          }>('/api/v1/sync/push', body)
          this.commitBatch(meta, res, row.chat_id)
          deleteRow()
          return true
        } catch (e) {
          if (!(e instanceof SyncApiError)) throw e
          if (e.code === 'blob_missing' && attempt === 0) {
            const missing = (e.details.missing as string[]) ?? []
            await this.uploadBlobIds(missing)
            continue
          }
          deleteRow()
          await this.onPushError(e, body, meta, row.chat_id)
          return false
        }
      }
      deleteRow()
      return false
    } finally {
      for (const k of keys) this.inflight.delete(k)
      if (flightKey) this.inflight.delete(flightKey)
    }
  }

  /**
   * `chat_bases`/`host_epochs` de um lote de conteúdo valem no ENVIO, não na montagem: todos os
   * lotes de um chat grande são montados juntos, e o aceite do anterior (commitBatch → bumpHead)
   * avança o base_head — com a base da montagem o servidor veria base < head e marcaria uma
   * divergência falsa (§8.4). Também cobre a outbox reenviada depois de um reinício. A base só
   * avança quando o conteúdo local reflete o head (os itens do lote seguem em sync_dirty até o
   * aceite, então mudanças remotas não a movem), logo isso não esconde uma divergência real.
   */
  private refreshContentBody(body: PushBody, chatId: string): void {
    body.chat_bases = { ...(body.chat_bases ?? {}), [chatId]: this.chatRow(chatId).base_head }
    // epoch: o da janela aberta agora; sem janela (fechou, reinício) o epoch antigo só daria
    // not_host → vai como replay, que é o que o próximo pushModeFor decidiria
    const epoch = this.host.windowEpoch(chatId)
    if (epoch != null) body.host_epochs = { ...(body.host_epochs ?? {}), [chatId]: epoch }
    else if (body.host_epochs) {
      delete body.host_epochs[chatId]
      if (!Object.keys(body.host_epochs).length) delete body.host_epochs
    }
  }

  private commitBatch(
    meta: ItemMeta[],
    res: {
      results: { type: string; id: string; rev: number; seq: number }[]
      head: number
      chat_heads?: Record<string, number>
    },
    chatId: string | null
  ): void {
    const seqOf = new Map((res.results ?? []).map((r) => [key(r.type, r.id), r.seq]))
    this.conn.transaction(() => {
      for (const m of meta) {
        this.putRecord({
          type: m.type,
          id: m.id,
          scope: m.scope,
          rev: m.rev,
          seq: seqOf.get(key(m.type, m.id)) ?? 0,
          deleted: m.deleted,
          base: m.deleted ? null : m.plain
        })
        this.conn
          .prepare('DELETE FROM sync_dirty WHERE type = ? AND id = ? AND mark = ?')
          .run(m.type, m.id, m.mark)
        if (m.deleted && m.type === 'chat') this.dropChatState(m.id)
        if (m.deleted && m.type === 'memory_collection')
          this.conn
            .prepare("DELETE FROM sync_records WHERE type = 'memory' AND scope = ?")
            .run(m.id)
      }
      for (const [cid, h] of Object.entries(res.chat_heads ?? {}))
        this.bumpHead(cid, h, cid === chatId)
    })()
    this.emitStatus()
  }

  private async onPushError(
    e: SyncApiError,
    body: PushBody,
    meta: ItemMeta[],
    chatId: string | null
  ): Promise<void> {
    const cid = (e.details.chat_id as string) ?? chatId
    switch (e.code) {
      case 'conflict':
        await this.handleConflicts((e.details.conflicts as Record<string, unknown>[]) ?? [], meta)
        return
      case 'chat_busy':
        this.scheduleCycle(1500)
        return
      case 'chat_diverged':
        if (cid) this.host.markDiverged(cid, e.details.diverged as Record<string, unknown> | null)
        return
      case 'divergence_discarded':
        if (cid) await this.discardLocalVersion(cid)
        return
      case 'not_host':
        if (cid) {
          if (e.details.state)
            this.host.onChatState(e.details.state as Record<string, unknown>, false)
          this.host.dropWindow(cid)
        }
        this.scheduleCycle(300)
        return
      case 'stale_base':
        if (cid) {
          const r = this.chatRow(cid)
          this.setChatRow(cid, { base_head: r.head })
        }
        this.scheduleCycle(300)
        return
      case 'quota_exceeded': {
        const d = e.details as { kind?: string; used?: number; limit?: number }
        this.quota = `Cota excedida (${d.kind ?? 'armazenamento'}): o app parou de enviar mudanças e continua recebendo.`
        this.emitStatus()
        return
      }
      case 'scope_deleted':
      case 'scope_missing':
        if (cid) this.markDirty('chat', cid, cid)
        return
      default:
        // corpo inválido etc.: não fica em laço — descarta essas marcas e registra o erro
        this.log('push recusado', e.status, e.code, e.message)
        this.error = `Envio recusado pelo servidor: ${e.message}`
        for (const m of meta)
          this.conn
            .prepare('DELETE FROM sync_dirty WHERE type = ? AND id = ? AND mark = ?')
            .run(m.type, m.id, m.mark)
        void body
    }
  }

  private async handleConflicts(
    conflicts: Record<string, unknown>[],
    meta: ItemMeta[]
  ): Promise<void> {
    const acc: ApplyResult = { events: [], scopes: new Set(), redirty: [] }
    withApply(this.conn, () => {
      for (const c of conflicts) {
        const type = String(c.type)
        const id = String(c.id)
        const reason = String(c.reason)
        const current = c.current as Change | undefined
        const m = meta.find((x) => x.type === type && x.id === id)
        if (reason === 'gone' || (reason === 'rev_mismatch' && current?.deleted)) {
          if (type === 'chat' && this.hasPendingContent(id) && existsLocal(this.conn, 'chat', id)) {
            this.addPrompt(id)
            continue
          }
          this.mergeResult(acc, deleteLocal(this.conn, type, id))
          this.conn.prepare('DELETE FROM sync_dirty WHERE type = ? AND id = ?').run(type, id)
          if (current)
            this.putRecord({
              type,
              id,
              scope: current.scope,
              rev: current.rev,
              seq: current.seq,
              deleted: true,
              base: null
            })
          if (type === 'chat') this.dropChatState(id)
          continue
        }
        if (reason === 'rev_mismatch' && current) {
          let curPlain: Plain
          try {
            curPlain = this.decryptChange(current)
          } catch (err) {
            this.log('conflito: não decifrou o atual', type, id, errMsg(err))
            continue
          }
          if (FIELD_LWW.includes(type as RecordType)) {
            const local = buildLocal(this.conn, type, id, this.chatExtra(type, id))
            const rec = this.record(type, id)
            if (local) {
              const merged = merge3(curPlain, this.basePlain(rec), local.plain)
              this.mergeResult(acc, this.applyPlain(type, id, merged))
            }
          }
          // setting/skill (LWW inteiro): o local vence com base_rev = atual; conteúdo: rev atual,
          // chat_bases antigo → o servidor detecta a divergência (§7.5)
          this.putRecord({
            type,
            id,
            scope: current.scope,
            rev: current.rev,
            seq: current.seq,
            deleted: false,
            base: curPlain
          })
          this.markDirty(type, id, current.scope)
          continue
        }
        if (reason === 'scope_deleted') {
          const chatId = m?.scope ?? (current?.scope as string | null)
          if (chatId && existsLocal(this.conn, 'chat', chatId)) this.addPrompt(chatId)
          else this.conn.prepare('DELETE FROM sync_dirty WHERE type = ? AND id = ?').run(type, id)
          continue
        }
        if (reason === 'scope_missing') {
          const scope = m?.scope
          if (scope && (type === 'session' || type === 'message'))
            this.markDirty('chat', scope, scope)
          if (scope && type === 'memory') this.markDirty('memory_collection', scope)
        }
      }
    })
    this.flushApply(acc)
  }

  /** Chats marcados "precisa rebaixar" sem conteúdo pendente: baixa o conteúdo online e reconcilia. */
  private async refetchPending(): Promise<void> {
    const rows = this.conn
      .prepare('SELECT chat_id FROM sync_chat WHERE needs_refetch = 1')
      .all() as { chat_id: string }[]
    for (const r of rows) {
      if (this.hasPendingContent(r.chat_id) || this.host.isDiverged(r.chat_id)) continue
      await this.replaceContentWithOnline(r.chat_id, false)
    }
  }

  /** Busca os registros de conteúdo online de um chat. */
  async fetchChatRecords(chatId: string): Promise<DownloadedRecord[]> {
    const out: DownloadedRecord[] = []
    let after = 0
    for (;;) {
      const r = await this.http.get<{ records: Change[]; next?: number; has_more?: boolean }>(
        `/api/v1/records?scope=${encodeURIComponent(chatId)}&after=${after}&limit=1000&payload=1`
      )
      const list = r.records ?? []
      await this.fillOmitted(list)
      for (const c of list) {
        if (!isContent(c.type) || c.deleted) continue
        let plain: Plain | null = null
        try {
          plain = this.decryptChange(c)
        } catch (e) {
          this.log('não decifrou', c.type, c.id, errMsg(e))
        }
        out.push({ change: c, plain })
      }
      if (!r.has_more || !list.length) break
      after = r.next ?? list[list.length - 1].seq
    }
    return out
  }

  /**
   * Substitui o conteúdo local de um chat pela versão online (apaga o que não está online).
   * `discard` = descarta também o conteúdo local pendente (divergência resolvida para a online).
   */
  async replaceContentWithOnline(chatId: string, discard: boolean): Promise<void> {
    const online = await this.fetchChatRecords(chatId)
    const acc: ApplyResult = { events: [], scopes: new Set(), redirty: [] }
    withApply(this.conn, () => {
      if (discard) {
        this.conn
          .prepare("DELETE FROM sync_dirty WHERE scope = ? AND type IN ('session', 'message')")
          .run(chatId)
        this.conn.prepare('DELETE FROM sync_outbox WHERE chat_id = ?').run(chatId)
      }
      const onlineIds = new Set(online.map((r) => key(r.change.type, r.change.id)))
      // mensagens locais que não existem online
      const localMsgs = this.conn
        .prepare(
          'SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.chat_id = ?'
        )
        .all(chatId) as { id: string }[]
      for (const m of localMsgs)
        if (!onlineIds.has(key('message', m.id))) {
          this.mergeResult(acc, deleteLocal(this.conn, 'message', m.id))
          this.conn.prepare("DELETE FROM sync_records WHERE type = 'message' AND id = ?").run(m.id)
        }
      const localSess = this.conn
        .prepare('SELECT id FROM sessions WHERE chat_id = ? ORDER BY depth DESC')
        .all(chatId) as { id: string }[]
      const mainId = (
        this.conn.prepare('SELECT main_session_id FROM chats WHERE id = ?').get(chatId) as
          { main_session_id: string | null } | undefined
      )?.main_session_id
      for (const s of localSess)
        if (!onlineIds.has(key('session', s.id)) && s.id !== mainId) {
          this.mergeResult(acc, deleteLocal(this.conn, 'session', s.id))
          this.conn.prepare("DELETE FROM sync_records WHERE type = 'session' AND id = ?").run(s.id)
        }
      const sorted = [...online].sort((a, b) => {
        const r = (x: DownloadedRecord): number =>
          x.change.type === 'session' ? Number((x.plain as { depth?: number })?.depth ?? 0) : 10
        return r(a) - r(b)
      })
      for (const r of sorted) {
        if (!r.plain) continue
        const rec = this.record(r.change.type, r.change.id)
        const local = buildLocal(this.conn, r.change.type, r.change.id)
        if (
          !rec ||
          rec.rev !== r.change.rev ||
          !local ||
          !sameRecordPlain(this.conn, r.change.type, { ...local.plain }, r.plain)
        )
          this.mergeResult(acc, this.applyPlain(r.change.type, r.change.id, r.plain))
        this.putRecord({
          type: r.change.type,
          id: r.change.id,
          scope: r.change.scope,
          rev: r.change.rev,
          seq: r.change.seq,
          deleted: false,
          base: r.plain
        })
      }
      acc.events.push(...normalizeNegativeSeqs(this.conn))
      const r = this.chatRow(chatId)
      const maxSeq = online.reduce((m, x) => Math.max(m, x.change.seq), 0)
      this.setChatRow(chatId, {
        needs_refetch: 0,
        head: Math.max(r.head, maxSeq),
        base_head: Math.max(r.head, maxSeq)
      })
    })
    this.flushApply(acc)
  }

  // ---------------- divergência (§9) ----------------

  async divergence(chatId: string): Promise<DivergenceDetails> {
    const online = await this.fetchChatRecords(chatId)
    const ver: DivergenceVersion = { sessions: [], messages: {} }
    for (const r of online) {
      if (!r.plain) continue
      // com parentId/branchSel: o visualizador mostra o caminho ativo de cada versão
      if (r.change.type === 'session')
        ver.sessions.push({ ...sessionFromPlain(r.change.id, r.plain, chatId), status: 'idle' })
      else {
        const m = messageFromPlain(r.change.id, r.plain)
        ;(ver.messages[m.sessionId] ??= []).push(m)
      }
    }
    for (const list of Object.values(ver.messages)) list.sort((a, b) => a.seq - b.seq)
    ver.sessions.sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt)
    let local: DivergenceVersion | null = null
    if (this.host.isDivergedSelf(chatId)) {
      local = { sessions: [], messages: {} }
      const sess = this.conn
        .prepare('SELECT id FROM sessions WHERE chat_id = ? ORDER BY depth, created_at')
        .all(chatId) as { id: string }[]
      for (const s of sess) {
        const row = buildLocal(this.conn, 'session', s.id)
        if (!row) continue
        local.sessions.push({ ...sessionFromPlain(s.id, row.plain, chatId), status: 'idle' })
        const msgs = this.conn
          .prepare('SELECT id FROM messages WHERE session_id = ? ORDER BY seq')
          .all(s.id) as { id: string }[]
        local.messages[s.id] = msgs
          .map((m) => rowMessage(this.conn, m.id))
          .filter(Boolean) as StoredMessage[]
      }
    }
    const sig = (m: StoredMessage): string => `${m.id}:${canonical(m.message)}`
    const flat = (v: DivergenceVersion | null): StoredMessage[] =>
      v ? Object.values(v.messages).flat() : []
    const onlineMsgs = flat(ver)
    const localMsgs = flat(local)
    const oSet = new Set(onlineMsgs.map(sig))
    const lSet = new Set(localMsgs.map(sig))
    const onlyOnline = onlineMsgs.filter((m) => !lSet.has(sig(m)))
    const onlyLocal = localMsgs.filter((m) => !oSet.has(sig(m)))
    const since = (l: StoredMessage[]): number | null =>
      l.length ? Math.min(...l.map((m) => m.createdAt)) : null
    return {
      chatId,
      online: ver,
      local,
      onlyOnline: { count: local ? onlyOnline.length : 0, since: local ? since(onlyOnline) : null },
      onlyLocal: { count: onlyLocal.length, since: since(onlyLocal) }
    }
  }

  async resolveDivergence(chatId: string, keep: 'online' | 'local'): Promise<void> {
    const d = this.host.divergedState(chatId)
    if (!d) throw new Error('Este chat não está divergente.')
    if (keep === 'online') {
      const r = await this.http.post<{ state?: Record<string, unknown> }>(
        `/api/v1/chats/${encodeURIComponent(chatId)}/divergence/resolve`,
        { divergence_id: d.divergence_id, keep: 'online' }
      )
      this.host.clearDiverged(chatId)
      if (r?.state) this.host.onChatState(r.state, false)
      if (d.device_id === this.deviceId) await this.discardLocalVersion(chatId)
      return
    }
    if (d.device_id !== this.deviceId)
      throw new Error('Só o dispositivo com a versão divergente pode mantê-la.')
    const online = await this.fetchChatRecords(chatId)
    const onlineMap = new Map(online.map((r) => [key(r.change.type, r.change.id), r]))
    const items: PushItem[] = []
    const meta: ItemMeta[] = []
    const add = (type: string, id: string, scope: string | null, plain: Plain | null): void => {
      const o = onlineMap.get(key(type, id))
      const baseRev = o
        ? o.change.rev
        : this.record(type, id)?.deleted
          ? this.record(type, id)!.rev
          : 0
      if (plain && o?.plain && sameRecordPlain(this.conn, type, plain, o.plain)) return
      if (!plain && !o) return
      const rev = baseRev + 1
      const item: PushItem = plain
        ? {
            type,
            id,
            scope,
            base_rev: baseRev,
            rev,
            deleted: false,
            env: this.encryptRecord(type, id, scope, rev, plain),
            blobs: []
          }
        : { type, id, scope, base_rev: baseRev, rev, deleted: true, blobs: [] }
      items.push(item)
      const mark =
        (
          this.conn
            .prepare('SELECT mark FROM sync_dirty WHERE type = ? AND id = ?')
            .get(type, id) as { mark: number } | undefined
        )?.mark ?? 0
      meta.push({ type, id, scope, rev, mark, deleted: !plain, plain })
    }
    const localIds = new Set<string>()
    const sess = this.conn
      .prepare('SELECT id FROM sessions WHERE chat_id = ? ORDER BY depth, created_at')
      .all(chatId) as { id: string }[]
    const blobShas = new Map<string, string[]>()
    for (const s of sess) {
      const l = buildLocal(this.conn, 'session', s.id)
      if (l) {
        localIds.add(key('session', s.id))
        add('session', s.id, chatId, l.plain)
      }
      const msgs = this.conn.prepare('SELECT id FROM messages WHERE session_id = ?').all(s.id) as {
        id: string
      }[]
      for (const m of msgs) {
        const lm = buildLocal(this.conn, 'message', m.id)
        if (!lm) continue
        localIds.add(key('message', m.id))
        if (lm.shas?.length) blobShas.set(key('message', m.id), lm.shas)
        add('message', m.id, chatId, lm.plain)
      }
    }
    for (const r of online)
      if (!localIds.has(key(r.change.type, r.change.id)))
        add(r.change.type, r.change.id, chatId, null)
    const ok = await this.ensureBlobs(blobShas)
    for (const it of items) {
      const shas = blobShas.get(key(it.type, it.id))
      if (shas && this.sk)
        it.blobs = shas.map((s) => blobIdFromSha256(this.sk!, fromHex(s))).filter((b) => ok.has(b))
    }
    items.sort(CONTENT_ORDER)
    // limites do push (≤ 500 itens, §7.4): o resolve leva o primeiro pedaço (já na ordem pais →
    // filhos) — isso limpa a divergência e faz deste dispositivo a base —; o resto vira conteúdo
    // pendente comum e sai pelo push normal (lotes com o chat_bases do momento do envio)
    let n = 0
    let size = 0
    for (; n < items.length; n++) {
      const bytes = items[n].env ? items[n].env!.c.length : 64
      if (n && (n >= MAX_ITEMS || size + bytes > MAX_BATCH_BYTES)) break
      size += bytes
    }
    const first = items.slice(0, n)
    const rest = items.slice(n)
    const metaOf = new Map(meta.map((m) => [key(m.type, m.id), m]))
    const res = await this.http.post<{
      results?: { type: string; id: string; rev: number; seq: number }[]
      head?: number
      chat_heads?: Record<string, number>
      state?: Record<string, unknown>
    }>(`/api/v1/chats/${encodeURIComponent(chatId)}/divergence/resolve`, {
      divergence_id: d.divergence_id,
      keep: 'local',
      push_id: randomUUID(),
      items: first
    })
    this.conn.transaction(() => {
      this.commitBatch(
        first.map((it) => metaOf.get(key(it.type, it.id))!),
        { results: res?.results ?? [], head: res?.head ?? 0, chat_heads: res?.chat_heads ?? {} },
        chatId
      )
      this.conn
        .prepare("DELETE FROM sync_dirty WHERE scope = ? AND type IN ('session', 'message')")
        .run(chatId)
      // o resto já está nas tabelas locais: o registro passa a ser o online (rev/plaintext que o
      // resolve usaria como base) e a marca dirty manda o buildBatches transformá-lo no local
      for (const it of rest) {
        const o = onlineMap.get(key(it.type, it.id))
        if (o)
          this.putRecord({
            type: it.type,
            id: it.id,
            scope: o.change.scope,
            rev: o.change.rev,
            seq: o.change.seq,
            deleted: false,
            base: o.plain
          })
        else if (it.base_rev === 0)
          this.conn
            .prepare('DELETE FROM sync_records WHERE type = ? AND id = ?')
            .run(it.type, it.id)
        this.markDirty(it.type, it.id, chatId)
      }
      const h = res?.chat_heads?.[chatId] ?? res?.head
      if (h) this.setChatRow(chatId, { head: h, base_head: h, needs_refetch: 0 })
    })()
    if (rest.length) this.log('divergência: resolve em partes', first.length, '+', rest.length)
    this.host.clearDiverged(chatId)
    if (res?.state) this.host.onChatState(res.state, false)
    this.scheduleCycle(0)
  }

  /** A versão local divergente foi descartada: apaga e baixa a online (§9.3). */
  async discardLocalVersion(chatId: string): Promise<void> {
    this.host.clearDiverged(chatId)
    await this.replaceContentWithOnline(chatId, true)
    this.emit({
      type: 'sync-notice',
      kind: 'info',
      text: 'A versão deste dispositivo foi descartada; o chat agora mostra a versão online.',
      chatId
    })
  }

  // ---------------- merge do primeiro login (§12) ----------------

  private localHasData(): boolean {
    const n = (sql: string): number => (this.conn.prepare(sql).get() as { n: number }).n
    if (n('SELECT COUNT(*) AS n FROM providers')) return true
    if (n('SELECT COUNT(*) AS n FROM chats')) return true
    if (n('SELECT COUNT(*) AS n FROM memories')) return true
    if (n('SELECT COUNT(*) AS n FROM memory_collections')) return true
    const presets = this.conn.prepare('SELECT name, config_json FROM presets').all() as {
      name: string
      config_json: string
    }[]
    // a persona "Padrão" semeada (config vazia) não conta
    return presets.some((p) => !(p.name === 'Padrão' && (p.config_json === '{}' || !p.config_json)))
  }

  private async afterUnlock(): Promise<void> {
    if (this.kv('merge_done') === '1') {
      this.start()
      return
    }
    await this.enterMerge()
  }

  private async enterMerge(): Promise<void> {
    this.connection = 'connecting'
    this.emitStatus()
    const account = await this.http.get<{ usage?: { records?: number } }>('/api/v1/account')
    const onlineRecords = account?.usage?.records ?? 0
    if (onlineRecords === 0) return this.runMerge('local')
    if (!this.localHasData()) return this.runMerge('online')
    const snap = await this.downloadAll()
    this.mergeSnapshot = snap
    this.mergeInfo = this.computeMergeInfo(snap)
    this.connection = 'online'
    this.emitStatus()
  }

  async resolveMerge(priority: 'online' | 'local'): Promise<SyncStatus> {
    if (this.phase() !== 'merge') throw new Error('Não há merge pendente.')
    await this.runMerge(priority)
    return this.status()
  }

  private async downloadAll(): Promise<OnlineSnapshot> {
    const records = new Map<string, DownloadedRecord>()
    let head = 0
    let since = 0
    try {
      for (;;) {
        const r = await this.http.get<{
          changes: Change[]
          next: number
          has_more: boolean
          head: number
        }>(`/api/v1/sync/changes?since=${since}&limit=1000&payload=1`)
        await this.fillOmitted(r.changes ?? [])
        for (const c of r.changes ?? []) records.set(key(c.type, c.id), { change: c, plain: null })
        head = Math.max(head, r.head ?? 0)
        since = r.next ?? since
        if (!r.has_more) break
      }
    } catch (e) {
      if (!(e instanceof SyncApiError && e.code === 'cursor_expired')) throw e
      const all = await this.downloadRecords()
      head = all.head
      records.clear()
      for (const c of all.changes) records.set(key(c.type, c.id), { change: c, plain: null })
    }
    for (const r of records.values()) {
      if (r.change.deleted || !isRecordType(r.change.type)) continue
      try {
        r.plain = this.decryptChange(r.change)
      } catch (e) {
        this.log('merge: não decifrou', r.change.type, r.change.id, errMsg(e))
      }
    }
    const st = await this.http.get<{
      chat_states?: Record<string, unknown>[]
      state_cursor?: number
    }>('/api/v1/chat-states?since=0')
    return { records, head, states: st.chat_states ?? [], stateCursor: st.state_cursor ?? 0 }
  }

  private onlineOf(snap: OnlineSnapshot, type: string): DownloadedRecord[] {
    return [...snap.records.values()].filter((r) => r.change.type === type)
  }

  private computeMergeInfo(snap: OnlineSnapshot): SyncMergeInfo {
    const n = (sql: string): number => (this.conn.prepare(sql).get() as { n: number }).n
    const live = (t: string): number =>
      this.onlineOf(snap, t).filter((r) => !r.change.deleted).length
    return {
      local: {
        providers: n('SELECT COUNT(*) AS n FROM providers'),
        chats: n('SELECT COUNT(*) AS n FROM chats'),
        presets: n('SELECT COUNT(*) AS n FROM presets'),
        memories: n('SELECT COUNT(*) AS n FROM memories')
      },
      online: {
        providers: live('provider'),
        chats: live('chat'),
        presets: live('preset'),
        memories: live('memory')
      },
      conflictingChats: this.conflictingChats(snap).length
    }
  }

  /** Chats com o mesmo id nos dois lados e histórias diferentes. */
  private conflictingChats(snap: OnlineSnapshot): string[] {
    const out: string[] = []
    for (const r of this.onlineOf(snap, 'chat')) {
      if (r.change.deleted || !existsLocal(this.conn, 'chat', r.change.id)) continue
      if (!this.sameContent(snap, r.change.id)) out.push(r.change.id)
    }
    return out
  }

  private sameContent(snap: OnlineSnapshot, chatId: string): boolean {
    const online = [...snap.records.values()].filter(
      (r) => isContent(r.change.type) && r.change.scope === chatId && !r.change.deleted
    )
    const localIds = [
      ...(
        this.conn.prepare('SELECT id FROM sessions WHERE chat_id = ?').all(chatId) as {
          id: string
        }[]
      ).map((r) => key('session', r.id)),
      ...(
        this.conn
          .prepare(
            'SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.chat_id = ?'
          )
          .all(chatId) as { id: string }[]
      ).map((r) => key('message', r.id))
    ]
    if (localIds.length !== online.length) return false
    for (const r of online) {
      const l = buildLocal(this.conn, r.change.type, r.change.id)
      if (!l || !r.plain) return false
      const strip = (p: Plain): Plain => {
        const x = { ...p }
        if (r.change.type === 'session') delete x.status
        return x
      }
      if (!sameRecordPlain(this.conn, r.change.type, strip(l.plain), strip(r.plain))) return false
    }
    return true
  }

  /** Executa o merge do primeiro login. */
  private async runMerge(priority: 'online' | 'local'): Promise<void> {
    const snap = this.mergeSnapshot ?? (await this.downloadAll())
    this.mergeSnapshot = null
    const acc: ApplyResult = { events: [], scopes: new Set(), redirty: [] }
    const conflicting = new Set(this.conflictingChats(snap))
    withApply(this.conn, () => {
      // 1) deduplicação local → online (id canônico = o online)
      const remap = this.dedupe(snap)
      this.applyRemap(remap)
      // 2) conteúdo vencedor por registro
      const online = [...snap.records.values()].sort((a, b) => {
        const order = [
          'setting',
          'provider',
          'preset',
          'memory_collection',
          'memory',
          'chat',
          'session',
          'message'
        ]
        const oa = order.indexOf(a.change.type)
        const ob = order.indexOf(b.change.type)
        if (oa !== ob) return oa - ob
        if (a.change.type === 'session')
          return (
            Number((a.plain as { depth?: number })?.depth ?? 0) -
            Number((b.plain as { depth?: number })?.depth ?? 0)
          )
        return a.change.seq - b.change.seq
      })
      // chats com histórias diferentes e prioridade online: apaga o conteúdo local antes
      if (priority === 'online') {
        for (const chatId of conflicting) {
          const sess = this.conn
            .prepare('SELECT id FROM sessions WHERE chat_id = ? ORDER BY depth DESC')
            .all(chatId) as { id: string }[]
          for (const s of sess) this.mergeResult(acc, deleteLocal(this.conn, 'session', s.id))
        }
      }
      for (const r of online) {
        const c = r.change
        if (!isRecordType(c.type)) {
          this.putRecord({ ...c, deleted: c.deleted, base: null, opaque: c })
          continue
        }
        if (c.type === 'skill') {
          // skills não entram no merge (opt-in, §13): só o registro (aparece em "Skills na nuvem")
          this.putRecord({
            type: c.type,
            id: c.id,
            scope: c.scope,
            rev: c.rev,
            seq: c.seq,
            deleted: c.deleted,
            base: r.plain
          })
          continue
        }
        const exists = existsLocal(this.conn, c.type, c.id)
        const contentOfConflict = isContent(c.type) && c.scope && conflicting.has(c.scope)
        if (c.deleted) {
          if (exists && c.type !== 'setting') {
            if (priority === 'online') this.mergeResult(acc, deleteLocal(this.conn, c.type, c.id))
            else this.markDirty(c.type, c.id, c.scope)
          }
          this.putRecord({
            type: c.type,
            id: c.id,
            scope: c.scope,
            rev: c.rev,
            seq: c.seq,
            deleted: true,
            base: null
          })
          continue
        }
        if (!r.plain) continue
        let useOnline: boolean
        if (contentOfConflict && priority === 'local') useOnline = false
        else if (!exists) useOnline = true
        else if (isContent(c.type)) useOnline = !contentOfConflict || priority === 'online'
        else if (c.type === 'setting')
          useOnline =
            priority === 'online' ||
            (buildLocal(this.conn, 'setting', c.id)?.plain.value ?? null) === null
        else useOnline = priority === 'online'
        if (useOnline) {
          try {
            this.mergeResult(acc, this.applyPlain(c.type, c.id, r.plain))
          } catch (e) {
            this.log('merge: não aplicou', c.type, c.id, errMsg(e))
            continue
          }
        } else {
          this.markDirty(c.type, c.id, c.scope)
        }
        this.putRecord({
          type: c.type,
          id: c.id,
          scope: c.scope,
          rev: c.rev,
          seq: c.seq,
          deleted: false,
          base: r.plain
        })
      }
      // prioridade local em chats conflitantes: o que só existe online vira tombstone
      if (priority === 'local') {
        for (const r of online) {
          if (!isContent(r.change.type) || r.change.deleted || !r.change.scope) continue
          if (!conflicting.has(r.change.scope)) continue
          if (!existsLocal(this.conn, r.change.type, r.change.id))
            this.markDirty(r.change.type, r.change.id, r.change.scope)
        }
      }
      // 3) tudo que é local e não tem registro online → envio
      for (const type of [
        'provider',
        'preset',
        'memory_collection',
        'memory',
        'chat',
        'session',
        'message',
        'setting'
      ] as RecordType[]) {
        for (const id of listLocalIds(this.conn, type)) {
          const rec = this.record(type, id)
          if (!rec) {
            const l = buildLocal(this.conn, type, id)
            this.markDirty(type, id, l?.scope ?? null)
          } else if (!rec.deleted && priority === 'local') {
            const l = buildLocal(this.conn, type, id, this.chatExtra(type, id))
            const base = this.basePlain(rec)
            if (l && !sameRecordPlain(this.conn, type, { ...(base ?? {}), ...l.plain }, base))
              this.markDirty(type, id, l.scope)
          }
        }
      }
      acc.events.push(...normalizeNegativeSeqs(this.conn))
      // 4) heads / estados
      const heads = new Map<string, number>()
      for (const r of online)
        if (isContent(r.change.type) && r.change.scope)
          heads.set(r.change.scope, Math.max(heads.get(r.change.scope) ?? 0, r.change.seq))
      for (const s of snap.states) {
        const cid = String(s.chat_id)
        heads.set(cid, Math.max(heads.get(cid) ?? 0, Number(s.head ?? 0)))
      }
      for (const [cid, h] of heads) this.setChatRow(cid, { head: h, base_head: h })
      this.setKv('cursor', snap.head)
      this.setKv('state_cursor', snap.stateCursor)
      this.setKv('merge_done', 1)
    })
    for (const s of snap.states) this.host.onChatState(s, false)
    for (const r of acc.redirty) this.markDirty(r.type, r.id)
    this.mergeInfo = null
    setTracking(this.conn, true)
    acc.scopes.add('providers')
    acc.scopes.add('presets')
    acc.scopes.add('settings')
    acc.scopes.add('chats')
    acc.scopes.add('memory')
    this.flushApply(acc)
    this.start()
    this.emitStatus()
  }

  /** Mapa id local → id online das entidades deduplicadas (§12.4). */
  private dedupe(snap: OnlineSnapshot): Map<string, string> {
    const remap = new Map<string, string>()
    const used = new Set<string>()
    const live = (t: string): DownloadedRecord[] =>
      this.onlineOf(snap, t).filter((r) => !r.change.deleted && r.plain)
    const pick = (
      type: string,
      localId: string,
      cands: DownloadedRecord[],
      match: (p: Plain) => boolean
    ): void => {
      if (snap.records.has(key(type, localId))) return // mesmo id: mesma entidade
      const hit = cands.find(
        (r) =>
          !used.has(key(type, r.change.id)) &&
          !existsLocal(this.conn, type, r.change.id) &&
          match(r.plain!)
      )
      if (!hit) return
      used.add(key(type, hit.change.id))
      remap.set(key(type, localId), hit.change.id)
    }
    for (const id of listLocalIds(this.conn, 'provider')) {
      const l = buildLocal(this.conn, 'provider', id)!.plain
      pick(
        'provider',
        id,
        live('provider'),
        (p) =>
          normBase(p.baseUrl) === normBase(l.baseUrl) &&
          (normName(p.name) === normName(l.name) || (!!l.apiKey && p.apiKey === l.apiKey))
      )
    }
    for (const id of listLocalIds(this.conn, 'preset')) {
      const l = buildLocal(this.conn, 'preset', id)!.plain
      pick(
        'preset',
        id,
        live('preset'),
        (p) =>
          normName(p.name) === normName(l.name) &&
          canonical(p.config ?? {}) === canonical(l.config ?? {})
      )
    }
    for (const id of listLocalIds(this.conn, 'memory_collection')) {
      const l = buildLocal(this.conn, 'memory_collection', id)!.plain
      pick(
        'memory_collection',
        id,
        live('memory_collection'),
        (p) => p.category === l.category && normName(p.name) === normName(l.name)
      )
    }
    for (const id of listLocalIds(this.conn, 'memory')) {
      const l = buildLocal(this.conn, 'memory', id)!.plain
      const col = remap.get(key('memory_collection', String(l.collectionId))) ?? l.collectionId
      pick(
        'memory',
        id,
        live('memory'),
        (p) => p.collectionId === col && normName(p.title) === normName(l.title)
      )
    }
    return remap
  }

  /** Troca ids locais deduplicados pelos online e remapeia as referências (§12.5). */
  private applyRemap(remap: Map<string, string>): void {
    if (!remap.size) return
    // troca de ids com filhos (coleção → memórias): checagem de FK só no commit
    this.conn.pragma('defer_foreign_keys = ON')
    const get = (type: string, id: unknown): string | undefined =>
      typeof id === 'string' ? remap.get(key(type, id)) : undefined
    const db = this.conn
    for (const [k, newId] of remap) {
      const [type, oldId] = k.split('|')
      const table: Record<string, string> = {
        provider: 'providers',
        preset: 'presets',
        memory_collection: 'memory_collections',
        memory: 'memories'
      }
      // a entidade local vira a online (o conteúdo é decidido depois pela prioridade)
      db.prepare(`UPDATE ${table[type]} SET id = ? WHERE id = ?`).run(newId, oldId)
      if (type === 'memory_collection') {
        db.prepare('UPDATE memories SET collection_id = ? WHERE collection_id = ?').run(
          newId,
          oldId
        )
      }
      if (type === 'memory')
        db.prepare('UPDATE memories SET supersedes_id = ? WHERE supersedes_id = ?').run(
          newId,
          oldId
        )
      if (type === 'provider')
        db.prepare('UPDATE sessions SET provider_id = ? WHERE provider_id = ?').run(newId, oldId)
    }
    const remapConfig = (cfg: Plain): boolean => {
      let changed = false
      const set = (obj: Plain, k: string, type: string): void => {
        const n = get(type, obj[k])
        if (n) {
          obj[k] = n
          changed = true
        }
      }
      set(cfg, 'providerId', 'provider')
      set(cfg, 'presetId', 'preset')
      if (cfg.smartApprove && typeof cfg.smartApprove === 'object') {
        const sa = cfg.smartApprove as Plain
        set(sa, 'providerId', 'provider')
        // modelo do resumo (coleta de contexto, desde 0.8.5)
        if (sa.capture && typeof sa.capture === 'object')
          set(sa.capture as Plain, 'providerId', 'provider')
      }
      // modelo da chamada de voz (1.5.0: `voice` sincroniza)
      const voice = cfg.voice as Plain | undefined
      if (voice && typeof voice === 'object' && voice.model && typeof voice.model === 'object')
        set(voice.model as Plain, 'providerId', 'provider')
      const mem = cfg.memory as Plain | undefined
      if (mem && typeof mem === 'object') {
        if (mem.extraction && typeof mem.extraction === 'object')
          set(mem.extraction as Plain, 'providerId', 'provider')
        if (Array.isArray(mem.collections))
          mem.collections = (mem.collections as unknown[]).map((c) => {
            const n = get('memory_collection', c)
            if (n) changed = true
            return n ?? c
          })
        if (mem.writeTo && typeof mem.writeTo === 'object')
          for (const cat of Object.keys(mem.writeTo as Plain))
            set(mem.writeTo as Plain, cat, 'memory_collection')
      }
      return changed
    }
    for (const table of ['chats', 'presets']) {
      const rows = db.prepare(`SELECT id, config_json FROM ${table}`).all() as {
        id: string
        config_json: string
      }[]
      for (const r of rows) {
        let cfg: Plain
        try {
          cfg = JSON.parse(r.config_json) as Plain
        } catch {
          continue
        }
        if (remapConfig(cfg))
          db.prepare(`UPDATE ${table} SET config_json = ? WHERE id = ?`).run(
            JSON.stringify(cfg),
            r.id
          )
      }
    }
    // settings com provedor dentro do objeto (1.4.0): smartApproveDefaults.capture e autoTitle;
    // (1.5.0) o provedor da transcrição/fala e o modelo padrão da chamada de voz
    for (const [sk, path] of [
      ['smartApproveDefaults', ['capture']],
      ['autoTitle', []],
      ['sttSettings', ['api']],
      ['ttsSettings', ['api']],
      ['voiceCallDefaults', ['model']]
    ] as [string, string[]][]) {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(sk) as
        { value: string } | undefined
      if (!r) continue
      try {
        const v = JSON.parse(r.value) as Plain
        let obj: unknown = v
        for (const k of path) obj = (obj as Plain | undefined)?.[k]
        if (!obj || typeof obj !== 'object') continue
        const n = get('provider', (obj as Plain).providerId)
        if (!n) continue
        ;(obj as Plain).providerId = n
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(v), sk)
      } catch {
        /* */
      }
    }
    for (const [sk, type] of [
      ['defaultProviderId', 'provider'],
      ['defaultPresetId', 'preset']
    ]) {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(sk) as
        { value: string } | undefined
      if (!r) continue
      try {
        const n = get(type, JSON.parse(r.value))
        if (n) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(n), sk)
      } catch {
        /* */
      }
    }
  }

  // ---------------- anexos (blobs, §14) ----------------

  blobIdForSha(sha: string): string {
    if (!this.sk) throw new Error('Conta bloqueada.')
    const r = this.conn.prepare('SELECT blob_id FROM sync_blobs WHERE sha256 = ?').get(sha) as
      { blob_id: string } | undefined
    if (r) return r.blob_id
    const id = blobIdFromSha256(this.sk, fromHex(sha))
    this.conn
      .prepare('INSERT OR IGNORE INTO sync_blobs (sha256, blob_id, uploaded) VALUES (?, ?, 0)')
      .run(sha, id)
    return id
  }

  /** Arquivo do store para um sha256 (qualquer extensão). */
  private storeFileFor(sha: string): string | null {
    try {
      const dir = attachmentsDir()
      for (const f of readdirSync(dir))
        if (f.startsWith(sha) && ATTACHMENT_FILE_RE.test(f)) return join(dir, f)
    } catch {
      /* sem store */
    }
    return null
  }

  /** Garante os blobs dos anexos no servidor. Retorna os ids presentes (os sem arquivo ficam de fora). */
  async ensureBlobs(shasByRecord: Map<string, string[]>): Promise<Set<string>> {
    const shas = new Set<string>()
    for (const l of shasByRecord.values()) for (const s of l) shas.add(s)
    const ok = new Set<string>()
    if (!shas.size || !this.sk) return ok
    const byId = new Map<string, string>()
    for (const s of shas) {
      const id = this.blobIdForSha(s)
      const r = this.conn.prepare('SELECT uploaded FROM sync_blobs WHERE sha256 = ?').get(s) as {
        uploaded: number
      }
      if (r?.uploaded) ok.add(id)
      else byId.set(id, s)
    }
    if (!byId.size) return ok
    const ids = [...byId.keys()]
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000)
      const r = await this.http.post<{ present: string[]; missing: string[] }>(
        '/api/v1/blobs/check',
        { ids: part }
      )
      for (const id of r.present ?? []) {
        ok.add(id)
        this.conn.prepare('UPDATE sync_blobs SET uploaded = 1 WHERE blob_id = ?').run(id)
      }
      for (const id of r.missing ?? []) {
        const sha = byId.get(id)!
        if (await this.uploadAttachment(sha, id)) ok.add(id)
      }
    }
    return ok
  }

  private async uploadBlobIds(ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = this.conn.prepare('SELECT sha256 FROM sync_blobs WHERE blob_id = ?').get(id) as
        { sha256: string } | undefined
      if (r) await this.uploadAttachment(r.sha256, id)
    }
  }

  private async uploadAttachment(sha: string, blobId: string): Promise<boolean> {
    if (!this.sk) return false
    const file = this.storeFileFor(sha)
    if (!file) return false
    const data = new Uint8Array(readFileSync(file))
    if (hex(sha256(data)) !== sha) return false
    await this.putBlob(blobId, data)
    this.conn.prepare('UPDATE sync_blobs SET uploaded = 1 WHERE blob_id = ?').run(blobId)
    return true
  }

  async putBlob(blobId: string, plaintext: Uint8Array): Promise<void> {
    if (!this.sk) throw new Error('Conta bloqueada.')
    const ct = encryptBlob(this.sk, this.userId, blobId, plaintext)
    await this.http.req('PUT', `/api/v1/blobs/${blobId}`, {
      body: ct,
      headers: { 'X-Content-SHA256': hex(sha256(ct)) },
      timeoutMs: 10 * 60_000
    })
  }

  async getBlob(blobId: string): Promise<Uint8Array> {
    if (!this.sk) throw new Error('Conta bloqueada.')
    const ct = await this.http.req<Uint8Array>('GET', `/api/v1/blobs/${blobId}`, {
      binary: true,
      timeoutMs: 10 * 60_000
    })
    return decryptBlob(this.sk, this.userId, blobId, ct)
  }

  private downloading = new Map<string, Promise<boolean>>()

  /** Baixa um anexo ausente (`<sha256>.<ext>`) do servidor. true = disponível no store. */
  ensureAttachment(file: string): Promise<boolean> {
    if (!ATTACHMENT_FILE_RE.test(file)) return Promise.resolve(false)
    try {
      if (existsSync(join(attachmentsDir(), file))) return Promise.resolve(true)
    } catch {
      return Promise.resolve(false)
    }
    if (!this.sk || this.phase() !== 'ready') return Promise.resolve(false)
    const cur = this.downloading.get(file)
    if (cur) return cur
    const p = (async () => {
      const sha = file.slice(0, 64)
      const ext = file.includes('.') ? file.slice(65) : ''
      try {
        const data = await this.getBlob(this.blobIdForSha(sha))
        if (hex(sha256(data)) !== sha) throw new Error('sha256 do anexo não confere')
        if (ext) saveStoreFile(data, ext)
        else return false
        return true
      } catch (e) {
        this.log('anexo não baixado', file, errMsg(e))
        return false
      }
    })().finally(() => this.downloading.delete(file))
    this.downloading.set(file, p)
    return p
  }

  /** Anexos citados no conteúdo de um chat que faltam no store (antes de rodar como host). */
  async prefetchChatAttachments(chatId: string): Promise<void> {
    const rows = this.conn
      .prepare(
        "SELECT m.message_json AS a, m.meta_json AS b FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.chat_id = ? AND (m.message_json LIKE '%clearchat-attachment://%' OR m.meta_json LIKE '%clearchat-attachment://%')"
      )
      .all(chatId) as { a: string; b: string }[]
    const files = new Set<string>()
    for (const r of rows) for (const f of attachmentFiles(`${r.a}\n${r.b}`)) files.add(f)
    await Promise.all([...files].map((f) => this.ensureAttachment(f)))
  }

  // ---------------- skills (§13) ----------------

  private skillRow(name: string):
    | {
        name: string
        record_id: string
        mode: string
        local_dir: string | null
        bundle_sha256: string | null
        rev: number
      }
    | undefined {
    return this.conn.prepare('SELECT * FROM sync_skills WHERE name = ?').get(name) as never
  }

  /** Plaintext do registro skill a partir de sync_skills (null = removida da nuvem). */
  private buildSkillLocal(recordId: string): LocalRecord | null {
    const r = this.conn
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .get(`skill_plain:${recordId}`) as { value: string } | undefined
    if (!r) return null
    try {
      return { scope: null, plain: JSON.parse(r.value) as Plain }
    } catch {
      return null
    }
  }

  /** Lista "Skills na nuvem". */
  cloudSkills(): CloudSkill[] {
    const rows = this.conn
      .prepare("SELECT id, base FROM sync_records WHERE type = 'skill' AND deleted = 0")
      .all() as { id: string; base: string | null }[]
    const out: CloudSkill[] = []
    for (const r of rows) {
      let p: Plain = {}
      try {
        p = r.base ? (JSON.parse(r.base) as Plain) : {}
      } catch {
        /* */
      }
      const name = String(p.name ?? '')
      if (!name) continue
      const b = (p.bundle ?? {}) as { size?: number; files?: number }
      const row = this.skillRow(name)
      out.push({
        name,
        description: String(p.description ?? ''),
        recordId: r.id,
        size: Number(b.size ?? 0),
        files: Number(b.files ?? 0),
        updatedAt: Number(p.updatedAt ?? 0),
        local: (row?.mode as 'source' | 'copy') ?? null
      })
    }
    // skills marcadas aqui mas ainda não aceitas pelo servidor
    for (const s of this.conn.prepare('SELECT * FROM sync_skills').all() as {
      name: string
      record_id: string
      mode: string
    }[]) {
      if (out.some((x) => x.name === s.name)) continue
      const local = this.buildSkillLocal(s.record_id)
      if (!local) continue
      const b = (local.plain.bundle ?? {}) as { size?: number; files?: number }
      out.push({
        name: s.name,
        description: String(local.plain.description ?? ''),
        recordId: s.record_id,
        size: Number(b.size ?? 0),
        files: Number(b.files ?? 0),
        updatedAt: Number(local.plain.updatedAt ?? 0),
        local: s.mode as 'source' | 'copy'
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Nomes das skills sincronizadas a partir desta máquina (pasta de origem). */
  trackedSourceSkills(): string[] {
    return (
      this.conn.prepare("SELECT name FROM sync_skills WHERE mode = 'source'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
  }

  /** Liga/desliga "Sincronizar" de uma skill local (pasta de origem). */
  async setSkillSync(name: string, on: boolean): Promise<void> {
    if (!this.sk) throw new Error('Entre na conta e desbloqueie para sincronizar skills.')
    if (!on) {
      this.conn.prepare('DELETE FROM sync_skills WHERE name = ?').run(name)
      return
    }
    const list = (await this.deps.skills?.list()) ?? []
    const s = list.find((x) => x.name === name)
    if (!s) throw new Error(`Skill não encontrada: ${name}`)
    await this.uploadSkill(name, s.dir, s.description, s.meta, 'source')
  }

  private async uploadSkill(
    name: string,
    dir: string,
    description: string,
    meta: unknown,
    mode: 'source' | 'copy'
  ): Promise<void> {
    if (!this.sk) return
    const built = await buildBundle(dir, name)
    const recordId = skillRecordId(this.sk, name)
    const blobId = blobIdFromSha256(this.sk, sha256(built.plaintext))
    await this.putBlob(blobId, built.plaintext)
    const plain: Plain = {
      sv: 1,
      name,
      description,
      ...(meta ? { meta } : {}),
      bundle: { blobId, sha256: built.sha256, size: built.size, files: built.files },
      updatedAt: Date.now()
    }
    this.setKv(`skill_plain:${recordId}`, JSON.stringify(plain))
    this.conn
      .prepare(
        `INSERT INTO sync_skills (name, record_id, mode, local_dir, bundle_sha256, rev) VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(name) DO UPDATE SET record_id = excluded.record_id, mode = excluded.mode, local_dir = excluded.local_dir,
         bundle_sha256 = excluded.bundle_sha256`
      )
      .run(name, recordId, mode, dir, built.contentHash)
    this.markDirty('skill', recordId)
    this.schedulePush()
  }

  /** Reescaneia as skills acompanhadas: mudou (hash do conteúdo) → nova revisão. */
  async checkTrackedSkills(): Promise<void> {
    if (!this.sk || this.skillsBusy) return
    this.skillsBusy = (async () => {
      const rows = this.conn.prepare('SELECT * FROM sync_skills').all() as {
        name: string
        mode: string
        local_dir: string | null
        bundle_sha256: string | null
        record_id: string
      }[]
      for (const r of rows) {
        if (!r.local_dir) continue
        const h = await folderContentHash(r.local_dir)
        if (!h) continue
        if (h !== r.bundle_sha256) {
          const local = this.buildSkillLocal(r.record_id)
          await this.uploadSkill(
            r.name,
            r.local_dir,
            String(local?.plain.description ?? ''),
            local?.plain.meta,
            r.mode as 'source' | 'copy'
          )
        }
      }
    })().finally(() => (this.skillsBusy = null))
    return this.skillsBusy
  }

  /** "Baixar" / "Baixar todas": extrai em synced-skills/<nome> e passa a acompanhar. */
  async downloadSkills(names?: string[]): Promise<number> {
    if (!this.sk || !this.deps.skills) throw new Error('Conta bloqueada.')
    let n = 0
    for (const s of this.cloudSkills()) {
      if (names && !names.includes(s.name)) continue
      if (s.local === 'source') continue
      await this.installSkillCopy(s.recordId)
      n++
    }
    this.deps.skills.changed()
    return n
  }

  private async installSkillCopy(recordId: string): Promise<void> {
    if (!this.sk || !this.deps.skills) return
    const rec = this.record('skill', recordId)
    const p = this.basePlain(rec)
    if (!p) return
    const name = String(p.name ?? '')
    const b = (p.bundle ?? {}) as { blobId?: string; sha256?: string }
    if (!name || !b.blobId || /[\\/]/.test(name) || name.startsWith('.')) return
    const data = await this.getBlob(b.blobId)
    if (b.sha256 && hex(sha256(data)) !== b.sha256) throw new Error('Bundle da skill corrompido.')
    const bundle = parseBundle(data)
    const target = join(this.deps.skills.syncedDir, name)
    const row = this.skillRow(name)
    // cópia editada localmente e remoto mudou → o remoto vence; a local vai para .conflicts
    if (row?.mode === 'copy' && row.local_dir) {
      const h = await folderContentHash(row.local_dir)
      if (h && row.bundle_sha256 && h !== row.bundle_sha256) {
        const { cpSync } = await import('node:fs')
        const dest = join(this.deps.skills.syncedDir, '.conflicts', `${name}-${Date.now()}`)
        cpSync(row.local_dir, dest, { recursive: true })
      }
    }
    const contentHash = await extractBundle(bundle, target)
    this.setKv(`skill_plain:${recordId}`, JSON.stringify(p))
    this.conn
      .prepare(
        `INSERT INTO sync_skills (name, record_id, mode, local_dir, bundle_sha256, rev) VALUES (?, ?, 'copy', ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET record_id = excluded.record_id, mode = 'copy', local_dir = excluded.local_dir,
         bundle_sha256 = excluded.bundle_sha256, rev = excluded.rev`
      )
      .run(name, recordId, target, contentHash, rec?.rev ?? 0)
  }

  /** Registro skill remoto mudou: cópias acompanhadas atualizam sozinhas; tombstone apaga a cópia. */
  private async onRemoteSkill(recordId: string, plain: Plain | null): Promise<void> {
    const row = this.conn.prepare('SELECT * FROM sync_skills WHERE record_id = ?').get(recordId) as
      { name: string; mode: string; local_dir: string | null } | undefined
    if (!plain) {
      this.conn.prepare(`DELETE FROM sync_state WHERE key = ?`).run(`skill_plain:${recordId}`)
      if (
        row?.mode === 'copy' &&
        row.local_dir &&
        this.deps.skills &&
        row.local_dir.startsWith(this.deps.skills.syncedDir)
      ) {
        const { rmSync } = await import('node:fs')
        rmSync(row.local_dir, { recursive: true, force: true })
      }
      if (row) this.conn.prepare('DELETE FROM sync_skills WHERE record_id = ?').run(recordId)
      this.deps.skills?.changed()
      this.emit({ type: 'sync-data-changed', scopes: ['skills'] })
      return
    }
    if (row?.mode === 'copy') {
      await this.installSkillCopy(recordId)
      this.deps.skills?.changed()
    } else if (row?.mode === 'source') {
      // a origem é desta máquina: o remoto (outra cópia editada) vence só se a pasta não mudou
      this.setKv(`skill_plain:${recordId}`, JSON.stringify(plain))
    }
    this.emit({ type: 'sync-data-changed', scopes: ['skills'] })
  }

  /** "Remover da nuvem": tombstone; cópias baixadas são apagadas, pastas de origem nunca. */
  async removeCloudSkill(name: string): Promise<void> {
    const s = this.cloudSkills().find((x) => x.name === name)
    if (!s) return
    this.conn.prepare('DELETE FROM sync_state WHERE key = ?').run(`skill_plain:${s.recordId}`)
    const row = this.skillRow(name)
    if (
      row?.mode === 'copy' &&
      row.local_dir &&
      this.deps.skills &&
      row.local_dir.startsWith(this.deps.skills.syncedDir)
    ) {
      const { rmSync } = await import('node:fs')
      rmSync(row.local_dir, { recursive: true, force: true })
      this.deps.skills.changed()
    }
    this.conn.prepare('DELETE FROM sync_skills WHERE name = ?').run(name)
    this.markDirty('skill', s.recordId)
    this.schedulePush()
  }

  /** "Parar de sincronizar" (só local): para de acompanhar; a cópia baixada fica como está. */
  stopTrackingSkill(name: string): void {
    this.conn.prepare('DELETE FROM sync_skills WHERE name = ?').run(name)
  }

  // ---------------- WebSocket ----------------

  private onWsState(s: WsState, info?: { code?: number; reason?: string }): void {
    if (s === 'online') this.connection = 'online'
    else if (s === 'connecting')
      this.connection =
        this.connection === 'online'
          ? 'connecting'
          : this.connection === 'disabled'
            ? 'connecting'
            : this.connection
    else if (s === 'offline') this.connection = 'offline'
    this.host.onConnection(s === 'online')
    if (info?.code) this.log('ws fechado', info.code, info.reason)
    this.emitStatus()
  }

  private onWelcome(w: Record<string, unknown>): void {
    this.connection = 'online'
    if (typeof w.keys_rev === 'number' && w.keys_rev !== Number(this.kv('keys_rev') ?? 0))
      void this.refreshKeys().catch(() => undefined)
    this.host.onWelcome(w)
    if (typeof w.state_cursor === 'number') this.setKv('state_cursor', w.state_cursor)
    void this.refreshDevices()
    this.scheduleCycle(0)
    this.emitStatus()
  }

  private onWsEvent(f: Record<string, unknown>): void {
    switch (f.t) {
      case 'sync.changes':
        this.scheduleCycle(0)
        return
      case 'keys.changed':
        void this.refreshKeys().catch(() => undefined)
        return
      case 'keys.reset':
        this.resetForKeys()
        return
      case 'account.deleted':
        this.localSignOut()
        this.emit({ type: 'sync-notice', kind: 'error', text: 'A conta foi apagada.' })
        return
      default:
        this.host.onEvent(f)
    }
  }

  // ---------------- pontes para o host ----------------

  chatInfos(): ChatHostInfo[] {
    return this.host.allInfos()
  }

  chatInfo(chatId: string): ChatHostInfo {
    return this.host.info(chatId)
  }

  takeover(chatId: string, opts: TakeoverOptions): Promise<ChatHostInfo> {
    return this.host.takeover(chatId, opts)
  }

  /** Lista de nomes de escopo para o renderer recarregar. */
  static readonly ALL_SCOPES: SyncScope[] = [
    'providers',
    'presets',
    'settings',
    'chats',
    'memory',
    'skills',
    'approvals',
    'webSearch',
    'voice'
  ]

  /** Sessões (do banco) do chat, com o status gravado. */
  sessionsOf(chatId: string): Session[] {
    const ids = this.conn
      .prepare('SELECT id FROM sessions WHERE chat_id = ? ORDER BY depth, created_at')
      .all(chatId) as { id: string }[]
    const out: Session[] = []
    for (const { id } of ids) {
      const l = buildLocal(this.conn, 'session', id)
      if (l) out.push(sessionFromPlain(id, l.plain, chatId))
    }
    return out
  }
}
