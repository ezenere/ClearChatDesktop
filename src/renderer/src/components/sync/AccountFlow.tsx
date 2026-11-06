// Entrar numa conta ClearChat (sync): servidor (oficial ou self-host) → e-mail → código →
// desbloqueio (senha de criptografia ou chave de recuperação) → merge do primeiro login.
// Usado no Onboarding e em Configurações → Conta. Ver docs/SYNC_PROTOCOL.md §5, §12, §20.
import {
  Radio,
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Cloud,
  ExternalLink,
  KeyRound,
  Laptop,
  LockKeyhole,
  Mail,
  Server,
  TriangleAlert
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { OFFICIAL_SYNC_LABEL, type SyncServerInfo, type SyncStatus } from '@shared/sync'
import { api, errorMessage } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Button, Label, Switch } from '../ui/controls'
import { SecretInput } from '../ProviderForm'

function ErrorLine({ text }: { text: string | null }): React.JSX.Element | null {
  if (!text) return null
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/[0.07] px-2.5 py-2 text-[12px] text-danger"
    >
      <CircleAlert className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{text}</span>
    </p>
  )
}

/** Escolha do servidor (estilo Jellyfin): oficial ou self-host, validado por /api/info. */
export function ServerPicker({
  status,
  info,
  onInfo
}: {
  status: SyncStatus
  info: SyncServerInfo | null
  onInfo: (i: SyncServerInfo | null) => void
}): React.JSX.Element {
  const [kind, setKind] = useState(status.server.kind)
  const [url, setUrl] = useState(status.server.kind === 'self' ? status.server.url : '')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = status.server.envOverride

  const apply = async (k: 'official' | 'self'): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      await api.sync.setServer(k, k === 'self' ? url : undefined)
      onInfo(await api.sync.probeServer())
    } catch (e) {
      onInfo(null)
      setError(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    let alive = true
    void api.sync
      .probeServer()
      .then((i) => alive && onInfo(i))
      .catch((e) => alive && setError(errorMessage(e)))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (locked)
    return (
      <div className="rounded-xl border border-border bg-bg/30 px-3 py-2.5 text-[12px] text-muted">
        <span className="flex items-center gap-2">
          <Server className="size-3.5 text-subtle" />
          <span className="font-mono">{status.server.url}</span>
        </span>
        <span className="mt-1 block text-[11px] text-subtle">
          Definido por <code className="font-mono">CLEARCHAT_SYNC_URL</code>.
        </span>
        <div className="mt-2 empty:hidden">
          <ErrorLine text={error} />
        </div>
      </div>
    )

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Servidor">
        {(
          [
            ['official', 'ClearChat', OFFICIAL_SYNC_LABEL, Cloud],
            ['self', 'Self-host', 'Seu próprio servidor', Server]
          ] as const
        ).map(([k, title, sub, Icon]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            data-testid={`server-${k}`}
            onClick={() => {
              setKind(k)
              setError(null)
              if (k === 'official') void apply('official')
              else onInfo(null)
            }}
            className={cn(
              'flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
              kind === k
                ? 'border-accent/60 bg-accent-soft/40'
                : 'border-border bg-bg/30 hover:border-border-strong'
            )}
          >
            <Icon
              className={cn(
                'mt-0.5 size-4 shrink-0',
                kind === k ? 'text-accent-strong' : 'text-subtle'
              )}
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{title}</span>
              <span className="block truncate text-[11.5px] text-subtle">{sub}</span>
            </span>
          </button>
        ))}
      </div>
      {kind === 'self' && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void apply('self')
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://sync.exemplo.com ou 192.168.0.10:8080"
            className="field min-w-0 flex-1 font-mono text-[12.5px]"
            data-testid="server-url"
            autoFocus
          />
          <Button type="submit" loading={checking} disabled={!url.trim()}>
            Verificar
          </Button>
        </form>
      )}
      {info && (
        <p
          className="flex items-center gap-1.5 text-[11.5px] text-subtle"
          data-testid="server-info"
        >
          <span className="size-1.5 rounded-full bg-success" />
          {info.name} · protocolo {info.protocol.version ?? info.protocol.max}
          {info.serverVersion ? ` · servidor ${info.serverVersion}` : ''}
        </p>
      )}
      {info?.insecure && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/[0.07] px-2.5 py-2 text-[11.5px] text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          Sem criptografia de transporte (http://) — use só em rede local. Os dados continuam
          cifrados ponta a ponta, mas tokens e metadados não.
        </p>
      )}
      <ErrorLine text={error} />
    </div>
  )
}

/** Fluxo completo de entrada. `onCancel` (onboarding) volta para a configuração do provedor. */
export function AccountFlow({
  onCancel,
  compact
}: {
  onCancel?: () => void
  compact?: boolean
}): React.JSX.Element {
  const status = useStore((s) => s.sync)
  const refreshSync = useStore((s) => s.refreshSync)
  const [info, setInfo] = useState<SyncServerInfo | null>(null)
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState(status?.account?.email ?? '')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [recovery, setRecovery] = useState(false)
  const [rk, setRk] = useState('')
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!status) return <p className="text-xs text-subtle">Carregando…</p>

  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refreshSync()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const signOut = (
    <button
      type="button"
      onClick={() => void act(() => api.sync.logout())}
      className="text-[12px] text-subtle hover:text-fg"
    >
      Sair desta conta
    </button>
  )

  // ---- conta sem chaves ----
  if (status.phase === 'keys-not-ready')
    return (
      <div className="space-y-3">
        <Header icon={KeyRound} title="Defina a senha de criptografia">
          A conta <b className="font-medium text-fg/90">{status.account?.email}</b> ainda não tem a
          senha que protege seus dados. Ela é criada no site (junto com a chave de recuperação).
        </Header>
        <ErrorLine text={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon={<ExternalLink className="size-3.5" />}
            onClick={() => void api.sync.openSetup()}
          >
            Abrir o site
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void act(() => api.sync.refreshKeys())}
          >
            Já defini
          </Button>
          <span className="ml-auto">{signOut}</span>
        </div>
      </div>
    )

  // ---- desbloqueio ----
  if (status.phase === 'locked')
    return recovery ? (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (pw1 !== pw2) return setError('As senhas não conferem.')
          void act(() => api.sync.unlockWithRecovery(rk, pw1, remember))
        }}
      >
        <Header icon={KeyRound} title="Usar a chave de recuperação">
          Digite a chave de 36 caracteres e defina uma senha de criptografia nova (os outros
          dispositivos continuam funcionando).
        </Header>
        <div>
          <Label>Chave de recuperação</Label>
          <input
            value={rk}
            onChange={(e) => setRk(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            className="field font-mono text-[12.5px] tracking-wide uppercase"
            autoFocus
            spellCheck={false}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Senha nova</Label>
            <SecretInput value={pw1} onChange={setPw1} placeholder="mín. 10 caracteres" />
          </div>
          <div>
            <Label>Repita a senha</Label>
            <SecretInput value={pw2} onChange={setPw2} />
          </div>
        </div>
        <RememberRow remember={remember} setRemember={setRemember} />
        <ErrorLine text={error} />
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            icon={<ArrowLeft className="size-3.5" />}
            onClick={() => setRecovery(false)}
          >
            Voltar
          </Button>
          <Button
            type="submit"
            variant="primary"
            className="ml-auto"
            loading={busy}
            disabled={!rk.trim() || !pw1}
          >
            Definir senha e desbloquear
          </Button>
        </div>
      </form>
    ) : (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void act(() => api.sync.unlock(password, remember))
        }}
      >
        <Header icon={LockKeyhole} title="Desbloquear seus dados">
          Conectado como <b className="font-medium text-fg/90">{status.account?.email}</b>. A senha
          de criptografia nunca sai deste computador: ela abre a chave que decifra seus dados.
        </Header>
        <div>
          <Label>Senha de criptografia</Label>
          <SecretInput value={password} onChange={setPassword} autoFocus />
        </div>
        <RememberRow remember={remember} setRemember={setRemember} />
        <ErrorLine text={error} />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setRecovery(true)}
            className="text-[12px] text-subtle hover:text-fg"
          >
            Usei minha chave de recuperação
          </button>
          {signOut}
          <Button
            type="submit"
            variant="primary"
            className="ml-auto"
            loading={busy}
            disabled={!password}
          >
            Desbloquear
          </Button>
        </div>
        {busy && (
          <p className="text-[11.5px] text-subtle">Derivando a chave e baixando seus dados…</p>
        )}
      </form>
    )

  // ---- merge do primeiro login ----
  if (status.phase === 'merge') return <MergeChoice status={status} />

  if (status.phase === 'ready')
    return (
      <p className="text-[12.5px] text-muted">
        Conectado como <b className="font-medium text-fg">{status.account?.email}</b>.
      </p>
    )

  // ---- deslogado: servidor + e-mail + código ----
  return (
    <div className="space-y-4">
      {!compact && (
        <Header icon={Cloud} title={info ? `Entrar em ${info.name}` : 'Entrar na sua conta'}>
          Sincronize provedores, chats, personas e memórias entre seus dispositivos — tudo cifrado
          ponta a ponta antes de sair deste computador.
        </Header>
      )}
      <div>
        <Label>Servidor</Label>
        <ServerPicker status={status} info={info} onInfo={setInfo} />
      </div>
      {step === 'email' ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void act(() => api.sync.requestCode(email)).then((ok) => ok && setStep('code'))
          }}
        >
          <Label>E-mail</Label>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Mail className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@exemplo.com"
                className="field pl-8"
                data-testid="sync-email"
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!email.trim() || !info}
            >
              Enviar código
            </Button>
          </div>
          <p className="text-[11.5px] text-subtle">
            Você recebe um código de 6 dígitos por e-mail
            {info?.captcha ? ' (depois de uma verificação rápida)' : ''}.
          </p>
        </form>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            void act(() => api.sync.verifyCode(email, code))
          }}
        >
          <Label hint={email}>Código</Label>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              className="field w-40 text-center font-mono text-[16px] tracking-[0.4em]"
              data-testid="sync-code"
              autoFocus
            />
            <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
              Entrar <ArrowRight className="size-3.5" />
            </Button>
          </div>
          <div className="flex gap-3 text-[12px] text-subtle">
            <button type="button" className="hover:text-fg" onClick={() => setStep('email')}>
              Trocar e-mail
            </button>
            <button
              type="button"
              className="hover:text-fg"
              onClick={() => void act(() => api.sync.requestCode(email))}
            >
              Reenviar código
            </button>
          </div>
        </form>
      )}
      <ErrorLine text={error} />
      <div className="flex items-center gap-2 border-t border-border pt-3">
        {info?.signupOpen ? (
          <p className="text-[12px] text-subtle">
            Não tem conta?{' '}
            <button
              type="button"
              data-testid="sync-signup"
              onClick={() => void api.sync.openSignup()}
              className="inline-flex items-center gap-1 font-medium text-accent-strong hover:underline"
            >
              Criar conta <ExternalLink className="size-3" />
            </button>
          </p>
        ) : (
          info && <p className="text-[12px] text-subtle">Cadastro só por convite neste servidor.</p>
        )}
        {onCancel && (
          <Button variant="ghost" className="ml-auto" onClick={onCancel}>
            Agora não
          </Button>
        )}
      </div>
    </div>
  )
}

function Header({
  icon: Icon,
  title,
  children
}: {
  icon: typeof Cloud
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-elevated">
        <Icon className="size-4 text-accent-strong" />
      </div>
      <div className="min-w-0">
        <h3 className="text-[14px] font-semibold tracking-tight">{title}</h3>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  )
}

function RememberRow({
  remember,
  setRemember
}: {
  remember: boolean
  setRemember: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-2.5 text-[12.5px] text-muted">
      <Switch checked={remember} onChange={setRemember} size="sm" />
      <span>
        Lembrar neste computador
        <span className="block text-[11px] text-subtle">
          A chave fica no chaveiro do sistema; desligado, pede a senha a cada abertura.
        </span>
      </span>
    </label>
  )
}

/** Primeiro login com dados dos dois lados: priorizar online ou local (§12). */
function MergeChoice({ status }: { status: SyncStatus }): React.JSX.Element {
  const refreshSync = useStore((s) => s.refreshSync)
  const [busy, setBusy] = useState<'online' | 'local' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const m = status.merge
  const choose = async (p: 'online' | 'local'): Promise<void> => {
    setBusy(p)
    setError(null)
    try {
      await api.sync.resolveMerge(p)
      await refreshSync()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const row = (label: string, a?: number, b?: number): React.JSX.Element => (
    <tr className="border-t border-border/70">
      <td className="py-1.5 text-muted">{label}</td>
      <td className="py-1.5 text-right font-mono">{a ?? '—'}</td>
      <td className="py-1.5 text-right font-mono">{b ?? '—'}</td>
    </tr>
  )
  return (
    <div className="space-y-3" data-testid="merge-choice">
      <Header icon={Laptop} title="Este computador já tem dados">
        A conta também tem dados online. Os dois lados serão unidos; a prioridade decide quem vence
        quando a mesma coisa existe dos dois lados — e a versão perdedora dessas coisas é
        descartada.
      </Header>
      {m && (
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[11px] text-subtle">
              <th className="pb-1 text-left font-normal" />
              <th className="pb-1 text-right font-normal">Neste computador</th>
              <th className="pb-1 text-right font-normal">Online</th>
            </tr>
          </thead>
          <tbody>
            {row('Provedores', m.local.providers, m.online.providers)}
            {row('Chats', m.local.chats, m.online.chats)}
            {row('Personas', m.local.presets, m.online.presets)}
            {row('Memórias', m.local.memories, m.online.memories)}
          </tbody>
        </table>
      )}
      {!!m?.conflictingChats && (
        <p className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/[0.07] px-2.5 py-2 text-[12px] text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {m.conflictingChats === 1
            ? '1 chat existe nos dois lados com histórias diferentes; a versão não priorizada será apagada.'
            : `${m.conflictingChats} chats existem nos dois lados com histórias diferentes; a versão não priorizada será apagada.`}
        </p>
      )}
      {!!m?.liveChats && (
        <p
          data-testid="merge-live-chats"
          className="flex items-start gap-2 rounded-lg border border-border bg-elevated/60 px-2.5 py-2 text-[12px] text-muted"
        >
          <Radio className="mt-px size-3.5 shrink-0 text-accent-strong" />
          {m.liveChats === 1
            ? '1 chat só ao vivo continua só neste dispositivo (fica fora do merge). Para enviá-lo, use “Salvar online” no menu do chat.'
            : `${m.liveChats} chats só ao vivo continuam só neste dispositivo (ficam fora do merge). Para enviá-los, use “Salvar online” no menu de cada chat.`}
        </p>
      )}
      <ErrorLine text={error} />
      <div className="grid grid-cols-2 gap-2">
        <Button
          size="lg"
          loading={busy === 'online'}
          disabled={!!busy}
          onClick={() => void choose('online')}
        >
          Priorizar online
        </Button>
        <Button
          size="lg"
          variant="primary"
          loading={busy === 'local'}
          disabled={!!busy}
          onClick={() => void choose('local')}
        >
          Priorizar local
        </Button>
      </div>
    </div>
  )
}
