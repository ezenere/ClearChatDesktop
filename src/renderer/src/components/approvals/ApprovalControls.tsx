// Peças da UI de aprovações: seletor de modo (3 vias, com ★ no padrão global), aviso do
// Smart-Approve sem modelo e o campo editável "+ whitelist/blacklist" (com validação e aviso de
// padrão amplo).
import { AlertTriangle, Star } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  APPROVAL_MODES,
  broadPatternWarning,
  modeHint,
  modeLabel,
  validateListEntry
} from '@shared/approvalPolicy'
import type { ApprovalItem, ApprovalListItem, ApprovalMode } from '@shared/types'
import { cn } from '../../lib/format'
import { Button } from '../ui/controls'
import { Tip } from '../ui/Tooltip'

export const SMART_NEEDS_MODEL = 'Escolha um modelo de Smart-Approve abaixo'
export const STAR_HINT =
  'A estrela marca o padrão global; escolher a opção com estrela segue o padrão global.'

/**
 * Segmented de 3 vias. Com `globalMode` (chat/persona): a opção igual ao padrão global ganha ★ e
 * `value` null = segue o global (mostra a opção com ★ selecionada); quem usa grava com
 * `withChatMode` (escolher a opção ★ = sem override). Sem `globalMode` (Configurações →
 * Aprovações): sem estrela, valor sempre definido. `smartUnavailable`: sem modelo do juiz → a opção Smart-Approve fica desabilitada (se
 * já estiver selecionada, fica em âmbar: esses itens perguntam a você).
 */
export function ModeSelector({
  item,
  value,
  onChange,
  globalMode,
  starLabel = 'Padrão global',
  smartUnavailable,
  label,
  testId
}: {
  item: ApprovalItem
  /** null = segue o padrão global (só com `globalMode`). */
  value: ApprovalMode | null
  onChange: (v: ApprovalMode) => void
  /** Modo global do item (marca a opção com ★) — no chat que herda a persona, o modo herdado. */
  globalMode?: ApprovalMode
  /** De onde vem o ★ (tooltip; padrão "Padrão global"). */
  starLabel?: string
  smartUnavailable?: boolean
  label: string
  testId?: string
}): React.JSX.Element {
  const shown = value ?? globalMode ?? null
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      data-inherit={globalMode && value == null ? 'true' : undefined}
      className="flex rounded-lg border border-border bg-bg/60 p-0.5"
    >
      {APPROVAL_MODES.map((m) => {
        const selected = shown === m
        const star = globalMode === m
        const disabled = m === 'smart' && !!smartUnavailable
        const warn = disabled && selected
        const hint = disabled ? SMART_NEEDS_MODEL : modeHint(item, m)
        return (
          <Tip
            key={m}
            label={
              <span className="block max-w-[260px] leading-snug">
                {hint}
                {warn && (
                  <span className="block text-warning/90">
                    Sem modelo: este item pergunta a você.
                  </span>
                )}
                {star && (
                  <span className="mt-0.5 block text-subtle">
                    ★ {starLabel}
                    {globalMode && value == null && selected ? ' (seguindo)' : ''}
                  </span>
                )}
              </span>
            }
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={disabled || undefined}
              data-mode={m}
              data-global={star || undefined}
              onClick={() => {
                if (disabled) return
                onChange(m)
              }}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] transition-colors',
                warn
                  ? 'bg-warning/[0.10] text-warning/90 shadow-sm'
                  : selected
                    ? 'bg-active text-fg shadow-sm'
                    : disabled
                      ? 'cursor-not-allowed text-faint/70'
                      : 'text-subtle hover:text-fg'
              )}
            >
              {warn && <AlertTriangle aria-hidden className="size-3 shrink-0" />}
              <span className="truncate">{modeLabel(item, m)}</span>
              {star && (
                <Star
                  aria-hidden
                  data-testid="global-star"
                  className={cn(
                    'size-2.5 shrink-0 fill-current',
                    selected && !warn ? 'text-accent-strong' : 'opacity-70'
                  )}
                />
              )}
            </button>
          </Tip>
        )
      })}
    </div>
  )
}

export function SmartMissingNote({
  where,
  onConfigure
}: {
  where?: string
  onConfigure?: () => void
}): React.JSX.Element {
  return (
    <p
      data-testid="smart-missing"
      className="flex items-start gap-1.5 text-[11.5px] leading-snug text-warning/90"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>
        Configure o modelo do Smart-Approve{where ? ` ${where}` : ''}
        {onConfigure && (
          <>
            {' '}
            (
            <button type="button" onClick={onConfigure} className="underline hover:text-warning">
              abrir
            </button>
            )
          </>
        )}
        . Sem modelo, essas chamadas pedem sua confirmação.
      </span>
    </p>
  )
}

/** Campo editável de uma entrada de lista (pré-preenchido), com validação e aviso suave. */
export function ListEntryEditor({
  item,
  list,
  initial,
  onConfirm,
  onCancel,
  confirmLabel
}: {
  item: ApprovalListItem
  list: 'allow' | 'deny'
  initial: string
  onConfirm: (entry: string) => void | Promise<void>
  onCancel: () => void
  confirmLabel?: string
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const error = validateListEntry(item, value)
  const warn = list === 'allow' && item !== 'pages' ? broadPatternWarning(value) : null
  return (
    <div data-testid="list-entry-editor" className="mt-1.5 space-y-1">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!error) void onConfirm(value.trim())
        }}
      >
        <input
          ref={ref}
          value={value}
          aria-label={list === 'allow' ? 'Padrão da whitelist' : 'Padrão da blacklist'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onCancel()}
          className="field h-7 min-w-0 flex-1 px-2 py-0 font-mono text-[11.5px]"
        />
        <Button
          type="submit"
          size="sm"
          variant={list === 'allow' ? 'primary' : 'danger'}
          disabled={!!error}
        >
          {confirmLabel ?? (list === 'allow' ? 'Salvar e permitir' : 'Salvar e negar')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </form>
      {error ? (
        <p className="text-[11px] text-danger/90">{error}</p>
      ) : warn ? (
        <p data-testid="broad-warning" className="text-[11px] leading-snug text-warning/90">
          {warn}
        </p>
      ) : (
        <p className="text-[11px] leading-snug text-faint">
          {item === 'pages'
            ? 'Domínio (github.com), subdomínios (*.github.com) ou prefixo de URL (https://github.com/org/).'
            : '“*” sozinho = qualquer quantidade de palavras; “*” dentro de uma palavra = curinga; sem “*” = exato.'}
        </p>
      )}
    </div>
  )
}
