// "Importar" (Configurações → Conectores): JSON colado (Claude Desktop / Claude Code / Cursor /
// VS Code) ou um arquivo de config conhecido desta máquina → prévia (`parseImport`, nada é gravado)
// → confirmar cria cada um. Os locais (stdio) ainda precisam de "Ativar neste computador".
import { FileJson, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { mcpCommandText, type McpImportItem, type McpTransport } from '@shared/mcp'
import { api, errorMessage } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Chip } from '../ui/Chip'
import { Button, Switch } from '../ui/controls'

type Preview = { items: McpImportItem[]; skipped: string[] } | { error: string } | null

const target = (t: McpTransport): string => (t.type === 'stdio' ? mcpCommandText(t) : t.url)

export function McpImport({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<Preview>(null)
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const [known, setKnown] = useState<{ app: string; path: string }[]>([])
  const [busy, setBusy] = useState(false)
  const loadMcp = useStore((s) => s.loadMcp)
  const toast = useStore((s) => s.toast)

  useEffect(() => {
    let alive = true
    api.mcp
      .knownConfigs()
      .then((k) => alive && setKnown(k))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // prévia ao vivo do que foi colado (o main só lê o JSON — nada é gravado)
  useEffect(() => {
    if (!text.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- campo vazio limpa a prévia
      setPreview(null)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      api.mcp
        .parseImport(text)
        .then((r) => {
          if (!alive) return
          setPreview(r)
          setSkip(new Set())
        })
        .catch((e) => alive && setPreview({ error: errorMessage(e) }))
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [text])

  const items = preview && 'items' in preview ? preview.items : []
  const chosen = items.filter((i) => !skip.has(i.name))

  const confirm = async (): Promise<void> => {
    setBusy(true)
    let ok = 0
    const failed: string[] = []
    for (const it of chosen) {
      try {
        await api.mcp.create({ name: it.name, transport: it.transport })
        ok++
      } catch (e) {
        failed.push(`${it.name}: ${errorMessage(e)}`)
      }
    }
    await loadMcp()
    setBusy(false)
    const local = chosen.filter((i) => i.transport.type === 'stdio').length
    if (ok)
      toast(
        `${ok} ${ok === 1 ? 'conector importado' : 'conectores importados'}${local ? ' — os locais precisam ser ativados neste computador' : ''}.`,
        'success'
      )
    if (failed.length) toast(`Não importados: ${failed.join(' · ')}`, 'error')
    else onDone()
  }

  return (
    <div
      data-testid="mcp-import"
      className="animate-fade-in space-y-3 rounded-xl border border-border-strong/70 bg-bg/40 p-4"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[12.5px] font-medium text-fg/90">Importar de outro app</span>
        {known.map((k) => (
          <Button
            key={k.path}
            size="sm"
            variant="secondary"
            title={k.path}
            icon={<FileJson className="size-3.5 text-accent-strong" />}
            onClick={() =>
              void api.mcp
                .readKnownConfig(k.path)
                .then((json) => setText(JSON.stringify(JSON.parse(json), null, 2)))
                .catch((e) => setPreview({ error: errorMessage(e) }))
            }
          >
            {k.app}
          </Button>
        ))}
      </div>
      <textarea
        value={text}
        aria-label="JSON de configuração"
        spellCheck={false}
        placeholder={
          '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "~"] },\n    "linear": { "url": "https://mcp.linear.app/mcp" }\n  }\n}'
        }
        onChange={(e) => setText(e.target.value)}
        className="field min-h-[120px] resize-y font-mono text-[11.5px] leading-relaxed"
      />
      {preview && 'error' in preview && (
        <p data-testid="mcp-import-error" className="text-[12px] text-danger">
          {preview.error}
        </p>
      )}
      {items.length > 0 && (
        <ul data-testid="mcp-import-preview" className="space-y-1.5">
          {items.map((it) => {
            const on = !skip.has(it.name)
            return (
              <li
                key={it.name}
                data-testid="mcp-import-item"
                data-name={it.name}
                className={cn(
                  'flex items-start gap-2.5 rounded-lg border border-border bg-surface/60 px-2.5 py-2',
                  !on && 'opacity-55'
                )}
              >
                <div className="pt-0.5">
                  <Switch
                    size="sm"
                    checked={on}
                    label={`Importar ${it.name}`}
                    onChange={(v) =>
                      setSkip((cur) => {
                        const next = new Set(cur)
                        if (v) next.delete(it.name)
                        else next.add(it.name)
                        return next
                      })
                    }
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[12px] text-fg/90">{it.name}</span>
                    <Chip>{it.transport.type === 'stdio' ? 'local (stdio)' : 'remoto (HTTP)'}</Chip>
                    {it.transport.type === 'stdio' && (
                      <Chip tone="warning" tip="Roda só depois de “Ativar neste computador”.">
                        precisa ativar
                      </Chip>
                    )}
                  </div>
                  <p
                    className="truncate font-mono text-[11px] text-subtle"
                    title={target(it.transport)}
                  >
                    {target(it.transport)}
                  </p>
                  {it.note && (
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-warning/90">
                      <TriangleAlert className="size-3 shrink-0" />
                      {it.note}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {preview && 'skipped' in preview && preview.skipped.length > 0 && (
        <p data-testid="mcp-import-skipped" className="text-[11.5px] text-subtle">
          Ignorados (formato desconhecido): {preview.skipped.join(', ')}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          data-testid="mcp-import-confirm"
          disabled={!chosen.length}
          loading={busy}
          onClick={() => void confirm()}
        >
          {chosen.length ? `Importar ${chosen.length}` : 'Importar'}
        </Button>
      </div>
    </div>
  )
}
