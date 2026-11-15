import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { useEffect, useSyncExternalStore } from 'react'
import { isChatProvider } from '@shared/providerKinds'
import { ChatHeader, ChatView } from './components/chat/ChatView'
import { NewChat } from './components/NewChat'
import { Onboarding } from './components/Onboarding'
import { RequestPreviewModal } from './components/panel/RequestPreview'
import { RightPanel } from './components/panel/RightPanel'
import { FileViewerPane } from './components/viewer/FileViewerPane'
import { CHAT_MIN_WIDTH, useWidth, VIEWER_MIN_WIDTH } from './components/viewer/viewerLayout'
import { SettingsModal } from './components/SettingsModal'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { VoiceCallController } from './components/voice/VoiceCallDock'
import { SyncPrompts } from './components/sync/ChatHost'
import { McpElicitDock } from './components/mcp/McpElicitForm'
import { Spinner } from './components/ui/controls'
import { TooltipProvider } from './components/ui/Tooltip'
import { cn } from './lib/format'
import { clampPanelWidth, panelMaxWidth } from './lib/panelLayout'
import { currentChat, useStore } from './store'

function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[90] flex w-[340px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          data-testid="toast"
          data-kind={t.kind}
          className={cn(
            'pointer-events-auto flex animate-slide-up items-start gap-2.5 rounded-xl border bg-elevated px-3.5 py-2.5 text-[12.5px] shadow-popover',
            t.kind === 'error' ? 'border-danger/25' : 'border-border-strong/70'
          )}
        >
          {t.kind === 'error' ? (
            <CircleAlert className="mt-px size-3.5 shrink-0 text-danger" />
          ) : t.kind === 'success' ? (
            <CircleCheck className="mt-px size-3.5 shrink-0 text-success" />
          ) : (
            <Info className="mt-px size-3.5 shrink-0 text-accent-strong" />
          )}
          <span className="min-w-0 flex-1 break-words text-fg/90">{t.text}</span>
          <button type="button" onClick={() => dismiss(t.id)} className="text-subtle hover:text-fg">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Abaixo desta largura de janela o painel direito vira gaveta sobreposta (e começa fechado). */
const NARROW_QUERY = '(max-width: 1179px)'

function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(NARROW_QUERY)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => window.matchMedia(NARROW_QUERY).matches
  )
}

function Main(): React.JSX.Element {
  const view = useStore((s) => s.view)
  const chat = useStore(currentChat)
  const panelOpen = useStore((s) => s.panelOpen)
  const setPanel = useStore((s) => s.setPanel)
  const narrow = useNarrow()
  // trocar a persona padrão (Configurações) reinicia o Novo chat com ela
  const defaultPresetId = useStore((s) => s.settings.defaultPresetId)

  // Ao ficar estreita, recolhe o painel (o usuário pode reabrir como gaveta).
  useEffect(() => {
    if (narrow) useStore.getState().setPanel(false)
  }, [narrow])
  const session = useStore((s) =>
    s.view.kind === 'chat' ? s.sessions[s.view.sessionId] : undefined
  )
  // painel de arquivo do chat aberto: [LISTA | CHAT | ARQUIVO | CONFIGS]
  const activeFile = useStore((s) => (s.view.kind === 'chat' ? s.viewer[s.view.chatId] : undefined))
  const [rowRef, rowWidth] = useWidth<HTMLDivElement>()
  // painel lateral redimensionável: em coluna deixa o mínimo do chat (e do painel de arquivo)
  const panelWidth = useStore((s) => s.panelWidth)
  const panelMax = panelMaxWidth(rowWidth, {
    overlay: narrow,
    reserved: CHAT_MIN_WIDTH + (activeFile ? VIEWER_MIN_WIDTH : 0)
  })
  const panelShown = clampPanelWidth(panelWidth, panelMax)
  const viewerMax = rowWidth - (panelOpen && !narrow ? panelShown : 0) - CHAT_MIN_WIDTH

  if (view.kind === 'chat' && chat) {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader chat={chat} session={session} />
        <div ref={rowRef} className="relative flex min-h-0 flex-1">
          <ChatView key={view.sessionId} chat={chat} sessionId={view.sessionId} />
          {activeFile && <FileViewerPane chat={chat} file={activeFile} maxWidth={viewerMax} />}
          {panelOpen && narrow && (
            <div
              className="absolute inset-0 z-20 animate-fade-in bg-black/40"
              onClick={() => setPanel(false)}
            />
          )}
          {panelOpen && (
            <RightPanel chat={chat} overlay={narrow} width={panelShown} maxWidth={panelMax} />
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <NewChat key={`new:${defaultPresetId ?? ''}`} />
    </div>
  )
}

function App(): React.JSX.Element {
  const booted = useStore((s) => s.booted)
  // só provedores de chat contam (um provedor só de voz — ElevenLabs — não abre o app)
  const hasProviders = useStore((s) => s.providers.some(isChatProvider))
  const boot = useStore((s) => s.boot)

  useEffect(() => {
    void boot()
  }, [boot])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey) return
      const s = useStore.getState()
      if (!s.providers.some(isChatProvider)) return
      if (e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault()
        s.setSettingsOpen(false)
        s.setPreview(null)
        s.goNew()
      } else if (e.key === ',') {
        e.preventDefault()
        s.setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={150}>
      {!booted ? (
        <div className="flex h-full flex-col">
          <div className="drag h-titlebar" />
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-4" />
          </div>
        </div>
      ) : !hasProviders ? (
        <Onboarding />
      ) : (
        <div className="flex h-full">
          <Sidebar />
          <Main />
          <SettingsModal />
          <RequestPreviewModal />
          <SyncPrompts />
          <McpElicitDock />
        </div>
      )}
      <Toasts />
      <VoiceCallController />
    </TooltipProvider>
  )
}

export default App
