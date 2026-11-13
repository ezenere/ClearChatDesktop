/* eslint-disable @typescript-eslint/no-explicit-any */
// Herança ao vivo da persona no main (src/main/repo.ts + src/main/chatInherit.ts, protocolo 1.10.0):
// chatsRepo devolve a config EFETIVA (persona ao vivo) e grava o REGISTRO (cópia + overrides), a
// sessão principal segue o modelo efetivo, patches de edição/voltar a herdar/troca/"Nenhuma",
// persona apagada congela, migração local dos chats antigos. Banco temporário (userData isolado;
// `electron` substituído por stub — padrão de e2e/voiceSettings.test.ts).
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-inherit-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

process.env.CLEARCHAT_TEST_USERDATA = TMP
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export default { app }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

type RepoMod = typeof import('../src/main/repo.ts')
let repoMod: RepoMod | null = null
async function repo(): Promise<RepoMod> {
  repoMod ??= await import('../src/main/repo.ts')
  return repoMod
}
after(async () => {
  if (repoMod) (await import('../src/main/db.ts')).closeDb()
})

async function setup(): Promise<{ r: RepoMod; pa: string; pb: string }> {
  const r = await repo()
  const or = r.providersRepo.create({
    name: 'OR',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-1'
  })
  const lo = r.providersRepo.create({
    name: 'Local',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'x'
  })
  r.settingsRepo.set('defaultProviderId', or.id)
  r.settingsRepo.set('defaultModel', 'base/model')
  const pa = r.presetsRepo.create({
    name: `A${Math.random()}`,
    config: { systemPrompt: 'A', model: 'a/model', providerId: or.id, autoCompact: true }
  }).id
  const pb = r.presetsRepo.create({
    name: `B${Math.random()}`,
    config: { systemPrompt: 'B', model: 'b/model', providerId: lo.id, autoCompact: false }
  }).id
  return { r, pa, pb }
}

const rawOf = async (id: string): Promise<any> => {
  const { getDb } = await import('../src/main/db.ts')
  return JSON.parse(
    (getDb().prepare('SELECT config_json FROM chats WHERE id = ?').get(id) as any).config_json
  )
}

test('criar com persona: herda ao vivo; editar a persona muda o chat (e o modelo da sessão principal) sem regravá-lo', async () => {
  const { r, pa } = await setup()
  const { chat, session } = r.chatsRepo.create({
    config: { presetId: pa, overrides: {}, cwd: TMP } as never
  })
  assert.deepEqual(chat.config.overrides, {})
  assert.equal(chat.config.systemPrompt, 'A')
  assert.equal(session.model, 'a/model')
  const before = JSON.stringify(await rawOf(chat.id))
  r.presetsRepo.update(pa, {
    config: { systemPrompt: 'A2', model: 'a/model-2', autoCompact: true }
  })
  const eff = r.chatsRepo.get(chat.id)!
  assert.equal(eff.config.systemPrompt, 'A2')
  // a persona não define mais o provedor → o modelo dela no provedor padrão
  assert.equal(eff.config.model, 'a/model-2')
  assert.equal(r.sessionsRepo.get(session.id)!.model, 'a/model-2', 'sessão principal segue')
  assert.equal(r.sessionsRepo.list(chat.id)[0].model, 'a/model-2')
  assert.equal(JSON.stringify(await rawOf(chat.id)), before, 'nenhuma escrita no chat')
})

test('editar no chat marca como próprio; título/estado não mexem na cópia; overrides = voltar a herdar', async () => {
  const { r, pa } = await setup()
  const { chat } = r.chatsRepo.create({
    config: { presetId: pa, overrides: {}, cwd: TMP } as never
  })
  let res = r.chatsRepo.update(chat.id, { config: { systemPrompt: 'meu' } })
  assert.deepEqual(res.chat.config.overrides, { systemPrompt: true })
  r.presetsRepo.update(pa, { config: { systemPrompt: 'A3', autoCompact: false } })
  res = r.chatsRepo.update(chat.id, { title: 'renomeado' })
  assert.equal(res.chat.config.systemPrompt, 'meu')
  assert.equal(res.chat.config.autoCompact, false, 'herdado ao vivo')
  assert.equal((await rawOf(chat.id)).autoCompact, true, 'a cópia não é regravada no título')
  // capturedContext (estado do chat) não vira unidade
  res = r.chatsRepo.update(chat.id, {
    config: { capturedContext: { main: { text: 'x', updatedAt: 1, by: 'user' } } }
  })
  assert.deepEqual(res.chat.config.overrides, { systemPrompt: true })
  res = r.chatsRepo.update(chat.id, { config: { overrides: {} } as never })
  assert.equal(res.chat.config.systemPrompt, 'A3')
  const raw = await rawOf(chat.id)
  assert.equal(raw.systemPrompt, 'A3', 'voltar a herdar grava a cópia')
  assert.equal(raw.autoCompact, false)
})

test('trocar de persona mantém os próprios (modelChanged); "Nenhuma" congela', async () => {
  const { r, pa, pb } = await setup()
  const { chat } = r.chatsRepo.create({
    config: { presetId: pa, overrides: {}, cwd: TMP } as never
  })
  r.chatsRepo.update(chat.id, { config: { autoCompact: false } })
  const sw = r.chatsRepo.update(chat.id, { config: { presetId: pb } })
  assert.equal(sw.modelChanged, true)
  assert.equal(sw.chat.config.systemPrompt, 'B')
  assert.equal(sw.chat.config.model, 'b/model')
  assert.equal(sw.chat.config.cacheEnabled, false, 'cache herdado segue o provedor (openai)')
  assert.deepEqual(sw.chat.config.overrides, { autoCompact: true })
  const none = r.chatsRepo.update(chat.id, { config: { presetId: null } as never })
  assert.equal(none.chat.config.presetId, undefined)
  r.presetsRepo.update(pb, { config: { systemPrompt: 'B2' } })
  assert.equal(r.chatsRepo.get(chat.id)!.config.systemPrompt, 'B', 'congelado')
})

test('apagar a persona congela os chats dela (presetId sai, valores efetivos ficam)', async () => {
  const { r, pa } = await setup()
  const { chat } = r.chatsRepo.create({
    config: { presetId: pa, overrides: {}, cwd: TMP } as never
  })
  r.presetsRepo.update(pa, { config: { systemPrompt: 'última', autoCompact: true } })
  assert.deepEqual(r.presetsRepo.delete(pa), [chat.id])
  const raw = await rawOf(chat.id)
  assert.equal(raw.presetId, undefined)
  assert.equal(raw.systemPrompt, 'última')
  assert.deepEqual(raw.overrides, {})
})

test('Novo chat sem overrides (API/testes) e chat legado migrado localmente', async () => {
  const { r, pa } = await setup()
  const { chat } = r.chatsRepo.create({
    config: { presetId: pa, cwd: TMP, systemPrompt: 'A', enabledTools: ['read_file'] }
  })
  assert.ok(!chat.config.overrides?.systemPrompt, 'igual à persona → herda')
  assert.ok(chat.config.overrides?.['enabledTools.shell'], 'tools diferentes → próprias')
  // chat antigo (cópia, sem overrides) → migra
  const { getDb } = await import('../src/main/db.ts')
  const legacy = { ...(await rawOf(chat.id)), autoCompact: false }
  delete legacy.overrides
  getDb()
    .prepare('UPDATE chats SET config_json = ? WHERE id = ?')
    .run(JSON.stringify(legacy), chat.id)
  assert.equal(r.chatsRepo.get(chat.id)!.config.autoCompact, false, 'antes: vale a cópia')
  assert.ok(r.chatsRepo.migrateInheritance().includes(chat.id))
  const m = await rawOf(chat.id)
  assert.equal(m.overrides.autoCompact, true)
  assert.equal(m.overrides.systemPrompt, undefined)
  assert.deepEqual(r.chatsRepo.migrateInheritance(), [], 'uma vez só')
})

test('migração: tools de um tipo de aparelho — só viram próprias se o chat rodou naquele tipo', async () => {
  const { r, pa } = await setup()
  const { getDb } = await import('../src/main/db.ts')
  const { ensureSyncSchema } = await import('../src/main/sync/schema.ts')
  const { chatRanOnHere } = await import('../src/main/chatInherit.ts')
  const { TOOL_NAMES } = await import('../src/shared/tools.ts')
  const db = getDb()
  ensureSyncSchema(db)
  // chats antigos (sem overrides): sem as tools do celular e com o shell desligado
  const legacyChat = async (): Promise<string> => {
    const { chat } = r.chatsRepo.create({ config: { presetId: pa, cwd: TMP, overrides: {} } })
    const raw = { ...(await rawOf(chat.id)), enabledTools: TOOL_NAMES.filter((t) => t !== 'shell') }
    delete raw.overrides
    db.prepare('UPDATE chats SET config_json = ? WHERE id = ?').run(JSON.stringify(raw), chat.id)
    return chat.id
  }
  const synced = (id: string): void => {
    db.prepare(
      "INSERT INTO sync_records (type, id, scope, rev, base) VALUES ('chat', ?, ?, 1, '{}')"
    ).run(id, id)
  }
  // local deste computador (nunca foi ao servidor)
  const local = await legacyChat()
  // sincronizado, rodou num computador (hostCwd)
  const pc = await legacyChat()
  synced(pc)
  db.prepare('INSERT INTO sync_chat (chat_id, host_cwd) VALUES (?, ?)').run(
    pc,
    JSON.stringify({ deviceId: 'outro-pc', path: '/home/x' })
  )
  // sincronizado, sem hostCwd (criado/rodado no celular)
  const phone = await legacyChat()
  synced(phone)
  // só ao vivo hospedado aqui (§23): local deste computador
  const live = await legacyChat()
  synced(live)
  db.prepare("UPDATE chats SET storage = 'live' WHERE id = ?").run(live)

  assert.deepEqual(chatRanOnHere(db, local), { computer: true, phone: false })
  assert.deepEqual(chatRanOnHere(db, pc), { computer: true, phone: false })
  assert.deepEqual(chatRanOnHere(db, phone), { computer: false, phone: true })
  assert.deepEqual(chatRanOnHere(db, live), { computer: true, phone: false })

  const ids = r.chatsRepo.migrateInheritance()
  for (const id of [local, pc, phone, live]) assert.ok(ids.includes(id), id)
  // rodou num computador: o "shell desligado" fica próprio; as do celular herdam
  for (const id of [local, pc, live]) {
    const m = await rawOf(id)
    assert.deepEqual(m.overrides, { 'enabledTools.shell': true }, id)
    const eff = r.chatsRepo.get(id)!.config
    assert.ok(!eff.enabledTools.includes('shell'))
    assert.ok(eff.enabledTools.includes('get_location' as never), 'herda a do celular')
  }
  // só no celular: o shell herda (roda sem ele no celular); as do celular desligadas ficam próprias
  const m = await rawOf(phone)
  assert.deepEqual(m.overrides, {
    'enabledTools.get_location': true,
    'enabledTools.nearby_places': true
  })
  assert.ok(r.chatsRepo.get(phone)!.config.enabledTools.includes('shell'))
})

test('regravar o chat preserva tools que o desktop não conhece (lista e overrides)', async () => {
  const { r, pa } = await setup()
  const { chat } = r.chatsRepo.create({ config: { presetId: pa, cwd: TMP, overrides: {} } })
  // registro vindo do celular: marca própria numa tool do celular + uma desconhecida na lista
  const { getDb } = await import('../src/main/db.ts')
  const raw = await rawOf(chat.id)
  raw.enabledTools = [...raw.enabledTools.filter((t: string) => t !== 'get_location'), 'mcp_x']
  raw.overrides = { 'enabledTools.get_location': true, 'enabledTools.mcp_x': true }
  getDb().prepare('UPDATE chats SET config_json = ? WHERE id = ?').run(JSON.stringify(raw), chat.id)
  // edição no desktop (outra tool + outro campo) e voltar a herdar outra unidade
  r.chatsRepo.update(chat.id, { config: { autoCompact: false } })
  const eff = r.chatsRepo.get(chat.id)!.config
  r.chatsRepo.update(chat.id, {
    config: { enabledTools: eff.enabledTools.filter((t) => t !== 'shell') }
  })
  let rec = await rawOf(chat.id)
  assert.ok(rec.overrides['enabledTools.get_location'] && rec.overrides['enabledTools.mcp_x'])
  assert.ok(rec.overrides['enabledTools.shell'] && rec.overrides.autoCompact)
  assert.ok(rec.enabledTools.includes('mcp_x') && rec.enabledTools.includes('nearby_places'))
  assert.ok(!rec.enabledTools.includes('get_location'))
  const ov = { ...rec.overrides }
  delete ov.autoCompact
  r.chatsRepo.update(chat.id, { config: { overrides: ov } })
  rec = await rawOf(chat.id)
  assert.deepEqual(Object.keys(rec.overrides).sort(), [
    'enabledTools.get_location',
    'enabledTools.mcp_x',
    'enabledTools.shell'
  ])
  assert.ok(rec.enabledTools.includes('mcp_x') && !rec.enabledTools.includes('get_location'))
  // persona com a lista (inclusive as do celular e a desconhecida): salvar/ler preserva
  const p = r.presetsRepo.create({
    name: `T${Math.random()}`,
    config: { enabledTools: ['web_search', 'get_location', 'mcp_x'] as never }
  })
  assert.deepEqual(r.presetsRepo.get(p.id)!.config.enabledTools, [
    'web_search',
    'get_location',
    'mcp_x'
  ])
})
