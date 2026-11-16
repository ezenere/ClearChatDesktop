import {
  AudioLines,
  BrainCircuit,
  CircleUserRound,
  CornerDownLeft,
  Drama,
  CloudSun,
  Globe,
  Lightbulb,
  MessageSquarePlus,
  Plug,
  Search,
  Server,
  ShieldCheck,
  X,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { filterSettingsNav, type SettingsNavSub } from '../lib/settingsNav'
import { cn } from '../lib/format'
import type { SettingsTab, SettingsTarget } from '../store'
import { useEscapeLayer } from './ui/escape'
import { Tip } from './ui/Tooltip'

const ICONS: Record<SettingsTab, LucideIcon> = {
  defaults: MessageSquarePlus,
  presets: Drama,
  audio: AudioLines,
  approvals: ShieldCheck,
  memory: BrainCircuit,
  skills: Lightbulb,
  mcp: Plug,
  web: Globe,
  maps: CloudSun,
  providers: Server,
  account: CircleUserRound
}

/** Abaixo desta largura de janela a barra lateral do modal vira só ícones (com tooltip). */
export const SETTINGS_COMPACT_QUERY = '(max-width: 959px)'

function useCompact(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(SETTINGS_COMPACT_QUERY)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(SETTINGS_COMPACT_QUERY).matches
  )
}

/**
 * Barra lateral de Configurações: busca "Procurar" + grupos de abas (ícone + rótulo). Os itens são
 * `button` dentro de um `nav` com `aria-current="page"` no ativo e nome acessível = rótulo (os testes e
 * os atalhos "Configurações → X" dependem disso). Janela estreita: só ícones; a lupa abre a busca por
 * cima do conteúdo.
 */
export function SettingsNav({
  tab,
  onSelect,
  panelId
}: {
  tab: SettingsTab
  /** Aba (ou sub-tela achada pela busca — ex.: 'audio:local'). */
  onSelect: (t: SettingsTarget) => void
  /** id da área de conteúdo (`aria-controls`). */
  panelId: string
}): React.JSX.Element {
  const compact = useCompact()
  const [query, setQuery] = useState('')
  // só no modo compacto: a busca aberta expande a barra por cima do conteúdo
  const [expanded, setExpanded] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const asideRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const full = !compact || expanded
  const { groups, best, bestSub, total } = useMemo(() => filterSettingsNav(query), [query])

  // Esc: 1º limpa a busca; no compacto, 2º recolhe a barra; depois fecha o modal (camada do Modal)
  useEscapeLayer(compact && expanded, () => setExpanded(false))
  useEscapeLayer(query !== '', () => setQuery(''))

  // compacto com a busca aberta: clicar fora (no conteúdo) recolhe
  useEffect(() => {
    if (!compact || !expanded) return
    const onDown = (e: MouseEvent): void => {
      if (asideRef.current?.contains(e.target as Node)) return
      setExpanded(false)
      setQuery('')
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [compact, expanded])

  const select = (id: SettingsTab, sub?: SettingsNavSub | null): void => {
    onSelect(sub?.target ?? id)
    if (compact && expanded) {
      setExpanded(false)
      setQuery('')
    }
  }

  const items = (): HTMLButtonElement[] => [
    ...(navRef.current?.querySelectorAll<HTMLButtonElement>('button[data-nav-item]') ?? [])
  ]

  // ↑/↓ entre os itens (Home/End nas pontas); ↑ no primeiro volta para a busca
  const onNavKey = (e: React.KeyboardEvent): void => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0) return
    let next: HTMLElement | undefined
    if (e.key === 'ArrowDown') next = list[Math.min(i + 1, list.length - 1)]
    else if (e.key === 'ArrowUp') next = i === 0 ? (inputRef.current ?? undefined) : list[i - 1]
    else if (e.key === 'Home') next = list[0]
    else if (e.key === 'End') next = list[list.length - 1]
    else return
    e.preventDefault()
    next?.focus()
  }

  return (
    <div className={cn('relative shrink-0', compact ? 'w-14' : 'w-[200px]')}>
      <aside
        ref={asideRef}
        data-testid="settings-sidebar"
        data-compact={compact || undefined}
        data-expanded={(compact && expanded) || undefined}
        className={cn(
          'flex h-full flex-col border-r border-border bg-bg/30',
          compact && expanded
            ? 'absolute inset-y-0 left-0 z-20 w-[220px] bg-surface shadow-modal'
            : 'w-full'
        )}
      >
        <div className={cn('shrink-0 pt-3 pb-1', full ? 'px-3' : 'flex justify-center px-2')}>
          {full ? (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" />
              <input
                ref={inputRef}
                autoFocus={compact}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && best) {
                    e.preventDefault()
                    select(best.id, bestSub)
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    items()[0]?.focus()
                  }
                }}
                placeholder="Procurar"
                aria-label="Procurar nas configurações"
                data-testid="settings-search"
                className="h-8 w-full rounded-lg border border-border bg-bg/60 pr-7 pl-8 text-[12.5px] text-fg outline-none placeholder:text-subtle focus:border-accent/50"
              />
              {query && (
                <button
                  type="button"
                  aria-label="Limpar busca das configurações"
                  onClick={() => {
                    setQuery('')
                    inputRef.current?.focus()
                  }}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ) : (
            <Tip label="Procurar" side="right">
              <button
                type="button"
                aria-label="Procurar"
                data-testid="settings-search-toggle"
                onClick={() => setExpanded(true)}
                className="flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                <Search className="size-4" />
              </button>
            </Tip>
          )}
        </div>

        <nav
          ref={navRef}
          aria-label="Seções das configurações"
          data-testid="settings-nav"
          onKeyDown={onNavKey}
          className={cn('min-h-0 flex-1 overflow-y-auto pb-3', full ? 'px-2' : 'px-2.5')}
        >
          {total === 0 && (
            <p
              data-testid="settings-search-empty"
              className="px-2.5 py-3 text-xs leading-relaxed text-subtle"
            >
              Nenhuma configuração encontrada
            </p>
          )}
          {groups.map(({ group, matches }, gi) => (
            <div key={group.id} role="group" aria-label={group.label} data-group={group.id}>
              {full ? (
                <div className="px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-subtle">
                  {group.label}
                </div>
              ) : (
                gi > 0 && <div aria-hidden className="mx-auto my-2 h-px w-6 bg-border" />
              )}
              <div className={cn('space-y-px', !full && gi === 0 && 'pt-1')}>
                {matches.map(({ item, keyword, sub }) => {
                  const Icon = ICONS[item.id]
                  const active = tab === item.id
                  const isBest = !!query && best?.id === item.id
                  const btn = (
                    <button
                      key={item.id}
                      type="button"
                      data-nav-item={item.id}
                      data-best={isBest || undefined}
                      aria-label={item.label}
                      aria-current={active ? 'page' : undefined}
                      aria-controls={panelId}
                      data-sub={(query && sub?.target) || undefined}
                      onClick={() => select(item.id, query ? sub : null)}
                      className={cn(
                        'group flex w-full items-center rounded-lg text-[13px] transition-colors',
                        full ? 'min-h-8 gap-2.5 px-2.5 py-1.5' : 'size-9 justify-center',
                        active ? 'bg-active text-fg' : 'text-fg/75 hover:bg-hover hover:text-fg'
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          active ? 'text-accent-strong' : 'text-muted group-hover:text-fg'
                        )}
                      />
                      {full && (
                        <span className="min-w-0 flex-1 text-left">
                          <span className="block truncate">{item.label}</span>
                          {query && keyword && (
                            <span className="block truncate text-[11px] text-subtle">
                              {keyword}
                            </span>
                          )}
                        </span>
                      )}
                      {full && isBest && (
                        <CornerDownLeft aria-hidden className="size-3 shrink-0 text-subtle" />
                      )}
                    </button>
                  )
                  return full ? (
                    btn
                  ) : (
                    <Tip key={item.id} label={item.label} side="right">
                      {btn}
                    </Tip>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>
    </div>
  )
}
