// Aba Tools (chat e persona): modo de aprovação por item — as 3 opções, com ★ na opção igual ao
// valor herdado: no chat que herda a persona ao vivo (1.10.0), o da persona (ou o global, se ela não
// define o item); senão, o padrão global. Sem override = segue o herdado (a opção ★ aparece
// selecionada); escolher a opção ★ volta a herdar. As listas são globais (Configurações → Aprovações).
import { AlertTriangle, Settings2, Star } from 'lucide-react'
import {
  APPROVAL_ITEM_GROUPS,
  APPROVAL_ITEMS,
  effectiveMode,
  ITEM_LABEL,
  ITEM_TOOL,
  normalizeChatModes,
  withChatMode
} from '@shared/approvalPolicy'
import { smartApproveActive } from '@shared/smartApprove'
import type { ApprovalItem, ApprovalMode } from '@shared/types'
import { approvalsSummary } from '../../lib/configSummary'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { AutoApproveInfo } from '../apiDocs'
import type { CfgProps } from '../panel/editors'
import { CollapsibleSection } from '../panel/fields'
import { HelpTip } from '../ui/Tooltip'
import { ModeSelector, SMART_NEEDS_MODEL } from './ApprovalControls'
import { InheritMark } from '../panel/inherit'
import { useInherit } from '../panel/inheritContext'

export function ChatApprovalSection({
  cfg,
  patch,
  chatScope
}: CfgProps & {
  /** Painel do chat: o aviso "sem modelo" leva à seção Smart-Approve (focusConfig). */
  chatScope?: boolean
}): React.JSX.Element {
  const global = useStore((s) => s.approvalSettings.modes)
  const globalAccept = useStore((s) => s.approvalSettings.smart.acceptEditsInRoot)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const focusConfig = useStore((s) => s.focusConfig)
  const overrides = normalizeChatModes(cfg.approvalModes)
  const judge = smartApproveActive(cfg.smartApprove)
  // chat que herda a persona: ★ = o modo herdado (persona → global) e escolher ★ volta a herdar
  const inh = useInherit()
  const unit = (item: ApprovalItem): string => `approvalModes.${item}`
  const inheritedMode = (item: ApprovalItem): ApprovalMode => {
    const v = inh?.inherited(unit(item)) as ApprovalMode | undefined
    return effectiveMode({ approvalModes: v ? { [item]: v } : {} }, global, item)
  }
  // escolher a opção ★ (= global) remove o override; outra opção fixa o modo neste chat
  const set = (item: ApprovalItem, mode: ApprovalMode): void => {
    if (inh && mode === inheritedMode(item)) return inh.revert([unit(item)])
    patch({ approvalModes: withChatMode(overrides, item, mode, global) })
  }
  const inheritedAccept = (): boolean => {
    const v = inh?.inherited('acceptEditsInRoot')
    return typeof v === 'boolean' ? v : globalAccept
  }
  const smartNoModel = judge
    ? []
    : APPROVAL_ITEMS.filter((i) => effectiveMode(cfg, global, i) === 'smart')
  return (
    <CollapsibleSection
      id="approvals"
      title="Aprovações"
      section="aprovacoes"
      summary={approvalsSummary(cfg)}
      warning={
        smartNoModel.length
          ? `Em Smart-Approve sem modelo (pedem confirmação): ${smartNoModel.map((i) => ITEM_LABEL[i]).join(', ')}`
          : null
      }
      aside={<AutoApproveInfo />}
      inherit={[...APPROVAL_ITEMS.map(unit), 'acceptEditsInRoot']}
      inheritClosed
      help={
        inh ? (
          <span data-testid="approval-star-hint">
            <Star className="mb-0.5 inline size-2.5 fill-current text-accent-strong" /> marca o
            valor herdado da persona “{inh.personaName}” (ou o padrão global, onde ela não define);
            escolher a opção com estrela volta a herdar (muda junto se ele mudar).
          </span>
        ) : (
          <span data-testid="approval-star-hint">
            <Star className="mb-0.5 inline size-2.5 fill-current text-accent-strong" /> marca o
            padrão global; escolher a opção com estrela segue o padrão global (muda junto se ele
            mudar).
          </span>
        )
      }
    >
      {APPROVAL_ITEM_GROUPS.map((g) => (
        <div key={g.title} className="space-y-2.5">
          <div className="border-b border-border/50 pb-1 text-[11px] text-subtle">{g.title}</div>
          {g.items.map((item) => {
            const missing = !judge && effectiveMode(cfg, global, item) === 'smart'
            return (
              <div key={item}>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] text-fg/90">{ITEM_LABEL[item]}</span>
                  <span className="font-mono text-[10.5px] text-faint">{ITEM_TOOL[item]}</span>
                  <InheritMark units={[unit(item)]} />
                  {missing && (
                    <span
                      data-testid={`smart-missing-${item}`}
                      title={`${SMART_NEEDS_MODEL}. Sem modelo, este item pede sua confirmação.`}
                      className="ml-auto inline-flex items-center gap-1 text-[11px] text-warning/90"
                    >
                      <AlertTriangle className="size-3" /> sem modelo · pergunta
                    </span>
                  )}
                </div>
                <ModeSelector
                  item={item}
                  value={
                    inh
                      ? inh.isOwn(unit(item))
                        ? effectiveMode(cfg, global, item)
                        : null
                      : (overrides[item] ?? null)
                  }
                  globalMode={inh ? inheritedMode(item) : global[item]}
                  starLabel={inh ? `Herdado (${inh.source(unit(item))})` : undefined}
                  smartUnavailable={!judge}
                  onChange={(m) => set(item, m)}
                  label={`Aprovação: ${ITEM_LABEL[item]}`}
                  testId={`chat-mode-${item}`}
                />
              </div>
            )
          })}
        </div>
      ))}
      {inh ? (
        <AcceptEditsRow
          value={
            inh.isOwn('acceptEditsInRoot')
              ? typeof cfg.acceptEditsInRoot === 'boolean'
                ? cfg.acceptEditsInRoot
                : globalAccept
              : null
          }
          globalValue={inheritedAccept()}
          starLabel={`★ Herdado (${inh.source('acceptEditsInRoot')})`}
          onChange={(v) =>
            v === inheritedAccept()
              ? inh.revert(['acceptEditsInRoot'])
              : patch({ acceptEditsInRoot: v === globalAccept ? null : v })
          }
        />
      ) : (
        <AcceptEditsRow
          value={typeof cfg.acceptEditsInRoot === 'boolean' ? cfg.acceptEditsInRoot : null}
          globalValue={globalAccept}
          onChange={(v) => patch({ acceptEditsInRoot: v === globalAccept ? null : v })}
        />
      )}
      {!judge && (
        <p data-testid="smart-needs-model" className="text-[11px] leading-snug text-faint">
          Smart-Approve indisponível:{' '}
          {chatScope ? (
            <button
              type="button"
              onClick={() => focusConfig('smart-approve')}
              className="text-accent-strong hover:underline"
            >
              escolha um modelo na seção Smart-Approve
            </button>
          ) : (
            'escolha um modelo na seção Smart-Approve'
          )}
          .
        </p>
      )}
      <button
        type="button"
        onClick={() => setSettingsOpen(true, 'approvals')}
        className="inline-flex items-center gap-1.5 text-[11.5px] text-accent-strong hover:underline"
      >
        <Settings2 className="size-3.5" /> Padrões globais e listas (Configurações → Aprovações)
      </button>
    </CollapsibleSection>
  )
}

/**
 * "Aceitar edições dentro da raiz do chat": Ligado / Desligado com ★ no padrão global (escolher a
 * opção ★ volta a seguir o global, como nos modos dos itens).
 */
function AcceptEditsRow({
  value,
  globalValue,
  starLabel = '★ Padrão global',
  onChange
}: {
  /** null = segue o herdado (global; no chat que herda a persona, o dela). */
  value: boolean | null
  globalValue: boolean
  starLabel?: string
  onChange: (v: boolean) => void
}): React.JSX.Element {
  const shown = value ?? globalValue
  return (
    <div className="space-y-1 border-t border-border/50 pt-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] text-fg/90">Aceitar edições dentro da raiz do chat</span>
        <HelpTip label="Aceitar edições dentro da raiz do chat" className="self-center">
          Ligado: escrever/editar arquivos cujo caminho (após seguir links) fica dentro da raiz roda
          sem perguntar e sem o juiz, em qualquer modo. Caminhos protegidos (.env, .git/hooks,
          ~/.ssh…) continuam perguntando.
        </HelpTip>
        <span className="font-mono text-[10.5px] text-faint">write_file · edit_file</span>
        <InheritMark units={['acceptEditsInRoot']} />
      </div>
      <div
        role="radiogroup"
        aria-label="Aceitar edições dentro da raiz do chat"
        data-testid="chat-accept-edits"
        data-inherit={value == null ? 'true' : undefined}
        className="flex rounded-lg border border-border bg-bg/60 p-0.5"
      >
        {[true, false].map((v) => {
          const selected = shown === v
          const star = globalValue === v
          return (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={selected}
              data-value={v ? 'on' : 'off'}
              data-global={star || undefined}
              title={star ? starLabel : undefined}
              onClick={() => onChange(v)}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] transition-colors',
                selected ? 'bg-active text-fg shadow-sm' : 'text-subtle hover:text-fg'
              )}
            >
              {v ? 'Ligado' : 'Desligado'}
              {star && <Star aria-hidden className="size-2.5 shrink-0 fill-current opacity-70" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
