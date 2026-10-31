// Aviso de versão nova (SPEC → "Atualizações"). Só lógica pura: o main consulta a última release
// publicada no GitHub (sem chave, sem telemetria) e o renderer mostra um aviso discreto. Nada é
// baixado nem instalado — "Baixar" só abre a página da release no navegador.

/** Repositório do app no GitHub — fonte única das URLs de release (API e página). */
export const APP_REPO = { owner: 'ezenere', name: 'ClearChatDesktop' } as const

/** Nome antigo do repositório (o GitHub redireciona; links antigos continuam válidos). */
const LEGACY_REPO_NAMES = ['ClearChat']

/** Última release publicada (o endpoint já exclui rascunhos e pré-releases). */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${APP_REPO.owner}/${APP_REPO.name}/releases/latest`

/** Página das releases (fallback do "Baixar" quando a resposta não traz `html_url`). */
export const RELEASES_PAGE = `https://github.com/${APP_REPO.owner}/${APP_REPO.name}/releases`

/** Primeira checagem alguns segundos depois do start (não disputa com o boot). */
export const UPDATE_FIRST_CHECK_MS = 8_000
/** Depois, a cada 6 h enquanto o app estiver aberto. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Setting local (não sincronizado): última versão cujo aviso o usuário dispensou. */
export const UPDATE_DISMISSED_KEY = 'updateDismissedVersion'

export interface LatestRelease {
  /** Sem o "v" do tag (ex.: "0.7.0"). */
  version: string
  /** Página da release (https://github.com/ezenere/ClearChatDesktop/releases/tag/…). */
  url: string
  name?: string
  publishedAt?: string
}

export interface UpdateStatus {
  /** `app.getVersion()`. */
  current: string
  /**
   * idle = ainda não checou; checking; latest = esta é a mais recente; available = há versão nova;
   * error = a última checagem falhou (rede, limite da API, resposta inválida) — silencioso: só
   * aparece como texto em Configurações, nunca como toast.
   */
  state: 'idle' | 'checking' | 'latest' | 'available' | 'error'
  /** Última release conhecida (mantida numa falha posterior). */
  latest?: LatestRelease
  /** Fim da última checagem (ms). */
  checkedAt?: number
  /** Motivo legível da última falha. */
  error?: string
}

/** "v0.7.0" / "0.7.0" / "0.7" → [0, 7, 0]; pré-release/build ("-beta.1", "+abc") é ignorado. */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?\s*$/i.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

/** Compara major.minor.patch numericamente: <0 se a < b, 0 se iguais, >0 se a > b. Inválida = 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0]
  const pb = parseVersion(b) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** Só https://github.com/ezenere/ClearChatDesktop/… ou o nome antigo (o GitHub não diferencia caixa no dono/repo). */
export function isReleaseUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username) return false
  const [, owner, repo] = u.pathname.split('/')
  return (
    owner?.toLowerCase() === APP_REPO.owner.toLowerCase() &&
    [APP_REPO.name, ...LEGACY_REPO_NAMES].some((n) => repo?.toLowerCase() === n.toLowerCase())
  )
}

/** JSON de /releases/latest → release; null se faltar/for inválido o tag ou for rascunho/pré. */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (!json || typeof json !== 'object') return null
  const r = json as Record<string, unknown>
  if (r.draft === true || r.prerelease === true) return null
  if (typeof r.tag_name !== 'string' || !parseVersion(r.tag_name)) return null
  const version = r.tag_name.trim().replace(/^v/i, '')
  const out: LatestRelease = {
    version,
    url: isReleaseUrl(r.html_url) ? r.html_url : RELEASES_PAGE
  }
  if (typeof r.name === 'string' && r.name.trim()) out.name = r.name.trim()
  if (typeof r.published_at === 'string') out.publishedAt = r.published_at
  return out
}

/** Há versão mais nova que a instalada? */
export function isNewer(latest: LatestRelease | undefined, current: string): boolean {
  return !!latest && compareVersions(latest.version, current) > 0
}

/**
 * Mostrar o aviso da sidebar: há versão mais nova e o usuário não dispensou ESTA versão (nem uma
 * posterior — dispensar a 0.8 também cala a 0.7 de um cache antigo). Volta para uma versão maior.
 */
export function shouldShowUpdateNotice(
  status: UpdateStatus | null | undefined,
  dismissedVersion: string | null | undefined
): boolean {
  if (!status?.latest || !isNewer(status.latest, status.current)) return false
  if (dismissedVersion && compareVersions(status.latest.version, dismissedVersion) <= 0)
    return false
  return true
}
