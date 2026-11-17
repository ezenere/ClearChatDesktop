// Configurações → Áudio → Chamada de voz → "Frases de ferramenta" (global, `voiceCallDefaults.
// toolPhrases`): liga/desliga e as frases por categoria de tool (recolhidas; uma por linha). A
// frase sai na 1ª tool do turno — clipe pré-gerado (`TOOL_<n>`, "Gerar clipes") ou síntese ao vivo
// sem ele. Ver SPEC.md → "Frases de ferramenta".
import {
  DEFAULT_TOOL_PHRASE_POOL,
  DEFAULT_TOOL_PHRASES,
  type VoiceToolPhrases
} from '@shared/voice'
import { ToggleRow } from '../panel/fields'
import { Button } from '../ui/controls'
import { SubHeading } from './audioUi'
import { ToolPhrasePoolFields } from './PhrasePoolFields'

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
          'Sai no instante em que a tool começa: no lugar do preâmbulo quando ele ainda não tocou; com o preâmbulo (ou uma frase de espera) tocando, entra na fila e toca logo depois dele, sem cortá-lo. Pulada quando o assistente já falou algo antes da tool, quando você está falando ou depois da despedida; na fila, cai se a resposta começar antes.\n' +
          'Usa os clipes pré-gerados ("Gerar clipes" em Voz); sem eles, sintetiza na hora (descartada se a resposta começar antes). Persona/chat podem ligar/desligar (★ segue este padrão). Não entra no histórico; os caracteres sintetizados contam no custo da voz da chamada.'
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
            <ToolPhrasePoolFields
              key={tp.pool ? 'custom' : 'default'}
              pool={pool}
              onCommit={(next) => set({ pool: next })}
            />
          </div>
        </details>
      )}
    </div>
  )
}
