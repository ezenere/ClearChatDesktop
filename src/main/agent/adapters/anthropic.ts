// Adaptador 'anthropic': API nativa da Anthropic (POST {baseUrl}/messages, GET {baseUrl}/models).
// Ver SPEC.md → "Adaptadores de provider". Funções puras (sem rede), exceto quem chama fetch.
// O histórico continua persistido no formato OpenAI; a conversão acontece só na cópia enviada.
// Também monta a Messages API do OpenRouter (`flavor: 'openrouter'`, busca nativa de tools —
// protocolo 1.12.0, @shared/toolSearch): mesmo formato de blocos, de SSE e de cache.
import { anthropicCapsReasoning } from '@shared/modelParams'
import { ANTHROPIC_VERSION } from '@shared/providerKinds'
import type { ApiMessage, ChatParams, ContentPart, ModelInfo, Provider, Usage } from '@shared/types'
import type { ToolDefinition } from '@shared/tools'
import { messagesApiTool } from '@shared/toolSearch'
import type { StreamAccumulator } from '../llm'

type CacheControl = { type: 'ephemeral' }

export type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string }
      cache_control?: CacheControl
    }
  | {
      type: 'document'
      source: { type: 'base64'; media_type: string; data: string }
      title?: string
      cache_control?: CacheControl
    }
  | {
      type: 'tool_use'
      id: string
      name: string
      input: Record<string, unknown>
      cache_control?: CacheControl
    }
  | {
      type: 'tool_result'
      tool_use_id: string
      /** string, ou blocos text/image/document (read_file de imagem/PDF). */
      content?: string | AnthropicBlock[]
      cache_control?: CacheControl
    }

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

/** max_tokens padrão (obrigatório na API) quando o chat não define um. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 32000

/** Teto de saída conhecido por família (modelos antigos têm limite menor que o padrão). */
export function anthropicDefaultMaxTokens(model: string): number {
  const m = model.toLowerCase()
  if (/claude-3-(haiku|opus|sonnet)/.test(m)) return 4096
  if (/claude-3-5/.test(m)) return 8192
  return ANTHROPIC_DEFAULT_MAX_TOKENS
}

export function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/messages`
}

/**
 * Headers nativos: x-api-key + anthropic-version (SEM Authorization), assinatura de app e por
 * último provider.headers (sobrescrevem).
 */
export function anthropicHeaders(
  provider: Pick<Provider, 'apiKey' | 'headers'>,
  appSignature: Record<string, string> = {}
): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION
  }
  if (provider.apiKey) h['x-api-key'] = provider.apiKey
  Object.assign(h, appSignature)
  for (const [k, v] of Object.entries(provider.headers ?? {})) {
    if (typeof v === 'string') h[k] = v
  }
  return h
}

/** Placeholder de áudio (a API não aceita áudio). */
export const audioPlaceholder = (name: string): string =>
  `[áudio não suportado por este provider: ${name}]`

/**
 * Troca parts input_audio por um texto placeholder ANTES de expandAttachments (o nome do anexo
 * ainda está em `_attachment`; e o arquivo nem precisa ser lido).
 */
export function dropAudioParts(messages: ApiMessage[]): ApiMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant' || typeof m.content === 'string' || !m.content) return m
    if (!m.content.some((p) => p.type === 'input_audio')) return m
    return {
      ...m,
      content: m.content.map((p): ContentPart =>
        p.type === 'input_audio'
          ? { type: 'text', text: audioPlaceholder(p._attachment?.name ?? 'áudio') }
          : p
      )
    } as ApiMessage
  })
}

const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s

/**
 * Tipos de bloco que aceitam `cache_control`. Blocos do servidor reenviados (`server_tool_use`,
 * `tool_search_tool_result`, `openrouter_tool_search_result`, …) nunca o recebem.
 */
const CACHEABLE = new Set(['text', 'image', 'document', 'tool_use', 'tool_result'])

function partToBlock(p: ContentPart): AnthropicBlock | null {
  // cache_control de um text part vem só das chamadas laterais (@shared/sideCache); o histórico
  // persistido nunca o tem (os breakpoints do chat são postos por applyAnthropicCache)
  if (p.type === 'text')
    return p.text
      ? {
          type: 'text',
          text: p.text,
          ...(p.cache_control ? { cache_control: p.cache_control } : {})
        }
      : null
  if (p.type === 'image_url') {
    const url = p.image_url.url
    const m = DATA_URL.exec(url)
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
    if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } }
    return { type: 'text', text: '[imagem indisponível]' }
  }
  if (p.type === 'file') {
    const m = DATA_URL.exec(p.file.file_data)
    if (m && m[1] === 'application/pdf')
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: m[2] }
      }
    return { type: 'text', text: `[arquivo não suportado por este provider: ${p.file.filename}]` }
  }
  if (p.type === 'input_audio') return { type: 'text', text: audioPlaceholder('áudio') }
  return null
}

function contentBlocks(c: string | ContentPart[] | null | undefined): AnthropicBlock[] {
  if (c == null) return []
  if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : []
  return c.map(partToBlock).filter((b): b is AnthropicBlock => !!b)
}

function parseInput(args: string): Record<string, unknown> {
  const s = (args ?? '').trim()
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }
  } catch {
    return { raw: s }
  }
}

export const EMPTY_USER_PLACEHOLDER = '[mensagem vazia]'

/**
 * Converte o histórico (formato OpenAI, já sanitizado e com anexos expandidos) para o formato
 * nativo: system → blocos top-level; tool_calls → tool_use; mensagens `tool` → blocos tool_result
 * num `user`; mensagens consecutivas do mesmo role mescladas (a API exige alternância); blocos de
 * texto vazios removidos; reasoning ignorado (sem assinatura não dá para reenviar).
 * `replayNative`: um assistente com `native` (já conferido e filtrado por quem monta a request —
 * @shared/toolSearch → prepareNativeReplay) vai com esses blocos, na ordem, no lugar da conversão.
 * `userIdx` = índices das mensagens nativas que contêm conteúdo de uma mensagem `user` real
 * (para o breakpoint de cache "última user").
 */
export function toAnthropicMessages(
  messages: ApiMessage[],
  opts: { replayNative?: boolean } = {}
): {
  system: AnthropicBlock[]
  messages: AnthropicMessage[]
  userIdx: number[]
} {
  const system: AnthropicBlock[] = []
  const out: AnthropicMessage[] = []
  const userFlag: boolean[] = []
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[], fromUser: boolean): void => {
    if (!blocks.length) return
    const last = out[out.length - 1]
    if (last && last.role === role) {
      // ordem cronológica: os tool_result vêm logo após o assistant → ficam no começo do user
      last.content.push(...blocks)
      if (fromUser) userFlag[out.length - 1] = true
      return
    }
    out.push({ role, content: blocks })
    userFlag.push(fromUser)
  }
  for (const m of messages) {
    if (m.role === 'system') {
      system.push(...contentBlocks(m.content).filter((b) => b.type === 'text'))
    } else if (m.role === 'user') {
      const blocks = contentBlocks(m.content)
      push('user', blocks.length ? blocks : [{ type: 'text', text: EMPTY_USER_PLACEHOLDER }], true)
    } else if (m.role === 'assistant' && opts.replayNative && m.native?.content.length) {
      // blocos do provedor como vieram (opacos para o app: server_tool_use, resultados da busca…)
      push(
        'assistant',
        m.native.content.map((b) => ({ ...b })) as unknown as AnthropicBlock[],
        false
      )
    } else if (m.role === 'assistant') {
      const blocks = contentBlocks(m.content)
      for (const t of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: t.id,
          name: t.function.name,
          input: parseInput(t.function.arguments)
        })
      }
      push('assistant', blocks, false)
    } else if (m.role === 'tool') {
      // tool_result aceita string ou blocos text/image/document (docs "Handle tool calls";
      // verificado com claude-haiku-4-5: imagem e PDF dentro do tool_result são lidos)
      const content: string | AnthropicBlock[] =
        typeof m.content === 'string' ? m.content : contentBlocks(m.content)
      push(
        'user',
        [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            ...(content.length ? { content } : {})
          }
        ],
        false
      )
    }
  }
  // A primeira mensagem precisa ser do usuário.
  if (out.length && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '[início da conversa]' }] })
    userFlag.unshift(false)
  }
  const userIdx = userFlag.flatMap((f, i) => (f ? [i] : []))
  return { system, messages: out, userIdx }
}

const mark = <T extends AnthropicBlock>(b: T): T => ({ ...b, cache_control: { type: 'ephemeral' } })

/**
 * Marca o último bloco CACHEÁVEL de uma mensagem nativa (na cópia) — recua por cima de blocos do
 * servidor reenviados (um turno pausado termina em `server_tool_use`).
 */
function markLast(m: AnthropicMessage): AnthropicMessage {
  const content = [...m.content]
  for (let i = content.length - 1; i >= 0; i--) {
    if (CACHEABLE.has(content[i].type)) {
      content[i] = mark(content[i])
      break
    }
  }
  return { ...m, content }
}

/**
 * Breakpoints de cache no formato nativo (máx. 4; usamos até 3): último bloco do system, último
 * bloco da última mensagem e da última mensagem com conteúdo de usuário (se for outra).
 */
export function applyAnthropicCache(
  system: AnthropicBlock[],
  messages: AnthropicMessage[],
  userIdx: number[]
): { system: AnthropicBlock[]; messages: AnthropicMessage[] } {
  const sys = system.length ? [...system.slice(0, -1), mark(system[system.length - 1])] : system
  const msgs = [...messages]
  if (msgs.length) msgs[msgs.length - 1] = markLast(msgs[msgs.length - 1])
  const lastUser = userIdx[userIdx.length - 1]
  if (lastUser !== undefined && lastUser !== msgs.length - 1)
    msgs[lastUser] = markLast(msgs[lastUser])
  return { system: sys, messages: msgs }
}

export function anthropicTools(defs: ToolDefinition[]): Record<string, unknown>[] {
  return defs.map((d) => messagesApiTool(d))
}

/**
 * Body nativo de /messages. Params: max_tokens (obrigatório), temperature, top_p, top_k,
 * reasoning_effort → `output_config: {effort}` (níveis já ajustados ao modelo pelo paramSupport;
 * a API só aceita low/medium/high/xhigh/max) e stop → stop_sequences; penalties/seed/repetition_penalty ignorados
 * (não existem na API). Quem chama já filtrou os params pelo modelo (@shared/modelParams) — aqui
 * vai o que vier. extraBody é mesclado por último.
 */
/**
 * reasoning_effort do chat → `output_config.effort`. O paramSupport já ajustou o valor para os
 * níveis do modelo (capabilities.effort / tabela); 'minimal' → 'low' fica só como rede de segurança.
 */
export function anthropicEffort(e: NonNullable<ChatParams['reasoning_effort']>): string {
  return e === 'minimal' ? 'low' : e
}

/**
 * Body de /messages. `flavor: 'openrouter'` (Messages API do OpenRouter — busca nativa de tools,
 * 1.12.0): `max_tokens` só se o chat definir (o padrão de 32000 é dos Claude; no OpenRouter é
 * opcional); effort "none" → `thinking: {type: "disabled"}` (o OpenRouter normaliza `thinking` e
 * `output_config.effort` para qualquer modelo). `toolsArray` (modos nativos): o array `tools` já
 * montado (definições com `defer_loading` + a entrada de busca do servidor — `nativeToolsArray`).
 */
export function buildAnthropicBody(input: {
  model: string
  messages: ApiMessage[]
  tools?: ToolDefinition[]
  toolsArray?: Record<string, unknown>[]
  params?: ChatParams & { stop?: string | string[] }
  cacheEnabled?: boolean
  extra?: Record<string, unknown> | null
  flavor?: 'anthropic' | 'openrouter'
  replayNative?: boolean
}): Record<string, unknown> {
  const conv = toAnthropicMessages(input.messages, { replayNative: input.replayNative })
  const { system, messages } = input.cacheEnabled
    ? applyAnthropicCache(conv.system, conv.messages, conv.userIdx)
    : conv
  const params = input.params ?? {}
  const ok = (v: unknown): v is number => typeof v === 'number' && !Number.isNaN(v)
  const openRouter = input.flavor === 'openrouter'
  const body: Record<string, unknown> = { model: input.model }
  if (ok(params.max_tokens)) body.max_tokens = params.max_tokens
  else if (!openRouter) body.max_tokens = anthropicDefaultMaxTokens(input.model)
  if (system.length) body.system = system
  body.messages = messages
  if (input.toolsArray?.length) body.tools = input.toolsArray
  else if (input.tools?.length) body.tools = anthropicTools(input.tools)
  if (ok(params.temperature)) body.temperature = params.temperature
  if (ok(params.top_p)) body.top_p = params.top_p
  if (ok(params.top_k)) body.top_k = params.top_k
  if (openRouter && params.reasoning_effort === 'none') body.thinking = { type: 'disabled' }
  else if (params.reasoning_effort)
    body.output_config = { effort: anthropicEffort(params.reasoning_effort) }
  const stop = params.stop
  if (stop) body.stop_sequences = Array.isArray(stop) ? stop : [stop]
  body.stream = true
  if (input.extra) Object.assign(body, input.extra)
  return body
}

// ---------------- stream (SSE nativo) ----------------

interface AnthState {
  /** índice do content_block → tipo, índice em acc.toolCalls (tool_use) e posição em acc.blocks */
  blocks: Map<number, { type: string; tool?: number; at?: number; json?: string }>
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}
const states = new WeakMap<StreamAccumulator, AnthState>()
const stateOf = (acc: StreamAccumulator): AnthState => {
  let s = states.get(acc)
  if (!s) {
    s = { blocks: new Map(), input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    states.set(acc, s)
  }
  return s
}

const n = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** Bloco de acc.blocks (cópia do provedor) do índice do evento. */
function blockAt(
  acc: StreamAccumulator,
  s: AnthState,
  idx: number
): Record<string, unknown> | null {
  const at = s.blocks.get(idx)?.at
  return at !== undefined && acc.blocks ? (acc.blocks[at] ?? null) : null
}

const STOP_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  refusal: 'content_filter'
}

function absorbUsage(acc: StreamAccumulator, u: Record<string, unknown> | undefined): void {
  if (!u || typeof u !== 'object') return
  const s = stateOf(acc)
  s.input = n(u.input_tokens) ?? s.input
  s.cacheRead = n(u.cache_read_input_tokens) ?? s.cacheRead
  s.cacheWrite = n(u.cache_creation_input_tokens) ?? s.cacheWrite
  s.output = n(u.output_tokens) ?? s.output
  const usage: Usage = {
    promptTokens: s.input + s.cacheRead + s.cacheWrite,
    completionTokens: s.output
  }
  if (s.cacheRead || 'cache_read_input_tokens' in u) usage.cachedTokens = s.cacheRead
  if (s.cacheWrite) usage.cacheWriteTokens = s.cacheWrite
  // OpenRouter (Messages API): custo da request no usage, quando vem
  const cost = n(u.cost) ?? acc.usage?.cost
  if (cost !== undefined) usage.cost = cost
  acc.usage = usage
}

/** Aplica um evento SSE nativo (`data` já parseado; o `type` vem no próprio JSON). */
export function applyAnthropicEvent(acc: StreamAccumulator, ev: Record<string, unknown>): void {
  const s = stateOf(acc)
  switch (ev.type) {
    case 'message_start': {
      const msg = (ev.message ?? {}) as Record<string, unknown>
      if (typeof msg.model === 'string') acc.model = msg.model
      absorbUsage(acc, msg.usage as Record<string, unknown>)
      return
    }
    case 'content_block_start': {
      const idx = n(ev.index) ?? s.blocks.size
      const b = (ev.content_block ?? {}) as Record<string, unknown>
      // cópia fiel do bloco (os deltas completam): `native` da resposta (@shared/toolSearch)
      const blocks = (acc.blocks ??= [])
      blocks.push(JSON.parse(JSON.stringify(b)) as Record<string, unknown>)
      const at = blocks.length - 1
      if (b.type === 'tool_use') {
        acc.toolCalls.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), arguments: '' })
        s.blocks.set(idx, { type: 'tool_use', tool: acc.toolCalls.length - 1, at })
        // input inicial não vazio (raro; normalmente {} e chega por input_json_delta)
        const input = b.input as Record<string, unknown> | undefined
        if (input && Object.keys(input).length)
          acc.toolCalls[acc.toolCalls.length - 1].arguments = JSON.stringify(input)
      } else {
        s.blocks.set(idx, { type: String(b.type), at })
        if (b.type === 'text' && typeof b.text === 'string') acc.content += b.text
        if (b.type === 'thinking' && typeof b.thinking === 'string') acc.reasoning += b.thinking
      }
      return
    }
    case 'content_block_delta': {
      const d = (ev.delta ?? {}) as Record<string, unknown>
      const idx = n(ev.index) ?? -1
      const blk0 = blockAt(acc, s, idx)
      if (blk0) {
        if (d.type === 'text_delta' && typeof d.text === 'string')
          blk0.text = `${typeof blk0.text === 'string' ? blk0.text : ''}${d.text}`
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string')
          blk0.thinking = `${typeof blk0.thinking === 'string' ? blk0.thinking : ''}${d.thinking}`
        else if (d.type === 'signature_delta' && typeof d.signature === 'string')
          blk0.signature = `${typeof blk0.signature === 'string' ? blk0.signature : ''}${d.signature}`
        else if (d.type === 'citations_delta' && d.citation)
          blk0.citations = [...(Array.isArray(blk0.citations) ? blk0.citations : []), d.citation]
        else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const st = s.blocks.get(idx)!
          st.json = (st.json ?? '') + d.partial_json
        }
      }
      if (d.type === 'text_delta' && typeof d.text === 'string') acc.content += d.text
      else if (d.type === 'thinking_delta' && typeof d.thinking === 'string')
        acc.reasoning += d.thinking
      else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        // Só o input de um bloco tool_use vira argumento de tool call. O de outro bloco conhecido
        // (server_tool_use da busca nativa, …) NUNCA vai para a tool call anterior; o fallback para
        // a última tool call vale só para um índice cujo content_block_start não chegou.
        const blk = s.blocks.get(n(ev.index) ?? -1)
        const slot = blk
          ? blk.tool !== undefined
            ? acc.toolCalls[blk.tool]
            : undefined
          : acc.toolCalls.at(-1)
        if (slot) slot.arguments += d.partial_json
      }
      return
    }
    case 'content_block_stop': {
      // input completo de tool_use/server_tool_use no bloco guardado (o JSON chegou em pedaços)
      const st = s.blocks.get(n(ev.index) ?? -1)
      const blk = blockAt(acc, s, n(ev.index) ?? -1)
      if (st?.json !== undefined && blk) {
        const raw = st.json.trim()
        try {
          blk.input = raw ? JSON.parse(raw) : (blk.input ?? {})
        } catch {
          blk.input = { raw }
        }
      }
      return
    }
    case 'message_delta': {
      const d = (ev.delta ?? {}) as Record<string, unknown>
      if (typeof d.stop_reason === 'string')
        acc.finishReason = STOP_MAP[d.stop_reason] ?? d.stop_reason
      absorbUsage(acc, ev.usage as Record<string, unknown>)
      return
    }
    case 'error': {
      const e = (ev.error ?? {}) as { type?: string; message?: string }
      throw new Error(
        `Erro do provider durante o stream: ${e.message ?? JSON.stringify(e)}${e.type ? ` (${e.type})` : ''}`
      )
    }
    default:
      return // ping, message_stop
  }
}

/** Resposta completa (provider ignorou stream:true): `{type:'message', content:[…], usage, …}`. */
export function applyAnthropicMessage(acc: StreamAccumulator, msg: Record<string, unknown>): void {
  if (msg.type === 'error') applyAnthropicEvent(acc, msg)
  if (typeof msg.model === 'string') acc.model = msg.model
  if (Array.isArray(msg.content))
    acc.blocks = JSON.parse(JSON.stringify(msg.content)) as Record<string, unknown>[]
  for (const b of (msg.content ?? []) as Record<string, unknown>[]) {
    if (b.type === 'text' && typeof b.text === 'string') acc.content += b.text
    else if (b.type === 'thinking' && typeof b.thinking === 'string') acc.reasoning += b.thinking
    else if (b.type === 'tool_use')
      acc.toolCalls.push({
        id: String(b.id ?? ''),
        name: String(b.name ?? ''),
        arguments: JSON.stringify(b.input ?? {})
      })
  }
  if (typeof msg.stop_reason === 'string')
    acc.finishReason = STOP_MAP[msg.stop_reason] ?? msg.stop_reason
  absorbUsage(acc, msg.usage as Record<string, unknown>)
}

// ---------------- /models ----------------

const supported = (c: unknown, key: string): boolean =>
  !!(c && typeof c === 'object' && (c as Record<string, { supported?: unknown }>)[key]?.supported)

/** Item de GET /v1/models (nativo) → ModelInfo. */
export function mapAnthropicModel(m: Record<string, unknown>): ModelInfo | null {
  const id = typeof m.id === 'string' ? m.id : null
  if (!id) return null
  const info: ModelInfo = { id, supportsTools: true }
  if (typeof m.display_name === 'string' && m.display_name) info.name = m.display_name
  const ctx = n(m.max_input_tokens)
  if (ctx !== undefined) info.contextLength = ctx
  const caps = m.capabilities
  if (caps && typeof caps === 'object') {
    const mods = ['text']
    if (supported(caps, 'image_input')) mods.push('image')
    if (supported(caps, 'pdf_input')) mods.push('file')
    info.inputModalities = mods
    // effort: supported + níveis (low/medium/high/xhigh/max) direto da API
    const reasoning = anthropicCapsReasoning(caps)
    if (reasoning) info.reasoning = reasoning
  } else {
    // API sem capabilities (versões antigas): todos os Claude atuais aceitam imagem e PDF.
    info.inputModalities = ['text', 'image', 'file']
  }
  return info
}

/**
 * GET {baseUrl}/models?limit=1000 com paginação (has_more / last_id → after_id).
 * `get(url)` faz a chamada e devolve o JSON (lança erro legível em HTTP != 2xx).
 */
export async function fetchAnthropicModels(
  base: string,
  get: (url: string) => Promise<unknown>
): Promise<ModelInfo[]> {
  const models: ModelInfo[] = []
  let after: string | null = null
  for (let page = 0; page < 20; page++) {
    const url = `${base}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`
    const j = ((await get(url)) ?? {}) as { data?: unknown; has_more?: unknown; last_id?: unknown }
    if (!Array.isArray(j.data)) throw new Error('Formato inesperado da resposta de /models.')
    for (const m of j.data) {
      const info =
        m && typeof m === 'object' ? mapAnthropicModel(m as Record<string, unknown>) : null
      if (info) models.push(info)
    }
    if (j.has_more === true && typeof j.last_id === 'string' && j.last_id) after = j.last_id
    else break
  }
  return models
}
