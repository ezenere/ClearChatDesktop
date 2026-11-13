// Registro das tools executadas localmente. delegate_task é tratado pelo runner (precisa do loop).
// send_to_chat também (precisa do loop do chat de destino).
import type { ToolName } from '@shared/types'
import { shell } from './bash'
import { processList, processLogs, processStart, processStop } from './processes'
import { editFile, listDir, readFile, writeFile } from './files'
import { findFiles, searchFiles } from './search'
import { presentFileTool } from './present'
import { listModelsTool } from './models'
import { getChatInfoTool, listChatsTool } from './chats'
import { readHistoryTool } from './history'
import { browseUrl, webSearch } from './web'
import { listSkillsTool, skillLoadTool, skillReadTool } from './skills'
import { runDatetimeTool } from '@shared/datetime'
import {
  fail,
  isInside,
  runToolImpl,
  ToolError,
  type ShellState,
  type ToolContext,
  type ToolResult
} from './util'

export type { ShellState, ToolContext, ToolResult } from './util'

/** Diretório do shell (tool shell) por sessão — persiste entre chamadas; volta ao raiz se o raiz mudar. */
const shells = new Map<string, ShellState>()

export function shellStateFor(
  sessionId: string,
  root: string,
  restore?: () => string | undefined
): ShellState {
  let s = shells.get(sessionId)
  if (!s || s.root !== root) {
    // Primeira chamada desde que o app abriu: restaura o último diretório salvo (se dentro do raiz).
    const prev = !s ? restore?.() : undefined
    s = { root, dir: prev && isInside(root, prev) ? prev : root }
    shells.set(sessionId, s)
  }
  return s
}

export function dropShellState(sessionId: string): void {
  shells.delete(sessionId)
}

type Impl = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>

const IMPLS: Partial<Record<ToolName, Impl>> = {
  list_dir: listDir,
  read_file: readFile,
  search_files: searchFiles,
  find_files: findFiles,
  present_file: presentFileTool,
  write_file: writeFile,
  edit_file: editFile,
  shell,
  process_start: processStart,
  process_logs: processLogs,
  process_list: processList,
  process_stop: processStop,
  web_search: webSearch,
  browse_url: browseUrl,
  list_models: listModelsTool,
  get_chat_info: getChatInfoTool,
  list_chats: listChatsTool,
  read_history: readHistoryTool,
  list_skills: listSkillsTool,
  skill_load: skillLoadTool,
  skill_read: skillReadTool,
  // data/hora do aparelho que roda o turno, no fuso dele (1.11.0; sem aprovação)
  datetime: async (args) => runDatetimeTool(args)
}

/** Faz parse dos argumentos (string JSON da tool_call). */
export function parseToolArgs(
  raw: string | Record<string, unknown> | undefined
): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw
  const s = (raw ?? '').trim()
  if (!s) return {}
  let v: unknown
  try {
    v = JSON.parse(s)
  } catch (e) {
    throw new ToolError(
      `Argumentos JSON inválidos: ${(e as Error).message}. Recebido: ${s.slice(0, 300)}`
    )
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new ToolError('Os argumentos devem ser um objeto JSON.')
  return v as Record<string, unknown>
}

/**
 * Executa uma tool local. Erros viram resultado de texto (status 'error'); abort é relançado (AbortError).
 */
export async function runLocalTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const impl = IMPLS[name]
  if (!impl) return fail(`Erro: ferramenta desconhecida: ${name}`)
  return runToolImpl(impl, args, ctx)
}
