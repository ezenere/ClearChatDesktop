// Chip "compacta"/"completa" de uma tool na lista de tools do chat/persona (tools compactadas,
// protocolo 1.11.0 — @shared/compactTools): marca/desmarca "vai completa" (`toolsFull`) com a
// marca de herança da unidade `toolsFull.<tool>`.
import { sendsCompact, shortToolDescription, withFullTool } from '@shared/compactTools'
import { toolLabel } from '@shared/deviceTools'
import type { ChatConfig } from '@shared/types'
import { cn } from '../../lib/format'
import { Tip } from '../ui/Tooltip'
import { InheritMark } from './inherit'

/**
 * Chip "compacta"/"completa" de uma tool (compactação ligada, 1.11.0): clicar marca/desmarca
 * "vai completa" (`toolsFull`); com a herança da persona, a marca "neste chat" volta a herdar.
 */
export function ToolFullChip({
  name,
  cfg,
  patch,
  dim
}: {
  name: string
  cfg: Pick<ChatConfig, 'toolsCompact' | 'toolsFull'>
  patch: (p: Partial<ChatConfig>) => void
  /** Esmaecido (tool de outro tipo de aparelho). */
  dim?: boolean
}): React.JSX.Element {
  const full = !sendsCompact(name, cfg)
  const label = toolLabel(name)
  return (
    <>
      <InheritMark units={[`toolsFull.${name}`]} />
      <Tip
        label={
          <span className="block max-w-[260px] leading-snug">
            {full ? (
              <>Vai completa (descrição e parâmetros). Clique para mandar compacta.</>
            ) : (
              <>
                Vai compacta: “{shortToolDescription(name)}” — o modelo lê o resto com search_tool.
                Clique para mandar completa.
              </>
            )}
          </span>
        }
      >
        <button
          type="button"
          data-testid={`tool-full-${name}`}
          data-full={full || undefined}
          aria-pressed={full}
          aria-label={`${label}: vai ${full ? 'completa' : 'compacta'}`}
          onClick={() => patch({ toolsFull: withFullTool(cfg.toolsFull, name, !full) })}
          className={cn(
            'inline-flex h-[18px] shrink-0 items-center rounded-md border px-1.5 text-[10.5px] transition-colors',
            full
              ? 'border-accent/40 bg-accent-soft/70 text-accent-strong hover:border-accent/60'
              : 'border-border text-subtle hover:border-border-strong hover:text-muted',
            dim && 'opacity-60'
          )}
        >
          {full ? 'completa' : 'compacta'}
        </button>
      </Tip>
    </>
  )
}
