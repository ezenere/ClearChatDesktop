import {
  AlertTriangle,
  ArrowRight,
  BookmarkPlus,
  FolderOpen,
  Cloud,
  FolderPlus,
  Radio,
  RotateCcw
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { normalizeAppSignatureId } from '@shared/appSignatures'
import { supportsCacheControl } from '@shared/defaults'
import { isChatProvider, providerKind } from '@shared/providerKinds'
import { sameValue, sanitizePresetConfig, withoutCwd, type PresetConfig } from '@shared/presets'
import type { ChatConfig, Preset } from '@shared/types'
import type { NewChatStorage } from '@shared/sync'
import { AppSignatureField, AppSignatureInfo } from './AppSignatureField'
import { api } from '../lib/api'
import { compactPath, isMac } from '../lib/format'
import { initialPresetId, newChatBase, presetProviderMissing, resolvePreset } from '../lib/presets'
import { withoutVoiceChoice } from '../lib/voice/voiceChoice'
import { useStore } from '../store'
import { ModelFieldInfo, RootInfo, SystemPromptInfo } from './apiDocs'
import { NewFolderForm } from './panel/FilesTab'
import { ModelInfoLine } from './panel/editors'
import { PresetPicker } from './presets/PresetPicker'
import { SavePresetDialog } from './presets/SavePresetDialog'
import { Tip } from './ui/Tooltip'
import { AutoTextarea, Button, Kbd, Label } from './ui/controls'
import { ModelPicker } from './ui/ModelPicker'

type Custom = { referer: string; title: string }

/** Campos visíveis no Novo chat (o resto vem da persona). */
interface Form {
  providerId: string
  model: string
  systemPrompt: string
  cwd: string
  appSignature: string
  appSignatureCustom: Custom
}

const EMPTY_CUSTOM: Custom = { referer: '', title: '' }

function formFrom(cfg: ChatConfig, cwd: string): Form {
  return {
    providerId: cfg.providerId,
    model: cfg.model,
    systemPrompt: cfg.systemPrompt,
    cwd,
    appSignature: normalizeAppSignatureId(cfg.appSignature),
    appSignatureCustom: cfg.appSignatureCustom ?? EMPTY_CUSTOM
  }
}

/** Campos do formulário que diferem da persona resolvida (cwd só conta se a persona o define). */
function changedFields(form: Form, resolved: ChatConfig, preset: Preset | null): (keyof Form)[] {
  const out: (keyof Form)[] = []
  if (form.providerId !== resolved.providerId) out.push('providerId')
  if (form.model.trim() !== resolved.model.trim()) out.push('model')
  if (form.systemPrompt !== resolved.systemPrompt) out.push('systemPrompt')
  if (form.appSignature !== normalizeAppSignatureId(resolved.appSignature)) out.push('appSignature')
  else if (
    form.appSignature === 'custom' &&
    !sameValue(form.appSignatureCustom, resolved.appSignatureCustom ?? EMPTY_CUSTOM)
  )
    out.push('appSignatureCustom')
  if (preset?.config.cwd && form.cwd !== preset.config.cwd) out.push('cwd')
  return out
}

export function NewChat(): React.JSX.Element {
  // só provedores de chat (o de voz — ElevenLabs — nunca vira o provedor do chat)
  const allProviders = useStore((s) => s.providers)
  const providers = useMemo(() => allProviders.filter(isChatProvider), [allProviders])
  const settings = useStore((s) => s.settings)
  const homeDir = useStore((s) => s.homeDir)
  const presets = useStore((s) => s.presets)
  const createChat = useStore((s) => s.createChat)
  const run = useStore((s) => s.run)
  const sync = useStore((s) => s.sync)
  // §23.1: a escolha só aparece com o sync pronto e o servidor com chats ao vivo
  const showStorage = sync?.phase === 'ready' && !!sync.live?.supported
  const [storage, setStorage] = useState<NewChatStorage | null>(null)
  const chosenStorage: NewChatStorage = storage ?? sync?.live?.newChatStorage ?? 'live'

  const base = useMemo(
    () => newChatBase(settings, providers, homeDir),
    [settings, providers, homeDir]
  )
  const resolve = (p: Preset | null): ChatConfig => resolvePreset(base, p, providers)

  const [presetId, setPresetId] = useState<string | null>(() =>
    initialPresetId(presets, settings.defaultPresetId)
  )
  const preset = presets.find((p) => p.id === presetId) ?? null
  const resolved = resolve(preset)
  const [form, setForm] = useState<Form>(() =>
    formFrom(resolved, preset?.config.cwd ?? settings.defaultCwd ?? homeDir ?? '')
  )
  const set = (p: Partial<Form>): void => setForm((f) => ({ ...f, ...p }))

  const [creating, setCreating] = useState(false)
  const [newFolder, setNewFolder] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  const changed = changedFields(form, resolved, preset)
  const providerMissing = presetProviderMissing(preset, providers)
  const customized = !!preset && changed.length > 0
  const provider = providers.find((p) => p.id === form.providerId)
  const canStart = !!provider && form.model.trim().length > 0 && !!form.cwd

  const pickPreset = (id: string): void => {
    const p = presets.find((x) => x.id === id) ?? null
    setPresetId(id)
    // a pasta escolhida continua, a menos que a persona defina a sua
    setForm(formFrom(resolve(p), p?.config.cwd ?? form.cwd))
  }

  /** Campos visíveis como patch de ChatConfig. */
  const visibleConfig = (): Partial<ChatConfig> => ({
    providerId: form.providerId,
    model: form.model.trim(),
    systemPrompt: form.systemPrompt,
    appSignature: form.appSignature,
    ...(form.appSignature === 'custom' ? { appSignatureCustom: form.appSignatureCustom } : {})
  })

  const start = async (): Promise<void> => {
    if (!canStart || !provider) return
    setCreating(true)
    // cache: o da persona, se ela define e o provedor não mudou; senão segue o provedor
    const cacheEnabled =
      preset?.config.cacheEnabled !== undefined && form.providerId === resolved.providerId
        ? preset.config.cacheEnabled
        : supportsCacheControl(providerKind(provider))
    await createChat({
      config: {
        // a voz/transcrição da persona não entra no snapshot: o chat a herda ao vivo (1.9.0)
        ...withoutVoiceChoice(withoutCwd(preset?.config)),
        ...visibleConfig(),
        cwd: form.cwd,
        cacheEnabled,
        ...(preset ? { presetId: preset.id } : {})
      },
      ...(showStorage ? { storage: chosenStorage } : {})
    })
    setCreating(false)
  }

  /** Nova persona = config da persona de origem + o que está na tela; atualizar = idem por cima dela. */
  const buildConfig = (_mode: 'new' | 'update', includeCwd: boolean): PresetConfig =>
    sanitizePresetConfig({
      ...withoutCwd(preset?.config),
      ...visibleConfig(),
      ...(includeCwd ? { cwd: form.cwd } : {})
    })

  const pickDir = async (): Promise<void> => {
    const dir = await run(() => api.fs.pickDirectory(), 'Erro ao escolher pasta')
    if (dir) set({ cwd: dir })
  }

  return (
    <div
      className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void start()
        }
      }}
    >
      <div className="w-full max-w-[600px] animate-slide-up py-[9vh]">
        <h1 className="text-[24px] font-semibold tracking-tight">Novo chat</h1>
        <p className="mt-1.5 text-[13px] text-muted">
          Escolha uma persona ou o modelo, ajuste o system prompt e comece.
        </p>

        <div className="mt-8 space-y-5">
          <div>
            <Label
              className="min-h-[18px]"
              hint={
                customized && (
                  <button
                    type="button"
                    onClick={() => pickPreset(preset.id)}
                    className="inline-flex items-center gap-1 text-subtle hover:text-fg"
                  >
                    <RotateCcw className="size-3" /> Desfazer alterações
                  </button>
                )
              }
            >
              Persona
            </Label>
            <div className="flex items-stretch gap-2">
              <div className="min-w-0 flex-1">
                <PresetPicker
                  presets={presets}
                  value={presetId}
                  customized={customized}
                  resolve={resolve}
                  onChange={pickPreset}
                />
              </div>
              {(customized || presets.length === 0) && (
                <Button
                  variant="secondary"
                  className="h-auto animate-fade-in px-3"
                  icon={<BookmarkPlus className="size-4 text-accent-strong" />}
                  onClick={() => setSaveOpen(true)}
                >
                  <span className="max-[1179px]:hidden">Salvar como persona</span>
                  <span className="hidden max-[1179px]:inline">Salvar</span>
                </Button>
              )}
            </div>
          </div>

          <div>
            <Label info={<ModelFieldInfo />}>Modelo</Label>
            <ModelPicker
              value={{ providerId: form.providerId, model: form.model }}
              onChange={(ref) => set({ providerId: ref.providerId, model: ref.model })}
            />
            <div className="mt-1.5 empty:hidden">
              <ModelInfoLine providerId={form.providerId} model={form.model} />
            </div>
            {providerMissing && !changed.includes('model') && !changed.includes('providerId') && (
              <p
                data-testid="preset-provider-missing"
                className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-warning/85"
              >
                <AlertTriangle className="size-3 shrink-0" />
                {`O provedor do modelo de “${preset?.name}” não existe mais — ${
                  base.model ? 'usando o modelo padrão.' : 'escolha outro modelo.'
                }`}
              </p>
            )}
          </div>

          <div>
            <Label
              info={<SystemPromptInfo />}
              hint={
                form.systemPrompt !== resolved.systemPrompt && (
                  <button
                    type="button"
                    onClick={() => set({ systemPrompt: resolved.systemPrompt })}
                    className="inline-flex items-center gap-1 text-subtle hover:text-fg"
                  >
                    <RotateCcw className="size-3" />{' '}
                    {preset ? 'Restaurar da persona' : 'Restaurar padrão'}
                  </button>
                )
              }
            >
              System prompt
            </Label>
            <AutoTextarea
              value={form.systemPrompt}
              onChange={(e) => set({ systemPrompt: e.target.value })}
              minRows={6}
              maxRows={16}
              placeholder="Instruções para o modelo (opcional)"
              className="field leading-relaxed"
            />
          </div>

          <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start gap-3">
            <div>
              <Label
                info={<RootInfo />}
                help="Workspace da sessão: o agente cria e edita arquivos e roda o shell aqui."
              >
                Diretório raiz
              </Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void pickDir()}
                  className="field group flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <FolderOpen className="size-4 shrink-0 text-subtle group-hover:text-accent-strong" />
                  <span
                    data-testid="new-chat-root"
                    className="min-w-0 flex-1 truncate font-mono text-[12.5px]"
                    title={form.cwd || undefined}
                  >
                    {form.cwd ? (
                      compactPath(form.cwd, homeDir, 40)
                    ) : (
                      <span className="font-sans text-subtle">Escolher pasta…</span>
                    )}
                  </span>
                  <span className="text-xs text-subtle group-hover:text-fg">Alterar</span>
                </button>
                <Tip label="Criar uma pasta nova (projeto novo) dentro da selecionada">
                  <button
                    type="button"
                    aria-label="Nova pasta…"
                    onClick={() => setNewFolder((v) => !v)}
                    className="field flex w-auto shrink-0 items-center gap-1.5 px-2.5 text-xs text-subtle hover:text-fg"
                  >
                    <FolderPlus className="size-4" />
                    <span className="max-[1179px]:hidden">Nova pasta…</span>
                  </button>
                </Tip>
              </div>
              {newFolder && (form.cwd || homeDir) && (
                <div className="mt-2">
                  <NewFolderForm
                    parent={(form.cwd || homeDir)!}
                    onCancel={() => setNewFolder(false)}
                    onCreated={(p) => {
                      setNewFolder(false)
                      set({ cwd: p })
                    }}
                  />
                </div>
              )}
            </div>
            <div>
              <Label
                info={
                  <AppSignatureInfo
                    id={form.appSignature}
                    custom={form.appSignatureCustom}
                    side="top"
                  />
                }
              >
                Assinatura do app
              </Label>
              <AppSignatureField
                value={form.appSignature}
                custom={form.appSignatureCustom}
                onChange={(p) => {
                  if (p.appSignature !== undefined) set({ appSignature: p.appSignature })
                  if (p.appSignatureCustom) set({ appSignatureCustom: p.appSignatureCustom })
                }}
              />
            </div>
          </div>
        </div>

        {showStorage && (
          <div className="mt-6" data-testid="new-chat-storage">
            <Label>Onde guardar</Label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  {
                    v: 'online',
                    icon: <Cloud className="size-4" />,
                    title: 'Salvar online',
                    text: 'Cifrado no servidor; sincroniza com os seus dispositivos.'
                  },
                  {
                    v: 'live',
                    icon: <Radio className="size-4" />,
                    title: 'Só ao vivo',
                    text: 'Fica só neste dispositivo; os outros o veem enquanto este app estiver aberto.'
                  }
                ] as const
              ).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  data-testid={`new-chat-storage-${o.v}`}
                  aria-pressed={chosenStorage === o.v}
                  onClick={() => setStorage(o.v)}
                  className={
                    'field flex items-start gap-2.5 text-left ' +
                    (chosenStorage === o.v
                      ? 'border-accent/60 bg-accent-soft/40 ring-1 ring-accent/40'
                      : 'text-muted hover:text-fg')
                  }
                >
                  <span
                    className={
                      'mt-0.5 shrink-0 ' +
                      (chosenStorage === o.v ? 'text-accent-strong' : 'text-subtle')
                    }
                  >
                    {o.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-fg">{o.title}</span>
                    <span className="block text-[11.5px] leading-snug text-subtle">{o.text}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8 flex items-center justify-end gap-3">
          <span className="flex items-center gap-1 text-[11px] text-subtle">
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>Enter</Kbd>
          </span>
          <Button
            variant="primary"
            size="lg"
            disabled={!canStart}
            loading={creating}
            onClick={() => void start()}
          >
            Começar <ArrowRight className="size-4" />
          </Button>
        </div>
      </div>

      <SavePresetDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        cwd={form.cwd || null}
        base={preset}
        buildConfig={buildConfig}
        onSaved={(p) => {
          // a persona salva passa a ser a selecionada (sem alterações pendentes)
          setPresetId(p.id)
          if (p.config.cwd) set({ cwd: p.config.cwd })
        }}
      />
    </div>
  )
}
