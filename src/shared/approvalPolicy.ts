// Aprovações: modo por ITEM (always | smart | lists) + listas GLOBAIS de permissão/bloqueio.
// Funções puras — main (runner) e renderer (Configurações → Aprovações, "Testar", card).
// Ver SPEC.md → "Aprovações".
//
// Itens: commands (shell) · processes (process_start) · pages (browse_url) · search (web_search) ·
// writeFile (write_file) · editFile (edit_file) · sendToChat (send_to_chat) · delegate (delegate_task) ·
// memory_write · memory_rewrite · memory_delete (tools de memória — mesmos nomes) ·
// schedule (criar agendamento — vale o mais restritivo entre ele e a tool agendada; @shared/schedule).
// Modo efetivo = override do chat (ChatConfig.approvalModes[item]) ?? global (settings
// `approvalModes`) ?? DEFAULT_APPROVAL_MODES.
//   always → roda sem perguntar (blacklist NÃO vale).
//   smart  → o juiz do Smart-Approve decide (config do chat). Sem modelo escolhido → pergunta
//            (fail-closed). commands/processes/pages: as listas valem antes (blacklist bloqueia;
//            100% whitelist roda sem juiz) e o juiz decide só o que sobrou (smartListPlan).
//   lists  → commands/processes/pages: cada sub-comando (ou a URL) contra blacklist (bloqueia tudo,
//            precede) e whitelist; o que sobrar → card com uma decisão por item.
//            demais itens (search, arquivos, chats, subagentes): sem listas — pergunta sim/não.
import { analyzeShell, shellQuote, type ShellCommand } from './shellParse'
import { detectScript, SCRIPT_PREVIEW, scriptHead } from './scriptPreview'
import {
  isReadOnlyTokens,
  protectedHits,
  protectedText,
  type ProtectedHit,
  type SafetyCtx
} from './approvalSafety'
import { normalizeSmartDefaults } from './smartDefaults'
import {
  CONFIRM_TOOLS,
  type ApprovalCheck,
  type ApprovalCheckItem,
  type ApprovalItem,
  type ApprovalList,
  type ApprovalListItem,
  type ApprovalMode,
  type ApprovalScript,
  type ApprovalSettings,
  type ChatConfig,
  type SmartApproveConfig,
  type ToolName
} from './types'

export const APPROVAL_ITEMS: ApprovalItem[] = [
  'commands',
  'processes',
  'pages',
  'search',
  'writeFile',
  'editFile',
  'sendToChat',
  'delegate',
  'memory_write',
  'memory_rewrite',
  'memory_delete',
  'schedule'
]
/** Grupos da UI (Configurações → Aprovações e aba Tools). */
export const APPROVAL_ITEM_GROUPS: { title: string; items: ApprovalItem[] }[] = [
  { title: 'Terminal e web', items: ['commands', 'processes', 'pages', 'search'] },
  { title: 'Arquivos e agentes', items: ['writeFile', 'editFile', 'sendToChat', 'delegate'] },
  { title: 'Memória', items: ['memory_write', 'memory_rewrite', 'memory_delete'] },
  { title: 'Agendamentos', items: ['schedule'] }
]
export const APPROVAL_LIST_ITEMS: ApprovalListItem[] = ['commands', 'processes', 'pages']
export const APPROVAL_MODES: ApprovalMode[] = ['always', 'smart', 'lists']

export const APPROVAL_MODES_SETTING = 'approvalModes'
export const APPROVAL_LISTS_SETTING = 'approvalLists'

export const ITEM_TOOL: Record<ApprovalItem, ToolName> = {
  commands: 'shell',
  processes: 'process_start',
  pages: 'browse_url',
  search: 'web_search',
  writeFile: 'write_file',
  editFile: 'edit_file',
  sendToChat: 'send_to_chat',
  delegate: 'delegate_task',
  memory_write: 'memory_write',
  memory_rewrite: 'memory_rewrite',
  memory_delete: 'memory_delete',
  schedule: 'schedule'
}

export const TOOL_ITEM: Partial<Record<ToolName, ApprovalItem>> = {
  shell: 'commands',
  process_start: 'processes',
  browse_url: 'pages',
  web_search: 'search',
  write_file: 'writeFile',
  edit_file: 'editFile',
  send_to_chat: 'sendToChat',
  delegate_task: 'delegate',
  memory_write: 'memory_write',
  memory_rewrite: 'memory_rewrite',
  memory_delete: 'memory_delete',
  schedule: 'schedule'
}

/** Tools que passam pelo gate de aprovação (uma por item). */
export const APPROVAL_TOOLS: ToolName[] = APPROVAL_ITEMS.map((i) => ITEM_TOOL[i])

export const ITEM_LABEL: Record<ApprovalItem, string> = {
  commands: 'Comandos',
  processes: 'Processos',
  pages: 'Páginas',
  search: 'Busca web',
  writeFile: 'Escrever arquivo',
  editFile: 'Editar arquivo',
  sendToChat: 'Enviar para chat',
  delegate: 'Delegar a subagente',
  memory_write: 'Gravar memória',
  memory_rewrite: 'Reescrever memória',
  memory_delete: 'Apagar memória',
  schedule: 'Criar agendamento'
}

/** Item com whitelist/blacklist (commands, processes, pages). Nos demais, `lists` = "Perguntar". */
export function isListItem(
  item: ApprovalItem | 'mcp' | null | undefined
): item is ApprovalListItem {
  return !!item && (APPROVAL_LIST_ITEMS as string[]).includes(item)
}

/** Nome da lista no texto de bloqueio ("Bloqueado pela blacklist (comandos)…"). */
export const ITEM_LIST_NAME: Record<ApprovalListItem, string> = {
  commands: 'comandos',
  processes: 'processos',
  pages: 'páginas'
}

export const MODE_LABEL: Record<ApprovalMode, string> = {
  always: 'Sempre permitir',
  smart: 'Smart-Approve',
  lists: 'Listas'
}

/** Rótulo do modo para um item (itens sem listas: "Perguntar"). */
export function modeLabel(item: ApprovalItem, mode: ApprovalMode): string {
  return mode === 'lists' && !isListItem(item) ? 'Perguntar' : MODE_LABEL[mode]
}

/** Explicação curta de cada opção (tooltip do seletor). */
export function modeHint(item: ApprovalItem, mode: ApprovalMode): string {
  if (mode === 'always')
    return isListItem(item) ? 'Roda sem perguntar (nem a blacklist vale)' : 'Roda sem perguntar'
  if (mode === 'smart')
    return isListItem(item)
      ? 'Blacklist bloqueia e whitelist libera; o juiz do Smart-Approve decide o resto (sem modelo → pergunta)'
      : 'O modelo juiz do Smart-Approve aprova ou pergunta a você (sem modelo → pergunta)'
  return isListItem(item)
    ? 'Whitelist libera, blacklist bloqueia; o resto pergunta'
    : 'Pergunta a você a cada chamada'
}

/**
 * Padrão global: Comandos/Processos/Páginas/Busca em `lists` (com listas vazias = pergunta sempre —
 * o comportamento das versões anteriores; o usuário vai liberando com "+ whitelist"). Busca web
 * também pergunta: a consulta sai para um serviço externo (DuckDuckGo, Brave, Exa, Tavily…) e pode vazar contexto.
 * Arquivos, chats e subagentes: `always` (rodavam sem perguntar antes de virarem itens).
 * Memória (gravar/reescrever/apagar): `always` — a terceira opção é "Perguntar".
 * Agendamentos: `lists` (= Perguntar) — o agendamento continua rodando sem ninguém olhando.
 */
export const DEFAULT_APPROVAL_MODES: Record<ApprovalItem, ApprovalMode> = {
  commands: 'lists',
  processes: 'lists',
  pages: 'lists',
  search: 'lists',
  writeFile: 'always',
  editFile: 'always',
  sendToChat: 'always',
  delegate: 'always',
  memory_write: 'always',
  memory_rewrite: 'always',
  memory_delete: 'always',
  schedule: 'lists'
}

const isMode = (v: unknown): v is ApprovalMode =>
  typeof v === 'string' && (APPROVAL_MODES as string[]).includes(v)

export function normalizeApprovalModes(v: unknown): Record<ApprovalItem, ApprovalMode> {
  const src = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const out = { ...DEFAULT_APPROVAL_MODES }
  for (const k of APPROVAL_ITEMS) if (isMode(src[k])) out[k] = src[k]
  return out
}

/** Override por chat: só itens/modos válidos (vazio = segue o global). */
export function normalizeChatModes(v: unknown): Partial<Record<ApprovalItem, ApprovalMode>> {
  const src = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const out: Partial<Record<ApprovalItem, ApprovalMode>> = {}
  for (const k of APPROVAL_ITEMS) if (isMode(src[k])) out[k] = src[k]
  return out
}

const cleanList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') continue
    const t = x.replace(/\s+/g, ' ').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

export function normalizeApprovalLists(v: unknown): Record<ApprovalListItem, ApprovalList> {
  const src = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const out = {} as Record<ApprovalListItem, ApprovalList>
  for (const k of APPROVAL_LIST_ITEMS) {
    const l = src[k] && typeof src[k] === 'object' ? (src[k] as Record<string, unknown>) : {}
    out[k] = { allow: cleanList(l.allow), deny: cleanList(l.deny) }
  }
  return out
}

export function normalizeApprovalSettings(
  modes: unknown,
  lists: unknown,
  smart?: unknown
): ApprovalSettings {
  return {
    modes: normalizeApprovalModes(modes),
    lists: normalizeApprovalLists(lists),
    smart: normalizeSmartDefaults(smart)
  }
}

/** Modo efetivo de um item num chat. */
export function effectiveMode(
  cfg: Pick<ChatConfig, 'approvalModes'> | null | undefined,
  global: Partial<Record<ApprovalItem, ApprovalMode>> | null | undefined,
  item: ApprovalItem
): ApprovalMode {
  const c = cfg?.approvalModes?.[item]
  if (isMode(c)) return c
  const g = global?.[item]
  return isMode(g) ? g : DEFAULT_APPROVAL_MODES[item]
}

/**
 * Aba Tools / personas (★ = padrão global): escolher a opção igual ao modo global grava "sem
 * override" (o chat segue o global, inclusive se ele mudar depois); outra opção grava o override.
 * `choice` null = voltar ao global. Retorna um objeto novo.
 */
export function withChatMode(
  overrides: Partial<Record<ApprovalItem, ApprovalMode>> | null | undefined,
  item: ApprovalItem,
  choice: ApprovalMode | null,
  global: Partial<Record<ApprovalItem, ApprovalMode>> | null | undefined
): Partial<Record<ApprovalItem, ApprovalMode>> {
  const next = normalizeChatModes(overrides)
  const g = isMode(global?.[item]) ? global![item]! : DEFAULT_APPROVAL_MODES[item]
  if (!choice || choice === g) delete next[item]
  else next[item] = choice
  return next
}

// ---------------- padrões de comando ----------------
// Casamento por TOKENS (mesmo tokenizer do comando: aspas removidas, espaços colapsados).
// - `*` como token sozinho (sem aspas) casa ZERO ou mais tokens;
// - `*` dentro de um token é glob dentro do token (`npm run test:*` casa `test:unit`);
// - `\*`, `'*'` ou `"*"` = asterisco literal;
// - sem `*` → casa EXATO (mesmos tokens, mesma quantidade).
// Programa (1º token): na BLACKLIST, um padrão sem `/` também casa o basename do comando
// (`rm *` bloqueia `/bin/rm -rf x`); na WHITELIST, não (`ls *` não libera `./ls` nem `/tmp/x/ls`).

interface PatTok {
  /** Partes literais separadas por wildcards (glob em token). */
  parts: string[]
  /** Token = `*` sozinho (multi-token). */
  any: boolean
}

/** Tokeniza um padrão. null = inválido (aspas sem fechamento). */
export function parsePattern(pattern: string): PatTok[] | null {
  const toks: PatTok[] = []
  let i = 0
  const s = pattern
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    const parts: string[] = ['']
    let wildcards = 0
    let quotedOrEscaped = false
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i]
      if (c === '\\' && i + 1 < s.length) {
        parts[parts.length - 1] += s[i + 1]
        quotedOrEscaped = true
        i += 2
      } else if (c === "'" || c === '"') {
        const end = s.indexOf(c, i + 1)
        if (end < 0) return null
        parts[parts.length - 1] += s.slice(i + 1, end)
        quotedOrEscaped = true
        i = end + 1
      } else if (c === '*') {
        parts.push('')
        wildcards++
        i++
      } else {
        parts[parts.length - 1] += c
        i++
      }
    }
    const any = wildcards === 1 && !quotedOrEscaped && parts.every((p) => p === '')
    toks.push({ parts, any })
  }
  return toks
}

function globToken(parts: string[], tok: string): boolean {
  if (parts.length === 1) return parts[0] === tok
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (!tok.startsWith(first)) return false
  if (tok.length < first.length + last.length || !tok.endsWith(last)) return false
  let pos = first.length
  const end = tok.length - last.length
  for (let k = 1; k < parts.length - 1; k++) {
    const idx = tok.indexOf(parts[k], pos)
    if (idx < 0 || idx + parts[k].length > end) return false
    pos = idx + parts[k].length
  }
  return pos <= end
}

const baseName = (s: string): string => s.slice(s.lastIndexOf('/') + 1)

/** Casa um padrão com as palavras de um comando. `basenameProgram`: ver acima (blacklist). */
export function matchCommandPattern(
  pattern: string,
  tokens: string[],
  opts: { basenameProgram?: boolean } = {}
): boolean {
  const pat = parsePattern(pattern)
  if (!pat || !pat.length || !tokens.length) return false
  const toks = [...tokens]
  // programa: padrão sem "/" casa o basename (só na blacklist)
  const p0 = pat[0]
  if (opts.basenameProgram && !p0.any && !p0.parts.join('*').includes('/'))
    toks[0] = baseName(toks[0])
  // DP clássico de wildcard por tokens
  const memo = new Map<string, boolean>()
  const go = (i: number, j: number): boolean => {
    const key = `${i},${j}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    let r: boolean
    if (i === pat.length) r = j === toks.length
    else if (pat[i].any) r = go(i + 1, j) || (j < toks.length && go(i, j + 1))
    else r = j < toks.length && globToken(pat[i].parts, toks[j]) && go(i + 1, j + 1)
    memo.set(key, r)
    return r
  }
  return go(0, 0)
}

/** Erro de validação de um padrão de comando (null = ok). */
export function validateCommandPattern(pattern: string): string | null {
  const t = pattern.trim()
  if (!t) return 'Padrão vazio.'
  const p = parsePattern(t)
  if (!p) return 'Aspas sem fechamento.'
  if (p.length === 1 && p[0].any) return '"*" sozinho casaria qualquer comando.'
  return null
}

/** Aviso suave: padrão que libera qualquer coisa do programa (`git *`). */
export function broadPatternWarning(pattern: string): string | null {
  const p = parsePattern(pattern.trim())
  if (!p || p.length !== 2 || !p[1].any || p[0].any) return null
  const prog = p[0].parts.join('*')
  const base = baseName(prog)
  if (base === 'ssh')
    return `"${prog} *" libera a conexão a QUALQUER servidor (os comandos remotos continuam avaliados um a um). Prefira o destino: "${prog} usuario@host".`
  if (ELEVATE.has(base))
    return `"${prog} *" não libera nada na whitelist: ${prog} só é liberado por uma entrada com o comando (ex.: "${prog} apt update *"). Na blacklist, bloqueia qualquer ${prog}.`
  return `"${prog} *" libera QUALQUER uso de ${prog} (ex.: ${EXAMPLES[baseName(prog)] ?? `${prog} com qualquer argumento`}). Prefira um subcomando: "${prog} <sub> *".`
}

const EXAMPLES: Record<string, string> = {
  git: 'git push --force, git reset --hard, git -c core.pager="…" (executa comandos)',
  rm: 'rm -rf ~',
  npm: 'npm publish, npm exec …',
  npx: 'npx qualquer-pacote',
  docker: 'docker run --privileged …',
  curl: 'curl … -o arquivo',
  python: 'python -c "…"',
  python3: 'python3 -c "…"',
  node: 'node -e "…"',
  sudo: 'sudo qualquer coisa',
  find: 'find … -delete',
  sed: 'sed -i, sed "1e comando" (executa comandos)',
  awk: 'awk \'BEGIN{system("…")}\' (executa comandos)',
  tar: 'tar --to-command="…" (executa comandos)',
  rg: 'rg --pre "…" (executa comandos)',
  vim: 'vim (pode executar comandos)',
  less: 'less (pode executar comandos com !)'
}

/** Programas cujo 1º argumento costuma ser um subcomando (git push, npm run…). */
const SUBCOMMAND_PROGRAMS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'npx',
  'cargo',
  'go',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'gh',
  'glab',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'brew',
  'apt',
  'apt-get',
  'dnf',
  'yum',
  'pacman',
  'systemctl',
  'journalctl',
  'adb',
  'gradle',
  'gradlew',
  './gradlew',
  'mvn',
  'make',
  'flutter',
  'dart',
  'dotnet',
  'terraform',
  'aws',
  'gcloud',
  'az',
  'firebase',
  'vercel',
  'swift',
  'xcrun',
  'rustup',
  'conda',
  'mix',
  'rails',
  'composer',
  'php',
  'ng',
  'nx',
  'turbo',
  'emulator',
  'avdmanager',
  'sdkmanager',
  'supabase',
  'heroku',
  'tsc',
  'eslint',
  'prettier',
  'jest',
  'vitest',
  'playwright'
])

/**
 * Pré-preenchimento do "+ whitelist/blacklist": `programa subcomando *` quando o programa tem
 * subcomandos conhecidos e o 1º argumento não-opção é alfabético (`git push origin main` →
 * `git push *`); senão `programa *` (`ls -la` → `ls *`). `sudo x …` → `sudo <sugestão de x>`.
 */
export function suggestCommandPattern(tokens: string[]): string {
  if (!tokens.length) return ''
  const q = shellQuote
  if ((tokens[0] === 'sudo' || tokens[0] === 'doas') && tokens.length > 1) {
    // mantém as opções (`sudo -u postgres psql …` → `sudo -u postgres psql *`)
    const i = elevateCommandIndex(tokens)
    if (i > 0 && i < tokens.length)
      return [tokens[0], ...tokens.slice(1, i), suggestCommandPattern(tokens.slice(i))]
        .map((t, k) => (k === i ? t : q(t)))
        .join(' ')
  }
  const prog = tokens[0]
  if (tokens.length === 1) return q(prog)
  if (SUBCOMMAND_PROGRAMS.has(baseName(prog)) || SUBCOMMAND_PROGRAMS.has(prog)) {
    const sub = tokens.slice(1).find((t) => !t.startsWith('-'))
    const subIdx = sub ? tokens.indexOf(sub) : -1
    // só se o subcomando vier logo depois do programa (não `git -C dir status`)
    if (sub && subIdx === 1 && /^[a-z][a-z0-9:._-]*$/i.test(sub)) return `${q(prog)} ${q(sub)} *`
  }
  return `${q(prog)} *`
}

// ---------------- URLs ----------------

/** URL como o browse_url abriria (sem esquema → https). null = inválida/não http(s). */
export function normalizeUrl(raw: string): URL | null {
  const t = String(raw ?? '').trim()
  if (!t) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    // WHATWG URL já põe esquema/host em minúsculas, converte IDN → punycode e remove porta padrão
    return u
  } catch {
    return null
  }
}

/** Host (punycode, minúsculo) de um domínio digitado — null se inválido. */
function normalizeHost(domain: string): { host: string; port: string } | null {
  const u = normalizeUrl(`https://${domain}`)
  if (!u || u.pathname !== '/' || u.search || u.hash || u.username) return null
  return { host: u.hostname, port: u.port }
}

export type UrlEntry =
  { kind: 'domain'; host: string; port: string; wildcard: boolean } | { kind: 'prefix'; url: URL }

/**
 * Entrada de lista de páginas:
 * - domínio: `github.com` (só esse host), `*.github.com` (o domínio E qualquer subdomínio),
 *   opcionalmente com porta (`localhost:3000`); vale para http e https;
 * - prefixo de URL: `https://github.com/ezenere/` — mesmo esquema/host/porta e caminho com esse
 *   prefixo em fronteira de segmento (`/ezenere` casa `/ezenere` e `/ezenere/x`, não
 *   `/ezenere2`). Com `?`/`#` na entrada, compara a URL inteira por prefixo.
 */
export function parseUrlEntry(entry: string): UrlEntry | null {
  const t = entry.trim()
  if (!t) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    const u = normalizeUrl(t)
    return u ? { kind: 'prefix', url: u } : null
  }
  const wildcard = t.startsWith('*.')
  const h = normalizeHost(wildcard ? t.slice(2) : t)
  if (!h || h.host.includes('*')) return null
  // `*.com` / `*.localhost`-like curingas amplos demais: exige ao menos 2 rótulos com curinga
  if (wildcard && !h.host.includes('.')) return null
  return { kind: 'domain', ...h, wildcard }
}

export function validateUrlEntry(entry: string): string | null {
  if (!entry.trim()) return 'Entrada vazia.'
  if (entry.trim() === '*' || entry.trim() === '*.') return '"*" sozinho casaria qualquer página.'
  return parseUrlEntry(entry)
    ? null
    : 'Use um domínio (github.com, *.github.com) ou uma URL http(s).'
}

export function matchUrlEntry(entry: string, url: URL): boolean {
  const e = parseUrlEntry(entry)
  if (!e) return false
  if (e.kind === 'domain') {
    if (e.port && e.port !== url.port) return false
    const h = url.hostname
    return h === e.host || (e.wildcard && h.endsWith(`.${e.host}`))
  }
  const p = e.url
  if (p.protocol !== url.protocol || p.hostname !== url.hostname || p.port !== url.port)
    return false
  if (p.search || p.hash) return url.href.startsWith(p.href)
  const pp = p.pathname
  if (pp === '/' || pp === '') return true
  const up = url.pathname
  if (pp.endsWith('/')) return up.startsWith(pp) || up === pp.slice(0, -1)
  return up === pp || up.startsWith(`${pp}/`)
}

// ---------------- avaliação contra as listas ----------------

export interface ListEvaluation {
  /** Bloqueado pela blacklist (comando inteiro / a URL). `where`: contexto do sub-comando. */
  blocked?: { text: string; entry: string; where?: string }
  check: ApprovalCheck
  /** Todos os itens liberados (whitelist ou leitura). */
  allAllowed: boolean
  /** Todos os itens são só de leitura (sempre liberado — approvalSafety.ts). */
  readOnly?: boolean
  /** Algum item toca um caminho protegido (sempre pergunta, sem juiz). */
  protected?: boolean
}

/** Programas que elevam privilégio: o item próprio só casa com entrada que nomeia o comando. */
const ELEVATE = new Set(['sudo', 'doas', 'su'])
const ELEVATE_ARG: Record<string, string> = { sudo: 'uUgpChDrtTR', doas: 'uC' }

/** Índice do comando depois das opções de sudo/doas (tokens ou tokens de padrão). */
function elevateCommandIndex(tokens: string[]): number {
  const withArg = ELEVATE_ARG[baseName(tokens[0])] ?? ''
  let i = 1
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i]
    if (t === '--') return i + 1
    if (
      /^--(user|group|host|prompt|close-from|chdir|role|type|other-user|command-timeout)$/.test(t)
    )
      i++
    else if (/^-[A-Za-z]+$/.test(t) && withArg.includes(t[t.length - 1])) i++
    i++
  }
  return i
}

/**
 * Whitelist do item próprio de sudo/doas/su (decisão: elevar privilégio nunca é liberado por um
 * padrão amplo): a entrada precisa nomear o comando — `sudo apt update *` vale; `sudo *`,
 * `sudo -u x *` não. su: precisa de `-c <script literal>`. A blacklist casa normalmente.
 */
export function isSpecificElevatePattern(pattern: string): boolean {
  const p = parsePattern(pattern.trim())
  if (!p || !p.length || p[0].any || p[0].parts.length !== 1) return false
  const lit = (t: (typeof p)[number] | undefined): boolean => !!t && !t.any && t.parts.length === 1
  const prog = baseName(p[0].parts[0])
  if (prog === 'su') {
    const k = p.findIndex((t) => lit(t) && /^(-c|--command|-C|--session-command)$/.test(t.parts[0]))
    return k > 0 && lit(p[k + 1])
  }
  // opções literais são puladas como no comando; o comando precisa ser literal (sem *)
  const withArg = ELEVATE_ARG[prog] ?? ''
  let k = 1
  while (k < p.length) {
    if (!lit(p[k])) return false // `*` antes do comando casaria qualquer comando
    const v = p[k].parts[0]
    if (!v.startsWith('-')) break
    if (v === '--') {
      k++
      break
    }
    if (
      /^--(user|group|host|prompt|close-from|chdir|role|type|other-user|command-timeout)$/.test(
        v
      ) ||
      (/^-[A-Za-z]+$/.test(v) && withArg.includes(v[v.length - 1]))
    )
      k++ // argumento da opção (pode ser *: `sudo -u * apt update`)
    k++
  }
  return lit(p[k])
}

/** Texto de um item com o contexto (resultado para o agente: "rm x — no servidor h (via ssh)"). */
export function checkItemLabel(it: { text: string; group?: string }): string {
  return it.group ? `${it.text} — ${it.group}` : it.text
}

/**
 * Prévia de script do sub-comando (detecção pura; o main lê o arquivo depois). `remote`: o comando
 * roda do outro lado de um ssh/docker exec/kubectl exec — o arquivo não é daqui.
 */
function scriptOf(c: ShellCommand, remote: boolean): ApprovalScript | undefined {
  const ref = detectScript(c.tokens)
  if (!ref) return undefined
  if (ref.kind === 'inline') {
    const h = scriptHead(ref.code, SCRIPT_PREVIEW.cardLines, SCRIPT_PREVIEW.cardChars)
    return {
      interpreter: ref.interpreter,
      status: 'inline',
      content: h.head,
      lines: h.lines,
      ...(h.truncated ? { truncated: true } : {})
    }
  }
  return { interpreter: ref.interpreter, path: ref.path, status: remote ? 'remote' : 'pending' }
}

/** Para cada sub-comando: roda do outro lado de um ssh/container (algum wrapper acima dele)? */
function remoteFlags(cmds: ShellCommand[]): boolean[] {
  const roles: (ShellCommand['role'] | undefined)[] = []
  return cmds.map((c) => {
    const d = c.depth ?? 0
    roles.length = d
    const remote = roles.some((r) => r === 'ssh' || r === 'container')
    roles[d] = c.role
    return remote
  })
}

/**
 * Para cada sub-comando: pode ser liberado como "só leitura"? Não sob sudo/su/container; dentro de
 * um ssh, só se a CONEXÃO estiver na whitelist (decisão: ler no servidor é liberado só para hosts
 * que você já liberou). Os itens próprios dos wrappers nunca são leitura.
 */
function readOnlyFlags(cmds: ShellCommand[], list: ApprovalList, ctx: SafetyCtx): boolean[] {
  const chain: (ShellCommand | undefined)[] = []
  return cmds.map((c) => {
    const d = c.depth ?? 0
    chain.length = d
    const above = chain.filter(Boolean) as ShellCommand[]
    chain[d] = c
    if (c.unsafe || c.role) return false
    for (const w of above) {
      if (w.role === 'elevate' || w.role === 'container') return false
      if (w.role === 'ssh' && !list.allow.some((p) => matchCommandPattern(p, w.match ?? w.tokens)))
        return false
    }
    return isReadOnlyTokens(c.tokens, ctx)
  })
}

function subItem(
  c: ShellCommand,
  list: ApprovalList,
  remote = false,
  readOnly = false,
  hits: ProtectedHit[] = []
): ApprovalCheckItem {
  const text = c.tokens.length ? c.tokens.map(shellQuote).join(' ') : c.text
  const tokens = c.match ?? c.tokens
  const suggestion =
    c.role === 'ssh' || c.role === 'container'
      ? tokens.map(shellQuote).join(' ')
      : c.role === 'elevate' && baseName(c.tokens[0] ?? '') === 'su'
        ? text
        : suggestCommandPattern(c.tokens)
  const script = scriptOf(c, remote)
  const base = {
    text,
    suggestion,
    ...(c.note ? { note: c.note } : {}),
    ...(c.depth ? { depth: c.depth } : {}),
    ...(c.group ? { group: c.group } : {}),
    ...(script ? { script } : {})
  }
  // caminho protegido: sempre pergunta (nem whitelist, nem juiz, nem "Sempre permitir")
  if (hits.length) {
    const prot = protectedText(hits)
    return {
      ...base,
      verdict: 'ask',
      protectedPath: prot,
      reason: `caminho protegido: ${prot}${c.unsafe ? `; ${c.unsafe}` : ''}`
    }
  }
  if (c.unsafe) return { ...base, verdict: 'ask', reason: c.unsafe }
  const entry = list.allow.find(
    (p) => matchCommandPattern(p, tokens) && (c.role !== 'elevate' || isSpecificElevatePattern(p))
  )
  // só leitura: sempre liberado (a entrada da whitelist, se casar, fica só como registro)
  if (readOnly) return { ...base, verdict: 'allow', readOnly: true, ...(entry ? { entry } : {}) }
  return entry ? { ...base, verdict: 'allow', entry } : { ...base, verdict: 'ask' }
}

/** Avalia um comando (shell / process_start) contra as listas de `item`. */
export function evaluateCommand(
  item: 'commands' | 'processes',
  command: string,
  list: ApprovalList,
  ctx: SafetyCtx = {}
): ListEvaluation {
  const a = analyzeShell(command)
  const cmds = a.commands.length
    ? a.commands
    : [{ tokens: [], text: command.trim() || '(vazio)', unsafe: 'comando vazio' } as ShellCommand]
  const ro = readOnlyFlags(cmds, list, ctx)
  const hits = cmds.map((c) => protectedHits(c, ctx))
  const build = (): ApprovalCheckItem[] => {
    const remote = remoteFlags(cmds)
    return cmds.map((x, i) => subItem(x, list, remote[i], ro[i], hits[i]))
  }
  for (const c of cmds) {
    // blacklist: o comando como escrito E (wrappers) a forma de casamento sem o comando interno
    const entry = list.deny.find(
      (p) =>
        matchCommandPattern(p, c.tokens, { basenameProgram: true }) ||
        (!!c.match && matchCommandPattern(p, c.match, { basenameProgram: true }))
    )
    if (entry) {
      const items = build()
      return {
        blocked: {
          text: c.tokens.map(shellQuote).join(' ') || c.text,
          entry,
          ...(c.group ? { where: c.group } : {})
        },
        check: { item, items },
        allAllowed: false
      }
    }
  }
  const items = build()
  return {
    check: { item, items },
    allAllowed: items.every((i) => i.verdict === 'allow'),
    ...(items.every((i) => i.readOnly) ? { readOnly: true } : {}),
    ...(items.some((i) => i.protectedPath) ? { protected: true } : {})
  }
}

export function evaluateUrl(raw: string, list: ApprovalList): ListEvaluation {
  const u = normalizeUrl(raw)
  if (!u) {
    return {
      check: {
        item: 'pages',
        items: [
          {
            text: String(raw ?? ''),
            verdict: 'ask',
            reason: 'URL inválida ou não http(s)',
            suggestion: ''
          }
        ]
      },
      allAllowed: false
    }
  }
  const text = u.href
  const suggestion = u.hostname
  const deny = list.deny.find((e) => matchUrlEntry(e, u))
  if (deny) {
    return {
      blocked: { text, entry: deny },
      check: { item: 'pages', items: [{ text, verdict: 'ask', suggestion }] },
      allAllowed: false
    }
  }
  const allow = list.allow.find((e) => matchUrlEntry(e, u))
  const it: ApprovalCheckItem = allow
    ? { text, verdict: 'allow', entry: allow, suggestion }
    : { text, verdict: 'ask', suggestion }
  return { check: { item: 'pages', items: [it] }, allAllowed: !!allow }
}

/** Avalia os argumentos de uma tool no modo lists. `search` → sempre pergunta (sem listas). */
export function evaluateLists(
  item: ApprovalItem,
  args: unknown,
  lists: Record<ApprovalListItem, ApprovalList>,
  ctx: SafetyCtx = {}
): ListEvaluation {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const str = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '')
  if (item === 'commands' || item === 'processes')
    return evaluateCommand(item, str('command'), lists[item], ctx)
  if (item === 'pages') return evaluateUrl(str('url'), lists.pages)
  return {
    check: { item, items: [{ text: str('query'), verdict: 'ask', suggestion: '' }] },
    allAllowed: false
  }
}

export function blockedText(
  item: ApprovalListItem,
  b: { text: string; entry: string; where?: string }
): string {
  return `Bloqueado pela blacklist (${ITEM_LIST_NAME[item]}): "${b.entry}" casou com "${b.text}"${b.where ? ` (${b.where})` : ''}`
}

export function userDeniedText(text: string): string {
  return `O usuário negou: ${text}`
}

export function validateListEntry(item: ApprovalListItem, entry: string): string | null {
  return item === 'pages' ? validateUrlEntry(entry) : validateCommandPattern(entry)
}

// ---------------- rota de decisão ----------------

export type ApprovalRoute =
  | { kind: 'run' }
  | { kind: 'judge' }
  /** pergunta simples (sim/não); smartMissing = modo smart sem modelo do juiz */
  | { kind: 'user'; smartMissing?: boolean }
  | { kind: 'lists' }

/** Juiz configurado = provedor + modelo escolhidos (igual a smartApproveActive). */
export const judgeConfigured = (sa: Partial<SmartApproveConfig> | null | undefined): boolean =>
  !!sa?.providerId && !!sa.model?.trim()

/**
 * Rota de uma chamada pelo modo efetivo do item: always → roda; smart → juiz (sem modelo →
 * usuário, fail-closed; nos itens com listas o runner aplica smartListPlan antes do juiz); lists →
 * listas (commands/processes/pages) ou pergunta simples. Tools que não são itens (leitura,
 * process_stop, ask_user…) → roda.
 */
export function approvalRoute(
  cfg: Pick<ChatConfig, 'approvalModes'> & { smartApprove?: Partial<SmartApproveConfig> },
  globalModes: Partial<Record<ApprovalItem, ApprovalMode>> | null | undefined,
  tool: ToolName
): ApprovalRoute {
  const item = TOOL_ITEM[tool]
  if (!item) return { kind: 'run' }
  const mode = effectiveMode(cfg, globalModes, item)
  if (mode === 'always') return { kind: 'run' }
  if (mode === 'smart')
    return judgeConfigured(cfg.smartApprove)
      ? { kind: 'judge' }
      : { kind: 'user', smartMissing: true }
  return isListItem(item) ? { kind: 'lists' } : { kind: 'user' }
}

/**
 * Modo smart num item com listas (commands/processes/pages): as listas decidem primeiro.
 * - blacklist casou → `blocked` (nada roda, sem juiz — como no modo Listas);
 * - tudo liberado pela whitelist → `run` (sem juiz), a menos que `judgeWhitelisted` ("Consultar o
 *   Smart-Approve também para o que a whitelist já libera");
 * - senão → `judge` com `judgeIdx` = os itens que o juiz decide (os não liberados; com
 *   `judgeWhitelisted`, todos). Os liberados vão ao juiz só como contexto.
 */
export type SmartListPlan =
  | { kind: 'blocked'; ev: ListEvaluation }
  | { kind: 'run'; ev: ListEvaluation }
  /** Caminho protegido: card das listas direto, sem juiz (ele não poderia liberar). */
  | { kind: 'protected'; ev: ListEvaluation }
  | { kind: 'judge'; ev: ListEvaluation; judgeIdx: number[] }

export function smartListPlan(
  item: ApprovalListItem,
  args: unknown,
  lists: Record<ApprovalListItem, ApprovalList>,
  opts: { judgeWhitelisted?: boolean; safety?: SafetyCtx } = {}
): SmartListPlan {
  const ev = evaluateLists(item, args, lists, opts.safety)
  if (ev.blocked) return { kind: 'blocked', ev }
  if (ev.protected) return { kind: 'protected', ev }
  if (ev.allAllowed && !opts.judgeWhitelisted) return { kind: 'run', ev }
  // leitura nunca vai ao juiz (nem com "consultar também o que a whitelist libera")
  const judgeIdx = ev.check.items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.readOnly && (opts.judgeWhitelisted || it.verdict !== 'allow'))
    .map(({ i }) => i)
  if (!judgeIdx.length) return { kind: 'run', ev }
  return { kind: 'judge', ev, judgeIdx }
}

/** Itens em modo smart que, por falta de modelo, estão perguntando (aviso na UI). */
export function smartItemsWithoutJudge(
  cfg: Pick<ChatConfig, 'approvalModes'> & { smartApprove?: Partial<SmartApproveConfig> },
  globalModes: Partial<Record<ApprovalItem, ApprovalMode>> | null | undefined
): ApprovalItem[] {
  if (judgeConfigured(cfg.smartApprove)) return []
  return APPROVAL_ITEMS.filter((i) => effectiveMode(cfg, globalModes, i) === 'smart')
}

// ---------------- decisões do card ----------------

/** Decisão de um item pendente do card (índice em check.items). */
export interface ApprovalItemDecision {
  index: number
  allow: boolean
  /** "+ whitelist" (allow) / "+ blacklist" (deny): padrão a salvar na lista global. */
  pattern?: string
}

// ---------------- migração (≤ 0.3.0 → modos; ≤ 0.4.0 → Smart-Approve por item) ----------------

/**
 * Config antiga (chat/persona, parcial) → modos por item. Legado = tem a chave `autoApprove`:
 * - tool em autoApprove → override `always` no item (shell→commands, process_start→processes,
 *   browse_url→pages, web_search→search; process_stop é ignorada — não pede mais confirmação);
 * - Smart-Approve ligado (enabled) avaliando a tool (tools ausente = todas) e não em autoApprove →
 *   override `smart`;
 * - smartApprove.tools perde as de CONFIRM_TOOLS (ficam só os extras) e extras que estavam em
 *   autoApprove saem do juiz (rodavam direto);
 * - `autoApprove` é removido. Sem a chave (e sem `assumeLegacy`) → retorna o MESMO objeto.
 */
export function migrateApprovalConfig<T extends Partial<ChatConfig>>(
  cfg: T,
  opts: { assumeLegacy?: boolean } = {}
): T {
  if (!cfg || typeof cfg !== 'object') return cfg
  // `assumeLegacy` (migração única do banco: tudo lá é de ≤ 0.3.0): também converte configs sem
  // `autoApprove` cujo smartApprove esteja no formato antigo (tools ausente = CONFIRM_TOOLS, ou com
  // tools de CONFIRM_TOOLS). O alias de leitura só usa a presença da chave `autoApprove`.
  const sa0 = cfg.smartApprove as Partial<SmartApproveConfig> | undefined
  const legacySmart =
    !!sa0 &&
    typeof sa0 === 'object' &&
    'enabled' in sa0 &&
    (!Array.isArray(sa0.tools) ||
      sa0.tools.some((t) => CONFIRM_TOOLS.includes(t) || t === 'process_stop'))
  if (!('autoApprove' in cfg) && !(opts.assumeLegacy && legacySmart)) return cfg
  const out = { ...cfg } as T & { autoApprove?: unknown }
  const aa = Array.isArray(cfg.autoApprove) ? (cfg.autoApprove as string[]) : []
  delete out.autoApprove
  const modes: Partial<Record<ApprovalItem, ApprovalMode>> = normalizeChatModes(cfg.approvalModes)
  const sa = cfg.smartApprove
  const saTools: string[] | null = sa && Array.isArray(sa.tools) ? (sa.tools as string[]) : null
  for (const tool of CONFIRM_TOOLS) {
    const item = TOOL_ITEM[tool]!
    if (modes[item]) continue
    if (aa.includes(tool)) modes[item] = 'always'
    else if (sa?.enabled === true && (saTools === null || saTools.includes(tool)))
      modes[item] = 'smart'
  }
  if (Object.keys(modes).length) out.approvalModes = modes
  if (sa && typeof sa === 'object') {
    const extras = (saTools ?? []).filter(
      (t) => !CONFIRM_TOOLS.includes(t as ToolName) && t !== 'process_stop' && !aa.includes(t)
    ) as ToolName[]
    out.smartApprove = { ...sa, tools: extras }
  }
  return out
}

/** Tools que eram "extras" do Smart-Approve (≤ 0.4.0) e hoje são itens. */
const LEGACY_SMART_EXTRAS: ToolName[] = ['write_file', 'edit_file', 'send_to_chat', 'delegate_task']

type ModesLike = Partial<Record<ApprovalItem, ApprovalMode>> | null | undefined

/**
 * Smart-Approve ≤ 0.4.0 (`smartApprove.enabled` + `smartApprove.tools` extras) → modos por item.
 * Hoje o juiz age exatamente nos itens em modo `smart`, desde que haja modelo. Mapeamento
 * (preserva o comportamento):
 * - `enabled` true COM modelo (juiz ativo): itens em smart continuam smart; cada extra marcado
 *   (write_file, edit_file, send_to_chat, delegate_task) vira override `smart` no item (antes: juiz
 *   → usuário — igual). Extras não marcados seguem o padrão "Sempre permitir" (antes rodavam direto).
 * - juiz INATIVO (`enabled` false, ou sem modelo) e COM modelo: os itens cujo modo efetivo era
 *   `smart` (do chat ou do global — `globalModes`) perguntavam ao usuário → override `lists`
 *   (Listas/Perguntar: com listas vazias = pergunta; whitelist/blacklist passam a valer). Extras
 *   não rodavam pelo juiz (rodavam direto) → nada (padrão "Sempre permitir").
 * - juiz inativo SEM modelo: nada muda (smart sem modelo já pergunta — fail-closed, com aviso).
 * - `enabled` e `tools` são removidos. Override já existente vence (extras). Idempotente: sem
 *   essas chaves → retorna o MESMO objeto.
 */
export function migrateSmartApproveConfig<T extends Partial<ChatConfig>>(
  cfg: T,
  opts: { globalModes?: ModesLike | (() => ModesLike) } = {}
): T {
  if (!cfg || typeof cfg !== 'object') return cfg
  const sa = cfg.smartApprove as (Partial<SmartApproveConfig> & Record<string, unknown>) | undefined
  if (!sa || typeof sa !== 'object' || (!('enabled' in sa) && !('tools' in sa))) return cfg
  const { enabled, tools, ...rest } = sa
  const hasModel = judgeConfigured(sa)
  const wasActive = enabled === true && hasModel
  const modes = normalizeChatModes(cfg.approvalModes)
  if (wasActive) {
    for (const t of Array.isArray(tools) ? tools : []) {
      const item = (LEGACY_SMART_EXTRAS as string[]).includes(t) ? TOOL_ITEM[t] : undefined
      if (item && !modes[item]) modes[item] = 'smart'
    }
  } else if (hasModel) {
    const g = typeof opts.globalModes === 'function' ? opts.globalModes() : opts.globalModes
    for (const item of APPROVAL_ITEMS)
      if (effectiveMode({ approvalModes: modes }, g, item) === 'smart') modes[item] = 'lists'
  }
  const out = { ...cfg, smartApprove: rest as unknown as SmartApproveConfig } as T
  if (Object.keys(modes).length) out.approvalModes = modes
  return out
}

/**
 * Os dois passos de migração de aprovações (≤ 0.3.0 e ≤ 0.4.0) em sequência — alias de leitura
 * (repo, personas) e migração do banco. `assumeLegacy`: ver migrateApprovalConfig.
 */
export function migrateLegacyApprovals<T extends Partial<ChatConfig>>(
  cfg: T,
  opts: { assumeLegacy?: boolean; globalModes?: ModesLike | (() => ModesLike) } = {}
): T {
  return migrateSmartApproveConfig(migrateApprovalConfig(cfg, opts), opts)
}
