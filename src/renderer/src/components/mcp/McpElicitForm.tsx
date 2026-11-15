// Formulário de um conector (elicitação MCP, modo formulário): o servidor pede dados ao usuário no
// meio de uma tool. Fica no lugar do campo de mensagem do chat da tool (como o questionário do
// ask_user); sem chat dono, num aviso flutuante (`McpElicitDock`). Enviar / Recusar / Cancelar →
// `mcp.answerElicitation`; erros de validação voltam por campo e o pedido continua aberto.
import { Check, Plug, Send, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { mcpFormContent, type McpFormField } from '@shared/mcp'
import type { McpElicitRequest } from '@shared/types'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { HelpTip } from '../ui/Tooltip'
import { Button, Kbd, Switch } from '../ui/controls'
import { Select } from '../ui/Select'

type Values = Record<string, unknown>

function initialValues(fields: McpFormField[]): Values {
  const out: Values = {}
  for (const f of fields) {
    if (f.default !== undefined) {
      out[f.key] =
        f.kind === 'multiselect'
          ? Array.isArray(f.default)
            ? f.default.map(String)
            : []
          : f.kind === 'boolean'
            ? f.default === true
            : String(f.default)
    } else if (f.kind === 'boolean') out[f.key] = false
    else if (f.kind === 'multiselect') out[f.key] = []
  }
  return out
}

const INPUT_TYPE: Record<string, string> = {
  email: 'email',
  uri: 'url',
  date: 'date',
  'date-time': 'datetime-local'
}
const PLACEHOLDER: Record<string, string> = {
  email: 'nome@exemplo.com',
  uri: 'https://…'
}

/** Valores do card → o que vai ao servidor (data e hora local → ISO 8601). */
function wireValues(fields: McpFormField[], values: Values): Values {
  const out = { ...values }
  for (const f of fields) {
    const v = out[f.key]
    if (f.format === 'date-time' && typeof v === 'string' && v && !/[zZ]|[+-]\d\d:\d\d$/.test(v)) {
      const d = new Date(v)
      if (!Number.isNaN(d.getTime())) out[f.key] = d.toISOString()
    }
  }
  return out
}

function FieldInput({
  field,
  value,
  onChange,
  id
}: {
  field: McpFormField
  value: unknown
  onChange: (v: unknown) => void
  id: string
}): React.JSX.Element {
  const f = field
  if (f.kind === 'boolean')
    return <Switch checked={value === true} onChange={(v) => onChange(v)} label={f.title} />
  if (f.kind === 'select') {
    const opts = f.options ?? []
    if (opts.length > 6)
      return (
        <Select
          value={typeof value === 'string' ? value : null}
          options={opts.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onChange(v)}
          label={f.title}
          placeholder="Escolha…"
          className="h-8 text-[13px]"
        />
      )
    return (
      <div role="radiogroup" aria-label={f.title} className="flex flex-wrap gap-1.5">
        {opts.map((o) => {
          const on = value === o.value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              className={cn(
                'rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors',
                on
                  ? 'border-accent/55 bg-accent-soft/50 text-fg'
                  : 'border-border bg-bg/30 text-muted hover:border-border-strong hover:text-fg'
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    )
  }
  if (f.kind === 'multiselect') {
    const list = Array.isArray(value) ? (value as string[]) : []
    return (
      <div role="group" aria-label={f.title} className="flex flex-wrap gap-1.5">
        {(f.options ?? []).map((o) => {
          const on = list.includes(o.value)
          return (
            <button
              key={o.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => onChange(on ? list.filter((x) => x !== o.value) : [...list, o.value])}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors',
                on
                  ? 'border-accent/55 bg-accent-soft/50 text-fg'
                  : 'border-border bg-bg/30 text-muted hover:border-border-strong hover:text-fg'
              )}
            >
              <span
                className={cn(
                  'flex size-3.5 items-center justify-center rounded-[4px] border',
                  on ? 'border-accent bg-accent text-white' : 'border-border-strong'
                )}
              >
                {on && <Check className="size-2.5" strokeWidth={3} />}
              </span>
              {o.label}
            </button>
          )
        })}
      </div>
    )
  }
  const numeric = f.kind === 'number' || f.kind === 'integer'
  return (
    <input
      id={id}
      type={numeric ? 'number' : (INPUT_TYPE[f.format ?? ''] ?? 'text')}
      step={f.kind === 'integer' ? 1 : numeric ? 'any' : undefined}
      min={numeric ? f.min : undefined}
      max={numeric ? f.max : undefined}
      minLength={f.kind === 'text' ? f.min : undefined}
      maxLength={f.kind === 'text' ? f.max : undefined}
      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
      placeholder={
        numeric
          ? f.min !== undefined && f.max !== undefined
            ? `${f.min}–${f.max}`
            : f.kind === 'integer'
              ? 'número inteiro'
              : 'número'
          : (PLACEHOLDER[f.format ?? ''] ?? '')
      }
      onChange={(e) => onChange(e.target.value)}
      className="field h-8 text-[13px]"
    />
  )
}

export function McpElicitForm({ request }: { request: McpElicitRequest }): React.JSX.Element {
  const answer = useStore((s) => s.answerMcpElicit)
  const form = request.form
  const [values, setValues] = useState<Values>(() => initialValues(form.fields))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [sending, setSending] = useState<'accept' | 'decline' | 'cancel' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    rootRef.current?.focus()
  }, [request.id])

  const send = async (action: 'accept' | 'decline' | 'cancel'): Promise<void> => {
    if (sending) return
    let payload: Values | undefined
    if (action === 'accept') {
      payload = wireValues(form.fields, values)
      // a mesma validação do main (resposta imediata; o main confere de novo)
      const local = mcpFormContent(form, payload).errors
      if (Object.keys(local).length) {
        setErrors(local)
        return
      }
    }
    setSending(action)
    const r = await answer(request.id, action, payload)
    setSending(null)
    if (!r.ok) setErrors(r.errors)
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="mcp-elicit-form"
      data-server={request.serverId}
      role="group"
      aria-label={`Formulário do conector ${request.serverLabel}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          void send('cancel')
        } else if (e.key === 'Enter' && !e.shiftKey && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault()
          void send('accept')
        }
      }}
      className="px-4 pt-3.5 pb-3 outline-none"
    >
      <div className="mb-2 flex items-center gap-2 text-[11px] text-subtle">
        <Plug className="size-3 text-accent-strong" />
        <span className="font-medium text-accent-strong">
          Conector {request.serverLabel} pede dados
        </span>
        <button
          type="button"
          onClick={() => void send('cancel')}
          className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
          aria-label="Cancelar formulário"
        >
          <X className="size-3" /> Cancelar <Kbd>Esc</Kbd>
        </button>
      </div>
      {form.message && (
        <h3
          data-testid="mcp-elicit-message"
          className="text-[14px] leading-snug font-medium whitespace-pre-wrap text-fg"
        >
          {form.message}
        </h3>
      )}
      <div className="mt-2.5 max-h-[46vh] space-y-3 overflow-y-auto pr-0.5">
        {form.fields.map((f) => {
          const id = `mcp-el-${request.id}-${f.key}`
          const err = errors[f.key]
          return (
            <div key={f.key} data-testid="mcp-elicit-field" data-field={f.key} data-kind={f.kind}>
              <div
                className={cn(
                  'flex gap-3',
                  f.kind === 'boolean' ? 'items-center' : 'flex-col gap-1'
                )}
              >
                <label htmlFor={id} className="min-w-0 flex-1 text-[12.5px] text-fg/90">
                  {f.title}
                  {f.required && f.kind !== 'boolean' && (
                    <span className="ml-0.5 text-danger/80" aria-label="obrigatório">
                      *
                    </span>
                  )}
                  {f.description && (
                    <span className="block text-[11.5px] leading-snug text-subtle">
                      {f.description}
                    </span>
                  )}
                </label>
                <FieldInput
                  field={f}
                  id={id}
                  value={values[f.key]}
                  onChange={(v) => {
                    setValues((cur) => ({ ...cur, [f.key]: v }))
                    setErrors((cur) => {
                      if (!cur[f.key]) return cur
                      const next = { ...cur }
                      delete next[f.key]
                      return next
                    })
                  }}
                />
              </div>
              {err && (
                <p
                  data-testid="mcp-elicit-error"
                  data-field={f.key}
                  className="mt-1 text-[11.5px] text-danger"
                >
                  {err}
                </p>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <HelpTip label="Formulário do conector">
          A resposta vai para o servidor do conector (não para o modelo). Recusar ou cancelar avisa
          o servidor, que segue sem os dados.
        </HelpTip>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            data-testid="mcp-elicit-decline"
            loading={sending === 'decline'}
            onClick={() => void send('decline')}
          >
            Recusar
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="mcp-elicit-submit"
            loading={sending === 'accept'}
            icon={<Send className="size-3.5" />}
            onClick={() => void send('accept')}
          >
            Enviar
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Formulários sem chat dono (servidor pediu fora de uma tool): aviso flutuante com o formulário. */
export function McpElicitDock(): React.JSX.Element | null {
  const req = useStore((s) => s.mcpElicits.find((r) => !r.chatId))
  if (!req) return null
  return (
    <div
      data-testid="mcp-elicit-dock"
      className="fixed top-12 right-4 z-[80] w-[440px] max-w-[calc(100vw-2rem)] animate-pop-in rounded-2xl border border-border-strong/70 bg-surface shadow-popover"
    >
      <McpElicitForm key={req.id} request={req} />
    </div>
  )
}
