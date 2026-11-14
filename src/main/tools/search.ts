// search_files (regex no conteúdo) e find_files (glob no nome). Usa ripgrep se disponível; senão um
// walker em JS (pula .git, node_modules, binários e links simbólicos). Saídas sempre limitadas.
import { spawn, spawnSync } from 'child_process'
import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import { LIMITS } from '@shared/limits'
import {
  abortError,
  displayPath,
  fail,
  fmtNum,
  isBinary,
  ok,
  optBool,
  optNumber,
  optString,
  requireString,
  resolveReadPath,
  resolveToolPath,
  ToolError,
  type ToolContext,
  type ToolResult
} from './util'

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const MAX_FILE_BYTES = 5 * 1024 * 1024
const FIND_SCAN_CAP = 10_000

let rgCache: boolean | null = null
export function ripgrepAvailable(): boolean {
  if (rgCache === null) {
    try {
      rgCache = spawnSync('rg', ['--version']).status === 0
    } catch {
      rgCache = false
    }
  }
  return rgCache
}
/** Só para testes: força o fallback em JS. */
export function _setRipgrep(v: boolean | null): void {
  rgCache = v
}

/** Glob → RegExp (`**`, `*`, `?`, `{a,b}`, `[…]`). Sem `/` no glob, casa com o nome do arquivo. */
export function globToRegExp(glob: string): { re: RegExp; basename: boolean } {
  const g = glob.trim().replace(/^\.\//, '')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++
        if (g[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = g.indexOf('}', i)
      if (end === -1) re += '\\{'
      else {
        re += `(?:${g
          .slice(i + 1, end)
          .split(',')
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
          .join('|')})`
        i = end
      }
    } else if (c === '[') {
      const end = g.indexOf(']', i)
      if (end === -1) re += '\\['
      else {
        re += g.slice(i, end + 1)
        i = end
      }
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&')
  }
  return { re: new RegExp(`^${re}$`), basename: !g.includes('/') }
}

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'))

async function* walk(dir: string, signal: AbortSignal): AsyncGenerator<string> {
  let dirents
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  dirents.sort((a, b) => a.name.localeCompare(b.name))
  for (const d of dirents) {
    if (signal.aborted) throw abortError()
    if (d.isSymbolicLink()) continue // não segue links (evita escapar do raiz e laços)
    const p = join(dir, d.name)
    if (d.isDirectory()) {
      if (!SKIP_DIRS.has(d.name)) yield* walk(p, signal)
    } else if (d.isFile()) yield p
  }
}

/** Executa rg e coleta até `cap` linhas de stdout (mata o processo ao atingir). */
export function runRg(
  argv: string[],
  cwd: string,
  cap: number,
  signal: AbortSignal
): Promise<{ lines: string[]; capped: boolean; code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines: string[] = []
    let buf = ''
    let stderr = ''
    let capped = false
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      if (capped) return
      buf += d.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (lines.length >= cap) {
          capped = true
          child.kill('SIGKILL')
          return
        }
        lines.push(line)
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(abortError())
      if (!capped && buf && lines.length < cap) lines.push(buf)
      else if (!capped && buf) capped = true
      resolve({ lines, capped, code, stderr })
    })
  })
}

const clipLine = (s: string): string =>
  s.length > LIMITS.searchMaxLineChars
    ? `${s.slice(0, LIMITS.searchMaxLineChars)} [… linha cortada]`
    : s

/**
 * Onde rodar o rg: dentro da pasta-alvo (globs com "/" valem relativos a ela) e com que prefixo
 * reescrever os caminhos para ficarem relativos ao diretório raiz. Alvo arquivo: roda no pai.
 */
async function rgPlace(
  root: string,
  target: string
): Promise<{ cwd: string; args: string[]; prefix: string }> {
  const st = await fs.stat(target)
  if (st.isDirectory()) {
    const rel = toPosix(displayPath(root, target))
    return { cwd: target, args: [], prefix: rel === '.' ? '' : `${rel}/` }
  }
  const dir = join(target, '..')
  const rel = toPosix(displayPath(root, dir))
  return { cwd: dir, args: [relative(dir, target)], prefix: rel === '.' ? '' : `${rel}/` }
}

export async function searchFiles(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const pattern = requireString(args, 'pattern')
  // como read_file: também alcança as saídas salvas deste chat (arquivos) mesmo com confinação
  const target = await resolveReadPath(ctx, optString(args, 'path'))
  const glob = optString(args, 'glob')
  const ci = optBool(args, 'case_insensitive')
  const maxResults = Math.min(
    LIMITS.searchMaxResults,
    Math.max(1, Math.floor(optNumber(args, 'max_results') ?? LIMITS.searchDefaultResults))
  )
  const root = ctx.cwd
  let results: string[] = []
  let capped = false

  if (ripgrepAvailable()) {
    const place = await rgPlace(root, target)
    const argv = [
      '--line-number',
      '--no-heading',
      '--with-filename',
      '--color',
      'never',
      '--hidden',
      '--max-filesize',
      '5M',
      '--max-columns',
      String(LIMITS.searchMaxLineChars),
      '--max-columns-preview',
      ...(ci ? ['-i'] : []),
      // globs posteriores têm precedência no rg: o do modelo primeiro, exclusões por último
      ...(glob ? ['-g', glob] : []),
      '-g',
      '!.git',
      '-g',
      '!node_modules',
      '-e',
      pattern,
      '--',
      ...place.args
    ]
    const r = await runRg(argv, place.cwd, maxResults, ctx.signal)
    if (r.code === 2 && r.lines.length === 0 && !/No files were searched/i.test(r.stderr)) {
      return fail(`Erro no search_files: ${r.stderr.trim().slice(0, 1500) || 'ripgrep falhou'}`)
    }
    results = r.lines.map((l) => clipLine(place.prefix + l.replace(/^\.\//, '')))
    capped = r.capped
  } else {
    let re: RegExp
    try {
      re = new RegExp(pattern, ci ? 'i' : '')
    } catch (e) {
      throw new ToolError(`Expressão regular inválida: ${(e as Error).message}`)
    }
    const g = glob ? globToRegExp(glob) : null
    const st = await fs.stat(target)
    const files = st.isFile() ? [target] : walk(target, ctx.signal)
    outer: for await (const f of files as AsyncIterable<string>) {
      const rel = toPosix(displayPath(root, f))
      if (g) {
        const subject = g.basename ? (rel.split('/').pop() ?? rel) : toPosix(relative(target, f))
        if (!g.re.test(subject)) continue
      }
      let buf: Buffer
      try {
        const s = await fs.stat(f)
        if (s.size > MAX_FILE_BYTES) continue
        buf = await fs.readFile(f)
      } catch {
        continue
      }
      if (isBinary(buf)) continue
      const lines = buf.toString('utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          if (results.length >= maxResults) {
            capped = true
            break outer
          }
          results.push(clipLine(`${rel}:${i + 1}:${lines[i]}`))
        }
      }
    }
  }

  const where = `${glob ? ` (glob ${glob})` : ''}${target !== root ? ` em ${displayPath(root, target)}` : ''}`
  if (!results.length) return ok(`Nenhum resultado para /${pattern}/${where}.`)
  const head = capped
    ? `[${fmtNum(results.length)} resultados para /${pattern}/${where} — limite atingido; há mais. Refine o padrão, use path/glob ou aumente max_results (máx. ${LIMITS.searchMaxResults}).]`
    : `[${fmtNum(results.length)} resultado(s) para /${pattern}/${where}]`
  return ok(`${head}\n${results.join('\n')}`)
}

export async function findFiles(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const glob = requireString(args, 'glob').trim()
  const target = await resolveToolPath(ctx, optString(args, 'path'))
  const root = ctx.cwd
  let found: string[] = []
  let capped = false

  if (ripgrepAvailable()) {
    const place = await rgPlace(root, target)
    const argv = [
      '--files',
      '--hidden',
      '--sort',
      'path',
      '-g',
      glob,
      '-g',
      '!.git',
      '-g',
      '!node_modules',
      ...place.args
    ]
    const r = await runRg(argv, place.cwd, FIND_SCAN_CAP, ctx.signal)
    if (r.code === 2 && r.lines.length === 0 && !/No files were searched/i.test(r.stderr)) {
      return fail(`Erro no find_files: ${r.stderr.trim().slice(0, 1500) || 'ripgrep falhou'}`)
    }
    found = r.lines
      .map((l) => place.prefix + l.replace(/^\.\//, ''))
      .filter((l) => l !== place.prefix)
    capped = r.capped
  } else {
    const g = globToRegExp(glob)
    for await (const f of walk(target, ctx.signal)) {
      const subject = g.basename ? (f.split(sep).pop() ?? f) : toPosix(relative(target, f))
      if (!g.re.test(subject)) continue
      if (found.length >= FIND_SCAN_CAP) {
        capped = true
        break
      }
      found.push(toPosix(displayPath(root, f)))
    }
    found.sort()
  }

  const where = target !== root ? ` em ${displayPath(root, target)}` : ''
  if (!found.length) return ok(`Nenhum arquivo casa com "${glob}"${where}.`)
  const max = LIMITS.findMaxResults
  const shown = found.slice(0, max)
  const total = capped ? `${fmtNum(found.length)}+` : fmtNum(found.length)
  let out = `[${total} arquivo(s) para "${glob}"${where}${found.length > max ? ` — mostrando ${max}` : ''}]\n${shown.join('\n')}`
  if (found.length > max)
    out += `\n[… mais ${capped ? `${fmtNum(found.length - max)}+` : fmtNum(found.length - max)} omitidos — refine o glob ou use path]`
  return ok(out)
}
