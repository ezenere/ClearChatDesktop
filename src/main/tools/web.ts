// web_search (buscadores em ordem de prioridade com fallback — DuckDuckGo, Brave (site), Brave
// Search API, Exa, Tavily; lógica pura em webSearch.ts) e browse_url (BrowserWindow oculta).
import { BrowserWindow } from 'electron'
import {
  BROWSE_TIMEOUT,
  SETTLE_MS,
  browseSession,
  cleanUserAgent,
  loadPage,
  type LoadedPage
} from './browsePage'
import { isBraveBlocked } from './brave'
import {
  fmtSecs,
  normalizeSearchInterval,
  runEngine,
  runGatedWebSearch,
  SEARCH_INTERVAL_SETTING,
  SearchGate,
  type HttpResponse,
  type SearchBackends,
  type SearchPage
} from './webSearch'
import { settingsRepo } from '../repo'
import { getEngineEntry, getSearchPlan } from '../webSearchConfig'
import type { WebSearchTestResult } from '@shared/ipc'
import {
  API_ENGINE_IDS,
  ENGINE_DEFAULT_BASE,
  engineBaseEnv,
  type ApiEngineId,
  type EngineHttpRequest,
  type SearchEngineId
} from '@shared/webSearchSettings'
import { LIMITS } from '@shared/limits'
import { extractPage, formatExtracted, type ExtractMode } from './pageExtract'
import {
  abortError,
  fail,
  ok,
  optBool,
  optNumber,
  optString,
  requireString,
  type ToolContext,
  type ToolResult
} from './util'

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'

async function ddgFetch(
  query: string,
  method: 'POST' | 'GET',
  signal: AbortSignal
): Promise<string> {
  const base = baseOf('ddg')
  const timeout = AbortSignal.timeout(20_000)
  const sig = AbortSignal.any([signal, timeout])
  const res =
    method === 'POST'
      ? await fetch(base, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: 'https://html.duckduckgo.com/',
            'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
          },
          body: new URLSearchParams({ q: query, b: '' }).toString(),
          signal: sig
        })
      : await fetch(`${base}?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
          signal: sig
        })
  const text = await res.text()
  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`)
  return text
}

/** Base de um buscador: env CLEARCHAT_SEARCH_BASE_<ID> (testes/proxy) ou a oficial. */
function baseOf(id: SearchEngineId): string {
  return process.env[engineBaseEnv(id)]?.trim() || ENGINE_DEFAULT_BASE[id]
}

const API_TIMEOUT = 20_000

/** HTTP das APIs de busca (fetch do Node: descompacta gzip sozinho). Lança só em rede/timeout. */
async function apiFetch(req: EngineHttpRequest, signal: AbortSignal): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(API_TIMEOUT)
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.any([signal, timeout])
    })
    return { status: res.status, text: await res.text() }
  } catch (e) {
    if (signal.aborted) throw abortError()
    if (timeout.aborted) throw new Error(`timeout de ${API_TIMEOUT / 1000} s`, { cause: e })
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    throw new Error(cause?.code || cause?.message || (e as Error).message, { cause: e })
  }
}

function backends(): SearchBackends {
  const bases: Partial<Record<ApiEngineId, string>> = {}
  for (const id of API_ENGINE_IDS) bases[id] = baseOf(id)
  return { ddg: ddgFetch, brave: braveFetch, http: apiFetch, bases }
}

/** Intervalo mínimo GLOBAL entre pesquisas (todos os chats/sessões/subagentes do processo). */
const searchGate = new SearchGate({
  intervalMs: () => normalizeSearchInterval(settingsRepo.get(SEARCH_INTERVAL_SETTING)) * 1000
})

export async function webSearch(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = requireString(args, 'query').trim()
  let waited = false
  const r = await runGatedWebSearch(
    query,
    backends(),
    ctx.signal,
    searchGate,
    (ms) => {
      waited = true
      ctx.onOutput?.(`Aguardando intervalo entre pesquisas… (${fmtSecs(ms)} s)`)
    },
    getSearchPlan()
  )
  if (waited) ctx.onOutput?.('Pesquisando…')
  // grande → arquivo (runToolImpl); erro fica inline
  return r.status === 'error' ? r : ok(r.content)
}

// "Testar" (Configurações → Pesquisa na web): UMA pesquisa pequena no buscador, fora do intervalo
// global (não consome nem espera a vez das pesquisas do agente), com freio leve: um teste por vez
// por buscador e no máximo um a cada TEST_COOLDOWN_MS.
const TEST_QUERY = 'ClearChat open source'
const TEST_COOLDOWN_MS = 3000
const lastTest = new Map<SearchEngineId, number>()
const testing = new Set<SearchEngineId>()

export async function testWebSearchEngine(id: SearchEngineId): Promise<WebSearchTestResult> {
  const entry = getEngineEntry(id)
  if (testing.has(id))
    return { ok: false, throttled: true, message: 'Já há um teste em andamento.' }
  const since = Date.now() - (lastTest.get(id) ?? -Infinity)
  if (since < TEST_COOLDOWN_MS)
    return {
      ok: false,
      throttled: true,
      message: `Aguarde ${fmtSecs(TEST_COOLDOWN_MS - since)} s para testar de novo.`
    }
  testing.add(id)
  lastTest.set(id, Date.now())
  const t0 = Date.now()
  try {
    const opts = entry.options?.maxResults ? { ...entry.options, maxResults: 3 } : entry.options
    const o = await runEngine(
      { ...entry, options: opts },
      TEST_QUERY,
      backends(),
      AbortSignal.timeout(30_000)
    )
    const ms = Date.now() - t0
    if (o.kind === 'fail') return { ok: false, message: o.message, ms }
    const count = o.kind === 'results' ? o.results.length : 0
    return {
      ok: true,
      count,
      ms,
      message: `${count} resultado${count === 1 ? '' : 's'} em ${fmtSecs(ms)} s`
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  } finally {
    testing.delete(id)
  }
}

/**
 * Brave Search: `fetch` simples recebe 429 + página "needs JavaScript / captcha"; a página carregada
 * numa BrowserWindow oculta (UA de Chrome, sem "Electron") vem completa (SSR). Devolve o HTML
 * renderizado — o parse é puro (brave.ts).
 */
export async function braveFetch(query: string, signal: AbortSignal): Promise<SearchPage> {
  const url = `${baseOf('brave-site')}?q=${encodeURIComponent(query)}`
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session: browseSession(),
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
  let status: number | undefined
  wc.on('did-navigate', (_e, _u, code) => {
    if (code > 0) status = code
  })
  const html = (): Promise<string> =>
    Promise.race([
      wc.executeJavaScript('document.documentElement.outerHTML', true) as Promise<string>,
      sleep(5000).then(() => {
        throw new Error('timeout ao ler a página')
      }),
      aborted
    ])
  try {
    if (signal.aborted) throw abortError()
    const loaded = new Promise<'loaded'>((res, rej) => {
      wc.once('did-finish-load', () => res('loaded'))
      wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
        if (isMain && code !== -3) rej(new Error(`falha ao carregar (${code} ${desc})`))
      })
    })
    loaded.catch(() => {})
    void wc.loadURL(url, { userAgent: cleanUserAgent(wc.getUserAgent()) }).catch(() => {})
    const first = await Promise.race([
      loaded,
      sleep(BRAVE_TIMEOUT).then(() => 'timeout' as const),
      aborted
    ])
    // ainda carregando: para (o executeJavaScript só roda com a página parada)
    if (first === 'timeout' && wc.isLoading()) wc.stop()
    let page = await html()
    // SSR: os resultados já vêm no load; se não vieram (hidratação lenta), espera um pouco.
    if (!/data-type="web"/.test(page) && !isBraveBlocked(page, status)) {
      await Promise.race([sleep(SETTLE_MS), aborted])
      page = await html()
    }
    if (first === 'timeout' && !/data-type="web"/.test(page))
      throw new Error(`timeout de ${BRAVE_TIMEOUT / 1000}s`)
    return { html: page, status }
  } finally {
    timers.forEach(clearTimeout)
    if (onAbort) signal.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
  }
}

const BRAVE_TIMEOUT = 20_000

// ---------------- browse_url ----------------
// Carregamento (janela oculta, anúncios bloqueados, página parada depois do HTML): browsePage.ts.

/** Página carregada por sessão + URL (trocar mode/links ou usar offset não recarrega). */
const pageCache = new Map<string, { at: number; page: LoadedPage; timedOut: boolean }>()

function cacheGet(key: string): { page: LoadedPage; timedOut: boolean } | null {
  const now = Date.now()
  for (const [k, v] of pageCache) if (now - v.at > LIMITS.browseCacheMs) pageCache.delete(k)
  return pageCache.get(key) ?? null
}

function cacheSet(key: string, page: LoadedPage, timedOut: boolean): void {
  pageCache.delete(key)
  pageCache.set(key, { at: Date.now(), page, timedOut })
  while (pageCache.size > LIMITS.browseCacheEntries) {
    const oldest = pageCache.keys().next().value
    if (oldest === undefined) break
    pageCache.delete(oldest)
  }
}

/** Texto ao modelo: Markdown do conteúdo (mode main/full) — grande vai para arquivo (runToolImpl). */
function renderPage(
  page: LoadedPage,
  opts: { mode: ExtractMode; links: boolean; offset: number },
  timedOut: boolean,
  fromCache: boolean
): string {
  const p = extractPage(page.html, page.url, {
    mode: opts.mode,
    links: opts.links,
    maxLinks: LIMITS.browseMaxLinks
  })
  if (!p.title) p.title = page.title
  return formatExtracted(p, {
    timedOut,
    timeoutS: BROWSE_TIMEOUT / 1000,
    fromCache,
    offset: opts.offset
  })
}

export async function browseUrl(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const raw = requireString(args, 'url').trim()
  const modeArg = optString(args, 'mode')
  if (modeArg && modeArg !== 'main' && modeArg !== 'full')
    return fail(
      'Erro: mode deve ser "main" (padrão: só o conteúdo principal) ou "full" (página inteira).'
    )
  const opts = {
    mode: (modeArg ?? 'main') as ExtractMode,
    links: optBool(args, 'links'),
    // legado: antes da saída em arquivo o texto era paginado por offset (caracteres)
    offset: Math.max(0, Math.floor(optNumber(args, 'offset') ?? 0))
  }
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return fail(`Erro: URL inválida: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('Erro: apenas URLs http/https são permitidas.')
  }
  if (ctx.signal.aborted) throw abortError()
  const cacheKey = `${ctx.cacheKey ?? ''}|${url.toString()}`
  // cache só ao reler a mesma página de outro jeito (mode/links/offset); chamada simples recarrega
  const reuse = opts.offset > 0 || modeArg !== undefined || args.links !== undefined
  const hit = reuse ? cacheGet(cacheKey) : null
  if (hit) return ok(renderPage(hit.page, opts, hit.timedOut, true))
  try {
    const { page, timedOut } = await loadPage(url.toString(), ctx.signal)
    cacheSet(cacheKey, page, timedOut)
    return ok(renderPage(page, opts, timedOut, false))
  } catch (e) {
    if ((e as Error).name === 'AbortError' || ctx.signal.aborted) throw abortError()
    return fail(`Erro ao abrir ${url.toString()}: ${(e as Error).message}`)
  }
}
