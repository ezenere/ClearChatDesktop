// Configurações → Áudio → Ditado: "Nível de ativação" do microfone (`audioInput.activationDb`, local
// do dispositivo — nunca sincroniza) com um medidor ao vivo. Abaixo do nível nada é fala: o portão de
// ativação do main (`@shared/speechGate`) não manda o trecho ao STT (corta as alucinações do whisper
// em silêncio/ruído — "Tchau.", "Obrigado."). O medidor só abre o microfone quando o usuário clica
// em "Testar" (nunca sozinho); no build de mock os níveis são simulados.
import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'
import { ACTIVATION_DB_RANGE, DEFAULT_ACTIVATION_DB, rmsToDb } from '@shared/speechGate'
import { AudioCapture } from '../../lib/audio/capture'
import { captureErrorText } from '../../lib/voice/dictation'
import { cn } from '../../lib/format'
import { Button } from '../ui/controls'
import { HelpTip } from '../ui/Tooltip'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'
/** Faixa do medidor (dBFS): a da ativação com uma folga dos dois lados. */
const METER_MIN = -80
const METER_MAX = -10

/** dBFS → posição no medidor (0..100 %). */
function meterPct(db: number): number {
  const v = Math.min(METER_MAX, Math.max(METER_MIN, db))
  return ((v - METER_MIN) / (METER_MAX - METER_MIN)) * 100
}

export function MicActivationLevel({
  value,
  deviceId,
  onChange
}: {
  /** Nível salvo (dBFS). */
  value: number
  /** Microfone escolhido (null = padrão do sistema). */
  deviceId: string | null
  onChange: (db: number) => void
}): React.JSX.Element {
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState<number | null>(null)
  const [peak, setPeak] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<number | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const shown = draft ?? value

  useEffect(() => {
    if (!testing) return
    let disposed = false
    let peakDb = -120
    const onLevel = (rms: number): void => {
      const db = rmsToDb(rms)
      peakDb = Math.max(db, peakDb - 0.6) // pico que cai devagar
      setLevel(db)
      setPeak(peakDb)
    }
    if (MOCK) {
      const t = setInterval(() => onLevel(0.002 + Math.abs(Math.sin(Date.now() / 300)) * 0.05), 50)
      return () => clearInterval(t)
    }
    const capture = new AudioCapture({ silence: false })
    captureRef.current = capture
    capture.on('level', onLevel)
    capture.on('error', (e) => setError(captureErrorText(e)))
    void capture.start(deviceId).catch((e: unknown) => {
      if (!disposed) {
        setError(captureErrorText(e as Error))
        setTesting(false)
      }
    })
    return () => {
      disposed = true
      captureRef.current = null
      void capture.stop().catch(() => {})
      setLevel(null)
      setPeak(null)
    }
  }, [testing, deviceId])

  const above = level != null && level >= shown
  return (
    <div className="space-y-1.5" data-testid="mic-activation">
      <div className="flex items-center gap-1.5 text-[13px] text-fg/90">
        Nível de ativação
        <HelpTip label="Nível de ativação">
          Abaixo deste nível o som não conta como fala: o trecho nem vai para a transcrição (ditado
          e chamada de voz). Evita que silêncio e ruído virem texto inventado — o “Tchau.” ou
          “Obrigado.” que aparecem do nada. Clique em Testar, fale normalmente e deixe a linha entre
          o ruído da sala (parado) e a sua voz. Vale só neste computador (depende do microfone e da
          sala; não sincroniza). Padrão {DEFAULT_ACTIVATION_DB} dB.
        </HelpTip>
        <span
          className="ml-auto font-mono text-[11.5px] text-subtle"
          data-testid="mic-activation-value"
        >
          {shown} dB
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div
          className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-hover"
          data-testid="mic-activation-meter"
          aria-hidden
        >
          {level != null && (
            <div
              className={cn(
                'absolute inset-y-0 left-0 rounded-full transition-[width] duration-75',
                above ? 'bg-success/70' : 'bg-subtle/40'
              )}
              style={{ width: `${meterPct(level)}%` }}
            />
          )}
          {peak != null && (
            <div
              className="absolute inset-y-0 w-px bg-fg/40"
              style={{ left: `${meterPct(peak)}%` }}
            />
          )}
          {/* a linha do nível de ativação */}
          <div
            data-testid="mic-activation-threshold"
            className="absolute inset-y-[-2px] w-0.5 bg-accent-strong"
            style={{ left: `${meterPct(shown)}%` }}
          />
        </div>
        <Button
          size="sm"
          variant={testing ? 'primary' : 'secondary'}
          data-testid="mic-activation-test"
          icon={testing ? <Square className="size-3" /> : <Mic className="size-3.5" />}
          onClick={() => {
            setError(null)
            setTesting((t) => !t)
          }}
        >
          {testing ? 'Parar' : 'Testar'}
        </Button>
      </div>
      <input
        type="range"
        min={ACTIVATION_DB_RANGE.min}
        max={ACTIVATION_DB_RANGE.max}
        step={1}
        value={shown}
        aria-label="Nível de ativação do microfone (dB)"
        data-testid="mic-activation-slider"
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={() => {
          if (draft != null && draft !== value) onChange(draft)
          setDraft(null)
        }}
        onKeyUp={() => {
          if (draft != null && draft !== value) onChange(draft)
          setDraft(null)
        }}
        onBlur={() => {
          if (draft != null && draft !== value) onChange(draft)
          setDraft(null)
        }}
        className="w-full accent-accent-strong"
      />
      {testing && level != null && (
        <p className="text-[11.5px] text-subtle" data-testid="mic-activation-status">
          {above ? 'Fala detectada' : 'Abaixo do nível — não conta como fala'} · {Math.round(level)}{' '}
          dB
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11.5px] text-danger" data-testid="mic-activation-error">
          {error}
        </p>
      )}
    </div>
  )
}
