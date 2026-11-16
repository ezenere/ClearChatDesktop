// E2E da UI dos AGENDAMENTOS contra o MOCK de UI (Playwright + `e2e/launch.ts`, sem backend, sem
// key): builda o renderer com VITE_CLEAR_MOCK=1 numa pasta de rascunho (não mexe em out/), abre
// `index.html?scenario=schedule` numa janela Electron mínima (userData isolado) e percorre:
//   chip "2 agendamentos" no header do chat → popover (ativos com id, próximo disparo, repetição,
//   execuções e a última com erro; "Encerrados · 1" com o cancelado ao fechar o app) → Parar um →
//   vai para Encerrados (parado pelo usuário) → Limpar tira os encerrados da tela; cards no chat
//   (disparos com a saída da tool — o com erro em vermelho —, aviso de cancelamento com os ids, card
//   da tool schedule com quando/o quê); card de aprovação do schedule (quando, lembrete, aviso de
//   que roda sozinho) → Permitir; aba Aprovações das Configurações com o item "Criar agendamento".
// Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-schedule-ui node e2e/schedule-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-schedule-ui'))
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

async function openChat(title: string): Promise<void> {
  await page.getByTestId('chat-item').filter({ hasText: title }).first().click()
  await page.getByTestId('chat-scroller').waitFor()
}

const popover = (): ReturnType<Page['locator']> => page.getByTestId('schedules-popover')
const badge = (): ReturnType<Page['locator']> => page.getByTestId('schedules-badge')

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
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=schedule' })
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

  await step('chip "2 agendamentos" no header do chat', async () => {
    await openChat('Build e PRs')
    await badge().waitFor()
    assert.equal(await badge().getAttribute('data-state'), 'active')
    assert.match(await badge().innerText(), /2 agendamentos/)
    await shot('01-chat-com-agendamentos')
  })

  await step('popover: ativos (id, próximo, repetição, execuções) e Encerrados · 1', async () => {
    await badge().click()
    await popover().waitFor()
    const items = popover().getByTestId('schedule-item')
    assert.equal(await items.count(), 2)
    const first = await items.nth(0).innerText()
    assert.match(first, /sch-4f2kq/)
    assert.match(first, /Checar o build/)
    assert.match(first, /\d\d:\d\d · daqui a 4 min/)
    assert.match(first, /a cada 10 min, 12 vezes/)
    assert.match(first, /2 de 12 execuções \(última: erro\)/)
    assert.match(first, /shell "npm test -- --reporter=dot"/)
    assert.match(
      await items.nth(1).innerText(),
      /sch-9a7b1[\s\S]*Revisar o PR do Bruno[\s\S]*uma vez/
    )
    assert.match(
      await popover().getByTestId('schedules-ended-toggle').innerText(),
      /Encerrados · 1/
    )
    await popover().getByTestId('schedules-ended-toggle').click()
    assert.match(
      await popover().getByTestId('schedule-ended').first().innerText(),
      /sch-k2m8p[\s\S]*cancelado: o app foi fechado · 2 execuções/
    )
    assert.match(await popover().innerText(), /Rodam só com o ClearChat aberto/)
    await shot('02-popover')
  })

  await step(
    'Parar → vai para Encerrados (parado pelo usuário); chip "1 agendamento"',
    async () => {
      await popover().getByTestId('schedule-item').nth(1).getByTestId('schedule-stop').click()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="schedule-item"]').length === 1
      )
      assert.match(await badge().innerText(), /1 agendamento$/)
      assert.match(
        await popover().getByTestId('schedules-ended-toggle').innerText(),
        /Encerrados · 2/
      )
      assert.match(await popover().innerText(), /parado pelo usuário/)
      await shot('03-parado')
    }
  )

  await step('Limpar tira os encerrados da tela (o ativo fica)', async () => {
    await popover().getByTestId('schedules-clear').click()
    await popover().getByTestId('schedules-ended-toggle').waitFor({ state: 'detached' })
    assert.equal(await popover().getByTestId('schedule-item').count(), 1)
    await page.keyboard.press('Escape')
    await popover().waitFor({ state: 'detached' })
  })

  await step(
    'cards no chat: disparos com a saída, o com erro, aviso de cancelamento, tool schedule',
    async () => {
      const fires = page.getByTestId('schedule-fire')
      assert.equal(await fires.count(), 2)
      const f1 = await fires.nth(0).innerText()
      assert.match(f1, /Agendamento Checar o build · execução 1 de 12/)
      assert.match(f1, /Se falhar, me diga qual teste quebrou\./)
      assert.match(f1, /shell "npm test -- --reporter=dot"\s*· ok/)
      assert.match(f1, /26 passing/)
      const f2 = await fires.nth(1).innerText()
      assert.match(f2, /execução 2 de 12/)
      assert.match(f2, /\s· erro/)
      assert.match(f2, /1 failing/)
      const notice = await page.getByTestId('schedule-notice').innerText()
      assert.match(notice, /Agendamento cancelado — o app foi fechado/)
      assert.match(notice, /sch-k2m8p process_logs "p1"/)
      await page.getByTestId('schedule-notice').scrollIntoViewIfNeeded()
      await shot('04-aviso-cancelamento')
      await fires.nth(1).scrollIntoViewIfNeeded()
      await fires.nth(1).locator('[role="button"]').first().click()
      await shot('05-disparo-com-erro-aberto')
      // card da tool schedule (cabeçalho: "Agendar" + quando · o quê)
      await page
        .getByText(/a cada 10 min, 12 vezes · shell "npm test -- --reporter=dot" \+ lembrete/)
        .first()
        .waitFor()
    }
  )

  await step('aprovação do schedule: quando, lembrete, aviso → Permitir', async () => {
    await openChat('Lembrete da reunião')
    const card = page.getByTestId('approval-card')
    await card.waitFor()
    const t = await card.innerText()
    assert.match(t, /Permitir que o agente agende isto\?/)
    assert.match(t, /Uma vez, em \d{4}-\d{2}-\d{2} 15:50 \(UTC[+-]\d+\)/)
    assert.match(t, /Reunião com o time em 10 min \(sala 3\)\./)
    assert.match(t, /Roda sozinho enquanto o ClearChat estiver aberto/)
    await shot('06-aprovacao')
    await card.getByRole('button', { name: 'Permitir' }).click()
    await card.waitFor({ state: 'detached' })
  })

  await step(
    'Configurações → Aprovações: item "Criar agendamento" (padrão Perguntar)',
    async () => {
      await page.getByRole('button', { name: /^Configurações/ }).click()
      const dlg = page.locator('[role="dialog"]')
      await dlg.getByRole('button', { name: 'Aprovações', exact: true }).click()
      const row = dlg.getByText('Criar agendamento', { exact: true })
      await row.scrollIntoViewIfNeeded()
      await row.waitFor()
      await dlg
        .getByTestId('global-mode-schedule')
        .getByRole('radio', { name: /Perguntar/, checked: true })
        .waitFor()
      await shot('07-aprovacoes')
      await page.keyboard.press('Escape')
    }
  )

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
