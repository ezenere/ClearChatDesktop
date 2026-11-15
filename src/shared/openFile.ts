// Arquivo selecionado na mensagem do usuário (protocolo 1.13.0, docs/SYNC_PROTOCOL.md §4.3.8 —
// "Arquivo selecionado"). Partes PURAS, compartilhadas por main, renderer, testes e o app mobile
// (vendorado): o texto fixo que o host acrescenta à mensagem enviada ao modelo, a normalização do
// caminho (relativo à raiz do chat quando está dentro dela, senão absoluto; ≤ 1024 caracteres) e a
// montagem da mensagem como vai na request. O `content` gravado continua sendo só o texto do
// usuário; o texto fixo só existe na CÓPIA enviada (e é mostrado na UI — nada escondido).
// Ver SPEC.md → "Arquivo selecionado".
import type { ApiMessage, MessageMeta, StoredMessage } from './types'

/** Teto do `path` (protocolo): acima disso o campo é descartado (nunca cortado — viraria outro arquivo). */
export const OPEN_FILE_PATH_MAX = 1024

/** `MessageMeta.openFile` (desde 1.13.0): o arquivo que o usuário tinha selecionado ao enviar. */
export interface OpenFileMeta {
  path: string
}

/**
 * Texto EXATO que vai ao modelo depois do conteúdo do usuário (parte de texto separada; num
 * `content` em texto, depois de uma linha em branco).
 */
export function openFileText(path: string): string {
  return `O usuário está com o arquivo ${path} selecionado; ele pode ou não estar relacionado a esta mensagem.`
}

// ---------------- caminhos ----------------

/** Caminho absoluto (POSIX `/…`, Windows `C:\…`/`C:/…` ou UNC `\\…`). */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p)
}

/** Caminho no estilo do Windows (letra de unidade ou UNC): separadores `\` e `/`, sem caixa. */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith('\\\\')
}

interface PathParts {
  /** `/` (POSIX), `C:\` (unidade) ou `\\` (UNC); '' = relativo. */
  head: string
  segs: string[]
}

/** Separa em raiz + segmentos, resolvendo `.` e `..` (nunca sobe acima da raiz de um absoluto). */
function partsOf(p: string, win: boolean): PathParts {
  let head = ''
  let rest = p
  if (win) {
    const m = /^([A-Za-z]:)(?:[\\/]|$)/.exec(p)
    if (m) {
      head = `${m[1]}\\`
      rest = p.slice(m[0].length)
    } else if (p.startsWith('\\\\')) {
      head = '\\\\'
      rest = p.slice(2)
    }
  } else if (p.startsWith('/')) {
    head = '/'
    rest = p.slice(1)
  }
  const segs: string[] = []
  for (const s of rest.split(win ? /[\\/]+/ : /\/+/)) {
    if (!s || s === '.') continue
    if (s === '..') {
      if (segs.length && segs[segs.length - 1] !== '..') segs.pop()
      else if (!head) segs.push('..')
      continue
    }
    segs.push(s)
  }
  return { head, segs }
}

const same = (a: string, b: string, win: boolean): boolean =>
  win ? a.toLowerCase() === b.toLowerCase() : a === b

/** `ap` é `rp` ou está abaixo dele (mesma raiz, segmentos de `rp` como prefixo). */
const under = (ap: PathParts, rp: PathParts, win: boolean): boolean =>
  same(ap.head, rp.head, win) &&
  ap.segs.length >= rp.segs.length &&
  rp.segs.every((s, i) => same(s, ap.segs[i], win))

/**
 * `p` é a própria `root` ou está dentro dela? Vale para POSIX e Windows (o estilo vem da raiz:
 * `\` e `/` como separador, sem caixa), com barras repetidas/finais e `.`/`..` resolvidos. Sem
 * expandir `~` (quem chama expande). Vazio → false.
 */
export function isPathInside(p: string, root: string): boolean {
  if (!p || !root) return false
  const win = isWindowsPath(root)
  return under(partsOf(p, win), partsOf(root, win), win)
}

/** Raiz (`/`, `C:\`, `\\` ou '' se relativo) e segmentos de um caminho POSIX ou Windows. */
export function pathSegments(p: string): { head: string; segs: string[] } {
  return partsOf(p, isWindowsPath(p))
}

/** `dir` + `name` com o separador do sistema de `dir` (Windows: `\`). */
export function joinPath(dir: string, name: string): string {
  const win = isWindowsPath(dir)
  if (dir.endsWith('/') || (win && dir.endsWith('\\'))) return dir + name
  return `${dir}${win ? '\\' : '/'}${name}`
}

/** Caminho com caracteres de controle (NUL, quebra de linha…): nunca vai ao modelo. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Caminho como vai em `openFile.path`: relativo à raiz do chat (`root`) quando está dentro dela,
 * senão absoluto, com `.`/`..` resolvidos e o separador do sistema da raiz. Relativo na entrada =
 * relativo à raiz. Sem raiz conhecida, o caminho como veio. Inválido (vazio, caracteres de
 * controle, acima de OPEN_FILE_PATH_MAX, ou a própria raiz) → null.
 */
export function normalizeOpenFilePath(
  path: unknown,
  root: string | null | undefined
): string | null {
  if (typeof path !== 'string' || !path.trim() || CONTROL.test(path)) return null
  const r = typeof root === 'string' && root.trim() && !CONTROL.test(root) ? root : null
  if (!r) return path.length <= OPEN_FILE_PATH_MAX ? path : null
  const win = isWindowsPath(r)
  const sep = win ? '\\' : '/'
  const rp = partsOf(r, win)
  const ap = isAbsolutePath(path) ? partsOf(path, win) : partsOf(`${r}${sep}${path}`, win)
  const inside = under(ap, rp, win)
  // a própria raiz (uma pasta) não é "arquivo selecionado"
  if (inside && ap.segs.length === rp.segs.length) return null
  const out = inside
    ? ap.segs.slice(rp.segs.length).join(sep)
    : ap.segs.length || ap.head
      ? `${ap.head}${ap.segs.join(sep)}`
      : ''
  if (!out || out.length > OPEN_FILE_PATH_MAX) return null
  return out
}

/**
 * Caminho absoluto para abrir/conferir o arquivo de um `openFile.path` (ou de um `@caminho`):
 * absoluto fica; relativo é juntado à raiz (com `.`/`..` resolvidos). Sem raiz, como veio.
 */
export function resolveChatPath(path: string, root: string | null | undefined): string {
  if (isAbsolutePath(path) || !root) return path
  const win = isWindowsPath(root)
  const sep = win ? '\\' : '/'
  const p = partsOf(`${root}${sep}${path}`, win)
  return `${p.head}${p.segs.join(sep)}`
}

/** Nome do arquivo (último segmento) de um caminho POSIX ou Windows. */
export function pathBaseName(path: string): string {
  const segs = path.split(/[\\/]+/).filter(Boolean)
  return segs[segs.length - 1] ?? path
}

/**
 * `openFile` vindo de fora (renderer, comando remoto `send`, registro sincronizado) → válido e
 * normalizado contra a raiz do chat NESTE host, ou null (ausente/malformado: a mensagem segue sem
 * ele — nunca é recusada por isso).
 */
export function parseOpenFile(v: unknown, root?: string | null): OpenFileMeta | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const path = normalizeOpenFilePath((v as { path?: unknown }).path, root)
  return path ? { path } : null
}

/**
 * `payload.meta.openFile` de um comando remoto `send`/`force` (§8.6): vale em qualquer `meta` (o
 * composer manda `{ openFile }` sem `kind`; `inter-chat` não leva arquivo) — string ≤ 1024 sem
 * caracteres de controle; quem executa normaliza pela raiz do chat dele. Senão null (a mensagem
 * segue sem o arquivo, nunca é recusada por isso).
 */
export function sendMetaOpenFile(meta: unknown): OpenFileMeta | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  return parseOpenFile((meta as { openFile?: unknown }).openFile)
}

// ---------------- request ----------------

/** `openFile` utilizável de um meta salvo/sincronizado (sem renormalizar: o host já normalizou). */
export function storedOpenFile(meta: MessageMeta | undefined | null): OpenFileMeta | null {
  return parseOpenFile(meta?.openFile, null)
}

/**
 * A mensagem do usuário como vai ao modelo: com `openFile`, o texto fixo depois do conteúdo — parte
 * de texto separada (content em parts) ou depois de uma linha em branco (content em texto). Outras
 * roles / sem `openFile` → a mesma mensagem (mesma referência). Nunca altera a entrada.
 */
export function withOpenFile(
  message: ApiMessage,
  openFile: OpenFileMeta | null | undefined
): ApiMessage {
  if (!openFile || message.role !== 'user') return message
  const text = openFileText(openFile.path)
  const c = message.content
  if (typeof c === 'string') return { role: 'user', content: c ? `${c}\n\n${text}` : text }
  return { role: 'user', content: [...c, { type: 'text', text }] }
}

/**
 * Mensagem salva → a cópia com o texto do arquivo selecionado aplicado (se houver). Todo builder
 * de request que envia o histórico (turno principal, subagentes, chamada de voz, compactação,
 * pré-visualização) passa as mensagens por aqui — ou por `withOpenFiles`.
 */
export function withStoredOpenFile(m: StoredMessage): StoredMessage {
  const of = m.message.role === 'user' ? storedOpenFile(m.meta) : null
  if (!of) return m
  return { ...m, message: withOpenFile(m.message, of) }
}

/** `withStoredOpenFile` em cada mensagem (mesma referência quando nada muda). */
export function withOpenFiles(history: StoredMessage[]): StoredMessage[] {
  let changed = false
  const out = history.map((m) => {
    const n = withStoredOpenFile(m)
    if (n !== m) changed = true
    return n
  })
  return changed ? out : history
}
