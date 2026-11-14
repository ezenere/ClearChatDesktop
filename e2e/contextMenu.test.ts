// Menu de contexto (botão direito) — partes puras, sem Electron: builder dos itens (campo editável,
// corretor, seleção, links com lista de esquemas, imagens, ações do app, item de dev), validação do
// descritor do renderer, URL de pesquisa, nome ao salvar imagem, Markdown → texto simples e o
// registro do renderer (mais interno vence, campo editável fora, token de uso único).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContextMenu,
  editAccelerator,
  type CtxItem,
  type CtxOptions,
  type CtxParams
} from '../src/main/contextMenuTemplate.ts'
import {
  imageFileName,
  isOpenableLink,
  markdownToPlainText,
  sanitizeAppCtx,
  searchLabel,
  webSearchUrl,
  CTX_MAX_COPY
} from '../src/shared/contextMenu.ts'
import {
  beginCtx,
  contributeCtx,
  isEditableTarget,
  runCtxAction,
  snapshotCtx
} from '../src/renderer/src/lib/contextMenu.ts'

const FLAGS = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canSelectAll: false
}

function params(p: Partial<CtxParams> = {}): CtxParams {
  return {
    x: 10,
    y: 20,
    isEditable: false,
    selectionText: '',
    linkURL: '',
    mediaType: 'none',
    srcURL: '',
    hasImageContents: false,
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: { ...FLAGS },
    ...p
  }
}

const OPTS: CtxOptions = { platform: 'linux', dev: false, canAddWord: true }

/** Itens como texto: "Rótulo" (desabilitado: "(Rótulo)"), separador "—". */
const view = (items: CtxItem[]): string[] =>
  items.map((i) => (i.type === 'separator' ? '—' : i.enabled ? i.label : `(${i.label})`))

const find = (items: CtxItem[], label: string): Extract<CtxItem, { type: 'item' }> => {
  const it = items.find((i) => i.type === 'item' && i.label === label)
  assert.ok(it && it.type === 'item', `item ${label}`)
  return it
}

test('nada sob o clique (fora de dev) → nenhum item (não abre menu)', () => {
  assert.deepEqual(buildContextMenu(params(), OPTS), [])
})

test('dev: "Inspecionar elemento" no fim, com as coordenadas do clique', () => {
  const items = buildContextMenu(
    params({ selectionText: 'oi', editFlags: { ...FLAGS, canCopy: true } }),
    {
      ...OPTS,
      dev: true
    }
  )
  assert.deepEqual(view(items).slice(-2), ['—', 'Inspecionar elemento'])
  assert.deepEqual(find(items, 'Inspecionar elemento').command, { type: 'inspect', x: 10, y: 20 })
  assert.deepEqual(view(buildContextMenu(params(), { ...OPTS, dev: true })), [
    'Inspecionar elemento'
  ])
})

test('campo editável: desfazer/refazer + recortar/copiar/colar/colar sem formatação/selecionar tudo pelos editFlags', () => {
  const items = buildContextMenu(
    params({
      isEditable: true,
      editFlags: { ...FLAGS, canPaste: true, canSelectAll: true, canUndo: true }
    }),
    OPTS
  )
  assert.deepEqual(view(items), [
    'Desfazer',
    '(Refazer)',
    '—',
    '(Recortar)',
    '(Copiar)',
    'Colar',
    'Colar sem formatação',
    'Selecionar tudo'
  ])
  assert.deepEqual(find(items, 'Colar sem formatação').command, {
    type: 'edit',
    op: 'pasteAndMatchStyle'
  })
  assert.equal(find(items, 'Colar').accelerator, 'CmdOrCtrl+V')
})

test('atalhos por plataforma', () => {
  assert.equal(editAccelerator('redo', 'linux'), 'Ctrl+Shift+Z')
  assert.equal(editAccelerator('redo', 'win32'), 'Ctrl+Y')
  assert.equal(editAccelerator('redo', 'darwin'), 'Shift+Cmd+Z')
  assert.equal(editAccelerator('pasteAndMatchStyle', 'darwin'), 'Shift+Alt+Cmd+V')
  assert.equal(editAccelerator('pasteAndMatchStyle', 'linux'), 'Ctrl+Shift+V')
})

test('corretor: sugestões primeiro (até 5), "Adicionar ao dicionário" só em sessão persistente', () => {
  const p = params({
    isEditable: true,
    misspelledWord: 'cassa',
    dictionarySuggestions: ['casa', 'caça', 'cassa', 'massa', 'cansa', 'caixa', 'calça']
  })
  const items = buildContextMenu(p, OPTS)
  assert.deepEqual(view(items).slice(0, 7), [
    'casa',
    'caça',
    'cassa',
    'massa',
    'cansa',
    'Adicionar ao dicionário',
    '—'
  ])
  assert.deepEqual(find(items, 'caça').command, { type: 'replaceMisspelling', word: 'caça' })
  assert.deepEqual(find(items, 'Adicionar ao dicionário').command, {
    type: 'addWord',
    word: 'cassa'
  })
  const mem = buildContextMenu(p, { ...OPTS, canAddWord: false })
  assert.ok(!view(mem).includes('Adicionar ao dicionário'))
  // sem sugestões: item desabilitado
  const none = buildContextMenu(params({ isEditable: true, misspelledWord: 'xyzw' }), OPTS)
  assert.deepEqual(view(none).slice(0, 3), ['(Sem sugestões)', 'Adicionar ao dicionário', '—'])
  // palavra marcada fora de campo editável não gera sugestões
  assert.deepEqual(buildContextMenu(params({ misspelledWord: 'xyzw' }), OPTS), [])
})

test('texto selecionado (fora de campo): Copiar + Pesquisar na web (rótulo encurtado, & escapado)', () => {
  const sel = 'Política   de cache & invalidação de respostas da API'
  const items = buildContextMenu(
    params({ selectionText: sel, editFlags: { ...FLAGS, canCopy: true } }),
    OPTS
  )
  assert.deepEqual(view(items), ['Copiar', '—', searchLabel(sel)])
  assert.match(searchLabel(sel), /^Pesquisar na web: “Política de cache && invalidação…”$/)
  assert.deepEqual(find(items, searchLabel(sel)).command, {
    type: 'search',
    text: 'Política de cache & invalidação de respostas da API'
  })
  // campo editável com seleção: edição + pesquisa
  const ed = buildContextMenu(params({ isEditable: true, selectionText: 'abc' }), OPTS)
  assert.equal(view(ed).at(-1), searchLabel('abc'))
})

test('links: só http/https/mailto abrem; sempre dá para copiar', () => {
  const http = buildContextMenu(params({ linkURL: 'https://example.com/a?b=1' }), OPTS)
  assert.deepEqual(view(http), ['Abrir no navegador', 'Copiar link'])
  assert.deepEqual(find(http, 'Copiar link').command, {
    type: 'copyText',
    text: 'https://example.com/a?b=1'
  })
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'clearchat-file://tok/x',
    'smb://h/x'
  ]) {
    const items = buildContextMenu(params({ linkURL: bad }), OPTS)
    assert.deepEqual(view(items), ['Copiar link'], bad)
  }
  const mail = buildContextMenu(
    params({ linkURL: 'mailto:Ana%20B%20<ana@x.com>?subject=oi' }),
    OPTS
  )
  assert.deepEqual(view(mail), ['Escrever e-mail', 'Copiar e-mail'])
  assert.deepEqual(find(mail, 'Copiar e-mail').command, {
    type: 'copyText',
    text: 'Ana B <ana@x.com>'
  })
  assert.ok(isOpenableLink('http://a.b') && isOpenableLink('mailto:a@b.c'))
  assert.ok(!isOpenableLink('not a url') && !isOpenableLink('ftp://x'))
})

test('imagens: copiar (com conteúdo) e salvar (esquemas conhecidos)', () => {
  const img = buildContextMenu(
    params({
      mediaType: 'image',
      srcURL: 'clearchat-attachment://' + 'a'.repeat(64) + '.png',
      hasImageContents: true
    }),
    OPTS
  )
  assert.deepEqual(view(img), ['Copiar imagem', 'Salvar imagem como…'])
  assert.deepEqual(find(img, 'Copiar imagem').command, { type: 'copyImage', x: 10, y: 20 })
  const odd = buildContextMenu(params({ mediaType: 'image', srcURL: 'chrome://x/y.png' }), OPTS)
  assert.deepEqual(view(odd), ['(Copiar imagem)', '(Salvar imagem como…)'])
  // link + imagem + seleção: grupos na ordem seleção → link → imagem
  const all = buildContextMenu(
    params({
      selectionText: 'x',
      linkURL: 'https://a.b',
      mediaType: 'image',
      srcURL: 'https://a.b/i.png',
      hasImageContents: true,
      editFlags: { ...FLAGS, canCopy: true }
    }),
    OPTS
  )
  assert.deepEqual(view(all), [
    'Copiar',
    '—',
    searchLabel('x'),
    '—',
    'Abrir no navegador',
    'Copiar link',
    '—',
    'Copiar imagem',
    'Salvar imagem como…'
  ])
})

test('ações do app: ordem fixa, grupos mensagem/arquivo, nunca em campo editável', () => {
  const app = sanitizeAppCtx({
    token: 7,
    actions: [
      'regenerate',
      'copyMarkdown',
      'fileCopyPath',
      'copyMessage',
      'editMessage',
      'fileShowInFolder'
    ],
    copy: { copyMarkdown: '**a**', copyMessage: 'a', fileCopyPath: '/tmp/x' }
  })
  const items = buildContextMenu(params(), { ...OPTS, app })
  assert.deepEqual(view(items), [
    'Copiar mensagem',
    'Copiar como Markdown',
    'Editar',
    'Regenerar resposta',
    '—',
    'Mostrar na pasta',
    'Copiar caminho'
  ])
  assert.deepEqual(find(items, 'Editar').command, { type: 'app', action: 'editMessage' })
  // seleção dentro da mensagem: Copiar/Pesquisar antes das ações do app
  const withSel = buildContextMenu(
    params({ selectionText: 'a', editFlags: { ...FLAGS, canCopy: true } }),
    {
      ...OPTS,
      app
    }
  )
  assert.deepEqual(view(withSel).slice(0, 4), ['Copiar', '—', searchLabel('a'), '—'])
  // editor da mensagem (textarea dentro do balão): só o menu de edição
  const ed = buildContextMenu(params({ isEditable: true }), { ...OPTS, app })
  assert.ok(!view(ed).includes('Copiar mensagem') && !view(ed).includes('Editar'))
  // bloco de código: "Copiar código" primeiro
  const code = sanitizeAppCtx({
    token: 1,
    actions: ['copyMessage', 'copyCode'],
    copy: { copyMessage: 'm', copyCode: 'c' }
  })
  assert.deepEqual(view(buildContextMenu(params(), { ...OPTS, app: code })), [
    'Copiar código',
    'Copiar mensagem'
  ])
})

test('sanitizeAppCtx: lista fechada, sem repetição, cópia só com texto, teto de tamanho', () => {
  assert.equal(sanitizeAppCtx(null), null)
  assert.equal(sanitizeAppCtx({ token: 'x', actions: ['copyMessage'] }), null)
  assert.equal(sanitizeAppCtx({ token: 1.5, actions: ['editMessage'] }), null)
  assert.equal(sanitizeAppCtx({ token: 1, actions: 'editMessage' }), null)
  assert.equal(sanitizeAppCtx({ token: 1, actions: ['rm -rf', 'eval', '__proto__'] }), null)
  const r = sanitizeAppCtx({
    token: 3,
    actions: ['editMessage', 'editMessage', 'copyMessage', 'copyCode', 'openDevTools', 'fileRun'],
    copy: { copyMessage: 'x'.repeat(CTX_MAX_COPY + 10), copyCode: 42 }
  })
  assert.deepEqual(r?.actions, ['editMessage', 'copyMessage', 'fileRun'])
  assert.equal(r?.copy.copyMessage?.length, CTX_MAX_COPY)
  assert.equal(r?.copy.copyCode, undefined)
})

test('pesquisa na web: buscador preferido do web_search (Brave) ou DuckDuckGo', () => {
  assert.equal(webSearchUrl('  a  b&c ', 'ddg'), 'https://duckduckgo.com/?q=a%20b%26c')
  assert.equal(webSearchUrl('x', 'brave-site'), 'https://search.brave.com/search?q=x')
  assert.equal(webSearchUrl('x', 'brave-api'), 'https://search.brave.com/search?q=x')
  assert.equal(webSearchUrl('x', 'tavily'), 'https://duckduckgo.com/?q=x')
  assert.equal(webSearchUrl('x', null), 'https://duckduckgo.com/?q=x')
  assert.equal(decodeURIComponent(webSearchUrl('y'.repeat(1000)).split('q=')[1]).length, 400)
})

test('nome sugerido ao salvar imagem', () => {
  assert.equal(imageFileName('clearchat-attachment://' + 'f'.repeat(64) + '.webp'), 'imagem.webp')
  assert.equal(imageFileName('data:image/jpeg;base64,AAAA'), 'imagem.jpg')
  assert.equal(imageFileName('https://x.com/a/gr%C3%A1fico.png?v=1'), 'gráfico.png')
  assert.equal(imageFileName('https://x.com/a/foto'), 'foto.png')
  assert.equal(imageFileName('https://x.com/'), 'imagem.png')
  assert.equal(
    imageFileName('clearchat-file://tok/dir/..%2F..%2Fetc%2Fpasswd'),
    '_.._etc_passwd.png'
  )
  assert.equal(imageFileName('lixo'), 'imagem.png')
})

test('Markdown → texto simples', () => {
  const md = [
    '# Título **forte**',
    '',
    'Texto com *ênfase*, __negrito__, ~~riscado~~, `code *literal*` e [link](https://a.b "t").',
    '![alt da imagem](x.png) e <https://auto.link>',
    '',
    '> citação',
    '> > aninhada',
    '',
    '- item um',
    '  * sub item',
    '- [ ] tarefa',
    '- [x] feita',
    '1. primeiro',
    '',
    '---',
    '',
    '| A | B |',
    '|---|:-:|',
    '| 1 | **2** |',
    '',
    '```js',
    'const a = **1** // *não* mexe',
    '```',
    '',
    '',
    '',
    'snake_case_name e 2*3*4 ficam; escape \\*literal\\*'
  ].join('\n')
  assert.equal(
    markdownToPlainText(md),
    [
      'Título forte',
      '',
      'Texto com ênfase, negrito, riscado, code *literal* e link.',
      'alt da imagem e https://auto.link',
      '',
      'citação',
      'aninhada',
      '',
      '• item um',
      '  • sub item',
      '• ☐ tarefa',
      '• ☑ feita',
      '1. primeiro',
      '',
      'A\tB',
      '1\t2',
      '',
      'const a = **1** // *não* mexe',
      '',
      'snake_case_name e 2*3*4 ficam; escape *literal*'
    ].join('\n')
  )
  // cerca ~~~ e cerca mais longa com ``` dentro
  assert.equal(markdownToPlainText('````md\n```py\nx\n```\n````\nfim'), '```py\nx\n```\nfim')
  assert.equal(markdownToPlainText('~~~\n# não é título\n~~~'), '# não é título')
  assert.equal(markdownToPlainText('Título\n===\ncorpo'), 'Título\n\ncorpo')
})

test('registro do renderer: mais interno vence, editável fica fora, token de uso único', () => {
  // sem clique em andamento: nada
  contributeCtx({ target: null }, { copy: { copyMessage: 'x' } })
  assert.equal(snapshotCtx(), null)

  const calls: string[] = []
  beginCtx()
  // bloco de código (mais interno) e depois a mensagem
  contributeCtx({ target: null }, { copy: { copyCode: 'print(1)' } })
  contributeCtx(
    { target: null },
    {
      copy: { copyMessage: () => 'texto', copyMarkdown: '**texto**', copyCode: 'NÃO' },
      run: { editMessage: () => calls.push('edit'), regenerate: undefined }
    }
  )
  const snap = snapshotCtx()
  assert.ok(snap)
  assert.deepEqual(snap.actions, ['copyCode', 'copyMessage', 'copyMarkdown', 'editMessage'])
  assert.deepEqual(snap.copy, {
    copyCode: 'print(1)',
    copyMessage: 'texto',
    copyMarkdown: '**texto**'
  })
  // consumido: nova pergunta sem novo clique → null
  assert.equal(snapshotCtx(), null)
  // token errado / ação de cópia / ação ausente → nada
  assert.equal(runCtxAction(snap.token + 1, 'editMessage'), false)
  assert.equal(runCtxAction(snap.token, 'copyMessage'), false)
  assert.equal(runCtxAction(snap.token, 'regenerate'), false)
  assert.equal(runCtxAction(snap.token, 'editMessage'), true)
  assert.deepEqual(calls, ['edit'])
  assert.equal(runCtxAction(snap.token, 'editMessage'), false, 'uso único')

  // clique dentro de um campo editável: nenhuma contribuição
  const textarea = { closest: (sel: string) => (sel.includes('textarea') ? {} : null) }
  assert.ok(isEditableTarget(textarea))
  assert.ok(!isEditableTarget({ closest: () => null }))
  beginCtx()
  contributeCtx({ target: textarea }, { copy: { copyMessage: 'x' } })
  assert.equal(snapshotCtx(), null)

  // texto vazio não vira ação
  beginCtx()
  contributeCtx({ target: null }, { copy: { copyMessage: '' } })
  assert.equal(snapshotCtx(), null)
})

test('arquivo (aba Arquivos / painel de arquivo): Mencionar no chat primeiro; Renomear e Excluir no fim', () => {
  const app = sanitizeAppCtx({
    token: 8,
    actions: ['fileDelete', 'fileCopyPath', 'fileRename', 'fileMention', 'fileOpenExternal'],
    copy: { fileCopyPath: '/r/a.ts' }
  })
  assert.deepEqual(view(buildContextMenu(params(), { ...OPTS, app })), [
    'Mencionar no chat',
    'Abrir no app',
    'Copiar caminho',
    'Renomear',
    'Excluir'
  ])
  assert.deepEqual(find(buildContextMenu(params(), { ...OPTS, app }), 'Excluir').command, {
    type: 'app',
    action: 'fileDelete'
  })
})
