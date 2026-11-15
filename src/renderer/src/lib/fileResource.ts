// Tipos das fontes de arquivos do renderer + `resourceFromBytes` (bytes → recurso do visualizador).
// Sem `window.api`: a fonte remota (lib/remoteFiles.ts) e os testes unitários importam daqui.
// Ver lib/fileSources.ts e SPEC.md → "Visualizador de arquivos (present_file)".
import type { DirEntry, ViewerKind } from '@shared/types'
import type {
  ViewerCheck,
  ViewerFile,
  ViewerTarget,
  ViewerText,
  ViewerUnavailable
} from '@shared/ipc'
import { VIEWER_LIMITS } from '@shared/fileViewer'

/** Metadados do arquivo aberto (iguais para qualquer fonte). */
export type ViewerFileInfo = Omit<ViewerFile, 'token' | 'url'>

/** Arquivo aberto no visualizador, independente de onde vêm os bytes. */
export interface ViewerResource {
  info: ViewerFileInfo
  /** URL carregável por <img>/<iframe> (local: clearchat-file://…; remota: blob:…). null = sem. */
  url: string | null
  /** Texto (markdown/código/texto), até VIEWER_LIMITS.textMaxBytes (`truncated` acima disso). */
  readText(signal?: AbortSignal): Promise<ViewerText>
  /** Link relativo do markdown (imagens) → URL carregável; null = indisponível. */
  assetUrl(rel: string): string | null
  /**
   * Ações (presentes conforme `FileSource.capabilities` e a classe em `info.action`): abrir no app
   * padrão (local: direto; remota: baixa para um temporário e abre), mostrar na pasta (só local),
   * salvar como… (remota: diálogo do main grava os bytes buscados), executar… (executável deste
   * sistema; o main reclassifica e pede confirmação).
   */
  openExternal?: () => Promise<void>
  showInFolder?: () => Promise<void>
  saveAs?: () => Promise<void>
  run?: () => Promise<void>
  /** Libera recursos (blob URLs). Chamado ao trocar de arquivo / fechar. */
  dispose(): void
}

/** Por que não abriu: os motivos do main + "host offline" (fonte remota sem conexão). */
export type FileUnavailable = ViewerUnavailable | 'host-offline' | 'error'

export type FileOpenResult =
  | { ok: true; resource: ViewerResource }
  | { ok: false; reason: FileUnavailable; message: string; deviceName?: string }

export interface FileOpenOptions {
  signal?: AbortSignal
  /** Progresso (fonte remota em pedaços); `total` = tamanho, se conhecido. */
  onProgress?: (loaded: number, total?: number) => void
}

/** O que a UI pode oferecer para arquivos desta fonte (barra do painel, cards, tipo sem prévia). */
export interface FileSourceCapabilities {
  /** "Mostrar na pasta" / "Mostrar local do arquivo no explorador" — nunca para arquivo remoto. */
  reveal: boolean
  /** "Abrir no app" / "Abrir arquivo" (remota: baixa para temporário e abre). */
  openNative: boolean
  /** "Salvar como…" (remota: diálogo de salvar no main com os bytes buscados). */
  saveAs: boolean
  /** "Executar…" de executáveis deste sistema (confirmação no main; remota: cópia temporária). */
  run: boolean
}

export interface FileSource {
  readonly id: 'local' | 'remote'
  readonly capabilities: FileSourceCapabilities
  open(target: ViewerTarget, opts?: FileOpenOptions): Promise<FileOpenResult>
  /** Estado dos arquivos de uma chamada de present_file (cards), sem abrir nada. */
  check(chatId: string, messageId: string): Promise<ViewerCheck[]>
}

export type DirListResult =
  | {
      ok: true
      dir: string
      entries: DirEntry[]
      /** Fonte remota: raiz do chat NO HOST e se a navegação fica nela (a local usa o chat). */
      root?: string
      confine?: boolean
      /** Pasta com entradas demais: só as primeiras vieram. */
      truncated?: boolean
    }
  | { ok: false; reason: 'host-offline' | 'denied' | 'error'; message: string }

export interface DirSource {
  readonly id: 'local' | 'remote'
  /** Lista `path` (absoluto) do chat — a fonte remota aplica a raiz/confinamento do host. */
  listDir(chatId: string, path: string, signal?: AbortSignal): Promise<DirListResult>
}

// ---------------- bytes → recurso (para a fonte remota) ----------------

/**
 * Monta um ViewerResource a partir dos BYTES do arquivo (fonte remota): imagem/PDF/HTML viram
 * blob URL; texto é decodificado com o teto de VIEWER_LIMITS (o chamador pode mandar só o começo
 * de um arquivo grande — `info.size` é o tamanho real). Assets relativos do markdown: `assetUrl`.
 * Precisa de `blob:` em img-src/frame-src no CSP quando for usada.
 */
export function resourceFromBytes(
  info: ViewerFileInfo,
  bytes: Uint8Array,
  opts: {
    assetUrl?: (rel: string) => string | null
    openExternal?: () => Promise<void>
    saveAs?: () => Promise<void>
    run?: () => Promise<void>
    /** Bytes servidos na blob URL quando diferem dos do arquivo (HTML com a CSP injetada). */
    blob?: Uint8Array
  } = {}
): ViewerResource {
  let url: string | null = null
  const binaryKinds: ViewerKind[] = ['image', 'pdf', 'html', 'video']
  const served = opts.blob ?? bytes
  // vídeo só com o arquivo inteiro (acima do teto do host vem só o começo: sem prévia)
  const whole = info.kind !== 'video' || bytes.length >= info.size
  if (binaryKinds.includes(info.kind) && whole && served.length <= VIEWER_LIMITS.binaryMaxBytes)
    url = URL.createObjectURL(new Blob([served as BlobPart], { type: info.mime }))
  return {
    info,
    url,
    readText: async () => {
      const max = VIEWER_LIMITS.textMaxBytes
      const slice = bytes.subarray(0, Math.min(bytes.length, max))
      let content = new TextDecoder('utf-8').decode(slice)
      const truncated = info.size > slice.length
      if (truncated) content = content.replace(/�+$/, '')
      return { content, truncated, size: info.size }
    },
    assetUrl: opts.assetUrl ?? (() => null),
    ...(opts.openExternal ? { openExternal: opts.openExternal } : {}),
    ...(opts.saveAs ? { saveAs: opts.saveAs } : {}),
    ...(opts.run ? { run: opts.run } : {}),
    dispose: () => {
      if (url) URL.revokeObjectURL(url)
    }
  }
}
