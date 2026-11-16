// Lugares pelo Google (protocolo 1.17.0, SYNC_PROTOCOL.md §4.3.6 — "Lugares próximos"): o provedor
// Google do `nearby_places` (a tool é do celular — src/location do mobile; este módulo é puro e
// compartilhado). Maps Experience agent tools, `POST mapstools.googleapis.com/v1:searchText`: o Google
// devolve um RESUMO em texto (pt-BR, com nota ★, nº de avaliações e citações [i]) e os lugares citados
// (id, posição, links do Google Maps, atribuição). A saída traz o resumo, uma linha por lugar (nome,
// distância calculada aqui, links) e o pedido de citar o link do Maps logo depois de cada lugar — os
// termos do Google exigem a fonte junto do conteúdo gerado.
import { GoogleError, mapsToolsPost, type MapsToolsDeps } from './googleMapsTools'

export const GOOGLE_PLACES_LIMITS = {
  /** Até 5 = básico (Essentials); 6–10 = Pro (mais caro). */
  defaultLimit: 5,
  maxLimit: 10,
  /** Raio máximo do viés de local do Google. */
  maxBiasM: 50_000
} as const

export interface GooglePlacesQuery {
  /** O que procurar ("pizzaria", "farmácia", "Starbucks"…). */
  what: string
  cuisine?: string | null
  /** Centro por nome (sem coordenadas): vai no texto ("… perto de <near>"). */
  near?: string | null
  /** Centro conhecido (posição do aparelho ou coordenadas): viés de local + distâncias. */
  center?: { lat: number; lon: number } | null
  radiusM: number
  limit: number
}

export interface GooglePlace {
  index: number
  id: string
  name: string | null
  lat: number | null
  lon: number | null
  placeUrl: string | null
  directionsUrl: string | null
  reviewsUrl: string | null
  /** Metros do centro (só com centro conhecido). */
  distanceM: number | null
}

export interface GooglePlacesResult {
  summary: string
  places: GooglePlace[]
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Texto da busca: o quê (+ culinária) e, sem centro conhecido, "perto de <near>". */
export function placesQueryText(q: GooglePlacesQuery): string {
  const what = [q.what.trim(), q.cuisine?.trim()].filter(Boolean).join(' ')
  return !q.center && q.near?.trim() ? `${what} perto de ${q.near.trim()}` : what
}

/** Corpo do searchText (pt-BR; viés circular no centro, quando há). */
export function placesSearchBody(q: GooglePlacesQuery): Record<string, unknown> {
  const pageSize = Math.min(GOOGLE_PLACES_LIMITS.maxLimit, Math.max(1, Math.round(q.limit)))
  return {
    textQuery: placesQueryText(q),
    languageCode: 'pt-BR',
    pageSize,
    ...(q.center
      ? {
          locationBias: {
            circle: {
              center: {
                latitude: Math.round(q.center.lat * 1e5) / 1e5,
                longitude: Math.round(q.center.lon * 1e5) / 1e5
              },
              radiusMeters: Math.min(GOOGLE_PLACES_LIMITS.maxBiasM, Math.max(1, q.radiusM))
            }
          }
        }
      : {})
  }
}

/** Distância (haversine) em metros. */
export function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 6_371_000
  const rad = (d: number): number => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** "350 m" / "1,3 km" / "12 km". */
export function fmtMeters(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`
  const km = m / 1000
  return `${String(km < 10 ? Math.round(km * 10) / 10 : Math.round(km)).replace('.', ',')} km`
}

/** Nome do lugar pelo título da atribuição ("<nome> - Google Maps"). */
export function placeNameOf(title: unknown): string | null {
  const t = str(title)
  return t ? t.replace(/\s+-\s+Google Maps$/, '').trim() || null : null
}

export function parseGooglePlaces(
  json: unknown,
  center: { lat: number; lon: number } | null
): GooglePlacesResult {
  const o = obj(json)
  const places: GooglePlace[] = (Array.isArray(o.places) ? o.places : []).map((raw, index) => {
    const p = obj(raw)
    const loc = obj(p.location)
    const links = obj(p.googleMapsLinks)
    const lat = fin(loc.latitude) ? loc.latitude : null
    const lon = fin(loc.longitude) ? loc.longitude : null
    return {
      index,
      id: str(p.id) ?? '',
      name: placeNameOf(obj(p.attribution).title),
      lat,
      lon,
      placeUrl: str(links.placeUrl) ?? str(obj(p.attribution).url),
      directionsUrl: str(links.directionsUrl),
      reviewsUrl: str(links.reviewsUrl),
      distanceM: center && lat != null && lon != null ? distanceM(center, { lat, lon }) : null
    }
  })
  return { summary: str(o.summary) ?? '', places }
}

/** Busca no Google; GoogleError (legível) ou AbortError. */
export async function searchGooglePlaces(
  key: string,
  q: GooglePlacesQuery,
  d: MapsToolsDeps
): Promise<GooglePlacesResult> {
  const json = await mapsToolsPost('searchText', key, placesSearchBody(q), d)
  const r = parseGooglePlaces(json, q.center ?? null)
  if (!r.summary && !r.places.length) throw new GoogleError('resposta sem lugares')
  return r
}

/**
 * Texto da tool. `centerText` descreve o centro ("sua localização atual, aproximada (…)", "-23.5,
 * -46.6" ou o `near`); `notes` = observações (precisão, aviso de custo…).
 */
export function formatGooglePlaces(
  r: GooglePlacesResult,
  q: GooglePlacesQuery,
  centerText: string,
  notes: string[] = []
): string {
  const what = `“${q.what.trim()}”${q.cuisine?.trim() ? ` (culinária: ${q.cuisine.trim()})` : ''}`
  const n = r.places.length
  const where = q.center
    ? `perto de ${centerText} (o Google prioriza ${fmtMeters(q.radiusM)} em volta, mas pode trazer mais longe — veja as distâncias)`
    : `perto de ${centerText}`
  const lines: string[] = [
    n
      ? `${n} ${n === 1 ? 'lugar' : 'lugares'} do Google Maps para ${what} ${where}.`
      : `O Google Maps não achou lugares para ${what} ${where}.`
  ]
  if (r.summary)
    lines.push('', 'Resumo do Google Maps (o [n] é o lugar n da lista abaixo):', r.summary)
  if (n) {
    lines.push('', 'Lugares:')
    for (const p of r.places) {
      const links = [
        p.placeUrl ? `[Google Maps](${p.placeUrl})` : null,
        p.directionsUrl ? `[como chegar](${p.directionsUrl})` : null
      ].filter(Boolean)
      lines.push(
        `[${p.index}] **${p.name ?? '(sem nome)'}**${p.distanceM != null ? ` — ${fmtMeters(p.distanceM)}` : ''}${links.length ? ` · ${links.join(' · ')}` : ''}`
      )
    }
  }
  for (const x of notes) lines.push(`Obs.: ${x}`)
  if (n)
    lines.push(
      '',
      'Ao responder, cite cada lugar com o link do Google Maps dele logo depois do que disser sobre ele (ex.: [nome](link)) — exigência do Google. Notas (★), avaliações e descrições são do Google Maps.'
    )
  return lines.join('\n')
}
