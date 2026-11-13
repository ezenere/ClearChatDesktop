// Testes unitários das tools compactadas e da tool `datetime` (protocolo 1.11.0, SYNC_PROTOCOL.md
// §4.3.6 — "Tools compactadas e `datetime`"), só a lógica pura de @shared (o mobile vendora):
// descrições curtas (1 a 20 palavras, todas as tools), plano da request (compactas + tool_search —
// antes search_tool — + prompt fixo só com alguma compacta; end_call sempre completa;
// determinístico; nos modos de busca nativa, 1.12.0: completas e adiadas), a tool_search
// devolvendo exatamente a definição que iria sem compactação (inclusive as ajustadas ao provedor),
// validação de argumentos com a definição completa no erro, o formatador strftime (nomes em pt-BR,
// fusos, erros) e as unidades de herança `toolsCompact` / `toolsFull.<tool>`.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACT_PARAMETERS,
  COMPACT_TOOLS_PROMPT,
  COMPACTABLE_TOOL_NAMES,
  SEARCH_TOOL_DEFINITION,
  TOOL_SHORT_DESCRIPTIONS,
  compactToolDefinition,
  compactToolsOn,
  invalidArgsText,
  normalizeToolsFull,
  planTools,
  runSearchTool,
  sendsCompact,
  sentToolDefinition,
  shortToolDescription,
  validateToolArgs,
  withCompactPrompt,
  withFullTool,
  wordCount
} from '../src/shared/compactTools.ts'
import {
  DATETIME_CODES,
  formatDateTime,
  runDatetimeTool,
  zonedParts
} from '../src/shared/datetime.ts'
import {
  END_CALL_TOOL,
  MEMORY_TOOL_NAMES,
  SEARCH_TOOL,
  SKILL_TOOL_NAMES,
  TOOL_DEFINITIONS,
  TOOL_LABELS,
  TOOL_NAMES,
  shellToolDefinition,
  toolDefinitionFor,
  type ToolDefinition
} from '../src/shared/tools.ts'
import { APP_TOOL_NAMES, PHONE_TOOL_NAMES, PHONE_TOOL_SHORT } from '../src/shared/deviceTools.ts'
import { DEFAULT_CHAT_CONFIG, defaultToolsPrompt } from '../src/shared/defaults.ts'
import {
  allUnits,
  applyChatEdit,
  effectiveChatConfig,
  isKnownUnit,
  mergeChatConfig3,
  migrateChatOverrides,
  newInheritingChatConfig,
  normalizeOverrides,
  personaDefines,
  personaEffectiveConfig,
  readUnit,
  revertToInherit,
  touchedUnits,
  unitOfKey,
  unitsOfKey,
  writeUnit,
  type InheritConfig,
  type InheritEnv
} from '../src/shared/chatInherit.ts'
import { PRESET_FIELDS, sanitizePresetConfig, type PresetConfig } from '../src/shared/presets.ts'

// ---------------- descrições curtas ----------------

test('descrição curta: TODAS as tools compactáveis (core, datetime, memória, skills, celular), 1 a 20 palavras', () => {
  const all = [...TOOL_NAMES, ...MEMORY_TOOL_NAMES, ...SKILL_TOOL_NAMES, ...PHONE_TOOL_NAMES]
  assert.ok(TOOL_NAMES.includes('datetime'), 'datetime no padrão de tools do app')
  assert.ok(APP_TOOL_NAMES.includes('datetime'))
  assert.ok(DEFAULT_CHAT_CONFIG('/w').enabledTools.includes('datetime'))
  assert.deepEqual([...COMPACTABLE_TOOL_NAMES].sort(), [...new Set(all)].sort())
  for (const t of all) {
    const d = TOOL_SHORT_DESCRIPTIONS[t]
    assert.ok(d, `descrição curta de ${t}`)
    const n = wordCount(d)
    assert.ok(n >= 1 && n <= 20, `${t}: ${n} palavras ("${d}")`)
    assert.ok(d.length < (TOOL_DEFINITIONS[t]?.function.description.length ?? Infinity), t)
  }
  // nada a mais: nem end_call nem tool_search (sempre completas)
  assert.deepEqual(Object.keys(TOOL_SHORT_DESCRIPTIONS).sort(), [...new Set(all)].sort())
  assert.equal(TOOL_SHORT_DESCRIPTIONS[END_CALL_TOOL], undefined)
  assert.equal(TOOL_SHORT_DESCRIPTIONS[SEARCH_TOOL], undefined)
  assert.equal(PHONE_TOOL_SHORT.get_location, TOOL_SHORT_DESCRIPTIONS.get_location)
  // tool_search e datetime: rótulos e definições do app; tool_search não é escolhível
  assert.equal(SEARCH_TOOL, 'tool_search', 'renomeada em 1.12.0')
  assert.equal(TOOL_LABELS.datetime, 'Data e hora')
  assert.equal(TOOL_LABELS.tool_search, 'Ler definição de tool')
  assert.ok(!TOOL_NAMES.includes(SEARCH_TOOL) && !APP_TOOL_NAMES.includes(SEARCH_TOOL))
  assert.deepEqual(SEARCH_TOOL_DEFINITION, TOOL_DEFINITIONS.tool_search)
  assert.equal(SEARCH_TOOL_DEFINITION.function.name, 'tool_search')
  assert.deepEqual(SEARCH_TOOL_DEFINITION.function.parameters.required, ['names'])
  // tool sem descrição do app (de outra versão): 1ª frase, até 20 palavras
  assert.equal(shortToolDescription('mcp_x', 'Faz X. Depois Y.'), 'Faz X.')
  assert.equal(shortToolDescription('constructor', 'Nome estranho.'), 'Nome estranho.')
  assert.equal(wordCount(shortToolDescription('mcp_y', 'a '.repeat(40))), 20)
})

// ---------------- plano da request ----------------

const fullDefs = (names: string[]): ToolDefinition[] =>
  names.map((n) => toolDefinitionFor(n as never, ['OR', 'Local']))

test('plano: compactação ligada (padrão) → compactas + tool_search no fim + prompt fixo', () => {
  const full = fullDefs(['read_file', 'shell', 'delegate_task', 'memory_search', 'list_skills'])
  const plan = planTools(full, {})
  assert.equal(compactToolsOn({}), true, 'ausente = ligada')
  assert.deepEqual(
    plan.definitions.map((d) => d.function.name),
    ['read_file', 'shell', 'delegate_task', 'memory_search', 'list_skills', 'tool_search']
  )
  assert.equal(plan.mode, 'local')
  assert.deepEqual(plan.deferred, [])
  assert.equal(plan.searchEntry, null)
  assert.deepEqual(plan.compacted, [
    'read_file',
    'shell',
    'delegate_task',
    'memory_search',
    'list_skills'
  ])
  for (const d of plan.definitions.slice(0, -1)) {
    assert.deepEqual(Object.keys(d.function), ['name', 'description', 'parameters'])
    assert.deepEqual(
      d.function.parameters,
      COMPACT_PARAMETERS,
      'esquema vazio, aceita qualquer objeto'
    )
    assert.equal(d.function.description, TOOL_SHORT_DESCRIPTIONS[d.function.name])
  }
  assert.deepEqual(plan.definitions.at(-1), SEARCH_TOOL_DEFINITION, 'tool_search sempre completa')
  assert.match(COMPACT_TOOLS_PROMPT, /com tool_search \(/, 'o prompt fixo nomeia a tool nova')
  assert.equal(plan.prompt, COMPACT_TOOLS_PROMPT)
  assert.deepEqual(plan.full, full, 'as completas, como iriam sem compactação')
  // prompt fixo no FIM do system prompt (linha em branco antes)
  assert.equal(withCompactPrompt('SYS', plan), `SYS\n\n${COMPACT_TOOLS_PROMPT}`)
  assert.equal(withCompactPrompt('', plan), COMPACT_TOOLS_PROMPT)
  // determinístico (prefixo de cache): mesma entrada → mesmos bytes
  assert.equal(JSON.stringify(planTools(full, {})), JSON.stringify(plan))
})

test('plano: sem nenhuma compacta (desligada ou todas em toolsFull) → sem tool_search e sem prompt', () => {
  const full = fullDefs(['read_file', 'shell'])
  const off = planTools(full, { toolsCompact: false, toolsFull: [] })
  assert.equal(off.mode, 'off')
  assert.deepEqual(off.definitions, full)
  assert.deepEqual(off.compacted, [])
  assert.equal(off.prompt, null)
  assert.equal(withCompactPrompt('SYS', off), 'SYS')
  const allFull = planTools(full, { toolsCompact: true, toolsFull: ['shell', 'read_file'] })
  assert.deepEqual(allFull.definitions, full)
  assert.equal(allFull.prompt, null)
  // uma completa, outra compacta
  const mixed = planTools(full, { toolsFull: ['shell'] })
  assert.deepEqual(mixed.compacted, ['read_file'])
  assert.deepEqual(
    mixed.definitions[1],
    full[1],
    'shell vai completa (descrição do shell detectado)'
  )
  assert.equal(mixed.definitions.at(-1)!.function.name, 'tool_search')
  // toolsFull não muda nada com a compactação desligada
  assert.equal(sendsCompact('shell', { toolsCompact: false, toolsFull: [] }), false)
})

test('plano: end_call sempre completa; tool_search (ou search_tool) nunca vem de enabledTools/toolsFull', () => {
  const full = [...fullDefs(['shell']), TOOL_DEFINITIONS.end_call]
  const p = planTools(full, {})
  assert.deepEqual(p.compacted, ['shell'])
  assert.deepEqual(p.definitions[1], TOOL_DEFINITIONS.end_call)
  assert.equal(sendsCompact('end_call', {}), false)
  // só end_call (nada compactável) → nem tool_search nem prompt
  const onlyEnd = planTools([TOOL_DEFINITIONS.end_call], {})
  assert.deepEqual(onlyEnd.definitions, [TOOL_DEFINITIONS.end_call])
  assert.equal(onlyEnd.prompt, null)
  // uma tool_search (ou a antiga search_tool) que viesse como "habilitada" é ignorada (não duplica)
  const legacy = {
    ...SEARCH_TOOL_DEFINITION,
    function: { ...SEARCH_TOOL_DEFINITION.function, name: 'search_tool' }
  } as ToolDefinition
  const dup = planTools([...fullDefs(['shell']), SEARCH_TOOL_DEFINITION, legacy], {})
  assert.deepEqual(
    dup.definitions.map((d) => d.function.name),
    ['shell', 'tool_search']
  )
  assert.ok(!dup.full.some((d) => /search_tool|tool_search/.test(d.function.name)))
  // toolsFull: lida sem tool_search/search_tool/end_call, nomes antigos mapeados, desconhecidas no fim
  assert.deepEqual(
    normalizeToolsFull([
      'search_tool',
      'tool_search',
      'bash',
      'end_call',
      'mcp_x',
      'memory_read',
      'list_dir',
      3
    ]),
    ['list_dir', 'shell', 'memory_read', 'mcp_x']
  )
  assert.deepEqual(normalizeToolsFull(undefined), [])
  assert.deepEqual(withFullTool(['mcp_x', 'skill_load'], 'read_file', true), [
    'read_file',
    'skill_load',
    'mcp_x'
  ])
  assert.deepEqual(withFullTool(['mcp_x', 'read_file'], 'read_file', false), ['mcp_x'])
})

test('definição enviada por tool (o <> da UI) e o texto gerado das tools seguem o modo', () => {
  const d = TOOL_DEFINITIONS.read_file
  assert.deepEqual(sentToolDefinition(d, { toolsCompact: false }), d)
  assert.deepEqual(sentToolDefinition(d, { toolsFull: ['read_file'] }), d)
  assert.deepEqual(sentToolDefinition(d, {}), compactToolDefinition(d))
  // texto das tools no system prompt (gerado): compactas com a descrição curta, tool_search completa
  const plan = planTools(fullDefs(['read_file', 'shell']), { toolsFull: ['shell'] })
  const native = defaultToolsPrompt(plan.definitions, true)
  assert.ok(native.includes(`- read_file: ${TOOL_SHORT_DESCRIPTIONS.read_file}`))
  assert.ok(native.includes(`- tool_search: ${SEARCH_TOOL_DEFINITION.function.description}`))
  assert.ok(native.includes(`- shell: ${TOOL_DEFINITIONS.shell.function.description}`))
  const text = defaultToolsPrompt(plan.definitions, false)
  assert.ok(text.includes('## read_file\n' + TOOL_SHORT_DESCRIPTIONS.read_file))
  assert.ok(text.includes('Parâmetros (JSON Schema): {"type":"object","properties":{}}'))
  assert.ok(text.includes(JSON.stringify(SEARCH_TOOL_DEFINITION.function.parameters)))
})

// ---------------- search_tool ----------------

test('search_tool: devolve EXATAMENTE a definição sem compactação (ajustadas ao provedor inclusive)', () => {
  const shellInfo = { name: 'zsh' as const, version: '5.9', os: 'Linux' }
  const full: ToolDefinition[] = [
    toolDefinitionFor('read_file', ['OR', 'Local']),
    toolDefinitionFor('delegate_task', ['OR', 'Local']), // `provider` com enum dos nomes
    toolDefinitionFor('list_models', ['Só um']), // sem `provider`
    shellToolDefinition(shellInfo),
    TOOL_DEFINITIONS.memory_write
  ]
  const r = runSearchTool({ names: ['delegate_task', 'shell', 'list_models'] }, full)
  assert.equal(r.status, 'ok')
  const out = JSON.parse(r.content)
  assert.deepEqual(out, [full[1].function, full[3].function, full[2].function])
  assert.deepEqual(out[0].parameters.properties.provider.enum, ['OR', 'Local'])
  assert.equal(out[2].parameters.properties.provider, undefined)
  assert.match(out[1].description, /sintaxe zsh/, 'shell com o shell detectado')
  // várias de uma vez, alias antigo, duplicatas
  const r2 = runSearchTool({ names: ['bash', 'memory_write', 'memory_write'] }, full)
  assert.deepEqual(JSON.parse(r2.content), [full[3].function, full[4].function])
  // nome desconhecido → erro com a lista das disponíveis (as encontradas vêm junto)
  const bad = runSearchTool({ names: ['read_file', 'nope'] }, full)
  assert.equal(bad.status, 'error')
  assert.match(
    bad.content,
    /^Erro: ferramenta desconhecida: nope\. Disponíveis: read_file, delegate_task, list_models, shell, memory_write\./
  )
  assert.ok(bad.content.includes(JSON.stringify(full[0].function)))
  const none = runSearchTool({ names: ['x', 'y'] }, full)
  assert.match(none.content, /ferramentas desconhecidas: x, y/)
  assert.ok(!none.content.includes('Definições das encontradas'))
  // a própria search_tool não é "disponível"; sem names → erro
  assert.equal(
    runSearchTool({ names: ['search_tool'] }, [...full, SEARCH_TOOL_DEFINITION]).status,
    'error'
  )
  assert.match(runSearchTool({}, full).content, /informe "names"/)
  assert.match(
    runSearchTool({ names: ['constructor'] }, full).content,
    /desconhecida: constructor\./
  )
  // um nome só como texto é aceito
  assert.equal(runSearchTool({ names: 'read_file' }, full).status, 'ok')
})

// ---------------- argumentos inválidos ----------------

test('argumentos: válidos passam (tolerante a número/booleano em texto); inválidos → erro com a definição completa', () => {
  const rf = TOOL_DEFINITIONS.read_file
  assert.deepEqual(validateToolArgs(rf, { path: 'a.txt' }), [])
  assert.deepEqual(validateToolArgs(rf, { path: 'a.txt', offset: '10', limit: 5 }), [])
  const p = validateToolArgs(rf, { file: 'a.txt' })
  assert.ok(p.includes('falta "path" (obrigatório)'), p.join())
  assert.ok(p.includes('parâmetro desconhecido: "file"'), p.join())
  assert.deepEqual(validateToolArgs(rf, { path: 'x', offset: 'dez' }), [
    '"offset" deve ser um número'
  ])
  // enum e objetos aninhados (ask_user)
  const mw = TOOL_DEFINITIONS.memory_write
  assert.deepEqual(validateToolArgs(mw, { category: 'nope' }), [
    '"category" deve ser um de: profile, topics, areas, people, preferences'
  ])
  const au = TOOL_DEFINITIONS.ask_user
  assert.deepEqual(
    validateToolArgs(au, { questions: [{ title: 'Q', options: [{ title: 'a' }] }] }),
    []
  )
  const nested = validateToolArgs(au, { questions: [{ title: 'Q', options: [] }] })
  assert.deepEqual(nested, ['"questions[0].options" precisa de pelo menos 1 itens'])
  assert.deepEqual(validateToolArgs(au, { questions: 'x' }), ['"questions" deve ser uma lista'])
  // esquema vazio (compacta) aceitaria tudo; a validação é contra a COMPLETA
  assert.deepEqual(validateToolArgs(compactToolDefinition(rf), { qualquer: 1 }), [])
  const text = invalidArgsText(rf, p)
  assert.ok(
    text.startsWith('Erro: argumentos inválidos para read_file: falta "path" (obrigatório)')
  )
  assert.ok(text.endsWith(JSON.stringify(rf.function)), 'definição completa no fim')
  assert.match(text, /foi enviada compactada/)
})

// ---------------- datetime ----------------

const NOW = Date.UTC(2026, 10, 13, 17, 5, 9) // 2026-11-13T17:05:09Z (sexta-feira)
const SP = { now: NOW, timeZone: 'America/Sao_Paulo' }

test('datetime: sem format → ISO 8601 com deslocamento + dia da semana + fuso (IANA e UTC±hh:mm)', () => {
  assert.deepEqual(formatDateTime(undefined, SP), {
    ok: true,
    text: '2026-11-13T14:05:09-03:00 · sexta-feira · fuso America/Sao_Paulo (UTC-03:00)'
  })
  assert.deepEqual(formatDateTime('', { now: NOW, timeZone: 'Asia/Kolkata' }), {
    ok: true,
    text: '2026-11-13T22:35:09+05:30 · sexta-feira · fuso Asia/Kolkata (UTC+05:30)'
  })
  assert.deepEqual(formatDateTime(null, { now: NOW, timeZone: 'UTC' }), {
    ok: true,
    text: '2026-11-13T17:05:09+00:00 · sexta-feira · fuso UTC (UTC+00:00)'
  })
  // padrão = fuso do aparelho
  const here = zonedParts({ now: NOW })
  assert.equal(here.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.equal(runDatetimeTool({}, SP).status, 'ok')
})

test('datetime: códigos strftime com nomes em pt-BR', () => {
  const f = (fmt: string, o: object = SP): string => {
    const r = formatDateTime(fmt, o)
    assert.ok(r.ok, JSON.stringify(r))
    return r.text
  }
  assert.equal(f('%A, %d de %B de %Y, %H:%M'), 'sexta-feira, 13 de novembro de 2026, 14:05')
  assert.equal(
    f('%a %b %e|%j|%u|%w|%y|%I %p|%Z|%z'),
    'sex nov 13|317|5|5|26|02 PM|America/Sao_Paulo|-0300'
  )
  assert.equal(f('%F %T|%D|%s|100%%|%S'), `2026-11-13 14:05:09|11/13/26|${NOW / 1000}|100%|09`)
  // dia com espaço (%e), meia-noite (12 AM), domingo (%u = 7, %w = 0), março e sábado
  const sun = { now: Date.UTC(2026, 2, 1, 3, 0, 0), timeZone: 'UTC' } // 2026-03-01 domingo 03:00
  assert.equal(f('%e|%u|%w|%A|%a|%B|%b|%I %p|%j', sun), ' 1|7|0|domingo|dom|março|mar|03 AM|060')
  const mid = { now: Date.UTC(2026, 7, 8, 0, 30, 0), timeZone: 'UTC' } // sábado 00:30
  assert.equal(f('%H %I %p %A %a %B', mid), '00 12 AM sábado sáb agosto')
  assert.equal(f('sem códigos'), 'sem códigos')
  assert.equal(DATETIME_CODES.length, 24)
})

test('datetime: código desconhecido / % solto → erro com a lista dos aceitos; format não texto → erro', () => {
  const r = formatDateTime('%Y-%Q', SP)
  assert.equal(r.ok, false)
  assert.equal(
    !r.ok && r.error,
    `código de formato desconhecido: %Q. Aceitos: ${DATETIME_CODES.join(' ')}`
  )
  const t = runDatetimeTool({ format: 'fim %' }, SP)
  assert.equal(t.status, 'error')
  assert.match(t.content, /^Erro: código de formato desconhecido: %\. Aceitos: %Y %m/)
  assert.equal(runDatetimeTool({ format: 5 }, SP).status, 'error')
  assert.match(
    runDatetimeTool({}, { now: NOW, timeZone: 'Marte/Olympus' }).content,
    /fuso inválido/
  )
  assert.deepEqual(runDatetimeTool({ format: '%Y' }, SP), { content: '2026', status: 'ok' })
  // a descrição da tool lista os mesmos códigos
  assert.ok(TOOL_DEFINITIONS.datetime.function.description.includes(DATETIME_CODES.join(' ')))
})

// ---------------- herança (unidades toolsCompact / toolsFull.<tool>) ----------------

const OR = { id: 'or', baseUrl: 'https://openrouter.ai/api/v1', kind: 'openrouter' as const }
const env: InheritEnv = {
  defaults: { defaultProviderId: 'or', defaultModel: 'base/model' },
  providers: [OR]
}
const persona = (cfg: PresetConfig): PresetConfig => sanitizePresetConfig(cfg)
const chatOf = (p: PresetConfig, extra: Partial<InheritConfig> = {}): InheritConfig =>
  newInheritingChatConfig({ cwd: '/w', presetId: 'p1', overrides: {}, ...extra }, p, env)

test('herança: toolsCompact é uma unidade; toolsFull.<tool> uma por tool (memória/skills/celular inclusive)', () => {
  assert.ok(PRESET_FIELDS.includes('toolsCompact') && PRESET_FIELDS.includes('toolsFull'))
  assert.equal(unitOfKey('toolsCompact'), 'toolsCompact')
  assert.equal(unitOfKey('toolsFull'), null, 'chave compartilhada')
  const units = unitsOfKey('toolsFull')
  assert.equal(units.length, COMPACTABLE_TOOL_NAMES.length)
  for (const u of [
    'toolsFull.read_file',
    'toolsFull.datetime',
    'toolsFull.memory_search',
    'toolsFull.skill_load',
    'toolsFull.get_location'
  ])
    assert.ok(units.includes(u), u)
  assert.ok(!units.includes('toolsFull.search_tool') && !units.includes('toolsFull.end_call'))
  // desconhecidas que vierem na lista também viram unidades (preservadas)
  assert.ok(unitsOfKey('toolsFull', { toolsFull: ['mcp_x' as never] }).includes('toolsFull.mcp_x'))
  const all = allUnits(DEFAULT_CHAT_CONFIG('/w'))
  assert.ok(all.includes('toolsCompact') && all.includes('toolsFull.shell'))
  assert.ok(isKnownUnit('toolsFull.shell') && isKnownUnit('toolsCompact'))
  assert.deepEqual(normalizeOverrides({ 'toolsFull.bash': true, toolsCompact: true }), {
    'toolsFull.shell': true,
    toolsCompact: true
  })
  // readUnit/writeUnit: lista ausente = undefined (= nenhuma); ordem do app; desconhecidas no fim
  const c: Partial<InheritConfig> = { toolsFull: ['mcp_x' as never] }
  assert.equal(readUnit({}, 'toolsFull.shell'), undefined)
  writeUnit(c, 'toolsFull.memory_read', true)
  writeUnit(c, 'toolsFull.shell', true)
  assert.deepEqual(c.toolsFull, ['shell', 'memory_read', 'mcp_x'])
  assert.equal(readUnit(c, 'toolsFull.shell'), true)
  writeUnit(c, 'toolsFull.shell', false)
  assert.deepEqual(c.toolsFull, ['memory_read', 'mcp_x'])
  // persona: os campos são de persona (sanitizados); toolsCompact só booleano
  assert.deepEqual(
    sanitizePresetConfig({ toolsCompact: false, toolsFull: ['bash', 'mcp_x'] } as never),
    {
      toolsCompact: false,
      toolsFull: ['shell', 'mcp_x']
    }
  )
  assert.deepEqual(sanitizePresetConfig({ toolsCompact: 'sim' } as never), {})
})

test('herança: persona sem os campos → padrão de "Novos chats" (true e []); com eles → os dela, ao vivo', () => {
  const pe = personaEffectiveConfig(persona({}), env)
  assert.equal(pe.toolsCompact, true)
  assert.deepEqual(pe.toolsFull, [])
  assert.equal(personaDefines(persona({}), 'toolsFull.shell'), false)
  const p = persona({ toolsCompact: false, toolsFull: ['shell'] })
  assert.equal(personaDefines(p, 'toolsCompact'), true)
  assert.equal(personaDefines(p, 'toolsFull.read_file'), true, 'a persona tem a lista')
  const chat = chatOf(persona({}))
  assert.deepEqual(chat.overrides, {})
  // a persona muda depois → o chat segue ao vivo
  const eff = effectiveChatConfig(chat, p, env)
  assert.equal(eff.toolsCompact, false)
  assert.deepEqual(eff.toolsFull, ['shell'])
})

test('herança: editar marca só a unidade tocada; voltar a herdar; migração (ausente = true / [])', () => {
  const p = persona({ toolsFull: ['memory_search'] })
  const chat = chatOf(p)
  const eff = effectiveChatConfig(chat, p, env)
  // marcar "vai completa" numa tool: só toolsFull.shell vira própria
  const patch = { toolsFull: withFullTool(eff.toolsFull, 'shell', true) }
  assert.deepEqual(touchedUnits(eff, patch), ['toolsFull.shell'])
  const edited = applyChatEdit(chat, patch, p, env)
  assert.deepEqual(edited.overrides, { 'toolsFull.shell': true })
  // a persona tira memory_search e põe read_file → o chat segue nessas e mantém shell própria
  const p2 = persona({ toolsFull: ['read_file'] })
  assert.deepEqual(effectiveChatConfig(edited, p2, env).toolsFull, ['read_file', 'shell'])
  // desligar a compactação no chat: unidade toolsCompact própria
  const off = applyChatEdit(edited, { toolsCompact: false }, p2, env)
  assert.equal(off.overrides!.toolsCompact, true)
  assert.equal(effectiveChatConfig(off, persona({ toolsCompact: true }), env).toolsCompact, false)
  const back = revertToInherit(off, ['toolsCompact', 'toolsFull.shell'], p2, env)
  assert.deepEqual(back.overrides, {})
  assert.equal(back.toolsCompact, true)
  assert.deepEqual(back.toolsFull, ['read_file'])
  // migração de um chat antigo (sem os campos): ausente = true / [] → nada vira próprio
  const old: InheritConfig = {
    ...DEFAULT_CHAT_CONFIG('/w', { providerId: 'or', model: 'base/model' }),
    presetId: 'p1'
  }
  delete old.toolsCompact
  delete old.toolsFull
  const ran = { computer: true, phone: false }
  const m = migrateChatOverrides(old, persona({}), env, ran)!
  assert.ok(
    !Object.keys(m.overrides!).some((u) => u === 'toolsCompact' || u.startsWith('toolsFull.'))
  )
  // a persona desliga a compactação → o chat antigo (ausente = ligada) difere: vira próprio
  const m2 = migrateChatOverrides(old, persona({ toolsCompact: false }), env, ran)!
  assert.equal(m2.overrides!.toolsCompact, true)
})

test('herança: merge 3-way por unidade (toolsFull compartilhada, toolsCompact)', () => {
  const base = { toolsCompact: true, toolsFull: [], overrides: {} }
  const local = { toolsCompact: true, toolsFull: ['shell'], overrides: { 'toolsFull.shell': true } }
  const server = { toolsCompact: false, toolsFull: [], overrides: { toolsCompact: true } }
  const m = mergeChatConfig3(server, base, local)
  assert.deepEqual(m.overrides, { toolsCompact: true, 'toolsFull.shell': true })
  assert.equal(m.toolsCompact, false, 'o valor próprio do servidor fica')
  assert.deepEqual(m.toolsFull, ['shell'])
})
