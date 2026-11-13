/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E das skills no app real (Playwright `_electron`), 100% local: um provedor OpenAI-compatible
// FALSO servido pelo próprio teste em 127.0.0.1 roteiriza o agente (list_skills → skill_load →
// skill_read; delegate_task para os subagentes). userData isolado (CLEARCHAT_USER_DATA) e HOME
// temporária — a pasta padrão `~/.claude/skills` resolve dentro dela; o ~/.claude/skills real e o
// ~/.config/ClearChat nunca são tocados. Nenhuma key real.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   npm run build
//   CLEARCHAT_E2E_DIR=/tmp/algum-dir node e2e/skills.spec.ts [filtro]
//
// Cobre: Configurações → Skills (locais, padrão, precedência/sobrescrita, inválida com erro, preview
// do SKILL.md, projeto); chat com skills → o modelo chama list_skills / skill_load / skill_read
// (prompt de apoio + tools na request, cards); skills desligadas → nada na request; lâmpada →
// picker → chip → mensagem com o part <skill> (sem `_skill` na request) e card; fila; erro legível
// com skill inexistente; subagentes com/sem skills; seção na aba Tools. Screenshots em $BASE/shots.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { elementShot } from './uiHelpers.ts'

const AGENT = 'fake/agent'
const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-skills-e2e'))
const USER_DATA = join(BASE, 'userdata')
const HOME = join(BASE, 'home')
const CWD = join(BASE, 'cwd')
const EXTRA = join(BASE, 'extra-skills')
const SHOTS = join(BASE, 'shots')
const FILTER = process.argv[2] ?? ''
const SKILL_TOOLS = ['list_skills', 'skill_load', 'skill_read']

// ---------------- skills de teste ----------------

function skill(
  base: string,
  dir: string,
  fm: string,
  body: string,
  files: Record<string, string> = {}
): string {
  const d = join(base, dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\n${fm}\n---\n\n${body}`)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true })
    writeFileSync(join(d, p), c)
  }
  return d
}

function makeSkills(): void {
  const personal = join(HOME, '.claude', 'skills')
  skill(
    personal,
    'pdf',
    'name: pdf\ndescription: Extrai texto e tabelas de PDFs, preenche formulários e junta arquivos. Use sempre que houver PDFs.\nlicense: Apache-2.0\nallowed-tools: Bash(python3:*) Read',
    '# PDF\n\n1. Leia references/guia.md.\n2. Rode `python3 scripts/extract.py arquivo.pdf`.\n',
    {
      'scripts/extract.py': 'import sys\nprint("extraído", sys.argv[1:])\n',
      'references/guia.md': '# Guia\n\nMARCADOR-GUIA: use pdftotext -layout.\n'
    }
  )
  skill(personal, 'comum', 'name: comum\ndescription: Versão pessoal (vence)', 'pessoal\n')
  skill(EXTRA, 'comum', 'name: comum\ndescription: Versão extra (sobrescrita)', 'extra\n')
  skill(
    EXTRA,
    'planilhas',
    'name: planilhas\ndescription: Planilhas xlsx e csv: fórmulas, gráficos e limpeza de dados.',
    'xlsx\n'
  )
  skill(EXTRA, 'quebrada', 'name: quebrada', 'sem description\n')
  skill(
    join(CWD, '.claude', 'skills'),
    'projeto-x',
    'name: projeto-x\ndescription: Convenções do projeto X (commits, testes).',
    'projeto\n'
  )
}

// ---------------- provedor falso ----------------

const hits: any[] = []
let server: Server | null = null
let fakeBase = ''
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}

async function startFake(): Promise<void> {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [{ id: AGENT, context_length: 64_000, supported_parameters: ['tools'] }]
          })
        )
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push(body)
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = textOf([...msgs].reverse().find((m) => m.role === 'user')?.content)
      const firstUser = textOf(msgs.find((m) => m.role === 'user')?.content)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const chunk = (delta: any, finish?: string): string =>
        `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 80, completion_tokens: 6 } } : {}) })}\n\n`
      const text = (t: string): void => {
        res.write(chunk({ role: 'assistant', content: t }))
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
      }
      const call = (name: string, args: any): void => {
        res.write(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${hits.length}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) }
              }
            ]
          })
        )
        res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
      }
      if (/^subtarefa/.test(firstUser)) return text('SUB OK')
      if (last?.role === 'tool') {
        const prev = [...msgs].reverse().find((m) => m.role === 'assistant' && m.tool_calls)
        const tool = prev?.tool_calls?.[0]?.function?.name
        if (/^use skills/.test(lastUser)) {
          if (tool === 'list_skills') return call('skill_load', { name: 'pdf' })
          if (tool === 'skill_load')
            return call('skill_read', { name: 'pdf', path: 'references/guia.md' })
        }
        return text(`FIM: ${textOf(last.content).slice(0, 80)}`)
      }
      if (/^use skills/.test(lastUser)) return call('list_skills', {})
      if (/^delegue/.test(lastUser)) return call('delegate_task', { task: 'subtarefa: confira' })
      if (/^devagar/.test(lastUser)) {
        res.write(chunk({ role: 'assistant', content: 'pensando…' }))
        await new Promise((r) => setTimeout(r, 1500))
        res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      return text('ok')
    })()
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  fakeBase = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

// ---------------- infra ----------------

let app: ElectronApplication
let page: Page
const results: { name: string; ok: boolean; info?: string; ms: number }[] = []
let shotN = 0

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.OPENROUTER_API_KEY
  env.CLEARCHAT_USER_DATA = USER_DATA
  env.HOME = HOME
  env.CLEARCHAT_SKIP_SHELL_ENV = '1'
  app = await electron.launch({ args: [ROOT], env, timeout: 60_000 })
  const log = createWriteStream(join(BASE, 'main.log'), { flags: 'a' })
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 820)
  )
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
    await sleep(100)
  }
}

async function waitIdle(chatId: string, sessionId: string): Promise<void> {
  await sleep(150)
  await waitFor(
    async () => {
      if ((await api<string[]>('agent.runningSessions')).includes(sessionId)) return null
      const s = (await api<any[]>('sessions.list', chatId)).find((x) => x.id === sessionId)
      return s && (s.status === 'idle' || s.status === 'done')
    },
    20_000,
    'sessão ociosa'
  )
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`asserção falhou: ${msg}`)
}

async function shot(name: string, el?: ReturnType<Page['locator']>): Promise<void> {
  await page.waitForTimeout(300)
  const path = join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`)
  // nunca el.screenshot(): elemento maior que a janela redimensiona a viewport (ver uiHelpers)
  if (el) await elementShot(page, el, path)
  else await page.screenshot({ path })
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (FILTER && !FILTER.split(',').some((f) => name.includes(f.trim()))) return
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined, ms: Date.now() - t0 })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''} (${Date.now() - t0}ms)`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message, ms: Date.now() - t0 })
    console.log(`✖ ${name} — ${(e as Error).message.split('\n').slice(0, 3).join('\n')}`)
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_').slice(0, 40)}`)
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
    } catch {
      /* */
    }
  }
}

const skillsOn = (over: any = {}): any => ({
  enabled: true,
  disabled: [],
  supportPrompt: { enabled: true, text: null },
  subagents: false,
  ...over
})
const toolNames = (b: any): string[] => (b.tools ?? []).map((t: any) => t.function.name)

async function openChatUi(title: string): Promise<void> {
  await page.getByTestId('chat-item').filter({ hasText: title }).first().click()
  await page.getByTestId('composer-column').waitFor()
}

async function ensurePanelTab(tab: string): Promise<void> {
  const t = page.getByTestId('right-panel').getByRole('tab', { name: tab, exact: true })
  if (!(await t.count())) await page.getByRole('button', { name: 'Abrir painel' }).click()
  await t.click()
}

/** Abre a seção recolhível `id` do painel/editor (CollapsibleSection), se estiver fechada. */
async function expand(scope: ReturnType<Page['locator']>, id: string): Promise<void> {
  const btn = scope.getByTestId(`collapse-${id}`)
  await btn.scrollIntoViewIfNeeded()
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click()
  await scope.locator(`[data-collapse-id="${id}"][data-open]`).waitFor()
}

// ---------------- passos ----------------

async function main(): Promise<void> {
  rmSync(BASE, { recursive: true, force: true })
  for (const d of [USER_DATA, HOME, CWD, EXTRA, SHOTS]) mkdirSync(d, { recursive: true })
  makeSkills()
  await startFake()
  await launch()

  let providerId = ''
  const newChat = async (title: string, skills: any, enabledTools: string[] = []): Promise<any> =>
    api('chats.create', {
      title,
      config: { providerId, model: AGENT, cwd: CWD, enabledTools, skills }
    })

  await step(
    'setup: provedor falso; pasta padrão (~/.claude/skills na HOME temporária) + pasta extra',
    async () => {
      providerId = (
        await api('providers.create', { name: 'Local', baseUrl: fakeBase, apiKey: 'k' })
      ).id
      const s0 = await api('skills.getSettings')
      assert(s0.locations.length === 1 && s0.locations[0].path === '~/.claude/skills', 'padrão')
      assert(s0.projectSkills === true, 'projeto ligado por padrão')
      const s1 = await api('skills.updateSettings', {
        locations: [...s0.locations, { id: 'extra', path: EXTRA, enabled: true }]
      })
      assert(s1.locations.length === 2, 'local extra salvo')
      // com o provedor criado, recarrega a UI (sai do onboarding)
      await page.reload()
      await page.waitForFunction(() => !!(window as any).api, null, { timeout: 30_000 })
      await page.getByRole('button', { name: 'Configurações' }).first().waitFor()
    }
  )

  await step('descoberta: precedência, sobrescrita, inválida, projeto', async () => {
    const d = await api('skills.discover', { cwd: CWD, counts: true })
    const [personal, extra, proj] = d.locations
    assert(
      personal.resolved === join(HOME, '.claude', 'skills'),
      `~ expandido na HOME temporária: ${personal.resolved}`
    )
    assert(proj?.kind === 'project', 'projeto por último')
    assert(
      JSON.stringify(d.skills.map((s: any) => s.name)) ===
        JSON.stringify(['comum', 'pdf', 'planilhas', 'projeto-x']),
      `efetivas: ${d.skills.map((s: any) => s.name)}`
    )
    assert(
      extra.skills.find((s: any) => s.name === 'comum').shadowedBy === '~/.claude/skills',
      'sobrescrita'
    )
    assert(
      /description/.test(extra.skills.find((s: any) => s.name === 'quebrada').error),
      'inválida com erro'
    )
    assert(personal.skills.find((s: any) => s.name === 'pdf').files === 3, 'contagem de arquivos')
  })

  await step(
    'UI: Configurações → Skills (locais, sobrescrita, inválida, preview do SKILL.md)',
    async () => {
      await page.getByRole('button', { name: 'Configurações' }).first().click()
      const dlg = page.locator('[role="dialog"]')
      await dlg.getByRole('button', { name: 'Skills', exact: true }).click()
      await dlg.getByTestId('skills-settings').waitFor()
      await dlg.getByTestId('skills-location').first().waitFor()
      assert((await dlg.getByTestId('skills-location').count()) === 2, '2 locais')
      await dlg.getByTestId('skill-shadowed').first().waitFor()
      assert(
        /sobrescrita por ~\/\.claude\/skills/.test(
          await dlg.getByTestId('skill-shadowed').first().innerText()
        ),
        'selo'
      )
      assert(
        /description/.test(await dlg.getByTestId('skill-error').first().innerText()),
        'erro da inválida'
      )
      await dlg.locator('[data-testid="skill-row"][data-skill="pdf"] > button').click()
      const prev = dlg.getByTestId('skill-preview')
      await prev.waitFor()
      await waitFor(async () => /# PDF/.test(await prev.innerText()), 5000, 'conteúdo do SKILL.md')
      assert(
        /license/.test(await prev.innerText()) && /allowed-tools/.test(await prev.innerText()),
        'campos'
      )
      await shot('settings-skills')
      await page.keyboard.press('Escape')
      await dlg.waitFor({ state: 'detached' })
    }
  )

  await step(
    'chat com skills: list_skills → skill_load → skill_read; prompt de apoio + tools na request',
    async () => {
      const chat = await newChat('Skills em ação', skillsOn(), ['read_file', 'shell'])
      const n0 = hits.length
      await api('agent.send', chat.mainSessionId, 'use skills para ler o PDF')
      await waitIdle(chat.id, chat.mainSessionId)
      const first = hits[n0]
      // tools compactadas (padrão, 1.11.0): as de skills vão compactas + a search_tool no fim, e o
      // roteiro list_skills → skill_load → skill_read roda com elas
      assert(
        JSON.stringify(toolNames(first)) ===
          JSON.stringify(['read_file', 'shell', ...SKILL_TOOLS, 'search_tool']),
        `tools: ${toolNames(first)}`
      )
      assert(
        JSON.stringify(first.tools[2].function.parameters) === '{"type":"object","properties":{}}',
        'list_skills compacta'
      )
      const sys = textOf(first.messages[0].content)
      assert(
        sys.includes('Você tem acesso a skills') && sys.includes('list_skills'),
        'prompt de apoio'
      )
      assert(
        !sys.includes('projeto-x') && !JSON.stringify(first.tools).includes('projeto-x'),
        'nenhuma lista de skills no contexto'
      )
      const msgs = await api<any[]>('sessions.messages', chat.mainSessionId)
      const tools = msgs
        .filter((m) => m.message.role === 'tool')
        .map((m) => textOf(m.message.content))
      assert(tools.length === 3, `3 resultados: ${tools.length}`)
      assert(
        /^\[4 skills disponíveis neste chat\]/.test(tools[0]) && /- projeto-x — /.test(tools[0]),
        'list_skills'
      )
      assert(
        tools[1].startsWith(`<skill name="pdf" path="${join(HOME, '.claude', 'skills', 'pdf')}">`),
        'skill_load'
      )
      assert(/Arquivos \(3\)/.test(tools[1]) && /scripts\/extract\.py/.test(tools[1]), 'arquivos')
      assert(/MARCADOR-GUIA/.test(tools[2]) && /^1\t# Guia/.test(tools[2]), 'skill_read')
      // a definição das tools é a mesma em todos os passos (cache)
      const defs = hits.slice(n0).map((h) => JSON.stringify(h.tools))
      assert(new Set(defs).size === 1, 'tools estáveis')
      await openChatUi('Skills em ação')
      await page.getByTestId('skill-tool-body').first().waitFor()
      assert((await page.getByTestId('skill-tool-body').count()) === 3, 'cards')
      await shot('skill-tool-cards')
    }
  )

  await step('skills desligadas → nada de skills na request', async () => {
    const chat = await newChat('Sem skills', { ...skillsOn(), enabled: false, subagents: true }, [
      'read_file'
    ])
    const n0 = hits.length
    await api('agent.send', chat.mainSessionId, 'olá')
    await waitIdle(chat.id, chat.mainSessionId)
    const b = hits[n0]
    assert(JSON.stringify(toolNames(b)) === '["read_file","search_tool"]', `tools: ${toolNames(b)}`)
    assert(!textOf(b.messages[0]?.content).includes('list_skills'), 'sem prompt de apoio')
    // lâmpada só com skills ligadas
    await openChatUi('Sem skills')
    assert((await page.getByTestId('skill-picker-button').count()) === 0, 'sem lâmpada')
  })

  await step('UI: seção Skills na aba Tools (checklist, prompt de apoio, subagentes)', async () => {
    await openChatUi('Skills em ação')
    await ensurePanelTab('Tools')
    const sec = page.getByTestId('skills-panel')
    await sec.scrollIntoViewIfNeeded()
    // checklist, prompt de apoio e subagentes ficam em "Ajustes das skills" (recolhido)
    await expand(sec, 'skills-details')
    await sec.getByTestId('skills-checklist').waitFor()
    assert((await sec.locator('[data-skill]').count()) === 4, '4 skills na lista')
    // desliga "planilhas" neste chat
    await sec.getByRole('switch', { name: 'Skill planilhas' }).click()
    await waitFor(
      async () => {
        const c = (await api<any[]>('chats.list')).find((x) => x.title === 'Skills em ação')
        return c?.config.skills?.disabled?.includes('planilhas')
      },
      5000,
      'planilhas desligada salva'
    )
    await expand(page.getByTestId('right-panel'), 'subagents')
    const line = page.getByTestId('subagent-skills')
    assert(/desligadas/.test(await line.innerText()), 'linha de subagentes')
    await shot('chat-skills-section', page.getByTestId('right-panel'))
  })

  await step(
    'lâmpada → picker → chip → mensagem com part <skill> (sem _skill) e card',
    async () => {
      await openChatUi('Skills em ação')
      const n0 = hits.length
      await page.getByTestId('skill-picker-button').click()
      const picker = page.getByTestId('skill-picker')
      await picker.waitFor()
      assert(!(await picker.locator('[data-skill="planilhas"]').count()), 'desligada não aparece')
      await page.getByRole('textbox', { name: 'Buscar skill' }).fill('pdf')
      await shot('skill-picker')
      await page.keyboard.press('Enter')
      const chip = page.getByTestId('skill-chip')
      await chip.waitFor()
      assert((await chip.getAttribute('data-skill')) === 'pdf', 'chip')
      await page.getByPlaceholder(/Mensagem/).fill('resuma o documento')
      await shot('skill-chip', page.getByTestId('composer-column'))
      await page.getByRole('button', { name: 'Enviar', exact: true }).click()
      await waitFor(async () => hits.length > n0, 10_000, 'request')
      const chat = (await api<any[]>('chats.list')).find((x) => x.title === 'Skills em ação')
      await waitIdle(chat.id, chat.mainSessionId)
      const req = hits[n0]
      const user = [...req.messages].reverse().find((m: any) => m.role === 'user')
      assert(Array.isArray(user.content) && user.content.length === 2, 'dois parts')
      const dir = join(HOME, '.claude', 'skills', 'pdf')
      assert(
        user.content[0].text.startsWith(`<skill name="pdf" path="${dir}">\n---\nname: pdf\n`),
        'bloco <skill>'
      )
      assert(user.content[0].text.endsWith('</skill>'), 'fecha')
      assert(user.content[1].text === 'resuma o documento', 'texto depois')
      assert(!JSON.stringify(req).includes('"_skill"'), '_skill removido')
      const msgs = await api<any[]>('sessions.messages', chat.mainSessionId)
      const stored = [...msgs].reverse().find((m) => m.message.role === 'user')
      assert(stored.message.content[0]._skill?.name === 'pdf', '_skill persistido')
      assert(
        stored.message.content[0].text === user.content[0].text,
        'texto exato igual ao enviado'
      )
      const card = page.getByTestId('skill-part').last()
      await card.waitFor()
      assert(/Skill carregada: pdf/.test(await card.innerText()), 'card')
      assert((await page.getByTestId('skill-chip').count()) === 0, 'chip some após enviar')
      await card.scrollIntoViewIfNeeded()
      await shot('skill-card')
    }
  )

  await step('fila: mensagem com skill enfileirada entra com o part <skill>', async () => {
    const chat = await newChat('Fila skills', skillsOn())
    await api('agent.send', chat.mainSessionId, 'devagar')
    await sleep(300)
    const r = await api('agent.send', chat.mainSessionId, '', [], ['planilhas'])
    assert(r.queued === true, 'enfileirada')
    const q = await api<any[]>('agent.getQueue', chat.mainSessionId)
    assert(q[0]?.skillParts?.[0]?._skill?.name === 'planilhas', 'na fila com o part')
    await waitIdle(chat.id, chat.mainSessionId)
    const msgs = await api<any[]>('sessions.messages', chat.mainSessionId)
    const queued = msgs.find((m) => m.meta.kind === 'queued')
    assert(
      queued && /<skill name="planilhas"/.test(queued.message.content[0].text),
      'entregue com o part'
    )
  })

  await step('erro legível: skill inexistente → nada enviado', async () => {
    const chat = await newChat('Erro skills', skillsOn())
    let err = ''
    try {
      await api('agent.send', chat.mainSessionId, 'oi', [], ['nao-existe'])
    } catch (e) {
      err = (e as Error).message
    }
    assert(/Skill "nao-existe" não está disponível/.test(err), `erro: ${err}`)
    const msgs = await api<any[]>('sessions.messages', chat.mainSessionId)
    assert(msgs.length === 0, 'nada persistido')
    const off = await newChat('Erro off', { ...skillsOn(), enabled: false })
    try {
      await api('agent.send', off.mainSessionId, 'oi', [], ['pdf'])
      err = ''
    } catch (e) {
      err = (e as Error).message
    }
    assert(/desligadas neste chat/.test(err), `desligadas: ${err}`)
  })

  await step(
    'subagentes: sem skills por padrão; com `subagents` recebem as mesmas tools + prompt',
    async () => {
      for (const subagents of [false, true]) {
        const chat = await newChat(`Sub ${subagents}`, skillsOn({ subagents }), ['delegate_task'])
        const n0 = hits.length
        await api('agent.send', chat.mainSessionId, 'delegue algo')
        await waitIdle(chat.id, chat.mainSessionId)
        const sub = hits
          .slice(n0)
          .find((h) =>
            /^subtarefa/.test(textOf(h.messages.find((m: any) => m.role === 'user')?.content))
          )
        assert(sub, 'request do subagente')
        const has = toolNames(sub).includes('skill_load')
        const sys = textOf(sub.messages[0]?.content)
        assert(has === subagents, `subagents=${subagents}: tools ${toolNames(sub)}`)
        assert(
          sys.includes('Você tem acesso a skills') === subagents,
          'prompt de apoio no subagente'
        )
      }
      await openChatUi('Sub true')
      await ensurePanelTab('Tools')
      await expand(page.getByTestId('right-panel'), 'subagents')
      assert(
        /ligadas/.test(await page.getByTestId('subagent-skills').innerText()),
        'linha: ligadas'
      )
    }
  )

  await step('persona: seção Skills no editor', async () => {
    await page.getByRole('button', { name: 'Configurações' }).first().click()
    const dlg = page.locator('[role="dialog"]')
    await dlg.getByRole('button', { name: 'Personas', exact: true }).click()
    await dlg
      .getByRole('button', { name: /Editar/ })
      .first()
      .click()
    await dlg.getByRole('tab', { name: 'Tools' }).click()
    await dlg.getByTestId('preset-skills').waitFor()
    await page.keyboard.press('Escape')
  })

  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${results.length - failed.length}/${results.length} passos ok · screenshots em ${SHOTS}`
  )
  await app.close()
  server?.close()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  try {
    await app?.close()
  } catch {
    /* */
  }
  server?.close()
  process.exit(1)
})
