// Conectores (servidores MCP — Model Context Protocol). Partes PURAS, compartilhadas pelo main, pelo
// renderer, pelos testes e pelo app mobile (vendora este arquivo): o registro do servidor
// (sincronizado, `mcp_server` — SYNC_PROTOCOL.md §4.3.10), a escolha por persona/chat
// (`ChatConfig.mcpServers`, herança por servidor), os nomes das tools no modelo, a limpeza dos
// esquemas, a conversão do resultado, a aprovação por servidor/tool, o formulário de elicitação e a
// importação de configs de outros apps. Ver SPEC.md → "Conectores (MCP)".
//
// Camadas: (1) CADASTRO global da conta — `McpServerDef`, sincronizado; (2) por APARELHO —
// `McpLocalState` (stdio ativado neste computador, ajustes, era descoberta; tokens OAuth ficam no
// main, cifrados), nunca sincronizado; (3) ESCOLHA por persona/chat — `ChatConfig.mcpServers`.
import type { JsonSchema, ToolDefinition } from './tools'

// ---------------- registro (sincronizado) ----------------

export type McpTransport =
  | {
      type: 'stdio'
      command: string
      args: string[]
      /** Variáveis do processo (valores podem ser segredos — o registro é cifrado ponta a ponta). */
      env: Record<string, string>
      /** Pasta de trabalho (vazia = a pasta pessoal). */
      cwd?: string
    }
  | {
      type: 'http'
      url: string
      /** Cabeçalhos fixos (ex.: `Authorization: Bearer …`). */
      headers: Record<string, string>
    }

/** Aprovação de uma tool MCP: perguntar (padrão), Smart-Approve ou sempre permitir. */
export type McpApprovalMode = 'ask' | 'smart' | 'always'

export interface McpToolInfo {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  /** Dicas do SERVIDOR (não confiáveis: só exibição e contexto do juiz — nunca liberam nada). */
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

/** Última lista vista do servidor (para aparelhos que não o executam mostrarem e escolherem). */
export interface McpToolsCache {
  tools: McpToolInfo[]
  /** Instruções do servidor (só vão ao modelo se ligadas no chat — nada escondido). */
  instructions?: string
  server?: { name: string; version?: string; title?: string }
  at: number
}

export interface McpServerDef {
  id: string
  /** Nome curto (vai no nome das tools: `mcp__<nome>__<tool>`) — ver `MCP_NAME_RE`. */
  name: string
  /** Rótulo livre (vazio = o nome). */
  title?: string
  transport: McpTransport
  /** Login OAuth (só HTTP; feito em cada aparelho — os tokens nunca sincronizam). */
  oauth?: boolean
  /** Aprovação padrão das tools deste servidor e as exceções por tool (nome original). */
  approval: { mode: McpApprovalMode; tools?: Record<string, McpApprovalMode> }
  /** Teto de uma chamada (ms; o progresso do servidor reinicia o relógio). Ausente = 120 s. */
  timeoutMs?: number
  tools?: McpToolsCache
  createdAt: number
  updatedAt: number
}

export const MCP_DEFAULT_TIMEOUT_MS = 120_000
export const MCP_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/
export const MCP_TOOL_PREFIX = 'mcp__'
/** Teto do nome de função (o menor entre os provedores: OpenAI = 64). */
export const MCP_WIRE_MAX = 64

export function validateMcpName(name: string): string | null {
  if (!name) return 'Dê um nome curto ao conector.'
  if (!MCP_NAME_RE.test(name))
    return 'Use letras minúsculas, números e hífens (até 24), sem hífen no começo ou no fim.'
  return null
}

/** Nome curto a partir de um rótulo ("GitHub Enterprise" → "github-enterprise"). */
export function slugMcpName(label: string): string {
  const s = label
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return s || 'conector'
}

/** Nome livre que não colide com os existentes (`nome`, `nome-2`, …). */
export function uniqueMcpName(base: string, taken: readonly string[]): string {
  const b = slugMcpName(base)
  if (!taken.includes(b)) return b
  for (let i = 2; ; i++) {
    const suffix = `-${i}`
    const n = `${b.slice(0, 24 - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken.includes(n)) return n
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const strMap = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (k && typeof x === 'string') out[k] = x
  return out
}
const isMode = (v: unknown): v is McpApprovalMode => v === 'ask' || v === 'smart' || v === 'always'

/** Transporte lido de qualquer valor (null = inválido). */
export function normalizeMcpTransport(v: unknown): McpTransport | null {
  if (!isObj(v)) return null
  if (v.type === 'stdio') {
    const command = typeof v.command === 'string' ? v.command.trim() : ''
    if (!command) return null
    const args = Array.isArray(v.args)
      ? v.args.filter((a): a is string => typeof a === 'string')
      : []
    const cwd = typeof v.cwd === 'string' && v.cwd.trim() ? v.cwd.trim() : undefined
    return { type: 'stdio', command, args, env: strMap(v.env), ...(cwd ? { cwd } : {}) }
  }
  if (v.type === 'http') {
    const url = typeof v.url === 'string' ? v.url.trim() : ''
    if (!/^https?:\/\/\S+$/i.test(url)) return null
    return { type: 'http', url, headers: strMap(v.headers) }
  }
  return null
}

function normalizeToolInfo(v: unknown): McpToolInfo | null {
  if (!isObj(v) || typeof v.name !== 'string' || !v.name) return null
  const ann = isObj(v.annotations) ? v.annotations : null
  const annotations: McpToolInfo['annotations'] = {}
  if (ann) {
    if (typeof ann.title === 'string') annotations.title = ann.title
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const)
      if (typeof ann[k] === 'boolean') annotations[k] = ann[k] as boolean
  }
  return {
    name: v.name,
    ...(typeof v.title === 'string' && v.title ? { title: v.title } : {}),
    ...(typeof v.description === 'string' ? { description: v.description } : {}),
    inputSchema: isObj(v.inputSchema) ? v.inputSchema : { type: 'object', properties: {} },
    ...(Object.keys(annotations).length ? { annotations } : {})
  }
}

export function normalizeToolsCache(v: unknown): McpToolsCache | undefined {
  if (!isObj(v) || !Array.isArray(v.tools)) return undefined
  const tools = v.tools.map(normalizeToolInfo).filter((t): t is McpToolInfo => !!t)
  const server = isObj(v.server) && typeof v.server.name === 'string' ? v.server : null
  return {
    tools,
    ...(typeof v.instructions === 'string' && v.instructions
      ? { instructions: v.instructions }
      : {}),
    ...(server
      ? {
          server: {
            name: server.name as string,
            ...(typeof server.version === 'string' ? { version: server.version } : {}),
            ...(typeof server.title === 'string' ? { title: server.title } : {})
          }
        }
      : {}),
    at: typeof v.at === 'number' ? v.at : 0
  }
}

/** Registro lido de qualquer valor (null = inválido). Campos desconhecidos são descartados. */
export function normalizeMcpServer(v: unknown): McpServerDef | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null
  const name = typeof v.name === 'string' ? v.name : ''
  const transport = normalizeMcpTransport(v.transport)
  if (validateMcpName(name) || !transport) return null
  const ap = isObj(v.approval) ? v.approval : {}
  const tools: Record<string, McpApprovalMode> = {}
  if (isObj(ap.tools)) for (const [k, m] of Object.entries(ap.tools)) if (isMode(m)) tools[k] = m
  const cache = normalizeToolsCache(v.tools)
  return {
    id: v.id,
    name,
    ...(typeof v.title === 'string' && v.title.trim() ? { title: v.title.trim() } : {}),
    transport,
    ...(v.oauth === true && transport.type === 'http' ? { oauth: true } : {}),
    approval: {
      mode: isMode(ap.mode) ? ap.mode : 'ask',
      ...(Object.keys(tools).length ? { tools } : {})
    },
    ...(typeof v.timeoutMs === 'number' && v.timeoutMs >= 1000 ? { timeoutMs: v.timeoutMs } : {}),
    ...(cache ? { tools: cache } : {}),
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0
  }
}

export const mcpLabel = (s: Pick<McpServerDef, 'name' | 'title'>): string => s.title || s.name

/** Modo de aprovação de uma tool (exceção da tool → padrão do servidor). */
export function mcpApprovalMode(s: Pick<McpServerDef, 'approval'>, tool: string): McpApprovalMode {
  const own = s.approval.tools?.[tool]
  return own ?? s.approval.mode
}

/**
 * Comando exato de um stdio (o que o usuário confirma em "Ativar neste computador" — muda o comando
 * ou os argumentos → pede de novo). As variáveis de ambiente não entram (segredos mudam sem o
 * programa mudar); a pasta sim.
 */
export function mcpCommandText(t: Extract<McpTransport, { type: 'stdio' }>): string {
  const q = (a: string): string =>
    /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`
  const line = [t.command, ...t.args].map(q).join(' ')
  return t.cwd ? `${line}   (em ${t.cwd})` : line
}

// ---------------- estado do aparelho (nunca sincronizado) ----------------

export interface McpLocalState {
  /** stdio: o comando que o usuário ativou NESTE computador (`mcpCommandText`). */
  activated?: string
  /** stdio: ajustes deste aparelho (caminhos diferentes entre máquinas). */
  override?: { args?: string[]; env?: Record<string, string>; cwd?: string }
  /** Era do protocolo descoberta na última conexão (pula a sondagem). */
  era?: 'legacy' | 'modern'
}

/** Transporte efetivo neste aparelho (com os ajustes locais do stdio). */
export function effectiveTransport(
  s: McpServerDef,
  local: McpLocalState | undefined
): McpTransport {
  const t = s.transport
  if (t.type !== 'stdio' || !local?.override) return t
  const o = local.override
  return {
    ...t,
    ...(o.args ? { args: o.args } : {}),
    env: { ...t.env, ...(o.env ?? {}) },
    ...(o.cwd !== undefined ? (o.cwd ? { cwd: o.cwd } : { cwd: undefined }) : {})
  }
}

export type McpAvailability =
  { ok: true } | { ok: false; reason: 'phone' | 'not-activated' | 'command-changed' }

/** O servidor pode rodar neste aparelho? (stdio: só computador, depois de ativado.) */
export function mcpAvailability(
  s: McpServerDef,
  local: McpLocalState | undefined,
  device: 'computer' | 'phone'
): McpAvailability {
  if (s.transport.type === 'http') return { ok: true }
  if (device === 'phone') return { ok: false, reason: 'phone' }
  if (!local?.activated) return { ok: false, reason: 'not-activated' }
  const now = mcpCommandText(
    effectiveTransport(s, local) as Extract<McpTransport, { type: 'stdio' }>
  )
  return local.activated === now ? { ok: true } : { ok: false, reason: 'command-changed' }
}

// ---------------- visão para a UI ----------------

export type McpState = 'idle' | 'connecting' | 'ready' | 'error' | 'needs-auth' | 'unavailable'

/** Estado da conexão neste aparelho. */
export interface McpStatus {
  state: McpState
  error?: string
  /** stdio não ativado / comando mudou / celular. */
  unavailable?: 'phone' | 'not-activated' | 'command-changed'
  era?: 'legacy' | 'modern'
  protocolVersion?: string
  toolCount?: number
  /** Últimas linhas do stderr (stdio) e eventos da conexão. */
  log: string[]
  connectedAt?: number
}

/** Um conector como a tela de Conectores o mostra (cadastro + estado deste aparelho). */
export interface McpServerView {
  server: McpServerDef
  status: McpStatus
  local: McpLocalState
  /** stdio: o comando exato que "Ativar neste computador" vai gravar (com os ajustes locais). */
  commandText?: string
  /** HTTP com OAuth: este aparelho tem login. */
  hasLogin: boolean
}

/** O que a tela manda ao criar/editar (o resto do registro é do app). */
export interface McpServerInput {
  name: string
  title?: string
  transport: McpTransport
  oauth?: boolean
  approval?: { mode: McpApprovalMode; tools?: Record<string, McpApprovalMode> }
  timeoutMs?: number
}

// ---------------- escolha por persona/chat ----------------

/** `ChatConfig.mcpServers[<id do servidor>]`. */
export interface McpServerChoice {
  on: boolean
  /** Tools desligadas aqui (nomes originais do servidor). */
  off?: string[]
  /** Instruções do servidor no system prompt (padrão false — ver "nada escondido"). */
  instructions?: boolean
}

export function normalizeMcpChoice(v: unknown): McpServerChoice | undefined {
  if (!isObj(v)) return undefined
  const off = Array.isArray(v.off)
    ? [...new Set(v.off.filter((t): t is string => typeof t === 'string' && !!t))]
    : []
  return {
    on: v.on === true,
    ...(off.length ? { off } : {}),
    ...(v.instructions === true ? { instructions: true } : {})
  }
}

export function normalizeMcpChoices(v: unknown): Record<string, McpServerChoice> {
  const out: Record<string, McpServerChoice> = {}
  if (isObj(v))
    for (const [id, c] of Object.entries(v)) {
      const n = normalizeMcpChoice(c)
      if (id && n) out[id] = n
    }
  return out
}

/** Servidores ligados nesta config (ids). */
export function mcpServersOn(cfg: { mcpServers?: unknown } | null | undefined): string[] {
  return Object.entries(normalizeMcpChoices(cfg?.mcpServers))
    .filter(([, c]) => c.on)
    .map(([id]) => id)
}

// ---------------- nomes no modelo ----------------

/** FNV-1a 32 bits em base 36 (6 caracteres) — sufixo estável de nomes longos/colididos. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(6, '0').slice(-6)
}

/** `mcp__<servidor>__<tool>` com só `[A-Za-z0-9_-]` e até 64 caracteres. */
export function mcpWireName(server: string, tool: string): string {
  const prefix = `${MCP_TOOL_PREFIX}${server}__`
  const clean = tool.replace(/[^A-Za-z0-9_-]/g, '_') || '_'
  if (prefix.length + clean.length <= MCP_WIRE_MAX) return prefix + clean
  const keep = MCP_WIRE_MAX - prefix.length - 7
  return `${prefix}${clean.slice(0, Math.max(1, keep))}_${shortHash(tool)}`
}

export const isMcpToolName = (name: string): boolean => name.startsWith(MCP_TOOL_PREFIX)

/** Uma tool MCP como vai ao modelo nesta sessão. */
export interface McpToolEntry {
  wire: string
  serverId: string
  server: string
  tool: McpToolInfo
}

/**
 * Tools MCP de uma sessão, na ordem: servidores na ordem do cadastro, tools na ordem do servidor
 * (determinístico — prefixo de cache estável), sem as desligadas. Colisão de nomes depois da limpeza
 * → sufixo de hash. `tools(server)` = a lista que vale aqui (a da conexão ou a do cache).
 */
export function mcpToolEntries(
  servers: readonly McpServerDef[],
  choices: Record<string, McpServerChoice>,
  tools: (s: McpServerDef) => readonly McpToolInfo[] | null
): McpToolEntry[] {
  const out: McpToolEntry[] = []
  const used = new Set<string>()
  for (const s of servers) {
    const c = choices[s.id]
    if (!c?.on) continue
    const list = tools(s)
    if (!list) continue
    const off = new Set(c.off ?? [])
    for (const t of list) {
      if (off.has(t.name)) continue
      let wire = mcpWireName(s.name, t.name)
      if (used.has(wire)) {
        const base = wire.slice(0, MCP_WIRE_MAX - 7)
        wire = `${base}_${shortHash(`${s.id}/${t.name}`)}`
      }
      used.add(wire)
      out.push({ wire, serverId: s.id, server: s.name, tool: t })
    }
  }
  return out
}

// ---------------- esquemas ----------------

const DROP_KEYS = new Set(['$schema', '$id', '$defs', 'definitions', '$comment'])
const MAX_REF_DEPTH = 8

/**
 * Esquema de entrada pronto para os provedores: `$ref` locais (`#/$defs/x`, `#/definitions/x`)
 * resolvidos inline (profundidade ≤ 8 — recursão vira `{}`), sem `$schema`/`$id`/`$defs`, raiz
 * sempre `type: object` com `properties`. O resto do JSON Schema fica como veio.
 */
export function mcpInputSchema(schema: Record<string, unknown>): JsonSchema {
  const root = isObj(schema) ? schema : {}
  const defs = {
    ...(isObj(root.definitions) ? root.definitions : {}),
    ...(isObj(root.$defs) ? root.$defs : {})
  } as Record<string, unknown>
  const walk = (v: unknown, depth: number): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, depth))
    if (!isObj(v)) return v
    if (typeof v.$ref === 'string') {
      const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(v.$ref)
      const target = m
        ? defs[decodeURIComponent(m[1]).replace(/~1/g, '/').replace(/~0/g, '~')]
        : undefined
      const rest = { ...v }
      delete rest.$ref
      if (!target || depth >= MAX_REF_DEPTH) return walk(rest, depth)
      return { ...(walk(target, depth + 1) as object), ...(walk(rest, depth) as object) }
    }
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (!DROP_KEYS.has(k)) out[k] = walk(x, depth)
    return out
  }
  const clean = walk(root, 0) as Record<string, unknown>
  return {
    ...clean,
    type: 'object',
    properties: isObj(clean.properties) ? clean.properties : {}
  } as unknown as JsonSchema
}

/** Definição no formato das tools do app (a descrição como o servidor mandou). */
export function mcpToolDefinition(e: McpToolEntry): ToolDefinition {
  const desc =
    e.tool.description?.trim() || e.tool.title || e.tool.annotations?.title || e.tool.name
  return {
    type: 'function',
    function: {
      name: e.wire as ToolDefinition['function']['name'],
      description: desc,
      parameters: mcpInputSchema(e.tool.inputSchema)
    }
  }
}

/** Instruções dos servidores ligadas no chat, como vão no fim do system prompt (null = nada). */
export function mcpInstructionsBlock(
  servers: readonly McpServerDef[],
  choices: Record<string, McpServerChoice>
): string | null {
  const parts: string[] = []
  for (const s of servers) {
    const c = choices[s.id]
    const text = s.tools?.instructions?.trim()
    if (c?.on && c.instructions && text)
      parts.push(
        `<mcp_server_instructions server="${s.name}">\n${text}\n</mcp_server_instructions>`
      )
  }
  return parts.length ? parts.join('\n\n') : null
}

// ---------------- resultado ----------------

export interface McpResultView {
  /** Texto para o modelo (todas as partes em texto, na ordem). */
  text: string
  /** Imagens (base64) — o main as grava como anexo e manda como parts. */
  images: { data: string; mimeType: string }[]
  isError: boolean
}

const MAX_INLINE_BLOB = 2000

/** `CallToolResult` (qualquer era) → texto + imagens. Sem conteúdo e com `structuredContent` → JSON. */
export function mcpResultView(result: unknown): McpResultView {
  const r = isObj(result) ? result : {}
  const parts: string[] = []
  const images: McpResultView['images'] = []
  const content = Array.isArray(r.content) ? r.content : []
  for (const c of content) {
    if (!isObj(c)) continue
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    else if (c.type === 'image' && typeof c.data === 'string') {
      const mimeType = typeof c.mimeType === 'string' ? c.mimeType : 'image/png'
      images.push({ data: c.data, mimeType })
      parts.push(`[imagem ${mimeType}]`)
    } else if (c.type === 'audio') {
      parts.push(`[áudio ${typeof c.mimeType === 'string' ? c.mimeType : ''} — não suportado]`)
    } else if (c.type === 'resource_link' && typeof c.uri === 'string') {
      const label = typeof c.title === 'string' ? c.title : typeof c.name === 'string' ? c.name : ''
      parts.push(`[recurso${label ? ` "${label}"` : ''}: ${c.uri}]`)
    } else if (c.type === 'resource' && isObj(c.resource)) {
      const res = c.resource
      const uri = typeof res.uri === 'string' ? res.uri : ''
      if (typeof res.text === 'string') parts.push(`[recurso ${uri}]\n${res.text}`)
      else if (typeof res.blob === 'string')
        parts.push(
          `[recurso binário ${uri} ${typeof res.mimeType === 'string' ? res.mimeType : ''} — ${Math.round((res.blob.length * 3) / 4)} bytes${res.blob.length <= MAX_INLINE_BLOB ? '' : ', não incluído'}]`
        )
    }
  }
  if (!parts.length && r.structuredContent !== undefined)
    parts.push(JSON.stringify(r.structuredContent, null, 2))
  return { text: parts.join('\n\n') || '(sem conteúdo)', images, isError: r.isError === true }
}

// ---------------- elicitação (o servidor pede dados ao usuário) ----------------

export type McpFieldKind = 'text' | 'number' | 'integer' | 'boolean' | 'select' | 'multiselect'

export interface McpFormField {
  key: string
  title: string
  description?: string
  kind: McpFieldKind
  required: boolean
  options?: { value: string; label: string }[]
  default?: unknown
  /** text: email | uri | date | date-time. */
  format?: string
  min?: number
  max?: number
}

export interface McpForm {
  message: string
  fields: McpFormField[]
}

/** Pedido de elicitação (modo formulário) → campos do card. null = esquema que não sabemos mostrar. */
export function mcpFormFromRequest(params: unknown): McpForm | null {
  const p = isObj(params) ? params : {}
  const message = typeof p.message === 'string' ? p.message : ''
  const schema = isObj(p.requestedSchema) ? p.requestedSchema : { properties: {} }
  const props = isObj(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((x) => typeof x === 'string') : []
  )
  const fields: McpFormField[] = []
  for (const [key, raw] of Object.entries(props)) {
    if (!isObj(raw)) return null
    const base = {
      key,
      title: typeof raw.title === 'string' && raw.title ? raw.title : key,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      required: required.has(key),
      ...(raw.default !== undefined ? { default: raw.default } : {})
    }
    const enumOpts = (vals: unknown, names?: unknown): McpFormField['options'] =>
      Array.isArray(vals)
        ? vals.map((v, i) => ({
            value: String(v),
            label: Array.isArray(names) && typeof names[i] === 'string' ? names[i] : String(v)
          }))
        : undefined
    const oneOf = (list: unknown): McpFormField['options'] =>
      Array.isArray(list)
        ? list.filter(isObj).map((o) => ({
            value: String(o.const),
            label: typeof o.title === 'string' ? o.title : String(o.const)
          }))
        : undefined
    if (raw.type === 'string' && (raw.enum || raw.oneOf)) {
      fields.push({
        ...base,
        kind: 'select',
        options: oneOf(raw.oneOf) ?? enumOpts(raw.enum, raw.enumNames)
      })
    } else if (raw.type === 'array' && isObj(raw.items)) {
      const it = raw.items
      const options = oneOf(it.anyOf ?? it.oneOf) ?? enumOpts(it.enum)
      if (!options) return null
      fields.push({
        ...base,
        kind: 'multiselect',
        options,
        ...(typeof raw.minItems === 'number' ? { min: raw.minItems } : {}),
        ...(typeof raw.maxItems === 'number' ? { max: raw.maxItems } : {})
      })
    } else if (raw.type === 'string') {
      fields.push({
        ...base,
        kind: 'text',
        ...(typeof raw.format === 'string' ? { format: raw.format } : {}),
        ...(typeof raw.minLength === 'number' ? { min: raw.minLength } : {}),
        ...(typeof raw.maxLength === 'number' ? { max: raw.maxLength } : {})
      })
    } else if (raw.type === 'number' || raw.type === 'integer') {
      fields.push({
        ...base,
        kind: raw.type,
        ...(typeof raw.minimum === 'number' ? { min: raw.minimum } : {}),
        ...(typeof raw.maximum === 'number' ? { max: raw.maximum } : {})
      })
    } else if (raw.type === 'boolean') {
      fields.push({ ...base, kind: 'boolean' })
    } else return null
  }
  return { message, fields }
}

/**
 * Respostas do card → `content` do resultado (só os campos preenchidos, nos tipos do esquema).
 * Devolve os erros por campo (pt-BR) quando algo não vale.
 */
export function mcpFormContent(
  form: McpForm,
  values: Record<string, unknown>
): { content: Record<string, unknown>; errors: Record<string, string> } {
  const content: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const f of form.fields) {
    const v = values[f.key]
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
    if (empty) {
      if (f.required && f.kind !== 'boolean') errors[f.key] = 'Obrigatório.'
      else if (f.kind === 'boolean' && f.required) content[f.key] = false
      continue
    }
    if (f.kind === 'number' || f.kind === 'integer') {
      const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
      if (!Number.isFinite(n) || (f.kind === 'integer' && !Number.isInteger(n)))
        errors[f.key] = f.kind === 'integer' ? 'Use um número inteiro.' : 'Use um número.'
      else if (f.min !== undefined && n < f.min) errors[f.key] = `Mínimo ${f.min}.`
      else if (f.max !== undefined && n > f.max) errors[f.key] = `Máximo ${f.max}.`
      else content[f.key] = n
    } else if (f.kind === 'boolean') content[f.key] = v === true || v === 'true'
    else if (f.kind === 'select') {
      const s = String(v)
      if (f.options && !f.options.some((o) => o.value === s)) errors[f.key] = 'Escolha uma opção.'
      else content[f.key] = s
    } else if (f.kind === 'multiselect') {
      const list = (Array.isArray(v) ? v : [v]).map(String)
      if (f.min !== undefined && list.length < f.min) errors[f.key] = `Escolha pelo menos ${f.min}.`
      else if (f.max !== undefined && list.length > f.max)
        errors[f.key] = `Escolha no máximo ${f.max}.`
      else content[f.key] = list
    } else {
      const s = String(v)
      if (f.min !== undefined && s.length < f.min) errors[f.key] = `Pelo menos ${f.min} caracteres.`
      else if (f.max !== undefined && s.length > f.max)
        errors[f.key] = `No máximo ${f.max} caracteres.`
      else content[f.key] = s
    }
  }
  return { content, errors }
}

// ---------------- importação (Claude Desktop / Claude Code / Cursor / VS Code) ----------------

export interface McpImportItem {
  name: string
  transport: McpTransport
  /** Aviso (ex.: transporte SSE antigo tratado como HTTP). */
  note?: string
}

/**
 * JSON de configuração de outro app → itens importáveis: `{"mcpServers": {...}}` (Claude Desktop,
 * Claude Code `.mcp.json`, Cursor), `{"servers": {...}}` (VS Code) ou o mapa direto. Nomes viram
 * nomes curtos únicos (contra `taken`). Erro legível quando nada serve.
 */
export function parseMcpImport(
  text: string,
  taken: readonly string[] = []
): { items: McpImportItem[]; skipped: string[] } | { error: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { error: `JSON inválido: ${(e as Error).message}` }
  }
  if (!isObj(json)) return { error: 'O JSON precisa ser um objeto.' }
  const map = isObj(json.mcpServers) ? json.mcpServers : isObj(json.servers) ? json.servers : json
  const items: McpImportItem[] = []
  const skipped: string[] = []
  const names = [...taken]
  for (const [label, raw] of Object.entries(map)) {
    if (!isObj(raw)) {
      skipped.push(label)
      continue
    }
    const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : ''
    let transport: McpTransport | null = null
    let note: string | undefined
    if (typeof raw.command === 'string' && (!type || type === 'stdio'))
      transport = normalizeMcpTransport({ ...raw, type: 'stdio' })
    else if (typeof (raw.url ?? raw.serverUrl) === 'string') {
      transport = normalizeMcpTransport({
        type: 'http',
        url: raw.url ?? raw.serverUrl,
        headers: raw.headers
      })
      if (type === 'sse')
        note = 'SSE (transporte antigo): conectado como HTTP, com o SSE de reserva.'
    }
    if (!transport) {
      skipped.push(label)
      continue
    }
    const name = uniqueMcpName(label, names)
    names.push(name)
    items.push({ name, transport, ...(note ? { note } : {}) })
  }
  if (!items.length && !skipped.length) return { error: 'Nenhum servidor no JSON.' }
  return { items, skipped }
}
