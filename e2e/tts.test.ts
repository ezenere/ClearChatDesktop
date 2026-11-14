// Síntese de fala (TTS, `src/main/voice/tts.ts` + `ttsLocal.ts`): cliente OpenAI-compatível
// `/audio/speech` com fetch mockado (payload JSON `{ model, voice, input, response_format }`,
// bytes de áudio na resposta), erros legíveis (401 chave, 429 cota, 500 com corpo resumido, rede,
// timeout, abort, config), despacho para o motor local (injetado) e os helpers puros de fonemas do
// Kokoro (mapeamento do espeak-ng → vocabulário). O spike real do Kokoro está reportado na SPEC —
// aqui nada roda ONNX nem baixa pesos.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catalogFileName, findCatalogEntry } from '../src/main/voice/catalog.ts'
import {
  createKokoroEngine,
  espeakInstallHint,
  kokoroInputIds,
  KOKORO_VOCAB,
  mapEspeakPhonemes,
  phonemizeText,
  ESPEAK_E2M
} from '../src/main/voice/ttsLocal.ts'
import {
  collectPcmStream,
  resetTtsPcmEndpoints,
  synthesize,
  synthesizeStream,
  ttsEndpointWantsPcm,
  TTS_DEFAULT_TIMEOUT_MS,
  TTS_TEST_PHRASE,
  TtsError,
  type TtsLocalBackend,
  type TtsLocalInput,
  type TtsLocalResult
} from '../src/main/voice/tts.ts'
import {
  DEFAULT_TTS_SETTINGS,
  normalizeTtsSettings,
  type TtsSettings
} from '../src/shared/voice.ts'

// ---------------- helpers ----------------

/** Settings de fala por API com o endpoint já RESOLVIDO pelo main (provedor → endereço + chave). */
const apiSettings = (over: Partial<TtsSettings['api']> = {}): TtsSettings => {
  const api = {
    providerId: 'p-tts',
    baseUrl: 'https://tts.example/v1',
    apiKey: 'sk-test',
    model: 'tts-model',
    voice: 'alloy',
    ...over
  }
  const stored = normalizeTtsSettings({ backend: 'api', api })
  return { ...stored, api: { ...stored.api, baseUrl: api.baseUrl, apiKey: api.apiKey } }
}

/** `apiSettings` com a assinatura de app resolvida pelo main (`api.appHeaders`). */
const withAppHeaders = (s: TtsSettings, appHeaders: Record<string, string>): TtsSettings => ({
  ...s,
  api: { ...s.api, appHeaders }
})

const localSettings = (): TtsSettings =>
  normalizeTtsSettings({
    backend: 'local',
    local: { engine: 'kokoro', voice: 'pf_dora', installed: true }
  })

/** fetch mockado: captura a chamada e devolve o corpo com o status/content-type pedidos. */
function mockFetch(
  respond: (
    url: string,
    init?: RequestInit
  ) => { status?: number; body: Uint8Array | string; contentType?: string }
): { calls: { url: string; init?: RequestInit }[]; fetch: typeof fetch } {
  const calls: { url: string; init?: RequestInit }[] = []
  return {
    calls,
    fetch: (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      const r = respond(String(url), init)
      return new Response(
        new Uint8Array(typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body),
        {
          status: r.status ?? 200,
          headers: { 'content-type': r.contentType ?? 'audio/wav' }
        }
      )
    }) as typeof fetch
  }
}

/** fetch mockado que "pendura" até o signal abortar (como o nativo: rejeita com AbortError). */
function hangingFetch(): typeof fetch {
  return ((url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      )
    })) as typeof fetch
}

async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch
  globalThis.fetch = f
  try {
    return await fn()
  } finally {
    globalThis.fetch = orig
  }
}

/** Motor local fake (registra as chamadas e devolve bytes fixos). */
function fakeEngine(over: Partial<TtsLocalResult> = {}): {
  backend: TtsLocalBackend
  calls: TtsLocalInput[]
} {
  const calls: TtsLocalInput[] = []
  return {
    calls,
    backend: {
      engine: 'kokoro',
      async synthesize(input) {
        calls.push(input)
        return {
          audio: new Uint8Array([0, 1, 2, 3]),
          mime: 'audio/wav',
          model: 'kokoro-onnx',
          ms: 7,
          ...over
        }
      }
    }
  }
}

// ---------------- cliente da API ----------------

test('tts api: payload JSON correto (model/voice/input/response_format) e bytes devolvidos', async () => {
  const audio = new Uint8Array([1, 2, 3, 4, 5])
  const { calls, fetch } = mockFetch(() => ({ body: audio }))
  const r = await withFetch(fetch, () =>
    synthesize({ text: 'Olá!', settings: apiSettings(), format: 'mp3' })
  )
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, 'https://tts.example/v1/audio/speech')
  assert.equal(init?.method, 'POST')
  const headers = init?.headers as Record<string, string>
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(JSON.parse(String(init?.body)), {
    model: 'tts-model',
    input: 'Olá!',
    response_format: 'mp3',
    voice: 'alloy'
  })
  assert.deepEqual([...r.audio], [1, 2, 3, 4, 5])
  assert.equal(r.mime, 'audio/mpeg')
  assert.equal(r.model, 'tts-model')
  assert.equal(r.backend, 'api')
  assert.ok(r.ms >= 0)
})

test('tts api: formato padrão wav, voz nula omitida, baseUrl com barra e chave vazia sem Authorization', async () => {
  const { calls, fetch } = mockFetch(() => ({ body: new Uint8Array([9]) }))
  await withFetch(fetch, () =>
    synthesize({
      text: 'oi',
      settings: apiSettings({ baseUrl: 'https://x.test/v1/', voice: null, apiKey: '' })
    })
  )
  assert.equal(calls[0].url, 'https://x.test/v1/audio/speech')
  const headers = calls[0].init?.headers as Record<string, string>
  assert.equal(headers.Authorization, undefined)
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.response_format, 'wav')
  assert.equal('voice' in body, false)
})

test('tts api: erros legíveis — 401 auth, 429 quota, 500 http com corpo resumido, 400 com detail', async () => {
  const cases: { status: number; body: string; kind: string; re: RegExp }[] = [
    {
      status: 401,
      body: '{"error":{"message":"bad key"}}',
      kind: 'auth',
      re: /chave de API inválida/
    },
    {
      status: 429,
      body: '{"error":{"message":"rate limit"}}',
      kind: 'quota',
      re: /limite de uso\/cota/
    },
    {
      status: 500,
      body: '{"error":{"message":"explodiu"}}',
      kind: 'http',
      re: /HTTP 500 .*explodiu/
    },
    { status: 400, body: '{"detail":"voz desconhecida"}', kind: 'http', re: /voz desconhecida/ }
  ]
  for (const c of cases) {
    const { fetch } = mockFetch(() => ({
      status: c.status,
      body: c.body,
      contentType: 'application/json'
    }))
    await withFetch(fetch, async () => {
      await assert.rejects(synthesize({ text: 'oi', settings: apiSettings() }), (e: unknown) => {
        assert.ok(e instanceof TtsError, `instância de TtsError (${c.status})`)
        assert.equal(e.kind, c.kind)
        assert.equal(e.status, c.status)
        assert.equal(e.backend, 'api')
        assert.match(e.message, c.re)
        return true
      })
    })
  }
})

test('tts api: resposta 2xx sem áudio (JSON ou corpo vazio) → erro http legível', async () => {
  const json = mockFetch(() => ({ body: '{"ok":true}', contentType: 'application/json' }))
  await withFetch(json.fetch, () =>
    assert.rejects(synthesize({ text: 'oi', settings: apiSettings() }), /resposta da API sem áudio/)
  )
  const empty = mockFetch(() => ({ body: new Uint8Array(0) }))
  await withFetch(empty.fetch, () =>
    assert.rejects(synthesize({ text: 'oi', settings: apiSettings() }), /corpo vazio/)
  )
})

test('tts api: rede, timeout e abort (AbortError nunca vira TtsError)', async () => {
  const failing = ((url: unknown) => {
    void url
    return Promise.reject(new TypeError('fetch failed'))
  }) as typeof fetch
  await withFetch(failing, () =>
    assert.rejects(
      synthesize({ text: 'oi', settings: apiSettings() }),
      (e: unknown) => e instanceof TtsError && e.kind === 'network'
    )
  )
  // timeout: fetch pendurado + timeoutMs curtíssimo
  await withFetch(hangingFetch(), () =>
    assert.rejects(
      synthesize({ text: 'oi', settings: apiSettings() }, { timeoutMs: 20 }),
      (e: unknown) => e instanceof TtsError && e.kind === 'timeout'
    )
  )
  // abort do chamador: AbortError cru (nunca TtsError)
  const controller = new AbortController()
  await withFetch(hangingFetch(), async () => {
    const p = synthesize({ text: 'oi', settings: apiSettings() }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError')
  })
})

test('tts api: config — sem baseUrl, sem modelo e texto vazio', async () => {
  await assert.rejects(
    synthesize({ text: 'oi', settings: apiSettings({ baseUrl: '' }) }),
    (e: unknown) =>
      e instanceof TtsError && e.kind === 'config' && /nenhum provedor de fala/.test(e.message)
  )
  await assert.rejects(
    synthesize({ text: 'oi', settings: apiSettings({ model: '' }) }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config' && /modelo/.test(e.message)
  )
  await assert.rejects(
    synthesize({ text: '   ', settings: apiSettings() }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config' && /vazio/.test(e.message)
  )
})

// ---------------- motor local ----------------

test('tts local: despacha para o motor injetado com voz/formato e devolve backend local', async () => {
  const { backend, calls } = fakeEngine({ model: 'kokoro-onnx-q8' })
  const r = await synthesize(
    { text: 'Uhum.', settings: localSettings(), format: 'wav' },
    { local: backend }
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0].text, 'Uhum.')
  assert.equal(calls[0].voice, 'pf_dora')
  assert.equal(calls[0].format, 'wav')
  assert.equal(r.backend, 'local')
  assert.equal(r.model, 'kokoro-onnx-q8')
  assert.equal(r.mime, 'audio/wav')
  assert.deepEqual([...r.audio], [0, 1, 2, 3])
})

test('tts local: sem motor → config legível; backend local sem `local` nas settings → config', async () => {
  await assert.rejects(
    synthesize({ text: 'oi', settings: localSettings() }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config' && /motor local/.test(e.message)
  )
  const { backend } = fakeEngine()
  const semLocal = normalizeTtsSettings({ backend: 'local', local: null })
  await assert.rejects(
    synthesize({ text: 'oi', settings: semLocal }, { local: backend }),
    (e: unknown) => e instanceof TtsError && e.kind === 'config'
  )
})

test('tts: frase de demonstração definida e timeout padrão de 60 s', () => {
  assert.ok(TTS_TEST_PHRASE.trim().length > 0)
  assert.equal(TTS_DEFAULT_TIMEOUT_MS, 60_000)
  assert.equal(DEFAULT_TTS_SETTINGS.backend, 'local')
})

// ---------------- fonemas do Kokoro (helpers puros) ----------------

test('mapEspeakPhonemes: ties (ZWJ/U+0361), dífonos do misaki, hífens e NFD', () => {
  // tie ^ (ZWJ do --ipa=3): t^ʃ vira ʧ (mapeamento do misaki EspeakG2P)
  assert.equal(mapEspeakPhonemes('t\u200dʃi'), 'ʧi')
  assert.equal(mapEspeakPhonemes('t\u0361ʃi'), 'ʧi')
  for (const [from, to] of ESPEAK_E2M) {
    assert.equal(mapEspeakPhonemes(from), to, `dífono ${from} → ${to}`)
  }
  // ties/hífens sobrando somem
  assert.equal(mapEspeakPhonemes('a^b-c'), 'abc')
  // 'ũ' pré-composto vira u + til combinante (o vocabulário é por caractere)
  assert.equal(mapEspeakPhonemes('ũ'), 'u\u0303')
  // equivalência com a saída real do espeak-ng pt-br (validada no spike)
  assert.equal(mapEspeakPhonemes('ol\u02c8a, \u02c8ist\u0283i'), 'ol\u02c8a, \u02c8ist\u0283i')
})

test('kokoroInputIds: vocabulário char-level, chars desconhecidos caem, truncamento em 509', () => {
  // vocabulário de referência (tokenizer.json da conversão ONNX)
  assert.equal(KOKORO_VOCAB['$'], 0)
  assert.equal(KOKORO_VOCAB.a, 43)
  assert.equal(KOKORO_VOCAB['\u02c8'], 156) // estresse primário
  assert.equal(KOKORO_VOCAB['\u02a7'], 133) // ʧ
  assert.equal(Object.keys(KOKORO_VOCAB).length, 115)
  // ids por caractere, na ordem; desconhecidos descartados (como o vocab.get do model.py)
  assert.deepEqual(kokoroInputIds('ab'), [43, 44])
  assert.deepEqual(kokoroInputIds('a\u4e16b'), [43, 44])
  assert.deepEqual(kokoroInputIds(''), [])
  // o pad das bordas ([0, *ids, 0]) é aplicado pelo motor — aqui não entra
  assert.deepEqual(kokoroInputIds('a'), [43])
  // truncamento
  assert.equal(kokoroInputIds('a'.repeat(600)).length, 509)
})

// ---------------- correções: corpo sob timeout, espeak-ng com `--`, sessão que falhou ----------------

test('tts api: timeout DURANTE a leitura do corpo vira TtsError timeout (não erro cru)', async () => {
  // cabeçalhos chegam na hora; o corpo nunca termina (até o signal abortar)
  const stalled = ((_url: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        init?.signal?.addEventListener('abort', () =>
          c.error(new DOMException('aborted', 'AbortError'))
        )
      }
    })
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'audio/wav' } })
    )
  }) as typeof fetch
  await withFetch(stalled, () =>
    assert.rejects(
      synthesize({ text: 'oi', settings: apiSettings() }, { timeoutMs: 30 }),
      (e: unknown) => e instanceof TtsError && e.kind === 'timeout'
    )
  )
})

test('phonemizeText: o texto vai depois de `--` (texto com "-" nunca vira opção do espeak-ng)', async () => {
  const calls: string[][] = []
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls.push([cmd, ...args])
    return 'ˈite‍ɪŋ'
  }
  await phonemizeText('- item um, -f/etc/passwd', run)
  assert.ok(calls.length >= 2)
  for (const c of calls) {
    assert.equal(c[0], 'espeak-ng')
    const dd = c.indexOf('--')
    assert.ok(dd > 0 && dd === c.length - 2, `"--" logo antes do texto: ${JSON.stringify(c)}`)
  }
  assert.equal(calls[0][calls[0].length - 1], '- item um')
  assert.equal(calls[1][calls[1].length - 1], ' -f/etc/passwd')
})

const espeakPresent = ((): boolean => {
  try {
    execFileSync('espeak-ng', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test(
  'phonemizeText REAL: "- item", "-f/arquivo" e "-wfile" fonemizam o texto (espeak-ng do sistema)',
  { skip: espeakPresent ? false : 'espeak-ng não instalado' },
  async () => {
    const run = async (cmd: string, args: string[]): Promise<string> =>
      execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const dash = await phonemizeText('- item um', run)
    assert.match(dash, /it/, 'a frase com "- " não é descartada')
    const f = await phonemizeText('-f/etc/hostname', run)
    assert.ok(f.length > 0 && !f.includes('\n'), 'não leu o arquivo: fonemizou o texto')
    const w = await phonemizeText('-wfile', run)
    assert.ok(w.length > 0, 'não ficou esperando o stdin')
  }
)

test('espeak-ng ausente: dica de instalação por plataforma (Linux sem citar só o pacman)', () => {
  const linux = espeakInstallHint('linux')
  assert.match(linux, /gerenciador de pacotes/)
  assert.match(linux, /apt/)
  assert.match(linux, /dnf/)
  assert.match(espeakInstallHint('darwin'), /brew install espeak-ng/)
  assert.match(espeakInstallHint('win32'), /PATH/)
})

test('kokoro: sessão ONNX que falhou ao criar não fica em cache (a próxima síntese tenta de novo)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'kokoro-cache-'))
  try {
    // modelo + voz "instalados": arquivo + registro no manifest com o mesmo tamanho (a checagem de
    // lista é barata — tamanho do registro; artefatos de TTS não têm magic)
    const dir = join(base, 'models')
    mkdirSync(dir, { recursive: true })
    const manifest: Record<string, unknown> = {}
    for (const id of ['kokoro-onnx', 'kokoro-voice-pf-dora']) {
      const file = catalogFileName(findCatalogEntry(id)!)!
      writeFileSync(join(dir, file), new Uint8Array(2048))
      manifest[id] = { version: '1', file, sha256: null, size: 2048, installedAt: '' }
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    let creates = 0
    const engine = createKokoroEngine({
      baseDir: base,
      run: async () => 'a',
      createSession: async () => {
        creates++
        throw new Error('onnx quebrou')
      }
    })
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        engine.synthesize({ text: 'oi', voice: 'pf_dora', format: 'wav' }),
        /onnx quebrou/
      )
    assert.equal(creates, 2, 'a falha não ficou cacheada')
    await engine.release()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------------- adaptador PCM → WAV (OpenRouter: "expected one of mp3|pcm") + streaming ----------------

/** PCM16 LE de amostras inteiras. */
const pcm16 = (...samples: number[]): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const dv = new DataView(out.buffer)
  samples.forEach((v, i) => dv.setInt16(i * 2, v, true))
  return out
}
const wavInfo = (wav: Uint8Array): { riff: string; rate: number; ch: number; data: number[] } => {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const data: number[] = []
  for (let o = 44; o + 1 < wav.length; o += 2) data.push(dv.getInt16(o, true))
  return {
    riff: String.fromCharCode(...wav.subarray(0, 4)) + String.fromCharCode(...wav.subarray(8, 12)),
    rate: dv.getUint32(24, true),
    ch: dv.getUint16(22, true),
    data
  }
}

test('tts api: OpenRouter pede pcm (nunca wav) e o PCM cru vira WAV com a taxa do content-type', async () => {
  resetTtsPcmEndpoints()
  const { calls, fetch } = mockFetch(() => ({
    body: pcm16(1, -2, 300),
    contentType: 'audio/pcm;rate=24000;channels=1'
  }))
  const r = await withFetch(fetch, () =>
    synthesize({
      text: 'Olá',
      settings: apiSettings({
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'elevenlabs/eleven-flash-v2.5',
        voice: 'sarah'
      })
    })
  )
  assert.equal(calls.length, 1)
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.response_format, 'pcm')
  assert.equal(body.voice, 'sarah', 'voz curta passa como está')
  assert.equal(r.mime, 'audio/wav')
  const w = wavInfo(r.audio)
  assert.equal(w.riff, 'RIFFWAVE')
  assert.equal(w.rate, 24000)
  assert.equal(w.ch, 1)
  assert.deepEqual(w.data, [1, -2, 300])
  // mp3 pedido segue mp3 (o OpenRouter aceita)
  const mp3 = mockFetch(() => ({ body: new Uint8Array([7]), contentType: 'audio/mpeg' }))
  await withFetch(mp3.fetch, () =>
    synthesize({
      text: 'oi',
      settings: apiSettings({ baseUrl: 'https://openrouter.ai/api/v1' }),
      format: 'mp3'
    })
  )
  assert.equal(JSON.parse(String(mp3.calls[0].init?.body)).response_format, 'mp3')
})

test('tts api: 400 que recusa wav citando pcm → repete UMA vez com pcm, embrulha e lembra o endpoint', async () => {
  resetTtsPcmEndpoints()
  const base = 'https://speech.example/v1'
  assert.equal(ttsEndpointWantsPcm(base), false)
  const { calls, fetch } = mockFetch((_url, init) => {
    const fmt = JSON.parse(String(init?.body)).response_format
    return fmt === 'wav'
      ? {
          status: 400,
          body: '{"error":{"message":"Invalid option: expected one of \\"mp3\\"|\\"pcm\\""}}',
          contentType: 'application/json'
        }
      : { body: pcm16(5, 6), contentType: 'audio/pcm;rate=44100' }
  })
  const r = await withFetch(fetch, () =>
    synthesize({ text: 'oi', settings: apiSettings({ baseUrl: base }) })
  )
  assert.deepEqual(
    calls.map((c) => JSON.parse(String(c.init?.body)).response_format),
    ['wav', 'pcm']
  )
  assert.equal(wavInfo(r.audio).rate, 44100)
  assert.deepEqual(wavInfo(r.audio).data, [5, 6])
  assert.equal(ttsEndpointWantsPcm(base), true)
  // a próxima já pede pcm (sem a request perdida)
  await withFetch(fetch, () =>
    synthesize({ text: 'de novo', settings: apiSettings({ baseUrl: base }) })
  )
  assert.equal(calls.length, 3)
  assert.equal(JSON.parse(String(calls[2].init?.body)).response_format, 'pcm')
  resetTtsPcmEndpoints()
})

test('tts api: 400 sem menção a pcm não repete (erro http legível); pcm sempre recusado → 1 retry só', async () => {
  resetTtsPcmEndpoints()
  const plain = mockFetch(() => ({
    status: 400,
    body: '{"error":{"message":"voice not found"}}',
    contentType: 'application/json'
  }))
  await withFetch(plain.fetch, () =>
    assert.rejects(synthesize({ text: 'oi', settings: apiSettings() }), (e: unknown) => {
      assert.ok(e instanceof TtsError)
      assert.equal(e.kind, 'http')
      assert.match(e.message, /voice not found/)
      return true
    })
  )
  assert.equal(plain.calls.length, 1)
  const always = mockFetch(() => ({
    status: 400,
    body: 'expected one of mp3|pcm',
    contentType: 'text/plain'
  }))
  await withFetch(always.fetch, () =>
    assert.rejects(synthesize({ text: 'oi', settings: apiSettings() }), /HTTP 400/)
  )
  assert.equal(always.calls.length, 2, 'repete uma vez, não em laço')
  resetTtsPcmEndpoints()
})

test('tts api: PCM estéreo vira mono (média) e byte ímpar sobrando é descartado', async () => {
  resetTtsPcmEndpoints()
  const stereo = new Uint8Array([...pcm16(100, 300, -10, -30), 0x7f])
  const { fetch } = mockFetch(() => ({
    body: stereo,
    contentType: 'audio/pcm; rate=16000; channels=2'
  }))
  const r = await withFetch(fetch, () =>
    synthesize({ text: 'oi', settings: apiSettings({ baseUrl: 'https://openrouter.ai/api/v1' }) })
  )
  const w = wavInfo(r.audio)
  assert.equal(w.rate, 16000)
  assert.deepEqual(w.data, [200, -20])
})

/** fetch cujo corpo chega em pedaços (ReadableStream) com os cortes dados. */
function chunkedFetch(parts: Uint8Array[], contentType: string, gapMs = 0): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        for (const p of parts) {
          if (gapMs) await new Promise((r) => setTimeout(r, gapMs))
          if (init?.signal?.aborted) {
            ctrl.error(new DOMException('aborted', 'AbortError'))
            return
          }
          ctrl.enqueue(p)
        }
        ctrl.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'content-type': contentType } })
  }) as typeof fetch
}

test('tts api: assinatura de app do pedido (`api.appHeaders`) vai no /audio/speech (síntese, stream e bloco) — como nas requests do chat', async () => {
  // bug (uso real, 2026-11-14): a fala do Fish Audio pelo OpenRouter (clipes e frases da chamada)
  // aparecia como app "Unknown" na atividade — as requests de voz não levavam HTTP-Referer/X-Title
  const { appSignatureHeadersOf } = await import('../src/shared/appSignatures.ts')
  const { synthesizeBlock } = await import('../src/main/voice/tts.ts')
  const pcm = new Uint8Array([1, 0, 2, 0])
  const { calls, fetch } = mockFetch(() => ({ body: pcm, contentType: 'audio/pcm;rate=24000' }))
  const cline = withAppHeaders(apiSettings(), appSignatureHeadersOf({ appSignature: 'cline' }))
  await withFetch(fetch, async () => {
    await synthesize({ text: 'oi', settings: cline, format: 'wav' })
    const st = await synthesizeStream({ text: 'oi', settings: cline })
    if (st.streaming) for await (const c of st.chunks) void c
    await synthesizeBlock({ text: 'oi', settings: cline })
    // sem contexto: a padrão; 'none' e sem o campo: nada
    await synthesize({
      text: 'oi',
      settings: withAppHeaders(apiSettings(), appSignatureHeadersOf())
    })
    await synthesize({
      text: 'oi',
      settings: withAppHeaders(apiSettings(), appSignatureHeadersOf({ appSignature: 'none' }))
    })
    await synthesize({ text: 'oi', settings: apiSettings() })
    // nunca sobrescreve a chave nem o Content-Type
    await synthesize({
      text: 'oi',
      settings: withAppHeaders(apiSettings(), {
        'X-Title': 'X',
        Authorization: 'Bearer roubada',
        'Content-Type': 'text/plain'
      })
    })
  })
  const h = (i: number): Record<string, string> => calls[i].init?.headers as Record<string, string>
  for (const i of [0, 1, 2]) {
    assert.equal(calls[i].url, 'https://tts.example/v1/audio/speech')
    assert.equal(h(i)['HTTP-Referer'], 'https://cline.bot', `request ${i}`)
    assert.equal(h(i)['X-Title'], 'Cline')
    assert.equal(h(i).Authorization, 'Bearer sk-test')
  }
  assert.equal(h(3)['X-Title'], 'ClearChat')
  assert.equal(h(3)['HTTP-Referer'], 'https://github.com/ezenere/clearchat')
  for (const i of [4, 5]) {
    assert.equal(h(i)['HTTP-Referer'], undefined)
    assert.equal(h(i)['X-Title'], undefined)
  }
  assert.equal(h(6).Authorization, 'Bearer sk-test')
  assert.equal(h(6)['Content-Type'], 'application/json')
})

test('synthesizeStream: PCM progressivo sai em pedaços alinhados (cortes no meio da amostra) + WAV completo', async () => {
  resetTtsPcmEndpoints()
  const all = pcm16(1, 2, 3, 4, 5)
  const parts = [all.subarray(0, 3), all.subarray(3, 4), all.subarray(4, 10)]
  const settings = apiSettings({ baseUrl: 'https://openrouter.ai/api/v1' })
  const s = await withFetch(chunkedFetch(parts, 'audio/pcm;rate=24000;channels=1'), () =>
    synthesizeStream({ text: 'oi', settings })
  )
  assert.equal(s.streaming, true)
  if (!s.streaming) return
  assert.equal(s.sampleRate, 24000)
  const got: number[][] = []
  for await (const c of s.chunks) {
    assert.equal(c.length % 2, 0, 'pedaço em amostras inteiras')
    got.push([...new Int16Array(c.slice().buffer)])
  }
  assert.deepEqual(got.flat(), [1, 2, 3, 4, 5])
  assert.ok(got.length >= 2, 'chegou em mais de um pedaço')
  // collectPcmStream junta num WAV
  const s2 = await withFetch(chunkedFetch(parts, 'audio/pcm;rate=24000'), () =>
    synthesizeStream({ text: 'oi', settings })
  )
  assert.equal(s2.streaming, true)
  if (!s2.streaming) return
  const full = await collectPcmStream(s2)
  assert.deepEqual(wavInfo(full.audio).data, [1, 2, 3, 4, 5])
  assert.equal(full.mime, 'audio/wav')
})

test('synthesizeStream: wav/mp3 e motor local → bytes completos (streaming: false); abort no meio → AbortError', async () => {
  resetTtsPcmEndpoints()
  const wav = mockFetch(() => ({ body: new Uint8Array([1, 2]), contentType: 'audio/wav' }))
  const r = await withFetch(wav.fetch, () =>
    synthesizeStream({ text: 'oi', settings: apiSettings() })
  )
  assert.equal(r.streaming, false)
  if (!r.streaming) assert.deepEqual([...r.result.audio], [1, 2])
  const eng = fakeEngine()
  const loc = await synthesizeStream(
    { text: 'oi', settings: localSettings() },
    { local: eng.backend }
  )
  assert.equal(loc.streaming, false)
  assert.equal(eng.calls[0].format, 'wav')
  // abort depois do 1º pedaço: o iterador rejeita com AbortError (nunca TtsError)
  const ac = new AbortController()
  const parts = Array.from({ length: 20 }, (_, i) => pcm16(i))
  const s = await withFetch(chunkedFetch(parts, 'audio/pcm;rate=24000', 5), () =>
    synthesizeStream(
      { text: 'oi', settings: apiSettings({ baseUrl: 'https://openrouter.ai/api/v1' }) },
      { signal: ac.signal }
    )
  )
  assert.equal(s.streaming, true)
  if (!s.streaming) return
  await assert.rejects(
    (async () => {
      for await (const c of s.chunks) if (c.length) ac.abort()
    })(),
    (e: Error) => e.name === 'AbortError'
  )
})
