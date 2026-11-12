// "Parâmetros" do modelo REMOTO escolhido em Transcrição/Fala (ElevenLabs direto, OpenRouter,
// OpenAI-compatível): o `ParamsEditor` genérico com as specs que o modelo aceita
// (`apiParamSpecs` — `@shared/voiceParams`). Grava em `api.params[família]` (só o escolhido). Nas
// settings deste dispositivo não sincroniza (protocolo 1.9.0); na voz de uma persona/chat
// (`persona`) sincroniza junto com ela. Vale na próxima fala/transcrição — o "Testar voz" já usa.
import type { VoiceCapability, VoiceProviderSupport } from '@shared/voiceCatalog'
import {
  apiParamSpecs,
  clearVoiceApiParams,
  normalizeVoiceApiParams,
  type VoiceApiParams
} from '@shared/voiceParams'
import { apiParamRows, setApiParamValue } from '../../lib/voice/apiParams'
import { ParamsEditor } from './ParamsEditor'

export function ApiParamsEditor({
  capability,
  family,
  model,
  modelLabel,
  params,
  ws = false,
  onChange,
  testId,
  persona = false
}: {
  capability: VoiceCapability
  family: VoiceProviderSupport | null
  model: string
  modelLabel: string
  params: VoiceApiParams | undefined
  /** A chamada usa o WebSocket da ElevenLabs (mostra o `auto_mode`). */
  ws?: boolean
  /** `api.params` completo novo (undefined = nenhum). */
  onChange: (next: VoiceApiParams | undefined) => void
  testId: string
  /** Parâmetros da voz de uma persona/chat (sincronizam com ela) — senão, deste dispositivo. */
  persona?: boolean
}): React.JSX.Element | null {
  if (!family) return null
  const specs = apiParamSpecs(capability, family, model, { ws })
  if (!specs.length) return null
  const values = params?.[family] ?? {}
  return (
    <ParamsEditor
      ownerLabel={modelLabel}
      value={values}
      rows={(draft) => apiParamRows(specs, draft)}
      set={(draft, key, v) => setApiParamValue(capability, family, draft, key, v)}
      onChange={(next) =>
        onChange(normalizeVoiceApiParams(capability, { ...(params ?? {}), [family]: next }))
      }
      onRestore={() => onChange(clearVoiceApiParams(capability, family, params))}
      testId={testId}
      rowReset
      note={
        (capability === 'tts'
          ? 'Vale na próxima fala (inclusive no “Testar voz”)'
          : 'Vale na próxima transcrição') +
        (persona
          ? '; sincroniza junto com a voz da persona/chat.'
          : '; só neste dispositivo (as settings de voz não sincronizam).')
      }
    />
  )
}
