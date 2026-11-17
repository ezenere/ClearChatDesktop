/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do Smart-Approve na UI real (Playwright + `e2e/launch.ts`), 100% determinístico: um provedor
// OpenAI-compatible FALSO servido pelo próprio teste em 127.0.0.1 faz o papel do agente
// (`fake/agent-1`: pede bash com o comando da mensagem e depois responde "FIM") E do juiz
// (`fake/judge-1`: respostas roteirizadas por passo). Nenhuma key real, nenhum custo.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/smart-approve.spec.ts [filtro]
//
// Cobre: aba Tools (opção Smart-Approve desabilitada sem modelo, ★ do padrão global — escolher a
// opção ★ remove o override —, sem liga/desliga, remover o modelo → itens em smart avisam e
// perguntam), rótulos com validação, tempo, juiz APPROVED → roda · REJECTED → resultado negado +
// "Executar mesmo assim" (liberação de uma vez) · ASK-USER → card de aprovação com o motivo ·
// resposta malformada e timeout → card de aprovação, custo do juiz no rodapé, "Testar", itens de
// (0.8.4) "negar" vira pergunta sem "O juiz pode negar"; listas antes do juiz (whitelist inteira →
// sem juiz, parcial → só o resto, blacklist → bloqueia, "consultar também" → juiz); subagente
// apagando arquivo que criou (o juiz vê tarefa, objetivo e arquivo); selo "ok" com os detalhes da
// aprovação e faixa compacta nas negadas;
// arquivo (Escrever arquivo em Smart-Approve → juiz; em Perguntar → card), popover do header (modos
// efetivos, revogar "Sempre") e a seção no editor de personas. Screenshots em $CLEARCHAT_E2E_DIR/shots.
import type { ElectronApplication, Locator, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { elementShot, pickModel as pickModelIn } from './uiHelpers.ts'

const FAKE_KEY = 'fake-key-smart-approve'
const AGENT = 'fake/agent-1'
const JUDGE = 'fake/judge-1'
const SUMMARY = 'fake/summary-1'
/** Modelo de raciocínio obrigatório (metadados no /models): juiz com "Tokens de pensamento". */
const THINKER = 'fake/thinker-1'
/** Id "Anthropic" (prefixo anthropic/): num provedor OpenRouter recebe cache_control. */
const CACHE_JUDGE = 'anthropic/fake-judge'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-smart-e2e'))
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
/** Respostas do resumidor (coleta de contexto); derivação de subagente → summaryDerive. */
const summaryQueue: string[] = []
let summaryDerive = '- (derivado)'
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

/** "escreva: <arquivo>" → write_file (conteúdo fixo). */
function writeFrom(text: string): string | null {
  const m = /escreva:\s*(\S+)/.exec(text)
  return m ? m[1] : null
}

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [AGENT, JUDGE]
              .map((id) => ({
                id,
                name: id === AGENT ? 'Fake Agent' : 'Fake Judge',
                context_length: 64_000,
                pricing: { prompt: '0.0000001', completion: '0.0000002' },
                supported_parameters: ['tools', 'temperature', 'max_tokens']
              }))
              .concat([
                {
                  id: THINKER,
                  name: 'Fake Thinker',
                  context_length: 64_000,
                  pricing: { prompt: '0.0000001', completion: '0.0000002' },
                  supported_parameters: ['max_tokens', 'reasoning'],
                  reasoning: {
                    mandatory: true,
                    supported_efforts: ['high', 'medium', 'low'],
                    default_effort: 'medium'
                  }
                } as any,
                {
                  id: CACHE_JUDGE,
                  name: 'Fake Cache Judge',
                  context_length: 64_000,
                  pricing: { prompt: '0.0000001', completion: '0.0000002' },
                  supported_parameters: ['temperature', 'max_tokens']
                }
              ])
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
      if (body.model === SUMMARY) {
        const u = String(body.messages?.[1]?.content ?? '')
        const text = u.includes('Task delegated to the subagent')
          ? summaryDerive
          : (summaryQueue.shift() ?? 'KEEP')
        sse([{ role: 'assistant', content: text }], {
          prompt_tokens: 200,
          completion_tokens: 20,
          cost: 0.000011
        })
        return
      }
      if (body.model === JUDGE || body.model === THINKER || body.model === CACHE_JUDGE) {
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
      const toolCall = (name: string, args: any): void =>
        sse(
          [
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) }
                }
              ]
            }
          ],
          { prompt_tokens: 100, completion_tokens: 10 }
        )
      // subagente: "… escreva: X e depois rode: <cmd>" → write_file, depois o shell
      const firstUser = textOf(msgs.find((m) => m.role === 'user')?.content)
      const then = /depois rode:\s*(.+)$/m.exec(firstUser)
      if (last?.role === 'tool' && then) {
        const ran = msgs.some((m) =>
          (m.tool_calls ?? []).some((t: any) => t.function?.name === 'shell')
        )
        if (!ran) return toolCall('shell', { command: then[1].trim() })
      }
      // principal: "delegue: <título> | <tarefa>" → delegate_task (bloqueante)
      const del =
        last?.role === 'user' ? /^delegue:\s*([^|]+)\|\s*(.+)$/s.exec(textOf(last.content)) : null
      if (del) return toolCall('delegate_task', { title: del[1].trim(), task: del[2].trim() })
      if (last?.role === 'tool') {
        sse([{ role: 'assistant', content: `FIM: ${String(last.content).slice(0, 80)}` }], {
          prompt_tokens: 100,
          completion_tokens: 8
        })
        return
      }
      const cmd = commandFrom(textOf(last?.content))
      const file = writeFrom(textOf(last?.content))
      if (file) {
        sse(
          [
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${Date.now().toString(36)}`,
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: file, content: 'escrito pelo e2e\n' })
                  }
                }
              ]
            }
          ],
          { prompt_tokens: 100, completion_tokens: 10 }
        )
        return
      }
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
const section = (): Locator => page.locator('section[data-section="smart-approve"]')

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

/** Resultado (mensagem tool) da última chamada bash cujo comando é `cmd`. */
async function toolResultFor(cmd: string): Promise<any> {
  const { msgs } = await chatState()
  const call = msgs
    .filter((m) => m.message.role === 'assistant')
    .flatMap((m) => m.message.tool_calls ?? [])
    .filter((t: any) => JSON.parse(t.function.arguments).command === cmd)
    .at(-1)
  assert(call, `tool call de ${cmd}`)
  return msgs.find((m) => m.message.role === 'tool' && m.message.tool_call_id === call.id)
}

async function pickModel(combobox: Locator, id: string, provider?: string): Promise<void> {
  await pickModelIn(page, combobox, id, { provider })
}

async function openToolsTab(): Promise<void> {
  const tab = page.getByTestId('right-panel').getByRole('tab', { name: 'Tools', exact: true })
  if (!(await tab.count())) await page.getByRole('button', { name: 'Abrir painel' }).click()
  await tab.click()
}

/** Abre a seção recolhível `id` do painel/editor (CollapsibleSection), se estiver fechada. */
async function expand(scope: Locator, id: string): Promise<void> {
  const btn = scope.getByTestId(`collapse-${id}`)
  await btn.scrollIntoViewIfNeeded()
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click()
  await scope.locator(`[data-collapse-id="${id}"][data-open]`).waitFor()
}

const judgeHits = (): { model: string; body: any }[] => hits.filter((h) => h.model === JUDGE)
const summaryHits = (): { model: string; body: any }[] => hits.filter((h) => h.model === SUMMARY)

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(CWD, { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(CWD, 'readme.txt'), 'smart-approve e2e\n')
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

  await step('novo chat com o agente falso', async () => {
    await pickModel(page.getByRole('combobox').first(), AGENT)
    await page.getByRole('button', { name: /Alterar/ }).click()
    await page.getByRole('button', { name: 'Começar' }).click()
    await composer().waitFor({ timeout: 15_000 })
    const { chat } = await chatState()
    assert(chat.config.model === AGENT, `modelo ${chat.config.model}`)
    assert(chat.config.cwd === CWD, `cwd ${chat.config.cwd}`)
  })

  await step(
    'aba Tools: sem modelo a opção Smart-Approve fica desabilitada; ★ = padrão global',
    async () => {
      await openToolsTab()
      const panel = page.getByTestId('right-panel')
      // Aprovações e Smart-Approve ficam recolhidas por padrão (resumo no cabeçalho)
      assert(
        (await panel.getByTestId('collapse-smart-approve').getAttribute('aria-expanded')) ===
          'false',
        'Smart-Approve recolhida por padrão'
      )
      await expand(panel, 'approvals')
      await expand(panel, 'smart-approve')
      const sec = section()
      await sec.scrollIntoViewIfNeeded()
      // sem modelo e sem itens em Smart: a dica é o placeholder do seletor (sem linha solta)
      await sec
        .getByTestId('smart-approve-model')
        .getByText(/Escolha um modelo para poder usar o modo Smart-Approve/)
        .waitFor()
      assert((await sec.getByTestId('smart-approve-hint').count()) === 0, 'sem linha de dica')
      // o único switch visível é o "Cache do prompt" (não há liga/desliga do juiz)
      assert(
        (await sec.getByRole('switch').count()) ===
          (await sec.getByTestId('smart-cache').getByRole('switch').count()),
        'sem liga/desliga na seção Smart-Approve'
      )
      assert(
        (await sec.getByText('Extras (passam a pedir confirmação)').count()) === 0,
        'sem checkboxes de extras'
      )
      const cmd = panel.getByTestId('chat-mode-commands')
      const smartOpt = cmd.getByRole('radio', { name: 'Smart-Approve' })
      assert((await smartOpt.getAttribute('aria-disabled')) === 'true', 'Smart desabilitado')
      // ★ no padrão global (Listas) e selecionado (sem override)
      const starred = cmd.locator('[data-global]')
      assert((await starred.getAttribute('data-mode')) === 'lists', 'estrela em Listas')
      assert((await starred.getAttribute('aria-checked')) === 'true', 'global selecionado')
      // tooltip explica por quê
      await smartOpt.scrollIntoViewIfNeeded()
      const tip = page
        .getByRole('tooltip')
        .filter({ hasText: 'Escolha um modelo de Smart-Approve abaixo' })
        .first()
      for (let i = 0; ; i++) {
        // radix abre no pointermove: mexe o mouse dentro da opção até o tooltip aparecer
        await smartOpt.hover({ position: { x: 12 + i * 6, y: 8 } })
        const ok = await tip
          .waitFor({ timeout: 1500 })
          .then(() => true)
          .catch(() => false)
        if (ok) break
        if (i >= 4) throw new Error('tooltip da opção Smart-Approve não apareceu')
      }
      await page.keyboard.press('Escape')
      await smartOpt.click({ force: true })
      await sleep(700)
      assert(
        !(await chatState()).chat.config.approvalModes?.commands,
        'clicar no Smart desabilitado não grava'
      )
      // itens novos: Escrever/Editar arquivo, Enviar para chat, Delegar — padrão Sempre permitir (★)
      for (const it of ['writeFile', 'editFile', 'sendToChat', 'delegate']) {
        const st = panel.getByTestId(`chat-mode-${it}`).locator('[data-global]')
        assert((await st.getAttribute('data-mode')) === 'always', `${it}: ★ em Sempre permitir`)
        assert((await st.getAttribute('aria-checked')) === 'true', `${it}: selecionado`)
      }
      await page.mouse.move(0, 0)
      await sleep(300)
      await shot('tools-aprovacoes-sem-modelo')
      await shotOf(sec, 'smart-section-sem-modelo')
      // escolher o modelo habilita a opção (sem toggle)
      await pickModel(sec.getByTestId('smart-approve-model').getByRole('combobox'), JUDGE)
      await sec.getByTestId('model-picker-provider').getByText('Local').waitFor()
      assert((await smartOpt.getAttribute('aria-disabled')) === null, 'Smart habilitado com modelo')
      await smartOpt.click()
      await sec.getByTestId('smart-items').getByText('Decide: Comandos.').waitFor()
      await sleep(700) // debounce da config
      let cfg = (await chatState()).chat.config
      assert(cfg.approvalModes?.commands === 'smart', `modo ${JSON.stringify(cfg.approvalModes)}`)
      assert(
        cfg.smartApprove?.model === JUDGE && cfg.smartApprove.providerId,
        `config ${JSON.stringify(cfg.smartApprove)}`
      )
      assert(
        !('enabled' in cfg.smartApprove) && !('tools' in cfg.smartApprove),
        'sem chaves legadas'
      )
      // ★: override em Escrever arquivo e volta ao global clicando na opção com estrela
      const wf = panel.getByTestId('chat-mode-writeFile')
      await wf.getByRole('radio', { name: 'Perguntar' }).click()
      await sleep(700)
      cfg = (await chatState()).chat.config
      assert(
        cfg.approvalModes?.writeFile === 'lists',
        `override ${JSON.stringify(cfg.approvalModes)}`
      )
      await wf.getByRole('radio', { name: 'Sempre permitir' }).click()
      await sleep(700)
      cfg = (await chatState()).chat.config
      assert(
        !('writeFile' in (cfg.approvalModes ?? {})),
        `★ = segue o global ${JSON.stringify(cfg.approvalModes)}`
      )
      // remover o modelo: Comandos (em Smart) avisa e pergunta; escolher de novo volta
      await sec.getByRole('button', { name: 'Remover modelo do Smart-Approve' }).click()
      await panel.getByTestId('smart-missing-commands').waitFor()
      await sec
        .getByTestId('smart-items')
        .getByText(/sem ele, Comandos pede sua confirmação/)
        .waitFor()
      assert((await smartOpt.getAttribute('aria-checked')) === 'true', 'continua em Smart')
      assert((await smartOpt.getAttribute('aria-disabled')) === 'true', 'mas indisponível')
      await page.mouse.move(0, 0)
      await cmd.scrollIntoViewIfNeeded()
      await sleep(300)
      await shot('tools-smart-sem-modelo-aviso')
      await pickModel(sec.getByTestId('smart-approve-model').getByRole('combobox'), JUDGE)
      await panel.getByTestId('smart-missing-commands').waitFor({ state: 'detached' })
      await page.mouse.move(0, 0)
      await panel.getByTestId('chat-mode-commands').scrollIntoViewIfNeeded()
      await sleep(300)
      await shot('tools-aprovacoes-com-modelo')
    }
  )

  await step('rótulos: validação (vazio, repetido) e edição; tempo máximo', async () => {
    const sec = section()
    // rótulos, tempo, toggles e prompt ficam em "Avançado" (recolhido por padrão)
    assert(
      (await sec.getByTestId('collapse-smart-advanced').getAttribute('aria-expanded')) === 'false',
      'Avançado recolhido por padrão'
    )
    await expand(sec, 'smart-advanced')
    const canDeny = sec.getByRole('switch', { name: 'O juiz pode negar' })
    const judgeWl = sec.getByRole('switch', {
      name: 'Consultar o Smart-Approve também para o que a whitelist já libera'
    })
    assert((await canDeny.getAttribute('aria-checked')) === 'false', 'pode negar: padrão off')
    assert((await judgeWl.getAttribute('aria-checked')) === 'false', 'julgar whitelist: padrão off')
    const approve = sec.getByRole('textbox', { name: 'Rótulo Aprovar' })
    await approve.fill('')
    await sec
      .getByTestId('smart-label-error')
      .getByText(/obrigatórios/)
      .waitFor()
    await approve.fill('rejected')
    await sec
      .getByTestId('smart-label-error')
      .getByText(/diferentes/)
      .waitFor()
    await sleep(700)
    let sa = (await chatState()).chat.config.smartApprove
    assert(sa.labels.approve === 'APPROVED', `inválido não salva (${sa.labels.approve})`)
    await approve.fill('OK-GO')
    await sec.getByTestId('smart-label-error').waitFor({ state: 'detached' })
    await sleep(700)
    sa = (await chatState()).chat.config.smartApprove
    assert(sa.labels.approve === 'OK-GO', `salvo ${sa.labels.approve}`)
    await approve.fill('APPROVED')
    const timeout = sec.getByRole('spinbutton', { name: 'Tempo máximo do juiz (segundos)' })
    await timeout.fill('3')
    await sleep(700)
    sa = (await chatState()).chat.config.smartApprove
    assert(sa.labels.approve === 'APPROVED' && sa.timeoutS === 3, JSON.stringify(sa))
    await sec.getByRole('button', { name: /Prompt do juiz/ }).click()
    await sec.getByRole('textbox', { name: 'Template do Smart-Approve' }).waitFor()
    await sec.getByText('{{recent_context}}', { exact: true }).waitFor()
    for (const k of [
      'user_goal',
      'subagent',
      'touched_files',
      'approved_before',
      'recent_activity'
    ])
      await sec.getByText(`{{${k}}}`, { exact: true }).waitFor()
    // screenshot da página (o de um elemento mais alto que a janela redimensiona a janela do
    // Electron, aciona o layout estreito e fecha o painel)
    await shot('smart-section')
    await sec.getByRole('button', { name: /Prompt do juiz/ }).click()
  })

  await step('APPROVED → executa (linha verde, custo do juiz no rodapé)', async () => {
    judgeQueue.push({ text: '**APPROVED** — Só imprime um texto.' })
    const before = judgeHits().length
    await sendMessage('rode: expr SA-APPROVED')
    await waitIdle()
    const card = bashCards().last()
    await card.locator('[data-status="ok"]').waitFor()
    // aprovada: nada abaixo do card; os detalhes ficam no selo "ok" (hover/foco; clique fixa)
    assert((await card.getByTestId('smart-approve-line').count()) === 0, 'sem linha no card')
    assert((await card.getByTestId('approval-denied-strip').count()) === 0, 'sem faixa')
    const badge = card.getByTestId('approval-badge')
    assert((await badge.getAttribute('data-approved-by')) === 'smart', 'aprovado pelo juiz')
    await badge.hover()
    const details = page.getByTestId('approval-details')
    await details.waitFor({ timeout: 5000 })
    const line = details.getByTestId('smart-approve-line')
    assert((await line.getAttribute('data-decision')) === 'approve', 'linha approve')
    await line.getByText('Liberado pelo Smart-Approve').waitFor()
    await line.getByText('Só imprime um texto.').waitFor()
    await sleep(300)
    await shot('selo-ok-smart-approve')
    await page.keyboard.press('Escape')
    await details.waitFor({ state: 'detached', timeout: 5000 })
    await page.getByTestId('judge-usage').last().waitFor()
    const r = await toolResultFor('expr SA-APPROVED')
    assert(r.message.content.includes('SA-APPROVED'), 'saída do bash')
    assert(r.meta.smartApprove.decision === 'approve', 'meta')
    assert(r.meta.smartApprove.usage?.cost === 0.000042, 'custo')
    const jh = judgeHits()
    assert(jh.length === before + 1, 'uma chamada ao juiz')
    const jb = jh.at(-1)!.body
    assert(jb.temperature === 0 && jb.max_tokens === 300 && !jb.tools, 'body do juiz')
    assert(
      jb.messages[0].role === 'system' && jb.messages[0].content.includes('Smart-Approve'),
      'system'
    )
    assert(jb.messages[1].content.includes('"command": "expr SA-APPROVED"'), 'args no template')
    assert(
      jb.messages[1].content.includes('[1] rode: expr SA-APPROVED'),
      'objetivo do usuário (mensagem digitada mais recente)'
    )
    assert(!jb.messages[0].content.includes('REJECTED'), 'sem "pode negar": juiz não oferece negar')
    // nada do juiz vai para o histórico do agente
    const agentLast = hits.filter((h) => h.model === AGENT).at(-1)!.body
    assert(!JSON.stringify(agentLast.messages).includes('Smart-Approve'), 'agente não vê o juiz')
    await card.scrollIntoViewIfNeeded()
    await shotOf(card, 'card-aprovado')
  })

  await step('REJECTED sem "O juiz pode negar" → vira pergunta (motivo como dica)', async () => {
    judgeQueue.push({ text: 'REJECTED\nParece desnecessário.' })
    await sendMessage('rode: expr SA-WOULD-REJECT')
    const card = bashCards().last()
    await card.getByRole('button', { name: 'Sim', exact: true }).waitFor({ timeout: 15_000 })
    await card.getByText('Smart-Approve sugeriu perguntar').waitFor()
    await card.getByTestId('smart-would-reject').waitFor()
    await card.getByText('Parece desnecessário.').waitFor()
    await card.scrollIntoViewIfNeeded()
    await shotOf(card, 'card-sugeriu-perguntar')
    await card.getByRole('button', { name: 'Não', exact: true }).click()
    await waitIdle()
    const r = await toolResultFor('expr SA-WOULD-REJECT')
    assert(r.meta.toolStatus === 'denied', 'você negou')
    assert(r.meta.smartApprove.decision === 'ask' && r.meta.smartApprove.wouldReject, 'mapeado')
    assert(!r.message.content.startsWith('Rejeitado pelo Smart-Approve'), 'não foi o juiz')
    const strip = bashCards().last().getByTestId('approval-denied-strip')
    assert((await strip.getAttribute('data-kind')) === 'user', 'faixa: negado por você')
  })

  await step('REJECTED com "O juiz pode negar" → resultado negado + faixa vermelha', async () => {
    await openToolsTab()
    const panel = page.getByTestId('right-panel')
    await expand(panel, 'smart-approve')
    await expand(section(), 'smart-advanced')
    await section().getByRole('switch', { name: 'O juiz pode negar' }).click()
    await sleep(700)
    assert((await chatState()).chat.config.smartApprove.canDeny === true, 'pode negar salvo')
    await shot('smart-avancado-pode-negar')
    judgeQueue.push({ text: 'REJECTED\nApagaria arquivos fora da raiz.' })
    await sendMessage('rode: expr SA-REJECTED')
    await waitIdle()
    const card = bashCards().last()
    await card.getByText('negada', { exact: true }).waitFor()
    assert(
      judgeHits().at(-1)!.body.messages[0].content.includes('REJECTED | ASK-USER'),
      'com pode negar: rótulo de rejeitar oferecido'
    )
    const strip = card.getByTestId('approval-denied-strip')
    assert((await strip.getAttribute('data-kind')) === 'smart', 'faixa do juiz')
    await strip.getByText('Apagaria arquivos fora da raiz.').waitFor()
    const box = await strip.boundingBox()
    assert(box && box.height <= 36, `faixa compacta (${box?.height}px)`)
    await strip.getByRole('button', { name: /Negado pelo Smart-Approve/ }).click()
    const line = strip.getByTestId('smart-approve-line')
    assert((await line.getAttribute('data-decision')) === 'reject', 'linha reject')
    const r = await toolResultFor('expr SA-REJECTED')
    assert(
      r.message.content ===
        'Rejeitado pelo Smart-Approve (fake/judge-1): Apagaria arquivos fora da raiz.',
      `conteúdo ${r.message.content}`
    )
    assert(r.meta.toolStatus === 'denied', 'denied')
    const agentLast = hits.filter((h) => h.model === AGENT).at(-1)!.body
    assert(
      agentLast.messages.at(-1).content.startsWith('Rejeitado pelo Smart-Approve'),
      'agente recebeu a rejeição'
    )
    await card.scrollIntoViewIfNeeded()
    await shotOf(card, 'card-rejeitado')
  })

  await step(
    'Executar mesmo assim → mensagem do usuário + chamada idêntica roda sem juiz',
    async () => {
      const before = judgeHits().length
      const card = bashCards().nth((await bashCards().count()) - 1)
      await card
        .getByTestId('approval-denied-strip')
        .getByRole('button', { name: 'Executar mesmo assim' })
        .click()
      await page.getByText('Pode executar shell `expr SA-REJECTED`; eu aprovo.').first().waitFor()
      await waitIdle()
      await card.getByTestId('smart-overridden').waitFor()
      const runCard = bashCards().last()
      await runCard.locator('[data-status="ok"]').waitFor()
      const badge = runCard.getByTestId('approval-badge')
      assert((await badge.getAttribute('data-approved-by')) === 'user', 'liberado por você')
      await badge.focus() // teclado: o foco abre o tooltip
      await page.getByTestId('approval-details').getByTestId('smart-override-run').waitFor()
      await page.keyboard.press('Escape')
      assert(judgeHits().length === before, 'sem nova chamada ao juiz')
      await runCard.scrollIntoViewIfNeeded()
      await shotOf(page.locator('main, [data-chat-drop]').first(), 'override-executado')
      const { msgs } = await chatState()
      const results = msgs.filter(
        (m) => m.message.role === 'tool' && m.message.content.includes('SA-REJECTED')
      )
      assert(
        results.some((m) => m.meta.smartOverride === true && m.meta.toolStatus === 'ok'),
        'rodou'
      )
      assert(
        msgs.some((m) => m.message.role === 'tool' && m.meta.smartApprove?.overridden === true),
        'rejeição marcada como liberada'
      )
      // a liberação é de uma vez só: a mesma chamada de novo volta ao juiz
      judgeQueue.push({ text: 'REJECTED\nDe novo não.' })
      await sendMessage('rode: expr SA-REJECTED')
      await waitIdle()
      await bashCards().last().getByText('negada', { exact: true }).waitFor()
      assert(judgeHits().length === before + 1, 'voltou ao juiz')
    }
  )

  await step('ASK-USER → card de aprovação com o motivo do juiz', async () => {
    judgeQueue.push({ text: 'ASK-USER\nPode ser intencional; confirme você.' })
    await sendMessage('rode: expr SA-ASK')
    const card = bashCards().last()
    await card.getByRole('button', { name: 'Sim', exact: true }).waitFor({ timeout: 15_000 })
    await card.getByText('Smart-Approve sugeriu perguntar').waitFor()
    await card.getByText('Pode ser intencional; confirme você.').waitFor()
    await card.scrollIntoViewIfNeeded()
    await shotOf(card, 'card-ask-user')
    await card.getByRole('button', { name: 'Sim', exact: true }).click()
    await waitIdle()
    const r = await toolResultFor('expr SA-ASK')
    assert(
      r.meta.toolStatus === 'ok' && r.message.content.includes('SA-ASK'),
      'rodou após permitir'
    )
    assert(r.meta.smartApprove?.decision === 'ask', 'meta ask')
  })

  await step('resposta malformada → card de aprovação (Negar)', async () => {
    judgeQueue.push({ text: 'Claro! Vou aprovar isso para você.' })
    await sendMessage('rode: expr SA-MALFORMED')
    const card = bashCards().last()
    await card.getByRole('button', { name: 'Não', exact: true }).waitFor({ timeout: 15_000 })
    await card.getByText('Smart-Approve não decidiu (resposta ambígua)').waitFor()
    await shotOf(card, 'card-ambiguo')
    await card.getByRole('button', { name: 'Não', exact: true }).click()
    await waitIdle()
    const r = await toolResultFor('expr SA-MALFORMED')
    assert(r.meta.toolStatus === 'denied', 'negado pelo usuário')
    assert(r.meta.smartApprove?.fallback === 'ambiguous', 'fallback ambiguous')
  })

  await step('timeout do juiz → card de aprovação', async () => {
    judgeQueue.push({ text: 'APPROVED\ntarde demais', delayMs: 8000 })
    const t0 = Date.now()
    await sendMessage('rode: expr SA-TIMEOUT')
    const card = bashCards().last()
    await card.locator('[data-status="judging"]').waitFor({ timeout: 5000 })
    await card.getByRole('button', { name: 'Sim', exact: true }).waitFor({ timeout: 10_000 })
    const waited = Date.now() - t0
    await card.getByText('Smart-Approve não decidiu (tempo esgotado)').waitFor()
    await card.getByRole('button', { name: 'Sim', exact: true }).click()
    await waitIdle()
    const r = await toolResultFor('expr SA-TIMEOUT')
    assert(r.meta.smartApprove?.fallback === 'timeout', 'fallback timeout')
    assert(r.meta.toolStatus === 'ok', 'rodou após permitir')
    return `aprovação apareceu após ${waited}ms (timeout 3s)`
  })

  await step('Escrever arquivo: Smart-Approve → juiz; Perguntar → card', async () => {
    await openToolsTab()
    const panel = page.getByTestId('right-panel')
    await expand(panel, 'approvals')
    const wf = panel.getByTestId('chat-mode-writeFile')
    await wf.getByRole('radio', { name: 'Smart-Approve' }).click()
    await section()
      .getByTestId('smart-items')
      .getByText('Decide: Comandos, Escrever arquivo.')
      .waitFor()
    await sleep(700)
    judgeQueue.push({ text: 'APPROVED\nArquivo dentro da raiz.' })
    const before = judgeHits().length
    await sendMessage('escreva: sa-juiz.txt')
    await waitIdle()
    assert(judgeHits().length === before + 1, 'juiz chamado para write_file')
    assert(judgeHits().at(-1)!.body.messages[1].content.includes('write_file'), 'tool no template')
    const { msgs } = await chatState()
    const res = msgs.filter((m) => m.message.role === 'tool').at(-1)
    assert(
      res.meta.toolStatus === 'ok' && res.meta.smartApprove?.decision === 'approve',
      'escreveu'
    )
    // Perguntar → card simples (Permitir/Negar), sem juiz
    await wf.getByRole('radio', { name: 'Perguntar' }).click()
    await sleep(700)
    await sendMessage('escreva: sa-pergunta.txt')
    const card = page.getByTestId('approval-card').last()
    await card.getByRole('button', { name: 'Negar', exact: true }).waitFor({ timeout: 15_000 })
    await card.getByRole('button', { name: 'Negar', exact: true }).click()
    await waitIdle()
    assert(judgeHits().length === before + 1, 'Perguntar não chama o juiz')
    const res2 = (await chatState()).msgs.filter((m) => m.message.role === 'tool').at(-1)
    assert(res2.meta.toolStatus === 'denied', 'negado')
    // volta ao padrão global (★ Sempre permitir)
    await wf.getByRole('radio', { name: 'Sempre permitir' }).click()
    await sleep(700)
    const cfg = (await chatState()).chat.config
    assert(!('writeFile' in (cfg.approvalModes ?? {})), 'voltou ao global')
  })

  await step('Testar (chamada de exemplo) no editor', async () => {
    await openToolsTab()
    await expand(page.getByTestId('right-panel'), 'smart-approve')
    const sec = section()
    await sec.scrollIntoViewIfNeeded()
    await expand(sec, 'smart-test')
    judgeQueue.push({ text: 'REJECTED\nApaga node_modules sem necessidade.' })
    await sec.getByRole('button', { name: 'Testar', exact: true }).click()
    const res = sec.getByTestId('smart-test-result')
    await res.waitFor({ timeout: 10_000 })
    await res.getByText('Negado pelo Smart-Approve').waitFor()
    await res.getByText('Apaga node_modules sem necessidade.').waitFor()
    const jb = judgeHits().at(-1)!.body
    assert(jb.messages[1].content.includes('rm -rf node_modules'), 'chamada de exemplo')
    await res.scrollIntoViewIfNeeded()
    await shotOf(page.getByTestId('right-panel'), 'smart-section-testar')
  })

  await step(
    'juiz com raciocínio obrigatório: aviso + "Tokens de pensamento" no body',
    async () => {
      const sec = section()
      await sec.scrollIntoViewIfNeeded()
      const picker = sec.getByTestId('smart-approve-model').getByRole('combobox')
      // juiz sem raciocínio: nada de aviso nem campo
      assert((await sec.getByTestId('smart-thinking').count()) === 0, 'sem campo no fake/judge-1')
      await pickModel(picker, THINKER)
      const box = sec.getByTestId('smart-thinking')
      await box.waitFor({ timeout: 10_000 })
      await box
        .getByTestId('smart-thinking-note')
        .getByText('Este modelo sempre raciocina (thinking obrigatório) — esforço mínimo.')
        .waitFor()
      const input = box.getByRole('spinbutton', { name: 'Tokens de pensamento do juiz' })
      assert((await input.getAttribute('placeholder')) === '2048', 'placeholder = padrão')
      await input.fill('3000')
      await input.blur()
      await sleep(700)
      let cfg = (await chatState()).chat.config
      assert(cfg.smartApprove?.thinkingTokens === 3000, `salvo ${cfg.smartApprove?.thinkingTokens}`)
      // (i) "Enviado à API": body exato com max_tokens somado e effort mínimo
      const info = sec.getByRole('button', { name: 'O que é enviado para a API' }).first()
      await info.hover()
      const tip = page.getByRole('tooltip').filter({ hasText: 'Chamada ao juiz (exemplo)' }).first()
      await tip.waitFor({ timeout: 5000 })
      const code = (await tip.locator('pre').first().textContent()) ?? ''
      assert(code.includes('"max_tokens": 3300'), `preview max_tokens: ${code.slice(0, 400)}`)
      assert(code.includes('"reasoning_effort": "low"'), 'preview effort')
      assert(!code.includes('"temperature"'), 'preview sem temperature')
      await tip
        .getByTestId('smart-request-notes')
        .getByText(/3000 tokens de pensamento/)
        .waitFor()
      await shot('smart-thinking-preview')
      await page.mouse.move(0, 0)
      await page.keyboard.press('Escape')
      // Testar: a request real ao juiz leva o mesmo body
      await expand(sec, 'smart-test')
      judgeQueue.push({ text: 'APPROVED\nok' })
      await sec.getByRole('button', { name: 'Testar', exact: true }).click()
      await sec
        .getByTestId('smart-test-result')
        .getByText('Liberado pelo Smart-Approve')
        .waitFor({ timeout: 10_000 })
      const tb = hits.filter((h) => h.model === THINKER).at(-1)!.body
      assert(tb.max_tokens === 3300, `max_tokens ${tb.max_tokens}`)
      assert(tb.reasoning_effort === 'low', `effort ${tb.reasoning_effort}`)
      assert(!('temperature' in tb), 'sem temperature')
      await box.scrollIntoViewIfNeeded()
      await shotOf(sec, 'smart-thinking-field')
      // limpar = padrão (null)
      await input.fill('')
      await input.blur()
      await sleep(700)
      cfg = (await chatState()).chat.config
      assert(cfg.smartApprove?.thinkingTokens == null, 'limpo = padrão')
      // volta ao juiz normal: some o campo
      await pickModel(picker, JUDGE)
      await box.waitFor({ state: 'detached', timeout: 5000 })
      await sleep(700) // debounce da config
      cfg = (await chatState()).chat.config
      assert(cfg.smartApprove?.model === JUDGE, 'juiz restaurado')
    }
  )

  await step(
    'cache do prompt: ligado divide em parts com cache_control; desligado = strings',
    async () => {
      // provedor OpenRouter apontando para o mesmo servidor falso (modelo anthropic/… recebe cache_control)
      await read('providers.create', {
        name: 'Local OR',
        kind: 'openrouter',
        baseUrl: fakeBase,
        apiKey: FAKE_KEY,
        headers: {}
      })
      await page.reload()
      await page.getByTestId('chat-item').first().click()
      await composer().waitFor({ timeout: 15_000 })
      await openToolsTab()
      const panel = page.getByTestId('right-panel')
      await expand(panel, 'smart-approve')
      const sec = section()
      await sec.scrollIntoViewIfNeeded()
      await pickModel(
        sec.getByTestId('smart-approve-model').getByRole('combobox'),
        CACHE_JUDGE,
        'Local OR'
      )
      await sleep(700)
      let cfg = (await chatState()).chat.config
      assert(cfg.smartApprove?.model === CACHE_JUDGE, `juiz ${cfg.smartApprove?.model}`)
      const toggle = sec.getByTestId('smart-cache').getByRole('switch')
      assert((await toggle.getAttribute('aria-checked')) === 'true', 'ligado por padrão')
      const test = async (): Promise<any> => {
        const n = hits.length
        judgeQueue.push({ text: 'APPROVED\nok' })
        await expand(sec, 'smart-test')
        await sec.getByRole('button', { name: 'Testar', exact: true }).click()
        await sec
          .getByTestId('smart-test-result')
          .getByText('Liberado pelo Smart-Approve')
          .waitFor({ timeout: 10_000 })
        return hits.slice(n).find((h) => h.model === CACHE_JUDGE)!.body
      }
      const on = await test()
      assert(Array.isArray(on.messages[0].content), 'system em parts')
      assert(on.messages[0].content[0].cache_control?.type === 'ephemeral', 'breakpoint no system')
      const parts = on.messages[1].content
      assert(Array.isArray(parts) && parts.length === 2, 'user dividido em 2 parts')
      assert(
        parts[0].cache_control?.type === 'ephemeral' && !parts[1].cache_control,
        '2º breakpoint'
      )
      assert(parts[1].text.includes('Pending tool call'), 'chamada pendente fora do cache')
      // (i): o body exato mostra o cache_control
      await sec.getByRole('button', { name: 'O que é enviado para a API' }).first().hover()
      const tip = page.getByRole('tooltip').filter({ hasText: 'Chamada ao juiz (exemplo)' }).first()
      await tip.waitFor({ timeout: 5000 })
      const code = (await tip.locator('pre').first().textContent()) ?? ''
      assert((code.match(/"cache_control"/g) ?? []).length === 2, 'preview com 2 cache_control')
      await shot('smart-cache-preview')
      await page.mouse.move(0, 0)
      await page.keyboard.press('Escape')
      // desligar: request de sempre (strings, sem cache_control)
      await toggle.click()
      await sleep(700)
      cfg = (await chatState()).chat.config
      assert(cfg.smartApprove?.cache === false, 'desligado salvo')
      const off = await test()
      assert(!JSON.stringify(off).includes('cache_control'), 'sem cache_control')
      assert(typeof off.messages[1].content === 'string', 'user string')
      assert(off.messages[1].content === parts[0].text + parts[1].text, 'mesmo texto')
      await sec.getByTestId('smart-cache').scrollIntoViewIfNeeded()
      await shotOf(sec, 'smart-cache-toggle')
      // religar (ausente = ligado) e voltar ao juiz do provedor Local
      await toggle.click()
      await sleep(700)
      cfg = (await chatState()).chat.config
      assert(!('cache' in cfg.smartApprove), 'ligado = chave ausente')
      await pickModel(sec.getByTestId('smart-approve-model').getByRole('combobox'), JUDGE, 'Local')
      await sleep(700)
      assert((await chatState()).chat.config.smartApprove?.model === JUDGE, 'juiz restaurado')
    }
  )

  await step(
    'listas antes do juiz: whitelist inteira → sem juiz; parcial → juiz só no resto; blacklist → bloqueia',
    async () => {
      const lists = (wl: string[], bl: string[] = []): Promise<any> =>
        read('approvals.updateSettings', {
          lists: {
            commands: { allow: wl, deny: bl },
            processes: { allow: [], deny: [] },
            pages: { allow: [], deny: [] }
          }
        })
      await lists(['expr *'], ['rm -rf *'])
      let before = judgeHits().length
      await sendMessage('rode: expr SA-WL')
      await waitIdle()
      assert(judgeHits().length === before, 'whitelist inteira: juiz não chamado')
      let r = await toolResultFor('expr SA-WL')
      assert(r.meta.toolStatus === 'ok' && !r.meta.smartApprove, 'rodou sem juiz')
      assert(
        r.meta.approval.mode === 'smart' && r.meta.approval.allowed[0].entry === 'expr *',
        'lista'
      )
      assert(
        (await bashCards()
          .last()
          .getByTestId('approval-badge')
          .getAttribute('data-approved-by')) === 'lists',
        'selo: pela lista'
      )
      // parcial: só o que a whitelist não cobre vai ao juiz (o resto como contexto)
      judgeQueue.push({ text: 'APPROVED\nCria um arquivo na raiz, parte da tarefa.' })
      before = judgeHits().length
      await sendMessage('rode: expr SA-PART && touch sa-part.txt')
      await waitIdle()
      assert(judgeHits().length === before + 1, 'parcial: uma chamada ao juiz')
      const u = judgeHits().at(-1)!.body.messages[1].content
      assert(u.includes('- expr SA-PART   [already allowed by whitelist "expr *"]'), 'contexto')
      assert(u.includes('- touch sa-part.txt   [TO DECIDE]'), 'só o resto a decidir')
      r = await toolResultFor('expr SA-PART && touch sa-part.txt')
      assert(r.meta.approval.judgeAllowed?.[0] === 'touch sa-part.txt', 'liberado pelo juiz')
      await bashCards().last().getByTestId('approval-badge').click()
      await page
        .getByTestId('approval-details')
        .getByText('Aprovado pela lista e pelo Smart-Approve')
        .waitFor()
      await sleep(300)
      await shot('selo-ok-lista-e-smart')
      await page.keyboard.press('Escape')
      // blacklist: bloqueia sem juiz
      before = judgeHits().length
      await sendMessage('rode: rm -rf /tmp/sa-nao-existe')
      await waitIdle()
      assert(judgeHits().length === before, 'blacklist: sem juiz')
      r = await toolResultFor('rm -rf /tmp/sa-nao-existe')
      assert(r.meta.toolStatus === 'denied' && r.meta.approval.blocked, 'bloqueado')
      // opção "consultar também o que a whitelist libera" → juiz chamado
      await openToolsTab()
      await expand(page.getByTestId('right-panel'), 'smart-approve')
      await expand(section(), 'smart-advanced')
      const wlSwitch = section().getByRole('switch', {
        name: 'Consultar o Smart-Approve também para o que a whitelist já libera'
      })
      await wlSwitch.click()
      await sleep(700)
      judgeQueue.push({ text: 'APPROVED\nSó imprime.' })
      before = judgeHits().length
      await sendMessage('rode: expr SA-WL-JUDGED')
      await waitIdle()
      assert(judgeHits().length === before + 1, 'com a opção: juiz chamado')
      assert(
        judgeHits()
          .at(-1)!
          .body.messages[1].content.includes('TO DECIDE — matches whitelist "expr *"'),
        'item da whitelist enviado ao juiz'
      )
      await wlSwitch.click()
      await sleep(700)
      await lists([], [])
    }
  )

  await step(
    'subagente apaga arquivo que criou: juiz vê a tarefa, o objetivo e o arquivo; "negar" vira pergunta',
    async () => {
      // pode negar desligado de novo (padrão)
      await openToolsTab()
      await expand(page.getByTestId('right-panel'), 'smart-approve')
      await expand(section(), 'smart-advanced')
      const canDeny = section().getByRole('switch', { name: 'O juiz pode negar' })
      if ((await canDeny.getAttribute('aria-checked')) === 'true') await canDeny.click()
      const { chat } = await chatState()
      await read('chats.update', chat.id, {
        config: { enabledTools: [...new Set([...chat.config.enabledTools, 'delegate_task'])] }
      })
      await sleep(700)
      assert((await chatState()).chat.config.smartApprove.canDeny === false, 'pode negar off')
      judgeQueue.push({ text: 'REJECTED\nApaga um arquivo.' })
      const before = judgeHits().length
      await sendMessage(
        'delegue: Rascunho | Crie um rascunho e limpe depois: escreva: sub-rascunho.txt e depois rode: rm sub-rascunho.txt'
      )
      const card = page.getByTestId('approval-card').last()
      await card.getByRole('button', { name: 'Sim', exact: true }).waitFor({ timeout: 20_000 })
      assert(judgeHits().length === before + 1, 'juiz chamado para o rm do subagente')
      const u = judgeHits().at(-1)!.body.messages[1].content
      assert(u.includes('Caller: a SUBAGENT (depth 1, "Rascunho")'), 'quem chama')
      assert(
        u.includes('escreva: sub-rascunho.txt e depois rode: rm sub-rascunho.txt'),
        'tarefa do delegate'
      )
      assert(u.includes('[1] delegue: Rascunho | Crie um rascunho'), 'objetivo da principal')
      assert(
        u.includes(`- ${join(CWD, 'sub-rascunho.txt')} (created/overwritten)`),
        'arquivo tocado'
      )
      assert(u.includes('- [ok] write_file: sub-rascunho.txt'), 'atividade recente')
      assert(u.includes('- rm sub-rascunho.txt   [TO DECIDE]'), 'decomposição')
      const pend = (await read<any[]>('agent.pendingApprovals')).at(-1)
      assert(pend.smartApprove.decision === 'ask' && pend.smartApprove.wouldReject, 'reject → ask')
      await card.getByText('Smart-Approve sugeriu perguntar').waitFor()
      await card.getByTestId('smart-would-reject').waitFor()
      await card.scrollIntoViewIfNeeded()
      await sleep(300)
      await shotOf(card, 'subagente-sugeriu-perguntar')
      await card.getByRole('button', { name: 'Sim', exact: true }).click()
      await waitIdle(40_000)
      const sub = (await read<any[]>('sessions.list', chat.id)).find((x) => x.title === 'Rascunho')
      assert(sub, 'subsessão')
      const msgs = await read<any[]>('sessions.messages', sub.id)
      const rm = msgs.filter((m) => m.message.role === 'tool').at(-1)
      assert(rm.meta.toolStatus === 'ok', `rm rodou (${rm.message.content})`)
      assert(rm.meta.approval.userAllowed?.[0] === 'rm sub-rascunho.txt', 'aprovado por você')
    }
  )

  await step(
    'leitura sempre liberada: ls roda sem card e sem juiz, até em "Listas" vazio',
    async () => {
      const { chat } = await chatState()
      const modes = chat.config.approvalModes
      await read('chats.update', chat.id, {
        config: { approvalModes: { ...modes, commands: 'lists' } }
      })
      await read('approvals.updateSettings', {
        lists: {
          commands: { allow: [], deny: [] },
          processes: { allow: [], deny: [] },
          pages: { allow: [], deny: [] }
        }
      })
      const before = judgeHits().length
      await sendMessage('rode: ls -la && git status')
      await waitIdle()
      const card = bashCards().last()
      assert((await card.getByTestId('approval-card').count()) === 0, 'sem card')
      const r = await toolResultFor('ls -la && git status')
      assert(r.meta.toolStatus !== 'denied', 'rodou')
      assert(r.meta.approval?.readOnly?.length === 2, `readOnly ${JSON.stringify(r.meta.approval)}`)
      assert(judgeHits().length === before, 'sem juiz')
      const badge = card.getByTestId('approval-badge')
      assert((await badge.getAttribute('data-approved-by')) === 'readonly', 'selo: leitura')
      await badge.click()
      await page
        .getByTestId('approval-details')
        .getByText('leitura (sempre liberada)')
        .first()
        .waitFor()
      await sleep(300)
      await shot('selo-leitura-sempre-liberada')
      await page.keyboard.press('Escape')
      await read('chats.update', chat.id, { config: { approvalModes: modes } })
    }
  )

  await step(
    'caminho protegido: pergunta mesmo na whitelist e no Smart-Approve (sem juiz)',
    async () => {
      await read('approvals.updateSettings', {
        lists: {
          commands: { allow: ['tee *'], deny: [] },
          processes: { allow: [], deny: [] },
          pages: { allow: [], deny: [] }
        }
      })
      const before = judgeHits().length
      await sendMessage('rode: expr SA-PROT | tee .env.local')
      const card = bashCards().last()
      await card.getByTestId('sub-protected').waitFor({ timeout: 15_000 })
      assert(judgeHits().length === before, 'o juiz não foi chamado')
      const sub = card
        .getByTestId('approval-sub')
        .filter({ has: page.getByTestId('sub-protected') })
      assert(
        (await sub.getByRole('button', { name: 'Sim + whitelist' }).isDisabled()) === true,
        '"Sim + whitelist" desabilitado'
      )
      await card.scrollIntoViewIfNeeded()
      await shotOf(card, 'card-caminho-protegido')
      await card.getByRole('button', { name: 'Não', exact: true }).first().click()
      await waitIdle()
      const r = await toolResultFor('expr SA-PROT | tee .env.local')
      assert(r.meta.toolStatus === 'denied', 'negado')
      assert(
        /\.env\.local/.test(r.meta.approval?.protectedPath ?? ''),
        'registro do caminho protegido'
      )
      await read('approvals.updateSettings', {
        lists: {
          commands: { allow: [], deny: [] },
          processes: { allow: [], deny: [] },
          pages: { allow: [], deny: [] }
        }
      })
    }
  )

  await step(
    'coleta de contexto: o resumo atualiza a descrição e o juiz recebe (espera o resumo)',
    async () => {
      const { chat } = await chatState()
      const pid = chat.config.providerId
      await read('chats.update', chat.id, {
        config: {
          smartApprove: {
            ...chat.config.smartApprove,
            environment: '172.16.1.7 é meu servidor de testes; pode reiniciar containers lá.',
            capture: {
              enabled: true,
              providerId: pid,
              model: SUMMARY,
              maxTokens: null,
              lookback: 2
            }
          }
        }
      })
      summaryQueue.push('APPEND\n- Usuário quer reiniciar o container api no 172.16.1.7')
      judgeQueue.push({ text: 'APPROVED\nO usuário pediu.' })
      const sBefore = summaryHits().length
      await sendMessage('rode: touch sa-capture.txt e reinicie o container api no 172.16.1.7')
      await waitIdle()
      assert(summaryHits().length === sBefore + 1, 'uma chamada ao resumidor')
      const sb = summaryHits().at(-1)!.body
      assert(sb.messages[1].content.includes('reinicie o container api'), 'mensagem do usuário')
      // só system + user; do agente, no máximo `lookback` (2) falas — nunca mensagens de tool
      assert(sb.messages.length === 2, 'system + user')
      const agentBlock = String(sb.messages[1].content).split('New message(s)')[0]
      assert(agentBlock.split('\n---\n').length <= 2, 'até 2 falas do agente')
      const u = judgeHits().at(-1)!.body.messages[1].content
      assert(u.startsWith('Descrição do ambiente (usuário)'), 'ambiente no começo')
      assert(u.includes('pode reiniciar containers lá'), 'descrição do usuário')
      assert(u.includes('Contexto capturado da conversa'), 'bloco capturado')
      assert(
        u.includes('- Usuário quer reiniciar o container api no 172.16.1.7'),
        'o juiz esperou o resumo'
      )
      const cc = (await chatState()).chat.config.capturedContext
      assert(cc?.main?.text === '- Usuário quer reiniciar o container api no 172.16.1.7', 'salvo')
      assert(cc?.main?.cost === 0.000011, 'custo registrado')
      // UI: Ambiente e contexto → descrição editável
      await openToolsTab()
      const panel = page.getByTestId('right-panel')
      await expand(panel, 'smart-approve')
      await expand(section(), 'smart-environment')
      const box = section().getByTestId('captured-context')
      await box.getByRole('textbox').waitFor()
      assert(
        (await box.getByRole('textbox').inputValue()).includes('reiniciar o container api'),
        'descrição na UI'
      )
      await box
        .getByTestId('captured-meta')
        .getByText(/atualizado há/)
        .waitFor()
      assert(
        (await section().getByTestId('capture-status').getAttribute('data-active')) === 'true',
        'coleta ativa'
      )
      await section().getByTestId('smart-context').scrollIntoViewIfNeeded()
      await sleep(300)
      await shotOf(section(), 'smart-ambiente-e-contexto')
    }
  )

  await step(
    'prompts do resumidor: personalizado vai na chamada; template sem {{user}} → aviso + padrão; Restaurar padrão',
    async () => {
      await openToolsTab()
      const panel = page.getByTestId('right-panel')
      await expand(panel, 'smart-approve')
      await expand(section(), 'smart-environment')
      await expand(section(), 'smart-capture-prompts')
      const box = section().getByTestId('chat-capture-prompts')
      await box.getByTestId('capture-prompts-use-global').uncheck()
      const fields = box.getByTestId('chat-capture-prompts-fields')
      await fields.waitFor()
      const promptBox = fields.getByRole('textbox', { name: 'Prompt do resumidor', exact: true })
      const tplBox = fields.getByRole('textbox', { name: 'Template do resumidor', exact: true })
      assert(
        (await promptBox.inputValue()).startsWith('You maintain a short "captured context"'),
        'mostra o padrão'
      )
      await promptBox.fill('PROMPT-E2E: resuma. KEEP APPEND REWRITE ({{max_chars}})')
      await promptBox.blur()
      await tplBox.fill('Só a descrição: {{current}}')
      await tplBox.blur()
      const warn = fields.getByTestId('capture-template-error')
      await warn.getByText(/Falta \{\{user\}\}/).waitFor()
      await warn.getByText(/usa o template padrão/).waitFor()
      const hdrWarn = section()
        .locator('[data-collapse-id="smart-capture-prompts"]')
        .getByTestId('collapse-warning')
        .first()
      assert(
        ((await hdrWarn.getAttribute('title')) ?? '').includes('template do resumidor inválido'),
        'aviso no cabeçalho da subseção'
      )
      await sleep(800) // patchConfig salva com 450 ms de atraso
      let cfg = (await chatState()).chat.config
      assert(
        cfg.smartApprove.capturePrompts?.prompt?.startsWith('PROMPT-E2E'),
        `prompt salvo ${JSON.stringify(cfg.smartApprove)}`
      )
      assert(
        cfg.smartApprove.capturePrompts?.template === 'Só a descrição: {{current}}',
        'template salvo'
      )
      await fields.scrollIntoViewIfNeeded()
      await shotOf(section(), 'smart-prompts-do-resumidor')
      // a chamada usa o prompt personalizado e o template PADRÃO (o personalizado está quebrado)
      summaryQueue.push('KEEP')
      const sBefore = summaryHits().length
      await sendMessage('lembrete: o banco de staging pode ser recriado')
      await waitIdle()
      for (let i = 0; i < 50 && summaryHits().length === sBefore; i++) await sleep(100)
      const sb = summaryHits().at(-1)!.body
      assert(summaryHits().length === sBefore + 1, 'uma chamada ao resumidor')
      assert(
        sb.messages[0].content.startsWith('PROMPT-E2E: resuma. KEEP APPEND REWRITE (1200)'),
        `system personalizado: ${sb.messages[0].content.slice(0, 80)}`
      )
      assert(
        sb.messages[1].content.includes('New message(s) typed by the user (DATA'),
        'template padrão'
      )
      assert(sb.messages[1].content.includes('banco de staging pode ser recriado'), 'mensagem nova')
      assert(!sb.messages[1].content.includes('Só a descrição'), 'template quebrado não foi')
      // Restaurar padrão (template e prompt) → sem aviso; "usar o global" remove o ajuste do chat
      await fields.getByTestId('capture-template-restore').getByRole('button').click()
      await warn.waitFor({ state: 'detached' })
      assert(
        (await tplBox.inputValue()).startsWith('Current description (DATA'),
        'template padrão de volta'
      )
      await fields.getByTestId('capture-prompt-restore').getByRole('button').click()
      await sleep(800) // patchConfig salva com 450 ms de atraso
      cfg = (await chatState()).chat.config
      assert(
        JSON.stringify(cfg.smartApprove.capturePrompts) ===
          JSON.stringify({ prompt: null, template: null, derivePrompt: null }),
        `restaurado ${JSON.stringify(cfg.smartApprove.capturePrompts)}`
      )
      await box.getByTestId('capture-prompts-use-global').check()
      await sleep(800) // patchConfig salva com 450 ms de atraso
      cfg = (await chatState()).chat.config
      assert(cfg.smartApprove.capturePrompts === undefined, 'usar o global remove o ajuste')
      // global (Configurações → Aprovações → Padrões globais): mesmo editor, salva no setting
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      const dlg = page.getByRole('dialog')
      await dlg.getByRole('button', { name: 'Aprovações', exact: true }).click()
      await expand(dlg, 'global-capture-prompts')
      const g = dlg.getByTestId('global-capture-prompts')
      const gDerive = g.getByRole('textbox', {
        name: 'Prompt da derivação do resumidor',
        exact: true
      })
      await gDerive.fill('DERIVE-GLOBAL até {{max_chars}}')
      await gDerive.blur()
      await sleep(300)
      const st = await read('approvals.getSettings')
      assert(
        st.smart.capturePrompts.derivePrompt === 'DERIVE-GLOBAL até {{max_chars}}',
        `global salvo ${JSON.stringify(st.smart.capturePrompts)}`
      )
      await g.getByTestId('capture-derivePrompt-restore').getByRole('button').click()
      await sleep(300)
      const st2 = await read('approvals.getSettings')
      assert(st2.smart.capturePrompts.derivePrompt === null, 'global restaurado')
      await page.keyboard.press('Escape')
    }
  )

  await step('subagente: o juiz dele recebe a descrição derivada do pai + tarefa', async () => {
    summaryDerive = '- Testes no 172.16.1.7\n- Tarefa do subagente: criar sa-sub.txt'
    judgeQueue.push({ text: 'APPROVED\nParte da tarefa.' })
    const before = judgeHits().length
    await sendMessage('delegue: Sub contexto | rode: touch sa-sub.txt')
    await waitIdle(45_000)
    const derive = summaryHits().find((h) =>
      String(h.body.messages[1].content).includes('Task delegated to the subagent')
    )
    assert(derive, 'derivação chamada')
    assert(
      String(derive!.body.messages[1].content).includes('reiniciar o container api'),
      'parte da descrição do pai'
    )
    const jh = judgeHits().slice(before)
    const subJudge = jh.find((h) =>
      String(h.body.messages[1].content).includes('Caller: a SUBAGENT')
    )
    assert(subJudge, 'juiz do subagente chamado')
    assert(
      String(subJudge!.body.messages[1].content).includes(
        '- Tarefa do subagente: criar sa-sub.txt'
      ),
      'descrição derivada no juiz do subagente'
    )
    const { chat } = await chatState()
    const subs = Object.values(chat.config.capturedContext?.sessions ?? {}) as any[]
    assert(
      subs.some((e) => e.text.includes('criar sa-sub.txt')),
      'salva por subsessão'
    )
    // desliga a coleta para os próximos passos
    await read('chats.update', chat.id, {
      config: { smartApprove: { ...chat.config.smartApprove, capture: null, environment: null } }
    })
  })

  await step(
    'header: popover com os modos efetivos — revogar "Sempre"; sem modelo o selo some e pergunta',
    async () => {
      await openToolsTab()
      const panel = page.getByTestId('right-panel')
      await expand(panel, 'approvals')
      await panel
        .getByTestId('chat-mode-pages')
        .getByRole('radio', { name: 'Sempre permitir' })
        .click()
      const badge = page.getByTestId('auto-approve-badge')
      await badge.getByText('Sempre: Páginas · Smart').waitFor({ timeout: 5000 })
      await page.getByRole('button', { name: 'Fechar painel' }).first().click()
      await badge.click()
      const pop = page.getByTestId('auto-approve-popover')
      await pop.waitFor()
      // 8 itens + 3 de memória (Gravar, Reescrever e Apagar memória)
      assert((await pop.getByTestId('auto-approve-item').count()) === 11, '11 itens')
      await pop.getByText('fake/judge-1'.split('/').pop()!).waitFor()
      assert((await pop.getByRole('switch').count()) === 0, 'sem liga/desliga no popover')
      await sleep(400) // animação de entrada
      await shot('header-popover')
      await pop.getByRole('button', { name: 'Revogar Páginas' }).click()
      await sleep(300)
      const cfg = (await chatState()).chat.config
      assert(cfg.approvalModes?.pages === undefined, `revogou ${JSON.stringify(cfg.approvalModes)}`)
      assert(cfg.approvalModes?.commands === 'smart', 'comandos continuam smart')
      await badge.getByText('Smart-Approve').waitFor()
      await pop.getByRole('button', { name: /Configurações → Aprovações/ }).waitFor()
      // "Ajustar neste chat" abre o painel na seção Aprovações (aberta)
      await pop.getByRole('button', { name: /Ajustar neste chat/ }).click()
      await panel.locator('[data-collapse-id="approvals"][data-open]').waitFor()
      // sem modelo: o selo some (nada roda sem você) e o modo smart pergunta (fail-closed)
      await openToolsTab()
      await section().getByRole('button', { name: 'Remover modelo do Smart-Approve' }).click()
      await badge.waitFor({ state: 'detached', timeout: 5000 })
      await page.getByRole('button', { name: 'Fechar painel' }).first().click()
      const before = judgeHits().length
      await sendMessage('rode: expr SA-SEM-JUIZ')
      const card = bashCards().last()
      await card.getByRole('button', { name: 'Negar', exact: true }).waitFor({ timeout: 15_000 })
      await card
        .getByTestId('smart-missing')
        .getByText(/Configure o modelo do Smart-Approve/)
        .waitFor()
      assert((await card.getByTestId('smart-approve-line').count()) === 0, 'sem linha do juiz')
      await shotOf(card, 'card-smart-sem-juiz')
      await card.getByRole('button', { name: 'Negar', exact: true }).click()
      await waitIdle()
      assert(judgeHits().length === before, 'juiz não chamado')
    }
  )

  await step('personas: o editor de Tools mostra o Smart-Approve', async () => {
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
    await dlg
      .getByRole('button', { name: /Editar/ })
      .first()
      .click()
    await dlg
      .getByRole('tab', { name: 'Tools' })
      .or(dlg.getByRole('button', { name: 'Tools', exact: true }))
      .first()
      .click()
    await expand(dlg, 'approvals')
    await expand(dlg, 'smart-approve')
    const s = dlg.locator('section[data-section="smart-approve"]')
    await s.scrollIntoViewIfNeeded()
    await s.getByText(/Escolha um modelo para poder usar o modo Smart-Approve/).waitFor()
    // mesmo seletor com ★ no editor de personas; Smart desabilitado sem modelo
    const cmd = dlg.getByTestId('chat-mode-commands')
    assert(
      (await cmd.getByRole('radio', { name: 'Smart-Approve' }).getAttribute('aria-disabled')) ===
        'true',
      'persona: Smart desabilitado sem modelo'
    )
    assert((await cmd.locator('[data-global]').count()) === 1, 'persona: ★ no padrão global')
    await page.keyboard.press('Escape')
  })

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
