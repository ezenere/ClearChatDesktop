// Agendamentos: tabela local `schedules` (NUNCA sincroniza — o agendamento é do aparelho que
// executa o chat). data_json = ScheduleInfo inteiro; chat_id/status em colunas para as consultas.
// Sem Electron além do getDb (testável com o banco temporário dos testes).
import { getDb } from '../db'
import { SCHEDULE_LIMITS, type ScheduleInfo } from '@shared/schedule'

interface Row {
  id: string
  data_json: string
}

function fromRow(r: Row): ScheduleInfo | null {
  try {
    const v = JSON.parse(r.data_json) as ScheduleInfo
    return v && typeof v === 'object' && v.id === r.id ? v : null
  } catch {
    return null
  }
}

const all = (rows: Row[]): ScheduleInfo[] => rows.map(fromRow).filter((s): s is ScheduleInfo => !!s)

export const scheduleRepo = {
  exists(id: string): boolean {
    return !!getDb().prepare('SELECT 1 FROM schedules WHERE id = ?').get(id)
  },

  get(id: string): ScheduleInfo | null {
    const r = getDb().prepare('SELECT id, data_json FROM schedules WHERE id = ?').get(id) as
      Row | undefined
    return r ? fromRow(r) : null
  },

  /** Grava (insere ou substitui). */
  save(s: ScheduleInfo): void {
    getDb()
      .prepare(
        `INSERT INTO schedules (id, chat_id, status, data_json, created_at, updated_at)
         VALUES (@id, @chat, @status, @json, @created, @now)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data_json = excluded.data_json,
           updated_at = excluded.updated_at`
      )
      .run({
        id: s.id,
        chat: s.chatId,
        status: s.status,
        json: JSON.stringify(s),
        created: s.createdAt,
        now: Date.now()
      })
  },

  /** Todos os do chat (qualquer estado), mais antigos primeiro. */
  listChat(chatId: string): ScheduleInfo[] {
    return all(
      getDb()
        .prepare('SELECT id, data_json FROM schedules WHERE chat_id = ? ORDER BY created_at, id')
        .all(chatId) as Row[]
    )
  },

  listActive(): ScheduleInfo[] {
    return all(
      getDb()
        .prepare("SELECT id, data_json FROM schedules WHERE status = 'active' ORDER BY created_at")
        .all() as Row[]
    )
  },

  /** Encerrados cujo aviso ainda não foi gravado no chat. */
  listPendingNotices(): ScheduleInfo[] {
    return all(
      getDb()
        .prepare(
          `SELECT id, data_json FROM schedules WHERE status <> 'active'
             AND json_extract(data_json, '$.noticePending') = 1 ORDER BY created_at`
        )
        .all() as Row[]
    )
  },

  /** Mantém só os `keep` encerrados mais recentes do chat (os ativos nunca saem). */
  prune(chatId: string, keep: number = SCHEDULE_LIMITS.endedKeepPerChat): void {
    getDb()
      .prepare(
        `DELETE FROM schedules WHERE chat_id = ? AND status <> 'active' AND id NOT IN (
           SELECT id FROM schedules WHERE chat_id = ? AND status <> 'active'
           ORDER BY updated_at DESC LIMIT ?)`
      )
      .run(chatId, chatId, keep)
  },

  deleteChat(chatId: string): void {
    getDb().prepare('DELETE FROM schedules WHERE chat_id = ?').run(chatId)
  }
}
