// Servidor MCP FALSO por stdio (testes do cliente MCP — e2e/mcp*.test.ts). Sem dependências, sem
// rede. Fala os dois "eras" do protocolo, escolhidos pelo env:
//   FAKE_MCP_ERA=legacy         2025: handshake `initialize`; método desconhecido antes dele → -32601
//   FAKE_MCP_ERA=legacy-silent  2025, mas IGNORA métodos desconhecidos (alguns servidores antigos)
//   FAKE_MCP_ERA=modern         2026-07-28: sem handshake, `server/discover`, resultType, MRTR
// Outros envs: FAKE_MCP_LOG=<arquivo> (uma linha JSON por mensagem recebida), FAKE_MCP_NAME,
// FAKE_MCP_INSTRUCTIONS, FAKE_MCP_TOOLS=echo,image,... (subconjunto/ordem das tools).
// Tools: echo, image, slow (progresso; respeita cancelamento), fail (isError), ask (pede dados ao
// usuário — elicitação: pedido do servidor no 2025, `input_required` no 2026), structured, big, env.
import { appendFileSync } from 'node:fs'

const ERA = process.env.FAKE_MCP_ERA || 'legacy'
const MODERN = ERA === 'modern'
const NAME = process.env.FAKE_MCP_NAME || 'fake'
const LOG = process.env.FAKE_MCP_LOG
const INSTRUCTIONS = process.env.FAKE_MCP_INSTRUCTIONS
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
const TOOLS = (process.env.FAKE_MCP_TOOLS || Object.keys(ALL_TOOLS).join(','))
  .split(',')
  .map((t) => ALL_TOOLS[t.trim()])
  .filter(Boolean)

let initialized = MODERN
const cancelled = new Set()
const pendingServer = new Map() // id → resolve (pedidos do servidor ao cliente, era 2025)
let serverReqId = 0

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const log = (msg) => {
  if (LOG) appendFileSync(LOG, JSON.stringify(msg) + '\n')
}
const complete = (r) => (MODERN ? { resultType: 'complete', ...r } : r)
const text = (t) => ({ content: [{ type: 'text', text: t }] })

function askClient(method, params) {
  const id = `srv-${++serverReqId}`
  send({ id, method, params })
  return new Promise((resolve) => pendingServer.set(id, resolve))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function callTool(id, params) {
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
        answer = await askClient('elicitation/create', req)
      }
      if (answer.action !== 'accept') return complete(text(`usuário respondeu: ${answer.action}`))
      return complete(text(`nome: ${answer.content?.name} · ok: ${answer.content?.ok}`))
    }
    default:
      throw Object.assign(new Error(`tool desconhecida: ${params.name}`), { code: -32602 })
  }
}

async function handle(msg) {
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
      return reply(complete({ tools: TOOLS, ...(MODERN ? { ttlMs: 0, cacheScope: 'private' } : {}) }))
    if (method === 'tools/call') return reply(await callTool(id, params))
    if (ERA === 'legacy-silent') return
    return error(-32601, `Method not found: ${method}`)
  } catch (e) {
    return error(e.code ?? -32603, e.message)
  }
}

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
    void handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
