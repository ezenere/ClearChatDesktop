// Painel de arquivo — coluna entre o chat e o painel de configurações: [LISTA | CHAT | ARQUIVO |
// CONFIGS]. Mostra o arquivo ativo do chat (present_file / aba Arquivos) com a fonte de bytes do
// chat (lib/fileSources: local; remota no controle remoto — baixa do host com progresso, sem
// "Mostrar na pasta", com "Salvar como…"; trocar de arquivo/chat cancela). Ações pela extensão +
// sistema (resourceActions): executável deste sistema → "Executar…" (confirmação no main); de
// outro sistema → só "Mostrar na pasta" / "Salvar como…" + nota. Divisor redimensionável
// (arrastar, ←/→, Home/End, duplo clique = padrão), fechar (X / Esc com o foco no painel).
// Ver SPEC → "Visualizador de arquivos (present_file)".
import {
  CircleAlert,
  Copy,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  Maximize,
  MonitorSmartphone,
  Play,
  RefreshCw,
  ShieldAlert,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { Chat } from '@shared/types'
import type { ViewerText } from '@shared/ipc'
import { VIEWER_LIMITS } from '@shared/fileViewer'
import { cn, formatBytes } from '../../lib/format'
import {
  resourceActions,
  sourcesFor,
  type FileOpenResult,
  type ViewerResource
} from '../../lib/fileSources'
import { errorMessage } from '../../lib/api'
import { useStore, VIEWER_DEFAULT_WIDTH, type ActiveFile } from '../../store'
import { useHostInfo } from '../sync/hooks'
import { Button, IconButton, Spinner, Switch } from '../ui/controls'
import { Tip } from '../ui/Tooltip'
import { Markdown } from '../chat/Markdown'
import { contributeCtx } from '../../lib/contextMenu'
import { fileIcon } from './fileIcons'
import { stepZoom, VIEWER_MIN_WIDTH } from './viewerLayout'

/** null = ajustar (imagem/PDF: cabe no painel); número = escala (1 = 100%). */
type Zoom = number | null

// ---------------- divisor ----------------

function Splitter({
  width,
  min,
  max,
  onChange
}: {
  width: number
  min: number
  max: number
  onChange: (w: number, persist: boolean) => void
}): React.JSX.Element {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const clamp = (w: number): number => Math.round(Math.min(max, Math.max(min, w)))
  const onKey = (e: ReactKeyboardEvent): void => {
    const step = e.shiftKey ? 64 : 16
    let next: number | null = null
    // o painel fica à direita do divisor: ← alarga, → estreita
    if (e.key === 'ArrowLeft') next = width + step
    else if (e.key === 'ArrowRight') next = width - step
    else if (e.key === 'Home') next = max
    else if (e.key === 'End') next = min
    if (next == null) return
    e.preventDefault()
    onChange(clamp(next), true)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionar painel de arquivo"
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid="viewer-splitter"
      onKeyDown={onKey}
      onDoubleClick={() => onChange(clamp(VIEWER_DEFAULT_WIDTH), true)}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: width }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        onChange(clamp(drag.current.w + (drag.current.x - e.clientX)), false)
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        onChange(clamp(width), true)
      }}
      className="group/split absolute inset-y-0 -left-1 z-10 flex w-2 cursor-col-resize justify-center outline-none"
    >
      <span className="h-full w-px bg-transparent transition-colors group-hover/split:bg-accent/50 group-focus-visible/split:bg-accent" />
    </div>
  )
}

// ---------------- conteúdo ----------------

/** Texto do recurso (markdown/código/texto). */
function useText(resource: ViewerResource): { text: ViewerText | null; error: string | null } {
  const [state, setState] = useState<{ text: ViewerText | null; error: string | null }>({
    text: null,
    error: null
  })
  useEffect(() => {
    const ctl = new AbortController()
    resource
      .readText(ctl.signal)
      .then((text) => !ctl.signal.aborted && setState({ text, error: null }))
      .catch((e) => !ctl.signal.aborted && setState({ text: null, error: errorMessage(e) }))
    return () => ctl.abort()
  }, [resource])
  return state
}

function TruncatedNote({ size, onOpen }: { size: number; onOpen?: () => void }): React.JSX.Element {
  return (
    <div
      data-testid="viewer-truncated"
      className="sticky top-0 z-[1] flex items-center gap-2 border-b border-warning/20 bg-[#1a1610] px-4 py-2 text-[11.5px] text-warning/90"
    >
      <CircleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Arquivo grande ({formatBytes(size)}): mostrando só os primeiros{' '}
        {formatBytes(VIEWER_LIMITS.textMaxBytes)}.
      </span>
      {onOpen && (
        <Button size="sm" variant="ghost" onClick={onOpen}>
          Abrir no app
        </Button>
      )}
    </div>
  )
}

function CodeView({ text, language }: { text: string; language?: string }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!language || text.length > VIEWER_LIMITS.highlightMaxChars) return
    void import('highlight.js/lib/common').then(({ default: hljs }) => {
      if (!alive || !hljs.getLanguage(language)) return
      // highlight.js escapa o texto: o HTML só contém os <span class="hljs-…"> dele
      setHtml(hljs.highlight(text, { language, ignoreIllegals: true }).value)
    })
    return () => {
      alive = false
    }
  }, [text, language])
  return (
    <pre className="hljs min-w-max !bg-transparent px-4 py-3 font-mono text-[12.5px] leading-[1.6]">
      {html != null ? (
        <code data-testid="viewer-code" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code data-testid="viewer-code">{text}</code>
      )}
    </pre>
  )
}

function TextKinds({
  resource,
  zoom,
  onOpenExternal
}: {
  resource: ViewerResource
  zoom: number
  onOpenExternal?: () => void
}): React.JSX.Element {
  const { text, error } = useText(resource)
  const { kind, language } = resource.info
  const resolveImage = useCallback((src: string) => resource.assetUrl(src), [resource])
  if (error)
    return <Problem icon={CircleAlert} title="Não foi possível ler o arquivo" text={error} />
  if (!text) return <Loading />
  const asMarkdown = kind === 'markdown' && text.content.length <= VIEWER_LIMITS.markdownMaxChars
  return (
    <div className="min-h-full">
      {text.truncated && <TruncatedNote size={text.size} onOpen={onOpenExternal} />}
      <div style={{ zoom }} data-testid="viewer-zoomable">
        {asMarkdown ? (
          <div className="mx-auto max-w-[820px] px-6 py-5">
            <Markdown text={text.content} resolveImage={resolveImage} />
          </div>
        ) : kind === 'code' ? (
          <CodeView text={text.content} language={language} />
        ) : (
          <pre
            data-testid="viewer-text"
            className="px-4 py-3 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap text-fg/85"
          >
            {text.content}
          </pre>
        )}
      </div>
    </div>
  )
}

/** Imagem: ajustar (padrão) ou escala; arrastar move quando maior que o painel. */
function ImageView({
  url,
  name,
  zoom,
  onZoom,
  onFitScale
}: {
  url: string
  name: string
  zoom: Zoom
  onZoom: (z: Zoom) => void
  /** Escala real no modo Ajustar (o +/− partem dela). */
  onFitScale: (scale: number) => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const pan = useRef<{ x: number; y: number; l: number; t: number } | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el || zoom != null || !natural) return
    const measure = (): void => {
      const img = el.querySelector('img')
      if (img && natural.w) onFitScale(img.clientWidth / natural.w)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [zoom, natural, onFitScale])
  if (failed)
    return <Problem icon={CircleAlert} title="Não foi possível mostrar a imagem" text={name} />
  return (
    <div
      ref={box}
      data-testid="viewer-image-box"
      className={cn(
        'h-full w-full overflow-auto bg-[repeating-conic-gradient(#15151b_0_25%,#101015_0_50%)] bg-[length:20px_20px]',
        zoom != null && 'cursor-grab active:cursor-grabbing'
      )}
      onWheel={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return
        e.preventDefault()
        const cur =
          zoom ??
          (natural ? (box.current?.querySelector('img')?.clientWidth ?? natural.w) / natural.w : 1)
        onZoom(stepZoom(cur, e.deltaY < 0 ? 1 : -1))
      }}
      onPointerDown={(e) => {
        const el = box.current
        if (zoom == null || !el || e.button !== 0) return
        pan.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const el = box.current
        if (!pan.current || !el) return
        el.scrollLeft = pan.current.l - (e.clientX - pan.current.x)
        el.scrollTop = pan.current.t - (e.clientY - pan.current.y)
      }}
      onPointerUp={() => (pan.current = null)}
    >
      <div
        className={cn(
          'flex min-h-full min-w-full',
          zoom == null ? 'h-full items-center justify-center' : 'w-max items-start'
        )}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          data-testid="viewer-image"
          onLoad={(e) => {
            const img = e.currentTarget
            setNatural({ w: img.naturalWidth, h: img.naturalHeight })
            if (zoom == null && img.naturalWidth) onFitScale(img.clientWidth / img.naturalWidth)
          }}
          onError={() => setFailed(true)}
          className={cn('select-none', zoom == null && 'max-h-full max-w-full object-contain')}
          style={
            zoom != null && natural
              ? { width: natural.w * zoom, height: natural.h * zoom, maxWidth: 'none' }
              : undefined
          }
        />
      </div>
    </div>
  )
}

/** HTML: iframe isolado (sandbox SEM allow-same-origin → origem opaca); scripts só com o toggle. */
function HtmlView({
  url,
  name,
  zoom,
  scripts
}: {
  url: string
  name: string
  zoom: number
  scripts: boolean
}): React.JSX.Element {
  return (
    <div className="h-full w-full overflow-hidden bg-white">
      <iframe
        key={scripts ? 'js' : 'nojs'}
        data-testid="viewer-html"
        title={name}
        src={url}
        sandbox={scripts ? 'allow-scripts' : ''}
        referrerPolicy="no-referrer"
        className="origin-top-left border-0"
        style={{
          width: `${100 / zoom}%`,
          height: `${100 / zoom}%`,
          transform: `scale(${zoom})`
        }}
      />
    </div>
  )
}

/** PDF: visualizador nativo do Chromium (páginas, zoom, busca). Zoom da barra = parâmetros do PDF. */
function PdfView({
  url,
  name,
  zoom
}: {
  url: string
  name: string
  zoom: Zoom
}): React.JSX.Element {
  const frag = zoom == null ? '#view=Fit' : `#zoom=${Math.round(zoom * 100)}`
  return (
    <iframe
      key={frag}
      data-testid="viewer-pdf"
      title={name}
      src={url + frag}
      className="h-full w-full border-0 bg-[#525659]"
    />
  )
}

function Loading({
  label = 'Carregando…',
  progress
}: {
  label?: string
  /** 0..1 (download do host em pedaços); ausente = só o spinner. */
  progress?: number
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 text-xs text-subtle">
      <div className="flex items-center gap-2">
        <Spinner /> {label}
      </div>
      {progress != null && (
        <div
          role="progressbar"
          aria-label="Baixando do host"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          data-testid="viewer-progress"
          className="h-1 w-48 overflow-hidden rounded-full bg-border/70"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }}
          />
        </div>
      )}
    </div>
  )
}

function Problem({
  icon: Icon,
  title,
  text,
  children
}: {
  icon: typeof CircleAlert
  title: string
  text?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="viewer-problem"
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <Icon className="size-6 text-subtle" />
      <div className="text-[13px] font-medium text-fg/90">{title}</div>
      {text && <div className="max-w-[340px] text-xs break-words text-subtle">{text}</div>}
      {children && <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  )
}

/**
 * Tipo sem visualização: nome, tamanho, tipo + "Mostrar local…" / "Salvar como…" / "Abrir arquivo"
 * ou "Executar…" (executável deste sistema); executável de outro sistema → a nota, sem abrir/rodar.
 */
function Unsupported({
  resource,
  onFolder,
  onSaveAs,
  onExternal,
  onRun,
  note
}: {
  resource: ViewerResource
  onFolder?: () => void
  onSaveAs?: () => void
  onExternal?: () => void
  onRun?: () => void
  note?: string
}): React.JSX.Element {
  const { name, size, typeLabel } = resource.info
  const { icon: Icon, tone } = fileIcon(name, 'binary')
  return (
    <div
      data-testid="viewer-unsupported"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <span className="flex size-14 items-center justify-center rounded-2xl border border-border bg-elevated">
        <Icon className={cn('size-7', tone)} />
      </span>
      <div className="max-w-full">
        <div className="truncate text-[14px] font-medium text-fg/95">{name}</div>
        <div className="mt-0.5 text-xs text-subtle">
          {typeLabel} · {formatBytes(size)}
        </div>
        <div className="mt-2 text-xs text-faint">
          Este tipo de arquivo não tem pré-visualização.
        </div>
        {note && (
          <div
            data-testid="viewer-exec-note"
            className="mt-2 flex items-center justify-center gap-1 text-xs text-warning/85"
          >
            <ShieldAlert className="size-3.5 shrink-0" /> {note}
          </div>
        )}
      </div>
      <div className="mt-1 flex flex-col gap-2">
        {onFolder && (
          <Button icon={<FolderOpen className="size-3.5" />} onClick={onFolder}>
            Mostrar local do arquivo no explorador
          </Button>
        )}
        {onSaveAs && (
          <Button icon={<Download className="size-3.5" />} onClick={onSaveAs}>
            Salvar como…
          </Button>
        )}
        {onExternal && (
          <Button
            variant="primary"
            icon={<ExternalLink className="size-3.5" />}
            onClick={onExternal}
          >
            Abrir arquivo
          </Button>
        )}
        {onRun && (
          <Button variant="primary" icon={<Play className="size-3.5" />} onClick={onRun}>
            Executar…
          </Button>
        )}
      </div>
    </div>
  )
}

function CopyPath({ path }: { path: string }): React.JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      label={done ? 'Copiado' : 'Copiar caminho'}
      size="xs"
      onClick={() =>
        void navigator.clipboard.writeText(path).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }
    >
      {done ? <Check className="text-success" /> : <Copy />}
    </IconButton>
  )
}

// ---------------- painel ----------------

export function FileViewerPane({
  chat,
  file,
  maxWidth
}: {
  chat: Chat
  file: ActiveFile
  /** Largura máxima disponível (o chat mantém um mínimo). */
  maxWidth: number
}): React.JSX.Element {
  const width = useStore((s) => s.viewerWidth)
  const setWidth = useStore((s) => s.setViewerWidth)
  const closeFile = useStore((s) => s.closeFile)
  const reloadFile = useStore((s) => s.reloadFile)
  const mentionFile = useStore((s) => s.mentionFile)
  const run = useStore((s) => s.run)
  const host = useHostInfo(chat.id)
  const source = sourcesFor(chat.id, host?.mode).file
  const [state, setState] = useState<{ key: string; result: FileOpenResult | null }>({
    key: '',
    result: null
  })
  const [progressOf, setProgress] = useState<{
    key: string
    loaded: number
    total?: number
  } | null>(null)
  const [zoom, setZoom] = useState<Zoom>(null)
  const [fitScale, setFitScale] = useState(1)
  const [scripts, setScripts] = useState(false)

  const key = `${JSON.stringify(file.target)}#${file.nonce}`
  // novo arquivo → zoom padrão e scripts desligados (reload mantém)
  const targetKey = JSON.stringify(file.target)
  const [prevTarget, setPrevTarget] = useState(targetKey)
  if (prevTarget !== targetKey) {
    setPrevTarget(targetKey)
    setZoom(null)
    setScripts(false)
  }

  useEffect(() => {
    const ctl = new AbortController()
    let res: ViewerResource | null = null
    void source
      .open(file.target, {
        signal: ctl.signal,
        onProgress: (loaded, total) => !ctl.signal.aborted && setProgress({ key, loaded, total })
      })
      .then((r) => {
        if (r.ok) res = r.resource
        if (!ctl.signal.aborted) setState({ key, result: r })
        else if (r.ok) r.resource.dispose()
      })
    return () => {
      ctl.abort()
      res?.dispose()
    }
  }, [key, file.target, source])

  const result = state.key === key ? state.result : null
  const progress = progressOf?.key === key ? progressOf : null
  const resource = result?.ok ? result.resource : null
  const kind = resource?.info.kind
  const fitKind = kind === 'image' || kind === 'pdf'
  const effZoom: number = zoom ?? 1
  // ações conforme as capacidades da fonte (remota: sem "Mostrar na pasta"; com "Salvar como…") e a
  // classe do arquivo (executável deste sistema: "Executar…" no lugar de "Abrir no app")
  const acts = resourceActions(source, resource)
  const openExternal = acts.openExternal
    ? () => void run(() => acts.openExternal!(), 'Não foi possível abrir o arquivo')
    : undefined
  const showInFolder = acts.showInFolder
    ? () => void run(() => acts.showInFolder!(), 'Não foi possível mostrar a pasta')
    : undefined
  const saveAs = acts.saveAs
    ? () => void run(() => acts.saveAs!(), 'Não foi possível salvar o arquivo')
    : undefined
  const runFile = acts.run
    ? () => void run(() => acts.run!(), 'Não foi possível executar o arquivo')
    : undefined
  const zoomable = !!resource && kind !== 'binary'

  // do modo Ajustar, +/− partem da escala real (imagem) — não de 100%
  const base = (z: Zoom): number => z ?? (kind === 'image' ? fitScale : 1)
  const zoomIn = (): void => setZoom((z) => stepZoom(base(z), 1))
  const zoomOut = (): void => setZoom((z) => stepZoom(base(z), -1))
  const reset = (): void => setZoom(fitKind ? 1 : null)

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Escape' && !mod) {
      e.stopPropagation()
      closeFile(chat.id)
    } else if (mod && zoomable && (e.key === '=' || e.key === '+')) {
      e.preventDefault()
      zoomIn()
    } else if (mod && zoomable && e.key === '-') {
      e.preventDefault()
      zoomOut()
    } else if (mod && zoomable && e.key === '0') {
      e.preventDefault()
      setZoom(null)
    }
  }

  const max = Math.max(VIEWER_MIN_WIDTH, maxWidth)
  const shown = Math.min(max, Math.max(VIEWER_MIN_WIDTH, width))
  const { icon: Icon, tone } = fileIcon(file.name, kind)
  const pct = zoom == null ? (fitKind ? 'Ajustar' : '100%') : `${Math.round(zoom * 100)}%`

  let body: React.ReactNode
  if (!result) {
    body = (
      <Loading
        label={
          progress
            ? `${source.id === 'remote' ? 'Baixando do host' : 'Carregando'}… ${formatBytes(progress.loaded)}${progress.total ? ` de ${formatBytes(progress.total)}` : ''}`
            : source.id === 'remote'
              ? 'Buscando no host…'
              : 'Carregando…'
        }
        progress={progress?.total ? progress.loaded / progress.total : undefined}
      />
    )
  } else if (!result.ok) {
    body =
      result.reason === 'remote' ? (
        <Problem
          icon={MonitorSmartphone}
          title={`Arquivo no ${result.deviceName ?? 'outro dispositivo'}`}
          text={
            // fonte remota: o motivo (outro dispositivo que não o host, host/servidor antigo)
            source.id === 'remote' && result.message
              ? result.message
              : 'A pré-visualização só funciona no dispositivo onde o arquivo está.'
          }
        />
      ) : result.reason === 'host-offline' ? (
        <Problem icon={WifiOff} title="Host offline" text={result.message} />
      ) : result.reason === 'denied' ? (
        <Problem icon={ShieldAlert} title="Acesso negado" text={result.message} />
      ) : (
        <Problem
          icon={CircleAlert}
          title={result.reason === 'missing' ? 'Arquivo não encontrado' : 'Não foi possível abrir'}
          text={
            result.reason === 'error' && source.id === 'remote' && result.message ? (
              <>
                {result.message}
                <span className="mt-1 block font-mono text-[11px] text-faint">{file.path}</span>
              </>
            ) : (
              file.path
            )
          }
        >
          <Button
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            onClick={() => reloadFile(chat.id)}
          >
            Tentar de novo
          </Button>
        </Problem>
      )
  } else if (resource) {
    const url = resource.url
    body =
      kind === 'image' && url ? (
        <ImageView
          url={url}
          name={resource.info.name}
          zoom={zoom}
          onZoom={setZoom}
          onFitScale={setFitScale}
        />
      ) : kind === 'pdf' && url ? (
        <PdfView url={url} name={resource.info.name} zoom={zoom} />
      ) : kind === 'html' && url ? (
        <HtmlView url={url} name={resource.info.name} zoom={effZoom} scripts={scripts} />
      ) : kind === 'binary' ? (
        <Unsupported
          resource={resource}
          onFolder={showInFolder}
          onSaveAs={saveAs}
          onExternal={openExternal}
          onRun={runFile}
          note={acts.note}
        />
      ) : (
        <TextKinds resource={resource} zoom={effZoom} onOpenExternal={openExternal} />
      )
  }

  return (
    <aside
      data-testid="file-viewer"
      aria-label={`Arquivo: ${file.name}`}
      onKeyDown={onKeyDown}
      onContextMenu={(e) =>
        // botão direito: as mesmas ações da barra do painel (iframes de HTML/PDF têm o menu básico)
        contributeCtx(e, {
          copy: { fileCopyPath: resource?.info.path ?? file.path },
          run: {
            // a próxima mensagem menciona este arquivo (volta a mencionar depois do × do chip)
            fileMention: () => mentionFile(chat.id, file.path, file.name),
            fileRun: runFile,
            fileOpenExternal: openExternal,
            fileShowInFolder: showInFolder,
            fileSaveAs: saveAs
          }
        })
      }
      style={{ width: shown }}
      className="relative flex shrink-0 animate-fade-in flex-col border-l border-border bg-surface"
    >
      <Splitter width={shown} min={VIEWER_MIN_WIDTH} max={max} onChange={setWidth} />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 pr-1.5 pl-3">
        <Icon className={cn('size-4 shrink-0', tone)} />
        <Tip label={resource?.info.path ?? file.path} side="bottom">
          <span
            data-testid="viewer-name"
            className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg/95"
          >
            {file.name}
          </span>
        </Tip>
        {resource && (
          <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
            {formatBytes(resource.info.size)}
          </span>
        )}
        <CopyPath path={resource?.info.path ?? file.path} />
        <IconButton label="Recarregar" size="xs" onClick={() => reloadFile(chat.id)}>
          <RefreshCw />
        </IconButton>
        <IconButton
          label="Fechar painel de arquivo"
          shortcut="Esc"
          size="xs"
          onClick={() => closeFile(chat.id)}
        >
          <X />
        </IconButton>
      </div>
      {resource && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/50 px-2">
          {zoomable && (
            <div role="group" aria-label="Zoom" className="flex items-center gap-0.5">
              <IconButton label="Diminuir zoom" shortcut="Ctrl −" size="xs" onClick={zoomOut}>
                <ZoomOut />
              </IconButton>
              <Tip label={fitKind ? 'Tamanho real (100%)' : 'Restaurar 100%'}>
                <button
                  type="button"
                  data-testid="viewer-zoom"
                  onClick={reset}
                  className="h-6 min-w-12 rounded-md px-1.5 text-[11px] text-muted tabular-nums hover:bg-hover hover:text-fg"
                >
                  {pct}
                </button>
              </Tip>
              <IconButton label="Aumentar zoom" shortcut="Ctrl +" size="xs" onClick={zoomIn}>
                <ZoomIn />
              </IconButton>
              {fitKind && (
                <IconButton
                  label="Ajustar ao painel"
                  size="xs"
                  active={zoom == null}
                  onClick={() => setZoom(null)}
                >
                  <Maximize />
                </IconButton>
              )}
            </div>
          )}
          {kind === 'html' && source.id === 'local' && (
            <label className="ml-1 flex items-center gap-1.5 text-[11px] text-subtle">
              <Switch
                size="sm"
                checked={scripts}
                label="Permitir scripts (isolado)"
                onChange={setScripts}
              />
              Permitir scripts (isolado)
            </label>
          )}
          <span className="flex-1" />
          {acts.note && kind !== 'binary' && (
            <span
              data-testid="viewer-exec-note"
              className="mr-1 truncate text-[11px] text-warning/85"
              title={acts.note}
            >
              {acts.note}
            </span>
          )}
          {runFile && (
            <IconButton label="Executar…" size="xs" onClick={runFile}>
              <Play />
            </IconButton>
          )}
          {openExternal && (
            <IconButton label="Abrir no app" size="xs" onClick={openExternal}>
              <ExternalLink />
            </IconButton>
          )}
          {showInFolder && (
            <IconButton label="Mostrar na pasta" size="xs" onClick={showInFolder}>
              <FolderOpen />
            </IconButton>
          )}
          {saveAs && (
            <IconButton label="Salvar como…" size="xs" onClick={saveAs}>
              <Download />
            </IconButton>
          )}
        </div>
      )}
      <div
        data-testid="viewer-body"
        data-kind={kind}
        data-zoom={zoom == null ? 'fit' : String(zoom)}
        className={cn(
          'min-h-0 flex-1',
          kind === 'image' || kind === 'pdf' || kind === 'html'
            ? 'overflow-hidden'
            : 'overflow-auto'
        )}
      >
        {body}
      </div>
    </aside>
  )
}
