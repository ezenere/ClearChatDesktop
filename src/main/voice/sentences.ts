// Corte de sentenças para o TTS por sentença da chamada de voz (função pura, sem Electron):
// `splitSentences` separa as sentenças COMPLETAS de um buffer de texto e devolve o resto ainda
// incompleto. O gestor da chamada (`voice/call.ts`) acumula o texto em streaming e corta uma
// sentença por vez, sintetizando cada uma inteira (sem streaming de áudio por tokens).
//
// Regras (testadas em `e2e/voiceCall.test.ts`):
// - fronteira = marca final `[.!?…]` (+ marcas repetidas `?!`) seguida de fechos opcionais
//   (`"»')]}` …) e então espaço/quebra de linha — ou o FIM do buffer quando `final: true`
//   (flush do fim da resposta; em streaming o fim do buffer pode continuar "Dr. Silva");
// - `.` NÃO corta: entre dígitos (decimal "3.14"), quando o trecho desde a última fronteira é só
//   um número ("1." de lista) ou quando a última palavra é uma abreviação pt-BR comum ("ex.",
//   "etc.", "Dr.", "p.ex."…) — exceto no fim do buffer com `final: true` (é o fim da resposta);
//   meses e dias da semana ("mar.", "set.", "out.", "ter.", "dom."…) também são palavras comuns
//   ("o mar.", "vai ter."): só valem como abreviação num contexto de DATA (número antes — "15
//   mar." —, número/ano depois — "mar. 2026", "mar. de 2026" — ou faixa "seg. a sex."); em
//   streaming, sem o texto seguinte ainda, o corte espera o próximo pedaço;
// - sem fronteira há muito tempo: corte forçado no último espaço antes de `maxChars` (padrão 240)
//   — resposta sem pontuação nunca espera o fim inteiro para começar a falar;
// - `commaCutMin` (1º pedaço da resposta): vírgula + espaço depois de ≥ N chars também corta — o
//   TTS começa a falar antes (a 1ª frase longa vira duas utterances);
// - **tags de voz** (`@shared/audioTags` — "[laughs]", "[nervous, whispering]"): nunca há corte
//   DENTRO dos colchetes (marca, vírgula nem corte forçado — inclusive com a tag ainda chegando no
//   streaming); uma tag que sobra sozinha entre sentenças vai para o começo da seguinte (ela modula
//   o que vem depois) ou, no fim da resposta, para o fim da anterior — nunca vira uma utterance.
import { audioTagRe, isOnlyAudioTags } from '@shared/audioTags'

export interface SentenceSplit {
  /** Sentenças completas, na ordem, já aparadas (uma por utterance do TTS). */
  sentences: string[]
  /** Trecho final ainda sem fronteira (acumular com o próximo delta). */
  rest: string
}

export const DEFAULT_SENTENCE_MAX_CHARS = 240

/** Mínimo de chars do 1º pedaço da resposta para a vírgula cortar (TTS começa antes). */
export const FIRST_CHUNK_COMMA_MIN = 25

/** Abreviações pt-BR comuns (minúsculas, sem o ponto final) — o `.` delas não corta sentença. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'ex',
  'exs',
  'etc',
  'p.ex',
  'p.exs',
  'p',
  'n',
  'núm',
  'dr',
  'dra',
  'sr',
  'sra',
  'srta',
  'prof',
  'profa',
  'eng',
  'av',
  'pe',
  'tel',
  'ed',
  'op',
  'cf',
  'ca',
  'cia',
  'ltda',
  'vs',
  'a.c',
  'd.c'
])

/**
 * Abreviações de dia da semana e de mês — várias são palavras comuns ("mar", "set", "out", "ter",
 * "dom", "sex"): só não cortam num contexto de data (`dateContext`).
 */
const DATE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'seg',
  'ter',
  'qua',
  'qui',
  'sex',
  'sáb',
  'sab',
  'dom',
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez'
])
const DATE_ABBR_RE =
  '(?:seg|ter|qua|qui|sex|s[áa]b|dom|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)'
/** Conectores de uma faixa de datas ("seg. a sex.", "jan.–mar.", "seg., qua. e sex."). */
const RANGE_RE = '(?:a|à|e|até|-|–|—|,)'
/** 2º item de uma faixa ("seg. a sex.": o trecho antes de "sex" termina em "seg. a "). */
const RANGE_BEFORE = new RegExp(
  String.raw`(?:^|[^\p{L}])${DATE_ABBR_RE}\.?\s*${RANGE_RE}\s*$`,
  'iu'
)
/** 1º item de uma faixa ("seg. a sex.": depois do ponto de "seg" vem " a sex"). */
const RANGE_AFTER = new RegExp(String.raw`^\s*${RANGE_RE}\s*${DATE_ABBR_RE}(?!\p{L})`, 'iu')

/**
 * O `.` de um mês/dia abreviado está num contexto de data? `before` = o trecho antes da
 * abreviação; `after` = o texto depois do ponto. 'unknown' = só espaço depois (o resto ainda não
 * chegou no streaming).
 */
function dateContext(before: string, after: string): 'date' | 'word' | 'unknown' {
  // número antes: "15 mar.", "15 de mar.", "1º set.", "15/mar."
  if (/\d{1,2}[ºª]?\s*(?:de\s+)?$/i.test(before) || /\d{1,2}\s*[/-]\s*$/.test(before)) return 'date'
  // 2º item de uma faixa: "seg. a sex.", "jan.–mar."
  if (RANGE_BEFORE.test(before)) return 'date'
  if (!after.trim()) return 'unknown'
  // número/ano depois: "mar. 2026", "mar. de 2026", "seg. 15/03"
  if (/^\s*(?:de\s+)?\d/i.test(after)) return 'date'
  // 1º item de uma faixa: "seg. a sex."
  if (RANGE_AFTER.test(after)) return 'date'
  return 'word'
}

const MARKS = '.!?…'
/** Fechos que podem vir depois da marca antes do espaço: `."`, `?)`, `]`… */
const CLOSERS = '"\'»”’)]}'

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isMark = (c: string): boolean => MARKS.includes(c)
const isCloser = (c: string): boolean => CLOSERS.includes(c)

/** Última "palavra" (letras/pontos internos) do trecho — para a checagem de abreviação. */
function trailingToken(seg: string): string {
  const m = seg.match(/[\p{L}.]+$/u)
  return m ? m[0].toLowerCase() : ''
}

/**
 * `.` na posição `i` é fronteira? (decimais, marcadores de lista e abreviações não cortam).
 * `atEnd` (fim do buffer com `final: true`) corta SEMPRE — no fim da resposta "Etc." é o fim.
 */
function dotCuts(
  buffer: string,
  i: number,
  segStart: number,
  atEnd: boolean,
  final: boolean
): boolean {
  if (atEnd && final) return true
  if (i > 0 && isDigit(buffer[i - 1]) && i + 1 < buffer.length && isDigit(buffer[i + 1]))
    return false
  const seg = buffer.slice(segStart, i)
  if (/^\d+$/.test(seg.trim())) return false // "1." / "2." de lista numerada
  const token = trailingToken(seg)
  if (token && ABBREVIATIONS.has(token)) return false
  if (token && DATE_ABBREVIATIONS.has(token)) {
    const ctx = dateContext(seg.slice(0, seg.length - token.length), buffer.slice(i + 1))
    // data → não corta; sem o texto seguinte ainda (streaming) → espera o próximo pedaço
    if (ctx === 'date' || (ctx === 'unknown' && !final)) return false
  }
  return true
}

/**
 * Trechos de `buffer` dentro de tags de voz (`[início, fim)`) — inclusive uma tag ainda aberta no fim
 * do buffer (streaming: o "]" ainda não chegou), desde que curta o bastante para ser uma tag.
 */
function tagSpans(buffer: string): [number, number][] {
  const spans: [number, number][] = []
  for (const m of buffer.matchAll(audioTagRe())) spans.push([m.index, m.index + m[0].length])
  const open = buffer.lastIndexOf('[')
  if (
    open >= 0 &&
    buffer.indexOf(']', open) < 0 &&
    buffer.length - open <= 42 &&
    /^\[\p{L}?[\p{L} ,.!?'’-]*$/u.test(buffer.slice(open))
  )
    spans.push([open, buffer.length])
  return spans
}

/**
 * Corta as sentenças completas de `buffer`. `final: true` trata o fim do buffer como fronteira
 * (flush do fim da resposta); `maxChars` limita o `rest` acumulado (corte forçado em espaço).
 * `rest` volta sem espaço à esquerda (o que vem depois de um corte é início de sentença).
 */
export function splitSentences(
  buffer: string,
  opts: { final?: boolean; maxChars?: number; commaCutMin?: number } = {}
): SentenceSplit {
  const split = splitRaw(buffer, opts)
  return attachLoneTags(split, !!opts.final)
}

/**
 * Tag de voz sozinha entre as sentenças vai para o começo da seguinte; no fim: com `final`, para o
 * fim da anterior (sem anterior, sai — uma tag sozinha nunca vira utterance); em streaming, volta ao
 * `rest` (espera o texto que ela modula).
 */
function attachLoneTags(split: SentenceSplit, final: boolean): SentenceSplit {
  const out: string[] = []
  let carry = ''
  for (const s of split.sentences) {
    if (isOnlyAudioTags(s)) {
      carry = carry ? `${carry} ${s}` : s
      continue
    }
    out.push(carry ? `${carry} ${s}` : s)
    carry = ''
  }
  let rest = split.rest
  // streaming: resto que é só tag (ou uma tag ainda chegando) segura a última sentença — se nada
  // vier depois, no fim a tag fecha a frase anterior em vez de sobrar sozinha
  if (!final && out.length && (isOnlyAudioTags(rest) || /^\s*\[[^\]]*$/.test(rest)) && !carry) {
    rest = `${out.pop()} ${rest.trim()}`
    return { sentences: out, rest }
  }
  // no fim da resposta, o resto que é só tag ("Isso é ótimo. [sighs]") fecha a sentença anterior
  if (final && isOnlyAudioTags(rest)) {
    carry = carry ? `${carry} ${rest.trim()}` : rest.trim()
    rest = ''
  }
  if (carry) {
    if (!final) rest = rest ? `${carry} ${rest}` : carry
    else if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${carry}`
  }
  return { sentences: out, rest }
}

function splitRaw(
  buffer: string,
  opts: { final?: boolean; maxChars?: number; commaCutMin?: number }
): SentenceSplit {
  const spans = tagSpans(buffer)
  const inTag = (k: number): boolean => spans.some(([a, b]) => k > a && k < b)
  const commaMin =
    typeof opts.commaCutMin === 'number' && opts.commaCutMin > 0 ? opts.commaCutMin : 0
  const maxChars =
    typeof opts.maxChars === 'number' && opts.maxChars > 0
      ? Math.round(opts.maxChars)
      : DEFAULT_SENTENCE_MAX_CHARS
  const sentences: string[] = []
  let segStart = 0
  let i = 0
  while (i < buffer.length) {
    // 1º pedaço: vírgula seguida de espaço depois de ≥ commaMin chars também é fronteira
    if (
      commaMin &&
      !sentences.length &&
      buffer[i] === ',' &&
      !inTag(i) &&
      i + 1 < buffer.length &&
      /\s/.test(buffer[i + 1]) &&
      buffer.slice(segStart, i).trim().length >= commaMin
    ) {
      const chunk = buffer.slice(segStart, i + 1).trim()
      if (chunk) sentences.push(chunk)
      segStart = i + 1
      i = i + 1
      continue
    }
    if (!isMark(buffer[i]) || inTag(i)) {
      i++
      continue
    }
    // marca (+ marcas repetidas) + fechos; fronteira = espaço depois (ou o fim, com `final`)
    let j = i
    while (j < buffer.length && isMark(buffer[j])) j++
    while (j < buffer.length && isCloser(buffer[j])) j++
    const atEnd = j >= buffer.length
    const boundary = atEnd ? !!opts.final : /\s/.test(buffer[j])
    if (!boundary) {
      i++
      continue
    }
    if (buffer[i] === '.' && !dotCuts(buffer, i, segStart, atEnd, !!opts.final)) {
      i++
      continue
    }
    const sentence = buffer.slice(segStart, j).trim()
    if (sentence) sentences.push(sentence)
    segStart = j
    i = j
  }
  let rest = buffer.slice(segStart)
  // corte forçado: sem fronteira há mais que maxChars → corta no último espaço (ou em maxChars)
  if (rest.length > maxChars) {
    let cut = -1
    const base = buffer.length - rest.length
    for (let k = Math.min(maxChars, rest.length - 1); k > 0; k--) {
      if (/\s/.test(rest[k]) && !inTag(base + k)) {
        cut = k
        break
      }
    }
    if (cut <= 0) cut = maxChars
    const forced = rest.slice(0, cut).trim()
    if (forced) sentences.push(forced)
    rest = rest.slice(cut)
  }
  return { sentences, rest: rest.trimStart() }
}
