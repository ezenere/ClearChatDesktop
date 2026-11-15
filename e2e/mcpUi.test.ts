// Lógica pura da UI dos conectores (src/renderer/src/lib/mcp.ts), sem Electron: estado legível,
// nome do modelo → servidor + tool, dicas do servidor, escolha por chat (`mcpServers`), resumos das
// seções, tools que vão daqui e o rascunho do formulário (validação, entrada do IPC, ajustes deste
// computador). Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpWireName, type McpServerDef, type McpServerView } from '../src/shared/mcp.ts'
import {
  emptyMcpDraft,
  mcpChoiceOf,
  mcpDetailsSummary,
  mcpDraftOf,
  mcpDraftToInput,
  mcpEntriesHere,
  mcpHintChips,
  mcpOverrideDraftOf,
  mcpOverrideOf,
  mcpStatusInfo,
  mcpSummary,
  mcpUnavailableReason,
  parseArgsText,
  resolveMcpTool,
  withMcpChoice,
  withMcpTool
} from '../src/renderer/src/lib/mcp.ts'

const pw: McpServerDef = {
  id: 's1',
  name: 'playwright',
  title: 'Navegador',
  transport: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'], env: {} },
  approval: { mode: 'ask' },
  tools: {
    tools: [
      { name: 'browser_navigate', description: 'Abre uma URL.', inputSchema: {} },
      {
        name: 'browser.snapshot',
        title: 'Snapshot',
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true }
      }
    ],
    at: 0
  },
  createdAt: 0,
  updatedAt: 0
}
const gh: McpServerDef = {
  id: 's2',
  name: 'github',
  transport: { type: 'http', url: 'https://x/mcp', headers: {} },
  oauth: true,
  approval: { mode: 'smart' },
  tools: { tools: [{ name: 'create_issue', inputSchema: {} }], at: 0 },
  createdAt: 0,
  updatedAt: 0
}
const view = (server: McpServerDef, status: McpServerView['status']): McpServerView => ({
  server,
  status,
  local: {},
  hasLogin: false
})

test('estado legível de cada situação do aparelho', () => {
  const s = (st: Partial<McpServerView['status']>): string =>
    mcpStatusInfo({ status: { state: 'idle', log: [], ...st } }).label
  assert.equal(s({ state: 'ready', toolCount: 3 }), 'Conectado (3 tools)')
  assert.equal(s({ state: 'ready', toolCount: 1 }), 'Conectado (1 tool)')
  assert.equal(s({ state: 'connecting' }), 'Conectando…')
  assert.equal(s({ state: 'needs-auth' }), 'Precisa entrar')
  assert.equal(
    s({ state: 'unavailable', unavailable: 'not-activated' }),
    'Não ativado neste computador'
  )
  assert.equal(
    s({ state: 'unavailable', unavailable: 'command-changed' }),
    'Comando mudou — ative de novo'
  )
  assert.equal(s({ state: 'idle' }), 'Desconectado')
  const err = mcpStatusInfo({
    status: { state: 'error', error: 'spawn npx ENOENT\nstack…', log: [] }
  })
  assert.equal(err.label, 'Erro: spawn npx ENOENT')
  assert.equal(err.detail, 'spawn npx ENOENT\nstack…')
  assert.equal(err.tone, 'danger')
  // motivo no painel: só o que impede de rodar aqui
  assert.equal(
    mcpUnavailableReason({
      status: { state: 'unavailable', unavailable: 'not-activated', log: [] }
    }),
    'não ativado aqui'
  )
  assert.equal(mcpUnavailableReason({ status: { state: 'needs-auth', log: [] } }), 'precisa entrar')
  assert.equal(mcpUnavailableReason({ status: { state: 'error', log: [] } }), null)
})

test('nome do modelo → servidor e tool (nome limpo, título, servidor apagado)', () => {
  const r = resolveMcpTool('mcp__playwright__browser_navigate', [pw, gh])
  assert.equal(r?.server?.id, 's1')
  assert.equal(r?.serverLabel, 'Navegador')
  assert.equal(r?.toolName, 'browser_navigate')
  assert.equal(r?.toolTitle, 'browser_navigate')
  // nome com caractere trocado na limpeza (browser.snapshot → browser_snapshot)
  const snap = resolveMcpTool(mcpWireName('playwright', 'browser.snapshot'), [pw])
  assert.equal(snap?.toolName, 'browser.snapshot')
  assert.equal(snap?.toolTitle, 'Snapshot')
  // sem cadastro: os pedaços do nome
  const gone = resolveMcpTool('mcp__linear__list_issues', [pw])
  assert.equal(gone?.server, null)
  assert.equal(gone?.serverLabel, 'linear')
  assert.equal(gone?.toolName, 'list_issues')
  assert.equal(resolveMcpTool('shell', [pw]), null)
})

test('dicas do servidor: só as declaradas; somente leitura vence destrutiva', () => {
  assert.deepEqual(
    mcpHintChips(pw.tools!.tools[1]).map((c) => c.label),
    ['somente leitura', 'mundo aberto']
  )
  assert.deepEqual(mcpHintChips(pw.tools!.tools[0]), [])
})

test('escolha por chat: liga, tools desligadas, desligado sem nada próprio some', () => {
  let cfg: {
    mcpServers?: Record<string, { on: boolean; off?: string[]; instructions?: boolean }>
  } = {}
  assert.deepEqual(mcpChoiceOf(cfg, 's1'), { on: false })
  cfg = { mcpServers: withMcpChoice(cfg, 's1', { on: true }) }
  assert.deepEqual(cfg.mcpServers, { s1: { on: true } })
  cfg = {
    mcpServers: withMcpChoice(
      cfg,
      's1',
      withMcpTool(mcpChoiceOf(cfg, 's1'), 'browser_navigate', false)
    )
  }
  assert.deepEqual(cfg.mcpServers, { s1: { on: true, off: ['browser_navigate'] } })
  cfg = {
    mcpServers: withMcpChoice(
      cfg,
      's1',
      withMcpTool(mcpChoiceOf(cfg, 's1'), 'browser_navigate', true)
    )
  }
  assert.deepEqual(cfg.mcpServers, { s1: { on: true } })
  // desligar guarda as tools desligadas/instruções (religar volta igual); sem nada → some
  cfg = { mcpServers: withMcpChoice(cfg, 's1', { on: false, instructions: true }) }
  assert.deepEqual(cfg.mcpServers, { s1: { on: false, instructions: true } })
  cfg = { mcpServers: withMcpChoice(cfg, 's1', { on: false }) }
  assert.deepEqual(cfg.mcpServers, {})
})

test('resumos e tools que vão daqui (stdio não ativado fica de fora)', () => {
  const views = [
    view(pw, { state: 'unavailable', unavailable: 'not-activated', log: [] }),
    view(gh, { state: 'ready', toolCount: 1, log: [] })
  ]
  assert.deepEqual(mcpSummary({}, views), { text: 'desligados', changed: false })
  const cfg = {
    mcpServers: {
      s1: { on: true, off: ['browser_navigate'] },
      s2: { on: true, instructions: true }
    },
    mcpSubagents: true
  }
  assert.deepEqual(mcpSummary(cfg, views), {
    text: '2 ligados · 1 indisponível aqui',
    changed: true
  })
  assert.deepEqual(mcpDetailsSummary(cfg, views), {
    text: '1 tool desligada · instruções de 1 · nos subagentes',
    changed: true
  })
  assert.deepEqual(mcpDetailsSummary({}, views).changed, false)
  assert.deepEqual(
    mcpEntriesHere(cfg, views).map((e) => e.wire),
    ['mcp__github__create_issue']
  )
})

test('formulário: argumentos, validação e entrada do IPC', () => {
  assert.deepEqual(parseArgsText(' -y \n\n@pkg/x\r\n~/dir '), ['-y', '@pkg/x', '~/dir'])
  const bad = mcpDraftToInput({ ...emptyMcpDraft(), name: 'Bad_Name' }, [])
  assert('errors' in bad)
  assert.match(bad.errors.name, /letras minúsculas/)
  assert.equal(bad.errors.command, 'Informe o comando.')
  const dup = mcpDraftToInput({ ...emptyMcpDraft(), name: 'playwright', command: 'npx' }, [
    'playwright'
  ])
  assert('errors' in dup && /Já existe/.test(dup.errors.name))
  const ok = mcpDraftToInput(
    {
      ...emptyMcpDraft(),
      title: ' Arquivos ',
      name: 'arquivos',
      command: 'npx',
      args: '-y\nserver',
      env: [
        { key: 'TOKEN', value: 's' },
        { key: '', value: '' }
      ],
      timeout: '30'
    },
    []
  )
  assert('input' in ok)
  assert.deepEqual(ok.input, {
    name: 'arquivos',
    title: 'Arquivos',
    transport: { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 's' } },
    oauth: false,
    timeoutMs: 30_000
  })
  const http = mcpDraftToInput(
    { ...emptyMcpDraft(), type: 'http', name: 'gh', url: 'ftp://x', timeout: '0' },
    []
  )
  assert('errors' in http)
  assert.equal(http.errors.url, 'Use um endereço http:// ou https://.')
  assert.equal(http.errors.timeout, 'Use segundos (1 ou mais).')
  const env2 = mcpDraftToInput(
    {
      ...emptyMcpDraft(),
      name: 'x',
      command: 'y',
      env: [
        { key: 'A', value: '1' },
        { key: 'A', value: '2' }
      ]
    },
    []
  )
  assert('errors' in env2 && /repetido/.test(env2.errors.env))
  // ida e volta pelo cadastro (sem teto próprio = 0, que o cadastro descarta)
  const back = mcpDraftToInput(mcpDraftOf(gh), [])
  assert('input' in back)
  assert.deepEqual(back.input, {
    name: 'github',
    title: '',
    transport: { type: 'http', url: 'https://x/mcp', headers: {} },
    oauth: true,
    timeoutMs: 0
  })
})

test('ajustes deste computador: só o que foi ligado; nada → null', () => {
  assert.equal(mcpOverrideOf(mcpOverrideDraftOf(undefined)), null)
  const d = mcpOverrideDraftOf({ args: ['a'], cwd: '' })
  assert.equal(d.useArgs, true)
  assert.equal(d.useCwd, true)
  assert.deepEqual(mcpOverrideOf({ ...d, env: [{ key: 'K', value: 'v' }] }), {
    args: ['a'],
    env: { K: 'v' },
    cwd: ''
  })
})
