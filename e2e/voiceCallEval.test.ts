// Log de diagnóstico dos preâmbulos (`<userData>/voice-eval/*.jsonl`) e métricas da timeline da
// chamada de voz: schema das linhas de decisão (preâmbulo tocado ou não), escrita tolerante em
// arquivos por dia e as contagens do painel (preâmbulos/frases de demora tocados, motivos).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceCallEval.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import { FILLER_POOL_MAX } from '@shared/voice'
import { computeVoiceCallMetrics } from '@shared/voiceTimeline'
import {
  createEvalLogger,
  evalLogFile,
  normalizeEvalEvent,
  type VoiceEvalEvent
} from '../src/main/voice/evalLog.ts'

const BASE = (): VoiceEvalEvent => ({
  ts: 1_700_000_000_000,
  kind: 'filler',
  variant: 7,
  played: true,
  latencyMs: 40,
  reason: 'delay/question'
})

// ---------------- schema ----------------

test('normalizeEvalEvent: round-trip válido; lixo/campos inválidos viram null', () => {
  assert.deepEqual(normalizeEvalEvent(BASE()), BASE())

  assert.equal(normalizeEvalEvent(null), null)
  assert.equal(normalizeEvalEvent('x'), null)
  assert.equal(
    normalizeEvalEvent({ ...BASE(), variant: FILLER_POOL_MAX + 1 }),
    null,
    'variante fora do pool'
  )
  assert.equal(normalizeEvalEvent({ ...BASE(), variant: 0 }), null, 'variante 1-based')
  // linhas de outros kinds não são aceitas
  assert.equal(normalizeEvalEvent({ ...BASE(), kind: 'x' }), null, 'kind desconhecido')
  assert.equal(normalizeEvalEvent({ ...BASE(), ts: Number.NaN }), null, 'ts inválido')
  // variantes até o teto do pool (16) — antes só 1..3 entravam e os preâmbulos 4+ sumiam do log
  assert.equal(normalizeEvalEvent({ ...BASE(), variant: FILLER_POOL_MAX })?.variant, 16)

  const rough = normalizeEvalEvent({
    ...BASE(),
    ts: 1.6,
    variant: 2.7,
    latencyMs: 7.9,
    played: 1,
    shadow: true, // campo antigo: descartado
    tail: 'fala do usuário', // nada da fala é gravado
    reason: 'r'.repeat(200)
  })
  assert.deepEqual(rough, {
    ts: 2,
    kind: 'filler',
    variant: 3,
    played: false,
    latencyMs: 8,
    reason: 'r'.repeat(64)
  })
})

// ---------------- escrita ----------------

test('createEvalLogger: um JSONL por dia com UMA linha por decisão; inválido não escreve', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clearchat-eval-'))
  try {
    const logger = createEvalLogger(dir)
    const skipped: VoiceEvalEvent = { ...BASE(), variant: 1, played: false, reason: 'delay/spoken' }
    logger.log(skipped)
    logger.log(BASE())
    logger.log({ ...BASE(), variant: 99 }) // inválido: fora
    // as escritas são serializadas numa cadeia: espera o arquivo do dia
    const file = evalLogFile(dir, new Date(BASE().ts))
    assert.equal(file, logger.file(new Date(BASE().ts)))
    let text = ''
    for (let i = 0; i < 100 && text.split('\n').filter(Boolean).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10))
      text = await readFile(file, 'utf8').catch(() => '')
    }
    const lines = text.split('\n').filter(Boolean)
    assert.equal(lines.length, 2, 'uma linha por decisão (a inválida não entra)')
    const parsed = lines.map((l) => normalizeEvalEvent(JSON.parse(l)))
    assert.deepEqual(parsed[0], skipped)
    assert.deepEqual(parsed[1], BASE())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createEvalLogger: falha de escrita nunca propaga (diretório ilegível só chama onError)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clearchat-eval-'))
  try {
    // um ARQUIVO no lugar do diretório raiz faz o mkdir/append falharem
    const { writeFile } = await import('node:fs/promises')
    const bad = join(dir, 'voice-eval')
    await writeFile(bad, 'não sou um diretório')
    const errors: unknown[] = []
    const logger = createEvalLogger(dir, (e) => errors.push(e))
    logger.log(BASE())
    logger.log(BASE())
    for (let i = 0; i < 100 && errors.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(errors.length, 2, 'as duas escritas falharam sem explodir')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------- métricas ----------------

const ev = (
  ts: number,
  kind: VoiceCallTimelineEvent['kind'],
  extra: Partial<VoiceCallTimelineEvent> = {}
): VoiceCallTimelineEvent => ({ ts, kind, ...extra })

test('computeVoiceCallMetrics: preâmbulos e frases de demora tocados; motivos por balde', () => {
  const events: VoiceCallTimelineEvent[] = [
    ev(1_000, 'speech-start'),
    ev(2_000, 'decision', { class: 'FILLER', variant: 2, played: true }),
    ev(2_010, 'clip-start', { id: 'u2' }),
    ev(3_000, 'decision', { class: 'FILLER', played: false, reason: 'short-speech' }),
    ev(3_100, 'decision', { class: 'FILLER', variant: 4, played: false, reason: 'delay/no-clip' }),
    ev(3_200, 'decision', { class: 'KEEPALIVE', played: true, id: 'u5' }),
    ev(3_300, 'decision', { class: 'APOLOGY', played: false, reason: 'not-ready' }),
    ev(3_400, 'decision', { class: 'APOLOGY', played: true, id: 'u6' }),
    // decisões de classes desconhecidas não entram em balde nenhum
    ev(3_500, 'decision', { class: 'ACK', played: false, reason: 'cooldown' }),
    ev(4_000, 'speech-end')
  ]
  const m = computeVoiceCallMetrics(events)
  assert.equal(m.elapsedMs, 3_000, '1000 → 4000')
  assert.equal(m.fillerPlayed, 1)
  assert.deepEqual(m.delayPlayed, { keepAlive: 1, apology: 1 })
  assert.deepEqual(m.skipped, {
    filler: { 'short-speech': 1, 'delay/no-clip': 1 },
    delay: { 'not-ready': 1 }
  })

  // sem eventos: zeros
  const empty = computeVoiceCallMetrics([])
  assert.equal(empty.elapsedMs, 0)
  assert.equal(empty.fillerPlayed, 0)
  assert.deepEqual(empty.skipped, { filler: {}, delay: {} })

  // `now` fecha o tempo da chamada
  const short = computeVoiceCallMetrics(
    [ev(1_000, 'decision', { class: 'FILLER', played: false })],
    2_000
  )
  assert.equal(short.elapsedMs, 1_000)
  assert.deepEqual(short.skipped.filler, { '?': 1 })
})
