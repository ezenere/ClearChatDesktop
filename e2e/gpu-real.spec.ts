/* eslint-disable @typescript-eslint/no-explicit-any */
// Verificação REAL do "Modo avançado (GPU local)" pelo app de verdade (Playwright + `e2e/launch.ts`):
// instala o runtime e os motores pedidos num userData ISOLADO (downloads reais: Python portátil,
// torch cu128, pesos do HF), sobe o servidor pelo main, sintetiza pelo caminho de áudio do app
// ("Testar voz" e o autoteste = `synthesizeStream`, o mesmo da chamada), transcreve uma sessão de
// ditado pelo whisper da GPU e confere que URL/token do servidor nunca chegam ao renderer.
// Opt-in (precisa de rede, GPU e ~15–30 GB de disco) — NÃO entra no `test:unit`.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   GPU_REAL_USER_DATA=/disco/grande/userdata \
//   GPU_REAL_INSTALL=omnivoice,whisper-large-v3-turbo \
//   GPU_REAL_TEST=omnivoice,whisper-large-v3-turbo \
//   CLEARCHAT_E2E_DIR=/tmp/gpu-real node e2e/gpu-real.spec.ts
//   (CLEARCHAT_GPU_PIP_CACHE=~/.cache/pip só acelera os downloads do pip — a instalação é do zero)
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-gpu-real'))
const USER_DATA = resolve(process.env.GPU_REAL_USER_DATA || join(BASE, 'userdata'))
const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
const INSTALL = list(process.env.GPU_REAL_INSTALL)
const TEST = list(process.env.GPU_REAL_TEST)

let app: ElectronApplication | null = null
let page: Page
const results: Record<string, unknown> = {}
const t0 = Date.now()
const log = (m: string): void =>
  console.log(`[gpu-real +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)

async function gpu<T>(method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([m, a]) => (window as any).api.voice.gpu[m as string](...(a as unknown[])),
    [method, args] as const
  ) as Promise<T>
}

async function status(): Promise<any> {
  return gpu('status')
}

/** Roda uma ação longa mostrando o progresso do evento `voice:gpu:progress`. */
async function withProgress(label: string, action: () => Promise<unknown>): Promise<number> {
  const start = Date.now()
  let last = ''
  const timer = setInterval(() => {
    void page
      .evaluate(() => (window as any).__gpuLast ?? null)
      .then((s: any) => {
        if (!s) return
        const rt = s.runtime?.progress
        const eng = (s.engines ?? []).find((e: any) => e.install?.progress)
        const p = eng?.install?.progress ?? rt
        const line = p ? `${eng ? eng.id : 'runtime'}: ${p.phase} ${p.pct ?? '?'}%` : ''
        if (line && line !== last) {
          last = line
          log(`  ${line}`)
        }
      })
      .catch(() => undefined)
  }, 2000)
  try {
    await action()
  } finally {
    clearInterval(timer)
  }
  const ms = Date.now() - start
  log(`${label}: ${(ms / 1000).toFixed(0)} s`)
  return ms
}

async function setVoice(
  kind: 'ttsSettings' | 'sttSettings',
  patch: Record<string, unknown>
): Promise<void> {
  await page.evaluate(
    async ([k, p]) => {
      const api = (window as any).api.voice
      const cur = (await api.settings.get())[k as string]
      await api.settings.set(k, { ...cur, ...(p as object) })
    },
    [kind, patch] as const
  )
}

/** PCM16 24 kHz (WAV) → PCM16 16 kHz (interpolação linear) para a sessão de transcrição. */
function wavTo16k(wav: Uint8Array): Uint8Array {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  const sr = dv.getUint32(24, true)
  const pcm = new Int16Array(
    wav.buffer.slice(
      wav.byteOffset + 44,
      wav.byteOffset + wav.byteLength - ((wav.byteLength - 44) % 2)
    )
  )
  const n = Math.floor((pcm.length * 16000) / sr)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * sr) / 16000
    const a = Math.floor(x)
    const f = x - a
    out[i] = Math.round((pcm[a] ?? 0) * (1 - f) + (pcm[a + 1] ?? pcm[a] ?? 0) * f)
  }
  return new Uint8Array(out.buffer)
}

async function main(): Promise<void> {
  mkdirSync(BASE, { recursive: true })
  mkdirSync(USER_DATA, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  env.CLEARCHAT_USER_DATA = USER_DATA
  // GPU_REAL_EXECUTABLE=dist/linux-unpacked/clearchat → o app EMPACOTADO (server.py fora do asar)
  const exe = process.env.GPU_REAL_EXECUTABLE
  app = await launchElectron(
    exe
      ? { executablePath: resolve(exe), args: [], env, timeout: 60_000 }
      : { args: [ROOT], env, timeout: 60_000 }
  )
  const mainLog = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(mainLog)
  app.process().stderr?.pipe(mainLog)
  page = await app.firstWindow()
  await page.waitForFunction(() => !!(window as any).api?.voice?.gpu, null, { timeout: 30_000 })
  await page.evaluate(() => {
    ;(window as any).__gpuEvents = 0
    ;(window as any).api.onVoiceGpuProgress((s: unknown) => {
      ;(window as any).__gpuLast = s
      ;(window as any).__gpuEvents++
    })
  })

  const s0 = await status()
  log(
    `status: ${s0.platform.os}/${s0.platform.arch}, disco livre ${s0.platform.diskFreeMb} MB, GPUs: ${s0.gpus.map((g: any) => `${g.name} ${g.vramTotalMb} MB (livre ${g.vramFreeMb}) driver ${g.driver} CUDA ${g.cudaMax}`).join('; ')}`
  )
  log(
    `runtime: ${s0.runtime.state} · compat ${s0.runtime.compat?.level} ${JSON.stringify(s0.runtime.compat?.reasons)}`
  )
  for (const e of s0.engines)
    log(
      `  ${e.id}: ${e.install.state} · compat ${e.compat.level} · ${e.sizeMb} MB · voices ${e.voices.length}`
    )
  results.statusBefore = { runtime: s0.runtime, gpus: s0.gpus, platform: s0.platform }

  // cancelar e retomar (GPU_REAL_CANCEL=<motor>): remove o motor, instala, cancela no meio dos
  // pesos, confere o estado e instala de novo (o HF retoma o que já baixou)
  const cancelId = process.env.GPU_REAL_CANCEL
  if (cancelId) {
    await gpu('removeEngine', cancelId)
    const freed = (await status()).engines.find((e: any) => e.id === cancelId)
    log(`${cancelId} removido: ${freed.install.state}`)
    const started = page.evaluate((id) => (window as any).api.voice.gpu.installEngine(id), cancelId)
    await page.waitForFunction(
      (id) => {
        const s = (window as any).__gpuLast
        const e = s?.engines?.find((x: any) => x.id === id)
        return (
          (e?.install?.progress?.phase ?? '').startsWith('Baixando') && e.install.progress.pct >= 45
        )
      },
      cancelId,
      { timeout: 600_000, polling: 200 }
    )
    await gpu('cancel')
    await started
    const afterCancel = (await status()).engines.find((e: any) => e.id === cancelId)
    results.cancel = { state: afterCancel.install.state, error: afterCancel.install.error }
    log(`cancelado: ${JSON.stringify(results.cancel)}`)
    results.resumeMs = await withProgress(`${cancelId} reinstalado (retomando)`, () =>
      gpu('installEngine', cancelId)
    )
  }
  if (INSTALL.length && s0.runtime.state !== 'installed') {
    results.runtimeInstallMs = await withProgress('runtime instalado', () => gpu('installRuntime'))
  }
  for (const id of INSTALL) {
    const st = (await status()).engines.find((e: any) => e.id === id)
    if (st?.install.state === 'installed') {
      log(`${id}: já instalado`)
      continue
    }
    results[`install_${id}_ms`] = await withProgress(`${id} instalado`, () =>
      gpu('installEngine', id)
    )
  }
  results.progressEvents = await page.evaluate(() => (window as any).__gpuEvents)
  const s1 = await status()
  results.runtime = s1.runtime
  results.engines = s1.engines.map((e: any) => ({
    id: e.id,
    state: e.install.state,
    error: e.install.error,
    compat: e.compat,
    voices: e.voices
  }))
  log(`runtime: ${s1.runtime.state} ${s1.runtime.sizeMb} MB`)

  if (TEST.some((x) => x !== 'whisper-large-v3-turbo')) {
    const cc0 = await gpu<{ id: string }>('downloadCc0Voice')
    log(`voz CC0: ${cc0.id}`)
  }

  const stt = TEST.includes('whisper-large-v3-turbo')
  if (stt) await setVoice('sttSettings', { mode: 'gpu' })
  for (const id of TEST) {
    if (id === 'whisper-large-v3-turbo') continue
    const r: Record<string, unknown> = {}
    await setVoice('ttsSettings', { backend: 'gpu', gpu: { engine: id, voice: null } })
    const tStart = Date.now()
    await gpu('startServer', stt ? [id, 'whisper-large-v3-turbo'] : [id])
    r.startServerMs = Date.now() - tStart
    log(`${id}: servidor no ar + modelos carregados em ${r.startServerMs} ms`)
    // "Testar voz" (WAV completo pelo caminho de API do app)
    const tests: number[] = []
    let wav: Uint8Array | null = null
    for (let i = 0; i < 3; i++) {
      const t = Date.now()
      const res = await page.evaluate(async () => {
        const out = await (window as any).api.voice.tts.test({
          text: 'Claro, já vou verificar isso para você agora.'
        })
        return {
          ms: out.ms,
          mime: out.mime,
          len: out.audio.length,
          audio: Array.from(out.audio as Uint8Array)
        }
      })
      tests.push(Date.now() - t)
      wav = new Uint8Array(res.audio)
      r.testMime = res.mime
      r.testBytes = res.len
    }
    r.testVozMs = tests
    if (wav) writeFileSync(join(BASE, `${id}.wav`), wav)
    // autoteste (synthesizeStream — o caminho da chamada) com transcrição de volta
    r.selfTest = await gpu('selfTest', id)
    log(`${id}: Testar voz ${tests.join('/')} ms · autoteste ${JSON.stringify(r.selfTest)}`)
    // ditado/transcrição pela sessão real (whisper da GPU) com o áudio sintetizado
    if (stt && wav) {
      const pcm = wavTo16k(wav)
      const tr = await page.evaluate(async (bytes) => {
        const v = (window as any).api.voice
        const id = await v.transcribe.start('pt-BR')
        const u8 = new Uint8Array(bytes)
        for (let o = 0; o < u8.length; o += 6400)
          await v.transcribe.push(id, u8.slice(o, o + 6400), 16000)
        const t = performance.now()
        const out = await v.transcribe.stop(id, { reusePartial: false })
        return { ...out, stopMs: Math.round(performance.now() - t) }
      }, Array.from(pcm))
      r.sttSession = tr
      log(
        `${id}: transcrição (sessão, GPU): "${tr.text}" em ${tr.stopMs} ms (backend ${tr.backend})`
      )
    }
    // voz do usuário (GPU_REAL_VOICE=1): o áudio sintetizado vira uma "voz gravada" — transcrição
    // automática pelo whisper da GPU, `addUserVoice` e síntese clonando essa voz
    if (process.env.GPU_REAL_VOICE === '1' && wav && id !== 'vibevoice-realtime') {
      const audio = Array.from(wav)
      const out = await page.evaluate(
        async ([bytes, engine]) => {
          const v = (window as any).api.voice
          void bytes
          // amostra de ~7 s (a voz precisa de 3–30 s; a frase do teste tem ~3 s)
          const sample = await v.tts.test({
            text: 'Olá! Esta é uma gravação de teste para clonar a minha voz. Eu falo devagar e com calma, para o modelo aprender o timbre.'
          })
          const ab = (sample.audio as Uint8Array).slice().buffer
          const tr = await v.gpu.transcribe({ audio: ab })
          const { id: vid } = await v.gpu.addUserVoice({
            name: `Teste ${engine}`,
            audio: ab,
            transcript: tr.text
          })
          const t = performance.now()
          const syn = await v.tts.test({ voice: vid, text: 'Esta é a minha voz clonada.' })
          const ms = Math.round(performance.now() - t)
          const st = await v.gpu.status()
          const listed = st.engines
            .find((e: any) => e.id === engine)
            .voices.some((x: any) => x.id === vid)
          await v.gpu.removeUserVoice(vid)
          return { transcript: tr.text, vid, ms, bytes: syn.audio.length, listed }
        },
        [audio, id] as const
      )
      r.userVoice = out
      log(`${id}: voz do usuário ${JSON.stringify(out)}`)
    }
    const st = await status()
    r.server = st.server
    results[id] = r
    await gpu('stopServer')
  }
  if (stt) {
    results['whisper-large-v3-turbo'] = {
      selfTest: await gpu('selfTest', 'whisper-large-v3-turbo')
    }
    log(`whisper: autoteste ${JSON.stringify(results['whisper-large-v3-turbo'])}`)
    await gpu('stopServer')
  }

  // o token/URL do servidor nunca aparecem no que o renderer vê
  const visible = await page.evaluate(async () => {
    const v = (window as any).api.voice
    return JSON.stringify([
      await v.settings.get(),
      await v.gpu.status(),
      await v.runtime?.status?.()
    ])
  })
  results.leak = /127\.0\.0\.1:\d+|Bearer /.test(visible)
  log(`vazamento de URL/token para o renderer: ${results.leak ? 'SIM (ERRO)' : 'não'}`)
  results.logTail = (await gpu<string>('log')).split('\n').slice(-20).join('\n')
}

main()
  .then(() => {
    writeFileSync(join(BASE, 'results.json'), JSON.stringify(results, null, 2))
    log(`ok — resultados em ${join(BASE, 'results.json')}`)
  })
  .catch((e) => {
    writeFileSync(
      join(BASE, 'results.json'),
      JSON.stringify({ ...results, error: String(e) }, null, 2)
    )
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await app?.close().catch(() => undefined)
  })
