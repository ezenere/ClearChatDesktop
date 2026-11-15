import { Hand, MessageCircleQuestion, WifiOff } from 'lucide-react'
import { type ReactNode } from 'react'
import { useStore } from '../store'
import { Tip } from './ui/Tooltip'
import { barAttrs, BarLevelsContext, useBarCollapse, useBarLevel } from '../lib/useBarCollapse'
import { cn } from '../lib/format'
import { toolDisplayName } from '../lib/mcp'

/**
 * Aprovações pendentes em OUTROS chats (as do chat aberto ficam no card da conversa ou na fila acima
 * do composer). Clique → abre o chat da mais antiga (a fila aparece lá).
 */
function ApprovalIndicator(): React.JSX.Element | null {
  const approvals = useStore((s) => s.approvals)
  const view = useStore((s) => s.view)
  const chats = useStore((s) => s.chats)
  const openChat = useStore((s) => s.openChat)
  const level = useBarLevel('approval-indicator')
  const elsewhere = approvals
    .filter((a) => !(view.kind === 'chat' && view.chatId === a.chatId))
    .sort((a, b) => a.createdAt - b.createdAt)
  if (elsewhere.length === 0) return null
  const first = elsewhere[0]
  const chat = chats.find((c) => c.id === first.chatId)
  const nChats = new Set(elsewhere.map((a) => a.chatId)).size
  const label =
    elsewhere.length === 1 ? 'Aprovação pendente' : `${elsewhere.length} aprovações pendentes`
  return (
    <Tip
      label={
        <span>
          <span className="text-warning">{toolDisplayName(first.toolName)}</span> aguardando
          aprovação em “{chat?.title ?? 'chat'}”
          {nChats > 1 ? ` (e em mais ${nChats - 1} chat(s))` : ''}
        </span>
      }
      side="bottom"
    >
      <button
        type="button"
        data-testid="approval-indicator"
        {...barAttrs('approval-indicator', level)}
        aria-label={label}
        onClick={() => void openChat(first.chatId)}
        className="no-drag flex h-7 shrink-0 animate-pop-in items-center gap-1.5 rounded-full border border-warning/45 bg-warning/[0.16] pr-2.5 pl-2 text-xs font-medium whitespace-nowrap text-warning shadow-[0_0_0_3px_rgb(245_181_68/0.08)] transition-colors hover:bg-warning/[0.24]"
      >
        <Hand className="size-3.5 shrink-0" />
        {level === 0 ? label : <span className="tabular-nums">{elsewhere.length}</span>}
      </button>
    </Tip>
  )
}

/** Questionário (ask_user) aguardando resposta num chat/sessão que não está na tela. */
function QuestionIndicator(): React.JSX.Element | null {
  const questions = useStore((s) => s.questions)
  const view = useStore((s) => s.view)
  const chats = useStore((s) => s.chats)
  const openChat = useStore((s) => s.openChat)
  const level = useBarLevel('question-indicator')
  const elsewhere = questions.filter(
    (q) => !(view.kind === 'chat' && view.sessionId === q.sessionId)
  )
  if (elsewhere.length === 0) return null
  const first = elsewhere[0]
  const chat = chats.find((c) => c.id === first.chatId)
  const label =
    elsewhere.length === 1 ? 'Pergunta pendente' : `${elsewhere.length} perguntas pendentes`
  return (
    <Tip label={`Questionário aguardando sua resposta em “${chat?.title ?? 'chat'}”`} side="bottom">
      <button
        type="button"
        data-testid="question-indicator"
        {...barAttrs('question-indicator', level)}
        aria-label={label}
        onClick={() => void openChat(first.chatId, first.sessionId)}
        className="no-drag flex h-7 shrink-0 animate-pop-in items-center gap-1.5 rounded-full border border-warning/30 bg-warning/[0.08] pr-2.5 pl-2 text-xs whitespace-nowrap text-warning transition-colors hover:bg-warning/[0.14]"
      >
        <MessageCircleQuestion className="size-3.5 shrink-0" />
        {level === 0 ? label : <span className="tabular-nums">{elsewhere.length}</span>}
      </button>
    </Tip>
  )
}

/**
 * Falha de conexão aguardando "Tentar de novo / Cancelar" numa sessão que não está na tela (outro
 * chat, ou um subagente deste chat — o clique leva à subsessão).
 */
function RetryIndicator(): React.JSX.Element | null {
  const retries = useStore((s) => s.retries)
  const view = useStore((s) => s.view)
  const chats = useStore((s) => s.chats)
  const sessions = useStore((s) => s.sessions)
  const openChat = useStore((s) => s.openChat)
  const level = useBarLevel('retry-indicator')
  const elsewhere = retries.filter((r) => !(view.kind === 'chat' && view.sessionId === r.sessionId))
  if (elsewhere.length === 0) return null
  const first = elsewhere[0]
  const chat = chats.find((c) => c.id === first.chatId)
  const sub = (sessions[first.sessionId]?.depth ?? 0) > 0
  const label =
    elsewhere.length > 1
      ? `${elsewhere.length} falhas de conexão`
      : sub
        ? 'Subagente aguardando decisão'
        : 'Falha de conexão'
  return (
    <Tip
      label={`${sub ? `Subagente “${sessions[first.sessionId]?.title || 'Subagente'}”` : 'Agente'} aguardando sua decisão (falha de conexão) em “${chat?.title ?? 'chat'}”`}
      side="bottom"
    >
      <button
        type="button"
        data-testid="retry-indicator"
        {...barAttrs('retry-indicator', level)}
        aria-label={label}
        onClick={() => void openChat(first.chatId, first.sessionId)}
        className={cn(
          'no-drag flex h-7 shrink-0 animate-pop-in items-center gap-1.5 rounded-full border border-warning/30 bg-warning/[0.08] text-xs whitespace-nowrap text-warning transition-colors hover:bg-warning/[0.14]',
          level === 0 || elsewhere.length > 1 ? 'pr-2.5 pl-2' : 'w-7 justify-center'
        )}
      >
        <WifiOff className="size-3.5 shrink-0" />
        {level === 0 ? (
          label
        ) : elsewhere.length > 1 ? (
          <span className="tabular-nums">{elsewhere.length}</span>
        ) : null}
      </button>
    </Tip>
  )
}

/**
 * Cabeçalho da janela. Os itens (selos do chat à esquerda, indicadores de outros chats à direita)
 * recolhem por prioridade quando falta largura (lib/responsiveBar.ts → BAR_ITEMS); o título
 * (`data-bar-title`) trunca por último.
 */
export function TopBar({
  children,
  right
}: {
  children?: ReactNode
  right?: ReactNode
}): React.JSX.Element {
  const [barRef, levels] = useBarCollapse<HTMLElement>()
  return (
    <BarLevelsContext.Provider value={levels}>
      <header
        ref={barRef}
        data-testid="top-bar"
        className="drag flex h-titlebar shrink-0 items-center gap-2 border-b border-border/70 pl-4"
      >
        <div data-bar-clip className="flex min-w-0 flex-1 items-center gap-2 overflow-x-clip">
          {children}
          <div data-bar-spacer className="h-full min-w-0 flex-1" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pr-2">
          <RetryIndicator />
          <QuestionIndicator />
          <ApprovalIndicator />
          {right}
        </div>
        <div className="overlay-spacer h-full" />
      </header>
    </BarLevelsContext.Provider>
  )
}
