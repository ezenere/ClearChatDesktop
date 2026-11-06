// Chats só ao vivo (docs/SYNC_PROTOCOL.md §23, desde 1.8.0): constantes da §17.1 e regras puras
// (itens do histórico, junção por `lseq`, anúncio, status) — usadas pelo host e pelo visualizador
// (src/main/sync/live*.ts) e pelos testes. Sem Electron nem rede.
import type { LiveChatStatus } from './sync'

/** §17.1 */
export const LIVE_LIMITS = {
  announceMaxEnvBytes: 2048,
  titleMaxChars: 120,
  cwdMaxChars: 300,
  maxChatsPerHost: 500,
  maxChatsPerUser: 1000,
  announceMinIntervalMs: 2000,
  historyPageMaxItems: 200,
  historyPageMaxBytes: 512 * 1024,
  historyChunkBytes: 512 * 1024,
  itemInlineMaxBytes: 256 * 1024,
  recInlineMaxBytes: 128 * 1024,
  historyItemMaxBytes: 32 * 1024 * 1024,
  historyChangesMax: 5000,
  convertWaitMs: 5000,
  attachChunkBytes: 512 * 1024,
  attachMaxFileBytes: 20 * 1024 * 1024,
  attachMaxFiles: 10,
  attachMaxMessageBytes: 50 * 1024 * 1024,
  attachMaxUploads: 10,
  attachMaxPendingBytes: 50 * 1024 * 1024,
  attachUploadIdleMs: 60_000,
  attachUnusedGraceMs: 24 * 3600_000,
  /** Comandos history.* / attach.* / fs.* em voo por visualizador (§23.5). */
  viewerConcurrency: 3,
  /** Coalescência dos `rec` no host (como os lotes do push, §23.6). */
  recDebounceMs: 250,
  /** `stream.event` máx. (§17.1) — com folga para a moldura. */
  streamEventMaxBytes: 200 * 1024,
  /** Espera do visualizador por um resultado de history.* / attach.*. */
  commandTimeoutMs: 35_000
} as const

/** Kinds de comando só de chats ao vivo (§8.6, desde 1.8.0). */
export const LIVE_COMMANDS = new Set([
  'history.list',
  'history.changes',
  'history.item',
  'chat.update',
  'attach.put',
  'attach.get'
])

/** Leituras/transferências (sem janela, sem dedupe, aceitas com o agente rodando). */
export const LIVE_READ_COMMANDS = new Set([
  'history.list',
  'history.changes',
  'history.item',
  'attach.put',
  'attach.get'
])

export type LiveItemType = 'chat' | 'session' | 'message'

/** Item do histórico ao vivo (§23.5) — `data` = plaintext do registro (§4.3.6–§4.3.8). */
export interface LiveItem {
  type: LiveItemType
  id: string
  lseq: number
  deleted?: true
  data?: Record<string, unknown>
  omitted?: true
  large?: number
}

/** Plaintext do anúncio (§23.4). */
export interface LiveChatInfo {
  sv: 1
  chatId: string
  title: string
  persona: { id: string; name: string; icon: string } | null
  model: { providerId: string | null; providerName: string | null; model: string | null }
  status: LiveChatStatus
  pending: { approvals: number; questions: number; retries: number }
  usesLocalTools: boolean
  hostCwd: string | null
  createdAt: number
  updatedAt: number
  messageCount?: number
}

const clipChars = (s: string, max: number): string => {
  const a = Array.from(s)
  return a.length <= max ? s : a.slice(0, max).join('')
}

/** Corta os textos do anúncio nos limites (o escritor corta, §23.4). */
export function clampLiveInfo(i: LiveChatInfo): LiveChatInfo {
  return {
    ...i,
    title: clipChars(i.title, LIVE_LIMITS.titleMaxChars),
    hostCwd: i.hostCwd == null ? null : clipChars(i.hostCwd, LIVE_LIMITS.cwdMaxChars),
    persona: i.persona
      ? {
          id: clipChars(i.persona.id, 100),
          name: clipChars(i.persona.name, 80),
          icon: clipChars(i.persona.icon, 40)
        }
      : null
  }
}

/** Plaintext decifrado de um anúncio → info validada (null = ignorar o item). */
export function parseLiveInfo(p: unknown, chatId: string): LiveChatInfo | null {
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  if (o.chatId !== chatId) return null
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const persona = o.persona && typeof o.persona === 'object' ? (o.persona as Plain) : null
  const model = (o.model && typeof o.model === 'object' ? o.model : {}) as Plain
  const pending = (o.pending && typeof o.pending === 'object' ? o.pending : {}) as Plain
  const status: LiveChatStatus =
    o.status === 'running' || o.status === 'waiting' ? o.status : 'idle'
  return {
    sv: 1,
    chatId,
    title: str(o.title) ?? '',
    persona: persona
      ? { id: str(persona.id) ?? '', name: str(persona.name) ?? '', icon: str(persona.icon) ?? '' }
      : null,
    model: {
      providerId: str(model.providerId),
      providerName: str(model.providerName),
      model: str(model.model)
    },
    status,
    pending: {
      approvals: num(pending.approvals),
      questions: num(pending.questions),
      retries: num(pending.retries)
    },
    usesLocalTools: o.usesLocalTools === true,
    hostCwd: str(o.hostCwd),
    createdAt: num(o.createdAt),
    updatedAt: num(o.updatedAt),
    ...(typeof o.messageCount === 'number' ? { messageCount: o.messageCount } : {})
  }
}

type Plain = Record<string, unknown>

/** Chave de um item (`type|id`). */
export const liveKey = (type: string, id: string): string => `${type}|${id}`

/**
 * Junção por item (§23.5, passo 3): o maior `lseq` vence; empate = a mesma versão (fica o que já
 * tem dado). Retorna true se `next` substitui `cur`.
 */
export function liveItemWins(cur: LiveItem | undefined, next: LiveItem): boolean {
  if (!cur) return true
  if (next.lseq > cur.lseq) return true
  if (next.lseq < cur.lseq) return false
  // mesmo lseq: completa um item que veio sem dado (omitted/large)
  return !cur.deleted && cur.data === undefined && next.data !== undefined
}

/** Texto curto do status de um chat ao vivo (lista, site, celular — §23.10). */
export function liveStatusLabel(status: LiveChatStatus, hostStatus: 'online' | 'grace'): string {
  if (hostStatus === 'grace') return 'reconectando…'
  return status === 'running' ? 'rodando' : status === 'waiting' ? 'aguardando você' : 'ocioso'
}

/** Nome de arquivo do store aceito em `attach.get` (§23.7). */
export const LIVE_ATTACH_FILE_RE = /^[0-9a-f]{64}\.[a-z0-9]{1,10}$/

/** Bytes UTF-8 do JSON de um valor. */
export const jsonBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length
