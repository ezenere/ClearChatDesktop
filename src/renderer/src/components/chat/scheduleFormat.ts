// Agendamentos no header do chat (chip + popover) — puro, testado em e2e/schedule.test.ts.
// Lista = a do main (ativos + encerrados recentes, @shared/schedule). Os encerrados aparecem até o
// usuário "Limpar" (marca local, por chat, em localStorage — não apaga nada: o agente continua
// consultando pelo id com schedule_list).
import type { ScheduleInfo } from '@shared/schedule'

export type SchedulesChip =
  | { kind: 'active'; count: number; nextAt: number | null; firing: boolean }
  | { kind: 'ended'; count: number; canceled: number }
  | null

/** Encerrados que ainda aparecem (terminaram depois do último "Limpar"). */
export function visibleEnded(list: readonly ScheduleInfo[], clearedAt: number): ScheduleInfo[] {
  return list.filter((s) => s.status !== 'active' && (s.endedAt ?? 0) > clearedAt)
}

/**
 * Chip: com ativos → "N agendamentos" (próximo disparo no tooltip); sem ativos mas com encerrados
 * ainda não limpos → neutro ("N encerrados", com aviso se algum foi cancelado); senão nada.
 */
export function schedulesChip(
  list: readonly ScheduleInfo[],
  clearedAt: number,
  firing: readonly string[] = []
): SchedulesChip {
  const active = list.filter((s) => s.status === 'active')
  if (active.length) {
    const next = active.map((s) => s.nextAt ?? Infinity).reduce((a, b) => Math.min(a, b), Infinity)
    return {
      kind: 'active',
      count: active.length,
      nextAt: Number.isFinite(next) ? next : null,
      firing: active.some((s) => firing.includes(s.id))
    }
  }
  const ended = visibleEnded(list, clearedAt)
  if (!ended.length) return null
  return {
    kind: 'ended',
    count: ended.length,
    canceled: ended.filter((s) => s.status === 'canceled').length
  }
}

const KEY = 'clearchat.schedulesCleared.'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Último "Limpar" dos encerrados deste chat (0 = nunca). */
export function readCleared(chatId: string): number {
  try {
    const v = Number(storage()?.getItem(KEY + chatId) ?? 0)
    return Number.isFinite(v) ? v : 0
  } catch {
    return 0
  }
}

export function writeCleared(chatId: string, at: number): void {
  try {
    storage()?.setItem(KEY + chatId, String(at))
  } catch {
    /* sem storage: só nesta sessão */
  }
}
