// Fala da chamada SEM pedaços (SPEC → "ElevenLabs direto" e "Streaming na chamada"): a resposta
// inteira num contexto só do WebSocket, repartida em utterances por sentença pelo alinhamento
// (`alignedSegments.ts`), e as utterances PCM seguidas emendadas sem buraco no player
// (`UtteranceQueue` + relógio compartilhado), renderizadas num AudioContext falso com relógio manual.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatConfig } from '@shared/types'
import type { VoiceCallUtteranceChunkEvent, VoiceCallUtteranceEvent } from '@shared/ipc'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  normalizeTtsSettings,
  type TtsSettings
} from '@shared/voice'
import {
  AlignedPcmSegmenter,
  speechUnits,
  type ElevenLabsAlignment
} from '../src/main/voice/alignedSegments.ts'
import {
  ElevenLabsCallTts,
  elevenLabsCallOptions,
  unsentSuffix,
  type TtsTextFeed
} from '../src/main/voice/elevenlabsStream.ts'
import { TtsStreamRelay } from '../src/main/voice/ttsStreamRelay.ts'
import { VoiceCallManager, type VoiceCallAmend } from '../src/main/voice/call.ts'
import {
  PCM_FADE_IN_MS,
  PCM_START_EARLY_FRAMES,
  PCM_VOLUME_SMOOTH_S,
  pcmNodeStartTime,
  PcmStreamSource,
  UtteranceQueue,
  WebAudioPcmPlayer,
  pcm16ToFloat,
  pcmRateOf
} from '../src/renderer/src/lib/voice/utteranceQueue.ts'
import { startElevenLabsFake } from './fakes/elevenlabsFake.mjs'

const RATE = 24_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 3000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(5)
  }
}
async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const c of chunks) parts.push(c)
  return Buffer.concat(parts)
}

/** PCM16 com o valor de cada amostra = índice (mod 30000) — dá para saber de onde veio cada fatia. */
function rampPcm(samples: number, from = 0): Uint8Array {
  const b = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) b.writeInt16LE(((from + i) % 30000) + 1, i * 2)
  return new Uint8Array(b.buffer, b.byteOffset, b.length)
}
const msToSamples = (ms: number): number => Math.round((ms * RATE) / 1000)

/** Alinhamento de um texto com `msPerChar` por char, a partir de `fromChar`, em blocos de `n`. */
function alignBlocks(text: string, msPerChar: number, blockChars: number): ElevenLabsAlignment[] {
  const out: ElevenLabsAlignment[] = []
  for (let i = 0; i < text.length; i += blockChars) {
    const chars = [...text.slice(i, i + blockChars)]
    out.push({
      chars,
      charStartTimesMs: chars.map((_, k) => k * msPerChar),
      charDurationsMs: chars.map(() => msPerChar)
    })
  }
  return out
}

// ---------------- segmentador por alinhamento (puro) ----------------

test('segmentador: fronteira no meio da pausa entre as sentenças; as fatias somam o PCM exato', async () => {
  // "Oi tudo. " (9 chars) + pausa longa no '.' e ' ' + "Bem sim." — 50 ms por char
  const text = 'Oi tudo. Bem sim. '
  const seg = new AlignedPcmSegmenter({ sampleRate: RATE })
  const a = seg.addSegment(speechUnits('Oi tudo.'))
  const b = seg.addSegment(speechUnits('Bem sim.'))
  const total = msToSamples(text.length * 50)
  const pcm = rampPcm(total)
  // alinhamento em blocos de 4 chars, PCM em pedaços de tamanho que não coincide com os blocos
  for (const al of alignBlocks(text, 50, 4)) seg.pushAlignment(al)
  for (let off = 0; off < pcm.length; off += 1234) seg.pushPcm(pcm.subarray(off, off + 1234))
  seg.finish()
  const s0 = await collect(seg.stream(a))
  const s1 = await collect(seg.stream(b))
  assert.equal(s0.length + s1.length, pcm.length, 'nada perdido nem duplicado')
  assert.deepEqual(Buffer.concat([s0, s1]), Buffer.from(pcm), 'na ordem, amostra a amostra')
  // 'o' de "tudo" termina em 7×50=350 ms; 'B' começa em 9×50=450 ms → corte em 400 ms
  assert.equal(s0.length / 2, msToSamples(400))
})

test('segmentador: alinhamento chegando ANTES do áudio (fronteira à frente do recebido) — nada pulado', async () => {
  const text = 'Oi tudo. Bem sim. '
  const seg = new AlignedPcmSegmenter({ sampleRate: RATE })
  const a = seg.addSegment(speechUnits('Oi tudo.'))
  const b = seg.addSegment(speechUnits('Bem sim.'))
  const p0 = collect(seg.stream(a))
  const p1 = collect(seg.stream(b))
  for (const al of alignBlocks(text, 50, 50)) seg.pushAlignment(al) // tudo alinhado já
  const pcm = rampPcm(msToSamples(text.length * 50))
  for (let off = 0; off < pcm.length; off += 998) {
    seg.pushPcm(pcm.subarray(off, off + 998))
    await sleep(0)
  }
  seg.finish()
  const [s0, s1] = await Promise.all([p0, p1])
  assert.deepEqual(Buffer.concat([s0, s1]), Buffer.from(pcm))
  assert.equal(s0.length / 2, msToSamples(400))
})

test('segmentador: antes da fronteira a fatia só solta até a última unidade alinhada; última cortada sem nada além solta tudo', async () => {
  const seg = new AlignedPcmSegmenter({ sampleRate: RATE })
  const a = seg.addSegment(speechUnits('Olá.'))
  seg.setTailOpen(true) // palavras da próxima sentença já entregues
  const got: number[] = []
  const reader = (async () => {
    for await (const c of seg.stream(a)) got.push(c.length / 2)
  })()
  seg.pushAlignment({
    chars: [...'Olá. '],
    charStartTimesMs: [0, 50, 100, 150, 200],
    charDurationsMs: [50, 50, 50, 50, 50]
  })
  seg.pushPcm(rampPcm(msToSamples(400)))
  await sleep(5)
  assert.equal(
    got.reduce((x, y) => x + y, 0),
    msToSamples(150),
    'até o fim do "á" (a pausa pode ser da próxima)'
  )
  seg.setTailOpen(false) // nada além dela no contexto: o que chegou é dela
  await sleep(5)
  assert.equal(
    got.reduce((x, y) => x + y, 0),
    msToSamples(400)
  )
  // só o FIM espera: o isFinal fecha
  seg.pushPcm(rampPcm(msToSamples(100)))
  seg.finish()
  await reader
  assert.equal(
    got.reduce((x, y) => x + y, 0),
    msToSamples(500)
  )
})

test('segmentador: sem alinhamento → estimativa por unidade; isFinal reparte o resto; fatia vazia vira um respiro de silêncio', async () => {
  const seg = new AlignedPcmSegmenter({
    sampleRate: RATE,
    fallbackMsPerUnit: 70,
    noAlignmentAfterMs: 300
  })
  const a = seg.addSegment(10)
  const b = seg.addSegment(0) // sentença sem letras ("…")
  const c = seg.addSegment(10)
  seg.pushPcm(rampPcm(msToSamples(200)))
  assert.equal(seg.estimating, false)
  seg.pushPcm(rampPcm(msToSamples(1300), msToSamples(200)))
  assert.equal(seg.estimating, true, 'sem alinhamento depois de 300 ms de áudio')
  seg.finish()
  const s0 = await collect(seg.stream(a))
  const s1 = await collect(seg.stream(b))
  const s2 = await collect(seg.stream(c))
  // estimativa: 10 unidades × 70 ms = 700 ms (meio da "pausa" entre a 10ª e a 11ª unidade)
  assert.equal(s0.length / 2, msToSamples(700))
  assert.equal(s1.length / 2, msToSamples(20), 'respiro de silêncio')
  assert.ok(s1.every((v) => v === 0))
  assert.equal(s0.length + s2.length, msToSamples(1500) * 2, 'todo o áudio real entregue')
})

test('segmentador: abort (barge-in) → AbortError nos consumidores; fatia descartada não afeta a seguinte', async () => {
  const seg = new AlignedPcmSegmenter({ sampleRate: RATE })
  const a = seg.addSegment(2)
  const b = seg.addSegment(2)
  seg.pushAlignment({
    chars: [...'ab cd'],
    charStartTimesMs: [0, 10, 20, 30, 40],
    charDurationsMs: [10, 10, 10, 10, 10]
  })
  seg.pushPcm(rampPcm(msToSamples(50)))
  seg.drop(a)
  seg.finish()
  const s1 = await collect(seg.stream(b))
  assert.equal(
    s1.length / 2,
    msToSamples(25),
    'a fatia b começa no meio da pausa, mesmo com a descartada'
  )
  const seg2 = new AlignedPcmSegmenter({ sampleRate: RATE })
  const x = seg2.addSegment(5)
  const p = collect(seg2.stream(x))
  seg2.abort()
  await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError')
})

test('unsentSuffix: sufixo direto; divergência de espaços resolvida pelas unidades', () => {
  assert.equal(unsentSuffix('Olá ', 'Olá meu amigo '), 'meu amigo ')
  assert.equal(unsentSuffix('Olá meu amigo ', 'Olá meu '), '')
  assert.equal(unsentSuffix('Oi. Tudo ', 'Oi.\nTudo bem? '), 'bem? ')
  assert.equal(unsentSuffix('', 'Oi '), 'Oi ')
})

// ---------------- ElevenLabsCallTts: um contexto por resposta (fake com alinhamento) ----------------

const KEY = 'test-key'
const ttsSettings = (baseUrl: string): TtsSettings => {
  const s = normalizeTtsSettings({
    backend: 'api',
    api: {
      providerId: 'p-el',
      baseUrl,
      apiKey: KEY,
      model: 'eleven_flash_v2_5',
      voice: 'EXAVITQu4vr4xnSDxMaL'
    }
  })
  // como o `getVoiceSettings` resolve o provedor (base/chave/tipo não são gravados nas settings)
  return { ...s, api: { ...s.api, baseUrl, apiKey: KEY, providerKind: 'elevenlabs' } }
}
/** Bytes de PCM que o fake gera para `text` (240 amostras/char × 2 bytes). */
const pcmBytes = (text: string): number => text.trim().length * 240 * 2

test('WS: resposta inteira num contexto — flush por sentença, sem close até o fim; cada fatia ≈ o áudio da sua sentença', async () => {
  const fake = await startElevenLabsFake({ chunkSamples: 1000 })
  const el = new ElevenLabsCallTts({ config: () => elevenLabsCallOptions(ttsSettings(fake.url)) })
  try {
    el.begin()
    const sentences = [
      'Olá, tudo bem com você?',
      'Hoje o dia está bonito.',
      'Vamos conversar um pouco.'
    ]
    let feed = ''
    const streams: Promise<Uint8Array>[] = []
    for (const s of sentences) {
      for (const w of s.split(/(?<= )/)) {
        feed += w
        el.partial(feed)
        await sleep(1)
      }
      el.cut(s)
      feed = ''
      streams.push(collect(el.synth(s).chunks))
    }
    await waitFor(() => fake.flushCount === 3, 2000, 'flushes')
    assert.ok(!fake.connections[0].frames.some((f) => f.close_context), 'contexto aberto até o fim')
    el.end()
    const slices = await Promise.all(streams)
    const ids = new Set(fake.connections[0].frames.map((f) => f.context_id).filter(Boolean))
    assert.equal(ids.size, 1, 'um contexto só')
    assert.ok(fake.connections[0].frames.at(-1)?.close_context, 'close_context no fim da resposta')
    const total = slices.reduce((a, s) => a + s.length, 0)
    assert.equal(
      total,
      sentences.reduce((a, s) => a + pcmBytes(s), 0),
      'todo o PCM, nada duplicado'
    )
    // a fronteira cai no meio do último char (pontuação) — ±1 char de áudio
    slices.forEach((s, i) =>
      assert.ok(Math.abs(s.length - pcmBytes(sentences[i])) <= 480, `fatia ${i}: ${s.length}`)
    )
    assert.deepEqual(fake.protocolErrors, [])
  } finally {
    el.close()
    await fake.close()
  }
})

test('WS: corte forçado dentro do texto já entregue e proxy sem alinhamento — o áudio todo sai, na ordem', async () => {
  for (const alignment of [true, false]) {
    const fake = await startElevenLabsFake({ chunkSamples: 1000, alignment })
    const el = new ElevenLabsCallTts({ config: () => elevenLabsCallOptions(ttsSettings(fake.url)) })
    try {
      el.begin()
      el.partial('Uma frase sem ponto que segue e segue ')
      // o cortador forçou o corte antes do que já foi entregue
      el.cut('Uma frase sem ponto')
      const s1 = collect(el.synth('Uma frase sem ponto').chunks)
      el.partial('que segue e segue até o fim')
      el.cut('que segue e segue até o fim.')
      const s2 = collect(el.synth('que segue e segue até o fim.').chunks)
      el.end()
      const [a, b] = await Promise.all([s1, s2])
      const sent = fake.connections[0].frames
        .filter((f) => typeof f.text === 'string' && f.text !== ' ')
        .map((f) => f.text)
        .join('')
      assert.equal(
        sent.replace(/\s+/g, ' ').trim(),
        'Uma frase sem ponto que segue e segue até o fim.',
        'nada repetido'
      )
      assert.equal(
        a.length + b.length,
        pcmBytes('Uma frase sem ponto que segue e segue') + pcmBytes('até o fim.')
      )
      assert.ok(a.length > 0 && b.length > 0)
      if (alignment)
        assert.ok(Math.abs(a.length - pcmBytes('Uma frase sem ponto')) <= 480, `${a.length}`)
    } finally {
      el.close()
      await fake.close()
    }
  }
})

// ---------------- chamada: vírgula e histórico no barge-in ----------------

function callWith(opts: {
  ttsFeed?: () => TtsTextFeed | null
  synth?: (t: string, s: AbortSignal) => Promise<{ audio: Uint8Array; mime: string }>
  emitUtterance?: (u: VoiceCallUtteranceEvent) => void
  amends?: VoiceCallAmend[]
  tts?: TtsSettings
}): { m: VoiceCallManager; emit: (e: AgentEvent) => void; synthCalls: string[] } {
  const listeners: ((e: AgentEvent) => void)[] = []
  const synthCalls: string[] = []
  const m = new VoiceCallManager({
    sendTurn: () => {},
    synth:
      opts.synth ??
      (async (text) => {
        synthCalls.push(text)
        return { audio: new TextEncoder().encode(text), mime: 'audio/wav' }
      }),
    emitState: () => {},
    emitUtterance: (u) => opts.emitUtterance?.(u as VoiceCallUtteranceEvent),
    emitUtteranceCancel: () => {},
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults: { ...DEFAULT_VOICE_CALL_DEFAULTS, fillers: { enabled: false, prompt: null } },
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: opts.tts ?? DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    amendTurn: async (_sid, a) => {
      opts.amends?.push(a)
    },
    ...(opts.ttsFeed ? { ttsFeed: opts.ttsFeed } : {})
  })
  return { m, emit: (e) => listeners.forEach((l) => l(e)), synthCalls }
}

test('chamada: com o TTS de texto em streaming a 1ª frase NÃO corta na vírgula; sem ele, corta', async () => {
  const answer = 'Os polvos têm três corações e sangue azul, porque a hemocianina usa cobre. Legal.'
  const cuts: string[] = []
  const feed: TtsTextFeed = {
    begin: () => {},
    partial: () => {},
    cut: (t) => cuts.push(t),
    reset: () => {},
    close: () => {}
  }
  for (const withFeed of [true, false]) {
    cuts.length = 0
    const { m, emit, synthCalls } = callWith(withFeed ? { ttsFeed: () => feed } : {})
    m.start('s1')
    emit({
      type: 'message-added',
      message: { id: 'm1', sessionId: 's1', message: { role: 'user', content: 'oi' } }
    } as unknown as AgentEvent)
    emit({ type: 'draft', sessionId: 's1', draft: { content: answer } } as unknown as AgentEvent)
    emit({
      type: 'message-added',
      message: {
        id: 'a1',
        sessionId: 's1',
        message: { role: 'assistant', content: answer },
        meta: {}
      }
    } as unknown as AgentEvent)
    await waitFor(() => synthCalls.length >= 2)
    if (withFeed) {
      assert.deepEqual(synthCalls, [
        'Os polvos têm três corações e sangue azul, porque a hemocianina usa cobre.',
        'Legal.'
      ])
      assert.deepEqual(cuts, synthCalls)
    } else {
      assert.equal(synthCalls[0], 'Os polvos têm três corações e sangue azul,')
    }
    m.stop()
  }
})

test('ponta a ponta (WS fake): barge-in na 2ª frase → histórico só com o que tocou; fim da resposta fecha o contexto', async () => {
  const fake = await startElevenLabsFake({ chunkSamples: 1200, chunkDelayMs: 8 })
  const el = new ElevenLabsCallTts({ config: () => elevenLabsCallOptions(ttsSettings(fake.url)) })
  const utts: VoiceCallUtteranceEvent[] = []
  const chunks: VoiceCallUtteranceChunkEvent[] = []
  const relay = new TtsStreamRelay({
    emitUtterance: (u) => utts.push(u),
    emitChunk: (c) => chunks.push(c),
    prebufferMs: 50
  })
  const amends: VoiceCallAmend[] = []
  const { m, emit } = callWith({
    ttsFeed: () => el,
    synth: (text, signal) => relay.synth(signal, async (s) => el.synth(text, s)),
    emitUtterance: (u) => relay.emitUtterance(u),
    amends,
    tts: ttsSettings(fake.url)
  })
  try {
    m.start('s1')
    emit({
      type: 'message-added',
      message: { id: 'm1', sessionId: 's1', message: { role: 'user', content: 'conta' } }
    } as unknown as AgentEvent)
    const answer =
      'Primeira frase da resposta. Segunda frase que vai ser interrompida. Terceira frase nunca ouvida.'
    let acc = ''
    for (const w of answer.split(/(?<= )/)) {
      acc += w
      emit({ type: 'draft', sessionId: 's1', draft: { content: acc } } as unknown as AgentEvent)
      await sleep(1)
    }
    emit({
      type: 'message-added',
      message: {
        id: 'a1',
        sessionId: 's1',
        message: { role: 'assistant', content: answer },
        meta: {}
      }
    } as unknown as AgentEvent)
    await waitFor(() => utts.length >= 2, 3000, 'duas utterances')
    // o renderer tocou u1 inteira e começou u2: o usuário interrompe
    m.bargeIn({ playedIds: [utts[0].id] })
    await waitFor(() => amends.length === 1, 2000, 'amend')
    const spoken = typeof amends[0].spoken === 'function' ? amends[0].spoken() : amends[0].spoken
    assert.deepEqual(spoken, { a1: ['Primeira frase da resposta.'] })
    // um contexto só para a resposta; o barge-in derrubou o que ainda gerava
    const ids = new Set(fake.connections[0].frames.map((f) => f.context_id).filter(Boolean))
    assert.equal(ids.size, 1)
    m.stop()
  } finally {
    el.close()
    await fake.close()
  }
})

// ---------------- player: utterances PCM emendadas sem buraco ----------------

/** AudioContext falso com relógio MANUAL (`advance`): nós terminam quando o relógio passa do fim. */
class ManualAudioContext {
  readonly sampleRate = RATE
  currentTime = 0
  state = 'running'
  readonly destination = {}
  readonly out = new Float32Array(RATE * 20)
  readonly placed: {
    frame: number
    len: number
    first: number
    stopped: boolean
    /** O `when` de `start(when)` × taxa (quadros, sem arredondar). */
    at: number
  }[] = []
  /** Mudanças de volume no relógio do áudio (`setTargetAtTime`). */
  readonly gainTargets: { value: number; at: number; tau: number }[] = []
  #live: { end: number; node: { onended: null | (() => void) }; rec: { stopped: boolean } }[] = []
  createGain(): unknown {
    const targets = this.gainTargets
    const gain = {
      value: 1,
      setTargetAtTime(value: number, at: number, tau: number): void {
        targets.push({ value, at, tau })
      }
    }
    return { gain, connect: () => undefined, disconnect: () => undefined }
  }
  createBuffer(_ch: number, n: number): unknown {
    const data = new Float32Array(n)
    return { length: n, sampleRate: RATE, getChannelData: () => data }
  }
  createBufferSource(): unknown {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ctx = this
    const node = {
      buffer: null as null | { length: number; getChannelData(): Float32Array },
      onended: null as null | (() => void),
      connect: (): void => undefined,
      stop(): void {
        const l = ctx.#live.find((x) => x.node === node)
        if (l) {
          l.rec.stopped = true
          ctx.#live = ctx.#live.filter((x) => x !== l)
        }
      },
      start(at: number): void {
        const data = node.buffer!.getChannelData()
        const frame = Math.round(at * RATE)
        const rec = { frame, len: data.length, first: data[0], stopped: false, at: at * RATE }
        ctx.placed.push(rec)
        for (let i = 0; i < data.length; i++) ctx.out[frame + i] += data[i]
        ctx.#live.push({ end: (frame + data.length) / RATE, node, rec })
      }
    }
    return node
  }
  async resume(): Promise<void> {
    return undefined
  }
  /** Anda o relógio até `t` (s), disparando `onended` dos nós que terminaram, na ordem. */
  async advance(t: number): Promise<void> {
    this.currentTime = t
    const done = this.#live.filter((l) => l.end <= t + 1e-9).sort((a, b) => a.end - b.end)
    this.#live = this.#live.filter((l) => !done.includes(l))
    for (const d of done) d.node.onended?.()
    await sleep(0)
  }
}

function pcmQueue(ctx: ManualAudioContext, events: string[]): UtteranceQueue {
  return new UtteranceQueue({
    playerFactory: (audio, mime, stream) => {
      const rate = pcmRateOf(mime)!
      let source = stream
      if (!source) {
        source = new PcmStreamSource(rate, audio)
        source.end()
      }
      return new WebAudioPcmPlayer(source, () => ctx as unknown as AudioContext)
    },
    onItem: ({ item, phase }) => events.push(`${phase}:${item.id}@${ctx.currentTime.toFixed(3)}`)
  })
}

const MIME = `audio/pcm;rate=${RATE}`

test('player: frases PCM seguidas se emendam no quadro exato, sem rampa na emenda; a 2ª só "começa" quando a 1ª termina', async () => {
  const ctx = new ManualAudioContext()
  const events: string[] = []
  const q = pcmQueue(ctx, events)
  const a = rampPcm(msToSamples(300), 0)
  const b = rampPcm(msToSamples(200), 5000)
  q.enqueue({ id: 'u1', audio: a.subarray(0, 4800), mime: MIME, kind: 'sentence', streaming: true })
  await sleep(1)
  q.pushChunk({ id: 'u1', pcm: a.subarray(4800), done: false })
  q.enqueue({ id: 'u2', audio: b.subarray(0, 2000), mime: MIME, kind: 'sentence', streaming: true })
  q.pushChunk({ id: 'u1', pcm: new Uint8Array(0), done: true })
  await sleep(1)
  q.pushChunk({ id: 'u2', pcm: b.subarray(2000), done: true })
  await sleep(1)
  // u2 pré-iniciada: já agendada, mas ainda não "começou" (não conta como ouvida)
  assert.deepEqual(events, ['start:u1@0.000'])
  assert.deepEqual(q.queuedIds, ['u2'])
  const p = ctx.placed
  const u1End = p[1].frame + p[1].len
  assert.equal(p[2].frame, u1End, 'o 1º nó da u2 começa exatamente onde a u1 termina')
  // sem rampa na emenda: a 1ª amostra da u2 é a do PCM (a rampa a teria zerado quase)
  assert.equal(ctx.out[u1End], pcm16ToFloat(b.subarray(0, 2))[0])
  // a 1ª utterance da fala entra com rampa (começo)
  assert.ok(Math.abs(ctx.out[p[0].frame]) < Math.abs(pcm16ToFloat(a.subarray(0, 2))[0]))
  await ctx.advance(u1End / RATE)
  assert.deepEqual(events, [
    'start:u1@0.000',
    `end:u1@${(u1End / RATE).toFixed(3)}`,
    `start:u2@${(u1End / RATE).toFixed(3)}`
  ])
  assert.equal(q.current?.id, 'u2')
  // nenhum quadro de silêncio entre as duas
  const start = p[0].frame + Math.floor((PCM_FADE_IN_MS / 1000) * RATE)
  for (let i = start; i < u1End + b.length / 2; i++)
    assert.notEqual(ctx.out[i], 0, `buraco no quadro ${i}`)
  await ctx.advance(5)
  assert.equal(q.state, 'idle')
})

test('player: barge-in com a seguinte já agendada — as duas param e a próxima fala recomeça já (sem esperar o áudio cortado)', async () => {
  const ctx = new ManualAudioContext()
  const events: string[] = []
  const q = pcmQueue(ctx, events)
  q.enqueue({ id: 'u1', audio: rampPcm(msToSamples(1000)), mime: MIME, kind: 'sentence' })
  q.enqueue({ id: 'u2', audio: rampPcm(msToSamples(1000)), mime: MIME, kind: 'sentence' })
  await sleep(1)
  assert.equal(ctx.placed.length, 2, 'u2 pré-agendada')
  await ctx.advance(0.4)
  q.cancel()
  assert.ok(
    ctx.placed.every((x) => x.stopped),
    'os dois nós parados'
  )
  q.enqueue({ id: 'u3', audio: rampPcm(msToSamples(100)), mime: MIME, kind: 'sentence' })
  await sleep(1)
  const u3 = ctx.placed[2]
  assert.equal(u3.frame, Math.ceil((0.4 + 0.03) * RATE), 'agora + antecedência, não depois de 2 s')
  assert.ok(Math.abs(u3.first) < 0.01, 'recomeço com rampa de entrada')
  assert.deepEqual(
    events.filter((e) => e.startsWith('start')),
    ['start:u1@0.000', 'start:u3@0.400']
  )
})

test('player: drop da atual com a seguinte agendada — a seguinte recomeça do zero, agora', async () => {
  const ctx = new ManualAudioContext()
  const events: string[] = []
  const q = pcmQueue(ctx, events)
  q.enqueue({ id: 'f1', audio: rampPcm(msToSamples(1000)), mime: MIME, kind: 'filler' })
  q.enqueue({ id: 'u1', audio: rampPcm(msToSamples(500)), mime: MIME, kind: 'sentence' })
  await sleep(1)
  await ctx.advance(0.2)
  q.drop('f1')
  await sleep(1)
  assert.equal(q.current?.id, 'u1')
  const restarted = ctx.placed.at(-1)!
  assert.equal(restarted.frame, Math.ceil((0.2 + 0.03) * RATE))
  assert.equal(restarted.len, msToSamples(500), 'u1 inteira, do começo')
})

test('player: o pedaço que chega depois do fim agendado (underrun) recomeça à frente com rampa', async () => {
  const ctx = new ManualAudioContext()
  const q = pcmQueue(ctx, [])
  const a = rampPcm(msToSamples(200))
  q.enqueue({ id: 'u1', audio: a.subarray(0, 4800), mime: MIME, kind: 'sentence', streaming: true })
  await sleep(1)
  await ctx.advance(0.5) // tocou tudo e o relógio passou
  q.pushChunk({ id: 'u1', pcm: a.subarray(4800), done: true })
  await sleep(1)
  const late = ctx.placed[1]
  assert.equal(late.frame, Math.ceil((0.5 + 0.03) * RATE))
  assert.ok(Math.abs(late.first) < Math.abs(pcm16ToFloat(a.subarray(4800, 4802))[0]))
})

test('player: cada nó começa um milésimo de quadro ANTES do quadro exato (o Chromium erra o fim do nó que começa em cima do quadro)', async () => {
  const ctx = new ManualAudioContext()
  const q = pcmQueue(ctx, [])
  const a = rampPcm(msToSamples(300))
  // pedaços de tamanhos variados, como chegam da rede
  q.enqueue({
    id: 'u1',
    audio: a.subarray(0, 1001 * 2),
    mime: MIME,
    kind: 'sentence',
    streaming: true
  })
  await sleep(1)
  for (const [from, to] of [
    [1001, 1502],
    [1502, 4000],
    [4000, 7200]
  ])
    q.pushChunk({ id: 'u1', pcm: a.subarray(from * 2, to * 2), done: false })
  q.pushChunk({ id: 'u1', pcm: new Uint8Array(0), done: true })
  await sleep(1)
  assert.equal(ctx.placed.length, 4)
  for (const p of ctx.placed) {
    assert.ok(p.at < p.frame, `início ${p.at} antes do quadro ${p.frame}`)
    assert.ok(
      p.frame - p.at <= PCM_START_EARLY_FRAMES * 1.01,
      `no máximo ${PCM_START_EARLY_FRAMES} quadro antes`
    )
  }
  // e continuam emendados no quadro exato (o arredondamento do motor cai no quadro certo)
  for (let i = 1; i < ctx.placed.length; i++)
    assert.equal(ctx.placed[i].frame, ctx.placed[i - 1].frame + ctx.placed[i - 1].len)
  assert.ok(
    Math.abs(pcmNodeStartTime(48_000, 48_000) - (1 - PCM_START_EARLY_FRAMES / 48_000)) < 1e-12
  )
  assert.equal(pcmNodeStartTime(0, 48_000), 0, 'nunca negativo')
})

test('player: o volume (ducking/fade) muda no relógio do áudio com uma curva curta — sem degraus no ganho', async () => {
  const ctx = new ManualAudioContext()
  const q = pcmQueue(ctx, [])
  q.enqueue({ id: 'u1', audio: rampPcm(msToSamples(500)), mime: MIME, kind: 'sentence' })
  await sleep(1)
  await ctx.advance(0.1)
  q.setVolume(0.5)
  q.setDuck(0.3)
  const t = ctx.gainTargets
  assert.ok(t.length >= 2, 'mudanças pelo setTargetAtTime')
  assert.deepEqual(
    t.slice(-2).map((x) => [x.value, x.at, x.tau]),
    [
      [0.5, 0.1, PCM_VOLUME_SMOOTH_S],
      [0.15, 0.1, PCM_VOLUME_SMOOTH_S]
    ]
  )
})
