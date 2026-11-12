// Configurações → Áudio → Chamada de voz → "Frases de ferramenta" (global, `voiceCallDefaults.
// toolPhrases`): liga/desliga e as frases por categoria de tool (recolhidas; uma por linha). A
// frase sai na 1ª tool do turno — clipe pré-gerado (`TOOL_<n>`, "Gerar clipes") ou síntese ao vivo
// sem ele. Ver SPEC.md → "Frases de ferramenta".
import { useState } from 'react'
import {
  DEFAULT_TOOL_PHRASE_POOL,
  DEFAULT_TOOL_PHRASES,
  TOOL_PHRASE_CATEGORIES,
  type ToolPhrase,
  type ToolPhraseCategory,
  type VoiceToolPhrases
} from '@shared/voice'
import { TOOL_PHRASE_AFTER_PREAMBLE_MS } from '@shared/voicePolicy'
import { ToggleRow } from '../panel/fields'
import { Button } from '../ui/controls'
import { SubHeading } from './audioUi'
import { TOOL_PHRASE_CATEGORY_LABELS, replaceCategoryLines } from '../../lib/voice/toolPhrases'

/** Frases de uma categoria (na ordem do pool). */
const linesOf = (pool: readonly ToolPhrase[], cat: ToolPhraseCategory): string[] =>
  pool.filter((p) => p.categories.includes(cat)).map((p) => p.text)

/** Frases de UMA categoria (uma por linha; commit no blur). */
function CategoryField({
  cat,
  pool,
  onCommit
}: {
  cat: ToolPhraseCategory
  pool: readonly ToolPhrase[]
  onCommit: (pool: ToolPhrase[] | null) => void
}): React.JSX.Element {
  const lines = linesOf(pool, cat)
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
    onCommit(replaceCategoryLines(pool, cat, next))
  }
  const label = TOOL_PHRASE_CATEGORY_LABELS[cat]
  return (
    <div className="space-y-1">
      <div className="text-[12px] text-fg/85">{label}</div>
      <textarea
        value={text}
        spellCheck={false}
        aria-label={`Frases de ferramenta — ${label} (uma por linha)`}
        data-testid={`voice-call-tool-phrases-${cat}`}
        rows={Math.min(5, Math.max(2, lines.length))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="field min-h-[48px] resize-y text-[12px] leading-relaxed"
      />
    </div>
  )
}

export function ToolPhrasesSettings({
  value,
  onChange
}: {
  value: VoiceToolPhrases | null | undefined
  onChange: (next: VoiceToolPhrases) => void
}): React.JSX.Element {
  const tp = value ?? DEFAULT_TOOL_PHRASES
  const pool = tp.pool ?? DEFAULT_TOOL_PHRASE_POOL
  const set = (patch: Partial<VoiceToolPhrases>): void => onChange({ ...tp, ...patch })
  return (
    <div className="space-y-3" data-testid="voice-call-tool-phrases">
      <SubHeading>Frases de ferramenta</SubHeading>
      <ToggleRow
        label="Frases de ferramenta"
        checked={tp.enabled}
        onChange={(enabled) => set({ enabled })}
        help={
          'Quando o assistente usa uma ferramenta durante a chamada, fala uma frase curta sobre ela ("Vou pesquisar isso.", "Deixa eu dar uma olhada nos arquivos.", "Vou rodar isso aqui.") — só na 1ª tool do turno, nunca mais de uma por turno.\n' +
          `Fica no lugar do preâmbulo quando ele ainda não tocou; se o preâmbulo já tocou, só sai ${TOOL_PHRASE_AFTER_PREAMBLE_MS / 1000} s depois do fim dele. Pulada quando o assistente já falou algo antes da tool, quando você está falando, com outra frase curta tocando ou depois da despedida.\n` +
          'Usa os clipes pré-gerados ("Gerar clipes" em Voz); sem eles, sintetiza na hora (descartada se a tool terminar ou a resposta começar antes). Persona/chat podem ligar/desligar (★ segue este padrão). Não entra no histórico; os caracteres sintetizados contam no custo da voz da chamada.'
        }
      />
      {tp.enabled && (
        <details data-testid="voice-call-tool-phrases-pools" className="group">
          <summary className="cursor-pointer text-[12px] text-subtle select-none hover:text-fg">
            Editar as frases
          </summary>
          <div className="mt-2 space-y-3">
            {tp.pool && (
              <div className="flex items-center gap-2 text-[11.5px] text-subtle">
                <span>Frases personalizadas — gere os clipes de novo depois de editar.</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6 px-2 text-[11px]"
                  data-testid="voice-call-tool-phrases-reset"
                  onClick={() => set({ pool: null })}
                >
                  Restaurar padrão
                </Button>
              </div>
            )}
            {TOOL_PHRASE_CATEGORIES.map((cat) => (
              <CategoryField
                key={`${cat}-${tp.pool ? 'custom' : 'default'}`}
                cat={cat}
                pool={pool}
                onCommit={(next) => set({ pool: next })}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
