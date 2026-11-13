/* eslint-disable @typescript-eslint/no-explicit-any */
// Chamada de voz (meia-duplex) — integração com mocks: o turno completo sobre o runner REAL
// (banco SQLite temporário + provedor OpenAI-compatible FALSO em 127.0.0.1), o `VoiceCallManager`
// real (síntese mockada e uttterances capturadas na ordem) e a `UtteranceQueue` real (player fake):
// fala → transcrição mock → envio pelo caminho do composer → stream de resposta mock →
// 2 sentenças → 2 sínteses → ordem correta → barge-in cancela. Também cobre: o histórico de um
// turno de voz é idêntico ao de um turno de texto (só o conteúdo muda) e os overrides do modo voz
// (voice.model/voice.tools/voicePrompt nas requests — o chat salvo não muda).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceCallTurn.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  type VoiceCallState
} from '@shared/voice'
import { COMPACT_TOOLS_PROMPT } from '@shared/compactTools'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-voicecall-'))
process.env.CLEARCHAT_TEST_USERDATA = TMP
process.env.CLEARCHAT_SKIP_SHELL_ENV = '1'
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export class BrowserWindow { static getAllWindows() { return [] } }
export const session = { fromPartition: () => ({}) }
export const dialog = {}
export const ipcMain = { handle() {} }
export const nativeImage = {}
export default { app, BrowserWindow, session, dialog, ipcMain, nativeImage }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

// ---------------- provedor falso ----------------
// A 1ª palavra da última mensagem user decide o texto da resposta; respostas longas saem em
// 2 pedaços (para o TTS por sentença cortar durante o streaming). `raw` guarda URL + corpo.

const MODEL = 'fake/agent'
const MODEL_VOZ = 'fake/voz'
let server: Server
let base = ''
const requests: { url: string; body: any }[] = []
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5 } } : {}) })}\n\n`

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && (req.url ?? '').endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              { id: MODEL, context_length: 64000 },
              { id: MODEL_VOZ, context_length: 64000 }
            ]
          })
        )
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      requests.push({ url: req.url ?? '', body })
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      const key = textOf(lastUser?.content).trim().split(/\s+/)[0] || ''
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // resultado de tool voltou: encerra com o eco do resultado (ciclo de tool fecha aqui)
      if (last?.role === 'tool') {
        res.write(
          chunk(body.model, {
            role: 'assistant',
            content: `FIM: ${textOf(last.content).slice(0, 40)}`
          })
        )
        res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      // 'ferramenta' → o modelo chama read_file (mesmo sem a request ter liberado tools)
      if (key === 'ferramenta') {
        res.write(
          chunk(body.model, {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: 'alvo.txt' }) }
              }
            ]
          })
        )
        res.end(chunk(body.model, {}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      const reply =
        key === 'duas'
          ? 'Primeira frase. Segunda frase.'
          : key === 'longa'
            ? 'Esta é uma frase bem longa sobre gatos e cachorros. Segunda frase.'
            : key === 'ok'
              ? 'Certo.'
              : 'Resposta simples.'
      const mid = Math.ceil(reply.length / 2)
      res.write(chunk(body.model, { role: 'assistant', content: reply.slice(0, mid) }))
      await new Promise((r) => setTimeout(r, 25))
      res.write(chunk(body.model, { content: reply.slice(mid) }))
      res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

// ---------------- módulos reais ----------------

type Mods = {
  runner: typeof import('../src/main/agent/runner.ts')
  repo: typeof import('../src/main/repo.ts')
  events: typeof import('../src/main/events.ts')
  request: typeof import('../src/main/agent/request.ts')
  call: typeof import('../src/main/voice/call.ts')
  machine: typeof import('../src/main/voice/turnMachine.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    runner: await import('../src/main/agent/runner.ts'),
    repo: await import('../src/main/repo.ts'),
    events: await import('../src/main/events.ts'),
    request: await import('../src/main/agent/request.ts'),
    call: await import('../src/main/voice/call.ts'),
    machine: await import('../src/main/voice/turnMachine.ts')
  }
  return mods
}

after(async () => {
  if (mods) {
    for (const sid of mods.runner.runningSessions()) await mods.runner.stop(sid).catch(() => {})
    ;(await import('../src/main/db.ts')).closeDb()
  }
  server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 8000,
  what = ''
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(15)
  }
}

// ---------------- síntese mock + fila real de reprodução ----------------

/** Síntese por sentença: registrada na ordem; em modo 'gated' o teste libera cada uma na mão. */
let synthMode: 'auto' | 'gated' = 'auto'
/** Falha de TTS (a sentença rejeita como o backend fora do ar — ela é pulada, texto segue). */
let failSynth = false
/** Falha de TTS só nas sentenças que contêm este trecho (as demais sintetizam). */
let failSynthOn: string | null = null
/** Quantas vezes a sentença `failSynthOn` ainda falha (Infinity = sempre). */
let failSynthTimes = Infinity
const synthCalls: string[] = []
const gates: { open: () => void }[] = []
const openGate = (i: number): void => gates[i]?.open()
const aborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error('AbortError'))
    signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true })
  })
async function synth(
  text: string,
  signal: AbortSignal
): Promise<{ audio: Uint8Array; mime: string }> {
  synthCalls.push(text)
  if (failSynth) throw new Error('TTS fora do ar')
  if (failSynthOn && text.includes(failSynthOn) && failSynthTimes > 0) {
    failSynthTimes--
    throw new Error('TTS fora do ar')
  }
  if (synthMode === 'gated') {
    await Promise.race([new Promise<void>((r) => gates.push({ open: r })), aborted(signal)])
  } else {
    await sleep(1)
    if (signal.aborted) throw new Error('AbortError')
  }
  // bytes determinísticos por sentença (o teste confere a ordem pelo conteúdo)
  return { audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }
}

/** Player fake para a `UtteranceQueue` real (o teste encerra cada utterance na mão). */
type FakePlayer = {
  id: string
  play(): void
  pause(): void
  onended: (() => void) | null
  onerror: (() => void) | null
  volume: number
}
const players: FakePlayer[] = []
const playerLog: string[] = []
function playerFactory(audio: Uint8Array): FakePlayer {
  const text = new TextDecoder().decode(audio)
  const p: FakePlayer = {
    id: text,
    play: () => void playerLog.push(`play:${text}`),
    pause: () => void playerLog.push(`pause:${text}`),
    onended: null,
    onerror: null,
    volume: 1
  }
  players.push(p)
  return p
}

// ---------------- manager real sobre o runner real ----------------

type Manager = InstanceType<(typeof import('../src/main/voice/call.ts'))['VoiceCallManager']>
type Queue = InstanceType<
  (typeof import('../src/renderer/src/lib/voice/utteranceQueue.ts'))['UtteranceQueue']
>
let manager: Manager | null = null
const emitted: string[] = []
const emittedIds: string[] = []
let queue: Queue | null = null
const states: VoiceCallState[] = []

async function boot(): Promise<{ manager: Manager }> {
  const { call, runner, repo, events, request, machine } = await load()
  const { UtteranceQueue } = await import('../src/renderer/src/lib/voice/utteranceQueue.ts')
  if (manager) return { manager }
  queue = new UtteranceQueue({
    playerFactory: (audio) => playerFactory(audio) as any,
    onState: (s) => {
      if (s === 'idle') manager?.playbackIdle()
    }
  })
  manager = new call.VoiceCallManager({
    // como o IPC: o `meta.voice` da fala vai junto (stash consumido pelo `runner.send`)
    sendTurn: (sid, text, meta) => {
      if (meta) runner.stashUserMeta(sid, text, meta)
      void runner.send(sid, text)
    },
    synth,
    emitState: (s) => states.push({ ...s }),
    emitUtterance: (u) => {
      emitted.push(new TextDecoder().decode(u.audio))
      emittedIds.push(u.id)
      queue?.enqueue(u)
    },
    // os preâmbulos ficam fora destes testes (clip ausente = nada toca; ver
    // `e2e/voiceCallActs.test.ts` para os atos de fala curta)
    emitUtteranceCancel: (id) => queue?.drop(id),
    emitTimeline: () => {},
    logEval: () => {},
    clip: async () => null,
    sessionInfo: (sid) => {
      const s = repo.sessionsRepo.get(sid)
      return s ? { chatId: s.chatId, depth: s.depth, busy: machine.isBusyStatus(s.status) } : null
    },
    chatConfig: (chatId) => repo.chatsRepo.get(chatId)?.config ?? null,
    settings: () => ({
      defaults: DEFAULT_VOICE_CALL_DEFAULTS,
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: DEFAULT_STT_SETTINGS,
      tts: DEFAULT_TTS_SETTINGS
    }),
    onEvent: (cb) => events.onAgentEvent(cb),
    // turno continuado / barge-in: o runner real para o turno e ajusta o histórico ao falado
    amendTurn: async (sid, amend) => {
      await runner.amendVoiceTurn(sid, amend)
    }
  })
  request.setVoiceCallSource((chat, session) => manager!.callContextFor(chat, session))
  return { manager }
}

let providerId = ''
let providerVozId = ''
async function newChat(
  voiceConfig?: unknown,
  chatTools: string[] = []
): Promise<{ chatId: string; sid: string }> {
  const { repo } = await load()
  if (!providerId) {
    providerId = repo.providersRepo.create({
      name: 'Falso',
      baseUrl: base,
      apiKey: 'k',
      headers: {}
    } as any).id
    providerVozId = repo.providersRepo.create({
      name: 'Falso Voz',
      baseUrl: `${base}/voz`,
      apiKey: 'k',
      headers: {}
    } as any).id
  }
  const { chat, session } = repo.chatsRepo.create({
    config: {
      providerId,
      model: MODEL,
      cwd: TMP,
      systemPrompt: 'persona base',
      params: { temperature: 0.7 },
      ...(chatTools.length ? { enabledTools: chatTools } : {}),
      ...(voiceConfig ? { voice: voiceConfig } : {})
    } as any
  })
  return { chatId: chat.id, sid: session.id }
}

const st = (sid: string): any => mods!.repo.sessionsRepo.get(sid)!
const path = (sid: string): any[] => mods!.repo.messagesRepo.path(sid)
const idle = (sid: string): Promise<unknown> =>
  waitFor(() => !mods!.runner.isRunning(sid) && st(sid).status === 'idle', 10_000, 'idle')

// ---------------- turno completo ----------------

test('turno completo: fala → transcrição → envio → stream → 2 sentenças → 2 sínteses na ordem → playback', async () => {
  synthMode = 'auto'
  synthCalls.length = 0
  emitted.length = 0
  players.length = 0
  playerLog.length = 0
  const { manager: m } = await boot()
  m.stop() // cada teste começa com a chamada fechada (idempotente)
  const { sid } = await newChat()
  const s0 = m.start(sid)
  assert.equal(s0.active, true)
  assert.equal(s0.phase, 'listening')

  // fala do usuário (transcrição mockada pelo chamador — o renderer faz `voice:transcribe:stop`)
  m.speechBegin()
  m.speechEnd()
  assert.equal(m.state().phase, 'transcribing')
  m.turn('duas frases por favor')
  await idle(sid)
  //2 sentenças,2 sínteses, na ordem
  await waitFor(() => synthCalls.length >= 2, 8000, '2 sínteses')
  assert.deepEqual(synthCalls, ['Primeira frase.', 'Segunda frase.'])
  await waitFor(() => emitted.length >= 2, 8000, '2 utterances emitidas')
  assert.deepEqual(emitted, ['WAV:Primeira frase.', 'WAV:Segunda frase.'])
  assert.equal(playerLog[0], 'play:WAV:Primeira frase.')
  assert.deepEqual(
    players.map((p) => p.id),
    ['WAV:Primeira frase.'],
    'uma utterance por vez (sem sobreposição)'
  )
  assert.equal(queue!.pending, 1, 'a segunda aguarda a primeira terminar')

  // resposta completa no histórico (o texto da fala e da resposta são mensagens normais)
  const msgs = path(sid)
  assert.deepEqual(
    msgs.map((x) => x.message.role),
    ['user', 'assistant']
  )
  assert.equal(textOf(msgs[0].message.content), 'duas frases por favor')
  assert.equal(textOf(msgs[1].message.content), 'Primeira frase. Segunda frase.')

  // fim da reprodução: a segunda utterance toca e a fila esvazia → volta a ouvir
  players[0].onended!()
  assert.deepEqual(
    players.map((p) => p.id),
    ['WAV:Primeira frase.', 'WAV:Segunda frase.']
  )
  players[1].onended!()
  await waitFor(() => m.state().phase === 'listening', 4000, 'listening após playback')
  m.stop()
  assert.equal(m.state().active, false)
})

test('fila de turnos: fala depois de OUVIR a resposta vira o próximo turno', async () => {
  synthMode = 'auto'
  synthCalls.length = 0
  emitted.length = 0
  const { manager: m } = await boot()
  m.stop() // cada teste começa com a chamada fechada (idempotente)
  const { sid } = await newChat()
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('duas')
  // a resposta foi falada (as duas frases emitidas e ouvidas) — a fala seguinte é turno novo
  await waitFor(() => emitted.length >= 2, 8000, 'resposta falada')
  m.speechBegin()
  m.speechEnd()
  m.turn('ok, obrigado')
  await idle(sid) // primeira resposta termina → o pendente (se houver) sai sozinho
  await idle(sid) // segunda resposta termina
  const msgs = path(sid)
  assert.deepEqual(
    msgs.map((x) => x.message.role),
    ['user', 'assistant', 'user', 'assistant']
  )
  assert.equal(textOf(msgs[2].message.content), 'ok, obrigado')
  assert.equal(m.state().pendingText, '')
  m.stop()
})

test('barge-in: fala durante a reprodução cancela a fala e o histórico fica só com o FALADO', async () => {
  synthMode = 'gated'
  synthCalls.length = 0
  emitted.length = 0
  players.length = 0
  playerLog.length = 0
  const { manager: m } = await boot()
  m.stop() // cada teste começa com a chamada fechada (idempotente)
  const { sid } = await newChat()
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('duas')
  // 1ª sentença: síntese liberada na mão → utterance emitida e tocando
  await waitFor(() => synthCalls.length >= 1, 8000, '1ª síntese')
  openGate(0)
  await waitFor(() => emitted.length >= 1, 8000, '1ª utterance')
  const firstId = emittedIds[emittedIds.length - 1]
  // barge-in com a 2ª sentença ainda em síntese
  await waitFor(() => synthCalls.length >= 2, 8000, '2ª síntese em voo')
  queue!.cancel() // o renderer pausa e descarta a fila
  m.bargeIn({ playedIds: [firstId] }) // a 1ª frase começou a tocar
  openGate(1)
  await sleep(50)
  assert.equal(emitted.length, 1, 'a fala do assistente foi cancelada — a 2ª sentença não saiu')
  assert.equal(
    playerLog.includes('pause:WAV:Primeira frase.'),
    true,
    `o áudio em curso foi pausado: ${playerLog.join(',')} / ${emitted.join(',')}`
  )
  assert.equal(m.state().phase, 'listening', 'volta a escutar')
  await idle(sid)
  await waitFor(
    () => textOf(path(sid)[1]?.message.content) === 'Primeira frase.',
    8000,
    'histórico truncado ao falado'
  ).catch((e) => {
    throw new Error(
      `${e.message}: ${m.state().error} ${JSON.stringify(path(sid).map((x) => [x.id, x.message.content, x.meta]))}`
    )
  })
  const msgs = path(sid)
  assert.deepEqual(
    msgs.map((x) => x.message.role),
    ['user', 'assistant']
  )
  assert.equal(msgs[1].meta.interrupted, true, 'marcada como interrompida')
  m.stop()
  synthMode = 'auto'
})

test('barge-in no MEIO de uma frase: o histórico fica só com as palavras ouvidas + "…"; o resto é só de exibição', async () => {
  synthMode = 'gated'
  gates.length = 0
  synthCalls.length = 0
  emitted.length = 0
  players.length = 0
  playerLog.length = 0
  const { manager: m } = await boot()
  m.stop()
  const { sid } = await newChat()
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('longa')
  await waitFor(() => synthCalls.length >= 1, 8000, '1ª síntese')
  openGate(0)
  await waitFor(() => emitted.length >= 1, 8000, '1ª utterance')
  const firstId = emittedIds[emittedIds.length - 1]
  await waitFor(() => synthCalls.length >= 2, 8000, '2ª síntese em voo')
  // o usuário insiste no meio da 1ª frase: tocou 1,65 s de 3 s (o player informa a posição)
  queue!.cancel()
  m.bargeIn({
    playedIds: [firstId],
    reason: 'voiced',
    current: { id: firstId, playedMs: 1650, durationMs: 3000 }
  })
  openGate(1)
  await idle(sid)
  const full = 'Esta é uma frase bem longa sobre gatos e cachorros. Segunda frase.'
  await waitFor(
    () => textOf(path(sid)[1]?.message.content).endsWith('…'),
    8000,
    'histórico truncado às palavras ouvidas'
  )
  const asst = path(sid)[1]
  const heard = textOf(asst.message.content)
  assert.ok(heard.startsWith('Esta é uma'), heard)
  assert.ok(!heard.includes('cachorros'), `só o ouvido: ${heard}`)
  assert.ok(full.startsWith(heard.slice(0, -1)), 'prefixo do original, em fronteira de palavra')
  assert.ok(/\p{L}…$/u.test(heard), 'termina numa palavra inteira + "…"')
  assert.equal(asst.meta.interrupted, true)
  assert.equal(asst.meta.voice?.spoken, 'partial')
  assert.equal(
    `${heard.slice(0, -1)} ${asst.meta.voice?.unheard}`,
    full,
    'o resto não ouvido fica em meta.voice.unheard (exibição)'
  )
  // a próxima request leva SÓ o texto ouvido (o resto nunca vai ao modelo)
  synthMode = 'auto'
  const before = requests.length
  m.speechBegin()
  m.speechEnd()
  m.turn('ok')
  await waitFor(() => requests.length > before, 8000, 'próxima request')
  await idle(sid)
  const sent = requests[before].body.messages as any[]
  const prev = sent.find((x) => x.role === 'assistant')
  assert.equal(textOf(prev.content), heard, 'o modelo vê só o que foi ouvido + "…"')
  assert.ok(!JSON.stringify(sent).includes('cachorros'), 'nada do trecho não ouvido na request')
  m.stop()
})

test('turno continuado: falar de novo antes de ouvir a resposta une as falas e apaga a resposta não ouvida', async () => {
  synthMode = 'gated'
  synthCalls.length = 0
  emitted.length = 0
  gates.length = 0
  const { manager: m } = await boot()
  m.stop()
  const { sid } = await newChat()
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('duas coisas')
  // a resposta chega do modelo, mas nada foi falado ainda (síntese presa)
  await waitFor(() => synthCalls.length >= 1, 8000, '1ª síntese')
  assert.equal(emitted.length, 0)
  // o usuário volta a falar (a pausa tinha fechado o turno no meio da frase)
  m.speechBegin({ dropped: [] })
  m.speechEnd()
  synthMode = 'auto'
  m.turn('e mais uma')
  await waitFor(
    () => {
      const ms = path(sid)
      return ms.length === 2 && ms[1].message.role === 'assistant' && ms
    },
    8000,
    'turno refeito'
  ).catch((e) => {
    throw new Error(
      `${e.message}: ${m.state().error} ${JSON.stringify(m.state())} ${JSON.stringify(path(sid).map((x) => [x.message.role, x.message.content]))}`
    )
  })
  await idle(sid)
  const msgs = path(sid)
  assert.deepEqual(
    msgs.map((x) => x.message.role),
    ['user', 'assistant'],
    'o turno anterior (e a resposta nunca falada) saiu do histórico'
  )
  assert.equal(textOf(msgs[0].message.content), 'duas coisas e mais uma', 'falas unidas')
  // a resposta do turno refeito é falada
  await waitFor(() => emitted.length >= 1, 8000, 'resposta nova falada')
  assert.ok(emitted.every((e) => e.startsWith('WAV:')))
  m.stop()
})

test('turno continuado: fala sem texto (ruído) devolve a resposta retida', async () => {
  synthMode = 'auto'
  emitted.length = 0
  const { manager: m } = await boot()
  m.stop()
  const { sid } = await newChat()
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('duas')
  m.speechBegin({ dropped: [] }) // ruído antes de qualquer frase tocar: retém
  m.speechEnd()
  await idle(sid)
  await sleep(30)
  const held = emitted.length
  m.turn('') // transcrição vazia: a resposta volta a ser falada
  await waitFor(() => emitted.length >= held + 1, 8000, 'resposta liberada')
  assert.ok(emitted.includes('WAV:Primeira frase.'))
  const msgs = path(sid)
  assert.equal(textOf(msgs[1].message.content), 'Primeira frase. Segunda frase.', 'nada apagado')
  m.stop()
})

// ---------------- histórico idêntico + overrides ----------------

test('histórico de um turno de voz = de um turno de texto + meta.voice (request idêntica)', async () => {
  synthMode = 'auto'
  const { manager: m } = await boot()
  m.stop() // cada teste começa com a chamada fechada (idempotente)
  const { runner } = await load()
  // turno de texto puro
  const a = await newChat()
  runner.send(a.sid, 'conteúdo igual')
  await idle(a.sid)
  // turno de voz com o MESMO conteúdo
  const b = await newChat()
  m.start(b.sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('conteúdo igual')
  await idle(b.sid)
  m.stop()
  const pa = path(a.sid)
  const pb = path(b.sid)
  assert.deepEqual(
    pb.map((x) => x.message.role),
    pa.map((x) => x.message.role)
  )
  // a única diferença de meta é `voice` (exibição/custos — nunca vai à API)
  assert.deepEqual(
    pb.map((x) =>
      Object.keys(x.meta)
        .filter((k) => k !== 'voice')
        .sort()
    ),
    pa.map((x) => Object.keys(x.meta).sort()),
    'mesmas chaves de meta além de meta.voice'
  )
  assert.equal(pb[0].meta.voice?.source, 'call', 'fala do usuário marcada como da chamada')
  assert.equal(pb[1].meta.voice?.source, 'call', 'resposta marcada como falada na chamada')
  assert.equal(pb[1].meta.voice?.spoken, true)
  assert.equal(pb[0].meta.voice?.callId, pb[1].meta.voice?.callId, 'mesma chamada')
  assert.equal(pa[0].meta.voice, undefined, 'turno de texto sem meta.voice')
  assert.equal(
    pb.some((x) => x.meta.kind),
    false,
    'sem meta.kind em nenhum dos dois'
  )
  assert.deepEqual(
    pb.map((x) => Object.keys(x.message).sort()),
    pa.map((x) => Object.keys(x.message).sort())
  )
})

test('overrides do modo voz: voice.model/voice.tools/voicePrompt só nas requests (chat salvo intacto)', async () => {
  synthMode = 'auto'
  const { manager: m } = await boot()
  m.stop() // cada teste começa com a chamada fechada (idempotente)
  const { repo } = await load()
  const { chatId, sid } = await newChat({
    enabled: true,
    model: { providerId: providerVozId, model: MODEL_VOZ, params: { temperature: 0.1 } },
    tools: { enabledTools: ['shell'], maxToolOutputChars: 500 },
    voicePrompt: 'Fale em frases curtas.'
  })
  const before = JSON.parse(JSON.stringify(repo.chatsRepo.get(chatId)!.config))
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('ok')
  await idle(sid)
  m.stop()
  const req = requests[requests.length - 1]
  assert.ok(req.url.includes('/voz/chat/completions'), `provider da chamada usado (${req.url})`)
  assert.equal(req.body.model, MODEL_VOZ, 'modelo da chamada')
  assert.equal(req.body.temperature, 0.1, 'params da chamada substituem os do chat')
  assert.deepEqual(
    (req.body.tools ?? []).map((t: any) => t.function.name),
    ['shell', 'end_call', 'tool_search'],
    'só as tools liberadas na chamada (+ end_call, que é da chamada; + tool_search: compactas, 1.11.0)'
  )
  // tools compactadas na chamada: shell compacta, end_call SEMPRE completa (a despedida está nela)
  const [shellDef, endCallDef] = req.body.tools
  assert.deepEqual(shellDef.function.parameters, { type: 'object', properties: {} })
  assert.match(endCallDef.function.description, /Encerra a chamada de voz/)
  assert.ok(
    textOf(req.body.messages[0].content).endsWith('\n\n' + COMPACT_TOOLS_PROMPT),
    'prompt fixo das tools compactadas no fim do system prompt'
  )
  assert.ok(
    textOf(req.body.messages[0].content).includes('persona base\n\n'),
    'system prompt do chat primeiro'
  )
  assert.ok(
    textOf(req.body.messages[0].content).includes('persona base\n\nFale em frases curtas.'),
    'voicePrompt somado logo depois do system prompt (o app não acrescenta prompt próprio)'
  )
  assert.ok(
    !textOf(req.body.messages[0].content).includes('conversa por voz'),
    'sem prompt-base oculto do modo voz'
  )
  assert.equal(req.body.max_tokens, undefined, 'a chamada não impõe teto de tokens')
  const after = JSON.parse(JSON.stringify(repo.chatsRepo.get(chatId)!.config))
  assert.deepEqual(after, before, 'a config salva do chat não muda')
})

test('start com chamada desativada no chat (voice.enabled: false) → erro legível', async () => {
  const { manager: m } = await boot()
  m.stop()
  const { sid } = await newChat({ enabled: false })
  assert.throws(() => m.start(sid), /desativada/)
  assert.equal(m.state().active, false, 'nada de chamada aberta por cima do erro')
})

test('falha de TTS que persiste: 1 nova tentativa e a chamada ENCERRA com o motivo (nada não falado fica)', async () => {
  synthMode = 'auto'
  failSynth = true
  synthCalls.length = 0
  emitted.length = 0
  const { manager: m } = await boot()
  m.stop()
  const { sid } = await newChat()
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('duas')
  await waitFor(() => !m.state().active, 4000, 'a chamada encerrou')
  assert.match(m.state().error ?? '', /TTS fora do ar/, 'o motivo fica no estado inativo')
  assert.deepEqual(synthCalls, ['Primeira frase.', 'Primeira frase.'], 'uma nova tentativa só')
  assert.deepEqual(emitted, [], 'nada foi emitido para tocar')
  await idle(sid)
  await waitFor(
    () => !path(sid).some((x) => x.message.role === 'assistant' && !x.meta?.synthetic),
    4000,
    'a resposta nunca falada sai do histórico'
  )
  assert.equal(textOf(path(sid)[0].message.content), 'duas', 'a fala do usuário fica')
  failSynth = false
  // a próxima chamada começa limpa
  m.start(sid)
  assert.equal(m.state().error, null)
  m.stop()
})

test('falha transitória de TTS numa sentença: nova tentativa dá certo e a resposta continua', async () => {
  synthMode = 'auto'
  failSynth = false
  failSynthOn = 'Primeira'
  failSynthTimes = 1
  synthCalls.length = 0
  emitted.length = 0
  const { manager: m } = await boot()
  m.stop()
  const { sid } = await newChat()
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('duas')
  await idle(sid)
  await waitFor(() => emitted.length === 2, 4000, 'as duas sentenças foram emitidas')
  assert.deepEqual(synthCalls, ['Primeira frase.', 'Primeira frase.', 'Segunda frase.'])
  assert.equal(m.state().active, true, 'a chamada segue')
  failSynthOn = null
  failSynthTimes = Infinity
  m.stop()
})

test('tools da chamada: voice.tools.enabledTools vale na execução (libera e recusa)', async () => {
  synthMode = 'auto'
  failSynth = false
  const { manager: m } = await boot()
  m.stop()
  writeFileSync(join(TMP, 'alvo.txt'), 'CONTEUDO-ARQUIVO')
  // chat SEM tools + chamada libera read_file → o gate de execução honra a lista da chamada
  const a = await newChat({
    enabled: true,
    tools: { enabledTools: ['read_file'], maxToolOutputChars: null }
  })
  m.start(a.sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('ferramenta')
  await idle(a.sid)
  m.stop()
  const pa = path(a.sid)
  const toolA = pa.find((x) => x.message.role === 'tool')
  assert.ok(toolA, 'a tool rodou')
  assert.ok(
    textOf(toolA!.message.content).includes('CONTEUDO-ARQUIVO'),
    `executou de verdade (${textOf(toolA!.message.content).slice(0, 60)})`
  )
  assert.ok(textOf(pa[pa.length - 1].message.content).startsWith('FIM:'))
  // chat COM read_file + chamada com tools [] ("nenhuma tool") → execução recusa
  const b = await newChat(
    { enabled: true, tools: { enabledTools: [], maxToolOutputChars: null } },
    ['read_file']
  )
  m.start(b.sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('ferramenta')
  await idle(b.sid)
  m.stop()
  const pb = path(b.sid)
  const toolB = pb.find((x) => x.message.role === 'tool')
  assert.ok(toolB, 'a tentativa virou tool message com o erro')
  assert.ok(
    textOf(toolB!.message.content).includes('não está disponível'),
    textOf(toolB!.message.content).slice(0, 80)
  )
})
