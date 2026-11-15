// Chamada de voz no histórico (SPEC → "Chamada de voz → Histórico e custos"): o ícone de voz nos
// balões (mic = fala do usuário / ditado; alto-falante = resposta falada), os marcadores de
// início/fim da chamada (mensagens só de exibição — kind 'voice-call') e a linha compacta do
// `end_call`. Os textos e o detalhamento de custos são puros (@shared/voiceCallMarks).
import { Mic, Phone, PhoneOff, Volume2 } from 'lucide-react'
import type { StoredMessage, ToolCall } from '@shared/types'
import {
  callCostSummary,
  callNoteFor,
  callUsageLines,
  endedByText,
  formatCallDuration,
  voiceBadgeText,
  type VoiceMessageMeta
} from '@shared/voiceCallMarks'
import { cn } from '../../lib/format'
import { formatTime } from '../../lib/dates'
import { Tip } from '../ui/Tooltip'

/** Ícone de voz ao lado da hora (mic/alto-falante) com o tooltip dos detalhes. */
export function VoiceBadge({
  voice,
  role
}: {
  voice: VoiceMessageMeta | undefined
  role: 'user' | 'assistant'
}): React.JSX.Element | null {
  if (!voice) return null
  const Icon = role === 'assistant' ? Volume2 : Mic
  const label = voiceBadgeText(voice, role)
  return (
    <Tip label={label}>
      <span
        data-testid="voice-badge"
        data-source={voice.source}
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 cursor-default items-center text-faint transition-colors group-hover/msg:text-subtle',
          voice.source === 'dictation' && 'opacity-70'
        )}
      >
        <Icon className="size-3" />
      </span>
    </Tip>
  )
}

/**
 * Divisor de início/fim da chamada (custos no fim; detalhamento no tooltip). O tooltip mostra a nota
 * exata que o marcador põe na request (no começo da próxima mensagem sua — `withCallNotes`).
 */
export function CallMarker({ msg }: { msg: StoredMessage }): React.JSX.Element | null {
  const mark = msg.meta.voiceCall
  if (!mark) return null
  const start = mark.phase === 'start'
  const cost = start ? null : callCostSummary(mark.usage)
  const lines = start ? [] : callUsageLines(mark)
  const note = (
    <span data-testid="call-marker-note" className="col-span-2 max-w-72 text-subtle">
      Vai ao modelo, no começo da sua próxima mensagem: “{callNoteFor(mark.phase)}”
    </span>
  )
  const pill = (
    <span
      className={cn(
        'inline-flex max-w-full cursor-default items-center gap-1.5 rounded-full border border-border bg-elevated/90 px-2.5 py-0.5 text-[11px] text-muted shadow-[0_1px_2px_rgb(0_0_0/0.25)]',
        !start && mark.endedBy === 'error' && 'border-danger/40 text-danger/90'
      )}
    >
      {start ? (
        <Phone className="size-3 shrink-0 text-accent-strong" />
      ) : (
        <PhoneOff className="size-3 shrink-0" />
      )}
      <span className="truncate">
        {start ? (
          <>Chamada de voz · {formatTime(mark.startedAt)}</>
        ) : (
          <>
            Chamada encerrada · {formatCallDuration(mark.durationMs ?? 0)} · {endedByText(mark)}
            {cost && <span className="tabular-nums"> · {cost}</span>}
          </>
        )}
      </span>
    </span>
  )
  return (
    <div
      data-testid="call-marker"
      data-phase={mark.phase}
      data-call-id={mark.callId}
      className="flex items-center gap-3 py-3 select-none"
    >
      <span className="h-px flex-1 bg-border/70" />
      <Tip
        label={
          <span data-testid="call-marker-tip" className="grid grid-cols-[auto_auto] gap-x-3">
            {lines.map(([k, v]) => (
              <span key={k} className="contents">
                <span className="text-subtle">{k}</span>
                <span className="tabular-nums">{v}</span>
              </span>
            ))}
            {lines.length > 0 && <span className="col-span-2 h-1" />}
            {note}
          </span>
        }
      >
        {pill}
      </Tip>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  )
}

/** `end_call` no histórico: linha compacta de sistema (sem card de tool). */
export function EndCallLine({
  call,
  result
}: {
  call: Pick<ToolCall, 'function'> | { function: { name: string; arguments: string } }
  result?: StoredMessage
}): React.JSX.Element {
  let reason = ''
  try {
    const a = JSON.parse(call.function.arguments || '{}') as { reason?: unknown }
    if (typeof a.reason === 'string') reason = a.reason.trim()
  } catch {
    reason = ''
  }
  const failed = !!result && result.meta.toolStatus !== 'ok'
  return (
    <div
      data-testid="end-call-line"
      className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-subtle italic"
    >
      <PhoneOff className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        {failed
          ? 'Encerrar chamada: não executado'
          : result
            ? 'Chamada encerrada pelo agente'
            : 'Encerrando a chamada…'}
        {reason && <span className="text-faint"> · {reason}</span>}
      </span>
    </div>
  )
}
