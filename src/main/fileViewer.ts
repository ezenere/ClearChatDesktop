// Visualizador de arquivos (main, sem Electron — testável): allowlist de arquivos que o renderer
// pode ler pelo protocolo clearchat-file://, abertura (present_file / aba Arquivos), leitura de
// texto e a resposta do protocolo. Ver SPEC.md → "Visualizador de arquivos (present_file)".
//
// Segurança: o renderer NUNCA passa caminho ao protocolo — só tokens aleatórios emitidos aqui.
// Um token = um arquivo (realpath fixado na concessão). O arquivo principal é servido só se o
// realpath ainda for o mesmo (troca por symlink depois da concessão → 404). Assets relativos (só
// imagens do markdown; imagens + CSS do HTML) só sob a pasta do arquivo (após realpath).
import { createReadStream, promises as fs } from 'fs'
import { Readable } from 'stream'
import { randomBytes } from 'crypto'
import { basename, dirname, join } from 'path'
import type { Chat, PresentedFile, StoredMessage, ViewerKind } from '@shared/types'
import type {
  ViewerCheck,
  ViewerFile,
  ViewerOpenResult,
  ViewerTarget,
  ViewerText
} from '@shared/ipc'
import {
  codeLanguage,
  detectViewerKind,
  parseViewerUrl,
  VIEWER_HTML_CSP,
  VIEWER_LIMITS,
  viewerAssetMime,
  viewerMime,
  viewerTypeLabel,
  viewerUrl
} from '@shared/fileViewer'
import { classifyFileAction } from '@shared/fileActions'
import { assertInsideRoot, binaryKind, isInside, resolvePath } from './tools/util'

export interface ViewerGrant {
  token: string
  /** realpath do arquivo no momento da concessão. */
  file: string
  /** realpath da pasta (base dos assets relativos). */
  dir: string
  kind: ViewerKind
}

/** Concessões em memória (só nesta execução do app). Mais antigas saem acima de `max`. */
export class ViewerRegistry {
  private byToken = new Map<string, ViewerGrant>()
  private byFile = new Map<string, string>()
  private max: number
  private newToken: () => string

  constructor(opts: { max?: number; newToken?: () => string } = {}) {
    this.max = opts.max ?? 1000
    this.newToken = opts.newToken ?? (() => randomBytes(16).toString('hex'))
  }

  /** Concede (ou renova) o acesso ao arquivo — `file` já é o realpath. */
  grant(file: string, kind: ViewerKind): ViewerGrant {
    const known = this.byFile.get(file)
    if (known) {
      const g = this.byToken.get(known)!
      g.kind = kind
      // renova a posição (LRU)
      this.byToken.delete(known)
      this.byToken.set(known, g)
      return g
    }
    const g: ViewerGrant = { token: this.newToken(), file, dir: dirname(file), kind }
    this.byToken.set(g.token, g)
    this.byFile.set(file, g.token)
    while (this.byToken.size > this.max) {
      const oldest = this.byToken.keys().next().value as string
      const og = this.byToken.get(oldest)!
      this.byToken.delete(oldest)
      this.byFile.delete(og.file)
    }
    return g
  }

  get(token: string): ViewerGrant | undefined {
    return this.byToken.get(token)
  }

  has(file: string): boolean {
    return this.byFile.has(file)
  }

  /**
   * Parte pura do protocolo: URL → o que servir (sem tocar no disco). `file` = o arquivo
   * concedido (um segmento = o nome dele); `asset` = caminho lexical sob a pasta (a checagem de
   * realpath vem depois, em `serveViewerRequest`).
   */
  resolve(
    url: string
  ):
    | { kind: 'file'; grant: ViewerGrant }
    | { kind: 'asset'; grant: ViewerGrant; path: string; mime: string }
    | { error: 400 | 403 | 404 } {
    const p = parseViewerUrl(url)
    if (!p) return { error: 400 }
    const grant = this.byToken.get(p.token)
    if (!grant) return { error: 404 }
    if (p.segments.length === 1 && p.segments[0] === basename(grant.file))
      return { kind: 'file', grant }
    const mime = viewerAssetMime(grant.kind, p.segments[p.segments.length - 1])
    if (!mime) return { error: 403 }
    return { kind: 'asset', grant, path: join(grant.dir, ...p.segments), mime }
  }
}

export const viewerRegistry = new ViewerRegistry()

let deviceSource: () => { id: string; name: string } | null = () => null
/** index.ts liga ao sync: dispositivo local anotado em meta.presentFiles (null = sync desligado). */
export function setViewerDeviceSource(fn: () => { id: string; name: string } | null): void {
  deviceSource = fn
}
export const viewerDevice = (): { id: string; name: string } | null => {
  try {
    return deviceSource()
  } catch {
    return null
  }
}

// ---------------- protocolo ----------------

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-site'
}

const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { 'content-type': 'text/plain', ...SECURITY_HEADERS } })

/** Lê o início do arquivo (detecção de tipo). */
export async function readHead(
  path: string,
  n: number = VIEWER_LIMITS.sniffBytes
): Promise<Buffer> {
  const fh = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/**
 * Cabeçalho `Range` (um intervalo de bytes: `bytes=a-b`, `bytes=a-` ou `bytes=-n`) → o trecho a
 * servir; 'unsatisfiable' = fora do arquivo (416); null = sem Range utilizável (serve tudo, 200 —
 * inclusive vários intervalos, que o <video> não pede).
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number
): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header ?? '')
  if (!m || (!m[1] && !m[2])) return null
  if (!m[1]) {
    // sufixo: os últimos n bytes
    const n = Number(m[2])
    if (!n || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start >= size || end < start) return 'unsatisfiable'
  return { start, end }
}

/** Resposta do protocolo clearchat-file:// (handler registrado em index.ts). */
export async function serveViewerRequest(
  url: string,
  registry: ViewerRegistry = viewerRegistry,
  /** Cabeçalho `Range` do pedido (o <video> busca aos pedaços para tocar/avançar). */
  range?: string | null
): Promise<Response> {
  const r = registry.resolve(url)
  if ('error' in r) return plain(r.error, r.error === 400 ? 'bad request' : 'not found')
  try {
    let target: string
    let mime: string
    let video = false
    const headers: Record<string, string> = { ...SECURITY_HEADERS }
    if (r.kind === 'file') {
      // o arquivo não pode ter virado outra coisa (symlink trocado) desde a concessão
      if ((await fs.realpath(r.grant.file)) !== r.grant.file) return plain(404, 'not found')
      target = r.grant.file
      mime = viewerMime(r.grant.kind, target, await readHead(target, 16))
      if (r.grant.kind === 'html') headers['content-security-policy'] = VIEWER_HTML_CSP
      video = r.grant.kind === 'video'
    } else {
      const real = await fs.realpath(r.path)
      if (!isInside(r.grant.dir, real)) return plain(403, 'forbidden')
      target = real
      mime = r.mime
    }
    const st = await fs.stat(target)
    if (!st.isFile()) return plain(404, 'not found')
    // vídeo vai aos pedaços (Range): sem o teto dos outros tipos, que são lidos inteiros
    if (!video && st.size > VIEWER_LIMITS.binaryMaxBytes) return plain(413, 'too large')
    headers['content-type'] = mime
    headers['accept-ranges'] = 'bytes'
    const part = parseByteRange(range, st.size)
    if (part === 'unsatisfiable')
      return new Response(null, {
        status: 416,
        headers: { ...SECURITY_HEADERS, 'content-range': `bytes */${st.size}` }
      })
    if (part) {
      headers['content-range'] = `bytes ${part.start}-${part.end}/${st.size}`
      headers['content-length'] = String(part.end - part.start + 1)
      const body = Readable.toWeb(
        createReadStream(target, { start: part.start, end: part.end })
      ) as unknown as ReadableStream
      return new Response(body, { status: 206, headers })
    }
    headers['content-length'] = String(st.size)
    const body = Readable.toWeb(createReadStream(target)) as unknown as ReadableStream
    return new Response(body, { status: 200, headers })
  } catch {
    return plain(404, 'not found')
  }
}

// ---------------- abrir / checar ----------------

/** Acesso ao banco/sync injetado (ipc.ts liga os reais; testes, falsos). */
export interface ViewerDeps {
  chat(id: string): Chat | null
  message(id: string): StoredMessage | null
  /** Chat de uma sessão (para conferir que a mensagem é do chat pedido). */
  chatOfSession(sessionId: string): string | null
  /** Dispositivo local do sync (null = sync desligado). */
  localDevice(): { id: string; name: string } | null
  /** Nome do host quando o chat roda em OUTRO dispositivo (controle remoto); senão null. */
  remoteHost(chatId: string): string | null
  /** Sistema deste computador (ações por tipo); padrão `process.platform`. */
  platform?: string
}

type Unavailable = Extract<ViewerOpenResult, { ok: false }>

const unavailable = (
  reason: Unavailable['reason'],
  message: string,
  deviceName?: string
): Unavailable => ({ ok: false, reason, message, ...(deviceName ? { deviceName } : {}) })

/**
 * Onde está o arquivo de uma chamada de present_file: local, ou em outro dispositivo (quem rodou
 * a tool ≠ este, ou o chat é controlado remotamente e a tool rodou sem sync).
 */
function presentedElsewhere(
  rec: NonNullable<StoredMessage['meta']['presentFiles']>,
  chatId: string,
  deps: ViewerDeps
): string | null {
  const local = deps.localDevice()
  // sync desligado agora: não dá para saber quem rodou — vale o disco local
  if (rec.deviceId && local)
    return rec.deviceId === local.id ? null : (rec.deviceName ?? 'outro dispositivo')
  return deps.remoteHost(chatId)
}

function presentedFile(
  target: Extract<ViewerTarget, { source: 'present' }>,
  deps: ViewerDeps
): { file: PresentedFile; rec: NonNullable<StoredMessage['meta']['presentFiles']> } | Unavailable {
  const msg = deps.message(target.messageId)
  const rec = msg?.meta.presentFiles
  if (!msg || !rec || deps.chatOfSession(msg.sessionId) !== target.chatId)
    return unavailable('invalid', 'Arquivo não encontrado nesta conversa.')
  const file = rec.files[target.index]
  if (!file || file.error) return unavailable('invalid', 'Este arquivo não foi apresentado.')
  return { file, rec }
}

/**
 * Confere o arquivo no disco (confinamento do chat, arquivo comum) → realpath ou indisponível.
 * Exportado: o host aplica as MESMAS regras ao `fs.read` de um controle remoto (sync/remoteFs.ts).
 */
export async function locate(
  chat: { config: Pick<Chat['config'], 'cwd' | 'confineToRoot'> },
  path: string
): Promise<{ real: string } | Unavailable> {
  try {
    if (chat.config.confineToRoot !== false) await assertInsideRoot(chat.config.cwd, path, path)
  } catch {
    return unavailable('denied', 'Acesso negado: o arquivo fica fora do diretório raiz do chat.')
  }
  try {
    const real = await fs.realpath(path)
    const st = await fs.stat(real)
    if (!st.isFile()) return unavailable('missing', 'Arquivo não encontrado.')
    return { real }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM')
      return unavailable('denied', 'Sem permissão para ler o arquivo.')
    return unavailable('missing', 'Arquivo não encontrado.')
  }
}

/**
 * Abre um arquivo no visualizador: valida (mensagem real de present_file / confinamento da aba
 * Arquivos), concede o token e devolve os metadados. Nunca lança por arquivo ausente.
 */
export async function openViewerFile(
  target: ViewerTarget,
  deps: ViewerDeps,
  registry: ViewerRegistry = viewerRegistry
): Promise<ViewerOpenResult> {
  if (!target || typeof target !== 'object' || typeof target.chatId !== 'string')
    return unavailable('invalid', 'Pedido inválido.')
  const chat = deps.chat(target.chatId)
  if (!chat) return unavailable('invalid', 'Chat não encontrado.')
  let path: string
  if (target.source === 'present') {
    if (typeof target.messageId !== 'string' || !Number.isInteger(target.index))
      return unavailable('invalid', 'Pedido inválido.')
    const found = presentedFile(target, deps)
    if ('ok' in found) return found
    const elsewhere = presentedElsewhere(found.rec, target.chatId, deps)
    if (elsewhere) return unavailable('remote', `Arquivo no ${elsewhere}.`, elsewhere)
    path = found.file.path
  } else if (target.source === 'browse') {
    if (typeof target.path !== 'string' || !target.path.trim() || target.path.includes('\0'))
      return unavailable('invalid', 'Caminho inválido.')
    path = resolvePath(chat.config.cwd, target.path)
  } else {
    return unavailable('invalid', 'Pedido inválido.')
  }
  const loc = await locate(chat, path)
  if ('ok' in loc) return loc
  const head = await readHead(loc.real).catch(() => Buffer.alloc(0))
  const kind = detectViewerKind(loc.real, head)
  const st = await fs.stat(loc.real)
  const g = registry.grant(loc.real, kind)
  const name = basename(loc.real)
  const language = kind === 'code' ? codeLanguage(name) : undefined
  const file: ViewerFile = {
    token: g.token,
    url: viewerUrl(g.token, name),
    path,
    name,
    size: st.size,
    mtime: st.mtimeMs,
    kind,
    mime: viewerMime(kind, name, head),
    ...(language ? { language } : {}),
    typeLabel:
      kind === 'binary' && head.length ? describeBinary(name, head) : viewerTypeLabel(kind, name),
    // bit de execução: só conta para arquivo sem extensão no Linux (ver @shared/fileActions)
    action: classifyFileAction(name, deps.platform ?? process.platform, {
      localExecutable: (st.mode & 0o111) !== 0
    })
  }
  return { ok: true, file }
}

/** "arquivo ZIP (ou docx/xlsx/jar)" pelos bytes; desconhecido → pela extensão. */
function describeBinary(name: string, head: Buffer): string {
  const k = binaryKind(head)
  return k === 'binário' ? viewerTypeLabel('binary', name) : k.charAt(0).toUpperCase() + k.slice(1)
}

/** Estado dos arquivos de uma chamada (cards) — sem conceder nada. */
export async function checkPresented(
  chatId: string,
  messageId: string,
  deps: ViewerDeps
): Promise<ViewerCheck[]> {
  const chat = deps.chat(chatId)
  const msg = deps.message(messageId)
  const rec = msg?.meta.presentFiles
  if (!chat || !msg || !rec || deps.chatOfSession(msg.sessionId) !== chatId) return []
  const elsewhere = presentedElsewhere(rec, chatId, deps)
  return Promise.all(
    rec.files.map(async (f): Promise<ViewerCheck> => {
      if (f.error) return { ok: false, reason: 'invalid' }
      if (elsewhere) return { ok: false, reason: 'remote', deviceName: elsewhere }
      const loc = await locate(chat, f.path)
      return 'ok' in loc ? { ok: false, reason: loc.reason } : { ok: true }
    })
  )
}

/** Texto do arquivo concedido (até VIEWER_LIMITS.textMaxBytes; corta caractere UTF-8 incompleto). */
export async function readViewerText(
  token: string,
  registry: ViewerRegistry = viewerRegistry
): Promise<ViewerText> {
  const g = typeof token === 'string' ? registry.get(token) : undefined
  if (!g) throw new Error('Arquivo não disponível (abra-o de novo).')
  if ((await fs.realpath(g.file)) !== g.file) throw new Error('O arquivo mudou de lugar.')
  const st = await fs.stat(g.file)
  const max = VIEWER_LIMITS.textMaxBytes
  const buf = await readHead(g.file, Math.min(st.size, max))
  let content = buf.toString('utf8')
  if (st.size > max) content = content.replace(/�+$/, '')
  return { content, truncated: st.size > max, size: st.size }
}

/** Caminho do arquivo de um token concedido (shell.openPath / showItemInFolder) — senão lança. */
export function grantedPath(token: string, registry: ViewerRegistry = viewerRegistry): string {
  const g = typeof token === 'string' ? registry.get(token) : undefined
  if (!g) throw new Error('Arquivo não disponível (abra-o de novo).')
  return g.file
}

/**
 * present_file rodou aqui: concede já os arquivos apresentados (o renderer abre o primeiro) e
 * anota o dispositivo (outros aparelhos do sync mostram "Arquivo no <dispositivo>").
 */
export async function registerPresented(
  rec: NonNullable<StoredMessage['meta']['presentFiles']>,
  device: { id: string; name: string } | null,
  registry: ViewerRegistry = viewerRegistry
): Promise<NonNullable<StoredMessage['meta']['presentFiles']>> {
  for (const f of rec.files) {
    if (f.error || !f.kind) continue
    try {
      registry.grant(await fs.realpath(f.path), f.kind)
    } catch {
      /* sumiu entre a tool e aqui: o card mostra "não encontrado" */
    }
  }
  return device ? { deviceId: device.id, deviceName: device.name, files: rec.files } : rec
}
