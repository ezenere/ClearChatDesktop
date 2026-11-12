// Leitura ao vivo da resposta falada (renderer): as frases da resposta atual que JÁ tocaram e a que
// está tocando, com quantos caracteres dela já foram ouvidos (`heardChars` estimado pela posição do
// player — palavra por palavra). O chat esmaece o resto da mensagem (`liveDimFrom` em
// `@shared/heardText` + `Markdown voice.dimFrom`). Alimentado por `useVoiceCall`; zera a cada
// resposta nova e no fim da chamada.
import { create } from 'zustand'

export interface VoiceFollowState {
  /** Frases da resposta atual que já terminaram de tocar (texto original, na ordem). */
  heard: string[]
  /** A frase tocando agora e quantos caracteres dela já foram ouvidos. */
  current: { id: string; text: string; chars: number } | null
}

export const useVoiceFollow = create<VoiceFollowState>(() => ({ heard: [], current: null }))

export const resetVoiceFollow = (): void => useVoiceFollow.setState({ heard: [], current: null })
