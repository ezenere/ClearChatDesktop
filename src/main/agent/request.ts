// Construção da request (função pura). Usada pelo runner E pelo previewRequest.
// Ver SPEC.md → "Construção da request" e "Token caching".
import * as os from 'os'
import { DEFAULT_SKILLS_SUPPORT_PROMPT, defaultToolsPrompt } from '@shared/defaults'
import { providerKind, type ProviderKind } from '@shared/providerKinds'
import { DEFAULT_APP_SIGNATURE, resolveAppSignatureHeaders } from '@shared/appSignatures'
import {
  END_CALL_TOOL,
  SKILL_TOOL_NAMES,
  TOOL_NAMES,
  toolDefinitionFor,
  type ToolDefinition
} from '@shared/tools'
import { normalizeSkillsConfig, skillsActiveFor } from '@shared/skills'
import { activeHistory, isDisplayOnly } from '@shared/context'
import { bwrapAvailable, shellLabel } from '../tools/bash'
import { expandAttachments, hoistToolMedia } from '../attachments'
import { paramSupport, type ParamSupport } from '@shared/modelParams'
import { cachedModelInfo } from '../providers'
import { adapterFor, buildHeaders, chatCompletionsUrl } from './adapters'
import { buildAnthropicBody, dropAudioParts } from './adapters/anthropic'
import type {
  ApiMessage,
  Chat,
  ChatConfig,
  ChatParams,
  ContentPart,
  ModelInfo,
  Provider,
  Session,
  StoredMessage,
  ToolCall,
  ToolName
} from '@shared/types'

export interface BuiltRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  /**
   * Adaptador que montou a request (formato do body e do stream). Ausente = OpenAI-compatible.
   * streamChat usa para escolher o parser; o preview pode mostrar.
   */
  kind?: ProviderKind
  /**
   * Notas legíveis sobre a montagem (ex.: "temperature omitido: não suportado por …") — parâmetros
   * ligados no chat que o modelo não aceita não são enviados (@shared/modelParams). O preview mostra.
   */
  notes?: string[]
}

export { buildHeaders, chatCompletionsUrl }

/**
 * Item do /models do modelo (para os parâmetros aceitos). Padrão: o cache de providers.listModels
 * (sem rede; vazio → desconhecido → todos os params). Testes podem trocar.
 */
let modelInfoSource: (providerId: string, model: string) => ModelInfo | undefined = cachedModelInfo
export function setModelInfoSource(
  fn: (providerId: string, model: string) => ModelInfo | undefined
): void {
  modelInfoSource = fn
}
export function modelInfoFor(providerId: string, model: string): ModelInfo | undefined {
  return modelInfoSource(providerId, model)
}

/**
 * Params do chat filtrados pelo modelo (paramSupport). O valor salvo não muda; só não vai.
 * `extra` = extraBody já parseado (thinking da Anthropic).
 */
export function filterParams(
  params: ChatParams,
  kind: ProviderKind,
  providerId: string,
  model: string,
  extra: Record<string, unknown> | null
): ParamSupport {
  return paramSupport({ kind, model, info: modelInfoFor(providerId, model), extra, params })
}

export interface EnvInfo {
  os: string
  shell: string
  /** bubblewrap instalado (o sandbox do shell só vale se existir). */
  bwrap?: boolean
}

/** Info do ambiente para o bloco <environment> — sem data/hora (estável para cache). */
export function defaultEnvInfo(): EnvInfo {
  const name =
    process.platform === 'linux'
      ? 'Linux'
      : process.platform === 'darwin'
        ? 'macOS'
        : process.platform === 'win32'
          ? 'Windows'
          : process.platform
  return {
    os: `${name} ${os.release()} (${process.arch})`,
    shell: shellLabel(),
    bwrap: bwrapAvailable()
  }
}

/**
 * Bloco <environment>: diretório raiz, SO, shell e regras do workspace. Só valores estáveis
 * (sem data/hora nem diretório atual do shell) — o prefixo do prompt não muda entre chamadas.
 */
export function environmentBlock(
  cfg: Pick<ChatConfig, 'cwd' | 'confineToRoot' | 'sandboxBash'>,
  env: EnvInfo = defaultEnvInfo()
): string {
  const lines = [
    `root: ${cfg.cwd}`,
    `os: ${env.os}`,
    `shell: ${env.shell}`,
    'Diretório raiz (workspace) desta sessão: root acima. Caminhos relativos nas ferramentas resolvem a partir dele e o shell começa nele (o diretório do shell persiste entre chamadas).'
  ]
  if (cfg.confineToRoot)
    lines.push('As ferramentas de arquivo só acessam caminhos dentro do diretório raiz.')
  if (cfg.sandboxBash && env.bwrap)
    lines.push('O shell roda em sandbox: só o diretório raiz (e um /tmp privado) é gravável.')
  return `<environment>\n${lines.join('\n')}\n</environment>`
}

/** Tools que só fazem sentido com delegate_task disponível (subagentes da própria sessão). */
const SUBAGENT_TOOLS: ToolName[] = [
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent'
]

/** A sessão já chamou delegate_task (tem ou teve subagentes)? */
export function hasDelegated(history: StoredMessage[]): boolean {
  return history.some(
    (m) =>
      m.message.role === 'assistant' &&
      !!m.message.tool_calls?.some((t) => t.function.name === 'delegate_task')
  )
}

/** Tools de subagentes que também valem entre irmãos (mesmo agente pai) — ver availableTools. */
const SIBLING_TOOLS: ToolName[] = ['check_subagents', 'message_subagent']

/**
 * A sessão tem irmãos (outras subsessões do mesmo agente pai)? O runner registra (banco); sem
 * registro (testes puros) = nunca.
 */
type SiblingsSource = (session: { id: string; parentSessionId: string }) => boolean
let siblingsSource: SiblingsSource = () => false
export function setSiblingsSource(fn: SiblingsSource): void {
  siblingsSource = fn
}

/** Subagente com irmãos (precisa de id + parentSessionId; sem eles = não). */
function hasSiblings(session: SessionRef): boolean {
  return (
    session.depth > 0 &&
    !!session.id &&
    !!session.parentSessionId &&
    siblingsSource({ id: session.id, parentSessionId: session.parentSessionId })
  )
}

type SessionRef = Pick<Session, 'depth'> & { id?: string; parentSessionId?: string | null }

/**
 * Tools disponíveis para a sessão: habilitadas no chat, na ordem fixa de TOOL_NAMES; delegate só se
 * depth < 2; ask_user e present_file só na principal (depth 0). As de gerenciar subagentes (check/wait/cancel/message) só com delegate_task disponível;
 * num SUBAGENTE, e quando o histórico é informado (request), só depois que ele criou algum
 * subagente: modelos fracos não as confundem com "responder" a quem delegou (o prefixo de cache
 * muda uma vez, no primeiro delegate). A principal as vê sempre (para planejar). Sem histórico
 * (execução de tool), é permissivo. Exceção — irmãos: um subagente (qualquer profundidade) que tem
 * irmãos recebe check_subagents + message_subagent (se habilitadas) para se coordenar com eles,
 * mesmo sem ter delegado (o prefixo de cache muda uma vez, quando surge o primeiro irmão).
 */
export function availableTools(
  chat: Chat,
  session: SessionRef,
  history?: StoredMessage[]
): ToolName[] {
  const enabled = new Set(chat.config.enabledTools ?? [])
  const canDelegate =
    enabled.has('delegate_task') &&
    session.depth < 2 &&
    (!history || session.depth === 0 || hasDelegated(history))
  let siblings: boolean | undefined // calculado só se preciso (consulta o banco)
  const siblingOk = (n: ToolName): boolean =>
    SIBLING_TOOLS.includes(n) && (siblings ??= hasSiblings(session))
  // TOOL_NAMES = as que o computador executa: as só do celular (get_location, nearby_places — §4.3.6)
  // ficam na lista do chat, mas nunca vão daqui (nem na request nem no texto das tools)
  const base = TOOL_NAMES.filter(
    (n) =>
      enabled.has(n) &&
      (n !== 'delegate_task' || session.depth < 2) &&
      // só a sessão principal pergunta ao usuário (subagentes decidem sozinhos)
      (n !== 'ask_user' || session.depth === 0) &&
      // o visualizador é do usuário: só a principal apresenta arquivos
      (n !== 'present_file' || session.depth === 0) &&
      (!SUBAGENT_TOOLS.includes(n) || canDelegate || siblingOk(n))
  )
  // memória: pela config de memória do chat (não por enabledTools), sempre no fim
  const memory = memoryToolsSource(chat, session).filter((n) => !base.includes(n))
  // skills: pela config de skills (ligadas; subagentes só com `subagents`) — depois da memória
  const skills = skillsActive(chat, session) ? SKILL_TOOL_NAMES : []
  // chamada de voz: `end_call` só nos turnos da chamada (sessão principal), salvo desligada em
  // "O agente pode encerrar a chamada" — independe de enabledTools/voice.tools (SPEC → end_call)
  const call =
    session.depth === 0 && session.id
      ? voiceCallContextFor(chat, { id: session.id, depth: session.depth })
      : null
  const voice: ToolName[] = call && call.endCall !== false ? [END_CALL_TOOL] : []
  return memory.length || skills.length || voice.length
    ? [...base, ...memory, ...skills, ...voice]
    : base
}

// ---------------- skills (SPEC → Skills) ----------------
// Só a config decide (nunca as skills descobertas): definições e prompt estáveis na sessão.

/** Skills vão para a API nesta sessão (ligadas no chat; subagente só com `skills.subagents`)? */
export function skillsActive(chat: Pick<Chat, 'config'>, session: Pick<Session, 'depth'>): boolean {
  return skillsActiveFor(normalizeSkillsConfig(chat.config.skills), session)
}

/** Prompt de apoio das skills anexado ao system prompt (null = não vai). */
export function skillsSupportPrompt(
  chat: Pick<Chat, 'config'>,
  session: Pick<Session, 'depth'>
): string | null {
  const cfg = normalizeSkillsConfig(chat.config.skills)
  if (!skillsActiveFor(cfg, session) || !cfg.supportPrompt.enabled) return null
  return cfg.supportPrompt.text ?? DEFAULT_SKILLS_SUPPORT_PROMPT
}

// ---------------- memória (SPEC → Memória) ----------------
// O main registra as fontes (main/memory/index.ts); sem registro (testes) = nada de memória.

/** Blocos de memória do system prompt (índice congelado + help). null = nada vai. */
export interface MemoryPromptBlocks {
  index: string | null
  help: string | null
}
type MemoryPromptSource = (
  chat: Chat,
  session: Pick<Session, 'depth'> & { id?: string }
) => MemoryPromptBlocks | null
type MemoryToolsSource = (chat: Chat, session: Pick<Session, 'depth'>) => ToolName[]
let memoryPromptSource: MemoryPromptSource = () => null
let memoryToolsSource: MemoryToolsSource = () => []
export function setMemorySources(src: {
  prompt: MemoryPromptSource
  tools: MemoryToolsSource
}): void {
  memoryPromptSource = src.prompt
  memoryToolsSource = src.tools
}

// ---------------- chamada de voz (SPEC → "Áudio → Chamada de voz (meia-duplex)") ----------------

/**
 * Overrides do modo voz no turno em andamento (`ResolvedVoiceCall` de `@shared/voice`); null =
 * turno de texto normal. O main registra a fonte (`src/main/ipc.ts` liga ao `VoiceCallManager`);
 * sem registro (testes puros) = nunca há chamada. O runner aplica com `applyVoiceCallChat`.
 */
export type VoiceCallContextSource = (
  chat: Pick<Chat, 'id' | 'config'>,
  session: Pick<Session, 'id' | 'depth'>
) => import('@shared/voice').ResolvedVoiceCall | null
let voiceCallContextSource: VoiceCallContextSource = () => null
export function setVoiceCallSource(fn: VoiceCallContextSource): void {
  voiceCallContextSource = fn
}
export function voiceCallContextFor(
  chat: Pick<Chat, 'id' | 'config'>,
  session: Pick<Session, 'id' | 'depth'>
): import('@shared/voice').ResolvedVoiceCall | null {
  return voiceCallContextSource(chat, session)
}

/** Nomes dos provedores configurados (o runner registra; sem registro = nenhum → sem `provider`). */
let providerNamesSource: () => string[] = () => []
export function setProviderNamesSource(fn: () => string[]): void {
  providerNamesSource = fn
}

export function toolDefinitions(
  names: ToolName[],
  providerNames: string[] = providerNamesSource()
): ToolDefinition[] {
  return names.map((n) => toolDefinitionFor(n, providerNames))
}

/**
 * Conteúdo do system prompt (string; vazio = não envia): system prompt → <environment> → memória
 * (índice + help, só na principal com memória ativa) → prompt de apoio das skills (se ligado) →
 * texto das tools (modo texto).
 */
export function systemContent(
  chat: Chat,
  session: Pick<Session, 'depth'> & { id?: string },
  env: EnvInfo = defaultEnvInfo(),
  history?: StoredMessage[]
): string {
  const cfg = chat.config
  let s = session.depth === 0 ? (cfg.systemPrompt ?? '') : (cfg.subagentSystemPrompt ?? '')
  const add = (block: string): void => {
    if (!block) return
    s = s ? `${s}\n\n${block}` : block
  }
  if (cfg.envInPrompt) add(environmentBlock(cfg, env))
  const memory = memoryPromptSource(chat, session)
  if (memory) {
    add(memory.index ?? '')
    add(memory.help ?? '')
  }
  add(skillsSupportPrompt(chat, session) ?? '')
  if (cfg.toolsInPrompt) {
    const defs = toolDefinitions(availableTools(chat, session, history))
    add(
      cfg.toolsPromptText ??
        defaultToolsPrompt(defs, cfg.nativeTools, { subagent: session.depth > 0 })
    )
  }
  return s
}

export function parseExtraBody(extra: string | undefined): Record<string, unknown> | null {
  if (extra == null || !extra.trim()) return null
  let v: unknown
  try {
    v = JSON.parse(extra)
  } catch (e) {
    throw new Error(`extraBody não é um JSON válido: ${(e as Error).message}`, { cause: e })
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('extraBody deve ser um objeto JSON (ex.: {"chave": "valor"}).')
  }
  return v as Record<string, unknown>
}

/**
 * Sanitiza o histórico para envio (determinístico → estável para cache):
 * - descarta mensagens 'tool' órfãs (sem tool_call correspondente no assistant anterior);
 * - insere resultados placeholder para tool_calls sem resposta (ex.: usuário apagou a msg tool);
 * - remove `reasoning` dos assistants quando o provider não é OpenRouter.
 */
export function sanitizeHistory(messages: ApiMessage[], keepReasoning: boolean): ApiMessage[] {
  const out: ApiMessage[] = []
  let pending: string[] = [] // ids de tool_calls aguardando resposta
  const flush = (): void => {
    for (const id of pending) {
      out.push({ role: 'tool', tool_call_id: id, content: '[Resultado indisponível]' })
    }
    pending = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      const i = pending.indexOf(m.tool_call_id)
      if (i === -1) continue // órfã
      pending.splice(i, 1)
      out.push(m)
      continue
    }
    flush()
    if (m.role === 'assistant') {
      let a = m
      if (!keepReasoning && 'reasoning' in a) {
        const { reasoning: _r, ...rest } = a
        void _r
        a = rest
      }
      if (a.tool_calls && a.tool_calls.length === 0) {
        const { tool_calls: _t, ...rest } = a
        void _t
        a = rest
      }
      out.push(a)
      pending = (a.tool_calls ?? []).map((t) => t.id)
    } else {
      out.push(m)
    }
  }
  flush()
  return out
}

/** Mensagem como vai no fio: igual a ApiMessage, mas qualquer content pode virar parts (cópia com cache_control). */
export type WireMessage =
  | ApiMessage
  | { role: 'assistant'; content: ContentPart[]; tool_calls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; tool_call_id: string; content: ContentPart[] }

/**
 * Marca o último text part de uma mensagem com cache_control (na CÓPIA). Mensagem só com anexos
 * (sem text part): marca o último part (imagem/arquivo/áudio) — aceito via OpenRouter por
 * Anthropic, OpenAI e Gemini (verificado empiricamente).
 */
function withCacheControl(content: string | ContentPart[]): ContentPart[] {
  const parts: ContentPart[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : content.map((p) => ({ ...p }))
  let i = parts.length - 1
  while (i >= 0 && parts[i].type !== 'text') i--
  if (i < 0) i = parts.length - 1
  if (i >= 0) parts[i] = { ...parts[i], cache_control: { type: 'ephemeral' } }
  return parts
}

/** Cópia da mensagem com breakpoint de cache; null se não houver onde marcar (conteúdo vazio). */
function markMessage(m: ApiMessage): WireMessage | null {
  const c = m.content
  if (c == null || (typeof c === 'string' && c === '')) return null
  if (Array.isArray(c) && !c.length) return null
  return { ...m, content: withCacheControl(c) } as WireMessage
}

/**
 * Breakpoints `cache_control` (Anthropic aceita no máx. 4 por request; usamos até 3), só na CÓPIA:
 * 1. system prompt;
 * 2. a ÚLTIMA mensagem do array, de qualquer role (inclusive `tool` — verificado empiricamente
 *    via OpenRouter → Anthropic) — em loops longos de tools cada passo lê o prefixo do anterior;
 *    se ela não tiver texto marcável (ex.: assistant só com tool_calls), recua até a próxima que tenha;
 * 3. a última mensagem `user` (se ainda não marcada) — ponto estável do turno.
 */
export function applyCacheBreakpoints(messages: ApiMessage[]): WireMessage[] {
  const out: WireMessage[] = [...messages]
  if (out.length && messages[0].role === 'system') {
    out[0] = { role: 'system', content: withCacheControl(messages[0].content) }
  }
  const start = messages[0]?.role === 'system' ? 1 : 0
  let lastMarked = -1
  for (let i = messages.length - 1; i >= start; i--) {
    const marked = markMessage(messages[i])
    if (marked) {
      out[i] = marked
      lastMarked = i
      break
    }
  }
  for (let i = messages.length - 1; i >= start; i--) {
    if (messages[i].role !== 'user') continue
    if (i !== lastMarked) {
      const marked = markMessage(messages[i])
      if (marked) out[i] = marked
    }
    break
  }
  return out
}

/**
 * Monta a request EXATA da próxima chamada, no formato do adaptador do provider:
 * 'openai'/'openrouter' → `POST {baseUrl}/chat/completions`; 'anthropic' → `POST {baseUrl}/messages`
 * (ver adapters/anthropic.ts).
 * - Só o histórico a partir da fronteira de compactação mais recente (meta.kind 'compaction') vai;
 *   as mensagens anteriores continuam salvas (e visíveis), mas não são enviadas.
 * - Mensagens com meta.kind === 'error' (se existirem) não são enviadas.
 * - sanitizeHistory descarta resultados de tool órfãos logo após a fronteira (nunca envia um par
 *   tool_calls ↔ tool partido).
 */
export function buildRequest(
  chat: Chat,
  session: Pick<Session, 'depth' | 'model'> & { id?: string },
  history: StoredMessage[],
  provider: Provider,
  env: EnvInfo = defaultEnvInfo()
): BuiltRequest {
  const cfg = chat.config
  const kind = providerKind(provider)
  const openRouter = kind === 'openrouter'

  const sys = systemContent(chat, session, env, history)
  const hist = sanitizeHistory(
    activeHistory(history)
      .filter((m) => !isDisplayOnly(m.meta))
      .map((m) => m.message),
    openRouter
  )
  const messages: ApiMessage[] = []
  if (sys) messages.push({ role: 'system', content: sys })
  messages.push(...hist)

  const signature = resolveAppSignatureHeaders(
    cfg.appSignature ?? DEFAULT_APP_SIGNATURE,
    cfg.appSignatureCustom
  )
  const adapter = adapterFor(kind)
  const tools = availableTools(chat, session, history)
  const params = cfg.params ?? {}
  const extra = parseExtraBody(params.extraBody)
  // Só o que o modelo aceita (o resto fica salvo no chat, mas não vai) — ver @shared/modelParams.
  const support = filterParams(params, kind, provider.id, session.model, extra)
  const notes = support.notes.length ? { notes: support.notes } : {}

  if (kind === 'anthropic') {
    // Anexos: áudio vira placeholder (a API não aceita); demais referências → base64 (na cópia).
    const sent = expandAttachments(dropAudioParts(messages))
    return {
      url: adapter.chatUrl(provider.baseUrl),
      headers: adapter.headers(provider, signature),
      body: buildAnthropicBody({
        model: session.model,
        messages: sent,
        tools: cfg.nativeTools && tools.length ? toolDefinitions(tools) : undefined,
        params: support.send,
        cacheEnabled: cfg.cacheEnabled,
        extra
      }),
      kind,
      ...notes
    }
  }

  // Anexos: referências clearchat-attachment:// → base64 e `_attachment` removido (só na cópia).
  // Mídia de resultados de tool (read_file) → mensagem user logo após o bloco de tools (role:tool
  // só aceita texto no Chat Completions — ver hoistToolMedia).
  const sent = expandAttachments(hoistToolMedia(messages))
  const wire: WireMessage[] = cfg.cacheEnabled ? applyCacheBreakpoints(sent) : sent

  const body: Record<string, unknown> = {
    model: session.model,
    messages: wire,
    stream: true,
    stream_options: { include_usage: true }
  }

  if (cfg.nativeTools && tools.length) body.tools = toolDefinitions(tools)

  const { reasoning_effort: effort, ...sampling } = support.send
  Object.assign(body, sampling)
  if (effort) {
    if (openRouter) body.reasoning = { effort }
    else body.reasoning_effort = effort
  }
  if (openRouter) body.usage = { include: true }

  if (extra) Object.assign(body, extra)

  return {
    url: adapter.chatUrl(provider.baseUrl),
    headers: adapter.headers(provider, signature),
    body,
    kind,
    ...notes
  }
}

/** `sk-or-v1-abc…a3b9` → `sk-or-…a3b9`. */
export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 12) return '…' + key.slice(-2)
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

/** Versão para exibição (preview): qualquer header com a key (Authorization, x-api-key) mascarado. */
export function maskRequest(req: BuiltRequest, apiKey: string): BuiltRequest {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = apiKey && v.includes(apiKey) ? v.split(apiKey).join(maskKey(apiKey)) : v
  }
  return { ...req, headers }
}
