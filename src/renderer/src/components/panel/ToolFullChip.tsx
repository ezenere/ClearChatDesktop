// Chip "compacta"/"completa" de uma tool na lista de tools do chat/persona (tools compactadas,
// protocolo 1.11.0 — @shared/compactTools): marca/desmarca "vai completa" (`toolsFull`) com a
// marca de herança da unidade `toolsFull.<tool>`. Num modo de busca nativa (1.12.0) a mesma
// escolha vira "adiada"/"carregada" (`defer_loading`).
import { sendsCompact, shortToolDescription, withFullTool } from '@shared/compactTools'
import { toolLabel } from '@shared/deviceTools'
import { isNativeMode } from '@shared/toolSearch'
import type { ChatConfig, ToolSearchMode } from '@shared/types'
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
  dim,
  mode
}: {
  name: string
  cfg: Pick<ChatConfig, 'toolsCompact' | 'toolsFull'>
  patch: (p: Partial<ChatConfig>) => void
  /** Esmaecido (tool de outro tipo de aparelho). */
  dim?: boolean
  /** Modo de envio do chat (1.12.0): nos nativos o chip diz "adiada"/"carregada". */
  mode?: ToolSearchMode
}): React.JSX.Element {
  const full = !sendsCompact(name, cfg)
  const label = toolLabel(name)
  const native = isNativeMode(mode)
  const text = native ? (full ? 'carregada' : 'adiada') : full ? 'completa' : 'compacta'
  return (
    <>
      <InheritMark units={[`toolsFull.${name}`]} />
      <Tip
        label={
          <span className="block max-w-[260px] leading-snug">
            {native ? (
              full ? (
                <>
                  Vai carregada desde o início (sem defer_loading). As outras o modelo encontra pela
                  busca do provedor. Clique para mandar adiada.
                </>
              ) : (
                <>
                  Vai adiada (defer_loading): completa, mas o modelo só a vê depois de encontrá-la
                  pela busca do provedor. Clique para mandar carregada.
                </>
              )
            ) : full ? (
              <>Vai completa (descrição e parâmetros). Clique para mandar compacta.</>
            ) : (
              <>
                Vai compacta: “{shortToolDescription(name)}” — o modelo lê o resto com tool_search.
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
          data-mode={native ? 'native' : 'local'}
          aria-label={`${label}: vai ${text}`}
          onClick={() => patch({ toolsFull: withFullTool(cfg.toolsFull, name, !full) })}
          className={cn(
            'inline-flex h-[18px] shrink-0 items-center rounded-md border px-1.5 text-[10.5px] transition-colors',
            full
              ? 'border-accent/40 bg-accent-soft/70 text-accent-strong hover:border-accent/60'
              : 'border-border text-subtle hover:border-border-strong hover:text-muted',
            dim && 'opacity-60'
          )}
        >
          {text}
        </button>
      </Tip>
    </>
  )
}
