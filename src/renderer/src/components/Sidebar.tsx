import {
  Check,
  CircleX,
  GitFork,
  Hand,
  MessageSquarePlus,
  MonitorSmartphone,
  Pencil,
  Radio,
  Settings,
  Trash2,
  X
} from 'lucide-react'
import { SyncIndicator } from './sync/ChatHost'
import { LiveChatsSection } from './sync/LiveChats'
import { useMemo, useState } from 'react'
import type { Chat } from '@shared/types'
import { cn, isMac, relativeTime } from '../lib/format'
import { isBusy, useStore } from '../store'
import { Logo } from './Logo'
import { Kbd } from './ui/controls'
import { Tip } from './ui/Tooltip'
import { UpdateNotice } from './UpdateNotice'

export function Sidebar(): React.JSX.Element {
  const allChats = useStore((s) => s.chats)
  // chats ao vivo de outros dispositivos ficam na seção "Ao vivo em <host>" (só memória, §23)
  const chats = useMemo(() => allChats.filter((c) => !c.liveViewer), [allChats])
  const view = useStore((s) => s.view)
  const goNew = useStore((s) => s.goNew)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const sessions = useStore((s) => s.sessions)
  const approvals = useStore((s) => s.approvals)
  const questions = useStore((s) => s.questions)
  const retries = useStore((s) => s.retries)
  const subFailures = useStore((s) => s.subFailures)

  const status = useMemo(() => {
    const out: Record<string, 'running' | 'approval' | 'input' | 'retry' | undefined> = {}
    for (const ss of Object.values(sessions)) if (isBusy(ss.status)) out[ss.chatId] = 'running'
    for (const r of retries) out[r.chatId] = 'retry'
    for (const q of questions) out[q.chatId] = 'input'
    for (const a of approvals) out[a.chatId] = 'approval'
    return out
  }, [sessions, approvals, questions, retries])

  /** Pendências para o destaque do item: aprovações (âmbar) e falhas de subagente não vistas (vermelho). */
  const marks = useMemo(() => {
    const out: Record<string, { approvals: number; failures: string[] }> = {}
    const get = (id: string): { approvals: number; failures: string[] } =>
      (out[id] ??= { approvals: 0, failures: [] })
    for (const a of approvals) get(a.chatId).approvals++
    for (const f of Object.values(subFailures)) if (!f.seen) get(f.chatId).failures.push(f.title)
    return out
  }, [approvals, subFailures])

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="drag flex h-titlebar shrink-0 items-center gap-2 px-4">
        {/* macOS: os botões de fechar/minimizar ocupam o canto esquerdo — só a nuvem, à direita */}
        {!isMac && (
          <>
            <Logo className="size-[18px]" />
            <span className="text-[13px] font-semibold tracking-tight text-fg/90">ClearChat</span>
          </>
        )}
        <SyncIndicator />
      </div>

      <div className="px-2.5 pt-1.5 pb-2">
        <button
          type="button"
          onClick={goNew}
          className={cn(
            'group flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
            view.kind === 'new' ? 'bg-active text-fg' : 'text-fg/85 hover:bg-hover hover:text-fg'
          )}
        >
          <MessageSquarePlus className="size-4 text-muted group-hover:text-fg" />
          Novo chat
          <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>N</Kbd>
          </span>
        </button>
      </div>

      <div className="px-4 pt-2 pb-1.5 text-[11px] font-medium tracking-wide text-subtle">
        Chats
      </div>
      <nav className="min-h-0 flex-1 space-y-px overflow-y-auto px-2.5 pb-3">
        {chats.length === 0 && (
          <p className="px-2.5 py-2 text-xs leading-relaxed text-subtle">
            Nenhum chat ainda. Suas conversas aparecem aqui.
          </p>
        )}
        {chats.map((c) => (
          <ChatItem
            key={c.id}
            chat={c}
            active={view.kind === 'chat' && view.chatId === c.id}
            status={status[c.id]}
            approvals={marks[c.id]?.approvals ?? 0}
            failures={marks[c.id]?.failures}
          />
        ))}
        <LiveChatsSection />
      </nav>

      <div className="border-t border-border p-2.5">
        <UpdateNotice />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="group flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Settings className="size-4" />
          Configurações
          <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>,</Kbd>
          </span>
        </button>
      </div>
    </aside>
  )
}

function ChatItem({
  chat,
  active,
  status,
  approvals = 0,
  failures
}: {
  chat: Chat
  active: boolean
  status: 'running' | 'approval' | 'input' | 'retry' | undefined
  /** Aprovações pendentes no chat (qualquer sessão) → item âmbar. */
  approvals?: number
  /** Subagentes que falharam e o usuário ainda não viu → item vermelho. */
  failures?: string[]
}): React.JSX.Element {
  const failed = !!failures?.length
  const host = useStore((s) => s.chatHosts[chat.id])
  const openChat = useStore((s) => s.openChat)
  const renameChat = useStore((s) => s.renameChat)
  const deleteChat = useStore((s) => s.deleteChat)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(chat.title)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (editing) {
    const save = (): void => {
      const t = title.trim()
      if (t && t !== chat.title) void renameChat(chat.id, t)
      setEditing(false)
    }
    return (
      <div className="flex h-8 items-center gap-1 rounded-lg bg-active pr-1 pl-1">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') {
              e.stopPropagation()
              setEditing(false)
            }
          }}
          onBlur={save}
          className="h-6 min-w-0 flex-1 rounded-md bg-bg px-1.5 text-[13px] outline-none ring-1 ring-accent/50"
        />
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void openChat(chat.id)}
      onKeyDown={(e) => e.key === 'Enter' && void openChat(chat.id)}
      onMouseLeave={() => setConfirmDelete(false)}
      onDoubleClick={() => {
        setTitle(chat.title)
        setEditing(true)
      }}
      data-testid="chat-item"
      data-approval={approvals > 0 || undefined}
      data-failed={failed || undefined}
      className={cn(
        'group relative flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors',
        active ? 'bg-active text-fg' : 'text-fg/75 hover:bg-hover hover:text-fg',
        // pendência de aprovação: âmbar (vale para subagentes também)
        approvals > 0 &&
          !failed &&
          'bg-warning/[0.09] text-fg shadow-[inset_0_0_0_1px_rgb(245_181_68/0.3)] hover:bg-warning/[0.14]',
        approvals > 0 && !failed && active && 'bg-warning/[0.16]',
        // subagente falhou e o chat ainda não foi aberto: vermelho
        failed &&
          'bg-danger/[0.08] text-fg shadow-[inset_0_0_0_1px_rgb(248_113_113/0.32)] hover:bg-danger/[0.13]'
      )}
    >
      {failed ? (
        <Tip
          label={`${failures!.length === 1 ? `Subagente “${failures![0]}” falhou` : `${failures!.length} subagentes falharam`} — abra o chat para ver`}
        >
          <CircleX data-testid="chat-sub-failed" className="size-3.5 shrink-0 text-danger" />
        </Tip>
      ) : approvals > 0 ? (
        <Tip
          label={
            approvals === 1 ? 'Aguardando sua aprovação' : `${approvals} aprovações aguardando você`
          }
        >
          <Hand data-testid="chat-awaiting-approval" className="size-3.5 shrink-0 text-warning" />
        </Tip>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{chat.title || 'Novo chat'}</span>
      {host?.mode === 'diverged' && (
        <Tip label="Divergente: escolha qual versão manter">
          <GitFork data-testid="chat-diverged" className="size-3.5 shrink-0 text-danger" />
        </Tip>
      )}
      {host?.live?.role === 'host' && (
        <Tip
          label={
            host.live.unsupported
              ? 'Só neste dispositivo — o servidor não suporta chats ao vivo'
              : 'Só ao vivo'
          }
        >
          <Radio
            data-testid="chat-live"
            className={cn(
              'size-3 shrink-0',
              host.live.announced ? 'text-accent-strong/80' : 'text-faint'
            )}
          />
        </Tip>
      )}
      {!host?.live && (host?.mode === 'remote' || host?.mode === 'host-offline') && (
        <Tip
          label={`Executando em ${host.host?.name ?? 'outro dispositivo'}${host.mode === 'host-offline' ? ' (offline)' : ''}`}
        >
          <MonitorSmartphone
            className={cn(
              'size-3 shrink-0',
              host.mode === 'host-offline' ? 'text-faint' : 'text-accent-strong/80'
            )}
          />
        </Tip>
      )}
      {approvals > 1 && (
        <span className="shrink-0 rounded-full bg-warning/20 px-1.5 text-[10.5px] font-semibold text-warning tabular-nums group-hover:hidden">
          {approvals}
        </span>
      )}
      {status === 'running' && (
        <Tip label="Executando">
          <span
            data-testid="chat-running"
            className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent-strong"
          />
        </Tip>
      )}
      {status === 'input' && (
        <Tip label="Aguardando sua resposta">
          <span
            data-testid="chat-awaiting-input"
            className="size-1.5 shrink-0 rounded-full bg-warning shadow-[0_0_0_3px_rgb(245_181_68/0.15)]"
          />
        </Tip>
      )}
      {status === 'retry' && (
        <Tip label="Aguardando sua decisão (falha de conexão)">
          <span
            data-testid="chat-awaiting-retry"
            className="size-1.5 shrink-0 rounded-full bg-warning shadow-[0_0_0_3px_rgb(245_181_68/0.15)]"
          />
        </Tip>
      )}
      {!status && !failed && (
        <span className="shrink-0 text-[11px] text-faint tabular-nums group-hover:hidden">
          {relativeTime(chat.updatedAt)}
        </span>
      )}
      <span
        className={cn(
          'absolute inset-y-0 right-1 hidden items-center gap-0.5 pl-6 group-hover:flex',
          active
            ? 'bg-gradient-to-l from-active via-active to-transparent'
            : 'bg-gradient-to-l from-hover via-hover to-transparent'
        )}
      >
        {confirmDelete ? (
          <>
            <Tip label="Confirmar exclusão">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void deleteChat(chat.id)
                }}
                className="rounded-md p-1 text-danger hover:bg-danger/15"
              >
                <Check className="size-3.5" />
              </button>
            </Tip>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setConfirmDelete(false)
              }}
              className="rounded-md p-1 text-subtle hover:bg-active hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </>
        ) : (
          <>
            <Tip label="Renomear">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setTitle(chat.title)
                  setEditing(true)
                }}
                className="rounded-md p-1 text-subtle hover:bg-active hover:text-fg"
              >
                <Pencil className="size-3.5" />
              </button>
            </Tip>
            <Tip label="Apagar">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirmDelete(true)
                }}
                className="rounded-md p-1 text-subtle hover:bg-active hover:text-danger"
              >
                <Trash2 className="size-3.5" />
              </button>
            </Tip>
          </>
        )}
      </span>
    </div>
  )
}
