/* eslint-disable @typescript-eslint/no-explicit-any */
// present_file + visualizador de arquivos (sem Electron): validação dos argumentos, confinamento de
// caminhos (as mesmas regras do read_file), texto do resultado, bloco de título dos cards, tipo do
// arquivo (extensão + bytes), URLs do protocolo, allowlist (registro de concessões, assets
// relativos, symlinks), resposta do protocolo (mime, nosniff, CSP do HTML), abertura/checagem
// (mensagem real, outro dispositivo, confinamento), leitura de texto com teto e disponibilidade
// da tool só na sessão principal.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codeLanguage,
  detectViewerKind,
  kindFromName,
  looksBinary,
  parsePresentFileArgs,
  parseViewerUrl,
  PRESENT_FILE_LIMITS,
  presentResultText,
  presentTitleBlock,
  sniffMagic,
  VIEWER_HTML_CSP,
  VIEWER_LIMITS,
  viewerAssetMime,
  viewerMime,
  viewerUrl
} from '../src/shared/fileViewer.ts'
import { presentFileTool } from '../src/main/tools/present.ts'
import {
  checkPresented,
  grantedPath,
  openViewerFile,
  parseByteRange,
  readViewerText,
  registerPresented,
  serveViewerRequest,
  ViewerRegistry,
  type ViewerDeps
} from '../src/main/fileViewer.ts'
import { availableTools } from '../src/main/agent/request.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import { TOOL_DEFINITIONS, TOOL_NAMES } from '../src/shared/tools.ts'
import type { Chat, PresentFilesRecord, StoredMessage } from '../src/shared/types.ts'

const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'cc-present-')))
const ROOT = join(TMP, 'root')
const OUT = join(TMP, 'fora')
mkdirSync(join(ROOT, 'docs', 'img'), { recursive: true })
mkdirSync(OUT, { recursive: true })
after(() => rmSync(TMP, { recursive: true, force: true }))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
writeFileSync(join(ROOT, 'docs', 'relatorio.md'), '# Relatório\n\n![g](img/g.png)\n')
writeFileSync(join(ROOT, 'docs', 'img', 'g.png'), PNG)
writeFileSync(join(ROOT, 'docs', 'img', 'segredo.txt'), 'não sou imagem')
writeFileSync(join(ROOT, 'pagina.html'), '<h1>oi</h1>')
writeFileSync(join(ROOT, 'dados.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2]))
writeFileSync(join(ROOT, 'semext'), PNG)
writeFileSync(join(OUT, 'segredo.png'), PNG)
symlinkSync(OUT, join(ROOT, 'link-fora'))
symlinkSync(join(OUT, 'segredo.png'), join(ROOT, 'docs', 'img', 'atalho.png'))

const ctx = (over: Record<string, unknown> = {}): any => ({
  cwd: ROOT,
  confine: true,
  signal: new AbortController().signal,
  ...over
})

// ---------------- argumentos ----------------

test('parsePresentFileArgs: formato, tolerâncias e limites', () => {
  assert.deepEqual(
    parsePresentFileArgs({ files: [{ path: ' a.md ', title: ' T ', description: '' }] }),
    { files: [{ path: 'a.md', title: 'T' }] }
  )
  // files como string JSON, item como string, path no topo
  assert.deepEqual(parsePresentFileArgs({ files: '[{"path":"a.md"},"b.png"]' }), {
    files: [{ path: 'a.md' }, { path: 'b.png' }]
  })
  assert.deepEqual(parsePresentFileArgs({ path: 'x.pdf', title: 'X' }), {
    files: [{ path: 'x.pdf', title: 'X' }]
  })
  // repetidos entram uma vez
  assert.equal((parsePresentFileArgs({ files: ['a', 'a', 'b'] }) as any).files.length, 2)
  // títulos/descrições longos são cortados
  const long = parsePresentFileArgs({ files: [{ path: 'a', title: 'x'.repeat(500) }] }) as any
  assert.equal(long.files[0].title.length, PRESENT_FILE_LIMITS.titleMax)
  assert.match((parsePresentFileArgs({}) as any).error, /files/)
  assert.match((parsePresentFileArgs({ files: [] }) as any).error, /ao menos um/)
  assert.match(
    (parsePresentFileArgs({ files: Array.from({ length: 21 }, (_, i) => `f${i}`) }) as any).error,
    /Máximo de 20 arquivos por chamada \(recebidos 21\)/
  )
  assert.match(
    (parsePresentFileArgs({ files: [{ title: 'sem path' }] }) as any).error,
    /files\[0\]/
  )
  assert.match((parsePresentFileArgs({ files: [{ path: 'a\0b' }] }) as any).error, /inválido/)
})

test('presentResultText: curto, com falhas e tudo falhando', () => {
  assert.deepEqual(presentResultText([{ shown: 'a.md' }, { shown: 'b.png' }]), {
    text: 'Apresentado ao usuário: a.md, b.png',
    ok: true
  })
  assert.deepEqual(
    presentResultText([{ shown: 'a.md' }, { shown: 'b.png', error: 'não encontrado' }]),
    {
      text: 'Apresentado ao usuário: a.md (não apresentado: b.png — não encontrado)',
      ok: true
    }
  )
  const all = presentResultText([{ shown: 'b.png', error: 'não encontrado' }])
  assert.equal(all.ok, false)
  assert.equal(all.text, 'Erro: nenhum arquivo apresentado (b.png — não encontrado).')
})

test('presentTitleBlock: as 4 variantes (+ título igual ao nome)', () => {
  const name = 'relatorio.md'
  assert.deepEqual(presentTitleBlock({ name, title: 'Relatório', description: 'Resumo' }), {
    title: 'Relatório',
    description: 'Resumo',
    fileName: name
  })
  assert.deepEqual(presentTitleBlock({ name, description: 'Resumo' }), {
    title: name,
    description: 'Resumo'
  })
  assert.deepEqual(presentTitleBlock({ name, title: 'Relatório' }), {
    title: 'Relatório',
    fileName: name
  })
  assert.deepEqual(presentTitleBlock({ name }), { title: name })
  assert.deepEqual(presentTitleBlock({ name, title: name, description: '  ' }), { title: name })
})

// ---------------- tipo do arquivo ----------------

test('tipo: extensão + bytes (texto × binário, assinatura)', () => {
  const txt = new TextEncoder().encode('olá, mundo\n')
  const nul = new Uint8Array([0x61, 0, 0x62])
  assert.equal(detectViewerKind('a.md', txt), 'markdown')
  assert.equal(detectViewerKind('a.MARKDOWN', txt), 'markdown')
  assert.equal(detectViewerKind('p.html', txt), 'html')
  assert.equal(detectViewerKind('x.ts', txt), 'code')
  assert.equal(detectViewerKind('Makefile', txt), 'code')
  assert.equal(detectViewerKind('LICENSE', txt), 'text')
  assert.equal(detectViewerKind('log.txt', txt), 'text')
  assert.equal(detectViewerKind('x.ts', nul), 'binary') // extensão de código com NUL
  for (const ext of ['png', 'jpg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
    assert.equal(detectViewerKind(`i.${ext}`, txt), 'image', ext)
  assert.equal(detectViewerKind('d.pdf', txt), 'pdf')
  assert.equal(detectViewerKind('d.zip', txt), 'binary')
  assert.equal(detectViewerKind('semext', new Uint8Array(PNG)), 'image') // assinatura PNG
  assert.equal(detectViewerKind('semext', new TextEncoder().encode('%PDF-1.7')), 'pdf')
  assert.equal(detectViewerKind('semext', txt), 'text')
  assert.equal(detectViewerKind('dado.bin2', nul), 'binary')
  assert.equal(kindFromName('arquivo.xyz'), null)
  // UTF-8 inválido (latin-1) → binário; multibyte cortado no fim da amostra → texto
  assert.equal(looksBinary(new Uint8Array([0x61, 0xe9, 0x62])), true)
  assert.equal(looksBinary(new Uint8Array([0x61, 0xc3])), false)
  assert.equal(looksBinary(new TextEncoder().encode('\x1b[31mvermelho\x1b[0m')), false)
  assert.equal(codeLanguage('a.tsx'), 'typescript')
  assert.equal(codeLanguage('a.py'), 'python')
  assert.equal(codeLanguage('a.txt'), undefined)
  // mimes: texto nunca sai como HTML
  assert.equal(viewerMime('markdown', 'a.md'), 'text/plain; charset=utf-8')
  assert.equal(viewerMime('html', 'a.html'), 'text/html; charset=utf-8')
  assert.equal(viewerMime('image', 'a.svg'), 'image/svg+xml')
  assert.equal(viewerMime('image', 'semext', new Uint8Array(PNG)), 'image/png')
  assert.equal(viewerMime('binary', 'a.zip'), 'application/octet-stream')
  // assets: markdown só imagens; HTML imagens + CSS; outros nada
  assert.equal(viewerAssetMime('markdown', 'g.png'), 'image/png')
  assert.equal(viewerAssetMime('markdown', 'x.css'), null)
  assert.equal(viewerAssetMime('markdown', 'x.txt'), null)
  assert.equal(viewerAssetMime('html', 'x.css'), 'text/css; charset=utf-8')
  assert.equal(viewerAssetMime('html', 'x.js'), null)
  assert.equal(viewerAssetMime('pdf', 'g.png'), null)
})

// ---------------- tool ----------------

test('present_file: caminhos como read_file (raiz, confinamento), falhas por arquivo', async () => {
  const r = await presentFileTool(
    {
      files: [
        { path: 'docs/relatorio.md', title: 'Relatório', description: 'O resumo' },
        { path: 'nao-existe.png' },
        { path: 'docs' },
        { path: '../fora/segredo.png' },
        { path: 'link-fora/segredo.png' },
        { path: 'semext' }
      ]
    },
    ctx()
  )
  assert.equal(r.status, 'ok')
  assert.equal(
    r.content,
    'Apresentado ao usuário: docs/relatorio.md, semext (não apresentado: nao-existe.png — não encontrado; docs — é um diretório; ../fora/segredo.png — fora do diretório raiz (acesso negado); link-fora/segredo.png — fora do diretório raiz (acesso negado))'
  )
  const files = r.meta!.presentFiles!.files
  assert.equal(files.length, 6)
  assert.deepEqual(files[0], {
    path: join(ROOT, 'docs', 'relatorio.md'),
    name: 'relatorio.md',
    title: 'Relatório',
    description: 'O resumo',
    size: 30,
    kind: 'markdown'
  })
  assert.equal(files[1].error, 'não encontrado')
  assert.equal(files[2].error, 'é um diretório')
  assert.equal(files[3].error, 'fora do diretório raiz (acesso negado)')
  assert.equal(files[4].error, 'fora do diretório raiz (acesso negado)')
  assert.equal(files[5].kind, 'image')
  // sem confinamento, absolutos/fora da raiz são aceitos (como read_file)
  const free = await presentFileTool(
    { files: [{ path: join(OUT, 'segredo.png') }] },
    ctx({ confine: false })
  )
  assert.equal(free.status, 'ok')
  assert.equal(free.meta!.presentFiles!.files[0].kind, 'image')
  // tudo falhando → erro (o card mostra as falhas)
  const bad = await presentFileTool({ files: ['nada.md'] }, ctx())
  assert.equal(bad.status, 'error')
  assert.match(bad.content, /^Erro: nenhum arquivo apresentado/)
  // argumentos inválidos → erro sem meta
  const inv = await presentFileTool({ files: [] }, ctx())
  assert.equal(inv.status, 'error')
  assert.equal(inv.meta, undefined)
})

test('present_file: na lista de tools, só na sessão principal', () => {
  assert.ok(TOOL_NAMES.includes('present_file'))
  assert.equal(TOOL_DEFINITIONS.present_file.function.parameters.required?.[0], 'files')
  const chat = {
    id: 'c',
    title: 't',
    mainSessionId: 's',
    createdAt: 0,
    updatedAt: 0,
    config: DEFAULT_CHAT_CONFIG('/w', { providerId: 'p', model: 'm', systemPrompt: '' })
  } as Chat
  assert.ok(availableTools(chat, { depth: 0 }).includes('present_file'))
  assert.ok(!availableTools(chat, { depth: 1 }).includes('present_file'))
})

// ---------------- protocolo / allowlist ----------------

test('parseViewerUrl: token + segmentos; recusa travessia e formatos estranhos', () => {
  const tok = 'a'.repeat(32)
  assert.deepEqual(parseViewerUrl(viewerUrl(tok, 'relatório final.md')), {
    token: tok,
    segments: ['relatório final.md']
  })
  assert.deepEqual(parseViewerUrl(`clearchat-file://${tok}/img/g.png?x=1#y`), {
    token: tok,
    segments: ['img', 'g.png']
  })
  for (const bad of [
    `clearchat-file://${tok}/../x.png`,
    `clearchat-file://${tok}/%2e%2e/x.png`,
    `clearchat-file://${tok}/a%2Fb.png`,
    `clearchat-file://${tok}/a%5Cb.png`,
    `clearchat-file://${tok}//x.png`,
    `clearchat-file://${tok}/x%00.png`,
    `clearchat-file://${tok}/%E0%A4%A.png`,
    `clearchat-file://naoehex/x.png`,
    `clearchat-file://${tok}`,
    `clearchat-attachment://${tok}/x.png`,
    42
  ])
    assert.equal(parseViewerUrl(bad), null, String(bad))
})

test('ViewerRegistry: concessão por arquivo, resolve (arquivo/asset), limite', () => {
  let n = 0
  const reg = new ViewerRegistry({ max: 2, newToken: () => String(++n).padStart(32, '0') })
  const md = join(ROOT, 'docs', 'relatorio.md')
  const g = reg.grant(md, 'markdown')
  assert.equal(reg.grant(md, 'markdown').token, g.token) // mesmo arquivo = mesmo token
  assert.deepEqual(reg.resolve(viewerUrl(g.token, 'relatorio.md')), { kind: 'file', grant: g })
  assert.deepEqual(reg.resolve(`clearchat-file://${g.token}/img/g.png`), {
    kind: 'asset',
    grant: g,
    path: join(ROOT, 'docs', 'img', 'g.png'),
    mime: 'image/png'
  })
  assert.deepEqual(reg.resolve(`clearchat-file://${g.token}/img/segredo.txt`), { error: 403 })
  assert.deepEqual(reg.resolve(`clearchat-file://${'f'.repeat(32)}/x.png`), { error: 404 })
  assert.deepEqual(reg.resolve('clearchat-file://x/y'), { error: 400 })
  // PDF não tem assets
  const pdf = reg.grant(join(ROOT, 'd.pdf'), 'pdf')
  assert.deepEqual(reg.resolve(`clearchat-file://${pdf.token}/g.png`), { error: 403 })
  // limite: a mais antiga sai
  reg.grant(join(ROOT, 'outro.txt'), 'text')
  assert.equal(reg.get(g.token), undefined)
  assert.equal(reg.has(md), false)
})

test('serveViewerRequest: mime, nosniff, CSP do HTML, assets confinados, symlinks', async () => {
  const reg = new ViewerRegistry()
  const md = reg.grant(join(ROOT, 'docs', 'relatorio.md'), 'markdown')
  let r = await serveViewerRequest(viewerUrl(md.token, 'relatorio.md'), reg)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await r.text(), '# Relatório\n\n![g](img/g.png)\n')
  // imagem relativa sob a pasta: ok
  r = await serveViewerRequest(`clearchat-file://${md.token}/img/g.png`, reg)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await r.arrayBuffer()).equals(PNG), true)
  // symlink dentro da pasta apontando para fora: recusado
  r = await serveViewerRequest(`clearchat-file://${md.token}/img/atalho.png`, reg)
  assert.equal(r.status, 403)
  // não-imagem: recusado; inexistente: 404
  assert.equal(
    (await serveViewerRequest(`clearchat-file://${md.token}/img/segredo.txt`, reg)).status,
    403
  )
  assert.equal(
    (await serveViewerRequest(`clearchat-file://${md.token}/img/nada.png`, reg)).status,
    404
  )
  // HTML: CSP sem rede
  const html = reg.grant(join(ROOT, 'pagina.html'), 'html')
  r = await serveViewerRequest(viewerUrl(html.token, 'pagina.html'), reg)
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(r.headers.get('content-security-policy'), VIEWER_HTML_CSP)
  assert.match(VIEWER_HTML_CSP, /default-src 'none'/)
  // arquivo trocado por symlink depois da concessão → 404
  const victim = join(TMP, 'vitima.txt')
  writeFileSync(victim, 'ok')
  const vg = reg.grant(victim, 'text')
  rmSync(victim)
  symlinkSync(join(OUT, 'segredo.png'), victim)
  assert.equal((await serveViewerRequest(viewerUrl(vg.token, 'vitima.txt'), reg)).status, 404)
  assert.equal((await serveViewerRequest('clearchat-file://zz/x', reg)).status, 400)
})

// ---------------- abrir / checar ----------------

function fixture(
  rec: PresentFilesRecord,
  opts: {
    local?: { id: string; name: string } | null
    remoteHost?: string | null
    confine?: boolean
  } = {}
): ViewerDeps {
  const chat: Chat = {
    id: 'c1',
    title: 't',
    mainSessionId: 's1',
    createdAt: 0,
    updatedAt: 0,
    config: {
      ...DEFAULT_CHAT_CONFIG(ROOT, { providerId: 'p', model: 'm', systemPrompt: '' }),
      confineToRoot: opts.confine ?? true
    }
  }
  const msg: StoredMessage = {
    id: 'm1',
    sessionId: 's1',
    seq: 1,
    createdAt: 0,
    message: { role: 'tool', tool_call_id: 't1', content: 'ok' },
    meta: { toolStatus: 'ok', presentFiles: rec }
  }
  return {
    chat: (id) => (id === 'c1' ? chat : null),
    message: (id) => (id === 'm1' ? msg : null),
    chatOfSession: (sid) => (sid === 's1' ? 'c1' : null),
    localDevice: () => opts.local ?? null,
    remoteHost: () => opts.remoteHost ?? null
  }
}

const presented = (over: Partial<PresentFilesRecord> = {}): PresentFilesRecord => ({
  files: [
    { path: join(ROOT, 'docs', 'relatorio.md'), name: 'relatorio.md', kind: 'markdown' },
    { path: join(ROOT, 'x.md'), name: 'x.md', error: 'não encontrado' },
    { path: join(ROOT, 'dados.zip'), name: 'dados.zip', kind: 'binary' },
    { path: join(OUT, 'segredo.png'), name: 'segredo.png', kind: 'image' }
  ],
  ...over
})

test('openViewerFile: mensagem real de present_file, outro dispositivo, confinamento', async () => {
  const reg = new ViewerRegistry()
  const deps = fixture(presented())
  const t = (index: number, over: Record<string, unknown> = {}): any => ({
    chatId: 'c1',
    source: 'present',
    messageId: 'm1',
    index,
    ...over
  })
  const ok = await openViewerFile(t(0), deps, reg)
  assert.ok(ok.ok)
  assert.equal(ok.file.kind, 'markdown')
  assert.deepEqual(ok.file.action, { class: 'document' }, 'ações por tipo (fileActions)')
  assert.equal(ok.file.url, viewerUrl(ok.file.token, 'relatorio.md'))
  assert.equal(grantedPath(ok.file.token, reg), join(ROOT, 'docs', 'relatorio.md'))
  // arquivo com erro / índice inexistente / mensagem de outro chat
  assert.deepEqual(((await openViewerFile(t(1), deps, reg)) as any).reason, 'invalid')
  assert.deepEqual(((await openViewerFile(t(9), deps, reg)) as any).reason, 'invalid')
  assert.deepEqual(
    ((await openViewerFile(t(0, { chatId: 'outro' }), deps, reg)) as any).reason,
    'invalid'
  )
  assert.deepEqual(
    ((await openViewerFile(t(0, { messageId: 'mX' }), deps, reg)) as any).reason,
    'invalid'
  )
  // binário: rótulo pelos bytes
  const zip = await openViewerFile(t(2), deps, reg)
  assert.ok(zip.ok)
  assert.equal(zip.file.kind, 'binary')
  assert.match(zip.file.typeLabel, /ZIP/)
  // caminho registrado fora da raiz (sync / confinamento ligado depois) → negado
  assert.equal(((await openViewerFile(t(3), deps, reg)) as any).reason, 'denied')
  // outro dispositivo rodou a tool → "Arquivo no …" sem tocar no disco
  const remote = await openViewerFile(
    t(0),
    fixture(presented({ deviceId: 'd2', deviceName: 'Notebook' }), {
      local: { id: 'd1', name: 'PC' }
    }),
    reg
  )
  assert.deepEqual(remote, {
    ok: false,
    reason: 'remote',
    message: 'Arquivo no Notebook.',
    deviceName: 'Notebook'
  })
  // mesmo dispositivo → abre
  assert.ok(
    (
      await openViewerFile(
        t(0),
        fixture(presented({ deviceId: 'd1' }), { local: { id: 'd1', name: 'PC' } }),
        reg
      )
    ).ok
  )
  // sem deviceId, chat em controle remoto → host
  assert.equal(
    ((await openViewerFile(t(0), fixture(presented(), { remoteHost: 'Desktop' }), reg)) as any)
      .deviceName,
    'Desktop'
  )
  // aba Arquivos: relativo à raiz, fora dela negado, ausente
  assert.ok(
    (await openViewerFile({ chatId: 'c1', source: 'browse', path: 'pagina.html' }, deps, reg)).ok
  )
  assert.equal(
    (
      (await openViewerFile(
        { chatId: 'c1', source: 'browse', path: join(OUT, 'segredo.png') },
        deps,
        reg
      )) as any
    ).reason,
    'denied'
  )
  assert.equal(
    (
      (await openViewerFile(
        { chatId: 'c1', source: 'browse', path: 'link-fora/segredo.png' },
        deps,
        reg
      )) as any
    ).reason,
    'denied'
  )
  assert.equal(
    ((await openViewerFile({ chatId: 'c1', source: 'browse', path: 'nada.txt' }, deps, reg)) as any)
      .reason,
    'missing'
  )
  assert.equal(
    ((await openViewerFile({ chatId: 'c1', source: 'browse', path: 'docs' }, deps, reg)) as any)
      .reason,
    'missing'
  )
  // sem confinamento, fora da raiz abre
  assert.ok(
    (
      await openViewerFile(
        { chatId: 'c1', source: 'browse', path: join(OUT, 'segredo.png') },
        fixture(presented(), { confine: false }),
        reg
      )
    ).ok
  )
  assert.equal(
    ((await openViewerFile({ chatId: 'zz', source: 'browse', path: 'a' }, deps, reg)) as any)
      .reason,
    'invalid'
  )
  assert.equal(((await openViewerFile(null as any, deps, reg)) as any).reason, 'invalid')
  assert.throws(() => grantedPath('f'.repeat(32), reg), /não disponível/)
})

test('checkPresented: estado por arquivo (cards)', async () => {
  assert.deepEqual(await checkPresented('c1', 'm1', fixture(presented())), [
    { ok: true },
    { ok: false, reason: 'invalid' },
    { ok: true },
    { ok: false, reason: 'denied' }
  ])
  const rem = await checkPresented(
    'c1',
    'm1',
    fixture(presented({ deviceId: 'd2', deviceName: 'Notebook' }), {
      local: { id: 'd1', name: 'PC' }
    })
  )
  assert.deepEqual(rem[0], { ok: false, reason: 'remote', deviceName: 'Notebook' })
  assert.deepEqual(await checkPresented('outro', 'm1', fixture(presented())), [])
})

test('readViewerText: teto de 5 MB com aviso; registerPresented concede e anota o dispositivo', async () => {
  const reg = new ViewerRegistry()
  const big = join(ROOT, 'grande.log')
  writeFileSync(big, 'á'.repeat(VIEWER_LIMITS.textMaxBytes / 2 + 10)) // 2 bytes por caractere
  const g = reg.grant(big, 'text')
  const t = await readViewerText(g.token, reg)
  assert.equal(t.truncated, true)
  assert.equal(t.size, VIEWER_LIMITS.textMaxBytes + 20)
  assert.ok(!t.content.includes('�'))
  const small = await readViewerText(
    reg.grant(join(ROOT, 'docs', 'relatorio.md'), 'markdown').token,
    reg
  )
  assert.deepEqual(small, {
    content: '# Relatório\n\n![g](img/g.png)\n',
    truncated: false,
    size: 30
  })
  await assert.rejects(readViewerText('0'.repeat(32), reg), /não disponível/)

  const reg2 = new ViewerRegistry()
  const rec = await registerPresented(presented(), { id: 'd1', name: 'PC' }, reg2)
  assert.equal(rec.deviceId, 'd1')
  assert.equal(rec.deviceName, 'PC')
  assert.ok(reg2.has(join(ROOT, 'docs', 'relatorio.md')))
  assert.ok(!reg2.has(join(ROOT, 'x.md'))) // com erro: não concede
  assert.deepEqual(await registerPresented({ files: [] }, null, reg2), { files: [] })
})

// ---------------- vídeo (prévia no painel) ----------------

const ftyp = (brand: string): Uint8Array =>
  Uint8Array.from([0, 0, 0, 0x18, ...Buffer.from('ftyp' + brand), 0, 0, 2, 0])

test('vídeo: extensão, assinatura (ftyp/EBML, fora HEIF/AVIF), mime e rótulo', () => {
  for (const n of ['a.mp4', 'a.M4V', 'a.webm', 'a.ogv', 'a.mov', 'a.mkv'])
    assert.equal(kindFromName(n), 'video', n)
  for (const n of ['a.avi', 'a.wmv', 'a.flv', 'a.3gp']) assert.equal(kindFromName(n), 'binary', n)
  assert.equal(detectViewerKind('gravacao.mp4', new Uint8Array([0, 1, 2, 0xff])), 'video')
  assert.deepEqual(sniffMagic(ftyp('isom')), { kind: 'video', ext: 'mp4' })
  assert.deepEqual(sniffMagic(ftyp('qt  ')), { kind: 'video', ext: 'mov' })
  assert.equal(sniffMagic(ftyp('heic')), null)
  assert.equal(sniffMagic(ftyp('avif')), null)
  const ebml = (doc: string): Uint8Array =>
    Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...Buffer.from(doc)])
  assert.deepEqual(sniffMagic(ebml('webm')), { kind: 'video', ext: 'webm' })
  assert.deepEqual(sniffMagic(ebml('matroska')), { kind: 'video', ext: 'mkv' })
  assert.equal(detectViewerKind('sem-extensao', ftyp('mp42')), 'video')
  assert.equal(viewerMime('video', 'a.webm'), 'video/webm')
  assert.equal(viewerMime('video', 'a.mov'), 'video/quicktime')
  assert.equal(viewerMime('video', 'gravacao', ebml('webm')), 'video/webm')
  assert.equal(viewerMime('video', 'gravacao'), 'video/mp4')
})

test('parseByteRange: a-b, a-, -n, fora do arquivo, inválido / vários intervalos', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseByteRange('bytes=500-', 1000), { start: 500, end: 999 })
  assert.deepEqual(parseByteRange('bytes=900-5000', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseByteRange('bytes=-5000', 1000), { start: 0, end: 999 })
  assert.equal(parseByteRange('bytes=1000-', 1000), 'unsatisfiable')
  assert.equal(parseByteRange('bytes=50-10', 1000), 'unsatisfiable')
  assert.equal(parseByteRange('bytes=-0', 1000), 'unsatisfiable')
  assert.equal(parseByteRange('bytes=0-', 0), 'unsatisfiable')
  assert.equal(parseByteRange(null, 1000), null)
  assert.equal(parseByteRange('bytes=-', 1000), null)
  assert.equal(parseByteRange('bytes=0-1,5-9', 1000), null)
  assert.equal(parseByteRange('items=0-1', 1000), null)
})

test('serveViewerRequest: Range → 206/416 e vídeo acima do teto dos outros tipos', async () => {
  const reg = new ViewerRegistry()
  const bytes = Buffer.alloc(4096)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  const path = join(ROOT, 'clipe.mp4')
  writeFileSync(path, bytes)
  const g = reg.grant(path, 'video')
  const url = viewerUrl(g.token, 'clipe.mp4')
  let r = await serveViewerRequest(url, reg)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'video/mp4')
  assert.equal(r.headers.get('accept-ranges'), 'bytes')
  assert.equal(r.headers.get('content-length'), '4096')
  r = await serveViewerRequest(url, reg, 'bytes=100-199')
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/4096')
  assert.equal(r.headers.get('content-length'), '100')
  assert.equal(Buffer.from(await r.arrayBuffer()).equals(bytes.subarray(100, 200)), true)
  r = await serveViewerRequest(url, reg, 'bytes=4000-')
  assert.equal(r.status, 206)
  assert.equal(Buffer.from(await r.arrayBuffer()).equals(bytes.subarray(4000)), true)
  r = await serveViewerRequest(url, reg, 'bytes=9000-')
  assert.equal(r.status, 416)
  assert.equal(r.headers.get('content-range'), 'bytes */4096')
  // acima do teto (arquivo esparso, sem gravar 200 MB): vídeo serve aos pedaços, imagem 413
  const big = join(TMP, 'grande.mp4')
  writeFileSync(big, '')
  truncateSync(big, VIEWER_LIMITS.binaryMaxBytes + 1)
  const bigVideo = reg.grant(big, 'video')
  r = await serveViewerRequest(viewerUrl(bigVideo.token, 'grande.mp4'), reg, 'bytes=0-15')
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), `bytes 0-15/${VIEWER_LIMITS.binaryMaxBytes + 1}`)
  assert.equal((await r.arrayBuffer()).byteLength, 16)
  const bigPng = join(TMP, 'grande.png')
  writeFileSync(bigPng, '')
  truncateSync(bigPng, VIEWER_LIMITS.binaryMaxBytes + 1)
  const bigImage = reg.grant(bigPng, 'image')
  assert.equal((await serveViewerRequest(viewerUrl(bigImage.token, 'grande.png'), reg)).status, 413)
  // os outros tipos também aceitam Range (PDF do Chromium pede aos pedaços)
  const md = reg.grant(join(ROOT, 'docs', 'relatorio.md'), 'markdown')
  r = await serveViewerRequest(viewerUrl(md.token, 'relatorio.md'), reg, 'bytes=0-1')
  assert.equal(r.status, 206)
  assert.equal(await r.text(), '# ')
})
