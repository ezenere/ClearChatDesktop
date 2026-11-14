/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da ramificação da conversa no app real (Playwright + `e2e/launch.ts`, chamando window.api pelo
// renderer — IPC + runner + banco de verdade), 100% determinístico: provedor OpenAI-compatible
// FALSO em 127.0.0.1 (nenhuma key real, nenhum custo).
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/branching.spec.ts [filtro]
//
// Cobre: editar mensagem digitada = nova versão (a antiga fica; messages.update recusa);
// regenerate = irmã da resposta; trocar de versão muda o corpo da próxima request; trocar com o
// agente rodando é recusado; subagente em segundo plano da versão abandonada é parado sem
// callback; regenerate depois de um erro substitui o erro; eventos session-updated com branchSel.
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { activePath } from '../src/shared/branches.ts'

const AGENT = 'fake/agent'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-branching-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const FILTER = process.argv[2] ?? ''

// ---------------- provedor falso ----------------
// 1ª palavra da última mensagem user decide; última `tool` → "FIM". Padrão: `R<n>` (n = nº da chamada).

const hits: any[] = []
const raw: string[] = []
const counters = new Map<string, number>()
let server: Server | null = null
let fakeBase = ''
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: AGENT, context_length: 64_000, supported_parameters: ['tools'] }]
          })
        )
        return
      }
      const text = await readBody(req)
      const body = JSON.parse(text || '{}')
      hits.push(body)
      raw.push(text)
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const key =
        textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
          .trim()
          .split(/\s+/)[0] ?? ''
      const n = (counters.get(key) ?? 0) + 1
      counters.set(key, n)
      const chunk = (delta: any, finish?: string): string =>
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 80, completion_tokens: 6 } } : {}) })}\n\n`
      const full = (t: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(chunk({ role: 'assistant', content: t }))
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
      }
      const hold = (ms: number, t: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write(chunk({ role: 'assistant', content: 'trabalhando… ' }))
        const timer = setTimeout(() => {
          if (res.writableEnded || res.destroyed) return
          res.write(chunk({ content: t }))
          res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
        }, ms)
        res.on('close', () => clearTimeout(timer))
      }
      if (last?.role === 'tool') return full(`FIM: ${textOf(last.content).slice(0, 40)}`)
      switch (key) {
        case 'lento':
          return hold(2500, 'LENTO OK')
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
            chunk({
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
          res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
          return
        case 'subtarefa':
          return hold(60_000, 'SUB OK')
        default:
          return full(`R${hits.length}`)
      }
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  await page.evaluate(() => {
    const w = window as any
    w.__ev = []
    w.api.onEvent((e: unknown) => w.__ev.push(e))
  })
}

async function api<T = any>(path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}

async function apiErr(path: string, ...args: unknown[]): Promise<string> {
  try {
    await api(path, ...args)
    return ''
  } catch (e) {
    return (e as Error).message
  }
}

const events = (): Promise<any[]> => page.evaluate(() => (window as any).__ev)
const clearEvents = (): Promise<unknown> => page.evaluate(() => ((window as any).__ev = []))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
  what: string
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando: ${what}`)
    await sleep(100)
  }
}

async function sessionOf(chatId: string, sid: string): Promise<any> {
  return (await api<any[]>('sessions.list', chatId)).find((x) => x.id === sid)
}

async function waitStatus(chatId: string, sid: string, status = 'idle'): Promise<void> {
  await sleep(150)
  await waitFor(
    async () => {
      if ((await api<string[]>('agent.runningSessions')).includes(sid)) return null
      return (await sessionOf(chatId, sid))?.status === status
    },
    20_000,
    `sessão ${status}`
  )
}

const all = (sid: string): Promise<any[]> => api<any[]>('sessions.messages', sid)
async function path(chatId: string, sid: string): Promise<any[]> {
  const s = await sessionOf(chatId, sid)
  return activePath(await all(sid), s?.branchSel ?? {})
}
const texts = (ms: any[]): string[] => ms.map((m) => textOf(m.message.content))

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (FILTER && !FILTER.split(',').some((f) => name.includes(f.trim()))) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
  }
}

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  await startFake()
  await launch()

  let providerId = ''
  const newChat = async (enabledTools: string[] = []): Promise<{ chatId: string; sid: string }> => {
    const c = await api('chats.create', {
      config: { providerId, model: AGENT, cwd: CWD, enabledTools }
    })
    return { chatId: c.id, sid: c.mainSessionId }
  }
  const turn = async (chatId: string, sid: string, text: string): Promise<void> => {
    await api('agent.send', sid, text)
    await waitStatus(chatId, sid)
  }

  await step('setup: provedor falso', async () => {
    providerId = (await api('providers.create', { name: 'Local', baseUrl: fakeBase, apiKey: 'k' }))
      .id
    assert(providerId, 'provedor')
  })

  await step('editar = nova versão: a antiga fica; messages.update recusa a digitada', async () => {
    const { chatId, sid } = await newChat()
    await turn(chatId, sid, 'pergunta original')
    await turn(chatId, sid, 'segunda')
    const [u1, a1] = await path(chatId, sid)
    const refused = await apiErr('messages.update', u1.id, { role: 'user', content: 'x' })
    assert(/nova versão/.test(refused), `messages.update recusado: ${refused}`)
    // assistant continua editável no lugar
    const up = await api('messages.update', a1.id, { role: 'assistant', content: 'a1 editada' })
    assert(up.message.content === 'a1 editada', 'assistant editada no lugar')
    await clearEvents()
    const n0 = hits.length
    await api('agent.editBranch', u1.id, { role: 'user', content: 'pergunta nova' })
    await waitStatus(chatId, sid)
    const p = await path(chatId, sid)
    assert(p.length === 2 && textOf(p[0].message.content) === 'pergunta nova', 'caminho novo')
    assert(p[0].parentId === null && p[0].id !== u1.id, 'irmã na raiz')
    assert((await all(sid)).length === 6, 'versão antiga inteira continua salva')
    assert(
      textOf(hits[n0].messages.at(-1).content) === 'pergunta nova' &&
        hits[n0].messages.length === 2,
      'request só com a versão nova'
    )
    const ev = await events()
    assert(
      ev.some(
        (e) => e.type === 'message-added' && e.message.id === p[0].id && e.message.parentId === null
      ),
      'message-added com parentId'
    )
    assert(
      ev.some((e) => e.type === 'session-updated' && e.session.id === sid),
      'session-updated'
    )
  })

  await step('regenerate = irmã; trocar de versão muda a próxima request', async () => {
    const { chatId, sid } = await newChat()
    await turn(chatId, sid, 'oi')
    const [u, a] = await path(chatId, sid)
    const n0 = raw.length
    await clearEvents()
    await api('agent.regenerate', sid, a.id)
    await waitStatus(chatId, sid)
    const p = await path(chatId, sid)
    assert(p.length === 2 && p[1].id !== a.id && p[1].parentId === u.id, 'nova resposta irmã')
    assert(raw[n0] === raw[n0 - 1], 'request do regenerate idêntica à original (bytes)')
    const sels = (await events())
      .filter((e) => e.type === 'session-updated' && e.session.id === sid)
      .map((e) => e.session.branchSel)
    assert(
      sels.some((s) => s[u.id] === null) && sels.at(-1)[u.id] === undefined,
      'null emitido e limpo'
    )
    const s = await api('agent.selectBranch', a.id)
    assert(s.branchSel[u.id] === a.id, 'selectBranch devolve a sessão')
    const n1 = hits.length
    await turn(chatId, sid, 'continua')
    const sent = JSON.stringify(hits[n1].messages)
    assert(
      sent.includes(textOf(a.message.content)) && !sent.includes(textOf(p[1].message.content)),
      'próxima request usa a versão escolhida'
    )
  })

  await step('trocar com o agente rodando é recusado', async () => {
    const { chatId, sid } = await newChat()
    await turn(chatId, sid, 'oi')
    const [u] = await path(chatId, sid)
    await api('agent.editBranch', u.id, { role: 'user', content: 'lento agora' })
    await waitFor(
      async () => (await api<string[]>('agent.runningSessions')).includes(sid),
      5000,
      'rodando'
    )
    const err = await apiErr('agent.selectBranch', u.id)
    assert(/Aguarde o agente terminar/.test(err), `recusado: ${err}`)
    await waitStatus(chatId, sid)
    await api('agent.selectBranch', u.id)
    assert((await path(chatId, sid))[0].id === u.id, 'liberado ao terminar')
  })

  await step('subagente em segundo plano da versão abandonada: parado sem callback', async () => {
    const { chatId, sid } = await newChat(['delegate_task'])
    await turn(chatId, sid, 'oi')
    const [u] = await path(chatId, sid)
    await api('agent.editBranch', u.id, { role: 'user', content: 'delegue isto' })
    await waitStatus(chatId, sid)
    const child = await waitFor(
      async () => (await api<any[]>('sessions.list', chatId)).find((s) => s.depth === 1),
      5000,
      'subsessão'
    )
    await waitFor(
      async () => (await api<string[]>('agent.runningSessions')).includes(child.id),
      5000,
      'subagente rodando'
    )
    const blocked = await apiErr('agent.selectBranch', u.id)
    assert(/subagente em segundo plano/.test(blocked), `troca bloqueada: ${blocked}`)
    const ub = (await path(chatId, sid))[0]
    // nova versão (editar de novo): a parte com o delegate sai do caminho
    await api('agent.editBranch', ub.id, { role: 'user', content: 'deixa pra lá' })
    await waitStatus(chatId, sid)
    await waitFor(
      async () => (await sessionOf(chatId, child.id))?.status === 'interrupted',
      8000,
      'subagente parado'
    )
    await sleep(300)
    assert(
      !(await all(sid)).some((m) => m.meta.kind === 'subagent-callback'),
      'sem callback do subagente parado'
    )
    assert(await sessionOf(chatId, child.id), 'subsessão continua salva')
  })

  await step('regenerate depois de um erro substitui o erro', async () => {
    const { chatId, sid } = await newChat()
    await api('agent.send', sid, 'falha agora')
    await waitStatus(chatId, sid, 'error')
    const p0 = await path(chatId, sid)
    const err = p0.at(-1)
    assert(err.meta.kind === 'error', 'erro persistido')
    await api('agent.regenerate', sid)
    await waitStatus(chatId, sid)
    assert(
      JSON.stringify(texts(await path(chatId, sid))) ===
        JSON.stringify(['falha agora', 'RECUPERADO']),
      'resposta nova no lugar do erro'
    )
    assert(!(await all(sid)).some((m) => m.id === err.id), 'erro apagado (não é versão)')
  })

  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} passos ok`)
  await app.close().catch(() => {})
  server?.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await app?.close().catch(() => {})
  server?.close()
  process.exit(1)
})
