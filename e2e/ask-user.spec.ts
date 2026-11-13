/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do questionário (tool ask_user) na UI real (Playwright `_electron`), determinístico: um
// provedor OpenAI-compatible FALSO servido pelo teste em 127.0.0.1 faz o papel do agente
// (`fake/agent-1`: mensagem "pergunte" → chama ask_user; resultado de tool → "FIM: …"). Também
// serve uma imagem PNG (ícone/hover da opção) para testar o download no main.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/ask-user.spec.ts
//
// Cobre: o formulário substitui o composer, "1/2", teclas 1–6, Próximo só com resposta, "Outro"
// com texto, Voltar, Enviar respostas → resultado compacto + card respondido; Esc cancela →
// "[O usuário não respondeu ao questionário]", sessão ociosa e NENHUMA nova chamada ao modelo;
// a próxima mensagem vê o "não respondeu" + a mensagem no histórico.
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from 'playwright'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32, deflateSync } from 'node:zlib'

const AGENT = 'fake/agent-1'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-ask-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')

function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgb).flat())])
  const raw = Buffer.concat(Array(h).fill(row))
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------- provedor falso ----------------

const hits: any[] = []
let server: Server | null = null
let fakeBase = ''
let origin = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : ''

const askArgs = (): unknown => ({
  questions: [
    {
      title: 'Qual banco de dados?',
      description: 'Para o serviço de pedidos.',
      options: [
        {
          title: 'PostgreSQL',
          icon: 'database',
          description: 'Relacional',
          image: `${origin}/big.png`
        },
        { title: 'SQLite', icon: `${origin}/icon.png`, help: '┌────┐\n│ db │\n└────┘' },
        { title: 'MongoDB', icon: '🍃' }
      ]
    },
    {
      title: 'Quais recursos?',
      multiple: true,
      options: [{ title: 'Cache' }, { title: 'Filas' }, { title: 'Busca' }]
    }
  ]
})

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (url === '/icon.png' || url === '/big.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(
          url === '/icon.png' ? solidPng(24, 24, [80, 200, 120]) : solidPng(320, 200, [90, 90, 220])
        )
        return
      }
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
      const sse = (delta: any): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const base = { id: 'f', object: 'chat.completion.chunk', model: body.model }
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`)
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
        )
        res.end('data: [DONE]\n\n')
      }
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      if (last?.role === 'tool') {
        sse({ role: 'assistant', content: `FIM: ${String(last.content)}` })
        return
      }
      if (/pergunte/.test(textOf(last?.content))) {
        sse({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${Date.now().toString(36)}`,
              type: 'function',
              function: { name: 'ask_user', arguments: JSON.stringify(askArgs()) }
            }
          ]
        })
        return
      }
      sse({ role: 'assistant', content: 'OK, entendido.' })
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  fakeBase = `${origin}/v1`
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
  page.locator('textarea[placeholder="Mensagem…"], textarea[placeholder="Enviar para a fila…"]')
const form = (): Locator => page.getByTestId('question-form')
async function chatState(): Promise<{ chat: any; session: any; msgs: any[] }> {
  const chat = (await read<any[]>('chats.list'))[0]
  const msgs = await read<any[]>('sessions.messages', chat.mainSessionId)
  const session = (await read<any[]>('sessions.list', chat.id)).find(
    (s) => s.id === chat.mainSessionId
  )
  return { chat, session, msgs }
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
  writeFileSync(join(CWD, 'readme.txt'), 'ask e2e\n')
  await startFake()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  // A janela não pode virar a "key window" do SO: teclas que o usuário digitar em outro app
  // durante o teste (o Electron rouba o foco ao abrir) cairiam no campo focado e quebrariam as
  // asserções de texto (ex.: "notificações pushr"). O Playwright injeta eventos via CDP e o
  // documento continua com foco emulado, então nada muda para o teste.
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

  await step('questionário substitui o composer; responder (teclas, Outro, Voltar)', async () => {
    await sendMessage('pergunte algo')
    await form().waitFor({ timeout: 15_000 })
    assert((await composer().count()) === 0, 'textarea do composer some')
    await page.getByText('Aguardando sua resposta').first().waitFor()
    await page.getByTestId('ask-card-pending').waitFor()
    const { session } = await chatState()
    assert(session.status === 'awaiting_input', `status ${session.status}`)
    assert((await page.getByTestId('ask-step').innerText()).trim() === '1/2', 'passo 1/2')
    // ícones: lucide (svg), imagem baixada (img clearchat-attachment), emoji
    const icon = form().locator('img[src^="clearchat-attachment://"]')
    await icon.first().waitFor({ timeout: 5000 })
    assert(
      await icon.first().evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
      'ícone carregado pelo protocolo'
    )
    await form().getByText('🍃').waitFor()
    // hover → imagem grande
    await form().getByTestId('ask-option').nth(0).hover()
    await page.getByTestId('ask-hover-image').waitFor({ timeout: 3000 })
    await shot('questionario-hover')
    // ajuda "?" → texto monoespaçado
    await form().getByTestId('ask-option').nth(1).getByRole('button', { name: /Ajuda/ }).click()
    await page.getByTestId('ask-help').getByText('│ db │').waitFor()
    await page.keyboard.press('Escape') // fecha só o popover
    await page.getByTestId('ask-help').waitFor({ state: 'detached' })
    assert((await form().count()) === 1, 'Esc no popover não cancela o questionário')
    // Próximo desabilitado sem resposta
    assert(await page.getByTestId('ask-next').isDisabled(), 'Próximo desabilitado')
    await form().focus()
    await page.keyboard.press('2')
    assert(
      (await form().getByTestId('ask-option').nth(1).getAttribute('aria-checked')) === 'true',
      'tecla 2 marca SQLite'
    )
    await page.keyboard.press('Enter')
    await form().getByText('Quais recursos?').waitFor()
    assert(await page.getByTestId('ask-submit').isDisabled(), 'Enviar desabilitado')
    await page.keyboard.press('1')
    await page.keyboard.press('2')
    await page.keyboard.press('4') // Outro
    await page.getByTestId('ask-other-text').fill('notificações push')
    await shot('questionario-passo-2')
    await page.getByRole('button', { name: 'Voltar', exact: true }).click()
    await form().getByText('Qual banco de dados?').waitFor()
    await page.getByTestId('ask-next').click()
    await page.getByTestId('ask-submit').click()
    await form().waitFor({ state: 'detached', timeout: 10_000 })
    await composer().waitFor()
    const { msgs } = await waitFor(
      async () => {
        const s = await chatState()
        return s.msgs.some(
          (m) => m.message.role === 'assistant' && /^FIM/.test(m.message.content ?? '')
        )
          ? s
          : null
      },
      15_000,
      'resposta final'
    )
    const tool = msgs.find((m) => m.message.role === 'tool')
    const expected =
      'Respostas do usuário:\n1. Qual banco de dados? → SQLite\n2. Quais recursos? → Cache, Filas, Outro: "notificações push"'
    assert(tool.message.content === expected, `resultado: ${JSON.stringify(tool.message.content)}`)
    assert(tool.meta.askUser?.outcome === 'answered', 'meta.askUser')
    await page.getByTestId('ask-card-answered').waitFor()
    await shot('card-respondido')
  })

  await step(
    'Esc cancela: "não respondeu", sessão ociosa, sem nova chamada ao modelo',
    async () => {
      await sendMessage('pergunte de novo')
      await form().waitFor({ timeout: 15_000 })
      const before = hits.length
      await form().focus()
      await page.keyboard.press('Escape')
      await form().waitFor({ state: 'detached', timeout: 10_000 })
      await composer().waitFor()
      await sleep(800)
      assert(hits.length === before, `chamadas ao modelo após cancelar: ${hits.length - before}`)
      const { msgs, session } = await chatState()
      assert(session.status === 'idle', `status ${session.status}`)
      const tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
      assert(
        tool.message.content === '[O usuário não respondeu ao questionário]',
        tool.message.content
      )
      assert(tool.meta.toolStatus === 'cancelled', 'toolStatus cancelled')
      await page.getByTestId('ask-card-cancelled').last().waitFor()
      // próxima mensagem: o modelo vê o "não respondeu" + a nova mensagem
      await sendMessage('use Postgres')
      await waitFor(async () => hits.length > before, 10_000, 'nova chamada')
      const sent: any[] = hits.at(-1).messages
      const n = sent.length
      assert(
        sent[n - 1].role === 'user' && /use Postgres/.test(textOf(sent[n - 1].content)),
        'último = user'
      )
      assert(
        sent[n - 2].role === 'tool' && /não respondeu/.test(String(sent[n - 2].content)),
        'antes = tool cancelado'
      )
      await shot('cancelado')
    }
  )

  await step('Parar (quadrado) também cancela', async () => {
    await sendMessage('pergunte mais uma vez')
    await form().waitFor({ timeout: 15_000 })
    const before = hits.length
    await page.getByRole('button', { name: 'Parar', exact: true }).click()
    await form().waitFor({ state: 'detached', timeout: 10_000 })
    await sleep(500)
    assert(hits.length === before, 'sem nova chamada')
    const { msgs } = await chatState()
    const tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
    assert(
      tool.message.content === '[O usuário não respondeu ao questionário]',
      tool.message.content
    )
  })

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
