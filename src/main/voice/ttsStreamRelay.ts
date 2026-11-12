// Ponte de streaming do TTS para a chamada de voz (main, sem Electron — testável): quando o endpoint
// de fala devolve PCM progressivo (`synthesizeStream` — ex.: OpenRouter/ElevenLabs), a síntese da
// sentença resolve assim que ~200 ms de áudio chegaram, com esse começo como `audio`
// (`audio/pcm;rate=N`); o resto segue baixando e vai ao renderer por `voice:call:utterance-chunk`
// depois que a chamada emitir a utterance. Assim a 1ª sentença começa a tocar no 1º pedaço, não no
// fim do corpo.
//
// Encaixe SEM mudar `call.ts`: a chamada recebe `{ audio, mime }` do `synth` e repassa o MESMO
// `audio` ao `emitUtterance` — a ponte reconhece o começo pela identidade do `Uint8Array`
// (WeakMap) e marca o evento com `streaming: true`. Sentença descartada pela chamada (barge-in
// durante a síntese) nunca é emitida: o stream é abortado pelo `signal` da chamada, ou pela ponte
// depois de `UNCLAIMED_MS`. `abortAll()` (barge-in/parar) derruba os downloads em curso.
// Ver SPEC → "Serviço de TTS → Streaming na chamada".
import type { VoiceCallUtteranceChunkEvent, VoiceCallUtteranceEvent } from '@shared/ipc'
import type { TtsStreamResult } from './tts'
import { concatBytes } from './wav'

/** Áudio acumulado antes de entregar o começo da sentença (o resto chega bem mais rápido que o tempo real). */
export const TTS_STREAM_PREBUFFER_MS = 200

/** Começo não emitido pela chamada depois deste tempo → stream abortado (sentença descartada). */
const UNCLAIMED_MS = 30_000

interface Entry {
  ctl: AbortController
  iterator: AsyncIterator<Uint8Array>
  /** Pedaços que chegaram antes da emissão (despejados ao emitir). */
  buffered: Uint8Array[]
  /** Id da utterance depois de emitida (null = ainda não). */
  id: string | null
  ended: boolean
  error: string | null
  timer: ReturnType<typeof setTimeout>
}

export interface TtsStreamRelayDeps {
  /** Envia um pedaço ao renderer (`voice:call:utterance-chunk`). */
  emitChunk(e: VoiceCallUtteranceChunkEvent): void
  /** Envia a utterance ao renderer (`voice:call:utterance`). */
  emitUtterance(u: VoiceCallUtteranceEvent): void
  /** Pré-buffer em ms (padrão `TTS_STREAM_PREBUFFER_MS`). */
  prebufferMs?: number
  /** Diagnóstico: latência até o 1º áudio de cada sentença (ms desde o início da request). */
  onFirstAudio?(ms: number, streaming: boolean): void
  /**
   * O stream de uma sentença JÁ emitida falhou no meio (o que chegou termina de tocar): a chamada
   * decide (fatal → encerra; transitória → uma falta) — nunca calado.
   */
  onStreamError?(e: unknown): void
}

export class TtsStreamRelay {
  readonly #deps: TtsStreamRelayDeps
  readonly #heads = new WeakMap<Uint8Array, Entry>()
  readonly #live = new Set<Entry>()

  constructor(deps: TtsStreamRelayDeps) {
    this.#deps = deps
  }

  /** Streams vivos (diagnóstico/testes). */
  get liveCount(): number {
    return this.#live.size
  }

  /**
   * `synth` da chamada: `start(signal)` abre a síntese (normalmente `synthesizeStream`). Sem
   * streaming → os bytes completos. Com streaming → resolve com o começo (≥ pré-buffer) e segue
   * baixando em segundo plano; áudio que acabou dentro do pré-buffer vira um bloco PCM fechado.
   */
  async synth(
    signal: AbortSignal,
    start: (signal: AbortSignal) => Promise<TtsStreamResult>
  ): Promise<{ audio: Uint8Array; mime: string; unitStartsMs?: () => number[] | null }> {
    const ctl = new AbortController()
    const linked = AbortSignal.any([signal, ctl.signal])
    const r = await start(linked)
    if (!r.streaming) {
      this.#deps.onFirstAudio?.(r.result.ms, false)
      return { audio: r.result.audio, mime: r.result.mime }
    }
    const iterator = r.chunks[Symbol.asyncIterator]()
    const target = Math.max(
      2,
      Math.round((r.sampleRate * 2 * (this.#deps.prebufferMs ?? TTS_STREAM_PREBUFFER_MS)) / 1000)
    )
    const head: Uint8Array[] = []
    let size = 0
    for (;;) {
      let n: IteratorResult<Uint8Array>
      try {
        n = await iterator.next()
      } catch (e) {
        ctl.abort()
        throw e
      }
      if (n.done) {
        // a sentença inteira coube no pré-buffer: bytes completos (sem streaming), ainda PCM cru —
        // toca pelo MESMO player Web Audio das outras frases (emendada sem buraco na anterior; um
        // WAV ia para o <audio>, que não encadeia)
        this.#deps.onFirstAudio?.(Date.now() - r.t0, false)
        return {
          audio: concatBytes(head),
          mime: `audio/pcm;rate=${r.sampleRate}`,
          ...(r.unitStartsMs ? { unitStartsMs: r.unitStartsMs } : {})
        }
      }
      head.push(n.value)
      size += n.value.length
      if (size >= target) break
    }
    this.#deps.onFirstAudio?.(Date.now() - r.t0, true)
    const audio = concatBytes(head)
    const entry: Entry = {
      ctl,
      iterator,
      buffered: [],
      id: null,
      ended: false,
      error: null,
      timer: setTimeout(() => {
        if (entry.id === null) this.#drop(entry) // nunca emitida: sentença descartada
      }, UNCLAIMED_MS)
    }
    entry.timer.unref?.()
    this.#heads.set(audio, entry)
    this.#live.add(entry)
    linked.addEventListener('abort', () => this.#drop(entry), { once: true })
    void this.#pump(entry)
    return {
      audio,
      mime: `audio/pcm;rate=${r.sampleRate}`,
      ...(r.unitStartsMs ? { unitStartsMs: r.unitStartsMs } : {})
    }
  }

  /** `emitUtterance` da chamada: começo de stream → evento `streaming` + despejo dos pedaços. */
  emitUtterance(u: VoiceCallUtteranceEvent): void {
    const entry = this.#heads.get(u.audio)
    if (!entry) {
      this.#deps.emitUtterance(u)
      return
    }
    this.#heads.delete(u.audio)
    clearTimeout(entry.timer)
    entry.id = u.id
    this.#deps.emitUtterance({ ...u, streaming: true })
    for (const pcm of entry.buffered) this.#deps.emitChunk({ id: u.id, pcm, done: false })
    entry.buffered = []
    if (entry.ended) this.#finish(entry)
  }

  /** Barge-in/parar: aborta todos os streams em curso (o renderer já descartou a fila). */
  abortAll(): void {
    for (const e of [...this.#live]) this.#drop(e)
  }

  async #pump(entry: Entry): Promise<void> {
    try {
      for (;;) {
        const n = await entry.iterator.next()
        if (n.done) break
        if (!this.#live.has(entry)) return
        if (entry.id === null) entry.buffered.push(n.value)
        else this.#deps.emitChunk({ id: entry.id, pcm: n.value, done: false })
      }
    } catch (e) {
      if (!this.#live.has(entry)) return // abortado de propósito
      entry.error = e instanceof Error ? e.message : String(e)
      try {
        this.#deps.onStreamError?.(e)
      } catch {
        /* o aviso nunca derruba a ponte */
      }
    }
    entry.ended = true
    if (entry.id !== null) this.#finish(entry)
  }

  #finish(entry: Entry): void {
    if (!this.#live.delete(entry) || entry.id === null) return
    this.#deps.emitChunk({
      id: entry.id,
      pcm: new Uint8Array(0),
      done: true,
      ...(entry.error ? { error: entry.error } : {})
    })
  }

  #drop(entry: Entry): void {
    if (!this.#live.delete(entry)) return
    clearTimeout(entry.timer)
    entry.buffered = []
    entry.ctl.abort()
    void entry.iterator.return?.(undefined)?.catch?.(() => undefined)
    // emitida e abortada no meio: encerra no renderer (o que já chegou termina de tocar)
    if (entry.id !== null)
      this.#deps.emitChunk({ id: entry.id, pcm: new Uint8Array(0), done: true, error: 'cancelado' })
  }
}
