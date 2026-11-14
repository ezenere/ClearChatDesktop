// Peças de layout da aba Áudio no padrão das outras abas de Configurações (Novos chats → "Título
// automático", Pesquisa na web, Skills): seção com cabeçalho `h3` 13px + (?) + `</>` separada por
// borda, cartão `rounded-xl border bg-elevated/40`, linha "rótulo à esquerda, número à direita"
// (o mesmo desenho do "Limite de tokens de saída") e a nota de aviso/erro.
import { TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { cn } from '../../lib/format'
import { HelpTip } from '../ui/Tooltip'

/** Cartão das listas/painéis da aba (mesmo das linhas de buscador em Pesquisa na web). */
export const CARD = 'rounded-xl border border-border bg-elevated/40'

/** Seção da aba: `h3` + (?) + extras (ex.: `</>`), separada da anterior por uma borda. */
export function AudioSection({
  title,
  help,
  aside,
  info,
  testId,
  first,
  children,
  className
}: {
  title: ReactNode
  help?: ReactNode
  /** Ações/estado à direita do título. */
  aside?: ReactNode
  /** Ícones depois do (?) — ex.: `ApiInfo`. */
  info?: ReactNode
  testId?: string
  /** Primeira seção (sem a borda de cima). */
  first?: boolean
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section
      data-testid={testId}
      className={cn('space-y-3', !first && 'settings-section settings-divided', className)}
    >
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-medium text-fg">{title}</h3>
        {help && <HelpTip label={typeof title === 'string' ? title : undefined}>{help}</HelpTip>}
        {info}
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

/** Subtítulo de um grupo dentro da seção (mesmo das Aprovações). */
export function SubHeading({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="border-b border-border/50 pb-1 text-[11.5px] text-subtle">{children}</div>
}

/** Linha "rótulo (?) ……… [número]" com commit no blur/Enter (padrão do "Limite de tokens"). */
export function NumberRow({
  label,
  help,
  value,
  min,
  max,
  step,
  testId,
  ariaLabel,
  disabled,
  unit,
  status,
  onCommit
}: {
  label: string
  help?: ReactNode
  value: number
  min: number
  max?: number
  step: number
  testId: string
  ariaLabel?: string
  disabled?: boolean
  /** Unidade depois do campo (ex.: "ms"). */
  unit?: string
  /** Linha de estado abaixo do rótulo (dinâmica). */
  status?: ReactNode
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(value)
  const commit = (): void => {
    const n = Number(text)
    let v = Number.isFinite(n) && text.trim() ? n : value
    v = Math.max(min, max != null ? Math.min(max, v) : v)
    setDraft(null)
    if (v !== value) onCommit(v)
  }
  return (
    <div className={cn('flex items-start gap-3', disabled && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg/90">
          {label}
          {help && (
            <HelpTip label={label} className="ml-1.5 -translate-y-px">
              {help}
            </HelpTip>
          )}
        </div>
        {status && <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">{status}</p>}
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={text}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          data-testid={testId}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="field h-7 w-[92px] px-2 py-0 text-right font-mono text-[12px] tabular-nums disabled:opacity-40 [&::-webkit-inner-spin-button]:opacity-40"
        />
        <span className="w-5 text-[11px] text-subtle">{unit}</span>
      </div>
    </div>
  )
}

/** Aviso visível (amarelo) com ícone — estado, nunca ajuda estática. */
export function WarnNote({
  children,
  testId,
  role = 'alert'
}: {
  children: ReactNode
  testId?: string
  role?: 'alert' | 'note' | 'status'
}): React.JSX.Element {
  return (
    <p
      role={role}
      data-testid={testId}
      className="flex items-start gap-1.5 text-[11.5px] leading-snug text-warning"
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}
