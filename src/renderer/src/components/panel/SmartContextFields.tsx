// Smart-Approve → "Descrição do ambiente" e "Coleta automática de contexto": peças usadas na aba
// Tools (chat/persona — ajuste sobre o padrão global) e em Configurações → Aprovações (o padrão
// global). O "Contexto capturado da conversa" (descrição mantida pelo resumidor, editável) só
// aparece no painel do chat. Ver SPEC.md → "Smart-Approve → Descrição do ambiente e coleta
// automática de contexto".
import { AlertTriangle, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import {
  CAPTURE_PLACEHOLDERS,
  captureActive,
  capturePromptsSummary,
  capturePromptsWarning,
  CONTEXT_CAPTURE_LIMITS,
  DERIVE_PLACEHOLDERS,
  effectiveCapture,
  effectiveCapturePrompts,
  effectiveEnvironment,
  normalizeCapture,
  normalizeCapturePrompts,
  smartInUse,
  validateCapturePrompts,
  type CapturePromptIssue
} from '@shared/contextCapture'
import {
  DEFAULT_CONTEXT_CAPTURE_PROMPT,
  DEFAULT_CONTEXT_CAPTURE_TEMPLATE,
  DEFAULT_CONTEXT_DERIVE_PROMPT
} from '@shared/defaults'
import type { CapturePrompts, CapturedEntry, ChatConfig, ContextCaptureConfig } from '@shared/types'
import { api } from '../../lib/api'
import { cn, formatCost, relativeTime } from '../../lib/format'
import { useStore } from '../../store'
import { AutoTextarea, Button, Switch } from '../ui/controls'
import { ModelPicker } from '../ui/ModelPicker'
import { C, HelpTip, Tip } from '../ui/Tooltip'
import { PlaceholderList } from '../ui/PlaceholderList'
import { CollapsibleSection, NumberInput, RestoreButton, ToggleRow } from './fields'
import { SideThinkingField } from './SideThinkingField'
import { PromptCacheToggle } from './PromptCacheToggle'
import { SIDE_THINKING } from '@shared/sideReasoning'

export const ENVIRONMENT_PLACEHOLDER =
  'Ex.: 172.16.1.7 é meu servidor de testes; pode reiniciar containers lá. Produção é deploy@prod.exemplo.com — nunca mexer sem perguntar.'

/** Campos da coleta automática (ligada, modelo do resumo, mensagens do agente, max_tokens). */
export function CaptureFields({
  value,
  onChange,
  testId
}: {
  value: ContextCaptureConfig
  onChange: (v: ContextCaptureConfig) => void
  testId?: string
}): React.JSX.Element {
  const c = normalizeCapture(value)
  const hasModel = !!c.providerId && !!c.model
  const L = CONTEXT_CAPTURE_LIMITS
  return (
    <div data-testid={testId} className="space-y-2.5">
      <ToggleRow
        label="Coleta automática de contexto"
        help={
          <>
            <p>
              Depois de cada mensagem sua, um modelo barato atualiza (em segundo plano) uma
              descrição curta do que você quer e permite — o juiz lê antes de decidir. Recebe só as
              suas mensagens e o texto das últimas falas do agente (nunca resultados de tool).
            </p>
            <p>
              Só olha o que veio depois da última mensagem já resumida (nada é reenviado); mensagens
              seguidas viram uma chamada só; Parar cancela o resumo em andamento. Sem itens em
              Smart-Approve, nenhuma chamada é feita.
            </p>
          </>
        }
        checked={c.enabled && hasModel}
        onChange={(enabled) => onChange({ ...c, enabled })}
      />
      <div className="flex items-center gap-1.5">
        <span className="w-[118px] shrink-0 text-[12px] text-fg/90">Modelo do resumo</span>
        <ModelPicker
          className="min-w-0 flex-1"
          value={hasModel ? { providerId: c.providerId!, model: c.model! } : null}
          placeholder="Nenhum"
          // padrão desligado até escolher um modelo: escolher liga
          onChange={(ref) =>
            onChange({ ...c, providerId: ref.providerId, model: ref.model, enabled: true })
          }
        />
        {hasModel && (
          <Tip label="Remover modelo do resumo (desliga a coleta)">
            <button
              type="button"
              aria-label="Remover modelo do resumo"
              onClick={() => onChange({ ...c, providerId: null, model: null, enabled: false })}
              className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 text-[12px] text-fg/90">
          Falas do agente antes da sua (contexto)
        </span>
        <NumberInput
          value={c.lookback}
          disabled={false}
          step={1}
          min={1}
          max={L.maxLookback}
          int
          label="Falas do agente lidas pelo resumo"
          onCommit={(v) => v >= 1 && v <= L.maxLookback && onChange({ ...c, lookback: v })}
        />
      </div>
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 text-[12px] text-fg/90">
          Máx. de tokens da resposta{' '}
          <span className="text-faint">(vazio = {L.defaultMaxTokens})</span>
        </span>
        <NumberInput
          value={c.maxTokens ?? undefined}
          disabled={false}
          step={50}
          min={L.minMaxTokens}
          max={L.maxMaxTokens}
          int
          label="Máximo de tokens do resumo"
          onCommit={(v) =>
            onChange({
              ...c,
              maxTokens:
                Number.isFinite(v) && v >= L.minMaxTokens ? Math.min(v, L.maxMaxTokens) : null
            })
          }
        />
      </div>
      <SideThinkingField
        providerId={c.providerId}
        model={c.model}
        value={c.thinkingTokens}
        onChange={(thinkingTokens) => onChange({ ...c, thinkingTokens })}
        defaultTokens={SIDE_THINKING.capture}
        call="do resumo"
        testId={testId ? `${testId}-thinking` : 'capture-thinking'}
      />
      <div data-testid={testId ? `${testId}-cache` : 'capture-cache'}>
        <PromptCacheToggle
          providerId={c.providerId}
          model={c.model}
          checked={c.cache !== false}
          onChange={(on) => {
            const next: ContextCaptureConfig = { ...c, cache: false }
            if (on) delete next.cache
            onChange(next)
          }}
          what="capture"
        />
      </div>
    </div>
  )
}

// ---------------- prompts do resumidor ----------------

const PROMPT_FIELDS: {
  key: keyof CapturePrompts
  title: string
  role: string
  def: string
  aria: string
}[] = [
  {
    key: 'prompt',
    title: 'Prompt do resumo',
    role: 'role: "system"',
    def: DEFAULT_CONTEXT_CAPTURE_PROMPT,
    aria: 'Prompt do resumidor'
  },
  {
    key: 'template',
    title: 'Template da mensagem do resumo',
    role: 'role: "user"',
    def: DEFAULT_CONTEXT_CAPTURE_TEMPLATE,
    aria: 'Template do resumidor'
  },
  {
    key: 'derivePrompt',
    title: 'Prompt da derivação (subagentes)',
    role: 'role: "system"',
    def: DEFAULT_CONTEXT_DERIVE_PROMPT,
    aria: 'Prompt da derivação do resumidor'
  }
]

function IssueLine({ issue }: { issue: CapturePromptIssue }): React.JSX.Element {
  return (
    <p
      data-testid={`capture-${issue.field}-${issue.level}`}
      className={cn(
        'mt-1 flex items-start gap-1.5 text-[11px] leading-snug',
        issue.level === 'error' ? 'text-warning' : 'text-warning/80'
      )}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>{issue.message}</span>
    </p>
  )
}

/**
 * Os três prompts do resumidor (system do resumo, template do resumo, system da derivação), cada um
 * com "Restaurar padrão", validação e a lista de placeholders. Salva ao sair do campo (igual ao
 * padrão ou vazio → null = segue o padrão, inclusive quando ele mudar numa versão nova).
 */
export function CapturePromptsFields({
  value,
  onChange,
  testId
}: {
  value: CapturePrompts | null | undefined
  onChange: (v: CapturePrompts) => void
  testId?: string
}): React.JSX.Element {
  const saved = normalizeCapturePrompts(value)
  const [drafts, setDrafts] = useState<Partial<Record<keyof CapturePrompts, string>>>({})
  // `local` = o último valor gravado por aqui (o store pode demorar: dois campos salvos em
  // seguida não podem se sobrescrever com um valor velho)
  const [local, setLocal] = useState(saved)
  const [prevSaved, setPrevSaved] = useState(saved)
  const keys = PROMPT_FIELDS.map((f) => f.key)
  if (keys.some((k) => prevSaved[k] !== saved[k])) {
    // mudou por fora (outro dispositivo, "usar o global"): descarta só o rascunho dos campos que
    // mudaram e não são eco do que gravamos aqui
    const external = keys.filter((k) => prevSaved[k] !== saved[k] && saved[k] !== local[k])
    setPrevSaved(saved)
    setLocal(saved)
    if (external.length)
      setDrafts((d) => {
        const next = { ...d }
        for (const k of external) delete next[k]
        return next
      })
  }
  const toValue = (f: (typeof PROMPT_FIELDS)[number], text: string): string | null =>
    !text.trim() || text === f.def ? null : text
  // validação ao vivo: o rascunho vale como se já estivesse salvo
  const live: CapturePrompts = { ...local }
  for (const f of PROMPT_FIELDS)
    if (drafts[f.key] !== undefined) live[f.key] = toValue(f, drafts[f.key]!)
  const issues = validateCapturePrompts(live)
  const commit = (key: keyof CapturePrompts, v: string | null): void => {
    setDrafts((d) => {
      const next = { ...d }
      delete next[key]
      return next
    })
    if ((local[key] ?? null) === v) return
    const next = { ...local, [key]: v }
    setLocal(next)
    onChange(next)
  }
  return (
    <div data-testid={testId} className="animate-fade-in space-y-2.5">
      {PROMPT_FIELDS.map((f) => {
        const text = drafts[f.key] ?? local[f.key] ?? f.def
        const custom = toValue(f, text) != null
        return (
          <div key={f.key}>
            <div className="mb-0.5 flex items-center gap-2">
              <span className="min-w-0 text-[10.5px] text-faint">
                {f.title} (<C>{f.role}</C>)
              </span>
              {custom && (
                <span
                  className="ml-auto shrink-0 whitespace-nowrap"
                  data-testid={`capture-${f.key}-restore`}
                >
                  <RestoreButton onClick={() => commit(f.key, null)} />
                </span>
              )}
            </div>
            <AutoTextarea
              value={text}
              aria-label={f.aria}
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value
                setDrafts((d) => ({ ...d, [f.key]: v }))
              }}
              onBlur={() =>
                drafts[f.key] !== undefined && commit(f.key, toValue(f, drafts[f.key]!))
              }
              minRows={4}
              maxRows={16}
              className="field font-mono text-[11px] leading-relaxed"
            />
            {issues
              .filter((i) => i.field === f.key)
              .map((i) => (
                <IssueLine key={i.message} issue={i} />
              ))}
          </div>
        )
      })}
      <PlaceholderList
        groups={[
          { title: 'Placeholders do resumo (prompt e template)', items: CAPTURE_PLACEHOLDERS },
          { title: 'Placeholders da derivação', items: DERIVE_PLACEHOLDERS }
        ]}
        note="Qualquer que seja o prompt, o app descarta linhas novas que copiam o texto do agente sem que você tenha dito ou confirmado (trava “só o que o usuário disse”), e o resumidor nunca recebe resultados de tool. A derivação recebe a descrição do pai e a tarefa numa mensagem fixa."
      />
    </div>
  )
}

/** Aba Tools: descrição do ambiente (chat/persona sobre a global) + coleta (sobre a global). */
export function SmartContextSection({
  cfg,
  set,
  chatId
}: {
  cfg: ChatConfig
  set: (p: {
    environment?: string | null
    capture?: ContextCaptureConfig | null
    capturePrompts?: CapturePrompts | null
  }) => void
  chatId?: string
}): React.JSX.Element {
  const defaults = useStore((s) => s.approvalSettings.smart)
  const globalModes = useStore((s) => s.approvalSettings.modes)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const sa = cfg.smartApprove
  const ownEnv = typeof sa?.environment === 'string'
  const ownCapture = !!sa?.capture
  const ownPrompts = !!sa?.capturePrompts
  const capture = effectiveCapture(sa, defaults)
  const prompts = effectiveCapturePrompts(sa, defaults)
  const inUse = smartInUse(cfg, globalModes)
  const active = captureActive(cfg, globalModes, defaults)
  return (
    <div className="space-y-3" data-testid="smart-context">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-fg/90">Descrição do ambiente</span>
          <HelpTip label="Descrição do ambiente">
            Vai para o juiz no começo da mensagem (<C>{'{{environment}}'}</C>): quais máquinas são
            quais, o que pode ser feito onde.
          </HelpTip>
          <button
            type="button"
            onClick={() => setSettingsOpen(true, 'approvals')}
            className="ml-auto text-[11px] text-accent-strong hover:underline"
          >
            Global
          </button>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-subtle">
            <Switch
              size="sm"
              testId="env-use-global"
              label="Usar a descrição global"
              checked={!ownEnv}
              onChange={(v) => set({ environment: v ? null : (defaults.environment ?? '') })}
            />
            usar a global
          </label>
        </div>
        {ownEnv ? (
          <AutoTextarea
            value={sa?.environment ?? ''}
            aria-label="Descrição do ambiente deste chat"
            placeholder={ENVIRONMENT_PLACEHOLDER}
            onChange={(e) => set({ environment: e.target.value })}
            minRows={2}
            maxRows={10}
            className="field text-[12px] leading-relaxed"
          />
        ) : (
          <p
            data-testid="env-global-text"
            className="rounded-lg border border-border bg-bg/40 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-muted"
          >
            {effectiveEnvironment(sa, defaults) || (
              <span className="text-faint">(vazia — defina em Configurações → Aprovações)</span>
            )}
          </p>
        )}
      </div>

      <div className="border-t border-border/60 pt-2.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-fg/90">Coleta de contexto</span>
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-subtle">
            <Switch
              size="sm"
              testId="capture-use-global"
              label="Usar o padrão global da coleta de contexto"
              checked={!ownCapture}
              onChange={(v) => set({ capture: v ? null : { ...capture } })}
            />
            usar o padrão global
          </label>
        </div>
        {ownCapture ? (
          <CaptureFields
            value={capture}
            onChange={(v) => set({ capture: v })}
            testId="chat-capture-fields"
          />
        ) : (
          <p className="text-[11.5px] text-muted">
            Padrão global:{' '}
            {capture.enabled && capture.model ? `ligada · ${capture.model}` : 'desligada'}
          </p>
        )}
        <p
          data-testid="capture-status"
          data-active={active ? 'true' : 'false'}
          className={cn(
            'mt-1.5 text-[11px] leading-snug',
            active ? 'text-success/90' : 'text-faint'
          )}
        >
          {active
            ? 'Ativa neste chat.'
            : capture.enabled && capture.model && !inUse
              ? 'Inativa: ative o Smart-Approve em algum item (com modelo do juiz).'
              : 'Inativa.'}
        </p>
      </div>

      <CollapsibleSection
        id="smart-capture-prompts"
        level="sub"
        title="Prompts do resumidor"
        summary={
          ownPrompts
            ? { text: `deste chat · ${capturePromptsSummary(prompts)}`, changed: true }
            : { text: `global · ${capturePromptsSummary(prompts)}`, changed: false }
        }
        warning={capturePromptsWarning(prompts)}
      >
        <div data-testid="chat-capture-prompts" className="space-y-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-subtle">
            <Switch
              size="sm"
              testId="capture-prompts-use-global"
              label="Usar os prompts globais do resumidor"
              checked={!ownPrompts}
              onChange={(v) => set({ capturePrompts: v ? null : normalizeCapturePrompts(prompts) })}
            />
            usar o global
          </label>
          {ownPrompts ? (
            <CapturePromptsFields
              value={sa?.capturePrompts}
              onChange={(v) => set({ capturePrompts: v })}
              testId="chat-capture-prompts-fields"
            />
          ) : (
            <p className="text-[11.5px] text-muted">
              Global ({capturePromptsSummary(prompts)}) — edite em{' '}
              <button
                type="button"
                onClick={() => setSettingsOpen(true, 'approvals')}
                className="text-accent-strong hover:underline"
              >
                Configurações → Aprovações
              </button>{' '}
              ou desmarque “usar o global” para personalizar só neste chat.
            </p>
          )}
          {!ownPrompts &&
            validateCapturePrompts(prompts).map((i) => <IssueLine key={i.message} issue={i} />)}
        </div>
      </CollapsibleSection>

      {chatId && <CapturedContextPanel chatId={chatId} cfg={cfg} />}
    </div>
  )
}

/** "Contexto capturado da conversa": a do chat e, vendo um subagente, a dele. Editável. */
function CapturedContextPanel({
  chatId,
  cfg
}: {
  chatId: string
  cfg: ChatConfig
}): React.JSX.Element {
  const view = useStore((s) => s.view)
  const sessions = useStore((s) => s.sessions)
  const subId = view.kind === 'chat' && view.chatId === chatId ? view.sessionId : null
  const sub = subId && sessions[subId]?.depth ? sessions[subId] : null
  const st = cfg.capturedContext
  return (
    <div className="space-y-2.5 border-t border-border/60 pt-2.5">
      <CapturedEntryEditor
        chatId={chatId}
        sessionId={null}
        entry={st?.main}
        title="Contexto capturado da conversa"
      />
      {sub && (
        <CapturedEntryEditor
          chatId={chatId}
          sessionId={sub.id}
          entry={st?.sessions?.[sub.id]}
          title={`Subagente “${sub.title}” (derivado do pai + tarefa)`}
        />
      )}
    </div>
  )
}

const BY_TEXT: Record<CapturedEntry['by'], string> = {
  model: 'pelo resumo',
  user: 'por você',
  derived: 'derivado do pai'
}

function CapturedEntryEditor({
  chatId,
  sessionId,
  entry,
  title
}: {
  chatId: string
  sessionId: string | null
  entry: CapturedEntry | undefined
  title: string
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const saved = entry?.text ?? ''
  const [draft, setDraft] = useState(saved)
  const [prev, setPrev] = useState(saved)
  if (prev !== saved) {
    setPrev(saved)
    setDraft(saved)
  }
  const dirty = draft !== saved
  const last = entry?.lastRun
  const meta = [
    entry?.updatedAt && saved
      ? `atualizado há ${relativeTime(entry.updatedAt)} ${BY_TEXT[entry.by]}`
      : null,
    entry?.calls ? `${entry.calls} resumo${entry.calls > 1 ? 's' : ''}` : null,
    entry?.cost ? formatCost(entry.cost) : null,
    last?.error ? `última falhou: ${last.error}` : null,
    last?.dropped ? `${last.dropped} linha(s) descartada(s) (só o agente disse)` : null
  ].filter(Boolean)
  return (
    <div data-testid={sessionId ? 'captured-context-sub' : 'captured-context'}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[12px] font-medium text-fg/90">{title}</span>
        {entry?.prev && (
          <button
            type="button"
            data-testid="captured-undo"
            onClick={() =>
              void run(() => api.agent.undoCapturedContext(chatId, sessionId), 'Falha ao desfazer')
            }
            className="ml-auto inline-flex items-center gap-1 text-[11px] text-subtle hover:text-fg"
          >
            <RotateCcw className="size-3" /> Desfazer última mudança
          </button>
        )}
      </div>
      <AutoTextarea
        value={draft}
        aria-label={
          sessionId ? 'Contexto capturado do subagente' : 'Contexto capturado da conversa'
        }
        placeholder="(vazio — o resumo preenche depois das suas mensagens; você pode escrever aqui)"
        onChange={(e) => setDraft(e.target.value)}
        minRows={2}
        maxRows={12}
        className="field font-mono text-[11.5px] leading-relaxed"
      />
      <div className="mt-1 flex items-center gap-2">
        <span
          data-testid="captured-meta"
          className="min-w-0 flex-1 truncate text-[10.5px] text-faint"
        >
          {meta.join(' · ') || 'Nada capturado ainda.'}
        </span>
        {dirty && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                void run(
                  () => api.agent.setCapturedContext(chatId, sessionId, draft),
                  'Falha ao salvar'
                )
              }
            >
              Salvar
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
