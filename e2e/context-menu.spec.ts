/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do menu de contexto (botão direito) no app REAL buildado (Playwright + `e2e/launch.ts`), com um
// provedor OpenAI-compatible FALSO em 127.0.0.1 (nenhuma key, nenhum custo). Menus nativos não são
// clicáveis pelo Playwright: com userData isolado o main expõe `globalThis.__clearchatContextMenu`
// (só nesse modo) — `capture(true)` guarda os menus em vez de abri-los e `click(rótulo)` executa um
// item do último menu pelo MESMO caminho do clique real (cópias gravadas no main; ações do app
// voltam ao renderer por `ctx:action`). O clique direito é de verdade (mouse do Chromium).
//
// Cobre: resposta do assistente (Copiar mensagem → texto simples na área de transferência, Copiar
// como Markdown, Editar, Regenerar resposta → nova versão), bloco de código (Copiar código primeiro),
// balão do usuário (Editar abre o editor; dentro do editor só o menu de edição), link (Copiar link),
// seleção (Copiar + Pesquisar na web → navegador do sistema, interceptado), preventDefault de um
// menu próprio não abre o nativo, corretor pt-BR/en-US na sessão.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/context-menu.spec.ts
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const MODEL = 'fake/ctx'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-ctxmenu-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')

const ANSWER = [
  'Resposta com **negrito** e um [link](https://example.com/).',
  '',
  '```js',
  'console.log(42)',
  '```'
].join('\n')
const ANSWER_PLAIN = 'Resposta com negrito e um link.\n\nconsole.log(42)'

let server: Server | null = null
let fakeBase = ''
let calls = 0

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
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64_000 }] }))
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      calls++
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const base = { id: `f${calls}`, object: 'chat.completion.chunk', model: body.model }
      const chunk = (o: unknown): boolean => res.write(`data: ${JSON.stringify(o)}\n\n`)
      chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: ANSWER } }] })
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      })
      res.end('data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

let app: ElectronApplication
let page: Page
const results: { name: string; ok: boolean; info?: string }[] = []
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n').slice(0, 6).join('\n')}`)
    try {
      await page.screenshot({ path: join(SHOTS, `FAIL-${name.replace(/[^\w]+/g, '_')}.png`) })
      await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
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

type Item = { type: 'separator' } | { type: 'item'; label: string; enabled: boolean }

const menuCount = (): Promise<number> =>
  app.evaluate(() => (globalThis as any).__clearchatContextMenu.menus().length)

/** Clique direito de verdade em `target` e o menu capturado (rótulos; desabilitado: "(x)"). */
async function rightClick(
  target: ReturnType<Page['locator']>,
  opts: { position?: { x: number; y: number } } = {}
): Promise<string[]> {
  const before = await menuCount()
  await target.click({ button: 'right', ...opts })
  await waitFor(async () => (await menuCount()) > before, 3000, 'menu de contexto')
  const items: Item[] = await app.evaluate(() => {
    const m = (globalThis as any).__clearchatContextMenu.menus()
    return m[m.length - 1].items
  })
  return items.map((i) => (i.type === 'separator' ? '—' : i.enabled ? i.label : `(${i.label})`))
}

const clickItem = (label: string): Promise<void> =>
  app.evaluate((_e, l) => (globalThis as any).__clearchatContextMenu.click(l), label)
const clipboardText = (): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText())
const clearClipboard = (): Promise<void> => app.evaluate(({ clipboard }) => clipboard.writeText(''))

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
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow, shell }) => {
    BrowserWindow.getAllWindows()[0].setSize(1280, 820)
    ;(globalThis as any).__clearchatContextMenu.capture(true)
    ;(globalThis as any).__opened = []
    shell.openExternal = (async (url: string) => {
      ;(globalThis as any).__opened.push(url)
    }) as any
  })

  let chatId = ''
  let sid = ''
  await step('setup: provedor falso, chat com uma resposta em Markdown', async () => {
    const p = await api('providers.create', { name: 'Local', baseUrl: fakeBase, apiKey: 'k' })
    const c = await api('chats.create', {
      title: 'Menu de contexto',
      config: { providerId: p.id, model: MODEL, cwd: CWD, enabledTools: [] }
    })
    chatId = c.id
    sid = c.mainSessionId
    await api('agent.send', sid, 'Pergunta do usuário')
    await waitFor(
      async () => {
        const ms = await api<any[]>('sessions.messages', sid)
        return ms.some((m) => m.message.role === 'assistant')
      },
      15_000,
      'resposta'
    )
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('chat-item').filter({ hasText: 'Menu de contexto' }).click()
    await page.getByTestId('chat-scroller').getByText('console.log(42)').waitFor()
    await sleep(500)
  })

  const scroller = (): ReturnType<Page['locator']> => page.getByTestId('chat-scroller')
  const answer = (): ReturnType<Page['locator']> =>
    scroller().locator('div.group\\/msg').filter({ hasText: 'Resposta com' }).first()
  const userMsg = (): ReturnType<Page['locator']> =>
    scroller().locator('div.group\\/msg').filter({ hasText: 'Pergunta do usuário' }).first()

  await step('resposta: ações da mensagem; "Copiar mensagem" grava o texto simples', async () => {
    const labels = await rightClick(answer().getByText('Resposta com', { exact: false }).first(), {
      position: { x: 5, y: 5 }
    })
    for (const l of ['Copiar mensagem', 'Copiar como Markdown', 'Editar', 'Regenerar resposta'])
      assert.ok(labels.includes(l), `${l} em ${JSON.stringify(labels)}`)
    assert.ok(!labels.includes('Copiar código'), 'fora do bloco de código')
    await clearClipboard()
    await clickItem('Copiar mensagem')
    assert.equal(await clipboardText(), ANSWER_PLAIN)
    await clickItem('Copiar como Markdown')
    assert.equal(await clipboardText(), ANSWER)
    return labels.join(' | ')
  })

  await step('bloco de código: "Copiar código" primeiro', async () => {
    const labels = await rightClick(
      scroller().locator('pre').filter({ hasText: 'console.log(42)' })
    )
    assert.equal(labels[0], 'Copiar código')
    assert.ok(labels.includes('Copiar mensagem'))
    await clickItem('Copiar código')
    assert.equal(await clipboardText(), 'console.log(42)')
  })

  await step('link: Abrir no navegador / Copiar link (+ ações da mensagem)', async () => {
    const labels = await rightClick(scroller().getByRole('link', { name: 'link' }))
    assert.deepEqual(labels.slice(0, 2), ['Abrir no navegador', 'Copiar link'])
    assert.ok(labels.includes('Copiar mensagem'))
    await clickItem('Copiar link')
    assert.equal(await clipboardText(), 'https://example.com/')
    await clickItem('Abrir no navegador')
    const opened: string[] = await app.evaluate(() => (globalThis as any).__opened)
    assert.deepEqual(opened, ['https://example.com/'])
  })

  await step('seleção: Copiar + Pesquisar na web (navegador do sistema)', async () => {
    await answer()
      .locator('strong')
      .evaluate((el) => {
        const r = document.createRange()
        r.selectNodeContents(el)
        const s = window.getSelection()!
        s.removeAllRanges()
        s.addRange(r)
      })
    const strong = answer().locator('strong')
    const labels = await rightClick(strong)
    assert.deepEqual(labels.slice(0, 3), ['Copiar', '—', 'Pesquisar na web: “negrito”'])
    await clickItem('Pesquisar na web: “negrito”')
    const opened: string[] = await app.evaluate(() => (globalThis as any).__opened)
    assert.equal(opened.at(-1), 'https://duckduckgo.com/?q=negrito')
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
  })

  await step(
    'balão do usuário: Copiar mensagem + Editar (sem Markdown/Regenerar); Editar abre o editor',
    async () => {
      const labels = await rightClick(userMsg().getByText('Pergunta do usuário'))
      assert.ok(labels.includes('Copiar mensagem') && labels.includes('Editar'), labels.join(' | '))
      assert.ok(!labels.includes('Copiar como Markdown') && !labels.includes('Regenerar resposta'))
      await clickItem('Copiar mensagem')
      assert.equal(await clipboardText(), 'Pergunta do usuário')
      await clickItem('Editar')
      const editor = userMsg().locator('textarea')
      await editor.waitFor({ timeout: 3000 })
      // dentro do editor: só o menu de edição (nada de ações da mensagem)
      const inEditor = await rightClick(editor)
      assert.ok(
        inEditor.includes('Colar') && inEditor.includes('Selecionar tudo'),
        inEditor.join(' | ')
      )
      assert.ok(!inEditor.includes('Copiar mensagem') && !inEditor.includes('Editar'))
      await page.screenshot({ path: join(SHOTS, 'editor.png') })
      await editor.press('Escape')
      await editor.waitFor({ state: 'detached', timeout: 3000 })
    }
  )

  await step('"Regenerar resposta" pelo menu cria uma nova versão', async () => {
    const before = calls
    await rightClick(answer().getByText('Resposta com', { exact: false }).first(), {
      position: { x: 5, y: 5 }
    })
    await clickItem('Regenerar resposta')
    await waitFor(
      async () => {
        const ms = await api<any[]>('sessions.messages', sid)
        return ms.filter((m) => m.message.role === 'assistant').length === 2
      },
      15_000,
      'segunda versão da resposta'
    )
    assert.equal(calls, before + 1)
    await scroller().getByTestId('branch-switcher').first().waitFor({ timeout: 5000 })
    void chatId
  })

  await step('menu próprio (preventDefault no contextmenu) não abre o nativo', async () => {
    await page.evaluate(() => {
      const d = document.createElement('div')
      d.id = 'own-menu'
      d.textContent = 'menu próprio'
      d.style.cssText =
        'position:fixed;left:300px;top:300px;width:120px;height:40px;z-index:99999;background:#333'
      d.addEventListener('contextmenu', (e) => e.preventDefault())
      document.body.appendChild(d)
    })
    const before = await menuCount()
    await page.locator('#own-menu').click({ button: 'right' })
    await sleep(600)
    assert.equal(await menuCount(), before)
    await page.evaluate(() => document.getElementById('own-menu')?.remove())
  })

  await step('área vazia: sem itens do app (dev: só Inspecionar elemento)', async () => {
    const dev = await app.evaluate(({ app }) => !app.isPackaged)
    const labels = await rightClick(page.getByTestId('chat-item').first())
    assert.deepEqual(labels, dev ? ['Inspecionar elemento'] : [])
  })

  await step(
    'corretor: pt-BR e en-US na sessão do app; campo do composer com spellcheck',
    async () => {
      const r = await app.evaluate(({ session, BrowserWindow }) => ({
        langs: session.defaultSession.getSpellCheckerLanguages(),
        enabled: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()?.spellcheck
      }))
      if (process.platform !== 'darwin') {
        assert.ok(r.langs.includes('pt-BR') && r.langs.includes('en-US'), JSON.stringify(r.langs))
      }
      assert.notEqual(r.enabled, false)
      return JSON.stringify(r)
    }
  )

  await step('builder no main: link file:// só copia; dev ganha Inspecionar', async () => {
    const items: Item[] = await app.evaluate(() =>
      (globalThis as any).__clearchatContextMenu.build({
        x: 1,
        y: 2,
        isEditable: false,
        selectionText: '',
        linkURL: 'file:///etc/passwd',
        mediaType: 'none',
        srcURL: '',
        hasImageContents: false,
        misspelledWord: '',
        dictionarySuggestions: [],
        editFlags: {
          canUndo: false,
          canRedo: false,
          canCut: false,
          canCopy: false,
          canPaste: false,
          canSelectAll: false
        }
      })
    )
    const labels = items.filter((i) => i.type === 'item').map((i) => (i as any).label)
    assert.equal(labels[0], 'Copiar link')
    assert.ok(!labels.includes('Abrir no navegador'))
  })

  await app.close()
  server?.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passos ok`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try {
    await app?.close()
  } catch {
    /* */
  }
  server?.close()
  process.exit(1)
})
