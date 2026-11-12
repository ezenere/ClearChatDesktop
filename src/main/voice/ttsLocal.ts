// Motor local de fala (TTS) do main — Kokoro-82M v1.0 em ONNX com os pesos do catálogo
// (`catalog.ts`, instalados pelo gerenciador de componentes) e fonemização pt-BR pelo `espeak-ng`
// do SISTEMA. A inferência roda no PROCESSO DO MOTOR (`ttsWorker.ts` via `ttsWorkerHost.ts`): o
// `session.run` do onnxruntime-node é síncrono e travava o event loop do main por 0,4–2,7 s por
// frase. Aqui ficam a resolução dos arquivos (modelo/voz instalados), a validação da voz, a
// prontidão e a tradução dos erros; o pipeline puro está em `kokoroCore.ts` (reexportado abaixo).
// Sem Electron, sem UI, sem IPC; com `run`/`createSession` injetados o motor roda EM PROCESSO
// (testes — nada de onnxruntime real).
import { readFile } from 'node:fs/promises'
import type { TtsLocalEngine } from '@shared/voice'
import { abortError } from '../tools/util'
import {
  espeakMissingMessage,
  KokoroCoreError,
  KOKORO_SAMPLE_RATE,
  kokoroSynthesizePcm,
  runEspeak,
  voiceStyles,
  type CommandRunner,
  type KokoroSession
} from './kokoroCore'
import { listLocalModels, resolveLocalModelPath, type LocalModelInfo } from './models'
import { TtsError, type TtsLocalBackend, type TtsLocalInput, type TtsLocalResult } from './tts'
import { sharedTtsWorkerHost, type TtsWorkerHost } from './ttsWorkerHost'
import { encodeWav } from './wav'

export {
  ESPEAK_E2M,
  espeakInstallHint,
  floatToPcm16,
  KOKORO_MAX_TOKENS,
  KOKORO_SAMPLE_RATE,
  KOKORO_VOCAB,
  kokoroInputIds,
  mapEspeakPhonemes,
  phonemizeText,
  type KokoroSession,
  type KokoroTensor
} from './kokoroCore'

/** Vozes pt-BR do Kokoro v1.0 (ids conferidos em `hexgrad/Kokoro-82M` VOICES.md). */
export interface KokoroVoiceInfo {
  /** Id da voz nas settings (`TtsSettings.local.voice`) e no nome do arquivo (`<id>.bin`). */
  id: string
  /** Rótulo de exibição. */
  label: string
  /** Entrada do catálogo com o voice pack (tensor de estilos 510×256 fp32). */
  catalogId: string
}

export const KOKORO_VOICES: readonly KokoroVoiceInfo[] = [
  { id: 'pf_dora', label: 'Dora (pt-BR, feminina)', catalogId: 'kokoro-voice-pf-dora' },
  { id: 'pm_alex', label: 'Alex (pt-BR, masculina)', catalogId: 'kokoro-voice-pm-alex' },
  { id: 'pm_santa', label: 'Santa (pt-BR, masculina)', catalogId: 'kokoro-voice-pm-santa' }
]

/**
 * Modelos do motor no catálogo, em ordem de preferência. Só a fp32: a int8 (`kokoro-onnx-q8`) foi
 * aposentada — ~3× mais lenta em CPU, a 1ª frase de 60 caracteres passava de 1 s mesmo num desktop
 * rápido (lenta demais para conversa; SPEC → "Áudio → Componentes locais").
 */
export const KOKORO_MODEL_IDS: readonly string[] = ['kokoro-onnx']

/** Modelo do Kokoro aposentado que ainda pode estar instalado (aviso + troca para a fp32). */
export const KOKORO_RETIRED_MODEL_ID = 'kokoro-onnx-q8'

/**
 * Aviso legível (pt-BR) para quem só tem o Kokoro int8 aposentado instalado: o app passou a usar a
 * fp32 — baixar o fp32 resolve e o arquivo int8 pode ser removido (fica em disco até o usuário
 * remover em Configurações → Áudio).
 */
export const KOKORO_RETIRED_MODEL_NOTE =
  'o Kokoro int8 instalado foi aposentado (lento demais para conversa em tempo real) — o app agora usa o Kokoro ONNX fp32: baixe-o em Configurações → Áudio (310 MB) e, se quiser, remova o int8 (88 MB)'

// ---------------- motor ----------------

export interface KokoroEngineDeps {
  /** userData do app — os pesos ficam em `<baseDir>/models` (gerenciador de componentes). */
  baseDir: string
  /** Processo do motor (padrão: o compartilhado do app — `sharedTtsWorkerHost()`). */
  host?: TtsWorkerHost
  /** Testes: executa o espeak-ng (com `createSession`, o motor roda EM PROCESSO). */
  run?: CommandRunner
  /** Testes: cria a sessão ONNX (presente → motor EM PROCESSO, sem worker). */
  createSession?: (modelPath: string) => Promise<KokoroSession>
}

/** Motor local Kokoro (implementação de `TtsLocalBackend`). */
export interface KokoroEngine extends TtsLocalBackend {
  engine: Extract<TtsLocalEngine, 'kokoro'>
  /** Vozes pt-BR com o estado de instalação em disco. */
  voices(): Promise<{ id: string; label: string; installed: boolean }[]>
  /** Solta a sessão ONNX carregada (modelo removido/trocado); a próxima síntese recarrega. */
  release(): Promise<void>
}

/** Erro legível de espeak-ng ausente (com a dica da plataforma). */
export function espeakMissingError(cause?: unknown): TtsError {
  return new TtsError('config', espeakMissingMessage(), { backend: 'local', cause })
}

/** `KokoroCoreError` → `TtsError` `config` (abort → `AbortError`); outros erros passam. */
function coreError(e: unknown): unknown {
  if (!(e instanceof KokoroCoreError)) return e
  if (e.code === 'aborted') return abortError()
  return new TtsError('config', e.message, { backend: 'local', cause: e })
}

/** Runner do espeak-ng do main (probe `--version`): falhas → `TtsError` legível. */
async function defaultRun(command: string, args: string[]): Promise<string> {
  try {
    return await runEspeak(command, args)
  } catch (e) {
    throw coreError(e)
  }
}

// ---------------- probes do runtime (prontidão do motor local) ----------------

/** Resultado de um probe de runtime. */
export interface TtsRuntimeProbe {
  available: boolean
  reason: string | null
}

/** Reprova (onnxruntime/espeak-ng) só vale por este tempo — dá para corrigir com o app aberto. */
const NEGATIVE_PROBE_TTL_MS = 30_000

let onnxProbe: Promise<TtsRuntimeProbe> | null = null

/**
 * `onnxruntime-node` carrega no PROCESSO DO MOTOR (binding nativo + libonnxruntime da plataforma)?
 * O main nunca carrega o binding. Positivo memoizado por execução; negativo expira em 30 s; nunca
 * lança.
 */
export function probeOnnxRuntime(
  host: TtsWorkerHost = sharedTtsWorkerHost()
): Promise<TtsRuntimeProbe> {
  if (onnxProbe) return onnxProbe
  const result: Promise<TtsRuntimeProbe> = host.probe().then((r) =>
    r.available
      ? { available: true, reason: null }
      : {
          available: false,
          reason: `o runtime ONNX (onnxruntime-node) não pôde ser carregado nesta instalação (${r.reason ?? 'motivo desconhecido'})`
        }
  )
  onnxProbe = result
  void result.then((r) => {
    if (!r.available && onnxProbe === result)
      setTimeout(() => {
        if (onnxProbe === result) onnxProbe = null
      }, NEGATIVE_PROBE_TTL_MS).unref?.()
  })
  return result
}

let espeakProbe: { at: number; result: Promise<TtsRuntimeProbe> } | null = null

/** O `espeak-ng` do sistema responde (`--version`)? Positivo memoizado; negativo expira em 30 s. */
export function probeEspeak(run: CommandRunner = defaultRun): Promise<TtsRuntimeProbe> {
  const now = Date.now()
  if (espeakProbe) return espeakProbe.result
  const result = run('espeak-ng', ['--version']).then(
    () => ({ available: true, reason: null }),
    (e: unknown) => ({ available: false, reason: e instanceof Error ? e.message : String(e) })
  )
  espeakProbe = { at: now, result }
  void result.then((r) => {
    if (!r.available && espeakProbe?.result === result)
      setTimeout(() => {
        if (espeakProbe?.result === result) espeakProbe = null
      }, NEGATIVE_PROBE_TTL_MS).unref?.()
  })
  return result
}

/** Zera os probes memoizados (testes). */
export function resetTtsRuntimeProbes(): void {
  onnxProbe = null
  espeakProbe = null
}

// ---------------- motor ----------------

/** Id do catálogo pelo arquivo do modelo (fp32 `model.onnx` / q8 `model_quantized.onnx`). */
const modelIdOf = (modelPath: string): string =>
  modelPath.endsWith('model_quantized.onnx') ? KOKORO_RETIRED_MODEL_ID : 'kokoro-onnx'

/**
 * Motor local Kokoro sobre os pesos do catálogo (`<userData>/models`): modelo `kokoro-onnx` (fp32
 * — a int8 foi aposentada; com só ela instalada, o erro diz para baixar a fp32), voz `<id>.bin`.
 * `synthesize` devolve wav 24 kHz mono (mp3 é do backend de API — erro legível aqui). A inferência
 * vai para o processo do motor (`deps.host`); com `createSession` injetado roda em processo.
 */
export function createKokoroEngine(deps: KokoroEngineDeps): KokoroEngine {
  const inProcess = !!deps.createSession
  const run = deps.run ?? defaultRun
  const sessions = new Map<string, Promise<KokoroSession>>()
  const host = (): TtsWorkerHost => deps.host ?? sharedTtsWorkerHost()

  const installedModels = async (): Promise<LocalModelInfo[]> => listLocalModels(deps.baseDir)

  const requireFile = async (catalogId: string, what: string): Promise<string> => {
    const info = (await installedModels()).find((m) => m.entry.id === catalogId)
    if (!info || info.state !== 'installed')
      throw new TtsError(
        'config',
        `${what} não instalado — baixe os arquivos do Kokoro em Configurações → Áudio`,
        { backend: 'local' }
      )
    return resolveLocalModelPath(deps.baseDir, catalogId)
  }

  const requireModel = async (): Promise<string> => {
    const models = await installedModels()
    for (const id of KOKORO_MODEL_IDS) {
      const m = models.find((x) => x.entry.id === id)
      if (m?.state === 'installed') return resolveLocalModelPath(deps.baseDir, id)
    }
    const retired = models.find((x) => x.entry.id === KOKORO_RETIRED_MODEL_ID)
    throw new TtsError(
      'config',
      retired?.state === 'installed'
        ? `modelo do Kokoro não instalado — ${KOKORO_RETIRED_MODEL_NOTE}`
        : 'modelo do Kokoro não instalado — baixe o motor local em Configurações → Áudio',
      { backend: 'local' }
    )
  }

  const sessionFor = (modelPath: string): Promise<KokoroSession> => {
    let s = sessions.get(modelPath)
    if (!s) {
      s = deps.createSession!(modelPath)
      sessions.set(modelPath, s)
      // falha não fica em cache: a próxima síntese tenta de novo (ex.: modelo baixado de novo)
      const created = s
      created.catch(() => {
        if (sessions.get(modelPath) === created) sessions.delete(modelPath)
      })
    }
    return s
  }

  /** Motor em processo (testes): mesmo pipeline do worker com a sessão injetada. */
  const synthesizeInProcess = async (
    modelPath: string,
    voicePath: string,
    text: string,
    signal?: AbortSignal
  ): Promise<Uint8Array> => {
    const styles = voiceStyles(await readFile(voicePath))
    const session = await sessionFor(modelPath)
    try {
      const out = await kokoroSynthesizePcm({
        text,
        styles,
        session,
        run,
        aborted: () => !!signal?.aborted
      })
      if (signal?.aborted) throw abortError()
      return encodeWav(out.pcm, KOKORO_SAMPLE_RATE)
    } catch (e) {
      throw coreError(e)
    }
  }

  return {
    engine: 'kokoro',
    async release() {
      if (!inProcess) {
        // o processo do motor só existe se já sintetizou/sondou: soltar a sessão = devolver a RAM
        host().unload()
        return
      }
      const all = [...sessions.values()]
      sessions.clear()
      for (const p of all) {
        try {
          await (await p).release?.()
        } catch {
          /* sessão que falhou ao criar / já liberada */
        }
      }
    },
    async voices() {
      const models = await installedModels()
      return KOKORO_VOICES.map((v) => ({
        id: v.id,
        label: v.label,
        installed: models.some((m) => m.entry.id === v.catalogId && m.state === 'installed')
      }))
    },
    async synthesize(input: TtsLocalInput): Promise<TtsLocalResult> {
      if (input.format !== 'wav')
        throw new TtsError('config', 'o motor local gera áudio wav (mp3 é do backend de API)', {
          backend: 'local'
        })
      if (input.signal?.aborted) throw abortError()
      const voice = KOKORO_VOICES.find((v) => v.id === input.voice)
      if (!voice)
        throw new TtsError(
          'config',
          `voz "${input.voice}" desconhecida para o Kokoro (use: ${KOKORO_VOICES.map((v) => v.id).join(', ')})`,
          { backend: 'local' }
        )
      const t0 = Date.now()
      const [modelPath, voicePath] = await Promise.all([
        requireModel(),
        requireFile(voice.catalogId, `voz ${voice.id}`)
      ])
      if (input.signal?.aborted) throw abortError()
      const audio = inProcess
        ? await synthesizeInProcess(modelPath, voicePath, input.text, input.signal)
        : (await host().synthesize({ modelPath, voicePath, text: input.text }, input.signal)).audio
      if (input.signal?.aborted) throw abortError()
      return { audio, mime: 'audio/wav', model: modelIdOf(modelPath), ms: Date.now() - t0 }
    }
  }
}

/**
 * Prontidão do motor local Kokoro ("pronto = modelo instalado + runtime carregável"):
 * `onnxruntime-node` carrega, `espeak-ng` existe no sistema e há modelo + voz `voiceId` instalados.
 * Nunca lança; `reason` diz o que falta (pt-BR).
 */
export async function kokoroReadiness(
  baseDir: string,
  voiceId: string | null,
  deps: { run?: (command: string, args: string[]) => Promise<string> } = {}
): Promise<TtsRuntimeProbe> {
  const [onnx, espeak, models] = await Promise.all([
    probeOnnxRuntime(),
    probeEspeak(deps.run),
    listLocalModels(baseDir).catch(() => [] as LocalModelInfo[])
  ])
  return kokoroReadinessOf({ onnx, espeak, models }, voiceId)
}

/**
 * `kokoroReadiness` sobre um retrato já coletado (probes + modelos em disco) — puro: a
 * disponibilidade da voz de uma persona (`voice/voiceCaps.ts`) confere várias vozes de uma vez.
 */
export function kokoroReadinessOf(
  snap: {
    onnx: Pick<TtsRuntimeProbe, 'available' | 'reason'>
    espeak: Pick<TtsRuntimeProbe, 'available' | 'reason'>
    models: readonly Pick<LocalModelInfo, 'entry' | 'state'>[]
  },
  voiceId: string | null
): TtsRuntimeProbe {
  const { onnx, espeak, models } = snap
  const missing: string[] = []
  if (!onnx.available) missing.push(onnx.reason ?? 'runtime ONNX indisponível')
  if (!espeak.available) missing.push(espeakMissingError().message)
  const installed = (id: string): boolean =>
    models.some((m) => m.entry.id === id && m.state === 'installed')
  if (!KOKORO_MODEL_IDS.some(installed))
    missing.push(
      installed(KOKORO_RETIRED_MODEL_ID)
        ? KOKORO_RETIRED_MODEL_NOTE
        : 'modelo do Kokoro não instalado'
    )
  const voice = KOKORO_VOICES.find((v) => v.id === voiceId)
  if (!voice) missing.push(`voz "${voiceId ?? ''}" desconhecida para o Kokoro`)
  else if (!installed(voice.catalogId)) missing.push(`voz ${voice.id} não instalada`)
  return missing.length
    ? { available: false, reason: missing.join('; ') }
    : { available: true, reason: null }
}
