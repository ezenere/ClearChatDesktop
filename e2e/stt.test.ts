// Transcrição de voz (STT, `src/main/voice/stt.ts`): cliente OpenAI-compatível com fetch mockado
// (multipart, idioma, filename coerente com o mime), erros legíveis (401 chave, 429 cota, 500 com
// corpo resumido, rede, timeout, abort, config), política pura `chooseSttBackend`
// (api/local/hybrid) e `transcribeWithFallback` (só o modo hybrid cai — nunca em 401/config).
// Um teste faz round-trip REAL num servidor local para conferir o multipart serializado pelo
// FormData/Blob + fetch nativos do Node.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  audioFileName,
  chooseSttBackend,
  isSttFallbackable,
  STT_DEFAULT_TIMEOUT_MS,
  SttError,
  transcribeAudio,
  transcribeWithFallback,
  type SttLocalBackend,
  type TranscribeAudioInput,
  type TranscribeResult
} from '../src/main/voice/stt.ts'
import {
  DEFAULT_STT_SETTINGS,
  type SttEndpointConfig,
  type SttSettings
} from '../src/shared/voice.ts'

// ---------------- helpers ----------------

/** Endpoint já RESOLVIDO pelo main (provedor Groq cadastrado → endereço + chave). */
const BASE_API: SttEndpointConfig = {
  ...DEFAULT_STT_SETTINGS.api,
  providerId: 'p-groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'sk-test'
}

const sttSettings = (
  over: Partial<SttSettings> = {},
  api: Partial<SttEndpointConfig> = {}
): SttSettings => ({ ...DEFAULT_STT_SETTINGS, ...over, api: { ...BASE_API, ...api } })

const bytes = (...v: number[]): Uint8Array => new Uint8Array(v)
const INPUT: TranscribeAudioInput = { audio: bytes(0, 1, 2), mimeType: 'audio/webm' }

interface FetchSpy {
  calls: { url: string; init: RequestInit }[]
  restore: () => void
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>): FetchSpy {
  const calls: FetchSpy['calls'] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const i = init ?? {}
    calls.push({ url: String(url), init: i })
    return impl(String(url), i)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig
    }
  }
}

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

async function capture(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn()
  } catch (e) {
    return e as Error
  }
  throw new Error('esperava erro, mas a chamada resolveu')
}

/** fetch que "pendura" até o signal abortar (como o nativo: rejeita com AbortError). */
const hangFetch = async (_url: string, init: RequestInit): Promise<Response> =>
  new Promise<Response>((_res, rej) => {
    const abort = (): void => rej(new DOMException('This operation was aborted', 'AbortError'))
    if (init.signal?.aborted) return abort()
    init.signal?.addEventListener('abort', abort, { once: true })
  })

function fakeLocal(
  impl: () => Promise<TranscribeResult>,
  ready = true
): { calls: TranscribeAudioInput[]; backend: SttLocalBackend } {
  const calls: TranscribeAudioInput[] = []
  const backend: SttLocalBackend = {
    ready,
    async transcribe(input) {
      calls.push(input)
      return impl()
    }
  }
  return { calls, backend }
}

const localOk = (): Promise<TranscribeResult> =>
  Promise.resolve({ text: 'local', model: 'whisper.cpp', baseUrl: 'local', ms: 1 })

// ---------------- transcribeAudio: request multipart ----------------

test('transcribeAudio: multipart correto (file/model/language/response_format) e texto do JSON', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'Olá mundo' }))
  t.after(m.restore)
  const r = await transcribeAudio(
    { audio: bytes(0, 1, 2), mimeType: 'audio/webm', fileName: 'gravacao' },
    { settings: sttSettings(), language: 'pt-BR' }
  )
  assert.deepEqual(
    { text: r.text, model: r.model, baseUrl: r.baseUrl },
    {
      text: 'Olá mundo',
      model: 'whisper-large-v3-turbo',
      baseUrl: 'https://api.groq.com/openai/v1'
    }
  )
  assert.equal(typeof r.ms, 'number')
  assert.equal(m.calls.length, 1)
  const { url, init } = m.calls[0]
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions')
  assert.equal(init.method, 'POST')
  const headers = init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer sk-test')
  const body = init.body as FormData
  assert.ok(body instanceof FormData)
  assert.equal(body.get('model'), 'whisper-large-v3-turbo')
  assert.equal(body.get('language'), 'pt')
  assert.equal(body.get('response_format'), 'json')
  const file = body.get('file')
  assert.ok(file instanceof Blob)
  assert.equal((file as File).name, 'gravacao.webm')
  assert.equal(file.type, 'audio/webm')
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [0, 1, 2])
})

test('transcribeAudio: endpoint local (localhost) sem chave → request sem Authorization', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'ok local' }))
  t.after(m.restore)
  const r = await transcribeAudio(INPUT, {
    settings: sttSettings({}, { baseUrl: 'http://127.0.0.1:8765/v1', apiKey: '' })
  })
  assert.equal(r.text, 'ok local')
  const headers = m.calls[0].init.headers as Record<string, string>
  assert.equal(headers.Authorization, undefined)
})

test('transcribeAudio: assinatura de app do pedido (`api.appHeaders`) vai no /audio/transcriptions — como nas requests do chat', async (t) => {
  // bug (uso real, 2026-11-14): a transcrição pelo OpenRouter aparecia como app "Unknown" na
  // atividade — as requests de voz não levavam o HTTP-Referer/X-Title das requests do chat
  const { appSignatureHeadersOf } = await import('../src/shared/appSignatures.ts')
  const m = mockFetch(async () => jsonRes(200, { text: 'ok' }))
  t.after(m.restore)
  await transcribeAudio(INPUT, {
    settings: sttSettings({}, { appHeaders: appSignatureHeadersOf({ appSignature: 'cline' }) })
  })
  await transcribeAudio(INPUT, {
    settings: sttSettings({}, { appHeaders: appSignatureHeadersOf() })
  })
  await transcribeAudio(INPUT, {
    settings: sttSettings(
      {},
      // nunca sobrescreve a chave nem o Accept
      { appHeaders: { 'X-Title': 'X', Authorization: 'Bearer roubada', Accept: 'text/html' } }
    )
  })
  const h = (i: number): Record<string, string> => m.calls[i].init.headers as Record<string, string>
  assert.equal(h(0)['HTTP-Referer'], 'https://cline.bot')
  assert.equal(h(0)['X-Title'], 'Cline')
  assert.equal(h(0).Authorization, 'Bearer sk-test')
  assert.equal(
    h(1)['HTTP-Referer'],
    'https://github.com/ezenere/clearchat',
    'sem contexto: a padrão'
  )
  assert.equal(h(1)['X-Title'], 'ClearChat')
  assert.equal(h(2).Authorization, 'Bearer sk-test')
  assert.equal(h(2).Accept, 'application/json')
  // 'none' = nada (e sem o campo, nada)
  await transcribeAudio(INPUT, {
    settings: sttSettings({}, { appHeaders: appSignatureHeadersOf({ appSignature: 'none' }) })
  })
  await transcribeAudio(INPUT, { settings: sttSettings() })
  for (const i of [3, 4]) {
    assert.equal(h(i)['HTTP-Referer'], undefined)
    assert.equal(h(i)['X-Title'], undefined)
  }
})

test('transcribeAudio: language vira ISO-639-1; ausente não envia o campo; baseUrl com barra final', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: '' }))
  t.after(m.restore)
  await transcribeAudio(INPUT, {
    settings: sttSettings({}, { baseUrl: 'https://x.example/v1/' }),
    language: 'en-US'
  })
  await transcribeAudio(INPUT, { settings: sttSettings() })
  assert.equal(m.calls[0].url, 'https://x.example/v1/audio/transcriptions')
  assert.equal((m.calls[0].init.body as FormData).get('language'), 'en')
  assert.equal((m.calls[1].init.body as FormData).get('language'), null)
})

test('transcribeAudio: filename coerente com o mime (wav/mp3/webm) e nome do chamador', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: '' }))
  t.after(m.restore)
  await transcribeAudio(
    { audio: bytes(1), mimeType: 'audio/wav', fileName: 'gravacao.webm' },
    { settings: sttSettings() }
  )
  await transcribeAudio({ audio: bytes(1), mimeType: 'audio/mpeg' }, { settings: sttSettings() })
  await transcribeAudio({ audio: bytes(1), mimeType: 'audio/webm' }, { settings: sttSettings() })
  const names = m.calls.map((c) => ((c.init.body as FormData).get('file') as File).name)
  assert.deepEqual(names, ['gravacao.wav', 'audio.mp3', 'audio.webm'])
  assert.equal(audioFileName('audio/x-wav'), 'audio.wav')
  assert.equal(audioFileName('audio/wav', '/tmp/x/y.mp3'), 'y.wav')
  assert.equal(audioFileName('audio/ogg', 'fala'), 'fala.ogg')
})

// ---------------- transcribeAudio: erros ----------------

test('transcribeAudio: 401 chave, 429 cota, 500 com corpo resumido, 400', async (t) => {
  const m = mockFetch(async (_u, init) => {
    const body = init.body as FormData
    const model = body.get('model')
    if (model === 'e401')
      return jsonRes(401, { error: { message: 'Invalid API Key', code: 'invalid_api_key' } })
    if (model === 'e429') return jsonRes(429, { error: { message: 'Rate limit reached' } })
    if (model === 'e500')
      return jsonRes(500, { error: { message: `upstream exploded ${'x'.repeat(300)}` } })
    return jsonRes(400, { error: { message: 'Invalid model' } })
  })
  t.after(m.restore)
  const withModel = (model: string): SttSettings => sttSettings({}, { model })

  const e401 = await capture(() => transcribeAudio(INPUT, { settings: withModel('e401') }))
  assert.ok(e401 instanceof SttError)
  assert.equal(e401.kind, 'auth')
  assert.equal(e401.status, 401)
  assert.match(e401.message, /chave de API inválida ou sem permissão \(HTTP 401\)/)
  assert.match(e401.message, /Invalid API Key/)

  const e429 = await capture(() => transcribeAudio(INPUT, { settings: withModel('e429') }))
  assert.ok(e429 instanceof SttError)
  assert.equal(e429.kind, 'quota')
  assert.equal(e429.status, 429)
  assert.match(e429.message, /limite de uso\/cota da transcrição atingido \(HTTP 429\)/)
  assert.match(e429.message, /Rate limit reached/)

  const e500 = await capture(() => transcribeAudio(INPUT, { settings: withModel('e500') }))
  assert.ok(e500 instanceof SttError)
  assert.equal(e500.kind, 'http')
  assert.equal(e500.status, 500)
  assert.match(e500.message, /^HTTP 500 na transcrição de áudio em https:\/\/api\.groq\.com/)
  assert.match(e500.message, /upstream exploded/)
  assert.ok(e500.message.length < 260, `corpo resumido: ${e500.message.length}`)

  const e400 = await capture(() => transcribeAudio(INPUT, { settings: withModel('e400') }))
  assert.ok(e400 instanceof SttError)
  assert.equal(e400.kind, 'http')
  assert.equal(e400.status, 400)
  assert.match(e400.message, /Invalid model/)
})

test('transcribeAudio: rede, config (sem chave/baseUrl/modelo) e resposta sem "text"', async (t) => {
  const m = mockFetch(async (url) => {
    if (url.includes('no-text')) return new Response('<html>proxy</html>', { status: 200 })
    throw new TypeError('fetch failed')
  })
  t.after(m.restore)

  const eNet = await capture(() => transcribeAudio(INPUT, { settings: sttSettings() }))
  assert.ok(eNet instanceof SttError)
  assert.equal(eNet.kind, 'network')
  assert.match(eNet.message, /erro de rede ao transcrever áudio em https:\/\/api\.groq\.com/)
  assert.match(eNet.message, /fetch failed/)

  const before = m.calls.length
  const eKey = await capture(() =>
    transcribeAudio(INPUT, { settings: sttSettings({}, { apiKey: '  ' }) })
  )
  assert.ok(eKey instanceof SttError)
  assert.equal(eKey.kind, 'config')
  assert.match(eKey.message, /chave de API de transcrição não configurada/)
  const eBase = await capture(() =>
    transcribeAudio(INPUT, { settings: sttSettings({}, { baseUrl: '' }) })
  )
  assert.equal((eBase as SttError).kind, 'config')
  assert.match((eBase as SttError).message, /escolha um em Configurações → Áudio/)
  // sem provedor resolvido (setting sem `providerId`): mesmo erro de config
  const eNone = await capture(() =>
    transcribeAudio(INPUT, { settings: { ...DEFAULT_STT_SETTINGS } })
  )
  assert.equal((eNone as SttError).kind, 'config')
  assert.match((eNone as SttError).message, /nenhum provedor de transcrição/)
  const eModel = await capture(() =>
    transcribeAudio(INPUT, { settings: sttSettings({}, { model: '' }) })
  )
  assert.equal((eModel as SttError).kind, 'config')
  assert.equal(m.calls.length, before, 'config errada não dispara request')

  const eText = await capture(() =>
    transcribeAudio(INPUT, {
      settings: sttSettings({}, { baseUrl: 'https://x.example/no-text' })
    })
  )
  assert.ok(eText instanceof SttError)
  assert.equal(eText.kind, 'http')
  assert.match(eText.message, /formato inesperado \(HTTP 200 sem campo "text"\)/)
})

test('transcribeAudio: timeout (60 s padrão, configurável) e abort do chamador', async (t) => {
  const m = mockFetch(hangFetch)
  t.after(m.restore)

  const eTimeout = await capture(() =>
    transcribeAudio(INPUT, { settings: sttSettings(), timeoutMs: 30 })
  )
  assert.ok(eTimeout instanceof SttError)
  assert.equal(eTimeout.kind, 'timeout')
  assert.match(eTimeout.message, /tempo esgotado na transcrição de áudio \(0\.03 s\)/)
  assert.equal(STT_DEFAULT_TIMEOUT_MS, 60_000)

  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 10)
  const eAbort = await capture(() =>
    transcribeAudio(INPUT, { settings: sttSettings(), signal: ctrl.signal })
  )
  assert.equal(eAbort.name, 'AbortError')
  assert.ok(!(eAbort instanceof SttError), 'abort não vira SttError')
})

// ---------------- multipart real via fetch nativo ----------------

test('multipart real via fetch nativo (round-trip em servidor local)', async () => {
  const seen: { raw: Buffer; headers: IncomingMessage['headers'] } = {
    raw: Buffer.alloc(0),
    headers: {}
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.raw = Buffer.concat(chunks)
      seen.headers = req.headers
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: 'round trip ok' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try {
    const r = await transcribeAudio(
      { audio: new TextEncoder().encode('FAKE-AUDIO-BYTES'), mimeType: 'audio/webm' },
      {
        settings: sttSettings({}, { apiKey: 'sk-real', baseUrl: `http://127.0.0.1:${port}/v1` }),
        language: 'pt-BR'
      }
    )
    assert.equal(r.text, 'round trip ok')
    assert.equal(r.baseUrl, `http://127.0.0.1:${port}/v1`)
    const body = seen.raw.toString('latin1')
    assert.match(seen.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/)
    assert.equal(seen.headers.authorization, 'Bearer sk-real')
    assert.match(body, /name="model"\r\n\r\nwhisper-large-v3-turbo\r\n/)
    assert.match(body, /name="language"\r\n\r\npt\r\n/)
    assert.match(body, /name="response_format"\r\n\r\njson\r\n/)
    assert.match(body, /filename="audio\.webm"/)
    assert.match(body, /Content-Type: audio\/webm/)
    assert.match(body, /FAKE-AUDIO-BYTES/)
  } finally {
    server.close()
  }
})

// ---------------- política pura ----------------

test('chooseSttBackend: api/local/hybrid (final × parcial, motor pronto ou não)', () => {
  const ready = { hasLocalReady: true }
  const notReady = { hasLocalReady: false }
  // api: sempre API (parciais melhor-esforço por chunked request)
  assert.equal(chooseSttBackend(sttSettings({ mode: 'api' }), ready), 'api')
  assert.equal(
    chooseSttBackend(sttSettings({ mode: 'api' }), { ...notReady, purpose: 'partial' }),
    'api'
  )
  // local: sempre local — sem motor pronto o erro é visível, nunca vaza o áudio para a API
  assert.equal(chooseSttBackend(sttSettings({ mode: 'local' }), notReady), 'local')
  assert.equal(
    chooseSttBackend(sttSettings({ mode: 'local' }), { ...ready, purpose: 'partial' }),
    'local'
  )
  // hybrid: final pela API; parciais pelo motor local (streaming) quando pronto, senão melhor-esforço
  assert.equal(chooseSttBackend(sttSettings({ mode: 'hybrid' }), ready), 'api')
  assert.equal(
    chooseSttBackend(sttSettings({ mode: 'hybrid' }), { ...ready, purpose: 'partial' }),
    'local'
  )
  assert.equal(
    chooseSttBackend(sttSettings({ mode: 'hybrid' }), { ...notReady, purpose: 'partial' }),
    'api'
  )
})

test('isSttFallbackable: só disponibilidade (rede/timeout/cota/5xx) — auth/config/4xx nunca', () => {
  const stt = (kind: SttError['kind'], status?: number): SttError =>
    new SttError(kind, 'x', { backend: 'api', status })
  assert.equal(isSttFallbackable(stt('network')), true)
  assert.equal(isSttFallbackable(stt('timeout')), true)
  assert.equal(isSttFallbackable(stt('quota', 429)), true)
  assert.equal(isSttFallbackable(stt('http', 500)), true)
  assert.equal(isSttFallbackable(stt('http', 502)), true)
  assert.equal(isSttFallbackable(stt('auth', 401)), false)
  assert.equal(isSttFallbackable(stt('config')), false)
  assert.equal(isSttFallbackable(stt('http', 400)), false)
  assert.equal(isSttFallbackable(new TypeError('fetch failed')), true)
  assert.equal(isSttFallbackable(new Error('qualquer')), false)
})

// ---------------- transcribeWithFallback ----------------

test('transcribeWithFallback: hybrid cai no local em erro de disponibilidade (500/rede)', async (t) => {
  const local = fakeLocal(localOk)
  const m500 = mockFetch(async () => jsonRes(500, { error: { message: 'Bad gateway' } }))
  t.after(m500.restore)
  const r1 = await transcribeWithFallback(INPUT, {
    settings: sttSettings({ mode: 'hybrid' }),
    local: local.backend
  })
  assert.deepEqual(
    { text: r1.text, backend: r1.backend, fellBack: r1.fellBack },
    { text: 'local', backend: 'local', fellBack: true }
  )
  assert.match(r1.fallbackReason ?? '', /HTTP 500/)
  assert.equal(local.calls.length, 1)
  m500.restore()

  const local2 = fakeLocal(localOk)
  const mNet = mockFetch(async () => {
    throw new TypeError('fetch failed')
  })
  t.after(mNet.restore)
  const r2 = await transcribeWithFallback(INPUT, {
    settings: sttSettings({ mode: 'hybrid' }),
    local: local2.backend
  })
  assert.equal(r2.backend, 'local')
  assert.equal(r2.fellBack, true)
  assert.match(r2.fallbackReason ?? '', /fetch failed/)
  // sucesso na API: sem fallback
  mNet.restore()
  const local3 = fakeLocal(localOk)
  const mOk = mockFetch(async () => jsonRes(200, { text: 'api' }))
  t.after(mOk.restore)
  const r3 = await transcribeWithFallback(INPUT, {
    settings: sttSettings({ mode: 'hybrid' }),
    local: local3.backend
  })
  assert.deepEqual(
    { text: r3.text, backend: r3.backend, fellBack: r3.fellBack },
    { text: 'api', backend: 'api', fellBack: false }
  )
  assert.equal(local3.calls.length, 0)
})

test('transcribeWithFallback: NÃO cai em 401 (config errada falha visível)', async (t) => {
  const local = fakeLocal(localOk)
  const m = mockFetch(async () => jsonRes(401, { error: { message: 'Invalid API Key' } }))
  t.after(m.restore)
  const e = await capture(() =>
    transcribeWithFallback(INPUT, {
      settings: sttSettings({ mode: 'hybrid' }),
      local: local.backend
    })
  )
  assert.ok(e instanceof SttError)
  assert.equal(e.kind, 'auth')
  assert.match(e.message, /chave de API inválida/)
  assert.equal(local.calls.length, 0, 'fallback não ocorre em 401')
})

test('transcribeWithFallback: modes api/local nunca trocam de backend', async (t) => {
  const local = fakeLocal(localOk)
  const m = mockFetch(async () => jsonRes(500, { error: { message: 'Bad gateway' } }))
  t.after(m.restore)
  // api puro: erro de disponibilidade também falha visível (sem secundário hoje)
  const eApi = await capture(() =>
    transcribeWithFallback(INPUT, {
      settings: sttSettings({ mode: 'api' }),
      local: local.backend
    })
  )
  assert.equal((eApi as SttError).kind, 'http')
  assert.equal(local.calls.length, 0)
  // local puro: nunca usa a API
  const local2 = fakeLocal(() => Promise.reject(new Error('motor quebrado')))
  const before = m.calls.length
  const eLocal = await capture(() =>
    transcribeWithFallback(INPUT, {
      settings: sttSettings({ mode: 'local' }),
      local: local2.backend
    })
  )
  assert.match(eLocal.message, /motor quebrado/)
  assert.equal(m.calls.length, before, 'modo local não dispara request na API')
})

test('transcribeWithFallback: local não pronto, ambos falham (notas) e abort não cai', async (t) => {
  const m = mockFetch(async () => jsonRes(503, { error: { message: 'Service unavailable' } }))
  t.after(m.restore)
  // hybrid sem motor pronto: o erro original da API segue visível
  const eNoLocal = await capture(() =>
    transcribeWithFallback(INPUT, { settings: sttSettings({ mode: 'hybrid' }) })
  )
  assert.equal((eNoLocal as SttError).status, 503)
  // local puro sem motor pronto: config visível
  const eNotReady = await capture(() =>
    transcribeWithFallback(INPUT, {
      settings: sttSettings({ mode: 'local' }),
      local: fakeLocal(localOk, false).backend
    })
  )
  assert.equal((eNotReady as SttError).kind, 'config')
  assert.match(eNotReady.message, /motor local de transcrição não está pronto/)
  // os dois falham: o erro do secundário anota a falha do primário
  const local = fakeLocal(() => Promise.reject(new TypeError('terminated')))
  const eBoth = await capture(() =>
    transcribeWithFallback(INPUT, {
      settings: sttSettings({ mode: 'hybrid' }),
      local: local.backend
    })
  )
  assert.match(eBoth.message, /terminated \(após falha em api: HTTP 503/)
  // abort: sai como AbortError, sem fallback
  const ctrl = new AbortController()
  ctrl.abort()
  const local3 = fakeLocal(localOk)
  const hang = mockFetch(hangFetch)
  const eAbort = await capture(() =>
    transcribeWithFallback(INPUT, {
      settings: sttSettings({ mode: 'hybrid' }),
      local: local3.backend,
      signal: ctrl.signal
    })
  )
  hang.restore()
  assert.equal(eAbort.name, 'AbortError')
  assert.equal(local3.calls.length, 0)
})
