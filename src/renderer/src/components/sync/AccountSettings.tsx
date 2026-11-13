// Configurações → Conta: entrar (servidor oficial ou self-host), estado do sync, dispositivos,
// senha de criptografia, chave de recuperação, skills na nuvem e sair. Ver docs/SYNC_PROTOCOL.md.
import {
  Check,
  CircleAlert,
  Cloud,
  CloudOff,
  Copy,
  Download,
  KeyRound,
  Laptop,
  Lightbulb,
  Lock,
  LogOut,
  Monitor,
  Pencil,
  RefreshCw,
  Smartphone,
  TriangleAlert,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { SyncDevice, SyncStatus } from '@shared/sync'
import { api, errorMessage } from '../../lib/api'
import { cn, relativeTime } from '../../lib/format'
import { useStore } from '../../store'
import { Button, Label, Spinner, Switch } from '../ui/controls'
import { HelpTip, Tip } from '../ui/Tooltip'
import { SecretInput } from '../ProviderForm'
import { AccountFlow } from './AccountFlow'
import { connectionLabel } from '../../lib/sync'

const TONE: Record<string, string> = {
  ok: 'bg-success',
  busy: 'bg-accent-strong animate-pulse-soft',
  off: 'bg-faint',
  err: 'bg-danger'
}

function Section({
  title,
  children,
  action,
  help
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
  /** Ajuda estática da seção → (?) ao lado do título. */
  help?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-medium tracking-wide text-subtle uppercase">{title}</h3>
        {help && (
          <HelpTip label={title} className="-ml-1">
            {help}
          </HelpTip>
        )}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  )
}

function DeviceIcon({ d }: { d: SyncDevice }): React.JSX.Element {
  const Icon = d.client === 'mobile' ? Smartphone : d.client === 'web' ? Monitor : Laptop
  return <Icon className="size-3.5 text-muted" />
}

function DevicesList({ status }: { status: SyncStatus }): React.JSX.Element {
  const [list, setList] = useState<SyncDevice[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const run = useStore((s) => s.run)
  const load = useCallback(async () => {
    try {
      setList(await api.sync.devices())
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga assíncrona da lista
    void load()
  }, [load, status.connection])
  if (error) return <p className="text-[12px] text-subtle">Lista indisponível: {error}</p>
  if (!list) return <Spinner className="size-3.5" />
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-bg/30">
      {list.map((d) => (
        <div
          key={d.id}
          className="group flex items-center gap-3 px-3.5 py-2.5"
          onMouseLeave={() => setConfirm(null)}
        >
          <div className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
            <DeviceIcon d={d} />
            <span
              className={cn(
                'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-surface',
                d.online ? 'bg-success' : 'bg-faint'
              )}
            />
          </div>
          <div className="min-w-0 flex-1">
            {editing === d.id ? (
              <form
                className="flex gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run(async () => {
                    await api.sync.renameDevice(d.id, name)
                    setEditing(null)
                    await load()
                  }, 'Erro ao renomear')
                }}
              >
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="field h-7 text-[12.5px]"
                  autoFocus
                />
                <Button
                  size="sm"
                  type="submit"
                  icon={<Check className="size-3.5" />}
                  aria-label="Salvar"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<X className="size-3.5" />}
                  onClick={() => setEditing(null)}
                  aria-label="Cancelar"
                />
              </form>
            ) : (
              <>
                <div className="flex items-baseline gap-2 text-[13px] font-medium">
                  {d.name}
                  {d.current && (
                    <span className="rounded-full bg-accent-soft px-1.5 py-px text-[10.5px] font-normal text-accent-strong">
                      este dispositivo
                    </span>
                  )}
                  {d.push && (
                    <span className="rounded-full bg-elevated px-1.5 py-px text-[10.5px] font-normal text-muted">
                      notificações
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-subtle">
                  {d.platform} · {d.client}
                  {d.appVersion ? ` ${d.appVersion}` : ''} ·{' '}
                  {d.online
                    ? 'online agora'
                    : d.lastSeenAt
                      ? `visto ${relativeTime(Date.parse(d.lastSeenAt))}`
                      : 'nunca conectado'}
                </div>
              </>
            )}
          </div>
          {editing !== d.id && (
            <div className="flex items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
              <Button
                size="sm"
                variant="ghost"
                icon={<Pencil className="size-3.5" />}
                aria-label="Renomear"
                onClick={() => {
                  setEditing(d.id)
                  setName(d.name)
                }}
              />
              {confirm === d.id ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    void run(async () => {
                      await api.sync.revokeDevice(d.id)
                      await load()
                    }, 'Erro ao desconectar')
                  }
                >
                  {d.current ? 'Sair?' : 'Desconectar?'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="hover:text-danger"
                  onClick={() => setConfirm(d.id)}
                >
                  Desconectar
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function PasswordChange(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (!open)
    return (
      <Button icon={<KeyRound className="size-3.5" />} onClick={() => setOpen(true)}>
        Trocar senha de criptografia
      </Button>
    )
  return (
    <form
      className="space-y-2 rounded-xl border border-border-strong/70 bg-bg/40 p-3.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (a !== b) return setMsg({ ok: false, text: 'As senhas não conferem.' })
        setBusy(true)
        setMsg(null)
        void api.sync
          .changePassword(a)
          .then(() => {
            setMsg({
              ok: true,
              text: 'Senha trocada. Os outros dispositivos continuam funcionando.'
            })
            setA('')
            setB('')
          })
          .catch((err) => setMsg({ ok: false, text: errorMessage(err) }))
          .finally(() => setBusy(false))
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label>Senha nova</Label>
          <SecretInput value={a} onChange={setA} placeholder="mín. 10 caracteres" autoFocus />
        </div>
        <div>
          <Label>Repita</Label>
          <SecretInput value={b} onChange={setB} />
        </div>
      </div>
      {msg && (
        <p className={cn('text-[12px]', msg.ok ? 'text-success' : 'text-danger')}>{msg.text}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Fechar
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!a}>
          Trocar senha
        </Button>
      </div>
    </form>
  )
}

function RecoveryKey(): React.JSX.Element {
  const [key, setKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [saved, setSaved] = useState(false)
  const run = useStore((s) => s.run)
  const toast = useStore((s) => s.toast)
  if (key)
    return (
      <div
        className="space-y-2.5 rounded-xl border border-warning/30 bg-warning/[0.05] p-3.5"
        data-testid="recovery-key"
      >
        <p className="text-[12px] text-warning">
          Guarde esta chave num lugar seguro — ela é mostrada só agora. A anterior deixou de valer.
        </p>
        <code className="block rounded-lg border border-border bg-bg/60 px-3 py-2.5 text-center font-mono text-[13px] tracking-wide select-all">
          {key}
        </code>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            icon={<Copy className="size-3.5" />}
            onClick={() => {
              void navigator.clipboard.writeText(key)
              toast('Chave copiada.', 'success')
            }}
          >
            Copiar
          </Button>
          <Button
            size="sm"
            icon={<Download className="size-3.5" />}
            onClick={() => {
              const a = document.createElement('a')
              a.href = URL.createObjectURL(
                new Blob([`Chave de recuperação do ClearChat\n\n${key}\n`], { type: 'text/plain' })
              )
              a.download = 'clearchat-chave-de-recuperacao.txt'
              a.click()
              URL.revokeObjectURL(a.href)
            }}
          >
            Baixar .txt
          </Button>
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
            <Switch size="sm" label="Guardei a chave" checked={saved} onChange={setSaved} />
            Guardei a chave
          </label>
          <Button size="sm" variant="primary" disabled={!saved} onClick={() => setKey(null)}>
            Concluir
          </Button>
        </div>
      </div>
    )
  return confirm ? (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-bg/30 px-3 py-2 text-[12px] text-muted">
      <TriangleAlert className="size-3.5 shrink-0 text-warning" />
      <span className="flex-1">A chave atual deixa de funcionar.</span>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
        Cancelar
      </Button>
      <Button
        size="sm"
        variant="primary"
        loading={busy}
        onClick={() => {
          setBusy(true)
          void run(() => api.sync.newRecoveryKey(), 'Erro ao gerar a chave')
            .then((r) => r && setKey(r.recoveryKey))
            .finally(() => {
              setBusy(false)
              setConfirm(false)
            })
        }}
      >
        Gerar nova chave
      </Button>
    </div>
  ) : (
    <Button icon={<KeyRound className="size-3.5" />} onClick={() => setConfirm(true)}>
      Gerar nova chave de recuperação
    </Button>
  )
}

function SkillsSummary(): React.JSX.Element {
  const tick = useStore((s) => s.skillsTick)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [n, setN] = useState<{ cloud: number; here: number } | null>(null)
  useEffect(() => {
    void Promise.all([api.sync.cloudSkills(), api.sync.trackedSkills()])
      .then(([c, t]) => setN({ cloud: c.length, here: t.length }))
      .catch(() => setN(null))
  }, [tick])
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-bg/30 px-3.5 py-2.5">
      <Lightbulb className="size-4 shrink-0 text-subtle" />
      <div className="min-w-0 flex-1 text-[12.5px]">
        <div className="text-fg/90">
          {n
            ? `${n.cloud} skill${n.cloud === 1 ? '' : 's'} na nuvem · ${n.here} sincronizada${n.here === 1 ? '' : 's'} daqui`
            : 'Skills'}
        </div>
        <div className="text-[11px] text-subtle">
          Opcional: nada de skills é enviado sem você ligar “Sincronizar” em cada uma.
        </div>
      </div>
      <Button size="sm" onClick={() => setSettingsOpen(true, 'skills')}>
        Gerenciar
      </Button>
    </div>
  )
}

export function AccountSettings(): React.JSX.Element {
  const status = useStore((s) => s.sync)
  const refreshSync = useStore((s) => s.refreshSync)
  const run = useStore((s) => s.run)
  const [syncing, setSyncing] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [, force] = useState(0)

  useEffect(() => {
    void refreshSync()
    const t = setInterval(() => force((x) => x + 1), 30_000)
    return () => clearInterval(t)
  }, [refreshSync])

  if (!status) return <Spinner className="size-4" />

  if (status.phase !== 'ready')
    return (
      <div className="space-y-4" data-testid="account-tab">
        <div className="rounded-2xl border border-border bg-bg/30 p-4">
          <AccountFlow />
        </div>
        <p className="text-[11.5px] leading-relaxed text-subtle">
          Zero-knowledge: tudo é cifrado (AES-256-GCM) neste computador com uma chave que só existe
          nos seus dispositivos. O servidor guarda apenas dados cifrados e o e-mail da conta.
        </p>
      </div>
    )

  const conn = connectionLabel(status)
  return (
    <div className="space-y-6" data-testid="account-tab">
      <div className="flex items-start gap-3.5 rounded-2xl border border-border bg-bg/30 p-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent-soft text-[17px] font-semibold text-accent-strong uppercase">
          {(status.account?.name || status.account?.email || '?').slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold tracking-tight">
            {status.account?.name || status.account?.email}
          </div>
          <div className="truncate text-[12px] text-subtle">{status.account?.email}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
            <span className="flex items-center gap-1.5" data-testid="sync-connection">
              <span className={cn('size-1.5 rounded-full', TONE[conn.tone])} />
              {conn.text}
            </span>
            <Tip label={status.server.url}>
              <span className="flex items-center gap-1">
                <Cloud className="size-3" /> {status.server.name ?? status.server.url}
              </span>
            </Tip>
            {status.lastSyncAt && (
              <span>última sincronização {relativeTime(status.lastSyncAt)}</span>
            )}
          </div>
        </div>
        <Button
          size="sm"
          icon={<RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} />}
          disabled={syncing}
          onClick={() => {
            setSyncing(true)
            void run(() => api.sync.syncNow(), 'Falha ao sincronizar').finally(() =>
              setSyncing(false)
            )
          }}
        >
          Sincronizar agora
        </Button>
      </div>

      {(status.error ||
        status.quota ||
        status.protocolError ||
        status.connection === 'offline') && (
        <div className="space-y-1.5">
          {status.protocolError && <Problem text={status.protocolError} />}
          {status.quota && <Problem text={status.quota} />}
          {status.error && <Problem text={status.error} />}
          {status.connection === 'offline' && !status.protocolError && (
            <p className="flex items-start gap-2 rounded-lg border border-border bg-bg/30 px-2.5 py-2 text-[12px] text-muted">
              <CloudOff className="mt-px size-3.5 shrink-0 text-subtle" />
              Sem conexão com o servidor. Você continua usando o app normalmente; as mudanças
              {status.pending
                ? ` (${status.pending} pendente${status.pending > 1 ? 's' : ''})`
                : ''}{' '}
              sobem quando a conexão voltar.
            </p>
          )}
        </div>
      )}

      <Section
        title="Dispositivos"
        help="Cada chat roda num dispositivo (o host); os outros viram controle remoto enquanto ele está online."
      >
        <DevicesList status={status} />
      </Section>

      <Section
        title="Notificações no celular"
        help="O aviso vai cifrado de ponta a ponta para o app do celular (o servidor não lê o conteúdo). Vale para os chats que este computador executa."
      >
        {/* mesmo layout do ToggleRow (rótulo + (?) à esquerda, Switch à direita), com `disabled` */}
        <div className="flex items-start gap-3" data-testid="push-notify">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-fg/90">
              Avisar no celular quando eu estiver ausente ou quando o pedido vier do celular
              <HelpTip label="Avisar no celular" className="ml-1.5 -translate-y-px">
                Aprovações, perguntas e respostas prontas. Ausente = tela bloqueada ou sem uso há 5
                minutos.
              </HelpTip>
            </div>
            {!status.push.available && (
              <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">
                Este servidor não tem notificações push configuradas.
              </p>
            )}
          </div>
          <div className="pt-0.5">
            <Switch
              checked={status.push.enabled}
              disabled={!status.push.available}
              label="Avisar no celular"
              onChange={(on) => {
                void run(async () => {
                  await api.sync.setPushNotify(on)
                  await refreshSync()
                })
              }}
            />
          </div>
        </div>
      </Section>

      <Section title="Segurança">
        <div className="flex flex-wrap gap-2">
          <PasswordChange />
          <RecoveryKey />
        </div>
        <p className="text-[11px] text-subtle">
          {status.remember
            ? 'A chave de decifragem está guardada no chaveiro deste computador.'
            : 'A chave de decifragem fica só na memória: o app pede a senha a cada abertura.'}
        </p>
      </Section>

      <Section title="Skills">
        <SkillsSummary />
      </Section>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          variant="ghost"
          icon={<Lock className="size-3.5" />}
          onClick={() =>
            void run(async () => {
              await api.sync.lock()
              await refreshSync()
            })
          }
        >
          Bloquear neste computador
        </Button>
        {confirmLogout ? (
          <>
            <span className="ml-auto text-[12px] text-subtle">
              Os dados deste computador ficam.
            </span>
            <Button variant="ghost" onClick={() => setConfirmLogout(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              icon={<LogOut className="size-3.5" />}
              onClick={() =>
                void run(async () => {
                  await api.sync.logout()
                  await refreshSync()
                  setConfirmLogout(false)
                })
              }
            >
              Sair da conta
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            className="ml-auto hover:text-danger"
            icon={<LogOut className="size-3.5" />}
            onClick={() => setConfirmLogout(true)}
          >
            Sair da conta
          </Button>
        )}
      </div>
    </div>
  )
}

function Problem({ text }: { text: string }): React.JSX.Element {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/[0.07] px-2.5 py-2 text-[12px] text-danger">
      <CircleAlert className="mt-px size-3.5 shrink-0" />
      {text}
    </p>
  )
}
