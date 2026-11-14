// E2E contra o MOCK de UI (Playwright `_electron`, sem backend/GPU/chave) do "Modo avançado (GPU
// local)" — agora dentro de Configurações → Áudio → "Modelos locais" (sub-tela com "← Áudio";
// `components/voice/gpu/`, mock em `dev/mockGpu.ts`): fora da página principal e sempre aberta na
// sub-tela; sem motor instalado nenhum grupo "Local (GPU)" no seletor de Modelo (instalado, o motor
// aparece lá e escolher define backend + motor); hardware só com os fatos (sem banner de veredito — a compat fica em cada
// motor; uma linha curta só quando nada roda); servidor local só leitura ("liga sozinho");
// chamada com a GPU: barra em "Preparando a GPU…" (aviso de uso, pouca VRAM, falha encerra) e
// depois "Ouvindo…"; runtime com progresso/cancelar; motor
// bloqueado não instala, motor com aviso pede confirmação e instala; backend de Fala "Local (GPU)"
// desabilitado até haver motor, depois motor + voz agrupada (modelo / CC0 / minhas); "Testar"
// mostra a latência medida; clonar voz por upload e por gravação (microfone INJETADO — nunca o
// real: getUserMedia vira um tom sintético); STT "Local (GPU)"; pré-checagem da chamada aponta o
// problema da GPU; sem rolagem horizontal em 1100/1440.
// Motores em duas seções ("Voz (TTS)" / "Transcrição (STT)", sem badge de tipo), runtime que não
// promete o Whisper, VRAM do próprio servidor fora dos avisos (motor carregado não avisa; "o app
// libera … ao trocar") e "Parâmetros" por motor (card, painel de Fala e de Transcrição: mudar,
// gravar, restaurar).
// Cenários: `?scenario=gpu-ok|gpu-installed|gpu-installing|gpu-none|gpu-lowvram|gpu-mac|
// gpu-incompatible|gpu-broken|gpu-call|gpu-call-lowvram|gpu-call-oom|gpu-own-vram`.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-gpumode node e2e/gpu-mode-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-gpumode'))
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
const tid = (id: string): ReturnType<Page['getByTestId']> => page.getByTestId(id)

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [w, h]
  )
  await page.waitForTimeout(350)
}

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
  await tid('audio-settings').waitFor()
  await page.waitForTimeout(400)
}

/** Abre o chat de exemplo no cenário do mock (composer com o telefone). */
async function openChat(scenario: string): Promise<void> {
  await page.evaluate((s) => {
    location.search = `?scenario=${s}`
  }, scenario)
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: /^Configurações/ }).waitFor()
  await page.waitForTimeout(400)
  await page
    .getByTestId('chat-item')
    .filter({ hasText: 'Ideias de nomes para o app' })
    .first()
    .click()
  await tid('voice-call-button').waitFor({ timeout: 4000 })
  await page.waitForTimeout(300)
}

const inLocal = async (): Promise<boolean> => (await tid('audio-local-models').count()) > 0

/** Abre a sub-tela "Modelos locais" (onde mora o Modo avançado). */
async function toLocal(): Promise<void> {
  if (await inLocal()) return
  await tid('audio-local-models-open').click()
  await tid('audio-local-models').waitFor()
}

/** Volta para a página principal de Áudio ("← Áudio"). */
async function toMain(): Promise<void> {
  if (!(await inLocal())) return
  await tid('audio-local-back').click()
  await tid('stt-section').waitFor()
}

/** Abre "Modelos locais" e espera o status da GPU (a seção fica sempre aberta lá). */
async function expandGpu(): Promise<void> {
  await toLocal()
  await tid('gpu-hardware').waitFor({ timeout: 5000 })
  await page.waitForTimeout(250)
}

/** Grupos do seletor de modelo (cabeçalhos) na página principal. */
async function pickerGroups(testId: string): Promise<string[]> {
  await toMain()
  await tid(testId).click()
  const list = page.getByRole('listbox', { name: 'Modelos' })
  await list.locator('[data-testid="model-group"]').first().waitFor({ timeout: 4000 })
  await page.waitForTimeout(250)
  const g = await list
    .locator('[data-testid="model-group"]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ')))
  await page.keyboard.press('Escape')
  return g
}

/** Escolhe um motor do grupo "Local (GPU)" no seletor de Modelo (Fala ou Transcrição). */
async function pickGpu(testId: 'tts-model' | 'stt-model', model?: string): Promise<void> {
  await toMain()
  await scrollTo(testId === 'tts-model' ? 'tts-section' : 'stt-section')
  await tid(testId).click()
  const list = page.getByRole('listbox', { name: 'Modelos' })
  await list
    .locator(`[role=option][data-provider="Local (GPU)"]${model ? `[data-model="${model}"]` : ''}`)
    .first()
    .click()
  await list.waitFor({ state: 'detached', timeout: 4000 })
  await page.waitForTimeout(300)
}

async function scrollTo(testId: string): Promise<void> {
  await tid(testId)
    .first()
    .evaluate((e) => e.scrollIntoView({ block: 'start' }))
  await page.waitForTimeout(200)
}

async function choose(label: string, option: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click()
  await popover().getByRole('button').filter({ hasText: option }).first().click()
  await page.waitForTimeout(350)
}

async function waitFor(fn: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando ${what}`)
    await page.waitForTimeout(100)
  }
}

const attr = (id: string, a: string): Promise<string | null> => tid(id).first().getAttribute(a)

/** WAV PCM16 mono (tom de 220 Hz com envelope de "fala") para o upload. */
function toneWav(seconds: number, rate = 24000): Buffer {
  const n = Math.round(seconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const env = (i / rate) % 1.5 < 1.1 ? 0.3 : 0
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * env * 32767), 44 + i * 2)
  }
  return buf
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const wavPath = join(BASE, 'minha-voz.wav')
  writeFileSync(wavPath, toneWav(8))
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
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  // Microfone INJETADO (nunca o hardware): getUserMedia vira um tom sintético com rajadas de
  // "fala"; enumerateDevices devolve um dispositivo falso (mesmo padrão de voice-dictation.spec.ts).
  await page.addInitScript(() => {
    const md = navigator.mediaDevices
    const FAKE = {
      deviceId: 'fake-mic-1',
      groupId: 'fake',
      kind: 'audioinput',
      label: 'Microfone falso (e2e)'
    }
    md.enumerateDevices = async () => [
      { ...FAKE, toJSON: () => FAKE } as unknown as MediaDeviceInfo
    ]
    md.getUserMedia = async () => {
      const ctx = new AudioContext({ sampleRate: 48000 })
      const osc = ctx.createOscillator()
      osc.frequency.value = 220
      const gain = ctx.createGain()
      const t0 = ctx.currentTime
      for (let i = 0; i < 100; i++) {
        gain.gain.setValueAtTime(0.3, t0 + i * 1.5)
        gain.gain.setValueAtTime(0, t0 + i * 1.5 + 1.1)
      }
      const dest = ctx.createMediaStreamDestination()
      osc.connect(gain).connect(dest)
      osc.start()
      ;(window as unknown as { __fakeMicOpened?: number }).__fakeMicOpened =
        ((window as unknown as { __fakeMicOpened?: number }).__fakeMicOpened ?? 0) + 1
      return dest.stream
    }
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await setSize(1440, 1000)

  // ---------------- fechado por padrão + backend desabilitado ----------------

  await step(
    'Modo avançado só em "Modelos locais" (sempre aberto lá); sem motor instalado nenhum grupo "Local (GPU)"',
    async () => {
      await openAudio('gpu-ok')
      assert.equal(await tid('gpu-mode-section').count(), 0, 'Modo avançado na página principal')
      assert.equal(await tid('tts-gpu-hint').count(), 0, 'dica antiga do provedor GPU')
      const tts = await pickerGroups('tts-model')
      const stt = await pickerGroups('stt-model')
      assert(!tts.some((g) => /Local \(GPU\)/.test(g)), `Fala: ${tts.join(' | ')}`)
      assert(!stt.some((g) => /Local \(GPU\)/.test(g)), `Transcrição: ${stt.join(' | ')}`)
      await scrollTo('tts-section')
      await shot('01-no-gpu-group')
      await toLocal()
      assert.equal(await attr('gpu-mode-section', 'data-expanded'), 'true')
      assert.equal(await tid('gpu-mode-toggle').count(), 0, 'recolher dentro da sub-tela')
      await tid('gpu-engines').waitFor({ timeout: 3000 })
      return `Fala: ${tts.join(' | ')}`
    }
  )

  await step(
    'gpu-ok: hardware sem banner de veredito, ordem dos motores, instalar sem runtime avisa que baixa junto',
    async () => {
      await expandGpu()
      assert.equal(await tid('gpu-verdict').count(), 0, 'banner de veredito voltou')
      assert.equal(await tid('gpu-incompatible').count(), 0, 'linha de incompatível num PC ok')
      assert.doesNotMatch(await tid('gpu-hardware').innerText(), /Sua GPU roda/)
      assert.match(
        await tid('gpu-list').innerText(),
        /RTX 3080 Ti[\s\S]*VRAM 12 GB[\s\S]*CUDA até 13\.4/
      )
      const order = await page
        .locator('[data-testid^="gpu-engine-"][data-install]')
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute('data-testid')!.replace('gpu-engine-', ''))
        )
      assert.deepEqual(order, [
        'omnivoice',
        'xtts-v2',
        'vibevoice-realtime',
        'qwen3-tts-0.6b',
        'qwen3-tts-1.7b',
        'whisper-large-v3-turbo'
      ])
      // duas seções com cabeçalho próprio; sem o badge de tipo nos cards
      const inSection = async (sec: string): Promise<string[]> =>
        tid(sec)
          .locator('[data-testid^="gpu-engine-"][data-install]')
          .evaluateAll((els) =>
            els.map((e) => e.getAttribute('data-testid')!.replace('gpu-engine-', ''))
          )
      assert.deepEqual(await inSection('gpu-engines-tts'), order.slice(0, 5))
      assert.deepEqual(await inSection('gpu-engines-stt'), ['whisper-large-v3-turbo'])
      assert.match(await tid('gpu-engines-tts').innerText(), /^Voz \(TTS\)/)
      assert.match(await tid('gpu-engines-stt').innerText(), /^Transcrição \(STT\)/)
      for (const id of order) {
        const head = await tid(`gpu-engine-${id}`).locator('span[data-tone="accent"]').count()
        assert.equal(head, 0, `badge de tipo no card ${id}`)
      }
      // o runtime não diz que instala o Whisper (o modelo é a seção de Transcrição)
      await page.getByRole('button', { name: 'Ajuda: Runtime da GPU' }).hover()
      const tip = page.getByRole('tooltip').first()
      await tip.waitFor({ timeout: 3000 })
      const tipText = await tip.innerText()
      assert.match(tipText, /Não inclui nenhum modelo/)
      assert.match(tipText, /Whisper\) são instalados à parte/)
      await page.mouse.move(5, 5)
      // sem o runtime o motor instala mesmo assim (o backend baixa o runtime antes) — com a nota
      assert.equal(
        await tid('gpu-engine-action-omnivoice').isDisabled(),
        false,
        'instalar bloqueado sem runtime'
      )
      assert.match(await tid('gpu-engine-note-omnivoice').innerText(), /runtime junto/)
      assert.match(await tid('gpu-runtime-size').innerText(), /7,5 GB de download/)
      // licença não comercial marcada; pt-PT do Qwen
      assert.match(await tid('gpu-engine-license-xtts-v2').innerText(), /licença não comercial/)
      assert.match((await attr('gpu-engine-license-xtts-v2', 'title')) ?? '', /CPML/)
      assert.match(await tid('gpu-engine-ptbr-qwen3-tts-0.6b').innerText(), /sotaque de Portugal/)
      await scrollTo('gpu-mode-section')
      await shot('02-gpu-ok-expanded')
      return order.join(' > ')
    }
  )

  await step('runtime: Instalar → barra com a fase (sem erro durante) → instalado', async () => {
    await tid('gpu-runtime-install').click()
    await tid('gpu-runtime-progress').waitFor({ timeout: 3000 })
    const phase = await tid('gpu-runtime-progress-phase').innerText()
    await shot('03-runtime-installing')
    const phases = new Set<string>()
    await waitFor(
      async () => {
        if ((await tid('gpu-runtime-progress-phase').count()) > 0)
          phases.add(await tid('gpu-runtime-progress-phase').innerText())
        assert.equal(await tid('gpu-runtime-error').count(), 0, 'erro durante a instalação')
        return (await attr('gpu-runtime', 'data-state')) === 'installed'
      },
      10_000,
      'runtime instalado'
    )
    assert.ok(![...phases].some((p) => /whisper/i.test(p)), [...phases].join(' | '))
    assert.match(await tid('gpu-runtime-state').innerText(), /instalado · /)
    return phase
  })

  await step('OmniVoice (compatível): instala sem confirmação, com progresso', async () => {
    await tid('gpu-engine-action-omnivoice').click()
    assert.equal(await tid('gpu-engine-confirm-omnivoice').count(), 0, 'confirmação num motor ok')
    await tid('gpu-engine-progress-omnivoice').waitFor({ timeout: 3000 })
    await waitFor(
      async () => (await attr('gpu-engine-omnivoice', 'data-install')) === 'installed',
      8000,
      'OmniVoice instalado'
    )
    // os passos moram em "Parâmetros" (fechado por padrão)
    assert.equal(await tid('gpu-omnivoice-steps').count(), 0, 'parâmetros abertos por padrão')
    await tid('gpu-engine-params-omnivoice-toggle').click()
    assert(await tid('gpu-omnivoice-steps').isVisible(), 'passos do OmniVoice')
    assert(await tid('gpu-engine-params-omnivoice-guidance_scale').isVisible(), 'guidance')
    assert(await tid('gpu-engine-params-omnivoice-speed').isVisible(), 'velocidade')
    assert.equal(
      await attr('gpu-omnivoice-steps-16', 'aria-checked'),
      'true',
      '16 passos por padrão'
    )
  })

  await step('Testar: mostra a latência medida (~0,3 s até o 1º áudio)', async () => {
    await tid('gpu-engine-test-omnivoice').click()
    await tid('gpu-engine-test-result-omnivoice').waitFor({ timeout: 4000 })
    const m = await tid('gpu-engine-measured-omnivoice').innerText()
    assert.match(m, /~0,3 s até o 1º áudio/)
    await tid('gpu-server').waitFor()
    assert.match(await tid('gpu-server-state').innerText(), /em uso por: OmniVoice/)
    await scrollTo('gpu-runtime')
    await shot('04-omnivoice-installed-tested')
    return m.trim()
  })

  await step(
    'Fala: grupo "Local (GPU)" com o motor instalado → voz em grupos; CC0 "Baixar"',
    async () => {
      const groups = await pickerGroups('tts-model')
      assert(
        groups.some((g) => /^Local \(GPU\) 1/.test(g)),
        `grupo GPU: ${groups.join(' | ')}`
      )
      await pickGpu('tts-model', 'omnivoice')
      await tid('tts-gpu').waitFor()
      assert.equal(await attr('tts-model', 'data-value'), 'omnivoice')
      assert.match(await tid('tts-model').innerText(), /Local \(GPU\)[\s\S]*OmniVoice/)
      // OmniVoice só clona: sem voz → erro de prontidão até baixar a CC0
      assert.match(await tid('tts-gpu-readiness').innerText(), /voz de referência/)
      // seletor de voz no desenho do seletor de modelo: grupos por origem, ações dentro do grupo
      await tid('gpu-voice').click()
      await tid('gpu-voice-menu').waitFor()
      assert(await tid('gpu-voice-group-cc0').isVisible(), 'grupo CC0')
      assert(await tid('gpu-voice-group-user').isVisible(), 'grupo Minhas vozes')
      await tid('gpu-cc0-download').click()
      await tid('gpu-voice-cc0-faber').waitFor({ timeout: 4000 })
      await waitFor(
        async () => (await attr('gpu-voice', 'data-value')) === 'cc0-faber',
        3000,
        'CC0 escolhida'
      )
      assert.equal(await attr('gpu-voice-cc0-faber', 'aria-selected'), 'true')
      await waitFor(
        async () => !/voz de referência/.test(await tid('tts-gpu').innerText()),
        3000,
        'prontidão sem erro de voz'
      )
      await tid('gpu-voice-preview-cc0-faber').click()
      await waitFor(
        async () => (await attr('gpu-voice-preview-cc0-faber', 'data-state')) !== 'busy',
        4000,
        'prévia'
      )
      assert.equal(await tid('tts-gpu-error').count(), 0, 'erro na prévia')
      await shot('05-tts-gpu-panel')
      await page.keyboard.press('Escape')
    }
  )

  await step(
    'clonar voz por UPLOAD: duração, nome, salvar → em Minhas vozes e no seletor',
    async () => {
      await tid('gpu-voice').click()
      await tid('gpu-voice-add-mine').click()
      // "Gravar ou enviar…" leva à sub-tela Modelos locais com o formulário aberto
      await tid('audio-local-models').waitFor({ timeout: 3000 })
      await tid('gpu-clone-form').waitFor({ timeout: 3000 })
      await tid('gpu-clone-file').setInputFiles(wavPath)
      await tid('gpu-clone-sample').waitFor({ timeout: 4000 })
      const dur = await tid('gpu-clone-duration').innerText()
      assert.match(dur, /minha-voz\.wav · 8,0 s/)
      assert.equal(
        await tid('gpu-clone-duration-problem').count(),
        0,
        'duração boa marcada como problema'
      )
      assert.equal(await tid('gpu-clone-name').inputValue(), 'minha-voz')
      await tid('gpu-clone-name').fill('Eduardo (upload)')
      await tid('gpu-clone-preview').click()
      await page.waitForTimeout(300)
      await tid('gpu-clone-form').scrollIntoViewIfNeeded()
      await shot('06-clone-upload')
      await tid('gpu-clone-save').click()
      await tid('gpu-clone-form').waitFor({ state: 'detached', timeout: 4000 })
      await tid('gpu-user-voice-user-1').waitFor()
      // aparece no grupo "Minhas vozes" do seletor de voz do painel de Fala (página principal)
      await toMain()
      await scrollTo('tts-section')
      await tid('gpu-voice').click()
      await tid('gpu-voice-group-user').getByTestId('gpu-voice-user-1').waitFor({ timeout: 3000 })
      await tid('gpu-voice-user-1').click()
      await waitFor(
        async () => (await attr('gpu-voice', 'data-value')) === 'user-1',
        3000,
        'voz do usuário escolhida'
      )
      return dur
    }
  )

  await step('Passos do OmniVoice: 32 grava e reflete nos dois controles', async () => {
    await toMain()
    await tid('tts-gpu-steps-32').click()
    await page.waitForTimeout(300)
    await toLocal()
    if ((await attr('gpu-engine-params-omnivoice', 'data-open')) !== 'true')
      await tid('gpu-engine-params-omnivoice-toggle').click()
    await waitFor(
      async () => (await attr('gpu-omnivoice-steps-32', 'aria-checked')) === 'true',
      3000,
      'passos 32 no card'
    )
    await tid('gpu-omnivoice-steps-16').click()
    await page.waitForTimeout(300)
    await toMain()
    await waitFor(
      async () => (await attr('tts-gpu-steps-16', 'aria-checked')) === 'true',
      3000,
      'passos 16 no painel de Fala'
    )
  })

  // ---------------- instalado: servidor, STT GPU, gravação, pré-checagem da chamada ----------------

  await step('gpu-installed: servidor rodando, latências do lab, STT "Local (GPU)"', async () => {
    await openAudio('gpu-installed')
    await expandGpu()
    assert.equal(await attr('gpu-server', 'data-state'), 'running')
    assert.match(
      await tid('gpu-server-state').innerText(),
      /em uso por: OmniVoice \+ Whisper large-v3-turbo/
    )
    assert.match(await tid('gpu-server-hint').innerText(), /desliga após 15 min sem uso/)
    assert.equal(await tid('gpu-server-start').count(), 0, 'botão Iniciar voltou')
    assert.match(await tid('gpu-server-stop').innerText(), /Parar agora/)
    const lat: Record<string, string> = {}
    for (const id of [
      'omnivoice',
      'xtts-v2',
      'vibevoice-realtime',
      'qwen3-tts-0.6b',
      'whisper-large-v3-turbo'
    ])
      lat[id] = (await tid(`gpu-engine-measured-${id}`).innerText()).trim()
    assert.match(lat['xtts-v2'], /~120 ms até o 1º áudio/)
    assert.match(lat['vibevoice-realtime'], /~20 ms/)
    assert.match(lat['qwen3-tts-0.6b'], /~170 ms/)
    assert.match(lat['whisper-large-v3-turbo'], /~100 ms por frase/)
    await scrollTo('gpu-server')
    await shot('07-gpu-installed')
    await pickGpu('stt-model', 'whisper-large-v3-turbo')
    await tid('stt-gpu').waitFor()
    assert.match(await tid('stt-gpu-state').innerText(), /instalado/)
    assert.equal(await tid('stt-api-params').count(), 0, 'parâmetros de API no modo GPU')
    assert.equal(await tid('stt-local').count(), 0, 'whisper.cpp no modo GPU')
    await shot('08-stt-gpu')
    return Object.values(lat).join(' | ')
  })

  await step(
    'clonar voz GRAVANDO (microfone injetado): contagem, nível, transcrever automaticamente',
    async () => {
      await toLocal()
      await scrollTo('gpu-user-voices')
      await tid('gpu-voice-add').click()
      await tid('gpu-clone-form').waitFor()
      assert(await tid('gpu-clone-suggested').isVisible(), 'texto sugerido')
      await tid('gpu-clone-record').click()
      await tid('gpu-clone-recording').waitFor({ timeout: 5000 })
      let maxLevel = 0
      const t0 = Date.now()
      while (Date.now() - t0 < 6500) {
        const v = Number(await attr('gpu-clone-level', 'aria-valuenow'))
        if (v > maxLevel) maxLevel = v
        await page.waitForTimeout(150)
      }
      const countdown = await tid('gpu-clone-countdown').innerText()
      assert.match(countdown, /faltam [1-4] s/)
      await tid('gpu-clone-form').scrollIntoViewIfNeeded()
      await shot('09-clone-recording')
      await tid('gpu-clone-stop').click()
      await tid('gpu-clone-sample').waitFor({ timeout: 4000 })
      const dur = await tid('gpu-clone-duration').innerText()
      const secs = Number(/([\d,]+) s/.exec(dur)?.[1].replace(',', '.'))
      assert(secs >= 6 && secs <= 8, `duração gravada ${dur}`)
      assert(maxLevel > 5, `medidor de nível parado (${maxLevel})`)
      const opened = await page.evaluate(
        () => (window as unknown as { __fakeMicOpened?: number }).__fakeMicOpened ?? 0
      )
      assert(opened >= 1, 'o microfone falso não foi usado')
      await tid('gpu-clone-transcribe').click()
      await waitFor(
        async () => (await tid('gpu-clone-transcript').inputValue()).length > 0,
        4000,
        'transcrição automática'
      )
      await tid('gpu-clone-name').fill('Minha voz gravada')
      await shot('10-clone-recorded')
      await tid('gpu-clone-save').click()
      await tid('gpu-clone-form').waitFor({ state: 'detached', timeout: 4000 })
      await tid('gpu-user-voice-user-1').waitFor()
      // com transcrição, a voz vale também para o Qwen
      return `${dur} · nível máx ${maxLevel}% · ${await tid('gpu-user-voice-list').innerText()}`
    }
  )

  await step(
    'pré-checagem da chamada: motor da fala removido → toast aponta Modelos locais',
    async () => {
      await pickGpu('tts-model', 'omnivoice')
      await tid('tts-gpu').waitFor()
      await toLocal()
      await tid('gpu-engine-action-omnivoice').click() // Remover
      await waitFor(
        async () => (await attr('gpu-engine-omnivoice', 'data-install')) === 'absent',
        3000,
        'OmniVoice removido'
      )
      await toMain()
      // a seleção continua no OmniVoice (marcado "não instalado" no seletor) com a prontidão
      await tid('tts-model-local-missing').waitFor()
      const ready = await tid('tts-gpu-readiness').innerText()
      assert.match(ready, /instale o motor OmniVoice/i)
      await scrollTo('tts-section')
      await shot('11-tts-gpu-readiness')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      await page
        .getByTestId('chat-item')
        .filter({ hasText: 'Ideias de nomes para o app' })
        .first()
        .click()
      await page.waitForTimeout(400)
      await tid('voice-call-button').click()
      const toast = page.getByTestId('toast').filter({ hasText: 'Chamada de voz indisponível' })
      await toast.waitFor({ timeout: 4000 })
      const text = await toast.innerText()
      assert.match(
        text,
        /Fala \(GPU local\): instale o motor OmniVoice em Configurações → Áudio → Modelos locais/
      )
      await shot('12-call-readiness-toast')
      return text.slice(0, 160)
    }
  )

  // ---------------- vereditos por cenário ----------------

  await step(
    'gpu-none: sem NVIDIA → aviso (CPU); runtime pede confirmação; motor com aviso confirma e instala',
    async () => {
      await openAudio('gpu-none')
      await expandGpu()
      assert.equal(await tid('gpu-verdict').count(), 0)
      assert.match(await tid('gpu-list').innerText(), /Intel UHD Graphics 630/)
      assert.equal(await attr('gpu-engine-xtts-v2', 'data-compat'), 'warn')
      await tid('gpu-runtime-install').click()
      await tid('gpu-runtime-confirm').waitFor()
      await scrollTo('gpu-mode-section')
      await shot('13-gpu-none-runtime-confirm')
      await tid('gpu-runtime-confirm-yes').click()
      await waitFor(
        async () => (await attr('gpu-runtime', 'data-state')) === 'installed',
        10_000,
        'runtime instalado'
      )
      await tid('gpu-engine-action-xtts-v2').click()
      await tid('gpu-engine-confirm-xtts-v2').waitFor()
      assert.match(
        await tid('gpu-engine-confirm-xtts-v2').innerText(),
        /pode não rodar bem[\s\S]*CPU/
      )
      assert.equal(
        await attr('gpu-engine-xtts-v2', 'data-install'),
        'absent',
        'instalou antes de confirmar'
      )
      await tid('gpu-engine-xtts-v2').scrollIntoViewIfNeeded()
      await shot('14-gpu-none-engine-confirm')
      await tid('gpu-engine-confirm-yes-xtts-v2').click()
      await waitFor(
        async () => (await attr('gpu-engine-xtts-v2', 'data-install')) === 'installed',
        8000,
        'XTTS instalado'
      )
    }
  )

  await step(
    'gpu-lowvram: Qwen 1.7B bloqueado (não instala, motivo visível); OmniVoice com aviso',
    async () => {
      await openAudio('gpu-lowvram')
      await expandGpu()
      assert.equal(await tid('gpu-verdict').count(), 0)
      const title = await tid('gpu-list').innerText()
      assert.match(title, /GTX 1650[\s\S]*VRAM 4 GB/)
      assert.equal(await attr('gpu-engine-qwen3-tts-1.7b', 'data-compat'), 'blocked')
      assert.equal(await attr('gpu-engine-omnivoice', 'data-compat'), 'warn')
      // runtime numa NVIDIA: sem confirmação
      await tid('gpu-runtime-install').click()
      assert.equal(await tid('gpu-runtime-confirm').count(), 0)
      await waitFor(
        async () => (await attr('gpu-runtime', 'data-state')) === 'installed',
        10_000,
        'runtime instalado'
      )
      assert.equal(
        await tid('gpu-engine-action-qwen3-tts-1.7b').isDisabled(),
        true,
        'bloqueado habilitado'
      )
      assert.match(
        await tid('gpu-engine-reasons-qwen3-tts-1.7b').innerText(),
        /6,9 GB de VRAM; sua GPU tem 4,0 GB/
      )
      await tid('gpu-engine-qwen3-tts-1.7b').scrollIntoViewIfNeeded()
      await shot('15-gpu-lowvram')
      await tid('gpu-engine-action-omnivoice').click()
      await tid('gpu-engine-confirm-omnivoice').waitFor()
      await tid('gpu-engine-confirm-yes-omnivoice').click()
      await waitFor(
        async () => (await attr('gpu-engine-omnivoice', 'data-install')) === 'installed',
        8000,
        'OmniVoice instalado'
      )
      return title
    }
  )

  await step(
    'gpu-mac: Apple Silicon experimental — aviso (não bloqueio) em todos, VibeVoice inclusive',
    async () => {
      await openAudio('gpu-mac')
      await expandGpu()
      assert.equal(await tid('gpu-verdict').count(), 0)
      assert.match(await tid('gpu-engine-reasons-omnivoice').innerText(), /Apple Silicon/)
      assert.equal(await attr('gpu-engine-vibevoice-realtime', 'data-compat'), 'warn')
      assert.match(await tid('gpu-list').innerText(), /memória unificada[\s\S]*macOS arm64/)
      await scrollTo('gpu-mode-section')
      await shot('16-gpu-mac')
    }
  )

  await step(
    'gpu-incompatible: uma linha curta "Incompatível: …" e o runtime não instala',
    async () => {
      await openAudio('gpu-incompatible')
      await expandGpu()
      assert.equal(await tid('gpu-verdict').count(), 0)
      const title = (await tid('gpu-incompatible').innerText()).trim()
      assert.match(title, /^Incompatível: /)
      assert.equal(title.split('\n').length, 1, 'mais de uma linha')
      assert.equal(await tid('gpu-runtime-install').isDisabled(), true)
      assert(await tid('gpu-runtime-blocked').isVisible())
      await scrollTo('gpu-mode-section')
      await shot('17-gpu-incompatible')
      return title
    }
  )

  await step(
    'gpu-installing: progresso com a fase e Cancelar volta a "não instalado"',
    async () => {
      await openAudio('gpu-installing')
      await expandGpu()
      await tid('gpu-runtime-progress').waitFor({ timeout: 4000 })
      await waitFor(
        async () => /PyTorch/.test(await tid('gpu-runtime-progress-phase').innerText()),
        4000,
        'fase do PyTorch'
      )
      const pct1 = Number(
        await page
          .getByRole('progressbar', { name: 'Instalação do runtime' })
          .getAttribute('aria-valuenow')
      )
      await page.waitForTimeout(800)
      const pct2 = Number(
        await page
          .getByRole('progressbar', { name: 'Instalação do runtime' })
          .getAttribute('aria-valuenow')
      )
      assert(pct2 >= pct1, `progresso voltou ${pct1} → ${pct2}`)
      await scrollTo('gpu-mode-section')
      await shot('18-gpu-installing')
      await tid('gpu-runtime-cancel').click()
      await waitFor(
        async () => (await attr('gpu-runtime', 'data-state')) === 'absent',
        3000,
        'cancelado'
      )
      assert.equal(await tid('gpu-runtime-progress').count(), 0)
      return `${pct1}% → ${pct2}%`
    }
  )

  await step('gpu-broken: erro do runtime legível com "ver log"', async () => {
    await openAudio('gpu-broken')
    await expandGpu()
    assert.match(await tid('gpu-runtime-error').innerText(), /libcudnn\.so\.9/)
    await tid('gpu-runtime-error-log-toggle').click()
    await waitFor(
      async () => /torch 2\.8/.test(await tid('gpu-runtime-error-log').innerText()),
      3000,
      'log'
    )
    assert.match(await tid('gpu-runtime-install').innerText(), /Reinstalar/)
    await scrollTo('gpu-mode-section')
    await shot('19-gpu-broken-log')
  })

  // ---------------- chamada com a GPU: liga sozinho ----------------

  await step(
    'gpu-call: telefone → barra "Preparando a GPU…" (aviso de uso) → "Ouvindo…"; servidor ligado sozinho',
    async () => {
      await openChat('gpu-call')
      await tid('voice-call-button').click()
      await tid('voice-call-dock').waitFor({ timeout: 4000 })
      await waitFor(
        async () => /Preparando a GPU…/.test(await tid('voice-call-status').innerText()),
        2000,
        'fase de preparo'
      )
      const prep = await tid('voice-call-preparing').innerText()
      assert.match(prep, /Iniciando OmniVoice \+ Whisper large-v3-turbo…/)
      const notice = await tid('voice-call-gpu-notice').innerText()
      assert.match(notice, /A chamada vai usar sua GPU \(RTX 3080 Ti\) — ~5,2 GB de VRAM/)
      assert.equal(await tid('voice-call-gpu-warning').count(), 0, 'aviso de VRAM com 9 GB livres')
      await shot('21-call-preparing-gpu')
      await waitFor(
        async () => /Aquecendo/.test(await tid('voice-call-preparing').innerText()),
        3000,
        'fase de aquecimento'
      )
      const t0 = Date.now()
      await waitFor(
        async () => /Ouvindo…/.test(await tid('voice-call-status').innerText()),
        5000,
        'chamada pronta'
      )
      assert.equal(await tid('voice-call-preparing').count(), 0)
      assert.equal(await tid('voice-call-gpu-notice').count(), 0, 'aviso de uso depois de pronta')
      await shot('22-call-ready')
      // "Entendi" vale para a sessão do app: a 2ª chamada com a GPU fria não repete o aviso
      await tid('voice-call-end').click()
      await tid('voice-call-dock').waitFor({ state: 'detached', timeout: 3000 })
      return `${prep.trim()} → pronta (+${Date.now() - t0} ms)`
    }
  )

  await step(
    'gpu-call: servidor só leitura — "em uso por", "Parar agora" → parado; "Entendi" não repete',
    async () => {
      await page.getByRole('button', { name: /^Configurações/ }).click()
      await dialog().getByRole('button', { name: 'Áudio', exact: true }).click()
      await tid('audio-settings').waitFor()
      await expandGpu()
      await scrollTo('gpu-runtime')
      assert.match(
        await tid('gpu-server-state').innerText(),
        /em uso por: OmniVoice \+ Whisper large-v3-turbo/
      )
      await shot('23-advanced-server-running')
      await tid('gpu-server-stop').click()
      await waitFor(
        async () => (await attr('gpu-server', 'data-state')) === 'stopped',
        3000,
        'servidor parado'
      )
      assert.match(await tid('gpu-server-hint').innerText(), /liga sozinho quando precisa/)
      assert.equal(await tid('gpu-server-stop').count(), 0, '"Parar agora" com o servidor parado')
      await scrollTo('gpu-mode-section')
      await shot('24-advanced-no-banner-status-line')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      // 2ª chamada (GPU fria de novo): prepara, mas o aviso de uso só depois de "Entendi"
      await tid('voice-call-button').click()
      await tid('voice-call-gpu-notice').waitFor({ timeout: 3000 })
      await tid('voice-call-gpu-notice-ok').click()
      assert.equal(await tid('voice-call-gpu-notice').count(), 0)
      await waitFor(
        async () => /Ouvindo…/.test(await tid('voice-call-status').innerText()),
        5000,
        'chamada pronta'
      )
      await tid('voice-call-end').click()
      await tid('voice-call-dock').waitFor({ state: 'detached', timeout: 3000 })
      await page.getByRole('button', { name: /^Configurações/ }).click()
      await dialog().getByRole('button', { name: 'Áudio', exact: true }).click()
      await tid('audio-settings').waitFor()
      await expandGpu()
      await tid('gpu-server-stop').click()
      await waitFor(
        async () => (await attr('gpu-server', 'data-state')) === 'stopped',
        3000,
        'parado'
      )
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      await tid('voice-call-button').click()
      await waitFor(
        async () => /Preparando a GPU…/.test(await tid('voice-call-status').innerText()),
        2000,
        'preparo'
      )
      assert.equal(
        await tid('voice-call-gpu-notice').count(),
        0,
        'aviso repetido depois do Entendi'
      )
      await tid('voice-call-end').click()
      await tid('voice-call-dock').waitFor({ state: 'detached', timeout: 3000 })
    }
  )

  await step('gpu-call-lowvram: aviso de pouca VRAM (não barra) e a chamada segue', async () => {
    await openChat('gpu-call-lowvram')
    await tid('voice-call-button').click()
    await tid('voice-call-gpu-warning').waitFor({ timeout: 4000 })
    const w = await tid('voice-call-gpu-warning').innerText()
    assert.match(w, /Pouca VRAM livre \(2,1 GB de 5,2 GB\) — a chamada pode falhar ou ficar lenta/)
    await shot('25-call-lowvram-warning')
    await waitFor(
      async () => /Ouvindo…/.test(await tid('voice-call-status').innerText()),
      5000,
      'chamada pronta com pouca VRAM'
    )
    assert(await tid('voice-call-gpu-warning').isVisible(), 'o aviso sumiu ao ficar pronta')
    await tid('voice-call-end').click()
    return w.trim()
  })

  await step(
    'gpu-call-oom: falha no aquecimento encerra a chamada com o motivo e sugere a voz na nuvem',
    async () => {
      await openChat('gpu-call-oom')
      await tid('voice-call-button').click()
      const toast = page.getByTestId('toast').filter({ hasText: 'Chamada encerrada' })
      await toast.waitFor({ timeout: 6000 })
      const text = await toast.innerText()
      assert.match(
        text,
        /a GPU local não ficou pronta — OmniVoice não carregou na GPU: GPU sem memória/
      )
      assert.match(text, /voz na nuvem/)
      await tid('voice-call-dock').waitFor({ state: 'detached', timeout: 3000 })
      await shot('26-call-oom-toast')
      return text.slice(0, 160)
    }
  )

  // ---------------- VRAM do próprio servidor + parâmetros ----------------

  await step(
    'gpu-own-vram: o servidor do app ocupa a VRAM — motor carregado sem aviso, XTTS "o app libera ao trocar"',
    async () => {
      await openAudio('gpu-own-vram')
      await expandGpu()
      const vram = await tid('gpu-vram').innerText()
      assert.match(vram, /livres · 5,5 GB com o servidor do ClearChat/)
      assert(await tid('gpu-engine-loaded-omnivoice').isVisible(), 'badge "na GPU agora"')
      assert.equal(await attr('gpu-engine-omnivoice', 'data-compat'), 'ok')
      assert.equal(await attr('gpu-engine-xtts-v2', 'data-compat'), 'ok')
      assert.equal(
        await page
          .locator('[data-testid^="gpu-engine-reasons-"]')
          .filter({ hasText: /VRAM/ })
          .count(),
        0,
        'aviso de VRAM causado pelo próprio app'
      )
      assert.match(
        await tid('gpu-engine-vram-note-xtts-v2').innerText(),
        /o app libera OmniVoice, Whisper large-v3-turbo da GPU/
      )
      await tid('gpu-engine-omnivoice').scrollIntoViewIfNeeded()
      await shot('27-own-vram-no-warning')
      // parar o servidor: reavalia na hora (a VRAM volta a ser livre, sem badge/nota)
      await tid('gpu-server-stop').click()
      await waitFor(
        async () => (await tid('gpu-engine-loaded-omnivoice').count()) === 0,
        3000,
        'badge some ao parar'
      )
      assert.equal(await tid('gpu-engine-vram-note-xtts-v2').count(), 0)
      assert.match(await tid('gpu-vram').innerText(), /\(8,8 GB livres\)/)
      return vram
    }
  )

  await step(
    'Parâmetros: card do XTTS (velocidade 1,15× padrão → muda → grava) aparece igual no painel de Fala; Restaurar padrão',
    async () => {
      await tid('gpu-engine-params-xtts-v2-toggle').click()
      assert.equal(await tid('gpu-engine-params-xtts-v2-speed-value').innerText(), '1,15×')
      assert.equal(await tid('gpu-engine-params-xtts-v2-restore').isDisabled(), true)
      for (const k of ['temperature', 'repetition_penalty', 'top_p', 'top_k'])
        assert(await tid(`gpu-engine-params-xtts-v2-${k}`).isVisible(), k)
      await tid('gpu-engine-params-xtts-v2-speed').focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await waitFor(
        async () => (await tid('gpu-engine-params-xtts-v2-speed-value').innerText()) === '1,25×',
        2000,
        'velocidade 1,25×'
      )
      await waitFor(
        async () => /1 alterado/.test(await tid('gpu-engine-params-xtts-v2-count').innerText()),
        2000,
        'contagem de alterados'
      )
      await tid('gpu-engine-params-xtts-v2').scrollIntoViewIfNeeded()
      await shot('28-params-card-xtts')
      // painel de Fala com o XTTS (escolhido no seletor de Modelo): o mesmo valor (gravado)
      await page.waitForTimeout(400)
      await pickGpu('tts-model', 'xtts-v2')
      await tid('tts-gpu').waitFor()
      await tid('tts-gpu-params-toggle').click()
      await waitFor(
        async () => (await tid('tts-gpu-params-speed-value').innerText()) === '1,25×',
        3000,
        'mesmo valor no painel de Fala'
      )
      await tid('tts-gpu-params').scrollIntoViewIfNeeded()
      await shot('29-params-tts-panel')
      await tid('tts-gpu-params-restore').click()
      await waitFor(
        async () => (await tid('tts-gpu-params-count').count()) === 0,
        3000,
        'restaurado no painel'
      )
      assert.equal(await tid('tts-gpu-params-restore').isDisabled(), true)
      await page.waitForTimeout(300)
      await toLocal()
      await tid('gpu-engine-params-xtts-v2-toggle').click()
      assert.equal(await tid('gpu-engine-params-xtts-v2-speed-value').innerText(), '1,15×')
      assert.equal(await tid('gpu-engine-params-xtts-v2-count').count(), 0)
    }
  )

  await step(
    'Parâmetros do whisper: painel de Transcrição (VAD liga, idioma, restaurar)',
    async () => {
      await pickGpu('stt-model', 'whisper-large-v3-turbo')
      await tid('stt-gpu').waitFor()
      await tid('stt-gpu-params-toggle').click()
      await tid('stt-gpu-params-vad_filter').getByRole('switch').click()
      await waitFor(
        async () => /1 alterado/.test(await tid('stt-gpu-params-count').innerText()),
        2000,
        'VAD gravado'
      )
      await choose('Idioma (Whisper large-v3-turbo)', /^Detectar/)
      await waitFor(
        async () => /2 alterados/.test(await tid('stt-gpu-params-count').innerText()),
        2000,
        'idioma gravado'
      )
      await tid('stt-gpu-params').scrollIntoViewIfNeeded()
      await shot('30-params-whisper')
      // o card do whisper em Modelos locais mostra os mesmos valores
      await page.waitForTimeout(400)
      await toLocal()
      await tid('gpu-engine-params-whisper-large-v3-turbo-toggle').click()
      assert.match(
        await tid('gpu-engine-params-whisper-large-v3-turbo-count').innerText(),
        /2 alterados/
      )
      await toMain()
      await tid('stt-gpu-params-toggle').click()
      await tid('stt-gpu-params-restore').click()
      await waitFor(
        async () => (await tid('stt-gpu-params-count').count()) === 0,
        2000,
        'whisper restaurado'
      )
    }
  )

  // ---------------- layout ----------------

  await step('layout: sem rolagem horizontal na seção em 1440 e 1100', async () => {
    await openAudio('gpu-installed')
    await expandGpu()
    const out: string[] = []
    for (const [w, h] of [
      [1440, 1000],
      [1100, 800]
    ]) {
      await setSize(w, h)
      const geo = await page.evaluate(() => {
        const sec = document.querySelector('[data-testid="gpu-mode-section"]') as HTMLElement
        const body = sec.closest('.overflow-y-auto') as HTMLElement | null
        let wide = 0
        sec.querySelectorAll<HTMLElement>('*').forEach((el) => {
          const r = el.getBoundingClientRect()
          const s = sec.getBoundingClientRect()
          if (r.right > s.right + 1) wide++
        })
        return {
          scroll: body ? body.scrollWidth > body.clientWidth + 1 : false,
          overflow: wide,
          width: Math.round(sec.getBoundingClientRect().width)
        }
      })
      assert.equal(geo.scroll, false, `rolagem horizontal em ${w}`)
      assert.equal(geo.overflow, 0, `${geo.overflow} elementos estouram a seção em ${w}`)
      await scrollTo('gpu-engines')
      await shot(`20-layout-${w}`)
      out.push(`${w}: seção ${geo.width}px`)
    }
    await setSize(1440, 1000)
    return out.join(' · ')
  })

  await step('sem erros de página', async () => {
    assert.deepEqual(pageErrors, [])
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
