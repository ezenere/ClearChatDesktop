// "O que foi ouvido" de uma frase falada, em palavras (`@shared/heardText`): o mapeamento
// ms → caracteres EXATO (alinhamento por letra do motor — ElevenLabs WebSocket, via
// `AlignedPcmSegmenter.unitStartsMs`) e ESTIMADO (proporcional à duração pelos caracteres falados),
// ambos conservadores (−150 ms, para baixo até a palavra anterior, nunca dentro de uma tag), o
// prefixo de volta no texto original quando as tags foram tiradas da síntese, e a leitura ao vivo
// (`liveDimFrom`).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/heardText.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EST_MS_PER_UNIT,
  HEARD_SAFETY_MS,
  heardChars,
  heardPrefix,
  liveDimFrom
} from '../src/shared/heardText.ts'
import { AlignedPcmSegmenter } from '../src/main/voice/alignedSegments.ts'

const TEXT = 'Esta é uma frase bem longa sobre gatos e cachorros.'
const prefix = (chars: number): string => TEXT.slice(0, chars)

/** Alinhamento sintético: cada letra/dígito começa 80 ms depois da anterior (espaço = +40 ms). */
function unitStarts(text: string, msPerUnit = 80): number[] {
  const out: number[] = []
  let t = 0
  for (const c of text) {
    if (/[\p{L}\p{N}]/u.test(c)) {
      out.push(t)
      t += msPerUnit
    } else t += 40
  }
  return out
}

test('estimado: proporcional à duração, conservador (−150 ms) e sempre numa fronteira de palavra', () => {
  assert.equal(HEARD_SAFETY_MS, 150)
  const half = heardChars(TEXT, 1650, { durationMs: 3000 })
  assert.equal(half.mode, 'estimated')
  const p = prefix(half.chars)
  assert.ok(TEXT.startsWith(p) && p.length > 0)
  assert.ok(TEXT[half.chars] === ' ' || half.chars === TEXT.length, `fronteira: "${p}|"`)
  assert.ok(half.chars < TEXT.length * 0.6, `~metade, nunca além: "${p}"`)
  // mais tempo tocado → nunca menos texto
  let last = 0
  for (let ms = 0; ms <= 3000; ms += 100) {
    const c = heardChars(TEXT, ms, { durationMs: 3000 }).chars
    assert.ok(c >= last, `monótono em ${ms} ms`)
    last = c
  }
  // começo (< 150 ms) = nada; tudo tocado = o texto inteiro
  assert.equal(heardChars(TEXT, 120, { durationMs: 3000 }).chars, 0)
  assert.equal(heardChars(TEXT, 3000, { durationMs: 3000 }).chars, TEXT.length)
  // duração ainda desconhecida: ~70 ms por letra
  const noDur = heardChars(TEXT, HEARD_SAFETY_MS + EST_MS_PER_UNIT * 9, {})
  assert.equal(prefix(noDur.chars), 'Esta é')
  // markdown não conta como fala (os ** não "gastam" tempo); a vírgula pesa uma pausa
  const md = heardChars('**Sim**, claro.', 400, { durationMs: 1000 })
  assert.equal('**Sim**, claro.'.slice(0, md.chars), '**Sim**')
  assert.equal(
    heardChars('Sim, claro.', 400, { durationMs: 1000 }).chars,
    'Sim'.length,
    'mesmo ponto sem o markdown'
  )
})

test('exato: pelas letras alinhadas, só a unidade cuja seguinte já começou; arredonda para baixo', () => {
  const starts = unitStarts(TEXT)
  // "Esta é uma" = 8 letras (inclui o é) + 2 espaços → a 9ª letra ("f" de "frase") começa em 8×80+3×40
  const fStart = starts[8]
  const r = heardChars(TEXT, fStart + HEARD_SAFETY_MS + 200, { unitStartsMs: starts })
  assert.equal(r.mode, 'exact')
  assert.equal(prefix(r.chars), 'Esta é uma', 'meia palavra ("fr…") não conta')
  const all = heardChars(TEXT, 10_000, { unitStartsMs: starts })
  assert.equal(prefix(all.chars), TEXT.replace(/\.$/, ''), 'tudo (até a última letra)')
  // alinhamento parcial (o fim ainda não chegou): só o que está alinhado
  const partial = heardChars(TEXT, 10_000, { unitStartsMs: starts.slice(0, 12) })
  assert.ok(prefix(partial.chars).length < TEXT.length / 2)
  // o modo exato ganha do estimado quando há alinhamento
  assert.equal(heardChars(TEXT, 1000, { durationMs: 3000, unitStartsMs: starts }).mode, 'exact')
})

test('tags de voz: nunca cortadas no meio; prefixo volta ao original quando a síntese não teve as tags', () => {
  const original = 'Claro! [laughs] Isso é muito engraçado mesmo.'
  const speech = 'Claro! Isso é muito engraçado mesmo.'
  const h = heardPrefix(original, speech, 1200, { durationMs: 2400 })
  assert.ok(original.startsWith(h.text), h.text)
  assert.ok(!/\[[^\]]*$/.test(h.text), `tag inteira ou nenhuma: "${h.text}"`)
  assert.match(h.text, /^Claro! \[laughs\] Isso/, 'a tag (não falada) vem junto do que a seguiu')
  // texto igual ao falado (voz que interpreta tags): direto
  const same = heardPrefix(original, original, 100_000, { durationMs: 2400 })
  assert.equal(same.text, original)
  // corte cairia dentro da tag → vai para antes dela
  const at = heardChars('Oi. [nervous, whispering] Ninguém respondeu.', 700, { durationMs: 2000 })
  const s = 'Oi. [nervous, whispering] Ninguém respondeu.'.slice(0, at.chars)
  assert.ok(!/\[[^\]]*$/.test(s), s)
})

test('leitura ao vivo: offset do que ainda não foi falado na mensagem certa', () => {
  const content = 'Primeira frase aqui. Segunda frase bem mais longa. Terceira.'
  assert.equal(liveDimFrom(content, [], null), null, 'nada tocando')
  const cur = { text: 'Segunda frase bem mais longa.', chars: 'Segunda frase'.length }
  assert.equal(
    liveDimFrom(content, ['Primeira frase aqui.'], cur),
    content.indexOf('Segunda') + 'Segunda frase'.length
  )
  // a frase atual não está nesta mensagem (outra mensagem está sendo falada)
  assert.equal(liveDimFrom('Outra mensagem qualquer.', [], cur), null)
  // terminou a última frase → nada a esmaecer
  const last = { text: 'Terceira.', chars: 'Terceira.'.length }
  assert.equal(
    liveDimFrom(content, ['Primeira frase aqui.', 'Segunda frase bem mais longa.'], last),
    null
  )
})

test('AlignedPcmSegmenter.unitStartsMs: início de cada letra relativo ao começo da fatia', () => {
  const seg = new AlignedPcmSegmenter({ sampleRate: 1000 })
  seg.addSegment(3) // "Oi a" → O, i, a
  seg.addSegment(2) // "ok"
  seg.pushAlignment({
    chars: ['O', 'i', ' ', 'a', '.', ' ', 'o', 'k'],
    charStartTimesMs: [0, 100, 200, 300, 400, 500, 900, 1000],
    charDurationsMs: [100, 100, 100, 100, 100, 400, 100, 100]
  })
  seg.pushPcm(new Uint8Array(2 * 1200))
  seg.finish()
  assert.deepEqual(seg.unitStartsMs(0), [0, 100, 300])
  const second = seg.unitStartsMs(1)
  assert.ok(second && second.length === 2, JSON.stringify(second))
  assert.ok(second![0] >= 0 && second![1] - second![0] === 100, 'relativo ao começo da fatia')
  // sem alinhamento (estimativa) → null
  const est = new AlignedPcmSegmenter({ sampleRate: 1000, noAlignmentAfterMs: 10 })
  est.addSegment(2)
  est.pushPcm(new Uint8Array(2 * 100))
  assert.equal(est.unitStartsMs(0), null)
})
