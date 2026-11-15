// Seção "Conectores" da aba Tools (painel do chat e editor de personas): liga/desliga cada conector
// do cadastro (`ChatConfig.mcpServers[id]`, uma unidade da herança por servidor) e, em "Ajustes dos
// conectores", as tools de cada um, as instruções do servidor (desligadas por padrão — nada
// escondido) e os conectores nos subagentes. O cadastro é global (Configurações → Conectores).
import { ArrowUpRight, Plug } from 'lucide-react'
import { useEffect } from 'react'
import { compactToolsOn, sendsCompact, sentToolDefinition } from '@shared/compactTools'
import {
  mcpInstructionsBlock,
  mcpLabel,
  mcpToolDefinition,
  type McpServerChoice,
  type McpServerView,
  type McpToolEntry
} from '@shared/mcp'
import { isNativeMode, messagesApiTool, type ToolSearchModeView } from '@shared/toolSearch'
import type { ChatConfig } from '@shared/types'
import { cn } from '../../lib/format'
import {
  mcpChoiceOf,
  mcpChoicesOf,
  mcpDetailsSummary,
  mcpEntriesHere,
  mcpHintChips,
  mcpRunsHere,
  mcpSummary,
  mcpToolTitle,
  mcpUnavailableReason,
  withMcpChoice,
  withMcpTool
} from '../../lib/mcp'
import { useToolSearchMode } from '../../lib/useToolSearchMode'
import { useStore } from '../../store'
import type { CfgProps } from '../panel/editors'
import { CollapsibleSection, ToggleRow } from '../panel/fields'
import { InheritMark } from '../panel/inherit'
import { ToolFullChip } from '../panel/ToolFullChip'
import { Chip } from '../ui/Chip'
import { Switch } from '../ui/controls'
import { ApiInfo, C, Tip } from '../ui/Tooltip'

const unit = (id: string): string => `mcpServers.${id}`

export function McpSection({
  cfg,
  patch,
  chatScope,
  chatId
}: CfgProps & { chatScope?: boolean; chatId?: string }): React.JSX.Element {
  const views = useStore((s) => s.mcp)
  const loadMcp = useStore((s) => s.loadMcp)
  const openMcp = useStore((s) => s.openMcp)
  const tsView = useToolSearchMode(cfg, chatId)
  useEffect(() => {
    if (!views) void loadMcp()
  }, [views, loadMcp])
  const list = views ?? []
  const choices = mcpChoicesOf(cfg)
  const set = (id: string, c: McpServerChoice): void =>
    patch({ mcpServers: withMcpChoice(cfg, id, c) } as Partial<ChatConfig>)
  const entries = mcpEntriesHere(cfg, list)
  const where = chatScope ? 'neste chat' : 'nesta persona'
  const anyOn = list.some((v) => choices[v.server.id]?.on)

  return (
    <CollapsibleSection
      id="mcp"
      title="Conectores"
      section="conectores"
      focusIds={['mcp-subagentes']}
      summary={mcpSummary(cfg, views)}
      inherit={[...list.map((v) => unit(v.server.id)), 'mcpSubagents']}
      inheritClosed
      help="Servidores MCP do cadastro (Configurações → Conectores). Ligado: as tools dele vão na request como mcp__<nome>__<tool>, com a aprovação definida no conector."
      aside={<McpSendInfo cfg={cfg} views={list} entries={entries} view={tsView} />}
    >
      <div data-testid={chatScope ? 'mcp-panel' : 'preset-mcp'} className="space-y-3">
        {list.length === 0 ? (
          <div className="flex items-center gap-2 text-[12px] text-subtle">
            Nenhum conector cadastrado.
            <button
              type="button"
              onClick={() => openMcp()}
              className="ml-auto inline-flex items-center gap-0.5 text-[11.5px] text-accent-strong hover:underline"
            >
              Adicionar <ArrowUpRight className="size-3" />
            </button>
          </div>
        ) : (
          <div className="-mx-1.5 space-y-px">
            {list.map((v) => (
              <ServerRow
                key={v.server.id}
                view={v}
                choice={mcpChoiceOf(cfg, v.server.id)}
                onChange={(c) => set(v.server.id, c)}
                onOpen={() => openMcp(v.server.id)}
              />
            ))}
          </div>
        )}
        {list.length > 0 && (
          <div className="flex items-center text-[11.5px] text-subtle">
            <span>
              {anyOn ? (
                <>
                  <span className="text-fg/85 tabular-nums">{entries.length}</span>{' '}
                  {entries.length === 1 ? 'tool vai' : 'tools vão'} {where}
                </>
              ) : (
                `Nenhum conector ligado ${where}`
              )}
            </span>
            <button
              type="button"
              onClick={() => openMcp()}
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-accent-strong hover:underline"
            >
              Conectores <ArrowUpRight className="size-3" />
            </button>
          </div>
        )}

        <CollapsibleSection
          id="mcp-details"
          level="sub"
          title="Ajustes dos conectores"
          summary={mcpDetailsSummary(cfg, views)}
          focusIds={['mcp-subagentes']}
        >
          {list
            .filter((v) => v.server.tools?.tools.length || v.server.tools?.instructions)
            .map((v) => (
              <ServerDetails
                key={v.server.id}
                view={v}
                cfg={cfg}
                patch={patch}
                choice={mcpChoiceOf(cfg, v.server.id)}
                onChange={(c) => set(v.server.id, c)}
                mode={tsView?.mode}
                entries={entries}
              />
            ))}
          <div data-section="mcp-subagentes" className={cn(!anyOn && 'opacity-55')}>
            <ToggleRow
              label="Conectores nos subagentes"
              help="Subagentes recebem as mesmas tools dos conectores ligados (com a mesma aprovação)."
              checked={cfg.mcpSubagents === true}
              onChange={(mcpSubagents) => patch({ mcpSubagents })}
              inherit={['mcpSubagents']}
            />
          </div>
        </CollapsibleSection>
      </div>
    </CollapsibleSection>
  )
}

function ServerRow({
  view,
  choice,
  onChange,
  onOpen
}: {
  view: McpServerView
  choice: McpServerChoice
  onChange: (c: McpServerChoice) => void
  onOpen: () => void
}): React.JSX.Element {
  const s = view.server
  const reason = mcpUnavailableReason(view)
  const total = s.tools?.tools.length ?? 0
  const off = new Set(choice.off ?? [])
  const active = s.tools?.tools.filter((t) => !off.has(t.name)).length ?? 0
  const label = mcpLabel(s)
  return (
    <div
      data-testid="mcp-choice"
      data-server={s.name}
      data-on={choice.on || undefined}
      className="flex h-8 items-center gap-2.5 rounded-lg px-1.5 hover:bg-hover/50"
    >
      <Switch
        size="sm"
        checked={choice.on}
        label={`Conector ${label}`}
        onChange={(on) => onChange({ ...choice, on })}
      />
      <Plug
        className={cn(
          'size-3.5 shrink-0',
          choice.on && !reason ? 'text-accent-strong' : 'text-faint'
        )}
      />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[12.5px]',
          reason ? 'text-subtle/80' : choice.on ? 'text-fg/90' : 'text-subtle'
        )}
      >
        {label}
      </span>
      <InheritMark units={[unit(s.id)]} />
      {reason ? (
        <Chip
          testId="mcp-reason"
          tone="warning"
          tip={
            reason === 'precisa entrar'
              ? 'Entre em Configurações → Conectores (o login fica neste aparelho).'
              : 'Ative em Configurações → Conectores — sem isso as tools dele não vão daqui.'
          }
        >
          {reason}
        </Chip>
      ) : (
        choice.on &&
        total > 0 && (
          <Chip tip="Tools que vão (desligue algumas em “Ajustes dos conectores”)">
            {active}/{total}
          </Chip>
        )
      )}
      {!reason && (
        <span className="max-w-[30%] truncate font-mono text-[10.5px] text-faint">{s.name}</span>
      )}
      <Tip label="Abrir em Configurações → Conectores">
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
          aria-label={`Abrir o conector ${label} nas Configurações`}
        >
          <ArrowUpRight className="size-3.5" />
        </button>
      </Tip>
    </div>
  )
}

function ServerDetails({
  view,
  cfg,
  patch,
  choice,
  onChange,
  mode,
  entries
}: CfgProps & {
  view: McpServerView
  choice: McpServerChoice
  onChange: (c: McpServerChoice) => void
  mode?: ToolSearchModeView['mode']
  /** Tools que vão daqui (o nome do modelo de cada uma). */
  entries: McpToolEntry[]
}): React.JSX.Element {
  const s = view.server
  const tools = s.tools?.tools ?? []
  const off = new Set(choice.off ?? [])
  const compact = compactToolsOn(cfg)
  const instr = s.tools?.instructions?.trim()
  const block = instr
    ? mcpInstructionsBlock([s], { [s.id]: { on: true, instructions: true } })
    : null
  return (
    <div
      data-testid="mcp-details-server"
      data-server={s.name}
      className={cn('space-y-1.5', !choice.on && 'opacity-55')}
    >
      <div className="flex items-center gap-1.5 border-b border-border/50 pb-1 text-[11px] text-subtle">
        <Plug className="size-3 shrink-0" />
        <span className="truncate">{mcpLabel(s)}</span>
        <span className="ml-auto tabular-nums text-faint">
          {tools.filter((t) => !off.has(t.name)).length}/{tools.length}
        </span>
      </div>
      {tools.length > 0 && (
        <div data-testid="mcp-tool-checklist" className="-mx-1.5 space-y-px">
          {tools.map((t) => {
            const on = !off.has(t.name)
            const title = mcpToolTitle(t)
            const wire = entries.find((e) => e.serverId === s.id && e.tool.name === t.name)?.wire
            const hints = mcpHintChips(t).map((h) => h.label)
            return (
              <div
                key={t.name}
                data-tool={t.name}
                className="flex min-h-7 items-center gap-2.5 rounded-lg px-1.5 hover:bg-hover/50"
              >
                <Switch
                  size="sm"
                  checked={on}
                  label={`Tool ${t.name} (${mcpLabel(s)})`}
                  onChange={(v) => onChange(withMcpTool(choice, t.name, v))}
                />
                <Tip
                  label={
                    <span className="block max-w-[300px] leading-snug">
                      <span className="block font-mono text-[11px]">{t.name}</span>
                      {t.description && (
                        <span className="mt-0.5 block text-subtle">{t.description}</span>
                      )}
                      {hints.length > 0 && (
                        <span className="mt-0.5 block text-subtle">
                          {hints.join(' · ')} (declarado pelo servidor)
                        </span>
                      )}
                    </span>
                  }
                >
                  <span
                    tabIndex={0}
                    className={cn(
                      'min-w-0 flex-1 truncate text-[12px] outline-none',
                      title === t.name && 'font-mono text-[11.5px]',
                      on ? 'text-fg/85' : 'text-subtle'
                    )}
                  >
                    {title}
                  </span>
                </Tip>
                {compact && on && choice.on && wire && (
                  <ToolFullChip name={wire} cfg={cfg} patch={patch} mode={mode} />
                )}
              </div>
            )
          })}
        </div>
      )}
      {block && (
        <ToggleRow
          label="Instruções do servidor"
          help={
            'Desligado (padrão): o texto que o servidor manda para orientar o modelo não vai.\nLigado: vai no fim do system prompt, como está no (</>).'
          }
          checked={!!choice.instructions}
          onChange={(instructions) => onChange({ ...choice, instructions })}
          info={
            <ApiInfo
              title={`Instruções de ${mcpLabel(s)}`}
              code={block}
              codeLabel="Texto exato (anexado ao fim do system prompt, separado por \n\n):"
              side="left"
            >
              <p>
                Declaradas pelo servidor (não confiáveis). Só vão com o conector e esta opção
                ligados.
              </p>
            </ApiInfo>
          }
        />
      )}
    </div>
  )
}

/** (</>) da seção: as definições EXATAS das tools que vão daqui + as instruções ligadas. */
function McpSendInfo({
  cfg,
  views,
  entries,
  view
}: {
  cfg: ChatConfig
  views: McpServerView[]
  entries: McpToolEntry[]
  view: ToolSearchModeView | null
}): React.JSX.Element {
  const choices = mcpChoicesOf(cfg)
  const on = views.filter((v) => choices[v.server.id]?.on)
  const notHere = on.filter((v) => !mcpRunsHere(v))
  const native = !!view && isNativeMode(view.mode)
  const defs = entries.map((e) => {
    const def = mcpToolDefinition(e)
    if (!native) return sentToolDefinition(def, cfg)
    return (
      view?.items[e.wire] ??
      messagesApiTool(def, sendsCompact(e.wire, cfg), view?.mode === 'native-anthropic')
    )
  })
  const instructions = mcpInstructionsBlock(
    views.filter(mcpRunsHere).map((v) => v.server),
    choices
  )
  const compact = compactToolsOn(cfg)
  return (
    <ApiInfo
      title="Conectores na request"
      side="left"
      wide
      code={entries.length ? JSON.stringify(defs, null, 2) : undefined}
      codeLabel={
        native
          ? 'Itens exatos do array tools (formato da Messages API):'
          : compact
            ? 'Definições exatas (itens do array tools; compactas onde marcado):'
            : 'Definições exatas (itens do array tools):'
      }
    >
      {!on.length ? (
        <p>
          Desligados: <strong className="text-fg">nada</strong> de conectores vai para a API.
        </p>
      ) : (
        <>
          <p>
            {entries.length} {entries.length === 1 ? 'tool vai' : 'tools vão'}{' '}
            {cfg.nativeTools ? (
              <>
                no campo <C>tools</C>
              </>
            ) : (
              <>no texto das tools (tools nativas desligadas)</>
            )}
            , com o nome <C>mcp__servidor__tool</C> e a descrição e o esquema como o servidor mandou
            {native
              ? ' (adiadas para a busca nativa, salvo as marcadas “carregada”).'
              : compact
                ? ' (compactas: a completa volta pela tool_search, salvo as marcadas “completa”).'
                : '.'}
          </p>
          {notHere.length > 0 && (
            <p>
              Não vão daqui: {notHere.map((v) => mcpLabel(v.server)).join(', ')} (não ativado neste
              computador).
            </p>
          )}
          <p>Subagentes: {cfg.mcpSubagents ? 'recebem as mesmas tools' : 'não recebem'}.</p>
          {instructions ? (
            <div>
              <div className="mb-1 text-[11px] text-subtle">
                Instruções dos servidores (fim do system prompt):
              </div>
              <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg/90">
                {instructions}
              </pre>
            </div>
          ) : (
            <p>Instruções dos servidores: nenhuma ligada.</p>
          )}
        </>
      )}
    </ApiInfo>
  )
}
