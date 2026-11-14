// Chats só ao vivo na UI (docs/SYNC_PROTOCOL.md §23): ícone na barra do composer com o popover de
// onde o chat fica e "Salvar online" / "Tirar do servidor" (§23.8; o "Tirar do servidor" de um chat
// online fica no popover do host) e a seção "Ao vivo em <host>" da sidebar com os chats ao vivo de
// OUTROS dispositivos (só memória, §23.5).
import { Radio } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import type { LiveChatView } from '@shared/sync'
import { liveStatusLabel } from '@shared/live'
import { cn, relativeTime } from '../../lib/format'
import { useStore } from '../../store'
import { Spinner } from '../ui/controls'
import { Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'
import { useHostInfo, useStorageAction } from './hooks'

/**
 * Ícone de chat só ao vivo na barra do composer (no lugar do ícone do host): neutro, como o do
 * computador de um chat salvo online. Clique → popover com onde o chat fica e, no host, "Salvar
 * online" (com a confirmação de antes). No visualizador ("Ao vivo em <host>"), só o estado.
 */
export function LiveIndicator({
  chat,
  className
}: {
  chat: Chat
  className?: string
}): React.JSX.Element | null {
  const info = useHostInfo(chat.id)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const { action, dialog } = useStorageAction(chat, () => setOpen(false))
  const live = info?.live
  if (!info || !live) return null
  const viewer = live.role === 'viewer'
  const label = viewer
    ? live.status === 'online'
      ? `Ao vivo em ${live.hostName}`
      : `Reconectando a ${live.hostName}…`
    : live.unsupported
      ? 'Só neste dispositivo — o servidor não suporta chats ao vivo'
      : live.announced
        ? 'Só ao vivo: os outros dispositivos o veem enquanto este app estiver aberto'
        : 'Só ao vivo (ainda não visível nos outros dispositivos)'
  const title = viewer
    ? `Ao vivo em ${live.hostName}`
    : live.unsupported
      ? 'Só neste dispositivo'
      : 'Só ao vivo'
  const text = viewer
    ? live.status === 'online'
      ? `Este chat fica só em ${live.hostName}; você o vê ao vivo (nada é gravado aqui).`
      : `Reconectando a ${live.hostName}… O chat volta quando ele reconectar.`
    : live.unsupported
      ? 'O servidor não suporta chats ao vivo: o chat fica só neste dispositivo.'
      : `Fica só neste dispositivo; os outros o veem enquanto este app estiver aberto${live.announced ? '' : ' (ainda não visível neles)'}.`
  return (
    <>
      <Tip label={`${label} · clique para opções`}>
        <button
          ref={anchor}
          type="button"
          data-testid="live-indicator"
          data-role={live.role}
          aria-label={label}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          className={cn(
            'relative flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
            viewer && live.status !== 'online'
              ? 'text-faint hover:bg-hover hover:text-subtle'
              : 'text-subtle hover:bg-hover hover:text-fg',
            open && 'bg-hover',
            className
          )}
        >
          <Radio className="size-4" />
        </button>
      </Tip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={320}>
        <div
          className="space-y-2.5 p-3 text-[12.5px]"
          data-testid="storage-popover"
          onClick={(e) => e.stopPropagation()}
        >
          <div>
            <div className="flex items-center gap-2 font-medium text-fg">
              <Radio className="size-3.5 shrink-0 text-subtle" />
              <span className="min-w-0 truncate" data-testid="storage-popover-title">
                {title}
              </span>
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-subtle">{text}</p>
          </div>
          {action && <div className="flex flex-wrap gap-1.5">{action}</div>}
        </div>
      </Popover>
      {dialog}
    </>
  )
}

/** Seção "Ao vivo em <host>" da sidebar (chats ao vivo de outros dispositivos). */
export function LiveChatsSection(): React.JSX.Element | null {
  const list = useStore((s) => s.liveChats)
  const view = useStore((s) => s.view)
  const opening = useStore((s) => s.liveOpening)
  const openLiveChat = useStore((s) => s.openLiveChat)
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; items: LiveChatView[] }>()
    for (const c of list) {
      const g = m.get(c.host.deviceId) ?? { name: c.host.name, items: [] }
      g.items.push(c)
      m.set(c.host.deviceId, g)
    }
    return [...m.values()]
  }, [list])
  if (!list.length) return null
  return (
    <div data-testid="live-section">
      {groups.map((g) => (
        <div key={g.name} className="mb-1">
          <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-subtle">
            <Radio className="size-3 text-faint" />
            <span className="truncate">Ao vivo em {g.name}</span>
          </div>
          {g.items.map((c) => {
            const active = view.kind === 'chat' && view.chatId === c.chatId
            const status = liveStatusLabel(c.status, c.settling ? 'grace' : c.host.status)
            return (
              <div
                key={c.chatId}
                role="button"
                tabIndex={0}
                data-testid="live-chat-item"
                data-chat-id={c.chatId}
                onClick={() => void openLiveChat(c.chatId)}
                onKeyDown={(e) => e.key === 'Enter' && void openLiveChat(c.chatId)}
                className={cn(
                  'group flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors',
                  active ? 'bg-active text-fg' : 'text-fg/75 hover:bg-hover hover:text-fg'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{c.title || 'Novo chat'}</span>
                {opening[c.chatId] ? (
                  <Spinner className="size-3" />
                ) : c.status !== 'idle' || c.host.status !== 'online' || c.settling ? (
                  <Tip label={status}>
                    <span
                      data-testid="live-chat-status"
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        c.host.status !== 'online' || c.settling
                          ? 'bg-faint'
                          : c.status === 'waiting'
                            ? 'bg-warning'
                            : 'animate-pulse-soft bg-accent-strong'
                      )}
                    />
                  </Tip>
                ) : (
                  <span className="shrink-0 text-[11px] text-faint tabular-nums">
                    {relativeTime(c.updatedAt)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
