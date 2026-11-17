/* eslint-disable @typescript-eslint/no-explicit-any */
// Arquivo selecionado (protocolo 1.13.0, SYNC §4.3.8 — @shared/openFile): o texto fixo, a
// normalização do caminho (relativo à raiz quando dentro, senão absoluto; Windows; `..`; limites),
// a validação de entrada, a mensagem como vai ao modelo (parte separada / linha em branco) e a
// injeção em TODOS os builders de request que enviam o histórico: turno (OpenAI-compatible com e
// sem cache, Anthropic nativa), subagente, compactação (full/trimmed/tail) e a conversa da extração
// de memórias. O `content` salvo nunca muda.
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest } from '../src/main/agent/request.ts'
import { buildCompactionRequest } from '../src/main/agent/compaction.ts'
import { extractionConversation } from '../src/main/memory/extraction.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import {
  isAbsolutePath,
  isPathInside,
  joinPath,
  normalizeOpenFilePath,
  OPEN_FILE_PATH_MAX,
  openFileText,
  parseOpenFile,
  pathBaseName,
  pathSegments,
  resolveChatPath,
  sendMetaOpenFile,
  storedOpenFile,
  withOpenFile,
  withOpenFiles,
  headingSlug,
  resolveMarkdownLink
} from '../src/shared/openFile.ts'
import type { ApiMessage, Chat, MessageMeta, Provider, StoredMessage } from '../src/shared/types.ts'

const LINE = (p: string): string =>
  `O usuário está com o arquivo ${p} selecionado; ele pode ou não estar relacionado a esta mensagem.`

test('texto fixo: exatamente o do protocolo', () => {
  assert.equal(openFileText('src/app.ts'), LINE('src/app.ts'))
  assert.equal(
    openFileText('/etc/hosts'),
    'O usuário está com o arquivo /etc/hosts selecionado; ele pode ou não estar relacionado a esta mensagem.'
  )
})

test('caminho: relativo dentro da raiz, absoluto fora, `.`/`..` resolvidos', () => {
  const root = '/home/u/proj'
  assert.equal(normalizeOpenFilePath('/home/u/proj/src/a.ts', root), 'src/a.ts')
  assert.equal(normalizeOpenFilePath('/home/u/proj/./src//b/../a.ts', root), 'src/a.ts')
  assert.equal(normalizeOpenFilePath('src/a.ts', root), 'src/a.ts')
  assert.equal(normalizeOpenFilePath('./src/a.ts', root), 'src/a.ts')
  // fora da raiz → absoluto (inclusive relativo que sobe)
  assert.equal(normalizeOpenFilePath('/etc/hosts', root), '/etc/hosts')
  assert.equal(normalizeOpenFilePath('../outro/x.md', root), '/home/u/outro/x.md')
  assert.equal(normalizeOpenFilePath('/home/u/project2/a', root), '/home/u/project2/a')
  // raiz com barra no fim / raiz "/"
  assert.equal(normalizeOpenFilePath('/home/u/proj/a', '/home/u/proj/'), 'a')
  assert.equal(normalizeOpenFilePath('/etc/x', '/'), 'etc/x')
  // a própria raiz não é arquivo
  assert.equal(normalizeOpenFilePath('/home/u/proj', root), null)
  assert.equal(normalizeOpenFilePath('.', root), null)
  // sem raiz: como veio
  assert.equal(normalizeOpenFilePath('qualquer/coisa', null), 'qualquer/coisa')
  // nomes com espaço e unicode passam
  assert.equal(normalizeOpenFilePath('/home/u/proj/Meus docs/ação.md', root), 'Meus docs/ação.md')
})

test('caminho: Windows (unidade, `/` e `\\`, sem caixa) e UNC', () => {
  const root = 'C:\\Users\\Ana\\proj'
  assert.equal(normalizeOpenFilePath('C:\\Users\\Ana\\proj\\src\\a.ts', root), 'src\\a.ts')
  assert.equal(normalizeOpenFilePath('c:/users/ana/PROJ/src/a.ts', root), 'src\\a.ts')
  assert.equal(normalizeOpenFilePath('src/a.ts', root), 'src\\a.ts')
  assert.equal(normalizeOpenFilePath('D:\\x.txt', root), 'D:\\x.txt')
  assert.equal(normalizeOpenFilePath('..\\b.txt', root), 'C:\\Users\\Ana\\b.txt')
  assert.equal(normalizeOpenFilePath('\\\\srv\\share\\a.txt', root), '\\\\srv\\share\\a.txt')
  assert.ok(isAbsolutePath('C:/x') && isAbsolutePath('\\\\srv\\s') && isAbsolutePath('/x'))
  assert.ok(!isAbsolutePath('src/x') && !isAbsolutePath('C:x'))
})

test('caminho: inválidos (vazio, controle, NUL, > 1024) → null; nunca cortado', () => {
  for (const bad of ['', '   ', 'a\u0000b', 'a\nb', 'a\tb', 42, null, undefined, {}])
    assert.equal(normalizeOpenFilePath(bad as any, '/r'), null, JSON.stringify(bad))
  const long = 'x'.repeat(OPEN_FILE_PATH_MAX)
  assert.equal(normalizeOpenFilePath(long, null), long)
  assert.equal(normalizeOpenFilePath(long + 'y', null), null)
  assert.equal(normalizeOpenFilePath(`/r/${long}`, '/r'), long)
  assert.equal(normalizeOpenFilePath(`/outra/${long}`, '/r'), null)
})

test('parseOpenFile / storedOpenFile: entrada não confiável', () => {
  assert.deepEqual(parseOpenFile({ path: '/r/a.ts' }, '/r'), { path: 'a.ts' })
  assert.deepEqual(parseOpenFile({ path: 'a.ts', extra: 1 }), { path: 'a.ts' })
  for (const bad of [null, 'a.ts', [], { path: '' }, { path: 'a\u0000' }, { file: 'a' }])
    assert.equal(parseOpenFile(bad as any, '/r'), null)
  assert.deepEqual(storedOpenFile({ openFile: { path: 'a.ts' } }), { path: 'a.ts' })
  assert.equal(storedOpenFile({ openFile: { path: 'x'.repeat(2000) } }), null)
  assert.equal(storedOpenFile({}), null)
})

test('sendMetaOpenFile: `meta.openFile` do comando remoto `send` (qualquer meta)', () => {
  assert.deepEqual(sendMetaOpenFile({ openFile: { path: '/r/a.ts' } }), { path: '/r/a.ts' })
  assert.deepEqual(sendMetaOpenFile({ kind: 'inter-chat', openFile: { path: 'a' } }), { path: 'a' })
  for (const bad of [null, undefined, 'x', [], {}, { openFile: { path: 'a\u0000' } }])
    assert.equal(sendMetaOpenFile(bad), null)
})

test('resolveChatPath / pathBaseName', () => {
  assert.equal(resolveChatPath('src/a.ts', '/home/u/p'), '/home/u/p/src/a.ts')
  assert.equal(resolveChatPath('/etc/x', '/home/u/p'), '/etc/x')
  assert.equal(resolveChatPath('../q/a', '/home/u/p'), '/home/u/q/a')
  assert.equal(resolveChatPath('src/a.ts', 'C:\\p'), 'C:\\p\\src\\a.ts')
  assert.equal(resolveChatPath('a', null), 'a')
  assert.equal(pathBaseName('/a/b/c.txt'), 'c.txt')
  assert.equal(pathBaseName('C:\\a\\b.txt'), 'b.txt')
  assert.equal(pathBaseName('src/'), 'src')
})

test('withOpenFile: texto → linha em branco + texto fixo; parts → parte separada; nada muda na entrada', () => {
  const of = { path: 'src/a.ts' }
  assert.deepEqual(withOpenFile({ role: 'user', content: 'oi' }, of), {
    role: 'user',
    content: `oi\n\n${LINE('src/a.ts')}`
  })
  assert.deepEqual(withOpenFile({ role: 'user', content: '' }, of), {
    role: 'user',
    content: LINE('src/a.ts')
  })
  const parts: ApiMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'veja' },
      { type: 'image_url', image_url: { url: 'clearchat-attachment://x.png' } }
    ]
  }
  const snap = JSON.stringify(parts)
  const out = withOpenFile(parts, of) as any
  assert.equal(out.content.length, 3)
  assert.deepEqual(out.content[2], { type: 'text', text: LINE('src/a.ts') })
  assert.equal(JSON.stringify(parts), snap, 'entrada intacta')
  const a: ApiMessage = { role: 'assistant', content: 'x' }
  assert.equal(withOpenFile(a, of), a)
  const u: ApiMessage = { role: 'user', content: 'x' }
  assert.equal(withOpenFile(u, null), u)
  const hist = [sm({ role: 'user', content: 'x' })]
  assert.equal(withOpenFiles(hist), hist, 'sem openFile: mesma referência')
})

// ---------------- builders de request ----------------

const GEN: Provider = {
  id: 'p1',
  name: 'Genérico',
  kind: 'openai',
  baseUrl: 'https://llm.example.com/v1',
  apiKey: 'k',
  headers: {},
  createdAt: 0
}
const OR: Provider = {
  ...GEN,
  name: 'OR',
  kind: undefined,
  baseUrl: 'https://openrouter.ai/api/v1'
}
const ANTH: Provider = {
  ...GEN,
  id: 'pa',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1'
}
const chat = (over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('/work', { providerId: 'p1', model: 'm', systemPrompt: 'SYS' }),
    enabledTools: [],
    envInPrompt: false,
    ...over
  }
})
let seq = 0
function sm(message: ApiMessage, meta: MessageMeta = {}): StoredMessage {
  seq++
  return { id: `m${seq}`, sessionId: 's1', seq, message, meta, createdAt: 0 }
}
const env = { os: 'Linux', shell: 'bash' }
const history = (): StoredMessage[] => [
  sm({ role: 'user', content: 'primeira' }, { openFile: { path: 'src/a.ts' } }),
  sm({ role: 'assistant', content: 'resposta' }),
  sm({ role: 'user', content: 'segunda sem arquivo' }),
  sm({ role: 'assistant', content: 'ok' }),
  sm(
    { role: 'user', content: [{ type: 'text', text: 'terceira' }] },
    { openFile: { path: '/etc/hosts' } }
  )
]
const userTexts = (msgs: any[]): string[] =>
  msgs
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join('|')
    )

test('turno OpenAI-compatible (sem cache): texto fixo nas mensagens do usuário com arquivo', () => {
  const h = history()
  const snap = JSON.stringify(h)
  const req = buildRequest(chat(), { depth: 0, model: 'm' }, h, GEN, env)
  assert.deepEqual(userTexts((req.body as any).messages), [
    `primeira\n\n${LINE('src/a.ts')}`,
    'segunda sem arquivo',
    `terceira|${LINE('/etc/hosts')}`
  ])
  assert.equal(JSON.stringify(h), snap, 'o histórico salvo não muda')
})

test('turno OpenRouter com cache: parte separada, cache_control na última parte de texto', () => {
  const req = buildRequest(
    chat({ cacheEnabled: true }),
    { depth: 0, model: 'm' },
    history(),
    OR,
    env
  )
  const msgs = (req.body as any).messages
  const last = msgs[msgs.length - 1]
  assert.deepEqual(last.content[0], { type: 'text', text: 'terceira' })
  assert.equal(last.content[1].text, LINE('/etc/hosts'))
  assert.equal(last.content[1].cache_control.type, 'ephemeral')
})

test('turno Anthropic nativa (Messages API): texto fixo no conteúdo do usuário', () => {
  const req = buildRequest(chat(), { depth: 0, model: 'claude-x' }, history(), ANTH, env)
  const body = req.body as any
  const json = JSON.stringify(body.messages)
  assert.ok(json.includes(JSON.stringify(`primeira\n\n${LINE('src/a.ts')}`).slice(1, -1)))
  assert.ok(json.includes(LINE('/etc/hosts')))
  assert.equal(req.api, 'messages')
})

test('subagente: o histórico dele também passa pela injeção', () => {
  const h = [sm({ role: 'user', content: 'tarefa' }, { openFile: { path: 'b.md' } })]
  const req = buildRequest(chat(), { depth: 1, model: 'm' }, h, GEN, env)
  assert.deepEqual(userTexts((req.body as any).messages), [`tarefa\n\n${LINE('b.md')}`])
})

test('compactação (full, trimmed, tail): o resumo vê o texto fixo; o prompt de resumo não', () => {
  for (const mode of ['full', 'trimmed', 'tail'] as const) {
    const req = buildCompactionRequest(
      chat(),
      { id: 's1', depth: 0, model: 'm' },
      history(),
      GEN,
      'RESUMA',
      { mode, window: 100_000 },
      env
    )
    const u = userTexts((req.body as any).messages)
    assert.ok(u.includes(`primeira\n\n${LINE('src/a.ts')}`), mode)
    assert.equal(u[u.length - 1], 'RESUMA', mode)
  }
})

test('extração de memórias: a conversa mostra o que o modelo viu', () => {
  const c = extractionConversation(history(), 0, 'manual')
  assert.ok(c.text.includes(`Usuário: primeira\n\n${LINE('src/a.ts')}`))
  assert.ok(c.text.includes('Usuário: segunda sem arquivo'))
})

test('meta inválido no histórico (sincronizado de fora) não vai ao modelo', () => {
  const h = [
    sm({ role: 'user', content: 'x' }, { openFile: { path: 'a\u0000b' } }),
    sm({ role: 'user', content: 'y' }, { openFile: 'nada' as any })
  ]
  const req = buildRequest(chat(), { depth: 0, model: 'm' }, h, GEN, env)
  assert.deepEqual(userTexts((req.body as any).messages), ['x', 'y'])
})

test('busca nativa de tools (Messages API, 1.12.0): o histórico enviado também leva o texto fixo', () => {
  const req = buildRequest(
    chat({ enabledTools: ['read_file', 'shell', 'datetime'] }),
    { depth: 0, model: 'claude-sonnet-4-5' },
    history(),
    ANTH,
    env,
    { modeOverride: 'native-anthropic' }
  )
  assert.equal(req.toolSearch?.mode, 'native-anthropic')
  const json = JSON.stringify((req.body as any).messages)
  assert.ok(json.includes(LINE('src/a.ts')) && json.includes(LINE('/etc/hosts')))
})

// aba Arquivos: o confinamento comparava com `/` fixo — numa raiz `C:\…` nenhuma subpasta ficava
// "dentro" e cada clique devolvia a aba à raiz
test('isPathInside: POSIX, Windows (sem caixa, \\ e /), barras finais, . e ..', () => {
  assert.equal(isPathInside('/home/u/p', '/home/u/p'), true)
  assert.equal(isPathInside('/home/u/p/src', '/home/u/p'), true)
  assert.equal(isPathInside('/home/u/p/src', '/home/u/p/'), true)
  assert.equal(isPathInside('/home/u/p//src/', '/home/u/p'), true)
  assert.equal(isPathInside('/home/u/projeto', '/home/u/p'), false)
  assert.equal(isPathInside('/home/u/p/../q', '/home/u/p'), false)
  assert.equal(isPathInside('/etc', '/'), true)
  assert.equal(isPathInside('/home/U/p/src', '/home/u/p'), false)
  assert.equal(isPathInside('C:\\Users\\dev\\projeto\\src', 'C:\\Users\\dev\\projeto'), true)
  assert.equal(isPathInside('c:/users/DEV/projeto/src', 'C:\\Users\\dev\\projeto'), true)
  assert.equal(isPathInside('C:\\Users\\dev\\projeto2', 'C:\\Users\\dev\\projeto'), false)
  assert.equal(isPathInside('D:\\Users\\dev\\projeto\\src', 'C:\\Users\\dev\\projeto'), false)
  assert.equal(isPathInside('C:\\x', 'C:\\'), true)
  assert.equal(isPathInside('\\\\srv\\share\\a', '\\\\srv\\share'), true)
  assert.equal(isPathInside('', '/home'), false)
  assert.equal(isPathInside('/home', ''), false)
})

test('joinPath / pathSegments: separador do sistema da pasta', () => {
  assert.equal(joinPath('/home/u', 'a'), '/home/u/a')
  assert.equal(joinPath('/', 'etc'), '/etc')
  assert.equal(joinPath('C:\\Users\\dev', 'a'), 'C:\\Users\\dev\\a')
  assert.equal(joinPath('C:\\', 'Users'), 'C:\\Users')
  assert.deepEqual(pathSegments('/home/u/p/'), { head: '/', segs: ['home', 'u', 'p'] })
  assert.deepEqual(pathSegments('C:/Users\\dev'), { head: 'C:\\', segs: ['Users', 'dev'] })
  assert.deepEqual(pathSegments('\\\\srv\\share'), { head: '\\\\', segs: ['srv', 'share'] })
})

test('links do markdown no visualizador: relativo à pasta do arquivo (POSIX/Windows), âncora, externo', () => {
  const md = '/home/u/proj/IDEIA/README.md'
  assert.deepEqual(resolveMarkdownLink(md, '02-diagnostico-dos-dados.md'), {
    kind: 'file',
    path: '/home/u/proj/IDEIA/02-diagnostico-dos-dados.md',
    anchor: null
  })
  assert.deepEqual(resolveMarkdownLink(md, './anexos/a%20b.md#Se%C3%A7%C3%A3o'), {
    kind: 'file',
    path: '/home/u/proj/IDEIA/anexos/a b.md',
    anchor: 'Se%C3%A7%C3%A3o'
  })
  assert.deepEqual(resolveMarkdownLink(md, '../outro.md?x=1'), {
    kind: 'file',
    path: '/home/u/proj/outro.md',
    anchor: null
  })
  assert.deepEqual(resolveMarkdownLink(md, '/etc/hosts'), {
    kind: 'file',
    path: '/etc/hosts',
    anchor: null
  })
  assert.deepEqual(resolveMarkdownLink('C:\\Users\\u\\docs\\README.md', '../b/c.md'), {
    kind: 'file',
    path: 'C:\\Users\\u\\b\\c.md',
    anchor: null
  })
  assert.deepEqual(resolveMarkdownLink(md, '#o-que-eu-recomendo'), {
    kind: 'anchor',
    anchor: 'o-que-eu-recomendo'
  })
  assert.deepEqual(resolveMarkdownLink(md, 'https://maplibre.org'), { kind: 'external' })
  assert.deepEqual(resolveMarkdownLink(md, 'mailto:a@b.c'), { kind: 'external' })
  assert.equal(resolveMarkdownLink(md, '  '), null)
  assert.equal(resolveMarkdownLink(md, '#'), null)
  assert.equal(headingSlug('O que eu recomendo'), 'o-que-eu-recomendo')
  assert.equal(headingSlug('2.1 Modelo de dados — aviário!'), '21-modelo-de-dados--aviário')
})
