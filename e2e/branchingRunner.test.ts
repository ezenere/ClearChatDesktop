/* eslint-disable @typescript-eslint/no-explicit-any */
// Ramificação da conversa — runner (WP2), sem Electron: módulo `electron` substituído por um stub,
// banco SQLite num diretório temporário e um provedor OpenAI-compatible FALSO em 127.0.0.1 (nenhuma
// key real, nenhum custo). Cobre: buildRequest no caminho ativo; regenerate = nova versão com a
// request byte a byte igual à do turno original; troca de versão muda a próxima request;
// editar = irmã (anexos/skills preservados) com a versão antiga intacta; troca recusada com a
// sessão ocupada; subagente em segundo plano da parte abandonada parado sem callback (e troca
// bloqueada enquanto ele roda); regenerate de erro substitui; `null` limpo ao parar; compactação
// num ramo (insertAt re-ligando) e edição acima da fronteira (caminho novo sem ela).
// Rodar: npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-branchrun-'))
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

// ---------------- provedor falso ----------------
// A 1ª palavra da última mensagem `user` decide; última mensagem `tool` → "FIM". Padrão: `R<n>`
// (n = nº da chamada, então cada resposta é diferente).

const MODEL = 'fake/agent'
let server: Server
let base = ''
/** Corpos crus (string exata enviada) e parseados, na ordem. */
const raw: string[] = []
const hits: any[] = []
const counters = new Map<string, number>()
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
      const text = await readBody(req)
      const body = JSON.parse(text || '{}')
      raw.push(text)
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      const key = textOf(lastUser?.content).trim().split(/\s+/)[0] || ''
      const n = (counters.get(key) ?? 0) + 1
      counters.set(key, n)
      const full = (t: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: t }))
        res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
      }
      /** Stream aberto até o cliente abortar (ou `ms`), depois termina normalmente. */
      const hold = (ms: number, t: string, opening = 'trabalhando… '): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: opening }))
        const timer = setTimeout(() => {
          if (res.writableEnded || res.destroyed) return
          res.write(chunk(body.model, { content: t }))
          res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
        }, ms)
        res.on('close', () => clearTimeout(timer))
      }
      if (last?.role === 'tool') return full(`FIM: ${textOf(last.content).slice(0, 40)}`)
      switch (key) {
        case 'lento':
          return hold(1500, 'LENTO OK')
        case 'mudo': // nada de conteúdo até o fim (Parar antes = nenhuma mensagem salva)
          return hold(800, 'MUDO OK', '')
        case 'falha':
          if (n === 1) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'pane no upstream' } }))
            return
          }
          return full('RECUPERADO')
        case 'delegue':
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(
            chunk(body.model, {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${hits.length}`,
                  type: 'function',
                  function: {
                    name: 'delegate_task',
                    arguments: JSON.stringify({ task: 'subtarefa lenta', background: true })
                  }
                }
              ]
            })
          )
          res.end(chunk(body.model, {}, 'tool_calls') + 'data: [DONE]\n\n')
          return
        case 'subtarefa':
          return hold(30_000, 'SUB OK')
        // delegate_task com esforço próprio do subagente (1.18.0): válido e inválido
        case 'delegue-leve':
        case 'delegue-ruim':
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(
            chunk(body.model, {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${hits.length}`,
                  type: 'function',
                  function: {
                    name: 'delegate_task',
                    arguments: JSON.stringify({
                      task: 'tarefa-leve rápida',
                      reasoning_effort: key === 'delegue-leve' ? 'low' : 'turbo'
                    })
                  }
                }
              ]
            })
          )
          res.end(chunk(body.model, {}, 'tool_calls') + 'data: [DONE]\n\n')
          return
        case 'tarefa-leve':
          return full('LEVE OK')
        default:
          return full(`R${hits.length}`)
      }
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

type Mods = {
  runner: typeof import('../src/main/agent/runner.ts')
  repo: typeof import('../src/main/repo.ts')
  events: typeof import('../src/main/events.ts')
  request: typeof import('../src/main/agent/request.ts')
  compaction: typeof import('../src/main/agent/compaction.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    runner: await import('../src/main/agent/runner.ts'),
    repo: await import('../src/main/repo.ts'),
    events: await import('../src/main/events.ts'),
    request: await import('../src/main/agent/request.ts'),
    compaction: await import('../src/main/agent/compaction.ts')
  }
  return mods
}

after(async () => {
  if (mods) {
    for (const sid of mods.runner.runningSessions()) await mods.runner.stop(sid).catch(() => {})
    ;(await import('../src/main/db.ts')).closeDb()
  }
  server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 8000,
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
async function newChat(enabledTools: string[] = []): Promise<{ chatId: string; sid: string }> {
  const { repo } = await load()
  if (!providerId)
    providerId = repo.providersRepo.create({
      name: 'Falso',
      baseUrl: base,
      apiKey: 'k',
      headers: {}
    } as any).id
  const { chat, session } = repo.chatsRepo.create({
    config: { providerId, model: MODEL, cwd: TMP, enabledTools: enabledTools as any }
  })
  return { chatId: chat.id, sid: session.id }
}

const st = (sid: string): any => mods!.repo.sessionsRepo.get(sid)!
const path = (sid: string): any[] => mods!.repo.messagesRepo.path(sid)
const all = (sid: string): any[] => mods!.repo.messagesRepo.listAll(sid)
const texts = (ms: any[]): string[] => ms.map((m) => textOf(m.message.content))
const idle = (sid: string): Promise<unknown> =>
  waitFor(() => !mods!.runner.isRunning(sid) && st(sid).status === 'idle', 10_000, 'idle')

/** Turno completo: envia e espera ociosa. */
async function turn(sid: string, text: string): Promise<void> {
  mods!.runner.send(sid, text)
  await sleep(30)
  await idle(sid)
}

// ---------------- request no caminho ativo ----------------

test('buildRequest(path): só o caminho ativo vai para a API (a outra versão fica de fora)', async () => {
  const { repo, request } = await load()
  const { chatId, sid } = await newChat()
  const M = repo.messagesRepo
  const u1 = M.append(sid, { role: 'user', content: 'pergunta 1' })
  M.append(sid, { role: 'assistant', content: 'resposta 1' })
  const u2 = M.append(sid, { role: 'user', content: 'pergunta 2 (original)' })
  M.append(sid, { role: 'assistant', content: 'resposta 2 (original)' })
  M.addSibling(u2.id, { role: 'user', content: 'pergunta 2 (editada)' })
  M.append(sid, { role: 'assistant', content: 'resposta 2 (editada)' })
  const chat = repo.chatsRepo.get(chatId)!
  const prov = repo.providersRepo.get(providerId)!
  const body = (): string =>
    JSON.stringify(
      request.buildRequest(chat, st(sid), M.path(sid), prov).body.messages.slice(1) // sem o system
    )
  const b = body()
  assert.ok(b.includes('pergunta 2 (editada)') && b.includes('resposta 2 (editada)'))
  assert.ok(!b.includes('(original)'), 'versão antiga fora da request')
  M.select(u2.id)
  const b2 = body()
  assert.ok(b2.includes('pergunta 2 (original)') && !b2.includes('(editada)'))
  assert.ok(b2.includes('pergunta 1'), 'tronco comum nas duas')
  assert.equal(u1.parentId, null)
})

// ---------------- regenerate / troca / edição ----------------

test('regenerate: nova versão (irmã), request idêntica byte a byte; troca muda a próxima request', async () => {
  const { runner, events } = await load()
  const { sid } = await newChat()
  await turn(sid, 'primeira')
  const n0 = raw.length
  await turn(sid, 'segunda')
  const original = raw[n0]
  const [, , u2, a2] = path(sid)
  assert.equal(textOf(u2.message.content), 'segunda')

  const seen: any[] = []
  const off = events.onAgentEvent((e) => seen.push(e))
  const n1 = raw.length
  await runner.regenerate(sid)
  await idle(sid)
  off()
  assert.equal(raw[n1], original, 'request do regenerate = a do turno original (mesmos bytes)')
  const p = path(sid)
  assert.equal(p.length, 4)
  const a2b = p[3]
  assert.notEqual(a2b.id, a2.id)
  assert.equal(a2b.parentId, u2.id, 'nova resposta = outro filho do prompt')
  assert.ok(
    all(sid).some((m) => m.id === a2.id),
    'versão antiga continua salva'
  )
  assert.deepEqual(st(sid).branchSel, {}, 'null limpo pela 1ª mensagem; a mais nova é o padrão')
  // session-updated com o null e depois sem ele
  const sels = seen
    .filter((e) => e.type === 'session-updated' && e.session.id === sid)
    .map((e) => e.session.branchSel)
  assert.ok(
    sels.some((s) => s[u2.id] === null),
    'null emitido'
  )
  assert.ok(
    sels.some((s) => !(u2.id in s)),
    'limpeza emitida'
  )

  // trocar para a versão antiga muda o histórico da próxima request
  const s = await runner.selectBranch(a2.id)
  assert.equal(s.branchSel?.[u2.id], a2.id)
  const n2 = raw.length
  await turn(sid, 'terceira')
  const sent = JSON.stringify(hits[n2].messages)
  assert.ok(sent.includes(textOf(a2.message.content)), 'versão escolhida vai')
  assert.ok(!sent.includes(textOf(a2b.message.content)), 'a outra não')
  // regenerar um turno ANTIGO (não o último) também cria versão; o resto vira a parte antiga
  const first = path(sid)[0]
  await runner.regenerate(sid, path(sid)[1].id)
  await idle(sid)
  const p2 = path(sid)
  assert.equal(p2.length, 2)
  assert.equal(p2[0].id, first.id)
  assert.ok(all(sid).length >= 8)
})

test('regenerate: Parar antes da 1ª mensagem limpa o null (volta à versão que existia)', async () => {
  const { runner } = await load()
  const { sid } = await newChat()
  await turn(sid, 'oi')
  await turn(sid, 'mudo por favor')
  const before = path(sid).map((m) => m.id)
  await runner.regenerate(sid)
  await waitFor(() => runner.isRunning(sid), 3000, 'rodando')
  const u = before[2]
  assert.equal(st(sid).branchSel[u], null, 'caminho termina no prompt enquanto a nova resposta vem')
  assert.deepEqual(
    path(sid).map((m) => m.id),
    before.slice(0, 3)
  )
  await sleep(100)
  await runner.stop(sid)
  await idle(sid)
  assert.deepEqual(st(sid).branchSel, {}, 'null limpo em finish')
  assert.deepEqual(
    path(sid).map((m) => m.id),
    before,
    'caminho volta à resposta que já existia'
  )
  assert.equal(all(sid).length, 4, 'nada novo salvo')
})

test('regenerate: Parar com parcial = a versão nova é a resposta interrompida', async () => {
  const { runner } = await load()
  const { sid } = await newChat()
  await turn(sid, 'lento por favor')
  const [u, a] = path(sid)
  await runner.regenerate(sid)
  await waitFor(() => runner.isRunning(sid), 3000, 'rodando')
  await waitFor(() => path(sid).length === 1 && hits.length > 0, 3000, 'caminho no prompt')
  await sleep(150)
  await runner.stop(sid)
  await idle(sid)
  const p = path(sid)
  assert.equal(p.length, 2)
  assert.equal(p[0].id, u.id)
  assert.notEqual(p[1].id, a.id)
  assert.equal(p[1].meta.interrupted, true)
  assert.deepEqual(st(sid).branchSel, {})
})

test('regenerate de erro: substitui (sem versão); messageId fora do caminho = erro', async () => {
  const { runner } = await load()
  const { sid } = await newChat()
  runner.send(sid, 'falha agora')
  await waitFor(() => st(sid).status === 'error', 8000, 'erro')
  const errId = path(sid).at(-1).id
  assert.equal(path(sid).at(-1).meta.kind, 'error')
  await runner.regenerate(sid, errId)
  await idle(sid)
  const p = path(sid)
  assert.deepEqual(texts(p), ['falha agora', 'RECUPERADO'])
  assert.ok(!all(sid).some((m) => m.id === errId), 'erro apagado, não guardado como versão')
  assert.equal(all(sid).length, 2)
  await assert.rejects(runner.regenerate(sid, 'nao-existe'), /versão ativa/)
})

test('editBranch: irmã com o texto novo (skills preservadas), versão antiga intacta; regras', async () => {
  const { runner, repo } = await load()
  const { sid, chatId } = await newChat()
  const skill = { type: 'text', text: '<skill name="x">corpo</skill>', _skill: { name: 'x' } }
  runner.send(sid, 'pergunta original', [], [skill as any])
  await sleep(30)
  await idle(sid)
  await turn(sid, 'continua')
  const [u1, a1] = path(sid)
  const n0 = raw.length
  await runner.editBranch(u1.id, { role: 'user', content: 'pergunta editada' })
  await idle(sid)
  const p = path(sid)
  assert.equal(p.length, 2)
  const u1b = p[0]
  assert.notEqual(u1b.id, u1.id)
  assert.equal(u1b.parentId, null, 'mesmo pai (raiz)')
  assert.deepEqual(u1b.meta, {})
  const parts = u1b.message.content
  assert.ok(Array.isArray(parts) && parts[0]._skill?.name === 'x', 'skill part mantido')
  assert.equal(parts.at(-1).text, 'pergunta editada')
  assert.ok(textOf(hits[n0].messages.at(-1).content).includes('pergunta editada'))
  assert.equal(all(sid).length, 6, 'versão antiga (u1 → a1 → u2 → a2) intacta')
  // a antiga continua alcançável
  await runner.selectBranch(u1.id)
  assert.deepEqual(
    path(sid)
      .map((m) => m.id)
      .slice(0, 2),
    [u1.id, a1.id]
  )
  // assistant / subsessão / sintética: não viram versão
  await assert.rejects(runner.editBranch(a1.id, { role: 'user', content: 'x' }), /digitadas/)
  const cb = repo.messagesRepo.append(
    sid,
    { role: 'user', content: '[Subagente…]' },
    { synthetic: true, kind: 'subagent-callback' }
  )
  await assert.rejects(runner.editBranch(cb.id, { role: 'user', content: 'x' }), /digitadas/)
  const sub = repo.sessionsRepo.create({
    chatId,
    parentSessionId: sid,
    parentToolCallId: null,
    depth: 1,
    model: MODEL,
    title: 's',
    task: 't',
    status: 'done'
  })
  const su = repo.messagesRepo.append(sub.id, { role: 'user', content: 'oi sub' })
  await assert.rejects(runner.editBranch(su.id, { role: 'user', content: 'x' }), /digitadas/)
})

test('selectBranch recusada com a sessão ocupada; liberada ao terminar', async () => {
  const { runner, repo } = await load()
  const { sid } = await newChat()
  await turn(sid, 'oi')
  const [u1] = path(sid)
  await runner.editBranch(u1.id, { role: 'user', content: 'lento agora' })
  await waitFor(() => runner.isRunning(sid), 3000, 'rodando')
  await assert.rejects(runner.selectBranch(u1.id), /Aguarde o agente terminar/)
  // status ocupado sem execução (ex.: card aberto em outro estado) também recusa
  await idle(sid)
  repo.sessionsRepo.setStatus(sid, 'awaiting_retry')
  await assert.rejects(runner.selectBranch(u1.id), /Aguarde/)
  repo.sessionsRepo.setStatus(sid, 'idle')
  const s = await runner.selectBranch(u1.id)
  assert.equal(s.branchSel?.root, u1.id)
  assert.equal(path(sid)[0].id, u1.id)
})

test('subagente em segundo plano: troca bloqueada enquanto roda; nova versão o para sem callback', async () => {
  const { runner, repo } = await load()
  const { sid, chatId } = await newChat(['delegate_task'])
  await turn(sid, 'oi')
  const [u1] = path(sid)
  await runner.editBranch(u1.id, { role: 'user', content: 'delegue algo' })
  await idle(sid) // a principal termina; o subagente segue rodando
  const child = await waitFor(
    () => repo.sessionsRepo.list(chatId).find((s) => s.parentSessionId === sid),
    3000,
    'subsessão'
  )
  await waitFor(() => runner.isRunning(child.id), 3000, 'subagente rodando')
  await assert.rejects(runner.selectBranch(u1.id), /subagente em segundo plano/)
  const u1b = path(sid)[0]
  // nova versão (editar a mesma mensagem de novo): a parte com o delegate sai → subagente parado
  await runner.editBranch(u1b.id, { role: 'user', content: 'deixa pra lá' })
  await idle(sid)
  await waitFor(() => !runner.isRunning(child.id), 6000, 'subagente parado')
  assert.equal(st(child.id).status, 'interrupted')
  await sleep(200)
  assert.ok(
    !all(sid).some((m) => m.meta.kind === 'subagent-callback'),
    'nenhum callback do subagente da versão abandonada'
  )
  assert.ok(repo.sessionsRepo.get(child.id), 'subsessão continua salva')
  // parado: trocar para a versão dele agora é permitido
  await runner.selectBranch(u1b.id)
  assert.equal(path(sid)[0].id, u1b.id)
})

test('delegate_task com reasoning_effort: só a request do subagente leva o esforço; gravado na tarefa; inválido = erro legível', async () => {
  const { repo } = await load()
  const { sid, chatId } = await newChat(['delegate_task'])
  const n0 = hits.length
  await turn(sid, 'delegue-leve agora')
  const reqs = hits.slice(n0)
  const sub = reqs.find((b) => textOf(b.messages?.at(-1)?.content).startsWith('tarefa-leve'))
  assert.ok(sub, 'request do subagente')
  assert.equal(sub.reasoning_effort, 'low', 'o esforço próprio do subagente')
  const mains = reqs.filter((b) => b !== sub)
  assert.ok(mains.length >= 1)
  assert.ok(
    mains.every((b) => b.reasoning_effort === undefined),
    'a sessão principal não muda'
  )
  const child = repo.sessionsRepo.list(chatId).find((s) => s.parentSessionId === sid)!
  const task = repo.messagesRepo.path(child.id)[0]
  assert.deepEqual(task.meta.delegate, { reasoningEffort: 'low' })
  // valor inválido: a tool volta com o erro (nenhum subagente novo)
  const before = repo.sessionsRepo.list(chatId).length
  await turn(sid, 'delegue-ruim agora')
  const tool = all(sid)
    .filter((m) => m.message.role === 'tool')
    .at(-1)!
  assert.match(
    textOf(tool.message.content),
    /reasoning_effort inválido — use um destes: none, minimal, low/
  )
  assert.equal(repo.sessionsRepo.list(chatId).length, before)
})

// ---------------- compactação e ramos ----------------

test('compactação num ramo: fronteira re-ligada (insertAt), a outra versão não é afetada', async () => {
  const { repo, compaction, request } = await load()
  const { chatId, sid } = await newChat()
  const M = repo.messagesRepo
  M.append(sid, { role: 'user', content: 'u1' })
  const a1 = M.append(sid, { role: 'assistant', content: 'a1' })
  const u2 = M.append(sid, { role: 'user', content: 'u2' })
  M.append(sid, { role: 'assistant', content: 'a2' })
  // nova versão de u2 ainda sem resposta (pendente) — e a seleção aponta para ela explicitamente
  const u2b = M.addSibling(u2.id, { role: 'user', content: 'u2 editada' })
  M.select(u2.id)
  M.select(u2b.id)
  M.append(sid, { role: 'assistant', content: 'a2b' })
  const u3 = M.append(sid, { role: 'user', content: 'u3 pendente' })
  repo.sessionsRepo.setBranchSel(sid, { [a1.id]: u2b.id }) // explícita (u2b já é a mais nova: some)
  const chat = repo.chatsRepo.get(chatId)!
  const hist = M.path(sid)
  const m = compaction.compactionMeta(chat, st(sid), hist, 'RESUMO', 10)
  assert.equal(m.insertBeforeSeq, u3.seq, 'fronteira antes da pendente do ramo')
  assert.deepEqual(m.summaryOf, { fromSeq: hist[0].seq, toSeq: hist[hist.length - 2].seq })
  const r = M.insertAt(
    sid,
    m.insertBeforeSeq!,
    { role: 'user', content: m.text },
    {
      synthetic: true,
      kind: 'compaction'
    }
  )
  const p = M.path(sid)
  assert.deepEqual(texts(p).slice(-2), [m.text, 'u3 pendente'])
  assert.equal(M.get(u3.id)!.parentId, r.message.id, 'pendente passou a ser filha da fronteira')
  // request a partir da fronteira (+ pendente)
  const prov = repo.providersRepo.get(providerId)!
  const msgs = request.buildRequest(chat, st(sid), p, prov).body.messages
  assert.deepEqual(
    msgs.slice(1).map((x: any) => textOf(x.content)),
    [m.text, 'u3 pendente']
  )
  // a versão antiga (u2 → a2) não tem fronteira
  M.select(u2.id)
  assert.deepEqual(texts(M.path(sid)), ['u1', 'a1', 'u2', 'a2'])
  assert.equal(r.selChanged, false, 'pendente era a mais nova: nada a mudar na seleção')

  // pendente numa versão MAIS ANTIGA (seleção explícita nela) → a seleção passa à fronteira
  const { sid: sid2 } = await newChat()
  M.append(sid2, { role: 'user', content: 'v1' })
  const b1 = M.append(sid2, { role: 'assistant', content: 'b1' })
  const x = M.append(sid2, { role: 'user', content: 'x pendente (antiga)' })
  M.addSibling(x.id, { role: 'user', content: 'y (mais nova)' })
  M.select(x.id)
  assert.equal(st(sid2).branchSel[b1.id], x.id)
  const h2 = M.path(sid2)
  const m2 = compaction.compactionMeta(chat, st(sid2), h2, 'R2', 5)
  assert.equal(m2.insertBeforeSeq, x.seq)
  const r2 = M.insertAt(
    sid2,
    m2.insertBeforeSeq!,
    { role: 'user', content: m2.text },
    {
      synthetic: true,
      kind: 'compaction'
    }
  )
  assert.equal(r2.selChanged, true)
  assert.equal(st(sid2).branchSel[b1.id], r2.message.id)
  assert.deepEqual(texts(M.path(sid2)), ['v1', 'b1', m2.text, 'x pendente (antiga)'])
})

test('compactação pelo runner num ramo editado + editar acima da fronteira = caminho sem ela', async () => {
  const { runner, repo } = await load()
  const { sid } = await newChat()
  await turn(sid, 'um')
  await turn(sid, 'dois')
  const u2 = path(sid)[2]
  await runner.editBranch(u2.id, { role: 'user', content: 'dois editado' })
  await idle(sid)
  runner.compact(sid)
  await sleep(30)
  await idle(sid)
  const p = path(sid)
  const b = p.at(-1)
  assert.equal(b.meta.kind, 'compaction', 'fronteira no fim do ramo ativo')
  assert.equal(b.parentId, p.at(-2).id)
  // versão antiga de "dois": sem fronteira
  await runner.selectBranch(u2.id)
  assert.ok(!path(sid).some((m) => m.meta.kind === 'compaction'))
  await runner.selectBranch(b.id)
  // continuar depois da fronteira: request começa nela
  let n = raw.length
  await turn(sid, 'tres')
  assert.match(textOf(hits[n].messages[1].content), /conversation_summary/)
  // editar "um" (acima da fronteira): o caminho novo volta às mensagens originais, sem resumo
  const u1 = path(sid)[0]
  n = raw.length
  await runner.editBranch(u1.id, { role: 'user', content: 'um reescrito' })
  await idle(sid)
  const sent = hits[n].messages.slice(1).map((x: any) => textOf(x.content))
  assert.deepEqual(sent, ['um reescrito'])
  assert.ok(!path(sid).some((m) => m.meta.kind === 'compaction'))
  assert.ok(
    repo.messagesRepo.listAll(sid).some((m) => m.id === b.id),
    'fronteira segue salva'
  )
})

test('inicialização: null de um regenerate interrompido (app fechado) é limpo só nas sessões que rodavam', async () => {
  const { runner, repo } = await load()
  const a = await newChat()
  const b = await newChat()
  for (const { sid } of [a, b]) {
    const u = repo.messagesRepo.append(sid, { role: 'user', content: 'p' })
    repo.messagesRepo.append(sid, { role: 'assistant', content: 'r' })
    repo.sessionsRepo.setBranchSel(sid, { [u.id]: null })
  }
  repo.sessionsRepo.setStatus(a.sid, 'running') // rodava aqui quando o app caiu
  // b: veio assim do sync (status gravado 'interrupted'): não é deste dispositivo → intocada
  repo.sessionsRepo.setStatus(b.sid, 'interrupted')
  runner.initRunner()
  assert.deepEqual(st(a.sid).branchSel, {})
  assert.equal(st(a.sid).status, 'interrupted')
  assert.equal(path(a.sid).length, 2)
  assert.ok(Object.values(st(b.sid).branchSel).includes(null))
})
