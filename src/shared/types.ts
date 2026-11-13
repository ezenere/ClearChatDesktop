import type { MemoryConfig, MemoryExtractionResult } from './memory'
import type { SkillPartMeta, SkillsConfig } from './skills'
import type { VoiceCallConfig } from './voice'
import type { AutoTitleRecord } from './autoTitle'
import type { VoiceCallMark, VoiceMessageMeta } from './voiceCallMarks'
// Contrato compartilhado entre main, preload e renderer. Ver SPEC.md → "Tipos compartilhados".

export interface Provider {
  id: string
  name: string
  /** Adaptador (ver providerKinds.ts). Ausente = inferido pela baseUrl (`providerKind()`). */
  kind?: import('./providerKinds').ProviderKind
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
  createdAt: number
}

export interface ModelInfo {
  id: string
  name?: string
  contextLength?: number
  promptPrice?: number
  completionPrice?: number
  supportsTools?: boolean
  /** Modalidades de entrada (OpenRouter `architecture.input_modalities`: text, image, file, audio, video). Ausente = desconhecido. */
  inputModalities?: string[]
  /**
   * Chaves de ChatParams que o modelo aceita (OpenRouter `supported_parameters`, mapeado em
   * @shared/modelParams). Ausente = desconhecido → todas (Anthropic usa uma tabela por modelo).
   */
  supportedParams?: string[]
  /**
   * Raciocínio informado pela API (OpenRouter: objeto `reasoning` do /models; Anthropic nativa:
   * `capabilities.effort`). Ausente = a API não informa (ver @shared/modelParams → effortSpec).
   */
  reasoning?: ModelReasoningInfo
  /**
   * OpenRouter: caminhos de API que servem o modelo (`endpoints` do /models — ex.:
   * `/api/v1/messages`). Ausente = desconhecido. Cache local, não sincroniza (@shared/toolSearch).
   */
  endpoints?: string[]
}

/** Níveis de esforço conhecidos (ordem crescente). */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelReasoningInfo {
  /**
   * Níveis aceitos (ordem crescente). `null` = a API diz que todos os níveis do gateway valem
   * (OpenRouter `supported_efforts: null`); ausente = a API não lista níveis.
   */
  efforts?: ReasoningEffort[] | null
  /** Nível padrão do modelo (OpenRouter `default_effort`). */
  defaultEffort?: ReasoningEffort
  /** Raciocínio obrigatório (OpenRouter `mandatory`: não aceita `effort: "none"`). */
  mandatory?: boolean
  /** Anthropic nativa: `capabilities.effort.supported` (false = não aceita effort). */
  effortSupported?: boolean
  /**
   * Raciocínio ligado por padrão (OpenRouter `default_enabled`; false = só pensa se pedido). Usado
   * pelas chamadas laterais (@shared/sideReasoning) quando os níveis não são informados.
   */
  defaultEnabled?: boolean
}

/** Só campos definidos (≠ undefined/null) vão para a request. */
export interface ChatParams {
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  frequency_penalty?: number
  presence_penalty?: number
  repetition_penalty?: number
  seed?: number
  /**
   * OpenRouter: vira `{ reasoning: { effort } }`; openai genérico: `reasoning_effort`; Anthropic
   * nativa: `output_config: { effort }`. Níveis válidos por modelo: @shared/modelParams → effortSpec.
   */
  reasoning_effort?: ReasoningEffort
  /** JSON livre, merge raso no body (último a ser aplicado). */
  extraBody?: string
}

export type ToolName =
  | 'list_dir'
  | 'read_file'
  | 'search_files'
  | 'find_files'
  | 'present_file'
  | 'write_file'
  | 'edit_file'
  | 'shell'
  | 'web_search'
  | 'browse_url'
  | 'list_models'
  | 'delegate_task'
  | 'get_chat_info'
  | 'list_chats'
  | 'send_to_chat'
  | 'read_history'
  | 'check_subagents'
  | 'wait_subagents'
  | 'cancel_subagent'
  | 'message_subagent'
  | 'process_start'
  | 'process_logs'
  | 'process_list'
  | 'process_stop'
  | 'ask_user'
  // data e hora do aparelho que roda o turno (protocolo 1.11.0; portátil, sem aprovação)
  | 'datetime'
  // memória modular (SPEC → Memória): disponibilidade pela config de memória, não por enabledTools
  | 'memory_search'
  | 'memory_read'
  | 'memory_write'
  | 'memory_rewrite'
  | 'memory_delete'
  // skills (SPEC → Skills): disponibilidade pela config de skills, não por enabledTools
  | 'list_skills'
  | 'skill_load'
  | 'skill_read'
  // chamada de voz: só nos turnos da chamada (SPEC → Chamada de voz → end_call), nunca por enabledTools
  | 'end_call'
  // tools compactadas (protocolo 1.11.0, @shared/compactTools): automática da versão local, nunca
  // escolhível. Desde 1.12.0 `tool_search` (antes `search_tool` — alias de leitura em TOOL_ALIASES)
  | 'tool_search'

/**
 * Tools cujo padrão global é PERGUNTAR (modo `lists`; ver approvalPolicy.ts) — os itens Comandos,
 * Processos, Páginas e Busca web. `process_stop` NÃO está aqui: o agente só enxerga/para processos
 * do próprio chat (registro por chat em tools/processes.ts), então nunca pede confirmação.
 */
export const CONFIRM_TOOLS: ToolName[] = ['shell', 'process_start', 'web_search', 'browse_url']
/**
 * Item de aprovação (um por tool): shell · process_start · browse_url · web_search · write_file ·
 * edit_file · send_to_chat · delegate_task.
 */
export type ApprovalItem =
  | 'commands'
  | 'processes'
  | 'pages'
  | 'search'
  | 'writeFile'
  | 'editFile'
  | 'sendToChat'
  | 'delegate'
  // memória: ids iguais aos nomes das tools (padrão global "Sempre permitir")
  | 'memory_write'
  | 'memory_rewrite'
  | 'memory_delete'
/**
 * always = sempre permitir · smart = Smart-Approve decide · lists = whitelist/blacklist
 * (commands/processes/pages; nos demais itens = "Perguntar").
 */
export type ApprovalMode = 'always' | 'smart' | 'lists'
/** Listas globais (settings `approvalLists`): padrões de comando/processo ou domínios/prefixos de URL. */
export interface ApprovalList {
  allow: string[]
  deny: string[]
}
export type ApprovalListItem = 'commands' | 'processes' | 'pages'
export interface ApprovalSettings {
  /** Modo global por item (settings `approvalModes`). */
  modes: Record<ApprovalItem, ApprovalMode>
  /** Listas globais (settings `approvalLists`) — nunca por chat. */
  lists: Record<ApprovalListItem, ApprovalList>
  /**
   * Padrões globais do Smart-Approve (setting `smartApproveDefaults`, sincronizado): descrição do
   * ambiente, "Aceitar edições dentro da raiz", coleta automática de contexto e prompts do resumidor.
   */
  smart: SmartApproveDefaults
}

/**
 * Renomes que a migração única do banco aplica (`src/main/migrateTools.ts` → @shared/toolRename):
 * só `bash` → `shell`. O renome `search_tool` → `tool_search` (1.12.0) NÃO entra aqui: o histórico
 * nunca é regravado (é só alias de leitura + troca na cópia enviada).
 */
export const STORED_TOOL_RENAMES: Record<string, ToolName> = { bash: 'shell' }

/** Nomes antigos de tools → atuais (alias de leitura: configs/históricos antigos, modelos). */
export const TOOL_ALIASES: Record<string, ToolName> = {
  ...STORED_TOOL_RENAMES,
  search_tool: 'tool_search'
}

/** Lista de ToolName com aliases antigos mapeados (sem duplicatas, ordem preservada). */
export function normalizeToolList(list: unknown): ToolName[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: ToolName[] = []
  for (const t of list) {
    if (typeof t !== 'string') continue
    const n = (TOOL_ALIASES[t] ?? t) as ToolName
    if (!out.includes(n)) out.push(n)
  }
  return out
}

export interface ChatConfig {
  providerId: string
  model: string
  systemPrompt: string
  params: ChatParams
  enabledTools: ToolName[]
  /** Envia definições no campo `tools` da API (padrão true). */
  nativeTools: boolean
  /** Anexa toolsPromptText ao system prompt (padrão false). */
  toolsInPrompt: boolean
  /** null = texto padrão gerado (defaults.ts); editável. */
  toolsPromptText: string | null
  /**
   * "Enviar tools compactadas" (protocolo 1.11.0, @shared/compactTools): cada tool fora de
   * `toolsFull` vai só com o nome + a descrição curta do app (esquema vazio) e a `tool_search`
   * devolve a definição completa — ou, desde 1.12.0, onde há busca nativa do provedor, vai completa
   * e adiada (`defer_loading`, @shared/toolSearch). Ausente = true (padrão do app).
   */
  toolsCompact?: boolean
  /** Com a compactação, estas vão completas (as de `enabledTools`, memória e skills). Ausente = []. */
  toolsFull?: ToolName[]
  /** Anexa bloco <environment> (cwd, SO, shell) ao system prompt (padrão true). */
  envInPrompt: boolean
  /** Adiciona breakpoints cache_control (padrão: true se baseUrl contém openrouter.ai). */
  cacheEnabled: boolean
  /** System prompt dos subagentes. */
  subagentSystemPrompt: string
  /** Diretório raiz (workspace) da sessão — absoluto. Compartilhado por todas as subsessões. */
  cwd: string
  /** Tools de arquivo rejeitam caminhos fora do diretório raiz (após realpath). Padrão true. */
  confineToRoot: boolean
  /** Roda o shell (tool `shell` e process_start) via bubblewrap (raiz gravável, resto do FS somente leitura). Padrão false. */
  sandboxBash: boolean
  /** Janela de contexto (tokens) — sobrescreve a informada pelo provider (/models). */
  contextWindow?: number | null
  /** Fração da janela a partir da qual o app sugere compactar (padrão 0.9). */
  compactThreshold: number
  /** Compacta automaticamente a sessão principal ao atingir o limite (subsessões: sempre). */
  autoCompact: boolean
  /** Prompt de compactação; null = DEFAULT_COMPACT_PROMPT. */
  compactPrompt: string | null
  /** Limite de caracteres do resultado de cada tool enviado ao modelo (padrão 30000). */
  maxToolOutputChars: number
  /**
   * Ajuste por chat do modo de aprovação de cada item (ausente = padrão global, settings
   * `approvalModes`). Ver approvalPolicy.ts.
   */
  approvalModes?: Partial<Record<ApprovalItem, ApprovalMode>>
  /**
   * @deprecated (≤ 0.3.0) tools "permitir sempre neste chat". Só alias de leitura: convertido em
   * `approvalModes` (always) por migrateApprovalConfig e removido.
   */
  autoApprove?: ToolName[]
  /** Assinatura de app (headers HTTP-Referer/X-Title) — id de APP_SIGNATURES (padrão 'clearchat'; 'none' = nada). */
  appSignature: string
  /** Usada quando appSignature === 'custom'. */
  appSignatureCustom?: { referer: string; title: string }
  /** Memória modular (SPEC → Memória). Ausente = desligada. */
  memory?: MemoryConfig
  /** Skills (SPEC → Skills). Ausente = desligadas. */
  skills?: SkillsConfig
  /**
   * Chamada de voz (SPEC → Áudio → Chamada de voz). Ausente = segue os padrões (campos null herdam
   * `voiceCallDefaults` global / o próprio chat). Persona via `PRESET_FIELDS`.
   */
  voice?: VoiceCallConfig
  /**
   * Smart-Approve: o modelo "juiz" que decide as chamadas dos itens em modo `smart` (aprovar /
   * rejeitar / perguntar ao usuário). Ausente/sem modelo = esses itens perguntam. Ver smartApprove.ts.
   */
  smartApprove?: SmartApproveConfig
  /**
   * "Aceitar edições dentro da raiz do chat" (aba Tools → Aprovações; também nas personas):
   * write_file/edit_file com caminho resolvido dentro da raiz (e fora dos caminhos protegidos) rodam
   * sem perguntar nem chamar o juiz. Ausente/null = padrão global (Configurações → Aprovações,
   * desligado por padrão). Ver approvalSafety.ts.
   */
  acceptEditsInRoot?: boolean | null
  /**
   * Smart-Approve → "Contexto capturado da conversa": descrição mantida pelo resumidor (e editável
   * por você) — do chat (`main`) e de cada subagente (`sessions`). Estado do chat (não vai para as
   * personas); sincroniza com a config do chat. Ver contextCapture.ts.
   */
  capturedContext?: CapturedContextState
  /**
   * Persona (preset) de origem: o chat a HERDA AO VIVO (protocolo 1.10.0 — @shared/chatInherit):
   * cada unidade fora de `overrides` segue o valor efetivo dela (e, onde ela não define, os padrões
   * de "Novos chats"). Ausente = sem persona (valores próprios).
   */
  presetId?: string
  /**
   * Unidades próprias do chat (`model`, `params.<nome>`, `enabledTools.<tool>`,
   * `approvalModes.<item>`, `appSignature`, `smartApprove`/`memory`/`skills` e as demais chaves de
   * PresetConfig uma a uma); as outras herdam a persona. Ausente = chat anterior à 1.10.0 (ainda não
   * migrado) ou sem persona. `voice`, `cwd`, `presetId` e `capturedContext` ficam fora (sempre do
   * chat). Ver SYNC_PROTOCOL.md §4.3.6.
   */
  overrides?: Record<string, true>
}

/** Rótulos que o juiz do Smart-Approve deve responder na 1ª linha. */
export interface SmartApproveLabels {
  approve: string
  reject: string
  ask: string
}

export interface SmartApproveConfig {
  /**
   * Par provedor + modelo do juiz (qualquer provedor). O juiz decide os itens em modo `smart`
   * (approvalModes); sem modelo esses itens perguntam a você (fail-closed).
   */
  providerId: string | null
  model: string | null
  /** System prompt do juiz; null = DEFAULT_SMART_APPROVE_PROMPT. */
  prompt: string | null
  /** Template da mensagem `user` do juiz (placeholders {{tool}} etc.); null = o padrão. */
  template: string | null
  labels: SmartApproveLabels
  /** Quantas mensagens recentes da sessão entram em {{recent_context}} (padrão 6). */
  contextMessages: number
  /** Tempo máximo da chamada ao juiz, em segundos (padrão 30). Estourou → pergunta ao usuário. */
  timeoutS: number
  /**
   * "O juiz pode negar" (0.8.4; padrão false — também para quem já usava o juiz): desligado, o juiz
   * só escolhe entre aprovar e perguntar; um rótulo de rejeitar vira "perguntar" (o motivo aparece
   * no card como dica). Ligado, a rejeição é honrada (não roda; o agente recebe o motivo).
   */
  canDeny: boolean
  /**
   * "Consultar o Smart-Approve também para o que a whitelist já libera" (0.8.4; padrão false): nos
   * itens com listas (Comandos/Processos/Páginas), o juiz normalmente só decide o que as listas não
   * decidem — chamada 100% liberada pela whitelist roda sem juiz. Ligado, ela também vai ao juiz.
   */
  judgeWhitelisted: boolean
  /**
   * "Descrição do ambiente" deste chat/persona (texto livre: hosts, o que pode ser feito onde…),
   * injetada no juiz em {{environment}}. Ausente/null = a descrição global (Configurações →
   * Aprovações); '' = nenhuma neste chat.
   */
  environment?: string | null
  /**
   * "Coleta automática de contexto" (resumidor): ausente/null = o padrão global. Ver
   * contextCapture.ts.
   */
  capture?: ContextCaptureConfig | null
  /**
   * Prompts do resumidor (coleta de contexto) deste chat/persona: ausente/null = os globais
   * (Configurações → Aprovações → Padrões globais). Ver contextCapture.ts.
   */
  capturePrompts?: CapturePrompts | null
  /**
   * "Tokens de pensamento" do juiz (0.8.8): só valem em modelo de raciocínio obrigatório
   * (@shared/sideReasoning → modo `minimal`), somados ao `max_tokens` da chamada. Ausente/null = o
   * padrão (SIDE_THINKING.judge).
   */
  thinkingTokens?: number | null
  /**
   * "Cache do prompt" do juiz (0.8.8): `cache_control` no fim do system e no {{cache_break}} do
   * template (@shared/sideCache). Ausente = ligado; só `false` é gravado.
   */
  cache?: boolean
  /**
   * @deprecated (≤ 0.4.0) liga/desliga. Só alias de leitura: migrateSmartApproveConfig converte
   * (ver approvalPolicy.ts) e remove. Hoje o juiz age nos itens em modo `smart` quando há modelo.
   */
  enabled?: boolean
  /**
   * @deprecated (≤ 0.4.0) tools "extras" avaliadas pelo juiz (write_file, edit_file, send_to_chat,
   * delegate_task). Viraram itens de aprovação: migrateSmartApproveConfig converte em modo `smart`.
   */
  tools?: ToolName[]
}

export type SmartApproveDecision = 'approve' | 'reject' | 'ask'

/** Categoria que o juiz dá ao perguntar/negar (rótulo fixo; ver SMART_CATEGORIES). */
export type SmartApproveCategory =
  | 'destructive'
  | 'secrets'
  | 'deploy'
  | 'system'
  | 'shared-history'
  | 'spending'
  | 'out-of-scope'
  | 'uncertain'

/** Coleta automática de contexto (resumidor do Smart-Approve). */
export interface ContextCaptureConfig {
  /** Ligada (só age com modelo escolhido e algum item em Smart-Approve). */
  enabled: boolean
  /** Modelo do resumo (qualquer provedor; independente do juiz). */
  providerId: string | null
  model: string | null
  /** max_tokens da chamada (null = padrão pequeno). */
  maxTokens: number | null
  /** Quantas mensagens do agente (só o texto dele) antes da sua entram como contexto (1–10). */
  lookback: number
  /**
   * "Tokens de pensamento" do resumidor (0.8.8): só em modelo de raciocínio obrigatório, somados ao
   * `max_tokens`. Ausente/null = o padrão (SIDE_THINKING.capture).
   */
  thinkingTokens?: number | null
  /** "Cache do prompt" do resumidor (0.8.8; system + descrição atual). Ausente = ligado. */
  cache?: boolean
}

/**
 * Prompts editáveis do resumidor (cada um null = o padrão de defaults.ts). O template precisa de
 * {{current}} e {{user}} — sem eles o app usa o template padrão (validateCapturePrompts).
 */
export interface CapturePrompts {
  /** System da chamada de resumo; null = DEFAULT_CONTEXT_CAPTURE_PROMPT. */
  prompt: string | null
  /** Mensagem user da chamada de resumo; null = DEFAULT_CONTEXT_CAPTURE_TEMPLATE. */
  template: string | null
  /** System da derivação da descrição de um subagente; null = DEFAULT_CONTEXT_DERIVE_PROMPT. */
  derivePrompt: string | null
}

/** Uma descrição capturada (do chat ou de um subagente). */
export interface CapturedEntry {
  text: string
  updatedAt: number
  /** Quem escreveu a versão atual. */
  by: 'model' | 'user' | 'derived'
  /** Versão anterior (desfazer a última mudança). */
  prev?: { text: string; updatedAt: number; by: CapturedEntry['by'] }
  /** Última mensagem já resumida (o resumidor nunca reenvia o que já processou). */
  cursor?: { id: string; seq: number; at: number }
  /** Última chamada ao resumidor. */
  lastRun?: {
    at: number
    providerId: string
    model: string
    decision?: 'keep' | 'append' | 'rewrite'
    error?: string
    usage?: Usage
    durationMs: number
    /** Linhas descartadas pela trava "só o que o usuário disse" (cópia do texto do agente). */
    dropped?: number
  }
  /** Soma das chamadas (custo fora do histórico). */
  calls?: number
  cost?: number
}

export interface CapturedContextState {
  main?: CapturedEntry
  /** Subagentes (sessionId → descrição derivada do pai + tarefa). */
  sessions?: Record<string, CapturedEntry>
}

/**
 * Padrões GLOBAIS do Smart-Approve/aprovações (setting `smartApproveDefaults`, Configurações →
 * Aprovações; sincroniza desde o protocolo 1.4.0 — ver SPEC → Sync).
 */
export interface SmartApproveDefaults {
  environment: string
  acceptEditsInRoot: boolean
  capture: ContextCaptureConfig
  /** Prompts do resumidor (cada um null = o padrão). */
  capturePrompts: CapturePrompts
}

/** Uma avaliação do juiz (meta da mensagem tool e da ApprovalRequest). Nunca entra no histórico enviado. */
export interface SmartApproveRecord {
  decision: SmartApproveDecision
  reason: string
  /** Por que caiu em 'ask' sem o juiz pedir: erro HTTP/rede, tempo esgotado ou resposta ambígua. */
  fallback?: 'error' | 'timeout' | 'ambiguous'
  error?: string
  providerId: string
  model: string
  usage?: Usage
  durationMs: number
  /** Request exata enviada ao juiz (key mascarada) — para o (i). */
  request?: { url: string; headers: Record<string, string>; body: unknown; notes?: string[] }
  /** Texto bruto da resposta do juiz (cortado). */
  response?: string
  /** O usuário clicou "Executar mesmo assim" depois de uma rejeição. */
  overridden?: boolean
  /**
   * O juiz respondeu o rótulo de rejeitar, mas "O juiz pode negar" está desligado: a decisão virou
   * 'ask' (o card mostra "o Smart-Approve sugeriu perguntar" com o motivo).
   */
  wouldReject?: boolean
  /** Itens (sub-comandos/URL) que o juiz avaliou — os demais já estavam liberados pela whitelist. */
  judged?: string[]
  /** Categoria dada pelo juiz ao perguntar/negar (linha `CATEGORY:`; ausente em templates antigos). */
  category?: SmartApproveCategory
}

/**
 * Persona: preset reutilizável de configuração de chat. `config` é um snapshot parcial de
 * ChatConfig (ver PRESET_FIELDS em presets.ts); campos ausentes seguem os padrões do app.
 */
export interface Preset {
  id: string
  name: string
  description: string
  /** Emoji ou nome de ícone lucide (ver PRESET_ICONS no renderer). */
  icon: string
  config: Partial<ChatConfig>
  createdAt: number
  updatedAt: number
}

export interface Chat {
  id: string
  title: string
  config: ChatConfig
  mainSessionId: string
  createdAt: number
  updatedAt: number
  /**
   * Chat só ao vivo de OUTRO dispositivo aberto como visualizador (sync §23.5): vem da memória do
   * main (nada no banco); o host é `hostName`.
   */
  liveViewer?: { hostDeviceId: string; hostName: string }
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'error'
  | 'interrupted'
  /** Subagente que encerrou o turno com subagentes em segundo plano pendentes: dorme até os callbacks. */
  | 'waiting'
  /** Sessão principal esperando o usuário responder um questionário (tool ask_user). */
  | 'awaiting_input'
  /** Chamada ao modelo falhou por erro de REDE: card "Tentar de novo / Cancelar" aberto (isBusy). */
  | 'awaiting_retry'

export interface Session {
  id: string
  chatId: string
  parentSessionId: string | null
  parentToolCallId: string | null
  depth: 0 | 1 | 2
  model: string
  /**
   * Provedor da subsessão (fixado ao criar). `null`/ausente na principal — ela segue
   * `chat.config.providerId` — e em subsessões antigas (→ o do chat). Ver `sessionProviderId`.
   */
  providerId?: string | null
  title: string
  task: string | null
  status: SessionStatus
  createdAt: number
  /**
   * Ramo ativo da árvore de mensagens: { [parentId | "root"]: childId | null }. Chave ausente ou
   * filho inexistente → o filho mais novo; `null` → o caminho termina ali (transitório). Vazio =
   * chat linear. Ver `src/shared/branches.ts`.
   */
  branchSel?: Record<string, string | null>
}

// Formato OpenAI exato — é o que é persistido e reenviado byte-a-byte (essencial para token caching)
// Anexos (ver SPEC.md → "Anexos"): persistidos com `_attachment` (campo privado, nunca enviado) e,
// nos binários, uma referência `clearchat-attachment://<sha256>.<ext>` no lugar do base64 — o
// buildRequest expande para data URL/base64 na cópia enviada (mesmos bytes sempre → cacheável).
export type CacheControl = { type: 'ephemeral' }

/** Tipo de anexo: define como ele é codificado na request. */
export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'text'

/** Metadados de um anexo (persistidos no part como `_attachment`; nunca vão para a API). */
export interface AttachmentMeta {
  name: string
  mime: string
  /** Bytes do arquivo original. */
  size: number
  kind: AttachmentKind
  /** Arquivo no store de anexos: `<sha256>.<ext>` (content-addressed). */
  file: string
  /** text: o conteúdo foi cortado no limite de caracteres. */
  truncated?: boolean
}

export type ContentPart =
  | {
      type: 'text'
      text: string
      cache_control?: CacheControl
      _attachment?: AttachmentMeta
      /** Invocação manual de skill (bloco <skill>): privado, removido na request (ver SPEC → Skills). */
      _skill?: SkillPartMeta
    }
  | {
      type: 'image_url'
      image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
      cache_control?: CacheControl
      _attachment?: AttachmentMeta
    }
  | {
      type: 'file'
      file: { filename: string; file_data: string }
      cache_control?: CacheControl
      _attachment?: AttachmentMeta
    }
  | {
      type: 'input_audio'
      input_audio: { data: string; format: string }
      cache_control?: CacheControl
      _attachment?: AttachmentMeta
    }

/** Anexo já salvo no store (resultado de attachments.pick/add) — o que agent.send recebe. */
export interface AttachmentInfo extends AttachmentMeta {
  sha256: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ApiMessage =
  | { role: 'system'; content: string | ContentPart[] }
  | { role: 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: ToolCall[]
      reasoning?: string
      /** desde 1.12.0 — blocos nativos do provedor (busca nativa de tools); SYNC §4.3.8. */
      native?: NativeTurn
    }
  /**
   * content em parts só no read_file de imagem/PDF: `[{type:'text', text:'[imagem: …]'}, <part por
   * referência>]` (ver SPEC.md → "Tools" / read_file). Os demais resultados continuam string.
   */
  | { role: 'tool'; tool_call_id: string; content: string | ContentPart[] }

/**
 * Blocos nativos de uma resposta (protocolo 1.12.0, SYNC_PROTOCOL.md §4.3.8): o `content` da
 * resposta do provedor, na ordem e sem alteração, SEM os blocos `thinking`/`redacted_thinking`.
 * Gravado só quando a resposta (num modo de busca nativa) trouxe blocos de ferramenta do servidor;
 * reenviado só ao mesmo provedor/API/modelo e se ainda bate com `content`/`tool_calls`
 * (@shared/toolSearch). Blocos de tipo desconhecido ficam como vieram (opacos).
 */
export interface NativeTurn {
  v: 1
  /** Formato dos blocos (só a Messages API por ora — Anthropic nativa e OpenRouter /messages). */
  api: 'anthropic-messages'
  /** Provedor (registro `provider` sincronizado) que gerou a resposta. */
  providerId: string
  /** Tipo do provedor na hora (informativo). */
  kind: 'anthropic' | 'openrouter'
  /** Modelo exatamente como enviado. */
  model: string
  content: Record<string, unknown>[]
}

/**
 * Modo de envio das tools de uma request (protocolo 1.12.0, @shared/toolSearch): busca nativa da
 * Anthropic, busca nativa do OpenRouter (Messages API), versão local do app (1.11.0) ou sem
 * compactação. Derivado a cada request — nunca gravado na config.
 */
export type ToolSearchMode = 'native-anthropic' | 'native-openrouter' | 'local' | 'off'

export interface Usage {
  promptTokens: number
  completionTokens: number
  cachedTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  cost?: number
}

export interface MessageMeta {
  /** Criado pelo app (não pelo usuário nem pelo modelo) — UI mostra (i) com o texto exato. */
  synthetic?: boolean
  /** 'error' = erro HTTP/modelo persistido só para exibição (synthetic; NUNCA enviado à API). */
  /** 'compaction' = fronteira de compactação (role user com o resumo; buildRequest envia daqui em diante). */
  /** 'inter-chat' = mensagem entregue por outro chat (send_to_chat), role user com cabeçalho. */
  kind?:
    | 'queued'
    | 'forced'
    | 'interrupt-notice'
    | 'tool-cancelled'
    | 'error'
    | 'compaction'
    | 'inter-chat'
    | 'subagent-callback'
    | 'parent-message'
    /** Mensagem direta de um subagente irmão (message_subagent), no irmão que recebe. */
    | 'sibling-message'
    /** Broadcast de um subagente irmão (message_subagent broadcast=true), em cada irmão que recebe. */
    | 'sibling-broadcast'
    /** Card da extração de memórias (synthetic, só exibição — NUNCA enviado à API, como 'error'). */
    | 'memory-extraction'
    /** Marcador de início/fim da chamada de voz (synthetic, só exibição — `meta.voiceCall`). */
    | 'voice-call'
  /** Resposta do assistente cortada pelo usuário. */
  interrupted?: boolean
  /**
   * Resposta do assistente (desde 1.12.0, só exibição): o modo de envio das tools em que ela foi
   * gerada e, numa queda para a versão local, de qual modo nativo veio (§4.3.8).
   */
  toolSearch?: {
    mode: 'native-anthropic' | 'native-openrouter' | 'local'
    fallbackFrom?: 'native-anthropic' | 'native-openrouter'
    reason?: string
  }
  usage?: Usage
  model?: string
  durationMs?: number
  /**
   * Resposta do assistente: tempo de raciocínio (ms) — do 1º delta de raciocínio ao 1º delta de
   * conteúdo/tool call (ou ao fim do stream). Ausente = sem raciocínio ou mensagem antiga.
   */
  reasoningMs?: number
  error?: string
  /** Em mensagens tool de delegate_task. */
  subSessionId?: string
  toolStatus?: 'ok' | 'error' | 'denied' | 'cancelled'
  /** shell: diretório do shell ao final do comando (persistido entre chamadas da sessão). */
  shellCwd?: string
  // ---- compactação (kind 'compaction') ----
  /** Faixa de seq resumida (inclusive). */
  summaryOf?: { fromSeq: number; toSeq: number }
  /** Mensagens resumidas. */
  compactedCount?: number
  /** Tokens de contexto usados antes da compactação. */
  usageBefore?: number
  /** Estimativa do contexto logo após a compactação (system + resumo) — até a próxima usage real. */
  contextEstimate?: number
  /** Usage da chamada de resumo (não faz parte do histórico enviado). */
  compactUsage?: Usage
  // ---- mensagens entre chats (kind 'inter-chat', no chat de destino) ----
  /** Chat que enviou a mensagem. */
  fromChatId?: string
  /**
   * Sessão (principal ou subagente) do chat de origem que chamou send_to_chat; em 'parent-message',
   * a sessão pai; em 'sibling-message' / 'sibling-broadcast', o irmão que enviou.
   */
  fromSessionId?: string
  /** Título do chat de origem no momento do envio (exibição se ele for apagado/renomeado). */
  fromChatTitle?: string
  /** Saltos da cadeia de mensagens entre chats (1 = enviada a partir de um turno humano). */
  interChatHops?: number
  /** send_to_chat (mensagem tool no remetente): chat de destino resolvido. */
  targetChatId?: string
  // ---- subagentes ----
  /** delegate_task com background=true (mensagem tool no pai). */
  background?: boolean
  /** kind 'subagent-callback': resultado de uma retomada (atualização após nova mensagem). */
  callbackUpdate?: boolean
  /** kind 'sibling-broadcast': id comum às cópias do mesmo broadcast (uma por irmão). */
  broadcastId?: string
  // ---- Smart-Approve (mensagem tool) ----
  /** Avaliação do juiz para esta chamada (custo aparece no rodapé da resposta). */
  smartApprove?: SmartApproveRecord
  /** Executada por liberação explícita do usuário ("Executar mesmo assim") após uma rejeição. */
  smartOverride?: boolean
  /** Gate de aprovação (modo lists/always): o que liberou ou bloqueou a chamada. */
  approval?: ApprovalRecord
  // ---- questionário (mensagem tool de ask_user) ----
  /** Perguntas (com imagens já resolvidas no store) + respostas estruturadas, para o card. */
  askUser?: AskUserRecord
  // ---- memória (SPEC → Memória) ----
  /** kind 'memory-extraction': resultado da extração (mudanças, custo, request exata). */
  memoryExtraction?: MemoryExtractionResult & {
    model?: string
    providerId?: string
    usage?: Usage
    request?: unknown
    trigger: 'manual' | 'compaction'
  }
  /** Mensagem tool de memory_write/memory_rewrite/memory_delete: o que mudou. */
  memoryChanges?: MemoryExtractionResult['changes']
  // ---- visualizador de arquivos (mensagem tool de present_file) ----
  /** Arquivos apresentados ao usuário (cards no chat + painel de arquivo). Ver SPEC → present_file. */
  presentFiles?: PresentFilesRecord
  // ---- título automático (1ª mensagem digitada da principal) ----
  /** Título do chat gerado por modelo a partir desta mensagem (custo/modelo — fora do histórico). */
  autoTitle?: AutoTitleRecord
  // ---- chamada de voz (SPEC → Chamada de voz → Histórico e custos) ----
  /** Mensagem de voz: fala da chamada (usuário/assistente) ou texto ditado. Só exibição/custos. */
  voice?: VoiceMessageMeta
  /** kind 'voice-call': marcador de início/fim da chamada (duração, quem encerrou, custos). */
  voiceCall?: VoiceCallMark
}

/** Tipo de visualização de um arquivo no painel (SPEC → "Visualizador de arquivos"). */
export type ViewerKind = 'markdown' | 'html' | 'image' | 'pdf' | 'code' | 'text' | 'binary'

/** Um arquivo de uma chamada de present_file (na ordem pedida pelo modelo). */
export interface PresentedFile {
  /** Caminho absoluto NO DISPOSITIVO que rodou a tool (resolvido contra a raiz do chat). */
  path: string
  /** Nome real do arquivo (basename). */
  name: string
  title?: string
  description?: string
  size?: number
  kind?: ViewerKind
  /** Erro curto (pt-BR) — o arquivo não foi apresentado ("não encontrado", "é um diretório"…). */
  error?: string
}

/** meta.presentFiles: onde os arquivos estão + a lista (cards renderizam só com isto). */
export interface PresentFilesRecord {
  /** Dispositivo do sync que rodou a tool (ausente = sync desligado → o dispositivo local). */
  deviceId?: string
  deviceName?: string
  files: PresentedFile[]
}

export interface StoredMessage {
  id: string
  sessionId: string
  seq: number
  /**
   * Mensagem anterior no mesmo ramo (árvore de mensagens); `null` = raiz da sessão; ausente =
   * linha/registro legado → a anterior por seq (`resolveParent` em `src/shared/branches.ts`).
   */
  parentId?: string | null
  message: ApiMessage
  meta: MessageMeta
  createdAt: number
}

export interface QueuedMessage {
  id: string
  sessionId: string
  text: string
  createdAt: number
  /** Anexos da mensagem enfileirada (já salvos no store). */
  attachments?: AttachmentInfo[]
  /** Skills carregadas manualmente (parts `<skill>` já lidos no envio, com `_skill`). */
  skillParts?: ContentPart[]
  /** Meta extra aplicada ao persistir (ex.: kind 'inter-chat' + origem). */
  meta?: MessageMeta
}

/** Um sub-comando (ou a URL) avaliado contra as listas, como o card mostra. */
export interface ApprovalCheckItem {
  /** Sub-comando normalizado (tokens) ou URL normalizada. */
  text: string
  /** allow = liberado pela whitelist; ask = precisa da sua decisão. */
  verdict: 'allow' | 'ask'
  /** Entrada da whitelist que casou (verdict allow). */
  entry?: string
  /** Por que nunca é liberado automaticamente (eval, redirecionamento para arquivo…). */
  reason?: string
  /** Contexto (ex.: "dentro de $(…)", "via bash -c", "prefixo env"). */
  note?: string
  /** Pré-preenchimento do "+ whitelist/blacklist" (prefixo `programa sub *` ou o domínio). */
  suggestion: string
  /** Nível na árvore da decomposição (internos de ssh/sudo/docker exec… = 1, 2…). */
  depth?: number
  /** Onde/como o sub-comando roda: "no servidor deploy@host (via ssh)", "via sudo"… */
  group?: string
  /**
   * O sub-comando executa um script (`python3 x.py`, `./run.sh`, `node -e '…'`): o começo do
   * arquivo (lido no main, ≤ 64 KiB) ou o código inline — card e juiz mostram. Ver scriptPreview.ts.
   */
  script?: ApprovalScript
  /** Só leitura: liberado sempre (approvalSafety.ts) — "leitura (sempre liberada)". */
  readOnly?: boolean
  /** Toca um caminho protegido (sempre pergunta): "~/.ssh/config (chaves e config do SSH)". */
  protectedPath?: string
}

/** Prévia de script de um item do card (ver src/shared/scriptPreview.ts). */
export interface ApprovalScript {
  interpreter: string
  /** Caminho como escrito no comando (arquivo). */
  path?: string
  /** Caminho resolvido pelo main (cwd do shell da chamada). */
  resolved?: string
  /**
   * pending = arquivo ainda não lido (o main preenche); ok = lido; inline = código no comando;
   * missing = não existe; binary; notfile = diretório/especial; remote = dentro de ssh/container
   * (não dá para ler daqui); error = falha de leitura.
   */
  status: 'pending' | 'ok' | 'inline' | 'missing' | 'binary' | 'notfile' | 'remote' | 'error'
  /** Começo do conteúdo (até 15 linhas / 1.200 chars). */
  content?: string
  /** Linhas do arquivo (com `partial`, das primeiras 64 KiB lidas). */
  lines?: number
  /** Arquivo maior que o limite de leitura (64 KiB). */
  partial?: boolean
  /** `content` é só o começo (há mais linhas/chars). */
  truncated?: boolean
}

export interface ApprovalCheck {
  item: ApprovalItem
  items: ApprovalCheckItem[]
}

/** meta.approval da mensagem tool (modo lists/smart; `always` só com o modo). */
export interface ApprovalRecord {
  item: ApprovalItem
  mode: ApprovalMode
  /** Sub-comandos/URL liberados pela whitelist. */
  allowed?: { text: string; entry: string }[]
  /** Bloqueado pela blacklist (nada rodou). */
  blocked?: { text: string; entry: string }
  /** Sub-comandos que o Smart-Approve liberou (modo smart: só os que a whitelist não liberou). */
  judgeAllowed?: string[]
  /** Sub-comandos que você aprovou no card (ou o resumo da chamada, na pergunta simples). */
  userAllowed?: string[]
  /** Sub-comando que você negou. */
  denied?: string
  /** Sub-comandos liberados por serem só de leitura (sempre liberados). */
  readOnly?: string[]
  /** Liberado por "Aceitar edições dentro da raiz do chat" (write_file/edit_file). */
  acceptEdits?: boolean
  /** Perguntou por tocar um caminho protegido. */
  protectedPath?: string
}

export interface ApprovalRequest {
  id: string
  chatId: string
  sessionId: string
  toolCallId: string
  toolName: ToolName
  args: unknown
  createdAt: number
  /** O Smart-Approve avaliou e pediu sua decisão (ou falhou) — o card mostra o motivo. */
  smartApprove?: SmartApproveRecord
  /** Modo lists: sub-comandos (ou a URL) com o veredito de cada um — card com 4 botões por item. */
  check?: ApprovalCheck
  /** Modo smart sem modelo do Smart-Approve → perguntou (o card avisa). */
  smartMissing?: boolean
  /** Pergunta porque toca um caminho protegido (o card mostra "caminho protegido"). */
  protectedPath?: string
}

// ---- Questionário (tool ask_user) — ver SPEC.md → "Questionário (ask_user)" ----

/** Ícone de uma opção já resolvido: nome lucide, texto/emoji ou imagem do store. */
export type AskUserIcon =
  { kind: 'lucide'; name: string } | { kind: 'text'; text: string } | { kind: 'image'; url: string }

/** Ajuda de uma opção: texto (monospace) ou imagem do store. */
export type AskUserHelp = { kind: 'text'; text: string } | { kind: 'image'; url: string }

/** Opção como a UI mostra (campos ausentes não aparecem). `url` = `clearchat-attachment://…`. */
export interface AskUserOption {
  title: string
  description?: string
  icon?: AskUserIcon
  /** Imagem grande mostrada ao passar o mouse sobre a opção. */
  image?: string
  help?: AskUserHelp
}

export interface AskUserQuestion {
  title: string
  description?: string
  multiple: boolean
  options: AskUserOption[]
}

/** Resposta a uma pergunta: índices das opções marcadas (0-based) + texto de "Outro". */
export interface QuestionAnswer {
  selected: number[]
  other?: string
}

/** Questionário pendente (memória do main; some ao responder/cancelar). */
export interface QuestionRequest {
  id: string
  chatId: string
  sessionId: string
  toolCallId: string
  questions: AskUserQuestion[]
  /** Imagens/ícones que não puderam ser carregados (também vão no resultado ao modelo). */
  notes?: string[]
  createdAt: number
}

/**
 * Chamada ao modelo que falhou por erro de rede (memória do main; some ao decidir). Ver SPEC.md →
 * "Falha de conexão (nova tentativa)".
 */
export interface RetryRequest {
  id: string
  chatId: string
  sessionId: string
  /** Erro curto (mensagem + causa). */
  error: string
  /** Modelo/provedor da chamada (para o card). */
  model: string
  providerName?: string
  createdAt: number
}

/** meta.askUser da mensagem tool: o que foi mostrado e o que o usuário respondeu. */
export interface AskUserRecord {
  questions: AskUserQuestion[]
  outcome: 'answered' | 'cancelled' | 'app-closed'
  answers?: QuestionAnswer[]
  notes?: string[]
}

export interface StreamDraft {
  content: string
  reasoning: string
  toolCalls: { id: string; name: string; arguments: string }[]
  /**
   * Relógio do raciocínio (epoch ms do processo que roda o stream): 1º delta de raciocínio e 1º
   * delta de conteúdo/tool call depois dele. Só local — o sync (draft.delta) não leva; o renderer
   * cai para a hora em que viu o raciocínio pela primeira vez.
   */
  reasoningStartedAt?: number
  reasoningEndedAt?: number
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
}

/** Processo em segundo plano iniciado por process_start (escopo: chat). */
export interface ProcessInfo {
  /** Id curto no chat ("p1", "p2"…). */
  id: string
  chatId: string
  /** Sessão que iniciou (principal ou subagente). */
  sessionId: string
  name: string
  command: string
  cwd: string
  pid: number | null
  status: 'running' | 'exited'
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt: number | null
  /** Total de linhas já produzidas (numeração global do log). */
  lines: number
  lastLine: string
  /** Arquivo com o log completo. */
  logFile: string
}

export type AgentEvent =
  | { type: 'session-created'; session: Session }
  | { type: 'session-updated'; session: Session }
  /** Subsessão apagada (ex.: regenerate/apagar a mensagem do delegate_task). Inclui descendentes. */
  | { type: 'session-deleted'; sessionId: string; chatId: string }
  | { type: 'message-added'; message: StoredMessage }
  | { type: 'message-updated'; message: StoredMessage }
  | { type: 'message-deleted'; sessionId: string; messageId: string }
  /** Throttled ~30–60ms; null = fim do stream. */
  | { type: 'draft'; sessionId: string; draft: StreamDraft | null }
  /** Output parcial (shell) opcional. */
  | {
      type: 'tool-running'
      sessionId: string
      toolCallId: string
      running: boolean
      output?: string
      /** Smart-Approve avaliando a chamada (antes de executar ou pedir aprovação). */
      judging?: boolean
    }
  | { type: 'queue-updated'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'approval-requested'; request: ApprovalRequest }
  | { type: 'approval-resolved'; id: string }
  /** Questionário (ask_user) aguardando o usuário / respondido ou cancelado. */
  | { type: 'question-requested'; request: QuestionRequest }
  | { type: 'question-resolved'; id: string }
  /** Falha de conexão com o provedor aguardando "Tentar de novo" / "Cancelar". */
  | { type: 'retry-requested'; request: RetryRequest }
  | { type: 'retry-resolved'; id: string }
  | { type: 'chat-updated'; chat: Chat }
  /** Compactação: agendada (próximo passo), rodando (com o texto parcial do resumo) ou null (fim). */
  | {
      type: 'compaction'
      sessionId: string
      state: 'scheduled' | 'running' | null
      text?: string
    }
  | { type: 'error'; sessionId: string; error: string }
  /** Processos em segundo plano (process_start) do chat mudaram (início, saída, parada). */
  | { type: 'processes-updated'; chatId: string; processes: ProcessInfo[] }
  /** Modos globais / listas de aprovação mudaram (Configurações → Aprovações ou "+ lista" no card). */
  | { type: 'approval-settings-updated'; settings: ApprovalSettings }
  /** Coleção/memória criada, alterada ou apagada (UI, tools do modelo ou extração). */
  | { type: 'memory-changed'; collectionId: string | null; memoryId: string | null }
  /** Locais de skills mudaram ou "Reescanear" (Configurações → Skills): listas recarregam. */
  | { type: 'skills-changed' }
  /** Chat apagado fora da UI (sync: apagado em outro dispositivo / divergência descartada). */
  | { type: 'chat-deleted'; chatId: string }
  /** Sync: estado da conta/conexão mudou. */
  | { type: 'sync-status'; status: import('./sync').SyncStatus }
  /** Sync: host/divergência de um chat mudou. */
  | { type: 'sync-chat-state'; info: import('./sync').ChatHostInfo }
  /** Sync: tabelas locais mudaram por mudanças remotas (o renderer recarrega esses domínios). */
  | { type: 'sync-data-changed'; scopes: import('./sync').SyncScope[] }
  /** Sync: lista dos chats só ao vivo de outros dispositivos mudou (§23.4; só memória). */
  | { type: 'sync-live-chats'; chats: import('./sync').LiveChatView[] }
  /** Sync: aviso para o usuário (toast; `chatId` = aviso também no chat). */
  | { type: 'sync-notice'; kind: 'info' | 'error' | 'success'; text: string; chatId?: string }
  /** Atualizações: resultado de uma checagem da última release (aviso discreto; nunca toast). */
  | { type: 'update-status'; status: import('./updates').UpdateStatus }
