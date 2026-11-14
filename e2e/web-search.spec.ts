/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E dos buscadores do web_search na UI real (Playwright + `e2e/launch.ts`), determinístico e sem rede:
// um provedor OpenAI-compatible FALSO e um servidor FALSO de busca em 127.0.0.1 fazem o papel de
// Exa / Tavily / Brave Search API / DuckDuckGo / Brave (site) — as bases vêm de
// CLEARCHAT_SEARCH_BASE_<ID>. userData isolado (CLEARCHAT_USER_DATA); nenhuma chave real.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/web-search.spec.ts
//
// Cobre (Configurações → Pesquisa na web): ordem padrão (DuckDuckGo, Brave (site) ligados; APIs
// desligadas com "Informe a chave de API para habilitar"), salvar chave (máscara; nunca em claro
// fora do "mostrar"; setting protegido), habilitar, reordenar (↑/↓ e arrastar), desabilitar,
// Testar (ok / erro de cota; gzip da Brave API), remover chave (desliga). Depois uma pesquisa pelo
// runner: Exa (1ª) responde 429 → Tavily (2ª) responde; o resultado diz quem respondeu e quem falhou.
import type { ElectronApplication, Locator, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'

const AGENT = 'fake/agent-1'
const ROOT = resolve(import.meta.dirname, '..')
const FX = join(import.meta.dirname, 'fixtures/web')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-websearch-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')

const EXA_KEY = 'exa-e2e-fake-key-0001'
const TAVILY_KEY = 'tvly-e2e-fake-key-0002'
const BRAVE_KEY = 'BSAe2efakekey0003'

// ---------------- servidores falsos ----------------

const llmHits: any[] = []
const searchHits: { path: string; method: string; headers: any; body: string }[] = []
let llm: Server | null = null
let search: Server | null = null
let llmBase = ''
let searchBase = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : ''
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`

async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
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
      const body = JSON.parse((await readBody(req)) || '{}')
      llmHits.push(body)
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (last?.role === 'tool') {
        const first = textOf(last.content).split('\n')[0]
        res.write(chunk(body.model, { role: 'assistant', content: `FIM — ${first}` }))
        res.write(chunk(body.model, {}, 'stop'))
      } else if (/^pesquise/.test(textOf(lastUser?.content))) {
        res.write(
          chunk(body.model, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now().toString(36)}`,
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: JSON.stringify({ query: 'typescript satisfies operator' })
                }
              }
            ]
          })
        )
        res.write(chunk(body.model, {}, 'tool_calls'))
      } else {
        res.write(chunk(body.model, { role: 'assistant', content: 'OK.' }))
        res.write(chunk(body.model, {}, 'stop'))
      }
      res.end('data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => llm!.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm!.address() as AddressInfo).port}/v1`
}

async function startSearch(): Promise<void> {
  search = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0]
      const body = await readBody(req)
      searchHits.push({ path, method: req.method ?? '', headers: req.headers, body })
      const json = (status: number, data: string, gzip = false): void => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (gzip) headers['Content-Encoding'] = 'gzip'
        res.writeHead(status, headers)
        res.end(gzip ? gzipSync(data) : data)
      }
      if (path === '/exa/search') {
        // a Exa está sempre sem cota neste cenário
        if (req.headers.authorization !== `Bearer ${EXA_KEY}`)
          return json(401, '{"error":"bad key"}')
        return json(429, '{"requestId":"r1","error":"Rate limit exceeded","tag":"RATE_LIMITED"}')
      }
      if (path === '/tavily/search') {
        if (req.headers.authorization !== `Bearer ${TAVILY_KEY}`)
          return json(401, '{"detail":{"error":"Unauthorized: missing or invalid API key."}}')
        return json(200, readFileSync(join(FX, 'tavily-search.json'), 'utf8'))
      }
      if (path === '/brave/res/v1/web/search') {
        if (req.headers['x-subscription-token'] !== BRAVE_KEY)
          return json(422, readFileSync(join(FX, 'brave-api-error-422.json'), 'utf8'))
        return json(200, readFileSync(join(FX, 'brave-api-search.json'), 'utf8'), true)
      }
      if (path.startsWith('/ddg')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        return res.end(readFileSync(join(FX, 'ddg-captcha.html'), 'utf8'))
      }
      if (path.startsWith('/brave-site')) {
        res.writeHead(429, { 'Content-Type': 'text/html' })
        return res.end(readFileSync(join(FX, 'brave-captcha.html'), 'utf8'))
      }
      res.writeHead(404)
      res.end('{}')
    })()
  })
  await new Promise<void>((r) => search!.listen(0, '127.0.0.1', r))
  searchBase = `http://127.0.0.1:${(search!.address() as AddressInfo).port}`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let shotN = 0
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
}
async function call<T = any>(path: string, ...args: unknown[]): Promise<T> {
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
const composer = (): Locator => page.locator('textarea[placeholder="Mensagem…"]')
const dialog = (): Locator => page.locator('[role="dialog"]')
const row = (id: string): Locator => page.getByTestId(`engine-${id}`)
const toggle = (id: string, label: string): Locator =>
  row(id).getByRole('switch', { name: `Habilitar ${label}` })
const order = async (): Promise<string> =>
  (await call<any>('webSearch.getSettings')).engines
    .map((e: any) => `${e.id}${e.enabled ? '+' : '-'}`)
    .join(' ')

async function openWebSettings(): Promise<void> {
  await page.getByRole('button', { name: /^Configurações/ }).click()
  await dialog().getByRole('button', { name: 'Pesquisa na web', exact: true }).click()
  await page.getByTestId('web-engines').waitFor()
}

async function saveKey(id: string, label: string, key: string): Promise<void> {
  const input = row(id).getByRole('textbox', { name: `Chave de API (${label})` })
  await input.fill(key)
  await input.press('Enter')
  await row(id).getByText('chave salva').waitFor()
}

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  await startLlm()
  await startSearch()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  env.CLEARCHAT_USER_DATA = USER_DATA
  env.CLEARCHAT_SEARCH_BASE_EXA = `${searchBase}/exa`
  env.CLEARCHAT_SEARCH_BASE_TAVILY = `${searchBase}/tavily`
  env.CLEARCHAT_SEARCH_BASE_BRAVE_API = `${searchBase}/brave`
  env.CLEARCHAT_SEARCH_BASE_DDG = `${searchBase}/ddg/html/`
  env.CLEARCHAT_SEARCH_BASE_BRAVE_SITE = `${searchBase}/brave-site/search`
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setFocusable(false)
    w.blur()
  })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, CWD)
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))

  await step('userData isolado + onboarding + novo chat', async () => {
    assert(userData === USER_DATA, `userData ${userData}`)
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await page.getByTestId('onboarding-provider').click()
    await page.locator('input.field').nth(0).fill('Local')
    await page.locator('input.field').nth(1).fill(llmBase)
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
    'padrão: DuckDuckGo → Brave (site) ligados; APIs desligadas e travadas sem chave',
    async () => {
      await openWebSettings()
      const o = await order()
      assert(o === 'ddg+ brave-site+ brave-api- exa- tavily-', o)
      for (const [id, label] of [
        ['exa', 'Exa'],
        ['tavily', 'Tavily'],
        ['brave-api', 'Brave Search API']
      ]) {
        assert(await toggle(id, label).isDisabled(), `${id} travado`)
        await row(id).getByText('Informe a chave de API para habilitar').waitFor()
        assert(
          await row(id)
            .getByRole('button', { name: `Testar ${label}` })
            .isDisabled(),
          'testar'
        )
      }
      // a API recusa ligar sem chave
      const err = await page.evaluate(async () => {
        const api = (window as any).api
        const s = await api.webSearch.getSettings()
        try {
          await api.webSearch.updateEngines(
            s.engines.map((e: any) => ({ ...e, enabled: e.id === 'exa' ? true : e.enabled }))
          )
          return ''
        } catch (e) {
          return String((e as Error).message)
        }
      })
      assert(/Informe a chave de API para habilitar o Exa/.test(err), err)
      await dialog().getByTestId('web-search-settings').scrollIntoViewIfNeeded()
      await shot('padrao')
    }
  )

  await step('(i) da Exa mostra endpoint/headers/body sem a chave', async () => {
    const trigger = row('exa').getByRole('button', { name: 'O que é enviado para a API' })
    await trigger.hover()
    const tip = page.locator('[data-radix-popper-content-wrapper]').last()
    await tip.waitFor({ timeout: 3000 })
    const t = await tip.innerText()
    assert(t.includes('POST https://api.exa.ai/search'), t)
    assert(t.includes('Authorization: Bearer {sua chave}'), t)
    assert(t.includes('"highlights": true'), t)
    await shot('info-exa')
    await page.mouse.move(2, 2)
  })

  await step('salvar chaves: máscara, mostrar a pedido, setting protegido', async () => {
    await saveKey('exa', 'Exa', EXA_KEY)
    const input = row('exa').getByRole('textbox', { name: 'Chave de API (Exa)' })
    const ph = await input.getAttribute('placeholder')
    assert(ph?.startsWith('exa-…0001'), `placeholder ${ph}`)
    assert((await input.inputValue()) === '', 'campo vazio depois de salvar')
    const s = JSON.stringify(await call('webSearch.getSettings'))
    assert(!s.includes(EXA_KEY), 'chave em claro no getSettings')
    const prot = await page.evaluate(() =>
      (window as any).api.settings.get('webSearchApiKeys').then(
        () => 'leu',
        (e: Error) => e.message
      )
    )
    assert(/protegido/.test(prot), `settings.get: ${prot}`)
    await row('exa').getByRole('button', { name: 'Mostrar chave' }).click()
    await waitFor(async () => (await input.inputValue()) === EXA_KEY, 3000, 'revelar')
    assert((await input.getAttribute('type')) === 'text', 'type text')
    await row('exa').getByRole('button', { name: 'Ocultar chave' }).click()
    assert((await input.inputValue()) === '', 'oculta de novo')
    await saveKey('tavily', 'Tavily', TAVILY_KEY)
    await saveKey('brave-api', 'Brave Search API', BRAVE_KEY)
    return ph ?? ''
  })

  await step('habilitar Exa e Tavily; reordenar com ↑/↓ e arrastando', async () => {
    await toggle('exa', 'Exa').click()
    await toggle('tavily', 'Tavily').click()
    await waitFor(async () => (await order()).includes('exa+ tavily+'), 3000, 'habilitados')
    for (let i = 0; i < 3; i++)
      await row('exa').getByRole('button', { name: 'Subir Exa' }).click({ force: true })
    await waitFor(async () => (await order()).startsWith('exa+'), 3000, 'exa no topo')
    // arrasta o Tavily (5º) para cima do DuckDuckGo (2º)
    await row('tavily').getByTestId('engine-handle-tavily').dragTo(row('ddg'))
    const o = await waitFor(
      async () => {
        const v = await order()
        return v.startsWith('exa+ tavily+') ? v : null
      },
      3000,
      'tavily em 2º'
    )
    assert(o === 'exa+ tavily+ ddg+ brave-site+ brave-api-', o)
    // a ordem da tela acompanha
    const ids = await page
      .getByTestId('web-engines')
      .locator('> li')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    assert(
      ids.join(',') === 'engine-exa,engine-tavily,engine-ddg,engine-brave-site,engine-brave-api',
      ids.join(',')
    )
    return o
  })

  await step('desabilitar Brave (site); opções do Tavily', async () => {
    await toggle('brave-site', 'Brave (site)').click()
    await waitFor(async () => (await order()).includes('brave-site-'), 3000, 'brave-site off')
    const n = row('tavily').getByRole('spinbutton', { name: 'Resultados (Tavily)' })
    await n.fill('4')
    await n.press('Enter')
    await row('tavily').getByRole('button', { name: 'Profundidade (Tavily)' }).click()
    await page.getByRole('button', { name: /^basic/ }).click()
    await waitFor(
      async () => {
        const t = (await call<any>('webSearch.getSettings')).engines.find(
          (e: any) => e.id === 'tavily'
        )
        return t.options.maxResults === 4 && t.options.depth === 'basic'
      },
      3000,
      'opções salvas'
    )
  })

  await step('Testar: Tavily ok, Exa erro de cota, Brave API ok (gzip)', async () => {
    const before = searchHits.length
    await row('tavily').getByRole('button', { name: 'Testar Tavily' }).click()
    await row('tavily')
      .getByTestId('engine-test-tavily')
      .getByText(/Funcionou: 3 resultados/)
      .waitFor({ timeout: 10_000 })
    const tav = searchHits.slice(before).find((h) => h.path === '/tavily/search')!
    const body = JSON.parse(tav.body)
    assert(body.max_results === 3 && body.search_depth === 'basic', tav.body)
    await row('exa').getByRole('button', { name: 'Testar Exa' }).click()
    await row('exa')
      .getByText(/Erro: limite de uso\/cota atingido \(HTTP 429\)/)
      .waitFor({ timeout: 10_000 })
    await row('brave-api').getByRole('button', { name: 'Testar Brave Search API' }).click()
    await row('brave-api')
      .getByText(/Funcionou: 2 resultados/)
      .waitFor({ timeout: 10_000 })
    const br = searchHits.filter((h) => h.path === '/brave/res/v1/web/search').at(-1)!
    assert(br.headers['accept'] === 'application/json', 'accept')
    assert(/gzip/.test(br.headers['accept-encoding']), 'accept-encoding')
    // freio leve: testar de novo na hora é recusado sem ir à rede
    const n = searchHits.length
    await row('brave-api').getByRole('button', { name: 'Testar Brave Search API' }).click()
    await row('brave-api')
      .getByText(/Aguarde .* s para testar de novo/)
      .waitFor({ timeout: 5000 })
    assert(searchHits.length === n, 'cooldown sem rede')
    await shot('configurado-e-testado')
  })

  await step('remover chave desliga o buscador', async () => {
    await toggle('brave-api', 'Brave Search API').isDisabled()
    await row('brave-api').getByRole('button', { name: 'Remover chave (Brave Search API)' }).click()
    await row('brave-api').getByText('requer chave').waitFor()
    assert(await toggle('brave-api', 'Brave Search API').isDisabled(), 'travado de novo')
    const o = await order()
    assert(o.endsWith('brave-api-'), o)
  })

  await step(
    'pesquisa pelo runner: Exa falha (429) → Tavily responde; DDG não é chamado',
    async () => {
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      const st = await call<any>('approvals.getSettings')
      await call('approvals.updateSettings', { modes: { ...st.modes, search: 'always' } })
      const before = searchHits.length
      await composer().click()
      await composer().fill('pesquise sobre satisfies')
      await composer().press('Enter')
      const chat = (await call<any[]>('chats.list'))[0]
      const toolMsg = await waitFor(
        async () => {
          const msgs = await call<any[]>('sessions.messages', chat.mainSessionId)
          return msgs.find((m) => m.message.role === 'tool')
        },
        20_000,
        'resultado do web_search'
      )
      const content: string = toolMsg.message.content
      const first = content.split('\n')[0]
      assert(
        first ===
          'Resultados de Tavily para "typescript satisfies operator" (após falha em Exa: limite de uso/cota atingido (HTTP 429) — Rate limit exceeded):',
        first
      )
      assert(content.includes('1. TypeScript: Documentation - TypeScript 4.9'), 'resultado 1')
      const paths = searchHits.slice(before).map((h) => h.path)
      assert(paths.join(',') === '/exa/search,/tavily/search', paths.join(','))
      const exaBody = JSON.parse(searchHits.slice(before)[0].body)
      assert(
        exaBody.query === 'typescript satisfies operator' && exaBody.contents.highlights === true,
        'body exa'
      )
      await page
        .getByText(/^FIM — Resultados de Tavily/)
        .first()
        .waitFor({ timeout: 10_000 })
      // abre o card da tool para a screenshot
      await page
        .getByText('Pesquisa na web')
        .last()
        .click()
        .catch(() => {})
      await shot('runner-fallback')
      return first
    }
  )

  await app.close()
  llm?.close()
  search?.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} ok — screenshots em ${SHOTS}`)
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
