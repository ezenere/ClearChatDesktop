// Tipos do sync compartilhados entre main e renderer (IPC `sync:*` e eventos). O protocolo em si
// está em docs/SYNC_PROTOCOL.md; o cliente roda no main (src/main/sync/).
import { COMPUTER_TOOL_NAMES } from './deviceTools'
import type { Session, StoredMessage } from './types'

/** Servidor oficial (padrão). Qualquer instância self-host funciona igual (§20). */
export const OFFICIAL_SYNC_URL = 'https://clear.ezenere.com'
export const OFFICIAL_SYNC_LABEL = 'clear.ezenere.com'
/** Faixa de versões do protocolo que este app fala. */
export const SYNC_PROTOCOL = 1

export type SyncServerKind = 'official' | 'self'

/** `GET <base>/api/info` validado. */
export interface SyncServerInfo {
  url: string
  name: string
  serverVersion?: string
  protocol: { min: number; max: number; version?: string }
  signupOpen: boolean
  captcha: boolean
  signupUrl?: string
  /** `http://` (sem criptografia de transporte). */
  insecure: boolean
  /** Instância com notificações push (`features.push` não nulo, desde 1.7.0). */
  push?: boolean
  /** Instância com chats só ao vivo (`features.liveChats`, desde 1.8.0, §23). */
  liveChats?: boolean
}

export type SyncConnection = 'disabled' | 'offline' | 'connecting' | 'online' | 'error'

/**
 * Fase da conta neste dispositivo:
 * - signed-out: sem conta
 * - locked: logado (tokens), mas a DEK não está em memória (pede a senha de criptografia)
 * - keys-not-ready: conta sem chaves (definir senha de criptografia no site)
 * - merge: desbloqueado, aguardando a escolha do primeiro login (priorizar online/local)
 * - ready: sincronizando
 */
export type SyncPhase = 'signed-out' | 'locked' | 'keys-not-ready' | 'merge' | 'ready'

export interface SyncMergeInfo {
  local: { providers: number; chats: number; presets: number; memories: number }
  online: { providers: number; chats: number; presets: number; memories: number }
  /** Chats que existem nos dois lados com histórias diferentes (a versão não priorizada é apagada). */
  conflictingChats: number
  /** Chats locais só ao vivo (§23): ficam fora do merge e continuam só neste dispositivo (§12). */
  liveChats?: number
}

/** Pergunta pendente do sync (diálogo). */
export type SyncPrompt = {
  kind: 'chat-gone'
  chatId: string
  title: string
}

export interface SyncStatus {
  phase: SyncPhase
  server: { kind: SyncServerKind; url: string; name: string | null; envOverride: boolean }
  account: { userId: string; email: string; name: string } | null
  device: { id: string; name: string } | null
  connection: SyncConnection
  /** Última sincronização completa (pull + push sem erro). */
  lastSyncAt: number | null
  /** Mudanças locais ainda não aceitas pelo servidor. */
  pending: number
  error: string | null
  /** Cota excedida: o app para de enviar (continua recebendo). */
  quota: string | null
  /** "Lembrar neste computador" (DEK no chaveiro do SO). */
  remember: boolean
  merge: SyncMergeInfo | null
  prompts: SyncPrompt[]
  /** Protocolo incompatível com o servidor (não sincroniza). */
  protocolError: string | null
  /**
   * Aparelhos desta conta que podem hospedar chats (desktop, can_host) com app < 0.7.0 — não
   * conhecem versões de mensagens (ramos): como host, o "regenerar" deles apaga as outras versões.
   * Vem do GET /devices (atualizado ao conectar e periodicamente). Vazio = nada a avisar.
   */
  outdatedHosts: { name: string; appVersion: string }[]
  /**
   * Avisos no celular (§22): `available` = o servidor tem push; `enabled` = preferência DESTE
   * computador ("Avisar no celular…", padrão ligado; local, §4.4).
   */
  push: { available: boolean; enabled: boolean }
  /**
   * Chats só ao vivo (§23): `supported` = servidor com `features.liveChats` e `welcome.caps` com
   * `live_chats` (a escolha "Salvar online"/"Só ao vivo" só aparece assim); `newChatStorage` = o
   * padrão deste dispositivo (a última escolha, §23.1).
   */
  live: { supported: boolean; newChatStorage: NewChatStorage }
}

/** Modo de um chat no host (§23.2; coluna local `chats.storage`, NULL = online). */
export type ChatStorage = 'online' | 'live' | 'live_pending'
/** Escolha ao criar um chat (§23.1). */
export type NewChatStorage = 'online' | 'live'

/** Status de um chat ao vivo no anúncio (§23.4). */
export type LiveChatStatus = 'idle' | 'running' | 'waiting'

/**
 * Chat só ao vivo de OUTRO dispositivo, como o visualizador o mostra (§23.4 — anúncio decifrado).
 * Nada disso é gravado (§23.5).
 */
export interface LiveChatView {
  chatId: string
  epoch: number
  title: string
  persona: { id: string; name: string; icon: string } | null
  model: { providerId: string | null; providerName: string | null; model: string | null }
  status: LiveChatStatus
  pending: { approvals: number; questions: number; retries: number }
  usesLocalTools: boolean
  hostCwd: string | null
  createdAt: number
  updatedAt: number
  messageCount: number | null
  running: boolean
  host: { deviceId: string; name: string; platform: string; status: 'online' | 'grace' }
  /** Sumiu da lista depois de uma reconexão e ainda está no prazo `settling_s` ("reconectando…"). */
  settling: boolean
}

export interface SyncDevice {
  id: string
  name: string
  platform: string
  client: string
  appVersion: string
  canHost: boolean
  createdAt: string
  lastSeenAt: string | null
  lastIp: string | null
  online: boolean
  current: boolean
  /** Recebe notificações push (celular com token; desde 1.7.0). */
  push: boolean
}

export type HostStatus = 'online' | 'grace' | 'offline'

/**
 * Como este dispositivo trata o chat (§8):
 * - off: sync desligado / bloqueado — tudo local
 * - local: este dispositivo é (ou será) o host
 * - remote: outro dispositivo online é o host → controle remoto
 * - host-offline: o host é outro dispositivo e está offline/caiu → só "Executar neste dispositivo"
 * - offline: sem conexão com o servidor — execução local (reconciliada depois)
 * - diverged: versões divergentes; nada sincroniza até escolher
 */
export type ChatHostMode = 'off' | 'local' | 'remote' | 'host-offline' | 'offline' | 'diverged'

export interface ChatHostInfo {
  chatId: string
  mode: ChatHostMode
  host: { deviceId: string; name: string; status: HostStatus; self: boolean } | null
  running: boolean
  pinned: boolean
  epoch: number
  handover: {
    toDeviceId: string
    toName: string
    mode: 'next_turn' | 'force'
    self: boolean
  } | null
  diverged: {
    divergenceId: string
    deviceId: string
    deviceName: string
    since: string
    /** Este dispositivo tem a versão local divergente. */
    self: boolean
  } | null
  usesLocalTools: boolean
  /** Raiz do chat no host (informativo). */
  hostCwd: { deviceId: string; path: string } | null
  /** Este dispositivo ainda não escolheu a raiz local do chat (pedir ao virar host). */
  needsCwd: boolean
  /** Modo do chat NESTE dispositivo (§23.2): só ao vivo no host. Ausente = online. */
  storage?: ChatStorage
  /**
   * Chat só ao vivo (§23): `role` = 'host' (guardado aqui) ou 'viewer' (de outro dispositivo, só em
   * memória). `announced` = visível nos outros agora (host); `unsupported` = o servidor não suporta
   * chats ao vivo (fica "Só neste dispositivo").
   */
  live?: {
    role: 'host' | 'viewer'
    announced: boolean
    unsupported: boolean
    hostName: string
    status: 'online' | 'grace' | 'offline'
  }
}

export interface CloudSkill {
  name: string
  description: string
  recordId: string
  size: number
  files: number
  updatedAt: number
  /** Neste dispositivo: pasta de origem acompanhada, cópia baixada ou nada. */
  local: 'source' | 'copy' | null
}

export interface DivergenceVersion {
  sessions: Session[]
  messages: Record<string, StoredMessage[]>
}

export interface DivergenceDetails {
  chatId: string
  online: DivergenceVersion
  /** Só no dispositivo que tem a versão local divergente. */
  local: DivergenceVersion | null
  /** Mensagens que só existem em cada versão (+ data da mais antiga delas). */
  onlyOnline: { count: number; since: number | null }
  onlyLocal: { count: number; since: number | null }
}

/** O que mudou nas tabelas locais por causa do sync (o renderer recarrega). */
export type SyncScope =
  | 'providers'
  | 'presets'
  | 'settings'
  | 'chats'
  | 'memory'
  | 'skills'
  | 'approvals'
  | 'webSearch'
  /**
   * Settings de áudio deste dispositivo (`audioInput`, `sttSettings`, `ttsSettings`,
   * `voiceCallDefaults`): locais desde 1.9.0 — só vem no recarregamento completo (merge remapeia o
   * provedor delas); a voz da persona/chat chega com `presets`/`chats`.
   */
  | 'voice'

export interface TakeoverOptions {
  mode: 'next_turn' | 'force'
  confirmPinned?: boolean
}

/**
 * Ferramentas locais (§8.9) = as tools "só no computador" da §4.3.6 (`present_file` inclusive, desde
 * 1.10.0). `usesLocalTools` recebe a config EFETIVA do chat (herança ao vivo da persona).
 */
export const LOCAL_TOOLS: readonly string[] = COMPUTER_TOOL_NAMES
/** O chat usa ferramentas locais (§8.9)? — sobre a config efetiva, com a voz em camadas. */
export function usesLocalTools(config: {
  enabledTools?: unknown
  skills?: unknown
  voice?: unknown
}): boolean {
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  // a chamada de voz pode liberar tools próprias (`voice.tools.enabledTools`) — contam também
  const voice = (config.voice ?? {}) as { tools?: { enabledTools?: unknown } | null }
  const tools = [...list(config.enabledTools), ...list(voice.tools?.enabledTools)]
  const skills = (config.skills ?? {}) as { enabled?: unknown }
  return (
    tools.some((t) => LOCAL_TOOLS.includes(t === 'bash' ? 'shell' : t)) || skills.enabled === true
  )
}

/**
 * Aviso forte ao assumir/trocar o host (§8.9, desde 1.10.0): só num chat com ferramentas locais QUE
 * JÁ RODOU NUM COMPUTADOR (registro com `hostCwd`). Sem `hostCwd` elas nunca rodaram e a troca é
 * livre — o padrão de tools inclui as do computador, então quase todo chat as tem na lista.
 */
export function takeoverWarnsLocalTools(usesLocal: boolean, hostCwd: unknown): boolean {
  return usesLocal && hostCwd != null && hostCwd !== ''
}
