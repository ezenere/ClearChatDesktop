// Tools só do celular (protocolo 1.10.0, §4.3.6 — "Tools de um tipo de aparelho") na lista de
// tools do chat/persona e da chamada de voz: alternáveis, esmaecidas, com a nota de que o computador
// não as manda ao modelo.
import {
  DEVICE_ONLY_LABEL,
  DEVICE_ONLY_NOTE,
  DEVICE_ONLY_TITLE,
  PHONE_TOOL_HELP,
  PHONE_TOOL_LABELS,
  PHONE_TOOL_NAMES
} from '@shared/deviceTools'
import type { ChatConfig } from '@shared/types'
import { Switch } from '../ui/controls'
import { HelpTip } from '../ui/Tooltip'
import { InheritMark } from './inherit'
import { ToolFullChip } from './ToolFullChip'

/**
 * Tools só do celular (§4.3.6): ficam na lista do chat/persona e são alternáveis aqui, mas o
 * computador nunca as manda ao modelo — esmaecidas, com a nota dizendo isso (nada escondido vai ao
 * modelo). Valem quando o chat roda no celular. Também na lista de tools da chamada de voz.
 */
export function PhoneToolsGroup({
  tools,
  onToggle,
  marks = true,
  compact
}: {
  tools: readonly string[]
  onToggle: (tool: string, on: boolean) => void
  /** Marcas "neste chat" (a lista é a do chat; na chamada de voz não há herança por tool). */
  marks?: boolean
  /** Compactação ligada (1.11.0): chip "compacta"/"completa" — vale quando o chat roda no celular. */
  compact?: {
    cfg: Pick<ChatConfig, 'toolsCompact' | 'toolsFull'>
    patch: (p: Partial<ChatConfig>) => void
  }
}): React.JSX.Element {
  return (
    <div data-testid="tools-device-phone" className="mt-2 border-t border-border/60 pt-2">
      <div className="flex items-baseline gap-2 px-0.5">
        <span className="text-[11px] font-medium tracking-wide text-subtle uppercase">
          {DEVICE_ONLY_TITLE.phone}
        </span>
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-faint">
          {DEVICE_ONLY_NOTE.phone}
        </span>
      </div>
      <div className="-mx-1.5 mt-1 space-y-px">
        {PHONE_TOOL_NAMES.map((t) => {
          const on = tools.includes(t)
          return (
            <div
              key={t}
              data-device-only="phone"
              data-tool={t}
              className="flex h-8 items-center gap-2.5 rounded-lg px-1.5 hover:bg-hover/50"
            >
              <span className="inline-flex opacity-60">
                <Switch
                  size="sm"
                  checked={on}
                  label={PHONE_TOOL_LABELS[t]}
                  onChange={(v) => onToggle(t, v)}
                />
              </span>
              <span
                title={DEVICE_ONLY_LABEL.phone}
                className="min-w-0 flex-1 truncate text-[12.5px] text-faint"
              >
                {PHONE_TOOL_LABELS[t]}
              </span>
              {marks && <InheritMark units={[`enabledTools.${t}`]} />}
              {compact && on && (
                <ToolFullChip name={t} cfg={compact.cfg} patch={compact.patch} dim />
              )}
              <span className="truncate font-mono text-[10.5px] text-faint/80">{t}</span>
              <HelpTip label={PHONE_TOOL_LABELS[t]}>
                {PHONE_TOOL_HELP[t]} Definição e execução no celular: neste computador ela não vai
                na request nem no texto das tools.
              </HelpTip>
            </div>
          )
        })}
      </div>
    </div>
  )
}
