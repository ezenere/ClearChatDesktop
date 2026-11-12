// Sessão de transcrição de voz (main, SEM Electron — testável): acumula o PCM16 mono 16 kHz do
// microfone, dispara parciais **melhor-esforço** a cada `STT_PARTIAL_INTERVAL_MS` (pedaços do
// acumulado com sobreposição de `STT_PARTIAL_OVERLAP_MS`, janela máxima `STT_PARTIAL_WINDOW_MS`;
// nunca com outra parcial em voo — sem fila e sem abortar-e-reenviar) e transcreve o buffer
// inteiro em `stop()` (final, via `transcribeWithFallback`; silêncio final longo aparado; acima
// do limite de upload da API vai em segmentos). `cancel()` descarta tudo sem transcrever. Uma
// sessão ATIVA por vez, com autocura: iniciar outra substitui a anterior; sessões de um renderer
// que recarregou/caiu são descartadas por `cancelTranscribeSessions(owner)`; sem PCM por 60 s a
// sessão se cancela. `encodeWav` monta o wav PCM enviado à API. **Portão de ativação de fala**
// (`@shared/speechGate`) na frente de TODA via de STT (parciais, segmentos, especulação e final):
// trecho com voz de menos não chama o STT, o que vai é aparado, e o texto passa pelo pós-filtro de
// alucinações de silêncio. Ver SPEC.md → "Áudio → Sessão de transcrição" e "Portão de ativação de
// fala".
import type { VoicePartialEvent, VoiceTranscribeResult } from '@shared/ipc'
import type { SttLocalConfig, SttSettings } from '@shared/voice'
import { STT_LOCAL_PARTIALS_OFF_NOTICE } from '@shared/voice'
import { INITIAL_NOISE_FLOOR_DB, SpeechGate, filterSilenceHallucination } from '@shared/speechGate'
import { abortError } from '../tools/util'
import type { LocalModelInfo } from './models'
import {
  chooseSttBackend,
  isSttFallbackable,
  STT_PARTIAL_INTERVAL_MS,
  STT_PARTIAL_OVERLAP_MS,
  SttError,
  transcribeAudio,
  transcribeWithFallback,
  type SttFallbackResult,
  type SttLocalBackend,
  type TranscribeAudioInput
} from './stt'
import {
  createSttLocalBackend,
  engineUnavailableError,
  isSttEngineRuntimeAvailable,
  resolveSttModelsBaseDir
} from './sttLocal'
import { encodeWav } from './wav'
import { isTransientVoiceError } from './callErrors'

/** PCM16 mono a esta taxa (Hz): o formato do buffer da sessão e do wav enviado à API. */
export const VOICE_SAMPLE_RATE = 16_000
/** PCM16 mono: 2 bytes por amostra → bytes por ms. */
const BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000
/** Sobreposição entre pedaços consecutivos das parciais, em bytes de PCM. */
const OVERLAP_BYTES = Math.round(STT_PARTIAL_OVERLAP_MS * BYTES_PER_MS)

// ---------------- wav PCM (puro) ----------------

// `encodeWav` vive em `wav.ts` (sem dependências — usado também pelo processo do motor de TTS);
// reexportado aqui para os chamadores existentes.
export { encodeWav }

// ---------------- sessão ----------------

/**
 * `hasLocalReady` da sessão: há modelo de STT **instalado** para o engine escolhido em
 * `sttSettings.local` **e** o runtime deste engine é carregável nesta versão ("pronto = modelo
 * instalado + runtime", SPEC → "Áudio → Runtime local de STT")? Pura — o estado em disco vem de
 * `listLocalModels` (`'installed'` conta; `'corrupt'`/`'downloading'`/`'notInstalled'` não) e o
 * runtime de `isSttEngineRuntimeAvailable` (hoje só `whisper.cpp`; `vosk`/`nemotron` → false). A
 * semântica é por ENGINE (o modelo concreto a carregar é escolhido pelo runtime — ver
 * `resolveModelEntry` em `voice/sttLocal.ts`); `installed` em `sttSettings.local`/`ttsSettings.local`
 * é só um espelho da UI — a verdade é sempre o disco (SPEC → "Áudio → Componentes locais").
 */
export function deriveHasLocalReady(
  local: Pick<SttLocalConfig, 'engine'> | null,
  models: readonly LocalModelInfo[]
): boolean {
  if (!local) return false
  if (!isSttEngineRuntimeAvailable(local.engine)) return false
  return models.some(
    (m) => m.entry.kind === 'stt' && m.entry.engine === local.engine && m.state === 'installed'
  )
}

/**
 * Erro honesto quando o backend local é o escolhido mas não dá para transcrever: sem modelo
 * escolhido, engine sem motor de inferência nesta versão (os arquivos podem estar instalados — ver
 * `engineUnavailableError`), nada instalado para o engine ou arquivo ausente/corrompido. Todos os
 * casos mantêm a frase-âncora "motor local de transcrição não está pronto"; `kind: 'config'`
 * (nunca cai em fallback) e o conselho é usar o modo API.
 */
function localRuntimeError(
  local: Pick<SttLocalConfig, 'engine' | 'model'> | null,
  modelReady: boolean
): SttError {
  if (!local)
    return new SttError(
      'config',
      'motor local de transcrição não está pronto — nenhum modelo local configurado (escolha/baixe um modelo em Configurações → Áudio) ou use o modo API',
      { backend: 'local' }
    )
  if (!isSttEngineRuntimeAvailable(local.engine)) return engineUnavailableError(local.engine)
  return new SttError(
    'config',
    modelReady
      ? 'motor local de transcrição não está pronto — o arquivo do modelo local está ausente/corrompido (reinstale em Configurações → Áudio) ou use o modo API'
      : `motor local de transcrição não está pronto — nenhum modelo local instalado para o engine '${local.engine}' (baixe em Configurações → Áudio) ou use o modo API`,
    { backend: 'local' }
  )
}

/** Nota curta (pt-BR) do porquê não há fallback local (anexada ao erro da API no modo hybrid). */
function localFallbackNote(
  local: Pick<SttLocalConfig, 'engine'> | null,
  modelReady: boolean
): string {
  if (!local) return 'nenhum modelo local configurado'
  if (!isSttEngineRuntimeAvailable(local.engine))
    return `o engine '${local.engine}' ainda não tem motor de inferência nesta versão`
  if (!modelReady) return `nenhum modelo local instalado para o engine '${local.engine}'`
  return 'o modelo local não está pronto (arquivo ausente/corrompido — reinstale em Configurações → Áudio)'
}

export interface TranscribeSessionDeps {
  /** Relógio (testes); padrão `Date.now`. */
  now?: () => number
  /**
   * Motor local injetado; sem ele, a sessão cria o runtime padrão (`voice/sttLocal.ts`) para o
   * `settings.local` atual (modo 'local' sem motor pronto falha legível).
   */
  local?: SttLocalBackend
  /**
   * Modelo local instalado para o engine escolhido (`deriveHasLocalReady`); padrão false. O
   * backend local só está "pronto" (`hasLocalReady` de `chooseSttBackend`) quando isto E o runtime
   * (`local.ready`) valem — sem runtime, as parciais seguem pela API melhor-esforço e as
   * transcrições que exigem o motor local falham com erro `config` honesto.
   */
  hasLocalReady?: boolean
  /** Recebe as parciais ao vivo (o IPC repassa em `voice:partial`). */
  onPartial?: (e: VoicePartialEvent) => void
  /**
   * Dono da sessão (o IPC passa o id do `webContents` que a iniciou): `cancelTranscribeSessions`
   * descarta as sessões de um dono que recarregou/caiu/fechou.
   */
  ownerId?: number | string
  /** Sem PCM por este tempo → a sessão se cancela sozinha (padrão `STT_SESSION_IDLE_MS`; 0 = nunca). */
  idleTimeoutMs?: number
  /** Teto de áudio aceito por sessão em ms (padrão `STT_SESSION_MAX_MS`). */
  maxAudioMs?: number
  /** Teto do wav por request da final na API (padrão `STT_API_MAX_UPLOAD_BYTES`; testes). */
  apiMaxUploadBytes?: number
  /**
   * Transcrição segmentada (padrão true): nas pausas da fala o trecho desde o último corte é
   * transcrito em segundo plano e o texto fica estável; a final só transcreve o trecho final.
   */
  segmented?: boolean
  /**
   * Falha FATAL (chave/cota/config) numa parcial, segmento ou especulação — a final ainda vai
   * falhar: a chamada de voz encerra já em vez de esperar o fim da fala (o IPC repassa).
   */
  onError?: (e: unknown, purpose: 'partial' | 'segment' | 'speculate') => void
}

/** Sem PCM por 60 s com a sessão ativa = renderer sumiu/travou → cancelamento automático. */
export const STT_SESSION_IDLE_MS = 60_000
/** Janela máxima de áudio de uma parcial (~10 s): parciais nunca crescem com a gravação. */
export const STT_PARTIAL_WINDOW_MS = 10_000
/** Teto de áudio de uma sessão (30 min ≈ 57,6 MB de PCM); o excedente é descartado com aviso. */
export const STT_SESSION_MAX_MS = 30 * 60_000
/**
 * Limite de upload das APIs OpenAI-compatíveis (Groq/OpenAI: 25 MB por arquivo) com folga: a final
 * maior que isto vai em segmentos (cortados no trecho mais silencioso perto da fronteira) e os
 * textos são concatenados.
 */
export const STT_API_MAX_UPLOAD_BYTES = 24 * 1024 * 1024
/** Silêncio final acima disto é aparado antes da final (o whisper alucina em silêncio longo). */
export const STT_TRAILING_SILENCE_MS = 1_500
/** Quanto do silêncio final fica depois de aparar. */
const TRAILING_SILENCE_KEEP_MS = 400
/** RMS (PCM16) abaixo disto conta como silêncio (≈ −46 dBFS — conservador). */
const SILENCE_RMS = 164
/** RMS (PCM16) da fala para os cortes de segmento (≈ −40 dBFS — o limiar de silêncio da captura). */
const SPEECH_RMS = 328
/** Pausa (ms de silêncio contínuo) que fecha um segmento da transcrição em segundo plano. */
export const STT_SEGMENT_PAUSE_MS = 500
/** Fala mínima (ms) desde o último corte para valer um segmento (fala curta fica inteira). */
export const STT_SEGMENT_MIN_MS = 3_000
/** Sem pausa: o segmento é cortado no trecho mais silencioso antes deste tamanho (ms). */
export const STT_SEGMENT_MAX_MS = 25_000
/** Novas tentativas de um segmento que falhou (depois disso a final cobre o trecho). */
const SEGMENT_RETRIES = 1

export interface StartTranscribeOptions {
  /** Configuração de transcrição REAL (com a chave — nunca sai do main). */
  settings: SttSettings
  /** Idioma do áudio ('pt-BR' → 'pt' na API); ausente/vazio = detecção automática. */
  language?: string
  /**
   * Nível de ativação do microfone (dBFS — `audioInput.activationDb`, local do dispositivo);
   * ausente = `DEFAULT_ACTIVATION_DB`. Abaixo dele nada é fala (o portão não manda ao STT).
   */
  activationDb?: number
}

export interface TranscribeStopOptions {
  /** O usuário não voltou a falar depois da última especulação: ela vira a final. */
  reuseSpeculative?: boolean
  /**
   * A parcial atual cobre a fala inteira desde o último segmento (uma transcrição só do trecho,
   * sem fala depois dela): vira a final sem request (`VoiceTranscribeResult.partialReused`).
   */
  reusePartial?: boolean
}

export interface TranscribeSession {
  /** Áudio recebido até agora (ms de PCM a 16 kHz) — custos/tempos da chamada de voz. */
  readonly audioMs?: number
  readonly id: string
  /** Acumula PCM16 mono little-endian a 16 kHz; `sampleRate` informado precisa casar. */
  push(chunk: Uint8Array, sampleRate?: number): void
  /**
   * Encerra a captura e transcreve o buffer inteiro (final; `purpose: 'final'`). Com
   * `reuseSpeculative` (o renderer garante que o usuário não voltou a falar depois da última
   * especulação) e uma especulação REUSÁVEL (mesmo backend da final), a transcrição especulativa
   * vira a final — sem 2ª chamada de STT.
   */
  stop(opts?: TranscribeStopOptions): Promise<VoiceTranscribeResult>
  /**
   * Transcrição ESPECULATIVA de tudo o que já foi capturado, sem encerrar (fim de turno adaptativo
   * da chamada de voz): motor local quando pronto (modo local/híbrido); API só com `allowApi`
   * (modo api/híbrido sem motor). null = indisponível (o chamador usa o silêncio fixo).
   */
  speculate(opts?: { allowApi?: boolean }): Promise<VoiceSpeculativeResult | null>
  /** Descarta tudo sem transcrever (idempotente). */
  cancel(): void
}

/** Resultado de `speculate()`. */
export interface VoiceSpeculativeResult {
  text: string
  ms: number
  backend: 'api' | 'local'
  /** Pode virar a final (`stop({ reuseSpeculative })`) — mesmo backend que a final usaria. */
  reusable: boolean
}

interface SpeculationState {
  /** Bytes de PCM cobertos (o buffer inteiro no momento da especulação). */
  bytes: number
  backend: 'api' | 'local'
  reusable: boolean
  controller: AbortController
  promise: Promise<VoiceSpeculativeResult | null>
  /** Resultado (null = falhou/abortou). */
  result: VoiceSpeculativeResult | null
  done: boolean
}

interface SessionState {
  id: string
  opts: StartTranscribeOptions
  now: () => number
  local?: SttLocalBackend
  /** Modelo instalado para o engine escolhido (ver `deriveHasLocalReady`). */
  hasLocalReady: boolean
  onPartial?: (e: VoicePartialEvent) => void
  onError?: (e: unknown, purpose: 'partial' | 'segment' | 'speculate') => void
  ownerId?: number | string
  chunks: Uint8Array[]
  totalBytes: number
  maxBytes: number
  /** O teto de áudio foi atingido (aviso emitido uma vez). */
  truncated: boolean
  /** Bytes já cobertos pelas parciais aceitas (o próximo pedaço recua `OVERLAP_BYTES`). */
  coveredBytes: number
  partialText: string
  /** Geração da última request disparada (resultados de gerações antigas expiram). */
  seq: number
  inFlight: { seq: number; controller: AbortController } | null
  lastFireAt: number
  /** Parciais desligadas no resto da sessão (auth/cota/config — o erro saiu uma vez). */
  partialsOff: boolean
  status: 'active' | 'stopping' | 'ended' | 'cancelled'
  finalController: AbortController | null
  idleMs: number
  idleTimer: ReturnType<typeof setTimeout> | null
  apiMaxUploadBytes: number
  /** Última transcrição especulativa (fim de turno adaptativo) — null = nenhuma. */
  spec: SpeculationState | null
  /** Portão de ativação de fala (quadros de 20 ms do buffer inteiro). */
  gate: SpeechGate
  // ---- transcrição segmentada (cortes nas pausas; a final só transcreve o trecho final) ----
  /** Segmentação ligada (backend da final utilizável). */
  segmented: boolean
  /** Fim (bytes) do áudio já transcrito em segmentos — a final e as parciais partem daqui. */
  segCut: number
  /** Texto dos segmentos já transcritos (estável). */
  segText: string
  /** Segmento em transcrição (um por vez, na ordem). */
  segInFlight: {
    start: number
    end: number
    controller: AbortController
    promise: Promise<void>
  } | null
  /** Silêncio contínuo no fim do buffer (bytes) e fim do último quadro com fala (bytes). */
  silenceRunBytes: number
  lastVoicedEnd: number
  /**
   * A parcial atual é a transcrição INTEIRA do trecho `[start, end)` desde o último corte (uma
   * request só, sem emendas): cobrindo a fala até o fim, vira a final/especulativa sem request.
   */
  tailExact: { start: number; end: number; backend: 'api' | 'local' } | null
  /**
   * Final adiantada pela API (mesmo áudio da especulação) quando o veredito sai do motor local mas
   * a final iria pela API (modo api/híbrido com motor local pronto e `allowApi`): reusável como
   * final no `stop({ reuseSpeculative })` — a final já está em voo desde a pausa.
   */
  prefetch: SpeculationState | null
}

interface SessionInternal {
  state: SessionState
  session: TranscribeSession
}

/** A sessão que recebe áudio (no máximo uma). */
let current: SessionInternal | null = null
/**
 * Piso de ruído aprendido pela última sessão (dBFS): a próxima começa dele — na chamada cada fala é
 * uma sessão curta, e o piso precisa atravessar as falas para se adaptar ao ambiente.
 */
let lastNoiseFloorDb = INITIAL_NOISE_FLOOR_DB
/** Sessões vivas (a ativa + as que ainda transcrevem a final depois do `stop`). */
const live = new Set<SessionInternal>()

/** A sessão ativa (única por vez) — usada pelo IPC para validar o id de push/stop/cancel. */
export function activeTranscribeSession(): TranscribeSession | null {
  return current?.session ?? null
}

/** Sessão viva (ativa ou terminando a final) pelo id — o `stop` de uma sessão substituída ainda vale. */
export function findTranscribeSession(id: string): TranscribeSession | null {
  for (const s of live) if (s.state.id === id) return s.session
  return null
}

/**
 * Descarta (cancel — sem transcrever; a final em voo é abortada) as sessões vivas do dono
 * `ownerId` — ou todas, sem argumento. O IPC chama quando o renderer recarrega, cai ou a janela
 * fecha: a sessão do renderer que sumiu nunca mais recebe `stop`/`cancel`. Devolve quantas.
 */
export function cancelTranscribeSessions(ownerId?: number | string): number {
  let n = 0
  for (const s of [...live]) {
    if (ownerId !== undefined && s.state.ownerId !== ownerId) continue
    s.session.cancel()
    n++
  }
  return n
}

const notActive = (): Error =>
  new Error('A transcrição não está mais ativa (encerrada ou cancelada).')

function sliceBuffer(state: SessionState, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start)
  let chunkStart = 0
  let written = 0
  for (const c of state.chunks) {
    const chunkEnd = chunkStart + c.length
    if (chunkEnd > start && chunkStart < end) {
      const from = Math.max(start, chunkStart) - chunkStart
      const to = Math.min(end, chunkEnd) - chunkStart
      out.set(c.subarray(from, to), written)
      written += to - from
    }
    chunkStart = chunkEnd
  }
  return out
}

const joinText = (a: string, b: string): string => [a, b].filter((x) => x.trim()).join(' ')

/**
 * Junta o texto de dois segmentos: um espaço entre eles e, quando o anterior não terminou a frase
 * (sem `.!?…`), a maiúscula que o STT pôs no começo do segmento seguinte vira minúscula (o corte
 * foi numa pausa no meio da frase; "E"/"A"/"O"/"É" sozinhos também) — siglas ("API", "SRC") ficam.
 */
export function joinSegments(prev: string, next: string): string {
  const a = prev.trim()
  let b = next.trim()
  if (!a) return b
  if (!b) return a
  if (!/[.!?…]["'”»)]*$/.test(a) && /^(\p{Lu}\p{Ll}|[EAOÉÀ](?=\s))/u.test(b))
    b = b[0].toLowerCase() + b.slice(1)
  return `${a} ${b}`
}

/** Erros de parcial que não melhoram tentando de novo (chave/cota/config) — desligam as parciais. */
const isPartialFatal = (e: unknown): boolean =>
  e instanceof SttError && (e.kind === 'auth' || e.kind === 'quota' || e.kind === 'config')

// ---------------- PCM: silêncio e segmentação (puros) ----------------

/** RMS (em unidades PCM16) de `[start, end)` amostras do PCM16 LE. */
function rmsOf(dv: DataView, start: number, end: number): number {
  let acc = 0
  for (let i = start; i < end; i++) {
    const v = dv.getInt16(i * 2, true)
    acc += v * v
  }
  return end > start ? Math.sqrt(acc / (end - start)) : 0
}

/**
 * Apara o silêncio no FIM do PCM16 mono quando ele passa de `STT_TRAILING_SILENCE_MS` (deixa
 * `TRAILING_SILENCE_KEEP_MS`): o auto-stop por silêncio grava segundos de nada no fim e o whisper
 * tende a alucinar ("Obrigado.") nesse trecho. Silêncio = quadros de 20 ms com RMS < ≈ −46 dBFS.
 */
export function trimTrailingSilence(pcm: Uint8Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const samples = pcm.length >> 1
  const frame = Math.max(1, Math.round(sampleRate / 50))
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let end = samples
  while (end > 0) {
    const start = Math.max(0, end - frame)
    if (rmsOf(dv, start, end) >= SILENCE_RMS) break
    end = start
  }
  const silent = samples - end
  if (silent * 1000 < STT_TRAILING_SILENCE_MS * sampleRate) return pcm
  const keep = Math.round((TRAILING_SILENCE_KEEP_MS * sampleRate) / 1000)
  return pcm.subarray(0, Math.min(samples, end + keep) * 2)
}

/**
 * Corta o PCM16 em segmentos de no máximo `maxBytes` (pares), cada corte no quadro de 100 ms mais
 * silencioso dos últimos ~20 s antes da fronteira (para não partir palavras). Puro.
 */
export function splitPcmForUpload(
  pcm: Uint8Array,
  maxBytes: number,
  sampleRate = VOICE_SAMPLE_RATE
): Uint8Array[] {
  const max = Math.max(2, maxBytes - (maxBytes % 2))
  if (pcm.length <= max) return [pcm]
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const frame = Math.max(1, Math.round(sampleRate / 10))
  const searchSamples = Math.min(Math.floor(max / 4), 20 * sampleRate)
  const out: Uint8Array[] = []
  let start = 0 // em amostras
  const total = pcm.length >> 1
  while ((total - start) * 2 > max) {
    const limit = start + (max >> 1)
    let best = limit
    let bestRms = Infinity
    for (
      let end = limit;
      end - frame >= limit - searchSamples && end - frame > start;
      end -= frame
    ) {
      const r = rmsOf(dv, end - frame, end)
      if (r < bestRms) {
        bestRms = r
        best = end - (frame >> 1)
      }
    }
    out.push(pcm.subarray(start * 2, best * 2))
    start = best
  }
  out.push(pcm.subarray(start * 2))
  return out
}

function emitPartial(state: SessionState, ms: number, error?: string): void {
  state.onPartial?.({
    sessionId: state.id,
    // segmentos estáveis + a parcial do trecho atual
    text: joinSegments(state.segText, state.partialText),
    isFinal: false,
    ms,
    // áudio coberto pelo texto (ms desde o início da sessão): o renderer sabe se a parcial está
    // "em dia" com a fala (cauda confiável para o backchannel)
    coveredMs: Math.round(state.coveredBytes / BYTES_PER_MS),
    ...(error ? { error } : {})
  })
}

/**
 * Dispara a parcial quando o intervalo decorreu e há áudio novo: pedaço `[covered − sobreposição,
 * agora]` (no máximo `STT_PARTIAL_WINDOW_MS`) como wav, `purpose: 'partial'` via
 * `chooseSttBackend` com o runtime local pronto. Pela **API** (melhor-esforço) ou pelo **motor
 * local em janelas** (whisper.cpp até o `base` — `local.partials`). Sem motor pronto, parciais
 * locais não existem (o modo 'local' nunca vaza para a API). Melhor-esforço SEM fila: **nunca**
 * dispara com outra em voo (a seguinte recobre o pedaço dela quando a anterior voltar), resultados
 * velhos expiram e erros de parcial nunca interrompem a sessão — auth/cota/config desligam as
 * parciais pelo resto da sessão com UM aviso (`VoicePartialEvent.error`).
 */
function maybeFirePartial(state: SessionState): void {
  if (state.status !== 'active' || state.partialsOff || state.inFlight) return
  // especulação em voo usa o mesmo motor: a parcial espera (a especulação é mais urgente)
  if (state.spec && !state.spec.done) return
  const { settings } = state.opts
  if (!settings.livePartials) return
  // pronto = modelo instalado (hasLocalReady) E motor de inferência disponível (local.ready) — sem
  // runtime, as parciais continuam melhor-esforço na API (modo 'local' nunca vaza para a API)
  const localReady = state.hasLocalReady && state.local?.ready === true
  const chosen = chooseSttBackend(settings, { hasLocalReady: localReady, purpose: 'partial' })
  if (chosen === 'local' && !localReady) return
  if (chosen === 'local' && state.local?.partials === false) {
    // modelo grande demais para parciais por janelas: avisa UMA vez (a UI mostra o aviso no lugar
    // de "Ouvindo…" sem texto — antes parecia travado) e não tenta de novo nesta sessão
    state.partialsOff = true
    emitPartial(state, 0, STT_LOCAL_PARTIALS_OFF_NOTICE)
    return
  }
  const now = state.now()
  if (now - state.lastFireAt < STT_PARTIAL_INTERVAL_MS) return
  const pieceEnd = state.totalBytes
  // nada falado depois do que já está coberto (só silêncio): não sobe silêncio (o whisper alucina)
  if (state.lastVoicedEnd > 0 && state.lastVoicedEnd <= state.coveredBytes) return
  const windowBytes = Math.round(STT_PARTIAL_WINDOW_MS * BYTES_PER_MS)
  // trecho desde o último corte ≤ janela: transcreve o trecho INTEIRO (texto sem emendas, que pode
  // virar a final); maior: janelas com sobreposição, emendadas (melhor-esforço)
  const exact = pieceEnd - state.segCut <= windowBytes
  const pieceStart = exact
    ? state.segCut
    : Math.max(state.segCut, state.coveredBytes - OVERLAP_BYTES, pieceEnd - windowBytes)
  if (pieceEnd - pieceStart <= 0) return
  const cutAtFire = state.segCut
  // portão de fala: pedaço sem voz suficiente não sobe (o whisper alucina em silêncio/ruído)
  const g = state.gate.analyze(pieceStart, pieceEnd)
  if (!g.send) return

  state.lastFireAt = now
  const seq = ++state.seq
  const controller = new AbortController()
  state.inFlight = { seq, controller }
  const audio = sliceBuffer(state, g.send.start, g.send.end)
  const input = {
    audio: encodeWav(audio, VOICE_SAMPLE_RATE),
    mimeType: 'audio/wav',
    fileName: 'partial'
  }
  const partial: Promise<{ text: string; ms: number }> =
    chosen === 'local'
      ? state.local!.transcribe(input, {
          language: state.opts.language,
          signal: controller.signal
        })
      : transcribeAudio(input, {
          settings,
          language: state.opts.language,
          signal: controller.signal
        })
  void partial
    .then((res) => {
      let r = res
      // resultado velho (sessão encerrada/abortada) expira; nunca entra na fila
      if (state.status !== 'active' || state.seq !== seq) return
      if (state.segCut !== cutAtFire) return // um segmento fechou no meio: esta parcial ficou velha
      r = { ...r, text: filterSilenceHallucination(r.text, g) }
      if (exact) {
        state.partialText = r.text.trim()
        state.tailExact = { start: pieceStart, end: pieceEnd, backend: chosen }
      } else {
        state.partialText = joinText(state.partialText, r.text)
        state.tailExact = null
      }
      state.coveredBytes = pieceEnd
      emitPartial(state, r.ms)
    })
    .catch((e) => {
      // melhor-esforço: abort/erro de parcial não interrompe a sessão (a final decide); erro que
      // não melhora tentando de novo desliga as parciais (sem reenvio em loop) com um aviso
      if (controller.signal.aborted || state.status !== 'active') return
      if (isPartialFatal(e)) {
        state.partialsOff = true
        state.onError?.(e, 'partial')
        emitPartial(
          state,
          0,
          `Parciais ao vivo desligadas nesta gravação: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    })
    .finally(() => {
      if (state.inFlight?.seq === seq) state.inFlight = null
    })
}

/** Acompanha a fala/silêncio do fim do buffer (quadros de 20 ms do pedaço recém-chegado). */
function trackSpeech(state: SessionState, chunk: Uint8Array): void {
  const base = state.totalBytes - chunk.length
  const frame = Math.round(20 * BYTES_PER_MS)
  const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.length - (chunk.length % 2))
  for (let off = 0; off < dv.byteLength; off += frame) {
    const end = Math.min(dv.byteLength, off + frame)
    if (rmsOf(dv, off >> 1, end >> 1) >= SPEECH_RMS) {
      state.lastVoicedEnd = base + end
      state.silenceRunBytes = 0
    } else state.silenceRunBytes += end - off
  }
}

/**
 * Corta um segmento quando a fala pausa (≥ `STT_SEGMENT_PAUSE_MS`, com ≥ `STT_SEGMENT_MIN_MS` de
 * fala desde o último corte) — no meio do silêncio — ou, sem pausa, no trecho mais silencioso antes
 * de `STT_SEGMENT_MAX_MS` (`splitPcmForUpload`). Um segmento por vez; o texto dele fica estável.
 */
function maybeCutSegment(state: SessionState): void {
  if (!state.segmented || state.status !== 'active' || state.segInFlight) return
  const voiced = state.lastVoicedEnd - state.segCut
  if (voiced <= 0) return
  const ms = (x: number): number => Math.round(x * BYTES_PER_MS) & ~1
  if (state.silenceRunBytes >= ms(STT_SEGMENT_PAUSE_MS) && voiced >= ms(STT_SEGMENT_MIN_MS)) {
    const cut = state.lastVoicedEnd + (Math.min(state.silenceRunBytes >> 1, ms(250)) & ~1)
    fireSegment(state, state.segCut, Math.min(cut, state.totalBytes), 0)
    return
  }
  if (state.totalBytes - state.segCut >= ms(STT_SEGMENT_MAX_MS)) {
    const pieces = splitPcmForUpload(
      sliceBuffer(state, state.segCut, state.totalBytes),
      ms(STT_SEGMENT_MAX_MS) - 2
    )
    if (pieces.length > 1) fireSegment(state, state.segCut, state.segCut + pieces[0].length, 0)
  }
}

function fireSegment(state: SessionState, start: number, end: number, attempt: number): void {
  if (end - start <= 0) return
  const controller = new AbortController()
  // portão de fala: segmento sem voz suficiente vale texto vazio (sem chamar o STT)
  const g = state.gate.analyze(start, end)
  const input = g.send
    ? {
        audio: encodeWav(sliceBuffer(state, g.send.start, g.send.end), VOICE_SAMPLE_RATE),
        mimeType: 'audio/wav',
        fileName: 'segment'
      }
    : null
  const stt: Promise<{ text: string; ms: number }> = input
    ? transcribeWithFallback(input, {
        settings: state.opts.settings,
        language: state.opts.language,
        local: state.local,
        signal: controller.signal
      })
    : Promise.resolve({ text: '', ms: 0 })
  const promise = stt
    .then((r) => {
      if (controller.signal.aborted || state.status === 'cancelled' || state.segCut !== start)
        return
      state.segText = joinSegments(state.segText, filterSilenceHallucination(r.text, g))
      state.segCut = end
      // a parcial do trecho que virou segmento sai; as próximas partem do corte
      state.partialText = ''
      state.tailExact = null
      state.coveredBytes = end
      if (state.status === 'active') emitPartial(state, r.ms)
    })
    .catch((e) => {
      if (controller.signal.aborted || state.status === 'cancelled') return
      // chave/cota/config: sem segmentos (a final decide e mostra o erro)
      if (isPartialFatal(e)) {
        state.segmented = false
        state.onError?.(e, 'segment')
        return
      }
      if (attempt < SEGMENT_RETRIES) {
        if (state.segInFlight?.controller === controller) state.segInFlight = null
        fireSegment(state, start, end, attempt + 1)
      }
      // desistiu: o trecho fica para a final (o corte não anda)
    })
    .finally(() => {
      if (state.segInFlight?.controller === controller) state.segInFlight = null
    })
  state.segInFlight = { start, end, controller, promise }
}

/** Espera os segmentos em voo (inclusive novas tentativas) — a final parte do último corte. */
async function settleSegments(state: SessionState): Promise<void> {
  for (let i = 0; i < 5 && state.segInFlight; i++) await state.segInFlight.promise.catch(() => {})
}

/** A parcial atual cobre toda a fala desde o último corte (uma transcrição só do trecho)? */
function tailCoveredByPartial(state: SessionState): boolean {
  const t = state.tailExact
  return (
    !!t &&
    t.start === state.segCut &&
    t.end >= state.lastVoicedEnd &&
    !!state.partialText.trim() &&
    !state.segInFlight
  )
}

/**
 * Transcrição especulativa do buffer inteiro (fim de turno adaptativo): backend local quando o
 * motor está pronto (modos local/híbrido), API só com `allowApi` (modo api, ou híbrido sem motor);
 * senão null. Mesma especulação reaproveitada quando não chegou áudio novo; a anterior em voo é
 * abortada; a parcial em voo é abortada (mesmo motor — a especulação é mais urgente). Reusável como
 * final quando o backend é o mesmo que a final usaria (`chooseSttBackend` final). Nunca rejeita por
 * falha de STT (resolve null — o chamador cai no silêncio fixo).
 */
function startSpeculation(
  state: SessionState,
  allowApi: boolean
): Promise<VoiceSpeculativeResult | null> {
  const { settings } = state.opts
  const localReady = state.hasLocalReady && state.local?.ready === true
  // veredito: motor local sempre que pronto (rápido, nada sai da máquina — inclusive no modo api);
  // sem motor, pela API só com permissão (no modo local nunca)
  const backend: 'local' | 'api' | null =
    settings.mode === 'local' || settings.mode === 'gpu'
      ? localReady
        ? 'local'
        : null
      : localReady
        ? 'local'
        : allowApi
          ? 'api'
          : null
  if (!backend) return Promise.resolve(null)
  const prev = state.spec
  if (prev && prev.bytes === state.totalBytes && !prev.controller.signal.aborted)
    return prev.promise
  prev?.controller.abort()
  state.prefetch?.controller.abort()
  state.prefetch = null
  const finalBackendNow = chooseSttBackend(settings, { hasLocalReady: localReady })
  if (tailCoveredByPartial(state)) {
    // a parcial já transcreveu a fala inteira do trecho: ela É a especulação (sem request)
    const t = state.tailExact!
    const result: VoiceSpeculativeResult = {
      text: joinSegments(state.segText, state.partialText),
      ms: 0,
      backend: t.backend,
      reusable: t.backend === finalBackendNow
    }
    const spec: SpeculationState = {
      bytes: state.totalBytes,
      backend: t.backend,
      reusable: result.reusable,
      controller: new AbortController(),
      promise: Promise.resolve(result),
      result,
      done: true
    }
    state.spec = spec
    return spec.promise
  }
  // a especulação cobre o buffer inteiro: a parcial em voo ficou redundante (mesmo motor, ou mais
  // uma request concorrente na API — no OpenRouter elas disputam a mesma fila e atrasam a final)
  state.inFlight?.controller.abort()
  state.inFlight = null
  const finalBackend = finalBackendNow
  const segBase = state.segText
  const cutAt = state.segCut
  // só o trecho desde o último segmento (o texto dos segmentos já está pronto), pelo portão de
  // fala: sem voz suficiente a especulação é o texto dos segmentos — sem request (e reusável: a
  // final também não chamaria o STT)
  const g = state.gate.analyze(state.segCut, state.totalBytes)
  if (!g.send) {
    const result: VoiceSpeculativeResult = {
      text: segBase,
      ms: 0,
      backend: finalBackend,
      reusable: true
    }
    state.spec = {
      bytes: state.totalBytes,
      backend: finalBackend,
      reusable: true,
      controller: new AbortController(),
      promise: Promise.resolve(result),
      result,
      done: true
    }
    return state.spec.promise
  }
  const pcm = sliceBuffer(state, g.send.start, g.send.end)
  if (!pcm.length || pcm.length + 44 > state.apiMaxUploadBytes) return Promise.resolve(null)
  const input = {
    audio: encodeWav(pcm, VOICE_SAMPLE_RATE),
    mimeType: 'audio/wav',
    fileName: 'audio'
  }
  const run = (b: 'local' | 'api', reusable: boolean): SpeculationState => {
    const controller = new AbortController()
    const p: Promise<{ text: string; ms: number }> =
      b === 'local'
        ? state.local!.transcribe(input, {
            language: state.opts.language,
            signal: controller.signal
          })
        : transcribeAudio(input, {
            settings,
            language: state.opts.language,
            signal: controller.signal
          })
    const spec: SpeculationState = {
      bytes: state.totalBytes,
      backend: b,
      reusable,
      controller,
      promise: Promise.resolve(null),
      result: null,
      done: false
    }
    spec.promise = p
      .then((r) => {
        if (controller.signal.aborted) return null
        // um segmento fechou no meio: o texto do trecho já não casa com o corte atual
        if (state.segCut !== cutAt) return null
        spec.result = {
          text: joinSegments(segBase, filterSilenceHallucination(r.text, g)),
          ms: r.ms,
          backend: b,
          reusable
        }
        return spec.result
      })
      .catch((e) => {
        // especulação é melhor-esforço (o silêncio fixo assume), mas erro fatal avisa já
        if (!controller.signal.aborted && isPartialFatal(e)) state.onError?.(e, 'speculate')
        return null
      })
      .finally(() => {
        spec.done = true
      })
    return spec
  }
  const spec = run(backend, finalBackend === backend)
  state.spec = spec
  // veredito local + final pela API: a final já sai agora (reusada se o usuário não voltar a falar)
  if (!spec.reusable && finalBackend === 'api' && allowApi) state.prefetch = run('api', true)
  return spec.promise
}

function clearIdle(state: SessionState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = null
}

function armIdle(state: SessionState, session: TranscribeSession): void {
  clearIdle(state)
  if (!state.idleMs || state.status !== 'active') return
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null
    if (state.status !== 'active') return
    console.warn(
      `[clearchat] transcrição ${state.id} sem áudio há ${Math.round(state.idleMs / 1000)} s — cancelada`
    )
    session.cancel()
  }, state.idleMs)
  state.idleTimer.unref?.()
}

/** Transcreve a final em segmentos que cabem no upload da API e concatena (sequencial). */
async function transcribeFinal(
  state: SessionState,
  pcm: Uint8Array,
  signal: AbortSignal
): Promise<SttFallbackResult> {
  const maxPcm = state.apiMaxUploadBytes - 44
  const segments = splitPcmForUpload(pcm, maxPcm)
  const opts = {
    settings: state.opts.settings,
    language: state.opts.language,
    local: state.local,
    signal
  }
  // falha transitória (rede, tempo esgotado, 5xx, 429 sem cota) ganha UMA nova tentativa já
  const once = async (input: TranscribeAudioInput): Promise<SttFallbackResult> => {
    try {
      return await transcribeWithFallback(input, opts)
    } catch (e) {
      if (signal.aborted || !isTransientVoiceError(e, 'stt')) throw e
      return await transcribeWithFallback(input, opts)
    }
  }
  const toInput = (seg: Uint8Array, i: number): TranscribeAudioInput => ({
    audio: encodeWav(seg, VOICE_SAMPLE_RATE),
    mimeType: 'audio/wav',
    fileName: segments.length > 1 ? `audio-${i + 1}` : 'audio'
  })
  if (segments.length === 1) return once(toInput(segments[0], 0))
  const parts: SttFallbackResult[] = []
  for (let i = 0; i < segments.length; i++) {
    if (signal.aborted) throw abortError()
    parts.push(await once(toInput(segments[i], i)))
  }
  const last = parts[parts.length - 1]
  const fell = parts.find((p) => p.fellBack)
  return {
    ...last,
    text: parts
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join(' '),
    ms: parts.reduce((a, p) => a + p.ms, 0),
    fellBack: !!fell,
    ...(fell?.fallbackReason ? { fallbackReason: fell.fallbackReason } : {})
  }
}

/**
 * Cria a sessão de transcrição (uma ativa por vez). `push` acumula PCM16 mono 16 kHz; parciais
 * melhor-esforço saem por `onPartial`; `stop()` transcreve o buffer final (com fallback quando há
 * `local` injetado) e `cancel()` descarta tudo sem transcrever. **Autocura**: uma sessão ativa
 * anterior é cancelada e substituída (o renderer que a abriu desistiu dela — recarregou, caiu ou
 * perdeu o id); uma anterior que já está transcrevendo a final (`stop` em voo) segue até o fim.
 * Sem PCM por `idleTimeoutMs` (60 s) a sessão se cancela sozinha.
 */
export function startTranscribeSession(
  opts: StartTranscribeOptions,
  deps: TranscribeSessionDeps = {}
): TranscribeSession {
  if (current) {
    const prev = current
    current = null
    if (prev.state.status === 'active') {
      console.warn(`[clearchat] transcrição ${prev.state.id} substituída por uma nova — cancelada`)
      prev.session.cancel()
    }
  }
  const maxAudioMs = deps.maxAudioMs ?? STT_SESSION_MAX_MS
  const state: SessionState = {
    id: crypto.randomUUID(),
    opts,
    now: deps.now ?? Date.now,
    // sem injeção (produção/testes de integração): o runtime local padrão para o engine/modelo
    // escolhidos em `settings.local` (`voice/sttLocal.ts`; baseDir = userData, lazy)
    local:
      deps.local ??
      createSttLocalBackend({
        baseDir: resolveSttModelsBaseDir(),
        selection: opts.settings.local
      }),
    hasLocalReady: deps.hasLocalReady === true,
    onPartial: deps.onPartial,
    onError: deps.onError,
    ownerId: deps.ownerId,
    chunks: [],
    totalBytes: 0,
    maxBytes: Math.max(0, Math.round(maxAudioMs * BYTES_PER_MS)) & ~1,
    truncated: false,
    coveredBytes: 0,
    partialText: '',
    seq: 0,
    inFlight: null,
    lastFireAt: (deps.now ?? Date.now)(),
    partialsOff: false,
    status: 'active',
    finalController: null,
    idleMs: deps.idleTimeoutMs ?? STT_SESSION_IDLE_MS,
    idleTimer: null,
    apiMaxUploadBytes: Math.max(1024, deps.apiMaxUploadBytes ?? STT_API_MAX_UPLOAD_BYTES),
    spec: null,
    prefetch: null,
    gate: new SpeechGate({
      activationDb: opts.activationDb,
      sampleRate: VOICE_SAMPLE_RATE,
      noiseFloorDb: lastNoiseFloorDb
    }),
    // segmentos só com o backend da final utilizável (modo local sem motor: a final já falha)
    // (modo local sem motor: o 1º segmento falha com erro `config` e desliga a segmentação)
    segmented: deps.segmented !== false,
    segCut: 0,
    segText: '',
    segInFlight: null,
    silenceRunBytes: 0,
    lastVoicedEnd: 0,
    tailExact: null
  }

  const end = (): void => {
    if (state.status !== 'cancelled') state.status = 'ended'
    // o piso de ruído aprendido segue para a próxima sessão (falas curtas da chamada)
    if (state.gate.frames > 0) lastNoiseFloorDb = state.gate.noiseFloorDb
    clearIdle(state)
    if (current?.state === state) current = null
    live.delete(internal)
  }

  const session: TranscribeSession = {
    get id(): string {
      return state.id
    },
    get audioMs(): number {
      return Math.round(state.totalBytes / BYTES_PER_MS)
    },
    push(chunk: Uint8Array, sampleRate?: number): void {
      if (state.status !== 'active') throw notActive()
      if (!(chunk instanceof Uint8Array))
        throw new Error('Áudio PCM inválido (esperado Uint8Array).')
      if (chunk.length % 2)
        throw new Error('Áudio PCM16 inválido (número ímpar de bytes — 2 bytes por amostra).')
      if (sampleRate !== undefined && sampleRate !== VOICE_SAMPLE_RATE)
        throw new Error(
          `A captura deve vir em PCM16 mono a ${VOICE_SAMPLE_RATE} Hz (recebido ${sampleRate} Hz).`
        )
      armIdle(state, session)
      if (!chunk.length) return
      const room = state.maxBytes - state.totalBytes
      if (room <= 0 || chunk.length > room) {
        if (room > 0) {
          state.chunks.push(chunk.slice(0, room))
          state.totalBytes += room
        }
        if (!state.truncated) {
          state.truncated = true
          emitPartial(
            state,
            0,
            `Gravação atingiu o limite de ${Math.round(state.maxBytes / BYTES_PER_MS / 60_000)} min — o áudio depois disso não será transcrito; pare para transcrever.`
          )
        }
        return
      }
      state.chunks.push(chunk)
      state.totalBytes += chunk.length
      state.gate.push(chunk)
      trackSpeech(state, chunk)
      maybeCutSegment(state)
      maybeFirePartial(state)
    },
    speculate(opts?: { allowApi?: boolean }): Promise<VoiceSpeculativeResult | null> {
      if (state.status !== 'active') return Promise.reject(notActive())
      return startSpeculation(state, !!opts?.allowApi)
    },
    async stop(opts?: TranscribeStopOptions): Promise<VoiceTranscribeResult> {
      if (state.status !== 'active') throw notActive()
      state.status = 'stopping'
      clearIdle(state)
      if (current?.state === state) current = null // a vaga de captura já fica livre
      state.inFlight?.controller.abort()
      state.inFlight = null
      const apiResult = (
        text: string,
        backend: 'api' | 'local',
        ms: number
      ): VoiceTranscribeResult => {
        const local = state.opts.settings.local
        return {
          text,
          model:
            backend === 'local'
              ? local?.model || local?.engine || 'local'
              : state.opts.settings.api.model,
          baseUrl:
            backend === 'local'
              ? 'local'
              : (state.opts.settings.api.baseUrl ?? '').trim().replace(/\/+$/, ''),
          ms,
          backend,
          fellBack: false
        }
      }
      if (opts?.reusePartial && tailCoveredByPartial(state)) {
        // a parcial já é a transcrição inteira do trecho final: a final sai sem request
        const backend = state.tailExact!.backend
        const text = joinSegments(state.segText, state.partialText)
        state.spec?.controller.abort()
        state.prefetch?.controller.abort()
        end()
        return { ...apiResult(text, backend, 0), partialReused: true }
      }
      const spec = state.spec?.reusable
        ? state.spec
        : state.prefetch?.reusable
          ? state.prefetch
          : null
      if (opts?.reuseSpeculative && spec) {
        // o usuário não voltou a falar depois da especulação: ela (ou a final adiantada) É a final
        // (sem 2ª chamada)
        const r = await spec.promise.catch(() => null)
        if (r && (state.status as string) !== 'cancelled') {
          end()
          const local = state.opts.settings.local
          return {
            text: r.text,
            model:
              r.backend === 'local'
                ? local?.model || local?.engine || 'local'
                : state.opts.settings.api.model,
            baseUrl:
              r.backend === 'local'
                ? 'local'
                : (state.opts.settings.api.baseUrl ?? '').trim().replace(/\/+$/, ''),
            ms: r.ms,
            backend: r.backend,
            fellBack: false,
            speculative: true
          }
        }
      }
      state.spec?.controller.abort()
      state.prefetch?.controller.abort()
      try {
        // segmentos em voo terminam (começaram antes — saem antes); a final é só o trecho final
        await settleSegments(state)
        if ((state.status as string) === 'cancelled') throw abortError()
        // portão de fala: o trecho final sem voz suficiente não vai ao STT (vazio — ou só os
        // segmentos); com voz, só do 1º ao último quadro com voz (com folga)
        const g = state.gate.analyze(state.segCut, state.totalBytes)
        const pcm = g.send
          ? trimTrailingSilence(sliceBuffer(state, g.send.start, g.send.end))
          : new Uint8Array(0)
        if (!pcm.length && state.segText) {
          end()
          return {
            ...apiResult(
              state.segText,
              chooseSttBackend(state.opts.settings, { hasLocalReady: state.local?.ready === true }),
              0
            )
          }
        }
        if (!pcm.length) {
          // nada capturado → texto vazio sem rede ("parar" sem falar não deve falhar)
          const backend = chooseSttBackend(state.opts.settings, {
            hasLocalReady: state.local?.ready === true
          })
          const local = state.opts.settings.local
          return {
            text: '',
            model:
              backend === 'local'
                ? local?.model || local?.engine || 'local'
                : state.opts.settings.api.model,
            baseUrl:
              backend === 'local'
                ? 'local'
                : (state.opts.settings.api.baseUrl ?? '').trim().replace(/\/+$/, ''),
            ms: 0,
            backend,
            fellBack: false
          }
        }
        const controller = new AbortController()
        state.finalController = controller
        const runtimeReady = state.local?.ready === true
        // sem motor pronto, o backend local não tem como transcrever: erro `config` honesto (o
        // modelo pode estar instalado) em vez de falha genérica no fim
        if (
          !runtimeReady &&
          chooseSttBackend(state.opts.settings, { hasLocalReady: false }) === 'local'
        )
          throw localRuntimeError(state.opts.settings.local, state.hasLocalReady)
        const raw = await transcribeFinal(state, pcm, controller.signal)
        const r = { ...raw, text: filterSilenceHallucination(raw.text, g) }
        return state.segText ? { ...r, text: joinSegments(state.segText, r.text) } : r
      } catch (e) {
        if (state.finalController?.signal.aborted || (state.status as string) === 'cancelled')
          throw abortError()
        // hybrid com o fallback local bloqueado (modelo/engine/runtime): a anotação conta a
        // verdade junto do erro da API em vez de deixar o fallback "sumir" em silêncio
        if (
          state.opts.settings.mode === 'hybrid' &&
          state.opts.settings.local &&
          state.local?.ready !== true &&
          isSttFallbackable(e)
        ) {
          const msg = e instanceof Error ? e.message : String(e)
          throw new SttError(
            'config',
            `${msg} — sem fallback local: ${localFallbackNote(state.opts.settings.local, state.hasLocalReady)}`,
            { backend: 'local', cause: e }
          )
        }
        throw e
      } finally {
        end()
      }
    },
    cancel(): void {
      if (state.status === 'ended' || state.status === 'cancelled') return
      state.finalController?.abort()
      state.spec?.controller.abort()
      state.prefetch?.controller.abort()
      state.segInFlight?.controller.abort()
      state.segInFlight = null
      state.inFlight?.controller.abort()
      state.inFlight = null
      state.chunks = []
      state.totalBytes = 0
      state.coveredBytes = 0
      state.partialText = ''
      state.status = 'cancelled'
      end()
    }
  }

  const internal: SessionInternal = { state, session }
  current = internal
  live.add(internal)
  armIdle(state, session)
  return session
}
