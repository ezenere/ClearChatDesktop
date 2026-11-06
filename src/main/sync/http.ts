// Cliente REST do sync (docs/SYNC_PROTOCOL.md §6). Sem Electron. Tokens por dispositivo com refresh
// rotativo (§5.4): 401 expirado → refresh (uma vez, serializado) → repete a requisição.
import { SYNC_PROTOCOL, type SyncServerInfo } from '@shared/sync'

export class SyncApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(
    message: string,
    status: number,
    code: string,
    details: Record<string, unknown> = {}
  ) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

/** Sem rede / servidor inacessível. */
export class SyncNetworkError extends Error {}

export interface Tokens {
  access_token: string
  /** ms Unix em que o access expira (calculado de access_expires_in). */
  access_expires_at: number
  refresh_token: string
}

export interface TokenStore {
  get(): Tokens | null
  set(t: Tokens | null): void
}

export interface HttpOptions {
  base: () => string
  tokens: TokenStore
  appVersion: string
  /** Tipo de cliente no cabeçalho `X-ClearChat-Client` (padrão `desktop`; o mobile reusa este módulo). */
  client?: 'desktop' | 'mobile'
  /** Refresh recusado (refresh_reused / sessão inválida) ou dispositivo revogado. */
  onSignedOut?: (code: string) => void
}

/** Normaliza a URL digitada (§20.1): sem esquema → https://; sem `/` final. */
export function normalizeBaseUrl(input: string): string {
  let s = String(input ?? '').trim()
  if (!s) throw new Error('Informe o endereço do servidor.')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error('Endereço do servidor inválido.')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new Error('Use um endereço http:// ou https://.')
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.protocol}//${u.host.toLowerCase()}${path}`
}

const errorText = (status: number, code: string, msg?: string): string => {
  if (msg) return msg
  if (status === 0) return 'Sem conexão com o servidor.'
  return `Erro do servidor (${status}${code ? ` ${code}` : ''}).`
}

export async function fetchServerInfo(base: string, timeoutMs = 10_000): Promise<SyncServerInfo> {
  let res: Response
  try {
    res = await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const msg = (e as Error).message || String(e)
    throw new SyncNetworkError(
      /certificate|ssl|tls/i.test(msg)
        ? `Falha de TLS ao conectar em ${base}: ${msg}`
        : `Não foi possível conectar em ${base} (${msg}).`
    )
  }
  if (!res.ok)
    throw new Error(`${base} não respondeu como um servidor ClearChat (HTTP ${res.status}).`)
  let j: Record<string, unknown>
  try {
    j = (await res.json()) as Record<string, unknown>
  } catch {
    throw new Error(`${base} não respondeu como um servidor ClearChat (resposta inválida).`)
  }
  const proto = j.protocol as { min?: unknown; max?: unknown; version?: unknown } | undefined
  if (!proto || typeof proto.min !== 'number' || typeof proto.max !== 'number')
    throw new Error(`${base} não respondeu como um servidor ClearChat (sem versão de protocolo).`)
  const features = (j.features ?? {}) as Record<string, unknown>
  const links = (j.links ?? {}) as Record<string, unknown>
  return {
    url: base,
    name: typeof j.name === 'string' && j.name ? j.name : 'ClearChat',
    serverVersion: typeof j.server_version === 'string' ? j.server_version : undefined,
    protocol: {
      min: proto.min,
      max: proto.max,
      version: typeof proto.version === 'string' ? proto.version : undefined
    },
    signupOpen: features.signupOpen === true,
    captcha: !!features.captcha,
    signupUrl: typeof links.signup === 'string' ? links.signup : undefined,
    insecure: base.startsWith('http://'),
    push: !!features.push,
    liveChats: features.liveChats === true
  }
}

/** Erro de protocolo incompatível (texto da §6.2) ou null. */
export function protocolMismatch(info: SyncServerInfo): string | null {
  if (SYNC_PROTOCOL >= info.protocol.min && SYNC_PROTOCOL <= info.protocol.max) return null
  return `Este servidor usa uma versão incompatível do protocolo (servidor ${info.protocol.min}–${info.protocol.max}, app ${SYNC_PROTOCOL}) — atualize o app/servidor.`
}

export class SyncHttp {
  private refreshing: Promise<boolean> | null = null

  private opts: HttpOptions

  constructor(opts: HttpOptions) {
    this.opts = opts
  }

  private headers(auth: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'X-ClearChat-Client': `${this.opts.client ?? 'desktop'}/${this.opts.appVersion}`,
      'X-ClearChat-Protocol': String(SYNC_PROTOCOL),
      ...extra
    }
    if (auth) {
      const t = this.opts.tokens.get()
      if (t) h.Authorization = `Bearer ${t.access_token}`
    }
    return h
  }

  /** Refresh do access (serializado). false = sessão perdida. */
  async refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const t = this.opts.tokens.get()
      if (!t?.refresh_token) return false
      try {
        const r = await this.raw('POST', '/api/v1/auth/refresh', {
          json: { refresh_token: t.refresh_token },
          auth: false
        })
        const j = r as { access_token: string; access_expires_in: number; refresh_token?: string }
        this.opts.tokens.set({
          access_token: j.access_token,
          access_expires_at: Date.now() + (j.access_expires_in ?? 3600) * 1000,
          refresh_token: j.refresh_token ?? t.refresh_token
        })
        return true
      } catch (e) {
        if (e instanceof SyncApiError && (e.status === 401 || e.status === 403)) {
          this.opts.onSignedOut?.(e.code)
          return false
        }
        throw e
      }
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /** Access ainda válido (com margem)? Senão faz refresh antes. */
  async ensureFresh(): Promise<void> {
    const t = this.opts.tokens.get()
    if (t && t.access_expires_at - Date.now() < 30_000) await this.refresh()
  }

  private async raw(
    method: string,
    path: string,
    o: {
      json?: unknown
      body?: Uint8Array
      auth?: boolean
      headers?: Record<string, string>
      binary?: boolean
      timeoutMs?: number
    } = {}
  ): Promise<unknown> {
    const auth = o.auth !== false
    const extra: Record<string, string> = { ...(o.headers ?? {}) }
    let body: BodyInit | undefined
    if (o.json !== undefined) {
      extra['Content-Type'] = 'application/json'
      body = JSON.stringify(o.json)
    } else if (o.body) {
      extra['Content-Type'] = 'application/octet-stream'
      body = o.body as unknown as BodyInit
    }
    let res: Response
    try {
      res = await fetch(`${this.opts.base()}${path}`, {
        method,
        headers: this.headers(auth, extra),
        body,
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000)
      })
    } catch (e) {
      throw new SyncNetworkError(`Sem conexão com o servidor (${(e as Error).message}).`)
    }
    if (res.status === 204) return null
    if (res.ok) {
      if (o.binary) return new Uint8Array(await res.arrayBuffer())
      const text = await res.text()
      return text ? JSON.parse(text) : null
    }
    let code = ''
    let message = ''
    let details: Record<string, unknown> = {}
    try {
      const j = (await res.json()) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> }
      }
      code = j.error?.code ?? ''
      message = j.error?.message ?? ''
      details = j.error?.details ?? {}
    } catch {
      /* corpo não JSON */
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') ?? details.retry_after ?? 0)
      if (ra) details = { ...details, retry_after: ra }
    }
    throw new SyncApiError(errorText(res.status, code, message), res.status, code, details)
  }

  /** Requisição autenticada (refresh automático em 401). */
  async req<T = unknown>(
    method: string,
    path: string,
    o: {
      json?: unknown
      body?: Uint8Array
      auth?: boolean
      headers?: Record<string, string>
      binary?: boolean
      timeoutMs?: number
    } = {}
  ): Promise<T> {
    if (o.auth !== false) await this.ensureFresh()
    try {
      return (await this.raw(method, path, o)) as T
    } catch (e) {
      if (o.auth !== false && e instanceof SyncApiError) {
        if (e.status === 401 && e.code !== 'refresh_reused') {
          if (await this.refresh()) return (await this.raw(method, path, o)) as T
          throw e
        }
        if (e.status === 403 && (e.code === 'device_revoked' || e.code === 'account_disabled'))
          this.opts.onSignedOut?.(e.code)
      }
      throw e
    }
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.req<T>('GET', path)
  }
  post<T = unknown>(path: string, json?: unknown, auth = true): Promise<T> {
    return this.req<T>('POST', path, { json: json ?? {}, auth })
  }
  put<T = unknown>(path: string, json: unknown): Promise<T> {
    return this.req<T>('PUT', path, { json })
  }
  patch<T = unknown>(path: string, json: unknown): Promise<T> {
    return this.req<T>('PATCH', path, { json })
  }
  del<T = unknown>(path: string, json?: unknown): Promise<T> {
    return this.req<T>('DELETE', path, json === undefined ? {} : { json })
  }
}
