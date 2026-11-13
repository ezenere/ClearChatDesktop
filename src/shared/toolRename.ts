// Renomeação de tools (ex.: `bash` → `shell`): transformações puras usadas pela migração do banco
// (src/main/db.ts) e como alias de leitura de configs (repo / personas / chats.update).
// Só os renomes de STORED_TOOL_RENAMES: `search_tool` → `tool_search` (1.12.0) nunca regrava nada
// (alias de leitura em TOOL_ALIASES + troca na cópia enviada).
import {
  STORED_TOOL_RENAMES as TOOL_ALIASES,
  normalizeToolList,
  type ChatConfig,
  type ToolName
} from './types'

const rename = (n: unknown): unknown => (typeof n === 'string' ? (TOOL_ALIASES[n] ?? n) : n)

/**
 * Config (chat ou persona, parcial): enabledTools, autoApprove e smartApprove.tools com nomes
 * antigos mapeados. Retorna o MESMO objeto se nada mudou (útil para saber se precisa regravar).
 */
export function migrateConfigTools<T extends Partial<ChatConfig>>(cfg: T): T {
  if (!cfg || typeof cfg !== 'object') return cfg
  let out: T = cfg
  const fix = (list: unknown): ToolName[] | undefined => {
    if (!Array.isArray(list) || !list.some((t) => typeof t === 'string' && t in TOOL_ALIASES))
      return undefined
    return normalizeToolList(list)
  }
  const en = fix(cfg.enabledTools)
  if (en) {
    // quem tinha o terminal habilitado ganha também as tools de processos em segundo plano
    const procs: ToolName[] = ['process_start', 'process_logs', 'process_list', 'process_stop']
    const i = en.indexOf('shell')
    const add = procs.filter((t) => !en.includes(t))
    if (i !== -1) en.splice(i + 1, 0, ...add)
    out = { ...out, enabledTools: en }
  }
  const aa = fix(cfg.autoApprove)
  if (aa) out = { ...out, autoApprove: aa }
  const sa = cfg.smartApprove
  const st = sa && typeof sa === 'object' ? fix(sa.tools) : undefined
  if (sa && st) out = { ...out, smartApprove: { ...sa, tools: st } }
  return out
}

/** message_json: tool_calls[].function.name antigos → atuais. null = nada mudou. */
export function migrateMessageJson(json: string): string | null {
  let m: unknown
  try {
    m = JSON.parse(json)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object') return null
  const msg = m as { role?: string; tool_calls?: { function?: { name?: unknown } }[] }
  if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) return null
  let changed = false
  for (const tc of msg.tool_calls) {
    const f = tc?.function
    if (f && typeof f.name === 'string' && f.name in TOOL_ALIASES) {
      f.name = rename(f.name) as string
      changed = true
    }
  }
  return changed ? JSON.stringify(m) : null
}

/** meta_json: campos com nome de tool (toolName) antigos → atuais. null = nada mudou. */
export function migrateMetaJson(json: string): string | null {
  let m: unknown
  try {
    m = JSON.parse(json)
  } catch {
    return null
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  const meta = m as Record<string, unknown>
  let changed = false
  for (const k of ['toolName', 'tool']) {
    if (typeof meta[k] === 'string' && (meta[k] as string) in TOOL_ALIASES) {
      meta[k] = rename(meta[k])
      changed = true
    }
  }
  return changed ? JSON.stringify(meta) : null
}

/** config_json (chat/persona). null = nada mudou. */
export function migrateConfigJson(json: string): string | null {
  let c: unknown
  try {
    c = JSON.parse(json)
  } catch {
    return null
  }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const next = migrateConfigTools(c as Partial<ChatConfig>)
  return next === c ? null : JSON.stringify(next)
}
