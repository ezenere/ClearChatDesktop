import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { clampSpillChars, LIMITS } from '@shared/limits'
import type { ContentPart, ModelInfo, PresentFilesRecord, StoredMessage } from '@shared/types'
import type { MediaContext } from './media'
import type { HistoryStore } from '../historyStore'
import type { SkillInfo } from '@shared/skills'
import {
  isReadableToolOutput,
  isToolOutputTarget,
  isUnderToolOutputs,
  renderSpilled,
  writeToolOutput,
  type SpillParts
} from './toolOutputs'

export const MAX_OUTPUT: number = LIMITS.maxToolOutputChars

/** Estado do shell de uma sessão (tool shell): diretório atual, persistido entre chamadas. */
export interface ShellState {
  root: string
  dir: string
}

export interface ToolContext {
  /** Diretório raiz da sessão (base dos caminhos relativos; onde o bash começa). */
  cwd: string
  /** Rejeita caminhos (após realpath) fora do diretório raiz. */
  confine?: boolean
  /** Teto de caracteres do resultado (ChatConfig.maxToolOutputChars). */
  maxOutput?: number
  /**
   * Acima disso (caracteres) o resultado vai inteiro para um arquivo (toolOutputs.ts) e o modelo
   * recebe um trecho + o caminho (setting `toolOutputSpillChars`; nunca acima de maxOutput).
   */
  spillChars?: number
  /** Id da tool_call (nome do arquivo da saída salva). */
  toolCallId?: string
  signal: AbortSignal
  /**
   * Turno de chamada de voz: list_dir/read_file com caminho inexistente tentam a grafia ignorando
   * maiúsculas/minúsculas dentro do diretório raiz (o STT erra caixa — "SRC" para "src").
   */
  voicePaths?: boolean
  /** Saída parcial (ex.: bash) — o chamador faz throttle e emite `tool-running`. */
  onOutput?: (partial: string) => void
  /** shell / process_start: diretório do shell persistido entre chamadas (por sessão). */
  shell?: ShellState
  /** shell / process_start: roda via bubblewrap (raiz gravável, resto somente leitura). */
  sandbox?: boolean
  /**
   * shell / process_start no sandbox: pastas montadas somente leitura (as das skills ativas — os
   * scripts delas precisam ser alcançáveis mesmo sob o /tmp privado).
   */
  roBinds?: string[]
  /** list_skills / skill_load / skill_read: skills ATIVAS do chat (o runner resolve). */
  skills?: SkillInfo[]
  /** Chat / sessão chamadores (process_*: registro de processos por chat). */
  chatId?: string
  sessionId?: string
  /** Chave de cache por sessão (browse_url). */
  cacheKey?: string
  /**
   * list_models: modelos do provedor da sessão (providers.listModels, com cache) e, em `providers`,
   * de todos os provedores configurados (o da sessão incluso, com isSession).
   */
  models?: {
    providerName: string
    current?: string
    list: () => Promise<ModelInfo[]>
    providers?: {
      id: string
      name: string
      isSession?: boolean
      list: () => Promise<ModelInfo[]>
    }[]
  }
  /** get_chat_info / list_chats: dados do chat chamador e dos outros chats (fornecidos pelo runner). */
  chats?: { self: () => ChatInfoData; list: () => ChatListEntry[] }
  /** read_history: mensagens persistidas da sessão chamadora (inclui as anteriores às fronteiras). */
  history?: () => StoredMessage[]
  /** read_history com chat_id / scope "all": leitura de outros chats + índice FTS (fornecido pelo runner). */
  historyStore?: HistoryStore
  /**
   * read_file: provider + modelo da sessão — decide se imagens/PDF podem ser devolvidos ao modelo
   * (mesma regra de capacidade dos anexos). Ausente = só texto.
   */
  media?: MediaContext
}

/** get_chat_info: o chat/sessão que chamou a tool. */
export interface ChatInfoData {
  chatId: string
  title: string
  sessionId: string
  mainSessionId: string
  depth: number
  parentSessionId: string | null
  sessionTitle: string
  model: string
  providerName: string
  root: string
  createdAt: number
  /** Esforço de raciocínio desta sessão (pedido, origem, o que vai depois do ajuste ao modelo). */
  reasoning?: { requested: string | null; source: 'subagent' | 'chat' | null; sent: string | null }
}

/** list_chats: uma linha por chat. */
export interface ChatListEntry {
  id: string
  title: string
  model: string
  status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_input' | 'awaiting_retry'
  updatedAt: number
  self: boolean
}

export interface ToolResult {
  content: string
  status: 'ok' | 'error'
  meta?: { shellCwd?: string; presentFiles?: PresentFilesRecord }
  /**
   * Conteúdo multimodal (read_file de imagem/PDF): parts persistidos por referência
   * (`clearchat-attachment://…` + `_attachment`). Quando presente, é o conteúdo da mensagem tool;
   * `content` fica como o texto equivalente.
   */
  parts?: ContentPart[]
  /**
   * Spill (ver toolOutputs.ts): sem isto, o `content` inteiro é o corpo salvo em arquivo quando
   * passa do limite. Com isto, só `body` vai ao arquivo (head/foot ficam inline) e `content` é a
   * versão inline de reserva (usada se não precisar/conseguir salvar). Removido por runToolImpl.
   */
  spill?: SpillParts
  /** Nunca salvar em arquivo (read_file/skill_read/skill_load: já limitam a própria saída). */
  noSpill?: boolean
}

export class ToolError extends Error {}

export const ok = (content: string, meta?: ToolResult['meta']): ToolResult =>
  meta ? { content, status: 'ok', meta } : { content, status: 'ok' }
export const fail = (content: string, meta?: ToolResult['meta']): ToolResult =>
  meta ? { content, status: 'error', meta } : { content, status: 'error' }

export const maxOutputOf = (ctx: Pick<ToolContext, 'maxOutput'>): number =>
  ctx.maxOutput && ctx.maxOutput > 0 ? ctx.maxOutput : MAX_OUTPUT

/** Limite efetivo para salvar a saída em arquivo: o setting, nunca acima de maxToolOutputChars. */
export const spillCharsOf = (ctx: Pick<ToolContext, 'maxOutput' | 'spillChars'>): number =>
  Math.min(clampSpillChars(ctx.spillChars), maxOutputOf(ctx))

/** Número no formato pt-BR (15.234). */
export const fmtNum = (n: number): string => n.toLocaleString('pt-BR')

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) {
    const kb = n / 1024
    return `${kb.toLocaleString('pt-BR', { maximumFractionDigits: kb < 10 ? 1 : 0 })} KB`
  }
  return `${(n / 1024 ** 2).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
}

const countLines = (s: string): number => {
  let n = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++
  return n
}

// ---------------- caminhos / confinação ----------------

/** Resolve caminho relativo ao diretório raiz; aceita absoluto e `~`. (Sem checar confinação.) */
export function resolvePath(cwd: string, p: unknown): string {
  if (p === undefined || p === null || p === '') return resolve(cwd)
  if (typeof p !== 'string') throw new ToolError('O argumento "path" deve ser uma string.')
  let s = p.trim()
  if (s === '~') s = homedir()
  else if (s.startsWith('~/')) s = homedir() + s.slice(1)
  return isAbsolute(s) ? resolve(s) : resolve(cwd, s)
}

/** `p` está dentro de `root` (ou é o próprio root)? Comparação lexical de caminhos absolutos. */
export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/**
 * realpath do caminho mesmo que ele (ainda) não exista: resolve o ancestral existente mais
 * profundo e reanexa o resto — assim `raiz/link-para-fora/novo.txt` é detectado.
 */
export async function realpathDeep(p: string): Promise<string> {
  let cur = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(cur)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ELOOP') throw new ToolError(`Erro: laço de links simbólicos em ${cur}.`)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
      const parent = dirname(cur)
      if (parent === cur) return resolve(p)
      rest.push(basename(cur))
      cur = parent
    }
  }
}

export function outsideRootError(root: string, original: string): ToolError {
  return new ToolError(
    `Erro: acesso negado — "${original}" fica fora do diretório raiz da sessão (${root}). ` +
      'As ferramentas de arquivo só acessam caminhos dentro do diretório raiz; use caminhos relativos a ele.'
  )
}

/** Lança ToolError se `abs` (após realpath, seguindo symlinks e `..`) estiver fora do root. */
export async function assertInsideRoot(
  root: string,
  abs: string,
  original?: string
): Promise<void> {
  const rootReal = await realpathDeep(root)
  const real = await realpathDeep(abs)
  if (!isInside(rootReal, real)) throw outsideRootError(root, original || abs)
}

/**
 * Caminho que NÃO existe → a grafia que existe ignorando maiúsculas/minúsculas, segmento a segmento,
 * só DENTRO de `root` (turno de voz: o STT erra caixa — "SRC" para "src"). Cada segmento ausente
 * precisa de exatamente UMA entrada com o mesmo nome em minúsculas; ambíguo/ausente/fora do root →
 * null. Caminho que existe → null (nada a ajustar).
 */
export async function caseInsensitiveMatch(root: string, abs: string): Promise<string | null> {
  try {
    await fs.stat(abs)
    return null
  } catch {
    /* não existe: tenta ajustar */
  }
  const base = resolve(root)
  if (!isInside(base, abs) || base === resolve(abs)) return null
  const parts = relative(base, abs).split(sep).filter(Boolean)
  let cur = base
  let changed = false
  for (const part of parts) {
    const exact = join(cur, part)
    try {
      await fs.lstat(exact)
      cur = exact
      continue
    } catch {
      /* segmento ausente: procura pela caixa */
    }
    let names: string[]
    try {
      names = await fs.readdir(cur)
    } catch {
      return null
    }
    const want = part.toLocaleLowerCase()
    const hits = names.filter((n) => n.toLocaleLowerCase() === want)
    if (hits.length !== 1) return null
    cur = join(cur, hits[0])
    changed = true
  }
  return changed ? cur : null
}

/**
 * Turno de voz (`ctx.voicePaths`): caminho inexistente → a grafia que existe ignorando a caixa
 * (`caseInsensitiveMatch`), revalidada pela confinação. Devolve o caminho a usar e a nota para o
 * resultado ("caminho ajustado") — ou o original sem nota.
 */
export async function voicePathFallback(
  ctx: Pick<ToolContext, 'cwd' | 'confine' | 'voicePaths'>,
  abs: string
): Promise<{ path: string; note: string }> {
  if (!ctx.voicePaths) return { path: abs, note: '' }
  const alt = await caseInsensitiveMatch(ctx.cwd, abs)
  if (!alt) return { path: abs, note: '' }
  if (ctx.confine) {
    try {
      await assertInsideRoot(ctx.cwd, alt, alt)
    } catch {
      return { path: abs, note: '' }
    }
  }
  return {
    path: alt,
    note: `[caminho ajustado (maiúsculas/minúsculas): "${relative(ctx.cwd, abs) || abs}" → "${relative(ctx.cwd, alt) || alt}"]\n`
  }
}

/** Resolve o caminho de uma tool de arquivo, aplicando a confinação ao diretório raiz se ativa. */
export async function resolveToolPath(
  ctx: Pick<ToolContext, 'cwd' | 'confine'>,
  p: unknown
): Promise<string> {
  const abs = resolvePath(ctx.cwd, p)
  if (ctx.confine) await assertInsideRoot(ctx.cwd, abs, typeof p === 'string' && p ? p : abs)
  return abs
}

/**
 * Caminho de LEITURA (read_file, search_files): como resolveToolPath, mas com confineToRoot também
 * aceita as saídas salvas deste chat (toolOutputs.ts) e os logs dos processos dele — só arquivos
 * comuns, pelo realpath (symlink para fora continua negado). Saída salva que já foi apagada → erro
 * explicando (em vez de "caminho não encontrado").
 */
export async function resolveReadPath(
  ctx: Pick<ToolContext, 'cwd' | 'confine' | 'chatId'>,
  p: unknown
): Promise<string> {
  const abs = resolvePath(ctx.cwd, p)
  const original = typeof p === 'string' && p ? p : abs
  if (isUnderToolOutputs(abs)) {
    try {
      await fs.stat(abs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ToolError(
          `Erro: a saída salva "${original}" não existe mais (saídas de ferramentas são apagadas após ${LIMITS.spillMaxAgeDays} dias ou quando o chat é apagado). Rode a ferramenta de novo para gerar outra.`
        )
    }
  }
  if (!ctx.confine) return abs
  try {
    await assertInsideRoot(ctx.cwd, abs, original)
  } catch (e) {
    if (e instanceof ToolError && (await isReadableToolOutput(ctx.chatId, abs))) return abs
    throw e
  }
  return abs
}

/** write_file/edit_file: as saídas salvas são somente leitura (com ou sem confinação). */
export async function assertWritable(abs: string, original?: string): Promise<void> {
  if (await isToolOutputTarget(abs))
    throw new ToolError(
      `Erro: "${original || abs}" é uma saída salva de ferramenta (somente leitura). Grave em outro caminho.`
    )
}

/** Caminho para exibição: relativo ao root quando dentro dele. */
export function displayPath(root: string, abs: string): string {
  if (!isInside(root, abs)) return abs
  return relative(root, abs) || '.'
}

// ---------------- truncamento ----------------

/** Trunca no fim: `[... truncado N chars]`. */
export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n[… truncado: ${fmtNum(s.length - max)} caracteres omitidos]`
}

/**
 * Mantém início e fim (ex.: 40% / 60%) com um marcador `[… N chars / M linhas omitidos …]` no
 * meio, alinhando os cortes a quebras de linha quando possível. `extra` soma o que já tinha sido
 * descartado antes (buffers de saída muito grandes).
 */
export function truncateHeadTail(
  s: string,
  max: number,
  headRatio = 0.5,
  hint?: string,
  extra?: { chars: number; lines: number }
): string {
  if (s.length <= max && !extra?.chars) return s
  const budget = Math.max(200, max - 160 - (hint?.length ?? 0))
  const headLen = Math.floor(budget * headRatio)
  const tailLen = budget - headLen
  let head = s.slice(0, Math.min(headLen, s.length))
  let tail = s.length - head.length > tailLen ? s.slice(s.length - tailLen) : s.slice(head.length)
  const hn = head.lastIndexOf('\n')
  if (hn > headLen * 0.7) head = head.slice(0, hn + 1)
  const tn = tail.indexOf('\n')
  if (tn !== -1 && tn < tailLen * 0.3 && tail.length === tailLen) tail = tail.slice(tn + 1)
  const omitted = s.slice(head.length, s.length - tail.length)
  const chars = omitted.length + (extra?.chars ?? 0)
  const lines = countLines(omitted) + (extra?.lines ?? 0)
  if (chars <= 0) return s
  const marker = `[… ${fmtNum(chars)} chars / ${fmtNum(lines)} linhas omitidos …]`
  return `${head.replace(/\n?$/, '\n')}${marker}${hint ? `\n${hint}` : ''}\n${tail}`
}

// ---------------- args ----------------

export function requireString(
  args: Record<string, unknown>,
  key: string,
  allowEmpty = false
): string {
  const v = args[key]
  if (typeof v !== 'string' || (!allowEmpty && v === '')) {
    throw new ToolError(`Argumento obrigatório "${key}" ausente ou inválido (esperado: string).`)
  }
  return v
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ToolError(`Argumento "${key}" deve ser uma string.`)
  return v
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new ToolError(`Argumento "${key}" deve ser um número.`)
  return n
}

export const optBool = (args: Record<string, unknown>, key: string): boolean =>
  args[key] === true || args[key] === 'true'

// ---------------- binários ----------------

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** Tipo provável de um binário pelos bytes iniciais (para a mensagem de recusa). */
export function binaryKind(buf: Buffer): string {
  const hex = buf.subarray(0, 8).toString('hex')
  const ascii = buf.subarray(0, 16).toString('latin1')
  if (hex.startsWith('89504e47')) return 'imagem PNG'
  if (hex.startsWith('ffd8ff')) return 'imagem JPEG'
  if (ascii.startsWith('GIF8')) return 'imagem GIF'
  if (ascii.startsWith('RIFF') && buf.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'imagem WebP'
  if (ascii.startsWith('%PDF')) return 'documento PDF'
  if (hex.startsWith('504b0304')) return 'arquivo ZIP (ou docx/xlsx/jar)'
  if (hex.startsWith('1f8b')) return 'arquivo gzip'
  if (hex.startsWith('7f454c46')) return 'executável ELF'
  if (ascii.startsWith('SQLite format 3')) return 'banco SQLite'
  if (hex.startsWith('0061736d')) return 'WebAssembly'
  return 'binário'
}

export function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/**
 * Spill (toolOutputs.ts): resultado acima do limite → corpo completo num arquivo do chat e, no
 * `content`, trecho + caminho + instruções. Erros sem `spill` explícito ficam inline; mídia e
 * `noSpill` nunca vão para arquivo. Falha ao gravar → `content` original (o teto corta depois).
 * O texto gerado só depende da saída e do caminho (estável no histórico / cache de prompt).
 */
export async function applySpill(r: ToolResult, ctx: ToolContext): Promise<ToolResult> {
  const { spill, noSpill, ...base } = r
  if (noSpill || base.parts?.length) return base
  const parts: SpillParts | null = spill ?? (base.status === 'ok' ? { body: base.content } : null)
  if (!parts) return base
  const size = (parts.head?.length ?? 0) + parts.body.length + (parts.foot?.length ?? 0)
  if (size <= spillCharsOf(ctx)) return base
  try {
    const path = await writeToolOutput(ctx.chatId, ctx.toolCallId, parts.body)
    const excerpt = Math.max(
      500,
      Math.min(LIMITS.spillExcerptChars, spillCharsOf(ctx) - 900 - (parts.foot?.length ?? 0))
    )
    return { ...base, content: renderSpilled(parts, path, excerpt) }
  } catch (e) {
    console.error('[clearchat] spill de saída de tool', e)
    return base
  }
}

/**
 * Executa a implementação de uma tool local: erros viram resultado de texto (status 'error'), abort
 * é relançado (AbortError), saídas grandes vão para arquivo (applySpill) e o resultado passa pelo
 * teto `maxToolOutputChars` (rede de segurança).
 */
export async function runToolImpl(
  impl: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    const r = await applySpill(await impl(args, ctx), ctx)
    // rede de segurança: nenhuma tool devolve mais que o limite configurado
    const max = maxOutputOf(ctx)
    return r.content.length > max ? { ...r, content: truncateHeadTail(r.content, max, 0.5) } : r
  } catch (e) {
    if (ctx.signal.aborted || (e as Error).name === 'AbortError') throw abortError()
    if (e instanceof ToolError)
      return fail(e.message.startsWith('Erro') ? e.message : `Erro: ${e.message}`)
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return fail(`Erro: caminho não encontrado: ${err.path ?? ''}`.trim())
    if (err.code === 'EACCES' || err.code === 'EPERM')
      return fail(`Erro: permissão negada: ${err.path ?? ''}`.trim())
    if (err.code === 'EISDIR') return fail(`Erro: é um diretório: ${err.path ?? ''}`.trim())
    if (err.code === 'ENOTDIR') return fail(`Erro: não é um diretório: ${err.path ?? ''}`.trim())
    return fail(`Erro: ${err.message ?? String(e)}`)
  }
}
