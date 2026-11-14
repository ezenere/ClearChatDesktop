// Menu de contexto (botão direito) — partes puras compartilhadas por main, preload, renderer e
// testes: ações do app numa lista fechada, o descritor que o renderer devolve ao main (validado),
// URL de pesquisa, links abríveis, nome do arquivo ao salvar imagem e Markdown → texto simples.
// Ver SPEC.md → "Menu de contexto".

/** main → renderer: "o que está sob o clique?" (`reqId`); renderer → main: resposta (`reqId`, descritor | null). */
export const CTX_QUERY_CHANNEL = 'ctx:query'
export const CTX_REPLY_CHANNEL = 'ctx:reply'
/** main → renderer: o usuário escolheu uma ação do app (`{ token, action }`). */
export const CTX_ACTION_CHANNEL = 'ctx:action'

/** Ações de cópia: o texto vem no descritor e o MAIN grava na área de transferência. */
export const CTX_COPY_ACTIONS = ['copyCode', 'copyMessage', 'copyMarkdown', 'fileCopyPath'] as const
/** Ações que o renderer executa (closures dos componentes; o main só devolve o nome). */
export const CTX_RUN_ACTIONS = [
  'editMessage',
  'regenerate',
  'fileMention',
  'fileRun',
  'fileOpenExternal',
  'fileShowInFolder',
  'fileSaveAs',
  'fileRename',
  'fileDelete'
] as const

export type CtxCopyAction = (typeof CTX_COPY_ACTIONS)[number]
export type CtxRunAction = (typeof CTX_RUN_ACTIONS)[number]
export type CtxAppAction = CtxCopyAction | CtxRunAction

/** Ordem e grupo no menu; rótulos fixos (o renderer nunca escolhe o texto do menu). */
export const CTX_APP_ITEMS: readonly {
  action: CtxAppAction
  label: string
  group: 'msg' | 'file'
}[] = [
  { action: 'copyCode', label: 'Copiar código', group: 'msg' },
  { action: 'copyMessage', label: 'Copiar mensagem', group: 'msg' },
  { action: 'copyMarkdown', label: 'Copiar como Markdown', group: 'msg' },
  { action: 'editMessage', label: 'Editar', group: 'msg' },
  { action: 'regenerate', label: 'Regenerar resposta', group: 'msg' },
  { action: 'fileMention', label: 'Mencionar no chat', group: 'file' },
  { action: 'fileRun', label: 'Executar…', group: 'file' },
  { action: 'fileOpenExternal', label: 'Abrir no app', group: 'file' },
  { action: 'fileShowInFolder', label: 'Mostrar na pasta', group: 'file' },
  { action: 'fileSaveAs', label: 'Salvar como…', group: 'file' },
  { action: 'fileCopyPath', label: 'Copiar caminho', group: 'file' },
  { action: 'fileRename', label: 'Renomear', group: 'file' },
  { action: 'fileDelete', label: 'Excluir', group: 'file' }
]

/** Teto de cada texto copiável que atravessa o IPC (mensagens enormes são cortadas). */
export const CTX_MAX_COPY = 4_000_000

/** O que o renderer devolve ao main para um clique direito dentro do app. */
export interface AppCtx {
  /** Identifica este clique; o `ctx:action` só vale com o mesmo token. */
  token: number
  /** Ações disponíveis agora (as mesmas regras da barra de ações do hover). */
  actions: CtxAppAction[]
  /** Texto de cada ação de cópia presente em `actions`. */
  copy: Partial<Record<CtxCopyAction, string>>
}

export const isCopyAction = (a: string): a is CtxCopyAction =>
  (CTX_COPY_ACTIONS as readonly string[]).includes(a)
export const isAppAction = (a: unknown): a is CtxAppAction =>
  typeof a === 'string' && CTX_APP_ITEMS.some((i) => i.action === a)

/**
 * Valida o descritor vindo do renderer (dado não confiável): só ações da lista, sem repetição;
 * cópia só com texto (string não vazia, cortada em CTX_MAX_COPY). Inválido → null.
 */
export function sanitizeAppCtx(raw: unknown): AppCtx | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { token?: unknown; actions?: unknown; copy?: unknown }
  if (typeof r.token !== 'number' || !Number.isSafeInteger(r.token)) return null
  if (!Array.isArray(r.actions)) return null
  const copyIn = r.copy && typeof r.copy === 'object' ? (r.copy as Record<string, unknown>) : {}
  const actions: CtxAppAction[] = []
  const copy: Partial<Record<CtxCopyAction, string>> = {}
  for (const a of r.actions) {
    if (!isAppAction(a) || actions.includes(a)) continue
    if (isCopyAction(a)) {
      const t = copyIn[a]
      if (typeof t !== 'string' || !t) continue
      copy[a] = t.slice(0, CTX_MAX_COPY)
    }
    actions.push(a)
  }
  return actions.length ? { token: r.token, actions, copy } : null
}

// ---------------- links, pesquisa, imagens ----------------

/** Só http(s) e mailto abrem no navegador/cliente de e-mail do sistema. */
export function isOpenableLink(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:' || p === 'mailto:'
  } catch {
    return false
  }
}

/** Texto da seleção como consulta: espaços colapsados, até 400 caracteres. */
export function searchQuery(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 400)
}

/**
 * Página de resultados no navegador para o buscador preferido do web_search (o 1º ligado):
 * Brave (site ou API) → search.brave.com; o resto (DuckDuckGo, Exa, Tavily — sem página de
 * resultados pública equivalente — ou nenhum) → DuckDuckGo.
 */
export function webSearchUrl(text: string, engine?: string | null): string {
  const q = encodeURIComponent(searchQuery(text))
  if (engine === 'brave-site' || engine === 'brave-api')
    return `https://search.brave.com/search?q=${q}`
  return `https://duckduckgo.com/?q=${q}`
}

/** Escapa o `&` (mnemônico no Windows/Linux) de texto vindo da página. */
export const menuText = (s: string): string => s.replace(/&/g, '&&')

/** "Pesquisar na web: “…”" com a seleção encurtada (até 32 caracteres). */
export function searchLabel(text: string): string {
  const q = searchQuery(text)
  const short = q.length > 32 ? `${q.slice(0, 31).trimEnd()}…` : q
  return `Pesquisar na web: “${menuText(short)}”`
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif'
}

/** Esquemas de imagem que "Salvar imagem como…" sabe ler. */
export const SAVEABLE_IMAGE_SCHEMES = [
  'http:',
  'https:',
  'data:',
  'blob:',
  'clearchat-attachment:',
  'clearchat-file:'
]

export function isSaveableImage(url: string): boolean {
  try {
    return SAVEABLE_IMAGE_SCHEMES.includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** Nome sugerido ao salvar uma imagem (sem barras nem caracteres de controle). */
export function imageFileName(url: string): string {
  const clean = (s: string): string =>
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'imagem.png'
  }
  if (u.protocol === 'data:') {
    const mime = /^data:([^;,]+)/.exec(url)?.[1]?.toLowerCase() ?? ''
    return `imagem.${IMAGE_EXT[mime] ?? 'png'}`
  }
  if (u.protocol === 'clearchat-attachment:') {
    const ext = /\.([a-z0-9]{1,10})\/?$/.exec(url)?.[1]
    return `imagem.${ext ?? 'png'}`
  }
  const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
  let name: string
  try {
    name = clean(decodeURIComponent(last))
  } catch {
    name = clean(last)
  }
  if (!name) return 'imagem.png'
  return /\.[a-z0-9]{1,5}$/i.test(name) ? name : `${name}.png`
}

// ---------------- Markdown → texto simples ("Copiar mensagem") ----------------

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

function inlinePlain(s: string): string {
  // spans de código ficam literais: o resto perde a marcação
  const parts = s.split(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) out += plainText(parts[i])
    else if (i % 3 === 2) out += parts[i].replace(/^ (.*) $/, '$1')
  }
  return out
}

function plainText(s: string): string {
  // escapes (\*, \_…) viram marcadores privados antes de tirar a ênfase e voltam no fim
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, (_m, c: string) => `\uE000${c.charCodeAt(0)}\uE001`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()]*\))+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1$2')
    .replace(/\uE000(\d+)\uE001/g, (_m, n: string) => String.fromCharCode(Number(n)))
}

/**
 * Texto da resposta sem a marcação do Markdown (o que se lê na tela): cercas de código somem (o
 * conteúdo fica), títulos/citações/ênfase/links/imagens viram o texto, marcadores de lista viram
 * "• " (tarefas ☐/☑), tabelas viram linhas com tabulação e separadores somem. Puro, sem parser —
 * aproximação boa para copiar, não um renderizador.
 */
export function markdownToPlainText(md: string): string {
  const out: string[] = []
  let fence: { char: string; len: number } | null = null
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE.exec(raw)
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && !f[2].trim()) fence = null
      else out.push(raw)
      continue
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = { char: f[1][0], len: f[1].length }
      continue
    }
    let line = raw
    // regra horizontal / sublinhado de título setext
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line) || /^ {0,3}=+ *$/.test(line)) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    while (/^ {0,3}> ?/.test(line)) line = line.replace(/^ {0,3}> ?/, '')
    const h = /^ {0,3}#{1,6}(?:\s+(.*?))?\s*#*\s*$/.exec(line)
    if (h) {
      out.push(inlinePlain(h[1] ?? ''))
      continue
    }
    // tabela: separador some; linhas → células com tabulação
    if (/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line)) continue
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((c) => inlinePlain(c.trim()).replace(/\\\|/g, '|'))
      out.push(cells.join('\t'))
      continue
    }
    const li = /^(\s*)(?:[-*+])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line)
    if (li) {
      const box = li[2] === undefined ? '' : li[2] === ' ' ? '☐ ' : '☑ '
      out.push(`${li[1]}• ${box}${inlinePlain(li[3])}`)
      continue
    }
    out.push(inlinePlain(line.replace(/ {2,}$/, '')))
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
