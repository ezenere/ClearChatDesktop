// E2E da UI de Configurações → TEMPO E MAPAS contra o MOCK de UI (Playwright + `e2e/launch.ts`, sem
// backend, sem key real, sem rede): builda o renderer com VITE_CLEAR_MOCK=1 numa pasta de rascunho
// (não mexe em out/), abre `index.html` numa janela Electron mínima (userData isolado) e percorre:
//   aba "Tempo e mapas" no grupo Agente (e pela busca de Configurações); Open-Meteo marcado, Google
//   desabilitado sem chave; salvar a chave (máscara, "chave salva"); Testar (ok); escolher o Google;
//   remover a chave → volta ao Open-Meteo; chave ruim digitada → Testar mostra o erro.
// Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-maps-ui node e2e/maps-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-maps-ui'))
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

const dlg = (): ReturnType<Page['locator']> => page.locator('[role="dialog"]')
const radio = (id: string): ReturnType<Page['locator']> =>
  page.getByTestId(`weather-provider-${id}`)

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
// userData isolado (localStorage do "Limpar" etc.) — nunca a pasta real do app
app.setPath('userData', ${JSON.stringify(USER_DATA)})
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, {})
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

  await step(
    'aba "Tempo e mapas" no grupo Agente; Open-Meteo marcado, Google desabilitado',
    async () => {
      await page.getByRole('button', { name: /^Configurações/ }).click()
      await dlg().getByRole('button', { name: 'Tempo e mapas', exact: true }).click()
      await page.getByTestId('maps-settings').waitFor()
      assert.equal(await radio('open-meteo').getAttribute('aria-checked'), 'true')
      assert.equal(await radio('google').getAttribute('aria-checked'), 'false')
      assert.ok(await radio('google').isDisabled(), 'Google sem chave fica desabilitado')
      assert.match(await radio('open-meteo').innerText(), /padrão[\s\S]*sem chave/)
      assert.match(await radio('google').innerText(), /requer chave/)
      await shot('01-sem-chave')
    }
  )

  await step('salvar a chave: máscara no lugar, "chave salva", Testar ok', async () => {
    const key = page.getByTestId('google-maps-key')
    await key.fill('AIzaSyMOCK0123456789abcdefXYZ')
    await page.getByRole('button', { name: 'Salvar' }).click()
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="google-maps-key"]') as HTMLInputElement | null)
          ?.value === ''
    )
    const ph = (await key.getAttribute('placeholder')) ?? ''
    assert.match(ph, /digite para trocar/)
    assert.ok(!ph.includes('MOCK0123456789'), `a chave não aparece inteira: ${ph}`)
    await radio('google').getByText('chave salva').waitFor()
    await page.getByRole('button', { name: 'Testar a chave do Google Maps' }).click()
    await page.getByTestId('google-maps-test').waitFor()
    assert.match(await page.getByTestId('google-maps-test').innerText(), /Chave ok/)
    await shot('02-chave-salva-teste-ok')
  })

  await step('escolher o Google; mostrar a chave a pedido', async () => {
    await radio('google').click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="weather-provider-google"]')
          ?.getAttribute('aria-checked') === 'true'
    )
    assert.equal(await radio('open-meteo').getAttribute('aria-checked'), 'false')
    await page.getByRole('button', { name: 'Mostrar chave' }).click()
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="google-maps-key"]') as HTMLInputElement | null)
          ?.value === 'AIzaSyMOCK0123456789abcdefXYZ'
    )
    await page.getByRole('button', { name: 'Ocultar chave' }).click()
    await shot('03-google-escolhido')
  })

  await step('remover a chave → volta ao Open-Meteo e o Google desabilita', async () => {
    await page.getByRole('button', { name: 'Remover a chave do Google Maps' }).click()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="weather-provider-open-meteo"]')
          ?.getAttribute('aria-checked') === 'true'
    )
    assert.ok(await radio('google').isDisabled())
    assert.match(await radio('google').innerText(), /requer chave/)
  })

  await step('chave ruim digitada: Testar mostra o erro (sem salvar)', async () => {
    await page.getByTestId('google-maps-key').fill('ruim')
    await page.getByRole('button', { name: 'Testar a chave do Google Maps' }).click()
    await page.getByTestId('google-maps-test').waitFor()
    assert.match(
      await page.getByTestId('google-maps-test').innerText(),
      /chave do Google Maps é inválida/
    )
    assert.ok(await radio('google').isDisabled(), 'testar não salva')
    await shot('04-chave-ruim')
  })

  await step('busca de Configurações acha "previsão do tempo"', async () => {
    await page.keyboard.press('Escape')
    await dlg()
      .waitFor({ state: 'detached' })
      .catch(() => undefined)
    await page.getByRole('button', { name: /^Configurações/ }).click()
    const search = dlg()
      .getByRole('searchbox')
      .or(dlg().getByPlaceholder(/Procurar/))
    await search.first().fill('previsão do tempo')
    await dlg().getByRole('button', { name: 'Tempo e mapas', exact: true }).waitFor()
    await page.keyboard.press('Escape')
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
