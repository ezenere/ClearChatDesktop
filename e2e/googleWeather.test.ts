// Provedor Google da tool `weather` e "Tempo e mapas" (protocolo 1.16.0 — @shared/googleWeather,
// @shared/mapsSettings): pedidos por momento (agora → dias e horas em paralelo, na hora local do
// lugar, virando a meia-noite), texto da saída com a atribuição, endereço direto ao Google, o que vai
// ao Open-Meteo (dias anteriores, > 10 dias, falha do Google — com o motivo), teto de horas, erros do
// Google legíveis, falha parcial, cancelamento, teste da chave e os settings. Sem rede: fetch falso
// com respostas no formato real do lookupWeather.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/googleWeather.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWeatherTool, type WeatherDeps, type WeatherFetch } from '../src/shared/weather.ts'
import {
  attributionPlace,
  GOOGLE_WEATHER_URL,
  googleErrorText,
  googleWeatherProvider,
  lookupBody,
  testGoogleWeatherKey
} from '../src/shared/googleWeather.ts'
import {
  checkMapsKey,
  mapsSettingsState,
  MAPS_PROTECTED_SETTINGS,
  normalizeWeatherProvider
} from '../src/shared/mapsSettings.ts'

const KEY = 'AIzaFAKE-chave-de-teste'
const TZ = 'America/Sao_Paulo'
const ATTR = {
  title: 'Weather for São Francisco, Curitiba - PR, Brasil - Google',
  url: 'https://www.google.com/search?q=Weather+for+Curitiba'
}

type Body = {
  location: { latLng?: { latitude: number; longitude: number }; address?: string }
  date?: { year: number; month: number; day: number }
  hour?: number
  languageCode?: string
  weatherOptions?: unknown
  capabilities?: string[]
}

function current(dateTime: string, b: Body): Record<string, unknown> {
  return {
    // como a API real: endereço pedido → endereço resolvido; ponto → o ponto
    returnedLocation: b.location.address
      ? { address: `${b.location.address} - SP, Brasil` }
      : { latLng: { latitude: -25.4278, longitude: -49.2731 } },
    weather: {
      temperature: { degrees: 16.2, unit: 'CELSIUS' },
      feelsLikeTemperature: { degrees: 16.2, unit: 'CELSIUS' },
      weatherCondition: {
        iconBaseUri: 'https://maps.gstatic.com/weather/v1/mostly_cloudy_night',
        description: { text: 'Predominantemente nublado', languageCode: 'pt-BR' }
      },
      precipitation: { probability: { percent: 12, type: 'RAIN' }, qpf: { quantity: 0.08 } },
      wind: { direction: { degrees: 191 }, speed: { value: 3 }, gust: { value: 6 } },
      relativeHumidity: 96,
      uvIndex: 0,
      thunderstormProbability: 2,
      cloudCover: 83,
      attribution: ATTR,
      dateTime
    },
    timeZone: TZ
  }
}

function daily(b: Body): Record<string, unknown> {
  const d = b.date!
  const day = d.day
  return {
    weather: {
      maxTemperature: { degrees: 25 + (day % 10) / 10 },
      minTemperature: { degrees: 17.4 },
      sunEvents: {
        sunriseTime: `${d.year}-${String(d.month).padStart(2, '0')}-${String(day).padStart(2, '0')}T08:20:18.5Z`,
        sunsetTime: `${d.year}-${String(d.month).padStart(2, '0')}-${String(day).padStart(2, '0')}T21:44:04.7Z`
      },
      weatherCondition: { description: { text: 'Nublado' } },
      precipitation: { probability: { percent: 15 }, qpf: { quantity: 0.04 } },
      wind: { direction: { degrees: 48 }, speed: { value: 11 }, gust: { value: 26 } },
      uvIndex: 7,
      thunderstormProbability: 30,
      attribution: ATTR,
      date: d
    },
    timeZone: TZ
  }
}

function hourly(b: Body): Record<string, unknown> {
  return {
    weather: {
      temperature: { degrees: 19 + b.hour! / 10 },
      weatherCondition: { description: { text: 'Chuva fraca' } },
      precipitation: { probability: { percent: 35 }, qpf: { quantity: 0.4 } },
      wind: { speed: { value: 2 } },
      uvIndex: b.hour === 12 ? 9.4 : 0,
      thunderstormProbability: 0,
      attribution: ATTR
    },
    timeZone: TZ
  }
}

interface Call {
  url: string
  body: Body | null
  key: string | undefined
}

/** fetch falso: Google pelo corpo (agora/dia/hora), Open-Meteo mínimo; grava as chamadas. */
function fake(
  o: {
    nowUtc?: string
    googleFail?: (b: Body) => { status: number; body: unknown } | null
  } = {},
  calls: Call[] = []
): WeatherFetch {
  return async (url, init) => {
    const body = init.body ? (JSON.parse(init.body) as Body) : null
    calls.push({ url, body, key: init.headers['X-Goog-Api-Key'] })
    const reply = (status: number, v: unknown): ReturnType<WeatherFetch> =>
      Promise.resolve({ ok: status < 300, status, text: async () => JSON.stringify(v) })
    if (url === GOOGLE_WEATHER_URL) {
      const f = o.googleFail?.(body!)
      if (f) return reply(f.status, f.body)
      if (!body!.date) return reply(200, current(o.nowUtc ?? '2026-11-16T06:13:51.947Z', body!))
      return reply(200, body!.hour != null ? hourly(body!) : daily(body!))
    }
    if (url.startsWith('https://geocoding-api.open-meteo.com/'))
      return reply(200, {
        results: [{ name: 'Curitiba', latitude: -25.43, longitude: -49.27, country: 'Brasil' }]
      })
    if (url.startsWith('https://api.open-meteo.com/'))
      return reply(200, {
        latitude: -25.43,
        longitude: -49.27,
        timezone: TZ,
        utc_offset_seconds: -10800,
        current: { time: '2026-11-16T03:15', temperature_2m: 18, weather_code: 3, is_day: 0 },
        daily: {
          time: ['2026-11-15', '2026-11-16'],
          temperature_2m_min: [17, 17],
          temperature_2m_max: [27, 24]
        }
      })
    throw new Error(`rota inesperada: ${url}`)
  }
}

const deps = (fetch: WeatherFetch, extra: Partial<WeatherDeps> = {}): WeatherDeps => ({
  fetch,
  signal: new AbortController().signal,
  provider: googleWeatherProvider(KEY),
  ...extra
})

const google = (calls: Call[]): Call[] => calls.filter((c) => c.url === GOOGLE_WEATHER_URL)

test('corpo do lookupWeather: ponto, endereço (com país), dia e hora; pt-BR métrico', () => {
  assert.deepEqual(lookupBody({ kind: 'point', lat: -25.427783, lon: -49.273061, label: '' }), {
    location: { latLng: { latitude: -25.42778, longitude: -49.27306 } },
    capabilities: ['WEATHER'],
    weatherOptions: { unitsSystem: 'METRIC' },
    languageCode: 'pt-BR'
  })
  const b = lookupBody(
    { kind: 'place', place: 'Vila Madalena, São Paulo', country: 'BR' },
    { date: { y: 2026, m: 11, d: 17 }, hour: 0 }
  )
  assert.deepEqual(b.location, { address: 'Vila Madalena, São Paulo, BR' })
  assert.deepEqual(b.date, { year: 2026, month: 11, day: 17 })
  assert.equal(b.hour, 0)
  assert.equal(attributionPlace(ATTR.title), 'São Francisco, Curitiba - PR, Brasil')
  assert.equal(attributionPlace('outra coisa'), null)
})

test('coordenadas: agora → dias e horas na hora LOCAL do lugar; saída completa com a fonte', async () => {
  const calls: Call[] = []
  const out: string[] = []
  const r = await runWeatherTool(
    { latitude: -25.4278, longitude: -49.2731, days: 2, hours: 3 },
    deps(fake({}, calls), { onOutput: (t) => out.push(t) })
  )
  assert.equal(r.status, 'ok', r.content)
  const g = google(calls)
  assert.equal(g.length, 1 + 2 + 3, 'agora + 2 dias + 3 horas')
  assert.ok(g.every((c) => c.key === KEY))
  assert.equal(g[0].body!.date, undefined, 'o 1º é o agora')
  // 06:13 UTC = 03:13 em São Paulo: dias 16 e 17; horas 3, 4 e 5 do dia 16
  assert.deepEqual(
    g.slice(1, 3).map((c) => c.body!.date!.day),
    [16, 17]
  )
  assert.deepEqual(
    g.slice(3).map((c) => [c.body!.date!.day, c.body!.hour]),
    [
      [16, 3],
      [16, 4],
      [16, 5]
    ]
  )
  assert.equal(calls.length, g.length, 'nada no Open-Meteo')
  assert.deepEqual(out, ['Consultando a previsão no Google…', 'Consultando 5 momentos no Google…'])
  const lines = r.content.split('\n')
  assert.equal(
    lines[0],
    'Tempo em coordenadas informadas — São Francisco, Curitiba - PR, Brasil · -25.4278, -49.2731 — horários locais de lá: America/Sao_Paulo (UTC-03:00)'
  )
  assert.equal(
    lines[1],
    'Agora (03:13, noite): 16,2 °C (sensação 16,2 °C) · Predominantemente nublado · umidade 96% · nuvens 83% · vento 3 km/h de S, rajadas 6 km/h · chuva 12%, 0,1 mm'
  )
  assert.equal(lines[2], 'Por dia:')
  assert.equal(
    lines[3],
    '- hoje, seg 16/11: 17,4 a 25,6 °C · Nublado · chuva 0 mm (chance 15%) · trovoada 30% · vento 11 km/h de NE, rajadas 26 km/h · UV 7 · sol 05:20–18:44'
  )
  assert.match(lines[4], /^- amanhã, ter 17\/11: 17,4 a 25,7 °C/)
  assert.equal(lines[5], 'Por hora (próximas 3 h):')
  assert.equal(lines[6], '- 03:00 · 19,3 °C · Chuva fraca · chuva 35%, 0,4 mm · vento 2 km/h')
  assert.equal(
    lines.at(-1),
    `Fonte: Google (Maps Experience agent tools) — ao usar estes dados, cite logo depois: [${ATTR.title}](${ATTR.url})`
  )
})

test('horas que viram a meia-noite local; UV ≥ 1 aparece; endereço vai direto ao Google', async () => {
  const calls: Call[] = []
  // 02:30 UTC do dia 17 = 23:30 do dia 16 em São Paulo
  const r = await runWeatherTool(
    { place: 'Vila Madalena, São Paulo', days: 1, hours: 2 },
    deps(fake({ nowUtc: '2026-11-17T02:30:00Z' }, calls))
  )
  assert.equal(r.status, 'ok', r.content)
  const g = google(calls)
  assert.deepEqual(g[0].body!.location, { address: 'Vila Madalena, São Paulo' })
  assert.ok(!calls.some((c) => c.url.includes('open-meteo')), 'sem geocodificar no Open-Meteo')
  assert.deepEqual(
    g.slice(2).map((c) => [c.body!.date!.day, c.body!.hour]),
    [
      [16, 23],
      [17, 0]
    ]
  )
  assert.match(r.content, /^Tempo em Vila Madalena, São Paulo - SP, Brasil — horários locais/)
  assert.match(r.content, /\n- 23:00 · 21,3 °C/)
  assert.match(r.content, /\n- amanhã 00:00 · 19 °C/)
})

test('o que o Google não cobre vai ao Open-Meteo (com o motivo); mais de 24 h vira 24 com aviso', async () => {
  const past: Call[] = []
  const a = await runWeatherTool({ place: 'Curitiba', past_days: 1, days: 1 }, deps(fake({}, past)))
  assert.equal(a.status, 'ok', a.content)
  assert.equal(google(past).length, 0)
  assert.match(
    a.content,
    /Obs\.: o Google não tem dias anteriores — usei o Open-Meteo nesta chamada\./
  )
  assert.match(a.content, /Fonte: Open-Meteo\.com/)
  const far = await runWeatherTool({ place: 'Curitiba', days: 14 }, deps(fake()))
  assert.match(far.content, /o Google prevê até 10 dias \(pedidos: 14\) — usei o Open-Meteo/)
  const many: Call[] = []
  const h = await runWeatherTool(
    { latitude: 1, longitude: 2, days: 1, hours: 40 },
    deps(fake({}, many))
  )
  assert.equal(google(many).length, 1 + 1 + 24)
  assert.match(h.content, /Por hora \(próximas 24 h\):/)
  assert.match(
    h.content,
    /Obs\.: com o Google, até 24 h por vez \(cada hora é uma chamada\): mostrei 24\./
  )
})

test('falha do Google no "agora" → Open-Meteo com o motivo legível (chave, API desligada, cota)', async () => {
  const cases: [unknown, number, RegExp][] = [
    [
      {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ reason: 'API_KEY_INVALID' }]
        }
      },
      400,
      /o Google falhou \(a chave do Google Maps é inválida \(Configurações → Tempo e mapas\)\) — usei o Open-Meteo\./
    ],
    [
      {
        error: {
          code: 403,
          message: 'Maps Experience agent tools has not been used',
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'SERVICE_DISABLED' }]
        }
      },
      403,
      /mapstools\.googleapis\.com/
    ],
    [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429, /cota do Google esgotada/]
  ]
  for (const [body, status, re] of cases) {
    const r = await runWeatherTool(
      { latitude: -25.43, longitude: -49.27, days: 1 },
      deps(fake({ googleFail: (b) => (!b.date ? { status, body } : null) }))
    )
    assert.equal(r.status, 'ok', r.content)
    assert.match(r.content, re)
    assert.match(r.content, /Fonte: Open-Meteo\.com/)
  }
  assert.equal(googleErrorText(500, null), 'HTTP 500')
})

test('falha parcial (um dia/hora): o resto sai e a saída diz o que faltou', async () => {
  const r = await runWeatherTool(
    { latitude: 1, longitude: 2, days: 2, hours: 1 },
    deps(
      fake({
        googleFail: (b) =>
          b.date?.day === 17 && b.hour == null
            ? { status: 400, body: { error: { message: 'timeframe unsupported' } } }
            : null
      })
    )
  )
  assert.equal(r.status, 'ok', r.content)
  assert.match(r.content, /- hoje, seg 16\/11:/)
  assert.ok(!r.content.includes('- amanhã, ter 17/11:'))
  assert.match(
    r.content,
    /Obs\.: o Google não respondeu para amanhã, ter 17\/11 \(HTTP 400: timeframe unsupported\)\./
  )
  assert.match(r.content, /Fonte: Google/)
})

test('posição do aparelho vai ao Google como ponto (rótulo e avisos dela); cancelamento lança', async () => {
  const calls: Call[] = []
  const r = await runWeatherTool(
    { days: 1 },
    deps(fake({}, calls), {
      devicePosition: async () => ({
        lat: -25.43,
        lon: -49.27,
        label: 'sua localização atual, aproximada (~1 km)',
        notes: ['o sistema só libera a aproximada']
      })
    })
  )
  assert.deepEqual(google(calls)[0].body!.location, {
    latLng: { latitude: -25.43, longitude: -49.27 }
  })
  assert.match(r.content, /^Tempo em sua localização atual, aproximada \(~1 km\) — São Francisco/)
  assert.match(r.content, /Obs\.: o sistema só libera a aproximada/)

  const ac = new AbortController()
  const hang: WeatherFetch = (_u, init) =>
    new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('x'))))
  const p = runWeatherTool({ latitude: 1, longitude: 2 }, { ...deps(hang), signal: ac.signal })
  setTimeout(() => ac.abort(), 10)
  await assert.rejects(p, (e: Error) => e.name === 'AbortError')
})

test('teste da chave (uma chamada) e os settings de Tempo e mapas', async () => {
  const calls: Call[] = []
  const ok = await testGoogleWeatherKey(KEY, {
    fetch: fake({}, calls),
    signal: new AbortController().signal
  })
  assert.deepEqual(ok, {
    ok: true,
    text: 'Chave ok — São Paulo agora: 16,2 °C, Predominantemente nublado.'
  })
  assert.equal(calls.length, 1)
  const bad = await testGoogleWeatherKey(KEY, {
    fetch: fake({
      googleFail: () => ({
        status: 400,
        body: { error: { details: [{ reason: 'API_KEY_INVALID' }] } }
      })
    }),
    signal: new AbortController().signal
  })
  assert.deepEqual(bad, {
    ok: false,
    error: 'a chave do Google Maps é inválida (Configurações → Tempo e mapas)'
  })

  assert.equal(normalizeWeatherProvider('google', true), 'google')
  assert.equal(normalizeWeatherProvider('google', false), 'open-meteo', 'sem chave volta ao padrão')
  assert.equal(normalizeWeatherProvider('xyz', true), 'open-meteo')
  assert.deepEqual(mapsSettingsState('google', '  AIzaSyABCDEFGHIJKLMNOP1234  '), {
    weatherProvider: 'google',
    google: {
      hasKey: true,
      keyMask: mapsSettingsState(null, 'AIzaSyABCDEFGHIJKLMNOP1234').google.keyMask
    }
  })
  const mask = mapsSettingsState(null, 'AIzaSyABCDEFGHIJKLMNOP1234').google.keyMask!
  assert.ok(!mask.includes('ABCDEFGH'), mask)
  assert.deepEqual(mapsSettingsState(undefined, ''), {
    weatherProvider: 'open-meteo',
    google: { hasKey: false, keyMask: null }
  })
  assert.deepEqual(checkMapsKey('  k  '), { ok: true, key: 'k' })
  assert.deepEqual(checkMapsKey(''), { ok: true, key: null })
  assert.equal(checkMapsKey('a b').ok, false)
  assert.deepEqual(MAPS_PROTECTED_SETTINGS, ['googleMapsApiKey'])
})
