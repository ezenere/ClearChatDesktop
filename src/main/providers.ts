// providers.listModels / providers.test — GET {baseUrl}/models pelo adaptador do provider
// (OpenAI-compatible/OpenRouter: mapModel; Anthropic nativa: mapAnthropicModel, paginado).
import { providerKind, type ProviderKind } from '@shared/providerKinds'
import { openRouterReasoning, openRouterSupportedParams } from '@shared/modelParams'
import type { ProviderTestInput, ProviderTestResult } from '@shared/ipc'
import type { ModelInfo, Provider } from '@shared/types'
import { adapterFor } from './agent/adapters'
import { fetchAnthropicModels } from './agent/adapters/anthropic'
import { readableError } from './agent/llm'
import { listElevenLabsModels } from './voice/elevenlabs'

const CACHE_MS = 5 * 60_000
const cache = new Map<string, { at: number; key: string; models: ModelInfo[] }>()

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : undefined
}

export function mapModel(m: Record<string, unknown>): ModelInfo | null {
  const id = typeof m.id === 'string' ? m.id : null
  if (!id) return null
  const info: ModelInfo = { id }
  if (typeof m.name === 'string' && m.name) info.name = m.name
  const ctx =
    num(m.context_length) ??
    num((m.top_provider as Record<string, unknown> | undefined)?.context_length) ??
    num(m.context_window) ??
    num(m.max_context_length)
  if (ctx !== undefined) info.contextLength = ctx
  const pricing = m.pricing as Record<string, unknown> | undefined
  if (pricing) {
    const p = num(pricing.prompt)
    const c = num(pricing.completion)
    if (p !== undefined && p >= 0) info.promptPrice = p
    if (c !== undefined && c >= 0) info.completionPrice = c
  }
  const arch = m.architecture as Record<string, unknown> | undefined
  if (arch && Array.isArray(arch.input_modalities)) {
    info.inputModalities = (arch.input_modalities as unknown[]).filter(
      (x): x is string => typeof x === 'string'
    )
  }
  if (Array.isArray(m.supported_parameters)) {
    info.supportsTools = (m.supported_parameters as unknown[]).includes('tools')
    const params = openRouterSupportedParams(m.supported_parameters)
    if (params) info.supportedParams = params
  }
  // OpenRouter: níveis de reasoning_effort aceitos (supported_efforts / default_effort / mandatory)
  const reasoning = openRouterReasoning(m.reasoning)
  if (reasoning) info.reasoning = reasoning
  // OpenRouter: caminhos de API que servem o modelo (busca nativa de tools pela Messages API, 1.12.0)
  if (Array.isArray(m.endpoints)) {
    const eps = (m.endpoints as unknown[]).filter((x): x is string => typeof x === 'string')
    if (eps.length) info.endpoints = eps
  }
  return info
}

type ModelsInput = Pick<Provider, 'baseUrl' | 'apiKey' | 'headers'> & { kind?: ProviderKind }

/** GET com erro legível (rede / HTTP / JSON inválido). */
async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause
    throw new Error(
      `Falha de rede: ${(e as Error).message}${cause?.message ? ` (${cause.message})` : ''}`,
      { cause: e }
    )
  }
  const text = await res.text()
  if (!res.ok) throw new Error(readableError(res.status, res.statusText, text))
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Resposta de /models não é JSON.')
  }
}

async function fetchModels(p: ModelsInput): Promise<ModelInfo[]> {
  const base = p.baseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL inválida (use http:// ou https://).')
  const adapter = adapterFor(p)
  if (adapter.kind === 'elevenlabs') {
    // provedor de voz: os modelos de TTS da ElevenLabs (GET /v1/models — exige a chave)
    const models = await listElevenLabsModels({
      baseUrl: base,
      apiKey: p.apiKey,
      headers: p.headers ?? {}
    })
    return models.map((m) => ({ id: m.id, name: m.name }))
  }
  const headers = adapter.getHeaders({ apiKey: p.apiKey, headers: p.headers ?? {} })
  if (adapter.kind === 'anthropic') {
    const models = await fetchAnthropicModels(base, (url) => getJson(url, headers))
    return models.sort((a, b) => a.id.localeCompare(b.id))
  }
  const j = await getJson(`${base}/models`, headers)
  const list = Array.isArray(j)
    ? j
    : Array.isArray((j as { data?: unknown }).data)
      ? (j as { data: unknown[] }).data
      : Array.isArray((j as { models?: unknown }).models)
        ? (j as { models: unknown[] }).models
        : null
  if (!list) throw new Error('Formato inesperado da resposta de /models.')
  return list
    .map((m) => (m && typeof m === 'object' ? mapModel(m as Record<string, unknown>) : null))
    .filter((m): m is ModelInfo => !!m)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function listModels(provider: Provider): Promise<ModelInfo[]> {
  const key = `${providerKind(provider)}|${provider.baseUrl}|${provider.apiKey}|${JSON.stringify(provider.headers)}`
  const c = cache.get(provider.id)
  if (c && c.key === key && Date.now() - c.at < CACHE_MS) return c.models
  const models = await fetchModels(provider)
  cache.set(provider.id, { at: Date.now(), key, models })
  return models
}

export function invalidateModels(providerId: string): void {
  cache.delete(providerId)
}

export async function testProvider(p: ProviderTestInput): Promise<ProviderTestResult> {
  try {
    const base = (p.baseUrl ?? '').trim().replace(/\/+$/, '')
    const kind = providerKind({ baseUrl: base, kind: p.kind })
    const input = { kind, baseUrl: base, apiKey: (p.apiKey ?? '').trim(), headers: p.headers ?? {} }
    const models = await fetchModels(input)
    // /models do OpenRouter é público: valida a key em /key.
    if (kind === 'openrouter') {
      if (!input.apiKey)
        return { ok: false, error: 'Informe a API key.', modelCount: models.length }
      const headers = adapterFor(kind).getHeaders(input)
      const res = await fetch(`${base}/key`, { headers, signal: AbortSignal.timeout(20_000) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return {
          ok: false,
          error: readableError(res.status, res.statusText, text),
          modelCount: models.length
        }
      }
    }
    return { ok: true, modelCount: models.length }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Item do /models já em cache (sem rede; ignora a validade — só serve para saber os parâmetros
 * aceitos). Desconhecido → undefined (o filtro de parâmetros trata como "todos").
 */
export function cachedModelInfo(providerId: string, model: string): ModelInfo | undefined {
  return cache.get(providerId)?.models.find((m) => m.id === model)
}
