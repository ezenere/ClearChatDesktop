/* eslint-disable @typescript-eslint/no-explicit-any */
// Notificações push do host (docs/SYNC_PROTOCOL.md §22, desde 1.7.0): cripto contra
// docs/test-vectors/push.json (K_push, AAD, envelope byte a byte), regras puras (@shared/push:
// quando/para quem, trecho sem Markdown, texto da aprovação) e o PushNotifier dentro do motor do
// sync (sem Electron) contra o servidor FALSO com push — turno vindo do "celular", pendência com e
// sem espera, dismiss, ausente/presente, parar pelo usuário, preferência desligada, instância sem push.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SCHEMA } from '../src/main/dbSchema'
import { ensureMemorySchema } from '../src/main/memory/schema'
import { ensureSearchIndex } from '../src/main/searchIndex'
import { aadPush, deriveSubkeys, fromHex, hex, openJson, seal, utf8 } from '../src/main/sync/crypto'
import { SyncEngine } from '../src/main/sync/engine'
import type { RunnerAdapter } from '../src/main/sync/host'
import type { Presence, TurnEndInfo } from '../src/main/sync/push'
import {
  approvalText,
  clip,
  pendingPlan,
  plainExcerpt,
  pushChatTitle,
  questionText,
  retryText,
  turnEndPlan
} from '../src/shared/push'
import type { AgentEvent } from '../src/shared/types'
import { startFakeSyncServer, type FakeSyncServer } from './fakes/syncServer.ts'

const VEC = resolve(import.meta.dirname, '..', 'docs', 'test-vectors')
const vec = (f: string): any => JSON.parse(readFileSync(join(VEC, f), 'utf8'))

// ---------------------------------------------------------------- cripto (push.json)

test('push.json: K_push = HKDF(DEK, clearchat/v1/push), AAD e envelope byte a byte', () => {
  const v = vec('push.json')
  const sk = deriveSubkeys(fromHex(vec('keys.json').dek_hex))
  assert.equal(hex(sk.push), v.push_key_hex)
  assert.ok(v.cases.length >= 2)
  for (const c of v.cases) {
    const aad = aadPush(v.user_id, c.kind, c.tag)
    assert.equal(Buffer.from(aad).toString('utf8'), c.aad_utf8)
    const frame = fromHex(c.frame_hex)
    assert.equal(Buffer.from(frame.subarray(1)).toString('utf8'), c.json)
    const env = seal(sk.push, aad, frame, fromHex(c.nonce_hex))
    assert.deepEqual(env, c.envelope, c.name)
    const plain = openJson(sk.push, aad, c.envelope)
    assert.deepEqual(plain, JSON.parse(c.json))
    assert.equal(plain.kind, c.kind)
    // AAD com outro kind/tag/usuário não abre
    assert.throws(() => openJson(sk.push, aadPush(v.user_id, 'dismiss', c.tag), c.envelope))
    assert.throws(() => openJson(sk.push, aadPush(v.user_id, c.kind, '0'.repeat(32)), c.envelope))
    assert.throws(() => openJson(sk.push, utf8(c.aad_utf8 + 'x'), c.envelope))
  }
})

// ---------------------------------------------------------------- regras puras

test('@shared/push: quando e para quem (§22.5)', () => {
  assert.deepEqual(pendingPlan({ phoneOrigin: 'cel', away: false }), { delay: 'now', to: ['cel'] })
  assert.deepEqual(pendingPlan({ phoneOrigin: 'cel', away: true }), { delay: 'now', to: ['cel'] })
  assert.deepEqual(pendingPlan({ phoneOrigin: null, away: true }), { delay: 'now', to: 'all' })
  assert.deepEqual(pendingPlan({ phoneOrigin: null, away: false }), { delay: 'grace', to: 'all' })
  assert.deepEqual(turnEndPlan({ phoneOrigin: 'cel', away: false, userStopped: false }), ['cel'])
  assert.deepEqual(turnEndPlan({ phoneOrigin: 'cel', away: true, userStopped: false }), ['cel'])
  assert.equal(turnEndPlan({ phoneOrigin: null, away: true, userStopped: false }), 'all')
  assert.equal(turnEndPlan({ phoneOrigin: null, away: false, userStopped: false }), null)
  assert.equal(turnEndPlan({ phoneOrigin: 'cel', away: true, userStopped: true }), null)
})

test('@shared/push: trecho sem Markdown e textos das pendências', () => {
  assert.equal(
    plainExcerpt(
      '## Pronto\n\nAlterei **3 arquivos** e os `testes` passaram — veja [o diff](http://x/y).\n\n- item _um_\n- item dois\n\n```ts\nconst a = 1\n```\n> citação ~~velha~~\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    ),
    'Pronto Alterei 3 arquivos e os testes passaram — veja o diff. item um item dois const a = 1 citação velha a b 1 2'
  )
  assert.equal(plainExcerpt('<think>raciocínio</think>Olá *mundo*'), 'Olá mundo')
  assert.equal(
    plainExcerpt('![gráfico](a.png) 2 * 3 * 4 snake_case_name'),
    'gráfico 2 * 3 * 4 snake_case_name'
  )
  const long = plainExcerpt('palavra '.repeat(100))
  assert.equal(Array.from(long).length, 200)
  assert.ok(long.endsWith('…'))
  assert.equal(Array.from(clip('😀'.repeat(300), 200)).length, 200)
  assert.equal(
    approvalText({ toolName: 'shell', args: { command: 'npm test' } }),
    'Executar: npm test'
  )
  assert.equal(
    approvalText({ toolName: 'shell', args: { command: 'npm   test\n&& ls' } }),
    'Executar: npm test && ls'
  )
  assert.equal(
    approvalText({ toolName: 'write_file', args: { path: 'src/a.ts', content: 'x' } }),
    'Escrever arquivo: src/a.ts'
  )
  assert.equal(
    approvalText({ toolName: 'edit_file', args: { path: 'b.ts' } }),
    'Editar arquivo: b.ts'
  )
  assert.equal(
    approvalText({ toolName: 'browse_url', args: { url: 'https://a.b' } }),
    'Abrir: https://a.b'
  )
  assert.equal(
    approvalText({ toolName: 'memory_write', args: {} }),
    'Usar a ferramenta memory_write'
  )
  assert.equal(approvalText({ toolName: 'shell', args: null }), 'Executar')
  assert.equal(
    questionText({
      questions: [
        { title: 'Qual **banco**?', multiple: false, options: [] },
        { title: 'Outra', multiple: false, options: [] }
      ]
    }),
    'Qual banco? (+1)'
  )
  assert.equal(retryText({ error: 'ECONNRESET\n  socket' }), 'Falha de conexão: ECONNRESET socket')
  assert.equal(pushChatTitle(''), 'Chat')
  assert.equal(Array.from(pushChatTitle('t'.repeat(500))).length, 120)
})

// ---------------------------------------------------------------- motor + servidor falso

let srv: FakeSyncServer
const PASSWORD = 'senha de criptografia longa'
let emailN = 0
const devs: SyncEngine[] = []
const GRACE_MS = 400

before(async () => {
  srv = await startFakeSyncServer({ hostDropGraceMs: 400, commandTimeoutMs: 3000, push: true })
})
after(async () => {
  for (const d of devs) d.destroy()
  await srv.close()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 6000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(30)
  }
}

function newDb(): Database.Database {
  const conn = new Database(':memory:')
  conn.pragma('foreign_keys = ON')
  conn.exec(SCHEMA)
  conn.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT')
  conn.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
  ensureMemorySchema(conn)
  ensureSearchIndex(conn)
  return conn
}

function addChat(conn: Database.Database, title: string): { chatId: string; sessionId: string } {
  const chatId = randomUUID()
  const sessionId = randomUUID()
  conn
    .prepare(
      'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      chatId,
      title,
      JSON.stringify({ model: 'fake/m', providerId: '', cwd: '/tmp' }),
      sessionId,
      1,
      1
    )
  conn
    .prepare(
      `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, title, task, status, created_at)
       VALUES (?, ?, NULL, NULL, 0, 'fake/m', 'Principal', NULL, 'idle', 1)`
    )
    .run(sessionId, chatId)
  return { chatId, sessionId }
}

interface Dev {
  eng: SyncEngine
  conn: Database.Database
  /** Evento "do runner local". */
  agent: (e: AgentEvent) => void
  /** Fim de turno "do runner local". */
  turnEnd: (i: Partial<TurnEndInfo> & { chatId: string; sessionId: string }) => void
  sent: { sid: string; text: string }[]
  presence: { value: Presence }
}

function device(name: string, server: FakeSyncServer = srv): Dev {
  const conn = newDb()
  const listeners = new Set<(e: AgentEvent) => void>()
  const turnListeners = new Set<(i: TurnEndInfo) => void>()
  const secrets = new Map<string, string>()
  const sent: Dev['sent'] = []
  const presence = { value: 'present' as Presence }
  const fail = (): never => {
    throw new Error('não usado')
  }
  const runner: RunnerAdapter = {
    busyChats: () => new Set(),
    send: async (sid, text) => {
      sent.push({ sid, text })
      return { queued: false }
    },
    forceSend: () => {},
    removeQueued: () => {},
    getQueue: () => [],
    takeChatQueues: () => [],
    stop: async () => {},
    stopChat: async () => {},
    stopSubagents: async () => {},
    approve: () => {},
    smartOverride: fail,
    answerQuestion: fail,
    cancelQuestion: async () => {},
    retry: fail,
    cancelRetry: fail,
    regenerate: async () => {},
    editBranch: async () => {},
    selectBranch: fail,
    editMessage: fail,
    deleteMessage: async () => {},
    compact: () => ({ scheduled: false }),
    extractMemory: async () => ({ created: 0, updated: 0, deleted: 0, changes: [] }),
    approvals: () => [],
    questions: () => [],
    retries: () => [],
    processes: () => [],
    skillsFor: async () => [],
    onTurnEnd: (fn) => {
      turnListeners.add(fn)
      return () => turnListeners.delete(fn)
    }
  }
  const eng = new SyncEngine({
    conn,
    emit: (e) => {
      for (const l of listeners) l(e)
    },
    onAgentEvent: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    secrets: {
      get: (k) => secrets.get(k) ?? null,
      set: (k, v) => (v == null ? secrets.delete(k) : secrets.set(k, v)),
      available: () => true
    },
    appVersion: 'test',
    deviceName: name,
    platform: 'linux',
    runner,
    envUrl: server.url,
    presence: () => presence.value,
    pushGraceMs: GRACE_MS,
    timing: {
      pollMs: 40,
      pushDebounceMs: 20,
      retryMs: 150,
      ws: { backoffBaseMs: 80, backoffMaxMs: 400, pingMs: 2000, pongTimeoutMs: 2000 }
    },
    log: process.env.SYNC_DEBUG ? (...a: unknown[]) => console.log(`[${name}]`, ...a) : () => {}
  })
  devs.push(eng)
  return {
    eng,
    conn,
    sent,
    presence,
    agent: (e) => {
      for (const l of listeners) l(e)
    },
    turnEnd: (i) => {
      const full: TurnEndInfo = {
        depth: 0,
        outcome: 'final',
        text: '',
        userStopped: false,
        compactOnly: false,
        ...i
      }
      for (const l of turnListeners) l(full)
    }
  }
}

async function login(d: Dev, email: string, server: FakeSyncServer = srv): Promise<void> {
  await d.eng.init()
  await d.eng.requestCode(email)
  await d.eng.verifyCode(email, server.lastCode(email)!)
  await d.eng.unlock(PASSWORD, true)
  await waitFor(() => d.eng.phase() === 'ready' && d.eng.status().connection === 'online', 'online')
}

/** Host (A, com o chat) + "celular" (B, com token de push no servidor). */
async function pair(): Promise<{
  A: Dev
  B: Dev
  chatId: string
  sessionId: string
  dek: Uint8Array
  userId: string
}> {
  const email = `push${++emailN}-${Date.now()}@teste.dev`
  const { dek, userId } = await srv.createAccount({ email, password: PASSWORD })
  const A = device('PC de casa')
  const { chatId, sessionId } = addChat(A.conn, 'Refatorar **login**')
  await login(A, email)
  await waitFor(() => A.eng.chatInfo(chatId).host?.self, 'A virou host')
  await waitFor(() => A.eng.pushAvailable(), 'features.push lido')
  const B = device('Celular')
  await login(B, email)
  srv.setPushToken(B.eng.deviceId, 'tok-celular')
  await waitFor(() => B.eng.host.mode(chatId) === 'remote', 'B é controle remoto')
  return { A, B, chatId, sessionId, dek, userId }
}

function decrypt(dek: Uint8Array, userId: string, p: any): any {
  const sk = deriveSubkeys(dek)
  return openJson(sk.push, aadPush(userId, p.kind, p.tag), p.env)
}

test('turno vindo do celular: aprovação na hora para ele, dismiss ao resolver, resposta para ele', async () => {
  const { A, B, chatId, sessionId, dek, userId } = await pair()
  const r = await B.eng.host.sendCommand(chatId, 'send', {
    sessionId,
    text: 'rode os testes',
    attachments: [],
    skills: [],
    createdAt: Date.now()
  })
  assert.equal(r.status, 'accepted')
  assert.deepEqual(A.sent, [{ sid: sessionId, text: 'rode os testes' }])
  await A.eng.host.ensureWindow(chatId, 'run')
  const before = srv.pushes.length
  A.agent({
    type: 'approval-requested',
    request: {
      id: 'ap-1',
      chatId,
      sessionId,
      toolCallId: 't1',
      toolName: 'shell',
      args: { command: 'npm test' },
      createdAt: 1
    } as any
  })
  const ap = await waitFor(
    () => srv.pushes.slice(before).find((p) => p.kind === 'approval'),
    'aviso de aprovação'
  )
  assert.deepEqual(ap.to, [B.eng.deviceId])
  assert.deepEqual(ap.targets, [B.eng.deviceId])
  assert.match(ap.tag, /^[0-9a-f]{32}$/)
  const pl = decrypt(dek, userId, ap)
  assert.deepEqual(Object.keys(pl).sort(), [
    'chatId',
    'chatTitle',
    // desde 1.8.0 (§22.4): o host se identifica no payload
    'hostDeviceId',
    'hostName',
    'kind',
    'requestId',
    'sessionId',
    'sv',
    'text',
    'ts'
  ])
  assert.equal(pl.sv, 1)
  assert.equal(pl.kind, 'approval')
  assert.equal(pl.chatId, chatId)
  assert.equal(pl.sessionId, sessionId)
  assert.equal(pl.chatTitle, 'Refatorar **login**')
  assert.equal(pl.text, 'Executar: npm test')
  assert.equal(pl.requestId, 'ap-1')
  assert.equal(pl.hostName, 'PC de casa')
  assert.equal(pl.hostDeviceId, A.eng.deviceId)
  assert.equal(pl.live, undefined)
  assert.ok(Math.abs(pl.ts - Date.now()) < 10_000)
  // o celular aprova (comando remoto) → o runner resolve → dismiss com a mesma tag, para ele
  A.agent({ type: 'approval-resolved', id: 'ap-1' })
  const dm = await waitFor(
    () => srv.pushes.slice(before).find((p) => p.kind === 'dismiss'),
    'dismiss'
  )
  assert.equal(dm.tag, ap.tag)
  assert.deepEqual(dm.to, [B.eng.deviceId])
  assert.equal(dm.env, null)
  // resposta pronta → reply para o celular, trecho sem Markdown, tag estável por chat
  A.turnEnd({ chatId, sessionId, text: '**Pronto**, alterei os `3` arquivos.' })
  const rp = await waitFor(() => srv.pushes.slice(before).find((p) => p.kind === 'reply'), 'reply')
  assert.deepEqual(rp.to, [B.eng.deviceId])
  const rpl = decrypt(dek, userId, rp)
  assert.equal(rpl.text, 'Pronto, alterei os 3 arquivos.')
  assert.equal(rpl.kind, 'reply')
  assert.equal(rpl.requestId, undefined)
  // o próximo turno é local (sem origem) e o PC está presente: nada
  const n = srv.pushes.length
  A.turnEnd({ chatId, sessionId, text: 'outra' })
  await sleep(300)
  assert.equal(srv.pushes.length, n)
  // de novo do celular: a tag do reply é a mesma (substitui o aviso anterior)
  await B.eng.host.sendCommand(chatId, 'send', {
    sessionId,
    text: 'e agora?',
    attachments: [],
    skills: [],
    createdAt: Date.now()
  })
  A.turnEnd({ chatId, sessionId, outcome: 'error', error: 'HTTP 500 do provedor\nlinha 2' })
  const er = await waitFor(() => srv.pushes.slice(n).find((p) => p.kind === 'error'), 'error')
  assert.equal(er.tag, rp.tag)
  assert.equal(decrypt(dek, userId, er).text, 'HTTP 500 do provedor linha 2')
  // o "celular" (controle remoto) nunca avisa sobre o chat que não executa
  assert.equal(srv.pushes.filter((p) => p.fromDeviceId === B.eng.deviceId).length, 0)
})

test('PC presente: pendência só depois da espera, para todos; resolvida antes → nada', async () => {
  const { A, chatId, sessionId } = await pair()
  await A.eng.host.ensureWindow(chatId, 'run')
  const n = srv.pushes.length
  const req = (id: string): any => ({
    id,
    chatId,
    sessionId,
    toolCallId: 't',
    questions: [{ title: 'Qual banco?', multiple: false, options: [] }],
    createdAt: 1
  })
  A.agent({ type: 'question-requested', request: req('q-1') })
  await sleep(GRACE_MS / 2)
  assert.equal(srv.pushes.length, n, 'nada antes da espera')
  const q = await waitFor(() => srv.pushes.slice(n).find((p) => p.kind === 'question'), 'pergunta')
  assert.equal(q.to, 'all')
  // resolvida antes da espera: nada sai (nem dismiss)
  const m = srv.pushes.length
  A.agent({ type: 'question-requested', request: req('q-2') })
  await sleep(GRACE_MS / 3)
  A.agent({ type: 'question-resolved', id: 'q-2' })
  await sleep(GRACE_MS * 2)
  assert.equal(srv.pushes.length, m)
  // retry e resposta com o PC presente: só o retry (depois da espera)
  A.agent({
    type: 'retry-requested',
    request: { id: 'r-1', chatId, sessionId, error: 'ECONNRESET', model: 'x', createdAt: 1 }
  })
  A.turnEnd({ chatId, sessionId, text: 'ok' })
  await waitFor(() => srv.pushes.slice(m).some((p) => p.kind === 'retry'), 'retry')
  assert.equal(srv.pushes.slice(m).filter((p) => p.kind === 'reply').length, 0)
})

test('PC ausente: pendência na hora e resposta para todos; parar/compactar não avisam; preferência desligada', async () => {
  const { A, chatId, sessionId, dek, userId } = await pair()
  await A.eng.host.ensureWindow(chatId, 'run')
  A.presence.value = 'away'
  const n = srv.pushes.length
  A.agent({
    type: 'approval-requested',
    request: {
      id: 'ap-x',
      chatId,
      sessionId,
      toolCallId: 't',
      toolName: 'write_file',
      args: { path: 'a.txt' },
      createdAt: 1
    } as any
  })
  const ap = await waitFor(
    () => srv.pushes.slice(n).find((p) => p.kind === 'approval'),
    'aprovação'
  )
  assert.equal(ap.to, 'all')
  assert.ok(Date.now() - ap.at < 5000)
  assert.equal(decrypt(dek, userId, ap).text, 'Escrever arquivo: a.txt')
  A.turnEnd({ chatId, sessionId, text: 'feito' })
  const rp = await waitFor(() => srv.pushes.slice(n).find((p) => p.kind === 'reply'), 'reply')
  assert.equal(rp.to, 'all')
  // parar pelo usuário, compactação, subagente: nada
  const m = srv.pushes.length
  A.turnEnd({ chatId, sessionId, outcome: 'aborted' })
  A.turnEnd({ chatId, sessionId, outcome: 'error', error: 'x', userStopped: true })
  A.turnEnd({ chatId, sessionId, compactOnly: true })
  A.turnEnd({ chatId, sessionId, depth: 1, text: 'sub' })
  await sleep(300)
  assert.equal(srv.pushes.length, m)
  // preferência deste computador desligada: nada
  A.eng.setPushNotify(false)
  assert.equal(A.eng.status().push.enabled, false)
  A.turnEnd({ chatId, sessionId, text: 'feito de novo' })
  await sleep(300)
  assert.equal(srv.pushes.length, m)
  A.eng.setPushNotify(true)
  // chat que este dispositivo NÃO executa: nada
  A.turnEnd({ chatId: randomUUID(), sessionId, text: 'outro chat' })
  await sleep(300)
  assert.equal(srv.pushes.length, m)
})

test('instância sem push: nada é enviado e o status mostra indisponível', async () => {
  const s2 = await startFakeSyncServer({ hostDropGraceMs: 400 })
  try {
    const email = `nopush-${Date.now()}@teste.dev`
    await s2.createAccount({ email, password: PASSWORD })
    const A = device('PC', s2)
    const { chatId, sessionId } = addChat(A.conn, 'X')
    await login(A, email, s2)
    await waitFor(() => A.eng.chatInfo(chatId).host?.self, 'host')
    A.presence.value = 'away'
    assert.deepEqual(A.eng.status().push, { available: false, enabled: true })
    A.turnEnd({ chatId, sessionId, text: 'oi' })
    await A.eng.push.settle()
    await sleep(200)
    assert.equal(s2.pushes.length, 0)
    assert.equal(s2.requests.filter((r) => /\/api\/v1\/push$/.test(r.path)).length, 0)
    A.eng.destroy()
  } finally {
    await s2.close()
  }
})

test('envelope do aviso fica no teto mesmo com texto multibyte', async () => {
  const { A, chatId, sessionId, dek, userId } = await pair()
  A.presence.value = 'away'
  A.conn.prepare('UPDATE chats SET title = ? WHERE id = ?').run('🎉'.repeat(200), chatId)
  const n = srv.pushes.length
  A.turnEnd({ chatId, sessionId, text: '𝔘'.repeat(500) })
  const rp = await waitFor(() => srv.pushes.slice(n).find((p) => p.kind === 'reply'), 'reply')
  assert.ok(JSON.stringify(rp.env).length <= 2048)
  const pl = decrypt(dek, userId, rp)
  assert.equal(Array.from(pl.chatTitle).length, 120)
  assert.ok(Array.from(pl.text).length <= 200)
})
