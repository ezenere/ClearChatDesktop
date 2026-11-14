// Renomear / excluir arquivos e pastas pela aba Arquivos do chat (menu de contexto). Mesmas regras
// de confinamento das tools de arquivo: com "Confinar à raiz" (padrão), a ENTRADA (o próprio link,
// não o alvo — pasta-mãe pelo realpath + nome) e o destino precisam ficar dentro da raiz; a raiz em
// si, a raiz do sistema e a home nunca. Excluir = lixeira do sistema quando o Electron oferece
// `shell.trashItem` (o chamador injeta), senão apaga de vez. Sem Electron aqui (testável).
// Ver SPEC.md → "Aba Arquivos → Renomear e excluir".
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, parse, resolve } from 'path'
import { isInside, realpathDeep, resolvePath } from './tools/util'

export interface FileOpsChat {
  config: { cwd: string; confineToRoot?: boolean }
}

/** Nome novo válido (um segmento): sem barras, NUL, `.`/`..`, vazio ou > 255. */
export function validEntryName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const n = name.trim()
  // eslint-disable-next-line no-control-regex
  if (!n || n === '.' || n === '..' || n.length > 255 || /[/\\\u0000]/.test(n)) return null
  return n
}

/** Caminho da entrada (absoluto) depois das checagens: confinamento e caminhos proibidos. */
async function entryPath(chat: FileOpsChat, path: unknown): Promise<string> {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0'))
    throw new Error('Caminho inválido.')
  const root = resolve(chat.config.cwd)
  const abs = resolvePath(root, path)
  const fsRoot = parse(abs).root
  if (abs === root || abs === fsRoot || abs === resolve(homedir()))
    throw new Error('Esta pasta não pode ser alterada por aqui.')
  if (chat.config.confineToRoot !== false) {
    // o próprio link conta (não o alvo): pasta-mãe pelo realpath + o nome
    const rootReal = await realpathDeep(root)
    const real = join(await realpathDeep(dirname(abs)), basename(abs))
    if (!isInside(rootReal, real) || real === rootReal)
      throw new Error('Acesso negado: fora do diretório raiz do chat.')
  }
  try {
    await fs.lstat(abs)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new Error('Arquivo não encontrado.', { cause: e })
    throw e
  }
  return abs
}

const fsError = (e: unknown, what: string): Error => {
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'EACCES' || code === 'EPERM')
    return new Error(`Sem permissão para ${what}.`, { cause: e })
  if (code === 'EBUSY') return new Error(`Em uso — não foi possível ${what}.`, { cause: e })
  return e instanceof Error ? e : new Error(String(e))
}

/** Renomeia (mesma pasta) e devolve o caminho novo. Já existe → erro legível (nunca sobrescreve). */
export async function renameEntry(
  chat: FileOpsChat,
  path: unknown,
  newName: unknown
): Promise<string> {
  const name = validEntryName(newName)
  if (!name) throw new Error('Nome inválido (sem barras; nem "." nem "..").')
  const abs = await entryPath(chat, path)
  const dest = join(dirname(abs), name)
  if (dest === abs) return abs
  // troca só de maiúsculas/minúsculas num sistema que não diferencia: o "destino" é o próprio
  const same = basename(abs).toLowerCase() === name.toLowerCase()
  try {
    await fs.lstat(dest)
    if (!same) throw new Error(`Já existe "${name}" nesta pasta.`)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw e
  }
  try {
    await fs.rename(abs, dest)
  } catch (e) {
    throw fsError(e, 'renomear')
  }
  return dest
}

/**
 * Exclui: com `trash` (shell.trashItem), vai para a lixeira (`'trash'`); sem, apaga de vez
 * (`'deleted'`; pasta com o conteúdo). Erro da lixeira volta legível (nunca apaga de vez no lugar).
 */
export async function deleteEntry(
  chat: FileOpsChat,
  path: unknown,
  trash?: ((p: string) => Promise<void>) | null
): Promise<'trash' | 'deleted'> {
  const abs = await entryPath(chat, path)
  if (trash) {
    try {
      await trash(abs)
    } catch (e) {
      throw new Error(
        `Não foi possível mover para a lixeira: ${(e as Error).message ?? String(e)}`,
        { cause: e }
      )
    }
    return 'trash'
  }
  try {
    await fs.rm(abs, { recursive: true, force: false })
  } catch (e) {
    throw fsError(e, 'excluir')
  }
  return 'deleted'
}
