/* eslint-disable @typescript-eslint/no-explicit-any */
// Adaptadores de provider (sem Electron): request nativa Anthropic (/messages — headers, system,
// imagem/PDF/áudio, tool_use/tool_result agrupados, alternância, cache_control), parse do SSE
// nativo (texto + tool_use + usage), /models nativo e despacho openai/openrouter/anthropic.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildUserContent, saveAttachment, setAttachmentsDir } from '../src/main/attachments.ts'
import { buildRequest, maskRequest } from '../src/main/agent/request.ts'
import { newAccumulator, streamChat, readableError } from '../src/main/agent/llm.ts'
import {
  applyAnthropicEvent,
  mapAnthropicModel,
  toAnthropicMessages
} from '../src/main/agent/adapters/anthropic.ts'
import { buildJudgeRequest } from '../src/main/agent/smartApprove.ts'
import { normalizeSmartApprove } from '../src/shared/smartApprove.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import type { ApiMessage, Chat, Provider, StoredMessage } from '../src/shared/types.ts'

const STORE = mkdtempSync(join(tmpdir(), 'cc-adapters-'))
setAttachmentsDir(STORE)
after(() => rmSync(STORE, { recursive: true, force: true }))

const env = { os: 'Linux 6.0 (x64)', shell: 'bash' }
const anth: Provider = {
  id: 'pa',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-api03-0123456789abcdefXYZ9',
  headers: {},
  createdAt: 0
}
const chat = (over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('/work', { providerId: 'pa', model: 'm', systemPrompt: 'SYS' }),
    enabledTools: ['read_file'],
    envInPrompt: false,
    // definições completas (a compactação, 1.11.0, tem testes próprios em compactTools.test.ts)
    toolsCompact: false,
    ...over
  } as Chat['config']
})
let seq = 0
const sm = (message: ApiMessage, meta = {}): StoredMessage => ({
  id: String(++seq),
  sessionId: 's1',
  seq,
  message,
  meta,
  createdAt: 0
})

test('anthropic: URL /messages, headers nativos (sem Bearer) e key mascarada no preview', () => {
  const req = buildRequest(
    chat(),
    { depth: 0, model: 'claude-x' },
    [],
    {
      ...anth,
      baseUrl: 'https://api.anthropic.com/v1/',
      headers: { 'anthropic-beta': 'b1' }
    },
    env
  )
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(req.kind, 'anthropic')
  assert.equal(req.headers['x-api-key'], anth.apiKey)
  assert.equal(req.headers['anthropic-version'], '2023-06-01')
  assert.equal(req.headers['anthropic-beta'], 'b1')
  assert.ok(!Object.keys(req.headers).some((k) => k.toLowerCase() === 'authorization'))
  const masked = maskRequest(req, anth.apiKey)
  assert.equal(masked.headers['x-api-key'], 'sk-ant…XYZ9')
  assert.ok(!JSON.stringify(masked).includes(anth.apiKey))
})

test('anthropic: body — system top-level, tools input_schema, params e max_tokens padrão', () => {
  const c = chat({
    cacheEnabled: false,
    params: {
      temperature: 0.3,
      top_k: 5,
      frequency_penalty: 1,
      seed: 3,
      reasoning_effort: 'high',
      extraBody: '{"metadata":{"user_id":"u"}}'
    }
  })
  const b = buildRequest(
    c,
    { depth: 0, model: 'claude-x' },
    [sm({ role: 'user', content: 'oi' })],
    anth,
    env
  ).body as any
  assert.deepEqual(b.system, [{ type: 'text', text: 'SYS' }])
  assert.deepEqual(b.messages, [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }])
  assert.equal(b.max_tokens, 32000)
  assert.equal(b.temperature, 0.3)
  assert.equal(b.top_k, 5)
  assert.equal(b.stream, true)
  assert.deepEqual(b.metadata, { user_id: 'u' })
  for (const k of [
    'frequency_penalty',
    'seed',
    'reasoning_effort',
    'reasoning',
    'stream_options',
    'usage'
  ])
    assert.equal(b[k], undefined, k)
  assert.equal(b.tools.length, 1)
  assert.equal(b.tools[0].name, 'read_file')
  assert.equal(b.tools[0].input_schema.type, 'object')
  assert.equal(b.tools[0].type, undefined)
  // max_tokens definido no chat vence; modelos antigos têm teto menor
  const b2 = buildRequest(
    chat({ params: { max_tokens: 100 } }),
    { depth: 0, model: 'x' },
    [],
    anth,
    env
  ).body as any
  assert.equal(b2.max_tokens, 100)
  const b3 = buildRequest(chat(), { depth: 0, model: 'claude-3-5-haiku-20241022' }, [], anth, env)
    .body as any
  assert.equal(b3.max_tokens, 8192)
})

test('anthropic: imagem → image base64, PDF → document, áudio → placeholder de texto', () => {
  const img = saveAttachment({ name: 'a.png', data: Uint8Array.from([137, 80, 78, 71, 1, 2]) })
  const pdf = saveAttachment({ name: 'doc.pdf', data: Buffer.from('%PDF-1.4 teste') })
  const wav = saveAttachment({ name: 'voz.wav', data: Uint8Array.from([82, 73, 70, 70, 0, 0]) })
  const hist = [sm({ role: 'user', content: buildUserContent('leia', [img, pdf, wav]) })]
  const b = buildRequest(chat({ cacheEnabled: false }), { depth: 0, model: 'm' }, hist, anth, env)
    .body as any
  const c = b.messages[0].content
  assert.deepEqual(c[0], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from([137, 80, 78, 71, 1, 2]).toString('base64')
    }
  })
  assert.deepEqual(c[1], {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: Buffer.from('%PDF-1.4 teste').toString('base64')
    }
  })
  assert.deepEqual(c[2], { type: 'text', text: '[áudio não suportado por este provider: voz.wav]' })
  assert.deepEqual(c[3], { type: 'text', text: 'leia' })
  assert.ok(!JSON.stringify(b).includes('_attachment'))
  assert.ok(!JSON.stringify(b).includes('clearchat-attachment'))
})

test('anthropic: tool_calls → tool_use, tools consecutivas agrupadas num user, alternância', () => {
  const msgs: ApiMessage[] = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    {
      role: 'assistant',
      content: 'vou ler',
      reasoning: 'pensando',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } },
        { id: 't2', type: 'function', function: { name: 'list_dir', arguments: '' } },
        { id: 't3', type: 'function', function: { name: 'bash', arguments: '{quebrado' } }
      ]
    },
    { role: 'tool', tool_call_id: 't1', content: 'conteúdo' },
    { role: 'tool', tool_call_id: 't2', content: '' },
    { role: 'tool', tool_call_id: 't3', content: 'r3' },
    { role: 'user', content: 'e agora?' },
    { role: 'assistant', content: null, tool_calls: [] as any },
    { role: 'assistant', content: 'fim' }
  ]
  const { system, messages } = toAnthropicMessages(msgs)
  assert.deepEqual(system, [{ type: 'text', text: 'S' }])
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant']
  )
  assert.deepEqual(messages[0].content, [
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' }
  ])
  assert.deepEqual(messages[1].content, [
    { type: 'text', text: 'vou ler' },
    { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x' } },
    { type: 'tool_use', id: 't2', name: 'list_dir', input: {} },
    { type: 'tool_use', id: 't3', name: 'bash', input: { raw: '{quebrado' } }
  ])
  assert.deepEqual(messages[2].content, [
    { type: 'tool_result', tool_use_id: 't1', content: 'conteúdo' },
    { type: 'tool_result', tool_use_id: 't2' },
    { type: 'tool_result', tool_use_id: 't3', content: 'r3' },
    { type: 'text', text: 'e agora?' }
  ])
  assert.deepEqual(messages[3].content, [{ type: 'text', text: 'fim' }])
  assert.ok(!JSON.stringify(messages).includes('pensando'))
})

test('anthropic: cache_control nativo (system + última mensagem + último user)', () => {
  const hist = [
    sm({ role: 'user', content: 'pergunta' }),
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
    }),
    sm({ role: 'tool', tool_call_id: 't1', content: 'res' })
  ]
  const b = buildRequest(chat(), { depth: 0, model: 'm' }, hist, anth, env).body as any
  assert.deepEqual(b.system.at(-1).cache_control, { type: 'ephemeral' })
  // último user (com a pergunta) e o user com o tool_result (última mensagem)
  assert.equal(b.messages.length, 3)
  assert.deepEqual(b.messages[0].content.at(-1).cache_control, { type: 'ephemeral' })
  assert.equal(b.messages[1].content.at(-1).cache_control, undefined)
  assert.deepEqual(b.messages[2].content.at(-1), {
    type: 'tool_result',
    tool_use_id: 't1',
    content: 'res',
    cache_control: { type: 'ephemeral' }
  })
  const n = JSON.stringify(b).split('cache_control').length - 1
  assert.ok(n <= 4)
  const off = buildRequest(chat({ cacheEnabled: false }), { depth: 0, model: 'm' }, hist, anth, env)
  assert.ok(!JSON.stringify(off.body).includes('cache_control'))
})

test('anthropic: SSE nativo → texto, tool_use, usage e finishReason', () => {
  const acc = newAccumulator()
  const evs: any[] = [
    {
      type: 'message_start',
      message: {
        model: 'claude-haiku-4-5',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 5,
          output_tokens: 1
        }
      }
    },
    { type: 'ping' },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Vou ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ler.' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} }
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"pa' }
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'input_json_delta', partial_json: 'th":"x"}' }
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' }
  ]
  for (const e of evs) applyAnthropicEvent(acc, e)
  assert.equal(acc.model, 'claude-haiku-4-5')
  assert.equal(acc.content, 'Vou ler.')
  assert.equal(acc.reasoning, 'hmm')
  assert.deepEqual(acc.toolCalls, [{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"x"}' }])
  assert.equal(acc.finishReason, 'tool_calls')
  assert.deepEqual(acc.usage, {
    promptTokens: 115,
    completionTokens: 42,
    cachedTokens: 100,
    cacheWriteTokens: 5
  })
  const a2 = newAccumulator()
  applyAnthropicEvent(a2, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } })
  assert.equal(a2.finishReason, 'length')
  assert.throws(
    () =>
      applyAnthropicEvent(newAccumulator(), {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' }
      }),
    /Overloaded/
  )
  assert.match(
    readableError(
      400,
      'Bad Request',
      '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: Field required"}}'
    ),
    /max_tokens: Field required/
  )
})

test('anthropic: streamChat contra servidor local com SSE nativo', async () => {
  const sse = [
    [
      'message_start',
      {
        type: 'message_start',
        message: { model: 'claude-t', usage: { input_tokens: 3, output_tokens: 1 } }
      }
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Olá' } }
    ],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
    ],
    ['message_stop', { type: 'message_stop' }]
  ]
  let seen: any = null
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen = { url: req.url, headers: req.headers, body: JSON.parse(raw) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [ev, data] of sse) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)
      // o servidor não fecha a conexão: message_stop encerra
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try {
    const req = buildRequest(
      chat(),
      { depth: 0, model: 'claude-t' },
      [sm({ role: 'user', content: 'oi' })],
      {
        ...anth,
        baseUrl: `http://127.0.0.1:${port}/v1`
      },
      env
    )
    const acc = newAccumulator()
    await streamChat(req, new AbortController().signal, acc, () => {})
    assert.equal(seen.url, '/v1/messages')
    assert.equal(seen.headers['x-api-key'], anth.apiKey)
    assert.equal(seen.headers.authorization, undefined)
    assert.equal(acc.content, 'Olá')
    assert.equal(acc.finishReason, 'stop')
    assert.equal(acc.completed, true)
    assert.deepEqual(acc.usage, { promptTokens: 3, completionTokens: 2 })
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('anthropic: /models nativo → ModelInfo (capabilities)', () => {
  const m = mapAnthropicModel({
    id: 'claude-haiku-4-5',
    display_name: 'Claude Haiku 4.5',
    max_input_tokens: 200000,
    max_tokens: 64000,
    capabilities: { image_input: { supported: true }, pdf_input: { supported: true } }
  })!
  assert.deepEqual(m, {
    id: 'claude-haiku-4-5',
    supportsTools: true,
    name: 'Claude Haiku 4.5',
    contextLength: 200000,
    inputModalities: ['text', 'image', 'file']
  })
  const t = mapAnthropicModel({
    id: 'x',
    capabilities: { image_input: { supported: false }, pdf_input: { supported: false } }
  })!
  assert.deepEqual(t.inputModalities, ['text'])
  assert.equal(mapAnthropicModel({}), null)
})

test('openai/openrouter: tipo pelo campo kind (não só pela URL) e juiz pelo adaptador', () => {
  const generic: Provider = {
    ...anth,
    kind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k'
  }
  const r1 = buildRequest(
    chat({ params: { reasoning_effort: 'low' } }),
    { depth: 0, model: 'm' },
    [],
    generic,
    env
  )
  assert.equal(r1.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(r1.headers.Authorization, 'Bearer k')
  assert.equal((r1.body as any).reasoning_effort, 'low')
  assert.equal((r1.body as any).usage, undefined)
  // proxy OpenRouter-compatível com outra URL, marcado como openrouter
  const orp: Provider = { ...generic, kind: 'openrouter' }
  const r2 = buildRequest(
    chat({ params: { reasoning_effort: 'low' } }),
    { depth: 0, model: 'm' },
    [],
    orp,
    env
  )
  assert.deepEqual((r2.body as any).reasoning, { effort: 'low' })
  assert.deepEqual((r2.body as any).usage, { include: true })
  // juiz do Smart-Approve
  const sa = normalizeSmartApprove({ enabled: true, providerId: 'pa', model: 'claude-j' } as any)
  const ctx = { tool: 'read_file', args: { path: 'x' }, history: [] } as any
  const j = buildJudgeRequest({ sa, provider: anth, chatConfig: {}, ctx })!
  assert.equal(j.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(j.kind, 'anthropic')
  assert.equal((j.body as any).max_tokens, 300)
  assert.equal((j.body as any).temperature, 0)
  assert.ok(Array.isArray((j.body as any).system))
  assert.equal((j.body as any).messages[0].role, 'user')
  const j2 = buildJudgeRequest({ sa, provider: orp, chatConfig: {}, ctx })!
  assert.deepEqual((j2.body as any).usage, { include: true })
})
