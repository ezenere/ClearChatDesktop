import { Sparkles } from 'lucide-react'
import { providerKind } from '@shared/providerKinds'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Tip } from '../ui/Tooltip'
import { barAttrs, useBarLevel } from '../../lib/useBarCollapse'

/**
 * Pílula "<Provedor> · <modelo>" na barra do composer (antes no cabeçalho): clique → aba Modelo;
 * tooltip com o endpoint para onde vai o `model`. Na subsessão mostra o par dela. Recolhe
 * (BAR_ITEMS['model-pill']): completo → só o nome do modelo → ícone.
 */
export function ModelPill({
  providerId,
  model
}: {
  providerId: string
  model: string
}): React.JSX.Element {
  const focusConfig = useStore((s) => s.focusConfig)
  const provider = useStore((s) => s.providers.find((p) => p.id === providerId))
  const level = useBarLevel('model-pill')
  const [vendor, name] = model.includes('/')
    ? [model.split('/')[0], model.split('/').slice(1).join('/')]
    : ['', model]
  return (
    <Tip
      label={
        <span className="max-w-[360px]">
          <span className="text-muted">{provider?.name ?? 'Provedor removido'}</span>
          <span className="text-faint"> · </span>
          <span className="font-mono">{model || 'sem modelo'}</span>
          <span className="block text-[11px] text-subtle">
            Enviado como <code className="font-mono">model</code> para{' '}
            {provider
              ? `${provider.baseUrl}/${providerKind(provider) === 'anthropic' ? 'messages' : 'chat/completions'}`
              : 'o endpoint do provedor'}{' '}
            · clique para trocar
          </span>
        </span>
      }
      side="top"
    >
      <button
        type="button"
        data-testid="model-pill"
        {...barAttrs('model-pill', level)}
        aria-label={`Modelo: ${provider?.name ?? 'provedor removido'} · ${model || 'sem modelo'}`}
        onClick={(e) => {
          e.stopPropagation()
          // abre a aba Modelo já com a seção do modelo aberta (as seções começam recolhidas)
          focusConfig('modelo')
        }}
        className={cn(
          'no-drag flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-lg text-[11.5px] whitespace-nowrap text-subtle transition-colors hover:bg-hover hover:text-fg',
          level === 2 ? 'w-7 justify-center' : 'px-1.5',
          level === 0 && 'max-w-[300px]'
        )}
      >
        <Sparkles className="size-3.5 shrink-0 text-accent-strong" />
        {level === 0 && (
          <>
            <span
              data-testid="model-pill-provider"
              className={cn(
                'max-w-[110px] shrink-0 truncate',
                provider ? 'text-subtle' : 'text-warning/85'
              )}
            >
              {provider?.name ?? 'provedor removido'}
            </span>
            <span className="shrink-0 text-faint">·</span>
            {vendor && <span className="shrink-0 text-faint">{vendor}/</span>}
          </>
        )}
        {level < 2 && (
          <span className={cn('truncate font-medium text-fg/85', level === 1 && 'max-w-[150px]')}>
            {name || 'sem modelo'}
          </span>
        )}
      </button>
    </Tip>
  )
}
