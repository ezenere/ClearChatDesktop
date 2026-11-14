/* eslint-disable @typescript-eslint/no-explicit-any */
// Streaming no nível do cliente HTTP (`streamChat`, o mesmo fetch do main): o conteúdo chega ao
// acumulador AOS PEDAÇOS, enquanto o provedor ainda escreve — para a Messages API (Anthropic nativa
// e o /messages do OpenRouter, com raciocínio omitido/resumido e blocos do servidor) e a Chat
// Completions. Servidor falso em 127.0.0.1 que manda um evento a cada PAUSE ms, servido também como
// uma API real pode servir: gzip (quando o cliente aceita), CRLF, vários eventos num pacote e
// eventos cortados em bytes arbitrários (inclusive no meio de um caractere UTF-8).
// Par do `e2e/streaming-ui.spec.ts` (a mesma coisa na UI real).
// Rodar: npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { constants as zc, createGzip } from 'node:zlib'
import { newAccumulator, streamChat } from '../src/main/agent/llm.ts'
import type { BuiltRequest } from '../src/main/agent/request.ts'

const PIECES = 6
const PAUSE = 80
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Shape {
  /** Corpo comprimido (gzip com flush por evento, como um proxy que comprime SSE). */
  gzip?: boolean
  crlf?: boolean
  /** Cada evento sai em pedaços deste tamanho (bytes), com uma pausa curta entre eles. */
  splitBytes?: number
}
interface Timeline {
  pieces: number[]
  end: number
}

const piece = (i: number): string => `pedaço-ç${i}-é`
const anthEvent = (e: any): string => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`

/** Eventos do turno: `[pausa antes, texto SSE, índice do pedaço de texto ou -1]`. */
function messagesEvents(variant: string): [number, string, number][] {
  const out: [number, string, number][] = []
  const ev = (e: any, wait = 0, p = -1): number => out.push([wait, anthEvent(e), p])
  ev({
    type: 'message_start',
    message: { model: 'claude-x', usage: { input_tokens: 10, output_tokens: 1 } }
  })
  let idx = 0
  if (variant === 'prebusca') {
    ev({
      type: 'content_block_start',
      index: idx,
      content_block: {
        type: 'server_tool_use',
        id: 'orpresearch_1',
        name: 'openrouter:tool_search',
        input: {}
      }
    })
    ev({ type: 'content_block_stop', index: idx++ })
    ev({
      type: 'content_block_start',
      index: idx,
      content_block: {
        type: 'openrouter_tool_search_result',
        tool_use_id: 'orpresearch_1',
        content: { tool_names: ['datetime'] }
      }
    })
    ev({ type: 'content_block_stop', index: idx++ })
  }
  if (variant === 'omitido' || variant === 'resumo') {
    ev({
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'thinking', thinking: '', signature: '' }
    })
    if (variant === 'resumo')
      ev(
        {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'thinking_delta', thinking: 'hmm' }
        },
        PAUSE
      )
    ev(
      {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'signature_delta', signature: 'c2ln' }
      },
      PAUSE
    )
    ev({ type: 'content_block_stop', index: idx++ })
  }
  if (variant === 'busca') {
    ev({
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex' }
    })
    ev({
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'input_json_delta', partial_json: '{"pattern":"x"}' }
    })
    ev({ type: 'content_block_stop', index: idx++ })
    ev({
      type: 'content_block_start',
      index: idx,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: { type: 'tool_search_tool_search_result', tool_references: [] }
      }
    })
    ev({ type: 'content_block_stop', index: idx++ })
  }
  ev({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } })
  for (let i = 1; i <= PIECES; i++) {
    ev(
      { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: piece(i) } },
      PAUSE,
      i
    )
    ev({ type: 'ping' })
  }
  ev({ type: 'content_block_stop', index: idx })
  ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })
  ev({ type: 'message_stop' })
  return out
}

function chatEvents(): [number, string, number][] {
  const c = (delta: any, finish?: string): string =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
  const out: [number, string, number][] = [[0, ': OPENROUTER PROCESSING\n\n', -1]]
  for (let i = 1; i <= PIECES; i++) out.push([PAUSE, c({ content: piece(i) }), i])
  out.push([0, c({}, 'stop'), -1], [0, 'data: [DONE]\n\n', -1])
  return out
}

let srv: Server
let base = ''
const timelines = new Map<string, Timeline>()

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = ''
  for await (const c of req) raw += c
  const body = JSON.parse(raw || '{}')
  const u = new URL(req.url ?? '/', 'http://x')
  const shape: Shape = {
    gzip: u.searchParams.has('gzip'),
    crlf: u.searchParams.has('crlf'),
    splitBytes: Number(u.searchParams.get('split')) || undefined
  }
  const id = u.searchParams.get('id') ?? 'x'
  const events = u.pathname.endsWith('/messages')
    ? messagesEvents(u.searchParams.get('variant') ?? 'texto')
    : chatEvents()
  assert.equal(body.stream, true, 'request pede stream')
  const gzip = shape.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {})
  })
  const z = gzip ? createGzip() : null
  z?.pipe(res)
  const out = (b: Buffer): void => {
    if (z) {
      z.write(b)
      z.flush(zc.Z_SYNC_FLUSH)
    } else res.write(b)
  }
  const tl: Timeline = { pieces: [], end: 0 }
  timelines.set(id, tl)
  for (const [wait, text, p] of events) {
    if (wait) await sleep(wait)
    const bytes = Buffer.from(shape.crlf ? text.replace(/\n/g, '\r\n') : text)
    if (shape.splitBytes)
      for (let i = 0; i < bytes.length; i += shape.splitBytes) {
        out(bytes.subarray(i, i + shape.splitBytes))
        await sleep(2)
      }
    else out(bytes)
    if (p > 0) tl.pieces.push(Date.now())
  }
  // fim = último evento escrito (o cliente para no message_stop/[DONE], antes do fim do corpo)
  tl.end = Date.now()
  if (z) await new Promise<void>((r) => z.end(() => r()))
  else res.end()
}

before(async () => {
  srv = createServer((req, res) => void serve(req, res).catch(() => res.destroy()))
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
})
after(() => srv?.close())

let seq = 0
/**
 * Roda `streamChat` e confere: cada pedaço chega ao acumulador (via onUpdate) logo depois de
 * escrito pelo servidor — bem antes do fim do stream — e o texto final está inteiro.
 */
async function check(
  path: string,
  req: Pick<BuiltRequest, 'kind' | 'api'>,
  qs: string
): Promise<void> {
  const id = `t${++seq}`
  const acc = newAccumulator()
  const seen: number[] = []
  await streamChat(
    {
      url: `${base}${path}?id=${id}&${qs}`,
      headers: { 'content-type': 'application/json' },
      body: { model: 'm', messages: [{ role: 'user', content: 'oi' }], stream: true },
      ...req
    } as BuiltRequest,
    new AbortController().signal,
    acc,
    () => {
      for (let i = seen.length + 1; i <= PIECES && acc.content.includes(piece(i)); i++)
        seen.push(Date.now())
    }
  )
  const tl = timelines.get(id)!
  for (let i = 0; !tl.end && i < 100; i++) await sleep(5)
  const all = Array.from({ length: PIECES }, (_, i) => piece(i + 1)).join('')
  assert.equal(acc.content, all, 'texto completo (UTF-8 inteiro)')
  assert.equal(acc.completed, true)
  assert.equal(seen.length, PIECES, 'todos os pedaços passaram pelo onUpdate')
  const lags = seen.map((t, i) => t - tl.pieces[i])
  // o 1º pedaço chegou com (PIECES-1) pausas de antecedência sobre o fim; cada um sem atraso
  assert.ok(seen[0] < tl.end - PAUSE * (PIECES - 2), `1º pedaço só no fim: ${seen[0] - tl.end} ms`)
  assert.ok(
    lags.every((l) => l < PAUSE / 2 + (Number(new URLSearchParams(qs).get('split')) ? 60 : 0)),
    `pedaços atrasados (ms): ${lags.join(', ')}`
  )
}

const ANTH = { kind: 'anthropic', api: 'messages' } as const
const ORM = { kind: 'openrouter', api: 'messages' } as const
const ORC = { kind: 'openrouter', api: 'chat' } as const

test('streamChat: Anthropic nativa (texto, raciocínio omitido/resumido, busca do servidor) chega aos pedaços', async () => {
  for (const variant of ['texto', 'omitido', 'resumo', 'busca'])
    await check('/v1/messages', ANTH, `variant=${variant}`)
})

test('streamChat: /messages do OpenRouter (pré-busca do roteador, raciocínio omitido) chega aos pedaços', async () => {
  for (const variant of ['texto', 'prebusca', 'omitido'])
    await check('/api/v1/messages', ORM, `variant=${variant}`)
})

test('streamChat: Chat Completions chega aos pedaços (controle)', async () => {
  await check('/api/v1/chat/completions', ORC, '')
})

test('streamChat: forma da resposta real — gzip com flush, CRLF, eventos cortados em bytes (UTF-8 no meio)', async () => {
  await check('/v1/messages', ANTH, 'variant=omitido&gzip')
  await check('/v1/messages', ANTH, 'variant=busca&crlf')
  await check('/v1/messages', ANTH, 'variant=texto&split=7')
  await check('/v1/messages', ANTH, 'variant=texto&split=3&crlf')
  await check('/api/v1/messages', ORM, 'variant=prebusca&gzip&crlf&split=13')
  await check('/api/v1/chat/completions', ORC, 'gzip&split=5')
})
