// Grupo de opções com herança (persona/chat): só as opções REAIS, com ★ na opção igual ao valor
// herdado (da persona ou do padrão global) — o mesmo desenho de `ChatApprovalSection`. Sem override
// (`value` null) a opção ★ aparece selecionada; escolher a opção ★ remove o override (null = segue
// herdando, muda junto se o herdado mudar); escolher outra fixa o valor neste nível. Nunca uma
// opção "herdar" separada duplicando o padrão.
import { Star } from 'lucide-react'
import { cn } from '../../lib/format'

export interface InheritOption<T> {
  value: T
  label: string
  /** Tooltip da opção (o ★ acrescenta de onde vem o padrão). */
  title?: string
}

/** `data-value` estável de uma opção (booleanos → on/off, como nos testes de UI). */
const valueAttr = (v: unknown): string =>
  v === true ? 'on' : v === false ? 'off' : String(v as string)

export function InheritChoice<T extends string | boolean>({
  label,
  options,
  value,
  inherited,
  inheritedFrom,
  testId,
  onChange,
  stretch = false
}: {
  /** Nome acessível do grupo. */
  label: string
  options: readonly InheritOption<T>[]
  /** Override deste nível; null = herda. */
  value: T | null
  /** Valor herdado (persona/global) — a opção dele ganha ★. */
  inherited: T
  /** De onde vem o herdado, para o tooltip do ★ ("padrão da persona" / "padrão global"). */
  inheritedFrom: string
  testId: string
  /** null = volta a herdar (escolheu a opção ★); senão o valor explícito. */
  onChange: (v: T | null) => void
  /** Opções dividem a largura (grupos com 3+ opções). */
  stretch?: boolean
}): React.JSX.Element {
  const shown = value ?? inherited
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      data-effective={valueAttr(shown)}
      data-inherit={value == null ? 'true' : undefined}
      className="flex rounded-lg border border-border bg-bg/60 p-0.5"
    >
      {options.map((o) => {
        const selected = shown === o.value
        const star = inherited === o.value
        const starTitle = `★ ${inheritedFrom} (escolher segue o padrão — muda junto se ele mudar)`
        return (
          <button
            key={valueAttr(o.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={valueAttr(o.value)}
            data-star={star || undefined}
            title={star ? (o.title ? `${o.title}\n${starTitle}` : starTitle) : o.title}
            onClick={() => onChange(star ? null : o.value)}
            className={cn(
              'flex items-center justify-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] transition-colors',
              stretch && 'min-w-0 flex-1 px-1.5 text-[11px]',
              selected ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
            )}
          >
            {o.label}
            {star && <Star aria-hidden className="size-2.5 shrink-0 fill-current opacity-70" />}
          </button>
        )
      })}
    </div>
  )
}
