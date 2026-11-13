// Configurações → Personas: lista, criar, editar (mesmos editores do painel), duplicar, apagar e
// definir a padrão do Novo chat.
import {
  AudioLines,
  ArrowLeft,
  BrainCircuit,
  Copy,
  FolderOpen,
  MessageSquareText,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
  Wrench
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { patchPresetConfig, type PresetConfig } from '@shared/presets'
import type { ChatConfig, Preset } from '@shared/types'
import { api } from '../../lib/api'
import { cn, compactPath } from '../../lib/format'
import { newChatBase, presetProviderMissing, presetSummary, resolvePreset } from '../../lib/presets'
import { useStore } from '../../store'
import { RootInfo } from '../apiDocs'
import {
  ContextSettingsSection,
  ModelEditor,
  RootOptions,
  SignatureSection,
  ToolsEditor,
  type CfgProps
} from '../panel/editors'
import { CollapsibleSection, ToggleRow } from '../panel/fields'
import { baseName, rootSummary } from '../../lib/configSummary'
import { Button, IconButton, Label } from '../ui/controls'
import { ModelLabel } from '../ui/ModelLabel'
import { HelpTip, Tip } from '../ui/Tooltip'
import { IconPicker, PresetIcon } from './PresetIcon'
import { MemorySection } from '../memory/MemorySection'
import { VoiceCallConfigSection } from '../voice/VoiceCallConfigSection'
import { VoiceChoiceSections } from '../voice/VoiceChoiceSections'

function useResolver(): (p: Pick<Preset, 'config'> | null) => ChatConfig {
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const homeDir = useStore((s) => s.homeDir)
  const base = useMemo(
    () => newChatBase(settings, providers, homeDir),
    [settings, providers, homeDir]
  )
  return (p) => resolvePreset(base, p, providers)
}

// ---------------- lista ----------------

function PresetRow({ preset, onEdit }: { preset: Preset; onEdit: () => void }): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const isDefault = useStore((s) => s.settings.defaultPresetId === preset.id)
  const setSetting = useStore((s) => s.setSetting)
  const deletePreset = useStore((s) => s.deletePreset)
  const duplicatePreset = useStore((s) => s.duplicatePreset)
  const resolve = useResolver()
  const cfg = resolve(preset)
  const following = useStore((s) => s.chats.filter((c) => c.config.presetId === preset.id).length)
  return (
    <div
      data-testid="preset-row"
      className="group flex items-center gap-3 rounded-xl border border-border bg-bg/30 px-3.5 py-2.5"
      onMouseLeave={() => setConfirm(false)}
    >
      <PresetIcon icon={preset.icon} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <span className="truncate">{preset.name}</span>
          {isDefault && (
            <span className="shrink-0 rounded bg-accent-soft px-1.5 py-px text-[10px] font-medium text-accent-strong">
              padrão
            </span>
          )}
        </div>
        <div className="truncate text-[11.5px] text-subtle">
          {cfg.model ? (
            <ModelLabel
              providerId={cfg.providerId}
              model={cfg.model}
              modelClassName="font-mono text-[11px]"
            />
          ) : (
            <span className="font-mono text-[11px]">sem modelo</span>
          )}
          <span className="text-faint"> · {preset.description || presetSummary(preset)}</span>
          {following > 0 && (
            <span data-testid="preset-following" className="text-faint">
              {' '}
              · {following === 1 ? '1 chat segue' : `${following} chats seguem`}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
        <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={onEdit}>
          Editar
        </Button>
        <IconButton label="Duplicar" size="sm" onClick={() => void duplicatePreset(preset.id)}>
          <Copy />
        </IconButton>
        <IconButton
          label={isDefault ? 'Persona padrão' : 'Definir como padrão'}
          size="sm"
          active={isDefault}
          onClick={() => !isDefault && void setSetting('defaultPresetId', preset.id)}
        >
          <Star className={cn(isDefault && 'fill-accent-strong text-accent-strong')} />
        </IconButton>
        {confirm ? (
          <Tip
            label={
              following
                ? `${following === 1 ? 'O chat que segue' : `Os ${following} chats que seguem`} esta persona ficam com os valores atuais, sem persona.`
                : 'Apagar esta persona'
            }
          >
            <Button size="sm" variant="danger" onClick={() => void deletePreset(preset.id)}>
              Apagar?
            </Button>
          </Tip>
        ) : (
          <IconButton
            label="Apagar"
            size="sm"
            className="hover:text-danger"
            onClick={() => setConfirm(true)}
          >
            <Trash2 />
          </IconButton>
        )}
      </div>
    </div>
  )
}

export function PresetsList({
  onEdit
}: {
  onEdit: (id: string | 'new') => void
}): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  return (
    <div className="space-y-2.5">
      <div className="mb-3 flex items-center gap-1.5 text-xs leading-relaxed text-subtle">
        Presets de chat: modelo, system prompt, parâmetros, tools e ajustes.
        <HelpTip label="Personas">
          Escolha uma no Novo chat; a estrela define a que vem selecionada.
        </HelpTip>
      </div>
      {presets.map((p) => (
        <PresetRow key={p.id} preset={p} onEdit={() => onEdit(p.id)} />
      ))}
      {presets.length === 0 && (
        <p className="rounded-xl border border-border bg-bg/30 px-3.5 py-3 text-xs text-subtle">
          Nenhuma persona. Chats novos usam os padrões de “Novos chats”.
        </p>
      )}
      <button
        type="button"
        onClick={() => onEdit('new')}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong text-[13px] text-subtle transition-colors hover:border-accent/50 hover:bg-accent-soft/30 hover:text-fg"
      >
        <Plus className="size-4" /> Nova persona
      </button>
    </div>
  )
}

// ---------------- editor ----------------

type EditorTab = 'model' | 'chat' | 'tools' | 'memory' | 'voice'
const EDITOR_TABS: { id: EditorTab; label: string; icon: typeof Sparkles }[] = [
  { id: 'model', label: 'Modelo', icon: Sparkles },
  { id: 'chat', label: 'Chat', icon: MessageSquareText },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'memory', label: 'Memória', icon: BrainCircuit },
  { id: 'voice', label: 'Voz', icon: AudioLines }
]

function PresetChatEditor({
  cfg,
  patch,
  draft,
  setCwd
}: CfgProps & {
  draft: PresetConfig
  setCwd: (cwd: string | undefined) => void
}): React.JSX.Element {
  const homeDir = useStore((s) => s.homeDir)
  const run = useStore((s) => s.run)
  const bwrap = useStore((s) => s.capabilities.bwrap)
  const window = useStore(
    (s) => s.models[cfg.providerId]?.list.find((m) => m.id === cfg.model)?.contextLength ?? null
  )
  const pick = async (): Promise<void> => {
    const d = await run(() => api.fs.pickDirectory(), 'Erro ao escolher pasta')
    if (d) setCwd(d)
  }
  return (
    <>
      <CollapsibleSection
        id="root"
        title="Diretório raiz"
        summary={rootSummary(
          cfg,
          !!bwrap,
          draft.cwd ? baseName(draft.cwd) : 'escolhido no Novo chat'
        )}
        aside={<RootInfo side="left" />}
      >
        <ToggleRow
          label="Definir diretório raiz"
          help="Desligado: o Novo chat usa a pasta escolhida na hora"
          checked={!!draft.cwd}
          onChange={(v) => (v ? void pick() : setCwd(undefined))}
        />
        {draft.cwd && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 py-1.5 pr-1.5 pl-3">
            <FolderOpen className="size-3.5 shrink-0 text-accent-strong/80" />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg/90"
              title={draft.cwd}
            >
              {compactPath(draft.cwd, homeDir, 48)}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void pick()}>
              Alterar…
            </Button>
          </div>
        )}
        <RootOptions cfg={cfg} patch={patch} />
      </CollapsibleSection>
      <SignatureSection cfg={cfg} patch={patch} />
      <ContextSettingsSection cfg={cfg} patch={patch} knownWindow={window} />
    </>
  )
}

export function PresetEditor({
  preset,
  onDone
}: {
  preset: Preset | null
  onDone: () => void
}): React.JSX.Element {
  const savePreset = useStore((s) => s.savePreset)
  const toast = useStore((s) => s.toast)
  const following = useStore(
    (s) => s.chats.filter((c) => !!preset && c.config.presetId === preset.id).length
  )
  const resolve = useResolver()
  const [name, setName] = useState(preset?.name ?? '')
  const [icon, setIcon] = useState(preset?.icon ?? 'sparkles')
  const [description, setDescription] = useState(preset?.description ?? '')
  const [draft, setDraft] = useState<PresetConfig>(() => preset?.config ?? {})
  const [tab, setTab] = useState<EditorTab>('model')
  const [iconsOpen, setIconsOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const cfg = resolve({ config: draft })
  const patch = (p: Partial<ChatConfig>): void => setDraft((d) => patchPresetConfig(d, p))
  const scope = `preset:${preset?.id ?? 'new'}`
  const providers = useStore((s) => s.providers)
  const missing = presetProviderMissing({ config: draft }, providers)
  const ownModel = !!draft.model?.trim() && !missing
  const modelNote = (
    <p className="flex items-center gap-1.5 text-[11.5px] text-subtle">
      {missing ? (
        <span data-testid="preset-provider-missing" className="text-warning/85">
          O provedor desta persona não existe mais — usando o modelo padrão.
        </span>
      ) : ownModel ? (
        'Definido nesta persona.'
      ) : (
        'Segue o modelo padrão de “Novos chats”.'
      )}
      {(ownModel || missing) && (
        <button
          type="button"
          onClick={() =>
            setDraft((d) => {
              const next = { ...d }
              delete next.providerId
              delete next.model
              return next
            })
          }
          className="inline-flex items-center gap-1 text-subtle underline-offset-2 hover:text-fg hover:underline"
        >
          Usar o padrão
        </button>
      )}
    </p>
  )

  const save = async (): Promise<void> => {
    if (!name.trim()) return
    setSaving(true)
    const saved = await savePreset(
      { name: name.trim(), icon, description, config: draft },
      preset?.id
    )
    setSaving(false)
    if (!saved) return
    toast(preset ? `Persona “${saved.name}” salva.` : `Persona “${saved.name}” criada.`, 'success')
    onDone()
  }

  return (
    <div data-testid="preset-editor" className="animate-fade-in">
      <button
        type="button"
        onClick={onDone}
        className="mb-3 inline-flex items-center gap-1.5 text-xs text-subtle hover:text-fg"
      >
        <ArrowLeft className="size-3.5" /> Personas
      </button>
      <div className="flex items-end gap-3">
        <div>
          <Label>Ícone</Label>
          <button
            type="button"
            aria-label="Escolher ícone"
            aria-expanded={iconsOpen}
            onClick={() => setIconsOpen((o) => !o)}
            className="rounded-lg transition-opacity hover:opacity-80"
          >
            <PresetIcon icon={icon} size="lg" />
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <Label>Nome</Label>
          <input
            className="field h-10"
            aria-label="Nome da persona"
            placeholder="Ex.: Revisor de código"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      {iconsOpen && (
        <div className="mt-3 animate-fade-in rounded-xl border border-border bg-bg/40 p-2.5">
          <IconPicker value={icon} onChange={setIcon} />
        </div>
      )}
      <div className="mt-3">
        <Label>Descrição</Label>
        <input
          className="field"
          aria-label="Descrição da persona"
          placeholder="Opcional — para que serve esta persona"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex items-center gap-3 border-b border-border/70 px-3 py-2">
          <div role="tablist" className="flex rounded-lg bg-bg/70 p-0.5">
            {EDITOR_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                  tab === t.id ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
              </button>
            ))}
          </div>
          <span className="ml-auto truncate text-[11px] text-subtle">
            Campos não alterados seguem “Novos chats”
            {following > 0 &&
              ` · ${following === 1 ? '1 chat segue' : `${following} chats seguem`} esta persona ao vivo`}
          </span>
        </div>
        {tab === 'model' ? (
          <ModelEditor cfg={cfg} patch={patch} scope={scope} modelNote={modelNote} />
        ) : tab === 'chat' ? (
          <PresetChatEditor
            cfg={cfg}
            patch={patch}
            draft={draft}
            setCwd={(cwd) =>
              setDraft((d) => {
                const next = { ...d }
                if (cwd) next.cwd = cwd
                else delete next.cwd
                return next
              })
            }
          />
        ) : tab === 'tools' ? (
          <ToolsEditor cfg={cfg} patch={patch} onOpenMemory={() => setTab('memory')} />
        ) : tab === 'voice' ? (
          <>
            <VoiceChoiceSections cfg={cfg} patch={patch} scope="persona" defaultOpen />
            <VoiceCallConfigSection cfg={cfg} patch={patch} scope="persona" defaultOpen />
          </>
        ) : (
          <MemorySection cfg={cfg} patch={patch} />
        )}
      </div>

      <div className="sticky -bottom-5 -mx-5 -mb-5 mt-4 flex items-center justify-end gap-2 border-t border-border bg-surface/95 px-5 py-3 backdrop-blur">
        <Button variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={!name.trim()}
          onClick={() => void save()}
        >
          {preset ? 'Salvar persona' : 'Criar persona'}
        </Button>
      </div>
    </div>
  )
}
