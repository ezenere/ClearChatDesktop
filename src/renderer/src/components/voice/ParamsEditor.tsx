// Disclosure "Parâmetros" dos modelos de voz — o MESMO componente para os motores da GPU local
// (`gpu/GpuParamsEditor`) e para os modelos remotos (ElevenLabs/OpenRouter/OpenAI-compatível —
// `ApiParamsEditor`): um controle por parâmetro (faixa + valor + padrão + "?" do efeito; seleção com
// nota por opção; texto livre), "Restaurar padrão" e a nota de quando vale. O rascunho segue o
// valor salvo e os arrastos de faixa gravam com atraso curto (um commit por gesto).
import { ChevronDown, ChevronRight, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../lib/format'
import { Button, IconButton, Switch } from '../ui/controls'
import { Select } from '../ui/Select'
import { HelpTip } from '../ui/Tooltip'

export type ParamValue = number | boolean | string
export type ParamValues = Record<string, ParamValue>

/** O que o editor precisa de uma spec (GPU e remota têm este formato). */
export interface ParamSpecLike {
  key: string
  label: string
  help: string
  kind: 'number' | 'boolean' | 'select' | 'text'
  /** null = "não enviar" (vale o padrão do provedor/voz). */
  default: ParamValue | null
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string; note?: string }[]
  applies?: 'next' | 'restart'
  maxLength?: number
  placeholder?: string
}

export interface ParamRowLike {
  spec: ParamSpecLike
  /** Valor mostrado no controle (o neutro quando não definido). */
  value: ParamValue
  /** Diferente do padrão (habilita "Restaurar padrão"). */
  changed: boolean
  display: string
  defaultDisplay: string
  /** Padrão `null` e nada escolhido ("da voz (conta)"). */
  unset?: boolean
  /** Texto miúdo no lugar do "padrão X" (ex.: "API: 0,50" enquanto não definido). */
  hint?: string
}

const sameValues = (a: ParamValues, b: ParamValues): boolean =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

export function ParamsEditor({
  ownerLabel,
  value,
  rows: rowsFor,
  set: setValue,
  onChange,
  onRestore,
  testId,
  extra,
  extraChanged = false,
  defaultOpen = false,
  note,
  rowReset = false
}: {
  /** Nome do motor/modelo (aria-label e tooltips). */
  ownerLabel: string
  /** Valores salvos (só os escolhidos). */
  value: ParamValues
  /** Linhas a partir do rascunho. */
  rows: (draft: ParamValues) => ParamRowLike[]
  /** Rascunho com `key` = `v` (null = volta ao padrão). */
  set: (draft: ParamValues, key: string, v: ParamValue | null) => ParamValues
  onChange: (next: ParamValues) => void
  /** "Restaurar padrão" num commit só (ausente → grava vazio). */
  onRestore?: () => void
  testId: string
  /** Controles extras no topo (ex.: passos do OmniVoice). */
  extra?: ReactNode
  extraChanged?: boolean
  defaultOpen?: boolean
  /** Nota curta ao lado do "Restaurar padrão" — só o que não é óbvio (o "vale na próxima fala" é). */
  note?: ReactNode
  /** Botão ↺ por linha alterada. */
  rowReset?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  const [draft, setDraft] = useState<ParamValues>(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<ParamValues | null>(null)
  // as settings mudam entre o arrasto e o commit: sempre o onChange/valor mais recentes
  const latest = useRef({ onChange, value })
  useEffect(() => {
    latest.current = { onChange, value }
  })

  // valor externo mudou (outro painel, restaurar): segue, a não ser que haja um commit pendente
  useEffect(() => {
    if (!pending.current) setDraft(value)
  }, [value])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (pending.current) latest.current.onChange(pending.current)
    },
    []
  )

  const rows = rowsFor(draft)
  if (!rows.length && !extra) return null
  const changed = rows.some((r) => r.changed) || extraChanged
  const nChanged = rows.filter((r) => r.changed).length + (extraChanged ? 1 : 0)

  const commit = (next: ParamValues, now = false): void => {
    setDraft(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    const flush = (): void => {
      timer.current = null
      const p = pending.current
      pending.current = null
      if (p && !sameValues(p, latest.current.value)) latest.current.onChange(p)
    }
    if (now) flush()
    else timer.current = setTimeout(flush, 350)
  }
  const set = (key: string, v: ParamValue | null, now = false): void =>
    commit(setValue(draft, key, v), now)
  const restore = (): void => {
    if (!onRestore) return commit({}, true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    pending.current = null
    setDraft({})
    onRestore()
  }
  const restartRows = rows.filter((r) => r.spec.applies === 'restart')

  return (
    <div className="mt-2" data-testid={testId} data-open={open} data-changed={changed}>
      <button
        type="button"
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md text-[11.5px] font-medium text-muted hover:text-fg"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <SlidersHorizontal className="size-3" />
        Parâmetros
        {nChanged > 0 && (
          <span className="font-normal text-accent-strong" data-testid={`${testId}-count`}>
            · {nChanged} {nChanged === 1 ? 'alterado' : 'alterados'}
          </span>
        )}
      </button>
      {open && (
        <div
          className="mt-2 space-y-2.5 rounded-lg border border-border/70 bg-bg/40 px-3 py-2.5"
          role="group"
          aria-label={`Parâmetros de ${ownerLabel}`}
        >
          {extra}
          {rows.map((r) => (
            <div
              key={r.spec.key}
              data-testid={`${testId}-row-${r.spec.key}`}
              data-unset={r.unset || undefined}
            >
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="text-[11.5px] font-medium text-muted">{r.spec.label}</span>
                <HelpTip label={`${r.spec.label} (${ownerLabel})`}>{r.spec.help}</HelpTip>
                {(r.spec.kind === 'number' || (r.spec.kind === 'boolean' && r.unset)) && (
                  <span
                    className={cn(
                      'ml-auto text-[11.5px] tabular-nums',
                      r.changed ? 'text-accent-strong' : r.unset ? 'text-subtle' : 'text-fg/80'
                    )}
                    data-testid={`${testId}-${r.spec.key}-value`}
                  >
                    {r.display}
                  </span>
                )}
                <span
                  className={cn(
                    'text-[10.5px] text-faint',
                    r.spec.kind !== 'number' && !(r.spec.kind === 'boolean' && r.unset) && 'ml-auto'
                  )}
                >
                  {r.hint
                    ? r.hint
                    : r.spec.kind === 'number' || r.spec.default === null
                      ? `padrão ${r.defaultDisplay}`
                      : ''}
                  {r.spec.applies === 'restart' ? ' · aplica ao reiniciar o servidor' : ''}
                </span>
                {rowReset && r.changed && (
                  <IconButton
                    size="xs"
                    label={`Restaurar o padrão de ${r.spec.label}`}
                    data-testid={`${testId}-${r.spec.key}-reset`}
                    onClick={() => set(r.spec.key, null, true)}
                  >
                    <RotateCcw />
                  </IconButton>
                )}
              </div>
              {r.spec.kind === 'number' && (
                <input
                  type="range"
                  min={r.spec.min}
                  max={r.spec.max}
                  step={r.spec.step}
                  value={Number(r.value)}
                  aria-label={`${r.spec.label} (${ownerLabel})`}
                  aria-valuetext={r.display}
                  data-testid={`${testId}-${r.spec.key}`}
                  onChange={(e) => set(r.spec.key, Number(e.target.value))}
                  onPointerUp={() => pending.current && commit(pending.current, true)}
                  onKeyUp={() => pending.current && commit(pending.current, true)}
                  className={cn('mt-1 w-full accent-accent-strong', r.unset && 'opacity-60')}
                />
              )}
              {r.spec.kind === 'boolean' && (
                <div className="mt-1" data-testid={`${testId}-${r.spec.key}`}>
                  <Switch
                    size="sm"
                    checked={r.value === true}
                    indeterminate={r.unset}
                    label={`${r.spec.label} (${ownerLabel})`}
                    onChange={(v) => set(r.spec.key, v, true)}
                  />
                </div>
              )}
              {r.spec.kind === 'select' && (
                <div className="mt-1" data-testid={`${testId}-${r.spec.key}`}>
                  <Select
                    value={String(r.value)}
                    label={`${r.spec.label} (${ownerLabel})`}
                    className="h-7 w-full max-w-[260px]"
                    menuMinWidth={300}
                    options={(r.spec.options ?? []).map((o) => ({
                      value: o.value,
                      label: o.value === r.spec.default ? `${o.label} (padrão)` : o.label,
                      ...(o.note ? { description: o.note } : {})
                    }))}
                    onChange={(v) => set(r.spec.key, v, true)}
                  />
                  {(() => {
                    const n = r.spec.options?.find((o) => o.value === String(r.value))?.note
                    return n && r.changed ? (
                      <p
                        className="mt-0.5 text-[10.5px] text-subtle"
                        data-testid={`${testId}-${r.spec.key}-note`}
                      >
                        {n}
                      </p>
                    ) : null
                  })()}
                </div>
              )}
              {r.spec.kind === 'text' && (
                <TextParam
                  value={typeof r.value === 'string' ? r.value : ''}
                  label={`${r.spec.label} (${ownerLabel})`}
                  placeholder={r.spec.placeholder}
                  maxLength={r.spec.maxLength}
                  testId={`${testId}-${r.spec.key}`}
                  onCommit={(v) => set(r.spec.key, v.trim() ? v : null, true)}
                />
              )}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-3" />}
              disabled={!changed}
              data-testid={`${testId}-restore`}
              onClick={restore}
            >
              Restaurar padrão
            </Button>
            {(restartRows.length > 0 || note) && (
              <span className="text-[10.5px] text-subtle">
                {restartRows.length ? 'Os marcados aplicam ao reiniciar o servidor. ' : ''}
                {note}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Campo de texto livre (commit no blur/Enter; vazio = não enviar). */
function TextParam({
  value,
  label,
  placeholder,
  maxLength,
  testId,
  onCommit
}: {
  value: string
  label: string
  placeholder?: string
  maxLength?: number
  testId: string
  onCommit: (v: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const v = draft
    setDraft(null)
    if (v.trim() !== value) onCommit(v)
  }
  return (
    <textarea
      rows={2}
      value={draft ?? value}
      aria-label={label}
      placeholder={placeholder}
      maxLength={maxLength}
      spellCheck={false}
      data-testid={testId}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          commit()
        }
      }}
      className="field mt-1 min-h-[52px] resize-y py-1.5 text-[12px] leading-snug"
    />
  )
}
