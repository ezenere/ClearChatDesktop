// A voz da chamada (Configurações → Áudio → Fala) interpreta tags de voz? (`supportsAudioTags` com a
// família do provedor escolhido) — os editores avisam quando as tags pedidas seriam tiradas da fala.
import { supportsAudioTags, voiceProviderSupport } from '@shared/voiceCatalog'
import { useStore } from '../../store'
import { useVoiceSettings } from './voiceSettings'

export function useCallTtsTagsSupport(): { supported: boolean; model: string | null } {
  const tts = useVoiceSettings((s) => s.view.ttsSettings)
  const providers = useStore((s) => s.providers)
  if (tts.backend !== 'api' || !tts.api.providerId) return { supported: false, model: null }
  const p = providers.find((x) => x.id === tts.api.providerId)
  const family = p ? voiceProviderSupport(p) : null
  return { supported: supportsAudioTags(family, tts.api.model), model: tts.api.model || null }
}
