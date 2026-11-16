// Lógica PURA da barra lateral de Configurações (`src/renderer/src/lib/settingsNav.ts`): grupos/ordem,
// rótulos (= nomes acessíveis usados pelos testes e2e) e a busca "Procurar" (rótulo + palavras-chave,
// sem acento/caixa, termos em qualquer ordem; o melhor resultado é o que o Enter abre).
// Sem DOM, sem Electron. Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterSettingsNav,
  normalizeSearch,
  SETTINGS_NAV,
  SETTINGS_NAV_ITEMS,
  settingsNavItem
} from '../src/renderer/src/lib/settingsNav.ts'

const ids = (q: string): string[] =>
  filterSettingsNav(q).groups.flatMap((g) => g.matches.map((m) => m.item.id))

test('grupos, ordem e rótulos (todas as abas, uma vez cada)', () => {
  assert.deepEqual(
    SETTINGS_NAV.map((g) => [g.label, g.items.map((i) => i.label)]),
    [
      ['Geral', ['Novos chats', 'Personas', 'Áudio']],
      [
        'Agente',
        ['Aprovações', 'Memórias', 'Skills', 'Conectores', 'Pesquisa na web', 'Tempo e mapas']
      ],
      ['Conexões', ['Provedores', 'Conta']]
    ]
  )
  const all = SETTINGS_NAV_ITEMS.map((i) => i.id).sort()
  assert.deepEqual(all, [
    'account',
    'approvals',
    'audio',
    'defaults',
    'maps',
    'mcp',
    'memory',
    'presets',
    'providers',
    'skills',
    'web'
  ])
  assert.equal(settingsNavItem('audio').label, 'Áudio')
  // título da página quando difere do rótulo
  assert.equal(settingsNavItem('mcp').title, 'Conectores · Servidores MCP')
  for (const i of SETTINGS_NAV_ITEMS) assert(i.keywords.length >= 5, `${i.id} sem palavras-chave`)
})

test('busca vazia: tudo, sem "melhor"', () => {
  const r = filterSettingsNav('   ')
  assert.equal(r.total, 11)
  assert.equal(r.best, null)
  assert.equal(r.groups.length, 3)
})

test('normaliza acento, caixa e espaços', () => {
  assert.equal(normalizeSearch('  ÁUDIO   Transcrição '), 'audio transcricao')
  assert.deepEqual(ids('audio'), ['audio'])
  assert.deepEqual(ids('APROVACOES'), ['approvals'])
})

test('palavras-chave levam à aba e aparecem como dica', () => {
  const r = filterSettingsNav('microfone')
  assert.deepEqual(ids('microfone'), ['audio'])
  assert.equal(r.groups[0].matches[0].keyword, 'microfone')
  assert.equal(r.best?.id, 'audio')
  assert.deepEqual(ids('whitelist'), ['approvals'])
  assert.equal(filterSettingsNav('juiz').best?.id, 'approvals')
  assert.equal(filterSettingsNav('tavily').best?.id, 'web')
  assert.equal(filterSettingsNav('previsão do tempo').best?.id, 'maps')
  assert.equal(filterSettingsNav('open-meteo').best?.id, 'maps')
  assert.equal(filterSettingsNav('sincronização').best?.id, 'account')
  assert.equal(filterSettingsNav('título automático').best?.id, 'defaults')
  // conectores (MCP)
  assert.deepEqual(ids('mcp'), ['mcp'])
  assert.deepEqual(ids('oauth'), ['mcp'])
  assert.equal(filterSettingsNav('stdio').best?.id, 'mcp')
  assert.equal(filterSettingsNav('conector').best?.id, 'mcp')
})

test('grupos sem resultado somem; nada → total 0', () => {
  const r = filterSettingsNav('gpu')
  assert.deepEqual(
    r.groups.map((g) => g.group.id),
    ['general']
  )
  const none = filterSettingsNav('xyzzy')
  assert.equal(none.total, 0)
  assert.equal(none.best, null)
  assert.deepEqual(none.groups, [])
})

test('melhor resultado: rótulo > palavra-chave igual > prefixo; empate → ordem da barra', () => {
  // "memória" casa com o rótulo Memórias e com palavras-chave de Aprovações
  assert.equal(filterSettingsNav('memoria').best?.id, 'memory')
  // "voz": Áudio tem a palavra exata; Personas só "voz da persona"
  assert(ids('voz').includes('presets'))
  assert.equal(filterSettingsNav('voz').best?.id, 'audio')
  // ElevenLabs aparece em Áudio e Provedores (empate → Áudio, que vem antes)
  assert.deepEqual(ids('elevenlabs'), ['audio', 'providers'])
  assert.equal(filterSettingsNav('elevenlabs').best?.id, 'audio')
  // prefixo do rótulo
  assert.equal(filterSettingsNav('pro').best?.id, 'providers')
})

test('vários termos em qualquer ordem (todos precisam casar)', () => {
  assert.deepEqual(ids('chave recuperação'), ['account'])
  assert.deepEqual(ids('recuperação chave'), ['account'])
  assert.deepEqual(ids('web pesquisa'), ['web'])
  assert.deepEqual(ids('microfone tavily'), [])
})
