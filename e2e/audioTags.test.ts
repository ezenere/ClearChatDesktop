// Tags de voz na chamada (SPEC → "Chamada de voz → Tags de voz"): reconhecimento/remoção
// (`@shared/audioTags`), capacidade por modelo (`supportsAudioTags` — ElevenLabs v3/v4, Fish Audio
// Drama 3/S2), o opt-in por persona/chat/global (normalizadores + herança chat → persona → global),
// a instrução no prompt (ligada × desligada × voz com/sem suporte), o corte de sentenças (nunca
// dentro dos colchetes; tag sozinha nunca vira utterance), a remoção antes da síntese quando a voz
// não as interpreta (o histórico guarda o original) e o id de voz do Fish Audio colado como link.
// Tudo com fakes — nada de rede.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/audioTags.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatConfig } from '@shared/types'
import {
  AUDIO_TAGS_PROMPT_MAX,
  DEFAULT_AUDIO_TAGS_PROMPT,
  hasAudioTags,
  isOnlyAudioTags,
  stripAudioTags
} from '../src/shared/audioTags.ts'
import {
  fishVoiceIdFrom,
  isFishAudioModel,
  supportsAudioTags,
  ttsSupportsAudioTags
} from '../src/shared/voiceCatalog.ts'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  normalizeVoiceCallConfig,
  normalizeVoiceCallDefaults,
  resolveVoiceCallConfig,
  voiceSystemPrompt,
  type TtsSettings,
  type VoiceCallConfig
} from '../src/shared/voice.ts'
import { splitSentences } from '../src/main/voice/sentences.ts'
import { VoiceCallManager, type VoiceCallUtterance } from '../src/main/voice/call.ts'

// ---------------- reconhecimento / remoção ----------------

test('tags: reconhece [laughs]/[short pause]/[nervous, whispering]; links, notas e checkboxes não', () => {
  for (const t of ['[laughs]', '[short pause]', '[nervous, whispering]', '[sussurra]', '[risos]'])
    assert.ok(hasAudioTags(`a ${t} b`), t)
  for (const t of ['[o link](http://x)', '[1]', '[ ]', '[x]', '[^1]', '[]'])
    assert.ok(!hasAudioTags(`a ${t} b`), t)
  assert.equal(stripAudioTags('Claro! [laughs] Isso é ótimo [sighs].'), 'Claro! Isso é ótimo.')
  assert.equal(stripAudioTags('[whispers] Um segredo.'), 'Um segredo.')
  assert.equal(stripAudioTags('Sem tags, igual.'), 'Sem tags, igual.')
  assert.equal(stripAudioTags('Veja [o link](http://x).'), 'Veja [o link](http://x).')
  assert.ok(isOnlyAudioTags('[laughs]'))
  assert.ok(isOnlyAudioTags(' [laughs] [short pause]. '))
  assert.ok(!isOnlyAudioTags('[laughs] Oi'))
  assert.ok(!isOnlyAudioTags('Oi'))
})

test('supportsAudioTags: ElevenLabs v3/v4 (direto e OpenRouter) e Fish Drama 3/S2; o resto não', () => {
  for (const m of ['eleven_v3', 'eleven_v3_conversational', 'eleven_v4', 'eleven_v4_turbo'])
    assert.ok(supportsAudioTags('elevenlabs', m), m)
  for (const m of ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'])
    assert.ok(!supportsAudioTags('elevenlabs', m), m)
  for (const m of [
    'elevenlabs/eleven-v3',
    'elevenlabs/eleven-v4-turbo',
    'fish-audio/drama-3',
    'fish-audio/s2-pro',
    'fish-audio/s2.1-pro',
    'fish-audio/s2.1-pro-free:free'
  ])
    assert.ok(supportsAudioTags('openrouter', m), m)
  for (const m of ['elevenlabs/eleven-flash-v2.5', 'fish-audio/s1', 'x-ai/grok-voice-tts-1.0'])
    assert.ok(!supportsAudioTags('openrouter', m), m)
  assert.ok(!supportsAudioTags('openai', 'eleven_v3'), 'família errada')
  assert.ok(!supportsAudioTags(null, 'eleven_v3'))
  // settings resolvidas do main (família pelo endereço/kind do provedor)
  const api = (model: string, baseUrl: string, providerKind?: string): TtsSettings => ({
    ...DEFAULT_TTS_SETTINGS,
    backend: 'api',
    api: { providerId: 'p', model, voice: null, baseUrl, ...(providerKind ? { providerKind } : {}) }
  })
  assert.ok(ttsSupportsAudioTags(api('eleven_v3', 'https://api.elevenlabs.io/v1')))
  assert.ok(ttsSupportsAudioTags(api('fish-audio/drama-3', 'https://openrouter.ai/api/v1')))
  assert.ok(!ttsSupportsAudioTags(api('eleven_flash_v2_5', 'https://api.elevenlabs.io/v1')))
  assert.ok(!ttsSupportsAudioTags(DEFAULT_TTS_SETTINGS), 'Kokoro local não interpreta')
})

test('Fish Audio: id ou link da biblioteca colado vira o id; outro texto não', () => {
  const id = '9a9cf47702da476aa4629e2506d4a857'
  assert.equal(fishVoiceIdFrom(id), id)
  assert.equal(fishVoiceIdFrom(`https://fish.audio/m/${id}`), id)
  assert.equal(fishVoiceIdFrom(`https://fish.audio/m/${id}/`), id)
  assert.equal(fishVoiceIdFrom(`fish.audio/m/${id}?ref=x`), id)
  assert.equal(fishVoiceIdFrom(`https://www.fish.audio/pt/m/${id.toUpperCase()}`), id)
  assert.equal(fishVoiceIdFrom('sarah'), null)
  assert.equal(fishVoiceIdFrom('https://example.com/m/' + id), null)
  assert.ok(isFishAudioModel('fish-audio/drama-3'))
  assert.ok(!isFishAudioModel('elevenlabs/eleven-v3'))
})

// ---------------- config: normalizadores + herança ----------------

test('audioTags/audioTagsPrompt: aditivos, lixo some, texto aparado com teto, vazio → null', () => {
  assert.equal(DEFAULT_VOICE_CALL_DEFAULTS.audioTags, false, 'opt-in: desligado por padrão')
  assert.equal(DEFAULT_VOICE_CALL_DEFAULTS.audioTagsPrompt, null)
  const c = normalizeVoiceCallConfig({ audioTags: true, audioTagsPrompt: '  use [laughs]\r\n ' })
  assert.equal(c.audioTags, true)
  assert.equal(c.audioTagsPrompt, 'use [laughs]')
  const junk = normalizeVoiceCallConfig({ audioTags: 'yes', audioTagsPrompt: '   ' })
  assert.ok(!('audioTags' in junk) && !('audioTagsPrompt' in junk), 'lixo/vazio não é gravado')
  assert.equal(
    normalizeVoiceCallConfig({ audioTagsPrompt: 'x'.repeat(5000) }).audioTagsPrompt?.length,
    AUDIO_TAGS_PROMPT_MAX
  )
  const d = normalizeVoiceCallDefaults({ audioTags: true, audioTagsPrompt: '' })
  assert.equal(d.audioTags, true)
  assert.equal(d.audioTagsPrompt, null)
  assert.equal(normalizeVoiceCallDefaults({}).audioTags, false, 'registro antigo: desligado')
})

test('herança chat → persona → global → padrão do app', () => {
  const g = { ...DEFAULT_VOICE_CALL_DEFAULTS, audioTags: true, audioTagsPrompt: 'GLOBAL' }
  const empty: VoiceCallConfig = normalizeVoiceCallConfig({})
  assert.equal(resolveVoiceCallConfig(empty, DEFAULT_VOICE_CALL_DEFAULTS).audioTags, false)
  assert.equal(
    resolveVoiceCallConfig(empty, DEFAULT_VOICE_CALL_DEFAULTS).audioTagsPrompt,
    DEFAULT_AUDIO_TAGS_PROMPT
  )
  assert.equal(resolveVoiceCallConfig(empty, g).audioTags, true)
  assert.equal(resolveVoiceCallConfig(empty, g).audioTagsPrompt, 'GLOBAL')
  const persona = normalizeVoiceCallConfig({ audioTags: false, audioTagsPrompt: 'PERSONA' })
  assert.equal(resolveVoiceCallConfig(empty, g, persona).audioTags, false)
  assert.equal(resolveVoiceCallConfig(empty, g, persona).audioTagsPrompt, 'PERSONA')
  const chat = normalizeVoiceCallConfig({ audioTags: true })
  const r = resolveVoiceCallConfig(chat, g, persona)
  assert.equal(r.audioTags, true, 'chat vence a persona')
  assert.equal(r.audioTagsPrompt, 'PERSONA', 'texto segue herdado')
})

test('instrução no prompt: só com tags ligadas E voz com suporte (todos os modos)', () => {
  const base = resolveVoiceCallConfig(null, DEFAULT_VOICE_CALL_DEFAULTS)
  const sys = 'Você é um assistente.'
  const cases: [boolean, boolean, boolean][] = [
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false]
  ]
  for (const [on, supported, expected] of cases) {
    const call = { ...base, audioTags: on, audioTagsActive: supported }
    for (const promptMode of ['append', 'replace', 'none'] as const) {
      const p = voiceSystemPrompt(sys, { ...call, promptMode, voicePrompt: 'curto' })
      assert.equal(
        p.includes(DEFAULT_AUDIO_TAGS_PROMPT),
        expected,
        `tags ${on} × suporte ${supported} × ${promptMode}`
      )
      if (expected) assert.ok(p.trimEnd().endsWith(DEFAULT_AUDIO_TAGS_PROMPT), 'no fim')
    }
  }
  // sem tags, o modo "nenhum" continua byte a byte o system prompt
  assert.equal(voiceSystemPrompt(sys, { ...base, promptMode: 'none' }), sys)
  // texto próprio
  assert.match(
    voiceSystemPrompt(sys, {
      ...base,
      audioTags: true,
      audioTagsActive: true,
      audioTagsPrompt: 'X'
    }),
    /\n\nX$/
  )
})

// ---------------- corte de sentenças ----------------

test('splitSentences: nunca corta dentro dos colchetes; tag sozinha vai para a frase que modula', () => {
  // vírgula do 1º pedaço dentro de uma direção do Fish não corta
  assert.deepEqual(
    splitSentences('[nervous, whispering] Ninguém, nada, respondeu. Depois', { commaCutMin: 5 })
      .sentences,
    ['[nervous, whispering] Ninguém,', 'nada, respondeu.']
  )
  // marca dentro de uma tag não é fronteira
  assert.deepEqual(splitSentences('Bem. [sighs. softly] Vamos lá.', { final: true }).sentences, [
    'Bem.',
    '[sighs. softly] Vamos lá.'
  ])
  // tag ainda chegando no streaming fica inteira no resto — e segura a frase anterior até saber se
  // ela fecha a resposta ("Bom dia. [whispers]") ou modula a próxima
  assert.deepEqual(splitSentences('Bom dia. [whisp', {}), {
    sentences: [],
    rest: 'Bom dia. [whisp'
  })
  assert.deepEqual(splitSentences('Bom dia. [whispers] Um segredo. Ok', {}).sentences, [
    'Bom dia.',
    '[whispers] Um segredo.'
  ])
  // tag sozinha entre sentenças vai para a seguinte; no fim, para a anterior; nunca sozinha
  assert.deepEqual(splitSentences('Claro! [laughs]. Que ideia. ', { final: false }).sentences, [
    'Claro!',
    '[laughs]. Que ideia.'
  ])
  assert.deepEqual(splitSentences('Isso é ótimo. [sighs]', { final: true }).sentences, [
    'Isso é ótimo. [sighs]'
  ])
  assert.deepEqual(splitSentences('[laughs]', { final: true }).sentences, [])
  // corte forçado (sem pontuação) nunca no meio de uma tag
  const long = `${'palavra '.repeat(28)}[nervous, whispering] fim`
  const cut = splitSentences(long, { maxChars: 230 })
  for (const s of [...cut.sentences, cut.rest]) {
    const open = (s.match(/\[/g) ?? []).length
    const close = (s.match(/\]/g) ?? []).length
    assert.equal(open, close, `pedaço com tag partida: "${s}"`)
  }
})

// ---------------- na chamada: remoção antes da síntese ----------------

function harness(tts: TtsSettings): {
  m: VoiceCallManager
  synth: string[]
  emitted: VoiceCallUtterance[]
  emit: (e: AgentEvent) => void
} {
  const listeners: ((e: AgentEvent) => void)[] = []
  const synth: string[] = []
  const emitted: VoiceCallUtterance[] = []
  const m = new VoiceCallManager({
    sendTurn: () => {},
    synth: async (text) => {
      synth.push(text)
      return { audio: new TextEncoder().encode(text), mime: 'audio/wav' }
    },
    emitState: () => {},
    emitUtterance: (u) => void emitted.push(u),
    emitUtteranceCancel: () => {},
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({ voice: { audioTags: true } }) as unknown as ChatConfig,
    settings: () => ({
      defaults: DEFAULT_VOICE_CALL_DEFAULTS,
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    fillerDelayMs: 60_000
  })
  m.start('s1')
  return { m, synth, emitted, emit: (e) => listeners.forEach((l) => l(e)) }
}

const answer = (h: ReturnType<typeof harness>, text: string): void => {
  h.emit({ type: 'draft', sessionId: 's1', draft: { content: text } } as unknown as AgentEvent)
  h.emit({
    type: 'message-added',
    message: { id: 'a1', sessionId: 's1', seq: 2, message: { role: 'assistant', content: text } }
  } as unknown as AgentEvent)
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const ttsApi = (model: string, baseUrl: string): TtsSettings => ({
  ...DEFAULT_TTS_SETTINGS,
  backend: 'api',
  api: { providerId: 'p', model, voice: null, baseUrl }
})

test('chamada: voz SEM suporte → tags tiradas antes da síntese (nunca lidas); tag sozinha não vira utterance', async () => {
  const h = harness(ttsApi('eleven_flash_v2_5', 'https://api.elevenlabs.io/v1'))
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.turn('me conta uma piada sobre programadores')
  answer(h, 'Claro! [laughs] Lá vai. [short pause] O bug era eu. [sighs]')
  await settle()
  assert.deepEqual(h.synth, ['Claro!', 'Lá vai.', 'O bug era eu.'])
  assert.ok(
    h.synth.every((t) => !t.includes('[')),
    'nenhuma tag chega à síntese'
  )
  // o contexto do turno não pede tags (voz sem suporte)
  const ctx = h.m.callContextFor({ id: 'c1', config: {} as ChatConfig }, { id: 's1', depth: 0 })
  assert.equal(ctx?.audioTagsActive, false)
  h.m.stop()
})

test('chamada: voz COM suporte → tags intactas na síntese; o contexto marca a instrução ativa', async () => {
  const h = harness(ttsApi('eleven_v3', 'https://api.elevenlabs.io/v1'))
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.turn('me conta uma piada sobre programadores')
  answer(h, 'Claro! [laughs] Lá vai. O bug era eu. [sighs]')
  await settle()
  assert.deepEqual(h.synth, ['Claro!', '[laughs] Lá vai.', 'O bug era eu. [sighs]'])
  const ctx = h.m.callContextFor({ id: 'c1', config: {} as ChatConfig }, { id: 's1', depth: 0 })
  assert.equal(ctx?.audioTagsActive, true)
  assert.equal(ctx?.audioTags, true)
  h.m.stop()
})
