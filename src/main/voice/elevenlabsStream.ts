// ElevenLabs direto — WebSocket de entrada em streaming para a chamada de voz (main, sem Electron —
// testável com o servidor fake de `e2e/fakes/elevenlabsFake.mjs`).
//
// Protocolo (conferido na documentação oficial em 2026-10-23 — ver SPEC → "ElevenLabs direto"):
// `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input?model_id=…
// &output_format=pcm_24000&inactivity_timeout=…[&language_code=pt][&auto_mode=true]`, chave no
// header `xi-api-key` (e também em `xi_api_key` no 1º frame — campo documentado). Um socket por
// chamada, UM CONTEXTO POR RESPOSTA (multi-context): o contexto abre com
// `{ text: ' ', context_id, generation_config: { chunk_length_schedule } [, voice_settings] }`,
// recebe o texto em pedaços (`{ text, context_id }` — palavras inteiras, sempre terminando em
// espaço), cada sentença cortada faz `{ text: resto, context_id, flush: true }` (gera já, SEM fechar
// — a próxima sentença continua no mesmo contexto, com a prosódia da anterior) e o fim da resposta
// fecha com `{ context_id, close_context: true }`; o servidor devolve `{ audio: base64 PCM16 24 kHz,
// contextId, alignment }` … `{ isFinal: true, contextId }`. O alinhamento reparte o áudio contínuo
// de volta em utterances por sentença (`alignedSegments.ts`). Barge-in: `close_context` no contexto
// e, se ele ainda estava gerando, o socket é derrubado (o `close_context` deixa o flush terminar —
// derrubar para tudo na hora); a próxima fala reconecta. O servidor fecha o socket ocioso depois de
// `inactivity_timeout` (pedimos 180 s, o máximo) — reconexão preguiçosa na próxima fala, e contexto
// que perdeu o socket antes de receber áudio é reenviado UMA vez num socket novo.
//
// `ElevenLabsCallTts` é o encaixe com a chamada (`TtsTextFeed`): `begin()` (turno novo — pré-abre o
// socket), `partial(texto)` (a sentença ainda incompleta cresce — vai ao contexto da resposta palavra
// a palavra, antes de a sentença fechar), `cut(sentença)` (o cortador fechou a sentença → flush: o
// contexto já começa a gerar), `end()` (a resposta acabou → close_context), `reset()`
// (barge-in/parar) e `synth(sentença, signal)` (o `synth` da chamada via `TtsStreamRelay` — a fatia
// daquela sentença no áudio da resposta).
import { abortError } from '../tools/util'
import { TtsError, type TtsPcmStream } from './tts'
import {
  AlignedPcmSegmenter,
  isSpeechUnit,
  parseAlignment,
  speechUnits,
  type ElevenLabsAlignment
} from './alignedSegments'
import type { TtsSettings } from '@shared/voice'
import {
  ELEVENLABS_OUTPUT_FORMAT,
  elevenLabsConfig,
  elevenLabsError,
  elevenLabsErrorDetail,
  elevenLabsHeaders,
  elevenLabsRate,
  elevenLabsWsSupportsModel,
  isElevenLabsEndpoint,
  type ElevenLabsConfig
} from './elevenlabs'
import { Pcm16MonoAligner } from './wav'

// ---------------- transporte (injetável) ----------------

/** O mínimo de um WebSocket (o global do Node/Electron serve; testes podem injetar outro). */
export interface WsLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (ev: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: (ev: unknown) => void): void
}

/** Abre um WebSocket com headers (o global do Node aceita `{ headers }` no 2º argumento). */
export type WsFactory = (url: string, init: { headers: Record<string, string> }) => WsLike

const WS_OPEN = 1

const defaultWsFactory: WsFactory = (url, init) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string, init: unknown) => WsLike }).WebSocket
  if (!Ctor)
    throw new TtsError('config', 'WebSocket indisponível neste runtime', { backend: 'api' })
  return new Ctor(url, init)
}

// ---------------- configuração ----------------

/**
 * `chunk_length_schedule` (chars acumulados antes de cada geração; 50–500) — o padrão da
 * ElevenLabs. Cada sentença cortada faz `flush`, então a geração quase sempre sai na fronteira da
 * sentença (frase curta não espera); o limiar só vale para frase longa ainda incompleta. Um 1º
 * limiar de 50 chars gerava pedaços no meio da frase (pior prosódia) — trocado em 2026-10-23.
 */
export const ELEVENLABS_CHUNK_SCHEDULE: readonly number[] = [120, 160, 250, 290]

/** Ociosidade antes de o servidor fechar o socket (máximo documentado: 180 s). */
export const ELEVENLABS_WS_INACTIVITY_S = 180

/** Tempo para o socket abrir. */
export const ELEVENLABS_WS_CONNECT_TIMEOUT_MS = 10_000

/** Sem áudio (nem `isFinal`) por este tempo depois do flush → `TtsError` 'timeout'. */
export const ELEVENLABS_WS_AUDIO_TIMEOUT_MS = 20_000

/** Contextos gerando ao mesmo tempo no socket (os demais esperam a vez — limite de concorrência). */
export const ELEVENLABS_WS_MAX_ACTIVE = 2

export interface ElevenLabsSocketOptions extends ElevenLabsConfig {
  chunkLengthSchedule?: readonly number[]
  /** `voice_settings` do 1º frame de cada contexto; null/ausente = as da voz salva na conta. */
  voiceSettings?: Record<string, unknown> | null
  /** `auto_mode=true` (a ElevenLabs gera ao receber frases completas, sem o schedule). */
  autoMode?: boolean
  inactivityTimeoutS?: number
  connectTimeoutMs?: number
  audioTimeoutMs?: number
  maxActive?: number
  wsFactory?: WsFactory
  /** Diagnóstico de falha antes de abrir (REST); padrão `diagnoseElevenLabs`. */
  diagnose?: (cfg: ElevenLabsConfig) => Promise<TtsError | null>
  now?: () => number
}

/** URL do WebSocket multi-contexto (http→ws, https→wss; a chave NUNCA vai na URL). */
export function elevenLabsWsUrl(
  cfg: Pick<ElevenLabsSocketOptions, 'baseUrl' | 'voiceId' | 'modelId' | 'languageCode'> & {
    autoMode?: boolean
    inactivityTimeoutS?: number
    outputFormat?: string
    textNormalization?: 'on' | 'off' | null
  }
): string {
  const u = new URL(cfg.baseUrl)
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:'
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/multi-stream-input`
  const q = new URLSearchParams()
  q.set('model_id', cfg.modelId)
  q.set('output_format', cfg.outputFormat ?? ELEVENLABS_OUTPUT_FORMAT)
  q.set('inactivity_timeout', String(cfg.inactivityTimeoutS ?? ELEVENLABS_WS_INACTIVITY_S))
  if (cfg.languageCode) q.set('language_code', cfg.languageCode)
  if (cfg.autoMode) q.set('auto_mode', 'true')
  if (cfg.textNormalization) q.set('apply_text_normalization', cfg.textNormalization)
  u.search = q.toString()
  return u.toString()
}

/**
 * Falha antes do socket abrir (o handshake não expõe o status HTTP): `GET /v1/voices/{voice_id}`
 * diz se é a chave (401/403), a voz (404/400) ou cota (429/402). Rede/2xx → null (erro genérico).
 */
export async function diagnoseElevenLabs(cfg: ElevenLabsConfig): Promise<TtsError | null> {
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/voices/${encodeURIComponent(cfg.voiceId)}`, {
      headers: elevenLabsHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(8_000)
    })
    if (res.ok) {
      await res.arrayBuffer().catch(() => undefined)
      return null
    }
    const d = elevenLabsErrorDetail(await res.text().catch(() => ''))
    if (res.status === 404 || res.status === 400) {
      const e = elevenLabsError(
        { status: res.status, message: d.message || 'voice_not_found', code: d.status },
        'voz'
      )
      return e.kind === 'http'
        ? elevenLabsError({ message: `voice_not_found ${d.message}`.trim() }, 'voz')
        : e
    }
    return elevenLabsError({ status: res.status, message: d.message, code: d.status }, 'voz')
  } catch {
    return null
  }
}

/** Identidade da configuração (trocar voz/modelo/chave = socket novo). */
const configKey = (o: ElevenLabsSocketOptions): string =>
  JSON.stringify([
    o.baseUrl,
    o.apiKey,
    o.voiceId,
    o.modelId,
    o.languageCode,
    o.chunkLengthSchedule ?? null,
    o.voiceSettings ?? null,
    !!o.autoMode,
    o.outputFormat ?? null,
    o.textNormalization ?? null,
    o.inactivityTimeoutS ?? null
  ])

// ---------------- contexto (uma sentença) ----------------

type Waiter = () => void

/** Uma sentença no socket multi-contexto (texto entrando, PCM saindo). */
export class ElevenLabsContext {
  readonly id: string
  readonly #sock: ElevenLabsSocket
  /** Texto já entregue ao socket (para o reenvio depois de uma queda). */
  text = ''
  /** Recebeu `flush` (o servidor está gerando o resto). */
  flushed = false
  /** `close_context` enviado (o servidor manda o `isFinal` depois do último áudio). */
  closeSent = false
  /**
   * Contexto de RESPOSTA (`ElevenLabsCallTts`): aceita texto depois de um `flush` (vários flushes,
   * um por sentença) e só fecha no `close()`.
   */
  multi = false
  /** Contexto de resposta com todo o texto já transformado em áudio (nada gerando agora). */
  settled = false
  /**
   * Destino do áudio no lugar da fila de `stream()` (contexto de resposta → segmentador por
   * alinhamento). Com sink, `stream()` não é usado.
   */
  sink: {
    audio(pcm: Uint8Array, alignment: ElevenLabsAlignment | null): void
    final(): void
    error(e: unknown): void
  } | null = null
  /** Recebeu o `isFinal` (todo o áudio chegou). */
  final = false
  aborted = false
  error: unknown = null
  /** Já está aberto no socket (fora da fila de concorrência). */
  started = false
  /** Reenvios depois de quedas (máx. 1). */
  retries = 0
  /** Momento do 1º texto entregue (latência 1º texto → 1º áudio). */
  firstTextAt: number | null = null
  flushAt: number | null = null
  firstAudioAt: number | null = null
  audioBytes = 0
  /** Frames esperando o contexto começar (fila de concorrência / socket conectando). */
  pendingFrames: Record<string, unknown>[] = []
  readonly #queue: Uint8Array[] = []
  #wake: Waiter | null = null
  readonly #aligner = new Pcm16MonoAligner(1)
  #timer: ReturnType<typeof setTimeout> | null = null
  /** Chamado no 1º áudio (instrumentação). */
  onFirstAudio: ((ctx: ElevenLabsContext) => void) | null = null

  constructor(id: string, sock: ElevenLabsSocket) {
    this.id = id
    this.#sock = sock
  }

  get done(): boolean {
    return this.final || this.aborted || this.error != null
  }

  /** Acrescenta texto (sem flush). Vazio/só espaços → nada. */
  send(text: string): void {
    if (this.done || this.closeSent || (this.flushed && !this.multi) || !text) return
    this.text += text
    this.firstTextAt ??= this.#sock.now()
    this.#sock.frame(this, { text, context_id: this.id })
  }

  /**
   * Contexto de resposta: entrega `tail` com `flush` (o buffer gera já — fim de uma sentença) sem
   * fechar; o tempo máximo sem áudio fica armado até `settle()` (todo o texto já tem áudio).
   */
  flush(tail = ''): void {
    if (this.done || this.closeSent) return
    const t = tail && !/\s$/.test(tail) ? `${tail} ` : tail
    this.text += t
    this.flushed = true
    this.settled = false
    this.firstTextAt ??= this.#sock.now()
    this.flushAt ??= this.#sock.now()
    this.#sock.frame(this, { text: t || ' ', context_id: this.id, flush: true })
    this.#arm()
  }

  /** Contexto de resposta: fim do texto → `close_context` (o servidor manda o `isFinal`). */
  close(): void {
    if (this.done || this.closeSent) return
    this.closeSent = true
    if (!this.flushed) {
      // nada foi gerado: só descarta (o servidor não manda isFinal de contexto sem flush)
      this.abort()
      return
    }
    this.#sock.frame(this, { context_id: this.id, close_context: true })
    this.#arm()
  }

  /** Todo o texto entregue já tem áudio (contexto de resposta ocioso): desarma o tempo máximo. */
  settle(): void {
    if (this.closeSent || this.done) return
    this.settled = true
    this.#clearTimer()
  }

  /** Último pedaço + `flush` (gera já) + `close_context` (o servidor manda o `isFinal`). */
  finish(tail = ''): void {
    if (this.done || this.flushed) return
    const t = tail && !/\s$/.test(tail) ? `${tail} ` : tail
    if (!this.text.trim() && !t.trim()) {
      // nada para falar: termina vazio (o stream acaba sem áudio → erro legível no consumidor)
      this.#fail(
        new TtsError('config', 'texto para a síntese de fala está vazio', { backend: 'api' })
      )
      return
    }
    this.text += t
    this.flushed = true
    this.closeSent = true
    this.firstTextAt ??= this.#sock.now()
    this.flushAt = this.#sock.now()
    this.#sock.frame(this, { text: t || ' ', context_id: this.id, flush: true })
    this.#sock.frame(this, { context_id: this.id, close_context: true })
    this.#arm()
  }

  /** Descarta o contexto (barge-in/sentença abandonada): áudio pendente cai fora. */
  abort(): void {
    if (this.done) return
    this.aborted = true
    this.#clearTimer()
    this.#queue.length = 0
    this.#sock.release(this, true)
    this.#notify()
    try {
      this.sink?.error(abortError())
    } catch {
      /* o destino nunca derruba o socket */
    }
  }

  /** Stream PCM16 mono 24 kHz do contexto (consumidor único). */
  stream(signal?: AbortSignal, model = ''): TtsPcmStream {
    const onAbort = (): void => this.abort()
    if (signal) {
      if (signal.aborted) this.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    async function* chunks(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const next = self.#queue.shift()
          if (next) {
            yield next
            continue
          }
          if (self.aborted) throw abortError()
          if (self.error) throw self.error
          if (self.final) {
            if (!self.audioBytes)
              throw new TtsError('http', 'a ElevenLabs terminou a sentença sem áudio', {
                backend: 'api'
              })
            return
          }
          await new Promise<void>((r) => (self.#wake = r))
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        if (!self.final) self.abort() // consumidor parou no meio
      }
    }
    return {
      streaming: true,
      sampleRate: this.#sock.sampleRate,
      model,
      backend: 'api',
      t0: this.firstTextAt ?? this.#sock.now(),
      chunks: chunks()
    }
  }

  // ---- entrada do socket ----

  /** @internal áudio base64 do servidor (+ o alinhamento de caracteres que veio junto). */
  pushAudio(b64: string, alignment: ElevenLabsAlignment | null = null): void {
    if (this.done) return
    const bytes = Buffer.from(b64, 'base64')
    const pcm = this.#aligner.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length))
    if (this.sink) {
      if (pcm.length && this.firstAudioAt == null) {
        this.firstAudioAt = this.#sock.now()
        try {
          this.onFirstAudio?.(this)
        } catch {
          /* instrumentação nunca derruba o áudio */
        }
      }
      this.audioBytes += pcm.length
      if (pcm.length && this.#timer) this.#arm()
      try {
        this.sink.audio(pcm, alignment)
      } catch {
        /* o destino nunca derruba o socket */
      }
      return
    }
    if (!pcm.length) return
    if (this.firstAudioAt == null) {
      this.firstAudioAt = this.#sock.now()
      try {
        this.onFirstAudio?.(this)
      } catch {
        /* instrumentação nunca derruba o áudio */
      }
    }
    this.audioBytes += pcm.length
    this.#queue.push(pcm)
    if (this.flushed) this.#arm()
    this.#notify()
  }

  /** @internal `isFinal` do servidor. */
  markFinal(): void {
    if (this.done) return
    this.final = true
    this.#clearTimer()
    this.#sock.release(this, false)
    this.#notify()
    try {
      this.sink?.final()
    } catch {
      /* o destino nunca derruba o socket */
    }
  }

  /** @internal falha (erro do servidor, queda, tempo). */
  fail(e: unknown): void {
    this.#fail(e)
  }

  #fail(e: unknown): void {
    if (this.done) return
    this.error = e
    this.#clearTimer()
    this.#sock.release(this, false)
    this.#notify()
    try {
      this.sink?.error(e)
    } catch {
      /* o destino nunca derruba o socket */
    }
  }

  /** (Re)arma o tempo máximo sem áudio depois do flush. */
  #arm(): void {
    this.#clearTimer()
    const ms = this.#sock.audioTimeoutMs
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#fail(
        new TtsError('timeout', `sem áudio da ElevenLabs há ${Math.round(ms / 1000)} s`, {
          backend: 'api'
        })
      )
    }, ms)
    this.#timer.unref?.()
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #notify(): void {
    const w = this.#wake
    this.#wake = null
    w?.()
  }
}

// ---------------- socket multi-contexto ----------------

/** Um WebSocket `multi-stream-input` (conexão preguiçosa, reconexão, fila de concorrência). */
export class ElevenLabsSocket {
  readonly key: string
  readonly #o: ElevenLabsSocketOptions
  #ws: WsLike | null = null
  #state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle'
  #everOpened = false
  #sentAuth = false
  #seq = 0
  #connectTimer: ReturnType<typeof setTimeout> | null = null
  /** Erro de protocolo recebido antes do fechamento (vale mais que o motivo do close). */
  #lastError: TtsError | null = null
  readonly #live = new Map<string, ElevenLabsContext>()
  /** Contextos esperando vaga (limite de concorrência), na ordem. */
  readonly #waiting: ElevenLabsContext[] = []
  /** Abertas no socket atual (o 1º frame — init — já saiu). */
  #activeCount = 0
  /** Conexões abertas (diagnóstico/testes). */
  connects = 0

  constructor(opts: ElevenLabsSocketOptions) {
    this.#o = opts
    this.key = configKey(opts)
  }

  get audioTimeoutMs(): number {
    return this.#o.audioTimeoutMs ?? ELEVENLABS_WS_AUDIO_TIMEOUT_MS
  }

  /** Taxa do PCM que o socket recebe (a do `output_format` pedido). */
  get sampleRate(): number {
    return elevenLabsRate(this.#o)
  }

  /** `auto_mode=true`: só frases completas entram no contexto (sem palavra a palavra). */
  get autoMode(): boolean {
    return !!this.#o.autoMode
  }

  get state(): 'idle' | 'connecting' | 'open' | 'closed' {
    return this.#state
  }

  /** Contextos vivos (diagnóstico/testes). */
  get liveCount(): number {
    return this.#live.size
  }

  now(): number {
    return this.#o.now ? this.#o.now() : Date.now()
  }

  /** Pré-abre a conexão (economiza o handshake no 1º texto). */
  warm(): void {
    if (this.#state === 'idle' || this.#state === 'closed') this.#connect()
  }

  /** Contexto novo (uma sentença). */
  context(): ElevenLabsContext {
    const ctx = new ElevenLabsContext(`c${++this.#seq}`, this)
    this.#live.set(ctx.id, ctx)
    this.#waiting.push(ctx)
    this.#pumpWaiting()
    return ctx
  }

  /** Algum contexto está gerando (flush enviado, sem `isFinal`)? */
  get generating(): boolean {
    for (const c of this.#live.values())
      if (c.flushed && !c.done && c.started && !(c.multi && c.settled)) return true
    return false
  }

  /** Fecha tudo (sem erro para os contextos: são abortados). */
  close(): void {
    for (const c of [...this.#live.values()]) c.abort()
    this.#teardown(1000, 'encerrado')
  }

  // ---- usado pelos contextos ----

  /** @internal envia (ou guarda até o contexto começar) um frame do contexto. */
  frame(ctx: ElevenLabsContext, msg: Record<string, unknown>): void {
    if (!ctx.started || this.#state !== 'open') {
      ctx.pendingFrames.push(msg)
      if (this.#state === 'idle' || this.#state === 'closed') this.#connect()
      return
    }
    this.#sendRaw(msg)
  }

  /** @internal o contexto acabou (final/erro) ou foi abortado (`closeRemote` = avisar o servidor). */
  release(ctx: ElevenLabsContext, closeRemote: boolean): void {
    if (!this.#live.delete(ctx.id)) return
    const w = this.#waiting.indexOf(ctx)
    if (w >= 0) this.#waiting.splice(w, 1)
    if (ctx.started) {
      this.#activeCount = Math.max(0, this.#activeCount - 1)
      if (closeRemote && this.#state === 'open' && !ctx.final) {
        // descartado: o servidor para de gerar o que não foi "flushado" (o flush em curso termina —
        // o áudio que ainda chegar deste id é ignorado)
        this.#sendRaw({ context_id: ctx.id, close_context: true })
      }
    }
    this.#pumpWaiting()
  }

  // ---- interno ----

  #maxActive(): number {
    return Math.max(1, this.#o.maxActive ?? ELEVENLABS_WS_MAX_ACTIVE)
  }

  /** Abre os contextos que esperam vaga (com o socket aberto). */
  #pumpWaiting(): void {
    if (this.#state !== 'open') {
      if (this.#waiting.length && (this.#state === 'idle' || this.#state === 'closed'))
        this.#connect()
      return
    }
    while (this.#waiting.length && this.#activeCount < this.#maxActive()) {
      const ctx = this.#waiting.shift()!
      if (ctx.done) continue
      this.#start(ctx)
    }
  }

  /** 1º frame do contexto (init) + os frames guardados. */
  #start(ctx: ElevenLabsContext): void {
    ctx.started = true
    this.#activeCount++
    const init: Record<string, unknown> = {
      text: ' ',
      context_id: ctx.id,
      generation_config: {
        chunk_length_schedule: [...(this.#o.chunkLengthSchedule ?? ELEVENLABS_CHUNK_SCHEDULE)]
      }
    }
    if (this.#o.voiceSettings) init.voice_settings = this.#o.voiceSettings
    if (!this.#sentAuth) {
      // campo documentado do 1º frame (o header `xi-api-key` já autentica; redundância para
      // runtimes/proxies que não repassam headers no upgrade)
      init.xi_api_key = this.#o.apiKey
      this.#sentAuth = true
    }
    this.#sendRaw(init)
    const frames = ctx.pendingFrames
    ctx.pendingFrames = []
    for (const f of frames) this.#sendRaw(f)
  }

  #sendRaw(msg: Record<string, unknown>): void {
    try {
      this.#ws?.send(JSON.stringify(msg))
    } catch {
      /* socket caindo: o 'close' trata os contextos */
    }
  }

  #connect(): void {
    if (this.#state === 'connecting' || this.#state === 'open') return
    this.#state = 'connecting'
    this.#sentAuth = false
    this.#everOpened = false
    this.#lastError = null
    this.#activeCount = 0
    let ws: WsLike
    try {
      const url = elevenLabsWsUrl({ ...this.#o })
      ws = (this.#o.wsFactory ?? defaultWsFactory)(url, {
        headers: { 'xi-api-key': this.#o.apiKey }
      })
    } catch (e) {
      this.#state = 'closed'
      this.#failAll(
        e instanceof TtsError
          ? e
          : new TtsError('config', `endereço da ElevenLabs inválido: ${(e as Error).message}`, {
              backend: 'api',
              cause: e
            })
      )
      return
    }
    this.#ws = ws
    this.connects++
    const timeoutMs = this.#o.connectTimeoutMs ?? ELEVENLABS_WS_CONNECT_TIMEOUT_MS
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null
      if (this.#ws !== ws || this.#state !== 'connecting') return
      this.#lastError = new TtsError(
        'timeout',
        `tempo esgotado ao conectar na ElevenLabs (${timeoutMs / 1000} s)`,
        { backend: 'api' }
      )
      try {
        ws.close()
      } catch {
        /* já caindo */
      }
      this.#onClose(ws, 1006, '')
    }, timeoutMs)
    this.#connectTimer.unref?.()
    ws.addEventListener('open', () => {
      if (this.#ws !== ws) return
      this.#clearConnectTimer()
      this.#state = 'open'
      this.#everOpened = true
      // contextos que já estavam abertos num socket anterior (reenvio) voltam para a fila
      this.#pumpWaiting()
    })
    ws.addEventListener('message', (ev) => {
      if (this.#ws !== ws) return
      this.#onMessage(ev.data)
    })
    ws.addEventListener('close', (ev) => this.#onClose(ws, ev?.code ?? 1006, ev?.reason ?? ''))
    ws.addEventListener('error', () => {
      /* o 'close' vem logo depois com o código */
    })
  }

  #onMessage(data: unknown): void {
    let j: Record<string, unknown>
    try {
      const s = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
      j = JSON.parse(s) as Record<string, unknown>
    } catch {
      return
    }
    if (!j || typeof j !== 'object') return
    const cid =
      typeof j.contextId === 'string'
        ? j.contextId
        : typeof j.context_id === 'string'
          ? j.context_id
          : null
    const ctx = cid ? this.#live.get(cid) : undefined
    const hasAudio = typeof j.audio === 'string' && j.audio.length > 0
    const isFinal = j.isFinal === true || j.is_final === true
    // alinhamento do texto ORIGINAL (o `normalizedAlignment` tem números/abreviações por extenso)
    const alignment = parseAlignment(j.alignment)
    if (hasAudio || alignment) ctx?.pushAudio(hasAudio ? (j.audio as string) : '', alignment)
    if (isFinal) {
      ctx?.markFinal()
      return
    }
    if (hasAudio) return
    // frame de erro: `{ message, error, code }` (ou `detail`)
    const errText =
      typeof j.error === 'string'
        ? j.error
        : typeof j.message === 'string'
          ? j.message
          : j.detail
            ? elevenLabsErrorDetail(JSON.stringify(j)).message
            : ''
    if (!errText) return
    const err = elevenLabsError(
      {
        message: typeof j.message === 'string' ? j.message : errText,
        code: typeof j.error === 'string' ? j.error : typeof j.code === 'string' ? j.code : ''
      },
      'WebSocket'
    )
    if (ctx && (err.kind === 'http' || err.kind === 'config')) {
      ctx.fail(err)
      return
    }
    // auth/cota/erro sem contexto: vale para o socket inteiro
    this.#lastError = err
    this.#failAll(err)
    this.#teardown(1000, 'erro')
  }

  #onClose(ws: WsLike, code: number, reason: string): void {
    if (this.#ws !== ws) return
    this.#clearConnectTimer()
    this.#ws = null
    const wasOpen = this.#everOpened
    this.#state = 'closed'
    this.#sentAuth = false
    this.#activeCount = 0
    const pending = [...this.#live.values()].filter((c) => !c.done)
    if (!pending.length) return // ocioso (inactivity_timeout) ou fechado por nós: reconecta depois
    const err = this.#lastError ?? this.#closeError(code, reason, wasOpen)
    const fatal = err.kind === 'auth' || err.kind === 'quota' || err.kind === 'config'
    // abertos no socket que caiu e ainda sem áudio → reenvio (1×); ainda na fila de concorrência →
    // ficam na fila para o socket novo; o resto (ou erro fatal / handshake falho) → erro
    const retry = pending.filter(
      (c) => !fatal && wasOpen && c.started && !c.firstAudioAt && c.retries < 1
    )
    const keep = pending.filter((c) => !fatal && wasOpen && !c.started)
    const fail = pending.filter((c) => !retry.includes(c) && !keep.includes(c))
    for (const c of fail) {
      const w = this.#waiting.indexOf(c)
      if (w >= 0) this.#waiting.splice(w, 1)
    }
    if (!wasOpen && !this.#lastError) {
      // falha no handshake: o diagnóstico REST diz se foi chave/voz/cota
      void this.#diagnoseAndFail(fail, err)
    } else {
      for (const c of fail) c.fail(err)
    }
    if (retry.length) {
      // caiu antes do áudio (ex.: fechou por ociosidade na hora em que a fala começou): reenvia
      // o texto inteiro num socket novo (`text` já inclui o que ainda estava na fila)
      for (const c of retry) {
        c.retries++
        c.started = false
        const frames: Record<string, unknown>[] = []
        if (c.text)
          frames.push({ text: c.text, context_id: c.id, ...(c.flushed ? { flush: true } : {}) })
        if (c.closeSent) frames.push({ context_id: c.id, close_context: true })
        c.pendingFrames = frames
        this.#waiting.unshift(c)
      }
    }
    if (retry.length || keep.length) this.#connect()
  }

  async #diagnoseAndFail(ctxs: ElevenLabsContext[], fallback: TtsError): Promise<void> {
    let err: TtsError | null
    try {
      err = await (this.#o.diagnose ?? diagnoseElevenLabs)(this.#o)
    } catch {
      err = null
    }
    for (const c of ctxs) c.fail(err ?? fallback)
  }

  #closeError(code: number, reason: string, wasOpen: boolean): TtsError {
    const r = (reason ?? '').trim()
    if (!wasOpen)
      return new TtsError(
        'network',
        `não foi possível abrir o WebSocket da ElevenLabs${r ? ` — ${r}` : ` (código ${code})`}`,
        { backend: 'api' }
      )
    if (r && code !== 1000) return elevenLabsError({ message: r, code: String(code) }, 'WebSocket')
    return new TtsError(
      'network',
      `a ElevenLabs fechou o WebSocket antes do fim do áudio (código ${code}${r ? ` — ${r}` : ''})`,
      { backend: 'api' }
    )
  }

  #failAll(err: unknown): void {
    for (const c of [...this.#live.values()]) c.fail(err)
    this.#waiting.length = 0
  }

  #teardown(code: number, reason: string): void {
    this.#clearConnectTimer()
    const ws = this.#ws
    this.#ws = null
    this.#state = 'closed'
    this.#sentAuth = false
    this.#activeCount = 0
    if (ws) {
      try {
        if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ close_socket: true }))
        ws.close(code, reason)
      } catch {
        /* já fechado */
      }
    }
  }

  #clearConnectTimer(): void {
    if (this.#connectTimer) clearTimeout(this.#connectTimer)
    this.#connectTimer = null
  }
}

// ---------------- encaixe com a chamada ----------------

/**
 * Ganchos de texto da chamada para um TTS de entrada em streaming (ver `VoiceCallDeps.ttsFeed`).
 * Todos são best-effort (nunca lançam): sem eles o `synth(sentença)` sozinho também funciona.
 */
export interface TtsTextFeed {
  /** Turno novo (ou início da chamada): pré-abre a conexão; a resposta anterior termina de gerar. */
  begin(): void
  /** Texto da sentença ainda incompleta (cresce a cada delta do LLM). */
  partial(text: string): void
  /** O cortador fechou esta sentença (vai virar `synth(text)` em seguida, na ordem). */
  cut(sentence: string): void
  /** A resposta acabou (o turno do agente terminou): nada mais vem para o contexto atual. */
  end?(): void
  /** Barge-in/parar/turno retido: descarta tudo o que ainda não tocou. */
  reset(): void
  /** Fim da chamada: fecha a conexão. */
  close(): void
}

/** Latência de uma resposta no WebSocket. */
export interface ElevenLabsLatency {
  /** Contexto (resposta) que recebeu o 1º áudio. */
  contextId: string
  /** 1º texto entregue → 1º áudio do contexto (ms). */
  firstTextToAudioMs: number
  /** 1º flush → 1º áudio (ms; null = o áudio chegou antes do flush). */
  flushToAudioMs: number | null
  /** 1º texto do TURNO → 1º áudio do turno (só no 1º contexto do turno; senão null). */
  turnMs: number | null
  /** Chars entregues no contexto até o 1º áudio. */
  chars: number
}

export interface ElevenLabsCallOptions {
  /** Config atual (lida a cada uso — Configurações podem mudar); null = desligado. */
  config(): ElevenLabsSocketOptions | null
  /** Instrumentação (1º texto → 1º áudio). */
  onLatency?(l: ElevenLabsLatency): void
  /** Ociosidade antes de fechar o contexto da resposta (padrão `ELEVENLABS_TURN_IDLE_CLOSE_MS`). */
  idleCloseMs?: number
}

/**
 * Sem texto novo por este tempo depois da última sentença cortada → o contexto da resposta fecha
 * (pausa longa do LLM, ex.: tools rodando). O texto que vier depois abre um contexto novo.
 */
export const ELEVENLABS_TURN_IDLE_CLOSE_MS = 2000

/** Respostas mantidas para o `synth` achar a fatia (a atual + as anteriores ainda tocando). */
const MAX_TURNS = 3

/** Uma sentença cortada dentro do contexto da resposta. */
interface TurnSegment {
  text: string
  index: number
  claimed: boolean
  cutAt: number
}

/** Uma resposta: um contexto, o segmentador por alinhamento e o texto entregue/cortado. */
interface Turn {
  ctx: ElevenLabsContext
  seg: AlignedPcmSegmenter
  /** Texto bruto entregue ao contexto (sempre termina em espaço). */
  sent: string
  /** Sentenças cortadas, cada uma seguida de um espaço. */
  cutText: string
  sentUnits: number
  cutUnits: number
  /** Unidades entregues até o último flush (o que o servidor está gerando). */
  flushedUnits: number
  segments: TurnSegment[]
  idleTimer: ReturnType<typeof setTimeout> | null
}

/**
 * O que falta entregar de `target` dado o que já foi (`sent`): normalmente um sufixo direto; se os
 * espaços divergirem (corte forçado numa quebra de linha, espaços duplos), pelas unidades de fala.
 */
export function unsentSuffix(sent: string, target: string): string {
  if (target.startsWith(sent)) return target.slice(sent.length)
  if (sent.startsWith(target) || sent.trimEnd() === target.trimEnd()) return ''
  const n = speechUnits(sent)
  let seen = 0
  let i = 0
  for (; i < target.length && seen < n; i++) if (isSpeechUnit(target[i])) seen++
  if (seen < n) return ''
  while (i < target.length && !/\s/.test(target[i])) i++ // o resto do token já foi entregue
  return target.slice(i).replace(/^\s+/, '')
}

/** O texto como o contexto o registra (pedaço com flush ganha espaço final). */
const withSpace = (t: string): string => (t && !/\s$/.test(t) ? `${t} ` : t)

/**
 * Encaixe da chamada com o WebSocket da ElevenLabs: UM contexto por resposta. A sentença ainda
 * incompleta vai palavra a palavra (`partial`), cada corte faz `flush` sem fechar (`cut`) e o
 * `synth(sentença)` devolve a FATIA daquela sentença no áudio contínuo do contexto (repartido pelo
 * alinhamento — `AlignedPcmSegmenter`). Prosódia contínua entre as frases, sem fila de contextos;
 * a chamada segue com uma utterance por sentença (histórico/barge-in/ordem iguais). Sentença que a
 * resposta não tem (nova tentativa depois de uma falha) → contexto avulso com o texto inteiro.
 */
export class ElevenLabsCallTts implements TtsTextFeed {
  readonly #o: ElevenLabsCallOptions
  #sock: ElevenLabsSocket | null = null
  /** Respostas recentes (a última é a atual quando o contexto dela ainda aceita texto). */
  #turns: Turn[] = []
  #turnFirstTextAt: number | null = null
  #turnReported = false

  constructor(opts: ElevenLabsCallOptions) {
    this.#o = opts
  }

  /** Socket atual (diagnóstico/testes). */
  get socket(): ElevenLabsSocket | null {
    return this.#sock
  }

  /** Segmentador da resposta atual (diagnóstico/testes). */
  get segmenter(): AlignedPcmSegmenter | null {
    return this.#current()?.seg ?? null
  }

  begin(): void {
    const sock = this.#socket()
    if (!sock) return
    // a resposta anterior termina de gerar o que já foi cortado (pode ainda estar tocando)
    this.#endCurrent()
    this.#turnFirstTextAt = null
    this.#turnReported = false
    sock.warm()
  }

  partial(text: string): void {
    const sock = this.#socket()
    if (!sock) return
    // auto_mode: a ElevenLabs gera ao receber o texto (sem buffer) — palavra solta pioraria a
    // prosódia; só a frase inteira entra (no `cut`)
    if (sock.autoMode) return
    const rest = text.replace(/^\s+/, '')
    if (!rest) return
    const cur = this.#current()
    const target = (cur?.cutText ?? '') + rest
    // só palavras inteiras (o pedaço sempre termina em espaço — recomendação da ElevenLabs)
    const m = /^[\s\S]*\s/.exec(target)
    const words = m ? m[0] : ''
    const add = unsentSuffix(cur?.sent ?? '', words)
    if (!add.trim()) return
    const turn = cur ?? this.#open(sock)
    this.#clearIdle(turn)
    turn.ctx.send(add)
    turn.sent += add
    turn.sentUnits += speechUnits(add)
    turn.seg.setTailOpen(turn.sentUnits > turn.cutUnits)
  }

  cut(sentence: string): void {
    const sock = this.#socket()
    if (!sock) return
    const s = sentence.trim()
    if (!s) return
    const turn = this.#current() ?? this.#open(sock)
    this.#clearIdle(turn)
    const target = `${turn.cutText}${s} `
    const add = withSpace(unsentSuffix(turn.sent, target))
    turn.ctx.flush(add)
    turn.sent += add
    turn.sentUnits += speechUnits(add)
    turn.flushedUnits = turn.sentUnits
    turn.cutText = target
    const units = speechUnits(s)
    turn.cutUnits += units
    const index = turn.seg.addSegment(units)
    turn.segments.push({ text: s, index, claimed: false, cutAt: sock.now() })
    turn.seg.setTailOpen(turn.sentUnits > turn.cutUnits)
    this.#armIdle(turn)
  }

  end(): void {
    this.#endCurrent()
  }

  /**
   * `synth` da chamada (via `TtsStreamRelay.synth`): a fatia desta sentença no áudio da resposta
   * (sentenças cortadas antes dela e nunca pedidas são descartadas), ou um contexto avulso com o
   * texto inteiro quando a resposta não a tem (nova tentativa depois de uma falha).
   */
  synth(text: string, signal?: AbortSignal): TtsPcmStream {
    const s = text.trim()
    const sock = this.#socket()
    if (!sock)
      throw new TtsError('config', 'a ElevenLabs não está configurada para a fala', {
        backend: 'api'
      })
    if (!s)
      throw new TtsError('config', 'texto para a síntese de fala está vazio', { backend: 'api' })
    const model = this.#o.config()?.modelId ?? ''
    for (const turn of this.#turns) {
      const i = turn.segments.findIndex((x) => !x.claimed && x.text === s)
      if (i < 0) continue
      for (const skipped of turn.segments.slice(0, i)) {
        if (skipped.claimed) continue
        skipped.claimed = true
        turn.seg.drop(skipped.index)
      }
      const item = turn.segments[i]
      item.claimed = true
      if (turn.ctx.error || turn.ctx.aborted) break // a resposta falhou: contexto avulso
      return {
        streaming: true,
        sampleRate: sock.sampleRate,
        model,
        backend: 'api',
        t0: item.cutAt,
        chunks: turn.seg.stream(item.index, signal),
        // alinhamento por letra desta sentença: o "ouvido" exato do barge-in em palavras
        unitStartsMs: () => turn.seg.unitStartsMs(item.index)
      }
    }
    const ctx = this.#newContext(sock)
    ctx.finish(s)
    return ctx.stream(signal, model)
  }

  reset(): void {
    const sock = this.#sock
    // medido ANTES de descartar (o contexto descartado sai da conta do socket)
    const generating = !!sock?.generating
    for (const t of this.#turns) {
      this.#clearIdle(t)
      t.ctx.abort()
      t.seg.abort()
    }
    this.#turns = []
    if (!sock) return
    // contexto ainda gerando (flush em curso não para com close_context): derruba o socket — o
    // próximo turno reconecta (begin pré-abre)
    if (generating) {
      sock.close()
      this.#sock = null
    }
  }

  close(): void {
    for (const t of this.#turns) {
      this.#clearIdle(t)
      t.seg.abort()
    }
    this.#turns = []
    this.#sock?.close()
    this.#sock = null
  }

  // ---- interno ----

  /** Socket da config atual (config mudou → socket novo; desligado → fecha). */
  #socket(): ElevenLabsSocket | null {
    let cfg: ElevenLabsSocketOptions | null
    try {
      cfg = this.#o.config()
    } catch {
      cfg = null
    }
    if (!cfg) {
      if (this.#sock) this.close()
      return null
    }
    const key = configKey(cfg)
    if (this.#sock && this.#sock.key !== key) this.close()
    this.#sock ??= new ElevenLabsSocket(cfg)
    return this.#sock
  }

  /** Resposta que ainda aceita texto (null = a próxima entrega abre um contexto novo). */
  #current(): Turn | null {
    const t = this.#turns.at(-1)
    return t && !t.ctx.done && !t.ctx.closeSent ? t : null
  }

  #open(sock: ElevenLabsSocket): Turn {
    const ctx = this.#newContext(sock)
    ctx.multi = true
    const seg = new AlignedPcmSegmenter({ sampleRate: sock.sampleRate })
    const turn: Turn = {
      ctx,
      seg,
      sent: '',
      cutText: '',
      sentUnits: 0,
      cutUnits: 0,
      flushedUnits: 0,
      segments: [],
      idleTimer: null
    }
    ctx.sink = {
      audio: (pcm, alignment) => {
        if (alignment) seg.pushAlignment(alignment)
        if (pcm.length) seg.pushPcm(pcm)
        // tudo o que foi pedido já tem áudio: nada gerando (o tempo máximo sem áudio desarma)
        if (turn.flushedUnits && seg.alignedUnits >= turn.flushedUnits) ctx.settle()
      },
      final: () => seg.finish(),
      error: (e) => {
        if (e instanceof Error && e.name === 'AbortError') seg.abort()
        else seg.fail(e)
      }
    }
    this.#turns.push(turn)
    while (this.#turns.length > MAX_TURNS) {
      const old = this.#turns.shift()!
      this.#clearIdle(old)
    }
    return turn
  }

  #newContext(sock: ElevenLabsSocket): ElevenLabsContext {
    const ctx = sock.context()
    ctx.onFirstAudio = (c) => this.#reportLatency(c)
    // 1º texto do turno: o relógio do "1º texto → 1º áudio" do turno começa aqui (inclui a
    // conexão quando o socket ainda não estava aberto)
    this.#turnFirstTextAt ??= sock.now()
    return ctx
  }

  /** Fecha o contexto da resposta atual (o já cortado termina de gerar; o resto cai fora). */
  #endCurrent(): void {
    const t = this.#current()
    if (!t) return
    this.#clearIdle(t)
    t.ctx.close()
  }

  #armIdle(t: Turn): void {
    this.#clearIdle(t)
    if (t.sentUnits > t.cutUnits) return // sentença seguinte já chegando
    t.idleTimer = setTimeout(() => {
      t.idleTimer = null
      if (this.#current() === t && t.sentUnits <= t.cutUnits) t.ctx.close()
    }, this.#o.idleCloseMs ?? ELEVENLABS_TURN_IDLE_CLOSE_MS)
    t.idleTimer.unref?.()
  }

  #clearIdle(t: Turn): void {
    if (t.idleTimer) clearTimeout(t.idleTimer)
    t.idleTimer = null
  }

  #reportLatency(c: ElevenLabsContext): void {
    const at = c.firstAudioAt ?? 0
    const turnMs =
      !this.#turnReported && this.#turnFirstTextAt != null ? at - this.#turnFirstTextAt : null
    this.#turnReported = true
    this.#o.onLatency?.({
      contextId: c.id,
      firstTextToAudioMs: at - (c.firstTextAt ?? at),
      flushToAudioMs: c.flushAt != null && c.flushAt <= at ? at - c.flushAt : null,
      turnMs,
      chars: c.text.length
    })
  }
}

/**
 * Opções do WebSocket para a fala atual — null quando a chamada NÃO deve usar o WebSocket da
 * ElevenLabs (backend local, outro provedor, sem chave, interruptor "Streaming por WebSocket"
 * desligado — `api.elevenLabsWs === false` —, ou modelo que o WebSocket não aceita —
 * esses seguem o `synth` por sentença via REST `/stream`).
 */
export function elevenLabsCallOptions(
  tts: TtsSettings,
  extra: Partial<ElevenLabsSocketOptions> = {}
): ElevenLabsSocketOptions | null {
  if (tts.backend !== 'api' || !isElevenLabsEndpoint(tts.api)) return null
  // "Streaming por WebSocket" desligado em Áudio → Fala: HTTP por frase
  if (tts.api.elevenLabsWs === false) return null
  let cfg: ElevenLabsConfig
  try {
    cfg = elevenLabsConfig(tts.api)
  } catch {
    return null // sem chave: o synth REST mostra o erro legível
  }
  if (!elevenLabsWsSupportsModel(cfg.modelId)) return null
  return { ...cfg, ...extra }
}
