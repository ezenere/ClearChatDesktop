// Personas no renderer: config base de um chat novo (padrões de "Novos chats") e resolução de
// uma persona sobre ela — a lógica é a de @shared/presets (a mesma que o main usa na herança ao
// vivo, @shared/chatInherit); aqui só o adaptador das settings do store.
import { DEFAULT_PRESET_NAME, newChatBase as sharedNewChatBase } from '@shared/presets'
import type { ChatConfig, Preset, Provider } from '@shared/types'
import type { AppSettings } from '../store'

export { presetProviderMissing, resolvePreset } from '@shared/presets'

/**
 * Config que um chat novo teria sem persona. Modelo = o par padrão (provedor + modelo) de "Novos
 * chats"; sem ele (ou com o provedor apagado), nenhum — o Novo chat pede para escolher.
 */
export function newChatBase(
  settings: AppSettings,
  providers: Provider[],
  homeDir: string | null
): ChatConfig {
  return sharedNewChatBase(settings, providers, settings.defaultCwd ?? homeDir ?? '')
}

/** Persona inicial do Novo chat: a padrão → "Padrão" → a primeira → nenhuma. */
export function initialPresetId(presets: Preset[], defaultPresetId: string | null): string | null {
  return (
    presets.find((p) => p.id === defaultPresetId)?.id ??
    presets.find((p) => p.name === DEFAULT_PRESET_NAME)?.id ??
    presets[0]?.id ??
    null
  )
}

const FIELD_LABELS: Record<string, string> = {
  providerId: 'modelo',
  model: 'modelo',
  systemPrompt: 'system prompt',
  params: 'parâmetros',
  enabledTools: 'tools',
  nativeTools: 'tools',
  toolsInPrompt: 'tools',
  toolsPromptText: 'tools',
  approvalModes: 'aprovação',
  subagentSystemPrompt: 'subagentes',
  envInPrompt: 'ambiente',
  cacheEnabled: 'cache',
  appSignature: 'assinatura',
  appSignatureCustom: 'assinatura',
  contextWindow: 'contexto',
  compactThreshold: 'contexto',
  autoCompact: 'contexto',
  compactPrompt: 'contexto',
  maxToolOutputChars: 'limites',
  confineToRoot: 'raiz',
  sandboxBash: 'raiz',
  cwd: 'diretório raiz'
}

/** Resumo do que a persona define (quando não há descrição). */
export function presetSummary(p: Pick<Preset, 'config'>): string {
  const labels = [...new Set(Object.keys(p.config).map((k) => FIELD_LABELS[k] ?? k))]
  if (!labels.length) return 'Segue os padrões de “Novos chats”'
  const shown = labels.slice(0, 3).join(', ')
  return `Define ${shown}${labels.length > 3 ? ` e mais ${labels.length - 3}` : ''}`
}
