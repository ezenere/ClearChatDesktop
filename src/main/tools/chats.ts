// get_chat_info / list_chats: informações do chat chamador e dos outros chats do app.
// Os dados vêm do runner (ToolContext.chats); a formatação é pura — testada em e2e/unit.test.ts.
// send_to_chat é tratado pelo runner (precisa do loop do chat de destino).
import { LIMITS } from '@shared/limits'
import {
  fail,
  fmtNum,
  maxOutputOf,
  ok,
  optNumber,
  optString,
  type ChatInfoData,
  type ChatListEntry,
  type ToolContext,
  type ToolResult
} from './util'

/** Data/hora local legível e sem ambiguidade: 2026-10-15 14:03 (UTC-3). */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const tz = `UTC${off >= 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}${off % 60 ? `:${p(Math.abs(off) % 60)}` : ''}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (${tz})`
}

/** "agora", "há 5 min", "há 3 h", "há 2 d". */
export function fmtAgo(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  return `há ${Math.floor(h / 24)} d`
}

const STATUS_LABEL: Record<ChatListEntry['status'], string> = {
  idle: 'ocioso',
  running: 'rodando',
  awaiting_approval: 'aguardando aprovação',
  awaiting_input: 'aguardando resposta do usuário',
  awaiting_retry: 'aguardando decisão do usuário (falha de conexão)'
}

export function formatChatInfo(i: ChatInfoData): string {
  const lines = [
    `chat_id: ${i.chatId}`,
    `título: ${i.title || 'Novo chat'}`,
    i.depth === 0
      ? `sessão: ${i.sessionId} (principal)`
      : `sessão: ${i.sessionId} (subagente, nível ${i.depth}: "${i.sessionTitle}")`
  ]
  if (i.depth > 0) {
    lines.push(`sessão-pai: ${i.parentSessionId ?? '?'}`)
    lines.push(`sessão principal do chat: ${i.mainSessionId}`)
  }
  const r = i.reasoning
  const effort = !r
    ? null
    : !r.requested
      ? 'esforço de raciocínio: não definido (o padrão do modelo)'
      : `esforço de raciocínio: ${r.requested} (${r.source === 'subagent' ? 'deste subagente — delegate_task' : 'do chat'})${
          r.sent === r.requested
            ? ''
            : r.sent
              ? ` — vai como ${r.sent} (o mais próximo que este modelo aceita)`
              : ' — este modelo não aceita: não vai na request'
        }`
  lines.push(
    `modelo: ${i.model || '(nenhum)'}`,
    ...(effort ? [effort] : []),
    `provedor: ${i.providerName || '(nenhum)'}`,
    `diretório raiz: ${i.root}`,
    `criado em: ${fmtDateTime(i.createdAt)}`
  )
  return lines.join('\n')
}

/** Normaliza `limit` (padrão 30, 1..100). */
export function clampChatsLimit(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return LIMITS.chatsDefaultResults
  return Math.min(LIMITS.chatsMaxResults, Math.max(1, Math.floor(v)))
}

export function formatChatList(
  chats: ChatListEntry[],
  opts: { query?: string; limit?: number },
  info: { maxChars?: number; now?: number } = {}
): string {
  const q = opts.query?.trim().toLowerCase()
  const matched = q ? rankChatsByTitle(chats, q) : chats
  const limit = clampChatsLimit(opts.limit)
  const max = info.maxChars ?? LIMITS.maxToolOutputChars
  const hint = q
    ? `\n[para procurar "${opts.query}" no conteúdo das conversas: read_history com scope "all" e query]`
    : ''
  if (!matched.length)
    return q
      ? `[nenhum chat de ${chats.length} tem "${opts.query}" no título]${hint}`
      : '[nenhum chat]'
  const lines: string[] = []
  let used = 200
  for (const c of matched.slice(0, limit)) {
    const line = [
      `${c.id}${c.self ? ' (este chat)' : ''}`,
      `"${(c.title || 'Novo chat').replace(/\s+/g, ' ')}"`,
      c.model || '(sem modelo)',
      STATUS_LABEL[c.status],
      `atualizado ${fmtAgo(c.updatedAt, info.now)}`
    ].join(' · ')
    if (used + line.length + 1 > max) break
    lines.push(line)
    used += line.length + 1
  }
  const head = `[${fmtNum(matched.length)} ${matched.length === 1 ? 'chat' : 'chats'}${q ? ` com "${opts.query}"` : ''}; mostrando ${lines.length}]`
  const tail =
    lines.length < matched.length
      ? `\n[${fmtNum(matched.length - lines.length)} não listados — refine com query ou aumente limit]`
      : ''
  return `${head}\n${lines.join('\n')}${tail}${hint}`
}

const norm = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * Chats cujo título tem todos os termos de `q` (sem acentos/caixa) ou cujo id começa com `q`,
 * mais relevantes primeiro: título igual > começa com > contém a frase > todos os termos;
 * empate = ordem original (mais recentes primeiro).
 */
export function rankChatsByTitle(chats: ChatListEntry[], q: string): ChatListEntry[] {
  const nq = norm(q.trim())
  const terms = nq.split(/\s+/).filter(Boolean)
  const scored: { c: ChatListEntry; score: number; i: number }[] = []
  chats.forEach((c, i) => {
    const t = norm(c.title || 'Novo chat')
    let score = -1
    if (t === nq) score = 0
    else if (t.startsWith(nq)) score = 1
    else if (t.includes(nq)) score = 2
    else if (terms.length && terms.every((x) => t.includes(x))) score = 3
    else if (c.id.startsWith(q.trim().toLowerCase())) score = 4
    if (score >= 0) scored.push({ c, score, i })
  })
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.c)
}

export async function getChatInfoTool(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.chats) return fail('Erro: informações do chat indisponíveis.')
  return ok(formatChatInfo(ctx.chats.self()))
}

export async function listChatsTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.chats) return fail('Erro: lista de chats indisponível.')
  return ok(
    formatChatList(
      ctx.chats.list(),
      { query: optString(args, 'query'), limit: optNumber(args, 'limit') },
      { maxChars: maxOutputOf(ctx) }
    )
  )
}
