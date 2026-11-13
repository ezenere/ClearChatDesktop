/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do backend (main process) via Playwright `_electron`, chamando window.api a partir do renderer.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   OPENROUTER_API_KEY=sk-or-... CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/backend.spec.ts [filtro]
//
// - A key vem SOMENTE do ambiente (nunca grave em arquivo).
// - Usa um userData isolado (CLEARCHAT_USER_DATA) e um cwd de rascunho dentro de CLEARCHAT_E2E_DIR.
// - E2E_MODEL / E2E_CACHE_MODEL / E2E_VISION_MODEL / E2E_AUDIO_MODEL / E2E_TEXT_MODEL sobrescrevem os
//   modelos escolhidos.
// - [filtro] (opcional): roda só os testes cujo nome contém algum dos textos (separados por vírgula).
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  createWriteStream
} from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { activePath } from '../src/shared/branches.ts'

const KEY = process.env.OPENROUTER_API_KEY
if (!KEY) {
  console.error('Defina OPENROUTER_API_KEY no ambiente.')
  process.exit(2)
}
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const FILTER = process.argv[2] ?? ''

const ch0 = (c: any): any => c.config
const DENIED_TEXT = 'O usuário negou a execução desta ferramenta.'
const CANCELLED_TEXT = '[Interrompido pelo usuário antes de concluir]'

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let totalCost = 0
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []
const report: Record<string, unknown> = {}

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY // o app não lê a key do ambiente; ela é passada via providers.create
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
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

async function events(): Promise<any[]> {
  return page.evaluate(() => (window as any).__ev)
}
async function clearEvents(): Promise<void> {
  await page.evaluate(() => ((window as any).__ev = []))
}

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
    await sleep(150)
  }
}

async function session(sessionId: string, chatId: string): Promise<any> {
  const list = await api<any[]>('sessions.list', chatId)
  return list.find((s) => s.id === sessionId)
}

async function waitIdle(chatId: string, sessionId: string, ms = 120_000): Promise<any> {
  return waitFor(
    async () => {
      const running = await api<string[]>('agent.runningSessions')
      if (running.includes(sessionId)) return null
      const s = await session(sessionId, chatId)
      return s && s.status !== 'running' && s.status !== 'awaiting_approval' ? s : null
    },
    ms,
    `sessão ${sessionId} ociosa`
  )
}

async function waitApproval(sessionId: string, ms = 90_000): Promise<any> {
  return waitFor(
    async () => (await api<any[]>('agent.pendingApprovals')).find((a) => a.sessionId === sessionId),
    ms,
    'approval-requested'
  )
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

/** Valida pareamento assistant.tool_calls ↔ tool. */
function assertPairing(msgs: any[]): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i].message
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = new Set(m.tool_calls.map((t: any) => t.id))
      let j = i + 1
      while (j < msgs.length && msgs[j].message.role === 'tool') {
        assert(
          ids.delete(msgs[j].message.tool_call_id),
          `tool msg inesperada ${msgs[j].message.tool_call_id}`
        )
        j++
      }
      assert(ids.size === 0, `tool_calls sem resposta: ${[...ids].join(',')}`)
    }
    if (m.role === 'tool') {
      const prev = msgs
        .slice(0, i)
        .reverse()
        .find((x: any) => x.message.role !== 'tool')
      assert(prev?.message.role === 'assistant', 'tool msg sem assistant anterior')
    }
  }
}

function addCost(msgs: any[]): void {
  for (const m of msgs) if (m.meta?.usage?.cost) totalCost += m.meta.usage.cost
}

/** Caminho ativo da sessão (o que o agente vê); `sessions.messages` traz TODAS as versões. */
async function messages(sessionId: string): Promise<any[]> {
  const all = await allMessages(sessionId)
  const sel = await page.evaluate(async (sid) => {
    const w = (window as any).api
    for (const c of await w.chats.list()) {
      const s = (await w.sessions.list(c.id)).find((x: any) => x.id === sid)
      if (s) return s.branchSel ?? {}
    }
    return {}
  }, sessionId)
  return activePath(all, sel)
}

async function allMessages(sessionId: string): Promise<any[]> {
  return api<any[]>('sessions.messages', sessionId)
}

const toolMsgs = (msgs: any[], name?: string): any[] => {
  const ids = new Map<string, string>()
  for (const m of msgs)
    if (m.message.role === 'assistant')
      for (const t of m.message.tool_calls ?? []) ids.set(t.id, t.function.name)
  return msgs.filter(
    (m) => m.message.role === 'tool' && (!name || ids.get(m.message.tool_call_id) === name)
  )
}

async function test(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (FILTER && name !== 'setup' && !FILTER.split(',').some((f) => name.includes(f))) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message}`)
  }
}

/** PDF mínimo (uma página, Helvetica) com o texto dado. */
function makePdf(text: string): number[] {
  const esc = text.replace(/[\\()]/g, (c) => '\\' + c)
  const stream = `BT /F1 24 Tf 72 700 Td (${esc}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offs) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Array.from(Buffer.from(out, 'latin1'))
}

/** WAV PCM 16-bit mono 16 kHz: bipes de 0,5 s separados por 0,5 s de silêncio (3 s → 3 bipes). */
function makeWav(freq: number, seconds: number): number[] {
  const rate = 16000
  const n = Math.floor(rate * seconds)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++)
    b.writeInt16LE(
      Math.floor(i / (rate / 2)) % 2 === 0
        ? Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000)
        : 0,
      44 + i * 2
    )
  return Array.from(b)
}

// ---------------- testes ----------------

let providerId = ''
let model = process.env.E2E_MODEL || ''
let chatId = ''
let sid = ''

async function newChat(config: Record<string, unknown> = {}): Promise<{ chat: any; sid: string }> {
  const chat = await api('chats.create', { config: { providerId, model, cwd: CWD, ...config } })
  return { chat, sid: chat.mainSessionId }
}

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  writeFileSync(join(CWD, 'input.txt'), 'hello from clearchat\nsecond line\n')
  await launch()

  await test('setup', async () => {
    const bad = await api('providers.test', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-invalid'
    })
    assert(bad.ok === false && bad.error, 'test com key inválida deve falhar')
    const t = await api('providers.test', { baseUrl: 'https://openrouter.ai/api/v1/', apiKey: KEY })
    assert(t.ok && t.modelCount > 10, `providers.test: ${JSON.stringify(t)}`)
    const p = await api('providers.create', {
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: KEY,
      headers: {}
    })
    providerId = p.id
    assert(p.baseUrl === 'https://openrouter.ai/api/v1', 'baseUrl normalizada')
    await api('settings.set', 'defaultProviderId', providerId)
    assert((await api('settings.get', 'defaultProviderId')) === providerId, 'settings get/set')
    const t0 = Date.now()
    const models = await api<any[]>('providers.listModels', providerId)
    const first = Date.now() - t0
    const t1 = Date.now()
    await api('providers.listModels', providerId)
    const cached = Date.now() - t1
    assert(models.length > 10, 'listModels')
    const withPrice = models.filter((m) => typeof m.promptPrice === 'number' && m.contextLength)
    assert(withPrice.length > 10, 'preço/contexto mapeados')
    if (!model) {
      const prefs = [
        'openai/gpt-4.1-nano',
        'openai/gpt-4o-mini',
        'google/gemini-2.5-flash-lite',
        'openai/gpt-5-nano'
      ]
      model = prefs.find((id) => models.some((m) => m.id === id && m.supportsTools)) ?? ''
      assert(model, 'nenhum modelo barato com tools encontrado')
    }
    const mi = models.find((m) => m.id === model)
    report.model = mi
    const ch = await newChat()
    chatId = ch.chat.id
    sid = ch.sid
    const sessions = await api<any[]>('sessions.list', chatId)
    assert(
      sessions.length === 1 && sessions[0].depth === 0 && sessions[0].model === model,
      'sessão principal'
    )
    assert(
      ch.chat.config.cacheEnabled === true &&
        ch.chat.config.enabledTools.length === 24 && // 19 + 4 de processo + ask_user
        ch.chat.config.enabledTools.includes('list_models') &&
        ch.chat.config.confineToRoot === true &&
        ch.chat.config.maxToolOutputChars === 30000,
      'defaults'
    )
    return `model=${model} (prompt $${(mi.promptPrice * 1e6).toFixed(3)}/M, tools=${mi.supportsTools}); listModels ${first}ms → cache ${cached}ms`
  })

  await test('previewRequest', async () => {
    const pr = await api('agent.previewRequest', sid)
    assert(pr.url === 'https://openrouter.ai/api/v1/chat/completions', 'url')
    assert(
      /^Bearer sk-or-…[0-9a-f]{4}$/.test(pr.headers.Authorization),
      `key mascarada: ${pr.headers.Authorization}`
    )
    assert(!JSON.stringify(pr).includes(KEY), 'key vazou no preview')
    assert(
      pr.headers['X-Title'] === 'ClearChat' && pr.headers['HTTP-Referer'],
      'headers OpenRouter'
    )
    const b = pr.body
    assert(
      b.model === model && b.stream === true && b.stream_options.include_usage === true,
      'body base'
    )
    assert(b.usage?.include === true, 'usage include')
    assert(
      b.messages[0].role === 'system' && Array.isArray(b.messages[0].content),
      'system em parts'
    )
    assert(b.messages[0].content[0].cache_control?.type === 'ephemeral', 'cache_control no system')
    const sysText = b.messages[0].content[0].text as string
    assert(sysText.includes(`<environment>\nroot: ${CWD}`), 'env block')
    assert(/caminhos dentro do diretório raiz/.test(sysText), 'confinação no env block')
    assert(b.tools.length === 24, `tools (${b.tools.length})`) // 19 + 4 de processo + ask_user
    assert(
      b.tools.some((t: any) => t.function.name === 'list_models'),
      'list_models nas tools'
    )
    assert(
      b.tools.some((t: any) => t.function.name === 'search_files') &&
        b.tools.some((t: any) => t.function.name === 'find_files'),
      'search_files/find_files'
    )
    // extraBody inválido → erro legível
    await api('chats.update', chatId, {
      config: { params: { temperature: 0.3, extraBody: '{nope' } }
    })
    let err = ''
    try {
      await api('agent.previewRequest', sid)
    } catch (e) {
      err = (e as Error).message
    }
    assert(/extraBody não é um JSON válido/.test(err), `erro extraBody: ${err}`)
    const c = await api('chats.update', chatId, {
      config: { params: { extraBody: undefined, temperature: 0 } }
    })
    assert(
      c.config.params.temperature === 0 && !('extraBody' in c.config.params),
      `merge params ${JSON.stringify(c.config.params)}`
    )
    const pr2 = await api('agent.previewRequest', sid)
    assert(pr2.body.temperature === 0, 'temperature enviada')
    // assinatura de app
    assert(ch0(await api('chats.get', chatId)).appSignature === 'clearchat', 'assinatura padrão')
    await api('chats.update', chatId, { config: { appSignature: 'none' } })
    let h = (await api('agent.previewRequest', sid)).headers
    assert(!('HTTP-Referer' in h) && !('X-Title' in h), `none: ${JSON.stringify(h)}`)
    await api('chats.update', chatId, { config: { appSignature: 'cline' } })
    h = (await api('agent.previewRequest', sid)).headers
    assert(
      h['HTTP-Referer'] === 'https://cline.bot' && h['X-Title'] === 'Cline',
      `cline: ${JSON.stringify(h)}`
    )
    await api('chats.update', chatId, {
      config: {
        appSignature: 'custom',
        appSignatureCustom: { referer: 'https://e2e.test', title: 'E2E' }
      }
    })
    h = (await api('agent.previewRequest', sid)).headers
    assert(
      h['HTTP-Referer'] === 'https://e2e.test' && h['X-Title'] === 'E2E',
      `custom: ${JSON.stringify(h)}`
    )
    await api('chats.update', chatId, { config: { appSignature: 'clearchat' } })
    report.previewSample = {
      ...pr2,
      body: {
        ...pr2.body,
        tools: `[${pr2.body.tools.length} tools]`,
        messages: pr2.body.messages.map((m: any) => ({
          ...m,
          content: Array.isArray(m.content)
            ? m.content.map((p: any) => ({ ...p, text: p.text.slice(0, 40) + '…' }))
            : m.content
        }))
      }
    }
  })

  await test('read_file + write_file', async () => {
    const r = await api(
      'agent.send',
      sid,
      'Use the read_file tool to read input.txt, then use the write_file tool to create output.txt containing exactly the first line of input.txt converted to UPPERCASE. Finally reply with just "DONE".'
    )
    assert(r.queued === false, 'não enfileirado')
    const s = await waitIdle(chatId, sid)
    assert(s.status === 'idle', `status ${s.status}`)
    const out = readFileSync(join(CWD, 'output.txt'), 'utf8')
    assert(out.trim() === 'HELLO FROM CLEARCHAT', `output.txt = ${JSON.stringify(out)}`)
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    assert(
      toolMsgs(msgs, 'read_file').some((m) =>
        m.message.content.includes('1\thello from clearchat')
      ),
      'read_file numerado'
    )
    assert(
      toolMsgs(msgs).every((m) => m.meta.toolStatus === 'ok'),
      'toolStatus ok'
    )
    const last = msgs[msgs.length - 1]
    assert(
      last.message.role === 'assistant' &&
        !last.message.tool_calls &&
        last.meta.usage?.promptTokens > 0,
      'resposta final com usage'
    )
    const chat = await api('chats.get', chatId)
    assert(
      chat.title.startsWith('Use the read_file tool') && chat.title.length <= 51,
      `título ${chat.title}`
    )
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'draft' && e.draft) &&
        ev.some((e) => e.type === 'draft' && e.draft === null),
      'drafts'
    )
    assert(
      ev.some((e) => e.type === 'tool-running' && e.running) &&
        ev.some((e) => e.type === 'session-updated' && e.session.status === 'running'),
      'eventos'
    )
    return `${msgs.length} msgs; usage último: ${JSON.stringify(last.meta.usage)}`
  })

  await test('bash approve (allow)', async () => {
    await clearEvents()
    await api(
      'agent.send',
      sid,
      'Use the shell tool to run exactly this command: echo hello-e2e > bash.txt && cat bash.txt'
    )
    const ap = await waitApproval(sid)
    assert(
      ap.toolName === 'shell' && ap.args.command.includes('hello-e2e'),
      `approval ${JSON.stringify(ap)}`
    )
    const s1 = await session(sid, chatId)
    assert(s1.status === 'awaiting_approval', `status ${s1.status}`)
    await api('agent.approve', ap.id, 'allow')
    await waitIdle(chatId, sid)
    assert(readFileSync(join(CWD, 'bash.txt'), 'utf8').trim() === 'hello-e2e', 'bash.txt')
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const t = toolMsgs(msgs, 'shell').at(-1)
    assert(
      t.message.content.includes('hello-e2e') && t.message.content.includes('[exit code: 0]'),
      `bash out ${t.message.content}`
    )
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'approval-requested') &&
        ev.some((e) => e.type === 'approval-resolved' && e.id === ap.id),
      'eventos approval'
    )
  })

  await test('bash deny', async () => {
    await api(
      'agent.send',
      sid,
      'Use the shell tool to run: touch denied-e2e.txt. If it is denied, just say "ok, denied" and do not retry.'
    )
    const ap = await waitApproval(sid)
    await api('agent.approve', ap.id, 'deny')
    const s = await waitIdle(chatId, sid)
    assert(s.status === 'idle', `status ${s.status}`)
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const t = toolMsgs(msgs, 'shell').find((m) => m.message.tool_call_id === ap.toolCallId)
    // modo Listas (padrão): "O usuário negou: <sub-comando>"; pergunta simples: DENIED_TEXT
    assert(
      t &&
        (t.message.content === DENIED_TEXT || t.message.content.startsWith('O usuário negou: ')) &&
        t.meta.toolStatus === 'denied',
      'tool negada'
    )
  })

  await test('approve + whitelist + fila (queue)', async () => {
    await api(
      'agent.send',
      sid,
      'Use the shell tool to run: sleep 4; touch slept-ok.txt; echo slept-ok. Then report the output.'
    )
    const ap = await waitApproval(sid)
    // card do modo Listas: "Sim + whitelist" em cada sub-comando pendente (padrão sugerido)
    assert(ap.check?.items?.length >= 1, `check ${JSON.stringify(ap.check)}`)
    const items = ap.check.items
      .map((it: any, index: number) => ({ it, index }))
      .filter(({ it }: any) => it.verdict !== 'allow')
      .map(({ it, index }: any) => ({
        index,
        allow: true,
        pattern: it.reason ? undefined : it.suggestion
      }))
    await api('agent.approve', ap.id, 'allow', items)
    const st = await api<any>('approvals.getSettings')
    // 0.8.5: sleep/echo são só leitura (sempre liberados); o pendente é o touch
    assert(st.lists.commands.allow.includes('touch *'), `whitelist ${st.lists.commands.allow}`)
    await sleep(500)
    const q = await api('agent.send', sid, 'Also: what is 2+2? Answer with just the number.')
    assert(q.queued === true, 'deveria enfileirar')
    const queue = await api<any[]>('agent.getQueue', sid)
    assert(queue.length === 1, 'fila com 1')
    await waitIdle(chatId, sid)
    assert((await api<any[]>('agent.getQueue', sid)).length === 0, 'fila drenada')
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const qi = msgs.findIndex((m) => m.meta.kind === 'queued')
    assert(qi > 0, 'msg queued persistida')
    const bashTool = toolMsgs(msgs, 'shell').find((m) => m.message.tool_call_id === ap.toolCallId)
    assert(
      bashTool && bashTool.seq < msgs[qi].seq && bashTool.message.content.includes('slept-ok'),
      'queued após resultado da tool'
    )
    const after = msgs.slice(qi + 1).filter((m) => m.message.role === 'assistant')
    assert(
      after.some((m) => /4/.test(m.message.content ?? '')),
      'resposta à msg enfileirada'
    )
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'queue-updated' && e.queue.length === 1),
      'evento queue-updated'
    )
  })

  await test('forceSend durante tool (bash longo)', async () => {
    await api('chats.update', chatId, { config: { autoApprove: ['shell'] } })
    await clearEvents()
    const marker = `sleep 31.${Math.floor(Math.random() * 1000)}`
    await api(
      'agent.send',
      sid,
      `Use the shell tool to run exactly: ${marker}; echo late > late.txt`
    )
    await waitFor(
      async () => (await events()).find((e) => e.type === 'tool-running' && e.running),
      60_000,
      'bash rodando'
    )
    await sleep(800)
    assert(
      execSync(`pgrep -f "[${marker[0]}]${marker.slice(1)}" || true`)
        .toString()
        .trim(),
      'sleep deveria estar rodando'
    )
    await api('agent.send', sid, 'Never mind, stop that. Just reply "forced-ack".')
    const [item] = await api<any[]>('agent.getQueue', sid)
    assert(item, 'item na fila')
    await api('agent.forceSend', item.id)
    await waitIdle(chatId, sid)
    await sleep(500)
    assert(
      !execSync(`pgrep -f "[${marker[0]}]${marker.slice(1)}" || true`)
        .toString()
        .trim(),
      'processo bash deveria ter sido morto'
    )
    assert(!existsSync(join(CWD, 'late.txt')), 'late.txt não deveria existir')
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const fi = msgs.findIndex((m) => m.meta.kind === 'forced')
    assert(fi > 0, 'msg forced')
    const cancelled = msgs[fi - 1]
    assert(
      cancelled.message.role === 'tool' &&
        cancelled.message.content === CANCELLED_TEXT &&
        cancelled.meta.toolStatus === 'cancelled',
      'tool cancelada antes da forced'
    )
    const last = msgs.at(-1)
    assert(
      last.message.role === 'assistant' && last.seq > msgs[fi].seq,
      'próxima chamada OK após forced'
    )
    assert((await session(sid, chatId)).status === 'idle', 'idle')
  })

  await test('forceSend durante stream + stop + regenerate', async () => {
    // modelos com reasoning (ex.: glm-5.3-flash) podem pensar minutos antes do 1º token de content:
    // esforço baixo neste teste (omitido com nota em modelos sem reasoning_effort)
    const prevParams = ch0(await api('chats.get', chatId)).params ?? {}
    await api('chats.update', chatId, {
      config: { params: { ...prevParams, reasoning_effort: 'low' } }
    })
    await clearEvents()
    await api(
      'agent.send',
      sid,
      'Write a 600-word story about a lighthouse keeper. Do not use any tools.'
    )
    await waitFor(
      async () => (await events()).find((e) => e.type === 'draft' && e.draft?.content?.length > 40),
      150_000, // modelos com reasoning (ex.: glm-5.3-flash) pensam antes do 1º token de content
      'stream começar'
    )
    await api('agent.send', sid, 'Stop the story. Reply only "interrupted-ack".')
    const [item] = await api<any[]>('agent.getQueue', sid)
    await api('agent.forceSend', item.id)
    await waitIdle(chatId, sid)
    let msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const fi = msgs.findIndex((m, i) => m.meta.kind === 'forced' && i > msgs.length - 4)
    assert(fi > 0, 'forced')
    const partial = msgs[fi - 1]
    assert(
      partial.message.role === 'assistant' &&
        partial.meta.interrupted === true &&
        partial.message.content.length > 0,
      'assistant parcial interrompido'
    )
    assert(
      msgs.at(-1).message.role === 'assistant' && msgs.at(-1).seq > msgs[fi].seq,
      'resposta após forced'
    )

    // stop
    await clearEvents()
    await api('agent.send', sid, 'Write a 600-word poem about the sea. Do not use tools.')
    await waitFor(
      async () => (await events()).find((e) => e.type === 'draft' && e.draft?.content?.length > 40),
      150_000, // modelos com reasoning (ex.: glm-5.3-flash) pensam antes do 1º token de content
      'stream começar'
    )
    await api('agent.stop', sid)
    const s = await waitIdle(chatId, sid, 10_000)
    assert(s.status === 'idle', `status após stop ${s.status}`)
    msgs = await messages(sid)
    assert(msgs.at(-1).meta.interrupted === true, 'parcial persistido após stop')

    // regenerate = nova versão da resposta (a interrompida continua salva, como irmã)
    const lastUser = msgs.filter((m) => m.message.role === 'user').at(-1)
    const oldPartial = msgs.at(-1)
    await api('agent.regenerate', sid)
    await waitIdle(chatId, sid)
    msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const lu = msgs.findIndex((m) => m.id === lastUser.id)
    assert(
      lu === msgs.length - 2 &&
        msgs.at(-1).message.role === 'assistant' &&
        !msgs.at(-1).meta.interrupted,
      'regenerado'
    )
    const kept = (await allMessages(sid)).find((m) => m.id === oldPartial.id)
    assert(
      kept && kept.parentId === lastUser.id && msgs.at(-1).parentId === lastUser.id,
      'versão antiga mantida (irmã da nova)'
    )
    await api('chats.update', chatId, { config: { params: prevParams } })
  })

  await test('delegate_task (subsessão)', async () => {
    await api('chats.update', chatId, { config: { autoApprove: ['shell'] } })
    await clearEvents()
    await api(
      'agent.send',
      sid,
      'Use the delegate_task tool (title "contar arquivos"; blocking, do not set background) to ask a subagent to use list_dir on the current working directory and report the exact file names. Then tell me how many files there are.'
    )
    await waitIdle(chatId, sid, 180_000)
    const sessions = await api<any[]>('sessions.list', chatId)
    const t0msgs = await messages(sid)
    const lastDelegate = toolMsgs(t0msgs, 'delegate_task').at(-1)
    assert(lastDelegate, 'delegate_task chamada')
    const child = sessions.find(
      (s) => s.depth === 1 && s.parentToolCallId === lastDelegate.message.tool_call_id
    )
    assert(child, 'subsessão criada')
    assert(
      child.parentSessionId === sid && child.parentToolCallId && child.status === 'done',
      `subsessão ${JSON.stringify(child)}`
    )
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const t = toolMsgs(msgs, 'delegate_task').at(-1)
    assert(
      t && t.meta.subSessionId === child.id && t.message.tool_call_id === child.parentToolCallId,
      'tool meta.subSessionId'
    )
    const cm = await messages(child.id)
    addCost(cm)
    assertPairing(cm)
    // o resultado do delegate é exatamente o texto final do subagente (o conteúdo depende do modelo)
    const finalSub = cm.filter((m) => m.message.role === 'assistant').at(-1)
    // (salvo uma `[nota: …]` inicial do delegate_task, ex.: "model" inventado → o da sessão)
    assert(
      t.message.content.replace(/^\[nota: [^\n]*\]\n\n/, '').trim() ===
        String(finalSub?.message.content ?? '').trim(),
      `resultado do subagente: ${t.message.content.slice(0, 200)}`
    )
    assert(
      toolMsgs(cm, 'list_dir').some((m) => /input\.txt/.test(m.message.content)),
      'list_dir do subagente viu input.txt'
    )
    assert(
      cm[0].message.role === 'user' && cm[0].meta.synthetic && cm[0].message.content === child.task,
      'task como primeira msg'
    )
    assert(toolMsgs(cm, 'list_dir').length >= 1, 'subagente usou list_dir')
    const pr = await api('agent.previewRequest', child.id)
    assert(
      pr.body.messages[0].content[0].text.startsWith('Você é um subagente'),
      'system prompt de subagente'
    )
    assert(
      pr.body.tools.some((x: any) => x.function.name === 'delegate_task'),
      'depth 1 ainda pode delegar'
    )
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'session-created' && e.session.id === child.id),
      'evento session-created'
    )
    assert(
      ev.some((e) => e.type === 'draft' && e.sessionId === child.id),
      'drafts da subsessão'
    )
    let sendErr = ''
    try {
      // conversar com o subagente é permitido (agent.send); regenerar/compactar continuam só na principal
      await api('agent.regenerate', child.id)
    } catch (e) {
      sendErr = (e as Error).message
    }
    assert(/somente leitura/.test(sendErr), 'subsessão não regenera')
    assert(
      pr.body.messages[1].role === 'user' &&
        JSON.stringify(pr.body.messages[1].content).includes(child.task.slice(0, 40)),
      'task é a 1ª mensagem user da request do subagente'
    )
    // regenerate = nova versão: a subsessão da versão antiga continua salva (não é apagada) e o
    // delegate antigo sai do caminho ativo (mas não do banco)
    await clearEvents()
    await api('agent.regenerate', sid)
    await waitIdle(chatId, sid, 180_000)
    const after = await api<any[]>('sessions.list', chatId)
    assert(
      after.some((s) => s.id === child.id),
      'subsessão da versão antiga mantida'
    )
    assert(
      !(await events()).some((e) => e.type === 'session-deleted' && e.sessionId === child.id),
      'nada apagado'
    )
    assert((await messages(child.id)).length > 0, 'mensagens da subsessão mantidas')
    assert(
      !(await messages(sid)).some((m) => m.id === lastDelegate.id) &&
        (await allMessages(sid)).some((m) => m.id === lastDelegate.id),
      'delegate antigo fora do caminho ativo, mas salvo'
    )
    // apagar a mensagem assistant com o tool_call do delegate também apaga a subsessão
    // (depois apaga a msg tool órfã, para manter o histórico pareado para os próximos testes)
    const m3 = await messages(sid)
    addCost(m3)
    const t3 = toolMsgs(m3, 'delegate_task').at(-1)
    if (t3?.meta.subSessionId) {
      const a3 = m3.find(
        (m) =>
          m.message.role === 'assistant' &&
          m.message.tool_calls?.some((tc: any) => tc.id === t3.message.tool_call_id)
      )
      const others = m3.filter(
        (m) =>
          m.message.role === 'tool' &&
          a3.message.tool_calls.some((tc: any) => tc.id === m.message.tool_call_id)
      )
      await api('messages.delete', a3.id)
      const after2 = await api<any[]>('sessions.list', chatId)
      assert(!after2.some((s) => s.id === t3.meta.subSessionId), 'subsessão apagada com a msg')
      for (const o of others) await api('messages.delete', o.id)
      assertPairing(await messages(sid))
    }
    return `child=${child.id.slice(0, 8)} model=${child.model}; resultado: ${t.message.content.slice(0, 80).replace(/\n/g, ' ')}…`
  })

  await test('web_search + browse_url', async () => {
    await api('chats.update', chatId, {
      config: { autoApprove: ['shell', 'web_search', 'browse_url'] }
    })
    await api(
      'agent.send',
      sid,
      'First use web_search with query "electron-vite build tooling". Then use browse_url on https://example.com and tell me the page title. Keep the answer short.'
    )
    await waitIdle(chatId, sid, 120_000)
    const msgs = await messages(sid)
    addCost(msgs)
    assertPairing(msgs)
    const ws = toolMsgs(msgs, 'web_search').at(-1)
    const bu = toolMsgs(msgs, 'browse_url').at(-1)
    assert(ws, 'web_search chamada')
    assert(
      bu && bu.meta.toolStatus === 'ok' && /Example Domain/.test(bu.message.content),
      `browse_url: ${bu?.message.content.slice(0, 200)}`
    )
    return `web_search status=${ws.meta.toolStatus}: ${ws.message.content.split('\n').slice(0, 3).join(' | ').slice(0, 160)}`
  })

  await test('modo texto (nativeTools=false)', async () => {
    // E2E_TEXT_MODEL: GLM (z-ai/*) usa <tool_call> como token especial do template — vários
    // provedores upstream o engolem e o content volta vazio; use outro modelo aqui.
    const { chat, sid: s2 } = await newChat({
      model: process.env.E2E_TEXT_MODEL || model,
      nativeTools: false,
      toolsInPrompt: true,
      enabledTools: ['read_file']
    })
    const pr = await api('agent.previewRequest', s2)
    assert(
      !pr.body.tools && /<tool_call>/.test(pr.body.messages[0].content[0].text),
      'sem campo tools; texto no system'
    )
    const findTr = (ms: any[]): any =>
      ms.find(
        (m) =>
          m.message.role === 'user' &&
          m.meta.synthetic &&
          /<tool_result name="read_file">/.test(m.message.content)
      )
    let msgs: any[] = []
    // modelos baratos às vezes respondem vazio (só reasoning) no 1º turno: até 3 tentativas
    for (let i = 0; i < 3; i++) {
      await api(
        'agent.send',
        s2,
        'Call the read_file tool on input.txt, writing the call in the exact <tool_call>{"name": ..., "arguments": {...}}</tool_call> format described in your instructions. After you get the result, tell me the second line of the file.'
      )
      await waitIdle(chat.id, s2)
      msgs = await messages(s2)
      if (findTr(msgs)) break
    }
    addCost(msgs)
    const tr = findTr(msgs)
    assert(tr, 'tool_result sintético')
    assert(
      /second line/i.test(msgs.at(-1).message.content ?? ''),
      `resposta final: ${msgs.at(-1).message.content}`
    )
  })

  await test('erro HTTP legível (key inválida)', async () => {
    const p = await api('providers.create', {
      name: 'Bad',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-v1-bad',
      headers: {}
    })
    const { chat, sid: s3 } = await newChat({ providerId: p.id })
    await clearEvents()
    await api('agent.send', s3, 'hi')
    const s = await waitIdle(chat.id, s3, 30_000)
    assert(s.status === 'error', `status ${s.status}`)
    const ev = (await events()).find((e) => e.type === 'error' && e.sessionId === s3)
    assert(ev && /Erro HTTP 401/.test(ev.error), `evento error: ${ev?.error}`)
    // erro persistido só para exibição e excluído da request
    const em = await messages(s3)
    const errM = em.find((m) => m.meta.kind === 'error')
    assert(errM && errM.meta.synthetic && errM.meta.error === ev.error, 'erro persistido')
    const prev = await api('agent.previewRequest', s3)
    assert(
      !JSON.stringify(prev.body.messages).includes('Erro HTTP'),
      'mensagem de erro não vai para a API'
    )
    await api('chats.delete', chat.id)
    assert(!(await api('chats.get', chat.id)), 'chat apagado')
    return ev.error
  })

  await test('token caching (Anthropic haiku via OpenRouter)', async () => {
    const models = await api<any[]>('providers.listModels', providerId)
    const cacheModel =
      process.env.E2E_CACHE_MODEL ||
      [
        'anthropic/claude-haiku-5.5',
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-3.5-haiku',
        'anthropic/claude-3-haiku'
      ].find((id) => models.some((m) => m.id === id))
    assert(cacheModel, 'nenhum haiku disponível')
    // system prompt longo (>4096 tokens) para passar do mínimo cacheável
    const filler = Array.from(
      { length: 260 },
      (_, i) =>
        `Regra ${i + 1}: mantenha respostas curtas, objetivas e corretas; cite fontes quando necessário; nunca invente dados sobre o item ${i + 1}.`
    ).join('\n')
    const { chat, sid: s4 } = await newChat({
      model: cacheModel,
      systemPrompt: `Você é um assistente.\n${filler}`,
      enabledTools: []
    })
    const turns: any[] = []
    for (const q of ['Responda apenas: oi', 'Responda apenas: tchau', 'Responda apenas: ok']) {
      await api('agent.send', s4, q)
      const s = await waitIdle(chat.id, s4)
      assert(s.status === 'idle', `status ${s.status}`)
      const msgs = await messages(s4)
      turns.push(msgs.at(-1).meta.usage)
    }
    addCost(await messages(s4))
    // compactação no mesmo chat: a request de resumo reaproveita o prefixo em cache
    await api('agent.compact', s4)
    await waitIdle(chat.id, s4)
    const cm = (await messages(s4)).at(-1)
    assert(cm.meta.kind === 'compaction', `fronteira: ${JSON.stringify(cm.meta)}`)
    if (cm.meta.compactUsage?.cost) totalCost += cm.meta.compactUsage.cost
    report.caching = { model: cacheModel, turns, compactUsage: cm.meta.compactUsage }
    assert(
      (cm.meta.compactUsage?.cachedTokens ?? 0) > 0,
      `compactação sem cache: ${JSON.stringify(cm.meta.compactUsage)}`
    )
    assert(
      (turns[1].cachedTokens ?? 0) > 0 || (turns[2].cachedTokens ?? 0) > 0,
      `sem cachedTokens: ${JSON.stringify(turns)}`
    )
    return turns
      .map(
        (u, i) =>
          `t${i + 1}: in=${u.promptTokens} cached=${u.cachedTokens ?? '-'} write=${u.cacheWriteTokens ?? '-'} cost=$${u.cost?.toFixed(6)}`
      )
      .join(' | ')
      .concat(` | compact: cached=${cm.meta.compactUsage?.cachedTokens}`)
  })

  await test('token caching em loop de tools (haiku)', async () => {
    const models = await api<any[]>('providers.listModels', providerId)
    const cacheModel =
      process.env.E2E_CACHE_MODEL ||
      ['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-4.5'].find((id) =>
        models.some((m) => m.id === id)
      )
    assert(cacheModel, 'nenhum haiku disponível')
    const filler = Array.from(
      { length: 260 },
      (_, i) =>
        `Regra ${i + 1}: mantenha respostas curtas, objetivas e corretas; cite fontes quando necessário; nunca invente dados sobre o item ${i + 1}.`
    ).join('\n')
    const loopDir = join(CWD, 'loop')
    mkdirSync(loopDir, { recursive: true })
    for (const n of ['a', 'b', 'c', 'd'])
      writeFileSync(
        join(loopDir, `${n}.txt`),
        Array.from({ length: 40 }, (_, i) => `${n}${i}: conteúdo de teste do arquivo ${n}`).join(
          '\n'
        )
      )
    const { chat, sid: s5 } = await newChat({
      model: cacheModel,
      systemPrompt: `Você é um assistente.\n${filler}`,
      enabledTools: ['read_file'],
      cwd: loopDir
    })
    await api(
      'agent.send',
      s5,
      'Leia os arquivos a.txt, b.txt, c.txt e d.txt com read_file, UM POR RESPOSTA (nunca chame duas tools na mesma resposta), na ordem, sem parar nem pedir confirmação entre eles (não escreva texto entre as chamadas). Só depois de ler os 4, responda apenas "fim".'
    )
    const s = await waitIdle(chat.id, s5, 180_000)
    assert(s.status === 'idle', `status ${s.status}`)
    const msgs = await messages(s5)
    addCost(msgs)
    const steps = msgs
      .filter((m) => m.message.role === 'assistant' && m.meta.usage)
      .map((m) => m.meta.usage)
    report.cachingLoop = { model: cacheModel, steps }
    const line = steps
      .map(
        (u, i) =>
          `s${i + 1}: in=${u.promptTokens} cached=${u.cachedTokens ?? 0} write=${u.cacheWriteTokens ?? 0}`
      )
      .join(' | ')
    assert(steps.length >= 3, `poucos passos: ${line}`)
    for (let i = 2; i < steps.length; i++)
      assert(
        (steps[i].cachedTokens ?? 0) > (steps[i - 1].cachedTokens ?? 0),
        `cachedTokens não cresceu no passo ${i + 1}: ${line}`
      )
    return line
  })

  await test('reinício: sessão rodando → interrupted (pareamento reparado)', async () => {
    const { chat: rc, sid: rs } = await newChat({ enabledTools: ['shell'], autoApprove: ['shell'] })
    const chatId = rc.id
    const sid = rs
    await clearEvents()
    await api('agent.send', sid, 'Use the shell tool to run exactly: sleep 20.123; echo z')
    await waitFor(
      async () =>
        (await events()).find((e) => e.type === 'tool-running' && e.running && e.sessionId === sid),
      60_000,
      'bash rodando'
    )
    await app.close()
    await sleep(500)
    assert(
      !execSync('pgrep -f "[s]leep 20.123" || true').toString().trim(),
      'bash deveria morrer ao fechar o app'
    )
    await launch()
    const s = await session(sid, chatId)
    assert(s.status === 'interrupted', `status após reinício ${s.status}`)
    const msgs = await messages(sid)
    assertPairing(msgs)
    assert(msgs.at(-1).message.content === CANCELLED_TEXT, 'tool sintética cancelada')
    // crash (SIGKILL): na próxima inicialização a sessão vira 'interrupted' e o pareamento é reparado
    await clearEvents()
    await api('agent.send', sid, 'Use the shell tool to run exactly: sleep 5.321; echo y')
    await waitFor(
      async () =>
        (await events()).find((e) => e.type === 'tool-running' && e.running && e.sessionId === sid),
      60_000,
      'bash rodando (2)'
    )
    app.process().kill('SIGKILL')
    await sleep(1000)
    await launch()
    const s2 = await session(sid, chatId)
    assert(s2.status === 'interrupted', `status após crash ${s2.status}`)
    const msgs2 = await messages(sid)
    assertPairing(msgs2)
    assert(
      msgs2.at(-1).message.content === CANCELLED_TEXT &&
        msgs2.at(-1).meta.toolStatus === 'cancelled',
      'reparo após crash'
    )
    // e segue funcionando
    await api('agent.send', sid, 'Reply only "back".')
    await waitIdle(chatId, sid)
    const m2 = await messages(sid)
    addCost(m2)
    assertPairing(m2)
    assert(m2.at(-1).message.role === 'assistant', 'responde após reinício')
  })

  // ---------------- diretório raiz / limites / compactação ----------------

  await test('compactação ponta a ponta (resumo persistido, request a partir da fronteira, continua coerente)', async () => {
    const { chat, sid: sc } = await newChat({ enabledTools: [] })
    await api('agent.send', sc, 'Remember this secret code word: ZEBRA-7731. Reply only "ok".')
    await waitIdle(chat.id, sc)
    await api('agent.send', sc, 'Also remember: my favorite color is teal. Reply only "ok".')
    await waitIdle(chat.id, sc)
    const before = await messages(sc)
    addCost(before)
    await clearEvents()
    const r = await api('agent.compact', sc)
    assert(r.scheduled === false, 'compacta já (ociosa)')
    const s = await waitIdle(chat.id, sc)
    assert(s.status === 'idle', `status ${s.status}`)
    const after = await messages(sc)
    assert(
      after.length === before.length + 1,
      `só a fronteira é persistida (${before.length} → ${after.length})`
    )
    const b = after.at(-1)
    assert(
      b.meta.kind === 'compaction' && b.meta.synthetic && b.message.role === 'user',
      'fronteira role user'
    )
    assert(
      /^<conversation_summary>\n[\s\S]+\n<\/conversation_summary>\n\n/.test(b.message.content),
      'formato'
    )
    assert(/ZEBRA-7731/.test(b.message.content), `resumo sem o código: ${b.message.content}`)
    assert(
      b.meta.summaryOf.fromSeq === before[0].seq && b.meta.summaryOf.toSeq === before.at(-1).seq,
      `summaryOf ${JSON.stringify(b.meta.summaryOf)}`
    )
    assert(b.meta.usageBefore > 0 && b.meta.contextEstimate > 0, 'usageBefore/contextEstimate')
    if (b.meta.compactUsage?.cost) totalCost += b.meta.compactUsage.cost
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'compaction' && e.state === 'running' && e.text) &&
        ev.some((e) => e.type === 'compaction' && e.state === null),
      'eventos de compactação (stream do resumo)'
    )
    // a próxima request começa na fronteira
    const pr = await api('agent.previewRequest', sc)
    const roles = pr.body.messages.map((m: any) => m.role)
    assert(JSON.stringify(roles) === '["system","user"]', `request compactada: ${roles}`)
    const firstUser = pr.body.messages[1].content
    const txt = Array.isArray(firstUser) ? firstUser.map((p: any) => p.text).join('') : firstUser
    assert(txt === b.message.content, 'fronteira reenviada byte a byte')
    assert(!JSON.stringify(pr.body).includes('Reply only "ok"'), 'histórico antigo fora da request')
    // continua coerente
    await api(
      'agent.send',
      sc,
      'What is my secret code word and my favorite color? Answer in one short line.'
    )
    await waitIdle(chat.id, sc)
    const m2 = await messages(sc)
    addCost(m2.slice(after.length))
    const ans = m2.at(-1).message.content ?? ''
    assert(/ZEBRA-7731/.test(ans) && /teal/i.test(ans), `resposta pós-compactação: ${ans}`)
    // mensagens antigas continuam salvas
    assert(
      before.every((m) => m2.some((x) => x.id === m.id)),
      'histórico antigo preservado'
    )
    // Parar durante a compactação: cancela sem salvar fronteira
    const n0 = m2.length
    await clearEvents()
    await api('agent.compact', sc)
    await waitFor(
      async () => (await events()).find((e) => e.type === 'compaction' && e.state === 'running'),
      20_000,
      'compactação rodando'
    )
    await api('agent.stop', sc)
    await waitIdle(chat.id, sc)
    const m3 = await messages(sc)
    assert(
      m3.length === n0 && !m3.slice(n0).some((m) => m.meta.kind === 'compaction'),
      'nada salvo ao parar'
    )
    return `resumo ${b.message.content.length} chars; resposta: ${ans.slice(0, 60)}`
  })

  await test('compactação automática (janela pequena) + "tentar de novo"', async () => {
    const { chat, sid: sa } = await newChat({ enabledTools: [] })
    await api('agent.send', sa, 'My name is Ana. Reply only "ok".')
    await waitIdle(chat.id, sa)
    const u = (await messages(sa)).at(-1).meta.usage
    // janela minúscula + automático: o próximo turno compacta antes de chamar o modelo
    await api('chats.update', chat.id, {
      config: { contextWindow: Math.ceil(u.promptTokens * 1.05), autoCompact: true }
    })
    await api('agent.send', sa, 'What is my name? Answer with just the name.')
    await waitIdle(chat.id, sa)
    const msgs = await messages(sa)
    addCost(msgs)
    const bi = msgs.findIndex((m) => m.meta.kind === 'compaction')
    assert(bi > 0, 'fronteira automática criada')
    if (msgs[bi].meta.compactUsage?.cost) totalCost += msgs[bi].meta.compactUsage.cost
    assert(
      msgs.at(-1).message.role === 'assistant' && /ana/i.test(msgs.at(-1).message.content),
      `resposta ${msgs.at(-1).message.content}`
    )
    // retry: compacta de novo e roda o agente outra vez
    await api('chats.update', chat.id, { config: { autoCompact: false, contextWindow: null } })
    const n = msgs.length
    await api('agent.compact', sa, { retry: true })
    await waitIdle(chat.id, sa)
    const m2 = await messages(sa)
    addCost(m2.slice(n))
    assert(m2[n]?.meta.kind === 'compaction', 'nova fronteira')
    assert(
      m2.at(-1).message.role === 'assistant' && m2.length > n + 1,
      'agente rodou depois de compactar'
    )
    return `fronteira em ${bi}; ${m2.length} msgs`
  })

  await test('read_file: arquivo grande → aviso e leitura em partes', async () => {
    writeFileSync(
      join(CWD, 'big-e2e.txt'),
      Array.from({ length: 5000 }, (_, i) => `registro ${i + 1}`).join('\n') + '\n'
    )
    const { chat, sid: sr } = await newChat({ enabledTools: ['read_file'] })
    await api(
      'agent.send',
      sr,
      'Use the read_file tool on big-e2e.txt (without offset or limit). Then tell me how many lines the file has in total, as reported by the tool.'
    )
    await waitIdle(chat.id, sr)
    const msgs = await messages(sr)
    addCost(msgs)
    const t = toolMsgs(msgs, 'read_file')[0]
    assert(t, 'read_file chamado')
    assert(
      // sem offset/limit: "[arquivo grande: …]"; se o modelo passar limit mesmo assim: "[arquivo com 5.000 linhas … — mostrando …]"
      /^\[(arquivo grande: 5\.000 linhas, .* — mostrando linhas 1–[\d.]+|arquivo com 5\.000 linhas .* — mostrando linhas 1–[\d.]+)/.test(
        t.message.content
      ),
      `cabeçalho: ${t.message.content.slice(0, 200)}`
    )
    assert(t.message.content.length <= 30_000, `limite de saída: ${t.message.content.length}`)
    // (a resposta do modelo barato nem sempre lê o total corretamente: só registra)
    return `${t.message.content.slice(0, 120)} → modelo: ${(msgs.at(-1).message.content ?? '').slice(0, 80)}`
  })

  await test('search_files encontra trecho (caminho:linha)', async () => {
    mkdirSync(join(CWD, 'src'), { recursive: true })
    writeFileSync(join(CWD, 'src', 'alvo.ts'), 'export const a = 1\n\n// NEEDLE_E2E_91 está aqui\n')
    mkdirSync(join(CWD, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(CWD, 'node_modules', 'x', 'i.js'), 'NEEDLE_E2E_91')
    const { chat, sid: ss } = await newChat({
      enabledTools: ['search_files', 'find_files', 'read_file']
    })
    await api(
      'agent.send',
      ss,
      'Use the search_files tool to find the text NEEDLE_E2E_91 in this project. Reply with the file path and line number only.'
    )
    await waitIdle(chat.id, ss)
    const msgs = await messages(ss)
    addCost(msgs)
    const calls = toolMsgs(msgs, 'search_files')
    assert(calls.length, 'search_files chamado')
    // o modelo pode errar o glob na 1ª tentativa ("Nenhum resultado" — não é erro) e refazer
    assert(
      calls.every((m) => m.meta.toolStatus === 'ok'),
      'sem erro de tool'
    )
    const t = calls.find((m) => /alvo\.ts/.test(m.message.content)) ?? calls[0]
    assert(
      /src\/alvo\.ts:3:\/\/ NEEDLE_E2E_91/.test(t.message.content),
      `resultado: ${t.message.content}`
    )
    assert(!t.message.content.includes('node_modules'), 'node_modules ignorado')
    assert(/alvo\.ts/.test(msgs.at(-1).message.content ?? ''), 'resposta cita o arquivo')
    return t.message.content.split('\n').slice(0, 2).join(' | ')
  })

  await test('list_models filtra modelos do provedor (query + tools_only)', async () => {
    // definições completas: o teste confere os argumentos/definição de list_models (1.11.0)
    const { chat, sid: sl } = await newChat({
      enabledTools: ['list_models', 'delegate_task'],
      toolsCompact: false
    })
    await api(
      'agent.send',
      sl,
      'Use the list_models tool with query "gpt-4.1" and tools_only true. Then reply with exactly one model id from the result, nothing else.'
    )
    await waitIdle(chat.id, sl)
    const msgs = await messages(sl)
    addCost(msgs)
    assertPairing(msgs)
    const calls = toolMsgs(msgs, 'list_models')
    assert(calls.length, 'list_models chamado')
    const t = calls.at(-1)
    assert(t.meta.toolStatus === 'ok', `status: ${t.meta.toolStatus} — ${t.message.content}`)
    const c = t.message.content as string
    // um provedor: formato simples; vários (o "Bad" criado antes): seções, o da sessão primeiro
    assert(
      /^\[\d+ modelos de [\d.]+ no provedor OpenRouter; mostrando \d+\]/.test(c) ||
        (/^\[modelos de \d+ provedores — OpenRouter \(desta sessão\): \d+ de [\d.]+, mostrando \d+/.test(
          c
        ) &&
          c.split('\n')[1] === '[OpenRouter] (provedor desta sessão)'),
      `cabeçalho: ${c.slice(0, 200)}`
    )
    const lines = c
      .split('\n')
      .slice(1)
      .filter((l) => !l.startsWith('['))
    assert(lines.length >= 1, 'pelo menos um modelo')
    assert(
      lines.every((l) => /gpt-?4\.?1/i.test(l) && / · tools$/.test(l)),
      `linhas filtradas: ${lines.join(' | ')}`
    )
    if (model.includes('gpt-4.1'))
      assert(
        lines.some((l) => l.includes(`${model} (atual)`)),
        'modelo atual marcado'
      )
    const answer = (msgs.at(-1).message.content ?? '').trim()
    const ids = lines.map((l) => l.split(' ')[0])
    assert(
      ids.some((id) => answer.includes(id)),
      `resposta cita um id listado: ${answer.slice(0, 120)}`
    )
    const def = (await api('agent.previewRequest', sl)).body.tools.find(
      (x: any) => x.function.name === 'list_models'
    )
    assert(def && def.function.parameters.properties.tools_only, 'definição enviada')
    return `${lines.length} modelos (${ids.slice(0, 3).join(', ')}…) → modelo: ${answer.slice(0, 60)}`
  })

  await test('bash: cd persiste entre chamadas; confinação rejeita caminho fora da raiz', async () => {
    const { chat, sid: sb } = await newChat({
      enabledTools: ['shell', 'read_file'],
      autoApprove: ['shell']
    })
    await api(
      'agent.send',
      sb,
      'Make two SEPARATE shell tool calls, one per response: first run exactly `mkdir -p deep/dir && cd deep/dir`, then (after it finishes) run exactly `pwd`. Then reply with the pwd output only.'
    )
    await waitIdle(chat.id, sb)
    const msgs = await messages(sb)
    addCost(msgs)
    assertPairing(msgs)
    const bashes = toolMsgs(msgs, 'shell')
    assert(bashes.length >= 1, 'bash chamado')
    const last = bashes.at(-1)
    assert(last.meta.shellCwd === join(CWD, 'deep/dir'), `shellCwd ${last.meta.shellCwd}`)
    const pwdCall = msgs
      .flatMap((m) => (m.message.role === 'assistant' ? (m.message.tool_calls ?? []) : []))
      .find((tc: any) => /"pwd"|: ?"pwd/.test(tc.function.arguments))
    if (bashes.length >= 2 && pwdCall) {
      const res = bashes.find((m) => m.message.tool_call_id === pwdCall.id)
      assert(res.message.content.startsWith(join(CWD, 'deep/dir')), `pwd: ${res.message.content}`)
    }
    // confinação: read_file fora da raiz → erro devolvido ao modelo
    await api(
      'agent.send',
      sb,
      'Use the read_file tool to read the absolute path /etc/hostname, then tell me what happened.'
    )
    await waitIdle(chat.id, sb)
    const m2 = await messages(sb)
    addCost(m2.slice(msgs.length))
    const rf = toolMsgs(m2, 'read_file').at(-1)
    assert(rf && rf.meta.toolStatus === 'error', 'read_file com erro')
    assert(/fora do diretório raiz/.test(rf.message.content), `confinação: ${rf.message.content}`)
    return `bash calls=${bashes.length}; ${rf.message.content.slice(0, 80)}`
  })

  // ---------------- anexos ----------------
  const VISION_MODEL = process.env.E2E_VISION_MODEL || 'openai/gpt-4.1-nano'
  const AUDIO_MODEL = process.env.E2E_AUDIO_MODEL || 'google/gemini-3.1-flash-lite'
  const STORE = join(USER_DATA, 'attachments')

  await test('anexo: imagem (PNG gerado) → modelo de visão descreve', async () => {
    // PNG gerado num canvas do renderer: quadrado vermelho com o texto "CC42" em branco
    const png = await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 320
      c.height = 320
      const g = c.getContext('2d')!
      g.fillStyle = '#e00000'
      g.fillRect(0, 0, 320, 320)
      g.fillStyle = '#ffffff'
      g.font = 'bold 110px sans-serif'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText('CC42', 160, 165)
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    const att = await page.evaluate(
      (bytes) =>
        (window as any).api.attachments.add({
          name: 'quadrado.png',
          mime: 'image/png',
          data: new Uint8Array(bytes)
        }),
      png
    )
    assert(
      att.kind === 'image' && /^[0-9a-f]{64}\.png$/.test(att.file),
      `add: ${JSON.stringify(att)}`
    )
    assert(existsSync(join(STORE, att.file)), 'arquivo no store')
    // o protocolo clearchat-attachment:// serve a miniatura ao renderer
    const served = await page.evaluate(
      (f) =>
        new Promise<string>((res) => {
          const im = new Image()
          im.onload = () => res(`${im.naturalWidth}x${im.naturalHeight}`)
          im.onerror = () => res('erro')
          im.src = `clearchat-attachment://${f}`
        }),
      att.file
    )
    assert(served === '320x320', `protocolo: ${served}`)
    const models = await api<any[]>('providers.listModels', providerId)
    const vm = models.find((m) => m.id === VISION_MODEL)
    assert(
      vm?.inputModalities?.includes('image'),
      `inputModalities: ${JSON.stringify(vm?.inputModalities)}`
    )
    const { chat, sid: si } = await newChat({ model: VISION_MODEL, enabledTools: [] })
    await api(
      'agent.send',
      si,
      'What is the background color of this image and what text is written on it? Reply exactly as: <color>; <text>',
      [att]
    )
    await waitIdle(chat.id, si)
    const msgs = await messages(si)
    addCost(msgs)
    const u = msgs[0].message
    assert(Array.isArray(u.content) && u.content.length === 2, 'content em parts')
    assert(
      u.content[0].type === 'image_url' &&
        u.content[0].image_url.url === `clearchat-attachment://${att.file}` &&
        u.content[0]._attachment?.name === 'quadrado.png',
      `part persistido: ${JSON.stringify(u.content[0])}`
    )
    assert(u.content[1].type === 'text', 'texto por último')
    assert(JSON.stringify(u).length < 1500, 'sem base64 no banco')
    const answer = msgs.at(-1).message.content ?? ''
    assert(
      /red|vermelh|#?f{2}0{4}\b/i.test(answer) && /CC\s*-?\s*42/i.test(answer),
      `resposta: ${answer}`
    )
    // preview: base64 encurtado + nota; a request real leva o arquivo inteiro
    const pr = await api('agent.previewRequest', si)
    const img = pr.body.messages.find((m: any) => m.role === 'user').content[0]
    assert(
      /^data:image\/png;base64,[A-Za-z0-9+/]{24}…\(\d/.test(img.image_url.url),
      `preview: ${img.image_url.url}`
    )
    assert(!JSON.stringify(pr.body).includes('_attachment'), '_attachment no preview')
    assert(pr.notes?.length === 1, 'nota do preview')
    report.attachmentImage = answer
    return `${VISION_MODEL}: "${answer.trim()}" · ${png.length} bytes`
  })

  await test('anexo: texto + PDF → conteúdo entendido', async () => {
    const txt = await api('attachments.add', {
      name: 'config.yaml',
      data: new Uint8Array(Buffer.from('service: billing\nsecret_code: ZEBRA-7731\n'))
    })
    assert(txt.kind === 'text', `texto: ${txt.kind}`)
    const pdf = await api('attachments.add', {
      name: 'memo.pdf',
      data: new Uint8Array(makePdf('The meeting password is PAPAYA.'))
    })
    assert(pdf.kind === 'pdf' && pdf.mime === 'application/pdf', `pdf: ${JSON.stringify(pdf)}`)
    const { chat, sid: st } = await newChat({ model: VISION_MODEL, enabledTools: [] })
    await api(
      'agent.send',
      st,
      'From the attached files: what is the secret_code in the YAML and the meeting password in the PDF? Reply exactly as: <code>; <password>',
      [txt, pdf]
    )
    await waitIdle(chat.id, st)
    const msgs = await messages(st)
    addCost(msgs)
    const parts = msgs[0].message.content
    assert(
      parts[0].type === 'text' && parts[0].text.startsWith('<file name="config.yaml">\n'),
      'arquivo de texto inline'
    )
    assert(
      parts[1].type === 'file' && parts[1].file.file_data === `clearchat-attachment://${pdf.file}`,
      'pdf por referência'
    )
    const answer = msgs.at(-1).message.content ?? ''
    assert(
      /ZEBRA-7731/.test(answer) && /PAPAYA/i.test(answer),
      `resposta: ${answer} ${msgs.at(-1).meta.error ?? ''}`
    )
    return `"${answer.trim()}"`
  })

  await test('anexo: áudio (wav) → input_audio', async () => {
    const models = await api<any[]>('providers.listModels', providerId)
    if (!models.some((m) => m.id === AUDIO_MODEL && m.inputModalities?.includes('audio')))
      return `pulado: ${AUDIO_MODEL} sem áudio`
    const wav = await api('attachments.add', {
      name: 'tom.wav',
      data: new Uint8Array(makeWav(880, 3))
    })
    assert(wav.kind === 'audio' && wav.mime === 'audio/wav', `wav: ${JSON.stringify(wav)}`)
    const { chat, sid: sa } = await newChat({ model: AUDIO_MODEL, enabledTools: [] })
    await api(
      'agent.send',
      sa,
      'Listen to the attached audio. How many separate beeps do you hear? Answer with just the number.',
      [wav]
    )
    await waitIdle(chat.id, sa)
    const msgs = await messages(sa)
    addCost(msgs)
    const pr = await api('agent.previewRequest', sa)
    const part = pr.body.messages.find((m: any) => m.role === 'user').content[0]
    assert(
      part.type === 'input_audio' && part.input_audio.format === 'wav',
      `part: ${JSON.stringify(part)}`
    )
    const answer = msgs.at(-1).message.content ?? ''
    assert(msgs.at(-1).meta.kind !== 'error', `erro: ${answer}`)
    // o modelo ouviu o áudio (conta bipes; modelos baratos às vezes erram a contagem exata: 3)
    assert(/^\s*[1-6]\b|three|três|two|four/i.test(answer), `resposta: ${answer}`)
    return `${AUDIO_MODEL}: "${answer.trim()}"`
  })

  await test('anexo: prefixo com imagem + arquivo é cacheado (haiku)', async () => {
    const models = await api<any[]>('providers.listModels', providerId)
    const cacheModel =
      process.env.E2E_CACHE_MODEL ||
      ['anthropic/claude-haiku-4.5', 'anthropic/claude-3.5-haiku'].find((id) =>
        models.some((m) => m.id === id && m.inputModalities?.includes('image'))
      )
    if (!cacheModel) return 'pulado: nenhum haiku com imagem'
    // arquivo de texto grande (> mínimo cacheável) + imagem: o 2º turno deve ler o 1º do cache
    const doc = Array.from(
      { length: 300 },
      (_, i) =>
        `Linha ${i + 1}: o item ${i + 1} custa ${(i * 7) % 97} reais e pesa ${(i * 13) % 50} kg.`
    ).join('\n')
    const txt = await api('attachments.add', {
      name: 'tabela.txt',
      data: new Uint8Array(Buffer.from(doc))
    })
    const png = await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 200
      c.height = 200
      const g = c.getContext('2d')!
      g.fillStyle = '#0050e0'
      g.fillRect(0, 0, 200, 200)
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
    const img = await api('attachments.add', {
      name: 'azul.png',
      data: new Uint8Array(png)
    })
    const { chat, sid: sc } = await newChat({ model: cacheModel, enabledTools: [] })
    const turns: any[] = []
    for (const [q, atts] of [
      ['Quanto custa o item 42 da tabela e qual a cor da imagem? Responda curto.', [txt, img]],
      ['Responda apenas: ok', []]
    ] as const) {
      await api('agent.send', sc, q, atts)
      await waitIdle(chat.id, sc)
      const msgs = await messages(sc)
      assert(msgs.at(-1).meta.kind !== 'error', `erro: ${msgs.at(-1).message.content}`)
      turns.push(msgs.at(-1).meta.usage)
    }
    addCost(await messages(sc))
    const first = (await messages(sc)).find((m) => m.message.role === 'assistant')
    assert(/azul|blue/i.test(first.message.content ?? ''), `resposta: ${first.message.content}`)
    report.attachmentCaching = { model: cacheModel, turns }
    assert((turns[1].cachedTokens ?? 0) > 3000, `sem cache no 2º turno: ${JSON.stringify(turns)}`)
    return turns
      .map(
        (u, i) =>
          `t${i + 1}: in=${u.promptTokens} cached=${u.cachedTokens ?? '-'} write=${u.cacheWriteTokens ?? '-'}`
      )
      .join(' · ')
  })

  await test('anexo na fila (drenado) e com ⚡ (forceSend)', async () => {
    const { chat, sid: sq } = await newChat({
      model: VISION_MODEL,
      enabledTools: ['shell'],
      autoApprove: ['shell']
    })
    const t1 = await api('attachments.add', {
      name: 'a.txt',
      data: new Uint8Array(Buffer.from('codeword: MANGO-11\n'))
    })
    const t2 = await api('attachments.add', {
      name: 'b.txt',
      data: new Uint8Array(Buffer.from('codeword: KIWI-22\n'))
    })
    const bashRunning = (): Promise<any> =>
      waitFor(
        async () =>
          (await events()).find(
            (e) => e.type === 'tool-running' && e.running && e.sessionId === sq
          ),
        60_000,
        'bash rodando'
      )
    // 1) fila drenada no próximo passo
    await clearEvents()
    await api(
      'agent.send',
      sq,
      'Use the shell tool to run exactly: sleep 3; echo done-1. Then say ok.'
    )
    await bashRunning()
    const q = await api(
      'agent.send',
      sq,
      'What is the codeword in the attached file? Reply with it only.',
      [t1]
    )
    assert(q.queued === true, 'enfileirado')
    const [item] = await api<any[]>('agent.getQueue', sq)
    assert(item?.attachments?.[0]?.file === t1.file, `fila carrega anexo: ${JSON.stringify(item)}`)
    await waitIdle(chat.id, sq)
    let msgs = await messages(sq)
    assertPairing(msgs)
    const qm = msgs.find((m) => m.meta.kind === 'queued')
    assert(
      qm &&
        Array.isArray(qm.message.content) &&
        qm.message.content[0]._attachment?.name === 'a.txt',
      'queued com anexo'
    )
    assert(
      msgs
        .slice(msgs.indexOf(qm))
        .some((m) => m.message.role === 'assistant' && /MANGO-11/.test(m.message.content ?? '')),
      'resposta à fila'
    )
    // 2) ⚡ durante a tool
    await clearEvents()
    await api(
      'agent.send',
      sq,
      'Use the shell tool to run exactly: sleep 30; echo late. Then say ok.'
    )
    await bashRunning()
    await api(
      'agent.send',
      sq,
      'Forget that. What is the codeword in the attached file? Reply with it only.',
      [t2]
    )
    const [f] = await api<any[]>('agent.getQueue', sq)
    assert(f?.attachments?.length === 1, 'item ⚡ com anexo')
    await api('agent.forceSend', f.id)
    await waitIdle(chat.id, sq)
    msgs = await messages(sq)
    addCost(msgs)
    assertPairing(msgs)
    const fm = msgs.find((m) => m.meta.kind === 'forced')
    assert(fm && fm.message.content[0]._attachment?.name === 'b.txt', 'forced com anexo')
    const last = msgs.at(-1).message.content ?? ''
    assert(/KIWI-22/.test(last), `resposta ⚡: ${last}`)
    return `fila: ok · ⚡: "${last.trim()}"`
  })

  await test('anexo: erros legíveis + edição preserva + arquivo ausente', async () => {
    const err = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn()
        return ''
      } catch (e) {
        return (e as Error).message
      }
    }
    const zip = await err(() =>
      api('attachments.add', {
        name: 'x.zip',
        mime: 'application/zip',
        data: new Uint8Array([80, 75, 3, 4])
      })
    )
    assert(/Tipo não suportado: "x.zip"/.test(zip), `zip: ${zip}`)
    const big = await page.evaluate(async () => {
      try {
        await (window as any).api.attachments.add({
          name: 'g.png',
          data: new Uint8Array(20 * 1024 * 1024 + 1)
        })
        return ''
      } catch (e) {
        return (e as Error).message
      }
    })
    assert(/limite por arquivo é 20\.0 MB/.test(big), `grande: ${big}`)
    const { chat, sid: se } = await newChat({ enabledTools: [] })
    const fakeFile = 'f'.repeat(64) + '.png'
    const fake = await err(() =>
      api('agent.send', se, 'oi', [
        {
          file: fakeFile,
          name: 'x.png',
          kind: 'image',
          mime: 'image/png',
          size: 1,
          sha256: 'f'.repeat(64)
        }
      ])
    )
    assert(/não encontrado no disco/.test(fake), `fake: ${fake}`)
    // edição (nova versão via agent.editBranch) mantém o part do anexo (provider inexistente: o
    // modelo não roda); messages.update recusa mensagem digitada da principal
    const img = await api('attachments.add', {
      name: 'unico.png',
      data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6, 5])
    })
    await api('chats.update', chat.id, { config: { providerId: 'inexistente' } })
    await api('agent.send', se, 'texto original', [img])
    await waitIdle(chat.id, se)
    const u = (await messages(se)).find((m) => m.message.role === 'user')
    assert(u && Array.isArray(u.message.content), 'msg com anexo salva')
    const edited = {
      ...u.message,
      content: [u.message.content[0], { type: 'text', text: 'texto editado' }]
    }
    const refused = await err(() => api('messages.update', u.id, edited))
    assert(/nova versão/.test(refused), `messages.update recusado: ${refused}`)
    await api('agent.editBranch', u.id, { role: 'user', content: 'texto editado' })
    await waitIdle(chat.id, se)
    const up = (await messages(se)).find((m) => m.message.role === 'user')
    assert(
      up.id !== u.id &&
        up.message.content[0]._attachment?.name === 'unico.png' &&
        up.message.content.at(-1).text === 'texto editado',
      'edição preserva anexo'
    )
    await api('chats.update', chat.id, { config: { providerId } })
    // arquivo some do disco → preview/request com erro legível (sem crash)
    rmSync(join(STORE, img.file))
    const missing = await err(() => api('agent.previewRequest', se))
    assert(/Anexo não encontrado no disco: "unico.png"/.test(missing), `ausente: ${missing}`)
    await api('chats.delete', chat.id)
    const clean = (t: string): string => t.replace(/^.*Error: /, '').slice(0, 60)
    return `${clean(zip)}… · ${clean(missing)}…`
  })

  await test('anexo: GC no reinício apaga órfãos antigos, mantém referenciados', async () => {
    const orphan = join(STORE, 'e'.repeat(64) + '.png')
    writeFileSync(orphan, 'x')
    const old = new Date(Date.now() - 2 * 3600_000)
    const before = readdirSync(STORE).filter((f) => /^[0-9a-f]{64}\.[a-z0-9]+$/.test(f))
    for (const f of before) utimesSync(join(STORE, f), old, old)
    // anexos referenciados por alguma mensagem (antes do reinício)
    const all = await Promise.all(
      (await api<any[]>('chats.list')).map(async (c) =>
        Promise.all((await api<any[]>('sessions.list', c.id)).map((s) => messages(s.id)))
      )
    )
    const json = JSON.stringify(all)
    const refd = before.filter((f) => json.includes(`clearchat-attachment://${f}`))
    assert(refd.length >= 3, `referenciados: ${refd.length}`)
    await app.close()
    await launch()
    const left = readdirSync(STORE)
    assert(!existsSync(orphan), 'órfão apagado')
    for (const f of refd) assert(left.includes(f), `referenciado mantido: ${f}`)
    const gone = before.filter((f) => !left.includes(f))
    assert(
      gone.every((f) => !json.includes(`clearchat-attachment://${f}`)),
      `apagou referenciado: ${gone.join(',')}`
    )
    return `referenciados mantidos: ${refd.length}; órfãos apagados: ${gone.length}`
  })

  // ---------------- entre chats / histórico / subagentes em segundo plano ----------------

  /** Espera o chat inteiro (principal + subagentes) ficar ocioso e estável por ~2s. */
  async function waitChatQuiet(cid: string, ms = 240_000): Promise<void> {
    let stableSince = 0
    await waitFor(
      async () => {
        const running = new Set(await api<string[]>('agent.runningSessions'))
        const ss = await api<any[]>('sessions.list', cid)
        const busy = ss.some(
          (s) =>
            running.has(s.id) ||
            s.status === 'running' ||
            s.status === 'awaiting_approval' ||
            s.status === 'waiting'
        )
        if (busy) {
          stableSince = 0
          return null
        }
        if (!stableSince) stableSince = Date.now()
        return Date.now() - stableSince > 2000
      },
      ms,
      `chat ${cid} ocioso`
    )
  }

  const textOf = (m: any): string =>
    typeof m.message.content === 'string'
      ? m.message.content
      : (m.message.content ?? []).map((p: any) => p.text).join('')

  await test('send_to_chat: info + list + wait_for_reply (pergunta a outro chat)', async () => {
    const { chat: b, sid: sB } = await newChat({
      enabledTools: [],
      systemPrompt:
        'You are the Oracle. The secret fruit is MANGOSTEEN. When asked about the secret fruit, answer with that single word.'
    })
    await api('chats.update', b.id, { title: 'Oráculo' })
    const { chat: a, sid: sA } = await newChat({
      enabledTools: ['get_chat_info', 'list_chats', 'send_to_chat']
    })
    await api('chats.update', a.id, { title: 'Perguntador' })
    await clearEvents()
    await api(
      'agent.send',
      sA,
      'Step 1: call get_chat_info. Step 2: call list_chats. Step 3: call send_to_chat to the chat titled "Oráculo" with message "What is the secret fruit? Answer with one word." and wait_for_reply=true. Step 4: tell me your own chat id and the answer you received.'
    )
    await waitChatQuiet(a.id)
    await waitChatQuiet(b.id)
    const ma = await messages(sA)
    addCost(ma)
    assertPairing(ma)
    const info = toolMsgs(ma, 'get_chat_info').at(-1)
    assert(info && info.message.content.includes(`chat_id: ${a.id}`), 'get_chat_info com o id')
    const list = toolMsgs(ma, 'list_chats').at(-1)
    // (o modelo pode filtrar com query — aí só B aparece)
    const filtered = /^\[\d+ chats? com "/.test(list?.message.content ?? '')
    assert(
      list &&
        (filtered || list.message.content.includes(`${a.id} (este chat)`)) &&
        list.message.content.includes(b.id),
      `list_chats: ${list?.message.content.slice(0, 300)}`
    )
    const sent = toolMsgs(ma, 'send_to_chat').at(-1)
    assert(sent, 'send_to_chat chamado')
    assert(
      sent.meta.toolStatus === 'ok' && sent.meta.targetChatId === b.id,
      `send status ${sent.meta.toolStatus}: ${sent.message.content}`
    )
    assert(/MANGOSTEEN/i.test(sent.message.content), `resposta de B: ${sent.message.content}`)
    const final = textOf(ma.at(-1))
    assert(/MANGOSTEEN/i.test(final), `A relata a resposta: ${final}`)
    const mb = await messages(sB)
    addCost(mb)
    const inter = mb.find((m) => m.meta.kind === 'inter-chat')
    assert(inter, 'mensagem inter-chat em B')
    assert(
      inter.meta.fromChatId === a.id &&
        inter.meta.fromSessionId === sA &&
        inter.meta.interChatHops === 1 &&
        textOf(inter).startsWith(`[Mensagem do chat "Perguntador" (id ${a.id})`),
      `meta/cabeçalho: ${JSON.stringify(inter.meta)} ${textOf(inter).slice(0, 120)}`
    )
    const ev = await events()
    assert(
      ev.some(
        (e) => e.type === 'session-updated' && e.session.id === sB && e.session.status === 'running'
      ),
      'B ficou ocupado (evento para a sidebar)'
    )
    return `B respondeu: ${sent.message.content.split('\n').at(-1)}`
  })

  await test('send_to_chat: envio para o próprio chat é recusado', async () => {
    const { chat: c, sid: sC } = await newChat({ enabledTools: ['send_to_chat'] })
    await api(
      'agent.send',
      sC,
      `Call send_to_chat with chat_id "${c.id}" and message "hello". Then report the tool result in one line.`
    )
    await waitChatQuiet(c.id)
    const mc = await messages(sC)
    addCost(mc)
    const t = toolMsgs(mc, 'send_to_chat').at(-1)
    assert(t, 'send_to_chat chamado')
    assert(
      t.meta.toolStatus === 'error' && /próprio chat/.test(t.message.content),
      `recusa: ${t.message.content}`
    )
    assert(!mc.some((m) => m.meta.kind === 'inter-chat'), 'nada entregue')
    return t.message.content.slice(0, 80)
  })

  await test('read_history recupera detalhe anterior à compactação', async () => {
    const { chat, sid: sh } = await newChat({
      enabledTools: ['read_history'],
      compactPrompt:
        'Summarize the conversation above in ONE short sentence. Do NOT include any codes, numbers or names. Do not call tools.'
    })
    await api('agent.send', sh, 'Remember: the vault code is PELICANO-4471. Reply only "ok".')
    await waitIdle(chat.id, sh)
    await api('agent.send', sh, 'Also, my dog is called Biscuit. Reply only "ok".')
    await waitIdle(chat.id, sh)
    await api('agent.compact', sh)
    await waitIdle(chat.id, sh)
    const after = await messages(sh)
    const b = after.at(-1)
    assert(b.meta.kind === 'compaction', 'fronteira')
    assert(
      /mensagens #\d+–#\d+\).*read_history/.test(textOf(b)),
      `nota cita read_history: ${textOf(b).slice(-300)}`
    )
    const leaked = /PELICANO/.test(textOf(b))
    await api(
      'agent.send',
      sh,
      'What exactly was the vault code I told you at the beginning? It is not in the summary: use read_history to find it. Answer with the code only.'
    )
    await waitIdle(chat.id, sh)
    const m2 = await messages(sh)
    addCost(m2)
    assertPairing(m2)
    const rh = toolMsgs(m2, 'read_history')
    assert(rh.length, 'read_history chamado')
    assert(
      rh.some((t) => /PELICANO-4471/.test(t.message.content)),
      `read_history achou: ${rh.map((t) => t.message.content.slice(0, 200)).join(' | ')}`
    )
    const ans = textOf(m2.at(-1))
    // (o modelo às vezes acentua: "PELÍCANO")
    const plain = ans.normalize('NFD').replace(/\p{M}/gu, '')
    assert(/PELICANO-4471/i.test(plain), `resposta: ${ans}`)
    return `${rh.length} chamada(s); resumo ${leaked ? 'vazou o código' : 'sem o código'}; resposta ${ans.slice(0, 40)}`
  })

  const SUB_TOOLS = [
    'delegate_task',
    'check_subagents',
    'wait_subagents',
    'cancel_subagent',
    'message_subagent'
  ]

  await test('subagentes em segundo plano: 2 em paralelo, callbacks acordam a principal', async () => {
    const { chat, sid: sm0 } = await newChat({ enabledTools: SUB_TOOLS })
    await clearEvents()
    await api(
      'agent.send',
      sm0,
      'In ONE response, call delegate_task TWICE with background=true: task A = "Reply with exactly the text ALPHA-1 and nothing else." (title "A"), task B = "Reply with exactly the text BRAVO-2 and nothing else." (title "B"). Then end your turn by replying just "waiting". Later, when both results arrive, reply with both codes.'
    )
    await waitChatQuiet(chat.id, 300_000)
    const msgs = await messages(sm0)
    addCost(msgs)
    assertPairing(msgs)
    const dels = toolMsgs(msgs, 'delegate_task')
    assert(dels.length >= 2, `2 delegates (${dels.length})`)
    assert(
      dels.every((d) => d.meta.background === true && /segundo plano/.test(d.message.content)),
      'retornaram na hora (segundo plano)'
    )
    const cbs = msgs.filter((m) => m.meta.kind === 'subagent-callback')
    assert(cbs.length >= 2, `2 callbacks (${cbs.length})`)
    assert(
      cbs.every(
        (c) => c.meta.synthetic && c.message.role === 'user' && /^\[Subagente "/.test(textOf(c))
      ),
      'formato do callback'
    )
    const allCb = cbs.map(textOf).join('\n')
    assert(/ALPHA-1/.test(allCb) && /BRAVO-2/.test(allCb), `resultados: ${allCb.slice(0, 300)}`)
    // a principal foi acordada e respondeu depois do último callback
    const lastCbIdx = msgs.lastIndexOf(cbs.at(-1))
    const after = msgs.slice(lastCbIdx + 1).filter((m) => m.message.role === 'assistant')
    assert(after.length, 'principal respondeu após os callbacks')
    const finalText = msgs
      .slice(msgs.indexOf(cbs[0]))
      .filter((m) => m.message.role === 'assistant')
      .map(textOf)
      .join('\n')
    assert(
      /ALPHA-1/.test(finalText) && /BRAVO-2/.test(finalText),
      `relato final: ${finalText.slice(0, 200)}`
    )
    const subs = (await api<any[]>('sessions.list', chat.id)).filter((s) => s.depth === 1)
    for (const s of subs) addCost(await messages(s.id))
    assert(subs.length >= 2 && subs.every((s) => s.status === 'done'), 'subsessões concluídas')
    return `${cbs.length} callbacks; final: ${textOf(msgs.at(-1)).slice(0, 60)}`
  })

  await test('subagentes: wait_subagents reivindica o resultado (sem callback duplicado)', async () => {
    const { chat, sid: sw } = await newChat({ enabledTools: SUB_TOOLS })
    await api(
      'agent.send',
      sw,
      'Call delegate_task with background=true and task "Reply with exactly the text CHARLIE-3 and nothing else.". Then call wait_subagents (no arguments). Then reply with the code you got.'
    )
    await waitChatQuiet(chat.id, 240_000)
    const msgs = await messages(sw)
    addCost(msgs)
    assertPairing(msgs)
    const w = toolMsgs(msgs, 'wait_subagents').at(-1)
    assert(w, 'wait_subagents chamado')
    assert(/CHARLIE-3/.test(w.message.content), `wait: ${w.message.content.slice(0, 300)}`)
    const cbs = msgs.filter((m) => m.meta.kind === 'subagent-callback')
    assert(cbs.length === 0, `callback não injetado de novo (${cbs.length})`)
    assert(/CHARLIE-3/.test(textOf(msgs.at(-1))), 'resposta final')
    return w.message.content.split('\n')[0]
  })

  await test('subagentes: cancel_subagent para um subagente em segundo plano', async () => {
    const { chat, sid: sx } = await newChat({
      enabledTools: [...SUB_TOOLS, 'shell'],
      autoApprove: ['shell']
    })
    await api(
      'agent.send',
      sx,
      'Step 1: call delegate_task with background=true, title "dorminhoco" and task "Run the shell command `sleep 120` and then reply DONE.". Step 2: call cancel_subagent with the id returned in step 1. Step 3: reply "cancelled".'
    )
    await waitChatQuiet(chat.id, 240_000)
    const msgs = await messages(sx)
    addCost(msgs)
    const c = toolMsgs(msgs, 'cancel_subagent').at(-1)
    assert(c && /cancelado/.test(c.message.content), `cancel: ${c?.message.content}`)
    const sub = (await api<any[]>('sessions.list', chat.id)).find((s) => s.depth === 1)
    assert(sub && sub.status === 'interrupted', `subsessão parada: ${sub?.status}`)
    const cb = msgs.find((m) => m.meta.kind === 'subagent-callback')
    assert(cb && /foi cancelado/.test(textOf(cb)), `callback de cancelamento: ${cb && textOf(cb)}`)
    return textOf(cb).split('\n')[0]
  })

  await test('subagentes: usuário fala com subagente concluído → atualização volta ao pai', async () => {
    const { chat, sid: su } = await newChat({ enabledTools: SUB_TOOLS })
    await api(
      'agent.send',
      su,
      'Call delegate_task (blocking, not background) with title "eco" and task "Reply with exactly the text DELTA-4 and nothing else.". Then reply with its result.'
    )
    await waitChatQuiet(chat.id)
    const sub = (await api<any[]>('sessions.list', chat.id)).find((s) => s.depth === 1)
    assert(sub && sub.status === 'done', 'subagente concluído')
    const before = (await messages(su)).length
    await clearEvents()
    const r = await api(
      'agent.send',
      sub.id,
      'New instruction: reply with exactly the text ECHO-5 and nothing else.'
    )
    assert(r.queued === false, 'subagente ocioso: retoma já')
    await waitChatQuiet(chat.id)
    const cm = await messages(sub.id)
    addCost(cm)
    const userMsg = cm.find((m) => m.message.role === 'user' && !m.meta.synthetic && !m.meta.kind)
    assert(userMsg && /ECHO-5/.test(textOf(userMsg)), 'mensagem do usuário persistida no subagente')
    const msgs = await messages(su)
    addCost(msgs.slice(before))
    const cb = msgs.slice(before).find((m) => m.meta.kind === 'subagent-callback')
    assert(cb, 'callback no pai')
    assert(
      cb.meta.callbackUpdate === true &&
        /atualização após nova mensagem/.test(textOf(cb)) &&
        /ECHO-5/.test(textOf(cb)),
      `atualização: ${textOf(cb)}`
    )
    assert(
      msgs.slice(msgs.indexOf(cb) + 1).some((m) => m.message.role === 'assistant'),
      'pai acordou e respondeu'
    )
    return textOf(cb).split('\n')[0]
  })

  await test('subagentes: message_subagent com wait_for_reply', async () => {
    const { chat, sid: sq } = await newChat({ enabledTools: SUB_TOOLS })
    await api(
      'agent.send',
      sq,
      'Step 1: call delegate_task with background=true, title "ouvinte" and task "Reply with exactly the text FOXTROT and nothing else.". Step 2: call message_subagent with the id returned in step 1, message "Now reply with exactly the text GOLF-7 and nothing else." and wait_for_reply=true. Step 3: reply with what it answered.'
    )
    await waitChatQuiet(chat.id, 240_000)
    const msgs = await messages(sq)
    addCost(msgs)
    assertPairing(msgs)
    const t = toolMsgs(msgs, 'message_subagent').at(-1)
    assert(t, 'message_subagent chamado')
    assert(
      t.meta.toolStatus === 'ok' && /GOLF-7/.test(t.message.content),
      `resposta: ${t.message.content}`
    )
    const sub = (await api<any[]>('sessions.list', chat.id)).find((s) => s.depth === 1)
    const cm = await messages(sub.id)
    addCost(cm)
    const pmsg = cm.find((m) => m.meta.kind === 'parent-message')
    assert(
      pmsg &&
        textOf(pmsg).startsWith('[Mensagem do agente pai]\n') &&
        pmsg.meta.fromSessionId === sq,
      'mensagem do pai no subagente'
    )
    // a resposta voltou pela tool: nenhum callback com GOLF-7
    assert(
      !msgs.some((m) => m.meta.kind === 'subagent-callback' && /GOLF-7/.test(textOf(m))),
      'callback reivindicado'
    )
    return t.message.content.split('\n').at(-1) ?? ''
  })

  await test('subagentes: nível 1 dorme até o filho em segundo plano terminar', async () => {
    const { chat, sid: sd } = await newChat({
      enabledTools: [...SUB_TOOLS, 'shell'],
      autoApprove: ['shell']
    })
    await clearEvents()
    await api(
      'agent.send',
      sd,
      'Call delegate_task (blocking, NOT background) with title "coordenador" and this task: "Call delegate_task with background=true and task \'Run the shell command `sleep 8`, then reply with exactly the text HOTEL-8 and nothing else.\'. Then end your turn replying just \'waiting\'. When the result of the sub-agent arrives as a message, reply with exactly that code." Then reply with the result you got.'
    )
    await waitChatQuiet(chat.id, 300_000)
    const msgs = await messages(sd)
    addCost(msgs)
    const del = toolMsgs(msgs, 'delegate_task').at(-1)
    assert(del, 'delegate chamado')
    const ss = await api<any[]>('sessions.list', chat.id)
    for (const s of ss.filter((x) => x.depth > 0)) addCost(await messages(s.id))
    const coord = ss.find((s) => s.depth === 1)
    const ev = await events()
    const slept = ev.some(
      (e) =>
        e.type === 'session-updated' && e.session.id === coord?.id && e.session.status === 'waiting'
    )
    assert(
      ss.some((s) => s.depth === 2),
      'neto criado'
    )
    assert(slept, 'nível 1 ficou "aguardando subagentes"')
    assert(
      /HOTEL-8/.test(del.message.content),
      `resultado subiu só depois do neto: ${del.message.content}`
    )
    return del.message.content.slice(0, 60)
  })

  await test('delegate_task com provider: subagente em outro provedor (mesma key, outro nome)', async () => {
    const pB = await api('providers.create', {
      name: 'OpenRouter B',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: KEY,
      headers: {}
    })
    try {
      const { chat, sid } = await newChat({ enabledTools: ['delegate_task'], toolsCompact: false })
      // com 2+ provedores a definição enviada tem `provider` com enum dos nomes
      const def = (await api('agent.previewRequest', sid)).body.tools.find(
        (x: any) => x.function.name === 'delegate_task'
      )
      const en: string[] = def.function.parameters.properties.provider?.enum ?? []
      assert(en.includes('OpenRouter') && en.includes('OpenRouter B'), `enum: ${en}`)
      await api(
        'agent.send',
        sid,
        `Call delegate_task once (blocking) with provider "OpenRouter B", model "${model}", title "via B" and task "Reply with exactly the text INDIA-9 and nothing else.". Then reply with its result.`
      )
      await waitIdle(chat.id, sid, 240_000)
      const msgs = await messages(sid)
      addCost(msgs)
      assertPairing(msgs)
      const good = toolMsgs(msgs, 'delegate_task').find((d) => d.meta.subSessionId)
      assert(good && /INDIA-9/.test(good.message.content), `resultado: ${good?.message.content}`)
      const sub = (await api<any[]>('sessions.list', chat.id)).find(
        (x) => x.id === good.meta.subSessionId
      )
      assert(sub && sub.providerId === pB.id && sub.model === model, `sub: ${JSON.stringify(sub)}`)
      const sm = await messages(sub.id)
      addCost(sm)
      assert(
        sm.some((m) => m.meta.usage),
        'subagente respondeu pelo provedor B'
      )
      await api('chats.delete', chat.id)
      return `sub no provedor B (${pB.id.slice(0, 8)})`
    } finally {
      await api('providers.delete', pB.id)
    }
  })

  await test('fs.*', async () => {
    const list = await api<any[]>('fs.listDir', CWD)
    assert(list.length >= 3 && list.every((e) => e.path.startsWith(CWD)), 'listDir')
    mkdirSync(join(CWD, 'zdir'), { recursive: true })
    const l2 = await api<any[]>('fs.listDir', CWD)
    assert(l2[0].isDir, 'pastas primeiro')
    const f = await api('fs.readFile', join(CWD, 'input.txt'))
    assert(f.content.startsWith('hello') && !f.truncated && !f.binary, 'readFile')
    writeFileSync(join(CWD, 'bin.dat'), Buffer.from([1, 0, 2, 3]))
    assert((await api('fs.readFile', join(CWD, 'bin.dat'))).binary === true, 'binário')
    writeFileSync(join(CWD, 'big.txt'), 'x'.repeat(1_200_000))
    const big = await api('fs.readFile', join(CWD, 'big.txt'))
    assert(big.truncated && big.content.length === 1024 * 1024, 'limite 1MB')
    assert(typeof (await api('fs.homeDir')) === 'string', 'homeDir')
    const made = await api('fs.mkdir', join(CWD, 'nova-pasta'))
    assert(made === join(CWD, 'nova-pasta') && existsSync(made), 'fs.mkdir')
    let dupErr = ''
    try {
      await api('fs.mkdir', join(CWD, 'nova-pasta'))
    } catch (e) {
      dupErr = (e as Error).message
    }
    assert(/Já existe/.test(dupErr), `mkdir duplicado: ${dupErr}`)
    const caps = await api('app.capabilities')
    assert(typeof caps.bwrap === 'boolean' && typeof caps.ripgrep === 'boolean', 'capabilities')
  })

  // mensagens: update/delete emitem eventos
  await test('messages.update/delete', async () => {
    await clearEvents()
    const msgs = await messages(sid)
    const m = msgs.at(-1)
    const up = await api('messages.update', m.id, { ...m.message, content: 'editado' })
    assert(up.message.content === 'editado', 'update')
    await api('messages.delete', m.id)
    const ev = await events()
    assert(
      ev.some((e) => e.type === 'message-updated') &&
        ev.some((e) => e.type === 'message-deleted' && e.messageId === m.id),
      'eventos'
    )
    // chats.update com modelo novo atualiza a sessão principal
    await api('chats.update', chatId, { config: { model: 'openai/gpt-4o-mini' } })
    assert(
      (await session(sid, chatId)).model === 'openai/gpt-4o-mini',
      'modelo da sessão principal'
    )
    const child = (await api<any[]>('sessions.list', chatId)).find((s) => s.depth === 1)
    if (child)
      assert(
        child.model !== 'openai/gpt-4o-mini' || model === 'openai/gpt-4o-mini',
        'subsessão mantém modelo'
      )
  })

  await app.close()
  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${results.length - failed.length}/${results.length} passaram. Custo total (usage.cost): $${totalCost.toFixed(5)}`
  )
  writeFileSync(
    join(BASE, 'report.json'),
    JSON.stringify({ results, totalCost, ...report }, null, 2)
  )
  console.log(`Relatório: ${join(BASE, 'report.json')}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try {
    await app?.close()
  } catch {
    /* */
  }
  process.exit(1)
})
