// "O que foi ouvido" de uma frase falada na chamada, em PALAVRAS (PURO — main, renderer e o mobile):
// dado o quanto da utterance tocou (`playedMs`, do player no barge-in ou ao vivo), quantos
// caracteres do texto dela o usuário ouviu. Dois modos, numa função só (`heardChars`):
// - **exact**: o motor deu o início de cada unidade de fala (letra/dígito) no áudio — o alinhamento
//   do WebSocket da ElevenLabs (`AlignedPcmSegmenter.unitStartsMs`);
// - **estimated**: os demais (OpenAI-compatível `/audio/speech`, OpenRouter, Kokoro, GPU, REST da
//   ElevenLabs) — proporcional à duração do áudio pelos caracteres falados (markdown não conta;
//   pontuação pesa uma pausa); duração ainda desconhecida (stream chegando) → ~70 ms por letra.
// Os dois são CONSERVADORES: descontam `HEARD_SAFETY_MS` e arredondam para BAIXO até o fim da
// palavra anterior (nunca meia palavra; nunca dentro de uma tag de voz). Ver SPEC.md → "Barge-in em
// palavras".
import { audioTagRe } from './audioTags'

/** Desconto (ms) antes de mapear — o usuário que interrompe não "ouviu" o último instante. */
export const HEARD_SAFETY_MS = 150
/** ms de áudio por unidade de fala quando a duração ainda não é conhecida (pt-BR, ~70 ms). */
export const EST_MS_PER_UNIT = 70

export type HeardMode = 'exact' | 'estimated'

export interface UtteranceTiming {
  /** Duração total do áudio da utterance (ms); null/ausente = desconhecida (ainda chegando). */
  durationMs?: number | null
  /**
   * Início (ms, relativo ao começo da utterance) de cada unidade de fala (letra/dígito) do texto,
   * na ordem — alinhamento EXATO do motor; null/ausente/vazio = estimativa.
   */
  unitStartsMs?: readonly number[] | null
}

const UNIT = /[\p{L}\p{N}]/u
const WORD = /[\p{L}\p{N}'’_-]/u

/** Peso de fala de um caractere (estimativa): letra 1, pausas pela pontuação, markdown 0. */
function weightOf(c: string): number {
  if (UNIT.test(c)) return 1
  if (/[.!?…]/.test(c)) return 5
  if (/[,;:]/.test(c)) return 3
  if (/\s/.test(c)) return 0.6
  if (/[*_`#~>|]/.test(c)) return 0
  return 0.3
}

/** Trechos `[início, fim)` das tags de voz do texto. */
function tagSpans(text: string): [number, number][] {
  return [...text.matchAll(audioTagRe())].map((m) => [m.index, m.index + m[0].length])
}

/** Arredonda o índice para BAIXO até o fim da palavra anterior (fora de tags); sem espaço no fim. */
function roundDownToWord(text: string, index: number): number {
  let i = Math.max(0, Math.min(text.length, Math.floor(index)))
  if (i >= text.length) return text.trimEnd().length
  for (const [a, b] of tagSpans(text)) if (i > a && i < b) i = a
  // no meio de uma palavra → volta ao começo dela
  if (i > 0 && WORD.test(text[i]) && WORD.test(text[i - 1]))
    while (i > 0 && WORD.test(text[i - 1])) i--
  return text.slice(0, i).trimEnd().length
}

/** Índice no texto logo depois da k-ésima unidade de fala (k ≥ 1); 0 com k ≤ 0. */
function indexAfterUnits(text: string, k: number): number {
  if (k <= 0) return 0
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (UNIT.test(text[i]) && ++n === k) return i + 1
  }
  return text.length
}

/**
 * Quantos caracteres de `text` foram OUVIDOS depois de `playedMs` de áudio da utterance (prefixo
 * `text.slice(0, chars)`, já sem espaço no fim, terminando numa fronteira de palavra). Tocou tudo
 * (`playedMs ≥ durationMs`) → o texto inteiro.
 */
export function heardChars(
  text: string,
  playedMs: number,
  timing: UtteranceTiming = {}
): { chars: number; mode: HeardMode } {
  const t0 = String(text ?? '')
  const units = timing.unitStartsMs?.filter((x) => Number.isFinite(x)) ?? []
  const mode: HeardMode = units.length ? 'exact' : 'estimated'
  const played = Number.isFinite(playedMs) ? Math.max(0, playedMs) : 0
  const dur =
    typeof timing.durationMs === 'number' &&
    Number.isFinite(timing.durationMs) &&
    timing.durationMs > 0
      ? timing.durationMs
      : null
  if (dur != null && played >= dur) return { chars: t0.trimEnd().length, mode }
  const t = played - HEARD_SAFETY_MS
  if (t <= 0 || !t0) return { chars: 0, mode }
  if (mode === 'exact') {
    // unidade ouvida = a seguinte já começou até `t` (a última: começou há um "tempo de letra")
    let k = 0
    for (let j = 0; j < units.length; j++) {
      const end = j + 1 < units.length ? units[j + 1] : units[j] + EST_MS_PER_UNIT
      if (end <= t) k = j + 1
      else break
    }
    return { chars: roundDownToWord(t0, indexAfterUnits(t0, k)), mode }
  }
  const weights = [...t0].map(weightOf)
  const total = weights.reduce((a, w) => a + w, 0)
  if (!total) return { chars: 0, mode }
  const pos = dur != null ? (t / dur) * total : t / EST_MS_PER_UNIT
  let acc = 0
  let idx = 0
  const chars = [...t0]
  let off = 0
  for (; idx < chars.length; idx++) {
    if (acc + weights[idx] > pos) break
    acc += weights[idx]
    off += chars[idx].length
  }
  return { chars: roundDownToWord(t0, off), mode }
}

/**
 * Prefixo OUVIDO do texto original de uma frase: o mapeamento roda sobre o texto que foi à síntese
 * (`speech` — sem as tags de voz quando a voz não as interpreta) e volta ao original contando as
 * letras/dígitos (as das tags removidas não contam), arredondado para baixo na palavra. '' = nada.
 */
export function heardPrefix(
  original: string,
  speech: string,
  playedMs: number,
  timing: UtteranceTiming = {}
): { text: string; mode: HeardMode } {
  const { chars, mode } = heardChars(speech, playedMs, timing)
  if (chars >= speech.trimEnd().length) return { text: original.trimEnd(), mode }
  if (original === speech) return { text: original.slice(0, chars), mode }
  let k = 0
  for (const c of speech.slice(0, chars)) if (UNIT.test(c)) k++
  const spans = tagSpans(original)
  let n = 0
  let idx = 0
  for (let i = 0; i < original.length && n < k; i++) {
    const span = spans.find(([a, b]) => i >= a && i < b)
    if (span) {
      i = span[1] - 1
      continue
    }
    if (UNIT.test(original[i]) && ++n === k) idx = i + 1
  }
  return { text: original.slice(0, roundDownToWord(original, idx)), mode }
}

/**
 * Leitura ao vivo: offset em `content` (a mensagem do assistente) a partir do qual o texto AINDA não
 * foi falado — as frases já tocadas (`heard`, na ordem) e a atual (`current` com `chars` ouvidos)
 * procuradas em sequência. null = a frase atual não está nesta mensagem (não é ela que está sendo
 * falada) ou nada a esmaecer.
 */
export function liveDimFrom(
  content: string,
  heard: readonly string[],
  current: { text: string; chars: number } | null
): number | null {
  if (!current || !current.text.trim()) return null
  let cursor = 0
  for (const s of heard) {
    const at = content.indexOf(s.trim(), cursor)
    if (at >= 0) cursor = at + s.trim().length
  }
  const at = content.indexOf(current.text.trim(), cursor)
  if (at < 0) return null
  const from = at + Math.max(0, Math.min(current.chars, current.text.trim().length))
  return from >= content.trimEnd().length ? null : from
}
