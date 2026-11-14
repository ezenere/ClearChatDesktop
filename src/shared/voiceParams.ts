// Parâmetros dos modelos de voz REMOTOS (Configurações → Áudio → Modelo → "Parâmetros"): o que cada
// família de API aceita no corpo/consulta da request, com faixa, padrão e o "?" do efeito. Gravados
// em `ttsSettings.api.params` / `sttSettings.api.params`, POR FAMÍLIA (`{ elevenlabs: {…},
// openrouter: {…}, openai: {…} }` — trocar de modelo não perde os de outra família) e só os valores
// escolhidos (padrão = a chave sai). São preferências do usuário: sincronizam com o resto de
// `ttsSettings`/`sttSettings` (protocolo 1.5.0, §4.3.2), ao contrário dos parâmetros da GPU local.
//
// Fontes (conferidas em 2026-10-24):
// - ElevenLabs TTS: https://elevenlabs.io/docs/api-reference/text-to-speech/convert (`output_format`
//   — `pcm_44100` exige o plano Pro; `voice_settings` stability/similarity_boost/style/
//   use_speaker_boost/speed; `apply_text_normalization` auto|on|off — nos v2.5 o "on" é só do plano
//   Enterprise, changelog 2024-10-20) e o WebSocket multi-contexto
//   https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input
//   (`voice_settings` no 1º frame; speed 0,7–1,2; `style`/`use_speaker_boost` "V2+ models";
//   `auto_mode` — changelog 2024-10-27: gera sem o buffer/`chunk_length_schedule`, para frases
//   completas).
// - OpenRouter: https://openrouter.ai/docs/api/api-reference/tts/create-speech.md (`speed` — honrado
//   por alguns modelos, os outros ignoram ou recusam; `instructions` — OpenAI gpt-4o-mini-tts, Gemini
//   TTS e Fish Audio) e https://openrouter.ai/docs/guides/overview/multimodal/stt.md (`temperature`
//   0–1 normalizado; `prompt` "aceito mas ignorado" → não exposto). A listagem `/models` traz
//   `supported_parameters` vazio para os modelos de áudio, então a regra é por id de modelo. O `speed`
//   no ElevenLabs via OpenRouter foi medido (2026-10-24: 0,8 → 3,30 s; 1,2 → 2,14 s na mesma frase) e
//   no Fish Audio também (2026-11-14, `speed` no topo do body; `provider.options.fish-audio.prosody`
//   é ignorado): drama-3 4,69 s no padrão, 0,5 → 9,91 s, 0,7 → 7,69 s, 1,5 → 3,53 s, 2 → 2,57 s;
//   s2-pro e s2.1-pro 1,5 → 3,09 s. O s1 não foi medido (fica sem o controle).
// - OpenAI-compatível: `/audio/speech` `speed` (0,25–4) e `instructions` (gpt-4o-mini-tts);
//   `/audio/transcriptions` `temperature` (0–1) e `prompt` (dica de vocabulário — Groq/OpenAI).
import type { VoiceCapability, VoiceProviderSupport } from './voiceCatalog'

export type VoiceParamValue = number | boolean | string
export type VoiceParamValues = Record<string, VoiceParamValue>
/** `api.params` gravado: valores escolhidos por família de API. */
export type VoiceApiParams = Partial<Record<VoiceProviderSupport, VoiceParamValues>>

export interface VoiceParamOption {
  value: string
  label: string
  /** Nota curta ao lado da opção (ex.: "exige plano Pro"). */
  note?: string
}

export interface VoiceParamSpec {
  key: string
  label: string
  /** Efeito em linguagem simples (o "?" da UI). */
  help: string
  kind: 'number' | 'boolean' | 'select' | 'text'
  /**
   * Padrão. `null` = não enviar (vale o do provedor — na ElevenLabs, os ajustes salvos da voz na
   * conta); o controle mostra `neutral` enquanto não for mexido.
   */
  default: VoiceParamValue | null
  /** Valor exibido no controle quando o padrão é `null` (o padrão documentado da API). */
  neutral?: VoiceParamValue
  min?: number
  max?: number
  step?: number
  decimals?: number
  options?: VoiceParamOption[]
  /** Texto: tamanho máximo e exemplo. */
  maxLength?: number
  placeholder?: string
  /** O modelo aceita? (ausente = todos os da família). */
  models?: (model: string) => boolean
  /** Faixa própria do modelo (ex.: `speed` 0,7–1,2 no ElevenLabs via OpenRouter). */
  range?: (model: string) => { min: number; max: number }
  /** Só com o WebSocket da ElevenLabs em uso na chamada (`auto_mode`). */
  wsOnly?: boolean
  /** Rótulo do padrão `null` ("da voz (conta)", "do provedor"). */
  unsetLabel?: string
}

// ---------------- ElevenLabs ----------------

/** Formato de saída padrão da ElevenLabs (PCM16 mono 24 kHz — todos os planos). */
export const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = 'pcm_24000'

/**
 * Formatos PCM oferecidos (o player da chamada toca PCM na taxa do stream; mp3/opus ficam de fora —
 * a chamada e o alinhamento por sentença precisam de PCM cru).
 */
export const ELEVENLABS_OUTPUT_FORMATS: readonly VoiceParamOption[] = [
  { value: 'pcm_16000', label: 'PCM 16 kHz', note: 'menor, som de telefone' },
  { value: 'pcm_22050', label: 'PCM 22,05 kHz' },
  { value: 'pcm_24000', label: 'PCM 24 kHz', note: 'todos os planos' },
  { value: 'pcm_44100', label: 'PCM 44,1 kHz', note: 'exige plano Pro na ElevenLabs' },
  { value: 'pcm_48000', label: 'PCM 48 kHz', note: 'plano não documentado pela ElevenLabs' }
]

/** Taxa (Hz) de um `output_format` PCM (`pcm_44100` → 44100); inválido → 24000. */
export function pcmFormatRate(format: string | null | undefined): number {
  const m = /^pcm_(\d{4,6})$/.exec((format ?? '').trim())
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n >= 8000 && n <= 192_000 ? n : 24_000
}

/** "44,1 kHz" de um `output_format` PCM. */
export function pcmFormatLabel(format: string): string {
  const khz = pcmFormatRate(format) / 1000
  return `${String(khz).replace('.', ',')} kHz`
}

/** Modelos v1 da ElevenLabs (sem `style`/`use_speaker_boost` — "V2+ models"). */
const elevenV1 = (model: string): boolean => /(^|[/_-])v1$|_v1(_|$)|monolingual_v1/i.test(model)

const ELEVENLABS_TTS_PARAMS: VoiceParamSpec[] = [
  {
    key: 'output_format',
    label: 'Formato de saída',
    help: 'Qualidade do áudio que a ElevenLabs devolve (PCM cru, tocado na taxa escolhida). 24 kHz serve em todos os planos; 44,1 kHz exige o plano Pro — se a conta não permitir, a ElevenLabs recusa e o app avisa. Vale para a chamada, o “Testar voz” e os clipes (mudar regera os clipes).',
    kind: 'select',
    default: DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
    options: [...ELEVENLABS_OUTPUT_FORMATS]
  },
  {
    key: 'stability',
    label: 'Estabilidade',
    help: 'Quanto a voz varia entre frases (0–1). Mais baixo = mais emoção e variação (pode ficar instável); mais alto = mais constante (pode ficar monótona). Sem mexer, vale o ajuste salvo da voz na sua conta (padrão da API: 0,5).',
    kind: 'number',
    default: null,
    neutral: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    unsetLabel: 'da voz (conta)'
  },
  {
    key: 'similarity_boost',
    label: 'Semelhança',
    help: 'Quanto a síntese se prende à voz original (0–1). Alto demais pode reproduzir ruídos da gravação de referência. Sem mexer, vale o ajuste da voz na conta (padrão da API: 0,75).',
    kind: 'number',
    default: null,
    neutral: 0.75,
    min: 0,
    max: 1,
    step: 0.05,
    unsetLabel: 'da voz (conta)'
  },
  {
    key: 'style',
    label: 'Estilo',
    help: 'Exagera o estilo do locutor original (0–1). Diferente de 0 gasta mais processamento e pode aumentar a latência. Só nos modelos v2 em diante. Sem mexer, vale o da voz (padrão da API: 0).',
    kind: 'number',
    default: null,
    neutral: 0,
    min: 0,
    max: 1,
    step: 0.05,
    models: (m) => !elevenV1(m),
    unsetLabel: 'da voz (conta)'
  },
  {
    key: 'use_speaker_boost',
    label: 'Reforço do locutor',
    help: 'Aumenta a semelhança com o locutor original, com um pouco mais de latência. Só nos modelos v2 em diante. Sem mexer, vale o da voz (padrão da API: ligado).',
    kind: 'boolean',
    default: null,
    neutral: true,
    models: (m) => !elevenV1(m),
    unsetLabel: 'da voz (conta)'
  },
  {
    key: 'speed',
    label: 'Velocidade',
    help: 'Ritmo da fala (0,7–1,2; 1 = normal). Abaixo de 1 fala mais devagar, acima mais rápido. Sem mexer, vale o da voz.',
    kind: 'number',
    default: null,
    neutral: 1,
    min: 0.7,
    max: 1.2,
    step: 0.05,
    unsetLabel: 'da voz (conta)'
  },
  {
    key: 'apply_text_normalization',
    label: 'Normalização do texto',
    help: 'Se números, datas e abreviações são escritos por extenso antes de falar. Automático = a ElevenLabs decide; Ligado = sempre; Desligado = nunca (o texto é lido como veio). Nos modelos v2.5 (Flash/Turbo) o “Ligado” é só do plano Enterprise.',
    kind: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Automático' },
      { value: 'on', label: 'Ligado' },
      { value: 'off', label: 'Desligado' }
    ]
  },
  {
    key: 'auto_mode',
    label: 'Frases completas (auto_mode)',
    help: 'Só na chamada pelo WebSocket. Desligado (padrão): o texto vai palavra a palavra enquanto o modelo escreve e a ElevenLabs junta no buffer (chunk_length_schedule) — o 1º som sai mais cedo. Ligado: o app manda só frases inteiras e a ElevenLabs gera cada uma na hora, sem buffer (auto_mode=true) — prosódia de frase completa, um pouco mais de espera pela 1ª frase.',
    kind: 'boolean',
    default: false,
    wsOnly: true
  }
]

// ---------------- OpenRouter / OpenAI-compatível ----------------

/** Faixa do `speed` por modelo no OpenRouter (null = o modelo não tem controle de velocidade). */
function openRouterSpeedRange(model: string): { min: number; max: number } | null {
  const m = model.trim().toLowerCase()
  if (m.startsWith('elevenlabs/')) return { min: 0.7, max: 1.2 }
  if (m.startsWith('bytedance-seed/')) return { min: 0.5, max: 2 }
  if (m.startsWith('openai/')) return { min: 0.25, max: 4 }
  if (/^fish-audio\/(?:drama-3|s2-pro|s2\.1-pro)(?:[-.:]|$)/.test(m)) return { min: 0.5, max: 2 }
  return null
}

/** Modelos que seguem `instructions` (tom/ritmo/emoção). */
const followsInstructions = (model: string): boolean => {
  const m = model.trim().toLowerCase()
  return (
    /gpt-4o(-mini)?-tts/.test(m) ||
    (m.startsWith('google/') && m.includes('tts')) ||
    m.startsWith('fish-audio/')
  )
}

const INSTRUCTIONS: VoiceParamSpec = {
  key: 'instructions',
  label: 'Instruções de fala',
  help: 'Como falar: tom, ritmo, emoção (ex.: “fale de forma calorosa e tranquila”). Só alguns modelos seguem (OpenAI gpt-4o-mini-tts, Gemini TTS, Fish Audio); vazio = não envia.',
  kind: 'text',
  default: null,
  maxLength: 400,
  placeholder: 'ex.: fale de forma calorosa e tranquila, em português do Brasil',
  models: followsInstructions,
  unsetLabel: 'não enviar'
}

const OPENROUTER_TTS_PARAMS: VoiceParamSpec[] = [
  {
    key: 'speed',
    label: 'Velocidade',
    help: 'Ritmo da fala (1 = normal). Só nos modelos com controle de velocidade (ElevenLabs 0,7–1,2; Seed Audio 0,5–2; OpenAI 0,25–4; Fish Audio Drama 3/S2 0,5–2) — nos outros o OpenRouter ignora ou recusa, então o controle nem aparece. Sem mexer, não é enviado.',
    kind: 'number',
    default: null,
    neutral: 1,
    min: 0.25,
    max: 4,
    step: 0.05,
    models: (m) => !!openRouterSpeedRange(m),
    range: (m) => openRouterSpeedRange(m) ?? { min: 0.25, max: 4 },
    unsetLabel: 'do modelo'
  },
  INSTRUCTIONS
]

const OPENAI_TTS_PARAMS: VoiceParamSpec[] = [
  {
    key: 'speed',
    label: 'Velocidade',
    help: 'Ritmo da fala (0,25–4; 1 = normal), campo `speed` do /audio/speech. Servidores que não o aceitam ignoram. Sem mexer, não é enviado.',
    kind: 'number',
    default: null,
    neutral: 1,
    min: 0.25,
    max: 4,
    step: 0.05,
    unsetLabel: 'do modelo'
  },
  INSTRUCTIONS
]

const TEMPERATURE: VoiceParamSpec = {
  key: 'temperature',
  label: 'Temperatura',
  help: 'Aleatoriedade da transcrição (0–1). 0 = a mais provável (mais estável); mais alto pode ajudar quando o modelo trava ou repete. Sem mexer, não é enviada (vale o padrão do provedor).',
  kind: 'number',
  default: null,
  neutral: 0,
  min: 0,
  max: 1,
  step: 0.05,
  unsetLabel: 'do provedor'
}

const OPENAI_STT_PARAMS: VoiceParamSpec[] = [
  TEMPERATURE,
  {
    key: 'prompt',
    label: 'Dica de vocabulário',
    help: 'Texto curto com nomes e termos técnicos que você costuma falar (ex.: “ClearChat, OpenRouter, Kubernetes”) — campo `prompt` do /audio/transcriptions (Groq, OpenAI). Ajuda a grafar certo. Vazio = não envia.',
    kind: 'text',
    default: null,
    maxLength: 600,
    placeholder: 'ex.: ClearChat, OpenRouter, ElevenLabs, Kubernetes',
    unsetLabel: 'não enviar'
  }
]

/** Parâmetros de FALA por família (o modelo decide quais aparecem — `ttsApiParamSpecs`). */
export const TTS_API_PARAMS: Record<VoiceProviderSupport, VoiceParamSpec[]> = {
  elevenlabs: ELEVENLABS_TTS_PARAMS,
  openrouter: OPENROUTER_TTS_PARAMS,
  openai: OPENAI_TTS_PARAMS
}

/** Parâmetros de TRANSCRIÇÃO por família (ElevenLabs direto não transcreve). */
export const STT_API_PARAMS: Record<VoiceProviderSupport, VoiceParamSpec[]> = {
  elevenlabs: [],
  openrouter: [TEMPERATURE],
  openai: OPENAI_STT_PARAMS
}

const familySpecs = (cap: VoiceCapability, family: VoiceProviderSupport): VoiceParamSpec[] =>
  (cap === 'tts' ? TTS_API_PARAMS : STT_API_PARAMS)[family] ?? []

/**
 * Parâmetros que o modelo escolhido aceita (com a faixa do modelo aplicada). `ws` = a chamada usa o
 * WebSocket da ElevenLabs (senão o `auto_mode` some).
 */
export function apiParamSpecs(
  cap: VoiceCapability,
  family: VoiceProviderSupport | null,
  model: string,
  opts: { ws?: boolean } = {}
): VoiceParamSpec[] {
  if (!family) return []
  return familySpecs(cap, family)
    .filter((s) => (!s.models || s.models(model)) && (!s.wsOnly || !!opts.ws))
    .map((s) => (s.range ? { ...s, ...s.range(model) } : s))
}

// ---------------- normalização ----------------

/** Um valor válido do parâmetro (limitado à faixa/opções) ou undefined quando inválido. */
export function normalizeVoiceParamValue(
  spec: VoiceParamSpec,
  v: unknown
): VoiceParamValue | undefined {
  if (spec.kind === 'boolean') return typeof v === 'boolean' ? v : undefined
  if (spec.kind === 'select')
    return typeof v === 'string' && spec.options?.some((o) => o.value === v) ? v : undefined
  if (spec.kind === 'text') {
    if (typeof v !== 'string') return undefined
    const t = v.replace(/\r/g, '').trim()
    return t ? t.slice(0, spec.maxLength ?? 1000) : undefined
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return undefined
  const f = 10 ** (spec.decimals ?? 2)
  const lo = spec.min ?? -Infinity
  const hi = spec.max ?? Infinity
  return Math.round(Math.max(lo, Math.min(hi, n)) * f) / f
}

/** Valores de UMA família: só os válidos e diferentes do padrão. */
export function normalizeVoiceParamValues(
  cap: VoiceCapability,
  family: VoiceProviderSupport,
  raw: unknown
): VoiceParamValues {
  const out: VoiceParamValues = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const src = raw as Record<string, unknown>
  for (const spec of familySpecs(cap, family)) {
    const v = normalizeVoiceParamValue(spec, src[spec.key])
    if (v !== undefined && v !== spec.default) out[spec.key] = v
  }
  return out
}

const FAMILIES: readonly VoiceProviderSupport[] = ['elevenlabs', 'openrouter', 'openai']

/** `api.params` normalizado (famílias vazias saem; tudo vazio → undefined = a chave sai). */
export function normalizeVoiceApiParams(
  cap: VoiceCapability,
  raw: unknown
): VoiceApiParams | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const src = raw as Record<string, unknown>
  const out: VoiceApiParams = {}
  for (const f of FAMILIES) {
    const v = normalizeVoiceParamValues(cap, f, src[f])
    if (Object.keys(v).length) out[f] = v
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * O que ENVIAR para o modelo: só os parâmetros escolhidos que o modelo aceita, na faixa dele
 * (`apiParamSpecs`). Os de padrão não-nulo entram só quando diferentes do padrão.
 */
export function apiParamsToSend(
  cap: VoiceCapability,
  family: VoiceProviderSupport | null,
  model: string,
  params: VoiceApiParams | null | undefined,
  opts: { ws?: boolean } = {}
): VoiceParamValues {
  const out: VoiceParamValues = {}
  if (!family) return out
  const saved = params?.[family]
  if (!saved) return out
  for (const spec of apiParamSpecs(cap, family, model, opts)) {
    const v = normalizeVoiceParamValue(spec, saved[spec.key])
    if (v !== undefined && v !== spec.default) out[spec.key] = v
  }
  return out
}

/** `api.params` com `key` = `value` na família (null = volta ao padrão: a chave sai). */
export function setVoiceApiParam(
  cap: VoiceCapability,
  family: VoiceProviderSupport,
  params: VoiceApiParams | null | undefined,
  key: string,
  value: VoiceParamValue | null
): VoiceApiParams | undefined {
  const cur = { ...(params?.[family] ?? {}) } as Record<string, unknown>
  if (value === null) delete cur[key]
  else cur[key] = value
  return normalizeVoiceApiParams(cap, { ...(params ?? {}), [family]: cur })
}

/** `api.params` sem a família (o "Restaurar padrão"). */
export function clearVoiceApiParams(
  cap: VoiceCapability,
  family: VoiceProviderSupport,
  params: VoiceApiParams | null | undefined
): VoiceApiParams | undefined {
  const rest = { ...(params ?? {}) }
  delete rest[family]
  return normalizeVoiceApiParams(cap, rest)
}

/** `output_format` efetivo da ElevenLabs (o salvo ou `pcm_24000`). */
export function elevenLabsOutputFormat(params: VoiceApiParams | null | undefined): string {
  const v = params?.elevenlabs?.output_format
  return typeof v === 'string' && ELEVENLABS_OUTPUT_FORMATS.some((o) => o.value === v)
    ? v
    : DEFAULT_ELEVENLABS_OUTPUT_FORMAT
}
