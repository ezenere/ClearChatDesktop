// Conectores (MCP): as conexões deste aparelho com os servidores — uma por servidor, aberta sob
// demanda (primeiro turno que precisa, "Testar", Configurações) e mantida até mudar a config, dar
// erro ou o app fechar. Usa o SDK oficial (@modelcontextprotocol/client v2): negocia a era do
// protocolo (2026-07-28 ou 2025, `versionNegotiation: auto`) e lembra a descoberta no estado local
// (sem sondar de novo — no stdio a sondagem abre um processo a mais). Sem Electron direto: o
// ambiente do usuário, o OAuth e os avisos vêm por `configureMcpManager` (testável em Node).
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { OAuthClientProvider } from '@modelcontextprotocol/client'
import {
  MCP_DEFAULT_TIMEOUT_MS,
  effectiveTransport,
  mcpAvailability,
  normalizeToolsCache,
  type McpServerDef,
  type McpStatus,
  type McpToolInfo,
  type McpTransport
} from '@shared/mcp'
import { mcpLocal, mcpRepo } from './store'

export type { McpState, McpStatus } from '@shared/mcp'

/** Quem chamou a tool (para o formulário de elicitação aparecer no chat certo). */
export interface McpCallOwner {
  chatId: string
  sessionId: string
  toolCallId: string
}

export type McpElicitHandler = (
  owner: McpCallOwner | null,
  server: McpServerDef,
  params: Record<string, unknown>
) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>

interface Deps {
  /** Ambiente do usuário (shell de login) para os processos stdio. */
  userEnv: () => Promise<Record<string, string>>
  /** Provedor OAuth de um servidor HTTP com login (null = sem OAuth). */
  authProvider: (s: McpServerDef) => OAuthClientProvider | null
  elicit: McpElicitHandler
  onChange: () => void
  appVersion: string
}

let deps: Deps = {
  userEnv: async () => cleanEnv(process.env),
  authProvider: () => null,
  elicit: async () => ({ action: 'decline' }),
  onChange: () => {},
  appVersion: '0.0.0'
}

export function configureMcpManager(d: Partial<Deps>): void {
  deps = { ...deps, ...d }
}

export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  delete out.ELECTRON_RUN_AS_NODE
  return out
}

const LOG_LINES = 200
const CONNECT_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 3000

interface Conn {
  key: string
  client: Client
  close: () => Promise<void>
  tools: McpToolInfo[]
  calls: McpCallOwner[]
}

/** Assinatura do que exige reconectar (transporte efetivo + OAuth). */
function connKey(s: McpServerDef, t: McpTransport): string {
  return JSON.stringify({ t, oauth: !!s.oauth })
}

class McpManager {
  #conns = new Map<string, Conn>()
  #pending = new Map<string, Promise<Conn>>()
  #status = new Map<string, McpStatus>()

  status(id: string): McpStatus {
    const s = mcpRepo.get(id)
    const st = this.#status.get(id) ?? { state: 'idle', log: [] }
    if (s) {
      const av = mcpAvailability(s, mcpLocal.get(id), 'computer')
      if (!av.ok) return { ...st, state: 'unavailable', unavailable: av.reason }
    }
    return st
  }

  #set(id: string, patch: Partial<McpStatus>): void {
    const cur = this.#status.get(id) ?? { state: 'idle' as const, log: [] }
    this.#status.set(id, { ...cur, ...patch })
    deps.onChange()
  }

  #log(id: string, line: string): void {
    const cur = this.#status.get(id) ?? { state: 'idle' as const, log: [] }
    const log = [...cur.log, ...line.split('\n').filter((l) => l.trim())].slice(-LOG_LINES)
    this.#status.set(id, { ...cur, log })
  }

  /** Conexão pronta (abre se preciso). Erro legível se indisponível/falhou. */
  async ensure(id: string): Promise<Conn> {
    const s = mcpRepo.get(id)
    if (!s) throw new Error('Conector não encontrado.')
    const local = mcpLocal.get(id)
    const av = mcpAvailability(s, local, 'computer')
    if (!av.ok)
      throw new Error(
        av.reason === 'command-changed'
          ? `O comando do conector "${s.name}" mudou: ative de novo neste computador (Configurações → Conectores).`
          : `O conector "${s.name}" não está ativado neste computador (Configurações → Conectores).`
      )
    const t = effectiveTransport(s, local)
    const key = connKey(s, t)
    const cur = this.#conns.get(id)
    if (cur && cur.key === key) return cur
    if (cur) await this.disconnect(id)
    const pend = this.#pending.get(id)
    if (pend) return pend
    const p = this.#open(s, t, key).finally(() => this.#pending.delete(id))
    this.#pending.set(id, p)
    return p
  }

  async #open(s: McpServerDef, t: McpTransport, key: string): Promise<Conn> {
    const id = s.id
    const era = mcpLocal.get(id)?.era
    this.#set(id, { state: 'connecting', error: undefined })
    const attempt = async (mode: 'auto' | 'legacy' | 'modern', sse = false): Promise<Conn> => {
      const client = new Client(
        { name: 'ClearChat', version: deps.appVersion },
        {
          capabilities: { elicitation: { form: {} } },
          versionNegotiation:
            mode === 'modern'
              ? { mode: { pin: '2026-07-28' } }
              : mode === 'auto'
                ? { mode: 'auto', probe: { timeoutMs: PROBE_TIMEOUT_MS } }
                : { mode: 'legacy' },
          listChanged: {
            tools: {
              onChanged: (err, tools) => {
                if (err || !tools) return
                const c = this.#conns.get(id)
                if (c) c.tools = tools.map(toInfo)
                this.#saveTools(id, client, tools.map(toInfo))
              }
            }
          }
        }
      )
      client.setRequestHandler('elicitation/create', async (req) => {
        const owner = this.#conns.get(id)?.calls.at(-1) ?? null
        const server = mcpRepo.get(id) ?? s
        const params = req.params as unknown as Record<string, unknown>
        if (params.mode === 'url') return { action: 'decline' as const }
        const r = await deps.elicit(owner, server, params)
        // o conteúdo já vem nos tipos do esquema (mcpFormContent)
        return r as {
          action: typeof r.action
          content?: Record<string, string | number | boolean | string[]>
        }
      })
      let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
      if (t.type === 'stdio') {
        const env = { ...(await deps.userEnv()), ...t.env }
        const stdio = new StdioClientTransport({
          command: t.command,
          args: t.args,
          env,
          ...(t.cwd ? { cwd: t.cwd } : {}),
          stderr: 'pipe'
        })
        stdio.stderr?.on('data', (d: Buffer) => this.#log(id, d.toString('utf8')))
        transport = stdio
      } else {
        const auth = s.oauth ? deps.authProvider(s) : null
        const opts = {
          requestInit: { headers: t.headers },
          ...(auth ? { authProvider: auth } : {})
        }
        transport = sse
          ? new SSEClientTransport(new URL(t.url), opts)
          : new StreamableHTTPClientTransport(new URL(t.url), opts)
      }
      const timer = new Promise<never>((_r, rej) =>
        setTimeout(
          () => rej(new Error(`tempo esgotado ao conectar (${CONNECT_TIMEOUT_MS / 1000} s)`)),
          CONNECT_TIMEOUT_MS
        ).unref?.()
      )
      try {
        await Promise.race([
          client.connect(
            transport,
            mode === 'legacy' && era ? { prior: { kind: 'legacy' } } : undefined
          ),
          timer
        ])
      } catch (e) {
        await client.close().catch(() => {})
        throw e
      }
      const listed = await client.listTools()
      const tools = listed.tools.map(toInfo)
      const conn: Conn = {
        key,
        client,
        close: () => client.close(),
        tools,
        calls: []
      }
      client.onclose = () => {
        if (this.#conns.get(id) === conn) {
          this.#conns.delete(id)
          this.#set(id, { state: 'idle' })
        }
      }
      client.onerror = (e) => this.#log(id, `erro: ${e.message}`)
      const gotEra = client.getProtocolEra?.() === 'modern' ? 'modern' : 'legacy'
      if (era !== gotEra) mcpLocal.patch(id, { era: gotEra }, false)
      this.#saveTools(id, client, tools)
      this.#conns.set(id, conn)
      this.#set(id, {
        state: 'ready',
        error: undefined,
        era: gotEra,
        protocolVersion: client.getNegotiatedProtocolVersion?.(),
        toolCount: tools.length,
        connectedAt: Date.now()
      })
      return conn
    }
    try {
      // era conhecida → sem sondagem; se mudou (servidor atualizado), tenta de novo com a sondagem
      if (era === 'legacy') return await attempt('legacy').catch(() => attempt('auto'))
      if (era === 'modern') return await attempt('modern').catch(() => attempt('auto'))
      return await attempt('auto').catch(async (e) => {
        // HTTP antigo (HTTP+SSE de 2024): o POST no endpoint falha (404/405) → tenta o SSE
        if (t.type === 'http' && isHttpStatus(e, [404, 405])) return attempt('legacy', true)
        throw e
      })
    } catch (e) {
      const needsAuth = (e as Error)?.name === 'UnauthorizedError' || isHttpStatus(e, [401])
      const msg = needsAuth ? 'Precisa entrar (OAuth) neste aparelho.' : errText(e)
      this.#log(id, `falhou: ${msg}`)
      this.#set(id, { state: needsAuth ? 'needs-auth' : 'error', error: msg })
      throw new Error(`Conector "${s.name}": ${msg}`, { cause: e })
    }
  }

  #saveTools(id: string, client: Client, tools: McpToolInfo[]): void {
    const info = client.getServerVersion?.()
    mcpRepo.setToolsCache(
      id,
      normalizeToolsCache({
        tools,
        ...(client.getInstructions?.() ? { instructions: client.getInstructions() } : {}),
        ...(info?.name
          ? { server: { name: info.name, version: info.version, title: info.title } }
          : {}),
        at: Date.now()
      })!
    )
    const st = this.#status.get(id)
    if (st) this.#status.set(id, { ...st, toolCount: tools.length })
    deps.onChange()
  }

  /** Abre as conexões (em paralelo) sem lançar — antes de montar a request de um turno. */
  async ensureMany(ids: string[]): Promise<void> {
    await Promise.allSettled(ids.map((id) => this.ensure(id)))
  }

  /** Tools da conexão aberta (null = sem conexão → quem chama usa o cache do registro). */
  liveTools(id: string): McpToolInfo[] | null {
    return this.#conns.get(id)?.tools ?? null
  }

  async callTool(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; owner: McpCallOwner; onProgress?: (msg: string) => void }
  ): Promise<unknown> {
    const s = mcpRepo.get(id)
    const conn = await this.ensure(id)
    conn.calls.push(opts.owner)
    try {
      return await conn.client.callTool(
        { name: tool, arguments: args },
        {
          signal: opts.signal,
          timeout: s?.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          ...(opts.onProgress
            ? {
                onprogress: (p: { progress: number; total?: number; message?: string }) =>
                  opts.onProgress!(
                    [p.total ? `${p.progress}/${p.total}` : String(p.progress), p.message ?? '']
                      .filter(Boolean)
                      .join(' · ')
                  )
              }
            : {})
        }
      )
    } finally {
      const i = conn.calls.indexOf(opts.owner)
      if (i >= 0) conn.calls.splice(i, 1)
    }
  }

  async disconnect(id: string): Promise<void> {
    const c = this.#conns.get(id)
    this.#conns.delete(id)
    if (c) await c.close().catch(() => {})
    const st = this.#status.get(id)
    if (st && st.state !== 'idle') this.#set(id, { state: 'idle' })
  }

  /** Reconecta (Configurações → "Reconectar"/"Testar"): fecha e abre de novo. */
  async reconnect(id: string): Promise<McpStatus> {
    await this.disconnect(id)
    try {
      await this.ensure(id)
    } catch {
      /* o status já tem o erro */
    }
    return this.status(id)
  }

  /** Fecha conexões de servidores apagados ou com config diferente (depois de editar/sync). */
  async reconcile(): Promise<void> {
    const live = new Map(mcpRepo.list().map((s) => [s.id, s]))
    for (const [id, c] of [...this.#conns]) {
      const s = live.get(id)
      if (!s || connKey(s, effectiveTransport(s, mcpLocal.get(id))) !== c.key)
        await this.disconnect(id)
    }
    for (const id of [...this.#status.keys()]) if (!live.has(id)) this.#status.delete(id)
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#conns.keys()].map((id) => this.disconnect(id)))
  }
}

function toInfo(t: {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
  annotations?: unknown
}): McpToolInfo {
  return (
    normalizeToolsCache({ tools: [t], at: 0 })!.tools[0] ?? {
      name: t.name,
      inputSchema: { type: 'object', properties: {} }
    }
  )
}

function isHttpStatus(e: unknown, codes: number[]): boolean {
  const x = e as { code?: unknown; status?: unknown; data?: { status?: unknown } } | null
  const n = [x?.status, x?.code, x?.data?.status].find((v) => typeof v === 'number')
  if (typeof n === 'number') return codes.includes(n)
  const m = /\b(4\d\d)\b/.exec(String((e as Error)?.message ?? ''))
  return !!m && codes.includes(Number(m[1]))
}

function errText(e: unknown): string {
  const err = e as { code?: string; message?: string } | null
  if (err?.code === 'ENOENT') return 'comando não encontrado (está instalado e no PATH?)'
  const msg = String(err?.message ?? e ?? 'erro desconhecido')
  if (/ENOENT/.test(msg)) return 'comando não encontrado (está instalado e no PATH?)'
  if (/ECONNREFUSED/.test(msg)) return 'conexão recusada (o servidor está no ar?)'
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg
}

export const mcpManager = new McpManager()
