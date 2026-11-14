/* eslint-disable @typescript-eslint/no-explicit-any */
// Diagnóstico PAGO (centavos) do streaming com as APIs reais: monta a request EXATAMENTE como o app
// (buildRequest com a config padrão de um chat novo — busca nativa de tools, system prompt e tools
// padrão) e a lê com o mesmo cliente do app (streamChat), registrando quando cada coisa chegou:
//   - rede: cada pedaço de bytes do corpo (já descomprimido) e os headers da resposta;
//   - app: cada atualização do acumulador (o que vira rascunho na tela, a cada ~40 ms);
//   - blocos: raciocínio (com texto ou omitido), busca do servidor, texto, argumentos de tool call.
// Diz se o texto chegou aos pedaços ou de uma vez, e onde o tempo foi (raciocínio sem texto na tela,
// argumentos de tool presos no servidor…). Uma request por alvo com chave (Anthropic, OpenRouter).
//
// Uso (na raiz do ClearChatDesktop):
//   ANTHROPIC_API_KEY=… node --import ./e2e/ts-hooks.mjs scripts/probe-streaming.ts --model=<id do chat>
//   OPENROUTER_API_KEY=… node --import ./e2e/ts-hooks.mjs scripts/probe-streaming.ts --or-model=anthropic/…
//   … --dry-run   só monta as requests (nada vai à rede)
//   … --tool      pede um arquivo (write_file): mede também os argumentos da tool call
//   … --control   (OpenRouter) também pela Chat Completions, para comparar
//   … --after-tool  a resposta DEPOIS de uma tool (histórico com list_dir e o resultado): o caso em
//                 que o claude-opus-5-5 segura a resposta inteira no servidor (2026-11-14)
//   … --effort=low|medium|high|xhigh|max   o esforço de raciocínio do chat (padrão: nenhum, como
//                 um chat novo — o modelo usa o padrão dele)
// Chaves só por env; nunca imprime chaves nem headers da request. Linha do tempo completa em JSON
// num diretório temporário (impresso no fim). URLs trocáveis (PROBE_ANTHROPIC_BASE,
// PROBE_OPENROUTER_BASE) só para testar o script contra um servidor falso local.
import { registerHooks } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ARGS = process.argv.slice(2)
const opt = (k: string): string | undefined =>
  ARGS.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const DRY = ARGS.includes('--dry-run')
const TOOL = ARGS.includes('--tool')
const CONTROL = ARGS.includes('--control')
const AFTER_TOOL = ARGS.includes('--after-tool')
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim() || ''
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY?.trim() || ''
const SECRETS = [ANTHROPIC_KEY, OPENROUTER_KEY].filter((s) => s.length >= 8)
const ANTHROPIC_BASE = process.env.PROBE_ANTHROPIC_BASE || 'https://api.anthropic.com/v1'
const OPENROUTER_BASE = process.env.PROBE_OPENROUTER_BASE || 'https://openrouter.ai/api/v1'
const MODEL = opt('model') || 'claude-haiku-4-5'
const OR_MODEL = opt('or-model') || 'anthropic/claude-haiku-4.5'
const EFFORT = opt('effort')

const redact = (s: string): string => {
  let out = s
  for (const k of SECRETS) out = out.split(k).join('***')
  return out
}
const log = (...a: unknown[]): void => console.log(redact(a.map(String).join(' ')))

// main do app fora do Electron: `electron` vira um stub; userData num diretório temporário
const TMP = mkdtempSync(join(tmpdir(), 'clearchat-probe-'))
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

const { buildRequest, setModelInfoSource, setNativeTestHosts } =
  await import('../src/main/agent/request.ts')
const { newAccumulator, streamChat } = await import('../src/main/agent/llm.ts')
const { DEFAULT_CHAT_CONFIG } = await import('../src/shared/defaults.ts')
// sem /models: parâmetros como desconhecidos (o app manda o que o chat define — nada, no padrão)
setModelInfoSource(() => undefined)
// hosts das URLs trocadas (servidor falso) no papel dos oficiais
setNativeTestHosts(
  [process.env.PROBE_ANTHROPIC_BASE, process.env.PROBE_OPENROUTER_BASE]
    .filter((u): u is string => !!u)
    .map((u) => new URL(u).hostname)
)

const PROMPT = TOOL
  ? 'Crie o arquivo poema.txt com um poema de umas 25 linhas sobre o mar (use a ferramenta de escrever arquivos; não precisa confirmar nada antes).'
  : AFTER_TOOL
    ? 'Liste os arquivos desta pasta e me diga em três ou quatro frases o que parece ter nela.'
    : 'Escreva três parágrafos (umas 200 palavras no total) sobre como as marés funcionam.'
/** --after-tool: a tool já rodou (o turno continua depois do resultado). */
const AFTER_TOOL_MESSAGES = [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'toolu_probe01',
        type: 'function',
        function: { name: 'list_dir', arguments: '{"path":"."}' }
      }
    ]
  },
  {
    role: 'tool',
    tool_call_id: 'toolu_probe01',
    content:
      'fotos/ (pasta)\nplanilha-2024.xlsx (12 KB)\nrascunho.txt (2 KB)\nrelatorio-vendas.pdf (340 KB)'
  }
]

interface Target {
  id: string
  provider: any
  model: string
  config?: Record<string, unknown>
}
const targets: Target[] = []
if (ANTHROPIC_KEY || DRY)
  targets.push({
    id: 'anthropic',
    provider: {
      id: 'probe-anthropic',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: ANTHROPIC_BASE,
      apiKey: ANTHROPIC_KEY
    },
    model: MODEL
  })
if (OPENROUTER_KEY || DRY) {
  const provider = {
    id: 'probe-openrouter',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: OPENROUTER_BASE,
    apiKey: OPENROUTER_KEY
  }
  targets.push({ id: 'openrouter-messages', provider, model: OR_MODEL })
  if (CONTROL)
    targets.push({
      id: 'openrouter-chat',
      provider,
      model: OR_MODEL,
      config: { toolsCompact: false }
    })
}
if (!targets.length) {
  log(
    'Nenhuma chave (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) — nada a fazer. Use --dry-run para só ver as requests.'
  )
  process.exit(1)
}

/** fetch do app embrulhado: headers da resposta e cada pedaço do corpo (tempo, bytes). */
const orig = globalThis.fetch
let net: {
  t0: number
  headers: Record<string, string>
  status: number
  chunks: [number, number][]
} | null = null
globalThis.fetch = (async (url: any, init: any) => {
  const res = await orig(url, init)
  if (!net) return res
  const n = net
  n.status = res.status
  for (const k of [
    'content-type',
    'content-encoding',
    'transfer-encoding',
    'cf-ray',
    'server',
    'via',
    'x-generation-id'
  ])
    if (res.headers.get(k))
      n.headers[k] = k === 'x-generation-id' ? '(presente)' : res.headers.get(k)!
  if (!res.body) return res
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        n.chunks.push([Date.now() - n.t0, chunk.byteLength])
        ctl.enqueue(chunk)
      }
    })
  )
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  })
}) as typeof fetch

const fmt = (ms: number | undefined): string => (ms == null ? '—' : `${(ms / 1000).toFixed(2)} s`)

const OUT = mkdtempSync(join(tmpdir(), 'clearchat-probe-out-'))
let n = 0
for (const t of targets) {
  const chat: any = {
    id: `probe-${t.id}`,
    title: '',
    mainSessionId: 's1',
    createdAt: 0,
    updatedAt: 0,
    config: {
      ...DEFAULT_CHAT_CONFIG(TMP, {
        providerId: t.provider.id,
        model: t.model,
        kind: t.provider.kind,
        baseUrl: t.provider.baseUrl
      }),
      ...(t.config ?? {}),
      ...(EFFORT ? { params: { reasoning_effort: EFFORT } } : {})
    }
  }
  const history: any[] = [
    {
      id: 'u1',
      sessionId: 's1',
      seq: 1,
      message: { role: 'user', content: PROMPT },
      meta: {},
      createdAt: Date.now()
    },
    ...(AFTER_TOOL ? AFTER_TOOL_MESSAGES : []).map((message, i) => ({
      id: `m${i + 2}`,
      sessionId: 's1',
      seq: i + 2,
      message,
      meta: {},
      createdAt: Date.now()
    }))
  ]
  const req = buildRequest(chat, { depth: 0, model: t.model, id: 's1' }, history, t.provider)
  const b = req.body as any
  log(`\n=== ${t.id} — ${t.model} — modo ${req.toolSearch?.mode ?? 'off'} — POST ${req.url}`)
  log(
    `body: stream=${b.stream} tools=${(b.tools ?? []).length} (adiadas ${(b.tools ?? []).filter((x: any) => x.defer_loading).length}, eager ${(b.tools ?? []).filter((x: any) => x.eager_input_streaming).length})` +
      ` thinking=${JSON.stringify(b.thinking ?? null)} output_config=${JSON.stringify(b.output_config ?? null)} max_tokens=${b.max_tokens ?? '—'}`
  )
  if (DRY) continue
  net = { t0: Date.now(), headers: {}, status: 0, chunks: [] }
  const t0 = net.t0
  const acc = newAccumulator()
  const updates: any[] = []
  let err = ''
  try {
    await streamChat(req, AbortSignal.timeout(300_000), acc, () => {
      updates.push({
        t: Date.now() - t0,
        content: acc.content.length,
        reasoning: acc.reasoning.length,
        args: acc.toolCalls.reduce((s, c) => s + c.arguments.length, 0),
        blocks: (acc.blocks ?? []).map((x) => x.type)
      })
    })
  } catch (e) {
    err = (e as Error).message
  }
  const n1 = net
  net = null
  const end = Date.now() - t0
  writeFileSync(
    join(OUT, `${++n}-${t.id}.json`),
    redact(
      JSON.stringify(
        {
          target: t.id,
          model: t.model,
          url: req.url,
          mode: req.toolSearch?.mode,
          status: n1.status,
          headers: n1.headers,
          chunks: n1.chunks,
          updates,
          end,
          finish: acc.finishReason,
          usage: acc.usage,
          blocks: acc.blocks,
          content: acc.content,
          error: err
        },
        null,
        1
      )
    )
  )
  log(
    `HTTP ${n1.status} · ${Object.entries(n1.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ')}`
  )
  if (err) log(`ERRO: ${err}`)
  const c = n1.chunks
  log(
    `rede: 1º byte ${fmt(c[0]?.[0])}, ${c.length} pedaços até ${fmt(c.at(-1)?.[0])} (maior: ${Math.max(0, ...c.map((x) => x[1]))} B); fim ${fmt(end)}`
  )
  const firstWhere = (f: (u: any) => boolean): number | undefined => updates.find(f)?.t
  const lastGrowth = (k: string): number | undefined => {
    let last: number | undefined
    for (let i = 1; i < updates.length; i++)
      if (updates[i][k] > updates[i - 1][k]) last = updates[i].t
    return last
  }
  const growths = (k: string): number =>
    updates.filter((u, i) => i > 0 && u[k] > updates[i - 1][k]).length + (updates[0]?.[k] ? 1 : 0)
  const thinkingBlock = firstWhere(
    (u) => u.blocks.includes('thinking') || u.blocks.includes('redacted_thinking')
  )
  log(
    `raciocínio: bloco desde ${fmt(thinkingBlock)}; texto do raciocínio ${acc.reasoning.length} chars` +
      `${thinkingBlock != null && !acc.reasoning.length ? ' (OMITIDO — a tela só mostra o cursor enquanto o modelo pensa)' : ''}`
  )
  const server = (acc.blocks ?? []).filter((x) => x.type === 'server_tool_use').length
  if (server) log(`busca do servidor: ${server} chamada(s)`)
  const f = firstWhere((u) => u.content > 0)
  const l = lastGrowth('content') ?? f
  log(
    `texto: ${acc.content.length} chars; 1º em ${fmt(f)}, último em ${fmt(l)}; ${growths('content')} atualizações com texto novo`
  )
  if (acc.toolCalls.length) {
    const fa = firstWhere((u) => u.args > 0)
    log(
      `tool calls: ${acc.toolCalls.map((x) => `${x.name}(${x.arguments.length} chars)`).join(', ')}; argumentos de ${fmt(fa)} a ${fmt(lastGrowth('args') ?? fa)} em ${growths('args')} atualizações`
    )
  }
  log(
    `fim: ${acc.finishReason ?? '—'} · tokens ${acc.usage ? `${acc.usage.promptTokens} in / ${acc.usage.completionTokens} out` : '—'}`
  )
  const textSpread = f != null && l != null ? l - f : 0
  const verdict =
    acc.content.length < 40
      ? 'texto curto demais para julgar'
      : growths('content') >= 5 && textSpread >= 500
        ? 'TEXTO CHEGOU AOS PEDAÇOS (o transporte e o app fazem streaming)'
        : 'TEXTO CHEGOU DE UMA VEZ'
  log(`veredito: ${verdict}`)
}
if (!DRY) log(`\nlinha do tempo completa (JSON, sem chaves): ${OUT}`)
