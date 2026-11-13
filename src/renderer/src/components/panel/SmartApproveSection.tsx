// Seção "Smart-Approve" da aba Tools (painel do chat e editor de personas): modelo juiz (sempre
// visível), itens que ele decide (os em modo Smart-Approve na seção Aprovações), "Avançado"
// recolhido (O juiz pode negar, Consultar também o que a whitelist libera, rótulos, contexto/tempo,
// prompt + template editáveis) e "Testar". Sem liga/desliga: o juiz age nos itens em modo Smart-Approve
// quando há modelo; sem modelo, esses itens perguntam a você.
import { AlertTriangle, FlaskConical, X } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_SMART_APPROVE_PROMPT, DEFAULT_SMART_APPROVE_TEMPLATE } from '@shared/defaults'
import { SIDE_THINKING } from '@shared/sideReasoning'
import {
  buildJudgeMessages,
  normalizeSmartApprove,
  SMART_APPROVE_DEFAULTS,
  SMART_APPROVE_PLACEHOLDERS,
  SMART_APPROVE_SAMPLE,
  validateLabels
} from '@shared/smartApprove'
import { TOOL_LABELS } from '@shared/tools'
import { APPROVAL_ITEMS, APPROVAL_TOOLS, effectiveMode, ITEM_LABEL } from '@shared/approvalPolicy'
import {
  type ApprovalItem,
  type SmartApproveConfig,
  type SmartApproveLabels,
  type SmartApproveRecord,
  type ToolName
} from '@shared/types'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { SmartApproveLine } from '../chat/SmartApprove'
import { AutoTextarea, Button } from '../ui/controls'
import { ModelPicker } from '../ui/ModelPicker'
import { Select } from '../ui/Select'
import { ApiInfo, C, Tip } from '../ui/Tooltip'
import { PlaceholderList } from '../ui/PlaceholderList'
import { smartAdvancedSummary, smartApproveSummary } from '../../lib/configSummary'
import type { CfgProps } from './editors'
import { CollapsibleSection, NumberInput, RestoreButton, ToggleRow } from './fields'
import { SmartContextSection } from './SmartContextFields'
import { SideThinkingField } from './SideThinkingField'
import { PromptCacheToggle } from './PromptCacheToggle'
import { useSideRequestPreview } from '../../lib/sideReasoning'

/** Resumo da subseção "Ambiente e contexto" (fechada). */
function environmentSummary(cfg: CfgProps['cfg']): { text: string; changed: boolean } {
  const sa = cfg.smartApprove
  const parts: string[] = []
  if (typeof sa?.environment === 'string')
    parts.push(sa.environment.trim() ? 'ambiente do chat' : 'sem ambiente')
  if (sa?.capture) parts.push(sa.capture.enabled ? 'coleta ligada' : 'coleta desligada')
  if (sa?.capturePrompts) parts.push('prompts do resumidor')
  if (cfg.capturedContext?.main?.text) parts.push('contexto capturado')
  return parts.length
    ? { text: parts.join(' · '), changed: true }
    : { text: 'padrão global', changed: false }
}

const LABEL_FIELDS: { key: keyof SmartApproveLabels; caption: string }[] = [
  { key: 'approve', caption: 'Aprovar' },
  { key: 'reject', caption: 'Rejeitar' },
  { key: 'ask', caption: 'Perguntar' }
]
const LABEL_TITLE: Partial<Record<keyof SmartApproveLabels, string>> = {
  reject: 'Só oferecido ao juiz com “O juiz pode negar”; sem ela, esta resposta vira “perguntar”.'
}

const TEST_TOOLS: ToolName[] = APPROVAL_TOOLS

function SmartRequestInfo({
  cfg,
  sa,
  tool,
  args
}: CfgProps & { sa: SmartApproveConfig; tool: ToolName; args: unknown }): React.JSX.Element {
  const provider = useStore((s) => s.providers.find((p) => p.id === sa.providerId))
  const bwrap = useStore((s) => s.capabilities.bwrap)
  const messages = buildJudgeMessages(sa, {
    tool,
    args,
    cwd: cfg.cwd || '~',
    confine: cfg.confineToRoot !== false,
    sandbox: !!cfg.sandboxBash && bwrap,
    history: SMART_APPROVE_SAMPLE.history
  })
  // body exato (mesma política de raciocínio e filtro de params do main)
  const { url, body, notes } = useSideRequestPreview({
    providerId: provider?.id,
    model: sa.model,
    messages,
    cache: sa.cache !== false,
    maxTokens: SMART_APPROVE_DEFAULTS.maxTokens,
    temperature: SMART_APPROVE_DEFAULTS.temperature,
    thinkingTokens: sa.thinkingTokens,
    defaultThinkingTokens: SIDE_THINKING.judge
  })
  return (
    <ApiInfo
      title="Chamada ao juiz (exemplo)"
      side="left"
      code={JSON.stringify({ url, body }, null, 2)}
      codeLabel={`POST — chamada de exemplo: ${tool}`}
      wide
    >
      <p>
        O juiz decide só as chamadas dos itens em modo <strong>Smart-Approve</strong> (seção
        Aprovações). Não há liga/desliga: sem modelo escolhido, esses itens pedem sua confirmação.
      </p>
      <p>
        Para cada chamada avaliada, o app faz uma request{' '}
        <strong className="text-fg">separada</strong> ao modelo escolhido (fora do histórico; o
        agente não a vê): <C>{'role: "system"'}</C> = o prompt, <C>{'role: "user"'}</C> = o template
        com os placeholders preenchidos, <C>temperature: 0</C> (omitido se o modelo não aceita),{' '}
        <C>max_tokens: {SMART_APPROVE_DEFAULTS.maxTokens}</C>. Raciocínio desligado onde o modelo
        permite; se for obrigatório, esforço mínimo e os “Tokens de pensamento” somados ao{' '}
        <C>max_tokens</C>. Com “Cache do prompt”, <C>cache_control</C> no fim do system e no{' '}
        <C>{'{{cache_break}}'}</C> do template (Anthropic e Anthropic/Gemini no OpenRouter).
        Headers: os do provedor do juiz + a assinatura do app deste chat.
      </p>
      {notes.length > 0 && (
        <ul data-testid="smart-request-notes" className="list-disc space-y-0.5 pl-4 text-[11px]">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p>
        O template recebe o contexto montado pelo app (limitado a ~6.000 caracteres): as últimas
        mensagens que você digitou na conversa principal, a tarefa do subagente, as últimas chamadas
        de tool, os arquivos que o agente criou/editou e o que já foi aprovado antes. Nos itens com
        listas, o juiz vê os sub-comandos já liberados pela whitelist só como contexto e decide os
        marcados <C>TO DECIDE</C>.
      </p>
      <p>
        Com “O juiz pode negar”: negada → o agente recebe <C>{'role: "tool"'}</C>{' '}
        <C>Rejeitado pelo Smart-Approve (modelo): motivo</C>. Sem ela, “negar” vira pergunta. Erro,
        tempo esgotado ou resposta sem exatamente um rótulo → você decide.
      </p>
    </ApiInfo>
  )
}

const joinItems = (items: ApprovalItem[]): string => items.map((i) => ITEM_LABEL[i]).join(', ')

export function SmartApproveSection({
  cfg,
  patch,
  chatId
}: CfgProps & {
  /** Painel do chat: mostra o "Contexto capturado da conversa" (editável). */
  chatId?: string
}): React.JSX.Element {
  const sa = normalizeSmartApprove(cfg.smartApprove)
  const set = (p: Partial<SmartApproveConfig>): void => patch({ smartApprove: { ...sa, ...p } })
  const hasModel = !!sa.providerId && !!sa.model

  // rótulos: rascunho local, só grava quando válido
  const [labels, setLabels] = useState<SmartApproveLabels>(sa.labels)
  const [prevLabels, setPrevLabels] = useState(sa.labels)
  if (JSON.stringify(prevLabels) !== JSON.stringify(sa.labels)) {
    setPrevLabels(sa.labels)
    setLabels(sa.labels)
  }
  const labelError = validateLabels(labels)

  const [testTool, setTestTool] = useState<ToolName>(SMART_APPROVE_SAMPLE.tool)
  const [testArgs, setTestArgs] = useState(JSON.stringify(SMART_APPROVE_SAMPLE.args, null, 2))
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<SmartApproveRecord | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  let parsedArgs: unknown = SMART_APPROVE_SAMPLE.args
  let argsError: string | null = null
  try {
    parsedArgs = JSON.parse(testArgs)
  } catch (e) {
    argsError = (e as Error).message
  }

  const global = useStore((s) => s.approvalSettings.modes)
  const smartItems = APPROVAL_ITEMS.filter((i) => effectiveMode(cfg, global, i) === 'smart')

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTestError(null)
    setTestResult(null)
    try {
      setTestResult(
        await api.agent.smartApproveTest({
          config: {
            smartApprove: sa,
            cwd: cfg.cwd,
            confineToRoot: cfg.confineToRoot,
            sandboxBash: cfg.sandboxBash,
            appSignature: cfg.appSignature,
            appSignatureCustom: cfg.appSignatureCustom
          },
          tool: testTool,
          args: parsedArgs,
          history: SMART_APPROVE_SAMPLE.history,
          ...(cfg.capturedContext?.main?.text ? { captured: cfg.capturedContext.main.text } : {})
        })
      )
    } catch (e) {
      setTestError(
        (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      )
    } finally {
      setTesting(false)
    }
  }

  const customPrompt = sa.prompt != null || sa.template != null

  return (
    <CollapsibleSection
      id="smart-approve"
      section="smart-approve"
      title="Smart-Approve"
      summary={smartApproveSummary(cfg)}
      inherit={['smartApprove']}
      warning={
        !hasModel && smartItems.length
          ? `Sem modelo: ${joinItems(smartItems)} ${smartItems.length > 1 ? 'pedem' : 'pede'} sua confirmação`
          : null
      }
      // rascunho de rótulos inválido (não salvo): mantém aberta e marca o cabeçalho
      error={labelError ? 'rótulos inválidos' : null}
      aside={<SmartRequestInfo cfg={cfg} patch={patch} sa={sa} tool={testTool} args={parsedArgs} />}
      help={
        <>
          <p>
            Um modelo avalia as chamadas dos itens em modo “Smart-Approve” (seção Aprovações acima)
            e aprova ou pergunta a você, sabendo o que você pediu e o que o agente está fazendo.
          </p>
          <p>
            Em Comandos/Processos/Páginas ele só complementa as listas: o que a whitelist libera
            roda sem ele; a blacklist bloqueia. Erro, demora ou resposta ambígua → pergunta a você.
          </p>
        </>
      }
    >
      <div data-testid="smart-approve-model" className="flex items-center gap-1.5">
        <ModelPicker
          className="min-w-0 flex-1"
          value={hasModel ? { providerId: sa.providerId!, model: sa.model! } : null}
          placeholder="Nenhum"
          onChange={(ref) => set({ providerId: ref.providerId, model: ref.model })}
        />
        {hasModel && (
          <Tip label="Remover modelo (itens em Smart-Approve passam a perguntar)">
            <button
              type="button"
              aria-label="Remover modelo do Smart-Approve"
              onClick={() => set({ providerId: null, model: null })}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>

      <div
        data-testid="smart-approve-hint"
        className={cn(
          'flex items-start gap-1.5 text-[11.5px] leading-snug',
          !hasModel && smartItems.length ? 'text-warning/90' : 'text-subtle'
        )}
      >
        {!hasModel && smartItems.length > 0 && (
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
        )}
        <span data-testid="smart-items">
          {!hasModel
            ? smartItems.length
              ? `Escolha um modelo: sem ele, ${joinItems(smartItems)} ${smartItems.length > 1 ? 'pedem' : 'pede'} sua confirmação.`
              : 'Escolha um modelo para poder usar o modo Smart-Approve nos itens acima.'
            : smartItems.length
              ? `Decide: ${joinItems(smartItems)}.`
              : 'Nenhum item está no modo Smart-Approve (seção Aprovações acima).'}
        </span>
      </div>

      <SideThinkingField
        providerId={sa.providerId}
        model={sa.model}
        value={sa.thinkingTokens}
        onChange={(thinkingTokens) => set({ thinkingTokens })}
        defaultTokens={SIDE_THINKING.judge}
        call="do juiz"
        testId="smart-thinking"
      />

      <div data-testid="smart-cache" className={cn(!hasModel && 'opacity-60')}>
        <PromptCacheToggle
          providerId={sa.providerId}
          model={sa.model}
          checked={sa.cache !== false}
          onChange={(on) => set({ cache: on ? undefined : false })}
          what="judge"
        />
      </div>

      <div className={cn('space-y-3 transition-opacity', !hasModel && 'opacity-60')}>
        <CollapsibleSection
          id="smart-environment"
          level="sub"
          title="Ambiente e contexto"
          summary={environmentSummary(cfg)}
        >
          <SmartContextSection
            cfg={cfg}
            chatId={chatId}
            set={(p) => {
              const next: Record<string, unknown> = { ...sa }
              for (const [k, v] of Object.entries(p)) {
                if (v === null) delete next[k]
                else next[k] = v
              }
              patch({ smartApprove: next as unknown as SmartApproveConfig })
            }}
          />
        </CollapsibleSection>
        <CollapsibleSection
          id="smart-advanced"
          level="sub"
          title="Avançado"
          summary={smartAdvancedSummary(cfg)}
          error={labelError ? 'rótulos inválidos' : null}
        >
          <div className="space-y-3">
            <ToggleRow
              label="O juiz pode negar"
              help={
                'Desligado (padrão): o juiz só aprova ou pergunta a você — uma resposta “negar” vira pergunta, com o motivo como dica no card.\nLigado: a chamada negada não roda e o agente recebe o motivo.'
              }
              checked={sa.canDeny}
              onChange={(canDeny) => set({ canDeny })}
            />
            <ToggleRow
              label="Consultar o Smart-Approve também para o que a whitelist já libera"
              help={
                'Desligado (padrão): Comandos/Processos/Páginas cobertos inteiros pela whitelist rodam sem o juiz, e ele decide só o que as listas não decidem.\nLigado: o juiz também avalia o que a whitelist libera.'
              }
              checked={sa.judgeWhitelisted}
              onChange={(judgeWhitelisted) => set({ judgeWhitelisted })}
            />
            <div>
              <div className="mb-1 text-[11px] text-subtle">Rótulos (1ª linha da resposta)</div>
              <div className="grid grid-cols-3 gap-1.5">
                {LABEL_FIELDS.map(({ key, caption }) => (
                  <label key={key} className="min-w-0">
                    <span
                      className="mb-0.5 block text-[10.5px] text-faint"
                      title={LABEL_TITLE[key]}
                    >
                      {caption}
                      {key === 'reject' && !sa.canDeny ? ' (→ perguntar)' : ''}
                    </span>
                    <input
                      value={labels[key]}
                      aria-label={`Rótulo ${caption}`}
                      onChange={(e) => {
                        const next = { ...labels, [key]: e.target.value }
                        setLabels(next)
                        if (!validateLabels(next))
                          set({
                            labels: {
                              approve: next.approve.trim(),
                              reject: next.reject.trim(),
                              ask: next.ask.trim()
                            }
                          })
                      }}
                      className={cn(
                        'field h-7 w-full px-2 py-0 font-mono text-[11.5px]',
                        labelError && !labels[key].trim() && 'border-danger/60'
                      )}
                    />
                  </label>
                ))}
              </div>
              {labelError && (
                <p data-testid="smart-label-error" className="mt-1 text-[11px] text-danger/90">
                  {labelError} (não salvo)
                </p>
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <span className="min-w-0 flex-1 text-[12.5px] text-fg/90">
                Mensagens recentes no contexto
              </span>
              <NumberInput
                value={sa.contextMessages}
                disabled={false}
                step={1}
                min={0}
                max={SMART_APPROVE_DEFAULTS.maxContextMessages}
                int
                label="Mensagens recentes no contexto do juiz"
                onCommit={(v) =>
                  v >= 0 &&
                  v <= SMART_APPROVE_DEFAULTS.maxContextMessages &&
                  set({ contextMessages: v })
                }
              />
            </div>
            <div className="flex items-center gap-2.5">
              <span className="min-w-0 flex-1 text-[12.5px] text-fg/90">Tempo máximo</span>
              <NumberInput
                value={sa.timeoutS}
                disabled={false}
                step={5}
                min={SMART_APPROVE_DEFAULTS.minTimeoutS}
                max={SMART_APPROVE_DEFAULTS.maxTimeoutS}
                int
                label="Tempo máximo do juiz (segundos)"
                onCommit={(v) =>
                  v >= SMART_APPROVE_DEFAULTS.minTimeoutS &&
                  v <= SMART_APPROVE_DEFAULTS.maxTimeoutS &&
                  set({ timeoutS: v })
                }
              />
              <span className="text-[12px] text-subtle">s</span>
            </div>

            <CollapsibleSection
              id="smart-prompt"
              level="sub"
              title="Prompt do juiz"
              summary={
                customPrompt
                  ? { text: 'personalizado', changed: true }
                  : { text: 'padrão', changed: false }
              }
              aside={
                customPrompt ? (
                  <RestoreButton onClick={() => set({ prompt: null, template: null })} />
                ) : null
              }
            >
              <div className="animate-fade-in space-y-2">
                <div>
                  <div className="mb-0.5 text-[10.5px] text-faint">
                    System (<C>{'role: "system"'}</C>)
                  </div>
                  <AutoTextarea
                    value={sa.prompt ?? DEFAULT_SMART_APPROVE_PROMPT}
                    aria-label="Prompt do Smart-Approve"
                    onChange={(e) => set({ prompt: e.target.value })}
                    minRows={5}
                    maxRows={16}
                    className="field font-mono text-[11px] leading-relaxed"
                  />
                </div>
                <div>
                  <div className="mb-0.5 text-[10.5px] text-faint">
                    Template da mensagem (<C>{'role: "user"'}</C>)
                  </div>
                  <AutoTextarea
                    value={sa.template ?? DEFAULT_SMART_APPROVE_TEMPLATE}
                    aria-label="Template do Smart-Approve"
                    onChange={(e) => set({ template: e.target.value })}
                    minRows={5}
                    maxRows={16}
                    className="field font-mono text-[11px] leading-relaxed"
                  />
                </div>
                <PlaceholderList
                  groups={[
                    { title: 'Placeholders (system e template)', items: SMART_APPROVE_PLACEHOLDERS }
                  ]}
                />
              </div>
            </CollapsibleSection>
          </div>
        </CollapsibleSection>

        <CollapsibleSection id="smart-test" level="sub" title="Testar com uma chamada de exemplo">
          <div className="space-y-2">
            <Select
              value={testTool}
              onChange={(v) => setTestTool(v)}
              options={TEST_TOOLS.map((t) => ({ value: t, label: `${TOOL_LABELS[t]} · ${t}` }))}
            />
            <AutoTextarea
              value={testArgs}
              aria-label="Argumentos de exemplo"
              onChange={(e) => setTestArgs(e.target.value)}
              minRows={2}
              maxRows={8}
              className={cn('field font-mono text-[11px]', argsError && 'border-danger/60')}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                loading={testing}
                disabled={!hasModel || !!argsError}
                icon={<FlaskConical className="size-3.5" />}
                onClick={() => void runTest()}
              >
                Testar
              </Button>
              <span className="text-[11px] text-faint">
                {argsError
                  ? 'JSON inválido'
                  : 'Contexto de exemplo: “As dependências do projeto estão quebradas, reinstale.”'}
              </span>
            </div>
            {testError && <p className="text-[11.5px] text-danger/90">{testError}</p>}
            {testResult && (
              <div
                data-testid="smart-test-result"
                className="overflow-hidden rounded-lg border border-border"
              >
                <SmartApproveLine rec={testResult} pending />
              </div>
            )}
          </div>
        </CollapsibleSection>
      </div>
    </CollapsibleSection>
  )
}
