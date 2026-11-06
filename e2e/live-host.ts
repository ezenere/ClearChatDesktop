/* eslint-disable @typescript-eslint/no-explicit-any */
// Desktop HOST de teste para o ponta a ponta de outros clientes (celular, site) contra o servidor de
// sync REAL local (ClearChatWebsite/backend/scripts/dev-server.sh): cria (ou reusa) uma conta, abre
// uma instância do app com userData isolado, entra, cria um provedor OpenAI-compatible FALSO (nada
// de API paga), um chat "Só ao vivo" e um chat online, e fica rodando até Ctrl+C. Imprime e-mail,
// senha e os ids.
//
// O modelo falso responde "ok: <texto>" aos poucos (deltas visíveis no stream); mensagem que começa
// com "rode " pede a tool `shell` (`echo ok-do-host`) — aprovação pendente no host (§22/§23.7).
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE; npx electron-vite build
//   CLEARCHAT_SYNC_TEST_URL=http://127.0.0.1:8123 CLEARCHAT_SYNC_TEST_MAIL_LOG=/caminho/dev-server.log \
//     CLEARCHAT_E2E_DIR=/algum/dir [CLEARCHAT_LIVE_EMAIL=… CLEARCHAT_LIVE_PASSWORD=…] node e2e/live-host.ts
//   (CLEARCHAT_LIVE_EMAIL de uma conta que já existe: só entra; sem ele, cadastra uma conta nova.)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  aadWrap,
  b64u,
  deriveSubkeys,
  keyProof,
  passwordKek,
  recoveryKek,
  wrapDek
} from '../docs/test-vectors/generate.ts'

const URL_ = process.env.CLEARCHAT_SYNC_TEST_URL
const MAIL_LOG = process.env.CLEARCHAT_SYNC_TEST_MAIL_LOG
if (!URL_ || !MAIL_LOG) {
  console.error('defina CLEARCHAT_SYNC_TEST_URL e CLEARCHAT_SYNC_TEST_MAIL_LOG')
  process.exit(2)
}
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-live-host'))
const EXISTING = !!process.env.CLEARCHAT_LIVE_EMAIL
const EMAIL = process.env.CLEARCHAT_LIVE_EMAIL || `host-${Date.now()}@teste.dev`
const PASSWORD = process.env.CLEARCHAT_LIVE_PASSWORD || 'senha do host ao vivo'
const NAME = process.env.CLEARCHAT_DEVICE_NAME || 'PC (host ao vivo)'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms: number,
  what: string
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando: ${what}`)
    await sleep(200)
  }
}

const lines = (): number => readFileSync(MAIL_LOG!, 'utf8').split('\n').length - 1
async function codeFor(after: number): Promise<string> {
  return waitFor(
    async () => {
      let code = ''
      for (const l of readFileSync(MAIL_LOG!, 'utf8').split('\n').slice(after)) {
        const m = new RegExp(
          `para ${EMAIL.replace(/[.+]/g, '\\$&')} — Seu código ClearChat: (\\d{6})`
        ).exec(l)
        if (m) code = m[1]
      }
      return code
    },
    20_000,
    'código no log do servidor'
  )
}

async function rest(method: string, path: string, body?: unknown, token?: string): Promise<any> {
  const r = await fetch(URL_ + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`${path} → ${r.status} ${t}`)
  return t ? JSON.parse(t) : null
}

/** Cadastro + chaves como o site faz (a DEK nunca sai deste processo). */
async function signup(): Promise<void> {
  const n0 = lines()
  await rest('POST', '/api/v1/auth/signup/start', { email: EMAIL, name: 'Host ao vivo' })
  const auth = await rest('POST', '/api/v1/auth/signup/verify', {
    email: EMAIL,
    code: await codeFor(n0),
    device: { name: 'site', platform: 'web', client: 'web', app_version: 't', can_host: false }
  })
  const dek = new Uint8Array(randomBytes(32))
  const uid = auth.user.id
  const kdf = { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 }
  const salt = new Uint8Array(randomBytes(16))
  const rsalt = new Uint8Array(randomBytes(16))
  await rest(
    'POST',
    '/api/v1/keys/setup',
    {
      password: {
        kdf,
        salt: b64u(salt),
        wrap: wrapDek(
          await passwordKek(PASSWORD, salt, kdf),
          dek,
          aadWrap(uid, 'password'),
          new Uint8Array(randomBytes(12))
        )
      },
      recovery: {
        kdf: { alg: 'hkdf-sha256' },
        salt: b64u(rsalt),
        wrap: wrapDek(
          recoveryKek(new Uint8Array(randomBytes(20)), rsalt),
          dek,
          aadWrap(uid, 'recovery'),
          new Uint8Array(randomBytes(12))
        )
      },
      verifier: keyProof(deriveSubkeys(dek)).verifier
    },
    auth.access_token
  )
}

let llm: Server
let llmBase = ''
async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    void (async () => {
      let d = ''
      for await (const c of req) d += c
      if ((req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: 'fake/agent', context_length: 64000, supported_parameters: ['tools'] }]
          })
        )
        return
      }
      const body = JSON.parse(d || '{}')
      const msgs: any[] = body.messages ?? []
      const textOf = (c: any): string =>
        typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      const last = msgs[msgs.length - 1]
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const ch = (delta: any, f?: string): string =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(f ? { finish_reason: f } : {}) }], ...(f ? { usage: { prompt_tokens: 20, completion_tokens: 5 } } : {}) })}\n\n`
      if (last?.role === 'tool') {
        res.end(
          ch({ role: 'assistant', content: `FIM: ${textOf(last.content).slice(0, 40)}` }) +
            ch({}, 'stop') +
            'data: [DONE]\n\n'
        )
        return
      }
      if (/^rode /.test(lastUser)) {
        res.end(
          ch({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now()}`,
                type: 'function',
                function: {
                  name: 'shell',
                  arguments: JSON.stringify({ command: 'echo ok-do-host' })
                }
              }
            ]
          }) +
            ch({}, 'tool_calls') +
            'data: [DONE]\n\n'
        )
        return
      }
      for (const w of `ok: ${lastUser.slice(0, 80)}`.split(/(?<= )/)) {
        if (res.destroyed) return
        res.write(ch({ role: 'assistant', content: w }))
        await sleep(120)
      }
      res.end(ch({}, 'stop') + 'data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`
}

async function main(): Promise<void> {
  mkdirSync(BASE, { recursive: true })
  await startLlm()
  if (!EXISTING) await signup()
  const dir = join(BASE, 'host')
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  Object.assign(env, {
    CLEARCHAT_USER_DATA: dir,
    CLEARCHAT_SYNC_URL: URL_,
    CLEARCHAT_SYNC_FAST: '1',
    CLEARCHAT_DEVICE_NAME: NAME
  })
  const app: ElectronApplication = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'host.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  const page: Page = await app.firstWindow()
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  const api = <T = any>(path: string, ...args: unknown[]): Promise<T> =>
    page.evaluate(
      ([p, a]) =>
        (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)(
          ...(a as unknown[])
        ),
      [path, args] as const
    ) as Promise<T>
  const st = await api('sync.status')
  if (st.phase !== 'ready') {
    const n = lines()
    await api('sync.requestCode', EMAIL)
    await api('sync.verifyCode', EMAIL, await codeFor(n))
    await api('sync.unlock', PASSWORD, true)
  }
  await waitFor(async () => (await api('sync.status')).phase === 'ready', 30_000, 'conta pronta')
  await waitFor(
    async () => (await api('sync.status')).live?.supported,
    20_000,
    'servidor com chats ao vivo'
  )
  const providers = await api<any[]>('providers.list')
  const provider =
    providers.find((p) => p.name === 'LLM falso (host)') ??
    (await api('providers.create', {
      name: 'LLM falso (host)',
      baseUrl: llmBase,
      apiKey: 'sk-fake'
    }))
  if (provider.baseUrl !== llmBase) await api('providers.update', provider.id, { baseUrl: llmBase })
  const cwd = join(BASE, 'raiz-do-chat')
  mkdirSync(cwd, { recursive: true })
  const cfg = { providerId: provider.id, model: 'fake/agent', cwd, enabledTools: ['shell'] }
  const chats = await api<any[]>('chats.list')
  const hosts = await api<any[]>('sync.chatStates')
  let live = chats.find((c) => hosts.find((h) => h.chatId === c.id)?.live?.role === 'host')
  if (!live) {
    live = await api('chats.create', {
      title: 'Chat só ao vivo do PC',
      storage: 'live',
      config: cfg
    })
    await api('agent.send', live.mainSessionId, 'primeira mensagem do host')
  }
  let online = chats.find((c) => c.title === 'Chat online do PC')
  if (!online)
    online = await api('chats.create', {
      title: 'Chat online do PC',
      storage: 'online',
      config: cfg
    })
  const s = await api('sync.status')
  console.log(
    JSON.stringify(
      {
        server: URL_,
        email: EMAIL,
        password: PASSWORD,
        hostDeviceId: s.device?.id,
        hostName: NAME,
        liveChat: { id: live.id, mainSessionId: live.mainSessionId },
        onlineChat: { id: online.id, mainSessionId: online.mainSessionId },
        llm: llmBase
      },
      null,
      2
    )
  )
  console.log('host pronto — Ctrl+C para fechar (o chat ao vivo some dos outros na hora)')
  const stop = async (): Promise<void> => {
    await app.close().catch(() => {})
    llm.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
  app.on('close', () => {
    llm.close()
    process.exit(0)
  })
}

main().catch((e) => {
  console.error('✖', e?.message ?? e)
  process.exit(1)
})
