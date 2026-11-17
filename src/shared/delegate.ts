// Parâmetros próprios de um subagente (`delegate_task` — protocolo 1.18.0). PURO (main e celular).
// O subagente herda os parâmetros do chat; o agente pode escolher o esforço de raciocínio SÓ dele
// (`reasoning_effort` da tool) — gravado no `meta.delegate` da mensagem de tarefa (a 1ª da
// subsessão, que já sincroniza) e aplicado nas requests da subsessão no lugar do do chat. O filtro
// por modelo (@shared/modelParams) ajusta/omite o nível como faz com o do chat.
import type { ChatParams, MessageMeta, ReasoningEffort, StoredMessage } from './types'

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

/** Valor do argumento `reasoning_effort` (null = não informado/vazio; undefined = inválido). */
export function parseDelegateEffort(v: unknown): ReasoningEffort | null | undefined {
  if (v == null || (typeof v === 'string' && !v.trim())) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim().toLowerCase() as ReasoningEffort
  return REASONING_EFFORTS.includes(t) ? t : undefined
}

/** Meta da mensagem de tarefa do subagente (só com o que foi escolhido). */
export function delegateTaskMeta(effort: ReasoningEffort | null): Pick<MessageMeta, 'delegate'> {
  return effort ? { delegate: { reasoningEffort: effort } } : {}
}

/** Esforço próprio da subsessão: o da mensagem de tarefa (a 1ª do histórico), se houver. */
export function subagentEffort(history: readonly StoredMessage[]): ReasoningEffort | null {
  const first = history[0]
  if (!first || first.message.role !== 'user') return null
  const e = parseDelegateEffort(first.meta?.delegate?.reasoningEffort)
  return e ?? null
}

/** Parâmetros da request de uma subsessão: os do chat com o esforço próprio dela por cima. */
export function subagentParams(
  params: ChatParams | null | undefined,
  depth: number,
  history: readonly StoredMessage[]
): ChatParams {
  const p = params ?? {}
  if (depth < 1) return p
  const effort = subagentEffort(history)
  return effort ? { ...p, reasoning_effort: effort } : p
}

/** Esforço de raciocínio da sessão para o `get_chat_info`: o pedido, de onde vem e o que vai. */
export interface EffortReport {
  /** O pedido (o do subagente ou o do chat); null = nenhum (o padrão do modelo). */
  requested: ReasoningEffort | null
  source: 'subagent' | 'chat' | null
  /** O que vai na request depois do ajuste ao modelo (null = não vai — o padrão dele). */
  sent: string | null
}

/**
 * Relatório do esforço da sessão. `filter` = o filtro de parâmetros por modelo do app (os
 * parâmetros que vão de fato — @shared/modelParams via `filterParams`); sem ele, o pedido.
 */
export function effortReport(
  params: ChatParams | null | undefined,
  depth: number,
  history: readonly StoredMessage[],
  filter?: (p: ChatParams) => ChatParams
): EffortReport {
  const own = depth >= 1 ? subagentEffort(history) : null
  const p = subagentParams(params, depth, history)
  const requested = p.reasoning_effort ?? null
  const sent = requested ? (filter ? (filter(p).reasoning_effort ?? null) : requested) : null
  return { requested, source: own ? 'subagent' : requested ? 'chat' : null, sent }
}
