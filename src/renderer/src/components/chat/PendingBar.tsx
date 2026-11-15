// Faixa acima do composer com as pendências do chat aberto cujo card na conversa está FORA da tela
// (ou não existe na sessão vista): fila de aprovações (uma de cada vez, a mais antiga primeiro,
// "1 de N", ‹ ›, "Abrir subsessão") e avisos vermelhos de subagentes que falharam. Questionário /
// falha de conexão ocupando o composer têm precedência: a fila espera (só uma linha de aviso).
// Ver SPEC.md → "Aprovações → UI → Fila acima do composer".
import { ArrowUpRight, ChevronLeft, ChevronRight, CircleX, Hand, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ApprovalRequest, Session } from '@shared/types'
import { anchorFor, isAnchorShown, queuedApprovals, shortFailure } from '../../lib/approvalAnchors'
import { cn, sessionLabel } from '../../lib/format'
import { useStore, type SubFailure } from '../../store'
import { C, Tip } from '../ui/Tooltip'
import { ApprovalWithDetail } from './ToolCard'
import { toolDisplayName } from '../../lib/mcp'

export function PendingBar({
  session,
  blocked
}: {
  /** Sessão vista (a do composer). */
  session: Session
  /** Questionário / falha de conexão ocupando o composer: a fila de aprovações espera. */
  blocked: boolean
}): React.JSX.Element | null {
  const approvals = useStore((s) => s.approvals)
  const sessions = useStore((s) => s.sessions)
  const vis = useStore((s) => s.anchorVis)
  const failuresAll = useStore((s) => s.subFailures)
  const dismiss = useStore((s) => s.dismissSubFailure)
  const chatId = session.chatId

  const queue = useMemo(
    () => queuedApprovals(approvals, chatId, session.id, sessions, vis),
    [approvals, chatId, session.id, sessions, vis]
  )
  const failures = useMemo(
    () =>
      Object.values(failuresAll)
        .filter(
          (f) =>
            f.chatId === chatId &&
            !f.dismissed &&
            f.sessionId !== session.id &&
            !isAnchorShown(vis, failureAnchor(f, session.id, sessions))
        )
        .sort((a, b) => a.at - b.at),
    [failuresAll, chatId, session.id, sessions, vis]
  )
  // Falha vista no próprio card do delegate (rolou até ele) conta como vista: não volta na faixa.
  useEffect(() => {
    for (const f of Object.values(failuresAll)) {
      if (f.chatId !== chatId || f.dismissed) continue
      const key = failureAnchor(f, session.id, sessions)
      if (key && vis[key] === true) dismiss(f.sessionId)
    }
  }, [failuresAll, chatId, session.id, sessions, vis, dismiss])

  if (!queue.length && !failures.length) return null
  return (
    <div className="mb-2 space-y-1.5" data-stack-extra>
      {failures.slice(0, 3).map((f) => (
        <FailureNotice key={f.sessionId} failure={f} onDismiss={() => dismiss(f.sessionId)} />
      ))}
      {failures.length > 3 && (
        <p className="pl-1 text-[11px] text-danger/80">
          + {failures.length - 3} subagentes falharam — veja no seletor de sessões
        </p>
      )}
      {queue.length > 0 &&
        (blocked ? (
          <div
            data-testid="approval-queue-waiting"
            className="flex items-center gap-1.5 pl-1 text-[11.5px] text-warning/85"
          >
            <Hand className="size-3.5 shrink-0" />
            {queue.length === 1
              ? '1 aprovação aguardando'
              : `${queue.length} aprovações aguardando`}{' '}
            — aparecem aqui depois que você responder acima
          </div>
        ) : (
          <ApprovalQueue queue={queue} viewSession={session} sessions={sessions} />
        ))}
    </div>
  )
}

function failureAnchor(
  f: SubFailure,
  viewSessionId: string,
  sessions: Record<string, Session>
): string | null {
  return anchorFor(f.sessionId, null, viewSessionId, sessions)
}

function ApprovalQueue({
  queue,
  viewSession,
  sessions
}: {
  queue: ApprovalRequest[]
  viewSession: Session
  sessions: Record<string, Session>
}): React.JSX.Element {
  const openChat = useStore((s) => s.openChat)
  // segue o item pelo id; se ele sair (decidido), fica na mesma posição → o próximo
  const [sel, setSel] = useState<{ id: string; index: number }>({ id: '', index: 0 })
  const found = queue.findIndex((a) => a.id === sel.id)
  const index = found >= 0 ? found : Math.min(sel.index, queue.length - 1)
  const cur = queue[index]
  const go = (i: number): void => setSel({ id: queue[i].id, index: i })
  const sub = sessions[cur.sessionId]
  const isOther = cur.sessionId !== viewSession.id
  const fromSubagent = !!sub && sub.depth > 0
  const who = !sub
    ? 'Sessão'
    : sub.depth > 0
      ? `Subagente “${sessionLabel(sub)}”`
      : 'Agente principal'
  return (
    <div
      data-testid="approval-queue"
      className="animate-pop-in overflow-hidden rounded-xl border border-warning/35 bg-surface shadow-[0_0_0_3px_rgb(245_181_68/0.06),0_8px_30px_-12px_rgb(0_0_0/0.7)]"
    >
      <div className="flex h-9 items-center gap-2 px-3">
        <Hand className="size-3.5 shrink-0 text-warning" />
        <span
          data-testid="approval-queue-who"
          className="min-w-0 truncate text-[12.5px] font-medium text-fg/90"
        >
          {who}
        </span>
        <span className="shrink-0 text-faint">·</span>
        <C>{toolDisplayName(cur.toolName)}</C>
        <span className="flex-1" />
        {queue.length > 1 && (
          <span className="flex shrink-0 items-center gap-0.5">
            <Tip label="Anterior">
              <button
                type="button"
                aria-label="Aprovação anterior"
                disabled={index === 0}
                onClick={() => go(index - 1)}
                className="rounded-md p-0.5 text-subtle hover:bg-hover hover:text-fg disabled:opacity-30"
              >
                <ChevronLeft className="size-3.5" />
              </button>
            </Tip>
            <span
              data-testid="approval-queue-count"
              className="px-0.5 text-[11.5px] text-muted tabular-nums"
            >
              {index + 1} de {queue.length}
            </span>
            <Tip label="Próxima">
              <button
                type="button"
                aria-label="Próxima aprovação"
                disabled={index >= queue.length - 1}
                onClick={() => go(index + 1)}
                className="rounded-md p-0.5 text-subtle hover:bg-hover hover:text-fg disabled:opacity-30"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </Tip>
          </span>
        )}
        {isOther && sub && (
          <button
            type="button"
            onClick={() => void openChat(sub.chatId, sub.id)}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-accent-strong hover:bg-accent-soft"
          >
            <ArrowUpRight className="size-3" />
            {sub.depth > 0 ? 'Abrir subsessão' : 'Abrir principal'}
          </button>
        )}
      </div>
      <div className="max-h-[42vh] overflow-y-auto">
        <ApprovalWithDetail key={cur.id} request={cur} fromSubagent={fromSubagent} />
      </div>
    </div>
  )
}

function FailureNotice({
  failure,
  onDismiss
}: {
  failure: SubFailure
  onDismiss: () => void
}): React.JSX.Element {
  const openChat = useStore((s) => s.openChat)
  const error = useStore((s) => failure.error ?? s.errors[failure.sessionId])
  return (
    <div
      data-testid="sub-failure-notice"
      role="alert"
      className={cn(
        'flex animate-pop-in items-center gap-2 rounded-xl border border-danger/30 bg-danger/[0.07] py-1.5 pr-1.5 pl-3 text-[12.5px]'
      )}
    >
      <CircleX className="size-3.5 shrink-0 text-danger" />
      <span className="min-w-0 flex-1 truncate text-fg/90" title={error}>
        Subagente <span className="font-medium">“{failure.title}”</span> falhou
        <span className="text-muted">: {shortFailure(error)}</span>
      </span>
      <button
        type="button"
        onClick={() => void openChat(failure.chatId, failure.sessionId)}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-accent-strong hover:bg-accent-soft"
      >
        <ArrowUpRight className="size-3" /> Abrir subsessão
      </button>
      <Tip label="Dispensar">
        <button
          type="button"
          aria-label="Dispensar aviso"
          onClick={onDismiss}
          className="rounded-md p-1 text-subtle hover:bg-hover hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      </Tip>
    </div>
  )
}
