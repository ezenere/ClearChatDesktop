// Clipes dos preâmbulos (fillers) da chamada de voz (SPEC → "Áudio → Serviço de TTS (clipes)"):
// falas curtas pré-geradas pela voz configurada e cacheadas em
// `<userData>/voice-clips/<voiceId>/FILLER_<n>.wav` (silêncio das pontas aparado), com manifest
// por voz (id, engine, modelo, hash da definição — o pool de preâmbulos). A Feature B consome via
// `loadCurrentClipAudio` (latência zero depois de gerados; cache velho = nada toca) e a
// regeneração acontece quando a voz muda (voiceId próprio por voz) ou o hash muda. Caches de
// versões antigas (com classes de clipe que saíram — `ACK`, `THINKING`…) contam como velhos: gerar
// de novo apaga os arquivos que não pertencem mais ao conjunto.
// Sem Electron/UI/IPC; síntese via `synthesize` de `tts.ts` (motor local injetado ou API).
import { createSHA256 } from 'hash-wasm'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FILLER_POOL_MAX,
  resolveFillerPool,
  type FillerPhrase,
  type TtsSettings
} from '@shared/voice'
import { resolveGpuParams } from '@shared/gpuVoice'
import { synthesize, type TtsLocalBackend } from './tts'

/**
 * Classes de clipes (whitelist de nomes de arquivo — nada fora daqui vira arquivo): só o `FILLER`
 * (preâmbulo pós-turno).
 */
export type ClipClass = 'FILLER'
export const CLIP_CLASSES: readonly ClipClass[] = ['FILLER']

/**
 * Teto do `<n>` (whitelist dos nomes de arquivo): uma variante por frase do pool de preâmbulos (até
 * `FILLER_POOL_MAX`).
 */
export const CLIP_MAX_VARIANTS = FILLER_POOL_MAX

/**
 * Conjunto completo de frases por classe: o `FILLER` = o pool de preâmbulos
 * (`voiceCallDefaults.fillers.pool`; null = `DEFAULT_FILLER_POOL`), na ordem do pool.
 */
export function clipPhraseSet(
  fillerPool?: readonly FillerPhrase[] | null
): Record<ClipClass, readonly string[]> {
  return {
    FILLER: resolveFillerPool(fillerPool ? [...fillerPool] : null).map((f) => f.text)
  }
}

/** Quantas variantes a classe tem no conjunto atual. */
export function clipVariantCount(
  cls: ClipClass,
  fillerPool?: readonly FillerPhrase[] | null
): number {
  return clipPhraseSet(fillerPool)[cls].length
}

/** Versão do pós-processamento dos clipes (entra no hash: mudou → regenera). */
const CLIP_POSTPROCESS = 'trim-v1'

/** Um clipe gerado (registro do manifest). */
export interface VoiceClip {
  /** Id estável: `<CLASSE>_<n>`. */
  id: string
  /** Nome do arquivo dentro da pasta da voz (sempre `clipFileName`). */
  file: string
  class: ClipClass
  /** Variante 1..`CLIP_MAX_VARIANTS`. */
  n: number
  text: string
}

/** Manifest de clipes de uma voz (`<userData>/voice-clips/<voiceId>/manifest.json`). */
export interface ClipsManifest {
  /** Voz dona do cache (mesmo id de `clipVoiceId`). */
  voiceId: string
  backend: 'api' | 'local' | 'gpu'
  /** Motor local ('kokoro'); null no backend de API. */
  engine: string | null
  /** Modelo/voz usados (informativo; nunca guarda chave de API). */
  model: string
  /** sha256 da definição (frases + voz + modelo) — mudou → os clipes são regerados. */
  hash: string
  generatedAt: string
  clips: VoiceClip[]
}

export interface GenerateClipsOptions {
  /** userData do app (os clipes vão para `<baseDir>/voice-clips`). */
  baseDir: string
  /** Configuração de fala dona da voz (backend/voz/modelo). */
  settings: TtsSettings
  /** Motor local injetado (backend 'local'); sem ele, `synthesize` falha legível. */
  local?: TtsLocalBackend
  /** Pool de preâmbulos (`voiceCallDefaults.fillers.pool`); null/ausente = o padrão. */
  fillerPool?: readonly FillerPhrase[] | null
  /** Progresso a cada clipe gerado. */
  onProgress?: (e: { done: number; total: number; id: string }) => void
  signal?: AbortSignal
}

// ---------------- nomes e pastas (seguros) ----------------

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Nome do arquivo de um clipe (`<CLASSE>_<n>.wav`) — classe/n fora da whitelist → erro legível. */
export function clipFileName(cls: string, n: number): string {
  if (!(CLIP_CLASSES as readonly string[]).includes(cls))
    throw new Error(`classe de clipe desconhecida: ${cls} (use: ${CLIP_CLASSES.join(', ')})`)
  if (!Number.isInteger(n) || n < 1 || n > CLIP_MAX_VARIANTS)
    throw new Error(`variante de clipe inválida: ${n} (use 1..${CLIP_MAX_VARIANTS})`)
  return `${cls}_${n}.wav`
}

/**
 * Id do diretório de cache da voz: `local-<engine>-<voz>` ou `api-<voz>` (segmento seguro — a voz
 * vem das settings e pode ser livre no backend de API; `../`, separadores e sequências `..` nunca
 * viram caminho).
 */
export function clipVoiceId(settings: TtsSettings): string {
  const raw =
    settings.backend === 'local'
      ? `local-${settings.local?.engine ?? 'kokoro'}-${settings.local?.voice ?? 'padrao'}`
      : settings.backend === 'gpu'
        ? `gpu-${settings.gpu?.engine ?? 'omnivoice'}-${settings.gpu?.voice ?? 'padrao'}`
        : `api-${(settings.api.voice ?? '').trim() || 'padrao'}`
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
  return safe || 'voz'
}

/** `<userData>/voice-clips` (raiz dos caches por voz). */
export function clipsRoot(baseDir: string): string {
  return join(baseDir, 'voice-clips')
}

/** Diretório de cache de uma voz (null quando o id não é um segmento seguro). */
export function clipsDir(baseDir: string, voiceId: string): string | null {
  return SAFE_SEGMENT.test(voiceId) ? join(clipsRoot(baseDir), voiceId) : null
}

// ---------------- manifest/hash ----------------

/**
 * Hash da definição dos clipes (o pool de preâmbulos + voz + modelo + pós-processamento): mudou →
 * o cache é velho e os clipes são regerados.
 */
export async function clipsHash(
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null
): Promise<string> {
  const payload = JSON.stringify({
    phrases: clipPhraseSet(fillerPool),
    post: CLIP_POSTPROCESS,
    backend: settings.backend,
    engine:
      settings.backend === 'local'
        ? (settings.local?.engine ?? null)
        : settings.backend === 'gpu'
          ? (settings.gpu?.engine ?? null)
          : null,
    voice:
      settings.backend === 'local'
        ? (settings.local?.voice ?? null)
        : settings.backend === 'gpu'
          ? (settings.gpu?.voice ?? null)
          : (settings.api.voice ?? null) || null,
    model: settings.backend === 'api' ? settings.api.model : null,
    // OmniVoice: os passos mudam o som → clipes novos (ausente nos outros backends: hash igual ao de antes)
    ...(settings.backend === 'gpu' && settings.gpu?.steps ? { steps: settings.gpu.steps } : {}),
    // parâmetros do modelo remoto (formato de saída, voice_settings, speed…) mudam o som; o
    // `auto_mode` só muda a chamada (ausente/vazio → hash igual ao de antes)
    ...(() => {
      if (settings.backend !== 'api' || !settings.api.params) return {}
      const p = JSON.parse(JSON.stringify(settings.api.params)) as Record<
        string,
        Record<string, unknown>
      >
      if (p.elevenlabs) delete p.elevenlabs.auto_mode
      for (const k of Object.keys(p)) if (!Object.keys(p[k]).length) delete p[k]
      return Object.keys(p).length ? { apiParams: p } : {}
    })(),
    // parâmetros do motor da GPU (velocidade, temperatura…) também mudam o som
    ...(settings.backend === 'gpu' && settings.gpu
      ? {
          params: resolveGpuParams(settings.gpu.engine, settings.gpu.params?.[settings.gpu.engine])
        }
      : {})
  })
  const hasher = await createSHA256()
  return hasher.update(payload).digest('hex')
}

const MANIFEST_FILE = 'manifest.json'

function normalizeClip(v: unknown): VoiceClip | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  const cls = typeof c.class === 'string' ? c.class : ''
  const n = typeof c.n === 'number' ? c.n : 0
  if (!(CLIP_CLASSES as readonly string[]).includes(cls)) return null
  if (!Number.isInteger(n) || n < 1 || n > CLIP_MAX_VARIANTS) return null
  let file: string
  try {
    file = clipFileName(cls, n)
  } catch {
    return null
  }
  if (c.file !== file) return null
  if (typeof c.id !== 'string' || c.id !== `${cls}_${n}`) return null
  if (typeof c.text !== 'string' || !c.text.trim()) return null
  return { id: c.id, file, class: cls as ClipClass, n, text: c.text }
}

/**
 * Lê e valida o manifest de uma voz (null quando ausente/inválido/sem os arquivos — o chamador
 * regenera). Só aceita ids de voz seguros e arquivos da whitelist.
 */
export async function loadClips(baseDir: string, voiceId: string): Promise<ClipsManifest | null> {
  const dir = clipsDir(baseDir, voiceId)
  if (!dir) return null
  let raw: string
  try {
    raw = await readFile(join(dir, MANIFEST_FILE), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const m = parsed as Record<string, unknown>
  if (m.voiceId !== voiceId) return null
  if (m.backend !== 'api' && m.backend !== 'local' && m.backend !== 'gpu') return null
  if (typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash)) return null
  if (typeof m.generatedAt !== 'string') return null
  if (typeof m.model !== 'string') return null
  if (m.engine !== null && typeof m.engine !== 'string') return null
  const clips = Array.isArray(m.clips) ? m.clips.map(normalizeClip) : []
  if (!clips.length || clips.some((c) => !c)) return null
  // todos os arquivos do manifest precisam existir (senão o cache está incompleto → regerar)
  for (const c of clips as VoiceClip[]) {
    if (!existsSync(join(dir, c.file))) return null
  }
  return {
    voiceId,
    backend: m.backend,
    engine: (m.engine as string | null) ?? null,
    model: m.model,
    hash: m.hash,
    generatedAt: m.generatedAt,
    clips: clips as VoiceClip[]
  }
}

/**
 * Caminho do `.wav` de um clipe da voz (null quando a classe/variante não existe no cache).
 * A Feature B toca este arquivo direto (latência zero depois de gerados).
 */
export async function resolveClip(
  baseDir: string,
  voiceId: string,
  cls: string,
  n: number
): Promise<string | null> {
  const dir = clipsDir(baseDir, voiceId)
  if (!dir) return null
  let file: string
  try {
    file = clipFileName(cls, n)
  } catch {
    return null
  }
  const path = join(dir, file)
  return existsSync(path) ? path : null
}

/**
 * Bytes prontos de um clipe da voz atual (null = não gerado/ilegível) — consumo da chamada de voz
 * (os preâmbulos tocam os `.wav` cacheados; nada é sintetizado no lugar).
 */
export async function loadClipAudio(
  baseDir: string,
  voiceId: string,
  cls: string,
  n: number
): Promise<{ audio: Uint8Array; mime: string } | null> {
  const path = await resolveClip(baseDir, voiceId, cls, n)
  if (!path) return null
  try {
    return { audio: await readFile(path), mime: 'audio/wav' }
  } catch {
    return null
  }
}

// ---------------- geração ----------------

/**
 * Gera (ou reusa) os clipes da voz configurada: cada frase de `clipPhraseSet` é sintetizada pela
 * voz atual (`synthesize` — motor local ou API) e gravada em
 * `<baseDir>/voice-clips/<voiceId>/<CLASSE>_<n>.wav`, com manifest (voz, engine, modelo, hash).
 * Cache: se o manifest da voz tem o mesmo hash e todos os arquivos existem, devolve sem sintetizar
 * (o "Gerar clipes" da UI é idempotente); voz nova = diretório novo = regeneração natural.
 */
export async function generateClips(opts: GenerateClipsOptions): Promise<ClipsManifest> {
  const voiceId = clipVoiceId(opts.settings)
  const dir = clipsDir(opts.baseDir, voiceId)
  if (!dir) throw new Error(`id de voz inseguro para clipes: ${voiceId}`)
  // gerações da MESMA voz em série (dois cliques/janelas): a segunda espera a primeira e reaproveita
  // o cache dela em vez de disputar os mesmos `.part`/manifest
  const prev = clipLocks.get(dir) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(() => generateClipsLocked(opts, voiceId, dir))
  clipLocks.set(dir, run)
  try {
    return await run
  } finally {
    if (clipLocks.get(dir) === run) clipLocks.delete(dir)
  }
}

const clipLocks = new Map<string, Promise<unknown>>()

async function generateClipsLocked(
  opts: GenerateClipsOptions,
  voiceId: string,
  dir: string
): Promise<ClipsManifest> {
  const hash = await clipsHash(opts.settings, opts.fillerPool)
  const existing = await loadClips(opts.baseDir, voiceId)
  if (existing && existing.hash === hash) return existing

  const phrases = clipPhraseSet(opts.fillerPool)
  const entries: VoiceClip[] = []
  const total = CLIP_CLASSES.reduce((a, c) => a + phrases[c].length, 0)
  let done = 0
  await mkdir(dir, { recursive: true })
  // conjunto novo: todo `.wav` que não pertence mais a ele sai — variantes que não existem mais
  // (pool menor) e as classes de versões antigas (`ACK_1.wav`, `THINKING_3.wav`…)
  const keep = new Set(
    CLIP_CLASSES.flatMap((c) => phrases[c].map((_, i) => clipFileName(c, i + 1)))
  )
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (/^[A-Z]+_\d+\.wav$/.test(name) && !keep.has(name))
      await rm(join(dir, name), { force: true })
  }
  for (const cls of CLIP_CLASSES) {
    for (let n = 1; n <= phrases[cls].length; n++) {
      if (opts.signal?.aborted) throw new Error('geração de clipes cancelada')
      const text = phrases[cls][n - 1]
      const file = clipFileName(cls, n)
      const r = await synthesize(
        { text, settings: opts.settings, format: 'wav' },
        { local: opts.local, signal: opts.signal }
      )
      // escrita via .part + rename (manifest só sai no fim, com tudo íntegro); silêncio das pontas
      // aparado (o Kokoro abre com ~180 ms de nada — o clipe tem de soar NA hora)
      const part = join(dir, `${file}.${randomUUID().slice(0, 8)}.part`)
      await writeFile(part, trimWavSilence(r.audio))
      await rename(part, join(dir, file))
      entries.push({ id: `${cls}_${n}`, file, class: cls, n, text })
      done++
      opts.onProgress?.({ done, total, id: `${cls}_${n}` })
    }
  }
  const engine =
    opts.settings.backend === 'local'
      ? (opts.settings.local?.engine ?? null)
      : opts.settings.backend === 'gpu'
        ? (opts.settings.gpu?.engine ?? null)
        : null
  const manifest: ClipsManifest = {
    voiceId,
    backend: opts.settings.backend,
    engine,
    model:
      opts.settings.backend === 'local'
        ? (opts.settings.local?.voice ?? '')
        : opts.settings.backend === 'gpu'
          ? (opts.settings.gpu?.engine ?? '')
          : opts.settings.api.model,
    hash,
    generatedAt: new Date().toISOString(),
    clips: entries
  }
  const tmp = join(dir, `${MANIFEST_FILE}.${randomUUID().slice(0, 8)}.tmp`)
  await writeFile(tmp, JSON.stringify(manifest, null, 2))
  await rename(tmp, join(dir, MANIFEST_FILE))
  return manifest
}

/**
 * Manifest da voz ATUAL só quando está em dia com a definição (hash igual — frases/pool/voz/modelo):
 * cache velho (pool mudou, frases trocadas nesta versão) → null (= "Gerar clipes" de novo).
 */
export async function loadCurrentClips(
  baseDir: string,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null
): Promise<ClipsManifest | null> {
  const m = await loadClips(baseDir, clipVoiceId(settings))
  if (!m) return null
  return m.hash === (await clipsHash(settings, fillerPool)) ? m : null
}

/** Bytes de um clipe só quando o cache da voz atual está em dia (senão null — nunca toca clipe velho). */
export async function loadCurrentClipAudio(
  baseDir: string,
  settings: TtsSettings,
  fillerPool: readonly FillerPhrase[] | null | undefined,
  cls: string,
  n: number
): Promise<{ audio: Uint8Array; mime: string } | null> {
  const m = await loadCurrentClips(baseDir, settings, fillerPool)
  if (!m || !m.clips.some((c) => c.class === cls && c.n === n)) return null
  return loadClipAudio(baseDir, m.voiceId, cls, n)
}

// ---------------- pós-processamento (puro) ----------------

/** Amplitude (PCM16) abaixo da qual a ponta do clipe conta como silêncio (≈ −45 dBFS). */
const TRIM_THRESHOLD = 180
/** Silêncio mantido em cada ponta depois de aparar (ms) e rampa de entrada/saída (ms). */
const TRIM_PAD_MS = 15
const TRIM_FADE_MS = 5

/**
 * Apara o silêncio do começo e do fim de um WAV PCM16 (mono ou multicanal), deixando `TRIM_PAD_MS`
 * e uma rampa curta nas pontas (sem clique). Qualquer outra coisa (mp3, float, WAV estranho, tudo
 * silêncio) volta intacta — o pós-processamento nunca quebra um clipe.
 */
export function trimWavSilence(bytes: Uint8Array): Uint8Array {
  try {
    if (bytes.length < 44) return bytes
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tag = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4))
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return bytes
    let off = 12
    let fmt: { channels: number; rate: number; bits: number; format: number } | null = null
    let data: { start: number; size: number } | null = null
    while (off + 8 <= bytes.length) {
      const id = tag(off)
      const size = dv.getUint32(off + 4, true)
      const body = off + 8
      if (id === 'fmt ' && size >= 16) {
        fmt = {
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          rate: dv.getUint32(body + 4, true),
          bits: dv.getUint16(body + 14, true)
        }
      } else if (id === 'data') {
        data = { start: body, size: Math.min(size, bytes.length - body) }
        break
      }
      off = body + size + (size % 2)
    }
    if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1) return bytes
    const frameBytes = 2 * fmt.channels
    const frames = Math.floor(data.size / frameBytes)
    if (frames < 2) return bytes
    const peak = (f: number): number => {
      let m = 0
      for (let c = 0; c < fmt!.channels; c++) {
        const v = Math.abs(dv.getInt16(data!.start + f * frameBytes + c * 2, true))
        if (v > m) m = v
      }
      return m
    }
    let first = 0
    while (first < frames && peak(first) < TRIM_THRESHOLD) first++
    if (first >= frames) return bytes // tudo silêncio: deixa como está
    let last = frames - 1
    while (last > first && peak(last) < TRIM_THRESHOLD) last--
    const pad = Math.round((TRIM_PAD_MS * fmt.rate) / 1000)
    const from = Math.max(0, first - pad)
    const to = Math.min(frames, last + 1 + pad)
    if (from === 0 && to === frames) return bytes
    const n = to - from
    const pcm = new Uint8Array(n * frameBytes)
    pcm.set(bytes.subarray(data.start + from * frameBytes, data.start + to * frameBytes))
    const pv = new DataView(pcm.buffer)
    const fade = Math.min(Math.floor(n / 2), Math.round((TRIM_FADE_MS * fmt.rate) / 1000))
    for (let i = 0; i < fade; i++) {
      const g = i / fade
      for (let c = 0; c < fmt.channels; c++) {
        const a = i * frameBytes + c * 2
        const b = (n - 1 - i) * frameBytes + c * 2
        pv.setInt16(a, Math.round(pv.getInt16(a, true) * g), true)
        pv.setInt16(b, Math.round(pv.getInt16(b, true) * g), true)
      }
    }
    const out = new Uint8Array(44 + pcm.length)
    const ov = new DataView(out.buffer)
    out.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
    ov.setUint32(4, 36 + pcm.length, true)
    out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8) // WAVEfmt␠
    ov.setUint32(16, 16, true)
    ov.setUint16(20, 1, true)
    ov.setUint16(22, fmt.channels, true)
    ov.setUint32(24, fmt.rate, true)
    ov.setUint32(28, fmt.rate * frameBytes, true)
    ov.setUint16(32, frameBytes, true)
    ov.setUint16(34, 16, true)
    out.set([0x64, 0x61, 0x74, 0x61], 36) // data
    ov.setUint32(40, pcm.length, true)
    out.set(pcm, 44)
    return out
  } catch {
    return bytes
  }
}

/** Remove o cache de clipes de uma voz (idempotente; id inseguro = sem efeito). */
export async function removeClips(baseDir: string, voiceId: string): Promise<void> {
  const dir = clipsDir(baseDir, voiceId)
  if (!dir) return
  await rm(dir, { recursive: true, force: true })
}
