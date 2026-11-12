// Áudio/voz — ligação com o app: as settings de voz DESTE DISPOSITIVO (`audioInput`, `sttSettings`,
// `ttsSettings`, `voiceCallDefaults` — locais desde o protocolo 1.9.0, não sincronizam) no settings
// genérico do banco, sempre lidas completas e normalizadas, e a voz da persona/chat
// (`config.voice.tts`/`.stt` — `chatVoiceLayers`, `resolveVoice`, `getVoiceSettingsWith`).
// Escrita tipada por `setVoiceSetting` (normaliza + grava + devolve o valor gravado). As settings
// de stt/tts guardam só o PROVEDOR (`providerId`), o modelo, a voz e as opções — endereço e chave
// vêm do provedor cadastrado em Configurações → Provedores, resolvidos aqui só para os serviços do
// main (`getVoiceSettings`; a chave nunca vai ao renderer). A transcrição vive em `voice/stt.ts` +
// `voice/session.ts`. Ver SPEC.md → "Áudio".
import type {
  VoiceResolutionView,
  VoiceSettingKind,
  VoiceSettingsMap,
  VoiceSettingsView
} from '@shared/ipc'
import {
  AUDIO_INPUT_SETTING,
  applySttChoice,
  applyTtsChoice,
  DEFAULT_TTS_LOCAL,
  normalizeVoiceCallConfig,
  resolveSttVoice,
  resolveTtsVoice,
  sttChoiceOf,
  ttsChoiceOf,
  type VoiceDeviceCaps,
  type VoiceLayers,
  type VoiceSttChoice,
  type VoiceTtsChoice,
  normalizeAudioInput,
  normalizeSttSettings,
  normalizeTtsSettings,
  normalizeVoiceCallDefaults,
  STT_SETTINGS_SETTING,
  TTS_SETTINGS_SETTING,
  VOICE_CALL_DEFAULTS_SETTING,
  type AudioInputSettings,
  type SttLocalConfig,
  type SttLocalEngine,
  type SttSettings,
  type TtsLocalConfig,
  type TtsLocalEngine,
  type TtsSettings,
  type VoiceCallDefaults
} from '@shared/voice'
import type { Provider } from '@shared/types'
import { providerKind } from '@shared/providerKinds'
import type { LocalModelCatalogEntry } from './voice/catalog'
import { chatsRepo, presetsRepo, providersRepo, settingsRepo } from './repo'

export interface VoiceSettings {
  /** Ditado: microfone, push-to-talk, silêncio e idioma (deste dispositivo). */
  audioInput: AudioInputSettings
  /** Voz em texto (STT): modo, endpoint de API e motor local. */
  stt: SttSettings
  /** Texto em voz (TTS): backend, endpoint de API e motor local. */
  tts: TtsSettings
  /** Padrões da chamada deste dispositivo, herdados por chats/personas quando `ChatConfig.voice` tem null. */
  voiceCallDefaults: VoiceCallDefaults
}

/** Settings de áudio/voz como estão gravadas (normalizadas; `providerId` NÃO resolvido). */
function readVoiceSettings(): VoiceSettings {
  return {
    audioInput: normalizeAudioInput(settingsRepo.get(AUDIO_INPUT_SETTING)),
    stt: normalizeSttSettings(settingsRepo.get(STT_SETTINGS_SETTING)),
    tts: normalizeTtsSettings(settingsRepo.get(TTS_SETTINGS_SETTING)),
    voiceCallDefaults: normalizeVoiceCallDefaults(settingsRepo.get(VOICE_CALL_DEFAULTS_SETTING))
  }
}

/**
 * Endpoint efetivo de STT/TTS: `baseUrl` e `apiKey` vêm SEMPRE do provedor cadastrado do
 * `providerId` (a chave dele nunca é copiada para a setting nem sai do main). Sem provedor
 * escolhido, ou apagado/sem endereço → sem `baseUrl`/`apiKey` (o cliente recusa com erro de config
 * "escolha um provedor"). Puro (lookup injetado).
 */
export function resolveVoiceEndpoint<
  T extends { providerId: string | null; baseUrl?: string; apiKey?: string }
>(api: T, lookup: (id: string) => Pick<Provider, 'baseUrl' | 'apiKey'> | null): T {
  const { baseUrl: _b, apiKey: _k, ...stored } = api
  void _b
  void _k
  const id = api.providerId?.trim()
  const p = id ? lookup(id) : null
  if (!p || !p.baseUrl.trim()) return stored as T
  return { ...stored, baseUrl: p.baseUrl.trim(), apiKey: p.apiKey.trim() } as T
}

/**
 * Settings de áudio/voz completas para os SERVIÇOS do main (ausente/inválido → os padrões de
 * `@shared/voice`), com o `providerId` de stt/tts resolvido para o endpoint/chave do provedor salvo.
 * Nunca vai ao renderer (a visão é `getVoiceSettingsView`, sem resolver).
 */
export function getVoiceSettings(): VoiceSettings {
  return getVoiceSettingsWith({})
}

/**
 * `getVoiceSettings` com a voz de uma persona/chat aplicada (protocolo 1.9.0): a fala/transcrição
 * escolhidas (`applyTtsChoice`/`applySttChoice` sobre as deste dispositivo — o que é do dispositivo
 * continua) e o `providerId` resolvido para endereço/chave do provedor salvo. null/ausente = as
 * deste dispositivo. Só para os serviços do main (chamada, ditado, prévias, clipes).
 */
export function getVoiceSettingsWith(choice: {
  tts?: VoiceTtsChoice | null
  stt?: VoiceSttChoice | null
}): VoiceSettings {
  const v = readVoiceSettings()
  const stt = applySttChoice(v.stt, choice.stt ?? null)
  const tts = applyTtsChoice(v.tts, choice.tts ?? null)
  const lookup = (id: string): Provider | null => providersRepo.get(id)
  return {
    ...v,
    stt: { ...stt, api: withTtsProviderKind(resolveVoiceEndpoint(stt.api, lookup), lookup) },
    tts: { ...tts, api: withTtsProviderKind(resolveVoiceEndpoint(tts.api, lookup), lookup) }
  }
}

// ---------------- voz da persona/chat (protocolo 1.9.0) ----------------

/** Camadas de voz de um chat salvo: a `voice` dele e a da persona de origem (lida ao vivo). */
export function chatVoiceLayers(chatId: string): VoiceLayers {
  const chat = chatsRepo.get(chatId)
  const presetId = chat?.config.presetId
  return {
    chat: chat?.config.voice ?? null,
    persona: presetId ? (presetsRepo.get(presetId)?.config.voice ?? null) : null
  }
}

/** Camadas cruas vindas do renderer (`voice:resolve`, ditado) → normalizadas (lixo = sem a camada). */
export function voiceLayersFrom(input: unknown): VoiceLayers {
  const o =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const layer = (v: unknown): VoiceLayers['chat'] =>
    v && typeof v === 'object' ? normalizeVoiceCallConfig(v) : null
  return { chat: layer(o.chat), persona: layer(o.persona) }
}

/**
 * O que a resolução vai conferir NESTE dispositivo para estas camadas: motores locais (modelos em
 * disco + runtimes) e/ou o modo GPU — as sondas só rodam quando alguma escolha ou setting os usa.
 */
export function voiceCapsNeed(layers: VoiceLayers): { local: boolean; gpu: boolean } {
  const v = readVoiceSettings()
  const tts = [v.tts.backend, ttsChoiceOf(layers).choice?.backend]
  const stt = [v.stt.mode, sttChoiceOf(layers).choice?.mode]
  return {
    local: tts.includes('local') || stt.includes('local') || stt.includes('hybrid'),
    gpu: tts.includes('gpu') || stt.includes('gpu')
  }
}

/**
 * Fala e transcrição de um chat/persona NESTE dispositivo (`resolveTtsVoice`/`resolveSttVoice`
 * sobre as settings daqui): o que a chamada e o ditado usam, de onde veio, o fallback e se
 * funciona. As `settings` da visão vêm SEM endereço/chave (podem ir ao renderer).
 */
export function resolveVoice(layers: VoiceLayers, caps: VoiceDeviceCaps): VoiceResolutionView {
  const v = readVoiceSettings()
  return {
    tts: resolveTtsVoice(layers, v.tts, caps),
    stt: resolveSttVoice(layers, v.stt, v.audioInput.language, caps)
  }
}

/**
 * A voz a USAR depois da resolução: a escolha quando ela vale aqui (null = as deste dispositivo,
 * inclusive no fallback) e o idioma da escolha da persona/chat (vale mesmo no fallback).
 */
export function voiceUse(r: VoiceResolutionView): {
  tts: VoiceTtsChoice | null
  stt: VoiceSttChoice | null
  language: string | null
} {
  return {
    tts: r.tts.source === 'device' ? null : r.tts.choice,
    stt: r.stt.source === 'device' ? null : r.stt.choice,
    language: r.stt.choice?.language ?? null
  }
}

/**
 * `providerKind` do provedor salvo no endpoint de fala resolvido (só para os serviços do main —
 * `'elevenlabs'` liga o cliente ElevenLabs direto; ver `voice/elevenlabs.ts`). Sem provedor → igual.
 */
export function withTtsProviderKind<T extends { providerId: string | null }>(
  api: T,
  lookup: (id: string) => Pick<Provider, 'baseUrl' | 'kind'> | null
): T & { providerKind?: string } {
  const id = api.providerId?.trim()
  const p = id ? lookup(id) : null
  return p ? { ...api, providerKind: providerKind(p) } : api
}

// ---------------- visão para a UI ----------------

/**
 * Os 4 grupos como a UI os vê (`voice:settings:get`): completos e normalizados, SEM resolver o
 * `providerId` — endereço e chave do provedor nunca entram na visão.
 */
export function getVoiceSettingsView(): VoiceSettingsView {
  const v = readVoiceSettings()
  return {
    audioInput: v.audioInput,
    sttSettings: v.stt,
    ttsSettings: v.tts,
    voiceCallDefaults: v.voiceCallDefaults
  }
}

// ---------------- escrita (voice:settings:set) ----------------

/**
 * Normaliza, grava um dos 4 grupos (pelas chaves de setting) e devolve o valor gravado (a mesma
 * visão de `getVoiceSettingsView`; `baseUrl`/`apiKey` vindos no valor são descartados pelo
 * normalizador). Grupo desconhecido → erro legível.
 */
export function setVoiceSetting(kind: 'audioInput', value: unknown): AudioInputSettings
export function setVoiceSetting(kind: 'sttSettings', value: unknown): SttSettings
export function setVoiceSetting(kind: 'ttsSettings', value: unknown): TtsSettings
export function setVoiceSetting(kind: 'voiceCallDefaults', value: unknown): VoiceCallDefaults
export function setVoiceSetting(
  kind: VoiceSettingKind,
  value: unknown
): VoiceSettingsMap[VoiceSettingKind]
export function setVoiceSetting(
  kind: VoiceSettingKind,
  value: unknown
): VoiceSettingsMap[VoiceSettingKind] {
  switch (kind) {
    case 'audioInput': {
      const saved = normalizeAudioInput(value)
      settingsRepo.set(AUDIO_INPUT_SETTING, saved)
      return saved
    }
    case 'sttSettings': {
      const saved = normalizeSttSettings(value)
      settingsRepo.set(STT_SETTINGS_SETTING, saved)
      return saved
    }
    case 'ttsSettings': {
      const saved = normalizeTtsSettings(value)
      settingsRepo.set(TTS_SETTINGS_SETTING, saved)
      return saved
    }
    case 'voiceCallDefaults': {
      const saved = normalizeVoiceCallDefaults(value)
      settingsRepo.set(VOICE_CALL_DEFAULTS_SETTING, saved)
      return saved
    }
  }
  throw new Error(`Grupo de configuração de áudio desconhecido: ${String(kind)}.`)
}

// ---------------- sincronia installed ↔ disco (SPEC → "Áudio → Componentes locais") ----------------

/**
 * Mantém `installed` de `sttSettings.local`/`ttsSettings.local` em sincronia com o disco quando um
 * modelo local é instalado/removido pelos canais `voice:models:*` (a escrita passa por
 * `setVoiceSetting`). Instalar **escolhe** o modelo como atual
 * (`installed: true`); remover o atual derruba o flag para `false` (a seleção engine/modelo fica —
 * a UI oferece "Baixar novamente"). Remover um modelo que não é o atual não mexe nas settings.
 * Idempotente; a SEMÂNTICA de "pronto para transcrever" não é o flag — é `deriveHasLocalReady`
 * (disco) na sessão de transcrição.
 */
export function syncLocalModelInstalled(entry: LocalModelCatalogEntry, installed: boolean): void {
  switch (entry.kind) {
    case 'stt': {
      const cur = normalizeSttSettings(settingsRepo.get(STT_SETTINGS_SETTING))
      const local: SttLocalConfig | null = cur.local
      if (installed) {
        setVoiceSetting('sttSettings', {
          ...cur,
          local: { engine: entry.engine as SttLocalEngine, model: entry.id, installed: true }
        })
        return
      }
      // só o modelo atual perde o flag (engine atual + id atual ou seleção "padrão do motor")
      if (
        local &&
        local.engine === entry.engine &&
        (local.model === entry.id || !local.model.trim())
      ) {
        setVoiceSetting('sttSettings', { ...cur, local: { ...local, installed: false } })
      }
      return
    }
    case 'tts': {
      const cur = normalizeTtsSettings(settingsRepo.get(TTS_SETTINGS_SETTING))
      const local: TtsLocalConfig | null = cur.local
      if (installed) {
        setVoiceSetting('ttsSettings', {
          ...cur,
          local: {
            engine: entry.engine as TtsLocalEngine,
            voice: local?.voice || DEFAULT_TTS_LOCAL.voice,
            installed: true
          }
        })
        return
      }
      if (local && local.engine === entry.engine) {
        setVoiceSetting('ttsSettings', { ...cur, local: { ...local, installed: false } })
      }
    }
  }
}
