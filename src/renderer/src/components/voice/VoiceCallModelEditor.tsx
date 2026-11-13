// "Modelo da chamada" (opcional) + parâmetros próprios da chamada de voz — o mesmo editor nos três
// lugares: painel da barra da chamada (chat da chamada), painel do chat / editor de personas (aba
// Chat → Chamada de voz) e Configurações → Áudio → Chamada de voz (padrão global). Vazio = herda
// (chat > persona > global > o modelo do próprio chat). Reusa o seletor de modelos e os editores de
// raciocínio/parâmetros do chat (`ReasoningField`/`ParamsSection` — só os parâmetros que o modelo
// aceita aparecem, pelo `paramSupport`). Ver SPEC → "Chamada de voz — modelo e parâmetros".
import { X } from 'lucide-react'
import type { ChatConfig, ChatParams } from '@shared/types'
import type { VoiceCallModelConfig } from '@shared/voice'
import { useStore } from '../../store'
import { ParamsSection, ReasoningField } from '../panel/editors'
import { NoInheritProvider } from '../panel/inherit'
import { ModelPicker } from '../ui/ModelPicker'
import { HelpTip } from '../ui/Tooltip'

/** Params sem chaves nulas (o editor do chat desliga um parâmetro gravando null). */
function cleanParams(p: ChatParams | undefined): ChatParams {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p ?? {})) if (v != null) out[k] = v
  return out as ChatParams
}

export function VoiceCallModelEditor({
  value,
  onChange,
  scope,
  inherited,
  compact = false
}: {
  /** Modelo da chamada neste nível (null = herda). */
  value: VoiceCallModelConfig | null
  onChange: (model: VoiceCallModelConfig | null) => void
  /** Escopo dos editores (lembra valores desligados / estado das seções). */
  scope: string
  /** O que vale quando vazio (ex.: "modelo do chat (claude-haiku-5.5)", "padrão global (…)"). */
  inherited: string
  /** Versão enxuta (painel da barra da chamada): parâmetros recolhidos. */
  compact?: boolean
}): React.JSX.Element {
  const providers = useStore((s) => s.providers)
  // cfg sintético: os editores do chat só leem providerId/model/params
  const cfg = value
    ? ({ providerId: value.providerId, model: value.model, params: value.params } as ChatConfig)
    : null
  const patch = (p: Partial<ChatConfig>): void => {
    if (!value) return
    if (p.params) onChange({ ...value, params: cleanParams(p.params) })
  }
  const providerName = value ? providers.find((x) => x.id === value.providerId)?.name : null
  return (
    <div data-testid={`voice-call-model-${scope}`} className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted">Modelo da chamada</span>
        <HelpTip label="Modelo da chamada">
          <p>
            Opcional: um modelo (e parâmetros) só para os turnos de voz — ex.: um modelo mais
            rápido, ou o mesmo com raciocínio desligado. Vazio = herda (chat → persona → padrão
            global → o modelo do próprio chat).
          </p>
          <p className="mt-2">
            Raciocínio em &quot;auto&quot;: a chamada desliga o raciocínio (ou usa o esforço mínimo,
            quando o modelo sempre raciocina) — na fala ele só atrasa a 1ª frase. Escolha um nível
            para mantê-lo. A chamada não impõe teto de tokens: <code>max_tokens</code> vale só se
            você ligá-lo nos parâmetros abaixo.
          </p>
        </HelpTip>
        {value && (
          <button
            type="button"
            data-testid={`voice-call-model-clear-${scope}`}
            onClick={() => onChange(null)}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-subtle transition-colors hover:bg-hover hover:text-fg"
            title="Voltar a herdar o modelo"
          >
            <X className="size-3" /> herdar
          </button>
        )}
      </div>
      <ModelPicker
        value={value ? { providerId: value.providerId, model: value.model } : null}
        placeholder={`Herdar — ${inherited}`}
        onChange={(ref) =>
          onChange({
            providerId: ref.providerId,
            model: ref.model,
            // trocar de modelo mantém os params (os que o novo não aceita ficam salvos, ocultos)
            params: value?.params ?? {}
          })
        }
      />
      {!value && (
        <p data-testid={`voice-call-model-inherit-${scope}`} className="text-[11px] text-subtle">
          Usando {inherited}, com o raciocínio desligado/mínimo na chamada.
        </p>
      )}
      {value && cfg && (
        <NoInheritProvider>
          {providerName === undefined && (
            <p className="text-[11px] text-danger">
              O provedor deste modelo não está mais configurado.
            </p>
          )}
          <ReasoningField
            cfg={cfg}
            patch={patch}
            scope={`voice-${scope}`}
            defaultLabel="auto"
            defaultTitle="Auto: a chamada desliga o raciocínio (ou esforço mínimo quando é obrigatório)"
          />
          <ParamsSection
            cfg={cfg}
            patch={patch}
            scope={`voice-${scope}`}
            sectionId={`voice-params-${scope}${compact ? '-compact' : ''}`}
            title="Parâmetros da chamada"
            help="Só os parâmetros ligados entram nas requests da chamada (os que o modelo não aceita ficam ocultos). max_tokens só vale se ligado aqui."
          />
        </NoInheritProvider>
      )}
    </div>
  )
}
