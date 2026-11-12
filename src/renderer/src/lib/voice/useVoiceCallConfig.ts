// Config da chamada de voz do chat atual (persona→chat→global + ★/herança) para o dock e o painel
// de timeline (`VoiceCallDock`/`VoiceCallPanel`): resolve `ChatConfig.voice` contra `voiceCallDefaults`
// e grava overrides por `patchConfig` (a opção ★ = padrão global remove o override). Os padrões
// globais vêm do espelho reativo `useVoiceSettings` (nunca uma cópia do primeiro mount). Ver SPEC →
// "Chamada de voz → Timeline e log de diagnóstico".
import { useEffect, useMemo } from 'react'
import {
  normalizeVoiceCallConfig,
  resolveVoiceCallConfig,
  type ResolvedVoiceCall,
  type VoiceCallConfig,
  type VoiceCallDefaults,
  type VoiceFillers
} from '@shared/voice'
import { useStore } from '../../store'
import { loadVoiceSettings, useVoiceSettings } from './voiceSettings'

/** Config da chamada do chat atual + padrões globais (★/herança). */
export function useVoiceCallConfig(): {
  chatId: string | null
  voice: VoiceCallConfig
  defaults: VoiceCallDefaults
  resolved: ResolvedVoiceCall
  setFillers: (patch: Partial<VoiceFillers> | 'inherit') => void
  /** Patch livre do `ChatConfig.voice` do chat da chamada (ex.: modelo da chamada). */
  setVoice: (patch: Partial<VoiceCallConfig>) => void
  /** Config de voz da persona de origem do chat (camada chat > persona > global). */
  persona: VoiceCallConfig | null
} {
  const chatId = useStore((s) => s.voiceCall.chatId)
  const chat = useStore((s) => s.chats.find((c) => c.id === s.voiceCall.chatId) ?? null)
  const patchConfig = useStore((s) => s.patchConfig)
  // padrões globais do espelho único (`voiceSettings`): Configurações → Áudio grava por lá e o ★
  // acompanha na hora; relê ao abrir a chamada (outra tela pode ter mudado)
  const defaults = useVoiceSettings((s) => s.view.voiceCallDefaults)
  useEffect(() => {
    if (chatId) void loadVoiceSettings()
  }, [chatId])
  const presetId = chat?.config.presetId ?? null
  const persona = useStore((s) =>
    presetId ? (s.presets.find((p) => p.id === presetId)?.config.voice ?? null) : null
  )
  // normalizado: campos legados de registros antigos (`interjections`) nunca são regravados
  const stored = chat?.config.voice ?? null
  const voice: VoiceCallConfig = useMemo(() => normalizeVoiceCallConfig(stored), [stored])
  const resolved = useMemo(
    () => resolveVoiceCallConfig(voice, defaults, persona),
    [voice, defaults, persona]
  )
  const setFillers = (patch: Partial<VoiceFillers> | 'inherit'): void => {
    if (!chatId) return
    patchConfig(chatId, {
      voice: { ...voice, fillers: patch === 'inherit' ? null : { ...resolved.fillers, ...patch } }
    })
  }
  const setVoice = (patch: Partial<VoiceCallConfig>): void => {
    if (!chatId) return
    patchConfig(chatId, { voice: { ...voice, ...patch } })
  }
  return { chatId, voice, defaults, resolved, setFillers, setVoice, persona }
}
