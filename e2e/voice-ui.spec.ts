/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E contra o MOCK de UI (Playwright `_electron`, sem backend, sem chave, sem microfone) da UX de
// áudio: composer (ordem da barra e o grupo [ telefone | mic | ˅ ]), ditado (campo com o digitado +
// o ditado translúcido — "Ouvindo…" sem texto, mic roxo com texto —, sem título "Gravando"; ✓
// conclui no cursor do início com desfazer; × e Esc descartam; Enviar conclui e envia; final que
// falha ao enviar → parcial no campo com aviso; cancelar durante o "Transcrevendo…" não insere),
// falhas do microfone (salvo desconectado → padrão + aviso; permissão negada dispensável; perdido
// no meio), botões de parar distintos com o agente ocupado, chamada de voz (falha visível em toast,
// pré-checagem, barra da chamada NO LUGAR do composer em 1440/1100/900 com e sem painel — sem
// textarea, rascunho intacto ao encerrar, pílula "Chamada ativa em…" nos outros chats, aprovações e
// pergunta clicáveis acima da barra —, CTA de clipes ausentes, botão some com a chamada desligada) e Configurações (barra lateral de abas sem
// cortes; Esc na captura da tecla do PTT não fecha o modal; tecla que digita é recusada).
// Cenários do mock: `?scenario=voice-mic-missing|voice-mic-denied|voice-mic-lost|voice-call-fail|
// voice-not-ready|voice-no-espeak` (ver `dev/mockApi.ts` → binding `voice`). Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-voice-ui node e2e/voice-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-voice-ui'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''
const MOCK_FINAL = 'Olá mundo, isto é um ditado simulado pelo mock de voz.'

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

const composer = (): ReturnType<Page['locator']> =>
  page.locator('[data-testid="composer-column"] textarea')
const recording = (): ReturnType<Page['locator']> =>
  page.locator('[data-testid="voice-recording"][data-state="recording"]')
const dialog = (): ReturnType<Page['locator']> => page.locator('[role="dialog"]')

async function openAudioSettings(): Promise<void> {
  await page.getByRole('button', { name: /^Configurações/ }).click()
  await dialog().getByRole('button', { name: 'Áudio', exact: true }).click()
  await page.getByTestId('audio-settings').waitFor()
  await page.waitForTimeout(250)
}

/** Retângulos da barra da chamada e da coluna do composer (+ rolagem horizontal da página). */
function dockGeo(): Promise<{
  dock: DOMRect | null
  column: DOMRect
  pageScroll: boolean
}> {
  return page.evaluate(() => {
    const r = (sel: string): DOMRect | null =>
      document.querySelector<HTMLElement>(sel)?.getBoundingClientRect().toJSON() ?? null
    return {
      dock: r('[data-testid=voice-call-dock]'),
      column: r('[data-testid=composer-column]')!,
      pageScroll: document.documentElement.scrollWidth > window.innerWidth
    }
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
  await setSize(1440, 860)

  // ---------------- ditado ----------------

  await step(
    'composer: ordem [clip | host | </> | … | modelo | [telefone | mic | ˅] | enviar]',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      const order = await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('[data-testid=composer-toolbar]')!
        const x = (sel: string): number | null => {
          const el = bar.querySelector<HTMLElement>(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return r.width ? r.left : null
        }
        const group = bar.querySelector<HTMLElement>('[data-testid=voice-group]')!
        const kids = [...group.children].map(
          (c) =>
            (c as HTMLElement).dataset.testid ??
            (c.querySelector('[data-testid]') as HTMLElement | null)?.dataset.testid
        )
        const gr = group.getBoundingClientRect()
        return {
          mode: bar.dataset.mode,
          clip: x('[aria-label="Anexar arquivos"]'),
          model: x('[data-testid=model-pill]'),
          group: gr.left,
          groupRight: gr.right,
          send: x('[data-testid=composer-send]'),
          kids,
          groupBorder: getComputedStyle(group).borderTopWidth,
          menuLabel: group
            .querySelector('[data-testid=voice-mic-menu-button]')
            ?.getAttribute('aria-label')
        }
      })
      assert.equal(order.mode, 'normal')
      assert(order.clip !== null && order.model !== null && order.send !== null, 'itens')
      assert(order.clip < order.model, 'clip antes do modelo')
      assert(order.model < order.group, 'modelo antes do grupo de voz')
      assert(order.groupRight <= order.send, 'grupo de voz antes do enviar')
      // UM controle com três segmentos, a seta (microfone da chamada E do ditado) por último
      assert.deepEqual(order.kids, [
        'voice-call-button',
        'voice-mic-button',
        'voice-mic-menu-button'
      ])
      assert.equal(order.groupBorder, '1px')
      assert.equal(order.menuLabel, 'Microfone (ditado e chamada)')
      await page
        .getByTestId('composer-column')
        .screenshot({ path: join(SHOTS, 'composer-01-normal.png') })
      return order.kids.join(' | ')
    }
  )

  await step(
    'ditado: "Ouvindo…" translúcido depois do digitado → parcial translúcida + mic roxo; sem "Gravando"',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await composer().fill('Linha digitada\nsegunda linha')
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      const draft = page.getByTestId('voice-draft')
      await draft.waitFor()
      // nada transcrito ainda: o marcador "Ouvindo…" (itálico, translúcido) depois do digitado
      const empty = await page.evaluate(() => {
        const sp = document.querySelector<HTMLElement>('[data-testid=voice-partial]')!
        const cs = getComputedStyle(sp)
        return {
          text: document.querySelector<HTMLElement>('[data-testid=voice-draft]')!.innerText,
          kind: sp.dataset.state,
          italic: cs.fontStyle,
          color: cs.color,
          mic: document.querySelector<HTMLElement>('[data-testid=voice-recording]')!.dataset
            .hasText,
          bar: document.querySelector<HTMLElement>('[data-testid=composer-toolbar]')!.innerText
        }
      })
      assert.equal(empty.text, 'Linha digitada\nsegunda linha Ouvindo…')
      assert.equal(empty.kind, 'placeholder')
      assert.equal(empty.italic, 'italic')
      assert.match(empty.color, /rgba\(.*0\.3\d*\)|oklab|color-mix/, `cor ${empty.color}`)
      assert.equal(empty.mic, 'false')
      assert(!/Gravando/.test(await page.locator('body').innerText()), 'título "Gravando…"')
      // durante o ditado a barra só tem mic + waveform + [ × | ✓ ] + enviar
      for (const id of ['model-pill', 'voice-group', 'host-indicator'])
        assert.equal(
          await page.getByTestId('composer-toolbar').getByTestId(id).count(),
          0,
          `${id} na barra do ditado`
        )
      assert.equal(
        await page
          .getByTestId('composer-toolbar')
          .getByRole('button', { name: 'Anexar arquivos' })
          .count(),
        0
      )
      await page.getByTestId('voice-waveform').waitFor()
      await page
        .getByTestId('composer-column')
        .screenshot({ path: join(SHOTS, 'composer-02-recording-empty.png') })
      // parcial chega: translúcida, no lugar do marcador; o mic fica roxo
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>('[data-testid=voice-partial]')?.dataset.state ===
            'partial' &&
          document.querySelector('[data-testid=voice-partial]')?.textContent?.includes('Olá'),
        undefined,
        { timeout: 4000 }
      )
      const live = await page.evaluate(() => {
        const sp = document.querySelector<HTMLElement>('[data-testid=voice-partial]')!
        const typed = document.querySelector<HTMLElement>('[data-testid=voice-draft-typed]')!
        const ta = document.querySelector<HTMLTextAreaElement>(
          '[data-testid=composer-column] textarea'
        )!
        const icon = document.querySelector<HTMLElement>('[data-testid=voice-recording]')!
        return {
          italic: getComputedStyle(sp).fontStyle,
          spoken: getComputedStyle(sp).color,
          typed: getComputedStyle(typed).color,
          value: ta.value,
          hidden: getComputedStyle(ta).display,
          mic: icon.dataset.hasText,
          micColor: getComputedStyle(icon).color
        }
      })
      assert.equal(live.mic, 'true')
      assert.equal(live.micColor, 'rgb(167, 139, 250)', 'mic roxo (accent-strong) com texto')
      assert.notEqual(live.spoken, live.typed, 'ditado com a mesma cor do digitado')
      assert.equal(live.italic, 'normal')
      // a textarea (escondida) continua com SÓ o texto do usuário
      assert.equal(live.value, 'Linha digitada\nsegunda linha')
      assert.equal(live.hidden, 'none', 'textarea no lugar do campo do ditado')
      await page
        .getByTestId('composer-column')
        .screenshot({ path: join(SHOTS, 'composer-03-recording-text.png') })
      // ✓: o final entra como texto normal (na textarea) no ponto de inserção, sem enviar
      await page.getByTestId('voice-finish-button').click()
      const want = `Linha digitada\nsegunda linha ${MOCK_FINAL}`
      await page.waitForFunction(
        (w) =>
          (document.querySelector('[data-testid=composer-column] textarea') as HTMLTextAreaElement)
            ?.value === w,
        want,
        { timeout: 5000 }
      )
      await page.getByTestId('voice-draft').waitFor({ state: 'detached' })
      assert.equal(
        await page.getByTestId('composer-toolbar').getAttribute('data-mode'),
        'normal',
        'barra volta ao normal'
      )
      await page.getByTestId('voice-live').waitFor({ state: 'attached' })
      assert.equal(await page.getByTestId('voice-live').innerText(), 'Transcrição pronta')
      await page
        .getByTestId('composer-column')
        .screenshot({ path: join(SHOTS, 'composer-04-after-finish.png') })
      return `${empty.color} → ${live.spoken} (digitado ${live.typed}) · mic ${live.micColor}`
    }
  )

  await step('ditado: × e Esc descartam o ditado (o campo volta como estava)', async () => {
    await open('chat', 'Ideias de nomes para o app')
    await composer().fill('fica assim')
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    await page.waitForFunction(
      () => document.querySelector('[data-testid=voice-partial]')?.textContent?.includes('Olá'),
      undefined,
      { timeout: 4000 }
    )
    await page.getByTestId('voice-cancel-button').click()
    await page.getByTestId('voice-draft').waitFor({ state: 'detached', timeout: 3000 })
    await page.waitForTimeout(1000)
    assert.equal(await composer().inputValue(), 'fica assim')
    // Esc (o foco vai para o campo do ditado ao começar)
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? ''
    )
    assert.equal(focused, 'voice-draft', 'foco no campo do ditado')
    await page.keyboard.press('Escape')
    await page.getByTestId('voice-draft').waitFor({ state: 'detached', timeout: 3000 })
    await page.waitForTimeout(1000)
    assert.equal(await composer().inputValue(), 'fica assim')
    const back = await composer().evaluate((el) => document.activeElement === el)
    assert(back, 'foco volta à textarea')
    return 'rascunho intacto (× e Esc)'
  })

  await step('ditado: Enviar durante a gravação conclui e envia digitado + final', async () => {
    await open('chat', 'Script de backup')
    await composer().fill('Resumo:')
    const before = await page.locator('[data-role=user], [data-testid=user-message]').count()
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    await page.waitForFunction(
      () => document.querySelector('[data-testid=voice-partial]')?.textContent?.includes('Olá'),
      undefined,
      { timeout: 4000 }
    )
    await page.getByTestId('composer-send').click()
    // esperando a final: o enviar mostra que está concluindo (não envia a parcial)
    await page.locator('[data-testid=composer-send][data-waiting=true]').waitFor({ timeout: 1500 })
    const want = `Resumo: ${MOCK_FINAL}`
    await page.waitForFunction(
      (w) => document.querySelector('[data-testid=chat-scroller]')?.textContent?.includes(w),
      want,
      { timeout: 6000 }
    )
    await page.getByTestId('voice-draft').waitFor({ state: 'detached' })
    assert.equal(await composer().inputValue(), '', 'campo limpo depois de enviar')
    const after = await page.locator('[data-role=user], [data-testid=user-message]').count()
    return `enviado "${want.slice(0, 40)}…" (${before} → ${after} msgs do usuário)`
  })

  await step(
    'ditado: Enviar com a final falhando → parcial no campo com aviso, nada enviado',
    async () => {
      await open('chat', 'Script de backup')
      await composer().fill('Nota:')
      await page.evaluate(() => {
        ;(window as any).__clearMockSttFinal = 'fail'
      })
      try {
        await page.getByTestId('voice-mic-button').click()
        await recording().waitFor()
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid=voice-partial]')
              ?.textContent?.includes('Olá mundo'),
          undefined,
          { timeout: 4000 }
        )
        const sent0 = await page.getByTestId('chat-scroller').innerText()
        await page.getByTestId('composer-send').click()
        await page.getByTestId('voice-send-note').waitFor({ timeout: 5000 })
        assert.match(
          await page.getByTestId('voice-send-note').innerText(),
          /final falhou — o texto parcial entrou no campo/
        )
        const value = await composer().inputValue()
        assert.match(value, /^Nota: Olá mundo/)
        const sent1 = await page.getByTestId('chat-scroller').innerText()
        assert(!sent1.includes('Nota: Olá'), 'a parcial foi enviada sozinha')
        assert.equal(sent0.length > 0, true)
        await composer().fill('')
        await page.getByRole('button', { name: 'Dispensar aviso do ditado' }).click()
        return value
      } finally {
        await page.evaluate(() => {
          ;(window as any).__clearMockSttFinal = undefined
        })
      }
    }
  )

  await step(
    'ditado: texto final entra no cursor do início do ditado e Ctrl+Z desfaz',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await composer().fill('Início fim')
      // cursor depois de "Início " (o clique no mic tira o foco, a seleção fica)
      await composer().evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7))
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      // a prévia já mostra o ditado NO cursor (entre "Início " e "fim")
      await page.waitForFunction(
        () =>
          /^Início Olá.* fim$/.test(
            document.querySelector<HTMLElement>('[data-testid=voice-draft]')?.innerText ?? ''
          ),
        undefined,
        { timeout: 4000 }
      )
      await page.getByTestId('voice-finish-button').click()
      const want = `Início ${MOCK_FINAL} fim`
      await page.waitForFunction(
        (w) =>
          (document.querySelector('[data-testid=composer-column] textarea') as HTMLTextAreaElement)
            ?.value === w,
        want,
        { timeout: 5000 }
      )
      await composer().focus()
      await page.keyboard.press('ControlOrMeta+z')
      await page.waitForTimeout(150)
      const undone = await composer().inputValue()
      assert.equal(undone, 'Início fim', `desfazer remove a inserção do ditado ("${undone}")`)
      return `"${want}" → Ctrl+Z → "${undone}"`
    }
  )

  await step('ditado: Cancelar durante o "Transcrevendo…" NÃO insere o texto', async () => {
    await open('chat', 'Ideias de nomes para o app')
    await composer().fill('abc')
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    await page.waitForTimeout(400)
    await page.getByTestId('voice-finish-button').click()
    // o mock leva ~700 ms para devolver a final: cancela no meio
    await page.getByTestId('voice-finish-button').and(page.locator('[disabled]')).waitFor()
    await page.getByTestId('voice-cancel-button').click()
    await page.getByTestId('voice-cancel-button').waitFor({ state: 'detached', timeout: 3000 })
    await page.waitForTimeout(1200)
    assert.equal(await composer().inputValue(), 'abc')
    return 'rascunho intacto'
  })

  await step('agente ocupado + ditado: "Parar o agente" e [ × | ✓ ] são distintos', async () => {
    await open('chat', 'Refatorar o parser de SSE')
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    const agent = page.getByTestId('agent-stop-button')
    const fin = page.getByTestId('voice-finish-button')
    await agent.waitFor()
    await fin.waitFor()
    const a = await agent.evaluate((el) => ({
      label: el.getAttribute('aria-label'),
      icon: el.querySelector('svg')?.getAttribute('class') ?? ''
    }))
    const f = await fin.evaluate((el) => ({
      label: el.getAttribute('aria-label'),
      icon: el.querySelector('svg')?.getAttribute('class') ?? ''
    }))
    assert.equal(a.label, 'Parar o agente')
    assert.equal(f.label, 'Concluir transcrição')
    assert.match(a.icon, /lucide-square/)
    assert.match(f.icon, /lucide-check/)
    assert.equal(
      await page.getByTestId('composer-send').getAttribute('aria-label'),
      'Concluir e adicionar à fila'
    )
    await page
      .getByTestId('composer-toolbar')
      .screenshot({ path: join(SHOTS, 'after-stop-buttons.png') })
    await page.getByTestId('voice-cancel-button').click()
    return `${a.label} × ${f.label}`
  })

  // ---------------- falhas do microfone ----------------

  await step(
    'microfone salvo desconectado: grava no padrão e avisa uma vez; menu marca o ausente',
    async () => {
      await open('voice-mic-missing', 'Ideias de nomes para o app')
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      const notice = page.getByTestId('voice-notice')
      await notice.waitFor()
      assert.match(await notice.innerText(), /Microfone salvo não encontrado — usando o padrão/)
      await shot('after-mic-missing-notice')
      await page.getByTestId('voice-cancel-button').click()
      await page.getByTestId('voice-mic-menu-button').click()
      await page.getByTestId('voice-mic-menu').waitFor()
      await page.waitForTimeout(600)
      const missing = await page.getByTestId('voice-mic-option-missing').count()
      const expanded = await page.getByTestId('voice-mic-menu-button').getAttribute('aria-expanded')
      assert.equal(expanded, 'true')
      const radios = await page.locator('[data-testid=voice-mic-menu] [role=menuitemradio]').count()
      assert(radios >= 1, 'itens menuitemradio')
      await page.keyboard.press('Escape')
      await page.getByTestId('voice-mic-menu').waitFor({ state: 'detached' })
      return `aviso ok · item "desconectado" no menu: ${missing ? 'sim' : 'não (lista sem deviceIds)'}`
    }
  )

  await step(
    'permissão negada: erro legível e dispensável (X limpa o erro da captura)',
    async () => {
      await open('voice-mic-denied', 'Ideias de nomes para o app')
      await page.getByTestId('voice-mic-button').click()
      const err = page.getByTestId('voice-error')
      await err.waitFor()
      assert.match(await err.innerText(), /Permissão de microfone negada/)
      await err.getByRole('button', { name: 'Dispensar erro de voz' }).click()
      await err.waitFor({ state: 'detached' })
    }
  )

  await step('microfone perdido no meio da gravação: aviso visível', async () => {
    await open('voice-mic-lost', 'Ideias de nomes para o app')
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    const notice = page.getByTestId('voice-notice')
    await notice.waitFor({ timeout: 4000 })
    assert.match(await notice.innerText(), /desconectado durante a gravação/)
  })

  // ---------------- chamada de voz ----------------

  await step(
    'chamada: falha ao iniciar aparece (toast) e a pré-checagem aponta o que falta',
    async () => {
      await open('voice-call-fail', 'Ideias de nomes para o app')
      await page.getByTestId('voice-call-button').click()
      const toast = page.getByTestId('toast').filter({ hasText: 'espeak-ng' })
      await toast.waitFor({ timeout: 4000 })
      assert.equal(await page.getByTestId('voice-call-dock').count(), 0)
      await shot('after-call-start-failure')
      await open('voice-not-ready', 'Ideias de nomes para o app')
      await page.getByTestId('voice-call-button').click()
      const t2 = page.getByTestId('toast').filter({ hasText: 'Chamada de voz indisponível' })
      await t2.waitFor({ timeout: 4000 })
      const txt = await t2.innerText()
      assert.match(txt, /Transcrição: escolha um modelo de transcrição em Configurações → Áudio/)
      assert.match(txt, /Kokoro/)
      // runtime local quebrado (espeak-ng ausente — probe `voice.runtime.status`)
      await open('voice-no-espeak', 'Ideias de nomes para o app')
      await page.getByTestId('voice-call-button').click()
      const t3 = page.getByTestId('toast').filter({ hasText: 'espeak-ng não encontrado' })
      await t3.waitFor({ timeout: 4000 })
      assert.equal(await page.getByTestId('voice-call-dock').count(), 0)
      // Configurações → Áudio mostra o motivo do motor local não estar pronto
      await openAudioSettings()
      const warn = page.getByTestId('tts-runtime-warning')
      await warn.waitFor({ timeout: 3000 })
      assert.match(await warn.innerText(), /espeak-ng não encontrado/)
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      return txt.replace(/\s+/g, ' ').slice(0, 140)
    }
  )

  await step('chamada: microfone negado encerra a chamada COM aviso (toast)', async () => {
    await open('voice-mic-denied', 'Ideias de nomes para o app')
    await page.getByTestId('voice-call-button').click()
    const toast = page.getByTestId('toast').filter({ hasText: 'Chamada de voz encerrada' })
    await toast.waitFor({ timeout: 4000 })
    assert.match(await toast.innerText(), /Permissão de microfone negada/)
    await page.getByTestId('voice-call-dock').waitFor({ state: 'detached', timeout: 3000 })
  })

  await step(
    'chamada: barra NO LUGAR do composer (sem textarea) em 1440/1100/900 ± painel; rascunho volta',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await composer().fill('rascunho guardado')
      await page.getByTestId('voice-call-button').click()
      await page.getByTestId('voice-call-dock').waitFor()
      // texto, anexos, mic, toolbar (pílula do modelo, enviar) somem durante a chamada
      assert.equal(await composer().count(), 0, 'textarea visível durante a chamada')
      assert.equal(await page.getByTestId('composer-toolbar').count(), 0, 'toolbar visível')
      assert.equal(await page.getByTestId('voice-mic-button').count(), 0, 'mic visível')
      const out: string[] = []
      for (const [w, h] of [
        [1440, 860],
        [1100, 800],
        [900, 760]
      ] as const) {
        await setSize(w, h)
        for (const p of [false, true]) {
          await panel(p)
          const g = await dockGeo()
          assert(g.dock, `barra ausente em ${w} painel=${p}`)
          // mesma largura e posição do card do composer: ocupa a coluna e fica no rodapé dela
          assert(
            Math.abs(g.dock.left - g.column.left) <= 1 &&
              Math.abs(g.dock.right - g.column.right) <= 1,
            `barra fora da largura da coluna em ${w} painel=${p}`
          )
          assert(Math.abs(g.dock.bottom - g.column.bottom) <= 1, `barra não está no rodapé em ${w}`)
          assert(!g.pageScroll, `página rola em ${w}`)
          out.push(`${w}${p ? '+painel' : ''}`)
          if (!p && (w === 1440 || w === 900)) await shot(`after-call-bar-${w}`)
        }
      }
      await panel(false)
      await setSize(1440, 860)
      // outro chat: composer normal + pílula que leva de volta à chamada
      await page.getByTestId('chat-item').filter({ hasText: 'Script de backup' }).first().click()
      await page.waitForTimeout(400)
      await composer().waitFor()
      const pill = page.getByTestId('voice-call-elsewhere')
      await pill.waitFor()
      assert.match(await pill.innerText(), /Chamada ativa em .*Ideias de nomes/)
      await shot('after-call-elsewhere-pill')
      await pill.click()
      await page.getByTestId('voice-call-dock').waitFor()
      assert.equal(await composer().count(), 0)
      return out.join(' · ')
    }
  )

  await step('chamada: sem clipes → aviso com "Gerar clipes" (some depois de gerar)', async () => {
    const hint = page.getByTestId('voice-call-clips-hint')
    await hint.waitFor()
    await page.getByTestId('voice-call-clips-generate').click()
    await hint.waitFor({ state: 'detached', timeout: 6000 })
    await page.getByTestId('voice-call-end').click()
    await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
    // fim da chamada: composer de volta com o rascunho intacto e o foco no texto
    await composer().waitFor()
    assert.equal(await composer().inputValue(), 'rascunho guardado')
    const focused = await composer().evaluate((el) => document.activeElement === el)
    assert(focused, 'foco não voltou ao composer')
  })

  await step(
    'chamada: aprovações e pergunta (ask_user) continuam clicáveis acima da barra',
    async () => {
      // aprovações: chat c1 tem aprovações pendentes (fila de aprovação acima do composer)
      await open('chat', 'Refatorar o parser de SSE')
      await page.getByTestId('voice-call-button').click()
      await page.getByTestId('voice-call-dock').waitFor()
      const queue = page.getByTestId('approval-queue')
      const hasQueue = (await queue.count()) > 0
      if (hasQueue) {
        const q = await queue.boundingBox()
        const d = await page.getByTestId('voice-call-dock').boundingBox()
        assert(q && d && q.y + q.height <= d.y + 1, 'aprovações não ficam acima da barra')
      }
      await page.getByTestId('voice-call-end').click()
      await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
      // pergunta pendente que chega durante a chamada: card acima da barra, opções clicáveis
      await open('question', 'Ideias de nomes para o app')
      await page.evaluate(`window.__clearStore.getState().startVoiceCall('s2')`)
      await page.getByTestId('voice-call-dock').waitFor()
      await page.getByTestId('voice-call-blocking-card').waitFor()
      await page.getByTestId('ask-option').first().click()
      await shot('after-call-with-question')
      await page.getByTestId('voice-call-end').click()
      await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
      return `aprovações acima: ${hasQueue ? 'sim' : 'sem fila neste mock'} · pergunta clicável`
    }
  )

  // ---------------- Configurações → Áudio ----------------

  await step(
    'Configurações: barra lateral de abas sem cortes nem rolagem (1440 e 1100)',
    async () => {
      const out: string[] = []
      for (const [w, h] of [
        [1440, 860],
        [1100, 800]
      ] as const) {
        await setSize(w, h)
        await openAudioSettings()
        const g = await page.getByTestId('settings-nav').evaluate((el) => {
          const box = el.getBoundingClientRect()
          const btns = [...el.querySelectorAll('button')]
          return {
            scroll: el.scrollWidth > el.clientWidth + 1,
            outside: btns.filter((b) => {
              const r = b.getBoundingClientRect()
              return r.right > box.right + 1 || r.left < box.left - 1
            }).length,
            // rótulo inteiro (sem reticências)
            cut: btns.filter((b) =>
              [...b.querySelectorAll('span')].some((s) => s.scrollWidth > s.clientWidth + 1)
            ).length,
            labels: btns.map((b) => b.getAttribute('aria-label')),
            active: btns
              .filter((b) => b.getAttribute('aria-current') === 'page')
              .map((b) => b.getAttribute('aria-label'))
          }
        })
        assert(!g.scroll, `rolagem horizontal em ${w}`)
        assert.equal(g.outside, 0, `aba cortada em ${w}`)
        assert.equal(g.cut, 0, `rótulo com reticências em ${w}`)
        assert(g.labels.includes('Áudio'), 'rótulo "Áudio"')
        assert.deepEqual(g.active, ['Áudio'])
        if (w === 1440) {
          await page
            .getByTestId('settings-sidebar')
            .screenshot({ path: join(SHOTS, 'after-tabbar.png') })
          await shot('after-settings-audio')
        }
        await page.keyboard.press('Escape')
        await dialog().waitFor({ state: 'detached' })
        out.push(`${w}: ${g.labels.length} abas`)
      }
      return out.join(' · ')
    }
  )

  await step(
    'Configurações → Áudio: Esc na captura da tecla do PTT NÃO fecha o modal',
    async () => {
      await openAudioSettings()
      const cap = page.getByTestId('ptt-key-capture')
      // sem tecla: push-to-talk aparece inativo
      await page.getByTestId('ptt-inactive-hint').waitFor()
      await cap.click()
      assert.match(await cap.innerText(), /Pressione a tecla/)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      assert(await dialog().isVisible(), 'o modal fechou com o Esc da captura')
      assert.equal(await cap.innerText(), 'Definir tecla')
      // tecla que digita é recusada (com o motivo) e a captura continua
      await cap.click()
      await page.keyboard.press('k')
      await page.getByTestId('ptt-key-problem').waitFor()
      assert.match(await cap.innerText(), /Pressione a tecla/)
      await page.keyboard.press('F8')
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid=ptt-key-capture]')?.textContent === 'Alterar tecla'
      )
      assert.equal(await page.getByTestId('ptt-inactive-hint').count(), 0)
      // segundo Esc (sem captura) fecha o modal normalmente
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      return 'Esc → só a captura; "k" recusada; F8 salva'
    }
  )

  // ---------------- correções de uso real (callfix) ----------------

  await step(
    'ditado: ao concluir, o texto já transcrito continua visível (translúcido) até a final',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await composer().fill('')
      await page.getByTestId('voice-mic-button').click()
      await recording().waitFor()
      await page.waitForFunction(
        () => document.querySelector('[data-testid=voice-partial]')?.textContent?.includes('Olá'),
        undefined,
        { timeout: 4000 }
      )
      await page.getByTestId('voice-finish-button').click()
      // o mock leva ~700 ms para a final: nesse meio a parcial NÃO some
      await page
        .locator('[data-testid=voice-partial][data-state=finalizing]')
        .waitFor({ timeout: 1500 })
      const ghost = await page.getByTestId('voice-partial').innerText()
      assert(ghost.includes('Olá'), `parcial sumiu ao parar: "${ghost}"`)
      assert(!/Transcrevendo/.test(ghost), 'mostrou "Transcrevendo…" no lugar do texto')
      await shot('after-dictation-finalizing')
      await page.waitForFunction(
        (t) =>
          (
            document.querySelector(
              '[data-testid="composer-column"] textarea'
            ) as HTMLTextAreaElement
          )?.value.includes(t),
        MOCK_FINAL,
        { timeout: 4000 }
      )
      await page.getByTestId('voice-partial').waitFor({ state: 'detached', timeout: 2000 })
      return 'parcial translúcida (finalizando) → final no lugar'
    }
  )

  await step('chamada: transcrição ao vivo do usuário na barra (parcial → final)', async () => {
    await open('chat', 'Ideias de nomes para o app')
    await page.getByTestId('voice-call-button').click()
    await page.getByTestId('voice-call-dock').waitFor()
    await page.evaluate(() =>
      (window as any).__clearVoiceRuntime.setState({
        live: { text: 'eu queria saber se dá pra mudar o tema', state: 'partial' }
      })
    )
    const live = page.getByTestId('voice-call-live')
    await live.waitFor()
    assert.equal(await live.getAttribute('data-state'), 'partial')
    assert.match(await live.innerText(), /mudar o tema/)
    await page.evaluate(() =>
      (window as any).__clearVoiceRuntime.setState({
        live: { text: 'Eu queria saber se dá pra mudar o tema do aplicativo.', state: 'final' }
      })
    )
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid=voice-call-live]')?.getAttribute('data-state') ===
        'final'
    )
    await shot('after-call-live-transcript')
    return 'voice-call-live na linha 1 da barra'
  })

  await step(
    'chamada: painel → "Modelo da chamada" (opcional) com raciocínio auto e parâmetros',
    async () => {
      // continua na chamada do passo anterior
      await page.getByTestId('voice-call-panel-toggle').click()
      await page.getByTestId('voice-call-panel').waitFor()
      await page.getByTestId('voice-call-panel-model').locator('summary').click()
      const ed = page.getByTestId('voice-call-model-call')
      await ed.waitFor()
      await ed.getByTestId('voice-call-model-inherit-call').waitFor()
      await ed.getByTestId('model-picker').click()
      const opt = page
        .getByRole('listbox', { name: 'Modelos' })
        .locator('[role=option][data-model]')
        .first()
      await opt.waitFor({ timeout: 8000 })
      const picked = await opt.getAttribute('data-model')
      await opt.click()
      await ed.getByTestId('voice-call-model-clear-call').waitFor()
      // o chat salvo ganhou o override (voice.model) — só a chamada usa
      const voice = await page.evaluate(() => {
        const st = (window as any).__clearStore.getState()
        return st.chats.find((c: any) => c.id === st.voiceCall.chatId)?.config.voice
      })
      assert.equal(voice?.model?.model, picked)
      await shot('after-call-panel-model')
      await ed.getByTestId('voice-call-model-clear-call').click()
      await ed.getByTestId('voice-call-model-inherit-call').waitFor()
      await page.getByTestId('voice-call-end').click()
      await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
      return `modelo da chamada: ${picked} → herdar`
    }
  )

  await step('chamada: sem violação de CSP ao tocar a fala (WAV por blob)', async () => {
    const violations: string[] = []
    const onConsole = (m: { text(): string }): void => {
      if (/Content Security Policy|media-src/i.test(m.text())) violations.push(m.text())
    }
    page.on('console', onConsole)
    await open('chat', 'Ideias de nomes para o app')
    await page.evaluate(() => {
      ;(window as any).__csp = []
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`)
      )
    })
    await page.getByTestId('voice-call-button').click()
    await page.getByTestId('voice-call-dock').waitFor()
    // turno simulado: o mock fala 2 utterances WAV (DomAudioPlayer → blob:)
    await page.evaluate(() => (window as any).__clearMockApi.voice.call.turn({ text: 'oi' }))
    await page.waitForTimeout(3200)
    const csp = await page.evaluate(() => (window as any).__csp as string[])
    page.off('console', onConsole)
    await page.getByTestId('voice-call-end').click()
    await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
    assert.deepEqual([...csp, ...violations], [], 'violação de CSP ao tocar áudio')
    return 'blob: liberado em media-src'
  })

  await step(
    'chamada: falha da API de voz encerra a chamada com o motivo e o composer volta',
    async () => {
      await open('voice-call-api-error', 'Ideias de nomes para o app')
      await composer().fill('rascunho guardado')
      await page.getByTestId('voice-call-button').click()
      await page.getByTestId('voice-call-dock').waitFor()
      await page.getByTestId('voice-call-dock').waitFor({ state: 'detached', timeout: 5000 })
      await page
        .getByText(/Chamada encerrada: créditos da ElevenLabs esgotados/)
        .waitFor({ timeout: 3000 })
      assert.equal(await composer().inputValue(), 'rascunho guardado', 'rascunho intacto')
      await shot('after-call-api-error')
      return 'toast "Chamada encerrada: …" + composer com o rascunho'
    }
  )

  await step(
    'persona: chamada desligada + modo do prompt no editor; chat da persona → telefone desabilitado com o motivo',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      // painel do chat: aba própria "Voz" (modelo da chamada + prompt do modo voz visíveis)
      await panel(true)
      await page.getByTestId('right-panel').getByRole('tab', { name: 'Voz' }).click()
      await page.getByTestId('right-panel').getByTestId('voice-call-enabled').waitFor()
      await page.getByTestId('right-panel').getByTestId('voice-call-model-chat').waitFor()
      await panel(false)
      await page.getByRole('button', { name: /^Configurações/ }).click()
      await dialog().getByRole('button', { name: 'Personas', exact: true }).click()
      const row = dialog().getByTestId('preset-row').filter({ hasText: 'Revisor de código' })
      await row.getByRole('button', { name: /Editar/ }).click()
      await dialog().getByTestId('preset-editor').waitFor()
      // aba própria "Voz" no editor de personas (seção aberta por padrão)
      await dialog().getByRole('tab', { name: 'Voz' }).click()
      await dialog().getByTestId('voice-call-enabled').waitFor()
      await dialog().getByTestId('voice-call-model-persona').waitFor()
      await dialog().getByTestId('voice-call-prompt-mode').waitFor()
      // modo do prompt (com a chamada ligada) e depois desligar a chamada nesta persona
      const modes = dialog().getByTestId('voice-call-prompt-mode')
      await modes.locator('[data-value=replace]').click()
      assert.equal(await modes.getAttribute('data-effective'), 'replace')
      await dialog().getByTestId('voice-call-enabled').locator('[data-value=off]').click()
      await dialog().getByTestId('voice-call-disabled-note').waitFor()
      await shot('after-persona-voice-off')
      await dialog().getByRole('button', { name: 'Salvar persona' }).click()
      await page.waitForTimeout(300)
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      // o chat atual passa a vir desta persona (presetId) e herda (voice.enabled null)
      const presetId = await page.evaluate(() => {
        const st = (window as any).__clearStore.getState()
        const p = st.presets.find((x: any) => x.name === 'Revisor de código')
        const chat =
          st.chats.find((c: any) => c.id === st.activeChatId) ??
          st.chats.find((c: any) => c.title === 'Ideias de nomes para o app')
        st.patchConfig(chat.id, {
          presetId: p.id,
          voice: { ...(chat.config.voice ?? {}), enabled: null }
        })
        return p.id
      })
      const btn = page.getByTestId('voice-call-button')
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid=voice-call-button]')?.getAttribute('data-off') ===
          'persona'
      )
      assert(await btn.isDisabled(), 'telefone habilitado com a persona desligando a chamada')
      // override do chat religa
      await page.evaluate(() => {
        const st = (window as any).__clearStore.getState()
        const chat = st.chats.find((c: any) => c.title === 'Ideias de nomes para o app')
        st.patchConfig(chat.id, { voice: { ...(chat.config.voice ?? {}), enabled: true } })
      })
      await page.waitForFunction(
        () => !document.querySelector('[data-testid=voice-call-button]')?.hasAttribute('disabled')
      )
      return `persona ${presetId}: desligada → telefone desabilitado; chat religa`
    }
  )

  await step('chamada desligada globalmente → telefone some (e volta ao religar)', async () => {
    await open('chat', 'Ideias de nomes para o app')
    await page.getByTestId('voice-call-button').waitFor()
    await openAudioSettings()
    const sw = page.getByRole('switch', { name: 'Chamada de voz disponível' })
    await sw.click()
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'detached' })
    await page.waitForTimeout(300)
    assert.equal(await page.getByTestId('voice-call-button').count(), 0)
    await openAudioSettings()
    await page.getByRole('switch', { name: 'Chamada de voz disponível' }).click()
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'detached' })
    await page.getByTestId('voice-call-button').waitFor({ timeout: 2000 })
  })

  // ---------------- histórico da chamada (marcadores, falas, custos) ----------------

  await step(
    'histórico: marcadores de início/fim, falas em itálico com mic/alto-falante, end_call compacto, ditado discreto',
    async () => {
      await open('voice-history', 'Revisão do deploy por voz')
      const markers = page.getByTestId('call-marker')
      await markers.first().waitFor()
      assert.equal(await markers.count(), 2, 'início + fim')
      const start = page.locator('[data-testid=call-marker][data-phase=start]')
      const end = page.locator('[data-testid=call-marker][data-phase=end]')
      assert.match(await start.innerText(), /Chamada de voz · \d{2}:\d{2}/)
      const endText = await end.innerText()
      assert.match(endText, /Chamada encerrada · 4 min 12 s · pelo agente · ≈ \$0,02/)
      // falas da chamada: itálico + ícone; ditado: ícone discreto, sem itálico
      const info = await page.evaluate(() => {
        const call = [...document.querySelectorAll<HTMLElement>('[data-voice=call]')]
        const dict = [...document.querySelectorAll<HTMLElement>('[data-voice=dictation]')]
        return {
          call: call.length,
          italic: call.every((e) => getComputedStyle(e).fontStyle === 'italic'),
          dict: dict.length,
          dictItalic: dict.some((e) => getComputedStyle(e).fontStyle === 'italic'),
          badges: [...document.querySelectorAll<HTMLElement>('[data-testid=voice-badge]')].map(
            (b) => b.dataset.source
          )
        }
      })
      assert.equal(info.call, 6, '3 falas do usuário + 3 respostas faladas')
      assert(info.italic, 'falas da chamada em itálico')
      assert.equal(info.dict, 1)
      assert.equal(info.dictItalic, false, 'ditado sem itálico')
      assert.equal(info.badges.filter((b) => b === 'call').length, 6)
      assert.equal(info.badges.filter((b) => b === 'dictation').length, 1)
      // end_call: linha compacta, sem card de tool; a resposta interrompida mantém o marcador
      await page.getByTestId('end-call-line').waitFor()
      assert.match(
        await page.getByTestId('end-call-line').innerText(),
        /Chamada encerrada pelo agente · usuário se despediu/
      )
      assert.equal(await page.getByText('Encerrar chamada', { exact: true }).count(), 0)
      await page.getByText('Interrompida pelo usuário').waitFor()
      await shot('voice-history-01-chat')
      // tooltip do marcador de fim: detalhamento dos custos/tempos
      await end.locator('span.rounded-full').hover()
      const tip = page.getByTestId('call-marker-tip')
      await tip.waitFor()
      const t = await tip.innerText()
      assert.match(
        t,
        /Transcrição \(openai\/whisper-large-v3-turbo\)\s+9 requests · 14 s · \$0,0011/
      )
      assert.match(t, /118 caracteres · ≈ \$0,01 \(preço de lista\)/)
      assert.match(t, /Preâmbulos\s+grátis/)
      await shot('voice-history-02-marker-tooltip')
      await page.mouse.move(5, 5)
      // tooltip da fala: duração + modelo da transcrição
      const badge = page.getByTestId('voice-badge').first()
      await badge.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
      await badge.hover()
      await page.getByText(/Falado na chamada de voz · 3,2 s · transcrição/).waitFor()
      await shot('voice-history-03-badge-tooltip')
      await page.mouse.move(5, 5)
      return endText.replace(/\s+/g, ' ')
    }
  )

  await step('gasto: seção "Chamadas de voz" (turnos de voz fora de "Respostas")', async () => {
    await page.getByTestId('spend-button').click()
    const pop = page.getByTestId('spend-popover')
    await pop.waitFor()
    await pop.getByTestId('spend-voice').waitFor()
    const v = await pop.getByTestId('spend-voice').innerText()
    assert.match(v, /Chamadas de voz · 1 chamada · 4 min 12 s/)
    assert.match(await pop.getByTestId('spend-voice-llm').innerText(), /3 respostas\)\s+\$0,0057/)
    assert.match(await pop.getByTestId('spend-voice-stt').innerText(), /\$0,0011/)
    assert.match(await pop.getByTestId('spend-voice-tts').innerText(), /118 caracteres\s+≈ \$0,01/)
    // "Respostas" = só as 2 fora da chamada (0,0012 + 0,0024)
    assert.match(await pop.getByTestId('spend-main').innerText(), /2 chamadas\s+\$0,0036/)
    await pop.getByTestId('spend-main-voice-note').waitFor()
    // total = 0,0036 + 0,0057 + 0,0011 (a voz ≈ fica fora)
    assert.equal(await pop.getByTestId('spend-total').innerText(), '$0,01')
    await pop.screenshot({ path: join(SHOTS, 'voice-history-04-spend.png') })
    await page.keyboard.press('Escape')
    return v.replace(/\s+/g, ' ').slice(0, 120)
  })

  await step('chamada ao vivo: relógio na barra + marcadores de início/fim no chat', async () => {
    await open('chat', 'Script de backup')
    const before = await page.getByTestId('call-marker').count()
    await page.getByTestId('voice-call-button').click()
    await page.getByTestId('voice-call-dock').waitFor()
    const clock = page.getByTestId('voice-call-clock')
    await clock.waitFor()
    assert.match(await clock.innerText(), /^\d{2}:\d{2}$/)
    await page.waitForFunction(
      () => document.querySelector('[data-testid=voice-call-clock]')?.textContent === '00:02',
      undefined,
      { timeout: 5000 }
    )
    await page.locator('[data-testid=call-marker][data-phase=start]').last().waitFor()
    await page
      .getByTestId('voice-call-dock')
      .screenshot({ path: join(SHOTS, 'call-bar-clock.png') })
    await page.getByTestId('voice-call-end').click()
    await page.getByTestId('voice-call-dock').waitFor({ state: 'detached' })
    await page.locator('[data-testid=call-marker][data-phase=end]').last().waitFor()
    assert.equal(await page.getByTestId('call-marker').count(), before + 2)
    assert.match(
      await page.locator('[data-testid=call-marker][data-phase=end]').last().innerText(),
      /Chamada encerrada · \d+ s · por você/
    )
    await shot('call-live-markers')
  })

  await step('ditado enviado: mic discreto no balão (sem itálico)', async () => {
    await open('chat', 'Script de backup')
    await page.getByTestId('voice-mic-button').click()
    await recording().waitFor()
    await page.waitForFunction(
      () => document.querySelector('[data-testid=voice-partial]')?.textContent?.includes('Olá'),
      undefined,
      { timeout: 4000 }
    )
    await page.getByTestId('composer-send').click()
    await page.waitForFunction(
      (w) => document.querySelector('[data-testid=chat-scroller]')?.textContent?.includes(w),
      MOCK_FINAL,
      { timeout: 6000 }
    )
    const last = page.locator('[data-voice=dictation]').last()
    await last.waitFor()
    assert.match(await last.innerText(), /ditado simulado/)
    assert.notEqual(await last.evaluate((e) => getComputedStyle(e).fontStyle), 'italic')
    assert((await page.locator('[data-testid=voice-badge][data-source=dictation]').count()) >= 1)
    // digitado sem ditado: sem ícone
    await composer().fill('mensagem digitada sem voz')
    await page.getByTestId('composer-send').click()
    await page.getByText('mensagem digitada sem voz').waitFor()
    const typedVoice = await page
      .getByText('mensagem digitada sem voz')
      .evaluate((e) => (e as HTMLElement).dataset.voice ?? null)
    assert.equal(typedVoice, null)
    await shot('dictation-badge')
  })

  await step('Voz (chat e Configurações): "O agente pode encerrar a chamada"', async () => {
    await open('chat', 'Ideias de nomes para o app')
    await panel(true)
    await page.getByTestId('right-panel').getByRole('tab', { name: 'Voz' }).click()
    const g = page.getByTestId('right-panel').getByTestId('voice-call-end-call')
    await g.waitFor()
    assert.equal(await g.getAttribute('data-effective'), 'on', 'padrão: ligado')
    await g.locator('[data-value=off]').click()
    assert.equal(await g.getAttribute('data-effective'), 'off')
    await page
      .getByTestId('right-panel')
      .screenshot({ path: join(SHOTS, 'voice-tab-end-call.png') })
    // sem opção "herdar" separada: escolher a opção ★ (o valor herdado) volta a seguir o padrão
    await g.locator('[data-star]').click()
    assert.equal(await g.getAttribute('data-inherit'), 'true', 'override removido')
    await panel(false)
    await openAudioSettings()
    await page.getByRole('switch', { name: 'O agente pode encerrar a chamada' }).waitFor()
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'detached' })
  })

  await step(
    'Configurações → Áudio → Chamada de voz: "Frases de demora" (tempos + pools recolhidos)',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await openAudioSettings()
      const box = page.getByTestId('voice-call-delay-phrases')
      await box.scrollIntoViewIfNeeded()
      const sw = box.getByRole('switch', { name: 'Frases de demora' })
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'ligadas por padrão')
      // padrões espaçados (2026-11-12): "manter viva" após 8 s, desculpa só depois de 15 s
      assert.equal(await box.getByTestId('voice-call-keepalive-after').inputValue(), '8000')
      assert.equal(await box.getByTestId('voice-call-apology-after').inputValue(), '15000')
      const pools = box.getByTestId('voice-call-delay-pools')
      assert.equal(await pools.evaluate((d) => (d as HTMLDetailsElement).open), false, 'recolhido')
      await pools.locator('summary').click()
      const ka = box.getByTestId('voice-call-keepalive-pool')
      assert.match(await ka.inputValue(), /Só mais um instante…/)
      await ka.fill('Um segundinho só.\nJá volto.')
      await box.getByTestId('voice-call-apology-after').click() // blur salva
      await box.getByTestId('voice-call-keepalive-pool-reset').waitFor()
      await box.screenshot({ path: join(SHOTS, 'audio-delay-phrases.png') })
      await box.getByTestId('voice-call-keepalive-pool-reset').click()
      assert.match(await ka.inputValue(), /Só mais um instante…/, 'restaurado')
      await sw.click()
      assert.equal(await sw.getAttribute('aria-checked'), 'false')
      assert.equal(await box.getByTestId('voice-call-keepalive-after').count(), 0, 'tempos somem')
      await sw.click()
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
    }
  )

  await step(
    'Áudio: "Modelos locais" (sub-tela) e o atalho "Configurações → Áudio…" do microfone voltam à página principal; Kokoro salvo sem pesos aponta Modelos locais',
    async () => {
      await open('chat', 'Ideias de nomes para o app')
      await openAudioSettings()
      // o mock salva o Kokoro sem os pesos em disco: o seletor de Modelo avisa com o caminho
      const missing = page.getByTestId('tts-model-local-missing')
      await missing.scrollIntoViewIfNeeded()
      assert.match(await missing.innerText(), /instale em Modelos locais/)
      await missing.getByRole('button', { name: 'instale em Modelos locais' }).click()
      await page.getByTestId('audio-local-models').waitFor()
      assert.equal(await page.getByTestId('audio-settings').getAttribute('data-view'), 'local')
      await page.getByTestId('voice-models-kokoro').waitFor({ timeout: 4000 })
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      // o atalho do menu do microfone abre a aba na página principal
      await page.getByTestId('voice-mic-menu-button').click()
      await page.getByTestId('voice-settings-link').click()
      await page.getByTestId('audio-settings').waitFor()
      assert.equal(await page.getByTestId('audio-settings').getAttribute('data-view'), 'main')
      assert(await page.getByTestId('audio-local-models-open').isVisible())
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
    }
  )

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
