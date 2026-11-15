// Conectores (MCP): execução de uma tool MCP (a aprovação já passou — runner). O resultado do
// servidor vira o texto para o modelo (@shared/mcpResultView) e as imagens viram anexos por
// referência (como o read_file de imagem — nunca base64 no banco). Saída grande / teto: runToolImpl.
import type { ContentPart } from '@shared/types'
import { mcpResultView, type McpToolEntry } from '@shared/mcp'
import { saveStoreFile } from '../attachments'
import { attachmentUrl } from '@shared/attachments'
import { mcpManager, type McpCallOwner } from '../mcp/manager'
import { fail, ok, type ToolContext, type ToolResult } from './util'

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export async function runMcpTool(
  entry: McpToolEntry,
  args: Record<string, unknown>,
  ctx: ToolContext,
  owner: McpCallOwner
): Promise<ToolResult> {
  const raw = await mcpManager.callTool(entry.serverId, entry.tool.name, args, {
    signal: ctx.signal,
    owner,
    ...(ctx.onOutput ? { onProgress: ctx.onOutput } : {})
  })
  const view = mcpResultView(raw)
  const images: ContentPart[] = []
  for (const img of view.images) {
    const ext = IMAGE_EXT[img.mimeType]
    if (!ext) continue // formato que os provedores não leem: fica só a menção no texto
    const data = Buffer.from(img.data, 'base64')
    if (!data.byteLength) continue
    const file = saveStoreFile(data, ext)
    images.push({
      type: 'image_url',
      image_url: { url: attachmentUrl(file) },
      _attachment: {
        name: `${entry.tool.name}.${ext}`,
        mime: img.mimeType,
        size: data.byteLength,
        kind: 'image',
        file
      }
    })
  }
  const base = view.isError ? fail(view.text) : ok(view.text)
  return images.length
    ? { ...base, parts: [{ type: 'text', text: view.text }, ...images], noSpill: true }
    : base
}
