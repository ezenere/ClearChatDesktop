// Peças visuais compartilhadas pelas abas do painel e pelo editor de personas.
import { AlertCircle, AlertTriangle, ChevronRight, RotateCcw } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { readCollapse, subscribeCollapse, writeCollapse } from '../../lib/collapse'
import { validateJson, type SectionSummary } from '../../lib/configSummary'
import {
  SectionErrorContext,
  useSectionError,
  type ReportSectionError
} from '../../lib/sectionError'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Switch } from '../ui/controls'
import { HelpTip } from '../ui/Tooltip'
import { InheritMark } from './inherit'

export function Section({
  title,
  children,
  aside,
  help,
  id,
  inherit
}: {
  title: string
  children: ReactNode
  aside?: ReactNode
  /** Ajuda estática da seção → (?) ao lado do título. */
  help?: ReactNode
  id?: string
  /** Unidades da herança da persona (painel do chat): marca "neste chat" + voltar a herdar. */
  inherit?: readonly string[]
}): React.JSX.Element {
  return (
    <section
      data-section={id}
      className="scroll-mt-2 border-b border-border/70 px-4 py-4 last:border-b-0"
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
          {title}
        </h3>
        {help && <HelpTip label={title}>{help}</HelpTip>}
        {inherit && <InheritMark units={inherit} />}
        {aside && <div className="ml-auto flex items-center">{aside}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

// ---------------- seção recolhível ----------------

/** [aberta, definir] — aberta = preferência salva (localStorage) ?? `defaultOpen`. */
function useCollapse(id: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const saved = useSyncExternalStore(
    subscribeCollapse,
    () => readCollapse(id),
    () => null
  )
  const set = useCallback((open: boolean) => writeCollapse(id, open), [id])
  return [saved ?? defaultOpen, set]
}

export interface CollapsibleSectionProps {
  /** Id estável: o aberto/fechado fica em localStorage `clearchat.collapse.<id>`. */
  id: string
  title: string
  children: ReactNode
  /** Resumo à direita do título com a seção fechada (o que difere do padrão). */
  summary?: SectionSummary | string | null
  /** Ícones (i) / ações que ficam visíveis mesmo fechada. */
  aside?: ReactNode
  /** Ajuda estática da seção → (?) no cabeçalho (visível mesmo fechada), antes do `aside`. */
  help?: ReactNode
  /** `data-section` (destino de focusConfig): focar abre a seção. */
  section?: string
  /** Outros `data-section` dentro dela que também a abrem ao serem focados. */
  focusIds?: string[]
  /** Erro vindo dos dados (ex.: JSON salvo inválido): abre e marca o cabeçalho. */
  error?: string | null
  /** Aviso (não abre): ícone âmbar no cabeçalho com o texto no tooltip. */
  warning?: string | null
  /** Aberta quando o usuário nunca mexeu nela (padrão: fechada). */
  defaultOpen?: boolean
  /** `section` = seção do painel; `sub` = disclosure menor dentro de uma seção. */
  level?: 'section' | 'sub'
  /**
   * Unidades da herança da persona (painel do chat): marca "neste chat" + voltar a herdar no
   * cabeçalho. `inheritClosed`: só com a seção fechada (aberta, cada campo tem a sua marca).
   */
  inherit?: readonly string[]
  inheritClosed?: boolean
}

/**
 * Seção recolhível do painel direito e do editor de personas. Cabeçalho = botão com chevron
 * (`aria-expanded`, Enter/Espaço), resumo quando fechada, estado lembrado por id. O conteúdo só é
 * montado aberto; um erro (prop `error` ou `useSectionError` de um campo dentro) a mantém aberta.
 */
export function CollapsibleSection({
  id,
  title,
  children,
  summary,
  aside,
  help,
  section,
  focusIds,
  error,
  warning,
  defaultOpen = false,
  level = 'section',
  inherit,
  inheritClosed = false
}: CollapsibleSectionProps): React.JSX.Element {
  const [saved, setSaved] = useCollapse(id, defaultOpen)
  const focus = useStore((s) => s.configFocus)
  const focusMatch = !!focus && (focus === section || !!focusIds?.includes(focus))
  const [childErrors, setChildErrors] = useState<Record<string, string>>({})
  const report = useCallback<ReportSectionError>(
    (key, err) =>
      setChildErrors((cur) => {
        if ((cur[key] ?? null) === err) return cur
        const next = { ...cur }
        if (err) next[key] = err
        else delete next[key]
        return next
      }),
    []
  )
  const err = error || Object.values(childErrors)[0] || null
  const open = saved || focusMatch || !!err
  // propaga o erro para a seção de fora (sub dentro de seção)
  useSectionError(err)
  // focusConfig abriu a seção: fica aberta depois que o foco passa
  useEffect(() => {
    if (focusMatch && !saved) setSaved(true)
  }, [focusMatch, saved, setSaved])

  const uid = useId()
  const btnId = `${uid}-btn`
  const bodyId = `${uid}-body`
  const sum = typeof summary === 'string' ? { text: summary, changed: false } : summary
  const toggle = (): void => {
    if (err) return // corrigir o erro antes de recolher
    setSaved(!open)
  }
  const errorBadge = err && (
    <span
      data-testid="collapse-error"
      title={err}
      className="inline-flex shrink-0 items-center gap-1 rounded bg-danger/12 px-1.5 py-px text-[10.5px] font-medium tracking-normal text-danger normal-case"
    >
      <AlertCircle className="size-3" />
      {err.length > 28 ? 'inválido' : err}
    </span>
  )
  const warnIcon = !err && warning && (
    <span data-testid="collapse-warning" title={warning} className="inline-flex shrink-0">
      <AlertTriangle aria-hidden className="size-3 text-warning/90" />
      <span className="sr-only">{warning}</span>
    </span>
  )
  const summaryEl = !open && sum && (
    <span
      data-testid="collapse-summary"
      data-changed={sum.changed || undefined}
      title={sum.text}
      className={cn(
        'min-w-0 truncate text-[11px] font-normal tracking-normal normal-case',
        sum.changed ? 'text-accent-strong/90' : 'text-faint'
      )}
    >
      {sum.text}
    </span>
  )
  const body = open && (
    <SectionErrorContext.Provider value={report}>
      {/* sem role="region": muitas seções viram landmarks demais (APG) e o nome dela colidiria
          com o rótulo do campo de mesmo nome (ex.: "System prompt") */}
      <div
        id={bodyId}
        className={cn(
          'animate-fade-in',
          level === 'section' ? 'space-y-3 pb-4' : 'mt-1.5 space-y-2'
        )}
      >
        {children}
      </div>
    </SectionErrorContext.Provider>
  )
  const helpEl = help && <HelpTip label={title}>{help}</HelpTip>
  const inheritEl = inherit && (!inheritClosed || !open) && <InheritMark units={inherit} />
  const buttonProps = {
    type: 'button' as const,
    id: btnId,
    'aria-expanded': open,
    'aria-controls': open ? bodyId : undefined,
    'data-testid': `collapse-${id}`,
    title: err ? 'Corrija o erro para recolher' : undefined,
    onClick: toggle
  }

  if (level === 'sub')
    return (
      <div data-section={section} data-collapse-id={id} data-open={open || undefined}>
        <div className="flex min-h-6 items-center gap-1.5 text-[11px] text-subtle">
          <button
            {...buttonProps}
            className="group -ml-0.5 inline-flex min-w-0 shrink-0 items-center gap-1 rounded px-0.5 py-0.5 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-faint transition-transform duration-150 group-hover:text-muted',
                open && 'rotate-90'
              )}
            />
            {title}
          </button>
          {helpEl}
          {errorBadge}
          {warnIcon}
          {inheritEl}
          {summaryEl}
          {aside && <div className="ml-auto flex shrink-0 items-center gap-1.5">{aside}</div>}
        </div>
        {body}
      </div>
    )

  return (
    <section
      data-section={section}
      data-collapse-id={id}
      data-open={open || undefined}
      className="scroll-mt-2 border-b border-border/70 px-4 last:border-b-0"
    >
      <div className="flex items-center gap-2 py-2.5">
        <h3 className="min-w-0 flex-1">
          <button
            {...buttonProps}
            className="group -mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-faint transition-transform duration-150 group-hover:text-muted',
                open && 'rotate-90'
              )}
            />
            <span className="shrink-0 group-hover:text-fg">{title}</span>
            {errorBadge}
            {warnIcon}
            {summaryEl && <span className="ml-auto flex min-w-0 justify-end">{summaryEl}</span>}
          </button>
        </h3>
        {(helpEl || aside || inheritEl) && (
          <div className="flex shrink-0 items-center gap-1.5">
            {inheritEl}
            {helpEl}
            {aside}
          </div>
        )}
      </div>
      {body}
    </section>
  )
}

export function ToggleRow({
  label,
  checked,
  onChange,
  info,
  help,
  status,
  inherit
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  info?: ReactNode
  /** Ajuda estática (o que a opção faz) → (?) depois do rótulo. "\n" separa parágrafos. */
  help?: ReactNode
  /** Linha visível abaixo do rótulo — só estado/aviso (dinâmico), nunca descrição estática. */
  status?: ReactNode
  /** Unidade(s) da herança da persona (painel do chat): marca "neste chat" + voltar a herdar. */
  inherit?: readonly string[]
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        {/* inline: num rótulo de duas linhas o (?) e o </> ficam logo depois da última palavra */}
        <div className="text-[13px] text-fg/90">
          {label}
          {help && (
            <HelpTip label={label} className="ml-1.5 -translate-y-px">
              {help}
            </HelpTip>
          )}
          {info && <span className="ml-1.5 inline-flex -translate-y-px align-middle">{info}</span>}
          {inherit && (
            <span className="ml-1.5 inline-flex -translate-y-px align-middle empty:hidden">
              <InheritMark units={inherit} />
            </span>
          )}
        </div>
        {status && <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">{status}</p>}
      </div>
      <div className="pt-0.5">
        <Switch checked={checked} onChange={onChange} label={label} />
      </div>
    </div>
  )
}

export function NumberInput({
  value,
  disabled,
  step,
  min,
  max,
  int,
  wide,
  label,
  onCommit
}: {
  value: number | undefined
  disabled: boolean
  step: number
  min?: number
  max?: number
  int?: boolean
  wide?: boolean
  label?: string
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [text, setText] = useState(value == null ? '' : String(value))
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(value == null ? '' : String(value))
  }
  return (
    <input
      type="number"
      value={text}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value)
        const n = int ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
        if (!Number.isNaN(n)) onCommit(n)
      }}
      className={cn(
        'field h-7 px-2 py-0 text-right font-mono text-[12px] tabular-nums disabled:opacity-40 [&::-webkit-inner-spin-button]:opacity-40',
        wide ? 'w-[110px]' : 'w-[92px]'
      )}
    />
  )
}

export function ExtraBodyEditor({
  value,
  onChange
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
}): React.JSX.Element {
  const [text, setText] = useState(value ?? '')
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    if ((value ?? '') !== text && validateJson(text) === null) setText(value ?? '')
  }
  const error = validateJson(text)
  // rascunho inválido (não salvo): a seção recolhível fica aberta e marca o cabeçalho
  useSectionError(error ? 'JSON inválido' : null)
  return (
    <div>
      <textarea
        value={text}
        spellCheck={false}
        aria-label="Body extra (JSON)"
        placeholder={'{\n  "provider": { "order": ["anthropic"] }\n}'}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          if (validateJson(t) === null) onChange(t.trim() ? t : undefined)
        }}
        className={cn(
          'field min-h-[84px] resize-y font-mono text-[11.5px] leading-relaxed',
          error && 'border-danger/50 focus:border-danger/60'
        )}
      />
      <div className="mt-1 h-4 text-[11px]">
        {error ? (
          <span className="text-danger">{error} — não salvo</span>
        ) : text.trim() ? (
          <span className="text-success/80">JSON válido · mesclado no body</span>
        ) : (
          <span className="text-subtle">Vazio · nada é mesclado</span>
        )}
      </div>
    </div>
  )
}

/** Nota em destaque suave (ex.: subsessão somente leitura). */
export function Note({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="rounded-lg border border-accent/20 bg-accent-soft/40 px-3 py-2 text-[11.5px] leading-snug text-muted">
      {children}
    </p>
  )
}

/** "Restaurar padrão" dos textos editáveis (prompts). */
export function RestoreButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-[11px] text-subtle hover:text-fg"
    >
      <RotateCcw className="size-3" /> Restaurar padrão
    </button>
  )
}
