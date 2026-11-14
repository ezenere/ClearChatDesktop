// Aba Arquivos → Renomear / Excluir (src/main/fileOps.ts) e o índice da raiz do popup de `@`
// (src/main/fileIndex.ts): confinamento como as tools de arquivo (link para fora conta pelo
// próprio link; destino nunca fora), nomes inválidos, "já existe" sem sobrescrever, raiz/home
// protegidas, lixeira injetada (erro legível, nunca apaga de vez no lugar) e o índice com pastas
// derivadas, sem .git/node_modules, com o teto.
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteEntry, renameEntry, validEntryName } from '../src/main/fileOps.ts'
import { chatFileIndex, withFolders } from '../src/main/fileIndex.ts'
import { _setRipgrep, ripgrepAvailable } from '../src/main/tools/search.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-fileops-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

function fixture(name: string): { root: string; outside: string } {
  const root = join(TMP, name, 'root')
  const outside = join(TMP, name, 'fora')
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'A')
  writeFileSync(join(root, 'src', 'b.ts'), 'B')
  writeFileSync(join(root, 'src', 'deep', 'c.md'), 'C')
  writeFileSync(join(outside, 'segredo.txt'), 'S')
  symlinkSync(outside, join(root, 'link-fora'))
  return { root, outside }
}

test('validEntryName', () => {
  assert.equal(validEntryName(' novo.txt '), 'novo.txt')
  for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', 'a\u0000', 'x'.repeat(256), 3, null])
    assert.equal(validEntryName(bad as never), null, String(bad))
})

test('renomear: mesma pasta, caminho novo; relativo à raiz; nunca sobrescreve', async () => {
  const { root } = fixture('ren')
  const chat = { config: { cwd: root } }
  const to = await renameEntry(chat, join(root, 'a.txt'), 'renomeado.txt')
  assert.equal(to, join(root, 'renomeado.txt'))
  assert.equal(readFileSync(to, 'utf8'), 'A')
  assert.ok(!existsSync(join(root, 'a.txt')))
  // relativo à raiz + pasta
  assert.equal(await renameEntry(chat, 'src/deep', 'fundo'), join(root, 'src', 'fundo'))
  assert.ok(existsSync(join(root, 'src', 'fundo', 'c.md')))
  // já existe
  await assert.rejects(renameEntry(chat, 'renomeado.txt', 'src'), /Já existe "src"/)
  // nomes inválidos / inexistente
  await assert.rejects(renameEntry(chat, 'renomeado.txt', '../fora.txt'), /Nome inválido/)
  await assert.rejects(renameEntry(chat, 'nada.txt', 'x'), /não encontrado/)
})

test('confinado: fora da raiz, pelo link para fora e a própria raiz são recusados', async () => {
  const { root, outside } = fixture('conf')
  const chat = { config: { cwd: root } }
  await assert.rejects(
    renameEntry(chat, join(outside, 'segredo.txt'), 'x.txt'),
    /fora do diretório raiz/
  )
  await assert.rejects(deleteEntry(chat, '../fora/segredo.txt'), /fora do diretório raiz/)
  // arquivo DENTRO do alvo de um link que aponta para fora
  await assert.rejects(deleteEntry(chat, 'link-fora/segredo.txt'), /fora do diretório raiz/)
  await assert.rejects(deleteEntry(chat, root), /não pode ser alterada/)
  await assert.rejects(deleteEntry(chat, '.'), /não pode ser alterada/)
  assert.ok(existsSync(join(outside, 'segredo.txt')))
  // o próprio link (dentro da raiz) pode ser excluído — só o link, o alvo fica
  assert.equal(await deleteEntry(chat, 'link-fora', null), 'deleted')
  assert.ok(!existsSync(join(root, 'link-fora')) && existsSync(join(outside, 'segredo.txt')))
  // sem confinamento: fora da raiz vale (como a aba Arquivos navega)
  const free = { config: { cwd: root, confineToRoot: false } }
  assert.equal(
    await renameEntry(free, join(outside, 'segredo.txt'), 'livre.txt'),
    join(outside, 'livre.txt')
  )
})

test('excluir: lixeira injetada; erro dela volta legível sem apagar; sem lixeira apaga (pasta inteira)', async () => {
  const { root } = fixture('del')
  const chat = { config: { cwd: root } }
  const trashed: string[] = []
  assert.equal(
    await deleteEntry(chat, 'a.txt', async (p) => {
      trashed.push(p)
    }),
    'trash'
  )
  assert.deepEqual(trashed, [join(root, 'a.txt')])
  await assert.rejects(
    deleteEntry(chat, 'src/b.ts', async () => {
      throw new Error('sem lixeira')
    }),
    /Não foi possível mover para a lixeira: sem lixeira/
  )
  assert.ok(existsSync(join(root, 'src', 'b.ts')), 'erro da lixeira não apaga')
  assert.equal(await deleteEntry(chat, 'src', null), 'deleted')
  assert.ok(!existsSync(join(root, 'src')))
})

test('índice da raiz: pastas derivadas, sem .git/node_modules (walker e ripgrep), teto', async () => {
  const root = join(TMP, 'idx')
  mkdirSync(join(root, 'src', 'ui'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(root, 'docs com espaço'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '')
  writeFileSync(join(root, '.env'), '')
  writeFileSync(join(root, 'src', 'app.ts'), '')
  writeFileSync(join(root, 'src', 'ui', 'Button.tsx'), '')
  writeFileSync(join(root, 'docs com espaço', 'guia.md'), '')
  writeFileSync(join(root, '.git', 'HEAD'), '')
  writeFileSync(join(root, 'node_modules', 'x', 'i.js'), '')
  const want = [
    '.env',
    'docs com espaço/',
    'docs com espaço/guia.md',
    'README.md',
    'src/',
    'src/app.ts',
    'src/ui/',
    'src/ui/Button.tsx'
  ].sort((a, b) => a.localeCompare(b))
  try {
    _setRipgrep(false)
    const js = await chatFileIndex(root, { fresh: true })
    assert.deepEqual(js.entries, want)
    assert.equal(js.truncated, false)
    const capped = await chatFileIndex(root, { fresh: true, cap: 2 })
    assert.equal(capped.truncated, true)
    _setRipgrep(null)
    const rg = await chatFileIndex(root, { fresh: true })
    assert.deepEqual(rg.entries, want, 'ripgrep (ou o walker, sem rg) dá o mesmo índice')
  } finally {
    _setRipgrep(null)
  }
  assert.deepEqual(withFolders(['a/b/c.txt', 'z.md']), ['a/', 'a/b/', 'a/b/c.txt', 'z.md'])
})

test('índice com ripgrep: respeita o .gitignore dentro de um repositório git (como o find_files)', async (t) => {
  if (!ripgrepAvailable()) return t.skip('ripgrep ausente')
  const root = join(TMP, 'idx-git')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'build/\n*.log\n')
  writeFileSync(join(root, 'keep.ts'), '')
  writeFileSync(join(root, 'debug.log'), '')
  writeFileSync(join(root, 'build', 'out.js'), '')
  const r = await chatFileIndex(root, { fresh: true })
  assert.deepEqual(r.entries, ['.gitignore', 'keep.ts'])
})
