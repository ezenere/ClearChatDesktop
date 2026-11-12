// Texto das mensagens da chamada de voz no Markdown do chat (plugin remark PURO — sem DOM):
// - **tags de voz** (`@shared/audioTags` — "[sussurra]", "[risos]") ficam no texto, com os colchetes,
//   numa `<span class="voice-tag">` (opacidade 0,65 — mesma fonte/itálico do texto da fala, sem
//   chip nem fundo); só fora de código (`inlineCode`/`code` nunca são tocados);
// - **o que ainda não foi falado** (leitura ao vivo / resto não ouvido depois de um barge-in): a
//   partir de `dimFrom` (offset no texto-fonte) o texto vai numa `<span class="voice-unheard">`
//   (opacidade 0,5); código/imagens depois do offset ganham a mesma classe. Uma tag dentro do trecho
//   esmaecido continua com o 0,65 RELATIVO a ele (spans aninhadas).
// Usado por `components/chat/Markdown.tsx` (prop `voice`); testado em `e2e/voiceText.test.ts`.
import { audioTagRe } from '@shared/audioTags'

/** Nó mínimo do mdast (o que o plugin lê/escreve). */
export interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: { hName?: string; hProperties?: Record<string, unknown>; [k: string]: unknown }
}

export interface VoiceTextOptions {
  /** Esmaecer as tags de voz (mensagens da chamada). */
  tags?: boolean
  /** Offset (no texto-fonte) a partir do qual o texto ainda não foi falado; null = tudo falado. */
  dimFrom?: number | null
}

const span = (cls: string, children: MdNode[]): MdNode => ({
  type: 'voiceSpan',
  children,
  data: { hName: 'span', hProperties: { className: [cls] } }
})

/** Texto → nós de texto e de tag de voz. */
function splitTags(value: string, tags: boolean): MdNode[] {
  if (!tags || !value) return value ? [{ type: 'text', value }] : []
  const out: MdNode[] = []
  let last = 0
  for (const m of value.matchAll(audioTagRe())) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push(span('voice-tag', [{ type: 'text', value: m[0] }]))
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

const addClass = (node: MdNode, cls: string): void => {
  node.data = node.data ?? {}
  const props = (node.data.hProperties = node.data.hProperties ?? {})
  const prev = props.className
  props.className = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), cls]
}

/** Transforma a árvore (in place). */
export function transformVoiceText(tree: MdNode, opts: VoiceTextOptions): void {
  const tags = !!opts.tags
  const dim = typeof opts.dimFrom === 'number' && opts.dimFrom >= 0 ? opts.dimFrom : null
  if (!tags && dim == null) return
  const walk = (node: MdNode): void => {
    if (!node.children) return
    const next: MdNode[] = []
    for (const child of node.children) {
      const start = child.position?.start.offset
      const end = child.position?.end.offset
      if (child.type === 'text' && typeof child.value === 'string') {
        const v = child.value
        // ponto de corte do "ainda não falado" dentro deste texto (aproximado quando o texto
        // difere do trecho-fonte — escapes/entidades)
        let cut = v.length
        if (dim != null && start != null) {
          if (start >= dim) cut = 0
          else if (end != null && end > dim) {
            const srcLen = Math.max(1, end - start)
            cut = Math.round(((dim - start) / srcLen) * v.length)
            // nunca no meio de uma tag de voz: a tag vai inteira para o lado em que começa
            for (const m of v.matchAll(audioTagRe()))
              if (cut > m.index && cut < m.index + m[0].length) cut = m.index
          }
        }
        next.push(...splitTags(v.slice(0, cut), tags))
        const rest = v.slice(cut)
        if (rest) next.push(span('voice-unheard', splitTags(rest, tags)))
        continue
      }
      if (child.type === 'code' || child.type === 'inlineCode' || child.type === 'image') {
        if (dim != null && start != null && start >= dim) addClass(child, 'voice-unheard')
        next.push(child)
        continue
      }
      walk(child)
      next.push(child)
    }
    node.children = next
  }
  walk(tree)
}

/** Plugin remark (`[remarkVoiceText, opts]`). */
export function remarkVoiceText(opts: VoiceTextOptions): (tree: MdNode) => void {
  return (tree) => transformVoiceText(tree, opts)
}
