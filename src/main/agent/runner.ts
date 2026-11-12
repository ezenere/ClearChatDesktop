// Loop do agente por sessão: build → stream → persistir assistant → tools → [fila] → repetir.
// Ver SPEC.md → "Runner / fila / interrupção".
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname } from 'path'
import type {
  ApiMessage,
  ApprovalCheck,
  ApprovalItem,
  ApprovalRecord,
  Chat,
  ContentPart,
  MessageMeta,
  QueuedMessage,
  Session,
  SessionStatus,
  SmartApproveRecord,
  StoredMessage,
  ToolCall,
  ToolName
} from '@shared/types'
import { TOOL_ALIASES } from '@shared/types'
import {
  argsSummary,
  normalizeSmartApprove,
  overrideMessageText,
  smartRejectText
} from '@shared/smartApprove'
import { buildJudgeExtras, type JudgeExtras } from '@shared/smartApproveContext'
import {
  approvalRoute,
  blockedText,
  checkItemLabel,
  effectiveMode,
  evaluateLists,
  isListItem,
  smartListPlan,
  TOOL_ITEM,
  userDeniedText,
  validateListEntry,
  type ApprovalItemDecision
} from '@shared/approvalPolicy'
import type { ApprovalListItem, ApprovalMode, CapturedContextState } from '@shared/types'
import { addListEntries, getApprovalSettings, onApprovalListsChanged } from '../approvalSettings'
import type {
  ApprovalDecision,
  CompactOptions,
  RequestPreview,
  SmartApproveTestInput
} from '@shared/ipc'
import type { ModelInfo, Provider } from '@shared/types'
import { sessionProviderId } from '@shared/models'
import { DEFAULT_COMPACT_PROMPT } from '@shared/defaults'
import { clampToolOutput, LIMITS, TOOL_SPILL_SETTING } from '@shared/limits'
import { applyVoiceCallChat } from '@shared/voice'
import { spokenPrefix } from '@shared/voiceTurn'
import { END_CALL_RESULT, type VoiceMessageMeta } from '@shared/voiceCallMarks'
import {
  interChatHeader,
  interChatText,
  nextInterChatHops,
  type InterChatSendMeta,
  splitInterChatText,
  wouldCreateWaitCycle,
  type WaitEdge
} from '@shared/interChat'
import {
  compactThreshold,
  contextUsage,
  hasCompactableHistory,
  isContextLengthError,
  isDisplayOnly,
  resolveContextWindow
} from '@shared/context'
import { emit } from '../events'
import { chatsRepo, messagesRepo, providersRepo, sessionsRepo, settingsRepo } from '../repo'
import { getDb, getDbPath } from '../db'
import { historyStore } from '../historyStore'
import { parseToolArgs, runLocalTool, shellStateFor } from '../tools'
import { registerPresented, viewerDevice } from '../fileViewer'
import {
  abortError,
  truncate,
  truncateHeadTail,
  type ChatListEntry,
  type ToolContext
} from '../tools/util'
import {
  delegateEmptyText,
  delegateFailureText,
  resolveSubagentTarget,
  type ModelSource
} from '../tools/models'
import {
  callbackText,
  formatSiblingExchanges,
  formatSiblingList,
  formatSubagentList,
  fmtDuration,
  parentMessageText,
  ReportRegistry,
  resolveMessageTarget,
  resolveSubagentRef,
  siblingPairKey,
  SlidingWindowLimiter,
  subtreeIds,
  type Report,
  type SiblingExchange,
  type SubagentRow
} from './subagents'
import {
  isSiblingKind,
  siblingBroadcastText,
  siblingMessageText,
  splitSiblingText
} from '@shared/siblings'
import { listModels } from '../providers'
import { contentText, isAppPart } from '@shared/attachments'
import { isChatProvider, providerKind } from '@shared/providerKinds'
import {
  accToDraft,
  finalizeToolCalls,
  markReasoning,
  newAccumulator,
  reasoningDuration,
  streamChat,
  throttle,
  type StreamAccumulator
} from './llm'
import {
  availableTools,
  buildRequest,
  maskRequest,
  modelInfoFor,
  setProviderNamesSource,
  setSiblingsSource,
  voiceCallContextFor
} from './request'
import type { BuiltRequest } from './request'
import { connectionErrorText, isConnectionFailure, retryAppClosedText } from '@shared/network'
import {
  callWithNetworkRetry,
  getRetry,
  listRetries,
  requestRetry,
  resolveRetry,
  type RetryOutcome
} from './retries'
import {
  buildCompactionRequest,
  cleanSummary,
  COMPACTION_MODES,
  compactionMeta
} from './compaction'
import { getApproval, listApprovals, requestApproval, resolveApproval } from './approvals'
import { addOverride, runJudge, takeOverride } from './smartApprove'
import { ContextCaptureService } from './contextCapture'
import { isInsideRoot, normalizePath, protectedRule, type SafetyCtx } from '@shared/approvalSafety'
import { capturedTextFor, effectiveAcceptEdits, effectiveEnvironment } from '@shared/contextCapture'
import { isTypedUserMessage } from '@shared/smartApproveContext'
import { realpathDeep, resolvePath } from '../tools/util'
import { fillScriptPreviews, resolveScriptPath } from '../scriptPreview'
import { bwrapAvailable } from '../tools/bash'
import {
  drainQueue,
  enqueue,
  getQueue,
  hasQueued,
  isQueued,
  requeueFront,
  takeQueued,
  clearQueue
} from './queue'
import { formatTextToolResult, parseTextToolCalls } from './textTools'
import { buildUserContent, truncateBodyForPreview, validateAttachments } from '../attachments'
import type { AskUserRecord, AttachmentInfo } from '@shared/types'
import {
  ASK_USER_APP_CLOSED,
  ASK_USER_NOT_ANSWERED,
  formatAskUserResult,
  parseAskUserArgs
} from '@shared/askUser'
import { cancelQuestion, getQuestion, listQuestions, requestQuestion } from './questions'
import { resolveAskUserQuestions } from '../askUserImages'
import { MEMORY_TOOL_NAMES, SKILL_TOOL_NAMES } from '@shared/tools'
import { afterCompaction, ensureSnapshot, runMemoryToolFor } from '../memory'
import { isTypedFirstMessage, scheduleAutoTitle } from '../autoTitle'
import { manualSkillParts, sandboxSkillDirs, sessionSkills } from '../skills'
import {
  activePath,
  buildTree,
  isBranchEditable,
  lastTurnAnchor,
  pruneSel,
  selectionToReach,
  selEquals,
  turnAnchor,
  turnResponse,
  type BranchSel
} from '@shared/branches'

export const CANCELLED_TEXT = '[Interrompido pelo usuário antes de concluir]'
export const DENIED_TEXT = 'O usuário negou a execução desta ferramenta.'
const MAX_DEPTH = 2

type LoopOutcome =
  | { kind: 'final'; text: string }
  | { kind: 'aborted'; partial: string }
  /** userCancelled: falha de rede e o usuário cancelou o card (não é um erro a avisar). */
  | { kind: 'error'; error: string; userCancelled?: boolean }

/** Fim de um turno (uma execução do loop de uma sessão) — avisos push do sync (§22.5). */
export interface TurnEnd {
  sessionId: string
  chatId: string
  depth: number
  outcome: 'final' | 'error' | 'aborted'
  text: string
  error?: string
  /** Parado pelo usuário (Parar, ⚡ sem continuação, cancelar o card de falha de conexão). */
  userStopped: boolean
  /** Loop só de compactação (sem resposta nova). */
  compactOnly: boolean
}

const turnEndListeners = new Set<(t: TurnEnd) => void>()

/** Assina o fim de cada turno (todas as sessões; o ouvinte filtra). Devolve o cancelamento. */
export function onTurnEnd(fn: (t: TurnEnd) => void): () => void {
  turnEndListeners.add(fn)
  return () => turnEndListeners.delete(fn)
}

function emitTurnEnd(st: RunState, o: LoopOutcome, compactOnly: boolean): void {
  if (shuttingDown || !turnEndListeners.size) return
  const t: TurnEnd = {
    sessionId: st.sessionId,
    chatId: st.chatId,
    depth: st.depth,
    outcome: o.kind,
    text: o.kind === 'final' ? o.text : '',
    ...(o.kind === 'error' ? { error: o.error } : {}),
    userStopped: o.kind === 'aborted' || (o.kind === 'error' && !!o.userCancelled),
    compactOnly
  }
  for (const fn of turnEndListeners) {
    try {
      fn(t)
    } catch (e) {
      console.error('[clearchat] onTurnEnd', e)
    }
  }
}

type StepResult =
  | { kind: 'final'; text: string }
  | { kind: 'continue' }
  | { kind: 'aborted'; partial: string }
  /** networkCancelled: falha de rede e o usuário cancelou o card (botão / Parar / ⚡). */
  | { kind: 'error'; error: string; networkCancelled?: boolean }

interface CompactRequest {
  reason: 'manual' | 'auto'
  /** Depois de compactar, continua o turno ("Compactar e tentar de novo"). */
  retry?: boolean
}

type CompactionResult =
  { kind: 'ok' } | { kind: 'skipped' } | { kind: 'aborted' } | { kind: 'error'; error: string }

interface RunState {
  sessionId: string
  chatId: string
  depth: number
  controller: AbortController
  stopRequested: boolean
  forced: QueuedMessage[]
  done: Promise<LoopOutcome>
  /** Compactação pedida/agendada: roda no próximo limite de passo. */
  compact: CompactRequest | null
  /** Loop iniciado só para compactar (ocioso): termina depois, salvo fila/⚡/retry. */
  compactOnly: boolean
  /** Já houve compactação automática desde a última chamada bem-sucedida (evita laço). */
  autoCompactTried: boolean
  /** Execução de subsessão que reporta ao pai por callback (segundo plano / retomada). */
  report?: Report
}

interface ToolOutcome {
  content: string
  /** read_file de imagem/PDF: conteúdo multimodal por referência (vira o content da mensagem tool). */
  parts?: ContentPart[]
  status: 'ok' | 'error' | 'denied' | 'cancelled'
  subSessionId?: string
  shellCwd?: string
  /** send_to_chat: chat de destino resolvido. */
  targetChatId?: string
  /** delegate_task em segundo plano. */
  background?: boolean
  /** Avaliação do Smart-Approve desta chamada. */
  smartApprove?: SmartApproveRecord
  /** Rodou por "Executar mesmo assim" (liberação de uma vez só). */
  smartOverride?: boolean
  /** Gate de aprovação: liberado pela whitelist / bloqueado pela blacklist / decisões do card. */
  approval?: ApprovalRecord
  /** ask_user: perguntas mostradas + respostas (card do questionário). */
  askUser?: AskUserRecord
  /** memory_write/rewrite/delete: o que mudou (card da tool). */
  memoryChanges?: MessageMeta['memoryChanges']
  /** present_file: arquivos apresentados (cards + painel de arquivo). */
  presentFiles?: MessageMeta['presentFiles']
  durationMs: number
}

const runs = new Map<string, RunState>()
/** Execuções de subsessões que reportam ao pai por callback (segundo plano / retomadas). */
const reports = new ReportRegistry()
/** Promise resolvida depois que o callback de cada execução foi tratado (por id do Report). */
const reportSettled = new Map<number, Promise<void>>()
/** Subagentes dormindo (status 'waiting'): acorda quando chega mensagem/callback. */
const wakers = new Map<string, () => void>()

const DEBUG = !!process.env['CLEARCHAT_DEBUG']
const dbg = (...a: unknown[]): void => {
  if (DEBUG) console.log('[clearchat:runner]', new Date().toISOString(), ...a)
}

// ---------------- helpers ----------------

/** true após before-quit: o loop abortado não toca mais no banco. */
let shuttingDown = false

function setStatus(sessionId: string, status: SessionStatus): void {
  if (shuttingDown) return
  const cur = sessionsRepo.get(sessionId)
  if (!cur || cur.status === status) return
  const s = sessionsRepo.setStatus(sessionId, status)
  if (s) emit({ type: 'session-updated', session: s })
}

const hasPendingBranch = (sel: BranchSel | undefined): boolean =>
  !!sel && Object.values(sel).includes(null)

function append(sessionId: string, message: ApiMessage, meta: MessageMeta = {}): StoredMessage {
  if (shuttingDown) throw new Error('Aplicativo encerrando.')
  const before = sessionsRepo.get(sessionId)?.branchSel
  const m = messagesRepo.append(sessionId, message, meta)
  emit({ type: 'message-added', message: m })
  const s = sessionsRepo.get(sessionId)
  if (s) {
    chatsRepo.touch(s.chatId)
    // coleta automática de contexto: mensagem digitada (ou do agente pai, no subagente)
    if (
      message.role === 'user' &&
      (isTypedUserMessage(m) || (s.depth > 0 && meta.kind === 'parent-message'))
    )
      capture.onUserMessage(sessionId)
    // 1ª mensagem do ramo novo do regenerate: o `null` da seleção saiu (o caminho segue por ela)
    if (hasPendingBranch(before) && !selEquals(before, s.branchSel))
      emit({ type: 'session-updated', session: s })
  }
  return m
}

/**
 * Tira os `null` da seleção (ramo vazio do regenerate que terminou sem nenhuma mensagem — Parar
 * logo no início, app fechado): o caminho volta à versão que já existia. Emite session-updated.
 */
function clearPendingBranch(sessionId: string): void {
  const s = sessionsRepo.get(sessionId)
  if (!s || !hasPendingBranch(s.branchSel)) return
  const next: BranchSel = {}
  for (const [k, v] of Object.entries(s.branchSel ?? {})) if (v !== null) next[k] = v
  const u = sessionsRepo.setBranchSel(sessionId, next)
  if (u) emit({ type: 'session-updated', session: u })
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Teto de caracteres do resultado de uma tool no turno: override da chamada de voz
 * (`voice.tools.maxToolOutputChars`, SPEC → "Chamada de voz (meia-duplex)") ou o do chat.
 */
function toolOutputLimit(chat: Chat, session: Pick<Session, 'id' | 'depth'>): number {
  const call = voiceCallContextFor(chat, session)
  return clampToolOutput(call?.tools?.maxToolOutputChars ?? chat.config.maxToolOutputChars)
}

/**
 * Persiste um erro HTTP/do modelo como mensagem só de exibição (sobrevive ao reinício).
 * meta.kind 'error' + synthetic → buildRequest a exclui do histórico enviado à API.
 */
function appendError(sessionId: string, error: string): void {
  if (shuttingDown || !sessionsRepo.get(sessionId)) return
  try {
    append(
      sessionId,
      { role: 'assistant', content: error },
      { synthetic: true, kind: 'error', error }
    )
  } catch (e) {
    console.error('[clearchat] appendError', e)
  }
}

/**
 * Mensagem só de exibição (marcador da chamada de voz — `meta.kind 'voice-call'`): persistida e
 * emitida como as demais, NUNCA enviada à API (`isDisplayOnly`). Null = não gravada.
 */
export function appendDisplayMessage(
  sessionId: string,
  content: string,
  meta: MessageMeta
): StoredMessage | null {
  if (shuttingDown || !sessionsRepo.get(sessionId)) return null
  try {
    return append(sessionId, { role: 'assistant', content }, { ...meta, synthetic: true })
  } catch (e) {
    console.error('[clearchat] appendDisplayMessage', e)
    return null
  }
}

/**
 * `meta.voice` da resposta do assistente num turno da chamada de voz (avaliado na hora de gravar —
 * a chamada pode ter acabado no meio do passo). Vazio fora da chamada.
 */
function voiceReplyMeta(
  chat: Chat,
  session: Session,
  content: string | null,
  partial = false
): Pick<MessageMeta, 'voice'> {
  const call = voiceCallContextFor(chat, session)
  if (!call?.callId) return {}
  const voice: VoiceMessageMeta = { source: 'call', callId: call.callId }
  if (content?.trim()) voice.spoken = partial ? 'partial' : true
  if (call.ttsModel) voice.ttsModel = call.ttsModel
  return { voice }
}

// ---- meta extra de uma mensagem do usuário (voz: chamada/ditado) — entregue a `send` ----
const pendingUserMeta = new Map<string, { text: string; meta: MessageMeta; at: number }>()
/**
 * A próxima `send(sessionId, text)` com este texto grava `meta` junto (ex.: `meta.voice` da fala
 * da chamada ou do ditado). Usado porque o envio passa pelo gate do sync (`gatedSend`), que só
 * leva texto/anexos; expira em 30 s.
 */
export function stashUserMeta(sessionId: string, text: string, meta: MessageMeta): void {
  pendingUserMeta.set(sessionId, { text, meta, at: Date.now() })
}
function takeUserMeta(sessionId: string, text: string): MessageMeta {
  const p = pendingUserMeta.get(sessionId)
  if (!p) return {}
  pendingUserMeta.delete(sessionId)
  return p.text === text && Date.now() - p.at < 30_000 ? p.meta : {}
}

/** Sessão + todos os descendentes (filhos antes dos pais na lista retornada). */
function subtree(chatId: string, rootIds: string[]): Session[] {
  const all = sessionsRepo.list(chatId)
  const out: Session[] = []
  const visit = (id: string): void => {
    for (const c of all.filter((s) => s.parentSessionId === id)) visit(c.id)
    const s = all.find((x) => x.id === id)
    if (s) out.push(s)
  }
  for (const id of rootIds) visit(id)
  return out
}

/** Subsessões (raízes) criadas pelos delegate_task destas mensagens da sessão `parent`. */
function subSessionRoots(parent: Session, msgs: StoredMessage[]): string[] {
  const callIds = new Set<string>()
  const subIds = new Set<string>()
  for (const m of msgs) {
    if (m.meta.subSessionId) subIds.add(m.meta.subSessionId)
    if (m.message.role === 'assistant')
      for (const tc of m.message.tool_calls ?? []) callIds.add(tc.id)
  }
  if (!subIds.size && !callIds.size) return []
  return sessionsRepo
    .list(parent.chatId)
    .filter(
      (s) =>
        s.parentSessionId === parent.id &&
        (subIds.has(s.id) || (s.parentToolCallId != null && callIds.has(s.parentToolCallId)))
    )
    .map((s) => s.id)
}

/**
 * Apaga as subsessões criadas pelos delegate_task destas mensagens (tool com meta.subSessionId ou
 * assistant com o tool_call de origem) — evita subsessões órfãs ao apagar mensagem.
 * Aborta as que estiverem rodando e emite `session-deleted` para cada uma (descendentes primeiro).
 */
export async function deleteSubSessionsOf(removed: StoredMessage[]): Promise<void> {
  if (!removed.length) return
  const parent = sessionsRepo.get(removed[0].sessionId)
  if (!parent) return
  const roots = subSessionRoots(parent, removed)
  if (!roots.length) return
  const doomed = subtree(parent.chatId, roots)
  reports.drop(doomed.map((s) => s.id)) // apagadas: nenhum callback delas
  const live = doomed.map((s) => runs.get(s.id)).filter((x): x is RunState => !!x)
  for (const st of live) {
    st.stopRequested = true
    st.forced = []
    st.controller.abort()
  }
  await Promise.all(live.map((st) => waitDone(st, 5000)))
  for (const s of doomed) {
    for (const a of listApprovals())
      if (a.sessionId === s.id) resolveApproval(a.id, { kind: 'cancel' })
    clearQueue(s.id)
  }
  for (const id of roots) sessionsRepo.delete(id) // FK ON DELETE CASCADE leva descendentes e mensagens
  for (const s of doomed) emit({ type: 'session-deleted', sessionId: s.id, chatId: s.chatId })
}

/** Apaga uma mensagem do histórico (IPC messages.delete) + subsessões que ela originou. */
export async function deleteMessage(id: string): Promise<void> {
  const r = messagesRepo.remove(id)
  if (!r) return
  const m = r.message
  emit({ type: 'message-deleted', sessionId: m.sessionId, messageId: m.id })
  // árvore: os filhos passaram para o pai da apagada (e a seleção pode ter mudado)
  for (const x of r.reparented) emit({ type: 'message-updated', message: x })
  if (r.selChanged) {
    const s = sessionsRepo.get(m.sessionId)
    if (s) emit({ type: 'session-updated', session: s })
  }
  await deleteSubSessionsOf([m])
}

/**
 * Garante pareamento válido no fim do histórico: para cada tool_call do último assistant
 * sem resposta, adiciona msg `tool` sintética cancelada.
 */
export function repairTail(
  sessionId: string,
  reason: 'cancelled' | 'app-closed' = 'cancelled'
): void {
  const msgs = messagesRepo.path(sessionId)
  let idx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i].message
    // card da extração de memórias / marcador da chamada de voz podem entrar no meio de um turno
    // (só exibição): ignora
    if (isDisplayOnly(msgs[i].meta)) continue
    if (m.role === 'assistant') {
      idx = i
      break
    }
    if (m.role === 'user') return
  }
  if (idx === -1) return
  const a = msgs[idx].message
  if (a.role !== 'assistant' || !a.tool_calls?.length) return
  const answered = new Set(
    msgs
      .slice(idx + 1)
      .map((m) => (m.message.role === 'tool' ? m.message.tool_call_id : null))
      .filter(Boolean)
  )
  for (const tc of a.tool_calls) {
    if (answered.has(tc.id)) continue
    // questionário que ficou sem resposta (app fechado): texto próprio; o card usa os argumentos
    if (tc.function.name === 'ask_user') {
      const appClosed = reason === 'app-closed'
      append(
        sessionId,
        {
          role: 'tool',
          tool_call_id: tc.id,
          content: appClosed ? ASK_USER_APP_CLOSED : ASK_USER_NOT_ANSWERED
        },
        { synthetic: true, kind: 'tool-cancelled', toolStatus: 'cancelled' }
      )
      continue
    }
    append(
      sessionId,
      { role: 'tool', tool_call_id: tc.id, content: CANCELLED_TEXT },
      { synthetic: true, kind: 'tool-cancelled', toolStatus: 'cancelled' }
    )
  }
}

/** Título provisório (1ª mensagem truncada) de um chat novo; devolve o título gravado ou null. */
function maybeSetTitle(session: Session, text: string): string | null {
  if (session.depth !== 0) return null
  const chat = chatsRepo.get(session.chatId)
  if (!chat) return null
  if (chat.title && chat.title !== 'Novo chat') return null
  const hasUser = messagesRepo.path(session.id).some((m) => m.message.role === 'user')
  if (hasUser) return null
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return null
  const title = line.length > 50 ? line.slice(0, 50).trimEnd() + '…' : line
  const { chat: updated } = chatsRepo.update(chat.id, { title })
  emit({ type: 'chat-updated', chat: updated })
  return title
}

function appendUser(
  session: Session,
  text: string,
  meta: MessageMeta = {},
  attachments: AttachmentInfo[] = [],
  skillParts: ContentPart[] = []
): StoredMessage {
  // mensagem de outro chat: o título (se ainda não houver) vem do corpo, sem o cabeçalho
  const titleText = meta.kind === 'inter-chat' ? splitInterChatText(text).body : text
  const names = [
    ...attachments.map((a) => a.name),
    ...skillParts.flatMap((p) => (p.type === 'text' && p._skill ? [`Skill ${p._skill.name}`] : []))
  ]
  const provisional = maybeSetTitle(session, titleText.trim() ? titleText : names.join(', '))
  const stored = append(
    session.id,
    { role: 'user', content: buildUserContent(text, attachments, skillParts) },
    meta
  )
  // título automático (Configurações → Novos chats): só a 1ª mensagem DIGITADA, em segundo plano
  if (provisional !== null && isTypedFirstMessage(meta))
    scheduleAutoTitle({
      chatId: session.chatId,
      text,
      attachments: names,
      expectTitle: provisional,
      messageId: stored.id
    })
  return stored
}

// ---------------- loop ----------------

function startLoop(
  session: Session,
  parentSignal?: AbortSignal,
  init: { compact?: CompactRequest; compactOnly?: boolean } = {}
): RunState {
  const st: RunState = {
    sessionId: session.id,
    chatId: session.chatId,
    depth: session.depth,
    controller: new AbortController(),
    stopRequested: false,
    forced: [],
    done: Promise.resolve({ kind: 'final', text: '' }),
    compact: init.compact ?? null,
    compactOnly: !!init.compactOnly,
    autoCompactTried: false
  }
  if (parentSignal) {
    if (parentSignal.aborted) st.controller.abort()
    else parentSignal.addEventListener('abort', () => st.controller.abort(), { once: true })
  }
  runs.set(session.id, st)
  setStatus(session.id, 'running')
  st.done = runLoop(st).catch((e): LoopOutcome => {
    const error = `Erro interno: ${errMsg(e)}`
    console.error('[clearchat] runner', e)
    appendError(st.sessionId, error)
    finish(st, 'error')
    emit({ type: 'error', sessionId: st.sessionId, error })
    return { kind: 'error', error }
  })
  const compactOnly = !!init.compactOnly
  void st.done.then((o) => emitTurnEnd(st, o, compactOnly))
  return st
}

function finish(st: RunState, status: SessionStatus): void {
  if (runs.get(st.sessionId) === st) runs.delete(st.sessionId)
  if (st.compact) {
    st.compact = null
    emit({ type: 'compaction', sessionId: st.sessionId, state: null })
  }
  if (!shuttingDown) clearPendingBranch(st.sessionId)
  setStatus(st.sessionId, status)
}

// ---------------- compactação ----------------

/** Provedor da sessão: principal = o do chat (atual); subsessão = o fixado ao criá-la. */
// definições de tools com `provider` ajustado aos provedores configurados (request/preview/estimativa)
setProviderNamesSource(() => chatProviders().map((p) => p.name))
// subagente com irmãos recebe check_subagents + message_subagent (ver availableTools)
setSiblingsSource(({ id, parentSessionId }) =>
  sessionsRepo.children(parentSessionId).some((s) => s.id !== id)
)

function providerFor(chat: Chat, session: Session): Provider | null {
  return providersRepo.get(sessionProviderId(chat.config, session))
}

const windowCache = new Map<string, { at: number; models: ModelInfo[] | null }>()

/** Janela de contexto da sessão (override do chat / contextLength do modelo via /models, em cache). */
async function contextWindowFor(chat: Chat, session: Session): Promise<number | null> {
  const provider = providerFor(chat, session)
  let models: ModelInfo[] | null = null
  if (provider) {
    const c = windowCache.get(provider.id)
    if (c && Date.now() - c.at < 5 * 60_000) models = c.models
    else {
      try {
        models = await listModels(provider)
      } catch {
        models = null
      }
      windowCache.set(provider.id, { at: Date.now(), models })
    }
  }
  return resolveContextWindow(chat.config, session, models)
}

/** Subsessões compactam sempre ao atingir o limite; a principal só com autoCompact. */
function autoCompactAllowed(chat: Chat, depth: number): boolean {
  return depth > 0 || !!chat.config.autoCompact
}

async function shouldAutoCompact(st: RunState): Promise<boolean> {
  const session = sessionsRepo.get(st.sessionId)
  const chat = session && chatsRepo.get(session.chatId)
  if (!session || !chat || !autoCompactAllowed(chat, session.depth)) return false
  const history = messagesRepo.path(session.id)
  if (!hasCompactableHistory(history)) return false
  const usage = contextUsage(history)
  if (!usage) return false
  const window = await contextWindowFor(chat, session)
  return !!window && usage.used >= compactThreshold(chat.config) * window
}

/**
 * Resume o histórico ativo com o mesmo modelo (request normal + prompt de compactação no fim),
 * transmitindo o resumo (evento `compaction`), e persiste a fronteira `role: user`. Abortar
 * (Parar/⚡) cancela sem salvar nada.
 */
async function runCompaction(st: RunState, signal: AbortSignal): Promise<CompactionResult> {
  const session = sessionsRepo.get(st.sessionId)
  if (!session) return { kind: 'error', error: 'Sessão não encontrada.' }
  const chat = chatsRepo.get(session.chatId)
  if (!chat) return { kind: 'error', error: 'Chat não encontrado.' }
  const provider = providerFor(chat, session)
  if (!provider) return { kind: 'error', error: 'Nenhum provider configurado para este chat.' }
  repairTail(session.id)
  const history = messagesRepo.path(session.id)
  if (!hasCompactableHistory(history)) return { kind: 'skipped' }
  const window = await contextWindowFor(chat, session)
  const prompt = chat.config.compactPrompt?.trim()
    ? chat.config.compactPrompt
    : DEFAULT_COMPACT_PROMPT
  emit({ type: 'compaction', sessionId: session.id, state: 'running', text: '' })
  dbg('compact', session.id.slice(0, 8), 'msgs', history.length)
  const t0 = Date.now()
  try {
    let acc = newAccumulator()
    let toolChoiceNone = false
    let emptyRetries = 0
    for (let i = 0; i < COMPACTION_MODES.length;) {
      let req
      try {
        req = buildCompactionRequest(chat, session, history, provider, prompt, {
          mode: COMPACTION_MODES[i],
          window,
          toolChoiceNone
        })
      } catch (e) {
        return { kind: 'error', error: errMsg(e) }
      }
      acc = newAccumulator()
      const cur = acc
      const tick = throttle(
        () =>
          emit({ type: 'compaction', sessionId: session.id, state: 'running', text: cur.content }),
        60
      )
      try {
        await streamChat(req, signal, acc, tick.call)
      } catch (e) {
        tick.cancel()
        if (signal.aborted) return { kind: 'aborted' }
        const error = errMsg(e)
        if (isContextLengthError(error) && i < COMPACTION_MODES.length - 1) {
          i++
          continue
        }
        return { kind: 'error', error }
      }
      tick.cancel()
      if (!acc.content.trim()) {
        // 1ª: tool_choice 'none' (o modelo tentou chamar tool); 2ª: só repete (alguns provedores
        // devolvem conteúdo vazio de forma intermitente); depois desiste com o diagnóstico.
        if (!toolChoiceNone) {
          toolChoiceNone = true
          continue
        }
        if (emptyRetries < 1) {
          emptyRetries++
          continue
        }
        const why = [
          acc.finishReason ? `finish_reason=${acc.finishReason}` : '',
          acc.reasoning.trim() ? `só raciocínio (${acc.reasoning.length} caracteres)` : '',
          acc.toolCalls.length ? `tentou chamar ${acc.toolCalls.length} tool(s)` : ''
        ]
          .filter(Boolean)
          .join(', ')
        return {
          kind: 'error',
          error: `o modelo não retornou um resumo${why ? ` (${why})` : ''}.`
        }
      }
      break
    }
    if (signal.aborted) return { kind: 'aborted' }
    const summary = cleanSummary(acc.content)
    const m = compactionMeta(chat, session, history, summary, acc.usage?.completionTokens)
    const meta: MessageMeta = {
      synthetic: true,
      kind: 'compaction',
      summaryOf: m.summaryOf,
      compactedCount: m.compactedCount,
      contextEstimate: m.contextEstimate,
      model: acc.model ?? session.model,
      durationMs: Date.now() - t0
    }
    const before = contextUsage(history)
    if (before) meta.usageBefore = before.used
    if (acc.usage) meta.compactUsage = acc.usage
    if (m.insertBeforeSeq != null) {
      // mensagens do usuário ainda sem resposta ficam depois da fronteira (intactas)
      if (shuttingDown) throw new Error('Aplicativo encerrando.')
      const r = messagesRepo.insertAt(
        session.id,
        m.insertBeforeSeq,
        { role: 'user', content: m.text },
        meta
      )
      for (const x of r.shifted) emit({ type: 'message-updated', message: x })
      emit({ type: 'message-added', message: r.message })
      // ramo: a seleção que apontava para a 1ª pendente passou para a fronteira
      if (r.selChanged) {
        const s = sessionsRepo.get(session.id)
        if (s) emit({ type: 'session-updated', session: s })
      }
      chatsRepo.touch(session.chatId)
    } else append(session.id, { role: 'user', content: m.text }, meta)
    // memória: o índice congelado é renovado no próximo request; extração automática (se ligada)
    void afterCompaction(session.id)
    return { kind: 'ok' }
  } finally {
    emit({ type: 'compaction', sessionId: session.id, state: null })
  }
}

/** Abort (Parar/⚡) em qualquer ponto do loop: injeta forçados e continua, ou encerra. */
function onAborted(st: RunState, partial: string): 'continue' | LoopOutcome {
  repairTail(st.sessionId)
  if (!st.stopRequested && st.forced.length && sessionsRepo.get(st.sessionId)) {
    st.controller = new AbortController()
    st.compactOnly = false
    // ⚡ durante aprovação/questionário: a sessão volta a 'running'
    setStatus(st.sessionId, 'running')
    for (const f of st.forced.splice(0)) {
      const s = sessionsRepo.get(st.sessionId)
      if (s) appendUser(s, f.text, { kind: 'forced', ...f.meta }, f.attachments, f.skillParts)
    }
    return 'continue'
  }
  finish(st, st.depth === 0 ? 'idle' : 'interrupted')
  return { kind: 'aborted', partial }
}

async function runLoop(st: RunState): Promise<LoopOutcome> {
  let lastText = ''
  for (;;) {
    // ---- compactação no limite de passo (pedida, agendada ou automática) ----
    if (!st.compact && !st.autoCompactTried && (await shouldAutoCompact(st)))
      st.compact = { reason: 'auto' }
    if (st.compact) {
      const req = st.compact
      st.compact = null
      if (req.reason === 'auto') st.autoCompactTried = true
      const signal = st.controller.signal
      let cr: CompactionResult
      try {
        cr = await runCompaction(st, signal)
      } catch (e) {
        cr = signal.aborted ? { kind: 'aborted' } : { kind: 'error', error: errMsg(e) }
      }
      if (shuttingDown) {
        if (runs.get(st.sessionId) === st) runs.delete(st.sessionId)
        return { kind: 'aborted', partial: '' }
      }
      if (signal.aborted || cr.kind === 'aborted') {
        const r = onAborted(st, '')
        if (r === 'continue') continue
        return r
      }
      if (cr.kind === 'error') {
        const error = `Falha ao compactar: ${cr.error}`
        appendError(st.sessionId, error)
        emit({ type: 'error', sessionId: st.sessionId, error })
        if (st.compactOnly) {
          finish(st, 'error')
          return { kind: 'error', error }
        }
      }
      if (st.compactOnly) {
        st.compactOnly = false
        const more =
          (req.retry && cr.kind !== 'error') || st.forced.length > 0 || hasQueued(st.sessionId)
        if (!more) {
          finish(st, st.depth === 0 ? 'idle' : 'done')
          return { kind: 'final', text: lastText }
        }
        for (const f of st.forced.splice(0)) {
          const s = sessionsRepo.get(st.sessionId)
          if (s) appendUser(s, f.text, { kind: 'forced', ...f.meta }, f.attachments, f.skillParts)
        }
      }
    }

    for (const q of drainQueue(st.sessionId)) {
      const s = sessionsRepo.get(st.sessionId)
      if (s) appendUser(s, q.text, { kind: 'queued', ...q.meta }, q.attachments, q.skillParts)
    }
    const signal = st.controller.signal
    let res: StepResult
    try {
      res = await step(st, signal)
    } catch (e) {
      res = signal.aborted ? { kind: 'aborted', partial: '' } : { kind: 'error', error: errMsg(e) }
    }

    if (shuttingDown) {
      if (runs.get(st.sessionId) === st) runs.delete(st.sessionId)
      return { kind: 'aborted', partial: '' }
    }
    // Card "Falha de conexão" cancelado: o turno termina como erro (como antes). Via ⚡, depois do
    // erro entra a mensagem forçada e o loop continua; Parar/botão Cancelar → status 'error'.
    if (res.kind === 'error' && res.networkCancelled) {
      repairTail(st.sessionId)
      appendError(st.sessionId, res.error)
      emit({ type: 'error', sessionId: st.sessionId, error: res.error })
      if (signal.aborted && !st.stopRequested && st.forced.length) {
        const r = onAborted(st, '')
        if (r === 'continue') continue
        return r
      }
      finish(st, 'error')
      return { kind: 'error', error: res.error, userCancelled: true }
    }
    if (signal.aborted || res.kind === 'aborted') {
      const r = onAborted(st, res.kind === 'aborted' ? res.partial : lastText)
      if (r === 'continue') continue
      return r
    }

    if (res.kind === 'error') {
      // Contexto estourado: compacta e tenta de novo (subsessões sempre; principal com autoCompact).
      if (isContextLengthError(res.error) && !st.autoCompactTried) {
        const chat = chatsRepo.get(st.chatId)
        if (chat && autoCompactAllowed(chat, st.depth)) {
          st.compact = { reason: 'auto' }
          continue
        }
      }
      repairTail(st.sessionId)
      appendError(st.sessionId, res.error)
      finish(st, 'error')
      emit({ type: 'error', sessionId: st.sessionId, error: res.error })
      return res
    }

    st.autoCompactTried = false // houve chamada bem-sucedida (usage nova)
    if (res.kind === 'continue') continue

    lastText = res.text
    // Compactação agendada durante o último passo: roda agora e encerra o turno (salvo fila/⚡).
    if (st.compact) {
      st.compactOnly = true
      continue
    }
    // Fim de turno: anexa forçados/fila e continua; senão encerra (checagem + finish síncronos).
    if (st.forced.length) {
      for (const f of st.forced.splice(0)) {
        const s = sessionsRepo.get(st.sessionId)
        if (s) appendUser(s, f.text, { kind: 'forced', ...f.meta }, f.attachments, f.skillParts)
      }
      continue
    }
    if (hasQueued(st.sessionId)) continue
    // Subagente com filhos em segundo plano pendentes: dorme até os callbacks; só reporta ao pai
    // quando encerrar um turno sem filhos pendentes.
    if (st.depth > 0 && reports.pending(st.sessionId).length) {
      const aborted = await sleepWhilePending(st)
      if (shuttingDown) {
        if (runs.get(st.sessionId) === st) runs.delete(st.sessionId)
        return { kind: 'aborted', partial: '' }
      }
      if (aborted) {
        const r = onAborted(st, res.text)
        if (r === 'continue') continue
        return r
      }
      if (hasQueued(st.sessionId)) continue
    }
    finish(st, st.depth === 0 ? 'idle' : 'done')
    return { kind: 'final', text: res.text }
  }
}

/** `{ reasoningMs }` da resposta (vazio sem raciocínio medido). */
function withReasoningMs(acc: StreamAccumulator): Pick<MessageMeta, 'reasoningMs'> {
  const ms = reasoningDuration(acc, Date.now())
  return ms != null ? { reasoningMs: ms } : {}
}

async function step(st: RunState, signal: AbortSignal): Promise<StepResult> {
  const session = sessionsRepo.get(st.sessionId)
  if (!session) return { kind: 'error', error: 'Sessão não encontrada (chat apagado?).' }
  const chat = chatsRepo.get(session.chatId)
  if (!chat) return { kind: 'error', error: 'Chat não encontrado.' }
  // Chamada de voz ativa: os overrides do turno (modelo/params, tools, voicePrompt) valem só nas
  // requests/tools deste turno — o chat salvo e o histórico não mudam (SPEC → "Chamada de voz").
  const call = voiceCallContextFor(chat, session)
  const reqSession = call?.model ? { ...session, model: call.model.model } : session
  let provider: Provider | null
  if (call?.model) {
    provider = providersRepo.get(call.model.providerId)
    if (!provider)
      return {
        kind: 'error',
        error: `Provider "${call.model.providerId}" da chamada de voz não está configurado.`
      }
  } else {
    provider = providerFor(chat, session)
  }
  if (!provider) return { kind: 'error', error: 'Nenhum provider configurado para este chat.' }
  if (!reqSession.model)
    return { kind: 'error', error: 'Nenhum modelo selecionado para este chat.' }
  // turno de voz: o raciocínio do modelo da chamada sai/fica mínimo salvo se os params da chamada
  // o definem (precisa do tipo do provedor e do /models — SPEC → "Chamada de voz → raciocínio")
  const reqChat = call
    ? applyVoiceCallChat(chat, call, {
        kind: providerKind(provider),
        info: modelInfoFor(provider.id, reqSession.model)
      })
    : chat

  const history = messagesRepo.path(session.id)
  // memória: o índice vai congelado por sessão (snapshot no 1º request; ver memory/service.ts)
  if (session.depth === 0) ensureSnapshot(chat, session)
  let req: BuiltRequest
  try {
    req = buildRequest(reqChat, reqSession, history, provider)
  } catch (e) {
    return { kind: 'error', error: errMsg(e) }
  }

  dbg('step', session.id.slice(0, 8), 'model', reqSession.model, 'msgs', history.length)
  let acc = newAccumulator()
  const draft = throttle(
    () => emit({ type: 'draft', sessionId: session.id, draft: accToDraft(acc) }),
    40
  )
  let t0 = Date.now()
  let first = true
  // Falha de REDE → card "Tentar de novo / Cancelar" (sessão 'awaiting_retry'); o parcial é
  // descartado e a chamada refeita do zero (request reconstruída do histórico, que não mudou).
  const r = await callWithNetworkRetry({
    signal,
    attempt: async () => {
      if (!first) {
        req = buildRequest(reqChat, reqSession, messagesRepo.path(session.id), provider)
        acc = newAccumulator()
        t0 = Date.now()
      }
      first = false
      // relógio do raciocínio (meta.reasoningMs e o "Pensando… N s" do rascunho)
      await streamChat(req, signal, acc, () => {
        markReasoning(acc, Date.now())
        draft.call()
      })
    },
    isNetwork: isConnectionFailure,
    onDiscard: () => {
      draft.cancel()
      emit({ type: 'draft', sessionId: session.id, draft: null })
      acc = newAccumulator()
    },
    ask: (e) => awaitRetryDecision(st, session, chat, provider, e, signal)
  })
  if (r.kind !== 'ok') {
    draft.cancel()
    emit({ type: 'draft', sessionId: session.id, draft: null })
    dbg('stream fail', session.id.slice(0, 8), r.kind === 'error' ? errMsg(r.error) : 'aborted')
    // card de falha de conexão cancelado (botão, Parar ou ⚡): nada parcial a salvar (já descartado)
    if (r.kind === 'error' && r.network)
      return { kind: 'error', error: errMsg(r.error), networkCancelled: true }
    if (r.kind === 'aborted' || signal.aborted) {
      if (acc.content.trim()) {
        append(
          session.id,
          {
            role: 'assistant',
            content: acc.content,
            ...(acc.reasoning.trim() ? { reasoning: acc.reasoning } : {})
          },
          {
            interrupted: true,
            model: acc.model ?? reqSession.model,
            durationMs: Date.now() - t0,
            ...withReasoningMs(acc),
            ...voiceReplyMeta(chat, session, acc.content, true)
          }
        )
      }
      return { kind: 'aborted', partial: acc.content }
    }
    return { kind: 'error', error: errMsg(r.error) }
  }
  draft.cancel()
  emit({ type: 'draft', sessionId: session.id, draft: null })
  dbg(
    'stream ok',
    session.id.slice(0, 8),
    Date.now() - t0,
    'ms',
    acc.finishReason,
    'tool_calls',
    acc.toolCalls.length
  )

  const calls: ToolCall[] = finalizeToolCalls(acc).map((t) => ({
    id: t.id,
    type: 'function',
    function: { name: t.name, arguments: t.arguments }
  }))
  const assistant: ApiMessage = {
    role: 'assistant',
    content: acc.content ? acc.content : calls.length ? null : '',
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(acc.reasoning.trim() ? { reasoning: acc.reasoning } : {})
  }
  const meta: MessageMeta = {
    model: acc.model ?? reqSession.model,
    durationMs: Date.now() - t0,
    ...withReasoningMs(acc)
  }
  if (acc.usage) meta.usage = acc.usage
  Object.assign(meta, voiceReplyMeta(chat, session, acc.content))
  append(session.id, assistant, meta)

  // ---- tools nativas ----
  if (calls.length) {
    /** `end_call` rodou: o turno termina aqui (sem nova chamada ao modelo — a chamada vai cair). */
    let hungUp = false
    for (const call of calls) {
      if (signal.aborted) break
      const r = await executeTool(
        st,
        session,
        call.id,
        call.function.name,
        call.function.arguments,
        signal
      )
      const tmeta: MessageMeta = { toolStatus: r.status, durationMs: r.durationMs }
      if (r.subSessionId) tmeta.subSessionId = r.subSessionId
      if (r.shellCwd) tmeta.shellCwd = r.shellCwd
      if (r.targetChatId) tmeta.targetChatId = r.targetChatId
      if (r.background) tmeta.background = true
      if (r.smartApprove) tmeta.smartApprove = r.smartApprove
      if (r.smartOverride) tmeta.smartOverride = true
      if (r.approval) tmeta.approval = r.approval
      if (r.askUser) tmeta.askUser = r.askUser
      if (r.memoryChanges?.length) tmeta.memoryChanges = r.memoryChanges
      if (r.presentFiles) tmeta.presentFiles = r.presentFiles
      if (r.status === 'cancelled') {
        tmeta.synthetic = true
        tmeta.kind = 'tool-cancelled'
      }
      append(
        session.id,
        { role: 'tool', tool_call_id: call.id, content: r.parts?.length ? r.parts : r.content },
        tmeta
      )
      if (call.function.name === 'end_call' && r.status === 'ok') hungUp = true
      if (r.status === 'cancelled' && signal.aborted) break
    }
    if (signal.aborted) return { kind: 'aborted', partial: '' }
    if (hungUp) return { kind: 'final', text: acc.content }
    return { kind: 'continue' }
  }

  // ---- modo texto (sem tools nativas) ----
  if (
    !reqChat.config.nativeTools &&
    availableTools(reqChat, session, history).length &&
    acc.content
  ) {
    const parsed = parseTextToolCalls(acc.content, availableTools(reqChat, session, history))
    if (parsed.length) {
      const parts: string[] = []
      // read_file de imagem/PDF no modo texto: os parts vão na própria mensagem user sintética
      const media: ContentPart[] = []
      let subSessionId: string | undefined
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        if (signal.aborted) {
          parts.push(formatTextToolResult(p.name, CANCELLED_TEXT))
          continue
        }
        if (p.error) {
          parts.push(formatTextToolResult(p.name, `Erro: ${p.error}`))
          continue
        }
        const id = `text_${Date.now().toString(36)}_${i}`
        const r = await executeTool(st, session, id, p.name, p.args, signal)
        if (r.subSessionId) subSessionId = r.subSessionId
        parts.push(formatTextToolResult(p.name, r.content))
        if (r.parts) media.push(...r.parts.filter((x) => x._attachment))
      }
      const umeta: MessageMeta = { synthetic: true }
      if (subSessionId) umeta.subSessionId = subSessionId
      const text = parts.join('\n\n')
      append(
        session.id,
        { role: 'user', content: media.length ? [{ type: 'text', text }, ...media] : text },
        umeta
      )
      if (signal.aborted) return { kind: 'aborted', partial: '' }
      return { kind: 'continue' }
    }
  }

  return { kind: 'final', text: acc.content }
}

/**
 * Modo Listas (commands / processes / pages): blacklist bloqueia tudo (precede), whitelist libera;
 * o resto vira UM card com todos os sub-comandos (os liberados marcados). Retorna `outcome` quando
 * a chamada NÃO deve rodar (bloqueada, negada, cancelada); senão roda com `record`.
 */
async function listsGate(
  chatId: string,
  sessionId: string,
  toolCallId: string,
  name: ToolName,
  item: ApprovalListItem,
  args: Record<string, unknown>,
  signal: AbortSignal,
  /** Modo smart: o juiz pediu sua decisão (ou não decidiu) — o card mostra o motivo. */
  smart?: SmartApproveRecord,
  /** Diretório em que o comando vai rodar (prévia dos scripts executados). */
  runDir?: string,
  /** Modo efetivo do item (registro); ausente = smart com juiz → 'smart', senão 'lists'. */
  mode?: ApprovalMode,
  /** Regras fixas (leitura sempre liberada, caminhos protegidos). */
  safety: SafetyCtx = {}
): Promise<{ outcome?: Omit<ToolOutcome, 'durationMs'>; record: ApprovalRecord }> {
  for (let round = 0; ; round++) {
    const ev = evaluateLists(item, args, getApprovalSettings().lists, safety)
    const allowed = ev.check.items
      .filter((i) => i.verdict === 'allow' && i.entry)
      .map((i) => ({ text: i.text, entry: i.entry! }))
    const readOnly = ev.check.items.filter((i) => i.readOnly).map((i) => checkItemLabel(i))
    const prot = ev.check.items
      .map((i) => i.protectedPath)
      .filter(Boolean)
      .join(', ')
    const record: ApprovalRecord = {
      item,
      mode: mode ?? (smart ? 'smart' : 'lists'),
      ...(allowed.length ? { allowed } : {}),
      ...(readOnly.length ? { readOnly } : {}),
      ...(prot ? { protectedPath: prot } : {})
    }
    if (ev.blocked) {
      const { text, entry, where } = ev.blocked
      return {
        record: { ...record, blocked: { text: where ? `${text} — ${where}` : text, entry } },
        outcome: { content: blockedText(item, ev.blocked), status: 'denied' }
      }
    }
    if (ev.allAllowed) return { record }
    setStatus(sessionId, 'awaiting_approval')
    const outcome = await requestApproval(
      {
        chatId,
        sessionId,
        toolCallId,
        toolName: name,
        args,
        check: runDir ? await fillScriptPreviews(ev.check, runDir) : ev.check,
        ...(smart ? { smartApprove: smart } : {})
      },
      signal
    )
    if (!signal.aborted) setStatus(sessionId, 'running')
    if (signal.aborted || outcome.kind === 'cancel')
      return { record, outcome: { content: CANCELLED_TEXT, status: 'cancelled' } }
    if (outcome.kind === 'reeval') {
      if (round > 50) return { record, outcome: { content: CANCELLED_TEXT, status: 'cancelled' } }
      continue
    }
    const pending = ev.check.items
      .map((it, index) => ({ it, index }))
      .filter(({ it }) => it.verdict !== 'allow')
    const decisions = new Map((outcome.items ?? []).map((d) => [d.index, d]))
    // sem decisões por item: 'allow' = sim para todos; 'deny' = não (o primeiro pendente)
    const entries: { item: ApprovalListItem; list: 'allow' | 'deny'; entry: string }[] = []
    let denied: string | undefined
    const userAllowed: string[] = []
    for (const { it, index } of pending) {
      const d = decisions.get(index)
      const allow = d ? d.allow : outcome.kind === 'allow'
      if (d?.pattern?.trim())
        entries.push({ item, list: allow ? 'allow' : 'deny', entry: d.pattern.trim() })
      if (allow) userAllowed.push(checkItemLabel(it))
      else denied ??= checkItemLabel(it)
    }
    if (entries.length) {
      try {
        addListEntries(entries)
      } catch (e) {
        dbg('approval lists', errMsg(e))
      }
    }
    if (denied !== undefined || outcome.kind === 'deny') {
      const text = denied ?? (pending[0] ? checkItemLabel(pending[0].it) : '')
      return {
        record: { ...record, denied: text, ...(userAllowed.length ? { userAllowed } : {}) },
        outcome: { content: userDeniedText(text), status: 'denied' }
      }
    }
    return { record: { ...record, ...(userAllowed.length ? { userAllowed } : {}) } }
  }
}

// Listas globais mudaram ("+ whitelist" num card, Configurações): cards pendentes cujo veredito
// mudou (algum sub-comando agora liberado/bloqueado) são reavaliados pelo runner.
onApprovalListsChanged(() => {
  const lists = getApprovalSettings().lists
  for (const req of listApprovals()) {
    if (!req.check || req.check.item === 'search') continue
    const chat = chatsRepo.get(req.chatId)
    const session = sessionsRepo.get(req.sessionId)
    const safety =
      chat && session
        ? safetyCtxFor(chat, session, req.toolName, (req.args ?? {}) as Record<string, unknown>)
        : {}
    const ev = evaluateLists(req.check.item, req.args, lists, safety)
    const before = req.check.items.map((i) => `${i.verdict}:${i.entry ?? ''}`).join('|')
    const after = ev.check.items.map((i) => `${i.verdict}:${i.entry ?? ''}`).join('|')
    if (ev.blocked || before !== after) resolveApproval(req.id, { kind: 'reeval' })
  }
})

// ---------------- Smart-Approve: coleta automática de contexto (resumidor) ----------------

/** Grava a descrição capturada na config do chat (sincroniza como o resto da config). */
function saveCaptured(
  chatId: string,
  fn: (st: CapturedContextState | undefined) => CapturedContextState
): void {
  if (shuttingDown) return
  const chat = chatsRepo.get(chatId)
  if (!chat) return
  const { chat: updated } = chatsRepo.update(chatId, {
    config: { capturedContext: fn(chat.config.capturedContext) }
  })
  emit({ type: 'chat-updated', chat: updated })
}

const capture = new ContextCaptureService({
  getChat: (id) => chatsRepo.get(id),
  getSession: (id) => sessionsRepo.get(id),
  history: (id) => messagesRepo.path(id),
  getProvider: (id) => providersRepo.get(id),
  globalModes: () => getApprovalSettings().modes,
  defaults: () => getApprovalSettings().smart,
  save: saveCaptured,
  log: (...a) => dbg(...a)
})

/** Edição sua da descrição capturada (sessionId null = a do chat). */
export function setCapturedContext(chatId: string, sessionId: string | null, text: string): void {
  capture.setText(chatId, sessionId, text)
}

/** Desfaz a última mudança da descrição capturada. */
export function undoCapturedContext(chatId: string, sessionId: string | null): void {
  capture.undo(chatId, sessionId)
}

/** Ids dos subagentes acima (o mais próximo primeiro), sem a principal. */
function parentChain(session: Session): string[] {
  const out: string[] = []
  let cur: Session | null = session
  for (let i = 0; cur?.parentSessionId && i < 4; i++) {
    const p = sessionsRepo.get(cur.parentSessionId)
    if (!p || p.depth === 0) break
    out.push(p.id)
    cur = p
  }
  return out
}

/** Regras fixas (approvalSafety.ts): home, diretório do comando, raiz e os dados do app. */
function safetyCtxFor(
  chat: Chat,
  session: Session,
  name: ToolName,
  args: Record<string, unknown>
): SafetyCtx {
  const root = chat.config.cwd
  return {
    home: homedir(),
    root,
    cwd: name === 'shell' || name === 'process_start' ? runDirFor(chat, session, name, args) : root,
    appData: [dirname(getDbPath())]
  }
}

/**
 * write_file/edit_file: o caminho é protegido? Fica dentro da raiz (após realpath, seguindo links)?
 * — "Aceitar edições dentro da raiz" e caminhos protegidos.
 */
async function fileGateInfo(
  chat: Chat,
  args: Record<string, unknown>,
  safety: SafetyCtx
): Promise<{ protectedPath?: string; inside: boolean }> {
  const raw = typeof args.path === 'string' ? args.path.trim() : ''
  if (!raw) return { inside: false }
  const abs = resolvePath(chat.config.cwd, raw)
  const real = await realpathDeep(abs).catch(() => abs)
  const rootReal = await realpathDeep(chat.config.cwd).catch(() => chat.config.cwd)
  const rule =
    protectedRule(normalizePath(abs, safety), safety) ??
    protectedRule(normalizePath(real, safety), safety)
  return {
    ...(rule ? { protectedPath: `${raw} (${rule.label})` } : {}),
    inside: isInsideRoot(rootReal, real)
  }
}

/** Diretório em que shell/process_start vai rodar: o cwd do shell da sessão (ou o `cwd` do processo). */
function runDirFor(
  chat: Chat,
  session: Session,
  name: ToolName,
  args: Record<string, unknown>
): string {
  const root = chat.config.cwd
  if (name === 'process_start' && typeof args.cwd === 'string' && args.cwd.trim())
    return resolveScriptPath(args.cwd, root)
  return shellStateFor(session.id, root, () => lastShellCwd(session.id)).dir
}

/**
 * Contexto extra do juiz (ver @shared/smartApproveContext): objetivo do usuário na sessão principal,
 * tarefa do subagente (e dos subagentes acima), atividade recente e arquivos tocados (sessão + pais).
 * Lê os históricos persistidos — só quando o juiz vai ser chamado.
 */
function judgeExtrasFor(
  session: Session,
  cwd: string,
  history: StoredMessage[],
  opts: {
    item?: ApprovalItem
    check?: ApprovalCheck
    judgeIdx?: number[]
    lists?: ReturnType<typeof getApprovalSettings>['lists']
  }
): JudgeExtras {
  const parents: { title: string; task: string | null; history: StoredMessage[] }[] = []
  let mainHistory = history
  let cur: Session | null = session
  for (let i = 0; cur?.parentSessionId && i < 4; i++) {
    const p = sessionsRepo.get(cur.parentSessionId)
    if (!p) break
    const h = messagesRepo.path(p.id)
    if (p.depth === 0 || !p.parentSessionId) {
      mainHistory = h
      break
    }
    parents.push({ title: p.title, task: p.task, history: h })
    cur = p
  }
  return buildJudgeExtras({
    history,
    mainHistory,
    subagent:
      session.depth > 0 ? { depth: session.depth, title: session.title, task: session.task } : null,
    parents,
    cwd,
    ...opts
  })
}

async function executeTool(
  st: RunState,
  session: Session,
  toolCallId: string,
  rawName: string,
  rawArgs: string | Record<string, unknown>,
  signal: AbortSignal
): Promise<ToolOutcome> {
  const t0 = Date.now()
  let smart: SmartApproveRecord | undefined
  let smartOverride = false
  let approval: ApprovalRecord | undefined
  const done = (o: Omit<ToolOutcome, 'durationMs'>): ToolOutcome => ({
    ...o,
    ...(smart ? { smartApprove: smart } : {}),
    ...(smartOverride ? { smartOverride: true } : {}),
    ...(approval ? { approval } : {}),
    durationMs: Date.now() - t0
  })
  const chat = chatsRepo.get(session.chatId)
  if (!chat) return done({ content: 'Erro: chat não encontrado.', status: 'error' })
  const name = (TOOL_ALIASES[rawName] ?? rawName) as ToolName // 'bash' (antigo) → 'shell'
  // chamada de voz: as tools do turno (`voice.tools.enabledTools`) valem também na execução —
  // o gate espelha as tools enviadas na request (SPEC → "Chamada de voz (meia-duplex)")
  const call = voiceCallContextFor(chat, session)
  const gateChat = call ? applyVoiceCallChat(chat, call) : chat
  if (!availableTools(gateChat, session).includes(name)) {
    return done({
      content: `Erro: a ferramenta "${rawName}" não está disponível nesta sessão.`,
      status: 'error'
    })
  }
  let args: Record<string, unknown>
  try {
    args = parseToolArgs(rawArgs)
  } catch (e) {
    return done({ content: `Erro: ${errMsg(e)}`, status: 'error' })
  }
  // chamada de voz: `end_call` não pede aprovação (só encerra a chamada — o VoiceCallManager vê o
  // resultado no histórico e desliga quando a resposta terminar de tocar)
  if (name === 'end_call') return done({ content: END_CALL_RESULT, status: 'ok' })

  // Gate de aprovação (ver @shared/approvalPolicy): modo efetivo do item (always | smart | lists).
  // Tools que não são itens (leitura, process_stop…) rodam direto; ask_user nunca pede confirmação.
  const settings = getApprovalSettings()
  let route =
    name === 'ask_user'
      ? { kind: 'run' as const }
      : approvalRoute(chat.config, settings.modes, name)
  const item = TOOL_ITEM[name]
  const mode = item ? effectiveMode(chat.config, settings.modes, item) : null
  if (route.kind !== 'run' && takeOverride(session.id, name, args)) {
    // "Executar mesmo assim": o usuário já liberou exatamente esta chamada (uma vez)
    smartOverride = true
    route = { kind: 'run' }
  }
  // Regras fixas (@shared/approvalSafety): caminho protegido SEMPRE pergunta (whitelist, juiz,
  // "Sempre permitir" e "Aceitar edições" não liberam; a blacklist continua bloqueando); comando só
  // de leitura SEMPRE roda (sem card, sem juiz); "Aceitar edições dentro da raiz" libera
  // write_file/edit_file na raiz. "Executar mesmo assim" (smartOverride) já é a sua aprovação.
  const safety = item ? safetyCtxFor(chat, session, name, args) : {}
  let protectedFile: string | undefined
  if (item && mode && !smartOverride && (name === 'write_file' || name === 'edit_file')) {
    const f = await fileGateInfo(chat, args, safety).catch(() => ({ inside: false }) as const)
    if ('protectedPath' in f && f.protectedPath) {
      protectedFile = f.protectedPath
      route = { kind: 'user' }
    } else if (
      route.kind !== 'run' &&
      f.inside &&
      effectiveAcceptEdits(chat.config, settings.smart)
    ) {
      route = { kind: 'run' }
      approval = { item, mode, acceptEdits: true }
    }
  }
  if (item && mode && !smartOverride && (name === 'shell' || name === 'process_start')) {
    const ev = evaluateLists(item, args, settings.lists, safety)
    if (route.kind === 'run') {
      // "Sempre permitir" + caminho protegido → card das listas
      if (ev.protected) route = { kind: 'lists' }
    } else if (!ev.blocked && ev.readOnly) {
      route = { kind: 'run' }
      approval = { item, mode, readOnly: ev.check.items.map((i) => checkItemLabel(i)) }
    } else if (!ev.blocked && ev.protected) {
      // juiz não é chamado (não poderia liberar); Smart sem modelo → o card das listas também
      route = { kind: 'lists' }
    }
  }
  // Modo smart: nos itens com listas, as listas decidem primeiro (smartListPlan) — blacklist
  // bloqueia sem juiz; 100% whitelist roda sem juiz (a menos que `judgeWhitelisted`); o juiz decide
  // só os itens que sobraram (os liberados vão como contexto). Juiz pede/falha → card das listas
  // com o motivo (itens com listas) ou pergunta simples.
  let smartCheck: ApprovalCheck | undefined
  if (route.kind === 'judge') {
    const sa = normalizeSmartApprove(chat.config.smartApprove)
    let judgeIdx: number[] | undefined
    if (isListItem(item)) {
      const plan = smartListPlan(item, args, settings.lists, {
        judgeWhitelisted: sa.judgeWhitelisted,
        safety
      })
      const allowed = plan.ev.check.items
        .filter((i) => i.verdict === 'allow' && i.entry)
        .map((i) => ({ text: i.text, entry: i.entry! }))
      const readOnly = plan.ev.check.items.filter((i) => i.readOnly).map((i) => checkItemLabel(i))
      approval = {
        item,
        mode: 'smart',
        ...(allowed.length ? { allowed } : {}),
        ...(readOnly.length ? { readOnly } : {})
      }
      if (plan.kind === 'blocked') {
        const { text, entry, where } = plan.ev.blocked!
        approval.blocked = { text: where ? `${text} — ${where}` : text, entry }
        return done({ content: blockedText(item, plan.ev.blocked!), status: 'denied' })
      }
      if (plan.kind === 'run') route = { kind: 'run' }
      else if (plan.kind === 'protected') route = { kind: 'lists' }
      else {
        // o juiz vê o começo dos scripts que o comando executa
        smartCheck = await fillScriptPreviews(plan.ev.check, runDirFor(chat, session, name, args))
        judgeIdx = plan.judgeIdx
      }
    }
    if (route.kind === 'judge') {
      emit({
        type: 'tool-running',
        sessionId: session.id,
        toolCallId,
        running: true,
        judging: true
      })
      try {
        // o juiz espera o resumo da sessão (descrição atualizada); teto de 20 s → julga assim mesmo
        await capture.waitIdle(session.id)
        if (signal.aborted) return done({ content: CANCELLED_TEXT, status: 'cancelled' })
        const fresh = chatsRepo.get(chat.id) ?? chat
        const history = messagesRepo.path(session.id)
        smart = await runJudge({
          sa,
          provider: sa.providerId ? providersRepo.get(sa.providerId) : null,
          chatConfig: chat.config,
          ctx: {
            tool: name,
            args,
            cwd: chat.config.cwd,
            confine: chat.config.confineToRoot !== false,
            sandbox: !!chat.config.sandboxBash && bwrapAvailable(),
            history,
            ...(smartCheck && judgeIdx ? { check: smartCheck, judgeIdx } : {}),
            extra: judgeExtrasFor(session, chat.config.cwd, history, {
              item,
              check: smartCheck,
              judgeIdx,
              lists: settings.lists
            }),
            environment: {
              user: effectiveEnvironment(fresh.config.smartApprove, settings.smart),
              captured: capturedTextFor(
                fresh.config.capturedContext,
                session.depth > 0 ? session.id : null,
                parentChain(session)
              )
            }
          },
          signal
        })
      } finally {
        emit({ type: 'tool-running', sessionId: session.id, toolCallId, running: false })
      }
      dbg('smart-approve', name, smart.decision, smart.fallback ?? '', smart.durationMs, 'ms')
      if (signal.aborted) return done({ content: CANCELLED_TEXT, status: 'cancelled' })
      // 'reject' só chega aqui com "O juiz pode negar" (sem ela, runJudge já mapeou para 'ask')
      if (smart.decision === 'reject') {
        return done({ content: smartRejectText(smart.model, smart.reason), status: 'denied' })
      }
      if (smart.decision === 'approve') {
        route = { kind: 'run' }
        if (approval && smart.judged?.length) approval.judgeAllowed = smart.judged
      } else if (smartCheck && smartCheck.items.some((i) => i.verdict !== 'allow')) {
        route = { kind: 'lists' }
      } else {
        // sem item pendente nas listas (tudo na whitelist + "consultar também"): pergunta simples
        route = { kind: 'user' }
      }
    }
  }
  // fail-closed: 'lists' sem item de lista (não deveria acontecer) vira pergunta simples
  if (route.kind === 'lists' && !isListItem(item)) route = { kind: 'user' }
  if (route.kind === 'lists' && isListItem(item)) {
    const r = await listsGate(
      chat.id,
      session.id,
      toolCallId,
      name,
      item,
      args,
      signal,
      mode === 'smart' ? smart : undefined,
      runDirFor(chat, session, name, args),
      mode ?? undefined,
      safety
    )
    approval = r.record
    if (r.outcome) return done(r.outcome)
  } else if (route.kind === 'user') {
    setStatus(session.id, 'awaiting_approval')
    const outcome = await requestApproval(
      {
        chatId: chat.id,
        sessionId: session.id,
        toolCallId,
        toolName: name,
        args,
        ...(smart ? { smartApprove: smart } : {}),
        ...('smartMissing' in route && route.smartMissing && !protectedFile
          ? { smartMissing: true }
          : {}),
        ...(protectedFile ? { protectedPath: protectedFile } : {})
      },
      signal
    )
    if (!signal.aborted) setStatus(session.id, 'running')
    if (protectedFile && item && mode)
      approval = { ...(approval ?? { item, mode }), protectedPath: protectedFile }
    if (outcome.kind === 'deny') {
      if (item && mode)
        approval = { ...(approval ?? { item, mode }), denied: argsSummary(name, args) }
      return done({ content: DENIED_TEXT, status: 'denied' })
    }
    if (outcome.kind !== 'allow' || signal.aborted)
      return done({ content: CANCELLED_TEXT, status: 'cancelled' })
    // registro da sua aprovação (card compacto "Aprovado por você"; contexto do juiz depois)
    if (item && mode)
      approval = {
        ...(approval ?? { item, mode }),
        userAllowed: [argsSummary(name, args)]
      }
  } else if (route.kind === 'run' && item && mode === 'always' && !smartOverride) {
    approval = { item, mode: 'always' }
  }
  if (signal.aborted) return done({ content: CANCELLED_TEXT, status: 'cancelled' })

  emit({ type: 'tool-running', sessionId: session.id, toolCallId, running: true })
  let latest = ''
  const out = throttle(
    () =>
      emit({
        type: 'tool-running',
        sessionId: session.id,
        toolCallId,
        running: true,
        output: latest.length > 20_000 ? latest.slice(-20_000) : latest
      }),
    150
  )
  try {
    if (name === 'delegate_task') {
      return done(await runDelegate(st, session, chat, toolCallId, args, signal))
    }
    if (name === 'send_to_chat') return done(await runSendToChat(session, chat, args, signal))
    if (name === 'check_subagents') return done(runCheckSubagents(session, chat, args))
    if (name === 'wait_subagents') return done(await runWaitSubagents(session, chat, args, signal))
    if (name === 'cancel_subagent') return done(await runCancelSubagent(session, chat, args))
    if (name === 'message_subagent')
      return done(await runMessageSubagent(session, chat, args, signal))
    if (name === 'ask_user') return done(await runAskUser(session, chat, toolCallId, args, signal))
    if (MEMORY_TOOL_NAMES.includes(name)) {
      const r = runMemoryToolFor(chat, session, name, args)
      return done({
        content: r.content,
        status: r.status,
        ...(r.changes?.length ? { memoryChanges: r.changes } : {})
      })
    }
    const root = chat.config.cwd
    const provider = name === 'list_models' ? providerFor(chat, session) : null
    const sessionProvider =
      name === 'read_file' || name === 'skill_read' ? providerFor(chat, session) : null
    const sandbox = !!chat.config.sandboxBash
    // skills: as ativas desta sessão (tools) e, no sandbox, as pastas delas montadas só leitura
    const skills = SKILL_TOOL_NAMES.includes(name) ? await sessionSkills(chat, session) : undefined
    const roBinds =
      sandbox && (name === 'shell' || name === 'process_start')
        ? await sandboxSkillDirs(chat, session)
        : undefined
    const allProviders = name === 'list_models' ? modelSources(chat, session) : []
    const r = await runLocalTool(name, args, {
      cwd: root,
      confine: chat.config.confineToRoot !== false,
      // turno de chamada de voz: list_dir/read_file toleram erro de caixa do STT no caminho
      ...(call ? { voicePaths: true } : {}),
      maxOutput: toolOutputLimit(chat, session),
      // saída grande → userData/tool-outputs/<chat>/<toolCallId>.txt (setting global do dispositivo)
      spillChars: settingsRepo.get<number>(TOOL_SPILL_SETTING) ?? undefined,
      toolCallId,
      sandbox,
      ...(roBinds?.length ? { roBinds } : {}),
      ...(skills ? { skills } : {}),
      shell:
        name === 'shell' || name === 'process_start'
          ? shellStateFor(session.id, root, () => lastShellCwd(session.id))
          : undefined,
      cacheKey: session.id,
      chatId: chat.id,
      sessionId: session.id,
      models:
        provider || allProviders.length
          ? {
              providerName: provider?.name ?? '',
              current: session.model,
              list: () =>
                provider ? listModels(provider) : Promise.reject(new Error('sem provedor')),
              providers: allProviders
            }
          : undefined,
      chats:
        name === 'get_chat_info' || name === 'list_chats' ? chatToolsCtx(chat, session) : undefined,
      history: name === 'read_history' ? () => messagesRepo.path(session.id) : undefined,
      historyStore: name === 'read_history' ? historyStore(getDb()) : undefined,
      // read_file: imagens/PDF só se o modelo da sessão os lê (mesma regra dos anexos)
      media: sessionProvider
        ? {
            providerKind: providerKind(sessionProvider),
            model: async () =>
              (await listModels(sessionProvider)).find((m) => m.id === session.model) ?? null
          }
        : undefined,
      signal,
      onOutput: (partial) => {
        latest = partial
        out.call()
      }
    })
    // present_file: concede os arquivos ao protocolo do visualizador + anota o dispositivo
    const presentFiles = r.meta?.presentFiles
      ? await registerPresented(r.meta.presentFiles, viewerDevice())
      : undefined
    return done({
      content: r.content,
      status: r.status,
      shellCwd: r.meta?.shellCwd,
      ...(r.parts?.length ? { parts: r.parts } : {}),
      ...(presentFiles ? { presentFiles } : {})
    })
  } catch (e) {
    if (signal.aborted || (e as Error).name === 'AbortError') {
      return done({ content: CANCELLED_TEXT, status: 'cancelled' })
    }
    return done({ content: `Erro: ${errMsg(e)}`, status: 'error' })
  } finally {
    out.cancel()
    emit({ type: 'tool-running', sessionId: session.id, toolCallId, running: false })
  }
}

/** Provedores de chat (os de voz — ElevenLabs — ficam fora das tools de modelos/subagente). */
function chatProviders(): ReturnType<typeof providersRepo.list> {
  return providersRepo.list().filter(isChatProvider)
}

/** Todos os provedores configurados como fontes de modelos (o da sessão primeiro, marcado). */
function modelSources(chat: Chat, session: Session): ModelSource[] {
  const own = sessionProviderId(chat.config, session)
  const list = chatProviders().map((p): ModelSource => ({
    id: p.id,
    name: p.name,
    isSession: p.id === own,
    list: () => listModels(p)
  }))
  return [...list.filter((p) => p.isSession), ...list.filter((p) => !p.isSession)]
}

/** Provedor + modelo do subagente (args provider/model; padrão: os da sessão chamadora). */
function resolveSubagent(
  chat: Chat,
  session: Session,
  args: Record<string, unknown>
): ReturnType<typeof resolveSubagentTarget> {
  return resolveSubagentTarget({
    providers: chatProviders().map((p) => ({ id: p.id, name: p.name })),
    callerProviderId: sessionProviderId(chat.config, session),
    callerModel: session.model,
    provider: args.provider,
    model: args.model,
    listModels: (pid) => {
      const p = providersRepo.get(pid)
      return p ? listModels(p) : Promise.reject(new Error('provedor não encontrado'))
    }
  })
}

async function runDelegate(
  _parent: RunState,
  session: Session,
  chat: Chat,
  toolCallId: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<Omit<ToolOutcome, 'durationMs'>> {
  if (session.depth >= MAX_DEPTH) {
    return { content: 'Erro: profundidade máxima de subagentes atingida.', status: 'error' }
  }
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (!task) return { content: 'Erro: argumento obrigatório "task" ausente.', status: 'error' }
  const background = args.background === true || args.background === 'true'
  const target = await resolveSubagent(chat, session, args)
  if ('error' in target) return { content: target.error, status: 'error' }
  const { model, providerId } = target
  const providerName = providersRepo.get(providerId)?.name ?? providerId
  // nota de resolução (ex.: modelo achado em outro provedor) — vai no início do resultado
  const note = target.note ? `[nota: ${target.note}]\n\n` : ''
  const rawTitle =
    (typeof args.title === 'string' && args.title.trim()) || task.replace(/\s+/g, ' ')
  const title = rawTitle.length > 60 ? rawTitle.slice(0, 60).trimEnd() + '…' : rawTitle

  const child = sessionsRepo.create({
    chatId: chat.id,
    parentSessionId: session.id,
    parentToolCallId: toolCallId,
    depth: (session.depth + 1) as 1 | 2,
    model,
    // provedor escolhido (padrão: o da sessão que o criou); trocar o do chat depois não o muda
    providerId,
    title,
    task,
    status: 'running'
  })
  emit({ type: 'session-created', session: child })
  const taskMsg = append(child.id, { role: 'user', content: task }, { synthetic: true })
  // coleta de contexto: a descrição do subagente = a do pai + a tarefa (o juiz dele usa esta)
  capture.deriveForSubagent(session, child, task, taskMsg)

  if (background) {
    // sem o signal do pai: Parar/⚡ na sessão pai não derrubam subagentes em segundo plano
    const bst = startLoop(child)
    attachReport(bst, child, false)
    return {
      content: `${note}Subagente iniciado em segundo plano (id ${child.id}, ${providerName} · ${model}). Você receberá o resultado automaticamente quando ele terminar.`,
      status: 'ok',
      subSessionId: child.id,
      background: true
    }
  }

  const cst = startLoop(child, signal)
  const outcome = await cst.done
  const max = toolOutputLimit(chat, session)
  if (outcome.kind === 'final') {
    return {
      content: note + truncateHeadTail(outcome.text.trim() || delegateEmptyText(model), max, 0.5),
      status: 'ok',
      subSessionId: child.id
    }
  }
  // pai parado/⚡ (cascata) — inclusive com o card de falha de conexão aberto no subagente
  if (signal.aborted)
    return { content: CANCELLED_TEXT, status: 'cancelled', subSessionId: child.id }
  if (outcome.kind === 'aborted') {
    const partial = outcome.partial.trim()
    return {
      content: `[Subagente interrompido pelo usuário]${partial ? `\n\nResposta parcial:\n${truncate(partial)}` : ''}`,
      status: 'cancelled',
      subSessionId: child.id
    }
  }
  return {
    content: note + delegateFailureText(model, outcome.error),
    status: 'error',
    subSessionId: child.id
  }
}

// ---------------- questionário (ask_user) ----------------

/**
 * ask_user: valida, resolve as imagens (store de anexos), mostra o questionário (sessão
 * 'awaiting_input') e espera. Respondeu → texto compacto + respostas estruturadas no meta.
 * Cancelou (Esc / Parar / ⚡ → abort do signal) → `[O usuário não respondeu ao questionário]`; o
 * abort faz o loop parar (Parar/Esc: turno termina, sem nova chamada; ⚡: entra a mensagem forçada).
 */
async function runAskUser(
  session: Session,
  chat: Chat,
  toolCallId: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<Omit<ToolOutcome, 'durationMs'>> {
  if (session.depth !== 0)
    return {
      content:
        'Erro: subagentes não podem perguntar ao usuário. Decida sozinho ou devolva a dúvida no resultado final.',
      status: 'error'
    }
  const parsed = parseAskUserArgs(args)
  if ('error' in parsed) return { content: parsed.error, status: 'error' }
  let resolved
  try {
    resolved = await resolveAskUserQuestions(parsed.questions, {
      root: chat.config.cwd,
      confine: chat.config.confineToRoot !== false,
      signal
    })
  } catch (e) {
    if (signal.aborted) return { content: ASK_USER_NOT_ANSWERED, status: 'cancelled' }
    return { content: `Erro: ${errMsg(e)}`, status: 'error' }
  }
  const { questions, notes } = resolved
  const tail = notes.length ? `\n\n${notes.join('\n')}` : ''
  const rec = (r: Omit<AskUserRecord, 'questions' | 'notes'>): AskUserRecord => ({
    questions,
    ...r,
    ...(notes.length ? { notes } : {})
  })
  if (signal.aborted)
    return {
      content: ASK_USER_NOT_ANSWERED + tail,
      status: 'cancelled',
      askUser: rec({ outcome: 'cancelled' })
    }
  setStatus(session.id, 'awaiting_input')
  const outcome = await requestQuestion(
    {
      chatId: chat.id,
      sessionId: session.id,
      toolCallId,
      questions,
      ...(notes.length ? { notes } : {})
    },
    signal
  )
  if (outcome.kind === 'cancel' || signal.aborted)
    return {
      content: ASK_USER_NOT_ANSWERED + tail,
      status: 'cancelled',
      askUser: rec({ outcome: 'cancelled' })
    }
  setStatus(session.id, 'running')
  const max = toolOutputLimit(chat, session)
  return {
    content: truncateHeadTail(formatAskUserResult(questions, outcome.answers, notes), max, 0.5),
    status: 'ok',
    askUser: rec({ outcome: 'answered', answers: outcome.answers })
  }
}

// ---------------- falha de conexão (Tentar de novo / Cancelar) ----------------

/**
 * Chamada ao modelo falhou por erro de rede: sessão 'awaiting_retry' + card bloqueante até o
 * usuário decidir. Subagentes também esperam aqui (o pai bloqueante continua esperando o delegate).
 */
async function awaitRetryDecision(
  st: RunState,
  session: Session,
  chat: Chat,
  provider: Provider,
  error: unknown,
  signal: AbortSignal
): Promise<RetryOutcome> {
  if (shuttingDown || signal.aborted) return 'cancel'
  dbg('network fail → card', session.id.slice(0, 8), errMsg(error))
  setStatus(session.id, 'awaiting_retry')
  const outcome = await requestRetry(
    {
      chatId: chat.id,
      sessionId: session.id,
      error: connectionErrorText(error),
      model: session.model,
      providerName: provider.name
    },
    signal
  )
  if (outcome === 'retry' && !signal.aborted && runs.get(st.sessionId) === st)
    setStatus(session.id, 'running')
  return signal.aborted ? 'cancel' : outcome
}

// ---------------- chats: get_chat_info / list_chats / send_to_chat ----------------

/** Estado de um chat para list_chats: aprovação pendente > alguma sessão rodando > ocioso. */
function chatStatus(chatId: string): ChatListEntry['status'] {
  if (listApprovals().some((a) => a.chatId === chatId)) return 'awaiting_approval'
  if (listQuestions().some((q) => q.chatId === chatId)) return 'awaiting_input'
  if (listRetries().some((q) => q.chatId === chatId)) return 'awaiting_retry'
  for (const st of runs.values()) if (st.chatId === chatId) return 'running'
  return 'idle'
}

function chatToolsCtx(chat: Chat, session: Session): ToolContext['chats'] {
  return {
    self: () => ({
      chatId: chat.id,
      title: chat.title,
      sessionId: session.id,
      mainSessionId: chat.mainSessionId,
      depth: session.depth,
      parentSessionId: session.parentSessionId,
      sessionTitle: session.title,
      model: session.model,
      providerName: providerFor(chat, session)?.name ?? '',
      root: chat.config.cwd,
      createdAt: chat.createdAt
    }),
    list: () =>
      chatsRepo.list().map((c) => ({
        id: c.id,
        title: c.title,
        model: c.config.model,
        status: chatStatus(c.id),
        updatedAt: c.updatedAt,
        self: c.id === chat.id
      }))
  }
}

/** Esperas em andamento (send_to_chat com wait_for_reply): chat que espera → chat aguardado. */
const waitEdges: (WaitEdge & { id: number })[] = []
let waitSeq = 0

/** Id exato ou prefixo único (≥ 4 caracteres) — modelos às vezes abreviam UUIDs. */
function resolveChatRef(ref: string): Chat | 'ambiguous' | null {
  const exact = chatsRepo.get(ref)
  if (exact) return exact
  const r = ref.toLowerCase()
  if (r.length < 4) return null
  const m = chatsRepo.list().filter((c) => c.id.startsWith(r))
  return m.length === 1 ? m[0] : m.length > 1 ? 'ambiguous' : null
}

/**
 * Entrega uma mensagem `role: user` a uma sessão como se o usuário a digitasse: rodando (ou
 * dormindo) → fila, injetada no próximo limite de passo; ociosa → inicia um turno. Subsessão
 * retomada → a nova resposta final volta ao pai como callback (atualização). `wake=false` só
 * registra a mensagem numa sessão parada (não inicia turno).
 */
function deliverToSession(
  session: Session,
  text: string,
  meta: MessageMeta,
  wake = true,
  attachments: AttachmentInfo[] = [],
  skillParts: ContentPart[] = []
): { queuedId?: string; run?: RunState } {
  const cur = runs.get(session.id)
  if (cur) {
    const q = enqueue(session.id, text, attachments, meta, skillParts)
    wakeSession(session.id)
    return { queuedId: q.id, run: cur }
  }
  repairTail(session.id)
  appendUser(session, text, meta, attachments, skillParts)
  if (!wake) return {}
  const run = startLoop(session)
  if (session.depth > 0 && session.parentSessionId) attachReport(run, session, true)
  return { run }
}

function lastAssistantText(sessionId: string): string {
  const msgs = messagesRepo.path(sessionId)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.message.role === 'assistant' && !isDisplayOnly(m.meta)) return m.message.content ?? ''
  }
  return ''
}

/** Fim de `done`, timeout (ms) ou abort do chamador (rejeita com AbortError). */
function raceDone<T>(done: Promise<T>, ms: number, signal: AbortSignal): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    if (ms <= 0) return resolve('timeout')
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(abortError())
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve('timeout')
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
    void done.then((o) => {
      cleanup()
      resolve(o)
    })
  })
}

type TurnWait = (LoopOutcome | { kind: 'timeout' } | { kind: 'undelivered' }) & { run?: RunState }

/**
 * Aguarda o turno do chat de destino que vai tratar a mensagem entregue terminar. Se ela ficou na
 * fila e o loop acabou sem entregá-la (Parar), devolve 'undelivered'.
 */
async function waitForTurn(
  sessionId: string,
  queuedId: string | undefined,
  signal: AbortSignal,
  ms: number
): Promise<TurnWait> {
  const deadline = Date.now() + ms
  for (;;) {
    if (signal.aborted) throw abortError()
    const st = runs.get(sessionId)
    if (!st) {
      if (queuedId && isQueued(sessionId, queuedId)) return { kind: 'undelivered' }
      return { kind: 'final', text: lastAssistantText(sessionId) }
    }
    const r = await raceDone(st.done, deadline - Date.now(), signal)
    if (r === 'timeout') return { kind: 'timeout', run: st }
    if (queuedId && isQueued(sessionId, queuedId)) {
      const again = runs.get(sessionId)
      if (again && again !== st) continue
      return { kind: 'undelivered' }
    }
    return { ...r, run: st }
  }
}

// ---------------- roteamento do send_to_chat (sync) ----------------

/** Onde a mensagem entre chats foi parar: aqui (entrega local) ou no host remoto do destino. */
export type InterChatRoute =
  { kind: 'local' } | { kind: 'remote'; queued: boolean; hostName: string }

/**
 * Instalado pelo sync: decide se o chat de destino roda aqui (entrega local) ou em outro
 * dispositivo (comando `send` ao host). Lança com o motivo quando não dá para entregar (host
 * offline, chat divergente, sem conexão com o chat rodando em outro lugar) — entregar localmente
 * nesses casos criaria conteúdo só deste dispositivo e levaria à divergência.
 */
type InterChatRouter = (
  targetChatId: string,
  sessionId: string,
  text: string,
  meta: InterChatSendMeta
) => Promise<InterChatRoute>
let interChatRouter: InterChatRouter | null = null

export function setInterChatRouter(fn: InterChatRouter | null): void {
  interChatRouter = fn
}

/**
 * `send` remoto com origem entre chats (protocolo ≥ 1.6.0, §8.6) executado neste host: grava a
 * mensagem com o meta inter-chat (como a entrega local do send_to_chat), então a cadeia de saltos
 * continua contada aqui. Passou do limite → lança (o host responde `rejected`).
 */
export function deliverInterChat(
  sessionId: string,
  text: string,
  meta: InterChatSendMeta
): { queued: boolean } {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  if (meta.interChatHops > LIMITS.interChatMaxHops)
    throw new Error(
      `limite de ${LIMITS.interChatMaxHops} saltos entre chats atingido — a mensagem não foi entregue.`
    )
  if (!text.trim()) throw new Error('Mensagem vazia.')
  const d = deliverToSession(session, text, {
    kind: 'inter-chat',
    fromChatId: meta.fromChatId,
    ...(meta.fromSessionId ? { fromSessionId: meta.fromSessionId } : {}),
    fromChatTitle: meta.fromChatTitle,
    interChatHops: meta.interChatHops
  })
  const fresh = chatsRepo.get(session.chatId)
  if (fresh) emit({ type: 'chat-updated', chat: fresh })
  return { queued: !!d.queuedId }
}

async function runSendToChat(
  session: Session,
  chat: Chat,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<Omit<ToolOutcome, 'durationMs'>> {
  const fail = (content: string, targetChatId?: string): Omit<ToolOutcome, 'durationMs'> => ({
    content,
    status: 'error',
    ...(targetChatId ? { targetChatId } : {})
  })
  const ref = typeof args.chat_id === 'string' ? args.chat_id.trim() : ''
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (!ref)
    return fail('Erro: argumento obrigatório "chat_id" ausente. Use list_chats para ver os ids.')
  if (!message) return fail('Erro: argumento obrigatório "message" ausente ou vazio.')
  const target = resolveChatRef(ref)
  if (target === 'ambiguous')
    return fail(
      `Erro: "${ref}" corresponde a mais de um chat. Use o id completo (veja list_chats).`
    )
  if (!target) return fail(`Erro: chat não encontrado: "${ref}". Use list_chats para ver os ids.`)
  if (target.id === chat.id)
    return fail(
      'Erro: não é possível enviar uma mensagem para o próprio chat. Para falar com o usuário, responda normalmente.',
      target.id
    )
  const tname = `"${target.title || 'Novo chat'}" (id ${target.id})`
  const targetSession = sessionsRepo.get(target.mainSessionId)
  if (!targetSession) return fail(`Erro: o chat ${tname} não tem sessão principal.`, target.id)

  // Laço entre chats: o turno atual deste chat já veio de uma cadeia de mensagens entre chats?
  const { hops, allowed } = nextInterChatHops(messagesRepo.path(chat.mainSessionId))
  if (!allowed)
    return fail(
      `Erro: limite de ${LIMITS.interChatMaxHops} saltos entre chats atingido — este turno já faz parte de uma cadeia de ${hops - 1} mensagens entre chats. A mensagem NÃO foi enviada; responda normalmente em vez de reenviar.`,
      target.id
    )
  const wait = args.wait_for_reply === true || args.wait_for_reply === 'true'
  const rawT = typeof args.timeout_s === 'number' ? args.timeout_s : Number(args.timeout_s)
  const timeoutS =
    Number.isFinite(rawT) && rawT > 0
      ? Math.min(LIMITS.interChatMaxTimeoutS, Math.max(1, Math.round(rawT)))
      : LIMITS.interChatDefaultTimeoutS
  if (wait && wouldCreateWaitCycle(waitEdges, chat.id, target.id))
    return fail(
      `Erro: ciclo de espera — o chat ${tname} já está aguardando (direta ou indiretamente) uma resposta deste chat; aguardá-lo travaria os dois. A mensagem NÃO foi enviada. Responda normalmente (sua resposta final volta para ele) ou envie sem wait_for_reply.`,
      target.id
    )

  const header = interChatHeader(chat.title, chat.id, {
    waitForReply: wait,
    canReply: availableTools(target, targetSession).includes('send_to_chat')
  })
  const meta: MessageMeta = {
    kind: 'inter-chat',
    fromChatId: chat.id,
    fromSessionId: session.id,
    fromChatTitle: chat.title,
    interChatHops: hops
  }
  const text = interChatText(header, message)
  let route: InterChatRoute = { kind: 'local' }
  if (interChatRouter) {
    try {
      route = await interChatRouter(target.id, targetSession.id, text, {
        kind: 'inter-chat',
        fromChatId: chat.id,
        fromSessionId: session.id,
        fromChatTitle: chat.title,
        interChatHops: hops
      })
    } catch (e) {
      return fail(
        `Erro: não foi possível entregar ao chat ${tname}: ${(e as Error).message} A mensagem NÃO foi enviada.`,
        target.id
      )
    }
  }
  if (route.kind === 'remote') {
    const fresh = chatsRepo.get(target.id)
    if (fresh) emit({ type: 'chat-updated', chat: fresh })
    const where = `O chat ${tname} roda em outro dispositivo (${route.hostName})`
    return {
      content: `${where}: mensagem ${route.queued ? 'enfileirada lá (ele está ocupado)' : 'entregue, iniciou um turno lá'}. ${wait ? 'Aguardar a resposta de um chat executado em outro dispositivo não é suportado; a' : 'A'} resposta ficará naquele chat (veja depois com get_chat_info/read_history) — não reenvie.`,
      status: 'ok',
      targetChatId: target.id
    }
  }
  // registra a espera ANTES de entregar: o destino pode tentar aguardar este chat de imediato
  const edge = wait ? { id: ++waitSeq, from: chat.id, to: target.id } : null
  if (edge) waitEdges.push(edge)
  const done = (
    content: string,
    status: ToolOutcome['status'] = 'ok'
  ): Omit<ToolOutcome, 'durationMs'> => ({ content, status, targetChatId: target.id })
  try {
    const d = deliverToSession(targetSession, text, meta)
    const fresh = chatsRepo.get(target.id)
    if (fresh) emit({ type: 'chat-updated', chat: fresh }) // sidebar: ordem / "atualizado"
    if (!wait)
      return done(
        d.queuedId
          ? `Mensagem enfileirada no chat ${tname}: ele está ocupado; será entregue no próximo passo dele. A resposta não volta automaticamente.`
          : `Mensagem entregue ao chat ${tname}: iniciou um turno lá. A resposta não volta automaticamente (use wait_for_reply=true para aguardar).`
      )
    let r: TurnWait
    try {
      r = await waitForTurn(targetSession.id, d.queuedId, signal, timeoutS * 1000)
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError')
        return done(
          `${CANCELLED_TEXT} A mensagem já tinha sido entregue ao chat ${tname}; a resposta ficará lá.`,
          'cancelled'
        )
      throw e
    }
    const max = toolOutputLimit(chat, session)
    switch (r.kind) {
      case 'final':
        return done(
          truncateHeadTail(
            `Resposta do chat ${tname}:\n\n${r.text.trim() || '(o chat terminou o turno sem texto)'}`,
            max,
            0.5
          )
        )
      case 'timeout':
        return done(
          `[O chat ${tname} ainda está rodando após ${timeoutS}s; a resposta ficará no chat ${target.id}. A mensagem foi entregue — não reenvie; verifique depois com list_chats.]`
        )
      case 'undelivered':
        return done(
          `[A mensagem ficou na fila do chat ${tname}: o turno dele foi interrompido antes de entregá-la.]`,
          'error'
        )
      case 'aborted': {
        const partial = r.partial.trim()
        return done(
          `[O turno do chat ${tname} foi interrompido antes de terminar.]${partial ? `\n\nResposta parcial:\n${truncate(partial, max)}` : ''}`,
          'error'
        )
      }
      default:
        return done(`Erro no chat ${tname}: ${r.error}`, 'error')
    }
  } finally {
    if (edge) {
      const i = waitEdges.findIndex((e) => e.id === edge.id)
      if (i !== -1) waitEdges.splice(i, 1)
    }
  }
}

// ---------------- subagentes em segundo plano / callbacks / mensagens a subagentes ----------------

function wakeSession(sessionId: string): void {
  wakers.get(sessionId)?.()
}

/**
 * Subagente que encerrou o turno com filhos em segundo plano pendentes: status 'waiting' até
 * chegar mensagem/callback na fila (ou não haver mais pendentes). Retorna true se foi abortado.
 */
async function sleepWhilePending(st: RunState): Promise<boolean> {
  setStatus(st.sessionId, 'waiting')
  while (
    reports.pending(st.sessionId).length &&
    !hasQueued(st.sessionId) &&
    !st.controller.signal.aborted
  ) {
    const sig = st.controller.signal
    await new Promise<void>((resolve) => {
      const done = (): void => {
        if (wakers.get(st.sessionId) === done) wakers.delete(st.sessionId)
        sig.removeEventListener('abort', done)
        resolve()
      }
      wakers.set(st.sessionId, done)
      sig.addEventListener('abort', done, { once: true })
    })
  }
  const aborted = st.controller.signal.aborted
  if (!aborted && !shuttingDown) setStatus(st.sessionId, 'running')
  return aborted
}

/** Registra que a execução `run` da subsessão reporta ao pai por callback quando terminar. */
function attachReport(run: RunState, session: Session, update: boolean): Report {
  const r = reports.add({
    sessionId: session.id,
    parentSessionId: session.parentSessionId ?? '',
    title: session.title,
    model: session.model,
    update
  })
  run.report = r
  reportSettled.set(
    r.id,
    run.done.then((o) => onReportDone(r, o))
  )
  return r
}

const callbackMeta = (r: Pick<Report, 'sessionId' | 'update'>): MessageMeta => ({
  kind: 'subagent-callback',
  synthetic: true,
  subSessionId: r.sessionId,
  ...(r.update ? { callbackUpdate: true } : {})
})

/**
 * Fim de uma execução que reporta ao pai: entrega o callback (fila se o pai estiver rodando;
 * acorda o pai se estiver ocioso), salvo se o resultado foi reivindicado ou a subsessão apagada.
 * Chamado na ordem em que as execuções terminam → callbacks na mesma ordem.
 */
function onReportDone(r: Report, o: LoopOutcome): void {
  if (shuttingDown) return
  try {
    if (reports.complete(r, o)) {
      const parent = sessionsRepo.get(r.parentSessionId)
      const chat = parent && chatsRepo.get(parent.chatId)
      if (parent && chat) {
        const text = callbackText(r, o, toolOutputLimit(chat, parent))
        const d = deliverToSession(parent, text, callbackMeta(r), !r.silent)
        reports.sent(r, d.queuedId)
      }
    }
  } catch (e) {
    console.error('[clearchat] callback de subagente', r.sessionId, e)
  } finally {
    reportSettled.delete(r.id)
    wakeSession(r.parentSessionId) // pai dormindo reavalia os pendentes
    reports.prune()
  }
}

/** Callback "(interrompido: o app foi fechado)" gravado direto no pai (sem acordá-lo). */
function appendAppClosedCallback(
  parentSessionId: string,
  r: Pick<Report, 'title' | 'sessionId' | 'model' | 'update'>
): void {
  if (!sessionsRepo.get(parentSessionId)) return
  const m = messagesRepo.append(
    parentSessionId,
    { role: 'user', content: callbackText(r, { kind: 'app-closed' }) },
    callbackMeta(r)
  )
  emit({ type: 'message-added', message: m })
}

/**
 * Para uma subsessão e todos os descendentes (inclusive em segundo plano). Os callbacks dos
 * descendentes só são registrados nos pais (também parados), sem acordá-los; o da raiz segue normal.
 */
async function stopSubtree(session: Session): Promise<void> {
  const ids = subtreeIds(sessionsRepo.list(session.chatId), [session.id])
  for (const id of ids) capture.cancel(id)
  const set = new Set(ids)
  for (const r of reports.all())
    if (set.has(r.sessionId) && r.sessionId !== session.id && !r.outcome) r.silent = true
  const sts = ids.map((id) => runs.get(id)).filter((x): x is RunState => !!x)
  for (const st of sts) {
    st.stopRequested = true
    if (st.forced.length) requeueFront(st.sessionId, st.forced.splice(0))
    st.controller.abort()
  }
  await Promise.all(sts.map((st) => waitDone(st)))
}

/** "Parar todos os subagentes" do chat (a sessão principal continua). */
export async function stopSubagents(chatId: string): Promise<void> {
  const all = sessionsRepo.list(chatId)
  const tops = all.filter((s) => s.depth === 1)
  await Promise.all(tops.map((s) => stopSubtree(s)))
}

/** Última atividade de uma subsessão (texto curto para check_subagents). */
function sessionTail(sessionId: string): string {
  const msgs = messagesRepo.path(sessionId)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i].message
    if (msgs[i].meta.kind === 'error') return `erro: ${msgs[i].meta.error ?? ''}`
    if (m.role === 'assistant') {
      if (m.content?.trim()) return m.content
      if (m.tool_calls?.length)
        return `chamando ${m.tool_calls.map((t) => t.function.name).join(', ')}`
    }
    if (m.role === 'tool') return `resultado de tool (${contentText(m.content).length} caracteres)`
  }
  return ''
}

function runCheckSubagents(
  session: Session,
  chat: Chat,
  args: Record<string, unknown> = {}
): Omit<ToolOutcome, 'durationMs'> {
  if (args.messages === true || args.messages === 'true')
    return runSiblingExchanges(session, chat, args)
  const kids = sessionsRepo.list(chat.id).filter((s) => s.parentSessionId === session.id)
  const pm = messagesRepo.path(session.id)
  const rows: SubagentRow[] = kids.map((k) => {
    const rep = reports.latest(k.id)
    const toolMsg = pm.find((m) => m.message.role === 'tool' && m.meta.subSessionId === k.id)
    const background = !!toolMsg?.meta.background
    const running = runs.has(k.id)
    const hasCallback = pm.some(
      (m) => m.meta.kind === 'subagent-callback' && m.meta.subSessionId === k.id
    )
    const msgs = messagesRepo.path(k.id)
    let result: SubagentRow['result']
    if (running) result = rep ? 'pending' : 'none'
    else if (rep) result = rep.claimed || rep.callbackSent ? 'delivered' : 'pending'
    else if (background || hasCallback) result = hasCallback ? 'delivered' : 'none'
    else result = toolMsg ? 'tool' : 'none'
    return {
      id: k.id,
      title: k.title,
      model: k.model,
      status: k.status,
      background,
      startedAt: k.createdAt,
      finishedAt: running ? undefined : (rep?.finishedAt ?? msgs.at(-1)?.createdAt ?? k.createdAt),
      result,
      tail: sessionTail(k.id)
    }
  })
  let content = formatSubagentList(rows)
  // num subagente: os irmãos (mesmo agente pai), com quem ele pode falar por message_subagent
  if (session.depth > 0 && session.parentSessionId) {
    const sibs = sessionsRepo.children(session.parentSessionId).filter((s) => s.id !== session.id)
    content += `\n\n${formatSiblingList(sibs.map((s) => ({ id: s.id, title: s.title, status: s.status })))}`
  }
  return {
    content: truncateHeadTail(content, toolOutputLimit(chat, session), 0.5),
    status: 'ok'
  }
}

/**
 * check_subagents messages=true: mensagens trocadas entre os filhos da sessão (irmãos entre si).
 * Fonte: as mensagens 'sibling-message' / 'sibling-broadcast' persistidas nas subsessões de quem
 * recebeu (+ as ainda na fila delas); um broadcast aparece uma vez, com os destinatários.
 */
function runSiblingExchanges(
  session: Session,
  chat: Chat,
  args: Record<string, unknown>
): Omit<ToolOutcome, 'durationMs'> {
  const kids = sessionsRepo.children(session.id)
  let only: string | null = null
  const ref = typeof args.id === 'string' ? args.id.trim() : ''
  if (ref) {
    const res = resolveOwnSubagent(session, chat, ref)
    if ('error' in res) return { content: res.error, status: 'error' }
    only = res.ok.id
  }
  const byId = new Map(kids.map((k) => [k.id, k]))
  const refOf = (id: string): { id: string; title: string } => ({
    id,
    title: byId.get(id)?.title ?? sessionsRepo.get(id)?.title ?? '(apagado)'
  })
  const direct: SiblingExchange[] = []
  const broadcasts = new Map<string, SiblingExchange>()
  const add = (to: string, meta: MessageMeta, text: string, at: number, queued: boolean): void => {
    if (!isSiblingKind(meta.kind) || !meta.fromSessionId) return
    const body = splitSiblingText(text).body
    if (meta.kind === 'sibling-broadcast' && meta.broadcastId) {
      const b = broadcasts.get(meta.broadcastId)
      if (b) {
        b.to.push(refOf(to))
        b.at = Math.min(b.at, at)
        b.queued = b.queued && queued
      } else
        broadcasts.set(meta.broadcastId, {
          at,
          from: refOf(meta.fromSessionId),
          to: [refOf(to)],
          broadcast: true,
          text: body,
          queued
        })
      return
    }
    direct.push({
      at,
      from: refOf(meta.fromSessionId),
      to: [refOf(to)],
      broadcast: false,
      text: body,
      queued
    })
  }
  for (const k of kids) {
    for (const m of messagesRepo.path(k.id))
      if (m.message.role === 'user')
        add(k.id, m.meta, contentText(m.message.content), m.createdAt, false)
    for (const q of getQueue(k.id)) if (q.meta) add(k.id, q.meta, q.text, q.createdAt, true)
  }
  let items = [...direct, ...broadcasts.values()]
  if (only) items = items.filter((it) => it.from.id === only || it.to.some((t) => t.id === only))
  return {
    content: formatSiblingExchanges(items, chat.id, toolOutputLimit(chat, session)),
    status: 'ok'
  }
}

const subTitle = (s: Pick<Session, 'title' | 'id'>): string =>
  `"${s.title || 'Subagente'}" (id ${s.id})`

function resolveOwnSubagent(
  session: Session,
  chat: Chat,
  ref: string
): { ok: Session } | { error: string } {
  const r = resolveSubagentRef(sessionsRepo.list(chat.id), session.id, ref)
  if (r === null)
    return {
      error: `Erro: subagente não encontrado: "${ref}". Use check_subagents para ver os ids.`
    }
  if (r === 'ambiguous')
    return { error: `Erro: "${ref}" corresponde a mais de um subagente. Use o id completo.` }
  if (r === 'not-owned')
    return {
      error: `Erro: "${ref}" não é um subagente desta sessão — só é possível falar com os próprios subagentes (diretos ou descendentes). Use check_subagents.`
    }
  return { ok: r }
}

const clampWaitS = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0
    ? Math.min(LIMITS.subagentWaitMaxS, Math.max(1, Math.round(n)))
    : LIMITS.subagentWaitDefaultS
}

/** Reivindica o resultado de uma execução: sem callback (retira da fila do pai, se já estava lá). */
function claimReport(r: Report): string {
  const c = reports.claim(r)
  if (c.queuedId && takeQueued(c.queuedId)) return ''
  return c.sent ? ' (já tinha chegado antes como mensagem)' : ''
}

async function runWaitSubagents(
  session: Session,
  chat: Chat,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<Omit<ToolOutcome, 'durationMs'>> {
  const rawIds = Array.isArray(args.ids)
    ? args.ids.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : typeof args.ids === 'string' && args.ids.trim()
      ? [args.ids]
      : []
  const mode = args.mode === 'any' ? 'any' : 'all'
  const timeoutS = clampWaitS(args.timeout_s)
  const max = toolOutputLimit(chat, session)
  let targets: Report[]
  if (rawIds.length) {
    targets = []
    for (const id of rawIds) {
      const res = resolveOwnSubagent(session, chat, id)
      if ('error' in res) return { content: res.error, status: 'error' }
      const rep = reports.latest(res.ok.id)
      if (!rep || rep.parentSessionId !== session.id)
        return {
          content: `Erro: o subagente ${subTitle(res.ok)} não está em segundo plano nesta sessão (estado: ${res.ok.status}). Use check_subagents.`,
          status: 'error'
        }
      if (!targets.includes(rep)) targets.push(rep)
    }
  } else {
    targets = reports
      .forParent(session.id)
      .filter(
        (r) =>
          !r.claimed &&
          (!r.outcome ||
            !r.callbackSent ||
            (!!r.callbackQueuedId && isQueued(session.id, r.callbackQueuedId)))
      )
  }
  if (!targets.length)
    return { content: '[nenhum subagente em segundo plano pendente nesta sessão]', status: 'ok' }
  const running = targets.filter((r) => !r.outcome)
  let timedOut = false
  if (running.length) {
    const settled = running.map((r) => reportSettled.get(r.id) ?? Promise.resolve())
    const all: Promise<unknown> = mode === 'all' ? Promise.all(settled) : Promise.race(settled)
    try {
      timedOut = (await raceDone(all, timeoutS * 1000, signal)) === 'timeout'
    } catch (e) {
      if (signal.aborted || (e as Error).name === 'AbortError')
        return {
          content: `${CANCELLED_TEXT} Os subagentes continuam rodando; os resultados chegarão como mensagem.`,
          status: 'cancelled'
        }
      throw e
    }
  }
  const finished = targets.filter((r) => r.outcome)
  const parts: string[] = []
  const per = Math.max(1000, Math.floor((max - 400) / Math.max(1, targets.length)))
  for (const r of targets) {
    if (r.outcome) parts.push(callbackText(r, r.outcome, per) + claimReport(r))
    else
      parts.push(
        `[Subagente "${r.title}" (id ${r.sessionId}) ainda rodando · ${fmtDuration(Date.now() - r.startedAt)} — o resultado chegará como mensagem]`
      )
  }
  const head = timedOut
    ? `[tempo esgotado após ${timeoutS}s: ${finished.length} de ${targets.length} subagentes terminaram]`
    : `[${finished.length} de ${targets.length} subagentes terminaram]`
  return { content: truncateHeadTail(`${head}\n\n${parts.join('\n\n')}`, max, 0.5), status: 'ok' }
}

async function runCancelSubagent(
  session: Session,
  chat: Chat,
  args: Record<string, unknown>
): Promise<Omit<ToolOutcome, 'durationMs'>> {
  const ref = typeof args.id === 'string' ? args.id.trim() : ''
  if (!ref) return { content: 'Erro: argumento obrigatório "id" ausente.', status: 'error' }
  const res = resolveOwnSubagent(session, chat, ref)
  if ('error' in res) return { content: res.error, status: 'error' }
  const target = res.ok
  if (!runs.has(target.id))
    return {
      content: `O subagente ${subTitle(target)} não está em execução (estado: ${target.status}).`,
      status: 'ok',
      subSessionId: target.id
    }
  const rep = runs.get(target.id)?.report
  await stopSubtree(target)
  return {
    content: `Subagente ${subTitle(target)} cancelado (com os subagentes dele).${rep ? ' O cancelamento chegará como mensagem de resultado.' : ''}`,
    status: 'ok',
    subSessionId: target.id
  }
}

async function runMessageSubagent(
  session: Session,
  chat: Chat,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<Omit<ToolOutcome, 'durationMs'>> {
  const ref = typeof args.id === 'string' ? args.id.trim() : ''
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  const wait = args.wait_for_reply === true || args.wait_for_reply === 'true'
  if (args.broadcast === true || args.broadcast === 'true') {
    if (!message)
      return { content: 'Erro: argumento obrigatório "message" ausente ou vazio.', status: 'error' }
    return runSiblingBroadcast(session, message, wait, isTrue(args.include_finished))
  }
  if (!ref)
    return {
      content:
        'Erro: argumento obrigatório "id" ausente (ou use broadcast=true para todos os irmãos).',
      status: 'error'
    }
  if (!message)
    return { content: 'Erro: argumento obrigatório "message" ausente ou vazio.', status: 'error' }
  const res = resolveMessageTarget(sessionsRepo.list(chat.id), session.id, ref)
  if (res === null)
    return {
      content: `Erro: subagente não encontrado: "${ref}". Use check_subagents para ver os ids.`,
      status: 'error'
    }
  if (res === 'ambiguous')
    return {
      content: `Erro: "${ref}" corresponde a mais de um subagente. Use o id completo.`,
      status: 'error'
    }
  if (res === 'not-owned')
    return {
      content: `Erro: "${ref}" não é um subagente desta sessão nem um irmão — message_subagent só alcança os próprios subagentes (diretos ou descendentes) e, num subagente, os irmãos (criados pelo mesmo agente pai). Use check_subagents.`,
      status: 'error'
    }
  if (res.relation === 'sibling') return runSiblingMessage(session, res.target, message, wait)
  const target = res.target
  const timeoutS = clampWaitS(args.timeout_s)
  const d = deliverToSession(target, parentMessageText(message), {
    kind: 'parent-message',
    fromSessionId: session.id
  })
  const out = (
    content: string,
    status: ToolOutcome['status'] = 'ok'
  ): Omit<ToolOutcome, 'durationMs'> => ({ content, status, subSessionId: target.id })
  const name = subTitle(target)
  if (!wait)
    return out(
      d.queuedId
        ? `Mensagem enfileirada para o subagente ${name}: ele está rodando e a recebe no próximo passo.`
        : `Mensagem entregue ao subagente ${name}: ele retomou o trabalho; a nova resposta final chegará como mensagem.`
    )
  let r: TurnWait
  try {
    r = await waitForTurn(target.id, d.queuedId, signal, timeoutS * 1000)
  } catch (e) {
    if (signal.aborted || (e as Error).name === 'AbortError')
      return out(
        `${CANCELLED_TEXT} A mensagem já tinha sido entregue ao subagente ${name}; a resposta chegará como mensagem.`,
        'cancelled'
      )
    throw e
  }
  // a resposta volta aqui: o callback dessa execução não é injetado de novo (se vinha para esta sessão)
  const rep = r.run?.report
  if (rep && rep.parentSessionId === session.id && r.kind !== 'timeout') claimReport(rep)
  const max = toolOutputLimit(chat, session)
  switch (r.kind) {
    case 'final':
      return out(
        truncateHeadTail(
          `Resposta do subagente ${name}:\n\n${r.text.trim() || delegateEmptyText(target.model)}`,
          max,
          0.5
        )
      )
    case 'timeout':
      return out(
        `[O subagente ${name} ainda está rodando após ${timeoutS}s; a resposta chegará como mensagem.]`
      )
    case 'undelivered':
      return out(
        `[A mensagem ficou na fila do subagente ${name}: ele foi parado antes de recebê-la.]`,
        'error'
      )
    case 'aborted':
      return out(`[O subagente ${name} foi interrompido antes de responder.]`, 'error')
    default:
      return out(delegateFailureText(target.model, r.error), 'error')
  }
}

const isTrue = (v: unknown): boolean => v === true || v === 'true'

/** Limite anti pingue-pongue entre irmãos (em memória; `now` injetável nos testes). */
export const siblingLimiter = new SlidingWindowLimiter()
const SIBLING_WINDOW_MS = (): number => LIMITS.siblingWindowS * 1000

const NO_SIBLING_WAIT =
  'Erro: wait_for_reply não vale entre subagentes irmãos (dois irmãos esperando um pelo outro travariam). Envie sem wait_for_reply: o irmão responde com message_subagent e a resposta chega como mensagem nova.'

/**
 * message_subagent para um irmão (mesmo agente pai): sem wait_for_reply; no máximo
 * LIMITS.siblingMaxPerWindow mensagens por par na janela (as duas direções somadas). Entrega igual
 * à do pai (fila se rodando/dormindo; retoma se ocioso/concluído — o resultado dessa retomada vai
 * ao AGENTE PAI como callback, como toda subsessão retomada).
 */
function runSiblingMessage(
  session: Session,
  target: Session,
  message: string,
  wait: boolean
): Omit<ToolOutcome, 'durationMs'> {
  if (wait) return { content: NO_SIBLING_WAIT, status: 'error' }
  const name = subTitle(target)
  const retryS = siblingLimiter.take(
    siblingPairKey(session.id, target.id),
    LIMITS.siblingMaxPerWindow,
    SIBLING_WINDOW_MS()
  )
  if (retryS)
    return {
      content: `Erro: você e o irmão ${name} já trocaram ${LIMITS.siblingMaxPerWindow} mensagens no último minuto (limite anti pingue-pongue). Você poderá enviar outra em ${retryS} s. Melhor: termine a sua tarefa e devolva o resultado — o agente pai coordena o resto.`,
      status: 'error'
    }
  const d = deliverToSession(target, siblingMessageText(session.title, session.id, message), {
    kind: 'sibling-message',
    fromSessionId: session.id
  })
  return {
    content: d.queuedId
      ? `Mensagem enfileirada para o irmão ${name}: ele está rodando e a recebe no próximo passo. Se precisar responder, ele usa message_subagent e a resposta chega como mensagem nova — não espere por ela se puder seguir.`
      : `Mensagem entregue ao irmão ${name}: ele estava parado e retomou o trabalho (a nova resposta final dele vai ao agente pai). Se precisar responder, ele usa message_subagent e a resposta chega como mensagem nova.`,
    status: 'ok',
    subSessionId: target.id
  }
}

/**
 * message_subagent broadcast=true: a mesma mensagem a todos os irmãos ATIVOS (loop vivo: rodando,
 * dormindo, aguardando aprovação…); com include_finished, também retoma os parados. Limite próprio
 * por remetente (LIMITS.siblingBroadcastMaxPerWindow) — não gasta a cota dos pares.
 */
function runSiblingBroadcast(
  session: Session,
  message: string,
  wait: boolean,
  includeFinished: boolean
): Omit<ToolOutcome, 'durationMs'> {
  if (wait)
    return {
      content: NO_SIBLING_WAIT.replace(
        'entre subagentes irmãos',
        'com broadcast (nem entre irmãos)'
      ),
      status: 'error'
    }
  const sibs =
    session.depth > 0 && session.parentSessionId
      ? sessionsRepo.children(session.parentSessionId).filter((s) => s.id !== session.id)
      : []
  if (!sibs.length)
    return {
      content:
        'Erro: você não tem subagentes irmãos (outras subsessões criadas pelo mesmo agente pai) — não há para quem enviar o broadcast.',
      status: 'error'
    }
  const active = sibs.filter((s) => runs.has(s.id))
  const stopped = sibs.filter((s) => !runs.has(s.id))
  const targets = includeFinished ? sibs : active
  const list = (xs: Session[]): string => xs.map((s) => subTitle(s)).join(', ')
  if (!targets.length)
    return {
      content: `Nenhum irmão ativo agora: o broadcast não foi enviado. Parados (ociosos/concluídos): ${list(stopped)}. Use include_finished=true para retomá-los (cada um roda de novo e gasta tokens) ou envie a um só com id.`,
      status: 'ok'
    }
  const retryS = siblingLimiter.take(
    `broadcast|${session.id}`,
    LIMITS.siblingBroadcastMaxPerWindow,
    SIBLING_WINDOW_MS()
  )
  if (retryS)
    return {
      content: `Erro: você já enviou ${LIMITS.siblingBroadcastMaxPerWindow} broadcasts no último minuto. Poderá enviar outro em ${retryS} s — ou mande direto a um irmão (message_subagent com id), ou termine a sua tarefa e deixe o agente pai coordenar.`,
      status: 'error'
    }
  const broadcastId = randomUUID()
  const text = siblingBroadcastText(session.title, session.id, message)
  const queued: Session[] = []
  const resumed: Session[] = []
  for (const t of targets) {
    const d = deliverToSession(t, text, {
      kind: 'sibling-broadcast',
      fromSessionId: session.id,
      broadcastId
    })
    ;(d.queuedId ? queued : resumed).push(t)
  }
  const lines = [
    `Broadcast entregue a ${targets.length} ${targets.length === 1 ? 'irmão' : 'irmãos'}.`,
    queued.length ? `Na fila (rodando; recebem no próximo passo): ${list(queued)}.` : '',
    resumed.length
      ? `Retomados (estavam parados; a nova resposta final de cada um vai ao agente pai): ${list(resumed)}.`
      : '',
    !includeFinished && stopped.length
      ? `Pulados por estarem parados (ociosos/concluídos): ${list(stopped)} — include_finished=true os retomaria.`
      : '',
    'Só quem for o destinatário responde, com message_subagent direto a você; a resposta chega como mensagem nova. Siga a sua tarefa enquanto isso.'
  ]
  return { content: lines.filter(Boolean).join('\n'), status: 'ok' }
}

/** Último diretório do shell salvo nesta sessão (restaura o `cd` do bash após reiniciar o app). */
function lastShellCwd(sessionId: string): string | undefined {
  const msgs = messagesRepo.path(sessionId)
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].meta.shellCwd) return msgs[i].meta.shellCwd
  return undefined
}

// ---------------- API pública (IPC) ----------------

/**
 * Compactar (só sessão principal; subsessões compactam sozinhas). Ociosa → roda já (loop só de
 * compactação); rodando → agenda para o próximo limite de passo.
 */
export function compact(sessionId: string, opts: CompactOptions = {}): { scheduled: boolean } {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  if (session.depth !== 0)
    throw new Error('Subsessões são somente leitura (compactam automaticamente).')
  const req: CompactRequest = { reason: 'manual', retry: !!opts.retry }
  const st = runs.get(sessionId)
  if (st) {
    if (st.stopRequested) throw new Error('A sessão está parando; tente novamente.')
    st.compact = req
    emit({ type: 'compaction', sessionId, state: 'scheduled' })
    return { scheduled: true }
  }
  repairTail(sessionId)
  if (!hasCompactableHistory(messagesRepo.path(sessionId)))
    throw new Error('Nada para compactar ainda (nenhuma resposta desde a última compactação).')
  startLoop(session, undefined, { compact: req, compactOnly: true })
  return { scheduled: false }
}

/**
 * Mensagem do usuário. Sessão principal ou subagente (conversa direta): rodando → fila; ociosa →
 * inicia um turno; subagente concluído → retoma e a nova resposta final volta ao pai (callback).
 */
export function send(
  sessionId: string,
  text: string,
  attachmentsInput?: AttachmentInfo[],
  skillParts: ContentPart[] = []
): { queued: boolean } {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  const attachments = validateAttachments(attachmentsInput)
  text = typeof text === 'string' ? text : ''
  if (!text.trim() && !attachments.length && !skillParts.length) throw new Error('Mensagem vazia.')
  const meta = takeUserMeta(sessionId, text)
  return {
    queued: !!deliverToSession(session, text, meta, true, attachments, skillParts).queuedId
  }
}

/**
 * `send` com skills escolhidas no composer (lâmpada): os SKILL.md são lidos AGORA e viram parts
 * `<skill>` da mensagem (também na fila / ⚡). Erro legível → nada é enviado.
 */
export async function sendWithSkills(
  sessionId: string,
  text: string,
  attachmentsInput?: AttachmentInfo[],
  skillNames?: unknown
): Promise<{ queued: boolean }> {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  const chat = chatsRepo.get(session.chatId)
  if (!chat) throw new Error('Chat não encontrado.')
  validateAttachments(attachmentsInput) // falha antes de ler as skills
  const parts = await manualSkillParts(chat, skillNames)
  return send(sessionId, text, attachmentsInput, parts)
}

export function forceSend(queuedId: string): void {
  const item = takeQueued(queuedId)
  if (!item) return
  const st = runs.get(item.sessionId)
  if (st && !st.stopRequested) {
    st.forced.push(item)
    st.controller.abort()
    return
  }
  const session = sessionsRepo.get(item.sessionId)
  if (!session) return
  if (st) {
    // ainda parando: volta para a fila; o usuário pode tentar de novo
    requeueFront(item.sessionId, [item])
    return
  }
  deliverToSession(session, item.text, item.meta ?? {}, true, item.attachments, item.skillParts)
}

export function removeQueued(queuedId: string): void {
  takeQueued(queuedId)
}

export { getQueue }

async function waitDone(st: RunState, ms = 15_000): Promise<void> {
  await Promise.race([st.done.then(() => undefined), new Promise<void>((r) => setTimeout(r, ms))])
}

export async function stop(sessionId: string): Promise<void> {
  // Parar também cancela o resumo da coleta de contexto (nada roda até a próxima mensagem sua)
  capture.cancel(sessionId)
  const session = sessionsRepo.get(sessionId)
  // subagente: para ele e todos os descendentes (inclusive os em segundo plano)
  if (session && session.depth > 0) return stopSubtree(session)
  const st = runs.get(sessionId)
  if (!st) return
  st.stopRequested = true
  if (st.forced.length) requeueFront(sessionId, st.forced.splice(0))
  st.controller.abort()
  await waitDone(st)
}

// ---------------- chamada de voz: turno interrompido (SPEC → "Turno continuado") ----------------

/** Entrada de `amendVoiceTurn`. */
export interface VoiceTurnAmend {
  /** Mensagem do usuário que abriu o turno interrompido. */
  userMessageId: string
  /**
   * Turno CONTINUADO (o usuário voltou a falar antes de ouvir qualquer resposta): apaga a mensagem
   * do usuário e tudo depois dela (o chamador reenviará o texto unido). Ignorado (vira `false`)
   * quando o turno já executou tools — o histórico das tools fica (efeitos reais aconteceram).
   */
  dropUser: boolean
  /**
   * Sentenças efetivamente FALADAS por mensagem do assistente (id → sentenças, na ordem). Função =
   * avaliada depois de parar o turno (a resposta em streaming só vira mensagem no abort).
   */
  spoken: Record<string, string[]> | (() => Record<string, string[]>)
}

/**
 * Chamada de voz: para o turno em andamento (se rodando) e ajusta o histórico ao que o usuário
 * OUVIU — nenhuma resposta nunca falada fica no histórico (o modelo "acharia" que disse).
 * - `dropUser` (turno continuado, sem tools): apaga a mensagem do usuário e tudo depois dela;
 * - senão, para cada assistente depois dela: sem nada falado e sem tool_calls → apagada; com parte
 *   falada → conteúdo truncado ao prefixo falado (`spokenPrefix`) com `interrupted: true`; com
 *   tool_calls → as chamadas ficam (pareadas com os resultados) e o texto é truncado ao falado.
 * Tools sem resposta ganham o resultado sintético cancelado (`repairTail`). Idempotente.
 */
export async function amendVoiceTurn(
  sessionId: string,
  input: VoiceTurnAmend
): Promise<{ removed: number; truncated: number }> {
  if (runs.has(sessionId)) await stop(sessionId)
  const spokenBy = typeof input.spoken === 'function' ? input.spoken() : input.spoken
  const path = messagesRepo.path(sessionId)
  const idx = path.findIndex((m) => m.id === input.userMessageId)
  if (idx < 0 || path[idx].message.role !== 'user') return { removed: 0, truncated: 0 }
  const after = path.slice(idx + 1)
  const usedTools = after.some(
    (m) =>
      m.message.role === 'tool' ||
      (m.message.role === 'assistant' && (m.message.tool_calls?.length ?? 0) > 0)
  )
  let removed = 0
  let truncated = 0
  if (input.dropUser && !usedTools) {
    for (const m of [...after].reverse()) {
      await deleteMessage(m.id)
      removed++
    }
    await deleteMessage(input.userMessageId)
    return { removed: removed + 1, truncated }
  }
  for (const m of after) {
    if (m.message.role !== 'assistant' || isDisplayOnly(m.meta)) continue
    const content = typeof m.message.content === 'string' ? m.message.content : ''
    const spoken = spokenPrefix(content, spokenBy[m.id] ?? [])
    const hasCalls = (m.message.tool_calls?.length ?? 0) > 0
    if (!spoken.trim() && !hasCalls) {
      await deleteMessage(m.id)
      removed++
      continue
    }
    if (spoken === content) continue
    // cortada no meio (barge-in em palavras): "…" no fim do que foi ouvido — é o que o modelo vê
    const heard = spoken.trim() && !/[.!?…]["'”»)\]]*$/.test(spoken) ? `${spoken}…` : spoken
    if (m.meta.interrupted && content === heard) continue // idempotente (já ajustada)
    // o resto NÃO ouvido fica só para exibição (`meta.voice.unheard` — nunca vai ao modelo)
    const unheard = content.startsWith(spoken) ? content.slice(spoken.length).trim() : ''
    const voice =
      m.meta.voice || unheard
        ? {
            voice: {
              ...(m.meta.voice ?? { source: 'call' as const }),
              ...(spoken.trim() ? { spoken: 'partial' as const } : {}),
              ...(unheard ? { unheard } : {})
            }
          }
        : {}
    if (voice.voice && !spoken.trim()) delete voice.voice.spoken
    const updated = messagesRepo.update(
      m.id,
      { ...m.message, content: hasCalls && !spoken ? null : heard },
      { ...m.meta, interrupted: true, ...voice }
    )
    emit({ type: 'message-updated', message: updated })
    truncated++
  }
  repairTail(sessionId)
  return { removed, truncated }
}

// ---------------- versões da conversa (ramos — src/shared/branches.ts) ----------------

/** Status em que a sessão está ocupada (turno, aprovação, questionário, card de rede, dormindo). */
const BUSY_STATUSES: readonly SessionStatus[] = [
  'running',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_retry',
  'waiting'
]

const isSessionBusy = (s: Session): boolean => runs.has(s.id) || BUSY_STATUSES.includes(s.status)

/** O que está em `from` e sai do caminho ao passar para `to` (tudo depois do ponto de divergência). */
const leftBehind = (from: StoredMessage[], to: StoredMessage[]): StoredMessage[] => {
  const keep = new Set(to.map((m) => m.id))
  return from.filter((m) => !keep.has(m.id))
}

/** Subsessões (com descendentes) nascidas destas mensagens que ainda estão rodando. */
function liveSubSessionsOf(parent: Session, msgs: StoredMessage[]): Session[] {
  const roots = subSessionRoots(parent, msgs)
  return roots.length ? subtree(parent.chatId, roots).filter((s) => runs.has(s.id)) : []
}

/**
 * Parte abandonada da conversa (nova versão por edição/regenerate): os subagentes nascidos nela
 * que ainda rodam (segundo plano / retomados) são parados SEM callback — o resultado cairia na
 * versão nova, que não os pediu; callbacks deles já na fila da principal saem também. As
 * subsessões continuam salvas (a versão antiga segue consultável).
 */
async function stopAbandonedSubagents(parent: Session, abandoned: StoredMessage[]): Promise<void> {
  const roots = subSessionRoots(parent, abandoned)
  if (!roots.length) return
  const ids = subtree(parent.chatId, roots).map((s) => s.id)
  const set = new Set(ids)
  reports.drop(ids)
  for (const q of getQueue(parent.id))
    if (q.meta?.kind === 'subagent-callback' && set.has(q.meta.subSessionId ?? '')) takeQueued(q.id)
  const live = ids.map((id) => runs.get(id)).filter((x): x is RunState => !!x)
  for (const st of live) {
    st.stopRequested = true
    if (st.forced.length) requeueFront(st.sessionId, st.forced.splice(0))
    st.controller.abort()
  }
  await Promise.all(live.map((st) => waitDone(st, 5000)))
}

/** Para o turno em andamento (como o regenerate sempre fez) antes de criar uma versão. */
async function stopForBranch(sessionId: string): Promise<void> {
  if (runs.has(sessionId)) await stop(sessionId)
  if (runs.has(sessionId)) throw new Error('A sessão ainda está parando; tente novamente.')
}

/**
 * Troca o texto de uma mensagem do usuário mantendo os parts do app (anexos e skills carregadas,
 * na mesma ordem); o texto vira um único text part no fim (= `withText` do renderer).
 */
function withUserText(content: ApiMessage['content'], text: string): string | ContentPart[] {
  if (content == null || typeof content === 'string') return text
  const keep = content.filter(isAppPart)
  if (!keep.length) {
    if (!content.length) return text
    const first = content.find((p) => p.type === 'text') ?? { type: 'text' as const, text: '' }
    return [{ ...first, text } as ContentPart]
  }
  return text.trim() ? [...keep, { type: 'text', text }] : keep
}

/**
 * Editar uma mensagem digitada da sessão principal = NOVA VERSÃO: uma irmã com o mesmo pai (texto
 * novo; anexos/skills da original), já selecionada, e o agente roda a partir dela. A versão
 * antiga (e tudo depois dela) continua salva. Para o turno em andamento e os subagentes em
 * segundo plano da parte abandonada (sem callback). Editar acima de uma fronteira de compactação
 * volta às mensagens originais (o caminho novo não tem a fronteira; o limite de contexto segue as
 * regras de sempre: compactação automática / "Compactar e tentar de novo").
 */
export async function editBranch(messageId: string, message: ApiMessage): Promise<void> {
  const cur = messagesRepo.get(messageId)
  if (!cur) throw new Error('Mensagem não encontrada.')
  const session = sessionsRepo.get(cur.sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  if (!isBranchEditable(cur, session.depth))
    throw new Error('Só mensagens digitadas na sessão principal viram uma nova versão.')
  if (!message || typeof message !== 'object' || message.role !== 'user')
    throw new Error('Mensagem inválida.')
  const content = withUserText(cur.message.content, contentText(message.content))
  if (!contentText(content).trim() && !(Array.isArray(content) && content.length))
    throw new Error('Mensagem vazia.')
  await stopForBranch(session.id)
  if (shuttingDown) throw new Error('Aplicativo encerrando.')
  // caminho novo = ancestrais da original + a versão nova; o resto do caminho atual sai
  const now = sessionsRepo.get(session.id) ?? session
  const tree = buildTree(messagesRepo.listAll(session.id))
  const keep = new Set<string>()
  for (let p = tree.parentOf.get(cur.id) ?? null; p; p = tree.parentOf.get(p) ?? null) keep.add(p)
  const abandoned = activePath(tree, now.branchSel).filter((m) => !keep.has(m.id))
  await stopAbandonedSubagents(session, abandoned)
  if (runs.has(session.id)) throw new Error('A sessão voltou a rodar; tente novamente.')
  const m = messagesRepo.addSibling(cur.id, { role: 'user', content })
  emit({ type: 'message-added', message: m })
  const s = sessionsRepo.get(session.id) ?? now
  emit({ type: 'session-updated', session: s })
  chatsRepo.touch(session.chatId)
  startLoop(s)
}

/**
 * Regenerar = NOVA VERSÃO da resposta do turno que contém `messageId` (padrão: o último turno do
 * caminho ativo): `branchSel[prompt] = null` (o caminho termina no prompt; a resposta nova entra
 * como outro filho dele — a 1ª mensagem limpa o null; terminar sem nenhuma limpa em `finish`). A
 * request é a mesma do turno original (mesmos bytes → prefixo inteiro do cache). Resposta que é só
 * erro (só exibição) no fim do caminho é SUBSTITUÍDA (apagada e refeita), sem criar versão.
 */
export async function regenerate(sessionId: string, messageId?: string): Promise<void> {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  if (session.depth !== 0) throw new Error('Subsessões são somente leitura.')
  await stopForBranch(sessionId)
  const path = messagesRepo.path(sessionId)
  if (messageId && !path.some((m) => m.id === messageId))
    throw new Error('Esta mensagem não está na versão ativa da conversa.')
  const prompt = messageId ? turnAnchor(path, messageId) : lastTurnAnchor(path)
  if (!prompt) throw new Error('Não há mensagem do usuário para regenerar.')
  const after = path.slice(path.findIndex((m) => m.id === prompt.id) + 1)
  const response = turnResponse(path, prompt.id)
  if (
    after.length &&
    after.length === response.length &&
    response.every((m) => isDisplayOnly(m.meta))
  ) {
    for (const m of response) await deleteMessage(m.id)
  } else if (after.length) {
    await stopAbandonedSubagents(session, after)
    if (runs.has(sessionId)) throw new Error('A sessão voltou a rodar; tente novamente.')
    const cur = sessionsRepo.get(sessionId)
    if (!cur) return
    const s = sessionsRepo.setBranchSel(sessionId, { ...cur.branchSel, [prompt.id]: null })
    if (s) emit({ type: 'session-updated', session: s })
  }
  if (runs.has(sessionId) || shuttingDown) return
  startLoop(sessionsRepo.get(sessionId) ?? session)
}

/**
 * Troca de versão: o caminho ativo passa a ir por `messageId` (a seleção mínima é gravada na
 * sessão). Recusada com a sessão ocupada (o histórico do agente mudaria no meio do turno) ou com
 * subagente em segundo plano ainda rodando na parte que sai ou entra no caminho.
 */
export async function selectBranch(messageId: string): Promise<Session> {
  const cur = messagesRepo.get(messageId)
  if (!cur) throw new Error('Mensagem não encontrada.')
  const session = sessionsRepo.get(cur.sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  if (isSessionBusy(session)) throw new Error('Aguarde o agente terminar para trocar de versão.')
  const tree = buildTree(messagesRepo.listAll(session.id))
  const before = activePath(tree, session.branchSel)
  const next = activePath(tree, pruneSel(tree, selectionToReach(tree, session.branchSel, cur.id)))
  const live = liveSubSessionsOf(session, [
    ...leftBehind(before, next),
    ...leftBehind(next, before)
  ])
  if (live.length)
    throw new Error(
      `${live.length === 1 ? 'Há um subagente' : `Há ${live.length} subagentes`} em segundo plano rodando nesta versão — aguarde terminar ou pare antes de trocar de versão.`
    )
  const s = messagesRepo.select(cur.id)
  emit({ type: 'session-updated', session: s })
  return s
}

/**
 * Resposta ao card de aprovação. Pergunta simples: 'allow' | 'deny'. Card do modo Listas: `items`
 * = decisão de cada sub-comando pendente (com padrão opcional para "+ whitelist"/"+ blacklist");
 * sem `items`, 'allow' = sim para todos e 'deny' = não. Padrões inválidos → erro (nada é decidido).
 */
export function approve(
  requestId: string,
  decision: ApprovalDecision,
  items?: ApprovalItemDecision[]
): void {
  const req = getApproval(requestId)
  if (!req) return
  if (items?.length && req.check) {
    const list = req.check.item as ApprovalListItem
    for (const d of items) {
      if (!req.check.items[d.index]) throw new Error(`Item ${d.index} inexistente.`)
      if (d.pattern != null) {
        const err = validateListEntry(list, d.pattern)
        if (err) throw new Error(`Padrão inválido "${d.pattern}": ${err}`)
      }
    }
  }
  resolveApproval(requestId, { kind: decision === 'allow' ? 'allow' : 'deny', items })
}

/**
 * "Executar mesmo assim" num resultado rejeitado pelo Smart-Approve: a rejeição continua sendo o
 * resultado daquela chamada (o histórico não muda), mas (1) a próxima chamada IDÊNTICA na mesma
 * sessão roda uma vez sem juiz nem confirmação e (2) uma mensagem do usuário "Pode executar …; eu
 * aprovo." é entregue à sessão (fila se estiver rodando; senão inicia um turno).
 */
export function smartOverride(messageId: string): void {
  const msg = messagesRepo.get(messageId)
  if (!msg || msg.message.role !== 'tool') throw new Error('Mensagem não encontrada.')
  const rec = msg.meta.smartApprove
  if (!rec || rec.decision !== 'reject')
    throw new Error('Esta chamada não foi rejeitada pelo Smart-Approve.')
  if (rec.overridden) return
  const session = sessionsRepo.get(msg.sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  const toolCallId = msg.message.tool_call_id
  let call: ToolCall | undefined
  for (const m of messagesRepo.listAll(session.id)) {
    if (m.message.role === 'assistant')
      call = m.message.tool_calls?.find((t) => t.id === toolCallId) ?? call
    if (call) break
  }
  if (!call) throw new Error('Chamada original não encontrada no histórico.')
  let args: Record<string, unknown>
  try {
    args = parseToolArgs(call.function.arguments)
  } catch (e) {
    throw new Error(`Argumentos inválidos: ${errMsg(e)}`, { cause: e })
  }
  const tool = call.function.name as ToolName
  addOverride(session.id, tool, args)
  const updated = messagesRepo.update(msg.id, msg.message, {
    ...msg.meta,
    smartApprove: { ...rec, overridden: true }
  })
  emit({ type: 'message-updated', message: updated })
  deliverToSession(session, overrideMessageText(tool, args), {}, true)
}

/** "Testar" do editor: roda o juiz numa chamada de exemplo (sem sessão; nada é salvo). */
export async function smartApproveTest(input: SmartApproveTestInput): Promise<SmartApproveRecord> {
  const sa = normalizeSmartApprove(input.config.smartApprove)
  // como na execução: nos itens com listas, o juiz vê o que a whitelist já libera (contexto)
  const item = TOOL_ITEM[input.tool]
  const lists = getApprovalSettings().lists
  const plan = isListItem(item)
    ? smartListPlan(item, input.args, lists, {
        judgeWhitelisted: sa.judgeWhitelisted,
        safety: { home: homedir(), root: input.config.cwd, cwd: input.config.cwd }
      })
    : null
  const ctx = {
    tool: input.tool,
    args: input.args,
    cwd: input.config.cwd || '~',
    confine: input.config.confineToRoot !== false,
    sandbox: !!input.config.sandboxBash && bwrapAvailable(),
    history: input.history ?? [],
    environment: {
      user: effectiveEnvironment(input.config.smartApprove, getApprovalSettings().smart),
      ...(input.captured ? { captured: input.captured } : {})
    },
    ...(plan?.kind === 'judge'
      ? {
          check: await fillScriptPreviews(plan.ev.check, input.config.cwd || homedir()),
          judgeIdx: plan.judgeIdx
        }
      : {})
  }
  const provider = sa.providerId ? providersRepo.get(sa.providerId) : null
  return runJudge({
    sa,
    provider,
    chatConfig: input.config,
    ctx,
    signal: new AbortController().signal
  })
}

export function pendingApprovals(): ReturnType<typeof listApprovals> {
  return listApprovals()
}

export function pendingQuestions(): ReturnType<typeof listQuestions> {
  return listQuestions()
}

/**
 * Cancelar o questionário (Esc / "Cancelar"): o mesmo que Parar — o resultado vira
 * `[O usuário não respondeu ao questionário]` e o agente para (sem nova chamada ao modelo).
 */
export async function cancelQuestionRequest(id: string): Promise<void> {
  const q = getQuestion(id)
  if (!q) return
  if (runs.has(q.sessionId)) await stop(q.sessionId)
  cancelQuestion(id) // sem loop (não deveria acontecer): só resolve
}

export function pendingRetries(): ReturnType<typeof listRetries> {
  return listRetries()
}

/** "Tentar de novo" no card de falha de conexão: repete a mesma chamada do zero. */
export function retryRequest(id: string): void {
  if (!getRetry(id)) throw new Error('Esta falha de conexão não está mais pendente.')
  resolveRetry(id, 'retry')
}

/** "Cancelar" no card de falha de conexão: o turno termina como erro (como antes do card). */
export function cancelRetryRequest(id: string): void {
  resolveRetry(id, 'cancel')
}

export function previewRequest(sessionId: string): RequestPreview {
  const session = sessionsRepo.get(sessionId)
  if (!session) throw new Error('Sessão não encontrada.')
  const chat = chatsRepo.get(session.chatId)
  if (!chat) throw new Error('Chat não encontrado.')
  const provider = providerFor(chat, session)
  if (!provider) throw new Error('Nenhum provider configurado para este chat.')
  const req = buildRequest(chat, session, messagesRepo.path(sessionId), provider)
  const masked = maskRequest(req, provider.apiKey)
  // anexos: o base64 aparece encurtado (a request real leva o arquivo inteiro)
  const { body, truncated } = truncateBodyForPreview(masked.body)
  if (!truncated) return masked
  return {
    ...masked,
    body,
    notes: [
      ...(masked.notes ?? []),
      `Base64 de ${truncated} anexo${truncated > 1 ? 's' : ''} encurtado nesta visualização (…(tamanho)); a request real envia o arquivo inteiro.`
    ]
  }
}

export function runningSessions(): string[] {
  return [...runs.keys()]
}

export function isRunning(sessionId: string): boolean {
  return runs.has(sessionId)
}

/** Aborta todas as sessões de um chat (antes de apagá-lo). */
export async function stopChat(chatId: string): Promise<void> {
  capture.cancelChat(chatId)
  reports.drop(sessionsRepo.list(chatId).map((s) => s.id)) // chat sendo apagado: sem callbacks
  const sts = [...runs.values()].filter((s) => s.chatId === chatId)
  for (const st of sts) {
    st.stopRequested = true
    st.forced = []
    st.controller.abort()
  }
  await Promise.all(sts.map((st) => waitDone(st, 5000)))
  for (const st of sts) clearQueue(st.sessionId)
  for (const s of sessionsRepo.list(chatId)) clearQueue(s.id)
}

/** Inicialização: sessões que ficaram rodando/aguardando → 'interrupted' (+ repara pareamento). */
export function initRunner(): void {
  // card de falha de conexão aberto num fechamento abrupto: o turno vira erro (mensagem persistida)
  const staleRetry = sessionsRepo.markStaleRetry()
  for (const id of staleRetry) {
    try {
      repairTail(id, 'app-closed')
      appendError(id, retryAppClosedText())
    } catch (e) {
      console.error('[clearchat] retry interrompido', id, e)
    }
  }
  const stale = [...staleRetry, ...sessionsRepo.markStaleInterrupted()]
  for (const id of stale) {
    try {
      repairTail(id, 'app-closed')
      // regenerate interrompido antes da 1ª mensagem: volta à versão que já existia. Só nas
      // sessões que rodavam AQUI (este dispositivo era o host) — nunca grava chat alheio.
      clearPendingBranch(id)
    } catch (e) {
      console.error('[clearchat] repairTail', id, e)
    }
  }
  // Subagentes que reportariam por callback (segundo plano / retomados) e ficaram rodando num
  // fechamento abrupto: o pai recebe "(interrompido: o app foi fechado)", sem ser acordado.
  for (const id of stale) {
    try {
      const s = sessionsRepo.get(id)
      if (!s || s.depth === 0 || !s.parentSessionId) continue
      const pm = messagesRepo.path(s.parentSessionId)
      if (!pm.some((m) => m.message.role === 'tool' && m.meta.subSessionId === id)) continue
      appendAppClosedCallback(s.parentSessionId, {
        title: s.title,
        sessionId: s.id,
        model: s.model,
        update: false
      })
    } catch (e) {
      console.error('[clearchat] callback de subagente interrompido', id, e)
    }
  }
}

/**
 * Encerramento do app (before-quit): aborta tudo (mata process groups do bash) e marca as sessões
 * em andamento como 'interrupted', reparando o pareamento tool_calls ↔ tool de forma síncrona.
 */
export function shutdownRunner(): void {
  const ids = [...runs.keys()]
  // questionários pendentes: resultado "não respondido: o app foi fechado" (com o card respondível
  // como "Não respondido": perguntas resolvidas no meta)
  for (const q of listQuestions()) {
    try {
      if (!sessionsRepo.get(q.sessionId)) continue
      const m = messagesRepo.append(
        q.sessionId,
        { role: 'tool', tool_call_id: q.toolCallId, content: ASK_USER_APP_CLOSED },
        {
          synthetic: true,
          kind: 'tool-cancelled',
          toolStatus: 'cancelled',
          askUser: {
            questions: q.questions,
            outcome: 'app-closed',
            ...(q.notes?.length ? { notes: q.notes } : {})
          }
        }
      )
      emit({ type: 'message-added', message: m })
    } catch (e) {
      console.error('[clearchat] shutdown questionário', q.sessionId, e)
    }
  }
  // falhas de conexão aguardando decisão: o turno vira erro "… (interrompido: o app foi fechado)"
  const retrySessions = new Set<string>()
  for (const r of listRetries()) {
    retrySessions.add(r.sessionId)
    appendError(r.sessionId, retryAppClosedText(r.error))
  }
  for (const id of ids) {
    try {
      repairTail(id, 'app-closed')
      clearPendingBranch(id)
      const s = sessionsRepo.setStatus(id, retrySessions.has(id) ? 'error' : 'interrupted')
      if (s) emit({ type: 'session-updated', session: s })
    } catch (e) {
      console.error('[clearchat] shutdown', id, e)
    }
  }
  // subagentes em segundo plano/retomados ainda rodando: o pai recebe o callback agora (sem acordar)
  for (const r of reports.all()) {
    if (r.outcome || r.dropped || r.claimed || !runs.has(r.sessionId)) continue
    reports.complete(r, { kind: 'app-closed' })
    try {
      appendAppClosedCallback(r.parentSessionId, r)
    } catch (e) {
      console.error('[clearchat] shutdown callback', r.sessionId, e)
    }
  }
  shuttingDown = true
  for (const st of runs.values()) {
    st.stopRequested = true
    st.forced = []
    st.controller.abort()
  }
}
