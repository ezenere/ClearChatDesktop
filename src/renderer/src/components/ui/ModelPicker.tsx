// Seletor único de modelo: os modelos de TODOS os provedores numa lista, agrupados por provedor
// (cabeçalho com nome, contagem e recolher/expandir), busca em todos os grupos, ID livre por
// provedor. O valor é o par { providerId, model } — o mesmo id em dois provedores são duas opções.
// `requires` (capacidades que o histórico do chat exige — @shared/modelCompat) desabilita os
// modelos que declaradamente não as têm, com o motivo no tooltip; desconhecido nunca desabilita.
// `source` troca a fonte (padrão: provedores de chat + `models` do store) — Configurações → Áudio
// usa o mesmo seletor para os modelos de transcrição/fala (catálogo de voz por provedor), com a
// meta à direita própria (`meta`: latência medida/pt-BR em vez de contexto/preço).
import {
  AlertTriangle,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Eye,
  FileText,
  RefreshCw,
  Search,
  TriangleAlert,
  Settings2,
  Wrench
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { ModelRef } from '@shared/models'
import { compatLabel, compatReason, modelCompat, type ChatCapability } from '@shared/modelCompat'
import { isChatProvider, providerKind } from '@shared/providerKinds'
import type { ModelInfo } from '@shared/types'
import { cn, formatTokens, pricePerMillion } from '../../lib/format'
import {
  ROW_HEIGHT,
  buildPickerRows,
  initialHighlight,
  isSelectable,
  nextSelectable,
  type ModelDisabled,
  rowOffsets,
  scrollToRow,
  stickyHeader,
  visibleRange,
  type PickerModels,
  type PickerProvider,
  type PickerRow
} from '../../lib/modelPicker'
import { useStore } from '../../store'
import { Popover } from './layers'
import { Spinner } from './controls'
import { Tip } from './Tooltip'

const COLLAPSED_KEY = 'clearchat.modelPicker.collapsed'

function loadCollapsed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveCollapsed(s: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...s]))
  } catch {
    /* sem storage: só nesta sessão */
  }
}

function priceLine(m: { promptPrice?: number; completionPrice?: number }): string | null {
  const ip = pricePerMillion(m.promptPrice)
  const op = pricePerMillion(m.completionPrice)
  if (ip === 'grátis' && op === 'grátis') return 'grátis'
  if (!ip && !op) return null
  return `${ip ?? '–'} / ${op ?? '–'}`
}

/** Fonte alternativa de provedores/modelos (ex.: catálogo de voz de Configurações → Áudio). */
export interface ModelPickerSource {
  providers: PickerProvider[]
  models: Record<string, PickerModels | undefined>
  /** Carrega a lista do provedor (`force` = ignora o cache — "Recarregar"/"tentar de novo"). */
  load: (providerId: string, force?: boolean) => void
}

export function ModelPicker({
  value,
  onChange,
  autoFocus,
  className,
  placeholder = 'Escolha um modelo…',
  requires,
  source,
  meta,
  badges,
  testId = 'model-picker',
  label,
  emptyText = 'Nenhum provedor configurado.'
}: {
  value: ModelRef | null
  onChange: (ref: ModelRef) => void
  autoFocus?: boolean
  className?: string
  placeholder?: string
  /** Capacidades exigidas pelo histórico do chat (vazio/ausente = sem restrição). */
  requires?: readonly ChatCapability[]
  /** Fonte própria (padrão: provedores de chat + modelos do store). */
  source?: ModelPickerSource
  /** Meta à direita da linha (padrão: contexto + preço). */
  meta?: (providerId: string, m: ModelInfo) => ReactNode
  /** Badges depois do nome (padrão: tools/visão/PDF/áudio). */
  badges?: (providerId: string, m: ModelInfo) => ReactNode
  testId?: string
  /** aria-label do gatilho (combobox). */
  label?: string
  /** Texto da lista sem provedores (com o atalho "Adicionar" → Configurações → Provedores). */
  emptyText?: string
}): React.JSX.Element {
  // só provedores de chat (os de voz — ElevenLabs — não têm modelos de LLM)
  const allProviders = useStore((s) => s.providers)
  const chatProviders = useMemo(() => allProviders.filter(isChatProvider), [allProviders])
  const storeModels = useStore((s) => s.models)
  const storeLoad = useStore((s) => s.loadModels)
  const providers: PickerProvider[] = source?.providers ?? chatProviders
  const models = source?.models ?? storeModels
  const loadModels = useMemo(
    () =>
      source
        ? (id: string, force?: boolean): void => source.load(id, force)
        : (id: string, force?: boolean): void => void storeLoad(id, force),
    [source, storeLoad]
  )
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hiKey, setHiKey] = useState<string | null>(null)
  const [stored, setStored] = useState<Set<string>>(() => new Set())
  /** Grupo aberto automaticamente ao abrir (o da seleção), mesmo se estiver recolhido. */
  const [forcedOpen, setForcedOpen] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(360)
  /** Largura da barra de rolagem (o cabeçalho grudado não a cobre). */
  const [sbw, setSbw] = useState(0)

  const anchor = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  // o popover só monta a lista depois de se posicionar: os efeitos de medida dependem do elemento
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el
    setScrollEl(el)
  }, [])

  const vPid = value?.providerId ?? ''
  const vModel = value?.model.trim() ?? ''
  const selected = useMemo(
    () => (vPid && vModel ? { providerId: vPid, model: vModel } : null),
    [vPid, vModel]
  )
  const provider = selected ? providers.find((p) => p.id === selected.providerId) : undefined
  const selEntry = selected ? models[selected.providerId] : undefined
  const selInfo = selEntry?.list.find((m) => m.id === selected?.model)

  // o modelo atual precisa da lista do seu provedor (nome/contexto) mesmo fechado
  useEffect(() => {
    if (selected?.providerId && provider) void loadModels(selected.providerId)
  }, [selected?.providerId, provider, loadModels])

  const collapsed = useMemo(() => {
    const c = new Set(stored)
    if (forcedOpen) c.delete(forcedOpen)
    return c
  }, [stored, forcedOpen])

  const reqKey = requires?.join(',') ?? ''
  const disabledReason = useMemo(() => {
    const req = reqKey ? (reqKey.split(',') as ChatCapability[]) : []
    if (!req.length) return undefined
    return (providerId: string, m: ModelInfo): ModelDisabled | null => {
      const p = chatProviders.find((x) => x.id === providerId)
      if (!p) return null
      const pk = providerKind(p)
      const { missing } = modelCompat(req, m, pk)
      const reason = compatReason(missing, pk)
      return reason ? { reason: `${reason}.`, label: compatLabel(missing) } : null
    }
  }, [reqKey, chatProviders])

  const rows = useMemo(
    () => buildPickerRows({ providers, models, query, collapsed, selected, disabledReason }),
    [providers, models, query, collapsed, selected, disabledReason]
  )
  const offsets = useMemo(() => rowOffsets(rows), [rows])
  const total = offsets[rows.length]

  const keyIndex = hiKey ? rows.findIndex((r) => r.key === hiKey) : -1
  const hi =
    keyIndex >= 0 && isSelectable(rows[keyIndex])
      ? keyIndex
      : query.trim()
        ? nextSelectable(rows, -1, 1)
        : initialHighlight(rows)

  const ensureVisible = useCallback(
    (i: number, center = false) => {
      const el = scroller.current
      if (!el || i < 0) return
      const h = el.clientHeight
      const next = center
        ? Math.max(0, offsets[i] - h / 2 + ROW_HEIGHT.model / 2)
        : scrollToRow(offsets, i, el.scrollTop, h, ROW_HEIGHT.header)
      if (next !== el.scrollTop) {
        el.scrollTop = next
        setScrollTop(el.scrollTop)
      }
    },
    [offsets]
  )

  const openList = (): void => {
    for (const p of providers) void loadModels(p.id)
    setStored(loadCollapsed())
    setForcedOpen(selected?.providerId ?? null)
    setQuery('')
    setHiKey(null)
    setScrollTop(0)
    setOpen(true)
    requestAnimationFrame(() => input.current?.focus())
  }

  // ao abrir: a seleção atual centralizada
  const didCenter = useRef(false)
  useLayoutEffect(() => {
    if (!open) {
      didCenter.current = false
      return
    }
    const el = scrollEl
    if (!el || didCenter.current) return
    const sel = rows.findIndex((r) => r.kind === 'model' && r.selected)
    if (sel >= 0) {
      didCenter.current = true
      ensureVisible(sel, true)
    }
  }, [open, rows, ensureVisible, scrollEl])

  useEffect(() => {
    const el = scrollEl
    if (!open || !el) return
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight || 360)
      setSbw(el.offsetWidth - el.clientWidth)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, scrollEl])

  const commit = (r: PickerRow | undefined): void => {
    if (!r || !isSelectable(r)) return
    onChange({ providerId: r.providerId, model: r.kind === 'model' ? r.model.id : r.text })
    setOpen(false)
    setQuery('')
  }

  const toggle = (providerId: string): void => {
    if (query.trim()) return
    const isCollapsed = collapsed.has(providerId)
    // recolher com o grupo rolado para cima: o cabeçalho volta ao topo da janela
    const el = scroller.current
    const h = rows.findIndex((r) => r.kind === 'header' && r.providerId === providerId)
    if (!isCollapsed && el && h >= 0 && offsets[h] < el.scrollTop) {
      el.scrollTop = offsets[h]
      setScrollTop(offsets[h])
    }
    const next = new Set(stored)
    if (isCollapsed) next.delete(providerId)
    else next.add(providerId)
    if (forcedOpen === providerId) setForcedOpen(null)
    setStored(next)
    saveCollapsed(next)
  }

  const move = (dir: 1 | -1): void => {
    const from = hi < 0 ? (dir === 1 ? -1 : rows.length) : hi
    const i = nextSelectable(rows, from, dir)
    if (i < 0) return
    setHiKey(rows[i].key)
    ensureVisible(i)
  }

  const [start, end] = visibleRange(offsets, scrollTop, viewH)
  const sticky = stickyHeader(rows, offsets, scrollTop)
  // o próximo cabeçalho "empurra" o grudado para cima
  let stickyShift = 0
  if (sticky >= 0) {
    const nextHeader = rows.findIndex(
      (r, i) => i > sticky && (r.kind === 'header' || r.kind === 'free-header')
    )
    if (nextHeader > 0) {
      const gap = offsets[nextHeader] - scrollTop
      if (gap < ROW_HEIGHT.header) stickyShift = gap - ROW_HEIGHT.header
    }
  }
  const searching = query.trim().length > 0
  const anyLoading = providers.some((p) => models[p.id]?.status === 'loading')

  const renderRow = (r: PickerRow, i: number, floating = false): React.JSX.Element => {
    switch (r.kind) {
      case 'header':
        return (
          <button
            type="button"
            tabIndex={-1}
            data-testid="model-group"
            data-provider={r.name}
            aria-expanded={!r.collapsed}
            disabled={searching}
            onClick={() => toggle(r.providerId)}
            title={searching ? undefined : r.collapsed ? 'Expandir' : 'Recolher'}
            className={cn(
              'group/h flex h-full w-full items-center gap-1.5 bg-elevated px-3 text-left',
              !floating && i > 0 && 'border-t border-border/60',
              floating && 'border-b border-border/60 shadow-[0_6px_10px_-8px_rgb(0_0_0/0.7)]',
              // opaco: o cabeçalho fixo (floating) fica por cima das linhas que rolam por baixo
              !searching &&
                'hover:bg-[color-mix(in_srgb,var(--color-hover)_50%,var(--color-elevated))]'
            )}
          >
            <ChevronRight
              className={cn(
                'size-3 shrink-0 text-subtle transition-transform',
                !r.collapsed && 'rotate-90',
                searching && 'opacity-30'
              )}
            />
            <span className="min-w-0 truncate text-[11.5px] font-semibold tracking-[0.02em] text-muted group-hover/h:text-fg">
              {r.name}
            </span>
            <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
              {r.status === 'ok' || r.total > 0
                ? searching
                  ? `${r.shown} de ${r.total}`
                  : r.total
                : ''}
            </span>
            <span className="ml-auto flex shrink-0 items-center">
              {r.status === 'loading' || r.status === 'idle' ? (
                <Spinner className="size-3" />
              ) : r.status === 'error' ? (
                <AlertTriangle className="size-3 text-warning/80" />
              ) : null}
            </span>
          </button>
        )
      case 'model': {
        const m = r.model
        const price = priceLine(m)
        const vision = m.inputModalities?.includes('image')
        const pdf = m.inputModalities?.includes('file')
        const audio = m.inputModalities?.includes('audio')
        const off = r.disabled
        const row = (
          <button
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={r.selected}
            aria-disabled={off ? true : undefined}
            data-provider={r.providerName}
            data-model={m.id}
            data-disabled={off ? '' : undefined}
            onMouseMove={() => !off && hiKey !== r.key && setHiKey(r.key)}
            onClick={() => commit(r)}
            className={cn(
              'mx-1 flex h-[42px] w-[calc(100%-8px)] items-center gap-2 rounded-lg pr-2.5 pl-[26px] text-left',
              i === hi && 'bg-hover',
              off && 'cursor-not-allowed'
            )}
          >
            <span className={cn('min-w-0 flex-1', off && 'opacity-45')}>
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'truncate text-[13px]',
                    r.selected ? 'text-accent-strong' : 'text-fg'
                  )}
                >
                  {m.name ?? m.id}
                </span>
                {badges ? badges(r.providerId, m) : null}
                {!badges && m.supportsTools && (
                  <Wrench
                    aria-label="tools"
                    className="size-2.5 shrink-0 text-subtle"
                    strokeWidth={2.25}
                  />
                )}
                {!badges && vision && (
                  <Eye aria-label="visão" className="size-3 shrink-0 text-subtle" />
                )}
                {!badges && pdf && (
                  <FileText aria-label="PDF" className="size-3 shrink-0 text-subtle" />
                )}
                {!badges && audio && (
                  <AudioLines aria-label="áudio" className="size-3 shrink-0 text-subtle" />
                )}
              </span>
              <span className="block truncate font-mono text-[10.5px] text-subtle">{m.id}</span>
            </span>
            {off ? (
              <span
                data-testid="model-incompatible"
                className="flex max-w-[45%] shrink-0 items-center gap-1 text-[10.5px] text-warning/85"
              >
                <TriangleAlert className="size-3 shrink-0" />
                <span className="truncate">{off.label}</span>
              </span>
            ) : meta ? (
              <span className="flex shrink-0 items-center gap-1 text-right text-[10.5px] leading-tight text-subtle tabular-nums">
                {meta(r.providerId, m)}
              </span>
            ) : (
              (m.contextLength || price) && (
                <span className="shrink-0 text-right text-[10.5px] leading-tight text-subtle tabular-nums">
                  {m.contextLength ? (
                    <span className="block">{formatTokens(m.contextLength)} ctx</span>
                  ) : null}
                  {price && (
                    <span className="block" title="Entrada / saída por 1M tokens">
                      {price}
                    </span>
                  )}
                </span>
              )
            )}
            <span className="flex w-3.5 shrink-0 justify-center">
              {r.selected && <Check className="size-3.5 text-accent-strong" />}
            </span>
          </button>
        )
        return off ? (
          <Tip label={<span className="max-w-[340px]">{off.reason}</span>} side="left">
            {row}
          </Tip>
        ) : (
          row
        )
      }
      case 'status':
        return (
          <div className="flex h-full w-full min-w-0 items-center gap-2 pr-2 pl-[30px] text-[11.5px] text-subtle">
            {r.status === 'loading' ? (
              <>
                <Spinner className="size-3" /> Carregando modelos…
              </>
            ) : r.status === 'error' ? (
              <>
                <span className="min-w-0 flex-1 truncate text-warning/85" title={r.error}>
                  Não foi possível listar ({r.error ?? 'erro'})
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => void loadModels(r.providerId, true)}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-accent-strong hover:bg-accent-soft"
                >
                  tentar de novo
                </button>
              </>
            ) : (
              'Nenhum modelo informado em /models — digite o ID acima.'
            )}
          </div>
        )
      case 'free-header':
        return (
          <div className="flex h-full w-full items-end border-t border-border/60 px-3 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-faint uppercase">
            ID livre
          </div>
        )
      case 'free':
        return (
          <button
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={false}
            data-provider={r.providerName}
            data-free={r.text}
            onMouseMove={() => hiKey !== r.key && setHiKey(r.key)}
            onClick={() => commit(r)}
            className={cn(
              'mx-1 flex h-[32px] w-[calc(100%-8px)] items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px]',
              i === hi && 'bg-hover'
            )}
          >
            <CornerDownLeft className="size-3.5 shrink-0 text-subtle" />
            <span className="shrink-0 text-muted">Usar</span>
            <span className="min-w-0 truncate font-mono text-[11.5px] text-fg">
              &ldquo;{r.text}&rdquo;
            </span>
            <span className="shrink-0 text-muted">em</span>
            <span className="max-w-[40%] shrink-0 truncate text-fg/90">{r.providerName}</span>
          </button>
        )
    }
  }

  return (
    <>
      <div
        ref={anchor}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        tabIndex={0}
        autoFocus={autoFocus}
        aria-label={label}
        data-testid={testId}
        data-value={selected?.model ?? ''}
        data-provider-id={selected?.providerId ?? ''}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === ' ')) {
            e.preventDefault()
            openList()
          }
        }}
        className={cn(
          'field no-drag flex cursor-default items-center gap-2',
          open && 'border-border-strong',
          className
        )}
      >
        <span className="@container flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
          {selected ? (
            <>
              <span
                data-testid="model-picker-provider"
                className={cn(
                  'max-w-[35%] shrink-0 truncate text-[12px]',
                  provider ? 'text-subtle' : 'text-warning/85'
                )}
              >
                {provider?.name ?? 'provedor removido'}
              </span>
              <span className="shrink-0 text-faint">·</span>
              <span className="min-w-0 truncate text-fg">{selInfo?.name ?? selected.model}</span>
              {selInfo?.name && selInfo.name !== selected.model && (
                <span className="min-w-0 shrink-[4] truncate font-mono text-[11px] text-subtle @max-[360px]:hidden">
                  {selected.model}
                </span>
              )}
            </>
          ) : (
            <span className="text-subtle">{placeholder}</span>
          )}
        </span>
        {selEntry?.status === 'loading' ? (
          <Spinner />
        ) : (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-subtle transition-transform',
              open && 'rotate-180'
            )}
          />
        )}
      </div>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        maxHeight={440}
        minWidth={400}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
          <Search className="size-3.5 shrink-0 text-subtle" />
          <input
            ref={input}
            value={query}
            aria-label="Buscar modelo"
            placeholder="Buscar em todos os provedores ou digitar um ID…"
            onChange={(e) => {
              setQuery(e.target.value)
              setHiKey(null)
              if (scroller.current) scroller.current.scrollTop = 0
              setScrollTop(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                move(1)
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                move(-1)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                commit(rows[hi])
              }
            }}
            className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
          />
          {providers.length > 0 && (
            <button
              type="button"
              title="Recarregar as listas de modelos"
              aria-label="Recarregar as listas de modelos"
              onClick={() => {
                for (const p of providers) void loadModels(p.id, true)
              }}
              className="rounded p-1 text-subtle hover:bg-hover hover:text-fg"
            >
              <RefreshCw className={cn('size-3.5', anyLoading && 'animate-spin')} />
            </button>
          )}
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            role="listbox"
            aria-label="Modelos"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
          >
            {providers.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-subtle">
                {emptyText}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    setSettingsOpen(true, 'providers')
                  }}
                  className="inline-flex items-center gap-1 text-accent-strong hover:underline"
                >
                  <Settings2 className="size-3" /> Adicionar
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-3 text-xs text-subtle">Nenhum modelo encontrado.</div>
            ) : (
              <div className="relative" style={{ height: total + 4 }}>
                {rows.slice(start, end).map((r, k) => {
                  const i = start + k
                  return (
                    <div
                      key={r.key}
                      className="absolute inset-x-0 flex items-center"
                      style={{ top: offsets[i], height: ROW_HEIGHT[r.kind] }}
                    >
                      {renderRow(r, i)}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          {sticky >= 0 && (
            <div
              className="absolute top-0 left-0 z-10"
              style={{
                right: sbw,
                height: ROW_HEIGHT.header,
                transform: `translateY(${stickyShift}px)`
              }}
            >
              {renderRow(rows[sticky], sticky, true)}
            </div>
          )}
        </div>
      </Popover>
    </>
  )
}
