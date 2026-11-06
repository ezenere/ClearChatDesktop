import { app } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { DB_FILENAME } from './migrate'
import { migrateToolShellRename } from './migrateTools'
import { migrateApprovalModes, migrateSmartApproveItems } from './migrateApprovals'
import { migrateWebSearchEngines } from './migrateWebSearch'
import { SCHEMA } from './dbSchema'
import { ensureSearchIndex } from './searchIndex'
import { ensureMemorySchema } from './memory/schema'
import { ensureMessageTree } from './migrateBranches'
import { ensureChatStorageColumns } from './sync/schema'

let db: Database.Database | null = null

export function getDbPath(): string {
  return join(app.getPath('userData'), DB_FILENAME)
}

/** Abre (uma vez) o banco em userData/clearchat.db, com WAL + foreign_keys e schema criado. */
export function getDb(): Database.Database {
  if (db) return db
  const conn = new Database(getDbPath())
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  conn.exec(SCHEMA)
  migrate(conn)
  db = conn
  return conn
}

/** Colunas adicionadas depois do schema inicial (idempotente). */
function migrate(conn: Database.Database): void {
  const cols = (conn.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
    (c) => c.name
  )
  // provedor da subsessão (a principal segue o do chat)
  if (!cols.includes('provider_id')) conn.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT')
  // tipo do provider (adaptador); vazio = inferido pela base_url — preenchido aqui uma vez
  const pcols = (conn.prepare('PRAGMA table_info(providers)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (!pcols.includes('kind')) {
    conn.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
    conn.exec(
      "UPDATE providers SET kind = CASE WHEN base_url LIKE '%openrouter.ai%' THEN 'openrouter' WHEN base_url LIKE '%api.anthropic.com%' THEN 'anthropic' ELSE 'openai' END"
    )
  }
  // tool `bash` renomeada para `shell` (histórico, configs de chats e personas) — uma vez
  try {
    const r = migrateToolShellRename(conn)
    if (!r.skipped)
      console.log(
        `[clearchat] migração bash→shell: ${r.messages} mensagens, ${r.metas} metas, ${r.chats} chats, ${r.presets} personas`
      )
  } catch (e) {
    console.error('[clearchat] migração bash→shell', e)
  }
  // "Auto-aprovar"/"sempre neste chat" + Smart-Approve por tool → modos por item — uma vez
  try {
    const r = migrateApprovalModes(conn)
    if (!r.skipped)
      console.log(`[clearchat] migração de aprovações: ${r.chats} chats, ${r.presets} personas`)
  } catch (e) {
    console.error('[clearchat] migração de aprovações', e)
  }
  // Smart-Approve liga/desliga + extras (≤ 0.4.0) → modo smart por item — uma vez (depois da acima)
  try {
    const r = migrateSmartApproveItems(conn)
    if (!r.skipped)
      console.log(`[clearchat] migração do Smart-Approve: ${r.chats} chats, ${r.presets} personas`)
  } catch (e) {
    console.error('[clearchat] migração do Smart-Approve', e)
  }
  // web_search: lista ordenada de buscadores (DuckDuckGo → Brave (site); APIs desligadas) — idempotente
  try {
    if (migrateWebSearchEngines(conn).changed) console.log('[clearchat] buscadores do web_search')
  } catch (e) {
    console.error('[clearchat] migração dos buscadores', e)
  }
  // memória modular: coleções, memórias, FTS e sessions.memory_json (idempotente)
  try {
    ensureMemorySchema(conn)
  } catch (e) {
    console.error('[clearchat] schema da memória', e)
  }
  // árvore de mensagens (ramos): messages.parent_id + sessions.branch_sel_json; parent_id preenchido
  // uma vez (anterior por seq), sem marcar nada como sujo no sync
  try {
    const r = ensureMessageTree(conn)
    if (!r.skipped) console.log(`[clearchat] árvore de mensagens: ${r.filled} mensagens`)
  } catch (e) {
    console.error('[clearchat] árvore de mensagens', e)
  }
  // chats só ao vivo (sync 1.8.0, §23): modo local do chat + último epoch ao vivo (nunca sincronizados)
  try {
    ensureChatStorageColumns(conn)
  } catch (e) {
    console.error('[clearchat] colunas de chats ao vivo', e)
  }
  // índice FTS5 das mensagens (read_history em outros chats) — cria/popula uma vez; depois o repo mantém
  try {
    const r = ensureSearchIndex(conn)
    if (!r.skipped) console.log(`[clearchat] índice de busca: ${r.indexed} mensagens em ${r.ms} ms`)
  } catch (e) {
    console.error('[clearchat] índice de busca', e)
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
