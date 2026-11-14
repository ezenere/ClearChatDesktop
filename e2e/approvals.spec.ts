/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do modo "Listas" das aprovações na UI real (Playwright + `e2e/launch.ts`), determinístico: um
// provedor OpenAI-compatible FALSO (`fake/agent-1`: "rode: <cmd>" → chama shell com o comando;
// resultado da tool → "FIM: …"). Nenhuma key real, nenhum custo.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/approvals.spec.ts [filtro]
//
// Cobre: card com 2 sub-comandos (um já na whitelist, marcado), "Sim + whitelist" com o campo
// pré-preenchido (`git init *`) editado → salva na lista global, o pendente restante com "Sim" →
// executa; a chamada seguinte com o mesmo padrão roda sem card ("Liberado pela whitelist"); "Não +
// blacklist" → resultado "O usuário negou: …"; depois a blacklist bloqueia sem perguntar;
// decomposição em árvore (ssh com comandos remotos + sudo: card com cabeçalhos "no servidor …",
// "Não" na conexão → nada roda; `rm -rf` remoto bloqueado pela blacklist — host `.invalid`, nada
// é executado); Configurações → Aprovações (modos globais, tabelas e "Testar comando" com ssh).
import type { ElectronApplication, Locator, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { elementShot, pickModel as pickModelIn } from './uiHelpers.ts'

const FAKE_KEY = 'fake-key-approvals'
const AGENT = 'fake/agent-1'
const JUDGE = 'fake/judge-1'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-approvals-e2e'))
const USER_DATA = join(BASE, 'userdata')
const CWD = join(BASE, 'cwd')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''

// ---------------- provedor falso ----------------

interface JudgeReply {
  text: string
  delayMs?: number
}
const judgeQueue: JudgeReply[] = []
const hits: { model: string; body: any }[] = []
let server: Server | null = null
let fakeBase = ''

async function readBody(req: IncomingMessage): Promise<string> {
  let data = ''
  for await (const c of req) data += c
  return data
}

const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : ''

/** Comando pedido na última mensagem do usuário: "rode: <cmd>" ou "Pode executar shell `<cmd>`". */
function commandFrom(text: string): string | null {
  const m = /rode:\s*(.+)$/m.exec(text) ?? /Pode executar shell `([^`]+)`/.exec(text)
  return m ? m[1].trim() : null
}

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [AGENT, JUDGE].map((id) => ({
              id,
              name: id === AGENT ? 'Fake Agent' : 'Fake Judge',
              context_length: 64_000,
              pricing: { prompt: '0.0000001', completion: '0.0000002' },
              supported_parameters: ['tools']
            }))
          })
        )
        return
      }
      if (!(req.method === 'POST' && url.endsWith('/chat/completions'))) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{"error":{"message":"not found"}}')
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push({ model: body.model, body })
      const sse = (deltas: any[], usage: any): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const base = { id: 'f', object: 'chat.completion.chunk', model: body.model }
        for (const d of deltas)
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: d }] })}\n\n`)
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`
        )
        res.end('data: [DONE]\n\n')
      }
      if (body.model === JUDGE) {
        const r = judgeQueue.shift() ?? { text: 'ASK-USER\n(sem roteiro)' }
        const send = (): void => {
          if (res.destroyed) return
          sse([{ role: 'assistant', content: r.text }], {
            prompt_tokens: 400,
            completion_tokens: 12,
            cost: 0.000042
          })
        }
        if (r.delayMs) setTimeout(send, r.delayMs)
        else send()
        return
      }
      // agente: usuário → chama bash com o comando; tool → "FIM: <resultado>"
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      if (last?.role === 'tool') {
        sse([{ role: 'assistant', content: `FIM: ${String(last.content).slice(0, 80)}` }], {
          prompt_tokens: 100,
          completion_tokens: 8
        })
        return
      }
      const cmd = commandFrom(textOf(last?.content))
      if (!cmd) {
        sse([{ role: 'assistant', content: 'Nada a fazer.' }], {
          prompt_tokens: 50,
          completion_tokens: 3
        })
        return
      }
      sse(
        [
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now().toString(36)}`,
                type: 'function',
                function: { name: 'shell', arguments: JSON.stringify({ command: cmd }) }
              }
            ]
          }
        ],
        { prompt_tokens: 100, completion_tokens: 10 }
      )
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
let shotN = 0
let stopped = false
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = USER_DATA
  app = await launchElectron({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(1280, 860)
  })
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any
  }, CWD)
}

async function shot(name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) })
}

async function shotOf(loc: Locator, name: string): Promise<void> {
  // nunca loc.screenshot(): elemento maior que a janela redimensiona a viewport (ver uiHelpers)
  await elementShot(page, loc, join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`))
}

async function read<T = any>(path: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([p, a]) => {
      const fn = (p as string).split('.').reduce((o: any, k) => o[k], (window as any).api)
      return fn(...(a as unknown[]))
    },
    [path, args] as const
  ) as Promise<T>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (stopped) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n')[0]}`)
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

const composer = (): Locator =>
  page.locator('textarea[placeholder="Mensagem…"], textarea[placeholder="Enviar para a fila…"]')
const stopBtn = (): Locator => page.getByRole('button', { name: 'Parar', exact: true })
const bashCards = (): Locator =>
  page.locator('div.rounded-xl').filter({ has: page.locator('span:text-is("Terminal (shell)")') })

async function sendMessage(text: string): Promise<void> {
  const c = composer()
  await c.click()
  await c.fill(text)
  await c.press('Enter')
}

async function waitIdle(ms = 30_000): Promise<void> {
  await sleep(300)
  await stopBtn().waitFor({ state: 'detached', timeout: ms })
}

async function chatState(): Promise<{ chat: any; msgs: any[] }> {
  const chat = (await read<any[]>('chats.list'))[0]
  const msgs = await read<any[]>('sessions.messages', chat.mainSessionId)
  return { chat, msgs }
}

async function pickModel(combobox: Locator, id: string): Promise<void> {
  await pickModelIn(page, combobox, id)
}

const approvalCard = (): Locator => page.getByTestId('approval-card').last()

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(CWD, 'readme.txt'), 'approvals e2e\n')
  await startFake()
  await launch()

  await step('onboarding com o provedor falso', async () => {
    await page.getByText('Bem-vindo ao ClearChat').waitFor({ timeout: 30_000 })
    await page.getByTestId('onboarding-provider').click()
    await page.locator('input.field').nth(0).fill('Local')
    await page.locator('input.field').nth(1).fill(fakeBase)
    await page.locator('input[type="password"]').fill(FAKE_KEY)
    await page.getByRole('button', { name: 'Testar conexão' }).click()
    await page.getByText(/Conexão ok/).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Continuar' }).click()
    await page.getByRole('heading', { name: 'Novo chat' }).waitFor({ timeout: 15_000 })
  })

  await step('novo chat com o agente falso; whitelist inicial "expr *"', async () => {
    await pickModel(page.getByRole('combobox').first(), AGENT)
    await page.getByRole('button', { name: /Alterar/ }).click()
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 15_000 })
    const s = await read<any>('approvals.updateSettings', {
      lists: {
        commands: { allow: ['expr *'], deny: [] },
        processes: { allow: [], deny: [] },
        pages: { allow: [], deny: [] }
      }
    })
    assert(s.modes.commands === 'lists', `modo global ${s.modes.commands}`)
  })

  await step(
    'card com 2 sub-comandos: um liberado (✓), "Sim + whitelist" editado no outro',
    async () => {
      await sendMessage('rode: expr AP-1 && git init -q ap-repo')
      const card = approvalCard()
      await card.waitFor({ timeout: 15_000 })
      const subs = card.getByTestId('approval-sub')
      assert((await subs.count()) === 2, `2 sub-comandos (${await subs.count()})`)
      await subs.nth(0).getByTestId('sub-whitelisted').getByText('expr *').waitFor()
      await subs.nth(1).getByText('git init -q ap-repo').waitFor()
      await card.scrollIntoViewIfNeeded()
      await shotOf(card, 'card-2-subcomandos')
      await subs.nth(1).getByRole('button', { name: 'Sim + whitelist' }).click()
      const input = card.getByRole('textbox', { name: 'Padrão da whitelist' })
      assert(
        (await input.inputValue()) === 'git init *',
        `pré-preenchido ${await input.inputValue()}`
      )
      // padrão amplo → aviso suave
      await input.fill('git *')
      await card.getByTestId('broad-warning').waitFor()
      await shotOf(card, 'card-aviso-amplo')
      await input.fill('git init *')
      await card.getByRole('button', { name: 'Salvar e permitir' }).click()
      await waitIdle()
      const s = await read<any>('approvals.getSettings')
      assert(s.lists.commands.allow.includes('git init *'), `whitelist ${s.lists.commands.allow}`)
      const { msgs } = await chatState()
      const tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
      assert(tool.meta.toolStatus === 'ok' && tool.message.content.includes('AP-1'), 'executou')
      assert(
        tool.meta.approval?.allowed?.[0]?.entry === 'expr *' &&
          tool.meta.approval?.userAllowed?.length === 1,
        `meta ${JSON.stringify(tool.meta.approval)}`
      )
      // aprovada: nada abaixo do card — os detalhes ficam no selo "ok" (tooltip; clique fixa)
      const done = bashCards().last()
      assert((await done.getByTestId('approval-denied-strip').count()) === 0, 'sem faixa')
      const badge = done.getByTestId('approval-badge')
      assert(
        (await badge.getAttribute('data-approved-by')) === 'user lists',
        `quem aprovou: ${await badge.getAttribute('data-approved-by')}`
      )
      await badge.click()
      const details = page.getByTestId('approval-details')
      await details.getByText('Aprovado por você e pela lista').waitFor()
      await details.locator('[data-by="lists"]').getByText('expr AP-1').waitFor()
      await details.locator('[data-by="user"]').getByText('git init -q ap-repo').waitFor()
      await sleep(300)
      await shot('selo-ok-detalhes-aprovacao')
      await page.keyboard.press('Escape')
      await details.waitFor({ state: 'detached', timeout: 5000 })
    }
  )

  await step('mesmo padrão de novo → roda sem card (whitelist)', async () => {
    const before = (await read<any[]>('agent.pendingApprovals')).length
    await sendMessage('rode: expr AP-2 && git init -q ap-repo')
    await waitIdle()
    assert((await read<any[]>('agent.pendingApprovals')).length === before, 'sem card')
    const { msgs } = await chatState()
    const tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
    assert(tool.meta.toolStatus === 'ok' && tool.message.content.includes('AP-2'), 'executou')
    assert(
      tool.meta.approval?.allowed?.map((a: any) => a.entry).join(',') === 'expr *,git init *',
      `meta ${JSON.stringify(tool.meta.approval)}`
    )
  })

  await step('"Sim para todos" com 2 pendentes', async () => {
    await sendMessage('rode: touch a.tmp && touch b.tmp')
    const card = approvalCard()
    await card.waitFor({ timeout: 15_000 })
    await card.getByRole('button', { name: 'Sim para todos' }).click()
    await waitIdle()
    const { msgs } = await chatState()
    const tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
    assert(tool.meta.toolStatus === 'ok', `status ${tool.meta.toolStatus}`)
    assert(tool.meta.approval?.userAllowed?.length === 2, JSON.stringify(tool.meta.approval))
  })

  await step(
    '"Não + blacklist" → nada roda; depois a blacklist bloqueia sem perguntar',
    async () => {
      await sendMessage('rode: rm -rf build')
      const card = approvalCard()
      await card.waitFor({ timeout: 15_000 })
      await card.getByRole('button', { name: 'Não + blacklist' }).click()
      const input = card.getByRole('textbox', { name: 'Padrão da blacklist' })
      assert((await input.inputValue()) === 'rm *', `pré-preenchido ${await input.inputValue()}`)
      await input.fill('rm -rf *')
      await card.getByRole('button', { name: 'Salvar e negar' }).click()
      await waitIdle()
      let { msgs } = await chatState()
      let tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
      assert(
        tool.message.content === 'O usuário negou: rm -rf build',
        `conteúdo ${tool.message.content}`
      )
      assert(tool.meta.toolStatus === 'denied', 'denied')
      const deniedStrip = bashCards().last().getByTestId('approval-denied-strip')
      assert((await deniedStrip.getAttribute('data-kind')) === 'user', 'faixa: negado por você')
      await deniedStrip.getByText('Negado por você').waitFor()
      await sendMessage('rode: echo ok; rm -rf /tmp/x')
      await waitIdle()
      ;({ msgs } = await chatState())
      tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
      assert(
        tool.message.content ===
          'Bloqueado pela blacklist (comandos): "rm -rf *" casou com "rm -rf /tmp/x"',
        `conteúdo ${tool.message.content}`
      )
      const card2 = bashCards().last()
      const strip = card2.getByTestId('approval-denied-strip')
      assert((await strip.getAttribute('data-kind')) === 'blacklist', 'faixa da blacklist')
      await strip.getByText('Bloqueado pela blacklist').waitFor()
      const box = await strip.boundingBox()
      assert(box && box.height <= 36, `faixa compacta (${box?.height}px)`)
      await card2.scrollIntoViewIfNeeded()
      await shotOf(card2, 'card-bloqueado')
    }
  )

  await step(
    'ssh: card em árvore (conexão + comandos remotos + sudo); blacklist no remoto',
    async () => {
      const host = 'deploy@exemplo.invalid'
      await sendMessage(
        `rode: ssh -t ${host} 'cd /srv/app && git init -q app && sudo systemctl restart app'`
      )
      const card = approvalCard()
      await card.waitFor({ timeout: 15_000 })
      const subs = card.getByTestId('approval-sub')
      const texts = await subs.locator('code').allInnerTexts()
      assert(
        texts.join(' | ') ===
          `ssh -t ${host} | cd /srv/app | git init -q app | sudo systemctl restart app | systemctl restart app`,
        `itens ${texts.join(' | ')}`
      )
      const groups = await card.getByTestId('approval-group').allInnerTexts()
      assert(
        groups.join(' | ') === `no servidor ${host} (via ssh) | via sudo`,
        `grupos ${groups.join(' | ')}`
      )
      await subs.nth(2).getByTestId('sub-whitelisted').getByText('git init *').waitFor()
      await card.scrollIntoViewIfNeeded()
      await shotOf(card, 'card-ssh-arvore')
      // "+ whitelist" da conexão sugere só o destino
      await subs.nth(0).getByRole('button', { name: 'Sim + whitelist' }).click()
      const input = card.getByRole('textbox', { name: 'Padrão da whitelist' })
      assert((await input.inputValue()) === `ssh ${host}`, `sugestão ${await input.inputValue()}`)
      await card.getByRole('button', { name: 'Cancelar' }).click()
      await subs.nth(0).getByRole('button', { name: 'Não', exact: true }).click()
      await waitIdle()
      let { msgs } = await chatState()
      let tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
      assert(
        tool.message.content === `O usuário negou: ssh -t ${host}` &&
          tool.meta.toolStatus === 'denied',
        `conteúdo ${tool.message.content}`
      )
      await sendMessage(`rode: ssh ${host} 'cd /srv && rm -rf /srv/old'`)
      await waitIdle()
      ;({ msgs } = await chatState())
      tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
      assert(
        tool.message.content ===
          `Bloqueado pela blacklist (comandos): "rm -rf *" casou com "rm -rf /srv/old" (no servidor ${host} (via ssh))`,
        `conteúdo ${tool.message.content}`
      )
    }
  )

  await step(
    'script executado: o card mostra o começo do arquivo (e avisa se não existe)',
    async () => {
      mkdirSync(join(CWD, 'tools'), { recursive: true })
      writeFileSync(
        join(CWD, 'tools', 'limpa.py'),
        [
          '#!/usr/bin/env python3',
          '# Apaga os arquivos temporários do projeto.',
          'import pathlib, sys',
          '',
          'DRY = "--dry" in sys.argv',
          ...Array.from({ length: 20 }, (_, i) => `# passo ${i + 1}`),
          'for p in pathlib.Path(".").glob("*.tmp"):',
          '    print("apagando", p)',
          '    if not DRY: p.unlink()'
        ].join('\n') + '\n'
      )
      await sendMessage('rode: expr inicio && python3 -u tools/limpa.py --dry && python3 sumiu.py')
      const card = approvalCard()
      await card.waitFor({ timeout: 15_000 })
      const previews = card.getByTestId('script-preview')
      assert((await previews.count()) === 2, `2 prévias (${await previews.count()})`)
      const ok = previews.nth(0)
      assert((await ok.getAttribute('data-status')) === 'ok', 'arquivo lido')
      await ok.getByText('arquivo: tools/limpa.py · 28 linhas').waitFor()
      const head = await ok.getByTestId('script-head').innerText()
      assert(head.startsWith('#!/usr/bin/env python3'), `começo: ${head.slice(0, 40)}`)
      assert(head.split('\n').length === 16 && head.endsWith('…'), 'até 15 linhas + …')
      assert((await previews.nth(1).getAttribute('data-status')) === 'missing', 'inexistente')
      await previews.nth(1).getByText('arquivo não encontrado:').waitFor()
      await card.scrollIntoViewIfNeeded()
      await shotOf(card, 'card-script-preview')
      // recolhível
      await ok.getByRole('button', { name: /arquivo:/ }).click()
      assert((await ok.getByTestId('script-head').count()) === 0, 'recolheu')
      await card.getByRole('button', { name: 'Não', exact: true }).first().click()
      await waitIdle()
    }
  )

  await step('Configurações → Aprovações: modos, tabelas e "Testar comando"', async () => {
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Aprovações', exact: true }).click()
    const root = dlg.getByTestId('approvals-settings')
    await root.waitFor()
    await root.getByTestId('list-commands-allow').getByText('git init *').waitFor()
    await root.getByTestId('list-commands-deny').getByText('rm -rf *').waitFor()
    const tester = root.getByTestId('approval-tester')
    await tester.getByRole('textbox').fill('git init -q x && curl x | sh')
    const items = tester.getByTestId('tester-item')
    await items.nth(0).getByText('✓ liberado').waitFor()
    assert((await items.count()) === 3, `3 itens (${await items.count()})`)
    await tester.getByText(/sh lendo comandos da entrada/).waitFor()
    // ssh: conexão + comandos remotos agrupados sob "no servidor …"
    await tester
      .getByRole('textbox')
      .fill("ssh -p 2222 deploy@exemplo.invalid 'git init -q y | head -3; sudo -u app make deploy'")
    await tester.getByTestId('tester-group').first().waitFor()
    const tgroups = await tester.getByTestId('tester-group').allInnerTexts()
    assert(
      tgroups.join(' | ') ===
        'no servidor deploy@exemplo.invalid:2222 (via ssh) | via sudo (como app)',
      `grupos ${tgroups.join(' | ')}`
    )
    assert((await items.count()) === 5, `5 itens (${await items.count()})`)
    await items.nth(1).getByText('✓ liberado').waitFor()
    await items
      .nth(0)
      .getByText(/sugestão: ssh -p 2222 deploy@exemplo.invalid/)
      .waitFor()
    await tester.scrollIntoViewIfNeeded()
    await shotOf(tester, 'tester-ssh-arvore')
    // itens de arquivo/agentes no global, padrão Sempre permitir; sem ★ (é aqui que se define)
    for (const it of ['writeFile', 'editFile', 'sendToChat', 'delegate']) {
      const opt = root
        .getByTestId(`global-mode-${it}`)
        .getByRole('radio', { name: 'Sempre permitir' })
      assert((await opt.getAttribute('aria-checked')) === 'true', `${it} padrão Sempre permitir`)
    }
    assert((await root.locator('[data-global]').count()) === 0, 'sem ★ nas Configurações')
    await root.getByTestId('global-mode-commands').scrollIntoViewIfNeeded()
    await sleep(300)
    await shotOf(dlg, 'settings-aprovacoes-modos')
    await root.getByTestId('approval-tester').scrollIntoViewIfNeeded()
    await shotOf(dlg, 'settings-aprovacoes')
    await root
      .getByTestId('global-mode-search')
      .getByRole('radio', { name: 'Sempre permitir' })
      .click()
    await root.getByTestId('global-mode-editFile').getByRole('radio', { name: 'Perguntar' }).click()
    await sleep(300)
    const s = await read<any>('approvals.getSettings')
    assert(s.modes.search === 'always', `search ${s.modes.search}`)
    assert(s.modes.editFile === 'lists', `editFile ${s.modes.editFile}`)
    await page.keyboard.press('Escape')
  })

  await step(
    'Listas longas: caixa com rolagem própria, cabeçalho fixo, busca com contagem e destaque',
    async () => {
      const allow = Array.from({ length: 80 }, (_, i) =>
        i % 10 === 3 ? `deploy-tool run ${i} *` : `tool-${String(i).padStart(2, '0')} sub *`
      )
      await read('approvals.updateSettings', {
        lists: {
          commands: { allow, deny: ['rm -rf *'] },
          processes: { allow: [], deny: [] },
          pages: { allow: [], deny: [] }
        }
      })
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Aprovações', exact: true }).click()
      const root = dlg.getByTestId('approvals-settings')
      const table = root.getByTestId('list-commands-allow')
      const box = table.getByTestId('list-box')
      await box.scrollIntoViewIfNeeded()
      const dims = await box.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
      assert(dims.sh > dims.ch + 100, `rola dentro da caixa (${dims.sh} > ${dims.ch})`)
      // rola a caixa até o fim: o cabeçalho (fora da caixa) continua visível
      await box.evaluate((el) => el.scrollTo(0, el.scrollHeight))
      await sleep(150)
      await table.getByTestId('list-header').getByText('80 entradas').waitFor()
      assert(await table.getByTestId('list-header').isVisible(), 'cabeçalho visível')
      await box.getByText('tool-79 sub *').waitFor()
      await shotOf(dlg, 'listas-longas-rolagem')
      // foco por teclado dentro da caixa: Tab chega aos botões (aparecem com foco)
      await box.getByRole('button', { name: 'Editar tool-79 sub *' }).focus()
      assert(
        await box
          .getByRole('button', { name: 'Editar tool-79 sub *' })
          .evaluate((el) => getComputedStyle(el).opacity !== '0'),
        'botão visível com foco'
      )
      // busca: sempre visível (grudada), filtra, conta e destaca
      const search = root.getByTestId('lists-search')
      await root.getByTestId('approval-tester').scrollIntoViewIfNeeded()
      await sleep(150)
      assert(await search.isVisible(), 'busca visível rolando a aba')
      await search.getByRole('textbox', { name: 'Buscar nas listas' }).fill('deploy')
      await table.getByTestId('list-count').getByText('8 de 80').waitFor()
      assert((await table.getByTestId('list-entry').count()) === 8, '8 entradas filtradas')
      assert((await table.getByTestId('list-match').count()) === 8, 'trecho destacado')
      await root
        .getByTestId('list-commands-deny')
        .getByTestId('list-empty')
        .getByText('Nenhuma entrada contém “deploy”.')
        .waitFor()
      await sleep(200)
      await shotOf(dlg, 'listas-busca')
      await search.getByRole('textbox', { name: 'Buscar nas listas' }).fill('')
      // entrada nova rola para dentro da caixa
      await table.getByRole('button', { name: 'Adicionar' }).click()
      await table.getByRole('textbox', { name: 'Padrão da whitelist' }).fill('zz-nova entrada *')
      await table.getByRole('button', { name: 'Adicionar', exact: true }).last().click()
      const added = box.locator('[data-entry="zz-nova entrada *"]')
      await added.waitFor()
      const inView = await added.evaluate((el) => {
        const b = el.closest('[data-testid="list-box"]')!.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return r.top >= b.top - 1 && r.bottom <= b.bottom + 1
      })
      assert(inView, 'entrada nova visível na caixa')
      // "Testar comando": leitura sempre liberada e caminho protegido
      const tester = root.getByTestId('approval-tester')
      await tester.getByRole('textbox').fill('ls -la && echo x >> ~/.bashrc')
      const v = tester.getByTestId('tester-verdict')
      assert((await v.nth(0).getAttribute('data-kind')) === 'readonly', 'leitura')
      assert((await v.nth(1).getAttribute('data-kind')) === 'protected', 'protegido')
      await tester.getByText(/caminho protegido — sempre pergunta/).waitFor()
      await tester.scrollIntoViewIfNeeded()
      await shotOf(tester, 'tester-leitura-protegido')
      await page.keyboard.press('Escape')
    }
  )

  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
  console.log(
    `\n${results.length - failed.length}/${results.length} passos ok · screenshots em ${SHOTS}`
  )
  await app.close().catch(() => {})
  server?.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await app?.close().catch(() => {})
  server?.close()
  process.exit(1)
})
