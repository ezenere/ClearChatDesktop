// Peças da UI dos conectores (MCP): seletor de aprovação (3 vias, ★ no padrão do servidor), linhas
// chave/valor com valores mascarados (variáveis de ambiente e cabeçalhos), o ponto de estado e os
// chips das dicas declaradas pelo servidor.
import { Eye, EyeOff, Plus, Star, X } from 'lucide-react'
import { useState } from 'react'
import type { McpApprovalMode, McpServerView, McpToolInfo } from '@shared/mcp'
import { cn } from '../../lib/format'
import {
  MCP_MODE_HINT,
  MCP_MODE_LABEL,
  MCP_MODES,
  mcpHintChips,
  mcpStatusInfo,
  type McpKv,
  type McpTone
} from '../../lib/mcp'
import { Chip } from '../ui/Chip'
import { Tip } from '../ui/Tooltip'

/**
 * Perguntar / Smart-Approve / Sempre permitir. Com `defaultMode` (tool): a opção igual ao padrão do
 * servidor ganha ★ e `value` null = segue o padrão (a opção ★ aparece selecionada); escolher a ★
 * volta a seguir o padrão (quem usa remove a exceção).
 */
export function McpModeSelector({
  value,
  defaultMode,
  onChange,
  label,
  testId,
  size = 'md'
}: {
  value: McpApprovalMode | null
  defaultMode?: McpApprovalMode
  onChange: (m: McpApprovalMode) => void
  label: string
  testId?: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const shown = value ?? defaultMode ?? 'ask'
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      data-value={shown}
      data-inherit={defaultMode && value == null ? 'true' : undefined}
      className="flex rounded-lg border border-border bg-bg/60 p-0.5"
    >
      {MCP_MODES.map((m) => {
        const selected = shown === m
        const star = defaultMode === m
        return (
          <Tip
            key={m}
            label={
              <span className="block max-w-[260px] leading-snug">
                {MCP_MODE_HINT[m]}
                {star && (
                  <span className="mt-0.5 block text-subtle">
                    ★ Padrão do conector{value == null && selected ? ' (seguindo)' : ''}
                  </span>
                )}
              </span>
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={MCP_MODE_LABEL[m]}
              data-mode={m}
              data-default={star || undefined}
              onClick={() => onChange(m)}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 transition-colors',
                size === 'sm' ? 'py-0.5 text-[11px]' : 'py-1 text-[11.5px]',
                selected ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
              )}
            >
              <span className="truncate">
                {size === 'sm' ? MCP_MODE_SHORT[m] : MCP_MODE_LABEL[m]}
              </span>
              {star && <Star aria-hidden className="size-2.5 shrink-0 fill-current opacity-70" />}
            </button>
          </Tip>
        )
      })}
    </div>
  )
}

/** Rótulos curtos do seletor compacto (por tool); o nome acessível é o completo. */
const MCP_MODE_SHORT: Record<McpApprovalMode, string> = {
  ask: 'Perguntar',
  smart: 'Smart',
  always: 'Sempre'
}

const DOT: Record<McpTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  accent: 'bg-accent-strong animate-pulse-soft',
  neutral: 'bg-faint'
}
const TEXT: Record<McpTone, string> = {
  success: 'text-success/90',
  warning: 'text-warning/90',
  danger: 'text-danger/90',
  accent: 'text-accent-strong',
  neutral: 'text-subtle'
}

/** Ponto + rótulo do estado do conector (detalhe do erro no tooltip). */
export function McpStatusLine({
  view,
  className
}: {
  view: Pick<McpServerView, 'status'>
  className?: string
}): React.JSX.Element {
  const st = mcpStatusInfo(view)
  const el = (
    <span
      data-testid="mcp-status"
      data-state={st.key}
      tabIndex={st.detail ? 0 : undefined}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-[11.5px] outline-none',
        TEXT[st.tone],
        className
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', DOT[st.tone])} />
      <span className="truncate">{st.label}</span>
    </span>
  )
  return st.detail ? (
    <Tip label={<span className="block max-w-[340px] leading-snug">{st.detail}</span>}>{el}</Tip>
  ) : (
    el
  )
}

/** Chips das dicas da tool (somente leitura, destrutiva…) — declaradas pelo servidor. */
export function McpHintChips({
  tool
}: {
  tool: Pick<McpToolInfo, 'annotations'>
}): React.JSX.Element {
  return (
    <>
      {mcpHintChips(tool).map((c) => (
        <Chip key={c.label} tone={c.tone} tip={c.tip} testId="mcp-hint">
          {c.label}
        </Chip>
      ))}
    </>
  )
}

/** Valor mascarado (senha) com o olho para revelar. */
function SecretInput({
  value,
  onChange,
  label,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  label: string
  placeholder?: string
}): React.JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <div className="relative min-w-0 flex-1">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        className="field h-8 pr-8 font-mono text-[12px]"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? `Ocultar ${label}` : `Mostrar ${label}`}
        className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-faint hover:text-fg"
      >
        {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
    </div>
  )
}

/** Linhas chave = valor (valores mascarados) com adicionar/remover. */
export function KvRows({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  what,
  testId
}: {
  rows: McpKv[]
  onChange: (rows: McpKv[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
  /** "variável" / "cabeçalho" (nomes acessíveis). */
  what: string
  testId?: string
}): React.JSX.Element {
  const set = (i: number, r: Partial<McpKv>): void =>
    onChange(rows.map((x, j) => (j === i ? { ...x, ...r } : x)))
  return (
    <div data-testid={testId} className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={r.key}
            aria-label={`Nome da ${what} ${i + 1}`}
            placeholder={keyPlaceholder}
            spellCheck={false}
            onChange={(e) => set(i, { key: e.target.value })}
            className="field h-8 w-[38%] shrink-0 font-mono text-[12px]"
          />
          <SecretInput
            value={r.value}
            label={`Valor da ${what} ${r.key || i + 1}`}
            placeholder={valuePlaceholder}
            onChange={(value) => set(i, { value })}
          />
          <button
            type="button"
            aria-label={`Remover ${what} ${r.key || i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-hover hover:text-danger"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="inline-flex items-center gap-1 text-[11.5px] text-accent-strong hover:underline"
      >
        <Plus className="size-3" /> {addLabel}
      </button>
    </div>
  )
}
