// Conteúdo dos ícones (i): o que exatamente vai para a API e como. Fonte única para toda a UI.
import { useEffect, useState } from 'react'
import { currentToolDefinition } from '@shared/tools'
import {
  COMPACT_TOOLS_HELP,
  COMPACT_TOOLS_PROMPT,
  NATIVE_TOOL_SEARCH_HELP,
  SEARCH_TOOL_DEFINITION,
  isCompactable,
  sendsCompact,
  sentToolDefinition
} from '@shared/compactTools'
import {
  SEARCH_ENTRY_NOTE,
  TOOL_SEARCH_LOCAL_NOTICE,
  isNativeMode,
  messagesApiTool,
  type ToolSearchModeView
} from '@shared/toolSearch'
import { COMPACTION_NOTE, compactionMessageText } from '@shared/defaults'
import { LIMITS } from '@shared/limits'
import { audioFormat, contentText, formatSize, messageAttachments } from '@shared/attachments'
import type {
  ApiMessage,
  AttachmentMeta,
  ChatConfig,
  ChatParams,
  StoredMessage,
  ToolName
} from '@shared/types'
import { api } from '../lib/api'
import { ATTACHMENT_LIMITS } from '@shared/limits'
import type { EffortSpec } from '@shared/modelParams'
import type { MemoryPreview } from '@shared/memory'
import { extractionOf, type MemoryExtractionMeta } from '../lib/memory'
import { SKILL_LIMITS, skillBlockBody, type SkillPartMeta } from '@shared/skills'
import { SKILL_TOOL_NAMES } from '@shared/tools'
import { ApiInfo, C } from './ui/Tooltip'

type Side = 'top' | 'right' | 'bottom' | 'left'

export function SystemPromptInfo({
  subagent,
  side
}: {
  subagent?: boolean
  side?: Side
}): React.JSX.Element {
  return (
    <ApiInfo title={subagent ? 'System prompt dos subagentes' : 'System prompt'} side={side}>
      {subagent ? (
        <p>
          Nas subsessões criadas por <C>delegate_task</C>, este texto substitui o system prompt
          principal: vira a mensagem <C>{'role: "system"'}</C> no início de <C>messages</C> de cada
          request do subagente.
        </p>
      ) : (
        <p>
          Enviado como a primeira mensagem do array <C>messages</C>, com <C>{'role: "system"'}</C>.
          Usado só na sessão principal.
        </p>
      )}
      <p>
        Ordem do conteúdo: este texto → <C>\n\n</C> + bloco <C>{'<environment>'}</C> (se ativo) →{' '}
        <C>\n\n</C> + índice e instruções da memória (se ativa; só na principal) → <C>\n\n</C> +
        prompt de apoio das skills (se ligado) → <C>\n\n</C> + texto das tools (se ativo) →{' '}
        <C>\n\n</C> + prompt fixo das tools compactadas (só se alguma tool vai compacta). Com token
        caching, o conteúdo vai como{' '}
        <C>{'[{ type: "text", text, cache_control: { type: "ephemeral" } }]'}</C>. Se tudo ficar
        vazio, nenhuma mensagem system é enviada.
      </p>
    </ApiInfo>
  )
}

export function ModelFieldInfo({ side }: { side?: Side }): React.JSX.Element {
  return (
    <ApiInfo title="Modelo" side={side}>
      <p>
        O que se escolhe é o par <b>provedor + modelo</b>: o id vai no campo <C>model</C> do body de{' '}
        <C>POST {'{baseUrl}'}/chat/completions</C> <i>desse</i> provedor, com a key dele (
        <C>Authorization: Bearer …</C>) e os headers extras dele. O mesmo id em dois provedores
        (ex.: um Claude via OpenRouter e via Anthropic) são opções diferentes.
      </p>
      <p>
        <C>HTTP-Referer</C>/<C>X-Title</C> vêm da &quot;Assinatura do app&quot;; em OpenRouter
        também vai <C>{'usage: { include: true }'}</C>. Trocar no meio do chat vale a partir da
        próxima request; subagentes ficam no provedor da sessão que os criou, salvo se o{' '}
        <C>delegate_task</C> informar <C>provider</C> (e/ou <C>model</C>) — aí o subagente fica fixo
        nesse par.
      </p>
    </ApiInfo>
  )
}

const PARAM_DOCS: Record<Exclude<keyof ChatParams, 'extraBody'>, string> = {
  temperature: 'Aleatoriedade da amostragem. Maior = mais criativo.',
  top_p: 'Nucleus sampling: considera só os tokens que somam esta probabilidade.',
  top_k: 'Considera só os K tokens mais prováveis (nem todo provedor aceita).',
  max_tokens: 'Limite de tokens gerados na resposta.',
  frequency_penalty: 'Penaliza tokens proporcionalmente à frequência em que já apareceram.',
  presence_penalty: 'Penaliza tokens que já apareceram ao menos uma vez.',
  repetition_penalty: 'Penalidade de repetição (OpenRouter e alguns provedores).',
  seed: 'Semente para amostragem determinística (quando suportado).',
  reasoning_effort: 'Esforço de raciocínio em modelos que suportam.'
}

export function ParamInfo({
  name,
  openRouter,
  effort
}: {
  name: keyof typeof PARAM_DOCS
  openRouter: boolean
  /** reasoning_effort: níveis do modelo, origem e formato no body (@shared/modelParams). */
  effort?: EffortSpec | null
}): React.JSX.Element {
  return (
    <ApiInfo title={<span className="font-mono text-[12px]">{name}</span>} side="left">
      <p>{PARAM_DOCS[name]}</p>
      {name === 'reasoning_effort' ? (
        <>
          <p>
            Enviado como{' '}
            <C>{effort?.wire ?? (openRouter ? 'reasoning: { effort }' : 'reasoning_effort')}</C> no
            body.
            {effort?.wire.startsWith('reasoning:') &&
              ' O OpenRouter traduz para o provedor (OpenAI reasoning_effort, Anthropic effort/budget_tokens, Gemini thinkingLevel) e leva níveis não aceitos ao mais próximo.'}
          </p>
          {effort && (
            <p data-testid="effort-origin">
              Níveis: <C>{effort.levels.join(' · ')}</C>
              {effort.source === 'unknown' && <b className="text-fg"> (não informado pela API)</b>}.
              Origem: {effort.origin}
              {effort.mandatory && ' Raciocínio obrigatório neste modelo (não aceita "none").'}
              {effort.known &&
                ' Um valor salvo fora desses níveis é ajustado para o mais próximo (ou omitido) na request.'}
            </p>
          )}
        </>
      ) : (
        <p>
          Enviado como <C>{`"${name}": <número>`}</C> na raiz do body.
        </p>
      )}
      <p className="text-subtle">
        Só vai na request com o toggle ligado; desligado, o campo é omitido.
      </p>
    </ApiInfo>
  )
}

export function ExtraBodyInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Body extra (JSON)" side="left">
      <p>
        Objeto JSON mesclado de forma rasa (<C>{'{ ...body, ...extra }'}</C>) na raiz do body,{' '}
        <strong className="text-fg">por último</strong> — sobrescreve qualquer campo, inclusive{' '}
        <C>model</C>, <C>messages</C> e <C>tools</C>. Vazio = nada é mesclado.
      </p>
    </ApiInfo>
  )
}

/** Config que decide a compactação de uma tool (o chat/persona; voz: a do chat). */
type CompactCfg = Pick<ChatConfig, 'toolsCompact' | 'toolsFull'>

export function ToolDefInfo({
  name,
  nativeTools,
  cfg,
  view
}: {
  name: ToolName
  nativeTools: boolean
  /** Compactação (1.11.0): a definição mostrada é a que vai — compacta ou completa. */
  cfg?: CompactCfg
  /**
   * Modo de envio do chat (busca nativa, 1.12.0): nos nativos o item mostrado é o da Messages API,
   * completo, com `defer_loading` (e o `cache_control`, se for o ponto de cache) — exatamente como vai.
   */
  view?: ToolSearchModeView | null
}): React.JSX.Element {
  if (view && isNativeMode(view.mode) && isCompactable(name))
    return <NativeToolDefInfo name={name} nativeTools={nativeTools} cfg={cfg} view={view} />
  const compact = sendsCompact(name, cfg)
  return (
    <ApiInfo
      title={<span className="font-mono text-[12px]">{name}</span>}
      code={JSON.stringify(sentToolDefinition(currentToolDefinition(name), cfg), null, 2)}
      codeLabel={
        compact
          ? 'Definição exata, compacta (um item do array tools):'
          : 'Definição exata (um item do array tools):'
      }
      side="left"
    >
      {compact ? (
        <p data-testid="tool-def-mode" data-mode="compact">
          <b className="text-fg">Vai compacta</b>: só o nome e a descrição curta, com os parâmetros
          vazios. A definição completa volta ao modelo pela <C>tool_search</C> (e no erro, se ele a
          chamar com argumentos inválidos). Marque &quot;completa&quot; para mandá-la inteira.
        </p>
      ) : (
        <p data-testid="tool-def-mode" data-mode="full" className="sr-only">
          Vai completa.
        </p>
      )}
      <p>
        {nativeTools ? (
          <>
            Habilitada: enviada como um item do array <C>tools</C> da request.
          </>
        ) : (
          <>
            &quot;Tools nativas&quot; está desligado: o campo <C>tools</C> não é enviado. A tool só
            chega ao modelo se o texto das tools no system prompt estiver ligado.
          </>
        )}{' '}
        <C>delegate_task</C> é omitida em subsessões de nível 2.
      </p>
    </ApiInfo>
  )
}

/** `<>` de uma tool num modo de busca nativa: o item exato da Messages API (adiada ou carregada). */
function NativeToolDefInfo({
  name,
  nativeTools,
  cfg,
  view
}: {
  name: ToolName
  nativeTools: boolean
  cfg?: CompactCfg
  view: ToolSearchModeView
}): React.JSX.Element {
  const deferred = sendsCompact(name, cfg)
  const item = view.items[name] ?? messagesApiTool(currentToolDefinition(name), deferred)
  const who = view.mode === 'native-anthropic' ? 'da Anthropic' : 'do OpenRouter'
  return (
    <ApiInfo
      title={<span className="font-mono text-[12px]">{name}</span>}
      code={JSON.stringify(item, null, 2)}
      codeLabel="Item exato do array tools (formato da Messages API):"
      side="left"
    >
      {deferred ? (
        <p data-testid="tool-def-mode" data-mode="deferred">
          <b className="text-fg">Vai adiada</b> (<C>defer_loading: true</C>): a definição completa
          vai na request, mas o modelo só a vê depois de encontrá-la pela busca nativa {who}. Marque
          &quot;carregada&quot; para ele vê-la desde o início.
        </p>
      ) : (
        <p data-testid="tool-def-mode" data-mode="loaded">
          <b className="text-fg">Vai carregada</b> desde o início (sem <C>defer_loading</C>).
          {item.cache_control ? (
            <>
              {' '}
              Leva o ponto de cache (<C>cache_control</C>): é a última tool carregada.
            </>
          ) : null}
        </p>
      )}
      {!nativeTools && (
        <p>
          &quot;Tools nativas&quot; está desligado: o campo <C>tools</C> não é enviado.
        </p>
      )}
    </ApiInfo>
  )
}

export function NativeToolsInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Tools nativas" side="left">
      <p>
        Ligado: as definições JSON das tools habilitadas vão no campo <C>tools</C> da request (antes
        do system, no prefixo cacheável) e o modelo responde com <C>tool_calls</C>.
      </p>
      <p>
        Desligado: o campo <C>tools</C> é omitido. Se o texto das tools no prompt estiver ligado, o
        modelo é instruído a chamar ferramentas escrevendo <C>{'<tool_call>{…}</tool_call>'}</C>, e
        os resultados voltam como mensagens <C>{'role: "user"'}</C> com{' '}
        <C>{'<tool_result name="…">…</tool_result>'}</C>.
      </p>
    </ApiInfo>
  )
}

/**
 * `<>` de "Enviar tools compactadas": o que vai, exatamente, no modo efetivo do chat (1.12.0).
 * Versão local (1.11.0): o prompt fixo e a definição da `tool_search` (textos do app, não
 * editáveis). Busca nativa: a entrada de busca do servidor como vai (descrição do provedor) — sem
 * prompt do app e sem `tool_search`.
 */
export function CompactToolsInfo({
  view
}: {
  view?: ToolSearchModeView | null
}): React.JSX.Element {
  if (view && isNativeMode(view.mode)) {
    return (
      <ApiInfo
        title={`Tools compactadas · ${view.label}`}
        code={JSON.stringify(view.searchEntry, null, 2)}
        codeLabel="Entrada de busca — último item do array tools:"
        side="left"
      >
        <p data-testid="compact-tools-native" data-mode={view.mode}>
          {NATIVE_TOOL_SEARCH_HELP}
        </p>
        <p>
          Cada tool que não está marcada &quot;carregada&quot; vai com a definição completa e{' '}
          <C>defer_loading: true</C>; as marcadas (e <C>end_call</C>) vão carregadas, e a última
          carregada leva o ponto de cache. A entrada de busca abaixo vai por último.{' '}
          {SEARCH_ENTRY_NOTE[view.mode]} Não há <C>tool_search</C> do app nem instrução no system
          prompt.
          {view.mode === 'native-openrouter' && (
            <>
              {' '}
              Enquanto houver tools adiadas, a request vai para <C>/messages</C> (Messages API do
              OpenRouter) em vez de <C>/chat/completions</C>.
            </>
          )}{' '}
          O <C>{'</>'}</C> de cada tool mostra o item exato.
        </p>
      </ApiInfo>
    )
  }
  return (
    <ApiInfo
      title="Tools compactadas"
      code={JSON.stringify(SEARCH_TOOL_DEFINITION, null, 2)}
      codeLabel="tool_search — último item do array tools (sempre completa):"
      side="left"
    >
      <p>{COMPACT_TOOLS_HELP}</p>
      {view?.mode === 'local' && (
        <p data-testid="compact-tools-local">
          {TOOL_SEARCH_LOCAL_NOTICE}
          {view.reason ? ` Motivo: ${view.reason}.` : ''}
        </p>
      )}
      <p>
        Cada tool que não está marcada &quot;completa&quot; vai só com o nome e a descrição curta do
        app, com parâmetros vazios. Havendo pelo menos uma compacta, vão também a <C>tool_search</C>{' '}
        (abaixo) e este prompt fixo, no fim do system prompt (precedido de <C>\n\n</C>); sem nenhuma
        compacta, nenhum dos dois. Vale para memória, skills, subagentes e a chamada de voz (menos{' '}
        <C>end_call</C>, sempre completa).
      </p>
      <pre
        data-testid="compact-tools-prompt"
        className="rounded-lg border border-border bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/90"
      >
        {COMPACT_TOOLS_PROMPT}
      </pre>
    </ApiInfo>
  )
}

export function ToolsInPromptInfo({ text }: { text: string }): React.JSX.Element {
  return (
    <ApiInfo
      title="Texto das tools no system prompt"
      code={text}
      codeLabel="Texto exato anexado:"
      side="left"
    >
      <p>
        Anexado ao <strong className="text-fg">final</strong> do conteúdo da mensagem{' '}
        <C>{'role: "system"'}</C>, precedido de <C>\n\n</C>, depois do bloco de ambiente.
      </p>
    </ApiInfo>
  )
}

const ENV_RE = /<environment>[\s\S]*?<\/environment>/

function systemText(body: unknown): string | null {
  const msgs = (body as { messages?: ApiMessage[] } | null)?.messages
  const sys = msgs?.find((m) => m.role === 'system')
  if (!sys) return null
  return contentText(sys.content)
}

/** Busca o bloco <environment> exato via previewRequest; cai num modelo se o main não responder. */
function EnvBlock({
  sessionId,
  cwd,
  deps
}: {
  sessionId?: string
  cwd: string
  deps?: string
}): React.JSX.Element {
  const fallback = `<environment>\nroot: ${cwd}\nos: (sistema operacional detectado pelo app)\nshell: (shell do usuário)\n…\n</environment>`
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    api.agent
      .previewRequest(sessionId)
      .then((p) => {
        const m = systemText(p.body)?.match(ENV_RE)
        if (alive && m) setText(m[0])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [sessionId, cwd, deps])
  return (
    <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/90">
      {text ?? fallback}
    </pre>
  )
}

export function EnvInfo({
  sessionId,
  cwd,
  deps
}: {
  /** Sem sessão (ex.: editor de persona): mostra um modelo do bloco. */
  sessionId?: string
  cwd: string
  /** Muda quando opções que alteram o bloco mudam (confinação, sandbox). */
  deps?: string
}): React.JSX.Element {
  return (
    <ApiInfo title="Bloco de ambiente" side="left" wide>
      <p>
        Anexado ao conteúdo da mensagem <C>{'role: "system"'}</C>, precedido de <C>\n\n</C>, logo
        após o seu system prompt. Diz ao modelo o diretório raiz, o SO e as regras do workspace. Sem
        data/hora nem diretório atual do shell, para manter o prefixo estável para o cache. Texto
        exato:
      </p>
      <EnvBlock sessionId={sessionId} cwd={cwd} deps={deps} />
    </ApiInfo>
  )
}

export function RootInfo({ side }: { side?: Side }): React.JSX.Element {
  return (
    <ApiInfo title="Diretório raiz" side={side}>
      <p>
        O workspace da sessão (e de todos os subagentes). Com o bloco de ambiente ativo, aparece no
        system prompt como <C>root: …</C> dentro de <C>{'<environment>'}</C>, junto com a regra de
        que caminhos relativos resolvem a partir dele.
      </p>
      <p>
        Localmente: base dos caminhos relativos das ferramentas e diretório onde o <C>shell</C>{' '}
        começa (o <C>cd</C> persiste entre chamadas da mesma sessão).
      </p>
    </ApiInfo>
  )
}

export function ConfineInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Confinar ao diretório raiz" side="left">
      <p>
        Localmente, <C>list_dir</C>, <C>read_file</C>, <C>write_file</C>, <C>edit_file</C>,{' '}
        <C>search_files</C> e <C>find_files</C> recusam caminhos que (após resolver <C>..</C> e
        links simbólicos) saiam do diretório raiz; o erro volta ao modelo como{' '}
        <C>{'role: "tool"'}</C>. O shell sempre começa no raiz e volta a ele se terminar fora.
      </p>
      <p>
        Com o bloco de ambiente ativo, adiciona ao system prompt a linha:{' '}
        <C>As ferramentas de arquivo só acessam caminhos dentro do diretório raiz.</C>
      </p>
    </ApiInfo>
  )
}

export function SandboxInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Shell em sandbox (bubblewrap)" side="left">
      <p>
        Localmente, o shell (tools <C>shell</C> e <C>process_start</C>) roda via <C>bwrap</C>: o
        diretório raiz é montado com leitura e escrita, o resto do sistema de arquivos fica somente
        leitura, <C>/tmp</C> é privado e a rede continua liberada.
      </p>
      <p>
        Com o bloco de ambiente ativo, adiciona ao system prompt a linha:{' '}
        <C>O shell roda em sandbox: só o diretório raiz (e um /tmp privado) é gravável.</C>
      </p>
    </ApiInfo>
  )
}

export function ContextWindowInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Janela de contexto e limite" side="left">
      <p>
        <strong className="text-fg">Não é enviado à API.</strong> Usado só pelo medidor de contexto
        (tokens da última resposta: <C>prompt_tokens + completion_tokens</C>) e para decidir quando
        sugerir — ou fazer, se automático — a compactação. Sem override, vem do{' '}
        <C>context_length</C> que o provedor informa em <C>/models</C>.
      </p>
      <p className="text-subtle">
        Subagentes usam a janela do próprio modelo e compactam sempre ao atingir o limite.
      </p>
    </ApiInfo>
  )
}

export function CompactPromptInfo({ prompt }: { prompt: string }): React.JSX.Element {
  return (
    <ApiInfo
      title="Prompt de compactação"
      side="left"
      code={compactionMessageText('…resumo gerado pelo modelo…')}
      codeLabel="O histórico anterior é substituído por esta mensagem role: user:"
    >
      <p>
        Usado só na request de compactação: a request normal da sessão (mesmas tools, system,
        parâmetros e histórico ativo — o prefixo vem do cache) com este texto como última mensagem{' '}
        <C>{'{ role: "user", content: "<prompt>" }'}</C>.
      </p>
      <p>
        Essa request e a resposta <strong className="text-fg">não entram no histórico</strong>. O
        resumo é salvo numa mensagem de fronteira; dali em diante cada request envia só{' '}
        <C>system</C> → fronteira → mensagens novas.
      </p>
      <p className="text-subtle">{prompt.length.toLocaleString('pt-BR')} caracteres.</p>
    </ApiInfo>
  )
}

export function MaxOutputInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Limite de saída das ferramentas" side="left">
      <p>
        Teto de caracteres do <C>content</C> de cada resultado enviado ao modelo como{' '}
        <C>{'role: "tool"'}</C> (≈ 4 caracteres por token). Saídas maiores são cortadas com um
        marcador explicando o corte e como ler o resto.
      </p>
      <p>
        <strong className="text-fg">Salvar em arquivo</strong> (global, padrão{' '}
        {LIMITS.spillThresholdChars.toLocaleString('pt-BR')}): resultado maior que isso vai inteiro
        para <C>userData/tool-outputs/&lt;chat&gt;/&lt;tool_call_id&gt;.txt</C> e o modelo recebe só
        o início (no <C>shell</C> e nos logs, início e fim — ~
        {LIMITS.spillExcerptChars.toLocaleString('pt-BR')} caracteres), o tamanho, o caminho e como
        ler o resto com <C>read_file</C> (offset/limit) ou <C>search_files</C> — que alcançam esses
        arquivos mesmo com a confinação ligada. Ficam só neste dispositivo, são apagados com o chat
        e após {LIMITS.spillMaxAgeDays} dias. Erros, <C>read_file</C> e <C>skill_read</C> nunca vão
        para arquivo.
      </p>
      <p>
        Fixos: <C>read_file</C> sem offset/limit devolve o arquivo inteiro se for pequeno, senão só
        o início (até o limite acima) e corta linhas acima de{' '}
        {LIMITS.readMaxLineChars.toLocaleString('pt-BR')} caracteres; <C>list_dir</C> até{' '}
        {LIMITS.listMaxEntries} entradas; <C>search_files</C> até {LIMITS.searchMaxResults}{' '}
        resultados; <C>list_models</C> até {LIMITS.modelsMaxResults} modelos.
      </p>
      <p className="text-subtle">Não é um campo da request.</p>
    </ApiInfo>
  )
}

export function CompactionMessageInfo({
  msg,
  side = 'top'
}: {
  msg: StoredMessage
  side?: Side
}): React.JSX.Element {
  return (
    <ApiInfo
      title="Resumo da conversa (fronteira de compactação)"
      code={JSON.stringify(msg.message, null, 2)}
      codeLabel="Objeto exato no array messages:"
      side={side}
    >
      <p>
        Enviado como mensagem <C>{'role: "user"'}</C> no início do histórico — logo depois do
        system. As mensagens anteriores a ela continuam salvas e visíveis, mas{' '}
        <strong className="text-fg">não são mais enviadas à API</strong>.
      </p>
      <p className="text-subtle">
        Criada pelo app: conteúdo = <C>{'<conversation_summary>…</conversation_summary>'}</C> + a
        nota “{COMPACTION_NOTE}” Se a ferramenta <C>read_history</C> estava habilitada ao compactar,
        a nota diz que o histórico original (mensagens #X–#Y) continua salvo e pode ser consultado
        com <C>read_history</C> (busca ou faixa). Apague-a para voltar a enviar o histórico
        completo.
      </p>
    </ApiInfo>
  )
}

export function CacheInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Token caching" side="left">
      <p>
        Adiciona <C>{'cache_control: { type: "ephemeral" }'}</C> em até três pontos da request (máx.
        4 no Anthropic):
      </p>
      <p>
        1. No system prompt, cujo <C>content</C> vira{' '}
        <C>{'[{ type: "text", text, cache_control }]'}</C>.
        <br />
        2. Na <strong className="text-fg">última</strong> mensagem do array, de qualquer role
        (inclusive <C>{'role: "tool"'}</C>) — assim cada passo de um loop de tools lê do cache tudo
        o que o passo anterior enviou.
        <br />
        3. Na última mensagem <C>{'role: "user"'}</C>, se não for a mesma.
      </p>
      <p>
        O <C>content</C> string vira <C>{'[{ type: "text", text, cache_control }]'}</C> só na cópia
        enviada; o histórico salvo não muda.
      </p>
      <p className="text-subtle">
        O histórico é reenviado byte a byte como foi salvo, para maximizar acertos de cache.
      </p>
    </ApiInfo>
  )
}

export function AutoApproveInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Aprovações" side="left">
      <p>
        <strong className="text-fg">Não é enviado à API.</strong> Só controla se o app pede sua
        confirmação antes de executar a tool localmente. Modos: <strong>Sempre permitir</strong>,{' '}
        <strong>Smart-Approve</strong> (o modelo juiz da seção abaixo decide; sem modelo → pergunta)
        e <strong>Listas</strong> (Comandos, Processos, Páginas: whitelist libera, blacklist
        bloqueia, o resto pergunta) ou <strong>Perguntar</strong> (demais itens).
      </p>
      <p>
        ★ marca o padrão global (Configurações → Aprovações). Escolher a opção com estrela segue o
        padrão global (sem ajuste neste chat; acompanha se ele mudar); escolher outra fixa o modo
        neste chat.
      </p>
      <p>
        Resultados enviados ao modelo como <C>{'role: "tool"'}</C>: negado →{' '}
        <C>O usuário negou: &lt;sub-comando&gt;</C> (pergunta simples:{' '}
        <C>O usuário negou a execução desta ferramenta.</C>); blacklist →{' '}
        <C>{'Bloqueado pela blacklist (comandos): "<entrada>" casou com "<sub-comando>"'}</C>. Num
        comando interno (ssh, sudo, docker exec…) o contexto vem junto:{' '}
        <C>{'… — no servidor deploy@host (via ssh)'}</C> /{' '}
        <C>{'… casou com "rm -rf x" (no servidor deploy@host (via ssh))'}</C>.
      </p>
    </ApiInfo>
  )
}

export function ComposerInfo({ running }: { running: boolean }): React.JSX.Element {
  return (
    <ApiInfo title="Sua mensagem" side="top">
      <p>
        Enviada como uma nova mensagem <C>{'{ role: "user", content: "<texto>" }'}</C> (string) no
        fim do array <C>messages</C>, depois de todo o histórico.
      </p>
      <p>
        Com anexos, <C>content</C> vira um array: um part por anexo (imagem → <C>image_url</C>, PDF
        → <C>file</C>, áudio → <C>input_audio</C>, texto → <C>text</C> com{' '}
        <C>{'<file name="…">'}</C>) e, por último, <C>{'{ type: "text", text }'}</C> com o que você
        digitou.
      </p>
      {running && (
        <p>
          O agente está trabalhando: a mensagem entra na <strong className="text-fg">fila</strong> e
          é anexada como <C>{'role: "user"'}</C> no próximo limite de passo (após os resultados das
          tools, antes da próxima chamada).
        </p>
      )}
    </ApiInfo>
  )
}

export function QueueInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Mensagens na fila">
      <p>
        Cada item vira uma mensagem <C>{'role: "user"'}</C> anexada no próximo limite de passo do
        agente, na ordem da fila.
      </p>
      <p>
        ⚡ envia agora: interrompe a geração/tools em andamento, salva a resposta parcial, fecha
        cada tool call pendente com uma mensagem <C>{'role: "tool"'}</C> com o texto{' '}
        <C>[Interrompido pelo usuário antes de concluir]</C> e então anexa sua mensagem.
      </p>
    </ApiInfo>
  )
}

/** (i) de uma mensagem do histórico: mostra o objeto exato reenviado em toda request. */
export function MessageInfo({
  msg,
  side = 'top'
}: {
  msg: StoredMessage
  side?: Side
}): React.JSX.Element {
  const m = msg.message
  if (msg.meta.kind === 'compaction') return <CompactionMessageInfo msg={msg} side={side} />
  const extraction = extractionOf(msg.meta)
  if (extraction) return <ExtractionMessageInfo extraction={extraction} side={side} />
  if (msg.meta.kind === 'error') {
    return (
      <ApiInfo title="Erro (só exibição)" side={side}>
        <p>
          <strong className="text-fg">Não é enviado à API.</strong> O app salvou este erro no
          histórico apenas para exibição (sobrevive ao reinício); ele é excluído do array{' '}
          <C>messages</C> de todas as requests.
        </p>
      </ApiInfo>
    )
  }
  const origin = originInfo(msg)
  if (origin) {
    return (
      <ApiInfo
        title={origin.title}
        code={JSON.stringify(m, null, 2)}
        codeLabel="Objeto exato no array messages:"
        side={side}
      >
        {origin.body}
      </ApiInfo>
    )
  }
  const desc: Record<ApiMessage['role'], React.ReactNode> = {
    user: (
      <>
        Mensagem <C>{'role: "user"'}</C> do histórico, reenviada em toda request exatamente como
        salva.
      </>
    ),
    assistant: (
      <>
        Mensagem <C>{'role: "assistant"'}</C> reenviada em toda request como salva: <C>content</C>
        {m.role === 'assistant' && m.tool_calls?.length ? (
          <>
            {' '}
            + <C>tool_calls</C>
          </>
        ) : null}
        {m.role === 'assistant' && m.reasoning ? (
          <>
            {' '}
            + <C>reasoning</C>
          </>
        ) : null}
        .
      </>
    ),
    tool: (
      <>
        Resultado enviado ao modelo como <C>{'role: "tool"'}</C>, pareado pelo <C>tool_call_id</C>.
      </>
    ),
    system: (
      <>
        Mensagem <C>{'role: "system"'}</C> do histórico.
      </>
    )
  }
  return (
    <ApiInfo
      title={msg.meta.synthetic ? 'Mensagem sintética (criada pelo app)' : undefined}
      code={JSON.stringify(m, null, 2)}
      codeLabel="Objeto exato no array messages:"
      side={side}
    >
      <p>{desc[m.role]}</p>
      {messageAttachments(m).length > 0 && (
        <p>
          Anexos: no banco ficam só referências <C>clearchat-attachment://…</C> (e o campo privado{' '}
          <C>_attachment</C>); em cada request elas viram o conteúdo em base64 e <C>_attachment</C>{' '}
          é removido. Veja o resultado em &quot;Ver request&quot;.
        </p>
      )}
      {msg.meta.synthetic && (
        <p>
          Não foi escrita por você nem pelo modelo: o app a inseriu para manter a conversa
          consistente.
        </p>
      )}
    </ApiInfo>
  )
}

/** (i) de mensagens que não foram digitadas aqui: outro chat, agente pai, irmão, resultado de subagente. */
function originInfo(msg: StoredMessage): { title: string; body: React.ReactNode } | null {
  const k = msg.meta.kind
  if (k === 'inter-chat')
    return {
      title: 'Mensagem de outro chat',
      body: (
        <>
          <p>
            Entregue pelo chat de origem com a ferramenta <C>send_to_chat</C>, como se o usuário a
            digitasse aqui: vai no histórico como <C>{'role: "user"'}</C>, reenviada em toda
            request.
          </p>
          <p className="text-subtle">
            A primeira linha (<C>{'[Mensagem do chat "…" (id …)]'}</C>) é um cabeçalho do app para o
            modelo saber de onde veio. Saltos na cadeia entre chats: {msg.meta.interChatHops ?? 1}{' '}
            (máx. {LIMITS.interChatMaxHops}).
          </p>
        </>
      )
    }
  if (k === 'parent-message')
    return {
      title: 'Mensagem do agente pai',
      body: (
        <p>
          Enviada pelo agente pai com <C>message_subagent</C>. Vai no histórico do subagente como{' '}
          <C>{'role: "user"'}</C>, com o cabeçalho <C>[Mensagem do agente pai]</C> na primeira
          linha.
        </p>
      )
    }
  if (k === 'sibling-message' || k === 'sibling-broadcast')
    return {
      title:
        k === 'sibling-broadcast'
          ? 'Broadcast de um subagente irmão'
          : 'Mensagem de um subagente irmão',
      body: (
        <>
          <p>
            Enviada por outro subagente do mesmo agente pai com <C>message_subagent</C>
            {k === 'sibling-broadcast' ? (
              <>
                {' '}
                (<C>broadcast=true</C>: a mesma mensagem foi a todos os irmãos ativos; só o
                destinatário responde)
              </>
            ) : null}
            . Vai no histórico deste subagente como <C>{'role: "user"'}</C>, com um cabeçalho do app
            na primeira linha dizendo de quem veio.
          </p>
          <p className="text-subtle">
            Entre irmãos: no máximo {LIMITS.siblingMaxPerWindow} mensagens por minuto por par (
            {LIMITS.siblingBroadcastMaxPerWindow} broadcasts por remetente), sem esperar resposta. O
            agente pai não vê estas mensagens no histórico dele, mas pode listá-las com{' '}
            <C>check_subagents</C> (<C>messages=true</C>).
          </p>
        </>
      )
    }
  if (k === 'subagent-callback')
    return {
      title: msg.meta.callbackUpdate
        ? 'Atualização de subagente (criada pelo app)'
        : 'Resultado de subagente (criada pelo app)',
      body: (
        <>
          <p>
            Quando um subagente em segundo plano (ou retomado por uma mensagem nova) termina, o app
            insere o resultado aqui como mensagem <C>{'role: "user"'}</C> sintética: na fila, se o
            agente estava rodando (entra no próximo passo), ou iniciando um turno novo, se estava
            ocioso.
          </p>
          <p className="text-subtle">
            Primeira linha = cabeçalho do app; o resto = resposta final do subagente (ou a falha).
          </p>
        </>
      )
    }
  return null
}

export function TaskInfo({ task, side }: { task: string | null; side?: Side }): React.JSX.Element {
  return (
    <ApiInfo title="Tarefa do subagente" code={task ?? ''} codeLabel="Argumento task:" side={side}>
      <p>
        O subagente não vê esta conversa. A request dele começa do zero com:{' '}
        <C>{'role: "system"'}</C> = system prompt de subagentes (+ ambiente/tools, se ativos) e,
        como primeira mensagem <C>{'role: "user"'}</C>, exatamente o argumento <C>task</C> da
        chamada <C>delegate_task</C>. O texto final dele volta para esta sessão como o resultado{' '}
        <C>{'role: "tool"'}</C>.
      </p>
    </ApiInfo>
  )
}

const LIMITS_TEXT_CHARS = ATTACHMENT_LIMITS.maxTextChars
const b64Size = (n: number): number => Math.ceil(n / 3) * 4

/** (i) de um anexo: como exatamente ele vai na request. */
export function AttachmentApiInfo({
  meta,
  openRouterParsed,
  side = 'top',
  className
}: {
  meta: AttachmentMeta
  className?: string
  /** PDF num modelo sem suporte nativo via OpenRouter (o OpenRouter extrai o texto). */
  openRouterParsed?: boolean
  side?: Side
}): React.JSX.Element {
  const name = JSON.stringify(meta.name)
  const shape =
    meta.kind === 'image'
      ? `{ "type": "image_url", "image_url": { "url": "data:${meta.mime};base64,…" } }`
      : meta.kind === 'pdf'
        ? `{ "type": "file", "file": { "filename": ${name}, "file_data": "data:application/pdf;base64,…" } }`
        : meta.kind === 'audio'
          ? `{ "type": "input_audio", "input_audio": { "data": "<base64>", "format": "${audioFormat(meta.mime)}" } }`
          : `{ "type": "text", "text": "<file name=${name}>\n…conteúdo…\n</file>" }`
  return (
    <ApiInfo
      title={meta.name}
      side={side}
      className={className}
      code={shape}
      codeLabel="Part enviado no content da mensagem role: user:"
    >
      {meta.kind === 'text' ? (
        <p>
          Arquivo de texto ({formatSize(meta.size)}): o conteúdo vai como um part <C>text</C>,
          dentro de <C>{'<file name="…">'}</C> — funciona com qualquer modelo.
          {meta.truncated && (
            <>
              {' '}
              <strong className="text-warning">Cortado</strong> no limite de{' '}
              {LIMITS_TEXT_CHARS.toLocaleString('pt-BR')} caracteres.
            </>
          )}{' '}
          Enviado em toda request enquanto estiver no histórico — conta tokens e é cacheável.
        </p>
      ) : (
        <p>
          {formatSize(meta.size)} → ~{formatSize(b64Size(meta.size))} em base64.{' '}
          <strong className="text-fg">
            Enviado em base64 em toda request enquanto estiver no histórico
          </strong>{' '}
          — conta tokens e é cacheável (os bytes são sempre os mesmos).
        </p>
      )}
      {meta.kind === 'pdf' && (
        <p>
          {openRouterParsed
            ? 'Este modelo não lê PDF nativamente: o OpenRouter extrai o texto do PDF (plugin file-parser) antes de repassar.'
            : 'No OpenRouter, modelos sem suporte nativo a PDF recebem o texto extraído pelo plugin file-parser.'}
        </p>
      )}
      <p>
        {meta.kind === 'text' ? (
          <>O texto fica salvo no histórico já no formato enviado (sem base64).</>
        ) : (
          <>
            No banco fica só uma referência (<C>clearchat-attachment://{meta.file.slice(0, 10)}…</C>
            ); o arquivo fica em <C>userData/attachments</C> e vira base64 na hora de montar cada
            request.
          </>
        )}{' '}
        Os anexos vêm antes do texto no array <C>content</C>.
      </p>
    </ApiInfo>
  )
}

// ---------------- Memória (SPEC → Memória) ----------------

function Block({ label, text }: { label: string; text: string | null }): React.JSX.Element {
  return (
    <div className="mt-2">
      <div className="mb-1 text-[11px] text-subtle">{label}</div>
      <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/90">
        {text ? text : <span className="text-subtle italic">(nada)</span>}
      </pre>
    </div>
  )
}

/**
 * (i) geral da memória: o índice + as instruções + as tools que vão na próxima request (via
 * `memory.preview`, exatos). Inativa → "Nada de memória vai para a API".
 */
export function MemoryPreviewInfo({
  preview,
  willSend,
  persona,
  helpText,
  side = 'left'
}: {
  /** null = ainda carregando / sem sessão. */
  preview: MemoryPreview | null
  /** Regra de envio calculada na UI (ligada + alguma coleção ativa numa categoria ligada). */
  willSend: boolean
  /** Editor de personas: sem sessão, sem índice real. */
  persona?: boolean
  helpText?: string | null
  side?: Side
}): React.JSX.Element {
  const active = preview ? preview.active : willSend
  return (
    <ApiInfo title="Memória" side={side} wide>
      {!active ? (
        <p data-testid="memory-nothing-sent">
          <strong className="text-fg">Nada de memória vai para a API</strong> — nenhum índice no
          system prompt, nenhuma instrução e nenhuma tool <C>memory_*</C>. Para enviar: ligue a
          memória e ative ao menos uma coleção numa categoria ligada.
        </p>
      ) : (
        <>
          <p>
            <strong className="text-fg">Índice</strong>: anexado ao conteúdo da mensagem{' '}
            <C>{'role: "system"'}</C>, precedido de <C>\n\n</C>, depois do system prompt e do bloco
            de ambiente. Por categoria → coleção ativa (nome, descrição, <i>escrita</i> ou{' '}
            <i>leitura</i>) → uma linha por memória (<C>id · categoria · título — resumo</C>);
            memórias “Sempre carregar” vão com os tópicos completos; substituídas ficam ocultas.
          </p>
          <p>
            <strong className="text-fg">Congelado por sessão</strong> (token caching): tirado na 1ª
            request e renovado só em chat novo, compactação ou “Atualizar memória”. O que o modelo
            grava durante a sessão chega pelos resultados das tools.
          </p>
          <p>
            <strong className="text-fg">Tools</strong>: as definições de <C>memory_*</C> entram no
            array <C>tools</C> (ou no texto das tools, se as nativas estiverem desligadas).
          </p>
          {persona || !preview ? (
            <>
              <p className="text-subtle">
                {persona
                  ? 'Persona: o índice exato depende das memórias no momento — abra o (i) da aba Memória de um chat para ver o texto enviado.'
                  : 'Carregando o texto exato…'}
              </p>
              {helpText != null && <Block label="Instruções (help prompt):" text={helpText} />}
            </>
          ) : (
            <>
              <Block label="Índice exato:" text={preview.index} />
              <Block label="Instruções (help prompt):" text={preview.help} />
              <Block label="Tools:" text={preview.tools.join(', ')} />
            </>
          )}
        </>
      )}
    </ApiInfo>
  )
}

export function MemoryCollectionsInfo({ side = 'left' }: { side?: Side }): React.JSX.Element {
  return (
    <ApiInfo title="Coleções ativas" side={side}>
      <p>
        Cada coleção marcada entra no <strong className="text-fg">índice</strong> do system prompt
        (nome, descrição e as memórias dela) e fica pesquisável por <C>memory_search</C> /{' '}
        <C>memory_read</C>. Categoria desligada = as coleções dela são ignoradas (a seleção fica
        guardada).
      </p>
      <p>
        <strong className="text-fg">Escrita</strong>: no máximo uma coleção por categoria — é onde{' '}
        <C>memory_write</C> cria/atualiza e para onde <C>memory_rewrite</C> copia versões novas de
        memórias que estão em coleções só de leitura. “Nenhuma” = o modelo não grava naquela
        categoria; sem coleção de escrita em nenhuma categoria, as tools de escrita nem são
        enviadas. No índice, a coleção aparece marcada <i>escrita</i> ou <i>leitura</i>.
      </p>
    </ApiInfo>
  )
}

export function MemoryHelpInfo({ text }: { text: string }): React.JSX.Element {
  return (
    <ApiInfo title="Instruções de memória" code={text} codeLabel="Texto anexado:" side="left">
      <p>
        Ligado: anexado ao conteúdo da mensagem <C>{'role: "system"'}</C>, depois do índice da
        memória, precedido de <C>\n\n</C>. Só na sessão principal (subagentes nunca recebem).
      </p>
    </ApiInfo>
  )
}

export function ExtractionPromptInfo({
  prompt,
  model
}: {
  prompt: string
  /** Rótulo do modelo da extração ("Modelo do chat" se não definido). */
  model?: string
}): React.JSX.Element {
  return (
    <ApiInfo title="Extração de memórias" code={prompt} codeLabel="Prompt de extração:" side="left">
      <p>
        Request <strong className="text-fg">separada</strong>, fora do histórico (nada dela é salvo
        na conversa){model ? <> — modelo: {model}</> : null}. Mensagens: este prompt como{' '}
        <C>{'role: "system"'}</C>, depois a conversa (ou o resumo da compactação + as mensagens
        recentes) e o índice completo das coleções ativas. Tools: só <C>memory_write</C>,{' '}
        <C>memory_rewrite</C> e <C>memory_delete</C>, executadas com as mesmas regras (coleção de
        escrita, categorias ligadas), em até algumas rodadas.
      </p>
      <p className="text-subtle">
        Dispara após a compactação (se “automaticamente” estiver ligado) ou pelo botão “Extrair
        memórias agora”. O resultado vira um card no chat, que não é enviado à API.
      </p>
    </ApiInfo>
  )
}

export function MemoryRefreshInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Atualizar memória" side="left">
      <p>
        O índice vai congelado na sessão (o prefixo do system prompt não muda, então o cache de
        tokens continua valendo). “Atualizar memória” tira um snapshot novo agora: a próxima request
        leva o índice atualizado — e paga uma escrita de cache do system prompt.
      </p>
    </ApiInfo>
  )
}

export function MemorySubagentsInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Memória nos subagentes" side="left">
      <p>
        Ligado (e com a memória ativa no chat): as requests dos subagentes recebem só as tools{' '}
        <C>memory_search</C> e <C>memory_read</C>. Subagentes{' '}
        <strong className="text-fg">nunca</strong> recebem o índice, as instruções nem as tools de
        escrita. Desligado: nenhuma tool de memória nos subagentes.
      </p>
    </ApiInfo>
  )
}

/** (i) do card de extração: não vai à API; mostra a request exata da extração. */
export function ExtractionMessageInfo({
  extraction,
  side = 'top'
}: {
  extraction: MemoryExtractionMeta
  side?: Side
}): React.JSX.Element {
  return (
    <ApiInfo
      title="Extração de memórias (só exibição)"
      side={side}
      code={extraction.request != null ? JSON.stringify(extraction.request, null, 2) : undefined}
      codeLabel="Body exato da request de extração:"
    >
      <p>
        <strong className="text-fg">Este card não é enviado à API.</strong> Fica no histórico só
        para exibição e é excluído do array <C>messages</C> de todas as requests.
      </p>
      <p>
        A extração foi uma request separada (
        {extraction.trigger === 'compaction'
          ? 'automática, após a compactação'
          : 'manual, “Extrair memórias agora”'}
        ): o prompt de extração + a conversa + o índice da memória; as mudanças foram gravadas pelas
        tools <C>memory_write</C>/<C>memory_rewrite</C>/<C>memory_delete</C>.
      </p>
      {extraction.request == null && (
        <p className="text-subtle">O body da request não foi registrado nesta extração.</p>
      )}
    </ApiInfo>
  )
}

// ---------------- Skills (SPEC → Skills) ----------------

/** (i) geral das skills do chat/persona: o que vai (prompt de apoio + 3 tools) ou nada. */
export function SkillsSendInfo({
  enabled,
  support,
  nativeTools,
  cfg
}: {
  enabled: boolean
  /** Texto exato do prompt de apoio que vai (null = não vai). */
  support: string | null
  nativeTools: boolean
  /** Compactação (1.11.0): as definições mostradas são as que vão. */
  cfg?: CompactCfg
}): React.JSX.Element {
  return (
    <ApiInfo
      title="Skills na request"
      side="left"
      code={
        enabled
          ? JSON.stringify(
              SKILL_TOOL_NAMES.map((n) => sentToolDefinition(currentToolDefinition(n), cfg)),
              null,
              2
            )
          : undefined
      }
      codeLabel="Definições exatas (itens do array tools):"
    >
      {enabled ? (
        <>
          <p>
            Ligadas:{' '}
            {support ? (
              <>
                o prompt de apoio é anexado ao conteúdo da mensagem <C>{'role: "system"'}</C>{' '}
                (precedido de <C>\n\n</C>, depois da memória) e{' '}
              </>
            ) : (
              <>sem prompt de apoio; </>
            )}
            as tools <C>list_skills</C>, <C>skill_load</C> e <C>skill_read</C> vão{' '}
            {nativeTools ? (
              <>
                no campo <C>tools</C>
              </>
            ) : (
              <>no texto das tools (tools nativas desligadas)</>
            )}
            .
          </p>
          <p>
            <strong className="text-fg">Nenhuma lista de skills vai no contexto</strong>: as
            definições são fixas (prefixo de cache estável) e o modelo descobre as skills chamando{' '}
            <C>list_skills</C>. O conteúdo de uma skill só entra quando ele chama <C>skill_load</C>/
            <C>skill_read</C> (resultados <C>role: tool</C>) ou quando você a carrega pela lâmpada
            do composer.
          </p>
        </>
      ) : (
        <p>
          Desligadas: <strong className="text-fg">nada</strong> de skills vai para a API — sem
          prompt de apoio, sem tools e sem a lâmpada no composer.
        </p>
      )}
    </ApiInfo>
  )
}

export function SkillsSupportInfo({ text }: { text: string }): React.JSX.Element {
  return (
    <ApiInfo title="Prompt de apoio das skills" code={text} codeLabel="Texto anexado:" side="left">
      <p>
        Ligado: anexado ao conteúdo da mensagem <C>{'role: "system"'}</C>, depois do bloco da
        memória (se houver), precedido de <C>\n\n</C>. Nos subagentes, só com &quot;Skills nos
        subagentes&quot; ligado. Não cita nenhuma skill — orienta o modelo a usar <C>list_skills</C>{' '}
        antes de tarefas especializadas.
      </p>
    </ApiInfo>
  )
}

export function SkillsSubagentsInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Skills nos subagentes" side="left">
      <p>
        Ligado (e com as skills ligadas no chat): as requests dos subagentes recebem as mesmas tools
        (<C>list_skills</C>, <C>skill_load</C>, <C>skill_read</C>) e o mesmo prompt de apoio,
        limitados às skills ativas deste chat. Desligado: nada de skills nos subagentes.
      </p>
    </ApiInfo>
  )
}

export function SkillsLocationsInfo(): React.JSX.Element {
  return (
    <ApiInfo title="Locais de skills" side="left">
      <p>
        Cada local é uma pasta cujas subpastas com <C>SKILL.md</C> são skills (formato Agent Skills
        / Claude Code: frontmatter YAML com <C>name</C> e <C>description</C>, depois as instruções
        em markdown; arquivos extras opcionais). A ordem é a precedência: com nomes repetidos vence
        o primeiro local; as skills de projeto (<C>{'<raiz do chat>/.claude/skills'}</C>) vêm por
        último.
      </p>
      <p>
        Nada daqui vai para a API sozinho: só quando um chat liga as skills (aba Tools) — e mesmo
        assim só as tools e o prompt de apoio; o modelo lista as skills com <C>list_skills</C>.
      </p>
    </ApiInfo>
  )
}

/** (i) do card "Skill carregada" (invocação manual): o texto exato enviado. */
export function SkillPartInfo({
  meta,
  text,
  side = 'left'
}: {
  meta: SkillPartMeta
  text: string
  side?: Side
}): React.JSX.Element {
  return (
    <ApiInfo
      title={`Skill ${meta.name}`}
      side={side}
      code={text}
      codeLabel="Part enviado no content da mensagem role: user (texto exato):"
    >
      <p>
        Carregada por você na lâmpada do composer: o SKILL.md foi lido no envio e vai como um part{' '}
        <C>text</C> (<C>{'<skill name="…" path="…">…</skill>'}</C>,{' '}
        {skillBlockBody(text).length.toLocaleString('pt-BR')} caracteres) antes do texto digitado,
        em toda request enquanto estiver no histórico — conta tokens e é cacheável. O campo privado{' '}
        <C>_skill</C> fica só no banco (removido na request).
        {meta.truncated && (
          <>
            {' '}
            <strong className="text-warning">Cortado</strong> no limite de{' '}
            {SKILL_LIMITS.manualMaxChars.toLocaleString('pt-BR')} caracteres.
          </>
        )}
      </p>
    </ApiInfo>
  )
}
