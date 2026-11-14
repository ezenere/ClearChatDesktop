/* eslint-disable @typescript-eslint/no-explicit-any */
// Chamada de voz: a resposta final chega AOS PEDAÇOS ao rascunho (eventos `draft` → chat e divisor
// de frases) e a 1ª frase vai à síntese ANTES do fim do stream — também quando o turno passou por
// uma tool (busca do servidor + tool_use na 1ª resposta, texto devagar na 2ª), na Anthropic nativa
// (`native-anthropic`) e numa OpenAI-compatible (controle). Runner REAL + `VoiceCallManager` REAL
// (síntese mockada), banco temporário, provedores FALSOS em 127.0.0.1.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/voiceStreaming.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS
} from '@shared/voice'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-voicestream-'))
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

const CLAUDE = 'claude-opus-5-5'
const OAI = 'fake/agent'
/** Frases da resposta final, uma a cada PAUSE ms. */
const SENTENCES = [
  'Encontrei três arquivos na pasta.',
  'O primeiro é o relatório de vendas.',
  'O segundo é uma planilha antiga.',
  'O terceiro é um rascunho.'
]
const PAUSE = 300
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Linha do tempo do servidor da última resposta final (ms epoch). */
let finalWrites: number[] = []
let finalEnd = 0

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const ev = (e: any): string => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`

async function anthropicTurn(res: ServerResponse, body: any): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  const last = (body.messages ?? []).at(-1)
  const toolResult =
    Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result')
  res.write(
    ev({
      type: 'message_start',
      message: { model: body.model, usage: { input_tokens: 50, output_tokens: 1 } }
    })
  )
  // raciocínio omitido (padrão dos Claude ≥ 4.7): bloco vazio + assinatura
  res.write(
    ev({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' }
    })
  )
  await sleep(150)
  res.write(
    ev({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'c2' }
    })
  )
  res.write(ev({ type: 'content_block_stop', index: 0 }))
  if (!toolResult) {
    // 1ª resposta: busca do servidor + tool_use list_dir
    res.write(
      ev({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'server_tool_use',
          id: 'srvtoolu_v1',
          name: 'tool_search_tool_regex'
        }
      })
    )
    res.write(
      ev({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"pattern":"list"}' }
      })
    )
    res.write(ev({ type: 'content_block_stop', index: 1 }))
    res.write(
      ev({
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_search_tool_result',
          tool_use_id: 'srvtoolu_v1',
          content: {
            type: 'tool_search_tool_search_result',
            tool_references: [{ type: 'tool_reference', tool_name: 'list_dir' }]
          }
        }
      })
    )
    res.write(ev({ type: 'content_block_stop', index: 2 }))
    res.write(
      ev({
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'tool_use', id: 'toolu_v1', name: 'list_dir', input: {} }
      })
    )
    res.write(
      ev({
        type: 'content_block_delta',
        index: 3,
        delta: { type: 'input_json_delta', partial_json: '{"path":"."}' }
      })
    )
    res.write(ev({ type: 'content_block_stop', index: 3 }))
    res.write(
      ev({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 30 }
      })
    )
    res.end(ev({ type: 'message_stop' }))
    return
  }
  // 2ª resposta: o texto devagar
  finalWrites = []
  res.write(
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
  )
  for (const s of SENTENCES) {
    await sleep(PAUSE)
    res.write(
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: `${s} ` } })
    )
    finalWrites.push(Date.now())
  }
  res.write(ev({ type: 'content_block_stop', index: 1 }))
  res.write(
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } })
  )
  finalEnd = Date.now()
  res.end(ev({ type: 'message_stop' }))
}

async function chatTurn(res: ServerResponse, body: any): Promise<void> {
  const chunk = (delta: any, finish?: string): string =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const last = (body.messages ?? []).at(-1)
  if (last?.role !== 'tool') {
    res.write(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_v1',
            type: 'function',
            function: { name: 'list_dir', arguments: '{"path":"."}' }
          }
        ]
      })
    )
    res.end(chunk({}, 'tool_calls') + 'data: [DONE]\n\n')
    return
  }
  finalWrites = []
  for (const s of SENTENCES) {
    await sleep(PAUSE)
    res.write(chunk({ content: `${s} ` }))
    finalWrites.push(Date.now())
  }
  finalEnd = Date.now()
  res.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
}

let server: Server
let base = ''
before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            url.startsWith('/anthropic/')
              ? { data: [{ id: CLAUDE, display_name: 'Claude Opus 5.5' }], has_more: false }
              : { data: [{ id: OAI, context_length: 64000 }] }
          )
        )
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      if (url.startsWith('/anthropic/')) await anthropicTurn(res, body)
      else await chatTurn(res, body)
    })().catch(() => res.destroy())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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
  mods ??= {
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

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  ms = 10_000,
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

/** Síntese: registra quando cada frase chegou. */
const synthAt: { text: string; t: number }[] = []
async function synth(text: string): Promise<{ audio: Uint8Array; mime: string }> {
  synthAt.push({ text, t: Date.now() })
  await sleep(1)
  return { audio: new TextEncoder().encode(`WAV:${text}`), mime: 'audio/wav' }
}

type Manager = InstanceType<(typeof import('../src/main/voice/call.ts'))['VoiceCallManager']>
let manager: Manager | null = null
/** Eventos `draft` da sessão (hora e tamanho do conteúdo). */
const drafts: { t: number; content: string }[] = []

async function boot(): Promise<Manager> {
  const { call, runner, repo, events, request, machine } = await load()
  if (manager) return manager
  request.setNativeTestHosts(['127.0.0.1'])
  events.onAgentEvent((e) => {
    if (e.type === 'draft' && e.draft) drafts.push({ t: Date.now(), content: e.draft.content })
  })
  manager = new call.VoiceCallManager({
    sendTurn: (sid, text, meta) => {
      if (meta) runner.stashUserMeta(sid, text, meta)
      void runner.send(sid, text)
    },
    synth,
    emitState: () => {},
    // a reprodução termina na hora (o player do renderer não existe aqui)
    emitUtterance: () => setTimeout(() => manager?.playbackIdle(), 5),
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
    }
  })
  request.setVoiceCallSource((chat, session) => manager!.callContextFor(chat, session))
  return manager
}

async function voiceTurnWithTool(kind: 'anthropic' | 'openai'): Promise<string> {
  const { repo, runner } = await load()
  const m = await boot()
  m.stop()
  writeFileSync(join(TMP, 'relatorio.txt'), 'x')
  const provider = repo.providersRepo.create({
    name: kind,
    ...(kind === 'anthropic' ? { kind: 'anthropic' } : {}),
    baseUrl: kind === 'anthropic' ? `${base}/anthropic/v1` : `${base}/v1`,
    apiKey: 'k',
    headers: {}
  } as any)
  const { session } = repo.chatsRepo.create({
    config: {
      providerId: provider.id,
      model: kind === 'anthropic' ? CLAUDE : OAI,
      cwd: TMP,
      systemPrompt: 'persona base'
    } as any
  })
  const sid = session.id
  drafts.length = 0
  synthAt.length = 0
  finalWrites = []
  finalEnd = 0
  m.start(sid)
  m.speechBegin()
  m.speechEnd()
  m.turn('liste os arquivos da pasta')
  await waitFor(
    () => !runner.isRunning(sid) && repo.sessionsRepo.get(sid)!.status === 'idle',
    15_000,
    'turno terminou'
  )
  m.stop()
  const msgs = repo.messagesRepo.path(sid)
  assert.ok(
    msgs.some((x) => x.message.role === 'tool'),
    `a tool rodou (${msgs.map((x) => x.message.role).join(',')})`
  )
  assert.ok(finalEnd > 0, 'a resposta final foi servida')
  const first = SENTENCES[0]
  const draftFirst = drafts.find((d) => d.content.includes(first))?.t
  const synthFirst = synthAt.find((s) => s.text.includes(first))?.t
  const info = `draft com a 1ª frase ${draftFirst ? draftFirst - finalEnd : '—'} ms do fim; síntese da 1ª frase ${synthFirst ? synthFirst - finalEnd : '—'} ms do fim; drafts com texto: ${drafts.filter((d) => d.content).length}`
  assert.ok(draftFirst != null && draftFirst < finalEnd - PAUSE * 2, `rascunho só no fim — ${info}`)
  assert.ok(synthFirst != null && synthFirst < finalEnd - PAUSE * 2, `síntese só no fim — ${info}`)
  return info
}

test('chamada de voz, OpenAI-compatible com tool: resposta final aos pedaços no rascunho e na síntese (controle)', async () => {
  console.log(await voiceTurnWithTool('openai'))
})

test('chamada de voz, Anthropic nativa com busca do servidor + tool: resposta final aos pedaços no rascunho e na síntese', async () => {
  console.log(await voiceTurnWithTool('anthropic'))
})
