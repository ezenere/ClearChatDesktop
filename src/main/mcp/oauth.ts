// Conectores (MCP): login OAuth dos servidores HTTP — por APARELHO (os tokens nunca sincronizam:
// o OAuth 2.1 troca o refresh token a cada renovação, e dois aparelhos com o mesmo token se
// derrubariam). Fluxo de app nativo: PKCE + callback em 127.0.0.1 (porta lembrada por servidor, para
// o registro dinâmico continuar valendo), navegador do sistema para a autorização, `state` e `iss`
// conferidos. Identificação do app: Client ID Metadata Document (o documento publicado no site do
// ClearChat — o caminho que a spec 2026-07-28 recomenda) quando o servidor de autorização aceita;
// senão registro dinâmico (RFC 7591, obsoleto mas ainda o mais comum). Credenciais do cliente
// guardadas POR EMISSOR (nunca reaproveitadas com outro servidor de autorização). Tudo cifrado com
// o safeStorage do sistema quando disponível (setting local `mcpAuth`).
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/client'
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens
} from '@modelcontextprotocol/client'
import type { McpServerDef } from '@shared/mcp'
import { getDb } from '../db'
import { mcpManager } from './manager'
import { mcpRepo } from './store'

export const MCP_AUTH_SETTING = 'mcpAuth'
/** Documento de identificação do app (Client ID Metadata Document) — publicado pelo site. */
export const CLIENT_METADATA_URL = 'https://clear.ezenere.com/oauth/clearchat-mcp-client.json'
const LOGIN_TIMEOUT_MS = 5 * 60_000

interface AuthRecord {
  /** Credenciais do cliente por emissor (DCR) — nunca usadas com outro servidor de autorização. */
  clients?: Record<string, StoredOAuthClientInformation>
  tokens?: StoredOAuthTokens
  /** Emissor dos tokens atuais. */
  issuer?: string
  asUrl?: string
  /** Porta do callback do último login (o registro dinâmico guardou esse redirect). */
  port?: number
}

// ---------------- armazenamento (cifrado) ----------------

interface Crypto {
  encrypt: (plain: string) => string | null
  decrypt: (stored: string) => string | null
}
let crypto: Crypto = { encrypt: () => null, decrypt: () => null }
let openUrl: (url: string) => void | Promise<void> = () => {}
let onAuthChange: () => void = () => {}

/** Electron liga o safeStorage, o navegador do sistema e o aviso de mudança (index.ts). */
export function configureMcpOAuth(o: {
  crypto?: Crypto
  openUrl?: (url: string) => void | Promise<void>
  onChange?: () => void
}): void {
  if (o.crypto) crypto = o.crypto
  if (o.openUrl) openUrl = o.openUrl
  if (o.onChange) onAuthChange = o.onChange
}

function readAll(): Record<string, string> {
  const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(MCP_AUTH_SETTING) as
    { value: string | null } | undefined
  try {
    const v = r?.value ? JSON.parse(r.value) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function writeAll(v: Record<string, string>): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(MCP_AUTH_SETTING, JSON.stringify(v))
}

function readRecord(id: string): AuthRecord {
  const raw = readAll()[id]
  if (!raw) return {}
  // "enc:<base64>" = cifrado pelo sistema; "plain:<json>" = sem cofre disponível
  const json = raw.startsWith('enc:')
    ? crypto.decrypt(raw.slice(4))
    : raw.startsWith('plain:')
      ? raw.slice(6)
      : null
  try {
    return json ? (JSON.parse(json) as AuthRecord) : {}
  } catch {
    return {}
  }
}

function writeRecord(id: string, rec: AuthRecord | null): void {
  const all = readAll()
  if (!rec || !Object.keys(rec).length) delete all[id]
  else {
    const json = JSON.stringify(rec)
    const enc = crypto.encrypt(json)
    all[id] = enc ? `enc:${enc}` : `plain:${json}`
  }
  writeAll(all)
  onAuthChange()
}

function patchRecord(id: string, patch: Partial<AuthRecord>): void {
  const rec: AuthRecord = { ...readRecord(id), ...patch }
  for (const k of Object.keys(rec) as (keyof AuthRecord)[]) if (rec[k] === undefined) delete rec[k]
  writeRecord(id, rec)
}

/** Este aparelho tem login (tokens) no servidor? */
export function mcpHasLogin(id: string): boolean {
  return !!readRecord(id).tokens?.access_token
}

/** Sair: apaga tokens e credenciais deste aparelho e fecha a conexão. */
export async function mcpLogout(id: string): Promise<void> {
  writeRecord(id, null)
  await mcpManager.disconnect(id)
}

// ---------------- provedor OAuth do SDK ----------------

interface Flow {
  redirectUrl: string
  state: string
  verifier?: string
  /** Servidor de autorização descoberto na ida (a volta precisa ser do mesmo — SEP-2352). */
  discovery?: OAuthDiscoveryState
  /** Abre a autorização (só durante um login pedido pelo usuário). */
  open: (url: URL) => void
}
const flows = new Map<string, Flow>()

class Provider implements OAuthClientProvider {
  readonly clientMetadataUrl = CLIENT_METADATA_URL
  #id: string
  constructor(id: string) {
    this.#id = id
  }
  get redirectUrl(): string {
    const f = flows.get(this.#id)
    if (f) return f.redirectUrl
    const port = readRecord(this.#id).port
    return `http://127.0.0.1${port ? `:${port}` : ''}/callback`
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'ClearChat',
      client_uri: 'https://clear.ezenere.com',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native'
    }
  }
  state(): string {
    return flows.get(this.#id)?.state ?? randomBytes(16).toString('base64url')
  }
  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const rec = readRecord(this.#id)
    const issuer = ctx?.issuer ?? rec.issuer
    return issuer ? rec.clients?.[issuer] : undefined
  }
  saveClientInformation(
    info: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext
  ): void {
    const rec = readRecord(this.#id)
    const issuer = ctx?.issuer ?? rec.issuer ?? ''
    patchRecord(this.#id, { clients: { ...(rec.clients ?? {}), [issuer]: info } })
  }
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const rec = readRecord(this.#id)
    // tokens de outro emissor não servem (o servidor de autorização mudou → login de novo)
    if (ctx?.issuer && rec.issuer && ctx.issuer !== rec.issuer) return undefined
    return rec.tokens
  }
  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    patchRecord(this.#id, { tokens, ...(ctx?.issuer ? { issuer: ctx.issuer } : {}) })
  }
  redirectToAuthorization(url: URL): void {
    // fora de um login pedido pelo usuário (conexão em segundo plano), nada abre: a UI mostra
    // "Precisa entrar" e o usuário clica em Entrar
    flows.get(this.#id)?.open(url)
  }
  saveDiscoveryState(d: OAuthDiscoveryState): void {
    const f = flows.get(this.#id)
    if (f) f.discovery = d
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return flows.get(this.#id)?.discovery
  }
  saveCodeVerifier(v: string): void {
    const f = flows.get(this.#id)
    if (f) f.verifier = v
  }
  codeVerifier(): string {
    const v = flows.get(this.#id)?.verifier
    if (!v) throw new Error('Login não iniciado neste aparelho.')
    return v
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') return writeRecord(this.#id, null)
    if (scope === 'tokens') return patchRecord(this.#id, { tokens: undefined })
    if (scope === 'client') return patchRecord(this.#id, { clients: undefined })
    if (scope === 'discovery') return patchRecord(this.#id, { asUrl: undefined })
  }
  saveAuthorizationServerUrl(u: string): void {
    patchRecord(this.#id, { asUrl: u })
  }
  authorizationServerUrl(): string | undefined {
    return readRecord(this.#id).asUrl
  }
}

const providers = new Map<string, Provider>()
/** Provedor OAuth de um servidor (o gerenciador de conexões o passa ao transporte HTTP). */
export function mcpAuthProvider(s: McpServerDef): OAuthClientProvider | null {
  if (!s.oauth || s.transport.type !== 'http') return null
  let p = providers.get(s.id)
  if (!p) {
    p = new Provider(s.id)
    providers.set(s.id, p)
  }
  return p
}

// ---------------- login (pedido pelo usuário) ----------------

interface Loopback {
  port: number
  result: Promise<URLSearchParams>
  close: () => void
}

const DONE_HTML = (ok: boolean, msg: string): string =>
  `<!doctype html><meta charset="utf-8"><title>ClearChat</title><body style="font:16px system-ui;margin:3em;text-align:center"><h2>${ok ? '✓ Pronto' : 'Não deu certo'}</h2><p>${msg}</p></body>`

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

/** Callback local (127.0.0.1): tenta a porta do último login; ocupada → uma livre. */
async function startLoopback(preferred?: number): Promise<Loopback> {
  let srv: Server
  try {
    srv = await listen(preferred ?? 0)
  } catch {
    srv = await listen(0)
  }
  const port = (srv.address() as { port: number }).port
  let settle: (p: URLSearchParams) => void = () => {}
  const result = new Promise<URLSearchParams>((r) => (settle = r))
  srv.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== '/callback') {
      res.writeHead(404)
      res.end()
      return
    }
    const err = url.searchParams.get('error')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      DONE_HTML(
        !err,
        err
          ? `O servidor recusou: ${err}. Volte ao ClearChat e tente de novo.`
          : 'Login concluído. Pode fechar esta aba e voltar ao ClearChat.'
      )
    )
    settle(url.searchParams)
  })
  return { port, result, close: () => srv.close() }
}

const logins = new Map<string, AbortController>()

/**
 * "Entrar" (Configurações → Conectores): abre a autorização no navegador do sistema e espera o
 * callback (até 5 min ou `cancelMcpLogin`). Já autorizado (token válido/renovado) → só reconecta.
 */
export async function mcpLogin(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = mcpRepo.get(id)
  if (!s || s.transport.type !== 'http' || !s.oauth)
    return { ok: false, error: 'Este conector não usa login OAuth.' }
  cancelMcpLogin(id)
  const ctl = new AbortController()
  logins.set(id, ctl)
  const rec = readRecord(id)
  const loop = await startLoopback(rec.port)
  // porta diferente da registrada: o registro dinâmico antigo não aceita este redirect → refaz
  if (rec.port && rec.port !== loop.port) patchRecord(id, { clients: undefined })
  patchRecord(id, { port: loop.port })
  const state = randomBytes(16).toString('base64url')
  flows.set(id, {
    redirectUrl: `http://127.0.0.1:${loop.port}/callback`,
    state,
    open: (url) => void openUrl(url.href)
  })
  const provider = mcpAuthProvider(s)!
  try {
    const first = await auth(provider, { serverUrl: s.transport.url })
    if (first !== 'AUTHORIZED') {
      const timeout = new Promise<never>((_r, rej) => {
        const t = setTimeout(
          () => rej(new Error('tempo esgotado esperando o login (5 min)')),
          LOGIN_TIMEOUT_MS
        )
        t.unref?.()
        ctl.signal.addEventListener('abort', () => {
          clearTimeout(t)
          rej(new Error('login cancelado'))
        })
      })
      const params = await Promise.race([loop.result, timeout])
      const err = params.get('error')
      if (err)
        throw new Error(
          `o servidor recusou (${err}${params.get('error_description') ? `: ${params.get('error_description')}` : ''})`
        )
      if (params.get('state') !== state)
        throw new Error('resposta de login inválida (state não confere)')
      const code = params.get('code')
      if (!code) throw new Error('resposta de login sem código')
      const iss = params.get('iss') ?? undefined
      const second = await auth(provider, {
        serverUrl: s.transport.url,
        authorizationCode: code,
        ...(iss ? { iss } : {})
      })
      if (second !== 'AUTHORIZED') throw new Error('o servidor não concluiu o login')
    }
    await mcpManager.reconnect(id)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    flows.delete(id)
    loop.close()
    if (logins.get(id) === ctl) logins.delete(id)
  }
}

export function cancelMcpLogin(id: string): void {
  logins.get(id)?.abort()
  logins.delete(id)
}
