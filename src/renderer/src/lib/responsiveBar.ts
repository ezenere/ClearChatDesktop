// Recolhimento progressivo do cabeçalho do chat e da barra do composer: cada item desce, por
// prioridade, de rótulo completo → curto → só ícone (o Tip leva o texto inteiro). A ordem mora SÓ
// aqui (BAR_ITEMS). O título do chat não é um item: ele fica e só trunca depois que os itens
// recolheram (ver useBarCollapse em lib/useBarCollapse.ts). Puro — testes em
// e2e/chatUi.test.ts.

/** 0 = completo · 1 = curto · 2 = só ícone (ou some, para textos de ajuda). */
export type BarLevel = 0 | 1 | 2

export type BarItemId =
  // cabeçalho
  | 'approval-indicator'
  | 'retry-indicator'
  | 'question-indicator'
  | 'session-switcher'
  | 'auto-approve'
  | 'processes'
  // composer
  | 'composer-status'
  | 'context-meter'
  | 'model-pill'
  | 'spend'
  | 'voice-controls'
  | 'composer-host'
  | 'composer-info'
  | 'composer-hint'
  | 'composer-file'

export interface BarItemSpec {
  /** Maior = continua legível por mais tempo. */
  priority: number
  /** Níveis que o item tem, do mais completo ao mais compacto. */
  levels: BarLevel[]
  /** O que cada nível mostra (documentação — a SPEC repete esta tabela). */
  doc: string
  /**
   * Só volta a aparecer (sobe de nível na folga) com estes itens completos: um item pequeno de
   * prioridade menor não fica visível enquanto um maior, de prioridade maior, está recolhido.
   */
  yieldsTo?: BarItemId[]
}

export const BAR_ITEMS: Record<BarItemId, BarItemSpec> = {
  'approval-indicator': {
    priority: 100,
    levels: [0, 1],
    doc: '"2 aprovações pendentes" → ícone + "2"'
  },
  'retry-indicator': { priority: 96, levels: [0, 1], doc: '"Falha de conexão" → ícone (+ nº)' },
  'question-indicator': { priority: 95, levels: [0, 1], doc: '"Pergunta pendente" → ícone (+ nº)' },
  'composer-status': {
    priority: 80,
    levels: [0, 2],
    doc: '"Aguardando aprovação" / "Trabalhando…" → só o ponto pulsante'
  },
  'context-meter': { priority: 70, levels: [0, 1, 2], doc: '"38k / 200k · 19%" → "19%" → anel' },
  'model-pill': {
    priority: 65,
    levels: [0, 1, 2],
    doc: '"<Provedor> · <vendor/>modelo" → "modelo" → ícone'
  },
  'session-switcher': {
    priority: 60,
    levels: [0, 1],
    doc: '"<sessão> · N sub" → ícone + "N sub"'
  },
  'auto-approve': {
    priority: 50,
    levels: [0, 2],
    doc: '"Sempre: Páginas, Busca web" / "Smart-Approve" → ícone'
  },
  processes: { priority: 40, levels: [0, 1], doc: '"2 processos" → ícone + "2"' },
  spend: { priority: 30, levels: [0, 2], doc: 'ícone + "$0,42" → ícone' },
  'voice-controls': {
    priority: 20,
    levels: [0, 1],
    doc: '[ telefone | mic | ˅ ] → [ telefone | mic ] (o menu do microfone vai para o botão direito do mic); nunca some'
  },
  'composer-file': {
    priority: 18,
    levels: [0, 1],
    doc: 'chip do arquivo selecionado [ícone nome.ext ×] → [ícone ×] (o caminho fica no tooltip); nunca some'
  },
  'composer-host': {
    priority: 16,
    levels: [0, 2],
    doc: 'ícone do host (local/remoto, só com sync) → some (a linha do host acima do composer continua)',
    yieldsTo: ['voice-controls', 'composer-file']
  },
  'composer-info': {
    priority: 14,
    levels: [0, 2],
    doc: '</> "Sua mensagem" (API) → some',
    yieldsTo: ['voice-controls', 'composer-file']
  },
  'composer-hint': {
    priority: 10,
    levels: [0, 2],
    doc: '"Enter envia · Shift+Enter quebra linha" → some',
    yieldsTo: ['voice-controls', 'composer-file']
  }
}

/** Larguras medidas por nível (px); nível nunca renderizado = ausente (estimado). */
export type BarWidths = Partial<Record<BarLevel, number>>

export interface BarPlanItem {
  id: BarItemId
  widths: BarWidths
}

/** Largura estimada de um nível ainda não medido. */
export function estimateWidth(widths: BarWidths, level: BarLevel): number {
  const known = widths[level]
  if (known != null) return known
  const full = widths[0] ?? widths[1] ?? 120
  if (level === 2) return Math.min(full, 30)
  if (level === 1) return Math.min(full, Math.max(widths[2] ?? 30, 72))
  return full
}

/**
 * Nível de cada item para caber em `available` px: começa tudo completo e, enquanto não cabe,
 * desce um degrau do item de MENOR prioridade que ainda pode descer (um item vai até o fim antes
 * do próximo começar); depois, com a folga que sobrar, sobe de volta os degraus que cabem (maior
 * prioridade primeiro). Determinístico para as mesmas larguras.
 */
export function planCollapse(
  items: BarPlanItem[],
  available: number
): Partial<Record<BarItemId, BarLevel>> {
  const idx = new Map<BarItemId, number>()
  const levels: Partial<Record<BarItemId, BarLevel>> = {}
  for (const it of items) {
    idx.set(it.id, 0)
    levels[it.id] = BAR_ITEMS[it.id].levels[0]
  }
  const width = (it: BarPlanItem): number => estimateWidth(it.widths, levels[it.id]!)
  let total = items.reduce((s, it) => s + width(it), 0)
  const order = [...items].sort(
    (a, b) => BAR_ITEMS[a.id].priority - BAR_ITEMS[b.id].priority || a.id.localeCompare(b.id)
  )
  while (total > available + 0.5) {
    const it = order.find((x) => idx.get(x.id)! < BAR_ITEMS[x.id].levels.length - 1)
    if (!it) break
    const before = width(it)
    const i = idx.get(it.id)! + 1
    idx.set(it.id, i)
    levels[it.id] = BAR_ITEMS[it.id].levels[i]
    total += width(it) - before
  }
  // folga que sobrou (um item grande desceu de uma vez): devolve degraus, maior prioridade
  // primeiro, enquanto couber — menos para quem cede a vez (`yieldsTo`) a um item ainda recolhido
  for (let changed = true; changed;) {
    changed = false
    for (const it of [...order].reverse()) {
      const i = idx.get(it.id)!
      if (i === 0) continue
      if (BAR_ITEMS[it.id].yieldsTo?.some((y) => (idx.get(y) ?? 0) > 0)) continue
      const before = width(it)
      const up = BAR_ITEMS[it.id].levels[i - 1]
      const after = estimateWidth(it.widths, up)
      if (total - before + after > available + 0.5) continue
      idx.set(it.id, i - 1)
      levels[it.id] = up
      total += after - before
      changed = true
    }
  }
  return levels
}
