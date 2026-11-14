// Configurações → Áudio → "Modelos locais" (sub-tela com "← Áudio", no padrão do "editar" das
// Personas): TODA a configuração dos modelos que rodam no computador — CPU (catálogo do
// whisper.cpp/Vosk/Nemotron e do Kokoro com pesos e vozes: baixar, remover, progresso, estado em
// disco, e a prontidão dos runtimes) e GPU (o Modo avançado inteiro: hardware, runtime, motores
// "Voz (TTS)"/"Transcrição (STT)" com parâmetros e "Minhas vozes"). Instalados, os modelos aparecem
// no seletor de Modelo da página principal (grupos "Local (CPU)" e "Local (GPU)"); escolher qual
// usar fica lá. Aberta pelo botão ao lado do título "Áudio", pela busca ("kokoro", "gpu"…) e pelos
// links "instale em Modelos locais" (`setSettingsOpen(true, 'audio:local')`).
import { ArrowLeft, Check, TriangleAlert } from 'lucide-react'
import type { VoiceModelInfo, VoiceRuntimeStatus } from '@shared/ipc'
import type { SttSettings, TtsSettings } from '@shared/voice'
import type { LocalModelAction } from '../../lib/voice/modelList'
import { cn } from '../../lib/format'
import { C } from '../ui/Tooltip'
import { AudioSection, CARD, SubHeading, WarnNote } from './audioUi'
import { DismissibleError, LocalModelList } from './voiceSettingsParts'
import { GpuModeSection } from './gpu/GpuModeSection'

export function LocalModelsScreen({
  stt,
  tts,
  onCommitStt,
  onCommitTts,
  models,
  modelProgress,
  modelError,
  runtime,
  onModelAction,
  onDismissModelError,
  onBack
}: {
  stt: SttSettings
  tts: TtsSettings
  onCommitStt: (next: SttSettings) => Promise<boolean>
  onCommitTts: (next: TtsSettings) => Promise<boolean>
  models: VoiceModelInfo[]
  modelProgress: Record<string, { bytes: number; total: number }>
  modelError: string | null
  runtime: VoiceRuntimeStatus | null
  onModelAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
  onDismissModelError: () => void
  onBack: () => void
}): React.JSX.Element {
  const sttInstalled = models.filter((m) => m.kind === 'stt' && m.state === 'installed').length
  const ttsInstalled = models.some(
    (m) =>
      m.kind === 'tts' && m.engine === 'kokoro' && m.state === 'installed' && !/voice/i.test(m.id)
  )
  return (
    <div className="space-y-5" data-testid="audio-local-models">
      <div>
        <button
          type="button"
          onClick={onBack}
          data-testid="audio-local-back"
          aria-label="Voltar para Áudio"
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-subtle hover:text-fg"
        >
          <ArrowLeft className="size-3.5" /> Áudio
        </button>
      </div>

      <AudioSection
        title="No computador (CPU)"
        first
        testId="local-cpu-section"
        help={
          <>
            <p>
              Transcrição com o whisper.cpp, o Vosk ou o Nemotron e fala com o Kokoro-82M (ONNX),
              rodando na CPU. Os arquivos ficam em <C>userData/models</C> (verificados por tamanho,
              magic bytes e sha256); remover devolve o espaço.
            </p>
            <p>
              Para as parciais ao vivo um modelo pequeno (tiny/base) basta. A fonemização pt-BR do
              Kokoro usa o <C>espeak-ng</C> do sistema.
            </p>
          </>
        }
      >
        <RuntimeLine runtime={runtime} />
        <div className={cn(CARD, 'px-3.5 py-3')} data-testid="local-stt-models">
          <SubHeading>
            Transcrição (STT) — whisper.cpp, Vosk, Nemotron
            <span className="ml-1.5 text-faint" data-testid="local-stt-installed">
              ·{' '}
              {sttInstalled
                ? `${sttInstalled} instalado${sttInstalled > 1 ? 's' : ''}`
                : 'nenhum instalado'}
            </span>
          </SubHeading>
          {modelError && (
            <div className="mt-2">
              <DismissibleError
                error={modelError}
                onDismiss={onDismissModelError}
                testId="voice-model-error"
                dismissLabel="Dispensar erro de modelos locais"
              />
            </div>
          )}
          {runtime && stt.local?.installed && !runtime.sttLocal.available && (
            <div className="mt-2">
              <WarnNote testId="stt-runtime-warning">
                Motor local não está pronto: {runtime.sttLocal.reason ?? 'runtime indisponível'}
              </WarnNote>
            </div>
          )}
          <LocalModelList
            kind="stt"
            models={models}
            progress={modelProgress}
            onAction={onModelAction}
          />
        </div>
        <div className={cn(CARD, 'px-3.5 py-3')} data-testid="local-tts-models">
          <SubHeading>
            Fala (TTS) — Kokoro-82M: pesos e vozes
            <span className="ml-1.5 text-faint" data-testid="local-tts-installed">
              · {ttsInstalled ? 'instalado' : 'não instalado'}
            </span>
          </SubHeading>
          {runtime &&
            tts.local?.engine === 'kokoro' &&
            tts.local.installed &&
            !runtime.ttsLocal.available && (
              <div className="mt-2">
                <WarnNote testId="tts-runtime-warning">
                  Motor local não está pronto: {runtime.ttsLocal.reason ?? 'runtime indisponível'}
                </WarnNote>
              </div>
            )}
          <LocalModelList
            kind="tts"
            models={models}
            progress={modelProgress}
            onAction={onModelAction}
          />
        </div>
      </AudioSection>

      <GpuModeSection
        tts={tts}
        onCommitTts={onCommitTts}
        stt={stt}
        onCommitStt={onCommitStt}
        embedded
      />
    </div>
  )
}

/** Prontidão dos runtimes da CPU (probe do main): whisper.cpp, onnxruntime, espeak-ng. */
function RuntimeLine({
  runtime
}: {
  runtime: VoiceRuntimeStatus | null
}): React.JSX.Element | null {
  if (!runtime) return null
  const items: { label: string; ok: boolean; reason?: string | null }[] = [
    { label: 'whisper.cpp', ok: runtime.whisper.available, reason: runtime.whisper.reason },
    { label: 'onnxruntime', ok: runtime.onnxruntime.available, reason: runtime.onnxruntime.reason },
    { label: 'espeak-ng', ok: runtime.espeak.available, reason: runtime.espeak.reason }
  ]
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]" data-testid="local-runtime">
      {items.map((i) => (
        <li
          key={i.label}
          title={i.ok ? 'carrega neste computador' : (i.reason ?? 'indisponível')}
          className={cn('flex items-center gap-1', i.ok ? 'text-subtle' : 'text-warning')}
        >
          {i.ok ? <Check className="size-3 text-success" /> : <TriangleAlert className="size-3" />}
          {i.label}
          {!i.ok && <span className="text-[10.5px]">— {i.reason ?? 'indisponível'}</span>}
        </li>
      ))}
    </ul>
  )
}
