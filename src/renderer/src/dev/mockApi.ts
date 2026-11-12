// SOMENTE DESENVOLVIMENTO: window.api simulado para validar o design sem backend.
// Carregado apenas quando o renderer é buildado com VITE_CLEAR_MOCK=1 (ver main.tsx).
import { DEFAULT_CHAT_CONFIG } from '@shared/defaults'
import { createMockVoiceCatalog } from './mockVoiceCatalog'
import { createMockGpu } from './mockGpu'
import { providerKind } from '@shared/providerKinds'
import {
  defaultSkillsSettings,
  normalizeSkillsSettings,
  type SkillInfo,
  type SkillsDiscovery,
  type SkillsSettings
} from '@shared/skills'
import type {
  ClearApi,
  TtsClipsView,
  TtsClipProgressEvent,
  TtsSynthResult,
  TtsVoicesView,
  VoiceApi,
  VoiceCallTimelineEvent,
  VoiceCallUtteranceCancelEvent,
  VoiceCallUtteranceEvent,
  VoiceModelInfo,
  VoiceModelProgressEvent,
  VoiceRuntimeStatus,
  VoicePartialEvent,
  VoiceSettingKind,
  VoiceSettingsMap,
  WebSearchSettingsState
} from '@shared/ipc'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS,
  VOICE_CALL_INACTIVE,
  normalizeAudioInput,
  normalizeSttSettings,
  normalizeTtsSettings,
  normalizeVoiceCallDefaults,
  applyTtsChoice,
  normalizeVoiceCallConfig,
  normalizeVoiceTtsChoice,
  resolveFillerPool,
  resolveSttVoice,
  resolveToolPhrasePool,
  resolveTtsVoice,
  resolveTurnSilenceMs,
  type SttLocalEngine,
  type SttSettings,
  type TtsLocalEngine,
  type TtsSettings,
  type VoiceCallState,
  type VoiceCheck,
  type VoiceDeviceCaps
} from '@shared/voice'
import { providerSupportsVoice } from '@shared/voiceCatalog'
import type { UpdateStatus } from '@shared/updates'
import { OFFICIAL_SYNC_URL, type SyncStatus } from '@shared/sync'
import {
  isApiEngine,
  maskKey,
  normalizeEngines,
  type SearchEngineId
} from '@shared/webSearchSettings'
import { copyName, sanitizePresetConfig } from '@shared/presets'
import {
  activeLeaf,
  activePath,
  buildTree,
  lastTurnAnchor,
  selectionToReach,
  selKey,
  turnAnchor,
  turnResponse
} from '@shared/branches'
import { isDisplayOnly } from '@shared/context'
import { contentText } from '@shared/attachments'
import { siblingBroadcastText, siblingMessageText } from '@shared/siblings'
import { evaluateLists, isListItem, normalizeApprovalSettings } from '@shared/approvalPolicy'
import { formatCallDuration, type VoiceCallMark } from '@shared/voiceCallMarks'
import {
  createMemoryMock,
  extractionRequest,
  mockChatMemory,
  mockPersonaMemory,
  MOCK_COLS
} from './mockMemory'
import {
  createMockRemoteFs,
  createMockViewer,
  mockPlatform,
  seedViewerScenario
} from './mockViewer'
import type {
  ApprovalSettings,
  AgentEvent,
  ApprovalRequest,
  Chat,
  ModelInfo,
  Preset,
  ProcessInfo,
  Provider,
  QueuedMessage,
  QuestionRequest,
  RetryRequest,
  Session,
  StoredMessage
} from '@shared/types'

const HOME = '/home/dev'
const now = Date.now()
let seq = 0
const id = (p: string): string => `${p}-${++seq}`

export function createMockApi(scenario: string): ClearApi {
  const listeners = new Set<(e: AgentEvent) => void>()
  const processes: ProcessInfo[] = [
    {
      id: 'p1',
      chatId: 'c1',
      sessionId: 's1',
      name: 'vite',
      command: 'npm run dev',
      cwd: `${HOME}/projetos/clearchat`,
      pid: 4242,
      status: 'running',
      exitCode: null,
      signal: null,
      startedAt: now - 7 * 60_000,
      endedAt: null,
      lines: 38,
      lastLine: '  ➜  Local:   http://localhost:5173/',
      logFile: `${HOME}/.config/ClearChat/processes/c1-p1.log`
    }
  ]
  // ?scenario=processes → também encerrados ainda listados (código 0 e falha), para o chip neutro;
  // ?scenario=processes-many → 30 processos (lista do popover rola)
  if (scenario === 'processes' || scenario === 'processes-many') {
    const done = (
      pid: string,
      name: string,
      command: string,
      exitCode: number,
      lastLine: string
    ): ProcessInfo => ({
      ...processes[0],
      id: pid,
      name,
      command,
      pid: null,
      status: 'exited',
      exitCode,
      startedAt: now - 5 * 60_000,
      endedAt: now - 4 * 60_000,
      lines: 12,
      lastLine,
      logFile: `${HOME}/.config/ClearChat/processes/c1-${pid}.log`
    })
    processes.push(
      done('p2', 'build', 'npm run build', 0, '✓ built in 3.2s'),
      done('p3', 'testes', 'npm test', 1, 'Tests: 2 failed, 41 passed')
    )
    if (scenario === 'processes-many')
      for (let i = 4; i <= 30; i++)
        processes.push(
          i % 3
            ? done(`p${i}`, `job ${i}`, `./scripts/job.sh ${i}`, i % 5 ? 0 : 2, `job ${i} fim`)
            : { ...processes[0], id: `p${i}`, name: `worker ${i}`, pid: 5000 + i }
        )
  }
  const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))
  // parciais ao vivo da transcrição (canal `voice:partial`) — só o mock de áudio emite
  const voiceListeners = new Set<(e: VoicePartialEvent) => void>()
  // progresso de download de modelos locais (canal `voice:models:progress`)
  const voiceModelListeners = new Set<(e: VoiceModelProgressEvent) => void>()
  // progresso da geração de clipes de voz (canal `voice:tts:clips:progress`)
  const voiceTtsClipListeners = new Set<(e: TtsClipProgressEvent) => void>()
  // estado da chamada de voz (canal `voice:call:state`) + utterances faladas (`voice:call:utterance`)
  const voiceCallStateListeners = new Set<(e: VoiceCallState) => void>()
  const voiceCallUtteranceListeners = new Set<(e: VoiceCallUtteranceEvent) => void>()
  // gancho para os E2E contra o mock (só existe neste build de desenvolvimento)
  ;(window as unknown as { __clearMockEmit?: typeof emit }).__clearMockEmit = emit

  const providers: Provider[] =
    scenario === 'onboarding'
      ? []
      : [
          {
            id: 'p1',
            name: 'OpenRouter',
            kind: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'sk-or-v1-9f8e7d6c5b4a3f2e1d0c',
            headers: {},
            createdAt: now
          },
          {
            id: 'p2',
            name: 'Local (LM Studio)',
            kind: 'openai',
            baseUrl: 'http://localhost:1234/v1',
            apiKey: '',
            headers: {},
            createdAt: now
          },
          // Groq cadastrado (OpenAI-compatível com chave) — o provedor padrão da transcrição no mock
          {
            id: 'p4',
            name: 'Groq',
            kind: 'openai',
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKey: 'gsk_mock_0000000000000000abcd',
            headers: {},
            createdAt: now
          },
          // provedor só de voz (ElevenLabs direto) — cenário da descoberta de vozes
          ...(scenario === 'voice-elevenlabs'
            ? [
                {
                  id: 'p3',
                  name: 'ElevenLabs',
                  kind: 'elevenlabs' as const,
                  baseUrl: 'https://api.elevenlabs.io',
                  apiKey: 'xi-mock-0000000000000000',
                  headers: {},
                  createdAt: now
                }
              ]
            : [])
        ]

  const models: ModelInfo[] = [
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Anthropic: Claude Sonnet 4.5',
      contextLength: 1_000_000,
      promptPrice: 0.000003,
      completionPrice: 0.000015,
      supportsTools: true
    },
    {
      id: 'anthropic/claude-haiku-4.5',
      name: 'Anthropic: Claude Haiku 4.5',
      contextLength: 200_000,
      promptPrice: 0.000001,
      completionPrice: 0.000005
    },
    {
      id: 'openai/gpt-5',
      name: 'OpenAI: GPT-5',
      contextLength: 400_000,
      promptPrice: 0.00000125,
      completionPrice: 0.00001
    },
    {
      id: 'openai/gpt-5-mini',
      name: 'OpenAI: GPT-5 Mini',
      contextLength: 400_000,
      promptPrice: 0.00000025,
      completionPrice: 0.000002
    },
    {
      id: 'google/gemini-2.5-pro',
      name: 'Google: Gemini 2.5 Pro',
      contextLength: 1_048_576,
      promptPrice: 0.00000125,
      completionPrice: 0.00001
    },
    {
      id: 'deepseek/deepseek-chat-v3.1:free',
      name: 'DeepSeek: V3.1 (free)',
      contextLength: 163_840,
      promptPrice: 0,
      completionPrice: 0
    },
    {
      id: 'qwen/qwen3-coder',
      name: 'Qwen: Qwen3 Coder',
      contextLength: 262_144,
      promptPrice: 0.00000022,
      completionPrice: 0.00000095
    },
    {
      id: 'meta-llama/llama-4-maverick',
      name: 'Meta: Llama 4 Maverick',
      contextLength: 1_048_576,
      promptPrice: 0.00000015,
      completionPrice: 0.0000006
    }
  ]

  const cfg = DEFAULT_CHAT_CONFIG(`${HOME}/projetos/clearchat`, {
    providerId: 'p1',
    model: 'anthropic/claude-sonnet-4.5',
    baseUrl: 'https://openrouter.ai/api/v1',
    kind: 'openrouter'
  })
  cfg.params = { temperature: 0.7 }
  cfg.approvalModes = { search: 'always', pages: 'always' }

  const chats: Chat[] =
    scenario === 'onboarding'
      ? []
      : [
          {
            id: 'c1',
            title: 'Refatorar o parser de SSE',
            config: cfg,
            mainSessionId: 's1',
            createdAt: now - 3_600_000,
            updatedAt: now - 60_000
          },
          {
            id: 'c2',
            title: 'Ideias de nomes para o app',
            config: { ...cfg, model: 'openai/gpt-5' },
            mainSessionId: 's2',
            createdAt: now - 86_400_000,
            updatedAt: now - 7_200_000
          },
          {
            id: 'c3',
            title: 'Resumo do artigo sobre CRDTs',
            config: cfg,
            mainSessionId: 's3',
            createdAt: now - 3 * 86_400_000,
            updatedAt: now - 2 * 86_400_000
          },
          {
            id: 'c4',
            title: 'Script de backup com rsync',
            config: cfg,
            mainSessionId: 's4',
            createdAt: now - 6 * 86_400_000,
            updatedAt: now - 5 * 86_400_000
          }
        ]

  const sessions: Session[] = [
    {
      id: 's1',
      chatId: 'c1',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'awaiting_approval',
      createdAt: now - 3_600_000
    },
    {
      id: 's1a',
      chatId: 'c1',
      parentSessionId: 's1',
      parentToolCallId: 'tc3',
      depth: 1,
      model: 'anthropic/claude-haiku-4.5',
      title: 'Mapear usos do parser',
      task: 'Encontre todos os lugares em src/ que chamam parseSSE e liste arquivo:linha com um resumo de como o retorno é usado.',
      status: 'done',
      createdAt: now - 1_800_000
    },
    {
      id: 's2',
      chatId: 'c2',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: 'openai/gpt-5',
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now
    },
    {
      id: 's3',
      chatId: 'c3',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now
    },
    {
      id: 's4',
      chatId: 'c4',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now
    }
  ]

  const msg = (
    sessionId: string,
    message: StoredMessage['message'],
    meta: StoredMessage['meta'] = {},
    createdAt = now
  ): StoredMessage => ({
    id: id('m'),
    sessionId,
    seq: ++seq,
    message,
    meta,
    createdAt
  })
  /** Hora local fixa N dias atrás (separadores de dia "Ontem" / "<dia da semana>" no chat c1). */
  const daysAgo = (n: number, h: number, m: number, s = 0): number => {
    const d = new Date(now)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, h, m, s).getTime()
  }
  /** Hoje, N minutos atrás (sem cruzar a meia-noite). */
  const minAgo = (n: number): number =>
    Math.max(now - n * 60_000, new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() + 1000)

  const messages: StoredMessage[] = [
    msg(
      's1',
      {
        role: 'user',
        content:
          'O parser de SSE em `src/main/agent/llm.ts` está engolindo a última linha quando o stream termina sem `\\n`. Pode investigar e corrigir?'
      },
      {},
      daysAgo(2, 9, 12, 4)
    ),
    msg(
      's1',
      {
        role: 'assistant',
        content: 'Vou dar uma olhada no arquivo primeiro.',
        reasoning:
          'O usuário relata perda da última linha. Provavelmente o buffer não é processado no final do stream. Preciso ler o arquivo.',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"src/main/agent/llm.ts","offset":40,"limit":60}'
            }
          }
        ]
      },
      {
        usage: { promptTokens: 4210, completionTokens: 96, cachedTokens: 3890, cost: 0.0021 },
        model: cfg.model,
        durationMs: 2300
      },
      daysAgo(2, 9, 12, 31)
    ),
    msg(
      's1',
      {
        role: 'tool',
        tool_call_id: 'tc1',
        content:
          '40\tfor await (const chunk of res.body) {\n41\t  buffer += decoder.decode(chunk, { stream: true })\n42\t  const lines = buffer.split("\\n")\n43\t  buffer = lines.pop() ?? ""\n44\t  for (const line of lines) handleLine(line)\n45\t}\n46\t// fim do stream\n47\treturn finish()'
      },
      { toolStatus: 'ok' },
      daysAgo(2, 9, 12, 33)
    ),
    msg(
      's1',
      {
        role: 'assistant',
        content:
          'Li o trecho: quando o loop termina, o resto do `buffer` não é processado. Quer que eu aplique a correção agora?'
      },
      {
        usage: { promptTokens: 4380, completionTokens: 41, cachedTokens: 4210, cost: 0.0012 },
        model: cfg.model,
        durationMs: 1800
      },
      daysAgo(2, 9, 12, 52)
    ),
    msg(
      's1',
      { role: 'user', content: 'Amanhã eu vejo isso. Algum teste cobre esse caso hoje?' },
      {},
      daysAgo(1, 18, 40, 10)
    ),
    msg(
      's1',
      {
        role: 'assistant',
        content:
          'Não — nenhum teste manda um stream que termina sem `\\n`. Vale incluir um junto com a correção.'
      },
      {
        usage: { promptTokens: 4460, completionTokens: 33, cachedTokens: 4380, cost: 0.0009 },
        model: cfg.model,
        durationMs: 1500
      },
      daysAgo(1, 18, 40, 16)
    ),
    msg('s1', { role: 'user', content: 'Pode corrigir agora.' }, {}, minAgo(4)),
    msg(
      's1',
      {
        role: 'assistant',
        content:
          "Encontrei o problema: quando o loop termina, o que sobrou em `buffer` nunca é processado. A correção é simples:\n\n```ts\nfor await (const chunk of res.body) {\n  buffer += decoder.decode(chunk, { stream: true })\n  const lines = buffer.split('\\n')\n  buffer = lines.pop() ?? ''\n  for (const line of lines) handleLine(line)\n}\n// processa o resto do buffer\nbuffer += decoder.decode()\nif (buffer.trim()) handleLine(buffer)\nreturn finish()\n```\n\nAntes de aplicar, vou delegar a um subagente o mapeamento dos outros usos do parser e rodar os testes.",
        tool_calls: [
          {
            id: 'tc3',
            type: 'function',
            function: {
              name: 'delegate_task',
              arguments:
                '{"title":"Mapear usos do parser","task":"Encontre todos os lugares em src/ que chamam parseSSE e liste arquivo:linha com um resumo de como o retorno é usado.","model":"anthropic/claude-haiku-4.5"}'
            }
          },
          {
            id: 'tc2',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":"npm test -- --run src/main/agent"}' }
          }
        ]
      },
      {
        usage: {
          promptTokens: 4720,
          completionTokens: 312,
          cachedTokens: 4210,
          reasoningTokens: 0,
          cost: 0.0049
        },
        model: cfg.model,
        durationMs: 5100
      },
      minAgo(3)
    ),
    msg(
      's1',
      {
        role: 'tool',
        tool_call_id: 'tc3',
        content:
          'Encontrei 2 usos:\n- src/main/agent/runner.ts:88 — consome eventos delta e acumula tool_calls\n- src/main/agent/preview.ts:12 — apenas tipagem'
      },
      { toolStatus: 'ok', subSessionId: 's1a' },
      minAgo(2)
    ),
    msg('s1a', {
      role: 'user',
      content:
        'Encontre todos os lugares em src/ que chamam parseSSE e liste arquivo:linha com um resumo de como o retorno é usado.'
    }),
    // resultado das aprovações no card: aprovada → detalhes no selo "ok" (lista, Smart-Approve,
    // você); negada/bloqueada → faixa compacta
    msg(
      's1a',
      {
        role: 'assistant',
        content: 'Vou procurar os usos e limpar o arquivo temporário que criei.',
        tool_calls: [
          {
            id: 'tsa1',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":"ls src/main/agent"}' }
          },
          {
            id: 'tsa2',
            type: 'function',
            function: {
              name: 'shell',
              arguments: '{"command":"git diff --stat && rm -f tmp-usos.txt"}'
            }
          },
          {
            id: 'tsa3',
            type: 'function',
            function: { name: 'shell', arguments: '{"command":"rm -rf ~/.cache/clearchat"}' }
          }
        ]
      },
      { usage: { promptTokens: 900, completionTokens: 60 }, model: 'anthropic/claude-haiku-4.5' }
    ),
    msg(
      's1a',
      { role: 'tool', tool_call_id: 'tsa1', content: 'llm.ts\npreview.ts\nrunner.ts' },
      {
        toolStatus: 'ok',
        approval: {
          item: 'commands',
          mode: 'lists',
          allowed: [{ text: 'ls src/main/agent', entry: 'ls *' }]
        }
      }
    ),
    msg(
      's1a',
      { role: 'tool', tool_call_id: 'tsa2', content: ' 1 file changed, 2 insertions(+)' },
      {
        toolStatus: 'ok',
        approval: {
          item: 'commands',
          mode: 'smart',
          allowed: [{ text: 'git diff --stat', entry: 'git diff *' }],
          judgeAllowed: ['rm -f tmp-usos.txt']
        },
        smartApprove: {
          decision: 'approve',
          reason: 'Apaga o arquivo temporário que o próprio subagente criou para a tarefa.',
          providerId: '',
          model: 'mock/judge',
          judged: ['rm -f tmp-usos.txt'],
          durationMs: 640,
          usage: { promptTokens: 1800, completionTokens: 18, cost: 0.00004 }
        }
      }
    ),
    msg(
      's1a',
      {
        role: 'tool',
        tool_call_id: 'tsa3',
        content:
          'Bloqueado pela blacklist (comandos): "rm -rf *" casou com "rm -rf ~/.cache/clearchat"'
      },
      {
        toolStatus: 'denied',
        approval: {
          item: 'commands',
          mode: 'smart',
          blocked: { text: 'rm -rf ~/.cache/clearchat', entry: 'rm -rf *' }
        }
      }
    ),
    msg(
      's1a',
      {
        role: 'assistant',
        content:
          'Encontrei 2 usos:\n- `src/main/agent/runner.ts:88` — consome eventos delta e acumula tool_calls\n- `src/main/agent/preview.ts:12` — apenas tipagem'
      },
      { usage: { promptTokens: 1200, completionTokens: 80 }, model: 'anthropic/claude-haiku-4.5' }
    )
  ]

  // Chat com VERSÕES (ramos): a resposta do 1º turno foi regenerada (2 versões, a mais nova ativa),
  // a pergunta do 2º foi editada (3 versões, a 2ª selecionada em branchSel) e o 3º turno só existe
  // na versão selecionada. ‹ i/n › e "Regenerar resposta" em todos os turnos.
  if (scenario !== 'onboarding') {
    chats.push({
      id: 'cbr',
      title: 'Cache das respostas da API',
      config: cfg,
      mainSessionId: 'sbr',
      createdAt: daysAgo(4, 10, 0),
      updatedAt: daysAgo(4, 10, 12)
    })
    const sbr: Session = {
      id: 'sbr',
      chatId: 'cbr',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: daysAgo(4, 10, 0),
      branchSel: {}
    }
    sessions.push(sbr)
    const usage = (p: number): StoredMessage['meta'] => ({
      usage: { promptTokens: p, completionTokens: 140, cachedTokens: p - 180, cost: 0.0016 },
      model: cfg.model,
      durationMs: 2400
    })
    const at = (
      parent: StoredMessage | null,
      message: StoredMessage['message'],
      meta: StoredMessage['meta'],
      minute: number
    ): StoredMessage => ({
      ...msg('sbr', message, meta, daysAgo(4, 10, minute)),
      parentId: parent ? parent.id : null
    })
    const u1 = at(
      null,
      {
        role: 'user',
        content: 'Como cachear a lista de modelos da API sem mostrar dados velhos por muito tempo?'
      },
      {},
      0
    )
    const a1 = at(
      u1,
      {
        role: 'assistant',
        content:
          'Um cache em memória com **TTL curto** (5 minutos) resolve: depois disso a próxima chamada vai à rede de novo.'
      },
      usage(820),
      1
    )
    const a1b = at(
      u1,
      {
        role: 'assistant',
        content:
          'Use **stale-while-revalidate**: responda na hora com o que está em cache e, se tiver mais de 5 minutos, busque a versão nova em segundo plano. Assim a tela nunca espera a rede e o dado velho dura no máximo uma visita.'
      },
      usage(820),
      2
    )
    const u2a = at(a1b, { role: 'user', content: 'Mostra um exemplo em TypeScript.' }, {}, 3)
    const a2a = at(
      u2a,
      {
        role: 'assistant',
        content:
          '```ts\nconst cache = new Map<string, { at: number; data: Model[] }>()\nexport async function models(key: string): Promise<Model[]> {\n  const hit = cache.get(key)\n  if (hit && Date.now() - hit.at < 300_000) return hit.data\n  const data = await fetchModels(key)\n  cache.set(key, { at: Date.now(), data })\n  return data\n}\n```'
      },
      usage(1010),
      4
    )
    const u2b = at(a1b, { role: 'user', content: 'Mostra um exemplo em Python.' }, {}, 5)
    const a2b = at(
      u2b,
      {
        role: 'assistant',
        content:
          '```python\n_cache: dict[str, tuple[float, list]] = {}\n\ndef models(key: str) -> list:\n    hit = _cache.get(key)\n    if hit and time.time() - hit[0] < 300:\n        return hit[1]\n    data = fetch_models(key)\n    _cache[key] = (time.time(), data)\n    return data\n```'
      },
      usage(1010),
      6
    )
    const u2c = at(a1b, { role: 'user', content: 'Mostra um exemplo em Go.' }, {}, 7)
    const a2c = at(
      u2c,
      {
        role: 'assistant',
        content:
          '```go\nfunc (c *Cache) Models(key string) []Model {\n\tif e, ok := c.m[key]; ok && time.Since(e.at) < 5*time.Minute {\n\t\treturn e.data\n\t}\n\t// …\n}\n```'
      },
      usage(1010),
      8
    )
    const u3 = at(a2b, { role: 'user', content: 'E como invalidar quando a chave muda?' }, {}, 10)
    const a3 = at(
      u3,
      {
        role: 'assistant',
        content:
          'Use a chave (ou um hash dela) como parte da chave do cache: trocar a chave vira automaticamente um cache novo, e o antigo expira sozinho.'
      },
      usage(1240),
      12
    )
    messages.push(u1, a1, a1b, u2a, a2a, u2b, a2b, u2c, a2c, u3, a3)
    sbr.branchSel = { [a1b.id]: u2b.id }
  }

  // ?scenario=model-compat → modelos com modalidades/tools conhecidas e um chat com imagem no
  // histórico: o seletor desabilita os modelos sem visão (SPEC → Anexos → Compatibilidade).
  if (scenario === 'model-compat') {
    const mods: Record<string, string[]> = {
      'anthropic/claude-sonnet-4.5': ['text', 'image', 'file'],
      'anthropic/claude-haiku-4.5': ['text', 'image', 'file'],
      'openai/gpt-5': ['text', 'image', 'file'],
      'openai/gpt-5-mini': ['text', 'image', 'file'],
      'google/gemini-2.5-pro': ['text', 'image', 'file', 'audio'],
      'deepseek/deepseek-chat-v3.1:free': ['text'],
      'qwen/qwen3-coder': ['text']
      // meta-llama/llama-4-maverick: sem modalidades (desconhecido → nunca desabilitado)
    }
    for (const m of models) {
      if (mods[m.id]) m.inputModalities = mods[m.id]
      m.supportsTools = m.id !== 'deepseek/deepseek-chat-v3.1:free'
    }
    chats.unshift({
      id: 'cimg',
      title: 'Análise da captura de tela',
      config: cfg,
      mainSessionId: 'simg',
      createdAt: now - 120_000,
      updatedAt: now - 30_000
    })
    sessions.push({
      id: 'simg',
      chatId: 'cimg',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now - 120_000
    })
    messages.push(
      msg(
        'simg',
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `clearchat-attachment://${'c'.repeat(64)}.png` },
              _attachment: {
                name: 'captura-layout.png',
                mime: 'image/png',
                size: 184_320,
                kind: 'image',
                file: `${'c'.repeat(64)}.png`
              }
            },
            { type: 'text', text: 'O que está desalinhado nesse layout?' }
          ]
        },
        {},
        now - 90_000
      ),
      msg(
        'simg',
        {
          role: 'assistant',
          content:
            'O cabeçalho do card está 4px mais à direita que o corpo — o `padding-left` do título não segue o do conteúdo.'
        },
        { usage: { promptTokens: 1650, completionTokens: 60 }, model: cfg.model },
        now - 60_000
      )
    )
  }

  let approvalSettings: ApprovalSettings = normalizeApprovalSettings(
    { commands: 'lists', processes: 'lists', pages: 'lists', search: 'lists' },
    {
      commands: {
        allow: ['git status', 'git diff *', 'ls *'],
        deny: ['rm -rf *', 'git push --force *']
      },
      processes: { allow: ['npm run dev *'], deny: [] },
      pages: { allow: ['*.github.com', 'https://developer.mozilla.org/'], deny: [] }
    }
  )
  const approvals: ApprovalRequest[] =
    scenario === 'onboarding'
      ? []
      : [
          {
            id: 'a1',
            chatId: 'c1',
            sessionId: 's1',
            toolCallId: 'tc2',
            toolName: 'shell',
            args: { command: 'git status && npm test -- --run src/main/agent | tee out.log' },
            check: evaluateLists(
              'commands',
              { command: 'git status && npm test -- --run src/main/agent | tee out.log' },
              approvalSettings.lists
            ).check,
            createdAt: now
          },
          {
            id: 'a2',
            chatId: 'c4',
            sessionId: 's4',
            toolCallId: 'tcx',
            toolName: 'web_search',
            args: { query: 'rsync --link-dest exemplo' },
            createdAt: now
          }
        ]
  const queues: Record<string, QueuedMessage[]> = {
    s1: [
      {
        id: 'q1',
        sessionId: 's1',
        text: 'Depois adiciona um teste cobrindo stream sem \\n no final, por favor.',
        createdAt: now
      }
    ]
  }
  const presets: Preset[] = [
    {
      id: 'pr1',
      name: 'Padrão',
      description: 'Configuração padrão do app (Configurações → Novos chats).',
      icon: 'sparkles',
      config: {},
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'pr2',
      name: 'Revisor de código',
      description: 'Lê o projeto e aponta bugs, sem editar arquivos.',
      icon: '🧐',
      config: {
        model: 'openai/gpt-4.1',
        systemPrompt: 'Você é um revisor de código rigoroso. Aponte bugs e riscos.',
        enabledTools: ['list_dir', 'read_file', 'search_files', 'find_files']
      },
      createdAt: now,
      updatedAt: now
    }
  ]
  const settings: Record<string, unknown> = {
    defaultProviderId: 'p1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    defaultPresetId: 'pr1'
  }

  const files: Record<string, { name: string; isDir: boolean; size: number }[]> = {
    [`${HOME}/projetos/clearchat`]: [
      { name: 'src', isDir: true, size: 0 },
      { name: 'node_modules', isDir: true, size: 0 },
      { name: 'resources', isDir: true, size: 0 },
      { name: '.gitignore', isDir: false, size: 106 },
      { name: 'package.json', isDir: false, size: 2223 },
      { name: 'README.md', isDir: false, size: 2300 },
      { name: 'SPEC.md', isDir: false, size: 20903 },
      { name: 'tsconfig.json', isDir: false, size: 107 },
      { name: 'electron.vite.config.ts', isDir: false, size: 967 }
    ]
  }

  const delay = <T>(v: T, ms = 60): Promise<T> =>
    new Promise((r) => setTimeout(() => r(structuredClone(v)), ms))

  // Chat com present_file (cards + painel de arquivo) — ver mockViewer.ts
  // (+ arquivos de um host simulado para o controle remoto: sync.remoteListDir / remoteReadFile)
  const remoteFs = createMockRemoteFs({ delay })
  if (scenario !== 'onboarding')
    seedViewerScenario({ home: HOME, cfg, chats, sessions, messages, files, msg })

  // Questionário (ask_user) pendente na sessão s2 — cenário "question" (VITE_CLEAR_MOCK=question)
  type MockOpt = { title: string; icon?: string; description?: string; help?: string }
  type MockQ = { title: string; description?: string; multiple?: boolean; options: MockOpt[] }
  const askArgs: { questions: MockQ[] } = {
    questions: [
      {
        title: 'Qual banco de dados?',
        description: 'Para o serviço de pedidos.',
        options: [
          { title: 'PostgreSQL', icon: 'database', description: 'Relacional, robusto' },
          {
            title: 'SQLite',
            icon: '🪶',
            help: '┌──────────┐\n│ app.db   │  arquivo único\n└──────────┘'
          },
          { title: 'MongoDB', icon: 'leaf' }
        ]
      },
      {
        title: 'Quais recursos?',
        multiple: true,
        options: [{ title: 'Cache' }, { title: 'Filas' }, { title: 'Busca full-text' }]
      }
    ]
  }
  // ?scenario=spend → chat c2 com gasto conhecido (respostas com cache/raciocínio, uma sem custo,
  // juiz, subagente, coleta de contexto e título automático) — valores conferidos no E2E
  // ?scenario=voice-history → chat com uma chamada de voz passada: marcadores de início/fim (com
  // custos), falas em itálico com mic/alto-falante, end_call compacto e uma mensagem ditada
  if (scenario === 'voice-history') {
    const t0 = minAgo(45)
    chats.unshift({
      id: 'cv',
      title: 'Revisão do deploy por voz',
      config: cfg,
      mainSessionId: 'sv',
      createdAt: t0,
      updatedAt: now - 30_000
    })
    sessions.push({
      id: 'sv',
      chatId: 'cv',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: t0
    })
    const callId = 'call-mock-1'
    const at = (min: number): number => t0 + min * 60_000
    const sttModel = 'openai/whisper-large-v3-turbo'
    const ttsModel = 'elevenlabs/eleven-flash-v2.5'
    const voiceUser = (durationMs: number): StoredMessage['meta'] => ({
      voice: { source: 'call' as const, callId, durationMs, sttModel }
    })
    const voiceBot = (spoken: true | 'partial' = true): StoredMessage['meta'] => ({
      voice: { source: 'call' as const, callId, spoken, ttsModel }
    })
    const usage = (cost: number): NonNullable<StoredMessage['meta']['usage']> => ({
      promptTokens: 2100,
      completionTokens: 40,
      cost
    })
    messages.push(
      msg('sv', { role: 'user', content: 'Vou te ligar para revisar o deploy.' }, {}, at(0)),
      msg(
        'sv',
        { role: 'assistant', content: 'Combinado — pode ligar quando quiser.' },
        { model: cfg.model, usage: usage(0.0012) },
        at(0.2)
      ),
      msg(
        'sv',
        { role: 'assistant', content: 'Chamada de voz iniciada' },
        {
          synthetic: true,
          kind: 'voice-call',
          voiceCall: { callId, phase: 'start', startedAt: at(1) }
        },
        at(1)
      ),
      msg(
        'sv',
        { role: 'user', content: 'Oi, você consegue ver se o deploy de ontem terminou?' },
        voiceUser(3200),
        at(1.2)
      ),
      msg(
        'sv',
        {
          role: 'assistant',
          content: 'Terminou sim. O deploy de ontem passou nos testes e está no ar.'
        },
        { model: cfg.model, usage: usage(0.0021), ...voiceBot() },
        at(1.3)
      ),
      msg('sv', { role: 'user', content: 'E os logs de erro?' }, voiceUser(1400), at(2)),
      msg(
        'sv',
        { role: 'assistant', content: 'Tem dois avisos de memória no worker,' },
        { model: cfg.model, usage: usage(0.0019), interrupted: true, ...voiceBot('partial') },
        at(2.1)
      ),
      msg('sv', { role: 'user', content: 'Beleza, obrigado, tchau!' }, voiceUser(1600), at(4.8)),
      msg(
        'sv',
        {
          role: 'assistant',
          content: 'Por nada, até mais!',
          tool_calls: [
            {
              id: 'tc-end-1',
              type: 'function',
              function: { name: 'end_call', arguments: '{"reason":"usuário se despediu"}' }
            }
          ]
        },
        { model: cfg.model, usage: usage(0.0017), ...voiceBot() },
        at(4.9)
      ),
      msg(
        'sv',
        { role: 'tool', tool_call_id: 'tc-end-1', content: 'Chamada encerrada pelo agente.' },
        { toolStatus: 'ok', durationMs: 1 },
        at(4.9)
      ),
      msg(
        'sv',
        { role: 'assistant', content: 'Chamada encerrada · 4 min 12 s · pelo agente' },
        {
          synthetic: true,
          kind: 'voice-call',
          voiceCall: {
            callId,
            phase: 'end',
            startedAt: at(1),
            endedAt: at(1) + 252_000,
            durationMs: 252_000,
            endedBy: 'agent',
            reason: 'usuário se despediu',
            usage: {
              turns: 3,
              userSpeechMs: 6200,
              stt: {
                mode: 'api',
                model: sttModel,
                apiRequests: 9,
                apiAudioMs: 14_000,
                localRequests: 0,
                cost: 0.0011,
                costedRequests: 9
              },
              tts: {
                backend: 'api',
                model: ttsModel,
                chars: 118,
                audioMs: 9800,
                cost: 0.0118,
                estimated: true
              },
              llm: { calls: 3, cost: 0.0057, costed: 3 }
            }
          }
        },
        at(5.2)
      ),
      msg(
        'sv',
        { role: 'user', content: 'Agora me manda o resumo por escrito, por favor.' },
        { voice: { source: 'dictation' } },
        at(6)
      ),
      msg(
        'sv',
        {
          role: 'assistant',
          content:
            '**Resumo do deploy**\n\n- Terminou ontem e passou nos testes.\n- Dois avisos de memória no worker (sem erro).'
        },
        { model: cfg.model, usage: usage(0.0024) },
        at(6.1)
      )
    )
  }

  if (scenario === 'spend') {
    const c2 = chats.find((c) => c.id === 'c2')!
    c2.config = {
      ...c2.config,
      capturedContext: {
        main: {
          text: 'Projeto de app de chat minimalista.',
          updatedAt: now,
          by: 'model',
          calls: 3,
          cost: 0.0015,
          lastRun: {
            at: now,
            providerId: 'p1',
            model: 'openai/gpt-5-mini',
            usage: { promptTokens: 500, completionTokens: 40, cost: 0.0005 },
            durationMs: 900
          }
        }
      }
    }
    sessions.push({
      id: 's2a',
      chatId: 'c2',
      parentSessionId: 's2',
      parentToolCallId: 'tcs2',
      depth: 1,
      model: 'anthropic/claude-haiku-4.5',
      title: 'Pesquisar nomes',
      task: 'Liste nomes curtos disponíveis.',
      status: 'done',
      createdAt: now - 60_000
    })
    messages.push(
      msg(
        's2',
        { role: 'user', content: 'Me ajuda a escolher um nome para o app?' },
        {
          autoTitle: {
            title: 'Ideias de nomes para o app',
            applied: true,
            trigger: 'auto',
            providerId: 'p1',
            model: 'openai/gpt-5-mini',
            usage: { promptTokens: 120, completionTokens: 8, cost: 0.00004 },
            durationMs: 600,
            at: now
          }
        }
      ),
      msg(
        's2',
        {
          role: 'assistant',
          content: 'Vou verificar o ambiente e pedir ajuda a um subagente.',
          reasoning: 'Preciso entender o projeto antes de sugerir nomes.',
          tool_calls: [
            {
              id: 'tcs1',
              type: 'function',
              function: { name: 'shell', arguments: '{"command":"ls"}' }
            }
          ]
        },
        {
          model: 'openai/gpt-5',
          durationMs: 6100,
          reasoningMs: 4200,
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
      msg(
        's2',
        { role: 'tool', tool_call_id: 'tcs1', content: 'README.md\nsrc' },
        {
          toolStatus: 'ok',
          smartApprove: {
            decision: 'approve',
            reason: 'Listar arquivos é seguro.',
            providerId: 'p1',
            model: 'openai/gpt-5-mini',
            usage: { promptTokens: 900, completionTokens: 20, cost: 0.002 },
            durationMs: 800
          }
        }
      ),
      msg(
        's2',
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tcs2',
              type: 'function',
              function: {
                name: 'delegate_task',
                arguments: '{"task":"Liste nomes curtos disponíveis."}'
              }
            }
          ]
        },
        {
          model: 'openai/gpt-5',
          durationMs: 2100,
          usage: { promptTokens: 12_000, completionTokens: 300, cachedTokens: 10_000, cost: 0.03 }
        }
      ),
      msg(
        's2',
        { role: 'tool', tool_call_id: 'tcs2', content: 'Lumen, Quill, Hush' },
        { toolStatus: 'ok', subSessionId: 's2a' }
      ),
      msg(
        's2',
        { role: 'assistant', content: 'Sugestões: **Lumen**, **Quill** e **Hush**.' },
        // provedor sem custo na usage → "custo desconhecido"
        {
          model: 'openai/gpt-5',
          durationMs: 1500,
          usage: { promptTokens: 5000, completionTokens: 100 }
        }
      ),
      msg('s2a', { role: 'user', content: 'Liste nomes curtos disponíveis.' }),
      msg(
        's2a',
        { role: 'assistant', content: 'Procurando…' },
        {
          model: 'anthropic/claude-haiku-4.5',
          durationMs: 900,
          usage: { promptTokens: 3000, completionTokens: 400, cachedTokens: 1000, cost: 0.01 }
        }
      ),
      msg(
        's2a',
        { role: 'assistant', content: 'Lumen, Quill, Hush' },
        {
          model: 'anthropic/claude-haiku-4.5',
          durationMs: 700,
          usage: { promptTokens: 3500, completionTokens: 200, cost: 0.008 }
        }
      )
    )
  }
  const questions: QuestionRequest[] = []
  if (scenario === 'question') {
    const s2 = sessions.find((s) => s.id === 's2')
    if (s2) s2.status = 'awaiting_input'
    const a = msg('s2', {
      role: 'assistant',
      content: 'Antes de começar, preciso de algumas decisões.',
      tool_calls: [
        {
          id: 'ask1',
          type: 'function',
          function: { name: 'ask_user', arguments: JSON.stringify(askArgs) }
        }
      ]
    })
    messages.push(msg('s2', { role: 'user', content: 'Monte o serviço de pedidos.' }), a)
    questions.push({
      id: 'q1',
      chatId: 'c2',
      sessionId: 's2',
      toolCallId: 'ask1',
      createdAt: now,
      questions: askArgs.questions.map((q) => ({
        title: q.title,
        ...(q.description ? { description: q.description } : {}),
        multiple: !!q.multiple,
        options: q.options.map((o) => ({
          title: o.title,
          ...(o.description ? { description: o.description } : {}),
          ...(o.icon
            ? {
                icon: /^[a-z-]+$/.test(o.icon)
                  ? { kind: 'lucide' as const, name: o.icon }
                  : { kind: 'text' as const, text: o.icon }
              }
            : {}),
          ...(o.help ? { help: { kind: 'text' as const, text: o.help } } : {})
        }))
      }))
    })
  }
  const resolveQuestion = (qid: string, content: string, meta: StoredMessage['meta']): void => {
    const q = questions.find((x) => x.id === qid)
    if (!q) return
    questions.splice(questions.indexOf(q), 1)
    emit({ type: 'question-resolved', id: qid })
    const m = msg(q.sessionId, { role: 'tool', tool_call_id: q.toolCallId, content }, meta)
    messages.push(m)
    emit({ type: 'message-added', message: m })
    const s = sessions.find((x) => x.id === q.sessionId)
    if (s) {
      s.status = 'idle'
      emit({ type: 'session-updated', session: { ...s } })
    }
  }

  // Falha de conexão aguardando decisão — cenários "retry" (principal s2) e "retry-sub" (subagente s1a)
  const retries: RetryRequest[] = []
  if (scenario === 'retry' || scenario === 'retry-sub') {
    const sid = scenario === 'retry' ? 's2' : 's1a'
    const s = sessions.find((x) => x.id === sid)
    if (s) {
      s.status = 'awaiting_retry'
      if (scenario === 'retry')
        messages.push(msg('s2', { role: 'user', content: 'Resuma o README.' }))
      retries.push({
        id: 'r1',
        chatId: s.chatId,
        sessionId: sid,
        error:
          'Falha de rede ao chamar https://openrouter.ai/api/v1/chat/completions: fetch failed (getaddrinfo ENOTFOUND openrouter.ai)',
        model: s.model,
        providerName: 'OpenRouter',
        createdAt: now
      })
    }
  }
  // Cenário "subagents": no chat c3, 4 subagentes em segundo plano — 3 pedem aprovação ao mesmo
  // tempo (dois shell no modo Listas, um web_search) e 1 falhou; conversa longa depois dos delegates
  // (os cards ficam fora da tela → fila acima do composer). `subagents-other`: abre no chat c2
  // (c3 fica âmbar/vermelho na sidebar).
  if (scenario.startsWith('subagents')) {
    const subs = [
      ['s3a', 'Rodar os testes do parser', 'shell', { command: 'npm test -- --run src/parser' }],
      [
        's3b',
        'Pesquisar CRDTs de texto',
        'web_search',
        { query: 'CRDT text editing Yjs vs Automerge' }
      ],
      [
        's3c',
        'Limpar artefatos de build',
        'shell',
        { command: 'rm -rf dist && git clean -fdX out' }
      ],
      ['s3d', 'Resumir o artigo', 'read_file', null]
    ] as const
    const calls = subs.map(([, title], i) => ({
      id: `tcs${i}`,
      type: 'function' as const,
      function: {
        name: 'delegate_task',
        arguments: JSON.stringify({
          title,
          task: `${title} (tarefa de exemplo).`,
          background: true
        })
      }
    }))
    messages.push(
      msg('s3', { role: 'user', content: 'Divida o trabalho em 4 subagentes em paralelo.' }),
      msg('s3', {
        role: 'assistant',
        content: 'Vou delegar 4 tarefas em segundo plano.',
        tool_calls: calls
      })
    )
    subs.forEach(([sid, title, tool, args], i) => {
      messages.push(
        msg(
          's3',
          {
            role: 'tool',
            tool_call_id: `tcs${i}`,
            content: `Subagente iniciado em segundo plano (id ${sid}).`
          },
          { toolStatus: 'ok', subSessionId: sid, background: true }
        )
      )
      sessions.push({
        id: sid,
        chatId: 'c3',
        parentSessionId: 's3',
        parentToolCallId: `tcs${i}`,
        depth: 1,
        model: 'anthropic/claude-haiku-4.5',
        title,
        task: `${title} (tarefa de exemplo).`,
        status: tool === 'read_file' ? 'error' : 'awaiting_approval',
        createdAt: now - 60_000
      })
      messages.push(
        msg(sid, { role: 'user', content: `${title} (tarefa de exemplo).` }, { synthetic: true })
      )
      // mensagens entre irmãos: direta (s3a → s3c) e broadcast (s3a → s3b, s3c)
      if (sid === 's3c')
        messages.push(
          msg(
            sid,
            {
              role: 'user',
              content: siblingMessageText(
                'Rodar os testes do parser',
                's3a',
                'Vou rodar os testes agora: não limpe o out/ até eu avisar.'
              )
            },
            { kind: 'sibling-message', fromSessionId: 's3a' }
          )
        )
      if (sid === 's3b' || sid === 's3c')
        messages.push(
          msg(
            sid,
            {
              role: 'user',
              content: siblingBroadcastText(
                'Rodar os testes do parser',
                's3a',
                'Alguém está mexendo em src/parser/index.ts?'
              )
            },
            { kind: 'sibling-broadcast', fromSessionId: 's3a', broadcastId: 'bc1' }
          )
        )
      if (args) {
        messages.push(
          msg(sid, {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: `tcsub${i}`,
                type: 'function',
                function: { name: tool, arguments: JSON.stringify(args) }
              }
            ]
          })
        )
        approvals.push({
          id: `as${i}`,
          chatId: 'c3',
          sessionId: sid,
          toolCallId: `tcsub${i}`,
          toolName: tool,
          args,
          ...(tool === 'shell'
            ? { check: evaluateLists('commands', args, approvalSettings.lists).check }
            : {}),
          createdAt: now + i
        })
      }
    })
    for (let k = 0; k < 6; k++)
      messages.push(
        msg('s3', {
          role: 'user',
          content: `Enquanto isso, me explique o ponto ${k + 1} do artigo.`
        }),
        msg('s3', {
          role: 'assistant',
          content: `**Ponto ${k + 1}.** ${'CRDTs garantem convergência sem coordenação central: cada réplica aplica operações comutativas e, ao trocar estado, todas chegam ao mesmo resultado. '.repeat(3)}`
        })
      )
    messages.push(
      msg(
        's3',
        {
          role: 'user',
          content:
            '[Subagente "Resumir o artigo" (id s3d) falhou]\nNão consegui ler o arquivo do artigo.'
        },
        { kind: 'subagent-callback', synthetic: true, subSessionId: 's3d' }
      )
    )
  }
  // `subagents-question`: a principal de c3 também tem um questionário aberto (precedência: a fila espera)
  if (scenario === 'subagents-question') {
    messages.push(
      msg('s3', {
        role: 'assistant',
        content: 'Uma decisão antes de seguir.',
        tool_calls: [
          {
            id: 'ask3',
            type: 'function',
            function: { name: 'ask_user', arguments: JSON.stringify(askArgs) }
          }
        ]
      })
    )
    questions.push({
      id: 'q3',
      chatId: 'c3',
      sessionId: 's3',
      toolCallId: 'ask3',
      createdAt: now,
      questions: askArgs.questions.map((q) => ({
        title: q.title,
        multiple: !!q.multiple,
        options: q.options.map((o) => ({ title: o.title }))
      }))
    })
  }
  const resolveRetryMock = (rid: string, retry: boolean): void => {
    const r = retries.find((x) => x.id === rid)
    if (!r) return
    retries.splice(retries.indexOf(r), 1)
    emit({ type: 'retry-resolved', id: rid })
    const s = sessions.find((x) => x.id === r.sessionId)
    if (!s) return
    if (retry) {
      const m = msg(r.sessionId, {
        role: 'assistant',
        content: 'Pronto — (resposta após tentar de novo, mock).'
      })
      messages.push(m)
      emit({ type: 'message-added', message: m })
      s.status = s.depth === 0 ? 'idle' : 'done'
    } else {
      const m = msg(
        r.sessionId,
        { role: 'assistant', content: r.error },
        { synthetic: true, kind: 'error', error: r.error }
      )
      messages.push(m)
      emit({ type: 'message-added', message: m })
      s.status = 'error'
    }
    emit({ type: 'session-updated', session: { ...s } })
  }

  // Cenário "memory": persona com memória, chat c5 com tools de memória e cards de extração.
  presets.push({
    id: 'pr3',
    name: 'Assistente pessoal',
    description: 'Conhece você: lê e grava a memória (perfil, pessoas, preferências).',
    icon: 'brain',
    config: {
      systemPrompt: 'Você é um assistente pessoal atencioso e direto.',
      memory: mockPersonaMemory()
    },
    createdAt: now,
    updatedAt: now
  })
  if (scenario === 'memory') seedMemoryScenario()
  // ?scenario=voice-persona → persona "Narradora" com voz e transcrição PRÓPRIAS (ElevenLabs Flash
  // pelo OpenRouter · sarah; Groq em inglês) no chat c2 (Ideias de nomes); ?scenario=
  // voice-persona-fallback → a voz dela é de um provedor que não existe neste dispositivo (cai na
  // padrão daqui, com aviso) — protocolo 1.9.0
  if (scenario === 'voice-persona' || scenario === 'voice-persona-fallback') {
    presets.push({
      id: 'pr4',
      name: 'Narradora',
      description: 'Fala com a voz dela.',
      icon: '🎙️',
      config: {
        voice: {
          enabled: null,
          model: null,
          tools: null,
          voicePrompt: null,
          fillers: null,
          tts: {
            backend: 'api',
            api: {
              providerId: scenario === 'voice-persona' ? 'p1' : 'p-outro-pc',
              model: 'elevenlabs/eleven-flash-v2.5',
              voice: 'sarah'
            }
          },
          stt: {
            mode: 'api',
            api: { providerId: 'p4', model: 'whisper-large-v3-turbo' },
            language: 'en-US'
          }
        }
      },
      createdAt: now,
      updatedAt: now
    })
    const c2 = chats.find((c) => c.id === 'c2')
    if (c2) c2.config = { ...c2.config, presetId: 'pr4' }
  }
  function seedMemoryScenario(): void {
    chats.unshift({
      id: 'c5',
      title: 'Planejamento do TCC',
      config: { ...cfg, presetId: 'pr3', memory: mockChatMemory() },
      mainSessionId: 's5',
      createdAt: now - 2 * 3_600_000,
      updatedAt: now
    })
    sessions.push({
      id: 's5',
      chatId: 'c5',
      parentSessionId: null,
      parentToolCallId: null,
      depth: 0,
      model: cfg.model,
      title: 'Principal',
      task: null,
      status: 'idle',
      createdAt: now - 2 * 3_600_000
    })
    const tc = (
      tid: string,
      name: string,
      args: unknown
    ): NonNullable<
      Extract<StoredMessage['message'], { role: 'assistant' }>['tool_calls']
    >[number] => ({
      id: tid,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) }
    })
    const tool = (
      tid: string,
      content: string,
      meta: Record<string, unknown> = {},
      at = minAgo(30)
    ): StoredMessage =>
      msg('s5', { role: 'tool', tool_call_id: tid, content }, { toolStatus: 'ok', ...meta }, at)
    const usage = { promptTokens: 5400, completionTokens: 120, cachedTokens: 4900, cost: 0.0018 }
    messages.push(
      msg(
        's5',
        {
          role: 'user',
          content: 'Lembra do que o Marcos pediu para o capítulo 3? Quero fechar isso nesta semana.'
        },
        {},
        minAgo(34)
      ),
      msg(
        's5',
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            tc('tcm1', 'memory_search', { query: 'capítulo 3 orientador', category: 'areas' })
          ]
        },
        { usage, model: cfg.model },
        minAgo(33)
      ),
      tool(
        'tcm1',
        'Resultados para "capítulo 3 orientador" (2):\n- m-orientacao · Projeto TCC [escrita] · areas · Orientação do TCC — Reuniões quinzenais com o [[marcos-orientador]]\n  trecho: …Próxima entrega: capítulo 3 (implementação)\n- m-cap3 · Projeto TCC [escrita] · areas · Capítulo 3 em revisão — Seções 3.2 e 3.4 precisam de figuras novas',
        {},
        minAgo(33)
      ),
      msg(
        's5',
        {
          role: 'assistant',
          content: '',
          tool_calls: [tc('tcm2', 'memory_read', { ids: ['m-orientacao', 'm-marcos'] })]
        },
        { usage, model: cfg.model },
        minAgo(32)
      ),
      tool(
        'tcm2',
        '[m-orientacao] Orientação do TCC (Áreas · Projeto TCC, escrita)\nResumo: Reuniões quinzenais com o [[marcos-orientador]]\n- Reuniões às quintas, 14h, a cada 15 dias\n- Marcos prefere receber capítulos em PDF, com 3 dias de antecedência\n- Próxima entrega: capítulo 3 (implementação)\n\n[m-marcos] Marcos (orientador) (Pessoas · Padrão, escrita)\nResumo: Prof. Marcos Lima, sistemas distribuídos\n- Muito exigente com referências\n- Responde e-mails só à noite',
        {},
        minAgo(32)
      ),
      msg(
        's5',
        {
          role: 'assistant',
          content:
            'O Marcos quer o **capítulo 3 em PDF com 3 dias de antecedência** da reunião de quinta. Vou registrar o novo prazo e a convidada da banca.',
          tool_calls: [
            tc('tcm3', 'memory_write', {
              category: 'areas',
              id: 'm-orientacao',
              ops: [
                {
                  op: 'replace',
                  fact: 'Próxima entrega: capítulo 3 (implementação)',
                  with: 'Próxima entrega: capítulo 3 até 24/10 (PDF)'
                }
              ]
            }),
            tc('tcm4', 'memory_write', {
              category: 'people',
              title: 'Banca: Profa. Helena',
              summary: 'Convidada para a banca do TCC',
              ops: [{ op: 'add', fact: 'Especialista em sistemas distribuídos' }]
            })
          ]
        },
        { usage, model: cfg.model },
        minAgo(31)
      ),
      tool(
        'tcm3',
        'Memória atualizada: m-orientacao "Orientação do TCC" (Projeto TCC).',
        {
          memoryChanges: [
            {
              op: 'update',
              memoryId: 'm-orientacao',
              title: 'Orientação do TCC',
              collectionId: MOCK_COLS.tcc
            }
          ]
        },
        minAgo(31)
      ),
      tool(
        'tcm4',
        'Memória criada: m-helena "Banca: Profa. Helena" (Pessoas · Padrão).',
        {
          memoryChanges: [
            {
              op: 'create',
              memoryId: 'm-helena',
              title: 'Banca: Profa. Helena',
              collectionId: MOCK_COLS.people
            }
          ]
        },
        minAgo(31)
      ),
      msg(
        's5',
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            tc('tcm5', 'memory_rewrite', {
              id: 'm-prazos-antigo',
              title: 'Prazo de entrega',
              summary: 'Entrega adiada para 14/12; banca em fevereiro',
              facts: [
                'Coordenação aprovou o adiamento em 10/10',
                'Versão final: 14/12',
                'Banca: 1ª quinzena de fevereiro'
              ]
            }),
            tc('tcm6', 'memory_delete', { id: 'm-reuniao-cancelada' })
          ]
        },
        { usage, model: cfg.model },
        minAgo(30)
      ),
      tool(
        'tcm5',
        'Versão nova criada em Projeto TCC: m-prazo "Prazo de entrega" (substitui m-prazos-antigo).',
        {
          memoryChanges: [
            {
              op: 'create',
              memoryId: 'm-prazo',
              title: 'Prazo de entrega',
              collectionId: MOCK_COLS.tcc
            }
          ]
        }
      ),
      tool('tcm6', 'Memória apagada: m-reuniao-cancelada "Reunião de 17/10".', {
        memoryChanges: [
          {
            op: 'delete',
            memoryId: 'm-reuniao-cancelada',
            title: 'Reunião de 17/10',
            collectionId: MOCK_COLS.tcc
          }
        ]
      }),
      msg(
        's5',
        {
          role: 'assistant',
          content:
            'Pronto: prazo do capítulo 3 atualizado (24/10, em PDF), a Profa. Helena anotada em Pessoas e o prazo final corrigido para 14/12.'
        },
        { usage, model: cfg.model, durationMs: 3100 },
        minAgo(29)
      ),
      msg(
        's5',
        { role: 'assistant', content: 'Extração de memórias: 2 criadas, 1 atualizada.' },
        {
          synthetic: true,
          kind: 'memory-extraction',
          memoryExtraction: {
            created: 2,
            updated: 1,
            deleted: 0,
            changes: [
              {
                op: 'create',
                memoryId: 'm-cap3',
                title: 'Capítulo 3 em revisão',
                collectionId: MOCK_COLS.tcc
              },
              {
                op: 'create',
                memoryId: 'm-corrida',
                title: 'Corrida',
                collectionId: MOCK_COLS.topics
              },
              {
                op: 'update',
                memoryId: 'm-orientacao',
                title: 'Orientação do TCC',
                collectionId: MOCK_COLS.tcc
              }
            ],
            model: 'anthropic/claude-haiku-4.5',
            providerId: 'p1',
            usage: { promptTokens: 8120, completionTokens: 240, cachedTokens: 0, cost: 0.0093 },
            request: extractionRequest(
              'anthropic/claude-haiku-4.5',
              mockChatMemory(),
              '<memory>…</memory>'
            ),
            trigger: 'compaction'
          }
        } as unknown as StoredMessage['meta'],
        minAgo(20)
      ),
      msg(
        's5',
        { role: 'assistant', content: 'Extração de memórias: falhou.' },
        {
          synthetic: true,
          kind: 'memory-extraction',
          memoryExtraction: {
            created: 0,
            updated: 0,
            deleted: 0,
            changes: [],
            error:
              'HTTP 429: Rate limit exceeded for anthropic/claude-haiku-4.5 — tente de novo em alguns segundos.',
            model: 'anthropic/claude-haiku-4.5',
            providerId: 'p1',
            trigger: 'manual'
          }
        } as unknown as StoredMessage['meta'],
        minAgo(12)
      )
    )
  }

  const syncStatus = (): SyncStatus => ({
    phase: 'signed-out',
    server: { kind: 'official', url: OFFICIAL_SYNC_URL, name: null, envOverride: false },
    account: null,
    device: null,
    connection: 'disabled',
    lastSyncAt: null,
    pending: 0,
    error: null,
    quota: null,
    remember: true,
    merge: null,
    prompts: [],
    protocolError: null,
    // ?scenario=branches → aviso "Atualize <dispositivo> para usar versões de mensagens"
    outdatedHosts:
      scenario === 'branches' ? [{ name: 'Notebook antigo', appVersion: '0.6.1' }] : [],
    push: { available: false, enabled: true },
    live: { supported: false, newChatStorage: 'live' }
  })
  const noSync = (): Promise<never> =>
    Promise.reject(new Error('Sync indisponível no modo de demonstração.'))

  // ---- ramos (versões de mensagens) ----
  const sessionMsgs = (sid: string): StoredMessage[] => messages.filter((m) => m.sessionId === sid)
  const busyStatus = (st: Session['status']): boolean =>
    ['running', 'waiting', 'awaiting_approval', 'awaiting_input', 'awaiting_retry'].includes(st)
  /** Resposta simulada sob `parentId`: rodando → mensagem do assistente → ociosa. */
  const mockReply = (sid: string, parentId: string, text: string): void => {
    const s = sessions.find((x) => x.id === sid)
    if (!s) return
    s.status = 'running'
    emit({ type: 'session-updated', session: { ...s } })
    setTimeout(() => {
      const m: StoredMessage = {
        ...msg(
          sid,
          { role: 'assistant', content: text },
          {
            model: chats.find((c) => c.id === s.chatId)?.config.model,
            usage: { promptTokens: 1300, completionTokens: 60 },
            durationMs: 900
          }
        ),
        parentId
      }
      messages.push(m)
      // o primeiro filho sob um `null` (regenerar) desfaz a pausa do caminho
      if (s.branchSel && s.branchSel[parentId] === null) {
        const next = { ...s.branchSel }
        delete next[parentId]
        s.branchSel = next
      }
      s.status = 'idle'
      emit({ type: 'message-added', message: m })
      emit({ type: 'session-updated', session: { ...s } })
    }, 900)
  }

  const mockApi: ClearApi = {
    sync: {
      status: () => delay(syncStatus()),
      probeServer: noSync,
      setServer: noSync,
      requestCode: noSync,
      verifyCode: noSync,
      refreshKeys: noSync,
      unlock: noSync,
      unlockWithRecovery: noSync,
      resolveMerge: noSync,
      lock: () => delay(syncStatus()),
      logout: () => delay(syncStatus()),
      changePassword: noSync,
      newRecoveryKey: noSync,
      devices: () => delay([]),
      renameDevice: noSync,
      revokeDevice: noSync,
      syncNow: noSync,
      setPushNotify: noSync,
      openSignup: () => delay(undefined),
      openSetup: () => delay(undefined),
      chatStates: () => delay([]),
      takeover: noSync,
      cancelHandover: noSync,
      setPinned: noSync,
      confirmCwd: noSync,
      divergence: noSync,
      resolveDivergence: noSync,
      setActiveChat: () => delay(undefined),
      answerPrompt: noSync,
      cloudSkills: () => delay([]),
      trackedSkills: () => delay([]),
      setSkillSync: noSync,
      downloadSkills: noSync,
      removeCloudSkill: noSync,
      stopTrackingSkill: noSync,
      hostSkills: () => delay(null),
      remoteListDir: (chatId, path) => remoteFs.remoteListDir(chatId, path),
      remoteReadFile: (chatId, path, offset, length) =>
        remoteFs.remoteReadFile(chatId, path, offset, length),
      liveChats: () => Promise.resolve([]),
      liveOpen: noSync,
      liveAttach: noSync,
      liveStats: () => Promise.resolve({ messages: 0, attachments: 0, bytes: 0 }),
      saveOnline: noSync,
      takeOffServer: noSync
    },
    memory: createMemoryMock({
      emit,
      chats,
      sessions,
      messages,
      msg,
      delay,
      withScenario: scenario === 'memory'
    }),
    providers: {
      list: () => delay(providers),
      create: async (p) => {
        const np = { ...p, kind: providerKind(p), id: id('p'), createdAt: Date.now() }
        providers.push(np)
        return delay(np)
      },
      update: async (pid, patch) => {
        const p = providers.find((x) => x.id === pid)!
        Object.assign(p, patch)
        return delay(p)
      },
      delete: async (pid) => {
        providers.splice(
          providers.findIndex((x) => x.id === pid),
          1
        )
      },
      listModels: () => delay(models, 300),
      test: () => delay({ ok: true, modelCount: 342 }, 600)
    },
    settings: {
      get: <T>(k: string) => delay((settings[k] ?? null) as T | null),
      set: async (k, v) => {
        settings[k] = v
      }
    },
    chats: {
      list: () => delay(chats),
      get: (cid) => delay(chats.find((c) => c.id === cid) ?? null),
      create: async (input) => {
        const sid = id('s')
        const chat: Chat = {
          id: id('c'),
          title: input.title ?? 'Novo chat',
          config: { ...DEFAULT_CHAT_CONFIG(HOME), ...input.config },
          mainSessionId: sid,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        chats.unshift(chat)
        sessions.push({
          id: sid,
          chatId: chat.id,
          parentSessionId: null,
          parentToolCallId: null,
          depth: 0,
          model: chat.config.model,
          title: 'Principal',
          task: null,
          status: 'idle',
          createdAt: Date.now()
        })
        return delay(chat)
      },
      update: async (cid, patch) => {
        const c = chats.find((x) => x.id === cid)!
        if (patch.title) c.title = patch.title
        if (patch.config) c.config = { ...c.config, ...patch.config }
        return delay(c)
      },
      delete: async (cid) => {
        chats.splice(
          chats.findIndex((x) => x.id === cid),
          1
        )
      },
      // título automático (mock): um título "gerado" a partir do atual, sem chamada nenhuma
      generateTitle: async (cid) => {
        const c = chats.find((x) => x.id === cid)!
        c.title = `${(c.title || 'Chat').split(/\s+/).slice(0, 4).join(' ')} (gerado)`
        emit({ type: 'chat-updated', chat: c })
        return delay(c, 700)
      }
    },
    sessions: {
      list: (cid) => delay(sessions.filter((s) => s.chatId === cid)),
      messages: (sid) => delay(messages.filter((m) => m.sessionId === sid))
    },
    messages: {
      update: async (mid, m) => {
        const sm = messages.find((x) => x.id === mid)!
        sm.message = m
        emit({ type: 'message-updated', message: sm })
        return delay(sm)
      },
      delete: async (mid) => {
        const i = messages.findIndex((x) => x.id === mid)
        const [sm] = messages.splice(i, 1)
        emit({ type: 'message-deleted', sessionId: sm.sessionId, messageId: mid })
      }
    },
    agent: {
      send: async (sid, text, atts, _skills, opts) => {
        // agente ocupado → fila (chips acima do composer), como no backend
        const ss = sessions.find((x) => x.id === sid)
        if (ss && ['running', 'waiting', 'awaiting_approval'].includes(ss.status)) {
          const item: QueuedMessage = {
            id: id('q'),
            sessionId: sid,
            text,
            ...(atts?.length ? { attachments: atts } : {}),
            createdAt: Date.now()
          }
          queues[sid] = [...(queues[sid] ?? []), item]
          emit({ type: 'queue-updated', sessionId: sid, queue: queues[sid] })
          return { queued: true }
        }
        const leaf = activeLeaf(sessionMsgs(sid), ss?.branchSel)
        const m = msg(sid, {
          role: 'user',
          content: atts?.length
            ? [
                ...atts.map((a) => ({
                  type: 'image_url' as const,
                  image_url: { url: `clearchat-attachment://${a.file}` },
                  _attachment: a
                })),
                { type: 'text' as const, text }
              ]
            : text
        })
        m.parentId = leaf ? leaf.id : null
        // texto ditado no composer: `meta.voice` como o main grava
        if (opts?.voice?.source === 'dictation')
          m.meta = { ...m.meta, voice: { source: 'dictation' } }
        messages.push(m)
        emit({ type: 'message-added', message: m })
        return { queued: false }
      },
      forceSend: async () => {},
      removeQueued: async (qid) => {
        for (const k of Object.keys(queues)) {
          queues[k] = queues[k].filter((q) => q.id !== qid)
          emit({ type: 'queue-updated', sessionId: k, queue: queues[k] })
        }
      },
      getQueue: (sid) => delay(queues[sid] ?? []),
      stop: async (sid) => {
        // Parar com o card de falha de conexão aberto = Cancelar
        for (const r of retries.filter((x) => x.sessionId === sid)) resolveRetryMock(r.id, false)
      },
      // regenerar = nova versão da resposta do turno (resposta só com erros → substitui)
      regenerate: async (sid, messageId) => {
        const s = sessions.find((x) => x.id === sid)
        if (!s) throw new Error('Sessão não encontrada.')
        const path = activePath(sessionMsgs(sid), s.branchSel)
        const anchor = messageId ? turnAnchor(path, messageId) : lastTurnAnchor(path)
        if (!anchor) throw new Error('Nada para regenerar.')
        const resp = turnResponse(path, anchor.id)
        if (resp.length && resp.every((m) => isDisplayOnly(m.meta))) {
          for (const r of resp) {
            messages.splice(messages.indexOf(r), 1)
            emit({ type: 'message-deleted', sessionId: sid, messageId: r.id })
          }
        } else s.branchSel = { ...(s.branchSel ?? {}), [anchor.id]: null }
        mockReply(sid, anchor.id, '(demonstração) Nova versão da resposta.')
      },
      editBranch: async (mid, message) => {
        const orig = messages.find((x) => x.id === mid)
        const s = orig && sessions.find((x) => x.id === orig.sessionId)
        if (!orig || !s) throw new Error('Mensagem não encontrada.')
        const parent = buildTree(sessionMsgs(s.id)).parentOf.get(mid) ?? null
        const m: StoredMessage = { ...msg(s.id, message), parentId: parent }
        messages.push(m)
        const sel = { ...(s.branchSel ?? {}) }
        delete sel[selKey(parent)]
        s.branchSel = sel
        emit({ type: 'message-added', message: m })
        mockReply(
          s.id,
          m.id,
          `(demonstração) Resposta à nova versão: “${contentText(message.content).slice(0, 80)}”`
        )
      },
      selectBranch: async (mid) => {
        const target = messages.find((x) => x.id === mid)
        const s = target && sessions.find((x) => x.id === target.sessionId)
        if (!target || !s) throw new Error('Mensagem não encontrada.')
        if (busyStatus(s.status)) throw new Error('Disponível quando o agente terminar.')
        s.branchSel = selectionToReach(sessionMsgs(s.id), s.branchSel, mid)
        emit({ type: 'session-updated', session: { ...s } })
        return delay({ ...s }, 30)
      },
      approve: async (rid, _decision, items) => {
        const req = approvals.find((a) => a.id === rid)
        if (req?.check && isListItem(req.check.item) && items?.length) {
          const item = req.check.item
          const lists = structuredClone(approvalSettings.lists)
          for (const d of items) {
            if (!d.pattern) continue
            const l = lists[item][d.allow ? 'allow' : 'deny']
            if (!l.includes(d.pattern)) l.push(d.pattern)
          }
          approvalSettings = normalizeApprovalSettings(approvalSettings.modes, lists)
          emit({ type: 'approval-settings-updated', settings: approvalSettings })
        }
        const i = approvals.findIndex((a) => a.id === rid)
        if (i >= 0) approvals.splice(i, 1)
        emit({ type: 'approval-resolved', id: rid })
        // subagente do cenário "subagents": conclui depois da decisão
        const ss = req && sessions.find((x) => x.id === req.sessionId)
        if (ss && ss.depth > 0) {
          ss.status = 'done'
          emit({ type: 'session-updated', session: { ...ss } })
        }
      },
      pendingApprovals: () => delay(approvals),
      smartOverride: async () => {},
      setCapturedContext: async (chatId, sessionId, text) => {
        const c = chats.find((x) => x.id === chatId)
        if (!c) return
        const st = { ...(c.config.capturedContext ?? {}) }
        const now = Date.now()
        const e = { text, updatedAt: now, by: 'user' as const }
        if (sessionId) st.sessions = { ...(st.sessions ?? {}), [sessionId]: e }
        else
          st.main = {
            ...e,
            ...(st.main
              ? { prev: { text: st.main.text, updatedAt: st.main.updatedAt, by: st.main.by } }
              : {})
          }
        c.config = { ...c.config, capturedContext: st }
        emit({ type: 'chat-updated', chat: { ...c } })
      },
      undoCapturedContext: async () => {},
      smartApproveTest: async () =>
        delay({
          decision: 'approve' as const,
          reason: 'Exemplo (mock).',
          providerId: '',
          model: 'mock/judge',
          durationMs: 120
        }),
      previewRequest: async (sid) => {
        const s = sessions.find((x) => x.id === sid)!
        const c = chats.find((x) => x.id === s.chatId)!
        const sys = `${c.config.systemPrompt}\n\n<environment>\nroot: ${c.config.cwd}\nos: linux (Arch Linux)\nshell: zsh 5.9\n</environment>`
        return delay({
          url: 'https://openrouter.ai/api/v1/chat/completions',
          headers: {
            Authorization: 'Bearer sk-or-v1-9f8e…0c',
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://clearchat.app',
            'X-Title': 'ClearChat'
          },
          body: {
            model: c.config.model,
            messages: [
              {
                role: 'system',
                content: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }]
              },
              ...activePath(sessionMsgs(sid), s.branchSel)
                .filter((m) => !isDisplayOnly(m.meta))
                .map((m) => m.message)
            ],
            stream: true,
            stream_options: { include_usage: true },
            tools: ['list_dir', 'read_file'].map((n) => ({
              type: 'function',
              function: { name: n }
            })),
            ...Object.fromEntries(
              Object.entries(c.config.params).filter(([k]) => k !== 'extraBody')
            ),
            usage: { include: true }
          }
        })
      },
      runningSessions: () => delay([]),
      compact: () => delay({ scheduled: false }),
      stopSubagents: () => delay(undefined)
    },
    viewer: {
      ...createMockViewer({ messages: () => messages, delay }),
      saveBytes: (name, bytes) => remoteFs.saveBytes(name, bytes),
      openBytes: (name, bytes) => remoteFs.openBytes(name, bytes),
      runBytes: (chatId, name, bytes) => remoteFs.runBytes(chatId, name, bytes)
    },
    fs: {
      listDir: (p) =>
        delay(
          (
            files[p] ?? [
              { name: 'index.ts', isDir: false, size: 1834 },
              { name: 'utils', isDir: true, size: 0 }
            ]
          ).map((f) => ({ ...f, path: `${p}/${f.name}`, mtime: now }))
        ),
      readFile: (p) =>
        delay({
          content: p.endsWith('.json')
            ? '{\n  "name": "clearchat",\n  "version": "0.1.0",\n  "main": "./out/main/index.js"\n}\n'
            : '# ClearChat\n\nChat desktop minimalista (Electron + React + TypeScript + Tailwind v4)\npara qualquer endpoint OpenAI-compatible.\n',
          truncated: false,
          binary: false
        }),
      pickDirectory: () => delay(`${HOME}/projetos/outro`),
      homeDir: () => delay(HOME),
      mkdir: (p) => delay(p)
    },
    app: {
      capabilities: () =>
        delay({
          bwrap: true,
          ripgrep: true,
          shell: { name: 'zsh' as const, version: '5.9', os: 'Linux' },
          platform: mockPlatform()
        })
    },
    // ?scenario=update → há versão nova (aviso na sidebar); senão, já na mais recente
    updates: (() => {
      const st = (): UpdateStatus =>
        scenario === 'update'
          ? {
              current: '0.6.1',
              state: 'available',
              latest: {
                version: '0.7.0',
                url: 'https://github.com/ezenere/ClearChatDesktop/releases/tag/v0.7.0'
              },
              checkedAt: Date.now()
            }
          : { current: '0.6.1', state: 'latest', checkedAt: Date.now() }
      return {
        status: () => delay(st()),
        check: () => delay(st(), 700),
        openRelease: async () => undefined
      }
    })(),
    presets: {
      list: () => delay(presets),
      create: async (input) => {
        const p: Preset = {
          id: id('pr'),
          name: input.name || 'Persona',
          description: input.description ?? '',
          icon: input.icon ?? '',
          config: sanitizePresetConfig(input.config),
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
        presets.push(p)
        return delay(p)
      },
      update: async (pid, patch) => {
        const p = presets.find((x) => x.id === pid)!
        Object.assign(p, patch, patch.config ? { config: sanitizePresetConfig(patch.config) } : {})
        p.updatedAt = Date.now()
        return delay(p)
      },
      delete: async (pid) => {
        presets.splice(
          presets.findIndex((x) => x.id === pid),
          1
        )
        if (settings.defaultPresetId === pid) delete settings.defaultPresetId
      },
      duplicate: async (pid) => {
        const src = presets.find((x) => x.id === pid)!
        const p = { ...structuredClone(src), id: id('pr'), name: copyName(src.name, presets) }
        presets.push(p)
        return delay(p)
      }
    },
    attachments: {
      pick: () =>
        delay({
          items: [
            {
              sha256: 'a'.repeat(64),
              name: 'diagrama.png',
              mime: 'image/png',
              size: 48_213,
              kind: 'image' as const,
              file: `${'a'.repeat(64)}.png`
            }
          ],
          errors: []
        }),
      add: (input) =>
        delay({
          sha256: 'b'.repeat(64),
          name: input.name,
          mime: input.mime || 'application/octet-stream',
          size: input.data.byteLength,
          kind: 'text' as const,
          file: `${'b'.repeat(64)}.txt`
        })
    },
    questions: {
      answer: async (qid, answers) => {
        const q = questions.find((x) => x.id === qid)
        if (!q) return
        resolveQuestion(qid, 'Respostas do usuário: (mock)', {
          toolStatus: 'ok',
          askUser: { questions: q.questions, outcome: 'answered', answers }
        })
      },
      cancel: async (qid) => {
        const q = questions.find((x) => x.id === qid)
        if (!q) return
        resolveQuestion(qid, '[O usuário não respondeu ao questionário]', {
          toolStatus: 'cancelled',
          synthetic: true,
          kind: 'tool-cancelled',
          askUser: { questions: q.questions, outcome: 'cancelled' }
        })
      },
      pending: () => delay(questions)
    },
    retries: {
      retry: async (rid) => resolveRetryMock(rid, true),
      cancel: async (rid) => resolveRetryMock(rid, false),
      pending: () => delay(retries)
    },
    processes: {
      list: (chatId) => delay(processes.filter((p) => p.chatId === chatId)),
      // como o main: parar (ou dispensar um encerrado) tira da lista
      stop: async (chatId, pid) => {
        const i = processes.findIndex((x) => x.chatId === chatId && x.id === pid)
        if (i >= 0) {
          processes.splice(i, 1)
          emit({
            type: 'processes-updated',
            chatId,
            processes: processes.filter((x) => x.chatId === chatId).map((x) => ({ ...x }))
          })
        }
        return delay(undefined)
      },
      logs: (chatId, pid, tail = 200) => {
        const p = processes.find((x) => x.chatId === chatId && x.id === pid)!
        const all = Array.from({ length: p.lines }, (_, i) => ({
          n: i + 1,
          text: i === p.lines - 1 ? p.lastLine : `[vite] hmr update /src/App.tsx (${i + 1})`
        }))
        return delay({ info: { ...p }, lines: all.slice(-tail) })
      }
    },
    approvals: {
      getSettings: () => delay(approvalSettings),
      updateSettings: async (patch) => {
        approvalSettings = normalizeApprovalSettings(
          patch.modes ?? approvalSettings.modes,
          patch.lists ?? approvalSettings.lists
        )
        emit({ type: 'approval-settings-updated', settings: approvalSettings })
        return delay(approvalSettings)
      }
    },
    skills: (() => {
      // skills fictícias (só para o modo mock da UI)
      let settings: SkillsSettings = defaultSkillsSettings()
      const mk = (
        name: string,
        description: string,
        extra: Partial<SkillInfo> = {}
      ): SkillInfo => ({
        name,
        description,
        dir: `/home/voce/.claude/skills/${name}`,
        file: `/home/voce/.claude/skills/${name}/SKILL.md`,
        locationId: 'default',
        locationLabel: '~/.claude/skills',
        warnings: [],
        files: 3,
        ...extra
      })
      const list = [
        mk(
          'pdf',
          'Extrai texto e tabelas de PDFs, preenche formulários e junta arquivos. Use com PDFs.'
        ),
        mk(
          'frontend-design',
          'Interfaces web caprichadas: layout, tipografia e cores consistentes.'
        ),
        mk('changelog', 'Gera o changelog a partir dos commits desde a última tag.')
      ]
      const disc = (): SkillsDiscovery => ({
        locations: settings.locations.map((l) => ({
          id: l.id,
          path: l.path,
          resolved: l.path.replace('~', '/home/voce'),
          label: l.path,
          enabled: l.enabled,
          kind: 'global' as const,
          exists: true,
          skills: l.id === 'default' ? list : []
        })),
        skills: settings.locations.some((l) => l.id === 'default' && l.enabled) ? list : []
      })
      return {
        getSettings: () => delay(settings),
        updateSettings: async (patch) => {
          settings = normalizeSkillsSettings({ ...settings, ...patch })
          emit({ type: 'skills-changed' })
          return delay(settings)
        },
        discover: () => delay(disc()),
        read: (file) =>
          delay(
            `---\nname: ${file.split('/').slice(-2)[0]}\ndescription: (mock)\n---\n\n# Instruções\n`
          ),
        pickFolder: () => delay(null),
        openFolder: () => delay(undefined)
      }
    })(),
    webSearch: (() => {
      // chaves só no "main" do mock; a UI recebe a máscara
      const keys: Partial<Record<SearchEngineId, string>> = {}
      let engines = normalizeEngines(null)
      const state = (): WebSearchSettingsState => ({
        engines: normalizeEngines(engines, (id) => !!keys[id]).map((e) => ({
          ...e,
          hasKey: !!keys[e.id],
          keyMask: maskKey(keys[e.id])
        }))
      })
      return {
        getSettings: () => delay(state()),
        updateEngines: async (list) => {
          const off = list.find((e) => e.enabled && isApiEngine(e.id) && !keys[e.id])
          if (off) throw new Error(`Informe a chave de API para habilitar o ${off.id}.`)
          engines = normalizeEngines(list, (id) => !!keys[id])
          return delay(state())
        },
        setKey: async (id, key) => {
          if (key?.trim()) keys[id] = key.trim()
          else delete keys[id]
          engines = normalizeEngines(engines, (x) => !!keys[x])
          return delay(state())
        },
        revealKey: (id) => delay(keys[id] ?? null),
        test: (id) =>
          delay(
            isApiEngine(id) && !keys[id]
              ? { ok: false, message: 'sem chave de API' }
              : { ok: true, count: 3, ms: 840, message: '3 resultados em 0,8 s' },
            700
          )
      }
    })(),
    // Áudio/voz (mock): settings só com provedor/modelo/voz (endereço e chave ficam no provedor —
    // mesmo contrato do main) e transcrição falsa com parciais ao vivo.
    voice: ((): VoiceApi => {
      // Cenários de áudio (falhas simuladas do microfone — a captura é pulada no mock, então o
      // ditado/chamada consultam `window.__clearMockMic`):
      //   ?scenario=voice-mic-missing → microfone salvo desconectado (cai no padrão + aviso)
      //   ?scenario=voice-mic-denied  → permissão negada (NotAllowedError)
      //   ?scenario=voice-mic-lost    → o microfone some 1,5 s depois de começar a gravar
      //   ?scenario=voice-call-fail   → `voice.call.start` recusa (erro legível)
      //   ?scenario=voice-not-ready   → STT sem provedor e Kokoro não instalado (pré-checagem da chamada)
      //   ?scenario=voice-no-espeak   → `runtime.status` sem espeak-ng (TTS local não pronto)
      //   ?scenario=voice-tts-fail    → "Testar voz" falha (401 legível)
      //   ?scenario=voice-alias       → STT no OpenRouter com o id sem prefixo (corrigido na UI)
      //   ?scenario=voice-api         → TTS pela API do OpenRouter (ElevenLabs Flash · sarah)
      //   ?scenario=voice-elevenlabs  → + provedor ElevenLabs direto (vozes com prévia)
      //   ?scenario=voice-slow-model  → TTS salvo num modelo fora da lista curada (Eleven v4 Turbo)
      const micMode =
        scenario === 'voice-mic-missing'
          ? 'missing'
          : scenario === 'voice-mic-denied'
            ? 'denied'
            : scenario === 'voice-mic-lost'
              ? 'lost'
              : 'ok'
      ;(window as unknown as { __clearMockMic?: string }).__clearMockMic = micMode
      const ready = scenario !== 'voice-not-ready'
      let audioInput = {
        ...DEFAULT_AUDIO_INPUT,
        deviceId: scenario === 'voice-mic-missing' ? 'mic-usb-desconectado' : null
      }
      // pronto para a chamada por padrão (STT no Groq cadastrado + Kokoro "instalado")
      let stt: SttSettings = {
        ...DEFAULT_STT_SETTINGS,
        api:
          scenario === 'voice-alias'
            ? { ...DEFAULT_STT_SETTINGS.api, providerId: 'p1', model: 'whisper-large-v3-turbo' }
            : { ...DEFAULT_STT_SETTINGS.api, providerId: ready ? 'p4' : null }
      }
      let tts: TtsSettings = {
        ...DEFAULT_TTS_SETTINGS,
        ...(scenario === 'voice-api' ||
        scenario === 'voice-elevenlabs' ||
        scenario === 'voice-slow-model'
          ? {
              backend: 'api' as const,
              api: {
                ...DEFAULT_TTS_SETTINGS.api,
                providerId: 'p1',
                model:
                  scenario === 'voice-slow-model'
                    ? 'elevenlabs/eleven-v4-turbo'
                    : 'elevenlabs/eleven-flash-v2.5',
                voice: 'sarah'
              }
            }
          : {}),
        local: DEFAULT_TTS_SETTINGS.local
          ? { ...DEFAULT_TTS_SETTINGS.local, installed: ready }
          : null
      }
      // ?scenario=gpu-call* → Fala e Transcrição na GPU local (OmniVoice + CC0 Faber; whisper)
      if (scenario.startsWith('gpu-call')) {
        tts = { ...tts, backend: 'gpu', gpu: { engine: 'omnivoice', voice: 'cc0-faber' } }
        stt = { ...stt, mode: 'gpu', gpu: { engine: 'whisper-large-v3-turbo' } }
      }
      let voiceCallDefaults = { ...DEFAULT_VOICE_CALL_DEFAULTS }
      const asObj = (v: unknown): Record<string, unknown> | null =>
        v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
      const view = (): VoiceSettingsMap => ({
        audioInput: normalizeAudioInput(audioInput),
        sttSettings: stt,
        ttsSettings: tts,
        voiceCallDefaults: normalizeVoiceCallDefaults(voiceCallDefaults)
      })
      /**
       * Backend/modo 'gpu' + `gpu` (Modo avançado): mantidos mesmo que o normalizador compartilhado
       * ainda não os conheça (o backend da GPU acrescenta ao `voice.ts`).
       */
      const keepGpu = <T extends object>(
        norm: T,
        raw: Record<string, unknown> | null,
        field: 'backend' | 'mode'
      ): T => {
        if (!raw) return norm
        const out = { ...norm } as Record<string, unknown>
        if (raw[field] === 'gpu') out[field] = 'gpu'
        if ('gpu' in raw && !('gpu' in norm && (norm as { gpu?: unknown }).gpu))
          out.gpu = raw.gpu ?? null
        return out as T
      }
      const apply = (kind: string, value: unknown): unknown => {
        const raw = asObj(value)
        if (kind === 'audioInput') return (audioInput = normalizeAudioInput(value))
        if (kind === 'voiceCallDefaults')
          return (voiceCallDefaults = normalizeVoiceCallDefaults(value))
        if (kind === 'sttSettings') return (stt = keepGpu(normalizeSttSettings(value), raw, 'mode'))
        if (kind === 'ttsSettings')
          return (tts = keepGpu(normalizeTtsSettings(value), raw, 'backend'))
        throw new Error(`Grupo de settings desconhecido: ${kind}`)
      }
      // transcrição falsa: parciais ao vivo em timers + texto final fixo (sem áudio de verdade)
      const MOCK_PARTIALS = ['Olá', 'Olá mundo', 'Olá mundo, isto é um ditado']
      const MOCK_FINAL = 'Olá mundo, isto é um ditado simulado pelo mock de voz.'
      let sessionSeq = 0
      let active: { id: string; timers: ReturnType<typeof setTimeout>[] } | null = null
      return {
        settings: {
          get: () => delay(view()),
          set: <K extends VoiceSettingKind>(
            kind: K,
            value: unknown
          ): Promise<VoiceSettingsMap[K]> =>
            delay(apply(kind, value)) as Promise<VoiceSettingsMap[K]>
        },
        transcribe: {
          start: async (language?: string, opts?: { voice?: unknown }) => {
            // E2E: o ditado passa as camadas de voz do chat (a transcrição da persona — 1.9.0)
            ;(
              window as unknown as { __clearMockLastTranscribe?: unknown }
            ).__clearMockLastTranscribe = { language: language ?? null, voice: opts?.voice ?? null }
            if (active) throw new Error('Já há uma sessão de transcrição ativa.')
            const id = `voice-mock-${++sessionSeq}`
            const timers = MOCK_PARTIALS.map((text, i) =>
              setTimeout(
                () => {
                  const e: VoicePartialEvent = {
                    sessionId: id,
                    text,
                    isFinal: false,
                    ms: (i + 1) * 400
                  }
                  voiceListeners.forEach((l) => l(e))
                },
                350 * (i + 1)
              )
            )
            active = { id, timers }
            return delay(id, 30)
          },
          push: async () => {
            // o mock não acumula áudio
          },
          stop: async (sessionId: string) => {
            if (active?.id !== sessionId) throw new Error('Sessão de transcrição desconhecida.')
            active.timers.forEach(clearTimeout)
            active = null
            // E2E: `window.__clearMockSttFinal = 'fail'` simula a final que falha (parcial recuperável)
            if (
              (window as unknown as { __clearMockSttFinal?: string }).__clearMockSttFinal === 'fail'
            )
              return delay(null, 500).then(() => {
                throw new Error('Serviço de transcrição fora do ar (mock).')
              })
            return delay(
              {
                text: MOCK_FINAL,
                model: stt.api.model,
                baseUrl:
                  providers.find((p) => p.id === stt.api.providerId)?.baseUrl ?? 'mock://stt',
                ms: 320,
                backend: 'api' as const,
                fellBack: false
              },
              // latência de rede plausível (dá tempo de "Cancelar" durante o "Transcrevendo…")
              700
            )
          },
          cancel: async (sessionId: string) => {
            if (active?.id !== sessionId) return
            active.timers.forEach(clearTimeout)
            active = null
          },
          // fim de turno adaptativo: o mock não especula (o turno fecha pelo silêncio fixo)
          speculate: async () => null
        },
        // modelos locais (mock): 2 entradas fake e download simulado com progresso (cancelável)
        models: ((): VoiceApi['models'] => {
          const MOCK_MODEL_STEPS = 10
          const mockModels: VoiceModelInfo[] = [
            {
              id: 'mock-whisper-tiny',
              kind: 'stt',
              engine: 'whisper.cpp',
              name: 'Whisper tiny (mock)',
              description:
                'Modelo falso de STT para validar a UI de download (progresso, instalação e remoção).',
              languages: ['mul'],
              version: '1',
              sizeBytes: 77_691_713,
              hasDownload: true,
              state: 'notInstalled',
              installedBytes: null
            },
            {
              id: 'mock-kokoro',
              kind: 'tts',
              engine: 'kokoro',
              name: 'Kokoro (mock)',
              description:
                'Modelo falso de TTS para validar a UI de Fala (download, vozes e clipes).',
              languages: ['pt-BR'],
              version: '1',
              sizeBytes: 92_361_116,
              hasDownload: true,
              state: 'notInstalled',
              installedBytes: null
            }
          ]
          /** Downloads simulados em voo (id → timer + resolve da promise de `download`). */
          const mockDownloads = new Map<
            string,
            {
              timer: ReturnType<typeof setInterval>
              resolve: (v: VoiceModelInfo | null) => void
            }
          >()
          // mesma semântica do main: instalar escolhe o modelo como atual; remover o atual
          // derruba `installed` (a seleção engine/modelo fica)
          const syncMockModelSetting = (m: VoiceModelInfo, installed: boolean): void => {
            if (m.kind === 'stt') {
              const cur = stt.local
              if (installed) {
                stt = normalizeSttSettings({
                  ...stt,
                  local: {
                    engine: m.engine as SttLocalEngine,
                    model: m.id,
                    installed: true
                  }
                })
              } else if (
                cur &&
                cur.engine === m.engine &&
                (cur.model === m.id || !cur.model.trim())
              ) {
                stt = normalizeSttSettings({ ...stt, local: { ...cur, installed: false } })
              }
              return
            }
            const cur = tts.local
            if (installed) {
              tts = normalizeTtsSettings({
                ...tts,
                local: {
                  engine: m.engine as TtsLocalEngine,
                  voice: cur?.voice || 'pf_dora',
                  installed: true
                }
              })
            } else if (cur && cur.engine === m.engine) {
              tts = normalizeTtsSettings({ ...tts, local: { ...cur, installed: false } })
            }
          }
          return {
            list: () => delay(mockModels.map((m) => ({ ...m }))),
            download: (input: { id: string }) => {
              const m = mockModels.find((x) => x.id === input?.id)
              if (!m) return Promise.reject(new Error(`modelo desconhecido: ${String(input?.id)}`))
              if (!m.hasDownload)
                return Promise.reject(new Error(`modelo ${m.id} não tem download disponível`))
              if (mockDownloads.has(m.id))
                return Promise.reject(new Error(`download já em andamento para ${m.id}`))
              m.state = 'downloading'
              return new Promise<VoiceModelInfo | null>((resolve) => {
                let step = 0
                const timer = setInterval(() => {
                  if (!mockDownloads.has(m.id)) return
                  step++
                  const bytes = Math.round((m.sizeBytes * step) / MOCK_MODEL_STEPS)
                  voiceModelListeners.forEach((l) => l({ id: m.id, bytes, total: m.sizeBytes }))
                  if (step >= MOCK_MODEL_STEPS) {
                    clearInterval(timer)
                    mockDownloads.delete(m.id)
                    m.state = 'installed'
                    m.installedBytes = m.sizeBytes
                    syncMockModelSetting(m, true)
                    resolve({ ...m })
                  }
                }, 120)
                mockDownloads.set(m.id, { timer, resolve })
              })
            },
            cancel: async (input: { id: string }) => {
              const job = mockDownloads.get(input?.id ?? '')
              if (!job) return
              clearInterval(job.timer)
              mockDownloads.delete(input.id)
              const m = mockModels.find((x) => x.id === input.id)
              if (m) m.state = 'notInstalled'
              // cancelado: como no main, `download` resolve null (não é erro)
              job.resolve(null)
            },
            remove: async (input: { id: string }) => {
              const m = mockModels.find((x) => x.id === input?.id)
              if (!m) return
              if (mockDownloads.has(m.id))
                throw new Error(`download em andamento para ${m.id} — cancele antes de remover`)
              m.state = 'notInstalled'
              m.installedBytes = null
              syncMockModelSetting(m, false)
            }
          }
        })(),
        // TTS (mock): síntese falsa (wav curto), clipes simulados com progresso e vozes
        tts: ((): VoiceApi['tts'] => {
          /** wav falso (seno 440 Hz, 0,6 s a 24 kHz) para o "Testar voz" do mock. */
          const fakeWav = (): Uint8Array => {
            const samples = 14_400
            const buf = new Uint8Array(44 + samples * 2)
            const view = new DataView(buf.buffer)
            view.setUint32(0, 0x46464952, true) // 'RIFF'
            view.setUint32(4, 36 + samples * 2, true)
            view.setUint32(8, 0x45564157, true) // 'WAVE'
            view.setUint32(12, 0x20746d66, true) // 'fmt '
            view.setUint32(16, 16, true)
            view.setUint16(20, 1, true)
            view.setUint16(22, 1, true)
            view.setUint32(24, 24_000, true)
            view.setUint32(28, 48_000, true)
            view.setUint16(32, 2, true)
            view.setUint16(34, 16, true)
            view.setUint32(36, 0x61746164, true) // 'data'
            view.setUint32(40, samples * 2, true)
            for (let i = 0; i < samples; i++)
              view.setInt16(
                44 + i * 2,
                Math.round(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 8192),
                true
              )
            return buf
          }
          const fakeSynth = async (format?: 'wav' | 'mp3'): Promise<TtsSynthResult> => {
            await delay(undefined, 350)
            return {
              audio: fakeWav(),
              mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
              model:
                tts.backend === 'api'
                  ? tts.api.model || 'mock-tts'
                  : tts.backend === 'gpu'
                    ? `${tts.gpu?.engine ?? 'gpu'} (mock)`
                    : 'kokoro (mock)',
              backend: tts.backend === 'gpu' ? 'local' : tts.backend,
              ms: 350
            }
          }
          /** Cache de clipes POR VOZ (como `userData/voice-clips/<voz>`). */
          const clipsByVoice = new Map<string, TtsClipsView>()
          /** Fala efetiva: a deste dispositivo ou a voz de uma persona/chat (`input.tts`). */
          const ttsFor = (input?: { tts?: unknown }): TtsSettings =>
            applyTtsChoice(tts, normalizeVoiceTtsChoice(input?.tts))
          const voiceIdOf = (t: TtsSettings): string =>
            t.backend === 'local'
              ? `local-kokoro-${t.local?.voice || 'pf_dora'}`
              : t.backend === 'gpu'
                ? `gpu-${t.gpu?.engine ?? 'omnivoice'}-${t.gpu?.voice ?? 'padrao'}`
                : `api-${t.api.voice || 'padrao'}`
          return {
            synth: ({ format }) => fakeSynth(format),
            test: async (input) => {
              if (scenario === 'voice-tts-fail') {
                await delay(undefined, 300)
                throw new Error(
                  'chave de API inválida ou sem permissão (HTTP 401) — No auth credentials found'
                )
              }
              // `input.tts` = a voz de uma persona/chat (prévia do editor): o resultado diz o modelo dela
              const choice = normalizeVoiceTtsChoice(input?.tts)
              if (choice) {
                const r = await fakeSynth('wav')
                const eff = applyTtsChoice(tts, choice)
                return {
                  ...r,
                  model: eff.backend === 'api' ? eff.api.model : `${eff.backend} (mock)`
                }
              }
              // ElevenLabs direto com o formato de saída do plano Pro (conta sem Pro): o mesmo texto
              // que o main gera do 403 `output_format_not_allowed`
              const el = providers.find((p) => p.id === tts.api.providerId)
              if (
                tts.backend === 'api' &&
                el?.kind === 'elevenlabs' &&
                tts.api.params?.elevenlabs?.output_format === 'pcm_44100'
              ) {
                await delay(undefined, 200)
                throw new Error(
                  'TtsError: O formato de saída 44,1 kHz exige o plano Pro da ElevenLabs — escolha outro formato em Configurações → Áudio → Parâmetros'
                )
              }
              return fakeSynth('wav')
            },
            clips: {
              generate: async (input) => {
                const t = ttsFor(input)
                const voiceId = voiceIdOf(t)
                const view: TtsClipsView = {
                  voiceId,
                  backend: t.backend,
                  engine: t.backend === 'local' ? 'kokoro' : null,
                  model: t.backend === 'api' ? t.api.model : (t.local?.voice ?? ''),
                  generatedAt: new Date().toISOString(),
                  clips: []
                }
                clipsByVoice.set(voiceId, view)
                // os preâmbulos e as frases de ferramenta (pools configurados): `FILLER_<n>`/`TOOL_<n>`
                const sets = [
                  ['FILLER', resolveFillerPool(voiceCallDefaults.fillers.pool)],
                  ['TOOL', resolveToolPhrasePool(voiceCallDefaults.toolPhrases.pool)]
                ] as const
                const total = sets.reduce((a, [, pool]) => a + pool.length, 0)
                let done = 0
                for (const [cls, pool] of sets)
                  for (const [i, phrase] of pool.entries()) {
                    const n = i + 1
                    await delay(undefined, 60)
                    view.clips.push({ id: `${cls}_${n}`, class: cls, n, text: phrase.text })
                    done++
                    voiceTtsClipListeners.forEach((l) => l({ id: `${cls}_${n}`, done, total }))
                  }
                return view
              },
              list: async (input) => clipsByVoice.get(voiceIdOf(ttsFor(input))) ?? null
            },
            voices: async (): Promise<TtsVoicesView> => ({
              local:
                tts.local?.engine === 'chatterbox'
                  ? []
                  : [
                      {
                        id: 'pf_dora',
                        label: 'Dora (pt-BR, feminina)',
                        engine: 'kokoro',
                        installed: true
                      },
                      {
                        id: 'pm_alex',
                        label: 'Alex (pt-BR, masculina)',
                        engine: 'kokoro',
                        installed: false
                      },
                      {
                        id: 'pm_santa',
                        label: 'Santa (pt-BR, masculina)',
                        engine: 'kokoro',
                        installed: false
                      }
                    ],
              api: ['alloy', 'echo', 'nova', 'onyx', 'shimmer'].map((id) => ({
                id,
                label: id,
                engine: null
              }))
            })
          }
        })(),
        // Chamada de voz (mock): máquina de turnos simulada — `turn(text)` "responde" com 2
        // utterances (wav curto gerado aqui) emitidas em ordem; barge-in descarta a fala pendente
        // e `playbackIdle` (do `UtteranceQueue` real, tocando os beeps) devolve ao "Ouvindo…".
        call: ((): VoiceApi['call'] => {
          let state: VoiceCallState = { ...VOICE_CALL_INACTIVE }
          let seq = 0
          let timers: ReturnType<typeof setTimeout>[] = []
          const setState = (patch: Partial<VoiceCallState>): VoiceCallState => {
            state = { ...state, ...patch }
            voiceCallStateListeners.forEach((l) => l({ ...state }))
            return { ...state }
          }
          const clearTimers = (): void => {
            timers.forEach(clearTimeout)
            timers = []
          }
          /** wav PCM16 mono 16 kHz curto (senoide) — o `UtteranceQueue` toca de verdade. */
          const beep = (freq: number, ms: number): Uint8Array => {
            const rate = 16000
            const n = Math.round((rate * ms) / 1000)
            const buf = new ArrayBuffer(44 + n * 2)
            const v = new DataView(buf)
            const ascii = (o: number, s: string): void => {
              for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
            }
            ascii(0, 'RIFF')
            v.setUint32(4, 36 + n * 2, true)
            ascii(8, 'WAVE')
            ascii(12, 'fmt ')
            v.setUint32(16, 16, true)
            v.setUint16(20, 1, true)
            v.setUint16(22, 1, true)
            v.setUint32(24, rate, true)
            v.setUint32(28, rate * 2, true)
            v.setUint16(32, 2, true)
            v.setUint16(34, 16, true)
            ascii(36, 'data')
            v.setUint32(40, n * 2, true)
            for (let i = 0; i < n; i++)
              v.setInt16(
                44 + i * 2,
                Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000),
                true
              )
            return new Uint8Array(buf)
          }
          const callMark = (sid: string, content: string, mark: VoiceCallMark): void => {
            const ss = sessions.find((x) => x.id === sid)
            const leaf = activeLeaf(sessionMsgs(sid), ss?.branchSel)
            const m = msg(
              sid,
              { role: 'assistant', content },
              { synthetic: true, kind: 'voice-call', voiceCall: mark },
              Date.now()
            )
            m.parentId = leaf ? leaf.id : null
            messages.push(m)
            emit({ type: 'message-added', message: m })
          }
          const speak = (sentences: number[]): void => {
            setState({ phase: 'speaking' })
            let at = 150
            for (const freq of sentences) {
              timers.push(
                setTimeout(() => {
                  voiceCallUtteranceListeners.forEach((l) =>
                    l({
                      id: `u-mock-${++seq}`,
                      audio: beep(freq, 600),
                      mime: 'audio/wav',
                      kind: 'sentence'
                    })
                  )
                }, at)
              )
              at += 1000
            }
          }
          return {
            start: async ({ sessionId }: { sessionId: string }) => {
              if (state.active) throw new Error('Já existe uma chamada de voz ativa.')
              if (scenario === 'voice-call-fail')
                throw new Error(
                  'Não foi possível iniciar a chamada de voz: espeak-ng não encontrado no sistema (simulado).'
                )
              state = {
                ...VOICE_CALL_INACTIVE,
                active: true,
                chatId: sessions.find((x) => x.id === sessionId)?.chatId ?? 'c1',
                sessionId,
                turnSilenceMs: resolveTurnSilenceMs(voiceCallDefaults.turn, audioInput),
                callId: `call-${Date.now()}`,
                startedAt: Date.now()
              }
              // marcador de início no histórico (como o main — mensagem só de exibição)
              callMark(sessionId, 'Chamada de voz iniciada', {
                callId: state.callId!,
                phase: 'start',
                startedAt: state.startedAt!
              })
              // GPU local (como o main): motores não carregados → "Preparando a GPU…" (o microfone
              // só abre depois); falha no aquecimento encerra a chamada com o motivo
              const gpuIds = [
                ...(tts.backend === 'gpu' ? [tts.gpu?.engine ?? 'omnivoice'] : []),
                ...(stt.mode === 'gpu' ? ['whisper-large-v3-turbo' as const] : [])
              ]
              if (gpuIds.length && !gpu.isWarm(gpuIds)) {
                state = { ...state, preparing: 'Iniciando…' }
                const still = (): boolean => state.active && state.sessionId === sessionId
                void gpu
                  .warm(gpuIds, (t) => {
                    if (still()) setState({ preparing: t })
                  })
                  .then(() => {
                    if (still()) setState({ preparing: null })
                  })
                  .catch((e: unknown) => {
                    if (!still()) return
                    clearTimers()
                    state = {
                      ...VOICE_CALL_INACTIVE,
                      error: `a GPU local não ficou pronta — ${(e as Error).message}. Feche programas que usam a GPU e tente de novo, ou use uma voz na nuvem (Configurações → Áudio)`
                    }
                    voiceCallStateListeners.forEach((l) => l({ ...state }))
                  })
              }
              voiceCallStateListeners.forEach((l) => l({ ...state }))
              // ?scenario=voice-call-api-error → os créditos da voz acabam no meio da chamada: o main
              // encerra a chamada com o motivo (estado inativo + error)
              if (scenario === 'voice-call-api-error')
                timers.push(
                  setTimeout(() => {
                    clearTimers()
                    state = {
                      ...VOICE_CALL_INACTIVE,
                      error: 'créditos da ElevenLabs esgotados (voz)'
                    }
                    voiceCallStateListeners.forEach((l) => l({ ...state }))
                  }, 1200)
                )
              return { ...state }
            },
            stop: async () => {
              clearTimers()
              if (state.active && state.sessionId && state.callId && state.startedAt) {
                const endedAt = Date.now()
                const durationMs = endedAt - state.startedAt
                callMark(
                  state.sessionId,
                  `Chamada encerrada · ${formatCallDuration(durationMs)} · por você`,
                  {
                    callId: state.callId,
                    phase: 'end',
                    startedAt: state.startedAt,
                    endedAt,
                    durationMs,
                    endedBy: 'user'
                  }
                )
              }
              state = { ...VOICE_CALL_INACTIVE }
              voiceCallStateListeners.forEach((l) => l({ ...state }))
              return { ...state }
            },
            mute: async ({ muted }: { muted: boolean }) => setState({ muted }),
            speechBegin: async () => setState({ phase: 'listening' }),
            speechEnd: async () => setState({ phase: 'transcribing' }),
            turn: async ({ text }: { text: string }) => {
              clearTimers()
              if (!text.trim()) return setState({ phase: 'listening' })
              const s = setState({ phase: 'thinking' })
              timers.push(setTimeout(() => speak([440, 330]), 700))
              return s
            },
            playbackIdle: async () =>
              state.phase === 'speaking' ? setState({ phase: 'listening' }) : { ...state },
            bargeIn: async () => {
              clearTimers()
              return setState({ phase: 'listening' })
            },
            backchannel: async () => {
              // mock sem backchannel: só aceita o registro
            },
            getState: async () => ({ ...state })
          }
        })(),
        // descoberta de modelos/vozes (dados reais do OpenRouter recortados — `mockVoiceCatalog.ts`)
        catalog: createMockVoiceCatalog(() => providers, delay),
        // voz da persona/chat NESTE dispositivo (protocolo 1.9.0): o resolvedor compartilhado sobre
        // o que o mock "tem" (provedores, Kokoro/whisper "instalados", espeak-ng, a GPU do mock)
        resolve: async (input) => {
          const gs = (await mockApi.voice?.gpu?.status().catch(() => null)) ?? null
          const noEspeak = scenario === 'voice-no-espeak'
          const gpuCheck = (engine: string, voice?: string | null): VoiceCheck => {
            if (!gs)
              return { ok: false, reason: 'o modo GPU local não está disponível neste dispositivo' }
            if (gs.runtime.state !== 'installed')
              return { ok: false, reason: 'o runtime da GPU não está instalado neste dispositivo' }
            const e = gs.engines.find((x) => x.id === engine)
            if (!e || e.install.state !== 'installed')
              return {
                ok: false,
                reason: `o motor ${e?.label ?? engine} não está instalado neste dispositivo`
              }
            if (voice && !e.voices.some((v) => v.id === voice))
              return { ok: false, reason: `a voz “${voice}” não existe neste dispositivo` }
            return { ok: true }
          }
          const caps: VoiceDeviceCaps = {
            provider: (id, capability) => {
              const p = providers.find((x) => x.id === id)
              if (!p)
                return { ok: false, reason: 'o provedor escolhido não existe neste dispositivo' }
              return providerSupportsVoice(p, capability)
                ? { ok: true }
                : {
                    ok: false,
                    reason: `o provedor “${p.name}” não serve ${capability === 'tts' ? 'fala' : 'transcrição'}`
                  }
            },
            ttsLocal: ({ engine, voice }) => {
              if (engine !== 'kokoro')
                return { ok: false, reason: `o motor ${engine} ainda não fala nesta versão do app` }
              if (noEspeak)
                return {
                  ok: false,
                  reason:
                    'espeak-ng não encontrado no sistema (instale o pacote "espeak-ng") neste dispositivo'
                }
              if (!ready && !(tts.local?.engine === 'kokoro' && tts.local.installed))
                return { ok: false, reason: 'modelo do Kokoro não instalado neste dispositivo' }
              return voice === 'pf_dora'
                ? { ok: true }
                : { ok: false, reason: `voz ${voice} não instalada neste dispositivo` }
            },
            sttLocal: () =>
              stt.local?.installed
                ? { ok: true }
                : { ok: false, reason: 'nenhum modelo do whisper.cpp instalado neste dispositivo' },
            ttsGpu: ({ engine, voice }) => gpuCheck(engine, voice),
            sttGpu: ({ engine }) => gpuCheck(engine)
          }
          const layers = {
            chat: input?.chat ? normalizeVoiceCallConfig(input.chat) : null,
            persona: input?.persona ? normalizeVoiceCallConfig(input.persona) : null
          }
          return delay({
            tts: resolveTtsVoice(layers, tts, caps),
            stt: resolveSttVoice(layers, stt, normalizeAudioInput(audioInput).language, caps)
          })
        },
        // probe dos runtimes locais (mock): tudo carregável, salvo ?scenario=voice-no-espeak
        runtime: {
          status: async (): Promise<VoiceRuntimeStatus> => {
            const ok = { available: true, reason: null }
            const noEspeak = scenario === 'voice-no-espeak'
            const espeak = noEspeak
              ? {
                  available: false,
                  reason: 'espeak-ng não encontrado no sistema (instale o pacote "espeak-ng")'
                }
              : ok
            return delay({
              whisper: ok,
              onnxruntime: ok,
              espeak,
              sttLocal: stt.local?.installed
                ? ok
                : { available: false, reason: 'nenhum modelo local instalado' },
              ttsLocal: noEspeak ? espeak : ok
            })
          }
        }
      }
    })(),
    onVoicePartial: (cb: (e: VoicePartialEvent) => void) => {
      voiceListeners.add(cb)
      return () => voiceListeners.delete(cb)
    },
    onVoiceModelProgress: (cb: (e: VoiceModelProgressEvent) => void) => {
      voiceModelListeners.add(cb)
      return () => voiceModelListeners.delete(cb)
    },
    onVoiceTtsClipsProgress: (cb: (e: TtsClipProgressEvent) => void) => {
      voiceTtsClipListeners.add(cb)
      return () => voiceTtsClipListeners.delete(cb)
    },
    onVoiceCallState: (cb: (e: VoiceCallState) => void) => {
      voiceCallStateListeners.add(cb)
      return () => voiceCallStateListeners.delete(cb)
    },
    onVoiceCallUtterance: (cb: (e: VoiceCallUtteranceEvent) => void) => {
      voiceCallUtteranceListeners.add(cb)
      return () => voiceCallUtteranceListeners.delete(cb)
    },
    onVoiceCallUtteranceCancel: (cb: (e: VoiceCallUtteranceCancelEvent) => void) => {
      // mock sem preâmbulos: o cancelamento nunca dispara, mas o canal existe
      void cb
      return () => void 0
    },
    onVoiceCallTimeline: (cb: (e: VoiceCallTimelineEvent) => void) => {
      // mock sem atos de fala curta: a timeline não enche, mas o canal existe
      void cb
      return () => void 0
    },
    onEvent: (cb) => {
      listeners.add(cb)
      if (scenario.startsWith('subagents')) {
        // o subagente "Resumir o artigo" morre com erro do provider (vermelho na sidebar/composer)
        const sd = sessions.find((x) => x.id === 's3d')
        if (sd) {
          sd.status = 'running'
          setTimeout(() => {
            sd.status = 'error'
            emit({
              type: 'error',
              sessionId: 's3d',
              error: 'Erro HTTP 402 Payment Required: Insufficient credits for this request.'
            })
            emit({ type: 'session-updated', session: { ...sd } })
          }, 600)
        }
      }
      if (scenario === 'reasoning') {
        // Raciocínio longo: uma resposta já salva + um segundo turno ainda "pensando".
        const s2 = sessions.find((x) => x.id === 's2')!
        const u1 = msg('s2', {
          role: 'user',
          content: 'Qual a melhor forma de paginar uma lista enorme no SQLite?'
        })
        const a1 = msg(
          's2',
          {
            role: 'assistant',
            content:
              'Use **keyset pagination** (`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 50`) com um índice composto — o custo por página fica constante, ao contrário de `OFFSET`.',
            reasoning: LONG_REASONING
          },
          {
            usage: {
              promptTokens: 812,
              completionTokens: 1460,
              reasoningTokens: 1210,
              cost: 0.0042
            },
            model: 'openai/gpt-5',
            durationMs: 18_400,
            reasoningMs: 12_400
          }
        )
        const u2 = msg('s2', {
          role: 'user',
          content: 'E se a ordenação puder mudar (por título, por data…)?'
        })
        messages.push(u1, a1)
        let i = 0
        setTimeout(() => {
          s2.status = 'running'
          emit({ type: 'session-updated', session: { ...s2 } })
          emit({ type: 'message-added', message: a1 })
          emit({ type: 'message-added', message: u2 })
          const t = setInterval(() => {
            i = Math.min(LONG_REASONING.length, i + 6)
            emit({
              type: 'draft',
              sessionId: 's2',
              draft: { reasoning: LONG_REASONING.slice(0, i), content: '', toolCalls: [] }
            })
            if (i >= LONG_REASONING.length) clearInterval(t)
          }, 30)
        }, 200)
      }
      if (scenario === 'stream') {
        const s2 = sessions.find((x) => x.id === 's2')!
        const um = msg('s2', {
          role: 'user',
          content:
            'Me dá 3 ideias de nome curtas para um app de chat minimalista, com uma frase de justificativa cada.'
        })
        messages.push(um)
        const full =
          'Aqui vão três opções:\n\n1. **Lumen** — sugere clareza e leveza, combina com uma interface limpa.\n2. **Quill** — remete à escrita, curto e fácil de lembrar.\n3. **Hush** — transmite calma e foco, sem ruído visual.'
        let i = 0
        setTimeout(() => {
          s2.status = 'running'
          emit({ type: 'session-updated', session: { ...s2 } })
          emit({ type: 'message-added', message: um })
          const t = setInterval(() => {
            i = Math.min(full.length, i + 9)
            emit({
              type: 'draft',
              sessionId: 's2',
              draft: {
                reasoning:
                  'O usuário quer nomes curtos e evocativos. Vou priorizar palavras de uma ou duas sílabas.',
                content: full.slice(0, i),
                toolCalls: []
              }
            })
            if (i >= full.length * 0.7) clearInterval(t)
          }, 40)
        }, 200)
      }
      if (scenario === 'markdown') {
        // Markdown difícil: cercas aninhadas, LaTeX em todos os delimitadores, preços; e um
        // rascunho em streaming parado no meio de um bloco aninhado e de uma fórmula.
        const s2 = sessions.find((x) => x.id === 's2')!
        const um = msg('s2', { role: 'user', content: 'Mostra um README e umas fórmulas.' })
        const am = msg('s2', { role: 'assistant', content: MARKDOWN_SAMPLE }, { model: cfg.model })
        const u2 = msg('s2', { role: 'user', content: 'E em streaming?' })
        messages.push(um, am, u2)
        setTimeout(() => {
          s2.status = 'running'
          emit({ type: 'session-updated', session: { ...s2 } })
          emit({
            type: 'draft',
            sessionId: 's2',
            draft: { reasoning: '', content: MARKDOWN_STREAM, toolCalls: [] }
          })
        }, 200)
      }
      return () => listeners.delete(cb)
    }
  }
  // Modo avançado (GPU local): `voice.gpu` + `onVoiceGpuProgress` (`mockGpu.ts`, cenários `gpu-*`;
  // os demais cenários usam o `gpu-ok` — RTX 3080 Ti com o runtime ausente)
  const gpu = createMockGpu(scenario.startsWith('gpu-') ? scenario : 'gpu-ok', delay)
  Object.assign(mockApi.voice ?? {}, { gpu: gpu.api })
  Object.assign(mockApi, { onVoiceGpuProgress: gpu.onProgress })
  return mockApi
}

const LONG_REASONING = `O usuário quer paginar uma lista grande no SQLite. A resposta óbvia é LIMIT/OFFSET, mas OFFSET fica linear: para pular 100 mil linhas o SQLite precisa percorrer 100 mil linhas do índice antes de devolver a primeira. Em listas que crescem, a página 2000 vira um gargalo.

Alternativa: keyset pagination (seek method). Guardo a última chave vista (created_at, id) e peço "as próximas 50 depois desta chave". Com um índice composto em (created_at DESC, id DESC) isso vira um range scan que começa exatamente no ponto certo — custo constante por página.

Detalhes que importam:
- O desempate por id é obrigatório; created_at sozinho não é único e linhas com o mesmo timestamp seriam puladas ou repetidas.
- A comparação de tupla (created_at, id) < (?, ?) é suportada pelo SQLite desde a 3.15 (row values). Em versões antigas, expandir para created_at < ? OR (created_at = ? AND id < ?).
- Conferir com EXPLAIN QUERY PLAN que aparece "SEARCH ... USING INDEX" e não "SCAN".
- Para "voltar uma página", inverter a comparação e a ordem, e depois reverter o resultado no cliente.
- Contar o total (COUNT(*)) continua caro; melhor mostrar "carregar mais" do que números de página.

Também vale lembrar do WAL: leituras longas não bloqueiam escritas, então paginar durante inserções é seguro, mas a página pode "andar" se linhas novas entrarem antes do cursor — com keyset isso não duplica itens, ao contrário do OFFSET, que repete o último item quando algo é inserido no topo.

Se a ordenação for por uma coluna não única (título, por exemplo), o mesmo princípio vale: chave composta (title, id) e um índice correspondente. Se o usuário puder escolher a ordenação livremente, um índice por ordenação suportada; colunas sem índice ficam com OFFSET mesmo, mas limitadas.

Resposta final: recomendar keyset com índice composto, mostrar a query, mencionar o desempate e o EXPLAIN QUERY PLAN. Manter curto.`

const MARKDOWN_SAMPLE = [
  'Aqui está o README:',
  '',
  '```markdown',
  '# Projeto',
  '',
  '## Instalação',
  '',
  '```bash',
  'npm install',
  '```',
  '',
  '## Uso',
  '',
  '```',
  'npm start',
  '```',
  '```',
  '',
  'A energia é \\(E = mc^2\\) e a média é $\\bar{x} = \\frac{1}{n}\\sum_i x_i$. O plano custa $5 e o extra $10.',
  '',
  '\\[',
  '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
  '\\]',
  '',
  '$$',
  'f(x) = \\sum_{k=0}^{\\infty} \\frac{f^{(k)}(a)}{k!}(x-a)^k + \\underbrace{a_0 + a_1 x + a_2 x^2 + a_3 x^3 + a_4 x^4 + a_5 x^5 + a_6 x^6 + a_7 x^7 + a_8 x^8}_{\\text{bem larga}}',
  '$$',
  '',
  '- Em lista: \\(\\alpha + \\beta\\)',
  '  \\[ \\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0} \\]',
  '- TeX inválido: $\\frac{1}{$ e \\(\\badcommand{x}\\)',
  '',
  'Código inline fica intacto: `\\(x\\)` e `$5`.'
].join('\n')

const MARKDOWN_STREAM = [
  'Claro:',
  '',
  '```markdown',
  '# Outro',
  '',
  '```python',
  'print("oi")',
  '```',
  '```',
  '',
  'Fórmula:',
  '',
  '\\[',
  '\\frac{a}{b'
].join('\n')
