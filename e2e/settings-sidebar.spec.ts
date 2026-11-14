// E2E contra o MOCK de UI (Playwright `_electron`, sem backend/chave) da navegação de Configurações:
// barra lateral com grupos (Geral · Agente · Conexões) e itens ícone + rótulo (botões com o mesmo nome
// acessível das abas antigas, `aria-current="page"` no ativo), conteúdo com rolagem própria e título da
// aba, busca "Procurar" (filtra por rótulo e palavras-chave; Enter abre o melhor resultado; "Nenhuma
// configuração encontrada"; Esc limpa a busca e só o 2º Esc fecha o modal), ↑/↓ entre os itens,
// janela estreita (900 px) só com ícones + tooltip e a lupa abrindo a busca por cima do conteúdo,
// abrir numa aba vindo de fora (menu do microfone → "Configurações → Áudio…", "Gerenciar personas…")
// e nenhuma aba com rolagem horizontal em 1440/1000/900. Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-settings-sidebar node e2e/settings-sidebar.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-settings-sidebar'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''

const ORDER = [
  'Novos chats',
  'Personas',
  'Áudio',
  'Aprovações',
  'Memórias',
  'Skills',
  'Pesquisa na web',
  'Provedores',
  'Conta'
]

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
    console.log(`✖ ${name} — ${(e as Error).message.split('\n').slice(0, 6).join('\n')}`)
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

const dialog = (): ReturnType<Page['locator']> => page.locator('[role="dialog"]')
const nav = (): ReturnType<Page['locator']> => page.getByTestId('settings-nav')
const tabBtn = (label: string): ReturnType<Page['locator']> =>
  dialog().getByRole('button', { name: label, exact: true })
const search = (): ReturnType<Page['locator']> => page.getByTestId('settings-search')

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [w, h]
  )
  await page.waitForTimeout(350)
}

async function openSettings(): Promise<void> {
  if (await dialog().isVisible()) return
  await page.getByRole('button', { name: /^Configurações/ }).click()
  await page.getByTestId('settings-sidebar').waitFor()
  await page.waitForTimeout(200)
}

async function closeSettings(): Promise<void> {
  if (!(await dialog().isVisible())) return
  await page.getByRole('button', { name: 'Fechar', exact: true }).first().click()
  await dialog().waitFor({ state: 'detached' })
}

/** Rótulo do item ativo (`aria-current="page"`) e título/aba da área de conteúdo. */
async function activeState(): Promise<{ active: string[]; title: string; tab: string | null }> {
  const active = await nav()
    .locator('button[aria-current="page"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  const title = (await page.locator('#settings-panel-title').innerText()).trim()
  const tab = await page.getByTestId('settings-content').getAttribute('data-tab')
  return { active, title, tab }
}

async function main(): Promise<void> {
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
// nunca o microfone real: dispositivo falso do Chromium
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.setPath('userData', ${JSON.stringify(join(BASE, 'user-data'))})
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=chat' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: /^Configurações/ }).waitFor()
  await page.waitForTimeout(400)

  await step('barra lateral: grupos, ordem, ícones e item ativo destacado', async () => {
    await setSize(1440, 900)
    await openSettings()
    const groups = await nav()
      .locator('[role="group"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    assert.deepEqual(groups, ['Geral', 'Agente', 'Conexões'])
    const labels = await nav()
      .locator('button[data-nav-item]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    assert.deepEqual(labels, ORDER)
    // cada item: ícone svg + rótulo visível; rótulo do grupo à vista
    for (const g of ['Geral', 'Agente', 'Conexões'])
      assert(await nav().getByText(g, { exact: true }).isVisible(), `grupo ${g} invisível`)
    const icons = await nav().locator('button[data-nav-item] svg').count()
    assert.equal(icons, ORDER.length)
    await tabBtn('Novos chats').click()
    const st = await activeState()
    assert.deepEqual(st.active, ['Novos chats'])
    assert.equal(st.title, 'Novos chats')
    assert.equal(st.tab, 'defaults')
    // destaque: fundo preenchido só no ativo (espera a transição de cor)
    await page.mouse.move(5, 5)
    await page.waitForTimeout(400)
    const bgs = await nav()
      .locator('button[data-nav-item]')
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor))
    const activeBg = bgs[0]
    assert(activeBg !== 'rgba(0, 0, 0, 0)', 'ativo sem fundo')
    assert.equal(bgs.filter((b) => b === activeBg).length, 1, 'mais de um item destacado')
    // barra com 200 px e modal ~1040
    const geo = await page.evaluate(() => ({
      side: document.querySelector('[data-testid=settings-sidebar]')!.getBoundingClientRect().width,
      dlg: document.querySelector('[role=dialog]')!.getBoundingClientRect().toJSON()
    }))
    assert(Math.abs(geo.side - 200) <= 1, `barra com ${geo.side}px`)
    await shot('1440-novos-chats')
    return `modal ${Math.round(geo.dlg.width)}×${Math.round(geo.dlg.height)} · barra ${geo.side}px`
  })

  await step('cada aba: clicar ativa, título e conteúdo trocam; rolagem independente', async () => {
    await openSettings()
    const out: string[] = []
    for (const label of ORDER) {
      await tabBtn(label).click()
      await page.waitForTimeout(150)
      const st = await activeState()
      assert.deepEqual(st.active, [label], `ativo errado em ${label}`)
      assert.equal(st.title, label)
    }
    // Áudio é longo: rolar o conteúdo não rola a barra lateral
    await tabBtn('Áudio').click()
    await page.getByTestId('audio-settings').waitFor()
    const r = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('[data-testid=settings-content]')!
      const side = document.querySelector<HTMLElement>('[data-testid=settings-sidebar]')!
      const before = side.getBoundingClientRect().top
      content.scrollTop = 600
      return {
        scrolled: content.scrollTop,
        sideMoved: side.getBoundingClientRect().top - before,
        scrollable: content.scrollHeight > content.clientHeight
      }
    })
    assert(r.scrollable && r.scrolled > 0, 'conteúdo do Áudio não rola')
    assert.equal(r.sideMoved, 0, 'a barra lateral rolou junto')
    // trocar de aba volta o conteúdo ao topo
    await tabBtn('Skills').click()
    const top = await page.getByTestId('settings-content').evaluate((e) => e.scrollTop)
    assert.equal(top, 0, 'troca de aba manteve a rolagem')
    out.push(`9 abas · Áudio rola ${r.scrolled}px sem mexer na barra`)
    for (const [label, name] of [
      ['Áudio', 'audio'],
      ['Aprovações', 'aprovacoes'],
      ['Provedores', 'provedores'],
      ['Personas', 'personas']
    ]) {
      await tabBtn(label).click()
      await shot(`1440-${name}`)
    }
    return out.join(' · ')
  })

  await step('Procurar: filtra por palavra-chave, Enter abre o melhor resultado', async () => {
    await openSettings()
    await tabBtn('Provedores').click()
    await search().fill('microfone')
    await page.waitForTimeout(100)
    let labels = await nav()
      .locator('button[data-nav-item]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    assert.deepEqual(labels, ['Áudio'])
    assert(await nav().getByText('microfone', { exact: true }).isVisible(), 'sem dica da palavra')
    assert.equal(await nav().locator('[data-best]').getAttribute('aria-label'), 'Áudio')
    await shot('1440-busca-microfone')
    await search().press('Enter')
    await page.getByTestId('audio-settings').waitFor()
    assert.deepEqual((await activeState()).active, ['Áudio'])
    // "memoria": Memórias (rótulo) ganha de Aprovações (palavra-chave)
    await search().fill('memoria')
    labels = await nav()
      .locator('button[data-nav-item]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    assert(labels.includes('Memórias') && labels.includes('Aprovações'), labels.join(','))
    await search().press('Enter')
    assert.deepEqual((await activeState()).active, ['Memórias'])
    // grupos sem resultado somem
    await search().fill('whitelist')
    const groups = await nav()
      .locator('[role="group"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    assert.deepEqual(groups, ['Agente'])
    // nada encontrado
    await search().fill('xyzzy')
    await page.getByTestId('settings-search-empty').waitFor()
    assert.equal(
      (await page.getByTestId('settings-search-empty').innerText()).trim(),
      'Nenhuma configuração encontrada'
    )
    assert.equal(await nav().locator('button[data-nav-item]').count(), 0)
    await search().press('Enter') // sem resultado: nada acontece
    assert.deepEqual((await activeState()).active, [])
    await shot('1440-busca-vazia')
    return 'microfone → Áudio · memoria → Memórias · whitelist → só Agente · xyzzy → vazio'
  })

  await step(
    'Procurar "kokoro"/"gpu": Áudio com a dica "Modelos locais"; Enter/clique abre a sub-tela (← Áudio volta)',
    async () => {
      await openSettings()
      await search().fill('')
      await tabBtn('Provedores').click()
      await search().fill('kokoro')
      await page.waitForTimeout(100)
      const labels = await nav()
        .locator('button[data-nav-item]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
      assert.deepEqual(labels, ['Áudio'])
      assert(
        await nav().getByText('Modelos locais · kokoro', { exact: true }).isVisible(),
        'dica da sub-tela'
      )
      assert.equal(await nav().locator('[data-best]').getAttribute('data-sub'), 'audio:local')
      await shot('1440-busca-kokoro')
      await search().press('Enter')
      await page.getByTestId('audio-local-models').waitFor()
      assert.deepEqual((await activeState()).active, ['Áudio'])
      await page.getByTestId('voice-models-kokoro').waitFor({ timeout: 4000 })
      await shot('1440-busca-kokoro-subtela')
      // ← Áudio volta à página principal; clicar na aba de novo também
      await page.getByTestId('audio-local-back').click()
      await page.getByTestId('stt-section').waitFor()
      // "gpu" pelo clique no resultado
      await search().fill('gpu')
      await page.waitForTimeout(100)
      await nav().locator('button[data-nav-item="audio"]').click()
      await page.getByTestId('gpu-mode-section').waitFor()
      assert.equal(await page.getByTestId('audio-settings').getAttribute('data-view'), 'local')
      await search().fill('')
      await tabBtn('Áudio').click()
      await page.getByTestId('stt-section').waitFor()
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      return 'kokoro → Modelos locais · gpu → Modelos locais · aba → principal'
    }
  )

  await step('Esc: 1º limpa a busca, 2º fecha o modal', async () => {
    await openSettings()
    await search().fill('gpu')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    assert(await dialog().isVisible(), 'o 1º Esc fechou o modal')
    assert.equal(await search().inputValue(), '')
    assert.equal(await nav().locator('button[data-nav-item]').count(), ORDER.length)
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'detached' })
    return 'busca limpa → modal fechado'
  })

  await step('teclado: ↓ da busca vai aos itens, ↑/↓/Home/End navegam, ↑ no 1º volta', async () => {
    await openSettings()
    await search().click()
    await page.keyboard.press('ArrowDown')
    const focused = (): Promise<string | null> =>
      page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)
    assert.equal(await focused(), 'Novos chats')
    await page.keyboard.press('ArrowDown')
    assert.equal(await focused(), 'Personas')
    await page.keyboard.press('End')
    assert.equal(await focused(), 'Conta')
    await page.keyboard.press('Enter')
    assert.deepEqual((await activeState()).active, ['Conta'])
    await page.keyboard.press('Home')
    assert.equal(await focused(), 'Novos chats')
    await page.keyboard.press('ArrowUp')
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
      'settings-search'
    )
    await closeSettings()
    return 'busca → itens → Enter abre'
  })

  await step('1000 px: barra completa, conteúdo sem rolagem horizontal', async () => {
    await setSize(1000, 760)
    await openSettings()
    const compact = await page.getByTestId('settings-sidebar').getAttribute('data-compact')
    assert.equal(compact, null, 'compacto em 1000 px')
    for (const [label, name] of [
      ['Áudio', 'audio'],
      ['Aprovações', 'aprovacoes'],
      ['Novos chats', 'novos-chats']
    ]) {
      await tabBtn(label).click()
      await shot(`1000-${name}`)
    }
    return 'barra com rótulos'
  })

  await step(
    '900 px: só ícones com tooltip; nomes acessíveis mantidos; lupa abre a busca',
    async () => {
      await setSize(900, 640)
      await openSettings()
      const side = page.getByTestId('settings-sidebar')
      assert.equal(await side.getAttribute('data-compact'), 'true')
      const w = await side.evaluate((e) => e.getBoundingClientRect().width)
      assert(w <= 57, `barra compacta com ${w}px`)
      assert.equal(await search().count(), 0, 'busca à vista no compacto')
      // rótulos escondidos, nome acessível igual (os testes clicam por ele)
      assert.equal(await nav().getByText('Geral', { exact: true }).count(), 0)
      await tabBtn('Aprovações').click()
      assert.deepEqual((await activeState()).active, ['Aprovações'])
      await tabBtn('Skills').hover()
      const tip = page.locator('[role="tooltip"]').filter({ hasText: 'Skills' })
      await tip.first().waitFor({ state: 'attached', timeout: 3000 })
      await shot('900-compacto-tooltip')
      // lupa → barra expandida por cima, busca focada; Enter escolhe e recolhe
      await page.getByTestId('settings-search-toggle').click()
      await search().waitFor()
      assert.equal(await side.getAttribute('data-expanded'), 'true')
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
        'settings-search'
      )
      await page.keyboard.type('tavily')
      await shot('900-compacto-busca')
      await page.keyboard.press('Enter')
      assert.deepEqual((await activeState()).active, ['Pesquisa na web'])
      assert.equal(await side.getAttribute('data-expanded'), null, 'não recolheu')
      // lupa + Esc: recolhe (sem fechar o modal); clicar fora também recolhe
      await page.getByTestId('settings-search-toggle').click()
      await search().waitFor()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      assert.equal(await side.getAttribute('data-expanded'), null)
      assert(await dialog().isVisible(), 'Esc fechou o modal')
      await page.getByTestId('settings-search-toggle').click()
      await search().waitFor()
      // clique fora da barra (no conteúdo, à direita do título — a barra expandida cobre a esquerda)
      await page.getByTestId('settings-content').click({ position: { x: 520, y: 14 } })
      await page.waitForTimeout(150)
      assert.equal(await side.getAttribute('data-expanded'), null, 'clique fora não recolheu')
      return `barra ${w}px · tooltip · lupa → tavily → Pesquisa na web`
    }
  )

  await step('nenhuma aba com rolagem horizontal (1440/1000/900)', async () => {
    const out: string[] = []
    for (const [w, h] of [
      [1440, 900],
      [1000, 760],
      [900, 640]
    ] as const) {
      await setSize(w, h)
      await openSettings()
      const bad: string[] = []
      for (const label of ORDER) {
        await tabBtn(label).click()
        await page.waitForTimeout(120)
        const o = await page.evaluate(() => {
          const c = document.querySelector<HTMLElement>('[data-testid=settings-content]')!
          return {
            scroll: c.scrollWidth > c.clientWidth + 1,
            page: document.documentElement.scrollWidth > window.innerWidth,
            width: Math.round(c.clientWidth)
          }
        })
        if (o.scroll || o.page) bad.push(label)
        if (label === 'Áudio') out.push(`${w}: conteúdo ${o.width}px`)
      }
      assert.deepEqual(bad, [], `rolagem horizontal em ${w}: ${bad.join(', ')}`)
    }
    await setSize(1440, 900)
    await closeSettings()
    return out.join(' · ')
  })

  await step('abrir numa aba vindo de fora (menu do microfone, Gerenciar personas…)', async () => {
    await closeSettings()
    const out: string[] = []
    if (!(await page.getByTestId('voice-mic-menu-button').isVisible())) {
      await page.getByTestId('chat-item').first().click()
      await page.waitForTimeout(400)
    }
    await page.getByTestId('voice-mic-menu-button').click()
    await page.getByTestId('voice-settings-link').click()
    await page.getByTestId('audio-settings').waitFor()
    assert.deepEqual((await activeState()).active, ['Áudio'])
    out.push('mic → Áudio')
    await closeSettings()
    // "Gerenciar personas…" no seletor de persona do Novo chat
    await page.keyboard.press('Control+n')
    const picker = page.getByTestId('preset-picker')
    if (await picker.isVisible().catch(() => false)) {
      await picker.click()
      await page.getByRole('button', { name: /Gerenciar personas/ }).click()
      await page.getByTestId('settings-sidebar').waitFor()
      assert.deepEqual((await activeState()).active, ['Personas'])
      out.push('Gerenciar personas → Personas')
      await closeSettings()
    }
    // atalho do store (o mesmo caminho de todos os links "Configurações → X")
    await page.evaluate(`window.__clearStore.getState().setSettingsOpen(true, 'providers')`)
    await page.getByTestId('settings-sidebar').waitFor()
    assert.deepEqual((await activeState()).active, ['Provedores'])
    out.push("setSettingsOpen(true,'providers') → Provedores")
    await closeSettings()
    return out.join(' · ')
  })

  await app.close()
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
