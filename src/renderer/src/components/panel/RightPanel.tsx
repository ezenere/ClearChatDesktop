import {
  AudioLines,
  Braces,
  BrainCircuit,
  FolderTree,
  MessageSquareText,
  Sparkles,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import { cn } from '../../lib/format'
import { PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH } from '../../lib/panelLayout'
import { useStore, type PanelTab } from '../../store'
import { IconButton } from '../ui/controls'
import { Splitter } from '../ui/Splitter'
import { ChatTab, MemoryTab, ModelTab, ToolsTab, VoiceTab } from './ConfigTabs'
import { Note } from './fields'
import { ModelLabel } from '../ui/ModelLabel'
import { sessionProviderId } from '@shared/models'
import { FilesTab } from './FilesTab'

const TABS: { id: PanelTab; label: string; icon: typeof Sparkles }[] = [
  { id: 'model', label: 'Modelo', icon: Sparkles },
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'memory', label: 'Memória', icon: BrainCircuit },
  { id: 'voice', label: 'Voz', icon: AudioLines },
  { id: 'files', label: 'Arquivos', icon: FolderTree }
]

export function RightPanel({
  chat,
  overlay,
  width,
  maxWidth
}: {
  chat: Chat
  /** Janela estreita: gaveta sobreposta ao chat em vez de coluna. */
  overlay?: boolean
  /** Largura mostrada (a escolhida no divisor, já dentro de [mínimo, maxWidth]). */
  width: number
  /** Máximo do divisor nesta janela (o chat mantém um mínimo). */
  maxWidth: number
}): React.JSX.Element {
  const tab = useStore((s) => s.panelTab)
  const setPanel = useStore((s) => s.setPanel)
  const setPanelWidth = useStore((s) => s.setPanelWidth)
  // aba cujo rótulo aparece: a sob o mouse (ou com o foco do teclado); senão a selecionada
  const [peek, setPeek] = useState<PanelTab | null>(null)
  const labelled = peek ?? tab
  const setPreview = useStore((s) => s.setPreview)
  const viewSessionId = useStore((s) => (s.view.kind === 'chat' ? s.view.sessionId : null))
  const viewSession = useStore((s) => (viewSessionId ? s.sessions[viewSessionId] : undefined))
  const isSub = !!viewSession && viewSession.depth > 0

  // focusConfig('contexto') → a aba já foi trocada no store; rola até a seção e destaca.
  const configFocus = useStore((s) => s.configFocus)
  const focusConfig = useStore((s) => s.focusConfig)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!configFocus) return
    const body = bodyRef.current
    const el = body?.querySelector<HTMLElement>(`[data-section="${configFocus}"]`)
    if (body && el) {
      // rola só o corpo do painel (scrollIntoView rolaria também a janela quando a seção está no fim)
      const top = el.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
      body.scrollTo({ top: Math.max(0, top - 4), behavior: 'smooth' })
      el.classList.add('animate-flash')
      setTimeout(() => el.classList.remove('animate-flash'), 1200)
    }
    focusConfig(null)
  }, [configFocus, focusConfig, tab])

  return (
    <aside
      data-testid="right-panel"
      style={{ width }}
      className={cn(
        'flex max-w-[85%] shrink-0 animate-fade-in flex-col border-l border-border bg-surface',
        overlay ? 'absolute inset-y-0 right-0 z-30 shadow-popover' : 'relative'
      )}
    >
      <Splitter
        width={width}
        min={PANEL_MIN_WIDTH}
        max={maxWidth}
        defaultWidth={PANEL_DEFAULT_WIDTH}
        label="Redimensionar painel lateral"
        testId="panel-splitter"
        onChange={setPanelWidth}
      />
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
        <div
          role="tablist"
          aria-label="Configurações do chat"
          onPointerLeave={() => setPeek(null)}
          className="flex min-w-0 flex-1 rounded-lg bg-bg/70 p-0.5"
        >
          {TABS.map((t) => {
            const shown = labelled === t.id
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-label={t.label}
                data-tab={t.id}
                data-label={shown || undefined}
                onClick={() => setPanel(true, t.id)}
                onPointerEnter={() => setPeek(t.id)}
                onFocus={(e) => e.currentTarget.matches(':focus-visible') && setPeek(t.id)}
                onBlur={() => setPeek((p) => (p === t.id ? null : p))}
                className={cn(
                  'flex h-7 min-w-0 flex-auto items-center justify-center rounded-md px-1.5 text-xs font-medium transition-colors',
                  tab === t.id ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
                )}
              >
                <t.icon aria-hidden className="size-3.5 shrink-0" />
                {/* só ícone; o rótulo abre (largura 0fr → 1fr + opacidade) na aba sob o mouse ou,
                    sem hover, na selecionada — a barra não muda de largura, as abas se acomodam */}
                <span
                  aria-hidden
                  className={cn(
                    'grid min-w-0 transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none',
                    shown ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0'
                  )}
                >
                  <span className="overflow-hidden">
                    <span className="block truncate pl-1.5">{t.label}</span>
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <IconButton
          label="Ver request"
          size="sm"
          side="bottom"
          onClick={() => setPreview(viewSessionId ?? chat.mainSessionId)}
        >
          <Braces />
        </IconButton>
        <IconButton label="Fechar painel" size="sm" side="bottom" onClick={() => setPanel(false)}>
          <X />
        </IconButton>
      </div>
      <div
        ref={bodyRef}
        className={cn('min-h-0 flex-1', tab === 'files' ? 'overflow-hidden' : 'overflow-y-auto')}
      >
        {tab !== 'files' && isSub && (
          <div className="px-4 pt-4">
            <Note>
              Configuração do chat (compartilhada por todas as sessões dele — editar aqui vale para
              o chat, não só para esta subsessão). Este subagente usa{' '}
              <ModelLabel
                providerId={sessionProviderId(chat.config, viewSession)}
                model={viewSession.model}
                className="text-fg/90"
                modelClassName="font-mono"
              />{' '}
              e o system prompt de subagentes (aba Tools); &quot;Ver request&quot; mostra a request
              dela. Para falar com ele, use o campo de mensagem — as respostas voltam ao agente pai.
            </Note>
          </div>
        )}
        {tab === 'model' ? (
          <ModelTab chat={chat} />
        ) : tab === 'chat' ? (
          <ChatTab chat={chat} />
        ) : tab === 'tools' ? (
          <ToolsTab chat={chat} />
        ) : tab === 'memory' ? (
          <MemoryTab chat={chat} />
        ) : tab === 'voice' ? (
          <VoiceTab chat={chat} />
        ) : (
          <FilesTab key={chat.id} chat={chat} />
        )}
      </div>
    </aside>
  )
}
