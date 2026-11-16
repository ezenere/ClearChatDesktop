// Sem Electron: importado por db.ts e pelos testes (banco temporário).
// Schema: ver SPEC.md → "Banco". JSON fica em colunas *_json; IDs = crypto.randomUUID(); timestamps = Date.now().
// Árvore de mensagens (ramos): messages.parent_id ('' = raiz, NULL = legado → anterior por seq) e
// sessions.branch_sel_json — em bancos antigos as colunas, o índice (session_id, parent_id) e o
// preenchimento vêm de ensureMessageTree (migrateBranches.ts); o índice fica lá porque este SCHEMA
// roda antes das migrações (num banco antigo a coluna ainda não existe).
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS providers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  api_key      TEXT NOT NULL DEFAULT '',
  headers_json TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);

-- Conectores (servidores MCP, SPEC → "Conectores (MCP)"): o registro sincronizado (mcp_server);
-- data_json = McpServerDef sem id/datas. O estado do aparelho (ativado aqui, ajustes, era, tokens
-- OAuth) fica em settings locais (mcpLocal / mcpAuth) — nunca sincroniza.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY,
  data_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS chats (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  config_json     TEXT NOT NULL,
  main_session_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  chat_id             TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  parent_session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  parent_tool_call_id TEXT,
  depth               INTEGER NOT NULL DEFAULT 0,
  model               TEXT NOT NULL,
  title               TEXT NOT NULL DEFAULT '',
  task                TEXT,
  status              TEXT NOT NULL DEFAULT 'idle',
  created_at          INTEGER NOT NULL,
  branch_sel_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_chat ON sessions(chat_id);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  parent_id    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Agendamentos (tools schedule/schedule_list/schedule_stop — SPEC → "Agendamentos"): só deste
-- aparelho, NUNCA sincroniza. data_json = ScheduleInfo inteiro (@shared/schedule). Ativos só
-- existem com o app aberto: no start os que sobraram de um fechamento abrupto viram cancelados.
CREATE TABLE IF NOT EXISTS schedules (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  status     TEXT NOT NULL,
  data_json  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_chat ON schedules(chat_id, status);
`
