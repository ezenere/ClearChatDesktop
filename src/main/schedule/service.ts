// Agendamentos: a instância do motor e as ligações. O runner instala o que é dele (entregar o
// disparo, gravar o aviso, rodar a tool agendada) e o sync instala o portão do host (este aparelho
// executa o chat?). Sem esse portão (sync desligado) o chat sempre roda aqui.
import { emit } from '../events'
import { Scheduler, type ScheduleGate, type ScheduleHost } from './scheduler'

export type RunnerScheduleHost = Omit<ScheduleHost, 'canRun' | 'onChange'>

let runnerHost: RunnerScheduleHost | null = null
let gate: (chatId: string) => ScheduleGate = () => ({ ok: true })
let instance: Scheduler | null = null

export function setScheduleRunnerHost(h: RunnerScheduleHost): void {
  runnerHost = h
}

/** Sync: este aparelho pode rodar o chat agora? (host aqui / chat local) */
export function setScheduleGate(fn: ((chatId: string) => ScheduleGate) | null): void {
  gate = fn ?? (() => ({ ok: true }))
}

const need = (): RunnerScheduleHost => {
  if (!runnerHost) throw new Error('agendamentos: runner não ligado')
  return runnerHost
}

export function scheduler(): Scheduler {
  if (!instance) {
    instance = new Scheduler({
      sessionOk: (s) => need().sessionOk(s),
      canRun: (chatId) => gate(chatId),
      runTool: (s, signal) => need().runTool(s, signal),
      isQueued: (sid, qid) => need().isQueued(sid, qid),
      deliver: (s, text, meta, replace) => need().deliver(s, text, meta, replace),
      notice: (sid, text, meta) => need().notice(sid, text, meta),
      onChange: (chatId) =>
        emit({ type: 'schedules-updated', chatId, schedules: instance?.view(chatId) ?? [] })
    })
  }
  return instance
}

/** Start do app (depois do initRunner): cancela os que sobraram de um fechamento abrupto. */
export function initScheduler(): void {
  try {
    scheduler().init()
  } catch (e) {
    console.error('[clearchat] agendamentos (início)', e)
  }
}

/** before-quit (depois do shutdownRunner): cancela todos e grava os avisos. */
export function shutdownScheduler(): void {
  try {
    instance?.shutdown()
  } catch (e) {
    console.error('[clearchat] agendamentos (fechar)', e)
  }
}
