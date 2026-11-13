// Tool `datetime` (protocolo 1.11.0, SYNC_PROTOCOL.md §4.3.6 — "Tools compactadas e `datetime`"):
// a data e hora atuais DO APARELHO QUE RODA O TURNO, no fuso dele. Sem `format`: ISO 8601 com o
// deslocamento, o dia da semana por extenso e o fuso (IANA e UTC±hh:mm). Com `format`: códigos de
// `strftime` (lista em DATETIME_CODES), nomes de dia e mês no idioma do app (pt-BR); código
// desconhecido → erro com a lista dos aceitos. O system prompt continua sem data/hora (o prefixo
// fica estável para o cache): esta tool é o jeito de o modelo saber o momento.
//
// Puro (sem Node/Electron/DOM): o fuso vem do Intl (o do aparelho, ou um injetado nos testes) e
// `now` é injetável. O desktop e o mobile (vendora este arquivo) formatam igual.

/** Códigos aceitos em `format` (a ordem é a da descrição da tool e da mensagem de erro). */
export const DATETIME_CODES = [
  '%Y',
  '%m',
  '%d',
  '%H',
  '%M',
  '%S',
  '%A',
  '%a',
  '%B',
  '%b',
  '%j',
  '%p',
  '%I',
  '%y',
  '%e',
  '%u',
  '%w',
  '%Z',
  '%z',
  '%F',
  '%T',
  '%D',
  '%s',
  '%%'
] as const

/** Nomes de dia e mês de um idioma (domingo primeiro; janeiro primeiro). */
export interface DateNames {
  weekdays: readonly string[]
  weekdaysShort: readonly string[]
  months: readonly string[]
  monthsShort: readonly string[]
}

/** Nomes em pt-BR (o idioma do app). Tabela fixa: o Intl de cada plataforma varia (Hermes, ICU). */
export const PT_BR_NAMES: DateNames = {
  weekdays: [
    'domingo',
    'segunda-feira',
    'terça-feira',
    'quarta-feira',
    'quinta-feira',
    'sexta-feira',
    'sábado'
  ],
  weekdaysShort: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'],
  months: [
    'janeiro',
    'fevereiro',
    'março',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro'
  ],
  monthsShort: ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
}

export interface DateTimeOptions {
  /** Momento (padrão: agora). */
  now?: Date | number
  /** Fuso IANA (padrão: o do aparelho, pelo Intl). */
  timeZone?: string
  /** Nomes de dia/mês (padrão: pt-BR). */
  names?: DateNames
}

/** O momento decomposto no fuso pedido. */
export interface ZonedParts {
  year: number
  month: number // 1-12
  day: number
  hour: number // 0-23
  minute: number
  second: number
  /** 0 = domingo. */
  weekday: number
  /** Deslocamento do fuso em minutos (ex.: -180 = UTC-03:00). */
  offsetMinutes: number
  /** Segundos desde a época Unix. */
  epochSeconds: number
  timeZone: string
}

/** Fuso do aparelho (IANA); sem Intl/fuso → "UTC". */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Decompõe `now` no fuso (Intl). Fuso inválido → lança RangeError (o Intl recusa). */
export function zonedParts(opts: DateTimeOptions = {}): ZonedParts {
  const ms = opts.now === undefined ? Date.now() : +opts.now
  const timeZone = opts.timeZone || deviceTimeZone()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const get = (type: string): number =>
    Number(fmt.formatToParts(ms).find((p) => p.type === type)?.value ?? NaN)
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = get('hour') % 24
  const minute = get('minute')
  const second = get('second')
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const exact = Math.floor(ms / 1000) * 1000
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    offsetMinutes: Math.round((wall - exact) / 60_000),
    epochSeconds: Math.floor(ms / 1000),
    timeZone
  }
}

const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0')

/** Deslocamento `-03:00` (sep = ':') ou `-0300` (sep = ''). */
export function formatOffset(minutes: number, sep = ':'): string {
  const sign = minutes < 0 ? '-' : '+'
  const m = Math.abs(minutes)
  return `${sign}${pad(Math.floor(m / 60))}${sep}${pad(m % 60)}`
}

function dayOfYear(p: ZonedParts): number {
  return (
    Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(p.year, 0, 1)) / 86_400_000) + 1
  )
}

/** Valor de um código (sem o `%`); null = desconhecido. */
function codeValue(c: string, p: ZonedParts, names: DateNames): string | null {
  const h12 = p.hour % 12 || 12
  switch (c) {
    case 'Y':
      return String(p.year)
    case 'm':
      return pad(p.month)
    case 'd':
      return pad(p.day)
    case 'H':
      return pad(p.hour)
    case 'M':
      return pad(p.minute)
    case 'S':
      return pad(p.second)
    case 'A':
      return names.weekdays[p.weekday]
    case 'a':
      return names.weekdaysShort[p.weekday]
    case 'B':
      return names.months[p.month - 1]
    case 'b':
      return names.monthsShort[p.month - 1]
    case 'j':
      return pad(dayOfYear(p), 3)
    case 'p':
      return p.hour < 12 ? 'AM' : 'PM'
    case 'I':
      return pad(h12)
    case 'y':
      return pad(p.year % 100)
    case 'e':
      return String(p.day).padStart(2, ' ')
    case 'u':
      return String(p.weekday === 0 ? 7 : p.weekday)
    case 'w':
      return String(p.weekday)
    case 'Z':
      return p.timeZone
    case 'z':
      return formatOffset(p.offsetMinutes, '')
    case 'F':
      return `${p.year}-${pad(p.month)}-${pad(p.day)}`
    case 'T':
      return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
    case 'D':
      return `${pad(p.month)}/${pad(p.day)}/${pad(p.year % 100)}`
    case 's':
      return String(p.epochSeconds)
    case '%':
      return '%'
  }
  return null
}

export type DateTimeResult = { ok: true; text: string } | { ok: false; error: string }

/** Texto padrão (sem `format`): ISO 8601 com deslocamento · dia da semana · fuso (IANA e UTC±hh:mm). */
export function defaultDateTimeText(p: ZonedParts, names: DateNames = PT_BR_NAMES): string {
  const off = formatOffset(p.offsetMinutes)
  const iso = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${off}`
  return `${iso} · ${names.weekdays[p.weekday]} · fuso ${p.timeZone} (UTC${off})`
}

/** Mensagem de erro de código desconhecido (com a lista dos aceitos). */
export function unknownCodeError(code: string): string {
  return `código de formato desconhecido: ${code}. Aceitos: ${DATETIME_CODES.join(' ')}`
}

/**
 * Data/hora atual formatada. `format` ausente/vazio → texto padrão; com `format` → códigos de
 * strftime (DATETIME_CODES); código desconhecido (ou `%` solto no fim) → erro com a lista.
 */
export function formatDateTime(format?: string | null, opts: DateTimeOptions = {}): DateTimeResult {
  let p: ZonedParts
  try {
    p = zonedParts(opts)
  } catch (e) {
    return { ok: false, error: `fuso inválido: ${opts.timeZone} (${(e as Error).message})` }
  }
  const names = opts.names ?? PT_BR_NAMES
  if (format == null || format === '') return { ok: true, text: defaultDateTimeText(p, names) }
  let out = ''
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]
    if (ch !== '%') {
      out += ch
      continue
    }
    const c = format[i + 1]
    if (c === undefined) return { ok: false, error: unknownCodeError('%') }
    const v = codeValue(c, p, names)
    if (v === null) return { ok: false, error: unknownCodeError(`%${c}`) }
    out += v
    i++
  }
  return { ok: true, text: out }
}

/** Execução da tool `datetime` (args do modelo): `{ format?: string }`. */
export function runDatetimeTool(
  args: Record<string, unknown>,
  opts: DateTimeOptions = {}
): { content: string; status: 'ok' | 'error' } {
  const f = args.format
  if (f != null && typeof f !== 'string')
    return { content: 'Erro: "format" deve ser um texto (códigos de strftime).', status: 'error' }
  const r = formatDateTime(f as string | undefined, opts)
  return r.ok ? { content: r.text, status: 'ok' } : { content: `Erro: ${r.error}`, status: 'error' }
}
