// Disponibilidade da voz NESTE dispositivo (protocolo 1.9.0 §4.3.6 — `VoiceDeviceCaps` de
// `@shared/voice`): provedores cadastrados aqui, modelos locais em disco, runtimes (whisper.cpp,
// onnxruntime, espeak-ng) e o modo GPU (runtime, motores, vozes desta máquina). Sem Electron: o IPC
// coleta um retrato (`collectVoiceCaps`, dependências injetadas) e as checagens são puras sobre ele
// (`voiceCapsFrom` — testadas com fakes em `e2e/voicePersona.test.ts`). Nunca expõe endereço/chave.
import type { Provider } from '@shared/types'
import type { GpuStatus } from '@shared/gpuVoice'
import type { SttLocalEngine, TtsLocalEngine, VoiceCheck, VoiceDeviceCaps } from '@shared/voice'
import { providerSupportsVoice } from '@shared/voiceCatalog'
import { findCatalogEntry } from './catalog'
import type { LocalModelInfo } from './models'
import { kokoroReadinessOf, type TtsRuntimeProbe } from './ttsLocal'

/** Retrato do que este dispositivo tem (coletado uma vez por resolução). */
export interface VoiceCapsSnapshot {
  /** Provedor cadastrado AQUI (null = não existe neste dispositivo). */
  provider(id: string): Pick<Provider, 'name' | 'baseUrl' | 'kind'> | null
  /** Catálogo de modelos locais + estado em disco. */
  models: readonly Pick<LocalModelInfo, 'entry' | 'state'>[]
  /** Probe do whisper.cpp (null = não sondado — vale como disponível, o erro sai na hora). */
  whisper: TtsRuntimeProbe | null
  onnx: TtsRuntimeProbe | null
  espeak: TtsRuntimeProbe | null
  /** Status do modo GPU (null = sem o modo GPU / não coletado). */
  gpu: GpuStatus | null
}

const UNPROBED: TtsRuntimeProbe = { available: true, reason: null }

/** Checagens puras sobre o retrato (as que a resolução da voz da persona/chat usa). */
export function voiceCapsFrom(snap: VoiceCapsSnapshot): VoiceDeviceCaps {
  const installed = (kind: 'stt' | 'tts', engine: string): Pick<LocalModelInfo, 'entry'>[] =>
    snap.models.filter(
      (m) => m.entry.kind === kind && m.entry.engine === engine && m.state === 'installed'
    )
  return {
    provider(id, capability): VoiceCheck {
      const p = snap.provider(id)
      if (!p || !p.baseUrl.trim())
        return { ok: false, reason: 'o provedor escolhido não existe neste dispositivo' }
      if (!providerSupportsVoice(p, capability))
        return {
          ok: false,
          reason: `o provedor “${p.name}” não serve ${capability === 'tts' ? 'fala' : 'transcrição'}`
        }
      return { ok: true }
    },
    sttLocal({ engine, model }: { engine: SttLocalEngine; model: string }): VoiceCheck {
      if (engine !== 'whisper.cpp')
        return { ok: false, reason: `o motor ${engine} ainda não transcreve nesta versão do app` }
      if (snap.whisper && !snap.whisper.available)
        return { ok: false, reason: snap.whisper.reason ?? 'o whisper.cpp não carrega aqui' }
      const list = installed('stt', engine)
      if (model) {
        if (!list.some((m) => m.entry.id === model))
          return {
            ok: false,
            reason: `o modelo ${findCatalogEntry(model)?.name ?? model} não está instalado neste dispositivo`
          }
      } else if (!list.length)
        return { ok: false, reason: `nenhum modelo do ${engine} instalado neste dispositivo` }
      return { ok: true }
    },
    ttsLocal({ engine, voice }: { engine: TtsLocalEngine; voice: string }): VoiceCheck {
      if (engine !== 'kokoro')
        return { ok: false, reason: `o motor ${engine} ainda não fala nesta versão do app` }
      const r = kokoroReadinessOf(
        { onnx: snap.onnx ?? UNPROBED, espeak: snap.espeak ?? UNPROBED, models: snap.models },
        voice
      )
      return r.available
        ? { ok: true }
        : { ok: false, reason: `${r.reason ?? 'Kokoro indisponível'} neste dispositivo` }
    },
    ttsGpu({ engine, voice }): VoiceCheck {
      const g = gpuEngineCheck(snap.gpu, engine)
      if (!g.ok || !g.voices) return g
      if (voice && !g.voices.some((v) => v.id === voice))
        return { ok: false, reason: `a voz “${voice}” não existe neste dispositivo` }
      return { ok: true }
    },
    sttGpu({ engine }): VoiceCheck {
      return gpuEngineCheck(snap.gpu, engine)
    }
  }
}

/** Runtime + motor da GPU instalados aqui e sem bloqueio de hardware. */
function gpuEngineCheck(
  s: GpuStatus | null,
  engine: string
): VoiceCheck & { voices?: GpuStatus['engines'][number]['voices'] } {
  if (!s) return { ok: false, reason: 'o modo GPU local não está disponível neste dispositivo' }
  if (s.runtime.state !== 'installed')
    return { ok: false, reason: 'o runtime da GPU não está instalado neste dispositivo' }
  const e = s.engines.find((x) => x.id === engine)
  if (!e) return { ok: false, reason: `o motor da GPU “${engine}” não existe nesta versão do app` }
  if (e.install.state !== 'installed')
    return { ok: false, reason: `o motor ${e.label} não está instalado neste dispositivo` }
  if (e.compat.level === 'blocked')
    return {
      ok: false,
      reason: `${e.label} não roda neste computador${e.compat.reasons[0] ? `: ${e.compat.reasons[0]}` : ''}`
    }
  return { ok: true, voices: e.voices }
}

/** Dependências para coletar o retrato (o IPC passa as reais; testes, fakes). */
export interface VoiceCapsDeps {
  provider(id: string): Pick<Provider, 'name' | 'baseUrl' | 'kind'> | null
  localModels(): Promise<readonly LocalModelInfo[]>
  whisper(): Promise<TtsRuntimeProbe>
  onnx(): Promise<TtsRuntimeProbe>
  espeak(): Promise<TtsRuntimeProbe>
  /** Status da GPU (ausente/null = sem o modo GPU). */
  gpu?(): Promise<GpuStatus | null>
}

/**
 * Coleta o retrato e devolve as checagens. `need` limita as sondas ao que a resolução vai olhar
 * (motores locais / GPU); o que não for coletado vale como "não sondado" (local) ou ausente (GPU).
 */
export async function collectVoiceCaps(
  deps: VoiceCapsDeps,
  need: { local: boolean; gpu: boolean }
): Promise<VoiceDeviceCaps> {
  const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)
  const [models, whisper, onnx, espeak, gpu] = await Promise.all([
    need.local ? safe(deps.localModels(), []) : Promise.resolve([]),
    need.local ? safe(deps.whisper(), null) : Promise.resolve(null),
    need.local ? safe(deps.onnx(), null) : Promise.resolve(null),
    need.local ? safe(deps.espeak(), null) : Promise.resolve(null),
    need.gpu && deps.gpu ? safe(deps.gpu(), null) : Promise.resolve(null)
  ])
  return voiceCapsFrom({ provider: deps.provider, models, whisper, onnx, espeak, gpu })
}
