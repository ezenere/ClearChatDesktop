// Repositórios sobre o SQLite (db.ts). Tudo síncrono (better-sqlite3).
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { getDb } from './db'
import { indexMessage } from './searchIndex'
import { ROOT_PARENT } from './migrateBranches'
import { DEFAULT_CHAT_CONFIG } from '@shared/defaults'
import { normalizeAppSignatureId } from '@shared/appSignatures'
import { isChatProvider, providerKind } from '@shared/providerKinds'
import { migrateConfigTools } from '@shared/toolRename'
import { normalizeVoiceCallConfig } from '@shared/voice'
import {
  activeLeaf,
  activePath,
  buildTree,
  pruneSel,
  selEquals,
  selKey,
  selectionToReach,
  toBranchSel,
  type BranchSel,
  type TreeMessage
} from '@shared/branches'
import {
  APPROVAL_MODES_SETTING,
  migrateApprovalConfig,
  migrateLegacyApprovals,
  migrateSmartApproveConfig
} from '@shared/approvalPolicy'
import type {
  ApiMessage,
  ApprovalItem,
  ApprovalMode,
  Chat,
  ChatConfig,
  ChatParams,
  MessageMeta,
  Preset,
  Provider,
  Session,
  SessionStatus,
  StoredMessage
} from '@shared/types'
import type {
  ChatCreateInput,
  ChatUpdateInput,
  PresetInput,
  PresetPatch,
  ProviderInput,
  ProviderPatch
} from '@shared/ipc'
import {
  DEFAULT_PRESET_ICON,
  DEFAULT_PRESET_NAME,
  DEFAULT_PRESET_SETTING,
  PRESETS_SEEDED_SETTING,
  copyName,
  sanitizePresetConfig
} from '@shared/presets'

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

// ---------------- providers ----------------

interface ProviderRow {
  id: string
  name: string
  base_url: string
  kind?: string
  api_key: string
  headers_json: string
  created_at: number
}

const toProvider = (r: ProviderRow): Provider => ({
  id: r.id,
  name: r.name,
  kind: providerKind({ baseUrl: r.base_url, kind: r.kind }),
  baseUrl: r.base_url,
  apiKey: r.api_key,
  headers: parse<Record<string, string>>(r.headers_json, {}),
  createdAt: r.created_at
})

const normBaseUrl = (u: string): string => u.trim().replace(/\/+$/, '')

export const providersRepo = {
  list(): Provider[] {
    const rows = getDb()
      .prepare('SELECT * FROM providers ORDER BY created_at')
      .all() as ProviderRow[]
    return rows.map(toProvider)
  },
  get(id: string): Provider | null {
    const r = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      ProviderRow | undefined
    return r ? toProvider(r) : null
  },
  create(p: ProviderInput): Provider {
    const prov: Provider = {
      id: randomUUID(),
      name: p.name?.trim() || 'Provider',
      baseUrl: normBaseUrl(p.baseUrl ?? ''),
      kind: providerKind({ baseUrl: p.baseUrl ?? '', kind: p.kind }),
      apiKey: (p.apiKey ?? '').trim(),
      headers: p.headers ?? {},
      createdAt: Date.now()
    }
    getDb()
      .prepare(
        'INSERT INTO providers (id, name, base_url, kind, api_key, headers_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        prov.id,
        prov.name,
        prov.baseUrl,
        prov.kind,
        prov.apiKey,
        JSON.stringify(prov.headers),
        prov.createdAt
      )
    return prov
  },
  update(id: string, patch: ProviderPatch): Provider {
    const cur = providersRepo.get(id)
    if (!cur) throw new Error(`Provider não encontrado: ${id}`)
    const next: Provider = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: normBaseUrl(patch.baseUrl) } : {}),
      ...(patch.kind !== undefined
        ? { kind: providerKind({ baseUrl: '', kind: patch.kind }) }
        : {}),
      ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey.trim() } : {}),
      ...(patch.headers !== undefined ? { headers: patch.headers ?? {} } : {})
    }
    getDb()
      .prepare(
        'UPDATE providers SET name = ?, base_url = ?, kind = ?, api_key = ?, headers_json = ? WHERE id = ?'
      )
      .run(
        next.name,
        next.baseUrl,
        next.kind ?? providerKind(next),
        next.apiKey,
        JSON.stringify(next.headers),
        id
      )
    return next
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM providers WHERE id = ?').run(id)
  }
}

// ---------------- settings ----------------

export const settingsRepo = {
  get<T = unknown>(key: string): T | null {
    const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string | null } | undefined
    if (!r || r.value == null) return null
    return parse<T | null>(r.value, null)
  },
  set(key: string, value: unknown): void {
    if (value === undefined || value === null) {
      getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
      return
    }
    getDb()
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify(value))
  }
}

// ---------------- sessions ----------------

interface SessionRow {
  id: string
  chat_id: string
  parent_session_id: string | null
  parent_tool_call_id: string | null
  depth: number
  model: string
  provider_id: string | null
  title: string
  task: string | null
  status: string
  created_at: number
  branch_sel_json?: string | null
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  chatId: r.chat_id,
  parentSessionId: r.parent_session_id,
  parentToolCallId: r.parent_tool_call_id,
  depth: Math.min(2, Math.max(0, r.depth)) as 0 | 1 | 2,
  model: r.model,
  providerId: r.provider_id ?? null,
  title: r.title,
  task: r.task,
  status: r.status as SessionStatus,
  createdAt: r.created_at,
  branchSel: toBranchSel(parse<unknown>(r.branch_sel_json, {}))
})

/** Seleção do ramo ativo da sessão ({} se não existe). */
function readSel(sessionId: string): BranchSel {
  const r = getDb().prepare('SELECT branch_sel_json FROM sessions WHERE id = ?').get(sessionId) as
    { branch_sel_json: string | null } | undefined
  return toBranchSel(parse<unknown>(r?.branch_sel_json, {}))
}

function writeSel(sessionId: string, sel: BranchSel): void {
  getDb()
    .prepare('UPDATE sessions SET branch_sel_json = ? WHERE id = ?')
    .run(JSON.stringify(sel), sessionId)
}

export const sessionsRepo = {
  list(chatId: string): Session[] {
    const rows = getDb()
      .prepare('SELECT * FROM sessions WHERE chat_id = ? ORDER BY created_at, rowid')
      .all(chatId) as SessionRow[]
    return rows.map(toSession)
  },
  /** Subsessões criadas diretamente por `parentSessionId` (filhos), na ordem de criação. */
  children(parentSessionId: string): Session[] {
    const rows = getDb()
      .prepare('SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at, rowid')
      .all(parentSessionId) as SessionRow[]
    return rows.map(toSession)
  },
  get(id: string): Session | null {
    const r = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      SessionRow | undefined
    return r ? toSession(r) : null
  },
  create(s: Omit<Session, 'id' | 'createdAt'>): Session {
    const sess: Session = {
      ...s,
      providerId: s.providerId ?? null,
      branchSel: s.branchSel ?? {},
      id: randomUUID(),
      createdAt: Date.now()
    }
    getDb()
      .prepare(
        `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, provider_id, title, task, status, created_at, branch_sel_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sess.id,
        sess.chatId,
        sess.parentSessionId,
        sess.parentToolCallId,
        sess.depth,
        sess.model,
        sess.providerId,
        sess.title,
        sess.task,
        sess.status,
        sess.createdAt,
        JSON.stringify(sess.branchSel)
      )
    return sess
  },
  setStatus(id: string, status: SessionStatus): Session | null {
    getDb().prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id)
    return sessionsRepo.get(id)
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id)
  },
  /**
   * Grava a seleção do ramo ativo (limpa: entradas inválidas/redundantes saem — o caminho é o
   * mesmo). Só escreve se mudou (o trigger do sync marcaria a sessão). Retorna a sessão.
   */
  setBranchSel(id: string, sel: BranchSel): Session | null {
    const db = getDb()
    db.transaction(() => {
      const next = pruneSel(buildTree(treeNodes(id)), sel)
      if (!selEquals(readSel(id), next)) writeSel(id, next)
    })()
    return sessionsRepo.get(id)
  },
  setModel(id: string, model: string): Session | null {
    getDb().prepare('UPDATE sessions SET model = ? WHERE id = ?').run(model, id)
    return sessionsRepo.get(id)
  },
  /** Na inicialização: sessões que ficaram rodando → 'interrupted'. Retorna os ids afetados. */
  markStaleInterrupted(): string[] {
    const rows = getDb()
      .prepare(
        "SELECT id FROM sessions WHERE status IN ('running', 'awaiting_approval', 'awaiting_input', 'waiting')"
      )
      .all() as { id: string }[]
    getDb()
      .prepare(
        "UPDATE sessions SET status = 'interrupted' WHERE status IN ('running', 'awaiting_approval', 'awaiting_input', 'waiting')"
      )
      .run()
    return rows.map((r) => r.id)
  },
  /** Na inicialização: card de falha de conexão que ficou aberto ('awaiting_retry') → 'error'. */
  markStaleRetry(): string[] {
    const rows = getDb()
      .prepare("SELECT id FROM sessions WHERE status = 'awaiting_retry'")
      .all() as { id: string }[]
    getDb().prepare("UPDATE sessions SET status = 'error' WHERE status = 'awaiting_retry'").run()
    return rows.map((r) => r.id)
  }
}

// ---------------- messages ----------------
// Árvore de mensagens (ramos — ver src/shared/branches.ts): parent_id '' = raiz, NULL = legado
// (→ anterior por seq), senão o id do pai. `path` = caminho ativo (o que o agente vê); `listAll` =
// todas as versões (UI, sync, buscas por id).

interface MessageRow {
  id: string
  session_id: string
  seq: number
  message_json: string
  meta_json: string
  created_at: number
  parent_id?: string | null
}

/** Coluna → StoredMessage.parentId (undefined = legado, derivar). */
const toParentId = (v: string | null | undefined): string | null | undefined =>
  v == null ? undefined : v === ROOT_PARENT ? null : v

/** StoredMessage.parentId → coluna. */
const fromParentId = (p: string | null): string => p ?? ROOT_PARENT

const toMessage = (r: MessageRow): StoredMessage => {
  const m: StoredMessage = {
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    message: parse<ApiMessage>(r.message_json, { role: 'user', content: '' }),
    meta: parse<MessageMeta>(r.meta_json, {}),
    createdAt: r.created_at
  }
  const p = toParentId(r.parent_id)
  if (p !== undefined) m.parentId = p
  return m
}

/** Só a estrutura (id, seq, pai) das mensagens da sessão — para calcular a árvore. */
function treeNodes(sessionId: string): TreeMessage[] {
  const rows = getDb()
    .prepare('SELECT id, seq, parent_id FROM messages WHERE session_id = ?')
    .all(sessionId) as { id: string; seq: number; parent_id: string | null }[]
  return rows.map((r) => {
    const p = toParentId(r.parent_id)
    return p === undefined ? { id: r.id, seq: r.seq } : { id: r.id, seq: r.seq, parentId: p }
  })
}

function insertRow(msg: StoredMessage, parentId: string | null): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    msg.id,
    msg.sessionId,
    msg.seq,
    JSON.stringify(msg.message),
    JSON.stringify(msg.meta),
    msg.createdAt,
    fromParentId(parentId)
  )
  indexMessage(db, msg.id, msg.message, msg.meta)
}

function nextSeq(sessionId: string): number {
  const r = getDb()
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE session_id = ?')
    .get(sessionId) as { m: number }
  return r.m + 1
}

export interface MessageRemoval {
  message: StoredMessage
  /** Filhos que passaram a apontar para o pai da apagada (já com o parentId novo). */
  reparented: StoredMessage[]
  /** A seleção do ramo ativo da sessão mudou (emitir session-updated). */
  selChanged: boolean
}

export const messagesRepo = {
  /** TODAS as mensagens da sessão (todos os ramos), por seq. UI, sync e buscas por id. */
  listAll(sessionId: string): StoredMessage[] {
    const rows = getDb()
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as MessageRow[]
    return rows.map(toMessage)
  },
  /** Caminho ativo da sessão (raiz → folha, crescente em seq): o histórico que o agente vê. */
  path(sessionId: string): StoredMessage[] {
    return activePath(messagesRepo.listAll(sessionId), readSel(sessionId))
  },
  get(id: string): StoredMessage | null {
    const r = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      MessageRow | undefined
    return r ? toMessage(r) : null
  },
  /**
   * Acrescenta no fim. Pai = `parentId` explícito (null = raiz) ou, por padrão, a folha do caminho
   * ativo (calculada dentro da transação). Um `null` na seleção sob esse pai (ramo novo vazio do
   * regenerate) é limpo — a mensagem passa a ser o caminho.
   */
  append(
    sessionId: string,
    message: ApiMessage,
    meta: MessageMeta = {},
    parentId?: string | null
  ): StoredMessage {
    const db = getDb()
    const tx = db.transaction((): StoredMessage => {
      const tree = buildTree(treeNodes(sessionId))
      const sel = readSel(sessionId)
      let parent: string | null
      if (parentId === undefined) parent = activeLeaf(tree, sel)?.id ?? null
      else {
        if (parentId !== null && !tree.byId.has(parentId))
          throw new Error(`Mensagem pai não encontrada na sessão: ${parentId}`)
        parent = parentId
      }
      const msg: StoredMessage = {
        id: randomUUID(),
        sessionId,
        seq: nextSeq(sessionId),
        parentId: parent,
        message,
        meta,
        createdAt: Date.now()
      }
      insertRow(msg, parent)
      const k = selKey(parent)
      if (Object.prototype.hasOwnProperty.call(sel, k) && sel[k] === null) {
        delete sel[k]
        writeSel(sessionId, sel)
      }
      return msg
    })
    return tx()
  },
  /**
   * Novo ramo: insere `message` como filho de `parentId` (null = nova raiz) — irmã das versões
   * que já existem ali — e seleciona o caminho até ela (o resto do caminho é ela mesma).
   */
  branch(
    sessionId: string,
    parentId: string | null,
    message: ApiMessage,
    meta: MessageMeta = {}
  ): StoredMessage {
    const db = getDb()
    const tx = db.transaction((): StoredMessage => {
      const nodes = treeNodes(sessionId)
      if (parentId !== null && !nodes.some((n) => n.id === parentId))
        throw new Error(`Mensagem pai não encontrada na sessão: ${parentId}`)
      const msg: StoredMessage = {
        id: randomUUID(),
        sessionId,
        seq: nextSeq(sessionId),
        parentId,
        message,
        meta,
        createdAt: Date.now()
      }
      insertRow(msg, parentId)
      const tree = buildTree([...nodes, { id: msg.id, seq: msg.seq, parentId }])
      const sel = readSel(sessionId)
      const next = pruneSel(tree, selectionToReach(tree, sel, msg.id))
      if (!selEquals(sel, next)) writeSel(sessionId, next)
      return msg
    })
    return tx()
  },
  /** Nova versão de `messageId`: irmã dela (mesmo pai efetivo), já selecionada. Ver `branch`. */
  addSibling(messageId: string, message: ApiMessage, meta: MessageMeta = {}): StoredMessage {
    const cur = messagesRepo.get(messageId)
    if (!cur) throw new Error(`Mensagem não encontrada: ${messageId}`)
    const parent = buildTree(treeNodes(cur.sessionId)).parentOf.get(messageId) ?? null
    return messagesRepo.branch(cur.sessionId, parent, message, meta)
  },
  /** Troca de versão: grava a seleção mínima para o caminho ativo passar por `messageId`. */
  select(messageId: string): Session {
    const cur = messagesRepo.get(messageId)
    if (!cur) throw new Error(`Mensagem não encontrada: ${messageId}`)
    const tree = buildTree(treeNodes(cur.sessionId))
    const sel = readSel(cur.sessionId)
    const next = pruneSel(tree, selectionToReach(tree, sel, messageId))
    if (!selEquals(sel, next)) writeSel(cur.sessionId, next)
    return sessionsRepo.get(cur.sessionId)!
  },
  /**
   * Insere uma mensagem na posição `seq`, deslocando (+1) as de seq ≥ `seq` da sessão. Só o número
   * de ordem muda — o conteúdo das mensagens deslocadas fica intacto. Usado pela compactação para
   * pôr a fronteira antes de mensagens do usuário ainda não respondidas.
   * Árvore: a nova entra entre a mensagem que estava em `seq` (pending0) e o pai dela (a fronteira
   * herda o pai; pending0 passa a ser filha da fronteira; uma seleção que apontava para pending0
   * aponta para a fronteira). Sem mensagem em `seq` → filha da folha do caminho ativo.
   */
  insertAt(
    sessionId: string,
    seq: number,
    message: ApiMessage,
    meta: MessageMeta = {}
  ): { message: StoredMessage; shifted: StoredMessage[]; selChanged: boolean } {
    const db = getDb()
    const tx = db.transaction(() => {
      const tree = buildTree(treeNodes(sessionId))
      const sel = readSel(sessionId)
      const pending0 = tree.ordered.find((n) => n.seq === seq) ?? null
      const parent = pending0
        ? (tree.parentOf.get(pending0.id) ?? null)
        : (activeLeaf(tree, sel)?.id ?? null)
      // dois passos (negativo → positivo) para não violar o índice único (session_id, seq)
      db.prepare('UPDATE messages SET seq = -(seq + 1) WHERE session_id = ? AND seq >= ?').run(
        sessionId,
        seq
      )
      db.prepare('UPDATE messages SET seq = -seq WHERE session_id = ? AND seq < 0').run(sessionId)
      const msg: StoredMessage = {
        id: randomUUID(),
        sessionId,
        seq,
        parentId: parent,
        message,
        meta,
        createdAt: Date.now()
      }
      insertRow(msg, parent)
      let selChanged = false
      if (pending0) {
        db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?').run(msg.id, pending0.id)
        const k = selKey(parent)
        if (sel[k] === pending0.id) {
          sel[k] = msg.id
          writeSel(sessionId, sel)
          selChanged = true
        }
      }
      const shifted = (
        db
          .prepare('SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq')
          .all(sessionId, seq) as MessageRow[]
      ).map(toMessage)
      return { message: msg, shifted, selChanged }
    })
    return tx()
  },
  update(id: string, message: ApiMessage, meta?: MessageMeta): StoredMessage {
    const cur = messagesRepo.get(id)
    if (!cur) throw new Error(`Mensagem não encontrada: ${id}`)
    const nextMeta = meta ?? cur.meta
    const db = getDb()
    db.transaction(() => {
      db.prepare('UPDATE messages SET message_json = ?, meta_json = ? WHERE id = ?').run(
        JSON.stringify(message),
        JSON.stringify(nextMeta),
        id
      )
      indexMessage(db, id, message, nextMeta)
    })()
    return { ...cur, message, meta: nextMeta }
  },
  /** Apaga uma mensagem (ver `remove`). */
  delete(id: string): StoredMessage | null {
    return messagesRepo.remove(id)?.message ?? null
  },
  /**
   * Apaga uma mensagem; os filhos dela passam para o pai dela (a conversa continua ligada) e a
   * seleção é ajustada para o caminho ativo continuar o mesmo, sem a apagada (a escolha feita
   * "dentro" dela sobe para o pai). Se a apagada era a folha, o caminho segue pelo pai.
   */
  remove(id: string): MessageRemoval | null {
    const cur = messagesRepo.get(id)
    if (!cur) return null
    const sid = cur.sessionId
    const db = getDb()
    return db.transaction((): MessageRemoval => {
      const nodes = treeNodes(sid)
      const tree = buildTree(nodes)
      const sel = readSel(sid)
      const oldLeaf = activeLeaf(tree, sel)
      const parent = tree.parentOf.get(id) ?? null
      const kids = new Set((tree.children.get(id) ?? []).map((k) => k.id))
      const upd = db.prepare('UPDATE messages SET parent_id = ? WHERE id = ?')
      for (const k of kids) upd.run(fromParentId(parent), k)
      db.prepare('DELETE FROM messages WHERE id = ?').run(id)

      const tree2 = buildTree(
        nodes
          .filter((n) => n.id !== id)
          .map((n) => (kids.has(n.id) ? { ...n, parentId: parent } : n))
      )
      let next: BranchSel = { ...sel }
      const pk = selKey(parent)
      const has = Object.prototype.hasOwnProperty.call(next, id)
      const inner = has ? next[id] : undefined
      delete next[id]
      if (next[pk] === id) {
        if (inner === undefined) delete next[pk]
        else next[pk] = inner
      }
      const target = oldLeaf && oldLeaf.id !== id ? oldLeaf.id : parent
      if (target) next = selectionToReach(tree2, next, target)
      next = pruneSel(tree2, next)
      const selChanged = !selEquals(sel, next)
      if (selChanged) writeSel(sid, next)
      const reparented = [...kids]
        .map((k) => messagesRepo.get(k))
        .filter((m): m is StoredMessage => !!m)
      return { message: cur, reparented, selChanged }
    })()
  }
}

// ---------------- chats ----------------

interface ChatRow {
  id: string
  title: string
  config_json: string
  main_session_id: string | null
  created_at: number
  updated_at: number
}

/** Modos globais (só lidos quando uma config legada do Smart-Approve precisa ser migrada). */
const legacyGlobalModes = (): Partial<Record<ApprovalItem, ApprovalMode>> | null =>
  settingsRepo.get<Partial<Record<ApprovalItem, ApprovalMode>>>(APPROVAL_MODES_SETTING) ?? null

const toChat = (r: ChatRow): Chat => {
  const fallback = DEFAULT_CHAT_CONFIG(homedir())
  // alias de leitura: nomes antigos de tools ('bash' → 'shell'), autoApprove (≤ 0.3.0) e
  // smartApprove.enabled/tools (≤ 0.4.0) → approvalModes
  const cfg = migrateLegacyApprovals(
    migrateConfigTools(parse<Partial<ChatConfig>>(r.config_json, {})),
    { globalModes: legacyGlobalModes }
  )
  return {
    id: r.id,
    title: r.title,
    config: {
      ...fallback,
      ...cfg,
      // ids antigos de assinatura (ex.: 'cleartchat') resolvem para o atual
      appSignature: normalizeAppSignatureId(cfg.appSignature),
      params: { ...(cfg.params ?? {}) },
      // normalizada como na persona (`sanitizePresetConfig`): campos legados de registros antigos
      // (`interjections` — protocolo §4.3.6) somem aqui e nunca voltam a ser gravados
      ...(cfg.voice && typeof cfg.voice === 'object'
        ? { voice: normalizeVoiceCallConfig(cfg.voice) }
        : {})
    },
    mainSessionId: r.main_session_id ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** Merge de params: chaves com undefined/null no patch são removidas. */
function mergeParams(base: ChatParams, patch: ChatParams | undefined): ChatParams {
  if (!patch) return base
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) delete out[k]
    else out[k] = v
  }
  return out as ChatParams
}

export const chatsRepo = {
  list(): Chat[] {
    const rows = getDb().prepare('SELECT * FROM chats ORDER BY updated_at DESC').all() as ChatRow[]
    return rows.map(toChat)
  },
  get(id: string): Chat | null {
    const r = getDb().prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined
    return r ? toChat(r) : null
  },
  create(input: ChatCreateInput): { chat: Chat; session: Session } {
    const s = (k: string): string | undefined => {
      const v = settingsRepo.get<unknown>(k)
      return typeof v === 'string' && v.trim() ? v : undefined
    }
    const inCfg = input?.config ?? {}
    const providerId =
      inCfg.providerId ||
      s('defaultProviderId') ||
      providersRepo.list().find(isChatProvider)?.id ||
      ''
    const provider = providerId ? providersRepo.get(providerId) : null
    const base = DEFAULT_CHAT_CONFIG(s('defaultCwd') ?? homedir(), {
      providerId,
      model: s('defaultModel'),
      systemPrompt: settingsRepo.get<string>('defaultSystemPrompt') ?? undefined,
      baseUrl: provider?.baseUrl,
      kind: provider?.kind
    })
    const definedCfg = migrateLegacyApprovals(
      migrateConfigTools(
        Object.fromEntries(
          Object.entries(inCfg).filter(([, v]) => v !== undefined)
        ) as Partial<ChatConfig>
      ),
      { globalModes: legacyGlobalModes }
    )
    const config: ChatConfig = {
      ...base,
      ...definedCfg,
      params: mergeParams(base.params, inCfg.params)
    }
    if (!config.cwd) config.cwd = homedir()

    const now = Date.now()
    const chatId = randomUUID()
    const db = getDb()
    const tx = db.transaction(() => {
      db.prepare(
        'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)'
      ).run(chatId, input?.title ?? '', JSON.stringify(config), now, now)
      const session = sessionsRepo.create({
        chatId,
        parentSessionId: null,
        parentToolCallId: null,
        depth: 0,
        model: config.model,
        title: 'Principal',
        task: null,
        status: 'idle'
      })
      db.prepare('UPDATE chats SET main_session_id = ? WHERE id = ?').run(session.id, chatId)
      return session
    })
    const session = tx()
    return { chat: chatsRepo.get(chatId)!, session }
  },
  /** Atualiza título/config (merge; `params` em deep-merge). Retorna o chat e se o modelo mudou. */
  update(id: string, patch: ChatUpdateInput): { chat: Chat; modelChanged: boolean } {
    const cur = chatsRepo.get(id)
    if (!cur) throw new Error(`Chat não encontrado: ${id}`)
    let config = cur.config
    if (patch?.config) {
      const raw = Object.fromEntries(
        Object.entries(patch.config).filter(([k, v]) => v !== undefined && k !== 'params')
      ) as Partial<ChatConfig>
      // patch legado { autoApprove: [...] } (ex.: scripts/testes antigos) → approvalModes por cima
      const definedCfg = migrateApprovalConfig(migrateConfigTools(raw))
      if ('autoApprove' in raw && definedCfg.approvalModes)
        definedCfg.approvalModes = { ...cur.config.approvalModes, ...definedCfg.approvalModes }
      if ('autoApprove' in raw && definedCfg.smartApprove && !raw.smartApprove)
        delete definedCfg.smartApprove
      // smartApprove legado (enabled/tools, ≤ 0.4.0) no patch → modos por item, sobre a config
      // mesclada (os overrides existentes do chat entram no mapeamento)
      config = migrateSmartApproveConfig(
        {
          ...cur.config,
          ...definedCfg,
          params: mergeParams(cur.config.params, patch.config.params)
        },
        { globalModes: legacyGlobalModes }
      )
    }
    const title = patch?.title !== undefined ? patch.title : cur.title
    const now = Date.now()
    getDb()
      .prepare('UPDATE chats SET title = ?, config_json = ?, updated_at = ? WHERE id = ?')
      .run(title, JSON.stringify(config), now, id)
    return {
      chat: { ...cur, title, config, updatedAt: now },
      modelChanged: config.model !== cur.config.model
    }
  },
  touch(id: string): void {
    getDb().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM chats WHERE id = ?').run(id)
  }
}

// ---------------- presets (personas) ----------------

interface PresetRow {
  id: string
  name: string
  description: string
  icon: string
  config_json: string
  created_at: number
  updated_at: number
}

const toPreset = (r: PresetRow): Preset => ({
  id: r.id,
  name: r.name,
  description: r.description,
  icon: r.icon,
  config: sanitizePresetConfig(parse<unknown>(r.config_json, {})),
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export const presetsRepo = {
  list(): Preset[] {
    const rows = getDb()
      .prepare('SELECT * FROM presets ORDER BY created_at, rowid')
      .all() as PresetRow[]
    return rows.map(toPreset)
  },
  get(id: string): Preset | null {
    const r = getDb().prepare('SELECT * FROM presets WHERE id = ?').get(id) as PresetRow | undefined
    return r ? toPreset(r) : null
  },
  create(input: PresetInput): Preset {
    const now = Date.now()
    const p: Preset = {
      id: randomUUID(),
      name: input?.name?.trim() || 'Persona',
      description: input?.description?.trim() ?? '',
      icon: input?.icon?.trim() ?? '',
      config: sanitizePresetConfig(input?.config),
      createdAt: now,
      updatedAt: now
    }
    getDb()
      .prepare(
        'INSERT INTO presets (id, name, description, icon, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(p.id, p.name, p.description, p.icon, JSON.stringify(p.config), now, now)
    return p
  },
  /** `patch.config` substitui a config inteira. */
  update(id: string, patch: PresetPatch): Preset {
    const cur = presetsRepo.get(id)
    if (!cur) throw new Error(`Persona não encontrada: ${id}`)
    const next: Preset = {
      ...cur,
      ...(patch?.name !== undefined ? { name: patch.name.trim() || cur.name } : {}),
      ...(patch?.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch?.icon !== undefined ? { icon: patch.icon.trim() } : {}),
      ...(patch?.config !== undefined ? { config: sanitizePresetConfig(patch.config) } : {}),
      updatedAt: Date.now()
    }
    getDb()
      .prepare(
        'UPDATE presets SET name = ?, description = ?, icon = ?, config_json = ?, updated_at = ? WHERE id = ?'
      )
      .run(next.name, next.description, next.icon, JSON.stringify(next.config), next.updatedAt, id)
    return next
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM presets WHERE id = ?').run(id)
    if (settingsRepo.get(DEFAULT_PRESET_SETTING) === id)
      settingsRepo.set(DEFAULT_PRESET_SETTING, null)
  },
  duplicate(id: string): Preset {
    const cur = presetsRepo.get(id)
    if (!cur) throw new Error(`Persona não encontrada: ${id}`)
    return presetsRepo.create({
      name: copyName(cur.name, presetsRepo.list()),
      description: cur.description,
      icon: cur.icon,
      config: cur.config
    })
  },
  /**
   * Primeira execução: cria a persona "Padrão" com config vazia (= segue os padrões de
   * "Novos chats" nas Configurações) e a marca como padrão. Roda uma vez só (apagá-la não a recria).
   */
  seed(): void {
    if (settingsRepo.get(PRESETS_SEEDED_SETTING)) return
    const db = getDb()
    db.transaction(() => {
      if ((db.prepare('SELECT COUNT(*) AS n FROM presets').get() as { n: number }).n === 0) {
        const p = presetsRepo.create({
          name: DEFAULT_PRESET_NAME,
          description: 'Configuração padrão do app (Configurações → Novos chats).',
          icon: DEFAULT_PRESET_ICON,
          config: {}
        })
        settingsRepo.set(DEFAULT_PRESET_SETTING, p.id)
      }
      settingsRepo.set(PRESETS_SEEDED_SETTING, true)
    })()
  }
}
