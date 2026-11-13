/* eslint-disable @typescript-eslint/no-explicit-any */
// Voz por persona/chat (protocolo 1.9.0 — `config.voice.tts`/`.stt`): normalizadores das escolhas,
// herança chat → persona → dispositivo, disponibilidade por backend (api/local/gpu) com os motivos
// do fallback, aplicar/extrair a escolha sobre as settings do dispositivo, o snapshot da persona no
// chat (sem a voz — herda ao vivo), as checagens do dispositivo do main (`voice/voiceCaps.ts`) com
// fakes, a chamada usando a voz do chat (gestor com motores fake), clipes por voz e os textos dos
// ícones esmaecidos. Nada de rede, microfone ou motor real. Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  applySttChoice,
  applyTtsChoice,
  layerVoiceCallConfig,
  normalizeSttSettings,
  normalizeTtsSettings,
  normalizeVoiceCallConfig,
  normalizeVoiceSttChoice,
  normalizeVoiceTtsChoice,
  resolveSttVoice,
  resolveTtsVoice,
  sttChoiceFromSettings,
  sttChoiceOf,
  sttSettingsCheck,
  ttsChoiceFromSettings,
  ttsChoiceOf,
  ttsSettingsCheck,
  type SttSettings,
  type TtsSettings,
  type VoiceCheck,
  type VoiceDeviceCaps,
  type VoiceSttChoice,
  type VoiceTtsChoice
} from '../src/shared/voice.ts'
import { applyPreset, sanitizePresetConfig } from '../src/shared/presets.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import type { AgentEvent } from '../src/shared/types.ts'

// ---------------- fixtures ----------------

const ELEVEN: VoiceTtsChoice = {
  backend: 'api',
  api: { providerId: 'xi', model: 'eleven_v3', voice: 'rachel' }
}
const KOKORO_MALE: VoiceTtsChoice = {
  backend: 'local',
  local: { engine: 'kokoro', voice: 'pm_alex' }
}
const GPU_CLONE: VoiceTtsChoice = {
  backend: 'gpu',
  gpu: { engine: 'xtts-v2', voice: 'user:voz-do-pc' }
}
const GROQ_EN: VoiceSttChoice = {
  mode: 'api',
  api: { providerId: 'groq', model: 'whisper-large-v3-turbo' },
  language: 'en-US'
}

/** Este dispositivo: Kokoro pf_dora + transcrição no Groq (pt-BR). */
const DEVICE_TTS: TtsSettings = normalizeTtsSettings({
  backend: 'local',
  local: { engine: 'kokoro', voice: 'pf_dora', installed: true },
  gpu: { engine: 'omnivoice', voice: null, steps: 32, params: { omnivoice: { speed: 0.9 } } }
})
const DEVICE_STT: SttSettings = normalizeSttSettings({
  mode: 'api',
  api: { providerId: 'groq', model: 'whisper-large-v3-turbo' },
  livePartials: false
})

/** Caps fake: provedores, vozes/modelos locais e GPU deste "dispositivo". */
function caps(
  over: {
    providers?: Record<string, 'tts' | 'stt' | 'both'>
    kokoroVoices?: string[]
    whisperModels?: string[]
    gpu?: { engines: string[]; voices: string[] } | null
  } = {}
): VoiceDeviceCaps & { calls: string[] } {
  const providers = over.providers ?? { xi: 'tts', groq: 'stt', or: 'both' }
  const kokoro = over.kokoroVoices ?? ['pf_dora']
  const whisper = over.whisperModels ?? ['ggml-base']
  const gpu = over.gpu === undefined ? null : over.gpu
  const calls: string[] = []
  const no = (reason: string): VoiceCheck => ({ ok: false, reason })
  return {
    calls,
    provider(id, cap) {
      calls.push(`provider:${id}:${cap}`)
      const p = providers[id]
      if (!p) return no('o provedor escolhido não existe neste dispositivo')
      return p === 'both' || p === cap ? { ok: true } : no(`o provedor “${id}” não serve ${cap}`)
    },
    ttsLocal({ engine, voice }) {
      calls.push(`ttsLocal:${engine}:${voice}`)
      if (engine !== 'kokoro') return no(`o motor ${engine} ainda não fala`)
      return kokoro.includes(voice)
        ? { ok: true }
        : no(`voz ${voice} não instalada neste dispositivo`)
    },
    sttLocal({ engine, model }) {
      calls.push(`sttLocal:${engine}:${model}`)
      return whisper.includes(model) || (!model && whisper.length)
        ? { ok: true }
        : no(`o modelo ${model} não está instalado neste dispositivo`)
    },
    ...(gpu
      ? {
          ttsGpu({ engine, voice }: { engine: string; voice: string | null }): VoiceCheck {
            if (!gpu.engines.includes(engine))
              return no(`o motor ${engine} não está instalado neste dispositivo`)
            return voice && !gpu.voices.includes(voice)
              ? no(`a voz “${voice}” não existe neste dispositivo`)
              : { ok: true }
          },
          sttGpu({ engine }: { engine: string }): VoiceCheck {
            return gpu.engines.includes(engine) ? { ok: true } : no('whisper da GPU não instalado')
          }
        }
      : {})
  }
}

const voice = (v: Record<string, unknown>): any => normalizeVoiceCallConfig(v)

// ---------------- normalizadores ----------------

test('normalizeVoiceTtsChoice: forma do protocolo — sem endereço/chave, GPU só motor+voz, lixo → null', () => {
  assert.deepEqual(
    normalizeVoiceTtsChoice({
      backend: 'api',
      api: {
        providerId: ' xi ',
        model: 'eleven_v3',
        voice: '',
        baseUrl: 'https://vaza',
        apiKey: 'sk-vazada',
        providerKind: 'elevenlabs',
        extraBody: { x: 1 },
        elevenLabsWs: true,
        params: { elevenlabs: { stability: 0.4, lixo: 1 }, openai: {} }
      }
    }),
    {
      backend: 'api',
      api: {
        providerId: 'xi',
        model: 'eleven_v3',
        voice: null,
        params: { elevenlabs: { stability: 0.4 } }
      }
    },
    'só provedor/modelo/voz/params; elevenLabsWs true some (ausente = WebSocket)'
  )
  assert.deepEqual(
    normalizeVoiceTtsChoice({
      backend: 'api',
      api: { providerId: 'xi', model: 'm', voice: 'v', elevenLabsWs: false }
    }),
    { backend: 'api', api: { providerId: 'xi', model: 'm', voice: 'v', elevenLabsWs: false } }
  )
  assert.equal(
    normalizeVoiceTtsChoice({ backend: 'api', api: { providerId: 'xi', model: '' } }),
    null
  )
  assert.equal(
    normalizeVoiceTtsChoice({ backend: 'api', api: { model: 'm' } }),
    null,
    'sem provedor'
  )
  assert.deepEqual(
    normalizeVoiceTtsChoice({ backend: 'local', local: { engine: 'kokoro', voice: '' } }),
    {
      backend: 'local',
      local: { engine: 'kokoro', voice: 'pf_dora' }
    }
  )
  assert.equal(
    normalizeVoiceTtsChoice({ backend: 'local', local: { engine: 'piper', voice: 'x' } }),
    null
  )
  assert.deepEqual(
    normalizeVoiceTtsChoice({
      backend: 'gpu',
      gpu: { engine: 'motor-do-futuro', voice: 'user:x', steps: 32, params: { a: 1 } }
    }),
    { backend: 'gpu', gpu: { engine: 'motor-do-futuro', voice: 'user:x' } },
    'motor desconhecido preservado (outro app pode conhecer); passos/parâmetros ficam no dispositivo'
  )
  for (const junk of [null, 42, 'kokoro', [], {}, { backend: 'fala' }, { backend: 'gpu', gpu: {} }])
    assert.equal(normalizeVoiceTtsChoice(junk), null, JSON.stringify(junk))
})

test('normalizeVoiceSttChoice: blocos obrigatórios por modo, só os do modo, GPU padrão, idioma', () => {
  assert.deepEqual(
    normalizeVoiceSttChoice({
      mode: 'api',
      api: {
        providerId: 'groq',
        model: 'w',
        apiKey: 'sk',
        params: { openai: { temperature: 0.2 } }
      },
      local: { engine: 'whisper.cpp', model: 'ggml-base' },
      gpu: { engine: 'x' },
      language: '  en-US '
    }),
    {
      mode: 'api',
      api: { providerId: 'groq', model: 'w', params: { openai: { temperature: 0.2 } } },
      language: 'en-US'
    }
  )
  assert.deepEqual(
    normalizeVoiceSttChoice({
      mode: 'hybrid',
      api: { providerId: 'groq', model: 'w' },
      local: { engine: 'whisper.cpp', model: 'ggml-base', installed: true }
    }),
    {
      mode: 'hybrid',
      api: { providerId: 'groq', model: 'w' },
      local: { engine: 'whisper.cpp', model: 'ggml-base' }
    },
    '`installed` (do dispositivo) nunca entra'
  )
  assert.deepEqual(normalizeVoiceSttChoice({ mode: 'gpu', gpu: { params: { beam: 5 } } }), {
    mode: 'gpu',
    gpu: { engine: 'whisper-large-v3-turbo', model: null }
  })
  assert.equal(normalizeVoiceSttChoice({ mode: 'api' }), null, 'api sem provedor')
  assert.equal(
    normalizeVoiceSttChoice({ mode: 'hybrid', api: { providerId: 'g', model: 'w' } }),
    null
  )
  assert.equal(normalizeVoiceSttChoice({ mode: 'local', local: { engine: 'kaldi' } }), null)
  assert.equal(normalizeVoiceSttChoice({ mode: 'nuvem' }), null)
  assert.equal(normalizeVoiceSttChoice('api'), null)
})

test('VoiceCallConfig: tts/stt só gravados quando escolhidos; camada chat > persona', () => {
  const c = normalizeVoiceCallConfig({ enabled: true, tts: ELEVEN, stt: { mode: 'x' } })
  assert.deepEqual(c.tts, ELEVEN)
  assert.equal('stt' in c, false, 'lixo some')
  assert.equal('tts' in normalizeVoiceCallConfig({}), false)
  const layered = layerVoiceCallConfig(
    { ...c, tts: null } as any,
    voice({ tts: KOKORO_MALE, stt: GROQ_EN })
  )
  assert.deepEqual(layered.tts, KOKORO_MALE, 'null no chat herda a persona')
  assert.deepEqual(layered.stt, GROQ_EN)
  assert.deepEqual(
    layerVoiceCallConfig(voice({ tts: ELEVEN }), voice({ tts: KOKORO_MALE })).tts,
    ELEVEN
  )
})

test('persona → chat: o chat novo NÃO leva a voz da persona (herda ao vivo); o editor da persona a vê', async () => {
  const { withoutVoiceChoice } = await import('../src/renderer/src/lib/voice/voiceChoice.ts')
  const persona = sanitizePresetConfig({
    systemPrompt: 'Narre.',
    voice: { enabled: true, voicePrompt: 'curto', tts: ELEVEN, stt: GROQ_EN }
  })
  assert.deepEqual(persona.voice?.tts, ELEVEN, 'a persona guarda a voz')
  // o editor da persona resolve a config com `applyPreset` — a voz precisa continuar visível lá
  assert.deepEqual(applyPreset(DEFAULT_CHAT_CONFIG('/tmp'), persona).voice?.tts, ELEVEN)
  // chat novo (NewChat): snapshot sem a voz/transcrição — herda ao vivo pela `presetId`
  const chat = withoutVoiceChoice(persona)
  assert.equal(chat.voice?.enabled, true, 'o resto da voz continua no snapshot')
  assert.equal(chat.voice?.voicePrompt, 'curto')
  assert.equal(chat.voice?.tts, undefined)
  assert.equal(chat.voice?.stt, undefined)
  assert.deepEqual(persona.voice?.tts, ELEVEN, 'a persona não é alterada')
  assert.equal(withoutVoiceChoice({ model: 'x' }).model, 'x')
})

// ---------------- herança e aplicar/extrair ----------------

test('herança: chat → persona → dispositivo (de onde veio)', () => {
  assert.deepEqual(
    ttsChoiceOf({ chat: voice({ tts: ELEVEN }), persona: voice({ tts: KOKORO_MALE }) }),
    {
      choice: ELEVEN,
      source: 'chat'
    }
  )
  assert.deepEqual(ttsChoiceOf({ chat: voice({}), persona: voice({ tts: KOKORO_MALE }) }), {
    choice: KOKORO_MALE,
    source: 'persona'
  })
  assert.deepEqual(ttsChoiceOf({ chat: null, persona: null }), { choice: null, source: 'device' })
  assert.deepEqual(sttChoiceOf({ persona: { stt: GROQ_EN } as any }).source, 'persona')
  assert.deepEqual(sttChoiceOf(null), { choice: null, source: 'device' })
})

test('applyTtsChoice/applySttChoice: o que é do dispositivo continua (GPU, installed, parciais)', () => {
  const api = applyTtsChoice(
    { ...DEVICE_TTS, api: { providerId: 'x', model: 'y', voice: null, baseUrl: 'u', apiKey: 'k' } },
    ELEVEN
  )
  assert.equal(api.backend, 'api')
  assert.deepEqual(
    api.api,
    ELEVEN.backend === 'api' ? ELEVEN.api : null,
    'sem endereço/chave antigos'
  )
  assert.deepEqual(api.local, DEVICE_TTS.local, 'motor local do dispositivo intacto')
  const gpu = applyTtsChoice(
    {
      ...DEVICE_TTS,
      gpu: { engine: 'xtts-v2', voice: null, steps: 32, params: { 'xtts-v2': { speed: 1.2 } } }
    },
    GPU_CLONE
  )
  assert.deepEqual(gpu.gpu, {
    engine: 'xtts-v2',
    voice: 'user:voz-do-pc',
    steps: 32,
    params: { 'xtts-v2': { speed: 1.2 } }
  })
  assert.equal(
    applyTtsChoice(DEVICE_TTS, { backend: 'gpu', gpu: { engine: 'futuro', voice: null } }),
    DEVICE_TTS
  )
  const loc = applyTtsChoice(DEVICE_TTS, KOKORO_MALE)
  assert.deepEqual(
    loc.local,
    { engine: 'kokoro', voice: 'pm_alex', installed: true },
    'mesmo motor → installed do dispositivo'
  )
  assert.equal(applyTtsChoice(DEVICE_TTS, null), DEVICE_TTS)
  const stt = applySttChoice(DEVICE_STT, {
    mode: 'local',
    local: { engine: 'whisper.cpp', model: 'ggml-small' }
  })
  assert.equal(stt.mode, 'local')
  assert.equal(stt.livePartials, false, 'parciais ao vivo são do dispositivo')
  assert.deepEqual(stt.api, DEVICE_STT.api, 'api do dispositivo fica (não usada no modo local)')
  assert.equal(
    applySttChoice(DEVICE_STT, {
      mode: 'gpu',
      gpu: { engine: 'whisper-large-v3-turbo', model: null }
    }).gpu?.engine,
    'whisper-large-v3-turbo'
  )
  // ida e volta pelos seletores (o editor da persona grava a escolha a partir das settings)
  for (const c of [ELEVEN, KOKORO_MALE, GPU_CLONE])
    assert.deepEqual(ttsChoiceFromSettings(applyTtsChoice(DEVICE_TTS, c)), c)
  assert.deepEqual(sttChoiceFromSettings(applySttChoice(DEVICE_STT, GROQ_EN), 'en-US'), GROQ_EN)
})

// ---------------- disponibilidade e fallback ----------------

test('resolveTtsVoice: escolha disponível vale; indisponível cai no dispositivo com o motivo (por backend)', () => {
  const ok = resolveTtsVoice({ persona: voice({ tts: ELEVEN }) }, DEVICE_TTS, caps())
  assert.equal(ok.source, 'persona')
  assert.equal(ok.available, true)
  assert.equal(ok.settings.backend, 'api')
  assert.equal(ok.fallback, undefined)
  const chat = resolveTtsVoice(
    { chat: voice({ tts: KOKORO_MALE }), persona: voice({ tts: ELEVEN }) },
    DEVICE_TTS,
    caps({ kokoroVoices: ['pf_dora', 'pm_alex'] })
  )
  assert.equal(chat.source, 'chat')
  assert.equal(chat.settings.local?.voice, 'pm_alex')
  // api: provedor de outro dispositivo
  const noProv = resolveTtsVoice(
    { persona: voice({ tts: ELEVEN }) },
    DEVICE_TTS,
    caps({ providers: { groq: 'stt' } })
  )
  assert.equal(noProv.source, 'device')
  assert.deepEqual(noProv.fallback, {
    from: 'persona',
    reason: 'o provedor escolhido não existe neste dispositivo'
  })
  assert.equal(noProv.available, true, 'o padrão daqui funciona')
  assert.equal(noProv.settings.local?.voice, 'pf_dora')
  assert.deepEqual(noProv.choice, ELEVEN, 'a escolha continua visível')
  // api: provedor que não serve fala
  assert.match(
    resolveTtsVoice(
      {
        persona: voice({ tts: { ...ELEVEN, api: { ...(ELEVEN as any).api, providerId: 'groq' } } })
      },
      DEVICE_TTS,
      caps()
    ).fallback!.reason,
    /não serve tts/
  )
  // local: voz não instalada aqui
  const male = resolveTtsVoice({ persona: voice({ tts: KOKORO_MALE }) }, DEVICE_TTS, caps())
  assert.equal(male.fallback?.reason, 'voz pm_alex não instalada neste dispositivo')
  // gpu: sem o modo GPU / motor ausente / voz clonada de outro PC / motor desconhecido
  assert.match(
    resolveTtsVoice({ persona: voice({ tts: GPU_CLONE }) }, DEVICE_TTS, caps()).fallback!.reason,
    /GPU local/
  )
  assert.match(
    resolveTtsVoice(
      { persona: voice({ tts: GPU_CLONE }) },
      DEVICE_TTS,
      caps({ gpu: { engines: ['omnivoice'], voices: [] } })
    ).fallback!.reason,
    /xtts-v2 não está instalado/
  )
  assert.equal(
    resolveTtsVoice(
      { persona: voice({ tts: GPU_CLONE }) },
      DEVICE_TTS,
      caps({ gpu: { engines: ['xtts-v2'], voices: ['cc0-faber'] } })
    ).fallback!.reason,
    'a voz “user:voz-do-pc” não existe neste dispositivo'
  )
  const gpuOk = resolveTtsVoice(
    { persona: voice({ tts: GPU_CLONE }) },
    DEVICE_TTS,
    caps({ gpu: { engines: ['xtts-v2'], voices: ['user:voz-do-pc'] } })
  )
  assert.equal(gpuOk.source, 'persona')
  assert.equal(gpuOk.settings.gpu?.steps, 32, 'passos do dispositivo')
  assert.match(
    resolveTtsVoice(
      { persona: voice({ tts: { backend: 'gpu', gpu: { engine: 'motor-x', voice: null } } }) },
      DEVICE_TTS,
      caps({ gpu: { engines: ['xtts-v2'], voices: [] } })
    ).fallback!.reason,
    /motor-x.*não existe nesta versão/
  )
  // celular: só `provider` — local/gpu caem no global
  const phone: VoiceDeviceCaps = { provider: () => ({ ok: true }) }
  assert.match(
    resolveTtsVoice(
      { persona: voice({ tts: KOKORO_MALE }) },
      {
        ...DEFAULT_TTS_SETTINGS,
        backend: 'api',
        api: { providerId: 'or', model: 'm', voice: null }
      },
      phone
    ).fallback!.reason,
    /motores locais/
  )
})

test('resolve: nada funciona aqui → indisponível (não configurado × não funciona) com o motivo', () => {
  const unconf = resolveTtsVoice(null, { ...DEFAULT_TTS_SETTINGS, backend: 'api' }, caps())
  assert.equal(unconf.available, false)
  assert.equal(unconf.unconfigured, true)
  assert.equal(unconf.reason, 'nenhum modelo de fala escolhido')
  const broken = resolveTtsVoice(
    { persona: voice({ tts: ELEVEN }) },
    DEVICE_TTS,
    caps({ providers: {}, kokoroVoices: [] })
  )
  assert.equal(broken.available, false)
  assert.equal(broken.unconfigured, undefined)
  assert.equal(broken.fallback?.reason, 'o provedor escolhido não existe neste dispositivo')
  assert.equal(broken.reason, 'voz pf_dora não instalada neste dispositivo')
  const stt = resolveSttVoice(null, DEFAULT_STT_SETTINGS, 'pt-BR', caps())
  assert.equal(stt.available, false)
  assert.equal(stt.unconfigured, true)
  assert.equal(stt.reason, 'nenhum modelo de transcrição escolhido')
})

test('resolveSttVoice: idioma da persona (mesmo no fallback), modos local/híbrido/gpu', () => {
  const r = resolveSttVoice({ persona: voice({ stt: GROQ_EN }) }, DEVICE_STT, 'pt-BR', caps())
  assert.equal(r.source, 'persona')
  assert.equal(r.language, 'en-US')
  assert.equal(r.settings.livePartials, false)
  const fb = resolveSttVoice(
    { persona: voice({ stt: { ...GROQ_EN, api: { providerId: 'sumiu', model: 'w' } } }) },
    DEVICE_STT,
    'pt-BR',
    caps()
  )
  assert.equal(fb.source, 'device')
  assert.equal(fb.language, 'en-US', 'o idioma é da persona — vale com a transcrição daqui')
  assert.equal(fb.settings, DEVICE_STT)
  assert.equal(resolveSttVoice(null, DEVICE_STT, 'pt-BR', caps()).language, 'pt-BR')
  const local = resolveSttVoice(
    {
      chat: voice({ stt: { mode: 'local', local: { engine: 'whisper.cpp', model: 'ggml-small' } } })
    },
    DEVICE_STT,
    'pt-BR',
    caps()
  )
  assert.equal(local.fallback?.reason, 'o modelo ggml-small não está instalado neste dispositivo')
  const localOk = resolveSttVoice(
    {
      chat: voice({ stt: { mode: 'local', local: { engine: 'whisper.cpp', model: 'ggml-base' } } })
    },
    DEVICE_STT,
    'pt-BR',
    caps()
  )
  assert.equal(localOk.source, 'chat')
  assert.equal(localOk.settings.local?.installed, true, 'conferido no disco → instalado')
  // híbrido: basta a API (o local é reserva/parciais)
  const hy = resolveSttVoice(
    {
      chat: voice({
        stt: {
          mode: 'hybrid',
          api: { providerId: 'groq', model: 'w' },
          local: { engine: 'whisper.cpp', model: 'ggml-large' }
        }
      })
    },
    DEVICE_STT,
    'pt-BR',
    caps()
  )
  assert.equal(hy.source, 'chat')
  assert.equal(
    sttSettingsCheck(
      applySttChoice(DEVICE_STT, {
        mode: 'hybrid',
        api: { providerId: 'x', model: 'w' },
        local: { engine: 'whisper.cpp', model: 'ggml-base' }
      }),
      caps()
    ).ok,
    true,
    'híbrido: o local basta'
  )
  assert.match(
    resolveSttVoice({ chat: voice({ stt: { mode: 'gpu' } }) }, DEVICE_STT, 'pt-BR', caps())
      .fallback!.reason,
    /GPU local/
  )
  assert.equal(ttsSettingsCheck(DEVICE_TTS, caps()).ok, true)
})

// ---------------- checagens do dispositivo (main — voice/voiceCaps.ts) ----------------

test('voiceCapsFrom: provedor existe e serve a capacidade; modelo/voz local instalados; GPU', async () => {
  const { voiceCapsFrom, collectVoiceCaps } = await import('../src/main/voice/voiceCaps.ts')
  const entry = (id: string, kind: string, engine: string): any => ({ id, kind, engine, name: id })
  const c = voiceCapsFrom({
    provider: (id) =>
      ({
        xi: { name: 'ElevenLabs', baseUrl: 'https://api.elevenlabs.io', kind: 'elevenlabs' },
        groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', kind: 'openai' },
        vazio: { name: 'Sem URL', baseUrl: ' ', kind: 'openai' }
      })[id] ?? null,
    models: [
      { entry: entry('ggml-base', 'stt', 'whisper.cpp'), state: 'installed' },
      { entry: entry('ggml-small', 'stt', 'whisper.cpp'), state: 'notInstalled' },
      { entry: entry('kokoro-onnx', 'tts', 'kokoro'), state: 'installed' },
      { entry: entry('kokoro-voice-pf-dora', 'tts', 'kokoro'), state: 'installed' }
    ],
    whisper: { available: true, reason: null },
    onnx: { available: true, reason: null },
    espeak: { available: true, reason: null },
    gpu: {
      runtime: { state: 'installed' },
      engines: [
        {
          id: 'xtts-v2',
          label: 'XTTS v2',
          install: { state: 'installed' },
          compat: { level: 'ok', reasons: [] },
          voices: [{ id: 'cc0-faber' }]
        },
        {
          id: 'omnivoice',
          label: 'OmniVoice',
          install: { state: 'absent' },
          compat: { level: 'ok', reasons: [] },
          voices: []
        },
        {
          id: 'qwen3-tts-1.7b',
          label: 'Qwen3',
          install: { state: 'installed' },
          compat: { level: 'blocked', reasons: ['VRAM insuficiente'] },
          voices: []
        }
      ]
    } as any
  })
  assert.deepEqual(c.provider('xi', 'tts'), { ok: true })
  assert.match(c.provider('xi', 'stt').reason!, /ElevenLabs.*não serve transcrição/)
  assert.deepEqual(c.provider('groq', 'stt'), { ok: true })
  assert.match(c.provider('sumiu', 'tts').reason!, /não existe neste dispositivo/)
  assert.match(c.provider('vazio', 'tts').reason!, /não existe neste dispositivo/)
  assert.deepEqual(c.sttLocal!({ engine: 'whisper.cpp', model: 'ggml-base' }), { ok: true })
  assert.deepEqual(
    c.sttLocal!({ engine: 'whisper.cpp', model: '' }),
    { ok: true },
    'sem modelo = qualquer do motor'
  )
  assert.match(
    c.sttLocal!({ engine: 'whisper.cpp', model: 'ggml-small' }).reason!,
    /não está instalado neste dispositivo/
  )
  assert.match(c.sttLocal!({ engine: 'vosk', model: '' }).reason!, /vosk ainda não transcreve/)
  assert.deepEqual(c.ttsLocal!({ engine: 'kokoro', voice: 'pf_dora' }), { ok: true })
  assert.match(
    c.ttsLocal!({ engine: 'kokoro', voice: 'pm_alex' }).reason!,
    /pm_alex não instalada.*neste dispositivo/
  )
  assert.deepEqual(c.ttsGpu!({ engine: 'xtts-v2', voice: 'cc0-faber' }), { ok: true })
  assert.match(
    c.ttsGpu!({ engine: 'xtts-v2', voice: 'user:outro-pc' }).reason!,
    /não existe neste dispositivo/
  )
  assert.match(
    c.ttsGpu!({ engine: 'omnivoice', voice: null }).reason!,
    /OmniVoice não está instalado/
  )
  assert.match(
    c.ttsGpu!({ engine: 'qwen3-tts-1.7b', voice: null }).reason!,
    /não roda neste computador: VRAM insuficiente/
  )
  assert.match(
    c.sttGpu!({ engine: 'whisper-large-v3-turbo', model: null }).reason!,
    /não existe nesta versão|não está instalado/
  )
  // sem GPU / runtime quebrado
  const noGpu = voiceCapsFrom({
    provider: () => null,
    models: [],
    whisper: { available: false, reason: 'binding ausente' },
    onnx: null,
    espeak: { available: false, reason: 'espeak-ng ausente' },
    gpu: null
  })
  assert.match(
    noGpu.ttsGpu!({ engine: 'xtts-v2', voice: null }).reason!,
    /modo GPU local não está disponível/
  )
  assert.equal(
    noGpu.sttLocal!({ engine: 'whisper.cpp', model: 'ggml-base' }).reason,
    'binding ausente'
  )
  assert.match(noGpu.ttsLocal!({ engine: 'kokoro', voice: 'pf_dora' }).reason!, /espeak-ng/)
  // coleta: só sonda o que a resolução vai olhar
  const probes: string[] = []
  const fakeProbe = (n: string) => async () => {
    probes.push(n)
    return { available: true, reason: null }
  }
  const deps = {
    provider: () => null,
    localModels: async () => {
      probes.push('models')
      return []
    },
    whisper: fakeProbe('whisper'),
    onnx: fakeProbe('onnx'),
    espeak: fakeProbe('espeak'),
    gpu: async () => {
      probes.push('gpu')
      return null
    }
  }
  await collectVoiceCaps(deps, { local: false, gpu: false })
  assert.deepEqual(probes, [], 'só API: nenhuma sonda')
  await collectVoiceCaps(deps, { local: true, gpu: true })
  assert.deepEqual(probes.sort(), ['espeak', 'gpu', 'models', 'onnx', 'whisper'])
})

// ---------------- a chamada usa a voz do chat ----------------

test('chamada: o gestor pede as settings PELO CHAT — fala/transcrição da persona (modelo no marcador, tags)', async () => {
  const { VoiceCallManager } = await import('../src/main/voice/call.ts')
  // persona com ElevenLabs v3 (interpreta tags) e Groq em inglês; o dispositivo fala com o Kokoro
  const personaTts = applyTtsChoice(DEVICE_TTS, ELEVEN)
  const effective = (chatId?: string | null): { tts: TtsSettings; stt: SttSettings } =>
    chatId === 'c-narradora'
      ? {
          tts: {
            ...personaTts,
            api: {
              ...personaTts.api,
              baseUrl: 'https://api.elevenlabs.io',
              providerKind: 'elevenlabs'
            }
          },
          stt: applySttChoice(DEVICE_STT, GROQ_EN)
        }
      : { tts: DEVICE_TTS, stt: DEVICE_STT }
  const asked: (string | null | undefined)[] = []
  const markers: any[] = []
  const synthCalls: string[] = []
  let cb: ((e: AgentEvent) => void) | null = null
  const m = new VoiceCallManager({
    sendTurn: () => {},
    synth: async (text) => {
      synthCalls.push(text)
      return { audio: new Uint8Array([1]), mime: 'audio/wav' }
    },
    emitState: () => {},
    emitUtterance: () => {},
    emitUtteranceCancel: () => {},
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c-narradora', depth: 0, busy: false }),
    chatConfig: () =>
      ({
        voice: {
          enabled: null,
          model: null,
          tools: null,
          voicePrompt: null,
          fillers: null,
          audioTags: true
        }
      }) as any,
    settings: (chatId) => {
      asked.push(chatId)
      return {
        defaults: {
          ...DEFAULT_VOICE_CALL_DEFAULTS,
          fillers: { ...DEFAULT_VOICE_CALL_DEFAULTS.fillers, enabled: false }
        },
        audioInput: DEFAULT_AUDIO_INPUT,
        ...effective(chatId)
      }
    },
    onEvent: (fn) => {
      cb = fn
      return () => {}
    },
    appendMarker: (_sid, content, meta) => void markers.push({ content, meta }),
    sessionMessages: () => [],
    newCallId: () => 'call-1'
  })
  void cb
  m.start('s1')
  // fala/transcrição (e os padrões) pelo chat da chamada; só os pools globais vêm sem chat
  assert.ok(asked.filter((c) => c === 'c-narradora').length >= 3, `settings pelo chat: ${asked}`)
  assert.ok(
    asked.every((c) => c === 'c-narradora' || c == null),
    `outro chat: ${asked}`
  )
  const ctx = m.callContextFor(
    {
      id: 'c-narradora',
      title: '',
      config: {} as any,
      mainSessionId: 's1',
      createdAt: 0,
      updatedAt: 0
    },
    { id: 's1', depth: 0 } as any
  )
  assert.equal(
    ctx?.audioTagsActive,
    true,
    'a voz da persona (ElevenLabs v3) interpreta tags — a do dispositivo (Kokoro) não'
  )
  m.stop()
  const end = markers.find((x) => x.meta?.voiceCall?.phase === 'end')
  assert.ok(end, 'marcador de fim')
  assert.equal(
    end.meta.voiceCall.usage.tts.model,
    'eleven_v3',
    'custos/modelo da fala = a voz da persona'
  )
  assert.equal(end.meta.voiceCall.usage.tts.backend, 'elevenlabs')
  assert.equal(end.meta.voiceCall.usage.stt.model, 'whisper-large-v3-turbo')
})

// ---------------- clipes por voz ----------------

test('clipes por voz: a voz da persona sem clipes não toca os da voz do dispositivo (reservas de sempre)', async () => {
  const { generateClips, loadCurrentClipAudio } = await import('../src/main/voice/clips.ts')
  const base = mkdtempSync(join(tmpdir(), 'clearchat-persona-clips-'))
  try {
    let n = 0
    const local = {
      engine: 'kokoro' as const,
      async synthesize(): Promise<any> {
        n++
        return {
          audio: new Uint8Array([82, 73, 70, 70, n]),
          mime: 'audio/wav',
          model: 'kokoro-onnx',
          ms: 1
        }
      }
    }
    await generateClips({ baseDir: base, settings: DEVICE_TTS, local })
    const persona = applyTtsChoice(DEVICE_TTS, KOKORO_MALE)
    assert.ok(await loadCurrentClipAudio(base, DEVICE_TTS, null, 'TOOL', 1), 'a do dispositivo tem')
    assert.equal(
      await loadCurrentClipAudio(base, persona, null, 'TOOL', 1),
      null,
      'a da persona não (frase → síntese ao vivo)'
    )
    assert.equal(
      await loadCurrentClipAudio(base, persona, null, 'FILLER', 1),
      null,
      'preâmbulo → não toca'
    )
    // "Gerar clipes desta voz": cache próprio da voz da persona
    await generateClips({ baseDir: base, settings: persona, local })
    assert.ok(await loadCurrentClipAudio(base, persona, null, 'FILLER', 1))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------------- textos dos ícones e "Salvar como persona" (renderer, puros) ----------------

test('textos: tooltips do mic/telefone esmaecidos, aviso do fallback, rótulos e a voz herdada no snapshot', async () => {
  const t = await import('../src/renderer/src/lib/voice/voiceChoice.ts')
  const providers = [
    { id: 'xi', name: 'ElevenLabs' },
    { id: 'groq', name: 'Groq' }
  ]
  assert.equal(t.ttsVoiceLabel(DEVICE_TTS, providers), 'Kokoro · pf_dora')
  assert.equal(
    t.ttsVoiceLabel(applyTtsChoice(DEVICE_TTS, ELEVEN), providers),
    'ElevenLabs · eleven_v3 · rachel'
  )
  assert.equal(
    t.ttsVoiceLabel(applyTtsChoice(DEVICE_TTS, GPU_CLONE), providers),
    'GPU local · XTTS-v2 · user:voz-do-pc'
  )
  assert.equal(
    t.sttVoiceLabel(DEVICE_STT, providers, 'pt-BR'),
    'Groq · whisper-large-v3-turbo · pt-BR'
  )
  const stt = resolveSttVoice(null, DEFAULT_STT_SETTINGS, 'pt-BR', caps())
  assert.match(
    t.dictationUnavailableText(stt)!,
    /^Ditado não configurado neste dispositivo — nenhum modelo de transcrição escolhido/
  )
  const sttBroken = resolveSttVoice(
    null,
    normalizeSttSettings({ mode: 'local', local: { engine: 'whisper.cpp', model: 'ggml-small' } }),
    'pt-BR',
    caps()
  )
  assert.match(
    t.dictationUnavailableText(sttBroken)!,
    /^Ditado não funciona neste dispositivo — o modelo ggml-small/
  )
  assert.equal(t.dictationUnavailableText(resolveSttVoice(null, DEVICE_STT, 'pt-BR', caps())), null)
  const tts = resolveTtsVoice(
    { persona: voice({ tts: ELEVEN }) },
    DEVICE_TTS,
    caps({ providers: { groq: 'stt' } })
  )
  assert.equal(
    t.voiceFallbackNote('tts', tts),
    'A voz da persona não está disponível neste dispositivo (o provedor escolhido não existe neste dispositivo) — usando a padrão deste dispositivo.'
  )
  assert.equal(t.voiceIconState([tts]), 'fallback')
  const okStt = resolveSttVoice(null, DEVICE_STT, 'pt-BR', caps())
  assert.equal(
    t.callUnavailableText({ tts, stt: okStt }),
    null,
    'fallback funciona: telefone normal'
  )
  const deadTts = resolveTtsVoice(null, { ...DEFAULT_TTS_SETTINGS, backend: 'api' }, caps())
  assert.equal(t.voiceIconState([stt, deadTts]), 'unconfigured')
  assert.match(
    t.callUnavailableText({ tts: deadTts, stt })!,
    /^Chamada de voz não configurada neste dispositivo — transcrição: .*; fala: nenhum modelo de fala escolhido/
  )
  assert.match(
    t.callUnavailableText({ tts: deadTts, stt: sttBroken })!,
    /^Chamada de voz não funciona neste dispositivo/
  )
  // "Salvar como persona": a voz herdada da persona de origem vai junto; a própria do chat vence
  const snap = t.withInheritedVoice(
    { voice: voice({ enabled: true }) },
    voice({ tts: ELEVEN, stt: GROQ_EN })
  )
  assert.deepEqual((snap.voice as any).tts, ELEVEN)
  assert.deepEqual((snap.voice as any).stt, GROQ_EN)
  const own = t.withInheritedVoice({ voice: voice({ tts: KOKORO_MALE }) }, voice({ tts: ELEVEN }))
  assert.deepEqual((own.voice as any).tts, KOKORO_MALE)
  assert.deepEqual(t.withInheritedVoice({ model: 'x' }, null), { model: 'x' })
})

// ---------------- sem prompt oculto: o único texto a mais é o "Prompt do modo voz" ----------------

test('chamada de uma persona intocada: a request tem EXATAMENTE o system prompt de um turno de texto', async () => {
  const { buildRequest } = await import('../src/main/agent/request.ts')
  const {
    applyVoiceCallChat,
    resolveVoiceCallConfig,
    voicePromptLayout,
    DEFAULT_VOICE_CALL_DEFAULTS: D
  } = await import('../src/shared/voice.ts')
  const provider = {
    id: 'p1',
    name: 'OR',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-x',
    headers: {},
    createdAt: 0
  }
  const chat = {
    id: 'c1',
    title: '',
    mainSessionId: 's1',
    createdAt: 0,
    updatedAt: 0,
    config: DEFAULT_CHAT_CONFIG('/w', {
      providerId: 'p1',
      model: 'm',
      systemPrompt: 'Você é a Diana.'
    })
  }
  const hist = [
    {
      id: 'u1',
      sessionId: 's1',
      seq: 1,
      message: { role: 'user', content: 'oi' },
      meta: {},
      createdAt: 0
    }
  ] as any
  const env = { os: 'Linux', shell: 'bash' }
  // OpenRouter com a compactação (padrão): Messages API (busca nativa, 1.12.0) → `system` no topo
  const system = (c: any): unknown => {
    const b = buildRequest(c, { depth: 0, model: 'm' }, hist, provider as any, env).body as any
    return b.system ? { role: 'system', content: b.system } : b.messages[0]
  }
  /** O texto do system prompt da request, sem o bloco de ambiente que o app sempre põe no fim. */
  const sysText = (c: any): string => {
    const m = system(c) as any
    const text = Array.isArray(m.content) ? m.content.map((p: any) => p.text).join('') : m.content
    return String(text).split('\n\n<environment>')[0]
  }
  // persona/chat intocados + os padrões deste dispositivo: nada do app entra
  assert.equal('basePromptEnabled' in D, false, 'não existe prompt-base')
  const call = resolveVoiceCallConfig(null, D, null)
  assert.deepEqual(voicePromptLayout(call), { replacesSystem: false, parts: [] })
  assert.deepEqual(system(applyVoiceCallChat(chat as any, call)), system(chat))
  // persona com prompt do modo voz: só ele muda — complementar / substituto / nenhum
  const persona = voice({ voicePrompt: 'Fale curto.' })
  const append = resolveVoiceCallConfig(null, D, persona)
  assert.equal(sysText(applyVoiceCallChat(chat as any, append)), 'Você é a Diana.\n\nFale curto.')
  assert.deepEqual(voicePromptLayout(append).parts, [{ kind: 'voice', text: 'Fale curto.' }])
  const replace = resolveVoiceCallConfig(voice({ promptMode: 'replace' }), D, persona)
  assert.equal(sysText(applyVoiceCallChat(chat as any, replace)), 'Fale curto.')
  assert.equal(voicePromptLayout(replace).replacesSystem, true)
  const none = resolveVoiceCallConfig(voice({ promptMode: 'none' }), D, persona)
  assert.deepEqual(system(applyVoiceCallChat(chat as any, none)), system(chat))
  assert.deepEqual(voicePromptLayout(none).parts, [])
  // tags de voz: só com o opt-in E a voz interpretando — e aparecem na prévia (mesmo cálculo)
  const tags = {
    ...resolveVoiceCallConfig(voice({ audioTags: true }), D, null),
    audioTagsActive: true
  }
  assert.deepEqual(
    voicePromptLayout(tags).parts.map((p) => p.kind),
    ['tags']
  )
  assert.ok(sysText(applyVoiceCallChat(chat as any, tags)).length > sysText(chat).length)
  assert.deepEqual(
    voicePromptLayout({ ...tags, audioTagsActive: false }).parts,
    [],
    'voz sem tags: nada'
  )
})
