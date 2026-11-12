// Estado local do sync (tabelas sync_*) + triggers de rastreamento de mudanças. Sem Electron:
// recebe a conexão (db.ts no app; banco temporário nos testes). Ver docs/SYNC_PROTOCOL.md §19.
//
// Rastreamento: triggers AFTER INSERT/UPDATE/DELETE nas tabelas sincronizadas marcam (type, id) em
// `sync_dirty` (mark incrementa a cada mudança). O conteúdo a enviar é calculado na hora do push
// (comparando o plaintext local com a última versão conhecida do servidor, `sync_records.base`).
// Os triggers só agem com o sync ligado (`sync_flags.k = 'on'`) e fora da aplicação de mudanças
// remotas (`sync_flags.k = 'apply'`, gravado dentro da transação de aplicação).
import type Database from 'better-sqlite3'

/** Chaves de `settings` sincronizadas → id do registro `setting` (§4.3.2). */
export const SYNC_SETTING_KEYS: Record<string, string> = {
  defaultProviderId: 'defaultModel',
  defaultModel: 'defaultModel',
  defaultSystemPrompt: 'defaultSystemPrompt',
  defaultPresetId: 'defaultPresetId',
  approvalModes: 'approvalModes',
  approvalLists: 'approvalLists',
  webSearchEngines: 'webSearchEngines',
  webSearchApiKeys: 'webSearchApiKeys',
  webSearchMinIntervalSec: 'webSearchMinIntervalSec',
  // desde o protocolo 1.4.0: preferências que antes ficavam só no dispositivo
  smartApproveDefaults: 'smartApproveDefaults',
  autoTitle: 'autoTitle',
  toolOutputSpillChars: 'toolOutputSpillChars'
  // 1.5.0 a 1.8.x também audioInput/sttSettings/ttsSettings/voiceCallDefaults: locais do
  // dispositivo desde o protocolo 1.9.0 (mudá-las não marca nada — records.ts DEVICE_VOICE_SETTING_IDS)
}

const TABLES = `
CREATE TABLE IF NOT EXISTS sync_flags (k TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sync_records (
  type    TEXT NOT NULL,
  id      TEXT NOT NULL,
  scope   TEXT,
  rev     INTEGER NOT NULL,
  seq     INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  base    TEXT,            -- plaintext JSON da revisão do servidor (null = tombstone / opaco)
  opaque  TEXT,            -- Change inteiro de tipo desconhecido / versão de envelope desconhecida
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS idx_sync_records_scope ON sync_records(scope);
CREATE TABLE IF NOT EXISTS sync_dirty (
  type  TEXT NOT NULL,
  id    TEXT NOT NULL,
  scope TEXT,
  mark  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (type, id)
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  push_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,     -- 'lww' | 'content'
  chat_id    TEXT,
  body       TEXT NOT NULL,     -- corpo do push (JSON) — reenviado igual nas tentativas
  meta       TEXT NOT NULL,     -- [{ type, id, mark, plaintext }] para atualizar sync_records no ack
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_chat (
  chat_id       TEXT PRIMARY KEY,
  head          INTEGER NOT NULL DEFAULT 0,   -- head online conhecido
  base_head     INTEGER NOT NULL DEFAULT 0,   -- head em que o conteúdo local se baseia
  state         TEXT,                         -- último ChatState (JSON)
  needs_refetch INTEGER NOT NULL DEFAULT 0,
  host_cwd      TEXT,                         -- { deviceId, path } (informativo, §4.3.6)
  cwd_confirmed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_blobs (sha256 TEXT PRIMARY KEY, blob_id TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sync_commands_seen (cmd_id TEXT PRIMARY KEY, at INTEGER NOT NULL, result TEXT);
CREATE TABLE IF NOT EXISTS sync_skills (
  name          TEXT PRIMARY KEY,
  record_id     TEXT NOT NULL,
  mode          TEXT NOT NULL,          -- 'source' | 'copy'
  local_dir     TEXT,
  bundle_sha256 TEXT,
  rev           INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_pending_apply (type TEXT NOT NULL, id TEXT NOT NULL, change TEXT NOT NULL, PRIMARY KEY (type, id));
`

const ACTIVE = `EXISTS (SELECT 1 FROM sync_flags WHERE k = 'on') AND NOT EXISTS (SELECT 1 FROM sync_flags WHERE k = 'apply')`

const mark = (type: string, id: string, scope: string): string =>
  `INSERT INTO sync_dirty (type, id, scope, mark) VALUES ('${type}', ${id}, ${scope}, 1)
   ON CONFLICT(type, id) DO UPDATE SET mark = mark + 1, scope = COALESCE(excluded.scope, scope);`

function triggersFor(
  table: string,
  type: string,
  idCol: string,
  scopeNew: string,
  scopeOld: string
): string {
  const t = `sync_${table}`
  return `
CREATE TRIGGER IF NOT EXISTS ${t}_ai AFTER INSERT ON ${table} WHEN ${ACTIVE} BEGIN
  ${mark(type, `NEW.${idCol}`, scopeNew)}
END;
CREATE TRIGGER IF NOT EXISTS ${t}_au AFTER UPDATE ON ${table} WHEN ${ACTIVE} BEGIN
  ${mark(type, `NEW.${idCol}`, scopeNew)}
END;
CREATE TRIGGER IF NOT EXISTS ${t}_aui AFTER UPDATE OF ${idCol} ON ${table} WHEN ${ACTIVE} AND OLD.${idCol} <> NEW.${idCol} BEGIN
  ${mark(type, `OLD.${idCol}`, scopeOld)}
END;
CREATE TRIGGER IF NOT EXISTS ${t}_ad AFTER DELETE ON ${table} WHEN ${ACTIVE} BEGIN
  ${mark(type, `OLD.${idCol}`, scopeOld)}
END;`
}

// settings: só as chaves sincronizadas (o par do modelo padrão vira o registro 'defaultModel')
const settingId = (col: string): string =>
  `CASE ${col} ${Object.entries(SYNC_SETTING_KEYS)
    .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
    .join(' ')} END`
const settingKeys = Object.keys(SYNC_SETTING_KEYS)
  .map((k) => `'${k}'`)
  .join(', ')

const SETTINGS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS sync_settings_ai AFTER INSERT ON settings WHEN ${ACTIVE} AND NEW.key IN (${settingKeys}) BEGIN
  ${mark('setting', settingId('NEW.key'), 'NULL')}
END;
CREATE TRIGGER IF NOT EXISTS sync_settings_au AFTER UPDATE ON settings WHEN ${ACTIVE} AND NEW.key IN (${settingKeys}) BEGIN
  ${mark('setting', settingId('NEW.key'), 'NULL')}
END;
CREATE TRIGGER IF NOT EXISTS sync_settings_ad AFTER DELETE ON settings WHEN ${ACTIVE} AND OLD.key IN (${settingKeys}) BEGIN
  ${mark('setting', settingId('OLD.key'), 'NULL')}
END;`

/**
 * Versão dos triggers (recria quando muda — ex.: chaves novas ou removidas em SYNC_SETTING_KEYS;
 * '4' = as settings de voz saíram, protocolo 1.9.0).
 */
const TRIGGERS_VERSION = '4'

function triggerSql(): string {
  return [
    triggersFor('providers', 'provider', 'id', 'NULL', 'NULL'),
    triggersFor('presets', 'preset', 'id', 'NULL', 'NULL'),
    triggersFor('chats', 'chat', 'id', 'NEW.id', 'OLD.id'),
    triggersFor('sessions', 'session', 'id', 'NEW.chat_id', 'OLD.chat_id'),
    triggersFor(
      'messages',
      'message',
      'id',
      '(SELECT chat_id FROM sessions WHERE id = NEW.session_id)',
      '(SELECT chat_id FROM sessions WHERE id = OLD.session_id)'
    ),
    triggersFor('memory_collections', 'memory_collection', 'id', 'NULL', 'NULL'),
    triggersFor('memories', 'memory', 'id', 'NEW.collection_id', 'OLD.collection_id'),
    SETTINGS_TRIGGERS
  ].join('\n')
}

const TRIGGER_TABLES = [
  'providers',
  'presets',
  'chats',
  'sessions',
  'messages',
  'memory_collections',
  'memories',
  'settings'
]

/**
 * Colunas locais de `chats` para os chats só ao vivo (§23.2, §4.4 — nunca enviadas): `storage`
 * (NULL/'online' | 'live' | 'live_pending') e `live_epoch` (último epoch ao vivo usado). Idempotente.
 */
export function ensureChatStorageColumns(conn: Database.Database): void {
  const cols = (conn.prepare('PRAGMA table_info(chats)').all() as { name: string }[]).map(
    (c) => c.name
  )
  if (!cols.length) return
  if (!cols.includes('storage')) conn.exec('ALTER TABLE chats ADD COLUMN storage TEXT')
  if (!cols.includes('live_epoch')) conn.exec('ALTER TABLE chats ADD COLUMN live_epoch INTEGER')
}

/** Cria as tabelas sync_* e os triggers (idempotente). Precisa das tabelas do app já criadas. */
export function ensureSyncSchema(conn: Database.Database): void {
  ensureChatStorageColumns(conn)
  conn.exec(TABLES)
  const v = conn.prepare("SELECT value FROM sync_state WHERE key = 'triggers'").get() as
    { value: string } | undefined
  if (v?.value !== TRIGGERS_VERSION) {
    conn.transaction(() => {
      for (const t of TRIGGER_TABLES)
        for (const s of ['ai', 'au', 'aui', 'ad'])
          conn.exec(`DROP TRIGGER IF EXISTS sync_${t}_${s}`)
      conn.exec(triggerSql())
      conn
        .prepare(
          "INSERT INTO sync_state (key, value) VALUES ('triggers', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(TRIGGERS_VERSION)
    })()
  } else conn.exec(triggerSql())
}

/** Liga/desliga o rastreamento (triggers). */
export function setTracking(conn: Database.Database, on: boolean): void {
  if (on) conn.prepare("INSERT OR IGNORE INTO sync_flags (k) VALUES ('on')").run()
  else conn.prepare("DELETE FROM sync_flags WHERE k = 'on'").run()
}

export function isTracking(conn: Database.Database): boolean {
  return !!conn.prepare("SELECT 1 FROM sync_flags WHERE k = 'on'").get()
}

/**
 * Executa `fn` numa transação com os triggers suspensos (aplicação de mudanças remotas). Aninhável:
 * dentro de outra transação vira savepoint (better-sqlite3).
 */
export function withApply<T>(conn: Database.Database, fn: () => T): T {
  const already = !!conn.prepare("SELECT 1 FROM sync_flags WHERE k = 'apply'").get()
  if (already) return conn.transaction(fn)()
  return conn.transaction(() => {
    conn.prepare("INSERT OR IGNORE INTO sync_flags (k) VALUES ('apply')").run()
    try {
      return fn()
    } finally {
      conn.prepare("DELETE FROM sync_flags WHERE k = 'apply'").run()
    }
  })()
}

/** Apaga todo o estado de sync (logout / troca de conta) — os dados do app ficam. */
export function wipeSyncState(conn: Database.Database): void {
  conn.transaction(() => {
    for (const t of [
      'sync_records',
      'sync_dirty',
      'sync_outbox',
      'sync_chat',
      'sync_blobs',
      'sync_commands_seen',
      'sync_skills',
      'sync_pending_apply'
    ])
      conn.exec(`DELETE FROM ${t}`)
    conn.exec("DELETE FROM sync_state WHERE key <> 'triggers'")
    conn.exec('DELETE FROM sync_flags')
  })()
}
