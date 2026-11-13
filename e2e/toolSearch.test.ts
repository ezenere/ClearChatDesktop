/* eslint-disable @typescript-eslint/no-explicit-any */
// Busca nativa de ferramentas (protocolo 1.12.0 — SYNC_PROTOCOL.md §4.3.6 "Busca nativa de
// ferramentas", §4.3.8 "Blocos nativos do provedor", §4.4 `toolSearchCaps`), sem chamada paga:
// (A) a lógica pura de @shared/toolSearch (o mobile vendora): tabela de modos, suporte por modelo,
//     bloqueios da Messages API, itens do array tools, `native` só quando preciso, reenvio
//     (canal, consistência, filtro de referências, adiadas carregadas), falhas lembradas (24 h);
// (B) a request montada (buildRequest, pura): native-anthropic, native-openrouter, versão local por
//     motivo, reenvio/descarte em edição, troca de modelo, compactação e compactação desligada;
// (C) o parse do SSE (formas documentadas da Anthropic/OpenRouter) sem corromper os argumentos;
// (D) o runner real com provedores FALSOS locais (127.0.0.1 tratado como host oficial): ida e volta
//     com os blocos reenviados, OpenRouter /messages com Bearer e custo pelo /generation, queda
//     para a versão local lembrada por 24 h (e não lembrada quando a local também falha), repetição
//     sem reenvio, `pause_turn` e a `tool_search` indisponível nos modos nativos.
// Rodar: npm run test:unit
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANTHROPIC_SEARCH_TOOL,
  OPENROUTER_SEARCH_TOOL,
  TOOL_SEARCH_CAPS_TTL_MS,
  TOOL_SEARCH_LOCAL_NOTICE,
  activeFailure,
  anthropicToolSearchSupport,
  capsKey,
  discoveredByNative,
  filterToolReferences,
  forceLoadedTools,
  isNativeRejection,
  messagesBlockers,
  nativeConsistent,
  nativeSearchChip,
  nativeSearches,
  nativeToolsArray,
  nativeTurnFrom,
  normalizeToolSearchCaps,
  prepareNativeReplay,
  replayableNative,
  resolveToolSearchMode,
  sentMediaOf,
  toolSearchMetaLabel,
  wireToolName,
  withFailure,
  withoutStaleNative,
  type ToolSearchModeInput
} from '../src/shared/toolSearch.ts'
import { COMPACT_TOOLS_PROMPT, planTools } from '../src/shared/compactTools.ts'
import { TOOL_ALIASES, type ApiMessage, type Chat, type Provider } from '../src/shared/types.ts'
import { TOOL_DEFINITIONS, toolDefinitionFor, type ToolDefinition } from '../src/shared/tools.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import { migrateMessageJson } from '../src/shared/toolRename.ts'
import {
  buildRequest,
  setModelInfoSource,
  setNativeTestHosts,
  setToolSearchCapsSource
} from '../src/main/agent/request.ts'
import { buildCompactionRequest, compactionMeta } from '../src/main/agent/compaction.ts'
import { applyAnthropicEvent, applyAnthropicMessage } from '../src/main/agent/adapters/anthropic.ts'
import { fetchGenerationCost, newAccumulator } from '../src/main/agent/llm.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-toolsearch-'))
const env = { os: 'Linux 6.0 (x64)', shell: 'bash' }

// ---------------- (A) lógica pura ----------------

const baseCfg = DEFAULT_CHAT_CONFIG('/w', { providerId: 'p', model: 'm', systemPrompt: 'S' })
const mi = (o: Partial<ToolSearchModeInput> = {}): ToolSearchModeInput => ({
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  providerId: 'pa',
  model: 'claude-sonnet-5-5',
  cfg: baseCfg,
  wouldCompact: true,
  ...o
})

test('modo: tabela de resolução (tipo × host × modelo × endpoints × bloqueios × falha × config)', () => {
  const r = (o: Partial<ToolSearchModeInput>): string => resolveToolSearchMode(mi(o)).mode
  // Anthropic oficial + Claude 4.5+ → nativa
  assert.deepEqual(resolveToolSearchMode(mi()), { mode: 'native-anthropic', api: 'messages' })
  assert.equal(r({ model: 'claude-haiku-4-5' }), 'native-anthropic')
  // modelo sem suporte / host de terceiros → local com o motivo
  const old = resolveToolSearchMode(mi({ model: 'claude-opus-4-1' }))
  assert.equal(old.mode, 'local')
  assert.match(old.reason!, /claude-opus-4-1 não tem a busca nativa/)
  const third = resolveToolSearchMode(mi({ baseUrl: 'https://gateway.example.com/v1' }))
  assert.equal(third.mode, 'local')
  assert.match(third.reason!, /não é a API oficial \(gateway\.example\.com\)/)
  // hosts de teste (provedor falso local)
  assert.equal(
    r({ baseUrl: 'http://127.0.0.1:9/v1', extraHosts: ['127.0.0.1'] }),
    'native-anthropic'
  )
  // OpenRouter oficial → Messages API; endpoints sem /messages, bloqueios e host → local
  const or = { kind: 'openrouter' as const, baseUrl: 'https://openrouter.ai/api/v1' }
  assert.deepEqual(resolveToolSearchMode(mi({ ...or, model: 'openai/gpt-5.6-luna' })), {
    mode: 'native-openrouter',
    api: 'messages'
  })
  assert.equal(
    r({ ...or, info: { endpoints: ['/api/v1/chat/completions', '/api/v1/messages'] } }),
    'native-openrouter'
  )
  const noMsg = resolveToolSearchMode(
    mi({ ...or, info: { endpoints: ['/api/v1/chat/completions'] } })
  )
  assert.equal(noMsg.mode, 'local')
  assert.equal(noMsg.api, 'chat')
  assert.match(noMsg.reason!, /não é servido pela Messages API/)
  const audio = resolveToolSearchMode(mi({ ...or, sent: { audio: true } }))
  assert.equal(audio.mode, 'local')
  assert.match(audio.reason!, /áudio/)
  assert.equal(r({ ...or, baseUrl: 'https://proxy.example.com/api/v1' }), 'local')
  // genérico → local
  const gen = resolveToolSearchMode(mi({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }))
  assert.equal(gen.mode, 'local')
  assert.match(gen.reason!, /genérico/)
  // falha lembrada (< 24 h) → local; vencida → nativa de novo
  const now = 1_800_000_000_000
  const caps = {
    [capsKey('pa', 'claude-sonnet-5-5')]: {
      mode: 'native-anthropic' as const,
      failedAt: now - 1000,
      error: 'HTTP 400: x'
    }
  }
  const failed = resolveToolSearchMode(mi({ caps, now }))
  assert.equal(failed.mode, 'local')
  assert.match(failed.reason!, /a busca nativa falhou com claude-sonnet-5-5 .*HTTP 400: x.*24 h/)
  assert.equal(failed.failure?.error, 'HTTP 400: x')
  assert.equal(r({ caps, now: now + TOOL_SEARCH_CAPS_TTL_MS }), 'native-anthropic')
  // config: compactação desligada / nada a adiar / sem tools → off; texto gerado → local
  assert.equal(r({ cfg: { ...baseCfg, toolsCompact: false } }), 'off')
  assert.equal(r({ wouldCompact: false }), 'off')
  assert.equal(r({ cfg: { ...baseCfg, nativeTools: false } }), 'off')
  assert.equal(r({ cfg: { ...baseCfg, nativeTools: false, toolsInPrompt: true } }), 'local')
  assert.equal(r({ cfg: { ...baseCfg, toolsInPrompt: true } }), 'local')
  // texto do usuário (não gerado) + nativas: as nativas decidem
  assert.equal(
    r({ cfg: { ...baseCfg, toolsInPrompt: true, toolsPromptText: 'meu' } }),
    'native-anthropic'
  )
})

test('suporte da Anthropic por modelo (tabela "Tool search tool": Claude 4.5+)', () => {
  for (const m of [
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-2',
    'claude-mythos-5-1',
    'anthropic/claude-haiku-4.5'
  ])
    assert.equal(anthropicToolSearchSupport(m), 'yes', m)
  for (const m of [
    'claude-opus-4-1',
    'claude-opus-4-1-20250805',
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-sonnet-4-0',
    'claude-3-5-sonnet-20241022',
    'claude-3-haiku-20240307'
  ])
    assert.equal(anthropicToolSearchSupport(m), 'no', m)
  assert.equal(anthropicToolSearchSupport('meu-alias'), 'unknown')
})

test('bloqueios da Messages API do OpenRouter (áudio, PDF sem leitura nativa, parâmetros, extraBody)', () => {
  const cfg = (params: Record<string, unknown>): any => ({ params })
  assert.deepEqual(messagesBlockers({ cfg: cfg({}) }), [])
  assert.match(messagesBlockers({ cfg: cfg({}), sent: { audio: true } })[0], /áudio/)
  // PDF: só bloqueia num modelo que se sabe que não lê PDF
  assert.deepEqual(messagesBlockers({ cfg: cfg({}), sent: { pdf: true } }), [])
  assert.deepEqual(
    messagesBlockers({
      cfg: cfg({}),
      sent: { pdf: true },
      info: { inputModalities: ['text', 'file'] }
    }),
    []
  )
  assert.match(
    messagesBlockers({ cfg: cfg({}), sent: { pdf: true }, info: { inputModalities: ['text'] } })[0],
    /PDF/
  )
  assert.match(
    messagesBlockers({ cfg: cfg({ seed: 1, frequency_penalty: 0.2, temperature: 1 }) })[0],
    /frequency_penalty, seed/
  )
  assert.match(
    messagesBlockers({ cfg: cfg({ extraBody: '{"reasoning":{"x":1},"provider":{}}' }) })[0],
    /extraBody .*reasoning/
  )
  assert.deepEqual(
    messagesBlockers({ cfg: cfg({ extraBody: '{"provider":{"order":["x"]}}' }) }),
    []
  )
  // mídia do histórico enviado
  assert.deepEqual(
    sentMediaOf([
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }]
      },
      {
        role: 'tool',
        tool_call_id: 'c',
        content: [
          { type: 'file', file: { filename: 'a.pdf', file_data: 'clearchat-attachment://x' } }
        ]
      }
    ] as ApiMessage[]),
    { audio: true, pdf: true }
  )
})

const defs = (names: string[]): ToolDefinition[] =>
  names.map((n) => toolDefinitionFor(n as never, []))

test('plano nativo: completas e adiadas (sem tool_search, sem prompt); local renomeado; off', () => {
  const full = defs(['read_file', 'shell', 'datetime'])
  const cfg = { toolsFull: ['read_file' as const] }
  const nat = planTools([...full, TOOL_DEFINITIONS.end_call], cfg, 'native-anthropic')
  assert.equal(nat.mode, 'native-anthropic')
  assert.deepEqual(
    nat.definitions.map((d) => d.function.name),
    ['read_file', 'shell', 'datetime', 'end_call']
  )
  assert.deepEqual(nat.deferred, ['shell', 'datetime'], 'end_call e as de toolsFull vão carregadas')
  assert.deepEqual(nat.compacted, [])
  assert.equal(nat.prompt, null)
  assert.deepEqual(nat.searchEntry, ANTHROPIC_SEARCH_TOOL)
  assert.deepEqual(planTools(full, cfg, 'native-openrouter').searchEntry, OPENROUTER_SEARCH_TOOL)
  // nada a adiar → off
  assert.equal(
    planTools(full, { toolsFull: ['read_file', 'shell', 'datetime'] }, 'native-anthropic').mode,
    'off'
  )
  // off forçado: tudo completo mesmo com a compactação ligada
  const off = planTools(full, {}, 'off')
  assert.deepEqual(off.definitions, full)
  assert.equal(off.prompt, null)
  // local: tool_search por último e o prompt fixo que a nomeia
  const loc = planTools(full, cfg, 'local')
  assert.equal(loc.definitions.at(-1)!.function.name, 'tool_search')
  assert.equal(loc.prompt, COMPACT_TOOLS_PROMPT)
  assert.ok(
    COMPACT_TOOLS_PROMPT.includes('tool_search') && !COMPACT_TOOLS_PROMPT.includes('search_tool')
  )
})

test('array tools nativo: definições completas, defer_loading, cache numa NÃO adiada, busca do servidor por último', () => {
  const full = defs(['list_dir', 'read_file', 'shell'])
  const arr = nativeToolsArray(full, {
    deferred: new Set(['list_dir', 'shell']),
    entry: { ...ANTHROPIC_SEARCH_TOOL },
    cache: true
  })
  assert.deepEqual(
    arr.map((t) => t.name),
    ['list_dir', 'read_file', 'shell', 'tool_search_tool_regex']
  )
  assert.equal(arr[0].defer_loading, true)
  assert.equal(arr[0].cache_control, undefined, 'adiada nunca leva cache_control (a API recusa)')
  assert.deepEqual(arr[1].cache_control, { type: 'ephemeral' })
  assert.equal(arr[1].defer_loading, undefined)
  assert.deepEqual(arr[1].input_schema, TOOL_DEFINITIONS.read_file.function.parameters)
  assert.deepEqual(arr.at(-1), ANTHROPIC_SEARCH_TOOL)
  // todas adiadas: nenhuma tool do app leva cache (o breakpoint do system cobre o prefixo)
  const all = nativeToolsArray(full, {
    deferred: new Set(['list_dir', 'read_file', 'shell']),
    entry: { ...OPENROUTER_SEARCH_TOOL },
    cache: true
  })
  assert.ok(all.every((t) => !t.cache_control))
  assert.deepEqual(all.at(-1), { type: 'openrouter:tool_search' })
})

// Blocos de uma resposta da busca nativa (docs "Tool search tool" — https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
const SEARCH_BLOCKS = (): Record<string, unknown>[] => [
  { type: 'thinking', thinking: 'vejamos', signature: 'sig' },
  { type: 'text', text: 'Vou ver a hora.' },
  {
    type: 'server_tool_use',
    id: 'srvtoolu_01ABC',
    name: 'tool_search_tool_regex',
    input: { pattern: 'date|time|hora' }
  },
  {
    type: 'tool_search_tool_result',
    tool_use_id: 'srvtoolu_01ABC',
    content: {
      type: 'tool_search_tool_search_result',
      tool_references: [
        { type: 'tool_reference', tool_name: 'datetime' },
        { type: 'tool_reference', tool_name: 'shell' }
      ]
    }
  },
  { type: 'tool_use', id: 'toolu_01XYZ', name: 'datetime', input: { format: '%H:%M' } }
]
const ch = { providerId: 'pa', kind: 'anthropic' as const, model: 'claude-sonnet-5-5' }
const asst = (native = nativeTurnFrom(SEARCH_BLOCKS(), ch)!): ApiMessage => ({
  role: 'assistant',
  content: 'Vou ver a hora.',
  tool_calls: [
    {
      id: 'toolu_01XYZ',
      type: 'function',
      function: { name: 'datetime', arguments: '{"format":"%H:%M"}' }
    }
  ],
  native
})

test('native: gravado só com blocos do servidor, sem pensamento, na ordem', () => {
  const n = nativeTurnFrom(SEARCH_BLOCKS(), ch)!
  assert.equal(n.v, 1)
  assert.equal(n.api, 'anthropic-messages')
  assert.deepEqual(
    n.content.map((b) => b.type),
    ['text', 'server_tool_use', 'tool_search_tool_result', 'tool_use']
  )
  // resposta comum (texto/tool_use/pensamento) → nada a gravar
  assert.equal(
    nativeTurnFrom(
      [
        { type: 'thinking', thinking: 'x' },
        { type: 'text', text: 'oi' },
        { type: 'tool_use', id: 't', name: 'x', input: {} }
      ],
      ch
    ),
    null
  )
  assert.equal(nativeTurnFrom(undefined, ch), null)
  // opaco do OpenRouter também conta
  assert.ok(
    nativeTurnFrom(
      [{ type: 'openrouter_tool_search_result', tool_use_id: 's', content: { matches: [] } }],
      { ...ch, kind: 'openrouter' }
    )
  )
})

test('reenvio: canal (provedor/API/modelo) e consistência com o texto e as tool calls', () => {
  const m = asst()
  const c = { mode: 'native-anthropic' as const, providerId: 'pa', model: 'claude-sonnet-5-5' }
  assert.ok(nativeConsistent(m))
  assert.ok(replayableNative(m, c))
  assert.equal(replayableNative(m, { ...c, model: 'claude-opus-5-5' }), false, 'outro modelo')
  assert.equal(replayableNative(m, { ...c, providerId: 'outro' }), false, 'outro provedor')
  assert.equal(replayableNative(m, { ...c, mode: 'native-openrouter' }), false, 'outra API/tipo')
  // edição do texto, dos argumentos, do id → não bate
  assert.equal(nativeConsistent({ ...m, content: 'Editado.' } as ApiMessage), false)
  const args = {
    ...m,
    tool_calls: [
      { ...(m as any).tool_calls[0], function: { name: 'datetime', arguments: '{"format":"%Y"}' } }
    ]
  }
  assert.equal(nativeConsistent(args as ApiMessage), false)
  const id = { ...m, tool_calls: [{ ...(m as any).tool_calls[0], id: 'outro' }] }
  assert.equal(nativeConsistent(id as ApiMessage), false)
  // argumentos com outra formatação (mesmo objeto) e nome antigo → bate (aliases)
  const fmt = {
    ...m,
    tool_calls: [
      {
        ...(m as any).tool_calls[0],
        function: { name: 'datetime', arguments: '{ "format" : "%H:%M" }' }
      }
    ]
  }
  assert.ok(nativeConsistent(fmt as ApiMessage))
  // quem edita tira o native que não bate (e mantém o que bate)
  assert.equal((withoutStaleNative({ ...m, content: 'x' } as ApiMessage) as any).native, undefined)
  assert.ok((withoutStaleNative(m) as any).native)
})

test('reenvio: referências filtradas às tools da request; descobertas; adiadas usadas sem descoberta vão carregadas', () => {
  const content = asst().role === 'assistant' ? (asst() as any).native.content : []
  const filtered = filterToolReferences(content, new Set(['datetime']))
  const res = filtered.find((b) => b.type === 'tool_search_tool_result') as any
  assert.deepEqual(res.content.tool_references, [{ type: 'tool_reference', tool_name: 'datetime' }])
  assert.equal((content[2] as any).content.tool_references.length, 2, 'o original não muda')
  // lista vazia é uma forma válida
  const empty = filterToolReferences(content, new Set()).find(
    (b) => b.type === 'tool_search_tool_result'
  ) as any
  assert.deepEqual(empty.content.tool_references, [])
  assert.deepEqual(discoveredByNative(content), ['datetime', 'shell'])
  // OpenRouter opaco: nomes legíveis + tool_use depois dele
  assert.deepEqual(
    discoveredByNative([
      { type: 'server_tool_use', id: 's', name: 'tool_search', input: { pattern: 'x' } },
      {
        type: 'openrouter_tool_search_result',
        tool_use_id: 's',
        content: { matches: [{ definition: { name: 'web_search' } }, { tool_id: 'browse_url' }] }
      },
      { type: 'tool_use', id: 't', name: 'shell', input: {} }
    ]),
    ['web_search', 'browse_url', 'shell']
  )
  // prepareNativeReplay: canal certo → reenviado e filtrado; outro canal → sem native
  const hist: ApiMessage[] = [
    { role: 'user', content: 'que horas?' },
    asst(),
    { role: 'tool', tool_call_id: 'toolu_01XYZ', content: '14:05' }
  ]
  const c = { mode: 'native-anthropic' as const, providerId: 'pa', model: 'claude-sonnet-5-5' }
  const ok = prepareNativeReplay(hist, c, new Set(['datetime', 'read_file']))
  assert.equal(ok.replayed, 1)
  assert.deepEqual(ok.discovered, ['datetime'])
  assert.deepEqual(forceLoadedTools(ok.messages, ['shell', 'datetime'], ok.discovered), [])
  const other = prepareNativeReplay(hist, { ...c, model: 'claude-opus-5-5' }, new Set(['datetime']))
  assert.equal(other.replayed, 0)
  assert.equal(other.skipped, 1)
  assert.equal((other.messages[1] as any).native, undefined)
  assert.deepEqual(forceLoadedTools(other.messages, ['shell', 'datetime'], other.discovered), [
    'datetime'
  ])
  // sem reenvio (repetição): idem
  assert.equal(prepareNativeReplay(hist, null, new Set()).skipped, 1)
})

test('falhas lembradas (toolSearchCaps): 24 h, vencidas saem, leitura tolerante; o que conta como recusa', () => {
  const now = 1_800_000_000_000
  let caps = withFailure(
    {},
    'p',
    'm',
    { mode: 'native-openrouter', failedAt: now, error: 'x'.repeat(500) },
    now
  )
  assert.equal(caps[capsKey('p', 'm')].error.length, 300)
  assert.ok(activeFailure(caps, 'p', 'm', now + TOOL_SEARCH_CAPS_TTL_MS - 1))
  assert.equal(activeFailure(caps, 'p', 'm', now + TOOL_SEARCH_CAPS_TTL_MS), null)
  caps = withFailure(
    caps,
    'p',
    'n',
    { mode: 'native-anthropic', failedAt: now + TOOL_SEARCH_CAPS_TTL_MS, error: '' },
    now + TOOL_SEARCH_CAPS_TTL_MS
  )
  assert.deepEqual(Object.keys(caps), [capsKey('p', 'n')], 'a vencida saiu')
  assert.deepEqual(
    normalizeToolSearchCaps({
      a: { mode: 'x', failedAt: 1 },
      b: { mode: 'native-anthropic', failedAt: 2 },
      c: null
    }),
    {
      b: { mode: 'native-anthropic', failedAt: 2, error: '' }
    }
  )
  assert.deepEqual(normalizeToolSearchCaps('lixo'), {})
  assert.ok(isNativeRejection(400, 'Erro HTTP 400: tool search not supported'))
  assert.ok(isNativeRejection(404, 'No endpoints found'))
  assert.ok(isNativeRejection(422, 'Unknown block type server_tool_use'))
  assert.equal(isNativeRejection(400, 'prompt is too long: 250000 tokens'), false)
  assert.equal(isNativeRejection(401, 'unauthorized'), false)
  assert.equal(isNativeRejection(429, 'rate'), false)
  assert.equal(isNativeRejection(500, 'x'), false)
})

test('renome search_tool → tool_search: alias de leitura, troca só na cópia, migração do banco não regrava', () => {
  assert.equal(TOOL_ALIASES.search_tool, 'tool_search')
  assert.equal(TOOL_ALIASES.bash, 'shell')
  assert.equal(wireToolName('search_tool'), 'tool_search')
  assert.equal(wireToolName('shell'), 'shell')
  // a migração única do banco (bash → shell) não toca em search_tool
  assert.equal(
    migrateMessageJson(
      JSON.stringify({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c', type: 'function', function: { name: 'search_tool', arguments: '{}' } }
        ]
      })
    ),
    null
  )
  assert.ok(
    migrateMessageJson(
      JSON.stringify({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: '{}' } }]
      })
    )
  )
})

test('transcrição: chip "buscou tools" e rótulo do rodapé; aviso da versão local', () => {
  const s = nativeSearches((asst() as any).native)
  assert.deepEqual(s, [{ query: 'date|time|hora', tools: ['datetime', 'shell'], opaque: false }])
  assert.equal(nativeSearchChip(s[0]), 'buscou tools: datetime, shell')
  const opaque = nativeSearches({
    v: 1,
    api: 'anthropic-messages',
    providerId: 'p',
    kind: 'openrouter',
    model: 'm',
    content: [
      { type: 'server_tool_use', id: 's', name: 'tool_search', input: { pattern: 'x' } },
      { type: 'openrouter_tool_search_result', tool_use_id: 's', content: { blob: 'opaco' } }
    ]
  })
  assert.equal(nativeSearchChip(opaque[0]), 'buscou tools (resultado do OpenRouter)')
  assert.equal(toolSearchMetaLabel({ mode: 'native-anthropic' }), 'busca nativa · Anthropic')
  assert.equal(
    toolSearchMetaLabel({ mode: 'local', fallbackFrom: 'native-openrouter' }),
    'tools: versão local (a busca nativa falhou)'
  )
  assert.equal(toolSearchMetaLabel({ mode: 'off' }), null)
  assert.equal(
    TOOL_SEARCH_LOCAL_NOTICE,
    'Neste endpoint a compactação não usa a busca nativa do provedor — usa a versão local do app (descrições curtas, a tool_search e uma instrução fixa).'
  )
})

// ---------------- (B) request montada ----------------

const ANTH: Provider = {
  id: 'pa',
  name: 'Anthropic',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-k',
  headers: {},
  createdAt: 0
}
const ORP: Provider = {
  id: 'po',
  name: 'OR',
  kind: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-k',
  headers: {},
  createdAt: 0
}
const mkChat = (over: Partial<Chat['config']> = {}): Chat => ({
  id: 'c1',
  title: '',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG('/work', {
      providerId: 'pa',
      model: 'claude-sonnet-5-5',
      systemPrompt: 'SYS'
    }),
    enabledTools: ['read_file', 'shell', 'datetime'],
    toolsFull: ['read_file'],
    envInPrompt: false,
    cacheEnabled: true,
    ...over
  }
})
let seq = 0
const sm = (message: ApiMessage, meta: any = {}): any => ({
  id: `m${++seq}`,
  sessionId: 's1',
  seq,
  message,
  meta,
  createdAt: 0
})
const S = { depth: 0 as const, model: 'claude-sonnet-5-5' }

test('native-anthropic: /messages, defer_loading, cache numa não adiada, busca do servidor por último, sem prompt fixo nem tool_search', () => {
  const req = buildRequest(mkChat(), S, [sm({ role: 'user', content: 'oi' })], ANTH, env)
  const b = req.body as any
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(req.api, 'messages')
  assert.equal(req.headers['x-api-key'], 'sk-ant-k')
  assert.equal(req.headers['anthropic-version'], '2023-06-01')
  assert.deepEqual(req.toolSearch, {
    mode: 'native-anthropic',
    deferred: ['shell', 'datetime'],
    forceLoaded: [],
    replayed: 0,
    skipped: 0
  })
  assert.deepEqual(
    b.tools.map((t: any) => t.name ?? t.type),
    ['read_file', 'shell', 'datetime', 'tool_search_tool_regex']
  )
  assert.deepEqual(b.tools[0].cache_control, { type: 'ephemeral' })
  assert.equal(b.tools[0].defer_loading, undefined)
  assert.equal(b.tools[1].defer_loading, true)
  assert.deepEqual(
    b.tools[1].input_schema,
    toolDefinitionFor('shell', []).function.parameters,
    'definição completa'
  )
  assert.ok(!b.tools.slice(1).some((t: any) => t.cache_control), 'cache só na carregada')
  assert.deepEqual(b.tools.at(-1), ANTHROPIC_SEARCH_TOOL)
  assert.equal(b.system[0].text, 'SYS', 'nada do app no system prompt')
  assert.ok(!JSON.stringify(b).includes(COMPACT_TOOLS_PROMPT))
  assert.ok(!b.tools.some((t: any) => t.name === 'tool_search'))
  assert.equal(b.max_tokens, 32000)
  assert.match(req.notes![0], /Busca nativa da Anthropic — 1 carregada, 2 adiadas/)
  // breakpoints: system + tool + última mensagem = no máx. 4
  const n = JSON.stringify(b).split('"cache_control"').length - 1
  assert.ok(n <= 4, `breakpoints: ${n}`)
})

test('native-openrouter: POST {base}/messages com Bearer, openrouter:tool_search, sem max_tokens padrão nem campos da Chat Completions; effort none → thinking disabled', () => {
  const chat = mkChat({ providerId: 'po', params: { reasoning_effort: 'none' } as any })
  const req = buildRequest(
    chat,
    { depth: 0, model: 'openai/gpt-5.6-luna' },
    [sm({ role: 'user', content: 'oi' })],
    ORP,
    env
  )
  const b = req.body as any
  assert.equal(req.url, 'https://openrouter.ai/api/v1/messages')
  assert.equal(req.kind, 'openrouter')
  assert.equal(req.api, 'messages')
  assert.equal(req.headers.Authorization, 'Bearer sk-or-k')
  assert.equal(req.headers['x-api-key'], undefined)
  assert.deepEqual(b.tools.at(-1), { type: 'openrouter:tool_search' })
  assert.equal(b.max_tokens, undefined)
  assert.equal(b.usage, undefined)
  assert.equal(b.stream_options, undefined)
  assert.equal(b.stream, true)
  assert.deepEqual(b.system, [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }])
  const eff = buildRequest(
    mkChat({ providerId: 'po', params: { reasoning_effort: 'medium' } as any }),
    { depth: 0, model: 'openai/gpt-5.6-luna' },
    [],
    ORP,
    env
  ).body as any
  assert.deepEqual(eff.output_config, { effort: 'medium' })
  assert.deepEqual(b.thinking, { type: 'disabled' })
  assert.equal(b.output_config, undefined)
  // max_tokens do chat vai
  const mt = buildRequest(
    mkChat({ providerId: 'po', params: { max_tokens: 500 } }),
    { depth: 0, model: 'openai/gpt-5.6-luna' },
    [],
    ORP,
    env
  ).body as any
  assert.equal(mt.max_tokens, 500)
})

test('OpenRouter na versão local: bloqueio (seed / extraBody) ou endpoints sem /messages → Chat Completions com tool_search e o motivo nas notas', () => {
  const seedChat = mkChat({ providerId: 'po', params: { seed: 7 } })
  const r = buildRequest(seedChat, { depth: 0, model: 'x/y' }, [], ORP, env)
  assert.equal(r.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(r.api, 'chat')
  assert.equal(r.toolSearch?.mode, 'local')
  assert.equal((r.body as any).tools.at(-1).function.name, 'tool_search')
  assert.match(
    r.notes![0],
    /Versão local do app — o chat precisa da Chat Completions do OpenRouter: parâmetros só da Chat Completions: seed/
  )
  setModelInfoSource((_p, m) =>
    m === 'x/y' ? { id: 'x/y', endpoints: ['/api/v1/chat/completions'] } : undefined
  )
  try {
    const e = buildRequest(
      mkChat({ providerId: 'po' }),
      { depth: 0, model: 'x/y:free' },
      [],
      ORP,
      env
    )
    assert.equal(e.toolSearch?.mode, 'local', 'variante :free cai no id base')
    assert.match(e.toolSearch!.reason!, /não é servido pela Messages API/)
  } finally {
    setModelInfoSource(() => undefined)
  }
})

/** Histórico de uma busca nativa já respondida + uma pergunta nova. */
const nativeHistory = (over: Partial<ApiMessage> = {}): any[] => [
  sm({ role: 'user', content: 'Que horas são?' }),
  sm({ ...asst(), ...over } as ApiMessage),
  sm({ role: 'tool', tool_call_id: 'toolu_01XYZ', content: '14:05' }),
  sm({ role: 'assistant', content: 'São 14:05.' }),
  sm({ role: 'user', content: 'e agora?' })
]
const assistantBlocks = (b: any): any[] =>
  b.messages.filter((m: any) => m.role === 'assistant')[0].content

test('reenvio na request: mesmo canal → blocos verbatim (referências filtradas); outro modelo/editado → conversão normal + usada carregada', () => {
  // mesmo canal: os blocos como vieram, menos a referência a uma tool fora do array tools (sem `shell`)
  const req = buildRequest(
    mkChat({ enabledTools: ['read_file', 'datetime'] }),
    S,
    nativeHistory(),
    ANTH,
    env
  )
  const b = req.body as any
  const blocks = assistantBlocks(b)
  assert.deepEqual(
    blocks.map((x: any) => x.type),
    ['text', 'server_tool_use', 'tool_search_tool_result', 'tool_use']
  )
  assert.deepEqual(blocks[2].content.tool_references, [
    { type: 'tool_reference', tool_name: 'datetime' }
  ])
  assert.ok(!blocks.some((x: any) => x.cache_control), 'sem cache_control nos blocos reenviados')
  assert.equal(req.toolSearch!.replayed, 1)
  assert.deepEqual(req.toolSearch!.forceLoaded, [])
  assert.equal(b.tools.find((t: any) => t.name === 'datetime').defer_loading, true)
  // nunca um tool_result para o srvtoolu
  assert.ok(!JSON.stringify(b.messages).includes('"tool_use_id":"srvtoolu_01ABC","content":"'))
  // outro modelo: conversão normal, datetime (usada sem a descoberta junto) vai carregada
  const other = buildRequest(
    mkChat(),
    { depth: 0, model: 'claude-opus-5-5' },
    nativeHistory(),
    ANTH,
    env
  )
  const ob = other.body as any
  assert.deepEqual(
    assistantBlocks(ob).map((x: any) => x.type),
    ['text', 'tool_use']
  )
  assert.deepEqual(other.toolSearch!.forceLoaded, ['datetime'])
  assert.equal(ob.tools.find((t: any) => t.name === 'datetime').defer_loading, undefined)
  assert.equal(ob.tools.find((t: any) => t.name === 'shell').defer_loading, true)
  assert.match(
    other.notes!.join('\n'),
    /Carregadas por já terem sido usadas sem a busca no histórico enviado: datetime/
  )
  // editada (texto mudou): conversão normal
  const edited = buildRequest(mkChat(), S, nativeHistory({ content: 'Editado.' } as any), ANTH, env)
  assert.deepEqual(
    assistantBlocks(edited.body).map((x: any) => x.type),
    ['text', 'tool_use']
  )
  assert.equal(edited.toolSearch!.skipped, 1)
  // outro provedor (OpenRouter Messages com o mesmo modelo): nunca reenvia blocos de outro canal
  const or = buildRequest(
    mkChat({ providerId: 'po' }),
    { depth: 0, model: 'claude-sonnet-5-5' },
    nativeHistory(),
    ORP,
    env
  )
  assert.deepEqual(
    assistantBlocks(or.body).map((x: any) => x.type),
    ['text', 'tool_use']
  )
})

test('reenvio: compactação desligada / Chat Completions / modo local → nenhum bloco do servidor no fio', () => {
  const off = buildRequest(mkChat({ toolsCompact: false }), S, nativeHistory(), ANTH, env)
  assert.equal(off.toolSearch!.mode, 'off')
  assert.ok(!JSON.stringify(off.body).includes('server_tool_use'))
  assert.ok(!JSON.stringify(off.body).includes('defer_loading'))
  const cc = buildRequest(
    mkChat({ providerId: 'po', params: { seed: 1 } }),
    S,
    nativeHistory(),
    ORP,
    env
  )
  assert.ok(!JSON.stringify(cc.body).includes('server_tool_use'))
  assert.ok(!JSON.stringify(cc.body).includes('"native"'), 'native nunca vai na Chat Completions')
  const loc = buildRequest(
    mkChat(),
    { depth: 0, model: 'claude-opus-4-1' },
    nativeHistory(),
    ANTH,
    env
  )
  assert.equal(loc.toolSearch!.mode, 'local')
  assert.ok(!JSON.stringify(loc.body).includes('server_tool_use'))
})

test('reenvio: noReplay / replay:false e o modo forçado (queda) na request', () => {
  const h = nativeHistory()
  const nr = buildRequest(mkChat(), S, h, ANTH, env, { noReplay: new Set([h[1].id]) })
  assert.equal(nr.toolSearch!.replayed, 0)
  assert.deepEqual(nr.toolSearch!.forceLoaded, ['datetime'])
  const r0 = buildRequest(mkChat(), S, h, ANTH, env, { replay: false })
  assert.equal(r0.toolSearch!.replayed, 0)
  const loc = buildRequest(mkChat(), S, h, ANTH, env, { modeOverride: 'local' })
  assert.equal(loc.toolSearch!.mode, 'local')
  assert.equal((loc.body as any).tools.at(-1).name, 'tool_search')
  assert.ok((loc.body as any).system[0].text.endsWith(COMPACT_TOOLS_PROMPT))
})

test('turno pausado (pause_turn): o assistente com native no fim vai como está; cache no último bloco cacheável', () => {
  const paused = nativeTurnFrom(
    [
      { type: 'text', text: 'Procurando…' },
      {
        type: 'server_tool_use',
        id: 'srvtoolu_P',
        name: 'tool_search_tool_regex',
        input: { pattern: 'x' }
      }
    ],
    ch
  )!
  const h = [
    sm({ role: 'user', content: 'oi' }),
    sm({ role: 'assistant', content: 'Procurando…', native: paused })
  ]
  const b = buildRequest(mkChat(), S, h, ANTH, env).body as any
  const last = b.messages.at(-1)
  assert.equal(last.role, 'assistant')
  assert.equal(last.content.at(-1).type, 'server_tool_use')
  assert.equal(last.content.at(-1).cache_control, undefined)
  assert.deepEqual(last.content[0].cache_control, { type: 'ephemeral' })
})

test('compactação: full reenvia; trimmed que encurta a resposta descarta; repetição com tool_choice none vai sem adiar nada', () => {
  const long = 'x'.repeat(9000)
  const h = [
    sm({ role: 'user', content: 'Que horas são?' }),
    sm({
      ...asst(nativeTurnFrom([{ type: 'text', text: long }, ...SEARCH_BLOCKS().slice(2)], ch)!),
      content: long
    } as ApiMessage),
    sm({ role: 'tool', tool_call_id: 'toolu_01XYZ', content: '14:05' }),
    sm({ role: 'assistant', content: 'São 14:05.' })
  ]
  const opts = { mode: 'full' as const, window: 200000 }
  const full = buildCompactionRequest(mkChat(), { id: 's1', ...S }, h, ANTH, 'Resuma.', opts, env)
  assert.equal(full.toolSearch!.replayed, 1)
  const trimmed = buildCompactionRequest(
    mkChat(),
    { id: 's1', ...S },
    h,
    ANTH,
    'Resuma.',
    { ...opts, mode: 'trimmed' },
    env
  )
  assert.equal(trimmed.toolSearch!.replayed, 0)
  assert.equal(trimmed.toolSearch!.skipped, 1)
  const none = buildCompactionRequest(
    mkChat(),
    { id: 's1', ...S },
    h,
    ANTH,
    'Resuma.',
    { ...opts, toolChoiceNone: true },
    env
  )
  const nb = none.body as any
  assert.equal(none.toolSearch!.mode, 'off')
  assert.deepEqual(nb.tool_choice, { type: 'none' })
  assert.ok(!JSON.stringify(nb).includes('defer_loading'))
  assert.ok(!JSON.stringify(nb).includes('tool_search_tool_regex'))
  // estimativa pós-compactação: nos nativos só as carregadas + a entrada de busca
  const nat = compactionMeta(mkChat(), { depth: 0 }, h, 'R', 5, env, 'native-anthropic')
  const loc = compactionMeta(mkChat({ toolsCompact: false }), { depth: 0 }, h, 'R', 5, env, 'off')
  assert.ok(
    nat.contextEstimate < loc.contextEstimate,
    `${nat.contextEstimate} < ${loc.contextEstimate}`
  )
})

// ---------------- (C) SSE ----------------

/** Eventos do streaming da busca nativa (docs "Tool search tool" → Streaming; Messages API). */
function searchStream(opts: { cost?: number; orResult?: boolean } = {}): any[] {
  const result = opts.orResult
    ? {
        type: 'openrouter_tool_search_result',
        tool_use_id: 'srvtoolu_xyz789',
        content: { matches: [{ definition: { name: 'datetime' } }] }
      }
    : {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_xyz789',
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: [{ type: 'tool_reference', tool_name: 'datetime' }]
        }
      }
  return [
    {
      type: 'message_start',
      message: { model: 'claude-haiku-4-5', usage: { input_tokens: 50, output_tokens: 1 } }
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Vou ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ver.' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'server_tool_use',
        id: 'srvtoolu_xyz789',
        name: 'tool_search_tool_regex'
      }
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"pattern":' }
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"time"}' }
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: result },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'datetime', input: {} }
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'input_json_delta', partial_json: '{"format":"%H"}' }
    },
    { type: 'content_block_stop', index: 3 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 30, ...(opts.cost != null ? { cost: opts.cost } : {}) }
    },
    { type: 'message_stop' }
  ]
}

test('SSE: server_tool_use / tool_search_tool_result / tool_use → blocos completos; só o datetime vira tool call', () => {
  const acc = newAccumulator()
  for (const e of searchStream()) applyAnthropicEvent(acc, e)
  assert.equal(acc.content, 'Vou ver.')
  assert.deepEqual(acc.toolCalls, [
    { id: 'toolu_1', name: 'datetime', arguments: '{"format":"%H"}' }
  ])
  assert.deepEqual(
    acc.blocks!.map((b) => b.type),
    ['text', 'server_tool_use', 'tool_search_tool_result', 'tool_use']
  )
  assert.deepEqual(acc.blocks![0], { type: 'text', text: 'Vou ver.' })
  assert.deepEqual(acc.blocks![1].input, { pattern: 'time' })
  assert.deepEqual(acc.blocks![3].input, { format: '%H' })
  assert.equal(acc.finishReason, 'tool_calls')
  const n = nativeTurnFrom(acc.blocks, ch)!
  // o que foi gravado bate com a forma canônica (o reenvio vale)
  const m: ApiMessage = {
    role: 'assistant',
    content: acc.content,
    tool_calls: acc.toolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: t.arguments }
    })),
    native: n
  }
  assert.ok(nativeConsistent(m))
})

test('SSE (OpenRouter Messages): openrouter_tool_search_result opaco e usage.cost no message_delta; sem cost → sem custo', () => {
  const acc = newAccumulator()
  for (const e of searchStream({ cost: 0.0042, orResult: true })) applyAnthropicEvent(acc, e)
  assert.equal(acc.usage!.cost, 0.0042)
  assert.deepEqual(acc.blocks![2].content, { matches: [{ definition: { name: 'datetime' } }] })
  const a2 = newAccumulator()
  for (const e of searchStream()) applyAnthropicEvent(a2, e)
  assert.equal(a2.usage!.cost, undefined)
  // resposta não-stream (provedor ignorou stream:true): os blocos vêm inteiros
  const a3 = newAccumulator()
  applyAnthropicMessage(a3, {
    type: 'message',
    content: SEARCH_BLOCKS().slice(1),
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 2, cost: 0.1 }
  })
  assert.deepEqual(
    a3.blocks!.map((b) => b.type),
    ['text', 'server_tool_use', 'tool_search_tool_result', 'tool_use']
  )
  assert.equal(a3.usage!.cost, 0.1)
})

test('custo pelo GET /generation: espera o 404 inicial, lê total_cost; erro → null', async () => {
  let calls = 0
  const fake = (async (url: string, init: any) => {
    calls++
    assert.equal(url, 'https://openrouter.ai/api/v1/generation?id=gen-1')
    assert.equal(init.headers.Authorization, 'Bearer k')
    if (calls === 1) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify({ data: { total_cost: 0.0123 } }), { status: 200 })
  }) as unknown as typeof fetch
  assert.equal(
    await fetchGenerationCost(
      'https://openrouter.ai/api/v1/',
      { Authorization: 'Bearer k' },
      'gen-1',
      { waits: [0, 0], fetchImpl: fake }
    ),
    0.0123
  )
  assert.equal(calls, 2)
  const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch
  assert.equal(
    await fetchGenerationCost('https://x', {}, 'g', { waits: [0], fetchImpl: bad }),
    null
  )
})

// ---------------- (D) runner + provedores falsos ----------------

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

let server: Server
let base = ''
/** Requests recebidas: url, headers e body. */
const hits: { url: string; auth: string; key: string; body: any }[] = []
/** Comportamento do provedor falso por teste. */
let behavior: {
  rejectDefer?: boolean
  rejectAll?: boolean
  rejectReplay?: boolean
  noCost?: boolean
} = {}

async function readBody(req: IncomingMessage): Promise<string> {
  let d = ''
  for await (const c of req) d += c
  return d
}
const sseOf = (events: any[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
const textOfContent = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''

function finalText(model: string, text: string, cost?: number): any[] {
  return [
    { type: 'message_start', message: { model, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3, ...(cost != null ? { cost } : {}) }
    },
    { type: 'message_stop' }
  ]
}

before(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.includes('/generation')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: { total_cost: 0.0077 } }))
        return
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
        return
      }
      const body = JSON.parse((await readBody(req)) || '{}')
      hits.push({
        url,
        auth: String(req.headers.authorization ?? ''),
        key: String(req.headers['x-api-key'] ?? ''),
        body
      })
      const raw = JSON.stringify(body)
      const err = (msg: string): void => {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } })
        )
      }
      if (behavior.rejectAll) return err('extraBody inválido (simulado)')
      if (behavior.rejectDefer && raw.includes('defer_loading'))
        return err('tool search is not supported for this model (simulado)')
      if (
        behavior.rejectReplay &&
        raw.includes('"server_tool_use"') &&
        body.messages.some(
          (m: any) =>
            m.role === 'assistant' && m.content.some((c: any) => c.type === 'server_tool_use')
        )
      )
        return err('Tool reference not found (simulado)')
      const msgs: any[] = body.messages ?? []
      const last = msgs.at(-1)
      const isOr = url.startsWith('/api/v1/')
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        ...(isOr ? { 'x-generation-id': `gen-${hits.length}` } : {})
      })
      const cost = isOr && !behavior.noCost ? 0.001 : undefined
      // continuação de um turno pausado: o último é o assistente (termina em server_tool_use)
      if (last?.role === 'assistant')
        return void res.end(sseOf(finalText(body.model, 'RETOMADO', cost)))
      const lastText = textOfContent(last?.content)
      if (last?.role === 'user' && last.content.some((c: any) => c.type === 'tool_result'))
        return void res.end(sseOf(finalText(body.model, 'FIM', cost)))
      if (lastText === 'pausa') {
        return void res.end(
          sseOf([
            {
              type: 'message_start',
              message: { model: body.model, usage: { input_tokens: 10, output_tokens: 1 } }
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'server_tool_use',
                id: 'srvtoolu_P',
                name: 'tool_search_tool_regex',
                input: {}
              }
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"pattern":"x"}' }
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'pause_turn' },
              usage: { output_tokens: 2 }
            },
            { type: 'message_stop' }
          ])
        )
      }
      if (lastText === 'busca-local')
        return void res.end(
          sseOf([
            { type: 'message_start', message: { model: body.model, usage: {} } },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_ts', name: 'tool_search', input: {} }
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"names":["shell"]}' }
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 2 }
            },
            { type: 'message_stop' }
          ])
        )
      if (lastText === 'hora') {
        const native = raw.includes('defer_loading')
        if (!native)
          // versão local: chama o datetime direto (compacta)
          return void res.end(
            sseOf([
              { type: 'message_start', message: { model: body.model, usage: {} } },
              {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: `toolu_l${hits.length}`,
                  name: 'datetime',
                  input: {}
                }
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: '{"format":"%Y"}' }
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 2 }
              },
              { type: 'message_stop' }
            ])
          )
        const ev = searchStream({ cost, orResult: isOr && !body.model.startsWith('claude') }).map(
          (e) =>
            e.type === 'content_block_start' && e.content_block.type === 'tool_use'
              ? { ...e, content_block: { ...e.content_block, id: `toolu_${hits.length}` } }
              : e.type === 'content_block_delta' && e.index === 3
                ? { ...e, delta: { type: 'input_json_delta', partial_json: '{"format":"%Y"}' } }
                : e
        )
        return void res.end(sseOf(ev))
      }
      res.end(sseOf(finalText(body.model, 'ok', cost)))
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  setNativeTestHosts(['127.0.0.1'])
})

after(() => {
  server?.close()
  rmSync(TMP, { recursive: true, force: true })
})

type Mods = {
  runner: typeof import('../src/main/agent/runner.ts')
  repo: typeof import('../src/main/repo.ts')
  caps: typeof import('../src/main/toolSearchCaps.ts')
}
let mods: Mods | null = null
async function load(): Promise<Mods> {
  if (mods) return mods
  mods = {
    runner: await import('../src/main/agent/runner.ts'),
    repo: await import('../src/main/repo.ts'),
    caps: await import('../src/main/toolSearchCaps.ts')
  }
  return mods
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(
  fn: () => T | null | undefined | false,
  what: string,
  ms = 8000
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`)
    await sleep(25)
  }
}
async function newChat(
  kind: 'anthropic' | 'openrouter',
  model: string,
  over: Record<string, unknown> = {}
): Promise<string> {
  const { repo } = await load()
  const p = repo.providersRepo.create({
    name: `Falso ${kind}`,
    kind,
    baseUrl: kind === 'anthropic' ? `${base}/v1` : `${base}/api/v1`,
    apiKey: kind === 'anthropic' ? 'sk-ant-falsa' : 'sk-or-falsa',
    headers: {}
  } as any)
  const { session } = repo.chatsRepo.create({
    config: {
      providerId: p.id,
      model,
      cwd: TMP,
      enabledTools: ['read_file', 'shell', 'datetime'],
      toolsFull: ['read_file'],
      ...over
    } as any
  })
  return session.id
}
async function turn(sid: string, text: string): Promise<any[]> {
  const { repo, runner } = await load()
  runner.send(sid, text)
  await waitFor(
    () =>
      !runner.isRunning(sid) &&
      ['idle', 'error'].includes(repo.sessionsRepo.get(sid)!.status) &&
      repo.sessionsRepo.get(sid),
    `fim do turno (${text})`
  )
  return repo.messagesRepo.path(sid)
}

test('runner native-anthropic: busca do servidor, native gravado, 2ª request com os MESMOS tools e os blocos reenviados (sem tool_result do srvtoolu)', async () => {
  setToolSearchCapsSource((await load()).caps.getToolSearchCaps)
  behavior = {}
  const sid = await newChat('anthropic', 'claude-haiku-4-5')
  const n0 = hits.length
  const msgs = await turn(sid, 'hora')
  const reqs = hits.slice(n0)
  assert.equal(reqs.length, 2, 'busca + tool_use → resultado → FIM')
  assert.equal(reqs[0].url, '/v1/messages')
  assert.equal(reqs[0].key, 'sk-ant-falsa')
  assert.equal(
    JSON.stringify(reqs[1].body.tools),
    JSON.stringify(reqs[0].body.tools),
    'tools byte a byte iguais'
  )
  const a = msgs.find((m) => m.message.role === 'assistant' && m.message.tool_calls)
  assert.ok(a.message.native, 'native gravado')
  assert.deepEqual(
    a.message.native.content.map((b: any) => b.type),
    ['text', 'server_tool_use', 'tool_search_tool_result', 'tool_use']
  )
  assert.deepEqual(a.meta.toolSearch, { mode: 'native-anthropic' })
  const sentAsst = reqs[1].body.messages.find((m: any) => m.role === 'assistant')
  assert.deepEqual(sentAsst.content, a.message.native.content, 'os blocos como vieram')
  assert.ok(
    !JSON.stringify(reqs[1].body).includes('"tool_use_id":"srvtoolu_xyz789","content":"'),
    'nenhum tool_result do srvtoolu'
  )
  const tool = msgs.find((m) => m.message.role === 'tool')
  assert.equal(tool.meta.toolStatus, 'ok')
  // a resposta final (sem blocos do servidor) não grava native
  const fin = msgs.at(-1)
  assert.equal(fin.message.content, 'FIM')
  assert.equal(fin.message.native, undefined)
})

test('runner native-openrouter: POST /api/v1/messages com Bearer; custo pelo /generation quando o stream não traz', async () => {
  behavior = { noCost: true }
  const sid = await newChat('openrouter', 'openai/gpt-5.6-luna')
  const n0 = hits.length
  const msgs = await turn(sid, 'hora')
  const r = hits[n0]
  assert.equal(r.url, '/api/v1/messages')
  assert.equal(r.auth, 'Bearer sk-or-falsa')
  assert.deepEqual(r.body.tools.at(-1), { type: 'openrouter:tool_search' })
  const a = msgs.find((m) => m.message.role === 'assistant' && m.message.tool_calls)
  assert.ok(a.message.native.content.some((b: any) => b.type === 'openrouter_tool_search_result'))
  assert.equal(a.message.native.kind, 'openrouter')
  const { repo } = await load()
  await waitFor(
    () => repo.messagesRepo.get(a.id)?.meta.usage?.cost === 0.0077,
    'custo do /generation',
    12000
  )
  behavior = {}
})

test('runner: tool_search não existe nos modos nativos (chamada vinda do histórico → indisponível)', async () => {
  behavior = {}
  const sid = await newChat('anthropic', 'claude-haiku-4-5')
  await turn(sid, 'oi') // registra o modo da sessão
  const msgs = await turn(sid, 'busca-local')
  const tool = msgs.filter((m) => m.message.role === 'tool').at(-1)
  assert.equal(tool.meta.toolStatus, 'error')
  assert.match(textOfContent(tool.message.content), /"tool_search" não está disponível/)
})

test('runner: queda para a versão local quando o provedor recusa o nativo — repetição local, falha lembrada 24 h, meta com fallbackFrom; próximo turno direto na local', async () => {
  const { repo } = await load()
  behavior = { rejectDefer: true }
  const sid = await newChat('anthropic', 'claude-sonnet-5-5')
  const n0 = hits.length
  const msgs = await turn(sid, 'hora')
  const reqs = hits.slice(n0)
  assert.ok(JSON.stringify(reqs[0].body).includes('defer_loading'), '1ª: nativa')
  assert.ok(!JSON.stringify(reqs[1].body).includes('defer_loading'), '2ª: local')
  assert.equal(reqs[1].body.tools.at(-1).name, 'tool_search')
  const a = msgs.find((m) => m.message.role === 'assistant' && m.message.tool_calls)
  assert.equal(a.meta.toolSearch.mode, 'local')
  assert.equal(a.meta.toolSearch.fallbackFrom, 'native-anthropic')
  assert.match(a.meta.toolSearch.reason, /recusada: HTTP 400/)
  assert.equal(a.message.native, undefined)
  const chat = repo.chatsRepo.get(repo.sessionsRepo.get(sid)!.chatId)!
  const caps = repo.settingsRepo.get<any>('toolSearchCaps')
  const f = caps[capsKey(chat.config.providerId, 'claude-sonnet-5-5')]
  assert.equal(f.mode, 'native-anthropic')
  assert.match(f.error, /tool search is not supported/)
  // próximo turno: direto na local (nenhuma request com defer_loading)
  const n1 = hits.length
  await turn(sid, 'oi de novo')
  assert.ok(hits.slice(n1).every((h) => !JSON.stringify(h.body).includes('defer_loading')))
  behavior = {}
})

test('runner: erro que também acontece na local NÃO é lembrado (é do pedido)', async () => {
  const { repo } = await load()
  behavior = { rejectAll: true }
  const sid = await newChat('anthropic', 'claude-opus-5-5')
  const msgs = await turn(sid, 'hora')
  assert.equal(repo.sessionsRepo.get(sid)!.status, 'error')
  assert.ok(msgs.some((m) => m.meta.kind === 'error'))
  const chat = repo.chatsRepo.get(repo.sessionsRepo.get(sid)!.chatId)!
  const caps = repo.settingsRepo.get<any>('toolSearchCaps') ?? {}
  assert.equal(caps[capsKey(chat.config.providerId, 'claude-opus-5-5')], undefined)
  behavior = {}
})

test('runner: reenvio recusado → repete sem reenviar (mesmo modo nativo, nada lembrado); a mensagem não é mais reenviada na sessão', async () => {
  const { repo } = await load()
  behavior = {}
  const sid = await newChat('anthropic', 'claude-haiku-5-5')
  await turn(sid, 'hora') // grava native
  behavior = { rejectReplay: true }
  const n0 = hits.length
  const msgs = await turn(sid, 'e agora?')
  const reqs = hits.slice(n0)
  assert.equal(reqs.length, 2)
  assert.ok(JSON.stringify(reqs[0].body.messages).includes('server_tool_use'), '1ª reenviou')
  assert.ok(!JSON.stringify(reqs[1].body.messages).includes('server_tool_use'), '2ª sem reenvio')
  assert.ok(JSON.stringify(reqs[1].body).includes('defer_loading'), 'continua nativa')
  assert.deepEqual(msgs.at(-1).meta.toolSearch, { mode: 'native-anthropic' })
  const chat = repo.chatsRepo.get(repo.sessionsRepo.get(sid)!.chatId)!
  const caps = repo.settingsRepo.get<any>('toolSearchCaps') ?? {}
  assert.equal(caps[capsKey(chat.config.providerId, 'claude-haiku-5-5')], undefined)
  const n1 = hits.length
  behavior = {}
  await turn(sid, 'mais uma')
  assert.ok(
    !JSON.stringify(hits[n1].body.messages).includes('server_tool_use'),
    'não reenvia mais na sessão'
  )
})

test('runner: pause_turn → nova request sem mensagem do usuário, terminando no assistente pausado', async () => {
  behavior = {}
  const sid = await newChat('anthropic', 'claude-haiku-4-5')
  const n0 = hits.length
  const msgs = await turn(sid, 'pausa')
  const reqs = hits.slice(n0)
  assert.equal(reqs.length, 2)
  const last = reqs[1].body.messages.at(-1)
  assert.equal(last.role, 'assistant')
  assert.equal(last.content.at(-1).type, 'server_tool_use')
  const paused = msgs.find((m) => m.message.role === 'assistant' && m.message.native)
  assert.ok(paused, 'turno pausado gravado com native')
  assert.equal(msgs.at(-1).message.content, 'RETOMADO')
})
