/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da UI real (Playwright `_electron`): clica/digita na interface do app buildado — nada de
// atalhos via window.api para AGIR (window.api só é lido para conferir estado no banco).
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   OPENROUTER_API_KEY=sk-or-... CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/ui.spec.ts [filtro]
//
// - A key vem SOMENTE do ambiente (nunca grave em arquivo); é digitada no onboarding.
// - userData isolado (CLEARCHAT_USER_DATA) e cwd de rascunho dentro de CLEARCHAT_E2E_DIR
//   (apagado no início). Screenshots em $CLEARCHAT_E2E_DIR/shots, log do main em ui-main.log.
// - O diálogo nativo "Escolher pasta" é substituído no main (dialog.showOpenDialog) para devolver
//   a pasta de rascunho — o clique no botão continua sendo pela UI.
// - [filtro] opcional: os passos são dependentes; o filtro só serve para PARAR depois do passo
//   cujo nome contém o texto (ex.: `node e2e/ui.spec.ts delegate`).
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from 'playwright'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32, deflateSync } from 'node:zlib'

/** PNG RGB de cor sólida (sem dependências). */
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

// ---------------- provedor OpenAI-compatible falso (local) ----------------
// GET /v1/models (inclui o mesmo id do modelo do OpenRouter → mesmo id em dois provedores) e
// POST /v1/chat/completions em SSE respondendo "FAKE-OK". Guarda as requests para conferência.
const FAKE_KEY = 'fake-key-e2e-123456'
const FAKE_MODEL = 'fake/echo-1'
const fakeHits: { url: string; auth: string; body: any }[] = []
let fakeServer: Server | null = null
let fakeBase = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}

async function startFakeProvider(modelIds: string[]): Promise<void> {
  fakeServer = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: modelIds.map((id, i) => ({
              id,
              name: id === FAKE_MODEL ? 'Fake Echo 1' : undefined,
              context_length: 32_000 * (i + 1),
              pricing: { prompt: '0.0000001', completion: '0.0000002' },
              supported_parameters: ['tools']
            }))
          })
        )
        return
      }
      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        const body = JSON.parse((await readBody(req)) || '{}')
        fakeHits.push({ url, auth: String(req.headers.authorization ?? ''), body })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const chunk = (o: unknown): boolean => res.write(`data: ${JSON.stringify(o)}\n\n`)
        const base = { id: 'fake-1', object: 'chat.completion.chunk', model: body.model }
        chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'FAKE-' } }] })
        chunk({ ...base, choices: [{ index: 0, delta: { content: 'OK' } }] })
        chunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        })
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"not found"}}')
    })()
  })
  await new Promise<void>((r) => fakeServer!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(fakeServer!.address() as AddressInfo).port}/v1`
}

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) {
  console.error('Defina OPENROUTER_API_KEY no ambiente.')
  process.exit(2)
}
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-ui-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''
const MODEL = process.env.E2E_MODEL || 'openai/gpt-4.1-nano'
const ALT_MODEL = process.env.E2E_ALT_MODEL || 'openai/gpt-4o-mini'
// Modo texto (<tool_call> no content): GLM (z-ai/*) trata <tool_call> como token especial e vários
// provedores upstream o engolem (content vazio) — use outro modelo nesse passo.
const TEXT_MODEL = process.env.E2E_TEXT_MODEL || MODEL

let app: ElectronApplication
let page: Page
let shotN = 0
let stopped = false
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []

// ---------------- infra ----------------

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY // o app não lê a key do ambiente: ela é digitada no onboarding
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'ui-main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await setSize(1280, 820)
  // diálogo nativo de pasta → devolve a pasta configurada em global.__pickDir
  // seletor de arquivos (anexos, properties com 'openFile') → global.__pickFiles
  await app.evaluate(({ dialog }, dir) => {
    ;(globalThis as any).__pickDir = dir
    dialog.showOpenDialog = (async (...args: any[]) => {
      const opts = args.find((a) => a && Array.isArray(a.properties))
      if (opts?.properties.includes('openFile'))
        return { canceled: false, filePaths: (globalThis as any).__pickFiles ?? [] }
      return { canceled: false, filePaths: [(globalThis as any).__pickDir] }
    }) as any
  }, CWD)
}

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win =
        BrowserWindow.getAllWindows().find((x) => x.isVisible()) ?? BrowserWindow.getAllWindows()[0]
      win.setSize(w, h)
    },
    [w, h] as const
  )
  await page.waitForTimeout(250)
}

async function shot(name: string): Promise<string> {
  const file = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path: file })
  return file
}

/** Lê estado via window.api (só leitura, para asserções). */
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
      // não deixa modais/popovers abertos contaminarem os próximos passos
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

// ---------------- helpers de UI ----------------

const composer = (): Locator =>
  page.locator('textarea[placeholder="Mensagem…"], textarea[placeholder="Enviar para a fila…"]')
const stopBtn = (): Locator => page.getByRole('button', { name: 'Parar', exact: true })

async function sendMessage(text: string): Promise<void> {
  const c = composer()
  await c.click()
  await c.fill(text)
  await c.press('Enter')
}

/** Espera a sessão visível ficar ociosa (sem botão Parar). */
async function waitIdle(ms = 120_000): Promise<void> {
  await sleep(400)
  await stopBtn().waitFor({ state: 'detached', timeout: ms })
}

async function waitRunning(ms = 30_000): Promise<void> {
  await stopBtn().waitFor({ state: 'visible', timeout: ms })
}

/** Pede um comando bash e espera ele estar executando (modelos baratos às vezes hesitam: reenvia). */
async function askLongBash(cmd: string): Promise<void> {
  const prompts = [
    `Run this exact shell command with the shell tool: ${cmd}`,
    `Call the shell tool right now with command "${cmd}". The file exists in the working directory. Do not ask questions, just call the tool.`,
    `shell tool, command: ${cmd} — call it immediately.`
  ]
  for (const p of prompts) {
    const before = await toolCards('Terminal (shell)').count()
    await sendMessage(p)
    const t0 = Date.now()
    while (Date.now() - t0 < 60_000) {
      const n = await toolCards('Terminal (shell)').count()
      if (
        n > before &&
        (await toolCards('Terminal (shell)').last().getByText('executando').count())
      )
        return
      if (!(await stopBtn().count()) && Date.now() - t0 > 1500) break
      await sleep(200)
    }
    await waitIdle(30_000)
  }
  throw new Error(`o modelo não executou: ${cmd}`)
}

/** Largura natural de uma <img> depois de carregar (0 = falhou). */
async function imgWidth(img: Locator): Promise<number> {
  return img.evaluate(
    (im: HTMLImageElement) =>
      new Promise<number>((res) => {
        if (im.complete) return res(im.naturalWidth)
        im.addEventListener('load', () => res(im.naturalWidth), { once: true })
        im.addEventListener('error', () => res(0), { once: true })
      })
  )
}

/** Cards de tool da sessão visível. */
const toolCards = (label: string): Locator =>
  page.locator('div.rounded-xl').filter({ has: page.locator(`span:text-is("${label}")`) })

/**
 * Escolhe um modelo no ModelPicker (um seletor só, agrupado por provedor). `provider`: prefixo
 * do nome do provedor (padrão "OpenRouter"); sem a opção na lista → "Usar <id> em <provedor>".
 */
async function pickModel(combobox: Locator, id: string, provider = 'OpenRouter'): Promise<void> {
  await combobox.click()
  const search = page.getByRole('textbox', { name: 'Buscar modelo' })
  await search.fill(id)
  const listbox = page.getByRole('listbox', { name: 'Modelos' })
  const exact = listbox.locator(`[role=option][data-model="${id}"][data-provider^="${provider}"]`)
  const free = listbox.locator(`[role=option][data-free][data-provider^="${provider}"]`)
  await exact.or(free).first().waitFor({ timeout: 20_000 })
  // espera a lista do provedor carregar antes de cair no ID livre
  await exact
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => {})
  if (await exact.count()) await exact.first().click()
  else await free.first().click()
  await listbox.waitFor({ state: 'detached', timeout: 5000 })
}

async function currentState(): Promise<{ chat: any; sid: string; msgs: any[] }> {
  const chats = await read<any[]>('chats.list')
  const chat = chats.find((c) => c.title !== 'Erro')!
  const msgs = await read<any[]>('sessions.messages', chat.mainSessionId)
  return { chat, sid: chat.mainSessionId, msgs }
}

async function openPreview(): Promise<any> {
  await page.getByRole('button', { name: 'Ver request' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByText('POST', { exact: true }).waitFor({ timeout: 10_000 })
  await sleep(200)
  // o JSON exibido no modal: headers e body
  const pres = dlg.locator('pre.hljs')
  const headers = JSON.parse(await pres.nth(0).innerText())
  const body = JSON.parse(await pres.nth(1).innerText())
  const url = (await dlg.getByTestId('preview-url').innerText()).trim()
  return { headers, body, dlg, url }
}

async function closeModal(): Promise<void> {
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 })
}

type PanelTab = 'Modelo' | 'Chat' | 'Tools' | 'Arquivos'

const panelTab = (tab: PanelTab): Locator =>
  page.getByTestId('right-panel').getByRole('tab', { name: tab, exact: true })

async function ensurePanel(tab: PanelTab): Promise<void> {
  if (!(await panelTab(tab).count()))
    await page.getByRole('button', { name: 'Abrir painel' }).click()
  await panelTab(tab).click()
}

/** Abre a seção recolhível `id` do painel/editor (CollapsibleSection), se estiver fechada. */
async function expand(scope: Locator, id: string): Promise<void> {
  const btn = scope.getByTestId(`collapse-${id}`)
  await btn.scrollIntoViewIfNeeded()
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click()
  await scope.locator(`[data-collapse-id="${id}"][data-open]`).waitFor()
}

/** Linha de uma persona na aba Personas das Configurações. */
const presetRow = (name: string): Locator =>
  page.getByTestId('preset-row').filter({ has: page.locator(`span:text-is("${name}")`) })

async function tooltipText(trigger: Locator): Promise<string> {
  await trigger.hover()
  const tip = page.getByRole('tooltip')
  await tip.first().waitFor({ timeout: 5000 })
  const t = await tip.first().innerText()
  await page.keyboard.press('Escape')
  await page.mouse.move(640, 5)
  await tip
    .first()
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => {})
  return t
}

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(join(CWD, 'sub'), { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(CWD, 'readme.txt'), 'arquivo de exemplo do e2e\n')
  writeFileSync(join(CWD, 'sub', 'inner.txt'), 'dentro da subpasta\n')
  writeFileSync(join(CWD, 'slow.sh'), 'sleep 40\necho slow-done\n')
  await startFakeProvider([FAKE_MODEL, MODEL, 'fake/other-2'])
  await launch()

  await step('onboarding (Testar → Continuar)', async () => {
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await page.getByTestId('onboarding-provider').click()
    await shot('onboarding')
    await page.locator('input[type="password"]').fill(KEY)
    await page.getByRole('button', { name: 'Testar conexão' }).click()
    await page.getByText(/Conexão ok/).waitFor({ timeout: 30_000 })
    await shot('onboarding-ok')
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
    const providers = await read<any[]>('providers.list')
    assert(providers.length === 1 && providers[0].baseUrl.includes('openrouter'), 'provider salvo')
  })

  await step('novo chat (modelo, system prompt, diretório raiz) → Começar', async () => {
    await pickModel(page.getByRole('combobox'), MODEL)
    await page
      .getByRole('combobox')
      .getByText(MODEL)
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {})
    const sp = page.getByPlaceholder('Instruções para o modelo (opcional)')
    await sp.fill(
      'Você é um assistente de testes. Seja muito conciso e use as ferramentas quando pedido.'
    )
    await page.getByRole('button', { name: /Alterar/ }).click()
    await page.getByText(CWD.split('/').pop()!, { exact: false }).first().waitFor({ timeout: 5000 })
    await shot('new-chat')
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 15_000 })
    await page.getByText('Pronto para conversar').waitFor()
    await shot('empty-chat')
    const { chat } = await currentState()
    assert(chat.config.model === MODEL, `modelo ${chat.config.model}`)
    assert(chat.config.cwd === CWD, `cwd ${chat.config.cwd}`)
    assert(chat.config.systemPrompt.startsWith('Você é um assistente de testes'), 'system prompt')
  })

  await step(
    'painel: abas Modelo · Chat · Tools · Arquivos, Ver request de qualquer aba',
    async () => {
      const aside = page.getByTestId('right-panel')
      await ensurePanel('Modelo')
      // tudo recolhido por padrão (o modelo inclusive); abertas aqui, ficam lembradas no resto
      for (const id of ['model', 'system-prompt', 'params', 'request']) await expand(aside, id)
      await aside.getByRole('combobox').waitFor({ timeout: 5000 })
      await aside.getByLabel('System prompt', { exact: true }).waitFor()
      await aside.getByRole('switch', { name: 'Enviar temperature' }).waitFor()
      await aside.getByRole('switch', { name: 'Token caching' }).waitFor()
      await aside.getByTestId('model-info').getByText(/ctx/).waitFor({ timeout: 15_000 })
      assert(
        (await aside.getByRole('switch', { name: 'Enviar tools nativas' }).count()) === 0,
        'Modelo sem tools'
      )
      await shot('tab-modelo')
      await ensurePanel('Chat')
      // o título é editado no cabeçalho do chat (não há mais campo na aba Chat)
      assert((await aside.getByLabel('Título do chat').count()) === 0, 'sem título na aba')
      await page.getByTestId('chat-title').waitFor()
      for (const t of [
        'Persona',
        'Contexto',
        'Janela e compactação',
        'Diretório raiz',
        'Assinatura do app'
      ])
        await aside.locator('h3', { hasText: t }).waitFor({ timeout: 3000 })
      for (const id of ['chat-persona', 'context', 'root']) await expand(aside, id)
      await aside.getByTestId('chat-root').waitFor()
      await aside.getByRole('switch', { name: 'Bloco de ambiente' }).waitFor()
      await aside.getByRole('button', { name: 'Salvar como persona' }).waitFor()
      await shot('tab-chat')
      await ensurePanel('Tools')
      // (o antigo "Auto-aprovar tudo" saiu: aprovações agora são por modo/listas globais)
      for (const id of ['tools-list', 'skills', 'tools-sending', 'subagents', 'limits'])
        await expand(aside, id)
      for (const n of ['Enviar tools nativas', 'Texto das tools no system prompt'])
        await aside.getByRole('switch', { name: n }).waitFor({ timeout: 3000 })
      await aside.getByLabel('System prompt dos subagentes').waitFor()
      await aside
        .getByRole('spinbutton', { name: 'Saída máxima por ferramenta (caracteres)' })
        .waitFor()
      await shot('tab-tools')
      // "Ver request" no cabeçalho do painel: funciona de qualquer aba
      const { body } = await openPreview()
      assert(body.model === MODEL && Array.isArray(body.tools), 'preview pela aba Tools')
      await closeModal()
      await ensurePanel('Arquivos')
      await aside.getByText('readme.txt').waitFor({ timeout: 5000 })
      // a aba é lembrada (localStorage) ao fechar/reabrir o painel
      await ensurePanel('Tools')
      await page.getByRole('button', { name: 'Fechar painel' }).first().click()
      await page.getByRole('button', { name: 'Abrir painel' }).click()
      assert((await panelTab('Tools').getAttribute('aria-selected')) === 'true', 'aba lembrada')
      const stored = await page.evaluate(() => localStorage.getItem('clearchat.panelTab'))
      assert(stored === 'tools', `localStorage ${stored}`)
      await ensurePanel('Modelo')
    }
  )

  await step('write_file + read_file', async () => {
    await sendMessage(
      'Use write_file to create notes.txt with exactly the content "alpha beta gamma". Then use read_file to read notes.txt. Then reply with the file content only.'
    )
    await waitRunning()
    await waitIdle()
    await toolCards('Escrever arquivo').first().waitFor({ timeout: 5000 })
    await toolCards('Ler arquivo').first().waitFor({ timeout: 5000 })
    assert(existsSync(join(CWD, 'notes.txt')), 'notes.txt criado')
    assert(readFileSync(join(CWD, 'notes.txt'), 'utf8').includes('alpha beta gamma'), 'conteúdo')
    await page.getByText('alpha beta gamma').last().waitFor()
    // título do chat = primeira mensagem
    const { chat } = await currentState()
    assert(chat.title.startsWith('Use write_file'), `título ${chat.title}`)
    // medidor de contexto: "Nk / Mk · P%" (janela do modelo via /models)
    const meter = page.getByTestId('context-meter')
    await meter.waitFor({ timeout: 10_000 })
    const mt = await meter.innerText()
    assert(/\d.*\/.*\d.*%/.test(mt), `medidor: ${mt}`)
    // card de tool mostra o tamanho aproximado do resultado
    await toolCards('Ler arquivo').first().getByTestId('tool-size').waitFor({ timeout: 5000 })
    await shot('write-read')
  })

  await step(
    'anexos: botão (diálogo) + colar → chips, aviso de modalidade, miniatura enviada',
    async () => {
      const n0 = (await currentState()).msgs.length
      // arquivos de teste: PNG vermelho (gerado aqui), texto e um WAV (gpt-4.1-nano não aceita áudio)
      const png = join(BASE, 'vermelho.png')
      writeFileSync(png, solidPng(256, 256, [220, 20, 20]))
      const md = join(BASE, 'notas.md')
      writeFileSync(md, '# Projeto Girassol\n\nTítulo do documento: GIRASSOL-9\n')
      const wav = join(BASE, 'som.wav')
      writeFileSync(
        wav,
        Buffer.from(
          'RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00',
          'latin1'
        )
      )
      await app.evaluate(
        (_e, files) => {
          ;(globalThis as any).__pickFiles = files
        },
        [png, md, wav]
      )
      const chips = page.locator('[data-attachment-chip]')
      await page.getByRole('button', { name: 'Anexar arquivos' }).click()
      await chips.nth(2).waitFor({ timeout: 10_000 })
      assert((await chips.count()) === 3, `chips: ${await chips.count()}`)
      // miniatura da imagem no chip (servida por clearchat-attachment://)
      assert((await imgWidth(chips.first().locator('img'))) === 256, 'miniatura no chip')
      // aviso inline: o modelo não aceita áudio; Enter não envia (pede confirmação)
      const alert = page.getByRole('alert').filter({ hasText: 'Este modelo não aceita áudio' })
      await alert.waitFor({ timeout: 10_000 })
      await sleep(300)
      await shot('attach-warning')
      await composer().click()
      await composer().fill('teste')
      await composer().press('Enter')
      await alert.getByText('Confirme para enviar assim mesmo.').waitFor({ timeout: 3000 })
      assert((await currentState()).msgs.length === n0, 'não enviou sem confirmar')
      await page.getByRole('button', { name: 'Remover som.wav' }).click()
      await alert.waitFor({ state: 'detached', timeout: 3000 })
      // colar uma imagem da área de transferência
      await composer().evaluate(
        (el, bytes) => {
          const dt = new DataTransfer()
          dt.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }))
          el.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          )
        },
        Array.from(solidPng(64, 64, [20, 120, 220]))
      )
      await chips.nth(2).waitFor({ timeout: 10_000 })
      const pastedName = (await chips.nth(2).getAttribute('data-attachment-chip')) ?? ''
      assert(/^colado-\d{6}\.png$/.test(pastedName), `nome colado: ${pastedName}`)
      await shot('attach-chips')
      // (i) do anexo explica o part enviado
      const tip = await tooltipText(
        chips.first().getByRole('button', { name: 'O que é enviado para a API' })
      )
      assert(
        /image_url/.test(tip) && /base64 em toda request/.test(tip),
        `tooltip: ${tip.slice(0, 120)}`
      )
      await page.getByRole('button', { name: `Remover ${pastedName}` }).click()
      assert((await chips.count()) === 2, 'chip colado removido')
      // arrastar e soltar um arquivo no chat: overlay "Solte para anexar" → chip
      const dropZone = page.locator('[data-chat-drop]')
      await dropZone.evaluate((el) => {
        const dt = new DataTransfer()
        dt.items.add(new File(['conteúdo arrastado\n'], 'arrastado.txt', { type: 'text/plain' }))
        ;(window as any).__dt = dt
        el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }))
      })
      await page.getByText('Solte para anexar').waitFor({ timeout: 3000 })
      await sleep(250)
      await shot('attach-drop')
      await dropZone.evaluate((el) =>
        el.dispatchEvent(
          new DragEvent('drop', {
            dataTransfer: (window as any).__dt,
            bubbles: true,
            cancelable: true
          })
        )
      )
      await page.getByText('Solte para anexar').waitFor({ state: 'detached', timeout: 3000 })
      const dropped = page.locator('[data-attachment-chip="arrastado.txt"]')
      await dropped.waitFor({ timeout: 5000 })
      await page.getByRole('button', { name: 'Remover arrastado.txt' }).click()
      assert((await chips.count()) === 2, 'chip arrastado removido')
      // enviar: imagem + arquivo de texto
      await composer().fill(
        'Qual é a cor da imagem e qual é o título do documento em notas.md? Responda curto.'
      )
      await composer().press('Enter')
      await waitIdle()
      assert((await chips.count()) === 0, 'chips limpos após enviar')
      const att = page.locator('[data-message-attachments]').last()
      const sentThumb = att.locator('img')
      await sentThumb.waitFor({ timeout: 10_000 })
      assert((await imgWidth(sentThumb)) === 256, 'miniatura na mensagem enviada')
      await att.getByText('notas.md').waitFor()
      const { msgs } = await currentState()
      const u = msgs.findLast((m) => m.message.role === 'user')
      assert(
        Array.isArray(u.message.content) &&
          u.message.content[0].image_url?.url.startsWith('clearchat-attachment://') &&
          u.message.content[1]._attachment?.name === 'notas.md',
        'mensagem persistida com referências'
      )
      const answer = msgs.at(-1).message.content ?? ''
      assert(/verm|red/i.test(answer) && /girassol/i.test(answer), `resposta: ${answer}`)
      await shot('attach-sent')
      await att.getByRole('button', { name: 'O que é enviado para a API' }).last().hover()
      await page.getByRole('tooltip').first().waitFor({ timeout: 5000 })
      await sleep(250)
      await shot('attach-info')
      await page.mouse.move(640, 5)
      // prévia do arquivo de texto expansível
      await att.getByRole('button', { name: 'Ver conteúdo' }).click()
      await att.getByText('Título do documento: GIRASSOL-9').waitFor({ timeout: 3000 })
      // lightbox
      await sentThumb.click()
      const lb = page.getByRole('dialog', { name: 'vermelho.png' })
      await lb.waitFor({ timeout: 3000 })
      await sleep(350)
      await shot('attach-lightbox')
      await page.keyboard.press('Escape')
      await lb.waitFor({ state: 'detached', timeout: 3000 })
      // Ver request: base64 encurtado + nota
      await ensurePanel('Chat')
      const { body, dlg } = await openPreview()
      const sent = body.messages.findLast((m: any) => m.role === 'user').content
      assert(
        /^data:image\/png;base64,.{24}…\(/.test(sent[0].image_url.url),
        `preview: ${sent[0].image_url.url}`
      )
      await dlg.getByText(/encurtado nesta visualização/).waitFor()
      await shot('attach-preview')
      await closeModal()
      // apaga o turno com anexos pela UI (os próximos passos seguem sem a imagem no histórico)
      for (let i = 0; i < 2; i++) {
        const row = page.locator('div.group\\/msg').last()
        await row.hover()
        await row.getByRole('button', { name: 'Apagar mensagem' }).click()
        await row.getByRole('button', { name: 'Apagar?' }).click()
        await sleep(400)
      }
      assert((await currentState()).msgs.length === n0, 'turno de anexos apagado')
      return `resposta: ${answer.trim().slice(0, 80)}`
    }
  )

  await step('bash → Permitir', async () => {
    await sendMessage('Run this exact shell command with the shell tool: expr hello-ui-allow')
    await page.getByRole('button', { name: /^(Permitir|Sim)$/ }).waitFor({ timeout: 60_000 })
    await page.getByText('Aguardando aprovação').first().waitFor()
    await shot('approval-card')
    await page.getByRole('button', { name: /^(Permitir|Sim)$/ }).click()
    await waitIdle()
    const card = toolCards('Terminal (shell)').last()
    await card.getByText('ok', { exact: true }).waitFor({ timeout: 5000 })
    await card.locator('div[role="button"]').click()
    await card
      .getByText(/hello-ui-allow/)
      .first()
      .waitFor({ timeout: 5000 })
    await shot('bash-allowed')
  })

  await step('bash → Negar', async () => {
    await sendMessage('Run this exact shell command with the shell tool: expr hello-ui-deny')
    await page.getByRole('button', { name: /^(Negar|Não)$/ }).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: /^(Negar|Não)$/ }).click()
    await waitIdle()
    await toolCards('Terminal (shell)').last().getByText('negada').waitFor({ timeout: 5000 })
    const { msgs } = await currentState()
    assert(
      msgs.some((m) => m.meta.toolStatus === 'denied' && /negou/.test(m.message.content)),
      'tool denied salvo'
    )
  })

  await step('bash → Sim + whitelist (lista global) e a próxima roda sem card', async () => {
    await sendMessage('Run this exact shell command with the shell tool: expr hello-ui-always')
    const btn = page.getByRole('button', { name: 'Sim + whitelist' })
    await btn.first().waitFor({ timeout: 60_000 })
    await btn.first().click()
    const input = page.getByRole('textbox', { name: 'Padrão da whitelist' })
    assert((await input.inputValue()) === 'expr *', `sugestão ${await input.inputValue()}`)
    await page.getByRole('button', { name: 'Salvar e permitir' }).click()
    await waitIdle()
    const st = await read<any>('approvals.getSettings')
    assert(st.lists.commands.allow.includes('expr *'), 'whitelist expr *')
    await shot('always')
    // os passos seguintes assumem o shell liberado neste chat (antes: "Sempre neste chat")
    const { chat } = await currentState()
    await read('chats.update', chat.id, { config: { approvalModes: { commands: 'always' } } })
  })

  await step('fila: mensagem durante execução vira chip e é injetada depois', async () => {
    await sendMessage('Run this exact shell command with the shell tool: sleep 6 && echo slept-ok')
    await toolCards('Terminal (shell)').last().getByText('executando').waitFor({ timeout: 60_000 })
    await sendMessage('Depois disso, responda apenas: FILA-OK')
    const chip = page.locator('p.line-clamp-2', { hasText: 'FILA-OK' })
    await chip.waitFor({ timeout: 5000 })
    await page.getByText('Na fila · enviadas no próximo passo do agente').waitFor()
    await shot('queued-chip')
    await waitIdle(90_000)
    await chip.waitFor({ state: 'detached', timeout: 5000 })
    await page.getByText('da fila').last().waitFor({ timeout: 5000 })
    const { msgs } = await currentState()
    const q = msgs.find((m) => m.meta.kind === 'queued')
    assert(q && /FILA-OK/.test(q.message.content), 'mensagem queued persistida')
    const qi = msgs.indexOf(q)
    const toolBefore = msgs
      .slice(0, qi)
      .reverse()
      .find((m) => m.message.role === 'tool')
    assert(
      /slept-ok/.test(toolBefore?.message.content ?? ''),
      'injetada depois do resultado da tool'
    )
    await shot('queued-injected')
  })

  await step('⚡ no chip interrompe e injeta já', async () => {
    await askLongBash('bash slow.sh')
    await sendMessage('Esqueça o comando. Responda apenas: FORCADO')
    await page.locator('p.line-clamp-2', { hasText: 'FORCADO' }).waitFor({ timeout: 5000 })
    const t0 = Date.now()
    await page.getByRole('button', { name: 'Enviar agora' }).click()
    await page.getByText('enviada agora (interrompeu o agente)').waitFor({ timeout: 10_000 })
    const took = Date.now() - t0
    await waitIdle()
    await toolCards('Terminal (shell)').last().getByText('interrompida').waitFor({ timeout: 5000 })
    const { msgs } = await currentState()
    assert(
      msgs.some((m) => m.meta.kind === 'forced'),
      'forced persistida'
    )
    assert(
      msgs.some((m) => m.meta.toolStatus === 'cancelled' && /Interrompido/.test(m.message.content)),
      'tool cancelada'
    )
    await shot('forced')
    return `injetada em ${took}ms`
  })

  await step('botão Parar', async () => {
    await askLongBash('bash slow.sh')
    const t0 = Date.now()
    await stopBtn().click()
    await waitIdle(15_000)
    await toolCards('Terminal (shell)').last().getByText('interrompida').waitFor({ timeout: 5000 })
    await page.getByPlaceholder('Mensagem…').waitFor()
    return `parou em ${Date.now() - t0}ms`
  })

  await step('delegate_task → subsessão (conversa direta) → volta', async () => {
    await sendMessage(
      'Use the delegate_task tool (title "listar arquivos") to ask a subagent to call list_dir on the working directory and report the file names. Then tell me the names.'
    )
    await waitIdle(180_000)
    const card = toolCards('Delegar a subagente').last()
    await card.getByRole('button', { name: 'Abrir subsessão' }).waitFor({ timeout: 5000 })
    // (i) do card de delegate descreve o que o subagente recebe
    const info = await tooltipText(
      card.getByRole('button', { name: 'O que é enviado para a API' }).first()
    )
    assert(
      /primeira mensagem/.test(info) && /system prompt de subagentes/.test(info),
      `(i) delegate: ${info}`
    )
    await shot('delegate-card')
    // abre pela troca de sessão
    await page.getByRole('button', { name: /\d+ sub/ }).click()
    await shot('session-switcher')
    await page.locator('button', { hasText: 'listar arquivos' }).last().click()
    await page.getByText('Conversando com o subagente').waitFor({ timeout: 5000 })
    // conversa direta com o subagente: composer próprio
    await page.locator('textarea[placeholder="Mensagem ao subagente…"]').waitFor({ timeout: 5000 })
    await page.getByText('readme.txt').first().waitFor({ timeout: 5000 })
    await page.getByText('Este subagente usa').waitFor({ timeout: 5000 })
    await sleep(500) // deixa as animações de entrada terminarem
    await shot('subsession')
    await page.getByRole('button', { name: 'Voltar à principal' }).click()
    await composer().waitFor({ timeout: 5000 })
  })

  await step('editar modelo/system prompt/params no meio do chat → Ver request', async () => {
    await ensurePanel('Modelo')
    const aside = page.locator('aside')
    await pickModel(aside.getByRole('combobox'), ALT_MODEL)
    await expand(aside, 'system-prompt')
    await expand(aside, 'params')
    const sp = aside.getByLabel('System prompt', { exact: true })
    await sp.click()
    await sp.press('End')
    await sp.pressSequentially(' [editado-e2e]')
    await aside.getByRole('switch', { name: 'Enviar temperature' }).click()
    const temp = aside.getByRole('spinbutton', { name: 'temperature', exact: true })
    await temp.fill('0.3')
    await shot('config-edited')
    const { body } = await openPreview()
    await shot('preview')
    assert(body.model === ALT_MODEL, `model ${body.model}`)
    assert(body.temperature === 0.3, `temperature ${body.temperature}`)
    const sys = body.messages[0].content[0].text as string
    assert(sys.includes('[editado-e2e]'), 'system editado no preview')
    await closeModal()
    // volta ao modelo barato e desliga temperature
    await pickModel(aside.getByRole('combobox'), MODEL)
    await aside.getByRole('switch', { name: 'Enviar temperature' }).click()
    const { body: b2 } = await openPreview()
    assert(b2.model === MODEL && b2.temperature === undefined, 'voltou')
    await closeModal()
  })

  await step('modo texto (tools nativas off + texto no prompt) roda tool', async () => {
    const aside = page.locator('aside')
    if (TEXT_MODEL !== MODEL) {
      await ensurePanel('Modelo')
      await pickModel(aside.getByRole('combobox'), TEXT_MODEL)
    }
    await ensurePanel('Tools')
    await expand(aside, 'tools-sending')
    await aside.getByRole('switch', { name: 'Enviar tools nativas' }).click()
    await aside.getByRole('switch', { name: 'Texto das tools no system prompt' }).click()
    try {
      const { body } = await openPreview()
      assert(!('tools' in body), 'sem campo tools')
      assert(
        /<tool_call>/.test(body.messages[0].content[0].text),
        'instruções <tool_call> no system'
      )
      await closeModal()
      // o modelo às vezes responde de memória (a pasta já foi listada antes): até 2 tentativas
      for (let i = 0; i < 2; i++) {
        await sendMessage(
          'Use the list_dir tool now on "." by writing a <tool_call> block exactly as instructed. After you get the result, reply with the file names.'
        )
        await waitIdle()
        if (
          (await currentState()).msgs.some(
            (m) => m.meta.synthetic && /<tool_result name="list_dir">/.test(m.message.content)
          )
        )
          break
      }
      await page.getByText('Resultado de tool (texto)').last().waitFor({ timeout: 5000 })
      const { msgs } = await currentState()
      assert(
        msgs.some(
          (m) => m.meta.synthetic && /<tool_result name="list_dir">/.test(m.message.content)
        ),
        'tool_result em texto'
      )
      await shot('text-mode')
    } finally {
      // restaura mesmo se falhar (senão os passos seguintes herdam o modo texto)
      await ensurePanel('Tools')
      await expand(aside, 'tools-sending')
      await aside.getByRole('switch', { name: 'Enviar tools nativas' }).click()
      await aside.getByRole('switch', { name: 'Texto das tools no system prompt' }).click()
      if (TEXT_MODEL !== MODEL) {
        await ensurePanel('Modelo')
        await pickModel(aside.getByRole('combobox'), MODEL)
      }
    }
  })

  await step('assinatura do app none/cline nos headers do Ver request', async () => {
    await ensurePanel('Chat')
    const aside = page.locator('aside')
    await expand(aside, 'signature')
    const sel = aside.locator('section', { hasText: 'Assinatura do app' }).locator('button.field')
    await sel.click()
    await page
      .locator('button', { hasText: /^Nenhuma/ })
      .last()
      .click()
    let { headers } = await openPreview()
    assert(
      !('X-Title' in headers) && !('HTTP-Referer' in headers),
      `none: ${JSON.stringify(headers)}`
    )
    assert(/…/.test(headers.Authorization) && !headers.Authorization.includes(KEY), 'key mascarada')
    await closeModal()
    await sel.click()
    await page
      .locator('button', { hasText: /^Cline/ })
      .last()
      .click()
    ;({ headers } = await openPreview())
    assert(headers['X-Title'] === 'Cline', `cline: ${JSON.stringify(headers)}`)
    await shot('preview-cline')
    await closeModal()
  })

  await step('Arquivos: raiz, navegação + Usar como raiz + preview + nova pasta', async () => {
    await ensurePanel('Arquivos')
    const aside = page.getByTestId('right-panel')
    await aside.getByText('notes.txt').waitFor({ timeout: 5000 })
    // breadcrumb começa na raiz (confinado): nada acima dela
    const crumbs = await aside.locator('nav button').allInnerTexts()
    assert(
      crumbs.length === 1 && crumbs[0].trim() === 'cwd',
      `breadcrumb ${JSON.stringify(crumbs)}`
    )
    await aside.locator('button', { hasText: /^sub$/ }).click()
    await aside.getByText('inner.txt').waitFor({ timeout: 5000 })
    await aside.getByRole('button', { name: 'Usar como raiz' }).click()
    await sleep(800)
    let { chat } = await currentState()
    assert(chat.config.cwd === join(CWD, 'sub'), `cwd ${chat.config.cwd}`)
    await aside.getByText('inner.txt').click()
    await aside.getByText('dentro da subpasta').waitFor({ timeout: 5000 })
    await shot('files-preview')
    await aside.getByRole('button', { name: 'Voltar' }).click()
    // raiz = sub: o breadcrumb não sobe; volta com "Escolher pasta…" (diálogo → pasta do e2e)
    assert(
      (await aside.locator('nav button', { hasText: /^cwd$/ }).count()) === 0,
      'não sobe da raiz'
    )
    await aside.getByRole('button', { name: 'Escolher pasta…' }).click()
    await aside.getByText('notes.txt').waitFor({ timeout: 5000 })
    await sleep(800)
    ;({ chat } = await currentState())
    assert(chat.config.cwd === CWD, `cwd ${chat.config.cwd}`)
    // nova pasta dentro da pasta atual
    await aside.getByRole('button', { name: 'Nova pasta…' }).click()
    await aside.getByLabel('Nome da nova pasta').fill('criada-na-aba')
    await aside.getByLabel('Nome da nova pasta').press('Enter')
    await aside.getByText('Pasta vazia').waitFor({ timeout: 5000 })
    assert(existsSync(join(CWD, 'criada-na-aba')), 'pasta criada')
    await aside.locator('nav button').first().click()
    await aside.getByText('notes.txt').waitFor({ timeout: 5000 })
    await shot('files')
  })

  await step('configurações: editar provider', async () => {
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Editar' }).first().click()
    const name = dlg.locator('input.field').first()
    await name.fill('OpenRouter E2E')
    await dlg.getByRole('button', { name: 'Salvar' }).click()
    await dlg.getByText('OpenRouter E2E').waitFor({ timeout: 5000 })
    await shot('settings')
    await closeModal()
    const ps = await read<any[]>('providers.list')
    assert(
      ps[0].name === 'OpenRouter E2E' && ps[0].apiKey === KEY,
      'provider editado, key preservada'
    )
  })

  let fakeId = ''
  let orId = ''

  await step(
    'dois provedores: grupos, recolher, busca em ambos, modelo do grupo 2 → Ver request/pílula',
    async () => {
      // adiciona o provedor falso (local) e um quebrado (porta fechada) pela UI
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Provedores', exact: true }).click()
      for (const [name, url, key] of [
        ['Local Fake', fakeBase, FAKE_KEY],
        ['Quebrado', 'http://127.0.0.1:9/v1', '']
      ]) {
        await dlg.getByRole('button', { name: 'Adicionar provedor' }).click()
        await dlg.locator('input.field').nth(0).fill(name)
        await dlg.locator('input.field').nth(1).fill(url)
        if (key) await dlg.locator('input[type="password"]').fill(key)
        await dlg.getByRole('button', { name: 'Adicionar', exact: true }).click()
        // o rótulo agora traz o tipo ao lado ("Local Fake OpenAI-compatible (genérico)")
        await dlg.getByText(name).first().waitFor({ timeout: 5000 })
      }
      assert(
        (await dlg.getByText('padrão', { exact: true }).count()) === 0,
        'provedores sem "padrão"'
      )
      await closeModal()
      const ps = await read<any[]>('providers.list')
      fakeId = ps.find((p) => p.name === 'Local Fake').id
      orId = ps.find((p) => p.name.startsWith('OpenRouter')).id

      await ensurePanel('Modelo')
      const aside = page.getByTestId('right-panel')
      assert(
        (await aside.getByText('Provedor', { exact: true }).count()) === 0,
        'sem seletor de provedor separado'
      )
      await aside.getByRole('combobox').click()
      const list = page.getByRole('listbox', { name: 'Modelos' })
      const group = (name: string): Locator =>
        page.locator(`[data-testid="model-group"][data-provider^="${name}"]`).first()
      const opt = (provider: string, id: string): Locator =>
        list.locator(`[role=option][data-provider^="${provider}"][data-model="${id}"]`)
      // o grupo da seleção atual (OpenRouter) vem aberto, centrado na seleção marcada
      await group('OpenRouter').waitFor()
      await opt('OpenRouter', MODEL).waitFor({ timeout: 15_000 })
      assert((await opt('OpenRouter', MODEL).getAttribute('aria-selected')) === 'true', 'seleção')
      await sleep(150)
      await shot('picker-expanded')
      // recolher o OpenRouter → os outros grupos aparecem
      await group('OpenRouter').click()
      assert((await group('OpenRouter').getAttribute('aria-expanded')) === 'false', 'recolhido')
      assert(
        (await list.locator('[role=option][data-provider^="OpenRouter"]').count()) === 0,
        'sem opções'
      )
      await group('Local Fake').waitFor()
      await group('Quebrado').waitFor()
      await opt('Local Fake', FAKE_MODEL).waitFor({ timeout: 10_000 })
      // o quebrado mostra erro com "tentar de novo" sem atrapalhar os outros
      await list.getByRole('button', { name: 'tentar de novo' }).waitFor({ timeout: 20_000 })
      const groupsText = await page
        .locator('[data-testid="model-group"]')
        .evaluateAll((els) => els.map((e) => e.textContent))
      assert(
        groupsText.some((t) => /Local Fake\s*3/.test(t ?? '')),
        `contagem: ${groupsText.join(' | ')}`
      )
      await sleep(150)
      await shot('picker-collapsed')
      // a busca atravessa todos os grupos (inclusive o recolhido): o mesmo id nos dois
      const search = page.getByRole('textbox', { name: 'Buscar modelo' })
      await search.fill(MODEL.split('/').pop()!)
      await opt('Local Fake', MODEL).waitFor({ timeout: 5000 })
      await opt('OpenRouter', MODEL).waitFor({ timeout: 5000 })
      await group('Local Fake').waitFor()
      await shot('picker-search')
      // teclado: ↓ percorre só opções (pula cabeçalhos); Esc fecha
      await search.press('ArrowDown')
      await search.press('Escape')
      await list.waitFor({ state: 'detached', timeout: 3000 })
      // escolhe o modelo no grupo 2 (mesmo id, outro provedor)
      await aside.getByRole('combobox').click()
      await page.getByRole('textbox', { name: 'Buscar modelo' }).fill(MODEL)
      await opt('Local Fake', MODEL).click()
      await list.waitFor({ state: 'detached', timeout: 3000 })
      await aside.getByTestId('model-picker-provider').getByText('Local Fake').waitFor()
      await page.getByTestId('model-pill-provider').getByText('Local Fake').waitFor()
      await shot('picked-group-2')
      const { url, headers, body } = await openPreview()
      assert(url === `${fakeBase}/chat/completions`, `url ${url}`)
      assert(
        /^Bearer /.test(headers.Authorization) && !headers.Authorization.includes(FAKE_KEY),
        `auth mascarada: ${headers.Authorization}`
      )
      assert(body.model === MODEL, `model ${body.model}`)
      await closeModal()
      await sleep(600)
      const { chat } = await currentState()
      assert(chat.config.providerId === fakeId && chat.config.model === MODEL, 'par salvo no chat')
      // subsessões criadas antes continuam no provedor delas
      const subs = (await read<any[]>('sessions.list', chat.id)).filter((x) => x.depth > 0)
      assert(subs.length > 0, 'há subsessões')
      assert(
        subs.every((x) => x.providerId === orId),
        `subsessões: ${subs.map((x) => x.providerId)}`
      )
      // a próxima request vai mesmo para o provedor novo
      const before = fakeHits.length
      await sendMessage('Diga oi (provedor falso)')
      await waitIdle(30_000)
      await page.getByText('FAKE-OK').last().waitFor({ timeout: 10_000 })
      const hit = fakeHits[before]
      assert(hit, 'request chegou ao provedor falso')
      assert(hit.url === '/v1/chat/completions', `path ${hit.url}`)
      assert(hit.auth === `Bearer ${FAKE_KEY}`, 'key do provedor falso')
      assert(hit.body.model === MODEL && hit.body.stream === true, 'model/stream')
      // reabrir: o OpenRouter continua recolhido (lembrado) e o grupo da seleção aberto
      await aside.getByRole('combobox').click()
      await group('OpenRouter').waitFor()
      assert(
        (await group('OpenRouter').getAttribute('aria-expanded')) === 'false',
        'recolhimento lembrado'
      )
      assert(
        (await opt('Local Fake', MODEL).getAttribute('aria-selected')) === 'true',
        'seleção no grupo 2'
      )
      await group('OpenRouter').click() // expande de volta
      await page.keyboard.press('Escape')
      // volta ao OpenRouter: a request seguinte vai para lá
      await pickModel(aside.getByRole('combobox'), MODEL, 'OpenRouter')
      await page
        .getByTestId('model-pill-provider')
        .getByText(/OpenRouter/)
        .waitFor()
      const p2 = await openPreview()
      assert(p2.url.startsWith('https://openrouter.ai/api/v1/'), `url ${p2.url}`)
      await closeModal()
      return `fake: ${fakeBase}`
    }
  )

  await step(
    'subagente em outro provedor: list_models de todos + delegate_task provider → request no outro',
    async () => {
      // principal no OpenRouter (passo anterior voltou para lá); o subagente vai para o Local Fake
      const { chat, sid } = await currentState()
      assert(chat.config.providerId === orId, 'principal no OpenRouter')
      // tools nativas (independe de um passo anterior ter falhado no meio do modo texto)
      const enabled: string[] = chat.config.enabledTools
      await read('chats.update', chat.id, {
        config: {
          nativeTools: true,
          toolsInPrompt: false,
          enabledTools: [...new Set([...enabled, 'list_models', 'delegate_task'])]
        }
      })
      const before = fakeHits.length
      const nMsgs = (await read<any[]>('sessions.messages', sid)).length
      await sendMessage(
        // query = id do MODEL (antes "nano", que só casava com o gpt-4.1-nano)
        'Do exactly these two tool calls in order. 1) Call list_models with only query "' +
          MODEL.split('/').pop() +
          '" (no provider argument, so it lists every provider). ' +
          '2) Call delegate_task with provider "Local Fake", model "' +
          MODEL +
          '", title "via fake" and task "Reply with the word PONG.". ' +
          'Then reply with the subagent result only.'
      )
      await waitIdle(180_000)
      const msgs = (await read<any[]>('sessions.messages', sid)).slice(nMsgs)
      const toolRes = (name: string): any => {
        const call = msgs
          .flatMap((m) => m.message.tool_calls ?? [])
          .filter((t: any) => t.function.name === name)
          .at(-1)
        return call && msgs.find((m) => m.message.tool_call_id === call.id)
      }
      // list_models: seções por provedor, o quebrado inline
      const lm = toolRes('list_models')
      assert(lm && lm.meta.toolStatus === 'ok', `list_models: ${lm?.message.content}`)
      const lmText: string = lm.message.content
      const lmArgs = JSON.parse(
        msgs
          .flatMap((m) => m.message.tool_calls ?? [])
          .find((t: any) => t.id === lm.message.tool_call_id).function.arguments || '{}'
      )
      if (lmArgs.provider) {
        // o modelo filtrou por conta própria (há enum de provedores): formato de um provedor só
        assert(
          new RegExp(`no provedor ${lmArgs.provider}`, 'i').test(lmText.split('\n')[0]),
          `cabeçalho filtrado: ${lmText.slice(0, 200)}`
        )
      } else {
        assert(
          /^\[modelos de 3 provedores — OpenRouter/.test(lmText),
          `cabeçalho: ${lmText.slice(0, 200)}`
        )
        assert(lmText.includes('[Local Fake]') && lmText.includes(MODEL), 'seção Local Fake')
        assert(/\[Quebrado\] erro ao listar/.test(lmText), 'quebrado inline')
      }
      // delegate_task: subsessão no Local Fake, request chegou lá
      const del = toolRes('delegate_task')
      assert(del && del.meta.toolStatus === 'ok', `delegate: ${del?.message.content}`)
      assert(/FAKE-OK/.test(del.message.content), `resultado: ${del.message.content}`)
      const sub = (await read<any[]>('sessions.list', chat.id)).find(
        (x) => x.id === del.meta.subSessionId
      )
      assert(sub && sub.providerId === fakeId && sub.model === MODEL, `sub: ${JSON.stringify(sub)}`)
      const hits = fakeHits.slice(before)
      assert(hits.length === 1, `requests no falso: ${hits.length}`)
      assert(hits[0].auth === `Bearer ${FAKE_KEY}` && hits[0].body.model === MODEL, 'key/model')
      assert(
        JSON.stringify(hits[0].body.messages).includes('PONG'),
        'a tarefa do subagente foi para o falso'
      )
      // o card e o seletor mostram "<Provedor> · <modelo>"
      const card = toolCards('Delegar a subagente').last()
      await card.getByText('Local Fake').waitFor({ timeout: 5000 })
      await page.getByRole('button', { name: /\d+ sub/ }).click()
      await page
        .locator('button', { hasText: 'via fake' })
        .last()
        .getByText('Local Fake')
        .waitFor({ timeout: 5000 })
      await shot('cross-provider-subagent')
      await page.keyboard.press('Escape')
      return `sub ${sub.id.slice(0, 8)} → ${hits[0].url}`
    }
  )

  await step(
    'Novos chats: modelo padrão (par) · persona com provedor apagado → aviso · provedor apagado = não definido',
    async () => {
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Novos chats', exact: true }).click()
      assert((await dlg.getByText('Provedor padrão').count()) === 0, 'sem "Provedor padrão"')
      await dlg
        .getByRole('combobox')
        .getByText(/Não definido/)
        .waitFor({ timeout: 5000 })
      await pickModel(dlg.getByRole('combobox'), FAKE_MODEL, 'Local Fake')
      await dlg.getByTestId('model-picker-provider').getByText('Local Fake').waitFor()
      await sleep(300)
      assert((await read('settings.get', 'defaultProviderId')) === fakeId, 'defaultProviderId')
      assert((await read('settings.get', 'defaultModel')) === FAKE_MODEL, 'defaultModel')
      await shot('settings-default-model')
      // persona com o modelo do provedor falso
      await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
      await dlg.getByRole('button', { name: 'Nova persona' }).click()
      const ed = dlg.getByTestId('preset-editor')
      await ed.getByLabel('Nome da persona').fill('Fake persona')
      await expand(ed, 'model')
      await ed.getByText('padrão de “Novos chats”').waitFor()
      await pickModel(ed.getByRole('combobox'), 'fake/other-2', 'Local Fake')
      await ed.getByText('desta persona', { exact: true }).waitFor()
      await ed.getByRole('button', { name: 'Criar persona' }).click()
      await presetRow('Fake persona').waitFor({ timeout: 5000 })
      const fp = (await read<any[]>('presets.list')).find((x) => x.name === 'Fake persona')
      assert(
        fp.config.providerId === fakeId && fp.config.model === 'fake/other-2',
        `par na persona: ${fp.config.providerId} ${fp.config.model}`
      )
      // Novo chat com a "Padrão" segue o par padrão
      await closeModal()
      await page.getByRole('button', { name: 'Novo chat' }).first().click()
      await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 10_000 })
      await page
        .getByTestId('model-picker-provider')
        .getByText('Local Fake')
        .waitFor({ timeout: 5000 })
      // apaga os provedores falso e quebrado
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      await dlg.getByRole('button', { name: 'Provedores', exact: true }).click()
      for (const name of ['Local Fake', 'Quebrado']) {
        const row = dlg
          .locator('div.group')
          .filter({ has: page.getByText(new RegExp(`^${name}OpenAI-compatible`)) })
        await row.hover()
        await row.getByRole('button', { name: 'Remover' }).click()
        await row.getByRole('button', { name: 'Remover?' }).click()
        await row.waitFor({ state: 'detached', timeout: 5000 })
      }
      await dlg.getByRole('button', { name: 'Novos chats', exact: true }).click()
      await dlg
        .getByRole('combobox')
        .getByText(/Não definido/)
        .waitFor({ timeout: 5000 })
      await closeModal()
      // persona cujo provedor sumiu → par padrão (não definido) + aviso
      const picker = page.getByTestId('preset-picker')
      await picker.click()
      await page.getByRole('option', { name: /Fake persona/ }).click()
      await page.getByTestId('preset-provider-missing').waitFor({ timeout: 5000 })
      await page.getByRole('combobox').getByText('Escolha um modelo…').waitFor()
      await shot('preset-provider-missing')
      // limpa: apaga a persona e volta à "Padrão"
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
      const row = presetRow('Fake persona')
      await row.hover()
      await row.getByRole('button', { name: 'Apagar' }).click()
      await row.getByRole('button', { name: 'Apagar?' }).click()
      await row.waitFor({ state: 'detached', timeout: 5000 })
      await closeModal()
      // o chat que usou o falso continua com OpenRouter (voltamos antes); volta para ele
      const { chat } = await currentState()
      assert(chat.config.providerId === orId, 'chat no OpenRouter')
      await page.locator('nav').getByText(chat.title).first().click()
      await composer().waitFor({ timeout: 10_000 })
    }
  )

  await step('editar (nova versão) / apagar mensagem, regenerar', async () => {
    await ensurePanel('Modelo')
    // editar a primeira mensagem do usuário = NOVA VERSÃO (a original continua salva) + o agente roda
    const firstUser = page.locator('div.group\\/msg').filter({ hasText: 'Use write_file' }).first()
    await firstUser.hover()
    await firstUser.getByRole('button', { name: 'Editar' }).click()
    // durante a edição o texto vira o valor do textarea do editor inline
    const ed = page.locator('div.group\\/msg textarea').first()
    const send = page.getByRole('button', { name: 'Enviar', exact: true })
    assert(await send.isDisabled(), 'Enviar desabilitado sem mudança')
    await ed.fill('Mensagem editada pelo e2e')
    await send.click()
    await page.getByText('Mensagem editada pelo e2e').waitFor({ timeout: 5000 })
    await waitIdle()
    let { msgs } = await currentState()
    assert(
      msgs.some((m) => m.message.content === 'Mensagem editada pelo e2e') &&
        msgs.some(
          (m) =>
            typeof m.message.content === 'string' && m.message.content.includes('Use write_file')
        ),
      'nova versão salva e a original mantida'
    )
    const edited = page
      .locator('div.group\\/msg')
      .filter({ hasText: 'Mensagem editada pelo e2e' })
      .first()
      .getByTestId('branch-switcher')
    assert((await edited.getAttribute('aria-label')) === 'Versão 2 de 2', '‹ 2/2 ›')
    await shot('branch-edited')
    // volta à versão original (o resto do passo usa a fila dela)
    await edited.getByRole('button', { name: 'Versão anterior' }).click()
    await page.getByText('FILA-OK').first().waitFor({ timeout: 5000 })
    // apagar a mensagem "da fila"
    const queued = page.locator('div.group\\/msg').filter({ hasText: 'FILA-OK' }).first()
    await queued.hover()
    await queued.getByRole('button', { name: 'Apagar mensagem' }).click()
    await queued.getByRole('button', { name: 'Apagar?' }).click()
    await sleep(500)
    ;({ msgs } = await currentState())
    assert(!msgs.some((m) => m.meta.kind === 'queued'), 'mensagem apagada')
    // regenerar a última resposta
    await sendMessage('Responda apenas: REGEN-BASE')
    await waitIdle()
    const before = (await currentState()).msgs.at(-1)
    const last = page.locator('div.group\\/msg').last()
    await last.hover()
    await last.getByRole('button', { name: 'Regenerar resposta' }).click()
    await sleep(500)
    await waitIdle()
    const after = (await currentState()).msgs.at(-1)
    assert(after.id !== before.id && after.message.role === 'assistant', 'regenerado')
    await shot('regenerated')
  })

  await step(
    'contexto: banner (janela pequena) → Compactar → divisor + resumo → Ver request',
    async () => {
      await ensurePanel('Modelo')
      const aside = page.locator('aside')
      await page.getByTestId('context-meter').click() // abre a aba Chat e rola até Contexto
      assert((await panelTab('Chat').getAttribute('aria-selected')) === 'true', 'aba Chat')
      await expand(aside, 'compaction')
      await aside.getByRole('switch', { name: 'Definir janela manualmente' }).click()
      const win = aside.getByRole('spinbutton', { name: 'Janela de contexto (tokens)' })
      await win.fill('1000')
      const banner = page.getByTestId('compact-banner')
      await banner.waitFor({ timeout: 10_000 })
      const bt = await banner.innerText()
      assert(/Contexto em \d+%/.test(bt), `banner: ${bt}`)
      await shot('context-banner')
      const before = (await currentState()).msgs.length
      await banner.getByRole('button', { name: 'Compactar conversa' }).click()
      // modelos com reasoning (ex.: glm-5.3-flash) podem levar minutos para resumir ~7k tokens
      await page.getByTestId('compaction-card').first().waitFor({ timeout: 240_000 })
      await waitIdle(240_000)
      await page.getByTestId('compaction-divider').waitFor({ timeout: 5000 })
      const div = await page.getByTestId('compaction-divider').innerText()
      assert(
        /Conversa compactada/.test(div) && /não são mais enviadas à API/.test(div),
        `divisor: ${div}`
      )
      const { msgs } = await currentState()
      assert(
        msgs.length === before + 1 && msgs.at(-1).meta.kind === 'compaction',
        'fronteira salva'
      )
      // (i) do resumo
      const card = page.getByTestId('compaction-card').last()
      const info = await tooltipText(
        card.getByRole('button', { name: 'O que é enviado para a API' })
      )
      assert(/role: "user"/.test(info) && /início do histórico/.test(info), `(i) resumo: ${info}`)
      assert((await banner.count()) === 0, 'banner some após compactar')
      const mt = await page.getByTestId('context-meter').innerText()
      assert(mt.trim().startsWith('~'), `medidor estimado: ${mt}`)
      await shot('compacted')
      // Ver request: system + resumo apenas
      const { body } = await openPreview()
      assert(body.messages.length === 2, `request com ${body.messages.length} mensagens`)
      const t = body.messages[1].content
      const txt = Array.isArray(t) ? t.map((p: any) => p.text).join('') : t
      assert(txt.startsWith('<conversation_summary>'), 'resumo é a 1ª mensagem do histórico')
      await shot('preview-compacted')
      await closeModal()
      // recolher/expandir a parte antiga
      await page.getByTestId('compaction-divider').getByRole('button', { name: 'Ocultar' }).click()
      assert((await page.getByTestId('compacted-old').count()) === 0, 'parte antiga recolhida')
      await page.getByTestId('compaction-divider').getByRole('button', { name: 'Mostrar' }).click()
      await page.getByTestId('compacted-old').waitFor({ timeout: 3000 })
      await aside.getByRole('switch', { name: 'Definir janela manualmente' }).click()
      // conversa continua depois da compactação
      await sendMessage('Responda apenas: POS-COMPACTACAO')
      await waitIdle()
      await page.getByText('POS-COMPACTACAO').last().waitFor({ timeout: 5000 })
    }
  )

  await step('erro HTTP persistido ((i) "não é enviado à API")', async () => {
    await ensurePanel('Modelo')
    const aside = page.locator('aside')
    await pickModel(aside.getByRole('combobox'), 'invalid-vendor/modelo-que-nao-existe')
    await sendMessage('isto deve falhar')
    await waitIdle(30_000)
    const err = page.locator('div.group\\/msg', { has: page.locator('.text-danger') }).last()
    await err.waitFor({ timeout: 10_000 })
    await err.hover()
    const info = await tooltipText(err.getByRole('button', { name: 'O que é enviado para a API' }))
    assert(/Não é enviado à API/.test(info), `(i) do erro: ${info}`)
    const { msgs } = await currentState()
    assert(msgs.at(-1).meta.kind === 'error', 'erro persistido')
    const { body } = await openPreview()
    assert(!JSON.stringify(body.messages).includes(msgs.at(-1).meta.error), 'erro fora da request')
    await closeModal()
    await shot('error-persisted')
    await pickModel(aside.getByRole('combobox'), MODEL)
    await sleep(600)
  })

  await step('reinício: chats e mensagens persistem', async () => {
    await ensurePanel('Chat') // a aba do painel sobrevive ao reinício
    const before = await currentState()
    await app.close()
    await launch()
    await page.locator('aside, nav').first().waitFor({ timeout: 30_000 })
    await page.getByText(before.chat.title).first().click()
    await page.getByText('Mensagem editada pelo e2e').waitFor({ timeout: 10_000 })
    await page.locator('.text-danger').first().waitFor({ timeout: 5000 }) // erro persistido
    const after = await currentState()
    assert(
      after.msgs.length === before.msgs.length,
      `msgs ${before.msgs.length} → ${after.msgs.length}`
    )
    assert((await panelTab('Chat').getAttribute('aria-selected')) === 'true', 'aba lembrada')
    await shot('after-restart')
  })

  await step('Novo chat → Nova pasta… vira o diretório raiz', async () => {
    await page.getByRole('button', { name: 'Novo chat' }).first().click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: /Alterar/ }).click() // diálogo → pasta do e2e
    await page.getByTestId('new-chat-root').getByText('cwd').waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: 'Nova pasta…' }).click()
    await page.getByLabel('Nome da nova pasta').fill('projeto-ui')
    await shot('new-folder')
    await page.getByRole('button', { name: 'Criar', exact: true }).click()
    await page
      .getByTestId('new-chat-root')
      .getByText(/projeto-ui/)
      .waitFor({ timeout: 5000 })
    assert(existsSync(join(CWD, 'projeto-ui')), 'pasta criada no disco')
    await pickModel(page.getByRole('combobox'), MODEL)
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 10_000 })
    const chats = await read<any[]>('chats.list')
    assert(
      chats.some((c) => c.config.cwd === join(CWD, 'projeto-ui')),
      'chat com raiz na pasta nova'
    )
    await ensurePanel('Arquivos')
    await page
      .getByTestId('right-panel')
      .locator('nav button')
      .first()
      .getByText('projeto-ui')
      .waitFor({ timeout: 5000 })
    await shot('new-folder-chat')
  })

  let revisorId = ''

  await step('persona: Novo chat → editar campos → Salvar como persona', async () => {
    await page.getByRole('button', { name: 'Novo chat' }).first().click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 10_000 })
    const picker = page.getByTestId('preset-picker')
    await picker.getByText('Padrão', { exact: true }).waitFor({ timeout: 5000 })
    // a lista mostra a persona "Padrão" criada na primeira execução
    await picker.click()
    await page.getByRole('option', { name: /Padrão/ }).waitFor()
    await page.keyboard.press('Escape')
    assert(
      (await page.getByRole('button', { name: /Salvar como persona/ }).count()) === 0,
      'sem botão antes de editar'
    )
    // trocar a pasta não personaliza (a "Padrão" não define diretório raiz)
    await page.getByRole('button', { name: /Alterar/ }).click() // diálogo → pasta do e2e
    await page.getByTestId('new-chat-root').getByText('cwd').waitFor({ timeout: 5000 })
    assert((await picker.getByText('Personalizado').count()) === 0, 'pasta não personaliza')
    await pickModel(page.getByRole('combobox'), MODEL)
    await page
      .getByPlaceholder('Instruções para o modelo (opcional)')
      .fill('Você é o revisor do e2e. Responda em uma linha.')
    await picker.getByText('Personalizado').waitFor({ timeout: 3000 })
    await picker.getByText('a partir de Padrão').waitFor()
    await shot('preset-customized')
    await page.getByRole('button', { name: /Salvar como persona/ }).click()
    const dlg = page.getByRole('dialog')
    assert(
      (await dlg.getByRole('radio', { name: 'Nova persona' }).getAttribute('aria-checked')) ===
        'true',
      'modo nova persona'
    )
    await dlg.getByLabel('Nome da persona').fill('Revisor E2E')
    await dlg.getByRole('button', { name: 'Escolher ícone' }).click()
    await dlg.getByRole('button', { name: 'Ícone code' }).click()
    await dlg.getByLabel('Descrição da persona').fill('Persona criada pelo e2e')
    const cwdSwitch = dlg.getByRole('switch', { name: 'Incluir diretório raiz' })
    assert((await cwdSwitch.getAttribute('aria-checked')) === 'false', 'cwd desligado por padrão')
    await shot('preset-save-dialog')
    await dlg.getByRole('button', { name: 'Salvar persona' }).click()
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    await picker.getByText('Revisor E2E', { exact: true }).waitFor({ timeout: 5000 })
    assert((await picker.getByText('Personalizado').count()) === 0, 'não é mais personalizado')
    const presets = await read<any[]>('presets.list')
    const p = presets.find((x) => x.name === 'Revisor E2E')
    assert(p, 'persona salva')
    revisorId = p.id
    assert(p.icon === 'code' && p.description === 'Persona criada pelo e2e', 'ícone/descrição')
    assert(p.config.model === MODEL, `modelo ${p.config.model}`)
    assert(p.config.systemPrompt.startsWith('Você é o revisor do e2e'), 'system prompt')
    assert(!('cwd' in p.config), 'sem cwd')
    await shot('preset-saved')
  })

  await step('persona: começar chat a partir dela + salvar do painel (aba Chat)', async () => {
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 10_000 })
    const chats = await read<any[]>('chats.list')
    const chat = chats.find((c) => c.config.presetId === revisorId)
    assert(chat, 'chat lembra a persona de origem')
    assert(chat.config.systemPrompt.startsWith('Você é o revisor do e2e'), 'system do chat')
    assert(chat.config.model === MODEL, 'modelo do chat')
    await ensurePanel('Chat')
    const aside = page.getByTestId('right-panel')
    await aside.getByTestId('chat-preset').getByText('Revisor E2E').waitFor({ timeout: 5000 })
    // título editável no cabeçalho do chat (clique → campo)
    await page.getByTestId('chat-title').click()
    await page.getByLabel('Título do chat').fill('Chat da persona E2E')
    await page.getByLabel('Título do chat').press('Enter')
    await page.locator('nav').getByText('Chat da persona E2E').waitFor({ timeout: 5000 })
    // ajusta um parâmetro e salva o chat como outra persona, com o diretório raiz
    await ensurePanel('Modelo')
    await expand(aside, 'params')
    await aside.getByRole('switch', { name: 'Enviar temperature' }).click()
    await aside.getByRole('spinbutton', { name: 'temperature', exact: true }).fill('0.4')
    await ensurePanel('Chat')
    await aside.getByRole('button', { name: 'Salvar como persona' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('radio', { name: 'Atualizar “Revisor E2E”' }).waitFor()
    await dlg.getByLabel('Nome da persona').fill('Do painel E2E')
    await dlg.getByRole('switch', { name: 'Incluir diretório raiz' }).click()
    await dlg.getByRole('button', { name: 'Salvar persona' }).click()
    await dlg.waitFor({ state: 'detached', timeout: 5000 })
    await aside.getByTestId('chat-preset').getByText('Do painel E2E').waitFor({ timeout: 5000 })
    const p = (await read<any[]>('presets.list')).find((x) => x.name === 'Do painel E2E')
    assert(p, 'persona do painel salva')
    assert(p.config.params.temperature === 0.4, `params ${JSON.stringify(p.config.params)}`)
    assert(p.config.cwd === CWD, `cwd ${p.config.cwd}`)
    assert(
      Array.isArray(p.config.enabledTools) && p.config.enabledTools.length > 0,
      'snapshot completo'
    )
    assert(!('presetId' in p.config), 'presetId não vai na persona')
    await sleep(600)
    const c2 = (await read<any[]>('chats.list')).find((c) => c.id === chat.id)
    assert(c2.config.presetId === p.id, 'chat passa a apontar para a nova persona')
  })

  await step('persona: editar nas Configurações (Modelo + Tools)', async () => {
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
    await presetRow('Padrão').waitFor({ timeout: 5000 })
    await presetRow('Revisor E2E').getByRole('button', { name: 'Editar' }).click()
    const ed = dlg.getByTestId('preset-editor')
    await ed.getByLabel('Nome da persona').fill('Revisor E2E 2')
    await expand(ed, 'system-prompt')
    await ed.getByLabel('System prompt', { exact: true }).fill('System editado nas configurações.')
    await shot('preset-editor')
    await ed.getByRole('tab', { name: 'Tools' }).click()
    await ed.getByRole('switch', { name: 'Terminal (shell)' }).first().click()
    await shot('preset-editor-tools')
    await ed.getByRole('button', { name: 'Salvar persona' }).click()
    await presetRow('Revisor E2E 2').waitFor({ timeout: 5000 })
    const p = (await read<any[]>('presets.list')).find((x) => x.id === revisorId)
    assert(p.name === 'Revisor E2E 2', `nome ${p.name}`)
    assert(p.config.systemPrompt === 'System editado nas configurações.', 'system editado')
    assert(
      Array.isArray(p.config.enabledTools) && !p.config.enabledTools.includes('shell'),
      `tools ${JSON.stringify(p.config.enabledTools)}`
    )
    assert(p.config.model === MODEL, 'modelo mantido')
    await shot('preset-list')
  })

  await step('persona: duplicar, definir padrão → Novo chat já vem com ela', async () => {
    await presetRow('Revisor E2E 2').getByRole('button', { name: 'Duplicar' }).click()
    await presetRow('Revisor E2E 2 (cópia)').waitFor({ timeout: 5000 })
    await presetRow('Revisor E2E 2').getByRole('button', { name: 'Definir como padrão' }).click()
    await presetRow('Revisor E2E 2').getByText('padrão', { exact: true }).waitFor({ timeout: 3000 })
    const def = await read<string>('settings.get', 'defaultPresetId')
    assert(def === revisorId, `defaultPresetId ${def}`)
    await closeModal()
    await page.getByRole('button', { name: 'Novo chat' }).first().click()
    const picker = page.getByTestId('preset-picker')
    await picker.getByText('Revisor E2E 2', { exact: true }).waitFor({ timeout: 5000 })
    const sp = await page.getByPlaceholder('Instruções para o modelo (opcional)').inputValue()
    assert(sp === 'System editado nas configurações.', `system no Novo chat: ${sp}`)
    await shot('preset-default-new-chat')
  })

  await step('persona: apagar (padrão volta para "Padrão")', async () => {
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
    for (const name of ['Revisor E2E 2', 'Revisor E2E 2 (cópia)', 'Do painel E2E']) {
      const row = presetRow(name)
      await row.hover()
      await row.getByRole('button', { name: 'Apagar' }).click()
      await row.getByRole('button', { name: 'Apagar?' }).click()
      await row.waitFor({ state: 'detached', timeout: 5000 })
    }
    const presets = await read<any[]>('presets.list')
    assert(
      presets.length === 1 && presets[0].name === 'Padrão',
      `restou ${presets.map((p) => p.name)}`
    )
    assert((await read('settings.get', 'defaultPresetId')) === null, 'padrão limpo')
    await closeModal()
    await page
      .getByTestId('preset-picker')
      .getByText('Padrão', { exact: true })
      .waitFor({ timeout: 5000 })
    // o chat criado da persona apagada continua funcionando (presetId só informativo)
    await page.getByText('Chat da persona E2E').first().click()
    await composer().waitFor({ timeout: 10_000 })
    await ensurePanel('Chat')
    await page.getByTestId('chat-preset').getByText('(persona apagada)').waitFor({ timeout: 5000 })
  })

  await step('indicador global de aprovação pendente (subagente pede bash)', async () => {
    await page.getByRole('button', { name: 'Novo chat' }).first().click()
    await pickModel(page.getByRole('combobox'), MODEL)
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 10_000 })
    await sendMessage(
      // mkdir (não expr/echo): `expr *` foi para a whitelist no passo "Sim + whitelist" e echo/printf são
      // só leitura (sempre liberados, 0.8.5) — precisa de algo que pergunte
      'Use the delegate_task tool to ask a subagent to run the bash command "mkdir -p sub-approval-ok && echo sub-approval-ok" with its shell tool and report the output. Then tell me the output.'
    )
    // o indicador do topo é só para OUTROS chats; aqui a aprovação do subagente fica no card do
    // delegate (visível) — ou na fila acima do composer se o card estiver fora da tela
    const indicator = page.getByTestId('approval-indicator')
    const delegateCard = toolCards('Delegar a subagente').first()
    await page.getByText('Permitir que o subagente execute').first().waitFor({ timeout: 90_000 })
    await shot('subagent-approval-in-chat')
    await delegateCard.getByRole('button', { name: 'Abrir subsessão' }).click()
    await page.getByText('Conversando com o subagente').waitFor({ timeout: 5000 })
    await shot('subagent-approval')
    await page.getByRole('button', { name: /^(Permitir|Sim)$/ }).click()
    await page.getByRole('button', { name: 'Voltar à principal' }).click()
    await composer().waitFor({ timeout: 5000 })
    // o modelo pode delegar mais de uma vez: aprova pelo card da principal
    const t0 = Date.now()
    while ((await stopBtn().count()) && Date.now() - t0 < 120_000) {
      const allow = page.getByRole('button', { name: /^(Permitir|Sim)$/ })
      if (await allow.count()) await allow.first().click()
      await sleep(500)
    }
    await waitIdle(10_000)
    await page
      .getByText(/sub-approval-ok/)
      .last()
      .waitFor({ timeout: 10_000 })
    assert((await indicator.count()) === 0, 'indicador some')
    await shot('subagent-approved')
    // regenerar = nova versão da resposta: a subsessão da versão anterior continua salva
    const chats = await read<any[]>('chats.list')
    const c2 = chats.find((c) => c.title.startsWith('Use the delegate_task tool to ask'))
    const oldSubs = (await read<any[]>('sessions.list', c2.id)).filter((x) => x.depth > 0)
    assert(oldSubs.length >= 1, 'subsessão existe')
    const last = page.locator('div.group\\/msg').last()
    await last.hover()
    await last.getByRole('button', { name: 'Regenerar resposta' }).click()
    const t1 = Date.now()
    await sleep(800)
    while ((await stopBtn().count()) && Date.now() - t1 < 120_000) {
      const allow = page.getByRole('button', { name: /^(Permitir|Sim)$/ })
      if (await allow.count()) await allow.first().click()
      await sleep(500)
    }
    await waitIdle(10_000)
    const now = await read<any[]>('sessions.list', c2.id)
    for (const o of oldSubs)
      assert(
        now.some((x) => x.id === o.id),
        'subsessão da versão anterior continua'
      )
    await shot('regenerated-delegate')
    return `subsessões antigas apagadas: ${oldSubs.length}`
  })

  await step('layout 900x600 (painel recolhe)', async () => {
    await setSize(900, 600)
    await shot('min-size')
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
    assert(!overflow, 'sem scroll horizontal')
    const comp = await composer().boundingBox()
    assert(comp && comp.width >= 300, `composer largo o bastante: ${comp?.width}`)
    assert((await panelTab('Modelo').count()) === 0, 'painel recolhido')
    // reabre como gaveta sobreposta (todas as abas cabem no cabeçalho); clicar fora fecha
    await page.getByRole('button', { name: 'Abrir painel' }).click()
    await panelTab('Modelo').waitFor()
    for (const t of ['Modelo', 'Chat', 'Tools', 'Arquivos'] as const) {
      const box = await panelTab(t).boundingBox()
      assert(box && box.x + box.width <= 900, `aba ${t} visível`)
    }
    await ensurePanel('Modelo')
    await sleep(300)
    await shot('min-size-drawer')
    // seletor de modelo na gaveta: cabe na janela
    await page.getByTestId('right-panel').getByRole('combobox').click()
    const lb = page.getByRole('listbox', { name: 'Modelos' })
    await lb.locator('[role=option]').first().waitFor({ timeout: 10_000 })
    await sleep(200)
    const pb = await lb.boundingBox()
    assert(pb && pb.x >= 0 && pb.x + pb.width <= 900 && pb.y + pb.height <= 600, 'picker na janela')
    await shot('min-size-picker')
    await page.keyboard.press('Escape')
    await lb.waitFor({ state: 'detached', timeout: 3000 })
    await page.mouse.click(300, 300)
    await panelTab('Modelo').waitFor({ state: 'detached', timeout: 3000 })
    // Novo chat em 900x600 (persona + campos sem scroll horizontal)
    await page.getByRole('button', { name: 'Novo chat' }).first().click()
    await page.getByTestId('preset-picker').waitFor()
    assert(
      !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
      'novo chat sem scroll horizontal'
    )
    await shot('min-size-new-chat')
    await setSize(1280, 820)
  })

  await app.close()
  fakeServer?.close()
  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${results.length - failed.length}/${results.length} passaram. Screenshots: ${SHOTS}`
  )
  writeFileSync(join(BASE, 'ui-report.json'), JSON.stringify({ results }, null, 2))
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try {
    await app?.close()
  } catch {
    /* */
  }
  process.exit(1)
})
