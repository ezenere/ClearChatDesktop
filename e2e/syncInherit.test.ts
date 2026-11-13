/* eslint-disable @typescript-eslint/no-explicit-any */
// Herança ao vivo da persona no SYNC (protocolo 1.10.0, §4.3.6/§7.5/§7.7) — motor real
// (src/main/sync/engine.ts) contra o servidor FALSO (e2e/fakes/syncServer.ts), dois "dispositivos"
// com bancos SQLite em memória na mesma conta:
//   - persona editada em A muda a config EFETIVA do chat herdado em B sem nenhuma escrita do chat;
//   - campo sobrescrito em B continua próprio quando a persona muda de novo;
//   - persona apagada congela os chats dela, enviados ANTES do tombstone; quem recebe o tombstone
//     com um chat local ainda apontando para ela o congela e o reenvia;
//   - chat legado (gravado por um app < 1.10.0, sem overrides) migra depois do pull completo, de
//     forma determinística;
//   - conflito: troca de persona em A × campo sobrescrito em B ao mesmo tempo (overrides por
//     unidade + a cópia de A não sobrescreve o valor próprio de B);
//   - tools de um tipo de aparelho: o merge do primeiro login grava `hostCwd` nos chats que o
//     computador envia; a limpeza única (uma vez por dispositivo, depois do pull completo) tira as
//     marcas de tools de um tipo de aparelho em que o chat nunca rodou e envia os chats.
// Rodar: npm run test:unit
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { SCHEMA } from '../src/main/dbSchema'
import { ensureMemorySchema } from '../src/main/memory/schema'
import { ensureSearchIndex } from '../src/main/searchIndex'
import { withApply } from '../src/main/sync/schema'
import { SyncEngine } from '../src/main/sync/engine'
import {
  chatRanOnHere,
  chatRecordFrom,
  DEVICE_OVERRIDES_CLEANUP_SETTING,
  effectiveFromJson,
  freezeChatsOfPreset,
  inheritEnvOf,
  presetConfigOf
} from '../src/main/chatInherit'
import {
  applyChatConfigPatch,
  newInheritingChatConfig,
  personaEffectiveConfig
} from '../src/shared/chatInherit'
import type { AgentEvent } from '../src/shared/types'
import { startFakeSyncServer, type FakeSyncServer } from './fakes/syncServer.ts'

let srv: FakeSyncServer
const PASSWORD = 'senha de criptografia longa'
let emailN = 0

before(async () => {
  srv = await startFakeSyncServer({ hostDropGraceMs: 400, commandTimeoutMs: 3000 })
})
const allDevs: Dev[] = []
after(async () => {
  for (const d of allDevs) d.eng.destroy()
  await srv.close()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 8000): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(40)
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

interface Dev {
  name: string
  conn: Database.Database
  eng: SyncEngine
  events: AgentEvent[]
}

function device(name: string): Dev {
  const conn = newDb()
  const events: AgentEvent[] = []
  const secrets = new Map<string, string>()
  const eng = new SyncEngine({
    conn,
    emit: (e) => void events.push(e),
    onAgentEvent: () => () => {},
    secrets: {
      get: (k) => secrets.get(k) ?? null,
      set: (k, v) => (v == null ? secrets.delete(k) : secrets.set(k, v)),
      available: () => true
    },
    appVersion: 'test',
    deviceName: name,
    platform: 'linux',
    runner: null,
    envUrl: srv.url,
    timing: {
      pollMs: 40,
      pushDebounceMs: 20,
      retryMs: 150,
      ws: { backoffBaseMs: 80, backoffMaxMs: 400, pingMs: 2000, pongTimeoutMs: 2000 }
    },
    log: process.env.SYNC_DEBUG ? (...a: unknown[]) => console.log(`[${name}]`, ...a) : () => {}
  })
  const dev = { name, conn, eng, events }
  allDevs.push(dev)
  return dev
}

async function newAccount(): Promise<string> {
  const email = `herança${++emailN}-${Date.now()}@teste.dev`
  await srv.createAccount({ email, password: PASSWORD })
  return email
}

async function login(d: Dev, email: string): Promise<void> {
  await d.eng.init()
  await d.eng.requestCode(email)
  await d.eng.verifyCode(email, srv.lastCode(email)!)
  await d.eng.unlock(PASSWORD, true)
}

const settled = (d: Dev): Promise<boolean> =>
  waitFor(
    () =>
      d.eng.phase() === 'ready' &&
      d.eng.pendingCount() === 0 &&
      (d.conn.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as any).n === 0,
    `${d.name} sincronizado`
  )

async function synced(...devs: Dev[]): Promise<void> {
  for (let i = 0; i < 2; i++)
    for (const d of devs) {
      await settled(d)
      await d.eng.syncNow()
    }
}

// ---------------- dados (SQL como os repos) ----------------

function addProvider(conn: Database.Database, id: string, kind = 'openrouter'): void {
  conn
    .prepare(
      'INSERT INTO providers (id, name, base_url, kind, api_key, headers_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, 'OpenRouter', 'https://openrouter.ai/api/v1', kind, 'sk-1', '{}', 1000)
}

function setSetting(conn: Database.Database, key: string, value: unknown): void {
  conn
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, JSON.stringify(value))
}

function addPreset(conn: Database.Database, id: string, name: string, config: object): void {
  conn
    .prepare(
      'INSERT INTO presets (id, name, description, icon, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, name, '', 'sparkles', JSON.stringify(config), 1, 1)
}

const setPreset = (conn: Database.Database, id: string, config: object): void =>
  void conn
    .prepare('UPDATE presets SET config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(config), Date.now(), id)

/** Chat ≥ 1.10.0 com a persona (como o repo grava: `newInheritingChatConfig`). */
function addInheritingChat(conn: Database.Database, presetId: string, extra: object = {}): string {
  const id = randomUUID()
  const sid = randomUUID()
  const cfg = newInheritingChatConfig(
    { cwd: '/home/teste', presetId, overrides: {}, ...extra },
    presetConfigOf(conn, presetId)!,
    inheritEnvOf(conn)
  )
  insertChat(conn, id, sid, cfg)
  return id
}

function insertChat(conn: Database.Database, id: string, sid: string, cfg: object): void {
  conn
    .prepare(
      'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, 'Chat', JSON.stringify(cfg), sid, 1, 1)
  conn
    .prepare(
      `INSERT INTO sessions (id, chat_id, parent_session_id, parent_tool_call_id, depth, model, title, task, status, created_at)
       VALUES (?, ?, NULL, NULL, 0, 'fake/m', 'Principal', NULL, 'idle', 1)`
    )
    .run(sid, id)
}

const rawConfig = (conn: Database.Database, id: string): any =>
  JSON.parse(
    (conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(id) as any).config_json
  )
const effective = (conn: Database.Database, id: string): any =>
  effectiveFromJson(
    conn,
    (conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(id) as any).config_json
  )
/** Edição local como o repo faz (patch sobre a efetiva → unidades tocadas viram próprias). */
function editChat(conn: Database.Database, id: string, patch: object): void {
  const rec = chatRecordFrom(
    conn,
    (conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(id) as any).config_json
  )
  const next = applyChatConfigPatch(rec, patch, {
    env: inheritEnvOf(conn),
    persona: (pid) => presetConfigOf(conn, pid),
    ranOn: chatRanOnHere(conn, id)
  })
  conn.prepare('UPDATE chats SET config_json = ? WHERE id = ?').run(JSON.stringify(next), id)
}
const serverRec = (d: Dev, type: string, id: string): any =>
  srv.records(d.eng.userId!).find((r) => r.type === type && r.id === id)
/** Plaintext da revisão do servidor que o dispositivo conhece (a base). */
const serverPlain = (d: Dev, type: string, id: string): any =>
  (d.eng as any).basePlain(d.eng.record(type, id))

/** Os dois dispositivos com o mesmo provedor, padrão de "Novos chats" e a persona P. */
async function pair(): Promise<{ A: Dev; B: Dev; email: string }> {
  const email = await newAccount()
  const A = device('A')
  const B = device('B')
  addProvider(A.conn, 'or')
  setSetting(A.conn, 'defaultProviderId', 'or')
  setSetting(A.conn, 'defaultModel', 'base/model')
  addPreset(A.conn, 'P', 'Revisor', { systemPrompt: 'v1', autoCompact: true })
  await login(A, email)
  await synced(A)
  await login(B, email)
  await synced(A, B)
  assert.ok(presetConfigOf(B.conn, 'P'), 'B recebeu a persona')
  return { A, B, email }
}

// ---------------- testes ----------------

test('persona editada em A muda o chat herdado em B sem nenhuma escrita do chat; override de B sobrevive', async () => {
  const { A, B } = await pair()
  const chatId = addInheritingChat(A.conn, 'P')
  await synced(A, B)
  assert.equal(effective(B.conn, chatId).systemPrompt, 'v1')
  const rev0 = serverRec(A, 'chat', chatId).rev

  setPreset(A.conn, 'P', { systemPrompt: 'v2', autoCompact: true, contextWindow: 9000 })
  await synced(A, B)
  assert.equal(effective(B.conn, chatId).systemPrompt, 'v2', 'B segue a persona ao vivo')
  assert.equal(effective(B.conn, chatId).contextWindow, 9000)
  assert.equal(serverRec(A, 'chat', chatId).rev, rev0, 'o registro do chat não foi regravado')
  assert.equal(rawConfig(B.conn, chatId).systemPrompt, 'v1', 'a cópia informativa fica como estava')

  // B sobrescreve o prompt (vira próprio) e A vê
  editChat(B.conn, chatId, { systemPrompt: 'meu prompt (B)' })
  await synced(B, A)
  assert.deepEqual(rawConfig(A.conn, chatId).overrides, { systemPrompt: true })
  assert.equal(effective(A.conn, chatId).systemPrompt, 'meu prompt (B)')
  // a persona muda de novo: o próprio continua, o herdado acompanha
  setPreset(A.conn, 'P', { systemPrompt: 'v3', autoCompact: false })
  await synced(A, B)
  for (const d of [A, B]) {
    assert.equal(effective(d.conn, chatId).systemPrompt, 'meu prompt (B)', d.name)
    assert.equal(effective(d.conn, chatId).autoCompact, false, d.name)
  }
  // padrão de "Novos chats" (setting sincronizada) também chega ao chat que herda
  setSetting(A.conn, 'defaultModel', 'outro/model')
  await synced(A, B)
  assert.equal(effective(B.conn, chatId).model, 'outro/model', 'Novos chats → persona → chat')
})

test('persona apagada: A congela e envia os chats ANTES do tombstone; B recebe congelado', async () => {
  const { A, B } = await pair()
  const chatId = addInheritingChat(A.conn, 'P')
  await synced(A, B)
  // apagar como o presetsRepo.delete: congela e apaga na mesma transação
  A.conn.transaction(() => {
    assert.deepEqual(freezeChatsOfPreset(A.conn, 'P'), [chatId])
    A.conn.prepare('DELETE FROM presets WHERE id = ?').run('P')
  })()
  await synced(A, B)
  const chatRec = serverRec(A, 'chat', chatId)
  const tomb = serverRec(A, 'preset', 'P')
  assert.ok(tomb.deleted, 'tombstone da persona')
  assert.ok(chatRec.seq < tomb.seq, 'chat congelado enviado antes do tombstone')
  const cfg = rawConfig(B.conn, chatId)
  assert.equal(cfg.presetId, undefined)
  assert.equal(cfg.systemPrompt, 'v1')
  assert.equal(cfg.autoCompact, true)
  assert.deepEqual(cfg.overrides, {}, 'overrides mantido')
})

test('tombstone remoto: o chat local de B que ainda aponta para a persona congela e volta ao servidor', async () => {
  const { A, B } = await pair()
  // B cria um chat com P enquanto A apaga P sem saber dele
  B.eng.stop()
  const chatB = addInheritingChat(B.conn, 'P', {
    overrides: { autoCompact: true },
    autoCompact: false
  })
  A.conn.transaction(() => {
    freezeChatsOfPreset(A.conn, 'P')
    A.conn.prepare('DELETE FROM presets WHERE id = ?').run('P')
  })()
  await synced(A)
  B.eng.start()
  await synced(B, A)
  assert.equal(presetConfigOf(B.conn, 'P'), null, 'B apagou a persona')
  const cfg = rawConfig(B.conn, chatB)
  assert.equal(cfg.presetId, undefined, 'congelado')
  assert.equal(cfg.systemPrompt, 'v1', 'com o valor efetivo da persona')
  assert.equal(cfg.autoCompact, false, 'o próprio continua')
  assert.equal(rawConfig(A.conn, chatB).presetId, undefined, 'A recebeu o chat congelado')
})

test('chat legado (app < 1.10.0, sem overrides) migra depois do pull completo — determinístico', async () => {
  const { A, B } = await pair()
  // A faz o papel do app antigo: não migra e envia o chat como cópia (sem overrides)
  const migrateA = A.eng.migrateInheritance.bind(A.eng)
  ;(A.eng as any).migrateInheritance = () => {}
  const chatId = randomUUID()
  const legacy = {
    ...personaEffectiveConfig(presetConfigOf(A.conn, 'P'), inheritEnvOf(A.conn), '/home/teste'),
    presetId: 'P',
    autoCompact: false, // mudado no chat
    params: { temperature: 0.4 } // mudado no chat
  }
  B.eng.stop()
  insertChat(A.conn, chatId, randomUUID(), legacy)
  await synced(A)
  assert.equal(rawConfig(A.conn, chatId).overrides, undefined, 'subiu sem overrides')
  const sent = (A.eng as any).basePlain(A.eng.record('chat', chatId))
  assert.equal(sent.config.overrides, undefined, 'o servidor tem a cópia sem overrides')
  const revSent = serverRec(A, 'chat', chatId).rev
  // B (≥ 1.10.0) puxa e migra: iguais herdam, diferentes ficam próprios
  B.eng.start()
  await synced(B, A)
  assert.equal(serverRec(A, 'chat', chatId).rev, revSent + 1, 'uma gravação (a migração)')
  const expected = { autoCompact: true, 'params.temperature': true }
  assert.deepEqual(rawConfig(B.conn, chatId).overrides, expected)
  assert.deepEqual(rawConfig(A.conn, chatId).overrides, expected, 'A recebeu a migração')
  // a mesma migração rodando em A daria o mesmo (determinística); já migrado → nada a fazer
  ;(A.eng as any).migrateInheritance = migrateA
  const before = rawConfig(A.conn, chatId)
  A.eng.migrateInheritance()
  assert.deepEqual(rawConfig(A.conn, chatId), before)
  // e agora o chat herda: a persona muda o prompt, os próprios ficam
  setPreset(A.conn, 'P', { systemPrompt: 'v2', autoCompact: true })
  await synced(A, B)
  assert.equal(effective(B.conn, chatId).systemPrompt, 'v2')
  assert.equal(effective(B.conn, chatId).autoCompact, false)
})

test('migração simultânea em dois dispositivos grava o mesmo (merge sem conflito real)', async () => {
  const { A, B } = await pair()
  const chatId = randomUUID()
  const sid = randomUUID()
  const legacy = {
    ...personaEffectiveConfig(presetConfigOf(A.conn, 'P'), inheritEnvOf(A.conn), '/home/teste'),
    presetId: 'P',
    systemPrompt: 'mudado'
  }
  // os dois receberam o mesmo chat de um app antigo (aplicado como remoto, sem marcar)
  for (const d of [A, B]) withApply(d.conn, () => insertChat(d.conn, chatId, sid, legacy))
  A.eng.migrateInheritance()
  B.eng.migrateInheritance()
  assert.deepEqual(rawConfig(A.conn, chatId), rawConfig(B.conn, chatId), 'mesmo resultado')
  await synced(A, B)
  assert.deepEqual(rawConfig(A.conn, chatId).overrides, { systemPrompt: true })
  assert.deepEqual(rawConfig(B.conn, chatId).overrides, { systemPrompt: true })
})

test('conflito: troca de persona em A × campo sobrescrito em B — overrides por unidade, a cópia não vence o próprio', async () => {
  const { A, B } = await pair()
  addPreset(A.conn, 'Q', 'Tradutor', {
    systemPrompt: 'q1',
    autoCompact: false,
    contextWindow: 7000
  })
  const chatId = addInheritingChat(A.conn, 'P')
  await synced(A, B)
  A.eng.stop()
  B.eng.stop()
  // A troca para Q (a cópia do prompt herdado vira 'q1'); B sobrescreve o prompt ao mesmo tempo
  editChat(A.conn, chatId, { presetId: 'Q' })
  editChat(B.conn, chatId, { systemPrompt: 'próprio de B' })
  A.eng.start()
  await synced(A)
  B.eng.start()
  await synced(B, A)
  for (const d of [A, B]) {
    const raw = rawConfig(d.conn, chatId)
    assert.equal(raw.presetId, 'Q', `${d.name}: a troca de persona ficou`)
    assert.deepEqual(raw.overrides, { systemPrompt: true }, `${d.name}: marca de B ficou`)
    const eff = effective(d.conn, chatId)
    assert.equal(eff.systemPrompt, 'próprio de B', `${d.name}: o próprio venceu a cópia`)
    assert.equal(eff.contextWindow, 7000, `${d.name}: o resto segue Q`)
  }
})

test('merge do primeiro login: o computador grava hostCwd nos chats locais que envia (§4.3.6, §12)', async () => {
  const email = await newAccount()
  const A = device('A')
  addProvider(A.conn, 'or')
  addPreset(A.conn, 'P', 'Revisor', { systemPrompt: 'v1' })
  // chat criado antes do login (sem sync): o computador é o host dele
  const chatId = addInheritingChat(A.conn, 'P')
  await login(A, email)
  await synced(A)
  const sent = (A.eng as any).basePlain(A.eng.record('chat', chatId))
  assert.deepEqual(sent.hostCwd, { deviceId: A.eng.deviceId, path: '/home/teste' })
  // um segundo computador vê o chat como "rodou num computador"
  const B = device('B')
  await login(B, email)
  await synced(A, B)
  assert.deepEqual(chatRanOnHere(B.conn, chatId), { computer: true, phone: false })
})

test('limpeza única das tools marcadas por causa do aparelho: uma vez por dispositivo, depois do pull completo', async () => {
  const { A, B, email } = await pair()
  // A e B já fizeram a limpeza (no primeiro pull); A grava chats como um build de teste de 1.10.0
  assert.ok(
    A.conn.prepare('SELECT 1 FROM settings WHERE key = ?').get(DEVICE_OVERRIDES_CLEANUP_SETTING),
    'A marcou a limpeza como feita'
  )
  // só o registro `chat` (sem conteúdo: ninguém vira host) com as marcas por causa do aparelho
  const noisy = (hostCwd: object | null): string => {
    const id = randomUUID()
    const cfg = newInheritingChatConfig(
      { cwd: '', presetId: 'P', overrides: {} },
      presetConfigOf(A.conn, 'P')!,
      inheritEnvOf(A.conn)
    )
    const next = {
      ...cfg,
      enabledTools: cfg.enabledTools.filter(
        (t: string) => !['shell', 'read_file', 'get_location'].includes(t)
      ),
      overrides: {
        'enabledTools.shell': true,
        'enabledTools.read_file': true,
        'enabledTools.get_location': true,
        systemPrompt: true
      }
    }
    if (hostCwd) A.eng.setChatRow(id, { host_cwd: JSON.stringify(hostCwd) })
    A.conn
      .prepare(
        'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, 'Chat', JSON.stringify(next), randomUUID(), 1, 1)
    return id
  }
  const celChat = noisy(null) // sem hostCwd: "rodou no celular"
  const pcChat = noisy({ deviceId: 'pc', path: '/home/x' })
  await synced(A, B)
  assert.equal(serverPlain(A, 'chat', celChat).hostCwd, undefined, 'chat do celular sem hostCwd')
  assert.ok(serverPlain(A, 'chat', pcChat).hostCwd, 'chat do computador com hostCwd')
  // B já tinha limpado: não mexe nos chats novos (uma vez por dispositivo)
  assert.equal(Object.keys(rawConfig(B.conn, celChat).overrides).length, 4)
  // um dispositivo novo (C) limpa depois do pull completo e envia
  const C = device('C')
  await login(C, email)
  await synced(C, A, B)
  for (const d of [A, B, C]) {
    assert.deepEqual(
      Object.keys(rawConfig(d.conn, celChat).overrides).sort(),
      ['enabledTools.get_location', 'systemPrompt'],
      `${d.name}: no chat do celular, as do computador voltaram a herdar`
    )
    assert.deepEqual(
      Object.keys(rawConfig(d.conn, pcChat).overrides).sort(),
      ['enabledTools.read_file', 'enabledTools.shell', 'systemPrompt'],
      `${d.name}: no chat do computador, a do celular voltou a herdar`
    )
    assert.ok(effective(d.conn, celChat).enabledTools.includes('shell'))
    assert.ok(effective(d.conn, pcChat).enabledTools.includes('get_location'))
  }
  // uma escolha explícita depois da limpeza não é desfeita num pull seguinte
  editChat(C.conn, celChat, {
    enabledTools: effective(C.conn, celChat).enabledTools.filter((t: string) => t !== 'list_dir')
  })
  await synced(C, A)
  await C.eng.syncNow()
  assert.ok(
    rawConfig(C.conn, celChat).overrides['enabledTools.list_dir'],
    'escolha do usuário fica'
  )
})
