import { LoaderCircle } from 'lucide-react'
import {
  forwardRef,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react'
import { cn } from '../../lib/format'
import { HelpTip, Tip } from './Tooltip'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.15),0_1px_2px_rgb(0_0_0/0.4)] hover:bg-[#9a70f8] active:bg-[#7c4fe6]',
  secondary:
    'border border-border bg-elevated text-fg hover:border-border-strong hover:bg-hover active:bg-active',
  ghost: 'text-muted hover:bg-hover hover:text-fg active:bg-active',
  danger: 'border border-danger/30 bg-danger/10 text-danger hover:bg-danger/15'
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant
    size?: 'sm' | 'md' | 'lg'
    loading?: boolean
    icon?: ReactNode
  }
>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cn(
        'no-drag inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[background-color,border-color,color,opacity] duration-100 select-none disabled:pointer-events-none disabled:opacity-45',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'lg' && 'h-10 px-4 text-sm',
        variants[variant],
        className
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string
    shortcut?: string
    active?: boolean
    size?: 'xs' | 'sm' | 'md'
    side?: 'top' | 'bottom' | 'left' | 'right'
  }
>(function IconButton(
  { label, shortcut, active, size = 'md', side, className, children, ...rest },
  ref
) {
  return (
    <Tip label={label} shortcut={shortcut} side={side}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          'no-drag inline-flex shrink-0 items-center justify-center rounded-md text-subtle transition-colors duration-100 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40',
          size === 'xs' && 'size-6 [&_svg]:size-3.5',
          size === 'sm' && 'size-7 [&_svg]:size-[15px]',
          size === 'md' && 'size-8 [&_svg]:size-4',
          active && 'bg-hover text-fg',
          className
        )}
        {...rest}
      >
        {children}
      </button>
    </Tip>
  )
})

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  size = 'md',
  indeterminate,
  testId
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
  size?: 'sm' | 'md'
  /** Estado parcial (ex.: "todos" com só alguns ligados). */
  indeterminate?: boolean
  /** data-testid do botão (role=switch — o Playwright usa check()/uncheck() nele). */
  testId?: string
}): React.JSX.Element {
  const md = size === 'md'
  const x = indeterminate
    ? md
      ? 'translate-x-[8.5px]'
      : 'translate-x-[7.5px]'
    : checked
      ? md
        ? 'translate-x-[15px]'
        : 'translate-x-[13px]'
      : 'translate-x-[2px] opacity-80'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(indeterminate ? true : !checked)}
      className={cn(
        'no-drag relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-40',
        md ? 'h-[18px] w-8' : 'h-4 w-7',
        indeterminate
          ? 'border-accent/60 bg-accent/40'
          : checked
            ? 'border-accent bg-accent'
            : 'border-border-strong bg-active hover:bg-[#2b2b35]'
      )}
    >
      <span
        className={cn(
          'block rounded-full bg-white shadow-sm transition-transform duration-150',
          md ? 'size-3' : 'size-2.5',
          x
        )}
      />
    </button>
  )
}

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return <LoaderCircle className={cn('size-3.5 animate-spin text-subtle', className)} />
}

/** Textarea que cresce com o conteúdo até `maxRows`. */
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number; maxRows?: number }
>(function AutoTextarea({ minRows = 1, maxRows = 12, className, value, ...rest }, outerRef) {
  const inner = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const cs = getComputedStyle(el)
    const line = parseFloat(cs.lineHeight) || 20
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    el.style.height = 'auto'
    const h = Math.min(Math.max(el.scrollHeight, line * minRows + pad), line * maxRows + pad)
    el.style.height = `${h + border}px`
    el.style.overflowY = el.scrollHeight > line * maxRows + pad ? 'auto' : 'hidden'
  }, [value, minRows, maxRows])
  return (
    <textarea
      ref={(el) => {
        inner.current = el
        if (typeof outerRef === 'function') outerRef(el)
        else if (outerRef) outerRef.current = el
      }}
      value={value}
      rows={minRows}
      className={cn('resize-none', className)}
      {...rest}
    />
  )
})

export function Label({
  children,
  info,
  help,
  hint,
  className
}: {
  children: ReactNode
  info?: ReactNode
  /** Ajuda estática do campo → (?) depois do rótulo (antes do `info`). */
  help?: ReactNode
  hint?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('mb-1.5 flex items-center gap-1.5', className)}>
      <span className="text-xs font-medium text-muted">{children}</span>
      {help && (
        <HelpTip label={typeof children === 'string' ? children : undefined}>{help}</HelpTip>
      )}
      {info}
      {hint && <span className="ml-auto text-[11px] text-subtle">{hint}</span>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border-strong bg-elevated px-1 font-sans text-[10px] font-medium text-muted">
      {children}
    </kbd>
  )
}
