// Tool `weather` (protocolo 1.16.0, @shared/weather): argumentos, URLs do Open-Meteo, escolha do lugar,
// texto da saída e a execução com `fetch` FALSO (geocodificação → previsão; reserva do aparelho;
// posição do aparelho; erros HTTP, tempo esgotado e cancelamento). Sem rede, sem custo.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/weather.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compassPoint,
  dayLabel,
  fmtNum,
  forecastUrl,
  geocodingUrl,
  geoPlaceLabel,
  parseGeocoding,
  parseWeatherArgs,
  rankPlaces,
  runWeatherTool,
  weatherCodeText,
  weatherToolSummary,
  weatherUsesDevicePosition,
  WEATHER_LIMITS,
  type GeoPlace,
  type WeatherDeps,
  type WeatherFetch
} from '../src/shared/weather.ts'
import { TOOL_DEFINITIONS, TOOL_LABELS, TOOL_NAMES } from '../src/shared/tools.ts'
import { TOOL_SHORT_DESCRIPTIONS, wordCount } from '../src/shared/compactTools.ts'
import { toolDevice } from '../src/shared/deviceTools.ts'
import { TOOLS_NEWER_THAN_LEGACY_CHATS } from '../src/shared/chatInherit.ts'
import { toolPhraseCategory } from '../src/shared/voicePolicy.ts'
import { TOOL_ITEM } from '../src/shared/approvalPolicy.ts'

// ---------------- dados falsos (formato das respostas reais do Open-Meteo) ----------------

const GEO_CURITIBA = {
  results: [
    {
      name: 'Curitiba',
      latitude: -25.42778,
      longitude: -49.27306,
      country_code: 'BR',
      country: 'Brasil',
      admin1: 'Paraná',
      admin2: 'Curitiba',
      population: 1948626
    },
    {
      name: 'Curitiba',
      latitude: 19.10498,
      longitude: -98.28768,
      country_code: 'MX',
      country: 'México',
      admin1: 'Puebla',
      population: 75
    },
    { name: 'sem coordenadas' }
  ]
}

const FORECAST = {
  latitude: -25.413006,
  longitude: -49.241608,
  utc_offset_seconds: -10800,
  timezone: 'America/Sao_Paulo',
  elevation: 908,
  current: {
    time: '2026-11-16T22:45',
    temperature_2m: 18,
    apparent_temperature: 19.6,
    relative_humidity_2m: 96,
    weather_code: 3,
    cloud_cover: 92,
    precipitation: 0.4,
    wind_speed_10m: 7,
    wind_direction_10m: 235,
    wind_gusts_10m: 14.8,
    is_day: 0
  },
  hourly: {
    time: ['2026-11-16T22:00', '2026-11-16T23:00', '2026-11-17T00:00'],
    temperature_2m: [18, 17.6, 17.5],
    precipitation_probability: [2, 7, 10],
    precipitation: [0, 0.1, 0],
    weather_code: [3, 51, 61],
    wind_speed_10m: [6, 7.8, 5.8],
    uv_index: [0, 0, 1.4]
  },
  daily: {
    time: ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'],
    weather_code: [95, 53, 51, 95],
    temperature_2m_max: [27, 23.8, 26.1, 28.6],
    temperature_2m_min: [17.3, 17.4, 17.1, -0.4],
    precipitation_sum: [11.3, 2.9, 1.6, 11.2],
    precipitation_probability_max: [100, 76, 49, 71],
    wind_speed_10m_max: [11.6, 14.5, 14.6, 8.9],
    wind_gusts_10m_max: [32.8, 37.1, 39.6, 37.1],
    wind_direction_10m_dominant: [332, 104, 75, 23],
    uv_index_max: [8.15, 9.45, 9.5, 9.25],
    sunrise: ['2026-11-15T05:20', '2026-11-16T05:20', '2026-11-17T05:20', '2026-11-18T05:19'],
    sunset: ['2026-11-15T18:42', '2026-11-16T18:43', '2026-11-17T18:43', '2026-11-18T18:44']
  }
}

interface Call {
  url: string
  headers: Record<string, string>
}

/** fetch falso: responde pela URL (geocodificação / previsão); grava as chamadas. */
function fakeFetch(
  routes: {
    geo?: (url: string) => { status: number; body: string }
    forecast?: (url: string) => { status: number; body: string }
  },
  calls: Call[] = []
): WeatherFetch {
  return async (url, init) => {
    calls.push({ url, headers: init.headers })
    const r = url.startsWith('https://geocoding-api.open-meteo.com/')
      ? routes.geo?.(url)
      : url.startsWith('https://api.open-meteo.com/')
        ? routes.forecast?.(url)
        : undefined
    if (!r) throw new Error(`rota inesperada: ${url}`)
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body }
  }
}

const json = (v: unknown, status = 200): { status: number; body: string } => ({
  status,
  body: JSON.stringify(v)
})

const deps = (fetch: WeatherFetch, extra: Partial<WeatherDeps> = {}): WeatherDeps => ({
  fetch,
  signal: new AbortController().signal,
  ...extra
})

const params = (url: string): URLSearchParams => new URL(url).searchParams

// ---------------- argumentos ----------------

test('argumentos: padrões, números em texto, limites ajustados com aviso, erros', () => {
  const d = parseWeatherArgs({})
  assert.ok(d.ok)
  assert.deepEqual(d.value, {
    place: null,
    latitude: null,
    longitude: null,
    country: null,
    days: WEATHER_LIMITS.daysDefault,
    hours: 0,
    pastDays: 0,
    notes: []
  })
  const s = parseWeatherArgs({
    place: '  Vila   Madalena, São Paulo ',
    country: 'br',
    days: '5',
    hours: 12.4,
    past_days: 2
  })
  assert.ok(s.ok)
  assert.equal(s.value.place, 'Vila Madalena, São Paulo')
  assert.equal(s.value.country, 'BR')
  assert.equal(s.value.days, 5)
  assert.equal(s.value.hours, 12)
  assert.equal(s.value.pastDays, 2)
  const c = parseWeatherArgs({ days: 40, hours: 100, past_days: -3 })
  assert.ok(c.ok)
  assert.equal(c.value.days, 16)
  assert.equal(c.value.hours, 48)
  assert.equal(c.value.pastDays, 0)
  assert.equal(c.value.notes.length, 3)
  assert.match(c.value.notes[0], /"days" vai de 1 a 16: usei 16/)
  const ll = parseWeatherArgs({ latitude: '-25,43', longitude: -49.27 })
  assert.ok(ll.ok)
  assert.equal(ll.value.latitude, -25.43)
  for (const [bad, re] of [
    [{ latitude: 10 }, /juntas/],
    [{ latitude: 91, longitude: 0 }, /−90 a 90/],
    [{ latitude: 'x', longitude: 1 }, /juntas/],
    [{ place: 42 }, /texto/],
    [{ country: 'Brasil' }, /2 letras/],
    [{ days: 'muitos' }, /inteiro/]
  ] as const) {
    const r = parseWeatherArgs(bad as Record<string, unknown>)
    assert.ok(!r.ok, JSON.stringify(bad))
    assert.match(r.error, re)
  }
  assert.equal(weatherUsesDevicePosition({}), true)
  assert.equal(weatherUsesDevicePosition({ place: '  ' }), true)
  assert.equal(weatherUsesDevicePosition({ place: 'Curitiba' }), false)
  assert.equal(weatherUsesDevicePosition({ latitude: 1, longitude: 2 }), false)
})

// ---------------- URLs ----------------

test('URLs: geocodificação em pt (país opcional) e previsão com dias que cobrem as horas', () => {
  const g = params(geocodingUrl('São Paulo', 'BR'))
  assert.equal(g.get('name'), 'São Paulo')
  assert.equal(g.get('language'), 'pt')
  assert.equal(g.get('countryCode'), 'BR')
  assert.equal(g.get('count'), String(WEATHER_LIMITS.geocodeCount))
  assert.equal(params(geocodingUrl('x', null)).get('countryCode'), null)

  const f = params(
    forecastUrl({ lat: -25.427783, lon: -49.273061 }, { days: 1, hours: 0, pastDays: 0 })
  )
  assert.equal(f.get('latitude'), '-25.4278')
  assert.equal(f.get('timezone'), 'auto')
  assert.equal(f.get('forecast_days'), '1')
  assert.equal(f.get('hourly'), null)
  assert.equal(f.get('past_days'), null)
  assert.match(f.get('current') ?? '', /temperature_2m,.*weather_code/)
  assert.match(f.get('daily') ?? '', /precipitation_probability_max/)
  // 48 h com 1 dia: pede 3 dias para as linhas por hora não pararem no fim de hoje
  const h = params(forecastUrl({ lat: 0, lon: 0 }, { days: 1, hours: 48, pastDays: 3 }))
  assert.equal(h.get('forecast_days'), '3')
  assert.equal(h.get('forecast_hours'), '48')
  assert.equal(h.get('past_days'), '3')
  assert.match(h.get('hourly') ?? '', /precipitation_probability/)
})

// ---------------- lugar ----------------

const gp = (name: string, population: number | null, extra: Partial<GeoPlace> = {}): GeoPlace => ({
  name,
  lat: 0,
  lon: 0,
  admin1: null,
  admin2: null,
  country: null,
  countryCode: null,
  population,
  ...extra
})

test('lugar: ordem do geocodificador com nome exato; sem nenhum exato, o mais populoso', () => {
  const tokyo = [gp('Tóquio', 9_733_276), gp('Tokyo', null)]
  assert.equal(
    rankPlaces(tokyo, 'Tokyo')[0].name,
    'Tóquio',
    'casou nome em outra língua: ordem dele'
  )
  const rio = [gp('Riobamba', 264_048), gp('Rio Branco', 419_452), gp('Rio de Janeiro', 6_747_815)]
  const r = rankPlaces(rio, 'Rio')
  assert.deepEqual(
    r.map((p) => p.name),
    ['Rio de Janeiro', 'Riobamba', 'Rio Branco']
  )
  const sp = [gp('São Paulo', 12_400_232), gp('Sao Paulo', 3_198)]
  assert.equal(rankPlaces(sp, 'sao paulo, SP')[0].population, 12_400_232)
  assert.equal(rankPlaces([], 'x').length, 0)

  assert.equal(
    geoPlaceLabel(gp('Curitiba', 1, { admin1: 'Paraná', country: 'Brasil' })),
    'Curitiba (Paraná, Brasil)'
  )
  assert.equal(
    geoPlaceLabel(gp('Rio de Janeiro', 1, { admin1: 'Rio de Janeiro', country: 'Brasil' })),
    'Rio de Janeiro (Brasil)'
  )
  assert.equal(geoPlaceLabel(gp('Tóquio', 1, { admin1: 'Tóquio' })), 'Tóquio')
  const parsed = parseGeocoding(GEO_CURITIBA)
  assert.equal(parsed.length, 2, 'resultado sem coordenadas sai')
  assert.equal(parsed[0].countryCode, 'BR')
  assert.deepEqual(parseGeocoding({}), [])
})

// ---------------- texto ----------------

test('texto: códigos WMO, rosa dos ventos, números pt-BR e dias relativos ao lugar', () => {
  assert.equal(weatherCodeText(0), 'céu limpo')
  assert.equal(weatherCodeText(95), 'trovoada')
  assert.equal(weatherCodeText(42), 'código 42')
  assert.equal(weatherCodeText(null), null)
  assert.equal(compassPoint(0), 'N')
  assert.equal(compassPoint(235), 'SO')
  assert.equal(compassPoint(90), 'L')
  assert.equal(compassPoint(359), 'N')
  assert.equal(compassPoint(-90), 'O')
  assert.equal(fmtNum(19.64), '19,6')
  assert.equal(fmtNum(18), '18')
  assert.equal(fmtNum(-0.04), '0')
  assert.equal(fmtNum(14.8, 0), '15')
  assert.equal(dayLabel('2026-11-16', '2026-11-16'), 'hoje, seg 16/11')
  assert.equal(dayLabel('2026-11-17', '2026-11-16'), 'amanhã, ter 17/11')
  assert.equal(dayLabel('2026-11-15', '2026-11-16'), 'ontem, dom 15/11')
  assert.equal(dayLabel('2026-11-18', '2026-11-16'), 'qua 18/11')
  assert.equal(dayLabel('2026-11-18', null), 'qua 18/11')
})

// ---------------- execução ----------------

test('lugar pelo nome: geocodifica, consulta a previsão e monta a saída completa', async () => {
  const calls: Call[] = []
  const out: string[] = []
  const r = await runWeatherTool(
    { place: 'Curitiba', days: 2, hours: 3, past_days: 1 },
    deps(fakeFetch({ geo: () => json(GEO_CURITIBA), forecast: () => json(FORECAST) }, calls), {
      onOutput: (t) => out.push(t),
      userAgent: 'ClearChat-teste'
    })
  )
  assert.equal(r.status, 'ok', r.content)
  assert.equal(calls.length, 2)
  assert.equal(params(calls[1].url).get('latitude'), '-25.4278')
  assert.equal(calls[0].headers['User-Agent'], 'ClearChat-teste')
  assert.deepEqual(out, ['Procurando “Curitiba”…', 'Consultando a previsão…'])
  const lines = r.content.split('\n')
  assert.equal(
    lines[0],
    'Tempo em Curitiba (Paraná, Brasil) · -25.4278, -49.2731 · 908 m — horários locais de lá: America/Sao_Paulo (UTC-03:00)'
  )
  assert.equal(
    lines[1],
    'Agora (22:45, noite): 18 °C (sensação 19,6 °C) · nublado · umidade 96% · nuvens 92% · vento 7 km/h de SO, rajadas 15 km/h · precipitação recente 0,4 mm'
  )
  assert.equal(lines[2], 'Por dia:')
  // 1 dia antes + 2 dias (o 4º dia da resposta não entra)
  assert.match(
    lines[3],
    /^- ontem, dom 15\/11: 17,3 a 27 °C · trovoada · chuva 11,3 mm \(chance 100%\)/
  )
  assert.equal(
    lines[4],
    '- hoje, seg 16/11: 17,4 a 23,8 °C · garoa moderada · chuva 2,9 mm (chance 76%) · vento até 15 km/h de L, rajadas 37 km/h · UV 9 · sol 05:20–18:43'
  )
  assert.match(lines[5], /^- amanhã, ter 17\/11: /)
  assert.ok(!r.content.includes('qua 18/11'))
  assert.equal(lines[6], 'Por hora (próximas 3 h):')
  assert.equal(lines[7], '- 22:00 · 18 °C · nublado · chuva 2%, 0 mm · vento 6 km/h')
  assert.equal(
    lines[9],
    '- amanhã 00:00 · 17,5 °C · chuva fraca · chuva 10%, 0 mm · vento 6 km/h · UV 1'
  )
  assert.match(
    r.content,
    /Outros lugares com esse nome: Curitiba \(Puebla, México\) 19\.105, -98\.2877 — se era outro, chame de novo com latitude e longitude/
  )
  assert.equal(
    lines.at(-1),
    'Fonte: Open-Meteo.com (CC BY 4.0); lugar: GeoNames via Open-Meteo — previsão de modelos meteorológicos (não é medição de estação).'
  )
})

test('coordenadas: sem geocodificar; avisos dos limites na saída; temperatura negativa', async () => {
  const calls: Call[] = []
  const r = await runWeatherTool(
    { latitude: -25.4, longitude: -49.2, place: 'casa da vó', days: 99 },
    deps(fakeFetch({ forecast: () => json(FORECAST) }, calls))
  )
  assert.equal(r.status, 'ok', r.content)
  assert.equal(calls.length, 1)
  assert.match(r.content, /^Tempo em casa da vó \(coordenadas informadas\) · -25\.4, -49\.2 /)
  assert.match(r.content, /qua 18\/11: -0,4 a 28,6 °C/)
  assert.match(r.content, /Obs\.: "days" vai de 1 a 16: usei 16\./)
  assert.ok(!r.content.includes('lugar: GeoNames'))
})

test('não achou no Open-Meteo: reserva do aparelho (celular); sem reserva, erro com dicas', async () => {
  const empty = fakeFetch({ geo: () => json({}), forecast: () => json(FORECAST) })
  const seen: string[] = []
  const r = await runWeatherTool(
    { place: 'Rua Augusta, 500' },
    deps(empty, {
      fallbackGeocoder: async (q) => {
        seen.push(q)
        return { lat: -23.55, lon: -46.65, label: 'Rua Augusta, São Paulo', source: 'Photon' }
      }
    })
  )
  assert.equal(r.status, 'ok', r.content)
  assert.deepEqual(seen, ['Rua Augusta, 500'])
  assert.match(r.content, /^Tempo em Rua Augusta, São Paulo · -23\.55, -46\.65/)
  assert.match(r.content, /lugar: Photon/)
  const miss = await runWeatherTool({ place: 'xyzzy', country: 'pt' }, deps(empty))
  assert.equal(miss.status, 'error')
  assert.match(miss.content, /^Erro: não encontrei “xyzzy” \(país PT\)\. Use o nome da cidade/)
  // reserva que falha não derruba: vira "não encontrei"
  const bad = await runWeatherTool(
    { place: 'xyzzy' },
    deps(empty, { fallbackGeocoder: async () => Promise.reject(new Error('rede')) })
  )
  assert.match(bad.content, /não encontrei/)
})

test('sem lugar: posição do aparelho (celular) ou erro no computador; erro da posição propaga', async () => {
  const fc = fakeFetch({ forecast: () => json(FORECAST) })
  const pc = await runWeatherTool({}, deps(fc))
  assert.equal(pc.status, 'error')
  assert.match(pc.content, /computador\) não fornece a localização atual/)
  const phone = await runWeatherTool(
    { days: 1 },
    deps(fc, {
      devicePosition: async () => ({
        lat: -25.43,
        lon: -49.27,
        label: 'sua localização atual, aproximada (~1 km)',
        notes: ['o sistema só libera a aproximada']
      })
    })
  )
  assert.equal(phone.status, 'ok', phone.content)
  assert.match(
    phone.content,
    /^Tempo em sua localização atual, aproximada \(~1 km\) · -25\.43, -49\.27/
  )
  assert.match(phone.content, /Obs\.: o sistema só libera a aproximada/)
  await assert.rejects(
    runWeatherTool(
      {},
      deps(fc, {
        devicePosition: async () => {
          throw new Error('Erro: a permissão de localização está negada')
        }
      })
    ),
    /permissão de localização/
  )
})

test('erros do Open-Meteo: HTTP com motivo, 429, resposta ilegível, sem previsão, rede', async () => {
  const run = (forecast: () => { status: number; body: string }): Promise<{ content: string }> =>
    runWeatherTool({ latitude: 1, longitude: 2 }, deps(fakeFetch({ forecast })))
  assert.equal(
    (await run(() => json({ error: true, reason: 'Parameter x is invalid' }, 400))).content,
    'Erro: o Open-Meteo respondeu HTTP 400: Parameter x is invalid.'
  )
  assert.match((await run(() => json({}, 429))).content, /excesso de pedidos/)
  assert.match((await run(() => ({ status: 200, body: '<html>' }))).content, /ilegível/)
  assert.match((await run(() => json({ hello: 1 }))).content, /sem a previsão/)
  const down = await runWeatherTool(
    { latitude: 1, longitude: 2 },
    deps(async () => {
      throw new TypeError('fetch failed')
    })
  )
  assert.equal(down.content, 'Erro: o Open-Meteo não respondeu (fetch failed).')
})

test('tempo esgotado vira erro; cancelamento do usuário lança AbortError', async () => {
  const hang: WeatherFetch = (_url, init) =>
    new Promise((_res, rej) =>
      init.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })
    )
  const t = await runWeatherTool({ latitude: 1, longitude: 2 }, deps(hang, { timeoutMs: 30 }))
  assert.equal(t.status, 'error')
  assert.match(t.content, /demorou demais/)
  const ac = new AbortController()
  const p = runWeatherTool({ latitude: 1, longitude: 2 }, { fetch: hang, signal: ac.signal })
  setTimeout(() => ac.abort(), 10)
  await assert.rejects(p, (e: Error) => e.name === 'AbortError')
  const pre = new AbortController()
  pre.abort()
  await assert.rejects(
    runWeatherTool({ place: 'x' }, { fetch: hang, signal: pre.signal }),
    (e: Error) => e.name === 'AbortError'
  )
})

test('resumo do card e argumentos inválidos sem chamar a rede', async () => {
  assert.equal(weatherToolSummary({ place: 'Curitiba' }), 'Curitiba · 3 dias')
  assert.equal(
    weatherToolSummary({
      latitude: -25.4278333,
      longitude: -49.27,
      days: 1,
      hours: 12,
      past_days: 1
    }),
    '-25.4278, -49.27 · 1 dia · 12 h · 1 dia antes'
  )
  assert.equal(weatherToolSummary({}), 'aqui · 3 dias')
  assert.equal(weatherToolSummary({ latitude: 1 }), '')
  const r = await runWeatherTool({ latitude: 1 }, deps(fakeFetch({})))
  assert.equal(r.status, 'error')
  assert.match(r.content, /^Erro: informe "latitude" e "longitude" juntas/)
})

test('contrato: na lista do app, roda em qualquer aparelho, sem aprovação, compacta e migração', () => {
  assert.ok(TOOL_NAMES.includes('weather'))
  assert.equal(TOOL_NAMES.indexOf('weather'), TOOL_NAMES.indexOf('datetime') + 1)
  assert.equal(TOOL_LABELS.weather, 'Previsão do tempo')
  const def = TOOL_DEFINITIONS.weather.function
  assert.equal(def.name, 'weather')
  assert.deepEqual(Object.keys(def.parameters.properties ?? {}), [
    'place',
    'country',
    'latitude',
    'longitude',
    'days',
    'hours',
    'past_days'
  ])
  assert.deepEqual(def.parameters.required, [])
  assert.match(def.description, /Open-Meteo/)
  assert.match(def.description, /no computador, informe o lugar/)
  const short = TOOL_SHORT_DESCRIPTIONS.weather
  assert.ok(short && wordCount(short) >= 1 && wordCount(short) <= 20, short)
  assert.equal(toolDevice('weather'), null)
  assert.equal(TOOL_ITEM.weather, undefined)
  assert.ok(TOOLS_NEWER_THAN_LEGACY_CHATS.includes('weather'))
  assert.equal(toolPhraseCategory('weather'), 'web')
})
