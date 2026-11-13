/* eslint-disable @typescript-eslint/no-explicit-any */
// Tools compactadas e `datetime` no main (protocolo 1.11.0, §4.3.6) — a VERSÃO LOCAL (a busca
// nativa de 1.12.0 tem testes próprios em toolSearch.test.ts): (A) a request montada (buildRequest,
// função pura) para um OpenAI-compatible genérico e a Anthropic nativa num modelo sem a busca
// nativa, o texto gerado das tools no system prompt, subagentes e o histórico com chamadas de tools
// que não vão mais (compactação desligada depois de usar a `search_tool` — o nome antigo vai como
// `tool_search` só na cópia); (B) o runner real com um provedor FALSO local (nada de rede/key
// real): a tool_search (e o nome antigo search_tool) devolve a definição completa das enviadas, uma
// tool compacta com argumentos inválidos recebe o erro com a definição completa, com argumentos
// válidos roda normalmente, `datetime` roda sem aprovação, e sem compactação a tool_search não existe.
// Rodar: npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRequest } from '../src/main/agent/request.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import {
  COMPACT_PARAMETERS,
  COMPACT_TOOLS_PROMPT,
  SEARCH_TOOL_DEFINITION,
  TOOL_SHORT_DESCRIPTIONS
} from '../src/shared/compactTools.ts'
import { TOOL_DEFINITIONS, toolDefinitionFor } from '../src/shared/tools.ts'
import type { ApiMessage, Chat, Provider, StoredMessage } from '../src/shared/types.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-compact-'))
const env = { os: 'Linux 6.0 (x64)', shell: 'bash' }
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

// ---------------- (A) request pura ----------------

const OR: Provider = {
  id: 'p1',
  name: 'OR',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'k',
  headers: {},
  createdAt: 0
}
/** OpenAI-compatible genérico: sem busca nativa → a versão local (1.11.0). */
const GEN: Provider = {
  id: 'p1',
  name: 'Genérico',
  kind: 'openai',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'k',
  headers: {},
  createdAt: 0
}
const ANTH: Provider = {
  id: 'pa',
  name: 'Anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'k',
  headers: {},
  kind: 'anthropic',
  createdAt: 0
}
const mkChat = (over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('/work', { providerId: 'p1', model: 'm', systemPrompt: 'SYS' }),
    enabledTools: ['read_file', 'shell', 'datetime'],
    envInPrompt: false,
    ...over
  }
})
let seq = 0
const sm = (message: ApiMessage): StoredMessage => ({
  id: String(++seq),
  sessionId: 's1',
  seq,
  message,
  meta: {},
  createdAt: 0
})
const s0 = { depth: 0 as const, model: 'm' }

test('genérico (versão local): compactas (nome + descrição curta + esquema vazio), tool_search completa no fim, prompt no fim do system', () => {
  const req = buildRequest(
    mkChat({ cacheEnabled: true }),
    s0,
    [sm({ role: 'user', content: 'oi' })],
    GEN,
    env
  )
  const b = req.body as any
  assert.equal(req.toolSearch?.mode, 'local')
  assert.match(req.notes?.[0] ?? '', /Versão local do app — provedor OpenAI-compatible genérico/)
  assert.deepEqual(
    b.tools.map((t: any) => t.function.name),
    ['read_file', 'shell', 'datetime', 'tool_search']
  )
  for (const t of b.tools.slice(0, 3)) {
    assert.equal(t.type, 'function')
    assert.equal(t.function.description, TOOL_SHORT_DESCRIPTIONS[t.function.name])
    assert.deepEqual(t.function.parameters, COMPACT_PARAMETERS)
  }
  assert.deepEqual(b.tools[3], SEARCH_TOOL_DEFINITION)
  // cache ligado (OpenRouter): system em parts com cache_control; o prompt fixo é o fim do texto
  assert.equal(b.messages[0].content[0].text, `SYS\n\n${COMPACT_TOOLS_PROMPT}`)
  assert.equal(b.messages[0].content[0].cache_control.type, 'ephemeral')
  // determinístico (prefixo de cache): mesma entrada → mesmos bytes
  const again = buildRequest(
    mkChat({ cacheEnabled: true }),
    s0,
    [sm({ role: 'user', content: 'oi' })],
    GEN,
    env
  )
  assert.equal(JSON.stringify(again.body.tools), JSON.stringify(b.tools))
  // uma marcada "vai completa": a definição completa (a mesma de toolDefinitionFor)
  const mixed = buildRequest(mkChat({ toolsFull: ['shell'] }), s0, [], GEN, env).body as any
  assert.deepEqual(mixed.tools[1], toolDefinitionFor('shell', []))
  // desligada: completas, sem tool_search e sem prompt (OpenRouter: Chat Completions de sempre)
  const off = buildRequest(mkChat({ toolsCompact: false }), s0, [], OR, env).body as any
  assert.deepEqual(
    off.tools.map((t: any) => t.function.name),
    ['read_file', 'shell', 'datetime']
  )
  assert.deepEqual(off.tools[0], TOOL_DEFINITIONS.read_file)
  assert.equal(off.messages[0].content[0].text, 'SYS')
  // todas completas → idem
  const all = buildRequest(
    mkChat({ toolsFull: ['read_file', 'shell', 'datetime'] }),
    s0,
    [],
    OR,
    env
  ).body as any
  assert.ok(!all.tools.some((t: any) => t.function.name === 'tool_search'))
  assert.ok(!textOf(all.messages[0].content).includes(COMPACT_TOOLS_PROMPT))
})

test('Anthropic nativa num modelo sem busca nativa (versão local): compactas com input_schema vazio, tool_search completa, prompt no fim do system', () => {
  const b = buildRequest(
    mkChat({ providerId: 'pa', cacheEnabled: false }),
    { depth: 0, model: 'claude-opus-4-1' },
    [sm({ role: 'user', content: 'oi' })],
    ANTH,
    env
  ).body as any
  assert.deepEqual(b.tools[0], {
    name: 'read_file',
    description: TOOL_SHORT_DESCRIPTIONS.read_file,
    input_schema: { type: 'object', properties: {} }
  })
  assert.deepEqual(b.tools.at(-1), {
    name: 'tool_search',
    description: SEARCH_TOOL_DEFINITION.function.description,
    input_schema: SEARCH_TOOL_DEFINITION.function.parameters
  })
  assert.deepEqual(b.system, [{ type: 'text', text: `SYS\n\n${COMPACT_TOOLS_PROMPT}` }])
})

test('texto das tools no system prompt: o gerado segue a compactação; um texto do usuário vai como está', () => {
  // nativas + texto gerado: lista as compactas com a descrição curta e a tool_search; prompt fixo
  // no fim (texto gerado → sempre a versão local, mesmo no OpenRouter)
  const both = buildRequest(mkChat({ toolsInPrompt: true, cacheEnabled: false }), s0, [], OR, env)
    .body as any
  const sys = both.messages[0].content as string
  assert.ok(sys.includes(`- read_file: ${TOOL_SHORT_DESCRIPTIONS.read_file}`))
  assert.ok(sys.includes(`- tool_search: ${SEARCH_TOOL_DEFINITION.function.description}`))
  assert.ok(sys.endsWith(`</tools>\n\n${COMPACT_TOOLS_PROMPT}`))
  // modo texto (sem tools nativas): esquema vazio nas compactas, search_tool com o esquema dela
  const txt = buildRequest(
    mkChat({ toolsInPrompt: true, nativeTools: false, cacheEnabled: false }),
    s0,
    [],
    OR,
    env
  ).body as any
  assert.equal(txt.tools, undefined)
  const t = txt.messages[0].content as string
  assert.ok(t.includes('## read_file\n' + TOOL_SHORT_DESCRIPTIONS.read_file))
  assert.ok(t.includes('## tool_search\n'))
  assert.ok(t.endsWith(COMPACT_TOOLS_PROMPT))
  // texto escrito pelo usuário, sem tools nativas: vai como está e nada é compactado (sem prompt)
  const own = buildRequest(
    mkChat({
      toolsInPrompt: true,
      nativeTools: false,
      toolsPromptText: 'MEU',
      cacheEnabled: false
    }),
    s0,
    [],
    OR,
    env
  ).body as any
  assert.equal(own.messages[0].content, 'SYS\n\nMEU')
  // texto do usuário + tools nativas: o texto vai como está; as nativas seguem a compactação
  const ownNative = buildRequest(
    mkChat({ toolsInPrompt: true, toolsPromptText: 'MEU', cacheEnabled: false }),
    s0,
    [],
    GEN,
    env
  ).body as any
  assert.equal(ownNative.messages[0].content, `SYS\n\nMEU\n\n${COMPACT_TOOLS_PROMPT}`)
  assert.equal(ownNative.tools.at(-1).function.name, 'tool_search')
})

test('subagente: a compactação vale (com o system prompt dos subagentes)', () => {
  const b = buildRequest(
    mkChat({ subagentSystemPrompt: 'SUB', cacheEnabled: false }),
    { depth: 1, model: 'm' },
    [],
    GEN,
    env
  ).body as any
  assert.equal(b.messages[0].content, `SUB\n\n${COMPACT_TOOLS_PROMPT}`)
  assert.equal(b.tools.at(-1).function.name, 'tool_search')
  assert.deepEqual(b.tools[0].function.parameters, COMPACT_PARAMETERS)
})

test('histórico: compactação desligada depois de usar a search_tool → as chamadas antigas continuam pareadas (OpenRouter e Anthropic); o nome antigo vai como tool_search só na cópia', () => {
  // o histórico é imutável e reenviado como está (cache): as chamadas de uma tool que não vai mais
  // (search_tool, ou uma tool desligada) seguem como mensagens de tool comuns, pareadas com o
  // resultado; o campo tools continua presente (a Anthropic exige tools quando há tool_use)
  const hist = [
    sm({ role: 'user', content: 'leia' }),
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'search_tool', arguments: '{"names":["read_file"]}' }
        }
      ]
    }),
    sm({ role: 'tool', tool_call_id: 'c1', content: '[{"name":"read_file"}]' }),
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c2', type: 'function', function: { name: 'datetime', arguments: '{}' } }]
    }),
    sm({ role: 'tool', tool_call_id: 'c2', content: '2026-11-13T14:05:09-03:00' }),
    sm({ role: 'assistant', content: 'pronto' }),
    sm({ role: 'user', content: 'e agora?' })
  ]
  const cfg = { toolsCompact: false, enabledTools: ['read_file' as const] }
  const or = buildRequest(mkChat(cfg), s0, hist, OR, env).body as any
  assert.deepEqual(
    or.tools.map((t: any) => t.function.name),
    ['read_file']
  )
  const calls = or.messages.filter((m: any) => m.tool_calls).map((m: any) => m.tool_calls[0].id)
  const results = or.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)
  assert.deepEqual(calls, ['c1', 'c2'])
  // renome 1.12.0: na cópia enviada a chamada antiga vira tool_search; o histórico salvo não muda
  assert.equal(
    or.messages.find((m: any) => m.tool_calls).tool_calls[0].function.name,
    'tool_search'
  )
  assert.equal((hist[1].message as any).tool_calls[0].function.name, 'search_tool')
  assert.deepEqual(results, ['c1', 'c2'])
  assert.ok(!textOf(or.messages[0].content).includes(COMPACT_TOOLS_PROMPT))
  const an = buildRequest(
    mkChat({ ...cfg, providerId: 'pa' }),
    { depth: 0, model: 'claude-x' },
    hist,
    ANTH,
    env
  ).body as any
  assert.deepEqual(
    an.tools.map((t: any) => t.name),
    ['read_file']
  )
  const blocks = an.messages.flatMap((m: any) => m.content.map((c: any) => [m.role, c.type]))
  const uses = an.messages.flatMap((m: any) =>
    m.content.filter((c: any) => c.type === 'tool_use').map((c: any) => c.id)
  )
  assert.equal(
    an.messages.flatMap((m: any) => m.content).find((c: any) => c.id === 'c1').name,
    'tool_search'
  )
  const res = an.messages.flatMap((m: any) =>
    m.content.filter((c: any) => c.type === 'tool_result').map((c: any) => c.tool_use_id)
  )
  assert.deepEqual(uses, ['c1', 'c2'])
  assert.deepEqual(res, ['c1', 'c2'])
  // alternância user/assistant preservada (tool_result no user seguinte ao tool_use)
  for (let i = 1; i < an.messages.length; i++)
    assert.notEqual(an.messages[i].role, an.messages[i - 1].role, JSON.stringify(blocks))
})

// ---------------- (B) runner real + provedor falso ----------------

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
let server: Server
let base = ''
const hits: any[] = []

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`

/** Roteiro: a 1ª mensagem do usuário escolhe a chamada; depois do resultado, responde "FIM". */
const SCRIPT: Record<string, { name: string; args: string }> = {
  invalido: { name: 'read_file', args: JSON.stringify({ file: 'a.txt' }) },
  json: { name: 'read_file', args: '{"path": "a.txt"' },
  valido: { name: 'read_file', args: JSON.stringify({ path: 'a.txt' }) },
  busca: { name: 'tool_search', args: JSON.stringify({ names: ['read_file', 'shell'] }) },
  // nome antigo (≤ 1.11.0): alias de leitura na execução
  buscaAntiga: { name: 'search_tool', args: JSON.stringify({ names: ['datetime'] }) },
  desconhecida: { name: 'tool_search', args: JSON.stringify({ names: ['nope'] }) },
  hora: { name: 'datetime', args: JSON.stringify({ format: '%Y' }) },
  // `files` como texto (fora do esquema, mas a tool aceita — ex.: caminho do Windows)
  apresenta: { name: 'present_file', args: JSON.stringify({ files: 'a.txt' }) },
  apresentaRuim: { name: 'present_file', args: JSON.stringify({ arquivos: ['a.txt'] }) }
}

before(async () => {
  writeFileSync(join(TMP, 'a.txt'), 'conteúdo A\n')
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: AGENT, context_length: 64000 }] }))
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (last?.role === 'tool') {
        res.write(chunk(body.model, { role: 'assistant', content: 'FIM' }))
        res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      const step = SCRIPT[textOf(last?.content).trim()]
      if (!step) {
        res.write(chunk(body.model, { role: 'assistant', content: 'ok' }))
        res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      res.write(
        chunk(body.model, {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${hits.length}`,
              type: 'function',
              function: { name: step.name, arguments: step.args }
            }
          ]
        })
      )
      res.end(chunk(body.model, {}, 'tool_calls') + 'data: [DONE]\n\n')
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
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    runner: await import('../src/main/agent/runner.ts'),
    repo: await import('../src/main/repo.ts')
  }
  return mods
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T | null | undefined | false, what: string): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > 8000) throw new Error(`timeout: ${what}`)
    await sleep(25)
  }
}
let providerId = ''
async function newChat(over: Record<string, unknown> = {}): Promise<string> {
  const { repo } = await load()
  if (!providerId)
    providerId = repo.providersRepo.create({
      name: 'Falso',
      baseUrl: base,
      apiKey: 'k',
      headers: {}
    } as any).id
  const { session } = repo.chatsRepo.create({
    config: {
      providerId,
      model: AGENT,
      cwd: TMP,
      enabledTools: ['read_file', 'shell', 'datetime'],
      ...over
    } as any
  })
  return session.id
}
/** Manda a mensagem, espera o turno e devolve o resultado da tool (conteúdo + status). */
async function turn(sid: string, text: string): Promise<{ content: string; status: string }> {
  const { repo, runner } = await load()
  runner.send(sid, text)
  await waitFor(
    () => !runner.isRunning(sid) && repo.sessionsRepo.get(sid)!.status === 'idle',
    `idle (${text})`
  )
  const tools = repo.messagesRepo.listAll(sid).filter((m) => m.message.role === 'tool')
  const t = tools[tools.length - 1]
  return { content: textOf(t.message.content), status: t.meta.toolStatus ?? '' }
}

test('runner: compacta com argumentos inválidos → o erro da tool + a definição completa; JSON inválido idem', async () => {
  const sid = await newChat()
  const r = await turn(sid, 'invalido')
  assert.equal(r.status, 'error')
  assert.match(r.content, /^Erro: /)
  assert.match(
    r.content,
    /Os argumentos não seguem o esquema de read_file: falta "path" \(obrigatório\); parâmetro desconhecido: "file"\./
  )
  assert.ok(r.content.endsWith(JSON.stringify(TOOL_DEFINITIONS.read_file.function)), r.content)
  // a request que gerou a chamada mandou read_file compacta
  const req = hits.find((h) => textOf(h.messages.at(-1)?.content) === 'invalido')
  assert.deepEqual(req.tools[0].function.parameters, COMPACT_PARAMETERS)
  const j = await turn(sid, 'json')
  assert.equal(j.status, 'error')
  assert.match(j.content, /^Erro: Argumentos JSON inválidos/)
  assert.ok(j.content.endsWith(JSON.stringify(TOOL_DEFINITIONS.read_file.function)))
})

test('runner: compacta roda com os argumentos que a tool aceita, mesmo fora do esquema (present_file com files em texto)', async () => {
  const sid = await newChat({ enabledTools: ['read_file', 'present_file', 'datetime'] })
  const r = await turn(sid, 'apresenta')
  assert.equal(r.status, 'ok', r.content)
  assert.ok(!r.content.includes('foi enviada compactada'))
  // falhou E fora do esquema → o erro dela + a definição completa
  const b = await turn(sid, 'apresentaRuim')
  assert.equal(b.status, 'error')
  assert.match(b.content, /Os argumentos não seguem o esquema de present_file: falta "files"/)
  assert.ok(b.content.endsWith(JSON.stringify(TOOL_DEFINITIONS.present_file.function)), b.content)
})

test('runner: compacta com argumentos válidos roda normalmente (sem ler antes)', async () => {
  const sid = await newChat()
  const r = await turn(sid, 'valido')
  assert.equal(r.status, 'ok')
  assert.match(r.content, /conteúdo A/)
})

test('runner: tool_search devolve a definição completa das enviadas; desconhecida → erro com a lista; o nome antigo search_tool também roda', async () => {
  const sid = await newChat()
  const r = await turn(sid, 'busca')
  assert.equal(r.status, 'ok')
  const defs = JSON.parse(r.content)
  assert.deepEqual(defs[0], TOOL_DEFINITIONS.read_file.function)
  assert.equal(defs[1].name, 'shell')
  assert.ok(defs[1].parameters.properties.command, 'esquema completo do shell')
  const old = await turn(sid, 'buscaAntiga')
  assert.equal(old.status, 'ok', old.content)
  assert.equal(JSON.parse(old.content)[0].name, 'datetime')
  const u = await turn(sid, 'desconhecida')
  assert.equal(u.status, 'error')
  assert.equal(
    u.content,
    'Erro: ferramenta desconhecida: nope. Disponíveis: read_file, shell, datetime.'
  )
})

test('runner: datetime roda sem aprovação (fuso do aparelho)', async () => {
  const sid = await newChat()
  const r = await turn(sid, 'hora')
  assert.equal(r.status, 'ok')
  assert.equal(r.content, String(new Date().getFullYear()))
})

test('runner: sem compactação não há tool_search (nem na request nem na execução)', async () => {
  const sid = await newChat({ toolsCompact: false })
  const r = await turn(sid, 'busca')
  assert.equal(r.status, 'error')
  assert.match(r.content, /a ferramenta "tool_search" não está disponível/)
  const req = hits.filter((h) => textOf(h.messages.at(-1)?.content) === 'busca').at(-1)
  assert.ok(!req.tools.some((t: any) => t.function.name === 'tool_search'))
  assert.ok(!textOf(req.messages[0].content).includes(COMPACT_TOOLS_PROMPT))
  // inválidos numa tool completa: o erro de sempre (sem a definição — o modelo já a tem)
  const v = await turn(sid, 'invalido')
  assert.ok(!v.content.includes('foi enviada compactada'))
})
