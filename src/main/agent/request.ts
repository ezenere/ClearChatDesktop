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
import { planTools, withCompactPrompt, type ToolsPlan } from '@shared/compactTools'
import {
  TOOL_SEARCH_MODE_LABEL,
  forceLoadedTools,
  isNativeMode,
  nativeToolSearchPrompt,
  nativeToolsArray,
  prepareNativeReplay,
  resolveToolSearchMode,
  sentMediaOf,
  wireToolName,
  type ToolSearchCaps,
  type ToolSearchFailure,
  type ToolSearchModeResult,
  type WireApi
} from '@shared/toolSearch'
import { activeHistory, isDisplayOnly } from '@shared/context'
import { bwrapAvailable, shellLabel } from '../tools/bash'
import { expandAttachments, hoistToolMedia } from '../attachments'
import { paramSupport, type ParamSupport } from '@shared/modelParams'
import { cachedModelInfo } from '../providers'
import { adapterFor, buildHeaders, chatCompletionsUrl } from './adapters'
import { buildAnthropicBody, dropAudioParts, messagesUrl } from './adapters/anthropic'
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
  ToolName,
  ToolSearchMode
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
   * Formato da request: 'messages' = Messages API (Anthropic nativa, ou o OpenRouter na busca
   * nativa de tools — o stream é o SSE nativo); 'chat' = Chat Completions. Ausente = pelo `kind`.
   */
  api?: WireApi
  /**
   * Notas legíveis sobre a montagem (ex.: "temperature omitido: não suportado por …") — parâmetros
   * ligados no chat que o modelo não aceita não são enviados (@shared/modelParams). O preview mostra.
   */
  notes?: string[]
  /** Busca de ferramentas desta request (protocolo 1.12.0 — @shared/toolSearch). */
  toolSearch?: RequestToolSearch
}

/** Como as tools foram nesta request (modo, motivo, adiadas/carregadas, reenvio de blocos). */
export interface RequestToolSearch {
  mode: ToolSearchMode
  reason?: string
  failure?: ToolSearchFailure
  /** Adiadas (`defer_loading`). */
  deferred: string[]
  /** Fora de `toolsFull`, mas carregadas por já terem sido usadas sem a busca no histórico enviado. */
  forceLoaded: string[]
  /** Respostas reenviadas com os blocos do provedor / que foram pela conversão normal. */
  replayed: number
  skipped: number
}

/** Opções de buildRequest (repetições do runner e a compactação). */
export interface BuildOptions {
  /** Força o modo (queda para a versão local; repetição da compactação sem tools). */
  modeOverride?: ToolSearchMode
  /** false = nenhum `native` reenviado (repetição depois de uma recusa do reenvio). */
  replay?: boolean
  /** Ids de mensagens cujo `native` não é mais reenviado nesta sessão (recusado antes). */
  noReplay?: ReadonlySet<string>
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

/** Item do /models com fallback para o id sem `:variante` (OpenRouter: `x/y:free` → `x/y`). */
function modelInfoLoose(providerId: string, model: string): ModelInfo | undefined {
  const info = modelInfoFor(providerId, model)
  if (info || !model.includes(':')) return info
  return modelInfoFor(providerId, model.replace(/:[^/:]*$/, ''))
}

// ---------------- busca nativa de tools (protocolo 1.12.0 — @shared/toolSearch) ----------------

/** Falhas lembradas da busca nativa (`toolSearchCaps`, local). O main registra; testes trocam. */
let capsSource: () => ToolSearchCaps = () => ({})
export function setToolSearchCapsSource(fn: () => ToolSearchCaps): void {
  capsSource = fn
}

/**
 * Hosts extras tratados como o host oficial (só testes: provedor FALSO local fazendo papel da
 * Anthropic/OpenRouter). Env `CLEARCHAT_E2E_NATIVE_HOSTS` (lista por vírgula) ou o setter.
 */
let nativeTestHosts: string[] = (process.env.CLEARCHAT_E2E_NATIVE_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
export function setNativeTestHosts(hosts: string[]): void {
  nativeTestHosts = hosts.map((h) => h.toLowerCase())
}
export const nativeHostsForTests = (): string[] => [...nativeTestHosts]

/** Mensagens que vão na request (fronteira em diante, sem as só de exibição). */
const sentMessages = (history: StoredMessage[]): StoredMessage[] =>
  activeHistory(history).filter((m) => !isDisplayOnly(m.meta))

/**
 * Modo de envio das tools para esta sessão/provedor/modelo (@shared/toolSearch →
 * resolveToolSearchMode): o mesmo na request, no preview, na execução e na aba Tools.
 */
export function resolveToolMode(
  chat: Chat,
  session: SessionRef & { model: string },
  history: StoredMessage[] | undefined,
  provider: Pick<Provider, 'id' | 'baseUrl' | 'kind'>
): ToolSearchModeResult {
  const local = toolsPlan(chat, session, history, undefined, 'local')
  return resolveToolSearchMode({
    kind: providerKind(provider),
    baseUrl: provider.baseUrl,
    providerId: provider.id,
    model: session.model,
    info: modelInfoLoose(provider.id, session.model),
    cfg: chat.config,
    wouldCompact: local.compacted.length > 0,
    sent: history ? sentMediaOf(sentMessages(history).map((m) => m.message)) : null,
    caps: capsSource(),
    extraHosts: nativeTestHosts
  })
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
 * As definições chegam ao modelo? (campo `tools`, ou o texto das tools GERADO pelo app no system
 * prompt — um `toolsPromptText` escrito pelo usuário vai como está e não leva definições).
 */
function toolsReachModel(cfg: ChatConfig): boolean {
  return cfg.nativeTools || (cfg.toolsInPrompt && cfg.toolsPromptText == null)
}

/**
 * Tools da request com a compactação (protocolo 1.11.0 — @shared/compactTools): as disponíveis da
 * sessão (completas, ajustadas aos provedores) → na versão local, compactas as que não estão em
 * `toolsFull` (com a compactação ligada), `tool_search` no fim e o prompt fixo, se alguma foi
 * compacta; nos modos de busca nativa (1.12.0), as mesmas vão completas e ADIADAS. Vale para os
 * turnos normais, subagentes e a chamada de voz (`end_call` sempre completa). Sem tools chegando ao
 * modelo (sem tools nativas e sem o texto gerado) → nada é compactado. Usado na request, no
 * preview, na execução (`tool_search`, erro de argumentos) e na estimativa da compactação.
 * `mode` padrão 'local' (o de 1.11.0) — quem monta a request passa o modo resolvido.
 */
export function toolsPlan(
  chat: Chat,
  session: SessionRef,
  history?: StoredMessage[],
  providerNames?: string[],
  mode: ToolSearchMode = 'local'
): ToolsPlan {
  const full = toolDefinitions(availableTools(chat, session, history), providerNames)
  if (!toolsReachModel(chat.config)) return planTools(full, chat.config, 'off')
  return planTools(full, chat.config, mode)
}

/**
 * Conteúdo do system prompt (string; vazio = não envia): system prompt → <environment> → memória
 * (índice + help, só na principal com memória ativa) → prompt de apoio das skills (se ligado) →
 * texto das tools (modo texto; o gerado segue a compactação) → prompt fixo das tools compactadas
 * (versão local com alguma compacta) ou o prompt fixo NATIVO (busca nativa com alguma adiada).
 */
export function systemContent(
  chat: Chat,
  session: Pick<Session, 'depth'> & { id?: string },
  env: EnvInfo = defaultEnvInfo(),
  history?: StoredMessage[],
  mode: ToolSearchMode = 'local',
  /** Prompt fixo no lugar do do plano (buildRequest: o nativo com as adiadas efetivas). */
  promptOverride?: string | null
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
  const plan = toolsPlan(chat, session, history, undefined, mode)
  if (cfg.toolsInPrompt) {
    add(
      cfg.toolsPromptText ??
        defaultToolsPrompt(plan.definitions, cfg.nativeTools, { subagent: session.depth > 0 })
    )
  }
  return withCompactPrompt(s, promptOverride === undefined ? plan : { prompt: promptOverride })
}

/** Reenvio de blocos nativos + adiadas efetivas de uma request nativa (ver nativeDeferral). */
export interface NativeDeferral {
  /** Histórico (sanitizado) com `native` só nas mensagens reenviadas. */
  messages: ApiMessage[]
  replayed: number
  skipped: number
  /** Fora de `toolsFull`, mas carregadas: usadas no histórico enviado sem a descoberta junto. */
  forceLoaded: string[]
  /** As que vão de fato com `defer_loading` (o prompt fixo nativo lista estas). */
  deferred: string[]
}

/**
 * Num modo nativo: quais respostas vão com os blocos do provedor (mesmo canal, ainda batendo com o
 * texto; referências filtradas às tools da request) e quais adiadas vão carregadas por já terem
 * sido usadas sem a descoberta junto. A mesma conta da request serve a aba Tools (o `<>` mostra o
 * que vai).
 */
export function nativeDeferral(
  plan: Pick<ToolsPlan, 'mode' | 'full' | 'deferred'>,
  sanitized: ApiMessage[],
  channel: { providerId: string; model: string } | null
): NativeDeferral {
  if (!isNativeMode(plan.mode))
    return { messages: sanitized, replayed: 0, skipped: 0, forceLoaded: [], deferred: [] }
  const names = new Set(plan.full.map((d) => d.function.name))
  const r = prepareNativeReplay(sanitized, channel ? { mode: plan.mode, ...channel } : null, names)
  const forceLoaded = forceLoadedTools(r.messages, plan.deferred, r.discovered)
  return {
    messages: r.messages,
    replayed: r.replayed,
    skipped: r.skipped,
    forceLoaded,
    deferred: plan.deferred.filter((n) => !forceLoaded.includes(n))
  }
}

/** Histórico que vai na request (sanitizado; `noReplay` tira o `native` dessas mensagens). */
export function sentHistory(
  history: StoredMessage[],
  kind: ProviderKind,
  keepNative: boolean,
  noReplay?: ReadonlySet<string>
): ApiMessage[] {
  const stored = sentMessages(history).map((m) =>
    noReplay?.has(m.id) && m.message.role === 'assistant' && m.message.native
      ? { ...m, message: { ...m.message, native: undefined } }
      : m
  )
  return sanitizeHistory(
    stored.map((m) => m.message),
    kind === 'openrouter',
    keepNative
  )
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
 * - remove `reasoning` dos assistants quando o provider não é OpenRouter;
 * - remove `native` (blocos do provedor, 1.12.0) salvo `keepNative` (modo de busca nativa — quem
 *   monta confere o reenvio em prepareNativeReplay); nunca vai para outro formato de API;
 * - chamadas antigas de `search_tool` vão como `tool_search` (o nome novo — só na cópia; o
 *   histórico salvo não muda).
 */
export function sanitizeHistory(
  messages: ApiMessage[],
  keepReasoning: boolean,
  keepNative = false
): ApiMessage[] {
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
      if (!keepNative && 'native' in a) {
        const { native: _n, ...rest } = a
        void _n
        a = rest
      }
      if (a.tool_calls?.some((t) => wireToolName(t.function.name) !== t.function.name)) {
        a = {
          ...a,
          tool_calls: a.tool_calls.map((t) =>
            wireToolName(t.function.name) === t.function.name
              ? t
              : { ...t, function: { ...t.function, name: wireToolName(t.function.name) } }
          )
        }
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
 * (ver adapters/anthropic.ts). Na busca nativa de tools do OpenRouter (1.12.0), `POST
 * {baseUrl}/messages` no formato da Messages API (o mesmo adaptador, `flavor: 'openrouter'`).
 * - Só o histórico a partir da fronteira de compactação mais recente (meta.kind 'compaction') vai;
 *   as mensagens anteriores continuam salvas (e visíveis), mas não são enviadas.
 * - Mensagens com meta.kind === 'error' (se existirem) não são enviadas.
 * - sanitizeHistory descarta resultados de tool órfãos logo após a fronteira (nunca envia um par
 *   tool_calls ↔ tool partido).
 * - Modo das tools (@shared/toolSearch): resolvido aqui (ou `opts.modeOverride`); nos nativos, as
 *   fora de `toolsFull` vão com `defer_loading` + a busca do servidor por último, os blocos nativos
 *   das respostas anteriores são reenviados (mesmo canal e ainda batendo com o texto) e uma adiada
 *   usada no histórico sem a descoberta junto vai carregada.
 */
export function buildRequest(
  chat: Chat,
  session: Pick<Session, 'depth' | 'model'> & { id?: string },
  history: StoredMessage[],
  provider: Provider,
  env: EnvInfo = defaultEnvInfo(),
  opts: BuildOptions = {}
): BuiltRequest {
  const cfg = chat.config
  const kind = providerKind(provider)
  const openRouter = kind === 'openrouter'

  const resolved: ToolSearchModeResult = opts.modeOverride
    ? { mode: opts.modeOverride, api: kind === 'anthropic' ? 'messages' : 'chat' }
    : resolveToolMode(chat, session, history, provider)
  // compactação: as definições como vão (1.11.0: compactas + tool_search; 1.12.0: completas e
  // adiadas nos modos nativos). planTools rebaixa para 'off' quando não há o que compactar/adiar.
  const plan = toolsPlan(chat, session, history, undefined, resolved.mode)
  const mode = plan.mode
  const native = isNativeMode(mode)

  // reenvio dos blocos nativos (mesmo provedor/API/modelo, ainda batendo com o texto) e as
  // adiadas que já foram usadas sem a descoberta no histórico enviado → carregadas
  const nd = nativeDeferral(
    plan,
    sentHistory(history, kind, native, opts.noReplay),
    opts.replay === false ? null : { providerId: provider.id, model: session.model }
  )
  const hist = nd.messages
  // prompt fixo: o da versão local, ou o nativo com as adiadas EFETIVAS desta request
  const sys = systemContent(
    chat,
    session,
    env,
    history,
    mode,
    native && isNativeMode(mode) ? nativeToolSearchPrompt(nd.deferred, mode) : undefined
  )
  const toolSearch: RequestToolSearch = {
    mode,
    ...(resolved.reason && mode === 'local' ? { reason: resolved.reason } : {}),
    ...(resolved.failure && mode === 'local' ? { failure: resolved.failure } : {}),
    deferred: nd.deferred,
    forceLoaded: nd.forceLoaded,
    replayed: nd.replayed,
    skipped: nd.skipped
  }
  const messages: ApiMessage[] = []
  if (sys) messages.push({ role: 'system', content: sys })
  messages.push(...hist)

  const signature = resolveAppSignatureHeaders(
    cfg.appSignature ?? DEFAULT_APP_SIGNATURE,
    cfg.appSignatureCustom
  )
  const adapter = adapterFor(kind)
  const tools = plan.definitions
  const params = cfg.params ?? {}
  const extra = parseExtraBody(params.extraBody)
  // Só o que o modelo aceita (o resto fica salvo no chat, mas não vai) — ver @shared/modelParams.
  const support = filterParams(params, kind, provider.id, session.model, extra)
  const notes = [...toolSearchNotes(toolSearch, plan.full.length), ...support.notes]
  const extras = { ...(notes.length ? { notes } : {}), toolSearch }

  if (native) {
    // Messages API: Anthropic nativa ou o /messages do OpenRouter (Bearer, assinatura de app)
    const sent = expandAttachments(dropAudioParts(messages))
    const toolsArray = cfg.nativeTools
      ? nativeToolsArray(plan.full, {
          deferred: new Set(toolSearch.deferred),
          entry: plan.searchEntry,
          cache: cfg.cacheEnabled
        })
      : undefined
    return {
      url: openRouter ? messagesUrl(provider.baseUrl) : adapter.chatUrl(provider.baseUrl),
      headers: openRouter
        ? buildHeaders(provider, signature)
        : adapter.headers(provider, signature),
      body: buildAnthropicBody({
        model: session.model,
        messages: sent,
        toolsArray,
        params: support.send,
        cacheEnabled: cfg.cacheEnabled,
        extra,
        flavor: openRouter ? 'openrouter' : 'anthropic',
        replayNative: true
      }),
      kind,
      api: 'messages',
      ...extras
    }
  }

  if (kind === 'anthropic') {
    // Anexos: áudio vira placeholder (a API não aceita); demais referências → base64 (na cópia).
    const sent = expandAttachments(dropAudioParts(messages))
    return {
      url: adapter.chatUrl(provider.baseUrl),
      headers: adapter.headers(provider, signature),
      body: buildAnthropicBody({
        model: session.model,
        messages: sent,
        tools: cfg.nativeTools && tools.length ? tools : undefined,
        params: support.send,
        cacheEnabled: cfg.cacheEnabled,
        extra
      }),
      kind,
      api: 'messages',
      ...extras
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

  if (cfg.nativeTools && tools.length) body.tools = tools

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
    api: 'chat',
    ...extras
  }
}

/** Notas do preview sobre a busca de ferramentas (só quando há o que dizer). */
function toolSearchNotes(t: RequestToolSearch, total: number): string[] {
  const out: string[] = []
  if (isNativeMode(t.mode)) {
    out.push(
      `Busca de ferramentas: ${TOOL_SEARCH_MODE_LABEL[t.mode]} — ${total - t.deferred.length} carregada${total - t.deferred.length === 1 ? '' : 's'}, ${t.deferred.length} adiada${t.deferred.length === 1 ? '' : 's'} (defer_loading).`
    )
    if (t.replayed || t.skipped)
      out.push(
        `${t.replayed} resposta${t.replayed === 1 ? '' : 's'} reenviada${t.replayed === 1 ? '' : 's'} com os blocos nativos do provedor${t.skipped ? `; ${t.skipped} pela conversão normal (outro provedor/modelo, editada ou reenvio recusado)` : ''}.`
      )
    if (t.forceLoaded.length)
      out.push(
        `Carregadas por já terem sido usadas sem a busca no histórico enviado: ${t.forceLoaded.join(', ')}.`
      )
  } else if (t.mode === 'local' && t.reason)
    out.push(`Busca de ferramentas: ${TOOL_SEARCH_MODE_LABEL.local} — ${t.reason}.`)
  return out
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
