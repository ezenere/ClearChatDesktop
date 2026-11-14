// Memória modular — extração: request SEPARADA (não persistida no histórico) ao modelo de extração
// com o prompt editável, o índice completo das coleções ativas e a conversa desde a última
// extração (ou o resumo da compactação + as mensagens recentes). O modelo responde com tool calls
// memory_write/memory_rewrite/memory_delete (tools nativas), executadas com as MESMAS regras do
// agente, em até MEMORY_LIMITS.extractionMaxRounds rodadas. Nunca lança: erro → result.error.
// Ver SPEC.md → "Memória" → Extração.
import { DEFAULT_APP_SIGNATURE, resolveAppSignatureHeaders } from '@shared/appSignatures'
import { activeHistory, isDisplayOnly } from '@shared/context'
import { contentText } from '@shared/attachments'
import { withStoredOpenFile } from '@shared/openFile'
import { DEFAULT_MEMORY_EXTRACTION_PROMPT } from '@shared/defaults'
import { MEMORY_LIMITS as ML } from '@shared/limits'
import type { MemoryExtractionResult } from '@shared/memory'
import { providerKind } from '@shared/providerKinds'
import { toolDefinitionFor } from '@shared/tools'
import type {
  ApiMessage,
  Chat,
  MessageMeta,
  Provider,
  StoredMessage,
  ToolCall,
  ToolName,
  Usage
} from '@shared/types'
import { adapterFor } from '../agent/adapters'
import { buildAnthropicBody } from '../agent/adapters/anthropic'
import { finalizeToolCalls, newAccumulator, streamChat } from '../agent/llm'
import { maskRequest, type BuiltRequest } from '../agent/request'
import { cleanSummary } from '../agent/compaction'
import { runMemoryTool, type MemoryChange } from '../tools/memory'
import type { MemoryService } from './service'

export type ExtractionTrigger = 'manual' | 'compaction'
export type ExtractionRecord = NonNullable<MessageMeta['memoryExtraction']>

const EXTRACTION_TOOLS: ToolName[] = ['memory_write', 'memory_rewrite', 'memory_delete']

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * Conversa para a extração (texto) + maior seq considerado. Só o histórico ativo (da fronteira de
 * compactação em diante): a fronteira entra como "[Resumo da conversa anterior]" se resumir algo
 * ainda não extraído (ou se a extração vem da compactação); o resto, só seq > lastSeq.
 */
export function extractionConversation(
  history: StoredMessage[],
  lastSeq: number,
  trigger: ExtractionTrigger,
  maxChars: number = ML.extractionConversationChars
): { text: string; maxSeq: number; messages: number } {
  const all = history.filter((m) => !isDisplayOnly(m.meta))
  const maxSeq = all.reduce((n, m) => Math.max(n, m.seq), lastSeq)
  const blocks: string[] = []
  for (const m of activeHistory(all)) {
    const msg = m.message
    if (m.meta.kind === 'compaction') {
      const covered = (m.meta.summaryOf?.toSeq ?? m.seq) > lastSeq
      if (trigger === 'compaction' || covered)
        blocks.push(
          `[Resumo da conversa anterior]\n${cleanSummary(contentText(msg.content as never))}`
        )
      continue
    }
    if (m.seq <= lastSeq) continue
    if (msg.role === 'user') {
      // o que o modelo viu: com o texto do arquivo selecionado (1.13.0), se houver
      const t = contentText(withStoredOpenFile(m).message.content as never).trim()
      if (t) blocks.push(`${m.meta.synthetic ? '[app]' : 'Usuário'}: ${t}`)
    } else if (msg.role === 'assistant') {
      const t = (msg.content ?? '').trim()
      const calls = (msg.tool_calls ?? []).map(
        (c) => `(chamou ${c.function.name} ${clip(c.function.arguments ?? '', 200)})`
      )
      if (t || calls.length) blocks.push(`Assistente: ${[t, ...calls].filter(Boolean).join('\n')}`)
    } else if (msg.role === 'tool') {
      const t = contentText(msg.content as never).trim()
      if (t) blocks.push(`[resultado de ferramenta] ${clip(t.replace(/\s+/g, ' '), 300)}`)
    }
  }
  // corta pelo início (o mais recente importa mais)
  let text = ''
  let n = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    const next = text ? `${blocks[i]}\n\n${text}` : blocks[i]
    if (next.length > maxChars && text) break
    text = next.length > maxChars ? next.slice(next.length - maxChars) : next
    n++
  }
  const hasConversation = blocks.some((b) => b.startsWith('Usuário:') || b.startsWith('[Resumo'))
  return { text: hasConversation ? text : '', maxSeq, messages: n }
}

/** Request da extração no formato do provedor (OpenAI-compatible ou Anthropic nativa). */
export function buildExtractionRequest(
  provider: Provider,
  model: string,
  chat: Pick<Chat, 'config'>,
  messages: ApiMessage[],
  tools: ToolName[]
): BuiltRequest {
  const kind = providerKind(provider)
  const adapter = adapterFor(kind)
  const signature = resolveAppSignatureHeaders(
    chat.config.appSignature ?? DEFAULT_APP_SIGNATURE,
    chat.config.appSignatureCustom
  )
  const defs = tools.map((t) => toolDefinitionFor(t, []))
  const body =
    kind === 'anthropic'
      ? buildAnthropicBody({ model, messages, tools: defs, params: {} })
      : {
          model,
          messages,
          tools: defs,
          stream: true,
          stream_options: { include_usage: true },
          ...(kind === 'openrouter' ? { usage: { include: true } } : {})
        }
  return {
    url: adapter.chatUrl(provider.baseUrl),
    headers: adapter.headers(provider, signature),
    body,
    kind
  }
}

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!b) return a
  if (!a) return { ...b }
  const sum = (x?: number, y?: number): number | undefined =>
    x == null && y == null ? undefined : (x ?? 0) + (y ?? 0)
  const out: Usage = {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens
  }
  for (const k of ['cachedTokens', 'cacheWriteTokens', 'reasoningTokens', 'cost'] as const) {
    const v = sum(a[k], b[k])
    if (v != null) out[k] = v
  }
  return out
}

export interface ExtractionInput {
  service: MemoryService
  chat: Chat
  sessionId: string
  history: StoredMessage[]
  /** Provedor/modelo da extração já resolvidos (null = sem provedor → erro). */
  provider: Provider | null
  model: string
  trigger: ExtractionTrigger
  signal?: AbortSignal
  /** Transporte (testes podem trocar). */
  stream?: typeof streamChat
}

export interface ExtractionOutcome {
  record: ExtractionRecord
  /** Nada novo para extrair (nenhuma request feita; nada a persistir). */
  empty: boolean
  /** Maior seq considerado (marcar como extraído se não houve erro). */
  maxSeq: number
}

export async function runExtraction(input: ExtractionInput): Promise<ExtractionOutcome> {
  const { service, chat, provider, model, trigger } = input
  const result: MemoryExtractionResult = { created: 0, updated: 0, deleted: 0, changes: [] }
  let usage: Usage | undefined
  let request: unknown
  const record = (): ExtractionRecord => ({
    ...result,
    created: result.changes.filter((c) => c.op === 'create').length,
    updated: result.changes.filter((c) => c.op === 'update').length,
    deleted: result.changes.filter((c) => c.op === 'delete').length,
    trigger,
    ...(model ? { model } : {}),
    ...(provider ? { providerId: provider.id } : {}),
    ...(usage ? { usage } : {}),
    ...(request ? { request } : {})
  })
  const lastSeq = service.readState(input.sessionId).lastExtractedSeq ?? 0
  const conv = extractionConversation(input.history, lastSeq, trigger)
  const fail = (error: string): ExtractionOutcome => ({
    record: { ...record(), error },
    empty: false,
    maxSeq: conv.maxSeq
  })
  try {
    const am = service.active(chat, { depth: 0 })
    if (!am.active) return fail('A memória está desligada ou sem coleções ativas neste chat.')
    if (!am.canWrite)
      return fail('Nenhuma coleção de escrita neste chat — a extração não tem onde gravar.')
    if (!provider) return fail('Nenhum provedor configurado para a extração.')
    if (!model) return fail('Nenhum modelo escolhido para a extração.')
    if (!conv.text) return { record: record(), empty: true, maxSeq: conv.maxSeq }
    const prompt = am.config.extraction.prompt?.trim()
      ? am.config.extraction.prompt
      : DEFAULT_MEMORY_EXTRACTION_PROMPT
    const index = service.renderIndex(am, {
      facts: 'all',
      maxChars: ML.extractionIndexChars,
      header:
        'Índice completo das memórias ativas (id · título — resumo, com os tópicos numerados). Coleções "escrita" aceitam memory_write; "leitura" só memory_rewrite.'
    })
    const messages: ApiMessage[] = [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: `${index}\n\n<conversation>\n${conv.text}\n</conversation>\n\nRegistre agora na memória o que for durável (ou não chame nenhuma ferramenta se não houver nada novo).`
      }
    ]
    const tools = EXTRACTION_TOOLS.filter((t) => am.tools.includes(t))
    const stream = input.stream ?? streamChat
    const signal = input.signal ?? new AbortController().signal
    for (let round = 0; round < ML.extractionMaxRounds; round++) {
      const req = buildExtractionRequest(provider, model, chat, messages, tools)
      if (!request) request = maskRequest(req, provider.apiKey)
      const acc = newAccumulator()
      try {
        await stream(req, signal, acc, () => {})
      } finally {
        usage = addUsage(usage, acc.usage)
      }
      const calls: ToolCall[] = finalizeToolCalls(acc).map((t) => ({
        id: t.id,
        type: 'function',
        function: { name: t.name, arguments: t.arguments }
      }))
      if (!calls.length) break
      messages.push({ role: 'assistant', content: acc.content || null, tool_calls: calls })
      // a cada rodada a memória ativa é relida (config/coleções podem ter mudado)
      const cur = service.active(chat, { depth: 0 })
      for (const c of calls) {
        let args: Record<string, unknown> = {}
        let content: string
        try {
          const v = c.function.arguments?.trim() ? JSON.parse(c.function.arguments) : {}
          args = v && typeof v === 'object' && !Array.isArray(v) ? v : {}
          const name = c.function.name as ToolName
          const r = EXTRACTION_TOOLS.includes(name)
            ? runMemoryTool(name, args, {
                store: service.store,
                am: cur,
                by: { updatedBy: 'extraction', chatId: chat.id }
              })
            : {
                content: `Erro: na extração só valem ${EXTRACTION_TOOLS.join(', ')}.`,
                status: 'error' as const
              }
          content = r.content
          if (r.changes) result.changes.push(...(r.changes as MemoryChange[]))
        } catch (e) {
          content = `Erro: argumentos inválidos (${(e as Error).message}).`
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content })
      }
    }
    return { record: record(), empty: false, maxSeq: conv.maxSeq }
  } catch (e) {
    return fail((e as Error)?.message || String(e))
  }
}

/** Texto curto da mensagem do card ("Extração de memórias: 2 criadas, 1 atualizada."). */
export function extractionSummaryText(r: ExtractionRecord): string {
  if (r.error) return `Extração de memórias falhou: ${r.error}`
  const parts: string[] = []
  if (r.created) parts.push(`${r.created} criada${r.created > 1 ? 's' : ''}`)
  if (r.updated) parts.push(`${r.updated} atualizada${r.updated > 1 ? 's' : ''}`)
  if (r.deleted) parts.push(`${r.deleted} apagada${r.deleted > 1 ? 's' : ''}`)
  return `Extração de memórias: ${parts.length ? parts.join(', ') : 'nada novo'}.`
}
