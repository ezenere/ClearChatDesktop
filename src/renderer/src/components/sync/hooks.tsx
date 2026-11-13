// Hooks do host de execução (selo, composer, troca de host). Ver ChatHost.tsx.
import { CircleAlert, FolderOpen, Lock, Wrench, Zap } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { Chat } from '@shared/types'
import { takeoverWarnsLocalTools, type ChatHostInfo } from '@shared/sync'
import { api, errorMessage } from '../../lib/api'
import { compactPath } from '../../lib/format'
import { useStore } from '../../store'
import { Button } from '../ui/controls'
import { Modal } from '../ui/layers'

const EMPTY: ChatHostInfo | undefined = undefined

export function useHostInfo(chatId: string | undefined): ChatHostInfo | undefined {
  return useStore((s) => (chatId ? s.chatHosts[chatId] : EMPTY))
}

export const deviceName = (): string => useStore.getState().sync?.device?.name ?? 'este dispositivo'

// ---------------- troca de host ("Executar neste dispositivo") ----------------

/** Diálogo da troca de host: aviso forte de ferramentas locais, raiz local, host fixado. */
export function useTakeover(chat: Chat): {
  start: (mode: 'next_turn' | 'force') => void
  dialog: React.JSX.Element | null
  busy: boolean
} {
  const info = useHostInfo(chat.id)
  const homeDir = useStore((s) => s.homeDir)
  const defaultCwd = useStore((s) => s.settings.defaultCwd)
  const run = useStore((s) => s.run)
  const [mode, setMode] = useState<'next_turn' | 'force' | null>(null)
  const [cwd, setCwd] = useState<string>('')
  const [pinnedOk, setPinnedOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const exec = useCallback(
    async (
      m: 'next_turn' | 'force',
      confirmPinned: boolean,
      root: string | null
    ): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        if (root) await api.sync.confirmCwd(chat.id, root)
        await api.sync.takeover(chat.id, { mode: m, confirmPinned })
        return true
      } catch (e) {
        setError(errorMessage(e))
        return false
      } finally {
        setBusy(false)
      }
    },
    [chat.id]
  )

  // §8.9: o aviso forte só num chat com ferramentas locais que já rodou num computador (hostCwd)
  const localWarn = !!info && takeoverWarnsLocalTools(info.usesLocalTools, info.hostCwd)

  const start = (m: 'next_turn' | 'force'): void => {
    if (!info) return
    const needsDialog = localWarn || info.pinned || info.needsCwd
    if (!needsDialog) {
      void run(async () => {
        await api.sync.takeover(chat.id, { mode: m })
      }, 'Não foi possível executar neste dispositivo')
      return
    }
    setCwd(info.needsCwd ? (defaultCwd ?? homeDir ?? '') : chat.config.cwd)
    setPinnedOk(false)
    setError(null)
    setMode(m)
  }

  const host = info?.host
  const dialog =
    mode && info ? (
      <Modal
        open
        onClose={() => setMode(null)}
        title="Executar neste dispositivo?"
        width={520}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={(info.pinned && !pinnedOk) || (info.needsCwd && !cwd)}
              data-testid="takeover-confirm"
              onClick={() =>
                void exec(mode, info.pinned, info.needsCwd ? cwd : null).then(
                  (ok) => ok && setMode(null)
                )
              }
            >
              {mode === 'force' ? 'Forçar e executar aqui' : 'Executar neste dispositivo'}
            </Button>
          </>
        }
      >
        <div
          className="space-y-3 text-[12.5px] leading-relaxed text-muted"
          data-testid="takeover-dialog"
        >
          {localWarn && (
            <div className="flex items-start gap-2.5 rounded-xl border border-warning/35 bg-warning/[0.08] px-3 py-2.5 text-warning">
              <Wrench className="mt-0.5 size-4 shrink-0" />
              <p>
                <b className="font-semibold">Este chat usa ferramentas locais</b>
                {info.hostCwd ? (
                  <>
                    {' '}
                    (diretório raiz <code className="font-mono">{info.hostCwd.path}</code> no{' '}
                    <b>{host?.name ?? 'outro dispositivo'}</b>)
                  </>
                ) : host ? (
                  <>
                    {' '}
                    no <b>{host.name}</b>
                  </>
                ) : null}
                . Executar no <b>{deviceName()}</b> pode rodar comandos no lugar errado.
              </p>
            </div>
          )}
          {mode === 'force' && host?.status === 'online' && (
            <p className="flex items-start gap-2">
              <Zap className="mt-0.5 size-3.5 shrink-0 text-warning" />O turno em andamento em{' '}
              {host.name} será interrompido (o que já foi gerado fica salvo).
            </p>
          )}
          {info.needsCwd && (
            <div>
              <p className="mb-1.5 text-[12px]">Diretório raiz deste chat neste dispositivo:</p>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    const d = await api.fs.pickDirectory()
                    if (d) setCwd(d)
                  })
                }
                className="field group flex items-center gap-2.5 text-left"
              >
                <FolderOpen className="size-4 shrink-0 text-subtle group-hover:text-accent-strong" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg/90">
                  {compactPath(cwd || '~', homeDir, 60)}
                </span>
                <span className="text-xs text-subtle group-hover:text-fg">Alterar</span>
              </button>
            </div>
          )}
          {info.pinned && (
            <label className="flex items-start gap-2 rounded-lg border border-border bg-bg/40 px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={pinnedOk}
                onChange={(e) => setPinnedOk(e.target.checked)}
                data-testid="takeover-pinned"
              />
              <span>
                <Lock className="mr-1 inline size-3 text-subtle" />O host está fixado em{' '}
                <b className="text-fg/90">{host?.name ?? 'outro dispositivo'}</b>. Executar neste
                dispositivo mesmo assim.
              </span>
            </label>
          )}
          {error && (
            <p className="flex items-start gap-2 text-danger">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </Modal>
    ) : null
  return { start, dialog, busy }
}
