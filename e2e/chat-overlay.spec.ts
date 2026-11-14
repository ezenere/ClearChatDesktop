// E2E do layout do chat com o composer FLUTUANTE contra o MOCK de UI (Playwright `_electron`,
// sem backend, sem key): o scroller ocupa a área toda do chat e a pilha de baixo (banner de
// contexto, fila, pendências, composer) fica por cima dele, sobre um degradê. Para cada estado da
// pilha confere, em 1280x820 (painel aberto e fechado) e 900x600:
//   - o scroller vai até o fim da área do chat (o composer está DENTRO do retângulo dele);
//   - a pilha está inteira visível e clicável (cada botão/campo responde ao hit-test);
//   - o padding do fim da lista = altura da pilha + 24px, e no fim a última mensagem fica acima dela;
//   - o "ir para o fim" fica logo acima da pilha, sem nada por cima.
// Estados: composer vazio / multi-linha (altura máxima, rola por dentro), lista vazia, anexos +
// aviso de modalidade, fila (vários chips), faixa de aprovações (1 e várias, subagentes) e card
// inline (Sim / Sim + whitelist / Não / Não + blacklist), questionário (várias perguntas; opções
// longas com imagens), falha de conexão, rodando (Parar) com rascunho crescendo preso ao fim,
// subsessão (banner), Smart-Approve avaliando, card de extração, banner de contexto (+ dispensar)
// e as transições entre eles. Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-overlay-e2e node e2e/chat-overlay.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-overlay-e2e'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''

let app: ElectronApplication
let page: Page
let stopped = false
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(200)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (stopped) return
  try {
    const info = await fn()
    results.push({ name, ok: true, info: info || undefined })
    console.log(`✔ ${name}${info ? ` — ${info}` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, info: (e as Error).message })
    console.log(
      `✖ ${name} — ${(e as Error).message
        .split('\n')
        .slice(0, process.env.E2E_VERBOSE ? 30 : 3)
        .join('\n')}`
    )
    try {
      await shot(`FAIL-${name.replace(/[^\w]+/g, '_')}`)
    } catch {
      /* */
    }
  }
  if (STOP_AFTER && name.includes(STOP_AFTER)) stopped = true
}

async function setSize(w: number, h: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [w, h]
  )
  await page.waitForTimeout(350)
}

async function panel(open: boolean): Promise<void> {
  const isOpen = await page.getByTestId('right-panel').isVisible()
  if (isOpen === open) return
  await page
    .getByRole('banner')
    .getByRole('button', { name: open ? 'Abrir painel' : 'Fechar painel' })
    .click()
  await page.waitForTimeout(300)
}

/** Recarrega o renderer em outro cenário do mock (estado do mock zerado) e abre o chat. */
async function open(scenario: string, chat: string): Promise<void> {
  await page.evaluate((s) => {
    location.search = `?scenario=${s}`
  }, scenario)
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('chat-item').filter({ hasText: chat }).first().click()
  await page.getByTestId('chat-scroller').waitFor()
  await page.waitForTimeout(500)
}

const frames = (n = 3): Promise<void> =>
  page.evaluate(
    (n) =>
      new Promise<void>((r) => {
        const f = (i: number): void => {
          if (i <= 0) r()
          else requestAnimationFrame(() => f(i - 1))
        }
        f(n)
      }),
    n
  )

async function toBottom(): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
    el.scrollTop = el.scrollHeight
  })
  await frames(4)
  await page.waitForTimeout(150)
  // a pilha pode mudar ao rolar (aprovação volta ao card) → rola de novo
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
    el.scrollTop = el.scrollHeight
  })
  await frames(4)
}

interface Geo {
  stage: DOMRectJSON
  sc: DOMRectJSON
  stack: DOMRectJSON
  padding: number
  contentBottom: number
  lastBottom: number
  atBottom: boolean
  blocked: string[]
  checked: number
  overflowX: boolean
}
type DOMRectJSON = { top: number; bottom: number; left: number; right: number; height: number }

/** Geometria do chat + hit-test de cada controle da pilha de baixo. */
function geo(): Promise<Geo> {
  return page.evaluate(() => {
    const q = (s: string): HTMLElement => document.querySelector<HTMLElement>(s)!
    const r = (el: Element): DOMRectJSON => {
      const b = el.getBoundingClientRect()
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height }
    }
    const stage = q('[data-testid=chat-stage]')
    const sc = q('[data-testid=chat-scroller]')
    const stack = q('[data-testid=composer-stack]')
    const inner = sc.firstElementChild as HTMLElement
    const pad = parseFloat(getComputedStyle(inner).paddingBottom)
    const ib = inner.getBoundingClientRect()
    let lastBottom = -Infinity
    for (const c of inner.children) {
      const b = c.getBoundingClientRect()
      if (b.height > 0) lastBottom = Math.max(lastBottom, b.bottom)
    }
    // hit-test: o centro de cada controle visível da pilha responde a ele mesmo
    const blocked: string[] = []
    let checked = 0
    const col = q('[data-testid=composer-column]')
    for (const el of col.querySelectorAll<HTMLElement>('button, textarea, input, [role=button]')) {
      const b = el.getBoundingClientRect()
      if (b.width < 2 || b.height < 2) continue
      if (getComputedStyle(el).visibility === 'hidden') continue
      const x = b.left + b.width / 2
      const y = b.top + b.height / 2
      // fora da área visível de um container com rolagem própria (lista do questionário etc.)
      let clipped = false
      for (let p = el.parentElement; p && p !== col; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY
        if (o === 'auto' || o === 'scroll' || o === 'hidden') {
          const pb = p.getBoundingClientRect()
          if (y < pb.top || y > pb.bottom || x < pb.left || x > pb.right) clipped = true
        }
      }
      if (clipped) continue
      checked++
      const hit = document.elementFromPoint(x, y)
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el)))
        blocked.push(
          `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24)}] → ${hit?.tagName.toLowerCase()}.${String(hit?.className).slice(0, 40)}`
        )
    }
    return {
      stage: r(stage),
      sc: r(sc),
      stack: r(stack),
      padding: pad,
      contentBottom: ib.bottom - pad,
      lastBottom,
      atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 2,
      blocked,
      checked,
      overflowX: document.documentElement.scrollWidth > window.innerWidth
    }
  })
}

/** Confere a pilha sobre a lista (rolada até o fim) e o botão "ir para o fim". */
async function checkOverlay(label: string, opts: { scrollBtn?: boolean } = {}): Promise<string> {
  await toBottom()
  const g = await geo()
  const near = (a: number, b: number, tol = 1.5): boolean => Math.abs(a - b) <= tol
  assert(near(g.sc.bottom, g.stage.bottom), `${label}: scroller termina no fim da área do chat`)
  assert(near(g.sc.top, g.stage.top), `${label}: scroller começa no topo da área do chat`)
  assert(
    g.stack.left >= g.sc.left - 1 &&
      g.stack.right <= g.sc.right + 1 &&
      g.stack.bottom <= g.sc.bottom + 1 &&
      g.stack.top >= g.sc.top - 1,
    `${label}: pilha dentro do retângulo do scroller (${JSON.stringify({ sc: g.sc, st: g.stack })})`
  )
  assert(near(g.stack.bottom, g.stage.bottom), `${label}: pilha colada no fim`)
  assert(g.checked > 0, `${label}: nenhum controle da pilha conferido`)
  assert.deepEqual(g.blocked, [], `${label}: controles da pilha cobertos`)
  assert(
    near(g.padding, g.stack.height + 24, 2),
    `${label}: padding do fim ${g.padding} ≠ pilha ${g.stack.height} + 24`
  )
  assert(g.atBottom, `${label}: rolou até o fim`)
  assert(
    g.lastBottom <= g.stack.top + 1,
    `${label}: última mensagem (${g.lastBottom}) acima da pilha (${g.stack.top})`
  )
  assert(!g.overflowX, `${label}: sem scroll horizontal`)
  let btn = ''
  if (opts.scrollBtn !== false) {
    const scrollable = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
      return el.scrollHeight - el.clientHeight > 150
    })
    if (scrollable) {
      await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
        el.scrollTop = Math.max(0, el.scrollTop - 150)
      })
      const b = page.getByTestId('scroll-to-bottom')
      await b.waitFor({ timeout: 3000 })
      await frames(3)
      const hit = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid=scroll-to-bottom]')!
        const st = document.querySelector<HTMLElement>('[data-testid=composer-stack]')!
        const r = el.getBoundingClientRect()
        const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return {
          ok: !!h && (h === el || el.contains(h)),
          gap: st.getBoundingClientRect().top - r.bottom
        }
      })
      assert(hit.ok, `${label}: "ir para o fim" coberto`)
      assert(
        hit.gap >= 0 && hit.gap <= 24,
        `${label}: "ir para o fim" logo acima da pilha (${hit.gap})`
      )
      await b.click()
      await page.waitForTimeout(700)
      assert((await geo()).atBottom, `${label}: "ir para o fim" voltou ao fim`)
      btn = ' · botão ok'
    }
  }
  return `pilha ${Math.round(g.stack.height)}px · ${g.checked} controles${btn}`
}

/** checkOverlay + screenshot em 1280x820 (painel aberto/fechado) e 900x600 (fechado). */
async function matrix(
  name: string,
  opts: { scrollBtn?: boolean; drawerShot?: boolean } = {}
): Promise<string> {
  const out: string[] = []
  for (const [w, h, p] of [
    [1280, 820, true],
    [1280, 820, false],
    [900, 600, false]
  ] as const) {
    await setSize(w, h)
    await panel(p)
    const tag = `${name}-${w}x${h}${p ? '-panel' : ''}`
    out.push(`${w}x${h}${p ? '+painel' : ''}: ${await checkOverlay(tag, opts)}`)
    await toBottom()
    await shot(tag)
  }
  if (opts.drawerShot) {
    await panel(true)
    await shot(`${name}-900x600-drawer`)
    await panel(false)
  }
  await setSize(1280, 820)
  return out.join(' | ')
}

/** Rola até o meio e fotografa o conteúdo passando sob o degradê/composer. */
async function midShot(name: string, fromBottom = 220): Promise<void> {
  await page.evaluate((d) => {
    const el = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - d)
  }, fromBottom)
  await frames(3)
  await shot(name)
}

// o renderer tem CSP sem eval: o corpo vai como expressão do DevTools (Runtime.evaluate)
const store = <T>(fn: string, arg?: unknown): Promise<T> =>
  page.evaluate(
    `((s, emit, arg) => { ${fn} })(window.__clearStore, window.__clearMockEmit, ${JSON.stringify(arg ?? null)})`
  ) as Promise<T>

const currentSession = (): Promise<string> =>
  store<string>(`const v = s.getState().view; return v.kind === 'chat' ? v.sessionId : ''`)

const TABLES_MD = [
  'Comparação dos candidatos:',
  '',
  '| | Candidato A | Candidato B |',
  '|---|---|---|',
  '| Trajetória | Vereador por dois mandatos, depois deputado estadual; atuou na comissão de orçamento e presidiu a frente parlamentar de mobilidade urbana. | Empresária do setor de logística, sem cargo eletivo anterior; foi secretária municipal de desenvolvimento econômico por três anos. |',
  '| Ficha criminal | Nenhuma condenação; responde a um inquérito sobre doações de campanha, ainda sem denúncia. | Nenhuma condenação nem processo em andamento segundo o TSE e o TJ. |',
  '| Chapa | Coligação de quatro partidos de centro-esquerda, vice do mesmo partido. | Partido único, vice independente indicado por movimento cívico. |',
  '| Propostas | Tarifa zero no transporte aos domingos, ampliação de creches em tempo integral e revisão do plano diretor. | Parcerias público-privadas para saneamento, digitalização dos serviços municipais e redução do IPTU para pequenos comércios. |',
  '',
  'Tabela larga:',
  '',
  '| Região | População | PIB per capita | IDH | Escolaridade média | Desemprego | Observações |',
  '|---|---|---|---|---|---|---|',
  '| Norte | 18,9 milhões | R$ 29.100 | 0,730 | 8,9 anos | 9,8% | Grande dependência do setor público e da mineração. |',
  '| Nordeste | 54,6 milhões | R$ 21.300 | 0,710 | 8,4 anos | 11,2% | Crescimento recente do turismo e das energias renováveis. |',
  '| Sudeste | 84,8 milhões | R$ 51.200 | 0,794 | 10,1 anos | 7,9% | Concentra a indústria e os serviços financeiros. |',
  '',
  'Links e código:',
  '',
  '| Recurso | Endereço | Comando |',
  '|---|---|---|',
  '| Documentação | https://example.com/uma/url/muito/comprida/que/nao/tem/espacos/nenhum/para/quebrar/linha?com=parametros&e=mais | `npx electron-vite build --outDir /tmp/um/caminho/bem/comprido/sem/espacos` |',
  '| Repositório | [github.com/ezenere/clearchat](https://github.com/ezenere/clearchat) | `npm run test:unit` |'
].join('\n')

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR4nGNkYPj/n4ECwESJ5lEDRg0YNWDUgFEDRg0YNWDUgFEDRg0YNWDUAMoNAAAm5gIdmAUyNQAAAABJRU5ErkJggg=='

async function main(): Promise<void> {
  rmSync(SHOTS, { recursive: true, force: true })
  mkdirSync(SHOTS, { recursive: true })
  if (!process.env.SKIP_BUILD) {
    execSync(`npx electron-vite build --outDir "${BUILD}"`, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_CLEAR_MOCK: '1' }
    })
  }
  const mainJs = join(BASE, 'mock-main.cjs')
  writeFileSync(
    mainJs,
    `const { app, BrowserWindow } = require('electron')
// nunca o microfone real: dispositivo falso do Chromium
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.setPath('userData', ${JSON.stringify(join(BASE, 'user-data'))})
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 820, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  // o mouse de verdade não interfere (o Playwright injeta eventos pelo DevTools)
  win.setIgnoreMouseEvents(true)
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))}, { search: 'scenario=chat' })
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await setSize(1280, 820)

  await step(
    'processos: chip verde → neutro (aviso de falha) → Remover o último some',
    async () => {
      await open('processes', 'Refatorar o parser')
      const badge = page.getByTestId('processes-badge')
      const pop = page.getByTestId('processes-popover')
      await badge.waitFor()
      assert.equal(await badge.getAttribute('data-state'), 'running')
      assert.match((await badge.getAttribute('class')) ?? '', /text-success/)
      assert.match(await badge.innerText(), /1 processo\b/)
      assert.equal(await page.getByTestId('processes-badge-warning').count(), 0)
      await badge.click()
      await pop.waitFor()
      assert.equal(await pop.getByTestId('process-item').count(), 3)
      // Parar o único rodando → sai da lista; sobram encerrados (um com falha): chip neutro + aviso
      await pop
        .getByTestId('process-item')
        .filter({ hasText: 'vite' })
        .getByRole('button', { name: 'Parar' })
        .click()
      await page.locator('[data-testid=processes-badge][data-state=failed]').waitFor()
      assert.doesNotMatch((await badge.getAttribute('class')) ?? '', /text-success/)
      assert.match(await badge.innerText(), /2 encerrados/)
      assert.match(
        (await badge.getAttribute('aria-label')) ?? '',
        /^2 processos encerrados \(1 com falha\) — ver\/remover$/
      )
      await page.getByTestId('processes-badge-warning').waitFor()
      await shot('proc-01-neutral-failed')
      // Remover a falha → neutro sem aviso
      await pop
        .getByTestId('process-item')
        .filter({ hasText: 'testes' })
        .getByTestId('process-dismiss')
        .click()
      await page.locator('[data-testid=processes-badge][data-state=finished]').waitFor()
      assert.equal(await page.getByTestId('processes-badge-warning').count(), 0)
      assert.match(await badge.innerText(), /1 encerrado\b/)
      // Remover o último → chip e popover somem
      await pop.getByTestId('process-dismiss').click()
      await badge.waitFor({ state: 'detached' })
      await pop.waitFor({ state: 'detached' })
      return 'verde → neutro+aviso → neutro → sem chip'
    }
  )

  await step('processos: lista longa rola dentro do popover e cabe na janela', async () => {
    await open('processes-many', 'Refatorar o parser')
    const out: string[] = []
    for (const [w, h] of [
      [1280, 820],
      [900, 600]
    ] as const) {
      await setSize(w, h)
      await page.getByTestId('processes-badge').click()
      await page.getByTestId('processes-popover').waitFor()
      await page.waitForTimeout(250)
      const g = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('[data-testid=processes-list]')!
        const box = document.querySelector<HTMLElement>(
          '[data-testid=processes-popover]'
        )!.parentElement!
        const items = list.querySelectorAll<HTMLElement>('[data-testid=process-item]')
        const before = { sh: list.scrollHeight, ch: list.clientHeight }
        list.scrollTop = list.scrollHeight
        const r = box.getBoundingClientRect()
        const lr = list.getBoundingClientRect()
        const last = items[items.length - 1].getBoundingClientRect()
        const title = box.firstElementChild!.firstElementChild!.getBoundingClientRect()
        const note = box.firstElementChild!.lastElementChild!.getBoundingClientRect()
        return {
          n: items.length,
          ...before,
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          lastIn: last.bottom <= lr.bottom + 1 && last.top >= lr.top - 1,
          titleIn: title.top >= r.top && title.bottom <= lr.top + 1,
          noteIn: note.top >= lr.bottom - 1 && note.bottom <= r.bottom + 1,
          listMax: lr.height <= window.innerHeight * 0.6 + 1,
          vw: window.innerWidth,
          vh: window.innerHeight
        }
      })
      assert.equal(g.n, 30, 'todos os processos na lista')
      assert(g.sh > g.ch, `lista rola (${g.sh} > ${g.ch})`)
      assert(g.lastIn, 'último item alcançável rolando')
      assert(g.titleIn && g.noteIn, 'título e nota fixos fora da área que rola')
      assert(g.listMax, 'lista ≤ 60% da altura da janela')
      assert(
        g.top >= 0 && g.left >= 0 && g.bottom <= g.vh && g.right <= g.vw,
        `popover dentro da janela (${JSON.stringify(g)})`
      )
      await shot(`proc-02-many-${w}x${h}`)
      await page.keyboard.press('Escape')
      await page.getByTestId('processes-popover').waitFor({ state: 'detached' })
      out.push(`${w}x${h}: ${g.ch}/${g.sh}px`)
    }
    await setSize(1280, 820)
    return out.join(' · ')
  })

  await step('estrutura: scroller até o fim, composer por cima (z), 90% da coluna', async () => {
    await open('chat', 'Ideias de nomes')
    await panel(false)
    await toBottom()
    const g = await page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
      const st = document.querySelector<HTMLElement>('[data-testid=composer-stack]')!
      const col = document.querySelector<HTMLElement>('[data-testid=composer-column]')!
      const inner = sc.firstElementChild as HTMLElement
      const cs = getComputedStyle(inner)
      const contentW = inner.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      return {
        position: getComputedStyle(st).position,
        z: Number(getComputedStyle(st).zIndex),
        maxW: cs.maxWidth,
        ratio: col.getBoundingClientRect().width / contentW,
        fadePE: getComputedStyle(document.querySelector('[data-testid=composer-fade]')!)
          .pointerEvents,
        stackPE: getComputedStyle(st).pointerEvents,
        colPE: getComputedStyle(col).pointerEvents,
        // hit-test logo acima do composer, na faixa do degradê: cai no conteúdo da lista
        fadeHit: (() => {
          const r = col.getBoundingClientRect()
          const h = document.elementFromPoint(r.left + 20, st.getBoundingClientRect().top - 20)
          return !!h && sc.contains(h)
        })()
      }
    })
    assert.equal(g.position, 'absolute')
    assert(g.z >= 20, 'pilha acima da lista')
    assert.equal(g.maxW, '1920px')
    assert(Math.abs(g.ratio - 0.9) < 0.01, `composer = 90% da coluna (${g.ratio})`)
    assert.equal(g.fadePE, 'none')
    assert.equal(g.stackPE, 'none')
    assert.equal(g.colPE, 'auto')
    assert(g.fadeHit, 'clique na faixa do degradê chega à lista')
    // conversa longa sem fila/pendências: texto aparecendo ao lado do composer e sumindo sob ele
    await open('memory', 'Planejamento do TCC')
    await panel(false)
    await midShot('00-mid-scroll-fade-1280-nopanel', 160)
    await panel(true)
    await midShot('00-mid-scroll-fade-1280-panel', 120)
    await setSize(1920, 1080)
    await toBottom()
    await shot('00-1920x1080-nopanel')
    await panel(true)
    await toBottom()
    await shot('00-1920x1080-panel')
    await midShot('00-mid-scroll-fade-1920-panel', 160)
    await setSize(1280, 820)
  })

  await step('1. composer vazio', async () => matrix('01-empty-composer'))

  await step('1. composer multi-linha (altura máxima, rola por dentro)', async () => {
    const ta = page.locator('[data-testid=composer-column] textarea')
    await ta.fill(Array.from({ length: 30 }, (_, i) => `linha ${i + 1} do texto`).join('\n'))
    await frames(3)
    const inner = await ta.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
    assert(inner.sh > inner.ch + 20, 'textarea rola por dentro')
    const info = await matrix('01-multiline')
    await midShot('01-multiline-mid', 200)
    await ta.fill('linha 1\nlinha 2\nlinha 3')
    const before = (await geo()).stack.height
    await ta.fill('')
    await frames(3)
    const g = await geo()
    assert(g.stack.height < before, 'pilha encolheu ao limpar')
    assert(Math.abs(g.padding - (g.stack.height + 24)) <= 2, 'padding acompanhou a pilha')
    return `textarea ${inner.ch}/${inner.sh}px · ${info}`
  })

  await step('0. lista vazia (chat novo) com o composer flutuante', async () => {
    const sid = await currentSession()
    await store(`s.setState((st) => ({ messages: { ...st.messages, [arg]: [] } }))`, sid)
    await page.getByText('Pronto para conversar').waitFor()
    return matrix('00-empty-chat', { scrollBtn: false })
  })

  await step('2. anexos (imagens, PDF, áudio, carregando) + aviso de modalidade', async () => {
    await open('chat', 'Ideias de nomes')
    const sid = await currentSession()
    await store(
      `const mk = (i, name, kind, mime) => ({ id: 'pa' + i, name, size: 40000 + i, status: 'ready', info: { sha256: String(i).repeat(64).slice(0, 64), name, mime, size: 40000 + i, kind, file: 'x' + i } });
       s.setState((st) => ({ pendingAttachments: { ...st.pendingAttachments, [arg]: [
         mk(1, 'diagrama.png', 'image', 'image/png'), mk(2, 'captura-de-tela-2026-10-17.png', 'image', 'image/png'),
         mk(3, 'foto.jpg', 'image', 'image/jpeg'), mk(4, 'relatorio-final.pdf', 'pdf', 'application/pdf'),
         mk(5, 'gravacao.mp3', 'audio', 'audio/mpeg'), mk(6, 'notas.md', 'text', 'text/markdown'),
         { id: 'pa7', name: 'grande.zip', size: 9000000, status: 'loading' } ] } }))`,
      sid
    )
    await page.getByText('Enviar mesmo assim').waitFor()
    await page.locator('[data-testid=composer-column] textarea').fill('Veja os anexos')
    return matrix('02-attachments')
  })

  await step('3. fila com vários chips (⚡ / X)', async () => {
    await open('chat', 'Refatorar o parser')
    const ta = page.locator('[data-testid=composer-column] textarea')
    for (const t of [
      'Também revisa o tratamento de \\r\\n, por favor.',
      'E roda o lint no fim, com uma mensagem um pouco mais longa para quebrar em duas linhas no chip.',
      'Último pedido da fila.'
    ]) {
      await ta.fill(t)
      await ta.press('Enter')
    }
    await page.getByLabel('Remover da fila').nth(3).waitFor()
    const info = await matrix('03-queue-chips')
    await midShot('03-queue-chips-mid', 260)
    // transição: remove um chip → a pilha encolhe, padding acompanha, fim continua visível
    const before = (await geo()).stack
    await toBottom()
    await page.getByLabel('Remover da fila').first().click()
    await page
      .getByLabel('Remover da fila')
      .nth(2)
      .waitFor({ state: 'detached' })
      .catch(() => {})
    await frames(4)
    const g = await geo()
    assert(Math.abs(g.padding - (g.stack.height + 24)) <= 2, 'padding após remover chip')
    assert(g.lastBottom <= g.stack.top + 1, 'última mensagem ainda acima da pilha')
    return `${info} · pilha ${Math.round(before.height)}→${Math.round(g.stack.height)}`
  })

  await step(
    '4. card de aprovação inline (Sim / Sim + whitelist / Não / Não + blacklist) acima do composer',
    async () => {
      await open('chat', 'Refatorar o parser')
      await toBottom()
      const card = page.getByTestId('approval-card').first()
      await card.waitFor()
      const hits = await page.evaluate(() => {
        const card = document.querySelector('[data-testid=approval-card]')!
        const st = document.querySelector('[data-testid=composer-stack]')!.getBoundingClientRect()
        const out: string[] = []
        for (const b of card.querySelectorAll<HTMLElement>('button')) {
          const r = b.getBoundingClientRect()
          if (r.width < 2) continue
          const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          if (r.bottom > st.top || !h || !(h === b || b.contains(h))) out.push(b.textContent ?? '')
        }
        return out
      })
      assert.deepEqual(hits, [], 'botões do card inline livres do composer')
      for (const name of ['Sim', 'Sim + whitelist', 'Não', 'Não + blacklist'])
        assert(await card.getByRole('button', { name, exact: true }).first().isVisible(), name)
      return matrix('04-inline-approval-card')
    }
  )

  await step('4. faixa com 1 aprovação (card fora da tela) e resolução → faixa some', async () => {
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
      el.scrollTop = 0
    })
    const q = page.getByTestId('approval-queue')
    await q.waitFor({ timeout: 4000 })
    await frames(3)
    const g = await geo()
    assert.deepEqual(g.blocked, [], 'faixa clicável')
    assert(Math.abs(g.padding - (g.stack.height + 24)) <= 2, 'padding com a faixa')
    await shot('04-pending-bar-single-1280x820-panel')
    // card parcialmente sob o composer não conta como visível → continua na faixa
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
      const card = document.querySelector<HTMLElement>('[data-testid=approval-card]')
      const st = document.querySelector<HTMLElement>('[data-testid=composer-stack]')!
      const tc = (card ?? document.querySelector<HTMLElement>('[data-anchor]'))!
      el.scrollTop += tc.getBoundingClientRect().top - st.getBoundingClientRect().top + 4
    })
    await frames(4)
    await page.waitForTimeout(200)
    assert(await q.isVisible(), 'card sob o composer → aprovação na faixa')
    await shot('04-pending-bar-card-under-composer')
    // resolve pela faixa → some; padding volta e o fim fica visível
    await q.getByRole('button', { name: 'Sim para todos' }).click()
    await q.waitFor({ state: 'detached', timeout: 4000 })
    await toBottom()
    const g2 = await geo()
    assert(Math.abs(g2.padding - (g2.stack.height + 24)) <= 2, 'padding após resolver')
    assert(g2.lastBottom <= g2.stack.top + 1, 'fim acima da pilha após resolver')
    await shot('04-approval-resolved')
    return `faixa ${Math.round(g.stack.height)}px → ${Math.round(g2.stack.height)}px`
  })

  await step('4. faixa com várias aprovações de subagentes (+ falha)', async () => {
    await open('subagents', 'Resumo do artigo')
    const q = page.getByTestId('approval-queue')
    await q.waitFor({ timeout: 4000 })
    await page.waitForTimeout(800)
    const info = await matrix('04-pending-bar-several', { drawerShot: true })
    await q.getByLabel('Próxima aprovação').click()
    await frames(3)
    const g = await geo()
    assert.deepEqual(g.blocked, [], 'faixa clicável após ›')
    await shot('04-pending-bar-several-next')
    await midShot('04-pending-bar-several-mid', 300)
    return info
  })

  await step('4b. subsessão com mensagens de irmãos (direta + broadcast)', async () => {
    await open('subagents', 'Resumo do artigo')
    // 3º delegate = s3c "Limpar artefatos de build": recebeu uma direta e um broadcast de s3a
    await page.getByRole('button', { name: 'Abrir subsessão' }).nth(2).click()
    await page.getByTestId('sub-banner').waitFor()
    const sib = page.getByTestId('sibling-message')
    await sib.first().waitFor({ timeout: 4000 })
    assert.equal(await sib.count(), 2)
    const t0 = (await sib.nth(0).innerText()).replace(/\s+/g, ' ')
    const t1 = (await sib.nth(1).innerText()).replace(/\s+/g, ' ')
    assert(t0.includes('Mensagem do irmão Rodar os testes do parser'), t0)
    assert(t0.includes('não limpe o out/') && !t0.includes('[Mensagem do subagente'), t0)
    assert(t1.includes('Broadcast do irmão Rodar os testes do parser'), t1)
    assert(t1.includes('Alguém está mexendo') && !t1.includes('[Broadcast do subagente'), t1)
    await sib.first().scrollIntoViewIfNeeded()
    await shot('04b-sibling-messages')
  })

  await step(
    '5. questionário substituindo o composer (2 perguntas) → responder → composer',
    async () => {
      await open('question', 'Ideias de nomes')
      await page.getByTestId('question-form').waitFor()
      const info = await matrix('05-ask-user')
      await page.getByTestId('ask-option').first().click()
      await page.getByTestId('ask-next').click()
      await page.getByTestId('ask-option').first().click()
      await shot('05-ask-user-step2')
      const before = (await geo()).stack.height
      await page.getByTestId('ask-submit').click()
      await page.getByTestId('question-form').waitFor({ state: 'detached' })
      await toBottom()
      const g = await geo()
      assert(g.stack.height < before, 'pilha encolheu (questionário → composer)')
      assert(Math.abs(g.padding - (g.stack.height + 24)) <= 2, 'padding após responder')
      assert(g.lastBottom <= g.stack.top + 1, 'resposta do questionário visível acima do composer')
      await shot('05-ask-user-answered')
      return `${info} · ${Math.round(before)}→${Math.round(g.stack.height)}px`
    }
  )

  await step('5. questionário com opções longas e imagens', async () => {
    await open('chat', 'Ideias de nomes')
    const sid = await currentSession()
    const long =
      'Uma opção com um título bem comprido para ver a quebra de linha dentro do card do questionário flutuante'
    await store(
      `emit({ type: 'question-requested', request: { id: 'qx', chatId: 'c2', sessionId: arg.sid, toolCallId: 'askx', createdAt: Date.now(), questions: [
        { title: 'Qual layout você prefere para a tela inicial do aplicativo?', description: arg.long, multiple: false, options: [
          { title: arg.long, description: arg.long, icon: { kind: 'image', url: arg.png }, image: arg.png },
          { title: 'Grade', icon: { kind: 'image', url: arg.png }, help: { kind: 'text', text: 'grade 3x3' } },
          { title: 'Lista', icon: { kind: 'lucide', name: 'list' } },
          { title: 'Cartões ' + arg.long, icon: { kind: 'text', text: '🃏' } },
          { title: 'Linha do tempo' }, { title: 'Kanban' }, { title: 'Calendário' } ] },
        { title: 'Recursos', multiple: true, options: [{ title: 'Cache' }, { title: 'Filas' }] } ] } })`,
      { sid, long, png: PNG }
    )
    await page.getByTestId('question-form').waitFor()
    const info = await matrix('05-ask-user-long')
    await store(`emit({ type: 'question-resolved', id: 'qx' })`)
    await page.getByTestId('question-form').waitFor({ state: 'detached' })
    await toBottom()
    const g = await geo()
    assert(Math.abs(g.padding - (g.stack.height + 24)) <= 2, 'padding após fechar o questionário')
    return info
  })

  await step('6. falha de conexão (Tentar de novo / Cancelar) → tentar de novo', async () => {
    await open('retry', 'Ideias de nomes')
    await page.getByTestId('retry-card').waitFor()
    const info = await matrix('06-retry-card')
    await page.getByRole('button', { name: /Tentar de novo/ }).click()
    await page.getByTestId('retry-card').waitFor({ state: 'detached' })
    await toBottom()
    const g = await geo()
    assert(Math.abs(g.padding - (g.stack.height + 24)) <= 2, 'padding após o retry')
    assert(g.lastBottom <= g.stack.top + 1, 'resposta nova acima do composer')
    await shot('06-retry-resolved')
    return info
  })

  await step('7. rodando (Parar) com rascunho crescendo preso ao fim', async () => {
    await open('stream', 'Ideias de nomes')
    await page.getByRole('button', { name: 'Parar', exact: true }).waitFor()
    const sid = await currentSession()
    // rascunho crescendo: a cada passo o fim continua acima do composer (stick-to-bottom)
    const base = 'Aqui vai uma resposta comprida em streaming.\n\n'
    let worst = Infinity
    for (let i = 1; i <= 14; i++) {
      await store(
        `emit({ type: 'draft', sessionId: arg.sid, draft: { reasoning: '', content: arg.text, toolCalls: [] } })`,
        {
          sid,
          text:
            base + Array.from({ length: i * 2 }, (_, k) => `- item ${k + 1} do rascunho`).join('\n')
        }
      )
      await frames(3)
      const g = await geo()
      assert(g.atBottom, `rascunho ${i}: preso ao fim`)
      worst = Math.min(worst, g.stack.top - g.lastBottom)
      assert(g.lastBottom <= g.stack.top + 1, `rascunho ${i}: fim acima do composer`)
    }
    await shot('07-streaming-draft')
    const info = await matrix('07-running')
    return `folga mínima ${Math.round(worst)}px · ${info}`
  })

  await step('8. subsessão (banner + composer para o subagente)', async () => {
    await open('chat', 'Refatorar o parser')
    await page.getByRole('button', { name: 'Abrir subsessão' }).first().click()
    await page.getByTestId('sub-banner').waitFor()
    await page.waitForTimeout(400)
    const g = await page.evaluate(() => {
      const banner = document.querySelector('[data-testid=sub-banner]')!.getBoundingClientRect()
      const stage = document.querySelector('[data-testid=chat-stage]')!.getBoundingClientRect()
      return { banner: banner.bottom, stage: stage.top }
    })
    assert(g.banner <= g.stage + 1, 'banner acima da área rolável')
    const info = await matrix('08-subsession')
    await open('retry-sub', 'Refatorar o parser')
    await page.getByRole('button', { name: 'Abrir subsessão' }).first().click()
    await page.getByTestId('retry-card').waitFor()
    return `${info} · retry na subsessão: ${await matrix('08-subsession-retry')}`
  })

  await step('9. Smart-Approve avaliando + badge de processos', async () => {
    await open('chat', 'Refatorar o parser')
    const sid = await currentSession()
    const tc = await store<string>(
      `const ms = s.getState().messages[arg] ?? []; for (let i = ms.length - 1; i >= 0; i--) { const c = ms[i].message.tool_calls; if (c && c.length) return c[c.length - 1].id } return ''`,
      sid
    )
    assert(tc, 'tool call encontrada')
    await store(
      `s.setState((st) => ({ approvals: st.approvals.filter((a) => a.toolCallId !== arg.tc) })); emit({ type: 'tool-running', sessionId: arg.sid, toolCallId: arg.tc, running: true, judging: true })`,
      { sid, tc }
    )
    await page.waitForTimeout(300)
    return matrix('09-smart-judging')
  })

  await step('9. card de extração de memórias no fim', async () => {
    await open('memory', 'Planejamento do TCC')
    await page.getByTestId('memory-extraction-card').first().waitFor()
    const info = await matrix('09-extraction-card')
    await midShot('09-extraction-mid', 240)
    return info
  })

  await step('10. banner de contexto (Compactar) e dispensar', async () => {
    await open('chat', 'Refatorar o parser')
    const chatId = await store<string>(`return s.getState().view.chatId`)
    await store(`s.getState().patchConfig(arg, { contextWindow: 1000 })`, chatId)
    await page.getByTestId('compact-banner').waitFor({ timeout: 4000 })
    const info = await matrix('10-context-banner')
    const before = (await geo()).stack.height
    await page.getByTestId('compact-banner').getByLabel('Dispensar').click()
    await page.getByTestId('compact-banner').waitFor({ state: 'detached' })
    await toBottom()
    const g = await geo()
    assert(g.stack.height < before, 'pilha encolheu ao dispensar')
    assert(Math.abs(g.padding - (g.stack.height + 24)) <= 2, 'padding após dispensar')
    assert(g.lastBottom <= g.stack.top + 1, 'fim acima do composer após dispensar')
    await shot('10-context-banner-dismissed')
    return info
  })

  await step(
    'tabelas markdown: colunas pelo conteúdo, sem quebrar palavras, larga rola',
    async () => {
      await open('chat', 'Ideias de nomes')
      const sid = await currentSession()
      await store(
        `const now = Date.now();
       emit({ type: 'message-added', message: { id: 'tu1', sessionId: arg.sid, seq: 1, createdAt: now, meta: {}, message: { role: 'user', content: 'Compare os candidatos em uma tabela.' } } });
       emit({ type: 'message-added', message: { id: 'ta1', sessionId: arg.sid, seq: 2, createdAt: now, meta: {}, message: { role: 'assistant', content: arg.md } } })`,
        { sid, md: TABLES_MD }
      )
      await page.locator('.md table').nth(2).waitFor()
      const out: string[] = []
      for (const [w, h, p] of [
        [1280, 820, false],
        [1280, 820, true],
        [900, 600, false]
      ] as const) {
        await setSize(w, h)
        await panel(p)
        await frames(3)
        const m = await page.evaluate(() => {
          const tables = [...document.querySelectorAll<HTMLTableElement>('.md table')]
          /** palavras partidas entre linhas (fora de links/código) e a maior palavra de cada célula */
          const broken: string[] = []
          const firstCol: { cell: number; word: number; text: string }[] = []
          for (const [ti, t] of tables.entries()) {
            for (const cell of t.querySelectorAll<HTMLElement>('th, td')) {
              const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
              let maxWord = 0
              for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if ((n.parentElement as HTMLElement).closest('a, code')) continue
                const text = n.textContent ?? ''
                for (const mm of text.matchAll(/\S+/g)) {
                  const r = document.createRange()
                  r.setStart(n, mm.index!)
                  r.setEnd(n, mm.index! + mm[0].length)
                  const rects = [...r.getClientRects()].filter((x) => x.width > 0)
                  const lines = new Set(rects.map((x) => Math.round(x.top)))
                  if (lines.size > 1) broken.push(`t${ti}: ${mm[0]}`)
                  maxWord = Math.max(maxWord, r.getBoundingClientRect().width)
                }
              }
              if ((cell as HTMLTableCellElement).cellIndex === 0) {
                const cs = getComputedStyle(cell)
                const inner =
                  cell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
                firstCol.push({ cell: inner, word: maxWord, text: cell.textContent ?? '' })
              }
            }
          }
          const wraps = [...document.querySelectorAll<HTMLElement>('.md .md-table')].map((w) => ({
            scroll: w.scrollWidth > w.clientWidth + 1,
            inside:
              w.getBoundingClientRect().right <= w.closest('.md')!.getBoundingClientRect().right + 1
          }))
          return {
            broken,
            firstCol,
            wraps,
            overflowX: document.documentElement.scrollWidth > window.innerWidth
          }
        })
        assert.deepEqual(m.broken, [], `${w}x${h}: palavras partidas nas células`)
        for (const c of m.firstCol)
          assert(
            c.cell + 0.5 >= c.word,
            `${w}x${h}: 1ª coluna "${c.text}" (${c.cell}px) < maior palavra (${c.word}px)`
          )
        assert(
          m.wraps.every((x) => x.inside),
          `${w}x${h}: tabelas dentro da coluna`
        )
        assert(!m.overflowX, `${w}x${h}: sem scroll horizontal na página`)
        if (w === 900) assert(m.wraps[1].scroll, '900: tabela larga rola na horizontal')
        const tag = `11-tables-${w}x${h}${p ? '-panel' : ''}`
        for (const [i, name] of ['comparison', 'wide', 'links'].entries()) {
          await page.locator('.md .md-table').nth(i).scrollIntoViewIfNeeded()
          await page.evaluate((i) => {
            const el = document.querySelectorAll<HTMLElement>('.md .md-table')[i]
            const sc = document.querySelector<HTMLElement>('[data-testid=chat-scroller]')!
            sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 60
          }, i)
          await frames(3)
          await shot(`${tag}-${name}`)
        }
        out.push(`${w}x${h}${p ? '+painel' : ''}: larga rola=${m.wraps[1].scroll}`)
      }
      await setSize(1280, 820)
      return out.join(' | ')
    }
  )

  await app.close()
  writeFileSync(join(BASE, 'report.json'), JSON.stringify(results, null, 2))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} ok · shots em ${SHOTS}`)
  if (failed.length) process.exit(1)
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
