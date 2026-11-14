// Card de aprovação (dentro do ToolCard). Pergunta simples: Permitir / Negar. Modo Listas: um item
// por sub-comando (ou a URL) — os já liberados aparecem marcados (✓ whitelist "…"), cada pendente
// tem [Sim] [Sim + whitelist] [Não] [Não + blacklist]; "+ lista" abre o campo editável
// pré-preenchido (prefixo `programa sub *` ou o domínio). Só executa quando todos forem "Sim";
// qualquer "Não" responde na hora (nada roda). "Sim para todos" atalho. Decomposição em árvore:
// os comandos internos de ssh/sudo/docker exec… ficam indentados sob o cabeçalho do grupo
// ("no servidor deploy@host (via ssh)"), cada um com o próprio veredito.
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  CornerDownRight,
  FileCode,
  Hand,
  Lock,
  ShieldCheck
} from 'lucide-react'
import { Fragment, useState } from 'react'
import { groupHeadings } from '@shared/shellParse'
import {
  isListItem,
  ITEM_LABEL,
  ITEM_TOOL,
  type ApprovalItemDecision
} from '@shared/approvalPolicy'
import type {
  ApprovalCheckItem,
  ApprovalListItem,
  ApprovalRequest,
  ApprovalScript
} from '@shared/types'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { ListEntryEditor, SmartMissingNote } from '../approvals/ApprovalControls'
import { Button } from '../ui/controls'
import { C } from '../ui/Tooltip'
import { SmartApproveLine } from './SmartApprove'

type Choice = { allow: boolean; pattern?: string }

export function ApprovalPrompt({
  request,
  fromSubagent,
  detail
}: {
  request: ApprovalRequest
  fromSubagent?: boolean
  /** Resumo dos argumentos (subagente / órfão). */
  detail?: string
}): React.JSX.Element {
  const approve = useStore((s) => s.approve)
  const focusConfig = useStore((s) => s.focusConfig)
  const who = fromSubagent ? 'o subagente' : 'o agente'
  if (request.check && isListItem(request.check.item))
    return (
      <ListsPrompt
        request={request}
        item={request.check.item}
        items={request.check.items}
        who={who}
      />
    )
  return (
    <div
      data-testid="approval-card"
      className="border-t border-warning/20 bg-warning/[0.045] px-3.5 py-3"
    >
      <div className="flex items-center gap-2 text-[13px] text-fg">
        <Hand className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0">
          Permitir que {who} execute <C>{request.toolName}</C>?
        </span>
      </div>
      {detail && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-bg/70 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg/85">
          {detail}
        </pre>
      )}
      {request.protectedPath && (
        <p
          data-testid="approval-protected"
          className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-snug text-warning/90"
        >
          <Lock className="mt-px size-3.5 shrink-0" />
          <span>
            <strong className="font-medium">caminho protegido</strong>: {request.protectedPath} —
            sempre pergunta (nem “Sempre permitir”, nem o Smart-Approve, nem “Aceitar edições”
            liberam).
          </span>
        </p>
      )}
      {request.smartMissing && (
        <div className="mt-2">
          <SmartMissingNote onConfigure={() => focusConfig('smart-approve')} />
        </div>
      )}
      {request.smartApprove && (
        <div className="-mx-3.5 mt-2 border-y border-warning/15 bg-bg/30">
          <SmartApproveLine rec={request.smartApprove} pending />
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void approve(request.id, 'allow')}>
          Permitir
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void approve(request.id, 'deny')}>
          Negar
        </Button>
      </div>
    </div>
  )
}

function ListsPrompt({
  request,
  item,
  items,
  who
}: {
  request: ApprovalRequest
  item: ApprovalListItem
  items: ApprovalCheckItem[]
  who: string
}): React.JSX.Element {
  const approve = useStore((s) => s.approve)
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [editing, setEditing] = useState<{ index: number; list: 'allow' | 'deny' } | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = items
    .map((it, index) => ({ it, index }))
    .filter(({ it }) => it.verdict !== 'allow')
  const multi = items.length > 1
  const heads = groupHeadings(items)

  const submit = async (next: Record<number, Choice>): Promise<void> => {
    const decided = pending.filter(({ index }) => next[index])
    const anyNo = decided.some(({ index }) => !next[index].allow)
    // envia quando todos decidiram — ou já no primeiro "Não" (nada vai rodar mesmo)
    if (!anyNo && decided.length < pending.length) return
    const list: ApprovalItemDecision[] = decided.map(({ index }) => ({
      index,
      allow: next[index].allow,
      ...(next[index].pattern ? { pattern: next[index].pattern } : {})
    }))
    setBusy(true)
    const ok = await approve(request.id, anyNo ? 'deny' : 'allow', list)
    if (!ok) setBusy(false)
  }
  const decide = (index: number, c: Choice): void => {
    const next = { ...choices, [index]: c }
    setChoices(next)
    setEditing(null)
    void submit(next)
  }

  return (
    <div
      data-testid="approval-card"
      className="border-t border-warning/20 bg-warning/[0.045] px-3.5 py-3"
    >
      <div className="flex items-center gap-2 text-[13px] text-fg">
        <Hand className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0">
          {item === 'pages'
            ? `Permitir que ${who} abra esta página?`
            : multi
              ? `Permitir que ${who} execute estes ${items.length} sub-comandos?`
              : `Permitir que ${who} execute este comando?`}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-faint">
          {ITEM_LABEL[item]} · {request.smartApprove ? 'listas + Smart-Approve' : 'listas'} ·{' '}
          <span className="font-mono">{ITEM_TOOL[item]}</span>
        </span>
      </div>
      {request.smartApprove && (
        <div className="-mx-3.5 mt-2 border-y border-warning/15 bg-bg/30">
          <SmartApproveLine rec={request.smartApprove} pending />
        </div>
      )}
      <div className="mt-2 space-y-1.5">
        {items.map((it, index) => {
          const c = choices[index]
          const indent = { marginLeft: `${(it.depth ?? 0) * 14}px` }
          return (
            <Fragment key={index}>
              {heads[index] && (
                <div
                  data-testid="approval-group"
                  style={indent}
                  className="flex items-center gap-1 pt-0.5 text-[10.5px] font-medium text-subtle"
                >
                  <CornerDownRight className="size-3 shrink-0 text-faint" />
                  {heads[index]}
                </div>
              )}
              <div
                data-testid="approval-sub"
                style={indent}
                className={cn(
                  'rounded-lg border px-2.5 py-1.5',
                  it.verdict === 'allow'
                    ? 'border-success/20 bg-success/[0.04]'
                    : c
                      ? c.allow
                        ? 'border-success/25 bg-bg/50'
                        : 'border-danger/25 bg-bg/50'
                      : 'border-border bg-bg/60'
                )}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="min-w-[min(12rem,100%)] flex-1 font-mono text-[11.5px] break-all whitespace-pre-wrap text-fg/90">
                    {it.text || '(vazio)'}
                  </code>
                  {it.protectedPath && (
                    <span
                      data-testid="sub-protected"
                      title={`Sempre pergunta: ${it.protectedPath}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded bg-danger/10 px-1.5 py-px text-[10.5px] text-danger/90"
                    >
                      <Lock className="size-3" /> caminho protegido
                    </span>
                  )}
                  {it.verdict === 'allow' && it.readOnly ? (
                    <span
                      data-testid="sub-readonly"
                      className="inline-flex shrink-0 items-center gap-1 text-[11px] text-success/90"
                    >
                      <Check className="size-3" /> leitura (sempre liberada)
                    </span>
                  ) : it.verdict === 'allow' ? (
                    <span
                      data-testid="sub-whitelisted"
                      className="inline-flex shrink-0 items-center gap-1 text-[11px] text-success/90"
                    >
                      <Check className="size-3" /> liberado pela lista “{it.entry}”
                    </span>
                  ) : c ? (
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 text-[11px]',
                        c.allow ? 'text-success/90' : 'text-danger/90'
                      )}
                    >
                      {c.allow ? <Check className="size-3" /> : <Ban className="size-3" />}
                      {c.allow ? 'Sim' : 'Não'}
                      {c.pattern && ` + ${c.allow ? 'whitelist' : 'blacklist'} “${c.pattern}”`}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const n = { ...choices }
                          delete n[index]
                          setChoices(n)
                        }}
                        className="ml-1 text-faint underline hover:text-fg"
                      >
                        desfazer
                      </button>
                    </span>
                  ) : (
                    <span className="flex shrink-0 flex-wrap items-center gap-1">
                      <Button
                        size="sm"
                        variant="primary"
                        className="h-6 px-2"
                        disabled={busy}
                        onClick={() => decide(index, { allow: true })}
                      >
                        Sim
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2"
                        disabled={busy || !!it.reason || !it.suggestion}
                        title={
                          it.reason
                            ? 'Este sub-comando nunca é liberado automaticamente'
                            : 'Permitir e salvar um padrão na whitelist global'
                        }
                        onClick={() => setEditing({ index, list: 'allow' })}
                      >
                        Sim + whitelist
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2"
                        disabled={busy}
                        onClick={() => decide(index, { allow: false })}
                      >
                        Não
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        className="h-6 px-2"
                        disabled={busy || !it.suggestion}
                        title="Negar e salvar um padrão na blacklist global"
                        onClick={() => setEditing({ index, list: 'deny' })}
                      >
                        Não + blacklist
                      </Button>
                    </span>
                  )}
                </div>
                {((it.note && it.note !== it.group) || it.reason) && (
                  <p className="mt-0.5 flex items-start gap-1 text-[10.5px] leading-snug text-subtle">
                    {it.reason && (
                      <AlertTriangle className="mt-px size-3 shrink-0 text-warning/90" />
                    )}
                    <span>
                      {[
                        it.note !== it.group && it.note,
                        it.reason && `pergunta sempre: ${it.reason}`
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </p>
                )}
                {it.script && <ScriptPreview script={it.script} />}
                {editing?.index === index && (
                  <ListEntryEditor
                    item={item}
                    list={editing.list}
                    initial={it.suggestion}
                    onCancel={() => setEditing(null)}
                    onConfirm={(pattern) =>
                      decide(index, { allow: editing.list === 'allow', pattern })
                    }
                  />
                )}
              </div>
            </Fragment>
          )
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {pending.length > 1 && (
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            icon={<ShieldCheck className="size-3.5" />}
            onClick={() => {
              const next = { ...choices }
              for (const { index } of pending) next[index] ??= { allow: true }
              setChoices(next)
              setEditing(null)
              void submit(next)
            }}
          >
            Sim para todos
          </Button>
        )}
        <span className="text-[11px] text-faint">
          {pending.length > 1
            ? 'Executa só quando todos forem “Sim”; qualquer “Não” cancela tudo.'
            : '“+ whitelist/blacklist” salva um padrão nas listas globais (Configurações → Aprovações).'}
        </span>
      </div>
    </div>
  )
}

const SCRIPT_NOTE: Partial<Record<ApprovalScript['status'], string>> = {
  missing: 'arquivo não encontrado',
  binary: 'binário',
  notfile: 'não é um arquivo',
  remote: 'arquivo remoto (não lido)',
  error: 'não foi possível ler',
  pending: 'não lido'
}

/**
 * Começo do script que o sub-comando executa (lido no main, ≤ 64 KiB) ou o código inline: até
 * 15 linhas, recolhível. Arquivo inexistente/binário/remoto → só um aviso.
 */
function ScriptPreview({ script }: { script: ApprovalScript }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  // como escrito no comando (curto); o caminho resolvido fica no title
  const path = script.path ?? ''
  const full = script.resolved ?? path
  const note = SCRIPT_NOTE[script.status]
  if (note)
    return (
      <p
        data-testid="script-preview"
        data-status={script.status}
        className="mt-1 flex min-w-0 items-center gap-1 text-[10.5px] text-subtle"
      >
        <FileCode className="size-3 shrink-0 text-faint" />
        <span className="shrink-0">{note}:</span>
        <span className="min-w-0 truncate font-mono" title={full}>
          {path}
        </span>
      </p>
    )
  const label =
    script.status === 'inline'
      ? `código inline (${script.interpreter}${script.lines ? ` · ${script.lines} ${script.lines === 1 ? 'linha' : 'linhas'}` : ''})`
      : `arquivo: ${path} · ${script.lines ?? 0}${script.partial ? '+' : ''} ${script.lines === 1 ? 'linha' : 'linhas'}`
  return (
    <div data-testid="script-preview" data-status={script.status} className="mt-1 min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-full min-w-0 items-center gap-1 text-[10.5px] text-subtle hover:text-fg"
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-faint transition-transform', open && 'rotate-90')}
        />
        <FileCode className="size-3 shrink-0 text-faint" />
        <span className="min-w-0 truncate font-mono" title={full || label}>
          ({label})
        </span>
      </button>
      {open && (
        <pre
          data-testid="script-head"
          className="mt-0.5 max-h-56 overflow-auto rounded-md border border-border/60 bg-bg/50 px-2 py-1 font-mono text-[10.5px] leading-snug whitespace-pre text-muted"
        >
          {script.content}
          {script.truncated ? '\n…' : ''}
        </pre>
      )}
    </div>
  )
}
