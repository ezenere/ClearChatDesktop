// Campos de edição dos pools de frases da chamada, por grupo (uma frase por linha; commit no blur):
// frases de ferramenta por categoria e preâmbulos por contexto. Usados no global (Configurações →
// Áudio → Chamada de voz) e na persona/chat (aba Voz — 1.18.0, `VoiceCallConfig.toolPhrasePool` /
// `fillerPool`).
import { useState } from 'react'
import {
  FILLER_CONTEXTS,
  TOOL_PHRASE_CATEGORIES,
  type FillerPhrase,
  type ToolPhrase
} from '@shared/voice'
import { replaceCategoryLines, TOOL_PHRASE_CATEGORY_LABELS } from '../../lib/voice/toolPhrases'
import {
  FILLER_CONTEXT_LABELS,
  fillerContextsOf,
  replaceContextLines
} from '../../lib/voice/fillerPhrases'

/** Frases de UM grupo (uma por linha; commit no blur). */
function GroupField({
  label,
  lines,
  testId,
  ariaLabel,
  onCommit
}: {
  label: string
  lines: string[]
  testId: string
  ariaLabel: string
  onCommit: (lines: string[]) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? lines.join('\n')
  const commit = (): void => {
    if (draft == null) return
    setDraft(null)
    const next = draft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (next.join('\n') === lines.join('\n')) return
    onCommit(next)
  }
  return (
    <div className="space-y-1">
      <div className="text-[12px] text-fg/85">{label}</div>
      <textarea
        value={text}
        spellCheck={false}
        aria-label={ariaLabel}
        data-testid={testId}
        rows={Math.min(5, Math.max(2, lines.length))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="field min-h-[48px] resize-y text-[12px] leading-relaxed"
      />
    </div>
  )
}

/**
 * Frases de ferramenta por categoria. `keepDefault`: igual ao padrão do app continua um pool (a
 * persona/chat que personalizou) — no global, null = o padrão.
 */
export function ToolPhrasePoolFields({
  pool,
  onCommit,
  testIdPrefix = 'voice-call-tool-phrases',
  keepDefault = false
}: {
  pool: readonly ToolPhrase[]
  onCommit: (pool: ToolPhrase[] | null) => void
  testIdPrefix?: string
  keepDefault?: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      {TOOL_PHRASE_CATEGORIES.map((cat) => (
        <GroupField
          key={cat}
          label={TOOL_PHRASE_CATEGORY_LABELS[cat]}
          lines={pool.filter((p) => p.categories.includes(cat)).map((p) => p.text)}
          testId={`${testIdPrefix}-${cat}`}
          ariaLabel={`Frases de ferramenta — ${TOOL_PHRASE_CATEGORY_LABELS[cat]} (uma por linha)`}
          onCommit={(lines) => onCommit(replaceCategoryLines(pool, cat, lines, keepDefault))}
        />
      ))}
    </div>
  )
}

/** Preâmbulos por contexto (pergunta, pedido, correção, tarefa longa, genérico). */
export function FillerPoolFields({
  pool,
  onCommit,
  testIdPrefix = 'voice-call-fillers',
  keepDefault = false
}: {
  pool: readonly FillerPhrase[]
  onCommit: (pool: FillerPhrase[] | null) => void
  testIdPrefix?: string
  keepDefault?: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      {FILLER_CONTEXTS.map((ctx) => (
        <GroupField
          key={ctx}
          label={FILLER_CONTEXT_LABELS[ctx]}
          lines={pool.filter((p) => fillerContextsOf(p).includes(ctx)).map((p) => p.text)}
          testId={`${testIdPrefix}-${ctx}`}
          ariaLabel={`Preâmbulos — ${FILLER_CONTEXT_LABELS[ctx]} (uma por linha)`}
          onCommit={(lines) => onCommit(replaceContextLines(pool, ctx, lines, keepDefault))}
        />
      ))}
    </div>
  )
}
