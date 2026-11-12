/* eslint-disable @typescript-eslint/no-explicit-any */
// Chamada de voz no histórico (SPEC → "Chamada de voz → Histórico e custos"): tool `end_call`
// (só nos turnos da chamada; desliga DEPOIS de a despedida tocar; barge-in/fala cancelam),
// `meta.voice` nas falas (chamada) e no ditado, marcadores de início/fim (só exibição — nunca na
// request) com duração/custos (STT `usage.cost`, TTS ≈ preço de lista, LLM dos turnos de voz) e o
// gasto do chat sem contar em dobro. Parte com fakes puros (manager) e parte sobre o runner REAL
// (banco temporário + provedor OpenAI-compatible falso em 127.0.0.1). Nada pago, sem microfone.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceCallMarks.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  layerVoiceCallConfig,
  normalizeVoiceCallConfig,
  resolveVoiceCallConfig,
  type TtsSettings,
  type VoiceCallState
} from '@shared/voice'
import {
  END_CALL_RESULT,
  audioDurationMs,
  callCostSummary,
  callEndText,
  callUsageLines,
  formatCallClock,
  formatCallDuration,
  sanitizeDictationMeta,
  type VoiceCallMark
} from '@shared/voiceCallMarks'
import { isDisplayOnly } from '@shared/context'
import { TOOL_NAMES } from '@shared/tools'
import type { AgentEvent, Chat, Session, StoredMessage } from '@shared/types'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-callmarks-'))
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
    await sleep(10)
  }
}

// =====================================================================================
// puras
// =====================================================================================

test('formatos: duração, relógio da barra, áudio PCM/WAV, ditado sanitizado', () => {
  assert.equal(formatCallDuration(38_400), '38 s')
  assert.equal(formatCallDuration(252_000), '4 min 12 s')
  assert.equal(formatCallDuration(120_000), '2 min')
  assert.equal(formatCallDuration(3_725_000), '1 h 02 min')
  assert.equal(formatCallClock(133_000), '02:13')
  assert.equal(formatCallClock(3_725_000), '1:02:05')
  // PCM16 a 24 kHz: 48.000 bytes = 1 s
  assert.equal(audioDurationMs(new Uint8Array(48_000), 'audio/pcm;rate=24000'), 1000)
  // WAV PCM16 mono 16 kHz (byte rate 32000): cabeçalho + 16.000 bytes = 500 ms
  const wav = new Uint8Array(44 + 16_000)
  const dv = new DataView(wav.buffer)
  dv.setUint32(0, 0x52494646, false)
  dv.setUint32(28, 32_000, true)
  assert.equal(audioDurationMs(wav, 'audio/wav'), 500)
  assert.equal(audioDurationMs(new Uint8Array(10), 'audio/mpeg'), null)
  // do renderer só o ditado é aceito (a fala da chamada é marcada pelo main)
  assert.deepEqual(sanitizeDictationMeta({ source: 'dictation', x: 1 }), { source: 'dictation' })
  assert.equal(sanitizeDictationMeta({ source: 'call', callId: 'forjado' }), null)
  assert.equal(sanitizeDictationMeta('lixo'), null)
})

test('end_call: fora de TOOL_NAMES (enabledTools) e "O agente pode encerrar" persona→chat→global', () => {
  assert.equal((TOOL_NAMES as string[]).includes('end_call'), false)
  assert.equal(resolveVoiceCallConfig(null, DEFAULT_VOICE_CALL_DEFAULTS).endCall, true)
  assert.equal(
    resolveVoiceCallConfig(null, { ...DEFAULT_VOICE_CALL_DEFAULTS, endCall: false }).endCall,
    false
  )
  // persona desliga; chat sem escolha segue a persona; chat que liga vence
  const persona = normalizeVoiceCallConfig({ endCall: false })
  assert.equal(
    resolveVoiceCallConfig({} as any, DEFAULT_VOICE_CALL_DEFAULTS, persona).endCall,
    false
  )
  assert.equal(
    resolveVoiceCallConfig({ endCall: true } as any, DEFAULT_VOICE_CALL_DEFAULTS, persona).endCall,
    true
  )
  assert.equal(layerVoiceCallConfig({ endCall: null } as any, persona).endCall, false)
  // aditivo: ausente não é gravado; lixo descartado
  assert.equal('endCall' in normalizeVoiceCallConfig({}), false)
  assert.equal('endCall' in normalizeVoiceCallConfig({ endCall: 'sim' }), false)
})

const endMark = (over: Partial<VoiceCallMark> = {}): VoiceCallMark => ({
  callId: 'c1',
  phase: 'end',
  startedAt: 1000,
  endedAt: 253_000,
  durationMs: 252_000,
  endedBy: 'agent',
  usage: {
    turns: 3,
    userSpeechMs: 6200,
    stt: {
      mode: 'api',
      model: 'whisper',
      apiRequests: 9,
      apiAudioMs: 14_000,
      localRequests: 0,
      cost: 0.0011,
      costedRequests: 9
    },
    tts: {
      backend: 'api',
      model: 'flash',
      chars: 118,
      audioMs: 9800,
      cost: 0.0118,
      estimated: true
    },
    llm: { calls: 3, cost: 0.0057, costed: 3 }
  },
  ...over
})

test('marcador de fim: texto, custo resumido (≈ com a estimativa da voz) e detalhamento', () => {
  const m = endMark()
  assert.equal(callEndText(m), 'Chamada encerrada · 4 min 12 s · pelo agente')
  assert.equal(callCostSummary(m.usage), '≈ $0,02') // 0,0011 + 0,0057 + ≈0,0118
  const lines = Object.fromEntries(callUsageLines(m))
  assert.equal(lines['Duração'], '4 min 12 s')
  assert.match(lines['Transcrição (whisper)'], /9 requests · 14 s · \$0,0011/)
  assert.match(lines['Voz (flash)'], /118 caracteres · ≈ \$0,01 \(preço de lista\)/)
  assert.match(lines['Modelo (respostas)'], /3 · \$0,0057/)
  assert.equal(lines['Preâmbulos'], 'grátis (clipes pré-gerados)')
  // local/GPU = grátis; ElevenLabs direta = caracteres (créditos); sem custo informado
  const local = endMark({
    endedBy: 'error',
    reason: 'créditos esgotados',
    usage: {
      ...endMark().usage!,
      stt: {
        ...endMark().usage!.stt,
        mode: 'local',
        apiRequests: 0,
        cost: undefined,
        costedRequests: 0
      },
      tts: { backend: 'elevenlabs', chars: 500, audioMs: 0 },
      llm: { calls: 2, cost: 0, costed: 0 }
    }
  })
  const l2 = Object.fromEntries(callUsageLines(local))
  assert.equal(l2['Transcrição (whisper)'], 'local (grátis)')
  assert.equal(l2['Voz'], '500 caracteres (créditos ElevenLabs)')
  assert.match(l2['Modelo (respostas)'], /custo não informado/)
  assert.equal(l2['Encerrada'], 'erro: créditos esgotados')
  assert.equal(callCostSummary(local.usage), null, 'nada com custo conhecido')
  const noCost = endMark({
    usage: {
      ...endMark().usage!,
      stt: { ...endMark().usage!.stt, cost: undefined, costedRequests: 0 }
    }
  })
  assert.match(
    Object.fromEntries(callUsageLines(noCost))['Transcrição (whisper)'],
    /custo não informado/
  )
})

test('sttUsageCost: usage.cost do OpenRouter (número finito ≥ 0)', async () => {
  const { sttUsageCost } = await import('../src/main/voice/stt.ts')
  assert.equal(sttUsageCost({ text: 'x', usage: { cost: 0.00012, seconds: 3 } }), 0.00012)
  assert.equal(sttUsageCost({ text: 'x' }), undefined)
  assert.equal(sttUsageCost({ usage: { cost: 'NaN' } }), undefined)
  assert.equal(sttUsageCost(null), undefined)
})

test('gasto do chat: turnos de voz saem de "Respostas" para "Chamadas de voz" (sem contar em dobro)', async () => {
  const { computeChatSpend } = await import('../src/renderer/src/lib/chatSpend.ts')
  const chat = { id: 'c', mainSessionId: 's', config: {} } as unknown as Chat
  const sessions = [{ id: 's', chatId: 'c', depth: 0, createdAt: 0 } as Session]
  let seq = 0
  const mk = (role: any, meta: any, content = 'x'): StoredMessage => ({
    id: `m${++seq}`,
    sessionId: 's',
    seq,
    message: { role, content } as any,
    meta,
    createdAt: seq
  })
  const voice = { source: 'call', callId: 'c1', spoken: true }
  const msgs = [
    mk('user', {}),
    mk('assistant', { model: 'm', usage: { promptTokens: 10, completionTokens: 5, cost: 0.01 } }),
    mk('assistant', {
      synthetic: true,
      kind: 'voice-call',
      voiceCall: { callId: 'c1', phase: 'start', startedAt: 1 }
    }),
    mk('user', { voice: { source: 'call', callId: 'c1', durationMs: 900 } }),
    mk('assistant', {
      model: 'm',
      usage: { promptTokens: 10, completionTokens: 5, cost: 0.002 },
      voice
    }),
    mk('assistant', {
      model: 'm',
      usage: { promptTokens: 10, completionTokens: 5, cost: 0.003 },
      voice
    }),
    mk('assistant', { synthetic: true, kind: 'voice-call', voiceCall: endMark() }),
    // ditado: não é chamada — a resposta seguinte conta em "Respostas"
    mk('user', { voice: { source: 'dictation' } }),
    mk('assistant', { model: 'm', usage: { promptTokens: 10, completionTokens: 5, cost: 0.004 } })
  ]
  const sp = computeChatSpend(chat, sessions, { s: msgs })
  assert.equal(sp.main.calls, 2, 'só as respostas fora da chamada')
  assert.ok(Math.abs(sp.main.cost - 0.014) < 1e-9)
  assert.equal(sp.voice.calls, 1)
  assert.equal(sp.voice.open, 0)
  assert.equal(sp.voice.llm.calls, 2)
  assert.ok(Math.abs(sp.voice.llm.cost - 0.005) < 1e-9)
  assert.ok(Math.abs(sp.voice.stt.cost - 0.0011) < 1e-9)
  assert.ok(Math.abs(sp.voice.tts.estimated - 0.0118) < 1e-9, 'estimativa da voz separada')
  assert.equal(sp.voice.tts.cost, 0)
  assert.equal(sp.voice.durationMs, 252_000)
  assert.equal(sp.voice.userSpeechMs, 6200)
  // total = respostas + voz (LLM) + STT informado; a estimativa ≈ da voz fica fora
  assert.ok(Math.abs(sp.total.cost - (0.014 + 0.005 + 0.0011)) < 1e-9, `total ${sp.total.cost}`)
  assert.equal(sp.total.calls, 4, 'cada resposta conta uma vez')
  // chamada em andamento (só o marcador de início)
  const open = computeChatSpend(chat, sessions, { s: msgs.slice(0, 6) })
  assert.equal(open.voice.calls, 1)
  assert.equal(open.voice.open, 1)
})

// =====================================================================================
// VoiceCallManager com fakes (sem runner): end_call, barge-in, marcadores, custos
// =====================================================================================

type Manager = InstanceType<(typeof import('../src/main/voice/call.ts'))['VoiceCallManager']>

interface Harness {
  m: Manager
  sent: { text: string; meta: any }[]
  markers: { content: string; meta: any }[]
  utterances: string[]
  states: VoiceCallState[]
  timeline: string[]
  emit: (e: AgentEvent) => void
  history: StoredMessage[]
  busy: { v: boolean }
}

const TTS_API: TtsSettings = {
  ...DEFAULT_TTS_SETTINGS,
  backend: 'api',
  api: { providerId: 'p', model: 'tts-model', voice: null }
}

async function harness(opts: { hangupMaxWaitMs?: number } = {}): Promise<Harness> {
  const { VoiceCallManager } = await import('../src/main/voice/call.ts')
  let cb: ((e: AgentEvent) => void) | null = null
  const h: Harness = {
    sent: [],
    markers: [],
    utterances: [],
    states: [],
    timeline: [],
    emit: (e) => cb?.(e),
    history: [],
    busy: { v: false },
    m: null as unknown as Manager
  }
  let n = 0
  h.m = new VoiceCallManager({
    sendTurn: (_sid, text, meta) => void h.sent.push({ text, meta }),
    synth: async (text) => ({ audio: new TextEncoder().encode(text), mime: 'audio/wav' }),
    emitState: (s) => void h.states.push(s),
    emitUtterance: (u) => void h.utterances.push(new TextDecoder().decode(u.audio)),
    emitUtteranceCancel: () => {},
    emitTimeline: (e) => void h.timeline.push(e.kind),
    logEval: () => {},
    clip: async () => null,
    sessionInfo: () => ({ chatId: 'c', depth: 0, busy: h.busy.v }),
    chatConfig: () => ({}) as any,
    settings: () => ({
      defaults: {
        ...DEFAULT_VOICE_CALL_DEFAULTS,
        fillers: { ...DEFAULT_VOICE_CALL_DEFAULTS.fillers, enabled: false }
      },
      audioInput: DEFAULT_AUDIO_INPUT,
      stt: { ...DEFAULT_STT_SETTINGS, api: { ...DEFAULT_STT_SETTINGS.api, model: 'whisper-x' } },
      tts: TTS_API
    }),
    onEvent: (fn) => {
      cb = fn
      return () => {}
    },
    appendMarker: (_sid, content, meta) => void h.markers.push({ content, meta }),
    sessionMessages: () => h.history,
    ttsUnitPrice: () => 0.00001,
    newCallId: () => `call-${++n}`,
    ...(opts.hangupMaxWaitMs != null ? { hangupMaxWaitMs: opts.hangupMaxWaitMs } : {})
  })
  return h
}

const userMsg = (id: string, text: string): StoredMessage => ({
  id,
  sessionId: 's1',
  seq: 1,
  message: { role: 'user', content: text },
  meta: {},
  createdAt: 1
})

/** O agente responde "Até mais!" + end_call (como o runner grava) e termina o turno. */
function agentSaysGoodbye(h: Harness, callId: string): void {
  const a: StoredMessage = {
    id: 'a1',
    sessionId: 's1',
    seq: 2,
    message: {
      role: 'assistant',
      content: 'Até mais!',
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'end_call', arguments: '{"reason":"usuário se despediu"}' }
        }
      ]
    },
    meta: {
      usage: { promptTokens: 1, completionTokens: 1, cost: 0.002 },
      voice: { source: 'call', callId, spoken: true }
    },
    createdAt: 2
  }
  const t: StoredMessage = {
    id: 't1',
    sessionId: 's1',
    seq: 3,
    message: { role: 'tool', tool_call_id: 'tc1', content: END_CALL_RESULT },
    meta: { toolStatus: 'ok' },
    createdAt: 3
  }
  h.history.push(a, t)
  h.emit({ type: 'message-added', message: a })
  h.emit({ type: 'message-added', message: t })
  h.emit({ type: 'session-updated', session: { id: 's1', status: 'idle' } as Session })
}

async function callUntilGoodbye(h: Harness): Promise<string> {
  const s = h.m.start('s1')
  assert.equal(s.active, true)
  assert.ok(s.callId && s.startedAt, 'estado com id e início (relógio da barra)')
  assert.equal(h.markers[0].meta.kind, 'voice-call')
  assert.equal(h.markers[0].meta.voiceCall.phase, 'start')
  h.m.speechBegin()
  h.m.speechEnd()
  // a final da transcrição chega ANTES do turno (o IPC repassa `voice:transcribe:stop`)
  h.m.noteTranscript({ text: 'valeu, tchau', model: 'whisper-x', backend: 'api', audioMs: 1500 })
  h.m.noteSttApiUsage({ audioMs: 1500, cost: 0.0004 })
  h.m.noteSttApiUsage({ audioMs: 800 }) // parcial sem custo informado
  h.m.turn('valeu, tchau')
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.sent[0].meta.voice, {
    source: 'call',
    callId: s.callId,
    durationMs: 1500,
    sttModel: 'whisper-x'
  })
  const u = userMsg('u1', 'valeu, tchau')
  h.history.push(u)
  h.emit({ type: 'message-added', message: u })
  agentSaysGoodbye(h, s.callId!)
  await waitFor(() => h.utterances.includes('Até mais!'), 2000, 'despedida sintetizada')
  return s.callId!
}

test('end_call: a chamada cai DEPOIS de a despedida tocar; marcador de fim com custos', async () => {
  const h = await harness()
  const callId = await callUntilGoodbye(h)
  h.m.noteTtsAudio(900)
  assert.equal(h.m.state().active, true, 'ainda tocando: não cai')
  assert.ok(h.timeline.includes('hangup-armed'))
  h.m.playbackIdle()
  assert.equal(h.m.state().active, false, 'despedida tocou → caiu')
  assert.equal(h.m.state().error, null, 'fim pelo agente não é erro (sem toast)')
  const end = h.markers[1]
  assert.equal(end.meta.kind, 'voice-call')
  assert.equal(end.meta.synthetic, true)
  const mark: VoiceCallMark = end.meta.voiceCall
  assert.equal(mark.phase, 'end')
  assert.equal(mark.callId, callId)
  assert.equal(mark.endedBy, 'agent')
  assert.equal(mark.reason, 'usuário se despediu')
  assert.match(end.content, /^Chamada encerrada · \d+ s · pelo agente$/)
  const u = mark.usage!
  assert.equal(u.turns, 1)
  assert.equal(u.userSpeechMs, 1500)
  assert.equal(u.stt.apiRequests, 2)
  assert.equal(u.stt.apiAudioMs, 2300)
  assert.equal(u.stt.costedRequests, 1)
  assert.ok(Math.abs((u.stt.cost ?? 0) - 0.0004) < 1e-12)
  assert.equal(u.tts.backend, 'api')
  assert.equal(u.tts.chars, 'Até mais!'.length)
  assert.equal(u.tts.audioMs, 900)
  assert.equal(u.tts.estimated, true)
  assert.ok(Math.abs((u.tts.cost ?? 0) - 'Até mais!'.length * 0.00001) < 1e-12)
  assert.deepEqual(u.llm, { calls: 1, cost: 0.002, costed: 1 })
})

test('end_call: barge-in (ou fala nova) antes de cair cancela o desligamento', async () => {
  const h = await harness()
  await callUntilGoodbye(h)
  h.m.bargeIn({ playedIds: [] })
  assert.ok(h.timeline.includes('hangup-cancelled'))
  h.m.playbackIdle()
  assert.equal(h.m.state().active, true, 'o usuário continuou falando: a chamada segue')
  h.m.stop()
  assert.equal(h.markers[1].meta.voiceCall.endedBy, 'user')

  const h2 = await harness()
  await callUntilGoodbye(h2)
  h2.m.speechBegin()
  h2.m.playbackIdle()
  assert.equal(h2.m.state().active, true, 'fala nova também cancela')
  h2.m.stop()
})

test('end_call: sem o playback-idle do renderer a chamada cai pela espera máxima', async () => {
  const h = await harness({ hangupMaxWaitMs: 30 })
  await callUntilGoodbye(h)
  assert.equal(h.m.state().active, true)
  await waitFor(() => !h.m.state().active, 2000, 'espera máxima')
  assert.equal(h.markers[1].meta.voiceCall.endedBy, 'agent')
})

test('marcador de fim adiado enquanto o turno do agente roda; erro leva o motivo', async () => {
  const h = await harness()
  h.m.start('s1')
  h.busy.v = true
  h.m.stop()
  assert.equal(h.markers.length, 1, 'ainda rodando: fim adiado (nunca no meio de um passo)')
  h.busy.v = false
  h.emit({ type: 'session-updated', session: { id: 's1', status: 'idle' } as Session })
  assert.equal(h.markers.length, 2)
  assert.equal(h.markers[1].meta.voiceCall.endedBy, 'user')
  // fim por falha: o motivo fica no marcador e no estado
  h.m.start('s1')
  h.m.stop('créditos da ElevenLabs esgotados (voz)')
  const mk = h.markers[3].meta.voiceCall
  assert.equal(mk.endedBy, 'error')
  assert.equal(mk.reason, 'créditos da ElevenLabs esgotados (voz)')
  assert.match(h.markers[3].content, /erro: créditos da ElevenLabs/)
})

// =====================================================================================
// runner real + provedor falso: end_call só na chamada, turno termina, marcadores fora da request
// =====================================================================================

const MODEL = 'fake/agent'
let server: Server
let base = ''
const requests: { body: any }[] = []
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''
async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const chunk = (model: string, delta: any, finish?: string): string =>
  `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } } : {}) })}\n\n`

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000 }] }))
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      requests.push({ body })
      const msgs: any[] = body.messages ?? []
      const last = msgs[msgs.length - 1]
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      const key = (textOf(lastUser?.content).trim().split(/\s+/)[0] || '').replace(/[,.!?]/g, '')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (last?.role === 'tool') {
        res.write(chunk(body.model, { role: 'assistant', content: 'NUNCA DEVIA SAIR' }))
        res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
        return
      }
      if (key === 'tchau') {
        res.write(chunk(body.model, { role: 'assistant', content: 'Até mais!' }))
        res.write(
          chunk(body.model, {
            tool_calls: [
              {
                index: 0,
                id: `call_end_${requests.length}`,
                type: 'function',
                function: { name: 'end_call', arguments: '{"reason":"despedida"}' }
              }
            ]
          })
        )
        res.end(chunk(body.model, {}, 'tool_calls') + 'data: [DONE]\n\n')
        return
      }
      res.write(chunk(body.model, { role: 'assistant', content: 'Resposta simples.' }))
      res.end(chunk(body.model, {}, 'stop') + 'data: [DONE]\n\n')
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

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

let real: Manager | null = null
let realPlayback = 0
async function bootReal(): Promise<Manager> {
  const { call, runner, repo, events, request, machine } = await load()
  if (real) return real
  real = new call.VoiceCallManager({
    sendTurn: (sid, text, meta) => {
      if (meta) runner.stashUserMeta(sid, text, meta)
      void runner.send(sid, text)
    },
    synth: async (text) => ({ audio: new TextEncoder().encode(text), mime: 'audio/wav' }),
    emitState: () => {},
    emitUtterance: () => void realPlayback++,
    emitUtteranceCancel: () => {},
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
    amendTurn: async (sid, amend) => {
      await runner.amendVoiceTurn(sid, amend)
    },
    appendMarker: (sid, content, meta) => void runner.appendDisplayMessage(sid, content, meta),
    sessionMessages: (sid) => repo.messagesRepo.path(sid)
  })
  request.setVoiceCallSource((chat, session) => real!.callContextFor(chat, session))
  return real
}

let providerId = ''
async function newChat(voice?: unknown): Promise<{ chatId: string; sid: string }> {
  const { repo } = await load()
  if (!providerId)
    providerId = repo.providersRepo.create({
      name: 'Falso',
      baseUrl: base,
      apiKey: 'k',
      headers: {}
    } as any).id
  const { chat, session } = repo.chatsRepo.create({
    config: {
      providerId,
      model: MODEL,
      cwd: TMP,
      systemPrompt: 'persona base',
      enabledTools: [],
      ...(voice ? { voice } : {})
    } as any
  })
  return { chatId: chat.id, sid: session.id }
}
const path = (sid: string): StoredMessage[] => mods!.repo.messagesRepo.path(sid)
const idle = (sid: string): Promise<unknown> =>
  waitFor(
    () => !mods!.runner.isRunning(sid) && mods!.repo.sessionsRepo.get(sid)!.status === 'idle',
    10_000,
    'idle'
  )

test('runner real: end_call só na chamada, encerra o turno (sem nova chamada ao modelo) e a chamada cai depois do áudio', async () => {
  const m = await bootReal()
  const { sid } = await newChat()
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.noteTranscript({ text: 'tchau, valeu', model: 'whisper', backend: 'api', audioMs: 1200 })
  const before = requests.length
  m.turn('tchau, valeu')
  await idle(sid)
  const req = requests[before].body
  assert.ok(
    (req.tools ?? []).some((t: any) => t.function.name === 'end_call'),
    'end_call oferecida no turno da chamada (mesmo sem tools no chat)'
  )
  assert.equal(requests.length, before + 1, 'depois do end_call o turno termina (sem 2ª request)')
  await waitFor(() => realPlayback > 0, 3000, 'despedida emitida')
  assert.equal(m.state().active, true, 'despedida tocando: a chamada ainda está de pé')
  m.playbackIdle()
  assert.equal(m.state().active, false, 'caiu depois da despedida')
  const msgs = path(sid)
  const kinds = msgs.map((x) => x.meta.kind ?? x.message.role)
  assert.deepEqual(kinds, ['voice-call', 'user', 'assistant', 'tool', 'voice-call'])
  const [start, user, bot, tool, end] = msgs
  assert.equal(start.meta.voiceCall?.phase, 'start')
  assert.equal(user.meta.voice?.source, 'call')
  assert.equal(user.meta.voice?.durationMs, 1200)
  assert.equal(user.meta.voice?.callId, start.meta.voiceCall?.callId)
  assert.equal(bot.meta.voice?.spoken, true)
  assert.equal(textOf((tool.message as any).content), END_CALL_RESULT)
  assert.equal(tool.meta.toolStatus, 'ok')
  assert.equal(end.meta.voiceCall?.endedBy, 'agent')
  assert.equal(end.meta.voiceCall?.reason, 'despedida')
  assert.deepEqual(end.meta.voiceCall?.usage?.llm, { calls: 1, cost: 0.001, costed: 1 })
  assert.ok(isDisplayOnly(start.meta) && isDisplayOnly(end.meta), 'marcadores só de exibição')

  // turno DIGITADO depois da chamada: sem end_call e sem os marcadores na request
  const n = requests.length
  mods!.runner.send(sid, 'oi de novo')
  await idle(sid)
  const typed = requests[n].body
  assert.equal(
    (typed.tools ?? []).some((t: any) => t.function.name === 'end_call'),
    false,
    'turno de texto nunca tem end_call'
  )
  const sent = JSON.stringify(typed.messages)
  assert.equal(
    sent.includes('Chamada de voz iniciada'),
    false,
    'marcador de início fora da request'
  )
  assert.equal(sent.includes('Chamada encerrada ·'), false, 'marcador de fim fora da request')
  assert.ok(sent.includes(END_CALL_RESULT), 'o resultado do end_call segue no histórico (curto)')
  assert.equal(path(sid).at(-1)?.meta.voice, undefined, 'resposta digitada sem meta.voice')
})

test('runner real: end_call desligado ("O agente pode encerrar" = não) e fora da chamada → indisponível', async () => {
  const m = await bootReal()
  const { sid } = await newChat({ endCall: false })
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  const before = requests.length
  m.turn('oi')
  await idle(sid)
  assert.equal(
    (requests[before].body.tools ?? []).some((t: any) => t.function.name === 'end_call'),
    false
  )
  m.stop()
  // o modelo chamando end_call num turno de texto: erro "não está disponível" (nada cai)
  const { sid: s2 } = await newChat()
  mods!.runner.send(s2, 'tchau')
  await idle(s2)
  const tool = path(s2).find((x) => x.message.role === 'tool')!
  assert.match(textOf((tool.message as any).content), /não está disponível/)
})

test('runner real: ditado — meta.voice { source: "dictation" } entregue pelo stash do envio', async () => {
  await bootReal()
  const { runner } = await load()
  const { sid } = await newChat()
  runner.stashUserMeta(sid, 'texto ditado', { voice: { source: 'dictation' } })
  runner.send(sid, 'texto ditado')
  await idle(sid)
  assert.deepEqual(path(sid)[0].meta.voice, { source: 'dictation' })
  // texto diferente do stash: nada é aplicado (o stash é de uma mensagem só)
  runner.stashUserMeta(sid, 'outro', { voice: { source: 'dictation' } })
  runner.send(sid, 'mensagem digitada')
  await idle(sid)
  assert.equal(
    path(sid).find((x) => textOf(x.message.content as any) === 'mensagem digitada')?.meta.voice,
    undefined
  )
})
