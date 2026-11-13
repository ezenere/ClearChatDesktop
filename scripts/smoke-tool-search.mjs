#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- script Node puro (.mjs), sem anotações de tipo */
// Smoke test PAGO (centavos) da busca nativa de ferramentas — protocolo 1.12.0.
// Responde os itens não verificados V-1…V-9 do design (conversas mínimas de dois turnos):
//   - Anthropic nativa (claude-haiku-4-5; + V-3 com pensamento: Haiku 4.5 com budget e Haiku 5.5 adaptativo)
//   - OpenRouter Messages API com um Claude (anthropic/claude-haiku-5.5)
//   - OpenRouter Messages API com um não-Claude (openai/gpt-5.6-luna) + V-7 (sem max_tokens)
//   - V-8: OpenRouter Messages + PDF num modelo sem PDF nativo (openai/gpt-5.1-codex-mini)
//
// Uso:
//   ANTHROPIC_API_KEY=… OPENROUTER_API_KEY=… node scripts/smoke-tool-search.mjs
//   node scripts/smoke-tool-search.mjs --dry-run          # só imprime os bodies (nada é enviado)
// Opções: --yes (sem a pausa de 5 s antes de começar) · --only=anthropic,or-claude,… (ids dos alvos)
// Modelos trocáveis por env: SMOKE_ANTHROPIC_MODEL, SMOKE_OR_CLAUDE_MODEL, SMOKE_OR_OTHER_MODEL,
// SMOKE_OR_NOPDF_MODEL. Node 20+, sem dependências. Chaves só por env; uma seção sem a chave é pulada.
// Nunca imprime chaves nem headers (e mascara as chaves em qualquer texto impresso).

const ARGS = new Set(process.argv.slice(2))
const DRY = ARGS.has('--dry-run')
const YES = ARGS.has('--yes')
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '')
  .slice('--only='.length)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim() || ''
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY?.trim() || ''
const SECRETS = [ANTHROPIC_KEY, OPENROUTER_KEY].filter((s) => s.length >= 8)

// URLs trocáveis só para testar o script contra um servidor falso local
const ANTHROPIC_URL = process.env.SMOKE_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01' // a mesma do app (V-9)
const OPENROUTER_BASE = process.env.SMOKE_OPENROUTER_BASE || 'https://openrouter.ai/api/v1'

// ---------------- saída (sem segredos) ----------------

function redact(s) {
  let out = String(s)
  for (const k of SECRETS) out = out.split(k).join('***')
  return out.replace(/(sk-(?:ant|or)-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g, '$1***')
}
const log = (...a) => console.log(redact(a.join(' ')))
const json = (o) => log(JSON.stringify(o))

/** Encurta strings longas e arrays grandes (mantém as chaves — é o formato que interessa). */
function trunc(v, max = 160, depth = 0) {
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…(+${v.length - max})` : v
  if (Array.isArray(v)) {
    const a = v.slice(0, 6).map((x) => trunc(x, max, depth + 1))
    if (v.length > 6) a.push(`…(+${v.length - 6} itens)`)
    return a
  }
  if (v && typeof v === 'object') {
    if (depth > 7) return '{…}'
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = trunc(x, max, depth + 1)
    return o
  }
  return v
}

// ---------------- conteúdo fixo (pequeno, no formato do app) ----------------

const EPH = { type: 'ephemeral' }
const SYSTEM = 'Você é um assistente. Responda em português, em uma frase curta.'
const PROMPT = 'Que horas são agora? Procure a ferramenta de data e hora e use-a.'

const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
// Ordem e descrições (resumidas) como no app; read_file vai carregada (como se estivesse em toolsFull).
const TOOLS = [
  {
    name: 'list_dir',
    description: 'Lista o conteúdo de uma pasta (arquivos e subpastas) relativa à raiz do chat.',
    input_schema: obj({ path: { type: 'string', description: 'Caminho da pasta.' } }, ['path'])
  },
  {
    name: 'read_file',
    description: 'Lê um arquivo de texto (ou imagem/PDF) relativo à raiz do chat.',
    input_schema: obj({ path: { type: 'string', description: 'Caminho do arquivo.' } }, ['path'])
  },
  {
    name: 'shell',
    description: 'Roda um comando no terminal (bash) na raiz do chat e devolve a saída.',
    input_schema: obj({ command: { type: 'string', description: 'Comando a executar.' } }, [
      'command'
    ])
  },
  {
    name: 'web_search',
    description: 'Pesquisa na web e devolve títulos, links e trechos dos resultados.',
    input_schema: obj({ query: { type: 'string', description: 'Termos da pesquisa.' } }, ['query'])
  },
  {
    name: 'datetime',
    description:
      'Data e hora atuais do aparelho que roda o chat, no fuso dele. Sem format: ISO 8601 com o deslocamento, o dia da semana e o fuso (IANA e UTC±hh:mm). Com format: códigos de strftime.',
    input_schema: obj({
      format: {
        type: 'string',
        description: 'Opcional: formato com códigos de strftime (ex.: "%A, %d de %B de %Y, %H:%M").'
      }
    })
  }
]
const LOADED = ['read_file']

const SEARCH_ENTRY = {
  anthropic: { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
  openrouter: { type: 'openrouter:tool_search' }
}

/** tools[] no formato da Messages API: adiadas com defer_loading, cache numa não adiada, busca por último. */
function toolsFor(t, { omit = [], loaded = LOADED } = {}) {
  const list = TOOLS.filter((d) => !omit.includes(d.name)).map((d) =>
    loaded.includes(d.name) ? { ...d } : { ...d, defer_loading: true }
  )
  const lastLoaded = list.map((d) => !d.defer_loading).lastIndexOf(true)
  if (lastLoaded >= 0) list[lastLoaded] = { ...list[lastLoaded], cache_control: EPH }
  list.push(SEARCH_ENTRY[t.provider])
  return list
}

/** Resultado da datetime no formato do app (sem format). */
function nowString() {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')
  const mm = String(Math.abs(off) % 60).padStart(2, '0')
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19)
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const wd = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' }).format(d)
  return `${local}${sign}${hh}:${mm} · ${wd} · fuso ${tz} (UTC${sign}${hh}:${mm})`
}

/** PDF mínimo de uma página (ASCII), gerado aqui com os offsets do xref corretos. */
function tinyPdfBase64() {
  const content = 'BT /F1 12 Tf 10 40 Td (ClearChat smoke test: the secret word is PAPAYA.) Tj ET'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 80] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offs = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  out += offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1').toString('base64')
}

// ---------------- alvos e passos ----------------

const ENV = process.env
const TARGETS = [
  {
    id: 'anthropic',
    provider: 'anthropic',
    model: ENV.SMOKE_ANTHROPIC_MODEL || 'claude-haiku-4-5',
    maxTokens: 400,
    steps: ['search', 'replay', 'tool-removed', 'refs-empty', 'undiscovered']
  },
  {
    // V-3: pensamento ligado (como um extraBody `thinking` do usuário no Haiku 4.5)
    id: 'anthropic-thinking',
    provider: 'anthropic',
    model: ENV.SMOKE_ANTHROPIC_MODEL || 'claude-haiku-4-5',
    maxTokens: 1600,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    steps: ['search', 'replay']
  },
  {
    // V-3: modelo que pensa por padrão (adaptativo, sem o campo thinking — como o app envia)
    id: 'anthropic-adaptive',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    maxTokens: 1024,
    steps: ['search', 'replay']
  },
  {
    id: 'or-claude',
    provider: 'openrouter',
    model: ENV.SMOKE_OR_CLAUDE_MODEL || 'anthropic/claude-haiku-5.5',
    maxTokens: 1024,
    steps: ['search', 'replay', 'tool-removed', 'refs-empty', 'undiscovered']
  },
  {
    id: 'or-other',
    provider: 'openrouter',
    model: ENV.SMOKE_OR_OTHER_MODEL || 'openai/gpt-5.6-luna',
    maxTokens: 1024,
    effort: 'low',
    steps: ['search', 'replay', 'tool-removed', 'refs-empty', 'undiscovered', 'no-max-tokens']
  },
  {
    id: 'or-pdf',
    provider: 'openrouter',
    model: ENV.SMOKE_OR_NOPDF_MODEL || 'openai/gpt-5.1-codex-mini',
    maxTokens: 300,
    effort: 'low',
    steps: ['pdf']
  }
]

/** Quais V-n cada passo responde. */
function answersFor(t, step) {
  const a = []
  if (step === 'replay') a.push('baseline') // reenvio literal (sem pensamento) + tool_result
  if (t.provider === 'anthropic' && step === 'search') a.push('V-9')
  if (step === 'undiscovered' || step === 'undiscovered-loaded') a.push('V-1')
  if (step === 'tool-removed' || step === 'refs-empty') a.push('V-2')
  if ((t.thinking || t.id === 'anthropic-adaptive') && step.startsWith('replay')) a.push('V-3')
  if (t.provider === 'openrouter' && step !== 'pdf') a.push('V-4')
  if (t.provider === 'openrouter' && step.startsWith('replay')) a.push('V-5')
  if (t.id === 'or-other' && step === 'search') a.push('V-6')
  if (step === 'no-max-tokens') a.push('V-7')
  if (step === 'pdf') a.push('V-8')
  if (step === 'canonical') a.push('V-1', 'V-3')
  return [...new Set(a)]
}

/** Marca o último bloco da última mensagem e da mensagem do usuário (como o app), nunca um bloco do servidor. */
function withCache(messages) {
  const CACHEABLE = new Set(['text', 'image', 'document', 'tool_use', 'tool_result'])
  const out = messages.map((m) => ({ ...m, content: m.content.map((b) => ({ ...b })) }))
  const markLast = (m) => {
    for (let i = m.content.length - 1; i >= 0; i--) {
      if (CACHEABLE.has(m.content[i].type)) {
        m.content[i].cache_control = EPH
        return
      }
    }
  }
  if (out.length) markLast(out[out.length - 1])
  if (out.length > 1 && out[0].role === 'user') markLast(out[0])
  return out
}

function body(t, { messages, tools, noMaxTokens = false }) {
  const b = { model: t.model }
  if (!noMaxTokens) b.max_tokens = t.maxTokens
  b.system = [{ type: 'text', text: SYSTEM, cache_control: EPH }]
  b.messages = withCache(messages)
  if (tools) b.tools = tools
  if (t.thinking) b.thinking = t.thinking
  if (t.effort) b.output_config = { effort: t.effort }
  b.stream = true
  return b
}

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const isThinking = (b) => b.type === 'thinking' || b.type === 'redacted_thinking'
const dropThinking = (content) => content.filter((b) => !isThinking(b))
const hasType = (content, type) => content.some((b) => b.type === type)

/** Tira das tool_references os nomes fora de `names` (cópia). */
function filterRefs(content, names) {
  return content.map((b) =>
    b.type === 'tool_search_tool_result' && Array.isArray(b.content?.tool_references)
      ? {
          ...b,
          content: {
            ...b.content,
            tool_references: b.content.tool_references.filter((r) => names.includes(r.tool_name))
          }
        }
      : b
  )
}

/** user com um tool_result por tool_use do turno 1 (ou um texto, se não houve tool_use). */
function toolResults(content) {
  const uses = content.filter((b) => b.type === 'tool_use')
  if (!uses.length) return user('Obrigado. Responda só: OK.')
  return {
    role: 'user',
    content: uses.map((u) => ({
      type: 'tool_result',
      tool_use_id: u.id,
      content: u.name === 'datetime' ? nowString() : 'ok'
    }))
  }
}

/** Conversão canônica (o que o app manda quando `native` é descartado): texto + tool_use. */
function canonical(content) {
  const text = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const blocks = text ? [{ type: 'text', text }] : []
  for (const b of content)
    if (b.type === 'tool_use')
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
  return blocks
}

const V1_ID = 'toolu_01SmokeUndiscovered0001'
const allNames = (omit = []) => TOOLS.map((d) => d.name).filter((n) => !omit.includes(n))

/**
 * Monta a request de um passo. `t1` = conteúdo (blocos) da resposta do turno 1.
 * null = passo não se aplica (motivo em `skip`).
 */
function buildStep(t, step, t1) {
  switch (step) {
    case 'search':
      return { body: body(t, { messages: [user(PROMPT)], tools: toolsFor(t) }) }
    case 'replay':
      return {
        body: body(t, {
          messages: [
            user(PROMPT),
            { role: 'assistant', content: dropThinking(t1) },
            toolResults(t1)
          ],
          tools: toolsFor(t)
        })
      }
    case 'replay-keep-thinking':
      if (!t1.some(isThinking)) return { skip: 'turno 1 sem blocos de pensamento' }
      return {
        body: body(t, {
          messages: [user(PROMPT), { role: 'assistant', content: t1 }, toolResults(t1)],
          tools: toolsFor(t)
        })
      }
    case 'canonical':
      return {
        body: body(t, {
          messages: [user(PROMPT), { role: 'assistant', content: canonical(t1) }, toolResults(t1)],
          tools: toolsFor(t)
        })
      }
    case 'tool-removed': {
      // datetime desligada depois: some do tools[]; a referência a ela sai; o tool_use histórico fica
      const omit = ['datetime']
      return {
        body: body(t, {
          messages: [
            user(PROMPT),
            { role: 'assistant', content: filterRefs(dropThinking(t1), allNames(omit)) },
            toolResults(t1)
          ],
          tools: toolsFor(t, { omit })
        })
      }
    }
    case 'refs-empty':
      if (!hasType(t1, 'tool_search_tool_result'))
        return { skip: 'turno 1 sem tool_search_tool_result (nada a filtrar)' }
      return {
        body: body(t, {
          messages: [
            user(PROMPT),
            { role: 'assistant', content: filterRefs(dropThinking(t1), []) },
            toolResults(t1)
          ],
          tools: toolsFor(t)
        })
      }
    case 'undiscovered':
    case 'undiscovered-loaded':
      // V-1: tool_use histórico de uma tool adiada que nenhuma busca no histórico revelou
      return {
        body: body(t, {
          messages: [
            user('Que horas são?'),
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: V1_ID, name: 'datetime', input: {} }]
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: V1_ID, content: nowString() }]
            }
          ],
          tools: toolsFor(
            t,
            step === 'undiscovered-loaded' ? { loaded: [...LOADED, 'datetime'] } : {}
          )
        })
      }
    case 'no-max-tokens':
      // V-7 isolado (sem tools: um passe só, o teto de custo fica no limite de saída do modelo)
      return { body: body(t, { messages: [user('Responda só: OK.')], noMaxTokens: true }) }
    case 'pdf':
      return {
        body: body(t, {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: tinyPdfBase64() }
                },
                { type: 'text', text: 'Qual é a palavra secreta no PDF? Responda só a palavra.' }
              ]
            }
          ]
        })
      }
    default:
      throw new Error(`passo desconhecido: ${step}`)
  }
}

/** O passo parte da resposta do turno 1? */
const NEEDS_T1 = (step) =>
  !['search', 'undiscovered', 'undiscovered-loaded', 'no-max-tokens', 'pdf'].includes(step)

/** Diagnósticos que só rodam quando um passo falha. */
const DIAG = {
  replay: ['replay-keep-thinking', 'canonical'],
  undiscovered: ['undiscovered-loaded']
}

// ---------------- custo ----------------

// USD por 1M tokens [entrada, saída]. O OpenRouter é atualizado pelo /models público antes de rodar.
const PRICES = {
  'claude-haiku-4-5': [1, 5],
  'claude-haiku-5-5': [0.1, 0.5],
  'anthropic/claude-haiku-5.5': [0.1, 0.5],
  'openai/gpt-5.6-luna': [0.2, 1.2],
  'openai/gpt-5.1-codex-mini': [0.25, 2]
}
const UNKNOWN_PRICE = [10, 50]
const MAX_COMPLETION = {} // do /models do OpenRouter
const priceOf = (model) => PRICES[model] ?? UNKNOWN_PRICE
const OCR_PAGE_USD = 0.002 // pior caso do file-parser (mistral-ocr) para 1 página

/**
 * Estimativa de uma request: entrada ≈ chars/3 + prompts do servidor (tool use + busca); com a busca
 * no tools[], o servidor amostra mais de uma vez (esperado 2; pior caso 10 na Anthropic — limite do
 * pause_turn — e 30 no OpenRouter — orçamento padrão de passos).
 */
function estimate(t, b) {
  const [pin, pout] = priceOf(t.model)
  const hasSearch = (b.tools ?? []).some((x) => x.type && x.type !== 'custom')
  const inTok =
    Math.ceil(JSON.stringify(b).length / 3) + (b.tools ? 400 : 0) + (hasSearch ? 1000 : 0)
  const maxOut = b.max_tokens ?? MAX_COMPLETION[t.model] ?? 128000
  const passesExp = hasSearch ? 2 : 1
  const passesMax = hasSearch ? (t.provider === 'anthropic' ? 10 : 30) : 1
  const outExp = Math.min(maxOut, t.thinking ? 1100 : 250)
  // Anthropic: max_tokens limita a resposta inteira; OpenRouter: suponha por passe (pior caso)
  const outMax = t.provider === 'anthropic' ? maxOut : maxOut * passesMax
  const pdf = b.messages.some((m) => m.content.some((x) => x.type === 'document'))
    ? OCR_PAGE_USD
    : 0
  return {
    expected: (inTok * passesExp * pin + outExp * pout) / 1e6 + pdf,
    worst: (inTok * passesMax * pin + outMax * pout) / 1e6 + pdf
  }
}

/** Custo real de uma resposta Anthropic pelo usage (cache: escrita 1,25×, leitura 0,1×). */
function anthropicCost(model, u) {
  if (!u) return 0
  const [pin, pout] = priceOf(model)
  const i =
    (u.input_tokens ?? 0) +
    1.25 * (u.cache_creation_input_tokens ?? 0) +
    0.1 * (u.cache_read_input_tokens ?? 0)
  return (i * pin + (u.output_tokens ?? 0) * pout) / 1e6
}

// ---------------- dados sintéticos (dry-run: o turno 2 parte de uma resposta "documentada") ----------------

function syntheticT1(t) {
  const use = { type: 'tool_use', id: 'toolu_01SyntheticDatetime', name: 'datetime', input: {} }
  if (t.provider === 'anthropic' || /^anthropic\//.test(t.model))
    return [
      { type: 'text', text: 'Vou ver a hora.' },
      {
        type: 'server_tool_use',
        id: 'srvtoolu_01Synthetic',
        name: 'tool_search_tool_regex',
        input: { pattern: 'hora|time|date' }
      },
      {
        type: 'tool_search_tool_result',
        tool_use_id: 'srvtoolu_01Synthetic',
        content: {
          type: 'tool_search_tool_search_result',
          tool_references: [{ type: 'tool_reference', tool_name: 'datetime' }]
        }
      },
      use
    ]
  return [
    {
      type: 'server_tool_use',
      id: 'srvtoolu_01Synthetic',
      name: 'tool_search',
      input: { pattern: 'hora|time|date' }
    },
    {
      type: 'openrouter_tool_search_result',
      tool_use_id: 'srvtoolu_01Synthetic',
      content: { matches: [] }
    },
    use
  ]
}

// ---------------- rede ----------------

function endpoint(t) {
  if (t.provider === 'anthropic')
    return {
      url: ANTHROPIC_URL,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': ANTHROPIC_KEY
      }
    }
  return {
    url: `${OPENROUTER_BASE}/messages`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'X-Title': 'ClearChat smoke test'
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseError(status, text) {
  try {
    const j = JSON.parse(text)
    const e = j.error ?? j
    const out = { type: e.type ?? e.code ?? null, message: e.message ?? text.slice(0, 400) }
    if (e.metadata) out.metadata = trunc(e.metadata)
    return out
  } catch {
    return { type: null, message: text.slice(0, 400) || `HTTP ${status}` }
  }
}

/** Aplica um evento SSE da Messages API, guardando os blocos completos na ordem. */
function applyEvent(acc, ev) {
  acc.events[ev.type] = (acc.events[ev.type] ?? 0) + 1
  switch (ev.type) {
    case 'message_start':
      acc.usageStart = ev.message?.usage ?? null
      acc.model = ev.message?.model
      return
    case 'content_block_start': {
      const b = structuredClone(ev.content_block ?? {})
      if (b.type === 'tool_use' || b.type === 'server_tool_use') b._json = ''
      acc.blocks[ev.index ?? acc.blocks.length] = b
      return
    }
    case 'content_block_delta': {
      const b = acc.blocks[ev.index]
      const d = ev.delta ?? {}
      if (!b) return
      if (d.type === 'text_delta') b.text = (b.text ?? '') + (d.text ?? '')
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + (d.thinking ?? '')
      else if (d.type === 'signature_delta') b.signature = (b.signature ?? '') + (d.signature ?? '')
      else if (d.type === 'input_json_delta') b._json = (b._json ?? '') + (d.partial_json ?? '')
      else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation)
      else acc.unknownDeltas[d.type] = (acc.unknownDeltas[d.type] ?? 0) + 1
      return
    }
    case 'content_block_stop': {
      const b = acc.blocks[ev.index]
      if (b && '_json' in b) {
        if (b._json.trim()) {
          try {
            b.input = JSON.parse(b._json)
          } catch {
            b.input = { _unparsed: b._json }
          }
        } else b.input ??= {}
        delete b._json
      }
      return
    }
    case 'message_delta':
      if (ev.delta?.stop_reason) acc.stopReason = ev.delta.stop_reason
      acc.usageDelta = ev.usage ?? null
      return
    case 'error':
      acc.streamError = ev.error ?? ev
      return
    default:
      return // ping, message_stop
  }
}

async function readSse(res, acc) {
  const dec = new TextDecoder()
  let buf = ''
  const flush = (chunk) => {
    const data = chunk
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    try {
      applyEvent(acc, JSON.parse(data))
    } catch {
      acc.badEvents = (acc.badEvents ?? 0) + 1
    }
  }
  for await (const piece of res.body) {
    buf += dec.decode(piece, { stream: true })
    let m
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      flush(buf.slice(0, m.index))
      buf = buf.slice(m.index + m[0].length)
    }
  }
  if (buf.trim()) flush(buf)
}

/** Custo pelo /generation (grátis): fallback quando o stream não traz usage.cost. */
async function generationCost(id) {
  for (const wait of [700, 1500, 3000, 5000]) {
    await sleep(wait)
    try {
      const r = await fetch(`${OPENROUTER_BASE}/generation?id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
        signal: AbortSignal.timeout(20000)
      })
      if (r.status === 404) continue
      if (!r.ok) return { status: r.status }
      const d = (await r.json())?.data ?? {}
      return {
        status: 200,
        total_cost: d.total_cost ?? null,
        tokens_prompt: d.tokens_prompt ?? d.native_tokens_prompt ?? null,
        tokens_completion: d.tokens_completion ?? d.native_tokens_completion ?? null,
        provider: d.provider_name ?? null
      }
    } catch (e) {
      return { error: String(e?.message ?? e) }
    }
  }
  return { status: 404, note: 'generation ainda não disponível depois de ~10 s' }
}

/** Resumo do que interessa a V-1…V-9 (sem texto longo, sem headers). */
function summarize(acc) {
  const blocks = acc.blocks.filter(Boolean)
  const KNOWN = new Set([
    'text',
    'thinking',
    'redacted_thinking',
    'tool_use',
    'server_tool_use',
    'tool_search_tool_result',
    'openrouter_tool_search_result'
  ])
  const s = {
    stop_reason: acc.stopReason ?? null,
    blocks: blocks.map((b) => b.type)
  }
  const stu = blocks.filter((b) => b.type === 'server_tool_use')
  if (stu.length)
    s.server_tool_use = stu.map((b) => ({
      id: String(b.id ?? '').slice(0, 10) + '…',
      name: b.name,
      input: b.input
    }))
  const tsr = blocks.filter((b) => b.type === 'tool_search_tool_result')
  if (tsr.length)
    s.tool_search_tool_result = tsr.map((b) => ({
      content_type: b.content?.type,
      tool_references: b.content?.tool_references?.map((r) => r.tool_name),
      ...(b.content?.error_code ? { error_code: b.content.error_code } : {})
    }))
  const orr = blocks.filter((b) => b.type === 'openrouter_tool_search_result')
  if (orr.length) s.openrouter_tool_search_result = orr.map((b) => trunc(b)) // V-5: formato exato
  const uses = blocks.filter((b) => b.type === 'tool_use')
  if (uses.length) s.tool_use = uses.map((b) => ({ name: b.name, input: b.input }))
  const th = blocks.filter(isThinking)
  if (th.length)
    s.thinking = th.map((b) => ({
      type: b.type,
      chars: (b.thinking ?? '').length,
      signature: !!b.signature,
      data: !!b.data
    }))
  const other = blocks.filter((b) => !KNOWN.has(b.type))
  if (other.length) s.other_blocks = other.map((b) => trunc(b))
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  if (text) s.text = text.length > 160 ? `${text.slice(0, 160)}…` : text
  s.usage = { message_start: acc.usageStart ?? null, message_delta: acc.usageDelta ?? null }
  if (Object.keys(acc.unknownDeltas).length) s.unknown_deltas = acc.unknownDeltas
  const odd = Object.keys(acc.events).filter(
    (k) =>
      ![
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
        'ping'
      ].includes(k)
  )
  if (odd.length) s.other_events = odd
  if (acc.badEvents) s.unparsed_events = acc.badEvents
  if (acc.streamError) s.stream_error = trunc(acc.streamError)
  return s
}

const COST = { anthropic: 0, openrouter: 0, openrouterUnknown: 0 }

async function send(t, step, b) {
  const { url, headers } = endpoint(t)
  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(180000)
    })
  } catch (e) {
    return {
      ok: false,
      out: { status: 0, error: { type: 'network', message: String(e?.message ?? e) } }
    }
  }
  const out = { status: res.status }
  const genId = res.headers.get('x-generation-id') // não é impresso; só usado no /generation
  if (t.provider === 'openrouter') out.has_generation_id = !!genId
  const acc = { blocks: [], events: {}, unknownDeltas: {} }
  if (!res.ok) {
    out.error = parseError(res.status, await res.text())
  } else if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    // provedor ignorou stream:true — resposta inteira
    const msg = await res.json()
    out.non_stream = true
    acc.blocks = msg.content ?? []
    acc.stopReason = msg.stop_reason
    acc.usageDelta = msg.usage
  } else {
    try {
      await readSse(res, acc)
    } catch (e) {
      out.read_error = String(e?.message ?? e)
    }
  }
  out.ms = Date.now() - t0
  const ok = res.ok && !acc.streamError && !out.read_error
  if (res.ok) Object.assign(out, summarize(acc))
  // custo
  if (t.provider === 'anthropic') {
    const c = anthropicCost(t.model, { ...(acc.usageStart ?? {}), ...(acc.usageDelta ?? {}) })
    out.cost_usd_est = Number(c.toFixed(6))
    COST.anthropic += c
  } else {
    const streamCost = acc.usageDelta?.cost ?? acc.usageStart?.cost
    out.stream_usage_cost = streamCost ?? null // V-4
    if (genId) {
      out.generation = await generationCost(genId)
    }
    const c = streamCost ?? out.generation?.total_cost
    if (typeof c === 'number') COST.openrouter += c
    else if (res.ok) COST.openrouterUnknown++
  }
  return { ok, out, content: acc.blocks.filter(Boolean) }
}

// ---------------- execução ----------------

const RESULTS = []

async function exec(t, step, t1, diag = null) {
  const built = buildStep(t, step, t1)
  const head = { target: t.id, model: t.model, step, answers: answersFor(t, step) }
  if (built.skip) {
    json({ ...head, skipped: built.skip })
    return { ok: true, skipped: true }
  }
  if (DRY) {
    const note = [
      NEEDS_T1(step) ? 'turno 2 montado a partir de uma resposta sintética' : '',
      diag ? `diagnóstico: só roda se "${diag}" falhar` : ''
    ].filter(Boolean)
    log(
      `\n--- ${t.id} · ${step} → POST ${endpoint(t).url}${note.length ? `  (${note.join('; ')})` : ''}`
    )
    log(JSON.stringify(trunc(built.body, 400), null, 2)) // só o PDF em base64 é encurtado
    return { ok: true, content: step === 'search' ? syntheticT1(t) : [] }
  }
  const r = await send(t, step, built.body)
  const line = { ...head, ...r.out }
  RESULTS.push(line)
  json(line)
  return r
}

async function runTarget(t) {
  log(`\n=== ${t.id} (${t.provider}, ${t.model}) ===`)
  let t1 = null
  for (const step of t.steps) {
    if (NEEDS_T1(step) && !t1) {
      json({
        target: t.id,
        model: t.model,
        step,
        answers: answersFor(t, step),
        skipped: 'turno 1 falhou'
      })
      continue
    }
    let r = await exec(t, step, t1)
    if (step === 'search' && r.ok && !r.skipped) {
      let content = r.content
      // pause_turn: reenvia o turno do assistente sem nova mensagem do usuário (uma vez)
      if (!DRY && r.out?.stop_reason === 'pause_turn') {
        const b = body(t, {
          messages: [user(PROMPT), { role: 'assistant', content }],
          tools: toolsFor(t)
        })
        const r2 = await send(t, 'resume', b)
        json({ target: t.id, model: t.model, step: 'resume', answers: [], ...r2.out })
        if (r2.ok) content = [...content, ...r2.content]
      }
      t1 = content
    }
    // diagnósticos: só quando o passo falha (no dry-run, os bodies são impressos assim mesmo)
    if ((DRY || !r.ok) && DIAG[step] && (t1 || step === 'undiscovered')) {
      for (const d of DIAG[step]) await exec(t, d, t1, step)
    }
  }
}

function planCost(targets) {
  let expected = 0
  let worst = 0
  const rows = []
  for (const t of targets) {
    const t1 = syntheticT1(t)
    const steps = [...t.steps, ...t.steps.flatMap((s) => DIAG[s] ?? [])]
    let te = 0
    let tw = 0
    let n = 0
    for (const s of steps) {
      const built = buildStep(t, s, t1)
      if (built.skip) continue
      n++
      const e = estimate(t, built.body)
      if (!(DIAG.replay.includes(s) || DIAG.undiscovered.includes(s))) te += e.expected
      tw += e.worst
    }
    expected += te
    worst += tw
    rows.push({
      target: t.id,
      model: t.model,
      requests_max: n,
      expected_usd: Number(te.toFixed(4)),
      worst_usd: Number(tw.toFixed(4))
    })
  }
  return { rows, expected, worst }
}

async function refreshOpenRouterCatalog(models) {
  try {
    const r = await fetch(`${OPENROUTER_BASE}/models`, { signal: AbortSignal.timeout(20000) })
    if (!r.ok) return log(`(catálogo do OpenRouter: HTTP ${r.status} — usando os preços embutidos)`)
    const data = (await r.json())?.data ?? []
    for (const id of models) {
      const m = data.find((x) => x.id === id)
      if (!m) {
        log(`AVISO: ${id} não está no /models do OpenRouter.`)
        continue
      }
      const pin = Number(m.pricing?.prompt) * 1e6
      const pout = Number(m.pricing?.completion) * 1e6
      if (Number.isFinite(pin) && Number.isFinite(pout)) PRICES[id] = [pin, pout]
      if (m.top_provider?.max_completion_tokens)
        MAX_COMPLETION[id] = m.top_provider.max_completion_tokens
      const eps = m.endpoints ?? []
      json({
        catalog: id,
        price_per_mtok: PRICES[id],
        messages_endpoint: eps.includes('/api/v1/messages'),
        input_modalities: m.architecture?.input_modalities ?? null
      })
    }
  } catch (e) {
    log(`(catálogo do OpenRouter indisponível: ${e?.message ?? e} — usando os preços embutidos)`)
  }
}

function summary() {
  const by = {}
  for (const r of RESULTS)
    for (const v of r.answers)
      (by[v] ??= []).push(
        `${r.target}/${r.step}: ${r.status}${r.stop_reason ? ` ${r.stop_reason}` : ''}${r.error ? ` ${r.error.type ?? ''} ${String(r.error.message ?? '').slice(0, 120)}` : ''}${r.stream_error ? ' stream_error' : ''}`
      )
  const or = RESULTS.filter((r) => r.target.startsWith('or-'))
  by['V-4 detail'] = {
    stream_usage_has_cost: or.filter((r) => typeof r.stream_usage_cost === 'number').length,
    generation_total_cost: or.filter((r) => typeof r.generation?.total_cost === 'number').length,
    of: or.filter((r) => r.status === 200).length
  }
  json({ summary: by })
  json({
    cost_usd: {
      anthropic_from_usage: Number(COST.anthropic.toFixed(5)),
      openrouter_reported: Number(COST.openrouter.toFixed(5)),
      openrouter_without_cost: COST.openrouterUnknown
    }
  })
}

async function main() {
  const [major] = process.versions.node.split('.').map(Number)
  if (major < 20) {
    console.error('Precisa de Node 20+.')
    process.exit(1)
  }
  let targets = TARGETS.filter((t) => !ONLY.length || ONLY.includes(t.id))
  if (!DRY) {
    const missing = []
    targets = targets.filter((t) => {
      const has = t.provider === 'anthropic' ? !!ANTHROPIC_KEY : !!OPENROUTER_KEY
      if (!has) missing.push(t.id)
      return has
    })
    if (missing.length)
      log(
        `Pulados (sem ${[...new Set(missing.map((id) => (id.startsWith('or-') ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY')))].join(' / ')}): ${missing.join(', ')}`
      )
    if (!targets.length) {
      log('Nada a rodar: defina ANTHROPIC_API_KEY e/ou OPENROUTER_API_KEY (ou use --dry-run).')
      process.exit(1)
    }
    const orModels = [
      ...new Set(targets.filter((t) => t.provider === 'openrouter').map((t) => t.model))
    ]
    if (orModels.length) await refreshOpenRouterCatalog(orModels)
  }
  const plan = planCost(targets)
  log(`\nPlano${DRY ? ' (dry-run: preços embutidos; nada é enviado)' : ''}:`)
  for (const row of plan.rows) json(row)
  log(
    `Custo estimado: ~US$ ${plan.expected.toFixed(3)} (esperado) · teto US$ ${plan.worst.toFixed(3)} (pior caso: busca com o máximo de passes do servidor, todos os diagnósticos e a saída inteira em todos os passes)`
  )
  if (!DRY && !YES) {
    log('Começando em 5 s — Ctrl+C cancela (--yes pula a espera).')
    await sleep(5000)
  }
  for (const t of targets) await runTarget(t)
  if (!DRY) summary()
}

main().catch((e) => {
  console.error(redact(e?.stack ?? String(e)))
  process.exit(1)
})
