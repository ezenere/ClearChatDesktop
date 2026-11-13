import {
  Ban,
  BookOpenText,
  Bot,
  Clock,
  Check,
  ChevronRight,
  CircleX,
  Cpu,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FolderOpen,
  FolderSearch,
  FolderTree,
  Globe,
  Hand,
  Search,
  Terminal,
  Wrench,
  ArrowUpRight,
  CircleStop,
  History,
  Hourglass,
  Info,
  ListChecks,
  MessageSquareText,
  MessagesSquare,
  Send,
  Play,
  Presentation,
  ScrollText,
  Activity,
  MessageCircleQuestion,
  WifiOff,
  type LucideIcon
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { TOOL_LABELS } from '@shared/tools'
import { toolLabel } from '@shared/deviceTools'
import { approxTokens } from '@shared/limits'
import type { ApprovalRequest, MessageMeta, Session, StoredMessage, ToolName } from '@shared/types'
import { TOOL_ALIASES } from '@shared/types'
import { cn, formatTokens, prettyJson } from '../../lib/format'
import { useStore, type ToolRun } from '../../store'
import { MessageInfo, TaskInfo } from '../apiDocs'
import { ApiInfo, C, Tip } from '../ui/Tooltip'
import { Button, Spinner } from '../ui/controls'
import { CopyButton } from './Markdown'
import { StatusDot } from './SessionSwitcher'
import { ModelLabel } from '../ui/ModelLabel'
import { ApprovalBadge, DeniedStrip } from './ApprovalOutcome'
import { approvalOutcome, type ApprovalOutcome } from '../../lib/approvalOutcome'
import { ApprovalPrompt } from './ApprovalCard'
import { AskUserAnswers, AskUserQuestionsList } from './AskUser'
import { ToolResultMedia } from './Attachments'
import { toolContentText } from '@shared/attachments'
import { isAnchorShown, shortFailure } from '../../lib/approvalAnchors'
import { useAnchor } from '../../lib/useAnchor'
import { isMemoryTool, memoryToolSummary } from '../../lib/memory'
import { MEMORY_TOOL_ICONS, MemoryToolBody } from '../memory/MemoryToolCard'
import { isSkillTool, skillToolSummary } from '../../lib/skills'
import { SKILL_TOOL_ICONS, SkillToolBody } from '../skills/SkillToolCard'

// Partial + string: tools novas (ex.: memória, do contrato do backend) caem no Wrench/no mapa delas.
const ICONS: Partial<Record<ToolName, LucideIcon>> = {
  ...MEMORY_TOOL_ICONS,
  ...SKILL_TOOL_ICONS,
  list_dir: FolderTree,
  read_file: FileText,
  search_files: FileSearch,
  find_files: FolderSearch,
  present_file: Presentation,
  write_file: FilePlus,
  edit_file: FilePen,
  shell: Terminal,
  process_start: Play,
  process_logs: ScrollText,
  process_list: Activity,
  process_stop: CircleStop,
  web_search: Search,
  browse_url: Globe,
  list_models: Cpu,
  delegate_task: Bot,
  get_chat_info: Info,
  list_chats: MessagesSquare,
  send_to_chat: Send,
  read_history: History,
  check_subagents: ListChecks,
  wait_subagents: Hourglass,
  cancel_subagent: CircleStop,
  message_subagent: MessageSquareText,
  ask_user: MessageCircleQuestion,
  datetime: Clock,
  tool_search: BookOpenText
}

const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id)

export interface ToolCallView {
  id: string
  name: string
  arguments: string
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function summary(name: string, args: Record<string, unknown> | null): string {
  if (!args) return ''
  if (isMemoryTool(name)) return memoryToolSummary(name, args)
  if (isSkillTool(name)) return skillToolSummary(name, args)
  const pick = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (name) {
    case 'shell':
    case 'bash':
      return pick('command')
    case 'process_start':
      return [pick('name') && `[${pick('name')}]`, pick('command')].filter(Boolean).join(' ')
    case 'process_logs':
      return [
        pick('id'),
        pick('pattern') && `/${pick('pattern')}/${args.case_insensitive === true ? 'i' : ''}`,
        args.since_line != null && `desde a linha ${String(args.since_line)}`,
        args.offset != null && `a partir da linha ${String(args.offset)}`,
        args.tail != null && `últimas ${String(args.tail)}`
      ]
        .filter(Boolean)
        .join(' · ')
    case 'process_list':
      return ''
    case 'process_stop':
      return [pick('id'), pick('signal')].filter(Boolean).join(' · ')
    case 'web_search':
      return pick('query')
    case 'browse_url':
      return [
        pick('url'),
        pick('mode') === 'full' && 'página inteira',
        args.links === true && 'links'
      ]
        .filter(Boolean)
        .join(' · ')
    case 'delegate_task':
      return pick('title') || pick('task')
    case 'datetime':
      return pick('format')
    case 'tool_search':
    case 'search_tool': // nome até 1.11.0 (chamadas antigas no histórico)
      return Array.isArray(args.names)
        ? args.names.filter((n) => typeof n === 'string').join(', ')
        : pick('names')
    case 'search_files': {
      const where = [pick('glob'), pick('path')].filter(Boolean).join(' · ')
      return `/${pick('pattern')}/${where ? `  ${where}` : ''}`
    }
    case 'list_models':
      return [
        pick('provider') && `@${pick('provider')}`,
        pick('query') && `"${pick('query')}"`,
        args.tools_only === true && 'tools',
        args.free_only === true && 'grátis',
        pick('sort') && `por ${pick('sort')}`,
        args.limit != null && `limite ${String(args.limit)}`
      ]
        .filter(Boolean)
        .join(' · ')
    case 'find_files':
      return pick('glob') + (pick('path') ? `  ${pick('path')}` : '')
    case 'list_chats':
      return [
        pick('query') && `"${pick('query')}"`,
        args.limit != null && `limite ${String(args.limit)}`
      ]
        .filter(Boolean)
        .join(' · ')
    case 'send_to_chat':
      return [
        `→ ${shortId(pick('chat_id'))}`,
        args.wait_for_reply === true && 'aguarda resposta',
        pick('message')
      ]
        .filter(Boolean)
        .join(' · ')
    case 'read_history': {
      const range =
        args.from_seq != null || args.to_seq != null
          ? `#${args.from_seq != null ? String(args.from_seq) : '…'}–#${args.to_seq != null ? String(args.to_seq) : '…'}`
          : ''
      return [
        pick('scope') === 'all' && 'todos os outros chats',
        pick('chat_id') && `chat ${shortId(pick('chat_id'))}`,
        pick('query') && `"${pick('query')}"`,
        range,
        args.include_tool_results === true && 'com resultados de tools'
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'wait_subagents': {
      const ids = Array.isArray(args.ids) ? args.ids.length : 0
      return [
        ids ? `${ids} subagente${ids > 1 ? 's' : ''}` : 'todos os pendentes',
        pick('mode') === 'any' ? 'o primeiro' : '',
        args.timeout_s != null && `até ${String(args.timeout_s)}s`
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'cancel_subagent':
      return shortId(pick('id'))
    case 'ask_user': {
      const qs = Array.isArray(args.questions) ? args.questions : []
      const first = qs[0] as { title?: unknown } | undefined
      const t = typeof first?.title === 'string' ? first.title : ''
      return qs.length > 1 ? `${qs.length} perguntas · ${t}` : t
    }
    case 'message_subagent':
      return [
        `→ ${shortId(pick('id'))}`,
        args.wait_for_reply === true && 'aguarda resposta',
        pick('message')
      ]
        .filter(Boolean)
        .join(' · ')
    case 'read_file': {
      const o = Number(args.offset ?? 1) || 1
      const l = args.limit != null ? Number(args.limit) : null
      const range =
        args.offset == null && l == null
          ? ''
          : l
            ? `  · linhas ${o}–${o + l - 1}`
            : `  · a partir da linha ${o}`
      return pick('path') + range
    }
    case 'present_file':
      return Array.isArray(args.files)
        ? (args.files as unknown[])
            .map((f) => (typeof f === 'string' ? f : ((f as { path?: string })?.path ?? '')))
            .join(', ')
        : pick('path')
    default:
      return pick('path') || (name === 'list_dir' ? '.' : '')
  }
}

type Status =
  | 'streaming'
  | 'judging'
  | 'running'
  | 'approval'
  | 'input'
  | 'ok'
  | 'error'
  | 'denied'
  | 'cancelled'
  | 'pending'

function StatusChip({
  status,
  outcome,
  meta
}: {
  status: Status
  /** Chamada aprovada: o selo abre os detalhes da aprovação (ApprovalBadge). */
  outcome?: ApprovalOutcome | null
  meta?: MessageMeta
}): React.JSX.Element | null {
  const map: Record<Status, { label: string; cls: string; icon: ReactNode }> = {
    streaming: { label: 'gerando', cls: 'text-subtle', icon: <Spinner className="size-3" /> },
    judging: {
      label: 'Smart-Approve avaliando',
      cls: 'text-accent-strong',
      icon: <Spinner className="size-3 text-accent-strong" />
    },
    running: {
      label: 'executando',
      cls: 'text-accent-strong',
      icon: <Spinner className="size-3 text-accent-strong" />
    },
    approval: {
      label: 'aguardando aprovação',
      cls: 'text-warning',
      icon: <Hand className="size-3" />
    },
    input: {
      label: 'aguardando sua resposta',
      cls: 'text-warning',
      icon: <MessageCircleQuestion className="size-3" />
    },
    ok: { label: 'ok', cls: 'text-success/90', icon: <Check className="size-3" /> },
    error: { label: 'erro', cls: 'text-danger', icon: <CircleX className="size-3" /> },
    denied: { label: 'negada', cls: 'text-danger/90', icon: <Ban className="size-3" /> },
    cancelled: { label: 'interrompida', cls: 'text-subtle', icon: <Ban className="size-3" /> },
    pending: { label: 'pendente', cls: 'text-faint', icon: null }
  }
  const s = map[status]
  const chip = (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px]', s.cls)}>
      {s.icon}
      {s.label}
    </span>
  )
  if (outcome?.kind === 'approved' && meta)
    return (
      <ApprovalBadge outcome={outcome} meta={meta}>
        {chip}
      </ApprovalBadge>
    )
  return chip
}

function Section({
  label,
  info,
  text,
  live
}: {
  label: string
  info?: ReactNode
  text: string
  live?: boolean
}): React.JSX.Element {
  return (
    <div className="px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-[11px] font-medium text-subtle">{label}</span>
        {info}
        {live && <span className="size-1.5 animate-pulse-soft rounded-full bg-accent-strong" />}
        <CopyButton text={text} className="-my-1 ml-auto" />
      </div>
      <pre className="max-h-80 overflow-auto rounded-lg bg-bg/70 px-3 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg/85">
        {text || <span className="text-faint italic">(vazio)</span>}
      </pre>
    </div>
  )
}

export function ToolCard({
  call,
  result,
  run,
  approval,
  subApproval,
  subApprovals,
  streaming,
  subSession,
  chatId,
  anchor
}: {
  call: ToolCallView
  result?: StoredMessage
  run?: ToolRun
  approval?: ApprovalRequest
  /** Aprovação pendente na subsessão criada por este delegate_task. */
  subApproval?: ApprovalRequest
  /** Todas as aprovações pendentes na subárvore deste delegate_task (subagente e netos), mais antiga primeiro. */
  subApprovals?: ApprovalRequest[]
  streaming?: boolean
  /** (legado; o status agora vem de `tool-running`) */
  sessionBusy?: boolean
  subSession?: Session
  chatId: string
  /** Id de âncora (lib/approvalAnchors): visível → as aprovações ficam aqui; fora da tela → na fila do composer. */
  anchor?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useAnchor<HTMLDivElement>(anchor ?? null)
  /** Card na tela (ou sem âncora): mostra os cards de aprovação; fora → só um aviso (estão na fila). */
  const onScreen = useStore((s) => !anchor || isAnchorShown(s.anchorVis, anchor))
  const hosted = subApprovals ?? (subApproval ? [subApproval] : [])
  const openChat = useStore((s) => s.openChat)
  const args = parseArgs(call.arguments)
  // nomes antigos (`search_tool` → `tool_search`, 1.12.0) com o rótulo/ícone do atual
  const name = (TOOL_ALIASES[call.name] === 'tool_search' ? 'tool_search' : call.name) as ToolName
  const question = useStore((s) =>
    name === 'ask_user' ? s.questions.find((q) => q.toolCallId === call.id) : undefined
  )
  const Icon = ICONS[name] ?? Wrench
  const isDelegate = name === 'delegate_task'
  const resultText =
    result && result.message.role === 'tool' ? toolContentText(result.message.content) : ''
  // read_file de imagem/PDF: parts por referência (miniatura no card)
  const resultMedia =
    result && result.message.role === 'tool' && Array.isArray(result.message.content)
      ? result.message.content.filter((p) => p._attachment)
      : []
  const background = isDelegate && (result?.meta.background === true || args?.background === true)
  const sessions = useStore((s) => s.sessions)
  const chats = useStore((s) => s.chats)
  // send_to_chat: chat de destino (id resolvido no resultado ou o argumento)
  const targetChatId =
    name === 'send_to_chat'
      ? (result?.meta.targetChatId ?? (typeof args?.chat_id === 'string' ? args.chat_id : ''))
      : ''
  const targetChat = targetChatId ? chats.find((c) => c.id === targetChatId) : undefined
  // message_subagent / cancel_subagent: subsessão alvo
  const targetSub =
    name === 'message_subagent' || name === 'cancel_subagent'
      ? (result?.meta.subSessionId && sessions[result.meta.subSessionId]) ||
        (typeof args?.id === 'string' ? sessions[args.id] : undefined)
      : undefined

  // Tools rodam em sequência: sem `tool-running` ainda, a chamada está só na fila ('pendente').
  const status: Status = streaming
    ? 'streaming'
    : approval || hosted.length
      ? 'approval'
      : question && !result
        ? 'input'
        : run?.judging
          ? 'judging'
          : run?.running
            ? 'running'
            : result
              ? (result.meta.toolStatus ?? 'ok')
              : 'pending'

  const expanded = open || !!approval
  const subId = result?.meta.subSessionId ?? subSession?.id
  const label = TOOL_LABELS[name] ?? toolLabel(call.name)
  let sum = summary(call.name, args)
  if (targetChat)
    sum = [
      `→ ${targetChat.title || 'Novo chat'}`,
      args?.wait_for_reply === true && 'aguarda resposta'
    ]
      .filter(Boolean)
      .join(' · ')
  if (targetSub)
    sum = [
      `→ ${targetSub.title || 'Subagente'}`,
      name === 'message_subagent' && args?.wait_for_reply === true && 'aguarda resposta'
    ]
      .filter(Boolean)
      .join(' · ')
  const liveSub = subId ? sessions[subId] : undefined
  /** Falha de conexão aguardando decisão na subsessão deste delegate_task. */
  const subRetry = useStore((s) =>
    isDelegate && subId ? s.retries.find((r) => r.sessionId === subId) : undefined
  )
  const root = useStore((s) => s.chats.find((c) => c.id === chatId)?.config.cwd)
  const chatProviderId = useStore((s) => s.chats.find((c) => c.id === chatId)?.config.providerId)
  const shellCwd = result?.meta.shellCwd
  const shellRel =
    shellCwd && root
      ? shellCwd === root
        ? '.'
        : shellCwd.startsWith(root + '/')
          ? './' + shellCwd.slice(root.length + 1)
          : shellCwd
      : null

  // aprovada → detalhes no selo de status; negada/bloqueada → faixa compacta abaixo do cabeçalho
  const outcome = result ? approvalOutcome(result.meta) : null
  const subFailed = isDelegate && liveSub?.status === 'error'
  const subError = useStore((s) => (subFailed && subId ? s.errors[subId] : undefined))
  return (
    <div
      ref={anchorRef}
      data-anchor={anchor}
      data-testid={isDelegate ? 'delegate-card' : undefined}
      className={cn(
        'my-2 overflow-hidden rounded-xl border bg-surface/70 transition-colors',
        approval || hosted.length
          ? 'border-warning/35 shadow-[0_0_0_3px_rgb(245_181_68/0.06)]'
          : subFailed
            ? 'border-danger/30'
            : 'border-border'
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}
        className="group flex h-9 items-center gap-2.5 px-3 hover:bg-white/[0.015]"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-faint transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        <Icon
          className={cn('size-3.5 shrink-0', isDelegate ? 'text-accent-strong' : 'text-muted')}
        />
        <span className="shrink-0 text-[12.5px] font-medium text-fg/90">{label}</span>
        {sum && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-subtle">{sum}</span>
        )}
        {!sum && <span className="flex-1" />}
        {shellRel && (
          <Tip
            label={`Diretório do shell após o comando: ${shellCwd} — a próxima chamada começa aqui`}
          >
            <span
              data-testid="shell-cwd"
              className="flex max-w-[160px] shrink-0 items-center gap-1 truncate font-mono text-[10.5px] text-faint"
            >
              <FolderOpen className="size-3 shrink-0" />
              <span className="truncate">{shellRel}</span>
            </span>
          </Tip>
        )}
        {result && (
          <Tip
            label={`Enviado ao modelo: ${resultText.length.toLocaleString('pt-BR')} caracteres ≈ ${approxTokens(resultText.length).toLocaleString('pt-BR')} tokens (caracteres ÷ 4)${resultMedia.length ? ` + ${resultMedia.length} ${resultMedia.every((p) => p._attachment?.kind === 'image') ? 'imagem(ns)' : 'arquivo(s)'} (tokens de imagem/PDF contados pelo provider no uso da resposta)` : ''}`}
          >
            <span
              data-testid="tool-size"
              className="shrink-0 text-[10.5px] tabular-nums text-faint"
            >
              ~{formatTokens(approxTokens(resultText.length))} tok
              {resultMedia.length ? ' + mídia' : ''}
            </span>
          </Tip>
        )}
        <StatusChip status={status} outcome={outcome} meta={result?.meta} />
      </div>

      {result && outcome?.kind === 'denied' && (
        <DeniedStrip outcome={outcome} meta={result.meta} messageId={result.id} />
      )}

      {isDelegate && !streaming && (
        <div className="flex items-center gap-3 border-t border-border/70 px-3.5 py-2.5">
          {background && (
            <span
              data-testid="bg-badge"
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent-strong"
            >
              em segundo plano
              {liveSub && <StatusDot status={liveSub.status} />}
            </span>
          )}
          <p className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted">
            {typeof args?.task === 'string' ? args.task : ''}
          </p>
          {liveSub && (
            <ModelLabel
              providerId={liveSub.providerId ?? chatProviderId}
              model={liveSub.model}
              short
              className="max-w-[200px] shrink-0 text-[11px] text-faint"
              modelClassName="font-mono"
            />
          )}
          <TaskInfo task={typeof args?.task === 'string' ? args.task : null} side="left" />
          {subId && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void openChat(chatId, subId)}
              icon={<ArrowUpRight className="size-3.5" />}
            >
              Abrir subsessão
            </Button>
          )}
        </div>
      )}

      {name === 'send_to_chat' && !streaming && (
        <div className="border-t border-border/70 px-3.5 py-2.5">
          <div className="flex items-center gap-3">
            <p className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted">
              {typeof args?.message === 'string' ? args.message : ''}
            </p>
            {targetChat && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void openChat(targetChat.id)}
                icon={<ArrowUpRight className="size-3.5" />}
              >
                Abrir chat
              </Button>
            )}
          </div>
          {args?.wait_for_reply === true && result?.meta.toolStatus === 'ok' && (
            <p
              data-testid="inter-chat-reply"
              className="mt-2 line-clamp-4 rounded-lg bg-bg/60 px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg/85"
            >
              {resultText.replace(/^Resposta do chat [^\n]*:\n\n/, '')}
            </p>
          )}
        </div>
      )}

      {resultMedia.length > 0 && !streaming && (
        <div className="border-t border-border/70 px-3.5 py-2.5">
          <ToolResultMedia parts={resultMedia} />
        </div>
      )}

      {name === 'ask_user' && !streaming && (
        <AskUserCardBody args={args} result={result} pending={!!question && !result} />
      )}

      {isMemoryTool(call.name) && !streaming && (
        <MemoryToolBody name={call.name} args={args} result={result} resultText={resultText} />
      )}

      {isSkillTool(call.name) && !streaming && (
        <SkillToolBody name={call.name} args={args} result={result} resultText={resultText} />
      )}

      {name === 'process_start' && !streaming && (
        <ProcessStartInfo chatId={chatId} args={args} result={resultText} />
      )}

      {targetSub && !streaming && (
        <div className="flex items-center gap-3 border-t border-border/70 px-3.5 py-2.5">
          <StatusDot status={targetSub.status} />
          <p className="line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted">
            {name === 'message_subagent' && typeof args?.message === 'string'
              ? args.message
              : targetSub.title}
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void openChat(chatId, targetSub.id)}
            icon={<ArrowUpRight className="size-3.5" />}
          >
            Abrir subsessão
          </Button>
        </div>
      )}

      {expanded && (
        <div className="animate-fade-in divide-y divide-border/70 border-t border-border/70">
          <Section
            label="Argumentos"
            text={prettyJson(call.arguments)}
            info={
              <ApiInfo title="Argumentos da chamada">
                <p>
                  Gerados pelo modelo e mantidos no histórico dentro de{' '}
                  <C>tool_calls[].function.arguments</C> (string JSON) da mensagem{' '}
                  <C>{'role: "assistant"'}</C>, id <C>{call.id}</C>.
                </p>
              </ApiInfo>
            }
          />
          {run?.running && run.output != null && !result && (
            <Section label="Saída (ao vivo)" text={run.output} live />
          )}
          {result && (
            <Section
              label={`Resultado · ${resultText.length.toLocaleString('pt-BR')} caracteres ≈ ${approxTokens(resultText.length).toLocaleString('pt-BR')} tokens`}
              text={resultText}
              info={<MessageInfo msg={result} side="left" />}
            />
          )}
        </div>
      )}
      {subRetry && subId && (
        <div
          data-testid="sub-retry"
          className="flex items-center gap-2 border-t border-warning/20 bg-warning/[0.045] px-3.5 py-2.5 text-[12.5px] text-fg"
        >
          <WifiOff className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            Subagente aguardando sua decisão (falha de conexão)
            <span className="block truncate text-[11.5px] text-muted">{subRetry.error}</span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void openChat(chatId, subId)}
            icon={<ArrowUpRight className="size-3.5" />}
          >
            Abrir subsessão
          </Button>
        </div>
      )}
      {subFailed && (
        <div
          data-testid="sub-failed"
          className="flex items-center gap-2 border-t border-danger/20 bg-danger/[0.05] px-3.5 py-2 text-[12.5px] text-fg"
        >
          <CircleX className="size-3.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 truncate">
            Subagente falhou
            {subError && <span className="text-muted">: {shortFailure(subError)}</span>}
          </span>
        </div>
      )}
      {onScreen && approval && <ApprovalPrompt request={approval} />}
      {onScreen &&
        !approval &&
        hosted.map((a) => <ApprovalWithDetail key={a.id} request={a} fromSubagent />)}
      {!onScreen && (approval || hosted.length > 0) && (
        <div className="flex items-center gap-2 border-t border-warning/20 bg-warning/[0.045] px-3.5 py-2 text-[12px] text-warning/90">
          <Hand className="size-3.5 shrink-0" />
          Aguardando aprovação — na fila acima do campo de mensagem
        </div>
      )}
    </div>
  )
}

/** Card de aprovação com o resumo dos argumentos (pedidos de subagentes / fila do composer). */
export function ApprovalWithDetail({
  request,
  fromSubagent
}: {
  request: ApprovalRequest
  fromSubagent?: boolean
}): React.JSX.Element {
  return (
    <ApprovalPrompt
      request={request}
      fromSubagent={fromSubagent}
      detail={
        request.check
          ? undefined
          : summary(request.toolName, request.args as Record<string, unknown>)
      }
    />
  )
}

/** ask_user: pendente → "Aguardando sua resposta…"; respondido → pergunta → resposta(s); cancelado → "Não respondido". */
function AskUserCardBody({
  args,
  result,
  pending
}: {
  args: Record<string, unknown> | null
  result?: StoredMessage
  pending: boolean
}): React.JSX.Element | null {
  const rec = result?.meta.askUser
  const rawQs = (Array.isArray(args?.questions) ? args.questions : []) as { title?: unknown }[]
  const titles = rec
    ? rec.questions
    : rawQs.map((q, i) => ({ title: typeof q?.title === 'string' ? q.title : `Pergunta ${i + 1}` }))
  if (pending)
    return (
      <div data-testid="ask-card-pending" className="border-t border-border/70 px-3.5 py-2.5">
        <p className="mb-1.5 text-[12px] text-warning/90">
          Aguardando sua resposta… o questionário está no lugar do campo de mensagem.
        </p>
        <AskUserQuestionsList questions={titles} />
      </div>
    )
  if (!result) return null
  if (rec?.outcome === 'answered' && rec.answers)
    return (
      <div data-testid="ask-card-answered" className="border-t border-border/70 px-3.5 py-2.5">
        <AskUserAnswers questions={rec.questions} answers={rec.answers} />
        {rec.notes?.length ? (
          <p className="mt-2 text-[11px] text-faint">{rec.notes.join(' ')}</p>
        ) : null}
      </div>
    )
  if (result.meta.toolStatus === 'cancelled')
    return (
      <div data-testid="ask-card-cancelled" className="border-t border-border/70 px-3.5 py-2.5">
        <p className="mb-1.5 text-[12px] text-subtle">
          Não respondido
          {rec?.outcome === 'app-closed' || /app foi fechado/.test(resultText(result))
            ? ' — o app foi fechado com o questionário aberto.'
            : '.'}
        </p>
        {titles.length > 0 && <AskUserQuestionsList questions={titles} />}
      </div>
    )
  return null
}

const resultText = (m: StoredMessage): string =>
  m.message.role === 'tool' ? toolContentText(m.message.content) : ''

/** process_start: comando, cwd, id e estado ao vivo do processo (do store). */
function ProcessStartInfo({
  chatId,
  args,
  result
}: {
  chatId: string
  args: Record<string, unknown> | null
  result: string
}): React.JSX.Element {
  const id = /\[processo (p\d+)/.exec(result)?.[1] ?? /processo (p\d+)/.exec(result)?.[1]
  const proc = useStore((s) => (id ? s.processes[chatId]?.find((p) => p.id === id) : undefined))
  const stopProcess = useStore((s) => s.stopProcess)
  const command = typeof args?.command === 'string' ? args.command : ''
  const waitFor = typeof args?.wait_for === 'string' ? args.wait_for : ''
  return (
    <div className="border-t border-border/70 px-3.5 py-2.5">
      <pre className="max-h-24 overflow-auto rounded-lg bg-bg/70 px-3 py-1.5 font-mono text-[11.5px] whitespace-pre-wrap text-fg/85">
        $ {command}
      </pre>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-subtle">
        {id && <span className="font-mono text-faint">{id}</span>}
        {waitFor && (
          <span>
            aguarda <span className="font-mono text-muted">/{waitFor}/</span>
          </span>
        )}
        {proc && (
          <span
            data-testid="process-state"
            className={cn(
              'flex items-center gap-1',
              proc.status === 'running' ? 'text-success/90' : 'text-faint'
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                proc.status === 'running' ? 'animate-pulse-soft bg-success' : 'bg-faint'
              )}
            />
            {proc.status === 'running'
              ? 'rodando'
              : proc.exitCode !== null
                ? `saiu (código ${proc.exitCode})`
                : `encerrado${proc.signal ? ` (${proc.signal})` : ''}`}
          </span>
        )}
        {proc?.status === 'running' && (
          <button
            type="button"
            onClick={() => void stopProcess(chatId, proc.id)}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-danger/85 hover:bg-danger/10 hover:text-danger"
          >
            <CircleStop className="size-3" /> Parar
          </button>
        )}
      </div>
    </div>
  )
}

export function OrphanApproval({
  request,
  anchor
}: {
  request: ApprovalRequest
  anchor: string
}): React.JSX.Element {
  const ref = useAnchor<HTMLDivElement>(anchor)
  const onScreen = useStore((s) => isAnchorShown(s.anchorVis, anchor))
  return (
    <div
      ref={ref}
      data-anchor={anchor}
      className="my-2 overflow-hidden rounded-xl border border-warning/35 bg-surface/70"
    >
      <div className="px-3.5 pt-3 font-mono text-[11.5px] whitespace-pre-wrap text-muted">
        {JSON.stringify(request.args, null, 2)}
      </div>
      {onScreen ? (
        <ApprovalPrompt request={request} />
      ) : (
        <div className="mt-2 flex items-center gap-2 border-t border-warning/20 bg-warning/[0.045] px-3.5 py-2 text-[12px] text-warning/90">
          <Hand className="size-3.5 shrink-0" />
          Aguardando aprovação — na fila acima do campo de mensagem
        </div>
      )}
    </div>
  )
}
