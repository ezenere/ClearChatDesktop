/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da UI dos CONECTORES (MCP) contra o MOCK de UI (Playwright + `e2e/launch.ts`, sem backend, sem
// key, sem servidor MCP de verdade): builda o renderer com VITE_CLEAR_MOCK=1 numa pasta de rascunho
// (não mexe em out/), abre `index.html?scenario=mcp` numa janela Electron mínima (userData isolado
// na pasta do teste) e percorre:
//   Configurações → Conectores (os 2 conectores de demonstração com estado certo: "playwright"
//   local conectado, "notion" remoto pedindo login); expandido: tools com o que o servidor declara,
//   dicas, aprovação por tool com ★ no padrão do conector (exceção ↔ voltar ao padrão), log;
//   Desativar → "Ativar neste computador" com a confirmação do comando EXATO; Entrar (OAuth) →
//   aguardando o navegador → conectado → Sair → Entrar → Cancelar; formulário (nome inválido, nome
//   repetido, criar um stdio com variável mascarada → "não ativado"); Importar (config conhecida do
//   Claude Desktop → prévia com nota do SSE e ignorados → importar 2); painel do chat → aba Tools →
//   seção Conectores (fechada, resumo, liga o conector → config gravada, (</>) com
//   `mcp__playwright__browser_navigate`, checklist de tools → `off`, instruções do servidor com o
//   bloco exato, chip "não ativado aqui"); cards das tools `mcp__…` (cabeçalho "Conector … · tool",
//   argumentos formatados, erro, pendente, registro "Conector"); card de aprovação de tool de
//   conector; formulário do conector (elicitação) no lugar do campo de mensagem: erros por campo,
//   enviar → valores tipados e resultado no chat; formulário sem chat (aviso flutuante) → Recusar.
// Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-mcp-ui node e2e/mcp-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-mcp-ui'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
const USER_DATA = join(BASE, 'userdata')
const STOP_AFTER = process.argv[2] ?? ''

let app: ElectronApplication
let page: Page
let stopped = false
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (stopped) return
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(
      `✖ ${name} — ${(e as Error).message
        .split('\n')
        .slice(0, process.env.E2E_VERBOSE ? 30 : 3)
        .join('\n')}`
    )
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

const settings = (): ReturnType<Page['locator']> => page.locator('[role="dialog"]')
const panel = (): ReturnType<Page['locator']> => page.getByTestId('right-panel')
const server = (name: string): ReturnType<Page['locator']> =>
  settings().locator(`[data-testid="mcp-server"][data-name="${name}"]`)
const status = (name: string): Promise<string | null> =>
  server(name).getByTestId('mcp-status').getAttribute('data-state')

async function waitState(name: string, state: string): Promise<void> {
  await settings()
    .locator(
      `[data-testid="mcp-server"][data-name="${name}"] [data-testid="mcp-status"][data-state="${state}"]`
    )
    .waitFor({ timeout: 5000 })
}

async function openConectores(): Promise<void> {
  if (
    !(await settings()
      .isVisible()
      .catch(() => false))
  )
    await page.getByRole('button', { name: /^Configurações/ }).click()
  await settings().getByRole('button', { name: 'Conectores', exact: true }).click()
  await settings().getByTestId('mcp-settings').waitFor()
}

async function closeSettings(): Promise<void> {
  if (
    !(await settings()
      .isVisible()
      .catch(() => false))
  )
    return
  await page.keyboard.press('Escape')
  await settings().waitFor({ state: 'detached' })
}

async function openChat(title: string): Promise<void> {
  await page.getByTestId('chat-item').filter({ hasText: title }).first().click()
  await page.getByTestId('chat-scroller').waitFor()
}

async function openPanelTab(chat: string, tab: string): Promise<void> {
  await openChat(chat)
  if (
    !(await panel()
      .isVisible()
      .catch(() => false))
  )
    await page.getByRole('button', { name: 'Abrir painel' }).click()
  await panel().getByRole('tab', { name: tab }).click()
}

/** Abre a seção recolhível `id` (CollapsibleSection) dentro de `scope`, se estiver fechada. */
async function expand(scope: ReturnType<Page['locator']>, id: string): Promise<void> {
  const btn = scope.getByTestId(`collapse-${id}`)
  await btn.scrollIntoViewIfNeeded()
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click()
  await scope.locator(`[data-collapse-id="${id}"][data-open]`).waitFor()
}

/**
 * Fecha os tooltips Radix: sair do gatilho num salto só deixa o ponteiro na "área de graça" (o
 * tooltip continua aberto) — o movimento em passos sai dela. Destino: o vazio da barra lateral.
 */
async function closeTips(): Promise<void> {
  await page.mouse.move(120, 780, { steps: 12 })
  await page
    .locator('[data-radix-popper-content-wrapper]')
    .first()
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => undefined)
}

/** Abre o (</>) / (?) (tooltip Radix) e devolve o texto. */
async function infoText(trigger: ReturnType<Page['locator']>): Promise<string> {
  const tip = page.locator('[data-radix-popper-content-wrapper]').last()
  for (let i = 0; ; i++) {
    await closeTips()
    await page.waitForTimeout(150)
    await trigger.scrollIntoViewIfNeeded()
    await trigger.hover()
    try {
      await tip.waitFor({ timeout: 2500 })
      await page.waitForTimeout(200)
      return (await tip.innerText()).trim()
    } catch (e) {
      if (i >= 2) throw e
    }
  }
}

const chatConfig = (chatId: string): Promise<any> =>
  page.evaluate(
    (id) =>
      (window as any).__clearStore.getState().chats.find((c: any) => c.id === id)?.config ?? null,
    chatId
  )

async function main(): Promise<void> {
  rmSync(SHOTS, { recursive: true, force: true })
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  if (!process.env.SKIP_BUILD) {
    execSync(`npx electron-vite build --outDir "${BUILD}"`, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_CLEAR_MOCK: '1' }
    })
  }
  const mainJs = join(BASE, 'mock-main.cjs')
  writeFileSync(
    mainJs,
    `const { app, BrowserWindow } = require('electron')
// userData isolado (localStorage das seções recolhíveis etc.) — nunca a pasta real do app
app.setPath('userData', ${JSON.stringify(USER_DATA)})
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=mcp' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await launchElectron({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
  )
  await page.getByTestId('chat-item').first().waitFor({ timeout: 20_000 })

  await step('Conectores: os 2 de demonstração com o estado certo', async () => {
    await openConectores()
    assert.equal(
      await settings().locator('#settings-panel-title').innerText(),
      'Conectores · Servidores MCP'
    )
    const names = await settings()
      .getByTestId('mcp-server')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))
    assert.deepEqual(names, ['playwright', 'notion'])
    assert.equal(await status('playwright'), 'ready')
    assert.match(
      await server('playwright').getByTestId('mcp-status').innerText(),
      /Conectado \(4 tools\)/
    )
    assert.equal(
      await server('playwright').getByTestId('mcp-transport').innerText(),
      'local (stdio)'
    )
    assert.equal(await status('notion'), 'needs-auth')
    assert.match(await server('notion').getByTestId('mcp-status').innerText(), /Precisa entrar/)
    assert.equal(await server('notion').getByTestId('mcp-transport').innerText(), 'remoto (HTTP)')
    await server('notion').getByRole('button', { name: 'Entrar' }).waitFor()
    await server('playwright').getByRole('button', { name: 'Desativar' }).waitFor()
    await shot('01-conectores')
  })

  await step('busca das Configurações: "oauth" / "mcp" levam a Conectores', async () => {
    const search = settings().getByLabel('Procurar nas configurações')
    await search.first().fill('mcp')
    const nav = settings().locator('nav[aria-label="Seções das configurações"]')
    await nav.getByRole('button', { name: 'Conectores', exact: true }).waitFor()
    await search.first().fill('oauth')
    assert.equal(await nav.locator('button[data-nav-item]').count(), 1)
    await search.first().fill('')
  })

  await step(
    'expandido: tools declaradas, dicas, ★ no padrão e exceção por tool, log',
    async () => {
      const pw = server('playwright')
      await pw.getByRole('button', { name: 'Expandir Navegador (Playwright)' }).click()
      const body = pw.getByTestId('mcp-server-body')
      await body.waitFor()
      const tools = await body
        .getByTestId('mcp-tool')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-tool')))
      assert.deepEqual(tools, [
        'browser_navigate',
        'browser_snapshot',
        'browser_click',
        'browser_take_screenshot'
      ])
      const tool = (t: string): ReturnType<Page['locator']> =>
        body.locator(`[data-testid="mcp-tool"][data-tool="${t}"]`)
      assert.match(await tool('browser_navigate').innerText(), /Abre uma URL na aba atual\./)
      assert.match(await tool('browser_snapshot').innerText(), /somente leitura/)
      assert.match(await tool('browser_click').innerText(), /destrutiva/)
      // padrão do conector = Perguntar (★); browser_snapshot tem exceção "Sempre permitir"
      assert.equal(await body.getByTestId('mcp-default-mode').getAttribute('data-value'), 'ask')
      const nav = body.getByTestId('mcp-tool-mode-browser_navigate')
      assert.equal(await nav.getAttribute('data-inherit'), 'true')
      assert.equal(await nav.locator('[data-default]').getAttribute('data-mode'), 'ask')
      assert.match(await nav.locator('[data-default]').innerText(), /Perguntar/)
      const snap = body.getByTestId('mcp-tool-mode-browser_snapshot')
      assert.equal(await snap.getAttribute('data-value'), 'always')
      assert.equal(await snap.getAttribute('data-inherit'), null)
      // exceção na navegação → Smart-Approve; escolher a ★ volta ao padrão
      await nav.getByRole('radio', { name: /Smart-Approve/ }).click()
      await body
        .locator('[data-testid="mcp-tool-mode-browser_navigate"][data-value="smart"]')
        .waitFor()
      assert.equal(
        await body.getByTestId('mcp-tool-mode-browser_navigate').getAttribute('data-inherit'),
        null
      )
      await shot('02-tools-aprovacao')
      await body
        .getByTestId('mcp-tool-mode-browser_navigate')
        .getByRole('radio', { name: /Perguntar/ })
        .click()
      await body
        .locator('[data-testid="mcp-tool-mode-browser_navigate"][data-inherit="true"]')
        .waitFor()
      const approval = await page.evaluate(
        () =>
          (window as any).__clearStore
            .getState()
            .mcp.find((v: any) => v.server.name === 'playwright').server.approval
      )
      assert.deepEqual(approval, { mode: 'ask', tools: { browser_snapshot: 'always' } })
      assert.match(await body.getByTestId('mcp-log').innerText(), /Playwright MCP 0\.0\.41/)
    }
  )

  await step('Desativar → "Ativar neste computador" mostra o comando exato', async () => {
    const pw = server('playwright')
    await pw.getByRole('button', { name: 'Desativar' }).click()
    await waitState('playwright', 'not-activated')
    assert.match(await pw.getByTestId('mcp-status').innerText(), /Não ativado neste computador/)
    await pw.getByRole('button', { name: 'Ativar neste computador' }).click()
    const confirm = pw.getByTestId('mcp-activate-confirm')
    await confirm.waitFor()
    assert.equal(
      (await confirm.getByTestId('mcp-activate-command').innerText()).trim(),
      'npx -y @playwright/mcp@latest'
    )
    assert.match(
      await confirm.innerText(),
      /Roda como um programa neste computador, com as suas permissões\./
    )
    await shot('03-ativar-confirmacao')
    await confirm.getByTestId('mcp-activate-apply').click()
    await waitState('playwright', 'ready')
    assert.equal(await pw.getByTestId('mcp-activate-confirm').count(), 0)
    // recolhe para as próximas telas
    await pw.getByRole('button', { name: 'Recolher Navegador (Playwright)' }).click()
  })

  await step('OAuth: Entrar → aguardando o navegador → conectado; Sair; Cancelar', async () => {
    const no = server('notion')
    await no.getByRole('button', { name: 'Entrar' }).click()
    await no.getByTestId('mcp-login-waiting').waitFor()
    await shot('04-oauth-aguardando')
    await no.getByRole('button', { name: 'Sair' }).waitFor({ timeout: 5000 })
    await waitState('notion', 'ready')
    await no.getByRole('button', { name: 'Sair' }).click()
    await waitState('notion', 'needs-auth')
    await no.getByRole('button', { name: 'Entrar' }).click()
    await no.getByTestId('mcp-login-waiting').waitFor()
    await no.getByRole('button', { name: 'Cancelar' }).click()
    await no.getByRole('button', { name: 'Entrar' }).waitFor()
    assert.equal(await no.getByTestId('mcp-login-error').count(), 0, 'cancelar não é erro')
    // entra de vez (o painel mais adiante vê o notion disponível)
    await no.getByRole('button', { name: 'Entrar' }).click()
    await no.getByRole('button', { name: 'Sair' }).waitFor({ timeout: 5000 })
  })

  await step(
    'formulário: nome inválido / repetido; cria um local (variável mascarada)',
    async () => {
      await settings().getByRole('button', { name: 'Adicionar conector' }).click()
      const form = settings().getByTestId('mcp-form')
      await form.waitFor()
      await form.getByLabel('Título do conector').fill('Meus Arquivos')
      assert.equal(await form.getByLabel('Nome curto do conector').inputValue(), 'meus-arquivos')
      await form.getByLabel('Nome curto do conector').fill('Bad_Name')
      await form.getByLabel('Comando', { exact: true }).fill('npx')
      await form.getByTestId('mcp-form-save').click()
      const err = form.getByTestId('mcp-field-error').first()
      await err.waitFor()
      assert.match(await err.innerText(), /letras minúsculas, números e hífens/)
      await shot('05-form-nome-invalido')
      await form.getByLabel('Nome curto do conector').fill('playwright')
      await form.getByTestId('mcp-form-save').click()
      await form.getByText('Já existe um conector chamado “playwright”.').waitFor()
      await form.getByLabel('Nome curto do conector').fill('meus-arquivos')
      await form
        .getByLabel('Argumentos (um por linha)')
        .fill('-y\n@modelcontextprotocol/server-filesystem\n/home/dev/Documentos')
      await form.getByRole('button', { name: 'Adicionar variável' }).click()
      await form.getByLabel('Nome da variável 1').fill('FS_TOKEN')
      const val = form.getByLabel('Valor da variável FS_TOKEN', { exact: true })
      await val.fill('segredo-123')
      assert.equal(await val.getAttribute('type'), 'password')
      await form.getByTestId('mcp-form-save').click()
      await server('meus-arquivos').waitFor()
      await waitState('meus-arquivos', 'not-activated')
      await server('meus-arquivos').getByRole('button', { name: 'Ativar neste computador' }).click()
      const cmd = server('meus-arquivos').getByTestId('mcp-activate-command')
      assert.equal(
        (await cmd.innerText()).trim(),
        'npx -y @modelcontextprotocol/server-filesystem /home/dev/Documentos'
      )
      assert.match(
        await server('meus-arquivos').getByTestId('mcp-activate-confirm').innerText(),
        /\+ 1 variável/
      )
      await server('meus-arquivos').getByRole('button', { name: 'Cancelar' }).click()
      const saved = await page.evaluate(
        () =>
          (window as any).__clearStore
            .getState()
            .mcp.find((v: any) => v.server.name === 'meus-arquivos').server
      )
      assert.equal(saved.title, 'Meus Arquivos')
      assert.deepEqual(saved.transport.env, { FS_TOKEN: 'segredo-123' })
    }
  )

  await step('importar: config do Claude Desktop → prévia → importa 2', async () => {
    await settings().getByRole('button', { name: 'Importar…' }).click()
    const imp = settings().getByTestId('mcp-import')
    await imp.waitFor()
    await imp.getByRole('button', { name: 'Claude Desktop' }).click()
    const prev = imp.getByTestId('mcp-import-preview')
    await prev.waitFor()
    const items = await prev
      .getByTestId('mcp-import-item')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))
    assert.deepEqual(items, ['filesystem', 'linear'])
    assert.match(await prev.innerText(), /SSE \(transporte antigo\)/)
    assert.match(await prev.innerText(), /precisa ativar/)
    assert.match(await imp.getByTestId('mcp-import-skipped').innerText(), /quebrado/)
    await shot('06-importar-previa')
    await imp.getByTestId('mcp-import-confirm').click()
    await server('linear').waitFor()
    await waitState('filesystem', 'not-activated')
    assert.equal(await settings().getByTestId('mcp-import').count(), 0)
  })

  await step('painel → Tools → Conectores: liga, (</>) exato, tools, instruções', async () => {
    await closeSettings()
    await openPanelTab('Refatorar o parser de SSE', 'Tools')
    const sec = panel().locator('[data-collapse-id="mcp"]')
    await sec.waitFor()
    assert.equal(await sec.getAttribute('data-open'), null, 'fechada por padrão')
    assert.equal(await sec.getByTestId('collapse-summary').innerText(), 'desligados')
    await expand(panel(), 'mcp')
    const sw = sec.getByRole('switch', { name: 'Conector Navegador (Playwright)' })
    await sw.click()
    await page.waitForFunction(
      () =>
        (window as any).__clearStore.getState().chats.find((c: any) => c.id === 'c1')?.config
          .mcpServers?.mcp_demo_pw?.on === true
    )
    // a config chega ao "main" (mock) depois do debounce
    await page.waitForTimeout(700)
    const saved = await page.evaluate(async () => {
      const c = await (window as any).__clearMockApi.chats.get('c1')
      return c.config.mcpServers
    })
    assert.deepEqual(saved, { mcp_demo_pw: { on: true } })
    // stdio não ativado → esmaecido com o motivo
    const mine = sec.locator('[data-testid="mcp-choice"][data-server="meus-arquivos"]')
    assert.equal(await mine.getByTestId('mcp-reason').innerText(), 'não ativado aqui')
    const info = await infoText(
      sec.getByRole('button', { name: 'O que é enviado para a API' }).first()
    )
    assert.match(info, /mcp__playwright__browser_navigate/)
    assert.match(info, /mcp__playwright__browser_take_screenshot/)
    assert.match(info, /Instruções dos servidores: nenhuma ligada/)
    await closeTips()
    await expand(sec, 'mcp-details')
    const list = sec.locator('[data-testid="mcp-details-server"][data-server="playwright"]')
    await list.getByRole('switch', { name: 'Tool browser_click (Navegador (Playwright))' }).click()
    await page.waitForFunction(
      () =>
        (window as any).__clearStore
          .getState()
          .chats.find((c: any) => c.id === 'c1')
          ?.config.mcpServers?.mcp_demo_pw?.off?.includes('browser_click') === true
    )
    // instruções do servidor: desligadas por padrão, (</>) com o bloco exato
    const instr = list.getByRole('switch', { name: 'Instruções do servidor' })
    assert.equal(await instr.getAttribute('aria-checked'), 'false')
    const block = await infoText(
      list.getByRole('button', { name: 'O que é enviado para a API' }).first()
    )
    assert.match(block, /<mcp_server_instructions server="playwright">/)
    assert.match(block, /Use browser_snapshot antes de clicar/)
    await closeTips()
    await instr.click()
    await page.waitForFunction(
      () =>
        (window as any).__clearStore.getState().chats.find((c: any) => c.id === 'c1')?.config
          .mcpServers?.mcp_demo_pw?.instructions === true
    )
    const after = await infoText(
      sec.getByRole('button', { name: 'O que é enviado para a API' }).first()
    )
    assert.doesNotMatch(after, /mcp__playwright__browser_click/)
    assert.match(after, /<mcp_server_instructions server="playwright">/)
    await closeTips()
    await page.waitForTimeout(200)
    await sec.scrollIntoViewIfNeeded()
    await shot('07-painel-conectores')
    const cfg = await chatConfig('c1')
    assert.deepEqual(cfg.mcpServers.mcp_demo_pw, {
      on: true,
      off: ['browser_click'],
      instructions: true
    })
    // fechada: o resumo diz o que difere
    await sec.getByTestId('collapse-mcp').click()
    assert.equal(await sec.getByTestId('collapse-summary').innerText(), '1 ligado')
  })

  await step('cards: tools mcp__… com "Conector … · tool", args, erro e pendente', async () => {
    await openChat('Preços com o navegador')
    const cards = page.getByTestId('chat-scroller').getByTestId('mcp-tool-card')
    await cards.first().waitFor()
    assert.equal(await cards.count(), 3)
    const first = cards.nth(0)
    const head = await first.innerText()
    assert.match(head, /Conector Navegador \(Playwright\)/)
    assert.match(head, /browser_navigate/)
    assert.match(await cards.nth(1).getByTestId('mcp-card-error').innerText(), /Ref e12 not found/)
    assert.match(await cards.nth(2).innerText(), /Captura de tela/)
    await cards.nth(2).getByTestId('mcp-card-pending').waitFor()
    assert.match(await cards.nth(2).innerText(), /aguardando sua resposta/)
    // expandido: argumentos formatados (JSON com indentação) e o resultado
    await first.getByRole('button').first().click()
    const txt = await first.innerText()
    assert.match(txt, /"url": "https:\/\/exemplo\.com\/precos"/)
    assert.match(txt, /Título: Preços — Exemplo/)
    // registro da aprovação: "Conector"
    await first.getByTestId('approval-badge').hover()
    await page.getByTestId('approval-item-mcp').waitFor()
    assert.match(await page.getByTestId('approval-details').innerText(), /Aprovado por você/)
    await shot('08-cards-mcp')
    await closeTips()
  })

  await step('aprovação de tool de conector: conector · tool, declarado, args', async () => {
    await openChat('Intranet: relatório semanal')
    const card = page.locator('[data-testid="approval-card"][data-item="mcp"]')
    await card.waitFor()
    assert.match(
      await card.getByTestId('mcp-approval-title').innerText(),
      /Conector Navegador \(Playwright\) · browser_navigate/
    )
    assert.match(await card.innerText(), /Conector · Perguntar/)
    assert.match(
      await card.getByTestId('mcp-approval-declared').innerText(),
      /declarado pelo servidor/
    )
    assert.match(
      await card.getByTestId('mcp-approval-declared').innerText(),
      /Abre uma URL na aba atual\./
    )
    assert.match(
      await card.getByTestId('mcp-approval-args').innerText(),
      /\{\n {2}"url": "https:\/\/intranet\.exemplo\.com\/relatorios"\n\}/
    )
    await shot('09-aprovacao-mcp')
    await card.getByRole('button', { name: 'Permitir' }).click()
    await card.waitFor({ state: 'detached' })
  })

  await step('formulário do conector (elicitação): erros por campo, enviar valores', async () => {
    await openChat('Preços com o navegador')
    const form = page.getByTestId('mcp-elicit-form')
    await form.waitFor()
    assert.equal(
      await form.getByTestId('mcp-elicit-message').innerText(),
      'Como salvar a captura de tela?'
    )
    const kinds = await form
      .getByTestId('mcp-elicit-field')
      .evaluateAll((els) =>
        els.map((e) => `${e.getAttribute('data-field')}:${e.getAttribute('data-kind')}`)
      )
    assert.deepEqual(kinds, [
      'filename:text',
      'format:select',
      'width:integer',
      'fullPage:boolean',
      'notify:text',
      'tags:multiselect'
    ])
    await shot('10-elicitacao')
    const errOf = (k: string): ReturnType<Page['locator']> =>
      form.locator(`[data-testid="mcp-elicit-error"][data-field="${k}"]`)
    await form.getByTestId('mcp-elicit-submit').click()
    assert.equal(await errOf('filename').innerText(), 'Obrigatório.')
    assert.equal(await errOf('width').innerText(), 'Obrigatório.')
    const field = (k: string): ReturnType<Page['locator']> =>
      form.locator(`[data-testid="mcp-elicit-field"][data-field="${k}"]`)
    await field('filename').locator('input').fill('ab')
    await field('width').locator('input').fill('5000')
    await field('notify').locator('input').fill('nao-e-email')
    await form.getByTestId('mcp-elicit-submit').click()
    assert.equal(await errOf('filename').innerText(), 'Pelo menos 3 caracteres.')
    assert.equal(await errOf('width').innerText(), 'Máximo 3840.')
    await shot('11-elicitacao-erros')
    await field('filename').locator('input').fill('precos-exemplo')
    await field('width').locator('input').fill('1280')
    await field('notify').locator('input').fill('')
    await field('format').getByRole('radio', { name: 'JPEG' }).click()
    await field('tags').getByRole('checkbox', { name: 'preços' }).click()
    assert.equal(
      await field('fullPage').getByRole('switch').getAttribute('aria-checked'),
      'true',
      'default do esquema'
    )
    await form.getByTestId('mcp-elicit-submit').click()
    await form.waitFor({ state: 'detached' })
    const sent = await page.evaluate(() => (window as any).__mockMcpAnswer)
    assert.deepEqual(sent, {
      action: 'accept',
      content: {
        filename: 'precos-exemplo',
        format: 'jpeg',
        width: 1280,
        fullPage: true,
        tags: ['preços']
      }
    })
    await page
      .getByTestId('chat-scroller')
      .getByTestId('mcp-tool-card')
      .nth(2)
      .locator('[data-status="ok"]')
      .waitFor()
    // o campo de mensagem voltou
    await page.getByTestId('composer-card').locator('textarea').first().waitFor()
  })

  await step('formulário sem chat: aviso flutuante → Recusar', async () => {
    await page.evaluate(() =>
      (window as any).__clearMockEmit({
        type: 'mcp-elicit',
        request: {
          id: 'el-global',
          chatId: null,
          sessionId: null,
          toolCallId: null,
          serverId: 'mcp_demo_notion',
          serverLabel: 'Notion',
          form: {
            message: 'Qual espaço de trabalho usar?',
            fields: [
              {
                key: 'workspace',
                title: 'Espaço',
                kind: 'select',
                required: true,
                options: [
                  { value: 'pessoal', label: 'Pessoal' },
                  { value: 'empresa', label: 'Empresa' }
                ]
              }
            ]
          },
          createdAt: Date.now()
        }
      })
    )
    const dock = page.getByTestId('mcp-elicit-dock')
    await dock.waitFor()
    assert.match(await dock.innerText(), /Conector Notion pede dados/)
    await shot('12-elicitacao-sem-chat')
    await dock.getByTestId('mcp-elicit-decline').click()
    await dock.waitFor({ state: 'detached' })
  })

  await step('editor de persona: a mesma seção Conectores (sem herança)', async () => {
    await page.getByRole('button', { name: /^Configurações/ }).click()
    await settings().getByRole('button', { name: 'Personas', exact: true }).click()
    await settings()
      .getByRole('button', { name: /Editar/ })
      .first()
      .click()
    await settings().getByRole('tab', { name: 'Tools' }).click()
    await expand(settings(), 'mcp')
    await settings().getByTestId('preset-mcp').waitFor()
    assert.equal(
      await settings()
        .getByTestId('preset-mcp')
        .getByRole('switch', { name: 'Conector Navegador (Playwright)' })
        .getAttribute('aria-checked'),
      'false'
    )
    await closeSettings()
  })

  await app.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} ok · screenshots em ${SHOTS}`)
  if (failed.length) process.exit(1)
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
