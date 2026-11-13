/* eslint-disable @typescript-eslint/no-explicit-any */
// read_file de imagens/PDF (sem Electron): decisão por capacidade do modelo (ok/parsed/unsupported/
// unknown), persistência por referência (sem base64 no banco), limites (redução injetada), expansão
// na cópia por adaptador (Anthropic: tool_result com image/document; OpenAI/OpenRouter: mídia numa
// mensagem user logo após o bloco de tools), compactação, preview, read_history e GC.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import Database from 'better-sqlite3'
import {
  hoistToolMedia,
  referencedFilesInDb,
  setAttachmentsDir,
  truncateBodyForPreview
} from '../src/main/attachments.ts'
import { buildRequest } from '../src/main/agent/request.ts'
import { buildCompactionRequest } from '../src/main/agent/compaction.ts'
import { readFile } from '../src/main/tools/files.ts'
import {
  imageSize,
  MEDIA_LIMITS,
  mediaDecision,
  pdfPageCount,
  setImageProcessor,
  sniffMedia,
  type MediaContext
} from '../src/main/tools/media.ts'
import { describeMessage, searchHistory } from '../src/main/tools/history.ts'
import { contentText } from '../src/shared/attachments.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import type { ApiMessage, Chat, ContentPart, Provider, StoredMessage } from '../src/shared/types.ts'

const TMP = mkdtempSync(join(tmpdir(), 'cc-readmedia-'))
const STORE = join(TMP, 'store')
const ROOT = join(TMP, 'root')
mkdirSync(ROOT, { recursive: true })
setAttachmentsDir(STORE)
after(() => {
  setImageProcessor(null)
  rmSync(TMP, { recursive: true, force: true })
})

// PNG válido mínimo (w×h, RGB) — imageSize lê o IHDR
function png(w: number, h: number, extra = 0): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(Math.min(h, 4) * (1 + w * 3))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    ...(extra ? [chunk('tEXt', Buffer.alloc(extra, 0x61))] : []),
    chunk('IEND', Buffer.alloc(0))
  ])
}
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF\n'
)

writeFileSync(join(ROOT, 'tela.png'), png(320, 120, 400)) // > 200 chars em base64 (preview encurta)
writeFileSync(join(ROOT, 'doc.pdf'), PDF)
writeFileSync(join(ROOT, 'icone.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>\n')
writeFileSync(join(ROOT, 'grande.png'), png(4000, 3000))

const media = (
  providerKind: MediaContext['providerKind'],
  inputModalities?: string[]
): MediaContext => ({
  providerKind,
  model: async () => (inputModalities ? { inputModalities } : null)
})
const ctx = (m?: MediaContext, over: Record<string, unknown> = {}): any => ({
  cwd: ROOT,
  confine: true,
  signal: new AbortController().signal,
  media: m,
  ...over
})

test('detecção: sniff de PNG/JPEG/GIF/WebP/PDF, dimensões e páginas', () => {
  assert.deepEqual(sniffMedia(png(2, 3)), { kind: 'image', mime: 'image/png' })
  assert.deepEqual(imageSize(png(1280, 720)), { width: 1280, height: 720 })
  assert.deepEqual(sniffMedia(PDF), { kind: 'pdf', mime: 'application/pdf' })
  assert.equal(pdfPageCount(PDF), 1)
  const gif = Buffer.from('GIF89a\x10\x00\x20\x00', 'latin1')
  assert.deepEqual(sniffMedia(gif)?.mime, 'image/gif')
  assert.deepEqual(imageSize(gif), { width: 16, height: 32 })
  // JPEG: SOI + APP0 + SOF0 (altura 600, largura 800)
  const jpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03,
    0x20, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ])
  assert.deepEqual(imageSize(jpg), { width: 800, height: 600 })
  assert.equal(sniffMedia(Buffer.from('<svg/>')), null) // SVG é texto
  assert.equal(sniffMedia(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), null)
})

test('decisão por capacidade: ok / parsed / unsupported / unknown', () => {
  const w = '"a.png" é uma imagem PNG (1 KB)'
  // ok
  assert.deepEqual(
    mediaDecision('image', { inputModalities: ['text', 'image'] }, 'openrouter', w),
    {
      send: true
    }
  )
  assert.deepEqual(
    mediaDecision('pdf', { inputModalities: ['text', 'image', 'file'] }, 'anthropic', w),
    { send: true }
  )
  // parsed: PDF no OpenRouter em modelo sem 'file' (o OpenRouter extrai o texto)
  assert.deepEqual(mediaDecision('pdf', { inputModalities: ['text'] }, 'openrouter', w), {
    send: true
  })
  // unsupported
  const u = mediaDecision('image', { inputModalities: ['text'] }, 'openrouter', w) as any
  assert.equal(u.send, false)
  assert.match(u.error, /Este modelo não lê imagens; read_file só pode devolver texto/)
  assert.match(u.error, /imagem PNG \(1 KB\)/)
  const up = mediaDecision('pdf', { inputModalities: ['text', 'image'] }, 'openai', w) as any
  assert.match(up.error, /não lê PDFs/)
  // unknown: imagem → tenta; PDF → erro com dica
  assert.deepEqual(mediaDecision('image', null, 'openai', w), { send: true })
  const uk = mediaDecision('pdf', null, 'openai', w) as any
  assert.equal(uk.send, false)
  assert.match(uk.error, /não sei se este modelo lê PDFs/)
  assert.match(uk.error, /pdftotext/)
})

test('read_file: imagem → parts por referência (texto + image_url), sem base64', async () => {
  const r = await readFile({ path: 'tela.png' }, ctx(media('openrouter', ['text', 'image'])))
  assert.equal(r.status, 'ok')
  assert.equal(r.content, '[imagem: tela.png, ' + r.content.split(', ')[1] + ', 320×120]')
  const [t, img] = r.parts as any[]
  assert.equal(t.type, 'text')
  assert.equal(t.text, r.content)
  assert.equal(img.type, 'image_url')
  assert.match(img.image_url.url, /^clearchat-attachment:\/\/[0-9a-f]{64}\.png$/)
  assert.equal(img._attachment.kind, 'image')
  assert.equal(img._attachment.name, 'tela.png')
  assert.ok(!JSON.stringify(r.parts).includes('base64'))
  // offset/limit não se aplicam → aviso
  const r2 = await readFile(
    { path: 'tela.png', offset: 1, limit: 3 },
    ctx(media('anthropic', ['text', 'image', 'file']))
  )
  assert.match(r2.content, /offset\/limit ignorados/)
})

test('read_file: PDF ok/parsed; unsupported e sem contexto → erro claro; SVG = texto', async () => {
  const p = await readFile({ path: 'doc.pdf' }, ctx(media('openrouter', ['text'])))
  assert.equal(p.status, 'ok')
  assert.match(p.content, /^\[PDF: doc\.pdf, .*1 página\]$/)
  assert.equal((p.parts as any[])[1].type, 'file')
  assert.match((p.parts as any[])[1].file.file_data, /^clearchat-attachment:\/\/[0-9a-f]{64}\.pdf$/)

  const no = await readFile({ path: 'tela.png' }, ctx(media('openrouter', ['text'])))
  assert.equal(no.status, 'error')
  assert.equal(no.parts, undefined)
  assert.match(no.content, /Este modelo não lê imagens; read_file só pode devolver texto/)
  assert.match(no.content, /imagem PNG/)

  const noCtx = await readFile({ path: 'tela.png' }, ctx(undefined))
  assert.equal(noCtx.status, 'error')

  const svg = await readFile({ path: 'icone.svg' }, ctx(media('openrouter', ['text'])))
  assert.equal(svg.status, 'ok')
  assert.match(svg.content, /<svg/)

  // confinamento continua valendo
  await assert.rejects(
    readFile({ path: '/etc/hosts' }, ctx(media('openai'))),
    /fora do diretório raiz/
  )
})

test('limites: imagem grande é reduzida pelo processador injetado; sem processador → erro', async () => {
  const m = media('anthropic', ['text', 'image', 'file'])
  setImageProcessor(null)
  const e = await readFile({ path: 'grande.png' }, ctx(m))
  assert.equal(e.status, 'error')
  assert.match(e.content, /grande demais/)
  assert.match(e.content, /4\.000×3\.000/)

  let called: any = null
  setImageProcessor((_data, _mime, opts) => {
    called = opts
    return { data: png(2000, 1500), mime: 'image/png', width: 2000, height: 1500 }
  })
  const r = await readFile({ path: 'grande.png' }, ctx(m))
  assert.equal(r.status, 'ok')
  assert.deepEqual(called, {
    maxSide: MEDIA_LIMITS.imageMaxSide,
    maxBytes: MEDIA_LIMITS.imageMaxBytes
  })
  assert.match(r.content, /reduzida de 4\.000×3\.000 .* para 2\.000×1\.500/)
  assert.equal((r.parts as any[])[1]._attachment.mime, 'image/png')

  // processador que falha → erro legível
  setImageProcessor(() => null)
  const f = await readFile({ path: 'grande.png' }, ctx(m))
  assert.match(f.content, /não foi possível reduzi-la/)
  setImageProcessor(null)
})

// ---------------- request / persistência ----------------

let seq = 0
const sm = (message: ApiMessage, meta = {}): StoredMessage => ({
  id: String(++seq),
  sessionId: 's1',
  seq,
  message,
  meta,
  createdAt: 0
})
const env = { os: 'Linux 6.0 (x64)', shell: 'bash' }
const prov = (kind: Provider['kind'], baseUrl: string): Provider => ({
  id: 'p',
  name: 'P',
  kind,
  baseUrl,
  apiKey: 'k-0123456789abcdef',
  headers: {},
  createdAt: 0
})
const OR = prov('openrouter', 'https://openrouter.ai/api/v1')
const OAI = prov('openai', 'http://localhost:1234/v1')
const ANTH = prov('anthropic', 'https://api.anthropic.com/v1')
const chat = (over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG(ROOT, { providerId: 'p', model: 'm', systemPrompt: 'SYS' }),
    enabledTools: ['read_file'],
    envInPrompt: false,
    ...over
  } as Chat['config']
})

async function history(): Promise<{ hist: StoredMessage[]; parts: ContentPart[] }> {
  const r = await readFile({ path: 'tela.png' }, ctx(media('openrouter', ['text', 'image'])))
  const parts = r.parts as ContentPart[]
  const call = (id: string, path: string): any => ({
    id,
    type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path }) }
  })
  return {
    parts,
    hist: [
      sm({ role: 'user', content: 'veja a tela' }),
      sm({
        role: 'assistant',
        content: null,
        tool_calls: [call('c1', 'tela.png'), call('c2', 'x')]
      }),
      sm({ role: 'tool', tool_call_id: 'c1', content: parts }, { toolStatus: 'ok' }),
      sm({ role: 'tool', tool_call_id: 'c2', content: 'texto' }, { toolStatus: 'ok' }),
      sm({ role: 'assistant', content: 'vi' })
    ]
  }
}

test('persistência: message_json só com referência; GC enxerga a referência da msg tool', async () => {
  const { hist } = await history()
  const json = JSON.stringify(hist[2].message)
  assert.ok(json.includes('clearchat-attachment://'))
  assert.ok(!json.includes('base64'))
  const db = new Database(':memory:')
  db.exec('CREATE TABLE messages (id TEXT, message_json TEXT, meta_json TEXT)')
  db.prepare('INSERT INTO messages (id, message_json) VALUES (?, ?)').run('1', json)
  const refs = referencedFilesInDb(db)
  db.close()
  assert.equal(refs.size, 1)
  assert.match([...refs][0], /^[0-9a-f]{64}\.png$/)
})

test('OpenRouter / OpenAI: role tool vira texto e a imagem vai numa user logo após o bloco de tools', async () => {
  const { hist } = await history()
  // Chat Completions (no OpenRouter, a compactação ligada iria pela Messages API — busca nativa)
  const cc = (): Chat => chat({ toolsCompact: false })
  for (const p of [OR, OAI]) {
    const req = buildRequest(cc(), { depth: 0, model: 'm' }, hist, p, env)
    const msgs = (req.body as any).messages
    // system, user, assistant, tool c1, tool c2, user (mídia), assistant
    assert.deepEqual(
      msgs.map((m: any) => m.role),
      ['system', 'user', 'assistant', 'tool', 'tool', 'user', 'assistant']
    )
    assert.equal(typeof msgs[3].content === 'string' || Array.isArray(msgs[3].content), true)
    assert.match(
      contentText(msgs[3].content),
      /^\[imagem: tela\.png.*\]\n\[imagem anexada na próxima mensagem\]$/
    )
    assert.ok(!JSON.stringify(msgs[3]).includes('image_url'))
    const u = msgs[5].content
    assert.equal(u[0].type, 'image_url')
    assert.match(u[0].image_url.url, /^data:image\/png;base64,iVBOR/)
    assert.equal(u[0]._attachment, undefined)
    assert.equal(u[1].text, '[arquivos retornados por read_file: tela.png]')
    // determinístico (cache de prefixo)
    const again = buildRequest(cc(), { depth: 0, model: 'm' }, hist, p, env)
    assert.equal(JSON.stringify(again.body), JSON.stringify(req.body))
  }
  // histórico persistido intacto
  assert.ok(Array.isArray(hist[2].message.content))
  // hoist sem mídia: identidade
  const plain: ApiMessage[] = [{ role: 'tool', tool_call_id: 'x', content: 'a' }]
  assert.equal(hoistToolMedia(plain), plain)
})

test('Anthropic nativo: tool_result com blocos text + image (e document para PDF)', async () => {
  const { hist } = await history()
  const pdf = await readFile(
    { path: 'doc.pdf' },
    ctx(media('anthropic', ['text', 'image', 'file']))
  )
  hist.push(
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c3', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
    }),
    sm({ role: 'tool', tool_call_id: 'c3', content: pdf.parts as ContentPart[] })
  )
  const req = buildRequest(chat(), { depth: 0, model: 'claude-haiku-4-5' }, hist, ANTH, env)
  const msgs = (req.body as any).messages
  const tr = msgs[2].content[0]
  assert.equal(tr.type, 'tool_result')
  assert.equal(tr.tool_use_id, 'c1')
  assert.equal(tr.content[0].type, 'text')
  assert.match(tr.content[0].text, /^\[imagem: tela\.png/)
  assert.equal(tr.content[1].type, 'image')
  assert.equal(tr.content[1].source.type, 'base64')
  assert.equal(tr.content[1].source.media_type, 'image/png')
  assert.equal(msgs[2].content[1].content, 'texto')
  const last = msgs[msgs.length - 1].content[0]
  assert.equal(last.type, 'tool_result')
  assert.equal(last.content[1].type, 'document')
  assert.equal(last.content[1].source.media_type, 'application/pdf')
  assert.ok(!JSON.stringify(req.body).includes('_attachment'))
  assert.ok(!JSON.stringify(req.body).includes('clearchat-attachment'))
  // preview encurta o base64 dentro do tool_result
  const prev = truncateBodyForPreview(req.body)
  assert.equal(prev.truncated, 2)
  assert.match(
    (prev.body as any).messages[2].content[0].content[1].source.data,
    /…\(\d+(,\d)? (KB|B)\)$/
  )
})

test('compactação trimmed: mídia da msg tool vira placeholder; preview OpenRouter encurta', async () => {
  const { hist } = await history()
  const trimmed = buildCompactionRequest(
    chat(),
    { id: 's1', depth: 0, model: 'm' },
    hist,
    OR,
    'RESUMA',
    { mode: 'trimmed', window: null },
    env
  )
  const body = JSON.stringify(trimmed.body)
  assert.ok(!body.includes('base64'))
  assert.ok(body.includes('[imagem: tela.png]'))
  const full = buildRequest(chat(), { depth: 0, model: 'm' }, hist, OR, env)
  const prev = truncateBodyForPreview(full.body)
  assert.equal(prev.truncated, 1)
})

test('read_history e texto: msg tool em parts', async () => {
  const { hist } = await history()
  const names = new Map([['c1', 'read_file']])
  const d = describeMessage(hist[2], names, true)
  assert.match(d.text, /^\[imagem: tela\.png.*\]\n\[anexos: tela\.png\]$/)
  const omitted = describeMessage(hist[2], names, false)
  assert.match(omitted.text, /\+ 1 anexo\(s\)/)
  const found = searchHistory(hist, { query: 'tela.png' })
  assert.match(found, /#\d+ tool \(read_file\): \[imagem: tela\.png/)
  assert.match(contentText(hist[2].message.content), /^\[imagem: tela\.png/)
})
