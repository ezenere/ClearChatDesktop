// Cabeçalho do raciocínio (MessageList → Reasoning): relógio do "Pensando… N s" guardado no store
// (sobrevive a remontagens e funciona no controle remoto, onde o draft não traz o relógio) e a
// formatação pt-BR de "Raciocínio · 12 s · 1,2 mil tokens". Puro — testes em e2e/chatUi.test.ts.
import type { StreamDraft } from '@shared/types'

/** Relógio do raciocínio de uma sessão enquanto o rascunho existe. */
export interface ReasoningClock {
  /** 1º delta de raciocínio ou abertura do bloco de raciocínio (epoch ms). */
  start: number
  /** 1º delta de conteúdo/tool call depois dele ou o fechamento do bloco ("Pensando…" acabou). */
  end?: number
}

/**
 * Próximo relógio a cada evento `draft`. Prefere as marcas do processo que roda o stream (o draft
 * local traz `reasoningStartedAt`/`reasoningEndedAt`); sem elas (controle remoto, ou rascunho de
 * antes de recarregar), usa `now` — a hora em que o raciocínio apareceu aqui. Devolve o MESMO
 * objeto quando nada muda (o store não re-renderiza à toa).
 */
export function nextReasoningClock(
  prev: ReasoningClock | undefined,
  draft: StreamDraft | null,
  now: number
): ReasoningClock | undefined {
  // raciocínio = texto dele OU a marca de início do processo que roda o stream (bloco de raciocínio
  // da Messages API aberto sem texto — `display: "omitted"` dos Claude ≥ 4.7)
  if (!draft || !(draft.reasoning || draft.reasoningStartedAt != null)) return undefined
  const start = draft.reasoningStartedAt ?? prev?.start ?? now
  const answering = !!draft.content || draft.toolCalls.length > 0 || draft.reasoningEndedAt != null
  const end = answering ? (draft.reasoningEndedAt ?? prev?.end ?? Math.max(now, start)) : undefined
  if (prev && prev.start === start && prev.end === end) return prev
  return end != null ? { start, end } : { start }
}

const trimZero = (s: string): string => s.replace(/,0$/, '')

/** Contagem compacta pt-BR: 850 · 1,2 mil · 12,3 mil · 123 mil · 1,2 mi. */
export function formatCountPt(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v < 1000) return String(v)
  if (v < 100_000) return `${trimZero((v / 1000).toFixed(1).replace('.', ','))} mil`
  if (v < 1_000_000) return `${Math.round(v / 1000)} mil`
  return `${trimZero((v / 1_000_000).toFixed(1).replace('.', ','))} mi`
}

/** Duração curta pt-BR: <1 s · 8 s · 1 min 5 s · 2 min. */
export function formatSecondsPt(ms: number): string {
  if (ms < 1000) return '<1 s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} min ${r} s` : `${m} min`
}

/**
 * Partes do cabeçalho do raciocínio.
 *  - pensando (`live`): "Pensando…" + "8 s" (a partir de 1 s);
 *  - concluído: "Raciocínio" + duração (se conhecida) + "1,2 mil tokens" (se o provedor informou).
 */
export function reasoningHeader(opts: {
  live?: boolean
  elapsedMs?: number
  durationMs?: number
  tokens?: number
}): { label: string; details: string[] } {
  if (opts.live) {
    const e = opts.elapsedMs
    return { label: 'Pensando…', details: e != null && e >= 1000 ? [formatSecondsPt(e)] : [] }
  }
  const details: string[] = []
  if (opts.durationMs != null && opts.durationMs > 0) details.push(formatSecondsPt(opts.durationMs))
  if (opts.tokens != null && opts.tokens > 0)
    details.push(`${formatCountPt(opts.tokens)} ${opts.tokens === 1 ? 'token' : 'tokens'}`)
  return { label: 'Raciocínio', details }
}
