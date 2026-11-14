/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da fila de aprovações acima do composer + destaques da sidebar (Playwright + `e2e/launch.ts`),
// determinístico: provedor OpenAI-compatible FALSO em 127.0.0.1, nenhuma key real.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/approval-queue.spec.ts
//
// Cobre: 3 subagentes em segundo plano pedem shell ao mesmo tempo; a resposta longa do pai empurra
// os cards "Delegar a subagente" para fora da tela → fila acima do composer "1 de 3" (sem duplicar
// nos cards); outro chat aberto → item do chat âmbar na sidebar + indicador do topo; volta → fila;
// aprova em sequência (o contador anda) → os 3 executam; card do delegate visível → aprovação só no
// card (sem fila); subagente que morre com erro com outro chat aberto → item vermelho; ao abrir:
// vermelho some da sidebar, aviso vermelho acima do composer (card fora da tela) → dispensar.
import type { ElectronApplication, Locator, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const AGENT = 'fake/agent-1'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-queue-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')

// ---------------- provedor falso ----------------

let server: Server | null = null
let fakeBase = ''
let callSeq = 0

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : ''
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
const LONG = Array.from(
  { length: 14 },
  (_, i) =>
    `Parágrafo ${i + 1} enquanto os subagentes trabalham: texto longo de propósito para empurrar os cards de delegação para fora da área visível da conversa.`
).join('\n\n')

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              { id: AGENT, name: 'Fake', context_length: 64_000, supported_parameters: ['tools'] }
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
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const users = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content))
      const lastUser = users.at(-1) ?? ''
      const full = (text: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: text }))
        res.write(chunk(body.model, {}, 'stop'))
        res.end('data: [DONE]\n\n')
      }
      const tools = (calls: { name: string; args: any }[]): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(
          chunk(body.model, {
            role: 'assistant',
            tool_calls: calls.map((c, index) => ({
              index,
              id: `call_${++callSeq}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) }
            }))
          })
        )
        res.write(chunk(body.model, {}, 'tool_calls'))
        res.end('data: [DONE]\n\n')
      }
      const delegate = (title: string, task: string): { name: string; args: any } => ({
        name: 'delegate_task',
        args: { title, task, background: true }
      })
      // subagente: "rode: <cmd>" → shell; resultado → FIM; "falhe" → erro HTTP do provider
      if (/^rode: /.test(users[0] ?? '')) {
        if (last?.role === 'tool') return full(`FIM: ${textOf(last.content).slice(0, 60)}`)
        if (last?.role === 'user' && /^rode: /.test(lastUser))
          return tools([{ name: 'shell', args: { command: lastUser.slice(6) } }])
      }
      if (/^falhe/.test(users[0] ?? '')) {
        setTimeout(() => {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ error: { message: 'Modelo recusou a tarefa (falha simulada)' } })
          )
        }, 2500)
        return
      }
      // principal
      if (last?.role === 'user' && lastUser.startsWith('[Subagente')) return full('Recebido.')
      if (last?.role === 'tool') {
        const key = [...users].reverse().find((u) => u.startsWith('delegue')) ?? ''
        return full(key.startsWith('delegue1') ? 'Delegado.' : LONG)
      }
      if (lastUser.startsWith('delegue3'))
        return tools([
          delegate('Sub-A', 'rode: expr SUB-A'),
          delegate('Sub-B', 'rode: expr SUB-B'),
          delegate('Sub-C', 'rode: expr SUB-C')
        ])
      if (lastUser.startsWith('delegue1')) return tools([delegate('Sub-V', 'rode: expr SUB-V')])
      if (lastUser.startsWith('delegue-falha'))
        return tools([delegate('Sub-X', 'falhe agora, por favor')])
      full('OK.')
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
const composer = (): Locator =>
  page.locator('textarea[placeholder="Mensagem…"], textarea[placeholder="Enviar para a fila…"]')
const queue = (): Locator => page.getByTestId('approval-queue')
const delegateCards = (): Locator => page.getByTestId('delegate-card')
const chatItem = (title: RegExp): Locator =>
  page.getByTestId('chat-item').filter({ hasText: title })
async function sendMessage(text: string): Promise<void> {
  const c = composer()
  await c.click()
  await c.fill(text)
  await c.press('Enter')
}
let chat1Id = ''
async function pending(): Promise<any[]> {
  return (await read<any[]>('agent.pendingApprovals')).filter((a) => a.chatId === chat1Id)
}
async function subs(): Promise<any[]> {
  return (await read<any[]>('sessions.list', chat1Id)).filter((s) => s.depth > 0)
}
async function newChat(): Promise<void> {
  await page.getByRole('button', { name: 'Novo chat' }).first().click()
  await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 10_000 })
  await page.getByRole('combobox').first().click()
  await page.getByRole('textbox', { name: 'Buscar modelo' }).fill(AGENT)
  await page.locator(`[role=option][data-model="${AGENT}"]`).first().click()
  await page.getByRole('button', { name: 'Começar' }).click()
  await composer().waitFor({ timeout: 15_000 })
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
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860))
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setFocusable(false)
    w.blur()
  })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, CWD)

  await step('onboarding + chat com delegate_task', async () => {
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
    const chat = (await read<any[]>('chats.list'))[0]
    chat1Id = chat.id
    await read('chats.update', chat.id, {
      config: { enabledTools: [...new Set([...chat.config.enabledTools, 'delegate_task'])] }
    })
  })

  await step('3 subagentes pedem aprovação; cards fora da tela → fila "1 de 3"', async () => {
    await sendMessage('delegue3 tarefas em paralelo')
    await waitFor(async () => (await pending()).length === 3, 20_000, '3 aprovações')
    await page.getByText('Parágrafo 14').waitFor({ timeout: 10_000 })
    await queue().waitFor({ timeout: 10_000 })
    const count = await page.getByTestId('approval-queue-count').innerText()
    assert(count === '1 de 3', `contador: ${count}`)
    const who = await page.getByTestId('approval-queue-who').innerText()
    assert(/Subagente “Sub-A”/.test(who), `identificação: ${who}`)
    await queue().getByText('expr SUB-A').waitFor()
    await queue().getByRole('button', { name: 'Abrir subsessão' }).waitFor()
    // sem duplicar: nenhum card de aprovação dentro dos cards do delegate (fora da tela)
    const inCards = await delegateCards().getByTestId('approval-card').count()
    assert(inCards === 0, `cards de aprovação nos delegates: ${inCards}`)
    assert((await page.getByTestId('approval-card').count()) === 1, 'só o card da fila')
    await shot('fila-1-de-3')
  })

  await step('outro chat aberto → chat âmbar na sidebar + indicador do topo', async () => {
    await newChat()
    const item = chatItem(/delegue3/)
    await item.waitFor()
    assert((await item.getAttribute('data-approval')) === 'true', 'item âmbar')
    await item.getByTestId('chat-awaiting-approval').waitFor()
    const ind = await page.getByTestId('approval-indicator').innerText()
    assert(/3 aprovações pendentes/.test(ind), `indicador: ${ind}`)
    await shot('sidebar-ambar')
    await item.click()
    await queue().waitFor({ timeout: 10_000 })
    assert(
      (await page.getByTestId('approval-indicator').count()) === 0,
      'indicador do topo só para outros chats'
    )
  })

  await step('aprovar em sequência → contador anda → os 3 executam', async () => {
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      seen.push(
        (await page.getByTestId('approval-queue-count').count())
          ? await page.getByTestId('approval-queue-count').innerText()
          : '(único)'
      )
      if (i === 1) await shot('fila-2-de-3')
      const n = (await pending()).length
      await queue().getByRole('button', { name: 'Sim', exact: true }).click()
      await waitFor(async () => (await pending()).length === n - 1, 10_000, `aprovação ${i + 1}`)
    }
    await queue().waitFor({ state: 'detached', timeout: 5000 })
    assert(seen.join('|') === '1 de 3|1 de 2|(único)', `sequência: ${seen.join('|')}`)
    const done = await waitFor(
      async () => {
        const s = await subs()
        return s.length === 3 && s.every((x) => x.status === 'done') ? s : null
      },
      20_000,
      'subagentes concluídos'
    )
    for (const s of done) {
      const msgs = await read<any[]>('sessions.messages', s.id)
      const tool = msgs.find((m) => m.message.role === 'tool')
      assert(
        tool?.meta.toolStatus === 'ok' && /SUB-[ABC]/.test(tool.message.content),
        `${s.title}: ${tool?.message.content}`
      )
    }
    await page.getByText('Recebido.').first().waitFor({ timeout: 15_000 })
    await shot('todos-executaram')
  })

  await step('card do delegate visível → aprovação só no card (sem fila)', async () => {
    await waitFor(
      async () => {
        const st = await read<any[]>('sessions.list', chat1Id)
        return st.every((s) => s.status !== 'running') ? st : null
      },
      20_000,
      'ocioso'
    )
    // conversa no fim (como o usuário a deixaria depois de mandar a mensagem)
    await page.evaluate(() => {
      const el = document.querySelector('.absolute.inset-0.overflow-y-auto')!
      el.scrollTop = el.scrollHeight
    })
    await sleep(300)
    await sendMessage('delegue1 curto')
    await waitFor(async () => (await pending()).length === 1, 20_000, '1 aprovação')
    await page.getByText('Delegado.').waitFor({ timeout: 10_000 })
    const card = delegateCards().filter({ hasText: 'Sub-V' })
    await card.getByTestId('approval-card').waitFor({ timeout: 5000 })
    await sleep(400)
    assert((await queue().count()) === 0, 'sem fila com o card visível')
    await shot('aprovacao-no-card-visivel')
    // rola para cima (card sai da tela) → vai para a fila; volta → card de novo
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.overflow-y-auto')) el.scrollTop = 0
    })
    await queue().waitFor({ timeout: 5000 })
    assert((await card.getByTestId('approval-card').count()) === 0, 'saiu do card')
    await shot('card-rolado-para-fora-fila')
    await card.scrollIntoViewIfNeeded()
    await queue().waitFor({ state: 'detached', timeout: 5000 })
    await card.getByRole('button', { name: 'Sim', exact: true }).click()
    await waitFor(async () => (await pending()).length === 0, 10_000, 'aprovada')
  })

  await step(
    'subagente morre com outro chat aberto → vermelho; abrir → aviso; dispensar',
    async () => {
      await waitFor(
        async () => {
          const st = await read<any[]>('sessions.list', chat1Id)
          return st.every((s) => s.status !== 'running') ? st : null
        },
        20_000,
        'ocioso'
      )
      await sendMessage('delegue-falha uma tarefa')
      await page.getByText('Parágrafo 14').last().waitFor({ timeout: 10_000 })
      // abre outro chat antes de o subagente falhar (o provedor responde o erro após 2,5 s)
      await chatItem(/Novo chat/)
        .first()
        .click()
      const item = chatItem(/delegue3/)
      await waitFor(
        async () => (await item.getAttribute('data-failed')) === 'true',
        15_000,
        'item vermelho'
      )
      await item.getByTestId('chat-sub-failed').waitFor()
      const sx = (await subs()).find((s) => s.title === 'Sub-X')
      assert(sx?.status === 'error', `Sub-X: ${sx?.status}`)
      await shot('sidebar-vermelho')
      await item.click()
      await page.getByTestId('sub-failure-notice').waitFor({ timeout: 10_000 })
      const txt = await page.getByTestId('sub-failure-notice').innerText()
      assert(/Sub-X/.test(txt) && /falha simulada|recusou/i.test(txt), `aviso: ${txt}`)
      assert((await item.getAttribute('data-failed')) === null, 'vermelho some ao abrir o chat')
      await shot('aviso-vermelho-composer')
      await page.getByRole('button', { name: 'Dispensar aviso' }).click()
      await page.getByTestId('sub-failure-notice').waitFor({ state: 'detached', timeout: 3000 })
      // o card do delegate continua mostrando a falha
      await delegateCards()
        .filter({ hasText: 'Sub-X' })
        .getByTestId('sub-failed')
        .waitFor({ timeout: 3000 })
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
