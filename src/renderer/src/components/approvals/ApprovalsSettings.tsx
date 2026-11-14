// Configurações → Aprovações: modo GLOBAL por item (Sempre / Smart-Approve / Listas ou Perguntar)
// — é aqui que se define o padrão (★ na aba Tools) — e as listas
// globais (whitelist/blacklist) de comandos, processos e páginas, com busca, edição e "Testar".
import {
  Ban,
  Check,
  CornerDownRight,
  FlaskConical,
  Lock,
  Pencil,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { APPROVAL_ITEM_GROUPS, evaluateLists, ITEM_LABEL, ITEM_TOOL } from '@shared/approvalPolicy'
import { analyzeShell, groupHeadings } from '@shared/shellParse'
import type { ApprovalItem, ApprovalListItem, ApprovalMode } from '@shared/types'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { capturePromptsSummary, capturePromptsWarning } from '@shared/contextCapture'
import {
  CaptureFields,
  CapturePromptsFields,
  ENVIRONMENT_PLACEHOLDER
} from '../panel/SmartContextFields'
import { CollapsibleSection, ToggleRow } from '../panel/fields'
import { AutoTextarea } from '../ui/controls'
import { useStore } from '../../store'
import { C, HelpTip } from '../ui/Tooltip'
import { ListEntryEditor, ModeSelector } from './ApprovalControls'

const ITEM_DESC: Record<ApprovalItem, string> = {
  commands: 'Tool shell — cada comando é desmontado em sub-comandos (|, &&, ;, $(…), bash -c…).',
  processes: 'Tool process_start — mesma análise dos comandos, com listas próprias.',
  pages: 'Tool browse_url — domínio (github.com, *.github.com) ou prefixo de URL.',
  search: 'Tool web_search — sem listas: no modo “Perguntar”, cada busca pede sua confirmação.',
  writeFile: 'Tool write_file — cria ou sobrescreve arquivos.',
  editFile: 'Tool edit_file — substitui trechos de um arquivo.',
  sendToChat:
    'Tool send_to_chat — manda uma mensagem a outro chat (que pode rodar o agente de lá).',
  delegate: 'Tool delegate_task — cria um subagente (com as tools e aprovações deste chat).',
  memory_write: 'Tool memory_write — cria ou atualiza uma memória na coleção de escrita.',
  memory_rewrite:
    'Tool memory_rewrite — cria uma versão corrigida de uma memória só de leitura (a substitui).',
  memory_delete: 'Tool memory_delete — apaga uma memória de uma coleção gravável.'
}

export function ApprovalsSettings(): React.JSX.Element {
  const settings = useStore((s) => s.approvalSettings)
  const update = useStore((s) => s.updateApprovalSettings)
  const [listItem, setListItem] = useState<ApprovalListItem>('commands')
  const setMode = (item: ApprovalItem, mode: ApprovalMode): void =>
    void update({ modes: { ...settings.modes, [item]: mode } })
  return (
    <div className="space-y-5" data-testid="approvals-settings">
      <div className="flex items-center gap-1.5 text-xs leading-relaxed text-subtle">
        Modo padrão de cada item em todos os chats.
        <HelpTip label="Modo padrão de cada item" wide>
          <p>
            Cada chat (aba Tools) e cada persona pode ajustar; lá a opção igual ao padrão daqui
            aparece com ★, e quem não ajustou segue este padrão.{' '}
            <strong className="text-fg/90">process_stop</strong> nunca pede confirmação: o agente só
            enxerga e para processos do próprio chat. As demais tools (leitura, apresentar arquivos,
            histórico, controle de subagentes, perguntas ao usuário) também nunca pedem.
          </p>
          <p>
            <strong className="text-fg/80">Sempre permitir</strong>: roda sem perguntar (a blacklist
            não vale).
          </p>
          <p>
            <strong className="text-fg/80">Smart-Approve</strong>: o modelo juiz escolhido no chat
            (aba Tools → Smart-Approve) aprova ou pergunta; em Comandos/Processos/Páginas ele só
            complementa as listas (blacklist bloqueia, o que a whitelist libera roda sem ele); sem
            modelo → pergunta.
          </p>
          <p>
            <strong className="text-fg/80">Listas</strong> (Comandos, Processos, Páginas): blacklist
            bloqueia (tem precedência), whitelist libera, o resto pergunta.
          </p>
          <p>
            <strong className="text-fg/80">Perguntar</strong> (demais itens): cada chamada pede sua
            confirmação.
          </p>
        </HelpTip>
      </div>
      {APPROVAL_ITEM_GROUPS.map((g) => (
        <div key={g.title} className="settings-section space-y-3">
          <div className="border-b border-border/50 pb-1 text-[11.5px] text-subtle">{g.title}</div>
          {g.items.map((item) => (
            <div key={item}>
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-fg/90">{ITEM_LABEL[item]}</span>
                <HelpTip label={ITEM_LABEL[item]} className="self-center">
                  {ITEM_DESC[item]}
                </HelpTip>
                <span className="font-mono text-[10.5px] text-faint">{ITEM_TOOL[item]}</span>
              </div>
              <ModeSelector
                item={item}
                value={settings.modes[item]}
                onChange={(m) => setMode(item, m)}
                label={`Modo global: ${ITEM_LABEL[item]}`}
                testId={`global-mode-${item}`}
              />
            </div>
          ))}
        </div>
      ))}

      <SmartDefaults />

      <div className="settings-section settings-divided">
        <div className="mb-3 flex items-center gap-1 border-b border-border">
          {(['commands', 'processes', 'pages'] as const).map((it) => (
            <button
              key={it}
              type="button"
              onClick={() => setListItem(it)}
              className={cn(
                '-mb-px border-b-2 px-2.5 pb-1.5 text-[12.5px] transition-colors',
                listItem === it
                  ? 'border-accent text-fg'
                  : 'border-transparent text-subtle hover:text-fg'
              )}
            >
              Listas · {ITEM_LABEL[it]}
            </button>
          ))}
        </div>
        <ListsEditor key={listItem} item={listItem} />
      </div>
    </div>
  )
}

function ListsEditor({ item }: { item: ApprovalListItem }): React.JSX.Element {
  const [query, setQuery] = useState('')
  return (
    <div className="space-y-4">
      {/* busca sempre visível (gruda no topo da aba ao rolar) */}
      <div
        data-testid="lists-search"
        className="sticky top-0 z-10 -mx-1 bg-surface px-1 pt-1 pb-2 shadow-[0_6px_8px_-8px_rgba(0,0,0,0.35)]"
      >
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-accent-strong" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), setQuery(''))}
            placeholder={`Buscar nas listas de ${ITEM_LABEL[item].toLowerCase()}…`}
            aria-label="Buscar nas listas"
            className="field h-9 border-accent/40 pl-9 text-[13px]"
          />
          {query && (
            <button
              type="button"
              aria-label="Limpar busca"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-subtle hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <ListTable item={item} list="allow" query={query} />
      <ListTable item={item} list="deny" query={query} />
      <Tester item={item} />
    </div>
  )
}

/** Texto com os trechos que casam com a busca destacados (sem caixa). */
function Highlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  const q = query.trim().toLowerCase()
  if (!q) return <>{text}</>
  const parts: React.ReactNode[] = []
  const low = text.toLowerCase()
  let i = 0
  for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, i)) {
    if (at > i) parts.push(text.slice(i, at))
    parts.push(
      <mark key={at} data-testid="list-match" className="rounded-sm bg-accent/25 px-px text-fg">
        {text.slice(at, at + q.length)}
      </mark>
    )
    i = at + q.length
  }
  if (i < text.length) parts.push(text.slice(i))
  return <>{parts}</>
}

function ListTable({
  item,
  list,
  query
}: {
  item: ApprovalListItem
  list: 'allow' | 'deny'
  query: string
}): React.JSX.Element {
  const settings = useStore((s) => s.approvalSettings)
  const update = useStore((s) => s.updateApprovalSettings)
  const entries = settings.lists[item][list]
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const shown = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !q || e.toLowerCase().includes(q))
  const save = async (next: string[], added?: string): Promise<boolean> => {
    const ok = await update({
      lists: { ...settings.lists, [item]: { ...settings.lists[item], [list]: next } }
    })
    if (ok) {
      setEditing(null)
      if (added) setJustAdded(added)
    }
    return ok
  }
  // entrada nova (ou o editor de "Adicionar") rola para dentro da caixa
  useEffect(() => {
    if (!box.current) return
    const target =
      editing === 'new'
        ? box.current.querySelector('[data-testid="list-entry-editor"]')
        : justAdded
          ? box.current.querySelector(`[data-entry="${CSS.escape(justAdded)}"]`)
          : null
    target?.scrollIntoView({ block: 'nearest' })
  }, [editing, justAdded, entries.length])
  const allow = list === 'allow'
  const count = q
    ? `${shown.length} de ${entries.length}`
    : `${entries.length} ${entries.length === 1 ? 'entrada' : 'entradas'}`
  return (
    <div data-testid={`list-${item}-${list}`}>
      <div data-testid="list-header" className="mb-1 flex items-center gap-1.5">
        {allow ? (
          <Check className="size-3.5 text-success/90" />
        ) : (
          <Ban className="size-3.5 text-danger/90" />
        )}
        <span className="text-[12px] font-medium text-fg/90">
          {allow ? 'Whitelist' : 'Blacklist'}
        </span>
        <span
          data-testid="list-count"
          className={cn('text-[11px]', q ? 'text-accent-strong' : 'text-faint')}
        >
          {count}
        </span>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-accent-strong hover:bg-accent-soft"
        >
          <Plus className="size-3" /> Adicionar
        </button>
      </div>
      <div
        ref={box}
        data-testid="list-box"
        className="max-h-[34vh] overflow-y-auto overscroll-contain rounded-lg border border-border"
      >
        {shown.length === 0 && editing !== 'new' && (
          <p data-testid="list-empty" className="px-3 py-2 text-[11.5px] text-faint">
            {entries.length ? `Nenhuma entrada contém “${query.trim()}”.` : 'Vazia.'}
          </p>
        )}
        {shown.map(({ e, i }) =>
          editing === i ? (
            <div key={i} className="border-b border-border/70 px-2 py-1.5 last:border-b-0">
              <ListEntryEditor
                item={item}
                list={list}
                initial={e}
                confirmLabel="Salvar"
                onCancel={() => setEditing(null)}
                onConfirm={(v) =>
                  void save(
                    entries.map((x, k) => (k === i ? v : x)),
                    v
                  )
                }
              />
            </div>
          ) : (
            <div
              key={i}
              data-testid="list-entry"
              data-entry={e}
              className={cn(
                'group flex h-8 items-center gap-2 border-b border-border/70 px-3 last:border-b-0 hover:bg-hover/40 focus-within:bg-hover/40',
                justAdded === e && 'bg-accent-soft/40'
              )}
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg/90"
                title={e}
              >
                <Highlight text={e} query={query} />
              </span>
              <button
                type="button"
                aria-label={`Editar ${e}`}
                onClick={() => setEditing(i)}
                className="rounded p-1 text-subtle opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-accent"
              >
                <Pencil className="size-3" />
              </button>
              <button
                type="button"
                aria-label={`Remover ${e}`}
                onClick={() => void save(entries.filter((_, k) => k !== i))}
                className="rounded p-1 text-subtle opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-accent"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          )
        )}
        {editing === 'new' && (
          <div className="px-2 py-1.5">
            <ListEntryEditor
              item={item}
              list={list}
              initial=""
              confirmLabel="Adicionar"
              onCancel={() => setEditing(null)}
              onConfirm={(v) => void save(entries.includes(v) ? entries : [...entries, v], v)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** "Testar comando/URL": decomposição em sub-comandos + veredito de cada um com as listas atuais. */
function Tester({ item }: { item: ApprovalListItem }): React.JSX.Element {
  const lists = useStore((s) => s.approvalSettings.lists)
  const [text, setText] = useState('')
  const [home, setHome] = useState<string | undefined>()
  useEffect(() => {
    void api.fs.homeDir().then(setHome, () => {})
  }, [])
  const isPages = item === 'pages'
  // caminhos relativos: a partir do home (o "Testar" não tem chat; o card usa o diretório do comando)
  const ev = text.trim()
    ? evaluateLists(item, isPages ? { url: text } : { command: text }, lists, {
        home,
        cwd: home
      })
    : null
  const parseError = !isPages && text.trim() ? analyzeShell(text).error : undefined
  const heads = ev ? groupHeadings(ev.check.items) : []
  return (
    <div data-testid="approval-tester" className="rounded-lg border border-border bg-bg/30 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-fg/90">
        <FlaskConical className="size-3.5 text-subtle" />
        {isPages ? 'Testar URL' : 'Testar comando'}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={isPages ? 1 : 2}
        placeholder={isPages ? 'https://github.com/…' : 'git status && npm test | tee log.txt'}
        aria-label={isPages ? 'URL para testar' : 'Comando para testar'}
        className="field resize-y font-mono text-[11.5px]"
      />
      {ev && (
        <div className="mt-2 space-y-1">
          {parseError && (
            <p className="text-[11px] text-warning/90">Não analisável: {parseError}</p>
          )}
          {ev.blocked && (
            <p data-testid="tester-blocked" className="text-[11.5px] text-danger/90">
              Bloqueado: <C>{ev.blocked.entry}</C> casou com <C>{ev.blocked.text}</C> — nada roda.
            </p>
          )}
          {ev.check.items.map((it, i) => (
            <Fragment key={i}>
              {heads[i] && (
                <div
                  data-testid="tester-group"
                  style={{ marginLeft: `${(it.depth ?? 0) * 14}px` }}
                  className="flex items-center gap-1 pt-0.5 text-[10.5px] font-medium text-subtle"
                >
                  <CornerDownRight className="size-3 shrink-0 text-faint" />
                  {heads[i]}
                </div>
              )}
              <div
                data-testid="tester-item"
                style={{ marginLeft: `${(it.depth ?? 0) * 14}px` }}
                className="flex items-start gap-2 rounded-md bg-bg/60 px-2 py-1"
              >
                <span
                  data-testid="tester-verdict"
                  data-kind={it.readOnly ? 'readonly' : it.protectedPath ? 'protected' : it.verdict}
                  className={cn(
                    'mt-px inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium',
                    it.verdict === 'allow'
                      ? 'text-success/90'
                      : it.protectedPath
                        ? 'text-danger/90'
                        : 'text-warning/90'
                  )}
                >
                  {it.protectedPath && <Lock className="size-3" />}
                  {it.readOnly
                    ? '✓ leitura (sempre liberada)'
                    : it.verdict === 'allow'
                      ? '✓ liberado'
                      : it.protectedPath
                        ? 'caminho protegido'
                        : 'pergunta'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[11.5px] break-all text-fg/90">
                    {it.text || '(vazio)'}
                  </span>
                  <span className="block text-[10.5px] text-faint">
                    {[
                      it.entry && `whitelist “${it.entry}”`,
                      it.note !== it.group && it.note,
                      it.reason && `nunca automático: ${it.reason}`,
                      it.suggestion && `sugestão: ${it.suggestion}`
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </div>
            </Fragment>
          ))}
          {!ev.blocked && (
            <p className="text-[11px] text-subtle">
              {ev.readOnly
                ? 'Resultado: só leitura — roda sem perguntar em qualquer modo (sem juiz).'
                : ev.allAllowed
                  ? 'Resultado: roda sem perguntar (modo Listas).'
                  : ev.protected
                    ? 'Resultado: toca um caminho protegido — sempre pergunta (whitelist e juiz não liberam).'
                    : 'Resultado: pede sua decisão para os itens pendentes.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Padrões globais do Smart-Approve (setting `smartApproveDefaults`, sincronizado): descrição do
 * ambiente, "Aceitar edições dentro da raiz", a coleta automática de contexto e os prompts do
 * resumidor. Cada chat/persona pode ajustar.
 */
function SmartDefaults(): React.JSX.Element {
  const smart = useStore((s) => s.approvalSettings.smart)
  const update = useStore((s) => s.updateApprovalSettings)
  const [env, setEnv] = useState(smart.environment)
  const [prevEnv, setPrevEnv] = useState(smart.environment)
  if (prevEnv !== smart.environment) {
    setPrevEnv(smart.environment)
    setEnv(smart.environment)
  }
  const set = (p: Partial<typeof smart>): void => void update({ smart: { ...smart, ...p } })
  return (
    <div data-testid="smart-defaults" className="settings-section settings-divided space-y-3">
      <div className="text-[11.5px] text-subtle">
        Padrões globais (cada chat e persona pode ajustar)
      </div>
      <ToggleRow
        label="Aceitar edições dentro da raiz do chat"
        help={
          'Desligado (padrão).\nLigado: write_file/edit_file com caminho (após seguir links) dentro da raiz do chat rodam sem perguntar e sem o juiz. Caminhos protegidos continuam perguntando.'
        }
        checked={smart.acceptEditsInRoot}
        onChange={(acceptEditsInRoot) => set({ acceptEditsInRoot })}
      />
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-medium text-fg/90">
          Descrição do ambiente (Smart-Approve)
          <HelpTip label="Descrição do ambiente (Smart-Approve)">
            Vai para o juiz de todos os chats (salvo ajuste no chat). Sincroniza entre os seus
            dispositivos (com o sync ligado).
          </HelpTip>
        </div>
        <AutoTextarea
          value={env}
          aria-label="Descrição do ambiente global"
          placeholder={ENVIRONMENT_PLACEHOLDER}
          onChange={(e) => setEnv(e.target.value)}
          onBlur={() => env !== smart.environment && set({ environment: env })}
          minRows={2}
          maxRows={10}
          className="field text-[12px] leading-relaxed"
        />
      </div>
      <CaptureFields
        value={smart.capture}
        onChange={(capture) => set({ capture })}
        testId="global-capture-fields"
      />
      <CollapsibleSection
        id="global-capture-prompts"
        level="sub"
        title="Prompts do resumidor"
        summary={{
          text: capturePromptsSummary(smart.capturePrompts),
          changed: capturePromptsSummary(smart.capturePrompts) !== 'padrão'
        }}
        warning={capturePromptsWarning(smart.capturePrompts)}
      >
        <CapturePromptsFields
          value={smart.capturePrompts}
          onChange={(capturePrompts) => set({ capturePrompts })}
          testId="global-capture-prompts"
        />
      </CollapsibleSection>
    </div>
  )
}
