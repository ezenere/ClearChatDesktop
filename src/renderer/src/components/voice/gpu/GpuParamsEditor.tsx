// "Parâmetros" de um motor do Modo avançado (GPU local): o `ParamsEditor` genérico com as specs de
// `GPU_ENGINE_PARAMS` (`@shared/gpuVoice`); o que se grava são só os valores diferentes do padrão
// (`ttsSettings.gpu.params[motor]` / `sttSettings.gpu.params`) — locais, não sincronizam. Os
// valores vão no corpo de cada fala (o servidor não reinicia); o whisper recebe na próxima
// transcrição.
import type { ReactNode } from 'react'
import { gpuParamRows, setGpuParam } from '../../../lib/voice/gpu/gpuUi'
import type { GpuEngineId } from '../../../lib/voice/gpu/types'
import type { GpuParamValues } from '@shared/gpuVoice'
import { ParamsEditor, type ParamValues } from '../ParamsEditor'

export function GpuParamsEditor({
  engineId,
  engineLabel,
  value,
  onChange,
  testId,
  extra,
  extraChanged = false,
  onRestore,
  defaultOpen = false
}: {
  engineId: GpuEngineId
  engineLabel: string
  /** Overrides salvos (só os diferentes do padrão). */
  value: GpuParamValues
  onChange: (next: GpuParamValues) => void
  testId: string
  /** Controles extras no topo (ex.: os passos do OmniVoice, que moram em `ttsSettings.gpu.steps`). */
  extra?: ReactNode
  /** O extra está fora do padrão (habilita "Restaurar padrão"). */
  extraChanged?: boolean
  /**
   * "Restaurar padrão" num commit só (parâmetros + extra — dois commits seguidos das settings se
   * sobrescreveriam). Ausente → grava os parâmetros vazios.
   */
  onRestore?: () => void
  defaultOpen?: boolean
}): React.JSX.Element | null {
  return (
    <ParamsEditor
      ownerLabel={engineLabel}
      value={value}
      rows={(draft) => gpuParamRows(engineId, draft)}
      set={(draft: ParamValues, key, v) =>
        v === null
          ? Object.fromEntries(Object.entries(draft).filter(([k]) => k !== key))
          : setGpuParam(engineId, draft, key, v)
      }
      onChange={onChange}
      onRestore={onRestore}
      testId={testId}
      extra={extra}
      extraChanged={extraChanged}
      defaultOpen={defaultOpen}
    />
  )
}
