// Voz da persona/chat (protocolo 1.9.0 — `config.voice.tts`/`.stt`): as seções "Fala" e
// "Transcrição" da aba Voz (painel do chat e editor de personas). Sem opção "herdar/padrão"
// duplicada: cada seção diz o que está valendo ("Usando a voz padrão deste dispositivo: Kokoro ·
// pf_dora" / "Usando a voz da persona “X”: …"), se funciona AQUI ("Disponível aqui" / "Não
// disponível neste dispositivo — usa o padrão deste dispositivo: <motivo>") e oferece "Escolher uma
// voz…" — que abre os MESMOS seletores de Configurações → Áudio (`TtsSettingsSection`/
// `SttSettingsSection` no modo `choice`: modelo/provedor/motor, voz com ▶, parâmetros; idioma da
// transcrição) — e "Voltar a usar …" (a escolha sai e o nível volta a herdar, ao vivo). A
// disponibilidade vem do main (`useVoiceResolution` → `voice.resolve`). Instalar modelos continua
// global e por dispositivo (Configurações → Áudio → Modelos locais).
import { Check, RotateCcw, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { VoiceModelInfo, VoiceRuntimeStatus } from '@shared/ipc'
import type { ChatConfig } from '@shared/types'
import {
  applySttChoice,
  applyTtsChoice,
  DEFAULT_TTS_LOCAL,
  normalizeVoiceCallConfig,
  normalizeVoiceSttChoice,
  normalizeVoiceTtsChoice,
  sttChoiceFromSettings,
  ttsChoiceFromSettings,
  type SttSettings,
  type TtsSettings,
  type VoiceCallConfig,
  type VoiceResolution,
  type VoiceSttChoice,
  type VoiceTtsChoice
} from '@shared/voice'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { DICTATION_LANGUAGES, languageLabel } from '../../lib/voice/languages'
import { sttVoiceLabel, ttsVoiceLabel } from '../../lib/voice/voiceChoice'
import { useVoiceResolution } from '../../lib/voice/voiceResolution'
import { loadVoiceSettings, useVoiceSettings } from '../../lib/voice/voiceSettings'
import type { ProviderOption } from '../../lib/voice/voiceSettingsHelpers'
import { useStore } from '../../store'
import { CollapsibleSection } from '../panel/fields'
import { Button, Label } from '../ui/controls'
import { Select } from '../ui/Select'
import { SttSettingsSection } from './SttSettingsSection'
import { TtsSettingsSection } from './TtsSettingsSection'

/** Modelos locais + prontidão dos runtimes (os seletores mostram os grupos Local (CPU)/(GPU)). */
function useLocalVoiceState(): { models: VoiceModelInfo[]; runtime: VoiceRuntimeStatus | null } {
  const [models, setModels] = useState<VoiceModelInfo[]>([])
  const [runtime, setRuntime] = useState<VoiceRuntimeStatus | null>(null)
  useEffect(() => {
    let alive = true
    void loadVoiceSettings()
    void api.voice?.models
      .list()
      .then((m) => alive && setModels(m))
      .catch(() => void 0)
    void api.voice?.runtime
      ?.status()
      .then((r) => alive && setRuntime(r))
      .catch(() => void 0)
    return () => {
      alive = false
    }
  }, [])
  return { models, runtime }
}

/** Linha de disponibilidade NESTE dispositivo da voz que está valendo neste nível. */
function Availability({
  r,
  deviceLabel,
  testId
}: {
  r: VoiceResolution<unknown, unknown> | null
  /** Rótulo da voz padrão deste dispositivo (o que entra no lugar no fallback). */
  deviceLabel: string
  testId: string
}): React.JSX.Element | null {
  if (!r) return null
  const state = !r.available ? 'unavailable' : r.fallback ? 'fallback' : 'ok'
  return (
    <p
      data-testid={testId}
      data-state={state}
      className={cn(
        'flex items-start gap-1.5 text-[11.5px] leading-snug',
        state === 'ok' && 'text-success',
        state === 'fallback' && 'text-warning',
        state === 'unavailable' && 'text-danger'
      )}
    >
      {state === 'ok' ? (
        <Check className="mt-px size-3.5 shrink-0" />
      ) : (
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
      )}
      <span>
        {state === 'ok'
          ? 'Disponível aqui'
          : state === 'fallback'
            ? `Não disponível neste dispositivo — usa o padrão deste dispositivo (${deviceLabel}): ${r.fallback?.reason ?? ''}`
            : `${r.unconfigured ? 'Não configurada' : 'Não funciona'} neste dispositivo: ${r.reason ?? 'indisponível'} (Configurações → Áudio)`}
      </span>
    </p>
  )
}

export function VoiceChoiceSections({
  cfg,
  patch,
  scope = 'chat',
  defaultOpen = false
}: {
  cfg: Partial<ChatConfig>
  patch: (p: Partial<ChatConfig>) => void
  /** Nível editado: o chat (herda da persona de origem) ou a persona (herda do dispositivo). */
  scope?: 'chat' | 'persona'
  defaultOpen?: boolean
}): React.JSX.Element | null {
  const voiceApi = api.voice
  const voice: VoiceCallConfig = normalizeVoiceCallConfig(cfg.voice ?? null)
  const presetId = scope === 'chat' ? (cfg.presetId ?? null) : null
  const persona = useStore((s) =>
    presetId ? (s.presets.find((p) => p.id === presetId) ?? null) : null
  )
  const personaVoice = persona?.config.voice ?? null
  const storeProviders = useStore((s) => s.providers)
  const providers = useMemo<ProviderOption[]>(
    () => storeProviders.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, kind: p.kind })),
    [storeProviders]
  )
  const device = useVoiceSettings((s) => s.view)
  const { models, runtime } = useLocalVoiceState()
  // camadas como a chamada/o ditado as veem (o rascunho da persona/chat incluso)
  const voiceKey = JSON.stringify(voice)
  const personaKey = JSON.stringify(personaVoice)
  const layers = useMemo(
    () =>
      scope === 'chat'
        ? { chat: JSON.parse(voiceKey) as unknown, persona: JSON.parse(personaKey) as unknown }
        : { persona: JSON.parse(voiceKey) as unknown },
    [scope, voiceKey, personaKey]
  )
  const res = useVoiceResolution(voiceApi ? layers : null)
  if (!voiceApi) return null

  const where = scope === 'chat' ? 'deste chat' : 'desta persona'
  const set = (p: Partial<VoiceCallConfig>): void => {
    const next: VoiceCallConfig = { ...voice, ...p }
    if (!next.tts) delete next.tts
    if (!next.stt) delete next.stt
    patch({ voice: next })
  }
  // o que este nível herda quando não tem escolha própria (chat: a da persona; senão o dispositivo)
  const inheritedTts =
    scope === 'chat' ? normalizeVoiceTtsChoice(personaVoice?.tts) : (null as VoiceTtsChoice | null)
  const inheritedStt =
    scope === 'chat' ? normalizeVoiceSttChoice(personaVoice?.stt) : (null as VoiceSttChoice | null)
  const personaName = persona?.name ?? ''
  const deviceTtsLabel = ttsVoiceLabel(device.ttsSettings, providers)
  const deviceSttLabel = sttVoiceLabel(device.sttSettings, providers, device.audioInput.language)

  return (
    <>
      <TtsChoiceSection
        own={voice.tts ?? null}
        inherited={inheritedTts}
        personaName={personaName}
        device={device.ttsSettings}
        deviceLabel={deviceTtsLabel}
        providers={providers}
        models={models}
        runtime={runtime}
        r={res?.tts ?? null}
        where={where}
        scope={scope}
        defaultOpen={defaultOpen}
        onChange={(tts) => set({ tts })}
      />
      <SttChoiceSection
        own={voice.stt ?? null}
        inherited={inheritedStt}
        personaName={personaName}
        device={device.sttSettings}
        deviceLanguage={device.audioInput.language}
        deviceLabel={deviceSttLabel}
        providers={providers}
        models={models}
        runtime={runtime}
        r={res?.stt ?? null}
        where={where}
        scope={scope}
        defaultOpen={defaultOpen}
        onChange={(stt) => set({ stt })}
      />
    </>
  )
}

interface ChoiceProps<C, S> {
  /** Escolha deste nível (null = herda). */
  own: C | null
  /** Escolha herdada da persona (só no chat). */
  inherited: C | null
  personaName: string
  device: S
  deviceLabel: string
  providers: ProviderOption[]
  models: VoiceModelInfo[]
  runtime: VoiceRuntimeStatus | null
  r: VoiceResolution<unknown, unknown> | null
  where: string
  scope: 'chat' | 'persona'
  defaultOpen: boolean
  onChange: (c: C | null) => void
}

function TtsChoiceSection(p: ChoiceProps<VoiceTtsChoice, TtsSettings>): React.JSX.Element {
  const { own, inherited, device, providers } = p
  const inheritedLabel = inherited
    ? ttsVoiceLabel(applyTtsChoice(device, inherited), providers)
    : p.deviceLabel
  const current = own
    ? `Voz própria ${p.where}: ${ttsVoiceLabel(applyTtsChoice(device, own), providers)}`
    : inherited
      ? `Usando a voz da persona “${p.personaName}”: ${inheritedLabel}`
      : `Usando a voz padrão deste dispositivo: ${p.deviceLabel}`
  const back = inherited
    ? 'Voltar a usar a voz da persona'
    : 'Voltar a usar a voz padrão deste dispositivo'
  // ponto de partida do seletor: a voz que está valendo agora (a herdada), ou o Kokoro padrão
  const start = (): VoiceTtsChoice =>
    inherited ??
    ttsChoiceFromSettings(device) ?? { backend: 'local', local: { ...DEFAULT_TTS_LOCAL } }
  return (
    <CollapsibleSection
      id={`voice-tts-${p.scope}`}
      title="Fala"
      section="voice-tts"
      defaultOpen={p.defaultOpen}
      summary={{
        text: own ? 'voz própria' : inherited ? 'da persona' : 'padrão do dispositivo',
        changed: !!own
      }}
      warning={
        p.r && !p.r.available
          ? 'Nenhuma voz funciona neste dispositivo'
          : p.r?.fallback
            ? 'A voz escolhida não está disponível neste dispositivo'
            : undefined
      }
      help={
        'Com que voz o agente FALA na chamada de voz (e nas prévias e clipes) — motor ou provedor, modelo, voz e parâmetros. ' +
        (p.scope === 'chat'
          ? 'Sem voz própria, o chat usa a da persona de origem (ao vivo) e, sem ela, a padrão deste dispositivo.'
          : 'Sem voz própria, a persona usa a padrão de cada dispositivo (Configurações → Áudio).') +
        ' A escolha sincroniza; num dispositivo onde ela não existe (provedor ausente, modelo local ou voz da GPU não instalados), vale a padrão daquele dispositivo. Instalar modelos é por dispositivo (Configurações → Áudio → Modelos locais).'
      }
    >
      <div className="space-y-2.5" data-testid={`tts-choice-${p.scope}`}>
        <p className="text-[12.5px] text-fg/90" data-testid="tts-choice-current">
          {current}
        </p>
        <Availability r={p.r} deviceLabel={p.deviceLabel} testId="tts-choice-availability" />
        {own ? (
          <div className="space-y-2.5">
            <TtsSettingsSection
              tts={applyTtsChoice(device, own)}
              providers={providers}
              models={p.models}
              runtime={p.runtime}
              choice={{ where: p.where }}
              onCommit={async (next) => {
                const c = ttsChoiceFromSettings(next)
                if (c) p.onChange(c)
                return !!c
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              data-testid="tts-choice-inherit"
              icon={<RotateCcw className="size-3.5" />}
              onClick={() => p.onChange(null)}
            >
              {back}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            data-testid="tts-choice-custom"
            onClick={() => p.onChange(start())}
          >
            {p.scope === 'chat'
              ? 'Escolher uma voz para este chat'
              : 'Escolher uma voz para esta persona'}
          </Button>
        )}
      </div>
    </CollapsibleSection>
  )
}

function SttChoiceSection(
  p: ChoiceProps<VoiceSttChoice, SttSettings> & { deviceLanguage: string }
): React.JSX.Element {
  const { own, inherited, device, providers } = p
  const label = (c: VoiceSttChoice): string =>
    sttVoiceLabel(applySttChoice(device, c), providers, c.language || p.deviceLanguage)
  const current = own
    ? `Transcrição própria ${p.where}: ${label(own)}`
    : inherited
      ? `Usando a transcrição da persona “${p.personaName}”: ${label(inherited)}`
      : `Usando a transcrição padrão deste dispositivo: ${p.deviceLabel}`
  const back = inherited
    ? 'Voltar a usar a transcrição da persona'
    : 'Voltar a usar a transcrição padrão deste dispositivo'
  // ponto de partida: a transcrição que está valendo agora (a herdada), ou o whisper.cpp local
  const start = (): VoiceSttChoice =>
    inherited ??
    sttChoiceFromSettings(device) ?? { mode: 'local', local: { engine: 'whisper.cpp', model: '' } }
  // idioma: as opções reais com ★ no idioma deste dispositivo (escolhê-lo = segue o dispositivo)
  const langOptions = [
    ...DICTATION_LANGUAGES,
    ...[p.deviceLanguage, own?.language ?? '']
      .filter((c) => c && !DICTATION_LANGUAGES.some((l) => l.value === c))
      .map((c) => ({ value: c, label: c }))
  ].map((l) =>
    l.value === p.deviceLanguage
      ? {
          ...l,
          label: `${l.label} ★`,
          description: 'idioma do ditado deste dispositivo — segue se ele mudar'
        }
      : l
  )
  return (
    <CollapsibleSection
      id={`voice-stt-${p.scope}`}
      title="Transcrição"
      section="voice-stt"
      defaultOpen={p.defaultOpen}
      summary={{
        text: own ? 'própria' : inherited ? 'da persona' : 'padrão do dispositivo',
        changed: !!own
      }}
      warning={
        p.r && !p.r.available
          ? 'Nenhuma transcrição funciona neste dispositivo'
          : p.r?.fallback
            ? 'A transcrição escolhida não está disponível neste dispositivo'
            : undefined
      }
      help={
        'Com que motor/modelo e em que idioma o app OUVE você na chamada de voz e no ditado do composer dos chats ' +
        (p.scope === 'chat' ? 'deste chat. ' : 'desta persona. ') +
        'Sem escolha própria vale a ' +
        (p.scope === 'chat' ? 'da persona de origem e, sem ela, a ' : '') +
        'padrão deste dispositivo. A escolha sincroniza; num dispositivo onde ela não existe, vale a padrão daquele dispositivo (parciais ao vivo e o microfone são sempre do dispositivo).'
      }
    >
      <div className="space-y-2.5" data-testid={`stt-choice-${p.scope}`}>
        <p className="text-[12.5px] text-fg/90" data-testid="stt-choice-current">
          {current}
        </p>
        <Availability r={p.r} deviceLabel={p.deviceLabel} testId="stt-choice-availability" />
        {own ? (
          <div className="space-y-2.5">
            <SttSettingsSection
              stt={applySttChoice(device, own)}
              language={own.language || p.deviceLanguage}
              providers={providers}
              models={p.models}
              runtime={p.runtime}
              choice={{ where: p.where }}
              onCommit={async (next) => {
                const c = sttChoiceFromSettings(next, own.language ?? null)
                if (c) p.onChange(c)
                return !!c
              }}
              extra={
                <div>
                  <Label help="Idioma pedido à transcrição nos chats desta voz (melhora a precisão). A opção com ★ é o idioma do ditado deste dispositivo: escolhida, a transcrição segue o dispositivo.">
                    Idioma
                  </Label>
                  <Select
                    value={own.language || p.deviceLanguage}
                    label="Idioma da transcrição"
                    onChange={(v) => {
                      const { language: _drop, ...rest } = own
                      void _drop
                      p.onChange(v === p.deviceLanguage ? rest : { ...rest, language: v })
                    }}
                    options={langOptions}
                  />
                  {own.language && own.language !== p.deviceLanguage && (
                    <p className="mt-1 text-[11.5px] text-subtle" data-testid="stt-choice-language">
                      {languageLabel(own.language)} — o ditado dos chats desta voz também usa este
                      idioma.
                    </p>
                  )}
                </div>
              }
            />
            <Button
              size="sm"
              variant="ghost"
              data-testid="stt-choice-inherit"
              icon={<RotateCcw className="size-3.5" />}
              onClick={() => p.onChange(null)}
            >
              {back}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            data-testid="stt-choice-custom"
            onClick={() => p.onChange(start())}
          >
            {p.scope === 'chat'
              ? 'Escolher a transcrição deste chat'
              : 'Escolher a transcrição desta persona'}
          </Button>
        )}
      </div>
    </CollapsibleSection>
  )
}
