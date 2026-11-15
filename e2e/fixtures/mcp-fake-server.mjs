/* eslint-disable @typescript-eslint/explicit-function-return-type -- fixture em JS puro (sem tipos) */
// Servidor MCP FALSO (testes do cliente MCP — e2e/mcp*.test.ts). Sem dependências. Como PROCESSO,
// fala stdio; importado, `startFakeMcpHttp` sobe o mesmo servidor em Streamable HTTP (127.0.0.1, com
// OAuth opcional). Fala os dois "eras" do protocolo, escolhidos pelo env (ou pelas opções):
//   FAKE_MCP_ERA=legacy         2025: handshake `initialize`; método desconhecido antes dele → -32601
//   FAKE_MCP_ERA=legacy-silent  2025, mas IGNORA métodos desconhecidos (alguns servidores antigos)
//   FAKE_MCP_ERA=modern         2026-07-28: sem handshake, `server/discover`, resultType, MRTR
// Outros envs: FAKE_MCP_LOG=<arquivo> (uma linha JSON por mensagem recebida), FAKE_MCP_NAME,
// FAKE_MCP_INSTRUCTIONS, FAKE_MCP_TOOLS=echo,image,... (subconjunto/ordem das tools).
// Tools: echo, image, slow (progresso; respeita cancelamento), fail (isError), ask (pede dados ao
// usuário — elicitação: pedido do servidor no 2025, `input_required` no 2026), structured, big, env.
import { appendFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const ALL_TOOLS = {
  echo: {
    name: 'echo',
    title: 'Eco',
    description: 'Devolve o texto recebido. Use para testar a conexão.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Texto a devolver' } },
      required: ['text']
    },
    annotations: { readOnlyHint: true }
  },
  image: {
    name: 'image',
    description: 'Devolve uma imagem PNG de 1 pixel.',
    inputSchema: { type: 'object', properties: {} }
  },
  slow: {
    name: 'slow',
    description: 'Demora: manda progresso e termina depois de `ms` (para no cancelamento).',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' }, steps: { type: 'number' } }
    }
  },
  fail: {
    name: 'fail',
    description: 'Sempre falha (isError).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true }
  },
  ask: {
    name: 'ask',
    description: 'Pede o nome do usuário (elicitação) e responde com ele.',
    inputSchema: { type: 'object', properties: {} }
  },
  structured: {
    name: 'structured',
    description: 'Resultado estruturado.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { total: { type: 'number' }, items: { type: 'array', items: { type: 'string' } } }
    }
  },
  big: {
    name: 'big',
    description: 'Texto longo (`chars` caracteres).',
    inputSchema: { type: 'object', properties: { chars: { type: 'number' } } }
  },
  env: {
    name: 'env',
    description: 'Valor de uma variável de ambiente do processo do servidor.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name']
    }
  },
  cwd: {
    name: 'cwd',
    description: 'Diretório atual do processo do servidor.',
    inputSchema: { type: 'object', properties: {} }
  }
}
/**
 * Um servidor falso (estado próprio). `opts`: era ('legacy' | 'legacy-silent' | 'modern'), name,
 * instructions, tools ('echo,image,…'), log (arquivo). `handle(msg, send)` processa uma mensagem
 * JSON-RPC; `send(msg)` entrega as respostas/notificações/pedidos do servidor.
 */
export function createFakeMcp(opts = {}) {
  const ERA = opts.era || 'legacy'
  const MODERN = ERA === 'modern'
  const NAME = opts.name || 'fake'
  const LOG = opts.log
  const INSTRUCTIONS = opts.instructions
  const TOOLS = (opts.tools || Object.keys(ALL_TOOLS).join(','))
    .split(',')
    .map((t) => ALL_TOOLS[t.trim()])
    .filter(Boolean)

  let initialized = MODERN
  const cancelled = new Set()
  const pendingServer = new Map() // id → resolve (pedidos do servidor ao cliente, era 2025)
  let serverReqId = 0

  const log = (msg) => {
    if (LOG) appendFileSync(LOG, JSON.stringify(msg) + '\n')
  }
  const complete = (r) => (MODERN ? { resultType: 'complete', ...r } : r)
  const text = (t) => ({ content: [{ type: 'text', text: t }] })

  function askClient(send, method, params) {
    const id = `srv-${++serverReqId}`
    send({ id, method, params })
    return new Promise((resolve) => pendingServer.set(id, resolve))
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function callTool(id, params, send) {
    const args = params.arguments || {}
    const token = params._meta?.progressToken
    switch (params.name) {
      case 'echo':
        return complete(text(`eco: ${args.text ?? ''}`))
      case 'image':
        return complete({
          content: [
            { type: 'text', text: 'um pixel:' },
            { type: 'image', data: PNG_1PX, mimeType: 'image/png' }
          ]
        })
      case 'slow': {
        const steps = args.steps ?? 3
        const ms = args.ms ?? 300
        for (let i = 1; i <= steps; i++) {
          await sleep(ms / steps)
          if (cancelled.has(id)) return null // cancelado: não responde (spec)
          if (token !== undefined)
            send({
              method: 'notifications/progress',
              params: { progressToken: token, progress: i, total: steps, message: `passo ${i}` }
            })
        }
        return complete(text(`terminou em ${ms} ms`))
      }
      case 'fail':
        return complete({ ...text('deu ruim de propósito'), isError: true })
      case 'structured':
        return complete({
          content: [{ type: 'text', text: '{"total":2,"items":["a","b"]}' }],
          structuredContent: { total: 2, items: ['a', 'b'] }
        })
      case 'big':
        return complete(text('x'.repeat(args.chars ?? 100_000)))
      case 'env':
        return complete(text(String(process.env[args.name] ?? '(vazia)')))
      case 'cwd':
        return complete(text(process.cwd()))
      case 'ask': {
        const req = {
          mode: 'form',
          message: 'Qual o seu nome?',
          requestedSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', title: 'Nome' },
              ok: { type: 'boolean', title: 'Pode usar?' }
            },
            required: ['name']
          }
        }
        let answer
        if (MODERN) {
          const got = params.inputResponses?.q1
          if (!got)
            return {
              resultType: 'input_required',
              inputRequests: { q1: { method: 'elicitation/create', params: req } },
              requestState: 'estado-1'
            }
          if (params.requestState !== 'estado-1') return complete(text('requestState errado'))
          answer = got
        } else {
          answer = await askClient(send, 'elicitation/create', req)
        }
        if (answer.action !== 'accept') return complete(text(`usuário respondeu: ${answer.action}`))
        return complete(text(`nome: ${answer.content?.name} · ok: ${answer.content?.ok}`))
      }
      default:
        throw Object.assign(new Error(`tool desconhecida: ${params.name}`), { code: -32602 })
    }
  }

  async function handle(msg, send) {
    log(msg)
    // resposta a um pedido nosso (elicitação na era 2025)
    if (msg.id !== undefined && !msg.method) {
      pendingServer.get(msg.id)?.(msg.result ?? { action: 'cancel' })
      pendingServer.delete(msg.id)
      return
    }
    if (msg.method === 'notifications/cancelled') {
      cancelled.add(msg.params?.requestId)
      return
    }
    if (msg.id === undefined) return // outras notificações
    const { id, method, params = {} } = msg
    const reply = (result) => result && send({ id, result })
    const error = (code, message) => send({ id, error: { code, message } })
    try {
      if (method === 'initialize') {
        if (MODERN) return error(-32601, 'Method not found')
        initialized = true
        const v = ['2025-06-18', '2025-11-25', '2025-03-26'].includes(params.protocolVersion)
          ? params.protocolVersion
          : '2025-06-18'
        return reply({
          protocolVersion: v,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: NAME, version: '1.0.0' },
          ...(INSTRUCTIONS ? { instructions: INSTRUCTIONS } : {})
        })
      }
      if (method === 'server/discover') {
        if (!MODERN) {
          if (ERA === 'legacy-silent') return // nunca responde
          return error(-32601, 'Method not found')
        }
        return reply({
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: { listChanged: true } },
          ...(INSTRUCTIONS ? { instructions: INSTRUCTIONS } : {}),
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: NAME, version: '1.0.0' } }
        })
      }
      if (!initialized) {
        if (ERA === 'legacy-silent') return
        return error(-32600, 'not initialized')
      }
      if (method === 'ping') return reply({})
      if (method === 'tools/list')
        return reply(
          complete({ tools: TOOLS, ...(MODERN ? { ttlMs: 0, cacheScope: 'private' } : {}) })
        )
      if (method === 'tools/call') return reply(await callTool(id, params, send))
      if (ERA === 'legacy-silent') return
      return error(-32601, `Method not found: ${method}`)
    } catch (e) {
      return error(e.code ?? -32603, e.message)
    }
  }
  return { handle, era: ERA }
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const fake = createFakeMcp({
    era: process.env.FAKE_MCP_ERA,
    name: process.env.FAKE_MCP_NAME,
    instructions: process.env.FAKE_MCP_INSTRUCTIONS,
    tools: process.env.FAKE_MCP_TOOLS,
    log: process.env.FAKE_MCP_LOG
  })
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      void fake.handle(msg, send)
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

/**
 * O mesmo servidor em Streamable HTTP (respostas `application/json`, sem SSE) em 127.0.0.1:<porta
 * livre>. `opts.auth` liga o OAuth falso (metadados RFC 9728/8414, /authorize que aprova na hora com
 * redirect, /token com PKCE S256 e refresh, /register de registro dinâmico) e exige Bearer no
 * /mcp; `opts.cimd` anuncia Client ID Metadata Documents. `opts.legacySse` = servidor antigo
 * (HTTP+SSE de 2024): o POST no /mcp responde 405. Devolve `{ url, base, close, seen }` — `seen`
 * guarda o que chegou (registros, autorizações, tokens, cabeçalhos).
 */
export async function startFakeMcpHttp(opts = {}) {
  const fake = createFakeMcp(opts)
  const seen = { registrations: [], authorize: [], tokens: [], mcpAuth: [], requests: [] }
  const codes = new Map()
  let tokenN = 0
  const valid = new Set()
  let base = ''
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const readBody = async (req) => {
    let d = ''
    for await (const c of req) d += c
    return d
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base)
    try {
      if (
        url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp'
      )
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] })
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          ...(opts.cimd ? { client_id_metadata_document_supported: true } : {})
        })
      if (url.pathname === '/register' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        seen.registrations.push(body)
        return json(res, 201, { ...body, client_id: `dyn-${seen.registrations.length}` })
      }
      if (url.pathname === '/authorize') {
        const p = Object.fromEntries(url.searchParams)
        seen.authorize.push(p)
        const code = `code-${seen.authorize.length}`
        codes.set(code, p)
        const to = new URL(p.redirect_uri)
        to.searchParams.set('code', code)
        if (p.state) to.searchParams.set('state', p.state)
        to.searchParams.set('iss', base)
        res.writeHead(302, { location: to.href })
        return res.end()
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const p = Object.fromEntries(new URLSearchParams(await readBody(req)))
        seen.tokens.push(p)
        if (p.grant_type === 'authorization_code') {
          const a = codes.get(p.code)
          const challenge = createHash('sha256')
            .update(p.code_verifier || '')
            .digest('base64url')
          if (!a || a.code_challenge !== challenge || a.client_id !== p.client_id)
            return json(res, 400, { error: 'invalid_grant' })
          codes.delete(p.code)
        } else if (p.grant_type !== 'refresh_token' || !String(p.refresh_token).startsWith('r-'))
          return json(res, 400, { error: 'invalid_grant' })
        const access = `tok-${++tokenN}-${randomBytes(4).toString('hex')}`
        valid.add(access)
        return json(res, 200, {
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: `r-${tokenN}`
        })
      }
      if (url.pathname === '/mcp') {
        if (opts.legacySse && req.method === 'POST') return json(res, 405, { error: 'use SSE' })
        if (opts.auth) {
          const h = req.headers.authorization || ''
          seen.mcpAuth.push(h)
          const tok = h.startsWith('Bearer ') ? h.slice(7) : ''
          if (!valid.has(tok)) {
            res.writeHead(401, {
              'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`
            })
            return res.end()
          }
        }
        if (req.method === 'GET') {
          res.writeHead(405)
          return res.end()
        }
        if (req.method === 'DELETE') {
          res.writeHead(200)
          return res.end()
        }
        const msg = JSON.parse(await readBody(req))
        seen.requests.push({ msg, headers: req.headers })
        if (msg.id === undefined || !msg.method) {
          res.writeHead(202)
          return res.end()
        }
        const out = []
        await fake.handle(msg, (m) => out.push({ jsonrpc: '2.0', ...m }))
        const reply = out.find((m) => m.id === msg.id)
        if (!reply) {
          res.writeHead(202)
          return res.end()
        }
        const headers = msg.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {}
        return json(res, 200, reply, headers)
      }
      res.writeHead(404)
      res.end()
    } catch (e) {
      json(res, 500, { error: String(e) })
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  return {
    url: `${base}/mcp`,
    base,
    seen,
    close: () => new Promise((r) => server.close(() => r()))
  }
}
