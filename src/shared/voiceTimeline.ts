// Métricas simples da chamada de voz a partir da timeline (funções puras, sem DOM — SPEC →
// "Timeline e log de diagnóstico"); alimentam o painel do dock (`VoiceCallPanel`). A timeline junta
// os eventos do main (`voice:call:timeline`) e do sensor (renderer) — ver `VoiceCallTimelineEvent`.
import type { VoiceCallTimelineEvent } from './ipc'

export interface VoiceCallMetrics {
  /** Duração da chamada coberta pela timeline (ms). */
  elapsedMs: number
  /** Preâmbulos que tocaram de fato (`decision` FILLER com `played`). */
  fillerPlayed: number
  /** Frases de demora que tocaram ("manter viva" e desculpa). */
  delayPlayed: { keepAlive: number; apology: number }
  /**
   * Por que NÃO tocou (motivo → vezes), separado em preâmbulos e frases de demora
   * (`KEEPALIVE`/`APOLOGY`) — o painel "Atos de fala curta" explica.
   */
  skipped: {
    filler: Record<string, number>
    delay: Record<string, number>
  }
}

/** Classes das frases de demora sintetizadas ao vivo. */
export const DELAY_PHRASE_CLASSES: readonly string[] = ['KEEPALIVE', 'APOLOGY']

/**
 * Métricas da chamada atual: preâmbulos e frases de demora tocados e os motivos dos que não
 * tocaram. `now` (ms) fecha o tempo da chamada; padrão: o ts do último evento.
 */
export function computeVoiceCallMetrics(
  events: readonly VoiceCallTimelineEvent[],
  now?: number
): VoiceCallMetrics {
  const list = [...events].sort((a, b) => a.ts - b.ts)
  const first = list[0]?.ts ?? 0
  const last = now ?? list[list.length - 1]?.ts ?? first
  const skipped: VoiceCallMetrics['skipped'] = { filler: {}, delay: {} }
  const delayPlayed = { keepAlive: 0, apology: 0 }
  let fillerPlayed = 0
  for (const e of list) {
    if (e.kind !== 'decision') continue
    const isFiller = e.class === 'FILLER'
    const isDelay = DELAY_PHRASE_CLASSES.includes(e.class ?? '')
    if (!isFiller && !isDelay) continue
    if (e.played) {
      if (isFiller) fillerPlayed++
      else if (e.class === 'KEEPALIVE') delayPlayed.keepAlive++
      else delayPlayed.apology++
      continue
    }
    const bucket = isFiller ? skipped.filler : skipped.delay
    const reason = e.reason || '?'
    bucket[reason] = (bucket[reason] ?? 0) + 1
  }
  return { elapsedMs: Math.max(0, last - first), fillerPlayed, delayPlayed, skipped }
}
