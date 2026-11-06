// Nomes dos canais IPC (formato `domínio:método`) + interface `window.api`.
// Ver SPEC.md → "API do preload". Todo método (exceto onEvent/onVoicePartial) é ipcRenderer.invoke → ipcMain.handle.
import type { EngineConfig } from './webSearchSettings'
import type {
  AudioInputSettings,
  SttLocalEngine,
  SttSettings,
  TtsLocalEngine,
  TtsSettings,
  VoiceCallDefaults,
  VoiceCallState
} from './voice'
import type { VoiceCatalogRequest, VoiceCatalogView } from './voiceCatalog'
import type { GpuEngineId, GpuSelfTestResult, GpuStatus } from './gpuVoice'
import type {
  ChatHostInfo,
  CloudSkill,
  DivergenceDetails,
  SyncDevice,
  SyncServerInfo,
  SyncServerKind,
  SyncStatus,
  TakeoverOptions
} from './sync'
import type { UpdateStatus } from './updates'
import type { RemoteDirResult, RemoteReadResult } from './remoteFs'
import type { SkillsDiscoverOptions, SkillsDiscovery, SkillsSettings } from './skills'
import type {
  Memory,
  MemoryCollection,
  MemoryCollectionInput,
  MemoryCollectionPatch,
  MemoryExtractionResult,
  MemoryInput,
  MemoryListQuery,
  MemoryPatch,
  MemoryPreview
} from './memory'
import type {
  AgentEvent,
  ApiMessage,
  ApprovalRequest,
  AttachmentInfo,
  Chat,
  ChatConfig,
  DirEntry,
  ModelInfo,
  Preset,
  ProcessInfo,
  Provider,
  QuestionAnswer,
  QuestionRequest,
  RetryRequest,
  QueuedMessage,
  Session,
  SmartApproveRecord,
  StoredMessage,
  ToolName,
  ViewerKind
} from './types'

export const IPC = {
  providers: {
    list: 'providers:list',
    create: 'providers:create',
    update: 'providers:update',
    delete: 'providers:delete',
    listModels: 'providers:listModels',
    test: 'providers:test'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set'
  },
  chats: {
    list: 'chats:list',
    get: 'chats:get',
    create: 'chats:create',
    update: 'chats:update',
    delete: 'chats:delete',
    generateTitle: 'chats:generateTitle'
  },
  sessions: {
    list: 'sessions:list',
    messages: 'sessions:messages'
  },
  messages: {
    update: 'messages:update',
    delete: 'messages:delete'
  },
  agent: {
    send: 'agent:send',
    forceSend: 'agent:forceSend',
    removeQueued: 'agent:removeQueued',
    getQueue: 'agent:getQueue',
    stop: 'agent:stop',
    regenerate: 'agent:regenerate',
    editBranch: 'agent:editBranch',
    selectBranch: 'agent:selectBranch',
    approve: 'agent:approve',
    pendingApprovals: 'agent:pendingApprovals',
    previewRequest: 'agent:previewRequest',
    runningSessions: 'agent:runningSessions',
    compact: 'agent:compact',
    stopSubagents: 'agent:stopSubagents',
    smartOverride: 'agent:smartOverride',
    smartApproveTest: 'agent:smartApproveTest',
    setCapturedContext: 'agent:setCapturedContext',
    undoCapturedContext: 'agent:undoCapturedContext'
  },
  fs: {
    listDir: 'fs:listDir',
    readFile: 'fs:readFile',
    pickDirectory: 'fs:pickDirectory',
    homeDir: 'fs:homeDir',
    mkdir: 'fs:mkdir'
  },
  viewer: {
    open: 'viewer:open',
    check: 'viewer:check',
    readText: 'viewer:readText',
    openExternal: 'viewer:openExternal',
    showInFolder: 'viewer:showInFolder',
    saveBytes: 'viewer:saveBytes',
    openBytes: 'viewer:openBytes',
    run: 'viewer:run',
    runBytes: 'viewer:runBytes'
  },
  app: {
    capabilities: 'app:capabilities'
  },
  updates: {
    status: 'updates:status',
    check: 'updates:check',
    openRelease: 'updates:openRelease'
  },
  presets: {
    list: 'presets:list',
    create: 'presets:create',
    update: 'presets:update',
    delete: 'presets:delete',
    duplicate: 'presets:duplicate'
  },
  memory: {
    listCollections: 'memory:listCollections',
    createCollection: 'memory:createCollection',
    updateCollection: 'memory:updateCollection',
    deleteCollection: 'memory:deleteCollection',
    list: 'memory:list',
    create: 'memory:create',
    update: 'memory:update',
    delete: 'memory:delete',
    preview: 'memory:preview',
    refreshSnapshot: 'memory:refreshSnapshot',
    extractNow: 'memory:extractNow'
  },
  attachments: {
    pick: 'attachments:pick',
    add: 'attachments:add'
  },
  questions: {
    answer: 'questions:answer',
    cancel: 'questions:cancel',
    pending: 'questions:pending'
  },
  retries: {
    retry: 'retries:retry',
    cancel: 'retries:cancel',
    pending: 'retries:pending'
  },
  processes: {
    list: 'processes:list',
    stop: 'processes:stop',
    logs: 'processes:logs'
  },
  approvals: {
    getSettings: 'approvals:getSettings',
    updateSettings: 'approvals:updateSettings'
  },
  skills: {
    getSettings: 'skills:getSettings',
    updateSettings: 'skills:updateSettings',
    discover: 'skills:discover',
    read: 'skills:read',
    pickFolder: 'skills:pickFolder',
    openFolder: 'skills:openFolder'
  },
  sync: {
    status: 'sync:status',
    probeServer: 'sync:probeServer',
    setServer: 'sync:setServer',
    requestCode: 'sync:requestCode',
    verifyCode: 'sync:verifyCode',
    refreshKeys: 'sync:refreshKeys',
    unlock: 'sync:unlock',
    unlockWithRecovery: 'sync:unlockWithRecovery',
    resolveMerge: 'sync:resolveMerge',
    lock: 'sync:lock',
    logout: 'sync:logout',
    changePassword: 'sync:changePassword',
    newRecoveryKey: 'sync:newRecoveryKey',
    devices: 'sync:devices',
    renameDevice: 'sync:renameDevice',
    revokeDevice: 'sync:revokeDevice',
    syncNow: 'sync:syncNow',
    setPushNotify: 'sync:setPushNotify',
    openSignup: 'sync:openSignup',
    openSetup: 'sync:openSetup',
    chatStates: 'sync:chatStates',
    takeover: 'sync:takeover',
    cancelHandover: 'sync:cancelHandover',
    setPinned: 'sync:setPinned',
    confirmCwd: 'sync:confirmCwd',
    divergence: 'sync:divergence',
    resolveDivergence: 'sync:resolveDivergence',
    setActiveChat: 'sync:setActiveChat',
    answerPrompt: 'sync:answerPrompt',
    cloudSkills: 'sync:cloudSkills',
    trackedSkills: 'sync:trackedSkills',
    setSkillSync: 'sync:setSkillSync',
    downloadSkills: 'sync:downloadSkills',
    removeCloudSkill: 'sync:removeCloudSkill',
    stopTrackingSkill: 'sync:stopTrackingSkill',
    hostSkills: 'sync:hostSkills',
    remoteListDir: 'sync:remoteListDir',
    remoteReadFile: 'sync:remoteReadFile'
  },
  webSearch: {
    getSettings: 'webSearch:getSettings',
    updateEngines: 'webSearch:updateEngines',
    setKey: 'webSearch:setKey',
    revealKey: 'webSearch:revealKey',
    test: 'webSearch:test'
  },
  voice: {
    settingsGet: 'voice:settings:get',
    settingsSet: 'voice:settings:set',
    transcribeStart: 'voice:transcribe:start',
    transcribePush: 'voice:transcribe:push',
    transcribeStop: 'voice:transcribe:stop',
    transcribeCancel: 'voice:transcribe:cancel',
    transcribeSpeculate: 'voice:transcribe:speculate',
    modelsList: 'voice:models:list',
    modelsDownload: 'voice:models:download',
    modelsCancel: 'voice:models:cancel',
    modelsRemove: 'voice:models:remove',
    ttsSynth: 'voice:tts:synth',
    ttsTest: 'voice:tts:test',
    ttsClipsGenerate: 'voice:tts:clips:generate',
    ttsClipsList: 'voice:tts:clips:list',
    ttsVoices: 'voice:tts:voices',
    catalogList: 'voice:catalog:list',
    catalogPreview: 'voice:catalog:preview',
    callStart: 'voice:call:start',
    callStop: 'voice:call:stop',
    callMute: 'voice:call:mute',
    callSpeechBegin: 'voice:call:speech-begin',
    callSpeechEnd: 'voice:call:speech-end',
    callTurn: 'voice:call:turn',
    callPlaybackIdle: 'voice:call:playback-idle',
    callBargeIn: 'voice:call:barge-in',
    callInterjectionObserved: 'voice:call:interjection-observed',
    callBackchannel: 'voice:call:backchannel',
    callGetState: 'voice:call:get-state',
    runtimeStatus: 'voice:runtime:status',
    // "Modo avançado (GPU local)" — SPEC → "Áudio → Modo avançado (GPU local)"
    gpuStatus: 'voice:gpu:status',
    gpuInstallRuntime: 'voice:gpu:install-runtime',
    gpuRemoveRuntime: 'voice:gpu:remove-runtime',
    gpuInstallEngine: 'voice:gpu:install-engine',
    gpuRemoveEngine: 'voice:gpu:remove-engine',
    gpuCancel: 'voice:gpu:cancel',
    gpuSelfTest: 'voice:gpu:self-test',
    gpuStartServer: 'voice:gpu:start-server',
    gpuStopServer: 'voice:gpu:stop-server',
    gpuAddUserVoice: 'voice:gpu:add-user-voice',
    gpuRemoveUserVoice: 'voice:gpu:remove-user-voice',
    gpuDownloadCc0Voice: 'voice:gpu:download-cc0-voice',
    gpuTranscribe: 'voice:gpu:transcribe',
    gpuLog: 'voice:gpu:log'
  }
} as const

/** Canal main → renderer (webContents.send) para todos os AgentEvent. */
export const EVENT_CHANNEL = 'agent:event'
/** Canal main → renderer com as parciais ao vivo de uma sessão de transcrição (`VoicePartialEvent`). */
export const VOICE_PARTIAL_CHANNEL = 'voice:partial'
/** Canal main → renderer com o progresso de downloads de modelos locais (`VoiceModelProgressEvent`). */
export const VOICE_MODELS_PROGRESS_CHANNEL = 'voice:models:progress'
/** Canal main → renderer com o progresso da geração de clipes de voz (`TtsClipProgressEvent`). */
export const VOICE_TTS_CLIPS_PROGRESS_CHANNEL = 'voice:tts:clips:progress'
/** Canal main → renderer com o status completo do modo GPU durante instalações/servidor (`GpuStatus`). */
export const VOICE_GPU_PROGRESS_CHANNEL = 'voice:gpu:progress'
/** Canal main → renderer com o estado da chamada de voz (`VoiceCallState`). */
export const VOICE_CALL_STATE_CHANNEL = 'voice:call:state'
/** Canal main → renderer com uma utterance falada da chamada (`VoiceCallUtteranceEvent`). */
export const VOICE_CALL_UTTERANCE_CHANNEL = 'voice:call:utterance'
/** Canal main → renderer com o cancelamento de uma utterance (`VoiceCallUtteranceCancelEvent`). */
export const VOICE_CALL_UTTERANCE_CANCEL_CHANNEL = 'voice:call:utterance-cancel'
/**
 * Canal main → renderer com os pedaços seguintes de uma utterance em streaming
 * (`VoiceCallUtteranceChunkEvent` — só utterances com `streaming: true`).
 */
export const VOICE_CALL_UTTERANCE_CHUNK_CHANNEL = 'voice:call:utterance-chunk'
/** Canal main → renderer com eventos da timeline da chamada (`VoiceCallTimelineEvent`). */
export const VOICE_CALL_TIMELINE_CHANNEL = 'voice:call:timeline'

type ValueOf<T> = T[keyof T]
export type IpcChannel = ValueOf<{ [D in keyof typeof IPC]: ValueOf<(typeof IPC)[D]> }>

/** Todos os canais invoke (útil para validar que o main registrou handlers para tudo). */
export const ALL_CHANNELS: IpcChannel[] = Object.values(IPC).flatMap(
  (domain) => Object.values(domain) as IpcChannel[]
)

// ---- Tipos de entrada/saída ----

export type ProviderInput = Omit<Provider, 'id' | 'createdAt'>
export type ProviderPatch = Partial<Omit<Provider, 'id' | 'createdAt'>>
export interface ProviderTestInput {
  kind?: import('./providerKinds').ProviderKind
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
}
export interface ProviderTestResult {
  ok: boolean
  error?: string
  modelCount?: number
}

export interface ChatCreateInput {
  title?: string
  config?: Partial<ChatConfig>
}
export interface ChatUpdateInput {
  title?: string
  config?: Partial<ChatConfig>
}

export type ApprovalDecision = 'allow' | 'deny'

/** "Testar" do Smart-Approve: a config (chat ou persona) + uma chamada de exemplo. */
export interface SmartApproveTestInput {
  config: Pick<
    ChatConfig,
    'smartApprove' | 'cwd' | 'confineToRoot' | 'sandboxBash' | 'appSignature' | 'appSignatureCustom'
  >
  tool: ToolName
  args: unknown
  /** Histórico de exemplo para {{recent_context}} / {{last_user_message}}. */
  history?: StoredMessage[]
  /** Contexto capturado do chat (o "Testar" usa o do chat aberto). */
  captured?: string
}

/** Request EXATA da próxima chamada (apiKey mascarada). */
export interface RequestPreview {
  url: string
  headers: Record<string, string>
  body: unknown
  /** Avisos sobre a exibição (ex.: base64 de anexos encurtado no preview). */
  notes?: string[]
}

/** Arquivo enviado pelo renderer (arrastar/colar) para o store de anexos. */
export interface AttachmentAddInput {
  name: string
  mime?: string
  data: Uint8Array
}

/** Resultado do seletor de arquivos: anexos salvos + erros legíveis (tamanho/tipo). */
export interface AttachmentPickResult {
  items: AttachmentInfo[]
  errors: string[]
}

export interface FileContent {
  content: string
  truncated: boolean
  binary: boolean
}

/**
 * Arquivo a abrir no visualizador (SPEC → "Visualizador de arquivos"): um arquivo de uma chamada
 * de present_file (o main confere a mensagem no banco) ou um arquivo escolhido na aba Arquivos.
 */
export type ViewerTarget =
  | { chatId: string; source: 'present'; messageId: string; index: number }
  | { chatId: string; source: 'browse'; path: string }

/** Concessão aberta: o token dá acesso (clearchat-file://<token>/<nome>) só a este arquivo. */
export interface ViewerFile {
  token: string
  /** URL do protocolo (imagem/PDF/HTML) — o renderer nunca monta caminho. */
  url: string
  /** Caminho absoluto (exibição / copiar). */
  path: string
  name: string
  size: number
  mtime: number
  kind: ViewerKind
  mime: string
  /** Linguagem do highlight.js (código). */
  language?: string
  /** Rótulo do tipo ("Documento PDF", "arquivo ZIP (ou docx/xlsx/jar)"…). */
  typeLabel: string
  /**
   * Ações pela extensão + sistema (documento / executável deste sistema / de outro / desconhecido).
   * Só para a UI: o main reclassifica antes de abrir ou executar.
   */
  action: import('./fileActions').FileAction
}

/** Por que o arquivo não abre aqui. */
export type ViewerUnavailable =
  | 'remote' // está em outro dispositivo (host do chat / quem rodou a tool)
  | 'missing' // não existe mais (ou não é um arquivo comum)
  | 'denied' // fora do diretório raiz com confinamento / sem permissão
  | 'invalid' // mensagem/arquivo inexistente na chamada

export type ViewerOpenResult =
  | { ok: true; file: ViewerFile }
  | { ok: false; reason: ViewerUnavailable; message: string; deviceName?: string }

/** Estado de cada arquivo de uma chamada de present_file (cards), sem abrir nada. */
export type ViewerCheck =
  { ok: true } | { ok: false; reason: ViewerUnavailable; deviceName?: string }

export interface ViewerText {
  content: string
  /** Lido só o começo (arquivo > VIEWER_LIMITS.textMaxBytes). */
  truncated: boolean
  size: number
}

export interface CompactOptions {
  /** Depois de compactar, roda o agente de novo (botão "Compactar e tentar de novo"). */
  retry?: boolean
}

export interface AppCapabilities {
  /** bubblewrap disponível → opção "shell em sandbox". */
  bwrap: boolean
  /** ripgrep disponível (search_files/find_files usam; senão, busca em JS). */
  ripgrep: boolean
  /** Shell do usuário detectado no start (descrição da tool `shell`). */
  shell?: import('./shellInfo').ShellInfoLite
  /** `process.platform` do main (ações por tipo de arquivo do visualizador). */
  platform?: string
}

/** Últimas linhas de um processo em segundo plano (popover da UI). */
export interface ProcessLogsResult {
  info: ProcessInfo
  lines: { n: number; text: string }[]
}

/** Buscador do web_search como a UI o vê: a chave só como máscara ("tvly-…abcd"). */
export interface WebSearchEngineState extends EngineConfig {
  hasKey: boolean
  keyMask: string | null
}
export interface WebSearchSettingsState {
  /** Ordem = prioridade. */
  engines: WebSearchEngineState[]
}
/** "Testar" de um buscador: uma pesquisa pequena (fora do intervalo global). */
export interface WebSearchTestResult {
  ok: boolean
  /** "3 resultados em 1,2 s" / motivo da falha. */
  message: string
  count?: number
  ms?: number
  /** Recusado pelo freio do botão (teste em andamento / muito seguido) — sem ir à rede. */
  throttled?: boolean
}

// ---- áudio/voz: settings globais + sessão de transcrição (SPEC → "Áudio") ----

/**
 * As 4 settings de áudio pelas CHAVES de setting (o discriminador de `voice:settings:set`).
 * `sttSettings.api`/`ttsSettings.api` têm só o provedor (`providerId`), o modelo, a voz e as
 * opções — endereço e chave ficam no provedor cadastrado e nunca chegam ao renderer.
 */
export interface VoiceSettingsMap {
  audioInput: AudioInputSettings
  sttSettings: SttSettings
  ttsSettings: TtsSettings
  voiceCallDefaults: VoiceCallDefaults
}
export type VoiceSettingKind = keyof VoiceSettingsMap
/** O que `voice:settings:get` devolve (= `VoiceSettingsMap`). */
export type VoiceSettingsView = VoiceSettingsMap

/** Parcial ao vivo de uma sessão de transcrição (canal `voice:partial`, assinada por `onVoicePartial`). */
export interface VoicePartialEvent {
  /** Sessão que emitiu (a UI descarta eventos de sessões antigas). */
  sessionId: string
  /** Texto parcial acumulado (melhor-esforço; a transcrição final o reescreve). */
  text: string
  /** Sempre false aqui — a transcrição definitiva volta como retorno de `voice:transcribe:stop`. */
  isFinal: boolean
  /** Duração da chamada que gerou a parcial, em ms. */
  ms: number
  /** Áudio coberto pelo texto, em ms desde o início da sessão (ausente = desconhecido). */
  coveredMs?: number
  /**
   * Aviso legível (uma vez por sessão) quando as parciais foram desligadas (chave/cota/config) ou
   * a gravação atingiu o teto de duração. Ausente = parcial normal. A final segue valendo.
   */
  error?: string
}

/** Resultado final de uma sessão de transcrição (`TranscribeResult` + backend/fellBack de `voice/stt.ts`). */
export interface VoiceTranscribeResult {
  /** Texto transcrito (pode ser vazio quando não há fala). */
  text: string
  /** Modelo usado (`sttSettings.api.model`; no motor local, o modelo/motor dele). */
  model: string
  /** Base da API usada (no motor local: 'local'). */
  baseUrl: string
  /** Duração da chamada em ms. */
  ms: number
  /** Backend que serviu a transcrição. */
  backend: 'api' | 'local'
  /** true quando o primário falhou (disponibilidade) e o secundário atendeu. */
  fellBack: boolean
  /** Motivo curto (pt-BR) da falha do primário quando `fellBack`. */
  fallbackReason?: string
  /** A final é a transcrição especulativa reaproveitada (fim de turno adaptativo — sem 2ª chamada). */
  speculative?: boolean
  /** A final é a última parcial (cobria a fala inteira do trecho final — sem request). */
  partialReused?: boolean
}

/** Transcrição especulativa (`voice:transcribe:speculate`) — fim de turno adaptativo da chamada. */
export interface VoiceSpeculativeView {
  text: string
  ms: number
  backend: 'api' | 'local'
  /** Pode virar a final com `stop(id, { reuseSpeculative: true })`. */
  reusable: boolean
}

/** Uma sessão de transcrição por vez; `start` devolve o id usado em push/stop/cancel. */
export interface VoiceApi {
  settings: {
    /** Os 4 grupos completos e normalizados. */
    get(): Promise<VoiceSettingsView>
    /** Normaliza, grava um grupo e devolve o valor gravado. */
    set<K extends VoiceSettingKind>(kind: K, value: unknown): Promise<VoiceSettingsMap[K]>
  }
  transcribe: {
    /** Cria a sessão global (PCM16 mono 16 kHz). `language` ausente = `audioInput.language`. */
    start(language?: string): Promise<string>
    /** Acumula PCM16 mono little-endian (16 kHz; `sampleRate`, se vier, precisa casar). */
    push(sessionId: string, pcm16: Uint8Array, sampleRate?: number): Promise<void>
    /**
     * Para o loop de parciais e transcreve o buffer inteiro (final, com fallback se houver motor
     * local). `reuseSpeculative`: o usuário não falou depois da última especulação — ela vira a final.
     */
    stop(
      sessionId: string,
      opts?: {
        reuseSpeculative?: boolean
        /** A parcial que cobre a fala inteira vira a final (ausente = `sttSettings.reusePartialFinal`). */
        reusePartial?: boolean
      }
    ): Promise<VoiceTranscribeResult>
    /**
     * Transcrição especulativa do que já foi dito, sem encerrar (fim de turno adaptativo): motor
     * local quando pronto; API só com `voiceCallDefaults.turn.speculativeApi`. null = indisponível.
     */
    speculate(sessionId: string): Promise<VoiceSpeculativeView | null>
    /** Descarta a sessão sem transcrever (id desconhecido = sem efeito). */
    cancel(sessionId: string): Promise<void>
  }
  models: {
    /** O catálogo de modelos locais completo, com o estado em disco de cada entrada. */
    list(): Promise<VoiceModelInfo[]>
    /**
     * Baixa, verifica e instala o modelo (`{ id }`), emitindo `voice:models:progress` pelo caminho.
     * Resolve com o estado final, ou `null` quando cancelado por `cancel` (não é erro). Download já
     * em andamento para o mesmo id → erro legível.
     */
    download(input: { id: string }): Promise<VoiceModelInfo | null>
    /** Cancela o download do id (aborta e limpa o `.part`; id desconhecido = sem efeito). */
    cancel(input: { id: string }): Promise<void>
    /** Remove o modelo instalado (idempotente). Download em voo para o id → erro legível. */
    remove(input: { id: string }): Promise<void>
  }
  tts: {
    /**
     * Sintetiza `text` com as settings TTS atuais (API OpenAI-compatível `/audio/speech` ou motor
     * local). Devolve os bytes do áudio + modelo/backend/ms; a chave de API nunca sai do main.
     */
    synth(input: { text: string; format?: 'wav' | 'mp3' }): Promise<TtsSynthResult>
    /**
     * Frase curta de demonstração ("Testar voz" — Configurações → Áudio). Sem argumento = as
     * settings salvas e `TTS_TEST_PHRASE`; `voice`/`model` sobrescrevem só neste teste (▶ prévia de
     * uma voz ainda não escolhida) e `text` troca a frase (até 200 caracteres).
     */
    test(input?: { voice?: string | null; model?: string; text?: string }): Promise<TtsSynthResult>
    clips: {
      /**
       * Gera os clipes de interjeição/filler da voz atual (cache em `userData/voice-clips`),
       * emitindo `voice:tts:clips:progress` a cada clipe. Cache válido (mesma voz/definição) é
       * reutilizado; voz muda → gera no diretório da voz nova.
       */
      generate(): Promise<TtsClipsView>
      /** Cache de clipes da voz atual (null = ainda não gerados). */
      list(): Promise<TtsClipsView | null>
    }
    /** Vozes do motor local atual (com estado de instalação) + sugestões livres para a API. */
    voices(): Promise<TtsVoicesView>
  }
  /**
   * Chamada de voz meia-duplex (SPEC → "Áudio → Chamada de voz (meia-duplex)"): entrar/sair,
   * mudo e os eventos do turno (fala do usuário → transcrição → envio; resposta falada por
   * sentença em `voice:call:utterance`). O renderer é o "sensor" (captura, silêncio, reprodução);
   * o main é o dono do estado do turno e do envio pelo caminho normal do composer.
   */
  call: {
    /** Entra na chamada da sessão (depth 0). Já em chamada/fora do padrão → erro legível. */
    start(input: { sessionId: string }): Promise<VoiceCallState>
    /** Sai da chamada (descarta fala pendente e para a fala do assistente). */
    stop(): Promise<VoiceCallState>
    /** Mudo do microfone (a captura é pausada pelo renderer; aqui só reflete no estado). */
    mute(input: { muted: boolean }): Promise<VoiceCallState>
    /**
     * O usuário começou a falar fora da reprodução de uma frase (a UI mostra "Ouvindo…").
     * `dropped` = utterances que o renderer descartou sem tocar (clipes/frases na fila) — com a
     * resposta ainda não ouvida, o main retém a resposta (turno continuado).
     */
    speechBegin(input?: { dropped?: string[] }): Promise<VoiceCallState>
    /** Silêncio encerrou a fala: a transcrição final está em andamento ("Transcrevendo…"). */
    speechEnd(): Promise<VoiceCallState>
    /**
     * Transcrição final da fala do usuário. Sem resposta em andamento envia já (mesmo caminho do
     * composer — fila/⚡ respeitadas); com resposta em voo fica como PRÓXIMO turno (máx. 1).
     */
    /**
     * Transcrição final da fala → turno. `speechMs` = tempo com VOZ da fala (do 1º ao último quadro
     * acima do limiar — sem o silêncio antes/depois nem a espera do fim de turno); o preâmbulo
     * compara com a "Fala mínima" (`interjections.minSpeechMs`). Ausente = desconhecido.
     */
    turn(input: { text: string; speechMs?: number }): Promise<VoiceCallState>
    /** A fila de reprodução do renderer esvaziou (tudo que foi emitido já tocou). */
    playbackIdle(): Promise<VoiceCallState>
    /**
     * Barge-in: o usuário falou durante a reprodução (a fala do assistente é cancelada, o turno do
     * agente é parado e o histórico fica só com o que foi FALADO). `playedIds` = utterances de
     * sentença que começaram a tocar (a que estava tocando conta).
     */
    bargeIn(input?: { playedIds?: string[] }): Promise<VoiceCallState>
    /**
     * Observação do detector de pausas na fala do usuário (SPEC → "Interjeições (regras)"): a
     * política pura decide e o main toca o clipe (ou não, em modo sombra). `observedAt` = momento
     * da observação em ms (decisão que chega > 600 ms tarde demais é descartada).
     */
    interjectionObserved(input: {
      speechMs: number
      pauseMs: number
      tail: string
      observedAt: number
      /** Veredito do fim de turno adaptativo da pausa (`UtteranceEnd`); ausente = sem especulação. */
      end?: string | null
    }): Promise<void>
    /**
     * Backchannel do usuário durante a reprodução (fala curta ≤ ~800 ms): só registra — NÃO
     * cancela a resposta nem vira turno (fala longa é barge-in, via `bargeIn`).
     */
    backchannel(input: { ms: number }): Promise<void>
    /**
     * Estado atual da chamada no main (canal `voice:call:get-state`) — para o renderer reidratar
     * depois de recarregar (o evento `voice:call:state` só chega em transições). Opcional na
     * interface só para não quebrar implementações antigas (o preload sempre expõe).
     */
    getState?(): Promise<VoiceCallState>
  }
  /**
   * Descoberta de modelos/vozes de STT e TTS nos provedores cadastrados (canal `voice:catalog:list`,
   * cache de 10 min no main) e prévias de voz publicadas pelo provedor (`voice:catalog:preview` —
   * só URLs devolvidas por uma listagem). Opcional como `runtime` (implementações antigas).
   */
  catalog?: {
    list(input: VoiceCatalogRequest): Promise<VoiceCatalogView>
    preview(input: { url: string }): Promise<{ audio: Uint8Array; mime: string }>
  }
  /** Prontidão dos runtimes locais (canal `voice:runtime:status`) — opcional como `call.getState`. */
  runtime?: {
    /** Sonda (memoizado) whisper.cpp/onnxruntime/espeak-ng e o "pronto" local de STT e TTS. */
    status(): Promise<VoiceRuntimeStatus>
  }
  /**
   * "Modo avançado (GPU local)" (SPEC → "Áudio → Modo avançado (GPU local)"): sonda de hardware,
   * runtime Python/torch e motores baixados sob demanda para `<userData>/gpu-runtime`, servidor
   * local (127.0.0.1 + token por sessão — URL/token nunca chegam aqui) e vozes de clonagem.
   * Progresso no evento `voice:gpu:progress` (`onVoiceGpuProgress`, `GpuStatus` completo).
   */
  gpu?: VoiceGpuApi
}

/** `window.api.voice.gpu` — ações resolvem quando terminam; a UI relê `status()`/o evento. */
export interface VoiceGpuApi {
  status(): Promise<GpuStatus>
  /** Baixa o Python portátil + torch + base (whisper/servidor). Cancelável por `cancel()`. */
  installRuntime(): Promise<void>
  removeRuntime(): Promise<void>
  /** Camada de pacotes do motor + pesos (instala o runtime antes, se faltar). */
  installEngine(id: GpuEngineId): Promise<void>
  removeEngine(id: GpuEngineId): Promise<void>
  /** Cancela a instalação/download em andamento (resolve mesmo sem nada em andamento). */
  cancel(): Promise<void>
  /** Frase pt-BR fixa pelo caminho de áudio do app (+ transcrição de volta com o whisper, se instalado). */
  selfTest(id: GpuEngineId): Promise<GpuSelfTestResult>
  /** Sobe os processos dos motores (padrão: os escolhidos em Fala/Transcrição). */
  startServer(ids?: string[]): Promise<void>
  stopServer(): Promise<void>
  /** Voz do usuário: WAV PCM16 mono (o renderer decodifica; 24 kHz) de 3–30 s (ideal 6–10 s). */
  addUserVoice(input: { name: string; audio: ArrayBuffer; transcript?: string }): Promise<{
    id: string
  }>
  removeUserVoice(id: string): Promise<void>
  /** Baixa uma referência pt-BR CC0 (padrão: Faber). */
  downloadCc0Voice(input?: { id?: string }): Promise<{ id: string }>
  /** Transcreve uma amostra (WAV) com o whisper da GPU (transcrição automática da voz de clonagem). */
  transcribe(input: { audio: ArrayBuffer }): Promise<{ text: string }>
  /** Últimas linhas do log da instalação e do servidor. */
  log(): Promise<string>
}

/** Resultado de um probe de runtime local (`voice:runtime:status`). */
export interface VoiceRuntimeCheck {
  available: boolean
  /** Motivo legível (pt-BR) quando indisponível; null quando ok. */
  reason: string | null
}

/**
 * Prontidão dos runtimes locais de áudio ("pronto = modelo instalado + runtime carregável"):
 * os binários nativos carregam DE VERDADE (whisper no processo do worker, onnxruntime no main) e
 * o espeak-ng existe no sistema.
 */
export interface VoiceRuntimeStatus {
  /** whisper.cpp (`@napi-rs/whisper`) carrega no processo do motor local de STT. */
  whisper: VoiceRuntimeCheck
  /** `onnxruntime-node` carrega (motor local de fala Kokoro). */
  onnxruntime: VoiceRuntimeCheck
  /** `espeak-ng` do sistema responde (fonemização pt-BR do Kokoro). */
  espeak: VoiceRuntimeCheck
  /** STT local pronto agora: engine escolhido com runtime + modelo instalado. */
  sttLocal: VoiceRuntimeCheck
  /** TTS local pronto agora: onnxruntime + espeak-ng + modelo e voz do Kokoro instalados. */
  ttsLocal: VoiceRuntimeCheck
  /** Fala pela GPU local pronta (runtime + motor instalados, sem bloqueio de hardware). Aditivo. */
  gpuTts?: VoiceRuntimeCheck
  /** Transcrição pela GPU local pronta (runtime + whisper instalados). Aditivo. */
  gpuStt?: VoiceRuntimeCheck
}

/** Estado do modelo local no disco (espelho de `LocalModelState` em `src/main/voice/models.ts`). */
export type VoiceModelState = 'notInstalled' | 'downloading' | 'installed' | 'corrupt'

/** Entrada do catálogo de modelos locais com o estado em disco (`voice:models:list`). */
export interface VoiceModelInfo {
  /** Id estável da entrada do catálogo (usado em `voice:models:*`). */
  id: string
  kind: 'stt' | 'tts'
  engine: SttLocalEngine | TtsLocalEngine
  name: string
  description: string
  /** Idiomas cobertos; `'mul'` = multilingue. */
  languages: string[]
  version: string
  /** Tamanho exato publicado pelo host (0 = desconhecido — placeholders de TTS). */
  sizeBytes: number
  /** O catálogo tem URL de download (`false` = placeholder — ação desabilitada na UI). */
  hasDownload: boolean
  state: VoiceModelState
  /** Tamanho do arquivo instalado em bytes (null = sem arquivo em disco). */
  installedBytes: number | null
}

/** Progresso de um download de modelo local (canal `voice:models:progress`, assinado por `onVoiceModelProgress`). */
export interface VoiceModelProgressEvent {
  /** Modelo (id do catálogo) a que o progresso se refere. */
  id: string
  /** Bytes baixados até agora. */
  bytes: number
  /** Total esperado em bytes (0 = desconhecido). */
  total: number
}

// ---- TTS: síntese de fala e clipes de interjeição/filler (`voice:tts:*`) ----

/** Resultado de uma síntese de fala (`voice:tts:synth`/`voice:tts:test`) — bytes completos. */
export interface TtsSynthResult {
  /** Bytes do áudio (wav/mp3). */
  audio: Uint8Array
  /** MIME do áudio ('audio/wav' | 'audio/mpeg'). */
  mime: string
  /** Modelo usado (endpoint de API ou artefato do motor local). */
  model: string
  /** Backend que serviu a síntese. */
  backend: 'api' | 'local'
  /** Duração da chamada em ms. */
  ms: number
}

/** Voz de fala (`voice:tts:voices`). */
export interface TtsVoiceInfo {
  /** Id da voz (`ttsSettings.local.voice` ou `ttsSettings.api.voice`). */
  id: string
  label: string
  /** Motor local da voz; null = sugestão livre para endpoints OpenAI-compatíveis. */
  engine: TtsLocalEngine | null
  /** Voz instalada em disco (só vozes locais). */
  installed?: boolean
}

/** Vozes para a UI de Fala (TTS): as do motor local atual + sugestões livres para a API. */
export interface TtsVoicesView {
  local: TtsVoiceInfo[]
  api: TtsVoiceInfo[]
}

/** Progresso da geração de clipes de voz (canal `voice:tts:clips:progress`). */
export interface TtsClipProgressEvent {
  /** Clipe pronto (`<CLASSE>_<n>`, ex.: `ACK_2`). */
  id: string
  done: number
  total: number
}

/** Um clipe gerado (visão serializável de `VoiceClip` em `src/main/voice/clips.ts`). */
export interface TtsClipInfo {
  id: string
  class: string
  n: number
  text: string
}

/** Cache de clipes de uma voz (`voice:tts:clips:list|generate`). */
export interface TtsClipsView {
  /** Voz dona do cache (diretório em `userData/voice-clips`). */
  voiceId: string
  backend: 'api' | 'local' | 'gpu'
  /** Motor local ('kokoro'); null no backend de API. */
  engine: string | null
  model: string
  generatedAt: string
  clips: TtsClipInfo[]
  /** Cache de uma definição antiga (frases/pool de preâmbulos mudaram) — precisa regerar. */
  stale?: boolean
}

/** Uma utterance falada da chamada de voz (canal `voice:call:utterance`) — bytes completos por sentença. */
export interface VoiceCallUtteranceEvent {
  /** Id estável da utterance (ordem de emissão). */
  id: string
  /** Bytes do áudio (wav/mp3) — tocar na ordem, sem sobreposição (fila `UtteranceQueue`). */
  audio: Uint8Array
  /** MIME do áudio ('audio/wav' | 'audio/mpeg'). */
  mime: string
  /**
   * Origem do áudio (timeline/UI; ausente = 'sentence'): sentença da resposta, filler pós-turno
   * ou interjeição na fala do usuário (clipes `resolveClip` — SPEC → "Chamada de voz") ou frase de
   * demora sintetizada ao vivo ("Só mais um instante…", "Desculpe a demora…" — tratada como clipe:
   * pulada se não tocar, descartada quando o usuário fala, nunca no histórico).
   */
  kind?: 'sentence' | 'filler' | 'interjection' | 'delay'
  /**
   * Ganho relativo da utterance (0–1, multiplica o volume da chamada); ausente = 1. Interjeições
   * (backchannel) tocam mais baixo (`interjections.volume`, padrão 0.6).
   */
  gain?: number
  /**
   * Utterance em streaming (TTS de API que devolve PCM progressivo — ex.: OpenRouter/ElevenLabs):
   * `audio` traz só o começo (PCM16 LE mono cru, ~200 ms) com `mime` `audio/pcm;rate=N`, e o resto
   * chega por `voice:call:utterance-chunk` até `done`. Ausente/false = bytes completos (wav/mp3).
   */
  streaming?: boolean
}

/** Próximo pedaço de uma utterance em streaming (canal `voice:call:utterance-chunk`). */
export interface VoiceCallUtteranceChunkEvent {
  /** Id da utterance (`VoiceCallUtteranceEvent.id`). */
  id: string
  /** PCM16 LE mono (mesma taxa do `mime` da utterance); pode vir vazio no `done`. */
  pcm: Uint8Array
  /** Último pedaço: depois dele a utterance termina quando o áudio acabar de tocar. */
  done: boolean
  /** O stream falhou no meio (o que já chegou toca; a utterance termina aí). */
  error?: string
}

/** Cancela uma utterance (canal `voice:call:utterance-cancel`) — filler interrompido pela 1ª sentença. */
export interface VoiceCallUtteranceCancelEvent {
  /** Id da utterance a cancelar (tocando → pausa e descarta; na fila → só descarta). */
  id: string
}

/**
 * Evento da timeline da chamada de voz (canal `voice:call:timeline`; SPEC → "Modo sombra e
 * timeline"). O main emite decisões/emissões/envio; o renderer acrescenta os eventos do sensor
 * (fala/pausa/reprodução/barge-in/backchannel) — tudo com `ts` e relativo ao início da chamada.
 */
export interface VoiceCallTimelineEvent {
  /** Momento do evento (ms desde epoch). */
  ts: number
  kind:
    /** Decisão de ato de fala (filler/interjeição) — tocou, sombra ou descartada (`reason`). */
    | 'decision'
    /** Clique (filler/interjeição) emitido ao renderer. */
    | 'clip-emitted'
    /** Clipe cancelado (filler interrompido pela 1ª sentença/reset). */
    | 'clip-cancelled'
    /** Sentença da resposta emitida ao renderer. */
    | 'sentence-emitted'
    /** Transcrição do usuário enviada como turno. */
    | 'turn-sent'
    /** Fala do usuário detectada (renderer). */
    | 'speech-start'
    /** Silêncio encerrou a fala do usuário (renderer). */
    | 'speech-end'
    /** Pausa na fala do usuário que virou observação de interjeição (renderer). */
    | 'pause'
    /** Reprodução de clipe começou/terminou (renderer). */
    | 'clip-start'
    | 'clip-end'
    /** Reprodução de sentença começou/terminou (renderer). */
    | 'sentence-start'
    | 'sentence-end'
    /** Fala longa do usuário durante a reprodução cancelou a fala do assistente (renderer). */
    | 'barge-in'
    /** Fala curta do usuário durante a reprodução (backchannel — só registrou). */
    | 'backchannel'
    /** Veredito do fim de turno adaptativo numa pausa (renderer — `text` = especulativa, `reason` = veredito). */
    | 'turn-verdict'
    /** Turno continuado: o usuário voltou a falar antes da resposta ser ouvida (main — `text` = turno refeito). */
    | 'turn-continued'
    /** Turno do agente parado e histórico ajustado ao que foi falado (main — barge-in/continuação). */
    | 'turn-amended'
    /**
     * Latência do TTS em streaming (main — ElevenLabs WebSocket): `latencyMs` = 1º texto entregue →
     * 1º áudio (do turno, na 1ª sentença; senão da sentença), `reason` = backend/contexto.
     */
    | 'tts-latency'
    /** O agente pediu para encerrar (`end_call`): a chamada cai quando a resposta terminar de tocar. */
    | 'hangup-armed'
    /** Desligamento pedido pelo agente cancelado (o usuário voltou a falar — `reason`). */
    | 'hangup-cancelled'
    /**
     * Falha ao TOCAR uma utterance no renderer (`play()` rejeitado, erro de mídia/CSP/codec —
     * `reason` = mensagem, `id`/`class` = a utterance): nunca mais calada (painel + erro do dock).
     */
    | 'playback-error'
  /** Classe do ato ('FILLER'/'ACK'/…); ausente em eventos sem classe. */
  class?: string | null
  /** Id da utterance dona do evento (pareia decisão → áudio). */
  id?: string | null
  /** Variante do clipe decidida (1..3). */
  variant?: number | null
  /** Tocou de fato (false = sombra/descartada). */
  played?: boolean
  /** Fala do usuário até o evento (ms). */
  speechMs?: number | null
  /** Pausa do usuário no evento (ms). */
  pauseMs?: number | null
  /** Latência decisão→emissão em ms (o pareamento com o início do áudio é da UI). */
  latencyMs?: number | null
  /** Texto curto (cauda da transcrição/trecho do turno) — truncado. */
  text?: string | null
  /** Motivo/regra da decisão. */
  reason?: string | null
}

/** Persona nova. `config` passa por sanitizePresetConfig (só PRESET_FIELDS + cwd opcional). */
export interface PresetInput {
  name: string
  description?: string
  icon?: string
  config: Partial<ChatConfig>
}
/** `config`, se presente, SUBSTITUI a config inteira da persona (não é merge). */
export type PresetPatch = Partial<PresetInput>

export interface ClearApi {
  providers: {
    list(): Promise<Provider[]>
    create(p: ProviderInput): Promise<Provider>
    update(id: string, patch: ProviderPatch): Promise<Provider>
    delete(id: string): Promise<void>
    listModels(providerId: string): Promise<ModelInfo[]>
    test(p: ProviderTestInput): Promise<ProviderTestResult>
  }
  settings: {
    get<T = unknown>(key: string): Promise<T | null>
    set(key: string, value: unknown): Promise<void>
  }
  chats: {
    list(): Promise<Chat[]>
    get(id: string): Promise<Chat | null>
    create(input: ChatCreateInput): Promise<Chat>
    update(id: string, patch: ChatUpdateInput): Promise<Chat>
    delete(id: string): Promise<void>
    /**
     * "Gerar título": o modelo do título (Configurações → Novos chats) dá nome ao chat a partir da
     * 1ª mensagem; erro legível sem modelo/mensagem ou se a chamada falhar.
     */
    generateTitle(id: string): Promise<Chat>
  }
  sessions: {
    list(chatId: string): Promise<Session[]>
    messages(sessionId: string): Promise<StoredMessage[]>
  }
  /** Edição livre do histórico (mensagem digitada da principal → `agent.editBranch`). */
  messages: {
    update(id: string, message: ApiMessage): Promise<StoredMessage>
    delete(id: string): Promise<void>
  }
  agent: {
    /**
     * Só sessão depth 0. idle → inicia turno; running → enfileira. `attachments`: anexos já
     * salvos via attachments.pick/add (texto pode ser vazio se houver anexos).
     */
    send(
      sessionId: string,
      text: string,
      attachments?: AttachmentInfo[],
      /** Skills escolhidas na lâmpada do composer: SKILL.md lido no envio (erro → nada enviado). */
      skills?: string[],
      /**
       * Extras da mensagem: `voice` = texto ditado no composer (`{ source: 'dictation' }` — o main
       * só aceita ditado daqui; a fala da chamada é marcada pelo próprio main).
       */
      opts?: { voice?: import('./voiceCallMarks').VoiceMessageMeta }
    ): Promise<{ queued: boolean }>
    /** ⚡: aborta o que está rodando e injeta a mensagem já. */
    forceSend(queuedId: string): Promise<void>
    removeQueued(queuedId: string): Promise<void>
    getQueue(sessionId: string): Promise<QueuedMessage[]>
    /** Aborta (cascata para subsessões). */
    stop(sessionId: string): Promise<void>
    /**
     * Nova versão da resposta do turno que contém `messageId` (padrão: o último turno do caminho
     * ativo) — a anterior continua salva (‹ › para alternar). Resposta que é só erro é substituída.
     */
    regenerate(sessionId: string, messageId?: string): Promise<void>
    /**
     * Editar mensagem digitada da sessão principal = nova versão (irmã com o novo texto; anexos e
     * skills da original) e o agente roda a partir dela. Para o turno em andamento e os
     * subagentes em segundo plano da parte abandonada.
     */
    editBranch(messageId: string, message: ApiMessage): Promise<void>
    /**
     * Troca de versão (o caminho ativo passa por `messageId`); emite session-updated. Erro (pt-BR)
     * com a sessão ocupada ou subagente em segundo plano rodando na parte que muda.
     */
    selectBranch(messageId: string): Promise<Session>
    /**
     * Responde um card. Pergunta simples: 'allow' | 'deny'. Card do modo Listas: `items` = decisão
     * por sub-comando pendente (`pattern` = "+ whitelist"/"+ blacklist", salvo na lista global);
     * sem `items`, 'allow' = sim para todos.
     */
    approve(
      requestId: string,
      decision: ApprovalDecision,
      items?: import('./approvalPolicy').ApprovalItemDecision[]
    ): Promise<void>
    pendingApprovals(): Promise<ApprovalRequest[]>
    previewRequest(sessionId: string): Promise<RequestPreview>
    runningSessions(): Promise<string[]>
    /**
     * Compacta a conversa (só sessão principal). Ociosa → roda já; rodando → agenda para o
     * próximo limite de passo (`scheduled: true`).
     */
    compact(sessionId: string, opts?: CompactOptions): Promise<{ scheduled: boolean }>
    /** Para todos os subagentes do chat (inclusive em segundo plano); a sessão principal continua. */
    stopSubagents(chatId: string): Promise<void>
    /**
     * "Executar mesmo assim" num resultado rejeitado pelo Smart-Approve (id da mensagem tool):
     * libera a próxima chamada idêntica uma vez e envia "Pode executar …; eu aprovo." à sessão.
     */
    smartOverride(messageId: string): Promise<void>
    /** Roda o juiz numa chamada de exemplo (nada é salvo). */
    smartApproveTest(input: SmartApproveTestInput): Promise<SmartApproveRecord>
    /**
     * Smart-Approve → "Contexto capturado da conversa": grava a sua edição da descrição (sessionId
     * null = a do chat; um subagente = a dele). A versão anterior fica para desfazer.
     */
    setCapturedContext(chatId: string, sessionId: string | null, text: string): Promise<void>
    /** Desfaz a última mudança da descrição capturada. */
    undoCapturedContext(chatId: string, sessionId: string | null): Promise<void>
  }
  fs: {
    listDir(path: string): Promise<DirEntry[]>
    readFile(path: string): Promise<FileContent>
    pickDirectory(): Promise<string | null>
    homeDir(): Promise<string>
    /** Cria uma pasta (pai precisa existir; erro se já existir). Retorna o caminho absoluto. */
    mkdir(path: string): Promise<string>
  }
  /** Visualizador de arquivos — só arquivos da allowlist do main (ver SPEC). */
  viewer: {
    open(target: ViewerTarget): Promise<ViewerOpenResult>
    /** Estado dos arquivos de uma chamada de present_file (cards: "não encontrado", "no <host>"). */
    check(chatId: string, messageId: string): Promise<ViewerCheck[]>
    /** Texto do arquivo concedido (markdown/código/texto), até VIEWER_LIMITS.textMaxBytes. */
    readText(token: string): Promise<ViewerText>
    /** shell.openPath / shell.showItemInFolder — só tokens concedidos. */
    openExternal(token: string): Promise<void>
    showInFolder(token: string): Promise<void>
    /**
     * "Salvar como…" de um arquivo buscado de outro dispositivo: diálogo do main grava os bytes
     * (até REMOTE_FS_LIMITS.maxFileBytes). false = cancelado.
     */
    saveBytes(name: string, bytes: Uint8Array): Promise<boolean>
    /**
     * "Abrir no app" de um arquivo buscado de outro dispositivo: grava num temporário
     * (userData/tmp-viewer/<aleatório>/<nome>, limpo ao abrir/fechar o app) e abre no app padrão.
     */
    openBytes(name: string, bytes: Uint8Array): Promise<void>
    /**
     * "Executar…" de um arquivo concedido (executável DESTE sistema): o main reclassifica, pede
     * confirmação (diálogo nativo, padrão Cancelar) e roda. false = cancelado.
     */
    run(token: string): Promise<boolean>
    /**
     * "Executar…" de um arquivo buscado do host (chat em controle remoto): confirmação ("veio de
     * <host>"), cópia temporária privada e roda. false = cancelado.
     */
    runBytes(chatId: string, name: string, bytes: Uint8Array): Promise<boolean>
  }
  app: {
    capabilities(): Promise<AppCapabilities>
  }
  /** Aviso de versão nova (SPEC → "Atualizações"): só consulta o GitHub; nada é baixado. */
  updates: {
    /** Versão instalada + resultado da última checagem (sem ir à rede). */
    status(): Promise<UpdateStatus>
    /** "Verificar atualizações": checa agora. Falha → `state: 'error'` (nunca lança). */
    check(): Promise<UpdateStatus>
    /** "Baixar": abre a página da última release no navegador (só URLs do repositório do app). */
    openRelease(): Promise<void>
  }
  /** Personas (presets de chat). Apagar a persona padrão limpa `defaultPresetId`. */
  presets: {
    list(): Promise<Preset[]>
    create(input: PresetInput): Promise<Preset>
    update(id: string, patch: PresetPatch): Promise<Preset>
    delete(id: string): Promise<void>
    /** Cópia com nome "X (cópia)". */
    duplicate(id: string): Promise<Preset>
  }
  /** Memória modular (SPEC → Memória). CRUD global; seleção fica em ChatConfig.memory. */
  memory: {
    /** Inclui coleções de chat (scope 'chat'). */
    listCollections(): Promise<MemoryCollection[]>
    createCollection(input: MemoryCollectionInput): Promise<MemoryCollection>
    updateCollection(id: string, patch: MemoryCollectionPatch): Promise<MemoryCollection>
    deleteCollection(id: string): Promise<void>
    list(query?: MemoryListQuery): Promise<Memory[]>
    create(input: MemoryInput): Promise<Memory>
    update(id: string, patch: MemoryPatch): Promise<Memory>
    delete(id: string): Promise<void>
    /** O que vai para a API na próxima request da sessão (índice/help/tools). */
    preview(sessionId: string): Promise<MemoryPreview>
    /** Renova o snapshot do índice da sessão ("Atualizar memória"). */
    refreshSnapshot(sessionId: string): Promise<MemoryPreview>
    /** Roda a extração de memórias agora (só sessão principal). */
    extractNow(sessionId: string): Promise<MemoryExtractionResult>
  }
  /** Anexos: salvos no store content-addressed (userData/attachments) antes do envio. */
  attachments: {
    /** Diálogo nativo (múltiplos arquivos); lê e salva no main. */
    pick(): Promise<AttachmentPickResult>
    /** Salva bytes vindos do renderer (arrastar/colar). Erro legível se grande demais/não suportado. */
    add(input: AttachmentAddInput): Promise<AttachmentInfo>
  }
  /** Questionários pendentes (tool ask_user). */
  questions: {
    /** Envia as respostas (uma por pergunta, na ordem). Erro legível se incompletas. */
    answer(id: string, answers: QuestionAnswer[]): Promise<void>
    /** Cancela: o resultado vira "[O usuário não respondeu ao questionário]" e o agente para. */
    cancel(id: string): Promise<void>
    pending(): Promise<QuestionRequest[]>
  }
  /** Falhas de conexão com o provedor aguardando decisão (card "Tentar de novo / Cancelar"). */
  retries: {
    /** Repete a mesma chamada do zero (o parcial já foi descartado). */
    retry(id: string): Promise<void>
    /** Termina o turno como erro (como antes) — o mesmo que Parar no card. */
    cancel(id: string): Promise<void>
    pending(): Promise<RetryRequest[]>
  }
  /** Processos em segundo plano (process_start) do chat. */
  processes: {
    list(chatId: string): Promise<ProcessInfo[]>
    /** SIGTERM no grupo; SIGKILL após ~3 s. */
    stop(chatId: string, id: string): Promise<void>
    logs(chatId: string, id: string, tail?: number): Promise<ProcessLogsResult>
  }
  /** Aprovações: modos globais por item + listas globais (settings approvalModes / approvalLists). */
  approvals: {
    getSettings(): Promise<import('./types').ApprovalSettings>
    /** Substitui `modes` e/ou `lists` (inteiros). Entrada inválida → erro legível. */
    updateSettings(
      patch: Partial<import('./types').ApprovalSettings>
    ): Promise<import('./types').ApprovalSettings>
  }
  /** Skills (Configurações → Skills; seleção por chat em ChatConfig.skills). Ver SPEC → Skills. */
  skills: {
    getSettings(): Promise<SkillsSettings>
    /** Substitui `locations` e/ou `projectSkills`. Emite `skills-changed`. */
    updateSettings(patch: Partial<SkillsSettings>): Promise<SkillsSettings>
    /** Escaneia os locais (+ projeto de `cwd`). `rescan` ignora o cache (e emite `skills-changed`). */
    discover(opts?: SkillsDiscoverOptions): Promise<SkillsDiscovery>
    /** Conteúdo de um SKILL.md (preview somente leitura). Só arquivos chamados SKILL.md. */
    read(file: string): Promise<string>
    /** Diálogo nativo para escolher uma pasta de skills. */
    pickFolder(): Promise<string | null>
    /** Abre a pasta no gerenciador de arquivos (`~` expandido). */
    openFolder(path: string): Promise<void>
  }
  /** Buscadores do web_search (Configurações → Pesquisa na web). */
  webSearch: {
    getSettings(): Promise<WebSearchSettingsState>
    /** Substitui a lista (ordem/ligado/opções). Ligar buscador com API sem chave → erro legível. */
    updateEngines(
      engines: import('./webSearchSettings').EngineConfig[]
    ): Promise<WebSearchSettingsState>
    /** Salva a chave (null/vazio remove e desliga o buscador). */
    setKey(
      engine: import('./webSearchSettings').SearchEngineId,
      key: string | null
    ): Promise<WebSearchSettingsState>
    /** Chave em claro, a pedido (botão mostrar). */
    revealKey(engine: import('./webSearchSettings').SearchEngineId): Promise<string | null>
    test(engine: import('./webSearchSettings').SearchEngineId): Promise<WebSearchTestResult>
  }
  /**
   * Áudio/voz (SPEC → "Áudio"): settings globais tipadas + sessão de transcrição. Opcional no tipo
   * só porque o mock de dev (`src/renderer/src/dev/mockApi.ts`) ainda não o implementa — o preload
   * real SEMPRE expõe (use `FullClearApi` / `window.api`, onde ele é obrigatório).
   */
  voice?: VoiceApi
  /** Parciais ao vivo da sessão de transcrição (canal `voice:partial`); unsubscribe como em `onEvent`. */
  onVoicePartial?(cb: (e: VoicePartialEvent) => void): () => void
  /** Progresso de downloads de modelos locais (canal `voice:models:progress`); unsubscribe como em `onEvent`. */
  onVoiceModelProgress?(cb: (e: VoiceModelProgressEvent) => void): () => void
  /** Status do modo GPU durante instalações/servidor (canal `voice:gpu:progress`); unsubscribe como em `onEvent`. */
  onVoiceGpuProgress?(cb: (e: GpuStatus) => void): () => void
  /** Progresso da geração de clipes de voz (canal `voice:tts:clips:progress`); unsubscribe como em `onEvent`. */
  onVoiceTtsClipsProgress?(cb: (e: TtsClipProgressEvent) => void): () => void
  /** Estado da chamada de voz (canal `voice:call:state`); unsubscribe como em `onEvent`. */
  onVoiceCallState?(cb: (e: VoiceCallState) => void): () => void
  /** Utterances faladas da chamada (canal `voice:call:utterance`); unsubscribe como em `onEvent`. */
  onVoiceCallUtterance?(cb: (e: VoiceCallUtteranceEvent) => void): () => void
  /** Cancelamento de utterance da chamada (canal `voice:call:utterance-cancel`); unsubscribe como em `onEvent`. */
  onVoiceCallUtteranceCancel?(cb: (e: VoiceCallUtteranceCancelEvent) => void): () => void
  /** Pedaços das utterances em streaming (canal `voice:call:utterance-chunk`); unsubscribe como em `onEvent`. */
  onVoiceCallUtteranceChunk?(cb: (e: VoiceCallUtteranceChunkEvent) => void): () => void
  /** Timeline da chamada de voz (canal `voice:call:timeline`); unsubscribe como em `onEvent`. */
  onVoiceCallTimeline?(cb: (e: VoiceCallTimelineEvent) => void): () => void
  /** Sync (conta, servidor, host de execução, divergência) — ver docs/SYNC_PROTOCOL.md. */
  sync: {
    status(): Promise<SyncStatus>
    /** Valida um servidor (GET <base>/api/info). Sem url = o servidor atual. */
    probeServer(url?: string): Promise<SyncServerInfo>
    /** Só deslogado. kind 'official' = clear.ezenere.com; 'self' = url. */
    setServer(kind: SyncServerKind, url?: string): Promise<SyncStatus>
    /** Envia o código por e-mail (captcha numa janela, se a instância exigir). */
    requestCode(email: string): Promise<void>
    verifyCode(email: string, code: string): Promise<SyncStatus>
    /** Conta sem chaves: "Já defini a senha". */
    refreshKeys(): Promise<SyncStatus>
    unlock(password: string, remember: boolean): Promise<SyncStatus>
    unlockWithRecovery(
      recoveryKey: string,
      newPassword: string,
      remember: boolean
    ): Promise<SyncStatus>
    resolveMerge(priority: 'online' | 'local'): Promise<SyncStatus>
    /** Esquece a DEK neste computador (continua logado). */
    lock(): Promise<SyncStatus>
    logout(): Promise<SyncStatus>
    changePassword(newPassword: string): Promise<void>
    newRecoveryKey(): Promise<{ recoveryKey: string }>
    devices(): Promise<SyncDevice[]>
    renameDevice(id: string, name: string): Promise<void>
    revokeDevice(id: string): Promise<void>
    syncNow(): Promise<SyncStatus>
    /** "Avisar no celular quando eu estiver ausente ou quando o pedido vier do celular" (local). */
    setPushNotify(on: boolean): Promise<SyncStatus>
    openSignup(): Promise<void>
    openSetup(): Promise<void>
    chatStates(): Promise<ChatHostInfo[]>
    /** "Executar neste dispositivo" (troca de host). */
    takeover(chatId: string, opts: TakeoverOptions): Promise<ChatHostInfo>
    cancelHandover(chatId: string): Promise<void>
    setPinned(chatId: string, pinned: boolean): Promise<void>
    /** Raiz local escolhida ao virar host de um chat vindo de outro dispositivo. */
    confirmCwd(chatId: string, cwd: string): Promise<void>
    divergence(chatId: string): Promise<DivergenceDetails>
    /** Mantém uma versão; a outra é APAGADA (depois do aviso na UI). */
    resolveDivergence(chatId: string, keep: 'online' | 'local'): Promise<void>
    /** Chat aberto na tela (stream ao vivo do host). */
    setActiveChat(chatId: string | null): Promise<void>
    /** "Chat apagado em outro dispositivo": manter como novo / descartar. */
    answerPrompt(chatId: string, keep: boolean): Promise<SyncStatus>
    cloudSkills(): Promise<CloudSkill[]>
    /** Skills locais com "Sincronizar" ligado (nomes). */
    trackedSkills(): Promise<string[]>
    setSkillSync(name: string, on: boolean): Promise<void>
    downloadSkills(names?: string[]): Promise<number>
    removeCloudSkill(name: string): Promise<void>
    stopTrackingSkill(name: string): Promise<void>
    /** Skills do host (controle remoto): null = este dispositivo executa o chat. */
    hostSkills(chatId: string): Promise<{ name: string; description: string }[] | null>
    /** Controle remoto: lista uma pasta do HOST do chat (`fs.list`, §8.6). Vazio = raiz. */
    remoteListDir(chatId: string, path: string): Promise<RemoteDirResult>
    /** Controle remoto: um pedaço de um arquivo do HOST (`fs.read`, §8.6). */
    remoteReadFile(
      chatId: string,
      path: string,
      offset: number,
      length: number
    ): Promise<RemoteReadResult>
  }
  /**
   * Menu de contexto (SPEC → "Menu de contexto"): ponte do menu nativo com as ações do app.
   * Opcional no tipo porque o mock de dev não tem menu nativo; o preload real sempre expõe.
   */
  contextMenu?: {
    /**
     * O main pergunta o que está sob o clique direito (`ctx:query`); `cb` devolve o descritor
     * (ou null) e o preload responde (`ctx:reply`). Unsubscribe como em `onEvent`.
     */
    onQuery(cb: () => import('./contextMenu').AppCtx | null): () => void
    /** O usuário escolheu uma ação do app no menu (`ctx:action`). Unsubscribe como em `onEvent`. */
    onAction(
      cb: (e: { token: number; action: import('./contextMenu').CtxAppAction }) => void
    ): () => void
  }
  /** Assina eventos do agente; retorna a função de unsubscribe. */
  onEvent(cb: (e: AgentEvent) => void): () => void
}

/** `ClearApi` com os membros de voz obrigatórios — o que o preload real expõe em `window.api`. */
export type FullClearApi = ClearApi &
  Required<
    Pick<
      ClearApi,
      | 'voice'
      | 'onVoicePartial'
      | 'onVoiceModelProgress'
      | 'onVoiceGpuProgress'
      | 'onVoiceTtsClipsProgress'
      | 'onVoiceCallState'
      | 'onVoiceCallUtterance'
      | 'onVoiceCallUtteranceCancel'
      | 'onVoiceCallTimeline'
    >
  >
