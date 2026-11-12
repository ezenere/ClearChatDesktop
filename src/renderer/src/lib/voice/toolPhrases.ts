// Frases de ferramenta no renderer (SPEC → "Frases de ferramenta"): rótulos pt-BR das categorias
// (editor de Configurações → Áudio → Chamada de voz e timeline do painel da chamada) e a edição
// do pool por categoria.
import {
  DEFAULT_TOOL_PHRASE_POOL,
  normalizeToolPhrasePool,
  type ToolPhrase,
  type ToolPhraseCategory
} from '@shared/voice'

export const TOOL_PHRASE_CATEGORY_LABELS: Record<ToolPhraseCategory, string> = {
  web: 'Web (pesquisa/navegação)',
  files: 'Arquivos',
  shell: 'Comandos e processos',
  memory: 'Memória',
  agents: 'Subagentes e outros chats',
  info: 'Modelos e informações',
  location: 'Localização',
  generic: 'Genérica (demais tools)'
}

/** Rótulo curto (timeline): "web", "arquivos"… — desconhecido volta como veio. */
export function toolPhraseCategoryShort(cat: string): string {
  const short: Record<string, string> = {
    web: 'web',
    files: 'arquivos',
    shell: 'comando',
    memory: 'memória',
    agents: 'subagentes',
    info: 'informações',
    location: 'localização',
    generic: 'genérica',
    none: 'sem categoria'
  }
  return short[cat] ?? cat
}

/** Pool → chave de comparação (texto + categorias, sem depender da ordem). */
const poolKey = (pool: readonly ToolPhrase[]): string =>
  pool
    .map((p) => `${p.text}\u0000${[...p.categories].sort().join(',')}`)
    .sort()
    .join('\n')

/**
 * Pool com as frases de `cat` trocadas por `lines` (no lugar onde elas estavam — a ordem das outras
 * categorias não muda): a mesma frase em várias categorias continua uma entrada só (as categorias
 * se juntam). Igual ao padrão (ou nada válido) → null (= padrão).
 */
export function replaceCategoryLines(
  pool: readonly ToolPhrase[],
  cat: ToolPhraseCategory,
  lines: readonly string[]
): ToolPhrase[] | null {
  const out: ToolPhrase[] = []
  const add = (text: string, cats: readonly ToolPhraseCategory[]): void => {
    const t = text.trim()
    if (!t || !cats.length) return
    const hit = out.find((p) => p.text === t)
    if (!hit) out.push({ text: t, categories: [...cats] })
    else for (const c of cats) if (!hit.categories.includes(c)) hit.categories.push(c)
  }
  let inserted = false
  const insertNew = (): void => {
    if (inserted) return
    inserted = true
    for (const l of lines) add(l, [cat])
  }
  for (const p of pool) {
    if (p.categories.includes(cat)) insertNew()
    add(
      p.text,
      p.categories.filter((c) => c !== cat)
    )
  }
  insertNew()
  const next = normalizeToolPhrasePool(out)
  if (!next || poolKey(next) === poolKey(DEFAULT_TOOL_PHRASE_POOL)) return null
  return next
}
