// Seção de memória da config (aba Memória do painel do chat e editor de personas): só SELECIONA e
// ATIVA coleções — criar/editar conteúdo é em Configurações → Memórias (global). No chat, mostra o
// que veio da persona de origem (selos *da persona* / *adicionada*, ★ na escrita da persona) e
// permite ajustar; na persona, sem "Extrair agora" e "Atualizar memória".
import {
  ArrowUpRight,
  BrainCircuit,
  PenLine,
  RefreshCw,
  RotateCcw,
  Settings2,
  Star,
  TriangleAlert,
  X
} from 'lucide-react'
import { useState } from 'react'
import {
  memoryExtractionSummary,
  memoryHelpSummary,
  memorySubagentsSummary
} from '../../lib/configSummary'
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_HINTS,
  MEMORY_CATEGORY_LABELS,
  type MemoryCategory,
  type MemoryCollection,
  type MemoryConfig
} from '@shared/memory'
import type { Chat, ChatConfig } from '@shared/types'
import { api, errorMessage } from '../../lib/api'
import { formatTime } from '../../lib/dates'
import { cn } from '../../lib/format'
import {
  activeInCategory,
  collectionBadge,
  DEFAULT_MEMORY_EXTRACTION_PROMPT,
  DEFAULT_MEMORY_HELP_PROMPT,
  differsFromPersona,
  extractionCounts,
  memoryConfigOf,
  memoryWillSend,
  restoreFromPersona,
  setWriteTarget,
  sharedCollections,
  toggleCategory,
  toggleCollection,
  writeTargetIssue,
  type CollectionBadge
} from '../../lib/memory'
import { useStore } from '../../store'
import {
  ExtractionPromptInfo,
  MemoryCollectionsInfo,
  MemoryHelpInfo,
  MemoryPreviewInfo,
  MemoryRefreshInfo,
  MemorySubagentsInfo
} from '../apiDocs'
import { PresetIcon } from '../presets/PresetIcon'
import { AutoTextarea, Button, Switch } from '../ui/controls'
import { ModelLabel } from '../ui/ModelLabel'
import { ModelPicker } from '../ui/ModelPicker'
import { Select } from '../ui/Select'
import { Tip } from '../ui/Tooltip'
import type { CfgProps } from '../panel/editors'
import { CollapsibleSection, RestoreButton, Section, ToggleRow } from '../panel/fields'
import { useMemoryCollections, useMemoryPreview } from './hooks'
import { CollectionIcon } from './MemoryIcon'
import { useInherit } from '../panel/inheritContext'

const NONE = '__none__'

export function MemorySection({
  cfg,
  patch,
  chat
}: CfgProps & {
  /** Presente = painel do chat (com extração agora e snapshot). */
  chat?: Chat
}): React.JSX.Element {
  const isChat = !!chat
  const cols = useMemoryCollections()
  const presets = useStore((s) => s.presets)
  const mem = memoryConfigOf(cfg)
  const set = (next: MemoryConfig): void => patch({ memory: next } as Partial<ChatConfig>)

  const preset = isChat && cfg.presetId ? presets.find((p) => p.id === cfg.presetId) : undefined
  const inh = useInherit()
  const persona = preset?.config.memory ? memoryConfigOf(preset.config) : null
  const willSend = memoryWillSend(mem, cols)
  const { preview, reload, setPreview } = useMemoryPreview(
    chat?.id ?? null,
    chat?.mainSessionId ?? null,
    JSON.stringify(mem)
  )
  const helpText = mem.helpPrompt.text ?? DEFAULT_MEMORY_HELP_PROMPT

  return (
    <div data-testid={isChat ? 'memory-panel' : 'preset-memory'}>
      <Section
        title="Memória"
        id="memoria"
        aside={
          <MemoryPreviewInfo
            preview={isChat ? preview : null}
            willSend={willSend}
            persona={!isChat}
            helpText={mem.helpPrompt.enabled ? helpText : null}
          />
        }
      >
        <ToggleRow
          label={isChat ? 'Memória neste chat' : 'Memória nesta persona'}
          help="Índice, instruções e tools de memória nas requests"
          checked={mem.enabled}
          onChange={(enabled) => set({ ...mem, enabled })}
        />
        {preset && inh ? (
          // herança ao vivo (1.10.0): a memória inteira é uma unidade — herdada ou deste chat
          <PersonaLine
            name={preset.name}
            icon={preset.icon}
            differs={inh.isOwn('memory')}
            ownLabel="Própria deste chat"
            sameLabel="Herdada da persona (ao vivo)"
            restoreLabel={`Voltar a herdar da persona “${preset.name}”`}
            onRestore={() => inh.revert(['memory'])}
          />
        ) : (
          preset &&
          persona && (
            <PersonaLine
              name={preset.name}
              icon={preset.icon}
              differs={differsFromPersona(mem, persona)}
              onRestore={() => set(restoreFromPersona(persona))}
            />
          )
        )}
        <SendStatus mem={mem} cols={cols} willSend={willSend} />
      </Section>

      <CollapsibleSection
        id="memory-collections"
        title="Coleções"
        summary={collectionsSummary(mem, cols, !!persona && differsFromPersona(mem, persona))}
        warning={collectionsWarning(mem, cols)}
        aside={<MemoryCollectionsInfo />}
        help={
          <span data-testid="memory-collections-help">
            Marque as coleções que o modelo lê; em cada categoria, escolha onde ele grava.
            {persona && (
              <>
                {' '}
                <Star className="mb-0.5 inline size-2.5 fill-current text-accent-strong" /> =
                escrita da persona.
              </>
            )}
          </span>
        }
      >
        <div className={cn('space-y-3', !mem.enabled && 'opacity-55')}>
          {MEMORY_CATEGORIES.map((cat) => (
            <CategoryBlock
              key={cat}
              cat={cat}
              mem={mem}
              cols={cols}
              persona={persona}
              onChange={set}
            />
          ))}
        </div>
        <ManageLink />
      </CollapsibleSection>

      <HelpSection mem={mem} text={helpText} onChange={set} />

      <ExtractionSection mem={mem} chat={chat} willSend={willSend} onChange={set} />

      {isChat && chat && (
        <SnapshotSection
          sessionId={chat.mainSessionId}
          chatId={chat.id}
          snapshotAt={preview?.snapshotAt ?? null}
          willSend={willSend}
          onRefreshed={(p) => {
            setPreview(p)
            reload()
          }}
        />
      )}

      <CollapsibleSection
        id="memory-subagents"
        section="memoria-subagentes"
        title="Subagentes"
        summary={memorySubagentsSummary(mem)}
        aside={<MemorySubagentsInfo />}
      >
        <ToggleRow
          label="Memória nos subagentes (só busca/leitura)"
          help="memory_search e memory_read — nunca escrita nem índice"
          checked={mem.subagents}
          onChange={(subagents) => set({ ...mem, subagents })}
        />
      </CollapsibleSection>
    </div>
  )
}

/** Cabeçalho da seção Coleções fechada: quantas ativas e em quantas categorias. */
function collectionsSummary(
  mem: MemoryConfig,
  cols: MemoryCollection[],
  differs: boolean
): { text: string; changed: boolean } {
  const active = mem.categories.flatMap((c) => activeInCategory(mem, cols, c)).length
  const text = `${active} ${active === 1 ? 'ativa' : 'ativas'} · ${mem.categories.length}/${MEMORY_CATEGORIES.length} categorias`
  return differs ? { text: `ajustada · ${text}`, changed: true } : { text, changed: false }
}

/** Escrita sem efeito em alguma categoria ligada (o aviso dentro da seção fica oculto fechada). */
function collectionsWarning(mem: MemoryConfig, cols: MemoryCollection[]): string | null {
  const bad = MEMORY_CATEGORIES.filter(
    (c) => mem.categories.includes(c) && writeTargetIssue(mem, cols, c)
  )
  return bad.length
    ? `Escrita sem efeito em: ${bad.map((c) => MEMORY_CATEGORY_LABELS[c]).join(', ')}`
    : null
}

function PersonaLine({
  name,
  icon,
  differs,
  onRestore,
  ownLabel = 'Ajustada neste chat',
  sameLabel = 'Igual à persona',
  restoreLabel = 'Voltar à memória da persona'
}: {
  name: string
  icon: string
  differs: boolean
  onRestore: () => void
  ownLabel?: string
  sameLabel?: string
  restoreLabel?: string
}): React.JSX.Element {
  return (
    <div
      data-testid="memory-persona-line"
      className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 py-1.5 pr-1.5 pl-2 text-[12px]"
    >
      <PresetIcon icon={icon} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] text-subtle">
          Da persona <span className="text-fg/90">{name}</span>
        </span>
        <span
          className={cn(
            'block truncate text-[11.5px]',
            differs ? 'text-accent-strong' : 'text-muted'
          )}
        >
          {differs ? ownLabel : sameLabel}
        </span>
      </span>
      {differs && (
        <Tip label={restoreLabel}>
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw className="size-3" />}
            onClick={onRestore}
            data-testid="memory-restore"
            className="h-6 px-2 text-[11px]"
          >
            {restoreLabel.startsWith('Voltar a herdar') ? 'Voltar a herdar' : 'Restaurar'}
          </Button>
        </Tip>
      )}
    </div>
  )
}

/** Resumo do que vai (ou não) para a API, com a regra de envio. */
function SendStatus({
  mem,
  cols,
  willSend
}: {
  mem: MemoryConfig
  cols: MemoryCollection[]
  willSend: boolean
}): React.JSX.Element {
  if (!willSend)
    return (
      <p
        data-testid="memory-status"
        data-active="false"
        className="rounded-lg border border-border bg-bg/40 px-3 py-2 text-[11.5px] leading-snug text-subtle"
      >
        <strong className="font-medium text-fg/85">Nada de memória vai para a API.</strong>{' '}
        {!mem.enabled
          ? 'A memória está desligada.'
          : 'Ative ao menos uma coleção numa categoria ligada.'}
      </p>
    )
  const active = mem.categories.flatMap((c) => activeInCategory(mem, cols, c))
  const writes = MEMORY_CATEGORIES.filter(
    (c) => mem.categories.includes(c) && mem.writeTo[c] && !writeTargetIssue(mem, cols, c)
  ).length
  const parts = [
    `${active.length} ${active.length === 1 ? 'coleção' : 'coleções'} no índice`,
    writes
      ? `grava em ${writes} ${writes === 1 ? 'categoria' : 'categorias'}`
      : 'sem coleção de escrita',
    mem.helpPrompt.enabled ? 'instruções' : ''
  ].filter(Boolean)
  return (
    <p
      data-testid="memory-status"
      data-active="true"
      className="flex items-start gap-1.5 rounded-lg border border-accent/20 bg-accent-soft/30 px-3 py-2 text-[11.5px] leading-snug text-muted"
    >
      <BrainCircuit className="mt-px size-3.5 shrink-0 text-accent-strong" />
      <span>Vai para a API: {parts.join(' · ')}.</span>
    </p>
  )
}

const BADGE: Record<Exclude<CollectionBadge, null>, { text: string; cls: string; tip: string }> = {
  persona: {
    text: 'da persona',
    cls: 'border-border text-subtle',
    tip: 'Ativa na persona de origem'
  },
  'persona-off': {
    text: 'da persona · desligada aqui',
    cls: 'border-dashed border-border-strong text-faint',
    tip: 'Ativa na persona, desligada neste chat'
  },
  added: {
    text: 'adicionada',
    cls: 'border-accent/30 text-accent-strong/90',
    tip: 'Ativada só neste chat (a persona não tem)'
  }
}

function CategoryBlock({
  cat,
  mem,
  cols,
  persona,
  onChange
}: {
  cat: MemoryCategory
  mem: MemoryConfig
  cols: MemoryCollection[]
  persona: MemoryConfig | null
  onChange: (m: MemoryConfig) => void
}): React.JSX.Element {
  const toast = useStore((s) => s.toast)
  const openMemory = useStore((s) => s.openMemory)
  const list = sharedCollections(cols, cat)
  const on = mem.categories.includes(cat)
  const active = activeInCategory(mem, cols, cat)
  const issue = writeTargetIssue(mem, cols, cat)
  const writeId = issue ? null : (mem.writeTo[cat] ?? null)
  const personaWrite = persona ? (persona.writeTo[cat] ?? null) : undefined
  const label = MEMORY_CATEGORY_LABELS[cat]
  return (
    <div data-testid={`memory-cat-${cat}`} className="rounded-lg border border-border bg-bg/30">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <Switch
          size="sm"
          checked={on}
          label={`Categoria ${label}`}
          onChange={(v) => onChange(toggleCategory(mem, cat, v))}
        />
        <div className="min-w-0 flex-1">
          <div className={cn('text-[12.5px] font-medium', on ? 'text-fg/90' : 'text-subtle')}>
            {label}
          </div>
          <div className="truncate text-[10.5px] text-faint" title={MEMORY_CATEGORY_HINTS[cat]}>
            {MEMORY_CATEGORY_HINTS[cat]}
          </div>
        </div>
        {on && list.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] text-subtle">Escrita:</span>
            <Select<string>
              label={`Coleção de escrita: ${label}`}
              value={writeId ?? NONE}
              menuMinWidth={210}
              className="h-7 w-[118px] px-2 py-0 text-[11.5px]"
              onChange={(v) => {
                const r = setWriteTarget(mem, cols, cat, v === NONE ? null : v)
                if (r.error) toast(r.error, 'error')
                else onChange(r.mem)
              }}
              options={[
                ...active.map((c) => ({
                  value: c.id,
                  label: (
                    <span className="flex items-center gap-1.5">
                      <PenLine className="size-3 shrink-0 text-accent-strong" />
                      <span className="truncate">{c.name}</span>
                      {personaWrite === c.id && (
                        <Star
                          aria-label="escrita da persona"
                          className="size-2.5 shrink-0 fill-current text-accent-strong"
                        />
                      )}
                    </span>
                  )
                })),
                {
                  value: NONE,
                  label: (
                    <span className="flex items-center gap-1.5 text-subtle">
                      Nenhuma
                      {personaWrite === null && (
                        <Star className="size-2.5 shrink-0 fill-current text-accent-strong" />
                      )}
                    </span>
                  ),
                  description: active.length
                    ? 'O modelo não grava nesta categoria'
                    : 'Ative uma coleção para gravar'
                }
              ]}
            />
          </div>
        )}
      </div>
      {on && (
        <div className="border-t border-border/60 px-1.5 py-1">
          {list.length === 0 ? (
            <button
              type="button"
              onClick={() => openMemory()}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[11.5px] text-subtle hover:bg-hover/50 hover:text-fg"
            >
              Nenhuma coleção — criar em Configurações → Memórias
              <ArrowUpRight className="size-3" />
            </button>
          ) : (
            list.map((c) => {
              const checked = mem.collections.includes(c.id)
              const badge = collectionBadge(c.id, mem, persona)
              const isWrite = writeId === c.id
              return (
                <label
                  key={c.id}
                  data-testid={`memory-col-${c.id}`}
                  data-checked={checked || undefined}
                  className="relative flex h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-hover/50"
                >
                  <Switch
                    size="sm"
                    checked={checked}
                    onChange={(v) => onChange(toggleCollection(mem, c, v))}
                    label={`${label}: ${c.name}`}
                  />
                  <CollectionIcon collection={c} size="xs" />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[12px]',
                      checked ? 'text-fg/90' : 'text-subtle'
                    )}
                  >
                    {c.name}
                  </span>
                  {badge && (
                    <Tip label={BADGE[badge].tip}>
                      <span
                        data-testid="memory-badge"
                        data-badge={badge}
                        className={cn(
                          'shrink-0 rounded border px-1 py-px text-[9.5px] leading-tight',
                          BADGE[badge].cls
                        )}
                      >
                        {BADGE[badge].text}
                      </span>
                    </Tip>
                  )}
                  {isWrite && (
                    <Tip label="Coleção de escrita desta categoria">
                      <PenLine
                        data-testid="memory-write-mark"
                        className="size-3 shrink-0 text-accent-strong"
                      />
                    </Tip>
                  )}
                  <span className="w-5 shrink-0 text-right text-[10.5px] text-faint tabular-nums">
                    {c.count ?? ''}
                  </span>
                </label>
              )
            })
          )}
          {issue && (
            <p className="flex items-center gap-1 px-1.5 pb-1 text-[11px] text-warning/90">
              <TriangleAlert className="size-3 shrink-0" /> Escrita sem efeito: {issue}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ManageLink(): React.JSX.Element {
  const openMemory = useStore((s) => s.openMemory)
  return (
    <button
      type="button"
      onClick={() => openMemory()}
      className="inline-flex items-center gap-1.5 text-[11.5px] text-accent-strong hover:underline"
    >
      <Settings2 className="size-3.5" /> Criar e editar memórias (Configurações → Memórias)
    </button>
  )
}

function HelpSection({
  mem,
  text,
  onChange
}: {
  mem: MemoryConfig
  text: string
  onChange: (m: MemoryConfig) => void
}): React.JSX.Element {
  const custom = mem.helpPrompt.text != null
  return (
    <CollapsibleSection id="memory-help" title="Instruções" summary={memoryHelpSummary(mem)}>
      <ToggleRow
        label="Instruções de memória no system prompt"
        help="Consultar antes de responder, gravar fatos novos, corrigir discrepâncias"
        checked={mem.helpPrompt.enabled}
        onChange={(enabled) => onChange({ ...mem, helpPrompt: { ...mem.helpPrompt, enabled } })}
        info={<MemoryHelpInfo text={text} />}
      />
      {mem.helpPrompt.enabled && (
        <PromptEditor
          id="memory-help-text"
          title="Texto das instruções"
          custom={custom}
          value={text}
          onChange={(t) => onChange({ ...mem, helpPrompt: { ...mem.helpPrompt, text: t } })}
          onRestore={() => onChange({ ...mem, helpPrompt: { ...mem.helpPrompt, text: null } })}
        />
      )}
    </CollapsibleSection>
  )
}

function PromptEditor({
  id,
  title,
  custom,
  value,
  onChange,
  onRestore,
  info
}: {
  id: string
  title: string
  custom: boolean
  value: string
  onChange: (v: string) => void
  onRestore: () => void
  info?: React.ReactNode
}): React.JSX.Element {
  return (
    <CollapsibleSection
      id={id}
      level="sub"
      title={title}
      summary={
        custom ? { text: 'personalizado', changed: true } : { text: 'padrão', changed: false }
      }
      aside={
        <>
          {info}
          {custom && <RestoreButton onClick={onRestore} />}
        </>
      }
    >
      <AutoTextarea
        value={value}
        aria-label={title}
        onChange={(e) => onChange(e.target.value)}
        minRows={4}
        maxRows={14}
        className="field font-mono text-[11px] leading-relaxed"
      />
    </CollapsibleSection>
  )
}

function ExtractionSection({
  mem,
  chat,
  willSend,
  onChange
}: {
  mem: MemoryConfig
  chat?: Chat
  willSend: boolean
  onChange: (m: MemoryConfig) => void
}): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const toast = useStore((s) => s.toast)
  const flushConfig = useStore((s) => s.flushConfig)
  const ex = mem.extraction
  const prompt = ex.prompt ?? DEFAULT_MEMORY_EXTRACTION_PROMPT
  const hasModel = !!ex.providerId && !!ex.model
  const setEx = (p: Partial<MemoryConfig['extraction']>): void =>
    onChange({ ...mem, extraction: { ...ex, ...p } })

  const extractNow = async (): Promise<void> => {
    if (!chat) return
    setRunning(true)
    try {
      await flushConfig(chat.id)
      const r = await api.memory.extractNow(chat.mainSessionId)
      // "nada novo desde a última extração" volta como error sem card: é informação, não falha
      if (r.error && /^Nada novo/i.test(r.error)) toast(r.error, 'info')
      else if (r.error) toast(`Extração de memórias falhou: ${r.error}`, 'error')
      else
        toast(
          r.created + r.updated + r.deleted
            ? `Extração de memórias: ${extractionCounts(r)}.`
            : 'Extração de memórias: nada novo para gravar.',
          'success'
        )
    } catch (err) {
      toast(`Extração de memórias falhou: ${errorMessage(err)}`, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <CollapsibleSection
      id="memory-extraction"
      title="Extração"
      summary={memoryExtractionSummary(mem)}
      aside={
        <ExtractionPromptInfo
          prompt={prompt}
          model={hasModel ? `${ex.model}` : 'o modelo do chat'}
        />
      }
    >
      <ToggleRow
        label="Extrair automaticamente após compactar"
        help="Uma request separada lê a conversa e grava fatos duradouros"
        checked={ex.auto}
        onChange={(auto) => setEx({ auto })}
      />
      <div>
        <div className="mb-1.5 text-[11.5px] text-subtle">Modelo de extração</div>
        <div data-testid="memory-extraction-model" className="flex items-center gap-1.5">
          <ModelPicker
            className="min-w-0 flex-1"
            value={hasModel ? { providerId: ex.providerId!, model: ex.model! } : null}
            placeholder="Modelo do chat"
            onChange={(ref) => setEx({ providerId: ref.providerId, model: ref.model })}
          />
          {hasModel && (
            <Tip label="Usar o modelo do chat">
              <button
                type="button"
                aria-label="Usar o modelo do chat na extração"
                onClick={() => setEx({ providerId: null, model: null })}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            </Tip>
          )}
        </div>
        {hasModel && (
          <p className="mt-1 text-[11px] text-faint">
            Extração com{' '}
            <ModelLabel
              providerId={ex.providerId!}
              model={ex.model!}
              short
              className="text-subtle"
            />
          </p>
        )}
      </div>
      <PromptEditor
        id="memory-extraction-prompt"
        title="Prompt de extração"
        custom={ex.prompt != null}
        value={prompt}
        onChange={(t) => setEx({ prompt: t })}
        onRestore={() => setEx({ prompt: null })}
      />
      {chat && (
        <>
          <Button
            variant="secondary"
            className="w-full"
            data-testid="memory-extract-now"
            loading={running}
            disabled={!willSend}
            icon={<BrainCircuit className="size-3.5 text-accent-strong" />}
            onClick={() => void extractNow()}
          >
            {running ? 'Extraindo memórias…' : 'Extrair memórias agora'}
          </Button>
          {!willSend && (
            <p className="-mt-1 text-center text-[11px] text-subtle">
              Ligue a memória e ative uma coleção para extrair.
            </p>
          )}
        </>
      )}
    </CollapsibleSection>
  )
}

function SnapshotSection({
  sessionId,
  chatId,
  snapshotAt,
  willSend,
  onRefreshed
}: {
  sessionId: string
  chatId: string
  snapshotAt: number | null
  willSend: boolean
  onRefreshed: (p: import('@shared/memory').MemoryPreview) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const toast = useStore((s) => s.toast)
  const flushConfig = useStore((s) => s.flushConfig)
  return (
    <CollapsibleSection
      id="memory-snapshot"
      title="Índice da sessão"
      summary={
        !willSend
          ? 'sem índice'
          : snapshotAt
            ? `desde ${formatTime(snapshotAt)}`
            : 'na próxima request'
      }
      aside={<MemoryRefreshInfo />}
    >
      <div className="flex items-center gap-2.5">
        <p
          data-testid="memory-snapshot"
          className="min-w-0 flex-1 text-[11.5px] leading-snug text-subtle"
        >
          {!willSend
            ? 'Sem índice — a memória não está ativa.'
            : snapshotAt
              ? `Índice congelado desde ${formatTime(snapshotAt)} — mudanças feitas fora deste chat entram ao atualizar.`
              : 'O índice é tirado na próxima request desta sessão.'}
        </p>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={!willSend}
          icon={<RefreshCw className="size-3.5" />}
          onClick={() => {
            setBusy(true)
            void (async () => {
              try {
                await flushConfig(chatId)
                const p = await api.memory.refreshSnapshot(sessionId)
                onRefreshed(p)
                toast('Memória atualizada: a próxima request leva o índice novo.', 'success')
              } catch (err) {
                toast(`Erro ao atualizar a memória: ${errorMessage(err)}`, 'error')
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          Atualizar memória
        </Button>
      </div>
    </CollapsibleSection>
  )
}
