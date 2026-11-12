// Textos e rótulos da voz da persona/chat (protocolo 1.9.0) — puros, sem React: o rótulo curto de
// uma voz/transcrição ("Kokoro · pf_dora", "ElevenLabs · eleven_flash_v2_5 · Rachel"), os tooltips
// do microfone/telefone esmaecidos ("não configurado"/"não funciona neste dispositivo" + motivo), o
// aviso discreto do fallback ("a voz da persona não está disponível aqui — usando a padrão deste
// dispositivo") e a voz herdada levada junto ao "Salvar como persona". Testados em
// `e2e/voicePersona.test.ts`.
import type { ChatConfig } from '@shared/types'
import { gpuEngineShortLabel } from '@shared/gpuVoice'
import {
  normalizeVoiceCallConfig,
  type SttSettings,
  type TtsSettings,
  type VoiceCallConfig,
  type VoiceResolution,
  type VoiceSttResolution,
  type VoiceTtsResolution
} from '@shared/voice'

/** Provedor como os rótulos o veem (sem chave). */
export interface LabelProvider {
  id: string
  name: string
}

const providerName = (id: string | null, providers: readonly LabelProvider[]): string =>
  (id && providers.find((p) => p.id === id)?.name) || 'provedor que não existe aqui'

/** Rótulo curto da voz de fala ("Kokoro · pf_dora", "ElevenLabs · eleven_flash_v2_5 · voz"). */
export function ttsVoiceLabel(s: TtsSettings, providers: readonly LabelProvider[]): string {
  if (s.backend === 'api')
    return [
      providerName(s.api.providerId, providers),
      s.api.model || 'sem modelo',
      s.api.voice ?? 'voz padrão'
    ].join(' · ')
  if (s.backend === 'gpu')
    return [
      'GPU local',
      gpuEngineShortLabel(s.gpu?.engine ?? 'omnivoice'),
      s.gpu?.voice ?? 'voz padrão do motor'
    ].join(' · ')
  if (!s.local) return 'nenhuma voz escolhida'
  return [s.local.engine === 'kokoro' ? 'Kokoro' : 'Chatterbox', s.local.voice].join(' · ')
}

/** Rótulo curto da transcrição ("Groq · whisper-large-v3-turbo · pt-BR", "whisper.cpp · ggml-base"). */
export function sttVoiceLabel(
  s: SttSettings,
  providers: readonly LabelProvider[],
  language?: string | null
): string {
  const local = s.local
    ? `${s.local.engine} · ${s.local.model || 'modelo padrão'}`
    : 'sem modelo local'
  const api = `${providerName(s.api.providerId, providers)} · ${s.api.model || 'sem modelo'}`
  const main =
    s.mode === 'api'
      ? api
      : s.mode === 'local'
        ? local
        : s.mode === 'gpu'
          ? 'GPU local · Whisper large-v3-turbo'
          : `${api} + ${s.local?.engine ?? 'local'} (híbrido)`
  return language ? `${main} · ${language}` : main
}

/** "da persona" / "deste chat" — de onde vem a escolha configurada. */
const fromText = (from: 'chat' | 'persona'): string =>
  from === 'persona' ? 'da persona' : 'deste chat'

/**
 * Aviso discreto quando a escolha da persona/chat não está disponível aqui e a padrão deste
 * dispositivo entra no lugar (null = sem fallback).
 */
export function voiceFallbackNote(
  kind: 'tts' | 'stt',
  r: Pick<VoiceResolution<unknown, unknown>, 'fallback'> | null | undefined
): string | null {
  if (!r?.fallback) return null
  const what = kind === 'tts' ? 'A voz' : 'A transcrição'
  return `${what} ${fromText(r.fallback.from)} não está disponível neste dispositivo (${r.fallback.reason}) — usando a padrão deste dispositivo.`
}

/** Estado do ícone: pronto, pronto com fallback, não configurado ou não funciona aqui. */
export type VoiceIconState = 'ok' | 'fallback' | 'unconfigured' | 'unavailable'

export function voiceIconState(
  rs: readonly (
    | Pick<VoiceResolution<unknown, unknown>, 'available' | 'unconfigured' | 'fallback'>
    | null
    | undefined
  )[]
): VoiceIconState {
  const list = rs.filter((r): r is NonNullable<typeof r> => !!r)
  const bad = list.filter((r) => !r.available)
  if (bad.length) return bad.every((r) => r.unconfigured) ? 'unconfigured' : 'unavailable'
  return list.some((r) => r.fallback) ? 'fallback' : 'ok'
}

/** Tooltip do microfone esmaecido (ditado indisponível aqui); null = disponível. */
export function dictationUnavailableText(
  stt: VoiceSttResolution | null | undefined
): string | null {
  if (!stt || stt.available) return null
  return stt.unconfigured
    ? `Ditado não configurado neste dispositivo — ${stt.reason ?? 'escolha a transcrição'} (Configurações → Áudio → Transcrição).`
    : `Ditado não funciona neste dispositivo — ${stt.reason ?? 'transcrição indisponível'} (Configurações → Áudio).`
}

/** Tooltip do telefone esmaecido (chamada indisponível aqui); null = disponível. */
export function callUnavailableText(
  r: { tts: VoiceTtsResolution; stt: VoiceSttResolution } | null | undefined
): string | null {
  if (!r || (r.tts.available && r.stt.available)) return null
  const parts = [
    !r.stt.available && `transcrição: ${r.stt.reason ?? 'indisponível'}`,
    !r.tts.available && `fala: ${r.tts.reason ?? 'indisponível'}`
  ].filter(Boolean)
  const state = voiceIconState([r.stt, r.tts])
  return `${state === 'unconfigured' ? 'Chamada de voz não configurada neste dispositivo' : 'Chamada de voz não funciona neste dispositivo'} — ${parts.join('; ')} (Configurações → Áudio).`
}

/**
 * "Salvar como persona" de um chat: a voz de fala/transcrição que o chat USA (a dele ou a herdada
 * ao vivo da persona de origem) vai junto — o chat não guarda a da persona (`applyPreset`).
 */
export function withInheritedVoice(
  cfg: Partial<ChatConfig>,
  personaVoice: VoiceCallConfig | null | undefined
): Partial<ChatConfig> {
  if (!personaVoice) return cfg
  const p = normalizeVoiceCallConfig(personaVoice)
  if (!p.tts && !p.stt) return cfg
  const v = normalizeVoiceCallConfig(cfg.voice ?? null)
  const tts = v.tts ?? p.tts
  const stt = v.stt ?? p.stt
  return { ...cfg, voice: { ...v, ...(tts ? { tts } : {}), ...(stt ? { stt } : {}) } }
}

/**
 * Config de uma persona para um chat NOVO sem a voz/transcrição dela (`voice.tts`/`voice.stt`): o
 * chat as herda AO VIVO da persona de origem (`presetId`) — trocar a voz da persona muda a dos chats
 * dela. O resto da `voice` (liga/desliga, modelo, prompts…) segue como snapshot.
 */
export function withoutVoiceChoice<T extends { voice?: VoiceCallConfig | null }>(cfg: T): T {
  if (!cfg.voice || (!cfg.voice.tts && !cfg.voice.stt)) return cfg
  const { tts: _t, stt: _s, ...voice } = cfg.voice
  void _t
  void _s
  return { ...cfg, voice }
}
