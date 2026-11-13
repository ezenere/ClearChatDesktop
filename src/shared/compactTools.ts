// Tools compactadas (protocolo 1.11.0, SYNC_PROTOCOL.md §4.3.6 — "Tools compactadas e `datetime`"):
// para economizar contexto, cada tool enviada ao modelo que não está em `toolsFull` vai COMPACTA —
// só o nome e uma descrição curta do app (1 a 20 palavras) com um esquema de parâmetros vazio que
// aceita qualquer objeto. Havendo pelo menos uma compacta, a request ganha a `search_tool` (sempre
// completa: devolve a definição completa — exatamente como iria sem compactação — das tools pedidas)
// e um prompt fixo curto no fim do system prompt. Sem nenhuma compacta, nem uma nem outro.
//
// Transparência ("nada oculto vai ao modelo"): o prompt fixo, a definição da `search_tool` e a
// descrição curta de cada tool são textos do app, não editáveis, mostrados na UI (aba Tools).
//
// Puro (sem Node/Electron/DOM): o desktop (request, execução, UI) e o mobile (vendora este arquivo)
// montam e executam igual. Quem chama passa as definições COMPLETAS como seriam enviadas (já
// ajustadas ao provedor — `toolDefinitionFor`, shell detectado, as do celular definidas no mobile).
import {
  END_CALL_TOOL,
  MEMORY_TOOL_NAMES,
  SEARCH_TOOL,
  SKILL_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  type JsonSchema,
  type JsonSchemaProp,
  type ToolDefinition
} from './tools'
import { PHONE_TOOLS, PHONE_TOOL_SHORT, orderedTools } from './deviceTools'
import { TOOL_ALIASES, type ChatConfig, type ToolName } from './types'

// ---------------- textos do app (visíveis na UI, não editáveis) ----------------

/**
 * Descrição curta de cada tool (o que vai no lugar da definição completa quando ela vai compacta):
 * 1 a 20 palavras, pt-BR, sem detalhes de uso — só o bastante para o modelo saber quando ler a
 * definição com `search_tool`. As do celular ficam em @shared/deviceTools (PHONE_TOOL_SHORT).
 * `end_call` e `search_tool` nunca vão compactas (sem descrição curta).
 */
export const TOOL_SHORT_DESCRIPTIONS: Record<string, string> = {
  list_dir: 'Lista arquivos e pastas de um diretório, com o tamanho dos arquivos.',
  read_file:
    'Lê arquivos de texto (linhas numeradas, por faixas), imagens e PDFs, inclusive saídas grandes salvas de outras ferramentas.',
  search_files: 'Busca texto ou regex no conteúdo dos arquivos, com caminho, linha e trecho.',
  find_files: 'Encontra arquivos e pastas pelo nome ou por padrão glob.',
  present_file:
    'Mostra ao usuário um arquivo (documento, imagem, página, PDF) no visualizador do app.',
  write_file: 'Cria ou sobrescreve um arquivo com o conteúdo dado.',
  edit_file: 'Edita um arquivo substituindo trechos exatos de texto.',
  shell: 'Roda um comando no terminal do usuário e devolve a saída e o código de saída.',
  process_start:
    'Inicia um processo em segundo plano (servidor, watcher, emulador) que continua rodando.',
  process_logs: 'Lê os logs de um processo iniciado com process_start.',
  process_list: 'Lista os processos em segundo plano deste chat.',
  process_stop: 'Para um processo em segundo plano deste chat.',
  web_search: 'Pesquisa na web e devolve títulos, links e trechos dos resultados.',
  browse_url: 'Abre uma URL e devolve o conteúdo principal da página em Markdown.',
  list_models:
    'Lista os modelos disponíveis nos provedores configurados (para escolher o de um subagente).',
  delegate_task:
    'Delega uma tarefa a um subagente, em primeiro ou segundo plano, com modelo opcional.',
  get_chat_info:
    'Informações deste chat: título, modelo, provedor, diretório raiz e ids da sessão.',
  list_chats: 'Lista os outros chats do app, com id, título, modelo e status.',
  send_to_chat: 'Envia uma mensagem a outro chat como se fosse o usuário.',
  read_history:
    'Busca ou lê mensagens antigas do histórico, inclusive de antes de uma compactação ou de outros chats.',
  check_subagents: 'Mostra o status e os resultados dos subagentes desta sessão.',
  wait_subagents: 'Espera subagentes em segundo plano terminarem e devolve os resultados.',
  cancel_subagent: 'Cancela um subagente em andamento.',
  message_subagent:
    'Envia uma mensagem a um subagente ou a um irmão, opcionalmente esperando a resposta.',
  ask_user: 'Mostra ao usuário um questionário de múltipla escolha e espera as respostas.',
  datetime: 'Data e hora atuais do aparelho, no fuso dele, com formato opcional.',
  memory_search: 'Busca nas memórias ativas sobre o usuário, pessoas e projetos.',
  memory_read: 'Lê memórias completas pelos ids ou slugs.',
  memory_write: 'Cria ou atualiza uma memória com fatos duráveis sobre o usuário.',
  memory_rewrite: 'Corrige uma memória de coleção só de leitura, criando uma versão atualizada.',
  memory_delete: 'Apaga uma memória gravável que ficou errada ou obsoleta.',
  list_skills: 'Lista as skills instaladas (instruções especializadas) e quando usar cada uma.',
  skill_load: 'Carrega uma skill: instruções completas, lista de arquivos e caminho da pasta.',
  skill_read: 'Lê um arquivo de dentro da pasta de uma skill.',
  ...PHONE_TOOL_SHORT
}

/** Prompt fixo acrescentado ao fim do system prompt (linha em branco antes) havendo tool compacta. */
export const COMPACT_TOOLS_PROMPT =
  'Algumas ferramentas foram enviadas compactadas: só o nome e uma descrição curta, sem os parâmetros. Antes de usar uma ferramenta compactada pela primeira vez, leia a definição completa dela com search_tool (dá para pedir várias de uma vez).'

/** Uma linha (UI) sobre o que a compactação faz. */
export const COMPACT_TOOLS_HELP =
  'Economiza contexto: cada tool vai só com o nome e uma descrição curta, e o modelo lê a definição completa com search_tool quando precisar.'

/** Definição da `search_tool` (sempre completa). */
export const SEARCH_TOOL_DEFINITION: ToolDefinition = TOOL_DEFINITIONS.search_tool

/** Esquema de parâmetros de uma tool compacta: vazio, aceita qualquer objeto (todos os provedores). */
export const COMPACT_PARAMETERS: JsonSchema = { type: 'object', properties: {} }

/**
 * Tools que podem ir compactas (todas menos `end_call` e `search_tool`), na ordem das unidades
 * `toolsFull.<tool>`: as de `enabledTools` (as do celular inclusive), memória e skills.
 */
export const COMPACTABLE_TOOL_NAMES: readonly ToolName[] = [
  ...TOOL_NAMES,
  ...MEMORY_TOOL_NAMES,
  ...SKILL_TOOL_NAMES,
  ...PHONE_TOOLS
]

/** Palavras de um texto (para a regra de 1 a 20 palavras das descrições curtas). */
export const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length

// ---------------- config ----------------

type CompactConfig = Pick<ChatConfig, 'toolsCompact' | 'toolsFull'>

/** Nome antigo → atual (`bash` → `shell`); só as chaves próprias do mapa (nada do protótipo). */
const aliased = (n: string): string =>
  Object.prototype.hasOwnProperty.call(TOOL_ALIASES, n) ? TOOL_ALIASES[n] : n

/** "Enviar tools compactadas" ligado? (ausente = true, o padrão do app). */
export const compactToolsOn = (cfg: Partial<CompactConfig> | null | undefined): boolean =>
  cfg?.toolsCompact !== false

/** A tool pode ir compacta? (`end_call` e `search_tool` vão sempre completas.) */
export const isCompactable = (name: string): boolean =>
  name !== END_CALL_TOOL && name !== SEARCH_TOOL

/**
 * `toolsFull` lido de qualquer valor: só textos, nomes antigos mapeados, sem duplicatas, sem as que
 * nunca vão compactas (`search_tool` — leitores a ignoram lá —, `end_call`); ordem do app, as
 * desconhecidas (de outra versão/aparelho) no fim, na ordem em que vieram. Ausente = [].
 */
export function normalizeToolsFull(v: unknown): ToolName[] {
  if (!Array.isArray(v)) return []
  const seen = v
    .filter((t): t is string => typeof t === 'string' && !!t)
    .map(aliased)
    .filter(isCompactable)
  return orderedTools(new Set(seen), seen, COMPACTABLE_TOOL_NAMES)
}

/**
 * Marca/desmarca "vai completa" numa lista `toolsFull` sem perder nada (as desconhecidas ficam, no
 * fim) — como `withTool` faz com `enabledTools`.
 */
export function withFullTool(list: unknown, name: string, full: boolean): ToolName[] {
  const cur = Array.isArray(list) ? list.filter((t): t is string => typeof t === 'string') : []
  const set = new Set(full ? [...cur, name] : cur.filter((t) => t !== name))
  return orderedTools(set, [...cur, name], COMPACTABLE_TOOL_NAMES)
}

/** A tool vai compacta com esta config? */
export function sendsCompact(
  name: string,
  cfg: Partial<CompactConfig> | null | undefined
): boolean {
  return (
    compactToolsOn(cfg) &&
    isCompactable(name) &&
    !(normalizeToolsFull(cfg?.toolsFull) as string[]).includes(name)
  )
}

// ---------------- definições ----------------

/**
 * Descrição curta de uma tool. Sem uma do app (tool de outra versão/aparelho): a 1ª frase da
 * descrição completa, cortada em 20 palavras.
 */
export function shortToolDescription(name: string, full?: string): string {
  // só as próprias do mapa (um nome como "constructor" não pode cair no protótipo)
  const own = Object.prototype.hasOwnProperty.call(TOOL_SHORT_DESCRIPTIONS, name)
    ? TOOL_SHORT_DESCRIPTIONS[name]
    : undefined
  if (own) return own
  const text = (full ?? '').trim()
  const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text
  const words = first.split(/\s+/).filter(Boolean)
  return words.length > 20 ? `${words.slice(0, 20).join(' ')}…` : words.join(' ') || name
}

/** Definição compacta: o nome + a descrição curta, com o esquema vazio. */
export function compactToolDefinition(def: ToolDefinition): ToolDefinition {
  const name = def.function.name
  return {
    type: 'function',
    function: {
      name,
      description: shortToolDescription(name, def.function.description),
      parameters: { ...COMPACT_PARAMETERS, properties: {} }
    }
  }
}

/** Definição como vai na request com esta config (compacta ou a completa recebida). */
export function sentToolDefinition(
  def: ToolDefinition,
  cfg: Partial<CompactConfig> | null | undefined
): ToolDefinition {
  return sendsCompact(def.function.name, cfg) ? compactToolDefinition(def) : def
}

/** O que vai na request: definições (na ordem), quais foram compactadas e o prompt fixo. */
export interface ToolsPlan {
  /** Itens do array `tools` (ou do texto das tools), na ordem; `search_tool` por último. */
  definitions: ToolDefinition[]
  /** Definições completas das tools enviadas (sem a `search_tool`), na mesma ordem. */
  full: ToolDefinition[]
  /** Nomes das que foram compactas. */
  compacted: ToolName[]
  /** Prompt fixo para o fim do system prompt (null = nenhuma compacta). */
  prompt: string | null
}

/**
 * Plano das tools de uma request. `full` = as definições completas como iriam sem compactação (na
 * ordem do app; `end_call` inclusive). Determinístico (mesma entrada → mesmos bytes: prefixo de
 * cache estável). Uma `search_tool` que viesse em `full` é ignorada (nunca escolhível).
 */
export function planTools(
  full: readonly ToolDefinition[],
  cfg: Partial<CompactConfig> | null | undefined
): ToolsPlan {
  const defs = full.filter((d) => d.function.name !== SEARCH_TOOL)
  const compacted: ToolName[] = []
  const definitions = defs.map((d) => {
    if (!sendsCompact(d.function.name, cfg)) return d
    compacted.push(d.function.name)
    return compactToolDefinition(d)
  })
  if (!compacted.length) return { definitions, full: defs, compacted, prompt: null }
  return {
    definitions: [...definitions, SEARCH_TOOL_DEFINITION],
    full: defs,
    compacted,
    prompt: COMPACT_TOOLS_PROMPT
  }
}

/** System prompt com o prompt fixo no fim (linha em branco antes); sem prompt → como está. */
export function withCompactPrompt(system: string, plan: Pick<ToolsPlan, 'prompt'>): string {
  if (!plan.prompt) return system
  return system ? `${system}\n\n${plan.prompt}` : plan.prompt
}

// ---------------- execução ----------------

export interface CompactToolResult {
  content: string
  status: 'ok' | 'error'
}

/** JSON da definição completa (`{name, description, parameters}`), como vai no `function` da tool. */
export const definitionJson = (def: ToolDefinition): string => JSON.stringify(def.function)

/**
 * Executa a `search_tool`: `{ names: string[] }` → a definição completa (descrição e esquema,
 * exatamente como iriam sem compactação) de cada tool pedida entre as enviadas (`full` do plano),
 * como um array JSON de `{name, description, parameters}`. Nome desconhecido → erro com a lista
 * das disponíveis (as encontradas vêm junto).
 */
export function runSearchTool(
  args: Record<string, unknown>,
  full: readonly ToolDefinition[]
): CompactToolResult {
  const raw = args.names ?? args.name
  const names = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim())
    .filter(Boolean)
  const available = full.map((d) => d.function.name).filter((n) => n !== SEARCH_TOOL)
  const list = `Disponíveis: ${available.join(', ') || '(nenhuma)'}.`
  if (!names.length)
    return {
      content: `Erro: informe "names" (lista com os nomes das ferramentas). ${list}`,
      status: 'error'
    }
  const found: ToolDefinition[] = []
  const unknown: string[] = []
  for (const n of [...new Set(names.map(aliased))]) {
    const d = full.find((x) => x.function.name === n && n !== SEARCH_TOOL)
    if (d) found.push(d)
    else unknown.push(n)
  }
  const json = `[${found.map(definitionJson).join(',')}]`
  if (!unknown.length) return { content: json, status: 'ok' }
  const what = unknown.length === 1 ? 'ferramenta desconhecida' : 'ferramentas desconhecidas'
  return {
    content: `Erro: ${what}: ${unknown.join(', ')}. ${list}${found.length ? `\n\nDefinições das encontradas:\n${json}` : ''}`,
    status: 'error'
  }
}

/**
 * Erro de argumentos de uma tool que foi COMPACTA: o texto do erro + a definição completa dela,
 * para o modelo se corrigir (protocolo 1.11.0: "argumentos inválidos → o resultado de erro DEVE
 * trazer a definição completa").
 */
export function withFullDefinition(error: string, def: ToolDefinition): string {
  return `${error}\n\nA ferramenta ${def.function.name} foi enviada compactada; a definição completa dela é:\n${definitionJson(def)}`
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** Confere um valor contra o esquema (tolerante: números/booleanos em texto passam). */
function checkValue(v: unknown, s: JsonSchemaProp | JsonSchema, path: string, out: string[]): void {
  if (v === undefined || v === null) return
  switch (s.type) {
    case 'string':
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        out.push(`"${path}" deve ser texto`)
        return
      }
      if ('enum' in s && s.enum && !s.enum.includes(String(v)))
        out.push(`"${path}" deve ser um de: ${s.enum.join(', ')}`)
      return
    case 'number':
    case 'integer':
      if (
        typeof v !== 'number' &&
        !(typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
      )
        out.push(`"${path}" deve ser um número`)
      return
    case 'boolean':
      if (typeof v !== 'boolean' && v !== 'true' && v !== 'false')
        out.push(`"${path}" deve ser true ou false`)
      return
    case 'array': {
      if (!Array.isArray(v)) {
        out.push(`"${path}" deve ser uma lista`)
        return
      }
      const p = s as JsonSchemaProp
      if (p.minItems !== undefined && v.length < p.minItems)
        out.push(`"${path}" precisa de pelo menos ${p.minItems} itens`)
      if (p.maxItems !== undefined && v.length > p.maxItems)
        out.push(`"${path}" aceita no máximo ${p.maxItems} itens`)
      if (p.items) v.forEach((x, i) => checkValue(x, p.items!, `${path}[${i}]`, out))
      return
    }
    case 'object': {
      if (!isPlain(v)) {
        out.push(`"${path}" deve ser um objeto`)
        return
      }
      checkObject(v, s, `${path}.`, out)
      return
    }
  }
}

function checkObject(
  v: Record<string, unknown>,
  s: Pick<JsonSchemaProp, 'properties' | 'required' | 'additionalProperties'>,
  prefix: string,
  out: string[]
): void {
  const props = s.properties ?? {}
  for (const r of s.required ?? [])
    if (v[r] === undefined || v[r] === null) out.push(`falta "${prefix}${r}" (obrigatório)`)
  for (const [k, x] of Object.entries(v)) {
    const p = Object.prototype.hasOwnProperty.call(props, k) ? props[k] : undefined
    if (!p) {
      if (s.additionalProperties === false) out.push(`parâmetro desconhecido: "${prefix}${k}"`)
      continue
    }
    checkValue(x, p, `${prefix}${k}`, out)
  }
}

/**
 * Problemas dos argumentos contra a definição completa (obrigatórios ausentes, parâmetros
 * desconhecidos quando o esquema não aceita outros, tipos e `enum`). Tolerante a números/booleanos
 * escritos como texto (as tools aceitam). [] = válidos.
 */
export function validateToolArgs(def: ToolDefinition, args: Record<string, unknown>): string[] {
  const out: string[] = []
  checkObject(args, def.function.parameters, '', out)
  return out
}

/**
 * Erro de uma tool que foi COMPACTA e falhou (a tool roda com os argumentos como vierem — cada uma
 * tem as tolerâncias dela, ex.: `present_file` aceita `files` como texto ou `path` solto): se os
 * argumentos não batem com o esquema, o erro da própria tool ganha os problemas e a definição
 * completa; se batem (o erro é de outra coisa — arquivo inexistente…), fica como está.
 */
export function compactToolErrorText(
  toolError: string,
  def: ToolDefinition,
  args: Record<string, unknown>
): string {
  const problems = validateToolArgs(def, args)
  if (!problems.length) return toolError
  return withFullDefinition(
    `${toolError}\n\nOs argumentos não seguem o esquema de ${def.function.name}: ${problems.join('; ')}.`,
    def
  )
}

/** Texto do erro de argumentos inválidos de uma tool compacta (problemas + definição completa). */
export function invalidArgsText(def: ToolDefinition, problems: readonly string[]): string {
  return withFullDefinition(
    `Erro: argumentos inválidos para ${def.function.name}: ${problems.join('; ')}.`,
    def
  )
}
