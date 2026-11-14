/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E da memória modular no app real (Playwright + `e2e/launch.ts`, chamando window.api pelo renderer),
// 100% determinístico: um provedor OpenAI-compatible FALSO servido pelo próprio teste em 127.0.0.1
// faz o agente (`fake/agent`: "lembre: X" → memory_write; "delegue" → delegate_task), o modelo de
// extração (`fake/extract`: memory_write com a pessoa citada) e o resumo da compactação. Nenhuma
// key real, nenhum custo.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/memory.spec.ts [filtro]
//
// Cobre: índice + tools na request; memory_write do agente → memória persistida + evento
// memory-changed → sessão nova vê no índice (a mesma sessão segue congelada); preview/"Ver request";
// "Atualizar memória"; memória desligada → nada vai; "Extrair memórias agora" (card fora da API);
// compactação → extração automática; subagente só com memory_search/memory_read quando ligado;
// categoria sem coleção de escrita → erro claro (sem nenhuma → sem tools de escrita); `chatMemory`
// legado não ativa nada e some da config ao reabrir o app (migração); apagar coleção apaga as memórias.
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const AGENT = 'fake/agent'
const EXTRACT = 'fake/extract'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-memory-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const FILTER = process.argv[2] ?? ''

// ---------------- provedor falso ----------------

const hits: any[] = []
let server: Server | null = null
let fakeBase = ''
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [AGENT, EXTRACT].map((id) => ({
              id,
              context_length: 64_000,
              supported_parameters: ['tools']
            }))
          })
        )
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const chunk = (delta: any, finish?: string): string =>
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 80, completion_tokens: 6 } } : {}) })}\n\n`
      const text = (t: string): void => {
        res.write(chunk({ role: 'assistant', content: t }))
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
      }
      const call = (name: string, args: any): void => {
        res.write(
          chunk({
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
        res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
      }
      if (body.model === EXTRACT) {
        if (last?.role === 'tool') return text('feito')
        const conv = textOf(last?.content).split('<conversation>')[1] ?? ''
        const who = /(?:prima|tio) (\w+)/.exec(conv)?.[1] ?? 'X'
        return call('memory_write', {
          category: 'people',
          title: `Pessoa ${who}`,
          summary: 'extraída',
          ops: [{ op: 'add', fact: 'veio da extração' }]
        })
      }
      if (/RESUMO DENSO/.test(lastUser)) {
        const who = /(?:prima|tio) (\w+)/.exec(JSON.stringify(msgs))?.[1] ?? '?'
        return text(`RESUMO: o usuário falou do tio ${who}.`)
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
      if (/^delegue/.test(lastUser)) return call('delegate_task', { task: 'subtarefa: confira' })
      if (/^subtarefa/.test(lastUser)) return text('SUB OK')
      return text('ok')
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  await page.evaluate(() => {
    const w = window as any
    w.__ev = []
    w.api.onEvent((e: unknown) => w.__ev.push(e))
  })
}

async function api<T = any>(path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}

const events = (): Promise<any[]> => page.evaluate(() => (window as any).__ev)
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
    await sleep(100)
  }
}

async function waitIdle(chatId: string, sessionId: string): Promise<void> {
  await sleep(150)
  await waitFor(
    async () => {
      if ((await api<string[]>('agent.runningSessions')).includes(sessionId)) return null
      const s = (await api<any[]>('sessions.list', chatId)).find((x) => x.id === sessionId)
      return s && s.status === 'idle'
    },
    20_000,
    'sessão ociosa'
  )
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (FILTER && !FILTER.split(',').some((f) => name.includes(f.trim()))) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
  }
}

const mem = (over: any = {}): any => ({
  enabled: true,
  collections: [],
  writeTo: {},
  categories: ['profile', 'topics', 'areas', 'people', 'preferences'],
  helpPrompt: { enabled: true, text: null },
  extraction: { auto: false, prompt: null, providerId: null, model: EXTRACT },
  subagents: false,
  ...over
})

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  await startFake()
  await launch()

  let providerId = ''
  let profile = ''
  let people = ''
  const newChat = async (memory: any, enabledTools: string[] = []): Promise<any> =>
    api('chats.create', {
      config: { providerId, model: AGENT, cwd: CWD, enabledTools, memory }
    })

  await step('setup: provedor falso e coleções', async () => {
    providerId = (await api('providers.create', { name: 'Local', baseUrl: fakeBase, apiKey: 'k' }))
      .id
    profile = (await api('memory.createCollection', { category: 'profile', name: 'Padrão' })).id
    people = (await api('memory.createCollection', { category: 'people', name: 'Pessoas' })).id
    const cols = await api<any[]>('memory.listCollections')
    assert(cols.length === 2 && cols.every((c) => c.count === 0), 'coleções com contagem')
  })

  const cfg = (): any => mem({ collections: [profile, people], writeTo: { profile, people } })

  let savedId = ''
  await step('índice + tools na request; memory_write do agente persiste; evento', async () => {
    const chat = await newChat(cfg())
    const n0 = hits.length
    await api('agent.send', chat.mainSessionId, 'lembre: Torce para o Palmeiras')
    await waitIdle(chat.id, chat.mainSessionId)
    const sys = textOf(hits[n0].messages[0].content)
    assert(/<memory>[\s\S]*### Padrão — escrita/.test(sys), 'índice no system')
    assert(sys.includes('Você tem uma memória persistente'), 'help prompt')
    const names = hits[n0].tools.map((t: any) => t.function.name)
    assert(names.includes('memory_write') && names.includes('memory_search'), 'tools de memória')
    const found = await api<any[]>('memory.list', { query: 'palmeiras' })
    assert(found.length === 1 && found[0].collectionId === profile, 'memória persistida')
    savedId = found[0].id
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'memory-changed' && e.memoryId === savedId),
      'evento memory-changed'
    )
    const msgs = await api<any[]>('sessions.messages', chat.mainSessionId)
    const tool = msgs.find((m) => m.message.role === 'tool')
    assert(tool.meta.memoryChanges?.[0]?.op === 'create', 'memoryChanges no meta da tool')
    assert(
      !textOf(hits.at(-1).messages[0].content).includes('Torce para o Palmeiras'),
      'mesma sessão: índice congelado'
    )
    // "Atualizar memória" renova o snapshot desta sessão
    const pv = await api('memory.refreshSnapshot', chat.mainSessionId)
    assert(pv.index.includes(savedId) && pv.snapshotAt, 'refresh inclui a nova')
    return savedId
  })

  await step('sessão nova vê a memória no índice; preview e "Ver request"', async () => {
    const chat = await newChat(cfg())
    const pv0 = await api('memory.preview', chat.mainSessionId)
    assert(pv0.active && pv0.snapshotAt === null && pv0.index.includes(savedId), 'preview')
    assert(pv0.tools.length === 5, 'tools no preview')
    const n0 = hits.length
    await api('agent.send', chat.mainSessionId, 'oi')
    await waitIdle(chat.id, chat.mainSessionId)
    assert(
      textOf(hits[n0].messages[0].content).includes(`${savedId} · Torce para o Palmeiras`),
      'índice da sessão nova'
    )
    const pv = await api('memory.preview', chat.mainSessionId)
    assert(pv.snapshotAt, 'snapshot tirado no 1º request')
    const req = await api('agent.previewRequest', chat.mainSessionId)
    assert(textOf(req.body.messages[0].content).includes(savedId), 'Ver request com o índice')
  })

  await step('memória desligada → nada de memória vai para a API', async () => {
    const chat = await newChat(mem({ enabled: false, collections: [profile] }))
    const n0 = hits.length
    await api('agent.send', chat.mainSessionId, 'oi')
    await waitIdle(chat.id, chat.mainSessionId)
    assert(!/<memory>|memória/i.test(textOf(hits[n0].messages[0].content)), 'sem índice/help')
    assert(!hits[n0].tools, 'sem tools')
    const pv = await api('memory.preview', chat.mainSessionId)
    assert(!pv.active && pv.index === null && pv.tools.length === 0, 'preview inativo')
  })

  await step('"Extrair memórias agora": grava, card persistido, fora da API', async () => {
    const chat = await newChat(cfg())
    await api('agent.send', chat.mainSessionId, 'extraia: minha prima Julia')
    await waitIdle(chat.id, chat.mainSessionId)
    const r = await api('memory.extractNow', chat.mainSessionId)
    assert(!r.error && r.created === 1, JSON.stringify(r))
    const msgs = await api<any[]>('sessions.messages', chat.mainSessionId)
    const card = msgs.find((m) => m.meta.kind === 'memory-extraction')
    assert(card?.meta.memoryExtraction?.trigger === 'manual', 'card')
    assert((await api<any[]>('memory.list', { query: 'julia' })).length === 1, 'memória extraída')
    const n0 = hits.length
    await api('agent.send', chat.mainSessionId, 'e agora?')
    await waitIdle(chat.id, chat.mainSessionId)
    assert(!JSON.stringify(hits[n0].messages).includes('Extração de memórias'), 'card fora da API')
  })

  await step('compactação → extração automática (resumo + recentes)', async () => {
    const chat = await newChat(
      mem({
        collections: [people],
        writeTo: { people },
        extraction: { auto: true, prompt: null, providerId: null, model: EXTRACT }
      })
    )
    await api('agent.send', chat.mainSessionId, 'compacte: meu tio Rui')
    await waitIdle(chat.id, chat.mainSessionId)
    await api('agent.compact', chat.mainSessionId)
    const card = await waitFor(
      async () =>
        (await api<any[]>('sessions.messages', chat.mainSessionId)).find(
          (m) => m.meta.kind === 'memory-extraction'
        ),
      20_000,
      'card da extração automática'
    )
    assert(card.meta.memoryExtraction.trigger === 'compaction', 'trigger compaction')
    assert(card.meta.memoryExtraction.created === 1, JSON.stringify(card.meta.memoryExtraction))
    const ext = hits.filter((h) => h.model === EXTRACT).at(-1)
    assert(textOf(ext.messages[1].content).includes('[Resumo da conversa anterior]'), 'resumo')
  })

  await step('subagente: só memory_search/memory_read quando ligado; nunca índice', async () => {
    const out: string[] = []
    for (const subagents of [true, false]) {
      const chat = await newChat(mem({ collections: [profile], writeTo: { profile }, subagents }), [
        'delegate_task'
      ])
      const n0 = hits.length
      await api('agent.send', chat.mainSessionId, 'delegue')
      await waitIdle(chat.id, chat.mainSessionId)
      const sub = hits
        .slice(n0)
        .find((h) =>
          textOf(h.messages.find((m: any) => m.role === 'user')?.content).startsWith('subtarefa')
        )
      assert(sub, 'request do subagente')
      assert(!JSON.stringify(sub.messages).includes('<memory>'), 'sem índice no subagente')
      const names = (sub.tools ?? [])
        .map((t: any) => t.function.name)
        .filter((n: string) => n.startsWith('memory_'))
      assert(
        JSON.stringify(names) === JSON.stringify(subagents ? ['memory_search', 'memory_read'] : []),
        `tools do subagente (${subagents}): ${names}`
      )
      out.push(`${subagents}: ${names.join(',') || '—'}`)
    }
    return out.join(' · ')
  })

  await step(
    'sem coleção de escrita: erro claro na categoria; sem nenhuma, sem tools de escrita',
    async () => {
      // Perfil sem escrita (só Pessoas): o agente tenta gravar em profile → erro, nada criado
      const chat = await newChat(mem({ collections: [profile, people], writeTo: { people } }))
      await api('agent.send', chat.mainSessionId, 'lembre: Mora em Curitiba')
      await waitIdle(chat.id, chat.mainSessionId)
      const msgs = await api<any[]>('sessions.messages', chat.mainSessionId)
      const tool = msgs.find((m) => m.message.role === 'tool')
      assert(
        /^Erro: Sem coleção de escrita para Perfil \(profile\) neste chat/.test(
          textOf(tool?.message.content)
        ),
        `erro claro: ${textOf(tool?.message.content)}`
      )
      assert((await api<any[]>('memory.list', { query: 'curitiba' })).length === 0, 'nada criado')
      assert(
        (await api<any[]>('memory.listCollections')).length === 2,
        'nenhuma coleção criada sob demanda'
      )
      // nenhuma coleção de escrita → só leitura na request
      const ro = await newChat(mem({ collections: [profile] }))
      const pv = await api('memory.preview', ro.mainSessionId)
      assert(
        JSON.stringify(pv.tools) === JSON.stringify(['memory_search', 'memory_read']),
        `tools do preview: ${pv.tools}`
      )
      const n0 = hits.length
      await api('agent.send', ro.mainSessionId, 'oi')
      await waitIdle(ro.id, ro.mainSessionId)
      const names = hits[n0].tools.map((t: any) => t.function.name)
      assert(
        !names.some((n: string) => ['memory_write', 'memory_rewrite', 'memory_delete'].includes(n)),
        `sem tools de escrita: ${names}`
      )
      assert(!JSON.stringify(hits[n0].tools).includes('"target"'), 'definições sem target')
    }
  )

  await step(
    'chatMemory legado: nada ativo; some da config ao reabrir (migração); apagar coleção apaga',
    async () => {
      const chat = await newChat({ ...mem(), chatMemory: true })
      const pv = await api('memory.preview', chat.mainSessionId)
      assert(!pv.active && pv.tools.length === 0, 'chatMemory sozinho não ativa nada')
      const before = await api('chats.get', chat.id)
      assert(before.config.memory.chatMemory === true, 'gravado como veio (legado)')
      await app.close()
      await launch()
      const after = await api('chats.get', chat.id)
      assert(after && !('chatMemory' in after.config.memory), 'chatMemory retirado na migração')
      assert(after.config.memory.enabled === true, 'resto da config intacto')
      const col = await api('memory.createCollection', { category: 'areas', name: 'Tmp' })
      await api('memory.create', { collectionId: col.id, title: 'Projeto X' })
      await api('memory.deleteCollection', col.id)
      assert((await api<any[]>('memory.list', { query: 'projeto' })).length === 0, 'cascade')
      await api('chats.delete', chat.id)
    }
  )

  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} passos ok`)
  await app.close().catch(() => {})
  server?.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await app?.close().catch(() => {})
  server?.close()
  process.exit(1)
})
