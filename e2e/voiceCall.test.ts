// Chamada de voz (meia-duplex) — unidades puras: resolução do `VoiceCallConfig` com herança
// (persona→chat→global), silêncio que encerra o turno, chat efetivo do turno (`applyVoiceCallChat`),
// corte de sentença do TTS (`splitSentences`), máquina de estados do turno (`VoiceTurnMachine`),
// fila de utterances (`UtteranceQueue`, com player fake) e porta de fala (`UtteranceGate`).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceCall.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TURN_SILENCE_MS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  applyVoiceCallChat,
  normalizeVoiceCallDefaults,
  resolveTurnSilenceMs,
  resolveVoiceCallConfig,
  type VoiceCallConfig
} from '@shared/voice'
import type { Chat, ChatConfig } from '@shared/types'
import { splitSentences, DEFAULT_SENTENCE_MAX_CHARS } from '../src/main/voice/sentences.ts'
import { VoiceTurnMachine } from '../src/main/voice/turnMachine.ts'
import {
  UtteranceQueue,
  type UtterancePlayer
} from '../src/renderer/src/lib/voice/utteranceQueue.ts'
import { UtteranceGate } from '../src/renderer/src/lib/voice/utteranceGate.ts'
import { voiceCallReadiness } from '../src/renderer/src/lib/voice/callReadiness.ts'
import {
  DEFAULT_STT_SETTINGS as STT0,
  DEFAULT_TTS_SETTINGS as TTS0,
  type SttSettings,
  type TtsSettings
} from '@shared/voice'

// ---------------- resolução do VoiceCallConfig (herança persona→chat→global) ----------------

test('resolveVoiceCallConfig: null/ausente herda tudo (enabled/fillers do global; model/tools do chat)', () => {
  const r = resolveVoiceCallConfig(null, DEFAULT_VOICE_CALL_DEFAULTS)
  assert.equal(r.enabled, true)
  assert.equal(r.model, null, 'model null = herda o modelo do chat')
  assert.equal(r.tools, null, 'tools null = as do chat')
  assert.equal(r.voicePrompt, null)
  assert.deepEqual(r.fillers, {
    enabled: DEFAULT_VOICE_CALL_DEFAULTS.fillers.enabled,
    prompt: DEFAULT_VOICE_CALL_DEFAULTS.fillers.prompt
  })
  assert.ok(!('basePrompt' in r), 'sem prompt-base (o app não põe prompt próprio na chamada)')
  assert.equal(r.promptMode, 'append', 'prompt do modo voz complementar por padrão')
  assert.ok(!('interjections' in r), 'sem interjeições (legado)')
})

test('resolveVoiceCallConfig: enabled null herda o global; false explícito vence (null ≠ false)', () => {
  const off = { ...DEFAULT_VOICE_CALL_DEFAULTS, enabled: false }
  assert.equal(resolveVoiceCallConfig({ ...emptyConfig(), enabled: null }, off).enabled, false)
  assert.equal(resolveVoiceCallConfig({ ...emptyConfig(), enabled: true }, off).enabled, true)
  assert.equal(
    resolveVoiceCallConfig({ ...emptyConfig(), enabled: false }, DEFAULT_VOICE_CALL_DEFAULTS)
      .enabled,
    false
  )
})

test('resolveVoiceCallConfig: fillers presentes são override (parciais completam com os padrões); null herda o global', () => {
  const custom = {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    fillers: { ...DEFAULT_VOICE_CALL_DEFAULTS.fillers, enabled: false, prompt: 'fale curto' }
  }
  const r = resolveVoiceCallConfig(
    { ...emptyConfig(), fillers: { enabled: true, prompt: null } },
    custom
  )
  assert.deepEqual(r.fillers, { enabled: true, prompt: null }, 'override vence o global')
  const r2 = resolveVoiceCallConfig(emptyConfig(), custom)
  assert.equal(r2.fillers.prompt, 'fale curto')
  assert.equal(r2.fillers.enabled, false)
  const r3 = resolveVoiceCallConfig(asConfig({ ...emptyConfig(), fillers: {} }), custom)
  assert.equal(r3.fillers.enabled, true, 'parcial: enabled ausente completa com o padrão (ligado)')
})

test('resolveVoiceCallConfig: model/tools passam pelo normalizador (model sem providerId+model → null)', () => {
  const ok = resolveVoiceCallConfig(
    asConfig({
      ...emptyConfig(),
      model: { providerId: 'p2', model: 'm-voz', params: { temperature: 0.2 } },
      tools: { enabledTools: ['shell'], maxToolOutputChars: 500 }
    }),
    DEFAULT_VOICE_CALL_DEFAULTS
  )
  assert.deepEqual(ok.model, { providerId: 'p2', model: 'm-voz', params: { temperature: 0.2 } })
  assert.deepEqual(ok.tools, { enabledTools: ['shell'], maxToolOutputChars: 500 })
  const broken = resolveVoiceCallConfig(
    asConfig({ ...emptyConfig(), model: { providerId: '', model: 'm', params: {} } }),
    DEFAULT_VOICE_CALL_DEFAULTS
  )
  assert.equal(broken.model, null, 'model incompleto não vale (herda o do chat)')
})

// ---------------- silêncio que encerra o turno ----------------

test('resolveTurnSilenceMs: explícito vale; null = padrão próprio da chamada (não herda o ditado)', () => {
  assert.equal(DEFAULT_TURN_SILENCE_MS, 1000, 'padrão de turno de conversa (~1 s)')
  assert.equal(
    resolveTurnSilenceMs(
      { silenceStopMs: 1500 },
      { silenceStopEnabled: true, silenceStopMs: 5000 }
    ),
    1500
  )
  assert.equal(
    resolveTurnSilenceMs(
      { silenceStopMs: null },
      { silenceStopEnabled: true, silenceStopMs: 5000 }
    ),
    DEFAULT_TURN_SILENCE_MS,
    'o auto-stop de 5 s do ditado NÃO vira o turno da chamada'
  )
  assert.equal(
    resolveTurnSilenceMs(
      { silenceStopMs: null },
      { silenceStopEnabled: false, silenceStopMs: 5000 }
    ),
    DEFAULT_TURN_SILENCE_MS,
    'auto-stop desligado → padrão (na chamada SEMPRE há limite)'
  )
  assert.equal(resolveTurnSilenceMs({ silenceStopMs: 0 }), DEFAULT_TURN_SILENCE_MS)
  assert.equal(resolveTurnSilenceMs(null), DEFAULT_TURN_SILENCE_MS)
})

test('normalizeVoiceCallDefaults: turn.silenceStopMs é preservado (> 0) e 0/lixeira vira null', () => {
  assert.equal(
    normalizeVoiceCallDefaults({ turn: { silenceStopMs: 3000 } }).turn.silenceStopMs,
    3000
  )
  assert.equal(
    normalizeVoiceCallDefaults({ turn: { silenceStopMs: 0 } }).turn.silenceStopMs,
    null,
    '0 = sem limite não faz sentido no turno → segue audioInput'
  )
  assert.equal(normalizeVoiceCallDefaults({ turn: { silenceStopMs: -5 } }).turn.silenceStopMs, null)
  assert.equal(normalizeVoiceCallDefaults(null).turn.silenceStopMs, null)
  assert.equal(normalizeVoiceCallDefaults({ turn: {} }).turn.silenceStopMs, null)
})

// ---------------- chat efetivo do turno (overrides de request) ----------------

const chatWith = (patch: Partial<ChatConfig>): Chat =>
  ({
    id: 'c1',
    title: 't',
    config: {
      providerId: 'p1',
      model: 'm-base',
      systemPrompt: 'persona',
      params: { temperature: 0.7 },
      enabledTools: ['shell', 'read_file'],
      maxToolOutputChars: 30000,
      ...patch
    } as ChatConfig
  }) as Chat

test('applyVoiceCallChat: voicePrompt/params/tools aplicados na CÓPIA; sem override nada muda', () => {
  const base = chatWith({})
  const r = resolveVoiceCallConfig(
    {
      ...emptyConfig(),
      voicePrompt: 'fale em frases curtas',
      model: { providerId: 'p2', model: 'm-voz', params: { temperature: 0.1 } },
      tools: { enabledTools: [], maxToolOutputChars: 1000 }
    },
    DEFAULT_VOICE_CALL_DEFAULTS
  )
  const eff = applyVoiceCallChat(base, r)
  assert.equal(
    eff.config.systemPrompt,
    'persona\n\nfale em frases curtas',
    'system prompt + o prompt do modo voz (nada do app)'
  )
  assert.deepEqual(
    eff.config.params,
    { temperature: 0.1 },
    'params do modelo da chamada substituem (a chamada não impõe teto de tokens)'
  )
  assert.deepEqual(eff.config.enabledTools, [], 'lista vazia = nenhuma tool na chamada')
  assert.equal(eff.config.maxToolOutputChars, 1000)
  assert.equal(base.config.systemPrompt, 'persona', 'o chat salvo não é mutado')
  assert.deepEqual(base.config.params, { temperature: 0.7 })

  const plain = applyVoiceCallChat(
    base,
    resolveVoiceCallConfig(emptyConfig(), DEFAULT_VOICE_CALL_DEFAULTS)
  )
  assert.deepEqual(
    plain.config,
    base.config,
    'sem overrides: EXATAMENTE a config do chat — o mesmo system prompt de um turno de texto'
  )
})

// ---------------- corte de sentença (TTS por sentença) ----------------

test('splitSentences: sentenças completas por marcas; resto fica para o próximo delta', () => {
  assert.deepEqual(splitSentences('Frase um. Frase dois. Frase três.', { final: true }), {
    sentences: ['Frase um.', 'Frase dois.', 'Frase três.'],
    rest: ''
  })
  assert.deepEqual(splitSentences('Frase um. Frase'), {
    sentences: ['Frase um.'],
    rest: 'Frase'
  })
  // sem espaço depois da marca (streaming): espera o próximo delta
  assert.deepEqual(splitSentences('Frase um.'), { sentences: [], rest: 'Frase um.' })
  assert.deepEqual(splitSentences('Frase um.', { final: true }), {
    sentences: ['Frase um.'],
    rest: ''
  })
})

test('splitSentences: marcas repetidas, fechos e interrogações/exclamações', () => {
  assert.deepEqual(splitSentences('Tá?? Tá! Ok… Segue.', { final: true }).sentences, [
    'Tá??',
    'Tá!',
    'Ok…',
    'Segue.'
  ])
  assert.deepEqual(splitSentences('Ele disse "tá bom." E saiu.', { final: true }).sentences, [
    'Ele disse "tá bom."',
    'E saiu.'
  ])
})

test('splitSentences: decimais, listas numeradas e abreviações não cortam', () => {
  assert.deepEqual(splitSentences('O pi é 3.14 mais ou menos.', { final: true }).sentences, [
    'O pi é 3.14 mais ou menos.'
  ])
  assert.deepEqual(
    splitSentences('1. Primeiro item. 2. Segundo item.', { final: true }).sentences,
    ['1. Primeiro item.', '2. Segundo item.']
  )
  assert.deepEqual(splitSentences('Veja o Dr. Silva amanhã.', { final: true }).sentences, [
    'Veja o Dr. Silva amanhã.'
  ])
  assert.deepEqual(splitSentences('Ex.: isto. Etc.', { final: true }).sentences, [
    'Ex.: isto.',
    'Etc.'
  ])
})

test('splitSentences: mês/dia abreviado só em contexto de data — "o mar." é palavra e corta', () => {
  const cut = (t: string): string[] => splitSentences(t, { final: true }).sentences
  // palavras comuns que também são abreviações de mês/dia: cortam
  assert.deepEqual(cut('Fomos ao mar. Depois voltamos.'), ['Fomos ao mar.', 'Depois voltamos.'])
  assert.deepEqual(cut('Você precisa ter. Depois conversamos.'), [
    'Você precisa ter.',
    'Depois conversamos.'
  ])
  assert.deepEqual(cut('Comprei um set. Ficou ótimo.'), ['Comprei um set.', 'Ficou ótimo.'])
  assert.deepEqual(cut('Ele saiu, ficou de out. Voltou depois.'), [
    'Ele saiu, ficou de out.',
    'Voltou depois.'
  ])
  assert.deepEqual(cut('Ele tem um dom. Usa bem.'), ['Ele tem um dom.', 'Usa bem.'])
  // contexto de data: não corta
  assert.deepEqual(cut('A reunião é em 15 mar. 2026 às 10h. Até lá.'), [
    'A reunião é em 15 mar. 2026 às 10h.',
    'Até lá.'
  ])
  assert.deepEqual(cut('Vence em mar. de 2026. Ok.'), ['Vence em mar. de 2026.', 'Ok.'])
  assert.deepEqual(cut('Desde 3 de nov. 2025 está assim. Certo.'), [
    'Desde 3 de nov. 2025 está assim.',
    'Certo.'
  ])
  assert.deepEqual(cut('Pago em mar./2026 sem juros. Pronto.'), [
    'Pago em mar./2026 sem juros.',
    'Pronto.'
  ])
  assert.deepEqual(cut('Atendemos de seg. a sex. das 9h às 18h. Ligue.'), [
    'Atendemos de seg. a sex. das 9h às 18h.',
    'Ligue.'
  ])
  assert.deepEqual(cut('Entre set. e out. de 2025 choveu. Fim.'), [
    'Entre set. e out. de 2025 choveu.',
    'Fim.'
  ])
  // streaming: sem o texto seguinte ainda, "mar." espera; com ele, decide
  assert.deepEqual(splitSentences('Fomos ao mar. '), { sentences: [], rest: 'Fomos ao mar. ' })
  assert.deepEqual(splitSentences('Fomos ao mar. Depois'), {
    sentences: ['Fomos ao mar.'],
    rest: 'Depois'
  })
  assert.deepEqual(splitSentences('Vence em 15 mar. '), {
    sentences: [],
    rest: 'Vence em 15 mar. '
  })
  // fim da resposta: corta mesmo sem o seguinte
  assert.deepEqual(cut('Fomos ao mar.'), ['Fomos ao mar.'])
  // as abreviações de sempre continuam
  assert.deepEqual(cut('Veja o Dr. Silva, p.ex. amanhã. Etc.'), [
    'Veja o Dr. Silva, p.ex. amanhã.',
    'Etc.'
  ])
})

test('splitSentences: ordinais (2.º/N.º), reticências e marcas com fecho cortam certo', () => {
  assert.deepEqual(splitSentences('O 2.º andar. N.º 25.', { final: true }).sentences, [
    'O 2.º andar.',
    'N.º 25.'
  ])
  assert.deepEqual(splitSentences('São Paulo, 3.º quarto. Fim.', { final: true }).sentences, [
    'São Paulo, 3.º quarto.',
    'Fim.'
  ])
  assert.deepEqual(
    splitSentences('Fim… Segue. Ele disse "tá bom." E saiu.', { final: true }).sentences,
    ['Fim…', 'Segue.', 'Ele disse "tá bom."', 'E saiu.']
  )
  assert.deepEqual(splitSentences('Frase um... Depois.', { final: true }).sentences, [
    'Frase um...',
    'Depois.'
  ])
  assert.deepEqual(splitSentences('Dr.ª Ana saiu. Segue.', { final: true }).sentences, [
    'Dr.ª Ana saiu.',
    'Segue.'
  ])
})

test('splitSentences: corte forçado por maxChars sem pontuação (latência)', () => {
  const long = 'palavra '.repeat(80).trim() // ~630 chars sem nenhuma marca
  const { sentences, rest } = splitSentences(long)
  assert.equal(sentences.length, 1)
  assert.ok(sentences[0].length <= DEFAULT_SENTENCE_MAX_CHARS)
  assert.ok(rest.length > 0, 'o resto fica para os deltas seguintes')
  // streaming: cada chamada vai serrando o resto
  let buf = long
  let out: string[] = []
  for (let i = 0; i < 10 && buf; i++) {
    const r = splitSentences(buf)
    out = out.concat(r.sentences)
    if (!r.sentences.length) break
    buf = r.rest
  }
  assert.ok(out.join(' ').startsWith('palavra'))
})

// ---------------- máquina de estados do turno ----------------

test('VoiceTurnMachine: fluxo por silêncio — listening → transcribing → thinking → listening', () => {
  const sent: string[] = []
  const m = new VoiceTurnMachine((t) => sent.push(t))
  m.start(false)
  assert.equal(m.phase, 'listening')
  m.speechBegan()
  assert.equal(m.phase, 'listening', 'usuário falando = "Ouvindo…"')
  m.speechEnded()
  assert.equal(m.phase, 'transcribing')
  m.turnArrived('olá, tudo bem?')
  assert.deepEqual(sent, ['olá, tudo bem?'])
  assert.equal(m.phase, 'thinking')
  m.responseDone()
  assert.equal(m.phase, 'listening')
})

test('VoiceTurnMachine: fala durante a resposta vira o PRÓXIMO turno (máx. 1 pendente, falas acumulam)', () => {
  const sent: string[] = []
  const m = new VoiceTurnMachine((t) => sent.push(t))
  m.start(false)
  m.turnArrived('pergunta')
  m.speechBegan()
  m.speechEnded()
  m.turnArrived('primeira fala') // durante a resposta → pendente
  m.speechBegan()
  m.speechEnded()
  m.turnArrived('segunda fala') // acumula no mesmo pendente
  assert.equal(m.pendingText, 'primeira fala segunda fala')
  assert.deepEqual(sent, ['pergunta'], 'nada sai antes do fim da resposta')
  assert.equal(m.phase, 'thinking')
  m.responseDone()
  assert.deepEqual(sent, ['pergunta', 'primeira fala segunda fala'])
  assert.equal(m.pendingText, '')
  assert.equal(m.phase, 'thinking', 'o turno pendente já disparou a próxima resposta')
  m.responseDone()
  assert.equal(m.phase, 'listening')
})

test('VoiceTurnMachine: transcrição vazia não vira turno; turnArrived ocioso envia já', () => {
  const sent: string[] = []
  const m = new VoiceTurnMachine((t) => sent.push(t))
  m.start(false)
  m.speechBegan()
  m.speechEnded()
  m.turnArrived('   ')
  assert.deepEqual(sent, [])
  assert.equal(m.phase, 'listening')
  m.turnArrived('direto')
  assert.deepEqual(sent, ['direto'])
})

test('VoiceTurnMachine: "Falando…" com utterances; playback-idle devolve ao repouso; barge-in cancela', () => {
  const m = new VoiceTurnMachine(() => {})
  m.start(false)
  m.turnArrived('pergunta')
  m.synthEnqueued()
  m.synthEnqueued()
  assert.equal(m.phase, 'speaking', 'sentenças na síntese já contam como "Falando…"')
  m.utteranceEmitted()
  assert.equal(m.phase, 'speaking')
  m.playbackIdle()
  assert.equal(m.phase, 'speaking', 'ainda há sentença para emitir')
  m.utteranceEmitted()
  m.playbackIdle()
  assert.equal(m.phase, 'thinking', 'áudio acabou mas a resposta continua')
  m.synthEnqueued()
  m.utteranceEmitted()
  assert.equal(m.phase, 'speaking')
  m.bargeIn()
  assert.equal(m.phase, 'listening', 'usuário falou por cima — volta a ouvir')
  m.responseDone()
  assert.equal(m.phase, 'listening')
})

test('VoiceTurnMachine: start com agente ocupado; stop zera tudo', () => {
  const m = new VoiceTurnMachine(() => {})
  m.start(true)
  assert.equal(m.phase, 'thinking')
  m.stop()
  assert.equal(m.active, false)
  assert.equal(m.phase, 'listening')
  m.turnArrived('ignorado')
  assert.equal(m.pendingText, '', 'fora da chamada nada é guardado')
})

test('VoiceTurnMachine: synthCleared zera as sentenças pendentes (falha de TTS não fica "Falando…")', () => {
  const m = new VoiceTurnMachine(() => {})
  m.start(false)
  m.turnArrived('pergunta')
  m.synthEnqueued()
  m.synthEnqueued()
  assert.equal(m.phase, 'speaking')
  m.synthCleared()
  assert.equal(m.phase, 'thinking', 'sentenças descartadas não contam mais como "Falando…"')
  m.synthEnqueued()
  m.utteranceEmitted()
  m.playbackIdle()
  m.responseDone()
  assert.equal(m.phase, 'listening')
})

// ---------------- fila de utterances (reprodução) ----------------

type FakePlayer = UtterancePlayer & { played: boolean; paused: boolean; id: string }

function fakeFactory(log: string[]): (audio: Uint8Array, mime: string) => UtterancePlayer {
  let n = 0
  return (audio, mime) => {
    const id = `p${++n}:${mime}:${audio.length}`
    const p: FakePlayer = {
      id,
      played: false,
      paused: false,
      play() {
        p.played = true
        log.push(`play:${id}`)
      },
      pause() {
        p.paused = true
        log.push(`pause:${id}`)
      },
      onended: null,
      onerror: null,
      volume: 1
    }
    return p
  }
}

const utt = (id: string): Parameters<UtteranceQueue['enqueue']>[0] => ({
  id,
  audio: new Uint8Array([1, 2, 3]),
  mime: 'audio/wav'
})

test('UtteranceQueue: toca na ordem, sem sobreposição; estados idle/playing', () => {
  const log: string[] = []
  const states: string[] = []
  const players: FakePlayer[] = []
  const q = new UtteranceQueue({
    playerFactory: (a, m) => {
      const p = fakeFactory(log)(a, m) as FakePlayer
      players.push(p)
      return p
    },
    onState: (s) => states.push(s)
  })
  q.enqueue(utt('u1'))
  q.enqueue(utt('u2'))
  assert.equal(q.state, 'playing')
  assert.equal(players.length, 1, 'uma utterance por vez')
  assert.equal(players[0].id.startsWith('p1'), true)
  assert.equal(q.pending, 1)
  players[0].onended!()
  assert.equal(players.length, 2, 'a segunda começa só quando a primeira termina')
  assert.equal(players[0].paused, false)
  players[1].onended!()
  assert.equal(q.state, 'idle')
  assert.deepEqual(states, ['playing', 'idle'])
  assert.deepEqual(
    log.map((l) => l.split(':')[0]),
    ['play', 'play']
  )
})

test('UtteranceQueue: cancel (barge-in) pausa o atual e descarta a fila', () => {
  const log: string[] = []
  const players: FakePlayer[] = []
  const q = new UtteranceQueue({
    playerFactory: (a, m) => {
      const p = fakeFactory(log)(a, m) as FakePlayer
      players.push(p)
      return p
    }
  })
  q.enqueue(utt('u1'))
  q.enqueue(utt('u2'))
  q.enqueue(utt('u3'))
  q.cancel()
  assert.equal(players[0].paused, true, 'o atual é pausado')
  assert.equal(q.state, 'idle')
  assert.equal(q.pending, 0)
  assert.equal(players.length, 1, 'a fila foi descartada — nada mais toca')
})

test('UtteranceQueue: volume propaga ao player atual e aos seguintes', () => {
  const players: FakePlayer[] = []
  const q = new UtteranceQueue({
    playerFactory: (a, m) => {
      const p = fakeFactory([])(a, m) as FakePlayer
      players.push(p)
      return p
    }
  })
  q.setVolume(0.4)
  q.enqueue(utt('u1'))
  assert.equal(players[0].volume, 0.4)
  q.setVolume(2) // fora da faixa é aparado
  assert.equal(q.volume, 1)
  players[0].onended!()
  q.enqueue(utt('u2'))
  assert.equal(players[1].volume, 1)
})

test('UtteranceQueue: player que falha pula para a próxima', () => {
  const players: FakePlayer[] = []
  let fail = true
  const q = new UtteranceQueue({
    playerFactory: (a, m) => {
      const p = fakeFactory([])(a, m) as FakePlayer
      players.push(p)
      if (fail) {
        fail = false
        queueMicrotask(() => p.onerror?.())
      }
      return p
    }
  })
  q.enqueue(utt('u1'))
  q.enqueue(utt('u2'))
  return Promise.resolve().then(async () => {
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(players.length, 2, 'a segunda toca apesar da falha da primeira')
  })
})

test('UtteranceQueue: play() interrompido pelo cancel não derruba a utterance seguinte', async () => {
  type Pending = {
    paused: boolean
    disposed: boolean
    onended: (() => void) | null
    onerror: (() => void) | null
    volume: number
    play(): Promise<void>
    pause(): void
    dispose(): void
    fail(): void
  }
  const made: Pending[] = []
  const q = new UtteranceQueue({
    playerFactory: () => {
      let rejectPlay: (() => void) | null = null
      const p: Pending = {
        paused: false,
        disposed: false,
        onended: null,
        onerror: null,
        volume: 1,
        // play() fica pendente até o teste rejeitar (o que acontece com `new Audio` ao pausar)
        play: () =>
          new Promise<void>((_resolve, reject) => {
            rejectPlay = reject
          }),
        pause: () => void (p.paused = true),
        dispose: () => void (p.disposed = true),
        fail: () => rejectPlay?.()
      }
      made.push(p)
      return p
    }
  })
  q.enqueue(utt('u1')) // player 1: play() pendente
  q.cancel() // barge-in: pausa/descarta (o play pendente rejeita depois)
  q.enqueue(utt('u2')) // player 2: tocando
  made[0].fail() // o play() interrompido rejeita agora (done velho)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(made.length, 2)
  assert.equal(made[1].disposed, false, 'o player atual não foi derrubado pelo done velho')
  assert.equal(q.state, 'playing', 'a utterance seguinte segue tocando')
})

// ---------------- porta de fala (fronteiras do turno) ----------------

test('UtteranceGate: fala começa no quadro acima do limiar e termina após o silêncio contínuo', () => {
  const g = new UtteranceGate({ threshold: 0.01, silenceMs: 500 })
  assert.equal(g.push(0.001, 33), null, 'silêncio antes da fala não dispara')
  assert.equal(g.push(0.05, 33), 'start')
  assert.equal(g.speaking, true)
  assert.equal(g.push(0.001, 33), null)
  assert.equal(g.push(0.02, 33), null, 'um quadro audível zera o silêncio')
  assert.equal(g.push(0.001, 33), null)
  assert.equal(g.push(0.001, 400), null, '433 ms ainda não encerram')
  assert.equal(g.push(0.001, 100), 'end', '533 ms contínuos encerram a fala')
  assert.equal(g.speaking, false)
  assert.equal(g.push(0.05, 33), 'start', 'nova fala')
})

test('UtteranceGate: reset descarta a fala em curso sem disparar end', () => {
  const g = new UtteranceGate({ threshold: 0.01, silenceMs: 500 })
  assert.equal(g.push(0.5, 33), 'start')
  g.reset()
  assert.equal(g.speaking, false)
  assert.equal(g.push(0.001, 5000), null, 'sem fala aberta o silêncio não dispara end')
})

function emptyConfig(): VoiceCallConfig {
  return {
    enabled: null,
    model: null,
    tools: null,
    voicePrompt: null,
    fillers: null
  }
}

/** Config "parcial/lixo" para testar a tolerância do normalizador (o resolver aceita unknown). */
function asConfig(v: unknown): VoiceCallConfig {
  return v as VoiceCallConfig
}

// ---------------- pré-checagem da chamada (renderer, pura) ----------------

/** Provedores cadastrados como a pré-checagem os vê (sem chave). */
const PROVS = [
  { id: 'p-groq', baseUrl: 'https://api.groq.com/openai/v1', kind: 'openai' },
  { id: 'p-el', baseUrl: 'https://api.elevenlabs.io', kind: 'elevenlabs' }
]

test('voiceCallReadiness: padrões de fábrica apontam o que falta (provedor de STT, Kokoro)', () => {
  const problems = voiceCallReadiness({ sttSettings: STT0, ttsSettings: TTS0 })
  assert.equal(problems.length, 2)
  assert.match(
    problems[0],
    /Transcrição: escolha um modelo de transcrição em Configurações → Áudio/
  )
  assert.match(
    problems[1],
    /Fala: instale o Kokoro e uma voz em Configurações → Áudio → Modelos locais/
  )
  // nenhum provedor que sirva transcrição cadastrado (ElevenLabs só fala) → aponta Provedores
  const none = voiceCallReadiness({ sttSettings: STT0, ttsSettings: TTS0 }, null, null, [PROVS[1]])
  assert.match(none[0], /cadastre um provedor que sirva transcrição em Configurações → Provedores/)
  // com provedor cadastrado mas não escolhido → só "escolha"
  const pick = voiceCallReadiness({ sttSettings: STT0, ttsSettings: TTS0 }, null, null, PROVS)
  assert.match(pick[0], /Transcrição: escolha um modelo de transcrição em Configurações → Áudio\./)
})

test('voiceCallReadiness: pronta com provedor + Kokoro instalado; casos por modo/backend', () => {
  const stt: SttSettings = { ...STT0, api: { ...STT0.api, providerId: 'p-groq' } }
  const tts: TtsSettings = {
    ...TTS0,
    local: { engine: 'kokoro', voice: 'pf_dora', installed: true }
  }
  assert.deepEqual(voiceCallReadiness({ sttSettings: stt, ttsSettings: tts }), [])
  assert.deepEqual(
    voiceCallReadiness({ sttSettings: stt, ttsSettings: tts }, null, null, PROVS),
    []
  )
  // provedor escolhido apagado de Provedores
  assert.match(
    voiceCallReadiness({ sttSettings: stt, ttsSettings: tts }, null, null, [PROVS[1]])[0],
    /o provedor do modelo escolhido não existe mais/
  )
  // sem modelo
  assert.match(
    voiceCallReadiness({
      sttSettings: { ...stt, api: { ...stt.api, model: ' ' } },
      ttsSettings: tts
    })[0],
    /escolha o modelo de transcrição/
  )
  // modo local sem modelo instalado
  const local: SttSettings = { ...STT0, mode: 'local', local: null }
  assert.match(voiceCallReadiness({ sttSettings: local, ttsSettings: tts })[0], /Modelos locais/)
  // híbrido: basta um dos dois
  const hybridLocal: SttSettings = {
    ...STT0,
    mode: 'hybrid',
    local: { engine: 'whisper.cpp', model: '', installed: true }
  }
  assert.deepEqual(voiceCallReadiness({ sttSettings: hybridLocal, ttsSettings: tts }), [])
  assert.match(
    voiceCallReadiness({ sttSettings: { ...STT0, mode: 'hybrid' }, ttsSettings: tts })[0],
    /híbrido\): escolha um modelo de transcrição[^]*instale um modelo local/
  )
  // Chatterbox ainda não funciona
  const chatterbox: TtsSettings = {
    ...TTS0,
    local: { engine: 'chatterbox', voice: '', installed: true }
  }
  assert.match(voiceCallReadiness({ sttSettings: stt, ttsSettings: chatterbox })[0], /Kokoro/)
  // TTS por API: provedor e modelo
  const ttsApi: TtsSettings = { ...TTS0, backend: 'api' }
  assert.match(
    voiceCallReadiness({ sttSettings: stt, ttsSettings: ttsApi })[0],
    /Fala: escolha um modelo de fala em Configurações → Áudio/
  )
  const ttsApiNoModel: TtsSettings = {
    ...TTS0,
    backend: 'api',
    api: { ...TTS0.api, providerId: 'p-el' }
  }
  assert.match(
    voiceCallReadiness({ sttSettings: stt, ttsSettings: ttsApiNoModel })[0],
    /escolha o modelo de fala/
  )
  assert.deepEqual(
    voiceCallReadiness(
      {
        sttSettings: stt,
        ttsSettings: { ...ttsApiNoModel, api: { ...ttsApiNoModel.api, model: 'eleven_flash_v2_5' } }
      },
      null,
      null,
      PROVS
    ),
    []
  )
})

test('voiceCallReadiness: probe de runtime (espeak-ng ausente / whisper quebrado) bloqueia o motor local', () => {
  const stt: SttSettings = { ...STT0, api: { ...STT0.api, providerId: 'p-groq' } }
  const tts: TtsSettings = {
    ...TTS0,
    local: { engine: 'kokoro', voice: 'pf_dora', installed: true }
  }
  const ok = { available: true, reason: null }
  const runtime = {
    whisper: ok,
    onnxruntime: ok,
    espeak: { available: false, reason: 'espeak-ng não encontrado' },
    sttLocal: ok,
    ttsLocal: { available: false, reason: 'espeak-ng não encontrado' }
  }
  const p = voiceCallReadiness({ sttSettings: stt, ttsSettings: tts }, runtime)
  assert.equal(p.length, 1)
  assert.match(p[0], /Fala: o motor local não está pronto — espeak-ng não encontrado/)
  // STT local instalado mas whisper não carrega: modo local bloqueia, híbrido cai na API
  const broken = {
    ...runtime,
    ttsLocal: ok,
    sttLocal: { available: false, reason: 'whisper falhou' }
  }
  const local: SttSettings = {
    ...stt,
    mode: 'local',
    local: { engine: 'whisper.cpp', model: '', installed: true }
  }
  assert.match(
    voiceCallReadiness({ sttSettings: local, ttsSettings: tts }, broken)[0],
    /whisper falhou/
  )
  assert.deepEqual(
    voiceCallReadiness({ sttSettings: { ...local, mode: 'hybrid' }, ttsSettings: tts }, broken),
    []
  )
  // sem probe (main antigo): só as settings contam
  assert.deepEqual(voiceCallReadiness({ sttSettings: stt, ttsSettings: tts }, null), [])
})
