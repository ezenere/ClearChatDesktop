// Provedor Google da tool `weather` (protocolo 1.16.0, SYNC_PROTOCOL.md §4.3.6 — "Previsão do tempo"):
// Maps Experience agent tools, `POST mapstools.googleapis.com/v1:lookupWeather` com a chave do Google
// Maps Platform (Configurações → Tempo e mapas). Cada pedido devolve UM momento — agora, um dia
// (`date`) ou uma hora (`date` + `hour`, hora local do lugar) —, então a previsão é: agora primeiro
// (dá o fuso e o dia de hoje do lugar) e depois os dias e as horas em paralelo. É o produto que os
// termos do Google liberam para LLMs, com a atribuição dele logo depois do conteúdo: a saída traz o
// link para o agente citar. Puro (fetch injetado); o desktop e o mobile o passam em `deps.provider`.
import { formatOffset, zonedParts } from './datetime'
import {
  abortError,
  GoogleError,
  googleErrorText,
  MAPS_TOOLS_BASE,
  mapsToolsPost
} from './googleMapsTools'
import {
  compassPoint,
  dayLabel,
  fmtNum,
  WEATHER_LIMITS,
  type ProviderWhere,
  type WeatherArgs,
  type WeatherDeps,
  type WeatherProvider
} from './weather'

export const GOOGLE_WEATHER_URL = `${MAPS_TOOLS_BASE}:lookupWeather`

export const GOOGLE_WEATHER_LIMITS = {
  /** Previsão diária do Google: até 10 dias. */
  daysMax: 10,
  /** Cada hora é uma chamada (cobrada): teto por uso da tool. */
  hoursMax: 24,
  /** Pedidos simultâneos (a cota do Google é 300/min por projeto). */
  concurrency: 6
} as const

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const coord = (v: number): string => String(Math.round(v * 10_000) / 10_000)

// o cliente comum (@shared/googleMapsTools); reexportado para quem já importava daqui
export { googleErrorText }

const postJson = (
  d: WeatherDeps,
  key: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> =>
  mapsToolsPost('lookupWeather', key, body, {
    fetch: d.fetch,
    signal: d.signal,
    timeoutMs: d.timeoutMs ?? WEATHER_LIMITS.timeoutMs
  })

/** Até `n` tarefas ao mesmo tempo; o resultado de cada uma (ou o erro) na ordem. */
async function pool<T>(
  tasks: (() => Promise<T>)[],
  n: number
): Promise<({ ok: true; v: T } | { ok: false; e: unknown })[]> {
  const out: ({ ok: true; v: T } | { ok: false; e: unknown })[] = new Array(tasks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++
      try {
        out[i] = { ok: true, v: await tasks[i]() }
      } catch (e) {
        out[i] = { ok: false, e }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker))
  return out
}

// ---------------- leitura ----------------

const deg = (v: unknown): number | null => {
  const n = obj(v).degrees
  return fin(n) ? n : null
}
const speed = (v: unknown): number | null => {
  const n = obj(v).value
  return fin(n) ? n : null
}
const condText = (w: Record<string, unknown>): string | null =>
  str(obj(obj(w.weatherCondition).description).text)
const isNight = (w: Record<string, unknown>): boolean =>
  /_night$/.test(str(obj(w.weatherCondition).iconBaseUri) ?? '')

function rain(w: Record<string, unknown>, daily: boolean): string | null {
  const p = obj(w.precipitation)
  const prob = obj(p.probability).percent
  const qpf = obj(p.qpf).quantity
  if (!fin(prob) && !fin(qpf)) return null
  if (daily)
    return `chuva ${fin(qpf) ? `${fmtNum(qpf)} mm` : '—'}${fin(prob) ? ` (chance ${fmtNum(prob, 0)}%)` : ''}`
  return `chuva ${fin(prob) ? `${fmtNum(prob, 0)}%` : '—'}${fin(qpf) ? `, ${fmtNum(qpf)} mm` : ''}`
}

function windText(w: Record<string, unknown>): string | null {
  const wd = obj(w.wind)
  const s = speed(wd.speed)
  if (s == null) return null
  const dir = compassPoint(obj(wd.direction).degrees)
  const g = speed(wd.gust)
  return `vento ${fmtNum(s, 0)} km/h${dir ? ` de ${dir}` : ''}${g != null ? `, rajadas ${fmtNum(g, 0)} km/h` : ''}`
}

const storm = (w: Record<string, unknown>): string | null =>
  fin(w.thunderstormProbability) && w.thunderstormProbability >= 10
    ? `trovoada ${fmtNum(w.thunderstormProbability, 0)}%`
    : null

/** Instante UTC → "HH:MM" na hora local do lugar. */
function localClock(iso: unknown, tz: string): string | null {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  try {
    const p = zonedParts({ now: t, timeZone: tz })
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
  } catch {
    return null
  }
}

interface Ymd {
  y: number
  m: number
  d: number
}
const ymdText = (p: Ymd): string =>
  `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`

/** Data/hora civil + `hours` (calendário puro: o dia vira na meia-noite local). */
function addHours(p: Ymd, hour: number, hours: number): Ymd & { h: number } {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d, hour + hours))
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours() }
}

/** Do título da atribuição ("Weather for <lugar> - Google") → o lugar. */
export function attributionPlace(title: unknown): string | null {
  const m = typeof title === 'string' ? /^Weather for (.+?) - Google$/.exec(title.trim()) : null
  return m ? m[1] : null
}

// ---------------- provedor ----------------

export function googleWeatherProvider(key: string): WeatherProvider {
  return {
    id: 'google',
    label: 'Google',
    fit(a) {
      if (a.pastDays > 0) return { ok: false, reason: 'o Google não tem dias anteriores' }
      if (a.days > GOOGLE_WEATHER_LIMITS.daysMax)
        return {
          ok: false,
          reason: `o Google prevê até ${GOOGLE_WEATHER_LIMITS.daysMax} dias (pedidos: ${a.days})`
        }
      if (a.hours > GOOGLE_WEATHER_LIMITS.hoursMax)
        return {
          ok: true,
          args: { ...a, hours: GOOGLE_WEATHER_LIMITS.hoursMax },
          notes: [
            `com o Google, até ${GOOGLE_WEATHER_LIMITS.hoursMax} h por vez (cada hora é uma chamada): mostrei ${GOOGLE_WEATHER_LIMITS.hoursMax}.`
          ]
        }
      return { ok: true, args: a, notes: [] }
    },
    async forecast(where, a, d) {
      return googleForecast(key, where, a, d)
    }
  }
}

function locationOf(where: ProviderWhere): Record<string, unknown> {
  if (where.kind === 'point')
    return {
      latLng: {
        latitude: Math.round(where.lat * 1e5) / 1e5,
        longitude: Math.round(where.lon * 1e5) / 1e5
      }
    }
  return { address: where.country ? `${where.place}, ${where.country}` : where.place }
}

/** Corpo do lookupWeather (agora / um dia / uma hora local). */
export function lookupBody(
  where: ProviderWhere,
  at: { date?: Ymd; hour?: number } = {}
): Record<string, unknown> {
  return {
    location: locationOf(where),
    capabilities: ['WEATHER'],
    weatherOptions: { unitsSystem: 'METRIC' },
    languageCode: 'pt-BR',
    ...(at.date ? { date: { year: at.date.y, month: at.date.m, day: at.date.d } } : {}),
    ...(at.date && at.hour != null ? { hour: at.hour } : {})
  }
}

async function googleForecast(
  key: string,
  where: ProviderWhere,
  a: WeatherArgs,
  d: WeatherDeps
): Promise<string> {
  d.onOutput?.('Consultando a previsão no Google…')
  const now = await postJson(d, key, lookupBody(where))
  const tz = str(now.timeZone)
  const cur = obj(now.weather)
  if (!tz || !Object.keys(cur).length) throw new GoogleError('resposta sem o tempo atual')
  const t = Date.parse(String(cur.dateTime ?? ''))
  let local: ReturnType<typeof zonedParts>
  try {
    local = zonedParts({ now: Number.isFinite(t) ? t : Date.now(), timeZone: tz })
  } catch {
    throw new GoogleError(`fuso desconhecido: ${tz}`)
  }
  const today: Ymd = { y: local.year, m: local.month, d: local.day }
  const todayText = ymdText(today)

  const dayAt = (i: number): Ymd => addHours(today, 0, i * 24)
  const hourAt = (j: number): Ymd & { h: number } => addHours(today, local.hour, j)
  const tasks: (() => Promise<Record<string, unknown>>)[] = [
    ...Array.from(
      { length: a.days },
      (_, i) => () => postJson(d, key, lookupBody(where, { date: dayAt(i) }))
    ),
    ...Array.from({ length: a.hours }, (_, j) => () => {
      const x = hourAt(j)
      return postJson(d, key, lookupBody(where, { date: x, hour: x.h }))
    })
  ]
  if (tasks.length)
    d.onOutput?.(
      `Consultando ${tasks.length} ${tasks.length === 1 ? 'momento' : 'momentos'} no Google…`
    )
  const results = await pool(tasks, GOOGLE_WEATHER_LIMITS.concurrency)
  if (d.signal.aborted) throw abortError()
  const days = results.slice(0, a.days)
  const hours = results.slice(a.days)

  // ---- cabeçalho ----
  const attribution = obj(cur.attribution)
  const placeName = str(obj(now.returnedLocation).address) ?? attributionPlace(attribution.title)
  const head =
    where.kind === 'point'
      ? `${where.label}${placeName ? ` — ${placeName}` : ''} · ${coord(where.lat)}, ${coord(where.lon)}`
      : (placeName ?? where.place)
  const lines: string[] = [
    `Tempo em ${head} — horários locais de lá: ${tz} (UTC${formatOffset(local.offsetMinutes)})`
  ]

  // ---- agora ----
  const tc = deg(cur.temperature)
  if (tc != null) {
    const feels = deg(cur.feelsLikeTemperature)
    const parts = [
      `${fmtNum(tc)} °C${feels != null ? ` (sensação ${fmtNum(feels)} °C)` : ''}`,
      condText(cur),
      fin(cur.relativeHumidity) ? `umidade ${fmtNum(cur.relativeHumidity, 0)}%` : null,
      fin(cur.cloudCover) ? `nuvens ${fmtNum(cur.cloudCover, 0)}%` : null,
      windText(cur),
      rain(cur, false),
      storm(cur),
      fin(cur.uvIndex) && cur.uvIndex >= 1 ? `UV ${fmtNum(cur.uvIndex, 0)}` : null
    ].filter((x): x is string => !!x)
    const clock = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`
    lines.push(`Agora (${clock}${isNight(cur) ? ', noite' : ''}): ${parts.join(' · ')}`)
  }

  // ---- por dia ----
  const failed: string[] = []
  const dayRows: string[] = []
  days.forEach((r, i) => {
    const date = ymdText(dayAt(i))
    if (!r.ok) {
      if ((r.e as Error)?.name === 'AbortError') throw r.e
      failed.push(dayLabel(date, todayText))
      return
    }
    const w = obj(r.v.weather)
    const tmin = deg(w.minTemperature)
    const tmax = deg(w.maxTemperature)
    const sun = obj(w.sunEvents)
    const rise = localClock(sun.sunriseTime, tz)
    const set = localClock(sun.sunsetTime, tz)
    const parts = [
      tmin != null && tmax != null ? `${fmtNum(tmin)} a ${fmtNum(tmax)} °C` : null,
      condText(w),
      rain(w, true),
      storm(w),
      windText(w),
      fin(w.uvIndex) ? `UV ${fmtNum(w.uvIndex, 0)}` : null,
      rise && set ? `sol ${rise}–${set}` : null
    ].filter((x): x is string => !!x)
    dayRows.push(`- ${dayLabel(date, todayText)}: ${parts.join(' · ')}`)
  })
  if (dayRows.length) lines.push('Por dia:', ...dayRows)

  // ---- por hora ----
  const hourRows: string[] = []
  hours.forEach((r, j) => {
    const x = hourAt(j)
    const date = ymdText(x)
    const clock = `${String(x.h).padStart(2, '0')}:00`
    const prefix = date === todayText ? '' : `${dayLabel(date, todayText).split(', ')[0]} `
    if (!r.ok) {
      if ((r.e as Error)?.name === 'AbortError') throw r.e
      failed.push(`${prefix}${clock}`)
      return
    }
    const w = obj(r.v.weather)
    const th = deg(w.temperature)
    const ws = speed(obj(w.wind).speed)
    const parts = [
      th != null ? `${fmtNum(th)} °C` : null,
      condText(w),
      rain(w, false),
      storm(w),
      ws != null ? `vento ${fmtNum(ws, 0)} km/h` : null,
      fin(w.uvIndex) && w.uvIndex >= 1 ? `UV ${fmtNum(w.uvIndex, 0)}` : null
    ].filter((x): x is string => !!x)
    hourRows.push(`- ${prefix}${clock} · ${parts.join(' · ')}`)
  })
  if (hourRows.length) lines.push(`Por hora (próximas ${hourRows.length} h):`, ...hourRows)

  // ---- avisos e fonte ----
  if (failed.length) {
    const why = results.find((r) => !r.ok) as { ok: false; e: unknown } | undefined
    lines.push(
      `Obs.: o Google não respondeu para ${failed.join(', ')}${why ? ` (${(why.e as Error)?.message ?? String(why.e)})` : ''}.`
    )
  }
  for (const n of [...a.notes, ...(where.kind === 'point' ? (where.notes ?? []) : [])])
    lines.push(`Obs.: ${n}`)
  const title = str(attribution.title)
  const url = str(attribution.url)
  lines.push(
    title && url
      ? `Fonte: Google (Maps Experience agent tools) — ao usar estes dados, cite logo depois: [${title}](${url})`
      : 'Fonte: Google (Maps Experience agent tools).'
  )
  return lines.join('\n')
}

/** Teste da chave (Configurações): uma chamada de "agora" num ponto fixo. */
export async function testGoogleWeatherKey(
  key: string,
  d: Pick<WeatherDeps, 'fetch' | 'signal' | 'timeoutMs'>
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const r = await postJson(
      { ...d } as WeatherDeps,
      key,
      lookupBody({ kind: 'point', lat: -23.5505, lon: -46.6333, label: '' })
    )
    const w = obj(r.weather)
    const tc = deg(w.temperature)
    return {
      ok: true,
      text: `Chave ok — São Paulo agora: ${tc != null ? `${fmtNum(tc)} °C` : '?'}${condText(w) ? `, ${condText(w)}` : ''}.`
    }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}
