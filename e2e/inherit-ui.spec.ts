/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da UI real (Playwright `_electron`, app buildado) da herança ao vivo da persona (protocolo
// 1.10.0): Novo chat marca como próprio só o que o usuário mudou no formulário; no painel do chat
// os campos próprios ganham "neste chat ↺" (voltar a herdar, com o valor herdado no tooltip) e os
// herdados seguem a persona ao vivo (editada pela UI das Configurações); o seletor "Persona de
// origem" troca de persona (mantém os próprios) e "Nenhuma" congela (explica antes de aplicar); as
// tools só do celular aparecem esmaecidas em "Só no celular", alternáveis, e não vão na request.
// Provedor OpenAI-compatible FALSO local (nada de key real, nada de rede), userData isolado, sync
// apontado para um endereço morto (nunca o servidor de produção), microfone negado.
// Screenshots em $CLEARCHAT_SHOTS (padrão $CLEARCHAT_E2E_DIR/shots).
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/inherit-ui.spec.ts
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-inherit-ui'))
const SHOTS = resolve(process.env.CLEARCHAT_SHOTS || join(BASE, 'shots'))
const CWD = join(BASE, 'cwd')
const MODEL = 'fake/agent'

let llm: Server
let llmBase = ''
let app: ElectronApplication
let page: Page

async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            {
              id: MODEL,
              context_length: 64000,
              supported_parameters: ['tools', 'temperature', 'top_p', 'max_tokens']
            }
          ]
        })
      )
      return
    }
    res.writeHead(404)
    res.end()
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
  const log = createWriteStream(join(BASE, 'inherit-main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ dialog, session, BrowserWindow }, dir) => {
    // pasta do Novo chat → a de rascunho; microfone/câmera: sempre negados
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    BrowserWindow.getAllWindows()[0]?.setSize(1360, 860)
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

async function panelTab(name: string): Promise<void> {
  if (!(await panel().count())) await page.getByRole('button', { name: 'Abrir painel' }).click()
  await panel().getByRole('tab', { name, exact: true }).click()
}

async function expand(id: string, scope = panel()): Promise<void> {
  const btn = scope.getByTestId(`collapse-${id}`)
  await btn.scrollIntoViewIfNeeded()
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click()
  await scope.locator(`[data-collapse-id="${id}"][data-open]`).waitFor()
}

const chat = async (): Promise<any> => (await api<any[]>('chats.list'))[0]

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(CWD, { recursive: true })
  await startLlm()
  await launch()
  let revisor = ''
  let tradutor = ''

  await step('preparo: provedor falso, padrão de Novos chats e duas personas', async () => {
    const p = await api('providers.create', {
      name: 'LLM falso',
      baseUrl: llmBase,
      apiKey: 'sk-fake'
    })
    await api('settings.set', 'defaultProviderId', p.id)
    await api('settings.set', 'defaultModel', MODEL)
    revisor = (
      await api('presets.create', {
        name: 'Revisor',
        description: 'Revisa código',
        icon: 'sparkles',
        config: {
          systemPrompt: 'Você revisa código.',
          params: { temperature: 0.2 },
          autoCompact: true
        }
      })
    ).id
    tradutor = (
      await api('presets.create', {
        name: 'Tradutor',
        description: 'Traduz textos',
        icon: 'sparkles',
        config: { systemPrompt: 'Você traduz textos.', autoCompact: false }
      })
    ).id
    await api('settings.set', 'defaultPresetId', revisor)
    await page.reload()
    await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 20_000 })
  })

  await step('Novo chat: só o que mudou no formulário vira próprio (overrides)', async () => {
    const picker = page.getByTestId('preset-picker')
    await picker.getByText('Revisor', { exact: true }).waitFor({ timeout: 10_000 })
    await page
      .getByRole('button', { name: /Alterar/ })
      .first()
      .click()
    await page.getByTestId('new-chat-root').getByText('cwd').waitFor({ timeout: 5000 })
    await page
      .getByPlaceholder('Instruções para o modelo (opcional)')
      .fill('Prompt próprio do chat.')
    await picker.getByText('Personalizado').waitFor({ timeout: 3000 })
    await shot('inherit-01-novo-chat-alterado')
    await page.getByRole('button', { name: /Começar/ }).click()
    const c = await waitFor(async () => (await chat()) ?? null, 'chat criado')
    assert(c.config.presetId === revisor, 'persona de origem')
    assert(
      JSON.stringify(c.config.overrides) === '{"systemPrompt":true}',
      `overrides ${JSON.stringify(c.config.overrides)}`
    )
    assert(c.config.systemPrompt === 'Prompt próprio do chat.', 'prompt próprio')
    assert(
      c.config.autoCompact === true && c.config.params.temperature === 0.2,
      'herdados da persona'
    )
    return `overrides=${JSON.stringify(c.config.overrides)}`
  })

  await step(
    'painel: campo próprio marcado "neste chat", herdados sem marca; editar marca',
    async () => {
      await panelTab('Modelo')
      await expand('system-prompt')
      await mark('systemPrompt').waitFor({ timeout: 5000 })
      await expand('params')
      assert((await mark('params.temperature').count()) === 0, 'temperature herdada (sem marca)')
      const t = panel().getByLabel('temperature', { exact: true })
      await t.fill('0.7')
      await mark('params.temperature').waitFor({ timeout: 5000 })
      await waitFor(
        async () => (await chat()).config.overrides?.['params.temperature'],
        'temperature própria'
      )
      // o tooltip mostra o valor herdado
      await mark('params.temperature').hover()
      await page.getByText(/Herdado: 0\.2 — persona “Revisor”/).waitFor({ timeout: 5000 })
      await shot('inherit-02-painel-modelo-proprio-x-herdado')
      await page.mouse.move(5, 5)
    }
  )

  await step(
    'Tools: tool e aprovação por item — ★ marca o herdado; escolher ★ volta a herdar',
    async () => {
      await panelTab('Tools')
      await page
        .getByTestId('inherit-banner')
        .getByText(/seguem “Revisor” ao vivo/)
        .waitFor()
      await panel().getByRole('switch', { name: 'Terminal (shell)' }).click()
      await mark('enabledTools.shell').waitFor({ timeout: 5000 })
      await expand('approvals')
      const sel = panel().getByTestId('chat-mode-pages')
      assert((await sel.getAttribute('data-inherit')) === 'true', 'páginas herdadas')
      await sel.locator('[data-mode="always"]').click()
      await mark('approvalModes.pages').waitFor({ timeout: 5000 })
      await waitFor(
        async () => (await chat()).config.overrides?.['approvalModes.pages'],
        'aprovação própria'
      )
      await mark('approvalModes.pages').scrollIntoViewIfNeeded()
      await shot('inherit-02b-painel-tools-aprovacoes')
      // a opção ★ (o valor herdado) volta a herdar — sem opção "herdar" duplicada
      await sel.locator('[data-global]').click()
      await waitFor(
        async () => !(await chat()).config.overrides?.['approvalModes.pages'],
        'aprovação herdada de novo'
      )
      assert((await sel.getAttribute('data-inherit')) === 'true', 'segue o herdado')
      // a tool volta a herdar pela marca
      await mark('enabledTools.shell').click()
      await waitFor(
        async () => (await chat()).config.enabledTools.includes('shell'),
        'shell herdada de novo'
      )
    }
  )

  await step(
    'Tools: "Só no celular" esmaecido com a nota, alternável, herda como as outras; não vai na request',
    async () => {
      await panelTab('Tools')
      const grp = panel().getByTestId('tools-device-phone')
      await grp.scrollIntoViewIfNeeded()
      await grp.getByText(/Não vão ao modelo quando o chat roda neste computador/).waitFor()
      const loc = grp.getByRole('switch', { name: 'Localização' })
      assert((await loc.getAttribute('aria-checked')) === 'true', 'ligada (padrão do app, herdado)')
      assert((await mark('enabledTools.get_location').count()) === 0, 'herdada (sem marca)')
      const c0 = await chat()
      assert(
        c0.config.enabledTools.includes('get_location') &&
          !c0.config.overrides?.['enabledTools.get_location'],
        'na lista do chat sem ser própria'
      )
      // a request daqui nunca leva as do celular (nem no texto das tools)
      const req = await api<any>('agent.previewRequest', c0.mainSessionId)
      const names = (req.body.tools ?? []).map((t: any) => t.function.name)
      assert(names.includes('read_file') && !names.includes('get_location'), names.join(','))
      assert(!JSON.stringify(req.body).includes('nearby_places'), 'nada do celular na request')
      await loc.click()
      await mark('enabledTools.get_location').waitFor({ timeout: 5000 })
      const c = await waitFor(async () => {
        const x = await chat()
        return x.config.overrides?.['enabledTools.get_location'] && x
      }, 'get_location própria')
      assert(!c.config.enabledTools.includes('get_location'), 'desligada no chat')
      assert(c.config.enabledTools.includes('nearby_places'), 'a outra continua')
      assert(
        Object.keys(c.config.overrides).filter((u) => u.startsWith('enabledTools.')).length === 1,
        'só a escolha do usuário vira própria'
      )
      await grp.scrollIntoViewIfNeeded()
      await shot('inherit-07-tools-so-no-celular')
      await mark('enabledTools.get_location').click()
      await waitFor(async () => {
        const x = await chat()
        return !x.config.overrides?.['enabledTools.get_location'] &&
          x.config.enabledTools.includes('get_location')
          ? x
          : null
      }, 'get_location herda de novo')
    }
  )

  await step(
    'persona editada nas Configurações: o chat que herda muda junto (ao vivo)',
    async () => {
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
      const row = dlg.getByTestId('preset-row').filter({ hasText: 'Revisor' })
      await row.getByTestId('preset-following').getByText('1 chat segue').waitFor({ timeout: 5000 })
      await row.hover()
      await row.getByRole('button', { name: 'Editar' }).click()
      const ed = dlg.getByTestId('preset-editor')
      await ed.getByRole('tab', { name: 'Chat' }).click()
      await expand('compaction', ed)
      await ed.getByRole('switch', { name: 'Compactar automaticamente' }).click()
      await ed.getByRole('tab', { name: 'Modelo' }).click()
      await expand('system-prompt', ed)
      await ed.getByLabel('System prompt', { exact: true }).fill('Você revisa código com rigor.')
      await dlg.getByRole('button', { name: 'Salvar persona' }).click()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 })
      const c = await waitFor(async () => {
        const x = await chat()
        return x.config.autoCompact === false && x
      }, 'autoCompact herdado mudou')
      assert(c.config.systemPrompt === 'Prompt próprio do chat.', 'o próprio não muda')
      const rec = await api<any>('chats.get', c.id)
      assert(rec.config.autoCompact === false, 'IPC já devolve o efetivo')
      await panelTab('Chat')
      await expand('compaction')
      const sw = panel().getByRole('switch', { name: 'Compactar automaticamente' })
      assert((await sw.getAttribute('aria-checked')) === 'false', 'painel mostra o herdado novo')
    }
  )

  await step('voltar a herdar: o prompt próprio sai e passa a ser o da persona', async () => {
    await panelTab('Modelo')
    await expand('system-prompt')
    await mark('systemPrompt').click()
    const c = await waitFor(async () => {
      const x = await chat()
      return !x.config.overrides?.systemPrompt && x
    }, 'systemPrompt herdado')
    assert(
      c.config.systemPrompt === 'Você revisa código com rigor.',
      `prompt ${c.config.systemPrompt}`
    )
    await panel().getByLabel('System prompt', { exact: true }).waitFor()
    const v = await panel().getByLabel('System prompt', { exact: true }).inputValue()
    assert(v === 'Você revisa código com rigor.', `textarea ${v}`)
    assert((await mark('systemPrompt').count()) === 0, 'sem marca')
  })

  await step('trocar de persona: os próprios ficam, os herdados seguem a nova', async () => {
    await panelTab('Chat')
    await page
      .getByTestId('persona-inherit-note')
      .getByText(/1 campo é deste chat/)
      .waitFor()
    await panel().getByRole('button', { name: 'Persona de origem' }).click()
    await sleep(200)
    await shot('inherit-03-seletor-persona')
    await page.getByRole('button', { name: /^Tradutor/ }).click()
    const c = await waitFor(async () => {
      const x = await chat()
      return x.config.presetId === tradutor && x
    }, 'persona trocada')
    assert(c.config.systemPrompt === 'Você traduz textos.', 'prompt herdado da nova')
    assert(c.config.params.temperature === 0.7, 'temperature própria mantida')
    assert(
      JSON.stringify(c.config.overrides) === '{"params.temperature":true}',
      'overrides mantido'
    )
    await page
      .getByTestId('persona-inherit-note')
      .getByText(/Segue “Tradutor” ao vivo/)
      .waitFor()
    await shot('inherit-04-persona-trocada')
  })

  await step('"Nenhuma": explica antes e congela os valores atuais', async () => {
    await panel().getByRole('button', { name: 'Persona de origem' }).click()
    await page.getByRole('button', { name: /^Nenhuma/ }).click()
    await page.getByTestId('persona-none-confirm').waitFor()
    await shot('inherit-05-nenhuma-explica')
    await page.getByTestId('persona-none-apply').click()
    const c = await waitFor(async () => {
      const x = await chat()
      return !x.config.presetId && x
    }, 'sem persona')
    assert(c.config.systemPrompt === 'Você traduz textos.', 'valor congelado')
    assert(c.config.autoCompact === false, 'herdado congelado')
    assert(c.config.overrides?.['params.temperature'] === true, 'overrides mantido (sem efeito)')
    await page
      .getByTestId('persona-inherit-note')
      .getByText(/Sem persona/)
      .waitFor()
    // persona mudada depois não afeta mais o chat
    await api('presets.update', tradutor, { config: { systemPrompt: 'Outro prompt.' } })
    assert((await chat()).config.systemPrompt === 'Você traduz textos.', 'congelado de verdade')
    await shot('inherit-06-sem-persona')
  })

  await step('apagar a persona congela os chats dela', async () => {
    // novo chat com a Revisor (sem mudar nada) → apagar a Revisor pela UI
    await page.getByRole('button', { name: 'Novo chat' }).first().click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor()
    await page.getByRole('button', { name: /Começar/ }).click()
    const c = await waitFor(async () => {
      const list = await api<any[]>('chats.list')
      return list.length === 2 && list[0]
    }, 'segundo chat')
    assert(JSON.stringify(c.config.overrides) === '{}', 'nada próprio')
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
    const row = dlg.getByTestId('preset-row').filter({ hasText: 'Revisor' })
    await row.hover()
    await row.getByRole('button', { name: 'Apagar' }).click()
    await row.getByRole('button', { name: 'Apagar?' }).click()
    await row.waitFor({ state: 'detached', timeout: 5000 })
    await page.keyboard.press('Escape')
    const f = await api<any>('chats.get', c.id)
    assert(!f.config.presetId, 'presetId removido')
    assert(f.config.systemPrompt === 'Você revisa código com rigor.', 'valores efetivos gravados')
  })

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
