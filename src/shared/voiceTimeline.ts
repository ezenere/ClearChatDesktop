// Métricas simples da chamada de voz a partir da timeline (funções puras, sem DOM — SPEC →
// "Timeline e log de diagnóstico"); alimentam o painel do dock (`VoiceCallPanel`). A timeline junta
// os eventos do main (`voice:call:timeline`) e do sensor (renderer) — ver `VoiceCallTimelineEvent`.
import type { VoiceCallTimelineEvent } from './ipc'

export interface VoiceCallMetrics {
  /** Duração da chamada coberta pela timeline (ms). */
  elapsedMs: number
  /** Preâmbulos que tocaram de fato (`decision` FILLER com `played`). */
  fillerPlayed: number
  /** Frases de espera que tocaram ("manter viva" e "obrigado por aguardar"). */
  delayPlayed: { keepAlive: number; thanks: number }
  /** Frases de ferramenta que tocaram (`decision` TOOL com `played` — no máx. 1 por turno). */
  toolPlayed: number
  /**
   * Por que NÃO tocou (motivo → vezes), separado em preâmbulos, frases de demora
   * (`KEEPALIVE`/`THANKS`) e frases de ferramenta (`TOOL`, motivo `<categoria>/<motivo>`) — o
   * painel "Atos de fala curta" explica.
   */
  skipped: {
    filler: Record<string, number>
    delay: Record<string, number>
    tool: Record<string, number>
  }
}

/** Classes das frases de espera ("manter viva" e "obrigado por aguardar"). */
export const DELAY_PHRASE_CLASSES: readonly string[] = ['KEEPALIVE', 'THANKS']

/**
 * Métricas da chamada atual: preâmbulos, frases de demora e de ferramenta tocados e os motivos dos que não
 * tocaram. `now` (ms) fecha o tempo da chamada; padrão: o ts do último evento.
 */
export function computeVoiceCallMetrics(
  events: readonly VoiceCallTimelineEvent[],
  now?: number
): VoiceCallMetrics {
  const list = [...events].sort((a, b) => a.ts - b.ts)
  const first = list[0]?.ts ?? 0
  const last = now ?? list[list.length - 1]?.ts ?? first
  const skipped: VoiceCallMetrics['skipped'] = { filler: {}, delay: {}, tool: {} }
  const delayPlayed = { keepAlive: 0, thanks: 0 }
  let fillerPlayed = 0
  let toolPlayed = 0
  for (const e of list) {
    if (e.kind !== 'decision') continue
    const isFiller = e.class === 'FILLER'
    const isTool = e.class === 'TOOL'
    const isDelay = DELAY_PHRASE_CLASSES.includes(e.class ?? '')
    if (!isFiller && !isDelay && !isTool) continue
    if (e.played) {
      if (isFiller) fillerPlayed++
      else if (isTool) toolPlayed++
      else if (e.class === 'KEEPALIVE') delayPlayed.keepAlive++
      else delayPlayed.thanks++
      continue
    }
    const bucket = isFiller ? skipped.filler : isTool ? skipped.tool : skipped.delay
    const reason = e.reason || '?'
    bucket[reason] = (bucket[reason] ?? 0) + 1
  }
  return {
    elapsedMs: Math.max(0, last - first),
    fillerPlayed,
    delayPlayed,
    toolPlayed,
    skipped
  }
}
