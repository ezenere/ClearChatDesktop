// Configurações → Áudio → Transcrição (STT). Um seletor só — MODELO — no mesmo desenho do chat:
// um grupo por provedor cadastrado em Configurações → Provedores que serve transcrição (OpenRouter,
// Groq, OpenAI, servidor local OpenAI-compatível…) + "Local (CPU)" (whisper.cpp/Vosk/Nemotron
// instalados) e "Local (GPU)" (Whisper do Modo avançado) — os grupos locais só aparecem com algo
// instalado (instalar/remover fica em "Modelos locais"). Escolher uma linha grava modo + provedor +
// motor + modelo de uma vez. Com modelo de API: "Parâmetros" do modelo (temperatura, dica de
// vocabulário) e, com um modelo local instalado, o interruptor do híbrido (motor local nas parciais
// e como reserva). Endereço e chave ficam só no provedor cadastrado — a chave nunca passa pela tela.
// Também é o seletor da TRANSCRIÇÃO DE UMA PERSONA/CHAT (`choice`, protocolo 1.9.0): `stt` = as
// settings deste dispositivo com a escolha aplicada, `onCommit` grava a escolha; o que é do
// dispositivo (parciais ao vivo, final rápida, parâmetros do whisper da GPU) fica de fora e o
// idioma da escolha entra em `extra`.
import { useCallback, type ReactNode } from 'react'
import type { VoiceModelInfo, VoiceRuntimeStatus } from '@shared/ipc'
import type { ModelRef } from '@shared/models'
import type { SttSettings } from '@shared/voice'
import { STT_LOCAL_PARTIAL_MAX_MODEL_BYTES } from '@shared/voice'
import type { VoiceProviderSupport } from '@shared/voiceCatalog'
import { apiParamsToSend } from '@shared/voiceParams'
import { useVoiceCatalogs } from '../../lib/voice/useVoiceCatalogs'
import { useStore } from '../../store'
import { ToggleRow } from '../panel/fields'
import { Label } from '../ui/controls'
import { ApiInfo, C } from '../ui/Tooltip'
import { AudioSection, WarnNote } from './audioUi'
import { VoiceModelField } from './voiceSettingsParts'
import { ApiParamsEditor } from './ApiParamsEditor'
import {
  effectiveFamily,
  providerMissing,
  type ProviderOption
} from '../../lib/voice/voiceSettingsHelpers'
import {
  applySttPick,
  hybridLocalModel,
  hybridToggleVisible,
  setHybrid,
  sttLocalGroups,
  sttModelRef
} from '../../lib/voice/voiceModelOptions'
import { useGpuStatus } from '../../lib/voice/gpu/useGpuStatus'
import { GpuSttPanel } from './gpu/GpuBackendPanels'

export function SttSettingsSection({
  stt,
  language,
  providers,
  models,
  runtime,
  onCommit,
  choice,
  extra
}: {
  stt: SttSettings
  language: string
  providers: ProviderOption[]
  /** Modelos locais (catálogo + estado em disco) — os instalados entram no seletor. */
  models: VoiceModelInfo[]
  runtime: VoiceRuntimeStatus | null
  /** Grava `sttSettings` (ou, com `choice`, a transcrição da persona/chat). */
  onCommit: (next: SttSettings) => Promise<boolean>
  /** Transcrição de uma persona/chat (`voice.stt`): título/textos do nível ("desta persona"). */
  choice?: { where: string }
  /** Controles extras depois do Modelo (o idioma da escolha da persona/chat). */
  extra?: ReactNode
}): React.JSX.Element {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const mode = stt.mode
  const usesApi = mode === 'api' || mode === 'hybrid'
  const provider = providers.find((p) => p.id === stt.api.providerId) ?? null
  const missing = usesApi && providerMissing(stt.api, providers)
  const catalogs = useVoiceCatalogs('stt', usesApi ? (provider?.id ?? null) : null)
  const family = effectiveFamily(provider)
  const { status: gpuStatus } = useGpuStatus()
  const localGroups = sttLocalGroups(models, gpuStatus, stt)
  const ref = sttModelRef(stt)

  // estável para o efeito de correção de apelido do campo de modelo
  const pickModel = useCallback(
    (r: ModelRef) => void onCommit(applySttPick(stt, r, models)),
    [onCommit, stt, models]
  )

  const local = stt.local
  const localModel = local ? models.find((m) => m.id === local.model) : undefined
  // modelo grande demais para parciais por janelas (o runtime as desliga — mesma regra do main)
  const localPartialsOff =
    !!localModel &&
    localModel.engine === 'whisper.cpp' &&
    localModel.sizeBytes > STT_LOCAL_PARTIAL_MAX_MODEL_BYTES
  const runtimeProblem =
    runtime && local?.installed && !runtime.sttLocal.available
      ? (runtime.sttLocal.reason ?? 'runtime indisponível')
      : null
  const showHybrid = hybridToggleVisible(stt, models) || (mode === 'hybrid' && !!provider)
  const hybridModel = hybridLocalModel(stt, models)
  const catalogModel =
    catalogs.stateFor(provider?.id ?? null).catalog?.models.find((m) => m.id === stt.api.model) ??
    null

  return (
    <AudioSection
      title={choice ? `Transcrição ${choice.where}` : 'Transcrição (STT)'}
      first={!!choice}
      testId={choice ? 'stt-choice-section' : 'stt-section'}
      help={
        <>
          <p>
            O áudio do ditado e da chamada de voz vira texto por um modelo de um provedor cadastrado
            em Configurações → Provedores (OpenRouter, Groq, OpenAI ou um servidor local
            OpenAI-compatível — localhost pode ficar sem chave) ou por um modelo local instalado em
            “Modelos locais” (CPU ou GPU — o áudio não sai do computador).
          </p>
          <p>
            A chave do provedor fica no processo principal e nunca chega à tela. Os modelos vêm da
            lista do próprio provedor (OpenRouter: <C>/models?output_modalities=transcription</C>).
          </p>
        </>
      }
      info={
        usesApi ? (
          <SttApiInfo
            stt={stt}
            baseUrl={provider?.baseUrl ?? ''}
            language={language}
            family={family}
          />
        ) : undefined
      }
    >
      <div>
        <Label help="Um seletor para tudo: os modelos de transcrição de cada provedor cadastrado (o endpoint e a chave vêm de Configurações → Provedores) e, quando houver algo instalado em “Modelos locais”, os grupos Local (CPU) e Local (GPU). Escolher um modelo já define o provedor/motor. Um id sem o prefixo do OpenRouter (ex.: whisper-large-v3-turbo) é corrigido sozinho para o id listado. Os lentos para a chamada têm o badge “lento”.">
          Modelo
        </Label>
        <VoiceModelField
          capability="stt"
          catalogs={catalogs}
          providers={providers}
          value={{ providerId: ref?.providerId ?? null, model: ref?.model ?? '' }}
          onChange={pickModel}
          testId="stt-model"
          localGroups={localGroups}
        />
      </div>

      {extra}

      {missing && (
        <WarnNote testId="stt-provider-missing">
          O provedor do modelo escolhido não existe mais — escolha outro modelo acima.
        </WarnNote>
      )}

      {usesApi && provider && (
        <ApiParamsEditor
          capability="stt"
          family={family}
          model={stt.api.model}
          modelLabel={catalogModel?.label ?? stt.api.model}
          params={stt.api.params}
          onChange={(params) => {
            const { params: _drop, ...rest } = stt.api
            void _drop
            void onCommit({ ...stt, api: params ? { ...rest, params } : rest })
          }}
          testId="stt-api-params"
          persona={!!choice}
        />
      )}

      {mode === 'gpu' && (
        <GpuSttPanel stt={stt} status={gpuStatus} onCommit={choice ? undefined : onCommit} />
      )}

      {mode === 'local' && (
        <div className="space-y-1.5" data-testid="stt-local">
          <p
            className={`text-[11.5px] ${local?.installed && localModel ? 'text-subtle' : 'text-warning'}`}
            data-testid="stt-local-current"
          >
            {local?.installed && localModel
              ? `No computador (CPU) com ${localModel.name} — o áudio nunca sai daqui.`
              : 'Nenhum modelo local instalado — '}
            {!(local?.installed && localModel) && (
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setSettingsOpen(true, 'audio:local')}
              >
                instale em Modelos locais
              </button>
            )}
          </p>
          {runtimeProblem && (
            <WarnNote testId="stt-runtime-warning">
              Motor local não está pronto: {runtimeProblem}
            </WarnNote>
          )}
        </div>
      )}

      {showHybrid && (
        <ToggleRow
          label="Motor local nas parciais e como reserva"
          checked={mode === 'hybrid'}
          onChange={(v) => void onCommit(setHybrid(stt, v, models))}
          help="Híbrido: a API faz a transcrição final; o modelo local (CPU) faz as parciais ao vivo e a transcrição especulativa do fim de turno da chamada, e transcreve quando a API falha por rede/cota/5xx. Um modelo pequeno (base) basta. Aparece com um modelo local de transcrição instalado em Modelos locais."
          status={
            mode === 'hybrid' ? (
              hybridModel ? (
                <span data-testid="stt-hybrid-model">
                  Modelo local: {hybridModel.name} (parciais, especulação e reserva)
                </span>
              ) : (
                <span className="text-warning" data-testid="stt-hybrid-missing">
                  Nenhum modelo local instalado — as parciais vão pela API e não há reserva.
                </span>
              )
            ) : undefined
          }
        />
      )}

      {!choice && (
        <ToggleRow
          label="Parciais ao vivo"
          checked={stt.livePartials}
          onChange={(livePartials) => void onCommit({ ...stt, livePartials })}
          help={
            mode === 'gpu'
              ? 'Melhor-esforço enquanto você fala: o whisper da GPU transcreve em janelas (rápido o bastante para o large-v3-turbo).'
              : mode === 'local'
                ? 'Melhor-esforço enquanto você fala: o motor local transcreve em janelas (só modelos até o base).'
                : 'Melhor-esforço enquanto você fala: o texto parcial aparece no composer (fora do texto editável) e a transcrição final entra no rascunho ao parar. Só pela API, cada parcial é uma request extra ao provedor; com o motor local como reserva, elas vêm dele quando pronto.'
          }
          status={
            mode === 'local' && stt.livePartials && localPartialsOff && localModel ? (
              <span className="text-warning" data-testid="stt-partials-off">
                Desligadas para {localModel.name}: grande demais para transcrever enquanto você fala
                — o texto aparece nas pausas. Use o ggml-base ou o ggml-tiny para ver ao vivo.
              </span>
            ) : undefined
          }
        />
      )}
      {!choice && usesApi && stt.livePartials && (
        <ToggleRow
          label="Final rápida (usar a parcial)"
          checked={stt.reusePartialFinal !== false}
          onChange={(reusePartialFinal) => void onCommit({ ...stt, reusePartialFinal })}
          help="Ditado: quando a última parcial já transcreveu a fala inteira desde a última pausa, ela vira o texto final na hora (sem esperar outra transcrição). Desligado: a final sempre transcreve de novo (um pouco mais precisa, mais lenta). A chamada de voz sempre aproveita."
        />
      )}
    </AudioSection>
  )
}

/** `</>` da transcrição: a request multipart exata do `/audio/transcriptions`. */
function SttApiInfo({
  stt,
  baseUrl,
  language,
  family
}: {
  stt: SttSettings
  baseUrl: string
  language: string
  family: VoiceProviderSupport | null
}): React.JSX.Element {
  const lang = language.split(/[-_]/)[0]?.toLowerCase() || language
  const extra = Object.entries(apiParamsToSend('stt', family, stt.api.model, stt.api.params))
  return (
    <ApiInfo
      title="Transcrição: request de cada gravação (e das parciais)"
      code={[
        `POST ${(baseUrl || '{endpoint}').replace(/\/+$/, '')}/audio/transcriptions`,
        'Authorization: Bearer {chave do provedor}',
        'Content-Type: multipart/form-data',
        '',
        'file            = audio.wav (PCM16 mono 16 kHz — o áudio gravado)',
        `model           = ${stt.api.model || '{modelo}'}`,
        `language        = ${lang}`,
        'response_format = json',
        ...extra.map(([k, v]) => `${k.padEnd(15)} = ${String(v)}`)
      ].join('\n')}
      codeLabel={
        family === 'openrouter'
          ? 'Com provedor de API · OpenRouter (a chave do provedor entra no header)'
          : 'Com provedor de API (a chave entra no header; servidor local pode ficar sem)'
      }
    >
      <p>
        Só o áudio gravado e esses campos saem do app (os de “Parâmetros” só quando escolhidos). Com{' '}
        <C>Parciais ao vivo</C> só pela API, o mesmo request é repetido em janelas enquanto você
        fala (melhor-esforço); a transcrição final manda o áudio inteiro. Com um modelo local nada
        sai do computador.
      </p>
    </ApiInfo>
  )
}
