// Busca nativa de tools (protocolo 1.12.0): o modo efetivo de envio das tools de um chat/persona,
// calculado no main com o mesmo resolvedor da request (IPC `agent.toolSearchMode`). Recalcula
// quando a config muda (modelo, provedor, compactação, tools…) e quando o chat muda (uma queda
// para a versão local no meio do turno, mídia nova no histórico).
import { useEffect, useState } from 'react'
import type { ToolSearchModeView } from '@shared/toolSearch'
import type { ChatConfig } from '@shared/types'
import { api } from './api'
import { useStore } from '../store'

export function useToolSearchMode(
  cfg: ChatConfig,
  chatId?: string | null
): ToolSearchModeView | null {
  const [view, setView] = useState<ToolSearchModeView | null>(null)
  const touched = useStore((s) =>
    chatId ? (s.chats.find((c) => c.id === chatId)?.updatedAt ?? 0) : 0
  )
  const key = `${chatId ?? ''}|${touched}|${JSON.stringify(cfg)}`
  useEffect(() => {
    let alive = true
    api.agent
      .toolSearchMode({ chatId: chatId ?? null, cfg })
      .then((v) => alive && setView(v))
      .catch(() => alive && setView(null))
    return () => {
      alive = false
    }
    // a chave já resume chatId + cfg + última alteração do chat
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return view
}
