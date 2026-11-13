// Testes unitários da herança ao vivo da persona (protocolo 1.10.0, §4.3.6 — @shared/chatInherit):
// unidades (params/tools/aprovações por subchave), valor efetivo da persona com a cadeia Novos
// chats → persona → chat, regra do cache, provedor apagado → par padrão, edição/voltar a herdar,
// migração determinística, congelamento, troca de persona, patch do chat.update e o merge 3-way
// (overrides por subchave + a cópia que não sobrescreve valor próprio); tools de um tipo de aparelho
// (padrão com as do celular, preservação de tools desconhecidas, migração só no tipo em que rodou).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allUnits,
  applyChatConfigPatch,
  applyChatEdit,
  effectiveChatConfig,
  freezeChat,
  inheritedUnitValue,
  isKnownUnit,
  isOwn,
  mergeChatConfig3,
  migrateChatOverrides,
  newInheritingChatConfig,
  normalizeOverrides,
  ownUnits,
  personaEffectiveConfig,
  readUnit,
  revertToInherit,
  switchPersona,
  touchedUnits,
  unitOfKey,
  unitsOfKey,
  voiceFilledFromPersona,
  voiceInheritingPersona,
  writeUnit,
  type InheritConfig,
  type InheritEnv
} from '../src/shared/chatInherit.ts'
import { DEFAULT_CHAT_CONFIG, DEFAULT_SYSTEM_PROMPT } from '../src/shared/defaults.ts'
import { sanitizePresetConfig, type PresetConfig } from '../src/shared/presets.ts'
import { TOOL_NAMES } from '../src/shared/tools.ts'
import {
  APP_TOOL_NAMES,
  chatRanOn,
  COMPUTER_TOOL_NAMES,
  PHONE_TOOLS,
  runsOn,
  toolDevice,
  toolLabel,
  withTool,
  type ChatRanOn
} from '../src/shared/deviceTools.ts'
import { normalizeToolList } from '../src/shared/types.ts'
import { migrateConfigTools } from '../src/shared/toolRename.ts'
import { usesLocalTools } from '../src/shared/sync.ts'
import type { ChatConfig } from '../src/shared/types.ts'

const OR = { id: 'or', baseUrl: 'https://openrouter.ai/api/v1', kind: 'openrouter' as const }
const LO = { id: 'lo', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'openai' as const }
const env = (over: Partial<InheritEnv['defaults']> = {}): InheritEnv => ({
  defaults: { defaultProviderId: 'or', defaultModel: 'base/model', ...over },
  providers: [OR, LO]
})

const persona = (cfg: PresetConfig): PresetConfig => sanitizePresetConfig(cfg)

/** Chat que só rodou no computador (registro com hostCwd / local deste PC) e só no celular. */
const PC: ChatRanOn = { computer: true, phone: false }
const PHONE: ChatRanOn = { computer: false, phone: true }

/** Chat criado com a persona (≥ 1.10.0, nada mudado no formulário). */
function chatOf(p: PresetConfig, e = env(), extra: Partial<InheritConfig> = {}): InheritConfig {
  return newInheritingChatConfig({ cwd: '/w', presetId: 'p1', overrides: {}, ...extra }, p, e)
}

// ---------------- unidades ----------------

test('unidades: par do modelo, assinatura, params/tools/aprovações por subchave, voice fora', () => {
  assert.equal(unitOfKey('providerId'), 'model')
  assert.equal(unitOfKey('model'), 'model')
  assert.equal(unitOfKey('appSignatureCustom'), 'appSignature')
  assert.equal(unitOfKey('systemPrompt'), 'systemPrompt')
  assert.equal(unitOfKey('memory'), 'memory')
  assert.equal(unitOfKey('params'), null)
  assert.equal(unitOfKey('voice'), null)
  assert.equal(unitOfKey('cwd'), null)
  assert.equal(unitOfKey('presetId'), null)
  assert.equal(unitOfKey('capturedContext'), null)
  assert.deepEqual(unitsOfKey('params', { params: { temperature: 1 } }, { params: { seed: 2 } }), [
    'params.temperature',
    'params.seed'
  ])
  assert.equal(unitsOfKey('enabledTools').length, APP_TOOL_NAMES.length)
  assert.ok(unitsOfKey('approvalModes').includes('approvalModes.commands'))
  const units = allUnits(DEFAULT_CHAT_CONFIG('/w'))
  assert.ok(units.includes('model') && units.includes('appSignature'))
  assert.ok(!units.includes('providerId') && !units.includes('voice') && !units.includes('cwd'))
  assert.ok(isKnownUnit('params.extraBody') && isKnownUnit('enabledTools.shell'))
  assert.ok(!isKnownUnit('params') && !isKnownUnit('voice') && !isKnownUnit('futuro'))
})

test('readUnit/writeUnit: subchaves e tools na ordem do app', () => {
  const c = DEFAULT_CHAT_CONFIG('/w')
  writeUnit(c, 'enabledTools.shell', false)
  assert.equal(readUnit(c, 'enabledTools.shell'), false)
  writeUnit(c, 'enabledTools.shell', true)
  assert.deepEqual(c.enabledTools, APP_TOOL_NAMES)
  writeUnit(c, 'params.temperature', 0.3)
  writeUnit(c, 'approvalModes.commands', 'always')
  assert.equal(readUnit(c, 'params.temperature'), 0.3)
  writeUnit(c, 'params.temperature', undefined)
  assert.deepEqual(c.params, {})
  writeUnit(c, 'approvalModes.commands', undefined)
  assert.equal(c.approvalModes, undefined)
  writeUnit(c, 'model', { providerId: 'lo', model: 'x' })
  assert.deepEqual([c.providerId, c.model], ['lo', 'x'])
})

test('overrides: só true, alias de tool, desconhecidos preservados mas sem efeito', () => {
  assert.equal(normalizeOverrides(undefined), undefined)
  assert.deepEqual(normalizeOverrides({ systemPrompt: true, x: 1, 'enabledTools.bash': true }), {
    systemPrompt: true,
    'enabledTools.shell': true
  })
  assert.deepEqual(ownUnits({ overrides: { systemPrompt: true, futuro: true } } as never), [
    'systemPrompt'
  ])
})

// ---------------- valor efetivo ----------------

test('persona efetiva: o que ela define; o resto, "Novos chats" (modelo, system prompt) ao vivo', () => {
  const p = persona({ systemPrompt: 'Revisor.', params: { temperature: 0.2 } })
  const pe = personaEffectiveConfig(p, env())
  assert.equal(pe.systemPrompt, 'Revisor.')
  assert.deepEqual([pe.providerId, pe.model], ['or', 'base/model'])
  // tools padrão do app = todas, inclusive as do celular (§4.3.6)
  assert.deepEqual(pe.enabledTools, APP_TOOL_NAMES)
  const empty = personaEffectiveConfig({}, env({ defaultSystemPrompt: 'Padrão do usuário' }))
  assert.equal(empty.systemPrompt, 'Padrão do usuário')
  assert.equal(
    personaEffectiveConfig({}, env({ defaultSystemPrompt: null })).systemPrompt,
    DEFAULT_SYSTEM_PROMPT
  )
})

test('chat herda ao vivo: mudar a persona (ou o padrão) muda o chat sem regravá-lo', () => {
  const p = persona({ systemPrompt: 'v1', model: 'p/m', providerId: 'lo' })
  const rec = chatOf(p)
  assert.deepEqual(rec.overrides, {})
  const p2 = persona({ ...p, systemPrompt: 'v2' })
  assert.equal(effectiveChatConfig(rec, p2, env()).systemPrompt, 'v2')
  // a persona não define o prompt → segue "Novos chats"
  const p3 = persona({ model: 'p/m', providerId: 'lo' })
  assert.equal(
    effectiveChatConfig(rec, p3, env({ defaultSystemPrompt: 'novo padrão' })).systemPrompt,
    'novo padrão'
  )
  // a cópia do registro não mudou
  assert.equal(rec.systemPrompt, 'v1')
})

test('persona inexistente aqui ou chat sem overrides → a config como está', () => {
  const p = persona({ systemPrompt: 'v1' })
  const rec = chatOf(p)
  assert.equal(effectiveChatConfig(rec, null, env()), rec)
  const legacy = { ...DEFAULT_CHAT_CONFIG('/w'), presetId: 'p1', systemPrompt: 'velho' }
  assert.equal(effectiveChatConfig(legacy, p, env()).systemPrompt, 'velho')
})

test('cacheEnabled: persona sem o campo → segue o provedor EFETIVO do chat', () => {
  const p = persona({ model: 'a/b', providerId: 'or' })
  const rec = chatOf(p)
  assert.equal(effectiveChatConfig(rec, p, env()).cacheEnabled, true)
  // o chat troca o modelo para um provedor openai → o cache herdado desliga
  const own = applyChatEdit(rec, { providerId: 'lo', model: 'local/x' }, p, env())
  assert.deepEqual(ownUnits(own), ['model'])
  assert.equal(effectiveChatConfig(own, p, env()).cacheEnabled, false)
  // a persona define o cache → vale o dela
  const p2 = persona({ model: 'a/b', providerId: 'or', cacheEnabled: false })
  assert.equal(effectiveChatConfig(rec, p2, env()).cacheEnabled, false)
})

test('provedor da persona apagado → o par padrão (o chat herdado segue)', () => {
  const p = persona({ model: 'gone/m', providerId: 'gone' })
  const rec = chatOf(p)
  const eff = effectiveChatConfig(rec, p, env())
  assert.deepEqual([eff.providerId, eff.model], ['or', 'base/model'])
})

test('granularidade: params/tools/aprovações herdam por subchave', () => {
  const p = persona({
    params: { temperature: 0.2, top_p: 0.9 },
    enabledTools: ['read_file', 'shell'],
    approvalModes: { commands: 'always' }
  })
  let rec = chatOf(p)
  let eff = effectiveChatConfig(rec, p, env())
  // liga o seed e desliga o shell no chat: só essas subunidades viram próprias
  rec = applyChatEdit(
    rec,
    { params: { ...eff.params, seed: 7 }, enabledTools: ['read_file'] },
    p,
    env()
  )
  assert.deepEqual(ownUnits(rec).sort(), ['enabledTools.shell', 'params.seed'])
  // a persona muda a temperatura e liga o list_dir: o chat acompanha; o seed e o shell ficam
  const p2 = persona({
    params: { temperature: 0.5, top_p: 0.9 },
    enabledTools: ['read_file', 'shell', 'list_dir'],
    approvalModes: { commands: 'smart', pages: 'always' }
  })
  eff = effectiveChatConfig(rec, p2, env())
  assert.deepEqual(eff.params, { temperature: 0.5, top_p: 0.9, seed: 7 })
  assert.deepEqual(eff.enabledTools, ['list_dir', 'read_file'])
  assert.deepEqual(eff.approvalModes, { commands: 'smart', pages: 'always' })
})

test('unidade própria AUSENTE vale como ausente (memória desligada)', () => {
  const p = persona({ memory: { enabled: true } as never })
  let rec = chatOf(p)
  assert.equal(effectiveChatConfig(rec, p, env()).memory?.enabled, true)
  rec = applyChatConfigPatch(
    rec,
    { overrides: { memory: true } },
    { env: env(), persona: () => p, ranOn: PC }
  )
  // virou própria guardando o valor que tinha (o efetivo)…
  assert.equal(effectiveChatConfig(rec, p, env()).memory?.enabled, true)
  // …e depois de removida no chat, fica ausente (= desligada) mesmo com a persona ligada
  const off = { ...rec }
  delete off.memory
  assert.equal(effectiveChatConfig(off, p, env()).memory, undefined)
})

// ---------------- edição / voltar a herdar ----------------

test('touchedUnits: chave simples enviada = tocada; compartilhada só o que mudou', () => {
  const c = DEFAULT_CHAT_CONFIG('/w')
  c.params = { temperature: 1, top_p: 1 }
  assert.deepEqual(touchedUnits(c, { systemPrompt: c.systemPrompt }), ['systemPrompt'])
  assert.deepEqual(touchedUnits(c, { params: { temperature: 1, top_p: null } as never }), [
    'params.top_p'
  ])
  assert.deepEqual(touchedUnits(c, { providerId: 'x', model: 'y' }), ['model'])
  assert.deepEqual(touchedUnits(c, { appSignatureCustom: { referer: 'a', title: 'b' } }), [
    'appSignature'
  ])
  assert.deepEqual(touchedUnits(c, { cwd: '/x', voice: null as never }), [])
})

test('voltar a herdar: a unidade sai de overrides e a cópia recebe o valor da persona', () => {
  const p = persona({ systemPrompt: 'persona' })
  let rec = applyChatEdit(chatOf(p), { systemPrompt: 'meu' }, p, env())
  assert.ok(isOwn(rec, 'systemPrompt'))
  assert.equal(inheritedUnitValue(rec, 'systemPrompt', p, env()), 'persona')
  const p2 = persona({ systemPrompt: 'persona 2' })
  rec = revertToInherit(rec, ['systemPrompt'], p2, env())
  assert.deepEqual(rec.overrides, {})
  assert.equal(rec.systemPrompt, 'persona 2')
})

test('edição em chat sem overrides (sem persona / antigo) = patch comum, sem marcar', () => {
  const rec = DEFAULT_CHAT_CONFIG('/w') as InheritConfig
  const next = applyChatEdit(rec, { systemPrompt: 'x' }, null, env())
  assert.equal(next.systemPrompt, 'x')
  assert.equal(next.overrides, undefined)
})

// ---------------- criação ----------------

test('Novo chat: overrides enviados = o que o usuário mudou; config completa (cópia)', () => {
  const p = persona({ systemPrompt: 'P', model: 'p/m', providerId: 'lo' })
  const rec = newInheritingChatConfig(
    {
      cwd: '/w',
      presetId: 'p1',
      overrides: { model: true },
      providerId: 'or',
      model: 'o/x',
      systemPrompt: 'ignorado'
    },
    p,
    env()
  )
  assert.deepEqual(rec.overrides, { model: true })
  assert.deepEqual([rec.providerId, rec.model, rec.systemPrompt], ['or', 'o/x', 'P'])
  assert.deepEqual(rec.enabledTools, APP_TOOL_NAMES)
  assert.equal(rec.cwd, '/w')
})

test('Novo chat sem overrides (API antiga/testes): calculados pela diferença', () => {
  const p = persona({ systemPrompt: 'P' })
  const rec = newInheritingChatConfig(
    { cwd: '/w', presetId: 'p1', systemPrompt: 'P', enabledTools: [] },
    p,
    env()
  )
  assert.deepEqual(Object.keys(rec.overrides!).length, APP_TOOL_NAMES.length)
  assert.ok(!isOwn(rec, 'systemPrompt'))
})

// ---------------- migração ----------------

test('migração: iguais herdam, diferentes ficam próprios; determinística', () => {
  const p = persona({
    systemPrompt: 'P',
    params: { temperature: 0.2 },
    model: 'p/m',
    providerId: 'or'
  })
  const pe = personaEffectiveConfig(p, env())
  const legacy: InheritConfig = {
    ...pe,
    cwd: '/w',
    presetId: 'p1',
    systemPrompt: 'mudado no chat',
    params: { temperature: 0.2, seed: 3 },
    enabledTools: TOOL_NAMES.filter((t) => t !== 'shell')
  }
  const a = migrateChatOverrides(legacy, p, env(), PC)!
  const b = migrateChatOverrides(JSON.parse(JSON.stringify(legacy)), p, env(), PC)!
  assert.deepEqual(a, b)
  // o chat antigo não tinha as tools do celular: a diferença não vira própria (rodou no PC)
  assert.deepEqual(Object.keys(a.overrides!).sort(), [
    'enabledTools.shell',
    'params.seed',
    'systemPrompt'
  ])
  // já migrado / sem persona / persona inexistente → nada
  assert.equal(migrateChatOverrides(a, p, env(), PC), null)
  assert.equal(migrateChatOverrides({ ...legacy, presetId: undefined }, p, env(), PC), null)
  assert.equal(migrateChatOverrides(legacy, null, env(), PC), null)
})

test('migração: cache igual ao herdado do provedor do chat; voz igual à da persona → null', () => {
  const p = persona({
    model: 'p/m',
    providerId: 'or',
    voice: { enabled: true, voicePrompt: 'Fale curto.', model: null, tools: null, fillers: null }
  })
  const pe = personaEffectiveConfig(p, env())
  const legacy: InheritConfig = {
    ...pe,
    cwd: '/w',
    presetId: 'p1',
    providerId: 'lo',
    model: 'l/m',
    cacheEnabled: false,
    voice: { enabled: true, voicePrompt: 'Outro', model: null, tools: null, fillers: null }
  }
  const m = migrateChatOverrides(legacy, p, env(), PC)!
  // o par é próprio; o cache false é o herdado do provedor openai do chat → herda
  assert.deepEqual(Object.keys(m.overrides!), ['model'])
  assert.equal(m.voice?.enabled, null)
  assert.equal(m.voice?.voicePrompt, 'Outro')
})

// ---------------- congelar / trocar ----------------

test('congelar: grava o efetivo, preenche a voz, remove presetId e mantém overrides', () => {
  const p = persona({
    systemPrompt: 'P',
    voice: { enabled: true, voicePrompt: 'V', model: null, tools: null, fillers: null }
  })
  let rec = applyChatEdit(chatOf(p), { autoCompact: true }, p, env())
  const p2 = persona({ ...p, systemPrompt: 'P2' })
  rec = freezeChat(rec, p2, env())
  assert.equal(rec.presetId, undefined)
  assert.equal(rec.systemPrompt, 'P2')
  assert.equal(rec.autoCompact, true)
  assert.deepEqual(rec.overrides, { autoCompact: true })
  assert.equal(rec.voice?.voicePrompt, 'V')
  // sem persona: valores próprios (overrides sem efeito)
  assert.equal(effectiveChatConfig(rec, p, env()).systemPrompt, 'P2')
})

test('trocar de persona: mantém as próprias, as herdadas seguem a nova', () => {
  const a = persona({ systemPrompt: 'A', autoCompact: false })
  const b = persona({ systemPrompt: 'B', autoCompact: true, contextWindow: 9000 })
  let rec = applyChatEdit(chatOf(a), { autoCompact: true }, a, env())
  rec = switchPersona(rec, 'p2', b, env())
  assert.equal(rec.presetId, 'p2')
  assert.deepEqual(rec.overrides, { autoCompact: true })
  assert.equal(rec.systemPrompt, 'B')
  assert.equal(rec.contextWindow, 9000)
  // chat sem persona que ganha uma: overrides (se houver) ficam; o resto herda
  const free = { ...DEFAULT_CHAT_CONFIG('/w'), systemPrompt: 'livre' } as InheritConfig
  const got = switchPersona(free, 'p2', b, env())
  assert.deepEqual(got.overrides, {})
  assert.equal(got.systemPrompt, 'B')
})

test('voz: herdar (migração) e preencher (congelamento)', () => {
  const pv = { enabled: true, voicePrompt: 'V', model: null, tools: null, fillers: null }
  assert.equal(voiceInheritingPersona({ ...pv, voicePrompt: 'V' }, pv).voicePrompt, null)
  assert.equal(
    voiceFilledFromPersona({ ...pv, enabled: null, voicePrompt: null }, pv).voicePrompt,
    'V'
  )
})

// ---------------- patch (tela local / chat.update §23.7) ----------------

test('patch: sem overrides = edição; com overrides = como enviado (voltar a herdar remoto)', () => {
  const p = persona({ systemPrompt: 'P' })
  const ctx = { env: env(), persona: (id: string) => (id === 'p1' ? p : null), ranOn: PC }
  let rec = applyChatConfigPatch(chatOf(p), { systemPrompt: 'meu' }, ctx)
  assert.deepEqual(rec.overrides, { systemPrompt: true })
  rec = applyChatConfigPatch(rec, { overrides: {} }, ctx)
  assert.deepEqual(rec.overrides, {})
  assert.equal(rec.systemPrompt, 'P')
  // com overrides + valor: o valor é gravado e a unidade é própria
  rec = applyChatConfigPatch(rec, { overrides: { systemPrompt: true }, systemPrompt: 'X' }, ctx)
  assert.equal(effectiveChatConfig(rec, p, env()).systemPrompt, 'X')
})

test('patch: presetId null = congelar; outro id = trocar (migra o antigo antes)', () => {
  const a = persona({ systemPrompt: 'A' })
  const b = persona({ systemPrompt: 'B' })
  const ctx = {
    env: env(),
    persona: (id: string) => (id === 'pa' ? a : id === 'pb' ? b : null),
    ranOn: PC
  }
  const legacy: InheritConfig = {
    ...personaEffectiveConfig(a, env()),
    cwd: '/w',
    presetId: 'pa',
    autoCompact: true
  }
  const sw = applyChatConfigPatch(legacy, { presetId: 'pb' }, ctx)
  assert.equal(sw.presetId, 'pb')
  assert.deepEqual(sw.overrides, { autoCompact: true })
  assert.equal(sw.systemPrompt, 'B')
  const fz = applyChatConfigPatch(sw, { presetId: null }, ctx)
  assert.equal(fz.presetId, undefined)
  assert.equal(fz.systemPrompt, 'B')
})

// ---------------- merge 3-way ----------------

test('merge: overrides mesclado por unidade (marcas dos dois lados ficam)', () => {
  const base = { systemPrompt: 'P', autoCompact: false, overrides: {} }
  const server = { systemPrompt: 'S', autoCompact: false, overrides: { systemPrompt: true } }
  const local = { systemPrompt: 'P', autoCompact: true, overrides: { autoCompact: true } }
  const m = mergeChatConfig3(server, base, local)
  assert.deepEqual(m.overrides, { systemPrompt: true, autoCompact: true })
  assert.equal(m.systemPrompt, 'S')
  assert.equal(m.autoCompact, true)
})

test('merge: a cópia de uma unidade herdada aqui não sobrescreve o valor próprio do servidor', () => {
  // local trocou de persona (cópia nova do prompt, herdado); outro dispositivo sobrescreveu o prompt
  const base = { systemPrompt: 'A', presetId: 'pa', overrides: {}, params: { temperature: 1 } }
  const local = { systemPrompt: 'B', presetId: 'pb', overrides: {}, params: { temperature: 0.5 } }
  const server = {
    systemPrompt: 'meu',
    presetId: 'pa',
    overrides: { systemPrompt: true, 'params.temperature': true },
    params: { temperature: 0.9 }
  }
  const m = mergeChatConfig3(server, base, local)
  assert.equal(m.presetId, 'pb')
  assert.equal(m.systemPrompt, 'meu')
  assert.deepEqual(m.params, { temperature: 0.9 })
  // voltar a herdar aqui (a marca sai) vence: a cópia vai junto
  const base2 = { systemPrompt: 'meu', overrides: { systemPrompt: true } }
  const local2 = { systemPrompt: 'P', overrides: {} }
  const server2 = { systemPrompt: 'meu 2', overrides: { systemPrompt: true } }
  const m2 = mergeChatConfig3(server2, base2, local2)
  assert.deepEqual(m2.overrides, {})
  assert.equal(m2.systemPrompt, 'P')
})

test('merge: config sem overrides (persona, app antigo) = LWW por chave como antes', () => {
  const m = mergeChatConfig3({ a: 1, b: 1 }, { a: 0, b: 0 }, { a: 0, b: 2 })
  assert.deepEqual(m, { a: 1, b: 2 })
  assert.equal('overrides' in m, false)
})

// ---------------- regras derivadas ----------------

test('usesLocalTools usa a config efetiva (tools herdadas da persona)', () => {
  const p = persona({ enabledTools: ['web_search'] })
  const rec = chatOf(p)
  assert.equal(usesLocalTools(effectiveChatConfig(rec, p, env())), false)
  const p2 = persona({ enabledTools: ['shell'] })
  assert.equal(usesLocalTools(effectiveChatConfig(rec, p2, env())), true)
})

test('config efetiva é completa (os campos obrigatórios de ChatConfig existem)', () => {
  const rec = chatOf(persona({}))
  const eff: ChatConfig = effectiveChatConfig(rec, persona({}), env())
  for (const k of ['providerId', 'model', 'systemPrompt', 'params', 'enabledTools', 'cwd'] as const)
    assert.notEqual(eff[k], undefined, k)
})

// ---------------- tools de um tipo de aparelho (§4.3.6) ----------------

test('aparelho: grupos, padrão do app com as do celular, rótulos', () => {
  assert.deepEqual(PHONE_TOOLS, ['get_location', 'nearby_places'])
  assert.equal(COMPUTER_TOOL_NAMES.length, 12)
  assert.ok(COMPUTER_TOOL_NAMES.includes('present_file'))
  assert.equal(toolDevice('shell'), 'computer')
  assert.equal(toolDevice('bash'), 'computer')
  assert.equal(toolDevice('get_location'), 'phone')
  assert.equal(toolDevice('web_search'), null)
  assert.equal(toolDevice('futura'), null)
  assert.ok(runsOn('web_search', 'phone') && runsOn('web_search', 'computer'))
  assert.ok(!runsOn('nearby_places', 'computer') && runsOn('nearby_places', 'phone'))
  assert.ok(!runsOn('read_file', 'phone'))
  // padrão de "Novos chats" (sem persona e persona sem tools) = todas, inclusive as do celular
  assert.deepEqual(DEFAULT_CHAT_CONFIG('/w').enabledTools, [...TOOL_NAMES, ...PHONE_TOOLS])
  assert.equal(toolLabel('get_location'), 'Localização')
  assert.equal(toolLabel('shell'), 'Terminal (shell)')
  assert.equal(toolLabel('mcp_x'), 'mcp_x')
})

test('aparelho: ligar/desligar preserva as do celular e as desconhecidas (ordem do app)', () => {
  const list = ['web_search', 'futura', 'get_location', 'shell'] as never as string[]
  const on = withTool(list, 'read_file', true)
  assert.deepEqual(on, ['read_file', 'shell', 'web_search', 'get_location', 'futura'])
  const off = withTool(on, 'shell', false)
  assert.deepEqual(off, ['read_file', 'web_search', 'get_location', 'futura'])
  assert.deepEqual(withTool(off, 'nearby_places', true), [
    'read_file',
    'web_search',
    'get_location',
    'nearby_places',
    'futura'
  ])
  // writeUnit (edição/voltar a herdar) idem
  const c: Partial<ChatConfig> = { enabledTools: list as never }
  writeUnit(c, 'enabledTools.list_dir', true)
  assert.deepEqual(c.enabledTools, ['list_dir', 'shell', 'web_search', 'get_location', 'futura'])
})

test('aparelho: listas com tools desconhecidas/do celular sobrevivem a normalizar e regravar', () => {
  const tools = [
    'bash',
    'get_location',
    'nearby_places',
    'mcp_futura'
  ] as never as ChatConfig['enabledTools']
  assert.deepEqual(normalizeToolList(tools), [
    'shell',
    'get_location',
    'nearby_places',
    'mcp_futura'
  ])
  assert.ok(
    migrateConfigTools({ enabledTools: tools }).enabledTools!.includes('get_location' as never)
  )
  // persona: sanitizar (ao salvar/ler) mantém a lista e a voz
  const p = sanitizePresetConfig({
    enabledTools: ['web_search', 'get_location', 'mcp_futura'],
    voice: { tools: { enabledTools: ['nearby_places', 'mcp_futura'], maxToolOutputChars: null } }
  } as never)
  assert.deepEqual(p.enabledTools, ['web_search', 'get_location', 'mcp_futura'])
  assert.deepEqual(p.voice?.tools?.enabledTools, ['nearby_places', 'mcp_futura'])
  // chat que herda a lista: editar outra tool vira própria só ela; as outras seguem a persona
  const rec = chatOf(p)
  assert.deepEqual(rec.enabledTools, ['web_search', 'get_location', 'mcp_futura'])
  const ed = applyChatEdit(
    rec,
    { enabledTools: withTool(rec.enabledTools, 'shell', true) },
    p,
    env()
  )
  assert.deepEqual(ed.overrides, { 'enabledTools.shell': true })
  assert.deepEqual(ed.enabledTools, ['shell', 'web_search', 'get_location', 'mcp_futura'])
  const eff = effectiveChatConfig(ed, p, env())
  assert.deepEqual(eff.enabledTools, ['shell', 'web_search', 'get_location', 'mcp_futura'])
  // marca própria numa tool do celular / desconhecida: preservada nos overrides (edição, voltar a
  // herdar outra unidade, merge)
  const own = applyChatEdit(
    ed,
    { enabledTools: withTool(eff.enabledTools, 'get_location', false) },
    p,
    env()
  )
  assert.deepEqual(Object.keys(own.overrides!).sort(), [
    'enabledTools.get_location',
    'enabledTools.shell'
  ])
  assert.equal(
    effectiveChatConfig(own, p, env()).enabledTools.includes('get_location' as never),
    false
  )
  const withUnknown = {
    ...own,
    overrides: { ...own.overrides, 'enabledTools.mcp_futura': true as const }
  }
  const rv = revertToInherit(withUnknown, ['enabledTools.shell'], p, env())
  assert.deepEqual(Object.keys(rv.overrides!).sort(), [
    'enabledTools.get_location',
    'enabledTools.mcp_futura'
  ])
  assert.ok(rv.enabledTools.includes('mcp_futura' as never))
  const merged = mergeChatConfig3(
    rv as never,
    rv as never,
    { ...rv, systemPrompt: 'x' } as never
  ) as unknown as InheritConfig
  assert.deepEqual(merged.overrides, rv.overrides)
  assert.deepEqual(merged.enabledTools, rv.enabledTools)
})

test('aparelho: chatRanOn — hostCwd = rodou num computador; sem hostCwd = no celular; local = PC', () => {
  assert.deepEqual(chatRanOn({ deviceId: 'd', path: '/p' }), PC)
  assert.deepEqual(chatRanOn(null), PHONE)
  assert.deepEqual(chatRanOn(undefined), PHONE)
  assert.deepEqual(chatRanOn(null, true), PC)
})

test('migração: tool do computador diferente só vira própria se o chat rodou num computador', () => {
  const p = persona({ systemPrompt: 'P' }) // sem tools: herda o padrão do app (todas)
  const pe = personaEffectiveConfig(p, env())
  // chat antigo do desktop: sem as do celular (o app antigo não as conhecia) e o shell desligado
  const pcLegacy: InheritConfig = {
    ...pe,
    cwd: '/w',
    presetId: 'p1',
    enabledTools: TOOL_NAMES.filter((t) => t !== 'shell')
  }
  const m = migrateChatOverrides(pcLegacy, p, env(), PC)!
  // o "shell desligado" deliberado fica; as do celular passam a herdar (o PC nunca as roda)
  assert.deepEqual(m.overrides, { 'enabledTools.shell': true })
  const eff = effectiveChatConfig(m, p, env())
  assert.ok(!eff.enabledTools.includes('shell'))
  assert.ok(eff.enabledTools.includes('get_location' as never))
  // o mesmo registro sem hostCwd (nunca rodou num computador): o shell também herda
  const ph = migrateChatOverrides(pcLegacy, p, env(), PHONE)!
  assert.deepEqual(ph.overrides, {
    'enabledTools.get_location': true,
    'enabledTools.nearby_places': true
  })
})

test('migração: chat criado no celular (sem as do computador) herda-as; as do celular contam', () => {
  const p = persona({ systemPrompt: 'P' })
  const pe = personaEffectiveConfig(p, env())
  const phoneTools = APP_TOOL_NAMES.filter((t) => runsOn(t, 'phone') && t !== 'nearby_places')
  const phoneLegacy: InheritConfig = {
    ...pe,
    cwd: '',
    presetId: 'p1',
    enabledTools: [...phoneTools, 'mcp_futura' as never]
  }
  const m = migrateChatOverrides(phoneLegacy, p, env(), PHONE)!
  // computador: nada próprio; nearby_places desligada no celular: própria; a desconhecida difere
  assert.deepEqual(Object.keys(m.overrides!).sort(), [
    'enabledTools.mcp_futura',
    'enabledTools.nearby_places'
  ])
  const eff = effectiveChatConfig(m, p, env())
  assert.ok(eff.enabledTools.includes('shell'), 'herda as do computador (roda sem elas no celular)')
  assert.ok(!eff.enabledTools.includes('nearby_places' as never))
  assert.ok(eff.enabledTools.includes('mcp_futura' as never), 'desconhecida preservada')
  // o mesmo chat rodando num computador: as do computador desligadas viram próprias
  const pc = migrateChatOverrides(phoneLegacy, p, env(), PC)!
  assert.ok(isOwn(pc, 'enabledTools.shell') && !isOwn(pc, 'enabledTools.nearby_places'))
  // tools sem tipo de aparelho: diferença vira própria em qualquer caso
  const noWeb = {
    ...phoneLegacy,
    enabledTools: phoneLegacy.enabledTools.filter((t) => t !== 'web_search')
  }
  assert.ok(isOwn(migrateChatOverrides(noWeb, p, env(), PHONE)!, 'enabledTools.web_search'))
  assert.ok(isOwn(migrateChatOverrides(noWeb, p, env(), PC)!, 'enabledTools.web_search'))
})

test('patch: trocar a persona de um chat não migrado usa o tipo de aparelho em que ele rodou', () => {
  const a = persona({ systemPrompt: 'A' })
  const b = persona({ systemPrompt: 'B' })
  const legacy: InheritConfig = {
    ...personaEffectiveConfig(a, env()),
    cwd: '',
    presetId: 'pa',
    enabledTools: APP_TOOL_NAMES.filter((t) => runsOn(t, 'phone'))
  }
  const persona_ = (id: string): PresetConfig | null => (id === 'pa' ? a : id === 'pb' ? b : null)
  const sw = applyChatConfigPatch(
    legacy,
    { presetId: 'pb' },
    { env: env(), persona: persona_, ranOn: PHONE }
  )
  assert.deepEqual(sw.overrides, {})
  assert.ok(sw.enabledTools.includes('shell'), 'segue a nova persona (todas)')
})
