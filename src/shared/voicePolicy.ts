// Atos de fala curta da chamada de voz — política PURA (sem Electron/UI/IPC/fS): regras dos
// preâmbulos (fillers), das frases de espera ("manter viva"/"obrigado por aguardar") e do
// backchannel × barge-in durante a reprodução,
// testáveis em `e2e/voiceCallActs.test.ts` e `e2e/voiceDelayPhrases.test.ts`. O consumo real:
// `src/main/voice/call.ts` (preâmbulos/frases de demora) e `src/renderer/src/lib/voice/useVoiceCall.ts`
// (barge-in). Ver SPEC.md → "Áudio → Chamada de voz (meia-duplex)" (subseções "Fillers" e "Frases
// de demora"). A chamada é meia-duplex: nada toca durante a fala do usuário.
//
// v1 é por REGRA (sem classificador treinado): os limiares abaixo decidem. `VoiceFillers.prompt`
// existe na config mas NÃO é consumido em v1 — fica pronto para o classificador futuro.
import {
  DEFAULT_BARGE_IN,
  DEFAULT_FILLER_DELAY_MS,
  type BargeInConfig,
  type FillerContext,
  type FillerPhrase,
  type ToolPhrase,
  type ToolPhraseCategory
} from './voice'
import { isBackchannelText, isCommandLike, isQuestionLike } from './voiceTurn'
import { filterSilenceHallucination } from './speechGate'

// ---------------- constantes de tempo ----------------

/**
 * Espera padrão entre o turno enviado e o preâmbulo (ms — 2500): o preâmbulo só sai quando a
 * resposta demora; se a 1ª frase da resposta ficar pronta antes disso, ele nem sai (configurável em
 * `voiceCallDefaults.fillers.delayMs`).
 */
export const FILLER_DELAY_MS = DEFAULT_FILLER_DELAY_MS

/** Preâmbulo não repete nenhum dos últimos N usados. */
export const FILLER_RECENT_WINDOW = 4

/** Fala do usuário com menos palavras que isto (e que não é pergunta) não ganha preâmbulo. */
export const FILLER_MIN_WORDS = 3

/** Rampa (ms) do ducking — abaixar e devolver o volume do assistente sem degrau audível. */
export const DUCK_FADE_MS = 80

/**
 * Fala mínima para o preâmbulo (ms de VOZ — `VoicedSpan.spanMs`): fala com menos voz que isto
 * ("sim", "ok" curtinhos) não ganha o "Hum, deixa eu ver…".
 */
export const FILLER_MIN_SPEECH_MS = 700

/** Teto do texto guardado na timeline/no log de diagnóstico da chamada (caracteres). */
export const EVAL_TAIL_MAX_CHARS = 80

// ---------------- fillers (fase 1) ----------------

/** Estado do filler do turno em andamento (quem decide = `fillerShouldFire`). */
export interface FillerState {
  /** Momento em que o turno do usuário foi disparado (ms); null = sem turno em andamento. */
  turnStartedAt: number | null
  /**
   * Há tools em execução no turno — só informativo (o rótulo da decisão): a tool tem a frase de
   * ferramenta, que SUBSTITUI o preâmbulo; tool rodando NÃO antecipa o preâmbulo (2026-11-12).
   */
  toolsRunning: boolean
  /** O agente já falou algo neste turno (1ª utterance de sentença emitida). */
  spokenThisTurn: boolean
  /** O filler deste turno já foi disparado (máximo 1 por turno). */
  usedThisTurn: boolean
  /** A resposta está em voo (sem resposta, não há o que esperar). */
  responseInFlight: boolean
  /** `fillers.enabled` resolvido (persona→chat→global). */
  enabled: boolean
}

/** Estado vazio (turno em repouso). */
export const EMPTY_FILLER_STATE: FillerState = {
  turnStartedAt: null,
  toolsRunning: false,
  spokenThisTurn: false,
  usedThisTurn: false,
  responseInFlight: false,
  enabled: true
}

/**
 * O filler (preâmbulo) deste turno deve tocar AGORA? Regra v3 (2026-11-12 — "só quando a resposta
 * demora de verdade"):
 * - no máximo 1 por turno (`usedThisTurn` — também marcado quando a frase de ferramenta ou uma
 *   frase de demora tocou no lugar) e NUNCA depois de a 1ª frase da resposta ficar pronta
 *   (`spokenThisTurn`) — resposta rápida dispensa o preâmbulo;
 * - só depois de `delayMs` do turno enviado (padrão 2500; 0 = já; inválido/negativo → o padrão) —
 *   tool em execução NÃO antecipa (a frase de ferramenta cobre a tool);
 * - só com resposta em voo e filler habilitado.
 */
export function fillerShouldFire(
  s: FillerState,
  now: number,
  delayMs: number = FILLER_DELAY_MS
): boolean {
  if (!s.enabled || s.usedThisTurn || s.spokenThisTurn || !s.responseInFlight) return false
  if (s.turnStartedAt == null) return false
  const wait = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : FILLER_DELAY_MS
  return now - s.turnStartedAt >= wait
}

const CORRECTION_START =
  /^(nao|na verdade|espera|espere|pera|perai|peraí|pera ai|calma|opa|ops|quer dizer|errado|nao e isso|nao nao)\b/

const foldText = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()

/** Contagem de palavras (para "fala curta"/"pedido longo"). */
export function wordCount(text: string): number {
  return String(text ?? '')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/**
 * Contexto do turno que escolhe o preâmbulo: correção/interrupção ("não…", "espera", "peraí") →
 * `correction`; pedido longo (≥ 25 palavras ou > 160 chars) → `complex`; pergunta → `question`;
 * comando/tarefa → `command`; resto → `generic`.
 */
export function classifyFillerContext(text: string): FillerContext {
  const t = String(text ?? '').trim()
  if (!t) return 'generic'
  if (CORRECTION_START.test(foldText(t))) return 'correction'
  if (wordCount(t) >= 25 || t.length > 160) return 'complex'
  if (isQuestionLike(t)) return 'question'
  if (isCommandLike(t)) return 'command'
  return 'generic'
}

/**
 * Escolhe a frase do pool (índice 0-based) para o contexto: candidatas = frases do contexto (sem
 * contexto declarado = `generic`) fora das `recent` (últimos `FILLER_RECENT_WINDOW` índices usados);
 * sem candidata → as `generic` fora das recentes → qualquer frase fora das recentes → a usada há
 * mais tempo entre as do contexto. Sorteio uniforme via `rng` (1 chamada). Pool vazio → null.
 */
export function pickFillerPhrase(
  pool: readonly FillerPhrase[],
  ctx: FillerContext,
  recent: readonly number[],
  rng: () => number = Math.random
): number | null {
  if (!pool.length) return null
  const window = recent.slice(-FILLER_RECENT_WINDOW)
  const fits = (i: number, c: FillerContext): boolean => {
    const cs = pool[i].contexts.length ? pool[i].contexts : (['generic'] as FillerContext[])
    return cs.includes(c)
  }
  // frase SÓ de pergunta ("Boa pergunta, deixa eu pensar.") nunca sai sem uma pergunta na
  // transcrição — nem como último recurso
  const questionOnly = (i: number): boolean =>
    pool[i].contexts.length > 0 && pool[i].contexts.every((c) => c === 'question')
  const all = pool.map((_, i) => i).filter((i) => ctx === 'question' || !questionOnly(i))
  if (!all.length) return null
  const fresh = (xs: number[]): number[] => xs.filter((i) => !window.includes(i))
  let cands = fresh(all.filter((i) => fits(i, ctx)))
  if (!cands.length && ctx !== 'generic') cands = fresh(all.filter((i) => fits(i, 'generic')))
  if (!cands.length) cands = fresh(all)
  if (!cands.length) {
    // tudo recente (pool pequeno): a do contexto usada há mais tempo
    const ofCtx = all.filter((i) => fits(i, ctx))
    const pickFrom = ofCtx.length ? ofCtx : all
    return pickFrom.reduce((best, i) => (window.indexOf(i) < window.indexOf(best) ? i : best))
  }
  let r = typeof rng === 'function' ? Number(rng()) : NaN
  if (!Number.isFinite(r)) r = Math.random()
  const k = Math.min(
    cands.length - 1,
    Math.floor(Math.min(Math.max(r, 0), 0.999999999) * cands.length)
  )
  return cands[k]
}

/** A fala é curta demais para preâmbulo (menos de `FILLER_MIN_WORDS` palavras e não é pergunta)? */
export function fillerTooShort(text: string): boolean {
  const t = String(text ?? '').trim()
  return wordCount(t) < FILLER_MIN_WORDS && !isQuestionLike(t)
}

/**
 * A fala teve menos VOZ que o mínimo do preâmbulo (`FILLER_MIN_SPEECH_MS`)? `voicedMs` = tempo
 * com voz da fala (do 1º ao último quadro acima do limiar — `VoicedSpan.spanMs`), SEM o silêncio
 * antes/depois nem a espera do fim de turno; null = desconhecido (mensagem digitada, renderer
 * antigo) → não barra.
 */
export function fillerBelowMinSpeech(
  voicedMs: number | null | undefined,
  minSpeechMs: number = FILLER_MIN_SPEECH_MS
): boolean {
  if (typeof voicedMs !== 'number' || !Number.isFinite(voicedMs)) return false
  const min = Number.isFinite(minSpeechMs) && minSpeechMs > 0 ? minSpeechMs : 0
  return voicedMs < min
}

/**
 * Tempo com VOZ de uma fala (renderer — quadros RMS da captura): `spanMs` = do início do 1º quadro
 * acima do limiar ao fim do último (as pausas internas contam — é a duração da fala), sem o
 * silêncio antes do 1º nem depois do último quadro com voz (o silêncio que fecha o turno, a espera
 * do veredito/da transcrição); `voicedMs` = só os quadros com voz.
 */
export class VoicedSpan {
  #elapsed = 0
  #first: number | null = null
  #lastEnd = 0
  #voiced = 0

  /** Duração da fala (1º → último quadro com voz, ms; 0 sem voz). */
  get spanMs(): number {
    return this.#first == null ? 0 : Math.max(0, this.#lastEnd - this.#first)
  }

  /** Soma dos quadros com voz (ms). */
  get voicedMs(): number {
    return this.#voiced
  }

  push(rms: number, frameMs: number, threshold: number): void {
    const dt = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0
    if (rms >= threshold) {
      if (this.#first == null) this.#first = this.#elapsed
      this.#voiced += dt
      this.#lastEnd = this.#elapsed + dt
    }
    this.#elapsed += dt
  }

  reset(): void {
    this.#elapsed = 0
    this.#first = null
    this.#lastEnd = 0
    this.#voiced = 0
  }
}

// ---------------- frases de ferramenta (SPEC → "Frases de ferramenta") ----------------

/**
 * Preâmbulo que já tocou: a frase de ferramenta só sai se ele terminou há pelo menos isto (ms) —
 * senão as duas emendariam ("Hum, deixa eu ver." + "Vou pesquisar isso.").
 */
export const TOOL_PHRASE_AFTER_PREAMBLE_MS = 3000
/** A frase de ferramenta não repete nenhuma das últimas N usadas. */
export const TOOL_PHRASE_RECENT_WINDOW = 3

/**
 * Tools sem frase: a própria tool já é a fala/interação (despedida, pergunta na tela) ou é
 * instantânea e não é "o trabalho" do turno — `search_tool` (só lê a definição de uma tool
 * compactada, 1.11.0: a frase fica para a tool de verdade que vem depois) e `datetime`.
 */
const TOOLS_WITHOUT_PHRASE = new Set(['end_call', 'ask_user', 'search_tool', 'datetime'])

/**
 * Categoria da frase de uma tool (null = tool sem frase — `end_call`, `ask_user`, `search_tool`,
 * `datetime`). Tools do celular
 * (`get_location`, `nearby_places`) caem em `location`; desconhecidas, em `generic`.
 */
export function toolPhraseCategory(toolName: string): ToolPhraseCategory | null {
  const n = String(toolName ?? '').trim()
  if (TOOLS_WITHOUT_PHRASE.has(n)) return null
  if (n === 'web_search' || n === 'browse_url') return 'web'
  if (
    /^(list_dir|read_file|search_files|find_files|present_file|write_file|edit_file)$/.test(n) ||
    /^fs_/.test(n)
  )
    return 'files'
  if (n === 'shell' || /^process_/.test(n)) return 'shell'
  if (/^memory_/.test(n)) return 'memory'
  if (
    /^(delegate_task|send_to_chat|check_subagents|wait_subagents|cancel_subagent|message_subagent)$/.test(
      n
    )
  )
    return 'agents'
  if (
    /^(list_models|get_chat_info|list_chats|read_history|list_skills|skill_load|skill_read)$/.test(
      n
    )
  )
    return 'info'
  if (n === 'get_location' || n === 'nearby_places') return 'location'
  return 'generic'
}

/**
 * Escolhe a frase (índice no pool) para a categoria: as da categoria fora das últimas
 * `TOOL_PHRASE_RECENT_WINDOW`; sem candidata → as genéricas fora das recentes → qualquer da
 * categoria (a usada há mais tempo) → qualquer genérica. Sorteio via `rng` (1 chamada). null = nada.
 */
export function pickToolPhrase(
  pool: readonly ToolPhrase[],
  category: ToolPhraseCategory,
  recent: readonly number[],
  rng: () => number = Math.random
): number | null {
  if (!pool.length) return null
  const window = recent.slice(-TOOL_PHRASE_RECENT_WINDOW)
  const of = (c: ToolPhraseCategory): number[] =>
    pool
      .map((_, i) => i)
      .filter((i) => (pool[i].categories.length ? pool[i].categories : ['generic']).includes(c))
  const fresh = (xs: number[]): number[] => xs.filter((i) => !window.includes(i))
  let cands = fresh(of(category))
  if (!cands.length && category !== 'generic') cands = fresh(of('generic'))
  if (!cands.length) {
    const fallback = of(category).length ? of(category) : of('generic')
    if (!fallback.length) return null
    return fallback.reduce((best, i) => (window.indexOf(i) < window.indexOf(best) ? i : best))
  }
  let r = typeof rng === 'function' ? Number(rng()) : NaN
  if (!Number.isFinite(r)) r = Math.random()
  const k = Math.min(
    cands.length - 1,
    Math.floor(Math.min(Math.max(r, 0), 0.999999999) * cands.length)
  )
  return cands[k]
}

/** Por que a frase de ferramenta NÃO sai (null = sai). */
export type ToolPhraseSkip =
  | 'disabled'
  | 'no-phrase'
  | 'announced'
  | 'hangup'
  | 'user-speaking'
  | 'clip-playing'
  | 'after-preamble'
  | 'assistant-audio'

/**
 * Regras da frase da 1ª tool do turno (a função é pura; quem chama garante "só a 1ª"): desligada;
 * tool sem frase; o assistente já falou/cortou uma frase da resposta neste turno (ele mesmo anunciou
 * a tool); desligamento armado; o usuário falando; uma frase curta tocando agora; o preâmbulo
 * terminou há menos de `TOOL_PHRASE_AFTER_PREAMBLE_MS`; outro áudio do assistente tocando.
 */
export function toolPhraseSkipReason(input: {
  enabled: boolean
  category: ToolPhraseCategory | null
  answerStarted: boolean
  hangup: boolean
  userSpeaking: boolean
  shortPlaying: boolean
  preambleEndedAt: number | null
  playbackActive: boolean
  now: number
}): ToolPhraseSkip | null {
  if (!input.enabled) return 'disabled'
  if (!input.category) return 'no-phrase'
  if (input.answerStarted) return 'announced'
  if (input.hangup) return 'hangup'
  if (input.userSpeaking) return 'user-speaking'
  if (input.shortPlaying) return 'clip-playing'
  if (
    input.preambleEndedAt != null &&
    input.now - input.preambleEndedAt < TOOL_PHRASE_AFTER_PREAMBLE_MS
  )
    return 'after-preamble'
  if (input.playbackActive) return 'assistant-audio'
  return null
}

// ---------------- frases de espera ("manter viva" + "obrigado por aguardar" — SPEC → "Frases de demora") ----------------

/** No máximo N frases "manter viva" FALADAS por turno (as puladas não contam). */
export const KEEPALIVE_MAX_PER_TURN = 2
/** Frase de espera não repete nenhuma das últimas N do mesmo pool (limitado a pool − 1). */
export const DELAY_RECENT_WINDOW = 2

/** Estado das frases de espera no turno em andamento (o `VoiceCallManager` guarda). */
export interface DelayPhraseState {
  /** Turno disparado em (ms); null = desarmado (sem turno esperando resposta). */
  turnStartedAt: number | null
  /**
   * Desde quando NADA se ouve (ms): o fim da última fala — o `playback-idle` depois do preâmbulo,
   * da frase de ferramenta, da "manter viva" anterior ou de uma frase da resposta — ou o envio do
   * turno. null = algo tocando/sintetizando para tocar, o usuário falando ou a espera pausada.
   */
  silentSince: number | null
  /** Frases "manter viva" FALADAS neste turno (emitidas para tocar). */
  keepAlives: number
  /** "Manter viva" faladas nesta ESPERA (desde a última frase da resposta) — o agradecimento exige ≥ 1. */
  waitKeepAlives: number
  /**
   * Fim da última frase curta tocada no turno (preâmbulo, frase de ferramenta, "manter viva",
   * agradecimento — o `playback-idle` depois dela; ms); null = nenhuma. O agradecimento conta daqui.
   */
  lastShortEndAt: number | null
  /** Uma frase da resposta já ficou pronta neste turno (informativo). */
  answerSpoken: boolean
  /** Há tool em execução agora (escolhe o pool da "manter viva": ferramenta × pensando). */
  toolsRunning: boolean
  /** O "obrigado por aguardar" já tocou neste turno (no máx. 1). */
  thanked: boolean
}

export const EMPTY_DELAY_STATE: DelayPhraseState = {
  turnStartedAt: null,
  silentSince: null,
  keepAlives: 0,
  waitKeepAlives: 0,
  lastShortEndAt: null,
  answerSpoken: false,
  toolsRunning: false,
  thanked: false
}

/**
 * Momento (ms) em que a próxima frase "manter viva" fica devida; null = nenhuma agora. Regra ÚNICA
 * (2026-11-12): `keepAliveAfterMs` de silêncio desde o fim da última fala (`silentSince`) — esse
 * silêncio É o espaçamento (sem cooldown/gap à parte) — enquanto a resposta não está sendo falada
 * (antes dela, com tool rodando e com o modelo pensando de novo depois da tool; quem chama bloqueia
 * quando a resposta está sintetizando/tocando, o usuário fala ou o desligamento foi armado), no
 * máx. `KEEPALIVE_MAX_PER_TURN` faladas por turno.
 */
export function keepAliveDueAt(
  s: DelayPhraseState,
  cfg: { enabled: boolean; keepAliveAfterMs: number }
): number | null {
  if (!cfg.enabled || s.turnStartedAt == null || s.silentSince == null) return null
  if (s.keepAlives >= KEEPALIVE_MAX_PER_TURN) return null
  const after =
    Number.isFinite(cfg.keepAliveAfterMs) && cfg.keepAliveAfterMs > 0 ? cfg.keepAliveAfterMs : 0
  return s.silentSince + after
}

/** Contexto da "manter viva": uma tool rodando (`tool`) ou o modelo pensando (`thinking`). */
export type KeepAliveContext = 'tool' | 'thinking'

export function keepAliveContext(s: Pick<DelayPhraseState, 'toolsRunning'>): KeepAliveContext {
  return s.toolsRunning ? 'tool' : 'thinking'
}

/** Por que o "obrigado por aguardar" NÃO toca antes da frase da resposta (null = toca). */
export type ThanksSkip = 'no-keepalive' | 'already' | 'too-soon' | 'not-ready'

/**
 * O "obrigado por aguardar" toca antes da frase da resposta que encerra a espera? Só se nesta espera
 * ao menos uma "manter viva" foi falada (`no-keepalive`), uma vez por turno (`already`), a última
 * frase de espera já TERMINOU há ≥ `thanksAfterMs` (`too-soon` — tocando agora ou recente: "falou
 * 'só mais um instante' há 2 s e a resposta chegou → não precisa") e ele já está PRONTO (`not-ready`
 * — clipe ou síntese em paralelo; a resposta nunca espera por ele).
 */
export function thanksSkipReason(input: {
  waitKeepAlives: number
  thanked: boolean
  ready: boolean
  /** Uma frase curta tocando agora (o fim dela ainda não chegou). */
  shortPlaying: boolean
  /** Fim da última frase de espera (ms); null = nenhuma terminou. */
  lastWaitEndAt: number | null
  now: number
  thanksAfterMs: number
}): ThanksSkip | null {
  if (!(input.waitKeepAlives > 0)) return 'no-keepalive'
  if (input.thanked) return 'already'
  if (
    input.shortPlaying ||
    input.lastWaitEndAt == null ||
    input.now - input.lastWaitEndAt < Math.max(0, input.thanksAfterMs)
  )
    return 'too-soon'
  if (!input.ready) return 'not-ready'
  return null
}

/**
 * Sorteia uma frase do pool (índice) sem repetir as últimas `DELAY_RECENT_WINDOW` (limitado a
 * pool − 1, para sempre sobrar candidata); pool vazio → null.
 */
export function pickDelayPhrase(
  pool: readonly string[],
  recent: readonly number[],
  rng: () => number = Math.random
): number | null {
  if (!pool.length) return null
  const n = Math.min(DELAY_RECENT_WINDOW, pool.length - 1)
  const window = n > 0 ? recent.slice(-n) : [] // slice(-0) devolveria tudo
  const cands = pool.map((_, i) => i).filter((i) => !window.includes(i))
  const list = cands.length ? cands : pool.map((_, i) => i)
  let r = typeof rng === 'function' ? Number(rng()) : NaN
  if (!Number.isFinite(r)) r = Math.random()
  const k = Math.min(
    list.length - 1,
    Math.floor(Math.min(Math.max(r, 0), 0.999999999) * list.length)
  )
  return list[k]
}

// ---------------- fala do usuário por cima da resposta (ducking × barge-in) ----------------

/** Por que a fala por cima da resposta virou barge-in. */
export type BargeInReason = 'voiced' | 'words' | 'stop-word'

/**
 * Resultado de um quadro/texto durante a fala por cima: `'duck'` (uma vez — a voz sustentada passou
 * do onset: o chamador ABAIXA o volume), `'barge-in'`, `'restore'` (o episódio fechou sem
 * confirmar — volume de volta se tinha abaixado) ou `'pending'`.
 */
export type DuckEvent = 'pending' | 'duck' | 'barge-in' | 'restore'

/**
 * Lacuna máxima (ms) DENTRO de uma sequência de voz para o onset do ducking: pausas curtas entre
 * sílabas/palavras não zeram a contagem; um silêncio maior que isto zera (rajadas separadas de
 * ruído não se somam).
 */
export const DUCK_ONSET_GAP_MS = 120

const foldWords = (text: string): string[] =>
  foldText(String(text ?? ''))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Palavras de parada explícita ("para", "espera"…) — o atalho do barge-in. */
const STOP_WORDS = new Set([
  'para',
  'pare',
  'parar',
  'paraai',
  'espera',
  'espere',
  'pera',
  'perai',
  'chega',
  'calma',
  'stop',
  'wait'
])
/** Complementos aceitos numa ordem de parada curta ("para aí", "espera um pouco", "para, por favor"). */
const STOP_FILLERS = new Set(['ai', 'ae', 'por', 'favor', 'um', 'pouco', 'so', 'ja', 'la'])

/**
 * Ordem de parada curta e explícita na transcrição parcial ("para", "pare!", "espera aí", "chega",
 * "peraí", "para, para") — até 4 palavras, a 1ª de parada e as demais de parada/complemento.
 * "para casa" NÃO é parada (a preposição seguida de conteúdo).
 */
export function isStopCommand(text: string): boolean {
  const w = foldWords(text)
  if (!w.length || w.length > 4 || !STOP_WORDS.has(w[0])) return false
  return w.every((x) => STOP_WORDS.has(x) || STOP_FILLERS.has(x))
}

/** Palavras "reais" da transcrição (fora o backchannel — "uhum", "aham", "sim", "tá", "ok"…). */
export function countRealWords(text: string): number {
  return foldWords(text).filter((x) => !isBackchannelText(x)).length
}

/**
 * Fala do usuário DURANTE a reprodução do assistente, com histerese em DOIS degraus (2026-11-12):
 * 1. **onset** — o volume só ABAIXA (`'duck'`, para `duckGain`; ele continua tocando) depois de
 *    `onsetMs` de voz SUSTENTADA acima do nível de ativação: lacunas ≤ `DUCK_ONSET_GAP_MS` dentro da
 *    sequência são toleradas, um silêncio maior zera a contagem — clique, pancada, tosse curta e
 *    ruído isolado nunca abaixam nada;
 * 2. **barge-in** — já abaixado, o usuário que insiste (`voicedMs` de voz no episódio, contados
 *    desde o início dele, ou `words` palavras reais / uma ordem de parada na transcrição parcial
 *    — `transcript`, que descarta alucinações do STT pelo filtro do portão de fala) para a
 *    resposta; a fala segue como o próximo turno. Nada disso vale antes do onset.
 * O que para antes (silêncio contínuo de `restoreMs`) fecha o episódio (`'restore'`: o volume volta
 * se tinha abaixado e o som é descartado — nenhum turno). Classe pura — `useVoiceCall` alimenta com
 * os quadros RMS e executa as ações (o mobile, com o player dele).
 */
export class PlaybackDuck {
  readonly cfg: Required<BargeInConfig>
  #open = false
  #ducked = false
  /** Voz no episódio (ms) — o barge-in conta daqui. */
  #voiced = 0
  /** Voz da sequência atual (ms) — o onset conta daqui. */
  #run = 0
  /** Silêncio desde o último quadro com voz (ms). */
  #quiet = 0
  #reason: BargeInReason | null = null

  constructor(cfg: Partial<BargeInConfig> = {}) {
    const ok = (v: unknown, def: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def
    this.cfg = {
      duckGain: Math.min(1, ok(cfg.duckGain, DEFAULT_BARGE_IN.duckGain)),
      voicedMs: ok(cfg.voicedMs, DEFAULT_BARGE_IN.voicedMs) || DEFAULT_BARGE_IN.voicedMs,
      words: Math.max(1, Math.round(ok(cfg.words, DEFAULT_BARGE_IN.words))),
      restoreMs: ok(cfg.restoreMs, DEFAULT_BARGE_IN.restoreMs) || DEFAULT_BARGE_IN.restoreMs,
      onsetMs: ok(cfg.onsetMs, DEFAULT_BARGE_IN.onsetMs)
    }
  }

  /** Há uma fala por cima em avaliação (o volume pode ainda não ter abaixado — ver `ducked`). */
  get open(): boolean {
    return this.#open
  }

  /** O volume do assistente foi abaixado neste episódio (a voz passou do onset). */
  get ducked(): boolean {
    return this.#ducked
  }

  /** Voz detectada no episódio (ms de quadros acima do limiar). */
  get voicedMs(): number {
    return this.#voiced
  }

  /** Por que virou barge-in (null = ainda não virou). */
  get reason(): BargeInReason | null {
    return this.#reason
  }

  /**
   * Abre o episódio (o quadro do início da fala já conta) SEM abaixar o volume — devolve o evento
   * do quadro (`'duck'` só com onset ≤ um quadro).
   */
  start(rms: number, frameMs: number, threshold: number): DuckEvent {
    this.#open = true
    this.#ducked = false
    this.#voiced = 0
    this.#run = 0
    this.#quiet = 0
    this.#reason = null
    return this.frame(rms, frameMs, threshold)
  }

  #commit(reason: BargeInReason): DuckEvent {
    if (this.#reason) return 'pending'
    this.#reason = reason
    this.#open = false
    return 'barge-in'
  }

  /**
   * Quadro durante o episódio: `'duck'` (uma vez) quando a sequência de voz chega ao onset;
   * `'barge-in'` (uma vez, só depois do onset) quando a voz do episódio passa de `voicedMs`;
   * `'restore'` quando o silêncio contínuo chega a `restoreMs` (o episódio fecha); senão
   * `'pending'`. Fechado → sempre `'pending'`.
   */
  frame(rms: number, frameMs: number, threshold: number): DuckEvent {
    if (!this.#open) return 'pending'
    const dt = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0
    if (rms >= threshold) {
      // pausa maior que a lacuna tolerada: a sequência recomeça (rajadas não se somam)
      if (this.#quiet > DUCK_ONSET_GAP_MS) this.#run = 0
      this.#quiet = 0
      this.#voiced += dt
      this.#run += dt
      if (!this.#ducked) {
        if (this.#run < this.cfg.onsetMs) return 'pending'
        this.#ducked = true
        return 'duck'
      }
      if (this.#voiced >= this.cfg.voicedMs) return this.#commit('voiced')
      return 'pending'
    }
    this.#quiet += dt
    if (this.#quiet >= this.cfg.restoreMs) {
      this.#open = false
      return 'restore'
    }
    return 'pending'
  }

  /**
   * Transcrição parcial/especulativa da fala do episódio — só depois do onset (antes, nem uma
   * palavra de ruído transcrita interrompe): alucinação conhecida do STT para a voz medida
   * (`filterSilenceHallucination`) não conta; ordem de parada → barge-in já (`'stop-word'`);
   * `words` palavras reais → barge-in (`'words'`). Fechado/não abaixado → `'pending'`.
   */
  transcript(text: string): DuckEvent {
    if (!this.#open || !this.#ducked) return 'pending'
    const real = filterSilenceHallucination(text, { voicedMs: this.#voiced, finalIsland: true })
    if (!real.trim()) return 'pending'
    if (isStopCommand(real)) return this.#commit('stop-word')
    if (countRealWords(real) >= this.cfg.words) return this.#commit('words')
    return 'pending'
  }

  /** Fecha o episódio sem classificar (mudo/parada da chamada/fim do turno). */
  reset(): void {
    this.#open = false
    this.#ducked = false
    this.#voiced = 0
    this.#run = 0
    this.#quiet = 0
    this.#reason = null
  }
}
