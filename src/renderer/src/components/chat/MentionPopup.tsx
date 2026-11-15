// Popup de `@` do composer (lista de arquivos/pastas da raiz do chat) e os chips dos caminhos
// completos no campo (camada por cima da textarea, com o mesmo texto transparente).
// Estado/teclado em lib/useMentions; sintaxe em @shared/pathMentions. Ver SPEC.md → "Menções
// @caminho".
import { CornerDownLeft, Folder } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { findPathMentions, splitPathMentions } from '@shared/pathMentions'
import type { MentionControls } from '../../lib/useMentions'
import { cn } from '../../lib/format'
import { Spinner } from '../ui/controls'
import { fileIcon } from '../viewer/fileIcons'

/** Lista do popup, acima do campo (↑/↓ move, Tab/Enter aceita, Esc fecha — teclas na textarea). */
export function MentionPopup({ m }: { m: MentionControls }): React.JSX.Element | null {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${m.selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [m.selected, m.items])
  if (!m.open || !m.query) return null
  const q = m.query.query
  return (
    <div
      role="listbox"
      aria-label="Arquivos para mencionar"
      data-testid="mention-popup"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-full left-2 z-30 mb-2 w-[min(440px,calc(100%-1rem))] animate-fade-in overflow-hidden rounded-xl border border-border bg-elevated shadow-popover"
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5 text-[11px] text-subtle">
        <span className="min-w-0 flex-1 truncate" data-testid="mention-scope">
          {m.scope ? (
            <>
              Em <span className="font-mono text-muted">{m.scope}</span>
            </>
          ) : q ? (
            <>
              Buscando <span className="font-mono text-muted">{q}</span> na raiz
            </>
          ) : (
            'Raiz do chat'
          )}
        </span>
        <span className="shrink-0 text-faint">↑↓ · Tab/Enter · Esc</span>
      </div>
      <div ref={list} className="max-h-[260px] overflow-y-auto py-1">
        {m.loading && (
          <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-subtle">
            <Spinner className="size-3.5" /> Carregando arquivos…
          </div>
        )}
        {!m.loading && !m.items.length && (
          <div className="px-3 py-2 text-[12px] text-subtle" data-testid="mention-empty">
            Nenhum arquivo para “{q}”
          </div>
        )}
        {m.items.map((it, i) => {
          const { icon: Icon, tone } = fileIcon(it.name)
          const active = i === m.selected
          return (
            <div
              key={it.path}
              role="option"
              aria-selected={active}
              data-index={i}
              data-testid="mention-item"
              data-path={it.path}
              data-dir={it.dir ? 'true' : undefined}
              onMouseEnter={() => m.setSelected(i)}
              onClick={() => m.pick(i)}
              className={cn(
                'flex h-7 cursor-pointer items-center gap-2 px-3 text-[12.5px]',
                active ? 'bg-accent-soft text-fg' : 'text-fg/85 hover:bg-hover'
              )}
            >
              {it.dir ? (
                <Folder
                  className="size-3.5 shrink-0 text-accent-strong/75"
                  fill="currentColor"
                  fillOpacity={0.15}
                />
              ) : (
                <Icon className={cn('size-3.5 shrink-0', tone)} />
              )}
              <span className="flex min-w-0 flex-1 items-baseline font-mono text-[12px]">
                {it.parent && (
                  <span className="min-w-0 shrink truncate text-faint">{it.parent}</span>
                )}
                <span className={cn('shrink-0 font-medium', active ? 'text-fg' : 'text-fg/90')}>
                  {it.name}
                  {it.dir ? '/' : ''}
                </span>
              </span>
              {active && <CornerDownLeft className="size-3 shrink-0 text-subtle" />}
            </div>
          )
        })}
      </div>
      {m.note && (
        <div className="border-t border-border/70 px-3 py-1 text-[10.5px] text-faint">{m.note}</div>
      )}
    </div>
  )
}

/**
 * Chips dos `@caminho` completos (seguidos de espaço) no campo: uma camada POR CIMA da textarea, com
 * o mesmo texto transparente (mesma caixa/fonte, largura e rolagem sincronizadas) — cada menção
 * ocupa exatamente o lugar do texto cru e o cobre com um chip opaco (ícone + caminho em fonte menor;
 * a sobra de largura vira o padding). O texto continua sendo o da textarea (cursor, desfazer e o que
 * vai ao modelo não mudam). Cursor ou seleção encostando na menção → o chip some e o texto cru
 * aparece (só um fundo de destaque) para editar; menção quebrada em duas linhas idem. Sem menções,
 * nada é renderizado. `className` = as mesmas classes de caixa/fonte da textarea.
 */
export function MentionHighlight({
  text,
  textarea,
  known,
  selection,
  className
}: {
  text: string
  textarea: React.RefObject<HTMLTextAreaElement | null>
  known: (path: string) => boolean
  selection: readonly [number, number] | null
  className: string
}): React.JSX.Element | null {
  const layer = useRef<HTMLDivElement>(null)
  const parts = useMemo(() => {
    const found = findPathMentions(text, { known }).filter((x) => x.complete)
    return found.length ? splitPathMentions(text, found) : null
  }, [text, known])
  useLayoutEffect(() => {
    const ta = textarea.current
    const el = layer.current
    if (!ta || !el) return
    const sync = (): void => {
      el.style.width = `${ta.clientWidth}px`
      el.style.height = `${ta.clientHeight}px`
      el.scrollTop = ta.scrollTop
      // menção quebrada entre linhas: o chip (um retângulo) não cabe — fica o texto cru destacado
      for (const m of el.querySelectorAll<HTMLElement>('[data-testid="composer-mention"]'))
        m.toggleAttribute('data-wrapped', m.getClientRects().length > 1)
    }
    sync()
    ta.addEventListener('scroll', sync)
    const ro = new ResizeObserver(sync)
    ro.observe(ta)
    return () => {
      ta.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [textarea, parts])
  if (!parts) return null
  return (
    <div
      ref={layer}
      aria-hidden
      data-testid="composer-mention-highlight"
      className={cn(
        'pointer-events-none absolute top-0 left-0 overflow-hidden break-words whitespace-pre-wrap text-transparent',
        className
      )}
    >
      {parts.map((p, i) => {
        if (!('mention' in p)) return <span key={i}>{p.text}</span>
        const { start, end } = p.mention
        const editing = !!selection && selection[0] <= end && selection[1] >= start
        return (
          <span
            key={i}
            data-testid="composer-mention"
            data-path={p.mention.path}
            data-editing={editing || undefined}
            className="group/m relative rounded-[3px] [box-decoration-break:clone] data-editing:bg-accent/20 data-wrapped:bg-accent/20"
          >
            {p.text}
            {!editing && <MentionChip path={p.mention.path} />}
          </span>
        )
      })}
      {/* a textarea reserva a linha do cursor depois de uma quebra final */}
      {text.endsWith('\n') ? ' ' : null}
    </div>
  )
}

/** O chip por cima do texto cru da menção (mesma largura; o conteúdo centralizado). */
function MentionChip({ path }: { path: string }): React.JSX.Element {
  const dir = path.endsWith('/')
  const bare = dir ? path.slice(0, -1) : path
  const cut = bare.lastIndexOf('/') + 1
  const parent = bare.slice(0, cut)
  const name = bare.slice(cut) + (dir ? '/' : '')
  const { icon: Icon, tone } = fileIcon(name)
  // a capa (cor do composer: a linha e um pouco abaixo) esconde o texto cru e o sublinhado do
  // corretor ortográfico da textarea
  return (
    <span className="absolute inset-x-0 top-[calc(50%-12px)] flex h-[26px] items-start bg-surface pt-[3px] group-data-wrapped/m:hidden">
      <span
        data-testid="composer-mention-chip"
        className="flex h-5 w-full items-center justify-center overflow-hidden rounded-md bg-accent/16 text-[12px] leading-none whitespace-nowrap ring-1 ring-accent/30 ring-inset"
      >
        {dir ? (
          <Folder
            className="size-3 shrink-0 text-accent-strong/80"
            fill="currentColor"
            fillOpacity={0.2}
          />
        ) : (
          <Icon className={cn('size-3 shrink-0', tone)} />
        )}
        <span className="ml-1 flex min-w-0 items-baseline">
          {parent && <span className="min-w-0 truncate text-muted">{parent}</span>}
          <span className="shrink-0 font-medium text-fg">{name}</span>
        </span>
      </span>
    </span>
  )
}
