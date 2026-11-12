// Painel da chamada de voz (dock — SPEC → "Chamada de voz → Timeline e log de diagnóstico"): toggle
// rápido dos preâmbulos (fillers) refletindo e gravando o `ChatConfig.voice` do chat da chamada
// (★ = segue o padrão global — escolher a opção ★ remove o override, como em
// `ChatApprovalSection`), contagens (preâmbulos, frases de demora e de ferramenta tocados, por que
// não tocaram),
// o modelo da chamada e a timeline da chamada atual (sem visualização pós-chamada na v1 — as
// decisões de preâmbulo ficam no log de diagnóstico `voice-eval/*.jsonl`).
import { useMemo } from 'react'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import { computeVoiceCallMetrics } from '@shared/voiceTimeline'
import { useStore } from '../../store'
import { useVoiceCallConfig } from '../../lib/voice/useVoiceCallConfig'
import { InheritChoice } from '../ui/InheritChoice'
import { toolPhraseCategoryShort } from '../../lib/voice/toolPhrases'
import { VoiceCallModelEditor } from './VoiceCallModelEditor'

/** Motivo de um ato de fala curta NÃO tocado → texto do painel (a "leitura de depuração"). */
const SKIP_LABELS: Record<string, string> = {
  // preâmbulos
  disabled: 'desligado',
  'short-speech': 'fala curta demais',
  'below-min-speech': 'fala com pouca voz',
  'no-clip': 'clipe ausente — gere os clipes',
  stopped: 'chamada encerrada',
  spoken: 'a resposta chegou antes',
  'fast-answer': 'a resposta ficou pronta antes da espera',
  'assistant-audio': 'áudio do assistente tocando',
  // frases de demora ("manter viva"/desculpa)
  'answer-first': 'a resposta chegou antes',
  'answer-coming': 'a resposta já está sintetizando',
  'not-ready': 'não ficou pronta antes da resposta',
  'keepalive-playing': '"manter viva" tocando',
  'too-soon': 'outra frase curta tocou há menos de 10 s',
  'clip-playing': 'outro clipe tocando',
  'user-speaking': 'você falando',
  'barge-in': 'barge-in',
  'new-turn': 'turno novo',
  'response-done': 'a resposta terminou',
  'send-failed': 'o envio falhou',
  'no-response': 'sem resposta em voo',
  hangup: 'o agente encerrou a chamada',
  cancelled: 'resposta cancelada',
  // frases de ferramenta (motivo `<categoria>/<motivo>`; `live/` = síntese ao vivo)
  'tool-phrase': 'a frase de ferramenta tocou no lugar',
  'no-phrase': 'sem frase para essa tool',
  announced: 'o assistente já falou antes da tool',
  'after-preamble': 'preâmbulo terminou há menos de 3 s',
  'tool-done': 'a tool terminou antes'
}

/** Por que a fala por cima virou barge-in → texto. */
const BARGE_IN_LABELS: Record<string, string> = {
  voiced: 'você continuou falando',
  words: 'palavras na transcrição',
  'stop-word': 'pediu para parar'
}

/** Motivo (com prefixo `delay/`/`tools/` dos preâmbulos) → texto. */
function skipLabel(reason: string): string {
  if (reason.startsWith('tts-error')) return `falha na síntese${reason.slice(9)}`
  const r = reason.includes('/') ? reason.slice(reason.lastIndexOf('/') + 1) : reason
  return SKIP_LABELS[r] ?? r
}

/** Descrição curta de um evento da timeline (linha do painel). */
function describeTimelineEvent(e: VoiceCallTimelineEvent): string {
  switch (e.kind) {
    case 'decision': {
      if (e.class === 'TOOL') {
        // `<categoria>` | `<categoria>/live` (tocou) · `<categoria>[/live]/<motivo>` (pulada)
        const [cat = '?', ...rest] = (e.reason ?? '?').split('/')
        const live = rest[0] === 'live'
        const why = rest.filter((r) => r !== 'live').join('/')
        const state = e.played ? 'tocou' : `não tocou — ${skipLabel(why || '?')}`
        return `frase de ferramenta (${toolPhraseCategoryShort(cat)}${live ? ' · ao vivo' : ''})${
          e.variant ? ` v${e.variant}` : ''
        } — ${state}${e.text ? ` · "${e.text.slice(0, 40)}"` : ''}`
      }
      const state = e.played ? 'tocou' : `não tocou — ${skipLabel(e.reason ?? '?')}`
      return `decisão ${e.class ?? '?'}${e.variant ? ` v${e.variant}` : ''} — ${state}${
        e.text ? ` · "…${e.text.slice(-24)}"` : ''
      }`
    }
    case 'clip-emitted':
      if (e.class === 'TOOL') return 'frase de ferramenta emitida'
      return e.text
        ? `frase ${e.class ?? '?'} emitida: "${e.text.slice(0, 40)}"`
        : `clipe ${e.class ?? '?'} emitido`
    case 'clip-cancelled':
      return e.class === 'TOOL'
        ? 'frase de ferramenta cancelada'
        : `clipe ${e.class ?? '?'} cancelado`
    case 'sentence-emitted':
      return `sentença: "…${(e.text ?? '').slice(-24)}"`
    case 'turn-sent':
      return `turno enviado: "…${(e.text ?? '').slice(-24)}"`
    case 'speech-start':
      return 'fala detectada'
    case 'speech-end':
      return 'fim da fala'
    case 'clip-start':
      return 'clipe começou a tocar'
    case 'clip-end':
      return 'clipe terminou'
    case 'sentence-start':
      return 'sentença começou a tocar'
    case 'sentence-end':
      return 'sentença terminou'
    case 'heard':
      return `ouvido até: "…${(e.text ?? '').slice(-28)}" (${e.latencyMs ?? 0} ms · ${
        e.reason === 'heard-exact' ? 'exato' : 'estimado'
      })`
    case 'duck':
      return 'fala por cima — volume do assistente abaixou'
    case 'duck-restore':
      return `volume de volta (fala curta descartada · ${e.speechMs ?? 0} ms de voz)`
    case 'barge-in':
      return `barge-in (fala do assistente cancelada${
        e.reason ? ` — ${BARGE_IN_LABELS[e.reason] ?? e.reason}` : ''
      })`
    case 'backchannel':
      return `fala curta por cima (${e.speechMs ?? 0} ms — não cancelou)`
    case 'playback-error':
      return `falha ao tocar ${e.class ?? ''}: ${e.reason ?? '?'}`
    case 'tts-latency':
      return `TTS 1º texto→1º áudio: ${e.latencyMs ?? 0} ms${e.reason ? ` (${e.reason})` : ''}`
    default:
      return e.kind
  }
}

/** Painel recolhível acima do dock (no mesmo fluxo da coluna do composer; só com a chamada ativa). */
export function VoiceCallPanel({ open }: { open: boolean }): React.JSX.Element | null {
  const timeline = useStore((s) => s.voiceCallTimeline)
  const { defaults, resolved, voice, persona, setFillers, setVoice } = useVoiceCallConfig()
  const chatModel = useStore(
    (s) => s.chats.find((c) => c.id === s.voiceCall.chatId)?.config.model ?? ''
  )
  const playbackErrors = timeline.filter((e) => e.kind === 'playback-error').length
  const metrics = useMemo(() => computeVoiceCallMetrics(timeline), [timeline])
  // o que o ★ herda no chat da chamada: a persona de origem, senão o padrão global
  const inheritedFillers = persona?.fillers?.enabled ?? defaults.fillers.enabled
  if (!open) return null
  const t0 = timeline[0]?.ts ?? 0
  return (
    <div
      data-testid="voice-call-panel"
      className="flex w-full flex-col gap-2 rounded-2xl border border-border-strong/70 bg-elevated px-3 py-2.5 shadow-popover"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[11.5px] font-medium text-fg/90">Atos de fala curta</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] text-subtle">Preâmbulos</span>
          <InheritChoice
            label="Preâmbulos"
            testId="voice-call-toggle-fillers"
            options={[
              { value: true, label: 'Ligado' },
              { value: false, label: 'Desligado' }
            ]}
            value={voice.fillers ? voice.fillers.enabled : null}
            inherited={inheritedFillers}
            inheritedFrom={persona?.fillers ? 'Padrão da persona' : 'Padrão global'}
            onChange={(v) => setFillers(v === null ? 'inherit' : { enabled: v })}
          />
        </div>
        <span className="ml-auto text-[10.5px] text-subtle">★ = padrão global</span>
      </div>
      <div
        data-testid="voice-call-metrics"
        className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border/60 pt-1.5 text-[10.5px] text-subtle"
      >
        <span data-testid="voice-call-filler-played">preâmbulos: {metrics.fillerPlayed}</span>
        {metrics.delayPlayed.keepAlive + metrics.delayPlayed.apology > 0 && (
          <span data-testid="voice-call-delay-played">
            frases de demora: {metrics.delayPlayed.keepAlive} manter viva ·{' '}
            {metrics.delayPlayed.apology} desculpa
          </span>
        )}
        {metrics.toolPlayed > 0 && (
          <span data-testid="voice-call-tool-played">
            frases de ferramenta: {metrics.toolPlayed}
          </span>
        )}
        {playbackErrors > 0 && (
          <span data-testid="voice-call-playback-errors" className="text-danger">
            falhas ao tocar: {playbackErrors}
          </span>
        )}
      </div>
      <SkipReadout skipped={metrics.skipped} />
      <details data-testid="voice-call-panel-model" className="border-t border-border/60 pt-1.5">
        <summary className="cursor-pointer text-[11px] text-subtle select-none hover:text-fg">
          Modelo da chamada:{' '}
          <span className="text-fg/80">
            {resolved.model ? resolved.model.model : `o do chat (${chatModel || '—'})`}
          </span>
        </summary>
        <div className="mt-2">
          <VoiceCallModelEditor
            value={voice.model}
            onChange={(model) => setVoice({ model })}
            scope="call"
            compact
            inherited={
              persona?.model
                ? `o da persona (${persona.model.model})`
                : defaults.model
                  ? `o padrão global (${defaults.model.model})`
                  : `o modelo do chat (${chatModel || '—'})`
            }
          />
        </div>
      </details>
      <ul
        data-testid="voice-call-timeline"
        className="max-h-[180px] space-y-0.5 overflow-y-auto font-mono text-[10.5px] leading-4 text-subtle"
      >
        {timeline.length === 0 && <li className="text-faint">sem eventos ainda</li>}
        {timeline.map((e, i) => (
          <li key={`${e.ts}-${i}`} className="flex gap-2">
            <span className="w-[52px] shrink-0 tabular-nums text-faint">
              +{((e.ts - t0) / 1000).toFixed(1)}s
            </span>
            <span className="min-w-0 break-words">{describeTimelineEvent(e)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Por que os atos de fala curta não tocaram (motivo × vezes) — preâmbulos, frases de demora e de
 * ferramenta (estas com a categoria: "web: o assistente já falou antes da tool ×1").
 */
function SkipReadout({
  skipped
}: {
  skipped: {
    filler: Record<string, number>
    delay: Record<string, number>
    tool: Record<string, number>
  }
}): React.JSX.Element | null {
  const row = (
    label: string,
    counts: Record<string, number>,
    testId: string,
    describe: (reason: string) => string = skipLabel
  ): React.JSX.Element | null => {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
    if (!entries.length) return null
    return (
      <div data-testid={testId} className="flex flex-wrap gap-x-2 gap-y-0.5">
        <span className="text-fg/80">{label} não tocou:</span>
        {entries.map(([reason, n]) => (
          <span key={reason} data-reason={reason} title={reason}>
            {describe(reason)} ×{n}
          </span>
        ))}
      </div>
    )
  }
  const a = row('Preâmbulo', skipped.filler, 'voice-call-skips-filler')
  const b = row('Frase de demora', skipped.delay, 'voice-call-skips-delay')
  const c = row('Frase de ferramenta', skipped.tool, 'voice-call-skips-tool', (reason) => {
    const [cat = '?', ...rest] = reason.split('/')
    const why = rest.filter((r) => r !== 'live').join('/')
    return `${toolPhraseCategoryShort(cat)}: ${skipLabel(why || '?')}`
  })
  if (!a && !b && !c) return null
  return (
    <div data-testid="voice-call-skips" className="space-y-0.5 text-[10.5px] text-subtle">
      {a}
      {b}
      {c}
    </div>
  )
}
