// Índice da raiz do chat para o popup de `@` do composer (menções de caminho): caminhos relativos
// com `/`, pastas com `/` no fim. Mesmas regras de ignorar do find_files: ripgrep (`--files
// --hidden`, respeita o .gitignore dentro de um repositório git) sem `.git` e `node_modules`; sem
// ripgrep, um walker em largura que pula `.git`, `node_modules` e links simbólicos. Limitado a
// INDEX_MAX_FILES arquivos (`truncated`); cache curto por raiz (o popup reabre muito). O filtro é
// puro, no renderer (@shared/pathMentions → filterMentionIndex). Ver SPEC.md → "Menções @caminho".
import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { ripgrepAvailable, runRg } from './tools/search'

export const INDEX_MAX_FILES = 20_000
const CACHE_MS = 10_000
const SKIP = new Set(['.git', 'node_modules'])

export interface FileIndex {
  entries: string[]
  truncated: boolean
}

const cache = new Map<string, { at: number; index: Promise<FileIndex> }>()

/** Pastas de cada arquivo (`a/b/c.txt` → `a/`, `a/b/`) + os arquivos, ordenados. */
export function withFolders(files: string[]): string[] {
  const dirs = new Set<string>()
  for (const f of files) {
    let i = f.indexOf('/')
    while (i > 0) {
      dirs.add(f.slice(0, i + 1))
      i = f.indexOf('/', i + 1)
    }
  }
  return [...dirs, ...files].sort((a, b) => a.localeCompare(b))
}

async function walk(root: string, cap: number): Promise<FileIndex> {
  const files: string[] = []
  const dirs: string[] = []
  let queue: string[] = ['']
  let truncated = false
  while (queue.length && !truncated) {
    const next: string[] = []
    for (const rel of queue) {
      let dirents
      try {
        dirents = await fs.readdir(join(root, rel), { withFileTypes: true })
      } catch {
        continue
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name))
      for (const d of dirents) {
        if (d.isSymbolicLink()) continue
        const p = rel ? `${rel}/${d.name}` : d.name
        if (d.isDirectory()) {
          if (SKIP.has(d.name)) continue
          dirs.push(`${p}/`)
          next.push(p)
        } else if (d.isFile()) {
          if (files.length >= cap) {
            truncated = true
            break
          }
          files.push(p)
        }
      }
      if (truncated) break
    }
    queue = next
  }
  return { entries: [...dirs, ...files].sort((a, b) => a.localeCompare(b)), truncated }
}

async function build(root: string, cap: number): Promise<FileIndex> {
  if (ripgrepAvailable()) {
    try {
      const ctl = new AbortController()
      const r = await runRg(
        ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'],
        root,
        cap,
        ctl.signal
      )
      if (r.code !== 2 || r.lines.length) {
        const files = r.lines.map((l) => l.replace(/^\.\//, '').replace(/\\/g, '/')).filter(Boolean)
        return { entries: withFolders(files), truncated: r.capped }
      }
    } catch {
      /* rg falhou: walker em JS */
    }
  }
  return walk(root, cap)
}

/** Índice da raiz `root` (cache de 10 s; `fresh` ignora o cache). */
export function chatFileIndex(
  root: string,
  opts: { fresh?: boolean; cap?: number } = {}
): Promise<FileIndex> {
  const key = resolve(root)
  const hit = cache.get(key)
  if (hit && !opts.fresh && Date.now() - hit.at < CACHE_MS) return hit.index
  const index = build(key, opts.cap ?? INDEX_MAX_FILES).catch((e) => {
    cache.delete(key)
    throw e
  })
  cache.set(key, { at: Date.now(), index })
  return index
}
