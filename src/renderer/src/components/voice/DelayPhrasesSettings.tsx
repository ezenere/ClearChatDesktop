// Configurações → Áudio → Chamada de voz → "Frases de demora" (global, `voiceCallDefaults.
// delayPhrases`): liga/desliga, os dois tempos e os pools editáveis (recolhidos). As frases são
// sintetizadas AO VIVO pela voz da chamada — ver SPEC.md → "Frases de demora".
import { useState } from 'react'
import {
  DEFAULT_APOLOGY_POOL,
  DEFAULT_DELAY_PHRASES,
  DEFAULT_KEEPALIVE_POOL,
  DELAY_PHRASE_MS_RANGE,
  normalizeDelayPhrasePool,
  type VoiceDelayPhrases
} from '@shared/voice'
import { DELAY_MIN_GAP_MS } from '@shared/voicePolicy'
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
      <SubHeading>Frases de demora</SubHeading>
      <ToggleRow
        label="Frases de demora"
        checked={dp.enabled}
        onChange={(enabled) => set({ enabled })}
        help={
          'Quando a resposta demora (raciocínio longo, tools), a chamada fala uma frase curta com a MESMA voz, sintetizada na hora (sem clipes pré-gerados):\n' +
          '• "manter viva" — depois do preâmbulo, sem áudio da resposta pelo tempo abaixo: "Só mais um instante…" (no máximo 2 por turno, 15 s entre o fim de uma e o início da outra);\n' +
          '• desculpa — a resposta ficou pronta depois do tempo abaixo: "Desculpe a demora, vamos lá." antes dela (só se já estiver pronta — a resposta nunca espera por ela).\n' +
          'Espaçadas: sempre pelo menos 10 s de silêncio entre o fim de qualquer frase curta (preâmbulo, "manter viva", desculpa) e a próxima "manter viva" ou desculpa — a desculpa que cairia antes disso é pulada.\n' +
          'Nunca enquanto você fala, depois de um barge-in ou da despedida. Não entram no histórico; os caracteres contam no custo da voz da chamada.'
        }
      />
      {dp.enabled && (
        <>
          <NumberRow
            label="Manter viva após"
            help={`Silêncio esperando a resposta (depois do preâmbulo, ou do envio da sua fala) até a frase “manter viva” — padrão ${DEFAULT_DELAY_PHRASES.keepAliveAfterMs / 1000} s; depois de uma frase curta, nunca menos de ${DELAY_MIN_GAP_MS / 1000} s.`}
            value={dp.keepAliveAfterMs}
            min={DELAY_PHRASE_MS_RANGE.min}
            max={DELAY_PHRASE_MS_RANGE.max}
            step={500}
            unit="ms"
            testId="voice-call-keepalive-after"
            ariaLabel="Frase manter viva após (ms)"
            onCommit={(keepAliveAfterMs) => set({ keepAliveAfterMs })}
          />
          <NumberRow
            label="Desculpa após"
            help={`Espera desde o fim da sua fala acima da qual a resposta ganha uma desculpa antes — padrão ${DEFAULT_DELAY_PHRASES.apologyAfterMs / 1000} s (só para demoras longas de verdade).`}
            value={dp.apologyAfterMs}
            min={DELAY_PHRASE_MS_RANGE.min}
            max={DELAY_PHRASE_MS_RANGE.max}
            step={500}
            unit="ms"
            testId="voice-call-apology-after"
            ariaLabel="Desculpa após (ms)"
            onCommit={(apologyAfterMs) => set({ apologyAfterMs })}
          />
          <details data-testid="voice-call-delay-pools" className="group">
            <summary className="cursor-pointer text-[12px] text-subtle select-none hover:text-fg">
              Editar as frases
            </summary>
            <div className="mt-2 space-y-3">
              <PoolField
                label="Manter viva"
                value={dp.keepAlivePool}
                defaults={DEFAULT_KEEPALIVE_POOL}
                testId="voice-call-keepalive-pool"
                onCommit={(keepAlivePool) => set({ keepAlivePool })}
              />
              <PoolField
                label="Desculpa"
                value={dp.apologyPool}
                defaults={DEFAULT_APOLOGY_POOL}
                testId="voice-call-apology-pool"
                onCommit={(apologyPool) => set({ apologyPool })}
              />
            </div>
          </details>
        </>
      )}
    </div>
  )
}
