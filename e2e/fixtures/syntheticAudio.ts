// Sinais sintéticos determinísticos para os testes de voz (PCM16 mono, sem áudio real nem
// microfone): fala "vozeada" (trem de pulsos glotais filtrado por formantes, com envelope de
// sílabas e frication), estalos de teclado (rajada de ruído com decaimento exponencial + "toc"
// grave), ruído de fundo. Usados por `e2e/speechGate.test.ts` (portão contra digitação) e
// `e2e/voiceClicks.test.ts`.

/** Gerador congruente linear determinístico (0..1). */
export function lcg(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 0x100000000
  }
}

const dbToAmp = (db: number): number => Math.pow(10, db / 20)

/** Ruído branco com RMS `db` dBFS (float −1..1). */
export function whiteNoise(n: number, db: number, seed = 7): Float32Array {
  const r = lcg(seed)
  const amp = dbToAmp(db) * Math.sqrt(3)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * (2 * r() - 1)
  return out
}

/** Ressonador de 2 polos (formante) aplicado no lugar. */
function resonate(x: Float32Array, rate: number, f: number, bw: number): Float32Array {
  const r = Math.exp((-Math.PI * bw) / rate)
  const a1 = 2 * r * Math.cos((2 * Math.PI * f) / rate)
  const a2 = -r * r
  const out = new Float32Array(x.length)
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const y = (1 - r) * x[i] + a1 * y1 + a2 * y2
    out[i] = y
    y2 = y1
    y1 = y
  }
  return out
}

/** Normaliza para RMS `db` dBFS (no lugar). */
function toRms(x: Float32Array, db: number, from = 0, to = x.length): Float32Array {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  const rms = Math.sqrt(s / Math.max(1, to - from))
  if (rms > 0) {
    const k = dbToAmp(db) / rms
    for (let i = 0; i < x.length; i++) x[i] *= k
  }
  return x
}

export interface SpeechOptions {
  rate?: number
  /** Frequência fundamental (Hz) no começo e no fim de cada sílaba (entonação). */
  f0?: [number, number]
  /** Nível RMS das vogais (dBFS). */
  db?: number
  /** Sílabas (ms) e pausas entre elas (ms). */
  syllableMs?: [number, number]
  gapMs?: [number, number]
  seed?: number
}

/**
 * "Fala" vozeada sintética de `ms`: sílabas com trem de pulsos glotais (f0 variando) passado por 3
 * formantes que mudam a cada sílaba, envelope com ataque/queda de ~25 ms, um pouco de aspiração e
 * algumas consoantes fricativas (ruído agudo) — o bastante para ter a estrutura temporal de uma voz
 * (energia espalhada pelo período, sem estalos isolados).
 */
export function syntheticSpeech(ms: number, o: SpeechOptions = {}): Float32Array {
  const rate = o.rate ?? 16_000
  const n = Math.round((rate * ms) / 1000)
  const r = lcg(o.seed ?? 3)
  const [f0a, f0b] = o.f0 ?? [120, 95]
  const [sylMin, sylMax] = o.syllableMs ?? [140, 260]
  const [gapMin, gapMax] = o.gapMs ?? [30, 110]
  const out = new Float32Array(n)
  const vowels: [number, number, number][] = [
    [730, 1090, 2440], // a
    [530, 1840, 2480], // e
    [270, 2290, 3010], // i
    [570, 840, 2410], // o
    [300, 870, 2240] // u
  ]
  let t = 0
  let syl = 0
  while (t < n) {
    const len = Math.round((rate * (sylMin + r() * (sylMax - sylMin))) / 1000)
    const end = Math.min(n, t + len)
    const fric = syl % 3 === 1 // algumas sílabas começam com fricativa ("s", "ch")
    const exc = new Float32Array(end - t)
    let phase = 0
    for (let i = 0; i < exc.length; i++) {
      const f0 = f0a + ((f0b - f0a) * i) / exc.length
      phase += f0 / rate
      // pulso glotal (derivada do fluxo) suavizado + aspiração
      if (phase >= 1) {
        phase -= 1
        exc[i] += 1
        if (i + 1 < exc.length) exc[i + 1] -= 0.6
      }
      exc[i] += 0.02 * (2 * r() - 1)
    }
    const [f1, f2, f3] = vowels[syl % vowels.length]
    const v1 = resonate(exc, rate, f1, 90)
    const v2 = resonate(exc, rate, f2, 110)
    const v3 = resonate(exc, rate, f3, 160)
    const voice = new Float32Array(exc.length)
    for (let i = 0; i < exc.length; i++) voice[i] = v1[i] + 0.6 * v2[i] + 0.3 * v3[i]
    toRms(voice, o.db ?? -26)
    const fricLen = fric ? Math.round(rate * 0.06) : 0
    const fn = whiteNoise(exc.length, (o.db ?? -26) - 8, 11 + syl)
    const ramp = Math.round(rate * 0.025)
    for (let i = 0; i < exc.length; i++) {
      const env = Math.min(1, i / ramp, (exc.length - 1 - i) / ramp)
      out[t + i] = i < fricLen ? fn[i] * Math.min(1, i / ramp + 0.2) : voice[i] * Math.max(0, env)
    }
    syl++
    t = end + Math.round((rate * (gapMin + r() * (gapMax - gapMin))) / 1000)
  }
  return out
}

export interface TypingOptions {
  rate?: number
  /** Teclas por segundo (cada tecla = clique de descida + clique de subida). */
  keysPerSec?: number
  /** Pico do clique (dBFS). */
  peakDb?: number
  /** Constante de decaimento (ms) da rajada. */
  tauMs?: number
  /** "Toc" grave (ressonância do teclado/mesa): frequência e decaimento (ms); null = sem. */
  thump?: { hz: number; tauMs: number; db: number } | null
  seed?: number
}

/**
 * Digitação sintética de `ms`: a cada tecla (intervalo com jitter), um clique de descida (rajada de
 * ruído banda larga com decaimento exponencial + "toc" grave opcional) e, 50–110 ms depois, o de
 * subida (mais fraco).
 */
export function syntheticTyping(ms: number, o: TypingOptions = {}): Float32Array {
  const rate = o.rate ?? 16_000
  const n = Math.round((rate * ms) / 1000)
  const r = lcg(o.seed ?? 5)
  const out = new Float32Array(n)
  const tau = ((o.tauMs ?? 3) * rate) / 1000
  const peak = dbToAmp(o.peakDb ?? -14)
  const thump = o.thump === undefined ? { hz: 180, tauMs: 6, db: -22 } : o.thump
  const click = (at: number, k: number): void => {
    for (let i = 0; at + i < n && i < tau * 8; i++) {
      const e = Math.exp(-i / tau)
      out[at + i] += k * peak * e * (2 * r() - 1)
      if (thump) {
        const te = Math.exp(-i / ((thump.tauMs * rate) / 1000))
        out[at + i] += k * dbToAmp(thump.db) * te * Math.sin((2 * Math.PI * thump.hz * i) / rate)
      }
    }
  }
  const period = rate / (o.keysPerSec ?? 7)
  for (let t = Math.round(r() * period); t < n; t += Math.round(period * (0.6 + 0.8 * r()))) {
    click(t, 1)
    click(t + Math.round(rate * (0.05 + 0.06 * r())), 0.5)
  }
  return out
}

/** Soma sinais (o mais curto completa com zeros). */
export function mix(...parts: Float32Array[]): Float32Array {
  const n = Math.max(...parts.map((p) => p.length))
  const out = new Float32Array(n)
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i]
  return out
}

/** Concatena sinais. */
export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Float −1..1 → PCM16 LE (bytes). */
export function toPcm16(x: Float32Array): Uint8Array {
  const out = new Uint8Array(x.length * 2)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < x.length; i++) {
    const c = Math.max(-1, Math.min(1, x[i]))
    dv.setInt16(i * 2, Math.round(c * 32767), true)
  }
  return out
}
