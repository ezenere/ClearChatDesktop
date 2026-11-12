// Configurações → Áudio → Chamada de voz → "Frases de espera" (local do dispositivo,
// `voiceCallDefaults.delayPhrases`): liga/desliga, "Manter viva após (silêncio)", "Agradecer se a
// última frase foi há mais de" e os pools editáveis (recolhidos) — "manter viva" (pensando /
// ferramenta rodando) e "obrigado por aguardar". Ver SPEC.md → "Frases de demora".
import { useState } from 'react'
import {
  DEFAULT_DELAY_PHRASES,
  DEFAULT_KEEPALIVE_POOL,
  DEFAULT_KEEPALIVE_TOOL_POOL,
  DEFAULT_THANKS_POOL,
  DELAY_PHRASE_MS_RANGE,
  THANKS_AFTER_MS_RANGE,
  normalizeDelayPhrasePool,
  type VoiceDelayPhrases
} from '@shared/voice'
import { KEEPALIVE_MAX_PER_TURN } from '@shared/voicePolicy'
import { ToggleRow } from '../panel/fields'
import { Button } from '../ui/controls'
import { NumberRow, SubHeading } from './audioUi'

/** Pool → texto do campo (uma frase por linha). */
const poolText = (pool: readonly string[]): string => pool.join('\n')

/** Pool editável (uma frase por linha; commit no blur; igual ao padrão ou vazio → null = padrão). */
function PoolField({
  label,
  value,
  defaults,
  testId,
  onCommit
}: {
  label: string
  value: string[] | null
  defaults: readonly string[]
  testId: string
  onCommit: (pool: string[] | null) => void
}): React.JSX.Element {
  const effective = value ?? defaults
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? poolText(effective)
  const commit = (): void => {
    if (draft == null) return
    setDraft(null)
    const pool = normalizeDelayPhrasePool(draft.split('\n'))
    const next = !pool || poolText(pool) === poolText(defaults) ? null : pool
    if (poolText(next ?? defaults) !== poolText(effective)) onCommit(next)
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[12px] text-fg/85">
        <span>{label}</span>
        {value && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 px-2 text-[11px]"
            data-testid={`${testId}-reset`}
            onClick={() => {
              setDraft(null)
              onCommit(null)
            }}
          >
            Restaurar padrão
          </Button>
        )}
      </div>
      <textarea
        value={text}
        spellCheck={false}
        aria-label={`Frases — ${label} (uma por linha)`}
        data-testid={testId}
        rows={Math.min(6, Math.max(3, effective.length))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        className="field min-h-[64px] resize-y text-[12px] leading-relaxed"
      />
    </div>
  )
}

export function DelayPhrasesSettings({
  value,
  onChange
}: {
  value: VoiceDelayPhrases | null | undefined
  onChange: (next: VoiceDelayPhrases) => void
}): React.JSX.Element {
  const dp = value ?? DEFAULT_DELAY_PHRASES
  const set = (patch: Partial<VoiceDelayPhrases>): void => onChange({ ...dp, ...patch })
  return (
    <div className="space-y-3" data-testid="voice-call-delay-phrases">
      <SubHeading>Frases de espera</SubHeading>
      <ToggleRow
        label="Frases de espera"
        checked={dp.enabled}
        onChange={(enabled) => set({ enabled })}
        help={
          'Quando a resposta demora (raciocínio longo, tools), a chamada fala frases curtas com a MESMA voz:\n' +
          `• "manter viva" — depois do preâmbulo ou da frase de ferramenta, a cada "Manter viva após" de silêncio sem a resposta: "Só mais um instante…" (no máximo ${KEEPALIVE_MAX_PER_TURN} por turno; vale com a ferramenta rodando e com o modelo pensando de novo depois dela);\n` +
          '• "obrigado por aguardar" — quando a resposta chega depois de uma "manter viva", uma frase de agradecimento antes dela, só se a última frase de espera foi há mais que o tempo abaixo (falou "só mais um instante" agora há pouco → não agradece). Fica pronta na hora: clipe ("Gerar clipes" em Voz) ou sintetizada enquanto você espera — a resposta nunca espera por ela.\n' +
          'Nunca enquanto você fala (um ruído só pausa), depois de um barge-in, da despedida ou com uma aprovação/pergunta na tela esperando você. Não entram no histórico; os caracteres sintetizados contam no custo da voz da chamada.'
        }
      />
      {dp.enabled && (
        <>
          <NumberRow
            label="Manter viva após (silêncio)"
            help={`Silêncio desde o fim da última fala (preâmbulo, frase de ferramenta, a "manter viva" anterior — ou o envio da sua fala) até a próxima "manter viva" — padrão ${DEFAULT_DELAY_PHRASES.keepAliveAfterMs / 1000} s. É também o espaço entre duas delas.`}
            value={dp.keepAliveAfterMs}
            min={DELAY_PHRASE_MS_RANGE.min}
            max={DELAY_PHRASE_MS_RANGE.max}
            step={500}
            unit="ms"
            testId="voice-call-keepalive-after"
            ariaLabel="Frase manter viva após (ms de silêncio)"
            onCommit={(keepAliveAfterMs) => set({ keepAliveAfterMs })}
          />
          <NumberRow
            label="Agradecer se a última frase foi há mais de"
            help={`"Obrigado por aguardar" antes da resposta só se a última frase de espera terminou há mais que isto — padrão ${DEFAULT_DELAY_PHRASES.thanksAfterMs / 1000} s (a resposta logo depois do "só mais um instante" dispensa o agradecimento).`}
            value={dp.thanksAfterMs}
            min={THANKS_AFTER_MS_RANGE.min}
            max={THANKS_AFTER_MS_RANGE.max}
            step={500}
            unit="ms"
            testId="voice-call-thanks-after"
            ariaLabel="Agradecer se a última frase de espera foi há mais de (ms)"
            onCommit={(thanksAfterMs) => set({ thanksAfterMs })}
          />
          <details data-testid="voice-call-delay-pools" className="group">
            <summary className="cursor-pointer text-[12px] text-subtle select-none hover:text-fg">
              Editar as frases
            </summary>
            <div className="mt-2 space-y-3">
              <PoolField
                label="Manter viva — pensando"
                value={dp.keepAlivePool}
                defaults={DEFAULT_KEEPALIVE_POOL}
                testId="voice-call-keepalive-pool"
                onCommit={(keepAlivePool) => set({ keepAlivePool })}
              />
              <PoolField
                label="Manter viva — ferramenta rodando"
                value={dp.keepAliveToolPool}
                defaults={DEFAULT_KEEPALIVE_TOOL_POOL}
                testId="voice-call-keepalive-tool-pool"
                onCommit={(keepAliveToolPool) => set({ keepAliveToolPool })}
              />
              <PoolField
                label="Obrigado por aguardar"
                value={dp.thanksPool}
                defaults={DEFAULT_THANKS_POOL}
                testId="voice-call-thanks-pool"
                onCommit={(thanksPool) => set({ thanksPool })}
              />
            </div>
          </details>
        </>
      )}
    </div>
  )
}
