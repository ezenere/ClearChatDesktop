// Agendamentos (tools `schedule` / `schedule_list` / `schedule_stop` — SPEC.md → "Agendamentos";
// protocolo 1.15.0, SYNC_PROTOCOL.md §4.3.6 "Agendamentos"). Um agendamento entrega ao agente, num
// horário, um lembrete (`message`) e/ou a saída de uma tool rodada naquele momento (`tool` + `args`).
// Fica só na memória e no banco do aparelho que executa o chat, e só enquanto o app está aberto:
// fechar o app (ou o chat passar a rodar em outro aparelho) cancela todos, e o agente recebe um
// aviso com os ids.
//
// Puro (sem Node/Electron/DOM): parse dos argumentos (quando e o quê), textos entregues ao agente
// (disparo, aviso de cancelamento, resultado das tools) e a listagem. O main (main/schedule) guarda
// e dispara; o renderer mostra (chip do chat, cards). `now` é sempre injetável; horários locais usam
// o fuso do aparelho (o Date local).
import type { ToolName } from './types'

export const SCHEDULE_LIMITS = {
  /** Repetição: no mínimo a cada 1 min (cada disparo pode virar uma chamada ao modelo). */
  minEveryMs: 60_000,
  /** Primeiro disparo: no mínimo daqui a 1 s; no máximo daqui a ~1 ano. */
  minDelayMs: 1_000,
  maxAheadMs: 366 * 24 * 3_600_000,
  /** Ativos por chat (os encerrados não contam). */
  maxActivePerChat: 20,
  /** `times` (execuções de uma repetição). */
  maxTimes: 10_000,
  maxMessageChars: 4_000,
  maxTitleChars: 80,
  /** Execuções guardadas por agendamento (as mais recentes). */
  historyKeep: 20,
  /** Encerrados guardados por chat (os mais recentes; os ativos nunca saem). */
  endedKeepPerChat: 100
} as const

export type ScheduleStatus = 'active' | 'done' | 'stopped' | 'canceled'

/**
 * Por que encerrou: `completed` (disparou a última vez) · `agent` (schedule_stop) · `user` (Parar na
 * tela) · `app-closed` · `host-changed` (o chat passou a rodar em outro aparelho) · `tool-unavailable`
 * (a tool saiu do chat ou caiu na blacklist) · `chat-deleted`.
 */
export type ScheduleEndReason =
  | 'completed'
  | 'agent'
  | 'user'
  | 'app-closed'
  | 'host-changed'
  | 'tool-unavailable'
  | 'chat-deleted'

export type ScheduleRunStatus = 'ok' | 'error' | 'denied'

export interface ScheduleRun {
  at: number
  status: ScheduleRunStatus
}

export interface ScheduleTool {
  name: string
  args: Record<string, unknown>
}

/** O que o agente pediu (normalizado). */
export interface ScheduleSpec {
  title: string
  message?: string
  tool?: ScheduleTool
  /** Primeiro disparo (epoch ms). */
  startAt: number
  /** Repetição (ms); ausente = dispara uma vez. */
  everyMs?: number
  /** Execuções da repetição (ausente = até parar ou o app fechar). */
  times?: number
}

export interface ScheduleInfo extends ScheduleSpec {
  id: string
  chatId: string
  /** Sessão principal do chat (quem recebe os disparos). */
  sessionId: string
  createdAt: number
  status: ScheduleStatus
  /** Próximo disparo (só ativos). */
  nextAt?: number
  runs: number
  /** Últimas execuções (até SCHEDULE_LIMITS.historyKeep). */
  history: ScheduleRun[]
  endedAt?: number
  endReason?: ScheduleEndReason
  /** Detalhe do encerramento (ex.: a tool que saiu). */
  endNote?: string
  /** Cancelado sem o aviso ainda gravado no chat (gravado quando este aparelho puder escrever nele). */
  noticePending?: boolean
  /** Só na lista da UI (nunca gravado): o disparo está rodando agora (a tool agendada). */
  firing?: boolean
}

/** Meta da mensagem `kind: 'schedule'` (role user, synthetic) — disparo ou aviso de cancelamento. */
export type ScheduleMessageMeta =
  | {
      event: 'fire'
      id: string
      title: string
      /** Número desta execução (1 = a primeira). */
      run: number
      times?: number
      everyMs?: number
      /** Próximo disparo; null = foi o último. */
      nextAt: number | null
      /** Atraso do disparo (> 1 min: o computador dormiu ou estava ocupado). */
      lateMs?: number
      /** Disparos anteriores que não chegaram a ser entregues (o agente estava ocupado). */
      replaced?: number
      message?: string
      tool?: {
        name: string
        args: Record<string, unknown>
        status: ScheduleRunStatus
        durationMs: number
      }
    }
  | {
      event: 'canceled'
      reason: ScheduleEndReason
      items: { id: string; title: string }[]
    }

// ---------------- tools que podem ser agendadas ----------------

/**
 * Não agendáveis: as que dependem do turno (perguntar ao usuário, subagentes, mensagens entre chats,
 * apresentar arquivo, encerrar chamada, busca de tools), as próprias de agendamento e as que gravam
 * memória. Todas as outras disponíveis no chat podem ser agendadas (inclusive as de conectores).
 */
export const UNSCHEDULABLE_TOOLS: readonly string[] = [
  'schedule',
  'schedule_list',
  'schedule_stop',
  'ask_user',
  'delegate_task',
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent',
  'send_to_chat',
  'present_file',
  'end_call',
  'tool_search',
  'search_tool',
  'memory_write',
  'memory_rewrite',
  'memory_delete'
]

export const SCHEDULE_TOOL_NAMES: readonly ToolName[] = [
  'schedule',
  'schedule_list',
  'schedule_stop'
]

export const isSchedulable = (name: string): boolean => !UNSCHEDULABLE_TOOLS.includes(name)

// ---------------- ids ----------------

const ID_RE = /^sch-[a-z0-9]{5}$/

/** `sch-` + 5 caracteres [a-z0-9]; `rand` injetável (testes). */
export function newScheduleId(rand: () => number = Math.random): string {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = 'sch-'
  for (let i = 0; i < 5; i++) s += abc[Math.floor(rand() * abc.length) % abc.length]
  return s
}

/** Id como o agente escreveu (com ou sem `sch-`, qualquer caixa) → canônico; inválido → null. */
export function normalizeScheduleId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim().toLowerCase().replace(/^#/, '')
  const id = t.startsWith('sch-') ? t : `sch-${t}`
  return ID_RE.test(id) ? id : null
}

/** `ids` (array ou string separada por vírgula/espaço) e o `id` avulso, sem repetidos, na ordem. */
export function scheduleIdsArg(args: Record<string, unknown>): {
  ids: string[]
  invalid: string[]
} {
  const raw: unknown[] = []
  const push = (v: unknown): void => {
    if (Array.isArray(v)) raw.push(...v)
    else if (typeof v === 'string') raw.push(...v.split(/[\s,;]+/).filter(Boolean))
    else if (v != null) raw.push(v)
  }
  push(args.ids)
  push(args.id)
  const ids: string[] = []
  const invalid: string[] = []
  for (const r of raw) {
    const id = normalizeScheduleId(r)
    if (!id) invalid.push(String(r))
    else if (!ids.includes(id)) ids.push(id)
  }
  return { ids, invalid }
}

// ---------------- tempo: durações e horários ----------------

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000
}

/** Unidade escrita (pt/en, singular/plural, abreviada) → s/m/h/d/w. */
function unitOf(u: string): string | null {
  const x = u.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  if (/^(s|seg|segs|segundos?|sec|secs|seconds?)$/.test(x)) return 's'
  if (/^(m|min|mins|minutos?|minutes?)$/.test(x)) return 'm'
  if (/^(h|hr|hrs|horas?|hours?)$/.test(x)) return 'h'
  if (/^(d|dias?|days?)$/.test(x)) return 'd'
  if (/^(w|sem|semanas?|weeks?)$/.test(x)) return 'w'
  return null
}

/**
 * Duração → ms. Número = segundos. Texto: "90s", "10m", "2h", "1d", "1h30m", "1h 30min",
 * "2 horas", "1.5h", ISO 8601 ("PT1H30M", "P1D"), "HH:MM:SS"/"MM:SS". Inválida/≤0 → null.
 */
export function parseDuration(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  if (/^\d+(\.\d+)?$/.test(t)) return parseDuration(Number(t))
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(t)
  if (iso && /\d/.test(t)) {
    const [, w, d, h, m, s] = iso
    const ms =
      Number(w ?? 0) * UNIT_MS.w +
      Number(d ?? 0) * UNIT_MS.d +
      Number(h ?? 0) * UNIT_MS.h +
      Number(m ?? 0) * UNIT_MS.m +
      Number(s ?? 0) * UNIT_MS.s
    return ms > 0 ? Math.round(ms) : null
  }
  const clock = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(t)
  if (clock) {
    const [, a, b, c] = clock
    const ms =
      c !== undefined
        ? (Number(a) * 3600 + Number(b) * 60 + Number(c)) * 1000
        : (Number(a) * 60 + Number(b)) * 1000
    return ms > 0 ? ms : null
  }
  const re = /(\d+(?:[.,]\d+)?)\s*([a-zA-Zçãéá]+)/g
  let total = 0
  let used = ''
  for (const m of t.matchAll(re)) {
    const unit = unitOf(m[2])
    if (!unit) return null
    total += Number(m[1].replace(',', '.')) * UNIT_MS[unit]
    used += m[0]
  }
  // tudo o que não é espaço/"e"/"and" precisa ter sido lido ("1h e 30 min", "1 hour and 5 minutes")
  const rest = t
    .replace(re, '')
    .replace(/\b(e|and)\b/gi, '')
    .trim()
  if (!used || rest) return null
  return total > 0 ? Math.round(total) : null
}

/**
 * Horário fixo → epoch ms. Aceita ISO 8601 com fuso ("2026-11-15T18:30:00-03:00", "…Z"), data e
 * hora locais ("2026-11-15 18:30", "2026-11-15T18:30:15", "15/11/2026 18:30") e só a hora
 * ("18:30" → a próxima vez que o relógio marcar 18:30, hoje ou amanhã). Inválido → null.
 */
export function parseAt(v: unknown, now: number): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (hm) {
    const [, H, M, S] = hm
    if (Number(H) > 23 || Number(M) > 59 || Number(S ?? 0) > 59) return null
    const d = new Date(now)
    d.setHours(Number(H), Number(M), Number(S ?? 0), 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const local =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(t) ?? null
  const br = /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  const parts = local
    ? { y: local[1], mo: local[2], d: local[3], h: local[4], mi: local[5], s: local[6] }
    : br
      ? { y: br[3], mo: br[2], d: br[1], h: br[4], mi: br[5], s: br[6] }
      : null
  if (parts) {
    const y = Number(parts.y)
    const mo = Number(parts.mo)
    const d = Number(parts.d)
    const h = Number(parts.h ?? 0)
    const mi = Number(parts.mi ?? 0)
    const s = Number(parts.s ?? 0)
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
    const date = new Date(y, mo - 1, d, h, mi, s, 0)
    // 31/02 → 03/03: recusa em vez de "consertar" a data
    if (date.getMonth() !== mo - 1 || date.getDate() !== d) return null
    return date.getTime()
  }
  // com fuso explícito (Z ou ±hh:mm): o Date entende
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
    const ms = Date.parse(t)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Fuso do aparelho no instante: "UTC-3", "UTC+5:30". */
export function utcOffsetLabel(ts: number): string {
  const off = -new Date(ts).getTimezoneOffset()
  const abs = Math.abs(off)
  return `UTC${off >= 0 ? '+' : '-'}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`
}

/** Data/hora local legível e sem ambiguidade: "2026-11-15 18:30 (UTC-3)" (segundos se houver). */
export function fmtLocalDateTime(
  ts: number,
  opts: { seconds?: boolean; tz?: boolean } = {}
): string {
  const d = new Date(ts)
  const sec = opts.seconds ?? d.getSeconds() !== 0
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? `:${pad(d.getSeconds())}` : ''}`
  return opts.tz === false ? base : `${base} (${utcOffsetLabel(ts)})`
}

/**
 * Hora curta para listas: "18:30" hoje, "amanhã 08:00", senão "2026-11-20 08:00" — sem segundos,
 * arredondada ao minuto mais próximo (o horário exato vai no tooltip / na listagem por id).
 */
export function fmtShortWhen(ts: number, now: number): string {
  const d = new Date(Math.round(ts / 60_000) * 60_000)
  const n = new Date(now)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  if (sameDay(d, n)) return hm
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(d, tomorrow)) return `amanhã ${hm}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/** "45 s", "10 min", "1 h 30 min", "2 d 3 h", "1 sem". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const w = Math.floor(s / 604_800)
  const d = Math.floor((s % 604_800) / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rs = s % 60
  const parts: string[] = []
  if (w) parts.push(`${w} sem`)
  if (d) parts.push(`${d} d`)
  if (h && parts.length < 2) parts.push(`${h} h`)
  if (m && parts.length < 2) parts.push(`${m} min`)
  if (rs && !w && !d && !h && parts.length < 2) parts.push(`${rs} s`)
  return parts.join(' ')
}

/** "daqui a 12 min", "agora", "há 3 min" (a partir de 1 min, arredondado ao minuto). */
export function fmtRelative(ts: number, now: number): string {
  const diff = ts - now
  if (Math.abs(diff) < 1000) return 'agora'
  const abs =
    Math.abs(diff) >= 60_000 ? Math.round(Math.abs(diff) / 60_000) * 60_000 : Math.abs(diff)
  return diff > 0 ? `daqui a ${fmtDuration(abs)}` : `há ${fmtDuration(abs)}`
}

// ---------------- parse dos argumentos do `schedule` ----------------

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Resumo curto de uma tool agendada: `shell "npm test"`, `read_file "src/a.ts"`, `web_search "…"`. */
export function scheduleToolSummary(tool: ScheduleTool, max = 60): string {
  const a = tool.args
  const main =
    ['command', 'path', 'query', 'url', 'id', 'name', 'pattern']
      .map((k) => a[k])
      .find((v) => typeof v === 'string' && v.trim()) ?? ''
  let arg = typeof main === 'string' ? main.replace(/\s+/g, ' ').trim() : ''
  if (!arg) {
    const json = JSON.stringify(a)
    arg = json === '{}' ? '' : json
  }
  if (arg.length > max) arg = `${arg.slice(0, max - 1)}…`
  return arg ? `${tool.name} "${arg}"` : tool.name
}

/** Título padrão: a 1ª linha do lembrete, senão o resumo da tool (≤ maxTitleChars). */
export function defaultScheduleTitle(
  message: string | undefined,
  tool: ScheduleTool | undefined
): string {
  const max = SCHEDULE_LIMITS.maxTitleChars
  const line =
    (message ?? '')
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  const t = line || (tool ? scheduleToolSummary(tool, max) : 'Agendamento')
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export interface ParseScheduleCtx {
  now: number
  /** A tool existe e está disponível nesta sessão (fora as não agendáveis)? */
  toolAvailable: (name: string) => boolean
}

/**
 * Argumentos do `schedule` → spec normalizada, ou o erro (texto para o modelo).
 * Quando: `at` (horário fixo) OU `in` (daqui a), e/ou `every` (repete; sem `at`/`in` o 1º disparo é
 * daqui a `every`); `times` só com `every`. O quê: `message` e/ou `tool` (+ `args`).
 */
export function parseScheduleArgs(
  args: Record<string, unknown>,
  ctx: ParseScheduleCtx
): { ok: ScheduleSpec } | { error: string } {
  const L = SCHEDULE_LIMITS
  const message = str(args.message)
  if (message.length > L.maxMessageChars)
    return { error: `Erro: "message" passa de ${L.maxMessageChars} caracteres.` }
  const toolName = str(args.tool)
  let tool: ScheduleTool | undefined
  if (toolName) {
    if (!isSchedulable(toolName))
      return {
        error: `Erro: a ferramenta "${toolName}" não pode ser agendada (depende do turno ou é de agendamento). Agende um lembrete (message) e chame-a quando ele chegar.`
      }
    if (!ctx.toolAvailable(toolName))
      return { error: `Erro: a ferramenta "${toolName}" não está disponível neste chat.` }
    let a: unknown = args.args ?? {}
    if (typeof a === 'string') {
      try {
        a = a.trim() ? JSON.parse(a) : {}
      } catch {
        return { error: 'Erro: "args" deve ser um objeto JSON com os argumentos da ferramenta.' }
      }
    }
    if (!a || typeof a !== 'object' || Array.isArray(a))
      return { error: 'Erro: "args" deve ser um objeto JSON com os argumentos da ferramenta.' }
    tool = { name: toolName, args: a as Record<string, unknown> }
  } else if (args.args !== undefined && args.args !== null && JSON.stringify(args.args) !== '{}') {
    return { error: 'Erro: "args" sem "tool" — diga qual ferramenta rodar em "tool".' }
  }
  if (!message && !tool)
    return {
      error:
        'Erro: diga o que agendar — "message" (lembrete entregue a você) e/ou "tool" + "args" (ferramenta rodada no horário).'
    }

  const hasAt = args.at !== undefined && args.at !== null && args.at !== ''
  const hasIn = args.in !== undefined && args.in !== null && args.in !== ''
  const hasEvery = args.every !== undefined && args.every !== null && args.every !== ''
  if (hasAt && hasIn)
    return { error: 'Erro: use "at" (horário fixo) OU "in" (daqui a), não os dois.' }
  if (!hasAt && !hasIn && !hasEvery)
    return {
      error:
        'Erro: diga quando — "at" (ex.: "2026-11-15 18:30" ou "18:30"), "in" (ex.: "10m", "2h") e/ou "every" (ex.: "15m").'
    }
  let everyMs: number | undefined
  if (hasEvery) {
    const e = parseDuration(args.every)
    if (e === null)
      return {
        error: `Erro: "every" inválido: ${JSON.stringify(args.every)} (ex.: "15m", "2h", "1d").`
      }
    if (e < L.minEveryMs) return { error: `Erro: "every" no mínimo ${fmtDuration(L.minEveryMs)}.` }
    everyMs = e
  }
  let startAt: number
  if (hasAt) {
    const at = parseAt(args.at, ctx.now)
    if (at === null)
      return {
        error: `Erro: "at" inválido: ${JSON.stringify(args.at)} (ex.: "2026-11-15 18:30", "18:30" ou ISO com fuso).`
      }
    if (at - ctx.now < L.minDelayMs)
      return {
        error: `Erro: "at" (${fmtLocalDateTime(at)}) já passou — agora são ${fmtLocalDateTime(ctx.now)}.`
      }
    startAt = at
  } else if (hasIn) {
    const d = parseDuration(args.in)
    if (d === null)
      return {
        error: `Erro: "in" inválido: ${JSON.stringify(args.in)} (ex.: "30s", "10m", "1h30m").`
      }
    if (d < L.minDelayMs) return { error: `Erro: "in" no mínimo ${fmtDuration(L.minDelayMs)}.` }
    startAt = ctx.now + d
  } else {
    startAt = ctx.now + (everyMs as number)
  }
  if (startAt - ctx.now > L.maxAheadMs)
    return { error: `Erro: o primeiro disparo passa de ${fmtDuration(L.maxAheadMs)} à frente.` }

  let times: number | undefined
  if (args.times !== undefined && args.times !== null && args.times !== '') {
    const n = Number(args.times)
    if (!Number.isInteger(n) || n < 1 || n > L.maxTimes)
      return { error: `Erro: "times" deve ser um inteiro de 1 a ${L.maxTimes}.` }
    if (!everyMs)
      return { error: 'Erro: "times" só vale com "every" (sem "every" dispara uma vez).' }
    times = n
  }
  const rawTitle = str(args.title)
  const title = rawTitle
    ? rawTitle.length > L.maxTitleChars
      ? `${rawTitle.slice(0, L.maxTitleChars - 1)}…`
      : rawTitle
    : defaultScheduleTitle(message, tool)
  return {
    ok: {
      title,
      ...(message ? { message } : {}),
      ...(tool ? { tool } : {}),
      startAt,
      ...(everyMs ? { everyMs } : {}),
      ...(times ? { times } : {})
    }
  }
}

// ---------------- próximos disparos ----------------

/**
 * Próximo disparo depois de uma execução em `firedAt` (a `run`-ésima). Repetição: o próximo ponto
 * da grade startAt + k·every que ainda não passou (disparos perdidos com o computador dormindo não
 * se acumulam). null = acabou.
 */
export function nextFireAt(
  s: Pick<ScheduleSpec, 'startAt' | 'everyMs' | 'times'>,
  run: number,
  firedAt: number
): number | null {
  if (!s.everyMs) return null
  if (s.times && run >= s.times) return null
  const k = Math.max(run, Math.floor((firedAt - s.startAt) / s.everyMs) + 1)
  return s.startAt + k * s.everyMs
}

// ---------------- textos ----------------

/** "a cada 10 min (3 de 10)" · "a cada 1 h" · "uma vez". */
export function fmtRepeat(s: Pick<ScheduleSpec, 'everyMs' | 'times'>): string {
  if (!s.everyMs) return 'uma vez'
  return `a cada ${fmtDuration(s.everyMs)}${s.times ? `, ${s.times} ${s.times === 1 ? 'vez' : 'vezes'}` : ''}`
}

/** O quê: `lembrete "…"` e/ou `shell "npm test"`. */
export function fmtWhat(s: Pick<ScheduleSpec, 'message' | 'tool'>, max = 60): string {
  const parts: string[] = []
  if (s.tool) parts.push(scheduleToolSummary(s.tool, max))
  if (s.message) {
    const one = s.message.replace(/\s+/g, ' ')
    parts.push(`lembrete "${one.length > max ? `${one.slice(0, max - 1)}…` : one}"`)
  }
  return parts.join(' + ')
}

export const END_REASON_TEXT: Record<ScheduleEndReason, string> = {
  completed: 'concluído (disparou a última vez)',
  agent: 'parado pelo agente',
  user: 'parado pelo usuário',
  'app-closed': 'cancelado: o app foi fechado',
  'host-changed': 'cancelado: o chat passou a rodar em outro aparelho',
  'tool-unavailable': 'parado: a ferramenta não pode mais rodar',
  'chat-deleted': 'cancelado: o chat foi apagado'
}

/** Resultado do `schedule` (criado). */
export function scheduleCreatedText(s: ScheduleInfo, now: number): string {
  const first = `${fmtLocalDateTime(s.startAt)} (${fmtRelative(s.startAt, now)})`
  return [
    `Agendamento ${s.id} criado: ${fmtWhat(s, 120)} — ${fmtRepeat(s)}, ${s.everyMs ? 'primeiro disparo' : 'dispara'} em ${first}.`,
    `No horário chega a mensagem "[Agendamento ${s.id} disparou …]"${s.tool ? ' com a saída da ferramenta' : ''}. Só roda com o app aberto (fechar cancela e você recebe um aviso). Para parar: schedule_stop com ids ["${s.id}"].`
  ].join('\n')
}

/**
 * Texto da mensagem de disparo (o que o modelo recebe). Cabeçalho entre colchetes com id, horário,
 * execução e próximo disparo; depois o lembrete e/ou a saída da tool.
 */
export function scheduleFireText(
  s: Pick<ScheduleInfo, 'id' | 'title' | 'everyMs' | 'times'>,
  f: {
    at: number
    run: number
    nextAt: number | null
    lateMs?: number
    replaced?: number
    message?: string
    tool?: {
      name: string
      args: Record<string, unknown>
      status: ScheduleRunStatus
      content: string
    }
  }
): string {
  const head: string[] = [`Agendamento ${s.id} disparou`, fmtLocalDateTime(f.at)]
  if (s.everyMs) {
    head.push(
      `execução ${f.run}${s.times ? ` de ${s.times}` : ''} (a cada ${fmtDuration(s.everyMs)})`
    )
    head.push(f.nextAt ? `próxima ${fmtShortWhen(f.nextAt, f.at)}` : 'foi a última')
  } else {
    head.push('disparo único (encerrado)')
  }
  if (f.lateMs && f.lateMs >= 60_000)
    head.push(`atrasado ${fmtDuration(f.lateMs)} (o computador estava suspenso ou ocupado)`)
  if (f.replaced)
    head.push(
      `substitui ${f.replaced} ${f.replaced === 1 ? 'disparo anterior que não chegou' : 'disparos anteriores que não chegaram'} a ser entregue${f.replaced === 1 ? '' : 's'}`
    )
  const lines = [`[${head.join(' · ')}]`]
  if (s.title && s.title !== f.message) lines.push(`Título: ${s.title}`)
  if (f.message) lines.push(`Lembrete: ${f.message}`)
  if (f.tool) {
    const st = f.tool.status === 'ok' ? 'ok' : f.tool.status === 'denied' ? 'bloqueada' : 'erro'
    lines.push(`Ferramenta ${f.tool.name} ${JSON.stringify(f.tool.args)} (${st}):`)
    lines.push(f.tool.content.trim() ? f.tool.content : '(sem saída)')
  }
  return lines.join('\n')
}

/** Aviso de cancelamento (mensagem `kind: 'schedule'`, event 'canceled') — gravado sem acordar o agente. */
export function scheduleCanceledText(
  items: Pick<ScheduleInfo, 'id' | 'title' | 'everyMs' | 'times' | 'message' | 'tool'>[],
  reason: ScheduleEndReason
): string {
  const why =
    reason === 'app-closed'
      ? 'o app foi fechado'
      : reason === 'host-changed'
        ? 'o chat passou a rodar em outro aparelho'
        : reason === 'chat-deleted'
          ? 'o chat foi apagado'
          : END_REASON_TEXT[reason]
  const list = items.map((s) => `${s.id} (${fmtWhat(s, 50)}, ${fmtRepeat(s)})`).join('; ')
  const one = items.length === 1
  return `[${one ? 'Agendamento cancelado' : 'Agendamentos cancelados'} — ${why}: ${list}. ${one ? 'Não vai' : 'Não vão'} mais disparar; schedule_list com ${one ? 'o id' : 'os ids'} mostra como ${one ? 'era' : 'eram'}. Para continuar, agende de novo.]`
}

/** Uma linha de agendamento ativo (schedule_list sem ids; tooltip do chip). */
export function scheduleLine(s: ScheduleInfo, now: number): string {
  const next = s.nextAt
    ? `próximo ${fmtShortWhen(s.nextAt, now)} (${fmtRelative(s.nextAt, now)})`
    : 'sem próximo'
  const runs = s.runs ? ` · ${s.runs} ${s.runs === 1 ? 'execução' : 'execuções'}` : ''
  return `${s.id} · "${s.title}" · ${fmtWhat(s)} · ${fmtRepeat(s)} · ${next}${runs}`
}

const STATUS_TEXT: Record<ScheduleStatus, string> = {
  active: 'ativo',
  done: 'concluído',
  stopped: 'parado',
  canceled: 'cancelado'
}

/** Detalhes de um agendamento (schedule_list com ids). */
export function scheduleDetail(s: ScheduleInfo, now: number): string {
  const lines = [
    `${s.id} — ${s.status === 'active' ? 'ativo' : `${STATUS_TEXT[s.status]} em ${fmtLocalDateTime(s.endedAt ?? now)}`}${s.endReason && s.status !== 'active' ? ` (${END_REASON_TEXT[s.endReason]}${s.endNote ? ` — ${s.endNote}` : ''})` : ''}`,
    `  título: ${s.title}`
  ]
  if (s.message) lines.push(`  lembrete: ${s.message}`)
  if (s.tool) lines.push(`  ferramenta: ${s.tool.name} ${JSON.stringify(s.tool.args)}`)
  lines.push(
    `  quando: ${s.everyMs ? `a partir de ${fmtLocalDateTime(s.startAt)}, ${fmtRepeat(s)}` : `${fmtLocalDateTime(s.startAt)}, uma vez`}`
  )
  if (s.status === 'active' && s.nextAt)
    lines.push(`  próximo disparo: ${fmtLocalDateTime(s.nextAt)} (${fmtRelative(s.nextAt, now)})`)
  const last = s.history.at(-1)
  lines.push(
    `  execuções: ${s.runs}${last ? ` (última ${fmtLocalDateTime(last.at)}: ${last.status === 'ok' ? 'ok' : last.status === 'denied' ? 'bloqueada' : 'erro'})` : ''}`
  )
  lines.push(`  criado: ${fmtLocalDateTime(s.createdAt)}`)
  return lines.join('\n')
}

/**
 * schedule_list. Sem ids: os ativos do chat (encerrados/cancelados não aparecem — só contados).
 * Com ids: os detalhes de cada um, em qualquer estado; id desconhecido → aviso na linha.
 */
export function formatScheduleList(
  chatSchedules: ScheduleInfo[],
  ids: string[],
  now: number
): string {
  if (ids.length) {
    return ids
      .map((id) => {
        const s = chatSchedules.find((x) => x.id === id)
        return s
          ? scheduleDetail(s, now)
          : `${id} — não encontrado neste chat neste aparelho (os agendamentos ficam no aparelho que executava o chat quando foram criados).`
      })
      .join('\n\n')
  }
  const active = chatSchedules
    .filter((s) => s.status === 'active')
    .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))
  const ended = chatSchedules.length - active.length
  const hint = ended
    ? `\n[${ended} ${ended === 1 ? 'encerrado ou cancelado não aparece' : 'encerrados ou cancelados não aparecem'} aqui — consulte por id com ids]`
    : ''
  if (!active.length)
    return `[nenhum agendamento ativo neste chat — agora: ${fmtLocalDateTime(now)}]${hint}`
  return `[${active.length} ${active.length === 1 ? 'agendamento ativo' : 'agendamentos ativos'} — agora: ${fmtLocalDateTime(now)}]\n${active.map((s) => scheduleLine(s, now)).join('\n')}${hint}`
}

// ---------------- aprovação (o mais restritivo entre o agendamento e a tool agendada) ----------------

/** Nível de aprovação: roda sem perguntar < juiz do Smart-Approve < pergunta ao usuário. */
export type GateLevel = 'run' | 'judge' | 'ask'

const LEVEL_ORDER: Record<GateLevel, number> = { run: 0, judge: 1, ask: 2 }

export const stricterLevel = (a: GateLevel, b: GateLevel): GateLevel =>
  LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b

// ---------------- UI: resumo dos argumentos (cards da tool e da aprovação) ----------------

/** "daqui a 10 min" / "às 18:30" / "a cada 15 min, 4 vezes" a partir dos argumentos crus. */
export function scheduleWhenSummary(args: Record<string, unknown>): string {
  const parts: string[] = []
  const at = str(args.at)
  const inMs = parseDuration(args.in)
  const every = parseDuration(args.every)
  if (at) parts.push(`em ${at}`)
  else if (inMs) parts.push(`daqui a ${fmtDuration(inMs)}`)
  if (every) {
    const n = Number(args.times)
    parts.push(
      `a cada ${fmtDuration(every)}${Number.isInteger(n) && n > 0 ? `, ${n} ${n === 1 ? 'vez' : 'vezes'}` : ''}`
    )
  }
  return parts.join(' · ')
}

/** Linha do ToolCard do `schedule`: quando · o quê. */
export function scheduleArgsSummary(args: Record<string, unknown>): string {
  const toolName = str(args.tool)
  const a = args.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {}
  const what = fmtWhat(
    {
      ...(toolName ? { tool: { name: toolName, args: a as Record<string, unknown> } } : {}),
      ...(str(args.message) ? { message: str(args.message) } : {})
    },
    50
  )
  return [scheduleWhenSummary(args), what].filter(Boolean).join(' · ')
}

/** Saída da tool dentro do texto de um disparo (o que vem depois de "Ferramenta … (st):"). */
export function scheduleFireOutput(text: string): string | null {
  const m = /\nFerramenta [^\n]* \((?:ok|erro|bloqueada)\):\n/.exec(text)
  return m ? text.slice(m.index + m[0].length) : null
}
