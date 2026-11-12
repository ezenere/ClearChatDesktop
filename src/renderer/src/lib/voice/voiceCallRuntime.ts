// Estado de runtime da chamada de voz no renderer (fora do store principal: o nível do microfone
// muda a ~30 Hz e só o waveform do dock deve re-renderizar). O controller (`useVoiceCall`, montado
// uma única vez em `App` por `VoiceCallController`) publica aqui; a barra da chamada — que ocupa o
// lugar do composer do chat da chamada — só lê e chama as ações.
import { create } from 'zustand'
import type { GpuCallPlan } from './gpu/gpuUi'

/**
 * Clipes da voz atual (preâmbulos e frases de ferramenta): sem eles os preâmbulos não tocam e as
 * frases de ferramenta são sintetizadas na hora. 'missing' = alguma classe velha/ausente
 * (`clipsStale` diz quais).
 */
export type VoiceClipsState = 'unknown' | 'missing' | 'ok' | 'generating'

export interface VoiceCallRuntime {
  /** Nível RMS ao vivo (0..1) para o `Waveform`. */
  level: number
  /** Erro legível da captura/transcrição durante a chamada (o do main vem em `voiceCall.error`). */
  error: string | null
  /** Volume da reprodução (0..1). */
  volume: number
  clips: VoiceClipsState
  /** Classes de clipe velhas/ausentes na voz atual (`'FILLER'`, `'TOOL'`) — [] com tudo em dia. */
  clipsStale: string[]
  /** Progresso da geração de clipes ("Gerar clipes" no dock). */
  clipsProgress: { done: number; total: number } | null
  /**
   * Transcrição ao vivo da fala do usuário na barra da chamada: as parciais enquanto fala
   * (`partial`), a especulativa da pausa (`speculative`) e a final enviada (`final`); '' = nada.
   */
  live: { text: string; state: 'partial' | 'speculative' | 'final' | null }
  /**
   * Chamada com fala/transcrição na GPU local: o plano da pré-checagem (`gpuCallPlan` — aviso de uso
   * da GPU e VRAM livre × necessária) para a barra mostrar na fase "Preparando a GPU…"; null = sem GPU.
   */
  gpuCall: GpuCallPlan | null
  /** O aviso "a chamada vai usar sua GPU" já foi dispensado nesta sessão do app ("Entendi"). */
  gpuNoticeSeen: boolean
  /** O aviso de pouca VRAM foi fechado nesta chamada. */
  gpuWarningClosed: boolean
  toggleMute: () => Promise<void>
  setVolume: (volume: number) => void
  clearError: () => void
  generateClips: () => Promise<void>
}

export const useVoiceCallRuntime = create<VoiceCallRuntime>(() => ({
  level: 0,
  error: null,
  volume: 1,
  clips: 'unknown',
  clipsStale: [],
  clipsProgress: null,
  live: { text: '', state: null },
  gpuCall: null,
  gpuNoticeSeen: false,
  gpuWarningClosed: false,
  toggleMute: async () => {},
  setVolume: () => {},
  clearError: () => {},
  generateClips: async () => {}
}))
