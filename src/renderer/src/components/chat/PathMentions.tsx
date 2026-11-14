// Caminhos citados nas mensagens do usuário: a linha "Arquivo selecionado: <caminho>" acima do
// balão (1.13.0 — tooltip com o texto EXATO que foi ao modelo) e os `@caminho` do texto com
// destaque (fora de código). Clique → confere e abre no painel de arquivo (lib/chatPaths); não
// existe → aviso discreto. Ver SPEC.md → "Arquivo selecionado" / "Menções @caminho".
import { FileText } from 'lucide-react'
import { Fragment, useMemo } from 'react'
import { openFileText } from '@shared/openFile'
import { findPathMentions, splitPathMentions } from '@shared/pathMentions'
import { openChatPath } from '../../lib/chatPaths'
import { Tip } from '../ui/Tooltip'

/** Linha discreta acima da mensagem do usuário com o arquivo selecionado ao enviar. */
export function OpenFileLine({
  chatId,
  path
}: {
  chatId: string
  path: string
}): React.JSX.Element {
  return (
    <Tip
      label={
        <span className="block max-w-[30rem] leading-snug whitespace-normal">
          <span className="block text-subtle">Enviado ao modelo depois da mensagem:</span>“
          {openFileText(path)}”
        </span>
      }
    >
      <div
        data-testid="msg-open-file"
        data-path={path}
        className="flex max-w-[85%] min-w-0 items-center gap-1 pr-1 text-[11px] text-subtle"
      >
        <FileText className="size-3 shrink-0" />
        <span className="shrink-0">Arquivo selecionado:</span>
        <button
          type="button"
          data-testid="msg-open-file-path"
          onClick={() => void openChatPath(chatId, path)}
          className="min-w-0 truncate font-mono text-muted transition-colors hover:text-fg hover:underline"
        >
          {path}
        </button>
      </div>
    </Tip>
  )
}

/** Texto da mensagem com os `@caminho` destacados (clicáveis). Sem menções → o texto como veio. */
export function MentionText({ chatId, text }: { chatId: string; text: string }): React.JSX.Element {
  const parts = useMemo(() => {
    const found = findPathMentions(text)
    return found.length ? splitPathMentions(text, found) : null
  }, [text])
  if (!parts) return <>{text}</>
  return (
    <>
      {parts.map((p, i) =>
        'mention' in p ? (
          <Tip key={i} label={`Abrir ${p.mention.path} no painel`}>
            <button
              type="button"
              data-testid="msg-path"
              data-path={p.mention.path}
              onClick={(e) => {
                e.stopPropagation()
                void openChatPath(chatId, p.mention.path)
              }}
              className="rounded-[4px] bg-accent/12 px-0.5 font-mono text-[0.9em] text-accent-strong transition-colors hover:bg-accent/20 hover:underline"
            >
              {p.text}
            </button>
          </Tip>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </>
  )
}
