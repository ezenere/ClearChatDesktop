/* eslint-disable @typescript-eslint/no-explicit-any */
// Agendamentos (tools schedule / schedule_list / schedule_stop — SPEC → "Agendamentos"):
// 1. contrato puro (@shared/schedule): durações, horários, argumentos, próximos disparos, textos;
// 2. motor (main/schedule/scheduler) com relógio falso e host de mentira: disparo, repetição,
//    substituição na fila, parar, app fechado (aviso), fechamento abrupto, host trocado, tool que
//    saiu do chat, limite por chat;
// 3. runner REAL com provedor OpenAI-compatible FALSO (127.0.0.1, "CALL {json}"): aprovação (o mais
//    restritivo entre o agendamento e a tool agendada; blacklist bloqueia), disparo acordando o
//    agente com a saída da tool, schedule_list/schedule_stop e o aviso ao fechar o app.
// Sem rede externa, sem custo. Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/schedule.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fmtDuration,
  formatScheduleList,
  newScheduleId,
  nextFireAt,
  normalizeScheduleId,
  parseAt,
  parseDuration,
  parseScheduleArgs,
  scheduleCanceledText,
  scheduleFireText,
  scheduleIdsArg,
  stricterLevel,
  type ScheduleInfo
} from '../src/shared/schedule.ts'

process.env.TZ = 'America/Sao_Paulo'
const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-sched-'))
process.env.CLEARCHAT_TEST_USERDATA = TMP
process.env.CLEARCHAT_SKIP_SHELL_ENV = '1'
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export class BrowserWindow { static getAllWindows() { return [] } }
export const session = { fromPartition: () => ({}) }
export const dialog = {}
export const ipcMain = { handle() {} }
export const nativeImage = {}
export default { app, BrowserWindow, session, dialog, ipcMain, nativeImage }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

const MIN = 60_000
const H = 3_600_000
// 2026-11-15 10:00:00 em São Paulo (UTC-3)
const NOW = new Date(2026, 10, 15, 10, 0, 0).getTime()

// ---------------- 1. contrato puro ----------------

test('parseDuration: unidades pt/en, combinações, ISO, relógio e número = segundos', () => {
  assert.equal(parseDuration('30s'), 30_000)
  assert.equal(parseDuration('10m'), 10 * MIN)
  assert.equal(parseDuration('10 min'), 10 * MIN)
  assert.equal(parseDuration('2h'), 2 * H)
  assert.equal(parseDuration('1h30m'), 90 * MIN)
  assert.equal(parseDuration('1h 30min'), 90 * MIN)
  assert.equal(parseDuration('1 hora e 5 minutos'), 65 * MIN)
  assert.equal(parseDuration('2 horas'), 2 * H)
  assert.equal(parseDuration('1.5h'), 90 * MIN)
  assert.equal(parseDuration('1d'), 24 * H)
  assert.equal(parseDuration('1 semana'), 7 * 24 * H)
  assert.equal(parseDuration('PT1H30M'), 90 * MIN)
  assert.equal(parseDuration('P1D'), 24 * H)
  assert.equal(parseDuration('01:30:00'), 90 * MIN)
  assert.equal(parseDuration('05:00'), 5 * MIN)
  assert.equal(parseDuration(90), 90_000)
  assert.equal(parseDuration('90'), 90_000)
  for (const bad of ['', 'abc', '10 parsecs', '0', -5, 'em breve', '10m depois', null, {}])
    assert.equal(parseDuration(bad), null, JSON.stringify(bad))
})

test('parseAt: data/hora local, só a hora (próxima vez), ISO com fuso, BR; inválidas', () => {
  assert.equal(parseAt('2026-11-15 18:30', NOW), new Date(2026, 10, 15, 18, 30).getTime())
  assert.equal(parseAt('2026-11-15T18:30:15', NOW), new Date(2026, 10, 15, 18, 30, 15).getTime())
  assert.equal(parseAt('15/11/2026 18:30', NOW), new Date(2026, 10, 15, 18, 30).getTime())
  // hoje ainda não passou → hoje; já passou → amanhã
  assert.equal(parseAt('18:30', NOW), new Date(2026, 10, 15, 18, 30).getTime())
  assert.equal(parseAt('09:00', NOW), new Date(2026, 10, 16, 9, 0).getTime())
  assert.equal(parseAt('2026-11-15T21:00:00Z', NOW), Date.UTC(2026, 10, 15, 21, 0))
  assert.equal(parseAt('2026-11-15T18:00:00-03:00', NOW), Date.UTC(2026, 10, 15, 21, 0))
  for (const bad of ['2026-02-31 10:00', '25:00', '2026-13-01', 'amanhã', '', '18h30'])
    assert.equal(parseAt(bad, NOW), null, bad)
})

const avail = (names: string[]): { now: number; toolAvailable: (n: string) => boolean } => ({
  now: NOW,
  toolAvailable: (n: string) => names.includes(n)
})

test('parseScheduleArgs: lembrete, tool, repetição; erros com o motivo', () => {
  const ok = (a: Record<string, unknown>, names: string[] = []): any => {
    const r = parseScheduleArgs(a, avail(names))
    assert.ok('ok' in r, JSON.stringify(r))
    return r.ok
  }
  const err = (a: Record<string, unknown>, re: RegExp, names: string[] = []): void => {
    const r = parseScheduleArgs(a, avail(names))
    assert.ok('error' in r, JSON.stringify(r))
    assert.match(r.error, re)
  }
  const a = ok({ message: 'Revisar o PR', in: '10m' })
  assert.equal(a.startAt, NOW + 10 * MIN)
  assert.equal(a.title, 'Revisar o PR')
  assert.equal(a.everyMs, undefined)
  const b = ok({ tool: 'shell', args: { command: 'npm test' }, every: '15m', times: 4 }, ['shell'])
  assert.equal(b.startAt, NOW + 15 * MIN)
  assert.equal(b.everyMs, 15 * MIN)
  assert.equal(b.times, 4)
  assert.equal(b.title, 'shell "npm test"')
  // args como string JSON (modelos às vezes mandam assim)
  assert.deepEqual(ok({ tool: 'shell', args: '{"command":"ls"}', in: 60 }, ['shell']).tool, {
    name: 'shell',
    args: { command: 'ls' }
  })
  const c = ok({ message: 'x', at: '18:30', every: '1h', title: 'Pausa' })
  assert.equal(c.startAt, new Date(2026, 10, 15, 18, 30).getTime())
  assert.equal(c.title, 'Pausa')

  err({ in: '10m' }, /diga o que agendar/)
  err({ message: 'x' }, /diga quando/)
  err({ message: 'x', at: '18:30', in: '5m' }, /OU "in"/)
  err({ message: 'x', every: '30s' }, /mínimo 1 min/)
  err({ message: 'x', in: '5m', times: 3 }, /só vale com "every"/)
  err({ message: 'x', at: '2026-11-15 09:00' }, /já passou/)
  err({ message: 'x', in: '500d' }, /à frente/)
  err({ tool: 'ask_user', in: '1m' }, /não pode ser agendada/, ['ask_user'])
  err({ tool: 'schedule', in: '1m' }, /não pode ser agendada/, ['schedule'])
  err({ tool: 'shell', in: '1m' }, /não está disponível/)
  err({ tool: 'shell', args: [1], in: '1m' }, /objeto JSON/, ['shell'])
  err({ message: 'x', args: { a: 1 }, in: '1m' }, /sem "tool"/)
})

test('nextFireAt: grade a partir do início, times, disparos perdidos não acumulam', () => {
  const s = { startAt: NOW, everyMs: 10 * MIN }
  assert.equal(nextFireAt(s, 1, NOW + 1000), NOW + 10 * MIN)
  // a tool demorou 25 min: o próximo é o ponto da grade que ainda não passou (30 min)
  assert.equal(nextFireAt(s, 1, NOW + 25 * MIN), NOW + 30 * MIN)
  // computador dormiu 2 h: um disparo só, o próximo volta à grade
  assert.equal(nextFireAt(s, 2, NOW + 2 * H + 1000), NOW + 2 * H + 10 * MIN)
  assert.equal(nextFireAt({ ...s, times: 3 }, 3, NOW + 20 * MIN), null)
  assert.equal(nextFireAt({ startAt: NOW }, 1, NOW), null)
})

test('ids: formato, normalização e o argumento ids/id', () => {
  const id = newScheduleId()
  assert.match(id, /^sch-[a-z0-9]{5}$/)
  assert.equal(normalizeScheduleId('SCH-AB12C'), 'sch-ab12c')
  assert.equal(normalizeScheduleId('ab12c'), 'sch-ab12c')
  assert.equal(normalizeScheduleId('#sch-ab12c'), 'sch-ab12c')
  assert.equal(normalizeScheduleId('sch-ab'), null)
  assert.deepEqual(scheduleIdsArg({ ids: ['sch-aaaaa', 'bbbbb', 'sch-aaaaa', 'zz'] }), {
    ids: ['sch-aaaaa', 'sch-bbbbb'],
    invalid: ['zz']
  })
  assert.deepEqual(scheduleIdsArg({ id: 'sch-ccccc, sch-ddddd' }).ids, ['sch-ccccc', 'sch-ddddd'])
  assert.equal(stricterLevel('run', 'judge'), 'judge')
  assert.equal(stricterLevel('ask', 'judge'), 'ask')
  assert.equal(fmtDuration(90 * MIN), '1 h 30 min')
})

const info = (p: Partial<ScheduleInfo> = {}): ScheduleInfo => ({
  id: 'sch-aaaaa',
  chatId: 'c1',
  sessionId: 's1',
  title: 'Checar build',
  tool: { name: 'shell', args: { command: 'npm test' } },
  startAt: NOW + 10 * MIN,
  everyMs: 10 * MIN,
  times: 5,
  createdAt: NOW,
  status: 'active',
  nextAt: NOW + 10 * MIN,
  runs: 0,
  history: [],
  ...p
})

test('textos: disparo, aviso de cancelamento e listagem (sem ids só ativos; com ids todos)', () => {
  const fire = scheduleFireText(info(), {
    at: NOW + 10 * MIN,
    run: 1,
    nextAt: NOW + 20 * MIN,
    replaced: 2,
    tool: { name: 'shell', args: { command: 'npm test' }, status: 'ok', content: 'ok 12 testes' }
  })
  assert.match(
    fire,
    /^\[Agendamento sch-aaaaa disparou · 2026-11-15 10:10 \(UTC-3\) · execução 1 de 5 \(a cada 10 min\) · próxima 10:20 · substitui 2 disparos anteriores/
  )
  assert.match(fire, /Ferramenta shell \{"command":"npm test"\} \(ok\):\nok 12 testes$/)
  const once = scheduleFireText(
    info({
      everyMs: undefined,
      times: undefined,
      tool: undefined,
      message: 'Ligar pro João',
      title: 'Ligar pro João'
    }),
    {
      at: NOW,
      run: 1,
      nextAt: null,
      lateMs: 15 * MIN,
      message: 'Ligar pro João'
    }
  )
  assert.match(once, /disparo único \(encerrado\) · atrasado 15 min/)
  assert.match(once, /\nLembrete: Ligar pro João$/)
  assert.doesNotMatch(once, /Título:/)

  const cancel = scheduleCanceledText(
    [
      info(),
      info({
        id: 'sch-bbbbb',
        tool: undefined,
        message: 'beber água',
        everyMs: undefined,
        times: undefined
      })
    ],
    'app-closed'
  )
  assert.match(
    cancel,
    /^\[Agendamentos cancelados — o app foi fechado: sch-aaaaa \(shell "npm test", a cada 10 min, 5 vezes\); sch-bbbbb \(lembrete "beber água", uma vez\)\. Não vão mais disparar/
  )

  const all = [
    info(),
    info({
      id: 'sch-bbbbb',
      status: 'canceled',
      endReason: 'app-closed',
      endedAt: NOW,
      nextAt: undefined
    }),
    info({
      id: 'sch-ccccc',
      status: 'done',
      endReason: 'completed',
      endedAt: NOW,
      nextAt: undefined
    })
  ]
  const list = formatScheduleList(all, [], NOW)
  assert.match(list, /^\[1 agendamento ativo/)
  assert.match(
    list,
    /sch-aaaaa · "Checar build" · shell "npm test" · a cada 10 min, 5 vezes · próximo 10:10 \(daqui a 10 min\)/
  )
  assert.doesNotMatch(list, /sch-bbbbb|sch-ccccc/)
  assert.match(list, /2 encerrados ou cancelados não aparecem/)
  const byId = formatScheduleList(all, ['sch-bbbbb', 'sch-zzzzz'], NOW)
  assert.match(
    byId,
    /^sch-bbbbb — cancelado em 2026-11-15 10:00 \(UTC-3\) \(cancelado: o app foi fechado\)/
  )
  assert.match(byId, /ferramenta: shell \{"command":"npm test"\}/)
  assert.match(byId, /sch-zzzzz — não encontrado neste chat/)
  assert.match(formatScheduleList([], [], NOW), /nenhum agendamento ativo/)
})

// ---------------- 2. motor com relógio falso ----------------

type SchedMods = {
  scheduler: typeof import('../src/main/schedule/scheduler.ts')
  store: typeof import('../src/main/schedule/store.ts')
}
let sm: SchedMods | null = null
async function schedMods(): Promise<SchedMods> {
  sm ??= {
    scheduler: await import('../src/main/schedule/scheduler.ts'),
    store: await import('../src/main/schedule/store.ts')
  }
  return sm
}

class FakeClock {
  t = NOW
  timers: { at: number; fn: () => void; id: number }[] = []
  seq = 0
  now = (): number => this.t
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout = (id: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== id)
  }
  /** Avança o relógio rodando os timers vencidos (e o que eles dispararem). */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at)
      const next = this.timers[0]
      if (!next || next.at > end) break
      this.timers.shift()
      this.t = Math.max(this.t, next.at)
      next.fn()
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    }
    this.t = end
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fakeHost(over: Partial<import('../src/main/schedule/scheduler.ts').ScheduleHost> = {}) {
  const log = {
    delivered: [] as { id: string; text: string; meta: any; replace?: string }[],
    notices: [] as { sid: string; text: string; meta: any }[],
    changes: [] as string[],
    queue: new Set<string>(),
    tools: [] as string[]
  }
  let q = 0
  const host = {
    sessionOk: () => true,
    canRun: () => ({ ok: true }) as const,
    runTool: async (s: ScheduleInfo) => {
      log.tools.push(s.id)
      return { status: 'ok' as const, content: `saída ${log.tools.length}`, durationMs: 5 }
    },
    isQueued: (_sid: string, qid: string) => log.queue.has(qid),
    deliver: (s: ScheduleInfo, text: string, meta: any, replace?: string) => {
      log.delivered.push({ id: s.id, text, meta, ...(replace ? { replace } : {}) })
      if (replace) log.queue.delete(replace)
      return {}
    },
    notice: (sid: string, text: string, meta: any) => {
      log.notices.push({ sid, text, meta })
      return true
    },
    onChange: (chatId: string) => log.changes.push(chatId),
    ...over
  }
  return { host, log, queueNext: () => `q${++q}` }
}

let chatSeq = 0
const spec = (p: Record<string, unknown> = {}): any => ({
  title: 'T',
  message: 'lembrete',
  startAt: NOW + MIN,
  ...p
})

test('motor: disparo único entrega o lembrete e encerra como concluído', async () => {
  const { scheduler, store } = await schedMods()
  const clock = new FakeClock()
  const { host, log } = fakeHost()
  const sch = new scheduler.Scheduler(host as any, clock)
  const chat = `c${++chatSeq}`
  const s = sch.create(spec(), chat, 's1')
  assert.equal(s.status, 'active')
  await clock.advance(59_000)
  assert.equal(log.delivered.length, 0)
  await clock.advance(2_000)
  assert.equal(log.delivered.length, 1)
  assert.equal(log.delivered[0].meta.kind, 'schedule')
  assert.equal(log.delivered[0].meta.synthetic, true)
  assert.equal(log.delivered[0].meta.schedule.event, 'fire')
  assert.equal(log.delivered[0].meta.schedule.nextAt, null)
  assert.match(log.delivered[0].text, /Lembrete: lembrete/)
  const after = store.scheduleRepo.get(s.id)!
  assert.equal(after.status, 'done')
  assert.equal(after.endReason, 'completed')
  assert.equal(after.runs, 1)
  sch.dispose()
})

test('motor: repetição com tool, times, e o disparo ainda na fila é substituído', async () => {
  const { scheduler, store } = await schedMods()
  const clock = new FakeClock()
  const f = fakeHost()
  let n = 0
  f.host.deliver = (s: ScheduleInfo, text: string, meta: any, replace?: string) => {
    f.log.delivered.push({ id: s.id, text, meta, ...(replace ? { replace } : {}) })
    if (replace) f.log.queue.delete(replace)
    const qid = `q${++n}`
    f.log.queue.add(qid) // agente ocupado: tudo fica na fila
    return { queuedId: qid }
  }
  const sch = new scheduler.Scheduler(f.host as any, clock)
  const chat = `c${++chatSeq}`
  const s = sch.create(
    spec({
      message: undefined,
      tool: { name: 'shell', args: { command: 'date' } },
      everyMs: 10 * MIN,
      times: 3,
      startAt: NOW + 10 * MIN
    }),
    chat,
    's1'
  )
  await clock.advance(10 * MIN)
  await clock.advance(10 * MIN)
  assert.equal(f.log.delivered.length, 2)
  assert.equal(f.log.delivered[1].replace, 'q1') // o 1º ainda estava na fila: substituído
  assert.equal(f.log.delivered[1].meta.schedule.replaced, 1)
  f.log.queue.clear() // o agente leu
  await clock.advance(10 * MIN)
  assert.equal(f.log.delivered.length, 3)
  assert.equal(f.log.delivered[2].replace, undefined)
  assert.equal(f.log.delivered[2].meta.schedule.run, 3)
  assert.equal(f.log.delivered[2].meta.schedule.nextAt, null)
  assert.match(f.log.delivered[2].text, /execução 3 de 3 \(a cada 10 min\) · foi a última/)
  assert.match(f.log.delivered[2].text, /Ferramenta shell \{"command":"date"\} \(ok\):\nsaída 3/)
  assert.equal(store.scheduleRepo.get(s.id)!.status, 'done')
  await clock.advance(30 * MIN)
  assert.equal(f.log.tools.length, 3)
  sch.dispose()
})

test('motor: parar (agente/usuário), já encerrado, de outro chat; limite de ativos por chat', async () => {
  const { scheduler } = await schedMods()
  const clock = new FakeClock()
  const { host, log } = fakeHost()
  const sch = new scheduler.Scheduler(host as any, clock)
  const chat = `c${++chatSeq}`
  const a = sch.create(spec({ everyMs: MIN }), chat, 's1')
  const b = sch.create(spec(), chat, 's1')
  const r = sch.stop(chat, [a.id, 'sch-zzzzz'], 'agent')
  assert.deepEqual(
    r.stopped.map((s) => [s.id, s.status, s.endReason]),
    [[a.id, 'stopped', 'agent']]
  )
  assert.deepEqual(r.missing, ['sch-zzzzz'])
  assert.equal(sch.stop(chat, [a.id], 'user').already.length, 1)
  assert.deepEqual(sch.stop('outro', [b.id], 'user').missing, [b.id])
  await clock.advance(5 * MIN)
  assert.deepEqual(
    log.delivered.map((d) => d.id),
    [b.id]
  ) // o parado não disparou
  const many = `c${++chatSeq}`
  for (let i = 0; i < 20; i++) sch.create(spec({ startAt: NOW + H }), many, 's1')
  assert.throws(
    () => sch.create(spec({ startAt: NOW + H }), many, 's1'),
    /já tem 20 agendamentos ativos/
  )
  sch.dispose()
})

test('motor: fechar o app cancela tudo e grava UM aviso por chat (sem disparo depois)', async () => {
  const { scheduler, store } = await schedMods()
  const clock = new FakeClock()
  const { host, log } = fakeHost()
  const sch = new scheduler.Scheduler(host as any, clock)
  const chat = `c${++chatSeq}`
  const a = sch.create(spec({ everyMs: 5 * MIN }), chat, 's-x')
  const b = sch.create(spec({ startAt: NOW + H }), chat, 's-x')
  sch.shutdown()
  // (o banco é o mesmo dos outros testes: os ativos de outros chats também recebem aviso)
  const mine = log.notices.filter((n) => n.sid === 's-x')
  assert.equal(mine.length, 1)
  assert.equal(mine[0].meta.schedule.event, 'canceled')
  assert.equal(mine[0].meta.schedule.reason, 'app-closed')
  assert.deepEqual(mine[0].meta.schedule.items.map((i: any) => i.id).sort(), [a.id, b.id].sort())
  assert.match(mine[0].text, /^\[Agendamentos cancelados — o app foi fechado:/)
  for (const id of [a.id, b.id]) {
    const s = store.scheduleRepo.get(id)!
    assert.equal(s.status, 'canceled')
    assert.equal(s.endReason, 'app-closed')
    assert.equal(s.noticePending, undefined)
  }
  await clock.advance(2 * H)
  assert.equal(log.delivered.length, 0)
})

test('motor: fechamento abrupto — no start os ativos viram cancelados, com aviso', async () => {
  const { scheduler, store } = await schedMods()
  const chat = `c${++chatSeq}`
  // ativo gravado por uma execução anterior que caiu
  store.scheduleRepo.save(info({ id: 'sch-crash', chatId: chat, sessionId: 's-crash' }))
  const { host, log } = fakeHost()
  const sch = new scheduler.Scheduler(host as any, new FakeClock())
  sch.init()
  assert.equal(store.scheduleRepo.get('sch-crash')!.status, 'canceled')
  assert.equal(log.notices.length, 1)
  assert.deepEqual(log.notices[0].meta.schedule.items, [{ id: 'sch-crash', title: 'Checar build' }])
  sch.dispose()
})

test('motor: chat passou a rodar em outro aparelho → cancelados; aviso só quando der para escrever', async () => {
  const { scheduler, store } = await schedMods()
  const clock = new FakeClock()
  let gate: any = { ok: true }
  const { host, log } = fakeHost({ canRun: () => gate })
  const sch = new scheduler.Scheduler(host as any, clock)
  const chat = `c${++chatSeq}`
  const a = sch.create(spec({ startAt: NOW + 30 * MIN }), chat, 's1')
  // estado passageiro (divergente): não cancela; o disparo vencido espera 1 min
  gate = { ok: false, retry: true, note: 'divergente' }
  await clock.advance(30 * MIN)
  assert.equal(log.delivered.length, 0)
  assert.equal(store.scheduleRepo.get(a.id)!.status, 'active')
  gate = { ok: true }
  await clock.advance(MIN)
  assert.equal(log.delivered.length, 1)
  const b = sch.create(spec({ startAt: NOW + 3 * H }), chat, 's1')
  gate = { ok: false, note: 'o chat agora roda em "Celular"' }
  await clock.advance(MIN)
  const sb = store.scheduleRepo.get(b.id)!
  assert.equal(sb.status, 'canceled')
  assert.equal(sb.endReason, 'host-changed')
  assert.equal(sb.endNote, 'o chat agora roda em "Celular"')
  assert.equal(log.notices.length, 0) // não pode escrever no chat de outro host
  gate = { ok: true }
  await clock.advance(MIN)
  assert.equal(log.notices.length, 1)
  assert.equal(log.notices[0].meta.schedule.reason, 'host-changed')
  assert.match(log.notices[0].text, /o chat passou a rodar em outro aparelho/)
  sch.dispose()
})

test('motor: a tool saiu do chat → entrega o motivo e para; chat apagado → some', async () => {
  const { scheduler, store } = await schedMods()
  const clock = new FakeClock()
  const { host, log } = fakeHost({
    runTool: async () => ({
      unavailable: 'A ferramenta shell não está mais disponível neste chat.'
    })
  })
  const sch = new scheduler.Scheduler(host as any, clock)
  const chat = `c${++chatSeq}`
  const a = sch.create(
    spec({ message: undefined, tool: { name: 'shell', args: { command: 'x' } }, everyMs: MIN }),
    chat,
    's1'
  )
  await clock.advance(MIN)
  assert.equal(log.delivered.length, 1)
  assert.equal(log.delivered[0].meta.schedule.tool.status, 'denied')
  assert.match(
    log.delivered[0].text,
    /\(bloqueada\):\nA ferramenta shell não está mais disponível neste chat\. O agendamento foi parado\./
  )
  const s = store.scheduleRepo.get(a.id)!
  assert.equal(s.status, 'stopped')
  assert.equal(s.endReason, 'tool-unavailable')
  await clock.advance(5 * MIN)
  assert.equal(log.delivered.length, 1)

  let ok = true
  const g = fakeHost({ sessionOk: () => ok })
  const sch2 = new scheduler.Scheduler(g.host as any, clock)
  const chat2 = `c${++chatSeq}`
  const b = sch2.create(spec({ startAt: clock.now() + MIN }), chat2, 's1')
  ok = false
  await clock.advance(MIN)
  assert.equal(g.log.delivered.length, 0)
  assert.equal(store.scheduleRepo.get(b.id), null)
  sch.dispose()
  sch2.dispose()
})

// ---------------- 3. runner real ----------------

const MODEL = 'fake/agent'
let server: Server
let base = ''
let calls = 0
const bodies: any[] = []
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''
async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 5 } } : {}) })}\n\n`

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000 }] }))
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      bodies.push(body)
      calls++
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      const full = (t: string): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(chunk(body.model, { role: 'assistant', content: t }))
        res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
      }
      if (last?.role === 'tool') return full('FIM')
      if (/^\[Agendamento sch-/.test(lastUser)) return full(`VI ${lastUser.slice(13, 22)}`)
      const call = /^CALL (.+)$/m.exec(lastUser)
      if (call) {
        const c = JSON.parse(call[1])
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(
          chunk(body.model, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${calls}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) }
              }
            ]
          })
        )
        res.end(chunk(body.model, {}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      return full(`R${calls}`)
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

type Mods = {
  runner: typeof import('../src/main/agent/runner.ts')
  repo: typeof import('../src/main/repo.ts')
  service: typeof import('../src/main/schedule/service.ts')
  approvals: typeof import('../src/main/agent/approvals.ts')
  settings: typeof import('../src/main/approvalSettings.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    runner: await import('../src/main/agent/runner.ts'),
    repo: await import('../src/main/repo.ts'),
    service: await import('../src/main/schedule/service.ts'),
    approvals: await import('../src/main/agent/approvals.ts'),
    settings: await import('../src/main/approvalSettings.ts')
  }
  ;(await import('../src/main/attachments.ts')).setAttachmentsDir(join(TMP, 'attachments'))
  mods.runner.initRunner()
  mods.service.initScheduler()
  return mods
}

after(async () => {
  if (mods) {
    mods.runner.shutdownRunner()
    mods.service.shutdownScheduler()
    ;(await import('../src/main/db.ts')).closeDb()
  }
  server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 10_000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(20)
  }
}

let providerId = ''
async function newChat(
  extra: Record<string, unknown> = {}
): Promise<{ chatId: string; sid: string }> {
  const m = await load()
  providerId ||= m.repo.providersRepo.create({
    name: 'Falso',
    baseUrl: base,
    apiKey: 'k',
    headers: {}
  } as any).id
  const { chat, session } = m.repo.chatsRepo.create({
    config: {
      providerId,
      model: MODEL,
      cwd: TMP,
      enabledTools: ['schedule', 'schedule_list', 'schedule_stop', 'datetime', 'shell'],
      toolsCompact: false,
      ...extra
    } as any
  })
  return { chatId: chat.id, sid: session.id }
}
const path = (sid: string): any[] => mods!.repo.messagesRepo.path(sid)
const idle = (sid: string): boolean => !mods!.runner.isRunning(sid)
const say = (sid: string, name: string, args: Record<string, unknown>): void => {
  mods!.runner.send(sid, `CALL ${JSON.stringify({ name, arguments: args })}`)
}
const lastTool = (sid: string): any =>
  [...path(sid)].reverse().find((m) => m.message.role === 'tool')

test('runner: tools só na principal; schedule com "Sempre permitir" cria, dispara e acorda o agente com a saída', async () => {
  const { sid, chatId } = await newChat({ approvalModes: { schedule: 'always' } })
  const m = mods!
  const chat = m.repo.chatsRepo.get(chatId)!
  const avail = (await import('../src/main/agent/request.ts')).availableTools
  assert.ok(avail(chat, { id: sid, depth: 0 } as any).includes('schedule'))
  assert.ok(!avail(chat, { id: 'x', depth: 1 } as any).includes('schedule'))

  say(sid, 'schedule', {
    tool: 'datetime',
    args: { format: '%Y' },
    in: '1s',
    message: 'veja o ano'
  })
  await waitFor(() => idle(sid) && lastTool(sid), 5000, 'tool result')
  const created = lastTool(sid)
  assert.equal(created.meta.toolStatus, 'ok', created.message.content)
  const id = /Agendamento (sch-[a-z0-9]{5}) criado/.exec(created.message.content)![1]
  assert.match(
    created.message.content,
    /datetime "\{"format":"%Y"\}" \+ lembrete "veja o ano" — uma vez, dispara em/
  )
  assert.deepEqual(created.meta.approval, { item: 'schedule', mode: 'always' })
  // disparo: mensagem kind schedule → o agente acorda e responde
  const fire = await waitFor(
    () => path(sid).find((x) => x.meta.kind === 'schedule'),
    6000,
    'disparo'
  )
  assert.equal(fire.message.role, 'user')
  assert.equal(fire.meta.synthetic, true)
  assert.equal(fire.meta.schedule.event, 'fire')
  assert.equal(fire.meta.schedule.tool.status, 'ok')
  assert.match(fire.message.content, new RegExp(`^\\[Agendamento ${id} disparou`))
  assert.match(
    fire.message.content,
    /Lembrete: veja o ano\nFerramenta datetime \{"format":"%Y"\} \(ok\):\n20\d\d/
  )
  await waitFor(
    () => idle(sid) && path(sid).at(-1).message.content === `VI ${id}`,
    5000,
    'resposta ao disparo'
  )
  // o modelo recebeu o disparo como mensagem do usuário
  assert.match(textOf(bodies.at(-1).messages.at(-1).content), /^\[Agendamento sch-/)
  assert.equal(
    m.service
      .scheduler()
      .list(chatId)
      .find((s) => s.id === id)!.status,
    'done'
  )

  // list / stop
  say(sid, 'schedule', { message: 'depois', every: '1h' })
  await waitFor(() => idle(sid) && /criado/.test(lastTool(sid)?.message.content), 5000)
  const id2 = /Agendamento (sch-[a-z0-9]{5}) criado/.exec(lastTool(sid).message.content)![1]
  say(sid, 'schedule_list', {})
  await waitFor(() => idle(sid) && /agendamento ativo/.test(lastTool(sid)?.message.content), 5000)
  const list = lastTool(sid).message.content
  assert.match(list, new RegExp(`${id2} · "depois"`))
  assert.doesNotMatch(list, new RegExp(id)) // o concluído não aparece sem ids
  assert.match(list, /1 encerrado ou cancelado não aparece/)
  say(sid, 'schedule_list', { ids: [id] })
  await waitFor(
    () => idle(sid) && new RegExp(`^${id} — concluído`).test(lastTool(sid)?.message.content),
    5000
  )
  say(sid, 'schedule_stop', { ids: [id2] })
  await waitFor(() => idle(sid) && /Parado/.test(lastTool(sid)?.message.content), 5000)
  assert.equal(
    m.service
      .scheduler()
      .list(chatId)
      .find((s) => s.id === id2)!.endReason,
    'agent'
  )
})

test('runner: aprovação — o mais restritivo vale; card Permitir cria; blacklist bloqueia sem card', async () => {
  const m = await load()
  m.settings.updateApprovalSettings({
    modes: { schedule: 'always', commands: 'lists' },
    lists: { commands: { allow: ['echo *'], deny: ['rm *'] } }
  } as any)
  const { sid, chatId } = await newChat()
  // shell fora da whitelist: mesmo com "Agendamentos: Sempre permitir", pergunta
  say(sid, 'schedule', { tool: 'shell', args: { command: 'npm test' }, in: '1h' })
  const req = await waitFor(
    () => m.approvals.listApprovals().find((a) => a.sessionId === sid),
    5000,
    'card'
  )
  assert.equal(req.toolName, 'schedule')
  m.runner.approve(req.id, 'allow')
  await waitFor(
    () => idle(sid) && /criado/.test(lastTool(sid)?.message.content),
    5000,
    'criado após card'
  )
  assert.deepEqual(lastTool(sid).meta.approval.userAllowed?.length, 1)
  // whitelist: roda sem card
  say(sid, 'schedule', { tool: 'shell', args: { command: 'echo oi' }, in: '1h' })
  await waitFor(
    () => idle(sid) && /echo oi/.test(lastTool(sid)?.message.content),
    5000,
    'whitelist'
  )
  assert.equal(lastTool(sid).meta.toolStatus, 'ok')
  // blacklist: negado sem card, nada criado
  const before = m.service.scheduler().list(chatId).length
  say(sid, 'schedule', { tool: 'shell', args: { command: 'rm -rf build' }, in: '1h' })
  await waitFor(() => idle(sid) && lastTool(sid)?.meta.toolStatus === 'denied', 5000, 'blacklist')
  assert.match(
    lastTool(sid).message.content,
    /Bloqueado pela blacklist \(comandos\).*o agendamento NÃO foi criado/
  )
  assert.equal(m.service.scheduler().list(chatId).length, before)
  // padrão "Perguntar" + Negar
  m.settings.updateApprovalSettings({ modes: { schedule: 'lists' } } as any)
  say(sid, 'schedule', { message: 'oi', in: '1h' })
  const r2 = await waitFor(
    () => m.approvals.listApprovals().find((a) => a.sessionId === sid),
    5000,
    'card 2'
  )
  m.runner.approve(r2.id, 'deny')
  await waitFor(() => idle(sid) && lastTool(sid)?.meta.toolStatus === 'denied', 5000, 'negado')
  assert.equal(m.service.scheduler().list(chatId).length, before)
  // argumentos inválidos: erro sem card
  say(sid, 'schedule', { message: 'x', every: '10s' })
  await waitFor(() => idle(sid) && lastTool(sid)?.meta.toolStatus === 'error', 5000, 'inválido')
  assert.match(lastTool(sid).message.content, /mínimo 1 min/)
})

test('runner: fechar o app grava o aviso (sem acordar o agente) com os ids', async () => {
  const m = await load()
  m.settings.updateApprovalSettings({ modes: { schedule: 'always' } } as any)
  const { sid } = await newChat()
  say(sid, 'schedule', { message: 'mais tarde', in: '2h' })
  await waitFor(() => idle(sid) && /criado/.test(lastTool(sid)?.message.content), 5000)
  const id = /Agendamento (sch-[a-z0-9]{5}) criado/.exec(lastTool(sid).message.content)![1]
  const n = calls
  m.service.shutdownScheduler()
  const notice = path(sid).at(-1)
  assert.equal(notice.meta.kind, 'schedule')
  assert.equal(notice.meta.schedule.event, 'canceled')
  assert.match(
    notice.message.content,
    new RegExp(
      `^\\[Agendamento cancelado — o app foi fechado: ${id} \\(lembrete "mais tarde", uma vez\\)`
    )
  )
  await sleep(300)
  assert.equal(calls, n) // não acordou
  assert.ok(idle(sid))
})
