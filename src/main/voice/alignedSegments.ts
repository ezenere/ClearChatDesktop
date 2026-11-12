// Fala da resposta INTEIRA num contexto só do WebSocket da ElevenLabs, repartida de volta em
// utterances por sentença pelo ALINHAMENTO que a ElevenLabs devolve junto do áudio (main, sem
// Electron — testável). A chamada continua pensando "uma utterance por sentença" (histórico truncado
// ao que foi ouvido, barge-in, ordem), mas o áudio é UM fluxo contínuo: a prosódia não recomeça a
// cada frase e as fatias se emendam amostra a amostra no player (ver SPEC → "ElevenLabs direto").
//
// Alinhamento: cada mensagem de áudio pode trazer `alignment: { chars, charStartTimesMs,
// charDurationsMs }`; os blocos NÃO coincidem com os pedaços de áudio (o 1º bloco costuma descrever
// mais áudio do que chegou), mas são consecutivos — cada bloco começa onde o anterior terminou (a
// soma bate com o áudio total a ±40 ms em 25 s, medido em 2026-10-23). Só letras e dígitos contam
// (`speechUnits`): espaços, pontuação, emoji e markdown podem sumir/mudar no texto alinhado.
//
// Fronteira da sentença k = meio da pausa entre o fim da última unidade da sentença e o começo da
// 1ª unidade da seguinte. Antes de a fronteira ser conhecida a fatia k só solta o áudio até o fim da
// última unidade dela já alinhada (a pausa depois pode ser da próxima) — ou tudo o que chegou, se ela é
// a última cortada e não há texto além no contexto; o FIM dela espera a 1ª unidade da seguinte ou o
// `isFinal` (fim da resposta / contexto ocioso — `ElevenLabsCallTts`). Sem alinhamento nenhum depois
// de `NO_ALIGNMENT_AFTER_MS` de áudio → estimativa por `FALLBACK_MS_PER_UNIT` (proxy/modelo que não
// manda alinhamento — o áudio continua contínuo; só a atribuição ao texto fica aproximada). No fim do
// contexto (`finish`) o que sobrou é repartido pelas sentenças restantes na proporção das unidades.
import { abortError } from '../tools/util'

/** Alinhamento de caracteres de uma mensagem da ElevenLabs (tempos em ms, relativos ao bloco). */
export interface ElevenLabsAlignment {
  chars: string[]
  charStartTimesMs: number[]
  charDurationsMs: number[]
}

/** Unidade de fala: letra ou dígito (o resto pode sumir/mudar no texto alinhado). */
const UNIT = /[\p{L}\p{N}]/u

/** O caractere é uma unidade de fala (letra/dígito)? */
export const isSpeechUnit = (c: string): boolean => UNIT.test(c)

/** Quantas unidades de fala (letras/dígitos) há no texto. */
export function speechUnits(text: string): number {
  let n = 0
  for (const c of text) if (UNIT.test(c)) n++
  return n
}

/** Alinhamento bem formado? (listas do mesmo tamanho, números finitos). */
export function parseAlignment(raw: unknown): ElevenLabsAlignment | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const chars = a.chars
  const st = a.charStartTimesMs ?? a.char_start_times_ms
  const du = a.charDurationsMs ?? a.char_durations_ms
  if (!Array.isArray(chars) || !Array.isArray(st) || !Array.isArray(du)) return null
  if (!chars.length || chars.length !== st.length || chars.length !== du.length) return null
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!st.every(ok) || !du.every(ok)) return null
  return { chars: chars.map((c) => String(c)), charStartTimesMs: st, charDurationsMs: du }
}

/** ms de áudio por unidade de fala na estimativa sem alinhamento (Flash v2.5 pt-BR: ~70 ms). */
export const FALLBACK_MS_PER_UNIT = 70

/** Áudio sem nenhum alinhamento depois disto → modo estimativa. */
export const NO_ALIGNMENT_AFTER_MS = 1500

/** Silêncio entregue por uma fatia que terminaria vazia (a utterance existe e toca ~20 ms). */
const EMPTY_SEGMENT_MS = 20

interface Segment {
  /** Unidades acumuladas até o fim desta sentença (inclusive). */
  cut: number
  /** Unidades desta sentença. */
  units: number
  /** Fim (amostra absoluta, exclusivo) quando conhecido. */
  end: number | null
  /** Até onde o consumidor já leu (amostra absoluta). */
  pos: number | null
  dropped: boolean
  emitted: number
}

export interface AlignedPcmSegmenterOptions {
  sampleRate: number
  fallbackMsPerUnit?: number
  noAlignmentAfterMs?: number
}

/**
 * Um contexto (resposta) → N fatias (sentenças). Entradas: `addSegment` (o cortador fechou uma
 * sentença, na ordem), `pushPcm`/`pushAlignment` (do socket), `setTailOpen` (há texto além da última
 * sentença cortada no contexto — o áudio depois dela pode ser da próxima), `finish`/`fail`.
 * Saída: `stream(i)` — o PCM da fatia i, ao vivo.
 */
export class AlignedPcmSegmenter {
  readonly sampleRate: number
  readonly #msPerUnit: number
  readonly #noAlignAfter: number
  #chunks: { at: number; pcm: Uint8Array }[] = []
  /** Amostras recebidas. */
  #received = 0
  /** Início/fim (ms) de cada unidade alinhada, na ordem. */
  #uStart: number[] = []
  #uEnd: number[] = []
  /** Fim do último bloco de alinhamento (ms). */
  #cursorMs = 0
  #blocks = 0
  #estimate = false
  #segs: Segment[] = []
  #tailOpen = false
  #final = false
  #error: unknown = null
  #aborted = false
  #waiters = new Set<() => void>()

  constructor(opts: AlignedPcmSegmenterOptions) {
    this.sampleRate = opts.sampleRate
    this.#msPerUnit = opts.fallbackMsPerUnit ?? FALLBACK_MS_PER_UNIT
    this.#noAlignAfter = opts.noAlignmentAfterMs ?? NO_ALIGNMENT_AFTER_MS
  }

  /** Unidades já alinhadas (diagnóstico/testes; na estimativa, as estimadas até o áudio recebido). */
  get alignedUnits(): number {
    return this.#estimate ? this.#estimatedUnits() : this.#uStart.length
  }

  /** Modo estimativa (sem alinhamento do servidor). */
  get estimating(): boolean {
    return this.#estimate
  }

  get segmentCount(): number {
    return this.#segs.length
  }

  /** Fim (amostra) da fatia i quando já conhecido (testes/diagnóstico). */
  boundary(i: number): number | null {
    return this.#segs[i]?.end ?? null
  }

  /**
   * Início (ms, relativo ao começo da fatia i) de cada unidade de fala (letra/dígito) da sentença
   * i já alinhada — o "ouvido" EXATO do barge-in em palavras (`@shared/heardText`). null = sem
   * alinhamento (modo estimativa) ou o começo da fatia ainda não é conhecido.
   */
  unitStartsMs(i: number): number[] | null {
    const seg = this.#segs[i]
    if (!seg || this.#estimate) return null
    const start = this.#startOf(i)
    if (start == null) return null
    const base = this.#ms(start)
    const prevCut = i ? this.#segs[i - 1].cut : 0
    const out: number[] = []
    for (let j = prevCut; j < seg.cut && j < this.#uStart.length; j++)
      out.push(Math.max(0, this.#uStart[j] - base))
    return out.length ? out : null
  }

  /** Mais uma sentença (na ordem) com `units` unidades de fala; devolve o índice da fatia. */
  addSegment(units: number): number {
    const prev = this.#segs.at(-1)?.cut ?? 0
    const u = Math.max(0, Math.floor(units))
    this.#segs.push({ cut: prev + u, units: u, end: null, pos: null, dropped: false, emitted: 0 })
    this.#update()
    return this.#segs.length - 1
  }

  setTailOpen(open: boolean): void {
    if (this.#tailOpen === open) return
    this.#tailOpen = open
    this.#update()
  }

  pushPcm(pcm: Uint8Array): void {
    if (this.#final || this.#error || this.#aborted || pcm.length < 2) return
    const n = pcm.length >> 1
    this.#chunks.push({ at: this.#received, pcm: pcm.subarray(0, n * 2) })
    this.#received += n
    if (!this.#blocks && !this.#estimate && this.#ms(this.#received) >= this.#noAlignAfter)
      this.#estimate = true
    this.#update()
  }

  pushAlignment(a: ElevenLabsAlignment): void {
    if (this.#final || this.#error || this.#aborted || this.#estimate) return
    let blockEnd = 0
    for (let i = 0; i < a.chars.length; i++) {
      const st = a.charStartTimesMs[i]
      const end = st + a.charDurationsMs[i]
      blockEnd = Math.max(blockEnd, end)
      if (UNIT.test(a.chars[i])) {
        this.#uStart.push(this.#cursorMs + st)
        this.#uEnd.push(this.#cursorMs + end)
      }
    }
    this.#cursorMs += blockEnd
    this.#blocks++
    this.#update()
  }

  /** O contexto terminou (`isFinal`): o áudio que sobrou vai para as fatias restantes. */
  finish(): void {
    if (this.#final || this.#error || this.#aborted) return
    this.#final = true
    this.#update()
  }

  fail(e: unknown): void {
    if (this.#final || this.#error || this.#aborted) return
    this.#error = e
    this.#wake()
  }

  /** Descarta tudo (barge-in): os consumidores recebem AbortError. */
  abort(): void {
    if (this.#aborted) return
    this.#aborted = true
    this.#chunks = []
    this.#wake()
  }

  /** O consumidor da fatia i desistiu (sentença descartada pela chamada): nada muda nas outras. */
  drop(i: number): void {
    const s = this.#segs[i]
    if (s) s.dropped = true
  }

  /** PCM16 da fatia i, ao vivo (consumidor único). */
  async *stream(i: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const seg = this.#segs[i]
    if (!seg) throw new Error(`fatia ${i} inexistente`)
    let wake: (() => void) | null = null
    const onAbort = (): void => wake?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        if (signal?.aborted || this.#aborted || seg.dropped) throw abortError()
        if (this.#error) throw this.#error
        const start = this.#startOf(i)
        if (start != null) {
          seg.pos ??= start
          // nunca além do que chegou (a fronteira pode estar à frente do áudio recebido)
          const limit = Math.min(seg.end ?? this.#safe(i, start), this.#received)
          if (limit > seg.pos) {
            const bytes = this.#slice(seg.pos, limit)
            seg.pos = limit
            if (bytes.length) {
              seg.emitted += bytes.length >> 1
              yield bytes
              continue
            }
          }
          if (seg.end != null && seg.pos >= seg.end) {
            if (!seg.emitted) {
              // fatia vazia (sentença sem letras, alinhamento degenerado): um respiro de silêncio
              // — a utterance existe e termina normalmente (nunca "frase sem áudio")
              yield new Uint8Array(Math.round((this.sampleRate * EMPTY_SEGMENT_MS) / 1000) * 2)
            }
            return
          }
        }
        await new Promise<void>((r) => {
          wake = r
          this.#waiters.add(r)
        })
        wake = null
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (seg.end == null || (seg.pos ?? 0) < seg.end) seg.dropped = true
    }
  }

  // ---------------- interno ----------------

  #ms(samples: number): number {
    return (samples * 1000) / this.sampleRate
  }

  #samples(ms: number): number {
    return Math.max(0, Math.round((ms * this.sampleRate) / 1000))
  }

  #estimatedUnits(): number {
    return Math.floor(this.#ms(this.#received) / this.#msPerUnit)
  }

  #unitsAligned(): number {
    return this.#estimate ? this.#estimatedUnits() : this.#uStart.length
  }

  #unitStart(i: number): number {
    return this.#estimate ? i * this.#msPerUnit : this.#uStart[i]
  }

  #unitEnd(i: number): number {
    return this.#estimate ? (i + 1) * this.#msPerUnit : this.#uEnd[i]
  }

  #startOf(i: number): number | null {
    return i === 0 ? 0 : (this.#segs[i - 1].end ?? null)
  }

  /** Até onde a fatia i (ainda sem fim conhecido) pode soltar áudio. */
  #safe(i: number, start: number): number {
    const seg = this.#segs[i]
    const prevCut = i ? this.#segs[i - 1].cut : 0
    const aligned = this.#unitsAligned()
    let safe = start
    if (i === this.#segs.length - 1 && !this.#tailOpen && !this.#estimate && aligned >= seg.cut)
      // última sentença cortada, toda alinhada, e nada além dela no contexto: todo o áudio que
      // chegou é dela (a pausa final inclusive) — só o FIM espera o próximo corte ou o isFinal
      safe = this.#received
    else if (aligned > prevCut) safe = this.#samples(this.#unitEnd(Math.min(aligned, seg.cut) - 1))
    return Math.max(start, Math.min(safe, this.#received))
  }

  /** Resolve as fronteiras que já dá para saber e acorda os consumidores. */
  #update(): void {
    const aligned = this.#unitsAligned()
    const last = this.#segs.length - 1
    for (let i = 0; i <= last; i++) {
      const seg = this.#segs[i]
      if (seg.end != null) continue
      const start = this.#startOf(i)
      if (start == null) break
      const prevCut = i ? this.#segs[i - 1].cut : 0
      let end: number | null = null
      // na estimativa as unidades "além" da última sentença cortada não existem de verdade
      if (aligned > seg.cut && !(this.#estimate && i === last)) {
        // a 1ª unidade da sentença seguinte já tem tempo: corta no meio da pausa
        const a = seg.cut > 0 ? this.#unitEnd(seg.cut - 1) : this.#unitStart(seg.cut)
        const b = this.#unitStart(seg.cut)
        end = this.#samples((a + b) / 2)
        if (end > this.#received) end = this.#final ? this.#received : end
      } else if (this.#final) {
        if (i === last) end = this.#received
        else if (aligned >= seg.cut && seg.cut > prevCut)
          end = this.#samples(this.#unitEnd(seg.cut - 1))
        else {
          // proporcional às unidades entre as sentenças restantes
          const remainingUnits = this.#segs[last].cut - prevCut
          const share = remainingUnits > 0 ? seg.units / remainingUnits : 1 / (last - i + 1)
          end = start + Math.round((this.#received - start) * share)
        }
      }
      if (end == null) break
      seg.end = Math.max(start, Math.min(end, this.#final ? this.#received : Infinity))
      if (seg.pos != null && seg.pos > seg.end) seg.end = seg.pos // já soltou além: nunca volta
    }
    this.#wake()
  }

  #slice(from: number, to: number): Uint8Array {
    const parts: Uint8Array[] = []
    let size = 0
    for (const c of this.#chunks) {
      const n = c.pcm.length >> 1
      const a = Math.max(from, c.at)
      const b = Math.min(to, c.at + n)
      if (b <= a) continue
      const p = c.pcm.subarray((a - c.at) * 2, (b - c.at) * 2)
      parts.push(p)
      size += p.length
    }
    if (parts.length === 1) return parts[0].slice()
    const out = new Uint8Array(size)
    let off = 0
    for (const p of parts) {
      out.set(p, off)
      off += p.length
    }
    return out
  }

  #wake(): void {
    const ws = [...this.#waiters]
    this.#waiters.clear()
    for (const w of ws) w()
  }
}
