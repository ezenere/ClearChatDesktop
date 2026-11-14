// Guarda do microfone dos testes E2E (`e2e/launch.ts` + `e2e/micGuard.cjs`), sem Electron:
//   - nenhum arquivo de e2e/ (nem scripts/) inicia o Electron por fora do launch.ts — quem chamar
//     `_electron.launch` direto (sem a guarda) reprova aqui;
//   - a guarda com um Electron falso: switches do dispositivo falso antes do ready, mídia negada em
//     toda sessão (pedido e consulta), handler instalado depois pelo app embrulhado, modo `fake`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { fakeMediaSwitches } from './launch.ts'

const ROOT = resolve(import.meta.dirname, '..')
const E2E = join(ROOT, 'e2e')
/** Os únicos arquivos que podem falar do `_electron` do Playwright. */
const ALLOWED = new Set(['e2e/launch.ts', 'e2e/micGuard.test.ts'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === 'node_modules') return []
    if (statSync(p).isDirectory()) return walk(p)
    return /\.(ts|mts|cts|js|mjs|cjs)$/.test(n) ? [p] : []
  })
}

test('nenhum spec inicia o Electron sem o launch.ts (guarda do microfone)', () => {
  const files = [...walk(E2E), ...walk(join(ROOT, 'scripts'))]
  assert(files.length > 50, 'varredura achou os specs')
  const bad: string[] = []
  for (const f of files) {
    const rel = relative(ROOT, f)
    if (ALLOWED.has(rel)) continue
    const src = readFileSync(f, 'utf8')
    const hits = [
      /\b_electron\b/.test(src) && '`_electron` do Playwright',
      /\belectron\s*\.\s*launch\s*\(/.test(src) && '`electron.launch(`',
      /electron\/dist\/electron|\.bin\/electron\b|require\(['"]electron\/index(\.js)?['"]\)/.test(
        src
      ) && 'binário do Electron',
      // no Node, `import … from 'electron'` é o caminho do binário (para um spawn); o
      // `require('electron')` dos mains do mock (texto que roda DENTRO do Electron) não conta
      /^\s*import\b[^\n]*\bfrom\s+['"]electron['"]/m.test(src) && "import de 'electron'"
    ].filter(Boolean)
    if (hits.length) bad.push(`${rel}: ${hits.join(', ')}`)
  }
  assert.deepEqual(bad, [], `use launchElectron de e2e/launch.ts:\n${bad.join('\n')}`)
})

test('specs que sobem o Electron usam launchElectron de ./launch.ts', () => {
  const specs = walk(E2E).filter((f) => /\.spec\.ts$|live-host\.ts$/.test(f))
  const missing = specs.filter((f) => {
    const src = readFileSync(f, 'utf8')
    return /launchElectron\(/.test(src) && !/from '\.\/launch\.ts'/.test(src)
  })
  assert.deepEqual(
    missing.map((f) => relative(ROOT, f)),
    []
  )
})

test('fakeMediaSwitches: sem som e dispositivo falso sempre; UI falsa nega no modo deny', () => {
  assert.deepEqual(fakeMediaSwitches(), [
    '--mute-audio',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream=deny'
  ])
  assert.deepEqual(fakeMediaSwitches('fake'), [
    '--mute-audio',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream'
  ])
})

// ---------------- a guarda com um Electron falso ----------------

type ReqHandler = (wc: unknown, p: string, cb: (ok: boolean) => void, d?: unknown) => void
type CheckHandler = (wc: unknown, p: string, origin: string, d?: unknown) => boolean

interface FakeSession {
  req: ReqHandler | null
  check: CheckHandler | null
  setPermissionRequestHandler(h: ReqHandler | null): void
  setPermissionCheckHandler(h: CheckHandler | null): void
}

function fakeSession(): FakeSession {
  const s: FakeSession = {
    req: null,
    check: null,
    setPermissionRequestHandler(h) {
      s.req = h
    },
    setPermissionCheckHandler(h) {
      s.check = h
    }
  }
  return s
}

function fakeElectron(): {
  electron: unknown
  switches: Map<string, string>
  defaultSession: FakeSession
  emit: (ev: string, ...a: unknown[]) => void
} {
  const switches = new Map<string, string>()
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
  let ready = false
  const defaultSession = fakeSession()
  const add = (ev: string, fn: (...a: unknown[]) => void): void => {
    listeners.set(ev, [...(listeners.get(ev) ?? []), fn])
  }
  const app = {
    isReady: () => ready,
    commandLine: { appendSwitch: (k: string, v = '') => switches.set(k, v) },
    on: add,
    once: (ev: string, fn: (...a: unknown[]) => void) => {
      const once = (...a: unknown[]): void => {
        listeners.set(
          ev,
          (listeners.get(ev) ?? []).filter((f) => f !== once)
        )
        fn(...a)
      }
      add(ev, once)
    }
  }
  const emit = (ev: string, ...a: unknown[]): void => {
    if (ev === 'ready') ready = true
    for (const fn of [...(listeners.get(ev) ?? [])]) fn(...a)
  }
  return { electron: { app, session: { defaultSession } }, switches, defaultSession, emit }
}

const { install } = createRequire(import.meta.url)('./micGuard.cjs') as {
  install: (electron: unknown, mode: string | undefined) => { mode: string; requests: unknown[] }
}

function fresh(mode: string | undefined): ReturnType<typeof fakeElectron> & {
  state: { mode: string; requests: unknown[] }
} {
  delete (globalThis as { __clearchatMicGuard?: unknown }).__clearchatMicGuard
  const f = fakeElectron()
  return { ...f, state: install(f.electron, mode) }
}

const ask = (s: FakeSession, permission: string): boolean => {
  let got: boolean | null = null
  s.req!(null, permission, (ok) => (got = ok), { mediaTypes: ['audio'] })
  assert.notEqual(got, null, `${permission}: callback não chamado`)
  return got!
}

test('guarda (deny): switches antes do ready, mídia negada no defaultSession e em sessões novas', () => {
  const f = fresh(undefined)
  assert.equal(f.state.mode, 'deny')
  assert.equal(f.switches.get('use-fake-device-for-media-stream'), '')
  assert.equal(f.switches.get('use-fake-ui-for-media-stream'), 'deny')
  assert.equal(f.defaultSession.req, null, 'nada antes do ready')
  f.emit('ready')
  assert.equal(ask(f.defaultSession, 'media'), false)
  assert.equal(ask(f.defaultSession, 'notifications'), true, 'o resto segue o padrão do Electron')
  assert.equal(f.defaultSession.check!(null, 'media', 'file://'), false)
  assert.equal(f.defaultSession.check!(null, 'clipboard-sanitized-write', 'file://'), true)
  assert.equal(f.state.requests.length, 1)
  const part = fakeSession()
  f.emit('session-created', part)
  assert.equal(ask(part, 'media'), false)
  assert.equal(part.check!(null, 'media', 'file://'), false)
})

test('guarda: handler que o app instala depois não libera a mídia', () => {
  const f = fresh('deny')
  f.emit('ready')
  const s = f.defaultSession
  s.setPermissionRequestHandler((_wc, _p, cb) => cb(true))
  s.setPermissionCheckHandler(() => true)
  assert.equal(ask(s, 'media'), false)
  assert.equal(s.check!(null, 'media', 'file://'), false)
  assert.equal(ask(s, 'notifications'), true, 'o handler do app vale para o resto')
  s.setPermissionRequestHandler((_wc, _p, cb) => cb(false))
  assert.equal(ask(s, 'notifications'), false)
  s.setPermissionRequestHandler(null)
  assert.equal(ask(s, 'media'), false)
  assert.equal(ask(s, 'notifications'), true)
})

test('guarda (fake): UI falsa aceita, mídia concedida — só o dispositivo falso existe', () => {
  const f = fresh('fake')
  assert.equal(f.state.mode, 'fake')
  assert.equal(f.switches.get('use-fake-device-for-media-stream'), '')
  assert.equal(f.switches.get('use-fake-ui-for-media-stream'), '')
  f.emit('ready')
  assert.equal(ask(f.defaultSession, 'media'), true)
  assert.equal(fresh('qualquer').state.mode, 'deny', 'valor desconhecido = deny')
})

test('guarda: instalada com o app já pronto (executablePath) guarda o defaultSession na hora', () => {
  delete (globalThis as { __clearchatMicGuard?: unknown }).__clearchatMicGuard
  const f = fakeElectron()
  f.emit('ready')
  install(f.electron, 'deny')
  assert.equal(f.switches.size, 0, 'switches só antes do ready (aí vêm da linha de comando)')
  assert.equal(ask(f.defaultSession, 'media'), false)
  delete (globalThis as { __clearchatMicGuard?: unknown }).__clearchatMicGuard
})
