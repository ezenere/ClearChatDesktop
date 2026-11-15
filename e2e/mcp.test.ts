// Conectores (MCP) — partes puras (@shared/mcp) e a herança por servidor (@shared/chatInherit).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/mcp.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveTransport,
  mcpApprovalMode,
  mcpAvailability,
  mcpCommandText,
  mcpFormContent,
  mcpFormFromRequest,
  mcpInputSchema,
  mcpInstructionsBlock,
  mcpResultView,
  mcpServersOn,
  mcpToolDefinition,
  mcpToolEntries,
  mcpWireName,
  normalizeMcpServer,
  parseMcpImport,
  slugMcpName,
  uniqueMcpName,
  validateMcpName,
  type McpServerDef
} from '../src/shared/mcp.ts'
import {
  personaDefines,
  readUnit,
  sameUnit,
  touchedUnits,
  unitsOfKey,
  writeUnit
} from '../src/shared/chatInherit.ts'
import type { ChatConfig } from '../src/shared/types.ts'

const server = (over: Partial<McpServerDef> = {}): McpServerDef =>
  normalizeMcpServer({
    id: 'mcp_1',
    name: 'github',
    transport: { type: 'stdio', command: 'npx', args: ['-y', '@x/github'], env: { TOKEN: 's' } },
    approval: { mode: 'ask' },
    tools: {
      tools: [
        {
          name: 'create_issue',
          description: 'Cria uma issue. Detalhes…',
          inputSchema: { type: 'object' }
        },
        { name: 'list.repos', inputSchema: { type: 'object' } }
      ],
      at: 1
    },
    createdAt: 1,
    updatedAt: 1,
    ...over
  })!

test('nomes curtos: validação, slug e únicos', () => {
  assert.equal(validateMcpName('github'), null)
  assert.equal(validateMcpName('my-server-2'), null)
  assert.ok(validateMcpName('GitHub'))
  assert.ok(validateMcpName('-x'))
  assert.ok(validateMcpName('a'.repeat(25)))
  assert.equal(slugMcpName('GitHub Enterprise'), 'github-enterprise')
  assert.equal(slugMcpName('Ação & Reação!'), 'acao-reacao')
  assert.equal(slugMcpName('***'), 'conector')
  assert.equal(uniqueMcpName('GitHub', ['github']), 'github-2')
  assert.equal(uniqueMcpName('GitHub', ['github', 'github-2']), 'github-3')
})

test('registro: normalização descarta inválidos e lixo', () => {
  assert.equal(
    normalizeMcpServer({
      id: 'x',
      name: 'Bad Name',
      transport: { type: 'http', url: 'https://a' }
    }),
    null
  )
  assert.equal(
    normalizeMcpServer({ id: 'x', name: 'ok', transport: { type: 'http', url: 'ftp://a' } }),
    null
  )
  assert.equal(
    normalizeMcpServer({ id: 'x', name: 'ok', transport: { type: 'stdio', command: ' ' } }),
    null
  )
  const s = normalizeMcpServer({
    id: 'x',
    name: 'ok',
    transport: { type: 'stdio', command: 'uvx', args: ['a', 3], env: { A: 'b', C: 1 } },
    oauth: true, // só HTTP
    approval: { mode: 'nope', tools: { a: 'always', b: 'x' } },
    extra: 1
  })!
  assert.deepEqual(s.transport, { type: 'stdio', command: 'uvx', args: ['a'], env: { A: 'b' } })
  assert.equal(s.oauth, undefined)
  assert.deepEqual(s.approval, { mode: 'ask', tools: { a: 'always' } })
  assert.equal('extra' in s, false)
  const h = normalizeMcpServer({
    id: 'y',
    name: 'notion',
    transport: { type: 'http', url: 'https://mcp.notion.com/mcp', headers: { A: 'b' } },
    oauth: true,
    approval: { mode: 'smart' }
  })!
  assert.equal(h.oauth, true)
  assert.equal(mcpApprovalMode(h, 'x'), 'smart')
  assert.equal(mcpApprovalMode(s, 'a'), 'always')
  assert.equal(mcpApprovalMode(s, 'b'), 'ask')
})

test('stdio: comando exato, ativação por aparelho e ajustes locais', () => {
  const s = server()
  const t = s.transport as Extract<McpServerDef['transport'], { type: 'stdio' }>
  assert.equal(mcpCommandText(t), 'npx -y @x/github')
  assert.equal(
    mcpCommandText({ ...t, args: ["it's here", 'a b'], cwd: '/tmp' }),
    `npx 'it'\\''s here' 'a b'   (em /tmp)`
  )
  assert.deepEqual(mcpAvailability(s, undefined, 'computer'), {
    ok: false,
    reason: 'not-activated'
  })
  assert.deepEqual(mcpAvailability(s, { activated: 'npx -y @x/github' }, 'phone'), {
    ok: false,
    reason: 'phone'
  })
  assert.deepEqual(mcpAvailability(s, { activated: 'npx -y @x/github' }, 'computer'), { ok: true })
  // o comando mudou (no registro sincronizado) → precisa ativar de novo
  assert.deepEqual(mcpAvailability(s, { activated: 'npx -y @x/old' }, 'computer'), {
    ok: false,
    reason: 'command-changed'
  })
  // ajuste local muda o comando efetivo (e é ele que se ativa)
  const local = { override: { args: ['-y', '@x/github@2'], env: { EXTRA: '1' } } }
  const eff = effectiveTransport(s, local) as typeof t
  assert.deepEqual(eff.args, ['-y', '@x/github@2'])
  assert.deepEqual(eff.env, { TOKEN: 's', EXTRA: '1' })
  assert.deepEqual(mcpAvailability(s, { ...local, activated: mcpCommandText(eff) }, 'computer'), {
    ok: true
  })
  // HTTP vale em qualquer aparelho
  const h = server({ transport: { type: 'http', url: 'https://x/mcp', headers: {} } })
  assert.deepEqual(mcpAvailability(h, undefined, 'phone'), { ok: true })
})

test('nomes no modelo: prefixo, limpeza, teto de 64 e colisão', () => {
  assert.equal(mcpWireName('github', 'create_issue'), 'mcp__github__create_issue')
  assert.equal(mcpWireName('github', 'list.repos'), 'mcp__github__list_repos')
  const long = mcpWireName('a-very-long-server-name', 'x'.repeat(80))
  assert.ok(long.length <= 64, long)
  assert.match(long, /^mcp__a-very-long-server-name__x+_[0-9a-z]{6}$/)
  // determinístico
  assert.equal(long, mcpWireName('a-very-long-server-name', 'x'.repeat(80)))
  const s = server({
    tools: {
      tools: [
        { name: 'a.b', inputSchema: {} },
        { name: 'a_b', inputSchema: {} },
        { name: 'off', inputSchema: {} }
      ],
      at: 1
    }
  })
  const entries = mcpToolEntries([s], { mcp_1: { on: true, off: ['off'] } }, (x) => x.tools!.tools)
  assert.deepEqual(
    entries.map((e) => e.wire),
    ['mcp__github__a_b', `mcp__github__a_b_${entries[1].wire.slice(-6)}`]
  )
  assert.notEqual(entries[0].wire, entries[1].wire)
  assert.deepEqual(
    mcpToolEntries([s], { mcp_1: { on: false } }, (x) => x.tools!.tools),
    []
  )
  assert.deepEqual(
    mcpToolEntries([s], {}, (x) => x.tools!.tools),
    []
  )
})

test('esquema: $ref resolvido, $defs fora, raiz object; definição com a descrição do servidor', () => {
  const sch = mcpInputSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      who: { $ref: '#/$defs/person', description: 'quem' },
      tree: { $ref: '#/definitions/node' }
    },
    $defs: { person: { type: 'object', properties: { name: { type: 'string' } } } },
    definitions: { node: { type: 'object', properties: { child: { $ref: '#/definitions/node' } } } }
  }) as unknown as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(sch.$schema, undefined)
  assert.equal(sch.$defs, undefined)
  assert.equal(sch.definitions, undefined)
  assert.deepEqual(sch.properties.who, {
    type: 'object',
    properties: { name: { type: 'string' } },
    description: 'quem'
  })
  // recursão: corta na profundidade máxima, sem $ref sobrando
  assert.ok(!JSON.stringify(sch).includes('$ref'))
  assert.deepEqual(mcpInputSchema({}), { type: 'object', properties: {} })
  const [e] = mcpToolEntries([server()], { mcp_1: { on: true } }, (x) => x.tools!.tools)
  const def = mcpToolDefinition(e)
  assert.equal(def.function.name, 'mcp__github__create_issue')
  assert.equal(def.function.description, 'Cria uma issue. Detalhes…')
})

test('instruções do servidor: só as ligadas no chat, marcadas pelo servidor', () => {
  const s = server({
    tools: { tools: [], instructions: 'Use sempre o repo X.', at: 1 }
  })
  assert.equal(mcpInstructionsBlock([s], { mcp_1: { on: true } }), null)
  assert.equal(
    mcpInstructionsBlock([s], { mcp_1: { on: true, instructions: true } }),
    '<mcp_server_instructions server="github">\nUse sempre o repo X.\n</mcp_server_instructions>'
  )
  assert.equal(mcpInstructionsBlock([s], { mcp_1: { on: false, instructions: true } }), null)
})

test('resultado: texto, imagem, recursos, estruturado e erro', () => {
  const v = mcpResultView({
    content: [
      { type: 'text', text: 'oi' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt' },
      { type: 'resource', resource: { uri: 'mem://x', text: 'conteúdo' } },
      { type: 'resource', resource: { uri: 'mem://b', blob: 'QUJD', mimeType: 'application/zip' } },
      { type: 'audio', data: 'x', mimeType: 'audio/wav' }
    ]
  })
  assert.deepEqual(v.images, [{ data: 'AAAA', mimeType: 'image/png' }])
  assert.equal(
    v.text,
    [
      'oi',
      '[imagem image/png]',
      '[recurso "a.txt": file:///a.txt]',
      '[recurso mem://x]\nconteúdo',
      '[recurso binário mem://b application/zip — 3 bytes]',
      '[áudio audio/wav — não suportado]'
    ].join('\n\n')
  )
  assert.equal(v.isError, false)
  assert.equal(mcpResultView({ content: [], structuredContent: { a: 1 } }).text, '{\n  "a": 1\n}')
  assert.equal(
    mcpResultView({ content: [{ type: 'text', text: 'x' }], isError: true }).isError,
    true
  )
  assert.equal(mcpResultView(null).text, '(sem conteúdo)')
})

test('elicitação: esquema → campos; respostas validadas nos tipos', () => {
  const form = mcpFormFromRequest({
    message: 'Dados',
    requestedSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Nome', minLength: 2 },
        age: { type: 'integer', minimum: 0, maximum: 150 },
        ok: { type: 'boolean' },
        color: { type: 'string', enum: ['r', 'g'], enumNames: ['Vermelho', 'Verde'] },
        size: { type: 'string', oneOf: [{ const: 's', title: 'Pequeno' }] },
        tags: { type: 'array', items: { enum: ['a', 'b'] }, maxItems: 1 }
      },
      required: ['name', 'ok']
    }
  })!
  assert.equal(form.message, 'Dados')
  assert.deepEqual(
    form.fields.map((f) => [f.key, f.kind, f.required]),
    [
      ['name', 'text', true],
      ['age', 'integer', false],
      ['ok', 'boolean', true],
      ['color', 'select', false],
      ['size', 'select', false],
      ['tags', 'multiselect', false]
    ]
  )
  assert.deepEqual(form.fields[3].options, [
    { value: 'r', label: 'Vermelho' },
    { value: 'g', label: 'Verde' }
  ])
  const bad = mcpFormContent(form, { name: 'a', age: '1.5', color: 'x', tags: ['a', 'b'] })
  assert.deepEqual(Object.keys(bad.errors).sort(), ['age', 'color', 'name', 'tags'])
  const good = mcpFormContent(form, { name: 'Edu', age: '30', color: 'g', tags: ['b'] })
  assert.deepEqual(good.errors, {})
  assert.deepEqual(good.content, { name: 'Edu', age: 30, ok: false, color: 'g', tags: ['b'] })
  // esquema com objeto aninhado: não sabemos mostrar
  assert.equal(
    mcpFormFromRequest({ requestedSchema: { properties: { x: { type: 'object' } } } }),
    null
  )
})

test('importação: Claude Desktop, VS Code, mapa direto, nomes únicos e ignorados', () => {
  const r = parseMcpImport(
    JSON.stringify({
      mcpServers: {
        GitHub: { command: 'npx', args: ['-y', 'gh'], env: { T: '1' } },
        notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
        old: { type: 'sse', url: 'https://x/sse' },
        broken: { foo: 1 }
      }
    }),
    ['github']
  )
  assert.ok('items' in r)
  assert.deepEqual(
    r.items.map((i) => [i.name, i.transport.type]),
    [
      ['github-2', 'stdio'],
      ['notion', 'http'],
      ['old', 'http']
    ]
  )
  assert.ok(r.items[2].note)
  assert.deepEqual(r.skipped, ['broken'])
  const vs = parseMcpImport(JSON.stringify({ servers: { pw: { type: 'stdio', command: 'npx' } } }))
  assert.ok('items' in vs && vs.items[0].name === 'pw')
  const bare = parseMcpImport(JSON.stringify({ x: { command: 'a' } }))
  assert.ok('items' in bare && bare.items.length === 1)
  assert.ok('error' in parseMcpImport('{nope'))
  assert.ok('error' in parseMcpImport('[]'))
})

test('herança: cada servidor é uma unidade (mcpServers.<id>), ausente = desligado', () => {
  const persona = {
    mcpServers: { a: { on: true }, b: { on: true, off: ['x'] } }
  } as Partial<ChatConfig>
  const chat = { mcpServers: { a: { on: false } } } as Partial<ChatConfig>
  assert.deepEqual(unitsOfKey('mcpServers', persona, chat), ['mcpServers.a', 'mcpServers.b'])
  assert.deepEqual(readUnit(persona, 'mcpServers.b'), { on: true, off: ['x'] })
  assert.equal(readUnit(chat, 'mcpServers.b'), undefined)
  assert.ok(sameUnit('mcpServers.b', undefined, { on: false }), 'ausente = desligado')
  assert.ok(!sameUnit('mcpServers.a', { on: true }, { on: false }))
  assert.ok(sameUnit('mcpSubagents', undefined, false))
  assert.ok(personaDefines(persona as never, 'mcpServers.a'))
  assert.ok(!personaDefines(persona as never, 'mcpServers.zzz'))
  const c: Partial<ChatConfig> = {}
  writeUnit(c, 'mcpServers.a', { on: true, junk: 1 })
  assert.deepEqual(c.mcpServers, { a: { on: true } })
  writeUnit(c, 'mcpServers.a', undefined)
  assert.equal(c.mcpServers, undefined)
  // editar um servidor só toca a unidade dele
  assert.deepEqual(
    touchedUnits(persona, { mcpServers: { ...persona.mcpServers, a: { on: false } } }),
    ['mcpServers.a']
  )
  assert.deepEqual(mcpServersOn(persona), ['a', 'b'])
})
