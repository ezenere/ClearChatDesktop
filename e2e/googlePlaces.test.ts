// Lugares pelo Google (protocolo 1.17.0 — @shared/googlePlaces, @shared/googleMapsTools e o setting
// `placesProvider` de @shared/mapsSettings): texto da busca (com/sem centro), corpo do searchText (viés
// circular, pageSize), leitura da resposta no formato real (resumo com citações + lugares com links e
// atribuição), distâncias, saída com o pedido de citar o link do Maps, erros do Google legíveis e os
// settings. Sem rede: fetch falso.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/googlePlaces.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  distanceM,
  fmtMeters,
  formatGooglePlaces,
  GOOGLE_PLACES_LIMITS,
  parseGooglePlaces,
  placeNameOf,
  placesQueryText,
  placesSearchBody,
  searchGooglePlaces,
  type GooglePlacesQuery
} from '../src/shared/googlePlaces.ts'
import { MAPS_TOOLS_BASE, type MapsToolsFetch } from '../src/shared/googleMapsTools.ts'
import {
  mapsSettingsState,
  normalizePlacesProvider,
  PLACES_PROVIDER_META
} from '../src/shared/mapsSettings.ts'
import { PHONE_TOOL_HELP, PHONE_TOOL_SHORT } from '../src/shared/deviceTools.ts'
import { wordCount } from '../src/shared/compactTools.ts'

const CENTER = { lat: -23.5536, lon: -46.6912 }

const place = (id: string, name: string, lat: number, lon: number): Record<string, unknown> => ({
  place: `places/${id}`,
  id,
  location: { latitude: lat, longitude: lon },
  googleMapsLinks: {
    placeUrl: `https://www.google.com/maps/place//data=${id}`,
    directionsUrl: `https://www.google.com/maps/dir//data=${id}`,
    reviewsUrl: `https://www.google.com/maps/place//reviews=${id}`
  },
  attribution: {
    title: `${name} - Google Maps`,
    url: `https://www.google.com/maps/place//data=${id}`
  }
})

// formato real do searchText (resumo pt-BR com nota ★, nº de avaliações e citações [i])
const RESPONSE = {
  summary:
    '**Carlos Pizza** [0] (4.6★ (2335)) é uma pizzaria com massas de fermentação natural.\n\n**Vesu Pizzaria** [1] (5.0★ (134)) oferece um ambiente casual.',
  places: [
    place('A1', 'Carlos Pizza', -23.5539197, -46.6891858),
    place('B2', 'Vesu Pizzaria', -23.5497015, -46.6916419)
  ],
  contentToken: 'tok'
}

const q = (o: Partial<GooglePlacesQuery> = {}): GooglePlacesQuery => ({
  what: 'pizzaria',
  center: CENTER,
  radiusM: 1500,
  limit: 5,
  ...o
})

test('texto e corpo do searchText: viés circular com centro; "perto de" sem centro; pageSize 1–10', () => {
  assert.equal(placesQueryText(q({ cuisine: 'napolitana' })), 'pizzaria napolitana')
  assert.equal(placesQueryText(q({ near: 'ignorado com centro' })), 'pizzaria')
  assert.equal(
    placesQueryText(q({ center: null, near: 'Avenida Paulista, São Paulo' })),
    'pizzaria perto de Avenida Paulista, São Paulo'
  )
  assert.deepEqual(placesSearchBody(q()), {
    textQuery: 'pizzaria',
    languageCode: 'pt-BR',
    pageSize: 5,
    locationBias: {
      circle: { center: { latitude: -23.5536, longitude: -46.6912 }, radiusMeters: 1500 }
    }
  })
  const far = placesSearchBody(q({ center: null, near: 'Centro', limit: 40 }))
  assert.equal(far.pageSize, GOOGLE_PLACES_LIMITS.maxLimit)
  assert.equal(far.locationBias, undefined)
  assert.equal(placesSearchBody(q({ limit: 0 })).pageSize, 1)
})

test('leitura da resposta: nomes pela atribuição, links, distâncias do centro', () => {
  const r = parseGooglePlaces(RESPONSE, CENTER)
  assert.equal(r.places.length, 2)
  assert.equal(r.places[0].name, 'Carlos Pizza')
  assert.equal(r.places[0].placeUrl, 'https://www.google.com/maps/place//data=A1')
  assert.equal(r.places[0].directionsUrl, 'https://www.google.com/maps/dir//data=A1')
  assert.ok(Math.abs(r.places[0].distanceM! - 210) < 15, String(r.places[0].distanceM))
  assert.equal(parseGooglePlaces(RESPONSE, null).places[0].distanceM, null)
  assert.deepEqual(parseGooglePlaces({}, CENTER), { summary: '', places: [] })
  assert.equal(
    placeNameOf('Al Capizza 24h - Pinheiros/SP - Google Maps'),
    'Al Capizza 24h - Pinheiros/SP'
  )
  assert.equal(placeNameOf(''), null)
  assert.equal(fmtMeters(213), '210 m')
  assert.equal(fmtMeters(1349), '1,3 km')
  assert.equal(fmtMeters(12_400), '12 km')
  assert.ok(Math.abs(distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111_195) < 10)
})

test('saída: cabeçalho com o centro e o raio, resumo, lista com links e o pedido de citar o Maps', () => {
  const r = parseGooglePlaces(RESPONSE, CENTER)
  const out = formatGooglePlaces(r, q(), 'sua localização atual, aproximada (-23.55, -46.69)', [
    'o sistema só libera a aproximada'
  ])
  const lines = out.split('\n')
  assert.equal(
    lines[0],
    '2 lugares do Google Maps para “pizzaria” perto de sua localização atual, aproximada (-23.55, -46.69) (o Google prioriza 1,5 km em volta, mas pode trazer mais longe — veja as distâncias).'
  )
  assert.ok(
    out.includes('Resumo do Google Maps (o [n] é o lugar n da lista abaixo):\n**Carlos Pizza** [0]')
  )
  assert.ok(
    out.includes(
      '[0] **Carlos Pizza** — 210 m · [Google Maps](https://www.google.com/maps/place//data=A1) · [como chegar](https://www.google.com/maps/dir//data=A1)'
    ),
    out
  )
  assert.ok(!out.includes('reviews='), 'sem o link de avaliações (economiza contexto)')
  assert.match(out, /Obs\.: o sistema só libera a aproximada/)
  assert.match(
    lines.at(-1)!,
    /^Ao responder, cite cada lugar com o link do Google Maps dele logo depois/
  )
  // sem centro (near no texto): sem distâncias nem raio
  const n = formatGooglePlaces(
    parseGooglePlaces(RESPONSE, null),
    q({ center: null, near: 'Avenida Paulista' }),
    'Avenida Paulista'
  )
  assert.match(n, /^2 lugares do Google Maps para “pizzaria” perto de Avenida Paulista\.\n/)
  assert.ok(n.includes('[1] **Vesu Pizzaria** · [Google Maps]'))
  const none = formatGooglePlaces({ summary: '', places: [] }, q({ cuisine: 'tailandesa' }), 'aqui')
  assert.match(
    none,
    /^O Google Maps não achou lugares para “pizzaria” \(culinária: tailandesa\) perto de aqui/
  )
  assert.ok(!none.includes('Ao responder'))
})

test('busca: POST no searchText com a chave; erros legíveis; resposta vazia é falha', async () => {
  const calls: { url: string; body: unknown; key?: string }[] = []
  const ok: MapsToolsFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body!), key: init.headers['X-Goog-Api-Key'] })
    return { ok: true, status: 200, text: async () => JSON.stringify(RESPONSE) }
  }
  const r = await searchGooglePlaces('AIza-teste', q(), {
    fetch: ok,
    signal: new AbortController().signal
  })
  assert.equal(r.places.length, 2)
  assert.equal(calls[0].url, `${MAPS_TOOLS_BASE}:searchText`)
  assert.equal(calls[0].key, 'AIza-teste')
  assert.deepEqual(calls[0].body, placesSearchBody(q()))

  const reply =
    (status: number, body: unknown): MapsToolsFetch =>
    async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) })
  await assert.rejects(
    searchGooglePlaces('k', q(), {
      fetch: reply(400, { error: { details: [{ reason: 'API_KEY_INVALID' }] } }),
      signal: new AbortController().signal
    }),
    /a chave do Google Maps é inválida/
  )
  await assert.rejects(
    searchGooglePlaces('k', q(), { fetch: reply(200, {}), signal: new AbortController().signal }),
    /resposta sem lugares/
  )
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    searchGooglePlaces('k', q(), { fetch: ok, signal: ac.signal }),
    (e: Error) => e.name === 'AbortError'
  )
})

test('settings: provedor dos lugares (OSM padrão; Google só com chave) e os textos neutros da tool', () => {
  assert.equal(normalizePlacesProvider('google', true), 'google')
  assert.equal(normalizePlacesProvider('google', false), 'osm')
  assert.equal(normalizePlacesProvider(undefined, true), 'osm')
  assert.equal(mapsSettingsState(null, 'AIzaSyKEY0123456789', 'google').placesProvider, 'google')
  assert.equal(mapsSettingsState(null, null, 'google').placesProvider, 'osm')
  assert.equal(PLACES_PROVIDER_META.google.needsKey, true)
  assert.match(PHONE_TOOL_HELP.nearby_places, /OpenStreetMap ou Google Maps/)
  const short = PHONE_TOOL_SHORT.nearby_places
  assert.ok(wordCount(short) >= 1 && wordCount(short) <= 20, short)
})
