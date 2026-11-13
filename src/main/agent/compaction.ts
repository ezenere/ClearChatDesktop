// Compactação de contexto — partes puras (testadas em unit.test.ts). O runner faz a chamada,
// transmite o resumo e persiste a fronteira.
//
// A request de resumo = a MESMA request normal (tools → system → histórico ativo, mesmos params,
// mesmos breakpoints de cache — o prefixo é reaproveitado do cache) + uma última mensagem
// `role: user` com o prompt de compactação. Nada dessa request (nem a resposta) entra no histórico:
// só o resumo, dentro da mensagem de fronteira `role: user` (meta.kind 'compaction').
import { compactionMessageText, COMPACTION_NOTE } from '@shared/defaults'
import { activeHistory, isDisplayOnly } from '@shared/context'
import { attachmentPlaceholder } from '@shared/attachments'
import type {
  ApiMessage,
  Chat,
  ContentPart,
  Provider,
  Session,
  StoredMessage,
  ToolCall,
  ToolSearchMode
} from '@shared/types'
import { isNativeMode } from '@shared/toolSearch'
import {
  availableTools,
  buildRequest,
  systemContent,
  toolsPlan,
  type BuiltRequest,
  type EnvInfo
} from './request'

/**
 * full    = histórico ativo intacto (aproveita o cache);
 * trimmed = resultados de tool e mensagens longas encurtados (se a request completa estourar o contexto);
 * tail    = trimmed + só as mensagens mais recentes que cabem (último recurso).
 */
export type CompactionMode = 'full' | 'trimmed' | 'tail'
export const COMPACTION_MODES: CompactionMode[] = ['full', 'trimmed', 'tail']

const TOOL_MAX = 1500
const MSG_MAX = 8000

function shorten(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n[… ${text.length - max} caracteres omitidos para caber no resumo …]\n${text.slice(text.length - tail)}`
}

function shrinkMessage(m: StoredMessage): StoredMessage {
  const msg = m.message
  let next: ApiMessage = msg
  if (msg.role === 'tool')
    next = {
      ...msg,
      content:
        typeof msg.content === 'string'
          ? shorten(msg.content, TOOL_MAX)
          : msg.content.map(shrinkPart) // read_file de imagem/PDF → placeholder de texto
    }
  else if (msg.role === 'assistant' && typeof msg.content === 'string') {
    const tool_calls = msg.tool_calls?.map((t): ToolCall => ({
      ...t,
      function: { ...t.function, arguments: shorten(t.function.arguments, MSG_MAX / 2) }
    }))
    next = {
      ...msg,
      content: shorten(msg.content, MSG_MAX),
      ...(tool_calls ? { tool_calls } : {})
    }
  } else if (msg.role === 'user' && typeof msg.content === 'string' && m.meta.kind !== 'compaction')
    next = { ...msg, content: shorten(msg.content, MSG_MAX) }
  else if (msg.role === 'user' && Array.isArray(msg.content))
    next = { ...msg, content: msg.content.map(shrinkPart) }
  return next === msg ? m : { ...m, message: next }
}

/**
 * Anexos no histórico encurtado: binários (imagem/PDF/áudio) viram um placeholder de texto
 * (`[imagem: foto.png]`) e arquivos de texto são cortados — o resumo menciona o anexo sem reenviá-lo.
 */
function shrinkPart(p: ContentPart): ContentPart {
  const a = p._attachment
  if (a && a.kind !== 'text') return { type: 'text', text: attachmentPlaceholder(a) }
  // skill carregada manualmente: só o nome (o modelo pode recarregá-la com skill_load)
  if (p.type === 'text' && p._skill)
    return { type: 'text', text: `[skill carregada: ${p._skill.name}]` }
  if (p.type === 'text') return { type: 'text', text: shorten(p.text, a ? TOOL_MAX * 2 : MSG_MAX) }
  return p
}

const msgChars = (m: StoredMessage): number => JSON.stringify(m.message).length

/**
 * Divide o histórico ativo em: o que será resumido e as mensagens `user` pendentes no fim (ainda
 * sem resposta — ex.: a mensagem que acabou de ser enviada quando a compactação automática roda no
 * início do turno). As pendentes NÃO entram no resumo: ficam, intactas, logo após a fronteira.
 */
export function splitPending(history: StoredMessage[]): {
  summarized: StoredMessage[]
  pending: StoredMessage[]
} {
  const active = activeHistory(history).filter((m) => !isDisplayOnly(m.meta))
  let i = active.length
  while (i > 0 && active[i - 1].message.role === 'user' && active[i - 1].meta.kind !== 'compaction')
    i--
  // sem nenhuma resposta a resumir, não há pendentes: tudo seria resumido
  if (!active.slice(0, i).some((m) => m.message.role === 'assistant'))
    return { summarized: active, pending: [] }
  return { summarized: active.slice(0, i), pending: active.slice(i) }
}

/** Histórico enviado na request de resumo (cópias; o banco não muda). Exclui as pendentes. */
export function compactionHistory(
  history: StoredMessage[],
  mode: CompactionMode,
  window: number | null
): StoredMessage[] {
  const active = splitPending(history).summarized
  if (mode === 'full') return active
  const trimmed = active.map(shrinkMessage)
  if (mode === 'trimmed') return trimmed
  // tail: mantém a fronteira anterior (resumo) + as mensagens mais recentes que cabem no orçamento.
  const budget = window ? Math.floor(window * 0.5 * 4) : 200_000
  const keepFirst = trimmed[0]?.meta.kind === 'compaction' ? [trimmed[0]] : []
  let used = keepFirst.reduce((n, m) => n + msgChars(m), 0)
  const tail: StoredMessage[] = []
  for (let i = trimmed.length - 1; i >= keepFirst.length; i--) {
    const c = msgChars(trimmed[i])
    if (tail.length && used + c > budget) break
    tail.unshift(trimmed[i])
    used += c
  }
  return [...keepFirst, ...tail] // tool órfão no início do corte é descartado por sanitizeHistory
}

/**
 * Request de resumo: request normal da sessão + prompt de compactação como último `role: user`.
 * `toolChoiceNone` (o modelo insistiu em chamar tools): `tool_choice: none` — que conflita com a
 * busca nativa de tools (1.12.0) — então a repetição vai sem adiar nada (modo 'off': todas
 * completas, sem a busca do servidor, sem reenvio de blocos nativos).
 */
export function buildCompactionRequest(
  chat: Chat,
  session: Pick<Session, 'id' | 'depth' | 'model'>,
  history: StoredMessage[],
  provider: Provider,
  prompt: string,
  opts: {
    mode: CompactionMode
    window: number | null
    toolChoiceNone?: boolean
    /** Modo das tools forçado (a busca nativa foi recusada nesta compactação → 'local'). */
    toolMode?: ToolSearchMode
  },
  env?: EnvInfo
): BuiltRequest {
  const hist = compactionHistory(history, opts.mode, opts.window)
  const last = hist[hist.length - 1]
  const promptMsg: StoredMessage = {
    id: '__compaction_prompt__',
    sessionId: session.id,
    seq: (last?.seq ?? 0) + 1,
    message: { role: 'user', content: prompt },
    meta: { synthetic: true },
    createdAt: 0
  }
  let req = buildRequest(chat, session, [...hist, promptMsg], provider, env, {
    ...(opts.toolMode ? { modeOverride: opts.toolMode } : {})
  })
  if (opts.toolChoiceNone && req.toolSearch && isNativeMode(req.toolSearch.mode))
    req = buildRequest(chat, session, [...hist, promptMsg], provider, env, { modeOverride: 'off' })
  // Só se o modelo insistir em chamar tools em vez de resumir (muda o cache de mensagens).
  if (opts.toolChoiceNone && req.body.tools)
    req.body.tool_choice = req.kind === 'anthropic' ? { type: 'none' } : 'none'
  return req
}

/** Remove tags <conversation_summary> (e a nota da fronteira) que o modelo possa ter repetido. */
export function cleanSummary(text: string): string {
  return text
    .replace(/<\/?conversation_summary>/g, '')
    .replace(COMPACTION_NOTE, '')
    .replace(
      /O histórico anterior desta conversa \(mensagens #\d+–#\d+\) foi compactado[^\n]*/g,
      ''
    )
    .trim()
}

/**
 * Faixa resumida + estimativa do contexto logo após a compactação (system + tools + fronteira).
 * `toolMode` = modo das tools da sessão (@shared/toolSearch): nos nativos só as carregadas e a
 * entrada de busca contam (as adiadas não estão no contexto).
 */
export function compactionMeta(
  chat: Chat,
  session: Pick<Session, 'depth'>,
  history: StoredMessage[],
  summary: string,
  summaryTokens: number | undefined,
  env?: EnvInfo,
  toolMode: ToolSearchMode = 'local'
): {
  text: string
  summaryOf: { fromSeq: number; toSeq: number }
  compactedCount: number
  contextEstimate: number
  /** Há mensagens pendentes: a fronteira entra ANTES delas (seq desta mensagem). */
  insertBeforeSeq?: number
} {
  const { summarized: active, pending } = splitPending(history)
  const summaryOf = { fromSeq: active[0]?.seq ?? 0, toSeq: active[active.length - 1]?.seq ?? 0 }
  const tools = availableTools(chat, session, history)
  // read_history habilitada ao compactar → a nota diz que o original (seq X–Y) é consultável.
  const firstSeq = history.find((m) => !isDisplayOnly(m.meta))?.seq ?? summaryOf.fromSeq
  const text = compactionMessageText(
    summary,
    tools.includes('read_history') ? { fromSeq: firstSeq, toSeq: summaryOf.toSeq } : undefined
  )
  const sys = systemContent(chat, session, env, history, toolMode)
  const plan = toolsPlan(chat, session, history, undefined, toolMode)
  const inContext = plan.definitions.filter((d) => !plan.deferred.includes(d.function.name))
  const toolsChars =
    chat.config.nativeTools && tools.length
      ? JSON.stringify(inContext).length +
        (plan.searchEntry ? JSON.stringify(plan.searchEntry).length : 0)
      : 0
  const pendingChars = pending.reduce((n, m) => n + JSON.stringify(m.message.content).length, 0)
  const overhead = Math.ceil(
    (sys.length + toolsChars + (text.length - summary.length) + pendingChars) / 4
  )
  return {
    text,
    summaryOf,
    compactedCount: active.length,
    contextEstimate: overhead + (summaryTokens || Math.ceil(summary.length / 4)),
    ...(pending.length ? { insertBeforeSeq: pending[0].seq } : {})
  }
}
