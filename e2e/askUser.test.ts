/* eslint-disable @typescript-eslint/no-explicit-any */
// Testes unitários do questionário (tool ask_user), sem Electron: validação dos argumentos,
// classificação de ícone/imagem/ajuda, validação das respostas, texto do resultado, resolução de
// imagens (servidor HTTP local, caminho fora do raiz, svg inline), GC e disponibilidade por depth.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import Database from 'better-sqlite3'
import {
  ASK_USER_APP_CLOSED,
  ASK_USER_NOT_ANSWERED,
  classifyHelp,
  classifyIcon,
  formatAskUserResult,
  parseAskUserArgs,
  validateAnswers
} from '../src/shared/askUser.ts'
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../src/shared/tools.ts'
import { CONFIRM_TOOLS } from '../src/shared/types.ts'
import { APPROVAL_TOOLS, approvalRoute } from '../src/shared/approvalPolicy.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import { availableTools, buildRequest, sanitizeHistory } from '../src/main/agent/request.ts'
import {
  gcAttachments,
  mimeForFile,
  readAttachment,
  referencedFilesInDb,
  setAttachmentsDir
} from '../src/main/attachments.ts'
import { resolveAskUserQuestions, resolveImageRef, sniffImage } from '../src/main/askUserImages.ts'
import type { Chat, StoredMessage } from '../src/shared/types.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-ask-'))
const STORE = join(TMP, 'store')
const ROOT = join(TMP, 'root')
mkdirSync(ROOT, { recursive: true })
setAttachmentsDir(STORE)
after(() => rmSync(TMP, { recursive: true, force: true }))

function png(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(14))),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

const q = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Qual banco?',
  options: [{ title: 'PostgreSQL' }, { title: 'SQLite' }],
  ...over
})

// ---------------- validação ----------------

test('ask_user: validação — limites e erros legíveis', () => {
  const ok = parseAskUserArgs({ questions: [q()] })
  assert.ok('questions' in ok)
  assert.equal(ok.questions[0].multiple, false)
  assert.deepEqual(ok.questions[0].options, [{ title: 'PostgreSQL' }, { title: 'SQLite' }])

  const err = (args: Record<string, unknown>): string => {
    const r = parseAskUserArgs(args)
    assert.ok('error' in r, JSON.stringify(r))
    return r.error
  }
  assert.match(err({}), /"questions" ausente/)
  assert.match(err({ questions: [] }), /vazia/)
  assert.match(err({ questions: Array(6).fill(q()) }), /máximo de 5 perguntas.*recebidas 6/)
  const seven = Array.from({ length: 7 }, (_, i) => ({ title: `o${i}` }))
  assert.match(
    err({ questions: [q(), q({ options: seven })] }),
    /Máximo de 5 opções por pergunta \(pergunta 2 tem 7\)/
  )
  assert.match(err({ questions: [q({ title: '' })] }), /pergunta 1 › title: obrigatório/)
  assert.match(err({ questions: [q({ title: 'x'.repeat(201) })] }), /201 caracteres — máximo 200/)
  assert.match(
    err({ questions: [q({ description: 'x'.repeat(1001) })] }),
    /description: 1001 caracteres — máximo 1000/
  )
  assert.match(err({ questions: [q({ options: [] })] }), /options: vazia/)
  assert.match(
    err({ questions: [q({ options: [{ title: '' }] })] }),
    /opção 1 › title: obrigatório/
  )
  assert.match(err({ questions: [q({ multiple: 'sim' })] }), /multiple: deve ser true ou false/)
  assert.match(
    err({ questions: [q({ options: [{ title: 'a', help: 'x\n'.repeat(2001) }] })] }),
    /help: \d+ caracteres — máximo 4000/
  )
  const bigSvg = `<svg>${'x'.repeat(210 * 1024)}</svg>`
  assert.match(
    err({ questions: [q({ options: [{ title: 'a', image: bigSvg }] })] }),
    /image: SVG inline com \d+ KB — máximo 200 KB/
  )
  assert.match(
    err({ questions: [q({ options: [{ title: 'a', icon: 'isto não é um ícone válido' }] })] }),
    /icon: .*não é um nome de ícone lucide/
  )
  // erro diz que nada foi mostrado
  assert.match(err({ questions: [q({ title: '' })] }), /nada foi mostrado ao usuário/)
  // questions como string JSON é aceito; campos opcionais vazios somem
  const s = parseAskUserArgs({
    questions: JSON.stringify([
      q({ description: '  ', multiple: true, options: [{ title: 'a', icon: '', description: '' }] })
    ])
  })
  assert.ok('questions' in s)
  assert.deepEqual(s.questions[0], {
    title: 'Qual banco?',
    multiple: true,
    options: [{ title: 'a' }]
  })
})

test('ask_user: classificação de icon / help', () => {
  assert.equal(classifyIcon('database'), 'lucide')
  assert.equal(classifyIcon('circle-help'), 'lucide')
  assert.equal(classifyIcon('🐘'), 'text')
  assert.equal(classifyIcon('<svg viewBox="0 0 1 1"></svg>'), 'svg')
  assert.equal(classifyIcon('https://x.dev/a.png'), 'url')
  assert.equal(classifyIcon('icons/db.png'), 'path')
  assert.equal(classifyIcon('logo.svg'), 'path')
  assert.equal(classifyIcon('C:\\img\\a'), 'path')
  assert.equal(classifyIcon('Database'), 'text') // não é kebab-case
  assert.equal(classifyHelp('┌─┐\n│a│ /usr/bin\n└─┘'), 'text')
  assert.equal(classifyHelp('docs/diagram.png'), 'path')
  assert.equal(classifyHelp('https://x.dev/d.png'), 'url')
  assert.equal(classifyHelp('veja https://x.dev para mais'), 'text')
  assert.equal(classifyHelp(SVG), 'svg')
})

// ---------------- respostas / resultado ----------------

const QS = [
  {
    title: 'Qual banco de dados?',
    multiple: false,
    options: [{ title: 'PostgreSQL' }, { title: 'SQLite' }]
  },
  {
    title: 'Quais recursos?',
    multiple: true,
    options: [{ title: 'Cache' }, { title: 'Filas' }, { title: 'Busca' }]
  },
  { title: 'Hospedagem?', multiple: false, options: [{ title: 'AWS' }] }
]

test('ask_user: validação das respostas (sem pular; uma só em single)', () => {
  assert.match((validateAnswers(QS, []) as any).error, /Responda todas as 3/)
  assert.match(
    (validateAnswers(QS, [{ selected: [0] }, { selected: [] }, { selected: [0] }]) as any).error,
    /Pergunta 2 sem resposta/
  )
  assert.match(
    (
      validateAnswers(QS, [
        { selected: [0] },
        { selected: [0] },
        { selected: [], other: '   ' }
      ]) as any
    ).error,
    /Pergunta 3 sem resposta/
  )
  assert.match(
    (validateAnswers(QS, [{ selected: [0, 1] }, { selected: [0] }, { selected: [0] }]) as any)
      .error,
    /Pergunta 1 aceita uma resposta só/
  )
  assert.match(
    (
      validateAnswers(QS, [
        { selected: [0], other: 'x' },
        { selected: [0] },
        { selected: [0] }
      ]) as any
    ).error,
    /aceita uma resposta só/
  )
  assert.match(
    (validateAnswers(QS, [{ selected: [9] }, { selected: [0] }, { selected: [0] }]) as any).error,
    /opção inválida/
  )
  const v = validateAnswers(QS, [
    { selected: [0] },
    { selected: [1, 0], other: ' notificações push ' },
    { selected: [], other: 'servidor próprio na Hetzner' }
  ])
  assert.ok('answers' in v)
  assert.deepEqual(v.answers[1], { selected: [0, 1], other: 'notificações push' })
})

test('ask_user: texto do resultado (single, multiple, Outro, combinado, notas)', () => {
  const text = formatAskUserResult(QS, [
    { selected: [0] },
    { selected: [0, 1], other: 'notificações push' },
    { selected: [], other: 'servidor próprio na Hetzner' }
  ])
  assert.equal(
    text,
    'Respostas do usuário:\n' +
      '1. Qual banco de dados? → PostgreSQL\n' +
      '2. Quais recursos? → Cache, Filas, Outro: "notificações push"\n' +
      '3. Hospedagem? → Outro: "servidor próprio na Hetzner"'
  )
  const withNotes = formatAskUserResult(
    QS.slice(0, 1),
    [{ selected: [1] }],
    ['[imagem da opção 2 da pergunta 1 indisponível: HTTP 404]']
  )
  assert.equal(
    withNotes,
    'Respostas do usuário:\n1. Qual banco de dados? → SQLite\n\n[imagem da opção 2 da pergunta 1 indisponível: HTTP 404]'
  )
  assert.equal(ASK_USER_NOT_ANSWERED, '[O usuário não respondeu ao questionário]')
  assert.equal(ASK_USER_APP_CLOSED, '[não respondido: o app foi fechado]')
})

// ---------------- disponibilidade / aprovação ----------------

const mkChat = (over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  // definições completas (a compactação, 1.11.0, tem testes próprios em compactTools.test.ts)
  config: {
    ...DEFAULT_CHAT_CONFIG(ROOT, { providerId: 'p1', model: 'm' }),
    toolsCompact: false,
    ...over
  }
})

test('ask_user: só na sessão principal; sem confirmação nem Smart-Approve', () => {
  assert.ok(TOOL_NAMES.includes('ask_user'))
  assert.ok(DEFAULT_CHAT_CONFIG('/x').enabledTools.includes('ask_user'))
  const chat = mkChat()
  assert.ok(availableTools(chat, { depth: 0 }).includes('ask_user'))
  assert.ok(!availableTools(chat, { depth: 1 }).includes('ask_user'))
  assert.ok(!availableTools(chat, { depth: 2 }).includes('ask_user'))
  assert.ok(!CONFIRM_TOOLS.includes('ask_user'))
  assert.ok(!APPROVAL_TOOLS.includes('ask_user'))
  assert.equal(approvalRoute(chat.config, null, 'ask_user').kind, 'run')
  // na request: definição com o schema aninhado (array de objetos)
  const p = {
    id: 'p1',
    name: 'X',
    baseUrl: 'https://api.x/v1',
    apiKey: 'k',
    headers: {},
    createdAt: 0
  }
  const body0 = buildRequest(chat, { depth: 0, model: 'm' }, [], p, { os: 'L', shell: 'bash' })
    .body as any
  const def = body0.tools.find((t: any) => t.function.name === 'ask_user')
  assert.ok(def)
  assert.equal(def.function.parameters.properties.questions.items.properties.options.maxItems, 5)
  assert.match(def.function.description, /Outro/)
  assert.match(def.function.description, /NÃO use para uma pergunta aberta simples/)
  const body1 = buildRequest(chat, { depth: 1, model: 'm' }, [], p, { os: 'L', shell: 'bash' })
    .body as any
  assert.ok(!body1.tools.some((t: any) => t.function.name === 'ask_user'))
  assert.equal(TOOL_DEFINITIONS.ask_user.function.parameters.required?.[0], 'questions')
})

test('ask_user: cancelado + nova mensagem → histórico válido (tool_call ↔ tool, depois o user)', () => {
  let seq = 0
  const sm = (message: any, meta = {}): StoredMessage => ({
    id: String(++seq),
    sessionId: 's1',
    seq,
    message,
    meta,
    createdAt: 0
  })
  const hist = [
    sm({ role: 'user', content: 'monte o serviço' }),
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'a1', type: 'function', function: { name: 'ask_user', arguments: '{}' } }]
    }),
    sm(
      { role: 'tool', tool_call_id: 'a1', content: ASK_USER_NOT_ANSWERED },
      { toolStatus: 'cancelled', synthetic: true, kind: 'tool-cancelled' }
    ),
    sm({ role: 'user', content: 'use Postgres' })
  ]
  const out = sanitizeHistory(hist.map((m) => m.message))
  assert.deepEqual(
    out.map((m: any) => m.role),
    ['user', 'assistant', 'tool', 'user']
  )
  assert.equal((out[2] as any).content, ASK_USER_NOT_ANSWERED)
})

// ---------------- imagens ----------------

let server: Server
let base = ''
const hits: string[] = []
after(() => server?.close())
test('ask_user: resolução de imagens (URL local, 404, tipo errado, grande, svg, caminho, fora do raiz)', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1)
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    if (req.url === '/a.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(png())
    } else if (req.url === '/text') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html></html>')
    } else if (req.url === '/fake.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end('not really a png')
    } else if (req.url === '/big.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' }) // sem content-length (chunked)
      res.write(big.subarray(0, 3 * 1024 * 1024))
      res.end(big.subarray(3 * 1024 * 1024))
    } else if (req.url === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
      res.end(SVG)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const ctx = { root: ROOT, confine: true }

  const u = await resolveImageRef(`${base}/a.png`, ctx)
  assert.match(u, /^clearchat-attachment:\/\/[0-9a-f]{64}\.png$/)
  const file = u.slice('clearchat-attachment://'.length)
  assert.deepEqual(readAttachment(file), png())
  assert.equal(mimeForFile(file), 'image/png')

  const s = await resolveImageRef(`${base}/icon.svg`, ctx)
  assert.match(s, /\.svg$/)
  assert.equal(mimeForFile(s.slice(23)), 'image/svg+xml')

  await assert.rejects(resolveImageRef(`${base}/nope.png`, ctx), /HTTP 404/)
  await assert.rejects(resolveImageRef(`${base}/text`, ctx), /tipo não suportado \(text\/html\)/)
  await assert.rejects(resolveImageRef(`${base}/fake.png`, ctx), /não é uma imagem válida/)
  await assert.rejects(resolveImageRef(`${base}/big.png`, ctx), /máximo 5 MB/)

  // svg inline → arquivo .svg no store (exibido via <img>)
  const inline = await resolveImageRef(SVG, ctx)
  assert.match(inline, /\.svg$/)
  assert.equal(readAttachment(inline.slice(23)).toString('utf8'), SVG)

  // caminho local relativo ao raiz
  writeFileSync(join(ROOT, 'logo.png'), png())
  writeFileSync(join(ROOT, 'notes.txt'), 'oi')
  assert.equal(await resolveImageRef('logo.png', ctx), u) // mesmo conteúdo → mesmo arquivo (dedup)
  await assert.rejects(resolveImageRef('notes.txt', ctx), /não é uma imagem/)
  await assert.rejects(resolveImageRef('missing.png', ctx), /arquivo não encontrado/)
  // fora do raiz: recusado com confinação; aceito sem
  const outside = join(TMP, 'outside.png')
  writeFileSync(outside, png())
  await assert.rejects(resolveImageRef(outside, ctx), /fora do diretório raiz/)
  await assert.rejects(resolveImageRef('../outside.png', ctx), /fora do diretório raiz/)
  assert.equal(await resolveImageRef(outside, { root: ROOT, confine: false }), u)

  assert.equal(sniffImage(png()), 'png')
  assert.equal(sniffImage(Buffer.from(SVG)), 'svg')
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?>\n' + SVG)), 'svg')
  assert.equal(sniffImage(Buffer.from('<html>')), null)
})

test('ask_user: resolveAskUserQuestions — falha numa imagem não derruba; ícone imagem/lucide/emoji', async () => {
  const parsed = parseAskUserArgs({
    questions: [
      {
        title: 'Escolha',
        description: 'desc',
        options: [
          { title: 'A', icon: 'database', image: `${base}/a.png`, help: 'ajuda\n  ascii' },
          { title: 'B', icon: '🐘', image: `${base}/missing.png` },
          { title: 'C', icon: SVG, help: 'logo.png' },
          { title: 'D', icon: `${base}/missing.png` },
          { title: 'E', icon: '../outside.png' }
        ]
      }
    ]
  })
  assert.ok('questions' in parsed, JSON.stringify(parsed))
  const { questions, notes } = await resolveAskUserQuestions(parsed.questions, {
    root: ROOT,
    confine: true
  })
  const [a, b, c, d, e] = questions[0].options
  assert.deepEqual(a.icon, { kind: 'lucide', name: 'database' })
  assert.match(a.image ?? '', /^clearchat-attachment:\/\/.+\.png$/)
  assert.deepEqual(a.help, { kind: 'text', text: 'ajuda\n  ascii' })
  assert.deepEqual(b.icon, { kind: 'text', text: '🐘' })
  assert.equal(b.image, undefined)
  assert.equal(c.icon?.kind, 'image')
  assert.match((c.icon as any).url, /\.svg$/)
  assert.equal(c.help?.kind, 'image')
  assert.equal(d.icon, undefined)
  assert.equal(e.icon, undefined)
  assert.deepEqual(notes, [
    '[imagem da opção 2 da pergunta 1 indisponível: HTTP 404]',
    '[ícone da opção 4 da pergunta 1 indisponível: HTTP 404]',
    '[ícone da opção 5 da pergunta 1 indisponível: caminho fora do diretório raiz (acesso negado)]'
  ])
  // campos ausentes não aparecem
  assert.deepEqual(Object.keys(d), ['title'])
  assert.equal(questions[0].description, 'desc')
})

test('ask_user: GC preserva imagens referenciadas só no meta_json (askUser)', async () => {
  const keep = (
    await resolveImageRef(SVG.replace('r="4"', 'r="3"'), { root: ROOT, confine: true })
  ).slice(23)
  const orphan = (
    await resolveImageRef(SVG.replace('r="4"', 'r="2"'), { root: ROOT, confine: true })
  ).slice(23)
  const old = new Date(Date.now() - 2 * 3600_000)
  for (const f of [keep, orphan]) utimesSync(join(STORE, f), old, old)
  const db = new Database(':memory:')
  db.exec('CREATE TABLE messages (message_json TEXT, meta_json TEXT)')
  db.prepare('INSERT INTO messages VALUES (?, ?)').run(
    JSON.stringify({ role: 'tool', tool_call_id: 'a', content: 'Respostas do usuário: …' }),
    JSON.stringify({
      askUser: {
        outcome: 'answered',
        questions: [
          {
            title: 'x',
            multiple: false,
            options: [{ title: 'a', image: `clearchat-attachment://${keep}` }]
          }
        ]
      }
    })
  )
  const refs = referencedFilesInDb(db)
  assert.ok(refs.has(keep))
  const r = gcAttachments(STORE, refs)
  assert.ok(r.deleted.includes(orphan))
  assert.ok(existsSync(join(STORE, keep)))
  assert.ok(!existsSync(join(STORE, orphan)))
})
