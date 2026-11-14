// Selo pequeno com um fato curto da seleção atual (capacidade, transporte, idioma, contagem,
// disponibilidade) no lugar de uma linha de texto solta: o detalhe vai no tooltip. Regra completa
// no comentário do `HelpTip` (ui/Tooltip.tsx).
import type { ReactNode } from 'react'
import { cn } from '../../lib/format'
import { Tip } from './Tooltip'

export type ChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent'

const TONES: Record<ChipTone, string> = {
  neutral: 'border-border text-subtle',
  success: 'border-success/30 text-success',
  warning: 'border-warning/35 text-warning',
  danger: 'border-danger/35 text-danger',
  accent: 'border-accent/30 text-accent-strong'
}

export function Chip({
  children,
  tip,
  tone = 'neutral',
  icon,
  testId,
  className,
  data
}: {
  children: ReactNode
  /** Detalhe (tooltip; o chip vira focável para o teclado também alcançar). */
  tip?: ReactNode
  tone?: ChipTone
  icon?: ReactNode
  testId?: string
  className?: string
  /** Atributos `data-*` extras (ex.: `{ state: 'ok' }` → `data-state="ok"`). */
  data?: Record<string, string | number | boolean | undefined>
}): React.JSX.Element {
  const attrs = Object.fromEntries(
    Object.entries(data ?? {}).map(([k, v]) => [
      `data-${k}`,
      v === undefined ? undefined : String(v)
    ])
  )
  const el = (
    <span
      data-testid={testId}
      {...attrs}
      tabIndex={tip ? 0 : undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-4 font-normal tracking-normal whitespace-nowrap normal-case outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        TONES[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  )
  return tip ? (
    <Tip label={<span className="block max-w-[300px] leading-snug whitespace-normal">{tip}</span>}>
      {el}
    </Tip>
  ) : (
    el
  )
}
