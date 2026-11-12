// Texto das mensagens da chamada no Markdown (plugin `remarkVoiceText` — `src/renderer/src/lib/
// voiceText.ts`): tags de voz esmaecidas no lugar (com os colchetes, nunca em código) e o trecho
// ainda não falado esmaecido a partir de um offset (leitura ao vivo / resto depois do barge-in).
// Render pelo mesmo caminho do react-markdown: mdast (`mdast-util-from-markdown`) → hast
// (`mdast-util-to-hast`) — sem DOM.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceText.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toHast } from 'mdast-util-to-hast'
import { transformVoiceText, type MdNode } from '../src/renderer/src/lib/voiceText.ts'

interface HNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: string[] }
  children?: HNode[]
}

/** Markdown → hast com o plugin (como o `<Markdown voice>` faz). */
function render(md: string, opts: { tags?: boolean; dimFrom?: number | null }): HNode {
  const tree = fromMarkdown(md) as unknown as MdNode
  transformVoiceText(tree, opts)
  return toHast(tree as never) as unknown as HNode
}

/** HTML mínimo (só tag/classe/texto) para comparar. */
function html(n: HNode): string {
  if (n.type === 'text') return n.value ?? ''
  const inner = (n.children ?? []).map(html).join('')
  if (n.type === 'root') return inner
  const cls = n.properties?.className?.length ? ` class="${n.properties.className.join(' ')}"` : ''
  return `<${n.tagName}${cls}>${inner}</${n.tagName}>`
}

test('tags de voz: no lugar, com os colchetes, numa span esmaecida — nunca em código', () => {
  const out = html(
    render('Claro! [risos] Que ideia. Use `[x] item` e [o link](http://a.b).', { tags: true })
  )
  assert.match(
    out,
    /^<p>Claro! <span class="voice-tag">\[risos\]<\/span> Que ideia\. Use <code>\[x\] item<\/code> e <a>o link<\/a>\.<\/p>$/
  )
  assert.match(out, /<span class="voice-tag">\[risos\]<\/span>/)
  assert.ok(!out.includes('voice-tag">[x]'), 'checkbox em código não vira tag')
  // bloco de código intacto
  const block = html(render('```\n[sussurra] dentro\n```', { tags: true }))
  assert.ok(!block.includes('voice-tag'))
  // Fish: direção livre com vírgula
  assert.match(
    html(render('[nervous, whispering] Ninguém respondeu.', { tags: true })),
    /<span class="voice-tag">\[nervous, whispering\]<\/span> Ninguém respondeu\./
  )
  // sem a opção: nada muda
  assert.equal(html(render('Oi [risos]', {})), '<p>Oi [risos]</p>')
})

test('trecho não falado: esmaecido a partir do offset; tag dentro dele mantém o 0,65 relativo', () => {
  const md = 'Primeira frase. Segunda [risos] frase longa.'
  const at = md.indexOf('Segunda')
  const out = html(render(md, { tags: true, dimFrom: at }))
  assert.equal(
    out,
    '<p>Primeira frase. <span class="voice-unheard">Segunda <span class="voice-tag">[risos]</span> frase longa.</span></p>'
  )
  // offset no meio de uma tag: a tag vai inteira para o lado em que começa
  const mid = md.indexOf('isos')
  assert.match(
    html(render(md, { tags: true, dimFrom: mid })),
    /voice-unheard"><span class="voice-tag">\[risos\]/
  )
  // tudo falado (offset no fim) e nada falado (0)
  assert.ok(!html(render(md, { dimFrom: md.length })).includes('voice-unheard'))
  assert.match(html(render(md, { dimFrom: 0 })), /^<p><span class="voice-unheard">Primeira/)
  // parágrafo inteiro depois do offset e código depois dele
  const two = 'Ouvido.\n\nNão ouvido `code` aqui.'
  const o2 = html(render(two, { dimFrom: two.indexOf('Não') }))
  assert.match(o2, /<p>Ouvido\.<\/p>/)
  assert.match(o2, /<code class="voice-unheard">code<\/code>/)
})
