// E2E contra o MOCK de UI (Playwright `_electron`, sem backend/chave) de Configurações → Áudio,
// seções de Transcrição (STT) e Fala (TTS): SEM seletor de Provedor — um único seletor de MODELO
// (`ModelPicker`, o mesmo do chat) com um grupo por provedor cadastrado em Configurações →
// Provedores (um servidor local OpenAI-compatível cadastrado vale) + "Local (CPU)"/"Local (GPU)" só
// quando há modelo local instalado (nada instalado → nenhum grupo local); escolher uma linha grava
// provedor/modo/motor de uma vez; o híbrido é um interruptor que só aparece com modelo de API + local
// instalado; "Parâmetros" do modelo (ElevenLabs: formato de saída com a nota do plano, stability…,
// restaurar; OpenRouter: speed só onde o modelo aceita; Groq: temperatura/dica de vocabulário);
// formato fora do plano → erro legível no "Testar voz"; botão "Modelos locais" → sub-tela com
// "← Áudio" (CPU + GPU lá; nada disso na página principal); correção do id sem prefixo, VOZ no mesmo
// desenho (busca, grupos por idioma, ▶ prévia por linha, id livre pela busca), ElevenLabs direto
// (prévia publicada), "Testar voz" com sucesso (local e API — a CSP libera `media-src blob:`) e com
// erro legível, curadoria (só os modelos medidos rápidos; id livre = "não testado"; salvo lento =
// aviso com troca de um clique) e a aba sem rolagem horizontal em 1440/1100.
// Voz por persona (protocolo 1.9.0): nota "padrões deste dispositivo (não sincronizam)" no topo da
// aba; no editor da persona e na aba Voz do chat, as seções "Fala" e "Transcrição" dizem o que vale
// (própria / da persona / padrão deste dispositivo), se funciona AQUI (ou o fallback com o motivo),
// "Escolher…" abre os mesmos seletores (com "Gerar clipes desta voz" e o idioma ★) e "Voltar a usar…"
// volta a herdar.
// Cenários: `?scenario=chat|voice-not-ready|voice-alias|voice-api|voice-elevenlabs|voice-tts-fail|voice-slow-model|voice-persona|voice-persona-fallback`.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-audio-ux node e2e/audio-settings-ux.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { pickModel } from './uiHelpers.ts'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-audio-ux'))
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
const popover = (): ReturnType<Page['locator']> => page.locator('div.shadow-popover').last()

/** Abre Configurações → Áudio no cenário do mock. */
async function openAudio(scenario: string): Promise<void> {
  await page.evaluate((s) => {
    location.search = `?scenario=${s}`
  }, scenario)
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: /^Configurações/ }).waitFor()
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /^Configurações/ }).click()
  await dialog().getByRole('button', { name: 'Áudio', exact: true }).click()
  await page.getByTestId('audio-settings').waitFor()
  await page.waitForTimeout(500)
}

/** Rola a seção até o topo da área do modal (para screenshots). */
async function scrollTo(testId: string): Promise<void> {
  await page.getByTestId(testId).evaluate((e) => e.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(200)
}

type VoiceView = {
  sttSettings: { api: { params?: unknown } }
  ttsSettings: { api: { params?: unknown } }
}
/** Settings de voz gravadas no mock (`window.__clearMockApi`). */
const savedVoice = (): Promise<VoiceView> =>
  page.evaluate(() =>
    (
      window as unknown as {
        __clearMockApi: { voice: { settings: { get: () => Promise<VoiceView> } } }
      }
    ).__clearMockApi.voice.settings.get()
  )

const visible = (testId: string): Promise<boolean> => page.getByTestId(testId).first().isVisible()
const count = (testId: string): Promise<number> => page.getByTestId(testId).count()

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando ${what}`)
    await page.waitForTimeout(100)
  }
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
app.setPath('userData', ${JSON.stringify(join(BASE, 'user-data'))})
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 1000, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=chat' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  const cspErrors: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspErrors.push(m.text())
  })
  await page.waitForLoadState('domcontentloaded')

  // ---------------- um seletor só: Modelo (provedores + locais instalados) ----------------

  /** Grupos do seletor de modelo aberto (texto do cabeçalho). */
  const pickerGroups = async (testId: string): Promise<string[]> => {
    await page.getByTestId(testId).click()
    const list = page.getByRole('listbox', { name: 'Modelos' })
    await list.locator('[data-testid="model-group"]').first().waitFor({ timeout: 4000 })
    await page.waitForTimeout(300)
    const g = await list
      .locator('[data-testid="model-group"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ')))
    await page.keyboard.press('Escape')
    return g
  }

  await step(
    'sem seletor de Provedor: um seletor de Modelo com os provedores cadastrados; nada local sem instalado',
    async () => {
      await openAudio('chat')
      for (const id of [
        'stt-base-url',
        'stt-api-key',
        'stt-advanced',
        'tts-base-url',
        'tts-advanced',
        'stt-provider',
        'tts-provider'
      ])
        assert.equal(await count(id), 0, `${id} ainda na tela`)
      assert.equal(
        await page.getByRole('button', { name: 'Provedor da transcrição', exact: true }).count(),
        0,
        'seletor de Provedor da transcrição'
      )
      assert.equal(
        await page.getByRole('button', { name: 'Provedor da fala', exact: true }).count(),
        0,
        'seletor de Provedor da fala'
      )
      // a setting aponta para o Groq cadastrado: o gatilho mostra provedor · modelo
      assert.equal(await page.getByTestId('stt-model').getAttribute('data-provider-id'), 'p4')
      assert.match(
        await page.getByTestId('stt-model').innerText(),
        /Groq[\s\S]*whisper-large-v3-turbo/
      )
      await waitFor(async () => (await count('voice-catalog-count')) > 0, 3000, 'modelos do Groq')
      const groups = await pickerGroups('stt-model')
      const joined = groups.join(' | ')
      for (const want of ['OpenRouter', 'Groq'])
        assert(joined.includes(want), `${want} fora da lista: ${joined}`)
      // provedor cuja listagem veio vazia (LM Studio sem modelos de transcrição) não vira grupo
      assert(!/LM Studio/.test(joined), `grupo vazio na lista: ${joined}`)
      assert(!/Local \((CPU|GPU)\)/.test(joined), `grupo local sem nada instalado: ${joined}`)
      assert(!/ElevenLabs/.test(joined), 'ElevenLabs na transcrição (só fala)')
      assert(!/personalizado/i.test(await page.getByTestId('audio-settings').innerText()))
      // nada de modelos locais/GPU na página principal (moram em "Modelos locais")
      for (const id of [
        'stt-local-engine',
        'voice-models-kokoro',
        'voice-models-whisper.cpp',
        'gpu-mode-section'
      ])
        assert.equal(await count(id), 0, `${id} na página principal`)
      await scrollTo('stt-section')
      await shot('ux-01-model-only')
      return joined.slice(0, 200)
    }
  )

  await step(
    'sem modelo escolhido: "Escolha um modelo…"; escolher um do Groq liga a transcrição',
    async () => {
      await openAudio('voice-not-ready')
      assert.match(await page.getByTestId('stt-model').innerText(), /Escolha um modelo/)
      assert.equal(await count('stt-api-params'), 0, 'parâmetros sem modelo')
      await scrollTo('stt-section')
      await shot('ux-02-no-model')
      await pickModel(page, page.getByTestId('stt-model'), 'whisper-large-v3-turbo', {
        provider: 'Groq'
      })
      await waitFor(
        async () => (await page.getByTestId('stt-model').getAttribute('data-provider-id')) === 'p4',
        3000,
        'provedor gravado junto com o modelo'
      )
      await page.getByTestId('stt-api-params').waitFor()
      await openAudio('chat')
    }
  )

  await step(
    'STT: grupos por provedor com contagem, busca, "lento"; escolher em outro grupo troca o provedor',
    async () => {
      await pickModel(page, page.getByTestId('stt-model'), 'openai/whisper-large-v3-turbo', {
        provider: 'OpenRouter'
      })
      await page.getByTestId('stt-model').click()
      const search = page.getByRole('textbox', { name: 'Buscar modelo' })
      await search.waitFor()
      assert.equal(
        await search.getAttribute('placeholder'),
        'Buscar em todos os provedores ou digitar um ID…'
      )
      const list = page.getByRole('listbox', { name: 'Modelos' })
      await list
        .locator('[data-testid="model-group"][data-provider="Groq"]')
        .waitFor({ timeout: 4000 })
      const groups = await list
        .locator('[data-testid="model-group"]')
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ')))
      assert(
        groups.some((g) => /^OpenRouter \d+/.test(g)),
        `grupo OpenRouter: ${groups.join(' | ')}`
      )
      assert(
        groups.some((g) => /^Groq 2/.test(g)),
        `grupo Groq com contagem: ${groups.join(' | ')}`
      )
      const gemini = list.locator('[role=option][data-model="google/gemini-3.5-transcribe"]')
      await gemini.waitFor()
      assert.match(await gemini.innerText(), /lento/)
      await shot('ux-04-stt-model-picker')
      await list
        .locator('[role=option][data-provider="Groq"][data-model="whisper-large-v3"]')
        .click()
      await waitFor(
        async () => (await page.getByTestId('stt-model').getAttribute('data-provider-id')) === 'p4',
        3000,
        'provedor trocado pelo modelo'
      )
      assert.equal(
        await page.getByTestId('stt-model').getAttribute('data-value'),
        'whisper-large-v3'
      )
      return groups.join(' | ')
    }
  )

  await step(
    'STT: "Parâmetros" do Groq (temperatura e dica de vocabulário) e do OpenRouter (só temperatura)',
    async () => {
      await page.getByTestId('stt-api-params-toggle').click()
      await page.getByTestId('stt-api-params-row-temperature').waitFor()
      await page.getByTestId('stt-api-params-row-prompt').waitFor()
      assert.match(
        await page.getByTestId('stt-api-params-temperature-value').innerText(),
        /do provedor/
      )
      await page.getByTestId('stt-api-params-prompt').fill('ClearChat, OpenRouter, Kubernetes')
      await page.getByTestId('stt-api-params-prompt').press('Enter')
      await page.getByTestId('stt-api-params-count').waitFor()
      await scrollTo('stt-section')
      await shot('ux-05-stt-params-groq')
      const saved = await savedVoice()
      assert.deepEqual(saved.sttSettings.api.params, {
        openai: { prompt: 'ClearChat, OpenRouter, Kubernetes' }
      })
      await pickModel(page, page.getByTestId('stt-model'), 'openai/whisper-large-v3-turbo', {
        provider: 'OpenRouter'
      })
      await page.getByTestId('stt-api-params-row-temperature').waitFor()
      assert.equal(
        await count('stt-api-params-row-prompt'),
        0,
        'OpenRouter ignora prompt: sem controle'
      )
    }
  )

  await step(
    '"Modelos locais": botão ao lado do título → sub-tela com "← Áudio" (CPU + GPU); baixar → grupo Local (CPU) e híbrido',
    async () => {
      const btn = page.getByTestId('audio-local-models-open')
      // ao lado do título "Áudio"
      const geo = await page.evaluate(() => {
        const t = document.getElementById('settings-panel-title')!.getBoundingClientRect()
        const b = document
          .querySelector('[data-testid="audio-local-models-open"]')!
          .getBoundingClientRect()
        return { dy: Math.abs(t.top + t.height / 2 - (b.top + b.height / 2)), dx: b.left - t.right }
      })
      assert(
        geo.dy < 8 && geo.dx >= 0 && geo.dx < 40,
        `botão fora do título: ${JSON.stringify(geo)}`
      )
      assert.equal(await count('stt-hybrid-model'), 0)
      assert.equal(
        await page.getByRole('switch', { name: 'Motor local nas parciais e como reserva' }).count(),
        0,
        'híbrido sem modelo local instalado'
      )
      await btn.click()
      await page.getByTestId('audio-local-models').waitFor()
      await page.getByTestId('audio-title-crumb').waitFor()
      for (const id of [
        'local-cpu-section',
        'local-stt-models',
        'local-tts-models',
        'gpu-mode-section'
      ])
        assert(await visible(id), `${id} fora da sub-tela`)
      assert.equal(await count('stt-section'), 0, 'página principal escondida')
      assert.equal(await page.getByTestId('gpu-mode-section').getAttribute('data-expanded'), 'true')
      await shot('ux-06-local-models')
      // baixa o whisper (mock) aqui
      await page.getByTestId('voice-model-action-mock-whisper-tiny').click()
      await waitFor(
        async () =>
          /instalado/.test(await page.getByTestId('local-stt-installed').innerText()) &&
          !/nenhum/.test(await page.getByTestId('local-stt-installed').innerText()),
        8000,
        'download do mock'
      )
      await page.getByTestId('audio-local-back').click()
      await page.getByTestId('stt-section').waitFor()
      // o instalado entra no seletor como "Local (CPU)"; o híbrido aparece (modelo de API + local)
      const groups = await pickerGroups('stt-model')
      assert(
        groups.some((g) => /^Local \(CPU\) 1/.test(g)),
        `grupo local: ${groups.join(' | ')}`
      )
      assert(!groups.some((g) => /Local \(GPU\)/.test(g)), 'GPU sem whisper instalado')
      const hybrid = page.getByRole('switch', { name: 'Motor local nas parciais e como reserva' })
      await hybrid.waitFor()
      await hybrid.click()
      await page.getByTestId('stt-hybrid-model').waitFor()
      assert.match(await page.getByTestId('stt-hybrid-model').innerText(), /Whisper tiny \(mock\)/)
      await hybrid.click()
      // escolher o local grava modo local + motor + modelo de uma vez
      await page.getByTestId('stt-model').click()
      await page
        .getByRole('listbox', { name: 'Modelos' })
        .locator('[role=option][data-provider="Local (CPU)"][data-model="mock-whisper-tiny"]')
        .click()
      await page.getByTestId('stt-local').waitFor()
      assert.match(await page.getByTestId('stt-local-current').innerText(), /Whisper tiny \(mock\)/)
      assert.equal(await count('stt-api-params'), 0, 'sem parâmetros remotos no local')
      assert.equal(await hybrid.count(), 0, 'sem híbrido com modelo local escolhido')
      await scrollTo('stt-section')
      await shot('ux-07-stt-local-picked')
      await pickModel(page, page.getByTestId('stt-model'), 'whisper-large-v3-turbo', {
        provider: 'Groq'
      })
      return groups.join(' | ')
    }
  )

  await step('STT: id sem prefixo no OpenRouter é corrigido com nota visível', async () => {
    await openAudio('voice-alias')
    await page.getByTestId('stt-model-corrected').waitFor({ timeout: 3000 })
    const note = await page.getByTestId('stt-model-corrected').innerText()
    assert.match(note, /whisper-large-v3-turbo” → “openai\/whisper-large-v3-turbo/)
    assert.equal(
      await page.getByTestId('stt-model').getAttribute('data-value'),
      'openai/whisper-large-v3-turbo'
    )
    await scrollTo('stt-section')
    await shot('ux-06-stt-alias-corrected')
    return note
  })

  // ---------------- TTS ----------------

  await step(
    'TTS Local: Kokoro (catálogo só em Modelos locais); "Testar voz" toca (sem erro, sem bloqueio da CSP)',
    async () => {
      await openAudio('chat')
      assert(await visible('tts-local'), 'motor local')
      assert.equal(await count('voice-models-kokoro'), 0, 'catálogo do Kokoro na página principal')
      assert.equal(await count('tts-api'), 0)
      assert.match(await page.getByTestId('tts-model').innerText(), /Local \(CPU\)[\s\S]*Kokoro/)
      // salvo no Kokoro sem os pesos em disco: aviso com o caminho para Modelos locais
      await page.getByTestId('tts-model-local-missing').waitFor()
      await page.getByTestId('tts-test').click()
      await waitFor(
        async () => (await page.getByTestId('tts-test').getAttribute('data-state')) !== 'busy',
        4000,
        'síntese'
      )
      await page.waitForTimeout(300)
      assert.equal(await count('tts-error'), 0, 'erro no Testar voz local')
      assert.equal(cspErrors.length, 0, `CSP: ${cspErrors[0]}`)
      await scrollTo('tts-section')
      await shot('ux-07-local-tts')
    }
  )

  await step(
    'TTS API: OpenRouter pelo seletor de modelo; seletor do chat com a latência medida e só os curados',
    async () => {
      // sem atalho: provedor + modelo pelo seletor único de Modelo e a voz pelo seletor de voz
      await page.getByTestId('tts-model').click()
      await page
        .getByRole('listbox', { name: 'Modelos' })
        .locator(
          '[role=option][data-provider="OpenRouter"][data-model="elevenlabs/eleven-flash-v2.5"]'
        )
        .click()
      await page.getByTestId('tts-api').waitFor()
      await page.getByTestId('tts-voice').click()
      await page.getByTestId('tts-voice-menu').waitFor()
      await page.getByTestId('voice-option-sarah').click()
      await waitFor(
        async () =>
          (await page.getByTestId('tts-model').getAttribute('data-value')) ===
          'elevenlabs/eleven-flash-v2.5',
        3000,
        'modelo'
      )
      assert.equal(await page.getByTestId('tts-voice').getAttribute('data-value'), 'sarah')
      await waitFor(
        async () => /Sarah[\s\S]*feminina/.test(await page.getByTestId('tts-voice').innerText()),
        4000,
        'voz Sarah com badges'
      )
      await page.getByTestId('tts-model').click()
      const list = page.getByRole('listbox', { name: 'Modelos' })
      const flash = list.locator('[role=option][data-model="elevenlabs/eleven-flash-v2.5"]')
      await flash.waitFor({ timeout: 4000 })
      assert.match(await flash.innerText(), /Eleven Flash v2\.5[\s\S]*~0,5 s/)
      const ids = await list
        .locator('[role=option][data-provider="OpenRouter"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-model') ?? ''))
      assert.equal(ids[0], 'elevenlabs/eleven-flash-v2.5', 'recomendado primeiro')
      for (const ok of ['fish-audio/s1', 'microsoft/mai-voice-2.1-flash'])
        assert(ids.includes(ok), `${ok} fora da lista: ${ids.join(', ')}`)
      assert(!ids.includes('elevenlabs/eleven-v4-turbo'), 'lento na lista curada')
      await shot('ux-08-tts-model-picker')
      await page.keyboard.press('Escape')
      await scrollTo('tts-section')
      await shot('ux-09-api-tts')
      return `${ids.length} modelos: ${ids.join(', ').slice(0, 160)}`
    }
  )

  await step(
    'TTS: voz no mesmo desenho — busca, grupos por idioma, ▶ prévia, id livre',
    async () => {
      await page.getByTestId('tts-voice').click()
      await page.getByTestId('tts-voice-menu').waitFor()
      const n = await page.locator('[data-testid^=voice-option-]').count()
      assert.equal(n, 21, `vozes do ElevenLabs Flash: ${n}`)
      const first = page.locator('[data-testid^=voice-option-]').first()
      assert.equal(await first.getAttribute('data-testid'), 'voice-option-sarah')
      assert.equal(
        await page
          .getByTestId('tts-voice-group-recommended')
          .getByTestId('voice-option-sarah')
          .count(),
        1,
        'Sarah no grupo das recomendadas'
      )
      assert.match(
        await page.getByTestId('voice-option-george').innerText(),
        /George[\s\S]*masculina[\s\S]*britânico/
      )
      await shot('ux-10-tts-voices')
      // busca filtra
      await page.getByTestId('tts-voice-search').fill('george')
      assert.equal(await page.locator('[data-testid^=voice-option-]').count(), 1)
      await page.getByTestId('tts-voice-search').fill('')
      await page.getByTestId('voice-preview-george').click()
      await waitFor(
        async () =>
          (await page.getByTestId('voice-preview-george').getAttribute('data-state')) !== 'busy',
        4000,
        'prévia'
      )
      assert.equal(await count('tts-preview-error'), 0, 'erro da prévia')
      await page.getByTestId('voice-option-george').click()
      await waitFor(
        async () => (await page.getByTestId('tts-voice').getAttribute('data-value')) === 'george',
        2000,
        'voz escolhida'
      )
      // id livre pela própria busca
      await page.getByTestId('tts-voice').click()
      await page.getByTestId('tts-voice-search').fill('minha-voz-clonada')
      await page.getByTestId('tts-voice-custom-use').click()
      await waitFor(
        async () =>
          (await page.getByTestId('tts-voice').getAttribute('data-value')) === 'minha-voz-clonada',
        2000,
        'voz livre'
      )
      await page.getByTestId('tts-voice-custom-note').waitFor()
      return `${n} vozes`
    }
  )

  await step('TTS API: "Testar voz" toca e os clipes mostram a contagem da voz atual', async () => {
    await page.getByTestId('tts-test').click()
    await waitFor(
      async () => (await page.getByTestId('tts-test').getAttribute('data-state')) !== 'busy',
      4000,
      'síntese'
    )
    assert.equal(await count('tts-error'), 0)
    await page.getByTestId('tts-clips-generate').click()
    await page.getByTestId('tts-clips-count').waitFor({ timeout: 6000 })
    const t = await page.getByTestId('tts-clips-count').innerText()
    // 12 preâmbulos + 26 frases de ferramenta + 4 "obrigado por aguardar"
    assert.match(t, /42 clipes gerados para “minha-voz-clonada”/)
    return t
  })

  await step(
    'TTS: trocar de modelo ajusta a voz (pt-BR primeiro; sem vozes = padrão); id livre = "não testado"',
    async () => {
      const model = page.getByTestId('tts-model')
      await pickModel(page, model, 'microsoft/mai-voice-2.1-flash', { provider: 'OpenRouter' })
      await waitFor(
        async () =>
          (await page.getByTestId('tts-voice').getAttribute('data-value')) ===
          'pt-BR-Luana:MAI-Voice-2.1-Flash',
        3000,
        'voz pt-BR recomendada'
      )
      await page.getByTestId('tts-voice').click()
      const ids = await page
        .locator('[data-testid^=voice-option-]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
      assert.deepEqual(ids.slice(0, 3), [
        'voice-option-pt-BR-Luana:MAI-Voice-2.1-Flash',
        'voice-option-pt-BR-Caio:MAI-Voice-2.1-Flash',
        'voice-option-pt-PT-Rui:MAI-Voice-2.1-Flash'
      ])
      await shot('ux-11-tts-voices-pt-first')
      await page.keyboard.press('Escape')
      // Fish Audio não lista vozes → voz padrão do modelo
      await pickModel(page, model, 'fish-audio/s1', { provider: 'OpenRouter' })
      await waitFor(
        async () => (await page.getByTestId('tts-voice').getAttribute('data-value')) === '',
        3000,
        'voz padrão'
      )
      assert.match(await page.getByTestId('tts-voice').innerText(), /Voz padrão da API/)
      // id livre pela busca do seletor ("Usar … em OpenRouter") → aviso "não testado"
      await model.click()
      await page.getByRole('textbox', { name: 'Buscar modelo' }).fill('meu/modelo-x')
      await page
        .locator('[role=option][data-free="meu/modelo-x"][data-provider="OpenRouter"]')
        .click()
      await page.getByTestId('tts-model-untested').waitFor()
      assert.match(await page.getByTestId('tts-model-untested').innerText(), /não testado/)
      await pickModel(page, model, 'elevenlabs/eleven-flash-v2.5', { provider: 'OpenRouter' })
      assert.equal(await count('tts-model-untested'), 0)
      return ids.slice(0, 3).join(', ')
    }
  )

  await step(
    'TTS: modelo salvo lento → aviso "modelo lento para chamada" com troca de um clique',
    async () => {
      await openAudio('voice-slow-model')
      await page.getByTestId('tts-model-slow').waitFor({ timeout: 3000 })
      const t = await page.getByTestId('tts-model-slow').innerText()
      assert.match(t, /Modelo lento para chamada \(medido: ~1,0 s até o 1º áudio\)/)
      assert.equal(
        await page.getByTestId('tts-model').getAttribute('data-value'),
        'elevenlabs/eleven-v4-turbo'
      )
      assert.equal(await count('tts-model-unknown'), 0, 'aviso de id desconhecido')
      await scrollTo('tts-section')
      await shot('ux-12-tts-slow-model-warning')
      await page.getByTestId('tts-model-use-recommended').click()
      await waitFor(
        async () =>
          (await page.getByTestId('tts-model').getAttribute('data-value')) ===
          'elevenlabs/eleven-flash-v2.5',
        3000,
        'troca para o recomendado'
      )
      assert.equal(await count('tts-model-slow'), 0, 'aviso continua depois da troca')
      assert.equal(await page.getByTestId('tts-voice').getAttribute('data-value'), 'sarah')
      return t.replace(/\n/g, ' ')
    }
  )

  await step('TTS: "Testar voz" com falha → aviso legível (role=alert) e dispensável', async () => {
    await openAudio('voice-tts-fail')
    await page.getByTestId('tts-test').click()
    await page.getByTestId('tts-error').waitFor({ timeout: 3000 })
    const t = await page.getByTestId('tts-error').innerText()
    assert.match(t, /Falha ao testar a voz: chave de API inválida ou sem permissão \(HTTP 401\)/)
    assert.equal(await page.getByTestId('tts-error').getAttribute('role'), 'alert')
    await scrollTo('tts-section')
    await shot('ux-13-tts-test-error')
    await page.getByRole('button', { name: 'Dispensar erro de síntese de fala' }).click()
    assert.equal(await count('tts-error'), 0)
    return t
  })

  await step(
    'ElevenLabs direto: provedor só na fala, modelos/vozes da conta com prévia publicada',
    async () => {
      await openAudio('voice-elevenlabs')
      // STT não lista o ElevenLabs (só fala)
      const sttOpts = await pickerGroups('stt-model')
      assert(!sttOpts.some((t) => t.includes('ElevenLabs')), 'ElevenLabs na transcrição')
      await pickModel(page, page.getByTestId('tts-model'), 'eleven_flash_v2_5', {
        provider: 'ElevenLabs'
      })
      await waitFor(
        async () =>
          (await page.getByTestId('tts-model').getAttribute('data-value')) === 'eleven_flash_v2_5',
        3000,
        'modelo do ElevenLabs'
      )
      // ElevenLabs direto: só Flash/Turbo v2.5 (Multilingual da conta fica fora)
      await page.getByTestId('tts-model').click()
      const list = page.getByRole('listbox', { name: 'Modelos' })
      const el = list.locator('[role=option][data-provider="ElevenLabs"]')
      await el.first().waitFor({ timeout: 4000 })
      const elOpts = (await el.allInnerTexts()).join(' | ')
      await page.keyboard.press('Escape')
      assert.match(elOpts, /Eleven Flash v2\.5[\s\S]*~0,3 s/)
      assert.match(elOpts, /Eleven Turbo v2\.5/)
      assert(!/Multilingual/.test(elOpts), `Multilingual na lista: ${elOpts}`)
      await page.getByTestId('tts-voice').click()
      assert.match(
        await page.getByTestId('voice-option-EXAVITQu4vr4xnSDxMaL').innerText(),
        /Sarah[\s\S]*pt-BR/
      )
      // voz com pt-BR verificado antes da só-inglês (George viria antes na ordem alfabética)
      assert.equal(
        await page.locator('[data-testid^=voice-option-]').first().getAttribute('data-testid'),
        'voice-option-EXAVITQu4vr4xnSDxMaL'
      )
      await page.getByTestId('voice-preview-EXAVITQu4vr4xnSDxMaL').click()
      await waitFor(
        async () =>
          (await page
            .getByTestId('voice-preview-EXAVITQu4vr4xnSDxMaL')
            .getAttribute('data-state')) !== 'busy',
        4000,
        'prévia publicada'
      )
      assert.equal(await count('tts-preview-error'), 0)
      await page.getByTestId('voice-option-EXAVITQu4vr4xnSDxMaL').click()
      await scrollTo('tts-section')
      await shot('ux-14-elevenlabs-tts')
      assert.equal(
        await page.getByTestId('tts-voice').getAttribute('data-value'),
        'EXAVITQu4vr4xnSDxMaL'
      )
      return sttOpts.join(' | ').replace(/\n/g, ' ').slice(0, 120)
    }
  )

  await step(
    'Na chamada: WebSocket (Flash), HTTP com o motivo (v4 Turbo, OpenRouter) e o interruptor força HTTP',
    async () => {
      const text = (): Promise<string> => page.getByTestId('tts-call-transport-text').innerText()
      const ws = (): Promise<string | null> =>
        page.getByTestId('tts-call-transport').getAttribute('data-ws')
      // continua no ElevenLabs direto com o Flash v2.5 (passo anterior)
      await waitFor(async () => (await ws()) === 'true', 3000, 'WebSocket no Flash')
      assert.equal(await text(), 'Na chamada: WebSocket (texto em streaming)')
      const toggle = page.getByRole('switch', { name: 'Streaming por WebSocket' })
      assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'ligado por padrão')
      await scrollTo('tts-call-transport')
      await shot('ux-15-transport-ws')
      // desligar força HTTP por frase (gravado como elevenLabsWs: false)
      await toggle.click()
      await waitFor(async () => (await ws()) === 'false', 3000, 'HTTP forçado')
      assert.equal(await text(), 'Na chamada: HTTP por frase — desligado por você')
      await shot('ux-16-transport-off')
      await toggle.click()
      await waitFor(async () => (await ws()) === 'true', 3000, 'WebSocket de volta')
      // v4 Turbo (na lista curada do ElevenLabs direto): o WebSocket não aceita → HTTP + motivo,
      // sem interruptor
      await pickModel(page, page.getByTestId('tts-model'), 'eleven_v4_turbo', {
        provider: 'ElevenLabs'
      })
      await waitFor(async () => (await ws()) === 'false', 3000, 'HTTP no v4 Turbo')
      assert.equal(await text(), 'Na chamada: HTTP por frase — o v4 Turbo não suporta WebSocket')
      assert.equal(await page.getByRole('switch', { name: 'Streaming por WebSocket' }).count(), 0)
      await shot('ux-17-transport-v4')
      // OpenRouter: HTTP por frase com o motivo
      await pickModel(page, page.getByTestId('tts-model'), 'elevenlabs/eleven-flash-v2.5', {
        provider: 'OpenRouter'
      })
      await waitFor(async () => /OpenRouter/.test(await text()), 3000, 'motivo do OpenRouter')
      assert.equal(
        await text(),
        'Na chamada: HTTP por frase — o OpenRouter não tem WebSocket de fala'
      )
      return 'Flash → WS · desligado → HTTP · v4 Turbo → HTTP · OpenRouter → HTTP'
    }
  )

  await step(
    'Parâmetros (OpenRouter): velocidade só nos modelos com controle (ElevenLabs 0,7–1,2); Fish Audio: instruções',
    async () => {
      // continua no OpenRouter · ElevenLabs Flash (passo anterior)
      await page.getByTestId('tts-api-params-toggle').click()
      const speed = page.getByTestId('tts-api-params-speed')
      await speed.waitFor()
      assert.deepEqual(
        [await speed.getAttribute('min'), await speed.getAttribute('max')],
        ['0.7', '1.2']
      )
      assert.equal(await count('tts-api-params-row-instructions'), 0)
      await pickModel(page, page.getByTestId('tts-model'), 'fish-audio/s1', {
        provider: 'OpenRouter'
      })
      await page.getByTestId('tts-api-params-row-instructions').waitFor()
      assert.equal(
        await count('tts-api-params-row-speed'),
        0,
        'Fish Audio sem controle de velocidade'
      )
      await pickModel(page, page.getByTestId('tts-model'), 'elevenlabs/eleven-flash-v2.5', {
        provider: 'OpenRouter'
      })
    }
  )

  await step(
    'Parâmetros (ElevenLabs direto): formato de saída com nota do plano, stability, restaurar; 44,1 kHz sem Pro → erro legível no "Testar voz"',
    async () => {
      await pickModel(page, page.getByTestId('tts-model'), 'eleven_flash_v2_5', {
        provider: 'ElevenLabs'
      })
      const toggle = page.getByTestId('tts-api-params-toggle')
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      for (const k of [
        'output_format',
        'stability',
        'similarity_boost',
        'style',
        'use_speaker_boost',
        'speed',
        'apply_text_normalization',
        'auto_mode'
      ])
        await page.getByTestId(`tts-api-params-row-${k}`).waitFor()
      assert.match(
        await page.getByTestId('tts-api-params-stability-value').innerText(),
        /da voz \(conta\)/
      )
      // stability pelo teclado (um passo) → gravada; o contador mostra 1 alterado
      const st = page.getByTestId('tts-api-params-stability')
      await st.focus()
      await page.keyboard.press('ArrowLeft')
      await page.getByTestId('tts-api-params-count').waitFor()
      assert.equal(await page.getByTestId('tts-api-params-stability-value').innerText(), '0,45')
      // formato 44,1 kHz: nota "exige plano Pro"
      await page
        .getByRole('button', { name: 'Formato de saída (Eleven Flash v2.5)', exact: true })
        .click()
      const opt = popover().getByRole('button').filter({ hasText: 'PCM 44,1 kHz' }).first()
      assert.match(await opt.innerText(), /exige plano Pro/)
      await opt.click()
      await page.getByTestId('tts-api-params-output_format-note').waitFor()
      await scrollTo('tts-api-params')
      await shot('ux-18-elevenlabs-params')
      const saved = await savedVoice()
      assert.deepEqual(saved.ttsSettings.api.params, {
        elevenlabs: { output_format: 'pcm_44100', stability: 0.45 }
      })
      // a conta (mock) não é Pro: o "Testar voz" mostra o erro inline, sem trocar o formato sozinho
      await page.getByTestId('tts-test').click()
      await page.getByTestId('tts-error').waitFor({ timeout: 3000 })
      const err = await page.getByTestId('tts-error').innerText()
      assert.match(
        err,
        /O formato de saída 44,1 kHz exige o plano Pro da ElevenLabs — escolha outro formato em Configurações → Áudio → Parâmetros/
      )
      await shot('ux-19-format-error')
      // restaurar padrão: tudo volta (24 kHz, da voz)
      await page.getByTestId('tts-api-params-restore').click()
      await waitFor(async () => (await count('tts-api-params-count')) === 0, 3000, 'restaurado')
      const after = await savedVoice()
      assert.equal(after.ttsSettings.api.params, undefined)
      return err
    }
  )

  await step('Áudio: nota de que são os padrões DESTE dispositivo (não sincronizam)', async () => {
    await openAudio('chat')
    const note = page.getByTestId('audio-device-note')
    await note.waitFor()
    assert.match(await note.innerText(), /Padrões deste dispositivo \(não sincronizam\)/)
    assert.match(await note.innerText(), /cada persona pode ter a própria voz e transcrição/)
    await page.keyboard.press('Escape')
    await dialog().waitFor({ state: 'detached' })
  })

  /** Abre o editor da persona (Configurações → Personas) na aba Voz. */
  const openPersonaVoice = async (scenario: string, name: string): Promise<void> => {
    await page.evaluate((s) => {
      location.search = `?scenario=${s}`
    }, scenario)
    await page.waitForLoadState('domcontentloaded')
    await page.getByRole('button', { name: /^Configurações/ }).waitFor()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: /^Configurações/ }).click()
    await dialog().getByRole('button', { name: 'Personas', exact: true }).click()
    await dialog()
      .getByTestId('preset-row')
      .filter({ hasText: name })
      .getByRole('button', { name: /Editar/ })
      .click()
    await dialog().getByTestId('preset-editor').waitFor()
    await dialog().getByRole('tab', { name: 'Voz' }).click()
    await dialog().getByTestId('tts-choice-persona').waitFor()
    await page.waitForTimeout(400)
  }

  await step(
    'persona → Voz: "Fala"/"Transcrição" com o que vale e se funciona aqui; Escolher/Voltar sem opção "herdar" duplicada',
    async () => {
      // persona SEM voz própria: mostra a padrão deste dispositivo + "Escolher…"
      await openPersonaVoice('voice-persona', 'Revisor de código')
      const cur = dialog().getByTestId('tts-choice-current')
      assert.match(
        await cur.innerText(),
        /^Usando a voz padrão deste dispositivo: Kokoro · pf_dora/
      )
      assert.match(
        await dialog().getByTestId('stt-choice-current').innerText(),
        /^Usando a transcrição padrão deste dispositivo: Groq · whisper-large-v3-turbo · pt-BR/
      )
      await waitFor(
        async () =>
          (await dialog().getByTestId('tts-choice-availability').getAttribute('data-state')) ===
          'ok',
        3000,
        'disponível aqui'
      )
      assert.equal(await count('tts-choice-inherit'), 0, 'sem "voltar" sem escolha própria')
      // escolher uma voz própria: os mesmos seletores de Áudio (modo da persona)
      await dialog().getByTestId('tts-choice-custom').click()
      await dialog().getByTestId('tts-choice-section').waitFor()
      assert.match(await cur.innerText(), /^Voz própria desta persona: Kokoro · pf_dora/)
      assert.equal(await count('tts-gpu-steps'), 0, 'passos da GPU são do dispositivo')
      // a voz da persona: ElevenLabs Flash pelo OpenRouter (provedor cadastrado aqui)
      await pickModel(page, dialog().getByTestId('tts-model'), 'elevenlabs/eleven-flash-v2.5', {
        provider: 'OpenRouter'
      })
      await waitFor(
        async () => /OpenRouter/.test(await cur.innerText()),
        3000,
        'voz própria na API'
      )
      assert.match(await cur.innerText(), /Voz própria desta persona: OpenRouter · .*eleven/i)
      // "Gerar clipes desta voz" (só com o clique — nunca sozinho)
      const gen = dialog().getByTestId('tts-clips-generate')
      assert.match(await gen.innerText(), /Gerar clipes desta voz/)
      assert.equal(await count('tts-clips-count'), 0)
      await gen.click()
      await dialog().getByTestId('tts-clips-count').waitFor({ timeout: 8000 })
      await shot('persona-voice-tts-custom')
      // transcrição própria com idioma (★ = o do dispositivo)
      await dialog().getByTestId('stt-choice-custom').click()
      await dialog().getByTestId('stt-choice-section').waitFor()
      assert.equal(await count('stt-gpu-params'), 0)
      await dialog().getByRole('button', { name: 'Idioma da transcrição' }).click()
      await popover()
        .getByRole('button', { name: /Inglês \(EUA\)/ })
        .click()
      await dialog().getByTestId('stt-choice-language').waitFor()
      assert.match(
        await dialog().getByTestId('stt-choice-current').innerText(),
        /Transcrição própria desta persona: .* · en-US/
      )
      // voltar a herdar
      await dialog().getByTestId('tts-choice-inherit').click()
      assert.match(await cur.innerText(), /^Usando a voz padrão deste dispositivo/)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await dialog()
        .waitFor({ state: 'detached' })
        .catch(() => undefined)
      return 'padrão → própria (API + clipes + idioma) → padrão'
    }
  )

  await step(
    'sem prompt oculto: persona intocada → "Nada" na prévia; "Usar sugestão" põe o texto NO campo e a prévia mostra',
    async () => {
      await openPersonaVoice('chat', 'Revisor de código')
      const preview = dialog().getByTestId('voice-call-prompt-preview')
      await preview.scrollIntoViewIfNeeded()
      assert.equal(await preview.getAttribute('data-parts'), '', 'nada acrescentado')
      assert.match(await preview.innerText(), /Nada: a chamada manda exatamente o system prompt/)
      const field = dialog().getByTestId('voice-call-prompt')
      assert.equal(await field.inputValue(), '', 'prompt do modo voz vazio por padrão')
      await dialog().getByTestId('voice-call-prompt-suggest').click()
      await waitFor(async () => (await field.inputValue()).length > 0, 3000, 'sugestão no campo')
      assert.match(await field.inputValue(), /conversa por voz/)
      await waitFor(
        async () => (await preview.getAttribute('data-parts')) === 'voice',
        3000,
        'prévia com o prompt do modo voz'
      )
      assert.match(await preview.innerText(), /Prompt do modo voz — desta persona/)
      await shot('persona-voice-prompt-preview')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await dialog()
        .waitFor({ state: 'detached' })
        .catch(() => undefined)
    }
  )

  await step(
    'persona com voz de outro dispositivo: "Não disponível neste dispositivo — usa o padrão deste dispositivo: <motivo>"',
    async () => {
      await openPersonaVoice('voice-persona-fallback', 'Narradora')
      const av = dialog().getByTestId('tts-choice-availability')
      await waitFor(
        async () => (await av.getAttribute('data-state')) === 'fallback',
        3000,
        'fallback'
      )
      assert.match(
        await av.innerText(),
        /Não disponível neste dispositivo — usa o padrão deste dispositivo \(Kokoro · pf_dora\): o provedor escolhido não existe neste dispositivo/
      )
      assert.match(
        await dialog().getByTestId('tts-choice-current').innerText(),
        /Voz própria desta persona: provedor que não existe aqui · elevenlabs\/eleven-flash-v2.5 · sarah/
      )
      assert.equal(
        await dialog().getByTestId('stt-choice-availability').getAttribute('data-state'),
        'ok'
      )
      await shot('persona-voice-fallback')
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await dialog()
        .waitFor({ state: 'detached' })
        .catch(() => undefined)
    }
  )

  await step(
    'chat → aba Voz: "Usando a voz da persona “Narradora”" e escolha própria do chat',
    async () => {
      await page.evaluate(() => {
        location.search = '?scenario=voice-persona'
      })
      await page.waitForLoadState('domcontentloaded')
      await page
        .getByTestId('chat-item')
        .filter({ hasText: 'Ideias de nomes para o app' })
        .first()
        .click()
      await page.getByTestId('chat-scroller').waitFor()
      if (!(await page.getByTestId('right-panel').isVisible()))
        await page.getByRole('banner').getByRole('button', { name: 'Abrir painel' }).click()
      await page.getByTestId('right-panel').getByRole('tab', { name: 'Voz' }).click()
      const panel = page.getByTestId('right-panel')
      const cur = panel.getByTestId('tts-choice-current')
      await cur.waitFor()
      assert.match(
        await cur.innerText(),
        /^Usando a voz da persona “Narradora”: OpenRouter · elevenlabs\/eleven-flash-v2.5 · sarah/
      )
      assert.match(
        await panel.getByTestId('stt-choice-current').innerText(),
        /^Usando a transcrição da persona “Narradora”: Groq · whisper-large-v3-turbo · en-US/
      )
      await panel.getByTestId('tts-choice-custom').click()
      await panel.getByTestId('tts-choice-section').waitFor()
      assert.match(await cur.innerText(), /^Voz própria deste chat:/)
      assert.match(
        await panel.getByTestId('tts-choice-inherit').innerText(),
        /Voltar a usar a voz da persona/
      )
      await shot('chat-voice-tab-custom')
      await panel.getByTestId('tts-choice-inherit').click()
      assert.match(await cur.innerText(), /^Usando a voz da persona “Narradora”/)
    }
  )

  await step('layout: aba Áudio sem rolagem horizontal em 1440 e 1100', async () => {
    await openAudio('chat')
    const out: string[] = []
    for (const [w, h] of [
      [1440, 1000],
      [1100, 800]
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
        [w, h]
      )
      await page.waitForTimeout(400)
      const geo = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="audio-settings"]') as HTMLElement
        const body = root.closest('.overflow-y-auto') as HTMLElement
        const r = root.getBoundingClientRect()
        let wide = 0
        root.querySelectorAll<HTMLElement>('*').forEach((el) => {
          if (el.getBoundingClientRect().right > r.right + 1) wide++
        })
        return { scroll: body.scrollWidth > body.clientWidth + 1, wide, width: Math.round(r.width) }
      })
      assert.equal(geo.scroll, false, `rolagem horizontal em ${w}`)
      assert.equal(geo.wide, 0, `${geo.wide} elementos estouram a aba em ${w}`)
      out.push(`${w}: ${geo.width}px`)
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000)
    )
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
