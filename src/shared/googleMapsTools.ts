// Cliente comum do Google Maps Experience agent tools (protocolo 1.16.0/1.17.0): `POST
// https://mapstools.googleapis.com/v1:<método>` com a chave do Google Maps Platform no cabeçalho
// `X-Goog-Api-Key`, teto de tempo, cancelamento e os erros do Google em pt-BR curto. Usado pela
// previsão do tempo (@shared/googleWeather) e pelos lugares (@shared/googlePlaces). Puro (fetch
// injetado — o global do Node/Electron e do React Native servem).

export const MAPS_TOOLS_BASE = 'https://mapstools.googleapis.com/v1'

/** O mínimo de `fetch` usado (compatível com `WeatherFetch`). */
export type MapsToolsFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; method?: 'POST'; body?: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface MapsToolsDeps {
  fetch: MapsToolsFetch
  signal: AbortSignal
  /** Teto por pedido (padrão 15 s). */
  timeoutMs?: number
}

/** Falha do Google (mensagem já legível): quem chama decide a reserva (Open-Meteo, OpenStreetMap). */
export class GoogleError extends Error {}

export const abortError = (): Error => {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Erro do Google (`{ error: { code, message, status, details[].reason } }`) → texto pt-BR curto. */
export function googleErrorText(status: number, body: unknown): string {
  const e = obj(obj(body).error)
  const reasons = (Array.isArray(e.details) ? e.details : []).map((x) => str(obj(x).reason))
  const msg = str(e.message) ?? ''
  if (reasons.includes('API_KEY_INVALID') || /API key not valid/i.test(msg))
    return 'a chave do Google Maps é inválida (Configurações → Tempo e mapas)'
  if (
    reasons.includes('SERVICE_DISABLED') ||
    reasons.includes('API_KEY_SERVICE_BLOCKED') ||
    e.status === 'PERMISSION_DENIED'
  )
    return 'a chave não pode usar o "Maps Experience agent tools" (ative mapstools.googleapis.com no projeto e na chave)'
  if (status === 429 || e.status === 'RESOURCE_EXHAUSTED')
    return 'cota do Google esgotada (tente mais tarde ou aumente a cota no Cloud Console)'
  return `HTTP ${status}${msg ? `: ${msg}` : ''}`
}

/** POST num método do agent tools; resposta JSON (objeto) ou GoogleError / AbortError. */
export async function mapsToolsPost(
  method: string,
  key: string,
  body: Record<string, unknown>,
  d: MapsToolsDeps
): Promise<Record<string, unknown>> {
  if (d.signal.aborted) throw abortError()
  const ms = d.timeoutMs ?? 15_000
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, ms)
  const onAbort = (): void => ac.abort()
  d.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await d.fetch(`${MAPS_TOOLS_BASE}:${method}`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Goog-Api-Key': key
      },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    if (!res.ok) throw new GoogleError(googleErrorText(res.status, json))
    if (!json || typeof json !== 'object') throw new GoogleError('resposta ilegível')
    return json as Record<string, unknown>
  } catch (e) {
    if (d.signal.aborted) throw abortError()
    if (e instanceof GoogleError) throw e
    if (timedOut) throw new GoogleError(`sem resposta em ${Math.round(ms / 1000)} s`)
    throw new GoogleError(`sem conexão (${(e as Error)?.message ?? String(e)})`)
  } finally {
    clearTimeout(timer)
    d.signal.removeEventListener('abort', onAbort)
  }
}
