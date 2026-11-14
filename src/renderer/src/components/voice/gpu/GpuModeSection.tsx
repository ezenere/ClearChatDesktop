// Configurações → Áudio → Modelos locais → "GPU local (Modo avançado)" — na sub-tela "Modelos
// locais" fica sempre aberta (`embedded`); fora dela, fechada por padrão (badge "avançado"):
// hardware detectado (só os fatos; a compatibilidade fica no card de cada motor — uma linha curta no
// topo só quando NADA roda), runtime (Python + PyTorch + servidor, baixado sob demanda — os
// modelos, inclusive o Whisper, são instalados à parte), motores em DUAS seções — "Voz (TTS)" e
// "Transcrição (STT)" — com um card por motor (e "Parâmetros" por motor), status do servidor local
// (só leitura: ele liga sozinho na chamada/ditado/"Testar voz" e desliga ocioso; "Parar agora"
// discreto) e "Minhas vozes".
// Tudo é baixar-para-usar; a checagem de hardware AVISA quando algo pode não rodar bem (instalar
// pede confirmação) e só BLOQUEIA o que é incompatível de verdade. Contrato: `window.api.voice.gpu`
// (tipos espelhados em `lib/voice/gpu/types.ts`); status compartilhado em `useGpuStatus`.
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  HardDrive,
  OctagonX,
  RefreshCw,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SttSettings, TtsSettings } from '@shared/voice'
import type { GpuParamValues } from '@shared/gpuVoice'
import { errorMessage } from '../../../lib/api'
import { cn } from '../../../lib/format'
import {
  formatMb,
  gpuBusy,
  gpuConfigFor,
  gpuServerLine,
  hardwareVerdict,
  RUNTIME_TYPICAL_MB,
  savedGpuParams,
  sortGpuEngines,
  sttWithGpuParams,
  ttsWithGpuParams,
  type HardwareVerdict
} from '../../../lib/voice/gpu/gpuUi'
import {
  asGpuTts,
  fromGpuTts,
  gpuApi,
  type GpuEngineId,
  type GpuEngineStatus,
  type GpuInfo,
  type GpuSelfTestResult,
  type GpuStatus,
  type GpuTtsEngineId
} from '../../../lib/voice/gpu/types'
import {
  patchGpuStatus,
  refreshGpuStatus,
  setGpuSectionExpanded,
  useGpuStatus,
  useGpuStore
} from '../../../lib/voice/gpu/useGpuStatus'
import { Button, IconButton } from '../../ui/controls'
import { C, HelpTip } from '../../ui/Tooltip'
import { Badge, GpuError, GpuProgress } from './gpuParts'
import { GpuEngineCard } from './GpuEngineCard'
import { GpuUserVoices } from './GpuUserVoices'

const VENDOR: Record<GpuInfo['vendor'], string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  apple: 'Apple',
  intel: 'Intel',
  other: 'outra'
}
const OS_LABEL: Record<GpuStatus['platform']['os'], string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows'
}

export function GpuModeSection({
  tts,
  onCommitTts,
  stt,
  onCommitStt,
  embedded = false
}: {
  tts: TtsSettings
  onCommitTts: (next: TtsSettings) => Promise<boolean>
  /** Transcrição (parâmetros do whisper em `sttSettings.gpu.params`); ausente = sem editor. */
  stt?: SttSettings
  onCommitStt?: (next: SttSettings) => Promise<boolean>
  /** Dentro da sub-tela "Modelos locais": sempre aberta (sem o recolher). */
  embedded?: boolean
}): React.JSX.Element {
  const state = useGpuStatus()
  const { status, available, loading, error, reveal, revealTarget } = state
  const expanded = embedded || state.expanded
  const root = useRef<HTMLElement>(null)
  const engines = useRef<HTMLDivElement>(null)

  // abrir a seção relê o status (o hardware/VRAM livre muda)
  useEffect(() => {
    if (expanded) void refreshGpuStatus()
  }, [expanded])

  // link "instale em Modelos locais" dos painéis de Fala/Transcrição: rola até a seção (uma vez —
  // o pedido é consumido para não rolar de novo ao reabrir a sub-tela)
  useEffect(() => {
    if (!reveal || revealTarget === 'voices') return
    const t = setTimeout(() => {
      const el = revealTarget === 'engines' ? (engines.current ?? root.current) : root.current
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      useGpuStore.setState({ reveal: 0 })
    }, 60)
    return () => clearTimeout(t)
  }, [reveal, revealTarget])

  return (
    <section
      ref={root}
      className="settings-section settings-divided"
      data-testid="gpu-mode-section"
      data-expanded={expanded}
    >
      <div className="flex items-center gap-2">
        {embedded ? (
          <h4 className="text-[13px] font-medium text-fg" data-testid="gpu-mode-title">
            GPU local (Modo avançado)
          </h4>
        ) : (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls="gpu-mode-body"
            data-testid="gpu-mode-toggle"
            onClick={() => setGpuSectionExpanded(!expanded)}
            className="flex items-center gap-1.5 rounded-md text-left text-[13px] font-medium text-fg hover:text-fg"
          >
            {expanded ? (
              <ChevronDown className="size-3.5 text-subtle" />
            ) : (
              <ChevronRight className="size-3.5 text-subtle" />
            )}
            Modo avançado (GPU local)
          </button>
        )}
        <Badge tone="accent">avançado</Badge>
        <HelpTip label="Modo avançado (GPU local)" wide>
          <p>
            Roda motores de voz (OmniVoice, XTTS-v2, VibeVoice, Qwen3-TTS) e a transcrição (whisper
            large-v3-turbo) na sua placa de vídeo, num servidor local que o app sobe e derruba
            sozinho. O texto falado e o áudio gravado não saem do computador.
          </p>
          <p>
            Nada vem instalado: primeiro o runtime (Python + PyTorch, ~5–8 GB, baixado do PyPI e do
            PyTorch), depois cada motor que você quiser (pesos do Hugging Face, 1,6–4,5 GB cada).
            Remover devolve o espaço.
          </p>
          <p>
            Feito para GPU NVIDIA (CUDA). Sem ela os motores rodam na CPU ou no Metal (Mac) — dá
            para instalar, mas fica lento para chamada. Motores incompatíveis com o computador ficam
            bloqueados.
          </p>
        </HelpTip>
      </div>
      {!expanded && (
        <p className="mt-1 pl-5 text-[11.5px] text-subtle" data-testid="gpu-mode-summary">
          Voz e transcrição na sua placa de vídeo, sem internet na hora de usar. Download grande;
          opcional.
        </p>
      )}
      {expanded && (
        <div id="gpu-mode-body" className="mt-3 space-y-3" data-testid="gpu-mode-body">
          {!available ? (
            <p className="text-[12px] text-subtle" data-testid="gpu-unavailable">
              O modo GPU local não está disponível neste build.
            </p>
          ) : !status ? (
            <div className="space-y-2">
              {error ? (
                <GpuError error={error} testId="gpu-status-error" />
              ) : (
                <p className="text-[12px] text-subtle">
                  {loading ? 'Verificando o hardware…' : 'Sem status.'}
                </p>
              )}
              <Button size="sm" variant="secondary" onClick={() => void refreshGpuStatus()}>
                Tentar de novo
              </Button>
            </div>
          ) : (
            <GpuModeBody
              status={status}
              loading={loading}
              tts={tts}
              onCommitTts={onCommitTts}
              stt={stt ?? null}
              onCommitStt={onCommitStt}
              enginesRef={engines}
            />
          )}
        </div>
      )}
    </section>
  )
}

function GpuModeBody({
  status,
  loading,
  tts,
  onCommitTts,
  stt,
  onCommitStt,
  enginesRef
}: {
  status: GpuStatus
  loading: boolean
  tts: TtsSettings
  onCommitTts: (next: TtsSettings) => Promise<boolean>
  stt: SttSettings | null
  onCommitStt?: (next: SttSettings) => Promise<boolean>
  enginesRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const verdict = hardwareVerdict(status)
  const runtimeInstalled = status.runtime.state === 'installed'
  const busy = gpuBusy(status)
  const list = sortGpuEngines(status.engines)
  const ttsList = list.filter((e) => e.kind === 'tts')
  const sttList = list.filter((e) => e.kind === 'stt')
  const whisper = status.engines.find((e) => e.id === 'whisper-large-v3-turbo')
  const gtts = asGpuTts(tts)
  const nvidia = status.gpus
    .filter((g) => g.vendor === 'nvidia')
    .reduce<GpuInfo | null>(
      (a, b) => (!a || (b.vramTotalMb ?? 0) > (a.vramTotalMb ?? 0) ? b : a),
      null
    )

  const installEngine = async (id: GpuEngineId): Promise<void> => {
    const gpu = gpuApi()
    if (!gpu) return
    patchGpuStatus((s) => ({
      ...s,
      engines: s.engines.map((e) =>
        e.id === id
          ? {
              ...e,
              install: { state: 'installing', progress: { phase: 'preparando…', pct: 0 } }
            }
          : e
      )
    }))
    try {
      await gpu.installEngine(id)
    } finally {
      await refreshGpuStatus()
    }
  }
  const removeEngine = async (id: GpuEngineId): Promise<void> => {
    const gpu = gpuApi()
    if (!gpu) return
    try {
      await gpu.removeEngine(id)
    } finally {
      await refreshGpuStatus()
    }
  }
  const cancel = (): void => {
    void gpuApi()
      ?.cancel()
      .catch(() => void 0)
      .finally(() => void refreshGpuStatus())
  }
  const selfTest = async (id: GpuEngineId): Promise<GpuSelfTestResult> => {
    const gpu = gpuApi()
    if (!gpu) throw new Error('modo GPU indisponível')
    const r = await gpu.selfTest(id)
    void refreshGpuStatus()
    return r
  }
  const saveSteps = (steps: number): void => {
    const omni = status.engines.find((e) => e.id === 'omnivoice')
    const prev = gtts.gpu
    const gpu =
      prev?.engine === 'omnivoice'
        ? { ...prev, steps }
        : prev
          ? { ...prev, steps } // guardado para quando o OmniVoice for escolhido
          : omni
            ? { ...gpuConfigFor(omni, null), steps }
            : { engine: 'omnivoice' as const, voice: null, steps }
    void onCommitTts(fromGpuTts({ ...gtts, gpu }))
  }
  /** Parâmetros de um motor: fala → `ttsSettings.gpu.params[id]`; whisper → `sttSettings.gpu.params`. */
  const saveParams = (e: GpuEngineStatus, next: GpuParamValues): void => {
    if (e.kind === 'stt') {
      if (stt && onCommitStt) void onCommitStt(sttWithGpuParams(stt, next))
      return
    }
    void onCommitTts(fromGpuTts(ttsWithGpuParams(gtts, e.id as GpuTtsEngineId, next)))
  }
  /** "Restaurar padrão" num commit só (OmniVoice: parâmetros + passos 16). */
  const restoreParams = (e: GpuEngineStatus): void => {
    if (e.kind === 'stt') return saveParams(e, {})
    const t = ttsWithGpuParams(gtts, e.id as GpuTtsEngineId, {})
    void onCommitTts(
      fromGpuTts(e.id === 'omnivoice' && t.gpu ? { ...t, gpu: { ...t.gpu, steps: 16 } } : t)
    )
  }
  const card = (e: GpuEngineStatus): React.JSX.Element => (
    <GpuEngineCard
      key={e.id}
      engine={e}
      runtimeInstalled={runtimeInstalled}
      otherBusy={busy && e.install.state !== 'installing'}
      steps={gtts.gpu?.steps}
      onInstall={() => installEngine(e.id)}
      onCancel={cancel}
      onRemove={() => removeEngine(e.id)}
      onSelfTest={() => selfTest(e.id)}
      onSteps={e.id === 'omnivoice' ? saveSteps : undefined}
      params={savedGpuParams(e.id, gtts, stt)}
      onParams={e.kind === 'stt' && !(stt && onCommitStt) ? undefined : (n) => saveParams(e, n)}
      onRestoreParams={() => restoreParams(e)}
      vramFreeMb={nvidia?.vramFreeMb ?? null}
    />
  )

  return (
    <>
      <HardwareCard status={status} verdict={verdict} loading={loading} />
      <RuntimeCard status={status} verdict={verdict} onCancel={cancel} />
      {runtimeInstalled && <ServerLine status={status} />}
      <div ref={enginesRef} className="space-y-4" data-testid="gpu-engines">
        <div className="space-y-2" data-testid="gpu-engines-tts">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-medium text-fg/90">Voz (TTS)</span>
            <HelpTip label="Motores de voz da GPU" wide>
              <p>
                Motores que FALAM as respostas. Cada um é um download separado (pesos do Hugging
                Face). Instalados, aparecem no seletor de Modelo de Fala (TTS), no grupo “Local
                (GPU)”; a voz é escolhida logo abaixo dele.
              </p>
              <p>
                “Testar” sintetiza uma frase curta no servidor local e mede o tempo até o 1º áudio e
                a velocidade (vezes o tempo real); “Parâmetros” ajusta velocidade, entonação etc. de
                cada motor (vale na próxima fala).
              </p>
              <p>
                Licenças: os pesos “não comercial” (CPML, CC-BY-NC, “research only”) servem para uso
                pessoal; confira o link de cada um antes de usar em trabalho pago.
              </p>
            </HelpTip>
            {!runtimeInstalled && verdict.level !== 'blocked' && (
              <span className="text-[11.5px] text-subtle">
                instalar um motor baixa o runtime junto
              </span>
            )}
          </div>
          {ttsList.map(card)}
        </div>
        <div className="space-y-2" data-testid="gpu-engines-stt">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-medium text-fg/90">Transcrição (STT)</span>
            <HelpTip label="Transcrição na GPU" wide>
              <p>
                O modelo que ESCUTA (ditado, chamada e a transcrição automática das suas vozes). É
                um download à parte do runtime (~1,6 GB): o runtime só traz a biblioteca
                faster-whisper, não o modelo.
              </p>
              <p>
                Instalado, aparece no seletor de Modelo de Transcrição (STT), no grupo “Local
                (GPU)”. “Testar” transcreve uma frase gravada e mede o tempo por frase.
              </p>
            </HelpTip>
          </div>
          {sttList.map(card)}
        </div>
      </div>
      <GpuUserVoices status={status} whisperInstalled={whisper?.install.state === 'installed'} />
    </>
  )
}

function HardwareCard({
  status,
  verdict,
  loading
}: {
  status: GpuStatus
  verdict: HardwareVerdict
  loading: boolean
}): React.JSX.Element {
  return (
    <div
      className="rounded-xl border border-border bg-elevated/40 px-3.5 py-3"
      data-testid="gpu-hardware"
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-fg/90">Hardware</span>
        <HelpTip label="Hardware">
          Lido do sistema (nvidia-smi / informações do sistema) ao abrir esta seção e quando o
          servidor local liga ou desliga. “VRAM livre” é a memória da placa sem uso agora — o
          desktop, o navegador e jogos ocupam parte dela. A parte do servidor do próprio ClearChat
          aparece separada e não conta contra os motores (o app a libera ao trocar de motor).
        </HelpTip>
        <IconButton
          size="xs"
          label="Verificar o hardware de novo"
          className="ml-auto"
          data-testid="gpu-hardware-refresh"
          disabled={loading}
          onClick={() => void refreshGpuStatus()}
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </IconButton>
      </div>
      {/* sem banner de veredito (cada motor mostra a própria compatibilidade): só o caso em que
          NADA roda neste computador ganha uma linha curta */}
      {verdict.level === 'blocked' && (
        <p
          role="alert"
          data-testid="gpu-incompatible"
          className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-danger"
        >
          <OctagonX className="size-3.5 shrink-0" />
          <span className="min-w-0">{verdict.title}</span>
        </p>
      )}
      <ul className="mt-2 space-y-1 text-[11.5px] text-muted" data-testid="gpu-list">
        {status.gpus.length ? (
          status.gpus.map((g, i) => (
            <li key={`${g.name}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <Cpu className="size-3.5 shrink-0 text-subtle" />
              <span className="font-medium text-fg/85">{g.name}</span>
              <span className="text-subtle">{VENDOR[g.vendor]}</span>
              {g.vramTotalMb != null && (
                <span data-testid="gpu-vram">
                  VRAM {formatMb(g.vramTotalMb)}
                  {g.vramFreeMb != null ? ` (${formatMb(g.vramFreeMb)} livres` : ''}
                  {g.vramFreeMb != null && g.vramOwnMb
                    ? ` · ${formatMb(g.vramOwnMb)} com o servidor do ClearChat)`
                    : g.vramFreeMb != null
                      ? ')'
                      : ''}
                </span>
              )}
              {g.vramTotalMb == null && g.vendor === 'apple' && <span>memória unificada</span>}
              {g.driver && <span>driver {g.driver}</span>}
              {g.cudaMax && <span>CUDA até {g.cudaMax}</span>}
              {g.computeCap && <span>compute {g.computeCap}</span>}
            </li>
          ))
        ) : (
          <li className="flex items-center gap-2">
            <Cpu className="size-3.5 shrink-0 text-subtle" /> Nenhuma placa de vídeo dedicada
            detectada
          </li>
        )}
        <li className="flex flex-wrap items-center gap-x-2">
          <HardDrive className="size-3.5 shrink-0 text-subtle" />
          <span>
            {OS_LABEL[status.platform.os] ?? status.platform.os} {status.platform.arch}
          </span>
          <span>· {formatMb(status.platform.diskFreeMb)} livres em disco</span>
        </li>
      </ul>
    </div>
  )
}

function RuntimeCard({
  status,
  verdict,
  onCancel
}: {
  status: GpuStatus
  verdict: HardwareVerdict
  onCancel: () => void
}): React.JSX.Element {
  const rt = status.runtime
  const [confirm, setConfirm] = useState<'install' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const blocked = verdict.level === 'blocked'
  // sem GPU NVIDIA (CPU/Metal) o runtime instala, mas avisa e pede confirmação antes do download
  const confirmInstall = verdict.level === 'warn' && !status.gpus.some((g) => g.vendor === 'nvidia')
  const installedEngines = status.engines.filter((e) => e.install.state === 'installed')
  const enginesMb = installedEngines.reduce((n, e) => n + e.sizeMb, 0)
  const sizeLabel =
    rt.sizeMb != null ? `~${formatMb(rt.sizeMb)}` : `~5–${formatMb(RUNTIME_TYPICAL_MB)}`

  const install = (): void => {
    const gpu = gpuApi()
    if (!gpu) return
    setConfirm(null)
    setError(null)
    patchGpuStatus((s) => ({
      ...s,
      runtime: {
        ...s.runtime,
        state: 'installing',
        error: null,
        progress: { phase: 'preparando…', pct: 0 }
      }
    }))
    void gpu
      .installRuntime()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => void refreshGpuStatus())
  }
  const remove = (): void => {
    const gpu = gpuApi()
    if (!gpu) return
    setConfirm(null)
    setError(null)
    void gpu
      .removeRuntime()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => void refreshGpuStatus())
  }

  return (
    <div
      className="rounded-xl border border-border bg-elevated/40 px-3.5 py-3"
      data-testid="gpu-runtime"
      data-state={rt.state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-fg/90">Runtime</span>
        <HelpTip label="Runtime da GPU" wide>
          <p>
            Python + PyTorch (CUDA) + o servidor local e as bibliotecas de áudio, numa pasta própria
            do app (não mexe no Python do sistema). Um download só, compartilhado por todos os
            motores.
          </p>
          <p>
            Não inclui nenhum modelo: cada motor de voz e a transcrição (Whisper) são instalados à
            parte, nas seções abaixo.
          </p>
        </HelpTip>
        <Badge
          tone={rt.state === 'installed' ? 'success' : rt.state === 'broken' ? 'danger' : 'neutral'}
          testId="gpu-runtime-state"
        >
          {rt.state === 'installed'
            ? `instalado${rt.version ? ` · ${rt.version}` : ''}`
            : rt.state === 'installing'
              ? 'instalando…'
              : rt.state === 'broken'
                ? 'com problema'
                : 'não instalado'}
        </Badge>
        <span className="text-[11.5px] text-subtle" data-testid="gpu-runtime-size">
          {rt.state === 'installed'
            ? `${rt.sizeMb != null ? formatMb(rt.sizeMb) : ''} em disco${enginesMb ? ` + ${formatMb(enginesMb)} de motores` : ''}`
            : `${sizeLabel} de download`}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {rt.state === 'installing' ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<X className="size-3.5" />}
              data-testid="gpu-runtime-cancel"
              onClick={onCancel}
            >
              Cancelar
            </Button>
          ) : rt.state === 'installed' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<X className="size-3.5" />}
              data-testid="gpu-runtime-remove"
              disabled={!!confirm}
              onClick={() => setConfirm('remove')}
            >
              Remover
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={<Download className="size-3.5" />}
              data-testid="gpu-runtime-install"
              disabled={blocked || !!confirm}
              title={blocked ? verdict.title : undefined}
              onClick={() => (confirmInstall ? setConfirm('install') : install())}
            >
              {rt.state === 'broken' ? 'Reinstalar' : 'Instalar runtime'}
            </Button>
          )}
        </span>
      </div>
      {blocked && rt.state !== 'installed' && (
        <p className="mt-1 text-[11.5px] text-danger" data-testid="gpu-runtime-blocked">
          Instalação bloqueada: este computador não roda nenhum motor.
        </p>
      )}
      {confirm === 'install' && (
        <ConfirmBox
          testId="gpu-runtime-confirm"
          text={`${verdict.title}. O runtime pode ser instalado (${sizeLabel}), mas os motores podem ficar lentos demais para chamada. Instalar mesmo assim?`}
          yes="Instalar mesmo assim"
          onYes={install}
          onNo={() => setConfirm(null)}
        />
      )}
      {confirm === 'remove' && (
        <ConfirmBox
          testId="gpu-runtime-remove-confirm"
          text={`Remover o runtime apaga também os motores instalados${installedEngines.length ? ` (${installedEngines.map((e) => e.label).join(', ')} — ${formatMb(enginesMb)})` : ''}. Suas vozes clonadas ficam guardadas.`}
          yes="Remover tudo"
          danger
          onYes={remove}
          onNo={() => setConfirm(null)}
        />
      )}
      {rt.state === 'installing' && (
        <GpuProgress
          progress={rt.progress}
          label="Instalação do runtime"
          testId="gpu-runtime-progress"
        />
      )}
      {rt.state === 'installing' && rt.progress?.bytes != null && (
        <p className="text-[10.5px] text-faint tabular-nums">
          {formatMb(rt.progress.bytes / 1048576)} baixados
        </p>
      )}
      <GpuError
        error={rt.state === 'broken' ? (rt.error ?? 'o runtime não carrega') : (rt.error ?? null)}
        testId="gpu-runtime-error"
      />
      <GpuError error={error} testId="gpu-runtime-action-error" />
    </div>
  )
}

function ConfirmBox({
  text,
  yes,
  onYes,
  onNo,
  testId,
  danger
}: {
  text: string
  yes: string
  onYes: () => void
  onNo: () => void
  testId: string
  danger?: boolean
}): React.JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-label={yes}
      data-testid={testId}
      className="mt-2 rounded-lg border border-warning/35 bg-warning/[0.06] px-2.5 py-2 text-[11.5px]"
    >
      <p className="flex items-start gap-1.5 text-warning">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span>{text}</span>
      </p>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant={danger ? 'danger' : 'primary'}
          data-testid={`${testId}-yes`}
          onClick={onYes}
        >
          {yes}
        </Button>
        <Button size="sm" variant="ghost" onClick={onNo}>
          Cancelar
        </Button>
      </div>
    </div>
  )
}

const SERVER_DOT: Record<GpuStatus['server']['state'], string> = {
  stopped: 'bg-faint',
  starting: 'bg-warning animate-pulse',
  running: 'bg-success',
  error: 'bg-warning'
}

/**
 * Servidor local — só leitura: liga sozinho quando a chamada/ditado/"Testar voz"/clipes precisam
 * e desliga depois de um tempo sem uso. "Parar agora" (discreto) só enquanto está ligado, para
 * devolver a VRAM já.
 */
function ServerLine({ status }: { status: GpuStatus }): React.JSX.Element {
  const sv = status.server
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const line = gpuServerLine(status)
  const stop = (): void => {
    const gpu = gpuApi()
    if (!gpu) return
    setBusy(true)
    setError(null)
    void gpu
      .stopServer()
      .catch((e) => setError(errorMessage(e)))
      .finally(() => {
        setBusy(false)
        void refreshGpuStatus()
      })
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[12px]"
      data-testid="gpu-server"
      data-state={sv.state}
    >
      <span className={cn('size-2 shrink-0 rounded-full', SERVER_DOT[sv.state])} aria-hidden />
      <span className="text-fg/85">Servidor local:</span>
      <span data-testid="gpu-server-state" className="text-fg/85">
        {line.text}
      </span>
      <span className="text-[11.5px] text-subtle" data-testid="gpu-server-hint">
        — {line.hint}
      </span>
      <HelpTip label="Servidor local da GPU">
        <p>
          Processo local (só em <C>127.0.0.1</C>, com chave por sessão) que carrega os motores na
          GPU. Você não precisa ligar nada: ele sobe sozinho quando a chamada, o ditado, o “Testar
          voz” ou os clipes precisam — na chamada, a barra mostra “Preparando a GPU…” e o microfone
          só abre com os modelos carregados.
        </p>
        <p>
          Sem uso, os modelos saem da VRAM em 10 min e o processo desliga em 15 min. Fechar o app
          também desliga. “Parar agora” devolve a VRAM na hora (para um jogo, por exemplo).
        </p>
      </HelpTip>
      {(sv.state === 'running' || sv.state === 'starting') && (
        <Button
          size="sm"
          variant="ghost"
          loading={busy}
          className="ml-auto h-6 px-1.5 text-[11.5px]"
          icon={<Square className="size-2.5" fill="currentColor" />}
          data-testid="gpu-server-stop"
          onClick={stop}
        >
          Parar agora
        </Button>
      )}
      {sv.state === 'error' && sv.error && (
        <p className="w-full text-[11px] text-warning" data-testid="gpu-server-error">
          {sv.error.split('\n')[0]}
        </p>
      )}
      {error && <GpuError error={error} testId="gpu-server-action-error" />}
    </div>
  )
}
