// Formulário de cadastro/edição de um conector (Configurações → Conectores): nome curto (validado,
// pré-preenchido a partir do título), título, tipo (local stdio / remoto HTTP), comando +
// argumentos + variáveis + pasta, ou URL + cabeçalhos + login OAuth, e o teto de tempo.
import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import {
  MCP_DEFAULT_TIMEOUT_MS,
  uniqueMcpName,
  type McpServerDef,
  type McpServerView
} from '@shared/mcp'
import { api, errorMessage } from '../../lib/api'
import { cn } from '../../lib/format'
import { emptyMcpDraft, mcpDraftOf, mcpDraftToInput, type McpDraft } from '../../lib/mcp'
import { useStore } from '../../store'
import { ToggleRow } from '../panel/fields'
import { AutoTextarea, Button, Label } from '../ui/controls'
import { KvRows } from './McpControls'

function FieldError({ text }: { text?: string }): React.JSX.Element | null {
  if (!text) return null
  return (
    <p data-testid="mcp-field-error" className="mt-1 text-[11.5px] text-danger">
      {text}
    </p>
  )
}

export function McpServerForm({
  server,
  taken,
  onDone
}: {
  /** Editar este (ausente = novo). */
  server?: McpServerDef
  /** Nomes dos OUTROS conectores (colisão). */
  taken: readonly string[]
  onDone: (view?: McpServerView) => void
}): React.JSX.Element {
  const [d, setD] = useState<McpDraft>(() => (server ? mcpDraftOf(server) : emptyMcpDraft()))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const loadMcp = useStore((s) => s.loadMcp)
  const run = useStore((s) => s.run)
  const patch = (p: Partial<McpDraft>): void => {
    setD((cur) => {
      const next = { ...cur, ...p }
      // nome curto segue o título até ser editado à mão
      if (p.title !== undefined && !cur.nameTouched)
        next.name = p.title.trim() ? uniqueMcpName(p.title, taken) : ''
      return next
    })
    setErrors({})
  }

  const save = async (): Promise<void> => {
    const r = mcpDraftToInput(d, taken)
    if ('errors' in r) return setErrors(r.errors)
    setSaving(true)
    try {
      const view = server ? await api.mcp.update(server.id, r.input) : await api.mcp.create(r.input)
      await loadMcp()
      onDone(view)
    } catch (err) {
      setErrors({ form: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const stdio = d.type === 'stdio'
  return (
    <div
      data-testid="mcp-form"
      className="animate-fade-in space-y-3.5 rounded-xl border border-border-strong/70 bg-bg/40 p-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Título</Label>
          <input
            value={d.title}
            aria-label="Título do conector"
            placeholder="Ex.: GitHub da empresa"
            onChange={(e) => patch({ title: e.target.value })}
            className="field h-8 text-[13px]"
          />
        </div>
        <div>
          <Label help="Vai no nome das tools que o modelo vê: mcp__<nome>__<tool>. Letras minúsculas, números e hífens (até 24).">
            Nome curto
          </Label>
          <input
            value={d.name}
            aria-label="Nome curto do conector"
            placeholder="github"
            spellCheck={false}
            onChange={(e) => patch({ name: e.target.value, nameTouched: true })}
            className={cn('field h-8 font-mono text-[12.5px]', errors.name && 'border-danger/50')}
          />
          <FieldError text={errors.name} />
        </div>
      </div>

      <div>
        <Label>Tipo</Label>
        <div
          role="radiogroup"
          aria-label="Tipo do conector"
          className="flex rounded-lg border border-border bg-bg/60 p-0.5"
        >
          {(
            [
              ['stdio', 'Local (stdio)'],
              ['http', 'Remoto (HTTP)']
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={d.type === t}
              onClick={() => patch({ type: t })}
              className={cn(
                'flex-1 rounded-md px-2 py-1 text-[12px] transition-colors',
                d.type === t ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {stdio ? (
        <>
          <div>
            <Label help="O programa que fala MCP pela entrada/saída padrão. Roda neste computador, com as suas permissões, só depois de “Ativar neste computador”.">
              Comando
            </Label>
            <input
              value={d.command}
              aria-label="Comando"
              placeholder="npx"
              spellCheck={false}
              onChange={(e) => patch({ command: e.target.value })}
              className={cn(
                'field h-8 font-mono text-[12.5px]',
                errors.command && 'border-danger/50'
              )}
            />
            <FieldError text={errors.command} />
          </div>
          <div>
            <Label help="Um argumento por linha (sem aspas).">Argumentos</Label>
            <AutoTextarea
              value={d.args}
              aria-label="Argumentos (um por linha)"
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\n~/Documentos'}
              spellCheck={false}
              minRows={2}
              maxRows={8}
              onChange={(e) => patch({ args: e.target.value })}
              className="field font-mono text-[12px] leading-relaxed"
            />
          </div>
          <div>
            <Label help="Valores ficam mascarados aqui e vão cifrados no sync (o cadastro é cifrado ponta a ponta).">
              Variáveis de ambiente
            </Label>
            <KvRows
              testId="mcp-env"
              rows={d.env}
              what="variável"
              keyPlaceholder="API_TOKEN"
              valuePlaceholder="valor"
              addLabel="Adicionar variável"
              onChange={(env) => patch({ env })}
            />
            <FieldError text={errors.env} />
          </div>
          <div>
            <Label>Pasta de trabalho</Label>
            <div className="flex items-center gap-1.5">
              <input
                value={d.cwd}
                aria-label="Pasta de trabalho"
                placeholder="pasta pessoal"
                spellCheck={false}
                onChange={(e) => patch({ cwd: e.target.value })}
                className="field h-8 min-w-0 flex-1 font-mono text-[12px]"
              />
              <Button
                size="sm"
                variant="ghost"
                icon={<FolderOpen className="size-3.5" />}
                onClick={() =>
                  void run(async () => {
                    const dir = await api.fs.pickDirectory()
                    if (dir) patch({ cwd: dir })
                  })
                }
              >
                Escolher…
              </Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div>
            <Label>URL</Label>
            <input
              value={d.url}
              aria-label="URL do servidor"
              placeholder="https://mcp.exemplo.com/mcp"
              spellCheck={false}
              onChange={(e) => patch({ url: e.target.value })}
              className={cn('field h-8 font-mono text-[12.5px]', errors.url && 'border-danger/50')}
            />
            <FieldError text={errors.url} />
          </div>
          <div>
            <Label help="Cabeçalhos fixos de cada requisição (ex.: Authorization: Bearer …). Valores mascarados.">
              Cabeçalhos
            </Label>
            <KvRows
              testId="mcp-headers"
              rows={d.headers}
              what="cabeçalho"
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer …"
              addLabel="Adicionar cabeçalho"
              onChange={(headers) => patch({ headers })}
            />
            <FieldError text={errors.headers} />
          </div>
          <ToggleRow
            label="Login OAuth"
            help="O servidor pede login: “Entrar” abre o navegador do sistema e o login fica neste aparelho (cada aparelho entra uma vez; os tokens nunca sincronizam)."
            checked={d.oauth}
            onChange={(oauth) => patch({ oauth })}
          />
        </>
      )}

      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1 text-[13px] text-fg/90">Tempo máximo por chamada</div>
        <input
          value={d.timeout}
          aria-label="Tempo máximo por chamada (segundos)"
          inputMode="numeric"
          placeholder={String(MCP_DEFAULT_TIMEOUT_MS / 1000)}
          onChange={(e) => patch({ timeout: e.target.value })}
          className={cn(
            'field h-7 w-[72px] px-2 py-0 text-right font-mono text-[12px] tabular-nums',
            errors.timeout && 'border-danger/50'
          )}
        />
        <span className="text-[12px] text-subtle">s</span>
      </div>
      <FieldError text={errors.timeout} />
      <FieldError text={errors.form} />

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone()}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          loading={saving}
          data-testid="mcp-form-save"
          onClick={() => void save()}
        >
          {server ? 'Salvar' : 'Adicionar'}
        </Button>
      </div>
    </div>
  )
}
