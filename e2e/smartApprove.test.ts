/* eslint-disable @typescript-eslint/no-explicit-any */
// Smart-Approve (sem Electron): parse da resposta do juiz, template, ordem de decisão, chamada ao
// juiz contra um servidor HTTP local (aprovar/rejeitar/perguntar/ambíguo/erro/timeout — nunca
// libera por falha), liberação de uma vez só e inclusão nos campos de persona.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { approvalRoute, evaluateLists, smartListPlan } from '../src/shared/approvalPolicy.ts'
import {
  JUDGE_CONTEXT_LIMITS,
  buildJudgeExtras,
  relevantWhitelist
} from '../src/shared/smartApproveContext.ts'
import { approvalOutcome } from '../src/renderer/src/lib/approvalOutcome.ts'
import { normalizeSmartDefaults } from '../src/shared/smartDefaults.ts'
import {
  argsKey,
  buildJudgeBody,
  buildJudgeMessages,
  effectiveJudgeMaxTokens,
  judgeVars,
  lastUserMessage,
  mapJudgeDecision,
  normalizeSmartApprove,
  overrideMessageText,
  parseJudgeOutput,
  recentContext,
  renderSmartTemplate,
  SMART_CATEGORY_KEYS,
  smartApproveActive,
  smartRejectText,
  validateLabels
} from '../src/shared/smartApprove.ts'
import {
  DEFAULT_SMART_APPROVE_PROMPT,
  DEFAULT_SMART_APPROVE_TEMPLATE
} from '../src/shared/defaults.ts'
import {
  PRESET_FIELDS,
  applyPreset,
  sanitizePresetConfig,
  snapshotPreset
} from '../src/shared/presets.ts'
import { DEFAULT_CHAT_CONFIG } from '../src/shared/defaults.ts'
import {
  OVERRIDE_TTL_MS,
  addOverride,
  clearOverrides,
  runJudge,
  takeOverride
} from '../src/main/agent/smartApprove.ts'
import type {
  Provider,
  SmartApproveConfig,
  SmartApproveRecord,
  StoredMessage
} from '../src/shared/types.ts'

// ---------------- parse ----------------

test('parse: variantes aceitas (markdown, caixa, prefixo, aspas, <think>)', () => {
  const cases: [string, string, string][] = [
    ['APPROVED\nLista arquivos na raiz.', 'approve', 'Lista arquivos na raiz.'],
    ['**APPROVED** — seguro', 'approve', 'seguro'],
    ['approved: tudo certo', 'approve', 'tudo certo'],
    ['Decision: REJECTED\nApaga a home.', 'reject', 'Apaga a home.'],
    ['Veredito — REJECTED: fora da raiz', 'reject', 'fora da raiz'],
    ['`ASK-USER`\nNão sei.', 'ask', 'Não sei.'],
    ['\n\n   APPROVED   \n\n  ok  ', 'approve', 'ok'],
    ['## REJECTED\n- exfiltra ~/.ssh', 'reject', 'exfiltra ~/.ssh'],
    ['"APPROVED" ok', 'approve', 'ok'],
    ['[ASK-USER] talvez', 'ask', 'talvez'],
    ['<think>REJECTED? hmm, APPROVED</think>\nAPPROVED\nok', 'approve', 'ok'],
    ['APPROVED\nthe user approved this earlier', 'approve', 'the user approved this earlier'],
    ['APPROVED', 'approve', '']
  ]
  for (const [raw, decision, reason] of cases) {
    const r = parseJudgeOutput(raw)
    assert.equal(r.decision, decision, raw)
    assert.equal(r.reason, reason, raw)
  }
})

test('parse: ambíguo / sem rótulo / vazio → sem decisão (perguntar)', () => {
  const cases: [string, string][] = [
    ['', 'empty'],
    ['   \n  ', 'empty'],
    ['This should not be APPROVED', 'no-label'],
    ['I think it is fine.\nAPPROVED', 'no-label'],
    ['ASK', 'no-label'],
    ['ASK-USERS please', 'no-label'],
    ['APPROVED_NOW', 'no-label'],
    ['APPROVEDX', 'no-label'],
    ['APPROVED or REJECTED', 'multiple'],
    ['APPROVED (not rejected)', 'multiple'],
    ['APPROVED\nActually REJECTED, it deletes files', 'multiple'],
    ['REJECTED\nASK-USER would also work', 'multiple']
  ]
  for (const [raw, problem] of cases) {
    const r = parseJudgeOutput(raw)
    assert.equal(r.decision, null, raw)
    assert.equal(r.problem, problem, raw)
  }
})

test('parse: rótulos personalizados (inclusive com caracteres de regex)', () => {
  const labels = { approve: 'SIM', reject: 'NÃO', ask: 'TALVEZ?' }
  assert.equal(parseJudgeOutput('sim\nok', labels).decision, 'approve')
  assert.equal(parseJudgeOutput('Não — perigoso', labels).decision, 'reject')
  assert.equal(parseJudgeOutput('TALVEZ? depende', labels).decision, 'ask')
  assert.equal(parseJudgeOutput('APPROVED', labels).decision, null) // rótulo padrão não vale
  // inválidos (duplicados) → padrão
  assert.equal(
    parseJudgeOutput('APPROVED', { approve: 'X', reject: 'x', ask: 'Y' }).decision,
    'approve'
  )
})

test('validateLabels / normalizeSmartApprove', () => {
  assert.equal(validateLabels({ approve: 'A', reject: 'B', ask: 'C' }), null)
  assert.match(validateLabels({ approve: '', reject: 'B', ask: 'C' })!, /obrigatórios/)
  assert.match(validateLabels({ approve: 'ok', reject: 'OK', ask: 'C' })!, /diferentes/)
  assert.match(validateLabels({ approve: 'a\nb', reject: 'B', ask: 'C' })!, /quebra/)
  const d = normalizeSmartApprove(undefined)
  assert.deepEqual(d, {
    providerId: null,
    model: null,
    prompt: null,
    template: null,
    labels: { approve: 'APPROVED', reject: 'REJECTED', ask: 'ASK-USER' },
    contextMessages: 6,
    timeoutS: 30,
    canDeny: false,
    judgeWhitelisted: false
  })
  const n = normalizeSmartApprove({
    enabled: true,
    providerId: 'p',
    model: ' m ',
    labels: { approve: ' SIM ', reject: 'NAO', ask: 'TALVEZ' },
    contextMessages: 999,
    timeoutS: 1,
    tools: ['shell', 'shell', 'write_file']
  })
  assert.equal(n.model, 'm')
  assert.deepEqual(n.labels, { approve: 'SIM', reject: 'NAO', ask: 'TALVEZ' })
  assert.equal(n.contextMessages, 50)
  assert.equal(n.timeoutS, 3)
  // chaves legadas (≤ 0.4.0: enabled, tools) não entram — viraram modos por item
  assert.equal('enabled' in n, false)
  assert.equal('tools' in n, false)
  // sem liga/desliga: pronto = provedor + modelo
  assert.equal(smartApproveActive(n), true)
  assert.equal(smartApproveActive({ ...n, model: null }), false)
  assert.equal(smartApproveActive({ ...n, providerId: null }), false)
  assert.equal(smartApproveActive({ ...n, enabled: false } as any), true)
})

// ---------------- template ----------------

let seq = 0
const sm = (message: any, meta: any = {}): StoredMessage => ({
  id: String(++seq),
  sessionId: 's',
  seq,
  message,
  meta,
  createdAt: 0
})

test('template: placeholders, desconhecidos intactos, sem reexpansão', () => {
  const out = renderSmartTemplate('t={{tool}} a={{ args }} x={{nada}} {{TOOL}}', {
    tool: '{{args}}',
    args: 'A'
  })
  assert.equal(out, 't={{args}} a=A x={{nada}} {{args}}')
})

test('mensagens do juiz: system + user renderizados com contexto compacto', () => {
  const sa = normalizeSmartApprove({
    providerId: 'p',
    model: 'j',
    contextMessages: 3
  })
  const long = 'x'.repeat(2000)
  const history = [
    sm({ role: 'user', content: 'mensagem antiga' }),
    sm({ role: 'user', content: 'Liste os arquivos, por favor.' }),
    sm({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }
      ]
    }),
    sm({ role: 'tool', tool_call_id: 'c1', content: long }, { toolStatus: 'ok' }),
    sm({ role: 'assistant', content: 'erro', tool_calls: undefined }, { kind: 'error' }),
    sm({
      role: 'assistant',
      content: 'Vou listar.',
      tool_calls: [
        {
          id: 'c2',
          type: 'function',
          function: { name: 'shell', arguments: '{"command":"ls -la"}' }
        }
      ]
    })
  ]
  const msgs = buildJudgeMessages(sa, {
    tool: 'shell',
    args: { command: 'ls -la' },
    cwd: '/work',
    confine: true,
    sandbox: false,
    history
  })
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'system')
  // sem "O juiz pode negar": o rótulo de rejeitar não é oferecido
  assert.ok(msgs[0].content.includes('(APPROVED | ASK-USER)'))
  assert.ok(!msgs[0].content.includes('REJECTED'))
  assert.ok(!msgs[0].content.includes('{{'), 'system sem placeholders')
  const u = msgs[1].content
  assert.ok(!u.includes('{{'), 'user sem placeholders')
  assert.ok(u.includes('tool: shell'))
  assert.ok(u.includes('{\n  "command": "ls -la"\n}'), 'args em JSON formatado')
  assert.ok(u.includes('Project root (cwd): /work'))
  assert.ok(u.includes('File tools confined to the root: yes'))
  assert.ok(u.includes('Shell sandboxed (only the root is writable): no'))
  // objetivo: mensagens digitadas, a mais recente primeiro
  assert.ok(u.includes('[1] Liste os arquivos, por favor.\n[2] mensagem antiga'))
  // atividade: só chamadas com resultado (a pendente c2 fica de fora); a fala do agente não vai
  // (0.8.5: pode repetir saída de tool — defesa contra prompt injection)
  assert.ok(
    u.includes(
      "Agent's recent tool calls (oldest first; outputs are never shown):\n- [ok] read_file: a\n"
    )
  )
  assert.ok(!u.includes('- [ok] shell'))
  assert.ok(!u.includes("Agent's latest message"))
  assert.ok(!u.includes('Vou listar.'))
  assert.ok(!u.includes('Caller: a SUBAGENT'), 'principal: sem seção de subagente')
  assert.ok(!u.includes('erro'))
  // {{recent_context}} continua disponível para templates personalizados
  const custom = buildJudgeMessages(
    { ...sa, template: '{{last_user_message}}\n{{recent_context}}' },
    { tool: 'shell', args: {}, cwd: '/w', confine: true, sandbox: false, history }
  )[1].content
  assert.ok(custom.startsWith('Liste os arquivos, por favor.\n'))
  // nunca o resultado de tool nem a prosa do agente — só status e chamadas
  assert.ok(custom.includes('[tool read_file] (ok; output omitted)'))
  assert.ok(!custom.includes('xxxxxxxxxx'))
  assert.ok(custom.includes('[assistant] → shell({"command":"ls -la"})'))
  assert.ok(!custom.includes('Vou listar.'))
  // com "O juiz pode negar": rótulo e regra de rejeitar no prompt
  const deny = buildJudgeMessages(
    { ...sa, canDeny: true },
    { tool: 'shell', args: {}, cwd: '/w', confine: true, sandbox: false, history }
  )[0].content
  assert.ok(deny.includes('(APPROVED | REJECTED | ASK-USER)'))
  assert.ok(deny.includes('\n- REJECTED — only for calls that are clearly malicious'))
})

test('contexto: N=0, fronteira de compactação, última mensagem do usuário', () => {
  const h = [
    sm({ role: 'user', content: 'antes' }),
    sm({ role: 'user', content: '<conversation_summary>…' }, { kind: 'compaction' }),
    sm({ role: 'user', content: 'depois' }),
    sm(
      { role: 'user', content: '[Subagente X concluiu]' },
      { kind: 'subagent-callback', synthetic: true }
    )
  ]
  assert.equal(recentContext(h, 0), '(omitted)')
  assert.ok(!recentContext(h, 10).includes('antes'))
  assert.equal(lastUserMessage(h), 'depois')
  assert.equal(lastUserMessage([]), '(none)')
  // subsessão: só mensagens digitadas contam; sem nenhuma → a tarefa (fallback)
  assert.equal(
    lastUserMessage([sm({ role: 'user', content: 'Tarefa X' }, { synthetic: true })]),
    '(none)'
  )
  assert.equal(
    lastUserMessage(
      [sm({ role: 'user', content: 'Tarefa X' }, { synthetic: true })],
      2000,
      'Tarefa X'
    ),
    'Tarefa X'
  )
})

test('body do juiz: temperatura 0, poucos tokens, sem tools; usage só no OpenRouter', () => {
  const b = buildJudgeBody('m', [{ role: 'user', content: 'x' }], false)
  assert.equal(b.temperature, 0)
  assert.equal(b.max_tokens, 300)
  assert.equal(b.stream, true)
  assert.equal('tools' in b, false)
  assert.equal('usage' in b, false)
  assert.deepEqual(buildJudgeBody('m', [], true).usage, { include: true })
})

// ---------------- ordem de decisão ----------------

test('rota: modo do item (always/smart/lists); o juiz só nos itens em smart', () => {
  const sa = { providerId: 'p', model: 'j' }
  const r = (cfg: any, t: any, g: any = null): string => {
    const x = approvalRoute(cfg, g, t)
    return x.kind === 'user' && x.smartMissing ? 'user-nojudge' : x.kind
  }
  // padrão global: lists (search = perguntar); arquivos/chats/subagentes = sempre permitir
  assert.equal(r({}, 'shell'), 'lists')
  assert.equal(r({}, 'process_start'), 'lists')
  assert.equal(r({}, 'browse_url'), 'lists')
  assert.equal(r({}, 'web_search'), 'user')
  assert.equal(r({}, 'read_file'), 'run')
  for (const t of ['write_file', 'edit_file', 'send_to_chat', 'delegate_task'])
    assert.equal(r({ smartApprove: sa }, t), 'run', t)
  // process_stop nunca pede confirmação
  assert.equal(r({ smartApprove: { ...sa, tools: ['process_stop'] } }, 'process_stop'), 'run')
  // global e override por chat
  assert.equal(r({}, 'shell', { commands: 'always' }), 'run')
  assert.equal(
    r({ approvalModes: { commands: 'lists' } }, 'shell', { commands: 'always' }),
    'lists'
  )
  assert.equal(r({ approvalModes: { commands: 'always' } }, 'shell'), 'run')
  // smart: com modelo → judge; sem config/sem modelo → pergunta (fail-closed)
  assert.equal(r({ approvalModes: { commands: 'smart' }, smartApprove: sa }, 'shell'), 'judge')
  assert.equal(r({ approvalModes: { commands: 'smart' } }, 'shell'), 'user-nojudge')
  assert.equal(
    r({ approvalModes: { search: 'smart' }, smartApprove: { ...sa, model: null } }, 'web_search'),
    'user-nojudge'
  )
  // modelo escolhido NÃO afeta itens fora do modo smart
  assert.equal(r({ smartApprove: sa }, 'shell'), 'lists')
  // itens de arquivo/agentes: smart → juiz; Perguntar → usuário
  assert.equal(
    r({ approvalModes: { writeFile: 'smart' }, smartApprove: sa }, 'write_file'),
    'judge'
  )
  assert.equal(r({ approvalModes: { writeFile: 'smart' } }, 'write_file'), 'user-nojudge')
  assert.equal(r({ approvalModes: { editFile: 'lists' } }, 'edit_file'), 'user')
  assert.equal(r({ smartApprove: sa }, 'delegate_task', { delegate: 'smart' }), 'judge')
  // `tools` legado não manda nada ao juiz (a migração converte em modo smart)
  assert.equal(r({ smartApprove: { ...sa, tools: ['write_file'] } }, 'write_file'), 'run')
  // modo inválido salvo → padrão
  assert.equal(r({ approvalModes: { commands: 'xx' } }, 'shell', { commands: 'yy' }), 'lists')
})

test('textos: rejeição e "Executar mesmo assim"', () => {
  assert.equal(smartRejectText('m/j', ' perigoso '), 'Rejeitado pelo Smart-Approve (m/j): perigoso')
  assert.equal(smartRejectText('m', ''), 'Rejeitado pelo Smart-Approve (m): sem motivo informado.')
  assert.equal(
    overrideMessageText('shell', { command: 'rm -rf build' }),
    'Pode executar shell `rm -rf build`; eu aprovo.'
  )
  assert.match(overrideMessageText('write_file', { path: 'a.txt', content: 'x' }), /`a\.txt`/)
})

test('liberação de uma vez só: mesma tool + mesmos args (ordem das chaves não importa), expira', () => {
  clearOverrides()
  addOverride('s1', 'shell', { command: 'ls', timeout_ms: 5 })
  assert.equal(takeOverride('s2', 'shell', { command: 'ls', timeout_ms: 5 }), false, 'outra sessão')
  assert.equal(
    takeOverride('s1', 'shell', { command: 'ls -a', timeout_ms: 5 }),
    false,
    'outros args'
  )
  assert.equal(
    takeOverride('s1', 'web_search', { command: 'ls', timeout_ms: 5 }),
    false,
    'outra tool'
  )
  assert.equal(takeOverride('s1', 'shell', { timeout_ms: 5, command: 'ls' }), true)
  assert.equal(takeOverride('s1', 'shell', { timeout_ms: 5, command: 'ls' }), false, 'só uma vez')
  addOverride('s1', 'shell', { command: 'x' }, 1000)
  assert.equal(
    takeOverride('s1', 'shell', { command: 'x' }, 1000 + OVERRIDE_TTL_MS + 1),
    false,
    'expirou'
  )
  assert.equal(argsKey({ b: 1, a: { d: 2, c: 3 } }), argsKey({ a: { c: 3, d: 2 }, b: 1 }))
})

// ---------------- personas ----------------

test('personas: smartApprove está em PRESET_FIELDS e sobrevive a snapshot/aplicar', () => {
  assert.ok((PRESET_FIELDS as readonly string[]).includes('smartApprove'))
  const sa: SmartApproveConfig = normalizeSmartApprove({ providerId: 'p', model: 'j' })
  const base = DEFAULT_CHAT_CONFIG('/w', { providerId: 'p', model: 'm' })
  const snap = snapshotPreset({ ...base, smartApprove: sa })
  assert.deepEqual(snap.smartApprove, sa)
  assert.deepEqual(sanitizePresetConfig({ smartApprove: sa, junk: 1 }), { smartApprove: sa })
  const applied = applyPreset(base, snap)
  assert.deepEqual(applied.smartApprove, sa)
  assert.notEqual(applied.smartApprove, sa, 'cópia')
})

// ---------------- chamada ao juiz (servidor local) ----------------

type Script = { status?: number; body?: string; delayMs?: number; json?: boolean }
let server: Server
let base = ''
const hits: any[] = []
let script: Script = {}

async function startServer(): Promise<void> {
  server = createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      hits.push({ headers: req.headers, body: JSON.parse(data || '{}') })
      const s = script
      const send = (): void => {
        if (s.status && s.status !== 200) {
          res.writeHead(s.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: s.body ?? 'falhou' } }))
          return
        }
        if (s.json) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              choices: [{ message: { content: s.body ?? '' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.00002 }
            })
          )
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const text = s.body ?? ''
        const mid = Math.floor(text.length / 2)
        for (const part of [text.slice(0, mid), text.slice(mid)])
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 9, cost: 0.00001 } })}\n\n`
        )
        res.end('data: [DONE]\n\n')
      }
      if (s.delayMs) setTimeout(send, s.delayMs)
      else send()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

const provider = (): Provider => ({
  id: 'pj',
  name: 'Juiz',
  baseUrl: base,
  apiKey: 'sk-judge-0123456789abcdef',
  headers: {},
  createdAt: 0
})

const judge = (
  over: Partial<SmartApproveConfig> = {},
  signal = new AbortController().signal,
  p: Provider | null = provider()
): Promise<SmartApproveRecord> =>
  runJudge({
    sa: {
      ...normalizeSmartApprove({ providerId: 'pj', model: 'judge/1' }),
      ...over
    },
    provider: p,
    chatConfig: { appSignature: 'none' },
    ctx: {
      tool: 'shell',
      args: { command: 'ls' },
      cwd: '/w',
      confine: true,
      sandbox: false,
      history: []
    },
    signal
  })

test('juiz: aprovar / rejeitar / perguntar; request exata e usage', async () => {
  await startServer()
  try {
    script = { body: 'APPROVED\nSó lista arquivos.' }
    let r = await judge()
    assert.equal(r.decision, 'approve')
    assert.equal(r.reason, 'Só lista arquivos.')
    assert.equal(r.model, 'judge/1')
    assert.equal(r.providerId, 'pj')
    assert.equal(r.usage?.cost, 0.00001)
    assert.equal(r.fallback, undefined)
    const hit = hits.at(-1)
    assert.equal(hit.body.model, 'judge/1')
    assert.equal(hit.body.temperature, 0)
    assert.equal(hit.body.max_tokens, 300)
    assert.equal(hit.body.tools, undefined)
    assert.equal(
      hit.body.messages[0].content,
      renderSmartTemplate(DEFAULT_SMART_APPROVE_PROMPT, {
        labels: 'APPROVED | ASK-USER',
        approve: 'APPROVED',
        reject: 'REJECTED',
        ask: 'ASK-USER',
        reject_rule: '',
        categories: SMART_CATEGORY_KEYS
      })
    )
    assert.ok(
      hit.body.messages[1].content.startsWith(DEFAULT_SMART_APPROVE_TEMPLATE.split('{{')[0])
    )
    assert.equal(hit.headers.authorization, 'Bearer sk-judge-0123456789abcdef')
    // o registro guarda a request com a key mascarada
    assert.ok(!JSON.stringify(r.request).includes('0123456789abcdef'))
    assert.deepEqual((r.request!.body as any).messages, hit.body.messages)

    // sem "O juiz pode negar" (padrão, também em configs antigas): rejeitar → perguntar + dica
    script = { body: '**REJECTED** — apaga a home' }
    r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.wouldReject, true)
    assert.equal(r.reason, 'apaga a home')
    assert.equal(r.fallback, undefined)
    // com "O juiz pode negar": a rejeição é honrada
    r = await judge({ canDeny: true })
    assert.equal(r.decision, 'reject')
    assert.equal(r.wouldReject, undefined)
    assert.equal(r.reason, 'apaga a home')

    script = { body: 'ASK-USER\nAmbíguo.', json: true }
    r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, undefined)
    assert.equal(r.reason, 'Ambíguo.')
    assert.equal(r.usage?.cost, 0.00002)
  } finally {
    server.close()
  }
})

test('juiz: falhas nunca liberam (ambíguo, vazio, HTTP, rede, timeout, abort, sem provedor)', async () => {
  await startServer()
  try {
    script = { body: 'Sure! APPROVED or REJECTED, your call' }
    let r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'ambiguous')
    assert.ok(r.response?.includes('your call'))

    script = { body: '' }
    r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'ambiguous')
    assert.match(r.error!, /vazio/)

    script = { status: 402, body: 'requires at least $0.50' }
    r = await judge()
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'error')
    assert.match(r.error!, /402.*requires at least/)

    script = { body: 'APPROVED\nok', delayMs: 1500 }
    const t0 = Date.now()
    r = await judge({ timeoutS: 0.3 })
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'timeout')
    assert.ok(Date.now() - t0 < 1400, 'respeita o timeout')

    const ac = new AbortController()
    script = { body: 'APPROVED\nok', delayMs: 1500 }
    setTimeout(() => ac.abort(), 100)
    r = await judge({}, ac.signal)
    assert.equal(r.decision, 'ask')
    assert.equal(r.fallback, 'error')

    r = await judge({}, undefined, null)
    assert.equal(r.decision, 'ask')
    assert.match(r.error!, /provedor/)
    r = await judge({ model: null })
    assert.equal(r.decision, 'ask')
  } finally {
    server.closeAllConnections() // keep-alive do fetch reaproveitaria a conexão
    server.close()
  }
  // servidor fechado → erro de rede
  const r = await judge()
  assert.equal(r.decision, 'ask')
  assert.equal(r.fallback, 'error')
  assert.match(r.error!, /Falha de rede/)
})

// ======================= 0.8.4: listas antes do juiz, juiz sem negar, contexto =======================

const LISTS = {
  commands: {
    allow: ['git status', 'git diff *', 'ssh deploy@prod.example.com', 'ls *'],
    deny: ['rm -rf /*']
  },
  processes: { allow: [], deny: [] },
  pages: { allow: ['docs.example.com', 'github.com'], deny: ['evil.example.org'] }
}

test('rota smart com listas: whitelist inteira → sem juiz; parcial → só os não liberados; opção → juiz', () => {
  // 100% whitelist → roda sem juiz
  let p = smartListPlan('commands', { command: 'git status && ls -la' }, LISTS)
  assert.equal(p.kind, 'run')
  // blacklist → bloqueia sem juiz
  p = smartListPlan('commands', { command: 'git status; rm -rf /tmp/x' }, LISTS)
  assert.equal(p.kind, 'blocked')
  // parcial → juiz decide só o que sobrou (índice 1)
  p = smartListPlan('commands', { command: 'git status && rm tmp.txt' }, LISTS)
  assert.equal(p.kind, 'judge')
  assert.deepEqual(p.kind === 'judge' && p.judgeIdx, [1])
  // "Consultar também o que a whitelist libera" → juiz no que a whitelist libera, mas NUNCA no
  // que é só leitura (0.8.5: git status/ls são sempre liberados)
  p = smartListPlan('commands', { command: 'ssh deploy@prod.example.com && git status' }, LISTS, {
    judgeWhitelisted: true
  })
  assert.equal(p.kind, 'judge')
  assert.deepEqual(p.kind === 'judge' && p.judgeIdx, [0])
  p = smartListPlan('commands', { command: 'git status && ls -la' }, LISTS, {
    judgeWhitelisted: true
  })
  assert.equal(p.kind, 'run')
  // a blacklist continua precedendo com a opção ligada
  assert.equal(
    smartListPlan('commands', { command: 'rm -rf /tmp' }, LISTS, { judgeWhitelisted: true }).kind,
    'blocked'
  )
  // páginas
  assert.equal(smartListPlan('pages', { url: 'https://github.com/x' }, LISTS).kind, 'run')
  assert.equal(smartListPlan('pages', { url: 'https://evil.example.org/' }, LISTS).kind, 'blocked')
  assert.equal(smartListPlan('pages', { url: 'https://npmjs.com/' }, LISTS).kind, 'judge')
  // a rota continua 'judge' para o item em smart (o runner aplica o plano)
  assert.equal(
    approvalRoute(
      { approvalModes: { commands: 'smart' }, smartApprove: { providerId: 'p', model: 'j' } },
      null,
      'shell'
    ).kind,
    'judge'
  )
})

test('veredito: rejeitar → perguntar sem "pode negar"; honrado com ela; aprovar/perguntar iguais', () => {
  assert.deepEqual(mapJudgeDecision('reject', false), { decision: 'ask', wouldReject: true })
  assert.deepEqual(mapJudgeDecision('reject', true), { decision: 'reject' })
  assert.deepEqual(mapJudgeDecision('approve', false), { decision: 'approve' })
  assert.deepEqual(mapJudgeDecision('ask', true), { decision: 'ask' })
})

test('migração: configs antigas (sem os campos novos) → pode negar e julgar a whitelist desligados', () => {
  const old = normalizeSmartApprove({
    providerId: 'p',
    model: 'j',
    prompt: 'custom {{reject}}',
    labels: { approve: 'SIM', reject: 'NAO', ask: 'TALVEZ' },
    enabled: true
  } as any)
  assert.equal(old.canDeny, false)
  assert.equal(old.judgeWhitelisted, false)
  assert.equal(old.prompt, 'custom {{reject}}', 'prompt personalizado preservado')
  assert.equal(normalizeSmartApprove({ canDeny: 'yes' as any }).canDeny, false, 'só true liga')
  assert.equal(
    normalizeSmartApprove({ canDeny: true, judgeWhitelisted: true }).judgeWhitelisted,
    true
  )
  // template personalizado antigo continua funcionando: {{labels}} só sem o de rejeitar
  const vars = judgeVars(old, {
    tool: 'shell',
    args: {},
    cwd: '/w',
    confine: true,
    sandbox: false,
    history: []
  })
  assert.equal(vars.labels, 'SIM | TALVEZ')
  assert.equal(vars.reject, 'NAO')
  assert.equal(vars.reject_rule, '')
})

const H = (sessionId: string, items: [any, any?][]): StoredMessage[] =>
  items.map(([message, meta], i) => ({
    id: `${sessionId}-${i}`,
    sessionId,
    seq: i + 1,
    message,
    meta: meta ?? {},
    createdAt: 0
  }))
const call = (id: string, name: string, args: any): any => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
})

test('contexto: objetivo da principal, tarefa do subagente, atividade, arquivos tocados, aprovados', () => {
  const main = H('m', [
    [{ role: 'user', content: 'Primeiro pedido antigo' }],
    [{ role: 'user', content: 'Gere o relatório em docs/' }],
    [{ role: 'user', content: '<tool_result>x</tool_result>' }, { synthetic: true }],
    [{ role: 'user', content: 'mensagem de outro chat' }, { kind: 'inter-chat' }],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [call('p1', 'write_file', { path: 'docs/base.md', content: 'x' })]
      }
    ],
    [{ role: 'tool', tool_call_id: 'p1', content: 'ok' }, { toolStatus: 'ok' }],
    [{ role: 'user', content: 'E apague os rascunhos depois' }, { kind: 'queued' }]
  ])
  const sub = H('s', [
    [{ role: 'user', content: 'TAREFA: crie draft.txt e depois apague' }, { synthetic: true }],
    [
      {
        role: 'assistant',
        content: 'Vou criar.',
        tool_calls: [
          call('c1', 'write_file', { path: 'draft.txt', content: 'x' }),
          call('c2', 'edit_file', { path: '/abs/a.ts', old_string: 'a', new_string: 'b' })
        ]
      }
    ],
    [{ role: 'tool', tool_call_id: 'c1', content: 'ok' }, { toolStatus: 'ok' }],
    [{ role: 'tool', tool_call_id: 'c2', content: 'Erro' }, { toolStatus: 'error' }],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [call('c3', 'shell', { command: 'rm -rf dist' })]
      }
    ],
    [
      { role: 'tool', tool_call_id: 'c3', content: '' },
      {
        toolStatus: 'ok',
        approval: { item: 'commands', mode: 'smart', userAllowed: ['rm -rf dist'] }
      }
    ],
    [
      {
        role: 'assistant',
        content: 'Agora apago o rascunho.',
        tool_calls: [call('c4', 'shell', { command: 'rm draft.txt' })]
      }
    ]
  ])
  const check = evaluateLists('commands', { command: 'git status && rm draft.txt' }, LISTS).check
  const x = buildJudgeExtras({
    history: sub,
    mainHistory: main,
    subagent: { depth: 1, title: 'Rascunhos', task: 'TAREFA: crie draft.txt e depois apague' },
    cwd: '/proj',
    item: 'commands',
    check,
    judgeIdx: [1],
    lists: LISTS
  })
  assert.deepEqual(x.userGoal, [
    'E apague os rascunhos depois',
    'Gere o relatório em docs/',
    'Primeiro pedido antigo'
  ])
  assert.equal(x.subagent?.depth, 1)
  assert.equal(x.subagent?.task, 'TAREFA: crie draft.txt e depois apague')
  // a pendente (c4) não entra; status de cada uma
  assert.deepEqual(
    x.recentTools.map((t) => `${t.status} ${t.name} ${t.summary}`),
    ['ok write_file draft.txt', 'error edit_file /abs/a.ts', 'ok shell rm -rf dist']
  )
  // 0.8.5: a fala do agente não entra mais no contexto do juiz (pode repetir saída de tool)
  assert.ok(!('lastAgentText' in x))
  // só os ok; relativos resolvidos pela raiz; do pai marcados
  assert.deepEqual(x.touchedFiles, [
    { path: '/proj/draft.txt', action: 'written' },
    { path: '/proj/docs/base.md', action: 'written', byParent: true }
  ])
  assert.deepEqual(x.approvedByUser, ['rm -rf dist'])
  // whitelist parecida: nenhuma entrada de "rm"; git status já liberou um item (fica de fora)
  assert.deepEqual(x.approvedWhitelist, [])

  const sa = normalizeSmartApprove({ providerId: 'p', model: 'j' })
  const u = buildJudgeMessages(sa, {
    tool: 'shell',
    args: { command: 'git status && rm draft.txt' },
    cwd: '/proj',
    confine: true,
    sandbox: false,
    history: sub,
    check,
    judgeIdx: [1],
    extra: x
  })[1].content
  assert.ok(u.includes('[1] E apague os rascunhos depois\n[2] Gere o relatório em docs/'))
  assert.ok(u.includes('Caller: a SUBAGENT (depth 1, "Rascunhos")'))
  assert.ok(u.includes('"""\nTAREFA: crie draft.txt e depois apague\n"""'))
  assert.ok(u.includes('- /proj/draft.txt (created/overwritten)'))
  assert.ok(u.includes('- /proj/docs/base.md (created/overwritten, by a parent agent)'))
  assert.ok(u.includes('approved by the user earlier in this session: rm -rf dist'))
  assert.ok(u.includes('- git status   [read-only (always allowed)]'))
  assert.ok(u.includes('- rm draft.txt   [TO DECIDE]'))
  // determinístico: mesma entrada → mesmo texto
  const again = buildJudgeMessages(sa, {
    tool: 'shell',
    args: { command: 'git status && rm draft.txt' },
    cwd: '/proj',
    confine: true,
    sandbox: false,
    history: sub,
    check,
    judgeIdx: [1],
    extra: buildJudgeExtras({
      history: sub,
      mainHistory: main,
      subagent: { depth: 1, title: 'Rascunhos', task: 'TAREFA: crie draft.txt e depois apague' },
      cwd: '/proj',
      item: 'commands',
      check,
      judgeIdx: [1],
      lists: LISTS
    })
  })[1].content
  assert.equal(again, u)
})

test('contexto: whitelist parecida (programa, wrapper ssh, host; site em Páginas)', () => {
  const c = evaluateLists(
    'commands',
    { command: 'git push origin x; ssh deploy@prod.example.com "systemctl restart app"' },
    LISTS
  ).check
  const idx = c.items.map((it, i) => (it.verdict === 'allow' ? -1 : i)).filter((i) => i >= 0)
  const wl = relevantWhitelist(c, idx, LISTS)
  assert.ok(wl.includes('git diff *'), 'mesmo programa (git)')
  assert.ok(!wl.includes('ls *'))
  assert.ok(!wl.includes('ssh deploy@prod.example.com'), 'a que já liberou um item fica de fora')
  const pg = evaluateLists('pages', { url: 'https://api.github.com/x' }, LISTS).check
  assert.deepEqual(relevantWhitelist(pg, [0], LISTS), ['github.com'])
})

test('contexto: tetos (objetivo, atividade, arquivos, subagente) — prompt limitado', () => {
  const L = JUDGE_CONTEXT_LIMITS
  const big = 'y'.repeat(5000)
  const hist = H('m', [
    ...Array.from({ length: 6 }, () => [{ role: 'user', content: big }] as [any]),
    ...Array.from(
      { length: 40 },
      (_, i) =>
        [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              call(`w${i}`, 'write_file', { path: `f${i}/${'z'.repeat(60)}.txt`, content: 'x' })
            ]
          }
        ] as [any]
    ),
    ...Array.from(
      { length: 40 },
      (_, i) =>
        [{ role: 'tool', tool_call_id: `w${i}`, content: 'ok' }, { toolStatus: 'ok' }] as [any, any]
    )
  ])
  const x = buildJudgeExtras({
    history: hist,
    subagent: { depth: 2, title: 'Neto', task: big },
    parents: [{ title: 'Filho', task: big, history: [] }],
    cwd: '/p'
  })
  assert.ok(x.userGoal.length <= L.goalMessages)
  assert.ok(x.userGoal.join('').length <= L.goalChars + 60)
  assert.ok(x.recentTools.length <= L.toolCalls)
  assert.ok(x.touchedFiles.length <= L.files)
  assert.ok(
    (x.subagent!.task + x.subagent!.parents.map((p) => p.task).join('')).length <= L.taskChars + 80
  )
  const sa = normalizeSmartApprove({ providerId: 'p', model: 'j' })
  const vars = judgeVars(sa, {
    tool: 'shell',
    args: { command: 'ls' },
    cwd: '/p',
    confine: true,
    sandbox: false,
    history: hist,
    extra: x
  })
  const ctxLen = ['user_goal', 'subagent', 'touched_files', 'approved_before', 'recent_activity']
    .map((k) => vars[k].length)
    .reduce((a, b) => a + b, 0)
  assert.ok(ctxLen <= 6500, `contexto ${ctxLen} chars`)
})

test('juiz: com a avaliação das listas, registra os itens julgados; timeout nunca nega (nem com pode negar)', async () => {
  await startServer()
  try {
    const check = evaluateLists('commands', { command: 'git status && rm x.txt' }, LISTS).check
    script = { body: 'APPROVED\nArquivo da tarefa.' }
    const r = await runJudge({
      sa: normalizeSmartApprove({ providerId: 'pj', model: 'judge/1' }),
      provider: provider(),
      chatConfig: { appSignature: 'none' },
      ctx: {
        tool: 'shell',
        args: { command: 'git status && rm x.txt' },
        cwd: '/w',
        confine: true,
        sandbox: false,
        history: [],
        check,
        judgeIdx: [1]
      },
      signal: new AbortController().signal
    })
    assert.equal(r.decision, 'approve')
    assert.deepEqual(r.judged, ['rm x.txt'])
    const u = hits.at(-1).body.messages[1].content
    assert.ok(u.includes('- rm x.txt   [TO DECIDE]') && u.includes('[read-only (always allowed)]'))
    script = { body: 'REJECTED\nnão', delayMs: 1500 }
    const t = await judge({ canDeny: true, timeoutS: 0.3 })
    assert.equal(t.decision, 'ask')
    assert.equal(t.fallback, 'timeout')
    script = { body: 'Talvez REJECTED, talvez APPROVED' }
    const amb = await judge({ canDeny: true })
    assert.equal(amb.decision, 'ask')
    assert.equal(amb.fallback, 'ambiguous')
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('card: aprovada → detalhes no selo (quem aprovou); negada/bloqueada → faixa', () => {
  assert.equal(
    approvalOutcome({ toolStatus: 'ok', approval: { item: 'memory_write', mode: 'always' } }),
    null
  )
  let o = approvalOutcome({
    toolStatus: 'ok',
    approval: { item: 'commands', mode: 'lists', allowed: [{ text: 'ls', entry: 'ls *' }] }
  })!
  assert.equal(o.kind, 'approved')
  assert.equal(o.title, 'Aprovado pela lista')
  o = approvalOutcome({
    toolStatus: 'ok',
    approval: {
      item: 'commands',
      mode: 'smart',
      allowed: [{ text: 'git status', entry: 'git status' }],
      judgeAllowed: ['rm x']
    },
    smartApprove: { decision: 'approve', reason: 'ok', providerId: 'p', model: 'j', durationMs: 1 }
  })!
  assert.equal(o.title, 'Aprovado pela lista e pelo Smart-Approve')
  assert.deepEqual(
    o.items.map((i) => i.by),
    ['lists', 'smart']
  )
  o = approvalOutcome({
    toolStatus: 'ok',
    approval: { item: 'commands', mode: 'smart', userAllowed: ['rm x'] },
    smartApprove: {
      decision: 'ask',
      wouldReject: true,
      reason: 'apaga',
      providerId: 'p',
      model: 'j',
      durationMs: 1
    }
  })!
  assert.equal(o.title, 'Aprovado por você')
  // registro antigo: o juiz pediu e rodou → você
  assert.equal(
    approvalOutcome({
      toolStatus: 'ok',
      smartApprove: { decision: 'ask', reason: '', providerId: 'p', model: 'j', durationMs: 1 }
    })!.title,
    'Aprovado por você'
  )
  assert.equal(
    approvalOutcome({ toolStatus: 'ok', smartOverride: true })!.title,
    'Aprovado por você'
  )
  o = approvalOutcome({
    toolStatus: 'denied',
    approval: { item: 'commands', mode: 'smart', blocked: { text: 'rm -rf /', entry: 'rm -rf /*' } }
  })!
  assert.equal(o.kind, 'denied')
  assert.equal(o.deniedBy, 'blacklist')
  o = approvalOutcome({
    toolStatus: 'denied',
    smartApprove: {
      decision: 'reject',
      reason: 'perigoso',
      providerId: 'p',
      model: 'j',
      durationMs: 1
    }
  })!
  assert.equal(o.deniedBy, 'smart')
  assert.equal(o.reason, 'perigoso')
  o = approvalOutcome({
    toolStatus: 'denied',
    approval: { item: 'search', mode: 'lists', denied: 'rsync' }
  })!
  assert.equal(o.title, 'Negado por você')
  assert.equal(
    approvalOutcome({ toolStatus: 'cancelled', approval: { item: 'commands', mode: 'lists' } }),
    null
  )
})

test('1.18.0: max_tokens do juiz — chat/persona > global (smartApproveDefaults.judgeMaxTokens) > 300; vai na request', () => {
  assert.equal(effectiveJudgeMaxTokens(null, null), 300)
  assert.equal(effectiveJudgeMaxTokens(null, { judgeMaxTokens: 800 }), 800)
  assert.equal(effectiveJudgeMaxTokens({ maxTokens: 1500 }, { judgeMaxTokens: 800 }), 1500)
  assert.equal(effectiveJudgeMaxTokens({ maxTokens: null }, { judgeMaxTokens: 800 }), 800)
  assert.equal(effectiveJudgeMaxTokens({ maxTokens: 3 }, null), 16, 'mínimo')
  assert.equal(effectiveJudgeMaxTokens({ maxTokens: 100_000 }, null), 100_000, 'sem teto')
  assert.equal(normalizeSmartApprove({ maxTokens: 900 }).maxTokens, 900)
  assert.equal('maxTokens' in normalizeSmartApprove({ maxTokens: null }), false, 'null = herda')
  assert.equal(normalizeSmartDefaults({ judgeMaxTokens: 700 }).judgeMaxTokens, 700)
  assert.equal('judgeMaxTokens' in normalizeSmartDefaults({}), false)
})
