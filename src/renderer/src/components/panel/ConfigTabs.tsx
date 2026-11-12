// Abas Modelo · Chat · Tools · Memória do painel direito (config do chat; salva automaticamente).
import { ArrowUpRight, BookmarkPlus, FolderOpen, Layers } from 'lucide-react'
import { useState } from 'react'
import { snapshotPreset } from '@shared/presets'
import type { Chat, ChatConfig } from '@shared/types'
import { useChatRequirements } from '../../lib/chatCompat'
import { baseName, rootSummary } from '../../lib/configSummary'
import { compactPath, formatTokens } from '../../lib/format'
import { useContextInfo } from '../../lib/useContextInfo'
import { isBusy, useStore } from '../../store'
import { ContextWindowInfo, RootInfo } from '../apiDocs'
import { PresetIcon } from '../presets/PresetIcon'
import { SavePresetDialog } from '../presets/SavePresetDialog'
import { Button } from '../ui/controls'
import {
  ContextSettingsSection,
  ModelEditor,
  RootOptions,
  SignatureSection,
  ToolsEditor
} from './editors'
import { CollapsibleSection, Section } from './fields'
import { MemorySection } from '../memory/MemorySection'
import { VoiceCallConfigSection } from '../voice/VoiceCallConfigSection'
import { VoiceChoiceSections } from '../voice/VoiceChoiceSections'
import { withInheritedVoice } from '../../lib/voice/voiceChoice'

function usePatch(chat: Chat): (p: Partial<ChatConfig>) => void {
  const patchConfig = useStore((s) => s.patchConfig)
  return (p) => patchConfig(chat.id, p)
}

export function ModelTab({ chat }: { chat: Chat }): React.JSX.Element {
  // o modelo do chat é o da sessão principal: o histórico dela decide o que é compatível
  const main = useStore((s) => s.sessions[chat.mainSessionId])
  const requires = useChatRequirements(main)
  return (
    <ModelEditor cfg={chat.config} patch={usePatch(chat)} scope={chat.id} requires={requires} />
  )
}

export function ToolsTab({ chat }: { chat: Chat }): React.JSX.Element {
  return <ToolsEditor cfg={chat.config} patch={usePatch(chat)} chatScope chatId={chat.id} />
}

export function MemoryTab({ chat }: { chat: Chat }): React.JSX.Element {
  return <MemorySection cfg={chat.config} patch={usePatch(chat)} chat={chat} />
}

/**
 * Aba Chat: persona de origem e o uso de contexto (com "Compactar agora") visíveis; recolhidos:
 * janela/compactação, opções da raiz e assinatura do app. O título é editado no cabeçalho do chat
 * (e na sidebar) e a raiz é trocada na aba Arquivos — aqui só aparece o caminho, com link.
 */
export function ChatTab({ chat }: { chat: Chat }): React.JSX.Element {
  const patch = usePatch(chat)
  return (
    <>
      <ChatInfoSection chat={chat} />
      <ContextSection chat={chat} />
      <RootSection chat={chat} />
      <SignatureSection cfg={chat.config} patch={patch} />
    </>
  )
}

/**
 * Aba Voz: a voz (Fala) e a Transcrição deste chat (da persona de origem ao vivo, ou próprias —
 * protocolo 1.9.0) e a chamada de voz (liga/desliga, modelo e parâmetros, tools e prompt do modo voz).
 */
export function VoiceTab({ chat }: { chat: Chat }): React.JSX.Element {
  const patch = usePatch(chat)
  return (
    <>
      <VoiceChoiceSections cfg={chat.config} patch={patch} scope="chat" defaultOpen />
      <VoiceCallConfigSection cfg={chat.config} patch={patch} defaultOpen />
    </>
  )
}

function ChatInfoSection({ chat }: { chat: Chat }): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const flushConfig = useStore((s) => s.flushConfig)
  const patchConfig = useStore((s) => s.patchConfig)
  const [saveOpen, setSaveOpen] = useState(false)
  const origin = chat.config.presetId
    ? (presets.find((p) => p.id === chat.config.presetId) ?? null)
    : null
  return (
    <Section title="Persona">
      <div className="flex items-center gap-2.5 rounded-lg border border-border bg-bg/40 py-1.5 pr-1.5 pl-2">
        <PresetIcon icon={origin?.icon} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-subtle">Persona de origem</div>
          <div data-testid="chat-preset" className="truncate text-[12.5px] text-fg/90">
            {origin ? origin.name : chat.config.presetId ? '(persona apagada)' : 'Nenhuma'}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<BookmarkPlus className="size-3.5 text-accent-strong" />}
          onClick={() => {
            void flushConfig(chat.id)
            setSaveOpen(true)
          }}
        >
          Salvar como persona
        </Button>
      </div>
      <SavePresetDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        cwd={chat.config.cwd}
        base={origin}
        buildConfig={(_mode, includeCwd) =>
          // a voz/transcrição herdada ao vivo da persona de origem vai junto (o chat não a guarda)
          snapshotPreset(withInheritedVoice(chat.config, origin?.config.voice), { includeCwd })
        }
        onSaved={(p) => patchConfig(chat.id, { presetId: p.id })}
      />
    </Section>
  )
}

function RootSection({ chat }: { chat: Chat }): React.JSX.Element {
  const patch = usePatch(chat)
  const homeDir = useStore((s) => s.homeDir)
  const bwrap = useStore((s) => s.capabilities.bwrap)
  const setPanel = useStore((s) => s.setPanel)
  const c = chat.config
  return (
    <CollapsibleSection
      id="root"
      section="raiz"
      title="Diretório raiz"
      summary={rootSummary(c, !!bwrap, baseName(c.cwd))}
      aside={<RootInfo side="left" />}
    >
      {/* só leitura: trocar a raiz é na aba Arquivos (Escolher pasta… / Usar como raiz) */}
      <div
        data-testid="chat-root"
        className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 py-1.5 pr-2 pl-3"
      >
        <FolderOpen className="size-3.5 shrink-0 text-accent-strong/80" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg/90" title={c.cwd}>
          {compactPath(c.cwd, homeDir, 30)}
        </span>
        <button
          type="button"
          onClick={() => setPanel(true, 'files')}
          className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-accent-strong hover:underline"
        >
          Alterar em Arquivos <ArrowUpRight className="size-3" />
        </button>
      </div>
      <RootOptions cfg={c} patch={patch} sessionId={chat.mainSessionId} />
    </CollapsibleSection>
  )
}

function ContextSection({ chat }: { chat: Chat }): React.JSX.Element {
  const patch = usePatch(chat)
  const compact = useStore((s) => s.compact)
  const viewSessionId = useStore((s) => (s.view.kind === 'chat' ? s.view.sessionId : null))
  const viewSession = useStore((s) => (viewSessionId ? s.sessions[viewSessionId] : undefined))
  const mainSession = useStore((s) => s.sessions[chat.mainSessionId])
  const session = viewSession ?? mainSession
  const compacting = useStore((s) => (session ? s.compactions[session.id] : undefined))
  const c = chat.config
  const info = useContextInfo(
    chat,
    session ?? {
      id: chat.mainSessionId,
      chatId: chat.id,
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: c.model,
      title: '',
      task: null,
      status: 'idle',
      createdAt: 0
    }
  )
  const isSub = !!session && session.depth > 0
  return (
    <>
      <Section title="Contexto" id="contexto" aside={<ContextWindowInfo />}>
        <div className="rounded-lg border border-border bg-bg/40 px-3 py-2.5 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="text-muted">Em uso</span>
            <span className="ml-auto font-mono text-fg/90 tabular-nums">
              {info.usage
                ? `${info.usage.estimated ? '~' : ''}${formatTokens(info.usage.used)}${info.window ? ` / ${formatTokens(info.window)} · ${Math.round((info.pct ?? 0) * 100)}%` : ''}`
                : '—'}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-muted">Janela</span>
            <span className="ml-auto text-subtle">
              {info.window
                ? `${info.window.toLocaleString('pt-BR')} tokens · ${info.source === 'override' ? 'definida aqui' : 'do modelo'}`
                : 'não informada pelo provedor'}
            </span>
          </div>
        </div>
        <Button
          variant="secondary"
          className="w-full"
          disabled={isSub || !info.canCompact || !!compacting}
          loading={compacting?.state === 'running'}
          icon={<Layers className="size-3.5 text-accent-strong" />}
          onClick={() => session && void compact(session.id)}
        >
          {compacting?.state === 'scheduled'
            ? 'Compactação agendada'
            : session && isBusy(session.status)
              ? 'Compactar no próximo passo'
              : 'Compactar agora'}
        </Button>
        {isSub && (
          <p className="-mt-1 text-center text-[11px] text-subtle">
            Subagentes compactam sozinhos ao atingir o limite.
          </p>
        )}
      </Section>
      <ContextSettingsSection cfg={c} patch={patch} knownWindow={info.window} info={false} />
    </>
  )
}
