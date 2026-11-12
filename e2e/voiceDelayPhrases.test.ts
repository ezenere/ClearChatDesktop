// Frases de espera da chamada de voz (SPEC → "Chamada de voz → Frases de demora"): "manter viva"
// ("Só mais um instante…") depois de 8 s de SILÊNCIO desde o fim da última fala (preâmbulo, frase de
// ferramenta, a "manter viva" anterior, uma frase da resposta), sempre que a resposta ainda não está
// sendo falada — antes dela, com tool rodando e com o modelo pensando de novo depois da tool —, no
// máx. 2 por turno; e "Obrigado por aguardar." logo antes da frase da resposta que encerra uma espera
// com "manter viva", só se a última frase de espera terminou há ≥ 4,5 s e ele já está pronto (clipe
// `THANKS_<n>` ou síntese em paralelo desde a 1ª "manter viva" — a resposta nunca espera por ele).
// Política pura (`@shared/voicePolicy`) + `VoiceCallManager` com relógio/timers FALSOS, síntese
// falsa, clipes falsos, reprodução falsa (`autoPlay`) e eventos do runner injetados. Nada pago, sem
// microfone.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceDelayPhrases.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatConfig, MessageMeta, StoredMessage } from '@shared/types'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_DELAY_PHRASES,
  DEFAULT_KEEPALIVE_POOL,
  DEFAULT_KEEPALIVE_TOOL_POOL,
  DEFAULT_STT_SETTINGS,
  DEFAULT_THANKS_POOL,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  LEGACY_APOLOGY_POOL,
  LEGACY_DELAY_PHRASE_DEFAULTS,
  THANKS_AFTER_MS_RANGE,
  normalizeDelayPhrases,
  normalizeVoiceCallDefaults,
  resolveDelayPhrasePools,
  type VoiceDelayPhrases
} from '@shared/voice'
import {
  FILLER_MIN_SPEECH_MS,
  VoicedSpan,
  fillerBelowMinSpeech,
  pickFillerPhrase,
  EMPTY_DELAY_STATE,
  KEEPALIVE_MAX_PER_TURN,
  keepAliveContext,
  keepAliveDueAt,
  pickDelayPhrase,
  thanksSkipReason,
  type DelayPhraseState
} from '@shared/voicePolicy'
import { computeVoiceCallMetrics } from '@shared/voiceTimeline'
import { END_CALL_RESULT, type VoiceCallMark } from '@shared/voiceCallMarks'
import {
  VoiceCallManager,
  type VoiceCallAmend,
  type VoiceCallUtterance
} from '../src/main/voice/call.ts'
import type { TtsTextFeed } from '../src/main/voice/elevenlabsStream.ts'

// =====================================================================================
// política pura
// =====================================================================================

const CFG = { enabled: true, keepAliveAfterMs: 8000 }
const st = (p: Partial<DelayPhraseState>): DelayPhraseState => ({
  ...EMPTY_DELAY_STATE,
  turnStartedAt: 0,
  silentSince: 0,
  ...p
})

test('padrões: manter viva após 8 s de silêncio, obrigado se a última frase foi há ≥ 4,5 s, no máx. 2 por turno', () => {
  assert.deepEqual(DEFAULT_DELAY_PHRASES, {
    enabled: true,
    keepAliveAfterMs: 8000,
    thanksAfterMs: 4500,
    keepAlivePool: null,
    keepAliveToolPool: null,
    thanksPool: null
  })
  assert.equal(KEEPALIVE_MAX_PER_TURN, 2)
  assert.deepEqual(THANKS_AFTER_MS_RANGE, { min: 1000, max: 30_000 })
  assert.ok(DEFAULT_THANKS_POOL.includes('Obrigado por aguardar.'))
  assert.ok(DEFAULT_THANKS_POOL.includes('Pronto, obrigado pela paciência.'))
  assert.ok(DEFAULT_THANKS_POOL.includes('Valeu por esperar, olha só…'))
  assert.ok(DEFAULT_THANKS_POOL.includes('Pronto, aqui está.'))
  assert.ok(
    !DEFAULT_THANKS_POOL.some((t) => /desculp|foi mal/i.test(t)),
    'agradece, não se desculpa'
  )
  for (const pool of [DEFAULT_KEEPALIVE_POOL, DEFAULT_KEEPALIVE_TOOL_POOL, DEFAULT_THANKS_POOL]) {
    assert.ok(pool.length >= 4, 'variedade: ≥ 4 frases por pool')
    assert.equal(new Set(pool).size, pool.length, 'sem duplicatas')
    assert.ok(pool.every((t) => t.length <= 80 && !/\.\.\./.test(t)))
  }
  assert.ok(
    !DEFAULT_KEEPALIVE_POOL.some((t) => DEFAULT_KEEPALIVE_TOOL_POOL.includes(t)),
    'pools de contexto distintos'
  )
})

test('keepAliveDueAt: regra ÚNICA — 8 s de silêncio desde o fim da última fala; sem cooldown/gap à parte; vale com a resposta já iniciada', () => {
  assert.equal(keepAliveDueAt(st({}), CFG), 8000, 'sem nada tocado: silêncio desde o envio')
  assert.equal(
    keepAliveDueAt(st({ silentSince: 2000, lastShortEndAt: 2000 }), CFG),
    10_000,
    'depois da frase de ferramenta/preâmbulo: 8 s do FIM dela'
  )
  // a 1ª "manter viva" terminou aos 11,5 s: a 2ª 8 s depois (o silêncio É o espaçamento)
  assert.equal(
    keepAliveDueAt(st({ keepAlives: 1, silentSince: 11_500, lastShortEndAt: 11_500 }), CFG),
    19_500
  )
  assert.equal(keepAliveDueAt(st({ silentSince: 0 }), { ...CFG, keepAliveAfterMs: 12_000 }), 12_000)
  assert.equal(keepAliveDueAt(st({ silentSince: null }), CFG), null, 'algo tocando/usuário falando')
  assert.equal(keepAliveDueAt(st({ turnStartedAt: null }), CFG), null, 'desarmado')
  assert.equal(keepAliveDueAt(st({}), { ...CFG, enabled: false }), null, 'desligado')
  assert.equal(
    keepAliveDueAt(st({ keepAlives: KEEPALIVE_MAX_PER_TURN }), CFG),
    null,
    `no máximo ${KEEPALIVE_MAX_PER_TURN} faladas por turno`
  )
  // o modelo já falou ("Vou pesquisar isso.") e PENSA DE NOVO depois da tool: continua valendo
  // (antes: só com tool rodando — o silêncio depois da tool não tinha "manter viva")
  assert.equal(
    keepAliveDueAt(st({ answerSpoken: true, toolsRunning: false, silentSince: 30_000 }), CFG),
    38_000
  )
  assert.equal(keepAliveContext({ toolsRunning: true }), 'tool')
  assert.equal(keepAliveContext({ toolsRunning: false }), 'thinking')
})

test('thanksSkipReason: só depois de "manter viva", 1 por turno, a última frase de espera terminou há ≥ 4,5 s, só pronto', () => {
  const base = {
    waitKeepAlives: 1,
    thanked: false,
    ready: true,
    shortPlaying: false,
    lastWaitEndAt: 10_000,
    now: 14_500,
    thanksAfterMs: 4500
  }
  assert.equal(thanksSkipReason(base), null, 'terminou há 4,5 s → agradece')
  assert.equal(thanksSkipReason({ ...base, now: 14_499 }), 'too-soon', 'há < 4,5 s → não precisa')
  assert.equal(thanksSkipReason({ ...base, now: 12_000 }), 'too-soon', 'há 2 s → não precisa')
  assert.equal(thanksSkipReason({ ...base, shortPlaying: true }), 'too-soon', 'ainda tocando')
  assert.equal(thanksSkipReason({ ...base, lastWaitEndAt: null }), 'too-soon')
  assert.equal(thanksSkipReason({ ...base, waitKeepAlives: 0 }), 'no-keepalive')
  assert.equal(thanksSkipReason({ ...base, thanked: true }), 'already')
  assert.equal(thanksSkipReason({ ...base, ready: false }), 'not-ready', 'nunca espera a síntese')
  assert.equal(thanksSkipReason({ ...base, thanksAfterMs: 8000, now: 17_999 }), 'too-soon')
})

test('pickDelayPhrase: nunca repete as últimas; pool de 1 sempre devolve a única; vazio → null', () => {
  const pool = [...DEFAULT_KEEPALIVE_POOL]
  let recent: number[] = []
  let prev: number | null = null
  let seed = 7
  const rng = (): number => (seed = (seed * 9301 + 49297) % 233280) / 233280
  for (let i = 0; i < 200; i++) {
    const k = pickDelayPhrase(pool, recent, rng)!
    assert.ok(k >= 0 && k < pool.length)
    assert.ok(!recent.slice(-2).includes(k), 'fora das 2 últimas')
    assert.notEqual(k, prev)
    prev = k
    recent = [...recent, k].slice(-2)
  }
  assert.equal(
    pickDelayPhrase(['só'], [0], () => 0.9),
    0
  )
  assert.equal(
    pickDelayPhrase(['a', 'b'], [0], () => 0),
    1,
    'pool de 2: alterna'
  )
  assert.equal(
    pickDelayPhrase([], [], () => 0),
    null
  )
})

test('normalizeDelayPhrases: padrões, tempos presos (manter viva 1–60 s, obrigado 1–30 s), pools aparados; aditivo no voiceCallDefaults', () => {
  assert.deepEqual(normalizeDelayPhrases(undefined), DEFAULT_DELAY_PHRASES)
  assert.deepEqual(normalizeDelayPhrases({}), DEFAULT_DELAY_PHRASES)
  const n = normalizeDelayPhrases({
    enabled: false,
    keepAliveAfterMs: 10,
    thanksAfterMs: 999_999,
    keepAlivePool: ['  Um   instante.  ', 'Um instante.', 42, '', 'x'.repeat(200)],
    keepAliveToolPool: ['Ainda rodando…'],
    thanksPool: []
  })
  assert.equal(n.enabled, false)
  assert.equal(n.keepAliveAfterMs, 1000)
  assert.equal(n.thanksAfterMs, 30_000)
  assert.deepEqual(n.keepAlivePool, ['Um instante.', 'x'.repeat(80)])
  assert.deepEqual(n.keepAliveToolPool, ['Ainda rodando…'])
  assert.equal(n.thanksPool, null, 'vazio = padrão')
  assert.equal(normalizeDelayPhrases({ thanksAfterMs: 10 }).thanksAfterMs, 1000)
  assert.equal(normalizeDelayPhrases({ thanksAfterMs: -1 }).thanksAfterMs, 4500, 'lixo → padrão')
  const pools = resolveDelayPhrasePools(n)
  assert.deepEqual(pools.thanks, [...DEFAULT_THANKS_POOL])
  assert.deepEqual(pools.keepAliveTool, ['Ainda rodando…'])
  assert.deepEqual(resolveDelayPhrasePools(DEFAULT_DELAY_PHRASES).keepAliveTool, [
    ...DEFAULT_KEEPALIVE_TOOL_POOL
  ])
  // registro sem o campo → os padrões; o campo passa pelo normalizador global
  const old = normalizeVoiceCallDefaults({ enabled: true, endCall: false })
  assert.deepEqual(old.delayPhrases, DEFAULT_DELAY_PHRASES)
  const custom = normalizeVoiceCallDefaults({ delayPhrases: { thanksAfterMs: 6000 } })
  assert.equal(custom.delayPhrases.thanksAfterMs, 6000)
  assert.equal(custom.delayPhrases.keepAliveAfterMs, 8000)
  assert.deepEqual(DEFAULT_VOICE_CALL_DEFAULTS.delayPhrases, DEFAULT_DELAY_PHRASES)
})

test('(f) migração: "desculpa" antiga → "obrigado por aguardar"; apologyAfterMs some; pool personalizado vira o do obrigado; 3000 → 8000', () => {
  assert.deepEqual(LEGACY_DELAY_PHRASE_DEFAULTS, { keepAliveAfterMs: 3000 })
  // o que uma instalação existente tem gravado (padrões antigos explícitos)
  const stored = {
    enabled: true,
    keepAliveAfterMs: 3000,
    apologyAfterMs: 5000,
    keepAlivePool: null,
    apologyPool: null
  }
  const m = normalizeDelayPhrases(stored)
  assert.deepEqual(m, DEFAULT_DELAY_PHRASES)
  assert.ok(!('apologyAfterMs' in m) && !('apologyPool' in m), 'campos antigos descartados')
  // tempo próprio de "manter viva" fica; o apologyAfterMs escolhido (15 s, 9 s…) não vira nada
  const own = normalizeDelayPhrases({ keepAliveAfterMs: 3500, apologyAfterMs: 9000 })
  assert.equal(own.keepAliveAfterMs, 3500)
  assert.equal(own.thanksAfterMs, 4500, 'a regra nova não usa o tempo desde o turno')
  // pool de desculpas PERSONALIZADO → o pool do obrigado
  const mine = normalizeDelayPhrases({ apologyPool: ['  Pronto, chegou.  ', 'Opa, aqui.'] })
  assert.deepEqual(mine.thanksPool, ['Pronto, chegou.', 'Opa, aqui.'])
  // pool igual ao padrão antigo (não é personalização) → os padrões novos
  assert.equal(normalizeDelayPhrases({ apologyPool: [...LEGACY_APOLOGY_POOL] }).thanksPool, null)
  // registro novo (com thanksPool, mesmo null) ignora o apologyPool que sobrou
  assert.equal(
    normalizeDelayPhrases({ thanksPool: null, apologyPool: ['Velha.'] }).thanksPool,
    null
  )
  assert.deepEqual(
    normalizeDelayPhrases({ thanksPool: ['Valeu!'], apologyPool: ['Velha.'] }).thanksPool,
    ['Valeu!']
  )
  // pelo registro do dispositivo (`voiceCallDefaults`), e idempotente
  const d = normalizeVoiceCallDefaults({
    delayPhrases: { ...stored, enabled: false, apologyPool: ['Pronto, chegou.'] }
  })
  assert.deepEqual(d.delayPhrases, {
    ...DEFAULT_DELAY_PHRASES,
    enabled: false,
    thanksPool: ['Pronto, chegou.']
  })
  assert.deepEqual(normalizeVoiceCallDefaults(d), d)
  assert.deepEqual(normalizeDelayPhrases(JSON.parse(JSON.stringify(mine))), mine)
})

// =====================================================================================
// VoiceCallManager com relógio e timers falsos
// =====================================================================================

/** Timers falsos: `advance` dispara em ordem, avançando o relógio até cada um. */
class FakeTimers {
  now = 1_000_000
  #seq = 0
  #list: { id: number; at: number; fn: () => void }[] = []
  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq
    this.#list.push({ id, at: this.now + Math.max(0, ms), fn })
    return id
  }
  clear = (h: unknown): void => {
    this.#list = this.#list.filter((t) => t.id !== h)
  }
  get pending(): number {
    return this.#list.length
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      this.#list.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.#list[0]
      if (!next || next.at > target) break
      this.#list.shift()
      this.now = Math.max(this.now, next.at)
      next.fn()
      await flush()
    }
    this.now = target
    await flush()
  }
  /** Avança até o instante absoluto `at` (relógio falso). */
  async until(at: number): Promise<void> {
    await this.advance(Math.max(0, at - this.now))
  }
}

/** Esvazia microtarefas/imediatos (síntese falsa resolve em microtarefa). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

interface PhraseCall {
  text: string
  signal: AbortSignal
  resolve: () => void
  reject: (e: unknown) => void
}

/** Duração (ms) de cada tipo de utterance na reprodução falsa (`autoPlay`). */
interface PlayDurations {
  filler: number
  delay: number
  tool: number
  sentence: number
}

/** Uma utterance tocada pela reprodução falsa: início/fim no relógio falso. */
interface PlayRec {
  id: string
  kind: string
  text: string
  start: number
  end: number
}

interface HarnessOpts {
  delay?: Partial<VoiceDelayPhrases>
  /** Frases de espera resolvem só com `phrase.resolve()` (padrão: na hora). */
  manualPhrases?: boolean
  /** Latência da síntese das frases de espera no relógio falso (ms; padrão 0 = microtarefa). */
  phraseLatencyMs?: number
  /** Preâmbulo (filler) ligado (padrão true — clipe falso). */
  fillers?: boolean
  /** Espera do preâmbulo (padrão 0 = já; os cenários usam o padrão real de 2,5 s). */
  fillerDelayMs?: number
  /** Clipes `THANKS` gerados (padrão true); false = o agradecimento é sintetizado ao vivo. */
  thanksClips?: boolean
  ttsFeed?: boolean
  /** STT só pela API (especulação lenta — espera de fim de turno longa). */
  slowSpeculation?: boolean
  /**
   * Reprodução falsa: cada utterance emitida toca na ordem pelo tempo dado (relógio falso) e o
   * `playback-idle` sai quando a fila esvazia — como o renderer. Ausente = o teste chama
   * `playbackIdle()` à mão.
   */
  autoPlay?: Partial<PlayDurations>
}

interface Harness {
  m: VoiceCallManager
  clock: FakeTimers
  emitted: VoiceCallUtterance[]
  /** Momento (relógio falso) da emissão de cada utterance. */
  emittedAt: Map<string, number>
  /** Reprodução falsa (`autoPlay`): o que tocou, quando começou e quando acabou. */
  played: PlayRec[]
  cancelled: string[]
  timeline: VoiceCallTimelineEvent[]
  /** Textos pedidos à síntese de SENTENÇA (`synth`). */
  synthTexts: string[]
  /** Pedidos à síntese de FRASE (`synthPhrase`). */
  phrases: PhraseCall[]
  /** Clipes pedidos (`CLASSE_n`). */
  clipCalls: string[]
  amends: { spoken: Record<string, string[]> }[]
  markers: { content: string; meta: MessageMeta }[]
  feedCalls: string[]
  emit(e: AgentEvent): void
  /** Emitidas de frase de espera (kind 'delay'), com o texto decodificado. */
  delays(): string[]
  history: StoredMessage[]
}

const dec = (u: VoiceCallUtterance): string => new TextDecoder().decode(u.audio)
const THANKS_POOL = [...DEFAULT_THANKS_POOL]
/** Texto de uma utterance de espera (síntese `PHRASE:<texto>` ou clipe `CLIP:THANKS_<n>`). */
const phraseText = (raw: string): string => {
  const clip = /^CLIP:THANKS_(\d+)$/.exec(raw)
  if (clip) return THANKS_POOL[Number(clip[1]) - 1] ?? '?'
  return raw.replace(/^PHRASE:/, '')
}
const isKeepAlive = (raw: string): boolean => {
  const t = phraseText(raw)
  return DEFAULT_KEEPALIVE_POOL.includes(t) || DEFAULT_KEEPALIVE_TOOL_POOL.includes(t)
}
const isThanks = (raw: string): boolean => THANKS_POOL.includes(phraseText(raw))

function harness(opts: HarnessOpts = {}): Harness {
  const listeners: ((e: AgentEvent) => void)[] = []
  const clock = new FakeTimers()
  const h: Harness = {
    m: null as unknown as VoiceCallManager,
    clock,
    emitted: [],
    emittedAt: new Map(),
    played: [],
    cancelled: [],
    timeline: [],
    synthTexts: [],
    phrases: [],
    clipCalls: [],
    amends: [],
    markers: [],
    feedCalls: [],
    history: [],
    emit: (e) => listeners.forEach((l) => l(e)),
    delays: () => h.emitted.filter((u) => u.kind === 'delay').map(dec)
  }
  let userSeq = 0
  const defaults = {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    fillers: { ...DEFAULT_VOICE_CALL_DEFAULTS.fillers, enabled: opts.fillers !== false },
    delayPhrases: { ...DEFAULT_DELAY_PHRASES, ...(opts.delay ?? {}) }
  }
  const feed: TtsTextFeed = {
    begin: () => void h.feedCalls.push('begin'),
    partial: (t) => void h.feedCalls.push(`partial:${t}`),
    cut: (t) => void h.feedCalls.push(`cut:${t}`),
    end: () => void h.feedCalls.push('end'),
    reset: () => void h.feedCalls.push('reset'),
    close: () => void h.feedCalls.push('close')
  }
  // reprodução falsa: fila na ordem, uma por vez, `playback-idle` quando esvazia
  const durations: PlayDurations | null = opts.autoPlay
    ? { filler: 1000, delay: 1500, tool: 1000, sentence: 2000, ...opts.autoPlay }
    : null
  const queue: VoiceCallUtterance[] = []
  let playing: PlayRec | null = null
  const playNext = (): void => {
    const u = queue.shift()
    if (!u || !durations) {
      playing = null
      h.m.playbackIdle()
      return
    }
    const kind = u.kind ?? 'sentence'
    const rec: PlayRec = { id: u.id, kind, text: dec(u), start: clock.now, end: -1 }
    playing = rec
    h.played.push(rec)
    clock.set(
      () => {
        rec.end = clock.now
        playNext()
      },
      durations[kind as keyof PlayDurations] ?? durations.sentence
    )
  }
  h.m = new VoiceCallManager({
    // o runner grava a mensagem do usuário DENTRO do envio (como o real)
    sendTurn: (_sid, text) => {
      const u: StoredMessage = {
        id: `mu${++userSeq}`,
        sessionId: 's1',
        seq: h.history.length + 1,
        message: { role: 'user', content: text },
        createdAt: clock.now
      }
      h.history.push(u)
      h.emit({ type: 'message-added', message: u })
    },
    synth: async (text) => {
      h.synthTexts.push(text)
      return { audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }
    },
    synthPhrase: (text, signal) =>
      new Promise((resolve, reject) => {
        const call: PhraseCall = {
          text,
          signal,
          resolve: () =>
            resolve({ audio: new TextEncoder().encode(`PHRASE:${text}`), mime: 'audio/wav' }),
          reject
        }
        h.phrases.push(call)
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        if (opts.manualPhrases) return
        if (opts.phraseLatencyMs) clock.set(call.resolve, opts.phraseLatencyMs)
        else queueMicrotask(call.resolve)
      }),
    timers: { set: clock.set, clear: clock.clear },
    now: () => clock.now,
    rng: () => 0.3,
    fillerDelayMs: opts.fillerDelayMs ?? 0,
    emitState: () => {},
    emitUtterance: (u) => {
      h.emitted.push(u)
      h.emittedAt.set(u.id, clock.now)
      if (!durations) return
      queue.push(u)
      if (!playing) playNext()
    },
    emitUtteranceCancel: (id) => void h.cancelled.push(id),
    emitTimeline: (e) => void h.timeline.push({ ...e }),
    logEval: () => {},
    clip: async (cls, n) => {
      h.clipCalls.push(`${cls}_${n}`)
      if (cls === 'THANKS' && opts.thanksClips === false) return null
      return { audio: new TextEncoder().encode(`CLIP:${cls}_${n}`), mime: 'audio/wav' }
    },
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults,
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    amendTurn: async (_sid, amend: VoiceCallAmend) => {
      h.amends.push({ spoken: typeof amend.spoken === 'function' ? amend.spoken() : amend.spoken })
    },
    appendMarker: (_sid, content, meta) => void h.markers.push({ content, meta }),
    sessionMessages: () => h.history,
    newCallId: () => 'call-1',
    ...(opts.ttsFeed ? { ttsFeed: () => feed } : {}),
    ...(opts.slowSpeculation ? { slowSpeculation: () => true } : {})
  })
  h.m.start('s1')
  return h
}

const LONG_Q = 'me explica com calma como funciona a fotossíntese nas plantas'

/** Espera o preâmbulo sair — o timer dele (espera 0) é do relógio falso (os mesmos timers). */
async function waitFiller(h: Harness): Promise<void> {
  for (let i = 0; i < 50 && !h.emitted.some((u) => u.kind === 'filler'); i++)
    await h.clock.advance(0)
  assert.ok(
    h.emitted.some((u) => u.kind === 'filler'),
    'preâmbulo tocou'
  )
}

/** Fala → turno enviado (o preâmbulo é armado com a espera do harness). */
function userTurn(h: Harness, text = LONG_Q): void {
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.turn(text)
}

/** Fala → turno (o filler sai na hora — espera 0 — e o renderer avisa o fim dele em `fillerMs`). */
async function turnWithFiller(h: Harness, fillerMs = 1000): Promise<void> {
  userTurn(h)
  await waitFiller(h)
  await h.clock.advance(fillerMs)
  h.m.playbackIdle() // o preâmbulo terminou de tocar
}

let aSeq = 0
/** A resposta chega inteira (raciocínio longo e depois o texto de uma vez). */
async function answer(h: Harness, text: string, opts: { done?: boolean } = {}): Promise<string> {
  const id = `ma${++aSeq}`
  h.emit({ type: 'draft', sessionId: 's1', draft: { content: text } } as unknown as AgentEvent)
  const a: StoredMessage = {
    id,
    sessionId: 's1',
    seq: h.history.length + 1,
    message: { role: 'assistant', content: text },
    createdAt: h.clock.now
  }
  h.history.push(a)
  h.emit({ type: 'message-added', message: a })
  if (opts.done !== false)
    h.emit({ type: 'session-updated', session: { id: 's1', status: 'idle' } } as AgentEvent)
  await flush()
  return id
}

let tSeq = 0
/** O assistente chama UMA tool (mensagem com tool_calls, texto opcional antes) e ela começa a rodar. */
async function callTool(h: Harness, name = 'web_search', content = ''): Promise<string> {
  const id = `tc${++tSeq}`
  const a: StoredMessage = {
    id: `mt${tSeq}`,
    sessionId: 's1',
    seq: h.history.length + 1,
    message: {
      role: 'assistant',
      content,
      tool_calls: [{ id, type: 'function' as const, function: { name, arguments: '{}' } }]
    },
    createdAt: h.clock.now
  } as StoredMessage
  h.history.push(a)
  if (content)
    h.emit({ type: 'draft', sessionId: 's1', draft: { content } } as unknown as AgentEvent)
  h.emit({ type: 'message-added', message: a })
  h.emit({ type: 'tool-running', sessionId: 's1', toolCallId: id, running: true } as AgentEvent)
  await flush()
  return id
}
const toolDone = (h: Harness, id: string): void =>
  h.emit({ type: 'tool-running', sessionId: 's1', toolCallId: id, running: false } as AgentEvent)

const decisions = (h: Harness, cls: string): VoiceCallTimelineEvent[] =>
  h.timeline.filter((e) => e.kind === 'decision' && e.class === cls)
const playedOf = (h: Harness, cls: string): VoiceCallTimelineEvent[] =>
  decisions(h, cls).filter((e) => e.played)

/** Frases curtas tocadas (preâmbulo/ferramenta/espera), na ordem. */
const shortsOf = (h: Harness): PlayRec[] => h.played.filter((p) => p.kind !== 'sentence')
const keepAlivesOf = (h: Harness): PlayRec[] =>
  h.played.filter((p) => p.kind === 'delay' && isKeepAlive(p.text))
const thanksOf = (h: Harness): PlayRec[] =>
  h.played.filter((p) => p.kind === 'delay' && isThanks(p.text))

// ---------------- o bug do silêncio (uso real) ----------------

test('bug do silêncio: ruído/"uhum" durante a espera (depois da frase de ferramenta) não cala a espera — a "manter viva" ainda vem', async () => {
  for (const noise of ['', 'uhum']) {
    const h = harness({ autoPlay: {}, fillerDelayMs: 2500 })
    const t0 = h.clock.now
    userTurn(h)
    await h.clock.advance(1000)
    await callTool(h, 'web_search') // frase de ferramenta aos 1 s (clipe, 1 s)
    assert.equal(h.played.filter((p) => p.kind === 'tool').length, 1)
    await h.clock.until(t0 + 5000)
    // o microfone captou algo (tosse, respiração, eco, "uhum"): antes, `speech-begin` ZERAVA as
    // frases de espera do turno e a transcrição vazia/backchannel nunca as rearmava — silêncio total
    h.m.speechBegin({ dropped: [] })
    await h.clock.advance(600)
    h.m.speechEnd()
    await h.clock.advance(400)
    h.m.turn(noise)
    const resumed = h.clock.now
    await h.clock.until(t0 + 30_000)
    const kas = keepAlivesOf(h)
    assert.equal(kas.length, 2, `ruído "${noise}": as 2 "manter viva" ainda tocam`)
    assert.equal(kas[0].start, resumed + 8000, '8 s de silêncio desde o fim do ruído')
    assert.equal(kas[1].start - kas[0].end, 8000)
    h.m.stop()
  }
})

test('bug do silêncio: o modelo anunciou a tool ("Vou pesquisar isso.") e PENSA DE NOVO depois dela — a "manter viva" continua (antes: só com tool rodando)', async () => {
  const h = harness({ autoPlay: {}, fillerDelayMs: 2500 })
  const t0 = h.clock.now
  userTurn(h)
  await h.clock.advance(1000)
  const id = await callTool(h, 'web_search', 'Vou pesquisar isso.')
  // a frase do próprio modelo toca (2 s) e a frase de ferramenta é pulada (anunciada)
  assert.ok(decisions(h, 'TOOL').some((e) => e.reason === 'web/announced'))
  await h.clock.until(t0 + 4000)
  toolDone(h, id) // tool rápida (3 s): o modelo volta a pensar — sem tool rodando
  await h.clock.until(t0 + 40_000)
  const kas = keepAlivesOf(h)
  assert.equal(kas.length, 2, 'as 2 "manter viva" com o modelo pensando de novo')
  const sentenceEnd = h.played.find((p) => p.kind === 'sentence')!.end
  assert.equal(kas[0].start, sentenceEnd + 8000, '8 s depois do fim da frase do modelo')
  assert.ok(
    DEFAULT_KEEPALIVE_POOL.includes(phraseText(kas[0].text)),
    'pool "pensando" (nenhuma tool rodando)'
  )
  await answer(h, 'Achei: a fotossíntese usa luz.')
  assert.equal(thanksOf(h).length, 1, 'e agradece antes da resposta que encerrou a espera')
  h.m.stop()
})

test('bug: "manter viva" pulada depois de sintetizada NÃO gasta o limite do turno', async () => {
  // síntese de 3 s; a frase de ferramenta começa a tocar enquanto a 1ª "manter viva" sintetiza →
  // pulada (assistant-audio); antes ela gastava 1 das 2 do turno — agora ainda saem 2 faladas
  const h = harness({ fillers: false, phraseLatencyMs: 3000, autoPlay: {} })
  const t0 = h.clock.now
  userTurn(h)
  await h.clock.until(t0 + 8000) // "manter viva" devida: síntese começa (pronta aos 11 s)
  assert.equal(h.phrases.length, 1)
  // a tool começa aos 10,5 s; o clipe da frase de ferramenta toca na hora (10,5 → 11,5 s)
  await h.clock.until(t0 + 10_500)
  await callTool(h, 'shell')
  await h.clock.until(t0 + 60_000)
  assert.ok(decisions(h, 'KEEPALIVE').some((e) => !e.played && e.reason === 'assistant-audio'))
  assert.equal(keepAlivesOf(h).length, KEEPALIVE_MAX_PER_TURN, 'ainda 2 faladas')
  h.m.stop()
})

// ---------------- os cenários pedidos ----------------

test('(a) tool às 1 s, tool de 30 s, resposta aos 35 s: frase de ferramenta → "manter viva" 8 s depois → outra 8 s depois → obrigado → resposta', async () => {
  const h = harness({ autoPlay: {}, fillerDelayMs: 2500 })
  const t0 = h.clock.now
  userTurn(h)
  await h.clock.advance(1000)
  const id = await callTool(h, 'web_search')
  await h.clock.until(t0 + 31_000)
  toolDone(h, id)
  await h.clock.until(t0 + 35_000)
  const t = h.clock.now
  await answer(h, 'Pronto, achei o que você pediu.')
  await h.clock.advance(10_000)
  const kinds = h.played.map((p) =>
    p.kind === 'delay' ? (isThanks(p.text) ? 'thanks' : 'keepalive') : p.kind
  )
  assert.deepEqual(kinds, ['tool', 'keepalive', 'keepalive', 'thanks', 'sentence'])
  const [tool, ka1, ka2, thanks, sentence] = h.played
  assert.equal(tool.start, t0 + 1000, 'frase de ferramenta no lugar do preâmbulo')
  assert.equal(
    ka1.start - tool.end,
    8000,
    '1ª "manter viva" 8 s depois do FIM da frase de ferramenta'
  )
  assert.equal(ka2.start - ka1.end, 8000, '2ª 8 s depois do FIM da 1ª')
  assert.ok(
    DEFAULT_KEEPALIVE_TOOL_POOL.includes(phraseText(ka1.text)),
    'tool rodando → pool "ferramenta"'
  )
  assert.notEqual(ka1.text, ka2.text, 'sem repetir')
  assert.ok(t - ka2.end >= 4500, 'a resposta chegou ≥ 4,5 s depois da última')
  assert.equal(thanks.start, t, 'obrigado na hora (clipe pré-gerado)')
  assert.ok(isThanks(thanks.text))
  assert.ok(
    h.clipCalls.some((c) => c.startsWith('THANKS_')),
    'clipe THANKS'
  )
  assert.equal(
    h.emittedAt.get(h.emitted.find((u) => u.kind === 'sentence')!.id),
    t,
    'a resposta sai na hora'
  )
  assert.equal(sentence.start, thanks.end, 'a frase espera o obrigado terminar (sem corte)')
  assert.equal(playedOf(h, 'FILLER').length, 0, 'nenhum preâmbulo')
  assert.equal(playedOf(h, 'THANKS').length, 1)
  assert.equal(h.synthTexts.length, 1, 'só a frase da resposta pela síntese de sentença')
  h.m.stop()
})

test('(b) "manter viva" e a resposta 2 s depois → sem obrigado (e tocando agora → também não, sem corte)', async () => {
  const h = harness({ autoPlay: {}, fillerDelayMs: 2500 })
  const t0 = h.clock.now
  userTurn(h)
  await h.clock.advance(1000)
  await callTool(h, 'web_search')
  await h.clock.until(t0 + 11_500) // 1ª "manter viva" terminou (10 s → 11,5 s)
  assert.equal(keepAlivesOf(h).length, 1)
  await h.clock.advance(2000)
  await answer(h, 'Aqui está.')
  await h.clock.advance(5000)
  assert.equal(thanksOf(h).length, 0, 'falou "só mais um instante" há 2 s: não precisa')
  assert.ok(decisions(h, 'THANKS').some((e) => !e.played && e.reason === 'too-soon'))
  // resposta chegando com a "manter viva" ainda tocando: espera ela terminar, sem obrigado
  const g = harness({ autoPlay: {}, fillerDelayMs: 2500 })
  const g0 = g.clock.now
  userTurn(g)
  await g.clock.advance(1000)
  await callTool(g, 'web_search')
  await g.clock.until(g0 + 10_500)
  await answer(g, 'Aqui está.')
  await g.clock.advance(5000)
  assert.equal(thanksOf(g).length, 0)
  const ka = keepAlivesOf(g)[0]
  const s = g.played.find((p) => p.kind === 'sentence')!
  assert.equal(s.start, ka.end, 'a resposta entra logo depois da "manter viva" (nada cortado)')
  assert.equal(g.cancelled.length, 0)
  h.m.stop()
  g.m.stop()
})

test('(c) sem "manter viva" (resposta 6 s depois da frase de ferramenta) → sem obrigado, nada preparado', async () => {
  const h = harness({ autoPlay: {}, fillerDelayMs: 2500, thanksClips: false })
  const t0 = h.clock.now
  userTurn(h)
  await h.clock.advance(1000)
  await callTool(h, 'web_search')
  await h.clock.until(t0 + 2000 + 6000)
  await answer(h, 'Pronto.')
  await h.clock.advance(10_000)
  assert.equal(keepAlivesOf(h).length, 0)
  assert.equal(thanksOf(h).length, 0)
  assert.equal(decisions(h, 'THANKS').length, 0, 'nada a explicar: não houve espera longa')
  assert.equal(h.phrases.length, 0, 'nada sintetizado (nem o obrigado)')
  assert.ok(!h.clipCalls.some((c) => c.startsWith('THANKS_')))
  h.m.stop()
})

test('(d) obrigado sem clipe e ainda sintetizando quando a resposta chega → pulado (abortado); a resposta nunca espera', async () => {
  const h = harness({ autoPlay: {}, fillerDelayMs: 2500, thanksClips: false, manualPhrases: true })
  const t0 = h.clock.now
  userTurn(h)
  await h.clock.advance(1000)
  await callTool(h, 'web_search')
  await h.clock.until(t0 + 10_000)
  assert.equal(h.phrases.length, 1, '"manter viva" sintetizando')
  h.phrases[0].resolve()
  await flush()
  assert.equal(keepAlivesOf(h).length, 1)
  // a 1ª "manter viva" falada: o obrigado (sem clipe) começa a sintetizar EM PARALELO já
  assert.equal(h.phrases.length, 2)
  assert.ok(
    THANKS_POOL.includes(h.phrases[1].text),
    'síntese do obrigado assim que a 1ª foi falada'
  )
  await h.clock.until(t0 + 18_000) // última frase de espera terminou há 6,5 s
  const t = h.clock.now
  await answer(h, 'Pronto, aqui está a resposta.')
  const sentence = h.emitted.find((u) => u.kind === 'sentence')!
  assert.equal(h.emittedAt.get(sentence.id), t, 'a frase saiu sem esperar o obrigado')
  assert.equal(h.phrases[1].signal.aborted, true, 'síntese do obrigado abortada')
  h.phrases[1].resolve() // chega tarde: ignorada
  await h.clock.advance(5000)
  assert.equal(thanksOf(h).length, 0)
  assert.ok(decisions(h, 'THANKS').some((e) => !e.played && e.reason === 'not-ready'))
  // pronto a tempo (síntese ao vivo, sem clipe): toca, e os caracteres contam no custo
  const g = harness({ autoPlay: {}, fillerDelayMs: 2500, thanksClips: false })
  const g0 = g.clock.now
  userTurn(g)
  await g.clock.advance(1000)
  await callTool(g, 'web_search')
  await g.clock.until(g0 + 18_000)
  await answer(g, 'Pronto.')
  await g.clock.advance(5000)
  assert.equal(thanksOf(g).length, 1, 'síntese ao vivo pronta → toca')
  assert.ok(playedOf(g, 'THANKS')[0].reason?.endsWith('/live'))
  g.m.stop()
  const end = g.markers.find((m) => (m.meta.voiceCall as VoiceCallMark).phase === 'end')!
  const usage = (end.meta.voiceCall as VoiceCallMark).usage!
  const phraseChars = g.phrases.reduce((n, p) => n + p.text.length, 0)
  assert.equal(
    usage.tts.chars,
    phraseChars + 'Pronto.'.length,
    '"manter viva" + obrigado + resposta'
  )
  h.m.stop()
})

test('(e) preâmbulo (sem tool, resposta lenta): preâmbulo aos 2,5 s → "manter viva" ×2 a cada 8 s de silêncio → obrigado → resposta', async () => {
  for (const [answerAt, thanks] of [
    [30_000, true], // última "manter viva" terminou aos 22,5 s → 7,5 s
    [25_000, false] // 2,5 s depois → sem obrigado
  ] as const) {
    const h = harness({ autoPlay: {}, fillerDelayMs: 2500 })
    const t0 = h.clock.now
    userTurn(h)
    await h.clock.until(t0 + answerAt)
    const t = h.clock.now
    await answer(h, 'A resposta, enfim. Com duas frases.')
    await h.clock.advance(15_000)
    const shorts = shortsOf(h)
    assert.equal(shorts[0].kind, 'filler')
    assert.equal(shorts[0].start, t0 + 2500, 'preâmbulo só porque a resposta demorou')
    const kas = keepAlivesOf(h)
    assert.equal(kas.length, 2)
    assert.equal(kas[0].start - shorts[0].end, 8000, '8 s depois do FIM do preâmbulo')
    assert.equal(kas[1].start - kas[0].end, 8000)
    assert.ok(DEFAULT_KEEPALIVE_POOL.includes(phraseText(kas[0].text)), 'o modelo pensando')
    assert.equal(thanksOf(h).length, thanks ? 1 : 0, `resposta aos ${answerAt / 1000} s`)
    const first = h.emitted.find((u) => u.kind === 'sentence')!
    assert.equal(h.emittedAt.get(first.id), t, 'a 1ª frase é emitida assim que fica pronta')
    h.m.stop()
  }
})

// ---------------- regras e garantias ----------------

test('manter viva: sem preâmbulo conta 8 s de silêncio desde o envio; limiar configurado vale', async () => {
  const h = harness({ fillers: false })
  userTurn(h)
  await h.clock.advance(7999)
  assert.equal(h.phrases.length, 0)
  await h.clock.advance(1)
  assert.equal(h.phrases.length, 1, '8 s de silêncio desde o envio')
  assert.equal(h.synthTexts.length, 0, 'nunca pela síntese de sentença (contexto da resposta)')
  assert.equal(h.m.state().phase, 'thinking', 'a fase continua "Pensando…"')
  const g = harness({ delay: { keepAliveAfterMs: 12_000 } })
  await turnWithFiller(g, 1000)
  await g.clock.advance(11_999)
  assert.equal(g.phrases.length, 0)
  await g.clock.advance(1)
  assert.equal(g.phrases.length, 1, '12 s depois do FIM do preâmbulo')
})

test('manter viva: latência da síntese e duração do áudio não comem o silêncio (conta do FIM da anterior)', async () => {
  const h = harness({ phraseLatencyMs: 3000, autoPlay: { filler: 1000, delay: 2500 } })
  userTurn(h)
  await waitFiller(h)
  await h.clock.advance(60_000)
  const shorts = shortsOf(h)
  assert.deepEqual(
    shorts.map((p) => p.kind),
    ['filler', 'delay', 'delay'],
    'preâmbulo + 2 "manter viva" (no máx. 2)'
  )
  const [pre, ka1, ka2] = shorts
  assert.equal(ka1.start - pre.end, 8000 + 3000, '8 s de silêncio + a síntese')
  assert.equal(ka2.start - ka1.end, 8000 + 3000)
  assert.equal(h.clock.pending, 0, 'nenhum timer pendurado')
})

test('manter viva em voo é abortada quando a resposta chega antes (nunca toca depois)', async () => {
  const h = harness({ manualPhrases: true })
  await turnWithFiller(h, 1000)
  await h.clock.advance(8000)
  assert.equal(h.phrases.length, 1)
  await answer(h, 'Chegou a resposta.')
  assert.equal(h.phrases[0].signal.aborted, true)
  h.phrases[0].resolve()
  await flush()
  assert.equal(h.delays().length, 0)
  assert.ok(decisions(h, 'KEEPALIVE').some((e) => !e.played && e.reason === 'answer-first'))
})

test('nunca com o usuário falando: a fala aborta a síntese e corta a frase tocando; fala de verdade vira turno novo', async () => {
  const h = harness({ manualPhrases: true })
  await turnWithFiller(h, 1000)
  await h.clock.advance(8000)
  assert.equal(h.phrases.length, 1)
  h.m.speechBegin() // o usuário voltou a falar
  assert.equal(h.phrases[0].signal.aborted, true)
  await h.clock.advance(60_000)
  assert.equal(h.phrases.length, 1, 'nada enquanto o usuário fala (por mais longa que seja a fala)')
  // tocando: a fala do usuário corta (o renderer já descartou; o main manda cancelar)
  const g = harness()
  await turnWithFiller(g, 1000)
  await g.clock.advance(8000)
  const id = g.emitted.find((u) => u.kind === 'delay')!.id
  g.m.speechBegin()
  assert.ok(g.cancelled.includes(id), 'frase de espera cancelada com fade')
  // o renderer avisa a fila vazia (clipe cortado) enquanto o usuário ainda fala: nada conta
  g.m.playbackIdle()
  await g.clock.advance(30_000)
  assert.equal(g.delays().length, 1, 'nada por cima da fala')
  // a fala vira turno continuado (texto de verdade): o turno novo rearma do zero
  g.m.speechEnd()
  g.m.turn('na verdade quero saber da respiração das plantas')
  await flush()
  assert.ok(g.timeline.some((e) => e.kind === 'turn-continued'))
})

test('nunca depois do barge-in, do end_call (desligamento armado) nem com resposta de erro', async () => {
  // barge-in no meio da resposta (tool rodando depois da 1ª frase): nada mais
  const b = harness()
  await turnWithFiller(b, 1000)
  await answer(b, 'Vou ver isso.', { done: false })
  b.emit({ type: 'tool-running', sessionId: 's1', toolCallId: 'tx', running: true } as AgentEvent)
  b.m.bargeIn({ playedIds: [] })
  b.m.playbackIdle()
  await b.clock.advance(60_000)
  assert.equal(b.phrases.length, 0)
  // controle: sem o barge-in a espera depois da 1ª frase tem "manter viva" — 8 s do FIM dela
  const c = harness()
  await turnWithFiller(c, 1000)
  await answer(c, 'Vou ver isso.', { done: false })
  c.emit({ type: 'tool-running', sessionId: 's1', toolCallId: 'tx', running: true } as AgentEvent)
  await c.clock.advance(1000)
  c.m.playbackIdle()
  await c.clock.advance(7999)
  assert.equal(c.delays().length, 0)
  await c.clock.advance(1)
  assert.equal(c.delays().length, 1, 'tool longa depois da 1ª frase: "manter viva"')
  // end_call: o desligamento armado cala as frases de espera
  const e = harness()
  await turnWithFiller(e, 1000)
  const a: StoredMessage = {
    id: 'a-end',
    sessionId: 's1',
    seq: 9,
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'end_call', arguments: '{}' } }]
    },
    createdAt: 1
  }
  e.history.push(a)
  e.emit({ type: 'message-added', message: a })
  e.emit({
    type: 'message-added',
    message: {
      id: 't-end',
      sessionId: 's1',
      seq: 10,
      message: { role: 'tool', tool_call_id: 'tc1', content: END_CALL_RESULT },
      meta: { toolStatus: 'ok' },
      createdAt: 2
    }
  })
  assert.ok(e.timeline.some((t) => t.kind === 'hangup-armed'))
  await e.clock.advance(60_000)
  assert.equal(e.phrases.length, 0, 'nada depois do end_call')
  // resposta de erro: a chamada encerra, nada é falado
  const r = harness()
  await turnWithFiller(r, 1000)
  r.emit({
    type: 'message-added',
    message: {
      id: 'err',
      sessionId: 's1',
      seq: 3,
      message: { role: 'assistant', content: 'Falhou' },
      meta: { kind: 'error', error: 'HTTP 500' },
      createdAt: 3
    }
  } as AgentEvent)
  assert.equal(r.m.state().active, false)
  await r.clock.advance(60_000)
  assert.equal(r.phrases.length, 0)
})

test('aprovação/pergunta na tela: nada de "só mais um instante" enquanto a sessão espera o usuário', async () => {
  const h = harness({ fillers: false })
  userTurn(h)
  await h.clock.advance(2000)
  h.emit({
    type: 'session-updated',
    session: { id: 's1', status: 'awaiting_approval' }
  } as AgentEvent)
  await h.clock.advance(60_000)
  assert.equal(h.phrases.length, 0, 'esperando a aprovação do usuário')
  h.emit({ type: 'session-updated', session: { id: 's1', status: 'running' } } as AgentEvent)
  await h.clock.advance(7999)
  assert.equal(h.phrases.length, 0)
  await h.clock.advance(1)
  assert.equal(h.phrases.length, 1, 'voltou a rodar: 8 s de silêncio daqui')
})

test('espera no meio da resposta: o obrigado entra antes da frase que encerra a espera (1 por turno)', async () => {
  const h = harness({ autoPlay: {} })
  await turnWithFiller(h, 1000)
  await answer(h, 'Vou procurar isso nos arquivos.', { done: false })
  const id = await callTool(h, 'read_file')
  await h.clock.advance(40_000)
  toolDone(h, id)
  const t = h.clock.now
  await answer(h, 'Pronto, achei o arquivo.')
  await h.clock.advance(10_000)
  assert.equal(
    keepAlivesOf(h).length,
    2,
    `2 "manter viva" na tool longa: ${h.delays().join(' | ')}`
  )
  const kinds = h.played.map((p) =>
    p.kind === 'delay' ? (isThanks(p.text) ? 'thanks' : 'keepalive') : p.kind
  )
  assert.deepEqual(kinds.slice(-2), ['thanks', 'sentence'], 'obrigado logo antes da frase seguinte')
  const last = h.emitted.filter((u) => u.kind === 'sentence').at(-1)!
  assert.equal(h.emittedAt.get(last.id), t, 'a frase sai na hora')
})

test('variedade: "manter viva" e obrigado não repetem as últimas entre turnos', async () => {
  const h = harness({ fillers: false, autoPlay: {} })
  const seen: { ka: string[]; th: string[] } = { ka: [], th: [] }
  for (let turn = 0; turn < 4; turn++) {
    const t0 = h.clock.now
    userTurn(h, `${LONG_Q} ${turn}`)
    await h.clock.until(t0 + 30_000)
    await answer(h, `Resposta ${turn}.`)
    await h.clock.advance(5000)
  }
  for (const p of h.played)
    if (p.kind === 'delay') (isThanks(p.text) ? seen.th : seen.ka).push(phraseText(p.text))
  assert.equal(seen.th.length, 4, 'um obrigado por turno')
  for (let i = 1; i < seen.th.length; i++) assert.notEqual(seen.th[i], seen.th[i - 1])
  for (let i = 2; i < seen.th.length; i++) assert.notEqual(seen.th[i], seen.th[i - 2])
  for (let i = 1; i < seen.ka.length; i++) assert.notEqual(seen.ka[i], seen.ka[i - 1])
  for (let i = 2; i < seen.ka.length; i++) assert.notEqual(seen.ka[i], seen.ka[i - 2])
})

test('frases de espera fora do histórico: o barge-in trunca só às frases da RESPOSTA', async () => {
  const h = harness()
  await turnWithFiller(h, 1000)
  await h.clock.advance(8000) // "manter viva" aos 9 s
  h.m.playbackIdle() // terminou
  await h.clock.advance(6000)
  const id = await answer(h, 'Primeira frase. Segunda frase.', { done: false })
  const delays = h.emitted.filter((u) => u.kind === 'delay')
  assert.equal(delays.length, 2, '"manter viva" + obrigado')
  const first = h.emitted.find((u) => u.kind === 'sentence')!.id
  h.m.bargeIn({ playedIds: [...delays.map((u) => u.id), first] })
  await flush()
  assert.equal(h.amends.length, 1)
  assert.deepEqual(h.amends[0].spoken, { [id]: ['Primeira frase.'] }, 'sem as frases de espera')
})

test('desligado (delayPhrases.enabled false): nada', async () => {
  const h = harness({ delay: { enabled: false } })
  await turnWithFiller(h, 1000)
  await h.clock.advance(60_000)
  await answer(h, 'Pronto.')
  assert.equal(h.phrases.length, 0)
  assert.equal(h.delays().length, 0)
  assert.equal(h.clock.pending, 0)
})

test('ElevenLabs (tts-feed): as frases de espera vão por request à parte — nunca no contexto da resposta', async () => {
  const h = harness({ ttsFeed: true, thanksClips: false })
  await turnWithFiller(h, 1000)
  await h.clock.advance(8000)
  h.m.playbackIdle()
  await h.clock.advance(6000)
  await answer(h, 'Resposta.')
  assert.equal(h.delays().length, 2, '"manter viva" + obrigado (ao vivo)')
  for (const p of h.phrases)
    assert.ok(
      !h.feedCalls.some((c) => c.includes(p.text)),
      `"${p.text}" nunca vai ao feed: ${h.feedCalls.join(' | ')}`
    )
  assert.ok(h.feedCalls.includes('cut:Resposta.'), 'a resposta segue pelo feed')
})

test('resposta inteira depois de raciocínio longo (turno já ocioso na síntese): o obrigado ainda entra', async () => {
  const h = harness()
  await turnWithFiller(h, 1000)
  await h.clock.advance(8000)
  h.m.playbackIdle()
  await h.clock.advance(6000)
  await answer(h, 'Demorou mas veio.') // done = session idle logo depois
  const kinds = h.emitted.map((u) =>
    u.kind === 'delay' ? (isThanks(dec(u)) ? 'thanks' : 'ka') : u.kind
  )
  assert.deepEqual(kinds, ['filler', 'ka', 'thanks', 'sentence'])
  h.m.playbackIdle()
  await h.clock.advance(60_000)
  assert.equal(h.clock.pending, 0, 'a espera acabou com a resposta')
})

test('métricas: frases de espera tocadas e "não tocou" no seu balde', () => {
  const ev = (p: Partial<VoiceCallTimelineEvent>): VoiceCallTimelineEvent => ({
    ts: 1,
    kind: 'decision',
    ...p
  })
  const m = computeVoiceCallMetrics([
    ev({ class: 'KEEPALIVE', played: true }),
    ev({ class: 'THANKS', played: false, reason: 'too-soon' }),
    ev({ class: 'THANKS', played: true }),
    ev({ class: 'FILLER', played: true })
  ])
  assert.equal(m.fillerPlayed, 1)
  assert.deepEqual(m.delayPlayed, { keepAlive: 1, thanks: 1 })
  assert.deepEqual(m.skipped.delay, { 'too-soon': 1 })
})

// =====================================================================================
// preâmbulo × fala mínima: tempo com VOZ (o silêncio do fim de turno não conta)
// =====================================================================================

/** Quadros de 100 ms: `voz`/`sil` em ms → RMS acima/abaixo do limiar. */
function frames(...parts: ['voz' | 'sil', number][]): number[] {
  const out: number[] = []
  for (const [k, ms] of parts)
    for (let i = 0; i < ms / 100; i++) out.push(k === 'voz' ? 0.2 : 0.001)
  return out
}
const THRESHOLD = 0.02

/** O que o renderer mede: `VoicedSpan` sobre os quadros da fala (início no 1º quadro com voz). */
function voicedSpanOf(fs: number[]): number {
  const v = new VoicedSpan()
  for (const rms of fs) v.push(rms, 100, THRESHOLD)
  return v.spanMs
}

test('VoicedSpan: 1º → último quadro com voz; silêncio antes/depois e a espera do fim de turno fora', () => {
  const fs = frames(['sil', 300], ['voz', 1500], ['sil', 400], ['voz', 1500], ['sil', 2000])
  const v = new VoicedSpan()
  for (const rms of fs) v.push(rms, 100, THRESHOLD)
  assert.equal(v.spanMs, 3400, 'pausa interna conta; silêncio inicial e final não')
  assert.equal(v.voicedMs, 3000)
  v.reset()
  assert.equal(v.spanMs, 0)
  assert.equal(fillerBelowMinSpeech(3000, 5000), true)
  assert.equal(fillerBelowMinSpeech(6000, 5000), false)
  assert.equal(fillerBelowMinSpeech(null, 5000), false, 'desconhecido (digitado) não barra')
})

/** Fala pela chamada: transcrição final (áudio com o silêncio) + turno com o tempo com voz. */
async function spokenTurn(
  h: Harness,
  text: string,
  speech: number[],
  audioMs: number
): Promise<void> {
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.noteTranscript({ text, model: 'whisper', backend: 'api', audioMs })
  h.m.turn(text, { speechMs: voicedSpanOf(speech) })
  await h.clock.advance(0) // o preâmbulo (espera 0) usa o timer do relógio falso
}
const fillerDecision = (h: Harness): VoiceCallTimelineEvent | undefined =>
  h.timeline.find((e) => e.kind === 'decision' && e.class === 'FILLER')

test(`fala mínima (${FILLER_MIN_SPEECH_MS} ms de voz): 0,5 s de fala + 2 s de silêncio no fim → SEM preâmbulo (o silêncio não conta)`, async () => {
  const h = harness()
  const q = 'qual é a diferença entre fotossíntese e respiração celular?'
  await spokenTurn(h, q, frames(['voz', 500], ['sil', 2000]), 2500)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0)
  const d = fillerDecision(h)!
  assert.equal(d.played, false)
  assert.equal(d.reason, 'below-min-speech')
  assert.equal(d.speechMs, 500, 'tempo com voz, não os 2,5 s do áudio')
})

test('fala mínima: 1,5 s de fala → preâmbulo (pergunta → frase de pergunta)', async () => {
  const h = harness()
  const q = 'qual é a diferença entre fotossíntese e respiração celular nas plantas?'
  await spokenTurn(h, q, frames(['sil', 200], ['voz', 1500], ['sil', 1200]), 2900)
  const fillers = h.emitted.filter((u) => u.kind === 'filler')
  assert.equal(fillers.length, 1)
  assert.match(fillerDecision(h)!.reason ?? '', /question/)
})

test('fala mínima com STT só por API (espera de fim de turno longa): fala curta segue sem preâmbulo', async () => {
  const h = harness({ slowSpeculation: true })
  // 0,6 s de fala; a especulação pela API demora e o turno só fecha 3,5 s depois — o áudio enviado
  // à transcrição tem ~4,1 s, mas a voz é 0,6 s
  const q = 'me explica como funciona o ciclo da água por favor'
  await spokenTurn(h, q, frames(['voz', 600], ['sil', 3500]), 4100)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0)
  assert.equal(fillerDecision(h)!.reason, 'below-min-speech')
})

test('comando curto "abre o arquivo" (padrão 700 ms de voz): preâmbulo de COMANDO, nunca "Boa pergunta"', async () => {
  const h = harness()
  await spokenTurn(h, 'abre o arquivo', frames(['voz', 900], ['sil', 1500]), 2400)
  const d = fillerDecision(h)!
  assert.equal(d.played, true)
  assert.match(d.reason ?? '', /command/)
  const clip = dec(h.emitted.find((u) => u.kind === 'filler')!)
  // pool padrão: índices de "comando" (Beleza/Tá/Certo/Um instante) — nunca o 2 ("Boa pergunta")
  assert.notEqual(clip, 'CLIP:FILLER_2')
})

test('mensagem digitada na chamada (sem medida de voz): a fala mínima não se aplica', async () => {
  const h = harness()
  h.emit({
    type: 'message-added',
    message: {
      id: 'typed',
      sessionId: 's1',
      seq: 1,
      message: { role: 'user', content: 'qual a capital da Austrália e por que não é Sydney?' },
      createdAt: 1
    }
  })
  await h.clock.advance(0)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 1)
})

test('pickFillerPhrase: frase só de pergunta nunca sai sem pergunta (nem como último recurso)', () => {
  const pool = [
    { text: 'Boa pergunta, deixa eu pensar.', contexts: ['question' as const] },
    { text: 'Um instante.', contexts: ['command' as const] }
  ]
  for (let i = 0; i < 20; i++)
    assert.equal(
      pickFillerPhrase(pool, 'generic', [1], () => i / 20),
      1,
      'cai na usada, não na de pergunta'
    )
  assert.equal(
    pickFillerPhrase([pool[0]], 'command', [], () => 0),
    null,
    'só pergunta no pool → nada'
  )
  assert.equal(
    pickFillerPhrase(pool, 'question', [], () => 0),
    0
  )
})
