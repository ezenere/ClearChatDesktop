// Conectores (MCP): o que a tela de Conectores chama pelo IPC (main/ipc.ts → `IPC.mcp.*`): visão de
// cada conector (cadastro + estado deste aparelho), ações e a importação de configs de outros apps
// (Claude Desktop, Claude Code, Cursor — só leitura, e só quando o usuário pede).
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  effectiveTransport,
  mcpCommandText,
  parseMcpImport,
  type McpLocalState,
  type McpServerInput,
  type McpServerView,
  type McpTransport
} from '@shared/mcp'
import { mcpManager } from './manager'
import { mcpHasLogin, mcpLogout } from './oauth'
import { mcpLocal, mcpRepo } from './store'

export function serverView(id: string): McpServerView {
  const server = mcpRepo.get(id)
  if (!server) throw new Error('Conector não encontrado.')
  const local = mcpLocal.get(id) ?? {}
  const t = effectiveTransport(server, local)
  return {
    server,
    status: mcpManager.status(id),
    local,
    ...(t.type === 'stdio'
      ? { commandText: mcpCommandText(t as Extract<McpTransport, { type: 'stdio' }>) }
      : {}),
    hasLogin: mcpHasLogin(id)
  }
}

export function listViews(): McpServerView[] {
  return mcpRepo.list().map((s) => serverView(s.id))
}

export function createServer(input: McpServerInput): McpServerView {
  return serverView(mcpRepo.create(input).id)
}

export function updateServer(id: string, patch: Partial<McpServerInput>): McpServerView {
  mcpRepo.update(id, patch)
  return serverView(id)
}

export async function deleteServer(id: string): Promise<void> {
  await mcpLogout(id).catch(() => {})
  await mcpManager.disconnect(id)
  mcpRepo.delete(id)
}

export async function activate(id: string): Promise<McpServerView> {
  mcpLocal.activate(id)
  await mcpManager.reconnect(id)
  return serverView(id)
}

export async function deactivate(id: string): Promise<McpServerView> {
  mcpLocal.deactivate(id)
  await mcpManager.disconnect(id)
  return serverView(id)
}

/** Ajustes deste aparelho (stdio). Mudar o comando efetivo pede ativar de novo. */
export async function setOverride(
  id: string,
  override: McpLocalState['override'] | null
): Promise<McpServerView> {
  mcpLocal.patch(id, { override: override ?? undefined })
  await mcpManager.reconcile()
  return serverView(id)
}

/** Arquivos de config de outros apps que existem nesta máquina (para "Importar"). */
export function knownConfigPaths(
  home = homedir(),
  platform = process.platform
): { app: string; path: string }[] {
  const appData =
    platform === 'win32'
      ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'))
  return [
    { app: 'Claude Desktop', path: join(appData, 'Claude', 'claude_desktop_config.json') },
    { app: 'Claude Code', path: join(home, '.claude.json') },
    { app: 'Cursor', path: join(home, '.cursor', 'mcp.json') }
  ].filter((c) => existsSync(c.path))
}

/** O JSON de um desses arquivos, só a parte dos servidores (o resto do arquivo não sai daqui). */
export function readKnownConfig(path: string, home = homedir()): string {
  if (!knownConfigPaths(home).some((c) => c.path === path))
    throw new Error('Arquivo não reconhecido.')
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return JSON.stringify({ mcpServers: json.mcpServers ?? {} })
}

export function parseImport(text: string): ReturnType<typeof parseMcpImport> {
  return parseMcpImport(
    text,
    mcpRepo.list().map((s) => s.name)
  )
}
