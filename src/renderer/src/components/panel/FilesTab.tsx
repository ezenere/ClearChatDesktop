import {
  ChevronRight,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderRoot,
  House,
  MonitorSmartphone,
  RefreshCw,
  WifiOff
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Chat, DirEntry } from '@shared/types'
import { api } from '../../lib/api'
import { contributeCtx } from '../../lib/contextMenu'
import { resourceActions, sourcesFor } from '../../lib/fileSources'
import { cn, compactPath, formatBytes } from '../../lib/format'
import { useStore } from '../../store'
import { Button, IconButton, Spinner } from '../ui/controls'
import { Modal } from '../ui/layers'
import { RootInfo } from '../apiDocs'
import { useHostInfo } from '../sync/hooks'
import { fileIcon } from '../viewer/fileIcons'

function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

function crumbs(path: string, home: string | null): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = []
  let base = ''
  let rest = path
  if (home && (path === home || path.startsWith(home + '/'))) {
    out.push({ label: '~', path: home })
    base = home
    rest = path.slice(home.length)
  } else {
    out.push({ label: '/', path: '/' })
  }
  for (const seg of rest.split('/').filter(Boolean)) {
    base = `${base}/${seg}`
    out.push({ label: seg, path: base })
  }
  return out
}

/** Breadcrumb a partir do diretório raiz (nunca acima dele). */
function rootCrumbs(path: string, root: string): { label: string; path: string }[] {
  const name = root.split('/').filter(Boolean).pop() ?? '/'
  const out = [{ label: name, path: root }]
  if (path === root || !path.startsWith(root === '/' ? '/' : root + '/')) return out
  let base = root
  for (const seg of path.slice(root.length).split('/').filter(Boolean)) {
    base = base === '/' ? `/${seg}` : `${base}/${seg}`
    out.push({ label: seg, path: base })
  }
  return out
}

const insideRoot = (p: string, root: string): boolean =>
  p === root || p.startsWith(root === '/' ? '/' : root + '/')

/** Formulário inline "Nova pasta…": cria `parent/nome`. */
export function NewFolderForm({
  parent,
  onCreated,
  onCancel
}: {
  parent: string
  onCreated: (path: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const homeDir = useStore((s) => s.homeDir)
  const run = useStore((s) => s.run)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = !!name.trim() && !/[/\\]/.test(name) && name.trim() !== '.' && name.trim() !== '..'
  const create = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    const p = await run(() => api.fs.mkdir(join(parent, name.trim())), 'Erro ao criar pasta')
    setBusy(false)
    if (p) onCreated(p)
  }
  return (
    <div className="animate-fade-in rounded-lg border border-border bg-bg/50 p-2.5">
      <div className="mb-1.5 truncate text-[11px] text-subtle" title={parent}>
        Nova pasta em <span className="font-mono">{compactPath(parent, homeDir, 40)}</span>
      </div>
      <div className="flex gap-2">
        <input
          autoFocus
          value={name}
          placeholder="nome-do-projeto"
          aria-label="Nome da nova pasta"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void create()
            }
            if (e.key === 'Escape') {
              e.stopPropagation()
              onCancel()
            }
          }}
          className="field h-7 min-w-0 flex-1 px-2 py-0 font-mono text-[12px]"
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!valid}
          loading={busy}
          onClick={() => void create()}
        >
          Criar
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

/** Nome válido para renomear (um segmento, sem barras, nem "." nem ".."). */
const validName = (n: string): boolean =>
  // eslint-disable-next-line no-control-regex
  !!n.trim() && !/[/\\\u0000]/.test(n) && n.trim() !== '.' && n.trim() !== '..'

/** Campo inline de "Renomear" no lugar do nome (Enter/fora salva, Esc cancela). */
function RenameField({
  entry,
  onDone
}: {
  entry: DirEntry
  onDone: (name: string | null) => void
}): React.JSX.Element {
  const [name, setName] = useState(entry.name)
  const commit = (): void =>
    onDone(validName(name) && name.trim() !== entry.name ? name.trim() : null)
  return (
    <input
      autoFocus
      value={name}
      aria-label={`Novo nome de ${entry.name}`}
      data-testid="files-rename-input"
      onFocus={(e) => {
        // seleciona só o nome, sem a extensão (como os gerenciadores de arquivo)
        const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.')
        e.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
      }}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onDone(null)
        }
      }}
      className={cn(
        'h-6 min-w-0 flex-1 rounded-md bg-bg px-1.5 font-mono text-[12px] outline-none ring-1',
        validName(name) ? 'ring-accent/50' : 'ring-danger/60'
      )}
    />
  )
}

export function FilesTab({ chat }: { chat: Chat }): React.JSX.Element {
  const homeDir = useStore((s) => s.homeDir)
  const patchConfig = useStore((s) => s.patchConfig)
  const run = useStore((s) => s.run)
  const tick = useStore((s) => s.fsTick[chat.id] ?? 0)
  // fonte da listagem: local, ou a do HOST no controle remoto (lib/fileSources → remoteFiles)
  const host = useHostInfo(chat.id)
  const dirSource = sourcesFor(chat.id, host?.mode).dir
  const remoteMode = dirSource.id === 'remote'
  // controle remoto: raiz e confinamento são os do chat NO HOST (vêm com a listagem)
  const [remoteRoot, setRemoteRoot] = useState<{ root: string; confine: boolean } | null>(null)
  const root = remoteMode ? (remoteRoot?.root ?? host?.hostCwd?.path ?? '') : chat.config.cwd
  const confine = remoteMode ? (remoteRoot?.confine ?? true) : chat.config.confineToRoot !== false
  const [dir, setDir] = useState(root)
  const [reload, setReload] = useState(0)
  const [creating, setCreating] = useState(false)
  const [listing, setListing] = useState<{
    dir: string
    entries?: DirEntry[]
    error?: string
    offline?: boolean
    truncated?: boolean
  } | null>(null)
  const active = useStore((s) => s.viewer[chat.id])
  const openFile = useStore((s) => s.openFile)
  const mentionFile = useStore((s) => s.mentionFile)
  const fileMoved = useStore((s) => s.fileMoved)
  // clique num `@pasta/` de uma mensagem: a aba vem até a pasta pedida
  const nav = useStore((s) => s.filesNav[chat.id])
  const [navSeen, setNavSeen] = useState(nav?.n ?? 0)
  if (nav && nav.n !== navSeen) {
    setNavSeen(nav.n)
    setDir(nav.dir)
  }
  /** Entrada em "Renomear" (campo inline) / pedindo confirmação para excluir. */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<DirEntry | null>(null)
  const [busyDelete, setBusyDelete] = useState(false)
  const [prevRoot, setPrevRoot] = useState(root)
  if (prevRoot !== root) {
    setPrevRoot(root)
    setDir(root)
  }
  const [prevMode, setPrevMode] = useState(remoteMode)
  if (prevMode !== remoteMode) {
    setPrevMode(remoteMode)
    setRemoteRoot(null)
  }
  // Confinado: a navegação nunca sobe acima da raiz.
  const shownDir = confine && !insideRoot(dir, root) ? root : dir
  // remota sem a raiz do host ainda: pede '' (o host responde com a raiz dele)
  const requestDir = remoteMode && !remoteRoot ? '' : shownDir

  useEffect(() => {
    const ctl = new AbortController()
    void dirSource.listDir(chat.id, requestDir, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      if (r.ok && r.root !== undefined && dirSource.id === 'remote')
        setRemoteRoot((cur) =>
          cur && cur.root === r.root && cur.confine === (r.confine !== false)
            ? cur
            : { root: r.root!, confine: r.confine !== false }
        )
      setListing(
        r.ok
          ? {
              dir: requestDir === '' && r.root !== undefined ? r.dir : requestDir,
              entries: r.entries,
              truncated: r.truncated
            }
          : { dir: requestDir, error: r.message, offline: r.reason === 'host-offline' }
      )
    })
    return () => ctl.abort()
  }, [requestDir, tick, reload, dirSource, chat.id])
  const current =
    listing?.dir === requestDir || (remoteMode && listing?.dir === shownDir) ? listing : null
  const entries = current?.entries ?? null
  const error = current?.error ?? null
  const offline = !!current?.offline

  const sorted = useMemo(
    () =>
      entries
        ? [...entries].sort((a, b) =>
            a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
          )
        : [],
    [entries]
  )

  /** Clique: abre no painel de arquivo (vira o arquivo ativo do chat). */
  const openInViewer = (e: DirEntry, path: string): void =>
    openFile(chat.id, { chatId: chat.id, source: 'browse', path }, path, e.name)
  /**
   * Duplo clique: abre no app padrão do sistema (remoto: cópia temporária); executável deste
   * sistema → "Executar…" (confirmação no main); de outro sistema → só avisa.
   */
  const openInApp = async (path: string): Promise<void> => {
    const fileSource = sourcesFor(chat.id, host?.mode).file
    if (!fileSource.capabilities.openNative) return
    const r = await fileSource.open({ chatId: chat.id, source: 'browse', path })
    if (!r.ok) {
      useStore.getState().toast(r.message, 'error')
      return
    }
    const acts = resourceActions(fileSource, r.resource)
    const open = acts.run ?? acts.openExternal
    if (open) await run(() => open(), 'Não foi possível abrir o arquivo')
    else if (acts.note) useStore.getState().toast(acts.note, 'info')
    r.resource.dispose()
  }

  const pick = async (): Promise<void> => {
    const d = await run(() => api.fs.pickDirectory(), 'Erro ao escolher pasta')
    if (d) {
      patchConfig(chat.id, { cwd: d })
      setDir(d)
    }
  }

  const parts = confine ? rootCrumbs(shownDir, root) : crumbs(shownDir, homeDir)

  /** Renomear: confinamento e "já existe" no main; o painel de arquivo e o chip acompanham. */
  const rename = async (e: DirEntry, path: string, name: string | null): Promise<void> => {
    setRenaming(null)
    if (!name) return
    const to = await run(
      () => api.fs.rename(chat.id, path, name),
      `Não foi possível renomear ${e.name}`
    )
    if (to) fileMoved(chat.id, path, to)
  }
  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    const path = deleting.path
    setBusyDelete(true)
    const r = await run(
      () => api.fs.remove(chat.id, path),
      `Não foi possível excluir ${deleting.name}`
    )
    setBusyDelete(false)
    setDeleting(null)
    if (r) fileMoved(chat.id, path, null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-3 border-b border-border/70 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-wide whitespace-nowrap text-accent-strong">
            RAIZ
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg/90" title={root}>
            {compactPath(root, homeDir, 34)}
          </span>
          <RootInfo side="left" />
          <IconButton label="Recarregar" size="xs" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw />
          </IconButton>
        </div>
        {remoteMode ? (
          <div
            data-testid="files-remote"
            className="flex items-center gap-1.5 text-[11.5px] text-subtle"
          >
            <MonitorSmartphone className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              Arquivos do {host?.host?.name ?? 'host'} — clique para visualizar (baixa pelo sync)
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              disabled={shownDir === root}
              icon={<FolderInput className="size-3.5" />}
              onClick={() => patchConfig(chat.id, { cwd: shownDir })}
            >
              Usar como raiz
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="flex-1"
              icon={<FolderOpen className="size-3.5" />}
              onClick={() => void pick()}
            >
              Escolher pasta…
            </Button>
            <IconButton
              label="Nova pasta…"
              size="sm"
              active={creating}
              onClick={() => setCreating((v) => !v)}
            >
              <FolderPlus />
            </IconButton>
          </div>
        )}
        {creating && !remoteMode && (
          <NewFolderForm
            parent={shownDir}
            onCancel={() => setCreating(false)}
            onCreated={(p) => {
              setCreating(false)
              setDir(p)
              setReload((n) => n + 1)
            }}
          />
        )}
      </div>

      <nav className="flex shrink-0 flex-wrap items-center gap-0.5 px-3 py-2 text-[12px]">
        {parts.map((p, i) => (
          <span key={p.path} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight className="size-3 text-faint" />}
            <button
              type="button"
              onClick={() => setDir(p.path)}
              title={p.path}
              className={cn(
                'flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover',
                i === parts.length - 1 ? 'font-medium text-fg' : 'text-subtle hover:text-fg'
              )}
            >
              {confine && i === 0 ? (
                <>
                  <FolderRoot className="size-3 text-accent-strong/80" />
                  {p.label}
                </>
              ) : p.label === '~' ? (
                <House className="size-3" />
              ) : (
                p.label
              )}
            </button>
          </span>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!entries && !error && (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-subtle">
            <Spinner /> Carregando…
          </div>
        )}
        {error &&
          (offline ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-subtle">
              <WifiOff className="size-3.5" /> Host offline — {error}
            </div>
          ) : (
            <div className="px-2 py-2 text-xs text-danger">{error}</div>
          ))}
        {entries && sorted.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-subtle">Pasta vazia</div>
        )}
        {current?.truncated && (
          <div className="px-2 py-1.5 text-[11px] text-subtle">
            Pasta grande: mostrando só as primeiras {sorted.length} entradas.
          </div>
        )}
        {sorted.map((e) => {
          const path = e.path || join(shownDir, e.name)
          const isActive = !e.isDir && active?.path === path
          const { icon: FIcon } = fileIcon(e.name)
          const icon = e.isDir ? (
            <Folder
              className="size-3.5 shrink-0 text-accent-strong/70"
              fill="currentColor"
              fillOpacity={0.15}
            />
          ) : (
            <FIcon className={cn('size-3.5 shrink-0', isActive ? 'text-fg/80' : 'text-subtle')} />
          )
          if (renaming === path)
            return (
              <div
                key={path}
                data-testid="files-entry"
                data-renaming="true"
                className="flex h-7 w-full items-center gap-2 rounded-md bg-active px-2"
              >
                {icon}
                <RenameField entry={e} onDone={(name) => void rename(e, path, name)} />
              </div>
            )
          return (
            <button
              key={path}
              type="button"
              data-testid="files-entry"
              data-path={path}
              aria-current={isActive ? 'true' : undefined}
              title={
                e.isDir
                  ? undefined
                  : `${e.name} — clique para visualizar, duplo clique abre no app${remoteMode ? ' (baixa do host)' : ''}`
              }
              onClick={() => (e.isDir ? setDir(path) : openInViewer(e, path))}
              onDoubleClick={() => !e.isDir && void openInApp(path)}
              onContextMenu={(ev) =>
                // botão direito: mencionar no chat (arquivos), copiar caminho e — só com os arquivos
                // neste dispositivo (sem comando do protocolo para o host) — renomear / excluir
                contributeCtx(ev, {
                  copy: { fileCopyPath: path },
                  run: {
                    ...(e.isDir ? {} : { fileMention: () => mentionFile(chat.id, path, e.name) }),
                    ...(remoteMode
                      ? {}
                      : {
                          fileRename: () => setRenaming(path),
                          fileDelete: () => setDeleting({ ...e, path })
                        })
                  }
                })
              }
              className={cn(
                'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px]',
                isActive ? 'bg-active text-fg' : 'hover:bg-hover'
              )}
            >
              {icon}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  isActive ? 'text-fg' : e.isDir ? 'text-fg/90' : 'text-fg/75',
                  e.name.startsWith('.') && 'opacity-60'
                )}
              >
                {e.name}
              </span>
              {!e.isDir && (
                <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
                  {formatBytes(e.size)}
                </span>
              )}
            </button>
          )
        })}
      </div>
      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={deleting.isDir ? 'Excluir pasta?' : 'Excluir arquivo?'}
          width={460}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                loading={busyDelete}
                data-testid="files-delete-confirm"
                onClick={() => void confirmDelete()}
              >
                Excluir
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-muted" data-testid="files-delete-text">
            <span className="font-mono text-fg">{deleting.name}</span>
            {deleting.isDir ? ' e tudo o que está dentro dela' : ''} vai para a lixeira do sistema
            (dá para restaurar por lá).
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-faint" title={deleting.path}>
            {deleting.path}
          </p>
        </Modal>
      )}
    </div>
  )
}
