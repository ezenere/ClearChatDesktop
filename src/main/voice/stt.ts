// Serviço de transcrição de voz (STT) do main — cliente do endpoint OpenAI-compatível
// `/audio/transcriptions` (do provedor cadastrado) + política pura de backend (api/local/híbrido). Sem Electron,
// sem UI, sem IPC (a fiação vem na fatia de integração) e sem backend local (os modelos locais entram
// em outra fatia; aqui o motor local é injetado como `SttLocalBackend`). O main é dono da rede e das
// chaves: a `apiKey` nunca sai daqui. Contratos de config em `@shared/voice` (`SttSettings`).
// Ver SPEC.md → "Áudio → Serviço de transcrição (STT)".
import type { SttSettings } from '@shared/voice'
import { connectionErrorText, isConnectionFailure } from '@shared/network'
import { voiceProviderSupport } from '@shared/voiceCatalog'
import { apiParamsToSend } from '@shared/voiceParams'
import { abortError } from '../tools/util'

// ---------------- medição de uso (custos da chamada de voz) ----------------

/** Uma request de transcrição pela API que deu certo (parcial, especulação, segmento ou final). */
export interface SttApiUsage {
  model: string
  baseUrl: string
  /** Endpoint na própria máquina (servidor local/GPU — grátis). */
  local: boolean
  /** Áudio enviado (ms; WAV medido pelo cabeçalho — outros formatos: null). */
  audioMs: number | null
  /** `usage.cost` devolvido pela API (OpenRouter); ausente = não informado. */
  cost?: number
}
const sttUsageListeners = new Set<(u: SttApiUsage) => void>()
/** Assina cada transcrição pela API (o main soma na chamada de voz ativa). Devolve o "desassinar". */
export function onSttApiUsage(cb: (u: SttApiUsage) => void): () => void {
  sttUsageListeners.add(cb)
  return () => sttUsageListeners.delete(cb)
}
function reportSttUsage(u: SttApiUsage): void {
  for (const cb of sttUsageListeners) {
    try {
      cb(u)
    } catch {
      /* medição nunca derruba a transcrição */
    }
  }
}

/** Duração (ms) de um WAV PCM pelo cabeçalho (byte rate); não-WAV → null. */
function wavDurationMs(audio: Uint8Array, mime: string): number | null {
  if (!/wav/i.test(mime) || audio.length < 44) return null
  const dv = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  if (dv.getUint32(0, false) !== 0x52494646) return null
  const byteRate = dv.getUint32(28, true)
  return byteRate > 0 ? Math.round(((audio.length - 44) / byteRate) * 1000) : null
}

/** `usage.cost` (número finito ≥ 0) de uma resposta JSON; ausente → undefined. */
export function sttUsageCost(json: unknown): number | undefined {
  const u = json && typeof json === 'object' ? (json as { usage?: unknown }).usage : undefined
  const c = u && typeof u === 'object' ? (u as { cost?: unknown }).cost : undefined
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : undefined
}

// ---------------- tipos ----------------

/** Áudio a transcrever (bytes crus do gravador — wav/mp3/webm/…). */
export interface TranscribeAudioInput {
  /** Bytes do áudio. */
  audio: Uint8Array
  /** MIME do áudio (ex.: 'audio/webm'). */
  mimeType: string
  /** Nome sugerido para o arquivo; a extensão é forçada a casar com o `mimeType`. */
  fileName?: string
}

/** Resultado de uma transcrição. */
export interface TranscribeResult {
  /** Texto transcrito (pode ser vazio quando não há fala). */
  text: string
  /** Modelo usado (`sttSettings.api.model`; no motor local, o modelo/motor dele). */
  model: string
  /** Base da API usada (no motor local: 'local'). */
  baseUrl: string
  /** Duração da chamada em ms. */
  ms: number
}

/**
 * Parcial ao vivo (enquanto o usuário fala) — contrato pronto para a fatia de integração.
 * Parciais via API são **melhor-esforço**: a cada `STT_PARTIAL_INTERVAL_MS` (~1 s) transcreve-se o
 * buffer com sobreposição de `STT_PARTIAL_OVERLAP_MS` (a API transcreve cada pedaço inteiro; o
 * texto pode ser reescrito no pedaço seguinte). Parciais de verdade vêm do motor local em
 * streaming — ver `chooseSttBackend(settings, { hasLocalReady, purpose: 'partial' })`.
 */
export interface TranscribePartial {
  /** Texto parcial (o definitivo quando `isFinal`). */
  text: string
  /** true na transcrição definitiva da fala. */
  isFinal: boolean
  /** Duração da chamada que gerou esta parcial, em ms. */
  ms: number
}

/** Intervalo entre pedidos de parcial via API (melhor-esforço). */
export const STT_PARTIAL_INTERVAL_MS = 1000
/** Sobreposição do buffer de áudio entre pedidos de parcial (ms). */
export const STT_PARTIAL_OVERLAP_MS = 300

/** Backend de transcrição. */
export type SttBackend = 'api' | 'local'

/** Categoria do erro de transcrição (decide se o fallback é tentado). */
export type SttErrorKind =
  | 'auth' // 401/403 — chave inválida/sem permissão (config errada; nunca cai no fallback)
  | 'quota' // 429/402 — limite de uso/cota (disponibilidade; cai no fallback)
  | 'http' // demais 4xx/5xx (fallback só em 5xx)
  | 'network' // conexão — ECONNREFUSED/DNS/reset… (cai no fallback)
  | 'timeout' // tempo esgotado (cai no fallback)
  | 'config' // sem provedor/chave/modelo ou backend indisponível (nunca cai no fallback)

/** Erro de transcrição com categoria, status HTTP e backend de origem. */
export class SttError extends Error {
  readonly kind: SttErrorKind
  readonly status?: number
  readonly backend: SttBackend

  constructor(
    kind: SttErrorKind,
    message: string,
    opts: { backend: SttBackend; status?: number; cause?: unknown }
  ) {
    super(message, { cause: opts.cause })
    this.name = 'SttError'
    this.kind = kind
    this.status = opts.status
    this.backend = opts.backend
  }
}

/**
 * O erro é de DISPONIBILIDADE (justifica cair no backend secundário)? Rede, timeout, cota/limite
 * (429/402) e 5xx do servidor sim; autenticação (401/403), configuração e demais 4xx **nunca**
 * (config errada tem que falhar visível).
 */
export function isSttFallbackable(e: unknown): boolean {
  if (e instanceof SttError)
    return (
      e.kind === 'network' ||
      e.kind === 'timeout' ||
      e.kind === 'quota' ||
      (e.kind === 'http' && (e.status ?? 0) >= 500)
    )
  // erros crus (motor local injetado): só falha de conexão conta como disponibilidade
  return isConnectionFailure(e)
}

// ---------------- nome do arquivo coerente com o mime ----------------

const MIME_EXT: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/opus': 'opus'
}

function extFor(mimeType: string): string {
  const mime = mimeType.split(';')[0].trim().toLowerCase()
  const known = MIME_EXT[mime]
  if (known) return known
  const sub = mime.split('/')[1] ?? ''
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'wav'
}

/**
 * Nome do campo `file` com extensão coerente com o `mimeType` (a API identifica o formato pelo
 * nome/mime do arquivo). O `fileName` do chamador fornece o nome-base (sem caminho/extensão);
 * sem ele, 'audio'.
 */
export function audioFileName(mimeType: string, fileName?: string): string {
  const name = (fileName ?? '').split(/[/\\]/).pop() ?? ''
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, '').trim() || 'audio'
  return `${base}.${extFor(mimeType)}`
}

/** `language` do app ('pt-BR') → ISO-639-1 da API/local ('pt'); vazio/ausente → null (detecção automática). */
export function languageParam(language?: string): string | null {
  const s = (language ?? '').trim()
  if (!s) return null
  const base = s.replace(/_/g, '-').split('-')[0].toLowerCase()
  return /^[a-z]{2,3}$/.test(base) ? base : s
}

/** Mensagem de erro do corpo (formato OpenAI/Groq `error.message`, `detail`, `message`), curta. */
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

// ---------------- cliente da API ----------------

/** Timeout padrão da request de transcrição (configurável por chamada). */
export const STT_DEFAULT_TIMEOUT_MS = 60_000

export interface SttTranscribeOptions {
  /** Configuração de transcrição (só `settings.api` é usado aqui). */
  settings: SttSettings
  /** Idioma do áudio (o app guarda tags regionais, 'pt-BR'; vai ISO-639-1, 'pt'). */
  language?: string
  /** Timeout da request em ms (padrão `STT_DEFAULT_TIMEOUT_MS` = 60 s). */
  timeoutMs?: number
  /** Cancelamento pelo chamador (Parar/⚡) — sai como `AbortError`, sem passar pelo fallback. */
  signal?: AbortSignal
}

function httpError(status: number, raw: string, url: string): SttError {
  const detail = errorDetail(raw)
  const tail = detail ? ` — ${detail}` : ''
  if (status === 401 || status === 403)
    return new SttError('auth', `chave de API inválida ou sem permissão (HTTP ${status})${tail}`, {
      backend: 'api',
      status
    })
  if (status === 402 || status === 429)
    return new SttError(
      'quota',
      `limite de uso/cota da transcrição atingido (HTTP ${status})${tail}`,
      { backend: 'api', status }
    )
  return new SttError('http', `HTTP ${status} na transcrição de áudio em ${url}${tail}`, {
    backend: 'api',
    status
  })
}

/**
 * Transcreve áudio com a API OpenAI-compatível de `sttSettings.api`: POST multipart em
 * `{baseUrl}/audio/transcriptions` (campo `file` com nome coerente com o mime, `model`, `language`
 * quando informado, `response_format: 'json'`; chave no header `Authorization: Bearer …`, nunca
 * devolvida ao chamador). Sucesso → `{ text, model, baseUrl, ms }`. Erros → `SttError` legível
 * (`kind`/`status`): `auth` (401/403), `quota` (429/402), `http` (demais 4xx/5xx, com o corpo
 * resumido), `network`, `timeout` (padrão 60 s, `timeoutMs`), `config` (sem provedor/chave/modelo).
 * Abort do `signal` propaga como `AbortError`.
 */
/** Endpoint na própria máquina (localhost/127.0.0.1/::1)? */
function isLocalEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

export async function transcribeAudio(
  input: TranscribeAudioInput,
  opts: SttTranscribeOptions
): Promise<TranscribeResult> {
  const api = opts.settings.api
  // endereço/chave resolvidos pelo main a partir do provedor cadastrado (ou do servidor da GPU)
  const baseUrl = (api.baseUrl ?? '').trim().replace(/\/+$/, '')
  const model = api.model.trim()
  const key = (api.apiKey ?? '').trim()
  if (!baseUrl)
    throw new SttError(
      'config',
      'nenhum provedor de transcrição escolhido — escolha um em Configurações → Áudio',
      { backend: 'api' }
    )
  if (!model)
    throw new SttError('config', 'modelo de transcrição não configurado', { backend: 'api' })
  // provedor local (localhost, cadastrado em Provedores) pode rodar sem chave — como o TTS
  if (!key && !isLocalEndpoint(baseUrl))
    throw new SttError(
      'config',
      'chave de API de transcrição não configurada no provedor (Configurações → Provedores)',
      { backend: 'api' }
    )

  const url = `${baseUrl}/audio/transcriptions`
  const timeoutMs = opts.timeoutMs ?? STT_DEFAULT_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const body = new FormData()
  body.append(
    'file',
    // cópia: `Uint8Array<ArrayBuffer>` satisfaz `BlobPart` em qualquer origem do buffer
    new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
    audioFileName(input.mimeType, input.fileName)
  )
  body.append('model', model)
  const language = languageParam(opts.language)
  if (language) body.append('language', language)
  body.append('response_format', 'json')
  // parâmetros do modelo escolhidos em Áudio → Parâmetros (`temperature`, `prompt` — só os que a
  // família aceita; o servidor da GPU nunca tem `params`)
  const family = voiceProviderSupport({ baseUrl, kind: api.providerKind ?? undefined })
  for (const [k, v] of Object.entries(apiParamsToSend('stt', family, model, api.params)))
    body.append(k, String(v))

  const t0 = Date.now()
  let raw: string
  let status: number
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        // assinatura de app do chat/persona do pedido (HTTP-Referer/X-Title — as mesmas do chat)
        ...(api.appHeaders ?? {}),
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {})
      },
      body,
      signal
    })
    status = res.status
    raw = await res.text()
  } catch (e) {
    if (opts.signal?.aborted) throw abortError()
    if (timeout.aborted)
      throw new SttError(
        'timeout',
        `tempo esgotado na transcrição de áudio (${timeoutMs / 1000} s) em ${url}`,
        { backend: 'api', cause: e }
      )
    throw new SttError(
      'network',
      `erro de rede ao transcrever áudio em ${url}: ${connectionErrorText(e)}`,
      { backend: 'api', cause: e }
    )
  }
  if (status < 200 || status >= 300) throw httpError(status, raw, url)

  let text: string | null = null
  let cost: number | undefined
  try {
    const json = (raw.trim() ? JSON.parse(raw) : null) as { text?: unknown } | null
    if (typeof json?.text === 'string') text = json.text
    cost = sttUsageCost(json)
  } catch {
    text = null
  }
  if (text === null)
    throw new SttError(
      'http',
      `resposta da API em formato inesperado (HTTP ${status} sem campo "text")`,
      { backend: 'api', status }
    )
  reportSttUsage({
    model,
    baseUrl,
    local: isLocalEndpoint(baseUrl),
    audioMs: wavDurationMs(input.audio, input.mimeType),
    ...(cost !== undefined ? { cost } : {})
  })
  return { text, model, baseUrl, ms: Date.now() - t0 }
}

// ---------------- política de backend (pura) ----------------

export interface SttBackendContext {
  /** O motor local está instalado e pronto para transcrever. */
  hasLocalReady: boolean
  /** 'final' (padrão): transcrição definitiva da fala; 'partial': parcial ao vivo. */
  purpose?: 'final' | 'partial'
}

/**
 * Qual backend transcreve (pura, testável):
 * - `api` → sempre 'api' (parciais via API melhor-esforço, chunked ~1 s);
 * - `local` → sempre 'local' — mesmo sem motor pronto (aí o erro é visível: config errada nunca
 *   vaza o áudio para a API); `gpu` idem (o motor injetado é o whisper da GPU local);
 * - `hybrid` → 'local' para as **parciais** quando o motor está pronto (streaming de verdade; sem
 *   pronto, cai em 'api' melhor-esforço) e 'api' para a **transcrição final** (mais precisa), com
 *   fallback para 'local' em erro de disponibilidade (ver `transcribeWithFallback`).
 */
export function chooseSttBackend(settings: SttSettings, ctx: SttBackendContext): SttBackend {
  // `gpu` (Modo avançado): o whisper do servidor local da GPU entra como o motor "local" injetado
  // (parciais, especulação e final por ele; nada vai para a API)
  if (settings.mode === 'local' || settings.mode === 'gpu') return 'local'
  if (settings.mode === 'api') return 'api'
  return ctx.purpose === 'partial' && ctx.hasLocalReady ? 'local' : 'api'
}

// ---------------- wrapper com fallback ----------------

/** Opções de uma chamada ao motor local. */
export interface SttLocalTranscribeOptions {
  /** Idioma do áudio ('pt-BR' → 'pt'). */
  language?: string
  /** Timeout da chamada em ms (o motor local pode ignorar quando não há como interromper). */
  timeoutMs?: number
  /** Cancelamento — aborta antes/depois da inferência quando ela não é interrompível. */
  signal?: AbortSignal
  /**
   * Texto incremental enquanto o engine consome o áudio (engines de streaming — Vosk sim; o
   * whisper.cpp emite parciais por **janelas** na sessão, `STT_PARTIAL_INTERVAL_MS`).
   */
  onPartial?: (text: string) => void
  /**
   * Finalidade: 'partial' = parcial ao vivo melhor-esforço (o motor local reduz o custo e pula a
   * parcial quando está ocupado — `SttBusyError`). Ausente = final/especulação/segmento.
   */
  purpose?: 'partial' | 'final'
}

/** Motor local de transcrição (injetado pela fatia de runtime local — `src/main/voice/sttLocal.ts`). */
export interface SttLocalBackend {
  /** Motor instalado/carregado e pronto para transcrever. */
  ready: boolean
  /**
   * Parciais por janelas valem a pena neste motor/modelo? Ausente = sim. O runtime whisper.cpp
   * desliga para modelos maiores que o `base` (cada janela custaria segundos de CPU).
   */
  partials?: boolean
  /** Transcreve localmente (no resultado, `baseUrl` = 'local' e `model` = motor/modelo local). */
  transcribe(
    input: TranscribeAudioInput,
    opts: SttLocalTranscribeOptions
  ): Promise<TranscribeResult>
}

export interface SttFallbackOptions extends SttTranscribeOptions {
  /** Motor local injetado; sem ele, o backend 'local' falha com erro legível (`SttError` config). */
  local?: SttLocalBackend
}

export interface SttFallbackResult extends TranscribeResult {
  /** Backend que serviu a transcrição. */
  backend: SttBackend
  /** true quando o primário falhou (erro de disponibilidade) e o secundário atendeu. */
  fellBack: boolean
  /** Motivo curto (pt-BR) da falha do primário quando `fellBack`. */
  fallbackReason?: string
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function runBackend(
  backend: SttBackend,
  input: TranscribeAudioInput,
  opts: SttFallbackOptions
): Promise<TranscribeResult> {
  if (backend === 'api') return transcribeAudio(input, opts)
  if (!opts.local?.ready)
    throw new SttError('config', 'motor local de transcrição não está pronto', { backend: 'local' })
  return opts.local.transcribe(input, {
    language: opts.language,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal
  })
}

/**
 * Transcreve no backend primário (`chooseSttBackend`) e, **só no modo `hybrid`**, cai no secundário
 * (o outro backend, quando pronto) em erro de **disponibilidade** (`isSttFallbackable`: rede,
 * timeout, cota/429, 5xx). Erro de autenticação/configuração (401/403, sem chave, 4xx) nunca cai:
 * config errada falha visível. Modos `api` e `local` nunca trocam de backend. Abort propaga como
 * `AbortError` (sem fallback). Os dois falhando → erro do secundário com a falha do primário anotada
 * ("após falha em …", como em `runWebSearch`).
 */
export async function transcribeWithFallback(
  input: TranscribeAudioInput,
  opts: SttFallbackOptions
): Promise<SttFallbackResult> {
  const hasLocalReady = opts.local?.ready === true
  const primary = chooseSttBackend(opts.settings, { hasLocalReady })
  const secondary: SttBackend | null =
    opts.settings.mode === 'hybrid' ? (primary === 'api' ? 'local' : 'api') : null
  try {
    return { ...(await runBackend(primary, input, opts)), backend: primary, fellBack: false }
  } catch (e) {
    const aborted = opts.signal?.aborted === true
    if (aborted) throw abortError()
    if (!secondary || !isSttFallbackable(e) || (secondary === 'local' && !hasLocalReady)) throw e
    try {
      return {
        ...(await runBackend(secondary, input, opts)),
        backend: secondary,
        fellBack: true,
        fallbackReason: errMsg(e)
      }
    } catch (e2) {
      if (opts.signal?.aborted) throw abortError()
      const note = ` (após falha em ${primary}: ${errMsg(e)})`
      if (e2 instanceof SttError)
        throw new SttError(e2.kind, e2.message + note, {
          backend: e2.backend,
          status: e2.status,
          cause: e2
        })
      throw new Error(errMsg(e2) + note, { cause: e2 })
    }
  }
}
