// Configurações → Áudio, no padrão das outras abas (seções `h3` + (?) separadas por borda, campos
// de largura total, `ToggleRow` com o switch à direita, linhas "rótulo … número"): ditado
// (microfone padrão, idioma, push-to-talk com captura de tecla, auto-stop por silêncio),
// transcrição (STT — `SttSettingsSection`) e fala (TTS — `TtsSettingsSection`) com UM seletor de
// Modelo cada (provedores cadastrados + "Local (CPU)"/"Local (GPU)" quando há modelo instalado) e
// os "Parâmetros" do modelo, e os padrões da chamada de voz (ligada, fim de turno, modelo da
// chamada, preâmbulos). Tudo o que é modelo LOCAL (CPU e GPU — baixar/remover, runtime,
// Modo avançado, suas vozes) mora na sub-tela "Modelos locais" (`LocalModelsScreen`, botão ao lado
// do título "Áudio" — `AudioTitleAside`; "← Áudio" volta). Cada controle grava na hora via
// `saveVoiceSetting` (espelho reativo `useVoiceSettings` — o composer e a chamada acompanham) e falha
// de gravação vira aviso visível. Os provedores vêm do store (cadastro só em Configurações →
// Provedores); a chave real nunca sai do main (contrato testado em `e2e/voiceSettings.test.ts`).
import { HardDrive, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  VoiceModelInfo,
  VoiceRuntimeStatus,
  VoiceSettingKind,
  VoiceSettingsMap
} from '@shared/ipc'
import type { SttSettings, TtsSettings, VoiceCallDefaults } from '@shared/voice'
import {
  BARGE_IN_RANGES,
  DEFAULT_AUDIO_INPUT,
  DEFAULT_BARGE_IN,
  DEFAULT_FILLER_DELAY_MS,
  FILLER_DELAY_MS_RANGE,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_TURN_SILENCE_MS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  resolveBargeIn,
  voicePromptLayout
} from '@shared/voice'
import type { AudioInputSettings } from '@shared/voice'
import { api, errorMessage } from '../../lib/api'
import { pttHotkeyProblem } from '../../lib/audio/hotkey'
import { menuInputDevices } from '../../lib/audio/devices'
import { formatHotkeyLabel, hotkeyFromEvent } from '../../lib/voice/hotkeyLabel'
import { loadVoiceSettings, saveVoiceSetting } from '../../lib/voice/voiceSettings'
import { useStore } from '../../store'
import { useEscapeLayer } from '../ui/escape'
import type { LocalModelAction } from '../../lib/voice/modelList'
import { ToggleRow } from '../panel/fields'
import { Button, Kbd, Label } from '../ui/controls'
import { Select } from '../ui/Select'
import { HelpTip } from '../ui/Tooltip'
import { AudioSection, NumberRow, SubHeading, WarnNote } from './audioUi'
import { SttSettingsSection } from './SttSettingsSection'
import { TtsSettingsSection } from './TtsSettingsSection'
import { VoiceCallModelEditor } from './VoiceCallModelEditor'
import { DelayPhrasesSettings } from './DelayPhrasesSettings'
import { ToolPhrasesSettings } from './ToolPhrasesSettings'
import { LocalModelsScreen } from './LocalModelsScreen'
import { MicActivationLevel } from './MicActivationLevel'
import { AudioTagsField } from './AudioTagsField'
import { VoicePromptPreview } from './VoiceCallConfigSection'
import { DEFAULT_AUDIO_TAGS_PROMPT } from '@shared/audioTags'
import type { ProviderOption } from '../../lib/voice/voiceSettingsHelpers'
import { useInputDeviceList } from '../../lib/voice/useInputDevices'
import { DICTATION_LANGUAGES } from '../../lib/voice/languages'
import { bumpVoiceEnv } from '../../lib/voice/voiceResolution'

/** Idiomas comuns do ditado (o campo aceita livre — "Outro…" abre o texto). */
const LANGUAGES = DICTATION_LANGUAGES
const CUSTOM_LANGUAGE = '__custom__'

/**
 * À direita do título "Áudio" (Configurações): o botão "Modelos locais" (abre a sub-tela) + (?);
 * dentro da sub-tela, o caminho "› Modelos locais".
 */
export function AudioTitleAside(): React.JSX.Element {
  const view = useStore((s) => s.settingsAudioView)
  const setView = useStore((s) => s.setAudioSettingsView)
  if (view === 'local')
    return (
      <span
        className="text-[15px] font-semibold tracking-tight text-subtle"
        data-testid="audio-title-crumb"
      >
        › Modelos locais
      </span>
    )
  return (
    <span className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        icon={<HardDrive className="size-3.5" />}
        data-testid="audio-local-models-open"
        onClick={() => setView('local')}
      >
        Modelos locais
      </Button>
      <HelpTip label="Modelos locais">
        Tudo o que roda no seu computador: na CPU, o whisper.cpp/Vosk/Nemotron (transcrição) e o
        Kokoro (fala) — baixar, remover, vozes; na GPU, o Modo avançado (hardware, runtime, motores
        de voz e transcrição, parâmetros e as suas vozes). Os instalados aparecem no seletor de
        Modelo desta página, nos grupos “Local (CPU)” e “Local (GPU)”.
      </HelpTip>
    </span>
  )
}

export function AudioSettings(): React.JSX.Element | null {
  const voice = api.voice
  const view = useStore((s) => s.settingsAudioView)
  const setView = useStore((s) => s.setAudioSettingsView)
  const [input, setInput] = useState<AudioInputSettings>(DEFAULT_AUDIO_INPUT)
  const [stt, setStt] = useState<SttSettings>(DEFAULT_STT_SETTINGS)
  const [tts, setTts] = useState<TtsSettings>(DEFAULT_TTS_SETTINGS)
  /** Padrões globais da chamada de voz (turnos, preâmbulos… — SPEC → "Chamada de voz"). */
  const [callDefaults, setCallDefaults] = useState<VoiceCallDefaults>(DEFAULT_VOICE_CALL_DEFAULTS)
  /** Falha ao gravar alguma setting (aviso visível no topo — nada falha em silêncio). */
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Prontidão dos runtimes locais (whisper/onnxruntime/espeak-ng); null = sem probe no main. */
  const [runtime, setRuntime] = useState<VoiceRuntimeStatus | null>(null)
  /** Rascunho do idioma livre ("Outro…") enquanto digita; null = lista comum. */
  const [langDraft, setLangDraft] = useState<string | null>(null)
  /** Provedores cadastrados (store — o cadastro é só em Configurações → Provedores). */
  const storeProviders = useStore((s) => s.providers)
  const providers = useMemo<ProviderOption[]>(
    () => storeProviders.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, kind: p.kind })),
    [storeProviders]
  )
  /** Modelos locais (catálogo + estado em disco, `voice:models:list`). */
  const [models, setModels] = useState<VoiceModelInfo[]>([])
  /** Progresso de download por modelo id (evento `voice:models:progress`). */
  const [modelProgress, setModelProgress] = useState<
    Record<string, { bytes: number; total: number }>
  >({})
  /** Erro de download/remoção de modelo (aviso legível no painel). */
  const [modelError, setModelError] = useState<string | null>(null)
  const { devices: allDevices, loaded: devicesLoaded } = useInputDeviceList()
  const { systemLabel, devices } = menuInputDevices(allDevices)

  useEffect(() => {
    let alive = true
    void loadVoiceSettings().then((all) => {
      if (!alive) return
      setInput(all.audioInput)
      setStt(all.sttSettings)
      setTts(all.ttsSettings)
      setCallDefaults(all.voiceCallDefaults)
    })
    void voice?.models
      .list()
      .then((list) => {
        if (alive) setModels(list)
      })
      .catch(() => void 0)
    void voice?.runtime
      ?.status()
      .then((r) => {
        if (alive) setRuntime(r)
      })
      .catch(() => void 0)
    return () => {
      alive = false
    }
  }, [voice])

  // progresso dos downloads em voo (main → renderer); o estado 'downloading' vem junto
  useEffect(
    () =>
      api.onVoiceModelProgress?.((e) => {
        setModelProgress((p) => ({ ...p, [e.id]: { bytes: e.bytes, total: e.total } }))
        setModels((ms) => ms.map((m) => (m.id === e.id ? { ...m, state: 'downloading' } : m)))
      }),
    []
  )

  /** Relê stt/tts do main (o main grava sozinho ao instalar/remover modelos locais). */
  const reloadVoiceGroups = useCallback((): void => {
    void loadVoiceSettings()
      .then((all) => {
        setStt(all.sttSettings)
        setTts(all.ttsSettings)
      })
      .catch(() => void 0)
  }, [])

  /** Grava `sttSettings` (provedor/modelo/opções — a chave fica no provedor). */
  const commitStt = useCallback(async (next: SttSettings): Promise<boolean> => {
    setStt(next)
    try {
      const saved = await saveVoiceSetting('sttSettings', next)
      setSaveError(null)
      setStt(saved)
      return true
    } catch (e) {
      setSaveError(`Não foi possível salvar: ${errorMessage(e)}`)
      return false
    }
  }, [])
  /** Grava `ttsSettings` (provedor/modelo/voz/opções — a chave fica no provedor). */
  const commitTts = useCallback(async (next: TtsSettings): Promise<boolean> => {
    setTts(next)
    try {
      const saved = await saveVoiceSetting('ttsSettings', next)
      setSaveError(null)
      setTts(saved)
      return true
    } catch (e) {
      setSaveError(`Não foi possível salvar: ${errorMessage(e)}`)
      return false
    }
  }, [])

  // trocar de sub-tela começa do topo (o link da GPU rola depois até a parte pedida)
  useEffect(() => {
    document.getElementById('settings-panel')?.scrollTo({ top: 0 })
  }, [view])

  if (!voice) {
    return (
      <p className="text-sm text-subtle" data-testid="audio-settings">
        API de voz indisponível neste build.
      </p>
    )
  }

  /** Grava um grupo e devolve o valor normalizado (null = falhou; o aviso fica visível no topo). */
  const persist = async <K extends VoiceSettingKind>(
    kind: K,
    value: unknown
  ): Promise<VoiceSettingsMap[K] | null> => {
    try {
      const saved = await saveVoiceSetting(kind, value)
      setSaveError(null)
      return saved
    } catch (e) {
      setSaveError(`Não foi possível salvar: ${errorMessage(e)}`)
      return null
    }
  }

  const saveInput = (patch: Partial<AudioInputSettings>): void => {
    const next = { ...input, ...patch }
    setInput(next)
    void persist('audioInput', next).then((saved) => saved && setInput(saved))
  }

  /** Grava `voiceCallDefaults` (padrões globais da chamada de voz — herdados por persona/chat). */
  const saveCallDefaults = (patch: Partial<VoiceCallDefaults>): void => {
    const next = { ...callDefaults, ...patch }
    setCallDefaults(next)
    void persist('voiceCallDefaults', next).then((saved) => saved && setCallDefaults(saved))
  }

  // ---- modelos locais (download/remoção com progresso) ----

  const refreshModels = (): void => {
    void voice.models
      .list()
      .then(setModels)
      .catch(() => void 0)
  }

  /** Probe dos runtimes locais (`voice.runtime.status`, quando o main expõe) — "pronto" de verdade. */
  const refreshRuntime = (): void => {
    void voice.runtime
      ?.status()
      .then(setRuntime)
      .catch(() => void 0)
  }

  /** O main sincroniza `installed` nas settings ao instalar/remover — relê os grupos. */
  const refreshModelSettings = (): void => {
    reloadVoiceGroups()
    refreshRuntime()
    // a disponibilidade da voz das personas/chats (ícones do composer, aba Voz) muda junto
    bumpVoiceEnv()
  }

  /** Ação da linha do modelo (`modelAction`): baixar/rebaixar, cancelar ou remover. */
  const runModelAction = (model: VoiceModelInfo, action: LocalModelAction['action']): void => {
    if (!action) return
    setModelError(null)
    if (action === 'cancel') {
      void voice.models.cancel({ id: model.id }).catch(() => void 0)
      return
    }
    if (action === 'remove') {
      setModels((ms) =>
        ms.map((m) =>
          m.id === model.id ? { ...m, state: 'notInstalled', installedBytes: null } : m
        )
      )
      void voice.models
        .remove({ id: model.id })
        .then(refreshModelSettings)
        .catch((e) => {
          setModelError(errorMessage(e))
          refreshModels()
        })
      return
    }
    // 'download' | 'retry': baixa com progresso (`voice:models:progress`); cancelado resolve null
    setModels((ms) => ms.map((m) => (m.id === model.id ? { ...m, state: 'downloading' } : m)))
    setModelProgress((p) => ({ ...p, [model.id]: { bytes: 0, total: model.sizeBytes } }))
    void voice.models
      .download({ id: model.id })
      .then((info) => {
        if (info) setModels((ms) => ms.map((m) => (m.id === model.id ? info : m)))
        else refreshModels() // cancelado: volta ao estado em disco
        refreshModelSettings()
      })
      .catch((e) => {
        setModelError(errorMessage(e))
        refreshModels()
      })
  }

  const langIsCommon = LANGUAGES.some((l) => l.value === input.language)
  // microfone salvo fora da lista (desconectado): opção marcada com aviso (a captura usa o padrão)
  const micMissing =
    devicesLoaded &&
    input.deviceId !== null &&
    allDevices.every((d) => !!d.deviceId) &&
    !allDevices.some((d) => d.deviceId === input.deviceId)
  const pttProblem = input.pttKey ? pttHotkeyProblem(input.pttKey) : null
  /** O PTT só está ATIVO com uma tecla válida — ligado sem tecla aparece desligado. */
  const pttActive = input.pttEnabled && !!input.pttKey && !pttProblem
  const turn = callDefaults.turn
  const bargeIn = resolveBargeIn(turn)

  const saveErrorBox = saveError && (
    <div
      role="alert"
      data-testid="voice-settings-error"
      className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[12px] text-danger"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{saveError}</span>
      <button
        type="button"
        aria-label="Dispensar erro de gravação"
        onClick={() => setSaveError(null)}
        className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )

  if (view === 'local')
    return (
      <div className="space-y-4" data-testid="audio-settings" data-view="local">
        {saveErrorBox}
        <LocalModelsScreen
          stt={stt}
          tts={tts}
          onCommitStt={commitStt}
          onCommitTts={commitTts}
          models={models}
          modelProgress={modelProgress}
          modelError={modelError}
          runtime={runtime}
          onModelAction={runModelAction}
          onDismissModelError={() => setModelError(null)}
          onBack={() => setView('main')}
        />
      </div>
    )

  return (
    <div className="space-y-5" data-testid="audio-settings" data-view="main">
      <div
        className="flex items-center gap-1.5 text-xs leading-relaxed text-subtle"
        data-testid="audio-device-note"
      >
        Padrões deste dispositivo (não sincronizam) — cada persona pode ter a própria voz e
        transcrição.
        <HelpTip label="Áudio">
          Ditado, transcrição, fala e chamada de voz deste computador: valem para os chats sem voz
          própria e não vão para os seus outros dispositivos (cada um tem os motores, modelos e o
          microfone dele). Cada persona/chat pode escolher a própria voz e transcrição
          (Configurações → Personas → Voz, ou painel do chat → aba Voz — essa escolha sincroniza;
          onde ela não existir, vale o padrão daquele dispositivo), ligar/desligar a chamada e ter
          modelo, tools e prompt próprios. Os provedores de transcrição e fala são os de
          Configurações → Provedores; os modelos que rodam no computador ficam em “Modelos locais”
          (botão ao lado do título).
        </HelpTip>
      </div>
      {saveErrorBox}

      {/* ---- ditado: microfone, idioma, push-to-talk, silêncio ---- */}
      <AudioSection
        title="Ditado"
        first
        testId="dictation-settings"
        help="Gravação de voz no composer (botão de microfone ou push-to-talk): a fala vira texto no rascunho — o envio é sempre manual. O microfone também vale para a chamada de voz."
      >
        <div>
          <Label help="Microfone usado no ditado por voz e na chamada de voz (o menu do botão de microfone do composer mostra a mesma lista). Se o microfone escolhido for desconectado, a gravação usa o padrão do sistema e avisa.">
            Microfone padrão
          </Label>
          <Select
            value={input.deviceId ?? '__default__'}
            label="Microfone padrão"
            onChange={(v) => saveInput({ deviceId: v === '__default__' ? null : v })}
            options={[
              {
                value: '__default__',
                label: systemLabel ? `Padrão do sistema (${systemLabel})` : 'Padrão do sistema'
              },
              ...(micMissing && input.deviceId
                ? [
                    {
                      value: input.deviceId,
                      label: 'Microfone salvo (desconectado)',
                      description: 'Não encontrado — a gravação usa o padrão do sistema'
                    }
                  ]
                : []),
              ...devices.map((d, i) => ({
                value: d.deviceId,
                label: d.label || `Microfone ${i + 1}`
              }))
            ]}
          />
          {micMissing && (
            <div className="mt-1.5">
              <WarnNote testId="mic-missing-warning" role="note">
                O microfone salvo não está conectado — a gravação usa o padrão do sistema até ele
                voltar.
              </WarnNote>
            </div>
          )}
          {devicesLoaded && devices.length === 0 && (
            <p className="mt-1.5 text-[11.5px] text-subtle">
              Nenhum microfone encontrado (ou permissão ainda não concedida).
            </p>
          )}
        </div>

        <div>
          <Label help="Idioma pedido à transcrição (melhora a precisão). Idiomas fora da lista também são aceitos (código livre, ex.: 'nl').">
            Idioma do ditado
          </Label>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                value={langIsCommon ? input.language : CUSTOM_LANGUAGE}
                label="Idioma do ditado"
                onChange={(v) => {
                  if (v === CUSTOM_LANGUAGE) setLangDraft(langIsCommon ? '' : input.language)
                  else {
                    setLangDraft(null)
                    saveInput({ language: v })
                  }
                }}
                options={[
                  ...LANGUAGES,
                  {
                    value: CUSTOM_LANGUAGE,
                    label: 'Outro (digitar)…',
                    description: 'Código livre (ISO)'
                  }
                ]}
              />
            </div>
            {!langIsCommon || langDraft !== null ? (
              <input
                type="text"
                value={langDraft ?? input.language}
                spellCheck={false}
                aria-label="Idioma (código)"
                data-testid="language-custom"
                placeholder="ex.: nl, pl, tr"
                onChange={(e) => setLangDraft(e.target.value)}
                onBlur={() => {
                  const v = (langDraft ?? '').trim()
                  setLangDraft(null)
                  // vazio não grava (o normalizador manda '' de volta ao padrão pt-BR)
                  if (v) saveInput({ language: v })
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                className="field w-[140px] font-mono text-[12.5px]"
              />
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <ToggleRow
            label="Push-to-talk"
            checked={pttActive}
            onChange={(v) => input.pttKey && !pttProblem && saveInput({ pttEnabled: v })}
            help={
              'Segure a tecla para falar e solte para parar e transcrever. Só funciona com a janela do ClearChat em foco e fica desligada enquanto o ditado não está disponível (chamada de voz, pergunta pendente, Configurações abertas).\nA tecla precisa ser F1–F24 ou ter Ctrl/Alt/Meta — uma tecla que digita deixaria de funcionar no app.\nO clique no microfone do composer funciona com ou sem push-to-talk.'
            }
            status={
              !input.pttKey ? (
                <span data-testid="ptt-inactive-hint">inativo — defina uma tecla</span>
              ) : undefined
            }
          />
          <div className="flex flex-wrap items-center gap-2">
            <Kbd>{input.pttKey ? formatHotkeyLabel(input.pttKey) : 'sem tecla'}</Kbd>
            <KeyCaptureField
              value={input.pttKey}
              // tecla nova liga o push-to-talk (definir a tecla é a intenção de usar)
              onChange={(pttKey) => saveInput({ pttKey, pttEnabled: true })}
            />
            {input.pttKey && (
              <Button size="sm" variant="ghost" onClick={() => saveInput({ pttKey: null })}>
                Remover tecla
              </Button>
            )}
          </div>
          {pttProblem && (
            <WarnNote testId="ptt-key-invalid">
              A tecla salva não vale como push-to-talk: {pttProblem}
            </WarnNote>
          )}
        </div>

        <MicActivationLevel
          value={input.activationDb}
          deviceId={input.deviceId}
          onChange={(activationDb) => saveInput({ activationDb })}
        />

        <ToggleRow
          label="Parar por silêncio"
          checked={input.silenceStopEnabled}
          onChange={(v) => saveInput({ silenceStopEnabled: v })}
          help={
            'Encerra a gravação do ditado sozinha quando você para de falar. O tempo conta de silêncio CONTÍNUO (falar de novo zera a contagem).\nA chamada de voz tem o próprio silêncio de turno (mais abaixo).'
          }
        />
        <NumberRow
          label="Silêncio que encerra a gravação"
          help="Milissegundos de silêncio contínuo (padrão 5000). 0 = sem limite: a gravação só para no botão, na tecla do push-to-talk ou em Esc."
          value={input.silenceStopMs}
          min={0}
          step={100}
          unit="ms"
          disabled={!input.silenceStopEnabled}
          status={input.silenceStopMs === 0 ? '0 = sem limite' : undefined}
          testId="silence-stop-ms"
          ariaLabel="Silêncio que encerra a gravação (ms)"
          onCommit={(silenceStopMs) => saveInput({ silenceStopMs: Math.round(silenceStopMs) })}
        />
      </AudioSection>

      {/* ---- STT (modelo: provedores + locais instalados; parâmetros; híbrido) ---- */}
      <SttSettingsSection
        stt={stt}
        language={input.language}
        providers={providers}
        models={models}
        runtime={runtime}
        onCommit={commitStt}
      />

      {/* ---- TTS (modelo + voz + parâmetros; teste e clipes) ---- */}
      <TtsSettingsSection
        tts={tts}
        providers={providers}
        models={models}
        runtime={runtime}
        onCommit={commitTts}
      />

      {/* ---- chamada de voz: disponível + fim de turno (padrões globais) ---- */}
      <AudioSection
        title="Chamada de voz"
        testId="voice-call-settings"
        help={
          <>
            <p>
              Conversa falada com o agente (botão de telefone no composer): você fala, o silêncio
              encerra a sua vez, a fala vira mensagem do chat e a resposta é falada. Estes são os
              padrões GLOBAIS — cada persona/chat pode ligar/desligar a chamada e ter modelo, tools
              e prompt próprios (painel do chat → aba Voz).
            </p>
            <p>
              Precisa da transcrição (STT) e da fala (TTS) configuradas acima; o que faltar é
              avisado ao tentar entrar na chamada.
            </p>
          </>
        }
      >
        <ToggleRow
          label="Chamada de voz disponível"
          checked={callDefaults.enabled}
          onChange={(enabled) => saveCallDefaults({ enabled })}
          help="Desligada, o botão de telefone some de todos os chats (exceto os que ligam a chamada explicitamente na própria config)."
        />
        <ToggleRow
          label="O agente pode encerrar a chamada"
          checked={callDefaults.endCall}
          onChange={(endCall) => saveCallDefaults({ endCall })}
          help="Tool end_call nos turnos da chamada (sem aprovação): quando você se despede ou pede para desligar, o agente diz uma despedida curta e a chamada cai depois de ela tocar — voltar a falar antes cancela. Persona/chat podem mudar (aba Voz)."
        />
        <SubHeading>Fim da sua vez de falar</SubHeading>
        <ToggleRow
          label="Fim de turno adaptativo"
          checked={turn.adaptive}
          onChange={(adaptive) => saveCallDefaults({ turn: { ...turn, adaptive } })}
          help='Aos ~250 ms de pausa o app transcreve o que você já disse (motor local) e decide: pergunta/comando fecha a vez rápido; frase que termina em vírgula, "e", "mas", "porque"… espera mais. Se você não voltar a falar, essa transcrição já é a final.'
        />
        <ToggleRow
          label="Especular pela API"
          checked={turn.speculativeApi}
          onChange={(speculativeApi) => saveCallDefaults({ turn: { ...turn, speculativeApi } })}
          help="Transcrição especulativa pela API quando não há motor local. Com as parciais ao vivo ligadas ela já acontece (a especulação reaproveitada vira a final — sem custo extra no caso comum, texto ~1 s antes); isto liga também sem as parciais."
        />
        <NumberRow
          label="Silêncio que encerra a fala"
          help={`Silêncio contínuo que encerra a SUA vez quando não há transcrição especulativa (fim de turno adaptativo desligado, ou STT só por API sem especulação) — padrão ${DEFAULT_TURN_SILENCE_MS} ms. Independente do "Parar por silêncio" do ditado.`}
          value={turn.silenceStopMs ?? DEFAULT_TURN_SILENCE_MS}
          min={200}
          max={10000}
          step={100}
          unit="ms"
          testId="voice-call-turn-silence"
          ariaLabel="Silêncio que encerra a fala na chamada (ms)"
          onCommit={(v) =>
            // o padrão volta a ser "segue o padrão" (null) — muda junto se o padrão mudar
            saveCallDefaults({
              turn: { ...turn, silenceStopMs: v === DEFAULT_TURN_SILENCE_MS ? null : v }
            })
          }
        />
        <NumberRow
          label="Fala completa"
          help='Silêncio que fecha uma fala completa: pergunta, comando ou fecho ("obrigado").'
          value={turn.completeSilenceMs}
          min={200}
          max={5000}
          step={50}
          unit="ms"
          testId="voice-call-turn-complete"
          ariaLabel="Silêncio para fala completa (ms)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, completeSilenceMs: v } })}
        />
        <NumberRow
          label="Afirmação"
          help="Silêncio que fecha uma afirmação (o ponto final do STT não prova que você terminou — pode ser uma história no meio)."
          value={turn.statementSilenceMs}
          min={200}
          max={10000}
          step={50}
          unit="ms"
          testId="voice-call-turn-statement"
          ariaLabel="Silêncio para afirmação (ms)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, statementSilenceMs: v } })}
        />
        <NumberRow
          label="Fala inacabada"
          help="Silêncio que fecha uma fala inacabada (termina em vírgula, conectivo ou hesitação) — o teto."
          value={turn.unfinishedSilenceMs}
          min={200}
          max={10000}
          step={50}
          unit="ms"
          testId="voice-call-turn-unfinished"
          ariaLabel="Silêncio para fala inacabada (ms)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, unfinishedSilenceMs: v } })}
        />
        <SubHeading>Falar por cima da resposta</SubHeading>
        <NumberRow
          label="Volume ao falar por cima"
          help={`Quando você fala por cima da resposta (por “Abaixar a voz depois de”), a voz do assistente ABAIXA para esta fração do volume (e continua tocando) em vez de parar na hora — uma tosse, um “uhum” ou um barulho não interrompem nada. 0 = mudo; 1 = não abaixa. Padrão ${Math.round(DEFAULT_BARGE_IN.duckGain * 100)} %.`}
          value={Math.round(bargeIn.duckGain * 100)}
          min={0}
          max={100}
          step={5}
          unit="%"
          testId="voice-call-duck-gain"
          ariaLabel="Volume do assistente enquanto você fala por cima (%)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, duckGain: v / 100 } })}
        />
        <NumberRow
          label="Abaixar a voz depois de"
          help={`Quanto tempo de voz SEGUIDA por cima da resposta (acima do nível de ativação do microfone) até a voz do assistente abaixar. Pausas curtas entre as palavras não zeram a contagem; um silêncio maior, sim — clique, pancada na mesa, tosse curta ou barulho isolado nunca abaixam nada. Padrão ${DEFAULT_BARGE_IN.onsetMs} ms.`}
          value={bargeIn.onsetMs}
          min={BARGE_IN_RANGES.onsetMs.min}
          max={BARGE_IN_RANGES.onsetMs.max}
          step={50}
          unit="ms"
          testId="voice-call-duck-onset"
          ariaLabel="Abaixar a voz depois de (ms de voz seguida)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, duckOnsetMs: v } })}
        />
        <NumberRow
          label="Interromper depois de falar"
          help={`Se você continuar falando por cima por este tempo (só o tempo com voz conta, desde o começo da fala por cima), o assistente para de falar e a sua fala vira o próximo turno (barge-in). Também interrompe com ${DEFAULT_BARGE_IN.words}+ palavras reconhecidas na transcrição ao vivo (palavras abaixo) ou com um pedido curto de parada (“para”, “espera”, “chega”, “peraí”) — sempre só depois de a voz ter abaixado. Padrão ${DEFAULT_BARGE_IN.voicedMs} ms.`}
          value={bargeIn.voicedMs}
          min={BARGE_IN_RANGES.voicedMs.min}
          max={BARGE_IN_RANGES.voicedMs.max}
          step={50}
          unit="ms"
          testId="voice-call-barge-in-voiced"
          ariaLabel="Interromper depois de falar por cima (ms de voz)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, bargeInVoicedMs: v } })}
        />
        <NumberRow
          label="Interromper com palavras"
          help={`Palavras reais (“uhum”, “sim”, “tá” não contam) na transcrição ao vivo da sua fala por cima que já interrompem o assistente — precisa das parciais ao vivo ligadas em Transcrição. Padrão ${DEFAULT_BARGE_IN.words}.`}
          value={bargeIn.words}
          min={BARGE_IN_RANGES.words.min}
          max={BARGE_IN_RANGES.words.max}
          step={1}
          testId="voice-call-barge-in-words"
          ariaLabel="Interromper com quantas palavras"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, bargeInWords: v } })}
        />
        <NumberRow
          label="Volume volta depois de"
          help={`Você parou de falar por cima antes de interromper: depois deste silêncio o volume do assistente volta ao normal e o som curto é descartado (não vira turno). Padrão ${DEFAULT_BARGE_IN.restoreMs} ms.`}
          value={bargeIn.restoreMs}
          min={BARGE_IN_RANGES.restoreMs.min}
          max={BARGE_IN_RANGES.restoreMs.max}
          step={50}
          unit="ms"
          testId="voice-call-duck-restore"
          ariaLabel="Volume volta depois de (ms de silêncio)"
          onCommit={(v) => saveCallDefaults({ turn: { ...turn, duckRestoreMs: v } })}
        />
        <AudioTagsField
          global
          value={callDefaults.audioTags}
          inherited={callDefaults.audioTags}
          inheritedFrom="Padrão do app"
          prompt={callDefaults.audioTagsPrompt}
          inheritedPrompt={DEFAULT_AUDIO_TAGS_PROMPT}
          onChange={(v) => saveCallDefaults({ audioTags: v ?? false })}
          onPromptChange={(audioTagsPrompt) => saveCallDefaults({ audioTagsPrompt })}
        />
        {/* transparência: o que uma chamada sem prompt próprio na persona/chat muda no prompt */}
        <VoicePromptPreview
          layout={voicePromptLayout({
            voicePrompt: null,
            promptMode: 'append',
            audioTags: callDefaults.audioTags,
            audioTagsPrompt: callDefaults.audioTagsPrompt ?? DEFAULT_AUDIO_TAGS_PROMPT,
            audioTagsActive: true
          })}
          voiceFrom={null}
          tagsFrom="padrão deste dispositivo"
        />
        <p className="text-[11.5px] text-subtle" data-testid="voice-call-no-hidden-prompt">
          O app não acrescenta prompt próprio na chamada: o único texto a mais é o “Prompt do modo
          voz” de cada persona/chat (aba Voz — vazio por padrão) e, com as tags de voz ligadas, a
          instrução delas.
        </p>
        <DelayPhrasesSettings
          value={callDefaults.delayPhrases}
          onChange={(delayPhrases) => saveCallDefaults({ delayPhrases })}
        />
        <ToolPhrasesSettings
          value={callDefaults.toolPhrases}
          onChange={(toolPhrases) => saveCallDefaults({ toolPhrases })}
        />
      </AudioSection>

      {/* ---- chamada de voz: modelo da chamada padrão (global) + parâmetros ---- */}
      <section className="border-t border-border pt-4" data-testid="voice-call-model-settings">
        <VoiceCallModelEditor
          value={callDefaults.model}
          onChange={(model) => saveCallDefaults({ model })}
          scope="global"
          inherited="o modelo de cada chat"
        />
      </section>

      {/* ---- chamada de voz: preâmbulos (fillers) ---- */}
      <AudioSection
        title="Preâmbulos"
        testId="voice-acts-settings"
        help={
          <>
            <p>
              Frase curta logo depois da sua fala enquanto a resposta não começa (&quot;Hum, deixa
              eu ver aqui.&quot;), decidida por regras simples (sem classificador treinado). Estes
              são os padrões GLOBAIS — persona/chat podem sobrescrever (★ do painel da chamada).
            </p>
            <p>
              A chamada é meia-duplex: você fala, o assistente responde — nada toca enquanto você
              fala.
            </p>
          </>
        }
      >
        <ToggleRow
          label="Preâmbulos"
          checked={callDefaults.fillers.enabled}
          onChange={(v) => saveCallDefaults({ fillers: { ...callDefaults.fillers, enabled: v } })}
          help='Preâmbulo curto ("Hum, deixa eu ver aqui.", "Beleza, só um minutinho.") escolhido pelo tipo de pedido, só quando a resposta DEMORA (veja "Espera do preâmbulo"). No máximo 1 por turno; a resposta espera ele terminar. Fala muito curta ("sim", "valeu") não ganha preâmbulo; quando o assistente usa uma ferramenta, a frase de ferramenta ("Vou pesquisar isso.") fica no lugar dele.'
        />
        <NumberRow
          label="Espera do preâmbulo"
          help={`Falar “deixa eu ver…” só se a resposta demorar mais que isto depois da sua fala: se a 1ª frase da resposta (ou a frase de ferramenta) sair antes, o preâmbulo nem toca. 0 = sempre, logo depois da sua fala. Padrão ${DEFAULT_FILLER_DELAY_MS / 1000} s.`}
          value={callDefaults.fillers.delayMs}
          min={FILLER_DELAY_MS_RANGE.min}
          max={FILLER_DELAY_MS_RANGE.max}
          step={100}
          unit="ms"
          testId="voice-call-filler-delay"
          ariaLabel="Espera do preâmbulo (ms)"
          onCommit={(v) => saveCallDefaults({ fillers: { ...callDefaults.fillers, delayMs: v } })}
        />
        {/* `fillers.prompt` ainda não é consumido (a decisão é por regra): campo escondido até ser */}
      </AudioSection>
    </div>
  )
}

/**
 * Captura da tecla do push-to-talk: mostra a atual e grava a próxima pressionada. Esc cancela SÓ a
 * captura (camada própria na pilha de Esc — o modal de Configurações continua aberto). Tecla que
 * não vale como PTT (`pttHotkeyProblem`: digitaria texto) é recusada com o motivo, e a captura
 * continua esperando.
 */
function KeyCaptureField({
  value,
  onChange
}: {
  value: string | null
  onChange: (v: string) => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEscapeLayer(capturing, () => {
    setCapturing(false)
    setProblem(null)
  })
  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      // Esc é da camada de Esc (fecha só a captura)
      if (e.key === 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      const hotkey = hotkeyFromEvent(e)
      if (!hotkey) return
      const why = pttHotkeyProblem(hotkey)
      if (why) {
        setProblem(`${formatHotkeyLabel(hotkey)}: ${why}`)
        return
      }
      setProblem(null)
      onChange(hotkey)
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, onChange])
  return (
    <>
      <Button
        size="sm"
        variant={capturing ? 'primary' : 'secondary'}
        data-testid="ptt-key-capture"
        onClick={() => {
          setProblem(null)
          setCapturing((c) => !c)
        }}
      >
        {capturing ? 'Pressione a tecla… (Esc cancela)' : value ? 'Alterar tecla' : 'Definir tecla'}
      </Button>
      {problem && (
        <span
          role="alert"
          data-testid="ptt-key-problem"
          className="basis-full text-[11px] leading-snug text-warning"
        >
          {problem}
        </span>
      )}
    </>
  )
}
