// Painéis "Local (GPU)" dentro de Fala (TTS) e Transcrição (STT) — o motor vem do seletor de
// Modelo: voz agrupada (Vozes do modelo / Voz pt-BR livre (CC0) / Minhas vozes) com prévia, passos
// do OmniVoice, "Parâmetros" do motor escolhido (velocidade, temperatura… — os mesmos do card em
// Modelos locais) e a prontidão visível (runtime/motor/servidor/compat) com o caminho para resolver
// em Áudio → Modelos locais (sub-tela com "← Áudio").
import { Info, TriangleAlert, OctagonX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SttSettings, TtsSettings } from '@shared/voice'
import { VOICE_PREVIEW_PHRASE } from '@shared/voiceCatalog'
import { GPU_CC0_VOICES } from '@shared/gpuVoice'
import { api, errorMessage } from '../../../lib/api'
import { cn } from '../../../lib/format'
import {
  compatUi,
  gpuSttProblems,
  gpuTtsProblems,
  groupGpuVoices,
  measuredLine,
  savedGpuParams,
  sttWithGpuParams,
  ttsWithGpuParams,
  type GpuProblem
} from '../../../lib/voice/gpu/gpuUi'
import {
  asGpuStt,
  asGpuTts,
  fromGpuTts,
  gpuApi,
  type GpuStatus,
  type GpuTtsEngineId
} from '../../../lib/voice/gpu/types'
import { refreshGpuStatus } from '../../../lib/voice/gpu/useGpuStatus'
import { openGpuLocalModels } from '../../../lib/voice/localModelsNav'
import { playAudioBytes } from '../../../lib/voice/voiceSettingsHelpers'
import { Button, Label } from '../../ui/controls'
import { DismissibleError, VoicePicker } from '../voiceSettingsParts'
import { Badge, StepsControl } from './gpuParts'
import { GpuParamsEditor } from './GpuParamsEditor'

/** Link "Modelos locais" que abre a sub-tela e mostra a parte da GPU. */
export function GpuSectionLink({
  children = 'Modelos locais',
  target = 'engines',
  testId
}: {
  children?: React.ReactNode
  target?: 'engines' | 'voices' | 'runtime'
  testId?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => openGpuLocalModels(target)}
      className="rounded px-0.5 text-accent-strong underline-offset-2 hover:underline"
    >
      {children}
    </button>
  )
}

/** Lista de problemas de prontidão (erro vermelho, aviso amarelo, info neutro). */
export function GpuReadiness({
  problems,
  testId
}: {
  problems: GpuProblem[]
  testId: string
}): React.JSX.Element | null {
  if (!problems.length) return null
  return (
    <ul className="space-y-1" data-testid={testId}>
      {problems.map((p) => (
        <li
          key={p.text}
          data-level={p.level}
          role={p.level === 'error' ? 'alert' : undefined}
          className={cn(
            'flex items-start gap-1.5 text-[11.5px] leading-snug',
            p.level === 'error'
              ? 'text-danger'
              : p.level === 'warn'
                ? 'text-warning'
                : 'text-subtle'
          )}
        >
          {p.level === 'error' ? (
            <OctagonX className="mt-0.5 size-3 shrink-0" />
          ) : p.level === 'warn' ? (
            <TriangleAlert className="mt-0.5 size-3 shrink-0" />
          ) : (
            <Info className="mt-0.5 size-3 shrink-0" />
          )}
          <span>
            {p.text.charAt(0).toUpperCase() + p.text.slice(1)}
            {/Modelos locais/.test(p.text) && (
              <>
                {' '}
                <GpuSectionLink testId={`${testId}-link`}>abrir</GpuSectionLink>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Painel de Fala com backend "Local (GPU)". `choiceTts` = voz de uma persona/chat (protocolo
 * 1.9.0): só motor + voz são dela — passos e parâmetros do motor ficam nas settings deste
 * dispositivo (escondidos aqui) e a prévia sai com a voz da persona.
 */
export function GpuTtsPanel({
  tts,
  status,
  onCommit,
  choiceTts
}: {
  tts: TtsSettings
  status: GpuStatus | null
  onCommit: (next: TtsSettings) => Promise<boolean>
  choiceTts?: unknown
}): React.JSX.Element {
  const voiceOnly = choiceTts !== undefined
  const g = asGpuTts(tts)
  const engine = status?.engines.find((e) => e.id === g.gpu?.engine) ?? null
  const [preview, setPreview] = useState<{ id: string; state: 'busy' | 'playing' } | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** CC0 em download (id) — uma por vez. */
  const [cc0Busy, setCc0Busy] = useState<string | null>(null)
  const player = useRef<{ el: HTMLAudioElement; url: string } | null>(null)
  const problems = gpuTtsProblems(g, status)

  const stop = (): void => {
    const p = player.current
    player.current = null
    if (p) {
      p.el.pause()
      URL.revokeObjectURL(p.url)
    }
  }
  useEffect(() => () => stop(), [])

  const save = (gpu: NonNullable<typeof g.gpu>): void => void onCommit(fromGpuTts({ ...g, gpu }))

  const runPreview = (id: string, label: string): void => {
    const v = { id, label }
    if (preview?.id === v.id && preview.state === 'playing') {
      stop()
      setPreview(null)
      return
    }
    stop()
    setError(null)
    setPreview({ id: v.id, state: 'busy' })
    void api.voice?.tts
      .test({
        voice: v.id,
        text: VOICE_PREVIEW_PHRASE,
        ...(voiceOnly ? { tts: choiceTts } : {})
      })
      .then((r) => {
        setPreview({ id: v.id, state: 'playing' })
        player.current = playAudioBytes(
          r.audio,
          r.mime,
          () => {
            player.current = null
            setPreview(null)
          },
          (msg) => {
            player.current = null
            setPreview(null)
            setError(`Prévia de “${v.label}”: ${msg}`)
          }
        )
      })
      .catch((e) => {
        setPreview(null)
        setError(`Prévia de “${v.label}”: ${errorMessage(e).replace(/^[A-Z]\w*Error: /, '')}`)
      })
  }

  const downloadCc0 = (cc0: string): void => {
    const gpu = gpuApi()
    if (!gpu) return
    setCc0Busy(cc0)
    setError(null)
    void gpu
      .downloadCc0Voice({ id: cc0 })
      .then(async ({ id }) => {
        await refreshGpuStatus()
        if (g.gpu) save({ ...g.gpu, voice: id })
      })
      .catch((e) => setError(`Não foi possível baixar a voz livre: ${errorMessage(e)}`))
      .finally(() => setCc0Busy(null))
  }

  return (
    <div className="space-y-3" data-testid="tts-gpu">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-subtle">
        {engine?.measured && <span>{measuredLine('tts', engine.measured)}</span>}
        {engine && !engine.license.commercial && <Badge>não comercial</Badge>}
        {engine && engine.compat.level !== 'ok' && (
          <Badge tone={compatUi(engine.compat).tone}>{compatUi(engine.compat).badge}</Badge>
        )}
        <span className="ml-auto">
          gerenciar em <GpuSectionLink testId="tts-gpu-manage" />
        </span>
      </div>
      {engine?.id === 'omnivoice' && !voiceOnly && (
        <StepsControl
          value={g.gpu?.steps ?? engine.options?.steps}
          testId="tts-gpu-steps"
          onChange={(steps) => g.gpu && save({ ...g.gpu, steps })}
        />
      )}
      {engine && engine.install.state === 'installed' && (
        <div>
          <Label help="Vozes do modelo: as que vêm prontas (as de sotaque de Portugal estão marcadas). Voz pt-BR livre: uma voz brasileira de domínio público (CC0) para clonar. Minhas vozes: as que você gravou ou enviou em Modelos locais. ▶ sintetiza uma frase curta no servidor local.">
            Voz
          </Label>
          <VoicePicker
            groups={groupGpuVoices(engine).map((gr) => ({
              key: gr.key,
              title: gr.title,
              voices: gr.voices.map((v) => ({
                id: v.id,
                label: v.label,
                badges:
                  v.accent === 'pt-PT' ? (
                    <Badge tone="warning" testId={`gpu-voice-ptpt-${v.id}`}>
                      sotaque de Portugal
                    </Badge>
                  ) : v.accent === 'pt-BR' ? (
                    <Badge>pt-BR</Badge>
                  ) : undefined
              })),
              extra:
                gr.key === 'builtin' && !gr.voices.length ? (
                  <span className="text-[11.5px] text-subtle">O modelo não tem vozes prontas.</span>
                ) : gr.key === 'cc0' &&
                  GPU_CC0_VOICES.some((c) => !gr.voices.some((v) => v.id === c.id)) ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11.5px] text-subtle">
                      {gr.voices.length
                        ? 'Mais vozes brasileiras de domínio público:'
                        : 'Vozes brasileiras de domínio público para clonar (~90 KB cada):'}
                    </span>
                    {GPU_CC0_VOICES.filter((c) => !gr.voices.some((v) => v.id === c.id)).map(
                      (c, i) => (
                        <Button
                          key={c.id}
                          size="sm"
                          variant="secondary"
                          loading={cc0Busy === c.id}
                          disabled={!!cc0Busy && cc0Busy !== c.id}
                          title={`${c.attribution} — ${c.license}`}
                          data-testid={
                            i === 0 && !gr.voices.length
                              ? 'gpu-cc0-download'
                              : `gpu-cc0-download-${c.id}`
                          }
                          onClick={() => downloadCc0(c.id)}
                        >
                          Baixar {c.name.replace(/\s*\(.*\)$/, '')}
                        </Button>
                      )
                    )}
                  </span>
                ) : gr.key === 'user' ? (
                  (close: () => void) => (
                    <span className="flex flex-wrap items-center gap-2">
                      {!gr.voices.length && (
                        <span className="text-[11.5px] text-subtle">Nenhuma voz sua ainda.</span>
                      )}
                      <button
                        type="button"
                        data-testid="gpu-voice-add-mine"
                        onClick={() => {
                          close()
                          openGpuLocalModels('voices')
                        }}
                        className="text-[11.5px] text-accent-strong hover:underline"
                      >
                        Gravar ou enviar uma voz…
                      </button>
                    </span>
                  )
                ) : undefined
            }))}
            value={g.gpu?.voice ?? null}
            onChange={(voice) => g.gpu && voice && save({ ...g.gpu, voice })}
            onPreview={runPreview}
            previewing={preview}
            allowFree={false}
            testId="gpu-voice"
            optionTestId="gpu-voice"
            previewTestId="gpu-voice-preview"
            label="Voz da fala (GPU local)"
            placeholder="Escolha uma voz…"
          />
        </div>
      )}
      {engine && engine.install.state === 'installed' && !voiceOnly && (
        <GpuParamsEditor
          engineId={engine.id}
          engineLabel={engine.label}
          kind="tts"
          value={savedGpuParams(engine.id, g, null)}
          onChange={(next) =>
            void onCommit(fromGpuTts(ttsWithGpuParams(g, engine.id as GpuTtsEngineId, next)))
          }
          testId="tts-gpu-params"
        />
      )}
      <GpuReadiness problems={problems} testId="tts-gpu-readiness" />
      <DismissibleError
        error={error}
        onDismiss={() => setError(null)}
        testId="tts-gpu-error"
        dismissLabel="Dispensar erro da voz da GPU"
      />
    </div>
  )
}

/** Painel de Transcrição com modo "Local (GPU)" (whisper large-v3-turbo). */
export function GpuSttPanel({
  stt,
  status,
  onCommit
}: {
  stt: SttSettings
  status: GpuStatus | null
  /** Grava os parâmetros do whisper (`sttSettings.gpu.params`); ausente = sem editor. */
  onCommit?: (next: SttSettings) => Promise<boolean>
}): React.JSX.Element {
  const s = asGpuStt(stt)
  const id = s.gpu?.engine ?? 'whisper-large-v3-turbo'
  const engine = status?.engines.find((e) => e.id === id) ?? null
  return (
    <div
      className="space-y-2 rounded-xl border border-border bg-elevated/40 px-3.5 py-3"
      data-testid="stt-gpu"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label
          className="mb-0"
          help="Transcrição pelo faster-whisper large-v3-turbo na sua GPU (int8, ~1,5 GB de VRAM): ~0,1 s por frase numa RTX 3080 Ti. Faz as parciais ao vivo e o fim de turno da chamada."
        >
          Motor
        </Label>
        <span className="text-[12px] text-fg/90">{engine?.label ?? 'Whisper large-v3-turbo'}</span>
        <Badge
          tone={engine?.install.state === 'installed' ? 'success' : 'warning'}
          testId="stt-gpu-state"
        >
          {engine?.install.state === 'installed' ? 'instalado' : 'não instalado'}
        </Badge>
        {engine?.measured && (
          <span className="text-[11.5px] text-subtle">{measuredLine('stt', engine.measured)}</span>
        )}
        <span className="ml-auto text-[11.5px] text-subtle">
          gerenciar em <GpuSectionLink testId="stt-gpu-manage" />
        </span>
      </div>
      {engine?.install.state === 'installed' && onCommit && (
        <GpuParamsEditor
          engineId="whisper-large-v3-turbo"
          engineLabel={engine.label}
          kind="stt"
          value={savedGpuParams('whisper-large-v3-turbo', null, s)}
          onChange={(next) => void onCommit(sttWithGpuParams(s, next))}
          testId="stt-gpu-params"
        />
      )}
      <GpuReadiness problems={gpuSttProblems(s, status)} testId="stt-gpu-readiness" />
    </div>
  )
}
