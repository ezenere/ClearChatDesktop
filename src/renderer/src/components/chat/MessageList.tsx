import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  Brain,
  ChevronRight,
  CircleAlert,
  Clock,
  Cpu,
  Layers,
  Maximize2,
  Minimize2,
  Pencil,
  Radio,
  RotateCcw,
  MessagesSquare,
  Trash2,
  User,
  Users,
  X,
  Zap
} from 'lucide-react'
import { splitInterChatText } from '@shared/interChat'
import { isSiblingKind, splitSiblingText } from '@shared/siblings'
import { isContextLengthError, isDisplayOnly, latestBoundaryIndex } from '@shared/context'
import { isBranchEditable, selectionToReach, selEquals, type BranchSel } from '@shared/branches'
import { messageAttachments, messageSkills } from '@shared/attachments'
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { ApprovalRequest, Session, StoredMessage, StreamDraft } from '@shared/types'
import { api } from '../../lib/api'
import {
  cn,
  formatCost,
  formatDuration,
  formatTokens,
  isMac,
  messageText,
  withText
} from '../../lib/format'
import {
  isBusy,
  selectMessages,
  selectRuns,
  useStore,
  type CompactionState,
  type ToolRun
} from '../../store'
import { CompactionMessageInfo, MessageInfo } from '../apiDocs'
import { ApiInfo } from '../ui/Tooltip'
import { AutoTextarea, Button, Spinner } from '../ui/controls'
import { AutoTitleBadge } from './AutoTitleBadge'
import { Tip } from '../ui/Tooltip'
import { CopyButton, Markdown } from './Markdown'
import { OrphanApproval, ToolCard } from './ToolCard'
import { PresentFileCards } from '../viewer/PresentFileCards'
import { presentedFilesOf } from '../../lib/presentFiles'
import { anchorFor, anchorId } from '../../lib/approvalAnchors'
import { useAnchorRoot } from '../../lib/useAnchor'
import { MessageAttachments } from './Attachments'
import { ExtractionCard } from '../memory/ExtractionCard'
import { isExtractionMessage } from '../../lib/memory'
import {
  dayKey,
  dayLabel,
  dayStarts,
  formatFullDateTime,
  formatTime,
  msUntilNextDay
} from '../../lib/dates'
import { useBranchView } from '../../lib/useBranchView'
import {
  branchGroup,
  regenerateTargets,
  subagentsBelow,
  trailingErrorId
} from '../../lib/branchView'
import { useHostInfo } from '../sync/hooks'
import { BranchSwitcher } from './BranchSwitcher'
import { reasoningHeader } from '../../lib/reasoning'
import { CallMarker, EndCallLine, VoiceBadge } from './VoiceMarks'
import { contributeCtx } from '../../lib/contextMenu'
import { markdownToPlainText } from '@shared/contextMenu'
import { liveDimFrom } from '@shared/heardText'
import { useVoiceFollow } from '../../lib/voice/voiceFollow'

// ---------- Bits ----------

type ReasoningView = 'closed' | 'box' | 'full'
/** Estado por mensagem (sobrevive a remontagens enquanto o app está aberto). */
/** Mensagem falada na chamada: tags de voz esmaecidas (opacidade 0,65) no texto. */
const VOICE_TAGS = { tags: true } as const
/** O resto não ouvido de uma resposta interrompida: inteiro esmaecido (tags com o 0,65 relativo). */
const VOICE_UNHEARD = { tags: true, dimFrom: 0 } as const

/**
 * Markdown de uma resposta da chamada: tags de voz esmaecidas e, enquanto ELA está sendo falada, o
 * trecho ainda não ouvido esmaecido (`liveDimFrom` — avança palavra por palavra; só opacidade, sem
 * pulo de layout). Fora da fala: render normal.
 */
function VoiceMarkdown({ text }: { text: string }): React.JSX.Element {
  const dimFrom = useVoiceFollow((s) => (s.current ? liveDimFrom(text, s.heard, s.current) : null))
  const voice = useMemo(() => (dimFrom != null ? { tags: true, dimFrom } : VOICE_TAGS), [dimFrom])
  return <Markdown text={text} voice={voice} />
}

const reasoningViews = new Map<string, ReasoningView>()

/**
 * Raciocínio da mensagem: fechado (só o cabeçalho) → caixa compacta com rolagem própria →
 * "expandir tudo" (texto inteiro na altura natural, sem rolagem interna). Enquanto o modelo
 * pensa, a caixa aparece sozinha; no modo expandido ela só cresce.
 */
/** Agora (ms), atualizado a cada segundo enquanto `active`. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = (): void => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const t = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [active])
  return now
}

function Reasoning({
  text,
  live,
  id,
  startedAt,
  durationMs,
  tokens
}: {
  text: string
  live?: boolean
  /** id da mensagem, para lembrar o estado; rascunhos não têm. */
  id?: string
  /** Pensando: início do raciocínio (relógio do store) → "Pensando… N s". */
  startedAt?: number
  /** Concluído: tempo de raciocínio (meta.reasoningMs ou o relógio do rascunho). */
  durationMs?: number
  /** Concluído: usage.reasoningTokens (quando o provedor informa). */
  tokens?: number
}): React.JSX.Element {
  const now = useSecondTick(!!live && startedAt != null)
  const header = reasoningHeader({
    live,
    elapsedMs: live && startedAt != null ? Math.max(0, now - startedAt) : undefined,
    durationMs,
    tokens
  })
  const [view, setViewState] = useState<ReasoningView>(
    () => (id && reasoningViews.get(id)) || 'closed'
  )
  const setView = (v: ReasoningView): void => {
    if (id) reasoningViews.set(id, v)
    setViewState(v)
  }
  const shown: ReasoningView = view === 'closed' && live ? 'box' : view
  const full = shown === 'full'
  // Caixa compacta enquanto o modelo pensa: acompanha o texto novo só se o usuário está no fim dela
  // (rolou para cima → não força a rolagem; voltou ao fim → volta a acompanhar).
  const boxRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const onBoxScroll = (): void => {
    const el = boxRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el || !live || shown !== 'box' || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [text, live, shown])
  return (
    <div className="mb-2">
      <div className="group/rsn -ml-1 flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => setView(shown === 'closed' ? 'box' : 'closed')}
          aria-expanded={shown !== 'closed'}
          className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-subtle hover:text-fg"
        >
          <Brain className={cn('size-3.5', live && 'animate-pulse-soft text-accent-strong')} />
          <span data-testid="reasoning-header">
            {header.label}
            {header.details.map((d) => (
              <span key={d} className="tabular-nums text-faint">
                {' · '}
                {d}
              </span>
            ))}
          </span>
          <ChevronRight
            className={cn('size-3 transition-transform', shown !== 'closed' && 'rotate-90')}
          />
        </button>
        <Tip label={full ? 'Voltar para a caixa' : 'Expandir tudo'}>
          <button
            type="button"
            onClick={() => setView(full ? 'box' : 'full')}
            aria-label={full ? 'Voltar para a caixa' : 'Expandir tudo'}
            className={cn(
              'grid size-5 place-items-center rounded-md text-faint transition-opacity hover:bg-hover hover:text-fg',
              shown === 'closed' &&
                'opacity-0 group-hover/rsn:opacity-100 focus-visible:opacity-100'
            )}
          >
            {full ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
          </button>
        </Tip>
      </div>
      {shown !== 'closed' && (
        <div
          ref={boxRef}
          onScroll={full ? undefined : onBoxScroll}
          data-testid="reasoning-box"
          className={cn(
            'mt-1.5 animate-fade-in border-l-2 border-border-strong pl-3.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-subtle',
            !full && 'max-h-72 overflow-y-auto'
          )}
        >
          {text}
        </div>
      )}
    </div>
  )
}

/** Soma das chamadas ao Smart-Approve dos resultados das tools de uma resposta. */
interface JudgeTotals {
  calls: number
  promptTokens: number
  completionTokens: number
  cost: number
  hasCost: boolean
}

function judgeTotals(msg: StoredMessage, results: Map<string, StoredMessage>): JudgeTotals | null {
  if (msg.message.role !== 'assistant' || !msg.message.tool_calls?.length) return null
  const t: JudgeTotals = { calls: 0, promptTokens: 0, completionTokens: 0, cost: 0, hasCost: false }
  for (const tc of msg.message.tool_calls) {
    const rec = results.get(tc.id)?.meta.smartApprove
    if (!rec) continue
    t.calls++
    t.promptTokens += rec.usage?.promptTokens ?? 0
    t.completionTokens += rec.usage?.completionTokens ?? 0
    if (rec.usage?.cost != null) {
      t.cost += rec.usage.cost
      t.hasCost = true
    }
  }
  return t.calls ? t : null
}

function UsageFooter({
  msg,
  judge
}: {
  msg: StoredMessage
  judge?: JudgeTotals | null
}): React.JSX.Element | null {
  const u = msg.meta.usage
  const parts: ReactNode[] = []
  if (msg.meta.model)
    parts.push(
      <span key="m" className="truncate">
        {msg.meta.model}
      </span>
    )
  if (u) {
    parts.push(
      <Tip key="u" label="Tokens de entrada / saída / lidos do cache">
        <span className="tabular-nums">
          {formatTokens(u.promptTokens)} in · {formatTokens(u.completionTokens)} out
          {u.cachedTokens ? (
            <span className="text-success/70"> · {formatTokens(u.cachedTokens)} cache</span>
          ) : null}
          {u.reasoningTokens ? <> · {formatTokens(u.reasoningTokens)} raciocínio</> : null}
        </span>
      </Tip>
    )
    const cost = formatCost(u.cost)
    if (cost)
      parts.push(
        <span key="c" className="tabular-nums">
          {cost}
        </span>
      )
  }
  const d = formatDuration(msg.meta.durationMs)
  if (d)
    parts.push(
      <span key="d" className="tabular-nums">
        {d}
      </span>
    )
  if (judge)
    parts.push(
      <Tip
        key="j"
        label={
          <span>
            Smart-Approve: {judge.calls} chamada{judge.calls > 1 ? 's' : ''} ao juiz ·{' '}
            {formatTokens(judge.promptTokens)} in · {formatTokens(judge.completionTokens)} out
            {judge.hasCost ? ` · ${formatCost(judge.cost) ?? '$0'}` : ''} — fora do histórico, não
            somado acima
          </span>
        }
      >
        <span data-testid="judge-usage" className="tabular-nums">
          juiz {judge.hasCost ? (formatCost(judge.cost) ?? '$0') : `${judge.calls}×`}
        </span>
      </Tip>
    )
  if (parts.length === 0) return null
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint transition-colors group-hover/msg:text-subtle">
      <Cpu className="size-3 shrink-0" />
      {parts.map((p, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span className="text-faint/60">·</span>}
          {p}
        </span>
      ))}
    </div>
  )
}

/** Hora da mensagem ("14:28"); tooltip com data e hora completas. */
function MsgTime({ ts, className }: { ts: number; className?: string }): React.JSX.Element {
  return (
    <Tip label={formatFullDateTime(ts)}>
      <span
        data-testid="msg-time"
        className={cn(
          'shrink-0 cursor-default text-[11px] whitespace-nowrap text-faint tabular-nums transition-colors select-none group-hover/msg:text-subtle',
          className
        )}
      >
        {formatTime(ts)}
      </span>
    </Tip>
  )
}

/** Pílula do dia entre mensagens ("Hoje" / "Ontem" / "qui., 15 de out."). */
function DayPill({ label, className }: { label: string; className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-full border border-border bg-elevated/90 px-2.5 py-0.5 text-[11px] font-medium text-muted shadow-[0_1px_2px_rgb(0_0_0/0.25)]',
        className
      )}
    >
      {label}
    </span>
  )
}

function DaySeparator({ ts, now }: { ts: number; now: number }): React.JSX.Element {
  return (
    <div
      data-day-sep={ts}
      data-day-label={dayLabel(ts, now)}
      data-testid="day-separator"
      className="pointer-events-none flex justify-center py-3 select-none"
    >
      <DayPill label={dayLabel(ts, now)} />
    </div>
  )
}

/** "Agora" que muda à meia-noite local (e ao voltar o foco, p/ cobrir suspensão) — Hoje → Ontem. */
function useToday(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setTimeout(() => setNow(Date.now()), msUntilNextDay(now))
    const onFocus = (): void => {
      if (dayKey(Date.now()) !== dayKey(now)) setNow(Date.now())
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearTimeout(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [now])
  return now
}

function ActionBtn({
  label,
  onClick,
  children,
  danger
}: {
  label: string
  onClick: () => void
  children: ReactNode
  danger?: boolean
}): React.JSX.Element {
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn(
          'rounded-md p-1 text-subtle transition-colors hover:bg-hover',
          danger ? 'hover:text-danger' : 'hover:text-fg'
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

function MessageActions({
  msg,
  canEdit,
  onEdit,
  onRegenerate,
  align = 'start'
}: {
  msg: StoredMessage
  canEdit: boolean
  onEdit: () => void
  onRegenerate?: () => void
  align?: 'start' | 'end'
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [confirm, setConfirm] = useState(false)
  const text = messageText(msg.message.content)
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100',
        align === 'end' && 'justify-end',
        confirm && 'opacity-100'
      )}
      onMouseLeave={() => setConfirm(false)}
    >
      <MessageInfo msg={msg} />
      {text && <CopyButton text={text} label="" className="px-1" />}
      {canEdit && (
        <ActionBtn label="Editar" onClick={onEdit}>
          <Pencil className="size-3.5" />
        </ActionBtn>
      )}
      {canEdit &&
        (confirm ? (
          <button
            type="button"
            onClick={() => void run(() => api.messages.delete(msg.id), 'Erro ao apagar mensagem')}
            className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger/20"
          >
            Apagar?
          </button>
        ) : (
          <ActionBtn label="Apagar mensagem" onClick={() => setConfirm(true)} danger>
            <Trash2 className="size-3.5" />
          </ActionBtn>
        ))}
      {onRegenerate && (
        <ActionBtn label="Regenerar resposta" onClick={onRegenerate}>
          <RotateCcw className="size-3.5" />
        </ActionBtn>
      )}
    </div>
  )
}

function InlineEditor({
  initial,
  onCancel,
  onSave,
  mode = 'replace',
  allowEmpty,
  hints
}: {
  initial: string
  onCancel: () => void
  onSave: (text: string) => void
  /**
   * 'replace' = edita o histórico salvo no lugar (não reenvia nada). 'branch' = envia como NOVA
   * VERSÃO da mensagem (a atual continua salva) e o agente responde.
   */
  mode?: 'replace' | 'branch'
  /** Modo 'branch': texto vazio pode ser enviado (a mensagem tem anexos). */
  allowEmpty?: boolean
  /** Linhas extras sob o rodapé (avisos do modo 'branch'). */
  hints?: ReactNode[]
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const branch = mode === 'branch'
  const canSave = !branch || (text !== initial && (allowEmpty || text.trim() !== ''))
  const save = (): void => {
    if (canSave) onSave(text)
  }
  return (
    <div className="w-full animate-fade-in">
      <AutoTextarea
        autoFocus
        value={text}
        minRows={2}
        maxRows={20}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            save()
          }
        }}
        className="field leading-relaxed"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span data-testid="editor-note" className="mr-auto text-[11px] text-subtle">
          {branch
            ? 'Envia como nova versão — a atual continua salva (‹ › para alternar)'
            : 'Edita o histórico salvo — não reenvia nada.'}
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Tip
          label={branch ? 'Enviar como nova versão' : 'Salvar'}
          shortcut={isMac ? '⌘+Enter' : 'Ctrl+Enter'}
        >
          <span>
            <Button size="sm" variant="primary" disabled={!canSave} onClick={save}>
              {branch ? 'Enviar' : 'Salvar'}
            </Button>
          </span>
        </Tip>
      </div>
      {hints && hints.length > 0 && (
        <div data-testid="editor-hints" className="mt-1.5 space-y-0.5 text-[11px] text-faint">
          {hints.map((h, i) => (
            <p key={i}>{h}</p>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- Mensagens ----------

function UserMessage({
  msg,
  canEdit,
  ctx
}: {
  msg: StoredMessage
  canEdit: boolean
  ctx: Ctx
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const editBranch = useStore((s) => s.editBranch)
  const [editing, setEditing] = useState(false)
  const text = msg.message.role === 'user' ? messageText(msg.message.content) : ''
  const hasAttachments =
    messageAttachments(msg.message).length > 0 || messageSkills(msg.message).length > 0
  const kind = msg.meta.kind
  // mensagem digitada na principal: editar = nova versão (ramo); o resto edita no lugar
  const branch = isBranchEditable(msg, ctx.depth)
  return (
    <div
      className="group/msg flex animate-slide-up flex-col items-end gap-1 py-2"
      onContextMenu={(e) =>
        // botão direito: as mesmas ações da barra do hover (SPEC → "Menu de contexto")
        !editing &&
        contributeCtx(e, {
          copy: { copyMessage: text },
          run: canEdit ? { editMessage: () => setEditing(true) } : undefined
        })
      }
    >
      {editing ? (
        <InlineEditor
          initial={text}
          mode={branch ? 'branch' : 'replace'}
          allowEmpty={hasAttachments}
          hints={branch ? ctx.editHints(msg) : undefined}
          onCancel={() => setEditing(false)}
          onSave={(t) => {
            setEditing(false)
            if (branch) void editBranch(ctx.sessionId, msg.id, withText(msg.message, t))
            else
              void run(
                () => api.messages.update(msg.id, withText(msg.message, t)),
                'Erro ao editar'
              )
          }}
        />
      ) : (
        <>
          {(kind === 'queued' || kind === 'forced') && (
            <span className="flex items-center gap-1 text-[10.5px] text-subtle">
              {kind === 'forced' ? <Zap className="size-3 text-warning" /> : null}
              {kind === 'forced' ? 'enviada agora (interrompeu o agente)' : 'da fila'}
            </span>
          )}
          {msg.message.role === 'user' && Array.isArray(msg.message.content) && (
            <MessageAttachments parts={msg.message.content} />
          )}
          {(text || !hasAttachments) && (
            <div
              data-voice={msg.meta.voice?.source}
              className={cn(
                'max-w-[85%] rounded-2xl rounded-br-md border border-border bg-elevated px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-fg shadow-[0_1px_0_rgb(255_255_255/0.03)_inset]',
                // fala da chamada (transcrição): itálico; ditado é texto revisado — normal
                msg.meta.voice?.source === 'call' && 'italic'
              )}
            >
              {text}
            </div>
          )}
          <BubbleFooter msg={msg} branch={ctx.switcher(msg)}>
            <MessageActions
              msg={msg}
              canEdit={canEdit}
              onEdit={() => setEditing(true)}
              align="end"
            />
            <AutoTitleBadge rec={msg.meta.autoTitle} />
          </BubbleFooter>
        </>
      )}
    </div>
  )
}

/**
 * Linha sob o balão (alinhada à direita): ‹ i/n › (sempre visível, se houver versões) + ações no
 * hover + hora sempre visível.
 */
function BubbleFooter({
  msg,
  branch,
  children
}: {
  msg: StoredMessage
  branch?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="-mt-0.5 flex min-h-6 items-center justify-end gap-1.5 pr-1">
      {branch}
      {children}
      <VoiceBadge voice={msg.meta.voice} role="user" />
      <MsgTime ts={msg.createdAt} />
    </div>
  )
}

function SyntheticMessage({
  msg,
  canEdit
}: {
  msg: StoredMessage
  canEdit: boolean
}): React.JSX.Element {
  const m = msg.message
  const text = messageText(m.content)
  const isToolResult = /^<tool_result/.test(text)
  return (
    <div className="group/msg flex items-center gap-2 py-1.5 pl-1 text-[12px] text-subtle">
      <span className="h-px w-4 bg-border-strong" />
      <span className="shrink-0">
        {isToolResult ? 'Resultado de tool (texto)' : 'Mensagem do app'} ·{' '}
        <span className="font-mono">{m.role}</span>
      </span>
      <MessageInfo msg={msg} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{text}</span>
      {canEdit && (
        <span className="opacity-0 transition-opacity group-hover/msg:opacity-100">
          <ActionBtn
            label="Apagar mensagem"
            onClick={() => void useStore.getState().run(() => api.messages.delete(msg.id))}
            danger
          >
            <Trash2 className="size-3.5" />
          </ActionBtn>
        </span>
      )}
      <MsgTime ts={msg.createdAt} />
    </div>
  )
}

function ErrorRow({
  text,
  onDismiss,
  action
}: {
  text: string
  onDismiss?: () => void
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="my-2 flex animate-slide-up items-start gap-2.5 rounded-xl border border-danger/25 bg-danger/[0.06] px-3.5 py-2.5 text-[12.5px] text-danger">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap">
          {text}
        </div>
        {action && <div className="mt-2">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="rounded p-0.5 text-danger/70 hover:text-danger"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** Erro HTTP/do modelo persistido (meta.kind 'error'): só exibição, nunca enviado à API. */
function ErrorMessage({ msg, ctx }: { msg: StoredMessage; ctx: Ctx }): React.JSX.Element {
  const run = useStore((s) => s.run)
  const regenerate = useStore((s) => s.regenerate)
  const text = msg.meta.error ?? messageText(msg.message.content ?? '')
  const canEdit = !ctx.readOnly && !ctx.busy
  // erro que fecha o caminho: "Tentar de novo" (resposta só com erros → o runner substitui)
  const isLast = msg.id === ctx.trailingErrorId
  const ctxError = isLast && !ctx.readOnly && !ctx.busy && isContextLengthError(text)
  return (
    <div className="group/msg py-1">
      <ErrorRow
        text={text}
        action={ctxError ? <CompactRetryButton sessionId={ctx.sessionId} /> : undefined}
      />
      <div className="-mt-1 flex min-h-6 items-center gap-0.5">
        {canEdit && (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
            <MessageInfo msg={msg} />
            <ActionBtn
              label="Apagar mensagem"
              onClick={() => void run(() => api.messages.delete(msg.id), 'Erro ao apagar mensagem')}
              danger
            >
              <Trash2 className="size-3.5" />
            </ActionBtn>
            {isLast && (
              <ActionBtn
                label="Tentar de novo (regenerar)"
                onClick={() => void regenerate(ctx.sessionId, msg.id)}
              >
                <RotateCcw className="size-3.5" />
              </ActionBtn>
            )}
          </div>
        )}
        <MsgTime ts={msg.createdAt} className="ml-auto" />
      </div>
    </div>
  )
}

/** "Compactar e tentar de novo" — para erros de contexto excedido. */
function CompactRetryButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  const compact = useStore((s) => s.compact)
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<Layers className="size-3.5 text-accent-strong" />}
      onClick={() => void compact(sessionId, true)}
    >
      Compactar e tentar de novo
    </Button>
  )
}

/** Conteúdo do resumo (entre as tags <conversation_summary>). */
function summaryOf(text: string): string {
  const m = /<conversation_summary>\n?([\s\S]*?)\n?<\/conversation_summary>/.exec(text)
  return (m ? m[1] : text).trim()
}

/** Fronteira de compactação: resumo enviado como role:user no início do histórico ativo. */
function CompactionCard({
  msg,
  canEdit,
  stale
}: {
  msg: StoredMessage
  canEdit: boolean
  /** Fronteira antiga (antes da mais recente): também não é mais enviada. */
  stale?: boolean
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const text = msg.message.role === 'user' ? messageText(msg.message.content) : ''
  const summary = summaryOf(text)
  const meta = msg.meta
  const u = meta.compactUsage
  const cost = formatCost(u?.cost)
  return (
    <div
      data-testid="compaction-card"
      className="group/msg my-3 animate-slide-up overflow-hidden rounded-xl border border-accent/25 bg-accent-soft/25"
    >
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5">
        <Layers className="size-3.5 shrink-0 text-accent-strong" />
        <span className="text-[12.5px] font-medium text-fg/90">Resumo da conversa</span>
        {stale ? (
          <span className="text-[11px] text-subtle">· substituído por um resumo mais recente</span>
        ) : (
          <span className="text-[11px] text-subtle">· início do histórico enviado</span>
        )}
        <CompactionMessageInfo msg={msg} side="left" />
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          <CopyButton text={summary} label="" className="px-1" />
          {canEdit &&
            (confirm ? (
              <button
                type="button"
                onClick={() =>
                  void run(() => api.messages.delete(msg.id), 'Erro ao apagar o resumo')
                }
                onMouseLeave={() => setConfirm(false)}
                className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger/20"
              >
                Apagar? (volta a enviar tudo)
              </button>
            ) : (
              <ActionBtn
                label="Apagar resumo (desfaz a compactação)"
                onClick={() => setConfirm(true)}
                danger
              >
                <Trash2 className="size-3.5" />
              </ActionBtn>
            ))}
        </div>
      </div>
      <div className={cn('relative px-3.5 text-[13px]', !open && 'max-h-[132px] overflow-hidden')}>
        <Markdown text={summary} />
        {!open && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#16131f] to-transparent" />
        )}
      </div>
      <div className="flex items-center gap-2 px-3.5 pt-1 pb-2.5 text-[11px] text-subtle">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 rounded-md px-1 py-0.5 whitespace-nowrap text-accent-strong hover:bg-accent-soft"
        >
          {open ? 'Recolher' : 'Ver resumo completo'}
        </button>
        <span className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap tabular-nums text-faint">
          {meta.usageBefore != null && (
            <>
              <Tip label="Contexto antes → estimativa logo depois (system + resumo)">
                <span>
                  {formatTokens(meta.usageBefore)} → ~{formatTokens(meta.contextEstimate)} tokens
                </span>
              </Tip>
            </>
          )}
          {meta.model && (
            <>
              <span>·</span>
              <span className="truncate">{meta.model}</span>
            </>
          )}
          {cost && (
            <>
              <span>·</span>
              <span>{cost}</span>
            </>
          )}
          {formatDuration(meta.durationMs) && (
            <>
              <span>·</span>
              <span>{formatDuration(meta.durationMs)}</span>
            </>
          )}
          <span>·</span>
          <MsgTime ts={msg.createdAt} className="text-faint" />
        </span>
      </div>
    </div>
  )
}

/** Compactação em andamento (resumo transmitido ao vivo) ou agendada. */
function LiveCompaction({ state }: { state: CompactionState }): React.JSX.Element {
  if (state.state === 'scheduled') {
    return (
      <div className="my-2 flex items-center gap-2 py-1 pl-1 text-[12px] text-subtle">
        <Clock className="size-3.5 text-accent-strong" />
        Compactação agendada para o próximo passo do agente.
      </div>
    )
  }
  return (
    <div
      data-testid="compaction-live"
      className="my-3 overflow-hidden rounded-xl border border-accent/25 bg-accent-soft/20"
    >
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5 text-[12.5px]">
        <Spinner className="size-3.5 text-accent-strong" />
        <span className="font-medium text-fg/90">Compactando conversa…</span>
        <span className="text-[11px] text-subtle">
          o modelo está resumindo o histórico (esta request não entra no histórico)
        </span>
      </div>
      {state.text && (
        <div className="max-h-72 overflow-y-auto px-3.5 pb-3 text-[13px]">
          <Markdown text={state.text} streaming />
        </div>
      )}
    </div>
  )
}

// ---------- Mensagens de outras origens (outro chat, agente pai, subagente) ----------

/** Rótulo acima de uma bolha de usuário que não foi digitada aqui (ou "Você" num subagente). */
function OriginLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1 text-[10.5px] font-medium text-accent-strong/90">
      {children}
    </span>
  )
}

/** Mensagem entregue por outro chat (send_to_chat): "De: <título>" com link para o chat de origem. */
function InterChatMessage({
  msg,
  canEdit,
  branch
}: {
  msg: StoredMessage
  canEdit: boolean
  /** ‹ i/n › (versões desta mensagem), se houver. */
  branch?: ReactNode
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const openChat = useStore((s) => s.openChat)
  const source = useStore((s) => s.chats.find((c) => c.id === msg.meta.fromChatId))
  const [editing, setEditing] = useState(false)
  const text = msg.message.role === 'user' ? messageText(msg.message.content) : ''
  const { body } = splitInterChatText(text)
  const title = source?.title || msg.meta.fromChatTitle || 'outro chat'
  return (
    <div
      data-testid="inter-chat-message"
      className="group/msg flex animate-slide-up flex-col items-end gap-1 py-2"
      onContextMenu={(e) =>
        !editing &&
        contributeCtx(e, {
          copy: { copyMessage: text },
          run: canEdit ? { editMessage: () => setEditing(true) } : undefined
        })
      }
    >
      {editing ? (
        <InlineEditor
          initial={text}
          onCancel={() => setEditing(false)}
          onSave={(t) => {
            setEditing(false)
            void run(() => api.messages.update(msg.id, withText(msg.message, t)), 'Erro ao editar')
          }}
        />
      ) : (
        <>
          <OriginLabel>
            <MessagesSquare className="size-3" />
            De:{' '}
            {source ? (
              <button
                type="button"
                onClick={() => void openChat(source.id)}
                className="underline decoration-accent-strong/40 underline-offset-2 hover:decoration-accent-strong"
              >
                {title}
              </button>
            ) : (
              <span>{title} (chat apagado)</span>
            )}
            {msg.meta.interChatHops && msg.meta.interChatHops > 1 ? (
              <span className="font-normal text-faint">
                · {msg.meta.interChatHops}º salto entre chats
              </span>
            ) : null}
          </OriginLabel>
          <div className="max-w-[85%] rounded-2xl rounded-br-md border border-accent-strong/30 bg-accent-soft/40 px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-fg">
            {body}
          </div>
          <BubbleFooter msg={msg} branch={branch}>
            <MessageActions
              msg={msg}
              canEdit={canEdit}
              onEdit={() => setEditing(true)}
              align="end"
            />
          </BubbleFooter>
        </>
      )}
    </div>
  )
}

/**
 * Mensagem do agente pai (message_subagent), de um subagente irmão (mensagem direta ou broadcast)
 * ou do usuário, numa subsessão.
 */
function SubsessionUserMessage({
  msg,
  canEdit,
  from
}: {
  msg: StoredMessage
  canEdit: boolean
  from: 'you' | 'parent' | 'sibling'
}): React.JSX.Element {
  const sibling = useStore((s) =>
    from === 'sibling' && msg.meta.fromSessionId ? s.sessions[msg.meta.fromSessionId] : undefined
  )
  const text = msg.message.role === 'user' ? messageText(msg.message.content) : ''
  const split = from === 'sibling' ? splitSiblingText(text) : null
  const body =
    from === 'parent'
      ? text.replace(/^\[Mensagem do agente pai\]\n/, '')
      : split
        ? split.body
        : text
  const broadcast = msg.meta.kind === 'sibling-broadcast'
  const siblingName = sibling?.title || split?.title || 'Subagente'
  const hasAttachments =
    messageAttachments(msg.message).length > 0 || messageSkills(msg.message).length > 0
  return (
    <div
      data-testid={
        from === 'parent'
          ? 'parent-message'
          : from === 'sibling'
            ? 'sibling-message'
            : 'user-in-sub'
      }
      className="group/msg flex animate-slide-up flex-col items-end gap-1 py-2"
      onContextMenu={(e) => contributeCtx(e, { copy: { copyMessage: text } })}
    >
      <OriginLabel>
        {from === 'parent' ? (
          <>
            <Bot className="size-3" /> Agente pai
          </>
        ) : from === 'sibling' ? (
          <>
            {broadcast ? <Radio className="size-3" /> : <Users className="size-3" />}
            {broadcast ? 'Broadcast do irmão' : 'Mensagem do irmão'} {siblingName}
          </>
        ) : (
          <>
            <User className="size-3" /> Você
          </>
        )}
      </OriginLabel>
      {msg.message.role === 'user' && Array.isArray(msg.message.content) && (
        <MessageAttachments parts={msg.message.content} />
      )}
      {(body || !hasAttachments) && (
        <div
          className={cn(
            'max-w-[85%] rounded-2xl rounded-br-md border px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-fg',
            from === 'you'
              ? 'border-border bg-elevated'
              : 'border-accent-strong/30 bg-accent-soft/40'
          )}
        >
          {body}
        </div>
      )}
      <BubbleFooter msg={msg}>
        <MessageActions msg={msg} canEdit={canEdit} onEdit={() => undefined} align="end" />
      </BubbleFooter>
    </div>
  )
}

/** Resultado de um subagente em segundo plano (ou atualização) injetado como role:user sintética. */
function CallbackCard({
  msg,
  chatId,
  canEdit
}: {
  msg: StoredMessage
  chatId: string
  canEdit: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const openChat = useStore((s) => s.openChat)
  const sub = useStore((s) =>
    msg.meta.subSessionId ? s.sessions[msg.meta.subSessionId] : undefined
  )
  const text = msg.message.role === 'user' ? messageText(msg.message.content) : ''
  const nl = text.indexOf('\n')
  // exibição: sem os colchetes e sem o id (o id completo fica no (i) e no link da subsessão)
  const header = (nl === -1 ? text : text.slice(0, nl))
    .replace(/^\[|\]$/g, '')
    .replace(/ \(id [^)]+\)/, '')
  const body = nl === -1 ? '' : text.slice(nl + 1)
  const failed = / (falhou|foi cancelado|não concluiu)$/.test(header)
  return (
    <div
      data-testid="subagent-callback"
      className="group/msg my-2 overflow-hidden rounded-xl border border-border bg-surface/70"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}
        className="flex h-9 items-center gap-2.5 px-3 hover:bg-white/[0.015]"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-faint transition-transform duration-150',
            open && 'rotate-90'
          )}
        />
        <Bot className={cn('size-3.5 shrink-0', failed ? 'text-danger' : 'text-accent-strong')} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg/90">{header}</span>
        <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
          <MessageInfo msg={msg} side="left" />
          {sub && (
            <button
              type="button"
              onClick={() => void openChat(chatId, sub.id)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-accent-strong hover:bg-accent-soft"
            >
              <ArrowUpRight className="size-3" /> Abrir subsessão
            </button>
          )}
          {canEdit && (
            <ActionBtn
              label="Apagar mensagem"
              onClick={() => void useStore.getState().run(() => api.messages.delete(msg.id))}
              danger
            >
              <Trash2 className="size-3.5" />
            </ActionBtn>
          )}
          <MsgTime ts={msg.createdAt} className="ml-1" />
        </span>
      </div>
      {!open && body && (
        <p className="line-clamp-2 border-t border-border/70 px-3.5 py-2 text-[12.5px] leading-relaxed text-muted">
          {body}
        </p>
      )}
      {open && body && (
        <div className="max-h-96 overflow-y-auto border-t border-border/70 px-3.5 py-2.5 text-[13px]">
          <Markdown text={body} />
        </div>
      )}
    </div>
  )
}

interface Ctx {
  chatId: string
  sessionId: string
  busy: boolean
  readOnly: boolean
  results: Map<string, StoredMessage>
  runs: Record<string, ToolRun>
  approvals: ApprovalRequest[]
  /** Aprovações de todas as sessões (para mostrar a do subagente no card de delegate). */
  allApprovals: ApprovalRequest[]
  childByToolCall: Map<string, Session>
  /** Aprovações das subárvores dos delegates desta sessão, por âncora (card do delegate). */
  hostedBy: Map<string, ApprovalRequest[]>
  /** Profundidade da sessão (0 = principal). */
  depth: number
  /** Última resposta do assistente de cada turno do caminho (onde fica "Regenerar resposta"). */
  regenTargets: Set<string>
  /** Erro persistido que fecha o caminho ("Tentar de novo"), ou null. */
  trailingErrorId: string | null
  /** ‹ i/n › da mensagem (null = só uma versão). `reveal`: só aparece no hover, como os outros ícones do rodapé. */
  switcher: (m: StoredMessage, reveal?: boolean) => ReactNode
  /** Avisos do editor de nova versão (fronteira de compactação, subagentes que serão parados…). */
  editHints: (m: StoredMessage) => ReactNode[]
}

function AssistantMessage({ msg, ctx }: { msg: StoredMessage; ctx: Ctx }): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [editing, setEditing] = useState(false)
  if (msg.message.role !== 'assistant') return <></>
  const m = msg.message
  const content = m.content ?? ''
  const canEdit = !ctx.readOnly && !ctx.busy
  // última resposta de um turno: regenerar cria uma nova versão (a atual continua salva)
  const canRegen = canEdit && ctx.depth === 0 && ctx.regenTargets.has(msg.id)
  return (
    <div
      className="group/msg animate-slide-up py-2"
      onContextMenu={(e) =>
        !editing &&
        contributeCtx(e, {
          copy: { copyMessage: () => markdownToPlainText(content), copyMarkdown: content },
          run: {
            ...(canEdit ? { editMessage: () => setEditing(true) } : {}),
            ...(canRegen
              ? { regenerate: () => void useStore.getState().regenerate(ctx.sessionId, msg.id) }
              : {})
          }
        })
      }
    >
      {m.reasoning && (
        <Reasoning
          text={m.reasoning}
          id={msg.id}
          durationMs={msg.meta.reasoningMs}
          tokens={msg.meta.usage?.reasoningTokens}
        />
      )}
      {editing ? (
        <InlineEditor
          initial={content}
          onCancel={() => setEditing(false)}
          onSave={(t) => {
            setEditing(false)
            void run(() => api.messages.update(msg.id, withText(msg.message, t)), 'Erro ao editar')
          }}
        />
      ) : (
        content &&
        (msg.meta.voice?.source === 'call' ? (
          // resposta falada na chamada: itálico (o texto é o que foi dito); enquanto é falada, o que
          // ainda não tocou fica esmaecido (leitura ao vivo)
          <div data-voice="call" className="italic">
            <VoiceMarkdown text={content} />
          </div>
        ) : (
          <Markdown text={content} />
        ))
      )}
      {msg.meta.voice?.unheard ? (
        // barge-in no meio: o resto que você não ouviu fica legível, esmaecido, depois do marcador
        <div data-testid="voice-unheard" className="mt-1 italic">
          <span className="mr-1.5 inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-0.5 align-middle text-[11px] not-italic text-subtle">
            <X className="size-3" /> interrompido
          </span>
          <Markdown text={msg.meta.voice.unheard} voice={VOICE_UNHEARD} />
        </div>
      ) : (
        msg.meta.interrupted && (
          <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-subtle">
            <X className="size-3" /> Interrompida pelo usuário
          </div>
        )
      )}
      {m.tool_calls?.map((tc) => {
        const result = ctx.results.get(tc.id)
        // end_call (chamada de voz): linha compacta de sistema, sem card de tool
        if (tc.function.name === 'end_call')
          return <EndCallLine key={tc.id} call={tc} result={result} />
        // present_file: só os cards dos arquivos, sem o cabeçalho de tool (erro/cancelado → card normal)
        if (
          tc.function.name === 'present_file' &&
          (result ? !!result.meta.presentFiles : !!presentedFilesOf(tc.function.arguments))
        ) {
          return (
            <PresentFileCards
              key={tc.id}
              chatId={ctx.chatId}
              args={tc.function.arguments}
              result={result}
              pending={!result}
            />
          )
        }
        const sub = ctx.childByToolCall.get(tc.id)
        const approval = ctx.approvals.find((a) => a.toolCallId === tc.id)
        const key = anchorId(ctx.sessionId, tc.id)
        return (
          <ToolCard
            key={tc.id}
            call={{ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }}
            result={ctx.results.get(tc.id)}
            run={ctx.runs[tc.id]}
            approval={approval}
            subApprovals={sub ? ctx.hostedBy.get(key) : undefined}
            anchor={approval || sub ? key : undefined}
            sessionBusy={ctx.busy}
            subSession={sub}
            chatId={ctx.chatId}
          />
        )
      })}
      {msg.meta.error && <ErrorRow text={msg.meta.error} />}
      {!editing && (
        <div className="mt-1.5 flex min-h-6 items-center gap-3">
          {ctx.switcher(msg)}
          <UsageFooter msg={msg} judge={judgeTotals(msg, ctx.results)} />
          <MessageActions
            msg={msg}
            canEdit={canEdit}
            onEdit={() => setEditing(true)}
            onRegenerate={
              canRegen
                ? () => void useStore.getState().regenerate(ctx.sessionId, msg.id)
                : undefined
            }
          />
          <span className="ml-auto flex items-center gap-1.5">
            <VoiceBadge voice={msg.meta.voice} role="assistant" />
            <MsgTime ts={msg.createdAt} />
          </span>
        </div>
      )}
    </div>
  )
}

function OrphanTool({ msg, canEdit }: { msg: StoredMessage; canEdit: boolean }): React.JSX.Element {
  const text = msg.message.role === 'tool' ? messageText(msg.message.content) : ''
  return (
    <div
      className="group/msg py-1.5"
      onContextMenu={(e) => contributeCtx(e, { copy: { copyMessage: text } })}
    >
      <div className="rounded-xl border border-border bg-surface/70 px-3.5 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-subtle">
          Resultado de tool <MessageInfo msg={msg} />
        </div>
        <pre className="max-h-60 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-fg/80">
          {text}
        </pre>
      </div>
      <div className="mt-1 flex min-h-6 items-center">
        <MessageActions msg={msg} canEdit={canEdit} onEdit={() => {}} />
        <MsgTime ts={msg.createdAt} className="ml-auto" />
      </div>
    </div>
  )
}

const DraftView = memo(function DraftView({
  draft,
  ctx
}: {
  draft: StreamDraft
  ctx: Ctx
}): React.JSX.Element {
  const clock = useStore((s) => s.reasoningClocks[ctx.sessionId])
  const inCall = useStore((s) => s.voiceCall.active && s.voiceCall.sessionId === ctx.sessionId)
  const live = !draft.content && !draft.toolCalls.length
  return (
    <div className="py-2">
      {draft.reasoning && (
        <Reasoning
          text={draft.reasoning}
          live={live}
          startedAt={clock?.start}
          durationMs={clock?.end != null ? clock.end - clock.start : undefined}
        />
      )}
      {(draft.content || (!draft.reasoning && !draft.toolCalls.length)) &&
        (inCall ? (
          // resposta da chamada ainda chegando: itálico + leitura ao vivo
          <div data-voice="call" className="italic">
            <VoiceMarkdown text={draft.content} />
          </div>
        ) : (
          <Markdown text={draft.content} streaming={!draft.toolCalls.length} />
        ))}
      {draft.toolCalls.map((tc, i) =>
        tc.name === 'end_call' ? (
          <EndCallLine
            key={tc.id || i}
            call={{ function: { name: tc.name, arguments: tc.arguments } }}
          />
        ) : tc.name === 'present_file' && presentedFilesOf(tc.arguments) ? (
          <PresentFileCards key={tc.id || i} chatId={ctx.chatId} args={tc.arguments} pending />
        ) : (
          <ToolCard key={tc.id || i} call={tc} streaming sessionBusy chatId={ctx.chatId} />
        )
      )}
    </div>
  )
})

function Thinking(): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 py-3 pl-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse-soft rounded-full bg-subtle"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </div>
  )
}

// ---------- Lista ----------

/**
 * Posição de `node` no conteúdo do `scroller` (soma de offsetTop; não depende da rolagem nem de
 * transforms — as mensagens recém-montadas entram com animação de deslize, que distorceria o
 * getBoundingClientRect). Se a cadeia sair do scroller, a origem é outra, mas a mesma nas duas
 * medidas (antes/depois da troca), que é o que importa.
 */
function offsetIn(node: HTMLElement, scroller: HTMLElement): number {
  let y = 0
  let cur: HTMLElement | null = node
  while (cur && cur !== scroller) {
    y += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  return y
}

export function MessageList({
  chatId,
  session,
  readOnly,
  empty
}: {
  chatId: string
  session: Session
  readOnly: boolean
  empty?: ReactNode
}): React.JSX.Element {
  const sessionId = session.id
  // todas as versões (árvore); o que aparece é o caminho ativo
  const allMessages = useStore(selectMessages(sessionId))
  const loaded = useStore((s) => sessionId in s.messages)
  const selectBranch = useStore((s) => s.selectBranch)
  const host = useHostInfo(chatId)
  // Views só de leitura (host offline; subsessão): trocar de versão vale só nesta tela.
  const localSwitch = readOnly || host?.mode === 'host-offline'
  const [localSel, setLocalSel] = useState<{
    sid: string
    base: BranchSel | undefined
    sel: BranchSel
  } | null>(null)
  // a seleção local cai quando a sincronizada muda (ou ao trocar de sessão / sair do modo leitura)
  const override =
    localSwitch &&
    localSel &&
    localSel.sid === sessionId &&
    selEquals(localSel.base, session.branchSel)
      ? localSel.sel
      : null
  const { tree, path: messages, siblings } = useBranchView(session, allMessages, override)
  const draft = useStore((s) => s.drafts[sessionId] ?? null)
  const runs = useStore(selectRuns(sessionId))
  const allApprovals = useStore((s) => s.approvals)
  const sessions = useStore((s) => s.sessions)
  const error = useStore((s) => s.errors[sessionId])
  const dismissError = useStore((s) => s.dismissError)
  const compaction = useStore((s) => s.compactions[sessionId])
  const [showOld, setShowOld] = useState(true)
  const busy = isBusy(session.status)
  const boundary = useMemo(() => latestBoundaryIndex(messages), [messages])

  // ---- troca de versão (‹ i/n ›) ----
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  /**
   * Posição do ‹ i/n › na tela antes da troca: depois dela ele fica no mesmo lugar (e com o foco,
   * se tinha — o controle é remontado na outra versão).
   */
  const switchAnchor = useRef<{ group: string; top: number; focus: boolean } | null>(null)
  /**
   * Espaço extra no fim para o ‹ i/n › ficar no lugar quando a versão nova é mais curta; só cobre o
   * que falta e encolhe conforme a rolagem/o conteúdo voltam a cobrir a tela (trimSpacer).
   */
  const spacer = useRef<HTMLDivElement>(null)
  const trimSpacer = useCallback((): void => {
    const el = scroller.current
    const sp = spacer.current
    if (!el || !sp) return
    const h = sp.offsetHeight
    if (!h) return
    const need = Math.max(0, Math.ceil(el.scrollTop + el.clientHeight - (el.scrollHeight - h)))
    if (need < h) sp.style.height = need ? `${need}px` : ''
  }, [])
  const onSelectBranch = useCallback(
    (id: string): void => {
      const group = branchGroup(tree, id)
      const el = scroller.current?.querySelector<HTMLElement>(
        `[data-branch-group="${CSS.escape(group)}"]`
      )
      const sc = scroller.current
      switchAnchor.current =
        el && sc
          ? {
              group,
              top: offsetIn(el, sc) - sc.scrollTop,
              focus: el.contains(document.activeElement)
            }
          : null
      pinned.current = false
      if (localSwitch)
        setLocalSel({
          sid: sessionId,
          base: session.branchSel,
          sel: selectionToReach(tree, override ?? session.branchSel, id)
        })
      else void selectBranch(sessionId, id)
    },
    [tree, localSwitch, sessionId, session.branchSel, override, selectBranch]
  )
  useLayoutEffect(() => {
    const a = switchAnchor.current
    const el = scroller.current
    if (!a || !el) return
    switchAnchor.current = null
    const sw = el.querySelector<HTMLElement>(`[data-branch-group="${CSS.escape(a.group)}"]`)
    if (!sw) return
    const target = offsetIn(sw, el) - a.top
    el.scrollTop = target
    // versão mais curta: o navegador limita a rolagem → completa com o espaço extra (scrollHeight
    // nunca é menor que a altura visível, por isso pode precisar de mais de uma passada)
    const sp = spacer.current
    for (let i = 0; sp && i < 3 && target - el.scrollTop > 0.5; i++) {
      sp.style.height = `${sp.offsetHeight + Math.ceil(target - el.scrollTop)}px`
      el.scrollTop = target
    }
    if (a.focus) sw.focus({ preventScroll: true })
  }, [messages])
  // outra sessão: sem espaço extra
  useLayoutEffect(() => {
    if (spacer.current) spacer.current.style.height = ''
  }, [sessionId])

  const ctx = useMemo<Ctx>(() => {
    const results = new Map<string, StoredMessage>()
    for (const m of messages) if (m.message.role === 'tool') results.set(m.message.tool_call_id, m)
    const childByToolCall = new Map<string, Session>()
    for (const s of Object.values(sessions))
      if (s.parentSessionId === sessionId && s.parentToolCallId)
        childByToolCall.set(s.parentToolCallId, s)
    const hostedBy = new Map<string, ApprovalRequest[]>()
    for (const a of [...allApprovals].sort((x, y) => x.createdAt - y.createdAt)) {
      if (a.sessionId === sessionId || a.chatId !== chatId) continue
      const key = anchorFor(a.sessionId, a.toolCallId, sessionId, sessions)
      if (key) hostedBy.set(key, [...(hostedBy.get(key) ?? []), a])
    }
    // subagentes em segundo plano ainda rodando (origem → impede trocar a versão acima deles)
    const busyCalls = Object.values(sessions)
      .filter((s) => s.parentSessionId === sessionId && s.parentToolCallId && isBusy(s.status))
      .map((s) => s.parentToolCallId as string)
    const parentOf = (id: string): string | null => tree.parentOf.get(id) ?? null
    const pathIndex = new Map(messages.map((m, i) => [m.id, i]))
    const switchBlocked = (m: StoredMessage): string | null => {
      if (localSwitch) return null
      if (busy) return 'Disponível quando o agente terminar'
      if (subagentsBelow(tree, parentOf(m.id), busyCalls) > 0)
        return 'Disponível quando os subagentes desta versão terminarem'
      return null
    }
    const switcher = (m: StoredMessage, reveal = true): ReactNode => {
      const info = siblings.get(m.id)
      if (!info) return null
      return (
        <BranchSwitcher
          info={info}
          group={branchGroup(tree, m.id)}
          onSelect={onSelectBranch}
          disabledReason={switchBlocked(m)}
          local={localSwitch}
          className={
            reveal
              ? 'opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100'
              : undefined
          }
        />
      )
    }
    const editHints = (m: StoredMessage): ReactNode[] => {
      const out: ReactNode[] = []
      const i = pathIndex.get(m.id) ?? -1
      if (boundary > 0 && i >= 0 && i < boundary)
        out.push(
          'Antes do resumo da conversa: a nova versão não usa o resumo e reenvia o histórico original (pode passar do limite de contexto).'
        )
      const n = subagentsBelow(tree, parentOf(m.id), busyCalls)
      if (n > 0)
        out.push(
          <span className="text-warning/90">
            {n} subagente{n > 1 ? 's' : ''} desta versão {n > 1 ? 'serão parados' : 'será parado'}.
          </span>
        )
      out.push('Mudanças em arquivos feitas pelo agente não são desfeitas.')
      return out
    }
    return {
      chatId,
      sessionId,
      busy,
      readOnly,
      results,
      runs,
      approvals: allApprovals.filter((a) => a.sessionId === sessionId),
      allApprovals,
      childByToolCall,
      hostedBy,
      depth: session.depth,
      regenTargets: regenerateTargets(messages),
      trailingErrorId: trailingErrorId(messages),
      switcher,
      editHints
    }
  }, [
    messages,
    sessions,
    sessionId,
    chatId,
    busy,
    readOnly,
    runs,
    allApprovals,
    tree,
    siblings,
    boundary,
    localSwitch,
    session.depth,
    onSelectBranch
  ])

  // Tool calls conhecidas (para não duplicar resultados/aprovações).
  const knownCalls = useMemo(() => {
    const set = new Set<string>()
    for (const m of messages)
      if (m.message.role === 'assistant')
        for (const tc of m.message.tool_calls ?? []) set.add(tc.id)
    return set
  }, [messages])

  // ---- auto-scroll ----
  const inner = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  useLayoutEffect(() => {
    pinned.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [sessionId, loaded])

  useEffect(() => {
    const el = scroller.current
    const content = inner.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      trimSpacer()
      if (pinned.current) el.scrollTop = el.scrollHeight
    })
    // border-box: o padding do fim acompanha o composer flutuante (cresce com fila, anexos, texto)
    ro.observe(content, { box: 'border-box' })
    ro.observe(el)
    return () => ro.disconnect()
  }, [trimSpacer])

  useAnchorRoot(scroller)

  // ---- data fixa no topo ao rolar (estilo WhatsApp) ----
  // Só aparece com rolagem do USUÁRIO (roda/toque/teclado/arrastar a barra) — o auto-scroll do
  // "preso ao fim" não a mostra. Rótulo = dia do último separador que já passou do topo; nenhum
  // passou (início da conversa, separador visível) → não aparece; o separador seguinte chegando
  // ao topo esconde a pílula (o próprio separador ocupa o lugar). Some 1,5 s após parar. Conversa
  // de um dia só (um separador) → nunca aparece.
  const [stickyState, setSticky] = useState<{ label: string; show: boolean; sid?: string }>({
    label: '',
    show: false
  })
  // ao trocar de sessão a pílula da anterior não vale (o rótulo é por sessão)
  const sticky =
    stickyState.sid === sessionId ? stickyState : { label: '', show: false, sid: sessionId }
  const userScrollAt = useRef(0)
  const dragging = useRef(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const mark = (): void => {
      userScrollAt.current = Date.now()
    }
    const down = (): void => {
      dragging.current = true
      mark()
    }
    const up = (): void => {
      dragging.current = false
    }
    el.addEventListener('wheel', mark, { passive: true })
    el.addEventListener('touchmove', mark, { passive: true })
    el.addEventListener('keydown', mark)
    el.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    return () => {
      el.removeEventListener('wheel', mark)
      el.removeEventListener('touchmove', mark)
      el.removeEventListener('keydown', mark)
      el.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])
  const STICKY_BAND = 40
  const updateSticky = useCallback((): void => {
    const el = scroller.current
    if (!el) return
    const user = dragging.current || Date.now() - userScrollAt.current < 800
    if (!user) return
    const top = el.getBoundingClientRect().top
    let label = ''
    let nextNear = false
    const seps = el.querySelectorAll<HTMLElement>('[data-day-sep]')
    // conversa de um dia só: o separador do topo já diz o dia — sem pílula fixa
    if (seps.length < 2) return
    for (const sep of seps) {
      const r = sep.getBoundingClientRect()
      if (r.top <= top + 4) label = sep.dataset.dayLabel ?? ''
      else {
        nextNear = r.top < top + STICKY_BAND
        break
      }
    }
    const show = !!label && !nextNear
    setSticky((s) => {
      const prev = s.sid === sessionId ? s.label : ''
      const next = label || prev
      return s.sid === sessionId && s.label === next && s.show === show
        ? s
        : { label: next, show, sid: sessionId }
    })
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setSticky((s) => ({ ...s, show: false })), 1500)
  }, [sessionId])

  const lastTop = useRef(0)
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    // Só desfixa do fim quando o usuário rola para CIMA: o scroll-anchoring do navegador também
    // dispara `scroll` (descendo um pouco) quando o conteúdo cresce, antes do ResizeObserver.
    const up = el.scrollTop < lastTop.current - 1
    lastTop.current = el.scrollTop
    if (bottom) pinned.current = true
    else if (up) pinned.current = false
    if (bottom !== atBottom) setAtBottom(bottom)
    trimSpacer()
    updateSticky()
  }

  // O erro do evento `error` também é persistido como mensagem (meta.kind 'error'): não duplica.
  const persistedError =
    !!error && messages.some((m) => m.meta.kind === 'error' && m.meta.error === error)

  const showThinking =
    busy &&
    session.status !== 'waiting' &&
    session.status !== 'awaiting_retry' &&
    !draft &&
    compaction?.state !== 'running' &&
    Object.values(runs).every((r) => !r.running && !r.judging) &&
    ctx.approvals.length === 0
  const canEdit = !readOnly && !busy

  /** Mensagens cujo componente já mostra o ‹ i/n › (balão do usuário, rodapé do assistente). */
  const nativeSwitcher = (m: StoredMessage): boolean => {
    const role = m.message.role
    if (
      isExtractionMessage(m.meta) ||
      m.meta.kind === 'compaction' ||
      m.meta.kind === 'error' ||
      m.meta.kind === 'voice-call'
    )
      return false
    if (role === 'assistant') return true
    if (role !== 'user' || m.meta.synthetic) return false
    if (m.meta.kind === 'inter-chat') return true
    if (
      m.meta.kind === 'subagent-callback' ||
      m.meta.kind === 'parent-message' ||
      isSiblingKind(m.meta.kind)
    )
      return false
    return session.depth === 0
  }
  const renderMessage = (m: StoredMessage, old: boolean): ReactNode => {
    const role = m.message.role
    // extração de memórias: só exibição (não vai à API), qualquer role
    if (isExtractionMessage(m.meta)) return <ExtractionCard key={m.id} msg={m} canEdit={canEdit} />
    if (m.meta.kind === 'compaction')
      return <CompactionCard key={m.id} msg={m} canEdit={canEdit} stale={old} />
    if (m.meta.kind === 'error') return <ErrorMessage key={m.id} msg={m} ctx={ctx} />
    // marcador de início/fim da chamada de voz (só exibição)
    if (m.meta.kind === 'voice-call') return <CallMarker key={m.id} msg={m} />
    if (role === 'user' && m.meta.kind === 'inter-chat')
      return <InterChatMessage key={m.id} msg={m} canEdit={canEdit} branch={ctx.switcher(m)} />
    if (role === 'user' && m.meta.kind === 'subagent-callback')
      return <CallbackCard key={m.id} msg={m} chatId={chatId} canEdit={canEdit} />
    if (role === 'user' && m.meta.kind === 'parent-message')
      return <SubsessionUserMessage key={m.id} msg={m} canEdit={false} from="parent" />
    if (role === 'user' && isSiblingKind(m.meta.kind))
      return <SubsessionUserMessage key={m.id} msg={m} canEdit={false} from="sibling" />
    if (role === 'user' && session.depth > 0 && !m.meta.synthetic)
      return <SubsessionUserMessage key={m.id} msg={m} canEdit={false} from="you" />
    if (m.meta.synthetic && role !== 'assistant') {
      if (role === 'tool' && knownCalls.has(m.message.tool_call_id)) return null
      return <SyntheticMessage key={m.id} msg={m} canEdit={canEdit} />
    }
    if (role === 'user') return <UserMessage key={m.id} msg={m} canEdit={canEdit} ctx={ctx} />
    if (role === 'assistant') return <AssistantMessage key={m.id} msg={m} ctx={ctx} />
    if (role === 'tool') {
      if (knownCalls.has(m.message.tool_call_id)) return null
      return <OrphanTool key={m.id} msg={m} canEdit={canEdit} />
    }
    return (
      <div key={m.id} className="flex items-center gap-1.5 py-1 text-[12px] text-subtle">
        system <ApiInfo code={messageText(m.message.content)} />
      </div>
    )
  }
  const oldMsgs = boundary > 0 ? messages.slice(0, boundary) : []
  const activeMsgs = boundary > 0 ? messages.slice(boundary) : messages
  const oldCount = oldMsgs.filter((m) => !isDisplayOnly(m.meta)).length

  // ---- separadores de dia (sobre as mensagens que de fato aparecem) ----
  const now = useToday()
  const starts = useMemo(() => {
    const shown = (showOld ? messages : messages.slice(Math.max(boundary, 0))).filter(
      (m) => !(m.message.role === 'tool' && knownCalls.has(m.message.tool_call_id))
    )
    return dayStarts(shown)
  }, [messages, boundary, showOld, knownCalls])
  const renderItem = (m: StoredMessage, old: boolean): ReactNode => {
    const el = renderMessage(m, old)
    if (!el) return null
    // outras mensagens com versões (erro, sintética…): ‹ i/n › numa linha pequena acima (fora do
    // grupo de hover da mensagem: fica sempre visível)
    const row = siblings.has(m.id) && !nativeSwitcher(m) ? ctx.switcher(m, false) : null
    return (
      <Fragment key={m.id}>
        {starts.has(m.id) && <DaySeparator ts={m.createdAt} now={now} />}
        {row && <div className="flex justify-start pt-1">{row}</div>}
        {el}
      </Fragment>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        data-chat-scroller
        data-testid="chat-scroller"
        className="absolute inset-0 scroll-pt-6 scroll-pb-[calc(var(--chat-bottom-inset,0px)+16px)] overflow-y-auto [scrollbar-gutter:stable]"
      >
        {/* o fim fica acima do composer flutuante (--chat-bottom-inset = altura da pilha de baixo) */}
        <div
          ref={inner}
          className="mx-auto w-full max-w-[1920px] px-8 pt-6 pb-[calc(var(--chat-bottom-inset,140px)+24px)]"
        >
          {loaded && allMessages.length === 0 && !draft && !busy && empty}
          {oldMsgs.length > 0 && showOld && (
            <div
              data-testid="compacted-old"
              className="opacity-[0.55] transition-opacity duration-200 hover:opacity-80"
            >
              {oldMsgs.map((m) => renderItem(m, true))}
            </div>
          )}
          {oldMsgs.length > 0 && (
            <div data-testid="compaction-divider" className="my-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-gradient-to-r from-transparent to-border-strong" />
              <span className="flex items-center gap-1.5 text-[11.5px] text-subtle">
                <Layers className="size-3.5 text-accent-strong/80" />
                <span className="font-medium text-muted">Conversa compactada</span>
                <span className="text-faint">·</span>
                {oldCount} {oldCount === 1 ? 'mensagem resumida' : 'mensagens resumidas'}
                <span className="text-faint">·</span>
                não são mais enviadas à API
                <button
                  type="button"
                  onClick={() => setShowOld((v) => !v)}
                  className="ml-1 rounded-md px-1.5 py-0.5 text-accent-strong hover:bg-accent-soft"
                >
                  {showOld ? 'Ocultar' : 'Mostrar'}
                </button>
              </span>
              <span className="h-px flex-1 bg-gradient-to-l from-transparent to-border-strong" />
            </div>
          )}
          {activeMsgs.map((m) => renderItem(m, false))}
          {compaction && <LiveCompaction state={compaction} />}
          {draft && <DraftView draft={draft} ctx={ctx} />}
          {ctx.approvals
            .filter((a) => !knownCalls.has(a.toolCallId))
            .map((a) => (
              <OrphanApproval key={a.id} request={a} anchor={anchorId(sessionId, a.toolCallId)} />
            ))}
          {showThinking && <Thinking />}
          {error && !persistedError && (
            <ErrorRow
              text={error}
              onDismiss={() => dismissError(sessionId)}
              action={
                !readOnly && !busy && isContextLengthError(error) ? (
                  <CompactRetryButton sessionId={sessionId} />
                ) : undefined
              }
            />
          )}
        </div>
        <div ref={spacer} aria-hidden data-testid="branch-spacer" />
      </div>
      <div
        aria-hidden
        data-testid="sticky-day"
        data-show={sticky.show || undefined}
        className={cn(
          'pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center transition-opacity',
          sticky.show ? 'opacity-100 duration-150' : 'opacity-0 duration-500'
        )}
      >
        {sticky.label && (
          <DayPill
            label={sticky.label}
            className="border-border-strong bg-elevated shadow-popover"
          />
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            const el = scroller.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
          }}
          className="absolute bottom-[calc(var(--chat-bottom-inset,0px)+10px)] left-1/2 z-30 flex size-8 -translate-x-1/2 animate-pop-in items-center justify-center rounded-full border border-border-strong bg-elevated text-muted shadow-popover hover:text-fg"
          aria-label="Ir para o fim"
          data-testid="scroll-to-bottom"
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
}
