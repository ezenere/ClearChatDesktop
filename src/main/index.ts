import { app, shell, BrowserWindow, nativeImage, nativeTheme, protocol, session } from 'electron'
import { join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { closeDb, getDb, getDbPath } from './db'
import { registerIpc, resetVoiceForWebContents, shutdownGpuVoice, shutdownVoiceCall } from './ipc'
import { shutdownSttWorker } from './voice/sttWorkerHost'
import { shutdownTtsWorker } from './voice/ttsWorkerHost'
import { registerEventWindow } from './events'
import { installContextMenu, setupSpellcheck } from './contextMenu'
import { initSync, shutdownSync, syncEngine } from './sync'
import { initRunner, shutdownRunner } from './agent/runner'
import { emit } from './events'
import { initShell, withMacToolPaths } from './tools/shellEnv'
import {
  gcProcessLogs,
  killAllProcesses,
  setProcessListener,
  setProcessLogDir
} from './tools/processes'
import { gcToolOutputs, setToolOutputDir } from './tools/toolOutputs'
import { chatsRepo } from './repo'
import { migrateLegacyData } from './migrate'
import { initUpdates, shutdownUpdates } from './updates'
import { setImageProcessor } from './tools/media'
import { nativeImageProcessor } from './imageResize'
import { ATTACHMENT_SCHEME, parseAttachmentUrl } from '@shared/attachments'
import { VIEWER_SCHEME } from '@shared/fileViewer'
import { serveViewerRequest, setViewerDeviceSource } from './fileViewer'
import { cleanViewerTemp, setViewerTempDir } from './viewerTemp'
import {
  attachmentsDir,
  gcAttachments,
  mimeForFile,
  readAttachment,
  referencedFilesInDb,
  setAttachmentsDir
} from './attachments'

const APP_NAME = 'ClearChat'
const APP_ID = 'com.clearchat.app'

// Nome explícito: define userData (~/.config/ClearChat) e o WM_CLASS da janela no Linux
// (o app_id no Wayland vem de "desktopName" no package.json → clearchat.desktop).
app.setName(APP_NAME)

// macOS: o PATH do Finder/Dock não tem o Homebrew (espeak-ng etc.); antes de criar processos filhos.
process.env.PATH = withMacToolPaths(process.env.PATH ?? '')

// Testes isolados: CLEARCHAT_USER_DATA sobrescreve o diretório userData (banco etc.). Antes do ready.
const isolatedUserData = process.env['CLEARCHAT_USER_DATA']
if (isolatedUserData) {
  app.setPath('userData', resolve(isolatedUserData))
}

// Uma instância por userData: um segundo processo abriria outro cliente de sync com a mesma sessão do
// dispositivo (os WebSockets se derrubam) e outro dono do banco. A segunda tentativa só traz a janela
// existente para a frente. O lock vale por userData, então testes com CLEARCHAT_USER_DATA isolados
// continuam podendo rodar lado a lado.
if (!app.requestSingleInstanceLock()) app.exit(0)

let mainWindow: BrowserWindow | null = null

app.on('second-instance', () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!win) {
    if (app.isReady()) mainWindow = createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

// clearchat-attachment://<sha256>.<ext> → arquivo do store de anexos (miniaturas no renderer).
// clearchat-file://<token>/<nome> → arquivo da allowlist do visualizador (present_file / aba
// Arquivos). Sem supportFetchAPI/corsEnabled: o renderer só usa em <img>/<iframe>; texto vem por IPC.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ATTACHMENT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  },
  { scheme: VIEWER_SCHEME, privileges: { standard: true, secure: true, stream: true } }
])

const THEME_BG = '#0b0b0f'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    backgroundColor: THEME_BG,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: THEME_BG, symbolColor: '#a1a1aa', height: 40 },
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })

  registerEventWindow(win)
  // botão direito: menu nativo (edição/seleção/links/imagens + ações da mensagem) — SPEC → "Menu de contexto"
  installContextMenu(win, { appActions: true })
  win.once('ready-to-show', () => win.show())

  // Voz: o estado do main (sessão de transcrição, chamada) é do renderer desta janela — se ele
  // recarregar, navegar, cair ou a janela fechar, nada fica órfão no main (SPEC → "Áudio").
  const wcId = win.webContents.id
  win.webContents.on('render-process-gone', (_e, details) =>
    resetVoiceForWebContents(wcId, `caiu (${details.reason})`)
  )
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument)
      resetVoiceForWebContents(wcId, 'recarregou/navegou')
  })
  win.on('closed', () => resetVoiceForWebContents(wcId, 'janela fechada'))

  // Links externos abrem no navegador do sistema, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)
  nativeTheme.themeSource = 'dark'
  // corretor ortográfico pt-BR + en-US nos campos de texto (macOS: corretor do sistema)
  setupSpellcheck(session.defaultSession)

  // F12 abre DevTools em dev; ignora Ctrl+R em produção.
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // Dados do nome antigo (~/.config/CleartChat/cleartchat.db) → ~/.config/ClearChat/clearchat.db.
  // Só no userData padrão; o diretório antigo fica intacto.
  if (!isolatedUserData) {
    try {
      const r = migrateLegacyData(app.getPath('userData'))
      if (r.migrated) console.log(`[clearchat] banco migrado (${r.reason}): ${r.from} → ${r.to}`)
      else if (r.reason.startsWith('error')) console.warn(`[clearchat] migração: ${r.reason}`)
    } catch (e) {
      console.error('[clearchat] migração', e)
    }
  }

  getDb()
  console.log(`[clearchat] db: ${getDbPath()}`)

  // Anexos: store content-addressed + GC de arquivos que nenhuma mensagem referencia.
  setAttachmentsDir(join(app.getPath('userData'), 'attachments'))
  // read_file: imagens grandes são reduzidas antes de ir ao modelo
  setImageProcessor(nativeImageProcessor(nativeImage))
  try {
    const gc = gcAttachments(attachmentsDir(), referencedFilesInDb(getDb()))
    if (gc.deleted.length) console.log(`[clearchat] anexos órfãos apagados: ${gc.deleted.length}`)
  } catch (e) {
    console.error('[clearchat] gc de anexos', e)
  }
  protocol.handle(ATTACHMENT_SCHEME, async (req) => {
    const file = parseAttachmentUrl(req.url.replace(/\/+$/, ''))
    if (!file) return new Response('bad request', { status: 400 })
    const serve = (): Response =>
      new Response(new Uint8Array(readAttachment(file)), {
        headers: { 'content-type': mimeForFile(file), 'cache-control': 'max-age=31536000' }
      })
    try {
      return serve()
    } catch {
      // ausente localmente: baixa do sync (anexo enviado por outro dispositivo)
      try {
        if (await syncEngine()?.ensureAttachment(file)) return serve()
      } catch {
        /* */
      }
      return new Response('not found', { status: 404 })
    }
  })

  // Visualizador de arquivos: só tokens emitidos pelo main (ver fileViewer.ts). Temporários de
  // arquivos remotos abertos no app: userData/tmp-viewer (limpa o que sobrou da última execução)
  setViewerTempDir(join(app.getPath('userData'), 'tmp-viewer'))
  protocol.handle(VIEWER_SCHEME, (req) => serveViewerRequest(req.url))
  setViewerDeviceSource(() => {
    const e = syncEngine()
    return e?.active && e.deviceId ? { id: e.deviceId, name: e.deviceName } : null
  })

  // Shell do usuário (descrição da tool `shell`) + ambiente do -ilc em segundo plano.
  initShell()
  // Processos em segundo plano: logs em userData/processes (antigos apagados) + evento por chat.
  setProcessLogDir(join(app.getPath('userData'), 'processes'))
  try {
    const old = gcProcessLogs()
    if (old.length) console.log(`[clearchat] logs de processos antigos apagados: ${old.length}`)
  } catch (e) {
    console.error('[clearchat] gc de logs de processos', e)
  }
  setProcessListener((chatId, processes) => emit({ type: 'processes-updated', chatId, processes }))
  // Saídas grandes de tools salvas em arquivo: userData/tool-outputs/<chat>/ — poda (idade,
  // orçamento total e pastas de chats que não existem mais).
  setToolOutputDir(join(app.getPath('userData'), 'tool-outputs'))
  try {
    const gone = gcToolOutputs({ liveChatIds: chatsRepo.list().map((c) => c.id) })
    if (gone.length) console.log(`[clearchat] saídas de tools antigas apagadas: ${gone.length}`)
  } catch (e) {
    console.error('[clearchat] gc de saídas de tools', e)
  }

  initRunner()
  registerIpc()
  mainWindow = createWindow()
  void initSync().catch((e) => console.error('[clearchat] sync', e))
  // Aviso de versão nova: consulta a última release no GitHub (poucos segundos após o start + a
  // cada 6 h). Só avisa — nada é baixado nem instalado. Testes isolados não consultam a rede.
  initUpdates(
    {
      currentVersion: app.getVersion(),
      onStatus: (status) => emit({ type: 'update-status', status })
    },
    { auto: !isolatedUserData }
  )

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  cleanViewerTemp()
  shutdownUpdates()
  shutdownSync()
  shutdownVoiceCall() // marcador de fim da chamada ativa antes de o runner parar de gravar
  shutdownRunner()
  shutdownSttWorker()
  shutdownTtsWorker()
  shutdownGpuVoice()
  killAllProcesses()
})
// garantia: nenhum process group de process_start fica órfão
process.on('exit', () => {
  killAllProcesses(0)
  shutdownGpuVoice()
})
app.on('will-quit', () => closeDb())
