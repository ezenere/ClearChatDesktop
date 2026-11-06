// Notificações push no celular (docs/SYNC_PROTOCOL.md §22, desde 1.7.0) — regras puras do host:
// quando avisar, para quem, e o texto (trecho sem Markdown). Sem Electron nem rede (testável; o
// mobile pode vendorar). O envio fica em src/main/sync/push.ts.
import type { ApprovalRequest, QuestionRequest, RetryRequest } from './types'

/** §17.1 */
export const PUSH_TEXT_MAX_CHARS = 200
export const PUSH_CHAT_TITLE_MAX_CHARS = 120
export const PUSH_PENDING_GRACE_S = 60
export const AWAY_IDLE_S = 300
export const PUSH_MAX_ENV_BYTES = 2048

export type PushKind = 'approval' | 'question' | 'retry' | 'reply' | 'error'
export type PushPendingKind = 'approval' | 'question' | 'retry'

/** Plaintext cifrado com K_push (§22.4). */
export interface PushPayload {
  sv: 1
  kind: PushKind
  chatId: string
  sessionId?: string
  chatTitle: string
  text: string
  requestId?: string
  hostName: string
  /** device_id do host (desde 1.8.0; escritores ≥ 1.8.0 enviam sempre). */
  hostDeviceId?: string
  /** Chat só ao vivo (§23): tocar abre o visualizador ao vivo (desde 1.8.0). */
  live?: true
  ts: number
}

/** Destinos de `POST /push`. */
export type PushTo = 'all' | string[]

/**
 * Pendência (aprovação/pergunta/retry, também de subagentes): na hora se o turno veio de um celular
 * (só para ele) ou se o host está ausente (todos); senão depois de PUSH_PENDING_GRACE_S, se ainda
 * pendente, para todos (§22.5).
 */
export function pendingPlan(o: { phoneOrigin: string | null; away: boolean }): {
  delay: 'now' | 'grace'
  to: PushTo
} {
  if (o.phoneOrigin) return { delay: 'now', to: [o.phoneOrigin] }
  if (o.away) return { delay: 'now', to: 'all' }
  return { delay: 'grace', to: 'all' }
}

/**
 * Fim do turno da sessão principal com resposta (`reply`) ou erro (`error`): só se o turno veio de um
 * celular (para ele) ou o host está ausente (todos). Parar pelo usuário não avisa (§22.5).
 */
export function turnEndPlan(o: {
  phoneOrigin: string | null
  away: boolean
  userStopped: boolean
}): PushTo | null {
  if (o.userStopped) return null
  if (o.phoneOrigin) return [o.phoneOrigin]
  if (o.away) return 'all'
  return null
}

/** Corta em `max` caracteres (code points), com reticências. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return (
    chars
      .slice(0, Math.max(0, max - 1))
      .join('')
      .trimEnd() + '…'
  )
}

/**
 * Trecho em texto puro de um Markdown (resposta do modelo): sem cercas de código, títulos, ênfase,
 * links/imagens (fica o texto), citações, marcadores de lista, tabelas e HTML; espaços colapsados.
 */
export function plainExcerpt(md: string, max = PUSH_TEXT_MAX_CHARS): string {
  let s = String(md ?? '')
  // blocos de pensamento que alguns modelos deixam no conteúdo
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
  // cercas de código: some a linha da cerca (```lang), fica o código
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*$/gm, ' ')
  // imagens e links: fica o texto
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  // HTML
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
  // começo de linha: títulos, citações, listas, linhas de tabela/regra
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]*(>[ \t]?)+/gm, '')
  s = s.replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, '')
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
  s = s.replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, ' ')
  s = s.replace(/\|/g, ' ')
  // ênfase e código inline
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2')
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
  s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
  s = s.replace(/~~(.+?)~~/g, '$1')
  s = s.replace(/`+([^`]*)`+/g, '$1')
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1')
  s = s.replace(/\s+/g, ' ').trim()
  return clip(s, max)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** O que a aprovação pede, em uma linha (ex.: "Executar: npm test"). */
export function approvalText(req: Pick<ApprovalRequest, 'toolName' | 'args'>): string {
  const a = (req.args && typeof req.args === 'object' ? req.args : {}) as Record<string, unknown>
  const one = (label: string, v: string): string => (v.trim() ? `${label}: ${v.trim()}` : label)
  let out: string
  switch (req.toolName) {
    case 'shell':
      out = one('Executar', str(a.command))
      break
    case 'process_start':
      out = one('Iniciar processo', str(a.command))
      break
    case 'process_stop':
      out = one('Parar processo', str(a.id))
      break
    case 'write_file':
      out = one('Escrever arquivo', str(a.path))
      break
    case 'edit_file':
      out = one('Editar arquivo', str(a.path))
      break
    case 'read_file':
    case 'list_dir':
    case 'present_file':
      out = one('Ler', str(a.path))
      break
    case 'search_files':
    case 'find_files':
      out = one('Buscar arquivos', str(a.pattern) || str(a.query) || str(a.path))
      break
    case 'browse_url':
      out = one('Abrir', str(a.url))
      break
    case 'web_search':
      out = one('Pesquisar na web', str(a.query))
      break
    case 'delegate_task':
      out = one('Delegar tarefa', str(a.task))
      break
    case 'send_to_chat':
      out = one('Mandar para outro chat', str(a.message))
      break
    default:
      out = `Usar a ferramenta ${req.toolName}`
  }
  return clip(out.replace(/\s+/g, ' '), PUSH_TEXT_MAX_CHARS)
}

/** A pergunta do agente (a primeira, com o total quando há mais de uma). */
export function questionText(req: Pick<QuestionRequest, 'questions'>): string {
  const qs = Array.isArray(req.questions) ? req.questions : []
  const first = qs[0]?.title?.trim() || 'O agente tem uma pergunta.'
  const more = qs.length > 1 ? ` (+${qs.length - 1})` : ''
  return clip(plainExcerpt(first, PUSH_TEXT_MAX_CHARS) + more, PUSH_TEXT_MAX_CHARS)
}

/** Espera de retry: a falha de conexão. */
export function retryText(req: Pick<RetryRequest, 'error'>): string {
  return clip(
    `Falha de conexão: ${String(req.error ?? '').replace(/\s+/g, ' ')}`,
    PUSH_TEXT_MAX_CHARS
  )
}

/** Título do chat para o aviso (≤ 120 chars; vazio → "Chat"). */
export function pushChatTitle(title: string | null | undefined): string {
  return clip(
    String(title ?? '')
      .replace(/\s+/g, ' ')
      .trim() || 'Chat',
    PUSH_CHAT_TITLE_MAX_CHARS
  )
}
