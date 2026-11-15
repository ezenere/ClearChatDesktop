// browse_url: carregamento da página (src/main/tools/browsePage.ts) num Electron de verdade com um
// servidor local — o bug "timeout de 25s" (2026-11-15: UOL/Tudo Gostoso quase sempre): o HTML vem na
// hora, mas anúncios seguram o load para sempre e o executeJavaScript só roda com a página parada.
// Também a lista de bloqueio pura (browseBlock.ts). Sem rede externa: os "domínios de anúncio"
// resolvem para o servidor local (--host-resolver-rules). Sem microfone (launchElectron).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/browsePage.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { isBlockedBrowseRequest } from '../src/main/tools/browseBlock.ts'
import { launchElectron } from './launch.ts'

test('bloqueio: anúncio/rastreio e tipos sem texto saem; a página principal e o resto ficam', () => {
  const b = isBlockedBrowseRequest
  assert.equal(b('https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script'), true)
  assert.equal(b('https://pagead2.googlesyndication.com/x', 'subFrame'), true)
  assert.equal(b('https://image6.pubmatic.com/AdServer/x', 'xhr'), true)
  assert.equal(b('https://cdn.taboola.com/libtrc/x.js', 'script'), true)
  assert.equal(b('https://adservice.google.com.br/ddm/fls', 'script'), true)
  assert.equal(b('https://www.uol.com.br/fonte.woff2', 'font'), true, 'fonte')
  assert.equal(b('https://www.uol.com.br/foto.jpg', 'image'), true, 'imagem')
  assert.equal(b('https://www.uol.com.br/', 'mainFrame'), false, 'a página nunca')
  assert.equal(b('https://www.taboola.com/', 'mainFrame'), false, 'nem num domínio da lista')
  assert.equal(b('https://www.uol.com.br/app.js', 'script'), false)
  assert.equal(
    b('https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.js', 'script'),
    false
  )
  assert.equal(b('https://notdoubleclick.net/x.js', 'script'), false, 'só o domínio e subdomínios')
  assert.equal(b('not a url', 'script'), false)
})

// ---------------- Electron real + servidor local ----------------

let server: Server
let port = 0
const hits: string[] = []
let app: ElectronApplication | null = null

const PAGE = (body: string, head = ''): string =>
  `<!doctype html><html><head><title>Receita</title>${head}</head><body>${body}</body></html>`

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/'
    hits.push(`${req.headers.host?.split(':')[0]}${path}`)
    if (path === '/hang.js' || path === '/never' || path === '/ad.js') return // nunca responde
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (path === '/ads')
      return res.end(
        PAGE(
          '<article><h1>Maionese defumada</h1><p>CONTEUDO_PRINCIPAL da receita.</p></article>' +
            // anúncios que nunca terminam (o load nunca dispara) e um script de anúncio "bloqueado"
            `<script async src="/hang.js"></script><iframe src="/never"></iframe>` +
            `<script async src="http://securepubads.g.doubleclick.net:${port}/ad.js"></script>`
        )
      )
    if (path === '/spa')
      return res.end(
        PAGE(
          '<div id="app">carregando…</div>' +
            '<script>setTimeout(() => { document.getElementById("app").innerHTML = "<p>MONTADO_PELO_JS</p>" }, 300)</script>'
        )
      )
    res.end(PAGE('<p>ok</p>'))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  app = await launchElectron({
    args: [
      `--host-resolver-rules=MAP *.doubleclick.net 127.0.0.1`,
      resolve(import.meta.dirname, 'fixtures/browse-main.mjs')
    ]
  })
  await app.evaluate(async () => {
    const g = globalThis as { __browse?: unknown }
    for (let i = 0; i < 200 && !g.__browse; i++) await new Promise((r) => setTimeout(r, 50))
  })
})

after(async () => {
  await app?.close().catch(() => {})
  server?.close()
})

interface Result {
  ms: number
  timedOut: boolean
  source: string
  html: string
  error?: string
}

async function load(path: string, timings: Record<string, number> = {}): Promise<Result> {
  return app!.evaluate(
    async (_e, [url, t]) => {
      const b = (globalThis as any).__browse // eslint-disable-line @typescript-eslint/no-explicit-any
      const t0 = Date.now()
      try {
        const r = await b.loadPage(url, new AbortController().signal, t)
        return { ms: Date.now() - t0, timedOut: r.timedOut, source: r.source, html: r.page.html }
      } catch (e) {
        return { ms: Date.now() - t0, timedOut: false, source: '', html: '', error: String(e) }
      }
    },
    [`http://127.0.0.1:${port}${path}`, timings] as const
  )
}

test('página cheia de anúncio (o load nunca dispara): conteúdo em segundos, sem o timeout de 25 s', async () => {
  const r = await load('/ads')
  assert.equal(r.error, undefined)
  assert.ok(r.html.includes('CONTEUDO_PRINCIPAL'), 'o conteúdo veio')
  assert.equal(r.timedOut, false)
  assert.equal(r.source, 'dom')
  assert.ok(r.ms < 8000, `${r.ms} ms (antes: 25 s + falha)`)
  assert.ok(
    !hits.some((h) => h.startsWith('securepubads.g.doubleclick.net')),
    `o anúncio nunca saiu: ${hits.join(', ')}`
  )
})

test('SPA: o conteúdo montado pelo JS depois do load entra (espera curta depois do load)', async () => {
  const r = await load('/spa')
  assert.equal(r.error, undefined)
  assert.ok(r.html.includes('MONTADO_PELO_JS'), r.html.slice(0, 300))
})

test('servidor que nunca responde: erro no timeout (configurável), sem esperar a leitura nem o HTML cru', async () => {
  const r = await load('/never', { timeoutMs: 1500 })
  assert.match(r.error ?? '', /timeout de 1\.5s/)
  assert.ok(r.ms < 3000, `${r.ms} ms`)
})
