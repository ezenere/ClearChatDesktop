// Hooks de dados dos conectores (MCP): o cadastro mora no store (`mcp`, relido com `mcp-changed`).
import { useMemo } from 'react'
import { resolveMcpTool, type McpToolRef } from '../../lib/mcp'
import { useStore } from '../../store'

/** Servidor + tool de um nome do modelo, pelo cadastro do store (null = não é tool de conector). */
export function useMcpToolRef(name: string): McpToolRef | null {
  const views = useStore((s) => s.mcp)
  return useMemo(
    () =>
      resolveMcpTool(
        name,
        views?.map((v) => v.server)
      ),
    [name, views]
  )
}
