/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do ditado por voz (Feature A) na UI real (Playwright + `e2e/launch.ts`), determinístico e sem
// rede externa: microfone INJETADO (getUserMedia/enumerateDevices trocados por um stream
// sintético — o microfone real nunca é aberto; as flags de fake device do Chromium são ignoradas
// neste Electron/Linux) + servidor FALSO de STT
// (`e2e/fakes/sttServer.ts`) respondendo `/audio/transcriptions` com transcrição fixa (cadastrado
// em Configurações → Provedores como OpenAI-compatível em localhost, com chave, e escolhido em
// Áudio → Transcrição pelo seletor único de Modelo). userData isolado (`CLEARCHAT_USER_DATA`); nenhuma chave real.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/voice-dictation.spec.ts
//   (ou: npm run test:e2e:voice)
//
// Cobre: grupo [ telefone | mic | ˅ ] no composer, chevron com menu de microfone (Padrão do
// sistema + dispositivo injetado), gravação com o áudio injetado → parciais (no campo do ditado
// `voice-draft`, translúcidas depois do texto digitado — a textarea não muda) → ✓ concluir → texto
// final no rascunho editável (o ✓ não envia), Esc cancela descartando, "Enviar" durante a gravação
// conclui e envia digitado + final, o request
// multipart chega ao servidor falso (file/model/language/response_format + Authorization da chave
// do provedor) e o microfone salvo inexistente cai no padrão com aviso (OverconstrainedError simulado).
import type { ElectronApplication, Locator, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startFakeSttServer, type FakeSttServer } from './fakes/sttServer.ts'

const AGENT = 'fake/agent-1'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-voice-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')
const STT_KEY = 'e2e-stt-fake-key-01'
const STT_TEXT = 'ISTO É UM DITADO DE TESTE'

// ---------------- servidor falso do LLM (só para o onboarding) ----------------

let llm: Server | null = null
let llmBase = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}

async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              {
                id: AGENT,
                name: 'Fake Agent',
                context_length: 64_000,
                supported_parameters: ['tools']
              }
            ]
          })
        )
        return
      }
      await readBody(req)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: AGENT, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK.' } }] })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: AGENT, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`
      )
      res.end('data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => llm!.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let stt: FakeSttServer | null = null
let shotN = 0
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
}
async function call<T = any>(path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
    await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`).catch(() => {})
  }
}
async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
  what: string
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(150)
  }
}
const composer = (): Locator => page.locator('[data-testid="composer-column"] textarea')
const dialog = (): Locator => page.locator('[role="dialog"]')
const composerValue = (): Promise<string> => composer().inputValue()
const micButton = (): Locator => page.getByTestId('voice-mic-button')
const finishButton = (): Locator => page.getByTestId('voice-finish-button')
const waveform = (): Locator => page.getByTestId('voice-waveform')
/** Gravando de verdade (captura aberta), não só "abrindo o microfone". */
const recording = (): Locator =>
  page.locator('[data-testid="voice-recording"][data-state="recording"]')

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  await startLlm()
  stt = await startFakeSttServer({ text: STT_TEXT, requireKey: STT_KEY })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  env.CLEARCHAT_USER_DATA = USER_DATA
  // Microfone INJETADO (nunca o hardware): neste Electron/Linux as flags de fake device do
  // Chromium são ignoradas — listariam e abririam o microfone REAL do usuário. getUserMedia vira
  // um MediaStream sintético (rajadas de tom com pausas, para o VAD ver fala e silêncio) e
  // enumerateDevices devolve um dispositivo falso; deviceId exato desconhecido →
  // OverconstrainedError, como o Chromium real.
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
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
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const a = c?.audio
      const dev = a && typeof a === 'object' ? (a as MediaTrackConstraints).deviceId : undefined
      const exact =
        dev && typeof dev === 'object' ? (dev as ConstrainDOMStringParameters).exact : undefined
      if (exact && exact !== FAKE.deviceId && exact !== 'default') {
        const err = new Error('') as Error & { constraint?: string }
        err.name = 'OverconstrainedError'
        err.constraint = 'deviceId'
        throw err
      }
      const ctx = new AudioContext({ sampleRate: 48000 })
      const osc = ctx.createOscillator()
      osc.frequency.value = 220
      const gain = ctx.createGain()
      // 1,2 s de "fala", 0,6 s de pausa, repetindo (~3 min)
      const t0 = ctx.currentTime
      for (let i = 0; i < 100; i++) {
        const s = t0 + i * 1.8
        gain.gain.setValueAtTime(0.3, s)
        gain.gain.setValueAtTime(0, s + 1.2)
      }
      const dest = ctx.createMediaStreamDestination()
      osc.connect(gain).connect(dest)
      osc.start()
      return dest.stream
    }
  })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, CWD)
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))

  await step('userData isolado + onboarding + novo chat', async () => {
    assert(userData === USER_DATA, `userData ${userData}`)
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await page.getByTestId('onboarding-provider').click()
    await page.locator('input.field').nth(0).fill('Local')
    await page.locator('input.field').nth(1).fill(llmBase)
    await page.locator('input[type="password"]').fill('fake-key')
    await page.getByRole('button', { name: 'Testar conexão' }).click()
    await page.getByText(/Conexão ok/).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
    await page.getByRole('combobox').first().click()
    await page.getByRole('textbox', { name: 'Buscar modelo' }).fill(AGENT)
    await page.locator(`[role=option][data-model="${AGENT}"]`).first().click()
    await page.getByRole('button', { name: /Alterar/ }).click()
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 15_000 })
  })

  await step(
    'Configurações → Áudio: STT para o servidor falso, tecla do PTT e silêncio 0 (sem limite)',
    async () => {
      await page.getByRole('button', { name: /^Configurações/ }).click()
      await page.getByRole('button', { name: 'Áudio', exact: true }).click()
      await page.getByTestId('audio-settings').waitFor()
      // STT: o servidor falso é cadastrado em Configurações → Provedores (OpenAI-compatível em
      // localhost, com chave) — a aba Áudio só escolhe entre os provedores cadastrados
      await dialog().getByRole('button', { name: 'Provedores', exact: true }).click()
      await dialog()
        .getByRole('button', { name: /Adicionar provedor/ })
        .click()
      await dialog().locator('input.field').nth(0).fill('STT falso')
      await dialog().locator('input.field').nth(1).fill(stt!.url)
      await dialog().locator('input[type="password"]').fill(STT_KEY)
      await dialog().getByRole('button', { name: 'Adicionar', exact: true }).click()
      await dialog().getByText('STT falso').first().waitFor()
      await dialog().getByRole('button', { name: 'Áudio', exact: true }).click()
      await page.getByTestId('audio-settings').waitFor()
      // um seletor só (Modelo): o modelo do provedor "STT falso" (listado ou pelo ID livre)
      await page.getByTestId('stt-model').click()
      const search = page.getByRole('textbox', { name: 'Buscar modelo' })
      await search.waitFor()
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === 'Buscar modelo'
      )
      await search.fill('whisper-large-v3-turbo')
      const list = page.getByRole('listbox', { name: 'Modelos' })
      const listed = list.locator(
        '[role=option][data-provider="STT falso"][data-model="whisper-large-v3-turbo"]'
      )
      const free = list.locator(
        '[role=option][data-provider="STT falso"][data-free="whisper-large-v3-turbo"]'
      )
      await listed.or(free).first().waitFor({ timeout: 10_000 })
      await listed.or(free).first().click()
      await waitFor(
        async () => /STT falso/.test(await page.getByTestId('stt-model').innerText()),
        5000,
        'provedor gravado junto com o modelo'
      )
      await waitFor(
        async () =>
          (await page.getByTestId('stt-model').getAttribute('data-value')) ===
          'whisper-large-v3-turbo',
        5000,
        'modelo padrão no provedor novo'
      )
      // a chave fica no provedor (main); a visão das settings de voz não tem chave nenhuma
      const provs = await call<any[]>('providers.list')
      const fake = provs.find((p) => p.name === 'STT falso')
      assert(fake && fake.baseUrl === stt!.url.replace(/\/+$/, ''), 'provedor do STT falso')
      const masked = `${STT_KEY.slice(0, 3)}…${STT_KEY.slice(-4)}`
      // tecla do push-to-talk: captura a próxima tecla e mostra a atual
      await page.getByTestId('ptt-key-capture').click()
      await page.keyboard.press('F8')
      await waitFor(
        async () => (await page.getByTestId('ptt-key-capture').innerText()) === 'Alterar tecla',
        5000,
        'tecla capturada'
      )
      const view0 = await call<any>('voice.settings.get')
      assert(view0.audioInput.pttKey === 'F8', `pttKey ${view0.audioInput.pttKey}`)
      // auto-stop por silêncio: 0 = sem limite (o fake device tem pausas de silêncio)
      await page.getByTestId('silence-stop-ms').fill('0')
      await page.getByTestId('silence-stop-ms').press('Tab')
      await shot('config-audio')
      // fecha (Esc) — o composer recarrega as settings — e confere o que o main salvou
      await page.keyboard.press('Escape')
      await dialog().waitFor({ state: 'detached' })
      const view = await call<any>('voice.settings.get')
      assert(view.sttSettings.api.providerId === fake.id, 'STT aponta para o provedor cadastrado')
      assert(!JSON.stringify(view).includes(STT_KEY), 'chave em claro no get')
      assert(view.audioInput.silenceStopMs === 0, `silenceStopMs ${view.audioInput.silenceStopMs}`)
      return `provedor ${fake.name} (${masked}) · baseUrl ${stt!.url}`
    }
  )

  await step('menu de microfone: Padrão do sistema + dispositivo injetado', async () => {
    await page.getByTestId('voice-mic-menu-button').click()
    await page.getByTestId('voice-mic-menu').waitFor()
    await page.getByTestId('voice-mic-option-system').waitFor()
    // a lista carrega assíncrona (enumeração + liberação de labels)
    await waitFor(
      async () => (await page.getByTestId('voice-mic-option-device').count()) >= 1,
      8000,
      'microfone listado'
    )
    const n = await page.getByTestId('voice-mic-option-device').count()
    assert(n >= 1, `nenhum microfone listado (${n})`)
    await page.getByTestId('voice-mic-option-system').click()
    await page.getByTestId('voice-mic-menu').waitFor({ state: 'detached' })
    const ai = await call<any>('voice.settings.get')
    assert(ai.audioInput.deviceId === null, `deviceId ${ai.audioInput.deviceId}`)
    return `${n} microfone(s)`
  })

  await step('composer: [ telefone | mic | ˅ ] num grupo só, antes do enviar', async () => {
    const kids = await page
      .getByTestId('voice-group')
      .evaluate((g) =>
        [...g.children].map(
          (c) =>
            (c as HTMLElement).dataset.testid ??
            (c.querySelector('[data-testid]') as HTMLElement | null)?.dataset.testid
        )
      )
    assert(
      JSON.stringify(kids) ===
        JSON.stringify(['voice-call-button', 'voice-mic-button', 'voice-mic-menu-button']),
      `segmentos: ${kids.join(' | ')}`
    )
    return kids.join(' | ')
  })

  await step(
    'clicar mic → grava (microfone injetado) → parciais translúcidas depois do digitado → ✓ → texto final',
    async () => {
      await composer().fill('Digitado:')
      await micButton().click()
      // estado real "gravando" (depois do start assíncrono da captura)
      await recording().waitFor({ timeout: 15_000 })
      await waveform().waitFor({ timeout: 10_000 })
      await finishButton().waitFor({ timeout: 10_000 })
      const draft = page.getByTestId('voice-draft')
      await draft.waitFor()
      // sem texto ainda: "Ouvindo…" depois do digitado; nada de título "Gravando"
      const first = await draft.innerText()
      assert(/^Digitado: (Ouvindo…|ISTO)/.test(first), `campo do ditado: "${first}"`)
      assert(!/Gravando/.test(await page.locator('body').innerText()), 'título "Gravando"')
      // parcial ao vivo no campo (translúcida), depois do digitado; a textarea não muda
      const ghost = page.getByTestId('voice-partial')
      await waitFor(
        async () =>
          ((await ghost.innerText().catch(() => '')) || '').includes(STT_TEXT.slice(0, 8)),
        20_000,
        'parcial no campo'
      )
      await shot('gravando')
      const partial = (await ghost.innerText()).trim()
      assert((await composerValue()) === 'Digitado:', 'parcial vazou para a textarea')
      assert(
        (await page.getByTestId('voice-recording').getAttribute('data-has-text')) === 'true',
        'mic roxo com texto'
      )
      const chat = (await call<any[]>('chats.list'))[0]
      const before = (await call<any[]>('sessions.messages', chat.mainSessionId)).length
      await finishButton().click()
      // texto final vira rascunho normal, no ponto de inserção
      await waitFor(
        async () => (await composerValue()) === `Digitado: ${STT_TEXT}`,
        20_000,
        'texto final no rascunho'
      )
      await draft.waitFor({ state: 'detached', timeout: 5000 })
      // ✓ não envia
      const after = (await call<any[]>('sessions.messages', chat.mainSessionId)).length
      assert(after === before, `mensagem saiu sozinha (${before} → ${after})`)
      await shot('rascunho-final')
      return `parcial "${partial}" → final "${STT_TEXT}"`
    }
  )

  await step(
    'request multipart chega ao servidor falso (file/model/language + Bearer)',
    async () => {
      const posts = stt!.hits.filter((h) => h.path.endsWith('/audio/transcriptions'))
      // ≥ 1: com a "final rápida" (sttSettings.reusePartialFinal, padrão ligado) a parcial que já
      // transcreveu a fala inteira vira a final sem outra request
      assert(posts.length >= 1, `requests: ${posts.length} (parciais/final)`)
      const last = posts[posts.length - 1]
      assert(last.method === 'POST', last.method)
      assert(
        last.headers.authorization === `Bearer ${STT_KEY}`,
        `auth ${last.headers.authorization}`
      )
      for (const field of [
        'name="file"',
        'name="model"',
        'name="language"',
        'name="response_format"'
      ])
        assert(last.body.includes(field), `campo ausente: ${field}`)
      assert(last.body.includes('whisper-large-v3-turbo'), 'modelo')
      assert(
        last.body.includes('\r\npt\r\n') || last.body.includes('\r\npt-'),
        'language normalizado'
      )
      return `${posts.length} request(s) em /audio/transcriptions`
    }
  )

  await step('Esc cancela a gravação e descarta (rascunho intacto)', async () => {
    const before = await composerValue()
    await micButton().click()
    await recording().waitFor({ timeout: 15_000 })
    await waveform().waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await waveform().waitFor({ state: 'detached', timeout: 10_000 })
    await page.getByTestId('voice-draft').waitFor({ state: 'detached', timeout: 5000 })
    assert((await composerValue()) === before, `rascunho mudou: "${await composerValue()}"`)
    await shot('cancelado')
  })

  await step('Enviar durante a gravação → conclui e envia digitado + final', async () => {
    await composer().fill('Enviado:')
    const chat = (await call<any[]>('chats.list'))[0]
    const before = (await call<any[]>('sessions.messages', chat.mainSessionId)).length
    await micButton().click()
    await recording().waitFor({ timeout: 15_000 })
    await waitFor(
      async () =>
        (
          (await page
            .getByTestId('voice-partial')
            .innerText()
            .catch(() => '')) || ''
        ).includes(STT_TEXT.slice(0, 8)),
      20_000,
      'parcial no campo'
    )
    await page.getByTestId('composer-send').click()
    const want = `Enviado: ${STT_TEXT}`
    const sent = await waitFor(
      async () => {
        const msgs = await call<any[]>('sessions.messages', chat.mainSessionId)
        return msgs.length > before
          ? msgs.find((m) => m.message?.role === 'user' && m.message?.content === want)
          : null
      },
      20_000,
      'mensagem enviada com o texto final'
    )
    await page.getByTestId('voice-draft').waitFor({ state: 'detached', timeout: 5000 })
    assert((await composerValue()) === '', 'campo limpo')
    return `enviada: "${sent.message.content}"`
  })

  await step('microfone salvo inexistente → cai no padrão do sistema com aviso', async () => {
    const view = await call<any>('voice.settings.get')
    await call('voice.settings.set', 'audioInput', {
      ...view.audioInput,
      deviceId: 'microfone-que-nao-existe'
    })
    // as settings do composer são relidas no início de cada gravação
    await micButton().click()
    await recording().waitFor({ timeout: 15_000 })
    const notice = page.getByTestId('voice-notice')
    await notice.waitFor({ timeout: 10_000 })
    const txt = await notice.innerText()
    assert(/Microfone salvo não encontrado/.test(txt), `aviso: ${txt}`)
    await shot('microfone-ausente')
    await page.getByTestId('voice-cancel-button').click()
    await waveform().waitFor({ state: 'detached', timeout: 10_000 })
    await call('voice.settings.set', 'audioInput', { ...view.audioInput, deviceId: null })
    return txt
  })

  await app.close()
  await stt?.close()
  llm?.close()
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
  try {
    await stt?.close()
  } catch {
    /* */
  }
  process.exit(1)
})
