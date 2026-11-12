// "Modo avançado (GPU local)" — orquestrador do main (sem Electron; tudo injetável): sonda de
// hardware + regras de compatibilidade, instalador (runtime/motores, uma operação por vez,
// cancelável), servidor (processos por grupo, token da sessão), vozes (CC0/usuário), autoteste
// pelo caminho de áudio do app e o resolvedor de endpoint usado por `voice/tts.ts` e pela
// transcrição (`sttBackend`). Emite o `GpuStatus` completo a cada mudança (evento
// `voice:gpu:progress`, no máximo a cada 250 ms). Ver SPEC.md → "Modo avançado (GPU local)".
import {
  DEFAULT_TTS_GPU,
  GPU_CC0_VOICES,
  GPU_ENGINE_CATALOG,
  GPU_STT_ENGINE_ID,
  OMNIVOICE_DEFAULT_STEPS,
  evaluateEngineCompat,
  evaluateRuntimeCompat,
  gpuEngineEntry,
  gpuEngineShortLabel,
  gpuEnginesLabel,
  isGpuEngineId,
  resolveGpuParams,
  type GpuEngineCatalogEntry,
  type GpuEngineGroup,
  type GpuEngineId,
  type GpuEngineStatus,
  type GpuProbe,
  type GpuSelfTestResult,
  type GpuStatus,
  type GpuTtsEngineId,
  type GpuVoice
} from '@shared/gpuVoice'
import {
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_API,
  type SttSettings,
  type TtsSettings
} from '@shared/voice'
import type { VoiceRuntimeCheck } from '@shared/ipc'
import { encodeWav } from '../wav'
import { synthesizeStream } from '../tts'
import { transcribeAudio, type SttLocalBackend, type TranscribeAudioInput } from '../stt'
import { GpuEndpointError, type GpuEndpoint, type GpuEndpointResolver } from './endpoint'
import { GpuInstaller, isAbortError, type InstallProgress, type InstallerDeps } from './installer'
import { ownVramByGpu, probeSystem } from './probe'
import { GpuServerManager, type ServerManagerDeps } from './server'
import { GpuVoiceStore } from './voices'

export interface GpuMeasured {
  firstAudioMs: number
  rtf: number
  at: string
  wer?: number
}

export interface GpuManagerDeps extends Omit<InstallerDeps, 'run'> {
  run?: InstallerDeps['run']
  /** Settings atuais (para padrões do servidor e voz/passos). */
  getTts: () => TtsSettings
  getStt: () => SttSettings
  /** Medições do autoteste (setting local `gpuVoiceMeasured`). */
  readMeasured: () => Partial<Record<GpuEngineId, GpuMeasured>>
  writeMeasured: (id: GpuEngineId, m: GpuMeasured) => void
  onStatus?: (s: GpuStatus) => void
  probe?: () => Promise<GpuProbe>
  /** Overrides do gerenciador de processos (testes). */
  server?: Partial<ServerManagerDeps>
  token?: string
  log?: (msg: string) => void
}

/** Frase fixa do autoteste (sem números — WER limpo). */
export const GPU_SELFTEST_PHRASE = 'Claro, já vou verificar isso para você agora.'

const PROBE_TTL_MS = 20_000

/** WER simples (palavras normalizadas: minúsculas, sem acentos/pontuação). */
export function wordErrorRate(ref: string, hyp: string): number {
  const norm = (s: string): string[] =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/%/g, ' por cento ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      // fala coloquial que o whisper escreve como se ouve ("pra" = "para")
      .map((w) => (w === 'pra' ? 'para' : w))
  const r = norm(ref)
  const h = norm(hyp)
  if (!r.length) return h.length ? 1 : 0
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)])
  for (let j = 1; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)
      )
  return Math.round((d[r.length][h.length] / r.length) * 1000) / 1000
}

type Op = {
  target: 'runtime' | GpuEngineId
  controller: AbortController
  progress: InstallProgress | null
  /** Instalação de motor que começou sem o runtime pronto (instala o runtime antes). */
  withRuntime: boolean
  /** Progresso do runtime (próprio ou instalado junto de um motor). */
  rtProgress: InstallProgress | null
}

/** Estado dos motores de um processo do servidor (`/health`). */
type HealthMap = Map<GpuEngineGroup, Record<string, { state?: string }>>

/** VRAM estimada do contexto CUDA de um processo (quando o driver não informa a do processo). */
const CUDA_CONTEXT_MB = 300

export class GpuVoiceManager implements GpuEndpointResolver {
  readonly installer: GpuInstaller
  readonly server: GpuServerManager
  readonly voices: GpuVoiceStore
  private op: Op | null = null
  private lastError: { target: 'runtime' | GpuEngineId; message: string } | null = null
  private probeCache: { at: number; v: GpuProbe } | null = null
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private warming = false
  /** Fase legível da subida sob demanda (`server.phase` do status; null = nada em andamento). */
  private serverPhase: string | null = null
  private readonly omniSteps = new Map<GpuEngineGroup, number>()
  /** Config do whisper já enviada a cada processo (`grupo:porta` → JSON dos parâmetros). */
  private readonly whisperCfg = new Map<string, string>()
  /** `/health` dos processos rodando (motores carregados), com validade curta. */
  private healthCache: { at: number; v: HealthMap } | null = null
  private seq = 0

  private readonly deps: GpuManagerDeps

  constructor(deps: GpuManagerDeps) {
    this.deps = deps
    this.installer = new GpuInstaller(deps)
    const L = this.installer.layout
    this.voices = new GpuVoiceStore(L.voices, deps.fetch)
    this.server = new GpuServerManager(
      {
        logDir: L.logs,
        onChange: () => {
          // processo subiu/caiu/parou: a VRAM livre e os motores carregados mudaram
          this.invalidateLive()
          this.scheduleEmit()
        },
        log: deps.log,
        spec: (group, engines, port, token) => ({
          python: this.installer.pythonFor(group),
          args: [
            '-I',
            this.installer.serverScript,
            'serve',
            '--port',
            String(port),
            '--engines',
            engines.join(','),
            '--voices-dir',
            L.voices,
            '--assets-dir',
            L.assets,
            '--omni-steps',
            String(this.currentSteps())
          ],
          env: this.installer.pyEnv({ CLEARCHAT_GPU_TOKEN: token, HF_HUB_OFFLINE: '1' }),
          cwd: L.root
        }),
        ...deps.server
      },
      deps.token
    )
  }

  private currentSteps(): number {
    return this.deps.getTts().gpu?.steps ?? OMNIVOICE_DEFAULT_STEPS
  }

  /** Esquece a sonda e o `/health` em cache (próximo status relê VRAM e motores carregados). */
  private invalidateLive(): void {
    this.probeCache = null
    this.healthCache = null
  }

  /** Motores de cada processo rodando (`/health`; cache de 3 s). */
  private async health(): Promise<HealthMap> {
    const now = Date.now()
    if (this.healthCache && now - this.healthCache.at < 3000) return this.healthCache.v
    const v: HealthMap = new Map()
    await Promise.all(
      this.server
        .list()
        .filter((p) => p.state === 'running' && p.port)
        .map(async (p) => {
          try {
            const r = await (this.deps.server?.fetch ?? fetch)(
              `http://127.0.0.1:${p.port}/health`,
              {
                headers: { Authorization: `Bearer ${this.server.token}` },
                signal: AbortSignal.timeout(1500)
              }
            )
            if (!r.ok) return
            const j = (await r.json()) as { engines?: Record<string, { state?: string }> }
            v.set(p.group, j.engines ?? {})
          } catch {
            /* processo ocupado/subindo: sem informação */
          }
        })
    )
    this.healthCache = { at: now, v }
    return v
  }

  // ---------------- sonda / status ----------------

  async probe(refresh = false): Promise<GpuProbe> {
    const now = Date.now()
    if (!refresh && this.probeCache && now - this.probeCache.at < PROBE_TTL_MS)
      return this.probeCache.v
    const v = await (this.deps.probe ?? (() => probeSystem(this.deps.baseDir)))()
    this.probeCache = { at: now, v }
    return v
  }

  private scheduleEmit(): void {
    if (!this.deps.onStatus || this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      void this.status()
        .then((s) => this.deps.onStatus?.(s))
        .catch(() => undefined)
    }, 250)
  }

  private voicesFor(
    entry: GpuEngineCatalogEntry,
    stored: Awaited<ReturnType<GpuVoiceStore['list']>>,
    whisperInstalled: boolean
  ): GpuVoice[] {
    const out: GpuVoice[] = entry.builtinVoices.map((v) => ({ ...v }))
    if (!entry.clones) return out
    for (const v of stored) {
      // Qwen exige a transcrição da referência; OmniVoice transcreve sozinho com o whisper instalado
      if (entry.needsTranscript && !v.transcript && !(entry.id === 'omnivoice' && whisperInstalled))
        continue
      out.push({
        id: v.id,
        label: v.name,
        source: v.source,
        ...(v.source === 'cc0' ? { accent: 'pt-BR' as const } : {})
      })
    }
    return out
  }

  async status(refreshProbe = false): Promise<GpuStatus> {
    const seq = ++this.seq
    const [probe, state, stored, health] = await Promise.all([
      this.probe(refreshProbe),
      this.installer.readState(),
      this.voices.list(),
      this.health()
    ])
    const runtimeState = this.installer.runtimeState(state)
    const runtimeReady = runtimeState === 'installed'
    const measured = this.deps.readMeasured()
    const op = this.op
    // instalando o runtime (sozinho ou antes de um motor): nada de "incompleta"/"com problema"
    // enquanto a instalação roda — o estado em disco é parcial POR definição
    const runtimeInstalling = !!op && (op.target === 'runtime' || (op.withRuntime && !runtimeReady))
    const whisperInstalled = this.installer.engineState(state, GPU_STT_ENGINE_ID) === 'installed'
    const vram = this.vramView(probe, health)
    const engines: GpuEngineStatus[] = GPU_ENGINE_CATALOG.map((entry) => {
      const st = this.installer.engineState(state, entry.id)
      const installing = op?.target === entry.id
      const err = this.lastError?.target === entry.id ? this.lastError.message : null
      const m = measured[entry.id]
      const ev = vram.engine(entry)
      return {
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        license: { ...entry.license },
        sizeMb:
          entry.weightsMb + (this.installer.layerReady(state, entry.group) ? 0 : entry.layerMb),
        vramMb: entry.vramMb,
        languages: [...entry.languages],
        ptBR: entry.ptBR,
        streaming: entry.streaming,
        voices: this.voicesFor(entry, stored, whisperInstalled),
        install: {
          state: installing ? 'installing' : st,
          ...(installing && op?.progress
            ? { progress: { phase: op.progress.phase, pct: op.progress.pct } }
            : {}),
          error:
            err ??
            (st === 'broken' && !runtimeInstalling
              ? 'arquivos do motor ausentes ou runtime incompleto — reinstale'
              : null)
        },
        compat: evaluateEngineCompat(entry, probe, {
          runtimeInstalled: runtimeReady,
          layerInstalled: this.installer.layerReady(state, entry.group),
          installed: st === 'installed',
          vram: { loaded: ev.loaded, reclaimMb: ev.reclaimMb, releases: ev.releases }
        }),
        ...(m ? { measured: { ...m } } : {}),
        ...(entry.id === 'omnivoice' ? { options: { steps: this.currentSteps() } } : {}),
        vram: { loaded: ev.loaded, availMb: ev.availMb, releases: ev.releases }
      }
    })
    const procs = this.server.list()
    const serverState: GpuStatus['server']['state'] =
      procs.some((p) => p.state === 'starting') || this.warming
        ? 'starting'
        : procs.some((p) => p.state === 'running')
          ? 'running'
          : procs.some((p) => p.state === 'error')
            ? 'error'
            : 'stopped'
    const rtProg = runtimeInstalling ? (op?.rtProgress ?? null) : null
    return {
      seq,
      platform: {
        os: (['linux', 'darwin', 'win32'].includes(probe.platform.os)
          ? probe.platform.os
          : 'linux') as GpuStatus['platform']['os'],
        arch: probe.platform.arch,
        diskFreeMb: probe.platform.diskFreeMb
      },
      gpus: probe.gpus.map(({ uuid, ...g }) => ({
        ...g,
        ...(g.vendor === 'nvidia' ? { vramOwnMb: vram.ownOf(uuid ?? null) } : {})
      })),
      runtime: {
        state: runtimeInstalling ? 'installing' : runtimeState,
        version: state.runtime?.version ?? null,
        sizeMb: state.runtime?.sizeMb ?? null,
        ...(rtProg
          ? {
              progress: {
                phase: rtProg.phase,
                pct: rtProg.pct,
                ...(rtProg.bytes !== undefined ? { bytes: rtProg.bytes } : {})
              }
            }
          : {}),
        error:
          this.lastError?.target === 'runtime'
            ? this.lastError.message
            : runtimeInstalling
              ? null
              : this.installer.runtimeProblem(state),
        compat: evaluateRuntimeCompat(probe)
      },
      engines,
      server: {
        state: serverState,
        engines: [...new Set(procs.filter((p) => p.state !== 'error').flatMap((p) => p.engines))],
        error: procs.find((p) => p.state === 'error')?.error ?? null,
        phase: this.serverPhase
      }
    }
  }

  /**
   * VRAM do ponto de vista do app: quanto cada processo do servidor ocupa (`--query-compute-apps`
   * casado com os PIDs dos processos; sem número do driver → motores carregados + contexto), o que
   * já está carregado e o que seria liberado ao subir cada motor (os processos de OUTROS grupos —
   * `tts()` os para ao trocar).
   */
  private vramView(
    probe: GpuProbe,
    health: HealthMap
  ): {
    ownOf: (uuid: string | null) => number
    engine: (e: GpuEngineCatalogEntry) => {
      loaded: boolean
      reclaimMb: number
      availMb: number | null
      releases: string[]
    }
  } {
    const procs = this.server.list().filter((p) => p.state !== 'error')
    const nv = probe.gpus
      .filter((g) => g.vendor === 'nvidia')
      .reduce<GpuProbe['gpus'][number] | null>(
        (a, b) => (!a || (b.vramTotalMb ?? 0) > (a.vramTotalMb ?? 0) ? b : a),
        null
      )
    const readyIn = (group: GpuEngineGroup): string[] =>
      Object.entries(health.get(group) ?? {})
        .filter(([, v]) => v?.state === 'ready')
        .map(([k]) => k)
    const apps = probe.computeApps ?? []
    /** VRAM de um processo (MB) na melhor NVIDIA. */
    const procMb = (p: (typeof procs)[number]): number => {
      const pids = new Set(p.pids)
      const est = (): number =>
        CUDA_CONTEXT_MB +
        readyIn(p.group).reduce(
          (n, id) => n + (isGpuEngineId(id) ? gpuEngineEntry(id).vramMb : 0),
          0
        )
      const by = ownVramByGpu(apps, pids, est)
      if (!by.size) return 0
      if (nv?.uuid) return (by.get(nv.uuid) ?? 0) + (by.get('') ?? 0)
      return [...by.values()].reduce((a, b) => a + b, 0)
    }
    const perProc = procs.map((p) => ({ p, mb: procMb(p), ready: readyIn(p.group) }))
    const allPids = new Set(procs.flatMap((p) => p.pids))
    return {
      ownOf: (uuid) => {
        const by = ownVramByGpu(apps, allPids, () => 0)
        return uuid
          ? (by.get(uuid) ?? 0) + (by.get('') ?? 0)
          : [...by.values()].reduce((a, b) => a + b, 0)
      },
      engine: (e) => {
        const loaded = perProc.some((x) => x.ready.includes(e.id))
        // whisper entra no processo que já roda (nada é liberado); um motor de fala sobe o processo
        // do seu grupo e o app para os dos outros grupos
        const others =
          e.kind === 'stt' ? [] : perProc.filter((x) => x.p.group !== e.group && x.mb > 0)
        const reclaimMb = others.reduce((n, x) => n + x.mb, 0)
        const releases = [
          ...new Set(
            others.flatMap((x) =>
              x.ready.length ? x.ready.map((id) => gpuEngineShortLabel(id)) : ['servidor ocioso']
            )
          )
        ]
        const free = nv?.vramFreeMb ?? null
        return { loaded, reclaimMb, availMb: free === null ? null : free + reclaimMb, releases }
      }
    }
  }

  // ---------------- instalação ----------------

  private async runOp(
    target: 'runtime' | GpuEngineId,
    work: (op: Op) => Promise<void>
  ): Promise<void> {
    if (this.op) throw new Error('Já há uma instalação em andamento — aguarde ou cancele.')
    const withRuntime =
      target !== 'runtime' && !this.installer.runtimeReady(await this.installer.readState())
    if (this.op) throw new Error('Já há uma instalação em andamento — aguarde ou cancele.')
    const op: Op = {
      target,
      controller: new AbortController(),
      progress: null,
      withRuntime,
      rtProgress: null
    }
    this.op = op
    this.lastError = null
    this.scheduleEmit()
    try {
      await work(op)
    } catch (e) {
      if (isAbortError(e) || op.controller.signal.aborted) {
        await this.installer.log('cancelado pelo usuário')
        return
      }
      const message = e instanceof Error ? e.message : String(e)
      this.lastError = { target, message }
      throw e
    } finally {
      this.op = null
      this.probeCache = null // disco mudou
      this.scheduleEmit()
    }
  }

  private progress(op: Op): (p: InstallProgress) => void {
    return (p) => {
      op.progress = p
      this.scheduleEmit()
    }
  }

  async installRuntime(): Promise<void> {
    const compat = evaluateRuntimeCompat(await this.probe(true))
    if (compat.level === 'blocked')
      throw new Error(`Não dá para instalar: ${compat.reasons.join(' ')}`)
    await this.runOp('runtime', (op) =>
      this.installer.installRuntime(op.controller.signal, (p) => {
        op.rtProgress = p
        this.progress(op)(p)
      })
    )
  }

  async installEngine(id: unknown): Promise<void> {
    if (!isGpuEngineId(id)) throw new Error(`Motor desconhecido: ${String(id)}.`)
    const entry = gpuEngineEntry(id)
    const state = await this.installer.readState()
    const compat = evaluateEngineCompat(entry, await this.probe(true), {
      runtimeInstalled: this.installer.runtimeReady(state),
      layerInstalled: this.installer.layerReady(state, entry.group),
      installed: false
    })
    if (compat.level === 'blocked')
      throw new Error(`Não dá para instalar: ${compat.reasons.join(' ')}`)
    await this.runOp(id, async (op) => {
      await this.installer.installEngine(id, op.controller.signal, this.progress(op), (p) => {
        op.rtProgress = p
      })
      // motores que só clonam (Qwen) precisam de uma voz: a referência CC0 pt-BR vem junto
      if (entry.clones && !entry.builtinVoices.length) {
        const voices = await this.voices.list()
        if (!voices.some((v) => !entry.needsTranscript || v.transcript))
          await this.voices
            .downloadCc0(undefined, op.controller.signal)
            .catch((e: unknown) =>
              this.installer.log(
                `voz CC0 não baixada: ${e instanceof Error ? e.message : String(e)}`
              )
            )
      }
    })
    // processo do grupo rodando sem o motor novo: a próxima fala reinicia com ele
  }

  cancel(): void {
    this.op?.controller.abort()
  }

  async removeRuntime(): Promise<void> {
    if (this.op) throw new Error('Cancele a instalação em andamento antes de remover.')
    await this.server.stopAll()
    await this.installer.removeRuntime()
    this.lastError = null
    this.probeCache = null
    this.scheduleEmit()
  }

  async removeEngine(id: unknown): Promise<void> {
    if (!isGpuEngineId(id)) throw new Error(`Motor desconhecido: ${String(id)}.`)
    if (this.op) throw new Error('Cancele a instalação em andamento antes de remover.')
    const entry = gpuEngineEntry(id)
    // o processo do grupo (e o whisper que roda dentro dele) solta os arquivos antes
    if (entry.group === 'base') await this.server.stopAll()
    else await this.server.stop(entry.group)
    await this.installer.removeEngine(id)
    if (this.lastError?.target === id) this.lastError = null
    this.probeCache = null
    this.scheduleEmit()
  }

  // ---------------- servidor / endpoints ----------------

  private async installedEngines(): Promise<Set<GpuEngineId>> {
    const s = await this.installer.readState()
    return new Set(
      GPU_ENGINE_CATALOG.map((e) => e.id).filter(
        (id) => this.installer.engineState(s, id) === 'installed'
      )
    )
  }

  /** Motores de um processo do grupo: os instalados do grupo + o whisper (se instalado). */
  private groupEngines(group: GpuEngineGroup, installed: Set<GpuEngineId>): string[] {
    const out = GPU_ENGINE_CATALOG.filter(
      (e) => e.group === group && e.kind === 'tts' && installed.has(e.id)
    ).map((e) => e.id as string)
    if (installed.has(GPU_STT_ENGINE_ID)) out.push(GPU_STT_ENGINE_ID)
    return out
  }

  private async readyFor(id: GpuEngineId): Promise<void> {
    const state = await this.installer.readState()
    const entry = gpuEngineEntry(id)
    const where = 'Configurações → Áudio → Modo avançado (GPU local)'
    if (this.installer.runtimeState(state) !== 'installed')
      throw new GpuEndpointError(
        `o runtime da GPU não está instalado — instale em ${where}`,
        'config'
      )
    const st = this.installer.engineState(state, id)
    if (st !== 'installed')
      throw new GpuEndpointError(
        st === 'broken'
          ? `o motor ${entry.label} está com arquivos faltando — reinstale em ${where}`
          : `o motor ${entry.label} não está instalado — instale em ${where}`,
        'config'
      )
    const compat = evaluateEngineCompat(entry, await this.probe(), {
      runtimeInstalled: true,
      layerInstalled: true,
      installed: true
    })
    if (compat.level === 'blocked')
      throw new GpuEndpointError(
        `${entry.label} não roda neste computador: ${compat.reasons[0]}`,
        'config'
      )
  }

  private endpoint(port: number): GpuEndpoint {
    return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: this.server.token }
  }

  private async ensureGroup(group: GpuEngineGroup, engines: string[]): Promise<number> {
    try {
      return await this.server.ensure(group, engines)
    } catch (e) {
      throw new GpuEndpointError(
        `servidor da GPU não subiu: ${e instanceof Error ? e.message : String(e)}`,
        'network'
      )
    }
  }

  /**
   * Um processo por vez na GPU: ao subir o processo de um grupo, os dos OUTROS grupos (motores de
   * fala que não são o escolhido agora, o whisper avulso do grupo base) saem e devolvem a VRAM — o
   * whisper vai junto no processo novo. Processo no meio de uma síntese (`busy`) fica (sai sozinho
   * quando ocioso).
   */
  private async releaseOtherGroups(group: GpuEngineGroup): Promise<void> {
    const others = this.server.list().filter((p) => p.group !== group)
    for (const p of others) {
      if (p.state === 'running' && p.port) {
        try {
          const r = await (this.deps.server?.fetch ?? fetch)(`http://127.0.0.1:${p.port}/health`, {
            headers: { Authorization: `Bearer ${this.server.token}` },
            signal: AbortSignal.timeout(1500)
          })
          if (r.ok && ((await r.json()) as { busy?: boolean }).busy) continue
        } catch {
          /* sem resposta: para mesmo assim */
        }
      }
      this.deps.log?.(`liberando a GPU: parando o processo ${p.group} para subir ${group}`)
      await this.server.stop(p.group)
    }
  }

  /** Resolvedor da fala (usado por `voice/tts.ts` via `gpuTtsAsApi`). */
  async tts(engine: GpuTtsEngineId, opts: { steps?: number } = {}): Promise<GpuEndpoint> {
    await this.readyFor(engine)
    const entry = gpuEngineEntry(engine)
    const cur = this.server.get(entry.group)
    if (!cur || cur.state === 'error' || !cur.engines.includes(engine))
      await this.releaseOtherGroups(entry.group)
    const port = await this.ensureGroup(
      entry.group,
      this.groupEngines(entry.group, await this.installedEngines())
    )
    if (engine === 'omnivoice') {
      const steps = opts.steps ?? OMNIVOICE_DEFAULT_STEPS
      if (this.omniSteps.get(entry.group) !== steps) {
        await this.post(port, '/v1/config', { omnivoice: { steps } }).catch(() => undefined)
        this.omniSteps.set(entry.group, steps)
      }
    }
    return this.endpoint(port)
  }

  /** Resolvedor da transcrição: o processo que já roda o whisper; senão o do motor de fala escolhido; senão o base. */
  async stt(): Promise<GpuEndpoint> {
    await this.readyFor(GPU_STT_ENGINE_ID)
    const running = this.server
      .list()
      .filter((p) => p.state === 'running' && p.engines.includes(GPU_STT_ENGINE_ID))
    const tts = this.deps.getTts()
    const prefer =
      tts.backend === 'gpu' ? gpuEngineEntry((tts.gpu ?? DEFAULT_TTS_GPU).engine).group : null
    const hit = running.find((p) => p.group === prefer) ?? running[0]
    if (hit?.port) {
      await this.pushWhisperConfig(hit.group, hit.port)
      return this.endpoint(hit.port)
    }
    const installed = await this.installedEngines()
    const group: GpuEngineGroup =
      prefer && tts.gpu && installed.has(tts.gpu.engine) ? prefer : 'base'
    const port = await this.ensureGroup(group, this.groupEngines(group, installed))
    await this.pushWhisperConfig(group, port)
    return this.endpoint(port)
  }

  /** Parâmetros do whisper (beam/VAD/idioma) no processo — valem na próxima transcrição. */
  private async pushWhisperConfig(group: GpuEngineGroup, port: number): Promise<void> {
    const params = resolveGpuParams(GPU_STT_ENGINE_ID, this.deps.getStt().gpu?.params)
    const key = `${group}:${port}`
    const json = JSON.stringify(params)
    if (this.whisperCfg.get(key) === json) return
    try {
      await this.post(port, '/v1/config', { whisper: params })
      this.whisperCfg.set(key, json)
    } catch (e) {
      this.deps.log?.(
        `config do whisper não aplicada: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }

  private async post(
    port: number,
    path: string,
    body: unknown,
    timeoutMs = 10_000
  ): Promise<unknown> {
    const r = await (this.deps.server?.fetch ?? fetch)(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }

  /** Voz escolhida por motor (aquecimento: prepara a voz que a chamada vai usar). */
  private warmVoices(tts: TtsSettings = this.deps.getTts()): Record<string, string> {
    return tts.gpu?.voice ? { [tts.gpu.engine]: tts.gpu.voice } : {}
  }

  /**
   * Motores escolhidos (fala `gpu` + transcrição `gpu`): os das settings deste dispositivo, ou os de
   * `settings` (a voz efetiva da chamada — a da persona/chat, protocolo 1.9.0).
   */
  selectedEngines(settings?: { tts: TtsSettings; stt: SttSettings }): GpuEngineId[] {
    const out: GpuEngineId[] = []
    const tts = settings?.tts ?? this.deps.getTts()
    const stt = settings?.stt ?? this.deps.getStt()
    if (tts.backend === 'gpu') out.push((tts.gpu ?? DEFAULT_TTS_GPU).engine)
    if (stt.mode === 'gpu') out.push(GPU_STT_ENGINE_ID)
    return out
  }

  /**
   * Os motores pedidos já estão num processo rodando E carregados (`/health` → `ready`)? A chamada
   * usa isso para decidir se precisa da fase "Preparando a GPU…" (subir/aquecer antes do microfone).
   */
  async isWarm(ids: readonly GpuEngineId[]): Promise<boolean> {
    if (!ids.length) return true
    const running = this.server.list().filter((p) => p.state === 'running' && p.port)
    for (const id of ids) {
      const proc = running.find((p) => p.engines.includes(id))
      if (!proc?.port) return false
      try {
        const r = await (this.deps.server?.fetch ?? fetch)(`http://127.0.0.1:${proc.port}/health`, {
          headers: { Authorization: `Bearer ${this.server.token}` },
          signal: AbortSignal.timeout(2000)
        })
        if (!r.ok) return false
        const j = (await r.json()) as { engines?: Record<string, { state?: string }> }
        if (j.engines?.[id]?.state !== 'ready') return false
      } catch {
        return false
      }
    }
    return true
  }

  private setPhase(text: string | null, onPhase?: (t: string) => void): void {
    this.serverPhase = text
    if (text) onPhase?.(text)
    this.scheduleEmit()
  }

  /**
   * Sobe e AQUECE (carrega os modelos e faz uma síntese curta) os motores pedidos — padrão: os
   * escolhidos. É o "liga sozinho" do servidor: a chamada chama antes de abrir o microfone, o ditado
   * no início da gravação. `onPhase` recebe o andamento legível ("Iniciando OmniVoice…",
   * "Aquecendo OmniVoice + Whisper…"). Motor que não carregou no aquecimento (OOM, pesos
   * corrompidos) → `GpuEndpointError` legível; falha só do request de aquecimento (timeout) é
   * registrada e não impede (a 1ª fala carrega sob demanda).
   */
  async startServer(
    ids?: unknown,
    opts: {
      onPhase?: (text: string) => void
      /** Fala que vai ser usada (a da chamada — voz da persona/chat); ausente = a das settings. */
      tts?: TtsSettings
    } = {}
  ): Promise<void> {
    const list = (
      Array.isArray(ids) ? ids.filter(isGpuEngineId) : this.selectedEngines()
    ) as GpuEngineId[]
    if (!list.length)
      throw new Error('Nenhum motor da GPU escolhido — escolha "GPU local" em Fala ou Transcrição.')
    const names = gpuEnginesLabel(list)
    this.warming = true
    this.setPhase(`Iniciando ${names}…`, opts.onPhase)
    try {
      for (const id of list.filter((x) => x !== GPU_STT_ENGINE_ID)) {
        await this.tts(id as GpuTtsEngineId, { steps: this.currentSteps() })
      }
      if (list.includes(GPU_STT_ENGINE_ID)) await this.stt()
      this.setPhase(`Aquecendo ${names}…`, opts.onPhase)
      // carrega os pesos já (a 1ª fala da chamada não paga a carga)
      const failed: string[] = []
      for (const p of this.server.list())
        if (p.state === 'running' && p.port) {
          const engines = p.engines.filter((e) => (list as string[]).includes(e))
          if (!engines.length) continue
          let r: unknown
          try {
            r = await this.post(
              p.port,
              '/v1/warmup',
              { engines, wait: true, synth: true, voices: this.warmVoices(opts.tts) },
              180_000
            )
          } catch (e) {
            this.deps.log?.(`aquecimento falhou: ${e instanceof Error ? e.message : String(e)}`)
            continue
          }
          const states = (r as { engines?: Record<string, { state?: string; error?: string }> })
            ?.engines
          for (const e of engines) {
            const st = states?.[e]
            if (st?.state === 'error')
              failed.push(`${gpuEnginesLabel([e])} não carregou na GPU: ${st.error ?? 'erro'}`)
          }
        }
      if (failed.length) throw new GpuEndpointError(failed.join('; '), 'network')
    } finally {
      this.warming = false
      // modelos carregados agora: a VRAM livre e os avisos mudam
      this.invalidateLive()
      this.setPhase(null)
    }
  }

  async stopServer(): Promise<void> {
    await this.server.stopAll()
    this.invalidateLive()
    this.scheduleEmit()
  }

  /** Saída do app. */
  shutdown(): void {
    this.op?.controller.abort()
    this.server.killAllNow()
  }

  /** Para os processos quando nada mais usa a GPU (backend trocado nas settings). */
  async onSettingsChanged(): Promise<void> {
    if (this.selectedEngines().length) return
    if (this.server.list().length) await this.server.stopAll()
  }

  // ---------------- transcrição pela GPU (motor "local" injetado na sessão) ----------------

  /** `SttLocalBackend` do modo `gpu`: o whisper do servidor local pelo cliente multipart de sempre. */
  sttBackend(ready: boolean): SttLocalBackend {
    return {
      ready,
      partials: true,
      transcribe: async (input, opts) => {
        const ep = await this.stt()
        const r = await transcribeAudio(input, {
          settings: this.sttApiSettings(ep),
          language: opts.language,
          timeoutMs: opts.timeoutMs,
          signal: opts.signal
        })
        // o resultado vai ao renderer: sem a URL/porta do servidor local
        return { ...r, baseUrl: 'gpu-local' }
      }
    }
  }

  private sttApiSettings(ep: GpuEndpoint): SttSettings {
    return {
      ...DEFAULT_STT_SETTINGS,
      mode: 'api',
      api: { providerId: null, baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: GPU_STT_ENGINE_ID }
    }
  }

  /** O whisper da GPU está pronto para transcrever (runtime + motor instalados, sem bloqueio)? */
  async sttReady(): Promise<boolean> {
    try {
      await this.readyFor(GPU_STT_ENGINE_ID)
      return true
    } catch {
      return false
    }
  }

  /** Transcrição avulsa (transcrição automática da voz de clonagem na UI). */
  async transcribe(input: { audio: unknown }): Promise<{ text: string }> {
    const audio =
      input?.audio instanceof ArrayBuffer
        ? new Uint8Array(input.audio)
        : input?.audio instanceof Uint8Array
          ? input.audio
          : null
    if (!audio?.length) throw new Error('Áudio vazio.')
    const ep = await this.stt().catch((e: unknown) => {
      throw new Error(e instanceof Error ? e.message : String(e))
    })
    const r = await transcribeAudio(
      { audio, mimeType: 'audio/wav', fileName: 'voz' },
      { settings: this.sttApiSettings(ep), language: 'pt-BR', timeoutMs: 120_000 }
    )
    return { text: r.text.trim() }
  }

  /** Prontidão para `voice:runtime:status` (fala/transcrição pela GPU). */
  async readiness(): Promise<{ gpuTts: VoiceRuntimeCheck; gpuStt: VoiceRuntimeCheck }> {
    const check = async (id: GpuEngineId): Promise<VoiceRuntimeCheck> => {
      try {
        await this.readyFor(id)
        return { available: true, reason: null }
      } catch (e) {
        return { available: false, reason: e instanceof Error ? e.message : String(e) }
      }
    }
    const tts = this.deps.getTts()
    return {
      gpuTts: await check((tts.gpu ?? DEFAULT_TTS_GPU).engine),
      gpuStt: await check(GPU_STT_ENGINE_ID)
    }
  }

  // ---------------- autoteste ----------------

  async selfTest(id: unknown): Promise<GpuSelfTestResult> {
    if (!isGpuEngineId(id)) throw new Error(`Motor desconhecido: ${String(id)}.`)
    const result = id === GPU_STT_ENGINE_ID ? await this.selfTestStt() : await this.selfTestTts(id)
    this.deps.writeMeasured(id, { ...result, at: new Date().toISOString() })
    this.invalidateLive()
    this.scheduleEmit()
    return result
  }

  private ttsSettingsFor(id: GpuTtsEngineId): TtsSettings {
    const cur = this.deps.getTts()
    const voice = cur.gpu?.engine === id ? cur.gpu.voice : null
    return {
      backend: 'gpu',
      api: { ...DEFAULT_TTS_API },
      local: null,
      // os parâmetros de AGORA (o "Testar" do card mede com eles)
      gpu: {
        engine: id,
        voice,
        steps: this.currentSteps(),
        ...(cur.gpu?.params ? { params: cur.gpu.params } : {})
      }
    }
  }

  /** Sintetiza pelo caminho do app (synthesizeStream) e mede 1º áudio, total e duração. */
  private async synthMeasure(
    id: GpuTtsEngineId,
    text: string
  ): Promise<{ firstMs: number; totalMs: number; durS: number; wav: Uint8Array }> {
    const t0 = Date.now()
    const r = await synthesizeStream({ text, settings: this.ttsSettingsFor(id) })
    if (!r.streaming) {
      const totalMs = Date.now() - t0
      const pcmBytes = Math.max(0, r.result.audio.length - 44)
      return { firstMs: totalMs, totalMs, durS: pcmBytes / 2 / 24000, wav: r.result.audio }
    }
    let first: number | null = null
    const parts: Uint8Array[] = []
    let n = 0
    for await (const c of r.chunks) {
      if (first === null) first = Date.now() - t0
      parts.push(c)
      n += c.length
    }
    const totalMs = Date.now() - t0
    const pcm = new Uint8Array(n)
    let o = 0
    for (const p of parts) {
      pcm.set(p, o)
      o += p.length
    }
    return {
      firstMs: first ?? totalMs,
      totalMs,
      durS: n / 2 / r.sampleRate,
      wav: encodeWav(pcm, r.sampleRate)
    }
  }

  private async selfTestTts(id: GpuTtsEngineId): Promise<GpuSelfTestResult> {
    // 1ª síntese aquece (carga do modelo/voz); a 2ª é a medida
    await this.synthMeasure(id, 'Olá.')
    const m = await this.synthMeasure(id, GPU_SELFTEST_PHRASE)
    const out: GpuSelfTestResult = {
      firstAudioMs: m.firstMs,
      rtf: m.durS > 0 ? Math.round((m.totalMs / 1000 / m.durS) * 1000) / 1000 : 0
    }
    if (await this.sttReady()) {
      try {
        const ep = await this.stt()
        const t = await transcribeAudio(
          { audio: m.wav, mimeType: 'audio/wav', fileName: 'autoteste' } as TranscribeAudioInput,
          { settings: this.sttApiSettings(ep), language: 'pt-BR', timeoutMs: 120_000 }
        )
        out.wer = wordErrorRate(GPU_SELFTEST_PHRASE, t.text)
      } catch (e) {
        this.deps.log?.(
          `autoteste: transcrição de volta falhou: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }
    return out
  }

  private async selfTestStt(): Promise<GpuSelfTestResult> {
    // áudio de teste: a voz CC0 (fala humana, transcrição conhecida)
    const cc0 = GPU_CC0_VOICES[0]
    await this.voices.downloadCc0(cc0.id)
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const audio = new Uint8Array(await readFile(join(this.voices.root, cc0.id, 'source.mp3')))
    const ep = await this.stt()
    const run = async (): Promise<{ ms: number; text: string }> => {
      const t0 = Date.now()
      const r = await transcribeAudio(
        { audio, mimeType: 'audio/mpeg', fileName: 'autoteste' },
        { settings: this.sttApiSettings(ep), language: 'pt-BR', timeoutMs: 120_000 }
      )
      return { ms: Date.now() - t0, text: r.text }
    }
    await run() // carga do modelo
    const r = await run()
    return {
      firstAudioMs: r.ms,
      rtf: Math.round((r.ms / 1000 / cc0.durationS) * 1000) / 1000,
      // o whisper escreve números com algarismos ("78%")
      wer: wordErrorRate(cc0.transcript.replace('setenta e oito', '78'), r.text)
    }
  }

  // ---------------- vozes ----------------

  async addUserVoice(input: {
    name: unknown
    audio: unknown
    transcript?: unknown
  }): Promise<{ id: string }> {
    const r = await this.voices.addUser(input ?? {})
    this.scheduleEmit()
    return r
  }

  async removeUserVoice(id: unknown): Promise<void> {
    await this.voices.remove(id)
    this.scheduleEmit()
  }

  async downloadCc0Voice(input?: { id?: unknown }): Promise<{ id: string }> {
    const r = await this.voices.downloadCc0(input?.id)
    this.scheduleEmit()
    return r
  }

  // ---------------- log ----------------

  async logText(): Promise<string> {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const parts = [`== install.log ==\n${await this.installer.logTail(150)}`]
    for (const g of ['base', 'xtts', 'qwen', 'omni', 'vibe']) {
      try {
        const t = (await readFile(join(this.installer.layout.logs, `server-${g}.log`), 'utf8'))
          .split('\n')
          .slice(-60)
          .join('\n')
        if (t.trim()) parts.push(`== servidor ${g} ==\n${t}`)
      } catch {
        /* sem log */
      }
    }
    return parts.join('\n\n')
  }
}
