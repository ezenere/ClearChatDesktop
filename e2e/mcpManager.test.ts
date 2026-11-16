/* eslint-disable @typescript-eslint/no-explicit-any */
// Conectores (MCP): cadastro + estado do aparelho (src/main/mcp/store.ts) e conexões
// (src/main/mcp/manager.ts) contra o servidor MCP FALSO (e2e/fixtures/mcp-fake-server.mjs) por
// stdio (eras 2025 e 2026) e Streamable HTTP. userData temporário; nada de rede externa.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/mcpManager.test.ts
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-mcp-'))
process.env.CLEARCHAT_TEST_USERDATA = TMP
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export default { app }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

const FAKE = resolve(import.meta.dirname, 'fixtures/mcp-fake-server.mjs')
const { mcpRepo, mcpLocal } = await import('../src/main/mcp/store.ts')
const { mcpManager, configureMcpManager } = await import('../src/main/mcp/manager.ts')
const { startFakeMcpHttp } = await import('./fixtures/mcp-fake-server.mjs')

after(async () => {
  await mcpManager.closeAll()
  ;(await import('../src/main/db.ts')).closeDb()
  rmSync(TMP, { recursive: true, force: true })
})

const elicited: any[] = []
configureMcpManager({
  elicit: async (owner, server, params) => {
    elicited.push({ owner, server: server.name, message: params.message })
    return { action: 'accept', content: { name: 'Edu', ok: true } }
  }
})

const stdio = (era: string, log?: string): any => ({
  type: 'stdio',
  command: process.execPath,
  args: [FAKE],
  env: { FAKE_MCP_ERA: era, ...(log ? { FAKE_MCP_LOG: log } : {}), SEGREDO: 'abc' }
})
const owner = { chatId: 'c1', sessionId: 's1', toolCallId: 't1' }
const callText = async (id: string, tool: string, args: any = {}): Promise<string> => {
  const r: any = await mcpManager.callTool(id, tool, args, {
    signal: new AbortController().signal,
    owner
  })
  return r.content[0].text
}

test('cadastro: nome validado e único; atualizar; apagar leva o estado local junto', () => {
  assert.throws(() => mcpRepo.create({ name: 'Bad', transport: stdio('legacy') }), /minúsculas/)
  const a = mcpRepo.create({ name: 'tmp-a', transport: stdio('legacy') })
  assert.equal(a.approval.mode, 'ask')
  assert.match(a.id, /^mcp_/)
  assert.throws(() => mcpRepo.create({ name: 'tmp-a', transport: stdio('legacy') }), /Já existe/)
  const b = mcpRepo.update(a.id, { title: 'Temporário', approval: { mode: 'always' } })
  assert.equal(b.title, 'Temporário')
  assert.equal(mcpRepo.get(a.id)!.approval.mode, 'always')
  mcpLocal.activate(a.id)
  assert.ok(mcpLocal.get(a.id)?.activated)
  mcpRepo.delete(a.id)
  assert.equal(mcpRepo.get(a.id), null)
  assert.equal(mcpLocal.get(a.id), undefined)
})

test('stdio 2025: só depois de ativado; tools no cadastro; era lembrada (sem sondar de novo)', async () => {
  const log = join(TMP, 'legacy.log')
  const s = mcpRepo.create({ name: 'legacy', transport: stdio('legacy', log) })
  await assert.rejects(mcpManager.ensure(s.id), /não está ativado neste computador/)
  assert.equal(mcpManager.status(s.id).state, 'unavailable')
  mcpLocal.activate(s.id)
  await mcpManager.ensure(s.id)
  const st = mcpManager.status(s.id)
  assert.equal(st.state, 'ready')
  assert.equal(st.era, 'legacy')
  assert.ok((st.toolCount ?? 0) >= 5)
  const saved = mcpRepo.get(s.id)!
  assert.ok(saved.tools?.tools.some((t) => t.name === 'echo'))
  assert.equal(saved.tools?.server?.name, 'fake')
  assert.equal(mcpLocal.get(s.id)?.era, 'legacy')
  assert.equal(await callText(s.id, 'echo', { text: 'oi' }), 'eco: oi')
  assert.equal(await callText(s.id, 'env', { name: 'SEGREDO' }), 'abc', 'env do conector chega')
  // reconectar: a era já é conhecida → nada de server/discover
  writeFileSync(log, '')
  await mcpManager.reconnect(s.id)
  const methods = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).method)
  assert.ok(methods.includes('initialize'))
  assert.ok(!methods.includes('server/discover'), methods.join(','))
})

test('stdio 2026: era moderna, progresso, cancelamento e elicitação no chat que chamou', async () => {
  const s = mcpRepo.create({ name: 'modern', transport: stdio('modern') })
  mcpLocal.activate(s.id)
  await mcpManager.ensure(s.id)
  assert.equal(mcpManager.status(s.id).era, 'modern')
  assert.equal(mcpManager.status(s.id).protocolVersion, '2026-07-28')
  const prog: string[] = []
  const r: any = await mcpManager.callTool(
    s.id,
    'slow',
    { ms: 300 },
    {
      signal: new AbortController().signal,
      owner,
      onProgress: (m) => prog.push(m)
    }
  )
  assert.equal(r.content[0].text, 'terminou em 300 ms')
  // o SDK despacha notificações num microtask e a resposta na hora (e aí remove o handler de
  // progresso): um progresso que chega na MESMA leitura do pipe que o resultado (sob carga, o
  // "passo 3" e o resultado saem juntos) é descartado pelo SDK — os que chegam valem, em ordem
  const all = ['1/3 · passo 1', '2/3 · passo 2', '3/3 · passo 3']
  assert.ok(prog.length >= 1, 'nenhum progresso chegou')
  assert.deepEqual(prog, all.slice(0, prog.length))
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 100)
  const t0 = Date.now()
  await assert.rejects(
    mcpManager.callTool(s.id, 'slow', { ms: 5000 }, { signal: ac.signal, owner }),
    /abort/i
  )
  assert.ok(Date.now() - t0 < 1500)
  assert.equal(await callText(s.id, 'ask'), 'nome: Edu · ok: true')
  assert.deepEqual(elicited.at(-1), { owner, server: 'modern', message: 'Qual o seu nome?' })
})

test('comando mudou no cadastro (sync): indisponível até ativar de novo; conexão fechada', async () => {
  const s = mcpRepo.create({ name: 'changes', transport: stdio('legacy') })
  mcpLocal.activate(s.id)
  await mcpManager.ensure(s.id)
  mcpRepo.update(s.id, { transport: { ...stdio('legacy'), args: [FAKE, '--x'] } })
  await mcpManager.reconcile()
  assert.equal(mcpManager.liveTools(s.id), null, 'conexão fechada')
  assert.equal(mcpManager.status(s.id).unavailable, 'command-changed')
  await assert.rejects(mcpManager.ensure(s.id), /mudou: ative de novo/)
  mcpLocal.activate(s.id)
  await mcpManager.ensure(s.id)
  assert.equal(mcpManager.status(s.id).state, 'ready')
})

test('comando que não existe: erro legível no status', async () => {
  const s = mcpRepo.create({
    name: 'missing',
    transport: { type: 'stdio', command: 'clearchat-nao-existe-xyz', args: [], env: {} }
  })
  mcpLocal.activate(s.id)
  await assert.rejects(mcpManager.ensure(s.id), /comando não encontrado/)
  assert.equal(mcpManager.status(s.id).state, 'error')
})

test('HTTP 2025 e 2026: cabeçalhos fixos chegam; tools e chamada', async () => {
  for (const era of ['legacy', 'modern']) {
    const srv = await startFakeMcpHttp({ era })
    try {
      const s = mcpRepo.create({
        name: `http-${era}`,
        transport: { type: 'http', url: srv.url, headers: { 'X-Teste': 'sim' } }
      })
      await mcpManager.ensure(s.id)
      assert.equal(mcpManager.status(s.id).era, era)
      assert.equal(await callText(s.id, 'echo', { text: era }), `eco: ${era}`)
      assert.ok(srv.seen.requests.every((r: any) => r.headers['x-teste'] === 'sim'))
      await mcpManager.disconnect(s.id)
    } finally {
      await srv.close()
    }
  }
})

test('HTTP com OAuth exigido e sem login: estado "precisa entrar"', async () => {
  const srv = await startFakeMcpHttp({ era: 'modern', auth: true })
  try {
    const s = mcpRepo.create({
      name: 'needs-login',
      transport: { type: 'http', url: srv.url, headers: {} }
    })
    await assert.rejects(mcpManager.ensure(s.id))
    assert.equal(mcpManager.status(s.id).state, 'needs-auth')
  } finally {
    await srv.close()
  }
})
