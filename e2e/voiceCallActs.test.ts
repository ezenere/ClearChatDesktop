// Atos de fala curta da chamada de voz — preâmbulos (fillers) pós-turno e o backchannel × barge-in
// do usuário durante a reprodução (a chamada é meia-duplex: nada toca durante a fala do usuário):
// política pura (`@shared/voicePolicy`) + `VoiceCallManager` sobre um turno MOCKADO (sendTurn fake
// + eventos do runner injetados; síntese/clipes falsos, relógio e PRNG injetáveis).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceCallActs.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatConfig } from '@shared/types'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import {
  BARGE_IN_RANGES,
  DEFAULT_AUDIO_INPUT,
  DEFAULT_BARGE_IN,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_FILLER_POOL,
  DEFAULT_VOICE_CALL_DEFAULTS,
  normalizeVoiceCallTurn,
  resolveBargeIn,
  resolveTurnTiming
} from '@shared/voice'
import {
  DUCK_FADE_MS,
  EMPTY_FILLER_STATE,
  FILLER_DELAY_MS,
  FILLER_MIN_SPEECH_MS,
  PlaybackDuck,
  countRealWords,
  fillerBelowMinSpeech,
  fillerShouldFire,
  isStopCommand,
  type FillerState
} from '@shared/voicePolicy'
import { VoiceCallManager, type VoiceCallUtterance } from '../src/main/voice/call.ts'
import type { VoiceEvalEvent } from '../src/main/voice/evalLog.ts'
import {
  UtteranceQueue,
  type UtterancePlayer
} from '../src/renderer/src/lib/voice/utteranceQueue.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 3000,
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

// ---------------- turno mockado (runner fake) ----------------

interface HarnessOpts {
  /** `fillers.enabled` resolvido (padrão true). */
  fillers?: boolean
  /** PRNG do manager (padrão Math.random). */
  rng?: () => number
  /** Espera do filler em ms (padrão 25 — o limiar de 1,2 s é testado na política pura). */
  fillerDelayMs?: number
  /** Relógio fake (só avança com `advance`) — expiração/cooldown determinísticos. */
  fakeClock?: boolean
  /** Clipes só resolvem quando `openClip()` libera (testa corrida resposta × filler). */
  gateClips?: boolean
  /** Clip dep devolve null (clipes não gerados). */
  noClips?: boolean
}

interface Harness {
  m: VoiceCallManager
  /** Turnos enviados pelo `sendTurn` (caminho do composer). */
  sent: string[]
  /** Utterances emitidas ao renderer (sentenças + clipes). */
  emitted: VoiceCallUtterance[]
  /** Ids cancelados pelo `emitUtteranceCancel`. */
  cancelled: string[]
  /** Tentativas de clipe (classe + variante), na ordem. */
  clips: { cls: string; n: number }[]
  /** Eventos da timeline emitidos pelo manager. */
  timeline: VoiceCallTimelineEvent[]
  /** Decisões de preâmbulo registradas no log de diagnóstico (`logEval`). */
  evals: VoiceEvalEvent[]
  emit(e: AgentEvent): void
  advance(ms: number): void
  openClip(): void
}

function harness(opts: HarnessOpts = {}): Harness {
  const listeners: ((e: AgentEvent) => void)[] = []
  const sent: string[] = []
  const emitted: VoiceCallUtterance[] = []
  const cancelled: string[] = []
  const clips: { cls: string; n: number }[] = []
  const timeline: VoiceCallTimelineEvent[] = []
  const evals: VoiceEvalEvent[] = []
  let clock = 1_000_000
  let clipGate: { open: () => void } | null = null
  const defaults = {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    fillers: { ...DEFAULT_VOICE_CALL_DEFAULTS.fillers, enabled: opts.fillers !== false }
  }
  const m = new VoiceCallManager({
    sendTurn: (_sid, text) => sent.push(text),
    synth: async (text) => ({ audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }),
    emitState: () => {},
    emitUtterance: (u) => emitted.push(u),
    emitUtteranceCancel: (id) => cancelled.push(id),
    emitTimeline: (e) => timeline.push({ ...e }),
    logEval: (e) => evals.push({ ...e }),
    clip: async (cls, n) => {
      clips.push({ cls, n })
      if (opts.gateClips) await new Promise<void>((r) => (clipGate = { open: r }))
      if (opts.noClips) return null
      return { audio: new TextEncoder().encode(`CLIP:${cls}_${n}`), mime: 'audio/wav' }
    },
    sessionInfo: () => ({ chatId: 'c1', depth: 0, busy: false }),
    chatConfig: () => ({}) as ChatConfig,
    settings: () => ({
      defaults,
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    now: () => (opts.fakeClock ? clock : Date.now()),
    rng: opts.rng,
    fillerDelayMs: opts.fillerDelayMs ?? 25
  })
  m.start('s1')
  return {
    m,
    sent,
    emitted,
    cancelled,
    clips,
    timeline,
    evals,
    emit: (e) => listeners.forEach((l) => l(e)),
    advance: (ms) => {
      clock += ms
    },
    openClip: () => clipGate?.open()
  }
}

// eventos do runner (só os campos que o manager consome)
const userMsg = (text: string): AgentEvent =>
  ({
    type: 'message-added',
    message: { sessionId: 's1', message: { role: 'user', content: text } }
  }) as unknown as AgentEvent
const assistantMsg = (text: string): AgentEvent =>
  ({
    type: 'message-added',
    message: { sessionId: 's1', message: { role: 'assistant', content: text } }
  }) as unknown as AgentEvent
const draft = (content: string): AgentEvent =>
  ({ type: 'draft', sessionId: 's1', draft: { content } }) as unknown as AgentEvent
const toolRunning = (running: boolean): AgentEvent =>
  ({ type: 'tool-running', sessionId: 's1', toolCallId: 't1', running }) as unknown as AgentEvent
const responseDone = (): AgentEvent =>
  ({ type: 'session-updated', session: { id: 's1', status: 'idle' } }) as unknown as AgentEvent

/** Fala falada → transcrição final vira turno (como o renderer faz). */
function speakTurn(h: Harness, text: string): void {
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.turn(text)
}

// ---------------- política pura: fillers ----------------

test('fillerShouldFire: limiar de FILLER_DELAY_MS (250 ms; 0 = já), tools disparam já, 1 por turno', () => {
  assert.equal(FILLER_DELAY_MS, 250, 'preâmbulo logo depois do turno: ~250 ms')
  const base: FillerState = {
    ...EMPTY_FILLER_STATE,
    turnStartedAt: 1000,
    responseInFlight: true,
    enabled: true
  }
  assert.equal(fillerShouldFire(base, 1000 + FILLER_DELAY_MS - 1), false, 'antes do limiar')
  assert.equal(fillerShouldFire(base, 1000 + FILLER_DELAY_MS), true, 'no limiar')
  assert.equal(fillerShouldFire({ ...base, toolsRunning: true }, 1001), true, 'tools: já')
  assert.equal(
    fillerShouldFire({ ...base, usedThisTurn: true }, 1000 + FILLER_DELAY_MS),
    false,
    'máx. 1 por turno'
  )
  assert.equal(
    fillerShouldFire({ ...base, spokenThisTurn: true }, 1000 + FILLER_DELAY_MS),
    false,
    'nunca depois da 1ª fala do agente'
  )
  assert.equal(fillerShouldFire({ ...base, enabled: false }, 2000), false, 'fillers desligados')
  assert.equal(
    fillerShouldFire({ ...base, responseInFlight: false }, 2000),
    false,
    'sem resposta em voo'
  )
  assert.equal(
    fillerShouldFire({ ...base, turnStartedAt: null }, 2000),
    false,
    'sem turno em andamento'
  )
  assert.equal(fillerShouldFire(base, 1000 + 50, 50), true, 'delayMs configurável')
  // bug antigo: 0 virava 1200 e o filler nunca saía na hora
  assert.equal(fillerShouldFire(base, 1000, 0), true, 'delayMs 0 = já')
  assert.equal(fillerShouldFire(base, 1000, -5), false, 'negativo → o padrão')
})

test('fillerBelowMinSpeech: fala com menos VOZ que FILLER_MIN_SPEECH_MS não ganha preâmbulo', () => {
  assert.equal(FILLER_MIN_SPEECH_MS, 700)
  assert.equal(fillerBelowMinSpeech(500), true)
  assert.equal(fillerBelowMinSpeech(700), false)
  assert.equal(fillerBelowMinSpeech(null), false, 'desconhecido (digitado) não barra')
  assert.equal(fillerBelowMinSpeech(500, 400), false, 'mínimo explícito')
})

// ---------------- fillers no turno mockado ----------------

/** Fala longa o bastante para ganhar preâmbulo (fala curta — "oi", "valeu" — não ganha). */
const LONG = 'me conta como funciona o cache de disco'

test('filler: preâmbulo logo depois do turno; a 1ª sentença NÃO o corta (espera na fila)', async () => {
  const h = harness({ fillerDelayMs: 25 })
  speakTurn(h, LONG)
  h.emit(userMsg(LONG)) // o runner persiste a mensagem do usuário (rearma o filler, como no real)
  assert.deepEqual(h.sent, [LONG])
  await waitFor(() => h.emitted.length > 0, 2000, 'filler emitido')
  assert.equal(h.emitted[0].kind, 'filler')
  assert.equal(
    new TextDecoder().decode(h.emitted[0].audio),
    `CLIP:FILLER_${h.clips[0].n}`,
    'o clipe tocado é o sorteado'
  )

  // a resposta começa → a sentença entra na fila DEPOIS do preâmbulo; nada é cancelado
  h.emit(draft('Primeira frase.'))
  h.emit(assistantMsg('Primeira frase.'))
  await waitFor(() => h.emitted.length > 1, 2000, 'sentença emitida')
  assert.equal(h.emitted[1].kind, 'sentence')
  assert.deepEqual(h.cancelled, [], 'o preâmbulo nunca é cortado pela resposta')

  // máximo 1 por turno (o tempo segue passando e nada mais sai)
  await sleep(80)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 1)
  h.m.stop()
})

test('filler: resposta rápida (1ª sentença antes do limiar) não toca filler', async () => {
  const h = harness({ fillerDelayMs: 40 })
  speakTurn(h, LONG)
  h.emit(draft('Resposta imediata.'))
  h.emit(assistantMsg('Resposta imediata.'))
  await waitFor(() => h.emitted.length > 0, 2000, 'sentença emitida')
  assert.equal(h.emitted[0].kind, 'sentence')
  await sleep(120)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0, 'sem filler')
  assert.equal(h.clips.length, 0, 'nem carregou o clipe')
  h.m.stop()
})

test('filler: fala curta ("valeu") não ganha preâmbulo; delay 0 sai já', async () => {
  const h = harness({ fillerDelayMs: 0 })
  speakTurn(h, 'valeu')
  await sleep(40)
  assert.equal(h.clips.length, 0, 'fala curta: sem preâmbulo')
  h.emit(assistantMsg('De nada.'))
  await waitFor(() => h.emitted.length > 0, 2000, 'resposta')
  h.m.playbackIdle()
  h.emit(responseDone())
  speakTurn(h, LONG)
  await waitFor(() => h.emitted.some((u) => u.kind === 'filler'), 2000, 'delay 0 = já')
  h.m.stop()
})

test('filler: tools em execução disparam o filler já (sem esperar o limiar)', async () => {
  const h = harness({ fillerDelayMs: 5000 })
  speakTurn(h, LONG)
  h.emit(toolRunning(true))
  await waitFor(() => h.emitted.length > 0, 2000, 'filler emitido no tool-running')
  assert.equal(h.emitted[0].kind, 'filler')
  await sleep(60)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 1, 'máx. 1 por turno')
  h.m.stop()
})

test('filler: desligado não toca; ligado toca e a decisão vai para o log de diagnóstico', async () => {
  const off = harness({ fillers: false, fillerDelayMs: 15 })
  speakTurn(off, LONG)
  await sleep(80)
  assert.equal(off.emitted.length, 0)
  assert.equal(off.clips.length, 0, 'desligado não carrega clipe')
  assert.equal(off.evals.length, 0)
  off.m.stop()

  const on = harness({ fillerDelayMs: 15 })
  speakTurn(on, LONG)
  await waitFor(() => on.emitted.length > 0, 2000, 'filler emitido')
  assert.equal(on.emitted[0].kind, 'filler')
  assert.equal(on.evals.length, 1, 'uma linha por decisão')
  assert.equal(on.evals[0].kind, 'filler')
  assert.equal(on.evals[0].played, true)
  assert.equal(on.evals[0].variant, on.clips[0].n, 'variante = a frase do pool tocada')
  assert.ok(!('shadow' in on.evals[0]), 'sem modo sombra')
  on.m.stop()
})

test('filler: frase pelo contexto e sem repetir nenhuma das últimas 4 entre turnos', async () => {
  const h = harness({ fillerDelayMs: 5, rng: () => 0 })
  const used: number[] = []
  const turns = [
    'Qual é a diferença entre um processo e uma thread?',
    'Qual é a capital da Austrália hoje em dia?',
    'Lista os arquivos da pasta src agora.',
    'Não, espera, eu quis dizer a outra pasta.',
    'Quanto custa uma assinatura anual disso?',
    'Quais são as opções de configuração do cache?'
  ]
  for (const t of turns) {
    speakTurn(h, t)
    await waitFor(
      () => h.emitted.filter((u) => u.kind === 'filler').length > used.length,
      2000,
      `filler de "${t}"`
    )
    used.push(h.clips.filter((c) => c.cls === 'FILLER').at(-1)!.n)
    h.emit(assistantMsg('Certo.'))
    await waitFor(() => h.emitted.at(-1)?.kind === 'sentence', 2000, 'resposta')
    h.m.playbackIdle()
    h.emit(responseDone())
  }
  const pool = DEFAULT_FILLER_POOL
  const ctxOf = (n: number): string[] => pool[n - 1].contexts
  // pergunta → frase de pergunta; comando → de comando; correção → de correção
  assert.ok(ctxOf(used[0]).includes('question'), pool[used[0] - 1].text)
  assert.ok(ctxOf(used[2]).includes('command'), pool[used[2] - 1].text)
  assert.ok(ctxOf(used[3]).includes('correction'), pool[used[3] - 1].text)
  // nunca repete nenhuma das 4 anteriores
  for (let i = 1; i < used.length; i++) {
    assert.ok(!used.slice(Math.max(0, i - 4), i).includes(used[i]), `turno ${i}: ${used}`)
  }
  h.m.stop()
})

test('filler: clipe ausente (não gerado) não toca nem erro; stop cancela filler tocando', async () => {
  const none = harness({ noClips: true, fillerDelayMs: 15 })
  speakTurn(none, LONG)
  await sleep(80)
  assert.equal(none.emitted.length, 0)
  assert.equal(none.m.state().error, null, 'clip ausente não é erro')
  none.m.stop()

  // stop no meio do filler: o clipe tocando é cancelado
  const h = harness({ fillerDelayMs: 15 })
  speakTurn(h, LONG)
  await waitFor(() => h.emitted.length > 0, 2000, 'filler emitido')
  h.m.stop()
  assert.deepEqual(h.cancelled, [h.emitted[0].id])
})

test('filler: carga de clipe em voo descartada quando a 1ª sentença chega primeiro', async () => {
  const h = harness({ fillerDelayMs: 15, gateClips: true })
  speakTurn(h, LONG)
  await waitFor(() => h.clips.length > 0, 2000, 'carga do clipe iniciada')
  // resposta chega ANTES do clipe resolver
  h.emit(draft('Cheguei primeiro.'))
  h.emit(assistantMsg('Cheguei primeiro.'))
  await waitFor(() => h.emitted.length > 0, 2000, 'sentença emitida')
  assert.equal(h.emitted[0].kind, 'sentence')
  h.openClip()
  await sleep(50)
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0, 'filler descartado')
  h.m.stop()
})

// ---------------- fila de utterances: drop (cancela só a utterance alvo) ----------------

test('UtteranceQueue.drop: cancela só a utterance alvo (tocando ou na fila)', () => {
  const players: (UtterancePlayer & { id: string })[] = []
  const log: string[] = []
  const factory = (audio: Uint8Array): UtterancePlayer => {
    const id = new TextDecoder().decode(audio)
    const p: UtterancePlayer & { id: string } = {
      id,
      play: () => log.push(`play:${id}`),
      pause: () => log.push(`pause:${id}`),
      onended: null,
      onerror: null,
      volume: 1
    }
    players.push(p)
    return p
  }
  const q = new UtteranceQueue({ playerFactory: factory })
  const u = (id: string): { id: string; audio: Uint8Array; mime: string; kind: 'filler' } => ({
    id,
    audio: new TextEncoder().encode(id),
    mime: 'audio/wav',
    kind: 'filler'
  })
  q.enqueue(u('a'))
  q.enqueue(u('b'))
  q.enqueue(u('c'))
  assert.equal(q.pending, 2)
  q.drop('a') // tocando → pausa e avança
  assert.deepEqual(log, ['play:a', 'pause:a', 'play:b'])
  q.drop('c') // na fila → só descarta
  assert.equal(q.pending, 0)
  players[1].onended!()
  assert.equal(q.state, 'idle')
  q.drop('zzz') // id desconhecido: sem efeito
  assert.equal(q.state, 'idle')
})

// ---------------- fala por cima da resposta: ducking × barge-in (renderer, puros) ----------------

/** Quadros de 50 ms: `voz`/`sil` em ms → RMS acima/abaixo do limiar 0,01. */
function duckFrames(d: PlaybackDuck, ...parts: ['voz' | 'sil', number][]): string[] {
  const out: string[] = []
  for (const [k, ms] of parts)
    for (let i = 0; i < ms / 50; i++) out.push(d.frame(k === 'voz' ? 0.2 : 0.001, 50, 0.01))
  return out
}

test('barge-in com histerese: padrões e normalização dos limiares (voiceCallDefaults.turn)', () => {
  assert.deepEqual(DEFAULT_BARGE_IN, { duckGain: 0.3, voicedMs: 700, words: 3, restoreMs: 450 })
  assert.equal(DUCK_FADE_MS, 80)
  assert.deepEqual(resolveBargeIn(null), DEFAULT_BARGE_IN)
  assert.deepEqual(resolveBargeIn({ duckGain: 'x', bargeInVoicedMs: NaN }), DEFAULT_BARGE_IN)
  assert.deepEqual(
    resolveBargeIn({ duckGain: 2, bargeInVoicedMs: 50, bargeInWords: 99.6, duckRestoreMs: 10 }),
    {
      duckGain: BARGE_IN_RANGES.duckGain.max,
      voicedMs: BARGE_IN_RANGES.voicedMs.min,
      words: BARGE_IN_RANGES.words.max,
      restoreMs: BARGE_IN_RANGES.restoreMs.min
    },
    'fora da faixa → preso no limite'
  )
  assert.equal(resolveBargeIn({ duckGain: 0 }).duckGain, 0, '0 = mudo (válido)')
  // no turno normalizado (aditivo: ausente → padrões) e no TurnTiming que vai ao renderer
  const t = normalizeVoiceCallTurn({ bargeInVoicedMs: 900, duckGain: 0.25 })
  assert.equal(t.bargeInVoicedMs, 900)
  assert.equal(t.duckGain, 0.25)
  assert.equal(t.bargeInWords, 3)
  assert.equal(t.duckRestoreMs, 450)
  assert.deepEqual(resolveTurnTiming(t).bargeIn, {
    duckGain: 0.25,
    voicedMs: 900,
    words: 3,
    restoreMs: 450
  })
  assert.deepEqual(resolveTurnTiming(null).bargeIn, DEFAULT_BARGE_IN)
})

test('PlaybackDuck: tosse/"uhum" curto → volume volta depois do silêncio e o som é descartado', () => {
  const d = new PlaybackDuck(DEFAULT_BARGE_IN)
  d.start(0.2, 50, 0.01)
  assert.equal(d.open, true, 'abaixou (o chamador aplica o duckGain)')
  // 250 ms de voz (contando o start) e silêncio: aos 450 ms de silêncio volta
  const ev = duckFrames(d, ['voz', 200], ['sil', 400])
  assert.ok(
    ev.every((e) => e === 'pending'),
    'nada antes do restore'
  )
  assert.equal(d.frame(0.001, 50, 0.01), 'restore')
  assert.equal(d.open, false)
  assert.equal(d.reason, null, 'não virou barge-in')
  assert.equal(d.voicedMs, 250)
  // pausas curtas no meio da fala NÃO devolvem o volume (o silêncio é contínuo)
  const e = new PlaybackDuck(DEFAULT_BARGE_IN)
  e.start(0.2, 50, 0.01)
  assert.ok(
    duckFrames(e, ['voz', 100], ['sil', 300], ['voz', 100], ['sil', 300]).every(
      (x) => x === 'pending'
    )
  )
  assert.equal(e.open, true)
})

test('PlaybackDuck: o usuário insiste (700 ms de voz no episódio) → barge-in uma vez', () => {
  const d = new PlaybackDuck(DEFAULT_BARGE_IN)
  d.start(0.2, 50, 0.01)
  // voz com pausas curtas: a voz do EPISÓDIO soma (50 + 300 + 350 = 700 ms)
  const ev = duckFrames(d, ['voz', 300], ['sil', 200], ['voz', 350], ['voz', 200])
  assert.equal(ev.filter((x) => x === 'barge-in').length, 1, 'uma única transição')
  assert.equal(d.reason, 'voiced')
  assert.equal(d.open, false, 'o episódio fecha: a fala segue como turno normal')
  assert.equal(d.frame(0.2, 50, 0.01), 'pending', 'fechado não decide mais')
  // limiar configurável
  const fast = new PlaybackDuck({ ...DEFAULT_BARGE_IN, voicedMs: 300 })
  fast.start(0.2, 50, 0.01)
  assert.ok(duckFrames(fast, ['voz', 250]).includes('barge-in'))
})

test('PlaybackDuck: palavras reais na parcial e ordem de parada interrompem já; backchannel não', () => {
  const d = new PlaybackDuck(DEFAULT_BARGE_IN)
  d.start(0.2, 50, 0.01)
  assert.equal(d.transcript('uhum'), 'pending')
  assert.equal(d.transcript('sim, tá'), 'pending', 'backchannel não conta')
  assert.equal(d.transcript('não, mas'), 'pending', '2 palavras < 3')
  assert.equal(d.transcript('não, mas eu queria'), 'barge-in')
  assert.equal(d.reason, 'words')
  // ordem de parada (atalho): mesmo curta
  for (const t of ['para', 'Pare!', 'espera aí', 'chega', 'Peraí.', 'para, para', 'stop']) {
    const s = new PlaybackDuck(DEFAULT_BARGE_IN)
    s.start(0.2, 50, 0.01)
    assert.equal(s.transcript(t), 'barge-in', t)
    assert.equal(s.reason, 'stop-word', t)
  }
  assert.equal(isStopCommand('para casa'), false, 'preposição + conteúdo não é parada')
  assert.equal(isStopCommand('para de falar agora por favor'), false, 'longa demais')
  assert.equal(isStopCommand('espera um pouco'), true)
  assert.equal(countRealWords('uhum, aham, sim'), 0)
  assert.equal(countRealWords('a pasta src'), 3)
  // fechado: texto não decide
  const c = new PlaybackDuck(DEFAULT_BARGE_IN)
  assert.equal(c.transcript('para'), 'pending')
})

test('UtteranceQueue.setDuck: abaixa com rampa e continua tocando; volta ao normal; vale para a próxima', async () => {
  const vols: number[][] = []
  const players: UtterancePlayer[] = []
  const q = new UtteranceQueue({
    playerFactory: () => {
      const i = players.length
      vols.push([])
      const p: UtterancePlayer = {
        play: () => {},
        pause: () => {},
        onended: null,
        onerror: null,
        get volume() {
          return vols[i].at(-1) ?? 1
        },
        set volume(v: number) {
          vols[i].push(v)
        }
      }
      players.push(p)
      return p
    }
  })
  q.setVolume(0.8)
  q.enqueue({ id: 's1', audio: new Uint8Array([1]), mime: 'audio/wav', kind: 'sentence' })
  q.setDuck(0.3, 40)
  await sleep(80)
  assert.ok(Math.abs(players[0].volume - 0.24) < 1e-9, `0,8 × 0,3: ${players[0].volume}`)
  assert.ok(vols[0].length > 3, 'em passos (rampa, sem degrau)')
  assert.equal(q.state, 'playing', 'continua tocando')
  // a próxima já nasce abaixada enquanto o ducking vale
  q.enqueue({ id: 's2', audio: new Uint8Array([2]), mime: 'audio/wav', kind: 'sentence' })
  players[0].onended!()
  assert.ok(Math.abs(players[1].volume - 0.24) < 1e-9)
  q.setDuck(1, 40)
  await sleep(80)
  assert.ok(Math.abs(players[1].volume - 0.8) < 1e-9, 'volume de volta')
  q.setDuck(0.5) // sem rampa = na hora
  assert.ok(Math.abs(players[1].volume - 0.4) < 1e-9)
  assert.equal(q.duck, 0.5)
})

test('barge-in: o motivo (voz/palavras/parada) e a voz do episódio vão à timeline do main', async () => {
  const h = harness({ fillerDelayMs: 10_000 })
  speakTurn(h, LONG)
  h.emit(draft('Uma resposta longa. Com várias frases.'))
  await waitFor(() => h.emitted.some((u) => u.kind === 'sentence'), 2000, 'sentença')
  h.m.bargeIn({ playedIds: [h.emitted[0].id], reason: 'stop-word', speechMs: 320 })
  const e = h.timeline.find((x) => x.kind === 'barge-in')!
  assert.equal(e.reason, 'stop-word')
  assert.equal(e.speechMs, 320)
  // motivo desconhecido não entra
  const g = harness({ fillerDelayMs: 10_000 })
  speakTurn(g, LONG)
  g.m.bargeIn({ reason: 'hack' })
  assert.equal(g.timeline.find((x) => x.kind === 'barge-in')!.reason, undefined)
  h.m.stop()
  g.m.stop()
})

// ---------------- meia-duplex no turno mockado ----------------

test('backchannel: registra na timeline sem cancelar nada nem virar turno', async () => {
  const h = harness()
  h.m.speechBegin()
  h.m.backchannel({ ms: 320 })
  assert.deepEqual(h.emitted, [])
  assert.deepEqual(h.cancelled, [])
  assert.deepEqual(h.sent, [])
  const e = h.timeline.find((x) => x.kind === 'backchannel')
  assert.equal(e?.speechMs, 320)
  assert.equal(h.m.state().phase, 'listening', 'estado do turno intacto')
  h.m.stop()
})

test('integração: nada toca durante a fala do usuário (meia-duplex) + preâmbulo na resposta (a 1ª sentença espera, sem corte)', async () => {
  const h = harness({ rng: () => 0, fillerDelayMs: 25 })
  // usuário falando, com pausas no meio: o assistente não emite nada (sem backchannel)
  h.m.speechBegin()
  await sleep(60)
  assert.deepEqual(h.emitted, [], 'nada durante a fala do usuário')
  assert.equal(h.clips.length, 0, 'nem carrega clipe')
  h.m.speechEnd()
  h.m.turn('então, sobre o relatório do trimestre passado')
  // resposta demora → preâmbulo; resposta começa → a sentença entra na fila depois dele
  await waitFor(() => h.emitted.some((u) => u.kind === 'filler'), 2000, 'filler')
  h.emit(draft('Claro. Segue o resumo.'))
  h.emit(assistantMsg('Claro. Segue o resumo.'))
  await waitFor(() => h.emitted.filter((u) => u.kind === 'sentence').length > 1, 2000, 'sentenças')
  assert.deepEqual(
    h.emitted.map((u) => u.kind),
    ['filler', 'sentence', 'sentence'],
    'ordem: preâmbulo → resposta (2 sentenças)'
  )
  assert.equal(h.cancelled.length, 0, 'o preâmbulo nunca é cortado pela resposta')
  assert.ok(
    h.emitted.every((u) => !('gain' in u)),
    'sem ganho por utterance (tudo no volume da chamada)'
  )
  const kinds = h.timeline.map((e) => e.kind)
  assert.equal(kinds.filter((k) => k === 'decision').length, 1, 'só a decisão do preâmbulo')
  assert.equal(kinds.includes('turn-sent'), true)
  assert.equal(kinds.includes('clip-cancelled'), false)
  assert.equal(kinds.includes('sentence-emitted'), true)
  h.m.stop()
})
