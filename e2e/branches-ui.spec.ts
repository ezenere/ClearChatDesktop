/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E das VERSÕES de mensagens (ramos) contra o MOCK de UI (Playwright + `e2e/launch.ts`, sem backend,
// sem key): builda o renderer com VITE_CLEAR_MOCK=1 numa pasta de rascunho (não mexe em out/), abre
// `index.html?scenario=branches` numa janela Electron mínima e percorre o chat "Cache das respostas
// da API" (resposta do 1º turno regenerada: 2 versões; pergunta do 2º editada: 3 versões, a 2ª ativa):
//   ‹ i/n › (só no hover, como os outros ícones) com o i/n certo (balão do usuário e rodapé do assistente), trocar muda o caminho
//   mostrado (botões e ←/→ com o grupo em foco) e mantém o ‹ › no mesmo lugar da tela; "Regenerar
//   resposta" em todos os turnos; editar → "Enviar" (desabilitado sem mudança) cria uma nova versão;
//   regenerar um turno anterior cria uma versão da resposta; tudo desabilitado com o agente rodando
//   ("Disponível quando o agente terminar"); aviso "Atualize <dispositivo>…" (+ dispensar).
// Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-branches-e2e node e2e/branches-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-branches-e2e'))
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
        .slice(0, process.env.E2E_VERBOSE ? 30 : 3)
        .join('\n')}`
    )
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
      await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

const scroller = (): ReturnType<Page['locator']> => page.getByTestId('chat-scroller')
const switchers = (): ReturnType<Page['locator']> => scroller().getByTestId('branch-switcher')
/** Bloco da (primeira) mensagem com `text` (balão do usuário ou resposta). */
const msgBlock = (text: string): ReturnType<Page['locator']> =>
  scroller().locator('div.group\\/msg').filter({ hasText: text }).first()
const labels = async (): Promise<string[]> =>
  switchers().evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))

async function waitIdle(): Promise<void> {
  await page.waitForFunction(() => {
    const st = (window as any).__clearStore.getState()
    return st.sessions.sbr?.status === 'idle'
  })
}

/** Status falso da sessão sbr (só na UI; o mock continua ocioso). */
async function fakeStatus(status: string): Promise<void> {
  // deixa chegar a resposta da troca anterior (ela traz o status real da sessão)
  await page.waitForTimeout(250)
  await page.evaluate((status) => {
    const w = window as any
    const s = w.__clearStore.getState().sessions.sbr
    w.__clearMockEmit({ type: 'session-updated', session: { ...s, status } })
  }, status)
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
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=branches' })
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
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 820)
  )

  await step('chat com versões: ‹ i/n › com o i/n certo e o caminho selecionado', async () => {
    await page.getByTestId('chat-item').filter({ hasText: 'Cache das respostas da API' }).click()
    await switchers().first().waitFor()
    assert.deepEqual(await labels(), ['Versão 2 de 2', 'Versão 2 de 3'])
    // assistente: ‹ › no rodapé da resposta regenerada; usuário: no rodapé do balão
    assert.equal(await msgBlock('stale-while-revalidate').getByTestId('branch-switcher').count(), 1)
    assert.equal(
      await msgBlock('Mostra um exemplo em Python.').getByTestId('branch-position').innerText(),
      '2/3'
    )
    await scroller().getByText('E como invalidar quando a chave muda?').waitFor()
    assert.equal(await scroller().getByText('Mostra um exemplo em Go.').count(), 0)
    assert.equal(await scroller().getByText('TTL curto').count(), 0)
    // como os outros ícones do rodapé: some sem o mouse, aparece no hover da mensagem
    const opacity = (): Promise<string> =>
      switchers()
        .first()
        .evaluate((e) => getComputedStyle(e).opacity)
    await page.mouse.move(2, 2)
    await page.waitForTimeout(400) // transição
    assert.equal(await opacity(), '0')
    await msgBlock('stale-while-revalidate').hover()
    await page.waitForTimeout(400)
    assert.equal(await opacity(), '1')
    await shot('01-branched-chat')
  })

  await step('"Regenerar resposta" em todos os turnos', async () => {
    const n = await scroller().getByRole('button', { name: 'Regenerar resposta' }).count()
    assert.equal(n, 3, `esperava 3 (um por turno), veio ${n}`)
    // o do 1º turno fica na resposta dele
    assert.equal(
      await msgBlock('stale-while-revalidate')
        .getByRole('button', { name: 'Regenerar resposta' })
        .count(),
      1
    )
  })

  await step('aviso de dispositivo desatualizado (+ dispensar)', async () => {
    const banner = page.getByTestId('outdated-hosts')
    await banner.waitFor()
    assert.match(
      await banner.innerText(),
      /Atualize Notebook antigo \(0\.6\.1\) para usar versões de mensagens com segurança/
    )
    await shot('02-outdated-banner')
    await banner.getByRole('button', { name: 'Dispensar' }).click()
    await banner.waitFor({ state: 'detached' })
  })

  await step('trocar (botão): o caminho muda e o ‹ › fica no mesmo lugar', async () => {
    const sw = msgBlock('Mostra um exemplo em Python.').getByTestId('branch-switcher')
    await page.waitForTimeout(400) // a pilha do composer acabou de mudar (aviso dispensado)
    const before = (await sw.boundingBox())!.y
    await sw.getByRole('button', { name: 'Próxima versão' }).click()
    await scroller().getByText('Mostra um exemplo em Go.').waitFor()
    assert.equal(await scroller().getByText('E como invalidar quando a chave muda?').count(), 0)
    const now = msgBlock('Mostra um exemplo em Go.').getByTestId('branch-switcher')
    assert.equal(await now.getAttribute('aria-label'), 'Versão 3 de 3')
    await page.waitForTimeout(400) // fim da animação de entrada das mensagens
    const after = (await now.boundingBox())!.y
    assert.ok(Math.abs(after - before) <= 2, `‹ › moveu ${after - before}px`)
    // a última versão não tem "próxima"
    assert.ok(await now.getByRole('button', { name: 'Próxima versão' }).isDisabled())
    const sel = await page.evaluate(
      () => (window as any).__clearStore.getState().sessions.sbr.branchSel
    )
    assert.deepEqual(Object.values(sel), [], 'escolher a mais nova apaga a chave')
    await shot('03-switched-to-go')
    return `Δy=${after - before}px`
  })

  await step('trocar (teclado ←/→ com o grupo em foco)', async () => {
    const sw = msgBlock('Mostra um exemplo em Go.').getByTestId('branch-switcher')
    await sw.focus()
    await page.keyboard.press('ArrowLeft')
    await scroller().getByText('Mostra um exemplo em Python.').waitFor()
    await page.keyboard.press('ArrowLeft')
    await scroller().getByText('Mostra um exemplo em TypeScript.').waitFor()
    assert.equal(
      await msgBlock('Mostra um exemplo em TypeScript.')
        .getByTestId('branch-switcher')
        .getAttribute('aria-label'),
      'Versão 1 de 3'
    )
    await page.keyboard.press('ArrowRight')
    await scroller().getByText('E como invalidar quando a chave muda?').waitFor()
  })

  await step('trocar a versão da resposta (assistente)', async () => {
    const sw = msgBlock('stale-while-revalidate').getByTestId('branch-switcher')
    await sw.getByRole('button', { name: 'Versão anterior' }).click()
    await scroller().getByText('TTL curto').waitFor()
    assert.deepEqual(await labels(), ['Versão 1 de 2'])
    assert.equal(await scroller().getByText('Mostra um exemplo em Python.').count(), 0)
    await shot('04-assistant-v1')
    await msgBlock('TTL curto')
      .getByTestId('branch-switcher')
      .getByRole('button', { name: 'Próxima versão' })
      .click()
    await scroller().getByText('Mostra um exemplo em Python.').waitFor()
    assert.deepEqual(await labels(), ['Versão 2 de 2', 'Versão 2 de 3'])
  })

  await step('desabilitado com o agente rodando', async () => {
    await fakeStatus('running')
    const sw = switchers().last()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="branch-switcher"]')?.getAttribute('aria-disabled') ===
        'true'
    )
    assert.ok(await sw.getByRole('button', { name: 'Versão anterior' }).isDisabled())
    assert.ok(await sw.getByRole('button', { name: 'Próxima versão' }).isDisabled())
    // sem regenerar nem editar enquanto roda
    assert.equal(await scroller().getByRole('button', { name: 'Regenerar resposta' }).count(), 0)
    assert.equal(await scroller().getByRole('button', { name: 'Editar' }).count(), 0)
    await sw.hover()
    const tip = page.locator('[data-radix-popper-content-wrapper]').last()
    await tip.waitFor({ timeout: 3000 })
    assert.match(await tip.innerText(), /Disponível quando o agente terminar/)
    // ←/→ também não troca
    await sw.focus()
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(200)
    assert.equal(await sw.getAttribute('aria-label'), 'Versão 2 de 3')
    await shot('05-busy-disabled')
    await fakeStatus('idle')
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="branch-switcher"]')?.hasAttribute('aria-disabled')
    )
  })

  await step('editar → "Enviar" cria uma nova versão', async () => {
    const block = msgBlock('Mostra um exemplo em Python.')
    await block.hover()
    await block.getByRole('button', { name: 'Editar' }).click()
    const editor = scroller().locator('textarea').first()
    await editor.waitFor()
    assert.match(
      await scroller().getByTestId('editor-note').innerText(),
      /Envia como nova versão — a atual continua salva \(‹ › para alternar\)/
    )
    const send = scroller().getByRole('button', { name: 'Enviar', exact: true })
    assert.ok(await send.isDisabled(), 'Enviar desabilitado sem mudança')
    await editor.fill('Mostra um exemplo em Rust.')
    assert.ok(await send.isEnabled())
    await shot('06-branch-editor')
    await editor.press('Control+Enter')
    await scroller().getByText('Mostra um exemplo em Rust.').waitFor()
    const sw = msgBlock('Mostra um exemplo em Rust.').getByTestId('branch-switcher')
    assert.equal(await sw.getAttribute('aria-label'), 'Versão 4 de 4')
    // a resposta da nova versão chega (mock) e a versão antiga continua salva
    await scroller().getByText('Resposta à nova versão').waitFor()
    await waitIdle()
    await sw.getByRole('button', { name: 'Versão anterior' }).click()
    await scroller().getByText('Mostra um exemplo em Go.').waitFor()
    await shot('07-after-edit')
  })

  await step('regenerar um turno anterior = nova versão da resposta', async () => {
    const block = msgBlock('stale-while-revalidate')
    await block.hover()
    await block.getByRole('button', { name: 'Regenerar resposta' }).click()
    await scroller().getByText('Nova versão da resposta').waitFor()
    await waitIdle()
    const sw = msgBlock('Nova versão da resposta').getByTestId('branch-switcher')
    assert.equal(await sw.getAttribute('aria-label'), 'Versão 3 de 3')
    // a anterior continua lá
    await sw.getByRole('button', { name: 'Versão anterior' }).click()
    await scroller().getByText('stale-while-revalidate').waitFor()
    await shot('08-regenerated-earlier-turn')
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
