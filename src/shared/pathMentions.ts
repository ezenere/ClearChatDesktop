// Menções `@caminho` no texto das mensagens (composer e balões do usuário). Partes PURAS —
// compartilhadas pelo renderer, testes e o app mobile (vendorado): a sintaxe, a busca dos tokens
// fora de código, o token em digitação no cursor, a inserção de um item escolhido no popup e o
// filtro do índice de arquivos da raiz do chat. A menção é TEXTO NORMAL da mensagem (o modelo vê
// exatamente o que foi digitado); só a exibição destaca. Ver SPEC.md → "Menções @caminho".
//
// Sintaxe (caminhos relativos à raiz do chat, separador `/`):
//   @src/app.ts            sem espaços: `@` + caracteres até o próximo espaço; pontuação final
//                          (`.,;:!?` e fechamentos `)]}>`) não faz parte do caminho
//   @"docs/meu arquivo.md" com espaço, aspas ou pontuação no fim: entre aspas duplas (sem `"`
//                          dentro e numa linha só)
//   @src/                  pasta (barra no fim)
// O `@` só abre menção no começo do texto, depois de espaço ou de `(`/`[`/`{` (e-mails como
// `a@b.com` não contam). Dentro de cercas ``` / ~~~ e de `código` nada é menção.

/** Pontuação final que não faz parte de um caminho sem aspas. */
const TRAIL = /[.,;:!?)\]}>'"”’]+$/
/** Antes do `@`: começo, espaço ou abertura. */
const BEFORE = /[\s([{]/

export interface PathMention {
  /** Índice do `@` no texto. */
  start: number
  /** Fim (exclusivo) do token (inclui as aspas de fechamento; sem a pontuação final). */
  end: number
  /** Caminho (sem `@` nem aspas). */
  path: string
  quoted: boolean
  /** Token terminado: aspas fechadas, ou seguido de espaço/quebra de linha (o que vem depois do caminho). */
  complete: boolean
}

/** O caminho precisa de aspas para virar uma menção inteira. */
export function needsQuotes(path: string): boolean {
  return /[\s"'`]/.test(path) || TRAIL.test(path) || path.startsWith('"')
}

/** `@caminho` (com aspas quando preciso). Caminho com `"` ou quebra de linha não é representável → null. */
export function formatPathMention(path: string): string | null {
  if (!path || /["\n\r]/.test(path)) return null
  return needsQuotes(path) ? `@"${path}"` : `@${path}`
}

/** Parece caminho de arquivo/pasta: tem `/` ou `\`, ou um ponto seguido de letra/número (`a.ts`, `.env`). */
export function isPathLike(path: string): boolean {
  return /[\\/]/.test(path) || /\.[\p{L}\p{N}]/u.test(path)
}

/** Faixas de código (cercas ```/~~~ inteiras e spans de crases) — onde nada é menção. */
export function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = []
  const lines = text.split('\n')
  let pos = 0
  let fence: { ch: string; len: number; start: number } | null = null
  const inlineFrom: { from: number; to: number }[] = []
  for (const line of lines) {
    const lineEnd = pos + line.length
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (
        f &&
        f[1][0] === fence.ch &&
        f[1].length >= fence.len &&
        !line.slice(f[0].length).trim()
      ) {
        out.push([fence.start, lineEnd])
        fence = null
      }
    } else if (f && !(f[1][0] === '`' && line.slice(f[0].length).includes('`'))) {
      fence = { ch: f[1][0], len: f[1].length, start: pos }
    } else inlineFrom.push({ from: pos, to: lineEnd })
    pos = lineEnd + 1
  }
  if (fence) out.push([fence.start, text.length])
  // spans de crases (podem atravessar linhas normais, mas não cercas)
  for (const seg of mergeSegments(inlineFrom)) {
    const s = text.slice(seg.from, seg.to)
    const re = /`+/g
    let m: RegExpExecArray | null
    let open: { at: number; len: number } | null = null
    while ((m = re.exec(s))) {
      if (!open) open = { at: m.index, len: m[0].length }
      else if (m[0].length === open.len) {
        out.push([seg.from + open.at, seg.from + m.index + m[0].length])
        open = null
      }
    }
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** Junta linhas normais consecutivas (spans de crases podem continuar na linha seguinte). */
function mergeSegments(segs: { from: number; to: number }[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (const s of segs) {
    const last = out[out.length - 1]
    if (last && s.from === last.to + 1) last.to = s.to
    else out.push({ ...s })
  }
  return out
}

const inRanges = (i: number, ranges: [number, number][]): boolean =>
  ranges.some(([a, b]) => i >= a && i < b)

/** Lê o token que começa no `@` em `at` (null se não é menção). */
function tokenAt(text: string, at: number): PathMention | null {
  if (text[at] !== '@') return null
  if (at > 0 && !BEFORE.test(text[at - 1])) return null
  if (text[at + 1] === '"') {
    const close = text.indexOf('"', at + 2)
    const nl = text.indexOf('\n', at + 2)
    if (close < 0 || (nl >= 0 && nl < close)) {
      // aspas ainda abertas: menção em digitação (até o fim da linha)
      const end = nl < 0 ? text.length : nl
      const path = text.slice(at + 2, end)
      return path ? { start: at, end, path, quoted: true, complete: false } : null
    }
    const path = text.slice(at + 2, close)
    if (!path.trim()) return null
    return { start: at, end: close + 1, path, quoted: true, complete: true }
  }
  const m = /^[^\s"`]+/.exec(text.slice(at + 1))
  if (!m) return null
  const run = m[0]
  const path = run.replace(TRAIL, '')
  if (!path) return null
  const after = at + 1 + run.length
  return {
    start: at,
    end: at + 1 + path.length,
    path,
    quoted: false,
    complete: after < text.length && /\s/.test(text[after])
  }
}

/**
 * Menções do texto, fora de código. `pathLike` (padrão true): só tokens que parecem caminho
 * (`isPathLike`, ou entre aspas) — ou que `known(path)` reconhece (ex.: o índice da raiz).
 */
export function findPathMentions(
  text: string,
  opts: { pathLike?: boolean; known?: (path: string) => boolean } = {}
): PathMention[] {
  const out: PathMention[] = []
  if (!text.includes('@')) return out
  const code = codeRanges(text)
  const strict = opts.pathLike !== false
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (inRanges(i, code)) continue
    const t = tokenAt(text, i)
    // aspas sem fechar não são menção (só o popup do composer as trata, em digitação)
    if (!t || (t.quoted && !t.complete)) continue
    if (strict && !t.quoted && !isPathLike(t.path) && !opts.known?.(t.path)) continue
    out.push(t)
    i = t.end - 1
  }
  return out
}

/** Texto dividido em trechos normais e menções (para destacar). */
export function splitPathMentions(
  text: string,
  mentions: PathMention[]
): ({ text: string } | { text: string; mention: PathMention })[] {
  const out: ({ text: string } | { text: string; mention: PathMention })[] = []
  let pos = 0
  for (const m of mentions) {
    if (m.start > pos) out.push({ text: text.slice(pos, m.start) })
    out.push({ text: text.slice(m.start, m.end), mention: m })
    pos = m.end
  }
  if (pos < text.length) out.push({ text: text.slice(pos) })
  return out
}

// ---------------- digitação (popup do composer) ----------------

export interface MentionQuery {
  /** Índice do `@`. */
  start: number
  /** Fim do token em digitação (o cursor ou, sem aspas, até o próximo espaço). */
  end: number
  /** O que foi digitado depois do `@` (sem as aspas). */
  query: string
  quoted: boolean
}

/**
 * Menção sendo digitada no cursor (`caret` = selectionStart, sem seleção): o `@` válido mais
 * próximo antes do cursor cujo token chega até ele — sem aspas, sem espaço no meio; com `@"`, até
 * as aspas fecharem. Fora disso (ou dentro de código) → null.
 */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  for (let i = caret - 1; i >= lineStart; i--) {
    if (text[i] !== '@') continue
    if (i > 0 && !BEFORE.test(text[i - 1])) continue
    if (inRanges(i, codeRanges(text))) return null
    const quoted = text[i + 1] === '"'
    const body = text.slice(i + (quoted ? 2 : 1), caret)
    if (quoted) {
      if (body.includes('"')) return null // aspas já fechadas antes do cursor
    } else if (/[\s"`]/.test(body)) return null
    let end = caret
    if (!quoted) {
      const rest = /^[^\s"`]*/.exec(text.slice(caret))
      end = caret + (rest ? rest[0].length : 0)
    } else {
      const close = text.indexOf('"', caret)
      const nl = text.indexOf('\n', caret)
      if (close >= 0 && (nl < 0 || close < nl)) end = close + 1
    }
    return { start: i, end, query: body, quoted }
  }
  return null
}

/**
 * Aceita um item do popup: troca o token em digitação por `@caminho` (aspas quando preciso).
 * Pasta → `@pasta/` sem espaço (o popup continua, listando a pasta; com aspas, elas ficam abertas
 * para continuar digitando); arquivo → token completo + um espaço. Devolve o texto e o cursor.
 */
export function applyMention(
  text: string,
  q: MentionQuery,
  entry: { path: string; dir: boolean }
): { text: string; caret: number } {
  const before = text.slice(0, q.start)
  let after = text.slice(q.end)
  if (entry.dir) {
    const path = entry.path.endsWith('/') ? entry.path : `${entry.path}/`
    const token = needsQuotes(path.slice(0, -1)) ? `@"${path}` : `@${path}`
    return { text: before + token + after, caret: before.length + token.length }
  }
  const token = formatPathMention(entry.path) ?? `@${entry.path}`
  // arquivo: o token + um espaço (reaproveita o que já vinha depois)
  if (!after.startsWith(' ')) after = ` ${after}`
  return { text: before + token + after, caret: before.length + token.length + 1 }
}

// ---------------- índice da raiz (filtro do popup) ----------------

export interface MentionCandidate {
  /** Relativo à raiz, com `/`; pasta termina em `/`. */
  path: string
  dir: boolean
  /** Nome (último segmento, sem a barra). */
  name: string
  /** Pasta-mãe (com `/` no fim) ou ''. */
  parent: string
}

const candidate = (p: string): MentionCandidate => {
  const dir = p.endsWith('/')
  const clean = dir ? p.slice(0, -1) : p
  const i = clean.lastIndexOf('/')
  return { path: p, dir, name: clean.slice(i + 1), parent: i < 0 ? '' : clean.slice(0, i + 1) }
}

/** Subsequência (fuzzy): todos os caracteres de `q` em ordem em `s`; menor = mais junto. */
function fuzzyGap(s: string, q: string): number | null {
  let gap = 0
  let j = 0
  let last = -1
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) {
      if (last >= 0) gap += i - last - 1
      last = i
      j++
    }
  }
  return j === q.length ? gap : null
}

/**
 * Itens do popup para o que foi digitado depois do `@`, a partir do índice da raiz (caminhos
 * relativos com `/`, pastas com `/` no fim):
 * - com `/` (`src/comp`): só os filhos diretos de `src/`, filtrados pelo resto (prefixo > contém >
 *   fuzzy), pastas primeiro;
 * - sem `/`: vazio → o primeiro nível da raiz; senão a raiz inteira (nome começa com > nome contém >
 *   caminho contém > fuzzy no caminho), caminhos mais curtos primeiro.
 * Sem diferenciar maiúsculas. No máximo `limit`.
 */
export function filterMentionIndex(
  entries: readonly string[],
  query: string,
  limit = 50
): MentionCandidate[] {
  const q = query.toLowerCase()
  const slash = q.lastIndexOf('/')
  const scored: { c: MentionCandidate; score: number; tie: number }[] = []
  const listing = slash >= 0 || !q
  if (listing) {
    const dir = slash >= 0 ? q.slice(0, slash + 1) : ''
    const rest = slash >= 0 ? q.slice(slash + 1) : ''
    for (const p of entries) {
      const c = candidate(p)
      if (c.parent.toLowerCase() !== dir) continue
      const name = c.name.toLowerCase()
      let score: number | null
      if (!rest || name.startsWith(rest)) score = 0
      else if (name.includes(rest)) score = 1
      else {
        const g = fuzzyGap(name, rest)
        score = g === null ? null : 2 + g / 100
      }
      if (score === null) continue
      scored.push({ c, score: score + (c.dir ? 0 : 0.5), tie: 0 })
    }
  } else {
    for (const p of entries) {
      const c = candidate(p)
      const name = c.name.toLowerCase()
      const full = p.toLowerCase()
      let score: number | null
      if (name.startsWith(q)) score = 0
      else if (name.includes(q)) score = 1
      else if (full.includes(q)) score = 2
      else {
        const g = fuzzyGap(full, q)
        score = g === null ? null : 3 + Math.min(g, 500) / 1000
      }
      if (score === null) continue
      scored.push({ c, score, tie: p.replace(/\/$/, '').split('/').length })
    }
  }
  // listagem de pasta: alfabética (pastas primeiro); busca na raiz: mais raso e nome mais curto
  // (mais perto do digitado) primeiro
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.tie - b.tie ||
      (listing ? 0 : a.c.name.length - b.c.name.length) ||
      a.c.path.localeCompare(b.c.path)
  )
  return scored.slice(0, limit).map((s) => s.c)
}
