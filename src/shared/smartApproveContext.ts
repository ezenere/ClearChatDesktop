// Smart-Approve: contexto do juiz além da chamada em si — o objetivo do usuário (mensagens digitadas
// na sessão principal), a tarefa do subagente, a atividade recente da sessão, os arquivos que o
// agente criou/editou, o que já foi aprovado antes (whitelist parecida, aprovações suas) e a
// descrição do ambiente (sua + a capturada pelo resumidor). Funções
// puras e determinísticas (mesma entrada → mesmo texto): o main monta a partir do histórico
// persistido; o renderer usa o mesmo código no (i) e no "Testar" com o histórico de exemplo.
// Ver SPEC.md → "Smart-Approve → Contexto do juiz".
//
// Orçamento (JUDGE_CONTEXT_LIMITS): cada seção tem o próprio teto de caracteres e a soma fica em
// ~6.000 chars (+ até ~2.700 da descrição do ambiente) — o prompt do juiz não cresce com o tamanho
// da conversa.
//
// Defesa contra prompt injection (SPEC → "Contexto do juiz"): o juiz NUNCA vê resultados de tool
// (páginas, arquivos lidos, saída de comandos) nem a prosa do agente (que pode repetir esse
// conteúdo literalmente — por isso a "última fala do agente" saiu em 0.8.5). Vê só: o que o usuário
// digitou, a tarefa do subagente, nomes + args curtos + status das chamadas, caminhos tocados, o
// que já foi aprovado, a decomposição e o começo dos scripts que o comando vai EXECUTAR.
import { contentText } from './attachments'
import { checkItemLabel, ITEM_TOOL } from './approvalPolicy'
import { scriptJudgeText } from './scriptPreview'
import type {
  ApprovalCheck,
  ApprovalItem,
  ApprovalList,
  ApprovalListItem,
  StoredMessage
} from './types'

export const JUDGE_CONTEXT_LIMITS = {
  /** Objetivo do usuário: últimas N mensagens digitadas na sessão principal. */
  goalMessages: 3,
  goalPerMessage: 1000,
  goalChars: 1500,
  /** Subagente: a tarefa recebida (+ as dos subagentes acima dele), no total. */
  taskChars: 1500,
  /** Atividade recente: últimas N chamadas de tool da sessão (com resultado). */
  toolCalls: 12,
  toolArgChars: 140,
  toolChars: 1100,
  /** Descrição do ambiente: a sua (chat/global) e a capturada da conversa. */
  environmentChars: 1500,
  capturedChars: 1200,
  /** Arquivos criados/editados (sessão + cadeia de pais). */
  files: 30,
  filesChars: 1000,
  /** Já aprovados: entradas parecidas da whitelist + o que você aprovou nesta sessão. */
  approved: 10,
  approvedChars: 600
} as const

export interface JudgeSubagent {
  /** 1 = filho da principal; 2 = neto. */
  depth: number
  title: string
  /** Tarefa que o pai passou no delegate_task. */
  task: string
  /** Subagentes acima dele (o mais próximo primeiro) — só em profundidade 2. */
  parents: { title: string; task: string }[]
}

export interface JudgeToolCall {
  name: string
  /** Argumentos resumidos (comando, caminho, URL…). */
  summary: string
  status: 'ok' | 'error' | 'denied' | 'cancelled'
}

export interface JudgeTouchedFile {
  path: string
  action: 'written' | 'edited' | 'presented'
  /** Tocado por uma sessão acima (agente principal / subagente pai). */
  byParent?: boolean
}

/** Contexto extra do juiz (seções do template). Ver buildJudgeExtras. */
export interface JudgeExtras {
  /** Mensagens digitadas pelo usuário na sessão principal, a mais recente primeiro. */
  userGoal: string[]
  /** null = a chamada é do agente principal. */
  subagent: JudgeSubagent | null
  /** Últimas chamadas de tool da sessão chamadora (a mais antiga primeiro). */
  recentTools: JudgeToolCall[]
  /** Mais recente primeiro; da própria sessão antes das dos pais. */
  touchedFiles: JudgeTouchedFile[]
  /** Entradas da whitelist parecidas com o que o juiz decide (mesmo programa/host/domínio). */
  approvedWhitelist: string[]
  /** O que você aprovou antes nesta sessão (cards, "Executar mesmo assim"), mais recente primeiro. */
  approvedByUser: string[]
}

export const EMPTY_JUDGE_EXTRAS: JudgeExtras = {
  userGoal: [],
  subagent: null,
  recentTools: [],
  touchedFiles: [],
  approvedWhitelist: [],
  approvedByUser: []
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, max: number): string => {
  const t = flat(s)
  return t.length > max ? `${t.slice(0, max)}… [+${t.length - max} chars]` : t
}

// ---------------- objetivo do usuário ----------------

/**
 * Mensagem DIGITADA pelo usuário: role user, não sintética (resultados de tool em texto, tarefa do
 * subagente, avisos) e sem kind de origem automática (compactação, outro chat, callbacks, irmãos,
 * mensagem do pai). Fila (`queued`) e ⚡ (`forced`) contam.
 */
export function isTypedUserMessage(m: StoredMessage): boolean {
  if (m.message.role !== 'user' || m.meta?.synthetic) return false
  const k = m.meta?.kind
  return !k || k === 'queued' || k === 'forced'
}

/** Últimas mensagens digitadas (a mais recente primeiro), com teto por mensagem e no total. */
export function userGoalFrom(history: StoredMessage[]): string[] {
  const L = JUDGE_CONTEXT_LIMITS
  const out: string[] = []
  let left = L.goalChars
  for (let i = history.length - 1; i >= 0 && out.length < L.goalMessages; i--) {
    const m = history[i]
    if (!isTypedUserMessage(m)) continue
    const text = flat(contentText(m.message.content))
    if (!text || text.startsWith('<tool_result')) continue
    if (left < 80) break
    const t = cut(text, Math.min(L.goalPerMessage, left))
    out.push(t)
    left -= t.length
  }
  return out
}

// ---------------- atividade recente ----------------

const argsObj = (raw: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(raw || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Resumo curto de argumentos de uma chamada do histórico (o campo que identifica a ação). */
export function callSummary(name: string, rawArgs: string): string {
  const a = argsObj(rawArgs)
  const s = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '')
  let main: string
  if (name === 'present_file' && Array.isArray(a.files))
    main = (a.files as { path?: unknown }[])
      .map((f) => (f && typeof f.path === 'string' ? f.path : ''))
      .filter(Boolean)
      .join(', ')
  else
    main =
      s('command') ||
      s('path') ||
      s('url') ||
      s('query') ||
      s('title') ||
      s('task') ||
      s('id') ||
      s('glob') ||
      s('pattern')
  if (name === 'process_start' && s('cwd')) main += ` (cwd ${s('cwd')})`
  return cut(
    main || (rawArgs && rawArgs !== '{}' ? rawArgs : ''),
    JUDGE_CONTEXT_LIMITS.toolArgChars
  )
}

/** Status de cada tool_call (pela mensagem tool correspondente). Sem resultado = ausente. */
function resultStatus(history: StoredMessage[]): Map<string, JudgeToolCall['status']> {
  const st = new Map<string, JudgeToolCall['status']>()
  for (const m of history)
    if (m.message.role === 'tool') st.set(m.message.tool_call_id, m.meta?.toolStatus ?? 'ok')
  return st
}

/**
 * Últimas chamadas de tool da sessão que já têm resultado (a pendente — a que está sendo julgada —
 * e as paralelas ainda não executadas ficam de fora), a mais antiga primeiro, com teto de chars.
 */
export function recentToolCallsFrom(history: StoredMessage[]): JudgeToolCall[] {
  const L = JUDGE_CONTEXT_LIMITS
  const st = resultStatus(history)
  const all: JudgeToolCall[] = []
  for (const m of history) {
    if (m.message.role !== 'assistant') continue
    for (const tc of m.message.tool_calls ?? []) {
      const status = st.get(tc.id)
      if (!status) continue
      all.push({
        name: tc.function.name,
        summary: callSummary(tc.function.name, tc.function.arguments),
        status
      })
    }
  }
  const out: JudgeToolCall[] = []
  let used = 0
  for (let i = all.length - 1; i >= 0 && out.length < L.toolCalls; i--) {
    const len = all[i].name.length + all[i].summary.length + 12
    if (used + len > L.toolChars) break
    used += len
    out.unshift(all[i])
  }
  return out
}

// ---------------- arquivos tocados ----------------

/** Caminho como as tools de arquivo resolvem (relativo → a partir da raiz). Sem `node:path`. */
export function resolveToolPath(p: string, cwd: string): string {
  const t = p.trim()
  if (!t || !cwd || /^(\/|~|[A-Za-z]:[\\/]|\\\\)/.test(t)) return t
  const base = cwd.replace(/[\\/]+$/, '')
  const rel = t.replace(/^(\.\/)+/, '')
  return rel === '.' ? base : `${base}/${rel}`
}

const FILE_ACTION: Record<string, JudgeTouchedFile['action']> = {
  write_file: 'written',
  edit_file: 'edited',
  present_file: 'presented'
}

/**
 * Arquivos criados/editados/apresentados com sucesso (write_file, edit_file, present_file) — da
 * própria sessão primeiro, depois das sessões acima (`byParent`); o mais recente primeiro, sem
 * repetir (vale a ação mais "forte": written > edited > presented), até `files` itens.
 */
export function touchedFilesFrom(
  sources: { history: StoredMessage[]; byParent?: boolean }[],
  cwd: string
): JudgeTouchedFile[] {
  const L = JUDGE_CONTEXT_LIMITS
  const rank = { written: 3, edited: 2, presented: 1 }
  const out: JudgeTouchedFile[] = []
  const index = new Map<string, number>()
  for (const src of sources) {
    const st = resultStatus(src.history)
    const calls: JudgeTouchedFile[] = []
    for (const m of src.history) {
      if (m.message.role !== 'assistant') continue
      for (const tc of m.message.tool_calls ?? []) {
        const action = FILE_ACTION[tc.function.name]
        if (!action || st.get(tc.id) !== 'ok') continue
        const a = argsObj(tc.function.arguments)
        const paths =
          action === 'presented'
            ? Array.isArray(a.files)
              ? (a.files as { path?: unknown }[]).map((f) =>
                  f && typeof f.path === 'string' ? f.path : ''
                )
              : []
            : [typeof a.path === 'string' ? a.path : '']
        for (const p of paths) {
          const path = resolveToolPath(p, cwd)
          if (path) calls.push({ path, action, ...(src.byParent ? { byParent: true } : {}) })
        }
      }
    }
    for (let i = calls.length - 1; i >= 0; i--) {
      const f = calls[i]
      const at = index.get(f.path)
      if (at === undefined) {
        index.set(f.path, out.length)
        out.push(f)
      } else if (rank[f.action] > rank[out[at].action]) {
        out[at] = { ...out[at], action: f.action }
      }
    }
  }
  return out.slice(0, L.files)
}

// ---------------- já aprovados ----------------

/**
 * O que você aprovou antes nesta sessão: itens com "Sim" nos cards (meta.approval.userAllowed) e
 * chamadas liberadas por "Executar mesmo assim" (meta.smartOverride). Só do mesmo item de aprovação
 * (comandos com comandos…), o mais recente primeiro, sem repetir.
 */
export function userApprovedFrom(history: StoredMessage[], item?: ApprovalItem | 'mcp'): string[] {
  const calls = new Map<string, { name: string; args: string }>()
  for (const m of history)
    if (m.message.role === 'assistant')
      for (const tc of m.message.tool_calls ?? [])
        calls.set(tc.id, { name: tc.function.name, args: tc.function.arguments })
  const out: string[] = []
  for (let i = history.length - 1; i >= 0 && out.length < JUDGE_CONTEXT_LIMITS.approved; i--) {
    const m = history[i]
    if (m.message.role !== 'tool') continue
    const rec = m.meta?.approval
    const found: string[] = []
    if (rec?.userAllowed?.length && (!item || rec.item === item)) found.push(...rec.userAllowed)
    if (m.meta?.smartOverride) {
      const c = calls.get(m.message.tool_call_id)
      // conectores: as aprovações de qualquer tool MCP contam como do mesmo item
      const same =
        !item || (item === 'mcp' ? c?.name.startsWith('mcp__') : ITEM_TOOL[item] === c?.name)
      if (c && same) found.push(callSummary(c.name, c.args))
    }
    for (const f of found) {
      const t = cut(f, JUDGE_CONTEXT_LIMITS.toolArgChars)
      if (t && !out.includes(t)) out.push(t)
    }
  }
  return out.slice(0, JUDGE_CONTEXT_LIMITS.approved)
}

const unquote = (t: string): string => t.replace(/^(['"])(.*)\1$/, '$2')
const baseName = (s: string): string => s.slice(s.lastIndexOf('/') + 1)
const firstWord = (s: string): string => baseName(unquote(s.trim().split(/\s+/)[0] ?? ''))

/** Hosts mencionados num item/grupo ("no servidor deploy@host (via ssh)", `user@host`). */
function hostsOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|[\s'"])(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+|[\w-]+@[\w.-]+)/g)) {
    const h = m[1].includes('@') ? m[1].split('@').pop()! : m[1]
    if (h && /[a-z]/i.test(h) && !out.includes(h)) out.push(h)
  }
  return out
}

/** Domínio "registrável" aproximado (últimos 2 rótulos) de um host. */
const siteOf = (host: string): string => host.split('.').slice(-2).join('.')

/**
 * Entradas da whitelist parecidas com os itens que o juiz decide: mesmo programa (1ª palavra),
 * mesmo wrapper (ssh/sudo/docker… do grupo) ou mesmo host; em Páginas, o mesmo site. As que já
 * liberaram um item desta chamada ficam de fora (aparecem na decomposição). Até `approved` entradas.
 */
export function relevantWhitelist(
  check: ApprovalCheck | undefined,
  judgeIdx: number[] | undefined,
  lists: Record<ApprovalListItem, ApprovalList> | undefined
): string[] {
  if (!check || !lists) return []
  const item = check.item as ApprovalListItem
  const list = lists[item]
  if (!list?.allow.length) return []
  const idx = judgeIdx ?? check.items.map((_, i) => i)
  const used = new Set(check.items.map((i) => i.entry).filter(Boolean) as string[])
  const out: string[] = []
  const push = (e: string): void => {
    if (!used.has(e) && !out.includes(e) && out.length < JUDGE_CONTEXT_LIMITS.approved) out.push(e)
  }
  if (item === 'pages') {
    const sites = new Set<string>()
    for (const i of idx) {
      const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(check.items[i]?.text ?? '')
      if (m) sites.add(siteOf(m[1].toLowerCase()))
    }
    for (const e of list.allow) {
      const h = /^(?:[a-z]+:\/\/)?(?:\*\.)?([^/:?#]+)/i.exec(e)?.[1]?.toLowerCase()
      if (h && sites.has(siteOf(h))) push(e)
    }
    return out
  }
  const progs = new Set<string>()
  const hosts = new Set<string>()
  for (const i of idx) {
    const it = check.items[i]
    if (!it) continue
    progs.add(firstWord(it.text))
    // wrapper do item (o item de nível menor logo acima: ssh, sudo, docker exec…)
    for (let k = i - 1; k >= 0 && (it.depth ?? 0) > 0; k--) {
      if ((check.items[k].depth ?? 0) < (it.depth ?? 0)) {
        progs.add(firstWord(check.items[k].text))
        break
      }
    }
    for (const h of hostsOf(`${it.text} ${it.group ?? ''}`)) hosts.add(h)
  }
  progs.delete('')
  for (const e of list.allow) {
    const p = firstWord(e)
    if (progs.has(p) || [...hosts].some((h) => e.includes(h))) push(e)
  }
  return out
}

// ---------------- montagem ----------------

export interface JudgeExtrasInput {
  /** Histórico (caminho ativo) da sessão que chamou a tool. */
  history: StoredMessage[]
  /** Histórico da sessão principal (na principal, o mesmo de `history`). */
  mainHistory?: StoredMessage[]
  /** Sessão chamadora quando é subagente (depth ≥ 1); ausente/0 = principal. */
  subagent?: { depth: number; title: string; task: string | null } | null
  /** Subagentes acima do chamador (o mais próximo primeiro), com o histórico de cada um. */
  parents?: { title: string; task: string | null; history: StoredMessage[] }[]
  cwd: string
  item?: ApprovalItem | 'mcp'
  /** Avaliação das listas (itens com listas em modo smart) e os índices que o juiz decide. */
  check?: ApprovalCheck
  judgeIdx?: number[]
  lists?: Record<ApprovalListItem, ApprovalList>
}

/** Cadeia de tarefas (subagente e pais) dentro de `taskChars`. */
function subagentInfo(input: JudgeExtrasInput): JudgeSubagent | null {
  const s = input.subagent
  if (!s || s.depth < 1) return null
  const L = JUDGE_CONTEXT_LIMITS
  const task = cut(s.task ?? '', Math.max(200, L.taskChars - 100 * (input.parents?.length ?? 0)))
  let left = L.taskChars - task.length
  const parents: { title: string; task: string }[] = []
  for (const p of input.parents ?? []) {
    if (left < 120) break
    const t = cut(p.task ?? '', left)
    parents.push({ title: cut(p.title, 80), task: t })
    left -= t.length
  }
  return { depth: s.depth, title: cut(s.title, 80), task, parents }
}

/** Monta o contexto extra do juiz a partir dos históricos persistidos (determinístico). */
export function buildJudgeExtras(input: JudgeExtrasInput): JudgeExtras {
  const main = input.mainHistory ?? input.history
  const isSub = !!input.subagent && input.subagent.depth >= 1
  const sources: { history: StoredMessage[]; byParent?: boolean }[] = [{ history: input.history }]
  if (isSub) {
    for (const p of input.parents ?? []) sources.push({ history: p.history, byParent: true })
    if (main !== input.history) sources.push({ history: main, byParent: true })
  }
  return {
    userGoal: userGoalFrom(main),
    subagent: subagentInfo(input),
    recentTools: recentToolCallsFrom(input.history),
    touchedFiles: touchedFilesFrom(sources, input.cwd),
    approvedWhitelist: relevantWhitelist(input.check, input.judgeIdx, input.lists),
    approvedByUser: userApprovedFrom(input.history, input.item)
  }
}

// ---------------- texto das seções (placeholders) ----------------
// Cada seção opcional vem com o próprio cabeçalho e termina em "\n" — vazia = "" (o template padrão
// as encadeia sem linhas em branco sobrando).

/** {{user_goal}}: "[1] …" (a mais recente primeiro) ou "(none)". */
export function userGoalText(x: JudgeExtras): string {
  if (!x.userGoal.length) return '(none)'
  return x.userGoal.map((t, i) => `[${i + 1}] ${t}`).join('\n')
}

/** {{subagent}}: quem chamou (subagente, profundidade, título) e a tarefa recebida. */
export function subagentBlock(x: JudgeExtras): string {
  const s = x.subagent
  if (!s) return ''
  const lines = [
    `\nCaller: a SUBAGENT (depth ${s.depth}, "${s.title}") created by the main agent to work on part of the user's goal. Task it received from its parent agent:`,
    `"""\n${s.task || '(empty)'}\n"""`
  ]
  for (const p of s.parents)
    lines.push(
      `Its parent subagent ("${p.title}") was working on:\n"""\n${p.task || '(empty)'}\n"""`
    )
  return `${lines.join('\n')}\n`
}

const ACTION_TEXT: Record<JudgeTouchedFile['action'], string> = {
  written: 'created/overwritten',
  edited: 'edited',
  presented: 'shown to the user'
}

/** {{touched_files}}: arquivos que o agente criou/editou nesta tarefa. */
export function touchedFilesBlock(x: JudgeExtras): string {
  if (!x.touchedFiles.length) return ''
  const lines: string[] = []
  let used = 0
  for (const f of x.touchedFiles) {
    const l = `- ${f.path} (${ACTION_TEXT[f.action]}${f.byParent ? ', by a parent agent' : ''})`
    if (used + l.length > JUDGE_CONTEXT_LIMITS.filesChars) {
      lines.push(`- … (+${x.touchedFiles.length - lines.length})`)
      break
    }
    used += l.length
    lines.push(l)
  }
  return `\nFiles the agent created or edited during this task (changing, moving or deleting them is part of the work):\n${lines.join('\n')}\n`
}

/** {{approved_before}}: whitelist parecida + o que você aprovou nesta sessão. */
export function approvedBlock(x: JudgeExtras): string {
  const max = JUDGE_CONTEXT_LIMITS.approvedChars
  const parts: string[] = []
  let left = max
  const list = (label: string, items: string[]): void => {
    if (!items.length || left < 60) return
    const text = cut(items.join(' · '), left - label.length)
    parts.push(`- ${label}${text}`)
    left -= label.length + text.length
  }
  list("user's whitelist (similar entries): ", x.approvedWhitelist)
  list('approved by the user earlier in this session: ', x.approvedByUser)
  if (!parts.length) return ''
  return `\nPreviously approved (context only):\n${parts.join('\n')}\n`
}

/** {{recent_activity}}: últimas chamadas de tool (status + nome + args curtos; nunca o resultado). */
export function recentActivityBlock(x: JudgeExtras): string {
  if (!x.recentTools.length) return ''
  const lines: string[] = ["Agent's recent tool calls (oldest first; outputs are never shown):"]
  for (const t of x.recentTools)
    lines.push(`- [${t.status}] ${t.name}${t.summary ? `: ${t.summary}` : ''}`)
  return `\n${lines.join('\n')}\n`
}

/** {{environment}}: a descrição do ambiente escrita por você e o contexto capturado da conversa. */
export interface JudgeEnvironment {
  /** Descrição do ambiente (usuário): a do chat/persona ou a global. */
  user?: string
  /** Contexto capturado da conversa (resumidor; no subagente, a descrição derivada dele). */
  captured?: string
}

/**
 * Texto de {{environment}} (vazio sem nada). Fica no começo do template (muda pouco → cache). As
 * duas partes são separadas: a sua descrição é informação confiável sobre as máquinas e o que pode
 * ser feito; a capturada resume só o que você disse na conversa.
 */
export function environmentBlock(env: JudgeEnvironment | undefined): string {
  const L = JUDGE_CONTEXT_LIMITS
  const clip = (t: string, max: number): string => {
    const s = t.replace(/\r/g, '').trim()
    return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s
  }
  const parts: string[] = []
  if (env?.user?.trim())
    parts.push(
      `Descrição do ambiente (usuário) — written by the user about their machines and what may be done there:\n"""\n${clip(env.user, L.environmentChars)}\n"""`
    )
  if (env?.captured?.trim())
    parts.push(
      `Contexto capturado da conversa — summarized by the app from what the user typed (goals, constraints, permissions they gave):\n"""\n${clip(env.captured, L.capturedChars)}\n"""`
    )
  return parts.length ? `${parts.join('\n')}\n` : ''
}

/**
 * {{commands}} com a avaliação das listas: um item por linha (árvore como no card), marcando o que
 * a whitelist já liberou (contexto) e o que o juiz decide. Páginas (um item só) → "".
 */
export function checkBlock(check: ApprovalCheck, judgeIdx: number[], maxLines = 120): string {
  if (check.item === 'pages' || !check.items.length) return ''
  const judge = new Set(judgeIdx)
  const lines: string[] = []
  const open: (string | undefined)[] = []
  check.items.forEach((it, i) => {
    const d = it.depth ?? 0
    const pad = '  '.repeat(d)
    if (it.group && open[d] !== it.group) lines.push(`${pad}[${it.group}]`)
    open[d] = it.group
    open.length = d + 1
    const tags: string[] = []
    if (it.readOnly && !judge.has(i)) tags.push('read-only (always allowed)')
    else if (judge.has(i)) {
      tags.push(
        it.verdict === 'allow' && it.entry
          ? `TO DECIDE — matches whitelist "${it.entry}"`
          : 'TO DECIDE'
      )
      if (it.reason) tags.push(`never auto-allowed by the whitelist: ${it.reason}`)
    } else if (it.verdict === 'allow') tags.push(`already allowed by whitelist "${it.entry ?? ''}"`)
    if (it.note && it.note !== it.group) tags.push(it.note)
    const text = it.text.length > 300 ? `${it.text.slice(0, 300)}…` : it.text
    lines.push(`${pad}- ${text}   [${tags.join('; ')}]`)
    // o que o script executado faz (começo do arquivo / código inline)
    if (judge.has(i) && it.script) lines.push(scriptJudgeText(it.script, pad).slice(1))
  })
  const body =
    lines.length > maxLines
      ? [...lines.slice(0, maxLines), `… (+${lines.length - maxLines})`].join('\n')
      : lines.join('\n')
  return `\nDecomposed commands (parsed by the app; indented lines run inside the line above). Items "already allowed" matched the user's whitelist and are shown only as context — judge the items marked TO DECIDE:\n${body}\n`
}

/** Rótulos dos itens que o juiz decide (registro `judged`, card). */
export function judgedLabels(
  check: ApprovalCheck | undefined,
  judgeIdx: number[] | undefined
): string[] {
  if (!check || !judgeIdx) return []
  return judgeIdx
    .map((i) => check.items[i])
    .filter(Boolean)
    .map((it) => checkItemLabel(it))
}
