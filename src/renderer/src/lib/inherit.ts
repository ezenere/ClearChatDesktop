// Herança ao vivo da persona na UI (protocolo 1.10.0 — @shared/chatInherit): o ambiente da
// herança a partir do store, rótulos das unidades e o texto do valor herdado (tooltip do "voltar a
// herdar"). Puro (sem React/DOM) — o mobile pode vendorar.
import { APP_SIGNATURES } from '@shared/appSignatures'
import { ITEM_LABEL, modeLabel } from '@shared/approvalPolicy'
import { keyOfUnit, type InheritEnv } from '@shared/chatInherit'
import { isChatProvider } from '@shared/providerKinds'
import { toolLabel } from '@shared/deviceTools'
import type { ApprovalItem, ApprovalMode, Provider } from '@shared/types'

/** Ambiente da herança: padrões de "Novos chats" + provedores de chat (o mesmo que o main lê). */
export function inheritEnvFrom(
  settings: {
    defaultProviderId?: string | null
    defaultModel?: string | null
    defaultSystemPrompt?: string | null
  },
  providers: readonly Provider[]
): InheritEnv {
  return {
    defaults: {
      defaultProviderId: settings.defaultProviderId ?? null,
      defaultModel: settings.defaultModel ?? null,
      defaultSystemPrompt: settings.defaultSystemPrompt ?? null
    },
    providers: providers.filter(isChatProvider)
  }
}

const KEY_LABELS: Record<string, string> = {
  model: 'Modelo',
  systemPrompt: 'System prompt',
  nativeTools: 'Enviar tools nativas',
  toolsInPrompt: 'Texto das tools no system prompt',
  toolsPromptText: 'Texto das tools',
  toolsCompact: 'Enviar tools compactadas',
  envInPrompt: 'Bloco de ambiente',
  cacheEnabled: 'Token caching',
  subagentSystemPrompt: 'System prompt dos subagentes',
  acceptEditsInRoot: 'Aceitar edições dentro da raiz',
  smartApprove: 'Smart-Approve',
  appSignature: 'Assinatura do app',
  contextWindow: 'Janela de contexto',
  compactThreshold: 'Sugerir compactação em',
  autoCompact: 'Compactar automaticamente',
  compactPrompt: 'Prompt de compactação',
  maxToolOutputChars: 'Saída máx. por ferramenta',
  confineToRoot: 'Confinar ferramentas à raiz',
  sandboxBash: 'Shell em sandbox',
  memory: 'Memória',
  skills: 'Skills'
}

const PARAM_LABELS: Record<string, string> = {
  reasoning_effort: 'Raciocínio',
  extraBody: 'Body extra (JSON)'
}

/** Nome legível de uma unidade (`params.temperature` → "temperature"). */
export function unitLabel(unit: string): string {
  const key = keyOfUnit(unit)
  const sub = unit.slice(key.length + 1)
  if (key === 'params') return PARAM_LABELS[sub] ?? sub
  if (key === 'enabledTools') return `Tool ${toolLabel(sub)}`
  if (key === 'toolsFull') return `Tool ${toolLabel(sub)} vai completa`
  if (key === 'approvalModes') return `Aprovação: ${ITEM_LABEL[sub as ApprovalItem] ?? sub}`
  return KEY_LABELS[unit] ?? unit
}

const short = (s: string, max = 90): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || '(vazio)'
}

const onOff = (v: unknown, fem = false): string =>
  v ? (fem ? 'ligada' : 'ligado') : fem ? 'desligada' : 'desligado'

/** Texto curto do valor de uma unidade (o herdado, no tooltip do "voltar a herdar"). */
export function unitValueText(
  unit: string,
  value: unknown,
  providerName?: (id: string) => string | null
): string {
  const key = keyOfUnit(unit)
  const sub = unit.slice(key.length + 1)
  if (unit === 'model') {
    const v = (value ?? {}) as { providerId?: string; model?: string }
    if (!v.model) return 'sem modelo'
    const p = v.providerId ? providerName?.(v.providerId) : null
    return p ? `${v.model} (${p})` : v.model
  }
  if (unit === 'appSignature') {
    const v = (value ?? {}) as { appSignature?: string | null }
    return APP_SIGNATURES.find((s) => s.id === v.appSignature)?.label ?? v.appSignature ?? 'padrão'
  }
  if (key === 'params') {
    if (value == null) return 'não enviado'
    return typeof value === 'string' ? short(value, 60) : String(value)
  }
  if (key === 'enabledTools') return onOff(value, true)
  if (key === 'toolsFull') return value ? 'completa' : 'compacta'
  if (key === 'approvalModes')
    return value
      ? modeLabel(sub as ApprovalItem, value as ApprovalMode)
      : 'padrão global (Configurações → Aprovações)'
  switch (unit) {
    case 'systemPrompt':
    case 'subagentSystemPrompt':
      return typeof value === 'string' ? `“${short(value)}”` : '(vazio)'
    case 'toolsPromptText':
    case 'compactPrompt':
      return typeof value === 'string' ? `“${short(value)}”` : 'texto padrão'
    case 'contextWindow':
      return typeof value === 'number' && value > 0
        ? `${value.toLocaleString('pt-BR')} tokens`
        : 'a do modelo'
    case 'compactThreshold':
      return typeof value === 'number' ? `${Math.round(value * 100)}%` : '90%'
    case 'maxToolOutputChars':
      return typeof value === 'number' ? `${value.toLocaleString('pt-BR')} caracteres` : 'padrão'
    case 'toolsCompact':
      return onOff(value !== false)
    case 'acceptEditsInRoot':
      return typeof value === 'boolean' ? onOff(value) : 'padrão global'
    case 'memory':
    case 'skills':
      return onOff((value as { enabled?: boolean } | null)?.enabled, true)
    case 'smartApprove': {
      const m = (value as { model?: string | null } | null)?.model
      return m ? `juiz ${m}` : 'sem modelo'
    }
  }
  if (typeof value === 'boolean') return onOff(value)
  if (value == null) return 'padrão'
  return typeof value === 'string' ? short(value) : String(value)
}
