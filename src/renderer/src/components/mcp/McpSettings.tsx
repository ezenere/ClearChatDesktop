// Configurações → Conectores (servidores MCP): lista com estado deste aparelho, ativar neste
// computador (com o comando exato), entrar/sair (OAuth), reconectar, editar/apagar; expandido: as
// tools (o que o servidor declara + aprovação por tool com ★ no padrão do conector), o padrão do
// conector, ajustes deste computador e o log. Adicionar e importar no fim da lista.
import {
  ChevronRight,
  FileJson,
  LogIn,
  LogOut,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { mcpLabel, type McpApprovalMode, type McpServerDef, type McpServerView } from '@shared/mcp'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import {
  mcpOverrideDraftOf,
  mcpOverrideOf,
  mcpToolTitle,
  mcpTransportLabel,
  type McpOverrideDraft
} from '../../lib/mcp'
import { useStore } from '../../store'
import { CollapsibleSection } from '../panel/fields'
import { Chip } from '../ui/Chip'
import { AutoTextarea, Button, IconButton, Spinner, Switch } from '../ui/controls'
import { HelpTip } from '../ui/Tooltip'
import { KvRows, McpHintChips, McpModeSelector, McpStatusLine } from './McpControls'
import { McpImport } from './McpImport'
import { McpServerForm } from './McpServerForm'

/** (?) ao lado do título da página. */
export function McpHelp(): React.JSX.Element {
  return (
    <HelpTip label="Conectores" wide>
      <p>
        Servidores MCP (Model Context Protocol) dão ao agente ferramentas de outros programas e
        serviços. O modelo vê cada uma como <span className="font-mono">mcp__nome__tool</span>.
      </p>
      <p>
        <b className="text-fg">Local (stdio)</b>: um programa que roda neste computador — só depois
        de “Ativar neste computador” (cada computador ativa o seu).{' '}
        <b className="text-fg">Remoto (HTTP)</b>: um endereço; com OAuth, cada aparelho entra uma
        vez.
      </p>
      <p>
        O cadastro sincroniza entre os aparelhos; a ativação, os ajustes e os logins ficam neste.
        Cada chat ou persona liga os conectores na aba <span className="text-muted">Tools</span>.
      </p>
    </HelpTip>
  )
}

export function McpSettings(): React.JSX.Element {
  const views = useStore((s) => s.mcp)
  const loadMcp = useStore((s) => s.loadMcp)
  const focus = useStore((s) => s.mcpFocus)
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    void loadMcp()
  }, [loadMcp])

  // link "Configurações → Conectores" vindo de um card/painel: abre aquele conector
  useEffect(() => {
    if (!focus) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- foco vindo de fora (link)
    setOpen(focus)
    useStore.setState({ mcpFocus: null })
  }, [focus])

  if (!views) return <Spinner />
  const names = views.map((v) => v.server.name)
  return (
    <div data-testid="mcp-settings" className="space-y-2.5">
      {views.length === 0 && editing !== 'new' && !importing && (
        <p className="rounded-xl border border-dashed border-border px-3 py-3 text-[12.5px] text-subtle">
          Nenhum conector ainda.
        </p>
      )}
      {views.map((v) =>
        editing === v.server.id ? (
          <McpServerForm
            key={v.server.id}
            server={v.server}
            taken={names.filter((n) => n !== v.server.name)}
            onDone={() => setEditing(null)}
          />
        ) : (
          <McpServerCard
            key={v.server.id}
            view={v}
            open={open === v.server.id}
            onToggle={() => setOpen((o) => (o === v.server.id ? null : v.server.id))}
            onEdit={() => setEditing(v.server.id)}
          />
        )
      )}
      {editing === 'new' ? (
        <McpServerForm
          taken={names}
          onDone={(view) => {
            setEditing(null)
            if (view) setOpen(view.server.id)
          }}
        />
      ) : importing ? (
        <McpImport onDone={() => setImporting(false)} />
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[13px] text-subtle transition-colors hover:border-accent/50 hover:bg-accent-soft/30 hover:text-fg"
          >
            <Plus className="size-4" /> Adicionar conector
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong px-4 text-[13px] text-subtle transition-colors hover:border-accent/50 hover:bg-accent-soft/30 hover:text-fg"
          >
            <FileJson className="size-4" /> Importar…
          </button>
        </div>
      )}
    </div>
  )
}

function McpServerCard({
  view,
  open,
  onToggle,
  onEdit
}: {
  view: McpServerView
  open: boolean
  onToggle: () => void
  onEdit: () => void
}): React.JSX.Element {
  const s = view.server
  const run = useStore((st) => st.run)
  const loadMcp = useStore((st) => st.loadMcp)
  const [confirmActivate, setConfirmActivate] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const cancelled = useRef(false)
  const ref = useRef<HTMLDivElement>(null)
  const stdio = s.transport.type === 'stdio'
  const needsActivation =
    stdio &&
    (view.status.unavailable === 'not-activated' || view.status.unavailable === 'command-changed')
  const activated = stdio && !needsActivation
  const runsHere = !view.status.unavailable

  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  const act = async (key: string, fn: () => Promise<unknown>, err: string): Promise<void> => {
    setBusy(key)
    await run(fn, err)
    await loadMcp()
    setBusy(null)
  }
  const login = async (): Promise<void> => {
    cancelled.current = false
    setLoginError(null)
    setLoggingIn(true)
    const r = await run(() => api.mcp.login(s.id), 'Falha ao entrar')
    setLoggingIn(false)
    if (r && !r.ok && !cancelled.current) setLoginError(r.error)
    await loadMcp()
  }

  return (
    <div
      ref={ref}
      data-testid="mcp-server"
      data-name={s.name}
      data-state={view.status.unavailable ?? view.status.state}
      className="group rounded-xl border border-border bg-bg/30"
      onMouseLeave={() => setConfirmDelete(false)}
    >
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Recolher' : 'Expandir'} ${mcpLabel(s)}`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-faint transition-transform duration-150',
              open && 'rotate-90'
            )}
          />
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
            <Plug className="size-3.5 text-muted" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-medium text-fg">{mcpLabel(s)}</span>
              {s.title && (
                <span className="shrink-0 font-mono text-[11px] text-faint">{s.name}</span>
              )}
              <Chip testId="mcp-transport">{mcpTransportLabel(s)}</Chip>
              {s.oauth && <Chip tip="Login OAuth por aparelho">OAuth</Chip>}
            </span>
            <McpStatusLine view={view} className="mt-0.5" />
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {needsActivation && (
            <Button
              size="sm"
              variant={view.status.unavailable === 'command-changed' ? 'warning' : 'secondary'}
              icon={<ShieldAlert className="size-3.5" />}
              onClick={() => setConfirmActivate(true)}
            >
              Ativar neste computador
            </Button>
          )}
          {activated && (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'deactivate'}
              onClick={() =>
                void act('deactivate', () => api.mcp.deactivate(s.id), 'Erro ao desativar')
              }
            >
              Desativar
            </Button>
          )}
          {s.oauth &&
            (loggingIn ? (
              <span className="flex items-center gap-1.5">
                <span
                  data-testid="mcp-login-waiting"
                  className="flex items-center gap-1.5 text-[11.5px] text-accent-strong"
                >
                  <Spinner className="size-3 text-accent-strong" /> Aguardando o navegador…
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    cancelled.current = true
                    void run(() => api.mcp.cancelLogin(s.id))
                  }}
                >
                  Cancelar
                </Button>
              </span>
            ) : view.hasLogin ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<LogOut className="size-3.5" />}
                loading={busy === 'logout'}
                onClick={() => void act('logout', () => api.mcp.logout(s.id), 'Erro ao sair')}
              >
                Sair
              </Button>
            ) : (
              <Button
                size="sm"
                variant={view.status.state === 'needs-auth' ? 'warning' : 'secondary'}
                icon={<LogIn className="size-3.5" />}
                onClick={() => void login()}
              >
                Entrar
              </Button>
            ))}
          {runsHere && (
            <IconButton
              label="Reconectar"
              size="sm"
              disabled={busy === 'reconnect'}
              onClick={() =>
                void act('reconnect', () => api.mcp.reconnect(s.id), 'Erro ao reconectar')
              }
            >
              <RefreshCw className={cn(busy === 'reconnect' && 'animate-spin')} />
            </IconButton>
          )}
          <IconButton label="Editar" size="sm" onClick={onEdit}>
            <Pencil />
          </IconButton>
          {confirmDelete ? (
            <Button
              size="sm"
              variant="danger"
              loading={busy === 'delete'}
              onClick={() => void act('delete', () => api.mcp.delete(s.id), 'Erro ao apagar')}
            >
              Apagar?
            </Button>
          ) : (
            <IconButton
              label="Apagar conector"
              size="sm"
              className="hover:text-danger"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
            </IconButton>
          )}
        </div>
      </div>

      {loginError && (
        <p
          data-testid="mcp-login-error"
          className="border-t border-danger/20 bg-danger/[0.04] px-3.5 py-1.5 text-[12px] text-danger"
        >
          {loginError}
        </p>
      )}

      {confirmActivate && view.commandText && (
        <ActivateConfirm
          view={view}
          busy={busy === 'activate'}
          onCancel={() => setConfirmActivate(false)}
          onConfirm={() =>
            void act('activate', () => api.mcp.activate(s.id), 'Erro ao ativar').then(() =>
              setConfirmActivate(false)
            )
          }
        />
      )}

      {open && <McpServerDetails view={view} />}
    </div>
  )
}

/** Confirmação de "Ativar neste computador": o comando EXATO que vai rodar + o aviso. */
function ActivateConfirm({
  view,
  busy,
  onCancel,
  onConfirm
}: {
  view: McpServerView
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const t = view.server.transport
  const env =
    t.type === 'stdio' ? Object.keys({ ...t.env, ...(view.local.override?.env ?? {}) }) : []
  return (
    <div
      data-testid="mcp-activate-confirm"
      className="animate-fade-in space-y-2 border-t border-warning/25 bg-warning/[0.05] px-3.5 py-3"
    >
      <div className="text-[12.5px] text-fg">
        Ativar <b className="font-medium">{mcpLabel(view.server)}</b> neste computador?
      </div>
      <pre
        data-testid="mcp-activate-command"
        className="overflow-x-auto rounded-lg border border-border bg-bg/80 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap break-all text-fg/90"
      >
        {view.commandText}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-[11.5px] text-warning/90">
          <ShieldAlert className="size-3.5 shrink-0" />
          Roda como um programa neste computador, com as suas permissões.
        </p>
        {env.length > 0 && (
          <Chip tip={`Variáveis de ambiente (valores não mostrados): ${env.join(', ')}`}>
            + {env.length} {env.length === 1 ? 'variável' : 'variáveis'}
          </Chip>
        )}
        <span className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            data-testid="mcp-activate-apply"
            onClick={onConfirm}
          >
            Ativar
          </Button>
        </span>
      </div>
    </div>
  )
}

function McpServerDetails({ view }: { view: McpServerView }): React.JSX.Element {
  const s = view.server
  const run = useStore((st) => st.run)
  const loadMcp = useStore((st) => st.loadMcp)
  const tools = s.tools?.tools ?? []
  const saveApproval = (approval: McpServerDef['approval']): void =>
    void run(async () => {
      await api.mcp.update(s.id, { approval })
      await loadMcp()
    }, 'Erro ao salvar a aprovação')
  const setToolMode = (tool: string, m: McpApprovalMode): void => {
    const next = { ...(s.approval.tools ?? {}) }
    if (m === s.approval.mode) delete next[tool]
    else next[tool] = m
    saveApproval({ mode: s.approval.mode, ...(Object.keys(next).length ? { tools: next } : {}) })
  }
  const target = s.transport.type === 'stdio' ? view.commandText : s.transport.url
  const info = [
    s.tools?.server &&
      `${s.tools.server.title || s.tools.server.name}${s.tools.server.version ? ` ${s.tools.server.version}` : ''}`,
    view.status.protocolVersion && `protocolo ${view.status.protocolVersion}`
  ].filter(Boolean) as string[]
  return (
    <div
      data-testid="mcp-server-body"
      className="animate-fade-in space-y-3.5 border-t border-border/70 px-3.5 pt-3 pb-3.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-subtle"
          title={target}
        >
          {target}
        </code>
        {info.map((i) => (
          <Chip key={i}>{i}</Chip>
        ))}
      </div>

      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[12px] text-fg/90">
          Aprovação padrão
          <HelpTip label="Aprovação padrão">
            Vale para as tools deste conector sem exceção própria (a ★ nas tools marca este padrão).
            Smart-Approve usa o juiz do chat; sem modelo, pergunta. As dicas do servidor nunca
            liberam nada sozinhas.
          </HelpTip>
        </div>
        <McpModeSelector
          value={s.approval.mode}
          onChange={(mode) => saveApproval({ ...s.approval, mode })}
          label={`Aprovação padrão: ${mcpLabel(s)}`}
          testId="mcp-default-mode"
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[12px] text-fg/90">
          Tools
          <span className="text-[11px] text-faint tabular-nums">{tools.length}</span>
          {tools.length > 0 && (
            <Chip tip="Nomes, títulos, descrições e dicas vêm do servidor — não confiáveis; vão ao modelo como o servidor mandou.">
              declaradas pelo servidor
            </Chip>
          )}
        </div>
        {tools.length === 0 ? (
          <p className="text-[12px] text-subtle">
            Nenhuma tool vista ainda{runsHere(view) ? ' — reconecte para listar.' : '.'}
          </p>
        ) : (
          <ul data-testid="mcp-tools" className="space-y-1.5">
            {tools.map((t) => {
              const own = s.approval.tools?.[t.name] ?? null
              const title = mcpToolTitle(t)
              return (
                <li
                  key={t.name}
                  data-testid="mcp-tool"
                  data-tool={t.name}
                  className="rounded-lg border border-border/80 bg-surface/50 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[12px] text-fg/90">{t.name}</span>
                    {title !== t.name && (
                      <span className="truncate text-[12px] text-muted">{title}</span>
                    )}
                    <McpHintChips tool={t} />
                    <div className="ml-auto w-[230px] max-w-full">
                      <McpModeSelector
                        size="sm"
                        value={own}
                        defaultMode={s.approval.mode}
                        onChange={(m) => setToolMode(t.name, m)}
                        label={`Aprovação: ${t.name}`}
                        testId={`mcp-tool-mode-${t.name}`}
                      />
                    </div>
                  </div>
                  {t.description && (
                    <p
                      title={t.description}
                      className="mt-1 line-clamp-2 border-l-2 border-border-strong/70 pl-2 text-[11.5px] leading-snug text-subtle"
                    >
                      {t.description}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {s.tools?.instructions && (
        <CollapsibleSection
          id={`mcp-instr-${s.id}`}
          level="sub"
          title="Instruções do servidor"
          summary={`${s.tools.instructions.length.toLocaleString('pt-BR')} caracteres`}
          help="Só vão ao modelo nos chats/personas que as ligarem (Tools → Conectores → Ajustes)."
        >
          <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-bg/70 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/85">
            {s.tools.instructions}
          </pre>
        </CollapsibleSection>
      )}

      {s.transport.type === 'stdio' && <McpOverrideEditor view={view} />}

      {(view.status.log.length > 0 || view.status.error) && (
        <div>
          <div className="mb-1 text-[11px] text-subtle">Log</div>
          <pre
            data-testid="mcp-log"
            className="max-h-36 overflow-auto rounded-lg border border-border bg-bg/80 px-2.5 py-1.5 font-mono text-[10.5px] leading-snug whitespace-pre-wrap text-muted"
          >
            {[
              ...view.status.log.slice(-12),
              ...(view.status.error && !view.status.log.length ? [view.status.error] : [])
            ].join('\n')}
          </pre>
        </div>
      )}
    </div>
  )
}

const runsHere = (v: McpServerView): boolean => !v.status.unavailable

/** "Ajustes deste computador" (stdio): argumentos, variáveis e pasta só deste aparelho. */
function McpOverrideEditor({ view }: { view: McpServerView }): React.JSX.Element {
  const s = view.server
  const run = useStore((st) => st.run)
  const loadMcp = useStore((st) => st.loadMcp)
  const [d, setD] = useState<McpOverrideDraft>(() => mcpOverrideDraftOf(view.local.override))
  const [saving, setSaving] = useState(false)
  const o = view.local.override
  const parts = [
    o?.args && 'argumentos',
    o?.env && `${Object.keys(o.env).length} variáveis`,
    o?.cwd !== undefined && 'pasta'
  ].filter(Boolean) as string[]
  const save = async (override: ReturnType<typeof mcpOverrideOf>): Promise<void> => {
    setSaving(true)
    await run(() => api.mcp.setOverride(s.id, override), 'Erro ao salvar os ajustes')
    await loadMcp()
    setSaving(false)
  }
  return (
    <CollapsibleSection
      id={`mcp-override-${s.id}`}
      level="sub"
      title="Ajustes deste computador"
      summary={{
        text: parts.length ? parts.join(' · ') : 'sem ajustes',
        changed: parts.length > 0
      }}
      help="Caminhos que mudam entre máquinas: valem só aqui (nunca sincronizam). Mudar o comando efetivo pede ativar de novo."
    >
      <div data-testid="mcp-override" className="space-y-2.5">
        <div className="flex items-center gap-2 text-[12px] text-fg/90">
          <Switch
            size="sm"
            checked={d.useArgs}
            label="Outros argumentos neste computador"
            onChange={(useArgs) => setD({ ...d, useArgs })}
          />
          Outros argumentos
        </div>
        {d.useArgs && (
          <AutoTextarea
            value={d.args}
            aria-label="Argumentos deste computador (um por linha)"
            spellCheck={false}
            minRows={2}
            maxRows={6}
            onChange={(e) => setD({ ...d, args: e.target.value })}
            className="field font-mono text-[12px]"
          />
        )}
        <div>
          <div className="mb-1 text-[11.5px] text-subtle">Variáveis (somadas às do cadastro)</div>
          <KvRows
            rows={d.env}
            what="variável deste computador"
            keyPlaceholder="NOME"
            valuePlaceholder="valor"
            addLabel="Adicionar variável"
            onChange={(env) => setD({ ...d, env })}
          />
        </div>
        <div className="flex items-center gap-2 text-[12px] text-fg/90">
          <Switch
            size="sm"
            checked={d.useCwd}
            label="Outra pasta neste computador"
            onChange={(useCwd) => setD({ ...d, useCwd })}
          />
          Outra pasta
          {d.useCwd && (
            <input
              value={d.cwd}
              aria-label="Pasta deste computador"
              placeholder="pasta pessoal"
              spellCheck={false}
              onChange={(e) => setD({ ...d, cwd: e.target.value })}
              className="field h-7 min-w-0 flex-1 font-mono text-[12px]"
            />
          )}
        </div>
        <div className="flex justify-end gap-1.5">
          {o && (
            <Button size="sm" variant="ghost" onClick={() => void save(null)}>
              Remover ajustes
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            loading={saving}
            onClick={() => void save(mcpOverrideOf(d))}
          >
            Salvar ajustes
          </Button>
        </div>
      </div>
    </CollapsibleSection>
  )
}
