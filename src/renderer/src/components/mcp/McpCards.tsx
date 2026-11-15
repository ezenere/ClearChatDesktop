// Conectores (MCP) no chat: o corpo do card de uma tool `mcp__…` (formulário pendente, erro do
// servidor) e o card de aprovação de uma tool de conector (conector · tool, o que o SERVIDOR declara
// — descrição e dicas, não confiáveis — e os argumentos formatados).
import { CircleX, Hand, MessageCircleQuestion, Plug } from 'lucide-react'
import { mcpApprovalMode } from '@shared/mcp'
import type { ApprovalRequest, StoredMessage } from '@shared/types'
import { MCP_MODE_LABEL } from '../../lib/mcp'
import { useStore } from '../../store'
import { SmartMissingNote } from '../approvals/ApprovalControls'
import { SmartApproveLine } from '../chat/SmartApprove'
import { Chip } from '../ui/Chip'
import { Button } from '../ui/controls'
import { McpHintChips } from './McpControls'
import { useMcpToolRef } from './hooks'

/** Partes extras do card de uma tool de conector (abaixo do cabeçalho). */
export function McpToolBody({
  result,
  resultText,
  pending
}: {
  result?: StoredMessage
  resultText: string
  /** Formulário do conector aguardando você (no lugar do campo de mensagem). */
  pending: boolean
}): React.JSX.Element | null {
  if (pending)
    return (
      <div
        data-testid="mcp-card-pending"
        className="flex items-center gap-2 border-t border-border/70 px-3.5 py-2 text-[12px] text-warning/90"
      >
        <MessageCircleQuestion className="size-3.5 shrink-0" />O conector pediu dados — o formulário
        está no lugar do campo de mensagem.
      </div>
    )
  if (result?.meta.toolStatus === 'error')
    return (
      <div
        data-testid="mcp-card-error"
        className="flex items-start gap-2 border-t border-danger/20 bg-danger/[0.04] px-3.5 py-2 text-[12px]"
      >
        <CircleX className="mt-px size-3.5 shrink-0 text-danger" />
        <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap text-fg/85">
          {resultText.replace(/^Erro:\s*/, '') || 'O servidor devolveu um erro.'}
        </span>
      </div>
    )
  return null
}

const pretty = (v: unknown): string => {
  try {
    return JSON.stringify(v ?? {}, null, 2)
  } catch {
    return String(v)
  }
}

/** Card de aprovação de uma tool de conector (pergunta simples: Permitir / Negar). */
export function McpApprovalPrompt({
  request,
  fromSubagent
}: {
  request: ApprovalRequest
  fromSubagent?: boolean
}): React.JSX.Element {
  const approve = useStore((s) => s.approve)
  const focusConfig = useStore((s) => s.focusConfig)
  const ref = useMcpToolRef(request.toolName)
  const who = fromSubagent ? 'o subagente' : 'o agente'
  const mode = ref?.server && ref.tool ? mcpApprovalMode(ref.server, ref.tool.name) : null
  return (
    <div
      data-testid="approval-card"
      data-item="mcp"
      className="border-t border-warning/20 bg-warning/[0.045] px-3.5 py-3"
    >
      <div className="flex items-center gap-2 text-[13px] text-fg">
        <Hand className="size-3.5 shrink-0 text-warning" />
        <span data-testid="mcp-approval-title" className="min-w-0">
          Permitir que {who} use{' '}
          <b className="font-medium">
            Conector {ref?.serverLabel ?? '?'} · {ref?.toolTitle ?? request.toolName}
          </b>
          ?
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-faint">
          <Plug className="size-3" />
          Conector{mode ? ` · ${MCP_MODE_LABEL[mode]}` : ''}
        </span>
      </div>
      {(ref?.tool?.description || (ref?.tool && ref.tool.annotations)) && (
        <div data-testid="mcp-approval-declared" className="mt-2 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tip="Texto e dicas vêm do servidor — não confiáveis; nunca liberam nada sozinhos.">
              declarado pelo servidor
            </Chip>
            {ref?.tool && <McpHintChips tool={ref.tool} />}
          </div>
          {ref?.tool?.description && (
            <p className="line-clamp-4 border-l-2 border-border-strong/70 pl-2 text-[12px] leading-snug whitespace-pre-wrap text-muted">
              {ref.tool.description}
            </p>
          )}
        </div>
      )}
      <pre
        data-testid="mcp-approval-args"
        className="mt-2 max-h-48 overflow-auto rounded-lg bg-bg/70 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg/85"
      >
        {pretty(request.args)}
      </pre>
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
