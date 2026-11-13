// Portão de ativação de fala na frente da transcrição (PURO — sem Electron/fs; o mobile pode
// vendorar). O whisper "alucina" em silêncio/ruído ("Tchau.", "Obrigado.", "Legendas pela
// comunidade Amara.org") — numa chamada um "tchau" inventado pode até encerrar a ligação. Então:
//   1. só vai ao STT o trecho com FALA de verdade: cada quadro de 20 ms tem o nível (dBFS) medido
//      contra o nível de ativação absoluto (`audioInput.activationDb`, local do dispositivo) E o
//      piso de ruído adaptativo + margem; um trecho com menos de `MIN_VOICED_MS` de voz é
//      descartado sem chamar o STT, e o que vai é aparado (silêncio antes/depois, com folga);
//   2. pós-filtro: o resultado que é só uma alucinação conhecida com pouca voz (ou palavras demais
//      para a voz que houve) vira texto vazio; a mesma frase grudada no FIM de uma transcrição
//      maior, sem uma "ilha" de voz própria no fim do áudio, é removida;
//   3. estalos (teclado, batidas) não são voz: quadro impulsivo e sequência curta não contam (ver
//      "transientes impulsivos") — digitar nunca soma voz para ir ao STT nem segura uma alucinação;
//   4. na fala que interrompeu o assistente (barge-in), alucinação conhecida no começo/fim sai
//      sempre (`stripBargeInHallucinations`, aplicada pela chamada).
// Consumo: `src/main/voice/session.ts` (todas as vias — parciais, segmentos, especulação e a final;
// ditado e chamada). Ver SPEC.md → "Áudio → Portão de ativação de fala".

// ---------------- nível de ativação (sensibilidade — `audioInput.activationDb`) ----------------

/** Nível de ativação padrão (dBFS de RMS): abaixo disto nunca é fala. */
export const DEFAULT_ACTIVATION_DB = -45
/** Faixa aceita do nível de ativação (fora dela o valor é preso no limite). */
export const ACTIVATION_DB_RANGE = { min: -70, max: -20 } as const

/** Nível de ativação normalizado (lixo → `DEFAULT_ACTIVATION_DB`; preso na faixa; inteiro). */
export function normalizeActivationDb(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_ACTIVATION_DB
  return Math.min(ACTIVATION_DB_RANGE.max, Math.max(ACTIVATION_DB_RANGE.min, Math.round(v)))
}

/** RMS (0..1) → dBFS (piso de −120 dB para o silêncio digital). */
export function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(1e-6, Number.isFinite(rms) ? Math.abs(rms) : 0))
}

/** dBFS → RMS (0..1). */
export function dbToRms(db: number): number {
  return Math.pow(10, db / 20)
}

// ---------------- portão ----------------

/** Quadro de análise (ms). */
export const GATE_FRAME_MS = 20
/** Margem (dB) sobre o piso de ruído para um quadro contar como voz. */
export const NOISE_MARGIN_DB = 10
/** Piso de ruído inicial (dBFS) — sala silenciosa; ele se adapta aos quadros sem fala. */
export const INITIAL_NOISE_FLOOR_DB = -65
/** Voz mínima (ms de quadros acima do limiar) para um trecho ir ao STT. */
export const MIN_VOICED_MS = 280
/** Folga mantida antes do 1º e depois do último quadro com voz ao aparar (ms). */
export const GATE_PAD_BEFORE_MS = 200
export const GATE_PAD_AFTER_MS = 300
/** Lacunas menores que isto (ms) não separam "ilhas" de voz. */
const ISLAND_MERGE_MS = 150
/** Pausa (ms) que separa a última ilha de voz e duração mínima dela para ser uma fala própria. */
export const FINAL_ISLAND_GAP_MS = 250
export const FINAL_ISLAND_MIN_MS = 250

// ---------------- transientes impulsivos (teclado, batidas, cliques) ----------------
//
// O nível (RMS) de um quadro não separa fala de um estalo: uma tecla batida perto do microfone tem
// o RMS de uma fala em voz baixa — digitar durante a chamada abaixava a resposta, virava barge-in e
// o whisper "transcrevia" o barulho como "Tchau." (2026-11-13). Duas regras baratas e
// determinísticas, as MESMAS no portão do STT (main/celular) e na detecção da chamada (renderer):
//   1. quadro IMPULSIVO não é fala: a energia está num estalo curto e o resto do quadro é
//      silêncio/ruído — energia média dos sub-blocos de `IMPULSE_SUBBLOCK_MS` ≥
//      `IMPULSE_MEAN_OVER_MEDIAN_DB` acima da mediana (a fala — vogais, consoantes sustentadas —
//      espalha a energia pelo quadro: ~3–7 dB; uma tecla: 15–30 dB) E 80 % dela em até
//      `IMPULSE_MAX_SPAN_MS` (o fim de uma vogal no meio do quadro também concentra, mas não cabe);
//   2. fala é SUSTENTADA: só conta depois de `MIN_SPEECH_RUN_MS` seguidos de quadros com nível de
//      fala e não impulsivos, com a energia espalhada pela janela e SEM estar morrendo (o último
//      quadro a no máximo `SPEECH_RUN_MAX_DECAY_DB` abaixo do mais forte — o "toc" grave de uma
//      tecla ressoa um pouco e some; o começo de uma sílaba sobe e fica); com a fala confirmada,
//      pausas de até `SPEECH_RUN_HOLD_MS` (entre sílabas) não exigem nova confirmação — um estalo
//      exige.

/** Sub-bloco (ms) da análise de impulso de um quadro. */
export const IMPULSE_SUBBLOCK_MS = 2
/** Energia média ÷ mediana dos sub-blocos (dB) a partir da qual o quadro é um estalo. */
export const IMPULSE_MEAN_OVER_MEDIAN_DB = 10
/** …e a energia ainda cabe em até tanto (ms — `IMPULSE_ENERGY_SHARE` dela): um estalo é curto. */
export const IMPULSE_MAX_SPAN_MS = 6
export const IMPULSE_ENERGY_SHARE = 0.8
/** Sequência mínima (ms) de quadros com nível de fala, não impulsivos, para virar fala. */
export const MIN_SPEECH_RUN_MS = 60
/** Lacuna (ms) tolerada dentro de uma fala já confirmada sem exigir nova confirmação. */
export const SPEECH_RUN_HOLD_MS = 150
/** Queda máxima (dB) do último quadro da janela em relação ao mais forte para confirmar a fala. */
export const SPEECH_RUN_MAX_DECAY_DB = 12

/** Energia (soma dos quadrados) de cada sub-bloco de `IMPULSE_SUBBLOCK_MS` (o resto fica fora). */
export function subblockEnergies(samples: ArrayLike<number>, sampleRate: number): Float64Array {
  const sub = Math.max(1, Math.round((sampleRate * IMPULSE_SUBBLOCK_MS) / 1000))
  const blocks = Math.floor(samples.length / sub)
  const out = new Float64Array(Math.max(0, blocks))
  for (let b = 0, i = 0; b < blocks; b++) {
    let s = 0
    for (const end = i + sub; i < end; i++) s += samples[i] * samples[i]
    out[b] = s
  }
  return out
}

/**
 * Quão impulsivo é o quadro: energia média ÷ mediana dos sub-blocos, em dB (0 = energia espalhada;
 * independente da escala das amostras). Menos de 4 sub-blocos ou quadro mudo → 0.
 */
export function impulseRatioDb(energies: Float64Array): number {
  const n = energies.length
  if (n < 4) return 0
  let total = 0
  for (let i = 0; i < n; i++) total += energies[i]
  const mean = total / n
  if (!(mean > 0)) return 0
  const sorted = energies.slice().sort()
  const median = n % 2 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
  return 10 * Math.log10(mean / Math.max(median, mean * 1e-6))
}

/**
 * Duração (ms) que concentra `IMPULSE_ENERGY_SHARE` da energia do quadro (os sub-blocos mais
 * fortes, somados até lá): um estalo cabe em poucos ms; o fim de uma vogal que acaba no meio do
 * quadro, não.
 */
export function energySpanMs(energies: Float64Array): number {
  let total = 0
  for (let i = 0; i < energies.length; i++) total += energies[i]
  if (!(total > 0)) return 0
  const sorted = energies.slice().sort().reverse()
  let acc = 0
  let k = 0
  while (k < sorted.length && acc < total * IMPULSE_ENERGY_SHARE) acc += sorted[k++]
  return k * IMPULSE_SUBBLOCK_MS
}

/** As energias dos sub-blocos são de um estalo (concentradas E curtas)? */
export function isImpulsiveEnergies(energies: Float64Array): boolean {
  return (
    impulseRatioDb(energies) >= IMPULSE_MEAN_OVER_MEDIAN_DB &&
    energySpanMs(energies) <= IMPULSE_MAX_SPAN_MS
  )
}

/** O quadro (amostras em qualquer escala — float −1..1 ou PCM16) é um estalo, não fala? */
export function isImpulsiveFrame(samples: ArrayLike<number>, sampleRate: number): boolean {
  return isImpulsiveEnergies(subblockEnergies(samples, sampleRate))
}

/** Resultado da análise de um trecho do buffer (bytes de PCM16). */
export interface GateAnalysis {
  /** Voz no trecho (ms de quadros acima do limiar). */
  voicedMs: number
  /** O que mandar ao STT (aparado com folga); null = voz de menos — não chama o STT. */
  send: { start: number; end: number } | null
  /** Silêncio (abaixo do limiar) depois do último quadro com voz até o fim do trecho (ms). */
  tailQuietMs: number
  /** O fim do áudio tem uma "ilha" de voz própria (pausa antes + duração mínima). */
  finalIsland: boolean
}

/**
 * Decisão de fala de UM quadro de nível (a regra única — o portão do STT no main/celular e a
 * detecção de fala da chamada no renderer usam a MESMA): nível (dBFS) ≥ `max(ativação, piso +
 * 10 dB)`, o quadro não é um estalo e a sequência de quadros assim já tem `MIN_SPEECH_RUN_MS` com a
 * energia espalhada (ver "transientes impulsivos" — com as amostras, `pushSamples`; só com o nível,
 * `pushRms`/`pushDb` aplicam a sequência mínima e o estalo que o chamador informar); o piso desce
 * rápido (silêncio de verdade) e sobe em ~1 s só com os quadros abaixo do limiar. Ruído constante
 * abaixo da ativação nunca é fala; ruído acima dela é caso do nível de ativação (Configurações →
 * Áudio). As taxas são por 20 ms e escalam com a duração do quadro (`frameMs`).
 */
export class LevelGate {
  readonly activationDb: number
  #floorDb: number
  /** Sequência atual de quadros com nível de fala e não impulsivos (ms / quadros). */
  #runMs = 0
  #runFrames = 0
  /** Os quadros mais recentes da sequência (a janela da confirmação): duração, nível, energias. */
  #runWindow: { ms: number; db: number; e: Float64Array | null }[] = []
  /** A sequência atual já é fala. */
  #confirmed = false
  /** Tempo desde o último quadro com nível de fala não impulsivo (ms). */
  #gapMs = 0
  #backfill = 0

  constructor(opts: { activationDb?: number; noiseFloorDb?: number } = {}) {
    this.activationDb = normalizeActivationDb(opts.activationDb)
    this.#floorDb =
      typeof opts.noiseFloorDb === 'number' && Number.isFinite(opts.noiseFloorDb)
        ? opts.noiseFloorDb
        : INITIAL_NOISE_FLOOR_DB
  }

  /** Piso de ruído estimado agora (dBFS). */
  get noiseFloorDb(): number {
    return this.#floorDb
  }

  /** Limiar de fala agora (dBFS). */
  get thresholdDb(): number {
    return Math.max(this.activationDb, this.#floorDb + NOISE_MARGIN_DB)
  }

  /**
   * Quadros ANTERIORES ao último `push` que a confirmação da sequência acabou de tornar fala (o
   * começo da sílaba, ainda não contado) — o portão do STT os marca de volta; 0 nos demais quadros.
   */
  get backfillFrames(): number {
    return this.#backfill
  }

  /**
   * Um quadro de `db` dBFS com `frameMs` de duração: é fala? (e atualiza o piso). `impulsive` = o
   * quadro é um estalo (`isImpulsiveFrame`); `energies` = as energias dos sub-blocos dele
   * (`subblockEnergies`) — com elas a sequência só confirma com a energia espalhada pela janela
   * (duas batidas seguidas — descida e subida da tecla — não viram fala).
   */
  pushDb(
    db: number,
    frameMs: number = GATE_FRAME_MS,
    impulsive = false,
    energies?: Float64Array
  ): boolean {
    const level = Number.isFinite(db) ? db : -120
    const dt = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : GATE_FRAME_MS
    const loud = level >= this.thresholdDb
    const k = Math.max(0.05, dt / GATE_FRAME_MS)
    const rate = (a: number): number => 1 - Math.pow(1 - a, k)
    if (level < this.#floorDb) this.#floorDb += rate(0.25) * (level - this.#floorDb)
    else if (!loud) this.#floorDb += rate(0.02) * (level - this.#floorDb)
    this.#backfill = 0
    if (loud && !impulsive) {
      this.#gapMs = 0
      this.#runMs += dt
      this.#runFrames++
      if (this.#confirmed) return true
      this.#runWindow.push({ ms: dt, db: level, e: energies?.length ? energies : null })
      // a janela: os quadros mais recentes que cobrem a sequência mínima
      let ms = 0
      for (let i = this.#runWindow.length - 1; i >= 0; i--) {
        ms += this.#runWindow[i].ms
        if (ms >= MIN_SPEECH_RUN_MS - 1e-6) {
          this.#runWindow = this.#runWindow.slice(i)
          break
        }
      }
      if (this.#runMs < MIN_SPEECH_RUN_MS - 1e-6 || !this.#sustained()) return false
      this.#confirmed = true
      this.#backfill = this.#runFrames - 1
      this.#runWindow = []
      return true
    }
    // estalo ou quadro abaixo do limiar: não é fala; a sequência recomeça (as caudas de duas teclas
    // nunca se somam). A fala confirmada aguenta uma pausa curta, mas não um estalo: depois dele a
    // voz precisa se confirmar de novo (digitar logo depois de falar não vira "fala")
    this.#gapMs += dt
    this.#runMs = 0
    this.#runFrames = 0
    this.#runWindow = []
    if (this.#confirmed && (impulsive || this.#gapMs > SPEECH_RUN_HOLD_MS)) this.#confirmed = false
    return false
  }

  /**
   * A janela da sequência é som sustentado: não está morrendo (último quadro perto do mais forte)
   * e, com as energias dos sub-blocos, a energia está espalhada por ela.
   */
  #sustained(): boolean {
    const w = this.#runWindow
    if (!w.length) return true
    let max = -Infinity
    for (const x of w) max = Math.max(max, x.db)
    if (w[w.length - 1].db < max - SPEECH_RUN_MAX_DECAY_DB) return false
    if (w.some((x) => !x.e)) return true
    const all = new Float64Array(w.reduce((a, x) => a + x.e!.length, 0))
    let o = 0
    for (const x of w) {
      all.set(x.e!, o)
      o += x.e!.length
    }
    return impulseRatioDb(all) < IMPULSE_MEAN_OVER_MEDIAN_DB
  }

  /** Um quadro de RMS (0..1) — o nível que a captura emite (`impulsive` quando conhecido). */
  pushRms(rms: number, frameMs: number = GATE_FRAME_MS, impulsive = false): boolean {
    return this.pushDb(rmsToDb(rms), frameMs, impulsive)
  }

  /**
   * Um quadro de AMOSTRAS (float −1..1; PCM16 com `scale` 32768): nível, estalo e a energia da
   * sequência — a regra completa (portão do STT; a chamada do renderer, com o quadro da captura).
   */
  pushSamples(
    samples: ArrayLike<number>,
    sampleRate: number,
    opts: { frameMs?: number; scale?: number } = {}
  ): boolean {
    const n = samples.length
    let sum = 0
    for (let i = 0; i < n; i++) sum += samples[i] * samples[i]
    const scale = opts.scale && opts.scale > 0 ? opts.scale : 1
    const rms = n ? Math.sqrt(sum / n) / scale : 0
    const energies = subblockEnergies(samples, sampleRate)
    const frameMs = opts.frameMs ?? (n * 1000) / (sampleRate > 0 ? sampleRate : 16_000)
    return this.pushDb(rmsToDb(rms), frameMs, isImpulsiveEnergies(energies), energies)
  }
}

/**
 * Detector de fala por quadros de 20 ms sobre PCM16 mono: nível (dBFS) contra
 * `max(ativação, piso + margem)`; o piso de ruído desce rápido e sobe devagar, só com os quadros
 * SEM fala (ruído abaixo da ativação ensina o piso — a fala precisa de 10 dB sobre ele; ruído
 * constante ACIMA da ativação continua "fala": para isso serve o nível de ativação ajustável, com o
 * medidor em Configurações → Áudio). Guarda uma marca por quadro para analisar qualquer trecho
 * depois (`analyze`).
 */
export class SpeechGate {
  readonly sampleRate: number
  readonly activationDb: number
  readonly #level: LevelGate
  #flags = new Uint8Array(1024)
  #frames = 0
  #residual = new Uint8Array(0)

  constructor(opts: { activationDb?: number; sampleRate?: number; noiseFloorDb?: number } = {}) {
    this.sampleRate = opts.sampleRate && opts.sampleRate > 0 ? opts.sampleRate : 16_000
    this.activationDb = normalizeActivationDb(opts.activationDb)
    this.#level = new LevelGate({
      activationDb: opts.activationDb,
      noiseFloorDb: opts.noiseFloorDb
    })
  }

  /** Bytes de PCM16 por quadro. */
  get frameBytes(): number {
    return Math.round((this.sampleRate * GATE_FRAME_MS) / 1000) * 2
  }

  /** Piso de ruído estimado agora (dBFS). */
  get noiseFloorDb(): number {
    return this.#level.noiseFloorDb
  }

  /** Limiar de fala agora (dBFS). */
  get thresholdDb(): number {
    return this.#level.thresholdDb
  }

  /** Quadros analisados até agora. */
  get frames(): number {
    return this.#frames
  }

  /** O quadro `i` teve voz? */
  voiced(i: number): boolean {
    return i >= 0 && i < this.#frames && this.#flags[i] === 1
  }

  /** Acrescenta PCM16 (little-endian); quadros incompletos esperam o próximo pedaço. */
  push(pcm: Uint8Array): void {
    const fb = this.frameBytes
    let buf = pcm
    if (this.#residual.length) {
      buf = new Uint8Array(this.#residual.length + pcm.length)
      buf.set(this.#residual)
      buf.set(pcm, this.#residual.length)
    }
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let off = 0
    for (; off + fb <= buf.length; off += fb) {
      const samples = new Float32Array(fb / 2)
      for (let j = off, k = 0; j < off + fb; j += 2, k++) samples[k] = dv.getInt16(j, true) / 32768
      this.#frame(samples)
    }
    this.#residual = buf.slice(off)
  }

  #frame(samples: Float32Array): void {
    const voiced = this.#level.pushSamples(samples, this.sampleRate, { frameMs: GATE_FRAME_MS })
    if (this.#frames >= this.#flags.length) {
      const bigger = new Uint8Array(this.#flags.length * 2)
      bigger.set(this.#flags)
      this.#flags = bigger
    }
    // a sequência acabou de se confirmar como fala: o começo dela (ainda não contado) também é
    for (let b = this.#level.backfillFrames, i = this.#frames - 1; b > 0 && i >= 0; b--, i--)
      this.#flags[i] = 1
    this.#flags[this.#frames++] = voiced ? 1 : 0
  }

  /**
   * Análise do trecho `[start, end)` (bytes): voz, o recorte a mandar ao STT (do 1º ao último
   * quadro com voz, com `GATE_PAD_*` de folga, dentro do trecho) — null com voz de menos —, o
   * silêncio no fim e se o fim tem uma ilha de voz própria.
   */
  analyze(start: number, end: number): GateAnalysis {
    const fb = this.frameBytes
    const bytesPerMs = (this.sampleRate * 2) / 1000
    const f0 = Math.max(0, Math.floor(start / fb))
    const f1 = Math.min(this.#frames, Math.ceil(end / fb))
    let voicedFrames = 0
    let first = -1
    let last = -1
    const islands: { from: number; to: number }[] = []
    const mergeFrames = Math.round(ISLAND_MERGE_MS / GATE_FRAME_MS)
    for (let i = f0; i < f1; i++) {
      if (this.#flags[i] !== 1) continue
      voicedFrames++
      if (first < 0) first = i
      last = i
      const isl = islands[islands.length - 1]
      if (isl && i - isl.to <= mergeFrames) isl.to = i
      else islands.push({ from: i, to: i })
    }
    const voicedMs = voicedFrames * GATE_FRAME_MS
    const rangeEndMs = Math.max(0, end - start) / bytesPerMs
    const tailQuietMs =
      last < 0
        ? Math.round(rangeEndMs)
        : Math.max(0, Math.round((end - (last + 1) * fb) / bytesPerMs))
    const lastIsl = islands[islands.length - 1]
    const prevIsl = islands[islands.length - 2]
    const finalIsland =
      !!lastIsl &&
      !!prevIsl &&
      (lastIsl.from - prevIsl.to - 1) * GATE_FRAME_MS >= FINAL_ISLAND_GAP_MS &&
      (lastIsl.to - lastIsl.from + 1) * GATE_FRAME_MS >= FINAL_ISLAND_MIN_MS
    if (voicedMs < MIN_VOICED_MS || first < 0)
      return { voicedMs, send: null, tailQuietMs, finalIsland }
    const even = (x: number): number => x - (x % 2)
    const s = Math.max(start, even(first * fb - Math.round(GATE_PAD_BEFORE_MS * bytesPerMs)))
    const e = Math.min(end, even((last + 1) * fb + Math.round(GATE_PAD_AFTER_MS * bytesPerMs)))
    return { voicedMs, send: { start: s, end: Math.max(s, e) }, tailQuietMs, finalIsland }
  }
}

// ---------------- pós-filtro de alucinações ----------------

/**
 * Frases que o whisper inventa em silêncio/ruído (pt-BR, en, es — normalizadas: minúsculas, sem
 * acento nem pontuação). Lista ÚNICA — o filtro e os testes usam esta.
 */
export const SILENCE_HALLUCINATIONS: readonly string[] = [
  // pt
  'tchau',
  'tchau tchau',
  'obrigado',
  'obrigada',
  'muito obrigado',
  'muito obrigada',
  'obrigado por assistir',
  'obrigada por assistir',
  'obrigado pela atencao',
  'valeu',
  'legendas pela comunidade amara org',
  'legenda pela comunidade amara org',
  'legendas pela comunidade amaraorg',
  'inscreva se',
  'inscreva se no canal',
  'se inscreva no canal',
  'ate a proxima',
  // en
  'thank you',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'bye',
  'bye bye',
  'you',
  'please subscribe',
  'subtitles by the amara org community',
  // es
  'gracias',
  'subtitulos realizados por la comunidad de amara org'
]
const HALLUCINATION_SET = new Set(SILENCE_HALLUCINATIONS)

/** Voz abaixo disto (ms) + texto que é alucinação conhecida = alucinação. */
export const HALLUCINATION_SHORT_VOICED_MS = 450
/** Palavras por segundo de voz acima disto = texto demais para a voz que houve. */
export const MAX_WORDS_PER_VOICED_SEC = 5

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** O texto (inteiro) é uma alucinação de silêncio conhecida (ou só pontuação — "…")? */
export function isSilenceHallucination(text: string): boolean {
  const t = norm(String(text ?? ''))
  return !t || HALLUCINATION_SET.has(t)
}

/**
 * Pós-filtro do resultado do STT para um trecho com `voicedMs` de voz: (1) o texto inteiro é uma
 * alucinação conhecida (ou só pontuação) e a voz foi curta (< `HALLUCINATION_SHORT_VOICED_MS`) ou
 * as palavras não cabem na voz (> `MAX_WORDS_PER_VOICED_SEC`) → ''; (2) a última frase é uma
 * alucinação conhecida grudada numa transcrição maior e o áudio NÃO tem uma ilha de voz própria no
 * fim (`finalIsland` — a frase não foi dita: o fim era silêncio/ruído) → ela sai. Texto real passa
 * intacto.
 */
export function filterSilenceHallucination(
  text: string,
  a: Pick<GateAnalysis, 'voicedMs' | 'finalIsland'>
): string {
  const raw = String(text ?? '')
  const t = norm(raw)
  if (!t) return ''
  const words = t.split(' ').length
  const voicedSec = Math.max(0.001, a.voicedMs / 1000)
  if (
    HALLUCINATION_SET.has(t) &&
    (a.voicedMs < HALLUCINATION_SHORT_VOICED_MS || words / voicedSec > MAX_WORDS_PER_VOICED_SEC)
  )
    return ''
  // frase final grudada ("Abre o arquivo. Tchau.")
  const parts = raw.trim().split(/(?<=[.!?…])\s+/)
  if (parts.length >= 2 && !a.finalIsland) {
    const lastNorm = norm(parts[parts.length - 1])
    if (lastNorm && HALLUCINATION_SET.has(lastNorm)) return parts.slice(0, -1).join(' ').trim()
  }
  return raw
}

/**
 * Fala que INTERROMPEU o assistente (barge-in): o usuário falou por cima de uma frase tocando — uma
 * alucinação conhecida ali nunca é real (pedido do usuário, 2026-11-13: "se essa frase surgir quando
 * ele interrompe, não é real"; o eco da resposta, a respiração e a digitação viram "Tchau." no
 * whisper). Sai a frase inteira que é só uma alucinação conhecida, no começo ou no fim (repetidas
 * inclusive — "Tchau. Tchau."); sobrou nada → ''. Texto real passa intacto; um "tchau" dito fora de
 * um barge-in não passa por aqui (continua podendo encerrar a chamada).
 */
export function stripBargeInHallucinations(text: string): string {
  const parts = String(text ?? '')
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .filter((p) => p.trim())
  const fake = (p: string): boolean => {
    const t = norm(p)
    return !t || HALLUCINATION_SET.has(t)
  }
  while (parts.length && fake(parts[parts.length - 1])) parts.pop()
  while (parts.length && fake(parts[0])) parts.shift()
  return parts.join(' ').trim()
}
