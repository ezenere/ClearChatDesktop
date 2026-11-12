// Voz de um chat/persona NESTE dispositivo no renderer (protocolo 1.9.0): pede ao main a resolução
// (`voice.resolve` → `resolveTtsVoice`/`resolveSttVoice` com a disponibilidade real — provedores,
// modelos em disco, runtimes, GPU) e a guarda num cache por camadas. Quem mostra o microfone e o
// telefone esmaecidos (composer), a pré-checagem da chamada e as seções "Fala"/"Transcrição" do
// editor da persona/chat leem daqui. Refaz quando as camadas mudam, quando as settings de voz deste
// dispositivo ou os provedores mudam, ao fechar as Configurações e quando algo é instalado/removido
// (`bumpVoiceEnv`, também pelo status da GPU).
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { VoiceLayersInput, VoiceResolutionView } from '@shared/ipc'
import { api } from '../api'
import { useStore } from '../../store'
import { useGpuStore } from './gpu/useGpuStatus'
import { useVoiceSettings } from './voiceSettings'

/** Contador do "ambiente de voz" (modelos/GPU instalados): sobe → as resoluções são refeitas. */
export const useVoiceEnv = create<{ tick: number }>(() => ({ tick: 0 }))

/** Algo instalado/removido/configurado fora das settings (modelos locais, GPU): refaz as resoluções. */
export function bumpVoiceEnv(): void {
  useVoiceEnv.setState((s) => ({ tick: s.tick + 1 }))
}

const cache = new Map<string, Promise<VoiceResolutionView | null>>()

/** Resolução (memoizada pela chave) — null sem `voice.resolve` ou se o main falhar. */
export function fetchVoiceResolution(
  layers: VoiceLayersInput,
  key = JSON.stringify(layers)
): Promise<VoiceResolutionView | null> {
  const resolve = api.voice?.resolve
  if (!resolve) return Promise.resolve(null)
  let p = cache.get(key)
  if (!p) {
    p = resolve(layers).catch(() => null)
    cache.set(key, p)
    // o cache é só para os vários consumidores do mesmo render (composer + telefone + seções)
    if (cache.size > 64) cache.delete(cache.keys().next().value as string)
  }
  return p
}

/** Assinatura do que, fora das camadas, muda a disponibilidade (settings daqui, provedores, GPU). */
function useEnvKey(): string {
  const tick = useVoiceEnv((s) => s.tick)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const view = useVoiceSettings((s) => s.view)
  const providers = useStore((s) => s.providers)
  const gpu = useGpuStore((s) => s.status)
  return useMemo(
    () =>
      JSON.stringify([
        tick,
        settingsOpen,
        view.sttSettings,
        view.ttsSettings,
        view.audioInput.language,
        providers.map((p) => [p.id, p.baseUrl, p.kind ?? null]),
        gpu
          ? [
              gpu.runtime.state,
              gpu.engines.map((e) => [e.id, e.install.state, e.voices.map((v) => v.id)])
            ]
          : null
      ]),
    [tick, settingsOpen, view, providers, gpu]
  )
}

/**
 * Voz resolvida das camadas (null = ainda resolvendo, sem `voice.resolve` ou sem camadas — `layers`
 * null desliga). Camadas iguais compartilham a mesma request.
 */
export function useVoiceResolution(layers: VoiceLayersInput | null): VoiceResolutionView | null {
  const env = useEnvKey()
  const layersKey = layers ? JSON.stringify(layers) : null
  const key = layersKey ? `${env}|${layersKey}` : null
  const [state, setState] = useState<{ key: string; value: VoiceResolutionView | null } | null>(
    null
  )
  useEffect(() => {
    if (!key || !layersKey) return
    let alive = true
    void fetchVoiceResolution(JSON.parse(layersKey) as VoiceLayersInput, key).then((value) => {
      if (alive) setState({ key, value })
    })
    return () => {
      alive = false
    }
  }, [key, layersKey])
  // a última resolução continua valendo enquanto a nova não chega (sem piscar o ícone)
  return key && state ? state.value : null
}

/** Camadas de voz de um chat (a `voice` dele + a da persona de origem, lida ao vivo do store). */
export function useChatVoiceLayers(chatId: string | null | undefined): VoiceLayersInput | null {
  const chat = useStore((s) => (chatId ? s.chats.find((c) => c.id === chatId) : undefined))
  const presetId = chat?.config.presetId ?? null
  const persona = useStore((s) =>
    presetId ? (s.presets.find((p) => p.id === presetId)?.config.voice ?? null) : null
  )
  const voice = chat?.config.voice ?? null
  const exists = !!chat
  return useMemo(() => (exists ? { chat: voice, persona } : null), [exists, voice, persona])
}
