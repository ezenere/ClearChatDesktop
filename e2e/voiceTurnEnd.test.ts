// Fim de turno adaptativo, turno continuado e preâmbulos da chamada de voz — políticas
// puras (`@shared/voiceTurn`, `@shared/voicePolicy`, `sentences.ts`, `tools/util.ts`) e os fluxos
// do `VoiceCallManager` com fakes (runner/síntese/clipes falsos; nada de rede).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceTurnEnd.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatConfig } from '@shared/types'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_FILLER_POOL,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_TURN_TIMING,
  DEFAULT_VOICE_CALL_DEFAULTS
} from '@shared/voice'
import {
  AdaptiveTurnGate,
  classifyUtteranceEnd,
  isBackchannelText,
  spokenPrefix,
  turnSilenceFor
} from '@shared/voiceTurn'
import { classifyFillerContext, fillerTooShort, pickFillerPhrase } from '@shared/voicePolicy'
import { splitSentences } from '../src/main/voice/sentences.ts'
import { caseInsensitiveMatch } from '../src/main/tools/util.ts'
import {
  VoiceCallManager,
  type VoiceCallAmend,
  type VoiceCallUtterance
} from '../src/main/voice/call.ts'
import {
  UtteranceQueue,
  type UtterancePlayer
} from '../src/renderer/src/lib/voice/utteranceQueue.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 2000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(5)
  }
}

// ---------------- classifyUtteranceEnd ----------------

test('classifyUtteranceEnd: pergunta/comando/fecho = completa; conectivo/vírgula = inacabada; ponto = afirmação', () => {
  const table: [string, string][] = [
    ['Qual é a diferença entre um processo e uma thread?', 'complete'],
    ['O que você acha disso?', 'complete'],
    ['Lista os arquivos da pasta SRC.', 'complete'],
    ['Pode abrir o arquivo de configuração.', 'complete'],
    ['Obrigado.', 'complete'],
    ['É isso.', 'complete'],
    ['Qual o melhor caminho', 'complete'], // interrogativa sem "?" do STT
    ['Ontem eu fui no mercado perto de casa.', 'statement'],
    ['Ontem, eu fui no mercado. E aí, eu encontrei um amigo antigo da faculdade.', 'statement'],
    ['Quando eu cheguei lá.', 'statement'], // "quando" abre narrativa: não é pergunta
    ['Ontem eu fui no mercado perto de casa,', 'unfinished'],
    ['e aí eu encontrei um amigo e', 'unfinished'],
    ['Eu queria saber porque', 'unfinished'],
    ['Deixa eu pensar...', 'unfinished'],
    ['O problema é que', 'unfinished'],
    ['Então tipo', 'unfinished'],
    ['Fui para a casa da', 'unfinished'],
    ['', 'unknown'],
    ['   ', 'unknown']
  ]
  for (const [text, want] of table) assert.equal(classifyUtteranceEnd(text), want, text)
})

test('turnSilenceFor: completa 600 / afirmação 1200 / inacabada 1500 / sem especulação 1000', () => {
  assert.equal(turnSilenceFor('complete', DEFAULT_TURN_TIMING), 600)
  assert.equal(turnSilenceFor('statement', DEFAULT_TURN_TIMING), 1200)
  assert.equal(turnSilenceFor('unfinished', DEFAULT_TURN_TIMING), 1500)
  assert.equal(turnSilenceFor('unknown', DEFAULT_TURN_TIMING), 1000)
})

// ---------------- AdaptiveTurnGate ----------------

/** Alimenta `ms` de quadros (33 ms) com o rms dado; devolve os eventos não nulos. */
function feed(g: AdaptiveTurnGate, rms: number, ms: number): string[] {
  const out: string[] = []
  for (let t = 0; t < ms; t += 33) {
    const e = g.push(rms, 33)
    if (e) out.push(e)
  }
  return out
}

test('AdaptiveTurnGate: especula aos ~250 ms; pergunta fecha aos ~600 ms; sem veredito segura o teto', () => {
  const g = new AdaptiveTurnGate(DEFAULT_TURN_TIMING, 0.01)
  assert.deepEqual(feed(g, 0.2, 500), ['start'])
  assert.deepEqual(feed(g, 0, 264), ['speculate'])
  assert.equal(g.speculating, true)
  assert.equal(g.requiredMs, 1500, 'pendente: o teto (nunca fecha antes do veredito)')
  assert.equal(g.setVerdict(g.specSeq, 'complete'), null, 'ainda não cumpriu 600 ms')
  const ev = feed(g, 0, 400)
  assert.deepEqual(ev, ['end'])
})

test('AdaptiveTurnGate: veredito tardio já cumprido fecha na hora; fala de volta invalida (resume)', () => {
  const g = new AdaptiveTurnGate(DEFAULT_TURN_TIMING, 0.01)
  feed(g, 0.2, 300)
  feed(g, 0, 264)
  const seq = g.specSeq
  feed(g, 0, 500) // a especulação demorou: ~760 ms de pausa
  assert.equal(g.setVerdict(seq, 'complete'), 'end')
  // pausa inacabada (história): o usuário retoma antes de 1500 ms → resume, sem 'end'
  const h = new AdaptiveTurnGate(DEFAULT_TURN_TIMING, 0.01)
  feed(h, 0.2, 300)
  feed(h, 0, 264)
  h.setVerdict(h.specSeq, 'unfinished')
  assert.deepEqual(feed(h, 0, 600), [])
  assert.deepEqual(feed(h, 0.2, 66), ['resume'])
  assert.equal(h.verdict, null)
  // veredito velho (geração anterior) é ignorado
  assert.equal(h.setVerdict(seq, 'complete'), null)
})

test('AdaptiveTurnGate: história com pausa de 900 ms (afirmação) fica UM turno; sem adaptativo = silêncio fixo', () => {
  const g = new AdaptiveTurnGate(DEFAULT_TURN_TIMING, 0.01)
  feed(g, 0.2, 2000)
  feed(g, 0, 264)
  g.setVerdict(g.specSeq, 'statement')
  assert.deepEqual(feed(g, 0, 640), [], '900 ms < 1200 ms: o turno não fecha')
  assert.deepEqual(feed(g, 0.2, 33), ['resume'])
  const fixed = new AdaptiveTurnGate({ ...DEFAULT_TURN_TIMING, adaptive: false }, 0.01)
  feed(fixed, 0.2, 300)
  const ev = feed(fixed, 0, 1100)
  assert.deepEqual(ev, ['end'], 'sem especulação: fecha no fallback (1000 ms)')
})

// ---------------- helpers puros ----------------

test('spokenPrefix: prefixo original que cobre as frases faladas; nada falado → vazio', () => {
  const c = 'Primeira frase.\nSegunda, com vírgula. Terceira!'
  assert.equal(spokenPrefix(c, []), '')
  assert.equal(spokenPrefix(c, ['Primeira frase.']), 'Primeira frase.')
  assert.equal(spokenPrefix(c, ['Primeira frase.', 'Segunda,']), 'Primeira frase.\nSegunda,')
  assert.equal(spokenPrefix(c, ['outra coisa']), 'outra coisa', 'fora do texto: as faladas')
})

test('isBackchannelText: "uhum"/"tá"/"ok" não são conteúdo novo', () => {
  for (const t of ['Uhum.', 'aham', 'Tá.', 'Ok, ok.', 'Sim.', 'tá bom'])
    assert.ok(isBackchannelText(t), t)
  for (const t of ['', 'não, espera', 'Tá, mas e o resto?', 'sim, pode apagar o arquivo'])
    assert.ok(!isBackchannelText(t), t)
})

test('splitSentences: o 1º pedaço corta na vírgula depois de ≥ 25 chars (TTS começa antes)', () => {
  const t = 'Um processo é um programa em execução, enquanto uma thread é um fluxo. Fim.'
  assert.deepEqual(splitSentences(t, { commaCutMin: 25, final: true }).sentences, [
    'Um processo é um programa em execução,',
    'enquanto uma thread é um fluxo.',
    'Fim.'
  ])
  // vírgula cedo demais (< 25) ou decimal não cortam; sem a opção, nada muda
  assert.deepEqual(splitSentences('Sim, claro. Ok.', { commaCutMin: 25, final: true }).sentences, [
    'Sim, claro.',
    'Ok.'
  ])
  assert.deepEqual(
    splitSentences('O valor de pi é 3,14 e mais um pouco até aqui. Fim.', {
      commaCutMin: 10,
      final: true
    }).sentences,
    ['O valor de pi é 3,14 e mais um pouco até aqui.', 'Fim.']
  )
  assert.equal(splitSentences(t, { final: true }).sentences.length, 2)
})

test('caseInsensitiveMatch: "SRC/Main.ts" acha "src/main.ts" dentro do root; ambíguo/fora → null', () => {
  const root = mkdtempSync(join(tmpdir(), 'clearchat-ci-'))
  try {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'main.ts'), 'x')
    // macOS (APFS) e Windows não diferenciam caixa: "SRC" já existe → nada a ajustar.
    if (existsSync(join(root, 'SRC'))) {
      return (async () => {
        assert.equal(await caseInsensitiveMatch(root, join(root, 'SRC', 'Main.ts')), null)
        assert.equal(await caseInsensitiveMatch(root, join(root, 'nada')), null)
      })().finally(() => rmSync(root, { recursive: true, force: true }))
    }
    return (async () => {
      assert.equal(await caseInsensitiveMatch(root, join(root, 'SRC')), join(root, 'src'))
      assert.equal(
        await caseInsensitiveMatch(root, join(root, 'SRC', 'Main.ts')),
        join(root, 'src', 'main.ts')
      )
      assert.equal(
        await caseInsensitiveMatch(root, join(root, 'src')),
        null,
        'existe: nada a ajustar'
      )
      assert.equal(await caseInsensitiveMatch(root, join(root, 'nada')), null)
      assert.equal(await caseInsensitiveMatch(root, join(tmpdir(), 'SRC')), null, 'fora do root')
      mkdirSync(join(root, 'Docs'))
      mkdirSync(join(root, 'docs'))
      assert.equal(await caseInsensitiveMatch(root, join(root, 'DOCS')), null, 'ambíguo')
    })().finally(() => rmSync(root, { recursive: true, force: true }))
  } catch (e) {
    rmSync(root, { recursive: true, force: true })
    throw e
  }
})

// ---------------- preâmbulo: contexto + rotação ----------------

test('classifyFillerContext: pergunta / comando / correção / pedido longo / genérico', () => {
  assert.equal(classifyFillerContext('Qual é a diferença entre processo e thread?'), 'question')
  assert.equal(classifyFillerContext('Lista os arquivos da pasta src.'), 'command')
  assert.equal(classifyFillerContext('Não, espera, eu quis dizer a outra.'), 'correction')
  assert.equal(classifyFillerContext('Peraí, volta um pouco.'), 'correction')
  assert.equal(
    classifyFillerContext(
      'Eu preciso que você analise o projeto inteiro, veja como o sync funciona entre os dois repositórios, compare com o protocolo e me diga o que falta para a próxima versão.'
    ),
    'complex'
  )
  assert.equal(classifyFillerContext('Ontem eu fui no mercado.'), 'generic')
  assert.ok(fillerTooShort('valeu'))
  assert.ok(!fillerTooShort('E isso?'), 'pergunta curta ganha preâmbulo')
})

test('pickFillerPhrase: frase do contexto, nunca uma das últimas 4; pool pequeno usa a mais antiga', () => {
  const pool = DEFAULT_FILLER_POOL
  const q = pickFillerPhrase(pool, 'question', [], () => 0)!
  assert.ok(pool[q].contexts.includes('question'))
  const recent: number[] = []
  for (let i = 0; i < 12; i++) {
    const k = pickFillerPhrase(pool, 'question', recent, () => 0.99)!
    assert.ok(!recent.slice(-4).includes(k), `${k} em ${recent}`)
    recent.push(k)
  }
  // correção: só as frases de correção
  const c = pickFillerPhrase(pool, 'correction', [], () => 0.5)!
  assert.ok(pool[c].contexts.includes('correction'), pool[c].text)
  // pool de 2: com as duas recentes, devolve a usada há mais tempo
  const tiny = [
    { text: 'A.', contexts: [] },
    { text: 'B.', contexts: [] }
  ]
  assert.equal(
    pickFillerPhrase(tiny, 'generic', [0, 1], () => 0),
    0
  )
  assert.equal(
    pickFillerPhrase([], 'generic', [], () => 0),
    null
  )
})

// ---------------- fila: volume e fade ----------------

test('UtteranceQueue: volume da chamada e corte com fade (sem corte seco)', async () => {
  const vols: number[] = []
  const log: string[] = []
  let player: UtterancePlayer | null = null
  const q = new UtteranceQueue({
    playerFactory: () => {
      const p: UtterancePlayer = {
        play: () => void log.push('play'),
        pause: () => void log.push('pause'),
        onended: null,
        onerror: null,
        get volume() {
          return vols[vols.length - 1] ?? 1
        },
        set volume(v: number) {
          vols.push(v)
        }
      }
      player = p
      return p
    }
  })
  q.setVolume(0.5)
  q.enqueue({
    id: 'i1',
    audio: new Uint8Array([1]),
    mime: 'audio/wav',
    kind: 'filler'
  })
  assert.equal(vols[0], 0.5, 'volume da chamada')
  assert.ok(player)
  q.drop('i1', 40)
  assert.deepEqual(log, ['play'], 'ainda em fade')
  await sleep(80)
  assert.deepEqual(log, ['play', 'pause'])
  assert.ok(vols.at(-1) === 0, 'rampa até 0')
  assert.ok(vols.length > 2, 'em passos')
})

// ---------------- manager: turno continuado / barge-in com fakes ----------------

interface H {
  m: VoiceCallManager
  sent: string[]
  emitted: VoiceCallUtterance[]
  cancelled: string[]
  amends: VoiceCallAmend[]
  timeline: { kind: string; reason?: string | null }[]
  emit(e: AgentEvent): void
  synthGate: { open: boolean }
}

function harness(): H {
  const listeners: ((e: AgentEvent) => void)[] = []
  const h: Omit<H, 'm'> = {
    sent: [],
    emitted: [],
    cancelled: [],
    amends: [],
    timeline: [],
    emit: (e) => listeners.forEach((l) => l(e)),
    synthGate: { open: true }
  }
  const m = new VoiceCallManager({
    sendTurn: (_s, text) => h.sent.push(text),
    synth: async (text, signal) => {
      await waitFor(() => h.synthGate.open || signal.aborted, 5000, 'synth gate')
      if (signal.aborted) throw new Error('AbortError')
      return { audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }
    },
    emitState: () => {},
    emitUtterance: (u) => h.emitted.push(u),
    emitUtteranceCancel: (id) => h.cancelled.push(id),
    emitTimeline: (e) => h.timeline.push({ kind: e.kind, reason: e.reason }),
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults: DEFAULT_VOICE_CALL_DEFAULTS,
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    amendTurn: async (_sid, a) => {
      h.amends.push({ ...a, spoken: typeof a.spoken === 'function' ? a.spoken() : a.spoken })
      // o runner para o turno: a sessão fica ociosa
      h.emit(idle())
    },
    fillerDelayMs: 10_000
  })
  m.start('s1')
  return { ...h, m } as H
}
let seq = 0
const userMsg = (text: string): AgentEvent =>
  ({
    type: 'message-added',
    message: {
      id: `m${++seq}`,
      sessionId: 's1',
      message: { role: 'user', content: text },
      meta: {}
    }
  }) as unknown as AgentEvent
const assistantMsg = (id: string, text: string): AgentEvent =>
  ({
    type: 'message-added',
    message: { id, sessionId: 's1', message: { role: 'assistant', content: text }, meta: {} }
  }) as unknown as AgentEvent
const busy = (): AgentEvent =>
  ({ type: 'session-updated', session: { id: 's1', status: 'running' } }) as unknown as AgentEvent
const idle = (): AgentEvent =>
  ({ type: 'session-updated', session: { id: 's1', status: 'idle' } }) as unknown as AgentEvent

/** Fala → turno enviado; o runner (fake) persiste a mensagem do usuário e fica ocupado. */
function sendTurn(h: H, text: string): string {
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.turn(text)
  const e = userMsg(text)
  h.emit(e)
  h.emit(busy())
  return (e as unknown as { message: { id: string } }).message.id
}

test('turno continuado: falar antes de ouvir retém a resposta, apaga o turno e reenvia unido', async () => {
  const h = harness()
  h.synthGate.open = false // a resposta ainda não ficou pronta para tocar
  const userId = sendTurn(h, 'Ontem eu fui no mercado perto de casa.')
  h.emit(assistantMsg('a1', 'Que legal! Como foi?'))
  // o usuário retoma a história antes de ouvir qualquer coisa
  h.m.speechBegin({ dropped: [] })
  h.synthGate.open = true
  h.m.speechEnd()
  h.m.turn('E aí eu encontrei um amigo antigo. O que você acha?')
  await waitFor(() => h.sent.length === 2, 2000, 'turno refeito')
  assert.equal(
    h.sent[1],
    'Ontem eu fui no mercado perto de casa. E aí eu encontrei um amigo antigo. O que você acha?'
  )
  assert.equal(h.amends.length, 1)
  assert.equal(h.amends[0].userMessageId, userId)
  assert.equal(h.amends[0].dropUser, true, 'sem tools: o turno anterior sai do histórico')
  assert.deepEqual(h.amends[0].spoken, { a1: [] }, 'nada foi falado')
  assert.equal(
    h.emitted.filter((u) => u.kind === 'sentence').length,
    0,
    'a resposta retida nunca tocou'
  )
  assert.ok(h.timeline.some((e) => e.kind === 'turn-continued' && e.reason === 'merged'))
  h.m.stop()
})

test('turno continuado: com tools já executadas o histórico delas fica (fala nova = próximo turno)', async () => {
  const h = harness()
  h.synthGate.open = false
  sendTurn(h, 'Lista os arquivos da pasta src.')
  h.emit({ type: 'tool-running', sessionId: 's1', toolCallId: 't', running: true } as never)
  h.m.speechBegin({ dropped: [] })
  h.m.speechEnd()
  h.m.turn('Não, a pasta docs.')
  await waitFor(() => h.sent.length === 2, 2000, 'próximo turno')
  assert.equal(h.sent[1], 'Não, a pasta docs.')
  assert.equal(h.amends[0].dropUser, false)
  h.m.stop()
})

test('turno continuado: "uhum"/ruído devolvem a resposta retida (nada apagado)', async () => {
  const h = harness()
  h.synthGate.open = false
  sendTurn(h, 'Me explica como funciona o cache de disco.')
  h.emit(assistantMsg('a1', 'O cache guarda arquivos. Isso acelera.'))
  h.m.speechBegin({ dropped: [] })
  h.synthGate.open = true
  h.m.speechEnd()
  h.m.turn('Uhum.')
  await waitFor(() => h.emitted.filter((u) => u.kind === 'sentence').length === 2, 2000, 'liberada')
  assert.equal(h.amends.length, 0)
  assert.equal(h.sent.length, 1)
  h.m.stop()
})

test('barge-in: para o turno e trunca ao que foi falado (frases que começaram a tocar)', async () => {
  const h = harness()
  sendTurn(h, 'Qual é a diferença entre processo e thread?')
  h.emit(assistantMsg('a1', 'Processo é isolado. Thread compartilha memória. Fim.'))
  await waitFor(() => h.emitted.length === 3, 2000, '3 frases emitidas')
  h.m.bargeIn({ playedIds: [h.emitted[0].id] })
  await waitFor(() => h.amends.length === 1, 2000, 'ajuste')
  assert.equal(h.amends[0].dropUser, false)
  assert.deepEqual(h.amends[0].spoken, { a1: ['Processo é isolado.'] })
  h.m.stop()
})

test('speechBegin numa pausa entre frases já ouvidas = barge-in (trunca), não turno continuado', async () => {
  const h = harness()
  sendTurn(h, 'Qual é a diferença entre processo e thread?')
  h.emit({ type: 'draft', sessionId: 's1', draft: { content: 'Processo é isolado. ' } } as never)
  await waitFor(() => h.emitted.length === 1, 2000, '1ª frase')
  h.synthGate.open = false
  h.emit(assistantMsg('a1', 'Processo é isolado. Thread compartilha memória.'))
  h.m.speechBegin({ dropped: [] }) // a 1ª frase já tocou; a 2ª ainda sintetiza
  await waitFor(() => h.amends.length === 1, 2000, 'ajuste')
  assert.deepEqual(h.amends[0].spoken, { a1: ['Processo é isolado.'] })
  h.m.stop()
})
