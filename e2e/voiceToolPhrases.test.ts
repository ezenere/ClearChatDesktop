// Frases de ferramenta da chamada de voz (SPEC → "Chamada de voz → Frases de ferramenta"): a 1ª tool
// do turno ganha uma frase curta da categoria dela ("Vou pesquisar isso.") — no máx. 1 por turno;
// pulada quando o assistente já falou antes da tool, com o usuário falando, desligamento armado ou
// outra frase curta tocando; no lugar do preâmbulo que ainda não tocou; ≥ 3 s depois do fim do
// preâmbulo que já tocou; conta como frase curta no espaçamento das frases de demora. Clipe
// pré-gerado `TOOL_<n>` ou, sem ele, síntese AO VIVO (descartada se a tool terminar/a resposta
// começar antes). Política pura (`@shared/voicePolicy`) + config (`@shared/voice`) +
// `VoiceCallManager` com relógio/timers FALSOS, clipes falsos, síntese falsa e reprodução falsa.
// Nada pago, sem microfone.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceToolPhrases.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ChatConfig, MessageMeta, StoredMessage } from '@shared/types'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_DELAY_PHRASES,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TOOL_PHRASE_POOL,
  DEFAULT_TOOL_PHRASES,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  TOOL_PHRASE_CATEGORIES,
  TOOL_PHRASE_POOL_MAX,
  normalizeToolPhrasePool,
  normalizeToolPhrases,
  normalizeVoiceCallConfig,
  normalizeVoiceCallDefaults,
  resolveToolPhrasePool,
  resolveVoiceCallConfig,
  type ToolPhraseCategory,
  type VoiceDelayPhrases,
  type VoiceToolPhrases
} from '@shared/voice'
import {
  DELAY_MIN_GAP_MS,
  TOOL_PHRASE_AFTER_PREAMBLE_MS,
  TOOL_PHRASE_RECENT_WINDOW,
  pickToolPhrase,
  toolPhraseCategory,
  toolPhraseSkipReason
} from '@shared/voicePolicy'
import { computeVoiceCallMetrics } from '@shared/voiceTimeline'
import type { VoiceCallMark } from '@shared/voiceCallMarks'
import { VoiceCallManager, type VoiceCallUtterance } from '../src/main/voice/call.ts'
import { replaceCategoryLines } from '../src/renderer/src/lib/voice/toolPhrases.ts'

// =====================================================================================
// config + política pura
// =====================================================================================

test('config: voiceCallDefaults.toolPhrases = { enabled: true, pool: null }; pool aparado/sem duplicatas/categorias conhecidas, máx. 40', () => {
  assert.deepEqual(DEFAULT_TOOL_PHRASES, { enabled: true, pool: null })
  assert.deepEqual(DEFAULT_VOICE_CALL_DEFAULTS.toolPhrases, DEFAULT_TOOL_PHRASES)
  // registro antigo (sem o campo) → o padrão; lixo → o padrão
  assert.deepEqual(normalizeVoiceCallDefaults({ enabled: true }).toolPhrases, DEFAULT_TOOL_PHRASES)
  assert.deepEqual(normalizeToolPhrases('x'), DEFAULT_TOOL_PHRASES)
  const n = normalizeToolPhrases({
    enabled: false,
    pool: [
      { text: '  Vou   pesquisar.  ', categories: ['web', 'nope', 'web'] },
      { text: 'Vou pesquisar.', categories: ['files'] }, // duplicata
      { text: 'Sem categoria.', categories: ['nope'] }, // nunca seria escolhida
      { text: '', categories: ['web'] },
      { text: 'x'.repeat(200), categories: ['generic'] },
      42
    ]
  })
  assert.equal(n.enabled, false)
  assert.deepEqual(n.pool, [
    { text: 'Vou pesquisar.', categories: ['web'] },
    { text: 'x'.repeat(80), categories: ['generic'] }
  ])
  assert.equal(normalizeToolPhrasePool([]), null, 'vazio = padrão')
  const big = Array.from({ length: 60 }, (_, i) => ({ text: `F${i}.`, categories: ['generic'] }))
  assert.equal(normalizeToolPhrasePool(big)!.length, TOOL_PHRASE_POOL_MAX)
  assert.equal(TOOL_PHRASE_POOL_MAX, 40)
  assert.deepEqual(resolveToolPhrasePool(null), DEFAULT_TOOL_PHRASE_POOL)
  // idempotente pelo normalizador global
  const d = normalizeVoiceCallDefaults({ toolPhrases: n })
  assert.deepEqual(normalizeVoiceCallDefaults(d), d)
})

test('padrões: 3–4 frases pt-BR por categoria, todas as categorias cobertas', () => {
  assert.deepEqual(
    [...TOOL_PHRASE_CATEGORIES],
    ['web', 'files', 'shell', 'memory', 'agents', 'info', 'location', 'generic']
  )
  for (const cat of TOOL_PHRASE_CATEGORIES) {
    const n = DEFAULT_TOOL_PHRASE_POOL.filter((p) => p.categories.includes(cat)).length
    assert.ok(n >= 3 && n <= 4, `${cat}: ${n}`)
  }
  const texts = DEFAULT_TOOL_PHRASE_POOL.map((p) => p.text)
  assert.ok(texts.includes('Vou pesquisar isso.'))
  assert.ok(texts.includes('Deixa eu dar uma olhada nos arquivos.'))
  assert.ok(texts.includes('Vou rodar isso aqui.'))
  assert.equal(new Set(texts).size, texts.length, 'sem duplicatas')
  assert.ok(texts.every((t) => t.length <= 80 && !/\.\.\./.test(t)))
})

test('persona/chat: VoiceCallConfig.toolPhrases boolean | null (★ herda): chat > persona > global', () => {
  const g = (enabled: boolean): typeof DEFAULT_VOICE_CALL_DEFAULTS => ({
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    toolPhrases: { enabled, pool: null }
  })
  assert.equal(resolveVoiceCallConfig(null, g(true)).toolPhrases, true)
  assert.equal(resolveVoiceCallConfig(null, g(false)).toolPhrases, false)
  const persona = normalizeVoiceCallConfig({ toolPhrases: false })
  assert.equal(persona.toolPhrases, false)
  assert.equal(resolveVoiceCallConfig(null, g(true), persona).toolPhrases, false, 'persona vence')
  const chat = normalizeVoiceCallConfig({ toolPhrases: true })
  assert.equal(resolveVoiceCallConfig(chat, g(false), persona).toolPhrases, true, 'chat vence')
  // null/lixo = herdar (o campo não é gravado)
  assert.equal('toolPhrases' in normalizeVoiceCallConfig({ toolPhrases: null }), false)
  assert.equal('toolPhrases' in normalizeVoiceCallConfig({ toolPhrases: 'sim' }), false)
})

test('toolPhraseCategory: web/arquivos/comandos/memória/subagentes/informações/localização/genérica; end_call e ask_user sem frase', () => {
  const cases: [string, ToolPhraseCategory | null][] = [
    ['web_search', 'web'],
    ['browse_url', 'web'],
    ['read_file', 'files'],
    ['list_dir', 'files'],
    ['search_files', 'files'],
    ['find_files', 'files'],
    ['write_file', 'files'],
    ['edit_file', 'files'],
    ['shell', 'shell'],
    ['process_start', 'shell'],
    ['memory_search', 'memory'],
    ['memory_write', 'memory'],
    ['delegate_task', 'agents'],
    ['send_to_chat', 'agents'],
    ['check_subagents', 'agents'],
    ['list_models', 'info'],
    ['get_chat_info', 'info'],
    ['get_location', 'location'],
    ['nearby_places', 'location'],
    ['mcp_qualquer_coisa', 'generic'],
    ['', 'generic'],
    ['end_call', null],
    ['ask_user', null]
  ]
  for (const [name, cat] of cases) assert.equal(toolPhraseCategory(name), cat, name)
})

test('pickToolPhrase: só da categoria, nunca as últimas 3; esgotada → genérica; pool vazio → null', () => {
  const pool = resolveToolPhrasePool(null)
  let seed = 11
  const rng = (): number => (seed = (seed * 9301 + 49297) % 233280) / 233280
  let recent: number[] = []
  for (let i = 0; i < 100; i++) {
    const k = pickToolPhrase(pool, 'web', recent, rng)!
    assert.ok(pool[k].categories.includes('web'), pool[k].text)
    assert.ok(!recent.slice(-TOOL_PHRASE_RECENT_WINDOW).includes(k), 'fora das últimas 3')
    recent = [...recent, k].slice(-TOOL_PHRASE_RECENT_WINDOW)
  }
  // categoria de 3 frases toda nas recentes → genérica fora das recentes
  const shell = pool.map((p, i) => (p.categories.includes('shell') ? i : -1)).filter((i) => i >= 0)
  assert.equal(shell.length, 3)
  const k = pickToolPhrase(pool, 'shell', shell, () => 0)!
  assert.ok(pool[k].categories.includes('generic'))
  // pool só com a categoria (todas recentes) → a usada há mais tempo
  const tiny = [
    { text: 'A.', categories: ['web' as const] },
    { text: 'B.', categories: ['web' as const] }
  ]
  assert.equal(
    pickToolPhrase(tiny, 'web', [0, 1], () => 0),
    0
  )
  assert.equal(
    pickToolPhrase([], 'web', [], () => 0),
    null
  )
})

test('toolPhraseSkipReason: desligada, anunciada, desligamento, usuário falando, frase curta tocando, < 3 s do preâmbulo, outro áudio', () => {
  const base = {
    enabled: true,
    category: 'web' as ToolPhraseCategory | null,
    answerStarted: false,
    hangup: false,
    userSpeaking: false,
    shortPlaying: false,
    preambleEndedAt: null as number | null,
    playbackActive: false,
    now: 10_000
  }
  assert.equal(TOOL_PHRASE_AFTER_PREAMBLE_MS, 3000)
  assert.equal(toolPhraseSkipReason(base), null)
  assert.equal(toolPhraseSkipReason({ ...base, enabled: false }), 'disabled')
  assert.equal(toolPhraseSkipReason({ ...base, category: null }), 'no-phrase')
  assert.equal(toolPhraseSkipReason({ ...base, answerStarted: true }), 'announced')
  assert.equal(toolPhraseSkipReason({ ...base, hangup: true }), 'hangup')
  assert.equal(toolPhraseSkipReason({ ...base, userSpeaking: true }), 'user-speaking')
  assert.equal(toolPhraseSkipReason({ ...base, shortPlaying: true }), 'clip-playing')
  assert.equal(toolPhraseSkipReason({ ...base, preambleEndedAt: 7001 }), 'after-preamble')
  assert.equal(toolPhraseSkipReason({ ...base, preambleEndedAt: 7000 }), null, '3 s exatos: sai')
  assert.equal(toolPhraseSkipReason({ ...base, playbackActive: true }), 'assistant-audio')
})

test('editor por categoria (renderer): troca só as frases da categoria, junta categorias da mesma frase, igual ao padrão → null', () => {
  const pool = resolveToolPhrasePool(null)
  const web = replaceCategoryLines(pool, 'web', ['Vou pesquisar isso.', 'Já procuro.'])!
  assert.deepEqual(
    web.filter((p) => p.categories.includes('web')).map((p) => p.text),
    ['Vou pesquisar isso.', 'Já procuro.']
  )
  // as outras categorias ficam intactas (e na mesma ordem relativa)
  for (const cat of TOOL_PHRASE_CATEGORIES.filter((c) => c !== 'web'))
    assert.deepEqual(
      web.filter((p) => p.categories.includes(cat)).map((p) => p.text),
      pool.filter((p) => p.categories.includes(cat)).map((p) => p.text),
      cat
    )
  // a mesma frase em duas categorias vira uma entrada só
  const both = replaceCategoryLines(pool, 'files', ['Deixa eu ver isso.'])!
  assert.deepEqual(both.find((p) => p.text === 'Deixa eu ver isso.')!.categories, [
    'files',
    'generic'
  ])
  // voltar ao conteúdo padrão → null (= padrão)
  const back = replaceCategoryLines(
    web,
    'web',
    pool.filter((p) => p.categories.includes('web')).map((p) => p.text)
  )
  assert.equal(back, null)
})

// =====================================================================================
// VoiceCallManager com relógio e timers falsos
// =====================================================================================

class FakeTimers {
  now = 1_000_000
  #seq = 0
  #list: { id: number; at: number; fn: () => void }[] = []
  set = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq
    this.#list.push({ id, at: this.now + Math.max(0, ms), fn })
    return id
  }
  clear = (h: unknown): void => {
    this.#list = this.#list.filter((t) => t.id !== h)
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      this.#list.sort((a, b) => a.at - b.at || a.id - b.id)
      const next = this.#list[0]
      if (!next || next.at > target) break
      this.#list.shift()
      this.now = Math.max(this.now, next.at)
      next.fn()
      await flush()
    }
    this.now = target
    await flush()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

interface PhraseCall {
  text: string
  resolve: () => void
}

interface HarnessOpts {
  /** Clipes TOOL disponíveis (padrão: sim). Os FILLER existem sempre. */
  toolClips?: boolean
  /** Síntese ao vivo resolve só com `phrase.resolve()` (padrão: na hora). */
  manualPhrases?: boolean
  fillers?: boolean
  /** Espera do preâmbulo (timer REAL do manager; padrão 0). */
  fillerDelayMs?: number
  delay?: Partial<VoiceDelayPhrases>
  toolPhrases?: Partial<VoiceToolPhrases>
  /** Reprodução falsa: cada utterance toca pelo tempo dado e o `playback-idle` sai na fila vazia. */
  autoPlay?: boolean
}

interface Harness {
  m: VoiceCallManager
  clock: FakeTimers
  emitted: VoiceCallUtterance[]
  emittedAt: Map<string, number>
  cancelled: string[]
  timeline: VoiceCallTimelineEvent[]
  phrases: PhraseCall[]
  markers: { content: string; meta: MessageMeta }[]
  history: StoredMessage[]
  emit(e: AgentEvent): void
  tools(): string[]
}

const dec = (u: VoiceCallUtterance): string => new TextDecoder().decode(u.audio)
/** Duração na reprodução falsa por tipo. */
const DUR: Record<string, number> = { filler: 1000, delay: 1500, tool: 1000, sentence: 2000 }

function harness(opts: HarnessOpts = {}): Harness {
  const listeners: ((e: AgentEvent) => void)[] = []
  const clock = new FakeTimers()
  const h: Harness = {
    m: null as unknown as VoiceCallManager,
    clock,
    emitted: [],
    emittedAt: new Map(),
    cancelled: [],
    timeline: [],
    phrases: [],
    markers: [],
    history: [],
    emit: (e) => listeners.forEach((l) => l(e)),
    tools: () => h.emitted.filter((u) => u.kind === 'tool').map(dec)
  }
  let userSeq = 0
  const defaults = {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    fillers: { ...DEFAULT_VOICE_CALL_DEFAULTS.fillers, enabled: opts.fillers !== false },
    delayPhrases: { ...DEFAULT_DELAY_PHRASES, ...(opts.delay ?? {}) },
    toolPhrases: { ...DEFAULT_TOOL_PHRASES, ...(opts.toolPhrases ?? {}) }
  }
  const queue: VoiceCallUtterance[] = []
  let playing = false
  const playNext = (): void => {
    const u = queue.shift()
    if (!u) {
      playing = false
      h.m.playbackIdle()
      return
    }
    playing = true
    clock.set(playNext, DUR[u.kind ?? 'sentence'])
  }
  h.m = new VoiceCallManager({
    sendTurn: (_sid, text) => {
      const u: StoredMessage = {
        id: `mu${++userSeq}`,
        sessionId: 's1',
        seq: h.history.length + 1,
        message: { role: 'user', content: text },
        createdAt: clock.now
      }
      h.history.push(u)
      h.emit({ type: 'message-added', message: u })
    },
    synth: async (text) => ({ audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }),
    synthPhrase: (text, signal) =>
      new Promise((resolve, reject) => {
        const call: PhraseCall = {
          text,
          resolve: () =>
            resolve({ audio: new TextEncoder().encode(`PHRASE:${text}`), mime: 'audio/wav' })
        }
        h.phrases.push(call)
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        if (!opts.manualPhrases) queueMicrotask(call.resolve)
      }),
    timers: { set: clock.set, clear: clock.clear },
    now: () => clock.now,
    rng: () => 0,
    fillerDelayMs: opts.fillerDelayMs ?? 0,
    emitState: () => {},
    emitUtterance: (u) => {
      h.emitted.push(u)
      h.emittedAt.set(u.id, clock.now)
      if (!opts.autoPlay) return
      queue.push(u)
      if (!playing) playNext()
    },
    emitUtteranceCancel: (id) => void h.cancelled.push(id),
    emitTimeline: (e) => void h.timeline.push({ ...e }),
    logEval: () => {},
    clip: async (cls, n) =>
      cls === 'TOOL' && opts.toolClips === false
        ? null
        : { audio: new TextEncoder().encode(`CLIP:${cls}_${n}`), mime: 'audio/wav' },
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
    amendTurn: async () => {},
    appendMarker: (_sid, content, meta) => void h.markers.push({ content, meta }),
    sessionMessages: () => h.history,
    newCallId: () => 'call-1'
  })
  h.m.start('s1')
  return h
}

const LONG_Q = 'me explica com calma como funciona a fotossíntese nas plantas'
const POOL = resolveToolPhrasePool(null)
const clipText = (u: string): string => {
  const n = Number(/TOOL_(\d+)/.exec(u)?.[1] ?? 0)
  return POOL[n - 1]?.text ?? '?'
}

/** Fala → turno (síncrono: o preâmbulo usa um timer real e ainda não saiu). */
function userTurn(h: Harness, text = LONG_Q): void {
  h.m.speechBegin()
  h.m.speechEnd()
  h.m.turn(text)
}

let callSeq = 0
let msgSeq = 0
/** O assistente chama tools (mensagem com tool_calls, texto opcional antes) e elas começam a rodar. */
function callTools(h: Harness, names: string[], content = ''): string[] {
  const ids = names.map(() => `tc${++callSeq}`)
  const a: StoredMessage = {
    id: `mt${++msgSeq}`,
    sessionId: 's1',
    seq: h.history.length + 1,
    message: {
      role: 'assistant',
      content,
      tool_calls: names.map((name, i) => ({
        id: ids[i],
        type: 'function' as const,
        function: { name, arguments: '{}' }
      }))
    },
    createdAt: h.clock.now
  } as StoredMessage
  h.history.push(a)
  if (content)
    h.emit({ type: 'draft', sessionId: 's1', draft: { content } } as unknown as AgentEvent)
  h.emit({ type: 'message-added', message: a })
  for (const id of ids)
    h.emit({ type: 'tool-running', sessionId: 's1', toolCallId: id, running: true } as AgentEvent)
  return ids
}

const toolDone = (h: Harness, id: string): void =>
  h.emit({ type: 'tool-running', sessionId: 's1', toolCallId: id, running: false } as AgentEvent)

async function answer(h: Harness, text: string, done = true): Promise<void> {
  const a: StoredMessage = {
    id: `ma${++msgSeq}`,
    sessionId: 's1',
    seq: h.history.length + 1,
    message: { role: 'assistant', content: text },
    createdAt: h.clock.now
  }
  h.emit({ type: 'draft', sessionId: 's1', draft: { content: text } } as unknown as AgentEvent)
  h.history.push(a)
  h.emit({ type: 'message-added', message: a })
  if (done) h.emit({ type: 'session-updated', session: { id: 's1', status: 'idle' } } as AgentEvent)
  await flush()
}

const toolDecisions = (h: Harness): VoiceCallTimelineEvent[] =>
  h.timeline.filter((e) => e.kind === 'decision' && e.class === 'TOOL')

/** Espera (tempo real) o preâmbulo sair — timer real de 0 ms. */
async function waitFiller(h: Harness): Promise<void> {
  for (let i = 0; i < 50 && !h.emitted.some((u) => u.kind === 'filler'); i++)
    await new Promise((r) => setTimeout(r, 2))
  assert.ok(
    h.emitted.some((u) => u.kind === 'filler'),
    'preâmbulo tocou'
  )
}

test('1ª tool do turno ganha a frase da categoria (clipe TOOL_<n>); a 2ª tool do MESMO turno não', async () => {
  const h = harness({ fillers: false })
  userTurn(h)
  const [t1] = callTools(h, ['web_search'])
  await flush()
  assert.equal(h.tools().length, 1, 'uma frase de ferramenta')
  const text = clipText(h.tools()[0])
  assert.ok(POOL.find((p) => p.text === text)!.categories.includes('web'), text)
  const d = toolDecisions(h)
  assert.equal(d.length, 1)
  assert.equal(d[0].played, true)
  assert.equal(d[0].reason, 'web')
  assert.equal(d[0].text, text)
  assert.ok(h.timeline.some((e) => e.kind === 'clip-emitted' && e.class === 'TOOL'))
  // a frase terminou; a tool acaba e o modelo chama OUTRA (e duas em paralelo): nada mais
  h.m.playbackIdle()
  toolDone(h, t1)
  callTools(h, ['read_file', 'shell'])
  await flush()
  assert.equal(h.tools().length, 1, 'nunca mais de uma por turno')
  assert.equal(toolDecisions(h).length, 1, 'nem decisão nova')
  // turno seguinte: vale de novo, sem repetir a frase
  await answer(h, 'Achei.')
  h.m.playbackIdle()
  userTurn(h, 'agora procura de novo outra coisa diferente na internet por favor')
  callTools(h, ['browse_url'])
  await flush()
  assert.equal(h.tools().length, 2)
  assert.notEqual(clipText(h.tools()[1]), text, 'sem repetir as últimas')
  h.m.stop()
})

test('end_call/ask_user não contam como "a 1ª tool": a próxima tool do turno ainda ganha a frase', async () => {
  const h = harness({ fillers: false })
  userTurn(h)
  callTools(h, ['ask_user'])
  await flush()
  assert.equal(toolDecisions(h).length, 0)
  callTools(h, ['memory_search'])
  await flush()
  assert.equal(h.tools().length, 1)
  assert.ok(POOL.find((p) => p.text === clipText(h.tools()[0]))!.categories.includes('memory'))
  h.m.stop()
})

test('anunciada: o assistente falou uma frase antes da tool → pulada (motivo na timeline)', async () => {
  const h = harness({ fillers: false })
  userTurn(h)
  callTools(h, ['web_search'], 'Claro, vou procurar isso no Google agora.')
  await flush()
  assert.equal(h.tools().length, 0)
  const d = toolDecisions(h)
  assert.equal(d.length, 1)
  assert.equal(d[0].played, false)
  assert.equal(d[0].reason, 'web/announced')
  const metrics = computeVoiceCallMetrics(h.timeline)
  assert.deepEqual(metrics.skipped.tool, { 'web/announced': 1 })
  assert.equal(metrics.toolPlayed, 0)
  h.m.stop()
})

test('desligada (global ou persona/chat ★): nada toca; o preâmbulo segue normal', async () => {
  const h = harness({ toolPhrases: { enabled: false } })
  userTurn(h)
  callTools(h, ['web_search'])
  await flush()
  assert.equal(h.tools().length, 0)
  assert.equal(toolDecisions(h)[0].reason, 'web/disabled')
  await waitFiller(h)
  h.m.stop()
})

test('preâmbulo ainda não tocou: a frase de ferramenta fica NO LUGAR dele (nenhum preâmbulo neste turno)', async () => {
  const h = harness({ fillerDelayMs: 400 })
  userTurn(h)
  callTools(h, ['shell'])
  await flush()
  assert.equal(h.tools().length, 1)
  await new Promise((r) => setTimeout(r, 450)) // o timer real do preâmbulo teria disparado
  await flush()
  assert.equal(h.emitted.filter((u) => u.kind === 'filler').length, 0, 'sem preâmbulo')
  const f = h.timeline.filter((e) => e.kind === 'decision' && e.class === 'FILLER')
  assert.deepEqual(
    f.map((e) => e.reason),
    ['tool-phrase']
  )
  h.m.stop()
})

test('preâmbulo já tocou: frase de ferramenta só ≥ 3 s depois do FIM dele (antes → pulada)', async () => {
  // terminou há < 3 s → pulada
  const a = harness()
  userTurn(a)
  await waitFiller(a)
  await a.clock.advance(1000)
  a.m.playbackIdle() // fim do preâmbulo
  await a.clock.advance(TOOL_PHRASE_AFTER_PREAMBLE_MS - 1)
  callTools(a, ['web_search'])
  await flush()
  assert.equal(a.tools().length, 0)
  assert.equal(toolDecisions(a)[0].reason, 'web/after-preamble')
  a.m.stop()
  // terminou há 3 s → toca
  const b = harness()
  userTurn(b)
  await waitFiller(b)
  await b.clock.advance(1000)
  b.m.playbackIdle()
  await b.clock.advance(TOOL_PHRASE_AFTER_PREAMBLE_MS)
  callTools(b, ['web_search'])
  await flush()
  assert.equal(b.tools().length, 1)
  b.m.stop()
  // preâmbulo tocando agora → pulada (frase curta tocando)
  const c = harness()
  userTurn(c)
  await waitFiller(c)
  callTools(c, ['web_search'])
  await flush()
  assert.equal(c.tools().length, 0)
  assert.equal(toolDecisions(c)[0].reason, 'web/clip-playing')
  c.m.stop()
})

test('usuário falando (resposta em voo) → pulada', async () => {
  const h = harness({ fillers: false })
  userTurn(h)
  h.m.speechBegin() // o usuário volta a falar com a resposta em voo
  callTools(h, ['web_search'])
  await flush()
  assert.equal(h.tools().length, 0)
  assert.equal(toolDecisions(h)[0].reason, 'web/user-speaking')
  h.m.stop()
})

test('espaçamento: a frase de ferramenta conta como frase curta — "manter viva" só 10 s depois do FIM dela', async () => {
  const h = harness({ fillers: false, autoPlay: true, delay: { apologyAfterMs: 60_000 } })
  userTurn(h)
  await h.clock.advance(1000)
  callTools(h, ['web_search'])
  await flush()
  assert.equal(h.tools().length, 1)
  await h.clock.advance(DUR.tool) // a frase terminou de tocar (playback-idle)
  const end = h.clock.now
  const delays = (): VoiceCallUtterance[] => h.emitted.filter((u) => u.kind === 'delay')
  // sem a frase, a "manter viva" sairia aos 8 s do envio; agora espera 10 s do fim da frase
  await h.clock.advance(DELAY_MIN_GAP_MS - 1)
  assert.equal(delays().length, 0, 'gap de 10 s desde o fim da frase de ferramenta')
  await h.clock.advance(1)
  assert.equal(delays().length, 1)
  assert.equal(h.emittedAt.get(delays()[0].id), end + DELAY_MIN_GAP_MS)
  h.m.stop()
})

test('espaçamento: "manter viva" tocando quando a 1ª tool começa → frase de ferramenta pulada', async () => {
  const h = harness({ fillers: false, autoPlay: true, delay: { apologyAfterMs: 60_000 } })
  userTurn(h)
  await h.clock.advance(DEFAULT_DELAY_PHRASES.keepAliveAfterMs) // "manter viva" sai aos 8 s
  assert.equal(h.emitted.filter((u) => u.kind === 'delay').length, 1)
  callTools(h, ['read_file'])
  await flush()
  assert.equal(h.tools().length, 0)
  assert.equal(toolDecisions(h)[0].reason, 'files/clip-playing')
  h.m.stop()
})

test('sem clipe TOOL: síntese AO VIVO — toca se a tool ainda roda; caracteres no custo da chamada', async () => {
  const h = harness({ fillers: false, toolClips: false, manualPhrases: true })
  userTurn(h)
  callTools(h, ['web_search'])
  await flush()
  assert.equal(h.phrases.length, 1, 'síntese ao vivo pedida')
  const text = h.phrases[0].text
  assert.ok(POOL.find((p) => p.text === text)!.categories.includes('web'))
  h.phrases[0].resolve()
  await flush()
  assert.deepEqual(h.tools(), [`PHRASE:${text}`])
  assert.equal(toolDecisions(h)[0].reason, 'web/live')
  h.m.playbackIdle()
  await answer(h, 'Pronto.')
  h.m.stop()
  const end = h.markers.find((m) => (m.meta.voiceCall as VoiceCallMark).phase === 'end')!
  const usage = (end.meta.voiceCall as VoiceCallMark).usage!
  assert.equal(usage.tts.chars, text.length + 'Pronto.'.length, 'frase + resposta')
})

test('sem clipe TOOL: síntese ao vivo pronta DEPOIS da resposta começar (ou da tool terminar) → descartada', async () => {
  // a resposta começou antes
  const a = harness({ fillers: false, toolClips: false, manualPhrases: true })
  userTurn(a)
  const [t1] = callTools(a, ['web_search'])
  await flush()
  await answer(a, 'Encontrei três resultados.', false)
  a.phrases[0].resolve()
  await flush()
  assert.equal(a.tools().length, 0)
  const d = toolDecisions(a)
  assert.equal(d.length, 1)
  assert.equal(d[0].played, false)
  assert.equal(d[0].reason, 'web/live/answer-first')
  void t1
  a.m.stop()
  // a tool terminou antes
  const b = harness({ fillers: false, toolClips: false, manualPhrases: true })
  userTurn(b)
  const [t2] = callTools(b, ['shell'])
  await flush()
  toolDone(b, t2)
  b.phrases[0].resolve()
  await flush()
  assert.equal(b.tools().length, 0)
  assert.equal(toolDecisions(b)[0].reason, 'shell/live/tool-done')
  b.m.stop()
})

test('com clipe: tool rápida já terminada ainda toca (latência ~zero; o modelo processa o resultado)', async () => {
  const h = harness({ fillers: false })
  userTurn(h)
  const [t1] = callTools(h, ['read_file'])
  toolDone(h, t1) // terminou antes do clipe carregar
  await flush()
  assert.equal(h.tools().length, 1)
  h.m.stop()
})

test('o usuário fala por cima: a frase de ferramenta tocando é cancelada (fade) e não volta no turno', async () => {
  const h = harness({ fillers: false })
  userTurn(h)
  callTools(h, ['web_search'])
  await flush()
  const id = h.emitted.find((u) => u.kind === 'tool')!.id
  h.m.speechBegin()
  assert.ok(h.cancelled.includes(id))
  assert.ok(h.timeline.some((e) => e.kind === 'clip-cancelled' && e.class === 'TOOL'))
  h.m.stop()
})
