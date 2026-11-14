/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do título automático na UI real (Playwright + `e2e/launch.ts`), 100% determinístico: um provedor
// OpenAI-compatible FALSO servido pelo próprio teste em 127.0.0.1 faz o papel do agente
// (`fake/agent-1`: responde na hora) e do modelo do título (`fake/titler-1`: respostas
// roteirizadas, com atraso). Nenhuma key real, nenhum custo; userData temporário.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/auto-title.spec.ts [filtro]
//
// Cobre: Configurações → Novos chats → "Título automático" (padrão Nenhum; escolher o modelo,
// memórias, limite de tokens, prompt + "Restaurar padrão"; persiste após recarregar), chat novo
// recebe o título gerado sem atrasar a resposta do agente (custo "título $" sob a 1ª mensagem),
// renomear antes da resposta preserva o título do usuário, "Gerar título" no cabeçalho e
// remover o modelo → nenhuma chamada. Screenshots em $CLEARCHAT_E2E_DIR/shots.
import type { ElectronApplication, Locator, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { elementShot, pickModel as pickModelIn } from './uiHelpers.ts'

const FAKE_KEY = 'fake-key-auto-title'
const AGENT = 'fake/agent-1'
const TITLER = 'fake/titler-1'
/** Raciocínio obrigatório (metadados no /models) → "Tokens de pensamento". */
const THINKER = 'fake/thinker-title-1'
const ROOT = resolve(process.env.CLEARCHAT_E2E_ROOT || join(import.meta.dirname, '..'))
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-autotitle-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''

// ---------------- provedor falso ----------------

interface TitleReply {
  text: string
  delayMs?: number
}
const titleQueue: TitleReply[] = []
const hits: { model: string; body: any; at: number; doneAt?: number }[] = []
let server: Server | null = null
let fakeBase = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [AGENT, TITLER]
              .map((id) => ({
                id,
                name: id === AGENT ? 'Fake Agent' : 'Fake Titler',
                context_length: 64_000,
                pricing: { prompt: '0.0000001', completion: '0.0000002' },
                supported_parameters: ['tools', 'temperature', 'max_tokens']
              }))
              .concat([
                {
                  id: THINKER,
                  name: 'Fake Thinker',
                  context_length: 64_000,
                  pricing: { prompt: '0.0000001', completion: '0.0000002' },
                  supported_parameters: ['max_tokens', 'reasoning'],
                  reasoning: { mandatory: true, supported_efforts: ['low', 'high'] }
                } as any
              ])
          })
        )
        return
      }
      if (!(req.method === 'POST' && url.endsWith('/chat/completions'))) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"not found"}}')
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      const hit: (typeof hits)[number] = { model: body.model, body, at: Date.now() }
      hits.push(hit)
      const sse = (text: string, usage: any): void => {
        if (res.destroyed) return
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const base = { id: 'f', object: 'chat.completion.chunk', model: body.model }
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`
        )
        res.end('data: [DONE]\n\n')
        hit.doneAt = Date.now()
      }
      if (body.model === TITLER) {
        const r = titleQueue.shift() ?? { text: 'Título sem roteiro' }
        setTimeout(
          () => sse(r.text, { prompt_tokens: 180, completion_tokens: 7, cost: 0.000021 }),
          r.delayMs ?? 0
        )
        return
      }
      sse('Resposta do agente falso.', { prompt_tokens: 100, completion_tokens: 5 })
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let shotN = 0
let stopped = false
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
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1280, 860)
  })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, CWD)
}

async function shot(name: string): Promise<string> {
  const p = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: p })
  return p
}

async function shotOf(loc: Locator, name: string): Promise<string> {
  const p = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await elementShot(page, loc, p) // nunca loc.screenshot() (ver uiHelpers)
  return p
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

async function waitUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
  what: string
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(80)
  }
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (stopped) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

const composer = (): Locator =>
  page.locator('textarea[placeholder="Mensagem…"], textarea[placeholder="Enviar para a fila…"]')
const stopBtn = (): Locator => page.getByRole('button', { name: 'Parar', exact: true })
const dialog = (): Locator => page.getByRole('dialog')
const group = (): Locator => dialog().getByTestId('auto-title-settings')
const headerTitle = (): Locator => page.getByTestId('chat-title')

async function sendMessage(text: string): Promise<void> {
  const c = composer()
  await c.click()
  await c.fill(text)
  await c.press('Enter')
}

async function waitIdle(ms = 30_000): Promise<void> {
  await sleep(300)
  await stopBtn().waitFor({ state: 'detached', timeout: ms })
}

async function currentChat(): Promise<any> {
  const chats = await read<any[]>('chats.list')
  return chats.sort((a, b) => b.createdAt - a.createdAt)[0]
}

async function pickModel(combobox: Locator, id: string): Promise<void> {
  await pickModelIn(page, combobox, id)
}

async function openDefaults(): Promise<void> {
  await page.getByRole('button', { name: 'Configurações' }).first().click()
  await dialog().getByRole('button', { name: 'Novos chats', exact: true }).click()
  await group().waitFor()
}

async function newChat(): Promise<void> {
  await page
    .locator('button:has-text("Novo chat")')
    .filter({ has: page.locator('kbd') })
    .click()
  await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: /Alterar/ }).click()
  await page.getByRole('button', { name: 'Começar' }).click()
  await composer().waitFor({ timeout: 15_000 })
}

const titleHits = (): typeof hits => hits.filter((h) => h.model === TITLER)
const FIRST = 'Como configuro o nginx como proxy reverso para o meu app Node na porta 3000?'
const PROVISIONAL = 'Como configuro o nginx como proxy reverso para o m…'

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  await startFake()
  await launch()

  await step('onboarding com o provedor falso', async () => {
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await page.getByTestId('onboarding-provider').click()
    await page.locator('input.field').nth(0).fill('Local')
    await page.locator('input.field').nth(1).fill(fakeBase)
    await page.locator('input[type="password"]').fill(FAKE_KEY)
    await page.getByRole('button', { name: 'Testar conexão' }).click()
    await page.getByText(/Conexão ok/).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
  })

  await step('Novos chats: grupo "Título automático" com o padrão Nenhum', async () => {
    await openDefaults()
    // modelo padrão do app = o agente falso (Novo chat já vem com ele)
    await pickModel(dialog().getByTestId('model-picker').first(), AGENT)
    const g = group()
    await g.getByText('Título automático', { exact: true }).waitFor()
    await g
      .getByTestId('auto-title-model')
      .getByText(/Nenhum — o título é o começo/)
      .waitFor()
    assert(
      (await g.getByRole('button', { name: 'Remover modelo do título' }).count()) === 0,
      'sem ×'
    )
    const sw = g.getByRole('switch', { name: 'Usar as memórias do usuário' })
    assert((await sw.getAttribute('aria-checked')) === 'false', 'memórias desligadas')
    assert(
      (await g.getByRole('spinbutton', { name: 'Limite de tokens de saída' }).inputValue()) ===
        '64',
      'limite padrão 64'
    )
    const prompt = await g.getByRole('textbox', { name: 'Prompt de geração' }).inputValue()
    assert(prompt.startsWith('Você dá nome a conversas.'), 'prompt padrão')
    assert((await g.getByText('Restaurar padrão').count()) === 0, 'sem restaurar no padrão')
    assert((await read('settings.get', 'autoTitle')) === null, 'nada salvo')
    await g.scrollIntoViewIfNeeded()
    await shotOf(dialog(), 'novos-chats-titulo-nenhum')
  })

  await step(
    'escolher modelo, memórias, limite e prompt → persiste; Restaurar padrão',
    async () => {
      const g = group()
      await pickModel(g.getByTestId('auto-title-model').getByRole('combobox'), TITLER)
      await g.getByRole('switch', { name: 'Usar as memórias do usuário' }).click()
      const num = g.getByRole('spinbutton', { name: 'Limite de tokens de saída' })
      await num.fill('48')
      const ta = g.getByRole('textbox', { name: 'Prompt de geração' })
      await ta.fill('Dê um título curtíssimo.')
      await ta.blur()
      await g.getByText('Restaurar padrão').waitFor()
      const saved = await waitUntil(
        async () => {
          const s = await read<any>('settings.get', 'autoTitle')
          return s?.prompt === 'Dê um título curtíssimo.' && s
        },
        5000,
        'salvo'
      )
      assert(saved.model === TITLER && saved.providerId, `modelo salvo ${JSON.stringify(saved)}`)
      assert(saved.useMemory === true, 'memórias salvas')
      assert(saved.maxTokens === 48, `limite ${saved.maxTokens}`)
      await g.scrollIntoViewIfNeeded()
      await shotOf(dialog(), 'novos-chats-titulo-configurado')
      // Restaurar padrão → prompt null (segue o padrão); memórias de volta ao padrão
      await g.getByText('Restaurar padrão').click()
      await g.getByRole('switch', { name: 'Usar as memórias do usuário' }).click()
      await waitUntil(
        async () => {
          const s = await read<any>('settings.get', 'autoTitle')
          return s?.prompt === null && s.useMemory === false
        },
        5000,
        'prompt restaurado'
      )
      // recarregar a janela: o grupo volta com o que foi salvo
      await page.keyboard.press('Escape')
      await page.reload()
      await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
      await openDefaults()
      await group().getByTestId('auto-title-model').getByText('fake/titler-1').first().waitFor()
      assert(
        (await group()
          .getByRole('spinbutton', { name: 'Limite de tokens de saída' })
          .inputValue()) === '48',
        'limite persistido'
      )
      assert(
        (await group().getByRole('textbox', { name: 'Prompt de geração' }).inputValue()).startsWith(
          'Você dá nome a conversas.'
        ),
        'prompt padrão após restaurar'
      )
      await page.keyboard.press('Escape')
    }
  )

  await step('modelo com raciocínio obrigatório: aviso + "Tokens de pensamento"', async () => {
    await openDefaults()
    const g = group()
    const picker = g.getByTestId('auto-title-model').getByRole('combobox')
    assert((await g.getByTestId('auto-title-thinking').count()) === 0, 'titler: sem campo')
    await pickModel(picker, THINKER)
    const box = g.getByTestId('auto-title-thinking')
    await box.waitFor({ timeout: 10_000 })
    await box
      .getByText('Este modelo sempre raciocina (thinking obrigatório) — esforço mínimo.')
      .waitFor()
    const input = box.getByRole('spinbutton', { name: 'Tokens de pensamento do título' })
    assert((await input.getAttribute('placeholder')) === '1024', 'placeholder = padrão')
    await input.fill('512')
    await input.blur()
    await waitUntil(
      async () => (await read<any>('settings.get', 'autoTitle'))?.thinkingTokens === 512,
      5000,
      'tokens de pensamento salvos'
    )
    // (i): parâmetros exatos — max_tokens 48 + 512, effort mínimo
    await g.getByRole('button', { name: 'O que é enviado para a API' }).first().hover()
    const params = page.getByTestId('auto-title-request-params')
    await params.waitFor({ timeout: 5000 })
    const txt = (await params.textContent()) ?? ''
    assert(txt.includes('"max_tokens": 560'), `max_tokens: ${txt}`)
    assert(txt.includes('"reasoning_effort": "low"'), `effort: ${txt}`)
    await shot('titulo-thinking-preview')
    await page.mouse.move(0, 0)
    await box.scrollIntoViewIfNeeded()
    await shotOf(dialog(), 'titulo-thinking-campo')
    // limpar = padrão; voltar ao titler → some o campo
    await input.fill('')
    await input.blur()
    await waitUntil(
      async () => (await read<any>('settings.get', 'autoTitle'))?.thinkingTokens === null,
      5000,
      'limpo'
    )
    await pickModel(picker, TITLER)
    await box.waitFor({ state: 'detached', timeout: 5000 })
    await page.keyboard.press('Escape')
  })

  await step('chat novo: o agente responde na hora e o título gerado chega depois', async () => {
    await newChat()
    titleQueue.push({ text: '"Proxy reverso nginx para Node."', delayMs: 2500 })
    const n0 = titleHits().length
    await sendMessage(FIRST)
    await page.getByText('Resposta do agente falso.').waitFor({ timeout: 15_000 })
    await waitIdle()
    // a resposta já veio e o título ainda é o provisório (a chamada do título está pendente)
    assert((await headerTitle().textContent()) === PROVISIONAL, 'título provisório no header')
    assert(titleHits().length === n0 + 1 && !titleHits()[n0].doneAt, 'título ainda pendente')
    await shot('chat-titulo-provisorio')
    await headerTitle().getByText('Proxy reverso nginx para Node', { exact: true }).waitFor({
      timeout: 10_000
    })
    const body = titleHits()[n0].body
    assert(body.max_tokens === 48, `max_tokens ${body.max_tokens}`)
    assert(String(body.messages[1].content).includes(FIRST), '1ª mensagem enviada')
    const badge = page.getByTestId('auto-title-usage')
    await badge.waitFor({ timeout: 5000 })
    assert(/título \$0\.0000|título <\$0\.0001/.test((await badge.textContent()) ?? ''), 'custo')
    const both = page.getByText('Proxy reverso nginx para Node', { exact: true })
    assert((await both.count()) >= 2, 'header + sidebar com o título novo')
    await shot('chat-titulo-gerado')
  })

  await step('renomear antes da resposta preserva o título do usuário', async () => {
    await newChat()
    titleQueue.push({ text: 'Título que não deve ficar', delayMs: 3000 })
    const n0 = titleHits().length
    await sendMessage('Me ajude a planejar uma viagem de 5 dias para Lisboa em maio')
    await waitIdle()
    await headerTitle().click()
    const input = page.getByRole('textbox', { name: 'Título do chat' })
    await input.fill('Lisboa — meu título')
    await input.press('Enter')
    await headerTitle().getByText('Lisboa — meu título').waitFor()
    await waitUntil(async () => titleHits()[n0]?.doneAt, 10_000, 'resposta do título')
    await sleep(700)
    const chat = await currentChat()
    assert(chat.title === 'Lisboa — meu título', `título ${chat.title}`)
    assert((await headerTitle().textContent()) === 'Lisboa — meu título', 'header preservado')
    await shot('chat-renomeado-preservado')
  })

  await step('"Gerar título" no cabeçalho gera de novo', async () => {
    titleQueue.push({ text: 'Roteiro de 5 dias em Lisboa', delayMs: 400 })
    await headerTitle().hover()
    const btn = page.getByTestId('generate-title')
    await btn.click()
    await headerTitle().getByText('Roteiro de 5 dias em Lisboa').waitFor({ timeout: 10_000 })
    await headerTitle().hover()
    await shotOf(page.locator('header').first(), 'header-gerar-titulo')
  })

  await step('remover o modelo (×) → chat novo sem chamada ao modelo do título', async () => {
    await openDefaults()
    await group().getByRole('button', { name: 'Remover modelo do título' }).click()
    await group()
      .getByText(/Nenhum — o título é o começo/)
      .waitFor()
    await waitUntil(
      async () => (await read<any>('settings.get', 'autoTitle'))?.model === null,
      5000,
      'modelo removido'
    )
    await page.keyboard.press('Escape')
    const n0 = titleHits().length
    await newChat()
    await sendMessage('Uma pergunta qualquer sobre SQL')
    await waitIdle()
    await sleep(800)
    assert(titleHits().length === n0, 'sem chamada ao modelo do título')
    assert(
      (await headerTitle().textContent()) === 'Uma pergunta qualquer sobre SQL',
      'título = começo da mensagem'
    )
    assert((await page.getByTestId('generate-title').count()) === 0, 'sem "Gerar título"')
  })

  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
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
