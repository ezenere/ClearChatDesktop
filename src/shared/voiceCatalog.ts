// Descoberta de modelos e vozes de STT/TTS nos provedores cadastrados (Configurações → Áudio).
// Funções PURAS (sem rede): o main (`src/main/voice/voiceCatalog.ts`) busca as listagens e passa o
// JSON para estes parsers; a UI usa os tipos, `voiceProviderSupport` e `resolveModelAlias`. Nada
// aqui carrega chave de API. Ver SPEC.md → "Áudio → Provedor, modelo e voz (descoberta)".
import { inferProviderKind, isProviderKind } from './providerKinds'

/** Capacidade de áudio pedida a um provedor. */
export type VoiceCapability = 'stt' | 'tts'

/** Família de API de áudio de um provedor (decide como listar modelos/vozes). */
export type VoiceProviderSupport = 'openrouter' | 'elevenlabs' | 'openai'

/** Um modelo de STT/TTS oferecido pelo provedor. */
export interface VoiceCatalogModel {
  /** Id exato enviado no campo `model` (ex.: 'openai/whisper-large-v3-turbo'). */
  id: string
  /** Nome legível (ex.: 'OpenAI: Whisper Large V3 Turbo'). */
  label: string
  /** Descrição curta (primeira frase), quando o provedor publica. */
  description?: string | null
  /** Preço resumido para a UI (ex.: 'US$ 40 / 1M caracteres'), quando conhecido. */
  priceHint?: string | null
  /**
   * Preço de lista por unidade em US$ (OpenRouter `pricing.prompt`: TTS = por caractere de entrada;
   * STT = por segundo de áudio) — custo ≈ da chamada de voz. null/ausente = desconhecido.
   */
  unitPrice?: number | null
  /** Vozes aceitas por este modelo (ids); null/ausente = todas as `voices` do catálogo. */
  voiceIds?: string[] | null
  /**
   * Latência medida (ms): TTS = 1º áudio de uma frase curta pt-BR; STT = transcrição de um clipe de
   * ~4 s (ver `CALL_TTS_MODELS_*` / `STT_SLOW_MODELS`). null/ausente = não medido.
   */
  latencyMs?: number | null
  /** Lento demais para a chamada de voz (STT: badge "lento"; TTS: modelo fora da lista curada). */
  slow?: boolean
  /** Vozes recomendadas para pt-BR neste modelo (ordem de preferência; vazio = voz padrão). */
  ptVoices?: string[]
}

/** Uma voz de TTS (com metadados para os badges do seletor). */
export interface VoiceCatalogVoice {
  /** Id exato enviado no campo `voice` (ex.: 'sarah', 'EXAVITQu4vr4xnSDxMaL'). */
  id: string
  label: string
  /** Idioma/sotaque principal (ex.: 'pt-BR', 'en-US', 'multilíngue'). */
  language?: string | null
  gender?: 'female' | 'male' | 'neutral' | null
  /** Sotaque/descrição curta (ex.: 'britânico', 'americano'). */
  accent?: string | null
  /** URL pública de uma prévia em áudio (ElevenLabs direto); null = sintetizar pelo teste. */
  previewUrl?: string | null
  /** Recomendada para pt-BR no modelo escolhido (badge; ver `orderVoicesForPt`). */
  recommended?: boolean
}

/** Resultado de `voice:catalog:list` — nunca contém chave de API. */
export interface VoiceCatalogView {
  capability: VoiceCapability
  /** Provedor cadastrado consultado. */
  providerId: string
  /** De onde veio a lista ('static' = tabela embutida porque a listagem falhou/não existe). */
  source: VoiceProviderSupport | 'static' | 'none'
  models: VoiceCatalogModel[]
  voices: VoiceCatalogVoice[]
  /** A lista pode estar incompleta: a UI aceita um id digitado. */
  freeText: boolean
  /** Falha legível da listagem (a UI mostra e oferece "Tentar de novo"); null = ok. */
  error: string | null
  /** Dica visível (ex.: "o provedor não lista modelos de áudio — digite o id"). */
  hint: string | null
  /** Momento da busca (ms epoch) — o main guarda em cache por `VOICE_CATALOG_CACHE_MS`. */
  fetchedAt: number
  /**
   * `models` é a lista curada para a chamada (TTS no OpenRouter/ElevenLabs direto — ver
   * `curateVoiceModels`): só os modelos medidos rápidos e com pt-BR.
   */
  curated?: boolean
  /**
   * Modelos que o provedor lista mas a curadoria escondeu (lentos/sem pt-BR/sem pcm) — a UI usa
   * para reconhecer um modelo salvo antigo e avisar "modelo lento para chamada".
   */
  hiddenModels?: VoiceCatalogModel[]
}

/** Pedido de `voice:catalog:list`. */
export interface VoiceCatalogRequest {
  capability: VoiceCapability
  /** Provedor cadastrado (Configurações → Provedores) a listar. */
  providerId: string
  /** Ignora o cache (botão "Atualizar"). */
  refresh?: boolean
}

/** Cache das listagens no main (10 min). */
export const VOICE_CATALOG_CACHE_MS = 10 * 60_000

/** Frase da prévia de voz (▶ do seletor quando o provedor não publica `preview_url`). */
export const VOICE_PREVIEW_PHRASE = 'Olá, esta é a minha voz.'

// ---------------- provedor → família de API ----------------

/** Host da API do ElevenLabs (provedor `elevenlabs` direto). */
export const ELEVENLABS_API_HOST = 'api.elevenlabs.io'

const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Família de API de áudio de um provedor cadastrado: `elevenlabs` (kind `elevenlabs` ou host
 * `api.elevenlabs.io`), `openrouter`, `openai` (OpenAI-compatível genérico — Groq, OpenAI, servidor
 * local) ou null (Anthropic nativa: sem áudio).
 */
export function voiceProviderSupport(p: {
  baseUrl: string
  kind?: unknown
}): VoiceProviderSupport | null {
  const host = hostOf(p.baseUrl)
  if (p.kind === 'elevenlabs' || host === ELEVENLABS_API_HOST || host.endsWith('.elevenlabs.io'))
    return 'elevenlabs'
  const kind = isProviderKind(p.kind) ? p.kind : inferProviderKind(p.baseUrl)
  if (kind === 'anthropic') return null
  return kind === 'openrouter' ? 'openrouter' : 'openai'
}

/**
 * O provedor serve a capacidade? STT usa o `/audio/transcriptions` OpenAI-compatível, que o
 * ElevenLabs direto não tem (Scribe tem API própria) → só TTS lá.
 */
export function providerSupportsVoice(
  p: { baseUrl: string; kind?: unknown },
  capability: VoiceCapability
): boolean {
  const s = voiceProviderSupport(p)
  if (!s) return false
  return capability === 'tts' || s !== 'elevenlabs'
}

// ---------------- helpers ----------------

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const listOf = (j: unknown, ...keys: string[]): unknown[] | null => {
  if (Array.isArray(j)) return j
  const o = asObj(j)
  if (!o) return null
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[]
  return null
}
const firstSentence = (s: string): string | null => {
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return null
  const m = /^(.{8,200}?[.!?])(\s|$)/.exec(t)
  const out = m ? m[1] : t
  return out.length > 200 ? `${out.slice(0, 199)}…` : out
}
const capitalize = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

// ---------------- OpenRouter ----------------

/**
 * Filtro de modalidade de saída do `/models` do OpenRouter por capacidade (conferido em
 * 2026-10-23: `?output_modalities=speech` lista os TTS com `supported_voices`;
 * `?output_modalities=transcription` lista os STT — o `/models` sem filtro só traz modelos de texto).
 */
export const OPENROUTER_OUTPUT_MODALITY: Record<VoiceCapability, string> = {
  tts: 'speech',
  stt: 'transcription'
}

function openRouterPriceHint(pricing: unknown, capability: VoiceCapability): string | null {
  const p = asObj(pricing)
  if (!p) return null
  const prompt = Number(p.prompt)
  if (!Number.isFinite(prompt) || prompt <= 0) {
    const completion = Number(p.completion)
    return Number.isFinite(completion) && completion === 0 && prompt === 0 ? 'grátis' : null
  }
  // TTS cobra por caractere de entrada; STT por segundo de áudio (preço publicado por "token")
  if (capability === 'tts') {
    const perM = prompt * 1_000_000
    return `US$ ${perM >= 10 ? perM.toFixed(0) : perM.toFixed(2)} / 1M caracteres`
  }
  const perMin = prompt * 60
  return `US$ ${perMin >= 0.1 ? perMin.toFixed(3) : perMin.toFixed(4)} / min`
}

/** `pricing.prompt` do OpenRouter como número (US$ por unidade); inválido → null. */
export function openRouterUnitPrice(pricing: unknown): number | null {
  const p = asObj(pricing)
  const v = p ? Number(p.prompt) : NaN
  return Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * Parser do `GET {baseUrl}/models?output_modalities=speech|transcription` do OpenRouter. Aceita a
 * lista completa também (filtra por `architecture.output_modalities`). Vozes vêm de
 * `supported_voices` por modelo; os metadados (gênero/sotaque/idioma) saem de `describeVoice`.
 */
export function parseOpenRouterAudioModels(
  json: unknown,
  capability: VoiceCapability
): { models: VoiceCatalogModel[]; voices: VoiceCatalogVoice[] } {
  const list = listOf(json, 'data')
  if (!list) throw new Error('Formato inesperado da lista de modelos do OpenRouter.')
  const want = OPENROUTER_OUTPUT_MODALITY[capability]
  const models: VoiceCatalogModel[] = []
  const voices = new Map<string, VoiceCatalogVoice>()
  for (const raw of list) {
    const m = asObj(raw)
    const id = str(m?.id)
    if (!m || !id) continue
    const arch = asObj(m.architecture)
    const out = Array.isArray(arch?.output_modalities) ? (arch.output_modalities as unknown[]) : []
    if (out.length && !out.includes(want)) continue
    const voiceIds = Array.isArray(m.supported_voices)
      ? (m.supported_voices as unknown[]).map(str).filter(Boolean)
      : []
    for (const v of voiceIds) if (!voices.has(v)) voices.set(v, describeVoice(v, id))
    models.push({
      id,
      label: str(m.name) || id,
      description: firstSentence(str(m.description)),
      priceHint: openRouterPriceHint(m.pricing, capability),
      unitPrice: openRouterUnitPrice(m.pricing),
      ...(capability === 'tts' ? { voiceIds } : {})
    })
  }
  models.sort((a, b) => a.label.localeCompare(b.label))
  return { models, voices: [...voices.values()] }
}

// ---------------- ElevenLabs (direto) ----------------

/**
 * Parser do `GET https://api.elevenlabs.io/v1/models` (array de `{ model_id, name, description,
 * can_do_text_to_speech, languages: [{ language_id, name }] }`). TTS = modelos com
 * `can_do_text_to_speech` (ausente = sim).
 */
export function parseElevenLabsModels(json: unknown): VoiceCatalogModel[] {
  const list = listOf(json, 'models')
  if (!list) throw new Error('Formato inesperado da lista de modelos do ElevenLabs.')
  const out: VoiceCatalogModel[] = []
  for (const raw of list) {
    const m = asObj(raw)
    const id = str(m?.model_id) || str(m?.id)
    if (!m || !id) continue
    if (m.can_do_text_to_speech === false) continue
    const langs = Array.isArray(m.languages) ? m.languages.length : 0
    const desc = firstSentence(str(m.description))
    out.push({
      id,
      label: str(m.name) || id,
      description: desc,
      priceHint: langs > 1 ? `${langs} idiomas` : null
    })
  }
  return out
}

const GENDERS: Record<string, VoiceCatalogVoice['gender']> = {
  female: 'female',
  male: 'male',
  neutral: 'neutral',
  feminino: 'female',
  masculino: 'male',
  non_binary: 'neutral',
  'non-binary': 'neutral'
}

/**
 * Parser do `GET https://api.elevenlabs.io/v1/voices` (`{ voices: [{ voice_id, name, category,
 * labels: { gender, accent, language?, description }, preview_url, verified_languages: [{ locale,
 * language, preview_url }] }] }`). Prévia em pt quando a voz tem `verified_languages` em português.
 */
export function parseElevenLabsVoices(json: unknown): VoiceCatalogVoice[] {
  const list = listOf(json, 'voices')
  if (!list) throw new Error('Formato inesperado da lista de vozes do ElevenLabs.')
  const out: VoiceCatalogVoice[] = []
  for (const raw of list) {
    const v = asObj(raw)
    const id = str(v?.voice_id) || str(v?.id)
    if (!v || !id) continue
    const labels = asObj(v.labels) ?? {}
    const verified = Array.isArray(v.verified_languages)
      ? (v.verified_languages as unknown[]).map(asObj).filter((x) => !!x)
      : []
    const pt = verified.find((l) => /^pt/i.test(str(l.locale) || str(l.language)))
    const lang =
      str(pt?.locale) ||
      str(labels.language) ||
      (verified.length > 1 ? 'multilíngue' : str(verified[0]?.locale)) ||
      null
    const preview = str(pt?.preview_url) || str(v.preview_url)
    const name = str(v.name) || id
    out.push({
      id,
      // nomes do ElevenLabs vêm como "Sarah - Mature, Reassuring" — o rótulo fica no nome
      label: name.split(/\s+-\s+/)[0] || name,
      language: lang,
      gender: GENDERS[str(labels.gender).toLowerCase()] ?? null,
      accent: str(labels.accent) || null,
      previewUrl: /^https:\/\//i.test(preview) ? preview : null
    })
  }
  out.sort((a, b) => a.label.localeCompare(b.label))
  return out
}

// ---------------- OpenAI-compatível genérico ----------------

const STT_ID_RE = /whisper|transcri|\bstt\b|-stt|asr|scribe|parakeet|voxtral|nova-?\d|canary/i
const TTS_ID_RE = /tts|speech|kokoro|eleven|aura|orpheus|piper|xtts|voice/i

/**
 * `GET {baseUrl}/models` de um endpoint OpenAI-compatível filtrado pela heurística do id
 * (whisper/transcribe/… para STT; tts/speech/… para TTS). `filtered` = quantos modelos o endpoint
 * listou no total (a UI avisa quando nenhum parece de áudio e aceita texto livre).
 */
export function parseOpenAiAudioModels(
  json: unknown,
  capability: VoiceCapability
): { models: VoiceCatalogModel[]; total: number } {
  const list = listOf(json, 'data', 'models')
  if (!list) throw new Error('Formato inesperado da resposta de /models.')
  const re = capability === 'stt' ? STT_ID_RE : TTS_ID_RE
  const all = list
    .map((raw) => {
      const m = asObj(raw)
      const id = str(m?.id) || str(m?.name)
      return id ? { id, label: str(m?.name) || id } : null
    })
    .filter((m): m is { id: string; label: string } => !!m)
  const models = all
    .filter((m) => re.test(m.id))
    .map((m) => ({ id: m.id, label: m.label }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { models, total: all.length }
}

/** Vozes comuns dos endpoints OpenAI-compatíveis (`/audio/speech` da OpenAI e clones). */
export const OPENAI_TTS_VOICES: readonly string[] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer'
]

// ---------------- metadados das vozes ----------------

/**
 * Vozes premade do ElevenLabs aceitas pelo OpenRouter (os 21 `supported_voices` dos modelos
 * `elevenlabs/*` em 2026-10-23), com gênero/sotaque da biblioteca do ElevenLabs. Todas falam
 * pt-BR nos modelos multilíngues (Flash v2.5, Turbo v2.5, Multilingual v2, v3, v4).
 */
export const ELEVENLABS_PREMADE_VOICES: Record<
  string,
  { gender: 'female' | 'male' | 'neutral'; accent: string }
> = {
  george: { gender: 'male', accent: 'britânico' },
  sarah: { gender: 'female', accent: 'americano' },
  adam: { gender: 'male', accent: 'americano' },
  alice: { gender: 'female', accent: 'britânico' },
  bella: { gender: 'female', accent: 'americano' },
  bill: { gender: 'male', accent: 'americano' },
  brian: { gender: 'male', accent: 'americano' },
  callum: { gender: 'male', accent: 'transatlântico' },
  charlie: { gender: 'male', accent: 'australiano' },
  chris: { gender: 'male', accent: 'americano' },
  daniel: { gender: 'male', accent: 'britânico' },
  eric: { gender: 'male', accent: 'americano' },
  harry: { gender: 'male', accent: 'americano' },
  jessica: { gender: 'female', accent: 'americano' },
  laura: { gender: 'female', accent: 'americano' },
  liam: { gender: 'male', accent: 'americano' },
  lily: { gender: 'female', accent: 'britânico' },
  matilda: { gender: 'female', accent: 'americano' },
  river: { gender: 'neutral', accent: 'americano' },
  roger: { gender: 'male', accent: 'americano' },
  will: { gender: 'male', accent: 'americano' }
}

/** Prefixo de idioma das vozes do Kokoro (`pf_dora` → p = pt-BR, f = feminina). */
const KOKORO_LANG: Record<string, string> = {
  a: 'en-US',
  b: 'en-GB',
  e: 'es',
  f: 'fr',
  h: 'hi',
  i: 'it',
  j: 'ja',
  p: 'pt-BR',
  z: 'zh'
}

/**
 * Metadados de uma voz a partir do id (heurísticas por família de modelo): ElevenLabs premade
 * (tabela), Microsoft `pt-BR-Nome:Modelo`, Deepgram `aura-2-nome-en`/`flux-nome-en`, Kokoro
 * `pf_dora`. Sem padrão conhecido → só o rótulo capitalizado.
 */
export function describeVoice(id: string, modelId = ''): VoiceCatalogVoice {
  const el = ELEVENLABS_PREMADE_VOICES[id.toLowerCase()]
  if (el && (!modelId || /^elevenlabs\//i.test(modelId)))
    return {
      id,
      label: capitalize(id),
      gender: el.gender,
      accent: el.accent,
      language: 'multilíngue'
    }
  let m = /^([a-z]{2}-[A-Z]{2})-([A-Za-z]+)(?::.*)?$/.exec(id)
  if (m) return { id, label: m[2], language: m[1] }
  m = /^(?:aura-2|flux)-([a-z]+)-([a-z]{2})$/.exec(id)
  if (m) return { id, label: capitalize(m[1]), language: m[2] }
  m = /^([abefhijpz])([fm])_([a-z]+)$/.exec(id)
  if (m)
    return {
      id,
      label: capitalize(m[3]),
      language: KOKORO_LANG[m[1]] ?? null,
      gender: m[2] === 'f' ? 'female' : 'male'
    }
  m = /^(en|gb|fr|de|es|it|pt)_([a-z]+)_([a-z]+)$/.exec(id)
  if (m)
    return {
      id,
      label: `${capitalize(m[2])} (${m[3]})`,
      language: m[1] === 'gb' ? 'en-GB' : m[1]
    }
  return { id, label: capitalize(id.replace(/[_-]+/g, ' ')) }
}

// ---------------- validação/correção do id do modelo ----------------

/**
 * Apelidos conhecidos de modelos de áudio sem o prefixo do OpenRouter (o id que funciona na Groq,
 * na OpenAI ou na API própria do fornecedor). Usado sem rede.
 */
export const OPENROUTER_MODEL_ALIASES: Record<string, string> = {
  'whisper-large-v3-turbo': 'openai/whisper-large-v3-turbo',
  'whisper-large-v3': 'openai/whisper-large-v3',
  'whisper-1': 'openai/whisper-1',
  'gpt-4o-transcribe': 'openai/gpt-4o-transcribe',
  'gpt-4o-mini-transcribe': 'openai/gpt-4o-mini-transcribe',
  'scribe-v2': 'elevenlabs/scribe-v2',
  scribe_v2: 'elevenlabs/scribe-v2',
  'nova-3': 'deepgram/nova-3',
  eleven_flash_v2_5: 'elevenlabs/eleven-flash-v2.5',
  eleven_turbo_v2_5: 'elevenlabs/eleven-turbo-v2.5',
  eleven_multilingual_v2: 'elevenlabs/eleven-multilingual-v2',
  eleven_v3: 'elevenlabs/eleven-v3',
  eleven_flash_v2: 'elevenlabs/eleven-flash-v2',
  eleven_turbo_v2: 'elevenlabs/eleven-turbo-v2'
}

/** Forma comparável de um id: sem prefixo `fornecedor/`, minúsculas, `_`/`.` viram `-`. */
const aliasKey = (id: string): string =>
  id
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/[_.]+/g, '-')

/**
 * O id do modelo existe no provedor? Se não existe mas há UM id equivalente na lista (mesmo nome
 * sem o prefixo `fornecedor/`, ou com `_`/`.` trocados — ex.: `whisper-large-v3-turbo` →
 * `openai/whisper-large-v3-turbo`, `elevenlabs/eleven-flash-v2.5` → `eleven_flash_v2_5`), devolve a
 * correção. `null` = id desconhecido sem equivalente único (a UI avisa).
 */
export function resolveModelAlias(
  model: string,
  ids: readonly string[]
): { id: string; corrected: boolean } | null {
  const m = model.trim()
  if (!m) return null
  if (ids.includes(m)) return { id: m, corrected: false }
  const ci = ids.filter((x) => x.toLowerCase() === m.toLowerCase())
  if (ci.length === 1) return { id: ci[0], corrected: true }
  const key = aliasKey(m)
  const hits = ids.filter((x) => aliasKey(x) === key)
  if (hits.length === 1) return { id: hits[0], corrected: true }
  return null
}

// ---------------- curadoria para a chamada (TTS remoto) ----------------

/** Um modelo de fala aprovado para a chamada (medido). */
export interface CallTtsModel {
  /** 1º áudio (ms) da frase curta pt-BR (45 caracteres, `response_format: 'pcm'`). */
  firstAudioMs: number
  /** Total (ms) da mesma frase (áudio inteiro recebido). */
  totalMs: number
  /** Voz usada na medição (null = voz padrão do modelo — o modelo não lista vozes). */
  testedVoice: string | null
  /** Vozes recomendadas para pt-BR (ordem de preferência); vazio = voz padrão do modelo. */
  ptVoices: string[]
}

/**
 * Modelos de fala do OpenRouter aprovados para a chamada de voz — a fonte da verdade do seletor
 * (modelo novo/desconhecido na listagem fica escondido até ser medido). Critério: 1º áudio ≤ ~0,9 s
 * para "Claro, já vou verificar isso para você agora." (45 caracteres, `pcm`, como o app pede) e
 * pt-BR aceitável (ida e volta pelo `openai/whisper-large-v3-turbo` sem idioma forçado: transcrição
 * em português, WER 0). Medido em 2026-10-23, uma chamada por modelo (conexão já aquecida), a
 * partir do Brasil. Fora da lista (motivo em `CALL_TTS_EXCLUDED_OPENROUTER`): ElevenLabs v3/v4/
 * Multilingual (1,0–1,5 s), Gemini TTS (2–3 s), Qwen, HeyGen, MAI-Voice-2/2.1 (não Flash), Voxtral,
 * Orpheus/CSM/Flux/Aura (sem pt-BR), MiniMax (não aceita pcm), Flash/Turbo v2 (só inglês).
 */
export const CALL_TTS_MODELS_OPENROUTER: Readonly<Record<string, CallTtsModel>> = {
  'elevenlabs/eleven-flash-v2.5': {
    firstAudioMs: 479,
    totalMs: 546,
    testedVoice: 'sarah',
    ptVoices: ['sarah']
  },
  'elevenlabs/eleven-turbo-v2.5': {
    firstAudioMs: 474,
    totalMs: 552,
    testedVoice: 'sarah',
    ptVoices: ['sarah']
  },
  'fish-audio/s1': { firstAudioMs: 406, totalMs: 675, testedVoice: null, ptVoices: [] },
  'fish-audio/drama-3': { firstAudioMs: 448, totalMs: 876, testedVoice: null, ptVoices: [] },
  'fish-audio/s2-pro': { firstAudioMs: 475, totalMs: 978, testedVoice: null, ptVoices: [] },
  'fish-audio/s2.1-pro': { firstAudioMs: 510, totalMs: 800, testedVoice: null, ptVoices: [] },
  'x-ai/grok-voice-tts-1.0': {
    firstAudioMs: 655,
    totalMs: 908,
    testedVoice: 'eve',
    ptVoices: ['eve']
  },
  'hexgrad/kokoro-82m': {
    firstAudioMs: 772,
    totalMs: 784,
    testedVoice: 'pf_dora',
    ptVoices: ['pf_dora', 'pm_alex', 'pm_santa']
  },
  'microsoft/mai-voice-2.1-flash': {
    firstAudioMs: 786,
    totalMs: 1156,
    testedVoice: 'pt-BR-Luana:MAI-Voice-2.1-Flash',
    ptVoices: [
      'pt-BR-Luana:MAI-Voice-2.1-Flash',
      'pt-BR-Caio:MAI-Voice-2.1-Flash',
      'pt-BR-Pedro:MAI-Voice-2.1-Flash',
      'pt-BR-Rafael:MAI-Voice-2.1-Flash'
    ]
  }
}

/** Por que um modelo listado ficou fora da chamada (aviso quando ele está salvo). */
export type CallTtsExclusion = 'slow' | 'no-pt' | 'no-pcm' | 'unreliable'

/**
 * Modelos do OpenRouter medidos e REPROVADOS para a chamada (mesma medição de 2026-10-23):
 * `firstAudioMs` medido (null = não medido) e o motivo. Serve só à mensagem do aviso — qualquer
 * modelo fora de `CALL_TTS_MODELS_OPENROUTER` já fica escondido.
 */
export const CALL_TTS_EXCLUDED_OPENROUTER: Readonly<
  Record<string, { firstAudioMs: number | null; reason: CallTtsExclusion }>
> = {
  'elevenlabs/eleven-v4': { firstAudioMs: 1329, reason: 'slow' },
  'elevenlabs/eleven-v4-turbo': { firstAudioMs: 1013, reason: 'slow' },
  'elevenlabs/eleven-v3': { firstAudioMs: 1491, reason: 'slow' },
  'elevenlabs/eleven-v3-conversational': { firstAudioMs: 1359, reason: 'slow' },
  'elevenlabs/eleven-multilingual-v2': { firstAudioMs: 1079, reason: 'slow' },
  'elevenlabs/eleven-turbo-v2': { firstAudioMs: 532, reason: 'no-pt' },
  'elevenlabs/eleven-flash-v2': { firstAudioMs: 583, reason: 'no-pt' },
  'mistralai/voxtral-mini-tts-3-0': { firstAudioMs: 979, reason: 'slow' },
  'mistralai/voxtral-mini-tts-2603': { firstAudioMs: 914, reason: 'no-pt' },
  'heygen/heygen-voice-1': { firstAudioMs: 2274, reason: 'slow' },
  'heygen/heygen-voice-1-turbo': { firstAudioMs: 1575, reason: 'slow' },
  'microsoft/mai-voice-2.1': { firstAudioMs: 1500, reason: 'slow' },
  'microsoft/mai-voice-2-flash': { firstAudioMs: 1273, reason: 'slow' },
  'microsoft/mai-voice-2': { firstAudioMs: 1166, reason: 'slow' },
  'google/gemini-3.8-flash-lite-tts': { firstAudioMs: 2053, reason: 'slow' },
  'google/gemini-3.8-flash-tts': { firstAudioMs: 2457, reason: 'slow' },
  'google/gemini-3.1-flash-tts-preview': { firstAudioMs: 2923, reason: 'slow' },
  'qwen/qwen-audio-3.0-tts-flash': { firstAudioMs: 2219, reason: 'slow' },
  'qwen/qwen-audio-3.0-tts-plus': { firstAudioMs: 1927, reason: 'slow' },
  'minimax/speech-2.8-hd': { firstAudioMs: 1801, reason: 'slow' },
  'minimax/speech-2.8-turbo': { firstAudioMs: 562, reason: 'no-pcm' },
  'deepgram/flux-tts': { firstAudioMs: 1207, reason: 'no-pt' },
  'deepgram/aura-2': { firstAudioMs: 766, reason: 'no-pt' },
  'canopylabs/orpheus-3b-0.1-ft': { firstAudioMs: 1897, reason: 'no-pt' },
  'sesame/csm-1b': { firstAudioMs: 16201, reason: 'no-pt' },
  'fish-audio/s2.1-pro-free:free': { firstAudioMs: 719, reason: 'unreliable' },
  'bytedance-seed/seed-audio-1-0': { firstAudioMs: null, reason: 'slow' }
}

/**
 * Modelos do ElevenLabs direto aprovados para a chamada: só as famílias de baixa latência com
 * português (Flash/Turbo v2.5). Medido em 2026-10-23 pelo REST `/stream` (`pcm_24000`, voz Sarah,
 * mesma frase): Flash 0,28 s / Turbo 0,31 s até o 1º áudio; pelo WebSocket `stream-input` ≈ 0,55 s
 * a quente. v4 Turbo direto (REST `/stream`, 2026-10-23): 1º áudio ~0,29 s (total ~0,85 s para
 * 3 s de fala) — entra, mais expressivo; sem `stream-input`, a chamada pede frase a frase pelo REST.
 * Multilingual v2 (~1,1 s pelo OpenRouter), v3 e v4 (não Turbo) ficam fora (lentos e sem
 * `stream-input`); Flash/Turbo v2 só falam inglês.
 */
export const CALL_TTS_MODELS_ELEVENLABS: Readonly<
  Record<string, CallTtsModel & { label: string }>
> = {
  eleven_flash_v2_5: {
    label: 'Eleven Flash v2.5',
    firstAudioMs: 279,
    totalMs: 383,
    testedVoice: 'EXAVITQu4vr4xnSDxMaL',
    ptVoices: []
  },
  eleven_turbo_v2_5: {
    label: 'Eleven Turbo v2.5',
    firstAudioMs: 311,
    totalMs: 335,
    testedVoice: 'EXAVITQu4vr4xnSDxMaL',
    ptVoices: []
  },
  eleven_v4_turbo: {
    label: 'Eleven v4 Turbo',
    firstAudioMs: 287,
    totalMs: 851,
    testedVoice: 'EXAVITQu4vr4xnSDxMaL',
    ptVoices: []
  }
}

/** Modelo/voz recomendados para a chamada por família curada (troca de um clique no aviso). */
export const CALL_TTS_RECOMMENDED: Readonly<
  Record<'openrouter' | 'elevenlabs', { model: string; voice: string | null; label: string }>
> = {
  openrouter: {
    model: 'elevenlabs/eleven-flash-v2.5',
    voice: 'sarah',
    label: 'ElevenLabs Flash v2.5'
  },
  elevenlabs: { model: 'eleven_flash_v2_5', voice: null, label: 'Eleven Flash v2.5' }
}

/**
 * STT lentos para a chamada (mediana da transcrição de clipes pt-BR de 2–9 s pelo OpenRouter em
 * 2026-10-23; ~4 s de áudio levam > 2 s) — continuam na lista com o badge "lento".
 */
export const STT_SLOW_MODELS: Readonly<Record<string, number>> = {
  'google/gemini-3.5-transcribe': 2300,
  'google/gemini-3.8-flash': 3070
}

/** Latência curta para os badges: 474 → "~0,5 s". */
export function formatLatency(ms: number): string {
  return `~${(Math.max(100, ms) / 1000).toFixed(1).replace('.', ',')} s`
}

/** O modelo é aprovado para a chamada nesta família? (famílias não curadas: sempre). */
export function isCallTtsModel(family: VoiceProviderSupport | null, model: string): boolean {
  const m = model.trim()
  if (family === 'openrouter') return m in CALL_TTS_MODELS_OPENROUTER
  if (family === 'elevenlabs') return m in CALL_TTS_MODELS_ELEVENLABS
  return true
}

/** Medição/motivo de um modelo reprovado (ElevenLabs direto: pelo id equivalente do OpenRouter). */
function excludedInfo(
  family: VoiceProviderSupport | null,
  model: string
): { firstAudioMs: number | null; reason: CallTtsExclusion } | undefined {
  const id = family === 'elevenlabs' ? (OPENROUTER_MODEL_ALIASES[model] ?? '') : model
  return family === 'openrouter' || family === 'elevenlabs'
    ? CALL_TTS_EXCLUDED_OPENROUTER[id]
    : undefined
}

/**
 * Aviso para um modelo salvo fora da lista curada: null = aprovado (ou família não curada); senão
 * o texto curto (inclui a latência medida quando há).
 */
export function callTtsWarning(family: VoiceProviderSupport | null, model: string): string | null {
  const m = model.trim()
  if (!m || isCallTtsModel(family, m)) return null
  const ex = excludedInfo(family, m)
  const measured =
    ex?.firstAudioMs != null ? ` (medido: ${formatLatency(ex.firstAudioMs)} até o 1º áudio)` : ''
  if (ex?.reason === 'no-pt')
    return `Modelo sem pt-BR bom para a chamada${measured} — escolha um da lista.`
  if (ex?.reason === 'no-pcm')
    return 'Modelo não serve à chamada (não entrega áudio em streaming pcm) — escolha um da lista.'
  if (ex?.reason === 'unreliable')
    return 'Modelo sem garantia de latência para a chamada — escolha um da lista.'
  return `Modelo lento para chamada${measured} — escolha um da lista.`
}

/**
 * Aplica a curadoria da chamada a uma listagem: TTS no OpenRouter → só os modelos de
 * `CALL_TTS_MODELS_OPENROUTER` que o provedor listou (o resto vai para `hidden`); TTS no ElevenLabs
 * direto → Flash/Turbo v2.5 SEMPRE (mesmo se `/v1/models` falhar ou a chave não puder listar),
 * com o nome da listagem quando veio; STT → todos, com `slow`/`latencyMs` dos lentos conhecidos;
 * OpenAI-compatível (servidor próprio) → sem curadoria. Ordem: o recomendado primeiro, depois por
 * latência medida.
 */
export function curateVoiceModels(
  models: readonly VoiceCatalogModel[],
  capability: VoiceCapability,
  family: VoiceProviderSupport | null
): { models: VoiceCatalogModel[]; hidden: VoiceCatalogModel[]; curated: boolean } {
  if (capability === 'stt')
    return {
      models: models.map((m) =>
        m.id in STT_SLOW_MODELS ? { ...m, slow: true, latencyMs: STT_SLOW_MODELS[m.id] } : m
      ),
      hidden: [],
      curated: false
    }
  if (family !== 'openrouter' && family !== 'elevenlabs')
    return { models: [...models], hidden: [], curated: false }
  const table: Readonly<Record<string, CallTtsModel>> =
    family === 'openrouter' ? CALL_TTS_MODELS_OPENROUTER : CALL_TTS_MODELS_ELEVENLABS
  const shown: VoiceCatalogModel[] = []
  const hidden: VoiceCatalogModel[] = []
  for (const m of models) {
    const c = table[m.id]
    if (c) shown.push({ ...m, latencyMs: c.firstAudioMs, ptVoices: c.ptVoices })
    else
      hidden.push({ ...m, slow: true, latencyMs: excludedInfo(family, m.id)?.firstAudioMs ?? null })
  }
  if (family === 'elevenlabs')
    for (const [id, c] of Object.entries(CALL_TTS_MODELS_ELEVENLABS))
      if (!shown.some((m) => m.id === id))
        shown.push({ id, label: c.label, latencyMs: c.firstAudioMs, ptVoices: c.ptVoices })
  const rec = CALL_TTS_RECOMMENDED[family].model
  shown.sort(
    (a, b) =>
      Number(b.id === rec) - Number(a.id === rec) ||
      (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9) ||
      a.label.localeCompare(b.label)
  )
  return { models: shown, hidden, curated: true }
}

/** Posição de uma voz na ordem "pt primeiro": pt-BR, pt-*, multilíngue, resto. */
const ptRank = (v: VoiceCatalogVoice): number => {
  const l = (v.language ?? '').toLowerCase()
  if (l === 'pt-br') return 0
  if (l.startsWith('pt')) return 1
  if (l === 'multilíngue') return 2
  return 3
}

/**
 * Vozes na ordem para pt-BR: as recomendadas do modelo primeiro (na ordem dada, com
 * `recommended: true`), depois pt-BR, outras pt, multilíngues e o resto (ordem original dentro de
 * cada grupo).
 */
export function orderVoicesForPt(
  voices: readonly VoiceCatalogVoice[],
  recommended: readonly string[] = []
): VoiceCatalogVoice[] {
  const rec = new Map(recommended.map((id, i) => [id, i]))
  return voices
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const ra = rec.get(a.v.id)
      const rb = rec.get(b.v.id)
      if (ra != null || rb != null) return (ra ?? 1e9) - (rb ?? 1e9)
      return ptRank(a.v) - ptRank(b.v) || a.i - b.i
    })
    .map(({ v }) => (rec.has(v.id) ? { ...v, recommended: true } : v))
}

// ---------------- tags de voz (audio tags) ----------------

/**
 * O modelo de fala interpreta tags de voz entre colchetes (`@shared/audioTags`)? Sem flag na API —
 * basta o texto com as tags e um destes modelos:
 * - ElevenLabs direto: famílias Eleven v3/v4 (`eleven_v3`, `eleven_v3_conversational`, `eleven_v4`,
 *   `eleven_v4_turbo`) — as anteriores (Flash/Turbo v2.5, Multilingual) ignoram/leem as tags. O
 *   WebSocket `stream-input` NÃO aceita v3/v4 (a chamada já vai por HTTP frase a frase com eles; há
 *   um WebSocket separado de Text-to-Dialogue — `/v1/text-to-dialogue/stream-input` — não usado);
 * - OpenRouter: `elevenlabs/eleven-v3*`/`elevenlabs/eleven-v4*` e o Fish Audio Drama 3 / S2 Pro /
 *   S2.1 Pro (direções em linguagem livre entre colchetes antes da frase — "[nervous, whispering]";
 *   o S1 usa parênteses → fora).
 * `family` = `voiceProviderSupport` do provedor (null/local/GPU → false).
 */
export function supportsAudioTags(family: VoiceProviderSupport | null, modelId: string): boolean {
  const m = String(modelId ?? '')
    .trim()
    .toLowerCase()
  if (!m) return false
  if (family === 'elevenlabs') return /^eleven_v[34](?:_|$)/.test(m)
  if (family === 'openrouter')
    return (
      /^elevenlabs\/eleven-v[34](?:[-.:]|$)/.test(m) ||
      /^fish-audio\/(?:drama-3|s2-pro|s2\.1-pro)(?:[-.:]|$)/.test(m)
    )
  return false
}

/**
 * A voz da chamada (settings de fala RESOLVIDAS no main — `api.baseUrl`/`providerKind`) interpreta
 * tags de voz? Só no backend de API (o Kokoro e os motores da GPU não interpretam).
 */
export function ttsSupportsAudioTags(tts: {
  backend: string
  api?: { model?: string; baseUrl?: string; providerKind?: string } | null
}): boolean {
  if (tts.backend !== 'api' || !tts.api) return false
  const family = voiceProviderSupport({
    baseUrl: tts.api.baseUrl ?? '',
    kind: tts.api.providerKind
  })
  return supportsAudioTags(family, tts.api.model ?? '')
}

// ---------------- vozes do Fish Audio (sem lista no OpenRouter) ----------------

/**
 * Id de voz do Fish Audio colado pelo usuário: o próprio id (32 hex — o `reference_id`) ou o link da
 * biblioteca (`https://fish.audio/m/<id>`, com ou sem `www.`, idioma — `/pt/m/<id>` — ou barra
 * final). null = não é um id do Fish Audio (o texto segue como id livre).
 */
export function fishVoiceIdFrom(input: string): string | null {
  const t = String(input ?? '').trim()
  if (/^[0-9a-f]{32}$/i.test(t)) return t.toLowerCase()
  const m =
    /^(?:https?:\/\/)?(?:www\.)?fish\.audio\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?m\/([0-9a-f]{32})(?:[/?#].*)?$/i.exec(
      t
    )
  return m ? m[1].toLowerCase() : null
}

/** O modelo (OpenRouter) é do Fish Audio (vozes = ids da biblioteca do Fish, sem lista)? */
export function isFishAudioModel(modelId: string): boolean {
  return /^fish-audio\//i.test(String(modelId ?? '').trim())
}
