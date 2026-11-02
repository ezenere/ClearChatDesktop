// Formulário de provedor (Configurações → Provedores, onboarding): rascunho, troca de tipo,
// inferência pela URL, headers e validação. Puro (sem React/IPC) — o renderer usa via
// lib/provider.ts e o app mobile vendora este arquivo.
import {
  inferProviderKind,
  PROVIDER_KIND_DEFAULT_URL,
  PROVIDER_KINDS,
  type ProviderKind
} from './providerKinds'
import type { Provider } from './types'

export interface ProviderDraft {
  name: string
  kind: ProviderKind
  /** O usuário escolheu o tipo manualmente (ou é um provider existente): não inferir pela URL. */
  kindTouched?: boolean
  baseUrl: string
  apiKey: string
  headersText: string
}

/** Entrada validada (= `ProviderInput` do IPC, com `kind` sempre presente). */
export type ProviderDraftInput = Omit<Provider, 'id' | 'createdAt'> & { kind: ProviderKind }

/** Nome padrão de cada tipo (preenchido ao trocar de tipo com o nome vazio ou padrão). */
export const PROVIDER_KIND_NAME: Record<ProviderKind, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  elevenlabs: 'ElevenLabs'
}

const isDefaultUrl = (url: string): boolean => {
  const u = url.trim().replace(/\/+$/, '')
  return PROVIDER_KINDS.some((k) => PROVIDER_KIND_DEFAULT_URL[k] === u)
}

/**
 * Troca de tipo: preenche a URL padrão se a atual estiver vazia ou for a padrão de outro tipo
 * (idem para o nome, se vazio ou igual ao nome padrão de outro tipo).
 */
export function draftWithKind(d: ProviderDraft, kind: ProviderKind): ProviderDraft {
  const baseUrl =
    !d.baseUrl.trim() || isDefaultUrl(d.baseUrl) ? PROVIDER_KIND_DEFAULT_URL[kind] : d.baseUrl
  const name =
    !d.name.trim() || Object.values(PROVIDER_KIND_NAME).includes(d.name.trim())
      ? PROVIDER_KIND_NAME[kind]
      : d.name
  return { ...d, kind, kindTouched: true, baseUrl, name }
}

/** Edição da URL: em provider novo sem tipo escolhido manualmente, sugere o tipo pela URL. */
export function draftWithBaseUrl(d: ProviderDraft, baseUrl: string): ProviderDraft {
  return { ...d, baseUrl, kind: d.kindTouched ? d.kind : inferProviderKind(baseUrl) }
}

export function parseHeaders(text: string): Record<string, string> | string {
  if (!text.trim()) return {}
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Deve ser um objeto JSON'
    for (const [k, val] of Object.entries(v)) {
      if (typeof val !== 'string') return `O valor de "${k}" deve ser string`
    }
    return v as Record<string, string>
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Rascunho → entrada válida, ou o texto do erro (pt-BR). */
export function draftToInput(d: ProviderDraft): ProviderDraftInput | string {
  const headers = parseHeaders(d.headersText)
  if (typeof headers === 'string') return `Headers inválidos: ${headers}`
  if (!d.name.trim()) return 'Informe um nome'
  if (!/^https?:\/\//.test(d.baseUrl.trim()))
    return 'A base URL deve começar com http:// ou https://'
  if (/\s/.test(d.apiKey.trim())) return 'A API key não pode conter espaços.'
  return {
    name: d.name.trim(),
    kind: d.kind,
    baseUrl: d.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: d.apiKey.trim(),
    headers
  }
}
