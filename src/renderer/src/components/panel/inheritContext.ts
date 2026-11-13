// Contexto da herança ao vivo da persona no painel do chat (o provedor e a marca ficam em
// ./inherit.tsx). Separado para o Fast Refresh (arquivo de componentes só exporta componentes).
import { createContext, useContext } from 'react'

export interface InheritCtx {
  personaName: string
  /** A unidade é do chat (não segue a persona)? */
  isOwn: (unit: string) => boolean
  /** Valor que a unidade teria herdando (da persona ou, se ela não define, de "Novos chats"). */
  inherited: (unit: string) => unknown
  /** De onde vem o herdado ("persona “X”" / "padrão de “Novos chats”"). */
  source: (unit: string) => string
  /** Texto legível do valor herdado. */
  inheritedText: (unit: string) => string
  revert: (units: readonly string[]) => void
  /** Unidades próprias do chat (conhecidas). */
  own: string[]
}

export const InheritContext = createContext<InheritCtx | null>(null)

/** Contexto da herança do chat (null = sem herança: persona, chat sem persona, não migrado). */
export function useInherit(): InheritCtx | null {
  return useContext(InheritContext)
}
