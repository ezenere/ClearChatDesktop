// Conectores (MCP): liga o cadastro, as conexões e o pedido de dados (elicitação) ao resto do app —
// a fonte das tools/instruções da request (agent/request.ts → setMcpSource), o ambiente do usuário
// para os processos stdio, o evento `mcp-changed` e a fila de formulários pendentes (UI → IPC).
import { randomUUID } from 'node:crypto'
import {
  mcpAvailability,
  mcpFormContent,
  mcpFormFromRequest,
  mcpInstructionsBlock,
  mcpLabel,
  mcpToolEntries,
  normalizeMcpChoices,
  type McpServerDef
} from '@shared/mcp'
import type { Chat, McpElicitRequest } from '@shared/types'
import { emit, onAgentEvent } from '../events'
import { setMcpSource } from '../agent/request'
import { userEnv } from '../tools/shellEnv'
import { cleanEnv, configureMcpManager, mcpManager, type McpCallOwner } from './manager'
import { mcpLocal, mcpRepo, notifyMcpStore, onMcpStoreChange } from './store'
import { configureMcpOAuth, mcpAuthProvider } from './oauth'

/** Servidores do cadastro que rodam neste aparelho (stdio ativado; HTTP sempre). */
export function serversHere(): McpServerDef[] {
  return mcpRepo.list().filter((s) => mcpAvailability(s, mcpLocal.get(s.id), 'computer').ok)
}

const PREPARE_TIMEOUT_MS = 15_000

// ---------------- elicitação ----------------

interface Pending {
  req: McpElicitRequest
  resolve: (r: {
    action: 'accept' | 'decline' | 'cancel'
    content?: Record<string, unknown>
  }) => void
}
const pending = new Map<string, Pending>()
/** Chamadas canceladas (Parar): o formulário delas some. */
const byCall = new Map<string, string>()

function elicit(
  owner: McpCallOwner | null,
  server: McpServerDef,
  params: Record<string, unknown>
): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }> {
  const form = mcpFormFromRequest(params)
  // esquema que não sabemos mostrar: recusa (o servidor segue sem os dados)
  if (!form) return Promise.resolve({ action: 'decline' })
  const req: McpElicitRequest = {
    id: randomUUID(),
    chatId: owner?.chatId ?? null,
    sessionId: owner?.sessionId ?? null,
    toolCallId: owner?.toolCallId ?? null,
    serverId: server.id,
    serverLabel: mcpLabel(server),
    form,
    createdAt: Date.now()
  }
  return new Promise((resolve) => {
    pending.set(req.id, { req, resolve })
    if (req.toolCallId) byCall.set(req.toolCallId, req.id)
    emit({ type: 'mcp-elicit', request: req })
  })
}

function finish(
  id: string,
  r: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
): void {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  if (p.req.toolCallId) byCall.delete(p.req.toolCallId)
  p.resolve(r)
  emit({ type: 'mcp-elicit-done', id })
}

/** Pedidos em aberto (a UI relê ao abrir). */
export function pendingElicitations(): McpElicitRequest[] {
  return [...pending.values()].map((p) => p.req)
}

/**
 * Resposta do usuário: accept com os valores (validados no esquema — erros voltam por campo, e o
 * pedido continua aberto), decline ou cancel.
 */
export function answerElicitation(
  id: string,
  action: 'accept' | 'decline' | 'cancel',
  values: Record<string, unknown> = {}
): { ok: true } | { ok: false; errors: Record<string, string> } {
  const p = pending.get(id)
  if (!p) return { ok: true }
  if (action !== 'accept') {
    finish(id, { action })
    return { ok: true }
  }
  const { content, errors } = mcpFormContent(p.req.form, values)
  if (Object.keys(errors).length) return { ok: false, errors }
  finish(id, { action: 'accept', content })
  return { ok: true }
}

/** A tool que pediu os dados foi cancelada (Parar/⚡): o formulário dela fecha como "cancel". */
export function cancelElicitationsOf(toolCallId: string): void {
  const id = byCall.get(toolCallId)
  if (id) finish(id, { action: 'cancel' })
}

// ---------------- inicialização ----------------

let started = false

export function initMcp(
  appVersion: string,
  platform: {
    /** safeStorage do sistema (null = sem cofre → guarda sem cifrar). */
    encrypt?: (plain: string) => string | null
    decrypt?: (stored: string) => string | null
    /** Navegador do sistema (login OAuth). */
    openUrl?: (url: string) => void | Promise<void>
  } = {}
): void {
  if (started) return
  started = true
  configureMcpOAuth({
    crypto: {
      encrypt: platform.encrypt ?? (() => null),
      decrypt: platform.decrypt ?? (() => null)
    },
    ...(platform.openUrl ? { openUrl: platform.openUrl } : {}),
    onChange: () => emit({ type: 'mcp-changed' })
  })
  configureMcpManager({
    appVersion,
    authProvider: mcpAuthProvider,
    userEnv: async () => cleanEnv((await userEnv()).env ?? process.env),
    elicit,
    onChange: () => emit({ type: 'mcp-changed' })
  })
  onMcpStoreChange(() => {
    void mcpManager.reconcile()
    emit({ type: 'mcp-changed' })
  })
  // sync aplicou conectores de outro aparelho (SQL direto): reconcilia as conexões e avisa a UI
  onAgentEvent((e) => {
    if (e.type === 'sync-data-changed' && e.scopes.includes('mcp')) notifyMcpStore()
  })
  setMcpSource({
    entries: (chat: Pick<Chat, 'config'>) =>
      mcpToolEntries(
        serversHere(),
        normalizeMcpChoices(chat.config.mcpServers),
        (s) => mcpManager.liveTools(s.id) ?? s.tools?.tools ?? null
      ),
    instructions: (chat: Pick<Chat, 'config'>) =>
      mcpInstructionsBlock(serversHere(), normalizeMcpChoices(chat.config.mcpServers)),
    prepare: async (chat: Pick<Chat, 'config'>) => {
      const choices = normalizeMcpChoices(chat.config.mcpServers)
      const ids = serversHere()
        .filter((s) => choices[s.id]?.on && !mcpManager.liveTools(s.id))
        .map((s) => s.id)
      if (!ids.length) return
      // não segura o turno para sempre: o que não conectou a tempo vai com a lista do cadastro
      await Promise.race([
        mcpManager.ensureMany(ids),
        new Promise((r) => setTimeout(r, PREPARE_TIMEOUT_MS).unref?.())
      ])
    }
  })
}

export async function shutdownMcp(): Promise<void> {
  for (const id of [...pending.keys()]) finish(id, { action: 'cancel' })
  await mcpManager.closeAll()
}
