// Áudio/voz — contratos da feature: configuração do DITADO (100% global, settings `audioInput`,
// `sttSettings`, `ttsSettings`) e da CHAMADA DE VOZ (por persona/chat em `ChatConfig.voice`, com os
// padrões globais herdados na setting `voiceCallDefaults`). Tudo JSON-serializável (nunca
// `undefined` nos writers); sincronizam desde o protocolo 1.5.0, menos as partes do dispositivo
// (microfone, `installed`, modo/bloco da GPU — `src/main/sync/records.ts`, SPEC → "Áudio no
// sync"). Ver SPEC.md → "Áudio".
import { DEFAULT_ACTIVATION_DB, normalizeActivationDb } from './speechGate'
import { AUDIO_TAGS_PROMPT_MAX, DEFAULT_AUDIO_TAGS_PROMPT } from './audioTags'
import {
  normalizeToolList,
  type Chat,
  type ChatConfig,
  type ChatParams,
  type ToolName
} from './types'
import { planVoiceReasoning, type VoiceReasoningRules } from './voiceCallParams'
import {
  DEFAULT_TTS_GPU,
  GPU_STT_ENGINE_ID,
  isGpuTtsEngineId,
  normalizeGpuParamOverrides,
  normalizeOmniSteps,
  normalizeTtsGpuParams,
  type SttGpuConfig,
  type TtsGpuConfig
} from './gpuVoice'
import { normalizeVoiceApiParams, type VoiceApiParams } from './voiceParams'
// contrato do modo GPU também a partir daqui (as settings `ttsSettings.gpu`/`sttSettings.gpu`)
export {
  DEFAULT_STT_GPU,
  DEFAULT_TTS_GPU,
  OMNIVOICE_DEFAULT_STEPS,
  type SttGpuConfig,
  type TtsGpuConfig
} from './gpuVoice'

// ---------------- settings keys (tabela `settings`, JSON; ver SPEC → Banco) ----------------

/** Ditado: microfone, push-to-talk, silêncio e idioma (100% global). */
export const AUDIO_INPUT_SETTING = 'audioInput'
/** Transcrição de voz em texto (STT): modo, endpoint de API e motor local. */
export const STT_SETTINGS_SETTING = 'sttSettings'
/** Síntese de fala (TTS): backend, endpoint de API e motor local. */
export const TTS_SETTINGS_SETTING = 'ttsSettings'
/** Padrões globais da chamada de voz, herdados quando `ChatConfig.voice` tem null. */
export const VOICE_CALL_DEFAULTS_SETTING = 'voiceCallDefaults'

// ---------------- ditado: entrada de áudio (settings `audioInput`) ----------------

export interface AudioInputSettings {
  /** Microfone (deviceId do sistema); null = padrão do sistema. Local do dispositivo (não sincroniza). */
  deviceId: string | null
  /**
   * Nível de ativação do microfone (dBFS de RMS; padrão `DEFAULT_ACTIVATION_DB` = −45; faixa
   * −70…−20): abaixo dele nada é fala — o portão de ativação (`@shared/speechGate`) não manda o
   * trecho ao STT (ditado e chamada). Depende do microfone/sala: **local do dispositivo** como o
   * `deviceId` (nunca sai no registro do sync; o recebido não o sobrescreve).
   */
  activationDb: number
  /** Push-to-talk: a captura só corre enquanto a tecla (ou o botão) estiver pressionada (padrão true). */
  pttEnabled: boolean
  /** Tecla do push-to-talk (ex.: 'Ctrl+Shift+Space'); null = sem tecla (só clique/segurar no botão). */
  pttKey: string | null
  /** Encerra a captura sozinha quando o usuário para de falar (padrão true). */
  silenceStopEnabled: boolean
  /** Milissegundos de silêncio que encerram a captura (padrão 5000; 0 = ignora o limite). */
  silenceStopMs: number
  /** Idioma do ditado (seletor multilingue, ex.: 'pt-BR'; padrão 'pt-BR'). */
  language: string
}

export const DEFAULT_AUDIO_INPUT: AudioInputSettings = {
  deviceId: null,
  activationDb: DEFAULT_ACTIVATION_DB,
  pttEnabled: true,
  pttKey: null,
  silenceStopEnabled: true,
  silenceStopMs: 5000,
  language: 'pt-BR'
}

// ---------------- transcrição (settings `sttSettings`) ----------------

/**
 * Onde transcrever: API remota, motor local, híbrido (API com fallback local) ou `gpu` — o
 * whisper-large-v3-turbo no servidor local da GPU ("Modo avançado (GPU local)", `sttSettings.gpu`).
 */
export type SttMode = 'api' | 'local' | 'hybrid' | 'gpu'
export const STT_MODES: readonly SttMode[] = ['api', 'local', 'hybrid', 'gpu']

/** Motor de transcrição local. */
export type SttLocalEngine = 'whisper.cpp' | 'vosk' | 'nemotron'
export const STT_LOCAL_ENGINES: readonly SttLocalEngine[] = ['whisper.cpp', 'vosk', 'nemotron']

/**
 * Endpoint de transcrição (API), no formato OpenAI `/audio/transcriptions`. GRAVADO só com o
 * provedor e o modelo: endereço e chave vêm SEMPRE do provedor cadastrado em Configurações →
 * Provedores (um servidor local OpenAI-compatível em localhost, sem chave, também é um provedor).
 */
export interface SttEndpointConfig {
  /** Provedor cadastrado (id de `providers`); null = nenhum escolhido (a API não transcreve). */
  providerId: string | null
  /** Modelo de transcrição (padrão: 'whisper-large-v3-turbo'). */
  model: string
  /**
   * Endereço/chave do provedor, preenchidos SÓ pelo main ao resolver o `providerId`
   * (`getVoiceSettings`) ou o servidor da GPU — nunca gravados nem enviados ao renderer.
   */
  baseUrl?: string
  apiKey?: string
  /** Tipo do provedor salvo, preenchido SÓ pelo main (decide os `params` da família). */
  providerKind?: string
  /**
   * Parâmetros do modelo por família de API (`temperature`, `prompt` — `@shared/voiceParams`): só
   * os escolhidos (aditivo; sincroniza com o resto de `sttSettings` — protocolo 1.5.0, §4.3.2).
   */
  params?: VoiceApiParams
}

export interface SttLocalConfig {
  /** Motor local (padrão ao instalar: 'whisper.cpp'). */
  engine: SttLocalEngine
  /** Modelo do motor (livre; vazio = o padrão do motor). */
  model: string
  /** O app detectou o motor instalado. */
  installed: boolean
}

export interface SttSettings {
  /** Onde transcrever (padrão 'api'). */
  mode: SttMode
  /** Provedor + modelo de API (padrão: nenhum provedor escolhido, `whisper-large-v3-turbo`). */
  api: SttEndpointConfig
  /** Motor local; null = nenhum instalado. */
  local: SttLocalConfig | null
  /** Transcrição ao vivo melhor-esforço enquanto o usuário fala (padrão true). */
  livePartials: boolean
  /**
   * Ditado: quando a última parcial já cobre a fala inteira (uma transcrição só do trecho final,
   * sem áudio falado depois dela), ela vira a final na hora — sem a request final (padrão true;
   * desligado = a final sempre transcreve o trecho de novo, um pouco mais preciso). A chamada de
   * voz sempre reaproveita (latência).
   */
  reusePartialFinal?: boolean
  /**
   * Modo `gpu`: motor do servidor local da GPU (aditivo — só gravado com o modo `gpu` ou quando
   * escolhido). Local do dispositivo: NUNCA sincroniza (SPEC → "Modo avançado (GPU local)").
   */
  gpu?: SttGpuConfig
}

export const DEFAULT_STT_API: SttEndpointConfig = {
  providerId: null,
  model: 'whisper-large-v3-turbo'
}

/**
 * Teto de tamanho do modelo local (whisper.cpp) para as parciais ao vivo por janelas: até o
 * `ggml-base` (~148 MB) cada janela volta em centenas de ms; do `small` para cima cada parcial custa
 * segundos de CPU e atrasaria a final — o runtime desliga as parciais e a UI avisa ("parciais
 * desligadas para este modelo"). SPEC → "Áudio → Runtime local de STT".
 */
export const STT_LOCAL_PARTIAL_MAX_MODEL_BYTES = 160_000_000

/** Aviso (pt-BR) de parciais locais desligadas para o modelo escolhido (sessão → UI). */
export const STT_LOCAL_PARTIALS_OFF_NOTICE =
  'Parciais ao vivo desligadas para este modelo local (grande demais para transcrever enquanto você fala) — o texto aparece nas pausas e quando você parar. Para ver o texto ao vivo, use o ggml-base ou o ggml-tiny.'

export const DEFAULT_STT_SETTINGS: SttSettings = {
  mode: 'api',
  api: { ...DEFAULT_STT_API },
  local: null,
  livePartials: true,
  reusePartialFinal: true
}

// ---------------- fala (settings `ttsSettings`) ----------------

/** Motor de síntese local. */
export type TtsLocalEngine = 'kokoro' | 'chatterbox'
export const TTS_LOCAL_ENGINES: readonly TtsLocalEngine[] = ['kokoro', 'chatterbox']

/**
 * Endpoint de síntese (API). GRAVADO só com o provedor, o modelo, a voz e as opções: endereço e
 * chave vêm SEMPRE do provedor cadastrado em Configurações → Provedores.
 */
export interface TtsEndpointConfig {
  /** Provedor cadastrado (id de `providers`); null = nenhum escolhido (a API não sintetiza). */
  providerId: string | null
  /** Modelo de síntese (padrão: vazio — não configurado). */
  model: string
  /** Voz pedida à API; null = a voz padrão da API. */
  voice: string | null
  /**
   * Endereço/chave do provedor, preenchidos SÓ pelo main ao resolver o `providerId`
   * (`getVoiceSettings`) ou o servidor da GPU — nunca gravados nem enviados ao renderer.
   */
  baseUrl?: string
  apiKey?: string
  /**
   * Tipo do provedor salvo (`providerId`), preenchido SÓ pelo main ao resolver o endpoint
   * (`getVoiceSettings`) — nunca gravado nem enviado ao renderer. `'elevenlabs'` = ElevenLabs
   * direta (REST `/v1/text-to-speech` + WebSocket na chamada — `voice/elevenlabs*.ts`).
   */
  providerKind?: string
  /**
   * ElevenLabs direta: a chamada usa o WebSocket multi-contexto (texto em streaming) quando o
   * modelo aceita. Ausente = ligado (padrão); `false` = força HTTP por frase. Gravado só quando
   * `false` (aditivo; sincroniza com o resto de `ttsSettings` — protocolo 1.5.0).
   */
  elevenLabsWs?: boolean
  /**
   * Parâmetros do modelo por família de API (`@shared/voiceParams` — ElevenLabs: formato de saída,
   * `voice_settings`, normalização, `auto_mode`; OpenRouter/OpenAI: `speed`, `instructions`): só os
   * escolhidos (aditivo; sincroniza com o resto de `ttsSettings` — protocolo 1.5.0, §4.3.2).
   */
  params?: VoiceApiParams
  /**
   * Campos extras do corpo JSON de `/audio/speech`, preenchidos SÓ pelo main (o servidor da GPU
   * recebe `{ params }` — os parâmetros do motor). Nunca gravado (o normalizador descarta).
   */
  extraBody?: Record<string, unknown>
}

/** Modelos da ElevenLabs que o WebSocket `stream-input` não aceita (v3/v4 → HTTP por frase). */
export function elevenLabsWsSupportsModel(modelId: string): boolean {
  return !/^eleven_v[34]/i.test(modelId.trim())
}

/** Nome curto do modelo da ElevenLabs para os avisos ("eleven_v4_turbo" → "v4 Turbo"). */
const elevenModelShort = (id: string): string => {
  const m = /^eleven_(v\d+)(?:_(\w+))?/i.exec(id.trim())
  if (!m) return id
  const rest = (m[2] ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return [m[1].toLowerCase(), rest].filter(Boolean).join(' ')
}

/** Como a fala da CHAMADA chega do provedor (indicador da aba Áudio → Fala). */
export interface TtsCallTransport {
  /** true = WebSocket multi-contexto (texto em streaming); false = HTTP por frase. */
  ws: boolean
  /** Por que é HTTP (pt-BR, minúsculo); null quando é WebSocket. */
  reason: string | null
  /** O interruptor "Streaming por WebSocket" se aplica (ElevenLabs direta + modelo que aceita). */
  toggle: boolean
}

/**
 * Transporte da fala na chamada para o backend de API — espelho PURO da decisão do main
 * (`elevenLabsCallOptions`): WebSocket só na ElevenLabs direta, com modelo que aceita e o
 * interruptor ligado; o resto é HTTP por frase. `family` = família do provedor escolhido.
 */
export function ttsCallTransport(
  api: Pick<TtsEndpointConfig, 'model' | 'elevenLabsWs'>,
  family: 'elevenlabs' | 'openrouter' | 'openai' | null
): TtsCallTransport {
  if (family !== 'elevenlabs')
    return {
      ws: false,
      reason:
        family === 'openrouter'
          ? 'o OpenRouter não tem WebSocket de fala'
          : 'só a ElevenLabs direta tem WebSocket de fala',
      toggle: false
    }
  if (!elevenLabsWsSupportsModel(api.model))
    return {
      ws: false,
      reason: `o ${elevenModelShort(api.model)} não suporta WebSocket`,
      toggle: false
    }
  if (api.elevenLabsWs === false) return { ws: false, reason: 'desligado por você', toggle: true }
  return { ws: true, reason: null, toggle: true }
}

export interface TtsLocalConfig {
  /** Motor local (padrão ao instalar: 'kokoro'). */
  engine: TtsLocalEngine
  /** Voz do motor (vazia/ausente → `DEFAULT_TTS_LOCAL.voice`). */
  voice: string
  /** O app detectou o motor instalado. */
  installed: boolean
}

export interface TtsSettings {
  /**
   * Onde sintetizar (padrão 'local' — Kokoro). `gpu` = servidor local da GPU ("Modo avançado (GPU
   * local)" — motor/voz em `gpu`; o main resolve URL/token, que nunca vão ao renderer).
   */
  backend: 'api' | 'local' | 'gpu'
  /** Provedor + modelo + voz de API (padrão: não configurado). */
  api: TtsEndpointConfig
  /** Motor local (padrão: Kokoro não instalado); null = o usuário limpou explicitamente. */
  local: TtsLocalConfig | null
  /**
   * Backend `gpu`: motor/voz/passos (aditivo — só gravado com o backend `gpu` ou quando escolhido).
   * Local do dispositivo: NUNCA sincroniza (SPEC → "Modo avançado (GPU local)").
   */
  gpu?: TtsGpuConfig
}

export const DEFAULT_TTS_API: TtsEndpointConfig = {
  providerId: null,
  model: '',
  voice: null
}

/**
 * Motor local padrão: Kokoro, ainda não instalado (`installed: false` → a UI oferece o download).
 * Voz `'pf_dora'` CONFIRMADA (fatia de TTS): id da voz pt-BR feminina do Kokoro v1.0, conferido em
 * `hexgrad/Kokoro-82M` VOICES.md (as demais pt-BR são `pm_alex`/`pm_santa`).
 */
export const DEFAULT_TTS_LOCAL: TtsLocalConfig = {
  engine: 'kokoro',
  voice: 'pf_dora',
  installed: false
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  backend: 'local',
  api: { ...DEFAULT_TTS_API },
  local: { ...DEFAULT_TTS_LOCAL }
}

// ---------------- chamada de voz (persona/chat — `ChatConfig.voice`) ----------------

/** Falas preenchidoras ("ãh", "só um minutinho…") enquanto o modelo pensa. */
export interface VoiceFillers {
  /** Liga as falas preenchidoras (padrão true). */
  enabled: boolean
  /** Prompt das falas preenchidoras; null = o padrão. */
  prompt: string | null
}

/**
 * Contexto do turno do usuário que escolhe o preâmbulo (filler) — `classifyFillerContext` em
 * `@shared/voicePolicy`: pergunta, comando/tarefa com tool, correção/interrupção ("não", "peraí"),
 * pedido longo/complexo ou genérico.
 */
export type FillerContext = 'question' | 'command' | 'correction' | 'complex' | 'generic'
export const FILLER_CONTEXTS: readonly FillerContext[] = [
  'question',
  'command',
  'correction',
  'complex',
  'generic'
]

/** Uma frase do pool de preâmbulos (vira o clipe `FILLER_<n>` — n = posição 1-based no pool). */
export interface FillerPhrase {
  /** Texto falado (pt-BR por extenso — nada de "Hmm": o TTS soletra/anglicaniza). */
  text: string
  /** Contextos em que a frase cabe (lista vazia = `generic`). */
  contexts: FillerContext[]
}

/** Máximo de frases no pool de preâmbulos (= máximo de clipes `FILLER_<n>`). */
export const FILLER_POOL_MAX = 16

/**
 * Pool padrão de preâmbulos (~0,6–1,4 s cada, pronunciáveis por Kokoro e ElevenLabs — o benchmark
 * mostrou que "Hum, deixa eu ver." funciona nos dois e "Hum…"/"Hmm" soltos não). A chamada toca UM
 * logo depois do turno (ponte até a 1ª frase da resposta), escolhido pelo contexto, sem repetir
 * nenhum dos últimos `FILLER_RECENT_WINDOW` usados.
 */
export const DEFAULT_FILLER_POOL: readonly FillerPhrase[] = [
  { text: 'Hum, deixa eu ver aqui.', contexts: ['question', 'generic'] },
  { text: 'Boa pergunta, deixa eu pensar.', contexts: ['question'] },
  { text: 'Hum, deixa eu ver.', contexts: ['question', 'generic'] },
  { text: 'Beleza, só um minutinho.', contexts: ['command'] },
  { text: 'Tá, deixa eu ver isso.', contexts: ['command', 'generic'] },
  { text: 'Certo, já vejo isso.', contexts: ['command'] },
  { text: 'Ah, tá, peraí.', contexts: ['correction'] },
  { text: 'Entendi, deixa eu rever.', contexts: ['correction'] },
  { text: 'Ah, entendi, um instante.', contexts: ['correction'] },
  { text: 'Deixa eu ver isso com calma.', contexts: ['complex'] },
  { text: 'Então, deixa eu ver.', contexts: ['complex', 'generic'] },
  { text: 'Um instante.', contexts: ['command', 'generic'] }
]

/** Padrões GLOBAIS dos fillers (`voiceCallDefaults.fillers`): o pool e o tempo valem para todos os chats. */
export interface VoiceFillerDefaults extends VoiceFillers {
  /**
   * Espera entre o turno enviado e o preâmbulo (ms; padrão 250, 0 = já): se a 1ª frase da resposta
   * ficar pronta antes disso, o preâmbulo nem sai.
   */
  delayMs: number
  /** Pool de preâmbulos; null = `DEFAULT_FILLER_POOL` (mudou → os clipes são regerados). */
  pool: FillerPhrase[] | null
}

/** Espera padrão do preâmbulo depois do turno enviado (ms). */
export const DEFAULT_FILLER_DELAY_MS = 250

/**
 * Categoria da ferramenta para a frase falada quando o assistente usa uma tool na chamada
 * (`toolPhraseCategory` em `@shared/voicePolicy`): pesquisa na web, arquivos, terminal/processos,
 * memória, subagentes/outros chats, informações (modelos/chats/histórico/skills), localização (tools
 * do celular — `get_location`/`nearby_places`) e genérica.
 */
export type ToolPhraseCategory =
  'web' | 'files' | 'shell' | 'memory' | 'agents' | 'info' | 'location' | 'generic'
export const TOOL_PHRASE_CATEGORIES: readonly ToolPhraseCategory[] = [
  'web',
  'files',
  'shell',
  'memory',
  'agents',
  'info',
  'location',
  'generic'
]

/** Uma frase de ferramenta do pool (vira o clipe `TOOL_<n>` — n = posição 1-based no pool). */
export interface ToolPhrase {
  /** Texto falado (pt-BR por extenso). */
  text: string
  /** Categorias em que a frase cabe (lista vazia = `generic`). */
  categories: ToolPhraseCategory[]
}

/** Máximo de frases no pool de frases de ferramenta (= máximo de clipes `TOOL_<n>`). */
export const TOOL_PHRASE_POOL_MAX = 40

/**
 * Pool padrão das frases de ferramenta (curtas, ~1 s; 3–4 por categoria). A chamada fala UMA por
 * turno, na 1ª tool que começa — sem repetir as últimas usadas.
 */
export const DEFAULT_TOOL_PHRASE_POOL: readonly ToolPhrase[] = [
  { text: 'Vou pesquisar isso.', categories: ['web'] },
  { text: 'Deixa eu procurar na internet.', categories: ['web'] },
  { text: 'Vou dar uma olhada na web.', categories: ['web'] },
  { text: 'Um instante, vou pesquisar.', categories: ['web'] },
  { text: 'Deixa eu dar uma olhada nos arquivos.', categories: ['files'] },
  { text: 'Vou olhar os arquivos.', categories: ['files'] },
  { text: 'Deixa eu conferir no projeto.', categories: ['files'] },
  { text: 'Vou abrir isso aqui.', categories: ['files'] },
  { text: 'Vou rodar isso aqui.', categories: ['shell'] },
  { text: 'Deixa eu executar isso.', categories: ['shell'] },
  { text: 'Vou rodar um comando.', categories: ['shell'] },
  { text: 'Deixa eu ver o que eu tenho anotado.', categories: ['memory'] },
  { text: 'Vou consultar a memória.', categories: ['memory'] },
  { text: 'Um instante, vou checar minhas notas.', categories: ['memory'] },
  { text: 'Vou pedir ajuda para um assistente.', categories: ['agents'] },
  { text: 'Deixa eu passar isso adiante.', categories: ['agents'] },
  { text: 'Vou delegar essa parte.', categories: ['agents'] },
  { text: 'Deixa eu conferir isso.', categories: ['info'] },
  { text: 'Vou checar rapidinho.', categories: ['info'] },
  { text: 'Deixa eu ver as informações.', categories: ['info'] },
  { text: 'Deixa eu ver onde você está.', categories: ['location'] },
  { text: 'Vou procurar lugares por perto.', categories: ['location'] },
  { text: 'Vou checar a localização.', categories: ['location'] },
  { text: 'Deixa eu ver isso.', categories: ['generic'] },
  { text: 'Um instante, vou cuidar disso.', categories: ['generic'] },
  { text: 'Vou fazer isso agora.', categories: ['generic'] }
]

/**
 * Frases de ferramenta da chamada (`voiceCallDefaults.toolPhrases`, global; aditivo): quando o
 * assistente começa a 1ª tool do turno, a chamada fala uma frase curta da categoria dela ("Vou
 * pesquisar isso.") — clipe pré-gerado `TOOL_<n>` (síntese ao vivo se o clipe não está pronto). Por
 * persona/chat só o liga/desliga (`VoiceCallConfig.toolPhrases`, ★ herda).
 */
export interface VoiceToolPhrases {
  /** Liga as frases de ferramenta (padrão true). */
  enabled: boolean
  /** Pool; null = `DEFAULT_TOOL_PHRASE_POOL` (mudou → os clipes são regerados). */
  pool: ToolPhrase[] | null
}

export const DEFAULT_TOOL_PHRASES: VoiceToolPhrases = { enabled: true, pool: null }

/**
 * Frases de demora da chamada (`voiceCallDefaults.delayPhrases`, global): sintetizadas AO VIVO pela
 * mesma voz da chamada (sem clipes pré-gerados) quando a resposta demora. Duas situações:
 * - **manter viva** (`keepAlivePool`): depois do preâmbulo, sem áudio da resposta por
 *   `keepAliveAfterMs` de silêncio → "Só mais um instante…" (no máx. 2 por turno, 15 s entre o fim
 *   de uma e o início da outra);
 * - **desculpa** (`apologyPool`): a 1ª frase da resposta ficou pronta depois de `apologyAfterMs`
 *   desde o turno → "Desculpe a demora, vamos lá." antes dela (sintetizada em paralelo; só toca se
 *   ficou pronta antes da resposta — nunca atrasa a síntese da resposta).
 * Espaçamento global: ≥ 10 s entre o FIM de qualquer frase curta (preâmbulo/"manter viva"/desculpa)
 * e o início da próxima "manter viva" ou desculpa (`DELAY_MIN_GAP_MS`; a desculpa que violaria é
 * pulada). Não entram no histórico (como os preâmbulos); os caracteres contam no custo da voz.
 */
export interface VoiceDelayPhrases {
  /** Liga as frases de demora (padrão true). */
  enabled: boolean
  /** Silêncio (ms) esperando a resposta antes de uma frase "manter viva" (padrão 8000). */
  keepAliveAfterMs: number
  /** Espera (ms) desde o turno acima da qual a resposta ganha uma desculpa antes (padrão 15000). */
  apologyAfterMs: number
  /** Frases "manter viva"; null = `DEFAULT_KEEPALIVE_POOL`. */
  keepAlivePool: string[] | null
  /** Frases de desculpa; null = `DEFAULT_APOLOGY_POOL`. */
  apologyPool: string[] | null
}

/** Frases "manter viva" padrão (curtas, ~1 s — enquanto a resposta não sai). */
export const DEFAULT_KEEPALIVE_POOL: readonly string[] = [
  'Só mais um instante…',
  'Tô quase lá…',
  'Deixa eu terminar de ver isso…',
  'Já te respondo…'
]

/** Frases de desculpa padrão (antes da 1ª frase de uma resposta que demorou). */
export const DEFAULT_APOLOGY_POOL: readonly string[] = [
  'Desculpe a demora, vamos lá.',
  'Pronto, desculpa a espera.',
  'Foi mal a demora, olha só…'
]

/** Máximo de frases por pool de demora. */
export const DELAY_PHRASE_POOL_MAX = 12
/** Tamanho máximo de uma frase de demora (chars). */
export const DELAY_PHRASE_MAX_CHARS = 80

export const DEFAULT_DELAY_PHRASES: VoiceDelayPhrases = {
  enabled: true,
  keepAliveAfterMs: 8000,
  apologyAfterMs: 15_000,
  keepAlivePool: null,
  apologyPool: null
}

/**
 * Padrões ANTIGOS dos tempos das frases de demora (até 2026-11-12): gravados explicitamente nas
 * instalações existentes (`voiceCallDefaults.delayPhrases`, sincronizado). O normalizador migra o
 * valor EXATAMENTE igual ao padrão antigo para o novo (`DEFAULT_DELAY_PHRASES`); outros valores
 * escolhidos pelo usuário ficam como estão.
 */
export const LEGACY_DELAY_PHRASE_DEFAULTS = {
  keepAliveAfterMs: 3000,
  apologyAfterMs: 5000
} as const

/** Limites dos tempos das frases de demora (ms) — fora deles o valor é preso no limite. */
export const DELAY_PHRASE_MS_RANGE = { min: 1000, max: 60_000 } as const

/** Modelo próprio da chamada de voz (null = herda o modelo do chat). */
export interface VoiceCallModelConfig {
  /** Provedor (id de `providers`). */
  providerId: string
  /** Modelo de chat usado na conversa por voz. */
  model: string
  /** Params do modelo (mesma semântica de `ChatParams`; chaves desconhecidas são preservadas). */
  params: ChatParams
}

/** Tools da chamada de voz (null em cada campo = igual ao chat). */
export interface VoiceCallToolsConfig {
  /** Tools liberadas; null = as do chat (alias antigos mapeados, sem duplicatas). */
  enabledTools: ToolName[] | null
  /** Teto de caracteres do resultado de cada tool; null = o do chat. */
  maxToolOutputChars: number | null
}

/**
 * Configuração da chamada de voz por persona/chat (`ChatConfig.voice`). Cada campo `null` herda o
 * padrão: `enabled`/`fillers` de `voiceCallDefaults` (global); `model`/`tools` do chat. Ausente =
 * tudo null (= segue os padrões). Ver SPEC → "Áudio → Chamada de voz". O campo `interjections` de
 * registros antigos é legado (protocolo §4.3.6): o normalizador o descarta e nada o grava.
 */
export interface VoiceCallConfig {
  /** Liga a chamada de voz; null = segue o padrão global (`voiceCallDefaults.enabled`). */
  enabled: boolean | null
  /** Modelo próprio da chamada de voz; null = herda o modelo do chat. */
  model: VoiceCallModelConfig | null
  /** Tools próprias da chamada de voz; null = igual ao chat. */
  tools: VoiceCallToolsConfig | null
  /** Prompt do modo voz (fala, estilo…); null = sem prompt próprio (o modo diz como compõe). */
  voicePrompt: string | null
  /**
   * Como o prompt do modo voz compõe com o system prompt do chat/persona nos turnos da chamada;
   * null/ausente = herda (persona → `'append'`). Ver `VoiceCallPromptMode`.
   */
  promptMode?: VoiceCallPromptMode | null
  /** Falas preenchidoras; null = segue o padrão global. */
  fillers: VoiceFillers | null
  /**
   * "O agente pode encerrar a chamada" (tool `end_call`); null/ausente = segue o padrão global
   * (`voiceCallDefaults.endCall`, ligado). Aditivo: só gravado quando escolhido.
   */
  endCall?: boolean | null
  /**
   * Tags de voz ("[laughs]", "[sussurra]"…): a instrução `audioTagsPrompt` entra no prompt da
   * chamada — só quando a voz da chamada as interpreta (`supportsAudioTags`). null/ausente = herda
   * (persona → global `voiceCallDefaults.audioTags`, desligado). Opt-in explícito; aditivo.
   */
  audioTags?: boolean | null
  /**
   * Frases de ferramenta ("Vou pesquisar isso." na 1ª tool do turno); null/ausente = herda
   * (persona → global `voiceCallDefaults.toolPhrases.enabled`, ligado). Aditivo.
   */
  toolPhrases?: boolean | null
  /** Texto da instrução das tags; null/ausente = herda (persona → global → `DEFAULT_AUDIO_TAGS_PROMPT`). */
  audioTagsPrompt?: string | null
}

/**
 * Composição do prompt nos turnos de voz (o prompt-base global entra em `append` e `replace`,
 * salvo desligado em Configurações → Áudio; nunca em `none`):
 * - `append` (complementar, padrão): system prompt do chat + prompt-base + prompt do modo voz;
 * - `replace` (substituto): prompt-base + prompt do modo voz NO LUGAR do system prompt do chat
 *   (prompt do modo voz vazio → nada a pôr no lugar: vale como `append`);
 * - `none` (nenhum): só o system prompt do chat — sem prompt-base nem prompt do modo voz.
 */
export type VoiceCallPromptMode = 'append' | 'replace' | 'none'
export const VOICE_CALL_PROMPT_MODES: readonly VoiceCallPromptMode[] = ['append', 'replace', 'none']

/**
 * Padrões GLOBAIS da chamada de voz (setting `voiceCallDefaults`). Por padrão a chamada está
 * **disponível** (ligada aqui, com os preâmbulos): dá para desligar globalmente nestes padrões ou
 * por chat/persona em `VoiceCallConfig.enabled: false`. O `interjections` de registros antigos é
 * legado (protocolo §4.3.6): o normalizador o descarta e nada o grava.
 */
export interface VoiceCallDefaults {
  /** Chamada de voz ligada por padrão (padrão true). */
  enabled: boolean
  /** Falas preenchidoras padrão (+ pool de preâmbulos e espera — globais). */
  fillers: VoiceFillerDefaults
  /** Turnos da chamada (silêncio que encerra a fala do usuário; fim de turno adaptativo). */
  turn: VoiceCallTurnConfig
  /**
   * Modelo da chamada padrão (provider/model/params) para chats/personas sem modelo próprio na
   * chamada; null = o modelo do próprio chat. O `max_tokens` dos turnos de voz só existe aqui (nos
   * params), como qualquer parâmetro do modelo — a chamada não impõe teto próprio.
   */
  model: VoiceCallModelConfig | null
  /** Prompt-base do modo voz somado ao system prompt (ligado por padrão). */
  basePromptEnabled: boolean
  /** Texto do prompt-base; null = `DEFAULT_VOICE_BASE_PROMPT`. */
  basePrompt: string | null
  /** "O agente pode encerrar a chamada" (tool `end_call` nos turnos da chamada; padrão true). */
  endCall: boolean
  /**
   * Frases de demora sintetizadas ao vivo ("Só mais um instante…", "Desculpe a demora, vamos
   * lá.") — ver `VoiceDelayPhrases`. Aditivo (ausente no registro = os padrões).
   */
  delayPhrases: VoiceDelayPhrases
  /** Frases de ferramenta (1 por turno, na 1ª tool) — ver `VoiceToolPhrases`. Aditivo (ausente = padrões). */
  toolPhrases: VoiceToolPhrases
  /** Tags de voz na chamada (padrão false — opt-in). Aditivo (ausente = false). */
  audioTags: boolean
  /** Instrução das tags; null = `DEFAULT_AUDIO_TAGS_PROMPT`. Aditivo. */
  audioTagsPrompt: string | null
}

/**
 * Turnos da chamada de voz (setting `voiceCallDefaults.turn`). `silenceStopMs: 0` é tratado como
 * `null` (na chamada o turno SEMPRE tem limite de silêncio — sem limite não há turnos).
 *
 * **Fim de turno adaptativo** (`adaptive`, padrão ligado): aos `speculativeAtMs` de pausa o app
 * transcreve o que já foi dito (transcrição especulativa — motor local; API só com
 * `speculativeApi`) e o silêncio exigido passa a depender de como a fala termina
 * (`classifyUtteranceEnd` em `@shared/voiceTurn`): completa (pergunta/comando/fecho) →
 * `completeSilenceMs`; afirmação → `statementSilenceMs`; inacabada (conectivo, vírgula,
 * hesitação) → `unfinishedSilenceMs`. Sem transcrição especulativa vale `silenceStopMs`. A
 * transcrição especulativa vira a final quando o usuário não voltou a falar (sem 2ª chamada).
 */
export interface VoiceCallTurnConfig {
  /**
   * Ms de silêncio contínuo que ENCERRAM a fala do usuário quando NÃO há transcrição especulativa
   * (adaptativo desligado/indisponível). `null` = o padrão (`DEFAULT_TURN_SILENCE_MS`) —
   * independente do auto-stop do ditado (`audioInput.silenceStopMs`, 5 s, longo demais para turno).
   */
  silenceStopMs: number | null
  /** Fim de turno adaptativo com transcrição especulativa (padrão true). */
  adaptive: boolean
  /** Pausa (ms) em que a transcrição especulativa dispara (padrão 250). */
  speculativeAtMs: number
  /** Silêncio (ms) que fecha uma fala COMPLETA — pergunta, comando, fecho (padrão 600). */
  completeSilenceMs: number
  /** Silêncio (ms) que fecha uma AFIRMAÇÃO (ponto final do STT — pode ser história no meio; padrão 1200). */
  statementSilenceMs: number
  /** Silêncio (ms) que fecha uma fala INACABADA — conectivo/vírgula/hesitação; é o teto (padrão 1500). */
  unfinishedSilenceMs: number
  /** Permite a transcrição especulativa pela API no modo 'api' (custa 1 request por pausa; padrão false). */
  speculativeApi: boolean
  /**
   * Barge-in com histerese ("ducking" — aditivo; ausente = os padrões): a fala do usuário por cima
   * da resposta primeiro ABAIXA o áudio do assistente para `duckGain` (0–1; padrão 0.3) e ele
   * continua tocando; só vira barge-in (para a resposta) com `bargeInVoicedMs` de voz no episódio
   * (padrão 700) ou `bargeInWords` palavras reais na transcrição parcial (padrão 3; "uhum"/"sim"
   * não contam) — ou uma palavra de parada ("para", "espera"…). Parou antes disso: depois de
   * `duckRestoreMs` de silêncio (padrão 450) o volume volta e o som curto é descartado.
   */
  duckGain?: number
  bargeInVoicedMs?: number
  bargeInWords?: number
  duckRestoreMs?: number
}

/** Limiares do barge-in com histerese (resolvidos de `VoiceCallTurnConfig` — `resolveBargeIn`). */
export interface BargeInConfig {
  /** Ganho do áudio do assistente enquanto o usuário fala por cima (0–1). */
  duckGain: number
  /** Voz do usuário (ms de quadros com voz no episódio) que confirma o barge-in. */
  voicedMs: number
  /** Palavras reais (fora backchannel) na transcrição parcial que confirmam o barge-in. */
  words: number
  /** Silêncio (ms) que devolve o volume e descarta o som curto. */
  restoreMs: number
}

export const DEFAULT_BARGE_IN: BargeInConfig = {
  duckGain: 0.3,
  voicedMs: 700,
  words: 3,
  restoreMs: 450
}

/** Faixas aceitas dos limiares do barge-in (fora delas o valor é preso no limite). */
export const BARGE_IN_RANGES = {
  duckGain: { min: 0, max: 1 },
  voicedMs: { min: 200, max: 5000 },
  words: { min: 1, max: 10 },
  restoreMs: { min: 150, max: 3000 }
} as const

/** Silêncio de turno padrão da chamada sem transcrição especulativa (ms). */
export const DEFAULT_TURN_SILENCE_MS = 1000

export const DEFAULT_VOICE_CALL_TURN: VoiceCallTurnConfig = {
  silenceStopMs: null,
  adaptive: true,
  speculativeAtMs: 250,
  completeSilenceMs: 600,
  statementSilenceMs: 1200,
  unfinishedSilenceMs: 1500,
  speculativeApi: false,
  duckGain: DEFAULT_BARGE_IN.duckGain,
  bargeInVoicedMs: DEFAULT_BARGE_IN.voicedMs,
  bargeInWords: DEFAULT_BARGE_IN.words,
  duckRestoreMs: DEFAULT_BARGE_IN.restoreMs
}

/**
 * Prompt-base do modo voz (somado ao system prompt nos turnos da chamada, antes do `voicePrompt`
 * do chat): respostas curtas, sem markdown, sem narrar falhas internas, e o aviso de que a fala
 * vem de transcrição automática (maiúsculas/acentos podem estar errados — "SRC" pode ser "src").
 */
export const DEFAULT_VOICE_BASE_PROMPT = [
  'Você está numa conversa por voz: sua resposta será lida em voz alta.',
  'A primeira frase tem no máximo 10 palavras e vai direto ao ponto. No máximo 3 frases curtas no total.',
  'Sem markdown, listas, títulos, tabelas, emojis ou blocos de código — escreva como se fala.',
  'Não narre tentativas internas nem erros de ferramentas em detalhe: se algo falhar, diga em uma frase curta o que houve e o que vai fazer.',
  'A fala do usuário vem de transcrição automática e pode ter maiúsculas, acentos ou palavras erradas (ex.: "SRC" pode ser a pasta "src"); interprete pela intenção e, em nomes de arquivos e pastas, tente a grafia em minúsculas antes de concluir que não existe.',
  'Se o usuário se despedir ou pedir para desligar, responda com uma despedida curta e, se a ferramenta end_call estiver disponível, chame-a no mesmo turno.'
].join(' ')

export const DEFAULT_VOICE_CALL_DEFAULTS: VoiceCallDefaults = {
  enabled: true,
  fillers: { enabled: true, prompt: null, delayMs: DEFAULT_FILLER_DELAY_MS, pool: null },
  turn: { ...DEFAULT_VOICE_CALL_TURN },
  model: null,
  basePromptEnabled: true,
  basePrompt: null,
  endCall: true,
  delayPhrases: { ...DEFAULT_DELAY_PHRASES },
  toolPhrases: { ...DEFAULT_TOOL_PHRASES },
  audioTags: false,
  audioTagsPrompt: null
}

/** Config "vazia": tudo null = herda os padrões globais (`voiceCallDefaults`) e o próprio chat. */
export const DEFAULT_VOICE_CALL_CONFIG: VoiceCallConfig = {
  enabled: null,
  model: null,
  tools: null,
  voicePrompt: null,
  fillers: null
}

// ---------------- normalizadores ----------------

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** String não vazia, aparada; vazio/não-string → null. */
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/** String não vazia, aparada; vazio/não-string → o padrão. */
const strOr = (v: unknown, def: string): string =>
  typeof v === 'string' && v.trim() ? v.trim() : def

const boolOr = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)

/** Inteiro ≥ 0 (0 válido — significado próprio, ex. `silenceStopMs: 0` = ignora o limite); inválido → padrão. */
const intOr = (v: unknown, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  return Number.isNaN(n) || n < 0 ? def : n
}

/** Inteiro ≥ 0 ou null (null = "igual ao chat"); inválido → null. */
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  return Number.isNaN(n) ? null : Math.max(0, n)
}

/** Texto de prompt (sem CR); vazio/não-string → null. */
const promptOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.replace(/\r/g, '') : null

/** Instrução das tags de voz: aparada, sem CR, até `AUDIO_TAGS_PROMPT_MAX`; vazio/lixo → null. */
export function normalizeAudioTagsPrompt(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\r/g, '').trim().slice(0, AUDIO_TAGS_PROMPT_MAX).trim()
  return t || null
}

/** Params como em `presets.ts` (`cleanParams`): só valores definidos (≠ null/NaN); chaves desconhecidas preservadas. */
const cleanParams = (v: unknown): ChatParams => {
  const out: Record<string, unknown> = {}
  const src = asObject(v)
  if (!src) return out
  for (const [k, val] of Object.entries(src)) {
    if (val === undefined || val === null || (typeof val === 'number' && Number.isNaN(val)))
      continue
    out[k] = val
  }
  return out as ChatParams
}

/** Config completa de entrada de áudio (ausente/inválido → `DEFAULT_AUDIO_INPUT`). */
export function normalizeAudioInput(v: unknown): AudioInputSettings {
  const src = asObject(v)
  if (!src) return { ...DEFAULT_AUDIO_INPUT }
  return {
    deviceId: strOrNull(src.deviceId),
    activationDb: normalizeActivationDb(src.activationDb),
    pttEnabled: boolOr(src.pttEnabled, DEFAULT_AUDIO_INPUT.pttEnabled),
    pttKey: strOrNull(src.pttKey),
    silenceStopEnabled: boolOr(src.silenceStopEnabled, DEFAULT_AUDIO_INPUT.silenceStopEnabled),
    // 0 é válido ("ignora o limite") e é preservado
    silenceStopMs: intOr(src.silenceStopMs, DEFAULT_AUDIO_INPUT.silenceStopMs),
    language: strOr(src.language, DEFAULT_AUDIO_INPUT.language)
  }
}

/** Settings completas de transcrição (ausente/inválido → `DEFAULT_STT_SETTINGS`). */
export function normalizeSttSettings(v: unknown): SttSettings {
  const src = asObject(v)
  const api = asObject(src?.api)
  const local = asObject(src?.local)
  return {
    mode:
      src && (STT_MODES as readonly string[]).includes(src.mode as string)
        ? (src.mode as SttMode)
        : DEFAULT_STT_SETTINGS.mode,
    // só provedor + modelo: `baseUrl`/`apiKey` gravados por versões de desenvolvimento são descartados
    api: {
      providerId: strOrNull(api?.providerId),
      model: strOr(api?.model, DEFAULT_STT_API.model),
      // aditivo: parâmetros do modelo por família (vazio = a chave sai)
      ...(() => {
        const params = normalizeVoiceApiParams('stt', api?.params)
        return params ? { params } : {}
      })()
    },
    // null = nenhum motor instalado (objeto inválido também cai em null)
    local: local
      ? {
          engine: (STT_LOCAL_ENGINES as readonly string[]).includes(local.engine as string)
            ? (local.engine as SttLocalEngine)
            : 'whisper.cpp',
          model: typeof local.model === 'string' ? local.model.trim() : '',
          installed: local.installed === true
        }
      : null,
    livePartials: boolOr(src?.livePartials, DEFAULT_STT_SETTINGS.livePartials),
    reusePartialFinal: boolOr(src?.reusePartialFinal, true),
    // aditivo: com o modo `gpu` (ou um `gpu` salvo) — o único motor é o whisper-large-v3-turbo
    ...(src?.mode === 'gpu' || asObject(src?.gpu)
      ? (() => {
          const params = normalizeGpuParamOverrides(GPU_STT_ENGINE_ID, asObject(src?.gpu)?.params)
          return {
            gpu: {
              engine: GPU_STT_ENGINE_ID,
              ...(Object.keys(params).length ? { params } : {})
            }
          }
        })()
      : {})
  }
}

/** `ttsSettings.gpu` normalizado (null = ausente/lixo). */
export function normalizeTtsGpu(v: unknown): TtsGpuConfig | null {
  const g = asObject(v)
  if (!g) return null
  const steps = normalizeOmniSteps(g.steps)
  const params = normalizeTtsGpuParams(g.params)
  return {
    engine: isGpuTtsEngineId(g.engine) ? g.engine : DEFAULT_TTS_GPU.engine,
    voice: strOrNull(g.voice),
    ...(steps !== undefined ? { steps } : {}),
    ...(params ? { params } : {})
  }
}

/**
 * Settings completas de fala (ausente/inválido → `DEFAULT_TTS_SETTINGS`). `local: null` salvo é
 * preservado (= o usuário limpou explicitamente); `local` ausente/lixo → o padrão (Kokoro não
 * instalado) e objeto parcial é completado com `DEFAULT_TTS_LOCAL`.
 */
export function normalizeTtsSettings(v: unknown): TtsSettings {
  const src = asObject(v)
  const api = asObject(src?.api)
  const local = asObject(src?.local)
  return {
    backend:
      src?.backend === 'api' || src?.backend === 'gpu' ? src.backend : DEFAULT_TTS_SETTINGS.backend,
    // provedor + modelo + voz + opções (`baseUrl`/`apiKey`/`providerKind` nunca são gravados)
    api: {
      providerId: strOrNull(api?.providerId),
      model: strOr(api?.model, DEFAULT_TTS_API.model),
      voice: strOrNull(api?.voice),
      // aditivo: só o `false` explícito é gravado (ausente = WebSocket ligado)
      ...(api?.elevenLabsWs === false ? { elevenLabsWs: false } : {}),
      // aditivo: parâmetros do modelo por família (vazio = a chave sai)
      ...(() => {
        const params = normalizeVoiceApiParams('tts', api?.params)
        return params ? { params } : {}
      })()
    },
    // null explícito = limpo pelo usuário; ausente/lixo → o motor padrão (Kokoro)
    local:
      src && 'local' in src && src.local === null
        ? null
        : {
            engine:
              local && (TTS_LOCAL_ENGINES as readonly string[]).includes(local.engine as string)
                ? (local.engine as TtsLocalEngine)
                : DEFAULT_TTS_LOCAL.engine,
            voice: strOr(local?.voice, DEFAULT_TTS_LOCAL.voice),
            installed: local?.installed === true
          },
    // aditivo: com o backend `gpu` (padrão OmniVoice) ou um `gpu` salvo
    ...(() => {
      const gpu =
        normalizeTtsGpu(src?.gpu) ?? (src?.backend === 'gpu' ? { ...DEFAULT_TTS_GPU } : null)
      return gpu ? { gpu } : {}
    })()
  }
}

/** Pool de preâmbulos normalizado: frases válidas (texto aparado ≤ 80 chars), no máximo `FILLER_POOL_MAX`; vazio/lixo → null. */
export function normalizeFillerPool(v: unknown): FillerPhrase[] | null {
  if (!Array.isArray(v)) return null
  const out: FillerPhrase[] = []
  for (const item of v) {
    const o = asObject(item)
    const text = typeof o?.text === 'string' ? o.text.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    if (!text) continue
    const contexts = Array.isArray(o?.contexts)
      ? FILLER_CONTEXTS.filter((c) => (o!.contexts as unknown[]).includes(c))
      : []
    out.push({ text, contexts })
    if (out.length >= FILLER_POOL_MAX) break
  }
  return out.length ? out : null
}

/** Pool efetivo (null → `DEFAULT_FILLER_POOL`). */
export function resolveFillerPool(pool: FillerPhrase[] | null | undefined): FillerPhrase[] {
  const p = normalizeFillerPool(pool ?? null)
  return p ?? DEFAULT_FILLER_POOL.map((f) => ({ text: f.text, contexts: [...f.contexts] }))
}

/**
 * Pool de frases de ferramenta: textos aparados (≤ 80 chars, sem duplicatas), categorias conhecidas
 * (vazia = `generic`), no máximo `TOOL_PHRASE_POOL_MAX`; vazio/lixo → null.
 */
export function normalizeToolPhrasePool(v: unknown): ToolPhrase[] | null {
  if (!Array.isArray(v)) return null
  const out: ToolPhrase[] = []
  for (const item of v) {
    const o = asObject(item)
    const text = typeof o?.text === 'string' ? o.text.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    if (!text || out.some((p) => p.text === text)) continue
    const categories = Array.isArray(o?.categories)
      ? TOOL_PHRASE_CATEGORIES.filter((c) => (o!.categories as unknown[]).includes(c))
      : []
    if (!categories.length) continue // sem categoria conhecida: nunca seria escolhida
    out.push({ text, categories })
    if (out.length >= TOOL_PHRASE_POOL_MAX) break
  }
  return out.length ? out : null
}

/** Pool efetivo de frases de ferramenta (null → `DEFAULT_TOOL_PHRASE_POOL`). */
export function resolveToolPhrasePool(pool: ToolPhrase[] | null | undefined): ToolPhrase[] {
  const p = normalizeToolPhrasePool(pool ?? null)
  return p ?? DEFAULT_TOOL_PHRASE_POOL.map((f) => ({ text: f.text, categories: [...f.categories] }))
}

/** Frases de ferramenta completas (ausente/lixo → `DEFAULT_TOOL_PHRASES`). */
export function normalizeToolPhrases(v: unknown): VoiceToolPhrases {
  const src = asObject(v)
  return {
    enabled: boolOr(src?.enabled, DEFAULT_TOOL_PHRASES.enabled),
    pool: normalizeToolPhrasePool(src?.pool)
  }
}

/** Turnos completos (ausente/lixo → `DEFAULT_VOICE_CALL_TURN`); 0 em `silenceStopMs` vira null. */
export function normalizeVoiceCallTurn(v: unknown): VoiceCallTurnConfig {
  const t = asObject(v)
  const d = DEFAULT_VOICE_CALL_TURN
  const turnMs = intOrNull(t?.silenceStopMs)
  const pos = (x: unknown, def: number): number => {
    const n = intOr(x, def)
    return n > 0 ? n : def
  }
  return {
    // null = o padrão da chamada (DEFAULT_TURN_SILENCE_MS); 0 não faz sentido aqui (sem limite =
    // sem turnos) e vira null
    silenceStopMs: turnMs && turnMs > 0 ? turnMs : null,
    adaptive: boolOr(t?.adaptive, d.adaptive),
    speculativeAtMs: pos(t?.speculativeAtMs, d.speculativeAtMs),
    completeSilenceMs: pos(t?.completeSilenceMs, d.completeSilenceMs),
    statementSilenceMs: pos(t?.statementSilenceMs, d.statementSilenceMs),
    unfinishedSilenceMs: pos(t?.unfinishedSilenceMs, d.unfinishedSilenceMs),
    speculativeApi: boolOr(t?.speculativeApi, d.speculativeApi),
    // barge-in com histerese (aditivo): lixo → padrão; fora da faixa → preso no limite
    ...(() => {
      const b = resolveBargeIn(t)
      return {
        duckGain: b.duckGain,
        bargeInVoicedMs: b.voicedMs,
        bargeInWords: b.words,
        duckRestoreMs: b.restoreMs
      }
    })()
  }
}

/** Limiares do barge-in com histerese a partir do `turn` (ausente/lixo → `DEFAULT_BARGE_IN`). */
export function resolveBargeIn(turn: unknown): BargeInConfig {
  const t = asObject(turn)
  const d = DEFAULT_BARGE_IN
  const r = BARGE_IN_RANGES
  const num = (
    v: unknown,
    def: number,
    range: { min: number; max: number },
    int: boolean
  ): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return def
    const n = int ? Math.round(v) : Math.round(v * 100) / 100
    return Math.min(range.max, Math.max(range.min, n))
  }
  return {
    duckGain: num(t?.duckGain, d.duckGain, r.duckGain, false),
    voicedMs: num(t?.bargeInVoicedMs, d.voicedMs, r.voicedMs, true),
    words: num(t?.bargeInWords, d.words, r.words, true),
    restoreMs: num(t?.duckRestoreMs, d.restoreMs, r.restoreMs, true)
  }
}

/**
 * Config completa da chamada de voz a partir de qualquer valor salvo (ausente/inválido →
 * `DEFAULT_VOICE_CALL_CONFIG` = tudo herda). Campos `null` são preservados (null ≠ false: null
 * herda o padrão global); chaves desconhecidas são descartadas (como nos demais normalizadores) e
 * `model.params` preserva as chaves que não conhece (como `cleanParams` em presets.ts).
 */
/** Modelo da chamada (provider + model + params) ou null (sem provider/model válidos). */
export function normalizeVoiceCallModel(v: unknown): VoiceCallModelConfig | null {
  const model = asObject(v)
  const providerId = strOrNull(model?.providerId)
  const modelName = strOrNull(model?.model)
  return model && providerId && modelName
    ? { providerId, model: modelName, params: cleanParams(model.params) }
    : null
}

const promptModeOrNull = (v: unknown): VoiceCallPromptMode | null =>
  VOICE_CALL_PROMPT_MODES.includes(v as VoiceCallPromptMode) ? (v as VoiceCallPromptMode) : null

export function normalizeVoiceCallConfig(v: unknown): VoiceCallConfig {
  const src = asObject(v)
  if (!src) return { ...DEFAULT_VOICE_CALL_CONFIG }
  // só os campos conhecidos são copiados: o `interjections` de registros antigos (legado —
  // protocolo §4.3.6) some aqui e nunca volta a ser gravado nem enviado
  const tools = asObject(src.tools)
  const fillers = asObject(src.fillers)
  const promptMode = promptModeOrNull(src.promptMode)
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : null,
    model: normalizeVoiceCallModel(src.model),
    tools: tools
      ? {
          enabledTools: normalizeToolList(tools.enabledTools) ?? null,
          maxToolOutputChars: intOrNull(tools.maxToolOutputChars)
        }
      : null,
    voicePrompt: promptOrNull(src.voicePrompt),
    // aditivo: só gravado quando escolhido (ausente = herda → complementar)
    ...(promptMode ? { promptMode } : {}),
    // objeto presente = override do global; `enabled` ausente completa com o padrão (ligado)
    fillers: fillers
      ? {
          enabled: boolOr(fillers.enabled, DEFAULT_VOICE_CALL_DEFAULTS.fillers.enabled),
          prompt: promptOrNull(fillers.prompt)
        }
      : null,
    // aditivo: só gravado quando escolhido (ausente = herda o global)
    ...(typeof src.endCall === 'boolean' ? { endCall: src.endCall } : {}),
    // tags de voz (aditivo; opt-in): só gravados quando escolhidos — lixo some
    ...(typeof src.audioTags === 'boolean' ? { audioTags: src.audioTags } : {}),
    ...(typeof src.toolPhrases === 'boolean' ? { toolPhrases: src.toolPhrases } : {}),
    ...(() => {
      const p = normalizeAudioTagsPrompt(src.audioTagsPrompt)
      return p ? { audioTagsPrompt: p } : {}
    })()
  }
}

/** Padrões globais completos da chamada de voz (ausente/inválido → `DEFAULT_VOICE_CALL_DEFAULTS`). */
export function normalizeVoiceCallDefaults(v: unknown): VoiceCallDefaults {
  const src = asObject(v)
  const fillers = asObject(src?.fillers)
  const d = DEFAULT_VOICE_CALL_DEFAULTS
  return {
    enabled: boolOr(src?.enabled, d.enabled),
    // `interjections` (legado — protocolo §4.3.6) é descartado: nunca regravado nem enviado
    fillers: {
      enabled: boolOr(fillers?.enabled, d.fillers.enabled),
      prompt: promptOrNull(fillers?.prompt),
      // 0 é válido (preâmbulo já, sem esperar)
      delayMs: Math.min(5000, intOr(fillers?.delayMs, d.fillers.delayMs)),
      pool: normalizeFillerPool(fillers?.pool)
    },
    turn: normalizeVoiceCallTurn(src?.turn),
    // `maxTokens` (teto antigo dos turnos de voz) saiu: o max_tokens vive nos params do modelo da
    // chamada — um valor gravado é descartado aqui
    model: normalizeVoiceCallModel(src?.model),
    basePromptEnabled: boolOr(src?.basePromptEnabled, d.basePromptEnabled),
    basePrompt: promptOrNull(src?.basePrompt),
    endCall: boolOr(src?.endCall, d.endCall),
    delayPhrases: normalizeDelayPhrases(src?.delayPhrases),
    toolPhrases: normalizeToolPhrases(src?.toolPhrases),
    audioTags: boolOr(src?.audioTags, d.audioTags),
    audioTagsPrompt: normalizeAudioTagsPrompt(src?.audioTagsPrompt)
  }
}

/** Pool de frases de demora: textos aparados (≤ 80 chars, sem duplicatas, máx. 12); vazio/lixo → null. */
export function normalizeDelayPhrasePool(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    const text =
      typeof item === 'string'
        ? item.replace(/\s+/g, ' ').trim().slice(0, DELAY_PHRASE_MAX_CHARS).trim()
        : ''
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= DELAY_PHRASE_POOL_MAX) break
  }
  return out.length ? out : null
}

/**
 * Frases de demora completas (ausente/lixo → `DEFAULT_DELAY_PHRASES`; tempos presos em 1–60 s; o
 * valor igual ao padrão antigo — `LEGACY_DELAY_PHRASE_DEFAULTS` — vira o padrão novo).
 */
export function normalizeDelayPhrases(v: unknown): VoiceDelayPhrases {
  const src = asObject(v)
  const d = DEFAULT_DELAY_PHRASES
  const ms = (x: unknown, def: number, legacy: number): number => {
    const n = typeof x === 'number' && Number.isFinite(x) ? Math.round(x) : NaN
    if (Number.isNaN(n) || n <= 0 || n === legacy) return def
    return Math.min(DELAY_PHRASE_MS_RANGE.max, Math.max(DELAY_PHRASE_MS_RANGE.min, n))
  }
  const legacy = LEGACY_DELAY_PHRASE_DEFAULTS
  return {
    enabled: boolOr(src?.enabled, d.enabled),
    keepAliveAfterMs: ms(src?.keepAliveAfterMs, d.keepAliveAfterMs, legacy.keepAliveAfterMs),
    apologyAfterMs: ms(src?.apologyAfterMs, d.apologyAfterMs, legacy.apologyAfterMs),
    keepAlivePool: normalizeDelayPhrasePool(src?.keepAlivePool),
    apologyPool: normalizeDelayPhrasePool(src?.apologyPool)
  }
}

/** Pools efetivos das frases de demora (null → os padrões). */
export function resolveDelayPhrasePools(
  p: Pick<VoiceDelayPhrases, 'keepAlivePool' | 'apologyPool'>
): {
  keepAlive: string[]
  apology: string[]
} {
  return {
    keepAlive: normalizeDelayPhrasePool(p.keepAlivePool) ?? [...DEFAULT_KEEPALIVE_POOL],
    apology: normalizeDelayPhrasePool(p.apologyPool) ?? [...DEFAULT_APOLOGY_POOL]
  }
}

// ---------------- resolução da chamada de voz (herança persona→chat→global) ----------------

/**
 * Silêncio que encerra a fala do usuário na chamada (ms): `turn.silenceStopMs` quando definido;
 * senão `DEFAULT_TURN_SILENCE_MS` (na chamada o turno SEMPRE tem limite — sem limite não há
 * turnos). O auto-stop do ditado (`audioInput`) NÃO é herdado: o padrão dele (5 s) é longo demais
 * para turno de conversa. `audioInput` segue aceito por compatibilidade com os chamadores.
 */
export function resolveTurnSilenceMs(
  turn: VoiceCallTurnConfig | null | undefined,
  audioInput?: Pick<AudioInputSettings, 'silenceStopEnabled' | 'silenceStopMs'>
): number {
  void audioInput
  const explicit = turn?.silenceStopMs
  if (typeof explicit === 'number' && explicit > 0) return Math.round(explicit)
  return DEFAULT_TURN_SILENCE_MS
}

/**
 * Tempos efetivos do fim de turno (renderer: `AdaptiveTurnGate`). Coerentes por construção:
 * `completeMs ≤ statementMs ≤ unfinishedMs` e `fallbackMs` (sem transcrição especulativa) dentro
 * de `[completeMs, unfinishedMs]`; `speculativeAtMs` < `completeMs`.
 */
export interface TurnTiming {
  adaptive: boolean
  speculativeAtMs: number
  completeMs: number
  statementMs: number
  unfinishedMs: number
  fallbackMs: number
  /**
   * Silêncio exigido enquanto a especulação está pendente; ausente = `unfinishedMs` (o teto). A
   * chamada põe `fallbackMs` quando a especulação vai pela API (lenta: 1–3 s no OpenRouter) — o
   * turno fecha no silêncio fixo e a final reaproveita a especulação em voo.
   */
  pendingMs?: number
  /** Barge-in com histerese (ducking) — ausente = `DEFAULT_BARGE_IN`. */
  bargeIn?: BargeInConfig
}

export function resolveTurnTiming(turn: VoiceCallTurnConfig | null | undefined): TurnTiming {
  const t = normalizeVoiceCallTurn(turn ?? null)
  const fallbackMs = resolveTurnSilenceMs(t)
  const unfinishedMs = Math.max(t.unfinishedSilenceMs, fallbackMs, t.statementSilenceMs)
  const completeMs = Math.min(t.completeSilenceMs, fallbackMs, t.statementSilenceMs)
  const statementMs = Math.min(Math.max(t.statementSilenceMs, completeMs), unfinishedMs)
  return {
    adaptive: t.adaptive,
    speculativeAtMs: Math.min(t.speculativeAtMs, Math.max(1, completeMs - 100)),
    completeMs,
    statementMs,
    unfinishedMs,
    fallbackMs,
    bargeIn: resolveBargeIn(t)
  }
}

export const DEFAULT_TURN_TIMING: TurnTiming = resolveTurnTiming(DEFAULT_VOICE_CALL_TURN)

/**
 * Camadas chat → persona da chamada de voz: cada campo `null`/ausente do chat herda o da persona
 * de origem (`ChatConfig.presetId`, lida AO VIVO). A persona também entra por snapshot na criação
 * do chat (`applyPreset`), então os dois coincidem até alguém mudar um dos lados; um campo que o
 * chat devolveu a "★ padrão" (null) segue a persona atual. Persona ausente → o próprio chat.
 */
export function layerVoiceCallConfig(
  chat: VoiceCallConfig | null | undefined,
  persona: VoiceCallConfig | null | undefined
): VoiceCallConfig {
  const c = normalizeVoiceCallConfig(chat ?? null)
  if (!persona) return c
  const p = normalizeVoiceCallConfig(persona)
  const mode = c.promptMode ?? p.promptMode ?? null
  const endCall = c.endCall ?? p.endCall ?? null
  const audioTags = c.audioTags ?? p.audioTags ?? null
  const toolPhrases = c.toolPhrases ?? p.toolPhrases ?? null
  const audioTagsPrompt = c.audioTagsPrompt ?? p.audioTagsPrompt ?? null
  return {
    enabled: c.enabled ?? p.enabled,
    model: c.model ?? p.model,
    tools: c.tools ?? p.tools,
    voicePrompt: c.voicePrompt ?? p.voicePrompt,
    ...(mode ? { promptMode: mode } : {}),
    fillers: c.fillers ?? p.fillers,
    ...(endCall !== null ? { endCall } : {}),
    ...(audioTags !== null ? { audioTags } : {}),
    ...(toolPhrases !== null ? { toolPhrases } : {}),
    ...(audioTagsPrompt !== null ? { audioTagsPrompt } : {})
  }
}

/** De onde vem o `enabled` efetivo (o tooltip do telefone explica quem desligou). */
export type VoiceCallSource = 'chat' | 'persona' | 'global'

/**
 * Chamada liberada? Precedência chat > persona > global. Com o snapshot da persona o chat costuma
 * ter o mesmo valor dela — valor igual ao da persona conta como "da persona" (o motivo exibido).
 */
export function resolveVoiceCallEnabled(
  chat: VoiceCallConfig | null | undefined,
  persona: VoiceCallConfig | null | undefined,
  defaults: VoiceCallDefaults | null | undefined
): { enabled: boolean; source: VoiceCallSource } {
  const c = normalizeVoiceCallConfig(chat ?? null).enabled
  const p = persona ? normalizeVoiceCallConfig(persona).enabled : null
  if (c !== null) return { enabled: c, source: p === c ? 'persona' : 'chat' }
  if (p !== null) return { enabled: p, source: 'persona' }
  return { enabled: normalizeVoiceCallDefaults(defaults ?? null).enabled, source: 'global' }
}

/**
 * `VoiceCallConfig` resolvido: campos null herdam o padrão (chat → persona via
 * `layerVoiceCallConfig`; aqui → global). `model` = chat > persona > global (`voiceCallDefaults
 * .model`) > null (o modelo do próprio chat); `tools` continua `null` sem override.
 */
export interface ResolvedVoiceCall {
  /** Chamada de voz liberada (para UI/envio). */
  enabled: boolean
  /** Modelo próprio da chamada (provider/model/params); null = o modelo do chat. */
  model: VoiceCallModelConfig | null
  /** Tools próprias (campos null = os do chat); null = igual ao chat. */
  tools: VoiceCallToolsConfig | null
  /** Prompt do modo voz; null = sem prompt próprio. */
  voicePrompt: string | null
  /** Composição do prompt nos turnos de voz (padrão `'append'`). */
  promptMode: VoiceCallPromptMode
  /** Falas preenchidoras efetivas (consumidas pela chamada — ver SPEC → "Fillers"). */
  fillers: VoiceFillers
  /** Prompt-base do modo voz (global); null = desligado. */
  basePrompt: string | null
  /** O agente pode encerrar a chamada (tool `end_call`) — chat > persona > global (padrão true). */
  endCall: boolean
  /** Frases de ferramenta (chat > persona > global `toolPhrases.enabled`; padrão true). */
  toolPhrases: boolean
  /** Tags de voz pedidas (chat > persona > global; padrão false) — ver `audioTagsActive`. */
  audioTags: boolean
  /** Instrução efetiva das tags (chat > persona > global > `DEFAULT_AUDIO_TAGS_PROMPT`). */
  audioTagsPrompt: string
  /**
   * A voz da chamada em andamento interpreta tags (`ttsSupportsAudioTags` — só no contexto do turno,
   * `VoiceCallManager.callContextFor`): com `audioTags` ligado, a instrução entra no prompt.
   */
  audioTagsActive?: boolean
  /**
   * Id da chamada em andamento (só no contexto do turno — `VoiceCallManager.callContextFor`): vai
   * em `meta.voice.callId` das mensagens faladas. Ausente fora da chamada/na resolução da UI.
   */
  callId?: string
  /** Modelo/motor da voz da chamada em andamento (`meta.voice.ttsModel` das respostas). */
  ttsModel?: string
}

/**
 * Resolução completa (aceita lixo/null; `enabled: null` herda o global — null ≠ false). `persona`
 * (opcional) = a config de voz da persona de origem do chat (`presetId`), lida ao vivo.
 */
export function resolveVoiceCallConfig(
  config: VoiceCallConfig | null | undefined,
  defaults: VoiceCallDefaults | null | undefined,
  persona?: VoiceCallConfig | null
): ResolvedVoiceCall {
  const c = layerVoiceCallConfig(config ?? null, persona ?? null)
  const d = normalizeVoiceCallDefaults(defaults ?? null)
  return {
    enabled: c.enabled ?? d.enabled,
    model: c.model ?? d.model,
    tools: c.tools,
    voicePrompt: c.voicePrompt,
    promptMode: c.promptMode ?? 'append',
    fillers: c.fillers ?? { enabled: d.fillers.enabled, prompt: d.fillers.prompt },
    basePrompt: d.basePromptEnabled ? (d.basePrompt ?? DEFAULT_VOICE_BASE_PROMPT) : null,
    endCall: c.endCall ?? d.endCall,
    audioTags: c.audioTags ?? d.audioTags,
    toolPhrases: c.toolPhrases ?? d.toolPhrases.enabled,
    audioTagsPrompt: c.audioTagsPrompt ?? d.audioTagsPrompt ?? DEFAULT_AUDIO_TAGS_PROMPT
  }
}

/**
 * System prompt dos turnos de voz pelo modo (ver `VoiceCallPromptMode`): `append` = system +
 * prompt-base + prompt do modo voz; `replace` = prompt-base + prompt do modo voz no lugar do system
 * (sem prompt do modo voz → como `append`); `none` = só o system. Separados por linha em branco. A
 * instrução das tags de voz entra no FIM (em qualquer modo — é um opt-in explícito) só com as tags
 * pedidas (`audioTags`) E a voz da chamada as interpretando (`audioTagsActive`).
 */
export function voiceSystemPrompt(
  systemPrompt: string,
  call: Pick<ResolvedVoiceCall, 'basePrompt' | 'voicePrompt' | 'promptMode'> &
    Partial<Pick<ResolvedVoiceCall, 'audioTags' | 'audioTagsPrompt' | 'audioTagsActive'>>
): string {
  const join = (parts: (string | null | undefined)[]): string =>
    parts.filter((x): x is string => !!x?.trim()).join('\n\n')
  const tags = call.audioTags && call.audioTagsActive ? (call.audioTagsPrompt ?? null) : null
  const mode = call.promptMode ?? 'append'
  if (mode === 'none') return tags ? join([systemPrompt, tags]) : systemPrompt
  if (mode === 'replace' && call.voicePrompt?.trim())
    return join([call.basePrompt, call.voicePrompt, tags])
  return join([systemPrompt, call.basePrompt, call.voicePrompt, tags])
}

/**
 * Chat efetivo de um turno de voz (cópia): a config do chat com os overrides da chamada aplicados
 * (`model` → params; `tools` → enabledTools/maxToolOutputChars; prompt pelo `promptMode`) e o
 * raciocínio do modelo da chamada desligado/mínimo quando os params da chamada não o definem
 * (`planVoiceReasoning` — com `rules`, que o runner passa com o tipo do provedor e o /models). Sem
 * teto de tokens próprio (o `max_tokens` só vem dos params). Função pura — o chat salvo nunca muda
 * (o histórico de um turno de voz é idêntico ao de um turno de texto).
 */
export function applyVoiceCallChat(
  chat: Chat,
  call: ResolvedVoiceCall,
  rules?: VoiceReasoningRules
): Chat {
  const cfg = chat.config
  const out: ChatConfig = { ...cfg }
  if (call.model) out.params = { ...call.model.params }
  if (call.tools?.enabledTools != null) out.enabledTools = [...call.tools.enabledTools]
  if (call.tools?.maxToolOutputChars != null) out.maxToolOutputChars = call.tools.maxToolOutputChars
  const sys = voiceSystemPrompt(cfg.systemPrompt ?? '', call)
  if (sys !== (cfg.systemPrompt ?? '')) out.systemPrompt = sys
  if (rules) {
    const model = call.model?.model ?? cfg.model
    // "configurado no modelo da chamada" = reasoning_effort nos params da chamada; os params do
    // chat (texto) não contam — a chamada sem modelo próprio usa o raciocínio desligado/mínimo
    const explicit = call.model?.params.reasoning_effort != null
    out.params = planVoiceReasoning({
      params: out.params ?? {},
      explicit,
      kind: rules.kind,
      model,
      info: rules.info
    }).params
  }
  return { ...chat, config: out }
}

// ---------------- estado da chamada de voz (main → store/UI; canais `voice:call:*`) ----------------

/** Fase do turno de voz mostrada na UI ("Ouvindo…/Transcrevendo…/Pensando…/Falando…"). */
export type VoiceCallPhase = 'listening' | 'transcribing' | 'thinking' | 'speaking'

/**
 * Estado da chamada de voz ativa (evento `voice:call:state`; retorno dos canais `voice:call:*`).
 * `error` é a última falha legível (ex.: TTS); limpa na próxima transição bem-sucedida.
 */
export interface VoiceCallState {
  active: boolean
  chatId: string | null
  sessionId: string | null
  phase: VoiceCallPhase
  muted: boolean
  /** Silêncio que encerra o turno sem transcrição especulativa, em ms (resolvido em `voice:call:start`). */
  turnSilenceMs: number
  /** Tempos do fim de turno adaptativo (resolvidos em `voice:call:start`). */
  turnTiming: TurnTiming
  /** Fala já transcrita aguardando o próximo turno (máx. 1; '' = nenhuma). */
  pendingText: string
  error: string | null
  /**
   * Fase "Preparando a GPU…" (Modo avançado): andamento legível da subida/aquecimento do servidor
   * local ("Iniciando OmniVoice…", "Aquecendo OmniVoice + Whisper…"). Presente = o microfone ainda
   * NÃO abre; ausente/null = pronta. Aditivo (só aparece com fala/transcrição na GPU).
   */
  preparing?: string | null
  /** Id da chamada ativa (marcadores no histórico e `meta.voice.callId`). Aditivo. */
  callId?: string
  /** Início da chamada ativa (epoch ms do main) — o relógio "02:13" da barra. Aditivo. */
  startedAt?: number
}

/** Estado "desligado" (retorno de `voice:call:stop` / inicial do store). */
export const VOICE_CALL_INACTIVE: VoiceCallState = {
  active: false,
  chatId: null,
  sessionId: null,
  phase: 'listening',
  muted: false,
  turnSilenceMs: DEFAULT_TURN_SILENCE_MS,
  turnTiming: DEFAULT_TURN_TIMING,
  pendingText: '',
  error: null
}
