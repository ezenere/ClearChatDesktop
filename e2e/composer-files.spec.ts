/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E dos arquivos no composer (app REAL buildado, Playwright + `e2e/launch.ts`, userData temporário,
// provedor OpenAI-compatible FALSO em 127.0.0.1 — nenhuma key, nenhum custo; microfone/câmera
// sempre negados): arquivo selecionado (protocolo 1.13.0) — chip do arquivo aberto no painel, × sem
// fechar o painel, outro arquivo traz o chip de volta, "Mencionar no chat" pelo menu da aba
// Arquivos, linha "Arquivo selecionado" na mensagem enviada (tooltip com o texto exato; clique abre)
// e o TEXTO EXATO na request do provedor falso; renomear (campo inline) e excluir (confirmação na
// UI; lixeira interceptada — nada vai para a lixeira real) pelo menu da aba Arquivos; popup de `@`
// pelo teclado (pasta continua listando, arquivo fecha com espaço, aspas com espaço no nome, Esc),
// destaque do caminho completo no composer; caminhos `@` destacados na mensagem enviada com clique
// (existente abre; ausente → aviso, nada abre); botões de voz (largura/ícones). Menus nativos não
// são clicáveis pelo Playwright: `__clearchatContextMenu` (só com userData isolado) captura e clica.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir [CLEARCHAT_E2E_SHOTS=/pasta] node e2e/composer-files.spec.ts
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const MODEL = 'fake/files'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(
  process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-composer-files-e2e')
)
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'projeto')
const SHOTS = resolve(process.env.CLEARCHAT_E2E_SHOTS || join(BASE, 'shots'))

const LINE = (p: string): string =>
  `O usuário está com o arquivo ${p} selecionado; ele pode ou não estar relacionado a esta mensagem.`

let server: Server | null = null
let fakeBase = ''
const bodies: any[] = []

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
      bodies.push(body)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const base = { id: `f${bodies.length}`, object: 'chat.completion.chunk', model: body.model }
      const chunk = (o: unknown): boolean => res.write(`data: ${JSON.stringify(o)}\n\n`)
      chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Certo.' } }] })
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
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
const shot = (name: string): Promise<Buffer> =>
  page.screenshot({ path: join(SHOTS, `${name}.png`) })

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n').slice(0, 8).join('\n')}`)
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_').slice(0, 60)}`)
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

const menuCount = (): Promise<number> =>
  app.evaluate(() => (globalThis as any).__clearchatContextMenu.menus().length)

async function rightClick(target: ReturnType<Page['locator']>): Promise<string[]> {
  const before = await menuCount()
  await target.click({ button: 'right' })
  await waitFor(async () => (await menuCount()) > before, 3000, 'menu de contexto')
  const items: any[] = await app.evaluate(() => {
    const m = (globalThis as any).__clearchatContextMenu.menus()
    return m[m.length - 1].items
  })
  return items.map((i) => (i.type === 'separator' ? '—' : i.enabled ? i.label : `(${i.label})`))
}
const clickItem = (label: string): Promise<void> =>
  app.evaluate((_e, l) => (globalThis as any).__clearchatContextMenu.click(l), label)

/** Textos das mensagens `user` da última request ao provedor falso. */
function lastUserContent(): string {
  const b = bodies[bodies.length - 1]
  const u = [...(b?.messages ?? [])].reverse().find((m: any) => m.role === 'user')
  if (!u) return ''
  return typeof u.content === 'string'
    ? u.content
    : u.content.map((p: any) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('|')
}

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(join(CWD, 'src', 'components'), { recursive: true })
  mkdirSync(join(CWD, 'docs com espaço'), { recursive: true })
  mkdirSync(join(CWD, 'node_modules', 'lib'), { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(CWD, 'README.md'), '# Projeto\n\nLeia-me.\n')
  writeFileSync(join(CWD, 'notas.txt'), 'notas do projeto\n')
  writeFileSync(join(CWD, 'apagar.txt'), 'some\n')
  writeFileSync(join(CWD, 'src', 'app.ts'), 'export const app = 1\n')
  writeFileSync(join(CWD, 'src', 'components', 'Button.tsx'), 'export {}\n')
  writeFileSync(join(CWD, 'docs com espaço', 'guia.md'), '# Guia\n')
  writeFileSync(join(CWD, 'node_modules', 'lib', 'index.js'), '')
  await startFake()

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = USER_DATA
  // sem login nada vai à rede; mesmo assim, nunca o servidor real
  env.CLEARCHAT_SYNC_URL = 'http://127.0.0.1:9'
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow, session, shell }) => {
    // microfone/câmera: sempre negados (nada de dispositivo real nos testes)
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    BrowserWindow.getAllWindows()[0].setSize(1440, 900)
    ;(globalThis as any).__clearchatContextMenu.capture(true)
    // lixeira interceptada: registra e apaga (nunca a lixeira real do usuário)
    ;(globalThis as any).__trashed = []
    shell.trashItem = (async (p: string) => {
      ;(globalThis as any).__trashed.push(p)
      const fs = process.getBuiltinModule('fs')
      fs.rmSync(p, { recursive: true, force: true })
    }) as any
  })
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })

  let sid = ''
  await step('setup: provedor falso e chat com a raiz de teste', async () => {
    const p = await api('providers.create', { name: 'Local', baseUrl: fakeBase, apiKey: 'k' })
    const c = await api('chats.create', {
      title: 'Arquivos no composer',
      config: { providerId: p.id, model: MODEL, cwd: CWD, enabledTools: [] }
    })
    sid = c.mainSessionId
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('chat-item').filter({ hasText: 'Arquivos no composer' }).click()
    await page.getByTestId('composer-card').waitFor()
  })

  const composer = (): ReturnType<Page['locator']> =>
    page.getByTestId('composer-card').locator('textarea')
  const chip = (): ReturnType<Page['locator']> => page.getByTestId('composer-file-chip')
  const entry = (name: string): ReturnType<Page['locator']> =>
    page.getByTestId('files-entry').filter({ hasText: new RegExp(`^${name}`) })
  const openFilesTab = async (): Promise<void> => {
    if (
      !(await page
        .getByTestId('right-panel')
        .isVisible()
        .catch(() => false))
    )
      await page.getByRole('button', { name: 'Abrir painel' }).click()
    await page.getByTestId('right-panel').getByRole('tab', { name: 'Arquivos' }).click()
    await page.getByTestId('files-entry').first().waitFor()
  }

  await step(
    'botões de voz: telefone e mic quase quadrados, mesma largura, ícones parecidos',
    async () => {
      // o telefone mede pelo segmento (o span que leva a borda do divisor, como o mic)
      const call = page.getByTestId('voice-call-button').locator('xpath=..')
      const mic = page.getByTestId('voice-mic-button')
      await mic.waitFor({ timeout: 10_000 })
      const [c, m] = [await call.boundingBox(), await mic.boundingBox()]
      assert.ok(c && m, 'botões visíveis')
      assert.ok(Math.abs(c.width - m.width) <= 1, `mesma largura (${c.width} × ${m.width})`)
      assert.ok(c.width >= 29 && c.width <= 31, `largura 30 px (${c.width})`)
      assert.ok(Math.abs(c.width - c.height) <= 3, `quase quadrado (${c.width}×${c.height})`)
      const icons = await page.evaluate(() => {
        const box = (sel: string): DOMRect =>
          document.querySelector(`[data-testid="${sel}"] svg`)!.getBoundingClientRect()
        const btn = (sel: string): DOMRect =>
          document.querySelector(`[data-testid="${sel}"]`)!.getBoundingClientRect()
        const ph = box('voice-call-button')
        const pb = btn('voice-call-button')
        return {
          phone: ph.width,
          mic: box('voice-mic-button').width,
          dx: ph.left + ph.width / 2 - (pb.left + pb.width / 2),
          dy: ph.top + ph.height / 2 - (pb.top + pb.height / 2)
        }
      })
      assert.ok(icons.phone < icons.mic, `telefone menor que o mic (${JSON.stringify(icons)})`)
      assert.ok(Math.abs(icons.dx) <= 1 && Math.abs(icons.dy) <= 1, 'telefone centralizado')
      const group = page.getByTestId('voice-group')
      const g = (await group.boundingBox())!
      await page.screenshot({
        path: join(SHOTS, '01-botoes-voz.png'),
        clip: { x: g.x - 220, y: g.y - 14, width: g.width + 300, height: g.height + 28 }
      })
      return `${c.width.toFixed(0)}×${c.height.toFixed(0)} · ícones ${JSON.stringify(icons)}`
    }
  )

  await step(
    'arquivo aberto no painel → chip no lugar da dica; tooltip com o caminho',
    async () => {
      assert.ok(await page.getByTestId('composer-hint').innerText(), 'dica antes')
      await openFilesTab()
      await entry('README.md').click()
      await page.getByTestId('file-viewer').waitFor()
      await chip().waitFor()
      assert.equal(await chip().getAttribute('data-path'), 'README.md')
      assert.equal(
        await page.getByTestId('composer-hint').count(),
        0,
        'o chip toma o lugar da dica'
      )
      // com painel + arquivo abertos a barra aperta e o chip pode estar recolhido (só o ícone);
      // espera a barra assentar (o recolhimento muda a largura do chip logo depois de aparecer)
      await sleep(500)
      await chip().locator('[aria-label^="Arquivo selecionado"]').hover()
      const tip = page.getByRole('tooltip').filter({ hasText: 'Arquivo selecionado' })
      await tip.waitFor({ timeout: 3000 })
      assert.ok((await tip.innerText()).includes(LINE('README.md')), 'tooltip com o texto exato')
      // painel de configurações fechado: a barra tem espaço e o chip mostra o nome
      await page
        .getByTestId('top-bar')
        .getByRole('button', { name: 'Fechar painel', exact: true })
        .click()
      await chip().getByText('README.md').waitFor()
      await chip().getByText('README.md').hover()
      await tip.waitFor({ timeout: 3000 })
      await sleep(250)
      await shot('02-chip-arquivo-aberto')
      await page.mouse.move(5, 5)
      await page
        .getByTestId('top-bar')
        .getByRole('button', { name: 'Abrir painel', exact: true })
        .click()
      await page.getByTestId('files-entry').first().waitFor()
    }
  )

  await step(
    '× do chip: para de mencionar sem fechar o painel; outro arquivo traz o chip',
    async () => {
      await page.getByTestId('composer-file-dismiss').click()
      await chip().waitFor({ state: 'detached' })
      assert.ok(await page.getByTestId('file-viewer').isVisible(), 'painel continua aberto')
      // a dica volta (pode estar recolhida: painel + arquivo abertos estreitam a barra)
      await page.getByTestId('composer-hint').waitFor({ state: 'attached' })
      await entry('notas.txt').click()
      await chip().waitFor()
      assert.equal(await chip().getAttribute('data-path'), 'notas.txt')
    }
  )

  await step('envio: linha "Arquivo selecionado" e o texto EXATO na request', async () => {
    const before = bodies.length
    await composer().fill('o que tem aqui?')
    await composer().press('Enter')
    await waitFor(async () => bodies.length > before, 15_000, 'request no provedor falso')
    assert.equal(lastUserContent(), `o que tem aqui?\n\n${LINE('notas.txt')}`)
    const msgs = await api<any[]>('sessions.messages', sid)
    const u = msgs.find((m) => m.message.role === 'user')
    assert.equal(u.message.content, 'o que tem aqui?', 'content salvo = só o texto do usuário')
    assert.deepEqual(u.meta.openFile, { path: 'notas.txt' })
    const line = page.getByTestId('msg-open-file')
    await line.waitFor()
    assert.equal(await line.getAttribute('data-path'), 'notas.txt')
    await line.getByText('Arquivo selecionado:').hover()
    const tip = page.getByRole('tooltip').filter({ hasText: 'Enviado ao modelo' })
    await tip.waitFor({ timeout: 3000 })
    assert.ok((await tip.innerText()).includes(LINE('notas.txt')))
    await shot('03-mensagem-arquivo-selecionado')
    await page.mouse.move(5, 5)
    // clique no caminho reabre no painel (fechado antes)
    await page.getByRole('button', { name: 'Fechar painel de arquivo' }).click()
    await page.getByTestId('file-viewer').waitFor({ state: 'detached' })
    await page.getByTestId('msg-open-file-path').click()
    await page.getByTestId('file-viewer').waitFor()
    assert.equal(await page.getByTestId('viewer-name').innerText(), 'notas.txt')
  })

  await step('menu da aba Arquivos: "Mencionar no chat" (arquivo não aberto)', async () => {
    await entry('src').click()
    await entry('app.ts').waitFor()
    const labels = await rightClick(entry('app.ts'))
    for (const l of ['Mencionar no chat', 'Copiar caminho', 'Renomear', 'Excluir'])
      assert.ok(labels.includes(l), `${l} em ${labels.join(' | ')}`)
    await clickItem('Mencionar no chat')
    await waitFor(
      async () => (await chip().getAttribute('data-path')) === 'src/app.ts',
      3000,
      'chip src/app.ts'
    )
    assert.equal(await page.getByTestId('viewer-name').innerText(), 'notas.txt', 'painel não muda')
    const before = bodies.length
    await composer().fill('e este?')
    await composer().press('Enter')
    await waitFor(async () => bodies.length > before, 15_000, 'request')
    assert.equal(lastUserContent(), `e este?\n\n${LINE('src/app.ts')}`)
    return labels.join(' | ')
  })

  await step('renomear pelo menu: campo inline, arquivo renomeado, painel acompanha', async () => {
    // volta à raiz da aba e renomeia o arquivo aberto no painel
    await page.getByTestId('right-panel').getByRole('button', { name: 'projeto' }).click()
    await entry('notas.txt').waitFor()
    await rightClick(entry('notas.txt'))
    await clickItem('Renomear')
    const input = page.getByTestId('files-rename-input')
    await input.waitFor()
    assert.equal(
      await input.evaluate((el: HTMLInputElement) =>
        el.value.slice(el.selectionStart!, el.selectionEnd!)
      ),
      'notas',
      'seleciona o nome sem a extensão'
    )
    await shot('04-renomear-inline')
    await input.fill('notas-novas.txt')
    await input.press('Enter')
    await entry('notas-novas.txt').waitFor()
    assert.ok(existsSync(join(CWD, 'notas-novas.txt')) && !existsSync(join(CWD, 'notas.txt')))
    await waitFor(
      async () => (await page.getByTestId('viewer-name').innerText()) === 'notas-novas.txt',
      3000,
      'painel segue o arquivo'
    )
    // Esc cancela
    await rightClick(entry('README.md'))
    await clickItem('Renomear')
    await page.getByTestId('files-rename-input').press('Escape')
    await page.getByTestId('files-rename-input').waitFor({ state: 'detached' })
    assert.ok(existsSync(join(CWD, 'README.md')))
  })

  await step('excluir pelo menu: confirmação na UI → lixeira (interceptada)', async () => {
    await rightClick(entry('apagar.txt'))
    await clickItem('Excluir')
    const confirm = page.getByTestId('files-delete-confirm')
    await confirm.waitFor()
    assert.ok((await page.getByTestId('files-delete-text').innerText()).includes('lixeira'))
    await shot('05-excluir-confirmacao')
    await confirm.click()
    await entry('apagar.txt').waitFor({ state: 'detached' })
    const trashed: string[] = await app.evaluate(() => (globalThis as any).__trashed)
    assert.deepEqual(trashed, [join(CWD, 'apagar.txt')])
    assert.ok(!existsSync(join(CWD, 'apagar.txt')))
  })

  await step(
    'popup de @ pelo teclado: pasta continua, arquivo fecha com espaço; destaque',
    async () => {
      await page.getByTestId('composer-file-dismiss').click()
      await composer().fill('')
      await composer().click()
      await composer().pressSequentially('veja @')
      const popup = page.getByTestId('mention-popup')
      await popup.waitFor()
      const first = await page.getByTestId('mention-item').allInnerTexts()
      assert.ok(!first.some((t) => t.includes('node_modules')), 'node_modules ignorado')
      await composer().pressSequentially('sr')
      await waitFor(
        async () =>
          (await page.getByTestId('mention-item').first().getAttribute('data-path')) === 'src/',
        3000,
        'src/ primeiro'
      )
      await sleep(250)
      await shot('06-popup-arroba')
      await composer().press('Tab')
      assert.equal(await composer().inputValue(), 'veja @src/')
      await waitFor(
        async () => (await page.getByTestId('mention-scope').innerText()).includes('src/'),
        3000,
        'popup lista src/'
      )
      const items = await page
        .getByTestId('mention-item')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))
      assert.deepEqual(items, ['src/components/', 'src/app.ts'])
      await composer().press('ArrowDown')
      await composer().press('Enter')
      assert.equal(await composer().inputValue(), 'veja @src/app.ts ')
      await popup.waitFor({ state: 'detached' })
      const mark = page.getByTestId('composer-mention')
      await mark.waitFor()
      assert.equal(await mark.getAttribute('data-path'), 'src/app.ts')
      // chip por cima do texto cru: ícone + caminho em fonte menor, no lugar exato do texto
      const chip = page.getByTestId('composer-mention-chip')
      await chip.waitFor()
      assert.equal((await chip.textContent())?.trim(), 'src/app.ts')
      const [mb, cb] = [await mark.boundingBox(), await chip.boundingBox()]
      assert.ok(
        mb && cb && Math.abs(cb.x - mb.x) < 1.5 && Math.abs(cb.width - mb.width) < 1.5,
        `chip na largura do texto: ${JSON.stringify({ mb, cb })}`
      )
      await shot('07-composer-caminho-destacado')
      // cursor encostando na menção → o chip some e o texto cru aparece para editar
      await composer().press('ArrowLeft')
      await waitFor(
        async () => (await mark.getAttribute('data-editing')) !== null,
        3000,
        'cursor na menção → texto cru'
      )
      assert.equal(await chip.count(), 0)
      await shot('07b-composer-caminho-editando')
      await composer().press('ArrowRight')
      await chip.waitFor()
      // nome com espaço: aspas; Esc fecha
      await composer().pressSequentially('e @docs')
      await composer().press('Tab')
      assert.equal(await composer().inputValue(), 'veja @src/app.ts e @"docs com espaço/')
      await composer().press('Enter')
      assert.equal(await composer().inputValue(), 'veja @src/app.ts e @"docs com espaço/guia.md" ')
      // entre aspas: o chip mostra o caminho sem as aspas
      await waitFor(async () => (await chip.count()) === 2, 3000, 'dois chips')
      assert.equal((await chip.nth(1).textContent())?.trim(), 'docs com espaço/guia.md')
      await shot('07c-composer-dois-chips')
      await composer().pressSequentially('@READ')
      await popup.waitFor()
      await composer().press('Escape')
      await popup.waitFor({ state: 'detached' })
      assert.ok(await page.getByTestId('composer-card').isVisible(), 'Esc não fechou nada além')
    }
  )

  await step('mensagem enviada: @caminhos destacados; existente abre, ausente avisa', async () => {
    const before = bodies.length
    await composer().fill('compare @src/app.ts com @nada/faltando.ts e `@codigo.ts`')
    await composer().press('Enter')
    await waitFor(async () => bodies.length > before, 15_000, 'request')
    assert.ok(
      lastUserContent().startsWith('compare @src/app.ts com @nada/faltando.ts'),
      'vai como texto normal'
    )
    const paths = page.getByTestId('chat-scroller').getByTestId('msg-path')
    await waitFor(async () => (await paths.count()) >= 2, 5000, 'caminhos destacados')
    const shown = await paths.evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))
    assert.ok(shown.includes('src/app.ts') && shown.includes('nada/faltando.ts'))
    assert.ok(!shown.includes('codigo.ts'), 'nada dentro de código')
    await page.getByRole('button', { name: 'Fechar painel de arquivo' }).click()
    await page.getByTestId('file-viewer').waitFor({ state: 'detached' })
    await shot('08-mensagem-caminhos')
    await paths.filter({ hasText: '@src/app.ts' }).last().click()
    await page.getByTestId('file-viewer').waitFor()
    assert.equal(await page.getByTestId('viewer-name').innerText(), 'app.ts')
    await page.getByRole('button', { name: 'Fechar painel de arquivo' }).click()
    await page.getByTestId('file-viewer').waitFor({ state: 'detached' })
    await paths.filter({ hasText: '@nada/faltando.ts' }).last().click()
    const toast = page.getByTestId('toast').filter({ hasText: 'Não encontrei nada/faltando.ts' })
    await toast.waitFor({ timeout: 5000 })
    await sleep(300)
    assert.equal(await page.getByTestId('file-viewer').count(), 0, 'nada foi aberto')
    await shot('09-caminho-ausente')
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
