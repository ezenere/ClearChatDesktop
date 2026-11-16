// Tool `weather` (protocolo 1.16.0, SYNC_PROTOCOL.md §4.3.6 — "Previsão do tempo"): o tempo agora, por
// dia e por hora num lugar (nome → geocodificação do Open-Meteo, com o GeoNames por trás), em
// coordenadas ou na posição atual do aparelho (só quem a fornece — o celular, com a aprovação de
// localização dele). Dados do Open-Meteo (modelos dos serviços meteorológicos nacionais; CC BY 4.0 —
// o crédito vai na saída). Sem chave e sem aprovação própria.
//
// Puro (sem Node/Electron/DOM): a rede (`fetch`) e a posição do aparelho entram por `WeatherDeps`; o
// desktop (src/main/tools) e o mobile (vendora este arquivo) rodam o mesmo código. A estrutura em
// provedor (geocodificar → previsão → texto) é o encaixe de outros provedores com chave no futuro.
import { formatOffset } from './datetime'

// ---------------- limites e endereços ----------------

export const WEATHER_LIMITS = {
  /** Dias de previsão (hoje incluído). */
  daysDefault: 3,
  daysMax: 16,
  /** Linhas por hora, a partir da hora atual. */
  hoursMax: 48,
  /** Dias anteriores (resumo diário). */
  pastDaysMax: 31,
  /** Teto de cada pedido ao Open-Meteo. */
  timeoutMs: 15_000,
  /** Resultados pedidos ao geocodificador (o 1º é o usado; os outros vão como alternativas). */
  geocodeCount: 5,
  placeMaxChars: 200
} as const

export const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast'
export const OPEN_METEO_GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search'
export const WEATHER_SOURCE = 'Open-Meteo.com'
export const WEATHER_CREDIT = 'Open-Meteo.com (CC BY 4.0)'

const CURRENT_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'weather_code',
  'cloud_cover',
  'precipitation',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'is_day'
]
const DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
  'uv_index_max',
  'sunrise',
  'sunset'
]
const HOURLY_VARS = [
  'temperature_2m',
  'precipitation_probability',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'uv_index'
]

// ---------------- argumentos ----------------

export interface WeatherArgs {
  place: string | null
  latitude: number | null
  longitude: number | null
  /** Código ISO 3166-1 alfa-2 (desambigua o lugar), em maiúsculas. */
  country: string | null
  days: number
  hours: number
  pastDays: number
  /** Ajustes feitos (valores fora do intervalo), para a saída avisar. */
  notes: string[]
}

export type WeatherArgsResult = { ok: true; value: WeatherArgs } | { ok: false; error: string }

/** Número (ou número em texto); ausente/vazio → null; inválido → NaN. */
function num(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim()) return Number(v.trim().replace(',', '.'))
  return NaN
}

function intIn(
  v: unknown,
  name: string,
  min: number,
  max: number,
  def: number,
  notes: string[]
): number | string {
  const n = num(v)
  if (n == null) return def
  if (!Number.isFinite(n)) return `"${name}" deve ser um número inteiro (${min} a ${max}).`
  const r = Math.round(n)
  if (r < min || r > max) {
    const c = Math.min(max, Math.max(min, r))
    notes.push(`"${name}" vai de ${min} a ${max}: usei ${c}.`)
    return c
  }
  return r
}

export function parseWeatherArgs(args: Record<string, unknown>): WeatherArgsResult {
  const a = args && typeof args === 'object' ? args : {}
  const notes: string[] = []
  const rawPlace = a.place
  if (rawPlace != null && typeof rawPlace !== 'string')
    return { ok: false, error: '"place" deve ser um texto (nome da cidade ou lugar).' }
  const place = (rawPlace ?? '').trim().replace(/\s+/g, ' ').slice(0, WEATHER_LIMITS.placeMaxChars)
  const lat = num(a.latitude)
  const lon = num(a.longitude)
  if (lat != null || lon != null) {
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon))
      return { ok: false, error: 'informe "latitude" e "longitude" juntas, como números.' }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180)
      return { ok: false, error: 'latitude vai de −90 a 90 e longitude de −180 a 180.' }
  }
  const rawCountry = a.country
  if (rawCountry != null && typeof rawCountry !== 'string')
    return { ok: false, error: '"country" deve ser o código do país com 2 letras (ex.: "BR").' }
  const country = (rawCountry ?? '').trim().toUpperCase()
  if (country && !/^[A-Z]{2}$/.test(country))
    return {
      ok: false,
      error: '"country" deve ser o código do país com 2 letras (ex.: "BR", "PT").'
    }
  const days = intIn(a.days, 'days', 1, WEATHER_LIMITS.daysMax, WEATHER_LIMITS.daysDefault, notes)
  if (typeof days === 'string') return { ok: false, error: days }
  const hours = intIn(a.hours, 'hours', 0, WEATHER_LIMITS.hoursMax, 0, notes)
  if (typeof hours === 'string') return { ok: false, error: hours }
  const pastDays = intIn(a.past_days, 'past_days', 0, WEATHER_LIMITS.pastDaysMax, 0, notes)
  if (typeof pastDays === 'string') return { ok: false, error: pastDays }
  return {
    ok: true,
    value: {
      place: place || null,
      latitude: lat,
      longitude: lon,
      country: country || null,
      days,
      hours,
      pastDays,
      notes
    }
  }
}

/** Sem lugar nem coordenadas: a tool usa a posição atual do aparelho (se ele a fornece). */
export function weatherUsesDevicePosition(args: Record<string, unknown>): boolean {
  const a = args && typeof args === 'object' ? args : {}
  const place = typeof a.place === 'string' && a.place.trim() !== ''
  return !place && num(a.latitude) == null && num(a.longitude) == null
}

// ---------------- rede ----------------

/** O mínimo de `fetch` que a tool usa (o global do Node/Electron e do React Native servem). */
export type WeatherFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** Posição do aparelho, já na precisão escolhida pelo usuário. */
export interface DevicePoint {
  lat: number
  lon: number
  /** Como a saída descreve o ponto ("sua localização atual, aproximada (~1 km)"). */
  label: string
  notes?: string[]
}

/** Geocodificador de reserva (o celular passa o do OpenStreetMap), quando o Open-Meteo não acha. */
export type FallbackGeocoder = (
  query: string,
  signal: AbortSignal
) => Promise<{ lat: number; lon: number; label: string; source: string } | null>

export interface WeatherDeps {
  fetch: WeatherFetch
  signal: AbortSignal
  onOutput?: (text: string) => void
  /** Posição atual do aparelho (pode pedir permissão; lança com o erro em pt-BR). Ausente = o
   * aparelho não fornece (computador). */
  devicePosition?: () => Promise<DevicePoint>
  fallbackGeocoder?: FallbackGeocoder
  userAgent?: string
  timeoutMs?: number
}

class WeatherError extends Error {}

const abortError = (): Error => {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

async function getJson(d: WeatherDeps, url: string): Promise<unknown> {
  if (d.signal.aborted) throw abortError()
  const ms = d.timeoutMs ?? WEATHER_LIMITS.timeoutMs
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, ms)
  const onAbort = (): void => ac.abort()
  d.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await d.fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'application/json', ...(d.userAgent ? { 'User-Agent': d.userAgent } : {}) }
    })
    const body = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(body)
    } catch {
      json = null
    }
    if (!res.ok) {
      const reason =
        json &&
        typeof json === 'object' &&
        typeof (json as { reason?: unknown }).reason === 'string'
          ? (json as { reason: string }).reason
          : ''
      if (res.status === 429)
        throw new WeatherError(
          'o Open-Meteo recusou por excesso de pedidos (limite do uso gratuito). Tente mais tarde.'
        )
      throw new WeatherError(
        `o Open-Meteo respondeu HTTP ${res.status}${reason ? `: ${reason}` : ''}.`
      )
    }
    if (json === null) throw new WeatherError('o Open-Meteo devolveu uma resposta ilegível.')
    return json
  } catch (e) {
    if (d.signal.aborted) throw abortError()
    if (e instanceof WeatherError) throw e
    if (timedOut)
      throw new WeatherError(
        `o Open-Meteo demorou demais para responder (${Math.round(ms / 1000)} s).`
      )
    throw new WeatherError(`o Open-Meteo não respondeu (${(e as Error)?.message ?? String(e)}).`)
  } finally {
    clearTimeout(timer)
    d.signal.removeEventListener('abort', onAbort)
  }
}

// ---------------- geocodificação ----------------

export interface GeoPlace {
  name: string
  lat: number
  lon: number
  admin1: string | null
  admin2: string | null
  country: string | null
  countryCode: string | null
  population: number | null
}

export function geocodingUrl(
  name: string,
  country: string | null,
  count: number = WEATHER_LIMITS.geocodeCount
): string {
  const q = [
    `name=${encodeURIComponent(name)}`,
    `count=${count}`,
    'language=pt',
    'format=json',
    ...(country ? [`countryCode=${country}`] : [])
  ]
  return `${OPEN_METEO_GEOCODING}?${q.join('&')}`
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Resposta do geocodificador → lugares válidos (na ordem dele: relevância/população). */
export function parseGeocoding(json: unknown): GeoPlace[] {
  const results = (json as { results?: unknown })?.results
  if (!Array.isArray(results)) return []
  const out: GeoPlace[] = []
  for (const r of results) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const name = str(o.name)
    if (!name || !fin(o.latitude) || !fin(o.longitude)) continue
    out.push({
      name,
      lat: o.latitude,
      lon: o.longitude,
      admin1: str(o.admin1),
      admin2: str(o.admin2),
      country: str(o.country),
      countryCode: str(o.country_code),
      population: fin(o.population) ? o.population : null
    })
  }
  return out
}

/** Sem acento e sem caixa (sem `normalize` no motor JS: só sem caixa). */
function fold(s: string): string {
  let t: string
  try {
    t = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  } catch {
    t = s
  }
  return t.toLowerCase().trim()
}

/**
 * Qual resultado usar: o 1º do geocodificador (a ordem dele já pesa relevância e população, e ele
 * casa nomes em outras línguas — "Tokyo" → Tóquio), a menos que NENHUM resultado tenha exatamente o
 * nome pedido (sem acento/caixa; o pedido até a 1ª vírgula) — busca aproximada ("Rio" → Riobamba,
 * Rio Branco, Rio de Janeiro…): aí o mais populoso. O escolhido vem primeiro; os outros na ordem.
 */
export function rankPlaces(found: GeoPlace[], query: string): GeoPlace[] {
  if (found.length < 2) return found
  const q = fold(query.split(',')[0] ?? '')
  if (found.some((p) => fold(p.name) === q)) return found
  const pick = found.reduce((best, p) => ((p.population ?? 0) > (best.population ?? 0) ? p : best))
  return [pick, ...found.filter((p) => p !== pick)]
}

/** "Curitiba (Paraná, Brasil)" — sem repetir o nome quando a região tem o mesmo. */
export function geoPlaceLabel(p: GeoPlace): string {
  const parts = [p.admin1, p.country].filter(
    (x, i, all): x is string => !!x && x !== p.name && all.indexOf(x) === i
  )
  return parts.length ? `${p.name} (${parts.join(', ')})` : p.name
}

const coord = (v: number): string => String(Math.round(v * 10_000) / 10_000)

// ---------------- previsão ----------------

export interface Forecast {
  latitude: number
  longitude: number
  elevation: number | null
  timezone: string | null
  utcOffsetSeconds: number | null
  current: Record<string, unknown> | null
  hourly: Record<string, unknown[]> | null
  daily: Record<string, unknown[]> | null
}

export function forecastUrl(
  point: { lat: number; lon: number },
  a: Pick<WeatherArgs, 'days' | 'hours' | 'pastDays'>
): string {
  // as linhas por hora podem passar do último dia pedido (ex.: 48 h com 1 dia): pede dias que cubram
  const fcDays = Math.min(
    WEATHER_LIMITS.daysMax,
    Math.max(a.days, a.hours > 0 ? Math.ceil(a.hours / 24) + 1 : 1)
  )
  const q = [
    `latitude=${coord(point.lat)}`,
    `longitude=${coord(point.lon)}`,
    `current=${CURRENT_VARS.join(',')}`,
    `daily=${DAILY_VARS.join(',')}`,
    ...(a.hours > 0 ? [`hourly=${HOURLY_VARS.join(',')}`, `forecast_hours=${a.hours}`] : []),
    'timezone=auto',
    `forecast_days=${fcDays}`,
    ...(a.pastDays > 0 ? [`past_days=${a.pastDays}`] : [])
  ]
  return `${OPEN_METEO_FORECAST}?${q.join('&')}`
}

function series(v: unknown): Record<string, unknown[]> | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.time)) return null
  const out: Record<string, unknown[]> = {}
  for (const [k, arr] of Object.entries(o)) if (Array.isArray(arr)) out[k] = arr
  return out
}

export function parseForecast(json: unknown): Forecast | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  if (!fin(o.latitude) || !fin(o.longitude)) return null
  return {
    latitude: o.latitude,
    longitude: o.longitude,
    elevation: fin(o.elevation) ? o.elevation : null,
    timezone: str(o.timezone),
    utcOffsetSeconds: fin(o.utc_offset_seconds) ? o.utc_offset_seconds : null,
    current:
      o.current && typeof o.current === 'object' ? (o.current as Record<string, unknown>) : null,
    hourly: series(o.hourly),
    daily: series(o.daily)
  }
}

// ---------------- texto ----------------

/** Códigos WMO (o `weather_code` do Open-Meteo; no diário, o mais severo do dia). */
export const WMO_TEXT: Record<number, string> = {
  0: 'céu limpo',
  1: 'predominantemente limpo',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'neblina',
  48: 'neblina com geada',
  51: 'garoa fraca',
  53: 'garoa moderada',
  55: 'garoa forte',
  56: 'garoa congelante fraca',
  57: 'garoa congelante forte',
  61: 'chuva fraca',
  63: 'chuva moderada',
  65: 'chuva forte',
  66: 'chuva congelante fraca',
  67: 'chuva congelante forte',
  71: 'neve fraca',
  73: 'neve moderada',
  75: 'neve forte',
  77: 'grãos de neve',
  80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva moderadas',
  82: 'pancadas de chuva fortes',
  85: 'pancadas de neve fracas',
  86: 'pancadas de neve fortes',
  95: 'trovoada',
  96: 'trovoada com granizo fraco',
  99: 'trovoada com granizo forte'
}

export function weatherCodeText(code: unknown): string | null {
  return fin(code) ? (WMO_TEXT[code] ?? `código ${code}`) : null
}

const COMPASS = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO']
/** Direção DE ONDE o vento vem (graus) → rosa de 8 pontos em português. */
export function compassPoint(deg: unknown): string | null {
  if (!fin(deg)) return null
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]
}

/** Número em pt-BR com até `dec` casas, sem zeros à direita ("19,6", "18", "0,1"). */
export function fmtNum(v: number, dec = 1): string {
  const f = 10 ** dec
  const r = Math.round(v * f) / f
  return String(Object.is(r, -0) ? 0 : r).replace('.', ',')
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

/** "2026-11-16" → { y, m, d } (null se não for uma data). */
function ymd(s: unknown): { y: number; m: number; d: number } | null {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(s) : null
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null
}

const dayNum = (p: { y: number; m: number; d: number }): number =>
  Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000)

/** "hoje, seg 16/11" / "amanhã, ter 17/11" / "qua 18/11" (relativo ao dia de hoje DO LUGAR). */
export function dayLabel(date: string, today: string | null): string {
  const p = ymd(date)
  if (!p) return date
  const base = `${WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]} ${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}`
  const t = ymd(today)
  if (!t) return base
  const diff = dayNum(p) - dayNum(t)
  const rel = diff === 0 ? 'hoje' : diff === 1 ? 'amanhã' : diff === -1 ? 'ontem' : null
  return rel ? `${rel}, ${base}` : base
}

const hhmm = (s: unknown): string | null => {
  const m = typeof s === 'string' ? /T(\d{2}:\d{2})/.exec(s) : null
  return m ? m[1] : null
}

const at = (o: Record<string, unknown[]>, k: string, i: number): unknown => o[k]?.[i]

function wind(speed: unknown, gusts: unknown, dir: unknown, max = false): string | null {
  if (!fin(speed)) return null
  const d = compassPoint(dir)
  return `vento ${max ? 'até ' : ''}${fmtNum(speed, 0)} km/h${d ? ` de ${d}` : ''}${fin(gusts) ? `, rajadas ${fmtNum(gusts, 0)} km/h` : ''}`
}

function currentLine(c: Record<string, unknown>): string | null {
  const t = c.temperature_2m
  if (!fin(t)) return null
  const time = hhmm(c.time)
  const parts = [
    `${fmtNum(t)} °C${fin(c.apparent_temperature) ? ` (sensação ${fmtNum(c.apparent_temperature)} °C)` : ''}`,
    weatherCodeText(c.weather_code),
    fin(c.relative_humidity_2m) ? `umidade ${fmtNum(c.relative_humidity_2m, 0)}%` : null,
    fin(c.cloud_cover) ? `nuvens ${fmtNum(c.cloud_cover, 0)}%` : null,
    wind(c.wind_speed_10m, c.wind_gusts_10m, c.wind_direction_10m),
    fin(c.precipitation) && c.precipitation > 0
      ? `precipitação recente ${fmtNum(c.precipitation)} mm`
      : null
  ].filter((x): x is string => !!x)
  const when = [time, c.is_day === 0 ? 'noite' : null].filter(Boolean).join(', ')
  return `Agora${when ? ` (${when})` : ''}: ${parts.join(' · ')}`
}

function dailyLine(dl: Record<string, unknown[]>, i: number, today: string | null): string | null {
  const date = at(dl, 'time', i)
  if (typeof date !== 'string') return null
  const tmin = at(dl, 'temperature_2m_min', i)
  const tmax = at(dl, 'temperature_2m_max', i)
  const rain = at(dl, 'precipitation_sum', i)
  const prob = at(dl, 'precipitation_probability_max', i)
  const uv = at(dl, 'uv_index_max', i)
  const rise = hhmm(at(dl, 'sunrise', i))
  const set = hhmm(at(dl, 'sunset', i))
  const parts = [
    fin(tmin) && fin(tmax) ? `${fmtNum(tmin)} a ${fmtNum(tmax)} °C` : null,
    weatherCodeText(at(dl, 'weather_code', i)),
    fin(rain) || fin(prob)
      ? `chuva ${fin(rain) ? `${fmtNum(rain)} mm` : '—'}${fin(prob) ? ` (chance ${fmtNum(prob, 0)}%)` : ''}`
      : null,
    wind(
      at(dl, 'wind_speed_10m_max', i),
      at(dl, 'wind_gusts_10m_max', i),
      at(dl, 'wind_direction_10m_dominant', i),
      true
    ),
    fin(uv) ? `UV ${fmtNum(uv, 0)}` : null,
    rise && set ? `sol ${rise}–${set}` : null
  ].filter((x): x is string => !!x)
  return `- ${dayLabel(date, today)}: ${parts.join(' · ')}`
}

function hourlyLine(h: Record<string, unknown[]>, i: number, today: string | null): string | null {
  const time = at(h, 'time', i)
  const clock = hhmm(time)
  if (typeof time !== 'string' || !clock) return null
  const date = time.slice(0, 10)
  // outro dia que não hoje: "amanhã 01:00" / "qua 18/11 01:00"
  const prefix = today && date === today ? '' : `${dayLabel(date, today).split(', ')[0]} `
  const t = at(h, 'temperature_2m', i)
  const prob = at(h, 'precipitation_probability', i)
  const rain = at(h, 'precipitation', i)
  const uv = at(h, 'uv_index', i)
  const ws = at(h, 'wind_speed_10m', i)
  const parts = [
    fin(t) ? `${fmtNum(t)} °C` : null,
    weatherCodeText(at(h, 'weather_code', i)),
    fin(prob) || fin(rain)
      ? `chuva ${fin(prob) ? `${fmtNum(prob, 0)}%` : '—'}${fin(rain) ? `, ${fmtNum(rain)} mm` : ''}`
      : null,
    fin(ws) ? `vento ${fmtNum(ws, 0)} km/h` : null,
    fin(uv) && uv >= 1 ? `UV ${fmtNum(uv, 0)}` : null
  ].filter((x): x is string => !!x)
  return `- ${prefix}${clock} · ${parts.join(' · ')}`
}

export interface WeatherWhere {
  /** Como a saída nomeia o lugar ("Curitiba (Paraná, Brasil)", "sua localização atual…"). */
  label: string
  lat: number
  lon: number
  /** De onde veio o nome (geocodificador), para o crédito. */
  geocodedBy?: string
  /** Outros resultados do geocodificador (desambiguação). */
  alternatives?: GeoPlace[]
  notes?: string[]
}

/** Saída da tool: cabeçalho, agora, por dia, por hora, alternativas, observações e o crédito. */
export function formatWeather(fc: Forecast, a: WeatherArgs, where: WeatherWhere): string {
  const off =
    fc.utcOffsetSeconds != null ? ` (UTC${formatOffset(Math.round(fc.utcOffsetSeconds / 60))})` : ''
  const lines: string[] = [
    `Tempo em ${where.label} · ${coord(where.lat)}, ${coord(where.lon)}${fc.elevation != null ? ` · ${fmtNum(fc.elevation, 0)} m` : ''} — horários locais de lá${fc.timezone ? `: ${fc.timezone}${off}` : off}`
  ]
  const today = typeof fc.current?.time === 'string' ? fc.current.time.slice(0, 10) : null
  const cur = fc.current ? currentLine(fc.current) : null
  if (cur) lines.push(cur)
  const dl = fc.daily
  if (dl) {
    const n = Math.min(dl.time.length, a.pastDays + a.days)
    const rows: string[] = []
    for (let i = 0; i < n; i++) {
      const l = dailyLine(dl, i, today)
      if (l) rows.push(l)
    }
    if (rows.length) lines.push('Por dia:', ...rows)
  }
  const h = fc.hourly
  if (h && a.hours > 0) {
    const rows: string[] = []
    for (let i = 0; i < Math.min(h.time.length, a.hours); i++) {
      const l = hourlyLine(h, i, today)
      if (l) rows.push(l)
    }
    if (rows.length) lines.push(`Por hora (próximas ${rows.length} h):`, ...rows)
  }
  if (!cur && !lines[1]) lines.push('(o Open-Meteo não devolveu dados para este ponto)')
  const alts = where.alternatives ?? []
  if (alts.length)
    lines.push(
      `Outros lugares com esse nome: ${alts.map((p) => `${geoPlaceLabel(p)} ${coord(p.lat)}, ${coord(p.lon)}`).join(' · ')} — se era outro, chame de novo com latitude e longitude (ou com "country").`
    )
  for (const n of [...a.notes, ...(where.notes ?? [])]) lines.push(`Obs.: ${n}`)
  lines.push(
    `Fonte: ${WEATHER_CREDIT}${where.geocodedBy ? `; lugar: ${where.geocodedBy}` : ''} — previsão de modelos meteorológicos (não é medição de estação).`
  )
  return lines.join('\n')
}

// ---------------- execução ----------------

export type WeatherToolResult = { content: string; status: 'ok' | 'error' }

const fail = (msg: string): WeatherToolResult => ({ content: `Erro: ${msg}`, status: 'error' })

/** Resolve o ponto: coordenadas → nome (Open-Meteo; reserva do aparelho) → posição do aparelho. */
async function resolveWhere(
  a: WeatherArgs,
  d: WeatherDeps
): Promise<WeatherWhere | WeatherToolResult> {
  if (a.latitude != null && a.longitude != null)
    return {
      label: a.place ? `${a.place} (coordenadas informadas)` : 'coordenadas informadas',
      lat: a.latitude,
      lon: a.longitude
    }
  if (a.place) {
    d.onOutput?.(`Procurando “${a.place}”…`)
    const found = rankPlaces(
      parseGeocoding(await getJson(d, geocodingUrl(a.place, a.country))),
      a.place
    )
    if (found.length) {
      const [first, ...rest] = found
      return {
        label: geoPlaceLabel(first),
        lat: first.lat,
        lon: first.lon,
        geocodedBy: 'GeoNames via Open-Meteo',
        alternatives: rest.slice(0, WEATHER_LIMITS.geocodeCount - 1)
      }
    }
    if (d.fallbackGeocoder) {
      const hit = await d.fallbackGeocoder(a.place, d.signal).catch((e: unknown) => {
        if (d.signal.aborted) throw abortError()
        void e
        return null
      })
      if (hit) return { label: hit.label, lat: hit.lat, lon: hit.lon, geocodedBy: hit.source }
    }
    return fail(
      `não encontrei “${a.place}”${a.country ? ` (país ${a.country})` : ''}. Use o nome da cidade (ex.: "Curitiba", "Springfield, Illinois", "Vila Madalena, São Paulo"), o país em "country" ou latitude e longitude.`
    )
  }
  if (!d.devicePosition)
    return fail(
      'informe "place" (cidade ou lugar) ou "latitude" e "longitude" — este aparelho (computador) não fornece a localização atual.'
    )
  const p = await d.devicePosition()
  return { label: p.label, lat: p.lat, lon: p.lon, notes: p.notes }
}

/**
 * Executa a tool. Erros previsíveis (argumentos, lugar não encontrado, Open-Meteo fora) voltam como
 * resultado de erro; cancelamento lança AbortError; o erro da posição do aparelho (permissão,
 * "Nunca"…) é propagado como veio (o runner do celular o converte).
 */
export async function runWeatherTool(
  args: Record<string, unknown>,
  d: WeatherDeps
): Promise<WeatherToolResult> {
  const parsed = parseWeatherArgs(args)
  if (!parsed.ok) return fail(parsed.error)
  const a = parsed.value
  try {
    const where = await resolveWhere(a, d)
    if ('status' in where) return where
    d.onOutput?.('Consultando a previsão…')
    const fc = parseForecast(await getJson(d, forecastUrl(where, a)))
    if (!fc) return fail('o Open-Meteo devolveu uma resposta sem a previsão.')
    return { content: formatWeather(fc, a, where), status: 'ok' }
  } catch (e) {
    if (e instanceof WeatherError) return fail(e.message)
    throw e
  }
}

/** Resumo do card da tool: "Curitiba · 3 dias · 12 h" / "aqui · 1 dia". */
export function weatherToolSummary(args: Record<string, unknown>): string {
  const p = parseWeatherArgs(args)
  if (!p.ok) return ''
  const a = p.value
  const where =
    a.place ??
    (a.latitude != null && a.longitude != null
      ? `${coord(a.latitude)}, ${coord(a.longitude)}`
      : 'aqui')
  const bits = [
    where,
    `${a.days} ${a.days === 1 ? 'dia' : 'dias'}`,
    a.hours ? `${a.hours} h` : null,
    a.pastDays ? `${a.pastDays} ${a.pastDays === 1 ? 'dia' : 'dias'} antes` : null
  ]
  return bits.filter(Boolean).join(' · ')
}
