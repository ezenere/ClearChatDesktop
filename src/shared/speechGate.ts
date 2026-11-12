// Portão de ativação de fala na frente da transcrição (PURO — sem Electron/fs; o mobile pode
// vendorar). O whisper "alucina" em silêncio/ruído ("Tchau.", "Obrigado.", "Legendas pela
// comunidade Amara.org") — numa chamada um "tchau" inventado pode até encerrar a ligação. Então:
//   1. só vai ao STT o trecho com FALA de verdade: cada quadro de 20 ms tem o nível (dBFS) medido
//      contra o nível de ativação absoluto (`audioInput.activationDb`, local do dispositivo) E o
//      piso de ruído adaptativo + margem; um trecho com menos de `MIN_VOICED_MS` de voz é
//      descartado sem chamar o STT, e o que vai é aparado (silêncio antes/depois, com folga);
//   2. pós-filtro: o resultado que é só uma alucinação conhecida com pouca voz (ou palavras demais
//      para a voz que houve) vira texto vazio; a mesma frase grudada no FIM de uma transcrição
//      maior, sem uma "ilha" de voz própria no fim do áudio, é removida.
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
 * Decisão de fala de UM quadro de nível (a regra única — o portão do STT no main e a detecção de
 * fala da chamada no renderer usam a MESMA): nível (dBFS) ≥ `max(ativação, piso + 10 dB)`; o piso
 * desce rápido (silêncio de verdade) e sobe em ~1 s só com os quadros SEM fala. Ruído constante
 * abaixo da ativação nunca é fala; ruído acima dela é caso do nível de ativação (Configurações →
 * Áudio). As taxas são por 20 ms e escalam com a duração do quadro (`frameMs`).
 */
export class LevelGate {
  readonly activationDb: number
  #floorDb: number

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

  /** Um quadro de `db` dBFS com `frameMs` de duração: é fala? (e atualiza o piso). */
  pushDb(db: number, frameMs: number = GATE_FRAME_MS): boolean {
    const level = Number.isFinite(db) ? db : -120
    const voiced = level >= this.thresholdDb
    const k = Math.max(
      0.05,
      (Number.isFinite(frameMs) && frameMs > 0 ? frameMs : GATE_FRAME_MS) / GATE_FRAME_MS
    )
    const rate = (a: number): number => 1 - Math.pow(1 - a, k)
    if (level < this.#floorDb) this.#floorDb += rate(0.25) * (level - this.#floorDb)
    else if (!voiced) this.#floorDb += rate(0.02) * (level - this.#floorDb)
    return voiced
  }

  /** Um quadro de RMS (0..1) — o nível que a captura do renderer emite. */
  pushRms(rms: number, frameMs: number = GATE_FRAME_MS): boolean {
    return this.pushDb(rmsToDb(rms), frameMs)
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
      let sum = 0
      for (let j = off; j < off + fb; j += 2) {
        const s = dv.getInt16(j, true) / 32768
        sum += s * s
      }
      this.#frame(rmsToDb(Math.sqrt(sum / (fb / 2))))
    }
    this.#residual = buf.slice(off)
  }

  #frame(db: number): void {
    const voiced = this.#level.pushDb(db, GATE_FRAME_MS)
    if (this.#frames >= this.#flags.length) {
      const bigger = new Uint8Array(this.#flags.length * 2)
      bigger.set(this.#flags)
      this.#flags = bigger
    }
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
