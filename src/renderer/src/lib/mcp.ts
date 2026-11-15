// Conectores (MCP) na UI — partes PURAS (sem React/DOM): estado legível de um conector, o nome do
// modelo (`mcp__<servidor>__<tool>`) de volta para servidor + tool, chips das dicas do servidor, a
// escolha por persona/chat (`ChatConfig.mcpServers`), os resumos das seções e o rascunho do
// formulário de cadastro. Os tipos e regras do protocolo ficam em @shared/mcp.
import {
  MCP_TOOL_PREFIX,
  mcpLabel,
  mcpToolEntries,
  mcpWireName,
  normalizeMcpChoices,
  validateMcpName,
  type McpApprovalMode,
  type McpServerChoice,
  type McpServerDef,
  type McpServerInput,
  type McpServerView,
  type McpToolEntry,
  type McpToolInfo
} from '@shared/mcp'
import type { ChatConfig } from '@shared/types'
import type { SectionSummary } from './configSummary'

/** Nome de tool para mostrar: `mcp__servidor__tool` → "servidor · tool" (o resto como está). */
export function toolDisplayName(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const rest = name.slice(5)
  const i = rest.indexOf('__')
  return i > 0 ? `${rest.slice(0, i)} · ${rest.slice(i + 2)}` : rest
}

export const MCP_MODES: readonly McpApprovalMode[] = ['ask', 'smart', 'always']

export const MCP_MODE_LABEL: Record<McpApprovalMode, string> = {
  ask: 'Perguntar',
  smart: 'Smart-Approve',
  always: 'Sempre permitir'
}

export const MCP_MODE_HINT: Record<McpApprovalMode, string> = {
  ask: 'Cada chamada pede sua confirmação no chat.',
  smart:
    'O juiz do Smart-Approve do chat decide (vê o servidor, a tool e o que o servidor declara); sem modelo, pergunta.',
  always: 'Roda sem perguntar.'
}

export type McpTone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent'

export interface McpStatusInfo {
  /** Estado curto (data-state na UI e nos testes). */
  key:
    | 'ready'
    | 'connecting'
    | 'error'
    | 'needs-auth'
    | 'not-activated'
    | 'command-changed'
    | 'phone'
    | 'idle'
  label: string
  tone: McpTone
  /** Detalhe (tooltip): o erro inteiro. */
  detail?: string
}

/** Primeira linha do erro, cortada (o inteiro vai no tooltip / no log). */
export function shortError(err: string, max = 64): string {
  const line = err.split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Estado deste aparelho como a lista de Conectores mostra. */
export function mcpStatusInfo(v: Pick<McpServerView, 'status'>): McpStatusInfo {
  const s = v.status
  if (s.state === 'unavailable' || s.unavailable) {
    if (s.unavailable === 'command-changed')
      return {
        key: 'command-changed',
        label: 'Comando mudou — ative de novo',
        tone: 'warning',
        detail:
          'O comando ou os argumentos mudaram desde que você ativou neste computador: confira e ative de novo.'
      }
    if (s.unavailable === 'phone')
      return { key: 'phone', label: 'Só no computador', tone: 'neutral' }
    return { key: 'not-activated', label: 'Não ativado neste computador', tone: 'warning' }
  }
  switch (s.state) {
    case 'ready': {
      const n = s.toolCount ?? 0
      return {
        key: 'ready',
        label: `Conectado (${n} ${n === 1 ? 'tool' : 'tools'})`,
        tone: 'success'
      }
    }
    case 'connecting':
      return { key: 'connecting', label: 'Conectando…', tone: 'accent' }
    case 'needs-auth':
      return {
        key: 'needs-auth',
        label: 'Precisa entrar',
        tone: 'warning',
        ...(s.error ? { detail: s.error } : {})
      }
    case 'error':
      return {
        key: 'error',
        label: s.error ? `Erro: ${shortError(s.error, 48)}` : 'Erro',
        tone: 'danger',
        ...(s.error ? { detail: s.error } : {})
      }
    default:
      return { key: 'idle', label: 'Desconectado', tone: 'neutral' }
  }
}

/** Chip do transporte. */
export function mcpTransportLabel(s: Pick<McpServerDef, 'transport'>): string {
  return s.transport.type === 'stdio' ? 'local (stdio)' : 'remoto (HTTP)'
}

/**
 * Por que um conector não roda NESTE aparelho (painel do chat: linha esmaecida + chip). null = roda
 * (ou pode rodar: HTTP sem erro de login, stdio ativado).
 */
export function mcpUnavailableReason(v: Pick<McpServerView, 'status'>): string | null {
  const s = v.status
  if (s.unavailable === 'not-activated') return 'não ativado aqui'
  if (s.unavailable === 'command-changed') return 'comando mudou'
  if (s.unavailable === 'phone') return 'só no computador'
  if (s.state === 'needs-auth') return 'precisa entrar'
  return null
}

/** O servidor entra na request daqui (mesma regra do main: stdio ativado; HTTP sempre)? */
export const mcpRunsHere = (v: Pick<McpServerView, 'status'>): boolean => !v.status.unavailable

/** Rótulo de uma tool: título do servidor → título das anotações → nome. */
export function mcpToolTitle(t: Pick<McpToolInfo, 'name' | 'title' | 'annotations'>): string {
  return t.title || t.annotations?.title || t.name
}

export interface McpToolRef {
  server: McpServerDef | null
  tool: McpToolInfo | null
  /** Nome curto do servidor (do cadastro ou, sem ele, o pedaço do nome do modelo). */
  serverName: string
  /** Rótulo do servidor (título do cadastro ou o nome). */
  serverLabel: string
  /** Nome original da tool (ou o pedaço do nome do modelo). */
  toolName: string
  /** Rótulo da tool (título → nome). */
  toolTitle: string
}

/**
 * Nome do modelo (`mcp__<servidor>__<tool>`) → servidor e tool do cadastro (o cache das tools). Sem
 * o servidor no cadastro (apagado, de outro aparelho ainda não sincronizado) → os pedaços do nome.
 */
export function resolveMcpTool(
  wire: string,
  servers: readonly McpServerDef[] | null | undefined
): McpToolRef | null {
  if (!wire.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = wire.slice(MCP_TOOL_PREFIX.length)
  let server: McpServerDef | null = null
  for (const s of servers ?? [])
    if (rest.startsWith(`${s.name}__`) && (!server || s.name.length > server.name.length))
      server = s
  const sep = rest.indexOf('__')
  const serverName = server?.name ?? (sep > 0 ? rest.slice(0, sep) : rest)
  const part = server ? rest.slice(server.name.length + 2) : sep > 0 ? rest.slice(sep + 2) : ''
  const list = server?.tools?.tools ?? []
  const tool =
    list.find((t) => mcpWireName(serverName, t.name) === wire) ??
    list.find((t) => t.name === part) ??
    null
  const toolName = tool?.name ?? part
  return {
    server,
    tool,
    serverName,
    serverLabel: server ? mcpLabel(server) : serverName,
    toolName,
    toolTitle: tool ? mcpToolTitle(tool) : toolName
  }
}

export interface McpHintChip {
  label: string
  tone: 'success' | 'danger' | 'neutral'
  tip: string
}

const HINT_NOTE = 'Dica declarada pelo servidor — não confiável: não libera nada sozinha.'

/** Chips das anotações da tool (só as que o servidor declarou). */
export function mcpHintChips(t: Pick<McpToolInfo, 'annotations'>): McpHintChip[] {
  const a = t.annotations ?? {}
  const out: McpHintChip[] = []
  if (a.readOnlyHint === true)
    out.push({ label: 'somente leitura', tone: 'success', tip: `Não altera nada. ${HINT_NOTE}` })
  if (a.destructiveHint === true && a.readOnlyHint !== true)
    out.push({
      label: 'destrutiva',
      tone: 'danger',
      tip: `Pode apagar ou sobrescrever. ${HINT_NOTE}`
    })
  if (a.idempotentHint === true)
    out.push({
      label: 'idempotente',
      tone: 'neutral',
      tip: `Repetir não muda o resultado. ${HINT_NOTE}`
    })
  if (a.openWorldHint === true)
    out.push({
      label: 'mundo aberto',
      tone: 'neutral',
      tip: `Fala com sistemas externos. ${HINT_NOTE}`
    })
  return out
}

// ---------------- escolha por persona/chat ----------------

export function mcpChoicesOf(
  cfg: Pick<ChatConfig, 'mcpServers'> | null | undefined
): Record<string, McpServerChoice> {
  return normalizeMcpChoices(cfg?.mcpServers)
}

export function mcpChoiceOf(
  cfg: Pick<ChatConfig, 'mcpServers'> | null | undefined,
  id: string
): McpServerChoice {
  return mcpChoicesOf(cfg)[id] ?? { on: false }
}

/** Mapa `mcpServers` com a escolha de um servidor trocada (desligado sem nada próprio → some). */
export function withMcpChoice(
  cfg: Pick<ChatConfig, 'mcpServers'> | null | undefined,
  id: string,
  choice: McpServerChoice
): Record<string, McpServerChoice> {
  const next = { ...mcpChoicesOf(cfg) }
  const off = [...new Set(choice.off ?? [])]
  const c: McpServerChoice = {
    on: choice.on,
    ...(off.length ? { off } : {}),
    ...(choice.instructions ? { instructions: true } : {})
  }
  if (!c.on && !c.off && !c.instructions) delete next[id]
  else next[id] = c
  return next
}

/** Liga/desliga uma tool de um servidor (desligar = entra em `off`). */
export function withMcpTool(choice: McpServerChoice, tool: string, on: boolean): McpServerChoice {
  const off = new Set(choice.off ?? [])
  if (on) off.delete(tool)
  else off.add(tool)
  return { ...choice, off: [...off] }
}

/** Resumo da seção Conectores (painel/persona). */
export function mcpSummary(
  cfg: Pick<ChatConfig, 'mcpServers'>,
  views: readonly McpServerView[] | null
): SectionSummary {
  const choices = mcpChoicesOf(cfg)
  const on = (views ?? []).filter((v) => choices[v.server.id]?.on)
  if (!on.length) return { text: 'desligados', changed: false }
  const blocked = on.filter((v) => !mcpRunsHere(v) || v.status.state === 'needs-auth').length
  return {
    text: `${on.length} ${on.length === 1 ? 'ligado' : 'ligados'}${blocked ? ` · ${blocked} ${blocked === 1 ? 'indisponível' : 'indisponíveis'} aqui` : ''}`,
    changed: true
  }
}

/** Resumo de "Ajustes dos conectores". */
export function mcpDetailsSummary(
  cfg: Pick<ChatConfig, 'mcpServers' | 'mcpSubagents'>,
  views: readonly McpServerView[] | null
): SectionSummary {
  const choices = mcpChoicesOf(cfg)
  const ids = new Set((views ?? []).map((v) => v.server.id))
  let off = 0
  let instr = 0
  for (const [id, c] of Object.entries(choices)) {
    if (!ids.has(id)) continue
    off += c.off?.length ?? 0
    if (c.instructions) instr++
  }
  const changes: string[] = []
  if (off) changes.push(`${off} ${off === 1 ? 'tool desligada' : 'tools desligadas'}`)
  if (instr) changes.push(`instruções de ${instr}`)
  if (cfg.mcpSubagents) changes.push('nos subagentes')
  return changes.length
    ? { text: changes.join(' · '), changed: true }
    : { text: 'todas as tools · sem instruções', changed: false }
}

/** Tools que vão na request deste chat neste aparelho (a mesma regra do main, sobre o cache). */
export function mcpEntriesHere(
  cfg: Pick<ChatConfig, 'mcpServers'>,
  views: readonly McpServerView[] | null
): McpToolEntry[] {
  const here = (views ?? []).filter(mcpRunsHere).map((v) => v.server)
  return mcpToolEntries(here, mcpChoicesOf(cfg), (s) => s.tools?.tools ?? null)
}

// ---------------- formulário de cadastro ----------------

export interface McpKv {
  key: string
  value: string
}

export interface McpDraft {
  title: string
  name: string
  /** O nome foi editado à mão (senão segue o título). */
  nameTouched: boolean
  type: 'stdio' | 'http'
  command: string
  /** Um argumento por linha. */
  args: string
  env: McpKv[]
  cwd: string
  url: string
  headers: McpKv[]
  oauth: boolean
  /** Segundos (vazio = padrão). */
  timeout: string
}

const kvOf = (m: Record<string, string> | undefined): McpKv[] =>
  Object.entries(m ?? {}).map(([key, value]) => ({ key, value }))

export function emptyMcpDraft(): McpDraft {
  return {
    title: '',
    name: '',
    nameTouched: false,
    type: 'stdio',
    command: '',
    args: '',
    env: [],
    cwd: '',
    url: '',
    headers: [],
    oauth: false,
    timeout: ''
  }
}

export function mcpDraftOf(s: McpServerDef): McpDraft {
  const t = s.transport
  return {
    ...emptyMcpDraft(),
    title: s.title ?? '',
    name: s.name,
    nameTouched: true,
    type: t.type,
    ...(t.type === 'stdio'
      ? { command: t.command, args: t.args.join('\n'), env: kvOf(t.env), cwd: t.cwd ?? '' }
      : { url: t.url, headers: kvOf(t.headers), oauth: !!s.oauth }),
    timeout: s.timeoutMs ? String(Math.round(s.timeoutMs / 1000)) : ''
  }
}

/** Argumentos do campo (um por linha; linhas vazias ignoradas). */
export function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

function kvMap(
  rows: McpKv[],
  what: string,
  errors: Record<string, string>,
  field: string
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (!k && !r.value) continue
    if (!k) {
      errors[field] = `${what}: falta o nome.`
      continue
    }
    if (k in out) errors[field] = `${what}: “${k}” repetido.`
    out[k] = r.value
  }
  return out
}

/**
 * Rascunho → entrada do IPC, ou os erros por campo (pt-BR). `taken` = nomes de OUTROS conectores.
 */
export function mcpDraftToInput(
  d: McpDraft,
  taken: readonly string[]
): { input: McpServerInput } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const name = d.name.trim()
  const nameErr = validateMcpName(name)
  if (nameErr) errors.name = nameErr
  else if (taken.includes(name)) errors.name = `Já existe um conector chamado “${name}”.`
  let transport: McpServerInput['transport']
  if (d.type === 'stdio') {
    const command = d.command.trim()
    if (!command) errors.command = 'Informe o comando.'
    const env = kvMap(d.env, 'Variável', errors, 'env')
    const cwd = d.cwd.trim()
    transport = {
      type: 'stdio',
      command,
      args: parseArgsText(d.args),
      env,
      ...(cwd ? { cwd } : {})
    }
  } else {
    const url = d.url.trim()
    if (!/^https?:\/\/\S+$/i.test(url)) errors.url = 'Use um endereço http:// ou https://.'
    const headers = kvMap(d.headers, 'Cabeçalho', errors, 'headers')
    transport = { type: 'http', url, headers }
  }
  let timeoutMs: number | undefined
  if (d.timeout.trim()) {
    const n = Number(d.timeout.replace(',', '.'))
    if (!Number.isFinite(n) || n < 1) errors.timeout = 'Use segundos (1 ou mais).'
    else timeoutMs = Math.round(n * 1000)
  }
  if (Object.keys(errors).length) return { errors }
  return {
    input: {
      name,
      title: d.title.trim(),
      transport,
      oauth: d.type === 'http' && d.oauth,
      // 0 apaga o teto próprio (o cadastro só guarda ≥ 1 s)
      timeoutMs: timeoutMs ?? 0
    }
  }
}

/** Ajuste deste computador (stdio) a partir do rascunho; null = sem ajuste. */
export interface McpOverrideDraft {
  args: string
  useArgs: boolean
  env: McpKv[]
  cwd: string
  useCwd: boolean
}

export function mcpOverrideDraftOf(
  o: { args?: string[]; env?: Record<string, string>; cwd?: string } | undefined
): McpOverrideDraft {
  return {
    args: (o?.args ?? []).join('\n'),
    useArgs: !!o?.args,
    env: kvOf(o?.env),
    cwd: o?.cwd ?? '',
    useCwd: o?.cwd !== undefined
  }
}

export function mcpOverrideOf(
  d: McpOverrideDraft
): { args?: string[]; env?: Record<string, string>; cwd?: string } | null {
  const env: Record<string, string> = {}
  for (const r of d.env) if (r.key.trim()) env[r.key.trim()] = r.value
  const out = {
    ...(d.useArgs ? { args: parseArgsText(d.args) } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(d.useCwd ? { cwd: d.cwd.trim() } : {})
  }
  return Object.keys(out).length ? out : null
}
