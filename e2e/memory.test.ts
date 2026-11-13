/* eslint-disable @typescript-eslint/no-explicit-any */
// Memória modular (SPEC → Memória). Parte A: repositório, limites, slug/FTS, resolução da config e
// herança de persona, índice (agrupamento, fixadas, substituídas, teto), snapshot por sessão, tools,
// extração com modelo falso roteirizado e exclusão das mensagens só de exibição — sobre um SQLite
// temporário, sem Electron. Parte B: runner real (módulo `electron` substituído por um stub) com um
// provedor OpenAI-compatible falso em 127.0.0.1: índice na request, memory_write pelo agente,
// sessão nova vendo a memória, extração agora, extração após compactação, subagentes.
// Rodar: npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SCHEMA } from '../src/main/dbSchema.ts'
import { MemoryService } from '../src/main/memory/service.ts'
import { removeChatMemory } from '../src/main/memory/schema.ts'
import { MemoryError, slugify, validateMemoryFields } from '../src/main/memory/store.ts'
import { activeMemory } from '../src/main/memory/config.ts'
import { hideSuperseded, indexGroups, renderIndex } from '../src/main/memory/render.ts'
import {
  extractionConversation,
  extractionSummaryText,
  runExtraction
} from '../src/main/memory/extraction.ts'
import { applyOps, runMemoryTool } from '../src/main/tools/memory.ts'
import { buildRequest, setMemorySources } from '../src/main/agent/request.ts'
import {
  DEFAULT_CHAT_CONFIG,
  DEFAULT_MEMORY_EXTRACTION_PROMPT,
  DEFAULT_MEMORY_HELP_PROMPT
} from '../src/shared/defaults.ts'
import { defaultMemoryConfig, normalizeMemoryConfig } from '../src/shared/memory.ts'
import { applyPreset, PRESET_FIELDS, sanitizePresetConfig } from '../src/shared/presets.ts'
import { contextUsage, hasCompactableHistory, isDisplayOnly } from '../src/shared/context.ts'
import { MEMORY_LIMITS } from '../src/shared/limits.ts'
import {
  MEMORY_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_LABELS,
  TOOL_NAMES
} from '../src/shared/tools.ts'
import {
  APPROVAL_ITEMS,
  approvalRoute,
  DEFAULT_APPROVAL_MODES,
  modeLabel,
  TOOL_ITEM
} from '../src/shared/approvalPolicy.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-memory-'))

// ---------------- banco temporário (parte A) ----------------

function openDb(name: string): Database.Database {
  const conn = new Database(join(TMP, name))
  conn.pragma('foreign_keys = ON')
  conn.exec(SCHEMA)
  return conn
}

let chatN = 0
function insertChat(conn: Database.Database, memory?: any): { chat: any; sessionId: string } {
  const id = `chat-${++chatN}`
  const config = { ...DEFAULT_CHAT_CONFIG('/tmp'), providerId: 'p', model: 'm', memory }
  conn
    .prepare(
      'INSERT INTO chats (id, title, config_json, main_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)'
    )
    .run(id, 't', JSON.stringify(config), `${id}-s`)
  conn
    .prepare(
      "INSERT INTO sessions (id, chat_id, depth, model, title, status, created_at) VALUES (?, ?, 0, 'm', 'Principal', 'idle', 0)"
    )
    .run(`${id}-s`, id)
  return { chat: { id, title: 't', config, mainSessionId: `${id}-s` }, sessionId: `${id}-s` }
}

const mem = (over: any = {}): any => ({ ...defaultMemoryConfig(), enabled: true, ...over })
const env = { os: 'L', shell: 'bash' }
const provider: any = {
  id: 'p',
  name: 'P',
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'k',
  headers: {},
  kind: 'openai',
  createdAt: 0
}
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

// ---------------- repositório ----------------

test('repositório: CRUD, limites legíveis, slug único e [[slug]] preservado, mover só na categoria', () => {
  const conn = openDb('repo.db')
  const changes: any[] = []
  const svc = new MemoryService(conn, { onChange: (c, m) => changes.push([c, m]) })
  const s = svc.store
  const perfil = s.createCollection({ category: 'profile', name: 'Padrão', description: 'eu' })
  const perfil2 = s.createCollection({ category: 'profile', name: 'Trabalho' })
  const areas = s.createCollection({ category: 'areas', name: 'Projeto TCC' })
  assert.equal(perfil.count, 0)
  assert.ok(changes.some((c) => c[0] === perfil.id))
  assert.throws(
    () => s.createCollection({ category: 'xx' as any, name: 'a' }),
    /Categoria inválida/
  )
  assert.throws(() => s.createCollection({ category: 'areas', name: '  ' }), /obrigatório/)

  const m = s.createMemory(
    {
      collectionId: perfil.id,
      title: 'Eduardo Zenere',
      summary: 'Engenheiro de software em São Paulo',
      facts: ['Trabalha com  Electron', 'trabalha com electron', 'Ver [[projeto-tcc]]']
    },
    { updatedBy: 'model', chatId: 'c1' }
  )
  assert.match(m.id, /^m[0-9a-z]{7}$/)
  assert.equal(m.slug, 'eduardo-zenere')
  assert.equal(m.category, 'profile')
  assert.deepEqual(m.facts, ['Trabalha com Electron', 'Ver [[projeto-tcc]]'], 'dedupe + espaços')
  assert.equal(m.updatedBy, 'model')
  assert.equal(m.updatedByChatId, 'c1')
  const m2 = s.createMemory({ collectionId: perfil2.id, title: 'Eduardo Zenere' })
  assert.equal(m2.slug, 'eduardo-zenere-2', 'slug único global')
  assert.equal(s.findMemory('[[eduardo-zenere]]')!.id, m.id)
  assert.equal(s.findMemory('eduardo-zenere-2')!.id, m2.id)
  assert.equal(slugify('Projeto TCC (2026) — Ação!'), 'projeto-tcc-2026-acao')

  // limites
  const L = MEMORY_LIMITS
  assert.throws(
    () => s.createMemory({ collectionId: perfil.id, title: 'x'.repeat(L.titleChars + 1) }),
    (e: any) => e instanceof MemoryError && /Título longo demais \(81\/80/.test(e.message)
  )
  assert.throws(
    () => validateMemoryFields({ title: 'a', summary: 's'.repeat(L.summaryChars + 1) }),
    /Resumo longo demais \(161\/160/
  )
  assert.throws(
    () => validateMemoryFields({ title: 'a', facts: ['f'.repeat(L.factChars + 1)] }),
    /Tópico longo demais \(201\/200/
  )
  assert.throws(
    () =>
      validateMemoryFields({ title: 'a', facts: Array.from({ length: 16 }, (_, i) => `f${i}`) }),
    /Tópicos demais \(16\/15\)/
  )

  // update: slug estável, mover só para a mesma categoria
  const up = s.updateMemory(m.id, { title: 'Eduardo Z.', pinned: true }, { updatedBy: 'user' })
  assert.equal(up.slug, 'eduardo-zenere', 'slug não muda')
  assert.equal(up.pinned, true)
  assert.equal(s.updateMemory(m.id, { collectionId: perfil2.id }).collectionId, perfil2.id)
  assert.throws(
    () => s.updateMemory(m.id, { collectionId: areas.id }),
    /mesma categoria \(Perfil\)/
  )

  // listagem / busca (sem acento, prefixo)
  s.createMemory({ collectionId: areas.id, title: 'TCC', summary: 'Monografia sobre CRDTs' })
  assert.equal(s.listCollections().find((c) => c.id === perfil2.id)!.count, 2)
  assert.deepEqual(
    s.listMemories({ query: 'sao paulo' }).map((x) => x.id),
    [m.id]
  )
  assert.equal(s.listMemories({ query: 'monograf' }).length, 1)
  assert.equal(s.listMemories({ category: 'areas' }).length, 1)
  const hit = s.search('electron', { collectionIds: [perfil2.id] })
  assert.equal(hit[0].memory.id, m.id)
  assert.equal(hit[0].snippet, 'Trabalha com Electron')

  // semelhança (FTS no título + slug)
  assert.deepEqual(
    s.similar(areas.id, 'Projeto do TCC').map((x) => x.title),
    ['TCC']
  )
  assert.equal(s.similar(areas.id, 'Viagem ao Japão').length, 0)

  // apagar coleção apaga as memórias (e o FTS)
  s.deleteCollection(perfil2.id)
  assert.equal(s.getMemory(m.id), null)
  assert.equal(s.listMemories({ query: 'electron' }).length, 0)
  const fts = conn.prepare('SELECT COUNT(*) AS n FROM memories_fts').get() as any
  assert.equal(fts.n, 1)
  conn.close()
})

test('migração: remove a antiga memória do chat (coleções scope chat + memórias, chatMemory nas configs); idempotente', () => {
  const conn = openDb('chat.db')
  const svc = new MemoryService(conn)
  const shared = svc.store.createCollection({ category: 'areas', name: 'TCC' })
  const keep = svc.store.createMemory({ collectionId: shared.id, title: 'Fica' })
  // estado legado: chat com chatMemory + coleções "Este chat" com memórias; persona com chatMemory
  const { chat } = insertChat(conn, { ...mem({ collections: [shared.id] }), chatMemory: true })
  const legacy = (id: string, category: string): void => {
    conn
      .prepare(
        "INSERT INTO memory_collections (id, category, name, description, scope, chat_id, created_at, updated_at) VALUES (?, ?, 'Este chat', '', 'chat', ?, 0, 0)"
      )
      .run(id, category, chat.id)
  }
  const legacyMemory = (id: string, collectionId: string, category: string): void => {
    conn
      .prepare(
        'INSERT INTO memories (id, collection_id, category, title, slug, facts_json, created_at, updated_at, supersedes_id) VALUES (?, ?, ?, ?, ?, \'["x"]\', 0, 0, ?)'
      )
      .run(id, collectionId, category, `T ${id}`, `t-${id}`, id === 'mlx' ? keep.id : null)
  }
  legacy('legacy-areas', 'areas')
  legacy('legacy-people', 'people')
  legacyMemory('mlx', 'legacy-areas', 'areas') // substituía uma memória compartilhada
  legacyMemory('mly', 'legacy-areas', 'areas')
  legacyMemory('mlz', 'legacy-people', 'people')
  const m1 = { id: 'mlx' }
  conn
    .prepare(
      "INSERT INTO presets (id, name, config_json, created_at, updated_at) VALUES ('pr', 'P', ?, 0, 0)"
    )
    .run(JSON.stringify({ memory: { ...mem({ collections: [shared.id] }), chatMemory: false } }))
  conn
    .prepare(
      "INSERT INTO presets (id, name, config_json, created_at, updated_at) VALUES ('pr2', 'Q', ?, 0, 0)"
    )
    .run(JSON.stringify({ model: 'x' }))
  // coleções legadas nunca são lidas pela API pública
  assert.equal(svc.store.getCollection('legacy-areas'), null)
  assert.deepEqual(
    svc.store.listCollections().map((c) => c.id),
    [shared.id]
  )

  const r = removeChatMemory(conn)
  assert.deepEqual(r, { collections: 2, memories: 3, chats: 1, presets: 1 })
  const n = (sql: string): number => (conn.prepare(sql).get() as { n: number }).n
  assert.equal(n("SELECT COUNT(*) AS n FROM memory_collections WHERE scope = 'chat'"), 0)
  assert.equal(n('SELECT COUNT(*) AS n FROM memories'), 1)
  assert.equal(svc.store.getMemory(m1.id), null)
  assert.equal(svc.store.getMemory(keep.id)?.title, 'Fica')
  assert.equal(n('SELECT COUNT(*) AS n FROM memories_fts'), 1, 'FTS sem as apagadas')
  const cfgOf = (table: string, id: string): any =>
    JSON.parse(
      (conn.prepare(`SELECT config_json FROM ${table} WHERE id = ?`).get(id) as any).config_json
    )
  const chatCfg = cfgOf('chats', chat.id)
  assert.ok(!('chatMemory' in chatCfg.memory))
  assert.deepEqual(chatCfg.memory.collections, [shared.id], 'resto da config intacto')
  assert.ok(!('chatMemory' in cfgOf('presets', 'pr').memory))
  assert.deepEqual(cfgOf('presets', 'pr2'), { model: 'x' })

  // idempotente: de novo (e ao reabrir o schema) nada muda
  assert.deepEqual(removeChatMemory(conn), { collections: 0, memories: 0, chats: 0, presets: 0 })
  new MemoryService(conn)
  assert.equal(n('SELECT COUNT(*) AS n FROM memories'), 1)
  // sem tabelas de chats/personas (banco só com a memória) não quebra
  const bare = new Database(join(TMP, 'bare.db'))
  new MemoryService(bare)
  assert.deepEqual(removeChatMemory(bare), { collections: 0, memories: 0, chats: 0, presets: 0 })
  bare.close()
  const cols = (conn.prepare('PRAGMA table_info(sessions)').all() as any[]).map((x) => x.name)
  assert.ok(cols.includes('memory_json'))
  conn.close()
})

test('migração ao abrir: ensureMemorySchema apaga coleções scope chat já existentes', () => {
  const conn = openDb('chat-open.db')
  new MemoryService(conn)
  const { chat } = insertChat(conn, { ...mem(), chatMemory: true })
  conn
    .prepare(
      "INSERT INTO memory_collections (id, category, name, scope, chat_id, created_at, updated_at) VALUES ('lc', 'areas', 'Este chat', 'chat', ?, 0, 0)"
    )
    .run(chat.id)
  conn
    .prepare(
      "INSERT INTO memories (id, collection_id, category, title, slug, created_at, updated_at) VALUES ('mlc', 'lc', 'areas', 'T', 't', 0, 0)"
    )
    .run()
  const svc = new MemoryService(conn) // reabre: migração roda
  assert.equal(svc.store.listMemories({}).length, 0)
  assert.equal((conn.prepare('SELECT COUNT(*) AS n FROM memory_collections').get() as any).n, 0)
  const cfg = JSON.parse(
    (conn.prepare('SELECT config_json FROM chats WHERE id = ?').get(chat.id) as any).config_json
  )
  assert.equal(cfg.memory.chatMemory, undefined)
  conn.close()
})

// ---------------- config / herança ----------------

test('config: regra de envio, categorias, writeTo validado, subagentes', () => {
  const conn = openDb('config.db')
  const svc = new MemoryService(conn)
  const s = svc.store
  const p = s.createCollection({ category: 'profile', name: 'Padrão' })
  const a = s.createCollection({ category: 'areas', name: 'TCC' })
  const a2 = s.createCollection({ category: 'areas', name: 'Outro' })
  const am = (memory: any, depth = 0): any =>
    activeMemory(s, { id: 'c', config: { memory } } as any, { depth })

  assert.equal(am(undefined).active, false, 'ausente = desligada')
  assert.deepEqual(am(undefined).tools, [])
  assert.equal(am(mem({ enabled: false, collections: [p.id] })).active, false)
  assert.equal(am(mem({ collections: [] })).active, false, 'nada ativo')
  assert.equal(am(mem({ collections: ['nao-existe'] })).active, false)

  const ro = am(mem({ collections: [p.id, a.id] }))
  assert.equal(ro.active, true)
  assert.deepEqual(ro.tools, ['memory_search', 'memory_read'], 'sem destino de escrita: só leitura')
  assert.equal(ro.canWrite, false)

  const w = am(mem({ collections: [p.id, a.id], writeTo: { areas: a.id, profile: a2.id } }))
  assert.equal(w.writeTo.areas?.id, a.id)
  assert.equal(w.writeTo.profile, null, 'writeTo de outra categoria → null')
  assert.deepEqual(w.tools, MEMORY_TOOL_NAMES)
  assert.equal(
    am(mem({ collections: [p.id], writeTo: { areas: a.id } })).canWrite,
    false,
    'writeTo fora das ativas'
  )

  const off = am(
    mem({ collections: [p.id, a.id], writeTo: { areas: a.id }, categories: ['profile'] })
  )
  assert.deepEqual(off.categories, ['profile'])
  assert.deepEqual(
    off.collections.map((c: any) => c.id),
    [p.id],
    'categoria desligada ignora as coleções'
  )
  assert.equal(off.canWrite, false)
  assert.equal(am(mem({ collections: [p.id], categories: [] })).active, false)

  // chatMemory legado não ativa nada: sem coleção ativa → nada vai
  const legacy = am({ ...mem(), chatMemory: true })
  assert.equal(legacy.active, false, 'chatMemory legado é ignorado')
  assert.deepEqual(legacy.tools, [])
  assert.equal(am({ ...mem({ collections: [p.id] }), chatMemory: true }).canWrite, false)

  // subagentes: só leitura, só com a opção; nunca escrita
  assert.equal(am(mem({ collections: [p.id], writeTo: { profile: p.id } }), 1).active, false)
  const sub = am(mem({ collections: [p.id], writeTo: { profile: p.id }, subagents: true }), 1)
  assert.deepEqual(sub.tools, ['memory_search', 'memory_read'])
  assert.equal(sub.canWrite, false)
  assert.equal(am(mem({ enabled: false, collections: [p.id], subagents: true }), 1).active, false)

  // chave muda com a config, não com memórias novas
  const k1 = w.key
  s.createMemory({ collectionId: a.id, title: 'Nova' })
  assert.equal(
    am(mem({ collections: [p.id, a.id], writeTo: { areas: a.id, profile: a2.id } })).key,
    k1
  )
  assert.notEqual(am(mem({ collections: [p.id, a.id] })).key, k1)
  conn.close()
})

test('config: normalização (chatMemory legado descartado) e herança de persona', () => {
  assert.ok((PRESET_FIELDS as readonly string[]).includes('memory'))
  const n = normalizeMemoryConfig({
    enabled: true,
    collections: ['a', 'a', 3],
    writeTo: { areas: 'a', xx: 'b', people: '' },
    categories: ['areas', 'zz'],
    chatMemory: true
  })
  assert.deepEqual(n.collections, ['a'])
  assert.deepEqual(n.writeTo, { areas: 'a', people: null })
  assert.deepEqual(n.categories, ['areas'])
  assert.ok(!('chatMemory' in n), 'chatMemory legado descartado')
  assert.ok(!('chatMemory' in defaultMemoryConfig()))
  assert.equal(normalizeMemoryConfig(null).enabled, false)
  const preset = sanitizePresetConfig({
    memory: { ...mem({ collections: ['x'] }), chatMemory: true }
  })
  assert.ok(!('chatMemory' in preset.memory!), 'persona salva sem chatMemory')
  assert.deepEqual(preset.memory!.collections, ['x'])
  const base = { ...DEFAULT_CHAT_CONFIG('/tmp'), memory: mem({ collections: ['y'] }) }
  const applied = applyPreset(base, preset)
  assert.deepEqual(applied.memory!.collections, ['x'], 'chat herda a seleção da persona')
  assert.ok(!('chatMemory' in applied.memory!))
})

test('tools e aprovações: nomes, rótulos, itens com padrão "Sempre permitir" e "Perguntar"', () => {
  for (const t of MEMORY_TOOL_NAMES) {
    assert.ok(!TOOL_NAMES.includes(t), 'fora de enabledTools')
    assert.equal(TOOL_DEFINITIONS[t].function.name, t)
  }
  assert.deepEqual(
    MEMORY_TOOL_NAMES.map((t) => TOOL_LABELS[t]),
    ['Buscar memória', 'Ler memória', 'Gravar memória', 'Reescrever memória', 'Apagar memória']
  )
  const wd = TOOL_DEFINITIONS.memory_write.function.description
  for (const k of ['profile', 'topics', 'areas', 'people', 'preferences', 'Discrepância'])
    assert.ok(wd.includes(k), k)
  // sem memória "do chat": nada de target nem da regra global × chat
  for (const t of ['memory_write', 'memory_rewrite'] as const) {
    const f = TOOL_DEFINITIONS[t].function
    assert.ok(!('target' in (f.parameters as any).properties), `${t} sem target`)
    assert.doesNotMatch(f.description, /target|Global × chat|memória do chat/)
  }
  assert.doesNotMatch(TOOL_DEFINITIONS.memory_delete.function.description, /deste chat/)
  for (const p of [DEFAULT_MEMORY_HELP_PROMPT, DEFAULT_MEMORY_EXTRACTION_PROMPT]) {
    assert.doesNotMatch(p, /target|Global × chat/)
    assert.match(p, /contradiz|Discrepâncias/)
  }
  for (const item of ['memory_write', 'memory_rewrite', 'memory_delete'] as const) {
    assert.ok(APPROVAL_ITEMS.includes(item))
    assert.equal(TOOL_ITEM[item], item)
    assert.equal(DEFAULT_APPROVAL_MODES[item], 'always')
    assert.equal(modeLabel(item, 'lists'), 'Perguntar')
  }
  assert.deepEqual(approvalRoute({ approvalModes: {} } as any, {}, 'memory_write'), { kind: 'run' })
  assert.deepEqual(
    approvalRoute({ approvalModes: { memory_delete: 'lists' } } as any, {}, 'memory_delete'),
    {
      kind: 'user'
    }
  )
  assert.deepEqual(approvalRoute({ approvalModes: {} } as any, {}, 'memory_search'), {
    kind: 'run'
  })
})

// ---------------- índice ----------------

test('índice: categoria → coleção (escrita/leitura) → memórias; fixadas com tópicos; substituídas ocultas; teto', () => {
  const conn = openDb('index.db')
  const svc = new MemoryService(conn)
  const s = svc.store
  const pAll = s.createCollection({ category: 'profile', name: 'Padrão', description: 'Quem sou' })
  const people = s.createCollection({ category: 'people', name: 'Família' })
  const peopleW = s.createCollection({ category: 'people', name: 'Minhas pessoas' })
  const ed = s.createMemory({
    collectionId: pAll.id,
    title: 'Eduardo',
    summary: 'Dev',
    facts: ['Mora em SP'],
    pinned: true
  })
  const ana = s.createMemory({
    collectionId: people.id,
    title: 'Ana',
    summary: 'Irmã',
    facts: ['Mora em Recife']
  })
  const ana2 = s.createMemory({
    collectionId: peopleW.id,
    title: 'Ana',
    summary: 'Irmã (mudou)',
    facts: ['Mora em Natal'],
    supersedesId: ana.id
  })
  const cfg = mem({
    collections: [people.id, pAll.id, peopleW.id],
    writeTo: { people: peopleW.id }
  })
  const am = activeMemory(s, { id: 'c', config: { memory: cfg } } as any, { depth: 0 })
  const text = svc.renderIndex(am)
  assert.ok(text.startsWith('<memory>') && text.endsWith('</memory>'))
  assert.ok(text.indexOf('## Perfil') < text.indexOf('## Pessoas'), 'ordem da taxonomia')
  assert.match(text, /### Padrão — leitura\nQuem sou/)
  assert.match(text, /### Minhas pessoas — escrita/)
  assert.ok(text.includes(`- ${ed.id} · Eduardo — Dev\n  1. Mora em SP`), 'fixada com tópicos')
  assert.ok(text.includes(`- ${ana2.id} · Ana — Irmã (mudou)`))
  assert.ok(!text.includes(`${ana.id} ·`), 'substituída oculta onde a substituta está ativa')
  assert.ok(!text.includes('Mora em Natal'), 'não fixada: sem tópicos')
  // sem a substituta ativa, a original aparece
  const am2 = activeMemory(
    s,
    { id: 'c', config: { memory: mem({ collections: [people.id] }) } } as any,
    { depth: 0 }
  )
  assert.ok(svc.renderIndex(am2).includes(`${ana.id} · Ana — Irmã`))
  assert.equal(hideSuperseded([ana, ana2]).length, 1)
  // teto: fixadas + recentes, com nota
  for (let i = 0; i < 40; i++)
    s.createMemory({ collectionId: peopleW.id, title: `Pessoa ${i}`, summary: 'x'.repeat(100) })
  const capped = renderIndex(indexGroups(s, am), { maxChars: 2500 })
  assert.ok(capped.length <= 2600, String(capped.length))
  assert.ok(capped.includes(`${ed.id} · Eduardo`), 'fixada sempre fica')
  assert.ok(capped.includes('Pessoa 39'), 'mais recente fica')
  assert.ok(!capped.includes('Pessoa 0 '), 'mais antiga sai')
  assert.match(capped, /fora do índice por tamanho — use memory_search/)
  conn.close()
})

// ---------------- snapshot + request ----------------

test('snapshot por sessão: congela no 1º request; renova em refresh/compactação/config; request e preview', () => {
  const conn = openDb('snap.db')
  const svc = new MemoryService(conn)
  setMemorySources({
    prompt: (chat, session) => svc.promptParts(chat, session),
    tools: (chat, session) => svc.active(chat, session).tools
  })
  try {
    const s = svc.store
    const col = s.createCollection({ category: 'areas', name: 'Projetos' })
    s.createMemory({ collectionId: col.id, title: 'Projeto Alfa', summary: 'App de notas' })
    const memory = mem({
      collections: [col.id],
      writeTo: { areas: col.id },
      helpPrompt: { enabled: true, text: null }
    })
    const { chat, sessionId } = insertChat(conn, memory)
    chat.config.toolsInPrompt = true
    // definições completas (a compactação, 1.11.0, tem testes próprios em compactTools.test.ts)
    chat.config.toolsCompact = false
    const session = { id: sessionId, depth: 0 as const, model: 'm' }

    // preview antes do 1º request: índice atual, ainda sem snapshot
    const pv = svc.preview(chat, session)
    assert.equal(pv.active, true)
    assert.equal(pv.snapshotAt, null)
    assert.match(pv.index!, /Projeto Alfa/)
    assert.equal(pv.help, DEFAULT_MEMORY_HELP_PROMPT)
    assert.deepEqual(pv.tools, MEMORY_TOOL_NAMES)

    svc.ensureSnapshot(chat, session)
    const at = svc.readState(sessionId).snapshot!.at
    s.createMemory({ collectionId: col.id, title: 'Projeto Beta', summary: 'Jogo' })
    const body = buildRequest(chat, session, [], provider, env).body as any
    const sys = textOf(body.messages[0].content)
    assert.ok(sys.includes('Projeto Alfa') && !sys.includes('Projeto Beta'), 'congelado')
    const iEnv = sys.indexOf('<environment>')
    const iMem = sys.indexOf('<memory>')
    const iHelp = sys.indexOf(DEFAULT_MEMORY_HELP_PROMPT.slice(0, 40))
    const iTools = sys.indexOf('memory_search')
    assert.ok(iEnv < iMem && iMem < iHelp, 'system → env → índice → help')
    assert.ok(
      sys.lastIndexOf('"name": "memory_search"') > iHelp ||
        sys.lastIndexOf('memory_search') > iHelp,
      'tools no prompt depois'
    )
    assert.ok(iTools > 0)
    const names = body.tools.map((t: any) => t.function.name)
    assert.deepEqual(names.slice(-5), MEMORY_TOOL_NAMES, 'tools de memória no fim')
    assert.equal(svc.preview(chat, session).snapshotAt, at)

    // refresh: inclui a nova
    svc.refreshSnapshot(chat, session)
    assert.match(svc.readState(sessionId).snapshot!.index, /Projeto Beta/)
    // compactação: limpa → próximo request tira outro
    s.createMemory({ collectionId: col.id, title: 'Projeto Gama', summary: 'Site' })
    svc.clearSnapshot(sessionId)
    assert.equal(svc.preview(chat, session).snapshotAt, null)
    svc.ensureSnapshot(chat, session)
    assert.match(svc.readState(sessionId).snapshot!.index, /Projeto Gama/)
    // config mudou (escrita removida) → snapshot obsoleto, índice atual sem "escrita"
    const ro = { ...chat, config: { ...chat.config, memory: { ...memory, writeTo: {} } } }
    assert.equal(svc.preview(ro, session).snapshotAt, null)
    assert.match(svc.preview(ro, session).index!, /Projetos — leitura/)
    assert.deepEqual(svc.preview(ro, session).tools, ['memory_search', 'memory_read'])
    // sem coleção de escrita em nenhuma categoria → request sem tools de escrita
    const roReq = buildRequest(
      { ...ro, config: { ...ro.config, toolsInPrompt: false } },
      session,
      [],
      provider,
      env
    ).body as any
    assert.deepEqual(
      roReq.tools.map((t: any) => t.function.name).filter((n: string) => n.startsWith('memory_')),
      ['memory_search', 'memory_read']
    )
    // chatMemory legado sem coleção ativa → nada de memória na request
    const legacyChat = {
      ...chat,
      config: {
        ...chat.config,
        toolsInPrompt: false,
        memory: { ...memory, collections: [], chatMemory: true }
      }
    }
    const legacy = buildRequest(legacyChat, session, [], provider, env).body as any
    assert.ok(!textOf(legacy.messages[0].content).includes('<memory>'))
    assert.ok(!legacy.tools.some((t: any) => t.function.name.startsWith('memory_')))

    // desligada → nada de memória na request
    const offChat = {
      ...chat,
      config: { ...chat.config, toolsInPrompt: false, memory: { ...memory, enabled: false } }
    }
    const off = buildRequest(offChat, session, [], provider, env).body as any
    assert.ok(!/memory|memória/i.test(textOf(off.messages[0].content)))
    assert.ok(!off.tools.some((t: any) => t.function.name.startsWith('memory_')))
    assert.equal(svc.preview(offChat, session).active, false)
    // subagente: nunca índice/help; tools só com a opção
    const sub = buildRequest(chat, { depth: 1, model: 'm' }, [], provider, env).body as any
    assert.ok(!textOf(sub.messages[0].content).includes('<memory>'))
    assert.ok(!sub.tools.some((t: any) => t.function.name.startsWith('memory_')))
    const subOn = { ...chat, config: { ...chat.config, memory: { ...memory, subagents: true } } }
    const sub2 = buildRequest(subOn, { depth: 1, model: 'm' }, [], provider, env).body as any
    assert.ok(!textOf(sub2.messages[0].content).includes('<memory>'))
    assert.ok(!textOf(sub2.messages[0].content).includes(DEFAULT_MEMORY_HELP_PROMPT.slice(0, 40)))
    assert.deepEqual(
      sub2.tools.map((t: any) => t.function.name).filter((n: string) => n.startsWith('memory_')),
      ['memory_search', 'memory_read']
    )
  } finally {
    setMemorySources({ prompt: () => null, tools: () => [] })
    conn.close()
  }
})

test('mensagens só de exibição (erro, extração) ficam fora da API, do contexto e da compactação', () => {
  const ext = {
    synthetic: true,
    kind: 'memory-extraction',
    memoryExtraction: {
      created: 1,
      updated: 0,
      deleted: 0,
      changes: [],
      trigger: 'manual',
      usage: { promptTokens: 999, completionTokens: 1 }
    }
  }
  const hist: any[] = [
    {
      id: '1',
      sessionId: 's',
      seq: 1,
      message: { role: 'user', content: 'oi' },
      meta: {},
      createdAt: 0
    },
    {
      id: '2',
      sessionId: 's',
      seq: 2,
      message: { role: 'assistant', content: 'olá' },
      meta: { usage: { promptTokens: 10, completionTokens: 2 } },
      createdAt: 0
    },
    {
      id: '3',
      sessionId: 's',
      seq: 3,
      message: { role: 'assistant', content: 'Extração de memórias: 1 criada.' },
      meta: ext,
      createdAt: 0
    }
  ]
  assert.ok(isDisplayOnly(ext as any))
  const body = buildRequest(
    { id: 'c', config: DEFAULT_CHAT_CONFIG('/tmp') } as any,
    { depth: 0, model: 'm' },
    hist,
    provider,
    env
  ).body as any
  assert.ok(!JSON.stringify(body.messages).includes('Extração de memórias'))
  assert.equal(contextUsage(hist)!.used, 12)
  assert.equal(hasCompactableHistory([hist[0], hist[2]]), false)
})

// ---------------- tools ----------------

test('tools: write (criar/atualizar/candidatas/force_new/sem coleção de escrita), rewrite, delete, read, search', () => {
  const conn = openDb('tools.db')
  const svc = new MemoryService(conn)
  const s = svc.store
  const fam = s.createCollection({ category: 'people', name: 'Família (compartilhada)' })
  const mine = s.createCollection({ category: 'people', name: 'Minhas pessoas' })
  const prof = s.createCollection({ category: 'profile', name: 'Perfil' })
  const ana = s.createMemory({
    collectionId: fam.id,
    title: 'Ana',
    summary: 'Irmã',
    facts: ['Mora em Recife', 'Gosta de café']
  })
  const memory = mem({
    collections: [fam.id, mine.id, prof.id],
    writeTo: { people: mine.id }
  })
  const { chat } = insertChat(conn, memory)
  const ctx = (): any => ({
    store: s,
    am: svc.active(chat, { depth: 0 }),
    by: { updatedBy: 'model', chatId: chat.id }
  })
  const run = (name: any, args: any): any => runMemoryTool(name, args, ctx())

  // criar na coleção de escrita da categoria
  let r = run('memory_write', {
    category: 'people',
    title: 'Bruno',
    summary: 'Amigo',
    ops: [{ op: 'add', fact: 'Joga xadrez' }]
  })
  assert.equal(r.status, 'ok', r.content)
  assert.equal(r.changes[0].op, 'create')
  const bruno = s.getMemory(r.changes[0].memoryId)!
  assert.equal(bruno.collectionId, mine.id)
  assert.equal(bruno.updatedBy, 'model')
  // parecida → não cria, devolve candidatas
  r = run('memory_write', {
    category: 'people',
    title: 'Bruno Lima',
    ops: [{ op: 'add', fact: 'x' }]
  })
  assert.equal(r.status, 'ok')
  assert.equal(r.changes, undefined)
  assert.match(r.content, /Nada foi criado/)
  assert.ok(r.content.includes(bruno.id))
  r = run('memory_write', { category: 'people', title: 'Bruno Lima', force_new: true })
  assert.equal(r.changes[0].op, 'create')
  // atualizar com ops (#n, texto)
  r = run('memory_write', {
    id: bruno.id,
    ops: [
      { op: 'replace', fact: '#1', with: 'Joga xadrez online' },
      { op: 'add', fact: 'Mora em BH' }
    ]
  })
  assert.equal(r.changes[0].op, 'update', r.content)
  assert.deepEqual(s.getMemory(bruno.id)!.facts, ['Joga xadrez online', 'Mora em BH'])
  r = run('memory_write', { id: bruno.id, ops: [{ op: 'remove', fact: 'mora em bh' }] })
  assert.equal(r.status, 'ok')
  assert.deepEqual(s.getMemory(bruno.id)!.facts, ['Joga xadrez online'])
  r = run('memory_write', { id: bruno.id, ops: [{ op: 'remove', fact: 'inexistente' }] })
  assert.equal(r.status, 'error')
  assert.match(r.content, /Tópico não encontrado/)
  // limite → erro legível
  r = run('memory_write', { id: bruno.id, ops: [{ op: 'add', fact: 'z'.repeat(201) }] })
  assert.match(r.content, /^Erro: Tópico longo demais \(201\/200/)
  // só leitura → manda usar rewrite
  r = run('memory_write', { id: ana.id, ops: [{ op: 'add', fact: 'x' }] })
  assert.equal(r.status, 'error')
  assert.match(r.content, /só de leitura.*memory_rewrite/)
  // categoria sem coleção de escrita: erro claro, nada criado (target legado é ignorado)
  const before = s.listMemories({}).length
  r = run('memory_write', { category: 'profile', title: 'Eu', ops: [{ op: 'add', fact: 'Dev' }] })
  assert.equal(r.status, 'error')
  assert.match(r.content, /^Erro: Sem coleção de escrita para Perfil \(profile\) neste chat/)
  r = run('memory_write', { category: 'profile', title: 'Eu', target: 'chat' })
  assert.match(r.content, /Sem coleção de escrita para Perfil/)
  assert.equal(s.listMemories({}).length, before)
  assert.deepEqual(
    s.listCollections().map((c) => c.id),
    [prof.id, fam.id, mine.id],
    'nenhuma coleção criada'
  )
  // rewrite de memória numa categoria sem escrita → mesmo erro
  const me = s.createMemory({ collectionId: prof.id, title: 'Perfil base' })
  r = run('memory_rewrite', { id: me.id, summary: 'x' })
  assert.match(r.content, /^Erro: Sem coleção de escrita para Perfil/)
  // categoria desligada / inválida
  const onlyPeople = {
    ...chat,
    config: { ...chat.config, memory: { ...memory, categories: ['people'] } }
  }
  r = runMemoryTool(
    'memory_write',
    { category: 'profile', title: 'Y' },
    { store: s, am: svc.active(onlyPeople, { depth: 0 }), by: { updatedBy: 'model' } }
  )
  assert.match(r.content, /desligada/)

  // rewrite de só leitura → nova memória na de escrita com supersedes_id; índice/busca mostram só ela
  r = run('memory_rewrite', {
    id: ana.id,
    ops: [{ op: 'replace', fact: 'Mora em Recife', with: 'Mora em Natal' }]
  })
  assert.equal(r.status, 'ok', r.content)
  const ana2 = s.getMemory(r.changes[0].memoryId)!
  assert.equal(ana2.supersedesId, ana.id)
  assert.equal(ana2.collectionId, mine.id)
  assert.deepEqual(ana2.facts, ['Mora em Natal', 'Gosta de café'])
  assert.deepEqual(
    s.getMemory(ana.id)!.facts,
    ['Mora em Recife', 'Gosta de café'],
    'original intacta'
  )
  r = run('memory_search', { query: 'Ana' })
  assert.ok(r.content.includes(ana2.id) && !r.content.includes(`${ana.id} ·`), r.content)
  r = run('memory_read', { ids: [ana.id] })
  assert.match(r.content, new RegExp(`substituída neste chat por ${ana2.id}`))
  // rewrite de novo da original → atualiza a substituta existente
  r = run('memory_rewrite', { id: ana.id, facts: ['Mora em Natal', 'Prefere chá'] })
  assert.equal(r.changes[0].memoryId, ana2.id)
  assert.equal(r.changes[0].op, 'update')
  // rewrite de gravável = update
  r = run('memory_rewrite', { id: bruno.id, summary: 'Amigo de infância' })
  assert.equal(r.changes[0].op, 'update')
  assert.match(r.content, /já é gravável/)

  // delete: só graváveis
  r = run('memory_delete', { id: ana.id })
  assert.equal(r.status, 'error')
  assert.match(r.content, /só de leitura/)
  r = run('memory_delete', { id: bruno.id })
  assert.equal(r.changes[0].op, 'delete')
  assert.equal(s.getMemory(bruno.id), null)

  // read: completa; fora das ativas
  const other = s.createCollection({ category: 'people', name: 'Inativa' })
  const hidden = s.createMemory({ collectionId: other.id, title: 'Segredo' })
  r = run('memory_read', { ids: [ana2.id, hidden.id, 'nada'] })
  assert.match(r.content, /tópicos:\n1\. Mora em Natal/)
  assert.match(r.content, /não está numa coleção ativa/)
  assert.match(r.content, /não encontrada/)
  r = run('memory_search', { query: 'segredo' })
  assert.match(r.content, /Nenhuma memória encontrada/)
  r = run('memory_search', { query: 'natal', collection: 'Minhas pessoas' })
  assert.ok(r.content.includes(ana2.id))

  // subagente: só search/read; escrita recusada
  const subCtx = {
    store: s,
    am: svc.active(
      { ...chat, config: { ...chat.config, memory: { ...memory, subagents: true } } },
      { depth: 1 }
    ),
    by: { updatedBy: 'model' as const }
  }
  assert.equal(runMemoryTool('memory_search', { query: 'natal' }, subCtx).status, 'ok')
  assert.match(
    runMemoryTool('memory_write', { category: 'people', title: 'Z' }, subCtx).content,
    /não está disponível/
  )
  // memória desligada
  const offCtx = {
    store: s,
    am: svc.active(
      { ...chat, config: { ...chat.config, memory: { ...memory, enabled: false } } },
      { depth: 0 }
    ),
    by: { updatedBy: 'model' as const }
  }
  assert.match(runMemoryTool('memory_search', { query: 'x' }, offCtx).content, /não está ativa/)
  assert.deepEqual(applyOps(['a', 'b'], [{ op: 'remove', fact: '#2' }]), ['a'])
  conn.close()
})

// ---------------- extração (modelo falso roteirizado) ----------------

test('extração: loop de tool calls com modelo falso, mesmas regras, request só com tools de escrita; erro e vazio', async () => {
  const conn = openDb('extract.db')
  const svc = new MemoryService(conn)
  const s = svc.store
  const col = s.createCollection({ category: 'people', name: 'Pessoas' })
  const existing = s.createMemory({
    collectionId: col.id,
    title: 'Ana',
    summary: 'Irmã',
    facts: ['Mora em Recife']
  })
  const { chat, sessionId } = insertChat(
    conn,
    mem({ collections: [col.id], writeTo: { people: col.id } })
  )
  const hist: any[] = [
    {
      id: '1',
      sessionId,
      seq: 1,
      message: {
        role: 'user',
        content: 'Minha irmã Ana se mudou para Natal. Meu amigo Caio é médico.'
      },
      meta: {},
      createdAt: 0
    },
    {
      id: '2',
      sessionId,
      seq: 2,
      message: { role: 'assistant', content: 'Anotado!' },
      meta: {},
      createdAt: 0
    }
  ]
  const reqs: any[] = []
  const script: any[][] = [
    [
      {
        name: 'memory_write',
        arguments: JSON.stringify({
          id: existing.id,
          ops: [{ op: 'replace', fact: '#1', with: 'Mora em Natal' }]
        })
      },
      {
        name: 'memory_write',
        arguments: JSON.stringify({
          category: 'people',
          title: 'Caio',
          summary: 'Amigo médico',
          ops: [{ op: 'add', fact: 'É médico' }]
        })
      }
    ],
    []
  ]
  const fake = async (req: any, _sig: any, acc: any): Promise<any> => {
    reqs.push(JSON.parse(JSON.stringify(req.body)))
    const calls = script.shift() ?? []
    acc.toolCalls = calls.map((c, i) => ({ id: `c${reqs.length}_${i}`, ...c }))
    acc.usage = { promptTokens: 100, completionTokens: 10, cost: 0.001 }
    return acc
  }
  const out = await runExtraction({
    service: svc,
    chat,
    sessionId,
    history: hist,
    provider,
    model: 'fake/x',
    trigger: 'manual',
    stream: fake
  })
  assert.equal(out.record.error, undefined)
  assert.equal(out.record.created, 1)
  assert.equal(out.record.updated, 1)
  assert.equal(out.maxSeq, 2)
  assert.equal(reqs.length, 2, 'para quando o modelo não chama mais tools')
  assert.deepEqual(
    reqs[0].tools.map((t: any) => t.function.name),
    ['memory_write', 'memory_rewrite', 'memory_delete']
  )
  const user = reqs[0].messages[1].content
  assert.ok(
    user.includes(existing.id) && user.includes('1. Mora em Recife'),
    'índice completo com tópicos'
  )
  assert.ok(user.includes('Usuário: Minha irmã Ana'))
  assert.equal(reqs[1].messages.at(-1).role, 'tool')
  assert.deepEqual(s.getMemory(existing.id)!.facts, ['Mora em Natal'])
  const caio = s.listMemories({ query: 'caio' })[0]
  assert.equal(caio.updatedBy, 'extraction')
  assert.equal(out.record.usage!.promptTokens, 200)
  assert.equal((out.record.request as any).headers.Authorization, 'Bearer …k')
  assert.equal(extractionSummaryText(out.record), 'Extração de memórias: 1 criada, 1 atualizada.')

  // desde a última extração: nada novo → vazio, sem request
  svc.writeState(sessionId, { lastExtractedSeq: 2 })
  const n = reqs.length
  const empty = await runExtraction({
    service: svc,
    chat,
    sessionId,
    history: hist,
    provider,
    model: 'fake/x',
    trigger: 'manual',
    stream: fake
  })
  assert.equal(empty.empty, true)
  assert.equal(reqs.length, n)
  // erro do provedor → result.error (não lança)
  svc.writeState(sessionId, { lastExtractedSeq: 0 })
  const bad = await runExtraction({
    service: svc,
    chat,
    sessionId,
    history: hist,
    provider,
    model: 'fake/x',
    trigger: 'manual',
    stream: async () => {
      throw new Error('Erro HTTP 500: pane')
    }
  })
  assert.match(bad.record.error!, /pane/)
  // sem destino de escrita → erro claro
  const ro = { ...chat, config: { ...chat.config, memory: mem({ collections: [col.id] }) } }
  const noW = await runExtraction({
    service: svc,
    chat: ro,
    sessionId,
    history: hist,
    provider,
    model: 'fake/x',
    trigger: 'manual',
    stream: fake
  })
  assert.match(noW.record.error!, /Nenhuma coleção de escrita/)
  // conversa: compactação → resumo + recentes
  const comp: any[] = [
    ...hist,
    {
      id: '3',
      sessionId,
      seq: 3,
      message: { role: 'user', content: 'RESUMO X' },
      meta: { kind: 'compaction', summaryOf: { fromSeq: 1, toSeq: 2 } },
      createdAt: 0
    },
    {
      id: '4',
      sessionId,
      seq: 4,
      message: { role: 'user', content: 'e agora?' },
      meta: {},
      createdAt: 0
    }
  ]
  const c1 = extractionConversation(comp, 2, 'compaction')
  assert.ok(c1.text.startsWith('[Resumo da conversa anterior]\nRESUMO X'))
  assert.ok(c1.text.includes('Usuário: e agora?') && !c1.text.includes('Ana se mudou'))
  assert.ok(
    !extractionConversation(comp, 2, 'manual').text.includes('RESUMO X'),
    'manual: resumo já extraído'
  )
  conn.close()
})

// ---------------- parte B: runner real + provedor falso ----------------

process.env.CLEARCHAT_TEST_USERDATA = TMP
process.env.CLEARCHAT_SKIP_SHELL_ENV = '1'
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export class BrowserWindow { static getAllWindows() { return [] } }
export const session = { fromPartition: () => ({}) }
export const dialog = {}
export const ipcMain = { handle() {} }
export const nativeImage = {}
export default { app, BrowserWindow, session, dialog, ipcMain, nativeImage }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

const AGENT = 'fake/agent'
const EXTRACT = 'fake/extract'
let server: Server
let base = ''
const hits: any[] = []

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const chunk = (model: string, delta: any, finish?: string, usage?: any): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(usage ? { usage } : {}) })}\n\n`

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ data: [AGENT, EXTRACT].map((id) => ({ id, context_length: 64000 })) })
        )
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const text = (t: string): void => {
        res.write(chunk(body.model, { role: 'assistant', content: t }))
        res.end(
          chunk(body.model, {}, 'stop', { prompt_tokens: 50, completion_tokens: 5 }) +
            'data: [DONE]\n\n'
        )
      }
      const call = (name: string, args: any): void => {
        res.write(
          chunk(body.model, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${hits.length}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          })
        )
        res.end(
          chunk(body.model, {}, 'tool_calls', { prompt_tokens: 50, completion_tokens: 5 }) +
            'data: [DONE]\n\n'
        )
      }
      if (body.model === EXTRACT) {
        if (last?.role === 'tool') return text('feito')
        const conv = textOf(last?.content).split('<conversation>')[1] ?? ''
        const m = /(?:prima|tio) (\w+)/.exec(conv)
        return call('memory_write', {
          category: 'people',
          title: `Pessoa ${m?.[1] ?? 'X'}`,
          summary: 'extraída',
          ops: [{ op: 'add', fact: 'veio da extração' }]
        })
      }
      if (/RESUMO DENSO/.test(lastUser)) {
        const who = /(?:prima|tio) (\w+)/.exec(JSON.stringify(msgs))
        return text(`RESUMO: o usuário falou do tio ${who?.[1] ?? '?'}.`)
      }
      if (last?.role === 'tool') return text(`FIM: ${textOf(last.content).slice(0, 60)}`)
      const lembre = /^lembre: (.+)$/.exec(lastUser)
      if (lembre)
        return call('memory_write', {
          category: 'profile',
          title: lembre[1],
          summary: 'dito pelo usuário',
          ops: [{ op: 'add', fact: lembre[1] }]
        })
      if (/^delegue/.test(lastUser))
        return call('delegate_task', { task: 'subtarefa: confira a memória' })
      if (/^subtarefa/.test(lastUser)) return text('SUB OK')
      return text('ok')
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

after(() => {
  server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

type Mods = {
  runner: typeof import('../src/main/agent/runner.ts')
  repo: typeof import('../src/main/repo.ts')
  memory: typeof import('../src/main/memory/index.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  const runner = await import('../src/main/agent/runner.ts')
  const repo = await import('../src/main/repo.ts')
  const memory = await import('../src/main/memory/index.ts')
  mods = { runner, repo, memory }
  return mods
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 8000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(25)
  }
}
let providerId = ''
let profileCol = ''
let peopleCol = ''
async function newChat(
  memory: any,
  enabledTools: string[] = []
): Promise<{ chatId: string; sid: string }> {
  const { repo } = await load()
  if (!providerId)
    providerId = repo.providersRepo.create({
      name: 'Falso',
      baseUrl: base,
      apiKey: 'k',
      headers: {}
    } as any).id
  const { chat, session } = repo.chatsRepo.create({
    config: { providerId, model: AGENT, cwd: TMP, enabledTools: enabledTools as any, memory }
  })
  return { chatId: chat.id, sid: session.id }
}
const idle = async (sid: string): Promise<void> => {
  const { repo, runner } = await load()
  await waitFor(
    () => !runner.isRunning(sid) && repo.sessionsRepo.get(sid)!.status === 'idle',
    10000,
    'idle'
  )
}

test('runner: índice na request, memory_write do agente persiste (aprovação "Sempre"), sessão nova vê no índice', async () => {
  const { runner, repo, memory } = await load()
  profileCol = memory.createCollection({ category: 'profile', name: 'Padrão' }).id
  peopleCol = memory.createCollection({ category: 'people', name: 'Pessoas' }).id
  const cfg = mem({
    collections: [profileCol, peopleCol],
    writeTo: { profile: profileCol, people: peopleCol }
  })
  const { sid } = await newChat(cfg)
  const n0 = hits.length
  runner.send(sid, 'lembre: Torce para o Palmeiras')
  await idle(sid)
  const first = hits[n0]
  assert.match(
    textOf(first.messages[0].content),
    /<memory>[\s\S]*## Perfil[\s\S]*### Padrão — escrita\n\(vazia\)/
  )
  // tools compactadas (padrão, 1.11.0): as de memória vão compactas + a tool_search no fim; o
  // memory_write do agente (argumentos válidos) roda normalmente sem ler a definição antes
  assert.deepEqual(
    first.tools.map((t: any) => t.function.name),
    [...MEMORY_TOOL_NAMES, 'tool_search']
  )
  assert.deepEqual(first.tools[0].function.parameters, { type: 'object', properties: {} })
  const saved = memory.listMemories({ query: 'palmeiras' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].collectionId, profileCol)
  const tool = repo.messagesRepo.listAll(sid).find((m) => m.message.role === 'tool')!
  assert.equal(tool.meta.toolStatus, 'ok')
  assert.equal(tool.meta.memoryChanges![0].op, 'create')
  assert.deepEqual(tool.meta.approval, { item: 'memory_write', mode: 'always' })
  // mesma sessão: índice congelado (cache) — a memória nova chega pelo resultado da tool
  assert.ok(!textOf(hits.at(-1).messages[0].content).includes('Torce para o Palmeiras'))
  // sessão nova (chat novo com a mesma config): vê no índice
  const b = await newChat(cfg)
  const n1 = hits.length
  runner.send(b.sid, 'oi')
  await idle(b.sid)
  assert.ok(
    textOf(hits[n1].messages[0].content).includes(`${saved[0].id} · Torce para o Palmeiras`)
  )
  // preview do IPC reflete o snapshot da sessão
  const pv = memory.previewMemory(b.sid)
  assert.ok(pv.snapshotAt && pv.index!.includes('Palmeiras'))
  const req = runner.previewRequest(b.sid) as any
  assert.ok(textOf(req.body.messages[0].content).includes('Palmeiras'))
})

test('runner: memória desligada → nada de memória na request; aprovação "Perguntar" pede confirmação', async () => {
  const { runner, repo } = await load()
  const off = await newChat(
    mem({ enabled: false, collections: [profileCol], writeTo: { profile: profileCol } })
  )
  const n0 = hits.length
  runner.send(off.sid, 'oi')
  await idle(off.sid)
  assert.ok(!/<memory>/.test(textOf(hits[n0].messages[0].content)))
  assert.equal(hits[n0].tools, undefined)
  // Perguntar: o card aparece; negar → não grava
  const ask = await newChat(mem({ collections: [profileCol], writeTo: { profile: profileCol } }))
  repo.chatsRepo.update(ask.chatId, { config: { approvalModes: { memory_write: 'lists' } } as any })
  runner.send(ask.sid, 'lembre: Mora em Campinas')
  const ap = await waitFor(
    () => runner.pendingApprovals().find((a) => a.sessionId === ask.sid),
    8000,
    'card'
  )
  assert.equal(ap.toolName, 'memory_write')
  runner.approve(ap.id, 'deny')
  await idle(ask.sid)
  const { memory } = await load()
  assert.equal(memory.listMemories({ query: 'campinas' }).length, 0)
})

test('runner: "Extrair memórias agora" grava, persiste o card (fora da API) e marca o seq', async () => {
  const { runner, repo, memory } = await load()
  const cfg = mem({
    collections: [peopleCol],
    writeTo: { people: peopleCol },
    extraction: { auto: false, prompt: null, providerId: null, model: EXTRACT }
  })
  const { sid } = await newChat(cfg)
  runner.send(sid, 'extraia: minha prima Julia')
  await idle(sid)
  const r = await memory.extractNow(sid)
  assert.equal(r.error, undefined)
  assert.equal(r.created, 1)
  const card = repo.messagesRepo.listAll(sid).find((m) => m.meta.kind === 'memory-extraction')!
  assert.ok(card.meta.synthetic)
  assert.equal(card.meta.memoryExtraction!.trigger, 'manual')
  assert.equal(card.meta.memoryExtraction!.model, EXTRACT)
  assert.ok(card.meta.memoryExtraction!.request)
  assert.equal(memory.listMemories({ query: 'julia' }).length, 1)
  assert.ok(memory.memoryService().readState(sid).lastExtractedSeq! >= 2)
  // de novo: nada novo
  const again = await memory.extractNow(sid)
  assert.match(again.error!, /Nada novo/)
  // o card não vai para a API
  const n0 = hits.length
  runner.send(sid, 'oi de novo')
  await idle(sid)
  assert.ok(!JSON.stringify(hits[n0].messages).includes('Extração de memórias'))
  // subsessão: recusada
  await assert.rejects(memory.extractNow('nao-existe'), /Sessão não encontrada/)
})

test('runner: compactação renova o snapshot e dispara a extração automática', async () => {
  const { runner, repo, memory } = await load()
  const cfg = mem({
    collections: [peopleCol],
    writeTo: { people: peopleCol },
    extraction: { auto: true, prompt: null, providerId: null, model: EXTRACT }
  })
  const { sid } = await newChat(cfg)
  runner.send(sid, 'compacte: meu tio Rui')
  await idle(sid)
  const snap1 = memory.memoryService().readState(sid).snapshot!
  assert.ok(snap1)
  runner.compact(sid)
  const card = await waitFor(
    () => repo.messagesRepo.listAll(sid).find((m) => m.meta.kind === 'memory-extraction'),
    10000,
    'card da extração automática'
  )
  assert.equal(card.meta.memoryExtraction!.trigger, 'compaction')
  assert.equal(card.meta.memoryExtraction!.created, 1, JSON.stringify(card.meta.memoryExtraction))
  const extReq = hits.filter((h) => h.model === EXTRACT).at(-1)
  assert.match(textOf(extReq.messages[1].content), /\[Resumo da conversa anterior\]\nRESUMO: /)
  await idle(sid)
  // compactação limpou o snapshot; o próximo request tira outro (com a memória extraída)
  runner.send(sid, 'continue')
  await idle(sid)
  const snap2 = memory.memoryService().readState(sid).snapshot!
  assert.ok(snap2.at > snap1.at)
  assert.match(snap2.index, /Pessoa Rui/)
})

test('runner: subagente só recebe memory_search/memory_read com a opção (nunca índice/help/escrita)', async () => {
  const { runner, repo } = await load()
  for (const subagents of [true, false]) {
    const cfg = mem({
      collections: [profileCol],
      writeTo: { profile: profileCol },
      subagents,
      helpPrompt: { enabled: true, text: null }
    })
    const { chatId, sid } = await newChat(cfg, ['delegate_task'])
    const n0 = hits.length
    runner.send(sid, 'delegue')
    await idle(sid)
    const subReq = hits
      .slice(n0)
      .find((h) =>
        textOf(h.messages.find((m: any) => m.role === 'user')?.content).startsWith('subtarefa')
      )
    assert.ok(subReq, 'request do subagente')
    const sys = textOf(subReq.messages[0]?.role === 'system' ? subReq.messages[0].content : '')
    assert.ok(!sys.includes('<memory>') && !sys.includes(DEFAULT_MEMORY_HELP_PROMPT.slice(0, 40)))
    const names = (subReq.tools ?? [])
      .map((t: any) => t.function.name)
      .filter((n: string) => n.startsWith('memory_'))
    assert.deepEqual(names, subagents ? ['memory_search', 'memory_read'] : [])
    const mainReq = hits[n0]
    assert.ok(textOf(mainReq.messages[0].content).includes('<memory>'))
    assert.ok(repo.sessionsRepo.list(chatId).length === 2)
  }
})
