// E2E contra o MOCK de UI (Playwright + `e2e/launch.ts`, sem backend, sem key) de três peças do chat:
//   1. raciocínio: "Pensando… N s" ao vivo (o relógio fica no store), "Raciocínio · 12 s · 1,2 mil
//      tokens" na resposta salva e "Raciocínio · N s" quando o rascunho passa a responder;
//   2. gasto do chat: botão ao lado do medidor de contexto + popover com as linhas/totais do mock
//      (?scenario=spend) e atualização ao vivo;
//   3. pílula do modelo no composer (fora do cabeçalho; clique → aba Modelo) e recolhimento do
//      cabeçalho/barra do composer em 1440, 1100 e 900 px (painel direito e arquivo abertos/fechados),
//      sem overflow nem quebra de linha; o host do chat é só um ícone na barra do composer (nada no
//      cabeçalho): remoto roxo / local neutro, tooltip com o nome e popover com as ações.
//      Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-bars-e2e node e2e/chat-bars-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-bars-e2e'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''

let app: ElectronApplication
let page: Page
let stopped = false
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(200)
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

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [w, h]
  )
  await page.waitForTimeout(350)
}

async function panel(open: boolean): Promise<void> {
  const isOpen = await page.getByTestId('right-panel').isVisible()
  if (isOpen === open) return
  await page
    .getByRole('banner')
    .getByRole('button', { name: open ? 'Abrir painel' : 'Fechar painel' })
    .click()
  await page.waitForTimeout(300)
}

async function open(scenario: string, chat: string): Promise<void> {
  await page.evaluate((s) => {
    location.search = `?scenario=${s}`
  }, scenario)
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('chat-item').filter({ hasText: chat }).first().click()
  await page.getByTestId('chat-scroller').waitFor()
  await page.waitForTimeout(500)
}

// o renderer tem CSP sem eval: o corpo vai como expressão do DevTools (Runtime.evaluate)
const store = <T>(fn: string, arg?: unknown): Promise<T> =>
  page.evaluate(
    `((s, emit, arg) => { ${fn} })(window.__clearStore, window.__clearMockEmit, ${JSON.stringify(arg ?? null)})`
  ) as Promise<T>

const text = async (testId: string): Promise<string> =>
  (await page.getByTestId(testId).innerText()).replace(/\s+/g, ' ').trim()

/** Overflow/quebra no cabeçalho e na barra do composer. */
function barsGeo(): Promise<{
  overflow: string[]
  wrapped: string[]
  levels: Record<string, string>
}> {
  return page.evaluate(() => {
    const overflow: string[] = []
    const wrapped: string[] = []
    const levels: Record<string, string> = {}
    const roots = [
      document.querySelector<HTMLElement>('[data-testid=top-bar]')!,
      document.querySelector<HTMLElement>('[data-testid=composer-toolbar]')!
    ]
    for (const root of roots) {
      if (!root) continue
      const clips = [root, ...root.querySelectorAll<HTMLElement>('[data-bar-clip]')]
      for (const c of clips)
        if (c.scrollWidth > c.clientWidth + 1)
          overflow.push(
            `${c.dataset.testid ?? c.className.slice(0, 30)} ${c.scrollWidth}>${c.clientWidth}`
          )
      const box = root.getBoundingClientRect()
      for (const it of root.querySelectorAll<HTMLElement>('[data-bar-item]')) {
        levels[it.dataset.barItem!] = it.dataset.barLevel!
        const r = it.getBoundingClientRect()
        if (r.width && r.height > 30) wrapped.push(`${it.dataset.barItem} h=${r.height}`)
        if (r.width && (r.right > box.right + 1 || r.left < box.left - 1))
          overflow.push(`${it.dataset.barItem} fora (${Math.round(r.left)}–${Math.round(r.right)})`)
      }
      const title = root.querySelector<HTMLElement>('[data-bar-title]')
      if (title && title.getBoundingClientRect().width < 40) overflow.push('título sumiu')
    }
    if (document.documentElement.scrollWidth > window.innerWidth) overflow.push('página rola')
    return { overflow, wrapped, levels }
  })
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
// microfone: a guarda do e2e/launch.ts (dispositivo falso, permissão negada)
app.setPath('userData', ${JSON.stringify(join(BASE, 'user-data'))})
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 860, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.setIgnoreMouseEvents(true)
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=chat' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await launchElectron({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await setSize(1440, 860)

  // ---------------- 1. raciocínio ----------------

  await step(
    'raciocínio: "Pensando… N s" ao vivo incrementa; resposta salva com tempo e tokens',
    async () => {
      await open('reasoning', 'Ideias de nomes para o app')
      const headers = page.getByTestId('reasoning-header')
      await headers
        .nth(1)
        .getByText(/Pensando…/)
        .waitFor()
      // resposta salva: meta.reasoningMs 12 400 + usage.reasoningTokens 1 210
      const saved = (await headers.first().innerText()).replace(/\s+/g, ' ')
      assert.equal(saved, 'Raciocínio · 12 s · 1,2 mil tokens')
      await page.waitForTimeout(1300)
      const a = (await headers.nth(1).innerText()).replace(/\s+/g, ' ')
      const m1 = /^Pensando… · (\d+) s$/.exec(a)
      assert(m1, `ao vivo: ${a}`)
      await page.waitForTimeout(2100)
      const b = (await headers.nth(1).innerText()).replace(/\s+/g, ' ')
      const m2 = /^Pensando… · (\d+) s$/.exec(b)
      assert(m2 && Number(m2[1]) >= Number(m1[1]) + 2, `incrementa: ${a} → ${b}`)
      // remontar a lista (abrir outro chat e voltar) não zera o relógio — ele mora no store
      await page.getByTestId('chat-item').filter({ hasText: 'Refatorar o parser' }).first().click()
      await page.waitForTimeout(400)
      await page.getByTestId('chat-item').filter({ hasText: 'Ideias de nomes' }).first().click()
      await page.waitForTimeout(400)
      const c = (await page.getByTestId('reasoning-header').nth(1).innerText()).replace(/\s+/g, ' ')
      const m3 = /^Pensando… · (\d+) s$/.exec(c)
      assert(m3 && Number(m3[1]) >= Number(m2[1]), `depois de remontar: ${c}`)
      await shot('01-reasoning-live')
      return `${saved} | ${a} → ${b} → ${c}`
    }
  )

  await step(
    'raciocínio: rascunho passa a responder → "Raciocínio · N s"; mensagem antiga só "Raciocínio"',
    async () => {
      await open('chat', 'Script de backup com rsync')
      await store(
        `emit({ type: 'draft', sessionId: 's4', draft: { content: '', reasoning: 'Vou pensar no rsync…', toolCalls: [] } })`
      )
      const h = page.getByTestId('reasoning-header').last()
      await h.getByText('Pensando…').waitFor()
      await page.waitForTimeout(2300)
      assert.match((await h.innerText()).replace(/\s+/g, ' '), /^Pensando… · 2 s$/)
      await store(
        `emit({ type: 'draft', sessionId: 's4', draft: { content: 'Use rsync -a', reasoning: 'Vou pensar no rsync…', toolCalls: [] } })`
      )
      await page.waitForTimeout(300)
      const done = (await h.innerText()).replace(/\s+/g, ' ')
      assert.equal(done, 'Raciocínio · 2 s')
      await shot('02-reasoning-draft-done')
      // mensagem salva sem reasoningMs/tokens (antiga)
      await store(`emit({ type: 'draft', sessionId: 's4', draft: null })`)
      await store(
        `emit({ type: 'message-added', message: { id: 'old-r', sessionId: 's4', seq: 9999, createdAt: Date.now(), message: { role: 'assistant', content: 'ok', reasoning: 'antigo' }, meta: { model: 'x' } } })`
      )
      await page.waitForTimeout(300)
      const old = (await page.getByTestId('reasoning-header').last().innerText()).trim()
      assert.equal(old, 'Raciocínio')
      return `${done} | antiga: ${old}`
    }
  )

  // ---------------- 2. gasto ----------------

  await step(
    'gasto: botão no composer + popover com as linhas/totais do mock; atualiza ao vivo',
    async () => {
      await open('spend', 'Ideias de nomes para o app')
      const btn = page.getByTestId('composer-toolbar').getByTestId('spend-button')
      await btn.waitFor()
      // o subagente carrega em segundo plano (~0,8 s): total inclui os $0,018 dele
      await page.waitForFunction(
        () => document.querySelector('[data-testid=spend-button-total]')?.textContent === '$0,17',
        undefined,
        { timeout: 5000 }
      )
      await btn.click()
      await page.getByTestId('spend-popover').waitFor()
      const expect: [string, string][] = [
        ['spend-total', '$0,17 + ?'],
        ['spend-main-cost', '$0,15 + ?'],
        ['spend-main-input', 'Entrada (sem cache) 10.000 tokens'],
        ['spend-main-cache-read', 'Entrada do cache 16.000 tokens'],
        ['spend-main-cache-write', 'Escrita de cache 1.000 tokens'],
        ['spend-main-output', 'Saída 900 tokens'],
        ['spend-main-reasoning', 'dos quais raciocínio 200 tokens'],
        ['spend-subagents-cost', '$0,02'],
        ['spend-subagents-input', 'Entrada (sem cache) 5.500 tokens'],
        ['spend-subagents-cache-read', 'Entrada do cache 1.000 tokens'],
        ['spend-subagents-output', 'Saída 600 tokens'],
        ['spend-judge-cost', '$0,0020'],
        ['spend-capture-cost', '$0,0015'],
        ['spend-title-cost', '<$0,0001']
      ]
      for (const [id, want] of expect) assert.equal(await text(id), want, id)
      assert.match(await text('spend-main'), /Respostas · 3 chamadas/)
      assert.match(await text('spend-subagents'), /Subagentes · 1 sessão · 2 chamadas/)
      assert.match(await text('spend-capture'), /Coleta de contexto · 3 chamadas/)
      assert.match(await text('spend-title'), /Título automático · 1 chamada/)
      assert.match(await text('spend-unknown'), /1 chamada sem custo informado/)
      assert.match(await text('spend-popover'), /relatórios de uso/)
      await page.getByRole('button', { name: 'Por subagente' }).click()
      assert.match(await text('spend-per-subagent'), /Pesquisar nomes · claude-haiku-4\.5 \$0,02/)
      await shot('03-spend-popover')
      // ao vivo: nova resposta com custo
      await store(
        `emit({ type: 'message-added', message: { id: 'live-1', sessionId: 's2', seq: 9999, createdAt: Date.now(), message: { role: 'assistant', content: 'mais' }, meta: { model: 'openai/gpt-5', usage: { promptTokens: 100, completionTokens: 10, cost: 0.1 } } } })`
      )
      await page.waitForFunction(
        () => document.querySelector('[data-testid=spend-total]')?.textContent === '$0,27 + ?'
      )
      assert.equal(await text('spend-button-total'), '$0,27')
      await page.keyboard.press('Escape')
      return 'linhas e totais conferem; +$0,10 ao vivo'
    }
  )

  // ---------------- 3. pílula + recolhimento ----------------

  await step('pílula do modelo: no composer (não no cabeçalho) e abre a aba Modelo', async () => {
    await open('chat', 'Refatorar o parser de SSE')
    await panel(false)
    assert.equal(await page.getByTestId('top-bar').getByTestId('model-pill').count(), 0)
    const pill = page.getByTestId('composer-toolbar').getByTestId('model-pill')
    await pill.waitFor()
    assert.match(
      (await pill.innerText()).replace(/\s+/g, ' '),
      /OpenRouter · anthropic\/ claude-sonnet-4\.5|OpenRouter · anthropic\/claude-sonnet-4\.5/
    )
    await pill.click()
    await page.getByTestId('right-panel').waitFor()
    const tab = page.getByTestId('right-panel').getByRole('tab', { name: 'Modelo' })
    assert.equal(await tab.getAttribute('aria-selected'), 'true')
    await shot('04-model-pill-opens-model-tab')
    // subsessão: o par dela
    await store(`s.getState().openSession('s1a')`)
    await page.waitForTimeout(400)
    assert.match(
      (await page
        .getByTestId('composer-toolbar')
        .getByTestId('model-pill')
        .getAttribute('aria-label')) ?? '',
      /claude-haiku-4\.5/
    )
    await store(`s.getState().openSession('s1')`)
    await panel(false)
  })

  await step(
    'recolhimento: 1440 / 1100 / 900 px × painel × arquivo (± ditado), sem overflow; host = ícone no composer',
    async () => {
      await open('chat', 'Refatorar o parser de SSE')
      // o painel abre por padrão a cada carga: com ele a 1440 px o ícone do host já pode recolher
      await panel(false)
      const HOST = 'Workstation do escritório (Linux)'
      const remote = (): Promise<void> =>
        store(
          `const st = s.getState();
         s.setState({
           sync: { ...(st.sync || {}), phase: 'ready', connection: 'connected', device: { id: 'dev-me', name: 'Notebook' }, outdatedHosts: [], prompts: [] },
           chatHosts: { ...st.chatHosts, c1: { chatId: 'c1', mode: 'remote', host: { deviceId: 'dev-ws', name: arg, status: 'online', self: false }, running: true, pinned: false, epoch: 1, handover: null, diverged: null, usesLocalTools: true, hostCwd: null, needsCwd: false } }
         })`,
          HOST
        )
      await remote()
      const indicator = page.getByTestId('composer-toolbar').getByTestId('host-indicator')
      await indicator.waitFor()
      assert.equal(await indicator.getAttribute('data-mode'), 'remote')
      // um lugar só: nada de "Executando em" no cabeçalho
      assert.equal(await page.getByRole('banner').getByTestId('host-indicator').count(), 0)
      assert.equal(await page.getByRole('banner').getByText('Executando em').count(), 0)
      const out: string[] = []
      for (const w of [1440, 1100, 900]) {
        for (const p of [false, true]) {
          for (const file of [false, true]) {
            await setSize(w, 820)
            if (file)
              await store(
                `s.getState().openFile('c1', { chatId: 'c1', source: 'browse', path: '/home/dev/projetos/clearchat/README.md' }, '/home/dev/projetos/clearchat/README.md', 'README.md')`
              )
            else await store(`s.getState().closeFile('c1')`)
            await panel(p)
            await page.waitForTimeout(450)
            const g = await barsGeo()
            const tag = `${w}${p ? '-painel' : ''}${file ? '-arquivo' : ''}`
            assert.deepEqual(g.overflow, [], `${tag}: overflow`)
            assert.deepEqual(g.wrapped, [], `${tag}: quebra de linha`)
            await shot(`05-bars-${tag}`)
            out.push(
              `${tag}: ${Object.entries(g.levels)
                .map(([k, v]) => `${k}=${v}`)
                .join(',')}`
            )
            // o grupo de voz [ telefone | mic | ˅ ] nunca some; o ícone do host e o </> recolhem
            // antes dele (a seta do microfone vai para o botão direito do mic no nível 1)
            const group = page.getByTestId('composer-toolbar').getByTestId('voice-group')
            assert.ok(await group.isVisible(), `${tag}: grupo de voz visível`)
            if (g.levels['voice-controls'] !== '0')
              assert.ok(
                g.levels['composer-host'] === '2' && g.levels['composer-info'] === '2',
                `${tag}: host e </> recolhem antes do grupo de voz`
              )
            if (g.levels['composer-host'] !== '2') {
              assert.ok(await indicator.isVisible(), `${tag}: ícone do host visível`)
              assert.equal((await indicator.innerText()).trim(), '', `${tag}: só ícone`)
            }
            if (w === 1440 && !p && !file)
              assert.ok(await indicator.isVisible(), `${tag}: ícone do host visível em 1440`)
            // barra do ditado (mic + waveform + [ × | ✓ ] + enviar) também cabe
            // (combinações mais estreitas sem o painel sobreposto com fundo escuro)
            if (file && ((w === 1440 && p) || (w === 900 && !p))) {
              await group.getByTestId('voice-mic-button').click()
              await page.getByTestId('voice-draft').waitFor()
              await page.waitForTimeout(450)
              const d = await barsGeo()
              assert.deepEqual(d.overflow, [], `${tag} (ditado): overflow`)
              await page.getByTestId('voice-finish-button').waitFor()
              await shot(`05-bars-${tag}-ditado`)
              await page.getByTestId('voice-cancel-button').click()
              await page.getByTestId('voice-draft').waitFor({ state: 'detached' })
            }
            if (w === 900 && !p && !file && (await indicator.isVisible())) {
              await indicator.hover()
              await page
                .getByRole('tooltip')
                .getByText(`Executando em ${HOST}`, { exact: false })
                .first()
                .waitFor({ timeout: 3000 })
              await shot('06-900-host-tooltip')
              await page.mouse.move(5, 400)
              await page.waitForTimeout(300)
            }
          }
        }
      }
      await panel(false)
      await store(`s.getState().closeFile('c1')`)
      await setSize(1440, 860)
      // remoto: popover com o nome e as ações (assumir, fixar)
      await indicator.click()
      const pop = page.getByTestId('host-popover')
      await pop.waitFor()
      assert.match(
        await pop.getByTestId('host-popover-title').innerText(),
        /Controle remoto de Workstation/
      )
      await pop.getByTestId('host-takeover').waitFor()
      await pop.getByTestId('host-pin').waitFor()
      await shot('07-host-remote-popover')
      await page.keyboard.press('Escape')
      // local: ícone neutro deste dispositivo, popover "Executando em Notebook" + fixar
      await store(
        `const st = s.getState();
         s.setState({ chatHosts: { ...st.chatHosts, c1: { ...st.chatHosts.c1, mode: 'local', host: { deviceId: 'dev-me', name: 'Notebook', status: 'online', self: true }, running: false } } })`
      )
      await page.waitForTimeout(200)
      assert.equal(await indicator.getAttribute('data-mode'), 'local')
      assert.equal(await indicator.getAttribute('aria-label'), 'Executando em Notebook')
      await indicator.click()
      await pop.waitFor()
      assert.equal(
        await pop.getByTestId('host-popover-title').innerText(),
        'Executando em Notebook'
      )
      assert.equal(await pop.getByTestId('host-takeover').count(), 0)
      await pop.getByTestId('host-pin').waitFor()
      await shot('08-host-local-popover')
      await page.keyboard.press('Escape')
      // sem sync: nada
      await store(`s.setState({ sync: null })`)
      await page.waitForTimeout(200)
      assert.equal(await indicator.count(), 0)
      return out.join(' | ')
    }
  )

  await app.close()
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} ok · shots em ${SHOTS}`)
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
