// Preâmbulos da chamada no renderer (SPEC → "Fillers"): rótulos pt-BR dos contextos e a edição do
// pool por contexto (= frases de ferramenta por categoria — lib/voice/toolPhrases.ts).
import {
  DEFAULT_FILLER_POOL,
  FILLER_CONTEXTS,
  normalizeFillerPool,
  type FillerContext,
  type FillerPhrase
} from '@shared/voice'

export const FILLER_CONTEXT_LABELS: Record<FillerContext, string> = {
  question: 'Pergunta',
  command: 'Pedido / comando',
  correction: 'Correção',
  complex: 'Tarefa longa',
  generic: 'Genérico (os demais)'
}

/** Contextos de uma frase (lista vazia = genérico). */
export const fillerContextsOf = (p: FillerPhrase): FillerContext[] =>
  p.contexts.length ? p.contexts : ['generic']

/** Pool → chave de comparação (texto + contextos, sem depender da ordem). */
const poolKey = (pool: readonly FillerPhrase[]): string =>
  pool
    .map((p) => `${p.text}\u0000${[...fillerContextsOf(p)].sort().join(',')}`)
    .sort()
    .join('\n')

/** Pool igual ao padrão do app (texto + contextos)? */
export function isDefaultFillerPool(pool: readonly FillerPhrase[]): boolean {
  return poolKey(pool) === poolKey(DEFAULT_FILLER_POOL)
}

/**
 * Pool com as frases de `ctx` trocadas por `lines` (no lugar onde elas estavam): a mesma frase em
 * vários contextos continua uma entrada só. `keepDefault` = igual ao padrão continua um pool (a
 * persona que copiou o global); sem ele, igual ao padrão (ou nada válido) → null (= padrão).
 */
export function replaceContextLines(
  pool: readonly FillerPhrase[],
  ctx: FillerContext,
  lines: readonly string[],
  keepDefault = false
): FillerPhrase[] | null {
  const out: FillerPhrase[] = []
  const add = (text: string, ctxs: readonly FillerContext[]): void => {
    const t = text.trim()
    if (!t || !ctxs.length) return
    const hit = out.find((p) => p.text === t)
    if (!hit) out.push({ text: t, contexts: [...ctxs] })
    else for (const c of ctxs) if (!hit.contexts.includes(c)) hit.contexts.push(c)
  }
  let inserted = false
  const insertNew = (): void => {
    if (inserted) return
    inserted = true
    for (const l of lines) add(l, [ctx])
  }
  for (const p of pool) {
    const ctxs = fillerContextsOf(p)
    if (ctxs.includes(ctx)) insertNew()
    add(
      p.text,
      ctxs.filter((c) => c !== ctx)
    )
  }
  insertNew()
  // ordem estável dos contextos (a do app)
  for (const p of out) p.contexts = FILLER_CONTEXTS.filter((c) => p.contexts.includes(c))
  const next = normalizeFillerPool(out)
  if (!next) return null
  if (!keepDefault && isDefaultFillerPool(next)) return null
  return next
}
