// Popup de `@` do composer (menções de caminho): o token em digitação no cursor, os itens (índice
// da raiz do chat — local, pelo main — ou, num chat executado em outro dispositivo, a pasta do
// token listada pelos comandos fs.* do host), a seleção (↑/↓), aceitar (Tab/Enter/clique: pasta
// continua listando, arquivo fecha com espaço) e Esc (fecha até o token mudar). A sintaxe e o
// filtro são puros (@shared/pathMentions). Ver SPEC.md → "Menções @caminho".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import type { ChatHostInfo } from '@shared/sync'
import {
  activeMentionQuery,
  applyMention,
  filterMentionIndex,
  type MentionCandidate,
  type MentionQuery
} from '@shared/pathMentions'
import { api } from './api'
import { isRemoteMode, sourcesFor } from './fileSources'
import { useStore } from '../store'

const INDEX_TTL_MS = 10_000

interface IndexState {
  chatId: string
  at: number
  tick: number
  entries: string[]
  truncated: boolean
}

export interface MentionControls {
  /** Popup aberto (há token em digitação e não foi fechado com Esc). */
  open: boolean
  query: MentionQuery | null
  items: MentionCandidate[]
  selected: number
  loading: boolean
  /** Índice parcial (raiz grande) ou listagem remota pasta a pasta. */
  note: string | null
  /** Pasta listada (com `/`) ou '' quando a busca é na raiz inteira. */
  scope: string
  setSelected: (i: number) => void
  /** Aceita o item `i` (texto + cursor via `onApply`). */
  pick: (i: number) => void
  /** Teclas do popup na textarea; true = tratada (o composer não faz mais nada com ela). */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Cursor da textarea mudou (digitação, clique, setas); null = saiu do campo (fecha). */
  track: (el: HTMLTextAreaElement | null) => void
  /** Caminho existe no índice carregado (destaque de `@Makefile` sem ponto/barra). */
  known: (path: string) => boolean
}

/**
 * `text`/`caret` = o campo; `onApply(next, caret, replace)` troca o trecho `replace` (o token) pelo
 * texto aceito — o composer usa `insertText` para manter o desfazer.
 */
export function useMentions(opts: {
  chat: Chat | undefined
  host: ChatHostInfo | undefined
  text: string
  enabled: boolean
  onApply: (r: { start: number; end: number; insert: string; caret: number }) => void
}): MentionControls {
  const { chat, host, text, enabled, onApply } = opts
  const chatId = chat?.id ?? ''
  const remote = !!chat && (!!chat.liveViewer || isRemoteMode(host?.mode))
  const tick = useStore((s) => (chatId ? (s.fsTick[chatId] ?? 0) : 0))
  const [caret, setCaret] = useState<number | null>(null)
  const [selected, setSelected] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [index, setIndex] = useState<IndexState | null>(null)
  const [listing, setListing] = useState<{ key: string; entries: string[] } | null>(null)

  const query = useMemo(
    () =>
      enabled && caret !== null && caret <= text.length ? activeMentionQuery(text, caret) : null,
    [enabled, caret, text]
  )
  const open = !!query && dismissedAt !== query.start
  // Esc fecha até o token mudar de lugar (ou sumir)
  const [lastStart, setLastStart] = useState<number | null>(null)
  const start = query?.start ?? null
  if (start !== lastStart) {
    setLastStart(start)
    setSelected(0)
    if (dismissedAt !== null && dismissedAt !== start) setDismissedAt(null)
  }

  // índice local: carregado quando o popup abre (cache curto; recarrega com a aba Arquivos)
  const indexRef = useRef<IndexState | null>(null)
  useEffect(() => {
    if (!open || remote || !chatId) return
    const cur = indexRef.current
    if (cur && cur.chatId === chatId && cur.tick === tick && Date.now() - cur.at < INDEX_TTL_MS)
      return
    let alive = true
    const done = (entries: string[], truncated: boolean): void => {
      if (!alive) return
      const st = { chatId, at: Date.now(), tick, entries, truncated }
      indexRef.current = st
      setIndex(st)
    }
    void api.fs
      .index(chatId)
      .then((r) => done(r?.entries ?? [], !!r?.truncated))
      .catch(() => done([], false))
    return () => {
      alive = false
    }
  }, [open, remote, chatId, tick])

  // remoto: a pasta do token, pela fonte do host (relativa à raiz dele)
  const q = query?.query ?? ''
  const slash = q.lastIndexOf('/')
  const dirPart = slash >= 0 ? q.slice(0, slash + 1) : ''
  const listKey = `${chatId}\n${dirPart}\n${tick}`
  useEffect(() => {
    if (!open || !remote || !chatId || listing?.key === listKey) return
    const ctl = new AbortController()
    const src = sourcesFor(chatId, chat?.liveViewer ? 'remote' : host?.mode).dir
    void src.listDir(chatId, dirPart.replace(/\/$/, ''), ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      setListing({
        key: listKey,
        entries: r.ok ? r.entries.map((e) => `${dirPart}${e.name}${e.isDir ? '/' : ''}`) : []
      })
    })
    return () => ctl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a chave cobre o resto
  }, [open, remote, listKey])

  const source = remote
    ? listing?.key === listKey
      ? listing.entries
      : null
    : index && index.chatId === chatId
      ? index.entries
      : null
  const items = useMemo(
    () => (open && source ? filterMentionIndex(source, q) : []),
    [open, source, q]
  )
  const known = useMemo(() => {
    const set = new Set(index?.chatId === chatId ? index.entries : [])
    return (p: string): boolean => set.has(p) || set.has(`${p}/`)
  }, [index, chatId])

  const sel = Math.min(selected, Math.max(0, items.length - 1))
  const applyRef = useRef(onApply)
  useEffect(() => {
    applyRef.current = onApply
  })
  const pick = useCallback(
    (i: number) => {
      const it = items[i]
      if (!query || !it) return
      const r = applyMention(text, query, { path: it.path, dir: it.dir })
      const tail = text.length - query.end
      applyRef.current({
        start: query.start,
        end: query.end,
        insert: r.text.slice(query.start, r.text.length - tail),
        caret: r.caret
      })
      setCaret(r.caret)
      setSelected(0)
    },
    [items, query, text]
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDismissedAt(query?.start ?? null)
      return true
    }
    if (!items.length) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setSelected((sel + d + items.length) % items.length)
      return true
    }
    if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault()
      pick(sel)
      return true
    }
    return false
  }

  const track = useCallback((el: HTMLTextAreaElement | null) => {
    setCaret(el && el.selectionStart === el.selectionEnd ? el.selectionStart : null)
  }, [])

  return {
    open,
    query,
    items,
    selected: sel,
    loading: open && !source,
    note: remote
      ? 'Arquivos do host: pasta por pasta'
      : index?.truncated
        ? 'Raiz grande: índice parcial'
        : null,
    scope: slash >= 0 || !q ? dirPart : '',
    setSelected,
    pick,
    onKeyDown,
    track,
    known
  }
}
