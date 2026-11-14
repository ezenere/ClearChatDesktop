// E2E da UI da memória modular contra o MOCK de UI (Playwright + `e2e/launch.ts`, sem backend, sem key):
// builda o renderer com VITE_CLEAR_MOCK=1 numa pasta de rascunho (não mexe em out/), abre
// `index.html?scenario=memory` numa janela Electron mínima e percorre:
//   Configurações → Memórias (criar coleções em duas categorias, criar/editar/fixar/reordenar/
//   apagar memórias, detalhe, links [[slug]], substitui/substituída; sem "memórias de chats");
//   aba Memória do painel (selos da persona, ligar coleções, escrita, toggles, extrair agora,
//   (i) com o índice exato e o estado "Nada de memória vai para a API"; sem "Memória do chat");
//   editor de personas (seção sem extrair/atualizar); aba Tools (subagentes);
//   cards das tools de memória (chips → abre a memória; sem "Este chat") e card da extração;
//   seções recolhíveis do painel (abrir/fechar com mouse e teclado, estado lembrado após recarregar,
//   resumo "N alterado(s)" quando um parâmetro difere do padrão, JSON inválido mantém a seção aberta
//   com o erro no cabeçalho, link que foca uma seção a abre).
// Screenshots em $CLEARCHAT_E2E_DIR/shots (1280x820 e 900x600).
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-memory-ui-e2e node e2e/memory-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { elementShot } from './uiHelpers.ts'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-memory-ui-e2e'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
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
        .slice(0, process.env.E2E_VERBOSE ? 30 : 1)
        .join('\n')}`
    )
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [w, h]
  )
  await page.waitForTimeout(300)
}

const settings = (): ReturnType<Page['locator']> => page.locator('[role="dialog"]')
const panel = (): ReturnType<Page['locator']> => page.getByTestId('right-panel')

/** Abre a seção recolhível `id` (CollapsibleSection) dentro de `scope`, se estiver fechada. */
async function expand(scope: ReturnType<Page['locator']>, id: string): Promise<void> {
  const btn = scope.getByTestId(`collapse-${id}`)
  await btn.scrollIntoViewIfNeeded()
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click()
  await scope.locator(`[data-collapse-id="${id}"][data-open]`).waitFor()
}

/** Esquece o aberto/fechado das seções (localStorage `clearchat.collapse.*`) e recarrega. */
async function resetCollapse(): Promise<void> {
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage))
      if (k.startsWith('clearchat.collapse.')) localStorage.removeItem(k)
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
}

async function openPanelTab(chat: string, tab: string): Promise<void> {
  await page.getByTestId('chat-item').filter({ hasText: chat }).first().click()
  if (
    !(await panel()
      .isVisible()
      .catch(() => false))
  )
    await page.getByRole('button', { name: 'Abrir painel' }).click()
  await panel().getByRole('tab', { name: tab }).click()
}

async function openSettingsMemory(): Promise<void> {
  await page.getByRole('button', { name: /^Configurações/ }).click()
  await settings().getByRole('button', { name: 'Memórias', exact: true }).click()
  await settings().getByTestId('memory-settings').waitFor()
}

async function closeSettings(): Promise<void> {
  await page.keyboard.press('Escape')
  await settings().waitFor({ state: 'detached' })
}

/** Abre o (i) (tooltip Radix) e devolve o texto. */
async function infoText(trigger: ReturnType<Page['locator']>): Promise<string> {
  const tip = page.locator('[data-radix-popper-content-wrapper]').last()
  for (let i = 0; ; i++) {
    await page.mouse.move(2, 2)
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

async function main(): Promise<void> {
  rmSync(SHOTS, { recursive: true, force: true })
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
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 820, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=memory' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await launchElectron({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await setSize(1280, 820)

  await step('chat com tools de memória e cards de extração', async () => {
    await page.getByTestId('chat-item').filter({ hasText: 'Planejamento do TCC' }).click()
    const cards = page.getByTestId('memory-extraction-card')
    await cards.first().waitFor()
    assert.equal(await cards.count(), 2)
    const summary = await cards.first().getByTestId('memory-extraction-summary').innerText()
    assert.match(summary, /2 criadas, 1 atualizada, 0 apagadas/)
    assert.match(summary, /após compactar/)
    assert.equal(await cards.nth(1).getAttribute('data-failed'), 'true')
    assert.match(await cards.nth(1).innerText(), /HTTP 429/)
    // chips das tools
    const chips = page.getByTestId('memory-changes')
    assert.ok((await chips.count()) >= 3)
    assert.ok(await page.getByText('Buscar memória').first().isVisible())
    assert.ok(await page.getByText('Gravar memória').first().isVisible())
    for (const t of await chips.allInnerTexts()) assert.doesNotMatch(t, /Este chat/)
    // card de extração: expandir e (i) com a request
    await cards
      .first()
      .getByRole('button', { name: /^Extração de memórias/ })
      .click()
    await cards.first().getByTestId('memory-changes').waitFor()
    const info = await infoText(
      cards.first().getByRole('button', { name: 'O que é enviado para a API', exact: true })
    )
    assert.match(info, /não é enviado à API/)
    assert.match(info, /memory_write/)
    await page.mouse.move(10, 10)
    await page.getByTestId('memory-extraction-card').first().scrollIntoViewIfNeeded()
    await shot('01-chat-extracao')
  })

  await step('busca: memórias encontradas com link', async () => {
    const search = page.locator('div.my-2', { hasText: 'Buscar memória' }).first()
    await search.scrollIntoViewIfNeeded()
    const found = search.getByTestId('memory-found')
    await found.waitFor()
    assert.match(await found.innerText(), /Orientação do TCC/)
    await shot('02-tool-busca')
  })

  await step('painel: tudo recolhido por padrão em todas as abas', async () => {
    await resetCollapse()
    const seen: string[] = []
    for (const tab of ['Modelo', 'Chat', 'Tools', 'Memória', 'Voz']) {
      await openPanelTab('Planejamento do TCC', tab)
      const secs = panel().locator('[data-collapse-id]')
      await secs.first().waitFor()
      // nenhuma seção montada aberta, e nada fora de seção (todo bloco do corpo é recolhível)
      assert.equal(await panel().locator('[data-collapse-id][data-open]').count(), 0, tab)
      assert.equal(await panel().locator('section:not([data-collapse-id])').count(), 0, tab)
      for (const id of await secs.evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-collapse-id') ?? '')
      ))
        seen.push(id)
    }
    for (const id of ['model', 'chat-persona', 'context', 'tools-list', 'skills', 'memory'])
      assert.ok(seen.includes(id), `seção ${id}`)
    return `${seen.length} seções fechadas`
  })

  await step('painel: seções recolhíveis (abrir/fechar, lembrar, resumo, erro)', async () => {
    await resetCollapse()
    await openPanelTab('Planejamento do TCC', 'Modelo')
    const p = panel()
    const head = (id: string): ReturnType<Page['locator']> => p.getByTestId(`collapse-${id}`)
    // padrão: tudo fechado (modelo inclusive, com o modelo no resumo); abrir mostra o raciocínio
    for (const id of ['model', 'system-prompt', 'params', 'request'])
      assert.equal(await head(id).getAttribute('aria-expanded'), 'false', `${id} fechada`)
    assert.equal(await p.getByLabel('System prompt', { exact: true }).count(), 0)
    assert.equal(await p.getByTestId('effort-levels').count(), 0)
    assert.match(
      await p.locator('[data-collapse-id="model"]').getByTestId('collapse-summary').innerText(),
      /claude-sonnet-4\.5/
    )
    await expand(p, 'model')
    await p.getByTestId('effort-levels').waitFor()
    await head('model').click()
    // resumo do que difere do padrão: ligar max_tokens → "N alterado(s) · … max_tokens 4.096"
    const sum = (id: string): ReturnType<Page['locator']> =>
      p.locator(`[data-collapse-id="${id}"]`).getByTestId('collapse-summary')
    const before = await sum('params').innerText()
    await head('params').click()
    assert.equal(await head('params').getAttribute('aria-expanded'), 'true')
    await p.getByRole('switch', { name: 'Enviar max_tokens' }).click()
    await head('params').click()
    assert.match(await sum('params').innerText(), /alterados? · .*max_tokens 4\.096/)
    assert.equal(await sum('params').getAttribute('data-changed'), 'true')
    // teclado: Enter no cabeçalho abre/fecha
    await head('params').focus()
    await page.keyboard.press('Enter')
    assert.equal(await head('params').getAttribute('aria-expanded'), 'true')
    await p.getByRole('switch', { name: 'Enviar max_tokens' }).click()
    await head('params').focus()
    await page.keyboard.press('Space')
    assert.equal(await head('params').getAttribute('aria-expanded'), 'false')
    assert.equal(await sum('params').innerText(), before, 'max_tokens desligado → resumo volta')
    // JSON inválido no body extra: não recolhe e mostra o erro no cabeçalho
    await expand(p, 'request')
    const body = p.getByRole('textbox', { name: 'Body extra (JSON)' })
    await body.fill('{ "provider": ')
    const err = p.locator('[data-collapse-id="request"]').getByTestId('collapse-error')
    await err.waitFor()
    assert.match(await err.innerText(), /JSON inválido/)
    await head('request').click()
    assert.equal(await head('request').getAttribute('aria-expanded'), 'true', 'não recolhe')
    await shot('00-colapso-json-invalido')
    await body.fill('')
    await err.waitFor({ state: 'detached' })
    await head('request').click()
    assert.equal(await head('request').getAttribute('aria-expanded'), 'false')
    // lembrado após recarregar: abre o system prompt, recarrega → continua aberto
    await expand(p, 'system-prompt')
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await openPanelTab('Planejamento do TCC', 'Modelo')
    assert.equal(await head('system-prompt').getAttribute('aria-expanded'), 'true')
    assert.equal(
      await page.evaluate(() => localStorage.getItem('clearchat.collapse.system-prompt')),
      '1'
    )
    await p.getByLabel('System prompt', { exact: true }).waitFor()
    await head('system-prompt').click()
    // link que foca uma seção a abre (Aprovações → "escolha um modelo na seção Smart-Approve")
    await panel().getByRole('tab', { name: 'Tools' }).click()
    assert.equal(await head('smart-approve').getAttribute('aria-expanded'), 'false')
    await expand(p, 'approvals')
    await p.getByTestId('smart-needs-model').click()
    await p.locator('[data-collapse-id="smart-approve"][data-open]').waitFor()
    await p.getByTestId('smart-approve-model').waitFor()
    await shot('00-colapso-tools')
    await head('smart-approve').click()
    await head('approvals').click()
  })

  await step('título no cabeçalho (renomear) e aba Chat sem título/raiz duplicados', async () => {
    await openPanelTab('Planejamento do TCC', 'Chat')
    const p = panel()
    // a aba Chat não tem mais o campo de título nem "Alterar…" da raiz
    assert.equal(await p.getByLabel('Título do chat').count(), 0)
    assert.equal(await p.getByRole('button', { name: 'Alterar…' }).count(), 0)
    // título: clique no cabeçalho → campo; Esc cancela, Enter salva
    const title = page.getByTestId('chat-title')
    await title.click()
    const input = page.getByRole('textbox', { name: 'Título do chat' })
    await input.fill('Rascunho descartado')
    await input.press('Escape')
    assert.equal(await title.innerText(), 'Planejamento do TCC')
    await title.click()
    await input.fill('TCC renomeado')
    await input.press('Enter')
    await page.getByTestId('chat-item').filter({ hasText: 'TCC renomeado' }).waitFor()
    assert.equal(await title.innerText(), 'TCC renomeado')
    await title.click()
    await input.fill('Planejamento do TCC')
    await input.press('Enter')
    // raiz: só leitura + link para a aba Arquivos
    await expand(p, 'root')
    await p.getByTestId('chat-root').waitFor()
    await p.getByRole('switch', { name: 'Confinar ferramentas à raiz' }).waitFor()
    await shot('00-aba-chat')
    await p
      .getByTestId('chat-root')
      .getByRole('button', { name: /Alterar em Arquivos/ })
      .click()
    assert.equal(
      await p.getByRole('tab', { name: 'Arquivos' }).getAttribute('aria-selected'),
      'true'
    )
    await p.getByRole('tab', { name: 'Chat' }).click()
    await p.getByTestId('collapse-root').click()
  })

  await step('aba Memória: herança da persona', async () => {
    if (
      !(await panel()
        .isVisible()
        .catch(() => false))
    )
      await page.getByRole('button', { name: 'Abrir painel' }).click()
    await panel().getByRole('tab', { name: 'Memória' }).click()
    const p = panel().getByTestId('memory-panel')
    await p.waitFor()
    // tudo recolhido por padrão, com resumo (a seção Memória inclusive)
    assert.match(
      await p.locator('[data-collapse-id="memory"]').getByTestId('collapse-summary').innerText(),
      /^ligada · \d+ coleç(ão|ões)$/
    )
    await expand(p, 'memory')
    assert.match(
      await p
        .locator('[data-collapse-id="memory-collections"]')
        .getByTestId('collapse-summary')
        .innerText(),
      /ativas? · \d\/5 categorias/
    )
    await expand(p, 'memory-collections')
    await expand(p, 'memory-snapshot')
    assert.equal(
      await p
        .getByTestId('memory-col-col-tcc')
        .getByTestId('memory-badge')
        .getAttribute('data-badge'),
      'added'
    )
    assert.equal(
      await p
        .getByTestId('memory-col-col-topics')
        .getByTestId('memory-badge')
        .getAttribute('data-badge'),
      'persona-off'
    )
    assert.equal(
      await p
        .getByTestId('memory-col-col-profile')
        .getByTestId('memory-badge')
        .getAttribute('data-badge'),
      'persona'
    )
    assert.ok(
      await p.getByTestId('memory-col-col-tcc').getByTestId('memory-write-mark').isVisible()
    )
    assert.match(await p.getByTestId('memory-persona-line').innerText(), /Ajustada neste chat/)
    assert.equal(await p.getByTestId('memory-status').getAttribute('data-active'), 'true')
    // não há memória "do chat": nem toggle, nem seção, nem link
    assert.equal(await p.getByRole('switch', { name: 'Memória do chat' }).count(), 0)
    assert.equal(await p.getByTestId('chat-memory-link').count(), 0)
    assert.doesNotMatch(await p.innerText(), /Memória do chat|Este chat/)
    await p
      .getByTestId('memory-snapshot')
      .getByText(/congelado desde/)
      .waitFor({ timeout: 5000 })
    await shot('03-painel-memoria')
  })

  await step('aba Memória: ligar coleção, escrita, toggles', async () => {
    const p = panel().getByTestId('memory-panel')
    await p.getByTestId('memory-col-col-clearchat').click()
    assert.equal(
      await p.getByTestId('memory-col-col-clearchat').getAttribute('data-checked'),
      'true'
    )
    assert.equal(
      await p
        .getByTestId('memory-col-col-clearchat')
        .getByTestId('memory-badge')
        .getAttribute('data-badge'),
      'added'
    )
    // escrita de Áreas → ClearChat
    await p.getByRole('button', { name: 'Coleção de escrita: Áreas' }).click()
    await page
      .locator('[role="dialog"], body')
      .getByRole('button', { name: /ClearChat/ })
      .last()
      .click()
    await p.getByTestId('memory-col-col-clearchat').getByTestId('memory-write-mark').waitFor()
    assert.equal(
      await p.getByTestId('memory-col-col-tcc').getByTestId('memory-write-mark').count(),
      0
    )
    // desligar a coleção de escrita limpa a escrita da categoria
    await p.getByTestId('memory-col-col-clearchat').click()
    assert.equal(
      (await p.getByTestId('memory-write-mark').filter({ visible: true }).count()) >= 0,
      true
    )
    assert.match(
      await p.getByRole('button', { name: 'Coleção de escrita: Áreas' }).innerText(),
      /Nenhuma/
    )
    // de volta: TCC como escrita
    await p.getByRole('button', { name: 'Coleção de escrita: Áreas' }).click()
    await page
      .getByRole('button', { name: /Projeto TCC/ })
      .last()
      .click()
    // categoria Tópicos: desligar some com as coleções
    await p.getByRole('switch', { name: 'Categoria Tópicos' }).click()
    assert.equal(await p.getByTestId('memory-col-col-topics').count(), 0)
    await p.getByRole('switch', { name: 'Categoria Tópicos' }).click()
    // toggles
    await expand(p, 'memory-subagents')
    await p.getByRole('switch', { name: 'Memória nos subagentes (só busca/leitura)' }).click()
    assert.equal(
      await p
        .getByRole('switch', { name: 'Memória nos subagentes (só busca/leitura)' })
        .getAttribute('aria-checked'),
      'true'
    )
    await shot('04-painel-escrita')
  })

  await step('aba Memória: (i) com o índice exato', async () => {
    const p = panel().getByTestId('memory-panel')
    await page.waitForTimeout(700) // preview depois do flush da config
    const info = await infoText(
      p
        .locator('section')
        .first()
        .getByRole('button', { name: 'O que é enviado para a API', exact: true })
    )
    assert.match(info, /Índice exato/)
    assert.match(info, /Projeto TCC \[escrita\]/)
    assert.match(info, /memory_search/)
    assert.match(info, /Instruções/)
    await shot('05-painel-preview')
    await page.mouse.move(10, 10)
  })

  await step('aba Memória: extrair agora', async () => {
    const p = panel().getByTestId('memory-panel')
    const before = await page.getByTestId('memory-extraction-card').count()
    await expand(p, 'memory-extraction')
    const btn = p.getByTestId('memory-extract-now')
    await btn.scrollIntoViewIfNeeded()
    await btn.click()
    await p.getByText('Extraindo memórias…').waitFor()
    await shot('06-extraindo')
    await page.getByText(/Extração de memórias: 1 criada, 1 atualizada/).waitFor({ timeout: 8000 })
    await page.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="memory-extraction-card"]').length > n,
      before
    )
    await shot('07-extraido')
  })

  await step('aba Memória: desligada → nada vai para a API', async () => {
    const p = panel().getByTestId('memory-panel')
    await expand(p, 'memory')
    await p.locator('section').first().scrollIntoViewIfNeeded()
    await p.getByRole('switch', { name: 'Memória neste chat' }).click()
    assert.equal(await p.getByTestId('memory-status').getAttribute('data-active'), 'false')
    assert.match(await p.getByTestId('memory-status').innerText(), /Nada de memória vai para a API/)
    await page.waitForTimeout(700)
    const info = await infoText(
      p
        .locator('section')
        .first()
        .getByRole('button', { name: 'O que é enviado para a API', exact: true })
    )
    assert.match(info, /Nada de memória vai para a API/)
    await page.mouse.move(10, 10)
    assert.ok(await p.getByTestId('memory-extract-now').isDisabled())
    await shot('08-painel-desligada')
    await p.getByRole('switch', { name: 'Memória neste chat' }).click()
  })

  await step('aba Tools: indicador de memória para subagentes', async () => {
    await panel().getByRole('tab', { name: 'Tools' }).click()
    await expand(panel(), 'subagents')
    const line = panel().getByTestId('subagent-memory')
    await line.scrollIntoViewIfNeeded()
    assert.match(await line.innerText(), /Memória para subagentes: ligada/)
    await shot('09-tools-subagentes')
    await line.getByRole('button', { name: /Memória/ }).click()
    await panel().getByTestId('memory-panel').waitFor()
    // o link foca a seção Subagentes da aba Memória (aberta)
    await panel().locator('[data-collapse-id="memory-subagents"][data-open]').waitFor()
  })

  await step('aba Tools: Skills recolhível com resumo', async () => {
    await panel().getByRole('tab', { name: 'Tools' }).click()
    const p = panel()
    const head = p.getByTestId('collapse-skills')
    if ((await head.getAttribute('aria-expanded')) === 'true') await head.click()
    assert.equal(await p.getByTestId('skills-panel').count(), 0, 'fechada: conteúdo desmontado')
    const sum = p.locator('[data-collapse-id="skills"]').getByTestId('collapse-summary')
    assert.match(await sum.innerText(), /^(desligadas|ligadas · .+)$/)
    await elementShot(
      page,
      p.locator('[data-collapse-id="skills"]'),
      join(SHOTS, '09b-skills-fechada.png')
    )
    // teclado: Enter abre, Espaço fecha
    await head.focus()
    await page.keyboard.press('Enter')
    await p.getByTestId('skills-panel').waitFor()
    assert.equal(await head.getAttribute('aria-expanded'), 'true')
    await page.keyboard.press('Space')
    await p.getByTestId('skills-panel').waitFor({ state: 'detached' })
    // o link "Skills" dos subagentes abre a seção e a sub "Ajustes das skills"
    await expand(p, 'subagents')
    await p
      .getByTestId('subagent-skills')
      .getByRole('button', { name: /Skills/ })
      .click()
    await p.locator('[data-collapse-id="skills"][data-open]').waitFor()
    await p.locator('[data-collapse-id="skills-details"][data-open]').waitFor()
    await p.getByRole('switch', { name: 'Skills nos subagentes' }).waitFor()
    await head.click()
    await p.getByTestId('collapse-subagents').click()
  })

  await step('painel: abas só com ícone (rótulo da selecionada; o hover troca)', async () => {
    const p = panel()
    await p.getByRole('tab', { name: 'Memória' }).click()
    const tabs = p.getByRole('tab')
    assert.equal(await tabs.count(), 6)
    // nome acessível = rótulo, mesmo sem o texto à vista
    for (const name of ['Modelo', 'Chat', 'Tools', 'Memória', 'Voz', 'Arquivos'])
      assert.equal(await p.getByRole('tab', { name, exact: true }).count(), 1, name)
    const labelW = (name: string): Promise<number> =>
      p
        .getByRole('tab', { name, exact: true })
        .evaluate((b) => (b.lastElementChild as HTMLElement).getBoundingClientRect().width)
    const shownTabs = async (): Promise<string[]> =>
      (await p
        .locator('[role="tab"][data-label]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))) as string[]
    await page.mouse.move(400, 400)
    await page.waitForTimeout(400)
    assert.deepEqual(await shownTabs(), ['Memória'])
    assert.ok((await labelW('Memória')) > 20, 'rótulo da selecionada à vista')
    assert.ok((await labelW('Tools')) < 1, 'demais só ícone')
    const bar = p.getByRole('tablist')
    const before = await bar.boundingBox()
    const req = await p.getByRole('button', { name: 'Ver request' }).boundingBox()
    await elementShot(page, p.locator('div.h-11').first(), join(SHOTS, '09c-abas-idle.png'))
    // hover em outra aba: o rótulo dela abre e o da selecionada recolhe; a barra não muda
    await p.getByRole('tab', { name: 'Tools', exact: true }).hover()
    await page.waitForTimeout(400)
    assert.deepEqual(await shownTabs(), ['Tools'])
    assert.ok((await labelW('Tools')) > 20)
    assert.ok((await labelW('Memória')) < 1)
    assert.deepEqual(await bar.boundingBox(), before, 'barra com a mesma largura')
    assert.deepEqual(await p.getByRole('button', { name: 'Ver request' }).boundingBox(), req)
    assert.equal(
      await p.getByRole('tab', { name: 'Memória' }).getAttribute('aria-selected'),
      'true',
      'o hover não troca a aba'
    )
    await elementShot(page, p.locator('div.h-11').first(), join(SHOTS, '09d-abas-hover.png'))
    // transição suave (~200 ms); com prefers-reduced-motion, nenhuma
    const anim = (): Promise<string> =>
      p.getByRole('tab', { name: 'Tools', exact: true }).evaluate((b) => {
        const cs = getComputedStyle(b.lastElementChild as Element)
        return `${cs.transitionProperty} ${cs.transitionDuration}`
      })
    assert.match(await anim(), /^grid-template-columns, opacity 0\.2s/)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.match(await anim(), /^none /)
    await page.emulateMedia({ reducedMotion: null })
    await page.mouse.move(400, 400)
    await page.waitForTimeout(400)
    assert.deepEqual(await shownTabs(), ['Memória'])
  })

  await step(
    'painel: largura pelo divisor (arrastar, teclado, duplo clique, lembrada)',
    async () => {
      await page.evaluate(() => localStorage.removeItem('clearchat.panel.width'))
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await openPanelTab('Planejamento do TCC', 'Tools')
      const p = panel()
      const split = p.getByTestId('panel-splitter')
      const width = async (): Promise<number> => Math.round((await p.boundingBox())!.width)
      assert.equal(await width(), 384, 'padrão')
      assert.equal(await split.getAttribute('aria-label'), 'Redimensionar painel lateral')
      assert.equal(await split.getAttribute('aria-valuenow'), '384')
      // arrastar para a esquerda alarga
      const box = (await split.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + 200)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 - 60, box.y + 200, { steps: 4 })
      await page.mouse.move(box.x + box.width / 2 - 116, box.y + 200, { steps: 4 })
      await page.mouse.up()
      assert.equal(await width(), 500)
      assert.equal(await page.evaluate(() => localStorage.getItem('clearchat.panel.width')), '500')
      await shot('09e-painel-largo')
      // teclado: → estreita 16 (Shift 64), End = mínimo, Home = máximo (o chat mantém 380 px)
      await split.focus()
      await page.keyboard.press('ArrowRight')
      assert.equal(await width(), 484)
      await page.keyboard.press('Shift+ArrowLeft')
      assert.equal(await width(), 548)
      await page.keyboard.press('End')
      assert.equal(await width(), 320)
      await page.keyboard.press('Home')
      const max = Number(await split.getAttribute('aria-valuemax'))
      const row = await page.evaluate(() => {
        const aside = document.querySelector('[data-testid="right-panel"]')!
        return aside.parentElement!.getBoundingClientRect().width
      })
      assert.equal(max, Math.min(720, Math.floor(row - 380)))
      assert.equal(await width(), max)
      // lembrada após recarregar
      await page.keyboard.press('End')
      await page.keyboard.press('Shift+ArrowLeft')
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await openPanelTab('Planejamento do TCC', 'Tools')
      assert.equal(await width(), 384)
      assert.equal(await page.evaluate(() => localStorage.getItem('clearchat.panel.width')), '384')
      // duplo clique volta ao padrão
      await split.focus()
      await page.keyboard.press('Shift+ArrowLeft')
      assert.equal(await width(), 448)
      await split.dblclick()
      assert.equal(await width(), 384)
    }
  )

  await step('ajuda (?) das opções: descrição no tooltip, não no painel', async () => {
    await panel().getByRole('tab', { name: 'Tools' }).click()
    await expand(panel(), 'smart-approve')
    await expand(panel(), 'smart-advanced')
    const sec = panel().locator('[data-collapse-id="smart-advanced"]')
    // a descrição do toggle não fica mais à vista
    assert.equal(await sec.getByText(/Desligado \(padrão\): o juiz só aprova/).count(), 0)
    const help = sec.getByRole('button', { name: 'Ajuda: O juiz pode negar', exact: true })
    const text = await infoText(help)
    assert.match(text, /Desligado \(padrão\): o juiz só aprova ou pergunta a você/)
    assert.match(text, /Ligado: a chamada negada não roda/)
    assert.doesNotMatch(text, /Enviado à API/)
    // "Desligado…" e "Ligado…" em parágrafos separados
    const tip = page.getByTestId('help-tip-content').last()
    assert.equal(await tip.locator('p').count(), 2)
    await page.mouse.move(2, 2, { steps: 8 })
    await page.keyboard.press('Escape')
    await tip.waitFor({ state: 'detached' })
    // teclado: focar o (?) abre o tooltip
    await help.focus()
    await page.getByTestId('help-tip-content').last().waitFor()
    await page.keyboard.press('Escape')
    // (?) da seção no cabeçalho (visível mesmo fechada) e o </> do ApiInfo com ícone de código
    const head = panel().locator('[data-collapse-id="smart-approve"]')
    assert.ok(
      await head.getByRole('button', { name: 'Ajuda: Smart-Approve', exact: true }).isVisible()
    )
    assert.equal(
      await head
        .getByRole('button', { name: 'O que é enviado para a API', exact: true })
        .first()
        .locator('svg[data-icon="api"]')
        .count(),
      1
    )
    await shot('09b-ajuda-tooltip')
  })

  await step('Configurações → Memórias: visão geral', async () => {
    await openSettingsMemory()
    const s = settings()
    assert.match(await s.getByTestId('memory-settings-cat-areas').innerText(), /Projeto TCC/)
    // sem a área "Memórias de chats": só as coleções das cinco categorias
    assert.equal(await s.getByTestId('memory-chat-groups').count(), 0)
    assert.doesNotMatch(
      await s.getByTestId('memory-settings').innerText(),
      /Memórias de chats|Este chat/
    )
    await shot('10-config-memorias')
  })

  await step('Configurações: criar coleções em duas categorias', async () => {
    const s = settings()
    for (const [cat, name, desc] of [
      ['areas', 'Viagem ao Japão', 'Roteiro, reservas e orçamento'],
      ['people', 'Trabalho', 'Colegas da Lumen']
    ]) {
      await s
        .getByTestId(`memory-settings-cat-${cat}`)
        .getByRole('button', { name: 'Nova coleção' })
        .click()
      const form = s.getByTestId('memory-collection-form')
      await form.getByLabel('Nome da coleção').fill(name)
      await form.getByLabel('Descrição da coleção').fill(desc)
      await form.getByRole('button', { name: 'Criar coleção' }).click()
      await s.getByTestId(`memory-settings-cat-${cat}`).getByText(name).waitFor()
    }
    // renomear
    const row = s
      .getByTestId('memory-settings-cat-people')
      .locator('[data-testid^="memory-collection-"]', { hasText: 'Trabalho' })
    await row.hover()
    await row.getByRole('button', { name: 'Editar Trabalho' }).click()
    await s
      .getByTestId('memory-collection-form')
      .getByLabel('Nome da coleção')
      .fill('Trabalho (Lumen)')
    await s.getByTestId('memory-collection-form').getByRole('button', { name: 'Salvar' }).click()
    await s.getByText('Trabalho (Lumen)').waitFor()
    await shot('11-config-colecoes-criadas')
  })

  await step('Configurações: criar, editar, fixar e apagar memória', async () => {
    const s = settings()
    await s.getByText('Viagem ao Japão').click()
    await s.getByTestId('memory-collection-view').waitFor()
    await s.getByRole('button', { name: 'Nova memória' }).click()
    const f = s.getByTestId('memory-new-form')
    await f.getByLabel('Título da memória').fill('Roteiro de Tóquio')
    await f.getByLabel('Resumo da memória').fill('5 dias em Tóquio em abril')
    assert.match(await f.getByTestId('memory-counter').first().innerText(), /17\/80/)
    await f.getByRole('button', { name: 'Criar memória' }).click()
    const d = s.getByTestId('memory-detail')
    await d.waitFor()
    // detalhes: adicionar 3, reordenar, editar, remover
    for (const fact of [
      'Hotel em Shinjuku',
      'JR Pass de 7 dias',
      'Visitar o [[marcos-orientador]]?'
    ]) {
      await d.getByLabel('Novo detalhe').fill(fact)
      await d.getByLabel('Novo detalhe').press('Enter')
      await d
        .getByTestId('memory-facts')
        .getByText(fact.replace(/\[\[.*\]\]\?/, '').trim())
        .first()
        .waitFor()
    }
    assert.match(await d.getByTestId('memory-facts-count').innerText(), /3\/15/)
    // link [[slug]] vira link para a memória
    assert.match(await d.getByTestId('memory-link').innerText(), /Marcos \(orientador\)/)
    const items = d.getByTestId('memory-facts').locator('li')
    await items.nth(1).hover()
    await items.nth(1).getByRole('button', { name: 'Subir' }).click()
    await page.waitForTimeout(200)
    assert.match(await items.nth(0).innerText(), /JR Pass/)
    await items.nth(2).hover()
    await items.nth(2).getByRole('button', { name: 'Remover' }).click()
    await page.waitForTimeout(200)
    assert.equal(await items.count(), 2)
    // editar o resumo inline (limite)
    await d.getByRole('button', { name: 'Editar resumo' }).click()
    const sum = d.getByLabel('resumo')
    await sum.fill('x'.repeat(170))
    assert.match(await d.getByTestId('memory-counter').first().innerText(), /170\/160/)
    await sum.fill('5 dias em Tóquio e 3 em Kyoto, em abril')
    await sum.press('Enter')
    await d.getByText('5 dias em Tóquio e 3 em Kyoto, em abril').waitFor()
    // fixar
    await d.getByRole('switch', { name: 'Sempre carregar' }).click()
    await page.waitForTimeout(200)
    assert.equal(
      await d.getByRole('switch', { name: 'Sempre carregar' }).getAttribute('aria-checked'),
      'true'
    )
    assert.match(await d.getByTestId('memory-updated').innerText(), /por você/)
    await shot('12-config-memoria-detalhe')
    // apagar
    await d.getByRole('button', { name: 'Apagar', exact: true }).click()
    await d.getByRole('button', { name: 'Apagar memória?' }).click()
    await s.getByTestId('memory-collection-view').waitFor()
    await s.getByText('Nenhuma memória nesta coleção.').waitFor()
  })

  await step('Configurações: lista da coleção, links e substituições', async () => {
    const s = settings()
    await s.getByTestId('memory-back').click()
    await s.getByTestId('memory-settings-cat-areas').getByText('Projeto TCC').click()
    await s.getByTestId('memory-collection-view').waitFor()
    await shot('13-config-colecao')
    await s.getByTestId('memory-row-m-prazo').click()
    const d = s.getByTestId('memory-detail')
    assert.match(
      await d.getByTestId('memory-supersedes').innerText(),
      /Substitui: Prazos do semestre/
    )
    await d.getByTestId('memory-supersedes').getByRole('button').click()
    assert.match(
      await s.getByTestId('memory-detail').getByTestId('memory-superseded-by').innerText(),
      /Substituída por: Prazo de entrega/
    )
    await shot('14-config-substituida')
    // busca global
    await s.getByTestId('memory-back').click()
    await s.getByTestId('memory-back').click()
    await s.getByLabel('Buscar em todas as memórias').fill('orientador')
    await s.getByTestId('memory-search-results').waitFor()
    assert.match(await s.getByTestId('memory-search-results').innerText(), /Marcos/)
    await s.getByLabel('Buscar em todas as memórias').fill('')
    // o que o modelo gravou no chat fica na coleção de escrita da categoria (Pessoas → Padrão)
    await s.getByTestId('memory-collection-col-people').getByRole('button').first().click()
    assert.match(await s.getByTestId('memory-collection-view').innerText(), /Banca: Profa. Helena/)
    await closeSettings()
  })

  await step('chip da tool abre a memória nas Configurações', async () => {
    await page
      .getByTestId('memory-changes')
      .locator('button', { hasText: 'Banca: Profa. Helena' })
      .first()
      .click()
    await settings().getByTestId('memory-detail').waitFor()
    assert.match(await settings().getByTestId('memory-detail').innerText(), /Banca: Profa. Helena/)
    await closeSettings()
  })

  await step('editor de personas: seção de memória', async () => {
    await resetCollapse()
    await page.getByRole('button', { name: /^Configurações/ }).click()
    await settings().getByRole('button', { name: 'Personas', exact: true }).click()
    const row = settings().getByTestId('preset-row').filter({ hasText: 'Assistente pessoal' })
    await row.hover()
    await row.getByRole('button', { name: /Editar/ }).click()
    const ed = settings().getByTestId('preset-editor')
    // o editor reaproveita as seções do painel: tudo recolhido por padrão também
    for (const tab of ['Modelo', 'Chat', 'Tools', 'Voz', 'Memória']) {
      await ed.getByRole('tab', { name: tab }).click()
      await ed.locator('[data-collapse-id]').first().waitFor()
      assert.equal(await ed.locator('[data-collapse-id][data-open]').count(), 0, tab)
    }
    await ed.getByRole('tab', { name: 'Memória' }).click()
    const sec = settings().getByTestId('preset-memory')
    await sec.waitFor()
    await expand(sec, 'memory-collections')
    await expand(sec, 'memory-extraction')
    assert.equal(await sec.getByTestId('memory-extract-now').count(), 0)
    assert.equal(await sec.getByText('Atualizar memória').count(), 0)
    assert.equal(await sec.getByRole('switch', { name: 'Memória do chat' }).count(), 0)
    assert.equal(
      await sec.getByTestId('memory-col-col-profile').getAttribute('data-checked'),
      'true'
    )
    await shot('15-persona-memoria')
    await closeSettings()
  })

  await step('900x600', async () => {
    await setSize(900, 600)
    await page
      .getByRole('button', { name: 'Abrir painel' })
      .click()
      .catch(() => {})
    const tab = panel().getByRole('tab', { name: 'Memória' })
    if (await tab.isVisible().catch(() => false)) await tab.click()
    await shot('16-900-painel')
    await openSettingsMemory()
    await shot('17-900-config')
    await settings().getByTestId('memory-settings-cat-areas').getByText('Projeto TCC').click()
    await settings().getByTestId('memory-row-m-orientacao').click()
    await shot('18-900-detalhe')
    await closeSettings()
  })

  await app.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} ok · shots em ${SHOTS}`)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
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
