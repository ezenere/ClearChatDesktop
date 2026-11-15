// Fonte REMOTA de arquivos (chat em controle remoto: o host é outro dispositivo online). Busca do
// host pelos comandos E2EE `fs.list` / `fs.read` (docs/SYNC_PROTOCOL.md §8.6, via main) e devolve
// os mesmos tipos da fonte local (lib/fileResource.ts) — os componentes não mudam.
//
// - Download em pedaços de REMOTE_FS_LIMITS.chunkBytes, alguns em voo ao mesmo tempo, com progresso
//   e cancelamento (trocar de arquivo/chat aborta). Só o que a prévia usa: imagem/PDF/HTML inteiros,
//   texto até VIEWER_LIMITS.textMaxBytes, tipo sem prévia só o começo; "Salvar como…" / "Abrir no
//   app" / "Executar…" completam o arquivo na hora.
// - Cache em memória dos últimos arquivos (teto de quantidade e de bytes); reabrir confere
//   tamanho + mtime no host (pedido de 0 bytes) antes de usar o cache.
// - Nunca "Mostrar na pasta": o arquivo não está neste computador.
// Puro (sem window.api): lib/remoteSourcesSetup.ts liga ao IPC/store; os testes usam um stub.
import type { DirEntry, PresentFilesRecord, ViewerKind } from '@shared/types'
import type { ViewerCheck, ViewerTarget } from '@shared/ipc'
import {
  codeLanguage,
  detectViewerKind,
  fileNameOf,
  VIEWER_LIMITS,
  VIEWER_REMOTE_HTML_CSP,
  viewerMime,
  viewerTypeLabel
} from '@shared/fileViewer'
import { classifyFileAction } from '@shared/fileActions'
import {
  REMOTE_FS_LIMITS,
  type RemoteDirResult,
  type RemoteFsFailure,
  type RemoteReadResult
} from '@shared/remoteFs'
import {
  resourceFromBytes,
  type DirListResult,
  type DirSource,
  type FileOpenOptions,
  type FileOpenResult,
  type FileSource,
  type ViewerFileInfo
} from './fileResource'

/** O que a fonte remota precisa do main (IPC) — os testes passam um stub. */
export interface RemoteFsSender {
  listDir(chatId: string, path: string): Promise<RemoteDirResult>
  readChunk(chatId: string, path: string, offset: number, length: number): Promise<RemoteReadResult>
  saveBytes(name: string, bytes: Uint8Array): Promise<boolean>
  openBytes(name: string, bytes: Uint8Array): Promise<void>
  /** "Executar…": o main confere o chat em controle remoto, reclassifica, confirma e roda. */
  runBytes(chatId: string, name: string, bytes: Uint8Array): Promise<boolean>
}

/** O que a fonte remota precisa do store. */
export interface RemoteContext {
  /** Registro de present_file da mensagem (null = desconhecida). */
  presented(chatId: string, messageId: string): PresentFilesRecord | null
  myDeviceId(): string | null
  /** Host atual do chat. */
  host(chatId: string): { deviceId: string | null; name: string } | null
  /** Fonte local: arquivo apresentado por ESTE dispositivo num chat que hoje roda em outro. */
  local?: FileSource
  /** `process.platform` DESTE computador (ações por tipo; padrão 'linux'). */
  platform?(): string
}

export type RemoteOptions = Pick<
  typeof REMOTE_FS_LIMITS,
  'chunkBytes' | 'maxFileBytes' | 'concurrency' | 'cacheFiles' | 'cacheBytes'
>

interface CacheEntry {
  size: number
  mtime: number
  /** Começo do arquivo (detecção de tipo). */
  head: Uint8Array
  /** Bytes buscados: o arquivo inteiro (`complete`) ou o começo usado pela prévia. */
  bytes: Uint8Array
  complete: boolean
  /** Completar em andamento ("Salvar como…" / "Abrir no app" ao mesmo tempo). */
  filling?: Promise<Uint8Array>
}

/** LRU por quantidade e bytes (arquivo maior que o teto não entra). */
export class RemoteFileCache {
  private map = new Map<string, CacheEntry>()
  private maxFiles: number
  private maxBytes: number

  constructor(maxFiles: number, maxBytes: number) {
    this.maxFiles = maxFiles
    this.maxBytes = maxBytes
  }

  get(key: string): CacheEntry | undefined {
    const e = this.map.get(key)
    if (e) {
      this.map.delete(key)
      this.map.set(key, e)
    }
    return e
  }

  put(key: string, e: CacheEntry): void {
    this.map.delete(key)
    if (e.bytes.byteLength > this.maxBytes) return
    this.map.set(key, e)
    let total = this.bytes()
    for (const [k, v] of this.map) {
      if (this.map.size <= this.maxFiles && total <= this.maxBytes) break
      this.map.delete(k)
      total -= v.bytes.byteLength
    }
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  bytes(): number {
    let n = 0
    for (const v of this.map.values()) n += v.bytes.byteLength
    return n
  }

  keys(): string[] {
    return [...this.map.keys()]
  }
}

/** Falha vinda do host/main (motivo + texto pronto). */
class RemoteFetchError extends Error {
  failure: RemoteFsFailure
  constructor(failure: RemoteFsFailure) {
    super(failure.message)
    this.failure = failure
  }
}

class AbortedError extends Error {}

const CHANGED = 'O arquivo mudou no host durante a busca — tente de novo.'

const mb = (n: number): string => `${Math.round(n / 1024 / 1024)} MB`

/**
 * Injeta a CSP do visualizador (VIEWER_REMOTE_HTML_CSP) num <meta> no começo do HTML — depois do
 * BOM/doctype (antes do doctype o documento cairia no modo quirks). O parser põe o <meta> no
 * <head>; políticas a mais só restringem (o HTML não consegue afrouxar).
 */
export function withViewerCsp(bytes: Uint8Array): Uint8Array {
  // windows-1252 decodifica 1 byte = 1 caractere: o índice na string é o índice em bytes
  const s = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048))
  let i = s.startsWith('ï»¿') ? 3 : 0
  const m = /^\s*<!doctype[^>]*>/i.exec(s.slice(i))
  if (m) i += m[0].length
  const meta = new TextEncoder().encode(
    `<meta http-equiv="Content-Security-Policy" content="${VIEWER_REMOTE_HTML_CSP}">`
  )
  const out = new Uint8Array(bytes.length + meta.length)
  out.set(bytes.subarray(0, i), 0)
  out.set(meta, i)
  out.set(bytes.subarray(i), i + meta.length)
  return out
}

/** Separador do host pelo caminho que ele mandou (Windows: `\`). */
function joinHost(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : `${dir}${sep}${name}`
}

const toOpenFailure = (f: RemoteFsFailure): FileOpenResult => {
  const base = { ok: false as const, message: f.message }
  const dev = f.deviceName ? { deviceName: f.deviceName } : {}
  switch (f.reason) {
    case 'host-offline':
      return { ...base, reason: 'host-offline', ...dev }
    case 'denied':
      return { ...base, reason: 'denied' }
    case 'missing':
      return { ...base, reason: 'missing' }
    case 'unsupported':
      // host/servidor antigo: como antes desta versão, "Arquivo no <host>" (com o motivo)
      return { ...base, reason: 'remote', ...dev }
    default:
      return { ...base, reason: 'error' }
  }
}

/** Fontes remotas (memoizadas por chat: os efeitos da UI dependem da identidade). */
export function createRemoteSources(
  sender: RemoteFsSender,
  ctx: RemoteContext,
  options: Partial<RemoteOptions> = {}
): {
  file: (chatId: string) => FileSource
  dir: (chatId: string) => DirSource
  cache: RemoteFileCache
} {
  const opts: RemoteOptions = { ...REMOTE_FS_LIMITS, ...options }
  const cache = new RemoteFileCache(opts.cacheFiles, opts.cacheBytes)
  const files = new Map<string, FileSource>()
  const dirs = new Map<string, DirSource>()

  /**
   * Lê [from, to) para `buf` com até `concurrency` pedaços em voo; confere tamanho/mtime a cada
   * resposta (mudou → erro). Resposta mais curta que o pedido (host com teto menor) → o resto volta
   * para a fila.
   */
  async function fill(
    chatId: string,
    path: string,
    buf: Uint8Array,
    from: number,
    to: number,
    expect: { size: number; mtime: number },
    signal: AbortSignal | undefined,
    onChunk: (n: number) => void
  ): Promise<void> {
    const queue: [number, number][] = []
    for (let off = from; off < to; off += opts.chunkBytes)
      queue.push([off, Math.min(opts.chunkBytes, to - off)])
    let failed = false
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = failed ? undefined : queue.shift()
        if (!item) return
        if (signal?.aborted) throw new AbortedError()
        const [off, len] = item
        const r = await sender.readChunk(chatId, path, off, len)
        if (signal?.aborted) throw new AbortedError()
        if (!r.ok) throw new RemoteFetchError(r)
        const got = r.data.length
        if (r.size !== expect.size || r.mtime !== expect.mtime || got === 0 || got > len)
          throw new Error(CHANGED)
        buf.set(r.data, off)
        onChunk(got)
        if (got < len) queue.unshift([off + got, len - got])
      }
    }
    const n = Math.max(1, Math.min(opts.concurrency, queue.length))
    const results = await Promise.allSettled(
      Array.from({ length: n }, () =>
        worker().catch((e) => {
          failed = true // os outros param na próxima volta
          throw e
        })
      )
    )
    const bad = results.find((r) => r.status === 'rejected')
    if (bad) throw (bad as PromiseRejectedResult).reason
  }

  /** O arquivo inteiro (completa o que a prévia não buscou). */
  function ensureFull(
    chatId: string,
    path: string,
    key: string,
    e: CacheEntry
  ): Promise<Uint8Array> {
    if (e.complete) return Promise.resolve(e.bytes)
    if (e.filling) return e.filling
    if (e.size > opts.maxFileBytes)
      return Promise.reject(
        new Error(`Arquivo grande demais para buscar do host (máximo ${mb(opts.maxFileBytes)}).`)
      )
    e.filling = (async () => {
      const full = new Uint8Array(e.size)
      full.set(e.bytes)
      try {
        await fill(chatId, path, full, e.bytes.length, e.size, e, undefined, () => {})
      } catch (err) {
        e.filling = undefined
        if (err instanceof RemoteFetchError) throw new Error(err.failure.message, { cause: err })
        throw err
      }
      e.bytes = full
      e.complete = true
      e.filling = undefined
      cache.put(key, e)
      return full
    })()
    return e.filling
  }

  function infoOf(path: string, name: string, e: CacheEntry): ViewerFileInfo {
    const kind = detectViewerKind(name, e.head)
    const language = kind === 'code' ? codeLanguage(name) : undefined
    return {
      path,
      name,
      size: e.size,
      mtime: e.mtime,
      kind,
      mime: viewerMime(kind, name, e.head),
      ...(language ? { language } : {}),
      typeLabel: viewerTypeLabel(kind, name),
      // cópia de outro dispositivo: só a extensão (nunca o bit de execução do host)
      action: classifyFileAction(name, ctx.platform?.() ?? 'linux')
    }
  }

  /** Quanto a prévia precisa do arquivo. */
  function neededBytes(kind: ViewerKind, size: number, headLen: number): number {
    if (kind === 'image' || kind === 'pdf' || kind === 'html') return size
    // vídeo toca do blob inteiro; acima do teto só o começo (painel: "grande demais", Salvar como…)
    if (kind === 'video') return size <= opts.maxFileBytes ? size : Math.min(size, headLen)
    if (kind === 'binary') return Math.min(size, headLen)
    return Math.min(size, VIEWER_LIMITS.textMaxBytes)
  }

  function makeFileSource(chatId: string): FileSource {
    /** Alvo → caminho no host (ou motivo de não abrir / delegar para a fonte local). */
    const resolveTarget = (
      target: ViewerTarget
    ): { path: string; name: string } | { result: FileOpenResult } | { local: FileSource } => {
      if (target.source === 'browse') {
        if (typeof target.path !== 'string' || !target.path.trim())
          return { result: { ok: false, reason: 'invalid', message: 'Caminho inválido.' } }
        return { path: target.path, name: fileNameOf(target.path) || target.path }
      }
      const rec = ctx.presented(chatId, target.messageId)
      const f = rec?.files[target.index]
      if (!rec || !f)
        return {
          result: {
            ok: false,
            reason: 'invalid',
            message: 'Arquivo não encontrado nesta conversa.'
          }
        }
      if (f.error)
        return {
          result: { ok: false, reason: 'invalid', message: 'Este arquivo não foi apresentado.' }
        }
      const me = ctx.myDeviceId()
      if (rec.deviceId && me && rec.deviceId === me && ctx.local) return { local: ctx.local }
      const host = ctx.host(chatId)
      if (rec.deviceId && host?.deviceId && rec.deviceId !== host.deviceId) {
        const deviceName = rec.deviceName ?? 'outro dispositivo'
        return {
          result: { ok: false, reason: 'remote', message: `Arquivo no ${deviceName}.`, deviceName }
        }
      }
      return { path: f.path, name: f.name }
    }

    const open = async (target: ViewerTarget, o: FileOpenOptions = {}): Promise<FileOpenResult> => {
      const t = resolveTarget(target)
      if ('result' in t) return t.result
      if ('local' in t) return t.local.open(target, o)
      const { path, name } = t
      const key = `${chatId}\n${path}`
      const { signal, onProgress } = o
      try {
        let entry = cache.get(key)
        // em cache: só confere tamanho/mtime (0 bytes); senão já vem o primeiro pedaço
        let first = await sender.readChunk(chatId, path, 0, entry ? 0 : opts.chunkBytes)
        if (signal?.aborted) throw new AbortedError()
        if (!first.ok) return toOpenFailure(first)
        if (entry && (entry.size !== first.size || entry.mtime !== first.mtime)) {
          cache.delete(key)
          entry = undefined
          first = await sender.readChunk(chatId, path, 0, opts.chunkBytes)
          if (signal?.aborted) throw new AbortedError()
          if (!first.ok) return toOpenFailure(first)
        }
        if (!entry) {
          const head = first.data.slice(0, VIEWER_LIMITS.sniffBytes)
          const kind = detectViewerKind(name, head)
          const need = neededBytes(kind, first.size, first.data.length)
          if (need > opts.maxFileBytes)
            return {
              ok: false,
              reason: 'error',
              message: `Arquivo grande demais para buscar do host (${mb(first.size)}; máximo ${mb(opts.maxFileBytes)}).`
            }
          const buf = new Uint8Array(need)
          const have = Math.min(first.data.length, need)
          buf.set(first.data.subarray(0, have))
          let loaded = have
          onProgress?.(loaded, need)
          await fill(chatId, path, buf, have, need, first, signal, (n) => {
            loaded += n
            onProgress?.(loaded, need)
          })
          entry = {
            size: first.size,
            mtime: first.mtime,
            head,
            bytes: buf,
            complete: need === first.size
          }
          cache.put(key, entry)
        }
        const e = entry
        const info = infoOf(path, name, e)
        const resource = resourceFromBytes(info, e.bytes, {
          ...(info.kind === 'html' ? { blob: withViewerCsp(e.bytes) } : {}),
          saveAs: async () => {
            await sender.saveBytes(name, await ensureFull(chatId, path, key, e))
          },
          openExternal: async () => {
            await sender.openBytes(name, await ensureFull(chatId, path, key, e))
          },
          run: async () => {
            await sender.runBytes(chatId, name, await ensureFull(chatId, path, key, e))
          }
        })
        return { ok: true, resource }
      } catch (err) {
        if (err instanceof AbortedError)
          return { ok: false, reason: 'error', message: 'Cancelado.' }
        if (err instanceof RemoteFetchError) return toOpenFailure(err.failure)
        return {
          ok: false,
          reason: 'error',
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }

    const check = async (_chatId: string, messageId: string): Promise<ViewerCheck[]> => {
      const rec = ctx.presented(chatId, messageId)
      if (!rec) return []
      const me = ctx.myDeviceId()
      const host = ctx.host(chatId)
      // sem ir à rede: só o que o registro diz (onde está); o resto o painel mostra ao abrir
      return rec.files.map((f): ViewerCheck => {
        if (f.error) return { ok: false, reason: 'invalid' }
        if (rec.deviceId && rec.deviceId !== me && host?.deviceId && rec.deviceId !== host.deviceId)
          return { ok: false, reason: 'remote', deviceName: rec.deviceName ?? 'outro dispositivo' }
        return { ok: true }
      })
    }

    return {
      id: 'remote',
      capabilities: { reveal: false, openNative: true, saveAs: true, run: true },
      open,
      check
    }
  }

  function makeDirSource(chatId: string): DirSource {
    return {
      id: 'remote',
      async listDir(_chatId, path): Promise<DirListResult> {
        const r = await sender.listDir(chatId, path)
        if (!r.ok)
          return {
            ok: false,
            reason:
              r.reason === 'host-offline'
                ? 'host-offline'
                : r.reason === 'denied'
                  ? 'denied'
                  : 'error',
            message: r.message
          }
        const entries: DirEntry[] = r.entries.map((x) => ({
          name: x.name,
          path: joinHost(r.dir, x.name),
          isDir: x.kind === 'dir',
          size: x.size ?? 0,
          mtime: x.mtime ?? 0
        }))
        return {
          ok: true,
          dir: r.dir,
          entries,
          root: r.root,
          confine: r.confine,
          truncated: r.truncated
        }
      }
    }
  }

  return {
    file: (chatId) => {
      let s = files.get(chatId)
      if (!s) files.set(chatId, (s = makeFileSource(chatId)))
      return s
    },
    dir: (chatId) => {
      let s = dirs.get(chatId)
      if (!s) dirs.set(chatId, (s = makeDirSource(chatId)))
      return s
    },
    cache
  }
}
