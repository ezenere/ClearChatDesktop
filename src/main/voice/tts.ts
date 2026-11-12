// Serviço de síntese de fala (TTS) do main — cliente do endpoint OpenAI-compatível
// `POST {baseUrl}/audio/speech` (JSON `{ model, voice, input, response_format }` → bytes de áudio)
// + despacho para o motor local (Kokoro) injetado como `TtsLocalBackend`. Sem Electron, sem UI,
// sem IPC (a fiação vem em `src/main/ipc.ts`) e sem rede/local embutidos: as dependências são
// injetáveis (testes usam fetch mockado e um motor fake). O main é dono da rede e das chaves: a
// `apiKey` nunca sai daqui. Contratos de config em `@shared/voice` (`TtsSettings`).
// Ver SPEC.md → "Áudio → Serviço de TTS (clipes)".
import type { TtsLocalEngine, TtsSettings } from '@shared/voice'
import { connectionErrorText } from '@shared/network'
import { voiceProviderSupport } from '@shared/voiceCatalog'
import { apiParamsToSend } from '@shared/voiceParams'
import { abortError } from '../tools/util'
import { concatBytes, encodeWav, parsePcmContentType, Pcm16MonoAligner } from './wav'
import {
  isElevenLabsEndpoint,
  synthesizeElevenLabs,
  synthesizeElevenLabsStream
} from './elevenlabs'
import { GpuEndpointError, gpuTtsAsApi } from './gpu/endpoint'

// ---------------- tipos ----------------

/** Formato do áudio sintetizado. */
export type TtsFormat = 'wav' | 'mp3'

/** Backend de síntese. */
export type TtsBackend = 'api' | 'local'

/** Entrada de uma síntese. */
export interface TtsSynthesizeInput {
  /** Texto a falar (pt-BR primeiro). */
  text: string
  /** Configuração de fala (escolhe backend/endpoint/voz). */
  settings: TtsSettings
  /** Formato do áudio (padrão 'wav'). */
  format?: TtsFormat
}

/** Resultado de uma síntese (bytes completos — sem streaming nesta fatia). */
export interface TtsSynthesizeResult {
  /** Bytes do áudio (wav/mp3). */
  audio: Uint8Array
  /** MIME do áudio ('audio/wav' | 'audio/mpeg'). */
  mime: string
  /** Modelo usado (`ttsSettings.api.model` ou o artefato do motor local). */
  model: string
  /** Backend que serviu a síntese. */
  backend: TtsBackend
  /** Duração da chamada em ms. */
  ms: number
}

/** Categoria do erro de síntese (mesma taxonomia do `SttError`). */
export type TtsErrorKind =
  | 'auth' // 401/403 — chave inválida/sem permissão
  | 'quota' // 429/402 — limite de uso/cota
  | 'http' // demais 4xx/5xx (ou resposta 2xx sem áudio)
  | 'network' // conexão — ECONNREFUSED/DNS/reset…
  | 'timeout' // tempo esgotado
  | 'config' // sem provedor/modelo ou motor local indisponível

/** Erro de síntese com categoria, status HTTP e backend de origem (mensagem legível em pt-BR). */
export class TtsError extends Error {
  readonly kind: TtsErrorKind
  readonly status?: number
  readonly backend: TtsBackend

  constructor(
    kind: TtsErrorKind,
    message: string,
    opts: { backend: TtsBackend; status?: number; cause?: unknown }
  ) {
    super(message, { cause: opts.cause })
    this.name = 'TtsError'
    this.kind = kind
    this.status = opts.status
    this.backend = opts.backend
  }
}

// ---------------- motor local (injetado) ----------------

/** Entrada de uma síntese local. */
export interface TtsLocalInput {
  text: string
  /** Voz do motor (`ttsSettings.local.voice`; ex.: 'pf_dora' no Kokoro). */
  voice: string
  format: TtsFormat
  signal?: AbortSignal
}

/** Resultado de uma síntese local (mesma forma do `TtsSynthesizeResult`, sem o backend). */
export interface TtsLocalResult {
  audio: Uint8Array
  mime: string
  model: string
  ms: number
}

/**
 * Motor local de síntese (injetado — o Kokoro vive em `ttsLocal.ts`). Falhas do motor devem vir
 * como `TtsError` legível (`config` quando falta modelo/voz/runtime).
 */
export interface TtsLocalBackend {
  /** Id do motor ('kokoro' | 'chatterbox'). */
  engine: TtsLocalEngine
  synthesize(input: TtsLocalInput): Promise<TtsLocalResult>
}

export interface TtsSynthesizeOptions {
  /** Motor local (backend 'local'); sem ele → `TtsError` `config` legível. */
  local?: TtsLocalBackend
  /** Timeout da request em ms (padrão `TTS_DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number
  /** Cancelamento pelo chamador — sai como `AbortError`. */
  signal?: AbortSignal
}

/** Timeout padrão da request de síntese (configurável por chamada). */
export const TTS_DEFAULT_TIMEOUT_MS = 60_000

/** Frase curta de demonstração do "Testar voz" (canal `voice:tts:test`). */
export const TTS_TEST_PHRASE = 'Olá, isto é um teste.'

const MIME_BY_FORMAT: Record<TtsFormat, string> = { wav: 'audio/wav', mp3: 'audio/mpeg' }
/** `response_format` pedido à API por formato do app. */
const RESPONSE_FORMAT: Record<TtsFormat, string> = { wav: 'wav', mp3: 'mp3' }

// ---------------- cliente da API ----------------

/** Mensagem de erro do corpo (formato OpenAI `error.message`, `detail`, `message`), curta. */
function errorDetail(raw: string): string {
  const msg = parsedErrorDetail(raw).replace(/\s+/g, ' ').trim()
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg
}

function parsedErrorDetail(raw: string): string {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    const e = j.error
    const cand =
      (e && typeof e === 'object'
        ? ((e as Record<string, unknown>).message ??
          (e as Record<string, unknown>).detail ??
          (e as Record<string, unknown>).msg)
        : e) ??
      j.detail ??
      j.message
    return typeof cand === 'string' ? cand : cand ? JSON.stringify(cand) : ''
  } catch {
    return /<html/i.test(raw) ? '' : raw
  }
}

function httpError(status: number, raw: string, url: string): TtsError {
  const detail = errorDetail(raw)
  const tail = detail ? ` — ${detail}` : ''
  if (status === 401 || status === 403)
    return new TtsError('auth', `chave de API inválida ou sem permissão (HTTP ${status})${tail}`, {
      backend: 'api',
      status
    })
  if (status === 402 || status === 429)
    return new TtsError(
      'quota',
      `limite de uso/cota da síntese de fala atingido (HTTP ${status})${tail}`,
      {
        backend: 'api',
        status
      }
    )
  return new TtsError('http', `HTTP ${status} na síntese de fala em ${url}${tail}`, {
    backend: 'api',
    status
  })
}

/**
 * Sintetiza `text` com a API OpenAI-compatível de `ttsSettings.api`: POST JSON em
 * `{baseUrl}/audio/speech` com `{ model, voice?, input, response_format }` e resposta = bytes de
 * áudio (wav/mp3). Chave no header `Authorization: Bearer …` quando há chave (servidores locais
 * compatíveis não exigem chave); a chave nunca é devolvida ao chamador. Erros → `TtsError`
 * legível (`kind`/`status`): `auth` (401/403), `quota` (429/402), `http` (demais 4xx/5xx e
 * resposta 2xx sem áudio), `network`, `timeout` (padrão 60 s) e `config` (sem provedor/modelo).
 * Abort do `signal` propaga como `AbortError`.
 */
export async function synthesize(
  input: TtsSynthesizeInput,
  opts: TtsSynthesizeOptions = {}
): Promise<TtsSynthesizeResult> {
  const text = input.text.trim()
  if (!text)
    throw new TtsError('config', 'texto para a síntese de fala está vazio', { backend: 'api' })
  const format: TtsFormat = input.format ?? 'wav'
  // backend `gpu` (Modo avançado): o servidor local vira um endpoint de API (URL/token do main)
  input = { ...input, settings: await resolveGpuSettings(input.settings) }
  if (input.settings.backend === 'local') return synthesizeLocal(text, input.settings, format, opts)
  // ElevenLabs direta (provedor `elevenlabs` / host elevenlabs.io): REST próprio, sempre WAV 24 kHz
  if (isElevenLabsEndpoint(input.settings.api))
    return synthesizeElevenLabs(text, input.settings.api, opts)
  return synthesizeApi(text, input.settings, format, opts)
}

/**
 * Backend `gpu` → settings de API apontando para o servidor local da GPU (o `GpuVoiceManager` sobe
 * o processo do motor se preciso). Falha de prontidão vira `TtsError` (`config` = motor/runtime
 * ausente ou bloqueado — fatal na chamada; `network` = servidor não subiu — transitória).
 */
async function resolveGpuSettings(settings: TtsSettings): Promise<TtsSettings> {
  if (settings.backend !== 'gpu') return settings
  try {
    return await gpuTtsAsApi(settings)
  } catch (e) {
    if (e instanceof GpuEndpointError)
      throw new TtsError(e.kind, e.message, { backend: 'api', cause: e })
    throw e
  }
}

async function synthesizeLocal(
  text: string,
  settings: TtsSettings,
  format: TtsFormat,
  opts: TtsSynthesizeOptions
): Promise<TtsSynthesizeResult> {
  const local = opts.local
  if (!local)
    throw new TtsError('config', 'motor local de fala não está pronto', { backend: 'local' })
  if (!settings.local)
    throw new TtsError('config', 'nenhum motor local de fala configurado', { backend: 'local' })
  const voice = settings.local.voice.trim()
  const r = await local.synthesize({ text, voice, format, signal: opts.signal })
  return { ...r, backend: 'local' }
}

// ---------------- adaptador PCM (endpoints que não aceitam wav) ----------------

/**
 * `baseUrl`s que já recusaram `response_format: 'wav'` nesta execução (400 "expected one of
 * mp3|pcm"): as próximas pedem `pcm` direto, sem a request perdida.
 */
const pcmOnlyEndpoints = new Set<string>()

/** Zera o aprendizado de endpoints só-pcm (testes). */
export function resetTtsPcmEndpoints(): void {
  pcmOnlyEndpoints.clear()
}

/**
 * O endpoint só aceita mp3/pcm em `/audio/speech`? OpenRouter (host `openrouter.ai`) sabidamente
 * recusa wav; outros entram na lista depois do primeiro 400 que cita pcm/mp3.
 */
export function ttsEndpointWantsPcm(baseUrl: string): boolean {
  if (pcmOnlyEndpoints.has(baseUrl)) return true
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
  } catch {
    return false
  }
}

/** 400 de "formato não suportado" que oferece pcm (ex.: OpenRouter: "expected one of mp3|pcm"). */
function rejectsWavForPcm(status: number, raw: string): boolean {
  return status === 400 && /\bpcm\b/i.test(raw) && /mp3|format/i.test(raw)
}

/** Taxa assumida quando o endpoint devolve `audio/pcm` sem `rate` (o padrão do ElevenLabs/OpenAI). */
const PCM_DEFAULT_RATE = 24_000

/** Resposta 2xx com o corpo ainda não lido (o chamador lê inteiro ou em streaming). */
interface SpeechResponse {
  res: Response
  url: string
  model: string
  t0: number
  signal: AbortSignal
  timeout: AbortSignal
  timeoutMs: number
  /** `response_format` efetivamente pedido. */
  requested: string
}

function failure(
  e: unknown,
  opts: TtsSynthesizeOptions,
  r: { timeout: AbortSignal; timeoutMs: number; url: string }
): unknown {
  if (opts.signal?.aborted) return abortError()
  if (e instanceof TtsError) return e
  if (r.timeout.aborted)
    return new TtsError(
      'timeout',
      `tempo esgotado na síntese de fala (${r.timeoutMs / 1000} s) em ${r.url}`,
      { backend: 'api', cause: e }
    )
  return new TtsError(
    'network',
    `erro de rede ao sintetizar fala em ${r.url}: ${connectionErrorText(e)}`,
    { backend: 'api', cause: e }
  )
}

/**
 * POST `{baseUrl}/audio/speech` até uma resposta 2xx com áudio (corpo não lido). Pedido `wav` em
 * endpoint só-pcm vira `pcm` (o chamador embrulha em WAV); 400 que recusa wav citando pcm/mp3 →
 * repete UMA vez com `pcm` e lembra o endpoint. Erros → `TtsError`; abort → `AbortError`.
 */
async function requestSpeech(
  text: string,
  settings: TtsSettings,
  format: TtsFormat,
  opts: TtsSynthesizeOptions
): Promise<SpeechResponse> {
  const api = settings.api
  // endereço/chave resolvidos pelo main a partir do provedor cadastrado (ou do servidor da GPU)
  const baseUrl = (api.baseUrl ?? '').trim().replace(/\/+$/, '')
  const model = api.model.trim()
  if (!baseUrl)
    throw new TtsError(
      'config',
      'nenhum provedor de fala escolhido — escolha um em Configurações → Áudio',
      { backend: 'api' }
    )
  if (!model)
    throw new TtsError('config', 'modelo de síntese de fala não configurado', { backend: 'api' })
  const key = (api.apiKey ?? '').trim()
  const url = `${baseUrl}/audio/speech`
  const timeoutMs = opts.timeoutMs ?? TTS_DEFAULT_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/*'
  }
  if (key) headers.Authorization = `Bearer ${key}`
  const voice = (api.voice ?? '').trim()
  const ctx = { timeout, timeoutMs, url }

  let requested = format === 'wav' && ttsEndpointWantsPcm(baseUrl) ? 'pcm' : RESPONSE_FORMAT[format]
  const t0 = Date.now()
  // parâmetros do modelo escolhidos em Áudio → Parâmetros (`speed`, `instructions` — só os que o
  // modelo aceita; o servidor da GPU usa o `extraBody` e nunca tem `params`)
  const family = api.extraBody
    ? null
    : voiceProviderSupport({ baseUrl, kind: api.providerKind ?? undefined })
  const modelParams =
    family && family !== 'elevenlabs' ? apiParamsToSend('tts', family, model, api.params) : {}
  for (let attempt = 0; ; attempt++) {
    // JSON `{ model, voice, input, response_format }` (voz ausente = a voz padrão da API)
    // (+ campos extras do main — `params` do motor da GPU; nunca sobrescrevem os de cima)
    const body: Record<string, unknown> = {
      ...(api.extraBody ?? {}),
      ...modelParams,
      model,
      input: text,
      response_format: requested
    }
    if (voice) body.voice = voice
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
    } catch (e) {
      throw failure(e, opts, ctx)
    }
    if (res.status >= 200 && res.status < 300) {
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      if (contentType.includes('application/json')) {
        // 2xx sem áudio: corpo JSON é erro legível
        try {
          await res.arrayBuffer()
        } catch {
          /* corpo ilegível — o erro abaixo já diz o que veio */
        }
        throw new TtsError(
          'http',
          `resposta da API sem áudio (HTTP ${res.status} veio ${contentType})`,
          {
            backend: 'api',
            status: res.status
          }
        )
      }
      return { res, url, model, t0, signal, timeout, timeoutMs, requested }
    }
    let raw: string
    try {
      raw = await res.text()
    } catch (e) {
      throw failure(e, opts, ctx)
    }
    if (attempt === 0 && requested === 'wav' && rejectsWavForPcm(res.status, raw)) {
      pcmOnlyEndpoints.add(baseUrl)
      requested = 'pcm'
      continue
    }
    throw httpError(res.status, raw, url)
  }
}

/** O corpo é PCM cru? (content-type `audio/pcm;rate=…`, ou `pcm` pedido sem content-type útil). */
function pcmFormatOf(sp: SpeechResponse): { sampleRate: number; channels: number } | null {
  const contentType = sp.res.headers.get('content-type') ?? ''
  const parsed = parsePcmContentType(contentType)
  if (parsed) return parsed
  const ct = contentType.toLowerCase()
  if (
    sp.requested === 'pcm' &&
    (!ct || ct.startsWith('audio/pcm') || ct.startsWith('application/octet-stream'))
  )
    return { sampleRate: PCM_DEFAULT_RATE, channels: 1 }
  return null
}

async function synthesizeApi(
  text: string,
  settings: TtsSettings,
  format: TtsFormat,
  opts: TtsSynthesizeOptions
): Promise<TtsSynthesizeResult> {
  const sp = await requestSpeech(text, settings, format, opts)
  let raw: Uint8Array
  try {
    // o corpo também corre sob o timeout/abort: ler fora do try deixava o timeout no meio do
    // download escapar como erro cru (nunca virava `TtsError` 'timeout')
    raw = new Uint8Array(await sp.res.arrayBuffer())
  } catch (e) {
    throw failure(e, opts, sp)
  }
  if (!raw.length)
    throw new TtsError(
      'http',
      `resposta da API sem áudio (HTTP ${sp.res.status} com corpo vazio)`,
      {
        backend: 'api',
        status: sp.res.status
      }
    )
  const pcm = pcmFormatOf(sp)
  if (pcm) {
    // adaptador: PCM16 cru → WAV (o resto do app — clipes, "Testar voz", chamada — toca wav)
    const aligner = new Pcm16MonoAligner(pcm.channels)
    const mono = aligner.push(raw)
    if (!mono.length)
      throw new TtsError('http', 'resposta da API sem áudio (PCM vazio)', {
        backend: 'api',
        status: sp.res.status
      })
    return {
      audio: encodeWav(mono, pcm.sampleRate),
      mime: 'audio/wav',
      model: sp.model,
      backend: 'api',
      ms: Date.now() - sp.t0
    }
  }
  return {
    audio: raw,
    mime: MIME_BY_FORMAT[format],
    model: sp.model,
    backend: 'api',
    ms: Date.now() - sp.t0
  }
}

// ---------------- streaming (PCM progressivo) ----------------

/** Síntese em streaming: PCM16 mono chegando aos pedaços (endpoints que devolvem `audio/pcm`). */
export interface TtsPcmStream {
  streaming: true
  sampleRate: number
  model: string
  backend: 'api'
  /** Início da request (ms epoch) — latência até o 1º áudio = chegada do 1º pedaço − t0. */
  t0: number
  /**
   * Pedaços PCM16 LE **mono** em ordem, alinhados em amostras inteiras (consumidor único). Termina
   * no fim do corpo; erro de rede/tempo → `TtsError`; abort do `signal` → `AbortError`.
   */
  chunks: AsyncIterable<Uint8Array>
  /**
   * Início (ms, relativo ao começo deste áudio) de cada letra/dígito do texto — alinhamento EXATO
   * do motor (ElevenLabs WebSocket), lido na hora (cresce com o áudio). Ausente = estimativa.
   */
  unitStartsMs?: () => number[] | null
}

/** Resultado de `synthesizeStream`: stream PCM, ou o áudio completo quando não há streaming. */
export type TtsStreamResult = TtsPcmStream | { streaming: false; result: TtsSynthesizeResult }

/**
 * Como `synthesize` (wav), mas devolve o áudio aos pedaços quando o endpoint responde PCM cru
 * (`audio/pcm;rate=N` — ex.: OpenRouter/ElevenLabs, que chega progressivo): o chamador começa a
 * tocar no 1º pedaço em vez de esperar o corpo inteiro. Motor local e endpoints que devolvem
 * wav/mp3 → `{ streaming: false, result }` (bytes completos, como `synthesize`).
 */
export async function synthesizeStream(
  input: Omit<TtsSynthesizeInput, 'format'>,
  opts: TtsSynthesizeOptions = {}
): Promise<TtsStreamResult> {
  const text = input.text.trim()
  if (!text)
    throw new TtsError('config', 'texto para a síntese de fala está vazio', { backend: 'api' })
  input = { ...input, settings: await resolveGpuSettings(input.settings) }
  if (input.settings.backend === 'local')
    return { streaming: false, result: await synthesizeLocal(text, input.settings, 'wav', opts) }
  if (isElevenLabsEndpoint(input.settings.api))
    return synthesizeElevenLabsStream(text, input.settings.api, opts)
  const sp = await requestSpeech(text, input.settings, 'wav', opts)
  const pcm = pcmFormatOf(sp)
  if (!pcm || !sp.res.body) {
    let raw: Uint8Array
    try {
      raw = new Uint8Array(await sp.res.arrayBuffer())
    } catch (e) {
      throw failure(e, opts, sp)
    }
    if (!raw.length)
      throw new TtsError(
        'http',
        `resposta da API sem áudio (HTTP ${sp.res.status} com corpo vazio)`,
        {
          backend: 'api',
          status: sp.res.status
        }
      )
    const audio = pcm
      ? encodeWav(new Pcm16MonoAligner(pcm.channels).push(raw), pcm.sampleRate)
      : raw
    return {
      streaming: false,
      result: {
        audio,
        mime: 'audio/wav',
        model: sp.model,
        backend: 'api',
        ms: Date.now() - sp.t0
      }
    }
  }
  const body = sp.res.body
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const reader = body.getReader()
    const aligner = new Pcm16MonoAligner(pcm!.channels)
    let total = 0
    try {
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>
        try {
          r = await reader.read()
        } catch (e) {
          throw failure(e, opts, sp)
        }
        if (r.done) break
        const out = aligner.push(r.value)
        if (out.length) {
          total += out.length
          yield out
        }
      }
      if (!total)
        throw new TtsError('http', 'resposta da API sem áudio (PCM vazio)', {
          backend: 'api',
          status: sp.res.status
        })
    } finally {
      // consumidor parou no meio (barge-in/erro): solta a conexão
      reader.cancel().catch(() => undefined)
    }
  }
  return {
    streaming: true,
    sampleRate: pcm.sampleRate,
    model: sp.model,
    backend: 'api',
    t0: sp.t0,
    chunks: chunks()
  }
}

/**
 * Síntese com os bytes COMPLETOS para frases curtas da chamada (frases de demora — "Só mais um
 * instante…"): como `synthesizeStream`, mas o PCM progressivo é juntado num bloco PCM cru
 * (`audio/pcm;rate=N`, sem streaming — toca pelo mesmo player Web Audio das frases da resposta e
 * se emenda nelas sem buraco); motor local / wav / mp3 → os bytes como vieram. ElevenLabs direta
 * vai pelo REST (`synthesizeElevenLabsStream`), nunca pelo WebSocket da resposta.
 */
export async function synthesizeBlock(
  input: Omit<TtsSynthesizeInput, 'format'>,
  opts: TtsSynthesizeOptions = {}
): Promise<{ audio: Uint8Array; mime: string }> {
  const r = await synthesizeStream(input, opts)
  if (!r.streaming) return { audio: r.result.audio, mime: r.result.mime }
  const parts: Uint8Array[] = []
  for await (const c of r.chunks) parts.push(c)
  return { audio: concatBytes(parts), mime: `audio/pcm;rate=${r.sampleRate}` }
}

/** Junta um stream PCM num WAV completo (clipes/"Testar voz" quando só há o stream). */
export async function collectPcmStream(stream: TtsPcmStream): Promise<TtsSynthesizeResult> {
  const parts: Uint8Array[] = []
  for await (const c of stream.chunks) parts.push(c)
  return {
    audio: encodeWav(concatBytes(parts), stream.sampleRate),
    mime: 'audio/wav',
    model: stream.model,
    backend: 'api',
    ms: Date.now() - stream.t0
  }
}
