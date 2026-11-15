/* eslint-disable @typescript-eslint/no-explicit-any */
// Conectores (MCP) no runner REAL: provedor OpenAI-compatible FALSO (127.0.0.1) que chama a tool
// pedida na mensagem ("CALL {json}") + servidor MCP FALSO por stdio (e2e/fixtures). Request (tools
// MCP completas/compactas, ligadas/desligadas, instruções, subagentes), aprovação (sempre /
// perguntar → permitir/negar), resultado (texto, imagem como anexo, isError) e formulário de
// elicitação até a resposta. Sem rede externa, sem custo.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/mcpRunner.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-mcprun-'))
process.env.CLEARCHAT_TEST_USERDATA = TMP
process.env.CLEARCHAT_SKIP_SHELL_ENV = '1'
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export class BrowserWindow { static getAllWindows() { return [] } }
export const session = { fromPartition: () => ({}) }
export const dialog = {}
export const ipcMain = { handle() {} }
export const nativeImage = {}
export default { app, BrowserWindow, session, dialog, ipcMain, nativeImage }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

const FAKE = resolve(import.meta.dirname, 'fixtures/mcp-fake-server.mjs')
const MODEL = 'fake/agent'
let server: Server
let base = ''
let calls = 0
const bodies: any[] = []
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''
async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 5 } } : {}) })}\n\n`

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000 }] }))
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      bodies.push(body)
      calls++
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      const full = (t: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: t }))
        res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
      }
      if (last?.role === 'tool') return full('FIM')
      const call = /^CALL (.+)$/m.exec(lastUser)
      if (call) {
        const c = JSON.parse(call[1])
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(
          chunk(body.model, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${calls}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
              }
            ]
          })
        )
        res.end(chunk(body.model, {}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      return full(`R${calls}`)
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

type Mods = {
  runner: typeof import('../src/main/agent/runner.ts')
  repo: typeof import('../src/main/repo.ts')
  request: typeof import('../src/main/agent/request.ts')
  store: typeof import('../src/main/mcp/store.ts')
  mcp: typeof import('../src/main/mcp/index.ts')
  manager: typeof import('../src/main/mcp/manager.ts')
  approvals: typeof import('../src/main/agent/approvals.ts')
  events: typeof import('../src/main/events.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    runner: await import('../src/main/agent/runner.ts'),
    repo: await import('../src/main/repo.ts'),
    request: await import('../src/main/agent/request.ts'),
    store: await import('../src/main/mcp/store.ts'),
    mcp: await import('../src/main/mcp/index.ts'),
    manager: await import('../src/main/mcp/manager.ts'),
    approvals: await import('../src/main/agent/approvals.ts'),
    events: await import('../src/main/events.ts')
  }
  ;(await import('../src/main/attachments.ts')).setAttachmentsDir(join(TMP, 'attachments'))
  mods.mcp.initMcp('0.0.0')
  mods.runner.initRunner()
  return mods
}

after(async () => {
  if (mods) {
    mods.runner.shutdownRunner()
    await mods.mcp.shutdownMcp()
    ;(await import('../src/main/db.ts')).closeDb()
  }
  server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 10_000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(20)
  }
}

let providerId = ''
let fakeId = ''
async function setup(): Promise<Mods> {
  const m = await load()
  if (!providerId)
    providerId = m.repo.providersRepo.create({
      name: 'Falso',
      baseUrl: base,
      apiKey: 'k',
      headers: {}
    } as any).id
  if (!fakeId) {
    const s = m.store.mcpRepo.create({
      name: 'fake',
      title: 'Falso',
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: [FAKE],
        env: { FAKE_MCP_ERA: 'modern', FAKE_MCP_INSTRUCTIONS: 'Sempre diga oi.' }
      },
      approval: { mode: 'always', tools: { fail: 'ask' } }
    })
    m.store.mcpLocal.activate(s.id)
    fakeId = s.id
  }
  return m
}
async function newChat(
  extra: Record<string, unknown> = {}
): Promise<{ chatId: string; sid: string }> {
  const m = await setup()
  const { chat, session } = m.repo.chatsRepo.create({
    config: {
      providerId,
      model: MODEL,
      cwd: TMP,
      enabledTools: [],
      toolsCompact: false,
      mcpServers: { [fakeId]: { on: true } },
      ...extra
    } as any
  })
  return { chatId: chat.id, sid: session.id }
}
const path = (sid: string): any[] => mods!.repo.messagesRepo.path(sid)

async function turn(sid: string, text: string): Promise<any> {
  const before = path(sid).length
  mods!.runner.send(sid, text)
  await waitFor(
    () =>
      path(sid)
        .slice(before)
        .some((m) => m.message.role === 'assistant' && textOf(m.message.content).length > 0),
    15_000,
    'resposta final'
  )
  await waitFor(() => !mods!.runner.runningSessions().includes(sid), 15_000, 'sessão ociosa')
  return path(sid).slice(before)
}
const toolMsg = (msgs: any[]): any => msgs.find((m) => m.message.role === 'tool')
const lastToolsSent = (): string[] => (bodies.at(-1)?.tools ?? []).map((t: any) => t.function?.name)

test('request: tools do servidor ligado (completas), com a descrição e o esquema do servidor', async () => {
  const { sid } = await newChat()
  await turn(sid, 'oi')
  const names = lastToolsSent()
  assert.ok(names.includes('mcp__fake__echo'), names.join(','))
  assert.ok(names.includes('mcp__fake__ask'))
  const echo = bodies.at(-1).tools.find((t: any) => t.function.name === 'mcp__fake__echo')
  assert.equal(echo.function.description, 'Devolve o texto recebido. Use para testar a conexão.')
  assert.deepEqual(echo.function.parameters.required, ['text'])
  // instruções do servidor: desligadas por padrão
  assert.ok(!JSON.stringify(bodies.at(-1).messages[0]).includes('Sempre diga oi.'))
})

test('request: compactas por padrão (vão com a tool_search); instruções só quando ligadas', async () => {
  const { sid } = await newChat({
    toolsCompact: true,
    mcpServers: { [fakeId]: { on: true, instructions: true, off: ['big'] } }
  })
  await turn(sid, 'oi')
  const tools = bodies.at(-1).tools
  const echo = tools.find((t: any) => t.function.name === 'mcp__fake__echo')
  assert.deepEqual(echo.function.parameters, { type: 'object', properties: {} }, 'compacta')
  assert.ok(tools.some((t: any) => t.function.name === 'tool_search'))
  assert.ok(!tools.some((t: any) => t.function.name === 'mcp__fake__big'), 'tool desligada no chat')
  const sys = textOf(bodies.at(-1).messages[0].content)
  assert.ok(
    sys.includes(
      '<mcp_server_instructions server="fake">\nSempre diga oi.\n</mcp_server_instructions>'
    ),
    sys
  )
})

test('desligado no chat / não ativado aqui / subagente sem mcpSubagents: nada de MCP', async () => {
  const m = await setup()
  const { sid } = await newChat({ mcpServers: { [fakeId]: { on: false } } })
  await turn(sid, 'oi')
  assert.ok(!lastToolsSent().some((n) => n.startsWith('mcp__')))
  const { chatId } = await newChat()
  const chat = m.repo.chatsRepo.get(chatId)!
  assert.ok(m.request.availableTools(chat, { depth: 0 } as any).includes('mcp__fake__echo' as any))
  assert.ok(!m.request.availableTools(chat, { depth: 1 } as any).some((n) => n.startsWith('mcp__')))
  const sub = { ...chat, config: { ...chat.config, mcpSubagents: true } }
  assert.ok(m.request.availableTools(sub, { depth: 1 } as any).includes('mcp__fake__echo' as any))
  m.store.mcpLocal.deactivate(fakeId)
  try {
    assert.ok(
      !m.request.availableTools(chat, { depth: 0 } as any).some((n) => n.startsWith('mcp__'))
    )
  } finally {
    m.store.mcpLocal.activate(fakeId)
  }
})

test('sempre permitir: roda e o resultado volta como role tool', async () => {
  const { sid } = await newChat()
  const msgs = await turn(
    sid,
    `CALL ${JSON.stringify({ name: 'mcp__fake__echo', arguments: { text: 'olá' } })}`
  )
  const t = toolMsg(msgs)
  assert.equal(textOf(t.message.content), 'eco: olá')
  assert.equal(t.meta?.toolStatus ?? 'ok', 'ok')
})

test('imagem do servidor vira anexo por referência; isError vira erro', async () => {
  const { sid } = await newChat()
  const msgs = await turn(sid, `CALL ${JSON.stringify({ name: 'mcp__fake__image' })}`)
  const parts = toolMsg(msgs).message.content
  assert.ok(Array.isArray(parts), JSON.stringify(parts))
  const img = parts.find((p: any) => p.type === 'image_url')
  assert.match(img.image_url.url, /^clearchat-attachment:\/\//)
  assert.equal(img._attachment.mime, 'image/png')
})

test('perguntar (exceção da tool): card de aprovação → permitir roda; negar não roda', async () => {
  const m = await setup()
  const { sid } = await newChat()
  const before = path(sid).length
  m.runner.send(sid, `CALL ${JSON.stringify({ name: 'mcp__fake__fail' })}`)
  const req = await waitFor(
    () => m.approvals.listApprovals().find((a) => a.sessionId === sid),
    10_000,
    'pedido de aprovação'
  )
  assert.equal(req.toolName, 'mcp__fake__fail')
  m.approvals.resolveApproval(req.id, { kind: 'allow' } as any)
  await waitFor(() => toolMsg(path(sid).slice(before)), 10_000, 'resultado')
  const t = toolMsg(path(sid).slice(before))
  assert.equal(textOf(t.message.content), 'deu ruim de propósito')
  assert.equal(t.meta?.toolStatus, 'error')
  assert.equal(t.meta?.approval?.item, 'mcp')
  await waitFor(() => !m.runner.runningSessions().includes(sid), 10_000, 'ociosa')
  // negar
  const b2 = path(sid).length
  m.runner.send(sid, `CALL ${JSON.stringify({ name: 'mcp__fake__fail' })}`)
  const r2 = await waitFor(
    () => m.approvals.listApprovals().find((a) => a.sessionId === sid),
    10_000,
    'pedido 2'
  )
  m.approvals.resolveApproval(r2.id, { kind: 'deny' } as any)
  await waitFor(() => toolMsg(path(sid).slice(b2)), 10_000, 'resultado 2')
  assert.equal(toolMsg(path(sid).slice(b2)).meta?.toolStatus, 'denied')
  await waitFor(() => !m.runner.runningSessions().includes(sid), 10_000, 'ociosa 2')
})

test('elicitação: o formulário aparece no chat da tool e a resposta volta ao servidor', async () => {
  const m = await setup()
  const { chatId, sid } = await newChat()
  const seen: any[] = []
  const off = m.events.onAgentEvent((e: any) => {
    if (e.type === 'mcp-elicit') seen.push(e.request)
  })
  try {
    const before = path(sid).length
    m.runner.send(sid, `CALL ${JSON.stringify({ name: 'mcp__fake__ask' })}`)
    const req = await waitFor(() => seen[0], 10_000, 'formulário')
    assert.equal(req.chatId, chatId)
    assert.equal(req.sessionId, sid)
    assert.ok(req.toolCallId)
    assert.equal(req.serverLabel, 'Falso')
    assert.deepEqual(
      req.form.fields.map((f: any) => f.key),
      ['name', 'ok']
    )
    assert.deepEqual(
      m.mcp.pendingElicitations().map((p) => p.id),
      [req.id]
    )
    // campo obrigatório vazio: erro por campo, o pedido continua aberto
    const bad = m.mcp.answerElicitation(req.id, 'accept', { ok: true })
    assert.deepEqual(bad, { ok: false, errors: { name: 'Obrigatório.' } })
    assert.deepEqual(m.mcp.answerElicitation(req.id, 'accept', { name: 'Ana', ok: true }), {
      ok: true
    })
    await waitFor(() => toolMsg(path(sid).slice(before)), 10_000, 'resultado')
    assert.equal(textOf(toolMsg(path(sid).slice(before)).message.content), 'nome: Ana · ok: true')
    assert.deepEqual(m.mcp.pendingElicitations(), [])
    await waitFor(() => !m.runner.runningSessions().includes(sid), 10_000, 'ociosa')
  } finally {
    off()
  }
})
