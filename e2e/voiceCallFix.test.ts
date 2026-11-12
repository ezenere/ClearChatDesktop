// Correções da chamada de voz em uso real (SPEC → "Chamada de voz"): o caminho PCM em streaming
// do TTS (OpenRouter/ElevenLabs → `synthesizeStream` → `TtsStreamRelay` → `UtteranceQueue` →
// `WebAudioPcmPlayer`) renderizado num AudioContext FALSO — a saída montada tem de ser amostra a
// amostra o PCM da API (sem estalo nas fronteiras dos pedaços nem das frases).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { synthesizeStream } from '../src/main/voice/tts.ts'
import { TtsStreamRelay } from '../src/main/voice/ttsStreamRelay.ts'
import {
  PCM_FADE_IN_MS,
  PcmScheduleClock,
  PcmStreamResampler,
  PcmStreamSource,
  UtteranceQueue,
  WebAudioPcmPlayer,
  applyFadeIn,
  pcm16ToFloat,
  pcmRateOf
} from '../src/renderer/src/lib/voice/utteranceQueue.ts'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  applyVoiceCallChat,
  layerVoiceCallConfig,
  normalizeVoiceCallConfig,
  normalizeVoiceCallDefaults,
  resolveVoiceCallConfig,
  resolveVoiceCallEnabled,
  voiceSystemPrompt,
  type SttSettings,
  type TtsSettings,
  type VoiceCallConfig
} from '../src/shared/voice.ts'
import { planVoiceReasoning, voiceReasoning } from '../src/shared/voiceCallParams.ts'
import { classifyVoiceError, voiceProviderLabel } from '../src/main/voice/callErrors.ts'
import { SttError } from '../src/main/voice/stt.ts'
import { TtsError } from '../src/main/voice/tts.ts'
import { VoiceCallManager, type VoiceCallUtterance } from '../src/main/voice/call.ts'
import {
  STT_SEGMENT_MIN_MS,
  joinSegments,
  startTranscribeSession
} from '../src/main/voice/session.ts'
import type { AgentEvent, Chat, ChatConfig } from '../src/shared/types.ts'

const RATE = 24_000
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** "Fala" sintética alta (até ~0,9 da escala) — pior caso para costuras: amplitude grande nas emendas. */
function speechLike(seconds: number, seed = 1): Int16Array {
  const n = Math.round(seconds * RATE)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const env = 0.5 + 0.4 * Math.sin(2 * Math.PI * 3 * t + seed)
    const v =
      env *
      (0.6 * Math.sin(2 * Math.PI * (180 + 40 * seed) * t) +
        0.3 * Math.sin(2 * Math.PI * 1230 * t) +
        0.1 * Math.sin(2 * Math.PI * 3100 * t))
    out[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767)
  }
  return out
}

const bytesOf = (pcm: Int16Array): Uint8Array =>
  new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)

/** Corpo da API em pedaços de tamanho ÍMPAR (como o OpenRouter manda: 1360, 1369, 1369…). */
function pcmResponse(bytes: Uint8Array, sizes: number[]): Response {
  let off = 0
  let k = 0
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (off >= bytes.length) return ctl.close()
      const n = sizes[k++ % sizes.length]
      ctl.enqueue(bytes.slice(off, off + n))
      off += n
    }
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': `audio/pcm;rate=${RATE};channels=1` }
  })
}

/** AudioContext falso: agenda cada nó num buffer de saída pelo quadro de início (soma, como o mixer). */
class FakeAudioContext {
  readonly sampleRate: number
  currentTime = 0
  state = 'running'
  readonly destination = {}
  readonly out: Float32Array
  readonly placed: { frame: number; len: number; rate: number }[] = []
  constructor(rate: number, seconds = 10) {
    this.sampleRate = rate
    this.out = new Float32Array(Math.round(rate * seconds))
  }
  createGain(): unknown {
    const noop = (): void => undefined
    return { gain: { value: 1 }, connect: noop, disconnect: noop }
  }
  createBuffer(_ch: number, n: number, rate: number): unknown {
    const data = new Float32Array(n)
    return { length: n, sampleRate: rate, duration: n / rate, getChannelData: () => data }
  }
  createBufferSource(): unknown {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ctx = this
    const node = {
      buffer: null as null | {
        length: number
        sampleRate: number
        getChannelData(): Float32Array
      },
      onended: null as null | (() => void),
      connect: (): void => undefined,
      stop: (): void => undefined,
      start(at: number) {
        const b = node.buffer!
        const frame = Math.round(at * ctx.sampleRate)
        ctx.placed.push({ frame, len: b.length, rate: b.sampleRate })
        const data = b.getChannelData()
        for (let i = 0; i < data.length; i++) ctx.out[frame + i] += data[i]
        // o relógio anda até o fim do nó quando ele "termina" (como o onended real)
        setTimeout(() => {
          ctx.currentTime = Math.max(ctx.currentTime, (frame + data.length) / ctx.sampleRate)
          node.onended?.()
        }, 0)
      }
    }
    return node
  }
  async resume(): Promise<void> {
    return undefined
  }
}

const settings: TtsSettings = {
  backend: 'api',
  api: {
    providerId: null,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
    model: 'elevenlabs/eleven-flash-v2.5',
    voice: 'sarah'
  },
  local: null
}

/** Uma frase pelo caminho real: fetch falso → synthesizeStream → relay → fila → player (ctx falso). */
async function playThroughPipeline(
  sentences: Int16Array[],
  sizes: number[],
  ctx: FakeAudioContext
): Promise<{ idle: boolean }> {
  const realFetch = globalThis.fetch
  let call = 0
  globalThis.fetch = (async () => pcmResponse(bytesOf(sentences[call++]), sizes)) as typeof fetch
  const queue = new UtteranceQueue({
    playerFactory: (audio, mime, stream) => {
      const rate = pcmRateOf(mime)
      assert.ok(rate, `mime PCM esperado, veio ${mime}`)
      let source = stream
      if (!source) {
        source = new PcmStreamSource(rate, audio)
        source.end()
      }
      return new WebAudioPcmPlayer(source, () => ctx as unknown as AudioContext)
    }
  })
  const relay = new TtsStreamRelay({
    emitUtterance: (u) => queue.enqueue(u),
    emitChunk: (e) => queue.pushChunk(e),
    prebufferMs: 200
  })
  try {
    for (let i = 0; i < sentences.length; i++) {
      const ac = new AbortController()
      const r = await relay.synth(ac.signal, (s) =>
        synthesizeStream({ text: `frase ${i}`, settings }, { signal: s })
      )
      relay.emitUtterance({ id: `u${i}`, audio: r.audio, mime: r.mime, kind: 'sentence' })
    }
    for (let i = 0; i < 200 && queue.state !== 'idle'; i++) await tick(2)
    return { idle: queue.state === 'idle' }
  } finally {
    globalThis.fetch = realFetch
  }
}

test('PCM em streaming: pedaços ímpares da API saem amostra a amostra, sem costura nas fronteiras', async () => {
  const src = speechLike(1.2)
  const ctx = new FakeAudioContext(RATE)
  const { idle } = await playThroughPipeline([src], [1360, 1369, 1369, 1356, 4097], ctx)
  assert.ok(idle, 'a fila terminou')
  // o contexto está na taxa do stream: nenhum nó é reamostrado (a causa do "pzzz" a 48 kHz)
  assert.ok(ctx.placed.length > 5, 'vários pedaços agendados')
  for (const p of ctx.placed) assert.equal(p.rate, RATE)
  // contíguos em quadros inteiros: cada nó começa onde o anterior terminou
  for (let i = 1; i < ctx.placed.length; i++)
    assert.equal(ctx.placed[i].frame, ctx.placed[i - 1].frame + ctx.placed[i - 1].len)
  const start = ctx.placed[0].frame
  const fade = Math.floor((PCM_FADE_IN_MS / 1000) * RATE)
  const ref = pcm16ToFloat(bytesOf(src))
  let maxErr = 0
  for (let i = fade; i < ref.length; i++)
    maxErr = Math.max(maxErr, Math.abs(ctx.out[start + i] - ref[i]))
  assert.equal(maxErr, 0, 'saída idêntica ao PCM da API depois da rampa de entrada')
  // rampa de entrada: o 1º quadro é atenuado (sem degrau no começo da frase)
  assert.ok(Math.abs(ctx.out[start]) <= Math.abs(ref[0]))
  // nada antes do começo nem depois do fim (nenhum cabeçalho/lixo tocado como amostra)
  for (let i = 0; i < start; i++) assert.equal(ctx.out[i], 0)
  for (let i = start + ref.length; i < start + ref.length + 500; i++) assert.equal(ctx.out[i], 0)
  // salto amostra a amostra nas emendas ≤ o maior salto natural do sinal
  let inside = 0
  for (let i = 1; i < ref.length; i++) inside = Math.max(inside, Math.abs(ref[i] - ref[i - 1]))
  for (const p of ctx.placed.slice(1)) {
    const j = p.frame
    assert.ok(Math.abs(ctx.out[j] - ctx.out[j - 1]) <= inside + 1e-9, `emenda no quadro ${j}`)
  }
})

test('PCM em streaming: duas frases seguidas (corte na vírgula) não se sobrepõem e cada uma entra com rampa', async () => {
  const a = speechLike(0.6, 1)
  const b = speechLike(0.5, 2)
  const ctx = new FakeAudioContext(RATE)
  await playThroughPipeline([a, b], [2887, 4220, 1369], ctx)
  // a 2ª frase começa num player novo: o 1º nó dela vem depois do fim da 1ª
  const total = a.length + b.length
  const sum = ctx.placed.reduce((acc, p) => acc + p.len, 0)
  assert.equal(sum, total, 'todas as amostras das duas frases foram agendadas uma única vez')
  const ends = ctx.placed.map((p) => [p.frame, p.frame + p.len])
  ends.sort((x, y) => x[0] - y[0])
  for (let i = 1; i < ends.length; i++) assert.ok(ends[i][0] >= ends[i - 1][1], 'sem sobreposição')
})

test('PcmScheduleClock: contíguo em quadros inteiros; underrun recomeça à frente e avisa (gap)', () => {
  const c = new PcmScheduleClock(24_000)
  const a = c.place(100, 0)
  assert.deepEqual(a, { startFrame: Math.ceil(0.03 * 24_000), gap: false })
  const b = c.place(50, 0.001)
  assert.deepEqual(b, { startFrame: a.startFrame + 100, gap: false })
  // o relógio passou do fim agendado: buraco → recomeça à frente com gap
  const late = c.place(10, 1)
  assert.equal(late.gap, true)
  assert.equal(late.startFrame, Math.ceil(1.03 * 24_000))
})

test('PcmStreamResampler: reamostrar pedaço a pedaço = reamostrar o stream inteiro (sem costura)', () => {
  const src = pcm16ToFloat(bytesOf(speechLike(0.3)))
  for (const to of [48_000, 44_100, 16_000]) {
    const whole = new PcmStreamResampler(RATE, to).push(src)
    const r = new PcmStreamResampler(RATE, to)
    const parts: number[] = []
    let off = 0
    const sizes = [684, 683, 1, 2048, 37]
    for (let k = 0; off < src.length; k++) {
      const n = sizes[k % sizes.length]
      parts.push(...r.push(src.subarray(off, off + n)))
      off += n
    }
    assert.ok(Math.abs(parts.length - whole.length) <= 1, `tamanho (${to})`)
    let maxErr = 0
    for (let i = 0; i < Math.min(parts.length, whole.length); i++)
      maxErr = Math.max(maxErr, Math.abs(parts[i] - whole[i]))
    assert.ok(maxErr < 1e-4, `diferença ${maxErr} em ${to} Hz`)
  }
})

test('pcm16ToFloat (little-endian, com byteOffset) e applyFadeIn', () => {
  const buf = new Uint8Array([0xff, 0x00, 0x80, 0xff, 0x7f])
  const f = pcm16ToFloat(buf.subarray(1, 5)) // [0x8000, 0x7fff] LE → -1, ~1
  assert.equal(f[0], -1)
  assert.ok(Math.abs(f[1] - 32767 / 32768) < 1e-9)
  const s = new Float32Array([1, 1, 1, 1])
  applyFadeIn(s, 3)
  assert.deepEqual(Array.from(s), [0.25, 0.5, 0.75, 1])
})

test('PCM em streaming: contexto recusou a taxa do stream (48 kHz) → reamostragem contínua em JS, sem nó em outra taxa', async () => {
  const src = speechLike(0.8)
  const ctx = new FakeAudioContext(48_000)
  await playThroughPipeline([src], [1369, 1360, 977], ctx)
  // nenhum nó a 24 kHz dentro do contexto de 48 kHz (era isso que o Chromium reamostrava nó a nó)
  for (const p of ctx.placed) assert.equal(p.rate, 48_000)
  for (let i = 1; i < ctx.placed.length; i++)
    assert.equal(ctx.placed[i].frame, ctx.placed[i - 1].frame + ctx.placed[i - 1].len)
  const whole = new PcmStreamResampler(RATE, 48_000).push(pcm16ToFloat(bytesOf(src)))
  const start = ctx.placed[0].frame
  const fade = Math.floor((PCM_FADE_IN_MS / 1000) * 48_000)
  let maxErr = 0
  for (let i = fade; i < whole.length - 2; i++)
    maxErr = Math.max(maxErr, Math.abs(ctx.out[start + i] - whole[i]))
  assert.ok(maxErr < 1e-4, `diferença ${maxErr}`)
})

// ---------------- falhas das APIs de voz na chamada ----------------

test('classifyVoiceError: fatal × transitória com motivo legível por provedor', () => {
  const tts = (
    kind: ConstructorParameters<typeof TtsError>[0],
    msg: string,
    status?: number
  ): TtsError => new TtsError(kind, msg, { backend: 'api', status })
  const stt = (
    kind: ConstructorParameters<typeof SttError>[0],
    msg: string,
    status?: number
  ): SttError => new SttError(kind, msg, { backend: 'api', status })
  const c = (
    e: unknown,
    src: 'stt' | 'tts' = 'tts',
    label = 'ElevenLabs'
  ): ReturnType<typeof classifyVoiceError> => classifyVoiceError(e, src, label)
  // 401 → fatal
  let r = c(stt('auth', 'chave de API inválida (HTTP 401)', 401), 'stt', 'OpenRouter')
  assert.equal(r?.fatal, true)
  assert.match(r!.reason, /chave do OpenRouter inválida/)
  // 402 / quota com texto de créditos → fatal
  assert.match(c(tts('quota', 'Payment required', 402))!.reason, /créditos da ElevenLabs esgotados/)
  assert.equal(c(tts('quota', 'quota_exceeded: This request exceeds your quota', 429))?.fatal, true)
  // 429 sem cota = limite de taxa → transitória
  assert.equal(c(tts('quota', 'Too many requests', 429))?.fatal, false)
  // voz/modelo inexistente → fatal
  r = c(tts('http', 'voice_not_found', 404))
  assert.equal(r?.fatal, true)
  assert.match(r!.reason, /modelo ou voz indisponível/)
  // 5xx, rede e tempo → transitória
  assert.equal(c(tts('http', 'bad gateway', 502))?.fatal, false)
  assert.equal(c(stt('network', 'ECONNRESET'), 'stt')?.fatal, false)
  assert.equal(c(stt('timeout', 'tempo esgotado'), 'stt')?.fatal, false)
  // config/motor local ausente → fatal
  r = c(new TtsError('config', 'Kokoro não instalado', { backend: 'local' }), 'tts', 'motor local')
  assert.equal(r?.fatal, true)
  assert.match(r!.reason, /voz local indisponível/)
  // erro sem tipo: frame do WebSocket com cota → fatal; processo do motor que caiu → transitória
  assert.equal(c(new Error('quota_exceeded'))?.fatal, true)
  assert.equal(c(new Error('o processo do motor de voz caiu (SIGSEGV)'))?.fatal, false)
  // cancelamento não é falha
  assert.equal(c(Object.assign(new Error('x'), { name: 'AbortError' })), null)
  assert.equal(voiceProviderLabel('https://openrouter.ai/api/v1'), 'OpenRouter')
  assert.equal(voiceProviderLabel('https://api.elevenlabs.io'), 'ElevenLabs')
  assert.equal(voiceProviderLabel('', true), 'motor local')
})

/** Manager com síntese programável (sequência de resultados/erros por chamada). */
function managerWith(
  synthPlan: (n: number, text: string) => Promise<{ audio: Uint8Array; mime: string }>
): {
  m: VoiceCallManager
  emit: (e: AgentEvent) => void
  emitted: VoiceCallUtterance[]
  synthCalls: string[]
  ended: () => number
} {
  const listeners: ((e: AgentEvent) => void)[] = []
  const emitted: VoiceCallUtterance[] = []
  const synthCalls: string[] = []
  let ended = 0
  const m = new VoiceCallManager({
    sendTurn: () => {},
    synth: async (text) => {
      synthCalls.push(text)
      return synthPlan(synthCalls.length, text)
    },
    emitState: () => {},
    emitUtterance: (u) => emitted.push(u),
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
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    classifyError: (e, source) => classifyVoiceError(e, source, 'OpenRouter'),
    onCallEnded: () => void ended++
  })
  m.start('s1')
  const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))
  return { m, emit, emitted, synthCalls, ended: () => ended }
}
const answer = (emit: (e: AgentEvent) => void, text: string): void => {
  emit({
    type: 'message-added',
    message: { id: 'u1', sessionId: 's1', message: { role: 'user', content: 'pergunta' }, meta: {} }
  } as unknown as AgentEvent)
  emit({
    type: 'message-added',
    message: { id: 'a1', sessionId: 's1', message: { role: 'assistant', content: text }, meta: {} }
  } as unknown as AgentEvent)
}
const waitUntil = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout')
    await tick(2)
  }
}
const okAudio = async (): Promise<{ audio: Uint8Array; mime: string }> => ({
  audio: new Uint8Array([1, 2]),
  mime: 'audio/wav'
})

test('chamada: TTS 401 → encerra na 1ª falha (sem nova tentativa), motivo legível, streams derrubados', async () => {
  const h = managerWith(async () => {
    throw new TtsError('auth', 'chave inválida (HTTP 401)', { backend: 'api', status: 401 })
  })
  answer(h.emit, 'Olá, tudo bem com você?')
  await waitUntil(() => !h.m.state().active)
  assert.deepEqual(h.synthCalls.length, 1, 'fatal não repete')
  assert.match(h.m.state().error ?? '', /chave do OpenRouter inválida/)
  assert.equal(h.ended(), 1)
})

test('chamada: TTS 402 (créditos) e 404 (voz) encerram; 5xx seguido de sucesso NÃO encerra; 5xx duas vezes encerra', async () => {
  const q = managerWith(async () => {
    throw new TtsError('quota', 'insufficient credits', { backend: 'api', status: 402 })
  })
  answer(q.emit, 'Olá, tudo bem com você?')
  await waitUntil(() => !q.m.state().active)
  assert.match(q.m.state().error ?? '', /créditos do OpenRouter esgotados/)

  const v = managerWith(async () => {
    throw new TtsError('http', 'voice not found', { backend: 'api', status: 404 })
  })
  answer(v.emit, 'Olá, tudo bem com você?')
  await waitUntil(() => !v.m.state().active)
  assert.match(v.m.state().error ?? '', /modelo ou voz indisponível/)

  const once = managerWith(async (n) => {
    if (n === 1) throw new TtsError('http', 'bad gateway', { backend: 'api', status: 502 })
    return okAudio()
  })
  answer(once.emit, 'Olá, tudo bem com você?')
  await waitUntil(() => once.emitted.length === 1)
  assert.equal(once.m.state().active, true, '5xx + sucesso: a chamada segue')
  assert.equal(once.synthCalls.length, 2)

  const twice = managerWith(async () => {
    throw new TtsError('http', 'bad gateway', { backend: 'api', status: 503 })
  })
  answer(twice.emit, 'Olá, tudo bem com você?')
  await waitUntil(() => !twice.m.state().active)
  assert.equal(twice.synthCalls.length, 2, 'uma nova tentativa só')
  assert.match(twice.m.state().error ?? '', /HTTP 503/)
})

test('chamada: processo do motor local que cai → nova tentativa; caiu de novo → encerra', async () => {
  const h = managerWith(async () => {
    throw new Error('o processo do motor de voz caiu (exit 139)')
  })
  answer(h.emit, 'Olá, tudo bem com você?')
  await waitUntil(() => !h.m.state().active)
  assert.equal(h.synthCalls.length, 2)
  assert.match(h.m.state().error ?? '', /caiu/)
})

test('chamada: falha de STT — fatal encerra já; transitória: 1ª é uma falta, a 2ª (ou já repetida) encerra', () => {
  const a = managerWith(okAudio)
  assert.equal(
    a.m.voiceApiError(
      'stt',
      new SttError('quota', 'quota exceeded', { backend: 'api', status: 429 })
    ),
    true
  )
  assert.equal(a.m.state().active, false)
  assert.match(a.m.state().error ?? '', /créditos/)
  const b = managerWith(okAudio)
  const net = new SttError('network', 'ECONNRESET', { backend: 'api' })
  assert.equal(b.m.voiceApiError('stt', net), false, 'a 1ª transitória não encerra')
  assert.equal(b.m.state().active, true)
  assert.equal(b.m.voiceApiError('stt', net), true, 'a 2ª encerra')
  const c = managerWith(okAudio)
  assert.equal(c.m.voiceApiError('stt', net, { retried: true }), true, 'já repetida: encerra')
  assert.match(c.m.state().error ?? '', /falha de conexão com a transcrição/)
})

test('chamada: turno do agente que falha de vez (erro persistido) encerra a chamada', async () => {
  const h = managerWith(okAudio)
  h.emit({
    type: 'message-added',
    message: { id: 'u1', sessionId: 's1', message: { role: 'user', content: 'oi' }, meta: {} }
  } as unknown as AgentEvent)
  h.emit({
    type: 'message-added',
    message: {
      id: 'e1',
      sessionId: 's1',
      message: { role: 'assistant', content: 'HTTP 401' },
      meta: { synthetic: true, kind: 'error', error: 'HTTP 401: chave inválida' }
    }
  } as unknown as AgentEvent)
  assert.equal(h.m.state().active, false)
  assert.match(h.m.state().error ?? '', /o modelo falhou: HTTP 401/)
})

test('fila do renderer: utterance que não toca (play() recusado/CSP) chega ao onError — nunca calada', async () => {
  const errors: { id: string; reason: string }[] = []
  const q = new UtteranceQueue({
    playerFactory: () => ({
      onended: null,
      onerror: null,
      volume: 1,
      play: () =>
        Promise.reject(Object.assign(new Error('blocked by CSP'), { name: 'NotSupportedError' })),
      pause: () => {}
    }),
    onError: ({ item, reason }) => errors.push({ id: item.id, reason })
  })
  q.enqueue({ id: 'c1', audio: new Uint8Array([1]), mime: 'audio/wav', kind: 'filler' })
  await tick(5)
  assert.equal(errors.length, 1)
  assert.match(errors[0].reason, /NotSupportedError: blocked by CSP/)
  assert.equal(q.state, 'idle', 'a fila segue')
})

// ---------------- transcrição segmentada + final rápida ----------------

const RATE16 = 16_000
/** PCM16 16 kHz: tom (fala) ou silêncio. */
const tone = (ms: number, amp = 8000): Uint8Array => {
  const n = Math.round((ms * RATE16) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / RATE16))
  return new Uint8Array(out.buffer)
}
const silence = (ms: number): Uint8Array => new Uint8Array(Math.round((ms * RATE16) / 1000) * 2)
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
/** fetch falso do /audio/transcriptions: devolve textos em sequência (ou lança/status). */
function fakeStt(plan: (n: number, bytes: number) => Response | Promise<Response>): {
  calls: number[]
  restore: () => void
} {
  const calls: number[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const file = (init?.body as FormData).get('file') as Blob
    const size = file.size - 44
    calls.push(size)
    return plan(calls.length, size)
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = orig) }
}
const json = (text: string): Response => new Response(JSON.stringify({ text }), { status: 200 })
/** Empurra em pedaços de 100 ms (como a captura). */
const pushAll = (s: { push(c: Uint8Array): void }, pcm: Uint8Array): void => {
  for (let o = 0; o < pcm.length; o += 3200) s.push(pcm.subarray(o, o + 3200))
}

test('joinSegments: espaço entre segmentos; maiúscula do corte no meio da frase vira minúscula (siglas ficam)', () => {
  assert.equal(
    joinSegments('Ontem eu fui ao mercado', 'E encontrei um amigo.'),
    'Ontem eu fui ao mercado e encontrei um amigo.'
  )
  assert.equal(
    joinSegments('Fui ao mercado.', 'Encontrei um amigo.'),
    'Fui ao mercado. Encontrei um amigo.'
  )
  assert.equal(joinSegments('abre a pasta', 'SRC agora'), 'abre a pasta SRC agora')
  assert.equal(joinSegments('', ' oi '), 'oi')
})

test('segmentos: pausa ≥ 500 ms depois de ≥ 3 s de fala transcreve o trecho em segundo plano; a final só sobe o resto', async (t) => {
  const texts = ['Primeira parte da fala,', 'segunda parte.']
  const f = fakeStt(() => json(texts.shift() ?? '?'))
  t.after(f.restore)
  const s = startTranscribeSession(
    { settings: sttSettings({ livePartials: false }), language: 'pt-BR' },
    { idleTimeoutMs: 0 }
  )
  pushAll(s, tone(STT_SEGMENT_MIN_MS + 200))
  pushAll(s, silence(600)) // pausa: corta aqui
  await tick(5)
  assert.equal(f.calls.length, 1, 'o segmento foi transcrito durante a gravação')
  const segBytes = f.calls[0]
  assert.ok(
    segBytes >= tone(STT_SEGMENT_MIN_MS + 200).length,
    'o segmento cobre a fala inteira até a pausa'
  )
  pushAll(s, tone(1500))
  const r = await s.stop()
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls[1] < segBytes, 'a final sobe só o trecho depois do corte')
  assert.equal(r.text, 'Primeira parte da fala, segunda parte.')
})

test('segmentos: falha transitória é repetida 1×; falhou de novo, a final cobre o trecho (nada se perde)', async (t) => {
  let n = 0
  const f = fakeStt(() => {
    n++
    if (n <= 2) return new Response('upstream', { status: 503 })
    return json('tudo de uma vez.')
  })
  t.after(f.restore)
  const s = startTranscribeSession(
    { settings: sttSettings({ livePartials: false }) },
    { idleTimeoutMs: 0 }
  )
  pushAll(s, tone(STT_SEGMENT_MIN_MS + 200))
  pushAll(s, silence(600))
  await tick(10)
  assert.equal(f.calls.length, 2, 'segmento + 1 nova tentativa')
  pushAll(s, tone(800))
  const r = await s.stop()
  assert.equal(r.text, 'tudo de uma vez.')
  assert.ok(f.calls[2] > f.calls[0], 'a final sobe tudo desde o início (o corte não andou)')
})

test('final rápida: parcial que transcreveu o trecho inteiro vira a final SEM request (reusePartial); final 500 → 1 nova tentativa', async (t) => {
  let now = 1_000_000
  const texts = ['Que horas são em Lisboa?']
  const f = fakeStt(() => json(texts.shift() ?? 'final'))
  t.after(f.restore)
  const partials: string[] = []
  const s = startTranscribeSession(
    { settings: sttSettings() },
    { idleTimeoutMs: 0, now: () => now, onPartial: (e) => partials.push(e.text) }
  )
  pushAll(s, tone(1200))
  now += 1000
  s.push(silence(100)) // dispara a parcial (o trecho inteiro)
  await tick(5)
  assert.deepEqual(partials, ['Que horas são em Lisboa?'])
  pushAll(s, silence(400)) // só silêncio depois
  const r = await s.stop({ reusePartial: true })
  assert.equal(r.text, 'Que horas são em Lisboa?')
  assert.equal(r.partialReused, true)
  assert.equal(f.calls.length, 1, 'nenhuma request na final')

  // fala depois da parcial → a final transcreve (e 500 na 1ª tentativa é repetido)
  let k = 0
  const g = fakeStt(() => (++k === 1 ? new Response('x', { status: 500 }) : json('texto final')))
  t.after(g.restore)
  const s2 = startTranscribeSession(
    { settings: sttSettings({ livePartials: false }) },
    { idleTimeoutMs: 0 }
  )
  pushAll(s2, tone(900))
  const r2 = await s2.stop({ reusePartial: true })
  assert.equal(r2.text, 'texto final')
  assert.equal(g.calls.length, 2, '500 + nova tentativa')
})

// ---------------- prompt do modo voz por persona (modo) + precedência ----------------

const chatOf = (systemPrompt: string): Chat =>
  ({
    id: 'c1',
    config: { systemPrompt, params: {}, model: 'm', providerId: 'p' }
  }) as unknown as Chat
const cfg = (v: Partial<VoiceCallConfig>): VoiceCallConfig => ({
  ...normalizeVoiceCallConfig(null),
  ...v
})

test('prompt na chamada: complementar (padrão) / substituto / nenhum — só o prompt do modo voz muda', () => {
  const sys = 'Você é a Diana.'
  const append = resolveVoiceCallConfig(
    cfg({ voicePrompt: 'Fale curto.' }),
    DEFAULT_VOICE_CALL_DEFAULTS
  )
  assert.equal(append.promptMode, 'append')
  assert.equal(applyVoiceCallChat(chatOf(sys), append).config.systemPrompt, `${sys}\n\nFale curto.`)
  const replace = resolveVoiceCallConfig(
    cfg({ voicePrompt: 'Você é a Diana ao telefone.', promptMode: 'replace' }),
    DEFAULT_VOICE_CALL_DEFAULTS
  )
  assert.equal(
    applyVoiceCallChat(chatOf(sys), replace).config.systemPrompt,
    'Você é a Diana ao telefone.',
    'substituto: o system prompt normal sai'
  )
  // substituto sem prompt de voz = nada a pôr no lugar → como complementar
  assert.equal(voiceSystemPrompt(sys, { voicePrompt: null, promptMode: 'replace' }), sys)
  const none = resolveVoiceCallConfig(
    cfg({ voicePrompt: 'ignorado', promptMode: 'none' }),
    DEFAULT_VOICE_CALL_DEFAULTS
  )
  assert.equal(
    applyVoiceCallChat(chatOf(sys), none).config.systemPrompt,
    sys,
    'nenhum: só o normal'
  )
  // campos LEGADOS do prompt-base (até 2026-11-12) gravados no dispositivo: ignorados
  const legacy = normalizeVoiceCallDefaults({
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    basePromptEnabled: true,
    basePrompt: 'texto antigo'
  } as never)
  assert.ok(!('basePromptEnabled' in legacy) && !('basePrompt' in legacy))
  const withLegacy = resolveVoiceCallConfig(cfg({}), {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    basePromptEnabled: true,
    basePrompt: 'texto antigo'
  } as never)
  assert.equal(applyVoiceCallChat(chatOf(sys), withLegacy).config.systemPrompt, sys)
  // valores antigos (sem promptMode) seguem complementares; lixo → herda
  assert.equal(normalizeVoiceCallConfig({ voicePrompt: 'x' }).promptMode, undefined)
  assert.equal(normalizeVoiceCallConfig({ promptMode: 'bogus' }).promptMode, undefined)
})

test('precedência chat > persona > global: enabled (com a origem p/ o tooltip), modelo e modo do prompt', () => {
  const persona = cfg({ enabled: false, promptMode: 'replace', voicePrompt: 'P' })
  // chat que herda (null) segue a persona AO VIVO
  let r = resolveVoiceCallEnabled(cfg({}), persona, DEFAULT_VOICE_CALL_DEFAULTS)
  assert.deepEqual(r, { enabled: false, source: 'persona' })
  // snapshot igual ao da persona → a origem exibida é a persona
  r = resolveVoiceCallEnabled(cfg({ enabled: false }), persona, DEFAULT_VOICE_CALL_DEFAULTS)
  assert.deepEqual(r, { enabled: false, source: 'persona' })
  // override do chat religa
  r = resolveVoiceCallEnabled(cfg({ enabled: true }), persona, DEFAULT_VOICE_CALL_DEFAULTS)
  assert.deepEqual(r, { enabled: true, source: 'chat' })
  // sem persona → global
  r = resolveVoiceCallEnabled(cfg({}), null, { ...DEFAULT_VOICE_CALL_DEFAULTS, enabled: false })
  assert.deepEqual(r, { enabled: false, source: 'global' })
  // camadas campo a campo
  const layered = layerVoiceCallConfig(cfg({ voicePrompt: 'C' }), persona)
  assert.equal(layered.voicePrompt, 'C')
  assert.equal(layered.promptMode, 'replace')
  // modelo: chat > persona > global > null (o do chat)
  const g = { providerId: 'pg', model: 'global-m', params: {} }
  const pm = { providerId: 'pp', model: 'persona-m', params: {} }
  const d = { ...DEFAULT_VOICE_CALL_DEFAULTS, model: g }
  assert.equal(resolveVoiceCallConfig(cfg({}), d).model?.model, 'global-m')
  assert.equal(resolveVoiceCallConfig(cfg({}), d, cfg({ model: pm })).model?.model, 'persona-m')
  assert.equal(
    resolveVoiceCallConfig(
      cfg({ model: { providerId: 'pc', model: 'chat-m', params: {} } }),
      d,
      cfg({ model: pm })
    ).model?.model,
    'chat-m'
  )
  assert.equal(resolveVoiceCallConfig(cfg({}), DEFAULT_VOICE_CALL_DEFAULTS).model, null)
})

// ---------------- raciocínio do modelo da chamada ----------------

test('raciocínio na chamada: desliga/mínimo pela política salvo escolha explícita nos params da chamada', () => {
  // OpenRouter sem /models em cache: tabela da Anthropic pelo id → effort none (haiku-5.5 pensa por padrão)
  assert.deepEqual(
    planVoiceReasoning({
      params: { reasoning_effort: 'high' },
      explicit: false,
      kind: 'openrouter',
      model: 'anthropic/claude-haiku-5.5'
    }).params,
    { reasoning_effort: 'none' },
    'o reasoning_effort do chat de texto não vale na chamada'
  )
  assert.equal(voiceReasoning('openrouter', 'anthropic/claude-opus-5.5').mode, 'minimal')
  // Anthropic nativa: thinking disabled no extraBody (sem atropelar um thinking do usuário)
  const nat = planVoiceReasoning({
    params: {},
    explicit: false,
    kind: 'anthropic',
    model: 'claude-haiku-5-5'
  })
  assert.deepEqual(JSON.parse(nat.params.extraBody!).thinking, { type: 'disabled' })
  const own = planVoiceReasoning({
    params: { extraBody: '{"thinking":{"type":"enabled","budget_tokens":1024}}' },
    explicit: false,
    kind: 'anthropic',
    model: 'claude-haiku-5-5'
  })
  assert.equal(JSON.parse(own.params.extraBody!).thinking.type, 'enabled')
  // escolha explícita nos params da chamada: intocado
  assert.deepEqual(
    planVoiceReasoning({
      params: { reasoning_effort: 'low', max_tokens: 300 },
      explicit: true,
      kind: 'openrouter',
      model: 'anthropic/claude-haiku-5.5'
    }).params,
    { reasoning_effort: 'low', max_tokens: 300 }
  )
  // nunca impõe max_tokens
  assert.equal(
    planVoiceReasoning({
      params: {},
      explicit: false,
      kind: 'openrouter',
      model: 'anthropic/claude-haiku-5.5'
    }).params.max_tokens,
    undefined
  )
  // applyVoiceCallChat com regras do provedor: o turno de voz manda effort none
  const call = resolveVoiceCallConfig(null, DEFAULT_VOICE_CALL_DEFAULTS)
  const chat = {
    id: 'c',
    config: {
      systemPrompt: '',
      params: { reasoning_effort: 'medium' },
      model: 'anthropic/claude-haiku-5.5',
      providerId: 'p'
    }
  } as unknown as Chat
  assert.equal(
    applyVoiceCallChat(chat, call, { kind: 'openrouter' }).config.params?.reasoning_effort,
    'none'
  )
  // modelo da chamada com reasoning_effort explícito: respeitado
  const call2 = resolveVoiceCallConfig(
    cfg({
      model: {
        providerId: 'p',
        model: 'anthropic/claude-haiku-5.5',
        params: { reasoning_effort: 'low' }
      }
    }),
    DEFAULT_VOICE_CALL_DEFAULTS
  )
  assert.equal(
    applyVoiceCallChat(chat, call2, { kind: 'openrouter' }).config.params?.reasoning_effort,
    'low'
  )
})
