/* eslint-disable @typescript-eslint/no-explicit-any */
// Fumaça com DUAS instâncias reais do app contra o servidor de sync REAL (../ClearChatWebsite):
// cadastro + chaves (como o site), login por código nos dois apps, provedor sincronizado, chat
// executado no host e mensagem enviada do outro app como controle remoto (executada no host, com
// o modelo falso local). Sai com 0 (pulado) sem CLEARCHAT_SYNC_TEST_URL.
//
// Chats só ao vivo (§23, servidor ≥ 1.8.0): chat ao vivo em A aparece em B, B abre (histórico de A),
// envia com anexo (attach.put), A executa, B recebe; conversões ao vivo ⇄ online; A fecha → some.
// Com CLEARCHAT_SYNC_TEST_PSQL (comando que roda SQL no banco do servidor, ex.
// `docker --context desktop-linux exec -i clearchat-backend-pytest psql -U postgres -d clearchat_dev -tA`)
// confere que o banco não tem nenhuma linha do chat ao vivo.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE; npm run build
//   CLEARCHAT_SYNC_TEST_URL=http://127.0.0.1:8100 CLEARCHAT_SYNC_TEST_MAIL_LOG=/caminho/api.log \
//     [CLEARCHAT_SYNC_TEST_PSQL="docker … psql … -tA"] CLEARCHAT_E2E_DIR=/tmp/x node e2e/sync-real.spec.ts
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { createWriteStream, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  aadWrap,
  b64u,
  deriveSubkeys,
  keyProof,
  passwordKek,
  recoveryKek,
  wrapDek
} from '../docs/test-vectors/generate.ts'
import { randomBytes } from 'node:crypto'
import { execSync } from 'node:child_process'

const URL_ = process.env.CLEARCHAT_SYNC_TEST_URL
const MAIL_LOG = process.env.CLEARCHAT_SYNC_TEST_MAIL_LOG
if (!URL_ || !MAIL_LOG) {
  console.log('pulado: defina CLEARCHAT_SYNC_TEST_URL e CLEARCHAT_SYNC_TEST_MAIL_LOG')
  process.exit(0)
}
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-sync-real-e2e'))
const EMAIL = `app-${Date.now()}@teste.dev`
const PASSWORD = 'senha de integração do app'
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
    await sleep(150)
  }
}

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
    15_000,
    'código'
  )
}
const lines = (): number => readFileSync(MAIL_LOG!, 'utf8').split('\n').length - 1

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

let llm: Server
let llmBase = ''
async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    void (async () => {
      let d = ''
      for await (const c of req) d += c
      if ((req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'fake/agent' }] }))
        return
      }
      const body = JSON.parse(d || '{}')
      const last = [...(body.messages ?? [])].reverse().find((m: any) => m.role === 'user')
      const text =
        typeof last?.content === 'string'
          ? last.content
          : (last?.content ?? []).map((p: any) => p.text ?? '').join('')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const ch = (delta: any, f?: string): string =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(f ? { finish_reason: f } : {}) }], ...(f ? { usage: { prompt_tokens: 5, completion_tokens: 2 } } : {}) })}\n\n`
      res.write(ch({ role: 'assistant', content: `ok: ${text.slice(0, 40)}` }))
      res.end(ch({}, 'stop') + 'data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`
}

interface Inst {
  app: ElectronApplication
  page: Page
}
async function launch(name: string): Promise<Inst> {
  const dir = join(BASE, name.replace(/\W+/g, '_'))
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  Object.assign(env, {
    CLEARCHAT_USER_DATA: dir,
    CLEARCHAT_SYNC_URL: URL_,
    CLEARCHAT_SYNC_FAST: '1',
    CLEARCHAT_DEVICE_NAME: name
  })
  const app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, `${name.replace(/\W+/g, '_')}.log`))
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  return { app, page }
}
const api = <T = any>(i: Inst, path: string, ...args: unknown[]): Promise<T> =>
  i.page.evaluate(
    ([p, a]) =>
      (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)(
        ...(a as unknown[])
      ),
    [path, args] as const
  ) as Promise<T>

async function login(i: Inst): Promise<void> {
  const n = lines()
  await api(i, 'sync.requestCode', EMAIL)
  await api(i, 'sync.verifyCode', EMAIL, await codeFor(n))
  await api(i, 'sync.unlock', PASSWORD, true)
}
const ready = (i: Inst): Promise<any> =>
  waitFor(
    async () => {
      const s = await api(i, 'sync.status')
      return s.phase === 'ready' && s.pending === 0 && s.connection === 'online' && s
    },
    30_000,
    'sincronizado'
  )
const texts = async (i: Inst, sid: string): Promise<string[]> =>
  (await api<any[]>(i, 'sessions.messages', sid)).map((m) =>
    typeof m.message.content === 'string' ? m.message.content : ''
  )

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  await startLlm()
  // cadastro + chaves como o site
  const n0 = lines()
  await rest('POST', '/api/v1/auth/signup/start', { email: EMAIL, name: 'App real' })
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
  const A = await launch('PC real')
  const B = await launch('Notebook real')
  try {
    await login(A)
    await ready(A)
    const provider = await api(A, 'providers.create', {
      name: 'LLM falso',
      baseUrl: llmBase,
      apiKey: 'k'
    })
    const chat = await api(A, 'chats.create', {
      title: 'Chat no servidor real',
      storage: 'online',
      config: { providerId: provider.id, model: 'fake/agent', cwd: BASE, enabledTools: [] }
    })
    await api(A, 'agent.send', chat.mainSessionId, 'olá do PC')
    await waitFor(
      async () => (await texts(A, chat.mainSessionId)).includes('ok: olá do PC'),
      15_000,
      'A respondeu'
    )
    await ready(A)
    console.log('✔ A: login, provedor, chat executado')
    await login(B)
    await ready(B)
    const provs = await api<any[]>(B, 'providers.list')
    if (!provs.some((p) => p.id === provider.id)) throw new Error('B não recebeu o provedor')
    await waitFor(
      async () => (await texts(B, chat.mainSessionId)).includes('ok: olá do PC'),
      15_000,
      'B recebeu o chat'
    )
    console.log('✔ B: login, provedor e chat baixados')
    await waitFor(
      async () =>
        (await api<any[]>(B, 'sync.chatStates')).find((h) => h.chatId === chat.id)?.mode ===
        'remote',
      15_000,
      'B controle remoto'
    )
    await api(B, 'sync.setActiveChat', chat.id)
    await api(B, 'agent.send', chat.mainSessionId, 'do notebook')
    await waitFor(
      async () => (await texts(A, chat.mainSessionId)).includes('ok: do notebook'),
      20_000,
      'host executou o envio remoto'
    )
    await waitFor(
      async () => (await texts(B, chat.mainSessionId)).includes('ok: do notebook'),
      20_000,
      'B recebeu a resposta'
    )
    console.log('✔ envio remoto de B executado no host A e resposta sincronizada')
    // ---------------- chats só ao vivo (§23) ----------------
    const PSQL = process.env.CLEARCHAT_SYNC_TEST_PSQL
    const dbRows = (chatId: string): number | null => {
      if (!PSQL) return null
      if (!/^[0-9a-f-]{36}$/.test(chatId)) throw new Error('id inválido')
      const sql =
        `SELECT (SELECT count(*) FROM records WHERE id = '${chatId}' OR scope_id = '${chatId}') + ` +
        `(SELECT count(*) FROM chat_states WHERE chat_id = '${chatId}');`
      return Number(execSync(PSQL, { input: sql, encoding: 'utf8' }).trim())
    }
    const tombOnly = (chatId: string): boolean | null => {
      if (!PSQL) return null
      const sql =
        `SELECT string_agg(type || ':' || deleted::text, ',') FROM records ` +
        `WHERE id = '${chatId}' OR scope_id = '${chatId}';`
      const out = execSync(PSQL, { input: sql, encoding: 'utf8' }).trim()
      return out === 'chat:true' || out === 'chat:t'
    }
    if ((await api(A, 'sync.status')).live?.supported !== true)
      throw new Error('servidor sem chats ao vivo (features.liveChats / welcome.caps)')
    const live = await api(A, 'chats.create', {
      title: 'Chat só ao vivo real',
      storage: 'live',
      config: { providerId: provider.id, model: 'fake/agent', cwd: BASE, enabledTools: [] }
    })
    await api(A, 'agent.send', live.mainSessionId, 'oi ao vivo')
    await waitFor(
      async () => (await texts(A, live.mainSessionId)).includes('ok: oi ao vivo'),
      15_000,
      'A respondeu no chat ao vivo'
    )
    await waitFor(
      async () => (await api<any[]>(B, 'sync.liveChats')).some((c) => c.chatId === live.id),
      15_000,
      'B vê o chat ao vivo'
    )
    await api(B, 'sync.setActiveChat', live.id)
    const opened = await api(B, 'sync.liveOpen', live.id)
    if (opened.title !== 'Chat só ao vivo real') throw new Error('título do chat ao vivo')
    if (!(await texts(B, live.mainSessionId)).includes('ok: oi ao vivo'))
      throw new Error('B não carregou o histórico do host')
    const att = await B.page.evaluate(
      ([cid]) =>
        (window as any).api.sync.liveAttach(
          cid,
          'real.txt',
          'text/plain',
          new TextEncoder().encode('ANEXO-REAL-AO-VIVO\n')
        ),
      [live.id] as const
    )
    await api(B, 'agent.send', live.mainSessionId, 'leia', [att])
    await waitFor(
      async () => (await texts(B, live.mainSessionId)).some((t) => t.startsWith('ok: <file')),
      20_000,
      'B recebeu a resposta ao vivo'
    )
    const rows = dbRows(live.id)
    if (rows !== null && rows !== 0)
      throw new Error(`banco do servidor com ${rows} linha(s) do chat ao vivo`)
    console.log(
      `✔ chat ao vivo: A → B, histórico, anexo, resposta${rows === 0 ? ' · 0 linhas no banco' : ''}`
    )
    await api(A, 'sync.saveOnline', live.id)
    await waitFor(
      async () =>
        (await texts(B, live.mainSessionId)).length >= 4 &&
        !(await api<any[]>(B, 'sync.liveChats')).some((c) => c.chatId === live.id),
      20_000,
      'B recebeu o chat salvo online'
    )
    await ready(A)
    await api(A, 'sync.takeOffServer', live.id)
    await waitFor(
      async () => (await api<any[]>(B, 'sync.liveChats')).some((c) => c.chatId === live.id),
      20_000,
      'de volta ao vivo em B'
    )
    const t = tombOnly(live.id)
    if (t === false) throw new Error('o banco deveria ter só o tombstone do chat')
    console.log(`✔ conversões ao vivo → online → ao vivo${t ? ' · só o tombstone no banco' : ''}`)
    await A.app.close()
    await waitFor(
      async () => !(await api<any[]>(B, 'sync.liveChats')).some((c) => c.chatId === live.id),
      15_000,
      'sumiu de B ao fechar A'
    )
    console.log('✔ A fechou → o chat ao vivo sumiu de B')
    console.log('\n6/6 ok')
  } finally {
    await A.app.close().catch(() => {})
    await B.app.close().catch(() => {})
    llm.close()
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('✖', e.message)
    process.exit(1)
  }
)
