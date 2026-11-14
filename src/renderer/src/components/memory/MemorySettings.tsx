// Configurações → Memórias (global): por categoria, as coleções (criar, renomear, descrição, ícone,
// apagar) → memórias da coleção (lista com busca) → detalhe editável (título, resumo, tópicos,
// "Sempre carregar", mover, origem, substitui/substituída). Chats e personas só selecionam/ativam
// (aba Memória).
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_HINTS,
  MEMORY_CATEGORY_LABELS,
  type Memory,
  type MemoryCategory,
  type MemoryCollection,
  type MemoryPatch
} from '@shared/memory'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import {
  canAddFact,
  cleanField,
  counter,
  matchesMemory,
  MEMORY_LIMITS,
  memoryDate,
  moveFact,
  moveTargets,
  plainMemoryText,
  removeFact,
  replaceFact,
  sharedCollections,
  splitMemoryLinks,
  UPDATED_BY_LABEL
} from '../../lib/memory'
import { useStore, type MemoryFocus } from '../../store'
import { IconPicker } from '../presets/PresetIcon'
import { AutoTextarea, Button, Switch } from '../ui/controls'
import { Select } from '../ui/Select'
import { HelpTip, Tip } from '../ui/Tooltip'
import { useMemoryCollections } from './hooks'
import { CATEGORY_ICON, CollectionIcon } from './MemoryIcon'

type View = { kind: 'home' } | { kind: 'collection'; id: string } | { kind: 'memory'; id: string }

/** Todas as memórias (para links [[slug]], substituições e busca global); recarrega em `memory-changed`. */
function useAllMemories(): { all: Memory[]; loaded: boolean; reload: () => void } {
  const tick = useStore((s) => s.memoryTick)
  const [all, setAll] = useState<Memory[]>([])
  const [loaded, setLoaded] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    api.memory
      .list()
      .then((l) => {
        if (!alive) return
        setAll(l)
        setLoaded(true)
      })
      .catch(() => alive && setLoaded(true))
    return () => {
      alive = false
    }
  }, [tick, nonce])
  return { all, loaded, reload: () => setNonce((n) => n + 1) }
}

export function MemorySettings(): React.JSX.Element {
  const cols = useMemoryCollections()
  const loadCols = useStore((s) => s.loadMemoryCollections)
  const focus = useStore((s) => s.memoryFocus)
  const { all, loaded, reload } = useAllMemories()
  const [view, setView] = useState<View>({ kind: 'home' })

  // Link externo (tool card, extração, painel) → abre a coleção/memória pedida (ajuste no render,
  // não em efeito); o foco é consumido logo depois.
  const [seenFocus, setSeenFocus] = useState<MemoryFocus | null>(null)
  if (focus && focus !== seenFocus) {
    setSeenFocus(focus)
    setView(
      focus.memoryId
        ? { kind: 'memory', id: focus.memoryId }
        : focus.collectionId
          ? { kind: 'collection', id: focus.collectionId }
          : { kind: 'home' }
    )
  }
  useEffect(() => {
    if (focus) useStore.setState({ memoryFocus: null })
  }, [focus])

  const refresh = (): void => {
    reload()
    void loadCols()
  }
  const nav = {
    home: () => setView({ kind: 'home' }),
    collection: (id: string) => setView({ kind: 'collection', id }),
    memory: (id: string) => setView({ kind: 'memory', id })
  }

  if (view.kind === 'memory') {
    const m = all.find((x) => x.id === view.id)
    if (!m)
      return (
        <Missing loaded={loaded} onBack={nav.home}>
          Esta memória não existe mais (pode ter sido apagada).
        </Missing>
      )
    return (
      <MemoryDetail key={m.id} memory={m} cols={cols} all={all} nav={nav} onChanged={refresh} />
    )
  }
  if (view.kind === 'collection') {
    const c = cols.find((x) => x.id === view.id)
    if (!c)
      return (
        <Missing loaded={cols.length > 0} onBack={nav.home}>
          Esta coleção não existe mais.
        </Missing>
      )
    return <CollectionView key={c.id} collection={c} all={all} nav={nav} onChanged={refresh} />
  }
  return <Home cols={cols} all={all} nav={nav} onChanged={refresh} />
}

type Nav = {
  home: () => void
  collection: (id: string) => void
  memory: (id: string) => void
}

function Missing({
  loaded,
  onBack,
  children
}: {
  loaded: boolean
  onBack: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="animate-fade-in">
      <BackLink onClick={onBack}>Memórias</BackLink>
      <p className="py-8 text-center text-[12.5px] text-subtle">
        {loaded ? children : 'Carregando…'}
      </p>
    </div>
  )
}

function BackLink({
  onClick,
  children
}: {
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="memory-back"
      className="mb-3 inline-flex items-center gap-1.5 text-xs text-subtle hover:text-fg"
    >
      <ArrowLeft className="size-3.5" /> {children}
    </button>
  )
}

function SearchBox({
  value,
  onChange,
  placeholder,
  className
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="field h-8 pr-7 pl-8 text-[12.5px]"
      />
      {value && (
        <button
          type="button"
          aria-label="Limpar busca"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-faint hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

// ---------------- início: categorias e coleções ----------------

function Home({
  cols,
  all,
  nav,
  onChanged
}: {
  cols: MemoryCollection[]
  all: Memory[]
  nav: Nav
  onChanged: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState<MemoryCategory | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const results = query.trim() ? all.filter((m) => matchesMemory(m, query)) : null

  return (
    <div data-testid="memory-settings" className="animate-fade-in space-y-5">
      <div className="flex items-center gap-1.5 text-xs leading-relaxed text-subtle">
        Coleções globais, cada uma de uma categoria.
        <HelpTip label="Memórias">
          Os chats e as personas escolhem quais o modelo lê e em qual ele grava (aba{' '}
          <strong className="text-fg/85">Memória</strong> do painel). Tudo o que você edita aqui
          vale para todos.
        </HelpTip>
      </div>
      <SearchBox value={query} onChange={setQuery} placeholder="Buscar em todas as memórias" />

      {results ? (
        <div data-testid="memory-search-results">
          <div className="mb-1.5 text-[11px] text-subtle">
            {results.length} {results.length === 1 ? 'resultado' : 'resultados'}
          </div>
          <MemoryRows list={results} cols={cols} all={all} onOpen={nav.memory} showCollection />
        </div>
      ) : (
        <>
          {MEMORY_CATEGORIES.map((cat) => {
            const Icon = CATEGORY_ICON[cat]
            const list = sharedCollections(cols, cat)
            return (
              <section
                key={cat}
                data-testid={`memory-settings-cat-${cat}`}
                className="settings-section"
              >
                <div className="mb-1.5 flex items-center gap-2 border-b border-border/50 pb-1.5">
                  <Icon className="size-3.5 text-muted" strokeWidth={1.75} />
                  <span className="text-[13px] font-medium text-fg/90">
                    {MEMORY_CATEGORY_LABELS[cat]}
                  </span>
                  <span className="truncate text-[11px] text-subtle">
                    {MEMORY_CATEGORY_HINTS[cat]}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-6 px-2 text-[11.5px]"
                    icon={<Plus className="size-3.5" />}
                    onClick={() => setCreating(cat)}
                  >
                    Nova coleção
                  </Button>
                </div>
                <div className="space-y-1">
                  {list.map((c) =>
                    editing === c.id ? (
                      <CollectionForm
                        key={c.id}
                        category={cat}
                        collection={c}
                        onDone={(saved) => {
                          setEditing(null)
                          if (saved) onChanged()
                        }}
                      />
                    ) : (
                      <CollectionRow
                        key={c.id}
                        collection={c}
                        onOpen={() => nav.collection(c.id)}
                        onEdit={() => setEditing(c.id)}
                        onDeleted={onChanged}
                      />
                    )
                  )}
                  {list.length === 0 && creating !== cat && (
                    <p className="px-1 py-1.5 text-[11.5px] text-faint">Nenhuma coleção.</p>
                  )}
                  {creating === cat && (
                    <CollectionForm
                      category={cat}
                      onDone={(saved) => {
                        setCreating(null)
                        if (saved) onChanged()
                      }}
                    />
                  )}
                </div>
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}

function CollectionRow({
  collection: c,
  onOpen,
  onEdit,
  onDeleted
}: {
  collection: MemoryCollection
  onOpen: () => void
  onEdit: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const run = useStore((s) => s.run)
  const n = c.count ?? 0
  return (
    <div
      data-testid={`memory-collection-${c.id}`}
      className="group flex items-center gap-2.5 rounded-lg border border-transparent px-1.5 py-1.5 hover:border-border hover:bg-bg/40"
      onMouseLeave={() => setConfirm(false)}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <CollectionIcon collection={c} size="md" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-fg/90">{c.name}</span>
          <span className="block truncate text-[11.5px] text-subtle">
            {c.description || <span className="text-faint">Sem descrição</span>}
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-subtle tabular-nums">
          {n} {n === 1 ? 'memória' : 'memórias'}
        </span>
      </button>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Tip label="Editar coleção">
          <button
            type="button"
            aria-label={`Editar ${c.name}`}
            onClick={onEdit}
            className="grid size-7 place-items-center rounded-md text-subtle hover:bg-hover hover:text-fg"
          >
            <Pencil className="size-3.5" />
          </button>
        </Tip>
        {confirm ? (
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void run(async () => {
                await api.memory.deleteCollection(c.id)
                onDeleted()
              }, 'Erro ao apagar a coleção')
            }
          >
            {n ? `Apagar com ${n} ${n === 1 ? 'memória' : 'memórias'}?` : 'Apagar?'}
          </Button>
        ) : (
          <Tip label="Apagar coleção">
            <button
              type="button"
              aria-label={`Apagar ${c.name}`}
              onClick={() => setConfirm(true)}
              className="grid size-7 place-items-center rounded-md text-subtle hover:bg-hover hover:text-danger"
            >
              <Trash2 className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
      <ChevronRight className="size-3.5 shrink-0 text-faint" />
    </div>
  )
}

function CollectionForm({
  category,
  collection,
  onDone
}: {
  category: MemoryCategory
  collection?: MemoryCollection
  onDone: (saved: boolean) => void
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [name, setName] = useState(collection?.name ?? '')
  const [description, setDescription] = useState(collection?.description ?? '')
  const [icon, setIcon] = useState<string | null>(collection?.icon ?? null)
  const [iconsOpen, setIconsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    setSaving(true)
    const ok = await run(
      () =>
        collection
          ? api.memory.updateCollection(collection.id, {
              name: n,
              description: description.trim(),
              icon
            })
          : api.memory.createCollection({
              category,
              name: n,
              description: description.trim(),
              icon
            }),
      collection ? 'Erro ao salvar a coleção' : 'Erro ao criar a coleção'
    )
    setSaving(false)
    if (ok) onDone(true)
  }
  return (
    <form
      data-testid="memory-collection-form"
      className="animate-fade-in rounded-xl border border-border-strong/70 bg-bg/40 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Escolher ícone"
          aria-expanded={iconsOpen}
          onClick={() => setIconsOpen((o) => !o)}
          className="rounded-lg transition-opacity hover:opacity-80"
        >
          <CollectionIcon collection={{ icon, category }} size="md" />
        </button>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onDone(false)
            }
          }}
          placeholder={`Nome — ex.: ${category === 'areas' ? 'Projeto TCC' : category === 'people' ? 'Família' : 'Pessoal'}`}
          aria-label="Nome da coleção"
          maxLength={MEMORY_LIMITS.collectionName}
          className="field h-8 min-w-0 flex-1 text-[13px]"
        />
      </div>
      {iconsOpen && (
        <div className="mt-2 rounded-lg border border-border bg-bg/40 p-2">
          <IconPicker value={icon ?? ''} onChange={(v) => setIcon(v || null)} />
          {icon && (
            <button
              type="button"
              onClick={() => setIcon(null)}
              className="mt-1.5 text-[11px] text-subtle hover:text-fg"
            >
              Usar o ícone da categoria
            </button>
          )}
        </div>
      )}
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Descrição — vai no índice para o modelo saber o que há aqui"
        aria-label="Descrição da coleção"
        maxLength={MEMORY_LIMITS.collectionDescription}
        className="field mt-2 h-8 text-[12.5px]"
      />
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => onDone(false)}>
          Cancelar
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={saving} disabled={!name.trim()}>
          {collection ? 'Salvar' : 'Criar coleção'}
        </Button>
      </div>
    </form>
  )
}

// ---------------- coleção: lista de memórias ----------------

function CollectionView({
  collection: c,
  all,
  nav,
  onChanged
}: {
  collection: MemoryCollection
  all: Memory[]
  nav: Nav
  onChanged: () => void
}): React.JSX.Element {
  const cols = useStore((s) => s.memoryCollections)
  const run = useStore((s) => s.run)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [found, setFound] = useState<Memory[] | null>(null)
  const own = useMemo(
    () => all.filter((m) => m.collectionId === c.id).sort((a, b) => b.updatedAt - a.updatedAt),
    [all, c.id]
  )

  // Busca: o FTS do main (memory.list com query); cai no filtro local se falhar.
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let alive = true
    const t = setTimeout(() => {
      api.memory
        .list({ collectionId: c.id, query: q })
        .then((l) => alive && setFound(l))
        .catch(() => alive && setFound(own.filter((m) => matchesMemory(m, q))))
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, c.id, own])
  const list = query.trim() ? (found ?? own.filter((m) => matchesMemory(m, query))) : own

  return (
    <div data-testid="memory-collection-view" className="animate-fade-in">
      <BackLink onClick={nav.home}>Memórias</BackLink>
      {editing ? (
        <CollectionForm
          category={c.category}
          collection={c}
          onDone={(saved) => {
            setEditing(false)
            if (saved) onChanged()
          }}
        />
      ) : (
        <div className="flex items-start gap-3" onMouseLeave={() => setConfirm(false)}>
          <CollectionIcon collection={c} size="md" className="size-10 [&_svg]:size-5" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold tracking-tight">{c.name}</h3>
            <p className="text-[11.5px] text-subtle">
              {MEMORY_CATEGORY_LABELS[c.category]} · {own.length}{' '}
              {own.length === 1 ? 'memória' : 'memórias'}
            </p>
            {c.description && (
              <p className="mt-1 text-[12.5px] leading-snug text-muted">{c.description}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil className="size-3.5" />}
              onClick={() => setEditing(true)}
            >
              Editar
            </Button>
            {confirm ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() =>
                  void run(async () => {
                    await api.memory.deleteCollection(c.id)
                    onChanged()
                    nav.home()
                  }, 'Erro ao apagar a coleção')
                }
              >
                Apagar coleção
                {own.length ? ` e ${own.length} ${own.length === 1 ? 'memória' : 'memórias'}` : ''}?
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="hover:text-danger"
                icon={<Trash2 className="size-3.5" />}
                onClick={() => setConfirm(true)}
                aria-label="Apagar coleção"
              />
            )}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Buscar nesta coleção"
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-8"
          icon={<Plus className="size-3.5" />}
          onClick={() => setCreating(true)}
        >
          Nova memória
        </Button>
      </div>
      {creating && (
        <NewMemoryForm
          collectionId={c.id}
          onDone={(m) => {
            setCreating(false)
            if (m) {
              onChanged()
              nav.memory(m.id)
            }
          }}
        />
      )}
      <div className="mt-3">
        {list.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-subtle">
            {query.trim() ? 'Nada encontrado.' : 'Nenhuma memória nesta coleção.'}
          </p>
        ) : (
          <MemoryRows list={list} cols={cols} all={all} onOpen={nav.memory} />
        )}
      </div>
    </div>
  )
}

function MemoryRows({
  list,
  cols,
  all,
  onOpen,
  showCollection
}: {
  list: Memory[]
  cols: MemoryCollection[]
  all: Memory[]
  onOpen: (id: string) => void
  showCollection?: boolean
}): React.JSX.Element {
  return (
    <div className="divide-y divide-border/60 rounded-xl border border-border">
      {list.map((m) => {
        const supersededBy = all.find((x) => x.supersedesId === m.id)
        const col = showCollection ? cols.find((c) => c.id === m.collectionId) : undefined
        return (
          <button
            key={m.id}
            type="button"
            data-testid={`memory-row-${m.id}`}
            onClick={() => onOpen(m.id)}
            className="group flex w-full items-start gap-3 px-3.5 py-2.5 text-left first:rounded-t-xl last:rounded-b-xl hover:bg-hover/40"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium text-fg/90">{m.title}</span>
                {m.pinned && (
                  <Tip label="Sempre carregar (vai no índice com os tópicos)">
                    <Pin className="size-3 shrink-0 text-accent-strong" />
                  </Tip>
                )}
                {supersededBy && (
                  <span className="shrink-0 rounded border border-border px-1 text-[9.5px] text-faint">
                    substituída
                  </span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-[12px] text-subtle">
                {plainMemoryText(m.summary, all) || <span className="text-faint">Sem resumo</span>}
              </span>
              {col && (
                <span className="mt-0.5 block truncate text-[10.5px] text-faint">
                  {MEMORY_CATEGORY_LABELS[col.category]} · {col.name}
                </span>
              )}
            </span>
            <span className="shrink-0 pt-0.5 text-[11px] text-faint">
              Atualizado {memoryDate(m.updatedAt)}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function Counter({ text, max }: { text: string; max: number }): React.JSX.Element {
  const c = counter(text, max)
  return (
    <span
      data-testid="memory-counter"
      className={cn(
        'shrink-0 text-[10.5px] tabular-nums',
        c.over ? 'text-danger' : c.near ? 'text-warning/90' : 'text-faint'
      )}
    >
      {c.label}
    </span>
  )
}

function NewMemoryForm({
  collectionId,
  onDone
}: {
  collectionId: string
  onDone: (m: Memory | null) => void
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [saving, setSaving] = useState(false)
  const t = cleanField(title, MEMORY_LIMITS.title, true)
  const s = cleanField(summary, MEMORY_LIMITS.summary)
  const valid = t !== null && s !== null
  return (
    <form
      data-testid="memory-new-form"
      className="mt-3 animate-fade-in rounded-xl border border-border-strong/70 bg-bg/40 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        setSaving(true)
        void run(
          () => api.memory.create({ collectionId, title: t, summary: s, facts: [] }),
          'Erro ao criar a memória'
        ).then((m) => {
          setSaving(false)
          if (m) onDone(m)
        })
      }}
    >
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onDone(null)
            }
          }}
          placeholder="Título — ex.: Trabalho atual"
          aria-label="Título da memória"
          className="field h-8 min-w-0 flex-1 text-[13px]"
        />
        <Counter text={title} max={MEMORY_LIMITS.title} />
      </div>
      <div className="mt-2 flex items-start gap-2">
        <AutoTextarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Resumo de uma linha (vai no índice)"
          aria-label="Resumo da memória"
          minRows={1}
          maxRows={4}
          className="field min-w-0 flex-1 text-[12.5px]"
        />
        <Counter text={summary} max={MEMORY_LIMITS.summary} />
      </div>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
          Cancelar
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={saving} disabled={!valid}>
          Criar memória
        </Button>
      </div>
    </form>
  )
}

// ---------------- detalhe da memória ----------------

/** Texto com `[[slug]]` virando link para a memória (slug desconhecido fica como texto). */
function MemoryText({
  text,
  all,
  onOpen
}: {
  text: string
  all: Memory[]
  onOpen: (id: string) => void
}): React.JSX.Element {
  return (
    <>
      {splitMemoryLinks(text).map((seg, i) => {
        if ('text' in seg) return <span key={i}>{seg.text}</span>
        const target = all.find((m) => m.slug === seg.slug)
        return target ? (
          <button
            key={i}
            type="button"
            data-testid="memory-link"
            onClick={(e) => {
              e.stopPropagation()
              onOpen(target.id)
            }}
            className="text-accent-strong underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            {seg.label === seg.slug ? target.title : seg.label}
          </button>
        ) : (
          <span key={i} className="text-subtle underline decoration-dotted underline-offset-2">
            {seg.label}
          </span>
        )
      })}
    </>
  )
}

/** Campo editável no lugar: clique para editar; Enter salva, Esc cancela; contador com o limite. */
function InlineEdit({
  value,
  max,
  onSave,
  label,
  multiline,
  required,
  placeholder,
  className,
  inputClassName,
  children
}: {
  value: string
  max: number
  onSave: (v: string) => Promise<boolean> | boolean
  label: string
  multiline?: boolean
  required?: boolean
  placeholder?: string
  className?: string
  inputClassName?: string
  /** Exibição (padrão: o próprio texto). */
  children?: ReactNode
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const cancelled = useRef(false)
  const commit = async (): Promise<void> => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const v = cleanField(text, max, required)
    if (v === null) return // inválido: continua editando (contador vermelho)
    if (v === value.trim()) return setEditing(false)
    if (await onSave(v)) setEditing(false)
  }
  if (!editing)
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Editar ${label}`}
        onClick={() => {
          setText(value)
          setEditing(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setText(value)
            setEditing(true)
          }
        }}
        className={cn(
          'group/edit -mx-1.5 cursor-text rounded-md px-1.5 py-0.5 hover:bg-hover/40',
          className
        )}
      >
        {value ? (children ?? value) : <span className="text-faint">{placeholder}</span>}
        <Pencil className="ml-1.5 inline size-3 text-faint opacity-0 transition-opacity group-hover/edit:opacity-100" />
      </div>
    )
  const common = {
    autoFocus: true,
    value: text,
    'aria-label': label,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setText(e.target.value),
    onBlur: () => void commit(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void commit()
      }
      if (e.key === 'Escape') {
        e.stopPropagation()
        cancelled.current = true
        setEditing(false)
      }
    }
  }
  return (
    <div className="flex items-start gap-2">
      {multiline ? (
        <AutoTextarea
          {...common}
          minRows={1}
          maxRows={6}
          className={cn('field min-w-0 flex-1', inputClassName)}
        />
      ) : (
        <input {...common} className={cn('field min-w-0 flex-1', inputClassName)} />
      )}
      <span className="pt-2">
        <Counter text={text} max={max} />
      </span>
    </div>
  )
}

function MemoryDetail({
  memory: m,
  cols,
  all,
  nav,
  onChanged
}: {
  memory: Memory
  cols: MemoryCollection[]
  all: Memory[]
  nav: Nav
  onChanged: () => void
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const chats = useStore((s) => s.chats)
  const openChat = useStore((s) => s.openChat)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [confirm, setConfirm] = useState(false)
  const [adding, setAdding] = useState('')
  const [editingFact, setEditingFact] = useState<number | null>(null)
  const col = cols.find((c) => c.id === m.collectionId)
  const supersedes = m.supersedesId ? all.find((x) => x.id === m.supersedesId) : undefined
  const supersededBy = all.find((x) => x.supersedesId === m.id)
  const chat = m.updatedByChatId ? chats.find((c) => c.id === m.updatedByChatId) : undefined
  const targets = moveTargets(m, cols)
  const colLabel = (id: string): string => {
    const c = cols.find((x) => x.id === id)
    return c ? c.name : 'coleção apagada'
  }

  const save = async (patch: MemoryPatch, label = 'Erro ao salvar a memória'): Promise<boolean> => {
    const r = await run(() => api.memory.update(m.id, patch), label)
    if (r) onChanged()
    return !!r
  }
  const setFacts = (facts: string[]): Promise<boolean> => save({ facts })
  const addFact = async (): Promise<void> => {
    const f = cleanField(adding, MEMORY_LIMITS.fact, true)
    if (f === null || !canAddFact(m.facts)) return
    if (await setFacts([...m.facts, f])) setAdding('')
  }

  return (
    <div data-testid="memory-detail" className="animate-fade-in">
      <BackLink onClick={() => (col ? nav.collection(col.id) : nav.home())}>
        {col ? col.name : 'Memórias'}
      </BackLink>

      <div className="flex items-start gap-2" onMouseLeave={() => setConfirm(false)}>
        <div className="min-w-0 flex-1">
          <InlineEdit
            value={m.title}
            max={MEMORY_LIMITS.title}
            required
            label="título"
            onSave={(title) => save({ title })}
            className="text-[17px] font-semibold tracking-tight"
            inputClassName="h-9 text-[15px] font-semibold"
          />
        </div>
        {confirm ? (
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void run(async () => {
                await api.memory.delete(m.id)
                onChanged()
                if (col) nav.collection(col.id)
                else nav.home()
              }, 'Erro ao apagar a memória')
            }
          >
            Apagar memória?
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="hover:text-danger"
            icon={<Trash2 className="size-3.5" />}
            onClick={() => setConfirm(true)}
          >
            Apagar
          </Button>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-subtle">
        <span data-testid="memory-updated">
          Última atualização: {memoryDate(m.updatedAt)} · {UPDATED_BY_LABEL[m.updatedBy]}
        </span>
        {m.updatedByChatId && (
          <>
            <span className="text-faint">·</span>
            {chat ? (
              <button
                type="button"
                onClick={() => {
                  setSettingsOpen(false)
                  void openChat(chat.id)
                }}
                className="inline-flex items-center gap-0.5 text-accent-strong hover:underline"
              >
                em “{chat.title || 'Novo chat'}” <ArrowUpRight className="size-3" />
              </button>
            ) : (
              <span className="text-faint">em um chat apagado</span>
            )}
          </>
        )}
      </div>

      {(supersedes || supersededBy || m.supersedesId) && (
        <div className="mt-2 space-y-1 text-[12px]">
          {m.supersedesId && (
            <p data-testid="memory-supersedes" className="text-subtle">
              Substitui:{' '}
              {supersedes ? (
                <button
                  type="button"
                  onClick={() => nav.memory(supersedes.id)}
                  className="text-accent-strong hover:underline"
                >
                  {supersedes.title}
                </button>
              ) : (
                <span className="text-faint">memória apagada</span>
              )}
              {supersedes && (
                <span className="text-faint"> · em {colLabel(supersedes.collectionId)}</span>
              )}
            </p>
          )}
          {supersededBy && (
            <p data-testid="memory-superseded-by" className="text-subtle">
              Substituída por:{' '}
              <button
                type="button"
                onClick={() => nav.memory(supersededBy.id)}
                className="text-accent-strong hover:underline"
              >
                {supersededBy.title}
              </button>
              <span className="text-faint">
                {' '}
                · em {colLabel(supersededBy.collectionId)} — onde as duas coleções estão ativas, o
                modelo vê só a substituta
              </span>
            </p>
          )}
        </div>
      )}

      <DetailLabel>Resumo</DetailLabel>
      <InlineEdit
        value={m.summary}
        max={MEMORY_LIMITS.summary}
        label="resumo"
        multiline
        placeholder="Sem resumo — clique para escrever"
        onSave={(summary) => save({ summary })}
        className="text-[13px] leading-relaxed text-fg/90"
        inputClassName="text-[13px] leading-relaxed"
      >
        <MemoryText text={m.summary} all={all} onOpen={nav.memory} />
      </InlineEdit>

      <DetailLabel
        aside={
          <span
            data-testid="memory-facts-count"
            className={cn(
              'text-[10.5px] tabular-nums',
              canAddFact(m.facts) ? 'text-faint' : 'text-warning/90'
            )}
          >
            {m.facts.length}/{MEMORY_LIMITS.facts}
          </span>
        }
      >
        Detalhes
      </DetailLabel>
      <ul data-testid="memory-facts" className="space-y-0.5">
        {m.facts.map((f, i) => (
          <li key={`${i}:${f}`} className="group/fact flex items-start gap-2">
            <span className="mt-[9px] size-1 shrink-0 rounded-full bg-muted" />
            <div className="min-w-0 flex-1">
              {editingFact === i ? (
                <FactEditor
                  initial={f}
                  onCancel={() => setEditingFact(null)}
                  onSave={async (v) => {
                    if (await setFacts(replaceFact(m.facts, i, v))) setEditingFact(null)
                  }}
                />
              ) : (
                <p
                  className="cursor-text rounded-md px-1 py-0.5 text-[13px] leading-relaxed text-fg/90 hover:bg-hover/40"
                  onClick={() => setEditingFact(i)}
                >
                  <MemoryText text={f} all={all} onOpen={nav.memory} />
                </p>
              )}
            </div>
            {editingFact !== i && (
              <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/fact:opacity-100 focus-within:opacity-100">
                <FactBtn
                  label="Subir"
                  disabled={i === 0}
                  onClick={() => void setFacts(moveFact(m.facts, i, -1))}
                >
                  <ArrowUp />
                </FactBtn>
                <FactBtn
                  label="Descer"
                  disabled={i === m.facts.length - 1}
                  onClick={() => void setFacts(moveFact(m.facts, i, 1))}
                >
                  <ArrowDown />
                </FactBtn>
                <FactBtn label="Editar" onClick={() => setEditingFact(i)}>
                  <Pencil />
                </FactBtn>
                <FactBtn
                  label="Remover"
                  danger
                  onClick={() => void setFacts(removeFact(m.facts, i))}
                >
                  <X />
                </FactBtn>
              </div>
            )}
          </li>
        ))}
        {m.facts.length === 0 && (
          <li className="px-1 text-[12.5px] text-faint">Nenhum detalhe ainda.</li>
        )}
      </ul>
      {canAddFact(m.facts) ? (
        <form
          className="mt-1.5 flex items-center gap-2 pl-3"
          onSubmit={(e) => {
            e.preventDefault()
            void addFact()
          }}
        >
          <Plus className="size-3.5 shrink-0 text-faint" />
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Adicionar detalhe — use [[slug]] para citar outra memória"
            aria-label="Novo detalhe"
            className="field h-7 min-w-0 flex-1 px-2 py-0 text-[12.5px]"
          />
          {adding && <Counter text={adding} max={MEMORY_LIMITS.fact} />}
        </form>
      ) : (
        <p className="mt-1.5 pl-3 text-[11.5px] text-subtle">
          Limite de {MEMORY_LIMITS.facts} detalhes — junte ou remova algum para adicionar.
        </p>
      )}

      <div className="mt-5 space-y-3 border-t border-border/70 pt-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[13px] text-fg/90">
              Sempre carregar
              <HelpTip label="Sempre carregar">
                Vai no índice com os detalhes completos (não só título e resumo)
              </HelpTip>
            </div>
          </div>
          <Switch
            checked={m.pinned}
            label="Sempre carregar"
            onChange={(pinned) => void save({ pinned })}
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[13px] text-fg/90">
              Coleção
              <HelpTip label="Coleção">Mover só entre coleções da mesma categoria.</HelpTip>
            </div>
            <p className="mt-0.5 text-[11.5px] text-subtle">{MEMORY_CATEGORY_LABELS[m.category]}</p>
          </div>
          <Select<string>
            label="Mover para a coleção"
            value={m.collectionId}
            className="h-8 w-[190px] text-[12.5px]"
            menuMinWidth={220}
            onChange={(collectionId) =>
              collectionId !== m.collectionId &&
              void save({ collectionId }, 'Erro ao mover a memória')
            }
            options={[...(col ? [col] : []), ...targets].map((c) => ({
              value: c.id,
              label: c.name,
              description: c.id === m.collectionId ? 'atual' : undefined
            }))}
          />
        </div>
      </div>
    </div>
  )
}

function DetailLabel({
  children,
  aside
}: {
  children: ReactNode
  aside?: ReactNode
}): React.JSX.Element {
  return (
    <div className="mt-5 mb-1.5 flex items-center gap-2">
      <span className="text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
        {children}
      </span>
      {aside && <span className="ml-auto">{aside}</span>}
    </div>
  )
}

function FactBtn({
  label,
  onClick,
  disabled,
  danger,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'grid size-6 place-items-center rounded-md text-subtle hover:bg-hover disabled:opacity-30 [&_svg]:size-3',
          danger ? 'hover:text-danger' : 'hover:text-fg'
        )}
      >
        {children}
      </button>
    </Tip>
  )
}

function FactEditor({
  initial,
  onSave,
  onCancel
}: {
  initial: string
  onSave: (v: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initial)
  const v = cleanField(text, MEMORY_LIMITS.fact, true)
  return (
    <div className="flex items-start gap-2">
      <AutoTextarea
        autoFocus
        value={text}
        aria-label="Editar detalhe"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (v !== null) onSave(v)
          }
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
        minRows={1}
        maxRows={5}
        className="field min-w-0 flex-1 py-1 text-[13px] leading-relaxed"
      />
      <span className="flex shrink-0 flex-col items-end gap-1 pt-1.5">
        <Counter text={text} max={MEMORY_LIMITS.fact} />
        <span className="flex gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="text-[11px] text-subtle hover:text-fg"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={v === null}
            onClick={() => v !== null && onSave(v)}
            className="text-[11px] text-accent-strong hover:underline disabled:opacity-40"
          >
            Salvar
          </button>
        </span>
      </span>
    </div>
  )
}
