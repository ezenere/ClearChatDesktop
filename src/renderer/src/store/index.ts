import { create } from 'zustand'
import type {
  AgentEvent,
  ApiMessage,
  ApprovalRequest,
  ApprovalSettings,
  AttachmentInfo,
  Chat,
  ChatConfig,
  ModelInfo,
  Preset,
  ProcessInfo,
  Provider,
  QueuedMessage,
  QuestionAnswer,
  QuestionRequest,
  RetryRequest,
  Session,
  StoredMessage,
  StreamDraft
} from '@shared/types'
import type {
  AppCapabilities,
  ApprovalDecision,
  PresetInput,
  ViewerTarget,
  VoiceCallTimelineEvent
} from '@shared/ipc'
import type { MemoryCollection } from '@shared/memory'
import type {
  ChatHostInfo,
  LiveChatView,
  NewChatStorage,
  SyncScope,
  SyncStatus
} from '@shared/sync'
import { api, errorMessage } from '../lib/api'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import { contentText, formatSize } from '@shared/attachments'
import { setToolShellInfo } from '@shared/shellInfo'
import { normalizeApprovalSettings, type ApprovalItemDecision } from '@shared/approvalPolicy'
import { touchedUnits, withoutUnits } from '@shared/chatInherit'
import { trackFailure, type SubFailure } from '../lib/subFailures'
import type { UpdateStatus } from '@shared/updates'
import type { VoiceMessageMeta } from '@shared/voiceCallMarks'
import { createBranchSelects } from '../lib/branchSelects'
import { loadVoiceSettings } from '../lib/voice/voiceSettings'
import { canAutoOpen } from '../lib/fileSources'
import { nextReasoningClock, type ReasoningClock } from '../lib/reasoning'
import { VOICE_CALL_INACTIVE, type VoiceCallState } from '@shared/voice'

export type View = { kind: 'new' } | { kind: 'chat'; chatId: string; sessionId: string }

export interface AppSettings {
  defaultProviderId: string | null
  defaultModel: string | null
  defaultSystemPrompt: string | null
  defaultCwd: string | null
  /** Persona selecionada por padrão no Novo chat. */
  defaultPresetId: string | null
  /** Versão cujo aviso de atualização foi dispensado (local; não sincroniza). */
  updateDismissedVersion: string | null
  /** Título automático (valor cru; ler com normalizeAutoTitleSettings). Sincroniza (protocolo 1.4.0). */
  autoTitle: unknown
}

export interface ToolRun {
  running: boolean
  output?: string
  /** Smart-Approve avaliando a chamada. */
  judging?: boolean
}

export interface ModelsEntry {
  status: 'loading' | 'ok' | 'error'
  list: ModelInfo[]
  error?: string
}

export interface Toast {
  id: number
  kind: 'error' | 'info' | 'success'
  text: string
}

export type { SubFailure }

export type SettingsTab =
  | 'account'
  | 'providers'
  | 'presets'
  | 'defaults'
  | 'approvals'
  | 'memory'
  | 'skills'
  | 'web'
  | 'audio'

/**
 * Destinos de `setSettingsOpen` além das abas: sub-telas (`audio:local` = Configurações → Áudio →
 * "Modelos locais", com "← Áudio").
 */
export type SettingsTarget = SettingsTab | 'audio:local'

/** Sub-tela da aba Áudio (principal ou "Modelos locais" — CPU + GPU). */
export type AudioSettingsView = 'main' | 'local'

export type PanelTab = 'model' | 'chat' | 'tools' | 'memory' | 'voice' | 'files'

const PANEL_TABS: PanelTab[] = ['model', 'chat', 'tools', 'memory', 'voice', 'files']

/** Alvo de "abrir em Configurações → Memórias" (link de tool, card de extração, painel). */
export interface MemoryFocus {
  memoryId?: string
  collectionId?: string
}
const PANEL_TAB_KEY = 'clearchat.panelTab'

/** Seção do painel → aba onde ela mora (focusConfig). */
const SECTION_TAB: Record<string, PanelTab> = {
  contexto: 'chat',
  'contexto-janela': 'chat',
  raiz: 'chat',
  'smart-approve': 'tools',
  aprovacoes: 'tools',
  memoria: 'memory',
  'memoria-subagentes': 'memory',
  skills: 'tools',
  'skills-subagentes': 'tools',
  'voice-call': 'voice'
}

function loadPanelTab(): PanelTab {
  try {
    const v = localStorage.getItem(PANEL_TAB_KEY) as PanelTab | null
    return v && PANEL_TABS.includes(v) ? v : 'model'
  } catch {
    return 'model'
  }
}

function savePanelTab(tab: PanelTab): void {
  try {
    localStorage.setItem(PANEL_TAB_KEY, tab)
  } catch {
    /* armazenamento indisponível: só não lembra */
  }
}

/** Arquivo ativo do visualizador de um chat (painel entre o chat e as configurações). */
export interface ActiveFile {
  target: ViewerTarget
  /** Caminho absoluto (destaque do card / da aba Arquivos). */
  path: string
  name: string
  /** Incrementa em "Recarregar" e ao reabrir o mesmo arquivo. */
  nonce: number
}

const VIEWER_WIDTH_KEY = 'clearchat.viewer.width'
export const VIEWER_DEFAULT_WIDTH = 520

function loadViewerWidth(): number {
  try {
    const v = Number(localStorage.getItem(VIEWER_WIDTH_KEY))
    return Number.isFinite(v) && v >= 240 ? v : VIEWER_DEFAULT_WIDTH
  } catch {
    return VIEWER_DEFAULT_WIDTH
  }
}

function saveViewerWidth(w: number): void {
  try {
    localStorage.setItem(VIEWER_WIDTH_KEY, String(Math.round(w)))
  } catch {
    /* armazenamento indisponível: só não lembra */
  }
}

/** Anexo no composer: carregando (indo para o store do main) ou pronto para enviar. */
export interface PendingAttachment {
  id: string
  name: string
  size: number
  status: 'loading' | 'ready'
  info?: AttachmentInfo
}

/** Compactação em andamento/agendada por sessão (evento `compaction`). */
export interface CompactionState {
  state: 'scheduled' | 'running'
  text: string
}

interface State {
  booted: boolean
  providers: Provider[]
  chats: Chat[]
  /** Personas (presets de chat). */
  presets: Preset[]
  settings: AppSettings
  homeDir: string | null
  view: View
  /** Todas as sessões conhecidas, por id. */
  sessions: Record<string, Session>
  /** Mensagens por sessão (só sessões já carregadas). */
  messages: Record<string, StoredMessage[]>
  drafts: Record<string, StreamDraft | null>
  /** Relógio do "Pensando… N s" do rascunho de cada sessão (lib/reasoning.ts). */
  reasoningClocks: Record<string, ReasoningClock | undefined>
  toolRuns: Record<string, Record<string, ToolRun>>
  queues: Record<string, QueuedMessage[]>
  approvals: ApprovalRequest[]
  /** Questionários pendentes (ask_user). */
  questions: QuestionRequest[]
  /** Falhas de conexão com o provedor aguardando "Tentar de novo" / "Cancelar". */
  retries: RetryRequest[]
  errors: Record<string, string | undefined>
  models: Record<string, ModelsEntry>
  panelOpen: boolean
  panelTab: PanelTab
  settingsOpen: boolean
  settingsTab: SettingsTab
  /** Sub-tela de Configurações → Áudio (volta a 'main' ao trocar de aba). */
  settingsAudioView: AudioSettingsView
  previewSessionId: string | null
  toasts: Toast[]
  compactions: Record<string, CompactionState | undefined>
  /** Incrementado a cada resultado de tool num chat (aba Arquivos recarrega). */
  fsTick: Record<string, number>
  /** Arquivo ativo do visualizador por chat (só nesta execução; ausente = painel fechado). */
  viewer: Record<string, ActiveFile | undefined>
  /** Largura do painel de arquivo (px; lembrada em localStorage). */
  viewerWidth: number
  capabilities: AppCapabilities
  /** Seção do painel Config para rolar até (ex.: 'contexto'). */
  configFocus: string | null
  /** Anexos ainda não enviados, por sessão (composer). */
  pendingAttachments: Record<string, PendingAttachment[]>
  /** Processos em segundo plano (process_start) por chat (evento `processes-updated`). */
  processes: Record<string, ProcessInfo[]>
  /** Aprovações: modos globais por item + listas globais. */
  approvalSettings: ApprovalSettings
  /** Visibilidade dos cards-âncora do chat aberto (IntersectionObserver) — ver lib/approvalAnchors. */
  anchorVis: Record<string, boolean | null>
  /** Falhas de subagentes por subsessão (vermelho na sidebar / aviso acima do composer). */
  subFailures: Record<string, SubFailure>
  /** Coleções de memória (compartilhadas e de chats), com contagem. */
  memoryCollections: MemoryCollection[]
  /** Incrementado a cada `memory-changed` (listas e preview recarregam). */
  memoryTick: number
  /** Coleção/memória a abrir em Configurações → Memórias. */
  memoryFocus: MemoryFocus | null
  /** Incrementado a cada `skills-changed` (listas de skills recarregam). */
  skillsTick: number
  /** Skill a destacar/abrir em Configurações → Skills (nome). */
  skillsFocus: string | null
  /** Skills escolhidas na lâmpada do composer, ainda não enviadas (por sessão; nomes). */
  pendingSkills: Record<string, string[]>
  /** Sync: conta/conexão (null = ainda não carregado). */
  sync: SyncStatus | null
  /** Sync: host de execução / divergência por chat. */
  chatHosts: Record<string, ChatHostInfo>
  /** Chats só ao vivo de OUTROS dispositivos (§23 — só memória). */
  liveChats: LiveChatView[]
  /** Chat ao vivo sendo aberto (histórico vindo do host). */
  liveOpening: Record<string, boolean>
  /** Mensagem indo para o host (controle remoto), por sessão: "enviando…". */
  remoteSending: Record<string, string | undefined>
  /** Avisos do sync por chat (ex.: "o dispositivo remoto caiu"). */
  chatNotices: Record<
    string,
    { text: string; kind: 'info' | 'error' | 'success'; at: number } | undefined
  >
  /** Versão instalada + última checagem de atualização (null = ainda não carregado). */
  update: UpdateStatus | null
  /** Aviso "Atualize <dispositivo> para usar versões de mensagens" dispensado (só nesta execução). */
  outdatedHostsDismissed: boolean
  /** Chamada de voz (meia-duplex) — espelho do estado do main (`voice:call:state`). */
  voiceCall: VoiceCallState
  /** Timeline da chamada de voz atual (eventos do main + do sensor; zerada a cada chamada). */
  voiceCallTimeline: VoiceCallTimelineEvent[]
}

interface Actions {
  boot(): Promise<void>
  refreshProviders(): Promise<void>
  refreshPresets(): Promise<void>
  /** Cria (sem id) ou atualiza uma persona; retorna a persona salva (ou null em erro). */
  savePreset(input: PresetInput, id?: string): Promise<Preset | null>
  deletePreset(id: string): Promise<void>
  duplicatePreset(id: string): Promise<Preset | null>
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>
  /** Várias de uma vez (ex.: o par defaultProviderId + defaultModel). */
  setSettings(patch: Partial<AppSettings>): Promise<void>
  /** "Verificar atualizações" (Configurações). Falha fica no estado, sem toast. */
  checkUpdates(): Promise<void>
  /** "Baixar": abre a página da release no navegador. */
  openRelease(): Promise<void>
  /** Dispensa o aviso da sidebar para a versão atual (volta numa versão maior). */
  dismissUpdate(): Promise<void>
  goNew(): void
  openChat(chatId: string, sessionId?: string): Promise<void>
  openSession(sessionId: string): Promise<void>
  loadMessages(sessionId: string, force?: boolean): Promise<void>
  createChat(input: {
    title?: string
    config: Partial<ChatConfig>
    storage?: NewChatStorage
  }): Promise<Chat | null>
  /** Abre um chat só ao vivo de outro dispositivo (carrega o histórico do host). */
  openLiveChat(chatId: string): Promise<void>
  /** "Salvar online" (§23.8). */
  saveOnline(chatId: string): Promise<boolean>
  /** "Tirar do servidor" (§23.8). */
  takeOffServer(chatId: string): Promise<boolean>
  renameChat(chatId: string, title: string): Promise<void>
  /** "Gerar título" (modelo do título de Configurações → Novos chats). */
  generateTitle(chatId: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  patchConfig(chatId: string, patch: Partial<ChatConfig>): void
  flushConfig(chatId: string): Promise<void>
  /**
   * "Voltar a herdar" (herança ao vivo da persona, protocolo 1.10.0): as unidades saem de
   * `overrides` e passam a seguir a persona de origem. Salva na hora (sem o debounce).
   */
  revertUnits(chatId: string, units: readonly string[]): Promise<void>
  /**
   * Troca a persona do chat (mantém os campos próprios; os herdados seguem a nova) ou `null` =
   * nenhuma (congela os valores atuais). `inheritAll`: tudo volta a herdar (ex.: "Salvar como
   * persona" — a persona nova é igual ao chat).
   */
  setChatPersona(
    chatId: string,
    presetId: string | null,
    opts?: { inheritAll?: boolean }
  ): Promise<void>
  /** Relê os chats (config efetiva) e as sessões do aberto — persona/padrões/provedores mudaram. */
  refreshChats(): Promise<void>
  send(
    sessionId: string,
    text: string,
    attachments?: AttachmentInfo[],
    skills?: string[],
    /** `voice`: texto ditado no composer (`meta.voice` da mensagem). */
    opts?: { voice?: VoiceMessageMeta }
  ): Promise<boolean>
  /** Entra na chamada de voz do chat (só sessão principal; erros legíveis viram toast). */
  startVoiceCall(sessionId: string): Promise<boolean>
  /** Sai da chamada de voz (idempotente). */
  stopVoiceCall(): Promise<void>
  /** Mudo do microfone na chamada (captura pausada). */
  setVoiceCallMuted(muted: boolean): Promise<void>
  /** Espelho do estado da chamada (evento `voice:call:state` / retorno dos canais `voice:call:*`). */
  applyVoiceCallState(state: VoiceCallState): void
  /** Acrescenta um evento à timeline da chamada atual (sensor local ou canal `voice:call:timeline`). */
  pushVoiceCallTimeline(event: VoiceCallTimelineEvent): void
  /** Chips "Carregar skill" do composer. */
  setPendingSkills(sessionId: string, names: string[]): void
  /** Abre Configurações → Skills (opcionalmente destacando uma skill). */
  openSkills(name?: string | null): void
  /** Anexa arquivos (arrastar/colar) ao composer da sessão. */
  addFiles(sessionId: string, files: File[]): Promise<void>
  /** Seletor nativo de arquivos (main lê e salva). */
  pickFiles(sessionId: string): Promise<void>
  removeAttachment(sessionId: string, id: string): void
  clearAttachments(sessionId: string): void
  /** `items`: decisões por sub-comando do card do modo Listas. false = falhou (card continua). */
  approve(id: string, decision: ApprovalDecision, items?: ApprovalItemDecision[]): Promise<boolean>
  /** Substitui modos e/ou listas globais de aprovação. false = erro (toast). */
  updateApprovalSettings(patch: Partial<ApprovalSettings>): Promise<boolean>
  /** Envia as respostas do questionário; false se falhou (o formulário continua). */
  answerQuestion(id: string, answers: QuestionAnswer[]): Promise<boolean>
  /** Cancela o questionário (o agente para). */
  cancelQuestion(id: string): Promise<void>
  /** Card de falha de conexão: repete a chamada / termina o turno como erro. */
  retryConnection(id: string): Promise<void>
  cancelRetry(id: string): Promise<void>
  loadModels(providerId: string, force?: boolean): Promise<void>
  setPanel(open: boolean, tab?: PanelTab): void
  /** Abre um arquivo no visualizador do chat (vira o arquivo ativo). */
  openFile(chatId: string, target: ViewerTarget, path: string, name: string): void
  /** Fecha o painel de arquivo do chat. */
  closeFile(chatId: string): void
  /** Recarrega o arquivo ativo do chat. */
  reloadFile(chatId: string): void
  setViewerWidth(width: number, persist?: boolean): void
  setSettingsOpen(open: boolean, tab?: SettingsTarget): void
  /** Troca a sub-tela de Configurações → Áudio ("Modelos locais" ↔ principal). */
  setAudioSettingsView(view: AudioSettingsView): void
  setPreview(sessionId: string | null): void
  toast(text: string, kind?: Toast['kind']): void
  dismissToast(id: number): void
  dismissError(sessionId: string): void
  /** Compactar a conversa (idle → já; rodando → agenda). */
  compact(sessionId: string, retry?: boolean): Promise<void>
  focusConfig(section: string | null): void
  /** Recarrega os processos em segundo plano do chat. */
  loadProcesses(chatId: string): Promise<void>
  stopProcess(chatId: string, id: string): Promise<void>
  /** Aplica medidas de visibilidade dos cards-âncora (undefined = card desmontado). */
  setAnchorVis(patch: Record<string, boolean | null | undefined>): void
  /** Some o aviso de falha do subagente acima do composer. */
  dismissSubFailure(sessionId: string): void
  /** Recarrega as coleções de memória. */
  loadMemoryCollections(): Promise<void>
  /** Abre Configurações → Memórias (opcionalmente numa coleção/memória). */
  openMemory(focus?: MemoryFocus | null): void
  /** Executa uma chamada de API; em caso de erro mostra um toast e retorna undefined. */
  run<T>(fn: () => Promise<T>, label?: string): Promise<T | undefined>
  /** Recarrega estado do sync e hosts dos chats. */
  refreshSync(): Promise<void>
  /** Recarrega domínios alterados por mudanças remotas. */
  reloadScopes(scopes: SyncScope[]): Promise<void>
  dismissChatNotice(chatId: string): void
  /**
   * Edita uma mensagem digitada como NOVA VERSÃO (ramo irmão; a atual continua salva) e roda o
   * agente. false = falhou (toast).
   */
  editBranch(sessionId: string, messageId: string, message: ApiMessage): Promise<boolean>
  /**
   * Regenera, como nova versão, a resposta do turno que contém `messageId` (padrão: o último).
   * Resposta só com erros → substitui (decisão do runner).
   */
  regenerate(sessionId: string, messageId?: string): Promise<void>
  /**
   * Troca a versão ativa para a que passa por `messageId` (otimista; volta se o main recusar —
   * sessão ocupada ou subagente em segundo plano abaixo da bifurcação). false = recusado.
   */
  selectBranch(sessionId: string, messageId: string): Promise<boolean>
  dismissOutdatedHosts(): void
}

export type Store = State & Actions

// Patches de config ainda não salvos (debounce), por chat.
const pending = new Map<
  string,
  { patch: Partial<ChatConfig>; timer: ReturnType<typeof setTimeout> }
>()
let toastSeq = 0
let attachmentSeq = 0
let unsubscribe: (() => void) | null = null
/** Troca de versão otimista + confirmações fora de ordem (ver lib/branchSelects). */
const branchSelects = createBranchSelects({
  session: (sid) => useStore.getState().sessions[sid],
  messages: (sid) => useStore.getState().messages[sid],
  put: (session) =>
    useStore.setState((s) => ({ sessions: { ...s.sessions, [session.id]: session } })),
  call: (messageId) => api.agent.selectBranch(messageId)
})

const SETTINGS_KEYS: (keyof AppSettings)[] = [
  'defaultProviderId',
  'defaultModel',
  'defaultSystemPrompt',
  'defaultCwd',
  'defaultPresetId',
  'updateDismissedVersion',
  'autoTitle'
]

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
}

function upsertMessage(list: StoredMessage[], msg: StoredMessage): StoredMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id)
  if (idx >= 0) {
    const next = [...list]
    next[idx] = msg
    return next
  }
  const next = [...list, msg]
  if (list.length && list[list.length - 1].seq > msg.seq) next.sort((a, b) => a.seq - b.seq)
  return next
}

/**
 * Config com um patch de edição aplicado na hora (otimista): o valor novo e, num chat que herda a
 * persona (tem `overrides`), as unidades tocadas marcadas como próprias — como o main grava.
 */
function patchedConfig(cfg: ChatConfig, patch: Partial<ChatConfig>): ChatConfig {
  const next = { ...cfg, ...patch }
  if (cfg.overrides && typeof cfg.overrides === 'object') {
    const touched = touchedUnits(cfg, patch)
    if (touched.length)
      next.overrides = {
        ...cfg.overrides,
        ...Object.fromEntries(touched.map((u) => [u, true as const]))
      }
  }
  return next
}

/** Reaplica um patch local pendente sobre um chat que chegou do main. */
function withPending(chat: Chat): Chat {
  const p = pending.get(chat.id)
  return p ? { ...chat, config: patchedConfig(chat.config, p.patch) } : chat
}

/** Settings de "Novos chats" que a herança lê (mudá-las muda os chats que herdam). */
const INHERITED_SETTINGS: readonly string[] = [
  'defaultProviderId',
  'defaultModel',
  'defaultSystemPrompt'
]

export const useStore = create<Store>()((set, get) => ({
  booted: false,
  providers: [],
  chats: [],
  presets: [],
  settings: {
    defaultProviderId: null,
    defaultModel: null,
    defaultSystemPrompt: null,
    defaultCwd: null,
    defaultPresetId: null,
    updateDismissedVersion: null,
    autoTitle: null
  },
  homeDir: null,
  view: { kind: 'new' },
  sessions: {},
  messages: {},
  drafts: {},
  reasoningClocks: {},
  toolRuns: {},
  queues: {},
  approvals: [],
  questions: [],
  retries: [],
  errors: {},
  models: {},
  panelOpen: true,
  panelTab: loadPanelTab(),
  settingsOpen: false,
  settingsTab: 'providers',
  settingsAudioView: 'main',
  previewSessionId: null,
  toasts: [],
  compactions: {},
  fsTick: {},
  viewer: {},
  viewerWidth: loadViewerWidth(),
  capabilities: { bwrap: false, ripgrep: false },
  configFocus: null,
  pendingAttachments: {},
  processes: {},
  approvalSettings: normalizeApprovalSettings(null, null),
  anchorVis: {},
  subFailures: {},
  memoryCollections: [],
  memoryTick: 0,
  memoryFocus: null,
  skillsTick: 0,
  skillsFocus: null,
  pendingSkills: {},
  sync: null,
  chatHosts: {},
  liveChats: [],
  liveOpening: {},
  remoteSending: {},
  chatNotices: {},
  update: null,
  outdatedHostsDismissed: false,
  voiceCall: { ...VOICE_CALL_INACTIVE },
  voiceCallTimeline: [],

  async refreshSync() {
    try {
      const [status, hosts] = await Promise.all([api.sync.status(), api.sync.chatStates()])
      set({ sync: status, chatHosts: Object.fromEntries(hosts.map((h) => [h.chatId, h])) })
    } catch (err) {
      console.warn('[clearchat] sync:', errorMessage(err))
    }
  },

  async reloadScopes(scopes) {
    const g = get()
    // herança ao vivo da persona: persona ou padrões de "Novos chats" mudaram → a config efetiva dos
    // chats (e o modelo da sessão principal) muda sem o chat ser regravado (provedores: em
    // refreshProviders)
    if (!scopes.includes('chats') && (scopes.includes('presets') || scopes.includes('settings')))
      scopes = [...scopes, 'chats']
    const tasks: Promise<unknown>[] = []
    if (scopes.includes('providers')) tasks.push(g.refreshProviders())
    if (scopes.includes('presets')) tasks.push(g.refreshPresets())
    if (scopes.includes('settings'))
      tasks.push(
        Promise.all(SETTINGS_KEYS.map((k) => api.settings.get<string>(k).catch(() => null))).then(
          (values) =>
            set({
              settings: Object.fromEntries(
                SETTINGS_KEYS.map((k, i) => [k, values[i] ?? null])
              ) as unknown as AppSettings
            })
        )
      )
    if (scopes.includes('approvals'))
      tasks.push(
        api.approvals
          .getSettings()
          .then((r) => set({ approvalSettings: r }))
          .catch(() => undefined)
      )
    if (scopes.includes('chats'))
      tasks.push(
        api.chats
          .list()
          .then((chats) => {
            set((s) => {
              const ids = new Set(chats.map((c) => c.id))
              const view =
                s.view.kind === 'chat' && !ids.has(s.view.chatId)
                  ? { kind: 'new' as const }
                  : s.view
              return { chats: sortChats(chats.map(withPending)), view }
            })
          })
          .catch(() => undefined)
      )
    if (scopes.includes('memory')) {
      set((s) => ({ memoryTick: s.memoryTick + 1 }))
      tasks.push(g.loadMemoryCollections())
    }
    if (scopes.includes('skills')) set((s) => ({ skillsTick: s.skillsTick + 1 }))
    // settings de áudio vindas do sync (1.5.0): relê o espelho único (Configurações → Áudio, chamada)
    if (scopes.includes('voice')) tasks.push(loadVoiceSettings().catch(() => undefined))
    await Promise.all(tasks)
    // chat aberto: sessões novas (subagentes vindos do host)
    const v = get().view
    if (scopes.includes('chats') && v.kind === 'chat') {
      const sessions = await api.sessions.list(v.chatId).catch(() => null)
      if (sessions)
        set((s) => {
          const next = { ...s.sessions }
          for (const ss of sessions)
            next[ss.id] =
              s.sessions[ss.id]?.status !== ss.status && s.sessions[ss.id]
                ? { ...ss, status: s.sessions[ss.id].status }
                : ss
          return { sessions: next }
        })
    }
  },

  dismissChatNotice(chatId) {
    set((s) => ({ chatNotices: { ...s.chatNotices, [chatId]: undefined } }))
  },

  dismissOutdatedHosts() {
    set({ outdatedHostsDismissed: true })
  },

  async editBranch(sessionId, messageId, message) {
    const session = get().sessions[sessionId]
    if (session) await get().flushConfig(session.chatId)
    const remote = !!session && get().chatHosts[session.chatId]?.mode === 'remote'
    set((s) => ({
      errors: { ...s.errors, [sessionId]: undefined },
      ...(remote
        ? {
            remoteSending: {
              ...s.remoteSending,
              [sessionId]: contentText(message.content ?? '') || '…'
            }
          }
        : {})
    }))
    const ok = await get()
      .run(async () => {
        await api.agent.editBranch(messageId, message)
        return true
      }, 'Erro ao enviar a nova versão')
      .finally(() => {
        if (remote) set((s) => ({ remoteSending: { ...s.remoteSending, [sessionId]: undefined } }))
      })
    return !!ok
  },

  async regenerate(sessionId, messageId) {
    const session = get().sessions[sessionId]
    if (session) await get().flushConfig(session.chatId)
    set((s) => ({ errors: { ...s.errors, [sessionId]: undefined } }))
    await get().run(() => api.agent.regenerate(sessionId, messageId), 'Erro ao regenerar')
  },

  async selectBranch(sessionId, messageId) {
    try {
      await branchSelects.select(sessionId, messageId)
      return true
    } catch (err) {
      get().toast(`Não foi possível trocar de versão: ${errorMessage(err)}`, 'error')
      return false
    }
  },

  async run(fn, label) {
    try {
      return await fn()
    } catch (err) {
      get().toast(label ? `${label}: ${errorMessage(err)}` : errorMessage(err), 'error')
      return undefined
    }
  },

  async boot() {
    if (!unsubscribe) {
      const offs: (() => void)[] = [api.onEvent((e) => applyEvent(e))]
      const onVoiceCallState = api.onVoiceCallState
      if (onVoiceCallState) offs.push(onVoiceCallState((e) => get().applyVoiceCallState(e)))
      const onVoiceCallTimeline = api.onVoiceCallTimeline
      if (onVoiceCallTimeline) offs.push(onVoiceCallTimeline((e) => get().pushVoiceCallTimeline(e)))
      unsubscribe = () => {
        for (const off of offs) off()
      }
    }
    const safe = async <T>(p: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p()
      } catch (err) {
        console.warn('[clearchat] boot:', errorMessage(err))
        return fallback
      }
    }
    const [
      providers,
      chats,
      presets,
      homeDir,
      approvals,
      questions,
      retries,
      capabilities,
      approvalSettings,
      syncStatus,
      hostList,
      update,
      liveList,
      ...values
    ] = await Promise.all([
      safe(() => api.providers.list(), [] as Provider[]),
      safe(() => api.chats.list(), [] as Chat[]),
      safe(() => api.presets.list(), [] as Preset[]),
      safe(() => api.fs.homeDir(), null as string | null),
      safe(() => api.agent.pendingApprovals(), [] as ApprovalRequest[]),
      safe(() => api.questions.pending(), [] as QuestionRequest[]),
      safe(() => api.retries.pending(), [] as RetryRequest[]),
      safe(() => api.app.capabilities(), { bwrap: false, ripgrep: false } as AppCapabilities),
      safe(() => api.approvals.getSettings(), normalizeApprovalSettings(null, null)),
      safe(() => api.sync.status(), null as SyncStatus | null),
      safe(() => api.sync.chatStates(), [] as ChatHostInfo[]),
      safe(() => api.updates.status(), null as UpdateStatus | null),
      safe(() => api.sync.liveChats(), [] as LiveChatView[]),
      ...SETTINGS_KEYS.map((k) => safe(() => api.settings.get<string>(k), null))
    ])
    const settings = Object.fromEntries(
      SETTINGS_KEYS.map((k, i) => [k, values[i] ?? null])
    ) as unknown as AppSettings
    // descrição da tool `shell` com o shell detectado no main (mesmo texto da request)
    setToolShellInfo(capabilities.shell ?? null)
    set({
      providers,
      chats: sortChats(chats),
      presets,
      homeDir,
      approvals,
      questions,
      retries,
      capabilities,
      approvalSettings: approvalSettings as ApprovalSettings,
      sync: syncStatus as SyncStatus | null,
      chatHosts: Object.fromEntries((hostList as ChatHostInfo[]).map((h) => [h.chatId, h])),
      settings,
      // um `update-status` pode ter chegado durante o boot: fica o mais recente
      update: get().update?.checkedAt ? get().update : (update as UpdateStatus | null),
      liveChats: liveList as LiveChatView[],
      booted: true
    })
  },

  async refreshProviders() {
    const providers = await get().run(() => api.providers.list(), 'Erro ao carregar provedores')
    if (providers) set({ providers })
    // provedor apagado/trocado: o modelo e o cache herdados dos chats podem mudar
    if (providers) await get().refreshChats()
  },

  async refreshPresets() {
    const presets = await get().run(() => api.presets.list(), 'Erro ao carregar personas')
    if (presets) set({ presets })
  },

  async savePreset(input, id) {
    const preset = await get().run(
      () => (id ? api.presets.update(id, input) : api.presets.create(input)),
      'Erro ao salvar persona'
    )
    if (!preset) return null
    set((s) => ({
      presets: s.presets.some((p) => p.id === preset.id)
        ? s.presets.map((p) => (p.id === preset.id ? preset : p))
        : [...s.presets, preset]
    }))
    // os chats que herdam desta persona mudam junto
    if (id) void get().refreshChats()
    return preset
  },

  async deletePreset(id) {
    const ok = await get().run(async () => {
      await api.presets.delete(id)
      return true
    }, 'Erro ao apagar persona')
    if (!ok) return
    set((s) => ({
      presets: s.presets.filter((p) => p.id !== id),
      settings:
        s.settings.defaultPresetId === id ? { ...s.settings, defaultPresetId: null } : s.settings
    }))
    // os chats dela foram congelados no main (valores atuais, sem persona)
    await get().refreshChats()
  },

  async duplicatePreset(id) {
    const preset = await get().run(() => api.presets.duplicate(id), 'Erro ao duplicar persona')
    if (preset) set((s) => ({ presets: [...s.presets, preset] }))
    return preset ?? null
  },

  async setSetting(key, value) {
    set((s) => ({ settings: { ...s.settings, [key]: value } }))
    await get().run(() => api.settings.set(key, value), 'Erro ao salvar configuração')
    if (INHERITED_SETTINGS.includes(key)) await get().refreshChats()
  },

  async setSettings(patch) {
    set((s) => ({ settings: { ...s.settings, ...patch } }))
    await get().run(
      () => Promise.all(Object.entries(patch).map(([k, v]) => api.settings.set(k, v))),
      'Erro ao salvar configuração'
    )
    if (Object.keys(patch).some((k) => INHERITED_SETTINGS.includes(k))) await get().refreshChats()
  },

  async checkUpdates() {
    set((s) => ({ update: s.update ? { ...s.update, state: 'checking' } : s.update }))
    try {
      set({ update: await api.updates.check() })
    } catch (err) {
      console.warn('[clearchat] atualizações:', errorMessage(err))
      set((s) => ({ update: s.update ? { ...s.update, state: 'error' } : s.update }))
    }
  },

  async openRelease() {
    await get().run(() => api.updates.openRelease(), 'Erro ao abrir a página da versão')
  },

  async dismissUpdate() {
    const v = get().update?.latest?.version
    if (v) await get().setSetting('updateDismissedVersion', v)
  },

  goNew() {
    set({ view: { kind: 'new' } })
    void api.sync.setActiveChat(null).catch(() => undefined)
  },

  async openChat(chatId, sessionId) {
    const chat = get().chats.find((c) => c.id === chatId)
    if (!chat) return
    const target = sessionId ?? chat.mainSessionId
    set((s) => ({
      view: { kind: 'chat', chatId, sessionId: target },
      subFailures: markFailures(s.subFailures, chatId, target)
    }))
    void api.sync.setActiveChat(chatId).catch(() => undefined)
    const sessions = await get().run(() => api.sessions.list(chatId), 'Erro ao carregar sessões')
    if (sessions) {
      set((s) => {
        const next = { ...s.sessions }
        for (const ss of sessions) next[ss.id] = ss
        return { sessions: next }
      })
    }
    void get().loadProcesses(chatId)
    await get().loadMessages(target)
  },

  async loadProcesses(chatId) {
    try {
      const list = await api.processes.list(chatId)
      set((s) => ({ processes: { ...s.processes, [chatId]: list } }))
    } catch {
      /* sem processos */
    }
  },

  async stopProcess(chatId, id) {
    await get().run(() => api.processes.stop(chatId, id), 'Erro ao parar o processo')
  },

  async openSession(sessionId) {
    const session = get().sessions[sessionId]
    if (!session) return
    set((s) => ({
      view: { kind: 'chat', chatId: session.chatId, sessionId },
      subFailures: markFailures(s.subFailures, session.chatId, sessionId)
    }))
    await get().loadMessages(sessionId)
  },

  async loadMessages(sessionId, force) {
    if (!force && get().messages[sessionId]) return
    const [msgs, queue] = await Promise.all([
      get().run(() => api.sessions.messages(sessionId), 'Erro ao carregar mensagens'),
      api.agent.getQueue(sessionId).catch(() => [] as QueuedMessage[])
    ])
    set((s) => ({
      messages: { ...s.messages, [sessionId]: [...(msgs ?? [])].sort((a, b) => a.seq - b.seq) },
      queues: { ...s.queues, [sessionId]: queue }
    }))
  },

  async createChat(input) {
    const chat = await get().run(() => api.chats.create(input), 'Não foi possível criar o chat')
    if (!chat) return null
    set((s) => ({ chats: sortChats([chat, ...s.chats.filter((c) => c.id !== chat.id)]) }))
    await get().openChat(chat.id)
    return chat
  },

  async openLiveChat(chatId) {
    if (get().liveOpening[chatId]) return
    set((s) => ({ liveOpening: { ...s.liveOpening, [chatId]: true } }))
    try {
      // inscreve no stream antes de carregar (os `rec` do meio do carregamento ficam guardados)
      await api.sync.setActiveChat(chatId).catch(() => undefined)
      const chat = await get().run(
        () => api.sync.liveOpen(chatId),
        'Não foi possível abrir o chat ao vivo'
      )
      if (!chat) return
      set((s) => ({ chats: sortChats([chat, ...s.chats.filter((c) => c.id !== chat.id)]) }))
      await get().openChat(chat.id)
      // reaberto: o espelho em memória pode ter mudado enquanto o chat estava fora da tela
      await get().loadMessages(chat.mainSessionId, true)
    } finally {
      set((s) => ({ liveOpening: { ...s.liveOpening, [chatId]: false } }))
    }
  },

  async saveOnline(chatId) {
    const ok = await get().run(async () => {
      await api.sync.saveOnline(chatId)
      return true
    }, 'Não foi possível salvar online')
    if (ok) get().toast('Enviando o chat para o servidor…', 'info')
    return !!ok
  },

  async takeOffServer(chatId) {
    const ok = await get().run(async () => {
      await api.sync.takeOffServer(chatId)
      return true
    }, 'Não foi possível tirar o chat do servidor')
    if (ok) get().toast('Tirando o chat do servidor…', 'info')
    return !!ok
  },

  async renameChat(chatId, title) {
    set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? { ...c, title } : c)) }))
    const chat = await get().run(() => api.chats.update(chatId, { title }), 'Erro ao renomear')
    if (chat) set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? withPending(chat) : c)) }))
  },

  async generateTitle(chatId) {
    // erro do main já vem legível ("Não foi possível gerar o título: …")
    const chat = await get().run(() => api.chats.generateTitle(chatId))
    if (chat) set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? withPending(chat) : c)) }))
  },

  async deleteChat(chatId) {
    const ok = await get().run(async () => {
      await api.chats.delete(chatId)
      return true
    }, 'Erro ao apagar chat')
    if (!ok) return
    set((s) => {
      const view =
        s.view.kind === 'chat' && s.view.chatId === chatId ? { kind: 'new' as const } : s.view
      const sessions = Object.fromEntries(
        Object.entries(s.sessions).filter(([, ss]) => ss.chatId !== chatId)
      )
      return {
        chats: s.chats.filter((c) => c.id !== chatId),
        sessions,
        approvals: s.approvals.filter((a) => a.chatId !== chatId),
        questions: s.questions.filter((q) => q.chatId !== chatId),
        retries: s.retries.filter((r) => r.chatId !== chatId),
        subFailures: Object.fromEntries(
          Object.entries(s.subFailures).filter(([, f]) => f.chatId !== chatId)
        ),
        view
      }
    })
  },

  patchConfig(chatId, patch) {
    const prev = pending.get(chatId)
    if (prev) clearTimeout(prev.timer)
    const merged = { ...(prev?.patch ?? {}), ...patch }
    const timer = setTimeout(() => void get().flushConfig(chatId), 450)
    pending.set(chatId, { patch: merged, timer })
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, config: patchedConfig(c.config, patch) } : c
      )
    }))
  },

  async revertUnits(chatId, units) {
    await get().flushConfig(chatId)
    const cur = get().chats.find((c) => c.id === chatId)
    if (!cur || !units.length) return
    const chat = await get().run(
      () =>
        api.chats.update(chatId, {
          config: { overrides: withoutUnits(cur.config.overrides, units) }
        }),
      'Erro ao voltar a herdar da persona'
    )
    if (chat) set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? withPending(chat) : c)) }))
    await get().refreshChats()
  },

  async setChatPersona(chatId, presetId, opts) {
    await get().flushConfig(chatId)
    const chat = await get().run(
      () =>
        api.chats.update(chatId, {
          config: { presetId: presetId as string, ...(opts?.inheritAll ? { overrides: {} } : {}) }
        }),
      'Erro ao trocar a persona do chat'
    )
    if (chat) set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? withPending(chat) : c)) }))
    await get().refreshChats()
  },

  async refreshChats() {
    await get().reloadScopes(['chats'])
  },

  async flushConfig(chatId) {
    const p = pending.get(chatId)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(chatId)
    const chat = await get().run(
      () => api.chats.update(chatId, { config: p.patch }),
      'Erro ao salvar configuração do chat'
    )
    if (chat) set((s) => ({ chats: s.chats.map((c) => (c.id === chatId ? withPending(chat) : c)) }))
  },

  async send(sessionId, text, attachments, skills, opts) {
    const session = get().sessions[sessionId]
    if (session) await get().flushConfig(session.chatId)
    const remote = !!session && get().chatHosts[session.chatId]?.mode === 'remote'
    set((s) => ({
      errors: { ...s.errors, [sessionId]: undefined },
      ...(remote
        ? {
            remoteSending: {
              ...s.remoteSending,
              [sessionId]: text || attachments?.map((a) => a.name).join(', ') || '…'
            }
          }
        : {})
    }))
    const res = await get()
      .run(
        () =>
          opts?.voice
            ? api.agent.send(sessionId, text, attachments ?? [], skills ?? [], opts)
            : skills?.length
              ? api.agent.send(sessionId, text, attachments ?? [], skills)
              : attachments?.length
                ? api.agent.send(sessionId, text, attachments)
                : api.agent.send(sessionId, text),
        remote ? 'O host não recebeu a mensagem' : 'Falha ao enviar'
      )
      .finally(() => {
        if (remote) set((s) => ({ remoteSending: { ...s.remoteSending, [sessionId]: undefined } }))
      })
    return res !== undefined
  },

  async startVoiceCall(sessionId) {
    const voice = api.voice
    if (!voice) return false
    const session = get().sessions[sessionId]
    if (session) await get().flushConfig(session.chatId)
    try {
      const state = await voice.call.start({ sessionId })
      set({ voiceCall: state })
      return true
    } catch (err) {
      get().toast(errorMessage(err), 'error')
      return false
    }
  },

  async stopVoiceCall() {
    const voice = api.voice
    if (!voice) return
    try {
      set({ voiceCall: await voice.call.stop() })
    } catch (err) {
      get().toast(errorMessage(err), 'error')
    }
  },

  async setVoiceCallMuted(muted) {
    const voice = api.voice
    if (!voice) return
    try {
      set({ voiceCall: await voice.call.mute({ muted }) })
    } catch (err) {
      get().toast(errorMessage(err), 'error')
    }
  },

  applyVoiceCallState(state) {
    // chamada nova (inativo→ativo) e fim da chamada zeram a timeline da chamada atual
    const prev = get().voiceCall
    const fresh = state.active && !prev.active
    set({
      voiceCall: state,
      voiceCallTimeline: fresh || !state.active ? [] : get().voiceCallTimeline
    })
    // a chamada terminou por falha (API de voz/modelo): o motivo vira toast — a barra some e o
    // composer volta com o rascunho
    if (prev.active && !state.active && state.error)
      get().toast(`Chamada encerrada: ${state.error}`, 'error')
  },

  pushVoiceCallTimeline(event) {
    // teto da lista (a UI mostra a chamada atual; o log de avaliação guarda o histórico)
    set((s) => ({
      voiceCallTimeline: [...s.voiceCallTimeline, event].slice(-500)
    }))
  },

  setPendingSkills(sessionId, names) {
    set((s) => ({ pendingSkills: { ...s.pendingSkills, [sessionId]: names } }))
  },

  openSkills(name) {
    set({ settingsOpen: true, settingsTab: 'skills', skillsFocus: name ?? null })
  },

  async addFiles(sessionId, files) {
    const setList = (fn: (l: PendingAttachment[]) => PendingAttachment[]): void =>
      set((s) => ({
        pendingAttachments: {
          ...s.pendingAttachments,
          [sessionId]: fn(s.pendingAttachments[sessionId] ?? [])
        }
      }))
    for (const file of files) {
      const count = get().pendingAttachments[sessionId]?.length ?? 0
      if (count >= ATTACHMENT_LIMITS.maxFiles) {
        get().toast(`No máximo ${ATTACHMENT_LIMITS.maxFiles} anexos por mensagem.`, 'error')
        return
      }
      if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
        get().toast(
          `"${file.name}" tem ${formatSize(file.size)} — o limite por arquivo é ${formatSize(ATTACHMENT_LIMITS.maxFileBytes)}.`,
          'error'
        )
        continue
      }
      const id = `att-${++attachmentSeq}`
      setList((l) => [...l, { id, name: file.name, size: file.size, status: 'loading' }])
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        // chat só ao vivo de outro dispositivo: o arquivo vai direto ao host (attach.put) — nada
        // é gravado aqui (§23.7)
        const chatId = get().sessions[sessionId]?.chatId
        const viewer = !!chatId && !!get().chats.find((c) => c.id === chatId)?.liveViewer
        const info = viewer
          ? await api.sync.liveAttach(chatId!, file.name, file.type || undefined, data)
          : await api.attachments.add({ name: file.name, mime: file.type, data })
        setList((l) => l.map((a) => (a.id === id ? { ...a, status: 'ready', info } : a)))
      } catch (err) {
        setList((l) => l.filter((a) => a.id !== id))
        get().toast(errorMessage(err), 'error')
      }
    }
  },

  async pickFiles(sessionId) {
    const chatId = get().sessions[sessionId]?.chatId
    if (chatId && get().chats.find((c) => c.id === chatId)?.liveViewer) {
      // chat ao vivo de outro dispositivo: escolhe aqui e envia ao host (sem salvar no store local)
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.onchange = () => {
        const files = [...(input.files ?? [])]
        if (files.length) void get().addFiles(sessionId, files)
      }
      input.click()
      return
    }
    const r = await get().run(() => api.attachments.pick(), 'Falha ao anexar')
    if (!r) return
    for (const e of r.errors) get().toast(e, 'error')
    if (!r.items.length) return
    set((s) => {
      const cur = s.pendingAttachments[sessionId] ?? []
      const room = Math.max(0, ATTACHMENT_LIMITS.maxFiles - cur.length)
      if (r.items.length > room)
        setTimeout(() =>
          get().toast(`No máximo ${ATTACHMENT_LIMITS.maxFiles} anexos por mensagem.`, 'error')
        )
      const added = r.items.slice(0, room).map((info): PendingAttachment => ({
        id: `att-${++attachmentSeq}`,
        name: info.name,
        size: info.size,
        status: 'ready',
        info
      }))
      return { pendingAttachments: { ...s.pendingAttachments, [sessionId]: [...cur, ...added] } }
    })
  },

  removeAttachment(sessionId, id) {
    set((s) => ({
      pendingAttachments: {
        ...s.pendingAttachments,
        [sessionId]: (s.pendingAttachments[sessionId] ?? []).filter((a) => a.id !== id)
      }
    }))
  },

  clearAttachments(sessionId) {
    set((s) => ({ pendingAttachments: { ...s.pendingAttachments, [sessionId]: [] } }))
  },

  async approve(id, decision, items) {
    try {
      await api.agent.approve(id, decision, items)
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }))
      return true
    } catch (err) {
      get().toast(`Falha ao responder aprovação: ${errorMessage(err)}`, 'error')
      return false
    }
  },

  async updateApprovalSettings(patch) {
    const r = await get().run(
      () => api.approvals.updateSettings(patch),
      'Erro ao salvar aprovações'
    )
    if (r) set({ approvalSettings: r })
    return !!r
  },

  async answerQuestion(id, answers) {
    const ok = await get().run(async () => {
      await api.questions.answer(id, answers)
      return true
    }, 'Falha ao enviar as respostas')
    if (ok) set((s) => ({ questions: s.questions.filter((q) => q.id !== id) }))
    return !!ok
  },

  async cancelQuestion(id) {
    await get().run(() => api.questions.cancel(id), 'Falha ao cancelar o questionário')
  },

  async retryConnection(id) {
    const ok = await get().run(async () => {
      await api.retries.retry(id)
      return true
    }, 'Falha ao tentar de novo')
    if (ok) set((s) => ({ retries: s.retries.filter((r) => r.id !== id) }))
  },

  async cancelRetry(id) {
    await get().run(() => api.retries.cancel(id), 'Falha ao cancelar')
  },

  async loadModels(providerId, force) {
    const cur = get().models[providerId]
    if (!force && cur && cur.status !== 'error') return
    set((s) => ({
      models: { ...s.models, [providerId]: { status: 'loading', list: cur?.list ?? [] } }
    }))
    try {
      const list = await api.providers.listModels(providerId)
      const sorted = [...list].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
      set((s) => ({ models: { ...s.models, [providerId]: { status: 'ok', list: sorted } } }))
    } catch (err) {
      set((s) => ({
        models: {
          ...s.models,
          [providerId]: { status: 'error', list: [], error: errorMessage(err) }
        }
      }))
    }
  },

  setPanel(open, tab) {
    if (tab) savePanelTab(tab)
    set((s) => ({ panelOpen: open, panelTab: tab ?? s.panelTab }))
  },
  openFile(chatId, target, path, name) {
    set((s) => ({
      viewer: {
        ...s.viewer,
        [chatId]: { target, path, name, nonce: (s.viewer[chatId]?.nonce ?? 0) + 1 }
      }
    }))
  },
  closeFile(chatId) {
    set((s) => ({ viewer: { ...s.viewer, [chatId]: undefined } }))
  },
  reloadFile(chatId) {
    set((s) => {
      const f = s.viewer[chatId]
      return f ? { viewer: { ...s.viewer, [chatId]: { ...f, nonce: f.nonce + 1 } } } : {}
    })
  },
  setViewerWidth(width, persist) {
    set({ viewerWidth: width })
    if (persist) saveViewerWidth(width)
  },
  setSettingsOpen(open, tab) {
    if (tab === 'audio:local')
      return set({ settingsOpen: open, settingsTab: 'audio', settingsAudioView: 'local' })
    // aba explícita = a tela principal dela (sem aba: reabre onde estava)
    set((s) => ({
      settingsOpen: open,
      settingsTab: tab ?? s.settingsTab,
      ...(tab ? { settingsAudioView: 'main' as const } : {})
    }))
  },
  setAudioSettingsView(view) {
    set({ settingsAudioView: view })
  },
  setPreview(sessionId) {
    set({ previewSessionId: sessionId })
  },

  toast(text, kind = 'info') {
    // mesmo aviso repetido (ex.: vários chats do mesmo host caíram): um toast só
    if (get().toasts.some((t) => t.text === text && t.kind === kind)) return
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3000)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
  dismissError(sessionId) {
    set((s) => ({ errors: { ...s.errors, [sessionId]: undefined } }))
  },

  async compact(sessionId, retry) {
    const session = get().sessions[sessionId]
    if (session) await get().flushConfig(session.chatId)
    set((s) => ({ errors: { ...s.errors, [sessionId]: undefined } }))
    const r = await get().run(
      () => api.agent.compact(sessionId, retry ? { retry: true } : undefined),
      'Não foi possível compactar'
    )
    if (r?.scheduled) get().toast('Compactação agendada para o próximo passo do agente.')
  },

  setAnchorVis(patch) {
    set((s) => {
      let changed = false
      const next = { ...s.anchorVis }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          if (k in next) {
            delete next[k]
            changed = true
          }
        } else if (next[k] !== v) {
          next[k] = v
          changed = true
        }
      }
      return changed ? { anchorVis: next } : {}
    })
  },

  dismissSubFailure(sessionId) {
    set((s) => {
      const f = s.subFailures[sessionId]
      if (!f || f.dismissed) return {}
      return {
        subFailures: { ...s.subFailures, [sessionId]: { ...f, dismissed: true, seen: true } }
      }
    })
  },

  async loadMemoryCollections() {
    try {
      const list = await api.memory.listCollections()
      set({ memoryCollections: list })
    } catch (err) {
      console.warn('[clearchat] memória:', errorMessage(err))
    }
  },

  openMemory(focus) {
    set({ settingsOpen: true, settingsTab: 'memory', memoryFocus: focus ?? null })
  },

  focusConfig(section) {
    if (!section) return set({ configFocus: null })
    const panelTab = SECTION_TAB[section] ?? 'model'
    savePanelTab(panelTab)
    set({ configFocus: section, panelOpen: true, panelTab })
  }
}))

/** Abrir o chat marca as falhas dele como vistas (sidebar); abrir a subsessão que falhou a dispensa. */
function markFailures(
  list: Record<string, SubFailure>,
  chatId: string,
  sessionId: string
): Record<string, SubFailure> {
  let next: Record<string, SubFailure> | null = null
  for (const [id, f] of Object.entries(list)) {
    if (f.chatId !== chatId) continue
    const dismissed = f.dismissed || id === sessionId
    if (f.seen && dismissed === f.dismissed) continue
    next ??= { ...list }
    next[id] = { ...f, seen: true, dismissed }
  }
  return next ?? list
}

function applyEvent(e: AgentEvent): void {
  const set = useStore.setState
  switch (e.type) {
    case 'session-created':
    case 'session-updated':
      set((s) => {
        const prev = s.sessions[e.session.id]
        // troca de versão pendente: a seleção otimista da mais recente fica (lib/branchSelects)
        const session = branchSelects.incoming(e.session)
        const subFailures = trackFailure(s.subFailures, prev, session, s.view, s.errors[session.id])
        return { sessions: { ...s.sessions, [session.id]: session }, subFailures }
      })
      break
    case 'session-deleted':
      set((s) => {
        const drop = <T>(rec: Record<string, T>): Record<string, T> => {
          if (!(e.sessionId in rec)) return rec
          const next = { ...rec }
          delete next[e.sessionId]
          return next
        }
        let view = s.view
        if (view.kind === 'chat' && view.sessionId === e.sessionId) {
          const chat = s.chats.find((c) => c.id === e.chatId)
          view = chat ? { kind: 'chat', chatId: chat.id, sessionId: chat.mainSessionId } : view
        }
        return {
          sessions: drop(s.sessions),
          messages: drop(s.messages),
          drafts: drop(s.drafts),
          reasoningClocks: drop(s.reasoningClocks),
          toolRuns: drop(s.toolRuns),
          queues: drop(s.queues),
          errors: drop(s.errors),
          approvals: s.approvals.filter((a) => a.sessionId !== e.sessionId),
          questions: s.questions.filter((q) => q.sessionId !== e.sessionId),
          retries: s.retries.filter((r) => r.sessionId !== e.sessionId),
          subFailures: drop(s.subFailures),
          view
        }
      })
      {
        const v = useStore.getState().view
        if (v.kind === 'chat') void useStore.getState().loadMessages(v.sessionId)
      }
      break
    case 'message-added':
    case 'message-updated': {
      const sid = e.message.sessionId
      set((s) => {
        const list = s.messages[sid]
        // Resultado de tool (nativo ou em texto) → a aba Arquivos do chat recarrega.
        const m = e.message.message
        const isToolResult =
          e.type === 'message-added' &&
          (m.role === 'tool' ||
            (m.role === 'user' && contentText(m.content).startsWith('<tool_result')))
        const chatId = s.sessions[sid]?.chatId
        const fsTick =
          isToolResult && chatId ? { ...s.fsTick, [chatId]: (s.fsTick[chatId] ?? 0) + 1 } : s.fsTick
        // present_file acabou de rodar: o 1º arquivo vira o ativo do chat (se dá para abrir aqui)
        let viewer = s.viewer
        const rec = e.message.meta.presentFiles
        if (e.type === 'message-added' && m.role === 'tool' && rec && chatId) {
          const host = s.chatHosts[chatId]
          const index = rec.files.findIndex((f) => !f.error)
          if (
            index >= 0 &&
            canAutoOpen(
              rec,
              chatId,
              s.sync?.device?.id,
              {
                mode: host?.mode,
                name: host?.host?.name,
                deviceId: host?.host?.deviceId
              },
              s.view.kind === 'chat' && s.view.chatId === chatId
            )
          ) {
            const f = rec.files[index]
            viewer = {
              ...s.viewer,
              [chatId]: {
                target: { chatId, source: 'present', messageId: e.message.id, index },
                path: f.path,
                name: f.name,
                nonce: (s.viewer[chatId]?.nonce ?? 0) + 1
              }
            }
          }
        }
        if (!list) return fsTick === s.fsTick && viewer === s.viewer ? {} : { fsTick, viewer }
        return {
          messages: { ...s.messages, [sid]: upsertMessage(list, e.message) },
          fsTick,
          viewer
        }
      })
      break
    }
    case 'compaction':
      set((s) => ({
        compactions: {
          ...s.compactions,
          [e.sessionId]: e.state
            ? {
                state: e.state,
                text:
                  e.text ?? (e.state === 'running' ? (s.compactions[e.sessionId]?.text ?? '') : '')
              }
            : undefined
        }
      }))
      break
    case 'message-deleted':
      set((s) => {
        const list = s.messages[e.sessionId]
        if (!list) return {}
        return {
          messages: { ...s.messages, [e.sessionId]: list.filter((m) => m.id !== e.messageId) }
        }
      })
      break
    case 'draft':
      set((s) => {
        const prev = s.reasoningClocks[e.sessionId]
        const clock = nextReasoningClock(prev, e.draft, Date.now())
        return {
          drafts: { ...s.drafts, [e.sessionId]: e.draft },
          ...(clock !== prev
            ? { reasoningClocks: { ...s.reasoningClocks, [e.sessionId]: clock } }
            : {})
        }
      })
      break
    case 'tool-running':
      set((s) => {
        const runs = { ...(s.toolRuns[e.sessionId] ?? {}) }
        if (e.running && e.judging) runs[e.toolCallId] = { running: false, judging: true }
        else if (e.running)
          runs[e.toolCallId] = { running: true, output: e.output ?? runs[e.toolCallId]?.output }
        else delete runs[e.toolCallId]
        return { toolRuns: { ...s.toolRuns, [e.sessionId]: runs } }
      })
      break
    case 'queue-updated':
      set((s) => ({ queues: { ...s.queues, [e.sessionId]: e.queue } }))
      break
    case 'approval-requested':
      set((s) => ({
        approvals: [...s.approvals.filter((a) => a.id !== e.request.id), e.request]
      }))
      break
    case 'approval-resolved':
      set((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.id) }))
      break
    case 'approval-settings-updated':
      set({ approvalSettings: e.settings })
      break
    case 'question-requested':
      set((s) => ({
        questions: [...s.questions.filter((q) => q.id !== e.request.id), e.request]
      }))
      break
    case 'question-resolved':
      set((s) => ({ questions: s.questions.filter((q) => q.id !== e.id) }))
      break
    case 'retry-requested':
      set((s) => ({
        retries: [...s.retries.filter((r) => r.id !== e.request.id), e.request]
      }))
      break
    case 'retry-resolved':
      set((s) => ({ retries: s.retries.filter((r) => r.id !== e.id) }))
      break
    case 'chat-updated':
      set((s) => {
        const chat = withPending(e.chat)
        const exists = s.chats.some((c) => c.id === chat.id)
        return {
          chats: sortChats(
            exists ? s.chats.map((c) => (c.id === chat.id ? chat : c)) : [chat, ...s.chats]
          )
        }
      })
      break
    case 'error':
      set((s) => {
        const f = s.subFailures[e.sessionId]
        return {
          errors: { ...s.errors, [e.sessionId]: e.error },
          ...(f
            ? { subFailures: { ...s.subFailures, [e.sessionId]: { ...f, error: e.error } } }
            : {})
        }
      })
      break
    case 'processes-updated':
      set((s) => ({ processes: { ...s.processes, [e.chatId]: e.processes } }))
      break
    case 'memory-changed':
      set((s) => ({ memoryTick: s.memoryTick + 1 }))
      scheduleMemoryReload()
      break
    case 'skills-changed':
      set((s) => ({ skillsTick: s.skillsTick + 1 }))
      break
    case 'sync-status':
      set({ sync: e.status })
      break
    case 'sync-chat-state':
      set((s) => ({ chatHosts: { ...s.chatHosts, [e.info.chatId]: e.info } }))
      break
    case 'sync-live-chats':
      set({ liveChats: e.chats })
      break
    case 'sync-data-changed':
      scheduleScopes(e.scopes)
      break
    case 'chat-deleted':
      set((s) => {
        const view =
          s.view.kind === 'chat' && s.view.chatId === e.chatId ? { kind: 'new' as const } : s.view
        return {
          chats: s.chats.filter((c) => c.id !== e.chatId),
          sessions: Object.fromEntries(
            Object.entries(s.sessions).filter(([, ss]) => ss.chatId !== e.chatId)
          ),
          approvals: s.approvals.filter((a) => a.chatId !== e.chatId),
          questions: s.questions.filter((q) => q.chatId !== e.chatId),
          retries: s.retries.filter((r) => r.chatId !== e.chatId),
          view
        }
      })
      break
    case 'update-status':
      set({ update: e.status })
      break
    case 'sync-notice':
      useStore.getState().toast(e.text, e.kind)
      if (e.chatId) {
        const at = Date.now()
        const cid = e.chatId
        setTimeout(() => {
          if (useStore.getState().chatNotices[cid]?.at === at)
            useStore.getState().dismissChatNotice(cid)
        }, 5 * 60_000)
        set((s) => ({
          chatNotices: {
            ...s.chatNotices,
            [e.chatId!]: { text: e.text, kind: e.kind, at: at }
          }
        }))
      }
      break
  }
}

// Rajadas de `sync-data-changed` → uma recarga por domínio.
const pendingScopes = new Set<SyncScope>()
let scopesTimer: ReturnType<typeof setTimeout> | null = null
function scheduleScopes(scopes: SyncScope[]): void {
  for (const sc of scopes) pendingScopes.add(sc)
  if (scopesTimer) return
  scopesTimer = setTimeout(() => {
    scopesTimer = null
    const list = [...pendingScopes]
    pendingScopes.clear()
    void useStore.getState().reloadScopes(list)
  }, 120)
}

// Rajadas de `memory-changed` (extração grava várias) → uma recarga só das coleções.
let memoryReload: ReturnType<typeof setTimeout> | null = null
function scheduleMemoryReload(): void {
  if (memoryReload) clearTimeout(memoryReload)
  memoryReload = setTimeout(() => {
    memoryReload = null
    void useStore.getState().loadMemoryCollections()
  }, 120)
}

// ---- Seletores ----

const EMPTY_MESSAGES: StoredMessage[] = []
const EMPTY_QUEUE: QueuedMessage[] = []
const EMPTY_RUNS: Record<string, ToolRun> = {}
const EMPTY_ATTACHMENTS: PendingAttachment[] = []

export const selectMessages =
  (sessionId: string) =>
  (s: Store): StoredMessage[] =>
    s.messages[sessionId] ?? EMPTY_MESSAGES
export const selectQueue =
  (sessionId: string) =>
  (s: Store): QueuedMessage[] =>
    s.queues[sessionId] ?? EMPTY_QUEUE
export const selectRuns =
  (sessionId: string) =>
  (s: Store): Record<string, ToolRun> =>
    s.toolRuns[sessionId] ?? EMPTY_RUNS

export const selectPendingAttachments =
  (sessionId: string) =>
  (s: Store): PendingAttachment[] =>
    s.pendingAttachments[sessionId] ?? EMPTY_ATTACHMENTS

export const isBusy = (status: Session['status'] | undefined): boolean =>
  status === 'running' ||
  status === 'awaiting_approval' ||
  status === 'awaiting_input' ||
  status === 'awaiting_retry' ||
  status === 'waiting'

export const currentChat = (s: Store): Chat | undefined =>
  s.view.kind === 'chat'
    ? s.chats.find((c) => c.id === (s.view as { chatId: string }).chatId)
    : undefined

const EMPTY_PROCESSES: ProcessInfo[] = []
export const selectProcesses =
  (chatId: string) =>
  (s: Store): ProcessInfo[] =>
    s.processes[chatId] ?? EMPTY_PROCESSES

const EMPTY_SKILLS: string[] = []
export const selectPendingSkills =
  (sessionId: string) =>
  (s: Store): string[] =>
    s.pendingSkills[sessionId] ?? EMPTY_SKILLS
