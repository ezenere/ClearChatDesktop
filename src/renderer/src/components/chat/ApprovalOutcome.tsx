// Resultado da aprovação no card da tool (ver lib/approvalOutcome.ts):
// - APROVADA (por você, pela lista e/ou pelo Smart-Approve): nada abaixo do card — o selo de status
//   ("ok") vira o gatilho de um tooltip com os detalhes (quem aprovou, a entrada da whitelist ou o
//   motivo do juiz, os sub-comandos com o veredito de cada um). Abre com hover/foco; clique fixa
//   (Esc / clique fora desafixa).
// - NEGADA/BLOQUEADA: faixa compacta de uma linha, visível (por que não rodou), que expande ao clicar.
import * as RT from '@radix-ui/react-tooltip'
import { Ban, Check, ChevronRight, Lock, Plug, ShieldCheck, ShieldX } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { categoryLabel } from '@shared/smartApprove'
import type { MessageMeta } from '@shared/types'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import type { ApprovalOutcome, OutcomeItem } from '../../lib/approvalOutcome'
import { Button } from '../ui/controls'
import { C } from '../ui/Tooltip'
import { SmartApproveLine } from './SmartApprove'

const ITEM_BY: Record<OutcomeItem['by'], { text: string; cls: string }> = {
  lists: { text: 'whitelist', cls: 'text-success/90' },
  smart: { text: 'Smart-Approve', cls: 'text-success/90' },
  user: { text: 'você', cls: 'text-success/90' },
  readonly: { text: 'leitura (sempre liberada)', cls: 'text-success/90' },
  edits: { text: 'aceitar edições na raiz', cls: 'text-success/90' },
  denied: { text: 'você negou', cls: 'text-danger/90' },
  blocked: { text: 'blacklist', cls: 'text-danger/90' }
}

/** Item do registro quando não é um item das Aprovações (tool de conector → "Conector"). */
function ItemTag({ meta }: { meta: MessageMeta }): React.JSX.Element | null {
  if (meta.approval?.item !== 'mcp') return null
  return (
    <span
      data-testid="approval-item-mcp"
      className="inline-flex shrink-0 items-center gap-1 rounded bg-hover px-1.5 py-px text-[10.5px] font-normal text-muted"
    >
      <Plug className="size-2.5" /> Conector
    </span>
  )
}

/** Detalhes (tooltip do selo ou faixa expandida): título, itens com veredito, juiz. */
export function ApprovalDetails({
  outcome,
  meta,
  hideTitle
}: {
  outcome: ApprovalOutcome
  meta: MessageMeta
  /** Faixa expandida: o título já está na faixa. */
  hideTitle?: boolean
}): React.JSX.Element {
  const approved = outcome.kind === 'approved'
  return (
    <div data-testid="approval-details" className="space-y-2 text-[12px]">
      {!hideTitle && (
        <div
          data-testid="approval-details-title"
          className={cn(
            'flex items-center gap-1.5 font-medium',
            approved ? 'text-success/90' : 'text-danger/90'
          )}
        >
          {approved ? <ShieldCheck className="size-3.5" /> : <ShieldX className="size-3.5" />}
          {outcome.title}
          <ItemTag meta={meta} />
        </div>
      )}
      {outcome.items.length > 0 && (
        <ul className="space-y-1">
          {outcome.items.map((it, i) => (
            <li
              key={i}
              data-testid="approval-details-item"
              data-by={it.by}
              className="flex min-w-0 items-start gap-1.5"
            >
              {it.by === 'denied' || it.by === 'blocked' ? (
                <Ban className="mt-0.5 size-3 shrink-0 text-danger/80" />
              ) : (
                <Check className="mt-0.5 size-3 shrink-0 text-success/80" />
              )}
              <code className="min-w-0 flex-1 font-mono text-[11px] break-all text-fg/85">
                {it.text}
              </code>
              <span className={cn('shrink-0 text-[10.5px]', ITEM_BY[it.by].cls)}>
                {ITEM_BY[it.by].text}
                {it.detail && it.by !== 'user' && <> “{it.detail}”</>}
                {it.detail && it.by === 'user' && <> · {it.detail}</>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {outcome.protectedPath && (
        <p
          data-testid="approval-protected"
          className="flex items-start gap-1 text-[11.5px] text-warning/90"
        >
          <Lock className="mt-0.5 size-3 shrink-0" />
          <span>Perguntou porque toca um caminho protegido: {outcome.protectedPath}</span>
        </p>
      )}
      {meta.smartOverride && (
        <p data-testid="smart-override-run" className="text-[11.5px] text-subtle">
          Executada com a sua liberação (Executar mesmo assim), sem passar pelo Smart-Approve.
        </p>
      )}
      {meta.smartApprove && (
        <div className="-mx-3.5 border-t border-border/70">
          <SmartApproveLine rec={meta.smartApprove} pending />
        </div>
      )}
    </div>
  )
}

/**
 * Selo de status de uma chamada aprovada com os detalhes da aprovação num tooltip (hover/foco;
 * clique fixa). `children` = o conteúdo do selo ("✓ ok").
 */
export function ApprovalBadge({
  outcome,
  meta,
  children
}: {
  outcome: ApprovalOutcome
  meta: MessageMeta
  children: ReactNode
}): React.JSX.Element {
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  return (
    <RT.Root open={hover || pinned} onOpenChange={setHover} delayDuration={150}>
      <RT.Trigger asChild>
        <button
          type="button"
          data-testid="approval-badge"
          data-approved-by={outcome.by.join(' ')}
          aria-label={`${outcome.title} — detalhes da aprovação`}
          aria-expanded={pinned}
          onClick={(e) => {
            e.stopPropagation() // não abre/fecha o card
            setPinned((p) => !p)
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="-mx-1 inline-flex shrink-0 cursor-help items-center rounded px-1 py-0.5 hover:bg-hover focus-visible:outline-1 focus-visible:outline-accent"
        >
          {children}
        </button>
      </RT.Trigger>
      <RT.Portal>
        <RT.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          onEscapeKeyDown={() => setPinned(false)}
          onPointerDownOutside={() => setPinned(false)}
          className="z-[100] max-h-[min(70vh,480px)] w-[min(420px,90vw)] animate-pop-in overflow-y-auto rounded-xl border border-border-strong/70 bg-elevated px-3.5 py-3 text-muted shadow-popover"
        >
          <ApprovalDetails outcome={outcome} meta={meta} />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}

/**
 * Faixa compacta (uma linha) de uma chamada negada/bloqueada: o que negou + o motivo cortado;
 * clique expande os detalhes. Rejeição do Smart-Approve: "Executar mesmo assim" à direita.
 */
export function DeniedStrip({
  outcome,
  meta,
  messageId
}: {
  outcome: ApprovalOutcome
  meta: MessageMeta
  messageId: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const run = useStore((s) => s.run)
  const sa = meta.smartApprove
  const action =
    outcome.deniedBy === 'smart' && sa ? (
      sa.overridden ? (
        <span data-testid="smart-overridden" className="shrink-0 text-[11px] text-subtle">
          Liberado · o agente pode repetir esta chamada uma vez
        </span>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="h-6 shrink-0 px-2 text-[11.5px]"
          onClick={() => void run(() => api.agent.smartOverride(messageId), 'Falha ao liberar')}
        >
          Executar mesmo assim
        </Button>
      )
    ) : null
  return (
    <div
      data-testid="approval-denied-strip"
      data-kind={outcome.deniedBy}
      className="border-t border-danger/20 bg-danger/[0.04]"
    >
      <div className="flex min-h-[30px] items-center gap-2 px-3.5 py-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]"
        >
          <ChevronRight
            className={cn('size-3 shrink-0 text-faint transition-transform', open && 'rotate-90')}
          />
          {outcome.deniedBy === 'user' ? (
            <Ban className="size-3.5 shrink-0 text-danger/90" />
          ) : (
            <ShieldX className="size-3.5 shrink-0 text-danger/90" />
          )}
          <span className="shrink-0 font-medium text-danger/90">{outcome.title}</span>
          <ItemTag meta={meta} />
          {outcome.deniedBy === 'smart' && sa?.category && (
            <span
              data-testid="strip-category"
              className="shrink-0 rounded bg-hover px-1.5 py-px text-[10.5px] text-muted"
            >
              {categoryLabel(sa.category)}
            </span>
          )}
          {outcome.reason && (
            <span
              data-testid="approval-denied-reason"
              title={outcome.reason}
              className="min-w-0 truncate text-muted"
            >
              {outcome.deniedBy === 'smart' ? outcome.reason : <C>{outcome.reason}</C>}
            </span>
          )}
        </button>
        {action}
      </div>
      {open && (
        <div className="border-t border-danger/15 px-3.5 py-2.5">
          <ApprovalDetails outcome={outcome} meta={meta} hideTitle />
        </div>
      )}
    </div>
  )
}
