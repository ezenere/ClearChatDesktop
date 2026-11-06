import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronRight,
  FolderOpen,
  PanelRight,
  Paperclip,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import type { ApprovalItem, ApprovalMode, Chat, ChatConfig, Session } from '@shared/types'
import { CONFIRM_TOOLS } from '@shared/types'
import { normalizeSmartApprove, smartApproveActive } from '@shared/smartApprove'
import {
  APPROVAL_ITEM_GROUPS,
  APPROVAL_ITEMS,
  effectiveMode,
  ITEM_LABEL,
  ITEM_TOOL,
  modeLabel
} from '@shared/approvalPolicy'
import { sessionProviderId } from '@shared/models'
import { cn, compactPath, sessionLabel } from '../../lib/format'
import { isBusy, useStore } from '../../store'
import { api } from '../../lib/api'
import { anchorTracker } from '../../lib/useAnchor'
import { TaskInfo } from '../apiDocs'
import { TopBar } from '../TopBar'
import { IconButton } from '../ui/controls'
import { Popover } from '../ui/layers'
import { ModelLabel } from '../ui/ModelLabel'
import { Tip } from '../ui/Tooltip'
import { barAttrs, useBarLevel } from '../../lib/useBarCollapse'
import { Composer } from './Composer'
import { useAttachmentSupport } from './attachmentSupport'
import { ContextMeter } from './ContextMeter'
import { GenerateTitleButton } from './GenerateTitleButton'
import { MessageList } from './MessageList'
import { ProcessesBadge } from './ProcessesBadge'
import { SessionSwitcher, StatusDot } from './SessionSwitcher'
import { DivergencePanel } from '../sync/ChatHost'
import { LiveBadge, LiveChatMenu } from '../sync/LiveChats'
import { useHostInfo } from '../sync/hooks'

function EmptyChat({ chat }: { chat: Chat }): React.JSX.Element {
  const homeDir = useStore((s) => s.homeDir)
  const setPanel = useStore((s) => s.setPanel)
  return (
    <div className="flex animate-fade-in flex-col items-center pt-[16vh] text-center">
      <div className="mb-5 flex size-11 items-center justify-center rounded-2xl border border-border bg-surface">
        <Sparkles className="size-5 text-accent-strong" strokeWidth={1.75} />
      </div>
      <h2 className="text-[19px] font-semibold tracking-tight">Pronto para conversar</h2>
      <p className="mt-1.5 text-[13px] text-muted">Escreva sua primeira mensagem abaixo.</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[11.5px]">
        <button
          type="button"
          onClick={() => setPanel(true, 'model')}
          className="flex max-w-full items-center rounded-full border border-border px-2.5 py-1 text-muted hover:border-border-strong hover:text-fg"
        >
          <ModelLabel
            providerId={chat.config.providerId}
            model={chat.config.model}
            modelClassName="font-mono"
          />
        </button>
        <button
          type="button"
          onClick={() => setPanel(true, 'files')}
          className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-mono text-muted hover:border-border-strong hover:text-fg"
        >
          <FolderOpen className="size-3 shrink-0" />
          <span title={chat.config.cwd}>{compactPath(chat.config.cwd, homeDir, 56)}</span>
        </button>
      </div>
    </div>
  )
}

function AutoApproveBadge({ chat }: { chat: Chat }): React.JSX.Element | null {
  const focusConfig = useStore((s) => s.focusConfig)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const patchConfig = useStore((s) => s.patchConfig)
  const flushConfig = useStore((s) => s.flushConfig)
  const global = useStore((s) => s.approvalSettings.modes)
  const level = useBarLevel('auto-approve')
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const sa = normalizeSmartApprove(chat.config.smartApprove)
  const judge = smartApproveActive(sa)
  // "Sempre permitir" chama atenção quando foge do "perguntar": nos itens de terminal/web (padrão
  // perguntar) ou num item cujo global pergunta. Arquivos/chats/subagentes no padrão "Sempre" (como
  // sempre rodaram) não contam.
  const modes = APPROVAL_ITEMS.map((i) => {
    const mode = effectiveMode(chat.config, global, i)
    return {
      item: i,
      mode,
      own: !!chat.config.approvalModes?.[i],
      risky:
        mode === 'always' &&
        (CONFIRM_TOOLS.includes(ITEM_TOOL[i]) || effectiveMode(null, global, i) !== 'always')
    }
  })
  const always = modes.filter((m) => m.risky)
  const smart = modes.filter((m) => m.mode === 'smart')
  // aparece quando algo roda sem você: sempre permitir (itens acima) ou Smart-Approve com modelo
  if (!always.length && !(smart.length && judge) && !open) return null
  // salva na hora (sem o debounce da config)
  const save = (p: Partial<ChatConfig>): void => {
    patchConfig(chat.id, p)
    void flushConfig(chat.id)
  }
  const setMode = (item: ApprovalItem, mode: ApprovalMode | null): void => {
    const next = { ...(chat.config.approvalModes ?? {}) }
    if (mode) next[item] = mode
    else delete next[item]
    save({ approvalModes: next })
  }
  const smartOn = smart.length > 0 && judge
  const label = always.length
    ? `Sempre: ${always.map((m) => ITEM_LABEL[m.item]).join(', ')}${smartOn ? ' · Smart' : ''}`
    : 'Smart-Approve'
  return (
    <>
      <Tip
        side="bottom"
        label={
          <span>
            {level > 0 && <span className="block font-medium">{label}</span>}
            {always.length
              ? `Rodam sem pedir confirmação: ${always.map((m) => ITEM_LABEL[m.item]).join(', ')}`
              : 'Smart-Approve decide as confirmações'}
            {always.length > 0 && smartOn ? ' · Smart-Approve em outros itens' : ''} · clique para
            ver os modos
          </span>
        }
      >
        <button
          ref={anchor}
          type="button"
          data-testid="auto-approve-badge"
          {...barAttrs('auto-approve', level)}
          onClick={() => setOpen((o) => !o)}
          aria-label="Aprovações"
          aria-expanded={open}
          className={cn(
            'no-drag flex h-7 max-w-[260px] shrink-0 items-center gap-1.5 rounded-lg border text-xs whitespace-nowrap transition-colors',
            level === 0 ? 'px-2' : 'w-7 justify-center',
            always.length
              ? 'border-warning/25 bg-warning/[0.06] text-warning/90 hover:bg-warning/[0.12]'
              : 'border-accent/25 bg-accent-soft/50 text-accent-strong hover:bg-accent-soft'
          )}
        >
          {always.length ? (
            <ShieldOff className="size-3.5 shrink-0" />
          ) : (
            <ShieldCheck className="size-3.5 shrink-0" />
          )}
          {level === 0 && <span className="truncate">{label}</span>}
        </button>
      </Tip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        width={350}
        align="end"
        maxHeight={460}
      >
        <div data-testid="auto-approve-popover" className="flex flex-col py-1.5">
          <div className="px-3 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
            Aprovações deste chat
          </div>
          {modes.map(({ item, mode, own, risky }, idx) => (
            <div
              key={item}
              data-testid="auto-approve-item"
              className={cn(
                'flex h-8 items-center gap-2 px-3 hover:bg-hover/60',
                idx > 0 &&
                  APPROVAL_ITEM_GROUPS.some((g) => g.items[0] === item) &&
                  'mt-1 border-t border-border/50'
              )}
            >
              {risky ? (
                <ShieldOff className="size-3.5 shrink-0 text-warning/80" />
              ) : (
                <ShieldCheck
                  className={cn(
                    'size-3.5 shrink-0',
                    mode === 'smart' ? 'text-accent-strong' : 'text-faint'
                  )}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/90">
                {ITEM_LABEL[item]}
              </span>
              <span className={cn('text-[11.5px]', risky ? 'text-warning/90' : 'text-subtle')}>
                {modeLabel(item, mode)}
                {!own && <span className="text-faint"> · global</span>}
                {mode === 'smart' && !judge && (
                  <span className="text-warning/90"> (sem modelo)</span>
                )}
              </span>
              {risky && (
                <button
                  type="button"
                  onClick={() =>
                    // volta ao global; se o global também for "sempre", força Listas/Perguntar
                    setMode(item, own && global[item] !== 'always' ? null : 'lists')
                  }
                  aria-label={`Revogar ${ITEM_LABEL[item]}`}
                  className="rounded-md px-1.5 py-0.5 text-[11.5px] text-danger/85 hover:bg-danger/10 hover:text-danger"
                >
                  Revogar
                </button>
              )}
            </div>
          ))}
          {smart.length > 0 && (
            <div className="mt-1.5 border-t border-border/70 px-3 pt-2.5 pb-1.5">
              <div className="flex items-center gap-2">
                <ShieldCheck
                  className={cn('size-3.5 shrink-0', judge ? 'text-accent-strong' : 'text-faint')}
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/90">
                  Smart-Approve
                  {sa.model && (
                    <>
                      <span className="text-faint">: </span>
                      <ModelLabel
                        providerId={sa.providerId}
                        model={sa.model}
                        short
                        className="text-[12px]"
                        modelClassName="font-mono text-muted"
                      />
                    </>
                  )}
                </span>
                {!judge && (
                  <AlertTriangle aria-hidden className="size-3.5 shrink-0 text-warning/90" />
                )}
              </div>
              <p className="mt-1 pl-5.5 text-[11.5px] leading-snug text-subtle">
                {judge
                  ? `Decide: ${smart.map((m) => ITEM_LABEL[m.item]).join(', ')}.`
                  : 'Configure o modelo do Smart-Approve (aba Tools): sem modelo, esses itens pedem sua confirmação.'}
              </p>
            </div>
          )}
          <div className="mt-1.5 flex flex-col border-t border-border/70 px-1.5 pt-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                focusConfig('aprovacoes')
              }}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[12px] text-accent-strong hover:bg-accent-soft"
            >
              <Settings2 className="size-3.5" /> Ajustar neste chat (aba Tools)
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setSettingsOpen(true, 'approvals')
              }}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[12px] text-accent-strong hover:bg-accent-soft"
            >
              <Settings2 className="size-3.5" /> Configurações → Aprovações
            </button>
          </div>
        </div>
      </Popover>
    </>
  )
}

/**
 * Título do chat no cabeçalho: clique para renomear (Enter/blur salva, Esc cancela). É o lugar do
 * título (a aba Chat do painel não tem mais o campo; a sidebar também renomeia).
 */
function ChatTitle({ chat }: { chat: Chat }): React.JSX.Element {
  const renameChat = useStore((s) => s.renameChat)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(chat.title)
  const commit = (): void => {
    setEditing(false)
    const t = text.trim()
    if (t !== chat.title) void renameChat(chat.id, t)
  }
  if (editing)
    return (
      <input
        autoFocus
        value={text}
        aria-label="Título do chat"
        placeholder="Novo chat"
        onFocus={(e) => e.target.select()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(chat.title)
            setEditing(false)
          }
        }}
        className="no-drag field h-7 w-[260px] max-w-full min-w-0 px-2 py-0 text-[13px] font-medium"
      />
    )
  return (
    <span className="group/title flex min-w-0 items-center gap-0.5">
      <Tip label="Renomear chat" side="bottom">
        <button
          type="button"
          data-testid="chat-title"
          data-bar-title
          onClick={() => {
            setText(chat.title)
            setEditing(true)
          }}
          className="no-drag -mx-1.5 min-w-[64px] truncate rounded-md px-1.5 py-0.5 text-left text-[13px] font-medium whitespace-nowrap hover:bg-hover"
        >
          {chat.title || 'Novo chat'}
        </button>
      </Tip>
      <GenerateTitleButton chat={chat} />
    </span>
  )
}

export function ChatHeader({
  chat,
  session
}: {
  chat: Chat
  session: Session | undefined
}): React.JSX.Element {
  const panelOpen = useStore((s) => s.panelOpen)
  const setPanel = useStore((s) => s.setPanel)
  const openSession = useStore((s) => s.openSession)
  const isSub = !!session && session.depth > 0
  return (
    <TopBar
      right={
        <>
          <LiveChatMenu chat={chat} />
          <IconButton
            label={panelOpen ? 'Fechar painel' : 'Abrir painel'}
            side="bottom"
            size="sm"
            active={panelOpen}
            onClick={() => setPanel(!panelOpen)}
          >
            <PanelRight />
          </IconButton>
        </>
      }
    >
      <div className="flex min-w-0 shrink items-center gap-1.5">
        {isSub ? (
          <>
            <button
              type="button"
              onClick={() => void openSession(chat.mainSessionId)}
              className="no-drag max-w-[220px] min-w-[48px] shrink truncate text-[13px] whitespace-nowrap text-subtle hover:text-fg"
            >
              {chat.title || 'Novo chat'}
            </button>
            <ChevronRight className="size-3.5 shrink-0 text-faint" />
            <span
              data-bar-title
              className="min-w-[64px] truncate text-[13px] font-medium whitespace-nowrap"
            >
              {sessionLabel(session)}
            </span>
          </>
        ) : (
          <ChatTitle key={chat.id} chat={chat} />
        )}
      </div>
      <LiveBadge chat={chat} />
      <SessionSwitcher chatId={chat.id} currentId={session?.id ?? chat.mainSessionId} />
      <ProcessesBadge chatId={chat.id} />
      <AutoApproveBadge chat={chat} />
    </TopBar>
  )
}

function SubBanner({ chat, session }: { chat: Chat; session: Session }): React.JSX.Element {
  const openSession = useStore((s) => s.openSession)
  const run = useStore((s) => s.run)
  const parent = useStore((s) =>
    session.parentSessionId ? s.sessions[session.parentSessionId] : undefined
  )
  const parentLabel = parent ? (parent.depth === 0 ? 'principal' : sessionLabel(parent)) : 'pai'
  return (
    <div className="shrink-0 border-b border-border/70 bg-accent-soft/40 px-8">
      <div className="mx-auto flex h-10 max-w-[1920px] items-center gap-2 text-[12.5px]">
        <Bot className="size-3.5 shrink-0 text-accent-strong" />
        <span data-testid="sub-banner" className="min-w-0 truncate text-muted">
          Conversando com o subagente{' '}
          <span className="font-medium text-fg/90">{sessionLabel(session)}</span>
          <span className="text-faint"> · </span>
          as respostas dele voltam ao agente {parentLabel}
        </span>
        <StatusDot status={session.status} className="ml-1" />
        <TaskInfo task={session.task} />
        <span className="text-faint">·</span>
        <ModelLabel
          providerId={sessionProviderId(chat.config, session)}
          model={session.model}
          className="max-w-[220px] min-w-0 text-[12px]"
          modelClassName="font-mono text-[11.5px] text-muted"
        />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ContextMeter chat={chat} session={session} />
          {isBusy(session.status) && (
            <Tip label="Parar este subagente (e os subagentes dele)">
              <button
                type="button"
                onClick={() => void run(() => api.agent.stop(session.id), 'Falha ao parar')}
                className="no-drag flex items-center gap-1 rounded-md px-2 py-1 text-xs text-danger/90 hover:bg-danger/10"
              >
                <Square className="size-3" fill="currentColor" /> Parar
              </button>
            </Tip>
          )}
          {parent && parent.depth > 0 && (
            <button
              type="button"
              onClick={() => void openSession(parent.id)}
              className="no-drag rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
            >
              Sessão-pai
            </button>
          )}
          <button
            type="button"
            onClick={() => void openSession(chat.mainSessionId)}
            className="no-drag flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent-strong hover:bg-accent-soft"
          >
            <ArrowLeft className="size-3.5" /> Voltar à principal
          </button>
        </div>
      </div>
    </div>
  )
}

export function ChatView({
  chat,
  sessionId
}: {
  chat: Chat
  sessionId: string
}): React.JSX.Element {
  const session = useStore((s) => s.sessions[sessionId])
  const host = useHostInfo(chat.id)
  const addFiles = useStore((s) => s.addFiles)
  const { dropText } = useAttachmentSupport(session)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  if (!session) {
    return <div className="flex-1" />
  }
  const isSub = session.depth > 0
  const hasFiles = (e: React.DragEvent): boolean => [...e.dataTransfer.types].includes('Files')
  // Arrastar arquivos para qualquer ponto do chat (só na sessão principal) → anexos do composer.
  const dropProps = isSub
    ? {}
    : {
        onDragEnter: (e: React.DragEvent) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          depth.current++
          setDragging(true)
        },
        onDragOver: (e: React.DragEvent) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        },
        onDragLeave: (e: React.DragEvent) => {
          if (!hasFiles(e)) return
          depth.current = Math.max(0, depth.current - 1)
          if (!depth.current) setDragging(false)
        },
        onDrop: (e: React.DragEvent) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          depth.current = 0
          setDragging(false)
          const files = [...e.dataTransfer.files]
          if (files.length) void addFiles(session.id, files)
        }
      }
  return (
    <div
      className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col')}
      data-chat-drop
      {...dropProps}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-30 flex animate-fade-in items-center justify-center rounded-2xl border-2 border-dashed border-accent/50 bg-bg/80 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-accent-soft text-accent-strong">
              <Paperclip className="size-5" />
            </span>
            <span className="text-[14px] font-medium">Solte para anexar</span>
            <span className="text-[12px] text-subtle">
              {dropText} · até {ATTACHMENT_LIMITS.maxFileBytes / 1024 / 1024} MB cada
            </span>
          </div>
        </div>
      )}
      {isSub && <SubBanner chat={chat} session={session} />}
      {host?.mode === 'diverged' ? (
        <DivergencePanel chat={chat} />
      ) : (
        <ChatStage chat={chat} session={session} />
      )}
    </div>
  )
}

/**
 * Lista de mensagens + composer flutuando por cima dela (estilo Claude desktop): o scroller ocupa
 * a área toda e a pilha de baixo (fila, pendências, composer) fica absoluta no rodapé, sobre um
 * degradê transparente → fundo. A altura da pilha vira `--chat-bottom-inset` (padding do fim da
 * lista e posição do "ir para o fim") e a margem do observador de âncoras (card coberto pelo
 * composer não conta como visível). Sem re-render: só variável CSS.
 */
function ChatStage({ chat, session }: { chat: Chat; session: Session }): React.JSX.Element {
  const isSub = session.depth > 0
  const area = useRef<HTMLDivElement>(null)
  const stack = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = area.current
    const el = stack.current
    if (!root || !el) return
    let last = -1
    let lastBar = -1
    const measure = (): void => {
      const h = Math.round(el.getBoundingClientRect().height)
      if (h !== last) {
        last = h
        root.style.setProperty('--chat-bottom-inset', `${h}px`)
        anchorTracker.setBottomInset(h)
      }
      // a pilha não cobre a barra de rolagem (o degradê passaria por cima dela)
      const sc = root.querySelector<HTMLElement>('[data-chat-scroller]')
      const bar = sc ? sc.offsetWidth - sc.clientWidth : 0
      if (bar !== lastBar) {
        lastBar = bar
        root.style.setProperty('--chat-scrollbar', `${bar}px`)
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const sc = root.querySelector<HTMLElement>('[data-chat-scroller]')
    if (sc) ro.observe(sc)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={area} data-testid="chat-stage" className="relative flex min-h-0 flex-1 flex-col">
      <MessageList
        chatId={chat.id}
        session={session}
        readOnly={isSub}
        empty={!isSub && <EmptyChat chat={chat} />}
      />
      <div
        ref={stack}
        data-testid="composer-stack"
        data-composer-stack
        className="pointer-events-none absolute bottom-0 left-0 z-20 right-[var(--chat-scrollbar,0px)]"
      >
        {/* degradê (styles.css → .composer-fade): o conteúdo aparece por trás e some sob o composer */}
        <div
          aria-hidden
          data-testid="composer-fade"
          className="composer-fade absolute inset-x-0 -top-10 bottom-0"
        />
        <Composer session={session} autoFocus />
      </div>
    </div>
  )
}
