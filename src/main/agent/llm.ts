// Cliente SSE streaming: POST {baseUrl}/chat/completions (OpenAI-compatible) ou, com
// BuiltRequest.kind === 'anthropic' / api === 'messages' (Messages API do OpenRouter, busca nativa
// de tools), POST {baseUrl}/messages (SSE nativo — adapters/anthropic.ts).
import type { StreamDraft, Usage } from '@shared/types'
import type { BuiltRequest } from './request'
import { applyAnthropicEvent, applyAnthropicMessage } from './adapters/anthropic'

export interface AccToolCall {
  id: string
  name: string
  arguments: string
}

/** Acumulador do stream (mantido pelo chamador para recuperar o parcial em caso de abort). */
export interface StreamAccumulator {
  content: string
  reasoning: string
  toolCalls: AccToolCall[]
  usage?: Usage
  finishReason?: string
  model?: string
  /** true quando o stream terminou normalmente ([DONE] ou fim do body). */
  completed: boolean
  /** 1º delta de raciocínio (epoch ms) — ver markReasoning. */
  reasoningStartedAt?: number
  /** 1º delta de conteúdo/tool call depois do raciocínio. */
  reasoningEndedAt?: number
  /**
   * Messages API: os blocos da resposta na ordem, como o provedor mandou (os deltas completam;
   * `input` de tool_use/server_tool_use já parseado) — vira `native` quando há blocos do servidor
   * (@shared/toolSearch → nativeTurnFrom).
   */
  blocks?: Record<string, unknown>[]
  /** OpenRouter: header `X-Generation-Id` (custo pelo GET /generation quando o stream não traz). */
  generationId?: string
}

export const newAccumulator = (): StreamAccumulator => ({
  content: '',
  reasoning: '',
  toolCalls: [],
  completed: false
})

export const accToDraft = (a: StreamAccumulator): StreamDraft => ({
  content: a.content,
  reasoning: a.reasoning,
  toolCalls: a.toolCalls.map((t) => ({ ...t })),
  ...(a.reasoningStartedAt != null ? { reasoningStartedAt: a.reasoningStartedAt } : {}),
  ...(a.reasoningEndedAt != null ? { reasoningEndedAt: a.reasoningEndedAt } : {})
})

/**
 * Relógio do raciocínio, chamado a cada atualização do stream: marca o 1º delta de raciocínio e o
 * 1º delta de conteúdo/tool call que vem depois dele (o fim do "Pensando…").
 */
export function markReasoning(acc: StreamAccumulator, now: number): void {
  if (acc.reasoningStartedAt == null) {
    if (acc.reasoning) acc.reasoningStartedAt = now
    else return
  }
  if (acc.reasoningEndedAt == null && (acc.content || acc.toolCalls.length))
    acc.reasoningEndedAt = now
}

/**
 * Duração do raciocínio (ms) para `meta.reasoningMs`: início → fim marcado (ou `now`, se o stream
 * acabou/foi cortado ainda pensando). undefined sem raciocínio ou quando tudo chegou de uma vez
 * (resposta não-stream: duração 0 não diz nada).
 */
export function reasoningDuration(acc: StreamAccumulator, now: number): number | undefined {
  if (acc.reasoningStartedAt == null) return undefined
  const ms = (acc.reasoningEndedAt ?? now) - acc.reasoningStartedAt
  return ms > 0 ? ms : undefined
}

export class LlmHttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * Extrai uma mensagem legível de um body de erro (JSON OpenAI/OpenRouter, Anthropic
 * `{type:'error', error:{type, message}}` ou texto).
 */
export function readableError(status: number, statusText: string, body: string): string {
  let msg = ''
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; metadata?: { raw?: string; provider_name?: string } } | string
      message?: string
    }
    if (typeof j.error === 'string') msg = j.error
    else if (j.error?.message) {
      msg = j.error.message
      const raw = j.error.metadata?.raw
      if (raw && !msg.includes(raw)) msg += ` — ${String(raw).slice(0, 500)}`
      if (j.error.metadata?.provider_name) msg += ` (provider: ${j.error.metadata.provider_name})`
    } else if (j.message) msg = j.message
  } catch {
    msg = body.trim().slice(0, 800)
  }
  return `Erro HTTP ${status}${statusText ? ' ' + statusText : ''}${msg ? ': ' + msg : ''}`
}

export function parseUsage(u: Record<string, unknown> | undefined | null): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const pd = (u.prompt_tokens_details ?? {}) as Record<string, unknown>
  const cd = (u.completion_tokens_details ?? {}) as Record<string, unknown>
  const usage: Usage = {
    promptTokens: num(u.prompt_tokens) ?? 0,
    completionTokens: num(u.completion_tokens) ?? 0
  }
  const cached = num(pd.cached_tokens)
  if (cached !== undefined) usage.cachedTokens = cached
  const cw = num(pd.cache_write_tokens)
  if (cw !== undefined) usage.cacheWriteTokens = cw
  const rt = num(cd.reasoning_tokens)
  if (rt !== undefined) usage.reasoningTokens = rt
  const cost = num(u.cost)
  if (cost !== undefined) usage.cost = cost
  return usage
}

interface Delta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  tool_calls?: {
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }[]
}

let idCounter = 0
const genCallId = (): string =>
  `call_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Aplica um chunk SSE (já parseado) ao acumulador. Exportado para testes. */
export function applyChunk(acc: StreamAccumulator, chunk: Record<string, unknown>): void {
  if (chunk.error) {
    const e = chunk.error as { message?: string; code?: number | string }
    throw new Error(`Erro do provider durante o stream: ${e.message ?? JSON.stringify(e)}`)
  }
  if (typeof chunk.model === 'string') acc.model = chunk.model
  if (chunk.usage) acc.usage = parseUsage(chunk.usage as Record<string, unknown>) ?? acc.usage
  const choices = chunk.choices as
    { delta?: Delta; message?: Delta; finish_reason?: string | null }[] | undefined
  const choice = choices?.[0]
  if (!choice) return
  const delta = choice.delta ?? choice.message ?? {}
  if (typeof delta.content === 'string') acc.content += delta.content
  const r = delta.reasoning ?? delta.reasoning_content
  if (typeof r === 'string') acc.reasoning += r
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = typeof tc.index === 'number' ? tc.index : acc.toolCalls.length
      let slot = acc.toolCalls[idx]
      // Alguns providers repetem index 0 para chamadas distintas (cada uma completa): id novo → nova entrada.
      if (slot && tc.id && slot.id && tc.id !== slot.id && slot.name) {
        acc.toolCalls.push({ id: tc.id, name: '', arguments: '' })
        const s = acc.toolCalls[acc.toolCalls.length - 1]
        if (tc.function?.name) s.name += tc.function.name
        if (tc.function?.arguments) s.arguments += tc.function.arguments
        continue
      }
      if (!slot) {
        slot = { id: '', name: '', arguments: '' }
        acc.toolCalls[idx] = slot
      }
      if (tc.id && !slot.id) slot.id = tc.id
      if (tc.function?.name) slot.name += tc.function.name
      if (tc.function?.arguments) slot.arguments += tc.function.arguments
    }
  }
  if (choice.finish_reason) acc.finishReason = choice.finish_reason
}

/** Finaliza tool calls: remove buracos, gera ids faltantes. */
export function finalizeToolCalls(acc: StreamAccumulator): AccToolCall[] {
  return acc.toolCalls
    .filter((t): t is AccToolCall => !!t && !!t.name)
    .map((t) => ({ ...t, id: t.id || genCallId() }))
}

/**
 * Faz a chamada streaming. Atualiza `acc` à medida que chegam deltas e chama `onUpdate`.
 * Lança erro legível em HTTP != 2xx, erro no stream ou abort (o parcial fica em `acc`).
 */
export async function streamChat(
  req: BuiltRequest,
  signal: AbortSignal,
  acc: StreamAccumulator,
  onUpdate: () => void
): Promise<StreamAccumulator> {
  // Watchdog: sem nenhum byte por STALL_MS (headers ou corpo) → erro legível.
  const stall = new AbortController()
  let stallTimer: NodeJS.Timeout | null = null
  const kick = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stall.abort(), STALL_MS)
  }
  const stalledError = (): Error =>
    new Error(`Sem resposta do provider por ${STALL_MS / 1000}s (timeout).`)
  kick()
  const sig = AbortSignal.any([signal, stall.signal])
  try {
    return await doStream(req, sig, acc, onUpdate, kick)
  } catch (e) {
    if (!signal.aborted && stall.signal.aborted) throw stalledError()
    throw e
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
  }
}

const STALL_MS = 120_000

async function doStream(
  req: BuiltRequest,
  sig: AbortSignal,
  acc: StreamAccumulator,
  onUpdate: () => void,
  kick: () => void
): Promise<StreamAccumulator> {
  let res: Response
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: sig
    })
  } catch (e) {
    if (sig.aborted) throw e
    const cause = (e as { cause?: { message?: string; code?: string } }).cause
    throw new Error(
      `Falha de rede ao chamar ${req.url}: ${(e as Error).message}${cause?.message ? ` (${cause.message})` : ''}`,
      { cause: e }
    )
  }
  if (!res.ok) {
    let text = ''
    try {
      text = await res.text()
    } catch {
      /* ignora */
    }
    throw new LlmHttpError(readableError(res.status, res.statusText, text), res.status)
  }

  const ctype = res.headers.get('content-type') ?? ''
  const gen = res.headers.get('x-generation-id')
  if (gen) acc.generationId = gen
  if (!res.body) throw new Error('Resposta sem corpo.')
  const anthropic = req.kind === 'anthropic' || req.api === 'messages'
  const apply = anthropic ? applyAnthropicEvent : applyChunk
  if (ctype.includes('application/json')) {
    // Provider ignorou stream:true — resposta completa em JSON.
    const j = (await res.json()) as Record<string, unknown>
    if (anthropic) applyAnthropicMessage(acc, j)
    else applyChunk(acc, j)
    acc.completed = true
    onUpdate()
    return acc
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let done = false
  const onAbort = (): void => {
    void reader.cancel().catch(() => {})
  }
  sig.addEventListener('abort', onAbort, { once: true })
  try {
    while (!done) {
      const { value, done: rdone } = await reader.read()
      kick()
      if (sig.aborted) throw new DOMException('Aborted', 'AbortError')
      if (rdone) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      let changed = false
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line || line.startsWith(':')) continue // comentários (": OPENROUTER PROCESSING")
        if (!line.startsWith('data:')) continue // `event: …` (Anthropic: o tipo também vem no JSON)
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          done = true
          break
        }
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        apply(acc, chunk)
        changed = true
        if (anthropic && chunk.type === 'message_stop') {
          done = true
          break
        }
      }
      if (changed) onUpdate()
    }
    if (sig.aborted) throw new DOMException('Aborted', 'AbortError')
    acc.completed = true
    return acc
  } finally {
    sig.removeEventListener('abort', onAbort)
    if (done) void reader.cancel().catch(() => {})
  }
}

/**
 * Custo de uma geração do OpenRouter pelo `GET {baseUrl}/generation?id=` (grátis) — para a Messages
 * API, cujo stream pode não trazer `usage.cost`. A geração demora um pouco a aparecer (404 no
 * começo): tenta de novo nos intervalos dados. null = não deu (sem custo; nunca lança).
 */
export async function fetchGenerationCost(
  baseUrl: string,
  headers: Record<string, string>,
  id: string,
  opts: { waits?: number[]; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<number | null> {
  const f = opts.fetchImpl ?? fetch
  const url = `${baseUrl.replace(/\/+$/, '')}/generation?id=${encodeURIComponent(id)}`
  for (const wait of opts.waits ?? [800, 1600, 3200, 6400]) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    if (opts.signal?.aborted) return null
    try {
      const res = await f(url, { headers, signal: AbortSignal.timeout(15_000) })
      if (res.status === 404) continue
      if (!res.ok) return null
      const j = (await res.json()) as { data?: { total_cost?: unknown } }
      const c = j?.data?.total_cost
      return typeof c === 'number' && Number.isFinite(c) ? c : null
    } catch {
      return null
    }
  }
  return null
}

/** Emissor com throttle (~40ms) para drafts / saída parcial. */
export function throttle(
  fn: () => void,
  ms = 40
): { call: () => void; flush: () => void; cancel: () => void } {
  let timer: NodeJS.Timeout | null = null
  let dirty = false
  return {
    call() {
      dirty = true
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (dirty) {
          dirty = false
          fn()
        }
      }, ms)
    },
    flush() {
      if (timer) clearTimeout(timer)
      timer = null
      if (dirty) {
        dirty = false
        fn()
      }
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      dirty = false
    }
  }
}
