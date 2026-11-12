// Registro dos handlers IPC (ipcMain.handle) — um para cada canal em `IPC` (src/shared/ipc.ts).
// Handlers recebem os argumentos posicionais na mesma ordem da API do preload.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  ALL_CHANNELS,
  IPC,
  VOICE_CALL_STATE_CHANNEL,
  VOICE_CALL_TIMELINE_CHANNEL,
  VOICE_CALL_UTTERANCE_CANCEL_CHANNEL,
  VOICE_CALL_UTTERANCE_CHANNEL,
  VOICE_CALL_UTTERANCE_CHUNK_CHANNEL,
  VOICE_GPU_PROGRESS_CHANNEL,
  VOICE_MODELS_PROGRESS_CHANNEL,
  VOICE_PARTIAL_CHANNEL,
  VOICE_TTS_CLIPS_PROGRESS_CHANNEL,
  type AppCapabilities,
  type ApprovalDecision,
  type AttachmentAddInput,
  type AttachmentPickResult,
  type CompactOptions,
  type ChatCreateInput,
  type ChatUpdateInput,
  type PresetInput,
  type PresetPatch,
  type ProviderInput,
  type ProviderPatch,
  type ProviderTestInput,
  type SmartApproveTestInput,
  type TtsClipsView,
  type TtsVoicesView,
  type VoiceModelInfo,
  type VoiceRuntimeStatus,
  type VoiceSettingKind
} from '@shared/ipc'
import type { ApiMessage, AttachmentInfo, Chat, QuestionAnswer } from '@shared/types'
import {
  chatOfMessage,
  chatOfSession,
  gateById,
  gateChat,
  gatedSend,
  syncEngine,
  syncHandlers
} from './sync'
import { emit, onAgentEvent, sendToWindows } from './events'
import { isBranchEditable, pruneSel, selectionToReach } from '@shared/branches'
import {
  chatsRepo,
  messagesRepo,
  presetsRepo,
  providersRepo,
  sessionsRepo,
  settingsRepo
} from './repo'
import { invalidateModels, listModels, testProvider } from './providers'
import * as fsapi from './fsapi'
import {
  checkPresented,
  grantedPath,
  openViewerFile,
  readViewerText,
  viewerDevice,
  type ViewerDeps
} from './fileViewer'
import type { ViewerTarget } from '@shared/ipc'
import { checkedBytes, writeViewerTemp } from './viewerTemp'
import {
  assertCanOpenLocal,
  chmodX,
  runGrantedFile,
  runRemoteBytes,
  spawnDetached,
  whichSync,
  type RunDeps
} from './fileRun'
import { safeFileName } from '@shared/remoteFs'
import * as runner from './agent/runner'
import { setVoiceCallSource } from './agent/request'
import * as memory from './memory'
import { generateTitleNow } from './autoTitle'
import { answerQuestion } from './agent/questions'
import { bwrapAvailable } from './tools/bash'
import { listProcesses, processLogLines, stopChatProcesses, stopProcess } from './tools/processes'
import { removeChatToolOutputs } from './tools/toolOutputs'
import { shellInfoLite } from './tools/shellEnv'
import { ripgrepAvailable } from './tools/search'
import { readFile as readFileAsync, stat, writeFile as writeFileAsync } from 'fs/promises'
import { basename, join } from 'path'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import { formatSize } from '@shared/attachments'
import { saveAttachment } from './attachments'
import { getApprovalSettings, updateApprovalSettings } from './approvalSettings'
import type { ApprovalItemDecision } from '@shared/approvalPolicy'
import type { ApprovalSettings } from '@shared/types'
import {
  PROTECTED_SETTINGS,
  type EngineConfig,
  type SearchEngineId
} from '@shared/webSearchSettings'
import {
  getWebSearchSettings,
  revealWebSearchKey,
  setWebSearchKey,
  updateWebSearchEngines
} from './webSearchConfig'
import { testWebSearchEngine } from './tools/web'
import * as skills from './skills'
import { updateChecker } from './updates'
import { isReleaseUrl, RELEASES_PAGE, type UpdateStatus } from '@shared/updates'
import type { SkillsDiscoverOptions, SkillsSettings } from '@shared/skills'
import type {
  MemoryCollectionInput,
  MemoryCollectionPatch,
  MemoryInput,
  MemoryListQuery,
  MemoryPatch
} from '@shared/memory'
import {
  chatVoiceLayers,
  getVoiceSettings,
  getVoiceSettingsView,
  getVoiceSettingsWith,
  resolveVoice,
  setVoiceSetting,
  syncLocalModelInstalled,
  voiceCapsNeed,
  voiceLayersFrom,
  voiceUse,
  type VoiceSettings
} from './voice'
import { collectVoiceCaps } from './voice/voiceCaps'
import {
  normalizeVoiceTtsChoice,
  type VoiceLayers,
  type VoiceSttChoice,
  type VoiceTtsChoice
} from '@shared/voice'
import { cachedVoiceUnitPrice, fetchVoicePreview, listVoiceCatalog } from './voice/voiceCatalog'
import { onSttApiUsage } from './voice/stt'
import { audioDurationMs, sanitizeDictationMeta } from '@shared/voiceCallMarks'
import type { VoiceCatalogRequest } from '@shared/voiceCatalog'
import {
  clipVoiceId,
  generateClips,
  loadClips,
  clipStaleClasses,
  loadCurrentClipAudio,
  type ClipsManifest
} from './voice/clips'
import { createEvalLogger } from './voice/evalLog'
import { findCatalogEntry } from './voice/catalog'
import {
  downloadLocalModel,
  isListedLocalModel,
  listLocalModels,
  removeLocalModel,
  type LocalModelInfo
} from './voice/models'
import {
  cancelTranscribeSessions,
  deriveHasLocalReady,
  findTranscribeSession,
  startTranscribeSession,
  type TranscribeSession
} from './voice/session'
import {
  isSttEngineRuntimeAvailable,
  probeWhisperRuntime,
  releaseSttModel,
  sttEngineUnavailableReason
} from './voice/sttLocal'
import { synthesize, synthesizeBlock, synthesizeStream, TTS_TEST_PHRASE } from './voice/tts'
import { TtsStreamRelay } from './voice/ttsStreamRelay'
import { classifyVoiceError, voiceProviderLabel } from './voice/callErrors'
import { ElevenLabsCallTts, elevenLabsCallOptions } from './voice/elevenlabsStream'
import {
  createKokoroEngine,
  espeakMissingError,
  kokoroReadiness,
  probeEspeak,
  probeOnnxRuntime,
  type KokoroEngine
} from './voice/ttsLocal'
import { VoiceCallManager } from './voice/call'
import { isBusyStatus } from './voice/turnMachine'
import { dirname } from 'path'
import { GpuVoiceManager, type GpuMeasured } from './voice/gpu/manager'
import { setGpuEndpointResolver } from './voice/gpu/endpoint'
import { prepareGpuForCall } from './voice/gpu/callPrep'
import {
  gpuEnginesLabel,
  isGpuEngineId,
  isGpuTtsEngineId,
  type GpuEngineId
} from '@shared/gpuVoice'
// servidor do modo GPU: script Python pequeno no pacote (desempacotado do asar — roda com o Python
// baixado pelo app; `requirements/` fica ao lado)
import gpuServerScript from '../../resources/gpu-server/server.py?asset&asarUnpack'

type Handler = (...args: never[]) => unknown

function validateMessage(m: unknown): ApiMessage {
  if (!m || typeof m !== 'object') throw new Error('Mensagem inválida.')
  const msg = m as ApiMessage
  if (!['system', 'user', 'assistant', 'tool'].includes(msg.role)) throw new Error('role inválido.')
  if (msg.role === 'tool' && typeof msg.tool_call_id !== 'string')
    throw new Error('tool_call_id ausente.')
  return msg
}

/** Processos rodam no host: no controle remoto a lista é só leitura (§11). */
function remoteProcessGuard(chatId: string): void {
  const e = syncEngine()
  if (e?.active && e.host.mode(chatId) === 'remote')
    throw new Error(`Os processos rodam no host (${e.host.hostName(chatId)}) — gerencie-os por lá.`)
}

/** Sessão de transcrição viva pelo id — erro legível para id desconhecido/encerrado/substituído. */
function requireTranscribeSession(sessionId: string): TranscribeSession {
  const s = typeof sessionId === 'string' ? findTranscribeSession(sessionId) : null
  if (!s)
    throw new Error('Sessão de transcrição não encontrada (encerrada, cancelada ou substituída).')
  return s
}

// ---- dono das chamadas de IPC (para o ciclo de vida da voz por janela) ----

/**
 * `webContents.id` de quem invocou o handler em execução (lido no começo SÍNCRONO do handler —
 * depois de um `await` já pode ser de outra chamada). null fora de um handler.
 */
let ipcSenderId: number | null = null

/** Chamada de voz e dono dela (o webContents que entrou) — limpos quando o renderer some. */
let voiceCallsRef: VoiceCallManager | null = null
/** Streaming do TTS da chamada (PCM progressivo da API → renderer); abortado no barge-in/parar. */
let ttsRelayRef: TtsStreamRelay | null = null
/** [tts-feed] WebSocket da ElevenLabs da chamada (fechado quando o renderer some). */
let elevenCallRef: ElevenLabsCallTts | null = null
let voiceCallOwner: number | null = null
/**
 * Voz da chamada em andamento, decidida no `voice:call:start` (protocolo 1.9.0): a escolha da
 * persona/chat quando disponível AQUI (null = as settings deste dispositivo, relidas a cada uso) e
 * o idioma da escolha. Limpa quando a chamada termina.
 */
let callVoice: {
  chatId: string
  tts: VoiceTtsChoice | null
  stt: VoiceSttChoice | null
  language: string | null
} | null = null

/** Settings de voz para os serviços da chamada: as efetivas do chat da chamada (ver `callVoice`). */
function callVoiceSettings(chatId?: string | null): VoiceSettings {
  return callVoice && (!chatId || chatId === callVoice.chatId)
    ? getVoiceSettingsWith(callVoice)
    : getVoiceSettings()
}

/**
 * O renderer `webContentsId` recarregou, navegou, caiu ou a janela fechou: tudo de voz que ele
 * deixou aberto no main é encerrado — sessões de transcrição dele (a final em voo é abortada) e a
 * chamada de voz que ele abriu. Sem isso a sessão órfã segurava a vaga ("Já há uma transcrição…")
 * e a chamada seguia "ativa" sem ninguém ouvindo. Idempotente.
 */
/**
 * App fechando (antes do runner parar): a chamada ativa termina com o marcador de fim gravado já
 * (o histórico não fica com uma chamada "em andamento" para sempre); marcador adiado também sai.
 */
export function shutdownVoiceCall(): void {
  try {
    if (voiceCallsRef?.state().active)
      voiceCallsRef.stop(undefined, { by: 'user', note: 'o app foi fechado', immediate: true })
    voiceCallsRef?.flushPendingMarkers()
  } catch (e) {
    console.warn('[clearchat] voz: fim da chamada ao fechar:', e instanceof Error ? e.message : e)
  }
}

export function resetVoiceForWebContents(webContentsId: number, reason: string): void {
  const n = cancelTranscribeSessions(webContentsId)
  let callStopped = false
  if (voiceCallsRef && voiceCallOwner === webContentsId && voiceCallsRef.state().active) {
    voiceCallsRef.stop()
    ttsRelayRef?.abortAll()
    elevenCallRef?.close()
    callStopped = true
  }
  if (voiceCallOwner === webContentsId) voiceCallOwner = null
  if (n || callStopped)
    console.log(
      `[clearchat] voz: renderer ${webContentsId} ${reason} — ${n} transcrição(ões) cancelada(s)${callStopped ? ', chamada encerrada' : ''}`
    )
}

// ---- modelos locais de áudio (SPEC → "Áudio → Componentes locais") ----

/**
 * userData do app — a API de modelos locais recebe o `baseDir` e instala em `<userData>/models`
 * (o `modelsDir` do gerenciador faz a junção; passar o caminho já montado dobraria o `models`).
 */
const localModelsBaseDir = (): string => app.getPath('userData')

/** Downloads de modelos locais em voo por id (cancelamento via `voice:models:cancel`). */
const localDownloads = new Map<string, AbortController>()

/** Progresso emitido no máximo a cada 100 ms por modelo (e sempre ao terminar). */
const PROGRESS_MIN_MS = 100
const lastProgressAt = new Map<string, number>()

/** Entrada do catálogo + estado em disco → visão do renderer (`VoiceModelInfo`). */
const toModelView = (info: LocalModelInfo): VoiceModelInfo => ({
  id: info.entry.id,
  kind: info.entry.kind,
  engine: info.entry.engine,
  name: info.entry.name,
  description: info.entry.description,
  languages: [...info.entry.languages],
  version: info.entry.version,
  sizeBytes: info.entry.sizeBytes,
  hasDownload: !!info.entry.url && !info.entry.retired,
  state: info.state,
  installedBytes: info.installedBytes
})

/** `{ id }` dos canais `voice:models:*`, validado (id não vazio). */
function requireModelId(input: { id: string } | undefined): string {
  const id = input && typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) throw new Error('Modelo não informado (esperado { id }).')
  return id
}

// ---- TTS: síntese de fala e clipes (`voice:tts:*` — SPEC → "Áudio → Serviço de TTS") ----

/** Motor local Kokoro (memoizado — mantém a sessão ONNX aquecida entre chamadas). */
let kokoro: KokoroEngine | null = null
const ttsLocalEngine = (): KokoroEngine =>
  (kokoro ??= createKokoroEngine({ baseDir: app.getPath('userData') }))

/**
 * Voz de um chat/persona NESTE dispositivo (protocolo 1.9.0): sonda só o que as camadas e as
 * settings daqui usam (modelos locais/runtimes, modo GPU) e resolve fala + transcrição
 * (`resolveVoice`). Usado pelo `voice:resolve`, pelo início da chamada e pelo ditado.
 */
async function resolveVoiceFor(layers: VoiceLayers): Promise<ReturnType<typeof resolveVoice>> {
  const caps = await collectVoiceCaps(
    {
      provider: (id) => providersRepo.get(id),
      localModels: () => listLocalModels(localModelsBaseDir()),
      whisper: () => probeWhisperRuntime(),
      onnx: () => probeOnnxRuntime(),
      espeak: async () => {
        const e = await probeEspeak()
        return e.available ? e : { available: false, reason: espeakMissingError().message }
      },
      gpu: async () => (gpuManagerRef ? gpuManagerRef.status() : null)
    },
    voiceCapsNeed(layers)
  )
  return resolveVoice(layers, caps)
}

/** Prontidão dos runtimes locais (`voice:runtime:status`) — probes memoizados + estado em disco. */
async function voiceRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  const v = getVoiceSettings()
  const [whisper, onnx, espeak, models] = await Promise.all([
    probeWhisperRuntime(),
    probeOnnxRuntime(),
    probeEspeak(),
    listLocalModels(localModelsBaseDir())
  ])
  const sttReady = deriveHasLocalReady(v.stt.local, models)
  const engine = v.stt.local?.engine
  const sttReason = sttReady
    ? null
    : !v.stt.local
      ? 'nenhum modelo local de transcrição escolhido'
      : !isSttEngineRuntimeAvailable(v.stt.local.engine)
        ? (sttEngineUnavailableReason(v.stt.local.engine) ??
          `o engine '${engine}' ainda não tem motor de inferência nesta versão`)
        : `nenhum modelo local instalado para o engine '${engine}'`
  const ttsLocal =
    v.tts.local?.engine === 'kokoro'
      ? await kokoroReadiness(localModelsBaseDir(), v.tts.local.voice)
      : {
          available: false,
          reason: v.tts.local
            ? `o motor '${v.tts.local.engine}' ainda não tem runtime nesta versão`
            : 'nenhum motor local de fala escolhido'
        }
  // modo GPU (avançado): runtime + motor instalados, sem bloqueio de hardware
  const gpu =
    gpuManagerRef && (v.tts.backend === 'gpu' || v.stt.mode === 'gpu')
      ? await gpuManagerRef.readiness().catch(() => null)
      : null
  return {
    whisper: { available: whisper.available, reason: whisper.reason },
    onnxruntime: { available: onnx.available, reason: onnx.reason },
    espeak: espeak.available ? espeak : { available: false, reason: espeakMissingError().message },
    sttLocal: { available: sttReady, reason: sttReason },
    ttsLocal,
    ...(gpu ? gpu : {})
  }
}

// ---- "Modo avançado (GPU local)" — SPEC → "Áudio → Modo avançado (GPU local)" ----

/** Gerenciador do modo GPU (criado no `registerIpc`; parado no `before-quit`). */
let gpuManagerRef: GpuVoiceManager | null = null
/** Geração da chamada (start/stop): o preparo da GPU de uma chamada encerrada não mexe na nova. */
let gpuCallGen = 0
/** Setting local (não sincroniza) com o último autoteste de cada motor da GPU. */
const GPU_MEASURED_SETTING = 'gpuVoiceMeasured'

/** Saída do app: derruba os processos do servidor da GPU e cancela instalações. */
export function shutdownGpuVoice(): void {
  gpuManagerRef?.shutdown()
}

function createGpuManager(): GpuVoiceManager {
  const readMeasured = (): Partial<Record<GpuEngineId, GpuMeasured>> => {
    const raw = settingsRepo.get(GPU_MEASURED_SETTING)
    return raw && typeof raw === 'object' ? (raw as Partial<Record<GpuEngineId, GpuMeasured>>) : {}
  }
  return new GpuVoiceManager({
    baseDir: app.getPath('userData'),
    serverDir: dirname(gpuServerScript),
    // testes reais: cache de pip existente (só acelera os downloads; a instalação é do zero)
    pipCacheDir: process.env['CLEARCHAT_GPU_PIP_CACHE'] || undefined,
    getTts: () => getVoiceSettings().tts,
    getStt: () => getVoiceSettings().stt,
    readMeasured,
    writeMeasured: (id, m) =>
      settingsRepo.set(GPU_MEASURED_SETTING, { ...readMeasured(), [id]: m }),
    onStatus: (s) => sendToWindows(VOICE_GPU_PROGRESS_CHANNEL, s),
    log: (m) => console.log(`[clearchat] gpu: ${m}`)
  })
}

/** Sugestões livres de vozes para endpoints OpenAI-compatíveis (o campo aceita qualquer id). */
const TTS_API_VOICES: TtsVoicesView['api'] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer'
].map((id) => ({ id, label: id, engine: null }))

/** Manifest de clipes → visão do renderer (sem o hash da definição, que é interno). */
const toClipsView = (m: ClipsManifest): TtsClipsView => ({
  voiceId: m.voiceId,
  backend: m.backend,
  engine: m.engine,
  model: m.model,
  generatedAt: m.generatedAt,
  clips: m.clips.map((c) => ({ id: c.id, class: c.class, n: c.n, text: c.text }))
})

/** Banco + sync para o visualizador de arquivos (fileViewer.ts é sem Electron). */
const viewerDeps: ViewerDeps = {
  chat: (id) => chatsRepo.get(id),
  message: (id) => messagesRepo.get(id),
  chatOfSession: (sid) => sessionsRepo.get(sid)?.chatId ?? null,
  localDevice: () => viewerDevice(),
  remoteHost: (chatId) => {
    const e = syncEngine()
    if (!e?.active) return null
    const mode = e.host.mode(chatId)
    return mode === 'remote' || mode === 'host-offline' ? e.host.hostName(chatId) : null
  }
}

/** "Executar…" do visualizador: diálogo nativo + processos reais (fileRun.ts é sem Electron). */
function runDeps(): RunDeps {
  return {
    platform: process.platform,
    which: (cmd) => whichSync(cmd),
    systemRoot: process.env.SystemRoot,
    confirm: async ({ message, detail }) => {
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: 'Executar arquivo',
        message,
        detail,
        buttons: ['Cancelar', 'Executar'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      return r.response === 1
    },
    openPath: (p) => shell.openPath(p),
    spawn: spawnDetached,
    chmodX,
    log: (m) => console.log(`[clearchat] executar: ${m}`)
  }
}

export function registerIpc(): void {
  presetsRepo.seed()
  // ---- chamada de voz meia-duplex: o dono do turno no main + os overrides de request ----
  // (o renderer é o "sensor": captura/silêncio/reprodução — SPEC → "Chamada de voz (meia-duplex)")
  // decisões de preâmbulo também viram linhas no log de diagnóstico (`voice-eval/*.jsonl`)
  const evalLogger = createEvalLogger(app.getPath('userData'), (e) =>
    console.log('[clearchat] voice-eval:', e)
  )
  // custos/tempos da chamada: áudio GERADO na chamada (frases da resposta e frases de demora —
  // clipes pré-gerados não contam) — PCM em streaming pela taxa da utterance, WAV pelo cabeçalho
  const pcmRates = new Map<string, number>()
  const meterUtterance = (u: {
    id: string
    audio: Uint8Array
    mime: string
    kind?: string
  }): void => {
    if (!voiceCallsRef?.state().active || (u.kind && u.kind !== 'sentence' && u.kind !== 'delay'))
      return
    const ms = audioDurationMs(u.audio, u.mime)
    if (ms) voiceCallsRef.noteTtsAudio(ms)
    const rate = /^audio\/pcm/i.test(u.mime) ? Number(/rate=(\d+)/i.exec(u.mime)?.[1] ?? 24_000) : 0
    if (rate > 0) pcmRates.set(u.id, rate)
  }
  const meterChunk = (e: { id: string; pcm: Uint8Array; done: boolean }): void => {
    const rate = pcmRates.get(e.id)
    if (!rate) return
    if (e.pcm.length) voiceCallsRef?.noteTtsAudio(Math.round((e.pcm.length / 2 / rate) * 1000))
    if (e.done) pcmRates.delete(e.id)
  }
  const ttsRelay = new TtsStreamRelay({
    emitUtterance: (u) => {
      meterUtterance(u)
      sendToWindows(VOICE_CALL_UTTERANCE_CHANNEL, u)
    },
    emitChunk: (e) => {
      meterChunk(e)
      sendToWindows(VOICE_CALL_UTTERANCE_CHUNK_CHANNEL, e)
    },
    // stream de TTS que caiu no meio da sentença: a chamada decide (fatal encerra)
    onStreamError: (e) => void voiceCallsRef?.voiceApiError('tts', e)
  })
  ttsRelayRef = ttsRelay
  // ---- [tts-feed] ElevenLabs direta na chamada: WebSocket multi-contexto (texto em streaming) ----
  // opções lidas das settings com um cache curto (o feed é consultado a cada delta do LLM)
  let elevenOptsCache: { at: number; v: ReturnType<typeof elevenLabsCallOptions> } | null = null
  const elevenOpts = (): ReturnType<typeof elevenLabsCallOptions> => {
    const now = Date.now()
    if (!elevenOptsCache || now - elevenOptsCache.at > 1000)
      elevenOptsCache = { at: now, v: elevenLabsCallOptions(callVoiceSettings().tts) }
    return elevenOptsCache.v
  }
  const elevenCall = new ElevenLabsCallTts({
    config: elevenOpts,
    // instrumentação: 1º texto entregue → 1º áudio (log + timeline do painel da chamada)
    onLatency: (l) => {
      console.log(
        `[clearchat] tts elevenlabs-ws: ${l.contextId} 1º texto→1º áudio ${l.firstTextToAudioMs} ms` +
          (l.flushToAudioMs != null ? ` (flush→áudio ${l.flushToAudioMs} ms)` : '') +
          (l.turnMs != null ? ` · turno ${l.turnMs} ms` : '') +
          ` · ${l.chars} chars`
      )
      if (voiceCallsRef?.state().active)
        sendToWindows(VOICE_CALL_TIMELINE_CHANNEL, {
          ts: Date.now(),
          kind: 'tts-latency',
          latencyMs: l.turnMs ?? l.firstTextToAudioMs,
          reason: `elevenlabs-ws ${l.turnMs != null ? 'turno' : l.contextId}`
        })
    }
  })
  elevenCallRef = elevenCall
  // ---- [/tts-feed] ----
  const voiceCalls = new VoiceCallManager({
    sendTurn: (sessionId, text, meta) => {
      // mesmo caminho do composer (`agent.send` → gatedSend → runner.send; fila/⚡ respeitadas);
      // o `meta.voice` da fala vai junto da mensagem (gatedSend só leva texto)
      if (meta) runner.stashUserMeta(sessionId, text, meta)
      void gatedSend(sessionId, text, undefined, undefined).catch((e) =>
        voiceCalls.reportError(e instanceof Error ? e.message : String(e))
      )
    },
    // TTS por sentença: com endpoint que devolve PCM progressivo (OpenRouter/ElevenLabs) a
    // sentença começa a tocar com ~200 ms de áudio e o resto segue em `voice:call:utterance-chunk`
    // (`TtsStreamRelay`); motor local / wav / mp3 → bytes completos, como antes
    // [tts-feed] ElevenLabs direta com modelo de WebSocket → a fatia da sentença no áudio da
    // resposta (um contexto por resposta, repartido pelo alinhamento)
    synth: (text, signal) =>
      ttsRelay.synth(signal, async (s) =>
        elevenOpts()
          ? elevenCall.synth(text, s)
          : synthesizeStream(
              { text, settings: callVoiceSettings().tts },
              { local: ttsLocalEngine(), signal: s }
            )
      ),
    // frases de espera ("Só mais um instante…", "Obrigado por aguardar." sem clipe): mesma
    // voz/backend, request à parte com os bytes completos — a ElevenLabs vai pelo REST, nunca no contexto WS da resposta
    synthPhrase: (text, signal) =>
      synthesizeBlock(
        { text, settings: callVoiceSettings().tts },
        { local: ttsLocalEngine(), signal }
      ),
    ttsFeed: () => (elevenOpts() ? elevenCall : null),
    emitState: (state) => sendToWindows(VOICE_CALL_STATE_CHANNEL, state),
    emitUtterance: (u) => ttsRelay.emitUtterance(u),
    emitUtteranceCancel: (id) => sendToWindows(VOICE_CALL_UTTERANCE_CANCEL_CHANNEL, { id }),
    emitTimeline: (event) => sendToWindows(VOICE_CALL_TIMELINE_CHANNEL, event),
    logEval: (event) => evalLogger.log(event),
    clip: (cls, n) => {
      // só o cache em dia com a definição atual (pool de preâmbulos/frases/voz) — clipe velho não
      // toca; o cache é POR VOZ: a voz da persona/chat sem clipes gerados cai nas reservas de
      // sempre (frase de ferramenta → síntese ao vivo; preâmbulo → não toca)
      const v = callVoiceSettings()
      return loadCurrentClipAudio(
        app.getPath('userData'),
        v.tts,
        v.voiceCallDefaults.fillers.pool,
        cls,
        n,
        v.voiceCallDefaults.toolPhrases.pool,
        v.voiceCallDefaults.delayPhrases.thanksPool
      )
    },
    // turno continuado/barge-in: para o turno e deixa no histórico só o que foi falado
    amendTurn: async (sessionId, amend) => {
      await runner.amendVoiceTurn(sessionId, amend)
    },
    sessionInfo: (sessionId) => {
      const s = sessionsRepo.get(sessionId)
      return s ? { chatId: s.chatId, depth: s.depth, busy: isBusyStatus(s.status) } : null
    },
    chatConfig: (chatId) => chatsRepo.get(chatId)?.config ?? null,
    // camada da persona de origem (lida ao vivo): chat > persona > global
    personaVoice: (chatId) => {
      const presetId = chatsRepo.get(chatId)?.config.presetId
      return presetId ? (presetsRepo.get(presetId)?.config.voice ?? null) : null
    },
    // falhas de STT/TTS: fatal encerra a chamada com motivo legível (provedor pelo endpoint)
    classifyError: (e, source) => {
      const v = callVoiceSettings()
      const local = source === 'stt' ? v.stt.mode === 'local' : v.tts.backend === 'local'
      const onGpu = source === 'stt' ? v.stt.mode === 'gpu' : v.tts.backend === 'gpu'
      const base = source === 'stt' ? v.stt.api.baseUrl : v.tts.api.baseUrl
      return classifyVoiceError(e, source, onGpu ? 'GPU local' : voiceProviderLabel(base, local))
    },
    onCallEnded: () => {
      ttsRelay.abortAll()
      callVoice = null
    },
    // sem motor local configurado, o veredito do fim de turno sai pela API (lento)
    slowSpeculation: () => {
      const stt = callVoiceSettings().stt
      // GPU local: whisper em ~0,1 s — veredito rápido como o motor local
      return stt.mode !== 'local' && stt.mode !== 'gpu' && !stt.local
    },
    // a voz efetiva do chat da chamada (persona/chat ou a deste dispositivo — `callVoice`)
    settings: (chatId) => {
      const v = callVoiceSettings(chatId)
      return { defaults: v.voiceCallDefaults, audioInput: v.audioInput, stt: v.stt, tts: v.tts }
    },
    onEvent: (cb) => onAgentEvent(cb),
    // marcadores de início/fim da chamada no histórico (só exibição — nunca vão à API)
    appendMarker: (sessionId, content, meta) => {
      runner.appendDisplayMessage(sessionId, content, meta)
    },
    sessionMessages: (sessionId) => messagesRepo.path(sessionId),
    // preço de lista da voz (OpenRouter `/models`, já em cache pela tela de Áudio/início da chamada)
    ttsUnitPrice: () => {
      const api = callVoiceSettings().tts.api
      return api.providerId && api.model
        ? cachedVoiceUnitPrice('tts', api.providerId, api.model)
        : null
    }
  })
  voiceCallsRef = voiceCalls
  // custo da transcrição pela API (OpenRouter devolve `usage.cost`): soma na chamada ativa
  onSttApiUsage((u) => {
    if (voiceCalls.state().active) voiceCalls.noteSttApiUsage(u)
  })
  setVoiceCallSource((chat, session) => {
    const call = voiceCalls.callContextFor(chat, session)
    // "Modelo da chamada" com um provedor que não existe NESTE dispositivo (a config de voz
    // sincroniza desde o protocolo 1.5.0) vale como "sem modelo próprio": o turno usa o modelo do
    // chat — nunca falha a chamada nem cai noutro provedor (SYNC_PROTOCOL §4.3.2/§12)
    return call?.model && !providersRepo.get(call.model.providerId)
      ? { ...call, model: null }
      : call
  })
  // sonda o runtime local em segundo plano (processo do worker + onnxruntime + espeak-ng): o
  // "pronto" dos canais já sai com o binding real; ninguém espera por isto aqui
  void probeWhisperRuntime().then((r) => {
    if (!r.available) console.warn(`[clearchat] STT local indisponível: ${r.reason}`)
  })
  // modo GPU: gerenciador + resolvedor do endpoint usado por `voice/tts.ts` (backend 'gpu')
  const gpu = (gpuManagerRef ??= createGpuManager())
  setGpuEndpointResolver(gpu)
  const handlers: Record<string, Handler> = {
    // ---- providers ----
    [IPC.providers.list]: () => providersRepo.list(),
    [IPC.providers.create]: (p: ProviderInput) => providersRepo.create(p),
    [IPC.providers.update]: (id: string, patch: ProviderPatch) => {
      invalidateModels(id)
      return providersRepo.update(id, patch ?? {})
    },
    [IPC.providers.delete]: (id: string) => {
      invalidateModels(id)
      providersRepo.delete(id)
    },
    [IPC.providers.listModels]: async (providerId: string) => {
      const p = providersRepo.get(providerId)
      if (!p) throw new Error('Provider não encontrado.')
      return listModels(p)
    },
    [IPC.providers.test]: (p: ProviderTestInput) => testProvider(p),

    // ---- settings ----
    // (as chaves de API dos buscadores não passam por aqui: só pelo domínio webSearch, mascaradas)
    [IPC.settings.get]: (key: string) => {
      if (PROTECTED_SETTINGS.includes(key)) throw new Error('Setting protegido.')
      return settingsRepo.get(key)
    },
    [IPC.settings.set]: (key: string, value: unknown) => {
      if (PROTECTED_SETTINGS.includes(key)) throw new Error('Setting protegido.')
      return settingsRepo.set(key, value)
    },

    // ---- chats ----
    // chats só ao vivo de outros dispositivos abertos aqui (só memória, §23.5) entram na lista
    [IPC.chats.list]: () => [...chatsRepo.list(), ...(syncEngine()?.liveViewer.openChats() ?? [])],
    [IPC.chats.get]: (id: string) => chatsRepo.get(id) ?? syncEngine()?.liveViewer.chat(id) ?? null,
    [IPC.chats.create]: (input: ChatCreateInput) => {
      const e = syncEngine()
      const requested =
        input?.storage === 'live' || input?.storage === 'online' ? input.storage : null
      // §23.1: o modo é gravado em todo chat novo (sem login também); a escolha vira o padrão
      const storage = e ? e.live.resolveNew(requested) : 'online'
      if (e && requested && e.live.supported()) e.live.rememberChoice(requested)
      const { chat, session } = chatsRepo.create({ title: input?.title, config: input?.config })
      if (e && storage !== 'online') {
        e.live.setStorage(chat.id, storage)
        e.live.schedule(chat.id, true)
      }
      emit({ type: 'session-created', session })
      emit({ type: 'chat-updated', chat })
      if (e) emit({ type: 'sync-chat-state', info: e.chatInfo(chat.id) })
      return chat
    },
    [IPC.chats.update]: async (id: string, patch: ChatUpdateInput): Promise<Chat> => {
      const e = syncEngine()
      // chat ao vivo de outro dispositivo: o host aplica (chat.update, §23.7)
      if (e?.host.isViewerChat(id)) {
        if (e.host.mode(id) !== 'remote') throw new Error(`Reconectando a ${e.host.hostName(id)}…`)
        await e.liveViewer.updateChat(id, patch ?? {})
        const cur = e.liveViewer.chat(id)
        if (!cur) throw new Error('Chat ao vivo indisponível.')
        return {
          ...cur,
          ...(patch?.title !== undefined ? { title: patch.title } : {}),
          config: { ...cur.config, ...(patch?.config ?? {}) }
        }
      }
      const { chat, modelChanged } = chatsRepo.update(id, patch ?? {})
      // raiz escolhida neste dispositivo (chat vindo de outro): não pergunta mais ao virar host
      if (patch?.config?.cwd) syncEngine()?.setChatRow(id, { cwd_confirmed: 1 })
      if (modelChanged && chat.mainSessionId) {
        const s = sessionsRepo.setModel(chat.mainSessionId, chat.config.model)
        if (s) emit({ type: 'session-updated', session: s })
      }
      emit({ type: 'chat-updated', chat })
      return chat
    },
    [IPC.chats.delete]: async (id: string) => {
      const e = syncEngine()
      if (e?.host.isViewerChat(id))
        throw new Error('Um chat só ao vivo só pode ser apagado no dispositivo que o guarda.')
      // chat só ao vivo deste dispositivo: some dos outros na hora (§23.9)
      if (e?.live.isLive(id)) {
        e.live.withdraw([id], 'deleted')
        e.live.forget(id)
      }
      if (e?.active && e.host.mode(id) === 'remote' && e.chatInfo(id).running)
        throw new Error(
          `O chat está rodando em ${e.host.hostName(id)} — pare o turno antes de apagá-lo.`
        )
      await runner.stopChat(id)
      await stopChatProcesses(id)
      chatsRepo.delete(id)
      removeChatToolOutputs(id)
    },
    // título automático: local (usa a config e o provedor deste dispositivo); o título sincroniza
    [IPC.chats.generateTitle]: (id: string) => {
      if (syncEngine()?.host.isViewerChat(id))
        throw new Error('Gere o título no dispositivo que guarda este chat ao vivo.')
      return generateTitleNow(id)
    },

    // ---- sessions ----
    // chat executado em outro dispositivo: o status ao vivo (o banco guarda `running` como
    // interrupted — §4.3.7); sem isso, abrir/voltar ao chat no meio do turno o mostrava parado
    [IPC.sessions.list]: (chatId: string) => {
      const e = syncEngine()
      const list = e?.host.isViewerChat(chatId)
        ? e.liveViewer.sessions(chatId)
        : sessionsRepo.list(chatId)
      const host = e?.host
      return host ? list.map((s) => host.displaySession(s)) : list
    },
    [IPC.sessions.messages]: (sessionId: string) => {
      const v = syncEngine()?.liveViewer
      if (v?.chatOfSession(sessionId) && !sessionsRepo.get(sessionId)) return v.messages(sessionId)
      return messagesRepo.listAll(sessionId)
    },

    // ---- messages ----
    [IPC.messages.update]: (id: string, message: ApiMessage) => {
      const msg = validateMessage(message)
      // mensagem digitada da principal: editar = nova versão (agent.editBranch), nunca no lugar
      const cur = messagesRepo.get(id)
      const owner = cur && sessionsRepo.get(cur.sessionId)
      if (cur && owner && isBranchEditable(cur, owner.depth))
        throw new Error(
          'Mensagens suas na conversa principal não são editadas no lugar: a edição vira uma nova versão (use “Editar” na mensagem).'
        )
      const local = (): ReturnType<typeof messagesRepo.update> => {
        const m = messagesRepo.update(id, msg)
        emit({ type: 'message-updated', message: m })
        return m
      }
      return gateChat(chatOfMessage(id), 'message.edit', { messageId: id, message: msg }, local, {
        purpose: 'edit',
        remote: () => ({
          ...(messagesRepo.get(id) ?? syncEngine()?.liveViewer.message(id))!,
          message: msg
        })
      })
    },
    [IPC.messages.delete]: (id: string) =>
      gateChat(
        chatOfMessage(id),
        'message.delete',
        { messageId: id },
        () => runner.deleteMessage(id),
        {
          purpose: 'edit'
        }
      ),

    // ---- agent ----
    [IPC.agent.send]: (
      sessionId: string,
      text: string,
      attachments?: AttachmentInfo[],
      skills?: string[],
      opts?: { voice?: unknown }
    ) => {
      // texto ditado no composer: `meta.voice` (só ditado é aceito do renderer)
      const voice = sanitizeDictationMeta(opts?.voice)
      if (voice && typeof sessionId === 'string' && typeof text === 'string')
        runner.stashUserMeta(sessionId, text, { voice })
      return gatedSend(sessionId, text, attachments, skills)
    },
    [IPC.agent.forceSend]: (queuedId: string) =>
      gateById(
        (e) => e.host.findQueued(queuedId)?.chatId ?? null,
        'queue.force',
        { queuedId },
        () => runner.forceSend(queuedId)
      ),
    [IPC.agent.removeQueued]: (queuedId: string) =>
      gateById(
        (e) => e.host.findQueued(queuedId)?.chatId ?? null,
        'queue.remove',
        { queuedId },
        () => runner.removeQueued(queuedId)
      ),
    [IPC.agent.getQueue]: (sessionId: string) =>
      syncEngine()?.host.mirrorQueue(sessionId) ?? runner.getQueue(sessionId),
    [IPC.agent.stop]: (sessionId: string) =>
      gateChat(chatOfSession(sessionId), 'stop', { sessionId }, () => runner.stop(sessionId), {
        content: false
      }),
    [IPC.agent.regenerate]: (sessionId: string, messageId?: string) =>
      gateChat(
        chatOfSession(sessionId),
        'branch.regenerate',
        { sessionId, ...(messageId ? { messageId } : {}) },
        () => runner.regenerate(sessionId, messageId || undefined),
        { purpose: 'run' }
      ),
    [IPC.agent.editBranch]: (messageId: string, message: ApiMessage) => {
      const msg = validateMessage(message)
      return gateChat(
        chatOfMessage(messageId),
        'branch.edit',
        { messageId, message: msg },
        () => runner.editBranch(messageId, msg),
        { purpose: 'run' }
      )
    },
    [IPC.agent.selectBranch]: (messageId: string) =>
      gateChat(
        chatOfMessage(messageId),
        'branch.select',
        { messageId },
        () => runner.selectBranch(messageId),
        {
          purpose: 'edit',
          // controle remoto: quem grava é o host; devolve a seleção esperada (o sync traz a real)
          remote: () => {
            const v = syncEngine()?.liveViewer
            const m = messagesRepo.get(messageId) ?? v?.message(messageId) ?? null
            const s =
              (m && sessionsRepo.get(m.sessionId)) ||
              (m && v
                ? (v
                    .sessions(v.chatOfSession(m.sessionId) ?? '')
                    .find((x) => x.id === m.sessionId) ?? null)
                : null)
            if (!m || !s) throw new Error('Mensagem não encontrada.')
            const all = sessionsRepo.get(s.id)
              ? messagesRepo.listAll(s.id)
              : (v?.sessionMessages(s.id) ?? [])
            return { ...s, branchSel: pruneSel(all, selectionToReach(all, s.branchSel, m.id)) }
          }
        }
      ),
    [IPC.agent.approve]: (
      requestId: string,
      decision: ApprovalDecision,
      items?: ApprovalItemDecision[]
    ) =>
      gateById(
        (e) => e.host.findApproval(requestId),
        'approval',
        { requestId, decision, ...(items?.length ? { items } : {}) },
        () => runner.approve(requestId, decision, items)
      ),
    [IPC.agent.pendingApprovals]: () => [
      ...runner.pendingApprovals(),
      ...(syncEngine()?.host.mirrorApprovals() ?? [])
    ],
    [IPC.agent.previewRequest]: (sessionId: string) => runner.previewRequest(sessionId),
    [IPC.agent.runningSessions]: () => [
      ...new Set([...runner.runningSessions(), ...(syncEngine()?.host.mirrorRunning() ?? [])])
    ],
    [IPC.agent.compact]: (sessionId: string, opts?: CompactOptions) =>
      gateChat(
        chatOfSession(sessionId),
        'compact',
        { sessionId, ...(opts ? { opts } : {}) },
        () => runner.compact(sessionId, opts ?? {}),
        { remote: (r) => ({ scheduled: !!r.queued }) }
      ),
    [IPC.agent.stopSubagents]: (chatId: string) =>
      gateChat(chatId, 'stop_subagents', {}, () => runner.stopSubagents(chatId), {
        content: false
      }),
    [IPC.agent.smartOverride]: (messageId: string) =>
      gateChat(chatOfMessage(messageId), 'smart_override', { messageId }, () =>
        runner.smartOverride(messageId)
      ),
    [IPC.agent.smartApproveTest]: (input: SmartApproveTestInput) => runner.smartApproveTest(input),
    [IPC.agent.setCapturedContext]: (chatId: string, sessionId: string | null, text: string) =>
      runner.setCapturedContext(chatId, sessionId ?? null, String(text ?? '')),
    [IPC.agent.undoCapturedContext]: (chatId: string, sessionId: string | null) =>
      runner.undoCapturedContext(chatId, sessionId ?? null),

    // ---- aprovações (modos globais + listas) ----
    [IPC.approvals.getSettings]: () => getApprovalSettings(),
    [IPC.approvals.updateSettings]: (patch: Partial<ApprovalSettings>) =>
      updateApprovalSettings(patch ?? {}),

    // ---- buscadores do web_search ----
    [IPC.webSearch.getSettings]: () => getWebSearchSettings(),
    [IPC.webSearch.updateEngines]: (engines: EngineConfig[]) => updateWebSearchEngines(engines),
    [IPC.webSearch.setKey]: (engine: SearchEngineId, key: string | null) =>
      setWebSearchKey(engine, key),
    [IPC.webSearch.revealKey]: (engine: SearchEngineId) => revealWebSearchKey(engine),
    [IPC.webSearch.test]: (engine: SearchEngineId) => testWebSearchEngine(engine),

    // ---- skills (SPEC → Skills) ----
    [IPC.skills.getSettings]: () => skills.getSkillsSettings(),
    [IPC.skills.updateSettings]: (patch: Partial<SkillsSettings>) => {
      const next = skills.updateSkillsSettings(patch ?? {})
      emit({ type: 'skills-changed' })
      return next
    },
    [IPC.skills.discover]: async (opts?: SkillsDiscoverOptions) => {
      const r = await skills.discover(opts ?? {})
      if (opts?.rescan) emit({ type: 'skills-changed' })
      return r
    },
    [IPC.skills.read]: async (file: string) => {
      if (typeof file !== 'string' || basename(file) !== 'SKILL.md')
        throw new Error('Só arquivos SKILL.md.')
      return readFileAsync(file, 'utf8')
    },
    [IPC.skills.pickFolder]: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Escolher pasta de skills',
        properties: ['openDirectory', 'createDirectory', 'showHiddenFiles']
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    },
    [IPC.skills.openFolder]: async (path: string) => {
      const err = await shell.openPath(skills.resolveLocationPath(String(path ?? '')))
      if (err) throw new Error(err)
    },

    // ---- fs ----
    [IPC.fs.listDir]: (path: string) => fsapi.listDir(path),
    [IPC.fs.readFile]: (path: string) => fsapi.readFile(path),
    [IPC.fs.pickDirectory]: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Escolher diretório raiz',
        properties: ['openDirectory', 'createDirectory']
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
    },
    [IPC.fs.homeDir]: () => fsapi.homeDir(),
    [IPC.fs.mkdir]: (path: string) => fsapi.mkdir(path),

    // ---- visualizador de arquivos (só a allowlist do main; ver fileViewer.ts) ----
    [IPC.viewer.open]: (target: ViewerTarget) => openViewerFile(target, viewerDeps),
    [IPC.viewer.check]: (chatId: string, messageId: string) =>
      checkPresented(chatId, messageId, viewerDeps),
    [IPC.viewer.readText]: (token: string) => readViewerText(token),
    [IPC.viewer.openExternal]: async (token: string) => {
      const file = grantedPath(token)
      // executável (deste sistema ou de outro) nunca abre direto: "Executar…" pede confirmação
      await assertCanOpenLocal(file, process.platform)
      const err = await shell.openPath(file)
      if (err) throw new Error(err)
    },
    [IPC.viewer.showInFolder]: (token: string) => shell.showItemInFolder(grantedPath(token)),
    // arquivo buscado de outro dispositivo (controle remoto): bytes vêm do renderer
    [IPC.viewer.saveBytes]: async (name: string, bytes: Uint8Array): Promise<boolean> => {
      const buf = checkedBytes(bytes)
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.SaveDialogOptions = {
        title: 'Salvar como',
        defaultPath: join(app.getPath('downloads'), safeFileName(name))
      }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return false
      await writeFileAsync(r.filePath, buf)
      return true
    },
    [IPC.viewer.openBytes]: async (name: string, bytes: Uint8Array) => {
      const err = await shell.openPath(writeViewerTemp(name, bytes))
      if (err) throw new Error(err)
    },
    // "Executar…": o main reclassifica e confirma; só token concedido / chat em controle remoto
    [IPC.viewer.run]: (token: string) => runGrantedFile(token, runDeps()),
    [IPC.viewer.runBytes]: (chatId: string, name: string, bytes: Uint8Array) =>
      runRemoteBytes(
        name,
        bytes,
        typeof chatId === 'string' ? viewerDeps.remoteHost(chatId) : null,
        runDeps()
      ),

    // ---- anexos ----
    [IPC.attachments.pick]: async (): Promise<AttachmentPickResult> => {
      const win = BrowserWindow.getFocusedWindow()
      const opts: Electron.OpenDialogOptions = {
        title: 'Anexar arquivos',
        properties: ['openFile', 'multiSelections']
      }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const out: AttachmentPickResult = { items: [], errors: [] }
      if (r.canceled) return out
      for (const path of r.filePaths) {
        const name = basename(path)
        try {
          const st = await stat(path)
          if (!st.isFile()) throw new Error(`"${name}" não é um arquivo.`)
          if (st.size > ATTACHMENT_LIMITS.maxFileBytes)
            throw new Error(
              `"${name}" tem ${formatSize(st.size)} — o limite por arquivo é ${formatSize(ATTACHMENT_LIMITS.maxFileBytes)}.`
            )
          out.items.push(saveAttachment({ name, data: await readFileAsync(path) }))
        } catch (e) {
          out.errors.push((e as Error).message)
        }
      }
      return out
    },
    [IPC.attachments.add]: (input: AttachmentAddInput) => {
      if (!input || !(input.data instanceof Uint8Array)) throw new Error('Arquivo inválido.')
      return saveAttachment(input)
    },

    // ---- app ----
    [IPC.app.capabilities]: (): AppCapabilities => ({
      bwrap: bwrapAvailable(),
      ripgrep: ripgrepAvailable(),
      shell: shellInfoLite(),
      platform: process.platform
    }),

    // ---- atualizações (só aviso; nada é baixado) ----
    [IPC.updates.status]: (): UpdateStatus =>
      updateChecker()?.status() ?? { current: app.getVersion(), state: 'idle' },
    [IPC.updates.check]: (): Promise<UpdateStatus> | UpdateStatus =>
      updateChecker()?.check() ?? { current: app.getVersion(), state: 'idle' },
    [IPC.updates.openRelease]: async () => {
      // a URL vem do main (resposta do GitHub já validada), nunca do renderer
      const url = updateChecker()?.status().latest?.url
      await shell.openExternal(isReleaseUrl(url) ? url : RELEASES_PAGE)
    },

    // ---- questionários (ask_user) ----
    [IPC.questions.answer]: (id: string, answers: unknown) =>
      gateById(
        (e) => e.host.findQuestion(id),
        'question',
        { requestId: id, answers: answers as QuestionAnswer[] },
        () => answerQuestion(id, answers)
      ),
    [IPC.questions.cancel]: (id: string) =>
      gateById(
        (e) => e.host.findQuestion(id),
        'question',
        { requestId: id, cancel: true },
        () => runner.cancelQuestionRequest(id)
      ),
    [IPC.questions.pending]: () => [
      ...runner.pendingQuestions(),
      ...(syncEngine()?.host.mirrorQuestions() ?? [])
    ],

    // ---- falha de conexão com o provedor (Tentar de novo / Cancelar) ----
    [IPC.retries.retry]: (id: string) =>
      gateById(
        (e) => e.host.findRetry(id),
        'retry',
        { requestId: id, action: 'retry' },
        () => runner.retryRequest(id)
      ),
    [IPC.retries.cancel]: (id: string) =>
      gateById(
        (e) => e.host.findRetry(id),
        'retry',
        { requestId: id, action: 'cancel' },
        () => runner.cancelRetryRequest(id)
      ),
    [IPC.retries.pending]: () => [
      ...runner.pendingRetries(),
      ...(syncEngine()?.host.mirrorRetries() ?? [])
    ],

    // ---- processos em segundo plano (process_start) ----
    [IPC.processes.list]: (chatId: string) =>
      syncEngine()?.host.mirrorProcesses(chatId) ?? listProcesses(chatId),
    [IPC.processes.stop]: async (chatId: string, id: string) => {
      remoteProcessGuard(chatId)
      await stopProcess(chatId, id, 'SIGTERM')
    },
    [IPC.processes.logs]: (chatId: string, id: string, tail?: number) => {
      remoteProcessGuard(chatId)
      return processLogLines(chatId, id, tail)
    },

    // ---- presets (personas) ----
    [IPC.presets.list]: () => presetsRepo.list(),
    [IPC.presets.create]: (input: PresetInput) => presetsRepo.create(input),
    [IPC.presets.update]: (id: string, patch: PresetPatch) => presetsRepo.update(id, patch ?? {}),
    [IPC.presets.delete]: (id: string) => presetsRepo.delete(id),
    [IPC.presets.duplicate]: (id: string) => presetsRepo.duplicate(id),
    // ---- memória (SPEC → Memória) ----
    [IPC.memory.listCollections]: () => memory.listCollections(),
    [IPC.memory.createCollection]: (input: MemoryCollectionInput) => memory.createCollection(input),
    [IPC.memory.updateCollection]: (id: string, patch: MemoryCollectionPatch) =>
      memory.updateCollection(id, patch ?? {}),
    [IPC.memory.deleteCollection]: (id: string) => memory.deleteCollection(id),
    [IPC.memory.list]: (query?: MemoryListQuery) => memory.listMemories(query),
    [IPC.memory.create]: (input: MemoryInput) => memory.createMemory(input),
    [IPC.memory.update]: (id: string, patch: MemoryPatch) => memory.updateMemory(id, patch ?? {}),
    [IPC.memory.delete]: (id: string) => memory.deleteMemory(id),
    [IPC.memory.preview]: (sessionId: string) => memory.previewMemory(sessionId),
    [IPC.memory.refreshSnapshot]: (sessionId: string) => memory.refreshSnapshot(sessionId),
    [IPC.memory.extractNow]: (sessionId: string) =>
      gateChat(
        chatOfSession(sessionId),
        'memory.extract',
        { sessionId },
        () => memory.extractNow(sessionId),
        {
          remote: () => ({
            created: 0,
            updated: 0,
            deleted: 0,
            changes: [],
            error: 'A extração roda no host; o resultado aparece no chat quando terminar.'
          })
        }
      ),
    // ---- voz: settings de áudio + sessão de transcrição (SPEC → "Áudio") ----
    // (stt/tts guardam só provedor/modelo/voz: a chave do provedor fica no main — `getVoiceSettings`)
    [IPC.voice.settingsGet]: () => getVoiceSettingsView(),
    [IPC.voice.settingsSet]: (kind: VoiceSettingKind, value: unknown) => {
      const saved = setVoiceSetting(kind, value)
      // modo GPU: nada mais escolhido → os processos do servidor saem (VRAM de volta) — menos com
      // uma chamada em andamento na GPU (a voz da persona/chat pode usá-la mesmo sem a daqui)
      const inCall = voiceCalls.state().active && gpu.selectedEngines(callVoiceSettings()).length
      if ((kind === 'ttsSettings' || kind === 'sttSettings') && !inCall)
        void gpu.onSettingsChanged()
      return saved
    },
    [IPC.voice.transcribeStart]: async (language?: string, opts?: { voice?: unknown }) => {
      const owner = ipcSenderId // antes de qualquer await
      // transcrição POR CHAT (protocolo 1.9.0): a fala da chamada usa a voz decidida no início
      // dela; o ditado do composer resolve a das camadas do chat (indisponível aqui → a daqui)
      const inCall = voiceCalls.state().active && owner !== null && owner === voiceCallOwner
      const use =
        inCall && callVoice
          ? { stt: callVoice.stt, language: callVoice.language }
          : opts?.voice
            ? voiceUse(await resolveVoiceFor(voiceLayersFrom(opts.voice)))
            : { stt: null, language: null }
      const v = getVoiceSettingsWith({ stt: use.stt })
      const lang =
        use.language ||
        (typeof language === 'string' && language.trim() ? language : v.audioInput.language)
      const gpuMode = v.stt.mode === 'gpu'
      const [models, gpuReady] = await Promise.all([
        listLocalModels(localModelsBaseDir()),
        gpuMode ? gpu.sttReady() : false,
        // "pronto" = modelo instalado + binding que carrega de verdade (probe memoizado)
        v.stt.mode !== 'api' && !gpuMode ? probeWhisperRuntime() : null
      ])
      return startTranscribeSession(
        // nível de ativação do microfone (local do dispositivo): o portão de fala da sessão
        { settings: v.stt, language: lang, activationDb: v.audioInput.activationDb },
        {
          // modo GPU: o whisper do servidor local entra como o motor "local" da sessão
          ...(gpuMode ? { local: gpu.sttBackend(gpuReady) } : {}),
          // coerência installed/hasLocalReady: a presença real de modelo instalado vem do disco
          hasLocalReady: gpuMode ? gpuReady : deriveHasLocalReady(v.stt.local, models),
          onPartial: (e) => sendToWindows(VOICE_PARTIAL_CHANNEL, e),
          // erro fatal de parcial/segmento/especulação na chamada: encerra já (a final falharia)
          onError: (e) => {
            if (voiceCalls.state().active && owner !== null && owner === voiceCallOwner)
              voiceCalls.voiceApiError('stt', e)
          },
          ownerId: owner ?? undefined
        }
      ).id
    },
    [IPC.voice.transcribePush]: (sessionId: string, pcm16: Uint8Array, sampleRate?: number) => {
      requireTranscribeSession(sessionId).push(pcm16, sampleRate)
    },
    [IPC.voice.transcribeStop]: (
      sessionId: string,
      opts?: { reuseSpeculative?: boolean; reusePartial?: boolean }
    ) => {
      const owner = ipcSenderId
      const ts = requireTranscribeSession(sessionId)
      const audioMs = ts.audioMs
      return ts
        .stop({
          reuseSpeculative: opts?.reuseSpeculative === true,
          // a chamada sempre pede; o ditado segue a setting (padrão ligado)
          reusePartial:
            typeof opts?.reusePartial === 'boolean'
              ? opts.reusePartial
              : getVoiceSettings().stt.reusePartialFinal !== false
        })
        .then((r) => {
          // a final da fala da chamada: duração/modelo no `meta.voice` do turno e nos custos
          if (voiceCalls.state().active && owner !== null && owner === voiceCallOwner)
            voiceCalls.noteTranscript({
              text: r.text,
              model: r.model,
              backend: r.backend,
              audioMs: audioMs ?? 0
            })
          return r
        })
        .catch((e: unknown) => {
          // a final da chamada falhou (a sessão já repetiu a transitória uma vez): encerra
          if (voiceCalls.state().active && owner !== null && owner === voiceCallOwner)
            voiceCalls.voiceApiError('stt', e, { retried: true })
          throw e
        })
    },
    // fim de turno adaptativo: transcrição especulativa (API só com `turn.speculativeApi`)
    [IPC.voice.transcribeSpeculate]: (sessionId: string) =>
      requireTranscribeSession(sessionId).speculate({
        // pela API com a opção explícita OU com as parciais ao vivo ligadas (já sobem o áudio a
        // cada ~1 s; a especulação reaproveitada vira a final — no caso comum não custa nada a
        // mais e a transcrição sai ~1 s antes)
        allowApi: (() => {
          const v = getVoiceSettings()
          return v.voiceCallDefaults.turn.speculativeApi || v.stt.livePartials
        })()
      }),
    // cancel é tolerante: encerrar uma sessão que já saiu (corrida com o fim natural) não é erro;
    // vale também para a sessão que está transcrevendo a final (aborta a final)
    [IPC.voice.transcribeCancel]: (sessionId: string) => {
      if (typeof sessionId === 'string') findTranscribeSession(sessionId)?.cancel()
    },
    // ---- modelos locais (catálogo + download/estado em disco) ----
    [IPC.voice.modelsList]: async (): Promise<VoiceModelInfo[]> =>
      // aposentados (voz lenta demais para chamada) só aparecem enquanto há arquivo para remover
      (await listLocalModels(localModelsBaseDir())).filter(isListedLocalModel).map(toModelView),
    [IPC.voice.modelsDownload]: async (input: { id: string }): Promise<VoiceModelInfo | null> => {
      const id = requireModelId(input)
      if (localDownloads.has(id)) throw new Error(`download já em andamento para ${id}`)
      const controller = new AbortController()
      localDownloads.set(id, controller)
      const emitProgress = (bytes: number, total: number): void => {
        const now = Date.now()
        const last = lastProgressAt.get(id) ?? 0
        if (bytes < total && now - last < PROGRESS_MIN_MS) return
        lastProgressAt.set(id, now)
        sendToWindows(VOICE_MODELS_PROGRESS_CHANNEL, { id, bytes, total })
      }
      try {
        const info = await downloadLocalModel(localModelsBaseDir(), id, {
          signal: controller.signal,
          onProgress: emitProgress
        })
        emitProgress(info.installedBytes ?? info.entry.sizeBytes, info.entry.sizeBytes)
        syncLocalModelInstalled(info.entry, true)
        return toModelView(info)
      } catch (e) {
        // cancelado pelo usuário (abort limpa o `.part` no gerenciador) → null, não é erro
        if (controller.signal.aborted) return null
        throw e
      } finally {
        localDownloads.delete(id)
        lastProgressAt.delete(id)
      }
    },
    // cancel é tolerante: id desconhecido/já encerrado = sem efeito (o gerenciador limpa o `.part`)
    [IPC.voice.modelsCancel]: (input: { id: string }): void => {
      localDownloads.get(requireModelId(input))?.abort()
    },
    [IPC.voice.modelsRemove]: async (input: { id: string }): Promise<void> => {
      const id = requireModelId(input)
      const entry = findCatalogEntry(id)
      // solta o modelo carregado antes de apagar o arquivo (RAM de volta; nada lendo o arquivo)
      const before = (await listLocalModels(localModelsBaseDir())).find((m) => m.entry.id === id)
      if (entry?.kind === 'stt') releaseSttModel(before?.path ?? undefined)
      if (entry?.engine === 'kokoro' && kokoro) {
        const k = kokoro
        kokoro = null
        await k.release()
      }
      await removeLocalModel(localModelsBaseDir(), id)
      if (entry) syncLocalModelInstalled(entry, false)
    },

    // ---- TTS: síntese de fala + clipes dos preâmbulos ----
    // (a `apiKey` do endpoint de síntese fica no main — os handlers usam `getVoiceSettings()`)
    [IPC.voice.ttsSynth]: (input: { text: string; format?: 'wav' | 'mp3' }) => {
      const text = input && typeof input.text === 'string' ? input.text : ''
      if (!text.trim()) throw new Error('Texto para a síntese de fala está vazio.')
      return synthesize(
        {
          text,
          settings: getVoiceSettings().tts,
          format: input.format === 'mp3' ? 'mp3' : 'wav'
        },
        { local: ttsLocalEngine() }
      )
    },
    [IPC.voice.ttsTest]: (input?: {
      voice?: unknown
      model?: unknown
      text?: unknown
      tts?: unknown
    }) => {
      // overrides só deste teste (▶ prévia de uma voz/modelo ainda não escolhidos no seletor)
      const clip = (v: unknown): string | null =>
        typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null
      // `tts` = a voz de uma persona/chat (prévias do editor da persona) em vez da deste dispositivo
      const saved = getVoiceSettingsWith({ tts: normalizeVoiceTtsChoice(input?.tts) }).tts
      const voice = clip(input?.voice)
      const model = clip(input?.model)
      const settings =
        saved.backend === 'gpu'
          ? {
              ...saved,
              gpu: {
                ...(saved.gpu ?? { engine: 'omnivoice' as const, voice: null }),
                ...(voice ? { voice } : {}),
                ...(isGpuTtsEngineId(model) ? { engine: model } : {})
              }
            }
          : saved.backend === 'api'
            ? {
                ...saved,
                api: {
                  ...saved.api,
                  voice: voice ?? saved.api.voice,
                  model: model ?? saved.api.model
                }
              }
            : saved.local && voice
              ? { ...saved, local: { ...saved.local, voice } }
              : saved
      return synthesize(
        { text: clip(input?.text) ?? TTS_TEST_PHRASE, settings, format: 'wav' },
        { local: ttsLocalEngine() }
      )
    },
    // descoberta de modelos/vozes por provedor (a chave fica no main — nunca na visão)
    [IPC.voice.catalogList]: (input: VoiceCatalogRequest) =>
      listVoiceCatalog(
        {
          capability: input?.capability === 'stt' ? 'stt' : 'tts',
          providerId: typeof input?.providerId === 'string' ? input.providerId : '',
          refresh: input?.refresh === true
        },
        { provider: (id) => providersRepo.get(id) }
      ),
    [IPC.voice.catalogPreview]: (input: { url: string }) =>
      fetchVoicePreview(typeof input?.url === 'string' ? input.url : ''),
    // `input.tts` = a voz de uma persona/chat ("Gerar clipes desta voz" — só com o clique do
    // usuário: nunca gerados sozinhos, uma API paga custa por clipe); ausente = a deste dispositivo
    [IPC.voice.ttsClipsGenerate]: async (input?: { tts?: unknown }): Promise<TtsClipsView> => {
      const v = getVoiceSettingsWith({ tts: normalizeVoiceTtsChoice(input?.tts) })
      const manifest = await generateClips({
        baseDir: app.getPath('userData'),
        settings: v.tts,
        fillerPool: v.voiceCallDefaults.fillers.pool,
        toolPool: v.voiceCallDefaults.toolPhrases.pool,
        thanksPool: v.voiceCallDefaults.delayPhrases.thanksPool,
        local: ttsLocalEngine(),
        onProgress: (e) => sendToWindows(VOICE_TTS_CLIPS_PROGRESS_CHANNEL, e)
      })
      return toClipsView(manifest)
    },
    [IPC.voice.ttsClipsList]: async (input?: { tts?: unknown }): Promise<TtsClipsView | null> => {
      const v = getVoiceSettingsWith({ tts: normalizeVoiceTtsChoice(input?.tts) })
      const m = await loadClips(app.getPath('userData'), clipVoiceId(v.tts))
      if (!m) return null
      // cache de uma definição antiga (frases/pool mudaram): "stale" → a UI pede para regerar; as
      // classes velhas vão em `staleClasses` (as outras continuam tocando — ex.: cache só de
      // preâmbulos, de antes das frases de ferramenta)
      const staleClasses = await clipStaleClasses(
        m,
        v.tts,
        v.voiceCallDefaults.fillers.pool,
        v.voiceCallDefaults.toolPhrases.pool,
        v.voiceCallDefaults.delayPhrases.thanksPool
      )
      return {
        ...toClipsView(m),
        ...(staleClasses.length ? { stale: true, staleClasses } : {})
      }
    },
    [IPC.voice.ttsVoices]: async (): Promise<TtsVoicesView> => {
      const v = getVoiceSettings().tts
      // chatterbox: motor ainda sem runtime nesta versão (a lista fica vazia na UI)
      if (v.local?.engine === 'chatterbox') return { local: [], api: TTS_API_VOICES }
      const local = await ttsLocalEngine().voices()
      return {
        local: local.map((x) => ({ ...x, engine: 'kokoro' as const })),
        api: TTS_API_VOICES
      }
    },

    // ---- chamada de voz (meia-duplex) — SPEC → "Áudio → Chamada de voz (meia-duplex)" ----
    [IPC.voice.callStart]: async (input: { sessionId: string }) => {
      const sessionId = input && typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
      if (!sessionId) throw new Error('Sessão não informada (esperado { sessionId }).')
      const owner = ipcSenderId
      // voz da chamada (protocolo 1.9.0): a da persona/chat quando disponível AQUI, senão a deste
      // dispositivo — decidida agora e mantida até o fim da chamada; nenhuma das duas funciona →
      // recusa com o motivo (a pré-checagem do renderer já esmaece o telefone)
      const startChatId = sessionsRepo.get(sessionId)?.chatId ?? null
      const res = startChatId ? await resolveVoiceFor(chatVoiceLayers(startChatId)) : null
      const problems = res
        ? [
            !res.stt.available && `Transcrição: ${res.stt.reason ?? 'não configurada'}.`,
            !res.tts.available && `Fala: ${res.tts.reason ?? 'não configurada'}.`
          ].filter((x): x is string => !!x)
        : []
      if (problems.length)
        throw new Error(`Chamada de voz indisponível neste dispositivo — ${problems.join(' ')}`)
      const use = res ? voiceUse(res) : { tts: null, stt: null, language: null }
      const effective = getVoiceSettingsWith(use)
      // modo GPU: os motores já estão carregados? (senão a chamada entra em "Preparando a GPU…")
      const gpuEngines = gpu.selectedEngines(effective)
      const gpuWarm = gpuEngines.length ? await gpu.isWarm(gpuEngines).catch(() => false) : true
      // chamada órfã de um renderer que sumiu sem avisar (ex.: crash antes do hook): o mesmo dono
      // pedindo de novo reabre; outro dono ainda vivo segue recusado pelo manager
      if (voiceCalls.state().active && owner !== null && voiceCallOwner === owner) voiceCalls.stop()
      const prevVoice = callVoice
      callVoice = startChatId ? { chatId: startChatId, ...use } : null
      elevenOptsCache = null
      let state: ReturnType<typeof voiceCalls.start>
      try {
        state = voiceCalls.start(sessionId)
      } catch (e) {
        callVoice = prevVoice // outra chamada ativa (outro dono) segue com a voz dela
        throw e
      }
      voiceCallOwner = owner
      const gen = ++gpuCallGen
      if (!gpuWarm) {
        // liga sozinho: sobe + aquece ANTES do microfone abrir (o estado devolvido já vem com
        // `preparing` — o renderer não abre a captura); falha encerra a chamada com o motivo
        state = voiceCalls.setPreparing(`Iniciando ${gpuEnginesLabel(gpuEngines)}…`)
        const t0 = Date.now()
        void prepareGpuForCall({
          engines: gpuEngines,
          isWarm: async () => false,
          start: (ids, onPhase) => gpu.startServer([...ids], { onPhase, tts: effective.tts }),
          setPreparing: (text) => void voiceCalls.setPreparing(text),
          stillActive: () => {
            const st = voiceCalls.state()
            return gen === gpuCallGen && st.active && st.sessionId === sessionId
          },
          fail: (reason) => {
            ttsRelay.abortAll()
            voiceCalls.stop(reason)
          }
        }).then((r) =>
          console.log(`[clearchat] gpu: preparo da chamada ${r} em ${Date.now() - t0} ms`)
        )
      }
      // o /models do provedor do chat e do modelo da chamada em cache: a política de raciocínio do
      // turno de voz (desligar/mínimo) depende dos metadados do modelo
      const session = sessionsRepo.get(sessionId)
      const chat = session ? chatsRepo.get(session.chatId) : null
      const call = chat ? voiceCalls.callContextFor(chat, { id: sessionId, depth: 0 }) : null
      for (const pid of new Set([chat?.config.providerId, call?.model?.providerId])) {
        const p = pid ? providersRepo.get(pid) : null
        if (p) void listModels(p).catch(() => undefined)
      }
      // preço de lista da voz (custo ≈ no marcador de fim): a listagem de modelos de fala em cache
      const ttsApi = effective.tts
      if (ttsApi.backend === 'api' && ttsApi.api.providerId)
        void listVoiceCatalog(
          { capability: 'tts', providerId: ttsApi.api.providerId },
          { provider: (id) => providersRepo.get(id) }
        ).catch(() => undefined)
      return state
    },
    [IPC.voice.callStop]: () => {
      voiceCallOwner = null
      gpuCallGen++
      ttsRelay.abortAll()
      return voiceCalls.stop()
    },
    [IPC.voice.callGetState]: () => voiceCalls.state(),
    [IPC.voice.runtimeStatus]: () => voiceRuntimeStatus(),
    // voz da persona/chat neste dispositivo (protocolo 1.9.0): camadas cruas → normalizadas aqui
    [IPC.voice.resolve]: (input?: unknown) => resolveVoiceFor(voiceLayersFrom(input)),
    // ---- modo avançado (GPU local): URL/token do servidor nunca saem do main ----
    [IPC.voice.gpuStatus]: () => gpu.status(true),
    [IPC.voice.gpuInstallRuntime]: () => gpu.installRuntime(),
    [IPC.voice.gpuRemoveRuntime]: () => gpu.removeRuntime(),
    [IPC.voice.gpuInstallEngine]: (id: unknown) => gpu.installEngine(id),
    [IPC.voice.gpuRemoveEngine]: (id: unknown) => gpu.removeEngine(id),
    [IPC.voice.gpuCancel]: () => gpu.cancel(),
    [IPC.voice.gpuSelfTest]: (id: unknown) => {
      if (!isGpuEngineId(id)) throw new Error(`Motor desconhecido: ${String(id)}.`)
      return gpu.selfTest(id)
    },
    [IPC.voice.gpuStartServer]: (ids?: unknown) => gpu.startServer(ids),
    [IPC.voice.gpuStopServer]: () => gpu.stopServer(),
    [IPC.voice.gpuAddUserVoice]: (input: { name: unknown; audio: unknown; transcript?: unknown }) =>
      gpu.addUserVoice(input),
    [IPC.voice.gpuRemoveUserVoice]: (id: unknown) => gpu.removeUserVoice(id),
    [IPC.voice.gpuDownloadCc0Voice]: (input?: { id?: unknown }) => gpu.downloadCc0Voice(input),
    [IPC.voice.gpuTranscribe]: (input: { audio: unknown }) => gpu.transcribe(input),
    [IPC.voice.gpuLog]: () => gpu.logText(),
    [IPC.voice.callMute]: (input: { muted: boolean }) => voiceCalls.mute(!!input?.muted),
    [IPC.voice.callSpeechBegin]: (input?: { dropped?: unknown }) => {
      const dropped = Array.isArray(input?.dropped)
        ? input.dropped.filter((x): x is string => typeof x === 'string')
        : []
      // o renderer descartou utterances sem tocar: os streams delas (TTS progressivo) param
      if (dropped.length) ttsRelay.abortAll()
      return voiceCalls.speechBegin({ dropped })
    },
    [IPC.voice.callSpeechEnd]: () => voiceCalls.speechEnd(),
    [IPC.voice.callTurn]: (input: { text: string; speechMs?: unknown }) =>
      voiceCalls.turn(input && typeof input.text === 'string' ? input.text : '', {
        // tempo com VOZ da fala (renderer — `VoicedSpan`): o preâmbulo compara com a "Fala mínima"
        speechMs: typeof input?.speechMs === 'number' ? input.speechMs : null
      }),
    [IPC.voice.callPlaybackIdle]: () => voiceCalls.playbackIdle(),
    [IPC.voice.callBargeIn]: (input?: {
      playedIds?: unknown
      reason?: unknown
      speechMs?: unknown
      current?: { id?: unknown; playedMs?: unknown; durationMs?: unknown }
    }) => {
      ttsRelay.abortAll() // o renderer já descartou a fila: os downloads em curso param
      return voiceCalls.bargeIn({
        ...(Array.isArray(input?.playedIds)
          ? { playedIds: input.playedIds.filter((x): x is string => typeof x === 'string') }
          : {}),
        ...(typeof input?.reason === 'string' ? { reason: input.reason } : {}),
        ...(typeof input?.speechMs === 'number' ? { speechMs: input.speechMs } : {}),
        ...(typeof input?.current?.id === 'string' && typeof input.current.playedMs === 'number'
          ? {
              current: {
                id: input.current.id,
                playedMs: input.current.playedMs,
                durationMs:
                  typeof input.current.durationMs === 'number' ? input.current.durationMs : null
              }
            }
          : {})
      })
    },
    [IPC.voice.callBackchannel]: (input: { ms: number }) =>
      voiceCalls.backchannel(input ?? { ms: 0 }),

    // ---- sync ----
    ...syncHandlers()
  }

  const missing = ALL_CHANNELS.filter((c) => !handlers[c])
  if (missing.length) throw new Error(`[clearchat] canais IPC sem handler: ${missing.join(', ')}`)

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      // o dono da chamada fica visível só durante a parte síncrona do handler
      ipcSenderId = e.sender.id
      try {
        return (fn as (...a: unknown[]) => unknown)(...args)
      } finally {
        ipcSenderId = null
      }
    })
  }
}
