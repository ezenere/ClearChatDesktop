// Atos de fala curta da chamada de voz — política PURA (sem Electron/UI/IPC/fS): regras dos
// preâmbulos (fillers), das frases de demora e do backchannel × barge-in durante a reprodução,
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

// ---------------- constantes de tempo ----------------

/**
 * Espera padrão entre o turno enviado e o preâmbulo (ms): se a 1ª frase da resposta ficar pronta
 * antes disso, o preâmbulo nem sai (configurável em `voiceCallDefaults.fillers.delayMs`).
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
  /** Há tools em execução no turno (o espera costuma ser longa → filler já). */
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
 * O filler (preâmbulo) deste turno deve tocar AGORA? Regra v2 (por regra, sem classificador):
 * - no máximo 1 por turno (`usedThisTurn`) e NUNCA depois de a 1ª frase da resposta ficar pronta
 *   (`spokenThisTurn`) — resposta rápida dispensa o preâmbulo;
 * - com tools em execução, dispara já; senão após `delayMs` (0 = já; inválido/negativo → o padrão);
 * - só com resposta em voo e filler habilitado.
 */
export function fillerShouldFire(
  s: FillerState,
  now: number,
  delayMs: number = FILLER_DELAY_MS
): boolean {
  if (!s.enabled || s.usedThisTurn || s.spokenThisTurn || !s.responseInFlight) return false
  if (s.turnStartedAt == null) return false
  if (s.toolsRunning) return true
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

/** Tools sem frase (a própria tool já é a fala/interação: despedida, pergunta na tela). */
const TOOLS_WITHOUT_PHRASE = new Set(['end_call', 'ask_user'])

/**
 * Categoria da frase de uma tool (null = tool sem frase — `end_call`, `ask_user`). Tools do celular
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

// ---------------- frases de demora (sintetizadas ao vivo — SPEC → "Frases de demora") ----------------

/** No máximo N frases "manter viva" por turno. */
export const KEEPALIVE_MAX_PER_TURN = 2
/**
 * Intervalo mínimo entre duas frases "manter viva" (ms): do FIM da anterior (o `playback-idle`
 * depois dela — a latência da síntese e a duração do áudio não comem o intervalo) ao início da
 * seguinte.
 */
export const KEEPALIVE_COOLDOWN_MS = 15_000
/**
 * Regra global de espaçamento (ms): silêncio mínimo entre o FIM de qualquer frase curta (preâmbulo,
 * "manter viva" ou desculpa) e o INÍCIO da próxima "manter viva" ou desculpa. A "manter viva" espera;
 * a desculpa que violaria a regra é PULADA (nunca adiada — a resposta não espera por ela).
 */
export const DELAY_MIN_GAP_MS = 10_000
/** Frase de demora não repete nenhuma das últimas N do mesmo pool (limitado a pool − 1). */
export const DELAY_RECENT_WINDOW = 2

/** Estado das frases de demora no turno em andamento (o `VoiceCallManager` guarda). */
export interface DelayPhraseState {
  /** Turno disparado em (ms); null = desarmado (sem turno esperando resposta). */
  turnStartedAt: number | null
  /** Desde quando nada toca esperando a resposta (ms); null = algo audível agora. */
  silentSince: number | null
  /** Frases "manter viva" decididas neste turno. */
  keepAlives: number
  /**
   * Última "manter viva" (ms) — o cooldown conta daqui: o FIM da reprodução dela; enquanto ainda
   * não terminou (ou se foi pulada depois da síntese), o momento da decisão.
   */
  lastKeepAliveAt: number | null
  /**
   * Fim da última frase curta tocada no turno (preâmbulo, "manter viva" ou desculpa — o
   * `playback-idle` depois dela; ms); null = nenhuma. A regra de `DELAY_MIN_GAP_MS` conta daqui.
   */
  lastShortEndAt: number | null
  /** A 1ª frase da resposta já ficou pronta (a desculpa não sai mais). */
  answerSpoken: boolean
  /** Há tool em execução agora (depois da 1ª frase, só aí volta a "manter viva"). */
  toolsRunning: boolean
  /** A síntese da desculpa já foi pedida neste turno. */
  apologyStarted: boolean
}

export const EMPTY_DELAY_STATE: DelayPhraseState = {
  turnStartedAt: null,
  silentSince: null,
  keepAlives: 0,
  lastKeepAliveAt: null,
  lastShortEndAt: null,
  answerSpoken: false,
  toolsRunning: false,
  apologyStarted: false
}

/**
 * Momento (ms) em que a próxima frase "manter viva" fica devida; null = nenhuma neste turno (ou
 * enquanto algo toca). Regras: silêncio ≥ `keepAliveAfterMs` esperando a resposta — antes da 1ª
 * frase dela, ou depois dela só com tool rodando —, no máx. `KEEPALIVE_MAX_PER_TURN` por turno,
 * `KEEPALIVE_COOLDOWN_MS` desde o fim da anterior e `DELAY_MIN_GAP_MS` desde o fim de qualquer
 * frase curta (o preâmbulo inclusive).
 */
export function keepAliveDueAt(
  s: DelayPhraseState,
  cfg: { enabled: boolean; keepAliveAfterMs: number }
): number | null {
  if (!cfg.enabled || s.turnStartedAt == null || s.silentSince == null) return null
  if (s.keepAlives >= KEEPALIVE_MAX_PER_TURN) return null
  if (s.answerSpoken && !s.toolsRunning) return null
  let due = s.silentSince + Math.max(0, cfg.keepAliveAfterMs)
  if (s.lastKeepAliveAt != null) due = Math.max(due, s.lastKeepAliveAt + KEEPALIVE_COOLDOWN_MS)
  if (s.lastShortEndAt != null) due = Math.max(due, s.lastShortEndAt + DELAY_MIN_GAP_MS)
  return due
}

/** Momento (ms) em que a síntese da desculpa começa; null = não neste turno. */
export function apologyDueAt(
  s: DelayPhraseState,
  cfg: { enabled: boolean; apologyAfterMs: number }
): number | null {
  if (!cfg.enabled || s.turnStartedAt == null || s.answerSpoken || s.apologyStarted) return null
  return s.turnStartedAt + Math.max(0, cfg.apologyAfterMs)
}

/** Por que a desculpa pronta NÃO toca antes da 1ª frase (null = toca). */
export type ApologySkip = 'not-ready' | 'keepalive-playing' | 'clip-playing' | 'too-soon'

/**
 * A desculpa toca antes da 1ª frase da resposta? Só pronta (nunca se espera a síntese dela), sem
 * frase "manter viva" nem outro clipe tocando (a resposta já vai esperar ele terminar) e com pelo
 * menos `DELAY_MIN_GAP_MS` desde o FIM da última frase curta (`lastShortEndAt` — preâmbulo,
 * "manter viva"). Violaria a regra → pulada, nunca adiada.
 */
export function apologySkipReason(input: {
  ready: boolean
  now: number
  keepAlivePlaying: boolean
  lastShortEndAt: number | null
  clipPlaying: boolean
}): ApologySkip | null {
  if (!input.ready) return 'not-ready'
  if (input.keepAlivePlaying) return 'keepalive-playing'
  if (input.clipPlaying) return 'clip-playing'
  if (input.lastShortEndAt != null && input.now - input.lastShortEndAt < DELAY_MIN_GAP_MS)
    return 'too-soon'
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

/** Resultado de um quadro/texto durante o ducking. */
export type DuckEvent = 'pending' | 'barge-in' | 'restore'

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
 * Fala do usuário DURANTE a reprodução do assistente, com histerese ("ducking"): ao começar, o
 * chamador ABAIXA o áudio do assistente para `duckGain` (ele continua tocando); o usuário que
 * insiste — `voicedMs` de voz no episódio, ou `words` palavras reais / uma ordem de parada na
 * transcrição parcial (`transcript`) — vira **barge-in** (o chamador para a resposta; a fala segue
 * como o próximo turno); o que para antes (tosse, "uhum", ruído, palavra curta) devolve o volume
 * depois de `restoreMs` de silêncio e o som é descartado (nenhum turno). Classe pura — `useVoiceCall`
 * alimenta com os quadros RMS e executa as ações (o mobile, com o player dele).
 */
export class PlaybackDuck {
  readonly cfg: BargeInConfig
  #open = false
  #voiced = 0
  #quiet = 0
  #reason: BargeInReason | null = null

  constructor(cfg: Partial<BargeInConfig> = {}) {
    const ok = (v: unknown, def: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def
    this.cfg = {
      duckGain: Math.min(1, ok(cfg.duckGain, DEFAULT_BARGE_IN.duckGain)),
      voicedMs: ok(cfg.voicedMs, DEFAULT_BARGE_IN.voicedMs) || DEFAULT_BARGE_IN.voicedMs,
      words: Math.max(1, Math.round(ok(cfg.words, DEFAULT_BARGE_IN.words))),
      restoreMs: ok(cfg.restoreMs, DEFAULT_BARGE_IN.restoreMs) || DEFAULT_BARGE_IN.restoreMs
    }
  }

  /** Há uma fala por cima em avaliação (áudio do assistente abaixado). */
  get open(): boolean {
    return this.#open
  }

  /** Voz detectada no episódio (ms de quadros acima do limiar). */
  get voicedMs(): number {
    return this.#voiced
  }

  /** Por que virou barge-in (null = ainda não virou). */
  get reason(): BargeInReason | null {
    return this.#reason
  }

  /** Abre o episódio (o quadro do início da fala já conta) — o chamador abaixa o volume. */
  start(rms: number, frameMs: number, threshold: number): void {
    this.#open = true
    this.#voiced = 0
    this.#quiet = 0
    this.#reason = null
    this.frame(rms, frameMs, threshold)
  }

  #commit(reason: BargeInReason): DuckEvent {
    if (this.#reason) return 'pending'
    this.#reason = reason
    this.#open = false
    return 'barge-in'
  }

  /**
   * Quadro durante o episódio: `'barge-in'` (uma vez) quando a voz passa de `voicedMs`;
   * `'restore'` quando o silêncio contínuo chega a `restoreMs` (o episódio fecha — volume de volta,
   * som descartado); senão `'pending'`. Fechado → sempre `'pending'`.
   */
  frame(rms: number, frameMs: number, threshold: number): DuckEvent {
    if (!this.#open) return 'pending'
    const dt = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0
    if (rms >= threshold) {
      this.#voiced += dt
      this.#quiet = 0
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
   * Transcrição parcial/especulativa da fala do episódio: ordem de parada → barge-in já
   * (`'stop-word'`); `words` palavras reais → barge-in (`'words'`). Fechado → `'pending'`.
   */
  transcript(text: string): DuckEvent {
    if (!this.#open) return 'pending'
    if (isStopCommand(text)) return this.#commit('stop-word')
    if (countRealWords(text) >= this.cfg.words) return this.#commit('words')
    return 'pending'
  }

  /** Fecha o episódio sem classificar (mudo/parada da chamada/fim do turno). */
  reset(): void {
    this.#open = false
    this.#voiced = 0
    this.#quiet = 0
    this.#reason = null
  }
}
