// Menções `@caminho` (@shared/pathMentions): tokens no texto (sem aspas, entre aspas com espaço,
// pontuação final, e-mails, código cercado/inline), "completo" (seguido de espaço) para o destaque
// do composer, o token em digitação no cursor, a inserção de pasta (popup continua) / arquivo
// (espaço depois; aspas quando preciso) e o filtro do índice (filhos diretos com `/`, busca na
// raiz inteira sem `/`: prefixo > contém > caminho > fuzzy).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeMentionQuery,
  applyMention,
  codeRanges,
  filterMentionIndex,
  findPathMentions,
  formatPathMention,
  isPathLike,
  needsQuotes,
  splitPathMentions
} from '../src/shared/pathMentions.ts'

const paths = (text: string, opts?: Parameters<typeof findPathMentions>[1]): string[] =>
  findPathMentions(text, opts).map((m) => m.path)

test('tokens: sem aspas, com aspas (espaço), pontuação final, começo/abertura antes do @', () => {
  assert.deepEqual(paths('veja @src/app.ts e @README.md.'), ['src/app.ts', 'README.md'])
  assert.deepEqual(paths('@"docs/meu arquivo.md" agora'), ['docs/meu arquivo.md'])
  assert.deepEqual(paths('(@src/a.ts), [@b/c.py]; {@d/}'), ['src/a.ts', 'b/c.py', 'd/'])
  assert.deepEqual(paths('linha1\n@x/y.txt?'), ['x/y.txt'])
  // e-mail / @ no meio da palavra / @ sozinho / aspas vazias ou sem fechar
  assert.deepEqual(paths('mande para ana@exemplo.com @ nada @"" @"aberto sem fim'), [])
  // aspas sem fechar terminam na linha (não atravessam)
  assert.deepEqual(paths('@"a b\nc" @ok.ts'), ['ok.ts'])
})

test('tokens: só os que parecem caminho (ou reconhecidos pelo índice)', () => {
  assert.deepEqual(paths('@Override @everyone @src @a.b @.env @x/'), ['a.b', '.env', 'x/'])
  assert.deepEqual(paths('@Makefile e @src', { known: (p) => p === 'Makefile' }), ['Makefile'])
  assert.deepEqual(paths('@Makefile', { pathLike: false }), ['Makefile'])
  assert.ok(isPathLike('a/b') && isPathLike('C:\\x') && isPathLike('.gitignore'))
  assert.ok(!isPathLike('nome') && !isPathLike('fim.'))
})

test('tokens: nada dentro de código (cercas ``` / ~~~ e crases)', () => {
  const text = [
    'antes @a.ts',
    '```ts',
    'import x from "@b.ts"; @c/d.ts',
    '```',
    'meio `@e.ts` e ``x @f.ts y`` @g.ts',
    '~~~',
    '@h.ts',
    '~~~',
    'fim @i.ts'
  ].join('\n')
  assert.deepEqual(paths(text), ['a.ts', 'g.ts', 'i.ts'])
  // cerca aberta até o fim
  assert.deepEqual(paths('ok @a.ts\n```\n@b.ts'), ['a.ts'])
  const r = codeRanges('x `y` z')
  assert.deepEqual(r, [[2, 5]])
})

test('completo (destaque no composer): seguido de espaço/quebra; aspas fechadas', () => {
  const ms = findPathMentions('@a.ts @b.ts\n@"c d.md" @e.ts')
  assert.deepEqual(
    ms.map((m) => [m.path, m.complete]),
    [
      ['a.ts', true],
      ['b.ts', true],
      ['c d.md', true],
      ['e.ts', false]
    ]
  )
  // pontuação final fica fora do token
  const [m] = findPathMentions('@x/y.ts, depois')
  assert.equal('@x/y.ts, depois'.slice(m.start, m.end), '@x/y.ts')
  assert.equal(m.complete, true, 'pontuação + espaço depois também completa')
  assert.equal(findPathMentions('@x/y.ts,')[0].complete, false)
})

test('splitPathMentions', () => {
  const t = 'a @b.ts c'
  assert.deepEqual(
    splitPathMentions(t, findPathMentions(t)).map((p) => [p.text, 'mention' in p]),
    [
      ['a ', false],
      ['@b.ts', true],
      [' c', false]
    ]
  )
})

test('formatPathMention / needsQuotes', () => {
  assert.equal(formatPathMention('src/a.ts'), '@src/a.ts')
  assert.equal(formatPathMention('docs/com espaço.md'), '@"docs/com espaço.md"')
  assert.equal(formatPathMention('termina.'), '@"termina."')
  assert.equal(formatPathMention('a"b'), null)
  assert.ok(needsQuotes('a b') && needsQuotes("it's") && !needsQuotes('a-b_c.d'))
})

test('activeMentionQuery: token no cursor (sem/com aspas), fora dele → null', () => {
  assert.deepEqual(activeMentionQuery('oi @sr', 6), {
    start: 3,
    end: 6,
    query: 'sr',
    quoted: false
  })
  assert.deepEqual(activeMentionQuery('@', 1), { start: 0, end: 1, query: '', quoted: false })
  // cursor no meio do token: `end` vai até o fim dele
  assert.deepEqual(activeMentionQuery('@src/app.ts fim', 4), {
    start: 0,
    end: 11,
    query: 'src',
    quoted: false
  })
  assert.deepEqual(activeMentionQuery('@"docs/meu ar', 13), {
    start: 0,
    end: 13,
    query: 'docs/meu ar',
    quoted: true
  })
  assert.equal(activeMentionQuery('@src/a.ts depois', 16), null, 'espaço depois do token')
  assert.equal(activeMentionQuery('a@b', 3), null, 'e-mail')
  assert.equal(activeMentionQuery('@"fechado" x', 12), null)
  assert.equal(activeMentionQuery('`@cod', 5), null, 'dentro de código')
  assert.equal(activeMentionQuery('@a\nb', 4), null, 'outra linha')
})

test('applyMention: pasta continua (sem espaço), arquivo fecha com espaço; aspas quando preciso', () => {
  const q1 = activeMentionQuery('veja @sr', 8)!
  assert.deepEqual(applyMention('veja @sr', q1, { path: 'src/', dir: true }), {
    text: 'veja @src/',
    caret: 10
  })
  const q2 = activeMentionQuery('veja @src/ap', 12)!
  assert.deepEqual(applyMention('veja @src/ap', q2, { path: 'src/app.ts', dir: false }), {
    text: 'veja @src/app.ts ',
    caret: 17
  })
  // espaço que já existia não duplica; texto depois fica
  const t3 = '@sr fim'
  const q3 = activeMentionQuery(t3, 3)!
  assert.deepEqual(applyMention(t3, q3, { path: 'src/x.ts', dir: false }), {
    text: '@src/x.ts fim',
    caret: 10
  })
  // pasta com espaço: aspas abertas (continua digitando dentro); arquivo: aspas fechadas
  const q4 = activeMentionQuery('@do', 3)!
  const r4 = applyMention('@do', q4, { path: 'docs com espaço/', dir: true })
  assert.deepEqual(r4, { text: '@"docs com espaço/', caret: 18 })
  const q5 = activeMentionQuery(r4.text, r4.caret)!
  assert.equal(q5.query, 'docs com espaço/')
  assert.deepEqual(applyMention(r4.text, q5, { path: 'docs com espaço/guia.md', dir: false }), {
    text: '@"docs com espaço/guia.md" ',
    caret: 27
  })
})

const INDEX = [
  '.env',
  'README.md',
  'docs/',
  'docs/guia.md',
  'src/',
  'src/app.ts',
  'src/components/',
  'src/components/Button.tsx',
  'src/components/Composer.tsx',
  'src/lib/',
  'src/lib/composerUtils.ts',
  'test/',
  'test/app.test.ts'
]

test('filtro: vazio → primeiro nível; com `/` → filhos diretos (pastas primeiro)', () => {
  assert.deepEqual(
    filterMentionIndex(INDEX, '').map((c) => c.path),
    ['docs/', 'src/', 'test/', '.env', 'README.md']
  )
  assert.deepEqual(
    filterMentionIndex(INDEX, 'src/').map((c) => c.path),
    ['src/components/', 'src/lib/', 'src/app.ts']
  )
  assert.deepEqual(
    filterMentionIndex(INDEX, 'src/comp').map((c) => c.path),
    ['src/components/']
  )
  assert.deepEqual(
    filterMentionIndex(INDEX, 'SRC/Components/b').map((c) => c.path),
    ['src/components/Button.tsx']
  )
  const c = filterMentionIndex(INDEX, 'src/components/')[0]
  assert.deepEqual(c, {
    path: 'src/components/Button.tsx',
    dir: false,
    name: 'Button.tsx',
    parent: 'src/components/'
  })
})

test('filtro sem `/`: raiz inteira — nome começa > nome contém > caminho > fuzzy; limite', () => {
  const r = filterMentionIndex(INDEX, 'comp').map((c) => c.path)
  assert.deepEqual(r.slice(0, 3), [
    'src/components/',
    'src/components/Composer.tsx',
    'src/lib/composerUtils.ts'
  ])
  assert.ok(r.includes('src/components/Button.tsx'), 'caminho contém')
  // fuzzy (subsequência)
  assert.deepEqual(
    filterMentionIndex(INDEX, 'gumd').map((c) => c.path),
    ['docs/guia.md']
  )
  assert.equal(filterMentionIndex(INDEX, 'zzz').length, 0)
  assert.equal(filterMentionIndex(INDEX, 's', 2).length, 2)
})
