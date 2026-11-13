/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da UI real (Playwright `_electron`, app buildado) das tools compactadas e da tool `datetime`
// (protocolo 1.11.0): na aba Tools do chat, "Enviar tools compactadas" ligado por padrão com o </>
// mostrando o prompt fixo e a definição da search_tool exatamente como vão; o </> de cada tool
// mostra a definição enviada (compacta ou completa); o chip "compacta"/"completa" marca a tool
// (unidade `toolsFull.<tool>`, com "neste chat ↺"); a linha "Data e hora"; desligar a compactação
// (unidade `toolsCompact`) e o "Ver request" refletindo tudo; o editor de personas com a mesma
// opção (o chat que herda segue ao vivo); a lista de tools da chamada de voz com o </> do que vai.
// Provedor OpenAI-compatible FALSO local (nada de key real, nada de rede), userData isolado, sync
// apontado para um endereço morto (nunca o servidor de produção), microfone negado.
// Screenshots em $CLEARCHAT_SHOTS (padrão $CLEARCHAT_E2E_DIR/shots).
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/compact-ui.spec.ts
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { COMPACT_TOOLS_PROMPT, TOOL_SHORT_DESCRIPTIONS } from '../src/shared/compactTools.ts'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-compact-ui'))
const SHOTS = resolve(process.env.CLEARCHAT_SHOTS || join(BASE, 'shots'))
const CWD = join(BASE, 'cwd')
const MODEL = 'fake/agent'

let llm: Server
let llmBase = ''
let app: ElectronApplication
let page: Page
const requests: any[] = []

const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''
const chunk = (delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}

/** "hora" → o modelo chama datetime; depois do resultado (ou qualquer outra coisa) → texto. */
async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              {
                id: MODEL,
                context_length: 64000,
                supported_parameters: ['tools', 'temperature', 'max_tokens']
              }
            ]
          })
        )
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      requests.push(body)
      const last = (body.messages ?? []).at(-1)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (last?.role !== 'tool' && textOf(last?.content).trim() === 'hora') {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: { name: 'datetime', arguments: '{"format":"%Y"}' }
              }
            ]
          })
        )
        res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      res.write(chunk({ role: 'assistant', content: 'Pronto.' }))
      res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`
}

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = join(BASE, 'user-data')
  // sem login nada vai à rede; mesmo assim, nunca o servidor real
  env.CLEARCHAT_SYNC_URL = 'http://127.0.0.1:9'
  app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'compact-main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ dialog, session, BrowserWindow }, dir) => {
    // pasta do Novo chat → a de rascunho; microfone/câmera: sempre negados
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    BrowserWindow.getAllWindows()[0]?.setSize(1360, 900)
  }, CWD)
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  what: string,
  ms = 10_000
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando: ${what}`)
    await sleep(120)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

const shots: string[] = []
async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await sleep(300)
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path })
  shots.push(path)
}

const results: { name: string; ok: boolean; info?: string }[] = []
let stopped = false
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (stopped) return
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
    await shot(`erro-${results.length}`).catch(() => {})
    stopped = true // passos dependentes
  }
}

const panel = (): ReturnType<Page['getByTestId']> => page.getByTestId('right-panel')
const mark = (unit: string): ReturnType<Page['locator']> =>
  panel().locator(`[data-testid="inherit-revert"][data-units="${unit}"]`)
const chat = async (): Promise<any> => (await api<any[]>('chats.list'))[0]
const preview = async (): Promise<any> =>
  api<any>('agent.previewRequest', (await chat()).mainSessionId)
/** Conteúdo do tooltip "Enviado à API" aberto (portal do Radix). */
const tooltip = (): ReturnType<Page['locator']> =>
  page.locator('[data-radix-popper-content-wrapper]').filter({ hasText: 'Enviado à API' })

async function panelTab(name: string): Promise<void> {
  if (!(await panel().count())) await page.getByRole('button', { name: 'Abrir painel' }).click()
  await panel().getByRole('tab', { name, exact: true }).click()
}

/**
 * Passa o mouse no </> dentro de `scope` e devolve o texto do tooltip. O Radix às vezes não reabre
 * um tooltip logo depois de outro fechar: sai e passa de novo (até 3 vezes).
 */
async function openApi(scope: ReturnType<Page['locator']>): Promise<string> {
  const btn = scope.getByRole('button', { name: 'O que é enviado para a API' }).first()
  await btn.scrollIntoViewIfNeeded()
  for (let i = 0; ; i++) {
    await page.mouse.move(5, 5)
    await page.keyboard.press('Escape')
    await tooltip()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    await btn.hover()
    try {
      await tooltip().waitFor({ timeout: 3000 })
      return (await tooltip().innerText()).replace(/\s+/g, ' ')
    } catch (e) {
      if (i >= 2) throw e
    }
  }
}
const row = (tool: string): ReturnType<Page['locator']> =>
  panel().locator(`[data-collapse-id="tools-list"] [data-tool="${tool}"]`).first()

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(CWD, { recursive: true })
  await startLlm()
  await launch()
  let persona = ''

  await step('preparo: provedor falso, persona sem campos de tools e um chat novo', async () => {
    const p = await api('providers.create', {
      name: 'LLM falso',
      baseUrl: llmBase,
      apiKey: 'sk-fake'
    })
    await api('settings.set', 'defaultProviderId', p.id)
    await api('settings.set', 'defaultModel', MODEL)
    persona = (
      await api('presets.create', {
        name: 'Agente',
        description: 'Usa tools',
        icon: 'sparkles',
        config: { systemPrompt: 'Você usa tools.' }
      })
    ).id
    await api('settings.set', 'defaultPresetId', persona)
    await page.reload()
    await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 20_000 })
    await page.getByTestId('preset-picker').getByText('Agente', { exact: true }).waitFor()
    await page.getByRole('button', { name: /Começar/ }).click()
    const c = await waitFor(async () => (await chat()) ?? null, 'chat criado')
    assert(c.config.presetId === persona, 'herda a persona')
    assert(c.config.toolsCompact === true, `toolsCompact ${c.config.toolsCompact}`)
    assert(c.config.enabledTools.includes('datetime'), 'datetime no padrão de tools')
  })

  await step(
    'aba Tools: "Enviar tools compactadas" ligado; o </> mostra o prompt fixo e a search_tool',
    async () => {
      await panelTab('Tools')
      const rowEl = panel().getByTestId('tools-compact-row')
      await rowEl.waitFor()
      const sw = rowEl.getByRole('switch', { name: 'Enviar tools compactadas' })
      assert((await sw.getAttribute('aria-checked')) === 'true', 'ligado por padrão')
      assert((await mark('toolsCompact').count()) === 0, 'herdado (sem marca)')
      const tip = await openApi(rowEl)
      assert(tip.includes(COMPACT_TOOLS_PROMPT), 'prompt fixo exato no </>')
      assert(tip.includes('"name": "search_tool"'), 'definição da search_tool')
      assert(tip.includes('"names"'), 'parâmetro names')
      await page.getByTestId('compact-tools-prompt').waitFor()
      await shot('compact-01-tools-compactadas-api')
    }
  )

  await step(
    '</> de cada tool: a definição compacta (descrição curta + parâmetros vazios)',
    async () => {
      const tip = await openApi(row('read_file'))
      assert(
        tip.includes(TOOL_SHORT_DESCRIPTIONS.read_file.replace(/\s+/g, ' ')),
        'descrição curta'
      )
      assert(tip.includes('"properties": {}'), 'esquema vazio')
      assert(tip.includes('Vai compacta'), 'explica o modo')
      assert(!tip.includes('"offset"'), 'sem os parâmetros completos')
      await shot('compact-02-tool-compacta-api')
    }
  )

  await step('linha "Data e hora" (datetime) ligada, com o chip e o </>', async () => {
    const r = row('datetime')
    await r.getByText('Data e hora', { exact: true }).waitFor()
    const sw = r.getByRole('switch', { name: 'Data e hora' })
    assert((await sw.getAttribute('aria-checked')) === 'true', 'ligada por padrão')
    assert((await r.getByTestId('tool-full-datetime').innerText()) === 'compacta', 'chip compacta')
    const tip = await openApi(r)
    assert(tip.includes(TOOL_SHORT_DESCRIPTIONS.datetime), 'descrição curta do datetime')
    const req = await preview()
    const names = req.body.tools.map((t: any) => t.function.name)
    assert(names.includes('datetime') && names.at(-1) === 'search_tool', names.join(','))
  })

  await step(
    'chip "completa": vira própria do chat (toolsFull.read_file), </> e request completos',
    async () => {
      await page.mouse.move(5, 5)
      await row('read_file').getByTestId('tool-full-read_file').click()
      await mark('toolsFull.read_file').waitFor({ timeout: 5000 })
      const c = await waitFor(async () => {
        const x = await chat()
        return x.config.overrides?.['toolsFull.read_file'] && x
      }, 'toolsFull.read_file própria')
      assert(
        JSON.stringify(c.config.toolsFull) === '["read_file"]',
        JSON.stringify(c.config.toolsFull)
      )
      assert(
        Object.keys(c.config.overrides).join() === 'toolsFull.read_file',
        `só a escolha vira própria: ${Object.keys(c.config.overrides)}`
      )
      assert(
        (await row('read_file').getByTestId('tool-full-read_file').innerText()) === 'completa',
        'chip completa'
      )
      const tip = await openApi(row('read_file'))
      assert(tip.includes('"offset"') && !tip.includes('Vai compacta'), 'definição completa no </>')
      const req = await preview()
      const rf = req.body.tools.find((t: any) => t.function.name === 'read_file')
      const sh = req.body.tools.find((t: any) => t.function.name === 'shell')
      assert(rf.function.parameters.properties.path, 'read_file completa na request')
      assert(
        JSON.stringify(sh.function.parameters) === '{"type":"object","properties":{}}',
        'shell compacta'
      )
      assert(
        textOf(req.body.messages[0].content).endsWith(`\n\n${COMPACT_TOOLS_PROMPT}`),
        'prompt no fim'
      )
      await page.mouse.move(5, 5)
      await page.keyboard.press('Escape')
      await tooltip()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
      await row('read_file').scrollIntoViewIfNeeded()
      await shot('compact-03-chip-completa')
    }
  )

  await step('memória e skills: grupo próprio com o modo de envio e o </>', async () => {
    const grp = panel().getByTestId('tools-other-compact')
    await grp.scrollIntoViewIfNeeded()
    await grp.getByTestId('tool-full-memory_search').waitFor()
    const tip = await openApi(grp.locator('[data-tool="skill_load"]'))
    assert(tip.includes(TOOL_SHORT_DESCRIPTIONS.skill_load), 'skill_load compacta')
  })

  await step(
    'desligar a compactação: unidade toolsCompact própria; request sem search_tool nem prompt',
    async () => {
      await page.mouse.move(5, 5)
      const rowEl = panel().getByTestId('tools-compact-row')
      await rowEl.scrollIntoViewIfNeeded()
      await rowEl.getByRole('switch', { name: 'Enviar tools compactadas' }).click()
      await mark('toolsCompact').waitFor({ timeout: 5000 })
      await waitFor(async () => (await chat()).config.toolsCompact === false, 'toolsCompact false')
      assert((await panel().getByTestId('tool-full-shell').count()) === 0, 'sem chips')
      const req = await preview()
      const names = req.body.tools.map((t: any) => t.function.name)
      assert(!names.includes('search_tool'), names.join(','))
      assert(!JSON.stringify(req.body.messages).includes(COMPACT_TOOLS_PROMPT), 'sem prompt fixo')
      const sh = req.body.tools.find((t: any) => t.function.name === 'shell')
      assert(sh.function.parameters.properties.command, 'shell completa')
      const tip = await openApi(row('shell'))
      assert(tip.includes('"command"'), '</> completo')
      // voltar a herdar
      await page.mouse.move(5, 5)
      await mark('toolsCompact').click()
      await waitFor(async () => (await chat()).config.toolsCompact === true, 'herda de novo')
      await mark('toolsFull.read_file').click()
      await waitFor(async () => {
        const x = await chat()
        return JSON.stringify(x.config.overrides) === '{}' && x
      }, 'nada próprio')
    }
  )

  await step(
    'turno real: o modelo chama datetime (compacta) e recebe a data; sem aprovação',
    async () => {
      const c = await chat()
      await api('agent.send', c.mainSessionId, 'hora')
      const msgs = await waitFor(async () => {
        const list = await api<any[]>('sessions.messages', c.mainSessionId)
        return (
          list.some((m) => m.message.role === 'assistant' && m.message.content === 'Pronto.') &&
          list
        )
      }, 'turno terminou')
      const tool = msgs.find((m: any) => m.message.role === 'tool')
      assert(tool.meta.toolStatus === 'ok', `status ${tool.meta.toolStatus}`)
      assert(
        tool.message.content === String(new Date().getFullYear()),
        String(tool.message.content)
      )
      const req = requests.find((r) => textOf(r.messages.at(-1)?.content) === 'hora')
      const dt = req.tools.find((t: any) => t.function.name === 'datetime')
      assert(
        JSON.stringify(dt.function.parameters) === '{"type":"object","properties":{}}',
        'compacta'
      )
      await page.getByText('Data e hora').first().waitFor({ timeout: 5000 })
      await shot('compact-04-turno-datetime')
    }
  )

  await step(
    'persona: a mesma opção no editor; desligar nela → o chat que herda segue ao vivo',
    async () => {
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
      const r = dlg.getByTestId('preset-row').filter({ hasText: 'Agente' })
      await r.hover()
      await r.getByRole('button', { name: 'Editar' }).click()
      const ed = dlg.getByTestId('preset-editor')
      await ed.getByRole('tab', { name: 'Tools' }).click()
      const sw = ed.getByRole('switch', { name: 'Enviar tools compactadas' })
      assert((await sw.getAttribute('aria-checked')) === 'true', 'persona: ligado (Novos chats)')
      await ed.getByTestId('tool-full-shell').click()
      assert(
        (await ed.getByTestId('tool-full-shell').innerText()) === 'completa',
        'chip na persona'
      )
      await sw.click()
      await dlg.getByRole('button', { name: 'Salvar persona' }).click()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 })
      const p = (await api<any[]>('presets.list')).find((x) => x.id === persona)
      assert(p.config.toolsCompact === false, 'persona grava toolsCompact')
      assert(JSON.stringify(p.config.toolsFull) === '["shell"]', JSON.stringify(p.config.toolsFull))
      const c = await waitFor(async () => {
        const x = await chat()
        return x.config.toolsCompact === false && x
      }, 'chat segue a persona')
      assert(JSON.stringify(c.config.overrides) === '{}', 'continua herdando')
      await panelTab('Tools')
      const csw = panel().getByRole('switch', { name: 'Enviar tools compactadas' })
      assert((await csw.getAttribute('aria-checked')) === 'false', 'painel mostra o herdado')
      const req = await preview()
      assert(!req.body.tools.some((t: any) => t.function.name === 'search_tool'), 'sem search_tool')
      // volta ao padrão para os próximos passos
      await api('presets.update', persona, { config: { systemPrompt: 'Você usa tools.' } })
      await waitFor(
        async () => (await chat()).config.toolsCompact === true,
        'persona sem os campos'
      )
    }
  )

  await step(
    'chamada de voz: a lista de tools próprias tem o </> com o que vai (compacta)',
    async () => {
      await panelTab('Voz')
      const tsw = panel().getByRole('switch', { name: 'Tools próprias na chamada' })
      await tsw.scrollIntoViewIfNeeded()
      await tsw.click()
      const list = panel().getByTestId('voice-call-tools')
      await list.waitFor({ timeout: 5000 })
      await list.getByText(/Vão compactas como no chat/).waitFor()
      const tip = await openApi(list.locator('[data-tool="shell"]'))
      assert(tip.includes(TOOL_SHORT_DESCRIPTIONS.shell), 'shell compacta no </> da chamada')
      await shot('compact-05-voz-tools')
      await page.mouse.move(5, 5)
      await tsw.click()
    }
  )

  await app.close()
  llm.close()
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passos ok`)
  console.log(`screenshots:\n${shots.join('\n')}`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
}

main().catch(async (e) => {
  console.error(e)
  await app?.close().catch(() => {})
  llm?.close()
  process.exit(1)
})
