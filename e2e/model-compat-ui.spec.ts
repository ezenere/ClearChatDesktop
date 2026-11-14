// E2E contra o MOCK de UI (Playwright `_electron`, sem backend, sem key) da compatibilidade modelo ↔
// chat (SPEC → Anexos → Compatibilidade), cenário `?scenario=model-compat` (modelos com modalidades
// conhecidas + chat "Análise da captura de tela" com uma imagem no histórico):
//   1. seletor da aba Modelo: modelos sem visão desabilitados (aria-disabled, "não aceita imagem",
//      tooltip com o motivo), clique não troca; modelo com visão e modelo sem metadados escolhíveis;
//   2. composer: modelo incompatível trocado fora do seletor (outro dispositivo/IPC) → aviso
//      "o modelo atual não aceita imagem" e Enter não envia (só "Enviar mesmo assim");
//   3. chat sem mídia: nada desabilitado.
// Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-modelcompat-e2e node e2e/model-compat-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-modelcompat-e2e'))
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

/** Opção do seletor no grupo do OpenRouter. */
const option = (model: string): Locator =>
  page.locator(`[role=option][data-provider="OpenRouter"][data-model="${model}"]`)

async function openPicker(): Promise<void> {
  await page.getByTestId('model-pill').click()
  const picker = page.getByTestId('right-panel').getByTestId('model-picker')
  await picker.waitFor()
  await picker.click()
  await option('openai/gpt-5').waitFor()
  await page.waitForTimeout(300)
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
// nunca o microfone real: dispositivo falso do Chromium
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
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
  app = await electron.launch({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  await step('seletor: chat com imagem → modelos sem visão desabilitados com motivo', async () => {
    await open('model-compat', 'Análise da captura de tela')
    await openPicker()
    const out: string[] = []
    for (const id of ['qwen/qwen3-coder', 'deepseek/deepseek-chat-v3.1:free']) {
      const o = option(id)
      assert.equal(await o.getAttribute('aria-disabled'), 'true', `${id} desabilitado`)
      assert.equal(
        (await o.getByTestId('model-incompatible').innerText()).trim(),
        'não aceita imagem',
        `${id} rótulo`
      )
      out.push(`${id.split('/')[1]} off`)
    }
    for (const id of [
      'openai/gpt-5',
      'anthropic/claude-sonnet-4.5',
      'meta-llama/llama-4-maverick' // sem metadados: desconhecido → nunca desabilita
    ]) {
      assert.equal(await option(id).getAttribute('aria-disabled'), null, `${id} habilitado`)
      assert.equal(await option(id).getByTestId('model-incompatible').count(), 0)
    }
    // tooltip com o motivo completo
    // rolar fecha o tooltip do Radix (e ele só reabre ao sair e voltar): traz a linha para a
    // vista, sai para outra linha e volta — algumas tentativas
    const tip = page
      .getByRole('tooltip')
      .getByText('Este chat tem imagens — o modelo não aceita imagem.', { exact: false })
      .first()
    for (let k = 0; ; k++) {
      await option('qwen/qwen3-coder').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await option('openai/gpt-5').hover()
      await page.waitForTimeout(150)
      await option('qwen/qwen3-coder').hover()
      try {
        await tip.waitFor({ timeout: 2000 })
        break
      } catch (e) {
        if (k >= 3) throw e
      }
    }
    await shot('01-picker-disabled-tooltip')
    // clique num desabilitado não troca nem fecha
    await option('qwen/qwen3-coder').click({ force: true }) // aria-disabled: Playwright não clica sem force
    await page.waitForTimeout(300)
    assert.ok(await option('qwen/qwen3-coder').isVisible(), 'lista continua aberta')
    const model = await store<string>(
      `return s.getState().chats.find((c) => c.id === 'cimg').config.model`
    )
    assert.equal(model, 'anthropic/claude-sonnet-4.5')
    // o com visão troca
    await option('openai/gpt-5').click()
    await page.waitForTimeout(300)
    const after = await store<string>(
      `return s.getState().chats.find((c) => c.id === 'cimg').config.model`
    )
    assert.equal(after, 'openai/gpt-5')
    await shot('02-picker-vision-chosen')
    return out.join(', ') + ` · escolhido ${after}`
  })

  await step(
    'composer: modelo incompatível trocado fora do seletor → aviso e Enter não envia',
    async () => {
      await open('model-compat', 'Análise da captura de tela')
      await store(
        `s.setState((st) => ({ sessions: { ...st.sessions, simg: { ...st.sessions.simg, model: 'qwen/qwen3-coder' } } }))`
      )
      const alert = page.getByTestId('composer-column').getByRole('alert')
      await alert
        .getByText('Este chat tem imagens — o modelo atual não aceita imagem', { exact: false })
        .waitFor()
      const before = await store<number>(`return (s.getState().messages.simg ?? []).length`)
      const ta = page.locator('[data-testid=composer-column] textarea')
      await ta.fill('E o rodapé?')
      await ta.press('Enter')
      await page.getByText('Confirme para enviar assim mesmo.').waitFor()
      const after = await store<number>(`return (s.getState().messages.simg ?? []).length`)
      assert.equal(after, before, 'Enter não enviou')
      await shot('03-composer-history-warning')
      return (await alert.innerText()).replace(/\s+/g, ' ').trim()
    }
  )

  await step('chat sem mídia: nenhum modelo desabilitado', async () => {
    await open('model-compat', 'Ideias de nomes para o app')
    await openPicker()
    const n = await page.locator('[role=option][aria-disabled=true]').count()
    assert.equal(n, 0, `desabilitados: ${n}`)
    await shot('04-picker-no-media')
    return 'ok'
  })

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
