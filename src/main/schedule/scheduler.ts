// Agendamentos: o motor (SPEC → "Agendamentos"). Guarda em scheduleRepo, arma UM timer para o
// próximo disparo (no máximo 60 s — o relógio pode pular: suspensão, fuso) e, no horário, roda a
// tool agendada (se houver) e entrega o disparo à sessão principal do chat (acorda o agente ou
// entra na fila do próximo passo). Só roda com o app aberto e neste aparelho sendo o host do chat:
// fechar o app cancela tudo (aviso gravado no chat, sem acordar o agente); o chat passar a rodar
// em outro aparelho cancela os dele (aviso gravado quando este aparelho puder escrever no chat).
//
// O que depende do runner/sync entra por `ScheduleHost` (index.ts liga; os testes usam um stub).
import type { MessageMeta } from '@shared/types'
import {
  newScheduleId,
  nextFireAt,
  SCHEDULE_LIMITS,
  scheduleCanceledText,
  scheduleFireText,
  type ScheduleEndReason,
  type ScheduleInfo,
  type ScheduleMessageMeta,
  type ScheduleRunStatus,
  type ScheduleSpec
} from '@shared/schedule'
import { scheduleRepo } from './store'

export type ScheduledToolResult =
  | { status: ScheduleRunStatus; content: string; durationMs: number }
  /** A tool não pode mais rodar (saiu do chat, blacklist): o agendamento para. */
  | { unavailable: string }

/** Pode rodar o chat neste aparelho agora? `retry` = estado passageiro (tenta de novo em 1 min). */
export type ScheduleGate =
  | { ok: true }
  | { ok: false; retry: true; note: string }
  | { ok: false; retry?: false; note: string }

export interface ScheduleHost {
  /** O chat e a sessão principal ainda existem? */
  sessionOk(s: ScheduleInfo): boolean
  canRun(chatId: string): ScheduleGate
  runTool(s: ScheduleInfo, signal: AbortSignal): Promise<ScheduledToolResult>
  /** O item ainda está na fila da sessão (não entregue)? */
  isQueued(sessionId: string, queuedId: string): boolean
  /**
   * Entrega o disparo (acorda o agente; rodando → fila). `replaceQueuedId` = o disparo anterior
   * deste agendamento ainda na fila: sai dela (o novo o substitui).
   */
  deliver(
    s: ScheduleInfo,
    text: string,
    meta: MessageMeta,
    replaceQueuedId?: string
  ): { queuedId?: string }
  /** Grava o aviso de cancelamento sem acordar o agente; false = não deu (tenta depois). */
  notice(sessionId: string, text: string, meta: MessageMeta): boolean
  onChange(chatId: string): void
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
}

/** Teto do timer: reavalia ao menos a cada 1 min (relógio pulou, avisos pendentes, host mudou). */
const MAX_WAIT_MS = 60_000
/** Estado passageiro (divergente, sem conexão com o chat em outro lugar): tenta de novo em 1 min. */
const RETRY_MS = 60_000
/** Encerrados mandados à UI por chat (os mais recentes). */
const VIEW_ENDED = 15

export class ScheduleError extends Error {}

type FireTool = Extract<ScheduleMessageMeta, { event: 'fire' }>['tool']

export class Scheduler {
  private timer: unknown = null
  /** Disparos com a tool rodando (id → abort). */
  private firing = new Map<string, AbortController>()
  /** Último disparo entregue na fila (ainda não lido pelo agente) por agendamento. */
  private queued = new Map<string, { queuedId: string; replaced: number }>()
  private closed = false
  private host: ScheduleHost
  private clock: Clock

  constructor(host: ScheduleHost, clock: Clock = realClock) {
    this.host = host
    this.clock = clock
  }

  // ---------------- consultas ----------------

  list(chatId: string): ScheduleInfo[] {
    return scheduleRepo.listChat(chatId)
  }

  /** O que a UI mostra: os ativos (próximo primeiro) + os encerrados mais recentes. */
  view(chatId: string): ScheduleInfo[] {
    const list = scheduleRepo.listChat(chatId)
    const active = list
      .filter((s) => s.status === 'active')
      .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0))
    const ended = list
      .filter((s) => s.status !== 'active')
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, VIEW_ENDED)
    return [...active.map((s) => (this.firing.has(s.id) ? { ...s, firing: true } : s)), ...ended]
  }

  activeCount(chatId: string): number {
    return scheduleRepo.listChat(chatId).filter((s) => s.status === 'active').length
  }

  isFiring(id: string): boolean {
    return this.firing.has(id)
  }

  // ---------------- criar / parar ----------------

  create(spec: ScheduleSpec, chatId: string, sessionId: string): ScheduleInfo {
    if (this.closed) throw new ScheduleError('Erro: o app está fechando.')
    if (this.activeCount(chatId) >= SCHEDULE_LIMITS.maxActivePerChat)
      throw new ScheduleError(
        `Erro: este chat já tem ${SCHEDULE_LIMITS.maxActivePerChat} agendamentos ativos — pare algum (schedule_stop) antes de criar outro.`
      )
    let id = newScheduleId()
    for (let i = 0; scheduleRepo.exists(id); i++) {
      if (i > 50) throw new ScheduleError('Erro: não foi possível gerar um id.')
      id = newScheduleId()
    }
    const s: ScheduleInfo = {
      ...spec,
      id,
      chatId,
      sessionId,
      createdAt: this.clock.now(),
      status: 'active',
      nextAt: spec.startAt,
      runs: 0,
      history: []
    }
    scheduleRepo.save(s)
    this.host.onChange(chatId)
    this.arm()
    return s
  }

  /**
   * Para agendamentos do chat. Um disparo com a tool rodando termina e é entregue (o último).
   * Devolve os parados, os que já estavam encerrados e os ids que não são deste chat.
   */
  stop(
    chatId: string,
    ids: string[],
    by: 'agent' | 'user'
  ): { stopped: ScheduleInfo[]; already: ScheduleInfo[]; missing: string[] } {
    const out = {
      stopped: [] as ScheduleInfo[],
      already: [] as ScheduleInfo[],
      missing: [] as string[]
    }
    for (const id of ids) {
      const s = scheduleRepo.get(id)
      if (!s || s.chatId !== chatId) {
        out.missing.push(id)
        continue
      }
      if (s.status !== 'active') {
        out.already.push(s)
        continue
      }
      out.stopped.push(this.end(s, 'stopped', by))
    }
    if (out.stopped.length) {
      scheduleRepo.prune(chatId)
      this.host.onChange(chatId)
      this.arm()
    }
    return out
  }

  /** Chat apagado: some tudo dele (sem aviso). */
  dropChat(chatId: string): void {
    for (const s of scheduleRepo.listChat(chatId)) this.firing.get(s.id)?.abort()
    scheduleRepo.deleteChat(chatId)
    this.host.onChange(chatId)
    this.arm()
  }

  private end(
    s: ScheduleInfo,
    status: Exclude<ScheduleInfo['status'], 'active'>,
    reason: ScheduleEndReason,
    extra: Partial<ScheduleInfo> = {}
  ): ScheduleInfo {
    const { nextAt: _n, ...rest } = s
    void _n
    const e: ScheduleInfo = {
      ...rest,
      ...extra,
      status,
      endReason: reason,
      endedAt: this.clock.now()
    }
    scheduleRepo.save(e)
    return e
  }

  /** Cancela os ativos do chat com aviso pendente (gravado por flushNotices). */
  private cancelChat(chatId: string, reason: ScheduleEndReason, note?: string): void {
    const act = scheduleRepo.listChat(chatId).filter((s) => s.status === 'active')
    for (const s of act) {
      this.firing.get(s.id)?.abort()
      this.end(s, 'canceled', reason, { noticePending: true, ...(note ? { endNote: note } : {}) })
    }
    if (act.length) this.host.onChange(chatId)
  }

  // ---------------- timer ----------------

  /** (Re)arma o timer para o próximo disparo (teto de 1 min). */
  arm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    if (this.closed) return
    const active = scheduleRepo.listActive()
    const pending = active.length ? [] : scheduleRepo.listPendingNotices()
    if (!active.length && !pending.length) return
    const now = this.clock.now()
    let wait = MAX_WAIT_MS
    for (const s of active) {
      if (this.firing.has(s.id) || s.nextAt === undefined) continue
      wait = Math.min(wait, Math.max(0, s.nextAt - now))
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      void this.tick()
    }, wait)
  }

  /** Dispara os vencidos, cancela os de chats que passaram a rodar em outro aparelho, grava avisos. */
  async tick(): Promise<void> {
    if (this.closed) return
    const now = this.clock.now()
    const active = scheduleRepo.listActive()
    // host mudou (chat em outro aparelho): cancela os do chat, com aviso pendente
    const chats = new Set(active.map((s) => s.chatId))
    const blocked = new Set<string>()
    for (const chatId of chats) {
      const g = this.host.canRun(chatId)
      if (g.ok) continue
      if (g.retry) blocked.add(chatId)
      else this.cancelChat(chatId, 'host-changed', g.note)
    }
    const due: Promise<void>[] = []
    for (const s of scheduleRepo.listActive()) {
      if (this.firing.has(s.id) || s.nextAt === undefined || s.nextAt > now) continue
      if (blocked.has(s.chatId)) {
        // estado passageiro: tenta de novo em 1 min (o disparo não conta)
        scheduleRepo.save({ ...s, nextAt: now + RETRY_MS })
        continue
      }
      due.push(this.fire(s))
    }
    this.flushNotices()
    this.arm()
    await Promise.all(due)
  }

  // ---------------- disparo ----------------

  private async fire(s: ScheduleInfo): Promise<void> {
    const dueAt = s.nextAt ?? this.clock.now()
    const lateMs = Math.max(0, this.clock.now() - dueAt)
    if (!this.host.sessionOk(s)) {
      scheduleRepo.deleteChat(s.chatId)
      this.host.onChange(s.chatId)
      return
    }
    const ac = new AbortController()
    this.firing.set(s.id, ac)
    this.host.onChange(s.chatId)
    try {
      let tool: FireTool
      let toolContent = ''
      let unavailable: string | null = null
      if (s.tool) {
        let r: ScheduledToolResult
        try {
          r = await this.host.runTool(s, ac.signal)
        } catch (e) {
          r = { status: 'error', content: `Erro: ${(e as Error).message}`, durationMs: 0 }
        }
        if (ac.signal.aborted || this.closed) return // app fechando / chat apagado: nada entregue
        if ('unavailable' in r) {
          unavailable = r.unavailable
          tool = { name: s.tool.name, args: s.tool.args, status: 'denied', durationMs: 0 }
          toolContent = `${r.unavailable} O agendamento foi parado.`
        } else {
          tool = {
            name: s.tool.name,
            args: s.tool.args,
            status: r.status,
            durationMs: r.durationMs
          }
          toolContent = r.content
        }
      } else {
        tool = undefined
      }
      // estado atual (pode ter sido parado pelo usuário/agente enquanto a tool rodava)
      const cur = scheduleRepo.get(s.id)
      if (!cur || this.closed) return
      const firedAt = this.clock.now()
      const run = cur.runs + 1
      const stillActive = cur.status === 'active' && !unavailable
      const next = stillActive ? nextFireAt(cur, run, firedAt) : null
      const history = [
        ...cur.history,
        { at: firedAt, status: (tool?.status ?? 'ok') as ScheduleRunStatus }
      ].slice(-SCHEDULE_LIMITS.historyKeep)
      let saved: ScheduleInfo
      if (stillActive && next !== null) {
        saved = { ...cur, runs: run, history, nextAt: next }
        scheduleRepo.save(saved)
      } else if (cur.status === 'active') {
        saved = this.end(
          { ...cur, runs: run, history },
          unavailable ? 'stopped' : 'done',
          unavailable ? 'tool-unavailable' : 'completed',
          unavailable ? { endNote: unavailable } : {}
        )
      } else {
        saved = { ...cur, runs: run, history }
        scheduleRepo.save(saved)
      }
      const prev = this.queued.get(s.id)
      const replacing = prev && this.host.isQueued(cur.sessionId, prev.queuedId) ? prev : null
      const replaced = replacing ? replacing.replaced + 1 : 0
      const meta: ScheduleMessageMeta = {
        event: 'fire',
        id: cur.id,
        title: cur.title,
        run,
        ...(cur.times ? { times: cur.times } : {}),
        ...(cur.everyMs ? { everyMs: cur.everyMs } : {}),
        nextAt: next,
        ...(lateMs >= 60_000 ? { lateMs } : {}),
        ...(replaced ? { replaced } : {}),
        ...(cur.message ? { message: cur.message } : {}),
        ...(tool ? { tool } : {})
      }
      const text = scheduleFireText(cur, {
        at: firedAt,
        run,
        nextAt: next,
        ...(lateMs >= 60_000 ? { lateMs } : {}),
        ...(replaced ? { replaced } : {}),
        ...(cur.message ? { message: cur.message } : {}),
        ...(tool ? { tool: { ...tool, content: toolContent } } : {})
      })
      const d = this.host.deliver(
        saved,
        text,
        { kind: 'schedule', synthetic: true, schedule: meta },
        replacing?.queuedId
      )
      if (d.queuedId) this.queued.set(s.id, { queuedId: d.queuedId, replaced })
      else this.queued.delete(s.id)
      if (saved.status !== 'active') scheduleRepo.prune(saved.chatId)
    } finally {
      this.firing.delete(s.id)
      this.host.onChange(s.chatId)
      this.arm()
    }
  }

  // ---------------- avisos de cancelamento ----------------

  /**
   * Grava, por chat, um aviso com os cancelados ainda sem aviso. `force` (fechar o app / start
   * depois de um fechamento abrupto): grava sem perguntar ao host — eles rodavam aqui.
   */
  flushNotices(force = false): void {
    const pending = scheduleRepo.listPendingNotices()
    if (!pending.length) return
    const groups = new Map<string, ScheduleInfo[]>()
    for (const s of pending) {
      const k = `${s.sessionId}\u0000${s.endReason ?? 'app-closed'}`
      groups.set(k, [...(groups.get(k) ?? []), s])
    }
    for (const list of groups.values()) {
      const first = list[0]
      const reason = first.endReason ?? 'app-closed'
      if (!this.host.sessionOk(first)) {
        for (const s of list) scheduleRepo.save({ ...s, noticePending: false })
        continue
      }
      if (!force && !this.host.canRun(first.chatId).ok) continue
      const meta: ScheduleMessageMeta = {
        event: 'canceled',
        reason,
        items: list.map((s) => ({ id: s.id, title: s.title }))
      }
      let ok = false
      try {
        ok = this.host.notice(first.sessionId, scheduleCanceledText(list, reason), {
          kind: 'schedule',
          synthetic: true,
          schedule: meta
        })
      } catch (e) {
        console.error('[clearchat] aviso de agendamentos', e)
      }
      if (!ok) continue
      for (const s of list) {
        const { noticePending: _p, ...rest } = s
        void _p
        scheduleRepo.save(rest)
      }
      this.host.onChange(first.chatId)
    }
  }

  // ---------------- ciclo de vida ----------------

  /** Start: ativos que sobraram (fechamento abrupto) → cancelados com aviso; avisos pendentes. */
  init(): void {
    this.closed = false
    const stale = scheduleRepo.listActive()
    for (const s of stale) this.end(s, 'canceled', 'app-closed', { noticePending: true })
    this.flushNotices(true)
    for (const chatId of new Set(stale.map((s) => s.chatId))) this.host.onChange(chatId)
    this.arm()
  }

  /** Fechar o app: cancela todos (aborta as tools rodando) e grava os avisos sem acordar ninguém. */
  shutdown(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    for (const ac of this.firing.values()) ac.abort()
    this.firing.clear()
    const act = scheduleRepo.listActive()
    for (const s of act) this.end(s, 'canceled', 'app-closed', { noticePending: true })
    this.flushNotices(true)
    this.closed = true
  }

  /** Testes: para o timer sem cancelar nada. */
  dispose(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.closed = true
  }
}
