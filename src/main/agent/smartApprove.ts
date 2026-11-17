// Smart-Approve no main: chamada ao juiz (fora do histórico) e liberações de uma vez só
// ("Executar mesmo assim"). As regras puras ficam em @shared/smartApprove.
import { DEFAULT_APP_SIGNATURE, resolveAppSignatureHeaders } from '@shared/appSignatures'
import { providerKind } from '@shared/providerKinds'
import { planSideCall, sideChatBody, SIDE_THINKING } from '@shared/sideReasoning'
import { sideCacheNote, sideWireMessages, type SideMessage } from '@shared/sideCache'
import {
  argsKey,
  buildJudgeMessages,
  mapJudgeDecision,
  parseJudgeOutput,
  SMART_APPROVE_DEFAULTS,
  type JudgeContext
} from '@shared/smartApprove'
import { judgedLabels } from '@shared/smartApproveContext'
import type {
  ChatConfig,
  Provider,
  SmartApproveConfig,
  SmartApproveRecord,
  ToolName
} from '@shared/types'
import { newAccumulator, streamChat } from './llm'
import { maskRequest, modelInfoFor, type BuiltRequest } from './request'
import { adapterFor } from './adapters'
import { buildAnthropicBody } from './adapters/anthropic'

export interface JudgeInput {
  /** Config já normalizada (normalizeSmartApprove). */
  sa: SmartApproveConfig
  /** Provedor do juiz (null = apagado → pergunta ao usuário). */
  provider: Provider | null
  chatConfig: Pick<ChatConfig, 'appSignature' | 'appSignatureCustom'>
  ctx: JudgeContext
  /** `max_tokens` da resposta (o efetivo — effectiveJudgeMaxTokens); ausente = 300. */
  maxTokens?: number
  /** Signal da sessão (Parar/⚡). */
  signal: AbortSignal
}

/**
 * Request de uma chamada "lateral" (fora do histórico): juiz do Smart-Approve, resumidor da coleta
 * de contexto e título automático. System + user, `maxTokens`, temperatura fixa (opcional),
 * raciocínio pela política de @shared/sideReasoning (desligado onde dá; obrigatório → esforço
 * mínimo + `thinkingTokens` somados ao max_tokens), streaming acumulado.
 */
export function buildSideRequest(input: {
  provider: Provider
  model: string
  /** System + user; `cacheAt` = 2º breakpoint do cache (marcador {{cache_break}}). */
  messages: SideMessage[]
  /** "Cache do prompt" (juiz/resumidor; título: ausente = desligado). */
  cache?: boolean
  maxTokens: number
  /** Ausente = sem temperature (título). */
  temperature?: number
  /** "Tokens de pensamento" da config (null/ausente = `defaultThinkingTokens`). */
  thinkingTokens?: number | null
  defaultThinkingTokens: number
  chatConfig?: Pick<ChatConfig, 'appSignature' | 'appSignatureCustom'>
}): BuiltRequest {
  const { provider, model, messages } = input
  const signature = resolveAppSignatureHeaders(
    input.chatConfig?.appSignature ?? DEFAULT_APP_SIGNATURE,
    input.chatConfig?.appSignatureCustom
  )
  const kind = providerKind(provider)
  const adapter = adapterFor(kind)
  // Parâmetros fixos passam pelo mesmo filtro do chat (paramSupport): modelos que rejeitam
  // temperature (ex.: claude-sonnet-5-5 nativo → 400) recebem a request sem ele.
  const plan = planSideCall({
    kind,
    model,
    info: modelInfoFor(provider.id, model),
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    thinkingTokens: input.thinkingTokens,
    defaultThinkingTokens: input.defaultThinkingTokens
  })
  // cache ligado + provedor que aceita cache_control: system e parte estável em parts marcadas
  const wire = sideWireMessages(messages, { cache: !!input.cache, kind, model })
  const cacheNote = sideCacheNote(wire)
  const notes = cacheNote ? [...plan.notes, cacheNote] : plan.notes
  const body =
    kind === 'anthropic'
      ? // max_tokens é obrigatório na API nativa (o filtro nunca o tira na Anthropic)
        buildAnthropicBody({
          model,
          messages: wire,
          params: plan.send,
          extra: plan.reasoning.thinking ? { thinking: plan.reasoning.thinking } : null
        })
      : sideChatBody(kind, model, wire, plan.send)
  return {
    url: adapter.chatUrl(provider.baseUrl),
    headers: adapter.headers(provider, signature),
    body,
    kind,
    ...(notes.length ? { notes } : {})
  }
}

/** Request exata da chamada ao juiz. */
export function buildJudgeRequest(input: Omit<JudgeInput, 'signal'>): BuiltRequest | null {
  const { sa, provider } = input
  if (!provider || !sa.model) return null
  return buildSideRequest({
    provider,
    model: sa.model,
    messages: buildJudgeMessages(sa, input.ctx),
    cache: sa.cache !== false,
    maxTokens: input.maxTokens ?? sa.maxTokens ?? SMART_APPROVE_DEFAULTS.maxTokens,
    temperature: SMART_APPROVE_DEFAULTS.temperature,
    thinkingTokens: sa.thinkingTokens,
    defaultThinkingTokens: SIDE_THINKING.judge,
    chatConfig: input.chatConfig
  })
}

const RESPONSE_MAX = 2000

/**
 * Chama o juiz e devolve a avaliação. NUNCA lança por falha do juiz: erro HTTP/rede, tempo
 * esgotado, resposta vazia/ambígua → decisão 'ask' (com `fallback`) — nunca 'reject'. Rejeitar
 * só sai daqui com `sa.canDeny`; sem ele vira 'ask' + `wouldReject`. Só o abort da sessão
 * propaga como decisão 'ask' + fallback 'error' — quem chama confere `signal.aborted`.
 */
export async function runJudge(input: JudgeInput): Promise<SmartApproveRecord> {
  const t0 = Date.now()
  const { sa, provider } = input
  const judged = judgedLabels(input.ctx.check, input.ctx.judgeIdx)
  const base = {
    providerId: sa.providerId ?? '',
    model: sa.model ?? '',
    ...(judged.length ? { judged } : {})
  }
  const req = buildJudgeRequest(input)
  if (!req || !provider) {
    return {
      ...base,
      decision: 'ask',
      fallback: 'error',
      error: provider
        ? 'Nenhum modelo escolhido para o Smart-Approve.'
        : 'O provedor do Smart-Approve não existe mais.',
      reason: '',
      durationMs: Date.now() - t0
    }
  }
  const request = maskRequest(req, provider.apiKey)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), sa.timeoutS * 1000)
  const acc = newAccumulator()
  try {
    await streamChat(req, AbortSignal.any([input.signal, timeout.signal]), acc, () => {})
  } catch (e) {
    clearTimeout(timer)
    const timedOut = timeout.signal.aborted && !input.signal.aborted
    return {
      ...base,
      decision: 'ask',
      fallback: timedOut ? 'timeout' : 'error',
      error: timedOut
        ? `Sem resposta do juiz em ${sa.timeoutS}s.`
        : input.signal.aborted
          ? 'Interrompido.'
          : (e as Error).message || String(e),
      reason: '',
      ...(acc.usage ? { usage: acc.usage } : {}),
      durationMs: Date.now() - t0,
      request,
      ...(acc.content ? { response: acc.content.slice(0, RESPONSE_MAX) } : {})
    }
  }
  clearTimeout(timer)
  const parsed = parseJudgeOutput(acc.content, sa.labels)
  // sem "O juiz pode negar": rejeitar vira perguntar (o motivo fica como dica no card)
  const mapped = parsed.decision ? mapJudgeDecision(parsed.decision, sa.canDeny) : null
  const rec: SmartApproveRecord = {
    ...base,
    model: base.model,
    decision: mapped?.decision ?? 'ask',
    ...(mapped?.wouldReject ? { wouldReject: true } : {}),
    // categoria (perguntar/negar): da linha CATEGORY:; templates antigos sem ela → ausente
    ...(parsed.decision && parsed.decision !== 'approve' && parsed.category
      ? { category: parsed.category }
      : {}),
    // sem decisão, o texto do juiz não vira "motivo" (fica em `response`)
    reason: parsed.decision ? parsed.reason : '',
    ...(acc.usage ? { usage: acc.usage } : {}),
    durationMs: Date.now() - t0,
    request,
    response: acc.content.slice(0, RESPONSE_MAX)
  }
  if (!parsed.decision) {
    rec.fallback = 'ambiguous'
    rec.error =
      parsed.problem === 'empty'
        ? 'O juiz respondeu vazio.'
        : parsed.problem === 'multiple'
          ? 'Resposta ambígua: mais de um rótulo.'
          : 'Resposta sem rótulo reconhecível na primeira linha.'
  }
  return rec
}

// ---------------- "Executar mesmo assim": liberação de uma vez só ----------------
// Depois de uma rejeição o usuário pode liberar ESTA chamada: a próxima chamada idêntica (mesma
// sessão, mesma tool, mesmos argumentos) roda sem juiz nem confirmação, uma única vez. Expira em
// OVERRIDE_TTL_MS ou ao reiniciar o app (só memória).

export const OVERRIDE_TTL_MS = 15 * 60_000

interface Override {
  tool: ToolName
  key: string
  expiresAt: number
}

const overrides = new Map<string, Override[]>()

export function addOverride(
  sessionId: string,
  tool: ToolName,
  args: unknown,
  now = Date.now()
): void {
  const list = (overrides.get(sessionId) ?? []).filter((o) => o.expiresAt > now)
  list.push({ tool, key: argsKey(args), expiresAt: now + OVERRIDE_TTL_MS })
  overrides.set(sessionId, list)
}

/** Consome a liberação da chamada idêntica, se houver. */
export function takeOverride(
  sessionId: string,
  tool: ToolName,
  args: unknown,
  now = Date.now()
): boolean {
  const list = (overrides.get(sessionId) ?? []).filter((o) => o.expiresAt > now)
  const key = argsKey(args)
  const i = list.findIndex((o) => o.tool === tool && o.key === key)
  if (i >= 0) list.splice(i, 1)
  if (list.length) overrides.set(sessionId, list)
  else overrides.delete(sessionId)
  return i >= 0
}

export function clearOverrides(sessionId?: string): void {
  if (sessionId) overrides.delete(sessionId)
  else overrides.clear()
}
