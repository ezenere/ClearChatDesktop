// Chamada de voz ativa — a barra da chamada SUBSTITUI o composer do chat da chamada (mesmo lugar e
// largura do card do composer; texto, anexos, mic e enviar somem — nada é digitado no rascunho por
// engano, e o rascunho volta intacto quando a chamada acaba). Mostra a fase ("Ouvindo…/
// Transcrevendo…/Pensando…/Falando…"), waveform do microfone, mudo (captura pausada), volume,
// painel de timeline/toggles ("Atos de fala curta"), "Encerrar", o aviso de clipes ausentes (CTA
// "Gerar clipes") e o card de erro. Em OUTROS chats o composer funciona e
// mostra a pílula "Chamada ativa em <chat>" (`VoiceCallElsewhere`) que leva de volta.
//
// A captura/reprodução vive em `lib/voice/useVoiceCall`, rodada UMA vez por `VoiceCallController`
// (em `App`); o estado de runtime vem de `useVoiceCallRuntime`. O chat continua normal por cima.
// Testids: `voice-call-dock`, `voice-call-status`, `voice-call-waveform`, `voice-call-mute`,
// `voice-call-volume`, `voice-call-end`, `voice-call-error`, `voice-call-pending`,
// `voice-call-panel-toggle`, `voice-call-clips-hint`, `voice-call-elsewhere`
// (painel: `voice-call-panel`); GPU local: `voice-call-preparing` (andamento da fase "Preparando a
// GPU…" — o microfone ainda não abriu), `voice-call-gpu-notice` (+ `-ok` "Entendi", uma vez por
// sessão do app) e `voice-call-gpu-warning` (pouca VRAM livre — avisa, não barra).
import { useEffect, useState } from 'react'
import { formatCallClock } from '@shared/voiceCallMarks'
import {
  Activity,
  Cpu,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Sparkles,
  TriangleAlert,
  Volume2,
  X
} from 'lucide-react'
import {
  DEFAULT_FILLER_POOL,
  DEFAULT_THANKS_POOL,
  DEFAULT_TOOL_PHRASE_POOL,
  type VoiceCallPhase
} from '@shared/voice'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { useVoiceCall } from '../../lib/voice/useVoiceCall'
import { useVoiceCallRuntime } from '../../lib/voice/voiceCallRuntime'
import { Tip } from '../ui/Tooltip'
import { Waveform } from './Waveform'
import { VoiceCallPanel } from './VoiceCallPanel'
import { useVoiceCallConfig } from '../../lib/voice/useVoiceCallConfig'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'

/** Rótulo da fase do turno ("Ouvindo…/Transcrevendo…/Pensando…/Falando…"). */
function phaseLabel(phase: VoiceCallPhase): string {
  switch (phase) {
    case 'transcribing':
      return 'Transcrevendo…'
    case 'thinking':
      return 'Pensando…'
    case 'speaking':
      return 'Falando…'
    default:
      return 'Ouvindo…'
  }
}

/** Controller da chamada (uma vez por app, em `App`): captura/reprodução + reidratação do estado. */
export function VoiceCallController(): null {
  useVoiceCall()
  // reidrata o estado da chamada do main (recarregar o renderer no meio da chamada): o evento
  // `voice:call:state` só chega em transições
  useEffect(() => {
    void api.voice?.call
      .getState?.()
      .then((state) => useStore.getState().applyVoiceCallState(state))
      .catch(() => void 0)
  }, [])
  return null
}

/**
 * Pílula "Chamada ativa em <chat>" no composer de OUTROS chats (o composer de lá funciona normal):
 * leva de volta ao chat da chamada, onde a barra da chamada está.
 */
export function VoiceCallElsewhere(): React.JSX.Element | null {
  const call = useStore((s) => s.voiceCall)
  const title = useStore((s) => s.chats.find((c) => c.id === s.voiceCall.chatId)?.title ?? null)
  const openChat = useStore((s) => s.openChat)
  if (!call.active || !call.chatId) return null
  return (
    <div className="mb-2 flex" data-stack-extra>
      <button
        type="button"
        data-testid="voice-call-elsewhere"
        onClick={() => void openChat(call.chatId!, call.sessionId ?? undefined)}
        className="flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11.5px] text-accent-strong transition-colors hover:bg-accent/20"
      >
        <Phone className="size-3 shrink-0" />
        <span className="min-w-0 truncate">
          Chamada ativa em <strong className="font-medium">{title ?? 'outro chat'}</strong>
        </span>
        <span className="shrink-0 text-subtle">· ir para a chamada</span>
      </button>
    </div>
  )
}

/**
 * Relógio da chamada ("02:13"): desde o `startedAt` do main (sem ele — main antigo —, desde que a
 * barra apareceu). Re-renderiza só ele, 1×/s.
 */
function CallClock({ startedAt }: { startedAt?: number }): React.JSX.Element {
  // sem `startedAt` (main antigo): desde a montagem (a barra remonta por chamada — `key`)
  const [mountedAt] = useState(() => Date.now())
  const since = startedAt ?? mountedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <Tip label="Duração da chamada">
      <span
        data-testid="voice-call-clock"
        className="shrink-0 cursor-default text-[12px] text-subtle tabular-nums"
      >
        {formatCallClock(now - since)}
      </span>
    </Tip>
  )
}

/**
 * Barra da chamada NO LUGAR do composer do chat da chamada (mesma largura/posição do card do
 * composer; o texto fica desabilitado durante a chamada). Painel, aviso de clipes e erro ficam
 * logo acima, no mesmo fluxo da pilha.
 */
export function VoiceCallDock(): React.JSX.Element | null {
  const call = useStore((s) => s.voiceCall)
  const stopVoiceCall = useStore((s) => s.stopVoiceCall)
  const runtimeError = useVoiceCallRuntime((s) => s.error)
  const volume = useVoiceCallRuntime((s) => s.volume)
  const toggleMute = useVoiceCallRuntime((s) => s.toggleMute)
  const setVolume = useVoiceCallRuntime((s) => s.setVolume)
  const clearError = useVoiceCallRuntime((s) => s.clearError)
  const [panelOpen, setPanelOpen] = useState(false)
  if (!call.active) return null
  const error = call.error ?? runtimeError
  const preparing = call.preparing || null
  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <VoiceCallPanel open={panelOpen} />
      <ClipsHint />
      <GpuCallNotice preparing={!!preparing} />
      {error && (
        <div
          role="alert"
          data-testid="voice-call-error"
          className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/[0.08] px-3 py-2 text-[12px] text-danger"
        >
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {!call.error && (
            <button
              type="button"
              aria-label="Dispensar erro da chamada"
              onClick={clearError}
              className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}
      <div
        data-testid="voice-call-dock"
        role="region"
        aria-label="Chamada de voz"
        className="rounded-2xl border border-accent/25 bg-surface shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)]"
      >
        {/* linha 1 (lugar do texto): waveform + fase da chamada + fala pendente */}
        <div className="flex min-w-0 items-center gap-3 px-4 pt-3 pb-1.5">
          <span data-testid="voice-call-waveform" className="flex shrink-0 items-center">
            {preparing ? (
              <span className="flex h-6 w-20 items-center justify-center text-accent-strong">
                <Loader2 className="size-4 animate-spin" />
              </span>
            ) : (
              <DockWaveform muted={call.muted} />
            )}
          </span>
          <span
            data-testid="voice-call-status"
            aria-live="polite"
            className={cn(
              'shrink-0 text-[14px] whitespace-nowrap text-fg/90',
              call.muted && 'text-subtle'
            )}
          >
            {preparing
              ? 'Preparando a GPU…'
              : call.muted
                ? 'Microfone mudo'
                : phaseLabel(call.phase)}
          </span>
          <CallClock key={call.callId ?? call.sessionId ?? ''} startedAt={call.startedAt} />
          <span className="flex min-w-0 flex-1 flex-col">
            {preparing && (
              <span
                data-testid="voice-call-preparing"
                title={preparing}
                className="truncate text-[12px] text-subtle"
              >
                {preparing} — o microfone abre em seguida
              </span>
            )}
            <LiveTranscript />
            {call.pendingText && (
              <span
                data-testid="voice-call-pending"
                title={call.pendingText}
                className="truncate text-[11.5px] text-subtle"
              >
                Próximo: {call.pendingText}
              </span>
            )}
          </span>
        </div>
        {/* linha 2 (lugar do toolbar): controles + Encerrar no lugar do Enviar */}
        <div className="flex min-w-0 items-center gap-2 px-2.5 pb-2.5">
          <Tip label={panelOpen ? 'Fechar timeline' : 'Timeline e atos de fala curta'}>
            <button
              type="button"
              data-testid="voice-call-panel-toggle"
              aria-label="Timeline e atos de fala curta"
              aria-pressed={panelOpen}
              onClick={() => setPanelOpen((v) => !v)}
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg',
                panelOpen && 'bg-active text-fg'
              )}
            >
              <Activity className="size-4" />
            </button>
          </Tip>
          <Tip label={call.muted ? 'Ativar microfone' : 'Silenciar microfone'}>
            <button
              type="button"
              data-testid="voice-call-mute"
              aria-label={call.muted ? 'Ativar microfone' : 'Silenciar microfone'}
              aria-pressed={call.muted}
              onClick={() => void toggleMute()}
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg',
                call.muted && 'bg-danger/15 text-danger hover:bg-danger/25 hover:text-danger'
              )}
            >
              {call.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
          </Tip>
          <Tip label={`Volume da fala: ${Math.round(volume * 100)}%`}>
            <label className="flex shrink-0 items-center gap-1.5 text-subtle">
              <Volume2 className="size-4" />
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                data-testid="voice-call-volume"
                aria-label="Volume da fala"
                onChange={(e) => setVolume(Number(e.target.value) / 100)}
                className="w-16 accent-accent-strong"
              />
            </label>
          </Tip>
          <span className="min-w-0 flex-1 truncate text-[11px] text-faint">
            Texto desativado durante a chamada
          </span>
          <Tip label="Encerrar chamada">
            <button
              type="button"
              data-testid="voice-call-end"
              aria-label="Encerrar chamada"
              onClick={() => void stopVoiceCall()}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-danger px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-danger/85"
            >
              <PhoneOff className="size-4" />
              Encerrar
            </button>
          </Tip>
        </div>
      </div>
    </div>
  )
}

/** Waveform isolado (o nível muda a ~30 Hz — só este componente re-renderiza). */
function DockWaveform({ muted }: { muted: boolean }): React.JSX.Element {
  const level = useVoiceCallRuntime((s) => s.level)
  return (
    <Waveform
      level={level}
      recording={!muted}
      simulate={MOCK}
      className="h-6 w-20 text-accent-strong"
    />
  )
}

/**
 * Preâmbulos ligados mas sem clipes gerados para a voz atual: nada tocaria em silêncio — o dock
 * avisa e oferece gerar os clipes ali mesmo. Só as frases de ferramenta ligadas: elas caem na
 * síntese ao vivo (mais lenta) — o aviso também aparece. Só o "obrigado por aguardar" sem clipe:
 * sem aviso (ele é sintetizado em paralelo enquanto o usuário espera).
 */
function ClipsHint(): React.JSX.Element | null {
  const clips = useVoiceCallRuntime((s) => s.clips)
  const stale = useVoiceCallRuntime((s) => s.clipsStale)
  const progress = useVoiceCallRuntime((s) => s.clipsProgress)
  const generate = useVoiceCallRuntime((s) => s.generateClips)
  const { resolved } = useVoiceCallConfig()
  // preâmbulos sem clipe = mudos; frases de ferramenta sem clipe = síntese ao vivo (mais lenta)
  const all = !stale.length // 'missing' sem detalhe = todas as classes
  const fillerMissing = resolved.fillers.enabled && (all || stale.includes('FILLER'))
  const toolMissing = resolved.toolPhrases && (all || stale.includes('TOOL'))
  if (!resolved.fillers.enabled && !resolved.toolPhrases) return null
  if (clips !== 'generating' && (clips !== 'missing' || (!fillerMissing && !toolMissing)))
    return null
  const total =
    DEFAULT_FILLER_POOL.length + DEFAULT_TOOL_PHRASE_POOL.length + DEFAULT_THANKS_POOL.length
  return (
    <div
      data-testid="voice-call-clips-hint"
      className="flex items-center gap-2 rounded-xl border border-warning/25 bg-warning/[0.06] px-3 py-1.5 text-[11.5px] text-warning"
    >
      <Sparkles className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {clips === 'generating'
          ? `Gerando clipes de voz… ${progress?.done ?? 0}/${progress?.total || total}`
          : fillerMissing
            ? 'Os preâmbulos estão ligados, mas ainda não há clipes para a voz atual — nada vai tocar até gerar.'
            : 'Ainda não há clipes para a voz atual — as frases de ferramenta vão ser sintetizadas na hora (mais lentas) até gerar.'}
      </span>
      {clips === 'missing' && (
        <button
          type="button"
          data-testid="voice-call-clips-generate"
          onClick={() => void generate()}
          className="shrink-0 rounded-md border border-warning/30 px-2 py-0.5 text-[11.5px] font-medium transition-colors hover:bg-warning/15"
        >
          Gerar clipes
        </button>
      )}
    </div>
  )
}

/**
 * O que o usuário está dizendo, ao vivo (parciais da transcrição enquanto fala → a especulativa da
 * pausa → a final enviada). Parcial em itálico/esmaecida: o texto definitivo pode mudar.
 */
function LiveTranscript(): React.JSX.Element | null {
  const live = useVoiceCallRuntime((s) => s.live)
  if (!live.text) return null
  return (
    <span
      data-testid="voice-call-live"
      data-state={live.state ?? undefined}
      title={live.text}
      className={cn(
        'truncate text-[12.5px] leading-5 [direction:rtl] text-left',
        live.state === 'final' ? 'text-fg/80' : 'text-subtle italic'
      )}
    >
      {/* rtl + bdi: com texto longo, o FIM (o que acabou de ser dito) fica visível */}
      <bdi>“{live.text}”</bdi>
    </span>
  )
}

/**
 * Chamada na GPU local: aviso (uma vez por sessão do app, "Entendi") de que a GPU vai ser usada —
 * só durante o "Preparando a GPU…" — e o de pouca VRAM livre (a chamada segue; fecha no ×).
 */
function GpuCallNotice({ preparing }: { preparing: boolean }): React.JSX.Element | null {
  const plan = useVoiceCallRuntime((s) => s.gpuCall)
  const seen = useVoiceCallRuntime((s) => s.gpuNoticeSeen)
  const closed = useVoiceCallRuntime((s) => s.gpuWarningClosed)
  if (!plan) return null
  const notice = preparing && !seen ? plan.notice : null
  const warning = !closed ? plan.warning : null
  if (!notice && !warning) return null
  return (
    <div className="space-y-1.5">
      {notice && (
        <div
          data-testid="voice-call-gpu-notice"
          role="status"
          className="flex items-center gap-2 rounded-xl border border-accent/25 bg-accent/[0.06] px-3 py-1.5 text-[11.5px] text-fg/85"
        >
          <Cpu className="size-3.5 shrink-0 text-accent-strong" />
          <span className="min-w-0 flex-1">
            {notice}. O servidor local liga agora e desliga sozinho depois de um tempo sem uso.
          </span>
          <button
            type="button"
            data-testid="voice-call-gpu-notice-ok"
            onClick={() => useVoiceCallRuntime.setState({ gpuNoticeSeen: true })}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11.5px] transition-colors hover:bg-hover"
          >
            Entendi
          </button>
        </div>
      )}
      {warning && (
        <div
          data-testid="voice-call-gpu-warning"
          role="alert"
          className="flex items-center gap-2 rounded-xl border border-warning/30 bg-warning/[0.07] px-3 py-1.5 text-[11.5px] text-warning"
        >
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{warning}.</span>
          <button
            type="button"
            aria-label="Fechar aviso de VRAM"
            onClick={() => useVoiceCallRuntime.setState({ gpuWarningClosed: true })}
            className="shrink-0 rounded-md p-1 transition-colors hover:bg-warning/15"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
