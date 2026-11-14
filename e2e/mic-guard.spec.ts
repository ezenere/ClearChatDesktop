/* eslint-disable @typescript-eslint/no-explicit-any */
// Prova da guarda do microfone (`e2e/launch.ts` + `e2e/micGuard.cjs`): nenhum teste automático abre
// o microfone real.
//   - main próprio (o caminho dos specs do mock) no modo `deny`: getUserMedia → NotAllowedError, a
//     lista de dispositivos sem rótulo; um handler que o "app" instala depois (concede tudo) não
//     libera a mídia; uma sessão nova (partição) também nasce guardada;
//   - o mesmo no modo `fake`: a lista só tem "Fake …" (conferido ANTES de pedir o microfone) e o
//     getUserMedia entrega a faixa do dispositivo falso;
//   - o app real buildado (userData isolado, sync num endereço morto): getUserMedia recusado e
//     Configurações → Áudio aberta (medidor/lista de dispositivos) sem nenhuma faixa de verdade.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run test:e2e:mic-guard     (ou: npm run build && node e2e/mic-guard.spec.ts)
import type { ElectronApplication, Page } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { APP_ROOT, launchElectron, type MicMode } from './launch.ts'

const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-mic-guard'))
const results: { name: string; ok: boolean; info?: string }[] = []
let app: ElectronApplication | null = null
/** Janela do passo atual (screenshot quando falha). */
let current: Page | null = null

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n').slice(0, 6).join('\n')}`)
    await current
      ?.screenshot({ path: join(BASE, `FAIL-${name.replace(/[^\w]+/g, '_')}.png`) })
      .catch(() => {})
  }
  current = null
}

interface Device {
  kind: string
  label: string
}

const devices = (page: Page): Promise<Device[]> =>
  page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices()).map((d) => ({ kind: d.kind, label: d.label }))
  )

/** Nenhuma entrada de áudio com rótulo de verdade (vazio = permissão negada; "Fake …" = falso). */
function assertNoRealInput(list: Device[]): void {
  const real = list.filter((d) => d.kind === 'audioinput' && d.label && !/^Fake\b/.test(d.label))
  assert.equal(real.length, 0, `dispositivo real visível: ${real.map((d) => d.label).join(', ')}`)
}

type Gum = { ok: true; labels: string[] } | { ok: false; name: string }

const getUserMedia = (page: Page): Promise<Gum> =>
  page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const labels = s.getAudioTracks().map((t) => t.label)
      s.getTracks().forEach((t) => t.stop())
      return { ok: true as const, labels }
    } catch (e) {
      return { ok: false as const, name: (e as Error).name }
    }
  })

function writeMain(dir: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'page.html'), '<!doctype html><title>mic</title><body>mic</body>')
  const mainJs = join(dir, 'main.cjs')
  writeFileSync(
    mainJs,
    `const { app, BrowserWindow } = require('electron')
const { join } = require('path')
app.setPath('userData', join(__dirname, 'user-data'))
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 300, show: false })
  win.loadFile(join(__dirname, 'page.html'))
})
app.on('window-all-closed', () => app.quit())
`
  )
  return mainJs
}

async function ownMain(mic: MicMode): Promise<string> {
  const mainJs = writeMain(join(BASE, `main-${mic}`))
  app = await launchElectron({ args: [mainJs], mic })
  try {
    return await ownChecks(app, mic)
  } finally {
    await app.close().catch(() => {})
    app = null
  }
}

async function ownChecks(app: ElectronApplication, mic: MicMode): Promise<string> {
  const page = (current = await app.firstWindow())
  await page.waitForLoadState('domcontentloaded')
  const before = await devices(page)
  assertNoRealInput(before) // antes de pedir o microfone
  const gum = await getUserMedia(page)
  let info: string
  if (mic === 'deny') {
    assert.deepEqual(gum, { ok: false, name: 'NotAllowedError' })
    assert(
      before.filter((d) => d.kind === 'audioinput').every((d) => d.label === ''),
      'rótulos visíveis com a mídia negada'
    )
    // o "app" troca o handler por um que concede tudo: a mídia continua negada
    await app.evaluate(({ session }) => {
      session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(true))
      session.defaultSession.setPermissionCheckHandler(() => true)
    })
    assert.deepEqual(await getUserMedia(page), { ok: false, name: 'NotAllowedError' })
    assertNoRealInput(await devices(page))
    // sessão nova (partição): já nasce guardada
    const guarded = await app.evaluate(({ session }) =>
      (globalThis as any).__clearchatMicGuard.isGuarded(session.fromPartition('mic-guard-test'))
    )
    assert(guarded, 'partição nova sem a guarda')
    info = 'NotAllowedError, sem rótulos; handler trocado e partição nova continuam negando'
  } else {
    assert(gum.ok, `getUserMedia falhou no modo fake: ${!gum.ok && gum.name}`)
    assert(gum.labels.length > 0 && gum.labels.every((l) => /^Fake\b/.test(l)), gum.labels.join())
    const ins = before.filter((d) => d.kind === 'audioinput')
    assert(ins.length > 0 && ins.every((d) => /^Fake\b/.test(d.label)), 'lista com o falso')
    info = `faixa "${gum.labels.join(', ')}"; lista: ${ins.map((d) => d.label).join(', ')}`
  }
  return info
}

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })

  await step('main próprio (caminho do mock), modo deny: getUserMedia recusado', () =>
    ownMain('deny')
  )
  await step('main próprio, modo fake: só o dispositivo falso do Chromium', () => ownMain('fake'))

  await step('launch recusa o app real sem userData isolado', async () => {
    const env = { ...process.env, CLEARCHAT_USER_DATA: '' }
    await assert.rejects(launchElectron({ args: [APP_ROOT], env }), /CLEARCHAT_USER_DATA/)
    const real = join(process.env.HOME ?? '', '.config', 'ClearChat')
    await assert.rejects(
      launchElectron({ args: [APP_ROOT], env: { ...process.env, CLEARCHAT_USER_DATA: real } }),
      /dados reais/
    )
  })

  await step(
    'app real: getUserMedia recusado, Configurações → Áudio sem faixa de verdade',
    async () => {
      const env: Record<string, string | undefined> = { ...process.env }
      delete env.OPENROUTER_API_KEY
      env.CLEARCHAT_USER_DATA = join(BASE, 'user-data')
      env.CLEARCHAT_SYNC_URL = 'http://127.0.0.1:9'
      app = await launchElectron({ args: [APP_ROOT], env })
      const page = (current = await app.firstWindow())
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
      assertNoRealInput(await devices(page))
      assert.deepEqual(await getUserMedia(page), { ok: false, name: 'NotAllowedError' })
      // sai da tela de boas-vindas: um provedor (endereço morto, nada vai à rede)
      await page.evaluate(async () => {
        const api = (window as any).api
        const p = await api.providers.create({
          name: 'Falso',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-fake'
        })
        await api.settings.set('defaultProviderId', p.id)
      })
      await page.reload()
      await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
      await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 20_000 })
      // registra tudo que o próprio app pedir ao abrir o Áudio (medidor, lista de dispositivos)
      await page.evaluate(() => {
        const md = navigator.mediaDevices
        const orig = md.getUserMedia.bind(md)
        const log: string[] = ((window as any).__gum = [])
        md.getUserMedia = async (c) => {
          try {
            const s = await orig(c)
            log.push(...s.getAudioTracks().map((t) => `faixa:${t.label}`))
            return s
          } catch (e) {
            log.push(`erro:${(e as Error).name}`)
            throw e
          }
        }
      })
      await page.keyboard.press('Control+,')
      await page.getByRole('dialog').getByRole('button', { name: 'Áudio', exact: true }).click()
      await page.getByTestId('audio-settings').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(1500)
      const log: string[] = await page.evaluate(() => (window as any).__gum)
      const tracks = log.filter((l) => l.startsWith('faixa:'))
      assert.equal(tracks.length, 0, `faixas abertas: ${tracks.join(', ')}`)
      assertNoRealInput(await devices(page))
      return log.length ? `o app pediu e levou: ${[...new Set(log)].join(', ')}` : 'o app não pediu'
    }
  )
  await app?.close().catch(() => {})
  app = null

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passos ok`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
}

main().catch(async (e) => {
  console.error(e)
  await app?.close().catch(() => {})
  process.exit(1)
})
