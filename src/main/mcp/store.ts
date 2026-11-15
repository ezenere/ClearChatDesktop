// Conectores (MCP): o cadastro (tabela `mcp_servers`, sincronizada como `mcp_server`) e o estado
// deste aparelho (setting local `mcpLocal`: stdio ativado aqui, ajustes, era descoberta). Sem
// Electron (testável com banco temporário). Os tokens OAuth ficam à parte (oauth.ts, cifrados).
import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import {
  mcpCommandText,
  normalizeMcpServer,
  normalizeToolsCache,
  effectiveTransport,
  validateMcpName,
  type McpLocalState,
  type McpServerDef,
  type McpServerInput,
  type McpToolsCache,
  type McpTransport
} from '@shared/mcp'

export const MCP_LOCAL_SETTING = 'mcpLocal'

interface Row {
  id: string
  data_json: string
  created_at: number
  updated_at: number
}

function fromRow(r: Row): McpServerDef | null {
  let data: unknown
  try {
    data = JSON.parse(r.data_json)
  } catch {
    return null
  }
  return normalizeMcpServer({
    ...(data && typeof data === 'object' ? data : {}),
    id: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  })
}

/** O que vai em `data_json` (o registro sem id/datas). */
export function serverData(s: McpServerDef): Record<string, unknown> {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = s
  void _id
  void _c
  void _u
  return rest
}

export type { McpServerInput } from '@shared/mcp'

let listeners: (() => void)[] = []
/** Avisos de mudança (o main liga ao evento `mcp-changed` e ao gerenciador de conexões). */
export function onMcpStoreChange(fn: () => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}
export function notifyMcpStore(): void {
  for (const l of listeners) {
    try {
      l()
    } catch {
      /* ignora */
    }
  }
}

function write(s: McpServerDef): void {
  getDb()
    .prepare(
      `INSERT INTO mcp_servers (id, data_json, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
    )
    .run(s.id, JSON.stringify(serverData(s)), s.createdAt, s.updatedAt)
}

export const mcpRepo = {
  list(): McpServerDef[] {
    const rows = getDb().prepare('SELECT * FROM mcp_servers ORDER BY created_at, id').all() as Row[]
    return rows.map(fromRow).filter((s): s is McpServerDef => !!s)
  },
  get(id: string): McpServerDef | null {
    const r = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined
    return r ? fromRow(r) : null
  },
  create(input: McpServerInput): McpServerDef {
    const err = validateMcpName(input.name)
    if (err) throw new Error(err)
    if (mcpRepo.list().some((s) => s.name === input.name))
      throw new Error(`Já existe um conector chamado "${input.name}".`)
    const now = Date.now()
    const s = normalizeMcpServer({
      ...input,
      id: `mcp_${randomUUID()}`,
      approval: input.approval ?? { mode: 'ask' },
      createdAt: now,
      updatedAt: now
    })
    if (!s) throw new Error('Configuração do conector inválida.')
    write(s)
    notifyMcpStore()
    return s
  },
  update(id: string, patch: Partial<McpServerInput>): McpServerDef {
    const cur = mcpRepo.get(id)
    if (!cur) throw new Error('Conector não encontrado.')
    if (patch.name !== undefined && patch.name !== cur.name) {
      const err = validateMcpName(patch.name)
      if (err) throw new Error(err)
      if (mcpRepo.list().some((s) => s.id !== id && s.name === patch.name))
        throw new Error(`Já existe um conector chamado "${patch.name}".`)
    }
    const next = normalizeMcpServer({ ...cur, ...patch, id, updatedAt: Date.now() })
    if (!next) throw new Error('Configuração do conector inválida.')
    write(next)
    notifyMcpStore()
    return next
  },
  /** Última lista de tools vista (só grava quando muda — evita escrever/sincronizar à toa). */
  setToolsCache(id: string, cache: McpToolsCache): boolean {
    const cur = mcpRepo.get(id)
    if (!cur) return false
    const next = normalizeToolsCache(cache)
    const strip = (c: McpToolsCache | undefined): string =>
      JSON.stringify(c ? { ...c, at: 0 } : null)
    if (strip(cur.tools) === strip(next)) return false
    write({ ...cur, ...(next ? { tools: next } : {}), updatedAt: Date.now() })
    notifyMcpStore()
    return true
  },
  delete(id: string): void {
    getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    const all = readLocal()
    if (all[id]) {
      delete all[id]
      writeLocal(all)
    }
    notifyMcpStore()
  }
}

// ---------------- estado do aparelho ----------------

function readLocal(): Record<string, McpLocalState> {
  const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(MCP_LOCAL_SETTING) as
    { value: string | null } | undefined
  try {
    const v = r?.value ? JSON.parse(r.value) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

function writeLocal(v: Record<string, McpLocalState>): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(MCP_LOCAL_SETTING, JSON.stringify(v))
}

export const mcpLocal = {
  get(id: string): McpLocalState | undefined {
    return readLocal()[id]
  },
  all(): Record<string, McpLocalState> {
    return readLocal()
  },
  patch(id: string, patch: Partial<McpLocalState>, notify = true): McpLocalState {
    const all = readLocal()
    const next: McpLocalState = { ...(all[id] ?? {}), ...patch }
    for (const k of Object.keys(next) as (keyof McpLocalState)[])
      if (next[k] === undefined) delete next[k]
    all[id] = next
    writeLocal(all)
    if (notify) notifyMcpStore()
    return next
  },
  /** "Ativar neste computador": grava o comando EXATO que o usuário viu (stdio). */
  activate(id: string): McpLocalState {
    const s = mcpRepo.get(id)
    if (!s || s.transport.type !== 'stdio')
      throw new Error('Só conectores locais (stdio) se ativam.')
    const t = effectiveTransport(s, mcpLocal.get(id))
    return mcpLocal.patch(id, {
      activated: mcpCommandText(t as Extract<McpTransport, { type: 'stdio' }>)
    })
  },
  deactivate(id: string): McpLocalState {
    return mcpLocal.patch(id, { activated: undefined })
  }
}
