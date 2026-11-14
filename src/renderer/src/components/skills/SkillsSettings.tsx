// Configurações → Skills (global): pastas onde o app procura skills (ordem = precedência), liga/
// desliga, adicionar/remover, "Abrir pasta", reescanear, skills de projeto; e, por local, as skills
// descobertas (válidas, inválidas com o erro, sobrescritas) com o SKILL.md em modo leitura.
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Lightbulb,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SKILLS_DIR,
  type SkillInfo,
  type SkillLocation,
  type SkillLocationScan
} from '@shared/skills'
import { api, errorMessage } from '../../lib/api'
import { cn } from '../../lib/format'
import { currentChat, useStore } from '../../store'
import { SkillsLocationsInfo } from '../apiDocs'
import { ToggleRow } from '../panel/fields'
import { Button, IconButton, Spinner, Switch } from '../ui/controls'
import { HelpTip, Tip } from '../ui/Tooltip'
import { useSkillsDiscovery, useSkillsSettings } from './hooks'
import { CloudSkillsSection, SkillSyncProvider, SkillSyncToggle } from '../sync/CloudSkills'

export function SkillsSettings(): React.JSX.Element {
  const { settings, update } = useSkillsSettings()
  const chat = useStore(currentChat)
  const run = useStore((s) => s.run)
  const focus = useStore((s) => s.skillsFocus)
  const { disc, loading, error, reload } = useSkillsDiscovery(chat?.config.cwd ?? null, {
    counts: true
  })
  const [open, setOpen] = useState<string | null>(null)

  // link "ver skill" (painel do chat / card de tool): abre o preview dela
  useEffect(() => {
    if (!focus || !disc) return
    const all = disc.locations.flatMap((l) => l.skills)
    const hit = disc.skills.find((s) => s.name === focus) ?? all.find((s) => s.name === focus)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- foco vindo de fora (link)
    if (hit) setOpen(hit.file)
    useStore.setState({ skillsFocus: null })
  }, [focus, disc])

  if (!settings) return <Spinner />
  const locs = settings.locations
  const setLocs = (locations: SkillLocation[]): Promise<void> => update({ locations })
  const move = (i: number, d: -1 | 1): void => {
    const next = [...locs]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    void setLocs(next)
  }
  const add = async (): Promise<void> => {
    const dir = await run(() => api.skills.pickFolder(), 'Erro ao escolher a pasta')
    if (!dir) return
    if (locs.some((l) => l.path === dir)) {
      useStore.getState().toast('Essa pasta já está na lista.', 'error')
      return
    }
    await setLocs([...locs, { id: `loc-${Date.now().toString(36)}`, path: dir, enabled: true }])
  }
  const scanOf = (id: string): SkillLocationScan | undefined =>
    disc?.locations.find((l) => l.id === id)
  const project = disc?.locations.find((l) => l.kind === 'project')

  return (
    <SkillSyncProvider>
      <div data-testid="skills-settings" className="space-y-4">
        <div className="flex items-center gap-1.5">
          <span className="text-xs leading-relaxed text-subtle">
            Pastas onde o app procura skills
          </span>
          <HelpTip label="Pastas de skills">
            Formato Agent Skills / Claude Code: uma subpasta por skill, com um{' '}
            <span className="font-mono text-muted">SKILL.md</span>. A ordem é a precedência — com
            nomes repetidos vence o primeiro local. Cada chat ou persona liga as skills e escolhe
            quais usar na aba <span className="text-muted">Tools</span>.
          </HelpTip>
          <SkillsLocationsInfo />
          <span className="flex-1" />
          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            icon={<RefreshCw className="size-3.5" />}
            onClick={() => reload(true)}
          >
            Reescanear
          </Button>
        </div>
        {error && <p className="text-[12px] text-danger">{error}</p>}

        <div className="space-y-2.5">
          {locs.map((l, i) => (
            <LocationCard
              key={l.id}
              index={i}
              loc={l}
              scan={scanOf(l.id)}
              isDefault={l.path === DEFAULT_SKILLS_DIR}
              first={i === 0}
              last={i === locs.length - 1}
              open={open}
              onOpen={setOpen}
              onToggle={(enabled) =>
                void setLocs(locs.map((x) => (x.id === l.id ? { ...x, enabled } : x)))
              }
              onMove={(d) => move(i, d)}
              onRemove={() => void setLocs(locs.filter((x) => x.id !== l.id))}
            />
          ))}
          {!locs.length && (
            <p className="rounded-xl border border-dashed border-border px-3 py-3 text-[12.5px] text-subtle">
              Nenhuma pasta configurada.
            </p>
          )}
          <button
            type="button"
            onClick={() => void add()}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[13px] text-subtle transition-colors hover:border-accent/50 hover:bg-accent-soft/30 hover:text-fg"
          >
            <FolderPlus className="size-4" /> Adicionar pasta…
          </button>
          {!locs.some((l) => l.path === DEFAULT_SKILLS_DIR) && (
            <button
              type="button"
              onClick={() =>
                void setLocs([...locs, { id: 'default', path: DEFAULT_SKILLS_DIR, enabled: true }])
              }
              className="text-[11.5px] text-accent-strong hover:underline"
            >
              Restaurar a pasta padrão ({DEFAULT_SKILLS_DIR})
            </button>
          )}
        </div>

        <div className="rounded-xl border border-border bg-surface/50 px-3.5 py-3">
          <ToggleRow
            label="Incluir .claude/skills do diretório raiz do chat"
            help="Skills de projeto, resolvidas por chat (depois das pastas acima na precedência). Com um chat aberto, a lista abaixo mostra as do diretório raiz dele."
            checked={settings.projectSkills}
            onChange={(projectSkills) => void update({ projectSkills })}
          />
          {settings.projectSkills && project && (
            <div className="mt-3 border-t border-border/70 pt-2.5">
              <p className="mb-1.5 text-[11px] text-subtle">
                Chat aberto: <span className="font-mono text-muted">{project.resolved}</span>
                {!project.exists && ' — pasta não existe'}
              </p>
              <SkillList scan={project} open={open} onOpen={setOpen} />
            </div>
          )}
        </div>
        <CloudSkillsSection />
      </div>
    </SkillSyncProvider>
  )
}

function LocationCard({
  index,
  loc,
  scan,
  isDefault,
  first,
  last,
  open,
  onOpen,
  onToggle,
  onMove,
  onRemove
}: {
  index: number
  loc: SkillLocation
  scan: SkillLocationScan | undefined
  isDefault: boolean
  first: boolean
  last: boolean
  open: string | null
  onOpen: (file: string | null) => void
  onToggle: (v: boolean) => void
  onMove: (d: -1 | 1) => void
  onRemove: () => void
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [collapsed, setCollapsed] = useState(false)
  const n = scan?.skills.length ?? 0
  return (
    <div
      data-testid="skills-location"
      data-path={loc.path}
      className={cn(
        'rounded-xl border bg-surface/60',
        loc.enabled ? 'border-border' : 'border-border/60 opacity-70'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="text-faint hover:text-fg"
          aria-label={collapsed ? 'Mostrar skills' : 'Ocultar skills'}
        >
          <ChevronRight
            className={cn('size-3.5 transition-transform', !collapsed && 'rotate-90')}
          />
        </button>
        <span className="w-4 shrink-0 text-center text-[11px] text-faint tabular-nums">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[12.5px] text-fg/90" title={scan?.resolved}>
              {scan?.label ?? loc.path}
            </span>
            {isDefault && (
              <span className="shrink-0 rounded bg-hover px-1 py-px text-[10px] text-subtle">
                padrão
              </span>
            )}
          </div>
          <p className="text-[11px] text-subtle">
            {!scan
              ? 'escaneando…'
              : !scan.exists
                ? 'pasta não existe (fica na lista; aparece quando for criada)'
                : scan.error
                  ? scan.error
                  : `${n} skill${n === 1 ? '' : 's'}`}
          </p>
        </div>
        <IconButton
          label="Subir (mais prioridade)"
          size="xs"
          disabled={first}
          onClick={() => onMove(-1)}
        >
          <ArrowUp />
        </IconButton>
        <IconButton label="Descer" size="xs" disabled={last} onClick={() => onMove(1)}>
          <ArrowDown />
        </IconButton>
        <IconButton
          label="Abrir pasta"
          size="xs"
          disabled={!scan?.exists}
          onClick={() => void run(() => api.skills.openFolder(loc.path), 'Erro ao abrir a pasta')}
        >
          <FolderOpen />
        </IconButton>
        <IconButton label="Remover da lista" size="xs" onClick={onRemove}>
          <Trash2 />
        </IconButton>
        <Switch checked={loc.enabled} onChange={onToggle} label={`Pasta ${loc.path}`} size="sm" />
      </div>
      {!collapsed && scan && scan.skills.length > 0 && (
        <div className="border-t border-border/70 px-3 py-2">
          <SkillList scan={scan} open={open} onOpen={onOpen} />
        </div>
      )}
    </div>
  )
}

function SkillList({
  scan,
  open,
  onOpen
}: {
  scan: SkillLocationScan
  open: string | null
  onOpen: (file: string | null) => void
}): React.JSX.Element {
  if (!scan.skills.length)
    return <p className="text-[11.5px] text-faint">Nenhuma skill nesta pasta.</p>
  return (
    <div className="-mx-1 space-y-px">
      {scan.skills.map((s) => (
        <SkillRow
          key={s.file}
          skill={s}
          open={open === s.file}
          onToggle={() => onOpen(open === s.file ? null : s.file)}
        />
      ))}
    </div>
  )
}

function SkillRow({
  skill: s,
  open,
  onToggle
}: {
  skill: SkillInfo
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open])
  return (
    <div ref={ref} data-testid="skill-row" data-skill={s.name}>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-hover/50',
          open && 'bg-hover/40'
        )}
      >
        <Lightbulb
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            s.error ? 'text-danger/70' : s.shadowedBy ? 'text-faint' : 'text-accent-strong/80'
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'truncate font-mono text-[12px]',
                s.error || s.shadowedBy ? 'text-subtle' : 'text-fg/90'
              )}
            >
              {s.name}
            </span>
            {s.files != null && !s.error && (
              <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
                {s.files} arquivo{s.files === 1 ? '' : 's'}
              </span>
            )}
            {s.warnings.length > 0 && !s.error && (
              <Tip label={s.warnings.join(' · ')}>
                <TriangleAlert className="size-3 shrink-0 text-warning/70" />
              </Tip>
            )}
            {s.shadowedBy && (
              <span
                data-testid="skill-shadowed"
                className="ml-auto shrink-0 rounded bg-warning/10 px-1.5 py-px text-[10.5px] text-warning/90"
              >
                sobrescrita por {s.shadowedBy}
              </span>
            )}
            {s.error && (
              <span className="ml-auto shrink-0 rounded bg-danger/10 px-1.5 py-px text-[10.5px] text-danger/90">
                inválida
              </span>
            )}
            {!s.error && !s.shadowedBy && (
              <span className="ml-auto">
                <SkillSyncToggle skill={s} />
              </span>
            )}
          </div>
          {s.error ? (
            <p data-testid="skill-error" className="text-[11.5px] leading-snug text-danger/85">
              {s.error}
            </p>
          ) : (
            <p className="line-clamp-2 text-[11.5px] leading-snug text-subtle">{s.description}</p>
          )}
        </div>
      </button>
      {open && <SkillPreview skill={s} onClose={onToggle} />}
    </div>
  )
}

function SkillPreview({
  skill: s,
  onClose
}: {
  skill: SkillInfo
  onClose: () => void
}): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    api.skills
      .read(s.file)
      .then((t) => alive && setText(t))
      .catch((e) => alive && setErr(errorMessage(e)))
    return () => {
      alive = false
    }
  }, [s.file, s.mtime])
  const m = s.meta
  const fields: [string, string][] = m
    ? [
        ...(m.license ? [['license', m.license] as [string, string]] : []),
        ...(m.compatibility ? [['compatibility', m.compatibility] as [string, string]] : []),
        ...(m.allowedTools ? [['allowed-tools', m.allowedTools] as [string, string]] : []),
        ...Object.entries(m.metadata ?? {}).map(
          ([k, v]) => [`metadata.${k}`, v] as [string, string]
        ),
        ...Object.entries(m.other ?? {}).map(([k, v]) => [k, v] as [string, string])
      ]
    : []
  return (
    <div
      data-testid="skill-preview"
      className="mx-1.5 mt-1 mb-2 animate-fade-in rounded-lg border border-border bg-bg/60"
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle" title={s.file}>
          {s.file}
        </span>
        <span className="text-[10.5px] text-faint">somente leitura</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
          aria-label="Fechar"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {(fields.length > 0 || s.warnings.length > 0) && (
        <div className="space-y-0.5 border-b border-border/70 px-2.5 py-1.5 text-[11px]">
          {fields.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="w-28 shrink-0 font-mono text-faint">{k}</span>
              <span className="min-w-0 flex-1 break-words text-muted">{v}</span>
            </div>
          ))}
          {s.warnings.map((w) => (
            <div key={w} className="flex items-center gap-1.5 text-warning/85">
              <TriangleAlert className="size-3 shrink-0" /> {w}
            </div>
          ))}
          {m?.other && (
            <p className="text-faint">Campos desconhecidos são mostrados aqui e ignorados.</p>
          )}
        </div>
      )}
      <pre className="max-h-80 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/85">
        {err ? <span className="text-danger">{err}</span> : (text ?? 'carregando…')}
      </pre>
    </div>
  )
}
