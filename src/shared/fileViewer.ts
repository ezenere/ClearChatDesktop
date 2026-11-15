// Visualizador de arquivos + tool present_file — partes PURAS compartilhadas por main e renderer:
// validação dos argumentos, texto do resultado, regras do bloco de título dos cards, tipo do
// arquivo (extensão + bytes), mimes e o formato das URLs do protocolo clearchat-file://.
// Ver SPEC.md → "Visualizador de arquivos (present_file)".
import type { PresentedFile, ViewerKind } from './types'

export const PRESENT_FILE_LIMITS = {
  /** Arquivos por chamada de present_file. */
  maxFiles: 20,
  titleMax: 200,
  descriptionMax: 1000,
  pathMax: 4096
} as const

/** Tetos do que o painel renderiza (um lugar só — fonte local e remota usam os mesmos). */
export const VIEWER_LIMITS = {
  /** Texto (markdown/código/texto): lê no máximo isto; acima, mostra o começo + aviso. */
  textMaxBytes: 5 * 1024 * 1024,
  /** Markdown acima disto é mostrado como texto puro (react-markdown fica lento). */
  markdownMaxChars: 1024 * 1024,
  /** Destaque de sintaxe só até aqui (acima: texto puro). */
  highlightMaxChars: 400 * 1024,
  /** Imagens/PDF/HTML servidos ao painel (e assets relativos do markdown). */
  binaryMaxBytes: 200 * 1024 * 1024,
  /** Bytes lidos para detectar texto × binário. */
  sniffBytes: 8000
} as const

// ---------------- URLs do protocolo ----------------

/** Protocolo privilegiado que serve ao renderer SÓ arquivos da allowlist do main. */
export const VIEWER_SCHEME = 'clearchat-file'
export const VIEWER_TOKEN_RE = /^[0-9a-f]{32}$/

/** `clearchat-file://<token>/<nome>` — o token identifica a concessão (o caminho nunca vai na URL). */
export const viewerUrl = (token: string, name: string): string =>
  `${VIEWER_SCHEME}://${token}/${encodeURIComponent(name)}`

/**
 * `clearchat-file://<token>/<seg>/<seg>` → token + segmentos decodificados, ou null. Recusa
 * segmentos vazios, `.`/`..` (também codificados), barras/NUL codificados e token fora do formato.
 */
export function parseViewerUrl(url: unknown): { token: string; segments: string[] } | null {
  if (typeof url !== 'string') return null
  const prefix = `${VIEWER_SCHEME}://`
  if (!url.startsWith(prefix)) return null
  const rest = url.slice(prefix.length).split(/[?#]/)[0]
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const token = rest.slice(0, slash).toLowerCase()
  if (!VIEWER_TOKEN_RE.test(token)) return null
  const raw = rest.slice(slash + 1).split('/')
  if (!raw.length) return null
  const segments: string[] = []
  for (const r of raw) {
    let seg: string
    try {
      seg = decodeURIComponent(r)
    } catch {
      return null
    }
    if (!seg || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) return null
    segments.push(seg)
  }
  return { token, segments }
}

// ---------------- tipo do arquivo ----------------

export function fileExtOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

const baseName = (name: string): string => (name.split(/[\\/]/).pop() ?? '').toLowerCase()

export const VIEWER_IMAGE_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/**
 * Vídeos com prévia no painel (<video> do Chromium/Electron, que traz H.264/AAC/VP8/VP9/AV1). Codec
 * que não toca (HEVC num .mov/.mkv, por exemplo) cai no "sem prévia" com os botões de abrir/salvar.
 * avi/wmv/flv/3gp ficam como binário (o Chromium não abre esses contêineres).
 */
export const VIEWER_VIDEO_MIMES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska'
}

/**
 * Extensão → linguagem do highlight.js (`highlight.js/lib/common`, o mesmo conjunto do markdown).
 * Extensão de código fora daqui vira texto puro.
 */
const CODE_LANGS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  ipynb: 'json',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  m: 'objectivec',
  mm: 'objectivec',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  command: 'bash',
  // scripts do Windows: prévia como código (sem destaque — fora do conjunto `common`)
  bat: 'plaintext',
  cmd: 'plaintext',
  ps1: 'plaintext',
  psm1: 'plaintext',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  xml: 'xml',
  plist: 'xml',
  vue: 'xml',
  svelte: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  mk: 'makefile',
  vb: 'vbnet'
}
const CODE_NAMES: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
  dockerfile: 'bash',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash'
}

const TEXT_EXTS = new Set(
  (
    'txt text log csv tsv env properties rst adoc asciidoc org tex srt vtt lock gitignore ' +
    'gitattributes editorconfig npmrc nvmrc dockerignore prettierrc eslintrc babelrc'
  ).split(/\s+/)
)
const TEXT_NAMES = new Set(['license', 'readme', 'changelog', 'authors', 'notice', 'copying'])

/** Binários conhecidos (sem visualização) — não precisam de sniff. */
const BINARY_EXTS = new Set(
  (
    'zip gz tgz bz2 xz zst 7z rar tar jar war ear apk aab ipa exe dll so dylib bin o a lib obj ' +
    'class pyc pyo wasm dmg iso img deb rpm msi pkg doc docx xls xlsx ppt pptx odt ods odp key ' +
    'pages numbers epub mobi mp3 wav ogg oga flac m4a aac opus mid midi avi ' +
    'wmv flv 3gp sqlite sqlite3 db mdb ttf otf woff woff2 eot psd ai sketch fig xcf heic heif ' +
    'tif tiff raw cr2 nef dng blend fbx glb gltf stl pdb npy npz pkl pt onnx safetensors parquet'
  ).split(/\s+/)
)

/** Linguagem do highlight.js para o nome (undefined = sem destaque). */
export function codeLanguage(name: string): string | undefined {
  return CODE_NAMES[baseName(name)] ?? CODE_LANGS[fileExtOf(name)]
}

/** Tipo pelo NOME; null = desconhecido (decide pelos bytes). */
export function kindFromName(name: string): ViewerKind | null {
  const ext = fileExtOf(name)
  const base = baseName(name)
  if (VIEWER_IMAGE_MIMES[ext]) return 'image'
  if (VIEWER_VIDEO_MIMES[ext]) return 'video'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx' || ext === 'mdown') return 'markdown'
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html'
  if (codeLanguage(name)) return 'code'
  if (TEXT_EXTS.has(ext) || TEXT_NAMES.has(base) || TEXT_NAMES.has(base.replace(/\.\w+$/, '')))
    return 'text'
  if (BINARY_EXTS.has(ext)) return 'binary'
  return null
}

/** UTF-8 válido? (tolera um caractere multibyte cortado no fim da amostra) */
function validUtf8(b: Uint8Array): boolean {
  let i = 0
  while (i < b.length) {
    const c = b[i]
    let n: number
    if (c < 0x80) n = 0
    else if (c >= 0xc2 && c <= 0xdf) n = 1
    else if (c >= 0xe0 && c <= 0xef) n = 2
    else if (c >= 0xf0 && c <= 0xf4) n = 3
    else return false
    if (i + n >= b.length) {
      // caractere cortado no fim da amostra: confere só os bytes que vieram
      for (let k = i + 1; k < b.length; k++) if ((b[k] & 0xc0) !== 0x80) return false
      return true
    }
    for (let k = 1; k <= n; k++) if ((b[i + k] & 0xc0) !== 0x80) return false
    i += n + 1
  }
  return true
}

/** Amostra parece binária? NUL, UTF-8 inválido ou muitos caracteres de controle. */
export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, VIEWER_LIMITS.sniffBytes)
  const b = head.subarray(0, n)
  let ctrl = 0
  for (let i = 0; i < n; i++) {
    const c = b[i]
    if (c === 0) return true
    // controles fora de \t \n \r \f \v e ESC (logs com cores)
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12 && c !== 11 && c !== 27) ctrl++
  }
  if (n > 0 && ctrl / n > 0.1) return true
  return !validUtf8(b)
}

/** Assinatura de imagem/PDF/vídeo nos bytes iniciais (arquivo sem extensão conhecida). */
export function sniffMagic(
  head: Uint8Array
): { kind: 'image' | 'pdf' | 'video'; ext: string } | null {
  const at = (i: number, ...bytes: number[]): boolean => bytes.every((v, k) => head[i + k] === v)
  const ascii = (i: number, s: string): boolean =>
    [...s].every((ch, k) => head[i + k] === ch.charCodeAt(0))
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return { kind: 'image', ext: 'png' }
  if (at(0, 0xff, 0xd8, 0xff)) return { kind: 'image', ext: 'jpg' }
  if (ascii(0, 'GIF8')) return { kind: 'image', ext: 'gif' }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', ext: 'webp' }
  if (ascii(0, 'BM') && head.length > 14) return { kind: 'image', ext: 'bmp' }
  if (ascii(0, '%PDF')) return { kind: 'pdf', ext: 'pdf' }
  // ISO BMFF (`ftyp` no byte 4): mp4/m4v/mov — fora as marcas de imagem (HEIF/AVIF)
  if (ascii(4, 'ftyp') && head.length >= 12) {
    const brand = String.fromCharCode(...head.subarray(8, 12))
    if (!/^(heic|heix|heim|heis|hevc|hevx|mif1|msf1|avif|avis)$/.test(brand))
      return { kind: 'video', ext: brand === 'qt  ' ? 'mov' : 'mp4' }
  }
  // EBML (Matroska/WebM): o DocType diz qual
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) {
    const txt = String.fromCharCode(...head.subarray(0, Math.min(head.length, 64)))
    return { kind: 'video', ext: txt.includes('webm') ? 'webm' : 'mkv' }
  }
  return null
}

/**
 * Tipo final: extensão manda para imagem/PDF/vídeo/binário conhecido; texto/código/markdown/HTML
 * com bytes binários vira binário; desconhecido → assinatura (imagem/PDF/vídeo) → texto × binário.
 */
export function detectViewerKind(name: string, head: Uint8Array): ViewerKind {
  const byName = kindFromName(name)
  if (byName === 'image' || byName === 'pdf' || byName === 'video' || byName === 'binary')
    return byName
  if (byName) return looksBinary(head) ? 'binary' : byName
  const magic = sniffMagic(head)
  if (magic) return magic.kind
  return looksBinary(head) ? 'binary' : 'text'
}

/** Mime com que o arquivo principal é servido (texto nunca sai como HTML). */
export function viewerMime(kind: ViewerKind, name: string, head?: Uint8Array): string {
  if (kind === 'image') {
    const m = VIEWER_IMAGE_MIMES[fileExtOf(name)]
    if (m) return m
    const magic = head ? sniffMagic(head) : null
    return magic ? (VIEWER_IMAGE_MIMES[magic.ext] ?? 'application/octet-stream') : 'image/png'
  }
  if (kind === 'video') {
    const m = VIEWER_VIDEO_MIMES[fileExtOf(name)]
    if (m) return m
    const magic = head ? sniffMagic(head) : null
    return (magic && VIEWER_VIDEO_MIMES[magic.ext]) || 'video/mp4'
  }
  if (kind === 'pdf') return 'application/pdf'
  if (kind === 'html') return 'text/html; charset=utf-8'
  if (kind === 'binary') return 'application/octet-stream'
  return 'text/plain; charset=utf-8'
}

/**
 * Asset relativo (imagem do markdown/HTML apresentado, sob a pasta dele): mime se permitido, senão
 * null. Markdown: só imagens. HTML: imagens + CSS (estático; scripts e fontes ficam de fora).
 */
export function viewerAssetMime(grantKind: ViewerKind, name: string): string | null {
  const ext = fileExtOf(name)
  if (grantKind !== 'markdown' && grantKind !== 'html') return null
  if (VIEWER_IMAGE_MIMES[ext]) return VIEWER_IMAGE_MIMES[ext]
  if (grantKind === 'html' && ext === 'css') return 'text/css; charset=utf-8'
  return null
}

/** Rótulo curto do tipo (painel de arquivo sem visualização, tooltips). */
export function viewerTypeLabel(kind: ViewerKind, name: string): string {
  const ext = fileExtOf(name)
  switch (kind) {
    case 'markdown':
      return 'Markdown'
    case 'html':
      return 'Página HTML'
    case 'image':
      return `Imagem ${ext ? ext.toUpperCase() : ''}`.trim()
    case 'pdf':
      return 'Documento PDF'
    case 'video':
      return `Vídeo ${ext ? ext.toUpperCase() : ''}`.trim()
    case 'code':
      return `Código${ext ? ` (.${ext})` : ''}`
    case 'text':
      return 'Texto'
    default:
      return ext ? `Arquivo .${ext}` : 'Arquivo binário'
  }
}

/** CSP do documento HTML servido ao iframe isolado (sem rede; scripts só se o iframe permitir). */
export const VIEWER_HTML_CSP =
  "default-src 'none'; img-src clearchat-file: data:; style-src 'unsafe-inline' clearchat-file:; " +
  "script-src 'unsafe-inline'; media-src clearchat-file: data:; font-src data:; " +
  "base-uri 'none'; form-action 'none'"

/**
 * CSP do HTML vindo de OUTRO dispositivo (controle remoto): servido por blob URL ao mesmo iframe
 * isolado, com esta política injetada num <meta> (blob: não tem cabeçalho). Sem rede e sem assets
 * relativos (os bytes estão no host); o documento ainda herda a CSP do app, que barra scripts.
 */
export const VIEWER_REMOTE_HTML_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "media-src data:; font-src data:; base-uri 'none'; form-action 'none'"

// ---------------- argumentos / resultado de present_file ----------------

export interface PresentFileRequest {
  path: string
  title?: string
  description?: string
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

function optText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? cut(t, max) : undefined
}

/**
 * Valida os argumentos de present_file: `{ files: [{ path, title?, description? }] }` (1..20).
 * Tolerante com modelos fracos: `files` como string JSON, item como string (caminho) e `{ path }`
 * no topo (um arquivo só). Caminhos repetidos entram uma vez. Erro → mensagem legível (pt-BR).
 */
export function parsePresentFileArgs(
  args: Record<string, unknown>
): { files: PresentFileRequest[] } | { error: string } {
  let raw: unknown = args.files
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = [raw]
    }
  }
  if (raw === undefined && typeof args.path === 'string')
    raw = [{ path: args.path, title: args.title, description: args.description }]
  if (!Array.isArray(raw))
    return { error: 'Argumento "files" ausente ou inválido (esperado: lista de { path }).' }
  if (raw.length === 0) return { error: 'Informe ao menos um arquivo em "files".' }
  if (raw.length > PRESENT_FILE_LIMITS.maxFiles)
    return {
      error: `Máximo de ${PRESENT_FILE_LIMITS.maxFiles} arquivos por chamada (recebidos ${raw.length}).`
    }
  const files: PresentFileRequest[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const item = typeof raw[i] === 'string' ? { path: raw[i] } : raw[i]
    if (!item || typeof item !== 'object')
      return { error: `files[${i}]: esperado um objeto { path, title?, description? }.` }
    const o = item as Record<string, unknown>
    const path = typeof o.path === 'string' ? o.path.trim() : ''
    if (!path) return { error: `files[${i}]: "path" ausente ou vazio.` }
    if (path.length > PRESENT_FILE_LIMITS.pathMax || path.includes('\0'))
      return { error: `files[${i}]: caminho inválido.` }
    if (seen.has(path)) continue
    seen.add(path)
    const title = optText(o.title, PRESENT_FILE_LIMITS.titleMax)
    const description = optText(o.description, PRESENT_FILE_LIMITS.descriptionMax)
    files.push({ path, ...(title ? { title } : {}), ...(description ? { description } : {}) })
  }
  return { files }
}

/**
 * Texto curto devolvido ao modelo: `Apresentado ao usuário: a.md, b.png` — com falhas:
 * `Apresentado ao usuário: a.md (não apresentado: b.png — não encontrado)`; tudo falhou → erro.
 */
export function presentResultText(entries: { shown: string; error?: string }[]): {
  text: string
  ok: boolean
} {
  const okNames = entries.filter((e) => !e.error).map((e) => e.shown)
  const failed = entries.filter((e) => e.error).map((e) => `${e.shown} — ${e.error}`)
  if (!okNames.length)
    return { text: `Erro: nenhum arquivo apresentado (${failed.join('; ')}).`, ok: false }
  return {
    text: `Apresentado ao usuário: ${okNames.join(', ')}${failed.length ? ` (não apresentado: ${failed.join('; ')})` : ''}`,
    ok: true
  }
}

// ---------------- cards ----------------

/**
 * Bloco de título do card (regras do produto):
 * - título + descrição → título; descrição abaixo; nome real pequeno e esmaecido abaixo
 * - só descrição → nome do arquivo como título; descrição abaixo
 * - só título → título; nome real abaixo, menor e esmaecido
 * - nenhum → só o nome real
 * Título igual ao nome do arquivo conta como sem título (não repete o nome).
 */
export function presentTitleBlock(f: Pick<PresentedFile, 'name' | 'title' | 'description'>): {
  title: string
  description?: string
  fileName?: string
} {
  const title = f.title?.trim() && f.title.trim() !== f.name ? f.title.trim() : undefined
  const description = f.description?.trim() || undefined
  if (title && description) return { title, description, fileName: f.name }
  if (description) return { title: f.name, description }
  if (title) return { title, fileName: f.name }
  return { title: f.name }
}

/** Nome do arquivo de um caminho (qualquer separador). */
export const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path
