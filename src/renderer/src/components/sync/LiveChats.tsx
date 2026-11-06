// Chats só ao vivo na UI (docs/SYNC_PROTOCOL.md §23): selo "Só ao vivo" no cabeçalho, menu do
// chat com "Salvar online" / "Tirar do servidor" (§23.8) e a seção "Ao vivo em <host>" da sidebar
// com os chats ao vivo de OUTROS dispositivos (só memória, §23.5).
import { Cloud, CloudOff, MoreHorizontal, Radio } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import type { LiveChatView } from '@shared/sync'
import { liveStatusLabel } from '@shared/live'
import { formatSize } from '@shared/attachments'
import { api } from '../../lib/api'
import { cn, relativeTime } from '../../lib/format'
import { useStore } from '../../store'
import { Button, Spinner } from '../ui/controls'
import { Modal, Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'
import { useHostInfo } from './hooks'

/** Selo do cabeçalho: "Só ao vivo" (host) / "Ao vivo em <host>" (visualizador). */
export function LiveBadge({ chat }: { chat: Chat }): React.JSX.Element | null {
  const info = useHostInfo(chat.id)
  const live = info?.live
  if (!live) return null
  const viewer = live.role === 'viewer'
  const text = viewer
    ? `Ao vivo em ${live.hostName}`
    : live.unsupported
      ? 'Só neste dispositivo'
      : 'Só ao vivo'
  const tip = viewer
    ? live.status === 'online'
      ? `Este chat fica só em ${live.hostName}; você o vê ao vivo (nada é gravado aqui).`
      : `Reconectando a ${live.hostName}…`
    : live.unsupported
      ? 'O servidor não suporta chats ao vivo: o chat fica só neste dispositivo.'
      : 'Fica só neste dispositivo; os outros o veem enquanto este app estiver aberto.'
  return (
    <Tip label={tip} side="bottom">
      <span
        data-testid="live-badge"
        data-role={live.role}
        className={cn(
          'no-drag flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
          viewer && live.status !== 'online'
            ? 'border-border text-subtle'
            : 'border-accent/35 bg-accent-soft/40 text-accent-strong'
        )}
      >
        <Radio className="size-3" />
        {text}
      </span>
    </Tip>
  )
}

/** Menu do chat (host): "Salvar online" num chat ao vivo; "Tirar do servidor" num online. */
export function LiveChatMenu({ chat }: { chat: Chat }): React.JSX.Element | null {
  const info = useHostInfo(chat.id)
  const sync = useStore((s) => s.sync)
  const saveOnline = useStore((s) => s.saveOnline)
  const takeOffServer = useStore((s) => s.takeOffServer)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<'save' | 'take' | null>(null)
  const [stats, setStats] = useState<{
    messages: number
    attachments: number
    bytes: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  if (!info || !sync || sync.phase !== 'ready' || chat.liveViewer) return null
  const isLive = info.live?.role === 'host'
  const pending = info.storage === 'live_pending'
  const canTake = !isLive && sync.live.supported && info.mode === 'local'
  if (!isLive && !canTake) return null
  const ask = (k: 'save' | 'take'): void => {
    setOpen(false)
    setConfirm(k)
    if (k === 'save')
      void api.sync
        .liveStats(chat.id)
        .then(setStats)
        .catch(() => setStats(null))
  }
  const go = async (): Promise<void> => {
    setBusy(true)
    const ok = confirm === 'save' ? await saveOnline(chat.id) : await takeOffServer(chat.id)
    setBusy(false)
    if (ok) setConfirm(null)
  }
  return (
    <>
      <Tip label="Mais ações do chat" side="bottom">
        <button
          ref={anchor}
          type="button"
          data-testid="chat-menu"
          aria-label="Mais ações do chat"
          onClick={() => setOpen((o) => !o)}
          className="no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-subtle hover:bg-hover hover:text-fg"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </Tip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={260} align="end">
        <div className="p-1.5 text-[12.5px]">
          {isLive ? (
            <button
              type="button"
              data-testid="chat-save-online"
              disabled={pending}
              onClick={() => ask('save')}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover disabled:opacity-50"
            >
              <Cloud className="size-3.5 text-accent-strong" />
              Salvar online
            </button>
          ) : (
            <button
              type="button"
              data-testid="chat-take-off-server"
              onClick={() => ask('take')}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
            >
              <CloudOff className="size-3.5 text-subtle" />
              Tirar do servidor
            </button>
          )}
        </div>
      </Popover>
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title={confirm === 'save' ? 'Salvar online?' : 'Tirar do servidor?'}
          width={500}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                loading={busy}
                data-testid="live-convert-confirm"
                onClick={() => void go()}
              >
                {confirm === 'save' ? 'Salvar online' : 'Tirar do servidor'}
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-muted">
            {confirm === 'save' ? (
              <>
                O histórico inteiro ({stats ? `${stats.messages} mensagens` : 'todas as mensagens'}
                {stats?.attachments
                  ? ` e ${stats.attachments} anexo(s), ~${formatSize(stats.bytes)}`
                  : ' e os anexos'}
                ) vai para o servidor, cifrado, e o chat passa a sincronizar com os seus
                dispositivos.
              </>
            ) : (
              <>
                O chat será apagado do servidor e dos seus outros dispositivos e ficará só neste. Os
                outros só o verão ao vivo, enquanto este app estiver aberto. Os anexos saem do
                servidor em até 24 h.
              </>
            )}
          </p>
        </Modal>
      )}
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
            <Radio className="size-3 text-accent-strong/80" />
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
