// Parâmetros dos modelos de voz REMOTOS (`@shared/voiceParams` + o envio no main): specs por
// família/modelo (ElevenLabs direto, OpenRouter, OpenAI-compatível), normalização em
// `api.params[família]`, o corpo REST e o 1º frame do WebSocket da ElevenLabs (`voice_settings`,
// `apply_text_normalization`), o formato de saída escolhido (taxa do WAV/stream; 403
// `output_format_not_allowed` → erro de configuração legível, fatal na chamada — sem sondagem nem
// troca automática), o `auto_mode` (URL + só frases inteiras), `speed`/`instructions` no
// `/audio/speech` e `temperature`/`prompt` no `/audio/transcriptions` só quando o modelo aceita, e o
// hash dos clipes. Servidor FAKE da ElevenLabs (`e2e/fakes/elevenlabsFake.mjs`) e fetch mockado —
// sem rede, sem chave real.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceParams.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_STT_SETTINGS,
  normalizeSttSettings,
  normalizeTtsSettings,
  type SttSettings,
  type TtsSettings
} from '@shared/voice'
import {
  apiParamSpecs,
  apiParamsToSend,
  clearVoiceApiParams,
  elevenLabsOutputFormat,
  normalizeVoiceApiParams,
  pcmFormatLabel,
  pcmFormatRate,
  setVoiceApiParam
} from '@shared/voiceParams'
import {
  elevenLabsConfig,
  elevenLabsError,
  elevenLabsErrorDetail
} from '../src/main/voice/elevenlabs.ts'
import {
  ElevenLabsCallTts,
  elevenLabsCallOptions,
  elevenLabsWsUrl
} from '../src/main/voice/elevenlabsStream.ts'
import { synthesize, synthesizeStream, TtsError } from '../src/main/voice/tts.ts'
import { transcribeAudio } from '../src/main/voice/stt.ts'
import { classifyVoiceError } from '../src/main/voice/callErrors.ts'
import { clipsHash } from '../src/main/voice/clips.ts'
import { startElevenLabsFake } from './fakes/elevenlabsFake.mjs'

const KEY = 'test-key'
const SARAH = 'EXAVITQu4vr4xnSDxMaL'
const PRO_403 =
  '{"detail":{"type":"authorization_error","code":"subscription_required","message":"Output format \'pcm_44100\' is only available on the Pro tier and above.","status":"output_format_not_allowed","request_id":"x"}}'
const PRO_MSG =
  'O formato de saída 44,1 kHz exige o plano Pro da ElevenLabs — escolha outro formato em Configurações → Áudio → Parâmetros'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await sleep(5)
  }
}
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const c of chunks) parts.push(c)
  return Buffer.concat(parts)
}

/** `ttsSettings` de ElevenLabs direto como o main resolve (base/chave/tipo fora da gravação). */
const elTts = (
  baseUrl: string,
  params?: unknown,
  over: Record<string, unknown> = {}
): TtsSettings => {
  const s = normalizeTtsSettings({
    backend: 'api',
    api: { providerId: 'p-el', model: 'eleven_flash_v2_5', voice: SARAH, params, ...over }
  })
  return { ...s, api: { ...s.api, baseUrl, apiKey: KEY, providerKind: 'elevenlabs' } }
}

// ---------------- specs/normalização ----------------

test('specs por modelo: ElevenLabs (auto_mode só com WebSocket; style só v2+), OpenRouter por id, STT', () => {
  const keys = (
    cap: 'tts' | 'stt',
    f: Parameters<typeof apiParamSpecs>[1],
    m: string,
    ws = false
  ): string[] => apiParamSpecs(cap, f, m, { ws }).map((s) => s.key)
  assert.deepEqual(keys('tts', 'elevenlabs', 'eleven_flash_v2_5', true), [
    'output_format',
    'stability',
    'similarity_boost',
    'style',
    'use_speaker_boost',
    'speed',
    'apply_text_normalization',
    'auto_mode'
  ])
  assert.ok(!keys('tts', 'elevenlabs', 'eleven_v4_turbo').includes('auto_mode'), 'sem WS')
  assert.ok(!keys('tts', 'elevenlabs', 'eleven_monolingual_v1').includes('style'), 'v1 sem style')
  // OpenRouter: speed só nos modelos com controle (faixa do modelo); instructions só nos que seguem
  const orEl = apiParamSpecs('tts', 'openrouter', 'elevenlabs/eleven-flash-v2.5')
  assert.deepEqual(
    orEl.map((s) => [s.key, s.min, s.max]),
    [['speed', 0.7, 1.2]]
  )
  assert.deepEqual(keys('tts', 'openrouter', 'fish-audio/s1'), ['instructions'])
  assert.deepEqual(keys('tts', 'openrouter', 'google/gemini-3.8-flash-tts'), ['instructions'])
  assert.deepEqual(keys('tts', 'openrouter', 'hexgrad/kokoro-82m'), [], 'sem parâmetro: nada')
  assert.deepEqual(keys('tts', 'openai', 'tts-1'), ['speed'])
  assert.deepEqual(keys('tts', 'openai', 'gpt-4o-mini-tts'), ['speed', 'instructions'])
  assert.deepEqual(keys('stt', 'openrouter', 'openai/whisper-large-v3-turbo'), ['temperature'])
  assert.deepEqual(keys('stt', 'openai', 'whisper-large-v3-turbo'), ['temperature', 'prompt'])
  assert.deepEqual(keys('stt', 'elevenlabs', 'x'), [])
  assert.deepEqual(apiParamSpecs('tts', null, 'x'), [])
})

test('normalização: só os válidos e diferentes do padrão, por família; vazio → a chave sai', () => {
  const p = normalizeVoiceApiParams('tts', {
    elevenlabs: {
      output_format: 'pcm_44100',
      stability: 0.4,
      speed: 9, // limitado à faixa (0,7–1,2)
      style: 'x', // lixo
      apply_text_normalization: 'auto', // padrão → sai
      auto_mode: false, // padrão → sai
      inventado: 1
    },
    openrouter: { speed: 1.1, instructions: '  calma  ' },
    openai: {},
    lixo: { a: 1 }
  })
  assert.deepEqual(p, {
    elevenlabs: { output_format: 'pcm_44100', stability: 0.4, speed: 1.2 },
    openrouter: { speed: 1.1, instructions: 'calma' }
  })
  assert.equal(
    normalizeVoiceApiParams('tts', { elevenlabs: { output_format: 'pcm_24000' } }),
    undefined
  )
  assert.equal(normalizeVoiceApiParams('tts', 'x'), undefined)
  // set/clear
  const s1 = setVoiceApiParam('tts', 'elevenlabs', undefined, 'stability', 0.3)
  assert.deepEqual(s1, { elevenlabs: { stability: 0.3 } })
  assert.equal(setVoiceApiParam('tts', 'elevenlabs', s1, 'stability', null), undefined)
  assert.deepEqual(clearVoiceApiParams('tts', 'elevenlabs', p), { openrouter: p!.openrouter })
  // nos normalizadores das settings: aditivo
  const tts = normalizeTtsSettings({ backend: 'api', api: { model: 'm', params: p } })
  assert.deepEqual(tts.api.params, p)
  assert.equal('params' in normalizeTtsSettings({ backend: 'api', api: { model: 'm' } }).api, false)
  const stt = normalizeSttSettings({
    mode: 'api',
    api: {
      providerId: 'g',
      model: 'w',
      params: { openai: { temperature: 0.2, prompt: 'ClearChat' } }
    }
  })
  assert.deepEqual(stt.api.params, { openai: { temperature: 0.2, prompt: 'ClearChat' } })
  assert.equal('params' in DEFAULT_STT_SETTINGS.api, false)
  // envio: só o que o modelo aceita, na faixa do modelo
  assert.deepEqual(
    apiParamsToSend('tts', 'openrouter', 'elevenlabs/eleven-flash-v2.5', {
      openrouter: { speed: 2, instructions: 'x' }
    }),
    { speed: 1.2 }
  )
  assert.deepEqual(
    apiParamsToSend('tts', 'openrouter', 'fish-audio/s1', { openrouter: { speed: 2 } }),
    {}
  )
  // Fish Audio Drama 3/S2: `speed` medido (2026-11-14), faixa 0,5–2
  assert.deepEqual(
    apiParamsToSend('tts', 'openrouter', 'fish-audio/drama-3', { openrouter: { speed: 3 } }),
    { speed: 2 }
  )
  assert.deepEqual(
    apiParamsToSend('tts', 'openrouter', 'fish-audio/s2.1-pro', { openrouter: { speed: 0.8 } }),
    { speed: 0.8 }
  )
  // formato
  assert.equal(elevenLabsOutputFormat(undefined), 'pcm_24000')
  assert.equal(elevenLabsOutputFormat({ elevenlabs: { output_format: 'pcm_16000' } }), 'pcm_16000')
  assert.equal(pcmFormatRate('pcm_44100'), 44100)
  assert.equal(pcmFormatRate('mp3_44100_128'), 24000)
  assert.equal(pcmFormatLabel('pcm_22050'), '22,05 kHz')
})

// ---------------- ElevenLabs REST ----------------

test('REST: voice_settings + apply_text_normalization no corpo; formato escolhido na URL e na taxa do WAV', async () => {
  const fake = await startElevenLabsFake()
  try {
    const r = await synthesize({
      text: 'Olá, teste.',
      settings: elTts(fake.url, {
        elevenlabs: {
          output_format: 'pcm_16000',
          speed: 1.1,
          stability: 0.4,
          apply_text_normalization: 'off'
        }
      })
    })
    assert.equal(Buffer.from(r.audio).readUInt32LE(24), 16000, 'taxa do WAV = a do formato')
    const req = fake.requests.find((q) => q.method === 'POST')!
    assert.equal(req.query.output_format, 'pcm_16000')
    assert.deepEqual(JSON.parse(req.body), {
      text: 'Olá, teste.',
      model_id: 'eleven_flash_v2_5',
      language_code: 'pt',
      voice_settings: { stability: 0.4, speed: 1.1 },
      apply_text_normalization: 'off'
    })
    // sem parâmetros: nada de voice_settings (vale o da voz na conta), 24 kHz
    fake.requests.length = 0
    const r2 = await synthesize({ text: 'Oi.', settings: elTts(fake.url) })
    assert.equal(Buffer.from(r2.audio).readUInt32LE(24), 24000)
    const body = JSON.parse(fake.requests.find((q) => q.method === 'POST')!.body)
    assert.equal(body.voice_settings, undefined)
    assert.equal(body.apply_text_normalization, undefined)
    // streaming por sentença (modelo sem WS) segue a taxa do formato
    const s = await synthesizeStream({
      text: 'Frase.',
      settings: elTts(
        fake.url,
        { elevenlabs: { output_format: 'pcm_44100' } },
        { model: 'eleven_v4_turbo' }
      )
    })
    assert.ok(s.streaming)
    if (s.streaming) {
      assert.equal(s.sampleRate, 44100)
      await collect(s.chunks)
    }
    assert.deepEqual(fake.protocolErrors, [])
  } finally {
    await fake.close()
  }
})

test('REST: formato fora do plano (403 output_format_not_allowed) → TtsError config com a mensagem pt-BR; fatal na chamada', async () => {
  const fake = await startElevenLabsFake({ planTier: 'creator' })
  try {
    let err: unknown = null
    await synthesize({
      text: 'Oi.',
      settings: elTts(fake.url, { elevenlabs: { output_format: 'pcm_44100' } })
    }).catch((e) => (err = e))
    assert.ok(err instanceof TtsError)
    assert.equal(err.kind, 'config')
    assert.equal(err.status, 403)
    assert.equal(err.message, PRO_MSG)
    // uma request só: sem sondagem nem troca automática de formato
    assert.equal(fake.requests.filter((q) => q.method === 'POST').length, 1)
    // 24 kHz continua funcionando na mesma conta
    await synthesize({ text: 'Oi.', settings: elTts(fake.url) })
    const f = classifyVoiceError(err, 'tts', 'ElevenLabs')!
    assert.equal(f.fatal, true)
    assert.equal(f.reason, PRO_MSG)
  } finally {
    await fake.close()
  }
  // o corpo exato da API (verificado na conta real) → a mesma mensagem
  const d = elevenLabsErrorDetail(PRO_403)
  const e = elevenLabsError({ status: 403, message: d.message, code: d.status }, 'síntese')
  assert.equal(e.kind, 'config')
  assert.equal(e.message, PRO_MSG)
  // 403 de chave continua `auth`
  assert.equal(elevenLabsError({ status: 403, message: 'missing_permissions' }).kind, 'auth')
})

// ---------------- ElevenLabs WebSocket ----------------

test('WS: voice_settings no 1º frame de cada contexto; formato na URL e na taxa do stream; auto_mode na URL', async () => {
  const fake = await startElevenLabsFake()
  const settings = elTts(fake.url, {
    elevenlabs: { output_format: 'pcm_22050', stability: 0.35, use_speaker_boost: false }
  })
  const el = new ElevenLabsCallTts({ config: () => elevenLabsCallOptions(settings) })
  try {
    el.begin()
    el.partial('Olá meu ami')
    el.cut('Olá meu amigo.')
    const s = el.synth('Olá meu amigo.')
    el.end()
    assert.equal(s.sampleRate, 22050)
    await collect(s.chunks)
    const conn = fake.connections[0]
    assert.equal(conn.query.output_format, 'pcm_22050')
    assert.equal(conn.query.auto_mode, undefined)
    assert.deepEqual(conn.frames[0].voice_settings, { stability: 0.35, use_speaker_boost: false })
    assert.deepEqual(fake.protocolErrors, [])
  } finally {
    el.close()
    await fake.close()
  }
  // auto_mode: URL com auto_mode=true e texto só em frases inteiras (sem palavra a palavra)
  const fake2 = await startElevenLabsFake()
  const auto = elTts(fake2.url, { elevenlabs: { auto_mode: true, apply_text_normalization: 'on' } })
  const opts = elevenLabsCallOptions(auto)!
  const u = new URL(elevenLabsWsUrl(opts))
  assert.equal(u.searchParams.get('auto_mode'), 'true')
  assert.equal(u.searchParams.get('apply_text_normalization'), 'on')
  assert.equal(u.searchParams.get('output_format'), 'pcm_24000')
  const el2 = new ElevenLabsCallTts({ config: () => elevenLabsCallOptions(auto) })
  try {
    el2.begin()
    el2.partial('Olá meu ami')
    el2.partial('Olá meu amigo, tudo')
    el2.cut('Olá meu amigo, tudo bem?')
    const s2 = el2.synth('Olá meu amigo, tudo bem?')
    el2.end()
    await collect(s2.chunks)
    assert.deepEqual(
      fake2.textFrames().map((f: { text?: string; flush?: boolean }) => [f.text, !!f.flush]),
      [['Olá meu amigo, tudo bem? ', true]],
      'só a frase inteira, com flush'
    )
  } finally {
    el2.close()
    await fake2.close()
  }
  // desligado: sem auto_mode e o "Streaming por WebSocket" desligado não leva opções
  assert.equal(elevenLabsCallOptions(elTts('http://x', undefined, { elevenLabsWs: false })), null)
})

test('WS: formato fora do plano → erro de configuração legível (frame de erro do servidor)', async () => {
  const fake = await startElevenLabsFake({ planTier: 'creator' })
  const settings = elTts(fake.url, { elevenlabs: { output_format: 'pcm_44100' } })
  const el = new ElevenLabsCallTts({ config: () => elevenLabsCallOptions(settings) })
  try {
    el.begin()
    el.cut('Olá.')
    const s = el.synth('Olá.')
    el.end()
    const err = await collect(s.chunks).then(
      () => null,
      (e: unknown) => e
    )
    assert.ok(err instanceof TtsError, String(err))
    assert.equal(err.kind, 'config')
    assert.equal(err.message, PRO_MSG)
    await waitFor(() => fake.connections[0]?.closed)
  } finally {
    el.close()
    await fake.close()
  }
})

test('config: elevenLabsConfig traz formato/taxa/voice_settings/normalização/auto_mode dos parâmetros', () => {
  const cfg = elevenLabsConfig(
    elTts('https://api.elevenlabs.io', {
      elevenlabs: { output_format: 'pcm_48000', similarity_boost: 0.9, auto_mode: true }
    }).api
  )
  assert.equal(cfg.outputFormat, 'pcm_48000')
  assert.equal(cfg.sampleRate, 48000)
  assert.deepEqual(cfg.voiceSettings, { similarity_boost: 0.9 })
  assert.equal(cfg.textNormalization, null)
  assert.equal(cfg.autoMode, true)
  const plain = elevenLabsConfig(elTts('https://api.elevenlabs.io').api)
  assert.equal(plain.outputFormat, 'pcm_24000')
  assert.equal(plain.voiceSettings, null)
})

// ---------------- OpenRouter / OpenAI-compatível ----------------

/** fetch mockado: captura o corpo e devolve PCM curto. */
function mockSpeech(): { bodies: Record<string, unknown>[]; restore: () => void } {
  const real = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(new Uint8Array(4800), {
      status: 200,
      headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' }
    })
  }) as typeof fetch
  return { bodies, restore: () => void (globalThis.fetch = real) }
}

const apiTts = (
  baseUrl: string,
  providerKind: string,
  model: string,
  params: unknown
): TtsSettings => {
  const s = normalizeTtsSettings({
    backend: 'api',
    api: { providerId: 'p', model, voice: 'sarah', params }
  })
  return { ...s, api: { ...s.api, baseUrl, apiKey: 'k', providerKind } }
}

test('/audio/speech: speed/instructions só quando o modelo aceita (OpenRouter por id; OpenAI-compatível)', async () => {
  const m = mockSpeech()
  try {
    const OR = 'https://openrouter.ai/api/v1'
    const params = { openrouter: { speed: 1.15, instructions: 'calma' }, openai: { speed: 1.5 } }
    await synthesize({
      text: 'a',
      settings: apiTts(OR, 'openrouter', 'elevenlabs/eleven-flash-v2.5', params)
    })
    await synthesize({ text: 'a', settings: apiTts(OR, 'openrouter', 'fish-audio/s1', params) })
    await synthesize({
      text: 'a',
      settings: apiTts(OR, 'openrouter', 'hexgrad/kokoro-82m', params)
    })
    await synthesize({
      text: 'a',
      settings: apiTts('http://localhost:8880/v1', 'openai', 'kokoro', params)
    })
    const pick = (b: Record<string, unknown>): Record<string, unknown> => ({
      speed: b.speed,
      instructions: b.instructions
    })
    assert.deepEqual(m.bodies.map(pick), [
      { speed: 1.15, instructions: undefined },
      { speed: undefined, instructions: 'calma' },
      { speed: undefined, instructions: undefined },
      { speed: 1.5, instructions: undefined }
    ])
    // os campos do app nunca são sobrescritos por parâmetros
    assert.equal(m.bodies[0].model, 'elevenlabs/eleven-flash-v2.5')
  } finally {
    m.restore()
  }
})

test('/audio/transcriptions: temperature (OpenRouter/OpenAI) e prompt (OpenAI-compatível) no multipart', async () => {
  const real = globalThis.fetch
  const forms: FormData[] = []
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    forms.push(init?.body as FormData)
    return new Response(JSON.stringify({ text: 'oi' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  const stt = (baseUrl: string, providerKind: string, params: unknown): SttSettings => {
    const s = normalizeSttSettings({ mode: 'api', api: { providerId: 'p', model: 'w', params } })
    return { ...s, api: { ...s.api, baseUrl, apiKey: 'k', providerKind } }
  }
  try {
    const params = {
      openrouter: { temperature: 0.3 },
      openai: { temperature: 0.1, prompt: 'ClearChat, OpenRouter' }
    }
    const input = { audio: new Uint8Array(10), mimeType: 'audio/wav' }
    await transcribeAudio(input, {
      settings: stt('https://openrouter.ai/api/v1', 'openrouter', params)
    })
    await transcribeAudio(input, {
      settings: stt('https://api.groq.com/openai/v1', 'openai', params)
    })
    await transcribeAudio(input, {
      settings: stt('https://api.groq.com/openai/v1', 'openai', undefined)
    })
    assert.equal(forms[0].get('temperature'), '0.3')
    assert.equal(forms[0].get('prompt'), null, 'OpenRouter ignora prompt: não vai')
    assert.equal(forms[1].get('temperature'), '0.1')
    assert.equal(forms[1].get('prompt'), 'ClearChat, OpenRouter')
    assert.equal(forms[2].get('temperature'), null, 'sem parâmetro escolhido: nada')
  } finally {
    globalThis.fetch = real
  }
})

// ---------------- clipes ----------------

test('hash dos clipes: muda com o formato/voice_settings, não com o auto_mode; sem params = igual ao antigo', async () => {
  const base = elTts('https://api.elevenlabs.io')
  const h0 = await clipsHash(base)
  const hFmt = await clipsHash(
    elTts('https://api.elevenlabs.io', { elevenlabs: { output_format: 'pcm_44100' } })
  )
  const hAuto = await clipsHash(
    elTts('https://api.elevenlabs.io', { elevenlabs: { auto_mode: true } })
  )
  const hStab = await clipsHash(
    elTts('https://api.elevenlabs.io', { elevenlabs: { stability: 0.2 } })
  )
  assert.notEqual(h0, hFmt)
  assert.notEqual(h0, hStab)
  assert.equal(h0, hAuto)
})
