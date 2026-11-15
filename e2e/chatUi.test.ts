// Chat: tempo/tokens do raciocínio, gasto do chat e recolhimento do cabeçalho/composer — lógica
// pura (src/renderer/src/lib/reasoning.ts, chatSpend.ts, responsiveBar.ts e o relógio do stream em
// src/main/agent/llm.ts). Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/chatUi.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Chat, Session, StoredMessage, StreamDraft } from '../src/shared/types.ts'
import {
  formatCountPt,
  formatSecondsPt,
  nextReasoningClock,
  reasoningHeader
} from '../src/renderer/src/lib/reasoning.ts'
import { computeChatSpend, formatIntPt, formatUsd } from '../src/renderer/src/lib/chatSpend.ts'
import {
  BAR_ITEMS,
  estimateWidth,
  planCollapse,
  type BarItemId
} from '../src/renderer/src/lib/responsiveBar.ts'
import {
  accToDraft,
  markReasoning,
  newAccumulator,
  reasoningDuration
} from '../src/main/agent/llm.ts'
import { applyAnthropicEvent } from '../src/main/agent/adapters/anthropic.ts'

// ---------------- raciocínio ----------------

test('formatCountPt: pt-BR compacto', () => {
  assert.equal(formatCountPt(0), '0')
  assert.equal(formatCountPt(850), '850')
  assert.equal(formatCountPt(999), '999')
  assert.equal(formatCountPt(1000), '1 mil')
  assert.equal(formatCountPt(1210), '1,2 mil')
  assert.equal(formatCountPt(12_345), '12,3 mil')
  assert.equal(formatCountPt(123_456), '123 mil')
  assert.equal(formatCountPt(1_250_000), '1,3 mi')
})

test('formatSecondsPt', () => {
  assert.equal(formatSecondsPt(300), '<1 s')
  assert.equal(formatSecondsPt(8_900), '8 s')
  assert.equal(formatSecondsPt(65_000), '1 min 5 s')
  assert.equal(formatSecondsPt(120_000), '2 min')
})

test('reasoningHeader: pensando, concluído com/sem dados, mensagem antiga', () => {
  assert.deepEqual(reasoningHeader({ live: true, elapsedMs: 400 }), {
    label: 'Pensando…',
    details: []
  })
  assert.deepEqual(reasoningHeader({ live: true, elapsedMs: 8_200 }), {
    label: 'Pensando…',
    details: ['8 s']
  })
  assert.deepEqual(reasoningHeader({ durationMs: 12_400, tokens: 1210 }), {
    label: 'Raciocínio',
    details: ['12 s', '1,2 mil tokens']
  })
  // sem tokens do provedor → só a duração
  assert.deepEqual(reasoningHeader({ durationMs: 3_000 }), {
    label: 'Raciocínio',
    details: ['3 s']
  })
  assert.deepEqual(reasoningHeader({ tokens: 850 }), {
    label: 'Raciocínio',
    details: ['850 tokens']
  })
  // mensagem antiga
  assert.deepEqual(reasoningHeader({}), { label: 'Raciocínio', details: [] })
})

const draft = (p: Partial<StreamDraft>): StreamDraft => ({
  content: '',
  reasoning: '',
  toolCalls: [],
  ...p
})

test('nextReasoningClock: começa no 1º raciocínio, termina no 1º conteúdo, some no fim', () => {
  assert.equal(nextReasoningClock(undefined, draft({}), 100), undefined)
  const c1 = nextReasoningClock(undefined, draft({ reasoning: 'a' }), 1000)
  assert.deepEqual(c1, { start: 1000 })
  // mais raciocínio: mesmo objeto (sem re-render)
  const c2 = nextReasoningClock(c1, draft({ reasoning: 'ab' }), 2000)
  assert.equal(c2, c1)
  const c3 = nextReasoningClock(c2, draft({ reasoning: 'ab', content: 'x' }), 5000)
  assert.deepEqual(c3, { start: 1000, end: 5000 })
  assert.equal(nextReasoningClock(c3, draft({ reasoning: 'ab', content: 'xy' }), 9000), c3)
  // tool call também encerra o raciocínio
  assert.deepEqual(
    nextReasoningClock(
      c1,
      draft({ reasoning: 'a', toolCalls: [{ id: 't', name: 'shell', arguments: '' }] }),
      3000
    ),
    { start: 1000, end: 3000 }
  )
  assert.equal(nextReasoningClock(c3, null, 9000), undefined)
})

test('nextReasoningClock: marcas do draft local têm precedência (sobrevive a recarregar)', () => {
  assert.deepEqual(
    nextReasoningClock(undefined, draft({ reasoning: 'a', reasoningStartedAt: 400 }), 5000),
    { start: 400 }
  )
  assert.deepEqual(
    nextReasoningClock(
      undefined,
      draft({ reasoning: 'a', content: 'b', reasoningStartedAt: 400, reasoningEndedAt: 2400 }),
      5000
    ),
    { start: 400, end: 2400 }
  )
})

test('markReasoning / reasoningDuration (runner → meta.reasoningMs)', () => {
  const acc = newAccumulator()
  markReasoning(acc, 100)
  assert.equal(acc.reasoningStartedAt, undefined)
  assert.equal(reasoningDuration(acc, 200), undefined)
  acc.reasoning = 'pensando'
  markReasoning(acc, 1000)
  markReasoning(acc, 1500)
  assert.equal(acc.reasoningStartedAt, 1000)
  assert.equal(acc.reasoningEndedAt, undefined)
  // cortado ainda pensando → até agora
  assert.equal(reasoningDuration(acc, 4000), 3000)
  assert.equal(accToDraft(acc).reasoningStartedAt, 1000)
  acc.content = 'resposta'
  markReasoning(acc, 13_400)
  markReasoning(acc, 20_000)
  assert.equal(acc.reasoningEndedAt, 13_400)
  assert.equal(reasoningDuration(acc, 30_000), 12_400)
  assert.equal(accToDraft(acc).reasoningEndedAt, 13_400)
  // tudo de uma vez (não-stream): duração 0 não é registrada
  const once = newAccumulator()
  once.reasoning = 'r'
  once.content = 'c'
  markReasoning(once, 500)
  assert.equal(reasoningDuration(once, 500), undefined)
  // sem raciocínio: nada no draft
  assert.equal('reasoningStartedAt' in accToDraft(newAccumulator()), false)
})

test('raciocínio OMITIDO (Messages API, bloco thinking sem texto): relógio do "Pensando…" e meta.reasoningMs', () => {
  const acc = newAccumulator()
  const ev = (e: Record<string, unknown>, now: number): void => {
    applyAnthropicEvent(acc, e)
    markReasoning(acc, now)
  }
  ev({ type: 'message_start', message: { model: 'claude-opus-5-5' } }, 100)
  assert.equal(acc.reasoningStartedAt, undefined, 'nada de raciocínio ainda')
  ev(
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    1000
  )
  assert.equal(acc.thinking, 'open')
  assert.equal(acc.reasoning, '', 'sem texto (display omitted)')
  assert.equal(acc.reasoningStartedAt, 1000, 'o bloco vazio já conta')
  const d1 = accToDraft(acc)
  assert.deepEqual(nextReasoningClock(undefined, d1, 1000), { start: 1000 }, '"Pensando…" ao vivo')
  ev(
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } },
    4000
  )
  assert.equal(acc.reasoningEndedAt, undefined)
  ev({ type: 'content_block_stop', index: 0 }, 4200)
  assert.equal(acc.thinking, 'closed')
  assert.equal(acc.reasoningEndedAt, 4200, 'fechar o bloco encerra o "Pensando…"')
  assert.deepEqual(nextReasoningClock(undefined, accToDraft(acc), 4300), {
    start: 1000,
    end: 4200
  })
  ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 4300)
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Oi' } }, 4400)
  assert.equal(reasoningDuration(acc, 9000), 3200, 'meta.reasoningMs conta o bloco vazio')
  // redacted_thinking também é raciocínio
  const r = newAccumulator()
  applyAnthropicEvent(r, {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'redacted_thinking', data: 'x' }
  })
  markReasoning(r, 50)
  assert.equal(r.reasoningStartedAt, 50)
  // controle remoto (draft sem marcas e sem texto): nada de relógio
  assert.equal(nextReasoningClock(undefined, draft({}), 100), undefined)
})

// ---------------- gasto do chat ----------------

let seq = 0
function m(
  sessionId: string,
  message: StoredMessage['message'],
  meta: StoredMessage['meta'] = {}
): StoredMessage {
  seq++
  return { id: `m${seq}`, sessionId, seq, message, meta, createdAt: seq }
}
const session = (
  id: string,
  depth: 0 | 1 | 2,
  title = '',
  parent: string | null = null
): Session => ({
  id,
  chatId: 'c1',
  parentSessionId: parent,
  parentToolCallId: null,
  depth,
  model: depth ? 'anthropic/claude-haiku-4.5' : 'openai/gpt-5',
  title,
  task: null,
  status: 'idle',
  createdAt: seq++
})

function chatWith(capturedContext?: Chat['config']['capturedContext']): Chat {
  return {
    id: 'c1',
    title: 'Chat',
    mainSessionId: 's1',
    createdAt: 0,
    updatedAt: 0,
    config: { capturedContext } as Chat['config']
  }
}

test('formatUsd / formatIntPt: pt-BR', () => {
  assert.equal(formatUsd(0), '$0,00')
  assert.equal(formatUsd(0.00004), '<$0,0001')
  assert.equal(formatUsd(0.0042), '$0,0042')
  assert.equal(formatUsd(0.42), '$0,42')
  assert.equal(formatUsd(0.17154), '$0,17')
  assert.equal(formatUsd(1234.5), '$1.234,50')
  assert.equal(formatIntPt(1234567), '1.234.567')
  assert.equal(formatIntPt(850), '850')
})

test('computeChatSpend: principal × subagentes, cache, custo ausente, juiz, resumidor e título', () => {
  const sessions = [
    session('s1', 0, 'Principal'),
    session('s1a', 1, 'Pesquisar', 's1'),
    session('s1b', 1, 'Nunca aberto', 's1'),
    { ...session('x', 0), chatId: 'outro' }
  ]
  const messages: Record<string, StoredMessage[]> = {
    s1: [
      m(
        's1',
        { role: 'user', content: 'oi' },
        {
          autoTitle: {
            title: 'T',
            applied: true,
            trigger: 'auto',
            providerId: 'p',
            model: 'mini',
            usage: { promptTokens: 120, completionTokens: 8, cost: 0.00004 },
            durationMs: 1,
            at: 1
          }
        }
      ),
      m(
        's1',
        { role: 'assistant', content: 'a' },
        {
          model: 'gpt',
          usage: {
            promptTokens: 10_000,
            completionTokens: 500,
            cachedTokens: 6000,
            cacheWriteTokens: 1000,
            reasoningTokens: 200,
            cost: 0.12
          }
        }
      ),
      m(
        's1',
        { role: 'tool', tool_call_id: 't1', content: 'ok' },
        {
          smartApprove: {
            decision: 'approve',
            reason: '',
            providerId: 'p',
            model: 'j',
            usage: { promptTokens: 900, completionTokens: 20, cost: 0.002 },
            durationMs: 1
          }
        }
      ),
      // juiz que falhou por HTTP, sem usage: não é cobrado → não conta
      m(
        's1',
        { role: 'tool', tool_call_id: 't2', content: 'ok' },
        {
          smartApprove: {
            decision: 'ask',
            reason: '',
            fallback: 'error',
            providerId: 'p',
            model: 'j',
            durationMs: 1
          }
        }
      ),
      m(
        's1',
        { role: 'assistant', content: null },
        {
          model: 'gpt',
          usage: { promptTokens: 12_000, completionTokens: 300, cachedTokens: 10_000, cost: 0.03 }
        }
      ),
      // sem custo → conta tokens, custo desconhecido
      m(
        's1',
        { role: 'assistant', content: 'c' },
        { model: 'gpt', usage: { promptTokens: 5000, completionTokens: 100 } }
      ),
      // mensagens do app (erro, sintética) não são chamadas
      m(
        's1',
        { role: 'assistant', content: 'erro' },
        { kind: 'error', synthetic: true, model: 'gpt' }
      ),
      // compactação
      m(
        's1',
        { role: 'user', content: 'resumo' },
        {
          kind: 'compaction',
          compactUsage: { promptTokens: 2000, completionTokens: 300, cost: 0.004 }
        }
      )
    ],
    s1a: [
      m('s1a', { role: 'user', content: 'tarefa' }),
      m(
        's1a',
        { role: 'assistant', content: 'x' },
        {
          model: 'h',
          usage: { promptTokens: 3000, completionTokens: 400, cachedTokens: 1000, cost: 0.01 }
        }
      ),
      m(
        's1a',
        { role: 'assistant', content: 'y' },
        { model: 'h', usage: { promptTokens: 3500, completionTokens: 200, cost: 0.008 } }
      )
    ],
    x: [
      m(
        'x',
        { role: 'assistant', content: 'z' },
        { model: 'o', usage: { promptTokens: 1, completionTokens: 1, cost: 9 } }
      )
    ]
  }
  const chat = chatWith({
    main: {
      text: '',
      updatedAt: 0,
      by: 'model',
      calls: 3,
      cost: 0.0015,
      lastRun: {
        at: 0,
        providerId: 'p',
        model: 'mini',
        usage: { promptTokens: 1, completionTokens: 1, cost: 0.0005 },
        durationMs: 1
      }
    },
    // resumidor de subagente sem custo informado (cost acumulado 0) → desconhecido
    sessions: {
      s1a: {
        text: '',
        updatedAt: 0,
        by: 'model',
        calls: 1,
        cost: 0,
        lastRun: {
          at: 0,
          providerId: 'p',
          model: 'mini',
          usage: { promptTokens: 1, completionTokens: 1 },
          durationMs: 1
        }
      }
    }
  })
  const s = computeChatSpend(chat, sessions, messages)
  assert.deepEqual(
    { ...s.main },
    {
      calls: 3,
      input: 3000 + 2000 + 5000,
      cacheRead: 16_000,
      cacheWrite: 1000,
      output: 900,
      reasoning: 200,
      cost: 0.15,
      costed: 2,
      tokensKnown: true
    }
  )
  assert.equal(s.subagents.calls, 2)
  assert.equal(s.subagents.input, 2000 + 3500)
  assert.equal(s.subagents.cacheRead, 1000)
  assert.equal(s.subagents.output, 600)
  assert.ok(Math.abs(s.subagents.cost - 0.018) < 1e-12)
  assert.equal(s.perSubagent.length, 1)
  assert.equal(s.perSubagent[0].label, 'Pesquisar')
  assert.equal(s.missingSessions, 1, 's1b ainda não carregada')
  assert.equal(s.judge.calls, 1)
  assert.equal(s.judge.cost, 0.002)
  assert.equal(s.judge.input, 900)
  assert.equal(s.capture.calls, 4)
  assert.equal(s.capture.costed, 3)
  assert.equal(s.capture.cost, 0.0015)
  assert.equal(s.capture.tokensKnown, false)
  assert.equal(s.title.calls, 1)
  assert.equal(s.title.cost, 0.00004)
  assert.equal(s.compaction.calls, 1)
  assert.equal(s.compaction.cost, 0.004)
  assert.equal(s.memory.calls, 0)
  assert.ok(Math.abs(s.total.cost - (0.15 + 0.018 + 0.002 + 0.0015 + 0.00004 + 0.004)) < 1e-12)
  assert.equal(s.total.calls, 3 + 2 + 1 + 4 + 1 + 1)
  assert.equal(s.total.unknown, 2, 'resposta sem custo + resumidor do subagente')
})

test('computeChatSpend: chat vazio e entrada de cache maior que o prompt', () => {
  const empty = computeChatSpend(chatWith(), [session('s1', 0)], { s1: [] })
  assert.equal(empty.total.calls, 0)
  assert.equal(empty.total.cost, 0)
  // promptTokens sem incluir o cache (provedor fora do padrão) → entrada sem cache nunca negativa
  const odd = computeChatSpend(chatWith(), [session('s1', 0)], {
    s1: [
      m(
        's1',
        { role: 'assistant', content: 'a' },
        { model: 'x', usage: { promptTokens: 100, completionTokens: 1, cachedTokens: 500 } }
      )
    ]
  })
  assert.equal(odd.main.input, 0)
  assert.equal(odd.main.cacheRead, 500)
  // resposta interrompida sem usage: chamada contada, custo desconhecido
  const cut = computeChatSpend(chatWith(), [session('s1', 0)], {
    s1: [m('s1', { role: 'assistant', content: 'meio' }, { model: 'x', interrupted: true })]
  })
  assert.equal(cut.main.calls, 1)
  assert.equal(cut.total.unknown, 1)
})

// ---------------- recolhimento ----------------

test('BAR_ITEMS: prioridades distintas onde importam e níveis começando no completo', () => {
  for (const [id, spec] of Object.entries(BAR_ITEMS)) {
    assert.equal(spec.levels[0], 0, id)
    assert.ok(spec.levels.length >= 2, id)
  }
  const p = (id: BarItemId): number => BAR_ITEMS[id].priority
  // título não é item; pendências ficam legíveis por mais tempo (o host é um ícone fixo no composer)
  assert.ok(p('approval-indicator') > p('question-indicator'))
  assert.ok(p('question-indicator') > p('session-switcher'))
  assert.ok(p('session-switcher') > p('auto-approve'))
  assert.ok(p('auto-approve') > p('processes'))
  assert.ok(p('context-meter') > p('model-pill'))
  assert.ok(p('model-pill') > p('spend'))
  assert.ok(p('spend') > p('composer-hint'))
  // composer: o ícone do host e o </> recolhem antes do grupo de voz, que nunca some (só a seta)
  assert.ok(p('voice-controls') > p('composer-host'))
  assert.ok(p('composer-host') > p('composer-info'))
  assert.ok(p('composer-info') > p('composer-hint'))
  assert.deepEqual(BAR_ITEMS['voice-controls'].levels, [0, 1])
})

test('planCollapse: tudo cabe → completo; aperta → menor prioridade desce primeiro', () => {
  const items = [
    { id: 'approval-indicator' as const, widths: { 0: 160, 1: 44 } },
    { id: 'context-meter' as const, widths: { 0: 200, 1: 110, 2: 40 } },
    { id: 'auto-approve' as const, widths: { 0: 180, 2: 28 } },
    { id: 'processes' as const, widths: { 0: 100, 1: 44 } }
  ]
  const full = 160 + 200 + 180 + 100
  assert.deepEqual(planCollapse(items, full), {
    'approval-indicator': 0,
    'context-meter': 0,
    'auto-approve': 0,
    processes: 0
  })
  // falta 40 px → só processos encolhe
  assert.deepEqual(planCollapse(items, full - 40), {
    'approval-indicator': 0,
    'context-meter': 0,
    'auto-approve': 0,
    processes: 1
  })
  // falta mais → aprovações vira ícone (e processos, que desceu antes, volta: cabe)
  assert.deepEqual(planCollapse(items, full - 100), {
    'approval-indicator': 0,
    'context-meter': 0,
    'auto-approve': 2,
    processes: 0
  })
  // o medidor desceu até o anel: a folga devolve o degrau de quem tem mais prioridade e cabe
  assert.deepEqual(planCollapse(items, 160 + 40 + 28 + 100), {
    'approval-indicator': 0,
    'context-meter': 2,
    'auto-approve': 2,
    processes: 0
  })
  const tight = planCollapse(items, 160 + 40 + 28 + 44)
  assert.equal(tight['context-meter'], 2)
  assert.equal(tight['approval-indicator'], 0)
  // nada cabe: tudo no mínimo, sem laço infinito
  assert.deepEqual(planCollapse(items, 0), {
    'approval-indicator': 1,
    'context-meter': 2,
    'auto-approve': 2,
    processes: 1
  })
})

test('planCollapse: host, </> e dica só voltam com o grupo de voz completo (yieldsTo)', () => {
  const items = [
    { id: 'voice-controls' as const, widths: { 0: 80, 1: 62 } },
    { id: 'composer-host' as const, widths: { 0: 25, 2: 0 } },
    { id: 'composer-info' as const, widths: { 0: 14, 2: 0 } }
  ]
  // falta espaço para o grupo completo (80) mas sobra para o </> (14): o </> continua recolhido
  const p = planCollapse(items, 62 + 15)
  assert.deepEqual(p, { 'voice-controls': 1, 'composer-host': 2, 'composer-info': 2 })
  // com o grupo completo, a folga devolve o host e o </>
  assert.deepEqual(planCollapse(items, 80 + 25 + 14), {
    'voice-controls': 0,
    'composer-host': 0,
    'composer-info': 0
  })
  assert.deepEqual(planCollapse(items, 80 + 14), {
    'voice-controls': 0,
    'composer-host': 2,
    'composer-info': 0
  })
  // sem o grupo de voz na barra (bloqueado): nada a esperar
  assert.deepEqual(planCollapse(items.slice(1), 14), {
    'composer-host': 2,
    'composer-info': 0
  })
})

test('planCollapse: </> não volta com o chip do arquivo recolhido (nome longo)', () => {
  const items = [
    { id: 'voice-controls' as const, widths: { 0: 80, 1: 62 } },
    { id: 'composer-file' as const, widths: { 0: 120, 1: 40 } },
    { id: 'composer-info' as const, widths: { 0: 14, 2: 0 } }
  ]
  // cabe o grupo de voz e o chip só como ícone, com folga para o </>: o </> continua recolhido
  assert.deepEqual(planCollapse(items, 80 + 40 + 20), {
    'voice-controls': 0,
    'composer-file': 1,
    'composer-info': 2
  })
  // chip completo: a folga devolve o </>
  assert.deepEqual(planCollapse(items, 80 + 120 + 14), {
    'voice-controls': 0,
    'composer-file': 0,
    'composer-info': 0
  })
})

test('planCollapse: estimativa de níveis nunca medidos e determinismo', () => {
  assert.equal(estimateWidth({ 0: 300 }, 2), 30)
  assert.equal(estimateWidth({ 0: 300 }, 1), 72)
  assert.equal(estimateWidth({ 0: 50 }, 1), 50)
  assert.equal(estimateWidth({ 0: 300, 1: 140 }, 1), 140)
  const items = [
    { id: 'model-pill' as const, widths: { 0: 260 } },
    { id: 'context-meter' as const, widths: { 0: 130 } },
    { id: 'spend' as const, widths: { 0: 60 } },
    { id: 'composer-hint' as const, widths: { 0: 220 } }
  ]
  const a = planCollapse(items, 300)
  assert.deepEqual(a, planCollapse(items, 300))
  // hint some primeiro, depois o gasto vira ícone, depois a pílula do modelo; a folga que sobra
  // devolve o gasto completo (cabe), mas não a pílula
  assert.equal(a['composer-hint'], 2)
  assert.equal(a['model-pill'], 1)
  assert.equal(a.spend, 0)
  assert.equal(a['context-meter'], 0)
  // sem folga para devolver: o gasto fica ícone
  assert.equal(planCollapse(items, 262)['spend'], 2)
})
