// Busca nativa de ferramentas (protocolo 1.12.0 — SYNC_PROTOCOL.md §4.3.6 "Busca nativa de
// ferramentas", §4.3.8 "Blocos nativos do provedor", §4.4 `toolSearchCaps`).
//
// Com a compactação ligada e pelo menos uma tool fora de `toolsFull`, cada request escolhe o MODO de
// envio das tools (derivado — nunca gravado na config):
//   - native-anthropic : provedor `anthropic` no host oficial, modelo Claude 4.5+ → todas as tools
//     completas, as fora de `toolsFull` com `defer_loading: true`, e a busca do servidor
//     (`tool_search_tool_regex_20251119`) por último. Sem prompt fixo e sem a nossa `tool_search`.
//   - native-openrouter: provedor `openrouter` (host oficial), modelo servido pela Messages API e
//     chat compatível com ela → a request vai para `<baseUrl>/messages` com as mesmas regras e
//     `{ type: 'openrouter:tool_search' }`.
//   - local            : qualquer outro caso (genérico, host de terceiros, modelo sem suporte, modo
//     texto, chat incompatível com a Messages API, ou depois de uma falha lembrada) → a compactação
//     de 1.11.0 (descrição curta, a nossa `tool_search`, prompt fixo). A UI avisa.
//   - off              : nada a compactar/adiar (compactação desligada, todas completas, sem tools).
//
// Transparência ("nada oculto vai ao modelo"): nos modos nativos não há texto do app no system
// prompt; a UI mostra o modo, o motivo e os itens exatos (com `defer_loading`) e a entrada de busca.
//
// Puro (sem Node/Electron/DOM): o desktop (request, runner, UI) e o mobile (vendora este arquivo)
// resolvem igual — mesmo chat, mesmo modo nos dois aparelhos.
import type { ProviderKind } from './providerKinds'
import { LEGACY_SEARCH_TOOL, SEARCH_TOOL, type ToolDefinition } from './tools'
import {
  TOOL_ALIASES,
  type ApiMessage,
  type ChatConfig,
  type ContentPart,
  type ModelInfo,
  type NativeTurn,
  type ToolSearchMode
} from './types'

export type { NativeTurn, ToolSearchMode }

export type NativeToolSearchMode = 'native-anthropic' | 'native-openrouter'

/** Formato da request: Chat Completions (`/chat/completions`) ou Messages API (`/messages`). */
export type WireApi = 'chat' | 'messages'

export const isNativeMode = (m: unknown): m is NativeToolSearchMode =>
  m === 'native-anthropic' || m === 'native-openrouter'

// ---------------- entradas de busca do servidor ----------------

/** Busca do servidor da Anthropic (variante regex) — último item do array `tools`. */
export const ANTHROPIC_SEARCH_TOOL: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'tool_search_tool_regex_20251119',
  name: 'tool_search_tool_regex'
})

/** Busca do servidor do OpenRouter (forma canônica, vale em qualquer modelo) — último item. */
export const OPENROUTER_SEARCH_TOOL: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'openrouter:tool_search'
})

/** Entrada de busca do modo (cópia nova a cada chamada); null fora dos modos nativos. */
export function searchToolEntry(mode: ToolSearchMode): Record<string, unknown> | null {
  if (mode === 'native-anthropic') return { ...ANTHROPIC_SEARCH_TOOL }
  if (mode === 'native-openrouter') return { ...OPENROUTER_SEARCH_TOOL }
  return null
}

// ---------------- hosts e modelos ----------------

export const ANTHROPIC_OFFICIAL_HOST = 'api.anthropic.com'
export const OPENROUTER_OFFICIAL_HOST = 'openrouter.ai'

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * O modelo da Anthropic tem a tool search do servidor? Tabela da Anthropic ("Tool search tool":
 * Claude 4.5 ou mais novo — Haiku 4.5 inclusive; Opus 4.1 e anteriores não). Regra por versão para
 * os próximos modelos valerem sozinhos. 'unknown' (alias próprio, nome fora do padrão) é tratado
 * como sim — a queda para a versão local cobre o erro.
 */
export function anthropicToolSearchSupport(model: string): 'yes' | 'no' | 'unknown' {
  const m = model
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, '')
    .replace(/\./g, '-')
  if (/^claude-(instant|2|3)/.test(m)) return 'no'
  // Opus/Sonnet 4.0 (claude-opus-4-20250514, claude-sonnet-4-0, …) e Opus 4.1
  if (/^claude-(opus|sonnet)-4(-0)?(-\d{8})?(@.*)?$/.test(m)) return 'no'
  if (/^claude-opus-4-1(?!\d)/.test(m)) return 'no'
  if (/^claude-(opus|sonnet|haiku)-4-[5-9](?!\d)/.test(m)) return 'yes'
  if (/^claude-(opus|sonnet|haiku|fable|mythos)-([5-9]|\d{2,})(?!\d)/.test(m)) return 'yes'
  if (/^claude-(fable|mythos)/.test(m)) return 'yes'
  return 'unknown'
}

// ---------------- compatibilidade com a Messages API do OpenRouter ----------------

/** Parâmetros do chat que a Messages API não tem (só a Chat Completions). */
export const CC_ONLY_PARAMS = [
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed'
] as const

/** Chaves de `extraBody` que só existem na Chat Completions do OpenRouter. */
export const CC_ONLY_EXTRA_KEYS: readonly string[] = [
  'reasoning',
  'transforms',
  'usage',
  'stream_options',
  'response_format',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'min_p',
  'top_a',
  'prediction',
  'verbosity',
  'modalities',
  'audio',
  'messages',
  'tool_choice',
  'parallel_tool_calls'
]

/** Mídia no histórico que vai na request (depois da fronteira de compactação). */
export interface SentMedia {
  audio?: boolean
  pdf?: boolean
}

function safeJsonObject(s: string | undefined): Record<string, unknown> | null {
  if (!s || !s.trim()) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Por que o chat não pode ir pela Messages API do OpenRouter (pt-BR; [] = pode): áudio na entrada
 * (a Messages API não tem bloco de áudio), PDF num modelo sem leitura nativa (o file-parser vale na
 * Chat Completions), parâmetros e chaves de `extraBody` que só a Chat Completions tem.
 */
export function messagesBlockers(i: {
  cfg: Pick<ChatConfig, 'params'>
  info?: Pick<ModelInfo, 'inputModalities'> | null
  sent?: SentMedia | null
}): string[] {
  const out: string[] = []
  if (i.sent?.audio) out.push('o chat tem áudio na entrada')
  const mods = i.info?.inputModalities
  if (i.sent?.pdf && mods && !mods.includes('file'))
    out.push('o chat tem PDF e o modelo não lê PDF nativamente')
  const params = (i.cfg.params ?? {}) as Record<string, unknown>
  const ccParams = CC_ONLY_PARAMS.filter((k) => params[k] != null)
  if (ccParams.length) out.push(`parâmetros só da Chat Completions: ${ccParams.join(', ')}`)
  const extra = safeJsonObject(i.cfg.params?.extraBody)
  const ccKeys = extra ? Object.keys(extra).filter((k) => CC_ONLY_EXTRA_KEYS.includes(k)) : []
  if (ccKeys.length) out.push(`extraBody com chaves só da Chat Completions: ${ccKeys.join(', ')}`)
  return out
}

/**
 * Áudio/PDF nas mensagens que vão na request (quem chama passa o histórico ativo — da fronteira de
 * compactação em diante, sem as mensagens só de exibição).
 */
export function sentMediaOf(messages: readonly ApiMessage[]): SentMedia {
  const out: SentMedia = {}
  for (const m of messages) {
    const c = (m as { content?: unknown }).content
    if (!Array.isArray(c)) continue
    for (const p of c as ContentPart[]) {
      if (p.type === 'input_audio') out.audio = true
      else if (
        p.type === 'file' &&
        (p._attachment?.kind === 'pdf' ||
          /\.pdf$/i.test(p.file.filename) ||
          p.file.file_data.startsWith('data:application/pdf'))
      )
        out.pdf = true
    }
  }
  return out
}

// ---------------- falhas lembradas (toolSearchCaps, local do dispositivo) ----------------

/** Setting local (NUNCA sincronizado, §4.4). */
export const TOOL_SEARCH_CAPS_SETTING = 'toolSearchCaps'
/** Uma falha vale por 24 h; depois o modo nativo é tentado de novo. */
export const TOOL_SEARCH_CAPS_TTL_MS = 24 * 60 * 60 * 1000

export interface ToolSearchFailure {
  /** Modo nativo que o provedor recusou. */
  mode: NativeToolSearchMode
  failedAt: number
  /** Erro curto do provedor. */
  error: string
}
/** `<providerId>\u0000<model>` → a falha (só as recusas que a versão local resolveu). */
export type ToolSearchCaps = Record<string, ToolSearchFailure>

export const capsKey = (providerId: string, model: string): string => `${providerId}\u0000${model}`

/** Lê o setting de qualquer valor (entradas inválidas fora). */
export function normalizeToolSearchCaps(v: unknown): ToolSearchCaps {
  const out: ToolSearchCaps = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
    const f = e as Partial<ToolSearchFailure> | null
    if (!f || typeof f !== 'object' || !isNativeMode(f.mode) || typeof f.failedAt !== 'number')
      continue
    out[k] = {
      mode: f.mode,
      failedAt: f.failedAt,
      error: typeof f.error === 'string' ? f.error : ''
    }
  }
  return out
}

/** Falha ainda válida (< 24 h) do provedor+modelo; null = tentar o nativo. */
export function activeFailure(
  caps: ToolSearchCaps | null | undefined,
  providerId: string,
  model: string,
  now = Date.now()
): ToolSearchFailure | null {
  const f = caps?.[capsKey(providerId, model)]
  if (!f) return null
  return now - f.failedAt < TOOL_SEARCH_CAPS_TTL_MS && f.failedAt <= now + 60_000 ? f : null
}

/** Caps com a falha nova (e sem as vencidas). */
export function withFailure(
  caps: ToolSearchCaps | null | undefined,
  providerId: string,
  model: string,
  failure: ToolSearchFailure,
  now = Date.now()
): ToolSearchCaps {
  const out: ToolSearchCaps = {}
  for (const [k, f] of Object.entries(caps ?? {}))
    if (now - f.failedAt < TOOL_SEARCH_CAPS_TTL_MS) out[k] = f
  out[capsKey(providerId, model)] = { ...failure, error: failure.error.slice(0, 300) }
  return out
}

/**
 * O erro de uma request NATIVA pode ser recusa do modo (vale tentar a versão local uma vez)? HTTP
 * 400/404/422, salvo estouro de contexto (aconteceria igual na versão local). Só vira falha lembrada
 * se a repetição local der certo — um erro do próprio pedido (extraBody inválido…) falha nos dois.
 */
export function isNativeRejection(status: number | undefined, message: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false
  return !/context (length|window)|prompt is too long|too many (input )?tokens|maximum context/i.test(
    message
  )
}

// ---------------- resolução do modo ----------------

export interface ToolSearchModeInput {
  kind: ProviderKind
  baseUrl: string
  providerId: string
  model: string
  /** Item do /models (OpenRouter: `endpoints`, `inputModalities`). Ausente = desconhecido. */
  info?: Pick<ModelInfo, 'endpoints' | 'inputModalities'> | null
  cfg: Pick<
    ChatConfig,
    'nativeTools' | 'toolsInPrompt' | 'toolsPromptText' | 'toolsCompact' | 'params'
  >
  /** A versão local compactaria ao menos uma tool (= há o que adiar). */
  wouldCompact: boolean
  /** Áudio/PDF no histórico enviado. */
  sent?: SentMedia | null
  /** Falhas lembradas deste dispositivo. */
  caps?: ToolSearchCaps | null
  now?: number
  /** Hosts extras tratados como oficiais (testes com provedor falso local). */
  extraHosts?: readonly string[]
}

export interface ToolSearchModeResult {
  mode: ToolSearchMode
  api: WireApi
  /** Por que não é a busca nativa (pt-BR), na versão local. */
  reason?: string
  /** Falha lembrada que levou à versão local. */
  failure?: ToolSearchFailure
}

/** dd/mm/aaaa hh:mm no fuso do aparelho (sem depender de Intl). */
function shortDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const failureReason = (model: string, f: ToolSearchFailure): string =>
  `a busca nativa falhou com ${model} em ${shortDate(f.failedAt)}${f.error ? ` (${f.error.slice(0, 120)})` : ''}; nova tentativa 24 h depois`

/**
 * Modo de envio das tools desta request (primeira regra que vale):
 * 1. sem tools chegando ao modelo, compactação desligada ou nada a compactar → off;
 * 2. texto das tools gerado no system prompt (modo texto) → local;
 * 3. `anthropic`: host oficial, modelo com suporte, sem falha lembrada → native-anthropic;
 * 4. `openrouter`: host oficial, chat compatível com a Messages API, modelo servido por ela (os
 *    `endpoints` do /models; desconhecido = sim), sem falha lembrada → native-openrouter;
 * 5. o resto → local (com o motivo).
 */
export function resolveToolSearchMode(i: ToolSearchModeInput): ToolSearchModeResult {
  const cfg = i.cfg
  const generatedText = cfg.toolsInPrompt && cfg.toolsPromptText == null
  const local = (reason: string, failure?: ToolSearchFailure): ToolSearchModeResult => ({
    mode: 'local',
    api: i.kind === 'anthropic' ? 'messages' : 'chat',
    reason,
    ...(failure ? { failure } : {})
  })
  if (!(cfg.nativeTools || generatedText) || cfg.toolsCompact === false || !i.wouldCompact)
    return { mode: 'off', api: i.kind === 'anthropic' ? 'messages' : 'chat' }
  if (generatedText) return local('a lista de tools vai no texto do system prompt')
  const host = hostOf(i.baseUrl)
  const official = (h: string): boolean =>
    host === h || (!!host && (i.extraHosts ?? []).includes(host))
  const failure = activeFailure(i.caps, i.providerId, i.model, i.now ?? Date.now())
  if (i.kind === 'anthropic') {
    if (!official(ANTHROPIC_OFFICIAL_HOST))
      return local(
        `endpoint compatível com a Anthropic que não é a API oficial (${host ?? i.baseUrl})`
      )
    if (anthropicToolSearchSupport(i.model) === 'no')
      return local(`${i.model} não tem a busca nativa (só Claude 4.5 ou mais novo)`)
    if (failure) return local(failureReason(i.model, failure), failure)
    return { mode: 'native-anthropic', api: 'messages' }
  }
  if (i.kind === 'openrouter') {
    if (!official(OPENROUTER_OFFICIAL_HOST))
      return local(`endpoint do tipo OpenRouter que não é o oficial (${host ?? i.baseUrl})`)
    const blockers = messagesBlockers({ cfg, info: i.info, sent: i.sent })
    if (blockers.length)
      return local(`o chat precisa da Chat Completions do OpenRouter: ${blockers.join('; ')}`)
    const eps = i.info?.endpoints
    if (eps && !eps.includes('/api/v1/messages'))
      return local(`${i.model} não é servido pela Messages API do OpenRouter`)
    if (failure) return local(failureReason(i.model, failure), failure)
    return { mode: 'native-openrouter', api: 'messages' }
  }
  return local('provedor OpenAI-compatible genérico, sem busca nativa de tools')
}

// ---------------- itens do array tools (formato da Messages API) ----------------

/** Item `tools[]` da Messages API de uma definição completa (adiada → `defer_loading: true`). */
export function messagesApiTool(def: ToolDefinition, deferred = false): Record<string, unknown> {
  return {
    name: def.function.name,
    description: def.function.description,
    input_schema: def.function.parameters,
    ...(deferred ? { defer_loading: true } : {})
  }
}

/**
 * Array `tools` de um modo nativo: as definições completas na ordem do app, cada uma com a própria
 * flag; a entrada de busca do servidor por último; com cache, o `cache_control` vai na ÚLTIMA tool
 * NÃO adiada do app (a API recusa nas adiadas; sem nenhuma, o breakpoint do system cobre as tools).
 */
export function nativeToolsArray(
  defs: readonly ToolDefinition[],
  o: { deferred: ReadonlySet<string>; entry: Record<string, unknown> | null; cache?: boolean }
): Record<string, unknown>[] {
  const out = defs.map((d) => messagesApiTool(d, o.deferred.has(d.function.name)))
  if (o.cache) {
    for (let i = out.length - 1; i >= 0; i--)
      if (!out[i].defer_loading) {
        out[i] = { ...out[i], cache_control: { type: 'ephemeral' } }
        break
      }
  }
  if (o.entry) out.push({ ...o.entry })
  return out
}

// ---------------- blocos nativos (gravação) ----------------

const PLAIN_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use'])
const isThinkingBlock = (b: Record<string, unknown>): boolean =>
  b.type === 'thinking' || b.type === 'redacted_thinking'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * `native` de uma resposta: os blocos na ordem, sem pensamento — só se veio algum bloco de
 * ferramenta do servidor (tipo fora de text/thinking/redacted_thinking/tool_use); senão null (o
 * caso comum: nada a gravar). O chamador só chama num modo nativo, com o stream completo.
 */
export function nativeTurnFrom(
  blocks: readonly Record<string, unknown>[] | null | undefined,
  ch: { providerId: string; kind: 'anthropic' | 'openrouter'; model: string }
): NativeTurn | null {
  const list = (blocks ?? []).filter(
    (b): b is Record<string, unknown> => !!b && typeof b === 'object' && typeof b.type === 'string'
  )
  if (!list.some((b) => !PLAIN_BLOCKS.has(b.type as string))) return null
  return {
    v: 1,
    api: 'anthropic-messages',
    providerId: ch.providerId,
    kind: ch.kind,
    model: ch.model,
    content: clone(list.filter((b) => !isThinkingBlock(b)))
  }
}

// ---------------- blocos nativos (reenvio) ----------------

/** Nome como vai no fio: `search_tool` (≤ 1.11.0) → `tool_search`; o resto como está. */
export const wireToolName = (name: string): string =>
  name === LEGACY_SEARCH_TOOL ? SEARCH_TOOL : name

const aliased = (n: unknown): string =>
  typeof n === 'string'
    ? Object.prototype.hasOwnProperty.call(TOOL_ALIASES, n)
      ? TOOL_ALIASES[n]
      : n
    : ''

/** Argumentos de uma tool call como objeto (mesma tolerância do adaptador da Anthropic). */
export function argsObject(args: string | undefined | null): Record<string, unknown> {
  const s = (args ?? '').trim()
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }
  } catch {
    return { raw: s }
  }
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

type AssistantMessage = Extract<ApiMessage, { role: 'assistant' }>

/**
 * `native` ainda bate com a forma canônica? Texto = os blocos `text` concatenados; `tool_calls` =
 * os `tool_use` na ordem (mesmo id, mesmo nome — com os aliases —, mesmo input). Uma edição do texto
 * ou dos argumentos (aqui, num controle remoto, num app antigo, ou o encurtamento da compactação)
 * deixa de bater: a mensagem vai pela conversão normal.
 */
export function nativeConsistent(m: ApiMessage): boolean {
  if (m.role !== 'assistant') return false
  const n = m.native
  if (!n || n.v !== 1 || n.api !== 'anthropic-messages' || !Array.isArray(n.content)) return false
  const blocks = n.content.filter((b) => !!b && typeof b === 'object')
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('')
  if (text !== (m.content ?? '')) return false
  const uses = blocks.filter((b) => b.type === 'tool_use')
  const calls = m.tool_calls ?? []
  if (uses.length !== calls.length) return false
  return uses.every((u, i) => {
    const c = calls[i]
    return (
      u.id === c.id &&
      aliased(u.name) === aliased(c.function.name) &&
      canonical(u.input ?? {}) === canonical(argsObject(c.function.arguments))
    )
  })
}

/** Canal da request (o reenvio só vale para o mesmo provedor, API e modelo). */
export interface NativeChannel {
  mode: NativeToolSearchMode
  providerId: string
  model: string
}

/** `native` desta mensagem pode ir no lugar da conversão normal, neste canal? */
export function replayableNative(
  m: ApiMessage,
  ch: NativeChannel
): m is AssistantMessage & {
  native: NativeTurn
} {
  if (m.role !== 'assistant' || !m.native) return false
  const n = m.native
  return (
    n.providerId === ch.providerId &&
    n.model === ch.model &&
    n.api === 'anthropic-messages' &&
    n.kind === (ch.mode === 'native-anthropic' ? 'anthropic' : 'openrouter') &&
    nativeConsistent(m)
  )
}

/**
 * Cópia dos blocos sem as referências a tools fora de `names` (as que não estão no array `tools`
 * da request: a API recusa uma referência a tool ausente). Lista vazia é uma forma válida.
 */
export function filterToolReferences(
  content: readonly Record<string, unknown>[],
  names: ReadonlySet<string>
): Record<string, unknown>[] {
  return content.map((b) => {
    const c = b.content as { tool_references?: unknown } | undefined
    if (b.type !== 'tool_search_tool_result' || !c || !Array.isArray(c.tool_references))
      return clone(b)
    return clone({
      ...b,
      content: {
        ...c,
        tool_references: (c.tool_references as Record<string, unknown>[]).filter(
          (r) => typeof r?.tool_name === 'string' && names.has(r.tool_name)
        )
      }
    })
  })
}

/** Nomes que um resultado opaco do OpenRouter revela (melhor esforço — o formato é do roteador). */
function openRouterResultNames(b: Record<string, unknown>): string[] {
  const c = b.content as Record<string, unknown> | undefined
  const out: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v)
  }
  for (const x of Array.isArray(c?.matches) ? (c!.matches as Record<string, unknown>[]) : []) {
    const def = x?.definition as Record<string, unknown> | undefined
    const fn = def?.function as Record<string, unknown> | undefined
    add(def?.name ?? fn?.name ?? x?.tool_id ?? x?.name)
  }
  for (const r of Array.isArray(c?.tool_references)
    ? (c!.tool_references as Record<string, unknown>[])
    : [])
    add(r?.tool_name)
  return out
}

/**
 * Tools que os blocos reenviados revelam ao modelo: as `tool_references` dos resultados da
 * Anthropic, os nomes legíveis de um resultado do OpenRouter e, depois de um resultado do
 * OpenRouter, as tools que o modelo chamou na mesma resposta (o roteador as revelou).
 */
export function discoveredByNative(content: readonly Record<string, unknown>[]): string[] {
  const out = new Set<string>()
  let afterOr = false
  for (const b of content) {
    if (b.type === 'tool_search_tool_result') {
      const refs = (b.content as { tool_references?: unknown } | undefined)?.tool_references
      if (Array.isArray(refs))
        for (const r of refs as Record<string, unknown>[])
          if (typeof r?.tool_name === 'string') out.add(r.tool_name)
    } else if (b.type === 'openrouter_tool_search_result') {
      afterOr = true
      for (const n of openRouterResultNames(b)) out.add(n)
    } else if (b.type === 'tool_use' && afterOr && typeof b.name === 'string') out.add(b.name)
  }
  return [...out]
}

/** Resultado de prepareNativeReplay. */
export interface NativeReplay {
  /** Cópias: `native` só nas que vão reenviadas (referências filtradas); fora das outras. */
  messages: ApiMessage[]
  /** Mensagens reenviadas com os blocos do provedor. */
  replayed: number
  /** Mensagens com `native` que foram pela conversão normal (outro canal, editadas, sem reenvio). */
  skipped: number
  /** Tools que os blocos reenviados revelam (o modelo já as conhece). */
  discovered: string[]
}

/**
 * Prepara o histórico de uma request nativa: cada assistente com `native` que pode ser reenviado
 * neste canal (mesmo provedor/API/modelo e ainda batendo com a forma canônica) leva os blocos com as
 * referências filtradas às tools de `toolNames` (o array `tools` da request); os outros perdem o
 * `native` (vão pela conversão normal). `ch` null = nenhum reenvio (repetição sem reenvio).
 */
export function prepareNativeReplay(
  messages: readonly ApiMessage[],
  ch: NativeChannel | null,
  toolNames: ReadonlySet<string>
): NativeReplay {
  let replayed = 0
  let skipped = 0
  const discovered = new Set<string>()
  const out = messages.map((m): ApiMessage => {
    if (m.role !== 'assistant' || !m.native) return m
    if (ch && replayableNative(m, ch)) {
      const content = filterToolReferences(m.native.content, toolNames)
      for (const n of discoveredByNative(content)) discovered.add(n)
      replayed++
      return { ...m, native: { ...m.native, content } }
    }
    skipped++
    const { native: _n, ...rest } = m
    void _n
    return rest
  })
  return { messages: out, replayed, skipped, discovered: [...discovered] }
}

/** Nomes (com os aliases) das tools chamadas nas mensagens. */
export function usedToolNames(messages: readonly ApiMessage[]): string[] {
  const out = new Set<string>()
  for (const m of messages)
    if (m.role === 'assistant')
      for (const t of m.tool_calls ?? []) out.add(aliased(t.function.name))
  return [...out]
}

/**
 * Adiadas que vão CARREGADAS nesta request: chamadas no histórico enviado sem que a descoberta delas
 * vá junto (`native` descartado, troca de modelo/provedor, histórico da versão local, corte da
 * compactação) — o modelo não pode ter usado uma tool que ele não vê.
 */
export function forceLoadedTools(
  messages: readonly ApiMessage[],
  deferred: readonly string[],
  discovered: readonly string[]
): string[] {
  const used = new Set(usedToolNames(messages))
  const known = new Set(discovered)
  return deferred.filter((n) => used.has(n) && !known.has(n))
}

/** Assistente editado (texto/argumentos) cujo `native` não bate mais → sem ele (cópia). */
export function withoutStaleNative<T extends ApiMessage>(m: T): T {
  if (m.role !== 'assistant' || !m.native || nativeConsistent(m)) return m
  const { native: _n, ...rest } = m as AssistantMessage
  void _n
  return rest as T
}

// ---------------- transcrição (chip) ----------------

export interface NativeSearch {
  /** Padrão/consulta da busca (o input do `server_tool_use`). */
  query?: string
  /** Tools encontradas (legíveis). */
  tools: string[]
  /** Resultado opaco (do OpenRouter) sem nomes legíveis. */
  opaque: boolean
}

/** Buscas de tools do servidor numa resposta (um item por `server_tool_use` com resultado). */
export function nativeSearches(native: NativeTurn | null | undefined): NativeSearch[] {
  if (!native || !Array.isArray(native.content)) return []
  const blocks = native.content.filter((b) => !!b && typeof b === 'object')
  const out: NativeSearch[] = []
  for (const b of blocks) {
    if (b.type !== 'server_tool_use') continue
    const input = (b.input ?? {}) as Record<string, unknown>
    const q = input.pattern ?? input.query ?? input.regex
    const res = blocks.find(
      (r) =>
        r !== b &&
        r.tool_use_id === b.id &&
        (r.type === 'tool_search_tool_result' || r.type === 'openrouter_tool_search_result')
    )
    if (!res) continue
    const tools =
      res.type === 'tool_search_tool_result'
        ? discoveredByNative([res])
        : openRouterResultNames(res)
    out.push({
      ...(typeof q === 'string' && q ? { query: q } : {}),
      tools,
      opaque: res.type === 'openrouter_tool_search_result' && !tools.length
    })
  }
  return out
}

/** Texto do chip na transcrição: "buscou tools: read_file, shell". */
export function nativeSearchChip(s: NativeSearch): string {
  if (s.tools.length) return `buscou tools: ${s.tools.join(', ')}`
  return s.opaque ? 'buscou tools (resultado do OpenRouter)' : 'buscou tools: nenhuma encontrada'
}

// ---------------- textos da UI (pt-BR) ----------------

export const TOOL_SEARCH_MODE_LABEL: Record<ToolSearchMode, string> = {
  'native-anthropic': 'Busca nativa da Anthropic',
  'native-openrouter': 'Busca nativa do OpenRouter (Messages API)',
  local: 'Versão local do app',
  off: 'Sem compactação'
}

/** Aviso da versão local (o protocolo exige que a UI avise, §4.3.6). */
export const TOOL_SEARCH_LOCAL_NOTICE =
  'Neste endpoint a compactação não usa a busca nativa do provedor — usa a versão local do app (descrições curtas, a tool_search e uma instrução fixa).'

/** Rótulo curto no rodapé de uma resposta (`meta.toolSearch`). */
export function toolSearchMetaLabel(t: { mode: string; fallbackFrom?: string }): string | null {
  if (t.mode === 'native-anthropic') return 'busca nativa · Anthropic'
  if (t.mode === 'native-openrouter') return 'busca nativa · OpenRouter'
  if (t.mode === 'local')
    return t.fallbackFrom ? 'tools: versão local (a busca nativa falhou)' : 'tools: versão local'
  return null
}

/** Linha de status do modo na aba Tools. */
export function toolSearchStatus(mode: ToolSearchMode, deferred: number): string {
  const n = `${deferred} tool${deferred === 1 ? '' : 's'}`
  if (mode === 'native-anthropic')
    return `${n} vão completas e adiadas (defer_loading); o modelo as encontra com a busca do servidor da Anthropic (tool_search_tool_regex). Sem instrução extra no system prompt.`
  if (mode === 'native-openrouter')
    return `${n} vão completas e adiadas (defer_loading); o modelo as encontra com openrouter:tool_search. Enquanto houver tools adiadas, este chat usa a Messages API do OpenRouter (/messages). Sem instrução extra no system prompt.`
  if (mode === 'local')
    return `${n} vão compactas (+ tool_search e uma instrução curta no fim do system prompt)`
  return 'Todas as ligadas vão completas'
}

/** Quem escreveu a descrição da entrada de busca (para o </>). */
export const SEARCH_ENTRY_NOTE: Record<NativeToolSearchMode, string> = {
  'native-anthropic':
    'A descrição dessa ferramenta é da Anthropic (não do app); o app não acrescenta prompt.',
  'native-openrouter':
    'A descrição dessa ferramenta é do OpenRouter (não do app); o app não acrescenta prompt.'
}

// ---------------- visão para a UI (aba Tools) ----------------

/**
 * O que a aba Tools mostra sobre o envio das tools (desktop: IPC `agent.toolSearchMode`; mobile:
 * calculado no próprio aparelho com as mesmas funções).
 */
export interface ToolSearchModeView {
  mode: ToolSearchMode
  /** "Busca nativa da Anthropic" / "…do OpenRouter (Messages API)" / "Versão local do app" / … */
  label: string
  /** Por que não é a busca nativa (versão local). */
  reason?: string
  /** Falha lembrada (versão local por causa dela). */
  failure?: ToolSearchFailure
  /** Adiadas (modos nativos) e compactas (versão local). */
  deferred: string[]
  compacted: string[]
  /** Tipo do provedor (para a forma dos itens). */
  kind: ProviderKind
  /** Nativos: o item EXATO de `tools[]` de cada tool da request (flags e cache inclusive). */
  items: Record<string, Record<string, unknown>>
  /** Nativos: a entrada de busca do servidor, como vai (último item de `tools`). */
  searchEntry: Record<string, unknown> | null
}

/** Monta a visão a partir do modo resolvido e do plano das tools daquele modo. */
export function toolSearchView(
  r: ToolSearchModeResult,
  plan: {
    mode: ToolSearchMode
    full: readonly ToolDefinition[]
    deferred: readonly string[]
    compacted: readonly string[]
    searchEntry: Record<string, unknown> | null
  },
  kind: ProviderKind,
  cache: boolean
): ToolSearchModeView {
  const items: Record<string, Record<string, unknown>> = {}
  if (isNativeMode(plan.mode)) {
    const arr = nativeToolsArray(plan.full, {
      deferred: new Set(plan.deferred),
      entry: null,
      cache
    })
    for (const it of arr) items[String(it.name)] = it
  }
  return {
    mode: plan.mode,
    label: TOOL_SEARCH_MODE_LABEL[plan.mode],
    ...(plan.mode === 'local' && r.reason ? { reason: r.reason } : {}),
    ...(plan.mode === 'local' && r.failure ? { failure: r.failure } : {}),
    deferred: [...plan.deferred],
    compacted: [...plan.compacted],
    kind,
    items,
    searchEntry: plan.searchEntry
  }
}
