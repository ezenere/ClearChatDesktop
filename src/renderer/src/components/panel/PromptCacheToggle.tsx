// "Cache do prompt" das chamadas laterais (juiz do Smart-Approve e resumidor da coleta de contexto).
// Ligado (padrão): `cache_control` no fim do system e no {{cache_break}} do template
// (@shared/sideCache). Ver SPEC.md → "Chamadas laterais → Cache do prompt".
import { providerKind } from '@shared/providerKinds'
import { sideCacheable } from '@shared/sideCache'
import { useStore } from '../../store'
import { Chip } from '../ui/Chip'
import { C } from '../ui/Tooltip'
import { ToggleRow } from './fields'

export function PromptCacheToggle({
  providerId,
  model,
  checked,
  onChange,
  what
}: {
  providerId: string | null | undefined
  model: string | null | undefined
  checked: boolean
  onChange: (v: boolean) => void
  /** O que fica no prefixo cacheado (texto da ajuda). */
  what: 'judge' | 'capture'
}): React.JSX.Element {
  const provider = useStore((s) => s.providers.find((p) => p.id === providerId))
  const auto = !!provider && !!model && !sideCacheable(providerKind(provider), model)
  return (
    <ToggleRow
      label="Cache do prompt"
      checked={checked}
      onChange={onChange}
      info={
        checked && auto ? (
          <Chip tip="Este provedor/modelo faz cache automático do prefixo — nada é marcado.">
            automático
          </Chip>
        ) : undefined
      }
      help={
        <>
          <p>
            Marca com <C>cache_control</C> o fim do system prompt e o fim da parte estável da
            mensagem (marcador <C>{'{{cache_break}}'}</C>
            {what === 'judge'
              ? ': ambiente, contexto capturado, objetivo, subagente e raiz'
              : ': a descrição atual — as falas do agente e as mensagens novas ficam fora'}
            ). Chamadas seguidas releem esse prefixo do cache do provedor em vez de pagá-lo de novo.
          </p>
          <p>
            O cache dura ~5 minutos. A 1ª escrita custa ~25% a mais nesses tokens; cada leitura,
            ~10% do preço normal —{' '}
            {what === 'judge'
              ? 'compensa quando há várias aprovações por turno.'
              : 'compensa com mensagens seguidas (a descrição só muda quando o resumo a altera).'}
          </p>
          <p>
            Só Anthropic (API nativa) e modelos Anthropic/Gemini no OpenRouter; os demais fazem
            cache automático. Prefixo menor que o mínimo do modelo (512–4.096 tokens) simplesmente
            não é cacheado. Desligado: a request de sempre, sem marcas.
          </p>
        </>
      }
    />
  )
}
