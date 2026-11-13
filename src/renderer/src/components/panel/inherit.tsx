// Herança ao vivo da persona no painel do chat (protocolo 1.10.0 — @shared/chatInherit): os
// editores (os mesmos do editor de personas) leem daqui se uma unidade é PRÓPRIA do chat ou
// herdada, qual seria o valor herdado e como "voltar a herdar". Fora do painel de um chat que herda
// (editor de personas, chat sem persona, chat antigo ainda não migrado) não há contexto e nada
// aparece.
import { RotateCcw } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import {
  inheritanceActive,
  inheritedUnitValue,
  isOwn,
  ownUnits,
  personaDefines
} from '@shared/chatInherit'
import type { Chat } from '@shared/types'
import { cn } from '../../lib/format'
import { inheritEnvFrom, unitLabel, unitValueText } from '../../lib/inherit'
import { useStore } from '../../store'
import { Tip } from '../ui/Tooltip'
import { InheritContext as Ctx, useInherit, type InheritCtx } from './inheritContext'

/** Provê a herança do chat aos editores de dentro (só quando ela vale aqui). */
export function ChatInheritProvider({
  chat,
  banner = false,
  children
}: {
  chat: Chat
  /** Linha no topo da aba dizendo de quem os campos sem marca herdam (abas Modelo/Tools/Memória). */
  banner?: boolean
  children: ReactNode
}): React.JSX.Element {
  const presets = useStore((s) => s.presets)
  const settings = useStore((s) => s.settings)
  const providers = useStore((s) => s.providers)
  const revertUnits = useStore((s) => s.revertUnits)
  const preset = chat.config.presetId
    ? (presets.find((p) => p.id === chat.config.presetId) ?? null)
    : null
  const value = useMemo<InheritCtx | null>(() => {
    if (!preset || !inheritanceActive(chat.config, preset.config)) return null
    const env = inheritEnvFrom(settings, providers)
    const providerName = (id: string): string | null =>
      providers.find((p) => p.id === id)?.name ?? null
    const inherited = (u: string): unknown => inheritedUnitValue(chat.config, u, preset.config, env)
    return {
      personaName: preset.name,
      isOwn: (u) => isOwn(chat.config, u),
      inherited,
      source: (u) =>
        personaDefines(preset.config, u)
          ? `persona “${preset.name}”`
          : `padrão de “Novos chats” (a persona “${preset.name}” não define)`,
      inheritedText: (u) => unitValueText(u, inherited(u), providerName),
      revert: (units) => void revertUnits(chat.id, units),
      own: ownUnits(chat.config)
    }
  }, [chat.config, chat.id, preset, settings, providers, revertUnits])
  return (
    <Ctx.Provider value={value}>
      {banner && value && (
        <div
          data-testid="inherit-banner"
          className="flex items-center gap-1.5 border-b border-border/70 bg-accent-soft/20 px-4 py-1.5 text-[11.5px] leading-snug text-subtle"
        >
          <span className="min-w-0 flex-1">
            Campos sem marca seguem <span className="text-fg/85">“{value.personaName}”</span> ao
            vivo;{' '}
            <span className="inline-flex -translate-y-px items-center gap-0.5 rounded border border-accent/25 bg-accent-soft/60 px-1 text-[10px] text-accent-strong align-middle">
              <RotateCcw aria-hidden className="size-2" />
              neste chat
            </span>{' '}
            = deste chat (clique para voltar a herdar).
          </span>
        </div>
      )}
      {children}
    </Ctx.Provider>
  )
}

/**
 * Sem herança aqui dentro: editores reaproveitados para outra coisa que não as unidades do chat
 * (ex.: modelo/params da chamada de voz — `voice.model.params` não é `params.<nome>`).
 */
export function NoInheritProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return <Ctx.Provider value={null}>{children}</Ctx.Provider>
}

/**
 * Marca de campo PRÓPRIO do chat ("neste chat" + ↺): clicar volta a herdar da persona; o tooltip
 * mostra o valor herdado. Campo herdado → nada (segue a persona; a seção Persona da aba Chat explica).
 * Várias unidades (ex.: a seção Parâmetros inteira) → volta a herdar todas as próprias.
 */
export function InheritMark({
  units,
  className
}: {
  units: readonly string[]
  className?: string
}): React.JSX.Element | null {
  const ctx = useInherit()
  if (!ctx) return null
  const own = units.filter(ctx.isOwn)
  if (!own.length) return null
  const one = own.length === 1 ? own[0] : null
  const label = (
    <span className="block max-w-[280px] leading-snug">
      <span className="block">
        {one
          ? `Voltar a herdar da persona “${ctx.personaName}”`
          : `Voltar a herdar ${own.length} campos da persona “${ctx.personaName}”`}
      </span>
      {one ? (
        <span className="mt-0.5 block text-subtle">
          Herdado: {ctx.inheritedText(one)} — {ctx.source(one)}
        </span>
      ) : (
        <span className="mt-0.5 block text-subtle">{own.map(unitLabel).join(', ')}</span>
      )}
    </span>
  )
  return (
    <Tip label={label}>
      <button
        type="button"
        data-testid="inherit-revert"
        data-units={own.join(' ')}
        aria-label={
          one
            ? `Voltar a herdar da persona “${ctx.personaName}” (${unitLabel(one)})`
            : `Voltar a herdar da persona “${ctx.personaName}” (${own.length} campos)`
        }
        onClick={(e) => {
          e.stopPropagation()
          ctx.revert(own)
        }}
        className={cn(
          'inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md border border-accent/25 bg-accent-soft/60 px-1.5 text-[10.5px] font-normal tracking-normal text-accent-strong normal-case transition-colors hover:border-accent/50 hover:bg-accent-soft',
          className
        )}
      >
        <RotateCcw aria-hidden className="size-2.5" />
        neste chat
      </button>
    </Tip>
  )
}
