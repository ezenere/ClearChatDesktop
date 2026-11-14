// Caminhos citados no chat (arquivo selecionado — 1.13.0 — e `@caminho` nas mensagens): a raiz do
// chat onde os arquivos estão (local, ou a do HOST num chat de outro dispositivo) e "abrir no
// painel" com a checagem antes — o arquivo precisa existir (listagem da pasta-mãe pela fonte do
// chat: local, ou os comandos fs.* do host); senão um aviso discreto e nada é aberto. Pasta → a
// aba Arquivos naquela pasta. Ver SPEC.md → "Arquivo selecionado" / "Menções @caminho".
import type { Chat } from '@shared/types'
import type { ChatHostInfo } from '@shared/sync'
import { isAbsolutePath, isWindowsPath, pathBaseName, resolveChatPath } from '@shared/openFile'
import { useStore } from '../store'
import { isRemoteMode, sourcesFor } from './fileSources'

/**
 * Raiz do chat onde os arquivos estão: a do host num chat executado em outro dispositivo (null se
 * ainda não conhecida — a fonte remota resolve caminhos relativos contra ela); senão a local.
 */
export function chatRootOf(chat: Chat, host: ChatHostInfo | undefined): string | null {
  if (chat.liveViewer || isRemoteMode(host?.mode)) return host?.hostCwd?.path ?? null
  return chat.config.cwd || null
}

/** Pasta-mãe de um caminho (POSIX ou Windows); relativo sem pasta → ''. */
export function parentDir(path: string): string {
  const win = isWindowsPath(path) || (!isAbsolutePath(path) && path.includes('\\'))
  const i = Math.max(path.lastIndexOf('/'), win ? path.lastIndexOf('\\') : -1)
  if (i < 0) return ''
  if (i === 0) return path.slice(0, 1)
  // `C:\arquivo` → `C:\`
  if (win && /^[A-Za-z]:$/.test(path.slice(0, i))) return path.slice(0, i + 1)
  return path.slice(0, i)
}

export type ChatPathCheck =
  | { kind: 'file'; abs: string; name: string }
  | { kind: 'dir'; abs: string; name: string }
  | { kind: 'missing'; message: string }

/** Confere o caminho na fonte do chat (sem abrir nada). */
export async function checkChatPath(chatId: string, path: string): Promise<ChatPathCheck> {
  const st = useStore.getState()
  const chat = st.chats.find((c) => c.id === chatId)
  if (!chat) return { kind: 'missing', message: 'Chat não encontrado.' }
  const host = st.chatHosts[chatId]
  const root = chatRootOf(chat, host)
  const clean = path.replace(/[\\/]+$/, '') || path
  const abs = root ? resolveChatPath(clean, root) : clean
  const name = pathBaseName(abs)
  const dir = parentDir(abs)
  const src = sourcesFor(chatId, chat.liveViewer ? 'remote' : host?.mode).dir
  const r = await src.listDir(chatId, dir || (root ?? ''))
  // pasta-mãe ausente/ilegível ou entrada ausente: o mesmo aviso (host offline tem o dele)
  if (!r.ok && r.reason === 'host-offline') return { kind: 'missing', message: r.message }
  const e = r.ok ? r.entries.find((x) => x.name === name) : undefined
  if (!e) return { kind: 'missing', message: `Não encontrei ${path} na raiz do chat.` }
  const full = e.path || abs
  return { kind: e.isDir ? 'dir' : 'file', abs: full, name }
}

/**
 * Clique num caminho citado: confere e abre no painel de arquivo (pasta → aba Arquivos nela). Não
 * existe / não deu para conferir → aviso discreto (toast), nunca tenta abrir.
 */
export async function openChatPath(chatId: string, path: string): Promise<boolean> {
  const st = useStore.getState()
  const r = await checkChatPath(chatId, path)
  if (r.kind === 'missing') {
    st.toast(r.message, 'info')
    return false
  }
  if (r.kind === 'dir') st.showFolder(chatId, r.abs)
  else st.openFile(chatId, { chatId, source: 'browse', path: r.abs }, r.abs, r.name)
  return true
}
