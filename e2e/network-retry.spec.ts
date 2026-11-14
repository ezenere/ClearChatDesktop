/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do card "Falha de conexão com o provedor" na UI real (Playwright + `e2e/launch.ts`), determinístico:
// um provedor OpenAI-compatible FALSO em 127.0.0.1 corta a conexão no meio do stream.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/network-retry.spec.ts
//
// Cobre: "corte1 …" → 1ª chamada corta após um parcial, 2ª responde → card aparece no lugar do
// composer (status awaiting_retry, "Aguardando sua decisão (falha de conexão)") → Tentar de novo
// (Enter) → resposta completa, sem o parcial duplicado/persistido; "cortesempre …" → Cancelar (Esc)
// → erro persistido como antes; subagente: o card aparece na subsessão, o pai mostra "Subagente
// aguardando decisão" (card do delegate + chip no topo + ponto na sidebar), retry → resultado ao pai.
import type { ElectronApplication, Locator, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const AGENT = 'fake/agent-1'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-retry-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')

// ---------------- provedor falso ----------------

const hits: any[] = []
const counters = new Map<string, number>()
let server: Server | null = null
let fakeBase = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : ''
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              {
                id: AGENT,
                name: 'Fake Agent',
                context_length: 64_000,
                supported_parameters: ['tools']
              }
            ]
          })
        )
        return
      }
      if (!(req.method === 'POST' && url.endsWith('/chat/completions'))) {
        res.writeHead(404)
        res.end('{}')
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      const key = textOf(lastUser?.content).split(/\s+/)[0] || ''
      const n = (counters.get(key) ?? 0) + 1
      counters.set(key, n)
      const full = (text: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: text }))
        res.write(chunk(body.model, {}, 'stop'))
        res.end('data: [DONE]\n\n')
      }
      const cut = (): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: 'PARCIAL-QUE-SOME ' }))
        // dá tempo de o parcial aparecer na tela antes de cortar
        setTimeout(() => res.socket?.destroy(), 700)
      }
      if (last?.role === 'tool') return full(`FIM: ${textOf(last.content)}`)
      if (key === 'corte1') return n === 1 ? cut() : full('RESPOSTA COMPLETA DO MODELO')
      if (key === 'cortesempre') return cut()
      if (key === 'subtarefa') return n === 1 ? cut() : full('SUB OK')
      if (key === 'delegue') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(
          chunk(body.model, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now().toString(36)}`,
                type: 'function',
                function: {
                  name: 'delegate_task',
                  arguments: JSON.stringify({ task: 'subtarefa que perde a conexão', title: 'Sub' })
                }
              }
            ]
          })
        )
        res.write(chunk(body.model, {}, 'tool_calls'))
        res.end('data: [DONE]\n\n')
        return
      }
      full('OK, entendido.')
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let shotN = 0
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
}
async function read<T = any>(path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
    await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`).catch(() => {})
  }
}
const composer = (): Locator =>
  page.locator(
    'textarea[placeholder="Mensagem…"], textarea[placeholder="Enviar para a fila…"], textarea[placeholder="Mensagem ao subagente…"]'
  )
const card = (): Locator => page.getByTestId('retry-card')
async function chatState(): Promise<{ chat: any; session: any; msgs: any[]; sessions: any[] }> {
  const chat = (await read<any[]>('chats.list'))[0]
  const msgs = await read<any[]>('sessions.messages', chat.mainSessionId)
  const sessions = await read<any[]>('sessions.list', chat.id)
  const session = sessions.find((s) => s.id === chat.mainSessionId)
  return { chat, session, msgs, sessions }
}
async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
  what: string
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(120)
  }
}
async function sendMessage(text: string): Promise<void> {
  const c = composer()
  await c.click()
  await c.fill(text)
  await c.press('Enter')
}

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  await startFake()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  // não roubar o teclado do usuário (ver ask-user.spec.ts)
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setFocusable(false)
    w.blur()
  })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, CWD)

  await step('onboarding + novo chat', async () => {
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await page.getByTestId('onboarding-provider').click()
    await page.locator('input.field').nth(0).fill('Local')
    await page.locator('input.field').nth(1).fill(fakeBase)
    await page.locator('input[type="password"]').fill('fake-key')
    await page.getByRole('button', { name: 'Testar conexão' }).click()
    await page.getByText(/Conexão ok/).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
    await page.getByRole('combobox').first().click()
    await page.getByRole('textbox', { name: 'Buscar modelo' }).fill(AGENT)
    await page.locator(`[role=option][data-model="${AGENT}"]`).first().click()
    await page.getByRole('button', { name: /Alterar/ }).click()
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 15_000 })
  })

  await step(
    'conexão cai no meio do stream → card; Tentar de novo → resposta completa',
    async () => {
      await sendMessage('corte1 explique algo')
      // o parcial aparece por streaming…
      await page.getByText('PARCIAL-QUE-SOME').first().waitFor({ timeout: 10_000 })
      // …e some quando o card abre
      await card().waitFor({ timeout: 15_000 })
      await page.getByText('Falha de conexão com o provedor').first().waitFor()
      await page.getByText('Aguardando sua decisão (falha de conexão)').waitFor()
      assert((await composer().count()) === 0, 'textarea do composer some')
      assert((await page.getByText('PARCIAL-QUE-SOME').count()) === 0, 'parcial descartado na tela')
      const { session, msgs } = await chatState()
      assert(session.status === 'awaiting_retry', `status ${session.status}`)
      assert(!msgs.some((m) => m.message.role === 'assistant'), 'nenhum assistant persistido')
      const err = await page.getByTestId('retry-error').innerText()
      assert(/terminated|other side closed|fetch failed/i.test(err), `erro curto: ${err}`)
      await shot('card-falha-conexao')
      // Enter = Tentar de novo (foco no botão)
      await card()
        .getByRole('button', { name: /Tentar de novo/ })
        .press('Enter')
      await card().waitFor({ state: 'detached', timeout: 10_000 })
      await page.getByText('RESPOSTA COMPLETA DO MODELO').waitFor({ timeout: 10_000 })
      await composer().waitFor()
      const s = await waitFor(
        async () => {
          const st = await chatState()
          return st.session.status === 'idle' ? st : null
        },
        10_000,
        'idle'
      )
      const assistants = s.msgs.filter((m) => m.message.role === 'assistant')
      assert(assistants.length === 1, `assistants: ${assistants.length}`)
      assert(assistants[0].message.content === 'RESPOSTA COMPLETA DO MODELO', 'conteúdo')
      assert((await page.getByText('PARCIAL-QUE-SOME').count()) === 0, 'sem parcial duplicado')
      await shot('depois-do-retry')
    }
  )

  await step('Cancelar (Esc) → turno termina como erro, sem nova chamada', async () => {
    await sendMessage('cortesempre de novo')
    await card().waitFor({ timeout: 15_000 })
    const before = hits.length
    await card()
      .getByRole('button', { name: /Tentar de novo/ })
      .press('Escape')
    await card().waitFor({ state: 'detached', timeout: 10_000 })
    await composer().waitFor()
    await sleep(500)
    assert(hits.length === before, `chamadas após cancelar: ${hits.length - before}`)
    const { session, msgs } = await chatState()
    assert(session.status === 'error', `status ${session.status}`)
    const last = msgs.at(-1)
    assert(last.meta.kind === 'error' && /terminated|closed/i.test(last.meta.error), 'erro')
    await shot('cancelado')
  })

  await step('Parar (quadrado) com o card aberto = Cancelar', async () => {
    await sendMessage('cortesempre outra vez')
    await card().waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Parar', exact: true }).click()
    await card().waitFor({ state: 'detached', timeout: 10_000 })
    const { session, msgs } = await chatState()
    assert(session.status === 'error', `status ${session.status}`)
    assert(msgs.at(-1).meta.kind === 'error', 'erro persistido')
  })

  await step(
    'subagente: card na subsessão; pai mostra a pendência; retry → resultado',
    async () => {
      const { chat } = await chatState()
      await read('chats.update', chat.id, {
        config: { enabledTools: [...chat.config.enabledTools, 'delegate_task'] }
      })
      await sendMessage('delegue uma subtarefa')
      // no chat (principal): card do delegate avisa + chip no topo
      await page.getByTestId('sub-retry').waitFor({ timeout: 15_000 })
      await page.getByTestId('retry-indicator').getByText('Subagente aguardando decisão').waitFor()
      assert((await card().count()) === 0, 'card não aparece na principal')
      const st = await chatState()
      assert(st.session.status === 'running', `pai: ${st.session.status}`)
      const sub = st.sessions.find((s) => s.depth === 1)
      assert(sub?.status === 'awaiting_retry', `sub: ${sub?.status}`)
      await shot('pai-subagente-aguardando')
      // vai para a subsessão pelo chip
      await page.getByTestId('retry-indicator').click()
      await card().waitFor({ timeout: 10_000 })
      await shot('subsessao-card')
      await card()
        .getByRole('button', { name: /Tentar de novo/ })
        .click()
      await card().waitFor({ state: 'detached', timeout: 10_000 })
      const done = await waitFor(
        async () => {
          const s = await chatState()
          return s.session.status === 'idle' ? s : null
        },
        15_000,
        'pai idle'
      )
      const tool = done.msgs.find((m) => m.message.role === 'tool')
      assert(tool?.message.content === 'SUB OK', `resultado do delegate: ${tool?.message.content}`)
      assert(done.msgs.at(-1).message.content === 'FIM: SUB OK', 'resposta final do pai')
    }
  )

  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${results.length - failed.length}/${results.length} passos ok · screenshots em ${SHOTS}`
  )
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
