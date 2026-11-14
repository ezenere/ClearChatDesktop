// Card de um motor do "Modo avançado (GPU local)": rótulo, licença (link; "não comercial"
// marcado), tamanho + VRAM, qualidade pt-BR, streaming, compatibilidade com os motivos (a VRAM do
// próprio servidor do app não conta como ocupada; motor já carregado não avisa), latência medida no
// último teste, Instalar/Cancelar/Remover, "Testar" e "Parâmetros" (instalado). O tipo (Voz /
// Transcrição) é a seção onde o card aparece. Bloqueado não instala (botão desabilitado com o
// motivo); aviso pede confirmação antes de instalar.
import { Download, ExternalLink, FlaskConical, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '../../../lib/api'
import {
  compatUi,
  engineAction,
  formatMb,
  measuredLine,
  PT_BR_BADGE
} from '../../../lib/voice/gpu/gpuUi'
import type { GpuEngineStatus, GpuSelfTestResult } from '../../../lib/voice/gpu/types'
import { cn } from '../../../lib/format'
import { Button } from '../../ui/controls'
import type { GpuParamValues } from '@shared/gpuVoice'
import { Badge, GpuError, GpuProgress, StepsControl } from './gpuParts'
import { GpuParamsEditor } from './GpuParamsEditor'

const formatDate = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

export function GpuEngineCard({
  engine,
  runtimeInstalled,
  otherBusy,
  steps,
  onInstall,
  onCancel,
  onRemove,
  onSelfTest,
  onSteps,
  params,
  onParams,
  onRestoreParams,
  vramFreeMb
}: {
  engine: GpuEngineStatus
  runtimeInstalled: boolean
  /** Outra instalação em andamento (uma por vez). */
  otherBusy: boolean
  /** Passos salvos do OmniVoice (`ttsSettings.gpu.steps`). */
  steps?: number
  onInstall: () => Promise<void>
  onCancel: () => void
  onRemove: () => Promise<void>
  onSelfTest: () => Promise<GpuSelfTestResult>
  onSteps?: (n: number) => void
  /** Parâmetros salvos do motor (só os diferentes do padrão). */
  params?: GpuParamValues
  onParams?: (next: GpuParamValues) => void
  /** Restaura tudo do motor num commit só (OmniVoice: parâmetros + passos). */
  onRestoreParams?: () => void
  /** VRAM livre agora na melhor NVIDIA (para a nota "o app libera … ao trocar"). */
  vramFreeMb?: number | null
}): React.JSX.Element {
  const e = engine
  const compat = compatUi(e.compat)
  const act = engineAction(e, runtimeInstalled, otherBusy)
  const pt = PT_BR_BADGE[e.ptBR]
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<{ busy: boolean; result: GpuSelfTestResult | null }>({
    busy: false,
    result: null
  })
  const installed = e.install.state === 'installed'

  const run = (fn: () => Promise<void>): void => {
    setError(null)
    void fn().catch((err) => setError(errorMessage(err)))
  }
  const primary = (): void => {
    if (act.action === 'cancel') return onCancel()
    if (act.action === 'remove') return run(onRemove)
    if (compat.confirm) {
      setConfirming(true)
      return
    }
    run(onInstall)
  }
  const selfTest = (): void => {
    setError(null)
    setTest({ busy: true, result: null })
    void onSelfTest()
      .then((result) => setTest({ busy: false, result }))
      .catch((err) => {
        setTest({ busy: false, result: null })
        setError(`Teste falhou: ${errorMessage(err)}`)
      })
  }
  const measured = test.result
    ? { firstAudioMs: test.result.firstAudioMs, rtf: test.result.rtf, at: new Date().toISOString() }
    : e.measured

  return (
    <div
      className={cn(
        'rounded-xl border bg-elevated/40 px-3.5 py-3',
        compat.level === 'blocked' ? 'border-border/60' : 'border-border/80'
      )}
      data-testid={`gpu-engine-${e.id}`}
      data-install={e.install.state}
      data-compat={compat.level}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[13px] font-medium text-fg/90">{e.label}</span>
        <Badge
          tone={installed ? 'success' : e.install.state === 'broken' ? 'danger' : 'neutral'}
          testId={`gpu-engine-state-${e.id}`}
        >
          {installed
            ? 'instalado'
            : e.install.state === 'installing'
              ? 'instalando…'
              : e.install.state === 'broken'
                ? 'com problema'
                : 'não instalado'}
        </Badge>
        {installed && e.vram?.loaded && (
          <Badge
            tone="success"
            testId={`gpu-engine-loaded-${e.id}`}
            title="Carregado agora no servidor local do app (a VRAM dele não conta como ocupada)."
          >
            na GPU agora
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {installed && (
            <Button
              size="sm"
              variant="ghost"
              loading={test.busy}
              icon={<FlaskConical className="size-3.5" />}
              data-testid={`gpu-engine-test-${e.id}`}
              onClick={selfTest}
            >
              {test.busy ? 'Testando…' : 'Testar'}
            </Button>
          )}
          <Button
            size="sm"
            variant={act.action === 'remove' ? 'ghost' : 'secondary'}
            disabled={act.disabled || confirming}
            title={act.why ?? undefined}
            aria-describedby={
              !act.why
                ? undefined
                : compat.level === 'blocked'
                  ? `gpu-engine-reasons-${e.id}`
                  : `gpu-engine-why-${e.id}`
            }
            data-testid={`gpu-engine-action-${e.id}`}
            data-action={act.action}
            icon={
              act.action === 'remove' || act.action === 'cancel' ? (
                <X className="size-3.5" />
              ) : (
                <Download className="size-3.5" />
              )
            }
            onClick={primary}
          >
            {act.label}
          </Button>
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <a
          href={e.license.url}
          target="_blank"
          rel="noreferrer"
          data-testid={`gpu-engine-license-${e.id}`}
          title={`Licença: ${e.license.name}${e.license.commercial ? '' : ' — uso NÃO comercial'}`}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] leading-4 whitespace-nowrap hover:underline',
            e.license.commercial ? 'border-border text-subtle' : 'border-warning/35 text-warning'
          )}
        >
          {/* nome completo no tooltip; no badge só o essencial (os nomes reais são longos) */}
          {e.license.commercial ? e.license.name.split(' · ')[0] : 'licença não comercial'}
          <ExternalLink className="size-2.5" />
        </a>
        <Badge tone={pt.tone} title={pt.help} testId={`gpu-engine-ptbr-${e.id}`}>
          {pt.label}
        </Badge>
        {e.kind === 'tts' && (
          <Badge
            tone={e.streaming ? 'success' : 'neutral'}
            title={
              e.streaming
                ? 'O áudio sai em pedaços enquanto é gerado (começa a tocar antes).'
                : 'Gera a frase inteira antes de tocar (o 1º áudio demora mais).'
            }
          >
            {e.streaming ? 'streaming' : 'frase inteira'}
          </Badge>
        )}
        <Badge tone={compat.tone} testId={`gpu-engine-compat-${e.id}`}>
          {compat.badge}
        </Badge>
      </div>

      <p className="mt-1 text-[11.5px] text-subtle">
        {formatMb(e.sizeMb)} de download · ~{formatMb(e.vramMb)} de VRAM
        {measured && (
          <span className="text-fg/80" data-testid={`gpu-engine-measured-${e.id}`}>
            {' · '}
            {measuredLine(e.kind, measured)}
            {measured.at && formatDate(measured.at) ? ` (teste de ${formatDate(measured.at)})` : ''}
            {e.measured?.wer != null && !test.result
              ? ` · ${Math.round(e.measured.wer * 100)}% de palavras erradas`
              : ''}
          </span>
        )}
      </p>

      {compat.level !== 'ok' && compat.reason && (
        <ul
          id={`gpu-engine-reasons-${e.id}`}
          className={cn(
            'mt-1 list-disc space-y-0.5 pl-4 text-[11.5px]',
            compat.level === 'blocked' ? 'text-danger' : 'text-warning'
          )}
          data-testid={`gpu-engine-reasons-${e.id}`}
        >
          {e.compat.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {compat.level === 'ok' &&
        installed &&
        e.vram &&
        !e.vram.loaded &&
        e.vram.releases.length > 0 &&
        vramFreeMb != null &&
        vramFreeMb < e.vramMb && (
          <p
            className="mt-1 text-[11.5px] text-subtle"
            data-testid={`gpu-engine-vram-note-${e.id}`}
          >
            Ao usar, o app libera {e.vram.releases.join(', ')} da GPU para caber (VRAM livre agora:{' '}
            {formatMb(vramFreeMb)}; com a troca: {formatMb(e.vram.availMb)}).
          </p>
        )}
      {act.note && (
        <p className="mt-1 text-[11.5px] text-subtle" data-testid={`gpu-engine-note-${e.id}`}>
          Instalar {act.note}.
        </p>
      )}
      {act.why && compat.level !== 'blocked' && (
        <p
          id={`gpu-engine-why-${e.id}`}
          className="mt-1 text-[11.5px] text-subtle"
          data-testid={`gpu-engine-why-${e.id}`}
        >
          {act.why.charAt(0).toUpperCase() + act.why.slice(1)}.
        </p>
      )}

      {confirming && (
        <div
          role="alertdialog"
          aria-labelledby={`gpu-confirm-title-${e.id}`}
          data-testid={`gpu-engine-confirm-${e.id}`}
          className="mt-2 rounded-lg border border-warning/35 bg-warning/[0.06] px-2.5 py-2 text-[11.5px]"
        >
          <p id={`gpu-confirm-title-${e.id}`} className="flex items-start gap-1.5 text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {e.label} pode não rodar bem neste computador
              {compat.reason ? `: ${compat.reason}` : '.'} Dá para instalar e testar — se ficar
              lento, remova e escolha outro motor.
            </span>
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              data-testid={`gpu-engine-confirm-yes-${e.id}`}
              onClick={() => {
                setConfirming(false)
                run(onInstall)
              }}
            >
              Instalar mesmo assim
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {e.install.state === 'installing' && (
        <GpuProgress
          progress={e.install.progress}
          label={`Instalação de ${e.label}`}
          testId={`gpu-engine-progress-${e.id}`}
        />
      )}

      {installed && onParams && (
        <GpuParamsEditor
          engineId={e.id}
          engineLabel={e.label}
          value={params ?? {}}
          onChange={onParams}
          testId={`gpu-engine-params-${e.id}`}
          extra={
            e.id === 'omnivoice' && onSteps ? (
              <StepsControl value={steps ?? e.options?.steps} onChange={onSteps} />
            ) : undefined
          }
          extraChanged={e.id === 'omnivoice' && (steps ?? e.options?.steps ?? 16) !== 16}
          onRestore={onRestoreParams}
        />
      )}

      {test.result && (
        <p
          className="mt-1.5 text-[11.5px] text-success"
          role="status"
          data-testid={`gpu-engine-test-result-${e.id}`}
        >
          Teste ok: {measuredLine(e.kind, test.result)}
          {test.result.wer != null
            ? ` · ${Math.round(test.result.wer * 100)}% de palavras erradas na transcrição de volta`
            : ''}
        </p>
      )}
      <GpuError
        error={e.install.state === 'broken' ? (e.install.error ?? 'instalação incompleta') : null}
        testId={`gpu-engine-error-${e.id}`}
      />
      <GpuError error={error} testId={`gpu-engine-action-error-${e.id}`} />
    </div>
  )
}
