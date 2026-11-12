// Sessão de transcrição (`src/main/voice/session.ts`, sem Electron): `encodeWav` (cabeçalho
// RIFF PCM16 mono, round-trip de amostras) e a sessão — parciais melhor-esforço no intervalo
// (pedaço com sobreposição, evento `{ text, isFinal, ms }`), abort da request em voo quando a
// seguinte dispara, expiração de resultado velho, `livePartials: false`/modo 'local' nunca chamam
// a API, `stop` = transcrição final via `transcribeWithFallback` (backend/fellBack; vazio sem rede),
// `cancel` nunca transcreve, sessão única com erro legível e erros de API (parcial engole, final
// propaga). fetch mockado como em `e2e/stt.test.ts`; relógio injetado (sem esperas).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeTranscribeSession,
  cancelTranscribeSessions,
  encodeWav,
  findTranscribeSession,
  splitPcmForUpload,
  startTranscribeSession,
  STT_PARTIAL_WINDOW_MS,
  trimTrailingSilence,
  VOICE_SAMPLE_RATE
} from '../src/main/voice/session.ts'
import { STT_PARTIAL_INTERVAL_MS, type SttLocalBackend } from '../src/main/voice/stt.ts'
import type { TranscribeResult } from '../src/main/voice/stt.ts'
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../src/shared/voice.ts'

// ---------------- helpers ----------------

const sttSettings = (over: Partial<SttSettings> = {}): SttSettings => ({
  ...DEFAULT_STT_SETTINGS,
  ...over,
  // endpoint já resolvido pelo main (provedor Groq cadastrado → endereço + chave)
  api: {
    ...DEFAULT_STT_SETTINGS.api,
    providerId: 'p-groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'sk-test',
    ...(over.api ?? {})
  }
})

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill)
/**
 * Fala "de verdade" para o portão de ativação (`@shared/speechGate`): 500 ms de PCM com amostras
 * 0x0101 (≈ −42 dBFS, acima do nível de ativação padrão −45) — trechos com menos de 280 ms de voz
 * nem chamam o STT.
 */
const VOICED = 16_000

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** fetch que ignora o abort e resolve depois de `ms` (simula resultado velho que chega atrasado). */
const delayedFetch = (ms: number, text: string) => async (): Promise<Response> => {
  await sleep(ms)
  return jsonRes(200, { text })
}

function fakeLocal(impl: () => Promise<TranscribeResult>): {
  calls: Uint8Array[]
  backend: SttLocalBackend
} {
  const calls: Uint8Array[] = []
  const backend: SttLocalBackend = {
    ready: true,
    async transcribe(input) {
      calls.push(input.audio)
      return impl()
    }
  }
  return { calls, backend }
}

/** PCM de 16 bits com amostras conhecidas (little-endian). */
function pcm16(...samples: number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const dv = new DataView(out.buffer)
  samples.forEach((s, i) => dv.setInt16(i * 2, s, true))
  return out
}

async function fileBytes(init: RequestInit): Promise<Uint8Array> {
  const body = init.body as FormData
  const file = body.get('file')
  assert.ok(file instanceof Blob, 'request com campo "file"')
  return new Uint8Array(await file.arrayBuffer())
}

function wavPcm(wav: Uint8Array): Uint8Array {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE')
  assert.equal(dv.getUint32(4, true), 36 + wav.length - 44)
  assert.equal(dv.getUint32(40, true), wav.length - 44)
  return wav.subarray(44)
}

interface Clock {
  now: () => number
  advance: (ms: number) => void
}
const clock = (): Clock => {
  let t = 1_000_000
  return { now: () => t, advance: (ms) => (t += ms) }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

// ---------------- encodeWav ----------------

test('encodeWav: cabeçalho RIFF/WAVE PCM 16-bit mono correto e round-trip das amostras', () => {
  const pcm = pcm16(0, 1, -1, 12345, -32768, 32767)
  const wav = encodeWav(pcm, VOICE_SAMPLE_RATE)
  const dv = new DataView(wav.buffer)
  assert.equal(wav.length, 44 + pcm.length)
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), 'RIFF')
  assert.equal(dv.getUint32(4, true), 36 + pcm.length) // tamanho do RIFF
  assert.equal(String.fromCharCode(...wav.subarray(8, 12)), 'WAVE')
  assert.equal(String.fromCharCode(...wav.subarray(12, 16)), 'fmt ')
  assert.equal(dv.getUint32(16, true), 16) // tamanho do fmt
  assert.equal(dv.getUint16(20, true), 1) // PCM
  assert.equal(dv.getUint16(22, true), 1) // mono
  assert.equal(dv.getUint32(24, true), VOICE_SAMPLE_RATE)
  assert.equal(dv.getUint32(28, true), VOICE_SAMPLE_RATE * 2) // byteRate
  assert.equal(dv.getUint16(32, true), 2) // blockAlign
  assert.equal(dv.getUint16(34, true), 16) // bits por amostra
  assert.equal(String.fromCharCode(...wav.subarray(36, 40)), 'data')
  assert.equal(dv.getUint32(40, true), pcm.length)
  // round-trip byte a byte
  assert.ok(sameBytes(wav.subarray(44), pcm))
})

test('encodeWav: pcm vazio → wav de 44 bytes; sampleRate entra no byteRate; inválidos lançam', () => {
  const empty = encodeWav(new Uint8Array(0), 48_000)
  assert.equal(empty.length, 44)
  assert.equal(new DataView(empty.buffer).getUint32(40, true), 0)
  assert.equal(new DataView(empty.buffer).getUint32(28, true), 96_000)
  assert.throws(() => encodeWav(new Uint8Array(3), 16_000), /ímpar/)
  assert.throws(() => encodeWav(new Uint8Array(2), 0), /sampleRate inválido/)
  assert.throws(() => encodeWav(new Uint8Array(2), 1.5), /sampleRate inválido/)
})

// ---------------- parciais melhor-esforço ----------------

test('parciais: disparam no intervalo, pedaço com sobreposição e evento { text, isFinal: false, ms }', async (t) => {
  const texts = ['parcial um', 'parcial dois']
  const m = mockFetch(async () => jsonRes(200, { text: texts.shift() ?? '?' }))
  t.after(m.restore)
  const c = clock()
  const events: { sessionId: string; text: string; isFinal: boolean; ms: number }[] = []
  const A = bytes(20_000, 1)
  const B = bytes(8_000, 2)
  const C = bytes(5_000, 3)
  const D = bytes(7_000, 4)
  const s = startTranscribeSession(
    { settings: sttSettings(), language: 'pt-BR' },
    { now: c.now, onPartial: (e) => events.push(e) }
  )
  t.after(() => s.cancel())

  s.push(A, VOICE_SAMPLE_RATE)
  assert.equal(m.calls.length, 0, 'intervalo ainda não decorreu')
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(B, VOICE_SAMPLE_RATE)
  await sleep(0)
  assert.equal(m.calls.length, 1)
  // 1ª parcial: o acumulado inteiro (covered = 0)
  assert.ok(sameBytes(wavPcm(await fileBytes(m.calls[0].init)), new Uint8Array([...A, ...B])))
  assert.equal((m.calls[0].init.body as FormData).get('language'), 'pt')

  s.push(C, VOICE_SAMPLE_RATE)
  assert.equal(m.calls.length, 1, 'não dispara antes do intervalo')
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(D, VOICE_SAMPLE_RATE)
  await sleep(0)
  assert.equal(m.calls.length, 2)
  // 2ª parcial: o trecho inteiro (≤ 10 s desde o início/último segmento) é transcrito de novo —
  // texto sem emendas, que pode virar a final (as janelas com sobreposição ficam para > 10 s)
  const total = new Uint8Array([...A, ...B, ...C, ...D])
  assert.ok(sameBytes(wavPcm(await fileBytes(m.calls[1].init)), total))

  assert.equal(events.length, 2)
  assert.equal(events[0].text, 'parcial um')
  assert.equal(events[1].text, 'parcial dois', 'a parcial do trecho inteiro substitui a anterior')
  for (const e of events) {
    assert.equal(e.isFinal, false)
    assert.equal(e.sessionId, s.id)
    assert.equal(typeof e.ms, 'number')
  }
  // o wav enviado é PCM16 mono 16 kHz
  const wav = await fileBytes(m.calls[0].init)
  assert.equal(new DataView(wav.buffer, wav.byteOffset).getUint32(24, true), VOICE_SAMPLE_RATE)
})

test('parciais: nunca dispara com outra em voo (sem fila e sem abortar-e-reenviar)', async (t) => {
  let release: (() => void) | null = null
  const m = mockFetch(async () => {
    if (m.calls.length === 1)
      return new Promise<Response>((res) => {
        release = () => res(jsonRes(200, { text: 'primeira' }))
      })
    return jsonRes(200, { text: 'segunda' })
  })
  t.after(m.restore)
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings() },
    { now: c.now, onPartial: (e) => events.push(e.text) }
  )
  t.after(() => s.cancel())

  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(16_000), VOICE_SAMPLE_RATE) // 1ª dispara (fica pendurada)
  assert.equal(m.calls.length, 1)
  for (let i = 0; i < 3; i++) {
    c.advance(STT_PARTIAL_INTERVAL_MS)
    s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  }
  assert.equal(m.calls.length, 1, 'com uma em voo, nenhuma outra dispara')
  assert.equal(m.calls[0].init.signal?.aborted, false, 'a em voo nunca é abortada pela seguinte')
  release!()
  await sleep(0)
  assert.deepEqual(events, ['primeira'])
  // a próxima transcreve o trecho inteiro de novo (≤ 10 s — texto sem emendas)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  assert.equal(m.calls.length, 2)
  const sent = wavPcm(await fileBytes(m.calls[1].init))
  assert.equal(sent.length, 16_000 * 6, 'pedaço = o trecho inteiro')
  await sleep(0)
  assert.deepEqual(events, ['primeira', 'segunda'])
})

test('parciais: janela máxima de ~10 s (o pedaço nunca cresce com a gravação)', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'x' }))
  t.after(m.restore)
  const c = clock()
  const s = startTranscribeSession({ settings: sttSettings() }, { now: c.now })
  t.after(() => s.cancel())
  // 30 s de áudio de uma vez antes do 1º disparo
  s.push(bytes(30 * 32_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(32), VOICE_SAMPLE_RATE)
  assert.equal(m.calls.length, 1)
  const sent = wavPcm(await fileBytes(m.calls[0].init))
  assert.equal(sent.length, STT_PARTIAL_WINDOW_MS * 32, 'só os últimos 10 s vão na parcial')
})

test('parciais: resultado que chega depois do fim da sessão é descartado', async (t) => {
  const m = mockFetch(delayedFetch(30, 'VELHO'))
  t.after(m.restore)
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings() },
    { now: c.now, onPartial: (e) => events.push(e.text) }
  )
  s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE) // dispara (resolve em 30 ms, ignorando o abort)
  s.cancel()
  await sleep(60)
  assert.deepEqual(events, [], 'a parcial velha expirou')
})

test('parciais: auth/cota desligam as parciais no resto da sessão com UM aviso (sem reenvio)', async (t) => {
  for (const status of [401, 429]) {
    const m = mockFetch(async () => jsonRes(status, { error: { message: 'nope' } }))
    const c = clock()
    const events: { text: string; error?: string }[] = []
    const s = startTranscribeSession(
      { settings: sttSettings() },
      { now: c.now, onPartial: (e) => events.push(e) }
    )
    for (let i = 0; i < 4; i++) {
      c.advance(STT_PARTIAL_INTERVAL_MS)
      s.push(bytes(8_000), VOICE_SAMPLE_RATE)
      await sleep(0)
    }
    s.cancel()
    m.restore()
    assert.equal(m.calls.length, 1, `HTTP ${status}: uma tentativa só`)
    assert.equal(events.length, 1, 'um aviso')
    assert.match(events[0].error ?? '', /Parciais ao vivo desligadas/)
    assert.equal(events[0].text, '')
  }
  t.diagnostic('401 e 429 desligam as parciais')
})

test('parciais locais: motor com partials=false (modelo maior que o base) só faz a final', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'api' }))
  t.after(m.restore)
  const local = fakeLocal(() =>
    Promise.resolve({ text: 'final', model: 'ggml-small', baseUrl: 'local', ms: 1 })
  )
  local.backend.partials = false
  const c = clock()
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'local' }) },
    { now: c.now, local: local.backend, hasLocalReady: true }
  )
  for (let i = 0; i < 3; i++) {
    c.advance(STT_PARTIAL_INTERVAL_MS)
    s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  }
  await sleep(0)
  assert.equal(local.calls.length, 0, 'nenhuma parcial local')
  const r = await s.stop()
  assert.equal(r.text, 'final')
  assert.equal(local.calls.length, 1)
  assert.equal(m.calls.length, 0)
})

test('parciais: livePartials false e modo "local" nunca chamam a API', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'x' }))
  t.after(m.restore)
  for (const settings of [sttSettings({ livePartials: false }), sttSettings({ mode: 'local' })]) {
    const c = clock()
    const s = startTranscribeSession({ settings }, { now: c.now })
    s.push(bytes(8_000), VOICE_SAMPLE_RATE)
    c.advance(STT_PARTIAL_INTERVAL_MS * 3)
    s.push(bytes(8_000), VOICE_SAMPLE_RATE)
    s.push(bytes(8_000), VOICE_SAMPLE_RATE)
    await sleep(0)
    s.cancel()
    assert.equal(m.calls.length, 0, 'nenhuma chamada de parcial')
  }
})

// ---------------- stop / cancel ----------------

test('stop: transcreve o buffer inteiro como final e devolve backend/fellBack', async (t) => {
  const texts = ['parcial', 'final']
  const m = mockFetch(async () => jsonRes(200, { text: texts.shift() ?? '?' }))
  t.after(m.restore)
  const c = clock()
  const s = startTranscribeSession({ settings: sttSettings(), language: 'pt-BR' }, { now: c.now })
  const A = bytes(20_000, 7)
  const B = bytes(10_000, 8)
  s.push(A, VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(B, VOICE_SAMPLE_RATE)
  await sleep(0)
  assert.equal(m.calls.length, 1, 'uma parcial antes do stop')

  const r = await s.stop()
  assert.deepEqual(
    { text: r.text, backend: r.backend, fellBack: r.fellBack },
    { text: 'final', backend: 'api', fellBack: false }
  )
  assert.equal(typeof r.ms, 'number')
  assert.equal(m.calls.length, 2, 'só a final depois do stop')
  // a final vai com o buffer INTEIRO (wav PCM16 mono 16 kHz)
  assert.ok(sameBytes(wavPcm(await fileBytes(m.calls[1].init)), new Uint8Array([...A, ...B])))
  assert.equal((m.calls[1].init.body as FormData).get('model'), 'whisper-large-v3-turbo')
  assert.equal(activeTranscribeSession(), null, 'sessão encerrada libera a global')
})

test('stop: hybrid com motor local injetado cai no local em falha de disponibilidade (fellBack)', async (t) => {
  const m = mockFetch(async () => {
    throw new TypeError('fetch failed')
  })
  t.after(m.restore)
  const local = fakeLocal(() =>
    Promise.resolve({ text: 'local', model: 'whisper.cpp', baseUrl: 'local', ms: 1 })
  )
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'hybrid' }) },
    { now: clock().now, local: local.backend }
  )
  s.push(bytes(VOICED), VOICE_SAMPLE_RATE)
  const r = await s.stop()
  assert.deepEqual(
    { text: r.text, backend: r.backend, fellBack: r.fellBack },
    { text: 'local', backend: 'local', fellBack: true }
  )
  assert.ok(r.fallbackReason, 'motivo do fallback anotado')
  assert.equal(m.calls.length, 1, 'a API foi tentada primeiro')
  assert.equal(local.calls.length, 1)
  assert.ok(
    sameBytes(wavPcm(local.calls[0]), bytes(VOICED)),
    'o local recebeu o buffer inteiro (wav)'
  )
})

test('stop: modo "local" com motor pronto transcreve local (a API nunca é chamada); sem motor → erro legível', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'não deve chegar aqui' }))
  t.after(m.restore)
  const local = fakeLocal(() =>
    Promise.resolve({ text: 'do motor', model: 'whisper.cpp', baseUrl: 'local', ms: 1 })
  )
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'local' }) },
    { now: clock().now, local: local.backend }
  )
  s.push(bytes(VOICED), VOICE_SAMPLE_RATE)
  const r = await s.stop()
  assert.deepEqual(
    { text: r.text, backend: r.backend, fellBack: r.fellBack },
    { text: 'do motor', backend: 'local', fellBack: false }
  )
  assert.equal(m.calls.length, 0, 'modo local nunca vaza áudio para a API')

  const s2 = startTranscribeSession({ settings: sttSettings({ mode: 'local' }) })
  s2.push(bytes(VOICED), VOICE_SAMPLE_RATE)
  await assert.rejects(() => s2.stop(), /motor local de transcrição não está pronto/)
})

test('stop: sem áudio → texto vazio sem rede; cancel nunca transcreve e encerra a sessão', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'x' }))
  t.after(m.restore)
  const s = startTranscribeSession({ settings: sttSettings() })
  const r = await s.stop()
  assert.deepEqual(
    { text: r.text, backend: r.backend, fellBack: r.fellBack },
    { text: '', backend: 'api', fellBack: false }
  )
  assert.equal(m.calls.length, 0, 'stop vazio não vai à rede')

  const s2 = startTranscribeSession({ settings: sttSettings() }, { now: clock().now })
  s2.push(bytes(8_000), VOICE_SAMPLE_RATE)
  s2.cancel()
  s2.cancel() // idempotente
  await sleep(0)
  assert.equal(m.calls.length, 0, 'cancel nunca transcreve')
  assert.throws(() => s2.push(bytes(2), VOICE_SAMPLE_RATE), /não está mais ativa/)
  await assert.rejects(() => s2.stop(), /não está mais ativa/)
  assert.equal(activeTranscribeSession(), null)
})

test('autocura: iniciar outra com uma ativa substitui (a anterior é cancelada)', async () => {
  const s1 = startTranscribeSession({ settings: sttSettings() })
  s1.push(bytes(100), VOICE_SAMPLE_RATE)
  const s2 = startTranscribeSession({ settings: sttSettings() })
  assert.notEqual(s2.id, s1.id)
  assert.equal(activeTranscribeSession()?.id, s2.id)
  assert.throws(() => s1.push(bytes(2), VOICE_SAMPLE_RATE), /não está mais ativa/)
  assert.equal(findTranscribeSession(s1.id), null, 'a substituída sumiu')
  s2.cancel()
  assert.equal(activeTranscribeSession(), null)
})

test('autocura: a final em voo da anterior termina mesmo com uma nova sessão aberta', async (t) => {
  const m = mockFetch(delayedFetch(20, 'final antiga'))
  t.after(m.restore)
  const s1 = startTranscribeSession({ settings: sttSettings() })
  s1.push(bytes(VOICED), VOICE_SAMPLE_RATE)
  const p = s1.stop()
  assert.equal(activeTranscribeSession(), null, 'o stop libera a vaga de captura na hora')
  assert.equal(findTranscribeSession(s1.id)?.id, s1.id, 'a que está transcrevendo segue viva')
  const s2 = startTranscribeSession({ settings: sttSettings() })
  assert.equal((await p).text, 'final antiga')
  assert.equal(activeTranscribeSession()?.id, s2.id)
  s2.cancel()
})

test('autocura: cancelTranscribeSessions(dono) descarta as do renderer que sumiu (inclusive a final em voo)', async (t) => {
  const m = mockFetch(
    (_url, init) =>
      new Promise<Response>((_res, rej) => {
        init.signal?.addEventListener(
          'abort',
          () => rej(new DOMException('This operation was aborted', 'AbortError')),
          { once: true }
        )
      })
  )
  t.after(m.restore)
  const a = startTranscribeSession({ settings: sttSettings() }, { ownerId: 1 })
  a.push(bytes(4_000), VOICE_SAMPLE_RATE)
  const finalA = a.stop() // final pendurada
  const b = startTranscribeSession({ settings: sttSettings() }, { ownerId: 2 })
  assert.equal(cancelTranscribeSessions(1), 1, 'só a do dono 1')
  await assert.rejects(finalA, (e: Error) => e.name === 'AbortError')
  assert.equal(activeTranscribeSession()?.id, b.id, 'a do outro dono segue')
  assert.equal(cancelTranscribeSessions(1), 0, 'idempotente')
  assert.equal(cancelTranscribeSessions(), 1, 'sem dono: todas')
  assert.equal(activeTranscribeSession(), null)
})

test('autocura: sem PCM pelo tempo de ociosidade a sessão se cancela sozinha', async () => {
  const s = startTranscribeSession({ settings: sttSettings() }, { idleTimeoutMs: 30 })
  await sleep(15)
  s.push(bytes(100), VOICE_SAMPLE_RATE) // push rearma
  await sleep(20)
  assert.equal(activeTranscribeSession()?.id, s.id, 'push recente mantém a sessão')
  await sleep(40)
  assert.equal(activeTranscribeSession(), null, 'ociosa → cancelada')
  assert.throws(() => s.push(bytes(2), VOICE_SAMPLE_RATE), /não está mais ativa/)
})

test('teto de duração: o excedente é descartado com um aviso e a final usa o que coube', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'ok' }))
  t.after(m.restore)
  const events: { error?: string }[] = []
  const s = startTranscribeSession(
    { settings: sttSettings({ livePartials: false }) },
    { maxAudioMs: 500, onPartial: (e) => events.push(e) } // 500 ms = 16 000 bytes
  )
  s.push(bytes(10_000), VOICE_SAMPLE_RATE)
  s.push(bytes(10_000), VOICE_SAMPLE_RATE)
  s.push(bytes(10_000), VOICE_SAMPLE_RATE)
  assert.equal(events.length, 1)
  assert.match(events[0].error ?? '', /limite/)
  await s.stop()
  assert.equal(wavPcm(await fileBytes(m.calls[0].init)).length, 16_000)
})

test('final acima do limite de upload: segmentos cortados no silêncio e textos concatenados', async (t) => {
  const texts = ['um', 'dois', 'três']
  const m = mockFetch(async () => jsonRes(200, { text: texts.shift() ?? '?' }))
  t.after(m.restore)
  const s = startTranscribeSession(
    { settings: sttSettings({ livePartials: false }) },
    { apiMaxUploadBytes: 44 + 32_000 } // 1 s por request
  )
  // 2,5 s de "fala" com um vale de silêncio perto de 0,9 s
  const pcm = new Int16Array(40_000).fill(3000)
  pcm.fill(0, 14_000, 15_600)
  s.push(new Uint8Array(pcm.buffer), VOICE_SAMPLE_RATE)
  const r = await s.stop()
  assert.equal(m.calls.length, 3)
  assert.equal(r.text, 'um dois três')
  const sizes = await Promise.all(m.calls.map(async (c) => wavPcm(await fileBytes(c.init)).length))
  for (const n of sizes) assert.ok(n <= 32_000, `segmento de ${n} bytes cabe no limite`)
  assert.equal(
    sizes.reduce((a, b) => a + b, 0),
    80_000,
    'nada se perde entre os segmentos'
  )
  // o 1º corte caiu dentro do vale de silêncio (amostras 14 000–15 600)
  assert.ok(sizes[0] / 2 >= 14_000 && sizes[0] / 2 <= 15_600, `corte em ${sizes[0] / 2}`)
})

test('trimTrailingSilence: apara silêncio final longo (deixa ~400 ms) e mantém o curto', () => {
  const speech = new Int16Array(16_000).fill(2000)
  const longSil = new Int16Array(48_000) // 3 s
  const joined = new Int16Array([...speech, ...longSil])
  const out = trimTrailingSilence(new Uint8Array(joined.buffer))
  assert.equal(out.length / 2, 16_000 + 6_400)
  const shortSil = new Int16Array([...speech, ...new Int16Array(16_000)]) // 1 s
  assert.equal(trimTrailingSilence(new Uint8Array(shortSil.buffer)).length, shortSil.length * 2)
  assert.equal(trimTrailingSilence(new Uint8Array(0)).length, 0)
})

test('splitPcmForUpload: cabe → 1 pedaço; não cabe → pedaços ≤ limite que somam o total', () => {
  const pcm = new Uint8Array(new Int16Array(10_000).fill(500).buffer)
  assert.equal(splitPcmForUpload(pcm, 20_000).length, 1)
  const parts = splitPcmForUpload(pcm, 6_001)
  assert.ok(parts.length >= 4)
  for (const p of parts) assert.ok(p.length <= 6_000 && p.length % 2 === 0)
  assert.equal(
    parts.reduce((a, p) => a + p.length, 0),
    pcm.length
  )
})

test('push: sampleRate diferente de 16 kHz e tamanho ímpar são erros legíveis', () => {
  const s = startTranscribeSession({ settings: sttSettings() })
  try {
    assert.throws(() => s.push(bytes(2), 48_000), /16000 Hz/)
    assert.throws(() => s.push(new Uint8Array(3)), /ímpar/)
    assert.throws(() => s.push('x' as unknown as Uint8Array), /Uint8Array/)
  } finally {
    s.cancel()
  }
})

test('erros de API: parcial engole (melhor-esforço) e a sessão segue; o final propaga legível', async (t) => {
  const m = mockFetch(async () => jsonRes(500, { error: { message: 'quebrou' } }))
  t.after(m.restore)
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings() },
    { now: c.now, onPartial: (e) => events.push(e.text) }
  )
  s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE) // 1ª parcial falha (500) — engolida
  await sleep(0)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE) // 2ª dispara mesmo assim
  await sleep(0)
  assert.equal(m.calls.length, 2, 'a falha da parcial não interrompe a sessão')
  assert.deepEqual(events, [])
  await assert.rejects(() => s.stop(), /HTTP 500/)
})

// ---------------- parciais pelo motor local (janelas) ----------------

test('parciais locais: modo "local" com motor pronto emite parciais por janelas (API nunca)', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'não deve chegar aqui' }))
  t.after(m.restore)
  const texts = ['UM', 'DOIS']
  const local = fakeLocal(() =>
    Promise.resolve({ text: texts.shift() ?? '?', model: 'ggml-tiny', baseUrl: 'local', ms: 1 })
  )
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'local' }) },
    {
      now: c.now,
      local: local.backend,
      hasLocalReady: true,
      onPartial: (e) => events.push(e.text)
    }
  )
  t.after(() => s.cancel())

  const A = bytes(8_000, 7)
  const B = bytes(8_000, 8)
  s.push(A, VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(B, VOICE_SAMPLE_RATE) // 1ª janela: [0, 16000)
  await sleep(0)
  assert.deepEqual(events, ['UM'])
  assert.equal(local.calls.length, 1)
  assert.ok(sameBytes(wavPcm(local.calls[0]), new Uint8Array([...A, ...B])), 'janela = acumulado')

  const C = bytes(8_000, 9)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(C, VOICE_SAMPLE_RATE) // 2ª: o trecho inteiro [0, 24000) (≤ 10 s)
  await sleep(0)
  assert.deepEqual(events, ['UM', 'DOIS'], 'a parcial do trecho inteiro substitui (como na API)')
  assert.equal(local.calls.length, 2)
  assert.ok(
    sameBytes(wavPcm(local.calls[1]), new Uint8Array([...A, ...B, ...C])),
    '2ª = o trecho inteiro'
  )
  assert.equal(m.calls.length, 0, 'modo local nunca vaza para a API (nem nas parciais)')
})

test('parciais locais: hybrid usa o motor local quando pronto e a API melhor-esforço quando não', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'api' }))
  t.after(m.restore)

  // pronto: parciais pelo motor local
  const local = fakeLocal(() =>
    Promise.resolve({ text: 'local', model: 'ggml-tiny', baseUrl: 'local', ms: 1 })
  )
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'hybrid' }) },
    { now: c.now, local: local.backend, hasLocalReady: true, onPartial: (e) => events.push(e.text) }
  )
  s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  await sleep(0)
  s.cancel()
  assert.deepEqual(events, ['local'])
  assert.equal(local.calls.length, 1)
  assert.equal(m.calls.length, 0, 'hybrid + pronto: parciais locais, sem API')

  // sem pronto: parciais seguem melhor-esforço pela API
  const events2: string[] = []
  const c2 = clock()
  const s2 = startTranscribeSession(
    { settings: sttSettings({ mode: 'hybrid' }) },
    { now: c2.now, onPartial: (e) => events2.push(e.text) }
  )
  s2.push(bytes(8_000), VOICE_SAMPLE_RATE)
  c2.advance(STT_PARTIAL_INTERVAL_MS)
  s2.push(bytes(8_000), VOICE_SAMPLE_RATE)
  await sleep(0)
  s2.cancel()
  assert.deepEqual(events2, ['api'])
  assert.equal(m.calls.length, 1, 'hybrid sem pronto: parcial melhor-esforço pela API')
})

test('modo "local" sem motor pronto não dispara parciais (nem locais nem de API)', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'x' }))
  t.after(m.restore)
  const local = fakeLocal(() =>
    Promise.resolve({ text: '?', model: 'ggml-tiny', baseUrl: 'local', ms: 1 })
  )
  local.backend.ready = false
  const c = clock()
  const events: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'local' }) },
    { now: c.now, local: local.backend, hasLocalReady: true, onPartial: (e) => events.push(e.text) }
  )
  s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  c.advance(STT_PARTIAL_INTERVAL_MS * 2)
  s.push(bytes(8_000), VOICE_SAMPLE_RATE)
  await sleep(0)
  s.cancel()
  assert.deepEqual(events, [])
  assert.equal(local.calls.length, 0)
  assert.equal(m.calls.length, 0)
})

// ---------------- transcrição especulativa (fim de turno adaptativo) ----------------

test('speculate: motor local transcreve o buffer sem encerrar; stop({reuseSpeculative}) reusa (sem 2ª chamada)', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'api' }))
  t.after(m.restore)
  let n = 0
  const local = fakeLocal(() =>
    Promise.resolve({ text: `fala ${++n}`, model: 'ggml-base', baseUrl: 'local', ms: 5 })
  )
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'local', livePartials: false }) },
    { now: clock().now, local: local.backend, hasLocalReady: true }
  )
  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  const spec = await s.speculate()
  assert.deepEqual(spec, { text: 'fala 1', ms: 5, backend: 'local', reusable: true })
  // sem áudio novo: a mesma especulação (sem chamar o motor de novo)
  assert.deepEqual(await s.speculate(), spec)
  assert.equal(local.calls.length, 1)
  // silêncio chegou depois (o usuário não voltou a falar): a especulativa vira a final
  s.push(new Uint8Array(3_200), VOICE_SAMPLE_RATE)
  const r = await s.stop({ reuseSpeculative: true })
  assert.equal(r.text, 'fala 1')
  assert.equal(r.speculative, true)
  assert.equal(r.backend, 'local')
  assert.equal(local.calls.length, 1, 'nenhuma 2ª transcrição')
  assert.equal(m.calls.length, 0)
})

test('speculate: sem reuse (usuário voltou a falar) a final transcreve tudo de novo', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'api' }))
  t.after(m.restore)
  let n = 0
  const local = fakeLocal(() =>
    Promise.resolve({ text: `fala ${++n}`, model: 'ggml-base', baseUrl: 'local', ms: 5 })
  )
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'local', livePartials: false }) },
    { now: clock().now, local: local.backend, hasLocalReady: true }
  )
  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  await s.speculate()
  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  const r = await s.stop()
  assert.equal(r.text, 'fala 2')
  assert.equal(r.speculative, undefined)
  assert.equal(local.calls.length, 2)
})

test('speculate: modo api só com allowApi; híbrido com motor local especula local mas não reusa', async (t) => {
  const m = mockFetch(async () => jsonRes(200, { text: 'pela api' }))
  t.after(m.restore)
  const api = startTranscribeSession(
    { settings: sttSettings({ livePartials: false }) },
    { now: clock().now }
  )
  api.push(bytes(16_000), VOICE_SAMPLE_RATE)
  assert.equal(await api.speculate(), null, 'API sem permissão: indisponível (custa request)')
  assert.equal(m.calls.length, 0)
  const spec = await api.speculate({ allowApi: true })
  assert.deepEqual(
    { text: spec?.text, backend: spec?.backend, reusable: spec?.reusable },
    { text: 'pela api', backend: 'api', reusable: true }
  )
  api.cancel()

  const local = fakeLocal(() =>
    Promise.resolve({ text: 'local', model: 'ggml-base', baseUrl: 'local', ms: 1 })
  )
  const hy = startTranscribeSession(
    { settings: sttSettings({ mode: 'hybrid', livePartials: false }) },
    { now: clock().now, local: local.backend, hasLocalReady: true }
  )
  hy.push(bytes(16_000), VOICE_SAMPLE_RATE)
  const h = await hy.speculate()
  assert.equal(h?.backend, 'local')
  assert.equal(h?.reusable, false, 'a final do híbrido é pela API (qualidade)')
  const before = m.calls.length
  const r = await hy.stop({ reuseSpeculative: true })
  assert.equal(r.backend, 'api')
  assert.equal(m.calls.length, before + 1, 'não reusável: a final transcreve')
})

test('speculate: falha do motor resolve null (o chamador cai no silêncio fixo)', async () => {
  const local = fakeLocal(() => Promise.reject(new Error('boom')))
  const s = startTranscribeSession(
    { settings: sttSettings({ mode: 'local', livePartials: false }) },
    { now: clock().now, local: local.backend, hasLocalReady: true }
  )
  s.push(bytes(16_000), VOICE_SAMPLE_RATE)
  assert.equal(await s.speculate(), null)
  s.cancel()
})
