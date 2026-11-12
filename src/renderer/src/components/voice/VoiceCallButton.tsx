// Botão de chamada de voz do composer (meia-duplex): telefone entra/sai da chamada do chat atual.
// Só aparece em sessões principais com `window.api.voice`; some quando a chamada está desligada no
// padrão GLOBAL (Configurações → Áudio esconde na hora) e fica DESABILITADO, com o motivo no
// tooltip, quando a persona ou o chat a desligam (`resolveVoiceCallEnabled`: chat > persona >
// global — um override do chat religa). Com a chamada ativa em
// OUTRO chat, fica desabilitado (uma chamada por vez — o microfone é único). Chat executado em
// OUTRO dispositivo (host remoto): desabilitado com o motivo no tooltip (o turno de voz roda no
// host; o ditado continua valendo). Antes de entrar, `voiceCallReadiness` confere STT/TTS (e, com
// `voice.runtime.status()`, os runtimes locais — espeak-ng etc.) — o que faltar vira toast com o
// caminho em Configurações → Áudio (nunca uma chamada que falha calada). Com fala/transcrição na
// GPU local, o status da GPU entra na pré-checagem (runtime, motor, servidor).
// Voz POR PERSONA/CHAT (protocolo 1.9.0): a fala e a transcrição são as resolvidas para o chat neste
// dispositivo (`useVoiceResolution` → `voice.resolve`): nenhuma das duas funcionando aqui (nem a da
// persona/chat nem a padrão daqui) → telefone esmaecido e desabilitado com o motivo no tooltip
// ("não configurada"/"não funciona neste dispositivo"); a da persona indisponível e a daqui no lugar
// → aviso discreto no tooltip. A pré-checagem usa a mesma resolução (fresca) antes de entrar.
// Testids: `voice-call-button` (com `voice-call-button-active` quando na chamada; `data-voice` =
// `fallback`/`unconfigured`/`unavailable`).
import { Phone, PhoneOff } from 'lucide-react'
import { useState } from 'react'
import type { Session } from '@shared/types'
import { resolveVoiceCallEnabled } from '@shared/voice'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { voiceCallReadiness } from '../../lib/voice/callReadiness'
import { gpuApi, type SttSettingsGpu, type TtsSettingsGpu } from '../../lib/voice/gpu/types'
import { gpuCallPlan } from '../../lib/voice/gpu/gpuUi'
import { useVoiceCallRuntime } from '../../lib/voice/voiceCallRuntime'
import { loadVoiceSettings, useVoiceSettings } from '../../lib/voice/voiceSettings'
import { useChatVoiceLayers, useVoiceResolution } from '../../lib/voice/voiceResolution'
import { callUnavailableText, voiceFallbackNote, voiceIconState } from '../../lib/voice/voiceChoice'
import { useHostInfo } from '../sync/hooks'
import { Tip } from '../ui/Tooltip'

export function VoiceCallButton({
  session,
  className
}: {
  session: Session
  /** Classes extras do botão (no grupo de voz do composer: segmento do `[ telefone | mic | ˅ ]`). */
  className?: string
}): React.JSX.Element | null {
  const defaults = useVoiceSettings((s) => s.view.voiceCallDefaults)
  const call = useStore((s) => s.voiceCall)
  const startVoiceCall = useStore((s) => s.startVoiceCall)
  const stopVoiceCall = useStore((s) => s.stopVoiceCall)
  const toast = useStore((s) => s.toast)
  const chat = useStore((s) => s.chats.find((c) => c.id === session.chatId))
  const host = useHostInfo(session.chatId)
  const [checking, setChecking] = useState(false)
  const presetId = chat?.config.presetId ?? null
  const persona = useStore((s) =>
    presetId ? (s.presets.find((p) => p.id === presetId) ?? null) : null
  )
  // voz do chat NESTE dispositivo (persona/chat → padrão daqui), com a disponibilidade real
  const layers = useChatVoiceLayers(session.depth === 0 ? session.chatId : null)
  const resolution = useVoiceResolution(api.voice ? layers : null)

  if (!api.voice || session.depth > 0 || !chat) return null
  // chat > persona > global: desligada no global some; desligada pela persona/chat fica
  // desabilitada com o motivo no tooltip (um override do chat pode religar)
  const { enabled, source } = resolveVoiceCallEnabled(
    chat.config.voice,
    persona?.config.voice ?? null,
    defaults
  )
  const mine = call.active && call.sessionId === session.id
  if (!enabled && source === 'global' && !mine) return null
  const off = !enabled && !mine
  const busy = call.active && !mine
  const remote = host?.mode === 'remote' && !mine
  // nem a voz da persona/chat nem a deste dispositivo funcionam aqui (no host remoto, quem decide é ele)
  const unavailable = !mine && !off && !remote ? callUnavailableText(resolution) : null
  const voiceState = resolution ? voiceIconState([resolution.stt, resolution.tts]) : null
  const fallbackNote = [
    voiceFallbackNote('tts', resolution?.tts),
    voiceFallbackNote('stt', resolution?.stt)
  ]
    .filter(Boolean)
    .join(' ')
  const disabled = off || busy || remote || checking || !!unavailable

  const start = async (): Promise<void> => {
    setChecking(true)
    try {
      const deviceView = await loadVoiceSettings()
      // voz EFETIVA do chat (persona/chat → padrão daqui), resolvida agora com o disco/GPU de
      // agora; sem `voice.resolve` (build antigo) vale a deste dispositivo
      const fresh =
        layers && api.voice?.resolve ? await api.voice.resolve(layers).catch(() => null) : null
      const view = fresh
        ? { sttSettings: fresh.stt.settings, ttsSettings: fresh.tts.settings }
        : deviceView
      const sttMode = (view.sttSettings as SttSettingsGpu).mode
      const ttsBackend = (view.ttsSettings as TtsSettingsGpu).backend
      // modo GPU (avançado): runtime/motor/servidor da GPU local
      const needsGpu = ttsBackend === 'gpu' || sttMode === 'gpu'
      const gpu = needsGpu
        ? await (gpuApi()
            ?.status()
            .catch(() => null) ?? null)
        : null
      let problems: string[]
      if (fresh) {
        const why = callUnavailableText(fresh)
        problems = why ? [why] : []
      } else {
        // probe dos runtimes locais (whisper/onnxruntime/espeak-ng) só quando algum motor local conta
        const needsLocal =
          ttsBackend !== 'api' || sttMode === 'local' || sttMode === 'hybrid' || sttMode === 'gpu'
        const runtime = needsLocal ? await api.voice?.runtime?.status().catch(() => null) : null
        // provedores cadastrados: sem provedor de STT/TTS a pré-checagem aponta Áudio/Provedores
        const providers = useStore.getState().providers
        const list = voiceCallReadiness(deviceView, runtime, gpu, providers)
        problems = list.length ? [`Chamada de voz indisponível — ${list.join(' ')}`] : []
      }
      if (problems.length) {
        toast(problems.join(' '), 'error')
        return
      }
      // GPU local: aviso de uso da GPU e da VRAM livre agora (pouca = avisa, não barra) para a barra
      // mostrar no "Preparando a GPU…" — o main sobe/aquece o servidor antes do microfone abrir
      useVoiceCallRuntime.setState({
        gpuCall: needsGpu ? gpuCallPlan(view.ttsSettings, view.sttSettings, gpu) : null,
        gpuWarningClosed: false
      })
      await startVoiceCall(session.id)
    } finally {
      setChecking(false)
    }
  }

  return (
    <Tip
      label={
        <span className="block max-w-[28rem] leading-snug whitespace-normal">
          {unavailable
            ? unavailable
            : off
              ? source === 'persona'
                ? `Chamada de voz desligada pela persona “${persona?.name ?? ''}” — religue neste chat no painel → Chat → Chamada de voz (Ligada).`
                : 'Chamada de voz desligada neste chat — religue no painel → Chat → Chamada de voz.'
              : remote
                ? `A chamada de voz roda no dispositivo que executa este chat (${host?.host?.name ?? 'outro dispositivo'}) — use-a por lá ou execute o chat aqui. O ditado continua disponível.`
                : busy
                  ? 'Já existe uma chamada em andamento'
                  : mine
                    ? 'Encerrar chamada de voz'
                    : fallbackNote
                      ? `Chamada de voz (falar com o agente) — ${fallbackNote}`
                      : 'Chamada de voz (falar com o agente)'}
        </span>
      }
    >
      {/* span: o tooltip continua funcionando com o botão desabilitado */}
      <span className="flex shrink-0">
        <button
          type="button"
          data-testid="voice-call-button"
          data-off={off ? source : undefined}
          data-voice={!mine && voiceState && voiceState !== 'ok' ? voiceState : undefined}
          disabled={disabled}
          aria-label={mine ? 'Encerrar chamada de voz' : 'Iniciar chamada de voz'}
          aria-pressed={mine}
          onClick={(e) => {
            e.stopPropagation()
            void (mine ? stopVoiceCall() : start())
          }}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg',
            mine && 'voice-call-button-active bg-accent/15 text-accent-strong hover:bg-accent/25',
            (busy || remote || off || unavailable) && 'opacity-40',
            className
          )}
        >
          {mine ? <PhoneOff className="size-4" /> : <Phone className="size-4" />}
        </button>
      </span>
    </Tip>
  )
}
