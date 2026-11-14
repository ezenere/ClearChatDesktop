// Resumos das seções recolhíveis do painel / editor de personas (o que aparece no cabeçalho
// quando a seção está fechada): o que foi alterado em relação ao padrão, para que nada
// personalizado fique invisível por acidente. Funções puras (testadas em e2e/unit.test.ts).
import {
  DEFAULT_COMPACT_THRESHOLD,
  DEFAULT_SMART_APPROVE_LABELS,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT
} from '@shared/defaults'
import {
  APP_SIGNATURES,
  DEFAULT_APP_SIGNATURE,
  normalizeAppSignatureId
} from '@shared/appSignatures'
import { ITEM_LABEL, normalizeChatModes } from '@shared/approvalPolicy'
import { LIMITS } from '@shared/limits'
import type { MemoryConfig } from '@shared/memory'
import type { SkillsConfig } from '@shared/skills'
import { normalizeSmartApprove, SMART_APPROVE_DEFAULTS } from '@shared/smartApprove'
import type { ChatConfig, ChatParams } from '@shared/types'

export interface SectionSummary {
  /** Texto curto (cabeçalho da seção fechada). */
  text: string
  /** Algo difere do padrão → o resumo ganha destaque. */
  changed: boolean
}

/** Erro de um texto que deve ser um objeto JSON (vazio = ok). */
export function validateJson(text: string): string | null {
  if (!text.trim()) return null
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Deve ser um objeto JSON'
    return null
  } catch (err) {
    return (err as Error).message.replace(/^JSON\.parse: /, '')
  }
}

const num = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 4 })

/** "N alterado(s) · a · b" ou o texto do padrão. */
export function changedSummary(changes: string[], fallback = 'padrão'): SectionSummary {
  if (!changes.length) return { text: fallback, changed: false }
  const n = changes.length
  return {
    text: `${n} ${n === 1 ? 'alterado' : 'alterados'} · ${changes.join(' · ')}`,
    changed: true
  }
}

/** Último segmento do id do modelo (`anthropic/claude-sonnet-4.5` → `claude-sonnet-4.5`). */
export function shortModel(model: string | null | undefined): string {
  const m = (model ?? '').trim()
  return m.includes('/') ? m.split('/').slice(1).join('/') : m
}

/** Última pasta de um caminho. */
export function baseName(path: string | null | undefined): string {
  const p = (path ?? '').replace(/[\\/]+$/, '')
  return p.split(/[\\/]/).pop() || p || '/'
}

// ---------------- Modelo ----------------

/** Seção Modelo fechada: o modelo (id curto) e o raciocínio enviado (só se o modelo o aceita). */
export function modelSummary(model: string, effort?: string | null): SectionSummary {
  const m = shortModel(model)
  if (!m) return { text: 'sem modelo', changed: true }
  return { text: effort ? `${m} · raciocínio ${effort}` : m, changed: false }
}

export function systemPromptSummary(text: string, defaultText?: string | null): SectionSummary {
  if (!text.trim()) return { text: 'vazio', changed: true }
  return text === (defaultText ?? DEFAULT_SYSTEM_PROMPT)
    ? { text: 'padrão', changed: false }
    : { text: 'personalizado', changed: true }
}

type NumKey = Exclude<keyof ChatParams, 'extraBody' | 'reasoning_effort'>
const NUM_KEYS: NumKey[] = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed'
]

/** Parâmetros numéricos enviados (padrão = nenhum: o provedor usa os dele). */
export function paramsSummary(params: ChatParams): SectionSummary {
  const on = NUM_KEYS.filter((k) => params[k] != null)
  return changedSummary(on.map((k) => `${k} ${num(params[k] as number)}`))
}

export function requestSummary(cfg: ChatConfig, defaultCache: boolean): SectionSummary {
  const changes: string[] = []
  if (cfg.cacheEnabled !== defaultCache)
    changes.push(cfg.cacheEnabled ? 'cache ligado' : 'cache desligado')
  if (cfg.params.extraBody?.trim()) changes.push('body extra')
  return changedSummary(changes, cfg.cacheEnabled ? 'padrão · cache ligado' : 'padrão · sem cache')
}

// ---------------- Chat ----------------

export function compactionSummary(cfg: ChatConfig): SectionSummary {
  const changes: string[] = []
  if (cfg.contextWindow != null && cfg.contextWindow > 0)
    changes.push(`janela ${num(cfg.contextWindow)}`)
  const pct = Math.round((cfg.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD) * 100)
  if (pct !== Math.round(DEFAULT_COMPACT_THRESHOLD * 100)) changes.push(`sugere em ${pct}%`)
  if (cfg.autoCompact) changes.push('automática')
  if (cfg.compactPrompt != null) changes.push('prompt personalizado')
  return changedSummary(changes, `padrão · sugere em ${pct}%`)
}

/** Confinar / sandbox / bloco de ambiente (`sandbox` só conta com bwrap disponível). */
export function rootOptionsChanges(cfg: ChatConfig, bwrap: boolean): string[] {
  const changes: string[] = []
  if (cfg.confineToRoot === false) changes.push('sem confinar')
  if (bwrap && cfg.sandboxBash) changes.push('sandbox')
  if (!cfg.envInPrompt) changes.push('sem bloco de ambiente')
  return changes
}

export function rootSummary(cfg: ChatConfig, bwrap: boolean, rootLabel: string): SectionSummary {
  return changedSummary(rootOptionsChanges(cfg, bwrap), rootLabel)
}

export function signatureSummary(
  id: string | undefined,
  custom?: { title?: string; referer?: string } | null
): SectionSummary {
  const v = normalizeAppSignatureId(id)
  const label = APP_SIGNATURES.find((s) => s.id === v)?.label ?? v
  if (v === DEFAULT_APP_SIGNATURE) return { text: label, changed: false }
  const name = custom?.title?.trim() || custom?.referer?.trim()
  return { text: v === 'custom' && name ? `${label} · ${name}` : label, changed: true }
}

// ---------------- Tools ----------------

export function approvalsSummary(cfg: Pick<ChatConfig, 'approvalModes'>): SectionSummary {
  const own = Object.keys(normalizeChatModes(cfg.approvalModes)) as (keyof typeof ITEM_LABEL)[]
  return changedSummary(
    own.map((i) => ITEM_LABEL[i]),
    'segue o padrão global'
  )
}

export function smartApproveSummary(cfg: Pick<ChatConfig, 'smartApprove'>): SectionSummary {
  const sa = normalizeSmartApprove(cfg.smartApprove)
  const changes: string[] = []
  if (sa.model) changes.push(shortModel(sa.model))
  changes.push(...smartAdvancedChanges(cfg))
  return changedSummary(changes, 'sem modelo')
}

/** Resumo do "Avançado" do Smart-Approve (o que difere do padrão). */
export function smartAdvancedSummary(cfg: Pick<ChatConfig, 'smartApprove'>): SectionSummary {
  return changedSummary(smartAdvancedChanges(cfg), 'padrão')
}

function smartAdvancedChanges(cfg: Pick<ChatConfig, 'smartApprove'>): string[] {
  const sa = normalizeSmartApprove(cfg.smartApprove)
  const changes: string[] = []
  if (sa.canDeny) changes.push('pode negar')
  if (sa.judgeWhitelisted) changes.push('julga a whitelist')
  if (
    sa.labels.approve !== DEFAULT_SMART_APPROVE_LABELS.approve ||
    sa.labels.reject !== DEFAULT_SMART_APPROVE_LABELS.reject ||
    sa.labels.ask !== DEFAULT_SMART_APPROVE_LABELS.ask
  )
    changes.push('rótulos')
  if (sa.contextMessages !== SMART_APPROVE_DEFAULTS.contextMessages)
    changes.push(`${sa.contextMessages} msgs`)
  if (sa.timeoutS !== SMART_APPROVE_DEFAULTS.timeoutS) changes.push(`${sa.timeoutS} s`)
  if (sa.prompt != null || sa.template != null) changes.push('prompt personalizado')
  if (typeof sa.environment === 'string') changes.push('ambiente do chat')
  if (sa.capture) changes.push(sa.capture.enabled ? 'coleta de contexto' : 'sem coleta')
  return changes
}

export function toolsSendingSummary(cfg: ChatConfig): SectionSummary {
  const changes: string[] = []
  if (!cfg.nativeTools) changes.push('sem tools nativas')
  if (cfg.toolsInPrompt) changes.push('texto no prompt')
  if (cfg.toolsInPrompt && cfg.toolsPromptText != null) changes.push('texto personalizado')
  return changedSummary(changes, 'padrão · tools nativas')
}

export function subagentsSummary(
  cfg: ChatConfig,
  memorySubagents: boolean,
  skillsSubagents: boolean
): SectionSummary {
  const changes: string[] = []
  if (cfg.subagentSystemPrompt !== DEFAULT_SUBAGENT_SYSTEM_PROMPT)
    changes.push(cfg.subagentSystemPrompt.trim() ? 'prompt personalizado' : 'prompt vazio')
  if (memorySubagents) changes.push('memória')
  if (skillsSubagents) changes.push('skills')
  return changedSummary(changes)
}

export function limitsSummary(cfg: Pick<ChatConfig, 'maxToolOutputChars'>): SectionSummary {
  const max = cfg.maxToolOutputChars ?? LIMITS.maxToolOutputChars
  return max === LIMITS.maxToolOutputChars
    ? { text: `padrão · ${num(max)} caracteres`, changed: false }
    : changedSummary([`saída máx. ${num(max)}`])
}

/** Seção Skills fechada: desligadas (padrão) ou quantas das encontradas estão ativas. */
export function skillsSummary(
  sc: Pick<SkillsConfig, 'enabled'>,
  active: number,
  total: number
): SectionSummary {
  if (!sc.enabled) return { text: 'desligadas', changed: false }
  return {
    text: total ? `ligadas · ${active}/${total} ativas` : 'ligadas · nenhuma encontrada',
    changed: true
  }
}

export function skillsDetailsSummary(sc: SkillsConfig): SectionSummary {
  const changes: string[] = []
  if (sc.disabled.length)
    changes.push(`${sc.disabled.length} ${sc.disabled.length === 1 ? 'desligada' : 'desligadas'}`)
  if (!sc.supportPrompt.enabled) changes.push('sem prompt de apoio')
  else if (sc.supportPrompt.text != null) changes.push('prompt personalizado')
  if (sc.subagents) changes.push('nos subagentes')
  return changedSummary(changes, 'todas · prompt de apoio')
}

// ---------------- Memória ----------------

/** Seção Memória fechada: desligada (padrão), ou ligada com quantas coleções vão no índice. */
export function memorySummary(mem: Pick<MemoryConfig, 'enabled'>, indexed: number): SectionSummary {
  if (!mem.enabled) return { text: 'desligada', changed: false }
  return {
    text: indexed
      ? `ligada · ${indexed} ${indexed === 1 ? 'coleção' : 'coleções'}`
      : 'ligada · nada vai para a API',
    changed: true
  }
}

export function memoryHelpSummary(mem: MemoryConfig): SectionSummary {
  if (!mem.helpPrompt.enabled) return { text: 'desligadas', changed: false }
  return {
    text: mem.helpPrompt.text != null ? 'ligadas · texto personalizado' : 'ligadas',
    changed: true
  }
}

export function memoryExtractionSummary(mem: MemoryConfig): SectionSummary {
  const ex = mem.extraction
  const changes: string[] = []
  if (ex.auto) changes.push('automática')
  if (ex.model) changes.push(shortModel(ex.model))
  if (ex.prompt != null) changes.push('prompt personalizado')
  return changedSummary(changes, 'manual · modelo do chat')
}

export function memorySubagentsSummary(mem: MemoryConfig): SectionSummary {
  return mem.subagents ? { text: 'ligada', changed: true } : { text: 'desligada', changed: false }
}
