/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do sync com DUAS instâncias reais do app (Playwright `_electron`, userData isolados) contra o
// servidor de sync FALSO (e2e/fakes/syncServer.ts) e um provedor OpenAI-compatible FALSO (nada de
// key real). Cobre: login pela UI (onboarding) e pela API, upload/download de provedores, chats e
// mensagens nos dois sentidos, host de execução (envio remoto executado no host, stream ao vivo
// visível no controle remoto, aprovação remota), host offline → composer desabilitado → assumir com
// aviso de ferramentas locais, troca forçada, "o dispositivo remoto caiu", divergência (escolher e
// descartar), skills opt-in, anexos (blob baixado sob demanda) e avisos push do host (§22: turno
// vindo de um "celular" com token → aprovação, dismiss e resposta para ele, cifrados com K_push).
// Tira screenshots das telas novas.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/sync.spec.ts [filtro]
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startFakeSyncServer, type FakeSyncServer } from './fakes/syncServer.ts'
import { aadPush, open, pushKey, unframeJson } from '../docs/test-vectors/generate.ts'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-sync-e2e'))
const SHOTS = join(BASE, 'shots')
const FILTER = process.argv[2] ?? ''
const EMAIL = 'eduardo@teste.dev'
const PASSWORD = 'senha de criptografia do teste'

// ---------------- provedor falso ----------------

const hits: any[] = []
let llm: Server | null = null
let llmBase = ''
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}

async function startLlm(): Promise<void> {
  llm = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: 'fake/agent', context_length: 64000, supported_parameters: ['tools'] }]
          })
        )
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const chunk = (delta: any, finish?: string): string =>
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 50, completion_tokens: 5 } } : {}) })}\n\n`
      const last = msgs[msgs.length - 1]
      if (last?.role === 'tool') {
        res.write(
          chunk({ role: 'assistant', content: `FIM: ${textOf(last.content).slice(0, 30)}` })
        )
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      if (/^explique e rode o comando/.test(lastUser)) {
        for (const p of ['Vou rodar ', 'o comando ', 'agora.']) {
          if (res.destroyed) return
          res.write(chunk({ role: 'assistant', content: p }))
          await new Promise((r) => setTimeout(r, 300))
        }
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_${hits.length}`,
                type: 'function',
                function: {
                  name: 'shell',
                  arguments: JSON.stringify({ command: 'expr texto-e-tool' })
                }
              }
            ]
          })
        )
        res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      const toChat = /^mande para o chat (\S+): (.+)$/.exec(lastUser)
      if (toChat) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${hits.length}`,
                type: 'function',
                function: {
                  name: 'send_to_chat',
                  arguments: JSON.stringify({ chat_id: toChat[1], message: toChat[2] })
                }
              }
            ]
          })
        )
        res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      if (/^rode o comando/.test(lastUser)) {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${hits.length}`,
                type: 'function',
                function: {
                  name: 'shell',
                  arguments: JSON.stringify({ command: 'expr remoto-ok' })
                }
              }
            ]
          })
        )
        res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      if (/devagar/.test(lastUser)) {
        const parts = [
          'Resposta ',
          'lenta, ',
          'chegando ',
          'aos ',
          'poucos ',
          'do ',
          'host ',
          'para ',
          'o ',
          'controle ',
          'remoto.'
        ]
        for (const p of parts) {
          if (res.destroyed) return
          res.write(chunk({ role: 'assistant', content: p }))
          await new Promise((r) => setTimeout(r, 350))
        }
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      res.write(chunk({ role: 'assistant', content: `ok: ${lastUser.slice(0, 40)}` }))
      res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => llm!.listen(0, '127.0.0.1', r))
  llmBase = `http://127.0.0.1:${(llm!.address() as AddressInfo).port}/v1`
}

// ---------------- instâncias ----------------

interface Inst {
  name: string
  dir: string
  app: ElectronApplication
  page: Page
}

let srv: FakeSyncServer

async function launch(name: string, dir: string, url?: string): Promise<Inst> {
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = dir
  env.CLEARCHAT_SYNC_URL = url ?? srv.url
  env.CLEARCHAT_SYNC_FAST = '1'
  env.CLEARCHAT_DEVICE_NAME = name
  // presença fixa (presente): os avisos push só saem pelos turnos vindos do "celular"
  env.CLEARCHAT_FORCE_AWAY = '0'
  const app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, `${name.replace(/\W+/g, '_')}.log`), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  await page.evaluate(() => {
    const w = window as any
    w.__ev = []
    w.api.onEvent((e: unknown) => w.__ev.push(e))
  })
  return { name, dir, app, page }
}

async function api<T = any>(i: Inst, path: string, ...args: unknown[]): Promise<T> {
  return i.page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}

const events = (i: Inst): Promise<any[]> => i.page.evaluate(() => (window as any).__ev)
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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

async function shot(i: Inst, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await sleep(250)
  await i.page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const results: { name: string; ok: boolean; info?: string; ms: number }[] = []
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (FILTER && !FILTER.split(',').some((f) => name.includes(f.trim()))) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
  }
}

async function loginApi(i: Inst): Promise<void> {
  await api(i, 'sync.requestCode', EMAIL)
  await api(i, 'sync.verifyCode', EMAIL, srv.lastCode(EMAIL))
  await api(i, 'sync.unlock', PASSWORD, true)
}

const status = (i: Inst): Promise<any> => api(i, 'sync.status')
const hostInfo = async (i: Inst, chatId: string): Promise<any> =>
  (await api<any[]>(i, 'sync.chatStates')).find((h) => h.chatId === chatId)
const texts = async (i: Inst, sessionId: string): Promise<string[]> =>
  (await api<any[]>(i, 'sessions.messages', sessionId)).map((m) => textOf(m.message.content))
const settled = (i: Inst): Promise<any> =>
  waitFor(
    async () => {
      const s = await status(i)
      return s.phase === 'ready' && s.pending === 0 && s.connection === 'online' && s
    },
    20_000,
    `${i.name} sincronizado`
  )

async function openChatUi(i: Inst, title: string): Promise<void> {
  await i.page.locator('[data-testid="chat-item"]', { hasText: title }).first().click()
  await sleep(300)
}

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  await startLlm()
  srv = await startFakeSyncServer({
    hostDropGraceMs: 1500,
    commandTimeoutMs: 15_000,
    name: 'ClearChat (teste)',
    push: true
  })
  const { dek, userId } = await srv.createAccount({
    email: EMAIL,
    name: 'Eduardo',
    password: PASSWORD
  })

  const A = await launch('PC de casa', join(BASE, 'a'))
  const B = await launch('Notebook', join(BASE, 'b'))
  const skillsDir = join(BASE, 'skills-a')
  let providerId = ''
  let chat: any = null
  let toolChat: any = null

  await step(
    'onboarding: entrar pela UI (servidor, e-mail, código, desbloqueio) — online vazio',
    async () => {
      await A.page.getByTestId('onboarding-login').click()
      await A.page.getByTestId('sync-email').waitFor()
      await shot(A, '01-onboarding-servidor')
      await A.page.getByTestId('sync-email').fill(EMAIL)
      await A.page.getByRole('button', { name: 'Enviar código' }).click()
      await A.page.getByTestId('sync-code').waitFor()
      await A.page.getByTestId('sync-code').fill(srv.lastCode(EMAIL)!)
      await shot(A, '02-onboarding-codigo')
      await A.page
        .getByRole('button', { name: /Entrar/ })
        .last()
        .click()
      await A.page.getByText('Desbloquear seus dados').waitFor({ timeout: 15_000 })
      await A.page.locator('input[type="password"]').first().fill(PASSWORD)
      await shot(A, '03-onboarding-desbloqueio')
      await A.page.getByRole('button', { name: 'Desbloquear' }).click()
      await waitFor(async () => (await status(A)).phase === 'ready', 20_000, 'A pronto')
      await A.page.getByText(/Conectado como/).waitFor()
      await shot(A, '04-onboarding-conectado')
    }
  )

  await step(
    'provedor criado em A sincroniza para B (login de B pela API, local vazio)',
    async () => {
      providerId = (
        await api(A, 'providers.create', {
          name: 'LLM falso',
          baseUrl: llmBase,
          apiKey: 'sk-fake-123'
        })
      ).id
      await settled(A)
      await loginApi(B)
      await settled(B)
      const list = await api<any[]>(B, 'providers.list')
      assert(
        list.some((p) => p.id === providerId && p.apiKey === 'sk-fake-123'),
        'B recebeu o provedor (com a chave)'
      )
      await B.page.getByTestId('sync-indicator').waitFor({ timeout: 10_000 })
    }
  )

  await step(
    'chat e mensagens: A executa (vira host) e B recebe; B edita o título e A recebe',
    async () => {
      chat = await api(A, 'chats.create', {
        title: 'Projeto compartilhado',
        config: { providerId, model: 'fake/agent', cwd: BASE, enabledTools: [] }
      })
      await api(A, 'agent.send', chat.mainSessionId, 'olá do PC')
      await waitFor(
        async () => (await texts(A, chat.mainSessionId)).length >= 2,
        15_000,
        'A respondeu'
      )
      await settled(A)
      await waitFor(
        async () => (await texts(B, chat.mainSessionId)).includes('ok: olá do PC'),
        15_000,
        'B recebeu as mensagens'
      )
      const h = await hostInfo(B, chat.id)
      assert(
        h?.mode === 'remote' && h.host?.name === 'PC de casa',
        `B é controle remoto (${h?.mode})`
      )
      await api(B, 'chats.update', chat.id, { title: 'Projeto compartilhado ✓' })
      await waitFor(
        async () => (await api(A, 'chats.get', chat.id))?.title === 'Projeto compartilhado ✓',
        10_000,
        'A recebe o título'
      )
    }
  )

  await step(
    'controle remoto: envio do composer de B executa no host A; stream ao vivo em B',
    async () => {
      await openChatUi(B, 'Projeto compartilhado')
      // o host é só um ícone na barra do composer (nada no cabeçalho); o popover tem as ações
      const ind = B.page.getByTestId('composer-toolbar').getByTestId('host-indicator')
      await ind.waitFor()
      assert((await ind.getAttribute('data-mode')) === 'remote', 'ícone remoto')
      const label = (await ind.getAttribute('aria-label')) ?? ''
      assert(/Executando em PC de casa/.test(label), `ícone do host: ${label}`)
      assert(
        (await B.page.getByRole('banner').getByText('Executando em').count()) === 0,
        'nada de host no cabeçalho'
      )
      await ind.click()
      const pop = B.page.getByTestId('host-popover')
      await pop.waitFor()
      const title = await pop.getByTestId('host-popover-title').innerText()
      assert(/Controle remoto de PC de casa/.test(title), `popover: ${title}`)
      await pop.getByTestId('host-takeover').waitFor()
      await shot(B, '04b-host-remoto-popover')
      await B.page.keyboard.press('Escape')
      const localInd = A.page.getByTestId('composer-toolbar').getByTestId('host-indicator')
      // A ainda está no onboarding (o provedor foi criado pela API): recarrega para ver os chats
      await A.page.reload()
      await A.page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
      await A.page.evaluate(() => {
        const w = window as any
        w.__ev = []
        w.api.onEvent((e: unknown) => w.__ev.push(e))
      })
      await A.page.getByTestId('chat-item').first().waitFor({ timeout: 15_000 })
      await openChatUi(A, 'Projeto compartilhado')
      await localInd.waitFor()
      assert((await localInd.getAttribute('data-mode')) === 'local', 'ícone local em A')
      await localInd.click()
      const popA = A.page.getByTestId('host-popover')
      await popA.waitFor()
      assert(
        /Executando em PC de casa/.test(await popA.getByTestId('host-popover-title').innerText()),
        'popover local'
      )
      await shot(A, '04c-host-local-popover')
      await A.page.keyboard.press('Escape')
      const n0 = hits.length
      const box = B.page.locator('[data-testid="composer-column"] textarea')
      await box.fill('responda devagar, por favor')
      await box.press('Enter')
      // o draft do host chega ao vivo em B (antes da mensagem persistida)
      await waitFor(
        async () =>
          (await events(B)).some(
            (e) => e.type === 'draft' && e.draft?.content?.includes('chegando')
          ),
        15_000,
        'draft ao vivo em B'
      ).catch(async (e) => {
        const ev = (await events(B))
          .map((x) => x.type)
          .slice(-40)
          .join(',')
        throw new Error(
          `${e.message} | A=${JSON.stringify(await texts(A, chat.mainSessionId))} | B ev=${ev} | conns=${JSON.stringify(srv.connections(srv.userIdOf(EMAIL)!))}`
        )
      })
      await shot(B, '05-controle-remoto-ao-vivo')
      assert(hits.length > n0, 'o modelo foi chamado (no host)')
      await waitFor(
        async () =>
          (await texts(A, chat.mainSessionId)).some((t) => t.includes('controle remoto.')),
        20_000,
        'host terminou'
      )
      await waitFor(
        async () =>
          (await texts(B, chat.mainSessionId)).some((t) => t.includes('controle remoto.')),
        15_000,
        'B recebe a resposta persistida'
      )
      const aMsgs = await texts(A, chat.mainSessionId)
      assert(aMsgs.includes('responda devagar, por favor'), 'a mensagem de B foi executada em A')
      await shot(B, '06-controle-remoto-concluido')
    }
  )

  let sender: any = null
  const sendTool = async (i: Inst, sid: string): Promise<any> => {
    const t = await waitFor(
      async () =>
        (await api<any[]>(i, 'sessions.messages', sid))
          .filter((m) => m.message.role === 'tool')
          .at(-1),
      15_000,
      'resultado do send_to_chat'
    )
    await waitFor(
      async () => (await texts(i, sid)).some((x) => x.startsWith('FIM:')),
      15_000,
      'turno do remetente terminou'
    )
    return t
  }

  await step(
    'send_to_chat de B para um chat executado em A vira comando remoto (nada local em B)',
    async () => {
      sender = await api(B, 'chats.create', {
        title: 'Remetente',
        config: { providerId, model: 'fake/agent', cwd: BASE, enabledTools: ['send_to_chat'] }
      })
      const before = (await texts(B, chat.mainSessionId)).length
      await api(
        B,
        'agent.send',
        sender.mainSessionId,
        `mande para o chat ${chat.id}: oi do remetente`
      )
      const t = await sendTool(B, sender.mainSessionId)
      const content = textOf(t.message.content)
      assert(
        t.meta.toolStatus === 'ok' && /outro dispositivo \(PC de casa\)/.test(content),
        `resultado: ${t.meta.toolStatus} ${content}`
      )
      // executado no host A (a resposta do modelo vem de A) e sincronizado de volta para B
      await waitFor(
        async () =>
          (await texts(A, chat.mainSessionId)).some((x) => x.startsWith('ok: [Mensagem do chat')),
        20_000,
        'A executou a mensagem entre chats'
      )
      await settled(A)
      await waitFor(
        async () =>
          (await texts(B, chat.mainSessionId)).some((x) => x.startsWith('ok: [Mensagem do chat')),
        15_000,
        'B recebe o turno de A'
      )
      // protocolo 1.6.0: o host grava a mensagem com a origem (meta inter-chat), não como digitada
      const inter = (await api<any[]>(A, 'sessions.messages', chat.mainSessionId)).find(
        (m) => m.meta.kind === 'inter-chat' && textOf(m.message.content).includes('oi do remetente')
      )
      assert(
        inter &&
          inter.meta.fromChatId === sender.id &&
          inter.meta.fromSessionId === sender.mainSessionId &&
          inter.meta.fromChatTitle === 'Remetente' &&
          inter.meta.interChatHops === 1,
        `meta no host: ${JSON.stringify(inter?.meta)}`
      )
      const h = await hostInfo(B, chat.id)
      assert(h?.mode === 'remote' && !h.diverged, `B segue controle remoto: ${JSON.stringify(h)}`)
      const after = await texts(B, chat.mainSessionId)
      assert(
        after.length === before + 2,
        `uma mensagem + uma resposta (${before} → ${after.length})`
      )
      await settled(B)
      return content.slice(0, 90)
    }
  )

  await step('aprovação pedida no host aparece e é respondida no controle remoto', async () => {
    toolChat = await api(A, 'chats.create', {
      title: 'Chat com terminal',
      config: { providerId, model: 'fake/agent', cwd: BASE, enabledTools: ['shell'] }
    })
    await api(A, 'agent.send', toolChat.mainSessionId, 'primeira')
    await waitFor(
      async () => (await texts(B, toolChat.mainSessionId)).length >= 2,
      15_000,
      'B tem o chat com terminal'
    )
    await openChatUi(B, 'Chat com terminal')
    await api(B, 'agent.send', toolChat.mainSessionId, 'rode o comando, por favor')
    const req = await waitFor(
      async () =>
        (await api<any[]>(B, 'agent.pendingApprovals')).find((a) => a.chatId === toolChat.id),
      15_000,
      'aprovação espelhada em B'
    )
    assert(req.toolName === 'shell', 'pedido do shell')
    await shot(B, '06b-aprovacao-remota')
    await api(B, 'agent.approve', req.id, 'allow')
    await waitFor(
      async () =>
        (await texts(B, toolChat.mainSessionId)).some(
          (t) => t.startsWith('FIM:') && t.includes('remoto-ok')
        ),
      20_000,
      'comando rodou no host e o resultado voltou'
    )
    assert(
      (await api<any[]>(A, 'agent.pendingApprovals')).length === 0,
      'aprovação resolvida no host'
    )
    await settled(A)
    return 'shell executado em A com a aprovação dada em B'
  })

  await step(
    'push: turno vindo do "celular" (B com token) → aprovação na hora, dismiss e resposta para ele',
    async () => {
      const kPush = pushKey(dek)
      const plain = (p: any): any =>
        unframeJson(open(kPush, aadPush(userId, p.kind, p.tag), p.env)) as any
      const sa = await status(A)
      assert(
        sa.push?.available === true && sa.push?.enabled === true,
        `status.push de A: ${JSON.stringify(sa.push)}`
      )
      const bId = (await status(B)).device.id
      const aId = (await status(A)).device.id
      assert(
        srv.pushes.filter((p) => p.fromDeviceId === aId).length === 0,
        `sem avisos antes (PC presente, sem celular): ${JSON.stringify(srv.pushes)}`
      )
      // B passa a ser "celular": tem token de push (GET /devices → push: true). O host relê a lista
      // de aparelhos a cada comando de turno, no máximo a cada 5 s (B mandou um há pouco)
      srv.setPushToken(bId, 'tok-celular-b')
      await sleep(5500)
      const n0 = srv.pushes.length
      try {
        return await phoneTurn(n0, bId, aId, plain)
      } catch (e) {
        // não deixa a aprovação pendurada para os passos seguintes
        for (const a of await api<any[]>(B, 'agent.pendingApprovals'))
          if (a.chatId === toolChat.id) await api(B, 'agent.approve', a.id, 'allow').catch(() => {})
        throw e
      } finally {
        srv.setPushToken(bId, null)
      }
    }
  )

  async function phoneTurn(
    n0: number,
    bId: string,
    aId: string,
    plain: (p: any) => any
  ): Promise<string> {
    {
      await api(B, 'agent.send', toolChat.mainSessionId, 'rode o comando, por favor')
      const req = await waitFor(
        async () =>
          (await api<any[]>(B, 'agent.pendingApprovals')).find((a) => a.chatId === toolChat.id),
        15_000,
        'aprovação espelhada em B'
      )
      const ap = await waitFor(
        async () => srv.pushes.slice(n0).find((p) => p.kind === 'approval'),
        10_000,
        'aviso de aprovação'
      )
      assert(ap.fromDeviceId === aId, 'enviado pelo host A')
      assert(
        JSON.stringify(ap.to) === JSON.stringify([bId]),
        `só para o celular: ${JSON.stringify(ap.to)}`
      )
      const pa = plain(ap)
      assert(
        pa.kind === 'approval' &&
          pa.chatId === toolChat.id &&
          pa.chatTitle === 'Chat com terminal' &&
          pa.text === 'Executar: expr remoto-ok' &&
          pa.requestId === req.id &&
          pa.hostName === 'PC de casa',
        `payload da aprovação: ${JSON.stringify(pa)}`
      )
      await api(B, 'agent.approve', req.id, 'allow')
      const dm = await waitFor(
        async () => srv.pushes.slice(n0).find((p) => p.kind === 'dismiss'),
        10_000,
        'dismiss da aprovação'
      )
      assert(dm.tag === ap.tag && dm.env === null, 'dismiss com a mesma tag, sem conteúdo')
      assert(JSON.stringify(dm.to) === JSON.stringify([bId]), 'dismiss para o celular')
      const rp = await waitFor(
        async () => srv.pushes.slice(n0).find((p) => p.kind === 'reply'),
        20_000,
        'aviso de resposta pronta'
      )
      const pr = plain(rp)
      assert(
        JSON.stringify(rp.to) === JSON.stringify([bId]) &&
          pr.kind === 'reply' &&
          pr.text.startsWith('FIM:') &&
          pr.text.includes('remoto-ok') &&
          pr.sessionId === toolChat.mainSessionId,
        `reply: ${JSON.stringify(rp.to)} ${JSON.stringify(pr)}`
      )
      // turno local em A (PC presente, sem origem móvel): nenhum aviso novo
      const n1 = srv.pushes.length
      await api(A, 'agent.send', toolChat.mainSessionId, 'só uma pergunta local')
      await waitFor(
        async () =>
          (await texts(A, toolChat.mainSessionId)).some((t) => t.includes('só uma pergunta local')),
        15_000,
        'turno local'
      )
      await settled(A)
      await sleep(1000)
      assert(
        srv.pushes.length === n1,
        `turno local não avisa: ${JSON.stringify(srv.pushes.slice(n1))}`
      )
      await settled(B)
      return `aprovação/dismiss/reply para o celular (${srv.pushes.length - n0} avisos)`
    }
  }

  await step(
    'controle remoto: texto antes da tool call fica na tela até a mensagem gravada; status ao vivo ao sair do chat',
    async () => {
      await openChatUi(B, 'Chat com terminal')
      const ev0 = (await events(B)).length
      await api(B, 'agent.send', toolChat.mainSessionId, 'explique e rode o comando')
      const req = await waitFor(
        async () =>
          (await api<any[]>(B, 'agent.pendingApprovals')).find((a) => a.chatId === toolChat.id),
        20_000,
        'aprovação espelhada em B'
      )
      // a mensagem do assistente (texto + tool call) chega pelo sync
      await waitFor(
        async () =>
          (await events(B))
            .slice(ev0)
            .some(
              (e) =>
                e.type === 'message-added' &&
                e.message.message.role === 'assistant' &&
                textOf(e.message.message.content).includes('Vou rodar')
            ),
        15_000,
        'mensagem do assistente em B'
      )
      const ev = (await events(B)).slice(ev0)
      const sid = toolChat.mainSessionId
      const iText = ev.findIndex(
        (e) => e.type === 'draft' && e.sessionId === sid && e.draft?.content?.includes('Vou rodar')
      )
      const iMsg = ev.findIndex(
        (e) =>
          e.type === 'message-added' &&
          e.message.message.role === 'assistant' &&
          textOf(e.message.message.content).includes('Vou rodar')
      )
      assert(iText >= 0 && iText < iMsg, `draft ao vivo antes da mensagem (${iText} < ${iMsg})`)
      const gap = ev
        .slice(iText, iMsg)
        .filter((e) => e.type === 'draft' && e.sessionId === sid && !e.draft?.content)
      assert(!gap.length, `o texto sumiu antes da mensagem chegar (${gap.length} draft vazio)`)
      await B.page.getByText('Vou rodar o comando agora.').first().waitFor()
      await shot(B, '06c-texto-antes-da-tool-call')
      // sair do chat com o turno parado na aprovação: continua "executando" na barra lateral
      const item = B.page.locator('[data-testid="chat-item"]', { hasText: 'Chat com terminal' })
      await openChatUi(B, 'Projeto compartilhado')
      await sleep(800)
      assert(
        (await item.getByTestId('chat-running').count()) === 1,
        'chat remoto em andamento segue com o ponto de "executando"'
      )
      await shot(B, '06d-status-fora-do-chat')
      // voltar: o status (aguardando aprovação) e o pedido continuam
      await openChatUi(B, 'Chat com terminal')
      await B.page.getByTestId('composer-status').waitFor({ timeout: 10_000 })
      await api(B, 'agent.approve', req.id, 'allow')
      await waitFor(
        async () =>
          (await texts(B, toolChat.mainSessionId)).filter((t) => t.startsWith('FIM:')).length >= 2,
        20_000,
        'resultado voltou'
      )
      await waitFor(
        async () => (await item.getByTestId('chat-running').count()) === 0,
        15_000,
        'fim do turno apaga o ponto'
      )
      await settled(A)
    }
  )

  let aDevice = ''
  await step(
    'host offline: "o dispositivo remoto caiu", composer desabilitado, assumir com aviso',
    async () => {
      aDevice = (await status(A)).device.id
      await openChatUi(B, 'Chat com terminal')
      srv.setRefuseConnections(aDevice, true)
      srv.dropDevice(aDevice)
      await B.page.getByTestId('host-offline').waitFor({ timeout: 15_000 })
      await waitFor(
        async () => (await events(B)).some((e) => e.type === 'sync-notice' && /caiu/.test(e.text)),
        10_000,
        'aviso caiu'
      )
      await B.page.getByTestId('host-notice').waitFor({ timeout: 5_000 })
      await shot(B, '07-host-offline')
      let err = ''
      try {
        await api(B, 'agent.send', toolChat.mainSessionId, 'não deve ir')
      } catch (e) {
        err = (e as Error).message
      }
      assert(/offline/.test(err), `envio recusado com host offline: ${err}`)
      if (sender) {
        // send_to_chat para um chat cujo host caiu: recusa (entregar em B criaria divergência)
        const n = (await texts(B, chat.mainSessionId)).length
        await api(B, 'agent.send', sender.mainSessionId, `mande para o chat ${chat.id}: vai falhar`)
        await waitFor(
          async () =>
            (await texts(B, sender.mainSessionId)).some((x) => /^FIM: Erro: não foi/.test(x)),
          15_000,
          'send_to_chat recusado'
        )
        const t = (await api<any[]>(B, 'sessions.messages', sender.mainSessionId))
          .filter((m) => m.message.role === 'tool')
          .at(-1)
        assert(
          t.meta.toolStatus === 'error' && /offline/.test(textOf(t.message.content)),
          `recusa: ${textOf(t.message.content)}`
        )
        assert((await texts(B, chat.mainSessionId)).length === n, 'nada entregue localmente')
      }
      await B.page.getByTestId('host-offline-takeover').click()
      await B.page.getByTestId('takeover-dialog').waitFor()
      const txt = await B.page.getByTestId('takeover-dialog').innerText()
      assert(/ferramentas locais/.test(txt), 'aviso forte de ferramentas locais')
      await shot(B, '08-assumir-aviso')
      await B.page.getByTestId('takeover-confirm').click()
      await waitFor(
        async () => (await hostInfo(B, toolChat.id))?.host?.self,
        10_000,
        'B virou host'
      )
      await api(B, 'agent.send', toolChat.mainSessionId, 'agora no notebook')
      await waitFor(
        async () => (await texts(B, toolChat.mainSessionId)).includes('ok: agora no notebook'),
        15_000,
        'B executou localmente'
      )
      await settled(B)
    }
  )

  await step('A volta: vira controle remoto; troca forçada devolve o host para A', async () => {
    srv.setRefuseConnections(aDevice, false)
    await waitFor(
      async () => (await hostInfo(A, toolChat.id))?.mode === 'remote',
      20_000,
      'A é controle remoto'
    )
    await waitFor(
      async () => (await texts(A, toolChat.mainSessionId)).includes('ok: agora no notebook'),
      15_000,
      'A recebe o que B rodou'
    )
    // B começa um turno lento e A força a troca no meio
    await api(B, 'agent.send', toolChat.mainSessionId, 'devagar de novo')
    await sleep(900)
    const info = await api(A, 'sync.takeover', toolChat.id, { mode: 'force' })
    assert(info.host?.self || info.handover?.self, 'troca pedida')
    await waitFor(
      async () => (await hostInfo(A, toolChat.id))?.host?.self,
      25_000,
      'A virou host (forçado)'
    )
    await waitFor(
      async () => (await hostInfo(B, toolChat.id))?.mode === 'remote',
      15_000,
      'B virou controle remoto'
    )
    await settled(B)
    await settled(A)
  })

  await step(
    'arquivos do host: B navega na aba Arquivos de A e abre arquivos (fs.list / fs.read cifrados)',
    async () => {
      // A é o host do "Chat com terminal" (raiz = BASE no disco de A); B é controle remoto
      const dir = join(BASE, 'remoto')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'relatorio.md'), '# Relatório do host\n\nGerado no PC de casa.\n')
      writeFileSync(
        join(dir, 'pixel.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64'
        )
      )
      writeFileSync(join(dir, 'grande.bin'), Buffer.alloc(1_200_000, 7))
      const list = await api(B, 'sync.remoteListDir', toolChat.id, '')
      assert(list.ok && list.root === BASE && list.confine === true, JSON.stringify(list))
      assert(
        list.entries.some((e: any) => e.name === 'remoto' && e.kind === 'dir'),
        'raiz do host listada'
      )
      const out = await api(B, 'sync.remoteListDir', toolChat.id, '..')
      assert(!out.ok && out.reason === 'denied', `fora da raiz negado: ${JSON.stringify(out)}`)
      // pedaços: o resultado chega como bytes (Uint8Array) pelo IPC
      const chunk = await B.page.evaluate(
        async ([id, p]) => {
          const r = await (window as any).api.sync.remoteReadFile(id, p, 0, 4 * 1024 * 1024)
          return r.ok
            ? { ok: true, len: r.data.length, typed: r.data instanceof Uint8Array, size: r.size }
            : r
        },
        [toolChat.id, join(dir, 'grande.bin')] as const
      )
      assert(
        chunk.ok && chunk.typed && chunk.len === 512 * 1024 && chunk.size === 1_200_000,
        `pedaço de 512 KiB: ${JSON.stringify(chunk)}`
      )
      // UI: aba Arquivos de B mostra a raiz do host e abre no painel por blob URL
      await openChatUi(B, 'Chat com terminal')
      if (!(await B.page.getByRole('tab', { name: 'Arquivos' }).count()))
        await B.page.getByRole('button', { name: 'Abrir painel' }).click()
      await B.page.getByRole('tab', { name: 'Arquivos' }).click()
      const panel = B.page.getByTestId('right-panel')
      await panel.getByTestId('files-remote').waitFor({ timeout: 10_000 })
      await panel.getByTestId('files-entry').filter({ hasText: 'remoto' }).click()
      await panel.getByTestId('files-entry').filter({ hasText: 'relatorio.md' }).click()
      const viewer = B.page.getByTestId('file-viewer')
      await viewer.locator('.md h1').filter({ hasText: 'Relatório do host' }).waitFor({
        timeout: 15_000
      })
      const labels = await viewer
        .locator('button[aria-label]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
      assert(labels.includes('Salvar como…'), `Salvar como… (${labels.join(', ')})`)
      assert(!labels.includes('Mostrar na pasta'), 'sem Mostrar na pasta')
      await panel.getByTestId('files-entry').filter({ hasText: 'pixel.png' }).click()
      const img = viewer.getByTestId('viewer-image')
      await img.waitFor({ timeout: 15_000 })
      const loaded = await img.evaluate(async (el: HTMLImageElement) => {
        if (!el.complete) await new Promise((r) => el.addEventListener('load', r, { once: true }))
        return { src: el.src.slice(0, 5), w: el.naturalWidth }
      })
      assert(
        loaded.src === 'blob:' && loaded.w === 1,
        `imagem por blob: (CSP): ${JSON.stringify(loaded)}`
      )
      await shot(B, 'arquivos-do-host')
      return `raiz do host ${list.root}`
    }
  )

  await step(
    'divergência: B roda offline, A roda online → divergente; B mantém a sua; A recebe',
    async () => {
      const bDevice = (await status(B)).device.id
      srv.setRefuseConnections(bDevice, true)
      srv.dropDevice(bDevice)
      await waitFor(
        async () => (await hostInfo(B, chat.id))?.mode === 'offline',
        10_000,
        'B offline'
      )
      await api(B, 'agent.send', chat.mainSessionId, 'versão offline do notebook')
      await waitFor(
        async () => (await texts(B, chat.mainSessionId)).includes('ok: versão offline do notebook'),
        15_000,
        'B rodou offline'
      )
      await api(A, 'agent.send', chat.mainSessionId, 'versão online do PC')
      await waitFor(
        async () => (await texts(A, chat.mainSessionId)).includes('ok: versão online do PC'),
        15_000,
        'A rodou'
      )
      await settled(A)
      srv.setRefuseConnections(bDevice, false)
      await waitFor(
        async () => (await hostInfo(B, chat.id))?.diverged?.self,
        25_000,
        'B vê a divergência'
      ).catch(async (e) => {
        throw new Error(
          `${e.message} | B=${JSON.stringify(await hostInfo(B, chat.id))} | Bst=${JSON.stringify(await status(B))} | A=${JSON.stringify(await hostInfo(A, chat.id))} | srv=${JSON.stringify(srv.chatState(srv.userIdOf(EMAIL)!, chat.id))} | Btexts=${JSON.stringify(await texts(B, chat.mainSessionId))}`
        )
      })
      await waitFor(
        async () => (await hostInfo(A, chat.id))?.diverged,
        10_000,
        'A vê a divergência'
      )
      await openChatUi(B, 'Projeto compartilhado')
      await B.page.getByTestId('divergence-panel').waitFor()
      await B.page.getByTestId('divergence-tab-local').click()
      await shot(B, '09-divergencia')
      await B.page.getByTestId('divergence-keep').click()
      await B.page.getByTestId('divergence-warning').waitFor()
      const warn = await B.page.getByTestId('divergence-warning').innerText()
      assert(/será apagada/.test(warn) && /mensage/.test(warn), `aviso de descarte: ${warn}`)
      await shot(B, '10-divergencia-aviso')
      await B.page.getByTestId('divergence-confirm').click()
      await waitFor(async () => !(await hostInfo(A, chat.id))?.diverged, 15_000, 'resolvida em A')
      await waitFor(
        async () => {
          const t = await texts(A, chat.mainSessionId)
          return (
            t.includes('ok: versão offline do notebook') && !t.includes('ok: versão online do PC')
          )
        },
        15_000,
        'A tem a versão de B (a online foi descartada)'
      )
    }
  )

  await step(
    'skills opt-in: A sincroniza uma skill; B baixa sob pedido e recebe a atualização',
    async () => {
      mkdirSync(join(skillsDir, 'demo'), { recursive: true })
      writeFileSync(
        join(skillsDir, 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: Skill de teste\n---\nversão 1\n'
      )
      await api(A, 'skills.updateSettings', {
        locations: [{ id: 'l1', path: skillsDir, enabled: true }]
      })
      await api(A, 'skills.discover', { rescan: true })
      await api(A, 'sync.setSkillSync', 'demo', true)
      await settled(A)
      const cloud = await waitFor(
        async () => {
          const l = await api<any[]>(B, 'sync.cloudSkills')
          return l.find((s) => s.name === 'demo') && l
        },
        15_000,
        'B vê a skill na nuvem'
      )
      assert(
        cloud.find((s: any) => s.name === 'demo').local === null,
        'não baixada automaticamente'
      )
      await api(B, 'sync.downloadSkills', ['demo'])
      const file = join(B.dir, 'synced-skills', 'demo', 'SKILL.md')
      assert(existsSync(file) && readFileSync(file, 'utf8').includes('versão 1'), 'B baixou')
      writeFileSync(
        join(skillsDir, 'demo', 'SKILL.md'),
        '---\nname: demo\ndescription: Skill de teste\n---\nversão 2\n'
      )
      await api(A, 'skills.discover', { rescan: true })
      await waitFor(
        async () => readFileSync(file, 'utf8').includes('versão 2'),
        20_000,
        'B recebeu a atualização'
      )
    }
  )

  await step('anexos: imagem enviada em A é baixada em B sob demanda (blob cifrado)', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    const info = await A.page.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      return (window as any).api.attachments.add({ name: 'pixel.png', mime: 'image/png', data })
    }, png.toString('base64'))
    const c = await api(A, 'chats.create', {
      title: 'Com anexo',
      config: { providerId, model: 'fake/agent', cwd: BASE, enabledTools: [] }
    })
    await api(A, 'agent.send', c.mainSessionId, 'veja a imagem', [info])
    await settled(A)
    await waitFor(
      async () => (await api<any[]>(B, 'sessions.messages', c.mainSessionId)).length >= 2,
      15_000,
      'B recebeu a mensagem'
    )
    assert(!existsSync(join(B.dir, 'attachments', info.file)), 'ainda não baixado em B')
    const w = await B.page.evaluate(
      (f) =>
        new Promise<number>((done) => {
          const img = new Image()
          img.onload = () => done(img.naturalWidth)
          img.onerror = () => done(-1)
          img.src = `clearchat-attachment://${f}`
        }),
      info.file
    )
    assert(w === 1, `B baixou e exibiu o anexo (${w})`)
    assert(existsSync(join(B.dir, 'attachments', info.file)), 'gravado no store de B')
  })

  await step(
    'preferências (protocolo 1.4.0): padrões do Smart-Approve, título automático e spill de A chegam em B; aviso dispensado fica local',
    async () => {
      const cur = await api<any>(A, 'approvals.getSettings')
      await api(A, 'approvals.updateSettings', {
        smart: {
          ...cur.smart,
          environment: 'Ambiente vindo do PC: 10.0.0.5 é teste',
          acceptEditsInRoot: true,
          capture: {
            enabled: true,
            providerId,
            model: 'fake/resumo',
            maxTokens: null,
            lookback: 3
          },
          capturePrompts: {
            prompt: 'PROMPT DO PC KEEP APPEND REWRITE',
            template: null,
            derivePrompt: null
          }
        }
      })
      await api(A, 'settings.set', 'autoTitle', {
        providerId,
        model: 'fake/titulo',
        useMemory: true,
        maxTokens: 48,
        prompt: 'Título do PC.'
      })
      await api(A, 'settings.set', 'toolOutputSpillChars', 25_000)
      await api(A, 'settings.set', 'updateDismissedVersion', '99.0.0')
      await settled(A)
      const smartB = await waitFor(
        async () => {
          const st = await api<any>(B, 'approvals.getSettings')
          return st.smart.environment.startsWith('Ambiente vindo do PC') && st.smart
        },
        15_000,
        'B recebeu os padrões globais'
      )
      assert(smartB.acceptEditsInRoot === true, 'aceitar edições')
      assert(smartB.capture.providerId === providerId && smartB.capture.lookback === 3, 'coleta')
      assert(
        smartB.capturePrompts.prompt === 'PROMPT DO PC KEEP APPEND REWRITE',
        'prompts do resumidor'
      )
      const titleB = await waitFor(
        async () =>
          (await api<any>(B, 'settings.get', 'autoTitle'))?.model === 'fake/titulo' &&
          api<any>(B, 'settings.get', 'autoTitle'),
        15_000,
        'B recebeu o título automático'
      )
      assert(
        titleB.providerId === providerId && titleB.prompt === 'Título do PC.',
        'autoTitle inteiro'
      )
      await waitFor(
        async () => (await api<any>(B, 'settings.get', 'toolOutputSpillChars')) === 25_000,
        15_000,
        'B recebeu o spill'
      )
      assert(
        (await api<any>(B, 'settings.get', 'updateDismissedVersion')) !== '99.0.0',
        'aviso dispensado é local'
      )
      // a UI de B recarregou (Configurações → Aprovações mostra o ambiente novo)
      await B.page.keyboard.press('Control+,')
      await B.page
        .getByRole('dialog')
        .getByRole('button', { name: 'Aprovações', exact: true })
        .click()
      const env = B.page.getByRole('textbox', { name: 'Descrição do ambiente global' })
      await waitFor(
        async () => (await env.inputValue()).startsWith('Ambiente vindo do PC'),
        10_000,
        'UI de B atualizada'
      )
      await B.page.keyboard.press('Escape')
      // e de volta: B muda o ambiente → A
      await api(B, 'approvals.updateSettings', {
        smart: { ...smartB, environment: 'editado no notebook' }
      })
      await waitFor(
        async () =>
          (await api<any>(A, 'approvals.getSettings')).smart.environment === 'editado no notebook',
        15_000,
        'A recebeu a edição de B'
      )
    }
  )

  await step(
    'áudio (protocolo 1.5.0): settings de voz, provedor ElevenLabs, voz do chat, ditado e marcadores da chamada de A chegam em B; o microfone fica local',
    async () => {
      const xi = (
        await api(A, 'providers.create', {
          name: 'ElevenLabs',
          baseUrl: 'https://api.elevenlabs.io',
          apiKey: 'xi-fake-1',
          kind: 'elevenlabs'
        })
      ).id
      const cur = await api<any>(A, 'voice.settings.get')
      await api(A, 'voice.settings.set', 'audioInput', {
        ...cur.audioInput,
        deviceId: 'microfone-do-pc',
        language: 'es-ES',
        silenceStopMs: 3200
      })
      await api(A, 'voice.settings.set', 'ttsSettings', {
        ...cur.ttsSettings,
        backend: 'api',
        api: {
          providerId: xi,
          model: 'eleven_flash_v2_5',
          voice: 'voz-do-pc',
          // parâmetros do modelo remoto (preferência — sincroniza; os da GPU não)
          params: { elevenlabs: { output_format: 'pcm_16000', stability: 0.4, speed: 1.1 } }
        }
      })
      await api(A, 'voice.settings.set', 'voiceCallDefaults', {
        ...cur.voiceCallDefaults,
        endCall: false
      })
      // conteúdo de voz no chat que A hospeda: ditado + chamada (marcadores de início/fim)
      await api(A, 'agent.send', chat.mainSessionId, 'texto ditado no PC', [], [], {
        voice: { source: 'dictation', durationMs: 2100 }
      })
      await waitFor(
        async () => (await texts(A, chat.mainSessionId)).includes('ok: texto ditado no PC'),
        15_000,
        'A respondeu ao ditado'
      )
      await api(A, 'voice.call.start', { sessionId: chat.mainSessionId })
      await sleep(400)
      await api(A, 'voice.call.stop')
      const markersOf = async (i: Inst): Promise<any[]> =>
        (await api<any[]>(i, 'sessions.messages', chat.mainSessionId)).filter(
          (m) => m.meta?.kind === 'voice-call'
        )
      await waitFor(async () => (await markersOf(A)).length >= 2, 10_000, 'marcadores em A')
      // voz do chat (chamada desligada neste chat) — depois da chamada
      await api(A, 'chats.update', chat.id, {
        config: {
          voice: {
            enabled: false,
            model: null,
            tools: null,
            voicePrompt: 'fale como no PC',
            fillers: null,
            interjections: null
          }
        }
      })
      await settled(A)

      const vB = await waitFor(
        async () => {
          const v = await api<any>(B, 'voice.settings.get')
          return v.ttsSettings.api.providerId === xi && v.voiceCallDefaults.endCall === false && v
        },
        15_000,
        'B recebeu as settings de voz'
      )
      assert(vB.ttsSettings.backend === 'api' && vB.ttsSettings.api.voice === 'voz-do-pc', 'fala')
      assert(
        JSON.stringify(vB.ttsSettings.api.params) ===
          JSON.stringify({
            elevenlabs: { output_format: 'pcm_16000', stability: 0.4, speed: 1.1 }
          }),
        `parâmetros do modelo remoto em B: ${JSON.stringify(vB.ttsSettings.api.params)}`
      )
      assert(vB.audioInput.language === 'es-ES' && vB.audioInput.silenceStopMs === 3200, 'ditado')
      assert(vB.audioInput.deviceId !== 'microfone-do-pc', 'o microfone de A não chega em B')
      const provB = (await api<any[]>(B, 'providers.list')).find((p) => p.id === xi)
      assert(provB?.kind === 'elevenlabs' && provB.apiKey === 'xi-fake-1', 'provedor de voz')
      await waitFor(
        async () => (await api<any>(B, 'chats.get', chat.id))?.config?.voice?.enabled === false,
        15_000,
        'B recebeu a voz do chat'
      )
      await waitFor(async () => (await markersOf(B)).length >= 2, 15_000, 'marcadores em B')
      const msgsB = await api<any[]>(B, 'sessions.messages', chat.mainSessionId)
      const dict = msgsB.find((m) => textOf(m.message.content) === 'texto ditado no PC')
      assert(dict?.meta?.voice?.source === 'dictation', 'meta.voice do ditado')
      const marks = await markersOf(B)
      assert(
        marks.some((m) => m.meta.voiceCall?.phase === 'start') &&
          marks.some((m) => m.meta.voiceCall?.phase === 'end' && m.meta.voiceCall.usage),
        'início e fim (com custos)'
      )

      // UI de B: Configurações → Áudio mostra o silêncio vindo do PC
      await B.page.keyboard.press('Control+,')
      await B.page.getByRole('dialog').getByRole('button', { name: 'Áudio', exact: true }).click()
      const silence = B.page.getByLabel('Silêncio que encerra a gravação (ms)')
      await waitFor(
        async () => (await silence.inputValue()) === '3200',
        10_000,
        'Áudio de B atualizado'
      )
      await shot(B, '12-audio-sincronizado')
      await B.page.keyboard.press('Escape')
      // chat em B: marcadores e selo de ditado; aba Voz do painel com a chamada desligada
      await openChatUi(B, 'Projeto compartilhado')
      await B.page.getByTestId('call-marker').first().waitFor({ timeout: 10_000 })
      assert((await B.page.getByTestId('call-marker').count()) >= 2, 'dois marcadores na tela')
      await B.page.getByTestId('voice-badge').first().waitFor({ timeout: 10_000 })
      if (!(await B.page.getByTestId('right-panel').isVisible()))
        await B.page.getByRole('banner').getByRole('button', { name: 'Abrir painel' }).click()
      await B.page.getByTestId('right-panel').getByRole('tab', { name: 'Voz' }).click()
      const enabled = B.page.getByTestId('right-panel').getByTestId('voice-call-enabled')
      await enabled.waitFor()
      assert((await enabled.getAttribute('data-effective')) === 'off', 'chamada desligada no chat')
      await shot(B, '13-voz-do-chat-sincronizada')
      await B.page.getByRole('banner').getByRole('button', { name: 'Fechar painel' }).click()
    }
  )

  await step('Configurações → Conta (screenshot) e dispositivos', async () => {
    await B.page.keyboard.press('Control+,')
    await B.page.getByRole('button', { name: 'Conta' }).click()
    await B.page.getByTestId('account-tab').waitFor()
    await sleep(800)
    await shot(B, '11-conta')
    const devs = await api<any[]>(B, 'sync.devices')
    assert(devs.length === 2 && devs.some((d) => d.current), 'dois dispositivos')
    await B.page.keyboard.press('Escape')
  })

  await step(
    'captcha: instância com Turnstile → janela do captcha → token → código enviado',
    async () => {
      const srv2 = await startFakeSyncServer({ captcha: true, name: 'Com captcha' })
      const email2 = 'captcha@teste.dev'
      await srv2.createAccount({ email: email2, password: PASSWORD })
      const C = await launch('Com captcha', join(BASE, 'c'), srv2.url)
      try {
        const info = await api(C, 'sync.probeServer')
        assert(info.captcha === true, 'features.captcha')
        await api(C, 'sync.requestCode', email2)
        assert(!!srv2.lastCode(email2), 'código enviado depois do captcha')
        const req = srv2.requests.find((r) => r.path.endsWith('/auth/code/request'))
        assert(req?.status === 202, 'turnstile_token aceito')
      } finally {
        await C.app.close().catch(() => {})
        await srv2.close()
      }
    }
  )

  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
  console.log(
    `\n${results.length - failed.length}/${results.length} passos ok · screenshots em ${SHOTS}`
  )
  await A.app.close().catch(() => {})
  await B.app.close().catch(() => {})
  await srv.close()
  llm?.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
})
