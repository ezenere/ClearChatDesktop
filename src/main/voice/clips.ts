// Clipes dos preâmbulos (fillers), das frases de ferramenta e do "obrigado por aguardar" da chamada
// de voz (SPEC → "Áudio → Serviço de TTS (clipes)"): falas curtas pré-geradas pela voz configurada e
// cacheadas em `<userData>/voice-clips/<voiceId>/<variante>/<FILLER|TOOL|THANKS>_<n>.wav` (silêncio
// das pontas aparado), com manifest por VARIANTE (id, engine, modelo, hash da definição + um hash
// POR CLASSE). A variante = os 16 primeiros hex de `clipConfigKey` (sha256 de tudo que muda o SOM
// além das frases: backend, provedor, modelo, voz, parâmetros do modelo, motor/passos da GPU) —
// a voz padrão deste dispositivo e a de uma persona/chat com o MESMO id de voz mas outro modelo ou
// outras instruções convivem (antes a pasta era só por voz: gerar uma sobrescrevia a outra e cada
// lado via o outro "desatualizado"). A Feature B consome via `loadCurrentClipAudio` (latência zero
// depois de gerados; classe velha = aquele clipe não toca); só as classes que mudaram são
// sintetizadas de novo (cache só de preâmbulos, de antes das frases de ferramenta: os `FILLER`
// continuam valendo e o "Gerar clipes" só gera os `TOOL`; idem os `THANKS`, que vieram depois).
// Layout antigo (`<voiceId>/manifest.json` direto na pasta da voz): ADOTADO pela configuração que
// ele casa (um hash por classe igual ao dela — o hash por classe já cobre voz/modelo/parâmetros)
// na 1ª leitura, sem sintetizar nada; o que não casa fica onde está para a outra configuração (ou
// para a limpeza). Limpeza (`pruneClips`): variantes que nenhuma voz em uso referencia e sem uso há
// `CLIP_UNUSED_MAX_AGE_MS` saem; as em uso nunca. Caches de versões antigas (com classes de clipe
// que saíram — `ACK`, `THINKING`…) contam como velhos: gerar de novo apaga os arquivos que não
// pertencem mais ao conjunto.
// Sem Electron/UI/IPC; síntese via `synthesize` de `tts.ts` (motor local injetado ou API).
import { createSHA256 } from 'hash-wasm'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  DELAY_PHRASE_POOL_MAX,
  FILLER_POOL_MAX,
  TOOL_PHRASE_POOL_MAX,
  resolveFillerPool,
  resolveThanksPool,
  resolveToolPhrasePool,
  type FillerPhrase,
  type ToolPhrase,
  type TtsSettings
} from '@shared/voice'
import { resolveGpuParams } from '@shared/gpuVoice'
import { synthesize, type TtsLocalBackend } from './tts'

/**
 * Classes de clipes (whitelist de nomes de arquivo — nada fora daqui vira arquivo): `FILLER`
 * (preâmbulo pós-turno), `TOOL` (frase da 1ª tool do turno — "Vou pesquisar isso.") e `THANKS`
 * ("Obrigado por aguardar." antes da resposta que demorou — pronto na hora, sem síntese).
 */
export type ClipClass = 'FILLER' | 'TOOL' | 'THANKS'
export const CLIP_CLASSES: readonly ClipClass[] = ['FILLER', 'TOOL', 'THANKS']

/**
 * Teto do `<n>` (whitelist dos nomes de arquivo): uma variante por frase do pool (até
 * `FILLER_POOL_MAX` preâmbulos / `TOOL_PHRASE_POOL_MAX` frases de ferramenta /
 * `DELAY_PHRASE_POOL_MAX` agradecimentos).
 */
export const CLIP_MAX_VARIANTS = Math.max(
  FILLER_POOL_MAX,
  TOOL_PHRASE_POOL_MAX,
  DELAY_PHRASE_POOL_MAX
)

/**
 * Conjunto completo de frases por classe, na ordem dos pools: `FILLER` = os preâmbulos
 * (`voiceCallDefaults.fillers.pool`; null = `DEFAULT_FILLER_POOL`), `TOOL` = as frases de
 * ferramenta (`voiceCallDefaults.toolPhrases.pool`; null = `DEFAULT_TOOL_PHRASE_POOL`) e `THANKS` =
 * o "obrigado por aguardar" (`voiceCallDefaults.delayPhrases.thanksPool`; null = `DEFAULT_THANKS_POOL`).
 */
export function clipPhraseSet(
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Record<ClipClass, readonly string[]> {
  return {
    FILLER: resolveFillerPool(fillerPool ? [...fillerPool] : null).map((f) => f.text),
    TOOL: resolveToolPhrasePool(toolPool ? [...toolPool] : null).map((f) => f.text),
    THANKS: resolveThanksPool(thanksPool)
  }
}

/** Quantas variantes a classe tem no conjunto atual. */
export function clipVariantCount(
  cls: ClipClass,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): number {
  return clipPhraseSet(fillerPool, toolPool, thanksPool)[cls].length
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

/**
 * Manifest de clipes de uma configuração de voz (`<userData>/voice-clips/<voiceId>/<variante>/
 * manifest.json`; layout antigo, sem variante: `<voiceId>/manifest.json`).
 */
export interface ClipsManifest {
  /** Voz dona do cache (mesmo id de `clipVoiceId`). */
  voiceId: string
  /**
   * Pasta da configuração dentro da da voz (os 16 primeiros hex de `configKey`); null = layout
   * antigo (direto na pasta da voz — ainda não adotado).
   */
  variant: string | null
  /** `clipConfigKey` completo da configuração (null no layout antigo). */
  configKey: string | null
  backend: 'api' | 'local' | 'gpu'
  /** Motor local ('kokoro'); null no backend de API. */
  engine: string | null
  /** Modelo/voz usados (informativo; nunca guarda chave de API). */
  model: string
  /** sha256 da definição (frases + voz + modelo) — mudou → os clipes são regerados. */
  hash: string
  /**
   * sha256 por classe (as frases DELA + voz + modelo): a classe em dia continua tocando e é
   * reaproveitada na regeneração. Manifest antigo (sem o campo, só preâmbulos): `{ FILLER: hash }`
   * — o hash antigo era exatamente o da classe FILLER.
   */
  classHashes: Partial<Record<ClipClass, string>>
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
  /** Pool de frases de ferramenta (`voiceCallDefaults.toolPhrases.pool`); null/ausente = o padrão. */
  toolPool?: readonly ToolPhrase[] | null
  /** Pool do "obrigado por aguardar" (`voiceCallDefaults.delayPhrases.thanksPool`); null = o padrão. */
  thanksPool?: readonly string[] | null
  /** Quais pools são próprios da persona/chat (pasta própria — `ownPoolsKey`). */
  own?: ClipOwnPools | null
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

/**
 * Diretório de cache de uma voz (null quando o id não é um segmento seguro). Com `variant`: a pasta
 * daquela configuração dentro da da voz (variante fora do formato → null); sem: a pasta da voz
 * (onde mora o layout antigo).
 */
export function clipsDir(baseDir: string, voiceId: string, variant?: string | null): string | null {
  if (!SAFE_SEGMENT.test(voiceId)) return null
  if (variant == null) return join(clipsRoot(baseDir), voiceId)
  return VARIANT_RE.test(variant) ? join(clipsRoot(baseDir), voiceId, variant) : null
}

// ---------------- configuração de voz (variante) ----------------

/** Nome da pasta de uma variante: 16 hex (prefixo de `clipConfigKey`). */
/** Variante: 16 hex da configuração de voz; com pools próprios (persona/chat), `-` + 8 hex deles. */
const VARIANT_RE = /^[0-9a-f]{16}(?:-[0-9a-f]{8})?$/

/** Variante sem uso (e que nenhuma voz em uso referencia) há mais que isto sai na limpeza. */
export const CLIP_UNUSED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * O que muda o SOM dos clipes além das frases (a "configuração de voz"): backend; na API o
 * provedor (id + tipo), o modelo, a voz e os parâmetros do modelo (`api.params`, sem o `auto_mode`
 * da ElevenLabs, que só muda a chamada); no local o motor e a voz; na GPU o motor, a voz, os passos
 * e os parâmetros resolvidos. NÃO entram: endereço/chave/headers (`baseUrl`, `apiKey`,
 * `appHeaders`, `extraBody` — derivados no main, a assinatura de app varia por chat sem mudar o
 * som), o transporte da chamada (`elevenLabsWs`) e o `installed`. Puro.
 */
export function clipConfigPayload(settings: TtsSettings): Record<string, unknown> {
  if (settings.backend === 'local')
    return {
      backend: 'local',
      engine: settings.local?.engine ?? 'kokoro',
      voice: settings.local?.voice ?? null
    }
  if (settings.backend === 'gpu') {
    const g = settings.gpu
    return {
      backend: 'gpu',
      engine: g?.engine ?? null,
      voice: g?.voice ?? null,
      steps: g?.steps ?? null,
      params: g ? resolveGpuParams(g.engine, g.params?.[g.engine]) : null
    }
  }
  const api = settings.api
  return {
    backend: 'api',
    providerId: api.providerId?.trim() || null,
    providerKind: api.providerKind ?? null,
    model: api.model.trim(),
    voice: (api.voice ?? '').trim() || null,
    params: soundApiParams(api.params) ?? null
  }
}

/** `api.params` só com o que muda o som (sem `elevenlabs.auto_mode`, famílias vazias fora). */
function soundApiParams(params: TtsSettings['api']['params']): Record<string, unknown> | null {
  if (!params) return null
  const p = JSON.parse(JSON.stringify(params)) as Record<string, Record<string, unknown>>
  if (p.elevenlabs) delete p.elevenlabs.auto_mode
  for (const k of Object.keys(p)) if (!p[k] || !Object.keys(p[k]).length) delete p[k]
  return Object.keys(p).length ? p : null
}

/** JSON com as chaves ordenadas (a ordem em que a UI gravou os parâmetros não muda a chave). */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/**
 * Chave (sha256 hex) da configuração de voz — a mesma em todo lugar que resolve a MESMA voz efetiva
 * (Configurações → Áudio, a aba Voz da persona/chat, o dock e a chamada): todos passam pelas
 * settings resolvidas do main (`getVoiceSettingsWith`).
 */
export async function clipConfigKey(settings: TtsSettings): Promise<string> {
  const hasher = await createSHA256()
  return hasher.update(stableJson({ v: 1, ...clipConfigPayload(settings) })).digest('hex')
}

/** Onde ficam os clipes de uma configuração de voz. */
export interface ClipsLocation {
  voiceId: string
  /** Pasta da configuração (16 hex de `configKey`). */
  variant: string
  configKey: string
  /** `<baseDir>/voice-clips/<voiceId>/<variant>`. */
  dir: string
}

/**
 * Pools PRÓPRIOS de uma persona/chat (1.18.0 — `effectivePhrasePools`): quais classes vêm deles.
 * Com algum, os clipes ficam numa pasta própria (a variante ganha o hash dos pools próprios) — a
 * mesma voz com os pools deste dispositivo e com os de uma persona não se sobrescrevem.
 */
export interface ClipOwnPools {
  filler: boolean
  tool: boolean
}

/** Hash curto (8 hex) dos pools próprios; null = nenhum (a pasta de sempre da voz). */
export async function ownPoolsKey(
  own: ClipOwnPools | null | undefined,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null
): Promise<string | null> {
  if (!own || (!own.filler && !own.tool)) return null
  const set = clipPhraseSet(fillerPool, toolPool, null)
  const hasher = await createSHA256()
  return hasher
    .update(
      stableJson({
        v: 1,
        ...(own.filler ? { FILLER: set.FILLER } : {}),
        ...(own.tool ? { TOOL: set.TOOL } : {})
      })
    )
    .digest('hex')
    .slice(0, 8)
}

/** Pasta (voz + variante) da configuração de voz das settings (+ pools próprios, se houver). */
export async function clipsLocation(
  baseDir: string,
  settings: TtsSettings,
  ownKey?: string | null
): Promise<ClipsLocation> {
  const voiceId = clipVoiceId(settings)
  const configKey = await clipConfigKey(settings)
  const variant = ownKey ? `${configKey.slice(0, 16)}-${ownKey}` : configKey.slice(0, 16)
  const dir = clipsDir(baseDir, voiceId, variant)
  if (!dir) throw new Error(`id de voz inseguro para clipes: ${voiceId}`)
  return { voiceId, variant, configKey, dir }
}

// ---------------- manifest/hash ----------------

/**
 * Hash da definição dos clipes (os pools de preâmbulos, de frases de ferramenta e de agradecimento +
 * voz + modelo + pós-processamento): mudou → o cache é velho e os clipes são regerados.
 */
export async function clipsHash(
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Promise<string> {
  return phrasesHash(settings, clipPhraseSet(fillerPool, toolPool, thanksPool))
}

/**
 * Hash de UMA classe (as frases dela + voz + modelo + pós-processamento). O de `FILLER` é idêntico
 * ao hash dos caches de antes das frases de ferramenta (o payload era `{ phrases: { FILLER } }`).
 */
export async function clipClassHash(
  settings: TtsSettings,
  cls: ClipClass,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Promise<string> {
  return phrasesHash(settings, { [cls]: clipPhraseSet(fillerPool, toolPool, thanksPool)[cls] })
}

/** Hash de todas as classes (classe → hash) do conjunto atual. */
export async function clipClassHashes(
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Promise<Record<ClipClass, string>> {
  const out = {} as Record<ClipClass, string>
  for (const c of CLIP_CLASSES)
    out[c] = await clipClassHash(settings, c, fillerPool, toolPool, thanksPool)
  return out
}

async function phrasesHash(
  settings: TtsSettings,
  phrases: Partial<Record<ClipClass, readonly string[]>>
): Promise<string> {
  const payload = JSON.stringify({
    phrases,
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
 * Lê e valida o manifest de uma variante da voz (null quando ausente/inválido/sem os arquivos — o
 * chamador regenera). Sem `variant`: o layout ANTIGO (manifest direto na pasta da voz). Só aceita
 * ids de voz seguros, variantes no formato e arquivos da whitelist.
 */
export async function loadClips(
  baseDir: string,
  voiceId: string,
  variant?: string | null
): Promise<ClipsManifest | null> {
  const dir = clipsDir(baseDir, voiceId, variant)
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
  if (!m || typeof m !== 'object') return null
  if (m.voiceId !== voiceId) return null
  // variante: o manifest diz de qual configuração é (a pasta é o prefixo da chave)
  let configKey: string | null = null
  if (variant != null) {
    if (m.variant !== variant) return null
    if (typeof m.configKey !== 'string' || !/^[0-9a-f]{64}$/.test(m.configKey)) return null
    // pasta = os 16 primeiros hex da chave (+ `-<hash>` dos pools próprios da persona/chat)
    if (!m.configKey.startsWith(variant.slice(0, 16))) return null
    configKey = m.configKey
  }
  if (m.backend !== 'api' && m.backend !== 'local' && m.backend !== 'gpu') return null
  if (typeof m.hash !== 'string' || !/^[0-9a-f]{64}$/.test(m.hash)) return null
  if (typeof m.generatedAt !== 'string') return null
  if (typeof m.model !== 'string') return null
  if (m.engine !== null && typeof m.engine !== 'string') return null
  const clips = Array.isArray(m.clips) ? m.clips.map(normalizeClip) : []
  if (!clips.length || clips.some((c) => !c)) return null
  // hash por classe; manifest de antes das frases de ferramenta (só preâmbulos) → o hash dele era o
  // da classe FILLER
  const classHashes: Partial<Record<ClipClass, string>> = {}
  const rawClass = m.classHashes && typeof m.classHashes === 'object' ? m.classHashes : null
  if (rawClass) {
    for (const c of CLIP_CLASSES) {
      const h = (rawClass as Record<string, unknown>)[c]
      if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) classHashes[c] = h
    }
  } else if ((clips as VoiceClip[]).every((c) => c.class === 'FILLER')) {
    classHashes.FILLER = m.hash
  }
  // todos os arquivos do manifest precisam existir (senão o cache está incompleto → regerar)
  for (const c of clips as VoiceClip[]) {
    if (!existsSync(join(dir, c.file))) return null
  }
  return {
    voiceId,
    variant: variant ?? null,
    configKey,
    backend: m.backend,
    engine: (m.engine as string | null) ?? null,
    model: m.model,
    hash: m.hash,
    classHashes,
    generatedAt: m.generatedAt,
    clips: clips as VoiceClip[]
  }
}

/**
 * Caminho do `.wav` de um clipe da voz (null quando a classe/variante não existe no cache).
 * `configVariant` = a pasta da configuração (`ClipsManifest.variant`; null = layout antigo).
 * A Feature B toca este arquivo direto (latência zero depois de gerados).
 */
export async function resolveClip(
  baseDir: string,
  voiceId: string,
  cls: string,
  n: number,
  configVariant?: string | null
): Promise<string | null> {
  const dir = clipsDir(baseDir, voiceId, configVariant)
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
  n: number,
  configVariant?: string | null
): Promise<{ audio: Uint8Array; mime: string } | null> {
  const path = await resolveClip(baseDir, voiceId, cls, n, configVariant)
  if (!path) return null
  try {
    return { audio: await readFile(path), mime: 'audio/wav' }
  } catch {
    return null
  }
}

// ---------------- variante: leitura, adoção do layout antigo, uso ----------------

/**
 * Uma operação por pasta de variante por vez (dois cliques/janelas, adoção × geração): a segunda
 * espera a primeira e reaproveita o resultado em vez de disputar os mesmos `.part`/manifest.
 */
const clipLocks = new Map<string, Promise<unknown>>()

async function withClipLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = clipLocks.get(dir) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  clipLocks.set(dir, run)
  try {
    return await run
  } finally {
    if (clipLocks.get(dir) === run) clipLocks.delete(dir)
  }
}

async function writeManifest(dir: string, manifest: ClipsManifest): Promise<void> {
  const tmp = join(dir, `${MANIFEST_FILE}.${randomUUID().slice(0, 8)}.tmp`)
  await writeFile(tmp, JSON.stringify(manifest, null, 2))
  await rename(tmp, join(dir, MANIFEST_FILE))
}

/** Marca de uso da variante (`{ lastUsedAt }` — tocada, listada ou gerada; vale para a limpeza). */
const USAGE_FILE = 'used.json'
/** A marca é regravada no máximo 1× por isto por pasta (a chamada lê clipes o tempo todo). */
const USAGE_THROTTLE_MS = 60 * 60 * 1000
const usageWritten = new Map<string, number>()

async function markClipsUsed(dir: string, force = false): Promise<void> {
  const now = Date.now()
  const last = usageWritten.get(dir)
  if (!force && last !== undefined && now - last < USAGE_THROTTLE_MS) return
  usageWritten.set(dir, now)
  try {
    const tmp = join(dir, `${USAGE_FILE}.${randomUUID().slice(0, 8)}.tmp`)
    await writeFile(tmp, JSON.stringify({ lastUsedAt: new Date(now).toISOString() }))
    await rename(tmp, join(dir, USAGE_FILE))
  } catch {
    // pasta sumiu (limpeza/remoção) — a marca não é essencial
  }
}

const isoMs = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

/** Último uso da variante: a marca de uso ou a geração (o mais novo); sem nenhum, o mtime da pasta. */
async function variantLastUsed(dir: string): Promise<number> {
  const field = async (file: string, key: string): Promise<number> => {
    try {
      const o = JSON.parse(await readFile(join(dir, file), 'utf8')) as Record<string, unknown>
      return isoMs(o?.[key])
    } catch {
      return 0
    }
  }
  const best = Math.max(
    await field(USAGE_FILE, 'lastUsedAt'),
    await field(MANIFEST_FILE, 'generatedAt')
  )
  if (best) return best
  try {
    return (await stat(dir)).mtimeMs
  } catch {
    return 0
  }
}

/**
 * O cache do layout antigo (manifest direto na pasta da voz) é desta configuração? Casa quando o
 * hash da definição inteira ou o de ALGUMA classe é igual ao dela — o hash por classe cobre voz,
 * modelo, parâmetros e motor, então só a configuração que gerou aqueles arquivos casa (classes que
 * não casam são frases que mudaram depois: ficam "velhas" e são refeitas sozinhas).
 */
async function legacyMatches(
  legacy: ClipsManifest,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Promise<boolean> {
  if (legacy.hash === (await clipsHash(settings, fillerPool, toolPool, thanksPool))) return true
  const hashes = await clipClassHashes(settings, fillerPool, toolPool, thanksPool)
  return CLIP_CLASSES.some((c) => !!legacy.classHashes[c] && legacy.classHashes[c] === hashes[c])
}

async function linkOrCopy(src: string, dst: string): Promise<void> {
  try {
    await link(src, dst)
  } catch {
    await copyFile(src, dst)
  }
}

/**
 * Adota o cache do layout antigo (`<voiceId>/manifest.json` + `.wav`) para a variante desta
 * configuração quando ele casa com ela: cada arquivo ganha um link (ou cópia) na pasta da
 * variante, o manifest dela sai por último e só então o antigo é apagado (falhou no meio → o
 * antigo continua valendo). Não casa (é de outra configuração com o mesmo id de voz) → fica onde
 * está, para ela. Nada é sintetizado.
 */
async function adoptLegacyClips(
  baseDir: string,
  loc: ClipsLocation,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Promise<ClipsManifest | null> {
  const voiceDir = clipsDir(baseDir, loc.voiceId)
  if (!voiceDir || !existsSync(join(voiceDir, MANIFEST_FILE))) return null
  return withClipLock(loc.dir, async () => {
    const already = await loadClips(baseDir, loc.voiceId, loc.variant)
    if (already) return already.configKey === loc.configKey ? already : null
    const legacy = await loadClips(baseDir, loc.voiceId)
    if (!legacy) return null
    if (!(await legacyMatches(legacy, settings, fillerPool, toolPool, thanksPool))) return null
    try {
      await mkdir(loc.dir, { recursive: true })
      for (const c of legacy.clips) {
        const part = join(loc.dir, `${c.file}.${randomUUID().slice(0, 8)}.part`)
        await linkOrCopy(join(voiceDir, c.file), part)
        await rename(part, join(loc.dir, c.file))
      }
      await writeManifest(loc.dir, { ...legacy, variant: loc.variant, configKey: loc.configKey })
    } catch {
      return null
    }
    // o antigo sai (o manifest primeiro: `.wav` solto sem manifest é lixo para a limpeza)
    await rm(join(voiceDir, MANIFEST_FILE), { force: true })
    for (const c of legacy.clips) await rm(join(voiceDir, c.file), { force: true })
    return loadClips(baseDir, loc.voiceId, loc.variant)
  })
}

/**
 * Manifest da configuração de voz das settings (null = ainda não gerados): o da variante dela —
 * ou o do layout antigo da mesma voz quando casa com esta configuração (adotado na hora: os clipes
 * continuam tocando sem regerar). Lido = usado (marca para a limpeza). É o que a lista/status, a
 * geração e a chamada usam: a mesma voz efetiva resolve sempre a mesma pasta.
 */
export async function loadVoiceClips(
  baseDir: string,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null,
  own?: ClipOwnPools | null
): Promise<ClipsManifest | null> {
  const ownKey = await ownPoolsKey(own, fillerPool, toolPool)
  const loc = await clipsLocation(baseDir, settings, ownKey)
  let m = await loadClips(baseDir, loc.voiceId, loc.variant)
  if (m && m.configKey !== loc.configKey) return null
  // o layout antigo é sempre dos pools do dispositivo (pools próprios nasceram depois dele)
  if (!m && !ownKey)
    m = await adoptLegacyClips(baseDir, loc, settings, fillerPool, toolPool, thanksPool)
  if (m) await markClipsUsed(loc.dir)
  return m
}

/**
 * Restos inúteis do layout antigo na pasta da voz quando ele NÃO vale para ninguém (manifest
 * inválido — classes que saíram, arquivo faltando — ou `.wav` sem manifest): saem na geração. Um
 * antigo válido nunca é tocado aqui (pode ser de outra configuração com o mesmo id de voz).
 */
async function dropBrokenLegacy(baseDir: string, voiceId: string): Promise<void> {
  const voiceDir = clipsDir(baseDir, voiceId)
  if (!voiceDir) return
  const names = (await readdir(voiceDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && LEGACY_FILE_RE.test(e.name))
    .map((e) => e.name)
  if (!names.length || (await loadClips(baseDir, voiceId))) return
  for (const name of names) await rm(join(voiceDir, name), { force: true })
}

// ---------------- geração ----------------

/**
 * Gera (ou reusa) os clipes da configuração de voz: cada frase de `clipPhraseSet` é sintetizada
 * pela voz (`synthesize` — motor local ou API) e gravada em
 * `<baseDir>/voice-clips/<voiceId>/<variante>/<CLASSE>_<n>.wav`, com manifest (voz, variante,
 * engine, modelo, hashes). Cache: se o manifest da variante tem o mesmo hash e todos os arquivos
 * existem, devolve sem sintetizar (o "Gerar clipes" da UI é idempotente); a classe com o mesmo hash
 * por classe é reaproveitada (só as classes que mudaram são sintetizadas); configuração nova =
 * pasta nova — as outras configurações da MESMA voz ficam intactas.
 */
export async function generateClips(opts: GenerateClipsOptions): Promise<ClipsManifest> {
  const ownKey = await ownPoolsKey(opts.own, opts.fillerPool, opts.toolPool)
  const loc = await clipsLocation(opts.baseDir, opts.settings, ownKey)
  // o layout antigo desta configuração é adotado antes (as classes em dia não são sintetizadas)
  await loadVoiceClips(
    opts.baseDir,
    opts.settings,
    opts.fillerPool,
    opts.toolPool,
    opts.thanksPool,
    opts.own
  )
  return withClipLock(loc.dir, () => generateClipsLocked(opts, loc))
}

async function generateClipsLocked(
  opts: GenerateClipsOptions,
  loc: ClipsLocation
): Promise<ClipsManifest> {
  const { voiceId, dir } = loc
  const hash = await clipsHash(opts.settings, opts.fillerPool, opts.toolPool, opts.thanksPool)
  const classHashes = await clipClassHashes(
    opts.settings,
    opts.fillerPool,
    opts.toolPool,
    opts.thanksPool
  )
  const loaded = await loadClips(opts.baseDir, voiceId, loc.variant)
  const existing = loaded && loaded.configKey === loc.configKey ? loaded : null
  if (existing && existing.hash === hash) {
    await markClipsUsed(dir, true)
    return existing
  }
  // classes ainda em dia no cache: os clipes delas ficam (nada é sintetizado de novo)
  const reuse = new Set(
    CLIP_CLASSES.filter((c) => !!existing && existing.classHashes[c] === classHashes[c])
  )

  const phrases = clipPhraseSet(opts.fillerPool, opts.toolPool, opts.thanksPool)
  const entries: VoiceClip[] = []
  const total = CLIP_CLASSES.reduce((a, c) => a + phrases[c].length, 0)
  let done = 0
  await mkdir(dir, { recursive: true })
  await dropBrokenLegacy(opts.baseDir, voiceId)
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
    if (reuse.has(cls) && existing) {
      for (const c of existing.clips.filter((x) => x.class === cls)) {
        entries.push(c)
        done++
        opts.onProgress?.({ done, total, id: c.id })
      }
      continue
    }
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
    variant: loc.variant,
    configKey: loc.configKey,
    backend: opts.settings.backend,
    engine,
    model:
      opts.settings.backend === 'local'
        ? (opts.settings.local?.voice ?? '')
        : opts.settings.backend === 'gpu'
          ? (opts.settings.gpu?.engine ?? '')
          : opts.settings.api.model,
    hash,
    classHashes,
    generatedAt: new Date().toISOString(),
    clips: entries
  }
  await writeManifest(dir, manifest)
  await markClipsUsed(dir, true)
  return manifest
}

/**
 * Manifest da voz ATUAL só quando está em dia com a definição (hash igual — frases/pool/voz/modelo):
 * cache velho (pool mudou, frases trocadas nesta versão) → null (= "Gerar clipes" de novo).
 */
export async function loadCurrentClips(
  baseDir: string,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Promise<ClipsManifest | null> {
  const m = await loadVoiceClips(baseDir, settings, fillerPool, toolPool, thanksPool)
  if (!m) return null
  return m.hash === (await clipsHash(settings, fillerPool, toolPool, thanksPool)) ? m : null
}

/**
 * Classes do conjunto atual cujos clipes estão velhos ou ausentes no cache da voz (`[]` = tudo em
 * dia; sem cache = todas). A UI pede "Gerar clipes" — as outras classes continuam tocando.
 */
export async function clipStaleClasses(
  m: ClipsManifest | null,
  settings: TtsSettings,
  fillerPool?: readonly FillerPhrase[] | null,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null
): Promise<ClipClass[]> {
  if (!m) return [...CLIP_CLASSES]
  const hashes = await clipClassHashes(settings, fillerPool, toolPool, thanksPool)
  return CLIP_CLASSES.filter((c) => m.classHashes[c] !== hashes[c])
}

/**
 * Bytes de um clipe só quando a CLASSE dele está em dia no cache da configuração de voz (senão
 * null — nunca toca clipe velho; a frase de ferramenta e o agradecimento caem na síntese ao vivo).
 */
export async function loadCurrentClipAudio(
  baseDir: string,
  settings: TtsSettings,
  fillerPool: readonly FillerPhrase[] | null | undefined,
  cls: string,
  n: number,
  toolPool?: readonly ToolPhrase[] | null,
  thanksPool?: readonly string[] | null,
  own?: ClipOwnPools | null
): Promise<{ audio: Uint8Array; mime: string } | null> {
  if (!(CLIP_CLASSES as readonly string[]).includes(cls)) return null
  const m = await loadVoiceClips(baseDir, settings, fillerPool, toolPool, thanksPool, own)
  if (!m || !m.clips.some((c) => c.class === cls && c.n === n)) return null
  const current = await clipClassHash(settings, cls as ClipClass, fillerPool, toolPool, thanksPool)
  if (m.classHashes[cls as ClipClass] !== current) return null
  return loadClipAudio(baseDir, m.voiceId, cls, n, m.variant)
}

// ---------------- limpeza (armazenamento limitado) ----------------

/** Arquivos do layout antigo na pasta da voz (nada fora disto é apagado ali). */
const LEGACY_FILE_RE = /^(?:manifest\.json|[A-Z]+_\d+\.wav|[A-Za-z0-9._-]+\.(?:part|tmp))$/

export interface PruneClipsOptions {
  baseDir: string
  /**
   * Settings RESOLVIDAS (`getVoiceSettingsWith`) de toda voz em uso: a deste dispositivo, as das
   * personas e dos chats e a da chamada em andamento — as variantes delas nunca saem.
   */
  keep: readonly TtsSettings[]
  fillerPool?: readonly FillerPhrase[] | null
  toolPool?: readonly ToolPhrase[] | null
  thanksPool?: readonly string[] | null
  /** Vozes de persona/chat com pools PRÓPRIOS em uso (a pasta delas também fica). */
  keepOwn?: readonly {
    settings: TtsSettings
    fillerPool: readonly FillerPhrase[] | null
    toolPool: readonly ToolPhrase[] | null
    own: ClipOwnPools
  }[]
  /** Sem uso há mais que isto (e sem voz em uso) → sai. Padrão `CLIP_UNUSED_MAX_AGE_MS`. */
  maxAgeMs?: number
  now?: number
}

/**
 * Limpeza do cache de clipes: primeiro as vozes em uso adotam o layout antigo que casa com elas;
 * depois sai toda variante que nenhuma delas usa e que não foi tocada/listada/gerada há
 * `maxAgeMs`, e o layout antigo que não casa com nenhuma voz em uso e é mais velho que isso. Nada
 * de uma configuração em uso é apagado; pasta em geração é pulada; pasta de voz vazia sai.
 * Devolve o que saiu (`<voiceId>/<variante>` ou `<voiceId>/(antigo)`).
 */
export async function pruneClips(opts: PruneClipsOptions): Promise<{ removed: string[] }> {
  const now = opts.now ?? Date.now()
  const maxAge = opts.maxAgeMs ?? CLIP_UNUSED_MAX_AGE_MS
  const pools = [opts.fillerPool, opts.toolPool, opts.thanksPool] as const
  // pasta de cada voz em uso (falhar aqui = não limpar nada: nunca apagar de uma voz em uso)
  const keep = new Set<string>()
  for (const s of opts.keep) keep.add((await clipsLocation(opts.baseDir, s)).dir)
  for (const k of opts.keepOwn ?? [])
    keep.add(
      (
        await clipsLocation(
          opts.baseDir,
          k.settings,
          await ownPoolsKey(k.own, k.fillerPool, k.toolPool)
        )
      ).dir
    )
  for (const s of opts.keep) {
    try {
      await loadVoiceClips(opts.baseDir, s, ...pools)
    } catch {
      // adoção falhou: o antigo fica (a checagem abaixo o protege)
    }
  }
  const removed: string[] = []
  const root = clipsRoot(opts.baseDir)
  const voices = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const v of voices) {
    if (!v.isDirectory() || !SAFE_SEGMENT.test(v.name)) continue
    const voiceDir = join(root, v.name)
    const entries = await readdir(voiceDir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || !VARIANT_RE.test(e.name)) continue
      const dir = join(voiceDir, e.name)
      if (keep.has(dir) || clipLocks.has(dir)) continue
      if (now - (await variantLastUsed(dir)) <= maxAge) continue
      await rm(dir, { recursive: true, force: true })
      usageWritten.delete(dir)
      removed.push(`${v.name}/${e.name}`)
    }
    // layout antigo que nenhuma voz em uso adotou (nem casa com uma delas) e velho
    const legacyFiles = entries
      .filter((e) => e.isFile() && LEGACY_FILE_RE.test(e.name))
      .map((e) => e.name)
    if (legacyFiles.length) {
      const legacy = await loadClips(opts.baseDir, v.name)
      let inUse = false
      if (legacy)
        for (const s of opts.keep) if (await legacyMatches(legacy, s, ...pools)) inUse = true
      let when = legacy ? isoMs(legacy.generatedAt) : 0
      if (!when)
        for (const f of legacyFiles)
          when = Math.max(
            when,
            await stat(join(voiceDir, f)).then(
              (x) => x.mtimeMs,
              () => 0
            )
          )
      if (!inUse && now - when > maxAge) {
        for (const f of legacyFiles) await rm(join(voiceDir, f), { force: true })
        removed.push(`${v.name}/(antigo)`)
      }
    }
    const left = await readdir(voiceDir).catch(() => ['?'])
    if (!left.length) await rm(voiceDir, { recursive: true, force: true })
  }
  return { removed }
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
