// O ÚNICO jeito de iniciar o Electron nos testes E2E (app real ou build do mock). Garante, antes de
// qualquer janela carregar, que o microfone real nunca é aberto — ver `micGuard.cjs`:
//   - `-r e2e/micGuard.cjs` no main (permissão `media` negada em toda sessão, mesmo se o app trocar o
//     handler) + os switches do dispositivo falso do Chromium, também na linha de comando;
//   - confere no main, logo depois de subir, que a guarda está no defaultSession e os switches valem
//     (senão fecha o app e falha).
// `micGuard.test.ts` reprova qualquer spec que chame `_electron.launch` direto; `mic-guard.spec.ts`
// prova no app e no mock que getUserMedia é recusado (ou, no modo `fake`, só vê o dispositivo falso).
import { _electron as electron, type ElectronApplication } from 'playwright'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const APP_ROOT = resolve(import.meta.dirname, '..')
export const MIC_GUARD = resolve(import.meta.dirname, 'micGuard.cjs')

/**
 * `deny` (padrão): getUserMedia sempre recusado. `fake`: só para specs do mock que precisam de uma
 * captura funcionando — o Chromium entrega o dispositivo falso (tom), nunca o hardware.
 */
export type MicMode = 'deny' | 'fake'

export interface LaunchOptions {
  /** Argumentos do Electron: o app (`APP_ROOT`) ou o main do mock, mais switches extras. */
  args?: string[]
  env?: Record<string, string | undefined>
  timeout?: number
  cwd?: string
  /** App empacotado (sem default_app): a guarda entra por `evaluate` logo depois de subir. */
  executablePath?: string
  mic?: MicMode
}

/**
 * Switches do Chromium que trocam o microfone/câmera pelo dispositivo falso — e `--mute-audio`:
 * nenhum teste toca som nos alto-falantes (o áudio continua sendo processado, só não sai).
 */
export function fakeMediaSwitches(mic: MicMode = 'deny'): string[] {
  return [
    '--mute-audio',
    '--use-fake-device-for-media-stream',
    mic === 'fake' ? '--use-fake-ui-for-media-stream' : '--use-fake-ui-for-media-stream=deny'
  ]
}

/** Pastas de dados reais do app — um teste nunca roda com elas. */
function realUserDataDirs(): string[] {
  const h = homedir()
  return ['ClearChat', 'CleartChat'].flatMap((n) => [
    join(h, '.config', n),
    join(h, 'Library', 'Application Support', n)
  ])
}

function assertIsolatedUserData(env: Record<string, string>): void {
  const dir = env.CLEARCHAT_USER_DATA
  if (!dir) throw new Error('launch: o app real precisa de CLEARCHAT_USER_DATA (pasta isolada)')
  const abs = resolve(dir)
  for (const real of realUserDataDirs())
    if (abs === real || abs.startsWith(real + sep))
      throw new Error(`launch: CLEARCHAT_USER_DATA aponta para os dados reais (${abs})`)
}

/** Confere no main que a guarda do microfone está instalada e os switches valem. */
export async function assertMicGuard(app: ElectronApplication, mic: MicMode): Promise<void> {
  const st = await app.evaluate(({ app: a, session }) => {
    const g = (globalThis as { __clearchatMicGuard?: any }).__clearchatMicGuard // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      installed: !!g,
      mode: g?.mode as string | undefined,
      defaultSession: !!g?.isGuarded(session.defaultSession),
      fakeDevice: a.commandLine.hasSwitch('use-fake-device-for-media-stream'),
      muted: a.commandLine.hasSwitch('mute-audio'),
      fakeUi: a.commandLine.hasSwitch('use-fake-ui-for-media-stream')
        ? a.commandLine.getSwitchValue('use-fake-ui-for-media-stream')
        : null
    }
  })
  const problems: string[] = []
  if (!st.installed) problems.push('guarda não carregou no main')
  if (st.mode !== mic) problems.push(`modo ${st.mode} ≠ ${mic}`)
  if (!st.defaultSession) problems.push('defaultSession sem a guarda')
  if (!st.fakeDevice) problems.push('sem --use-fake-device-for-media-stream')
  if (!st.muted) problems.push('sem --mute-audio')
  if (st.fakeUi === null || (mic === 'deny' && st.fakeUi !== 'deny'))
    problems.push(`--use-fake-ui-for-media-stream=${st.fakeUi}`)
  if (problems.length) throw new Error(`guarda do microfone: ${problems.join('; ')}`)
}

/**
 * Inicia o Electron com a guarda do microfone. `env` padrão: o do processo; `ELECTRON_RUN_AS_NODE`
 * sai sempre. Iniciar o app real (`APP_ROOT` ou `executablePath`) exige `CLEARCHAT_USER_DATA`
 * isolado.
 */
export async function launchElectron(opts: LaunchOptions = {}): Promise<ElectronApplication> {
  const mic = opts.mic ?? 'deny'
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  env.CLEARCHAT_E2E_MIC = mic
  const userArgs = opts.args ?? []
  if (opts.executablePath || userArgs.some((a) => resolve(a) === APP_ROOT))
    assertIsolatedUserData(env)
  const base = { env, timeout: opts.timeout ?? 60_000, ...(opts.cwd ? { cwd: opts.cwd } : {}) }
  let app: ElectronApplication
  if (opts.executablePath) {
    app = await electron.launch({
      ...base,
      executablePath: opts.executablePath,
      args: [...fakeMediaSwitches(mic), ...userArgs]
    })
    const { install } = createRequire(import.meta.url)('./micGuard.cjs') as {
      install: (...a: unknown[]) => unknown
    }
    await app.evaluate(
      (electronMod, [src, mode]) => {
        ;(0, eval)(`(${src})`)(electronMod, mode)
      },
      [install.toString(), mic] as const
    )
  } else {
    app = await electron.launch({
      ...base,
      args: ['-r', MIC_GUARD, ...fakeMediaSwitches(mic), ...userArgs]
    })
  }
  try {
    await assertMicGuard(app, mic)
  } catch (e) {
    await app.close().catch(() => {})
    throw e
  }
  return app
}
