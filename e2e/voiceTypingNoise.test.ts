// Digitação durante a chamada (2026-11-13): o teclado batendo perto do microfone contava como voz —
// abaixava a resposta, virava barge-in e o whisper "transcrevia" o barulho como "Tchau." (que pode
// encerrar a chamada). Aqui, com sinais sintéticos determinísticos (`fixtures/syntheticAudio.ts` —
// nada de microfone nem de rede real; STT falso):
//   1. o portão (`LevelGate`/`SpeechGate`) separa estalos de teclado de fala;
//   2. digitação durante a reprodução não abaixa a resposta, não vira barge-in nem abre um turno;
//   3. a sessão de transcrição não manda digitação ao STT, e um "Tchau." inventado sobre ela some;
//   4. alucinação conhecida na fala que INTERROMPEU o assistente sai (sozinha → turno vazio; grudada
//      no começo/fim → só ela sai); fora de um barge-in, "Tchau." segue valendo.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceTypingNoise.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatConfig } from '@shared/types'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_BARGE_IN,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_TURN_TIMING,
  DEFAULT_VOICE_CALL_DEFAULTS,
  type SttSettings
} from '@shared/voice'
import {
  HALLUCINATION_SHORT_VOICED_MS,
  IMPULSE_MEAN_OVER_MEDIAN_DB,
  LevelGate,
  MIN_VOICED_MS,
  SpeechGate,
  impulseRatioDb,
  isImpulsiveFrame,
  stripBargeInHallucinations,
  subblockEnergies
} from '@shared/speechGate'
import { PlaybackDuck } from '@shared/voicePolicy'
import { AdaptiveTurnGate } from '@shared/voiceTurn'
import { startTranscribeSession } from '../src/main/voice/session.ts'
import { VoiceCallManager } from '../src/main/voice/call.ts'
import {
  concat,
  mix,
  syntheticSpeech,
  syntheticTyping,
  toPcm16,
  whiteNoise,
  type TypingOptions
} from './fixtures/syntheticAudio.ts'

const SR = 16_000

/** Ruído de fundo de sala (−62 dBFS) somado a tudo — o piso adaptativo tem o que aprender. */
const room = (x: Float32Array): Float32Array => mix(x, whiteNoise(x.length, -62, 99))

/** Teclados: membrana (clique seco), mecânico (clique + "toc" grave), rápido e forte. */
const KEYBOARDS: [string, TypingOptions][] = [
  ['membrana 7/s', { keysPerSec: 7, tauMs: 3 }],
  ['forte e rápido 10/s', { keysPerSec: 10, tauMs: 2, peakDb: -8 }],
  ['sem toc 8/s', { keysPerSec: 8, tauMs: 4, thump: null, peakDb: -10 }],
  ['mecânico com toc 6/s', { keysPerSec: 6, tauMs: 6, thump: { hz: 150, tauMs: 10, db: -18 } }]
]
const VOICES: [string, Parameters<typeof syntheticSpeech>[1]][] = [
  ['grave', { f0: [120, 95] }],
  ['bem grave', { f0: [95, 80], seed: 9 }],
  ['aguda', { f0: [230, 190], seed: 4 }],
  ['baixa (−38 dB)', { db: -38, seed: 8 }],
  ['sílabas curtas', { syllableMs: [80, 120], gapMs: [60, 150], seed: 21 }]
]

/** Quadros do renderer (~33 ms) pelo `LevelGate.pushSamples` → ms com voz e quadros de voz. */
function rendererFrames(x: Float32Array, frameMs = 32): { voicedMs: number; flags: boolean[] } {
  const g = new LevelGate()
  const n = Math.round((SR * frameMs) / 1000)
  const flags: boolean[] = []
  for (let o = 0; o + n <= x.length; o += n) flags.push(g.pushSamples(x.subarray(o, o + n), SR))
  return { voicedMs: flags.filter(Boolean).length * frameMs, flags }
}

/** Tempo com nível acima da ativação (−45 dBFS) — o que o portão antigo (só RMS) contava. */
function loudMs(x: Float32Array, frameMs = 20): number {
  const n = Math.round((SR * frameMs) / 1000)
  let ms = 0
  for (let o = 0; o + n <= x.length; o += n) {
    let s = 0
    for (let i = o; i < o + n; i++) s += x[i] * x[i]
    if (20 * Math.log10(Math.sqrt(s / n) + 1e-9) >= -45) ms += frameMs
  }
  return ms
}

// ---------------- 1. o portão ----------------

test('estalo × fala por quadro: tecla concentra a energia (≥ 10 dB média/mediana); vogal espalha', () => {
  const typing = room(syntheticTyping(3000))
  const speech = room(syntheticSpeech(3000))
  const n = 320
  const ratios = (x: Float32Array): number[] => {
    const out: number[] = []
    for (let o = 0; o + n <= x.length; o += n) {
      const f = x.subarray(o, o + n)
      let s = 0
      for (const v of f) s += v * v
      if (20 * Math.log10(Math.sqrt(s / n)) >= -45)
        out.push(impulseRatioDb(subblockEnergies(f, SR)))
    }
    return out.sort((a, b) => a - b)
  }
  const sp = ratios(speech)
  const ty = ratios(typing)
  assert.ok(sp[Math.floor(sp.length * 0.9)] < IMPULSE_MEAN_OVER_MEDIAN_DB, `fala p90 ${sp.at(-1)}`)
  assert.ok(ty[Math.floor(ty.length / 2)] >= IMPULSE_MEAN_OVER_MEDIAN_DB, `teclas p50 ${ty[0]}`)
  // invariante de escala (float × PCM16) e casos degenerados
  const click = new Float32Array(320)
  click[100] = 0.8
  click[101] = -0.5
  assert.equal(isImpulsiveFrame(click, SR), true)
  assert.equal(
    isImpulsiveFrame(
      click.map((v) => v * 32768),
      SR
    ),
    true
  )
  assert.equal(isImpulsiveFrame(new Float32Array(320), SR), false, 'silêncio digital não é estalo')
  assert.equal(impulseRatioDb(new Float64Array(2)), 0, 'quadro curto demais')
})

test('LevelGate (quadros do renderer) e SpeechGate (STT): digitação não soma voz; fala quase toda conta', () => {
  for (const [name, o] of KEYBOARDS) {
    const x = room(syntheticTyping(6000, o))
    const before = loudMs(x)
    const r = rendererFrames(x)
    const g = new SpeechGate()
    g.push(toPcm16(x))
    const a = g.analyze(0, x.length * 2)
    // antes: o nível sozinho via "voz" em boa parte do tempo
    assert.ok(before >= 1500, `${name}: o nível (RMS) via ${before} ms de "voz"`)
    assert.ok(r.voicedMs <= 400, `${name}: renderer ${r.voicedMs} ms em 6 s`)
    assert.ok(a.voicedMs < MIN_VOICED_MS * 2, `${name}: portão do STT ${a.voicedMs} ms em 6 s`)
  }
  for (const [name, o] of VOICES) {
    const x = room(syntheticSpeech(3000, o))
    const loud = loudMs(x)
    const r = rendererFrames(x)
    const g = new SpeechGate()
    g.push(toPcm16(x))
    const a = g.analyze(0, x.length * 2)
    // o portão do STT conta de volta o começo de cada sequência; o tempo real do renderer só conta
    // a partir da confirmação (~60 ms depois do começo de cada trecho de voz)
    assert.ok(a.voicedMs >= loud * 0.8, `voz ${name}: STT ${a.voicedMs} de ${loud} ms`)
    assert.ok(r.voicedMs >= loud * 0.55, `voz ${name}: renderer ${r.voicedMs} de ${loud} ms`)
    assert.ok(a.send, `voz ${name}: vai ao STT`)
  }
  // falando E digitando: a fala continua sendo fala
  const both = room(mix(syntheticSpeech(3000), syntheticTyping(3000)))
  const g = new SpeechGate()
  g.push(toPcm16(both))
  assert.ok(g.analyze(0, both.length * 2).voicedMs >= 1800)
})

test('sequência mínima: estalo isolado não é fala; o começo da sílaba confirmada é contado de volta', () => {
  const g = new LevelGate()
  // quadros "altos" (−30 dB) e não impulsivos: 1º e 2º quadro (40 ms) ainda não; o 3º confirma
  assert.equal(g.pushDb(-30, 20), false)
  assert.equal(g.pushDb(-30, 20), false)
  assert.equal(g.pushDb(-30, 20), true)
  assert.equal(g.backfillFrames, 2, 'os 2 quadros anteriores entram na fala')
  assert.equal(g.pushDb(-30, 20), true)
  assert.equal(g.backfillFrames, 0)
  // lacuna curta dentro da fala confirmada (≤ 150 ms) não exige nova confirmação
  for (let i = 0; i < 5; i++) assert.equal(g.pushDb(-80, 20), false)
  assert.equal(g.pushDb(-30, 20), true)
  // lacuna longa: recomeça
  for (let i = 0; i < 10; i++) g.pushDb(-80, 20)
  assert.equal(g.pushDb(-30, 20), false)
  // estalo no meio de uma sequência não confirmada a zera (caudas de teclas não se somam)
  const h = new LevelGate()
  assert.equal(h.pushDb(-30, 33), false)
  assert.equal(h.pushDb(-25, 33, true), false, 'estalo')
  assert.equal(h.pushDb(-30, 33), false, 'recomeçou')
  assert.equal(h.pushDb(-30, 33), true)
  // o portão do STT marca o começo de volta: 300 ms de fala = 300 ms de voz
  const sg = new SpeechGate()
  sg.push(
    toPcm16(
      room(
        concat(
          new Float32Array(SR / 2),
          syntheticSpeech(300, { syllableMs: [300, 300] }),
          new Float32Array(SR / 2)
        )
      )
    )
  )
  const a = sg.analyze(0, SR * 2 * 1.3)
  assert.ok(a.voicedMs >= 240, `voz ${a.voicedMs}`)
})

// ---------------- 2. chamada: digitação durante a reprodução ----------------

/**
 * O "sensor" da chamada (= `useVoiceCall.onLevel`): quadros de 32 ms pelo `LevelGate` → turno
 * (`AdaptiveTurnGate`) e, com a resposta tocando, o ducking/barge-in (`PlaybackDuck`).
 */
function callSensor(x: Float32Array): { starts: number; ducks: number; bargeIns: number } {
  const frameMs = 32
  const n = (SR * frameMs) / 1000
  const level = new LevelGate()
  const gate = new AdaptiveTurnGate(DEFAULT_TURN_TIMING, 0.5)
  const hold = new PlaybackDuck(DEFAULT_BARGE_IN)
  let starts = 0
  let ducks = 0
  let bargeIns = 0
  for (let o = 0; o + n <= x.length; o += n) {
    const v = level.pushSamples(x.subarray(o, o + n), SR, { frameMs }) ? 1 : 0
    const ev = gate.push(v, frameMs)
    if (ev === 'start') {
      starts++
      if (hold.start(v, frameMs, 0.5) === 'duck') ducks++
      continue
    }
    if (ev === 'end' && !hold.open) continue
    if (hold.open) {
      const e = hold.frame(v, frameMs, 0.5)
      if (e === 'duck') ducks++
      else if (e === 'barge-in') {
        bargeIns++
        hold.reset()
      } else if (e === 'restore') gate.reset()
    }
  }
  return { starts, ducks, bargeIns }
}

test('digitação durante a resposta: não abaixa a voz, não vira barge-in (fala insistente vira)', () => {
  for (const [name, o] of KEYBOARDS) {
    const r = callSensor(room(syntheticTyping(10_000, o)))
    assert.equal(r.ducks, 0, `${name}: ducks ${r.ducks} (aberturas ${r.starts})`)
    assert.equal(r.bargeIns, 0, `${name}: barge-ins ${r.bargeIns}`)
  }
  const membrane = callSensor(room(syntheticTyping(10_000, KEYBOARDS[0][1])))
  assert.equal(membrane.starts, 0, 'teclado de membrana nem abre episódio/turno')
  // o usuário falando por cima (com ou sem teclado junto): abaixa e vira barge-in
  for (const x of [syntheticSpeech(3000), mix(syntheticSpeech(3000), syntheticTyping(3000))]) {
    const r = callSensor(room(x))
    assert.ok(r.ducks >= 1, 'abaixou')
    assert.ok(r.bargeIns >= 1, 'virou barge-in')
  }
})

// ---------------- 3. sessão de transcrição (STT falso) ----------------

const sttSettings = (): SttSettings => ({
  ...DEFAULT_STT_SETTINGS,
  livePartials: false,
  mode: 'api',
  api: {
    ...DEFAULT_STT_SETTINGS.api,
    providerId: 'p-groq',
    baseUrl: 'https://stt.example/v1',
    apiKey: 'sk-test'
  }
})

/** STT falso: o whisper "alucina" o texto dado (contando as requests). */
function fakeStt(text: string): { calls: () => number; restore: () => void } {
  let calls = 0
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    calls++
    return new Response(JSON.stringify({ text }), { status: 200 })
  }) as typeof fetch
  return { calls: () => calls, restore: () => (globalThis.fetch = orig) }
}

test('sessão: digitação não vai ao STT; o "Tchau." inventado sobre ela nunca vira texto', async (t) => {
  for (const [name, o] of KEYBOARDS) {
    const stt = fakeStt('Tchau.')
    t.after(stt.restore)
    const s = startTranscribeSession({ settings: sttSettings() })
    s.push(toPcm16(room(syntheticTyping(4000, o))), SR)
    const r = await s.stop()
    stt.restore()
    assert.equal(r.text, '', `${name}: "${r.text}" (${stt.calls()} requests)`)
  }
  // a fala (com teclado junto) continua indo ao STT e o texto real passa
  const stt = fakeStt('Abre o arquivo de configuração.')
  t.after(stt.restore)
  const s = startTranscribeSession({ settings: sttSettings() })
  s.push(
    toPcm16(room(concat(syntheticTyping(1500), mix(syntheticSpeech(2000), syntheticTyping(2000))))),
    SR
  )
  const r = await s.stop()
  assert.equal(r.text, 'Abre o arquivo de configuração.')
  assert.equal(stt.calls(), 1)
  assert.ok(HALLUCINATION_SHORT_VOICED_MS > MIN_VOICED_MS)
})

// ---------------- 4. a fala que interrompeu o assistente ----------------

test('stripBargeInHallucinations: sozinha some; grudada no começo/fim sai; texto real intacto', () => {
  assert.equal(stripBargeInHallucinations('Tchau.'), '')
  assert.equal(stripBargeInHallucinations('Tchau. Tchau.'), '')
  assert.equal(stripBargeInHallucinations(' Obrigado. '), '')
  assert.equal(stripBargeInHallucinations('…'), '')
  assert.equal(stripBargeInHallucinations('Espera aí. Tchau.'), 'Espera aí.')
  assert.equal(
    stripBargeInHallucinations('Tchau. Espera aí, não é isso.'),
    'Espera aí, não é isso.'
  )
  assert.equal(stripBargeInHallucinations('Obrigado. Abre o README. Tchau!'), 'Abre o README.')
  assert.equal(
    stripBargeInHallucinations('Tchau, até amanhã às nove.'),
    'Tchau, até amanhã às nove.'
  )
  assert.equal(stripBargeInHallucinations('Para, não precisa.'), 'Para, não precisa.')
  assert.equal(stripBargeInHallucinations(''), '')
})

function manager(): { m: VoiceCallManager; sent: string[] } {
  const sent: string[] = []
  const m = new VoiceCallManager({
    sendTurn: (_sid, text) => void sent.push(text),
    synth: async () => ({ audio: new Uint8Array([1, 2]), mime: 'audio/wav' }),
    emitState: () => {},
    emitUtterance: () => {},
    emitUtteranceCancel: () => {},
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults: {
        ...DEFAULT_VOICE_CALL_DEFAULTS,
        fillers: { enabled: false, prompt: null, delayMs: 250, pool: null }
      },
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: () => () => {}
  })
  m.start('s1')
  return { m, sent }
}

test('chamada: "Tchau." na fala que interrompeu o assistente não vira turno; fora do barge-in vale', () => {
  // barge-in (o renderer confirmou a fala por cima) → a transcrição só "Tchau." = turno vazio
  const a = manager()
  a.m.bargeIn({ playedIds: [] })
  a.m.speechEnd()
  a.m.turn('Tchau.')
  assert.deepEqual(a.sent, [], 'nada enviado (o modelo nunca vê o "Tchau." inventado)')
  // a próxima fala, normal, vale inteira — inclusive um "tchau" de verdade
  a.m.speechBegin()
  a.m.speechEnd()
  a.m.turn('Tchau.')
  assert.deepEqual(a.sent, ['Tchau.'])
  a.m.stop()

  // grudada no fim de uma fala real que interrompeu: só ela sai
  const b = manager()
  b.m.bargeIn({ playedIds: [] })
  b.m.speechEnd()
  b.m.turn('Espera aí, não é isso. Tchau.')
  assert.deepEqual(b.sent, ['Espera aí, não é isso.'])
  b.m.stop()

  // mudo no meio da fala do barge-in (o renderer descarta a fala, sem turno): a marca não vaza
  const c = manager()
  c.m.bargeIn({ playedIds: [] })
  c.m.mute(true)
  c.m.mute(false)
  c.m.speechBegin()
  c.m.speechEnd()
  c.m.turn('Tchau.')
  assert.deepEqual(c.sent, ['Tchau.'])
  c.m.stop()
})
