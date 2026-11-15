// browse_url: carrega a página numa janela oculta e pega o HTML renderizado (depois do JS da
// página). Separado de web.ts (que formata o resultado) para testar no Electron sem o resto do app
// (e2e/browsePage.test.ts). A extração é pura, no main (pageExtract.ts).
//
// Tempo (2026-11-15 — "cada pouco ele dá timeout… na UOL é quase toda vez"): o HTML chega em
// décimos de segundo, mas páginas cheias de anúncio NUNCA disparam o load dentro do timeout — e o
// `executeJavaScript` do Electron só roda depois que a página para de carregar, então antes a ferramenta
// esperava 25 s e ainda falhava. Agora: espera o HTML (`dom-ready`, até `BROWSE_TIMEOUT`), dá até
// `LOAD_GRACE_MS` para o load (JS de SPAs), `SETTLE_MS` depois dele, e PARA o carregamento antes de
// ler o DOM. As requisições de anúncio/rastreamento nem saem (`isBlockedBrowseRequest`). Se ainda
// assim o DOM não vier, cai para o HTML cru do servidor (sem o JS da página).
import { BrowserWindow, session as electronSession, type Session } from 'electron'
import { LIMITS } from '@shared/limits'
import { isBlockedBrowseRequest } from './browseBlock'

/** Espera do HTML da página (`dom-ready`). */
export const BROWSE_TIMEOUT = 25_000
/** Depois do HTML: espera do load (anúncios podem não terminar nunca — a página é parada). */
export const LOAD_GRACE_MS = 4000
/** Depois do load: o JS da página termina de montar o conteúdo (SPAs). */
export const SETTLE_MS = 1500
/** Leitura do DOM (e do HTML cru, no plano B). */
const GRAB_TIMEOUT = 5000
const RAW_TIMEOUT = 10_000

// HTML renderizado (depois do JS da página)
const GRAB_JS = `(() => ({
  html: document.documentElement ? document.documentElement.outerHTML.slice(0, ${LIMITS.browseMaxHtmlChars}) : '',
  url: location.href,
  title: document.title || ''
}))()`

export interface LoadedPage {
  html: string
  url: string
  title: string
}

export interface BrowseLoad {
  page: LoadedPage
  /** O HTML não chegou em `BROWSE_TIMEOUT` (conteúdo parcial). */
  timedOut: boolean
  /** Como o HTML foi lido: DOM renderizado ou HTML cru do servidor (plano B). */
  source: 'dom' | 'raw'
}

export interface BrowseTimings {
  timeoutMs: number
  graceMs: number
  settleMs: number
}

const DEFAULT_TIMINGS: BrowseTimings = {
  timeoutMs: BROWSE_TIMEOUT,
  graceMs: LOAD_GRACE_MS,
  settleMs: SETTLE_MS
}

function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/** UA do Chromium sem os marcadores do Electron/app (sites tratam "Electron" como robô). */
export function cleanUserAgent(ua: string): string {
  return ua.replace(/ Electron\/\S+/, '').replace(/ clearchat\/\S+/i, '')
}

let browseSes: Session | null = null
/** Sessão em memória da ferramenta: sem permissões, sem downloads, sem anúncios/rastreadores. */
export function browseSession(): Session {
  if (browseSes) return browseSes
  const ses = electronSession.fromPartition('clearchat-browse') // em memória (não persistente)
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.on('will-download', (e) => e.preventDefault())
  ses.webRequest.onBeforeRequest((d, cb) =>
    cb(isBlockedBrowseRequest(d.url, d.resourceType) ? { cancel: true } : {})
  )
  browseSes = ses
  return ses
}

/**
 * Carrega `url` numa janela oculta e devolve o HTML (ver o cabeçalho). Erro legível → throw; abort →
 * AbortError.
 */
export async function loadPage(
  url: string,
  signal: AbortSignal,
  timings: Partial<BrowseTimings> = {}
): Promise<BrowseLoad> {
  const t = { ...DEFAULT_TIMINGS, ...timings }
  if (signal.aborted) throw abortError()
  const ses = browseSession()
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      images: false,
      spellcheck: false
    }
  })
  const wc = win.webContents
  wc.setAudioMuted(true)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  const timers: NodeJS.Timeout[] = []
  const sleep = (ms: number): Promise<void> => new Promise((r) => timers.push(setTimeout(r, ms)))
  let onAbort: (() => void) | null = null
  const aborted = new Promise<never>((_res, rej) => {
    onAbort = () => rej(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  const ua = cleanUserAgent(wc.getUserAgent())
  try {
    let finished = false
    // a resposta da página chegou (navegação do frame principal confirmada)
    let committed = false
    wc.on('did-navigate', () => {
      committed = true
    })
    const loaded = new Promise<'loaded'>((res) =>
      wc.once('did-finish-load', () => {
        finished = true
        res('loaded')
      })
    )
    const domReady = new Promise<'dom'>((res) => wc.once('dom-ready', () => res('dom')))
    const failed = new Promise<never>((_res, rej) => {
      wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
        if (isMain && code !== -3) rej(new Error(`falha ao carregar (${code} ${desc})`))
      })
    })
    failed.catch(() => {})
    void wc.loadURL(url, { userAgent: ua }).catch(() => {})
    const first = await Promise.race([
      domReady,
      loaded,
      failed,
      sleep(t.timeoutMs).then(() => 'timeout' as const),
      aborted
    ])
    const timedOut = first === 'timeout'
    if (!timedOut) {
      // o load (JS de SPAs) até a folga; com ele, o JS ainda monta o conteúdo
      if (!finished) await Promise.race([loaded, failed, sleep(t.graceMs), aborted])
      if (finished) await Promise.race([sleep(t.settleMs), aborted])
    }
    // anúncios ainda carregando: para (o DOM fica) — o executeJavaScript só roda com a página parada
    if (!wc.isDestroyed() && wc.isLoading()) wc.stop()
    // o servidor nem respondeu: não há DOM nem HTML cru a ler
    if (!committed) throw new Error(`timeout de ${t.timeoutMs / 1000}s`)
    const page = await Promise.race([
      wc.executeJavaScript(GRAB_JS, true) as Promise<LoadedPage>,
      sleep(GRAB_TIMEOUT).then(() => null),
      aborted
    ])
    if (page && page.html) return { page, timedOut, source: 'dom' }
    // plano B: o HTML cru do servidor (sem o JS da página)
    const raw = await rawHtml(ses, url, ua, signal).catch(() => {
      if (signal.aborted) throw abortError()
      return null // falhou ou passou do teto
    })
    if (raw) return { page: raw, timedOut, source: 'raw' }
    throw new Error(timedOut ? `timeout de ${t.timeoutMs / 1000}s` : 'timeout ao extrair conteúdo')
  } finally {
    timers.forEach(clearTimeout)
    if (onAbort) signal.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}

/** HTML cru do servidor (mesma sessão e UA), com teto de tempo. null = não é HTML/falhou. */
async function rawHtml(
  ses: Session,
  url: string,
  ua: string,
  signal: AbortSignal
): Promise<LoadedPage | null> {
  const ctrl = new AbortController()
  const stop = (): void => ctrl.abort()
  signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, RAW_TIMEOUT)
  try {
    const res = await ses.fetch(url, { headers: { 'user-agent': ua }, signal: ctrl.signal })
    if (!res.ok || !/html|xml/i.test(res.headers.get('content-type') ?? '')) return null
    const html = (await res.text()).slice(0, LIMITS.browseMaxHtmlChars)
    return html ? { html, url: res.url || url, title: '' } : null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}
