// Fila de utterances da chamada de voz (renderer): toca os bytes wav/mp3 das sentenças na ordem,
// SEM sobreposição, com estados `idle`/`playing`. Barge-in = `cancel()` (pausa o atual e descarta
// a fila). O player é injetável (testes usam fake; a fábrica padrão é `new Audio` com blob URL,
// liberado ao terminar). Utterances em streaming (`streaming: true`, `audio/pcm;rate=N` — TTS de API
// com PCM progressivo) tocam pela Web Audio conforme os pedaços chegam (`pushChunk`). Frases PCM
// seguidas se EMENDAM sem buraco: quando a atual já agendou todo o áudio, a seguinte é pré-iniciada
// e agendada no mesmo relógio, exatamente onde a atual termina (sem rampa) — ela só vira "atual"
// (evento `start`, conta como ouvida) quando a anterior termina de tocar.
// Ver SPEC.md → "Áudio → Chamada de voz (meia-duplex)" e "Serviço de TTS → Streaming na chamada".
import type { VoiceCallUtteranceChunkEvent, VoiceCallUtteranceEvent } from '@shared/ipc'

export type UtteranceState = 'idle' | 'playing'

/** Player de uma utterance (o mínimo que a fila precisa — `new Audio` satisfaz). */
export interface UtterancePlayer {
  play(): void | Promise<void>
  pause(): void
  /** O áudio terminou (toque completo). */
  onended: (() => void) | null
  /** Falha ao carregar/tocar (a fila segue para a próxima); `reason` legível quando conhecido. */
  onerror: ((reason?: string) => void) | null
  /** Volume 0..1 (a fila propaga `setVolume`). */
  volume: number
  /** Libera recursos (blob URL etc.) — chamado ao terminar/cancelar. */
  dispose?(): void
  /**
   * Todo o áudio já foi agendado (stream acabou; falta só tocar) — a fila pré-inicia a próxima
   * utterance PCM emendada nesta. Ausente = player que não encadeia (`<audio>`).
   */
  onscheduled?: (() => void) | null
  /** Encadeia com outras utterances (agenda no relógio compartilhado)? */
  readonly chains?: boolean
  /** Parada anunciada (rampa de saída começando): não agenda mais nada e solta o relógio. */
  detach?(): void
  /** Quanto já tocou (ms) — o "ouvido" do barge-in em palavras e a leitura ao vivo. */
  readonly positionMs?: number
  /** Duração total (ms) quando conhecida (stream terminado / mídia carregada); null = ainda não. */
  readonly durationMs?: number | null
}

/**
 * Pedaços PCM16 de uma utterance em streaming: o começo (`audio` do evento) + o que chegar por
 * `voice:call:utterance-chunk`. Quem assina recebe o que já chegou e depois o resto, ao vivo.
 */
export class PcmStreamSource {
  readonly sampleRate: number
  #chunks: Uint8Array[] = []
  #ended = false
  #listener: { chunk: (pcm: Uint8Array) => void; end: () => void } | null = null

  constructor(sampleRate: number, first?: Uint8Array) {
    this.sampleRate = sampleRate
    if (first?.length) this.#chunks.push(first)
  }

  get ended(): boolean {
    return this.#ended
  }

  push(pcm: Uint8Array): void {
    if (this.#ended || !pcm.length) return
    this.#chunks.push(pcm)
    this.#listener?.chunk(pcm)
  }

  end(): void {
    if (this.#ended) return
    this.#ended = true
    this.#listener?.end()
  }

  /** Assina (um ouvinte): repassa o que já chegou e segue ao vivo; devolve o cancelamento. */
  subscribe(chunk: (pcm: Uint8Array) => void, end: () => void): () => void {
    this.#listener = { chunk, end }
    for (const c of this.#chunks) chunk(c)
    if (this.#ended) end()
    return () => {
      if (this.#listener?.chunk === chunk) this.#listener = null
    }
  }
}

/** Taxa do `audio/pcm;rate=N` (null = não é PCM cru). */
export function pcmRateOf(mime: string): number | null {
  const m = /^audio\/pcm\b.*?\brate=(\d+)/i.exec(mime)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Fábrica de player por utterance (bytes + mime → player pronto para `play`). Utterance em
 * streaming chega com o `stream` (PCM16 aos pedaços) — `audio` é só o começo.
 */
export type PlayerFactory = (
  audio: Uint8Array,
  mime: string,
  stream?: PcmStreamSource
) => UtterancePlayer

/** Player padrão: blob URL + `new Audio` (sem dependências; liberado no `dispose`). */
class DomAudioPlayer implements UtterancePlayer {
  onended: (() => void) | null = null
  onerror: ((reason?: string) => void) | null = null
  readonly #el: HTMLAudioElement
  readonly #url: string

  constructor(audio: Uint8Array, mime: string) {
    // cópia exata: o buffer de origem pode ser uma visão maior (bytes do IPC)
    const copy = audio.slice()
    this.#url = URL.createObjectURL(new Blob([copy], { type: mime }))
    this.#el = new Audio(this.#url)
    this.#el.onended = () => this.onended?.()
    this.#el.onerror = () => {
      const err = this.#el.error
      this.onerror?.(
        err ? `erro de mídia ${err.code}${err.message ? `: ${err.message}` : ''}` : 'erro de mídia'
      )
    }
  }

  get volume(): number {
    return this.#el.volume
  }

  set volume(v: number) {
    this.#el.volume = v
  }

  get positionMs(): number {
    const t = this.#el.currentTime
    return Number.isFinite(t) ? t * 1000 : 0
  }

  get durationMs(): number | null {
    const d = this.#el.duration
    return Number.isFinite(d) && d > 0 ? d * 1000 : null
  }

  /** Devolve a promise do `<audio>`: rejeição (autoplay/decodificação) chega à fila, que avança. */
  play(): Promise<void> {
    return this.#el.play()
  }

  pause(): void {
    this.#el.pause()
  }

  dispose(): void {
    this.#el.pause()
    this.#el.onended = null
    this.#el.onerror = null
    URL.revokeObjectURL(this.#url)
  }
}

/** Antecedência do agendamento na Web Audio (s) — absorve o jitter entre pedaços. */
const PCM_LEAD_S = 0.03
/** Rampa de entrada (ms) no começo da utterance e depois de um buraco (underrun) — sem estalo. */
export const PCM_FADE_IN_MS = 5
/**
 * Quanto (em quadros) cada pedaço começa ANTES do quadro exato dele: o Chromium (Electron 44 /
 * Chrome 152, medido num OfflineAudioContext em 2026-11-13 — `e2e/voice-playback.spec.ts`) erra o
 * fim de um `AudioBufferSourceNode` cujo início cai EXATAMENTE num quadro — em parte dos pedaços o resto
 * do quantum de 128 quadros sai com o áudio de 128 quadros antes (lixo somado ao pedaço seguinte:
 * o "estalinho" contínuo na fala da chamada, a cada pedaço da rede). Com o início um milésimo de
 * quadro antes, a saída é idêntica ao PCM amostra a amostra (a interpolação de 0,001 quadro é
 * inaudível — erro < 1e-5) e o fim sai certo. Ver `pcmNodeStartTime`.
 */
export const PCM_START_EARLY_FRAMES = 1e-3
/**
 * Constante de tempo (s) da mudança de volume no player PCM (ducking/fade de saída): a rampa em
 * passos de 10 ms vira uma curva contínua no relógio do áudio — sem degraus ("zíper") no ganho.
 */
export const PCM_VOLUME_SMOOTH_S = 0.004

/** Instante (s) do `start()` do nó que deve começar no quadro `frame` (ver `PCM_START_EARLY_FRAMES`). */
export function pcmNodeStartTime(frame: number, sampleRate: number): number {
  return Math.max(0, frame - PCM_START_EARLY_FRAMES) / sampleRate
}

// ---------------- partes puras do player PCM (testadas em e2e/voiceCallFix.test.ts) ----------------

/** PCM16 LE (bytes, tamanho par) → amostras float −1..1. */
export function pcm16ToFloat(pcm: Uint8Array): Float32Array {
  const n = pcm.length >> 1
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000
  return out
}

/** Rampa linear de entrada nas primeiras `frames` amostras (no lugar). */
export function applyFadeIn(samples: Float32Array, frames: number): void {
  const n = Math.min(samples.length, Math.max(0, Math.floor(frames)))
  for (let i = 0; i < n; i++) samples[i] *= (i + 1) / (n + 1)
}

/**
 * Reamostrador linear CONTÍNUO entre pedaços (só usado quando o AudioContext não pôde abrir na
 * taxa do stream): guarda a última amostra e a fase, então reamostrar pedaço a pedaço dá
 * exatamente o mesmo que reamostrar o stream inteiro — sem costura nas fronteiras.
 */
export class PcmStreamResampler {
  readonly #step: number
  #pos = 0
  #prev: number | null = null

  constructor(fromRate: number, toRate: number) {
    this.#step = fromRate / toRate
  }

  push(input: Float32Array): Float32Array {
    const n = input.length
    if (!n) return new Float32Array(0)
    // sequência virtual [prev, ...input]: o índice -1 é a última amostra do pedaço anterior
    const at = (i: number): number => (i < 0 ? (this.#prev ?? input[0]) : input[i])
    const out: number[] = []
    let p = this.#pos
    for (;;) {
      const i0 = Math.floor(p)
      const frac = p - i0
      if (frac === 0) {
        if (i0 > n - 1) break
        out.push(at(i0))
      } else {
        if (i0 + 1 > n - 1) break
        out.push(at(i0) + (at(i0 + 1) - at(i0)) * frac)
      }
      p += this.#step
    }
    this.#pos = p - n
    this.#prev = input[n - 1]
    return Float32Array.from(out)
  }
}

/**
 * Relógio de agendamento em QUADROS inteiros da taxa do contexto: cada pedaço começa exatamente
 * onde o anterior terminou (sem lacuna nem sobreposição); atrasou (underrun) → recomeça
 * `leadS` à frente do relógio, avisando (`gap`) para o chamador suavizar a entrada.
 */
export class PcmScheduleClock {
  readonly rate: number
  #next: number | null = null

  constructor(rate: number) {
    this.rate = rate
  }

  place(frames: number, nowS: number, leadS = PCM_LEAD_S): { startFrame: number; gap: boolean } {
    const earliest = Math.ceil((nowS + leadS) * this.rate)
    const first = this.#next == null
    const gap = !first && (this.#next as number) < Math.ceil(nowS * this.rate)
    const startFrame = first || gap ? earliest : (this.#next as number)
    this.#next = startFrame + frames
    return { startFrame, gap }
  }

  get nextFrame(): number | null {
    return this.#next
  }

  /** Esquece o fim agendado (o áudio foi cortado): o próximo pedaço recomeça à frente do relógio. */
  reset(): void {
    this.#next = null
  }
}

/**
 * Relógio de agendamento COMPARTILHADO por AudioContext: as utterances PCM seguidas da chamada
 * agendam no mesmo relógio — a frase seguinte começa no quadro exato em que a anterior termina.
 */
const scheduleClocks = new WeakMap<object, PcmScheduleClock>()
export function scheduleClockFor(ctx: { sampleRate: number }): PcmScheduleClock {
  let c = scheduleClocks.get(ctx)
  if (!c || c.rate !== ctx.sampleRate) {
    c = new PcmScheduleClock(ctx.sampleRate)
    scheduleClocks.set(ctx, c)
  }
  return c
}

/**
 * Um AudioContext por taxa do stream (`new AudioContext({ sampleRate })`): o PCM de 24 kHz do TTS
 * agendado em pedaços num contexto de 48 kHz era reamostrado NÓ A NÓ e cada fronteira de pedaço
 * (~28 ms) ganhava um degrau de até ~0,6 da escala cheia — o "pzzz/rrrr" na fala da chamada. Na
 * taxa do stream os pedaços se emendam amostra a amostra; o navegador reamostra a saída inteira
 * de uma vez para o dispositivo. Taxa recusada → o contexto padrão + `PcmStreamResampler`.
 */
const audioContexts = new Map<number, AudioContext>()
function audioContextFor(rate: number): AudioContext {
  let ctx = audioContexts.get(rate)
  if (!ctx || ctx.state === 'closed') {
    try {
      ctx = new AudioContext({ sampleRate: rate, latencyHint: 'interactive' })
    } catch {
      ctx = audioContexts.get(0)
      if (!ctx || ctx.state === 'closed') {
        ctx = new AudioContext({ latencyHint: 'interactive' })
        audioContexts.set(0, ctx)
      }
    }
    audioContexts.set(rate, ctx)
  }
  return ctx
}

/**
 * Player de PCM16 em streaming pela Web Audio: cada pedaço vira um `AudioBufferSourceNode`
 * agendado em quadros inteiros, emendado no anterior no relógio COMPARTILHADO do contexto
 * (`scheduleClockFor` — a utterance seguinte continua exatamente onde esta termina), num contexto
 * na taxa do stream (sem reamostragem por nó — ver `audioContextFor`); rampa de 5 ms só quando
 * recomeça (começo da fala, depois de um corte ou de um underrun) — nunca entre frases emendadas;
 * termina quando o stream acabou e o último trecho tocou. Volume por `GainNode`.
 */
export class WebAudioPcmPlayer implements UtterancePlayer {
  onended: (() => void) | null = null
  onerror: ((reason?: string) => void) | null = null
  onscheduled: (() => void) | null = null
  readonly chains = true
  readonly #source: PcmStreamSource
  #ctx: AudioContext | null = null
  #gain: GainNode | null = null
  #volume = 1
  #clock: PcmScheduleClock | null = null
  #resampler: PcmStreamResampler | null = null
  #nodes = new Set<AudioBufferSourceNode>()
  #unsubscribe: (() => void) | null = null
  #streamEnded = false
  #finished = false
  #stopped = false
  /** Parada anunciada (rampa de saída): nada mais é agendado. */
  #detached = false
  /** Quadro (exclusivo) onde termina o último nó agendado por este player. */
  #lastEnd: number | null = null
  /** Quadro do 1º nó agendado (o começo audível desta utterance) e quadros agendados no total. */
  #firstFrame: number | null = null
  #frames = 0

  readonly #contextFor: (rate: number) => AudioContext

  /** `contextFor` injetável (testes renderizam o agendamento num contexto falso). */
  constructor(
    source: PcmStreamSource,
    contextFor: (rate: number) => AudioContext = audioContextFor
  ) {
    this.#source = source
    this.#contextFor = contextFor
  }

  get volume(): number {
    return this.#volume
  }

  set volume(v: number) {
    this.#volume = v
    const gain = this.#gain
    const ctx = this.#ctx
    if (!gain) return
    // no relógio do áudio, com uma curva curta: o ducking/fade de saída chegam em passos de 10 ms
    // (setInterval) — cada passo seco no `value` era um degrau audível
    if (ctx && typeof gain.gain.setTargetAtTime === 'function')
      gain.gain.setTargetAtTime(v, ctx.currentTime, PCM_VOLUME_SMOOTH_S)
    else gain.gain.value = v
  }

  get positionMs(): number {
    const ctx = this.#ctx
    if (!ctx || this.#firstFrame == null) return 0
    const ms = (ctx.currentTime - this.#firstFrame / ctx.sampleRate) * 1000
    return Math.max(0, Math.min(ms, (this.#frames / ctx.sampleRate) * 1000))
  }

  get durationMs(): number | null {
    const ctx = this.#ctx
    return ctx && this.#streamEnded ? (this.#frames / ctx.sampleRate) * 1000 : null
  }

  async play(): Promise<void> {
    const ctx = this.#contextFor(this.#source.sampleRate)
    this.#ctx = ctx
    this.#clock = scheduleClockFor(ctx)
    this.#resampler =
      ctx.sampleRate === this.#source.sampleRate
        ? null
        : new PcmStreamResampler(this.#source.sampleRate, ctx.sampleRate)
    const gain = ctx.createGain()
    gain.gain.value = this.#volume
    gain.connect(ctx.destination)
    this.#gain = gain
    if (ctx.state === 'suspended') await ctx.resume()
    if (this.#stopped) return
    this.#unsubscribe = this.#source.subscribe(
      (pcm) => this.#schedule(pcm),
      () => {
        this.#streamEnded = true
        // todo o áudio já está agendado: a fila pode emendar a próxima utterance
        if (!this.#stopped && !this.#detached) this.onscheduled?.()
        this.#check()
      }
    )
  }

  #schedule(pcm: Uint8Array): void {
    const ctx = this.#ctx
    const gain = this.#gain
    const clock = this.#clock
    if (!ctx || !gain || !clock || this.#stopped || this.#detached) return
    let samples = pcm16ToFloat(pcm)
    if (this.#resampler) samples = this.#resampler.push(samples)
    if (!samples.length) return
    // contíguo em quadros inteiros enquanto o próximo pedaço chega antes da hora (inclusive o 1º
    // pedaço desta utterance, emendado no fim da anterior); atrasou (underrun) ou relógio sem nada
    // agendado → recomeça um pouco à frente, com rampa de entrada (sem estalo)
    const fresh = clock.nextFrame == null
    const { startFrame, gap } = clock.place(samples.length, ctx.currentTime)
    if (fresh || gap) applyFadeIn(samples, (PCM_FADE_IN_MS / 1000) * ctx.sampleRate)
    this.#lastEnd = startFrame + samples.length
    this.#firstFrame ??= startFrame
    this.#frames += samples.length
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
    buffer.getChannelData(0).set(samples)
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(gain)
    node.start(pcmNodeStartTime(startFrame, ctx.sampleRate))
    this.#nodes.add(node)
    node.onended = () => {
      this.#nodes.delete(node)
      this.#check()
    }
  }

  #check(): void {
    if (this.#finished || this.#stopped || !this.#streamEnded || this.#nodes.size) return
    this.#finished = true
    this.onended?.()
  }

  /** O relógio compartilhado aponta para o fim deste player: esquece (o áudio foi cortado). */
  #releaseClock(): void {
    if (this.#clock && this.#lastEnd != null && this.#clock.nextFrame === this.#lastEnd)
      this.#clock.reset()
  }

  detach(): void {
    this.#detached = true
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#releaseClock()
  }

  pause(): void {
    this.#stopped = true
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#releaseClock()
    for (const node of this.#nodes) {
      node.onended = null
      try {
        node.stop()
      } catch {
        /* ainda não começou / já parou */
      }
    }
    this.#nodes.clear()
  }

  dispose(): void {
    this.pause()
    this.#gain?.disconnect()
    this.#gain = null
  }
}

/**
 * Para um player: na hora (`fadeMs` 0) ou com rampa linear de volume até 0 em `fadeMs` (passos de
 * ~10 ms) — clipe/frase interrompidos nunca cortam seco no meio da palavra.
 */
function stopPlayer(player: UtterancePlayer, fadeMs: number): void {
  // nada mais é agendado e o relógio compartilhado fica livre já (a fala seguinte não espera o fim
  // do áudio cortado)
  try {
    player.detach?.()
  } catch {
    /* player sem relógio */
  }
  const finish = (): void => {
    try {
      player.pause()
    } catch {
      /* player já parado */
    }
    player.dispose?.()
  }
  if (!(fadeMs > 0) || typeof setInterval !== 'function') return finish()
  const start = player.volume
  const steps = Math.max(1, Math.round(fadeMs / 10))
  let i = 0
  const timer = setInterval(() => {
    i++
    try {
      player.volume = Math.max(0, start * (1 - i / steps))
    } catch {
      /* player sem volume ajustável */
    }
    if (i >= steps) {
      clearInterval(timer)
      finish()
    }
  }, fadeMs / steps)
}

export function domPlayerFactory(
  audio: Uint8Array,
  mime: string,
  stream?: PcmStreamSource
): UtterancePlayer {
  const rate = pcmRateOf(mime)
  if (rate !== null) {
    // PCM cru: streaming (pedaços chegando) ou um bloco só, fechado
    let source = stream
    if (!source) {
      source = new PcmStreamSource(rate, audio)
      source.end()
    }
    return new WebAudioPcmPlayer(source)
  }
  return new DomAudioPlayer(audio, mime)
}

export interface UtteranceQueueOptions {
  /** Fábrica de players (padrão `domPlayerFactory`). */
  playerFactory?: PlayerFactory
  /** Mudança de estado ('idle' = fila vazia e nada tocando; 'playing' = há áudio em curso). */
  onState?: (state: UtteranceState) => void
  /** Início/fim da reprodução de cada utterance (timeline da chamada — cancelas não emitem 'end'). */
  onItem?: (e: { item: VoiceCallUtteranceEvent; phase: 'start' | 'end' }) => void
  /**
   * A utterance NÃO tocou (bytes ilegíveis, `play()` rejeitado — autoplay/CSP/codec —, erro de
   * mídia): a fila segue para a próxima, mas o motivo chega aqui (nunca falha calada).
   */
  onError?: (e: { item: VoiceCallUtteranceEvent; reason: string }) => void
}

/** Uma utterance com player criado (a atual, ou a seguinte pré-iniciada emendada nela). */
interface Entry {
  item: VoiceCallUtteranceEvent
  player: UtterancePlayer
  /** Virou a atual (evento `start` emitido — conta como ouvida). */
  started: boolean
  settled: boolean
  /** O player terminou antes de virar a atual (pré-iniciada). */
  ended: boolean
  /** Falhou antes de virar a atual (motivo, reportado quando ela vira a atual). */
  failed: string | null
  /** Todo o áudio já está agendado. */
  scheduled: boolean
}

/**
 * Fila de reprodução (uma por chamada). `enqueue` aceita qualquer ordem de chegada e toca
 * estritamente na ordem; `cancel()` (barge-in) pausa o que estiver tocando e descarta o resto —
 * o texto da resposta segue completo no histórico. `state`/`pending` alimentam a UI. Utterances
 * PCM seguidas (mesma taxa) se emendam sem buraco: a seguinte é pré-iniciada quando a atual já
 * agendou todo o áudio, mas só vira a atual (evento `start`) quando a anterior termina de tocar.
 */
export class UtteranceQueue {
  #factory: PlayerFactory
  #onState: ((state: UtteranceState) => void) | undefined
  #onItem: ((e: { item: VoiceCallUtteranceEvent; phase: 'start' | 'end' }) => void) | undefined
  #onError: ((e: { item: VoiceCallUtteranceEvent; reason: string }) => void) | undefined
  #queue: VoiceCallUtteranceEvent[] = []
  /** Pedaços das utterances em streaming (por id), da chegada até o fim do stream. */
  #streams = new Map<string, PcmStreamSource>()
  #cur: Entry | null = null
  /** A seguinte, já agendada logo depois do fim da atual (ainda não audível). */
  #next: Entry | null = null
  #state: UtteranceState = 'idle'
  #volume = 1
  /** Fator do ducking (1 = normal; < 1 = o usuário fala por cima — `setDuck`). */
  #duck = 1
  #duckTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: UtteranceQueueOptions = {}) {
    this.#factory = options.playerFactory ?? domPlayerFactory
    this.#onState = options.onState
    this.#onItem = options.onItem
    this.#onError = options.onError
  }

  get state(): UtteranceState {
    return this.#state
  }

  /** Utterances aguardando (não inclui a que está tocando). */
  get pending(): number {
    return this.#queue.length + (this.#next ? 1 : 0)
  }

  /** A utterance tocando agora (null = nada). */
  get current(): VoiceCallUtteranceEvent | null {
    return this.#cur?.item ?? null
  }

  /**
   * Posição da utterance tocando agora: quanto já tocou e a duração total quando conhecida (o
   * barge-in em palavras e a leitura ao vivo). null = nada tocando.
   */
  currentPosition(): { id: string; playedMs: number; durationMs: number | null } | null {
    const e = this.#cur
    if (!e || !e.started) return null
    const p = e.player
    return {
      id: e.item.id,
      playedMs: Math.max(0, Math.round(p.positionMs ?? 0)),
      durationMs: p.durationMs != null ? Math.round(p.durationMs) : null
    }
  }

  /** Ids das utterances aguardando (na ordem; sem a que está tocando — a pré-iniciada entra). */
  get queuedIds(): string[] {
    return [...(this.#next ? [this.#next.item.id] : []), ...this.#queue.map((u) => u.id)]
  }

  /** Volume 0..1 (propagado ao player atual e aos seguintes). */
  get volume(): number {
    return this.#volume
  }

  setVolume(volume: number): void {
    this.#volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1
    this.#applyVolume()
  }

  /** Fator do ducking atual (1 = normal). */
  get duck(): number {
    return this.#duck
  }

  /**
   * Ducking (barge-in com histerese): o áudio do assistente vai ao fator `gain` (0..1; 1 = volta ao
   * normal) numa rampa linear de `fadeMs` (passos de ~10 ms) e CONTINUA tocando — vale para o que
   * toca e para o que vier depois, até o próximo `setDuck`. `fadeMs` 0 = na hora.
   */
  setDuck(gain: number, fadeMs = 0): void {
    const target = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1
    if (this.#duckTimer) clearInterval(this.#duckTimer)
    this.#duckTimer = null
    const from = this.#duck
    if (!(fadeMs > 0) || typeof setInterval !== 'function' || from === target) {
      this.#duck = target
      this.#applyVolume()
      return
    }
    const steps = Math.max(1, Math.round(fadeMs / 10))
    let i = 0
    this.#duckTimer = setInterval(() => {
      i++
      this.#duck = from + (target - from) * Math.min(1, i / steps)
      this.#applyVolume()
      if (i >= steps && this.#duckTimer) {
        clearInterval(this.#duckTimer)
        this.#duckTimer = null
      }
    }, fadeMs / steps)
  }

  #applyVolume(): void {
    const v = this.#volume * this.#duck
    for (const e of [this.#cur, this.#next]) if (e) e.player.volume = v
  }

  /** Enfileira uma utterance (bytes completos) — toca na ordem, sem sobreposição. */
  enqueue(utterance: VoiceCallUtteranceEvent): void {
    const rate = utterance.streaming ? pcmRateOf(utterance.mime) : null
    if (rate !== null) this.#streams.set(utterance.id, new PcmStreamSource(rate, utterance.audio))
    this.#queue.push(utterance)
    if (this.#cur?.scheduled) this.#preStart()
    this.#pump()
  }

  /**
   * Próximo pedaço de uma utterance em streaming (`voice:call:utterance-chunk`): na fila ou
   * tocando, o áudio é acrescentado; `done` fecha o stream. Id desconhecido (cancelada) = ignorado.
   */
  pushChunk(e: VoiceCallUtteranceChunkEvent): void {
    const source = this.#streams.get(e.id)
    if (!source) return
    if (e.pcm?.length) source.push(e.pcm)
    // a fonte fica no mapa até a utterance terminar de tocar (ou ser descartada): o player dela
    // pode nem ter começado ainda
    if (e.done) source.end()
  }

  /**
   * Barge-in/parada: pausa o atual e descarta a fila (nada mais toca até o próximo enqueue).
   * `fadeMs` > 0 = o atual sai com rampa de volume (sem corte seco no meio da palavra).
   */
  cancel(fadeMs = 0): void {
    this.#queue = []
    this.#streams.clear()
    const cur = this.#cur
    const next = this.#next
    this.#cur = null
    this.#next = null
    if (next) stopPlayer(next.player, 0) // ainda não audível: sai seco
    if (cur) stopPlayer(cur.player, fadeMs)
    this.#setState('idle')
  }

  /**
   * Cancela UMA utterance pelo id (ex.: filler interrompido pela 1ª sentença da resposta): na
   * fila → só descarta; tocando → pausa/limpa e avança para a seguinte. Id desconhecido = sem efeito.
   */
  drop(id: string, fadeMs = 0): void {
    this.#queue = this.#queue.filter((u) => u.id !== id)
    this.#streams.delete(id)
    if (this.#next?.item.id === id) {
      const next = this.#next
      this.#next = null
      stopPlayer(next.player, 0)
    }
    if (this.#cur?.item.id !== id) return
    const cur = this.#cur
    this.#cur = null
    stopPlayer(cur.player, fadeMs)
    // a pré-iniciada estava agendada depois do fim do áudio cortado: recomeça do zero
    this.#requeueNext()
    if (!this.#queue.length) this.#setState('idle')
    else this.#pump()
  }

  #requeueNext(): void {
    const next = this.#next
    if (!next) return
    this.#next = null
    stopPlayer(next.player, 0)
    this.#queue.unshift(next.item)
  }

  #pump(): void {
    if (this.#cur) return
    const pre = this.#next
    if (pre) {
      this.#next = null
      this.#promote(pre)
      return
    }
    const item = this.#queue.shift()
    if (!item) return
    this.#setState('playing')
    const entry = this.#create(item)
    if (!entry) {
      // bytes ilegíveis (já reportado): segue para a próxima
      if (!this.#queue.length) this.#setState('idle')
      this.#pump()
      return
    }
    this.#promote(entry)
    this.#run(entry)
  }

  /** Cria o player da utterance (null = bytes ilegíveis — reportado em `onError`). */
  #create(item: VoiceCallUtteranceEvent): Entry | null {
    let player: UtterancePlayer
    try {
      player = this.#factory(item.audio, item.mime, this.#streams.get(item.id))
    } catch (e) {
      this.#streams.delete(item.id)
      this.#onError?.({
        item,
        reason: `áudio ilegível: ${e instanceof Error ? e.message : String(e)}`
      })
      return null
    }
    const entry: Entry = {
      item,
      player,
      started: false,
      settled: false,
      ended: false,
      failed: null,
      scheduled: false
    }
    player.volume = this.#volume * this.#duck
    player.onended = () => this.#ended(entry)
    player.onerror = (reason?: string) => this.#failed(entry, reason || 'erro ao tocar')
    if (player.chains)
      player.onscheduled = () => {
        entry.scheduled = true
        if (entry === this.#cur) this.#preStart()
      }
    return entry
  }

  /** `play()` (rejeição — autoplay/CSP/codec — vira falha da utterance). */
  #run(entry: Entry): void {
    const fail = (e: unknown): void =>
      this.#failed(
        entry,
        `play() recusado: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`
      )
    try {
      const r = entry.player.play()
      if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).catch(fail)
    } catch (e) {
      fail(e)
    }
  }

  /** A utterance vira a atual (audível): evento `start`. */
  #promote(entry: Entry): void {
    this.#cur = entry
    this.#setState('playing')
    entry.started = true
    this.#onItem?.({ item: entry.item, phase: 'start' })
    if (entry.failed != null) {
      const reason = entry.failed
      entry.failed = null
      this.#failed(entry, reason)
      return
    }
    if (entry.ended) {
      this.#ended(entry)
      return
    }
    if (entry.scheduled) this.#preStart()
  }

  /**
   * A atual já agendou todo o áudio: pré-inicia a seguinte (PCM na mesma taxa) — ela agenda no
   * relógio compartilhado, exatamente onde a atual termina.
   */
  #preStart(): void {
    const cur = this.#cur
    if (this.#next || !cur || cur.settled || !cur.player.chains) return
    const item = this.#queue[0]
    if (!item) return
    const rate = pcmRateOf(item.mime)
    if (rate === null || rate !== pcmRateOf(cur.item.mime)) return
    this.#queue.shift()
    const entry = this.#create(item)
    if (!entry) return
    if (!entry.player.chains) {
      // a fábrica deu um player que não encadeia: segue o fluxo normal (depois da atual)
      entry.player.dispose?.()
      this.#queue.unshift(item)
      return
    }
    this.#next = entry
    this.#run(entry)
  }

  #ended(entry: Entry): void {
    if (entry.settled) return
    if (entry === this.#next) {
      entry.ended = true
      return
    }
    if (entry !== this.#cur) return // velho (cancel()/drop() + enqueue novo)
    this.#finish(entry)
  }

  #failed(entry: Entry, reason: string): void {
    if (entry.settled) return
    if (entry === this.#next) {
      entry.failed ??= reason
      return
    }
    // só se ainda é a utterance atual (play() interrompido por cancel/drop não é falha)
    if (entry !== this.#cur) return
    this.#onError?.({ item: entry.item, reason })
    this.#finish(entry)
  }

  #finish(entry: Entry): void {
    entry.settled = true
    this.#cur = null
    this.#streams.delete(entry.item.id)
    entry.player.dispose?.()
    if (entry.started) this.#onItem?.({ item: entry.item, phase: 'end' })
    if (!this.#queue.length && !this.#next) this.#setState('idle')
    this.#pump()
  }

  #setState(state: UtteranceState): void {
    if (this.#state === state) return
    this.#state = state
    this.#onState?.(state)
  }
}
