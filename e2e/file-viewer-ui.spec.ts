/* eslint-disable @typescript-eslint/no-explicit-any */
// E2E do VISUALIZADOR DE ARQUIVOS (present_file) contra o MOCK de UI (Playwright + `e2e/launch.ts`, sem
// backend, sem key): builda o renderer com VITE_CLEAR_MOCK=1 numa pasta de rascunho (não mexe em
// out/), abre `index.html` numa janela Electron mínima e percorre o chat "Relatório trimestral de
// vendas" (mockViewer.ts):
//   cards sem o cabeçalho de tool, na ordem da resposta, com as 4 variantes do bloco de título;
//   present_file novo (evento) abre o 1º arquivo no painel; clicar outro card troca (card ativo
//   selecionado); zoom (botões) muda a escala (markdown e imagem, "Ajustar"); tipo sem prévia com os
//   dois botões (chamadas de SO registradas no mock); aba Arquivos: clique abre no painel e destaca,
//   duplo clique abre no app; divisor (teclado e arrastar, largura lembrada); fechar (X e Esc);
//   trocar de chat mostra o arquivo de cada chat. Controle remoto (o chat passa a rodar no "PC do
//   escritório", host simulado em mockViewer.ts): present_file abre sozinho buscando do host com
//   progresso; Salvar como… / Abrir no app presentes e nunca "Mostrar na pasta"; aba Arquivos lista
//   o host; PDF e HTML por blob URL (HTML sem o toggle de scripts); tipo sem prévia baixa só ao
//   abrir/salvar; reabrir usa o cache; host offline. Ações por tipo (mock = Linux): .sh com prévia
//   de código + "Executar…" (local e do host); .exe do host só "Salvar como…" + "Executável de
//   Windows" (nada roda: o mock só registra as chamadas).
// Screenshots em $CLEARCHAT_E2E_DIR/shots.
//
// Uso:
//   unset ELECTRON_RUN_AS_NODE
//   CLEARCHAT_E2E_DIR=/tmp/clearchat-viewer-e2e node e2e/file-viewer-ui.spec.ts [filtro-para-parar]
//   (SKIP_BUILD=1 reaproveita o build anterior)
import type { ElectronApplication, Page } from 'playwright'
import { launchElectron } from './launch.ts'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = resolve(process.env.CLEARCHAT_E2E_DIR || join(tmpdir(), 'clearchat-viewer-e2e'))
const BUILD = join(BASE, 'build')
const SHOTS = join(BASE, 'shots')
const STOP_AFTER = process.argv[2] ?? ''
const VROOT = '/home/dev/projetos/vendas'

let app: ElectronApplication
let page: Page
let stopped = false
const results: { name: string; ok: boolean; info?: string }[] = []

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(250)
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

const scroller = (): ReturnType<Page['locator']> => page.getByTestId('chat-scroller')
const cards = (): ReturnType<Page['locator']> => scroller().getByTestId('present-file-card')
const viewer = (): ReturnType<Page['locator']> => page.getByTestId('file-viewer')
const card = (text: string): ReturnType<Page['locator']> =>
  cards().filter({ hasText: text }).first()
const viewerName = (): Promise<string> => viewer().getByTestId('viewer-name').innerText()
const zoomAttr = (): Promise<string | null> =>
  viewer().getByTestId('viewer-body').getAttribute('data-zoom')

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
// microfone: a guarda do e2e/launch.ts (dispositivo falso, permissão negada)
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 860, useContentSize: true, backgroundColor: '#0d0d10', show: true })
  win.loadFile(${JSON.stringify(join(BUILD, 'renderer', 'index.html'))})
})
app.on('window-all-closed', () => app.quit())
`
  )
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await launchElectron({ args: [mainJs], env, timeout: 60_000 })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 860)
  )
  // largura lembrada de outra execução não deve interferir (o store lê no boot → recarrega)
  await page.evaluate(() => localStorage.removeItem('clearchat.viewer.width'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  await step('cards sem cabeçalho de tool, na ordem, com as 4 variantes do título', async () => {
    await page
      .getByTestId('chat-item')
      .filter({ hasText: 'Relatório trimestral de vendas' })
      .click()
    await cards().first().waitFor()
    assert.equal(await cards().count(), 4)
    // nenhum card de tool comum para present_file (sem "Apresentar arquivo" no cabeçalho)
    assert.equal(await scroller().getByText('Apresentar arquivo').count(), 0)
    // ordem: texto → 3 cards → texto → 1 card → texto
    const order = await scroller().evaluate((root) => {
      const out: string[] = []
      root.querySelectorAll('.md p, [data-testid="present-file-card"]').forEach((el) => {
        out.push(
          el.getAttribute('data-testid') === 'present-file-card'
            ? `card:${el.querySelector('[data-testid="pf-title"]')?.textContent}`
            : `text:${(el.textContent ?? '').slice(0, 12)}`
        )
      })
      return out.filter((x) => !x.startsWith('text:Gere'))
    })
    assert.deepEqual(order, [
      'text:Pronto — ger',
      'card:Relatório do trimestre',
      'card:grafico-vendas.png',
      'card:Dados brutos (ERP)',
      'text:E as notas d',
      'card:notas.txt',
      'text:Quer que eu '
    ])
    const block = async (text: string): Promise<[string | null, string | null, string | null]> => {
      const c = card(text)
      const get = async (id: string): Promise<string | null> =>
        (await c.getByTestId(id).count()) ? c.getByTestId(id).innerText() : null
      return [await get('pf-title'), await get('pf-desc'), await get('pf-name')]
    }
    // título + descrição → título, descrição, nome real
    assert.deepEqual(await block('Relatório do trimestre'), [
      'Relatório do trimestre',
      'Resumo das vendas por região, com a variação T1 → T2.',
      'relatorio.md'
    ])
    // só descrição → nome do arquivo como título, descrição
    assert.deepEqual(await block('grafico-vendas.png'), [
      'grafico-vendas.png',
      'Gráfico de barras das vendas por trimestre.',
      null
    ])
    // só título → título, nome real
    assert.deepEqual(await block('Dados brutos'), ['Dados brutos (ERP)', null, 'dados-brutos.zip'])
    // nenhum → só o nome
    assert.deepEqual(await block('notas.txt'), ['notas.txt', null, null])
    assert.equal(await viewer().count(), 0, 'sem arquivo ativo o painel não aparece')
    await shot('01-cards')
  })

  await step('present_file novo abre o 1º arquivo no painel (card ativo)', async () => {
    await page.evaluate(() => {
      const w = window as any
      const now = Date.now()
      const files = [
        {
          path: '/home/dev/projetos/vendas/relatorio.md',
          name: 'relatorio.md',
          title: 'Relatório (revisado)',
          size: 400,
          kind: 'markdown'
        },
        {
          path: '/home/dev/projetos/vendas/grafico-vendas.png',
          name: 'grafico-vendas.png',
          size: 48213,
          kind: 'image'
        }
      ]
      w.__clearMockEmit({
        type: 'message-added',
        message: {
          id: 'mpf-a',
          sessionId: 'spf',
          seq: 9001,
          createdAt: now,
          message: {
            role: 'assistant',
            content: 'Revisei o relatório:',
            tool_calls: [
              {
                id: 'tpf3',
                type: 'function',
                function: {
                  name: 'present_file',
                  arguments: JSON.stringify({ files: files.map((f) => ({ path: f.name })) })
                }
              }
            ]
          },
          meta: {}
        }
      })
      w.__clearMockEmit({
        type: 'message-added',
        message: {
          id: 'mpf-t',
          sessionId: 'spf',
          seq: 9002,
          createdAt: now,
          message: { role: 'tool', tool_call_id: 'tpf3', content: 'Apresentado ao usuário: …' },
          meta: { toolStatus: 'ok', presentFiles: { files } }
        }
      })
    })
    await viewer().waitFor()
    assert.equal(await viewerName(), 'relatorio.md')
    await viewer().locator('.md h1').filter({ hasText: 'Relatório trimestral de vendas' }).waitFor()
    // o arquivo ativo (mesmo caminho) aparece selecionado em todos os cards dele
    const active = await cards().evaluateAll((els) =>
      els
        .filter((e) => e.hasAttribute('data-active'))
        .map((e) => e.querySelector('[data-testid="pf-title"]')?.textContent)
    )
    assert.deepEqual(active, ['Relatório do trimestre', 'Relatório (revisado)'])
    await shot('02-auto-open-markdown')
  })

  await step('clicar outro card troca o arquivo do painel', async () => {
    await card('grafico-vendas.png')
      .getByRole('button', { name: /no visualizador/ })
      .click()
    await viewer().getByTestId('viewer-image').waitFor()
    assert.equal(await viewerName(), 'grafico-vendas.png')
    assert.equal(await card('grafico-vendas.png').getAttribute('data-active'), 'true')
    assert.equal(await card('Relatório do trimestre').getAttribute('data-active'), null)
  })

  await step('zoom da imagem: Ajustar → +/− mudam a escala → Ajustar', async () => {
    assert.equal(await zoomAttr(), 'fit')
    const img = viewer().getByTestId('viewer-image')
    const fitW = (await img.boundingBox())!.width
    await viewer().getByRole('button', { name: 'Aumentar zoom' }).click()
    const z1 = Number(await zoomAttr())
    assert.ok(z1 > fitW / 640, `zoom ${z1} deveria passar da escala ajustada ${fitW / 640}`)
    await viewer().getByRole('button', { name: 'Aumentar zoom' }).click()
    const z2 = Number(await zoomAttr())
    assert.ok(z2 > z1)
    await page.waitForTimeout(100)
    const w2 = (await img.boundingBox())!.width
    assert.ok(Math.abs(w2 - 640 * z2) < 2, `largura ${w2} ≠ ${640 * z2}`)
    await viewer().getByRole('button', { name: 'Diminuir zoom' }).click()
    assert.equal(Number(await zoomAttr()), z1)
    // ampliada: arrastar move (pan) a imagem
    await viewer().getByTestId('viewer-zoom').click() // 100%
    for (let i = 0; i < 3; i++)
      await viewer().getByRole('button', { name: 'Aumentar zoom' }).click()
    const boxEl = viewer().getByTestId('viewer-image-box')
    const bb = (await boxEl.boundingBox())!
    const before = await boxEl.evaluate((e) => e.scrollLeft)
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
    await page.mouse.down()
    await page.mouse.move(bb.x + bb.width / 2 - 80, bb.y + bb.height / 2, { steps: 5 })
    await page.mouse.up()
    const after = await boxEl.evaluate((e) => e.scrollLeft)
    assert.ok(after - before >= 60, `pan: scrollLeft ${before} → ${after}`)
    await viewer().getByRole('button', { name: 'Ajustar ao painel' }).click()
    assert.equal(await zoomAttr(), 'fit')
    assert.ok(Math.abs((await img.boundingBox())!.width - fitW) < 2)
    await shot('03-image')
    return `ajustada ${Math.round(fitW)}px`
  })

  await step('zoom do markdown (tamanho do texto) e reset', async () => {
    await card('Relatório do trimestre')
      .getByRole('button', { name: /no visualizador/ })
      .click()
    await viewer().locator('.md h1').waitFor()
    assert.equal(await zoomAttr(), 'fit') // padrão (100%)
    const z = (): Promise<string> =>
      viewer()
        .getByTestId('viewer-zoomable')
        .evaluate((e) => (e as HTMLElement).style.zoom)
    await viewer().getByRole('button', { name: 'Aumentar zoom' }).click()
    assert.equal(await z(), '1.1')
    await page.keyboard.press('Control+=') // foco no painel: atalho também
    assert.equal(await z(), '1.25')
    await viewer().getByTestId('viewer-zoom').click() // reset
    assert.equal(await z(), '1')
  })

  await step('tipo sem prévia: nome/tamanho/tipo + os dois botões', async () => {
    await card('Dados brutos')
      .getByRole('button', { name: /no visualizador/ })
      .click()
    const pane = viewer().getByTestId('viewer-unsupported')
    await pane.waitFor()
    const text = await pane.innerText()
    assert.match(text, /dados-brutos\.zip/)
    assert.match(text, /Arquivo ZIP/)
    assert.match(text, /2,4 MB|2\.4 MB/)
    await pane.getByRole('button', { name: 'Mostrar local do arquivo no explorador' }).click()
    await pane.getByRole('button', { name: 'Abrir arquivo' }).click()
    const calls = await page.evaluate(() => (window as any).__mockViewerCalls)
    assert.deepEqual(calls, [`reveal:${VROOT}/dados-brutos.zip`, `open:${VROOT}/dados-brutos.zip`])
    await shot('04-unsupported')
  })

  await step('ações do card (hover): Abrir no app / Mostrar na pasta', async () => {
    const c = card('notas.txt')
    await c.hover()
    await c.getByRole('button', { name: 'Abrir no app' }).click()
    await page.waitForTimeout(150)
    const calls = await page.evaluate(() => (window as any).__mockViewerCalls)
    assert.equal(calls[calls.length - 1], `open:${VROOT}/notas.txt`)
  })

  /** present_file simulado (evento): `deviceId` = arquivos de outro dispositivo (host). */
  const emitPresent = (
    id: string,
    seq: number,
    files: { path: string; name: string; size: number; kind: string }[],
    device?: { deviceId: string; deviceName: string }
  ): Promise<void> =>
    page.evaluate(
      ({ id, seq, files, device }) => {
        const w = window as any
        const now = Date.now()
        w.__clearMockEmit({
          type: 'message-added',
          message: {
            id: `${id}-a`,
            sessionId: 'spf',
            seq,
            createdAt: now,
            message: {
              role: 'assistant',
              content: 'Arquivos:',
              tool_calls: [
                {
                  id: `${id}-c`,
                  type: 'function',
                  function: {
                    name: 'present_file',
                    arguments: JSON.stringify({ files: files.map((f) => ({ path: f.name })) })
                  }
                }
              ]
            },
            meta: {}
          }
        })
        w.__clearMockEmit({
          type: 'message-added',
          message: {
            id: `${id}-t`,
            sessionId: 'spf',
            seq: seq + 1,
            createdAt: now,
            message: {
              role: 'tool',
              tool_call_id: `${id}-c`,
              content: 'Apresentado ao usuário: …'
            },
            meta: { toolStatus: 'ok', presentFiles: { ...(device ?? {}), files } }
          }
        })
      },
      { id, seq, files, device }
    )
  const labelsIn = (loc: ReturnType<Page['locator']>): Promise<string[]> =>
    loc
      .locator('button[aria-label]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))

  await step(
    'script .sh (Linux): prévia como código + "Executar…" (sem "Abrir no app")',
    async () => {
      await emitPresent('msh', 9051, [
        { path: `${VROOT}/deploy.sh`, name: 'deploy.sh', size: 96, kind: 'code' }
      ])
      await viewer().waitFor()
      await page.waitForFunction(
        () => document.querySelector('[data-testid="viewer-name"]')?.textContent === 'deploy.sh'
      )
      const code = viewer().getByTestId('viewer-code')
      await code.waitFor()
      assert.match(await code.innerText(), /npm run build/)
      const labels = await labelsIn(viewer())
      assert.ok(labels.includes('Executar…'), labels.join(', '))
      assert.ok(labels.includes('Mostrar na pasta'))
      assert.ok(!labels.includes('Abrir no app'))
      // card: as mesmas ações no hover
      const c = card('deploy.sh')
      await c.hover()
      const cardLabels = await labelsIn(c)
      assert.ok(cardLabels.includes('Executar…') && !cardLabels.includes('Abrir no app'))
      assert.ok(cardLabels.includes('Mostrar na pasta'))
      // nada roda no mock: a chamada só é registrada (o main real pede confirmação)
      await viewer().getByRole('button', { name: 'Executar…' }).click()
      await page.waitForTimeout(150)
      const calls = await page.evaluate(() => (window as any).__mockViewerCalls)
      assert.equal(calls[calls.length - 1], `run:${VROOT}/deploy.sh`)
      await shot('05a-script-run')
    }
  )

  await step(
    'aba Arquivos: clique abre no painel e destaca; duplo clique abre no app',
    async () => {
      await page.getByRole('tab', { name: 'Arquivos' }).click()
      const entry = (name: string): ReturnType<Page['locator']> =>
        page.getByTestId('right-panel').getByTestId('files-entry').filter({ hasText: name })
      await entry('notas.txt').click()
      await viewer().getByTestId('viewer-text').waitFor()
      assert.equal(await viewerName(), 'notas.txt')
      assert.equal(await entry('notas.txt').getAttribute('aria-current'), 'true')
      assert.equal(await entry('relatorio.md').getAttribute('aria-current'), null)
      // o card com o mesmo caminho também fica ativo
      assert.equal(await card('notas.txt').getAttribute('data-active'), 'true')
      await entry('grafico-vendas.png').dblclick()
      await page.waitForTimeout(200)
      const calls = await page.evaluate(() => (window as any).__mockViewerCalls)
      assert.equal(calls[calls.length - 1], `open:${VROOT}/grafico-vendas.png`)
      assert.equal(await viewerName(), 'grafico-vendas.png')
      await shot('05-files-tab')
    }
  )

  await step('divisor: teclado e arrastar mudam a largura (lembrada)', async () => {
    const sep = viewer().getByTestId('viewer-splitter')
    const w0 = (await viewer().boundingBox())!.width
    await sep.focus()
    // ← alarga / → estreita (aqui o painel já está no máximo: estreita primeiro)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    const w1 = (await viewer().boundingBox())!.width
    assert.equal(Math.round(w0 - w1), 32)
    await page.keyboard.press('ArrowLeft')
    assert.equal(Math.round((await viewer().boundingBox())!.width - w1), 16)
    await page.keyboard.press('ArrowRight')
    const box = (await sep.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 300)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + 300, { steps: 6 })
    await page.mouse.up()
    const w2 = (await viewer().boundingBox())!.width
    assert.ok(Math.abs(w1 - 80 - w2) <= 2, `esperava ~${w1 - 80}, veio ${w2}`)
    const saved = await page.evaluate(() => localStorage.getItem('clearchat.viewer.width'))
    assert.equal(Number(saved), Math.round(w2))
    assert.equal(await sep.getAttribute('aria-valuenow'), String(Math.round(w2)))
    await shot('06-resized')
    return `${Math.round(w0)} → ${Math.round(w1)} → ${Math.round(w2)}px`
  })

  await step('arquivo ativo é por chat (trocar de chat e voltar)', async () => {
    await page.getByTestId('chat-item').filter({ hasText: 'Ideias de nomes para o app' }).click()
    await page.waitForTimeout(300)
    assert.equal(await viewer().count(), 0)
    await page
      .getByTestId('chat-item')
      .filter({ hasText: 'Relatório trimestral de vendas' })
      .click()
    await viewer().waitFor()
    assert.equal(await viewerName(), 'grafico-vendas.png')
  })

  await step('fechar: X e Esc', async () => {
    await viewer().getByRole('button', { name: 'Fechar painel de arquivo' }).click()
    await viewer().waitFor({ state: 'detached' })
    await card('notas.txt')
      .getByRole('button', { name: /no visualizador/ })
      .click()
    await viewer().waitFor()
    await viewer().getByRole('button', { name: 'Recarregar' }).focus()
    await page.keyboard.press('Escape')
    await viewer().waitFor({ state: 'detached' })
    assert.equal(
      await cards().evaluateAll((els) => els.filter((e) => e.hasAttribute('data-active')).length),
      0
    )
  })

  await step('aba Arquivos: entra em pastas e volta pelo caminho (raiz POSIX e C:\\)', async () => {
    const panel = page.getByTestId('right-panel')
    const entry = (name: string): ReturnType<Page['locator']> =>
      panel.getByTestId('files-entry').filter({ hasText: name }).first()
    const crumbs = async (): Promise<string[]> =>
      (await panel.locator('nav button').allInnerTexts()).map((t) => t.trim())
    const until = async (want: string[]): Promise<void> => {
      for (let i = 0; i < 40 && (await crumbs()).join('›') !== want.join('›'); i++)
        await page.waitForTimeout(50)
      assert.deepEqual(await crumbs(), want)
    }
    const CHAT = 'Refatorar o parser de SSE'
    const setCwd = (cwd: string): Promise<void> =>
      page.evaluate(
        ([title, dir]) => {
          const st = (window as any).__clearStore.getState()
          const c = st.chats.find((x: any) => x.title === title)
          st.patchConfig(c.id, { cwd: dir })
        },
        [CHAT, cwd]
      )
    await page.getByTestId('chat-item').filter({ hasText: CHAT }).click()
    await page.getByRole('tab', { name: 'Arquivos' }).click()
    // POSIX: clearchat › src › utils e de volta pela raiz
    await entry('src').click()
    await until(['clearchat', 'src'])
    await entry('utils').click()
    await until(['clearchat', 'src', 'utils'])
    await panel.locator('nav button').first().click()
    await until(['clearchat'])
    await entry('package.json').waitFor()
    // Windows: as entradas voltam com `\` (path.join do main) — antes o confinamento comparava com
    // `/` e devolvia a aba à raiz a cada clique
    const before = await page.evaluate(
      (title) =>
        (window as any).__clearStore.getState().chats.find((x: any) => x.title === title).config
          .cwd as string,
      CHAT
    )
    await setCwd('C:\\Users\\dev\\projeto')
    await until(['projeto'])
    await entry('utils').click()
    await until(['projeto', 'utils'])
    assert.equal(
      await entry('index.ts').getAttribute('data-path'),
      'C:\\Users\\dev\\projeto\\utils\\index.ts'
    )
    await entry('utils').click()
    await until(['projeto', 'utils', 'utils'])
    await panel.locator('nav button').nth(1).click()
    await until(['projeto', 'utils'])
    await shot('05c-files-windows-root')
    await setCwd(before)
    await until(['clearchat'])
    await page
      .getByTestId('chat-item')
      .filter({ hasText: 'Relatório trimestral de vendas' })
      .click()
    await page.waitForTimeout(200)
  })

  // ---------------- controle remoto: arquivos do host pelo sync (fonte remota) ----------------
  const HROOT = '/srv/escritorio/vendas'
  const hostState = (mode: 'remote' | 'host-offline'): Promise<void> =>
    page.evaluate((m) => {
      ;(window as any).__clearMockEmit({
        type: 'sync-chat-state',
        info: {
          chatId: 'cpf',
          mode: m,
          host: {
            deviceId: 'dev-escritorio',
            name: 'PC do escritório',
            status: m === 'remote' ? 'online' : 'offline',
            self: false
          },
          running: false,
          pinned: false,
          epoch: 4,
          handover: null,
          diverged: null,
          usesLocalTools: true,
          hostCwd: { deviceId: 'dev-escritorio', path: '/srv/escritorio/vendas' },
          needsCwd: false
        }
      })
    }, mode)
  const remoteCalls = (): Promise<string[]> =>
    page.evaluate(() => (window as any).__mockRemoteCalls)
  const osCalls = (): Promise<string[]> => page.evaluate(() => (window as any).__mockViewerCalls)
  const toolbarLabels = (): Promise<string[]> =>
    viewer()
      .locator('button[aria-label]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))

  await step('remoto: present_file abre sozinho buscando do host (progresso)', async () => {
    await hostState('remote')
    await page.waitForTimeout(100)
    await page.evaluate((root) => {
      const w = window as any
      const now = Date.now()
      const files = [
        { path: `${root}/log-grande.txt`, name: 'log-grande.txt', size: 3_000_000, kind: 'text' },
        { path: `${root}/grafico.png`, name: 'grafico.png', size: 67, kind: 'image' }
      ]
      w.__clearMockEmit({
        type: 'message-added',
        message: {
          id: 'mpr-a',
          sessionId: 'spf',
          seq: 9101,
          createdAt: now,
          message: {
            role: 'assistant',
            content: 'Do PC do escritório:',
            tool_calls: [
              {
                id: 'tpr1',
                type: 'function',
                function: {
                  name: 'present_file',
                  arguments: JSON.stringify({ files: files.map((f) => ({ path: f.name })) })
                }
              }
            ]
          },
          meta: {}
        }
      })
      w.__clearMockEmit({
        type: 'message-added',
        message: {
          id: 'mpr-t',
          sessionId: 'spf',
          seq: 9102,
          createdAt: now,
          message: { role: 'tool', tool_call_id: 'tpr1', content: 'Apresentado ao usuário: …' },
          meta: {
            toolStatus: 'ok',
            presentFiles: { deviceId: 'dev-escritorio', deviceName: 'PC do escritório', files }
          }
        }
      })
    }, HROOT)
    await viewer().waitFor()
    assert.equal(await viewerName(), 'log-grande.txt')
    await viewer().getByTestId('viewer-progress').waitFor()
    const label = await viewer().getByTestId('viewer-body').innerText()
    assert.match(label, /Baixando do host… .* de /)
    await shot('10-remote-progress')
    await viewer().getByTestId('viewer-text').waitFor({ timeout: 15_000 })
    const reads = (await remoteCalls()).filter((c) => c.startsWith('read:log-grande.txt'))
    assert.ok(reads.length >= 3, `pedaços: ${reads.length}`)
    const text = await viewer().getByTestId('viewer-text').innerText()
    assert.match(text, /^000001 INFO pedido processado/)
    // ações remotas: Abrir no app + Salvar como…, nunca Mostrar na pasta
    const labels = await toolbarLabels()
    assert.ok(labels.includes('Salvar como…'), labels.join(', '))
    assert.ok(labels.includes('Abrir no app'))
    assert.ok(!labels.includes('Mostrar na pasta'))
    await viewer().getByRole('button', { name: 'Salvar como…' }).click()
    await page.waitForTimeout(200)
    assert.match((await osCalls()).at(-1) ?? '', /^save:log-grande\.txt:\d+$/)
    // o card do arquivo do host fica ativo e sem a nota "Arquivo no …"
    const c = card('log-grande.txt')
    assert.equal(await c.getAttribute('data-active'), 'true')
    assert.equal(await c.getByTestId('pf-note').count(), 0)
    await shot('11-remote-text')
    return `${reads.length} pedaços`
  })

  await step('remoto: aba Arquivos lista o host; PDF por blob URL no visualizador', async () => {
    await page.getByRole('tab', { name: 'Arquivos' }).click()
    const panel = page.getByTestId('right-panel')
    await panel.getByTestId('files-remote').waitFor()
    assert.match(await panel.getByTestId('files-remote').innerText(), /PC do escritório/)
    // ações locais (raiz/pasta nova) somem no controle remoto
    assert.equal(await panel.getByRole('button', { name: 'Usar como raiz' }).count(), 0)
    assert.equal(await panel.getByRole('button', { name: 'Escolher pasta…' }).count(), 0)
    const entry = (name: string): ReturnType<Page['locator']> =>
      panel.getByTestId('files-entry').filter({ hasText: name })
    await entry('relatorio-final.pdf').waitFor()
    assert.ok((await remoteCalls()).includes(`list:${HROOT}`))
    assert.equal(await entry('dados').count(), 1)
    await entry('relatorio-final.pdf').click()
    const pdf = viewer().getByTestId('viewer-pdf')
    await pdf.waitFor()
    const src = (await pdf.getAttribute('src')) ?? ''
    assert.match(src, /^blob:/)
    await page.waitForTimeout(1500)
    await shot('12-remote-pdf')
    // o PDF carregou no frame (o visualizador do Chromium cria o frame do plugin)
    const frames = page.frames().map((f) => f.url())
    return `frames: ${frames.filter((u) => u.startsWith('blob:') || u.includes('pdf')).join(' | ') || '(nenhum)'}`
  })

  await step('remoto: HTML isolado (blob + CSP), sem o toggle de scripts', async () => {
    const panel = page.getByTestId('right-panel')
    await panel.getByTestId('files-entry').filter({ hasText: 'pagina.html' }).click()
    const frame = viewer().getByTestId('viewer-html')
    await frame.waitFor()
    assert.match((await frame.getAttribute('src')) ?? '', /^blob:/)
    assert.equal(await frame.getAttribute('sandbox'), '')
    assert.equal(await viewer().getByText('Permitir scripts (isolado)').count(), 0)
    await page.waitForTimeout(400)
    await shot('13-remote-html')
  })

  await step(
    'remoto: tipo sem prévia → Salvar como… / Abrir arquivo (sem explorador)',
    async () => {
      const panel = page.getByTestId('right-panel')
      await panel.getByTestId('files-entry').filter({ hasText: 'backup.zip' }).click()
      const pane = viewer().getByTestId('viewer-unsupported')
      await pane.waitFor()
      assert.equal(
        await pane.getByRole('button', { name: 'Mostrar local do arquivo no explorador' }).count(),
        0
      )
      const before = (await remoteCalls()).filter((c) => c.startsWith('read:backup.zip')).length
      assert.equal(before, 1, 'prévia: só o começo')
      await pane.getByRole('button', { name: 'Abrir arquivo' }).click()
      await page.waitForFunction(
        () =>
          ((window as any).__mockViewerCalls as string[]).some((c) => c.startsWith('open-temp:')),
        undefined,
        { timeout: 15_000 }
      )
      assert.match((await osCalls()).at(-1) ?? '', /^open-temp:backup\.zip:3150049$/)
      await pane.getByRole('button', { name: 'Salvar como…' }).click()
      await page.waitForTimeout(200)
      assert.match((await osCalls()).at(-1) ?? '', /^save:backup\.zip:3150049$/)
      await shot('14-remote-unsupported')
    }
  )

  await step('remoto: reabrir usa o cache (só confere tamanho/mtime)', async () => {
    const panel = page.getByTestId('right-panel')
    const n0 = (await remoteCalls()).length
    await panel.getByTestId('files-entry').filter({ hasText: 'relatorio-final.pdf' }).click()
    await viewer().getByTestId('viewer-pdf').waitFor()
    const added = (await remoteCalls()).slice(n0).filter((c) => c.startsWith('read:'))
    assert.deepEqual(added, ['read:relatorio-final.pdf:0:0'])
  })

  await step('remoto: .exe no Linux → só "Salvar como…" + "Executável de Windows"', async () => {
    const panel = page.getByTestId('right-panel')
    await panel.getByTestId('files-entry').filter({ hasText: 'instalar.exe' }).click()
    const pane = viewer().getByTestId('viewer-unsupported')
    await pane.waitFor()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="viewer-name"]')?.textContent === 'instalar.exe'
    )
    assert.match(
      await pane.getByTestId('viewer-exec-note').innerText(),
      /Executável de Windows — não roda neste sistema/
    )
    assert.deepEqual(
      await pane.getByRole('button').evaluateAll((els) => els.map((e) => e.textContent?.trim())),
      ['Salvar como…']
    )
    const labels = await toolbarLabels()
    assert.ok(labels.includes('Salvar como…'), labels.join(', '))
    for (const no of ['Abrir no app', 'Executar…', 'Mostrar na pasta'])
      assert.ok(!labels.includes(no), `${no} não deveria aparecer`)
    await pane.getByRole('button', { name: 'Salvar como…' }).click()
    await page.waitForFunction(() =>
      ((window as any).__mockViewerCalls as string[]).at(-1)?.startsWith('save:instalar')
    )
    assert.equal((await osCalls()).at(-1), 'save:instalar.exe:98304')
    await shot('14a-remote-exe')
  })

  await step(
    'remoto: cards do host — .exe só "Salvar como…" com a nota; .sh "Executar…"',
    async () => {
      await emitPresent(
        'mrx',
        9201,
        [
          { path: `${HROOT}/instalar.exe`, name: 'instalar.exe', size: 98304, kind: 'binary' },
          { path: `${HROOT}/atualizar.sh`, name: 'atualizar.sh', size: 42, kind: 'code' }
        ],
        { deviceId: 'dev-escritorio', deviceName: 'PC do escritório' }
      )
      const exe = card('instalar.exe')
      await exe.waitFor()
      await exe.scrollIntoViewIfNeeded()
      assert.match(
        await exe.getByTestId('pf-hint').innerText(),
        /Executável de Windows — não roda neste sistema/
      )
      assert.equal(await exe.getAttribute('data-disabled'), null, 'a nota não desabilita o card')
      await exe.hover()
      const exeLabels = (await labelsIn(exe)).filter((l) => !l.includes('no visualizador'))
      assert.deepEqual(exeLabels, ['Salvar como…'])
      const sh = card('atualizar.sh')
      await sh.hover()
      const shLabels = (await labelsIn(sh)).filter((l) => !l.includes('no visualizador'))
      assert.deepEqual(shLabels, ['Executar…', 'Salvar como…'])
      await sh.getByRole('button', { name: /no visualizador/ }).click()
      await viewer().getByTestId('viewer-code').waitFor()
      assert.match(await viewer().getByTestId('viewer-code').innerText(), /atualizando/)
      await viewer().getByRole('button', { name: 'Executar…' }).click()
      await page.waitForFunction(() =>
        ((window as any).__mockViewerCalls as string[]).at(-1)?.startsWith('run-temp:')
      )
      assert.match((await osCalls()).at(-1) ?? '', /^run-temp:atualizar\.sh:\d+$/)
      await shot('14b-remote-exec-cards')
    }
  )

  await step('remoto: host offline → estados "Host offline" no painel e na aba', async () => {
    await hostState('host-offline')
    await viewer().getByRole('button', { name: 'Recarregar' }).click()
    const problem = viewer().getByTestId('viewer-problem')
    await problem.waitFor()
    assert.match(await problem.innerText(), /Host offline[\s\S]*PC do escritório/)
    const panel = page.getByTestId('right-panel')
    await panel.getByRole('button', { name: 'Recarregar' }).click()
    await panel.getByText(/Host offline —/).waitFor()
    await shot('15-remote-offline')
  })

  await app.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} ok · screenshots em ${SHOTS}`)
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
