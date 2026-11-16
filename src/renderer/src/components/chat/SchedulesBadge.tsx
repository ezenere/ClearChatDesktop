// Chip "N agendamentos" no header do chat (tool `schedule`) + popover com os ativos (o quê, quando,
// próximo disparo, execuções, Parar) e os encerrados recentes (por que encerrou; "Limpar" só tira
// da tela — o agente continua consultando pelo id). A lista vem do main (ou do host, num chat
// executado em outro aparelho: Parar vira o comando `schedule.stop`).
import { AlarmClock, AlarmClockOff, Bell, ChevronRight, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  END_REASON_TEXT,
  fmtLocalDateTime,
  fmtRelative,
  fmtRepeat,
  fmtShortWhen,
  scheduleToolSummary,
  type ScheduleInfo
} from '@shared/schedule'
import { cn } from '../../lib/format'
import { selectSchedules, useStore } from '../../store'
import { Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'
import { barAttrs, useBarLevel } from '../../lib/useBarCollapse'
import { readCleared, schedulesChip, visibleEnded, writeCleared } from './scheduleFormat'

function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    // primeiro tique logo (ao abrir o popover o "daqui a N" não espera o intervalo inteiro)
    const first = setTimeout(() => setNow(Date.now()), 0)
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => {
      clearTimeout(first)
      clearInterval(t)
    }
  }, [active, ms])
  return now
}

const RUN_LABEL = { ok: 'ok', error: 'erro', denied: 'bloqueada' } as const

function What({ s }: { s: ScheduleInfo }): React.JSX.Element {
  return (
    <div className="mt-1 space-y-0.5 pl-3.5">
      {s.tool && (
        <Tip label={`${s.tool.name} ${JSON.stringify(s.tool.args, null, 2)}`}>
          <p className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted">
            <Wrench className="size-3 shrink-0 text-faint" />
            <span className="truncate">{scheduleToolSummary(s.tool, 90)}</span>
          </p>
        </Tip>
      )}
      {s.message && s.message !== s.title && (
        <p className="flex min-w-0 items-start gap-1.5 text-[11.5px] leading-snug text-muted">
          <Bell className="mt-0.5 size-3 shrink-0 text-faint" />
          <span className="line-clamp-2">{s.message}</span>
        </p>
      )}
    </div>
  )
}

function ActiveRow({
  chatId,
  s,
  now
}: {
  chatId: string
  s: ScheduleInfo
  now: number
}): React.JSX.Element {
  const stopSchedule = useStore((st) => st.stopSchedule)
  const [stopping, setStopping] = useState(false)
  const last = s.history.at(-1)
  return (
    <div
      data-testid="schedule-item"
      className="border-b border-border/60 px-3 py-2 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            s.firing ? 'animate-pulse-soft bg-accent' : 'bg-success'
          )}
        />
        <span className="font-mono text-[11px] text-faint">{s.id}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg/90">
          {s.title}
        </span>
        <Tip label={s.nextAt ? fmtLocalDateTime(s.nextAt) : ''}>
          <span
            data-testid="schedule-next"
            className="shrink-0 text-[11px] tabular-nums text-subtle"
          >
            {s.firing
              ? 'disparando…'
              : s.nextAt
                ? `${fmtShortWhen(s.nextAt, now)} · ${fmtRelative(s.nextAt, now)}`
                : ''}
          </span>
        </Tip>
      </div>
      <What s={s} />
      <div className="mt-1.5 flex items-center gap-2 pl-3.5 text-[11px] text-faint">
        <span>{fmtRepeat(s)}</span>
        {s.runs > 0 && (
          <span>
            · {s.runs}
            {s.times ? ` de ${s.times}` : ''} {s.runs === 1 ? 'execução' : 'execuções'}
            {last && (
              <span className={cn(last.status !== 'ok' && 'text-danger/80')}>
                {' '}
                (última: {RUN_LABEL[last.status]})
              </span>
            )}
          </span>
        )}
        <button
          type="button"
          data-testid="schedule-stop"
          disabled={stopping}
          onClick={() => {
            setStopping(true)
            void stopSchedule(chatId, s.id).finally(() => setStopping(false))
          }}
          className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-danger/85 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
        >
          <AlarmClockOff className="size-3" />
          {stopping ? 'Parando…' : 'Parar'}
        </button>
      </div>
    </div>
  )
}

function EndedRow({ s, now }: { s: ScheduleInfo; now: number }): React.JSX.Element {
  return (
    <div data-testid="schedule-ended" className="px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            s.status === 'canceled' ? 'bg-warning/80' : 'bg-faint'
          )}
        />
        <span className="font-mono text-[11px] text-faint">{s.id}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg/75">{s.title}</span>
        <Tip label={s.endedAt ? fmtLocalDateTime(s.endedAt) : ''}>
          <span className="shrink-0 text-[11px] tabular-nums text-faint">
            {s.endedAt ? fmtRelative(s.endedAt, now) : ''}
          </span>
        </Tip>
      </div>
      <p className="mt-0.5 pl-3.5 text-[11px] text-subtle">
        {END_REASON_TEXT[s.endReason ?? 'completed']}
        {s.runs ? ` · ${s.runs} ${s.runs === 1 ? 'execução' : 'execuções'}` : ''}
      </p>
    </div>
  )
}

export function SchedulesBadge({ chatId }: { chatId: string }): React.JSX.Element | null {
  const list = useStore(selectSchedules(chatId))
  const [open, setOpen] = useState(false)
  const [cleared, setCleared] = useState(() => readCleared(chatId))
  const [showEnded, setShowEnded] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const level = useBarLevel('schedules')
  // o chip mostra "próximo em N min": atualiza a cada 30 s fechado, a cada 1 s aberto
  const now = useNow(list.length > 0, open ? 1000 : 30_000)
  const [prevChat, setPrevChat] = useState(chatId)
  if (prevChat !== chatId) {
    setPrevChat(chatId)
    setCleared(readCleared(chatId))
    setShowEnded(false)
  }
  const chip = schedulesChip(list, cleared)
  // lista esvaziou: fecha o popover junto com o chip (não reabre sozinho)
  if (!chip && open) setOpen(false)
  if (!chip) return null
  const active = list.filter((s) => s.status === 'active')
  const ended = visibleEnded(list, cleared)
  const n = chip.count
  const isActive = chip.kind === 'active'
  const s = n === 1 ? '' : 's'
  const tip = isActive
    ? `Agendamentos deste chat${chip.nextAt ? ` — próximo ${fmtShortWhen(chip.nextAt, now)} (${fmtRelative(chip.nextAt, now)})` : ''}`
    : `${n} agendamento${s} encerrado${s}${chip.canceled ? ` (${chip.canceled} cancelado${chip.canceled === 1 ? '' : 's'})` : ''} — ver/limpar`
  return (
    <>
      <Tip side="bottom" label={tip}>
        <button
          ref={anchor}
          type="button"
          data-testid="schedules-badge"
          {...barAttrs('schedules', level)}
          data-state={isActive ? 'active' : 'ended'}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={isActive ? `${n} agendamento${s} ativo${s}` : tip}
          className={cn(
            'no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs whitespace-nowrap transition-colors',
            isActive
              ? 'border-accent/25 bg-accent/[0.06] text-accent-strong/90 hover:bg-accent/[0.12]'
              : 'border-border text-muted hover:border-border-strong hover:text-fg'
          )}
        >
          <span className="relative flex">
            <AlarmClock className="size-3.5" />
            {!isActive && chip.canceled > 0 && (
              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-bg" />
            )}
          </span>
          <span className="tabular-nums">
            {level === 0 ? `${n} ${isActive ? `agendamento${s}` : `encerrado${s}`}` : n}
          </span>
        </button>
      </Tip>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        width={440}
        align="end"
        maxHeight={760}
      >
        <div data-testid="schedules-popover" className="flex min-h-0 flex-1 flex-col py-1">
          <div className="shrink-0 px-3 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-subtle uppercase">
            Agendamentos
            {active.length > 0 && (
              <span className="ml-1.5 font-normal tracking-normal normal-case text-faint">
                · {active.length} ativo{active.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <div
            data-testid="schedules-list"
            className="max-h-[60vh] min-h-0 flex-1 overflow-y-auto overscroll-contain border-y border-border/40"
          >
            {active.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-subtle">Nenhum agendamento ativo.</p>
            ) : (
              active.map((x) => <ActiveRow key={x.id} chatId={chatId} s={x} now={now} />)
            )}
            {ended.length > 0 && (
              <div className="border-t border-border/40">
                <div className="flex items-center px-3 py-1.5">
                  <button
                    type="button"
                    data-testid="schedules-ended-toggle"
                    onClick={() => setShowEnded((v) => !v)}
                    className="flex items-center gap-1 text-[11.5px] text-muted hover:text-fg"
                  >
                    <ChevronRight
                      className={cn('size-3 transition-transform', showEnded && 'rotate-90')}
                    />
                    Encerrados · {ended.length}
                  </button>
                  <Tip label="Tira os encerrados da tela (o agente ainda os consulta pelo id)">
                    <button
                      type="button"
                      data-testid="schedules-clear"
                      onClick={() => {
                        const at = Date.now()
                        writeCleared(chatId, at)
                        setCleared(at)
                      }}
                      className="ml-auto rounded-md px-1.5 py-0.5 text-[11.5px] text-muted hover:bg-hover hover:text-fg"
                    >
                      Limpar
                    </button>
                  </Tip>
                </div>
                {(showEnded || active.length === 0) &&
                  ended.map((x) => <EndedRow key={x.id} s={x} now={now} />)}
              </div>
            )}
          </div>
          <p className="shrink-0 px-3 pt-1.5 text-[11px] leading-snug text-faint">
            Rodam só com o ClearChat aberto, no aparelho que executa o chat. Fechar o app cancela
            todos — o agente recebe um aviso com os ids.
          </p>
        </div>
      </Popover>
    </>
  )
}
