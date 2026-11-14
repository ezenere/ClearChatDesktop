// "Assinatura de app": headers de atribuição (HTTP-Referer / X-Title) enviados em cada request.
// Valores conferidos no código-fonte de cada app (out/2026). Ver SPEC.md → "Assinatura de app".

export interface AppSignature {
  id: string
  label: string
  referer?: string
  title?: string
}

export const DEFAULT_APP_SIGNATURE = 'clearchat'

/**
 * Ids antigos que continuam aceitos (silenciosamente) e resolvem para o id atual.
 * 'cleartchat' era o id da assinatura padrão antes da correção do nome do app (typo).
 */
const APP_SIGNATURE_ALIASES: Record<string, string> = { cleartchat: 'clearchat' }

/** Id normalizado: vazio → padrão; aliases antigos → id atual. */
export function normalizeAppSignatureId(id: string | undefined | null): string {
  const v = id || DEFAULT_APP_SIGNATURE
  return APP_SIGNATURE_ALIASES[v] ?? v
}

export const APP_SIGNATURES: AppSignature[] = [
  { id: 'none', label: 'Nenhuma' },
  {
    id: 'clearchat',
    label: 'ClearChat',
    referer: 'https://github.com/ezenere/clearchat',
    title: 'ClearChat'
  },
  // cline/cline sdk/packages/llms/src/providers/request-headers.ts
  { id: 'cline', label: 'Cline', referer: 'https://cline.bot', title: 'Cline' },
  // RooCodeInc/Roo-Code src/api/providers/constants.ts
  {
    id: 'roo-code',
    label: 'Roo Code',
    referer: 'https://github.com/RooVetGit/Roo-Cline',
    title: 'Roo Code'
  },
  // Kilo-Org/kilocode packages/opencode/src/provider/provider.ts (a extensão legada usava https://kilocode.ai)
  { id: 'kilo-code', label: 'Kilo Code', referer: 'https://kilo.ai/', title: 'Kilo Code' },
  // Aider-AI/aider aider/llm.py (OR_SITE_URL / OR_APP_NAME)
  { id: 'aider', label: 'Aider', referer: 'https://aider.chat', title: 'Aider' },
  // anomalyco/opencode packages/core/src/plugin/provider/openrouter.ts
  { id: 'opencode', label: 'opencode', referer: 'https://opencode.ai/', title: 'opencode' },
  // SillyTavern/SillyTavern src/constants.js
  {
    id: 'sillytavern',
    label: 'SillyTavern',
    referer: 'https://sillytavern.app',
    title: 'SillyTavern'
  },
  // open-webui/open-webui backend/open_webui/utils/headers.py
  { id: 'open-webui', label: 'Open WebUI', referer: 'https://openwebui.com/', title: 'Open WebUI' },
  // danny-avila/LibreChat packages/api/src/endpoints/openai/config.ts
  { id: 'librechat', label: 'LibreChat', referer: 'https://librechat.ai', title: 'LibreChat' },
  { id: 'custom', label: 'Personalizada' }
]

/**
 * Headers de atribuição para a assinatura `id`. 'none' → {}; 'custom' usa `custom`;
 * id desconhecido/vazio → ClearChat. Campos vazios não são enviados.
 */
export function resolveAppSignatureHeaders(
  id: string,
  custom?: { referer: string; title: string }
): Record<string, string> {
  const sigId = normalizeAppSignatureId(id)
  if (sigId === 'none') return {}
  let referer: string | undefined
  let title: string | undefined
  if (sigId === 'custom') {
    referer = custom?.referer
    title = custom?.title
  } else {
    const sig =
      APP_SIGNATURES.find((s) => s.id === sigId) ??
      APP_SIGNATURES.find((s) => s.id === DEFAULT_APP_SIGNATURE)!
    referer = sig.referer
    title = sig.title
  }
  const h: Record<string, string> = {}
  if (referer?.trim()) h['HTTP-Referer'] = referer.trim()
  if (title?.trim()) h['X-Title'] = title.trim()
  return h
}

/** A assinatura de uma config de chat/persona (`ChatConfig.appSignature` + a personalizada). */
export interface AppSignatureConfig {
  appSignature?: string | null
  appSignatureCustom?: { referer: string; title: string } | null
}

/**
 * Headers de atribuição das requests feitas num contexto (chat/persona) — as MESMAS regras das
 * requests do chat: a assinatura da config; sem contexto ou sem assinatura = a padrão (ClearChat);
 * 'none' = nenhum header. Vale também para as requests de voz (`/audio/speech`,
 * `/audio/transcriptions` — antes iam sem atribuição: "Unknown" na atividade do OpenRouter).
 */
export function appSignatureHeadersOf(cfg?: AppSignatureConfig | null): Record<string, string> {
  return resolveAppSignatureHeaders(
    cfg?.appSignature || DEFAULT_APP_SIGNATURE,
    cfg?.appSignatureCustom ?? undefined
  )
}

/** Texto de header seguro (sem quebras de linha — o fetch recusaria o valor), aparado e curto. */
const headerText = (v: unknown, max: number): string | null =>
  typeof v === 'string'
    ? v
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, max)
    : null

/**
 * Assinatura vinda de um pedido do renderer (`signature` dos pedidos de voz: a do chat/persona da
 * tela) → config sanitizada; lixo/ausente = null (sem contexto → a padrão).
 */
export function appSignatureConfigFrom(v: unknown): AppSignatureConfig | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const id = headerText(o.appSignature, 64)
  const c = o.appSignatureCustom
  const custom =
    c && typeof c === 'object' && !Array.isArray(c)
      ? {
          referer: headerText((c as Record<string, unknown>).referer, 500) ?? '',
          title: headerText((c as Record<string, unknown>).title, 200) ?? ''
        }
      : null
  if (!id && !custom) return null
  return { ...(id ? { appSignature: id } : {}), ...(custom ? { appSignatureCustom: custom } : {}) }
}
