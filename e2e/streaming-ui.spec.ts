/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do streaming na UI real (Playwright + `e2e/launch.ts`, app buildado): a resposta aparece no
// chat AOS PEDAÇOS, enquanto o provedor ainda está gerando — não só no fim. Provedores FALSOS
// locais que mandam o SSE devagar (um delta a cada PAUSE ms):
//   - Anthropic (Messages API nativa, 127.0.0.1 no papel do host oficial → busca nativa de tools,
//     `native-anthropic`): texto puro; raciocínio omitido (bloco `thinking` vazio + assinatura, o
//     padrão dos Claude 4.7+); raciocínio resumido; busca do servidor (server_tool_use +
//     tool_search_tool_result) antes do texto;
//   - OpenRouter (Messages API `/messages`, `native-openrouter`): pré-busca do roteador + texto;
//   - OpenRouter (Chat Completions, tools compactadas desligadas): controle.
// Cada variante também é servida como a API real serve (`content-encoding: gzip` quando o cliente
// aceita, CRLF, linhas `event:`), porque é aí que um proxy/descompressor pode segurar o corpo.
// A página registra (MutationObserver) quando cada pedaço fica visível; o servidor, quando escreveu
// cada um. Passa se os pedaços aparecem antes do fim do stream, cada um logo depois de escrito.
// userData isolado, sync num endereço morto, microfone negado, nada de rede/chave real.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/streaming-ui.spec.ts
import type { ElectronApplication, Locator, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { constants as zc, createGzip, type Gzip } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-streaming-ui'))
const SHOTS = resolve(process.env.CLEARCHAT_SHOTS || join(BASE, 'shots'))
const CWD = join(BASE, 'cwd')
const CLAUDE = 'claude-haiku-4-5'
const OR_CLAUDE = 'anthropic/claude-haiku-4.5'
/** Pedaços de texto por resposta e o intervalo entre eles. */
const PIECES = 8
const PAUSE = 250

let llm: Server
let llmBase = ''
let app: ElectronApplication
let page: Page

/** Linha do tempo do servidor por cenário (ms epoch — mesmo relógio da página). */
interface ServerTimeline {
  start: number
  pieces: number[]
  end: number
  encoding: string
}
const timelines = new Map<string, ServerTimeline>()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}

const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

/** Marcador do pedaço `i` do cenário `id` (o texto que a página procura). */
const piece = (id: string, i: number): string => `pedaco-${id}-${i}`

/** Escritor SSE com a forma da API real: gzip (se aceito), CRLF opcional, flush por evento. */
function sseWriter(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { gzip: boolean; crlf: boolean }
): { write: (s: string) => void; end: () => Promise<void>; encoding: string } {
  const gzip = opts.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  }
  if (gzip) headers['Content-Encoding'] = 'gzip'
  res.writeHead(200, headers)
  const nl = (s: string): string => (opts.crlf ? s.replace(/\n/g, '\r\n') : s)
  if (!gzip)
    return {
      write: (s) => void res.write(nl(s)),
      end: async () => void res.end(),
      encoding: 'identity'
    }
  const z: Gzip = createGzip({ flush: zc.Z_SYNC_FLUSH })
  z.pipe(res)
  return {
    write: (s) => {
      z.write(nl(s))
      z.flush(zc.Z_SYNC_FLUSH)
    },
    end: () => new Promise<void>((r) => z.end(() => r())),
    encoding: 'gzip'
  }
}

const anthEvent = (e: any): string => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`

/**
 * Resposta da Messages API (Anthropic ou OpenRouter) para o cenário `id` (a 1ª palavra da última
 * mensagem do usuário: `<id> <variante>`). Variantes: `texto`, `omitido` (thinking vazio, padrão
 * dos Claude novos), `resumo` (thinking com texto), `busca` (busca do servidor antes do texto),
 * `prebusca` (pré-busca do OpenRouter).
 */
async function messagesTurn(
  req: IncomingMessage,
  res: ServerResponse,
  body: any,
  flavor: 'anthropic' | 'openrouter'
): Promise<void> {
  const last = (body.messages ?? []).at(-1)
  const [id = 'x', variant = 'texto', enc = ''] = textOf(last?.content).trim().split(/\s+/)
  const w = sseWriter(req, res, { gzip: enc.includes('gzip'), crlf: enc.includes('crlf') })
  const tl: ServerTimeline = { start: Date.now(), pieces: [], end: 0, encoding: w.encoding }
  timelines.set(id, tl)
  const send = (e: any): void => w.write(anthEvent(e))
  send({
    type: 'message_start',
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 40, output_tokens: 1 }
    }
  })
  let idx = 0
  if (flavor === 'openrouter' && variant === 'prebusca') {
    // pré-busca que o roteador injeta (input vazio) + resultado opaco
    send({
      type: 'content_block_start',
      index: idx,
      content_block: {
        type: 'server_tool_use',
        id: `orpresearch_${id}`,
        name: 'openrouter:tool_search',
        input: {}
      }
    })
    send({ type: 'content_block_stop', index: idx++ })
    send({
      type: 'content_block_start',
      index: idx,
      content_block: {
        type: 'openrouter_tool_search_result',
        tool_use_id: `orpresearch_${id}`,
        content: { tool_names: ['datetime'] }
      }
    })
    send({ type: 'content_block_stop', index: idx++ })
  }
  if (variant === 'omitido' || variant === 'resumo') {
    send({
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'thinking', thinking: '', signature: '' }
    })
    if (variant === 'resumo')
      for (let i = 0; i < 3; i++) {
        await sleep(PAUSE)
        send({
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'thinking_delta', thinking: `pensando ${i}… ` }
        })
      }
    else await sleep(PAUSE * 3)
    send({
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJh' }
    })
    send({ type: 'content_block_stop', index: idx++ })
  }
  if (variant === 'busca') {
    send({
      type: 'content_block_start',
      index: idx,
      content_block: {
        type: 'server_tool_use',
        id: `srvtoolu_${id}`,
        name: 'tool_search_tool_regex'
      }
    })
    send({
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'input_json_delta', partial_json: '{"pattern":"date"}' }
    })
    send({ type: 'content_block_stop', index: idx++ })
    send({
      type: 'content_block_start',
      index: idx,
      content_block: {
        type: 'tool_search_tool_result',
        tool_use_id: `srvtoolu_${id}`,
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: [{ type: 'tool_reference', tool_name: 'datetime' }]
        }
      }
    })
    send({ type: 'content_block_stop', index: idx++ })
  }
  send({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } })
  for (let i = 1; i <= PIECES; i++) {
    await sleep(PAUSE)
    // `longo`: cada pedaço é um parágrafo comprido — a resposta passa da altura da janela e o chat
    // precisa acompanhar o fim enquanto ela cresce
    const filler = variant === 'longo' ? `\n\n${'texto de enchimento '.repeat(60)}\n\n` : ''
    send({
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'text_delta', text: `${i === 1 ? '' : ' '}${filler}${piece(id, i)}` }
    })
    tl.pieces.push(Date.now())
    send({ type: 'ping' })
  }
  send({ type: 'content_block_stop', index: idx })
  send({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 }
  })
  send({ type: 'message_stop' })
  await w.end()
  tl.end = Date.now()
}

/** Chat Completions do OpenRouter (controle). */
async function chatTurn(req: IncomingMessage, res: ServerResponse, body: any): Promise<void> {
  const last = (body.messages ?? []).at(-1)
  const [id = 'x', , enc = ''] = textOf(last?.content).trim().split(/\s+/)
  const w = sseWriter(req, res, { gzip: enc.includes('gzip'), crlf: enc.includes('crlf') })
  const tl: ServerTimeline = { start: Date.now(), pieces: [], end: 0, encoding: w.encoding }
  timelines.set(id, tl)
  const chunk = (delta: any, finish?: string): string =>
    `data: ${JSON.stringify({ id: 'gen', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
  w.write(': OPENROUTER PROCESSING\n\n')
  for (let i = 1; i <= PIECES; i++) {
    await sleep(PAUSE)
    w.write(chunk({ role: 'assistant', content: `${i === 1 ? '' : ' '}${piece(id, i)}` }))
    tl.pieces.push(Date.now())
  }
  w.write(chunk({}, 'stop'))
  w.write('data: [DONE]\n\n')
  await w.end()
  tl.end = Date.now()
}

async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      try {
        if (url.startsWith('/anthropic/')) {
          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                data: [{ id: CLAUDE, display_name: 'Claude Haiku 4.5', max_input_tokens: 200000 }],
                has_more: false
              })
            )
            return
          }
          const body = JSON.parse((await readBody(req)) || '{}')
          await messagesTurn(req, res, body, 'anthropic')
          return
        }
        if (url.startsWith('/openrouter/')) {
          if (req.method === 'GET' && url.includes('/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                data: [
                  {
                    id: OR_CLAUDE,
                    name: 'Claude Haiku 4.5',
                    context_length: 200000,
                    supported_parameters: ['tools', 'max_tokens', 'reasoning']
                  }
                ]
              })
            )
            return
          }
          if (req.method === 'GET') {
            res.writeHead(404)
            res.end()
            return
          }
          const body = JSON.parse((await readBody(req)) || '{}')
          if (url.endsWith('/messages')) await messagesTurn(req, res, body, 'openrouter')
          else await chatTurn(req, res, body)
          return
        }
        res.writeHead(404)
        res.end()
      } catch (e) {
        console.error('[fake]', e)
        res.destroy()
      }
    })()
  })
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`
}

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  delete env.ANTHROPIC_API_KEY
  env.CLEARCHAT_USER_DATA = join(BASE, 'user-data')
  // provedores falsos no papel dos hosts oficiais (busca nativa de tools, 1.12.0)
  env.CLEARCHAT_E2E_NATIVE_HOSTS = '127.0.0.1'
  env.CLEARCHAT_SYNC_URL = 'http://127.0.0.1:9'
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'streaming-main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w?.setSize(1360, 900)
    // não roubar o teclado do usuário
    w?.setFocusable(false)
    w?.blur()
  })
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
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

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  what: string,
  ms = 15_000
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout esperando: ${what}`)
    await sleep(100)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

const shots: string[] = []
async function shot(name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path })
  shots.push(path)
}

const results: { name: string; ok: boolean; info?: string }[] = []
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
    await shot(`erro-${results.length}`).catch(() => {})
  }
}

const composer = (): Locator => page.locator('textarea[placeholder="Mensagem…"]')

/**
 * Observador na página: a 1ª vez (ms epoch) em que cada marcador fica VISÍVEL NA TELA — no texto
 * renderizado, dentro da área visível da rolagem do chat e acima do composer flutuante (um texto
 * que chega mas fica abaixo da dobra não conta). Confere a cada mutação e a cada quadro.
 */
async function watch(markers: string[]): Promise<void> {
  await page.evaluate((ms) => {
    const w = window as any
    w.__seen = {} as Record<string, number>
    w.__obs?.disconnect()
    if (w.__raf) cancelAnimationFrame(w.__raf)
    const onScreen = (m: string): boolean => {
      const sc = document.querySelector('[data-testid="chat-scroller"]')
      if (!sc) return false
      const view = sc.getBoundingClientRect()
      const composer = document.querySelector('textarea[placeholder="Mensagem…"]')
      const bottom = composer
        ? Math.min(view.bottom, composer.getBoundingClientRect().top)
        : view.bottom
      const walk = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.nodeValue?.indexOf(m) ?? -1
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + m.length)
        const b = r.getBoundingClientRect()
        if (b.height > 0 && b.top >= view.top - 1 && b.bottom <= bottom + 1) return true
      }
      return false
    }
    const check = (): void => {
      const text = document.body.innerText
      for (const m of ms)
        if (w.__seen[m] == null && text.includes(m) && onScreen(m)) w.__seen[m] = Date.now()
    }
    w.__obs = new MutationObserver(check)
    w.__obs.observe(document.body, { subtree: true, childList: true, characterData: true })
    const frame = (): void => {
      check()
      w.__raf = requestAnimationFrame(frame)
    }
    frame()
  }, markers)
}
const seen = (): Promise<Record<string, number>> =>
  page.evaluate(() => ({ ...((window as any).__seen ?? {}) }))

/** Abre o chat `title` pela barra lateral. */
async function openChat(title: string): Promise<void> {
  await page.getByText(title, { exact: true }).first().click()
  await composer().waitFor({ timeout: 15_000 })
}

/**
 * Manda `<id> <variante> [enc]` no chat aberto e confere que os pedaços apareceram na tela
 * enquanto o servidor ainda escrevia: o 1º visível antes do último ser escrito e cada pedaço visível
 * em até `PAUSE * 2` ms depois de escrito (folga do throttle de 40 ms + IPC + render).
 */
async function runTurn(chatId: string, id: string, variant: string, enc = ''): Promise<string> {
  const markers = Array.from({ length: PIECES }, (_, i) => piece(id, i + 1))
  await watch(markers)
  const text = `${id} ${variant}${enc ? ` ${enc}` : ''}`
  await composer().click()
  await composer().fill(text)
  await composer().press('Enter')
  const c = await api<any>('chats.get', chatId)
  await waitFor(async () => {
    const list = await api<any[]>('sessions.messages', c.mainSessionId)
    return list.some(
      (m) => m.message.role === 'assistant' && textOf(m.message.content).includes(piece(id, PIECES))
    )
  }, `resposta ${id} gravada`)
  await page.getByText(piece(id, PIECES)).first().waitFor({ timeout: 5000 })
  const tl = timelines.get(id)
  assert(tl && tl.end, `servidor não registrou o cenário ${id}`)
  const s = await seen()
  const lag = markers.map((m, i) => (s[m] == null ? null : s[m] - tl.pieces[i]))
  const before = markers.filter((m) => s[m] != null && s[m] < tl.pieces[PIECES - 1]).length
  const info = `${tl.encoding}; visíveis antes do fim: ${before}/${PIECES}; atraso por pedaço (ms): ${lag.join(', ')}`
  assert(before >= PIECES - 2, `pedaços só no fim (streaming quebrado) — ${info}`)
  const late = lag.filter((l) => l == null || l > PAUSE * 2)
  assert(late.length <= 1, `pedaços atrasados — ${info}`)
  return info
}

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(CWD, { recursive: true })
  await startLlm()
  await launch()

  const chats: Record<string, string> = {}
  await step(
    'preparo: provedores falsos (Anthropic, OpenRouter) e um chat em cada modo',
    async () => {
      const anth = await api('providers.create', {
        name: 'Anthropic falsa',
        kind: 'anthropic',
        baseUrl: `${llmBase}/anthropic/v1`,
        apiKey: 'sk-ant-fake'
      })
      const or = await api('providers.create', {
        name: 'OpenRouter falso',
        kind: 'openrouter',
        baseUrl: `${llmBase}/openrouter/api/v1`,
        apiKey: 'sk-or-fake'
      })
      await api('settings.set', 'defaultProviderId', anth.id)
      await api('settings.set', 'defaultModel', CLAUDE)
      await api('settings.set', 'defaultCwd', CWD)
      const mk = async (title: string, config: any): Promise<string> =>
        (await api<any>('chats.create', { title, config: { cwd: CWD, ...config } })).id
      chats.anth = await mk('Stream Anthropic', { providerId: anth.id, model: CLAUDE })
      chats.orMsg = await mk('Stream OpenRouter Messages', { providerId: or.id, model: OR_CLAUDE })
      chats.orChat = await mk('Stream OpenRouter Chat', {
        providerId: or.id,
        model: OR_CLAUDE,
        toolsCompact: false
      })
      await page.reload()
      await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
      const p1 = await api<any>(
        'agent.previewRequest',
        (await api<any>('chats.get', chats.anth)).mainSessionId
      )
      const p2 = await api<any>(
        'agent.previewRequest',
        (await api<any>('chats.get', chats.orMsg)).mainSessionId
      )
      const p3 = await api<any>(
        'agent.previewRequest',
        (await api<any>('chats.get', chats.orChat)).mainSessionId
      )
      assert(p1.toolSearch?.mode === 'native-anthropic', `anthropic: ${p1.toolSearch?.mode}`)
      assert(p1.body.stream === true, 'anthropic: stream true')
      assert(
        p2.toolSearch?.mode === 'native-openrouter' && p2.url.endsWith('/messages'),
        `or: ${p2.toolSearch?.mode} ${p2.url}`
      )
      assert(p2.body.stream === true, 'openrouter messages: stream true')
      assert(p3.url.endsWith('/chat/completions'), `or chat: ${p3.url}`)
      return `modos: ${p1.toolSearch.mode}, ${p2.toolSearch.mode}, ${p3.toolSearch?.mode ?? 'off'}`
    }
  )

  await openChat('Stream Anthropic')
  let n = 0
  for (const [variant, enc] of [
    ['texto', ''],
    ['omitido', ''],
    ['resumo', ''],
    ['busca', ''],
    ['longo', ''],
    ['texto', 'gzip'],
    ['omitido', 'gzip-crlf']
  ] as const) {
    const id = `a${++n}`
    await step(
      `Anthropic (native-anthropic): ${variant}${enc ? ` + ${enc}` : ''} aparece aos pedaços`,
      () => runTurn(chats.anth, id, variant, enc)
    )
  }
  await shot('streaming-anthropic')

  await openChat('Stream OpenRouter Messages')
  for (const [variant, enc] of [
    ['texto', ''],
    ['prebusca', ''],
    ['omitido', 'gzip']
  ] as const) {
    const id = `m${++n}`
    await step(
      `OpenRouter /messages (native-openrouter): ${variant}${enc ? ` + ${enc}` : ''} aparece aos pedaços`,
      () => runTurn(chats.orMsg, id, variant, enc)
    )
  }

  await openChat('Stream OpenRouter Chat')
  for (const enc of ['', 'gzip']) {
    const id = `c${++n}`
    await step(
      `OpenRouter Chat Completions (controle)${enc ? ` + ${enc}` : ''} aparece aos pedaços`,
      () => runTurn(chats.orChat, id, 'texto', enc)
    )
  }

  await app.close()
  llm.close()
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passos ok`)
  console.log(`screenshots:\n${shots.join('\n')}`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
}

main().catch(async (e) => {
  console.error(e)
  await app?.close().catch(() => {})
  llm?.close()
  process.exit(1)
})
