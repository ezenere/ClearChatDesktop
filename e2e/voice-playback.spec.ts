// Fala da chamada renderizada no motor de áudio REAL (o Chromium do Electron, num
// OfflineAudioContext — nada toca nos alto-falantes, sem microfone, sem rede, sem API paga):
// as vias de TTS do main geram os eventos de verdade (`synthesizeStream` com fetch falso — PCM do
// OpenRouter/Fish a 44,1 kHz e a 24 kHz em pedaços de tamanho arbitrário, inclusive ímpar —,
// as fatias da ElevenLabs por alinhamento e a frase de demora em bloco), passam pelo
// `TtsStreamRelay` e são tocadas pelo `UtteranceQueue`/`WebAudioPcmPlayer` do renderer (o código
// do app, só sem os tipos) com os pedaços chegando aos poucos durante a renderização. A saída tem
// que ser o PCM sintetizado amostra a amostra: nenhum estalo (salto/buraco/lixo) em lugar nenhum.
//
// Controle (informativo): o mesmo agendamento com o início dos nós EXATAMENTE no quadro — o que o
// player fazia até 2026-11-13 — mostra o defeito do Chromium (o fim de parte dos nós repete o
// áudio de 128 quadros antes): o "estalinho" contínuo que o usuário ouvia com o Fish Audio Drama 3.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run test:e2e:playback
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import type { VoiceCallUtteranceChunkEvent, VoiceCallUtteranceEvent } from '@shared/ipc'
import { normalizeTtsSettings, type TtsSettings } from '@shared/voice'
import { resetTtsPcmEndpoints, synthesizeBlock, synthesizeStream } from '../src/main/voice/tts.ts'
import { TtsStreamRelay } from '../src/main/voice/ttsStreamRelay.ts'
import { AlignedPcmSegmenter, speechUnits } from '../src/main/voice/alignedSegments.ts'
import { Pcm16MonoAligner } from '../src/main/voice/wav.ts'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-voice-playback'))

// ---------------- sinais (PCM16 mono) ----------------

/** Lcg determinístico (0..1). */
function lcg(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 0x100000000
  }
}

/**
 * Uma "frase" sintética: soma de senos (f0 + harmônicos, com vibrato) e envelope de 15 ms nas
 * pontas — como uma síntese de TTS, que começa e termina perto do zero.
 */
function sentencePcm(rate: number, ms: number, f0: number, seed: number): Int16Array {
  const n = Math.round((rate * ms) / 1000)
  const out = new Int16Array(n)
  const ramp = Math.round(rate * 0.015)
  const r = lcg(seed)
  const ph = [r(), r(), r()].map((p) => p * 2 * Math.PI)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const f = f0 * (1 + 0.02 * Math.sin(2 * Math.PI * 5 * t))
    const v =
      0.22 * Math.sin(2 * Math.PI * f * t + ph[0]) +
      0.1 * Math.sin(4 * Math.PI * f * t + ph[1]) +
      0.05 * Math.sin(6 * Math.PI * f * t + ph[2])
    const env = Math.min(1, i / ramp, (n - 1 - i) / ramp)
    out[i] = Math.round(v * Math.max(0, env) * 32767)
  }
  return out
}

const bytesOf = (s: Int16Array): Uint8Array => new Uint8Array(s.buffer, s.byteOffset, s.byteLength)

/** Corta bytes em pedaços de tamanho aleatório (ímpares inclusive — o corte da rede). */
function randomCuts(b: Uint8Array, seed: number, min = 1, max = 9000): Uint8Array[] {
  const r = lcg(seed)
  const out: Uint8Array[] = []
  for (let o = 0; o < b.length;) {
    const n = Math.min(b.length - o, min + Math.floor(r() * (max - min)))
    out.push(b.slice(o, o + n))
    o += n
  }
  return out
}

/** fetch falso do `/audio/speech`: devolve os pedaços do corpo com `content-type` dado. */
function streamingFetch(bodies: Uint8Array[][], contentType: string): typeof fetch {
  let i = 0
  return (async (_url: unknown, init?: RequestInit) => {
    const parts = bodies[i++ % bodies.length]
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        for (const p of parts) {
          await new Promise((r) => setImmediate(r))
          if (init?.signal?.aborted) {
            ctrl.error(new DOMException('aborted', 'AbortError'))
            return
          }
          ctrl.enqueue(p)
        }
        ctrl.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'content-type': contentType } })
  }) as typeof fetch
}

const ttsApi = (baseUrl: string, model: string): TtsSettings => {
  const stored = normalizeTtsSettings({
    backend: 'api',
    api: { providerId: 'p-tts', baseUrl, apiKey: 'sk-test', model, voice: null }
  })
  return { ...stored, api: { ...stored.api, baseUrl, apiKey: 'sk-test' } }
}

/** Evento como o renderer recebe (ordem de chegada). */
type Ev =
  { kind: 'utt'; ev: VoiceCallUtteranceEvent } | { kind: 'chunk'; ev: VoiceCallUtteranceChunkEvent }

/** Relay da chamada capturando os eventos na ordem (o que o IPC mandaria ao renderer). */
function capturingRelay(): { relay: TtsStreamRelay; events: Ev[] } {
  const events: Ev[] = []
  const relay = new TtsStreamRelay({
    emitUtterance: (ev) => events.push({ kind: 'utt', ev }),
    emitChunk: (ev) => events.push({ kind: 'chunk', ev })
  })
  return { relay, events }
}

async function drain(relay: TtsStreamRelay): Promise<void> {
  for (let i = 0; i < 400 && relay.liveCount; i++) await new Promise((r) => setTimeout(r, 5))
}

interface Scenario {
  name: string
  rate: number
  events: Ev[]
  /** O PCM esperado na saída, na ordem (as frases emendadas). */
  expected: Int16Array
}

/** OpenRouter (Fish Audio Drama 3 / ElevenLabs pelo OpenRouter): PCM em streaming por frase. */
async function httpScenario(name: string, rate: number, seed: number): Promise<Scenario> {
  resetTtsPcmEndpoints()
  const sentences = [
    sentencePcm(rate, 900, 190, seed),
    sentencePcm(rate, 1400, 170, seed + 1),
    sentencePcm(rate, 700, 210, seed + 2),
    sentencePcm(rate, 1200, 180, seed + 3)
  ]
  const bodies = sentences.map((s, k) => randomCuts(bytesOf(s), seed * 10 + k, 1, 6000))
  const { relay, events } = capturingRelay()
  const orig = globalThis.fetch
  globalThis.fetch = streamingFetch(bodies, `audio/pcm;rate=${rate};channels=1`)
  try {
    const settings = ttsApi('https://openrouter.ai/api/v1', 'fish-audio/drama-3')
    for (let k = 0; k < sentences.length; k++) {
      const ctl = new AbortController()
      const r = await relay.synth(ctl.signal, (s) =>
        synthesizeStream({ text: `frase ${k}`, settings }, { signal: s })
      )
      relay.emitUtterance({ id: `u${k + 1}`, audio: r.audio, mime: r.mime, kind: 'sentence' })
    }
    await drain(relay)
  } finally {
    globalThis.fetch = orig
  }
  return { name, rate, events, expected: concatPcm(sentences) }
}

/** Frase de demora (bloco PCM completo, `synthesizeBlock`) emendada entre frases em streaming. */
async function blockScenario(rate: number): Promise<Scenario> {
  resetTtsPcmEndpoints()
  const a = sentencePcm(rate, 800, 200, 41)
  const delay = sentencePcm(rate, 600, 230, 42)
  const b = sentencePcm(rate, 900, 175, 43)
  const { relay, events } = capturingRelay()
  const orig = globalThis.fetch
  globalThis.fetch = streamingFetch(
    [a, delay, b].map((s, k) => randomCuts(bytesOf(s), 70 + k, 1, 4000)),
    `audio/pcm;rate=${rate}`
  )
  try {
    const settings = ttsApi('https://openrouter.ai/api/v1', 'fish-audio/drama-3')
    const ctl = new AbortController()
    const r1 = await relay.synth(ctl.signal, (s) =>
      synthesizeStream({ text: 'a', settings }, { signal: s })
    )
    relay.emitUtterance({ id: 'u1', audio: r1.audio, mime: r1.mime, kind: 'sentence' })
    const blk = await synthesizeBlock({ text: 'Só mais um instante.', settings })
    relay.emitUtterance({ id: 'd1', audio: blk.audio, mime: blk.mime, kind: 'delay' })
    const r2 = await relay.synth(ctl.signal, (s) =>
      synthesizeStream({ text: 'b', settings }, { signal: s })
    )
    relay.emitUtterance({ id: 'u2', audio: r2.audio, mime: r2.mime, kind: 'sentence' })
    await drain(relay)
  } finally {
    globalThis.fetch = orig
  }
  return {
    name: `frase de demora em bloco (${rate} Hz)`,
    rate,
    events,
    expected: concatPcm([a, delay, b])
  }
}

/** ElevenLabs por WebSocket: UM áudio contínuo repartido em frases pelo alinhamento. */
async function alignedScenario(): Promise<Scenario> {
  const rate = 24_000
  const texts = ['Claro, já verifico.', 'O arquivo está na pasta src.', 'Quer que eu abra?']
  const full = sentencePcm(rate, 3600, 185, 77)
  const seg = new AlignedPcmSegmenter({ sampleRate: rate })
  const idx = texts.map((t) => seg.addSegment(speechUnits(t)))
  // alinhamento: as letras espalhadas pelo áudio (pausas entre as frases)
  const chars = [...texts.join(' ')]
  const msPer = 3600 / chars.length
  const { relay, events } = capturingRelay()
  const feeding = (async () => {
    // o áudio chega em pedaços; o alinhamento das letras já tocadas (+ um pouco à frente) junto
    let sentChars = 0
    let receivedMs = 0
    // os pedaços do socket passam pelo alinhador de amostras (como em `elevenlabsStream.ts`)
    const aligner = new Pcm16MonoAligner(1)
    for (const raw of randomCuts(bytesOf(full), 99, 1, 5000)) {
      const p = aligner.push(raw)
      seg.pushPcm(p)
      receivedMs += (p.length / 2 / rate) * 1000
      const upto = Math.min(chars.length, Math.floor((receivedMs + 300) / msPer))
      if (upto > sentChars) {
        const block = chars.slice(sentChars, upto)
        seg.pushAlignment({
          chars: block,
          charStartTimesMs: block.map((_, k) => k * msPer),
          charDurationsMs: block.map(() => msPer)
        })
        sentChars = upto
      }
      await new Promise((r) => setImmediate(r))
    }
    seg.finish()
  })()
  for (let k = 0; k < texts.length; k++) {
    const ctl = new AbortController()
    const r = await relay.synth(ctl.signal, async () => ({
      streaming: true as const,
      sampleRate: rate,
      model: 'eleven_flash_v2_5',
      backend: 'api' as const,
      t0: Date.now(),
      chunks: seg.stream(idx[k])
    }))
    relay.emitUtterance({ id: `u${k + 1}`, audio: r.audio, mime: r.mime, kind: 'sentence' })
  }
  await feeding
  await drain(relay)
  return { name: 'ElevenLabs WebSocket (fatias de um áudio só)', rate, events, expected: full }
}

function concatPcm(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// ---------------- renderização no Chromium ----------------

/** Página: o player do app (sem tipos) + o harness que renderiza num OfflineAudioContext. */
function harnessSource(): string {
  // script clássico (módulo ES não carrega de file://): os `export` saem, o resto é o código do app
  const player = stripTypeScriptTypes(
    readFileSync(join(ROOT, 'src/renderer/src/lib/voice/utteranceQueue.ts'), 'utf8')
  ).replace(/^export /gm, '')
  return `${player}
window.__render = async function (sc, opts) {
  const rate = sc.rate
  const frames = sc.expectedLen + Math.round(rate * 1.5)
  const off = new OfflineAudioContext(1, frames, rate)
  // contexto "ao vivo" sobre o offline: rodando, sem resume (o player não distingue)
  const legacy = !!opts.legacy
  const ctx = {
    get sampleRate() { return off.sampleRate },
    get currentTime() { return off.currentTime },
    state: 'running',
    resume: async () => {},
    destination: off.destination,
    createGain: () => off.createGain(),
    createBuffer: (c, n, r) => off.createBuffer(c, n, r),
    createBufferSource: () => {
      const node = off.createBufferSource()
      if (legacy) {
        // controle: o agendamento antigo (início EXATAMENTE no quadro)
        const start = node.start.bind(node)
        node.start = (when) => start(Math.round(when * rate) / rate)
      }
      return node
    }
  }
  const q = new UtteranceQueue({
    playerFactory: (audio, mime, stream) => {
      const r = pcmRateOf(mime)
      let source = stream
      if (!source) { source = new PcmStreamSource(r, audio); source.end() }
      return new WebAudioPcmPlayer(source, () => ctx)
    }
  })
  // os eventos chegam aos poucos (mais rápido que o tempo real, com pausas), durante a renderização
  const evs = sc.events.map((e) => e.kind === 'utt'
    ? { kind: 'utt', ev: { ...e.ev, audio: new Uint8Array(e.ev.audio) } }
    : { kind: 'chunk', ev: { ...e.ev, pcm: new Uint8Array(e.ev.pcm) } })
  let next = 0
  const step = 512 / rate
  const perStep = Math.max(1, Math.ceil(evs.length / ((sc.expectedLen / rate) / step / 1.6)))
  const deliver = () => {
    for (let k = 0; k < perStep && next < evs.length; k++, next++) {
      const e = evs[next]
      if (e.kind === 'utt') q.enqueue(e.ev)
      else q.pushChunk(e.ev)
    }
  }
  for (let t = step; t < frames / rate - step; t += step) {
    off.suspend(t).then(async () => {
      deliver()
      await new Promise((r) => setTimeout(r, 0))
      off.resume()
    })
  }
  deliver()
  await new Promise((r) => setTimeout(r, 0))
  const out = (await off.startRendering()).getChannelData(0)
  return Array.from(out)
}
document.title = 'pronto'
`
}

async function render(page: Page, sc: Scenario, legacy: boolean): Promise<Float32Array> {
  const plain = {
    rate: sc.rate,
    expectedLen: sc.expected.length,
    events: sc.events.map((e) =>
      e.kind === 'utt'
        ? { kind: 'utt', ev: { ...e.ev, audio: Array.from(e.ev.audio) } }
        : { kind: 'chunk', ev: { ...e.ev, pcm: Array.from(e.ev.pcm) } }
    )
  }
  const out = await page.evaluate(
    ([s, o]) =>
      (
        window as unknown as {
          __render: (s: unknown, o: unknown) => Promise<number[]>
        }
      ).__render(s, o),
    [plain, { legacy }] as const
  )
  return Float32Array.from(out)
}

/**
 * Compara a saída com o PCM esperado: começa no 1º quadro com som (o relógio põe a fala ~30 ms à
 * frente); a rampa de entrada da 1ª utterance (5 ms) fica de fora. Devolve os quadros errados.
 */
function compare(
  out: Float32Array,
  expected: Int16Array,
  rate: number
): {
  bad: number
  worst: number
  firstBad: number
  start: number
  tailNoise: number
  clicks: number
} {
  let start = 0
  while (start < out.length && out[start] === 0) start++
  const skip = Math.ceil((5 / 1000) * rate) + 1
  let bad = 0
  let worst = 0
  let firstBad = -1
  for (let i = skip; i < expected.length; i++) {
    const e = Math.abs(out[start + i] - expected[i] / 0x8000)
    if (e > 1e-3) {
      bad++
      if (firstBad < 0) firstBad = i
    }
    worst = Math.max(worst, e)
  }
  let tailNoise = 0
  for (let i = start + expected.length; i < out.length; i++)
    tailNoise = Math.max(tailNoise, Math.abs(out[i]))
  // estalos: saltos de uma amostra para a outra maiores que qualquer salto do próprio sinal
  let maxStep = 0
  for (let i = 1; i < expected.length; i++)
    maxStep = Math.max(maxStep, Math.abs(expected[i] - expected[i - 1]) / 0x8000)
  let clicks = 0
  for (let i = start + skip + 1; i < start + expected.length + 128 && i < out.length; i++)
    if (Math.abs(out[i] - out[i - 1]) > maxStep * 1.5 + 0.005) {
      clicks++
      i += 32 // um estalo = um evento
    }
  return { bad, worst, firstBad, start, tailNoise, clicks }
}

// ---------------- execução ----------------

async function main(): Promise<void> {
  mkdirSync(BASE, { recursive: true })
  const page1 = join(BASE, 'playback.html')
  writeFileSync(
    page1,
    `<!doctype html><meta charset="utf-8"><title>…</title><script src="./harness.js"></script>`
  )
  writeFileSync(join(BASE, 'harness.js'), harnessSource())
  const mainJs = join(BASE, 'playback-main.cjs')
  writeFileSync(
    mainJs,
    `const { app, BrowserWindow } = require('electron')
app.setPath('userData', ${JSON.stringify(join(BASE, 'user-data'))})
app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
  win.loadFile(${JSON.stringify(page1)})
})
app.on('window-all-closed', () => app.quit())
`
  )
  const scenarios: Scenario[] = [
    await httpScenario('OpenRouter / Fish Audio Drama 3 — PCM 44,1 kHz em streaming', 44_100, 3),
    await httpScenario('OpenRouter — PCM 24 kHz em streaming', 24_000, 5),
    await blockScenario(44_100),
    await alignedScenario()
  ]
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | null = null
  const failures: string[] = []
  try {
    app = await electron.launch({ args: ['--disable-gpu', mainJs], env, timeout: 60_000 })
    const page = await app.firstWindow()
    await page.waitForFunction(() => document.title === 'pronto', null, { timeout: 30_000 })
    for (const sc of scenarios) {
      const utts = sc.events.filter((e) => e.kind === 'utt').length
      const chunks = sc.events.filter((e) => e.kind === 'chunk').length
      const fixed = compare(await render(page, sc, false), sc.expected, sc.rate)
      const legacy = compare(await render(page, sc, true), sc.expected, sc.rate)
      const ok = fixed.bad === 0 && fixed.clicks === 0 && fixed.tailNoise < 1e-3
      console.log(
        `${ok ? '✔' : '✖'} ${sc.name}: ${utts} utterances, ${chunks} pedaços, ${sc.expected.length} amostras — ` +
          `estalos ${fixed.clicks}, quadros errados ${fixed.bad} (pior ${fixed.worst.toFixed(4)}), depois do fim ${fixed.tailNoise.toFixed(4)}` +
          ` · controle (início no quadro exato): ${legacy.clicks} estalos, ${legacy.bad} quadros errados (pior ${legacy.worst.toFixed(3)})`
      )
      if (!ok)
        failures.push(
          `${sc.name}: ${fixed.bad} quadros errados (1º em ${fixed.firstBad}, pior ${fixed.worst})`
        )
    }
  } finally {
    await app?.close().catch(() => undefined)
  }
  assert.deepEqual(
    failures,
    [],
    'a fala renderizada tem que ser o PCM sintetizado, amostra a amostra'
  )
  console.log('ok — reprodução sem estalos em todas as vias')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
