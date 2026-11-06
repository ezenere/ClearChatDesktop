/* eslint-disable @typescript-eslint/no-explicit-any */
// Chats só ao vivo (docs/SYNC_PROTOCOL.md §23, desde 1.8.0): cripto contra docs/test-vectors/live.json
// (AAD live-announce, comandos/resultados/rec), regras puras (@shared/live) e o fluxo inteiro no
// motor do sync (sem Electron) contra o servidor FALSO com `liveChats`: anúncio → lista decifrada no
// outro dispositivo, histórico sob demanda (history.list/changes/item), `rec` ao vivo, comando `send`
// com anexo enviado por attach.put (e lido por attach.get), chat.update, saída do host (some na
// hora), conversões ao vivo ⇄ online, exclusividade (live_conflict), merge do primeiro login e
// servidor sem suporte. Nada do chat ao vivo pode aparecer nos registros do servidor.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SCHEMA } from '../src/main/dbSchema'
import { ensureMemorySchema } from '../src/main/memory/schema'
import { ensureSearchIndex } from '../src/main/searchIndex'
import {
  aadCommand,
  aadCommandResult,
  aadLiveAnnounce,
  aadStream,
  fromHex,
  openJson,
  seal,
  utf8
} from '../src/main/sync/crypto'
import { SyncEngine } from '../src/main/sync/engine'
import type { RunnerAdapter } from '../src/main/sync/host'
import { setAttachmentsDir } from '../src/main/attachments'
import { clampLiveInfo, liveItemWins, liveStatusLabel, parseLiveInfo } from '../src/shared/live'
import type { AgentEvent } from '../src/shared/types'
import { startFakeSyncServer, type FakeSyncServer } from './fakes/syncServer.ts'

const VEC = resolve(import.meta.dirname, '..', 'docs', 'test-vectors')
const vec = (f: string): any => JSON.parse(readFileSync(join(VEC, f), 'utf8'))
const PASSWORD = 'senha de criptografia do teste'

// ---------------------------------------------------------------- cripto (live.json)

test('live.json: AAD live-announce, envelopes byte a byte e casos que DEVEM falhar', () => {
  const v = vec('live.json')
  const key = fromHex(v.stream_key_hex)
  for (const c of v.cases) {
    const frame = fromHex(c.frame_hex)
    assert.equal(Buffer.from(frame.subarray(1)).toString('utf8'), c.json)
    const env = seal(key, utf8(c.aad_utf8), frame, fromHex(c.nonce_hex))
    assert.deepEqual(env, c.envelope, c.name)
    assert.deepEqual(openJson(key, utf8(c.aad_utf8), c.envelope), JSON.parse(c.json))
  }
  const ann = v.cases.find((c: any) => c.name === 'live-announce')
  const info = JSON.parse(ann.json)
  const aad = aadLiveAnnounce(v.user_id, v.host_device_id, info.chatId, 1793923200000, 3)
  assert.equal(Buffer.from(aad).toString('utf8'), ann.aad_utf8)
  // o mesmo envelope não abre como outro host, outra arev, nem como evento de stream
  assert.throws(() =>
    openJson(
      key,
      aadLiveAnnounce(v.user_id, randomUUID(), info.chatId, 1793923200000, 3),
      ann.envelope
    )
  )
  assert.throws(() =>
    openJson(
      key,
      aadLiveAnnounce(v.user_id, v.host_device_id, info.chatId, 1793923200000, 2),
      ann.envelope
    )
  )
  assert.throws(() =>
    openJson(key, aadStream(v.user_id, info.chatId, 1793923200000, 3), ann.envelope)
  )
  for (const m of v.must_fail)
    assert.throws(() => openJson(key, utf8(m.aad_utf8), m.envelope), m.name)
  // comando / resultado do histórico usam as AADs que já existiam
  const cmd = v.cases.find((c: any) => c.name === 'history.list (comando)')
  assert.equal(
    Buffer.from(aadCommand(v.user_id, info.chatId, 'cmd-h1')).toString('utf8'),
    cmd.aad_utf8
  )
  const res = v.cases.find((c: any) => c.name === 'history.list (resultado)')
  assert.equal(
    Buffer.from(aadCommandResult(v.user_id, info.chatId, 'cmd-h1')).toString('utf8'),
    res.aad_utf8
  )
  // o anúncio do vetor é um LiveChatInfo válido
  const parsed = parseLiveInfo(info, info.chatId)
  assert.equal(parsed?.title, 'Plano da viagem')
  assert.equal(parsed?.status, 'waiting')
  assert.equal(parseLiveInfo(info, randomUUID()), null, 'chatId de dentro ≠ de fora → ignorado')
})

test('@shared/live: maior lseq vence, textos cortados, rótulos de status', () => {
  const a = { type: 'message' as const, id: 'm', lseq: 3, data: { x: 1 } }
  assert.equal(liveItemWins(undefined, a), true)
  assert.equal(liveItemWins(a, { ...a, lseq: 2 }), false)
  assert.equal(liveItemWins(a, { ...a, lseq: 4 }), true)
  assert.equal(liveItemWins(a, { ...a, data: { x: 2 } }), false, 'empate = a mesma versão')
  assert.equal(
    liveItemWins({ type: 'message', id: 'm', lseq: 3, omitted: true }, a),
    true,
    'empate completa o item sem dado'
  )
  const long = clampLiveInfo({
    sv: 1,
    chatId: 'c',
    title: 'x'.repeat(500),
    persona: null,
    model: { providerId: null, providerName: null, model: null },
    status: 'idle',
    pending: { approvals: 0, questions: 0, retries: 0 },
    usesLocalTools: false,
    hostCwd: '/'.repeat(400),
    createdAt: 1,
    updatedAt: 2
  })
  assert.equal(long.title.length, 120)
  assert.equal(long.hostCwd?.length, 300)
  assert.equal(liveStatusLabel('running', 'online'), 'rodando')
  assert.equal(liveStatusLabel('waiting', 'online'), 'aguardando você')
  assert.equal(liveStatusLabel('idle', 'online'), 'ocioso')
  assert.equal(liveStatusLabel('running', 'grace'), 'reconectando…')
})

// ---------------------------------------------------------------- motor + servidor falso

let srv: FakeSyncServer
let oldSrv: FakeSyncServer
let attDir = ''
const devs: SyncEngine[] = []
let emailN = 0

before(async () => {
  srv = await startFakeSyncServer({ hostDropGraceMs: 600, commandTimeoutMs: 8000, liveChats: true })
  oldSrv = await startFakeSyncServer({ hostDropGraceMs: 600, commandTimeoutMs: 8000 })
  attDir = mkdtempSync(join(tmpdir(), 'clearchat-live-att-'))
  setAttachmentsDir(attDir)
})

after(async () => {
  for (const d of devs) d.destroy()
  await srv.close()
  await oldSrv.close()
  rmSync(attDir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 8000): Promise<T> {
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

function addChat(
  conn: Database.Database,
  title: string,
  storage: 'live' | null = 'live'
): { chatId: string; sessionId: string } {
  const chatId = randomUUID()
  const sessionId = randomUUID()
  conn
    .prepare(
      'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      chatId,
      title,
      JSON.stringify({ model: 'fake/m', providerId: '', cwd: '/tmp/host-root' }),
      sessionId,
      1,
      Date.now()
    )
  conn
    .prepare(
      `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, title, task, status, created_at)
       VALUES (?, ?, NULL, NULL, 0, 'fake/m', 'Principal', NULL, 'idle', 1)`
    )
    .run(sessionId, chatId)
  if (storage) conn.prepare('UPDATE chats SET storage = ? WHERE id = ?').run(storage, chatId)
  return { chatId, sessionId }
}

let seqN = 0
function addMessage(
  conn: Database.Database,
  sessionId: string,
  role: 'user' | 'assistant',
  content: unknown
): string {
  const id = randomUUID()
  conn
    .prepare(
      'INSERT INTO messages (id, session_id, seq, message_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, sessionId, ++seqN, JSON.stringify({ role, content }), '{}', Date.now())
  conn
    .prepare('UPDATE chats SET updated_at = ? WHERE main_session_id = ?')
    .run(Date.now(), sessionId)
  return id
}

interface Dev {
  eng: SyncEngine
  conn: Database.Database
  events: AgentEvent[]
  sent: { sid: string; text: string; atts: any[] }[]
}

function device(name: string, server: FakeSyncServer = srv): Dev {
  const conn = newDb()
  const listeners = new Set<(e: AgentEvent) => void>()
  const secrets = new Map<string, string>()
  const events: AgentEvent[] = []
  const sent: Dev['sent'] = []
  const fail = (): never => {
    throw new Error('não usado')
  }
  const runner: RunnerAdapter = {
    busyChats: () => new Set(),
    // "turno" falso: grava a mensagem do usuário e a resposta (os triggers levam ao emissor ao vivo)
    send: async (sid, text, atts) => {
      sent.push({ sid, text, atts })
      addMessage(conn, sid, 'user', text)
      addMessage(conn, sid, 'assistant', `ok: ${text}`)
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
    updateChat: (chatId, patch) => {
      if (patch.title !== undefined)
        conn
          .prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
          .run(patch.title, Date.now(), chatId)
    }
  }
  const eng = new SyncEngine({
    conn,
    emit: (e) => {
      events.push(e)
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
    timing: {
      pollMs: 40,
      pushDebounceMs: 20,
      retryMs: 150,
      ws: { backoffBaseMs: 80, backoffMaxMs: 400, pingMs: 2000, pongTimeoutMs: 2000 }
    },
    log: process.env.SYNC_DEBUG ? (...a: unknown[]) => console.log(`[${name}]`, ...a) : () => {}
  })
  eng.live.limits = { ...eng.live.limits, recDebounceMs: 20, announceMinIntervalMs: 60 }
  devs.push(eng)
  return { eng, conn, events, sent }
}

async function login(d: Dev, email: string, server: FakeSyncServer = srv): Promise<void> {
  await d.eng.init()
  await d.eng.requestCode(email)
  await d.eng.verifyCode(email, server.lastCode(email)!)
  await d.eng.unlock(PASSWORD, true)
  await waitFor(
    () => d.eng.phase() === 'ready' && d.eng.status().connection === 'online',
    `${d.eng.deviceName} online`
  )
}

async function account(server: FakeSyncServer = srv): Promise<{ email: string; userId: string }> {
  const email = `live${++emailN}-${Date.now()}@teste.dev`
  const { userId } = await server.createAccount({ email, password: PASSWORD })
  return { email, userId }
}

const serverHas = (server: FakeSyncServer, userId: string, chatId: string): boolean =>
  server.records(userId).some((r) => r.id === chatId || r.scope === chatId) ||
  !!server.chatState(userId, chatId)

test('fluxo ao vivo: anúncio, lista decifrada, histórico, rec, send com anexo, saída do host', async () => {
  const { email, userId } = await account()
  const A = device('PC de casa')
  const { chatId, sessionId } = addChat(A.conn, 'Plano da viagem')
  addMessage(A.conn, sessionId, 'user', 'oi')
  addMessage(A.conn, sessionId, 'assistant', 'olá!')
  await login(A, email)
  assert.equal(A.eng.live.supported(), true, 'features.liveChats + welcome.caps')
  await waitFor(() => srv.liveBindings(userId).some((b) => b.chat_id === chatId), 'vínculo')
  const B = device('Notebook')
  await login(B, email)
  const view = await waitFor(
    () => B.eng.liveViewer.views().find((v) => v.chatId === chatId),
    'B vê o chat ao vivo'
  )
  assert.equal(view.title, 'Plano da viagem')
  assert.equal(view.host.name, 'PC de casa')
  assert.equal(view.hostCwd, '/tmp/host-root')
  assert.equal(B.eng.host.mode(chatId), 'remote')
  assert.equal(B.eng.chatInfo(chatId).live?.role, 'viewer')
  assert.equal(A.eng.chatInfo(chatId).live?.role, 'host')
  // tetos encolhidos no host: páginas de 1 item, itens "grandes" em pedaços, `rec` com omitted
  A.eng.live.limits = {
    ...A.eng.live.limits,
    historyPageMaxItems: 1,
    itemInlineMaxBytes: 120,
    historyChunkBytes: 40,
    recInlineMaxBytes: 150
  }
  addMessage(A.conn, sessionId, 'user', 'uma mensagem bem comprida '.repeat(12))
  // B abre: histórico vindo do host, só em memória
  B.eng.host.setActive(chatId)
  const chat = await B.eng.liveViewer.open(chatId)
  assert.equal(chat.title, 'Plano da viagem')
  assert.equal(chat.mainSessionId, sessionId)
  assert.equal(chat.liveViewer?.hostName, 'PC de casa')
  assert.deepEqual(
    (await B.eng.liveViewer.messages(sessionId)).map((m) => m.message.content),
    ['oi', 'olá!', 'uma mensagem bem comprida '.repeat(12)]
  )
  assert.equal(
    (B.conn.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n,
    0,
    'nada gravado no banco do visualizador'
  )
  // mensagem nova no host → `rec` → B recebe ao vivo
  addMessage(A.conn, sessionId, 'assistant', 'mais uma')
  await waitFor(
    () =>
      B.events.some(
        (e) => e.type === 'message-added' && (e.message.message as any).content === 'mais uma'
      ),
    'rec chegou em B'
  )
  // item acima do teto do `rec` → omitted → B busca com history.item
  const big = 'resposta longa '.repeat(30)
  addMessage(A.conn, sessionId, 'assistant', big)
  await waitFor(
    () =>
      B.events.some(
        (e) => e.type === 'message-added' && (e.message.message as any).content === big
      ),
    'item omitted buscado'
  )
  // anexo: B envia ao host em pedaços (attach.put) — vários pedaços com o teto encolhido
  const bytes = Buffer.alloc(1200 * 1024, 7)
  bytes.write('hello', 0)
  const info = await B.eng.liveViewer.upload(chatId, {
    name: 'notas.txt',
    mime: 'text/plain',
    data: new Uint8Array(bytes)
  })
  assert.equal(info.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(info.file, `${info.sha256}.txt`)
  assert.ok(A.eng.live.hasStoreFile(info), 'o arquivo está no store do host')
  // send com a referência ao store do host
  const r = await B.eng.host.sendCommand(chatId, 'send', {
    sessionId,
    text: 'leia o anexo',
    attachments: [info],
    skills: [],
    createdAt: Date.now()
  })
  assert.equal(r.status, 'accepted')
  assert.equal(A.sent.at(-1)?.atts[0]?.file, info.file)
  await waitFor(
    () =>
      B.events.some(
        (e) =>
          e.type === 'message-added' && (e.message.message as any).content === 'ok: leia o anexo'
      ),
    'resposta do host em B'
  )
  // referência inexistente → recusado
  await assert.rejects(
    B.eng.host.sendCommand(chatId, 'send', {
      sessionId,
      text: 'x',
      attachments: [{ ...info, file: `${'0'.repeat(64)}.txt`, sha256: '0'.repeat(64) }],
      skills: [],
      createdAt: Date.now()
    }),
    /não conseguiu baixar um dos anexos/
  )
  // attach.get: B lê do host (sem cache), conferido pelo SHA-256 — só em memória
  addMessage(A.conn, sessionId, 'user', [
    { type: 'text', text: 'veja' },
    {
      type: 'file',
      file: { filename: 'notas.txt', file_data: `clearchat-attachment://${info.file}` }
    }
  ])
  ;(B.eng.liveViewer as any).att.clear()
  ;(B.eng.liveViewer as any).attBytes = 0
  await waitFor(() => B.eng.liveViewer.ownsFile(info.file), 'anexo citado no histórico de B')
  const got = await B.eng.liveViewer.attachment(info.file)
  assert.ok(got && Buffer.compare(got, bytes) === 0, 'attach.get devolveu os bytes')
  // chat.update: B renomeia, o host aplica e reanuncia
  await B.eng.liveViewer.updateChat(chatId, { title: 'Viagem a Lisboa' })
  await waitFor(
    () => B.eng.liveViewer.views().find((v) => v.chatId === chatId)?.title === 'Viagem a Lisboa',
    'novo título anunciado'
  )
  // history.* em chat que não é ao vivo / sem vínculo → recusado pelo servidor
  const online = addChat(A.conn, 'Online comum', null)
  await waitFor(() => srv.records(userId).some((x) => x.id === online.chatId), 'chat online subiu')
  // nada do chat ao vivo no servidor
  assert.equal(serverHas(srv, userId, chatId), false, 'zero registros do chat ao vivo')
  // mudança perdida (B fora do chat, sem inscrição) → reabrir busca por history.changes
  B.eng.host.setActive(null)
  await sleep(100)
  addMessage(A.conn, sessionId, 'assistant', 'perdida')
  await sleep(400)
  B.eng.host.setActive(chatId)
  await B.eng.liveViewer.open(chatId)
  assert.ok(
    (await B.eng.liveViewer.messages(sessionId)).some((m) => m.message.content === 'perdida'),
    'history.changes trouxe a mensagem perdida'
  )
  // host fecha o app → some na hora (live.withdraw quit)
  A.eng.destroy()
  await waitFor(() => !B.eng.liveViewer.views().some((v) => v.chatId === chatId), 'sumiu de B')
  assert.ok(B.events.some((e) => e.type === 'chat-deleted' && e.chatId === chatId))
  assert.equal(serverHas(srv, userId, chatId), false)
})

test('conversões: ao vivo → online (saved_online) e online → ao vivo (tombstone, host mantém)', async () => {
  const { email, userId } = await account()
  const A = device('PC')
  const { chatId, sessionId } = addChat(A.conn, 'Converter')
  addMessage(A.conn, sessionId, 'user', 'primeira')
  await login(A, email)
  const B = device('Note')
  await login(B, email)
  await waitFor(() => B.eng.liveViewer.views().some((v) => v.chatId === chatId), 'B vê')
  // ao vivo → online
  A.eng.saveOnline(chatId)
  await waitFor(
    () => srv.records(userId).some((r) => r.type === 'chat' && r.id === chatId),
    'subiu'
  )
  await waitFor(
    () => !srv.liveBindings(userId).some((b) => b.chat_id === chatId),
    'vínculo apagado'
  )
  await waitFor(
    () => (B.conn.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n === 1,
    'B recebeu o chat comum'
  )
  assert.equal(B.eng.liveViewer.views().length, 0)
  assert.equal(A.eng.live.storage(chatId), 'online')
  await waitFor(() => !A.eng.pendingCount(), 'A sem pendências')
  // online → ao vivo
  await waitFor(() => A.eng.host.mode(chatId) === 'local', 'A é o host')
  await A.eng.takeOffServer(chatId)
  await waitFor(() => A.eng.live.storage(chatId) === 'live', 'virou live no ack')
  await waitFor(() => srv.liveBindings(userId).some((b) => b.chat_id === chatId), 'anunciado')
  const rec = srv.records(userId).find((r) => r.type === 'chat' && r.id === chatId)
  assert.ok(rec?.deleted, 'tombstone do chat no feed')
  assert.ok(
    !srv.records(userId).some((r) => r.scope === chatId && r.type !== 'chat'),
    'sessões/mensagens apagadas do servidor'
  )
  assert.equal(srv.chatState(userId, chatId), null)
  await waitFor(
    () => !(B.conn.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId) as unknown),
    'B apagou a cópia'
  )
  await waitFor(() => B.eng.liveViewer.views().some((v) => v.chatId === chatId), 'B vê ao vivo')
  assert.ok(
    A.conn.prepare('SELECT 1 FROM messages WHERE session_id = ?').get(sessionId),
    'A mantém'
  )
  // de novo ao vivo → online: recriação sobre o tombstone
  A.eng.saveOnline(chatId)
  await waitFor(
    () => srv.records(userId).some((r) => r.type === 'chat' && r.id === chatId && !r.deleted),
    'recriado online'
  )
})

test('exclusividade: push de outro dispositivo num chat vinculado → live_conflict; host.begin também', async () => {
  const { email, userId } = await account()
  const A = device('PC')
  const { chatId } = addChat(A.conn, 'Exclusivo')
  await login(A, email)
  const B = device('Note')
  await login(B, email)
  await waitFor(() => srv.liveBindings(userId).some((b) => b.chat_id === chatId), 'vínculo')
  await assert.rejects(
    B.eng.ws.request('host.begin', { chat_id: chatId, epoch: null, purpose: 'run' }),
    (e: any) => e.code === 'live_conflict'
  )
  await assert.rejects(
    B.eng.http.post('/api/v1/sync/push', {
      push_id: randomUUID(),
      items: [
        {
          type: 'chat',
          id: chatId,
          scope: chatId,
          base_rev: 0,
          rev: 1,
          deleted: false,
          env: { v: 1, k: 1, n: 'AAAAAAAAAAAAAAAA', c: 'A'.repeat(40) },
          blobs: []
        }
      ]
    }),
    (e: any) => e.code === 'live_conflict'
  )
  // history.* sem vínculo → invalid_request no servidor
  await assert.rejects(
    B.eng.host.rawCommand(randomUUID(), 'history.list', { type: 'chat' }, 3000, 'timeout'),
    (e: any) => e.code === 'invalid_request'
  )
})

test('merge do primeiro login: chat ao vivo criado sem login continua local; padrão de instalação nova', async () => {
  const { email, userId } = await account()
  const A = device('PC')
  A.eng.live.ensureDeviceDefault()
  assert.equal(A.eng.live.deviceDefault(), 'live', 'instalação nova: só ao vivo')
  assert.equal(A.eng.live.resolveNew(null), 'live', 'sem login grava o padrão do dispositivo')
  const live = addChat(A.conn, 'Antes do login')
  const online = addChat(A.conn, 'Online antes do login', null)
  await login(A, email)
  await waitFor(() => srv.records(userId).some((r) => r.id === online.chatId), 'online subiu')
  await waitFor(() => srv.liveBindings(userId).some((b) => b.chat_id === live.chatId), 'anunciado')
  assert.equal(serverHas(srv, userId, live.chatId), false, 'o ao vivo não subiu no merge')
  // instalação que já sincronizava: "Salvar online"
  const C = device('Antigo')
  C.eng.setKv('user_id', userId)
  C.eng.live.ensureDeviceDefault()
  assert.equal(C.eng.live.deviceDefault(), 'online')
})

test('servidor sem suporte (< 1.8.0): chats novos online; o ao vivo fica só local', async () => {
  const { email, userId } = await account(oldSrv)
  const A = device('PC', oldSrv)
  const { chatId } = addChat(A.conn, 'Só local')
  await login(A, email, oldSrv)
  await sleep(400)
  assert.equal(A.eng.live.supported(), false)
  assert.equal(A.eng.live.resolveNew('live'), 'online', 'escolha escondida → online')
  assert.equal(A.eng.chatInfo(chatId).live?.unsupported, true)
  assert.equal(serverHas(oldSrv, userId, chatId), false)
  // "Salvar online" só usa push comum
  A.eng.saveOnline(chatId)
  await waitFor(() => oldSrv.records(userId).some((r) => r.id === chatId), 'subiu por push comum')
})
