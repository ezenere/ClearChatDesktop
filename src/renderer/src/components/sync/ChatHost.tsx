// Host de execução na UI (docs/SYNC_PROTOCOL.md §8–§9): ícone do host na barra do composer (popover
// "Executando em <dispositivo>" com as ações), cartão do host offline e avisos acima do composer,
// troca de host com o aviso de ferramentas locais, painel de divergência e perguntas do sync.
import {
  CircleAlert,
  Cloud,
  Radio,
  CloudOff,
  GitFork,
  Laptop,
  Lock,
  MonitorSmartphone,
  TriangleAlert,
  Unlock,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Chat } from '@shared/types'
import type { DivergenceDetails, DivergenceVersion } from '@shared/sync'
import { selectionToReach, type BranchSel } from '@shared/branches'
import { api, errorMessage } from '../../lib/api'
import { cn, messageText, relativeTime } from '../../lib/format'
import { useStore } from '../../store'
import { Button, Spinner } from '../ui/controls'
import { Modal, Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'
import { Markdown } from '../chat/Markdown'
import { connectionLabel } from '../../lib/sync'
import { useHostInfo, useTakeover, deviceName } from './hooks'
import { useBranchView } from '../../lib/useBranchView'
import { branchGroup } from '../../lib/branchView'
import { BranchSwitcher } from '../chat/BranchSwitcher'

// ---------------- indicador do host (barra do composer) ----------------

/**
 * Onde o chat executa, só como ícone na barra do composer (antes era o selo "Executando em
 * <dispositivo>" no cabeçalho + "controle remoto · <host>" no composer — redundante): remoto = ícone
 * roxo (ponto verde com o host online), local = ícone neutro deste dispositivo, sem conexão = nuvem
 * cortada, host offline = ícone apagado (no cartão "Executar neste dispositivo"). O tooltip leva o
 * nome; o clique abre o popover com as ações de antes (assumir, forçar, cancelar troca, fixar host).
 * Sem sync (sem conta / bloqueado), nada.
 */
export function HostIndicator({
  chat,
  className
}: {
  chat: Chat
  className?: string
}): React.JSX.Element | null {
  const info = useHostInfo(chat.id)
  const sync = useStore((s) => s.sync)
  const run = useStore((s) => s.run)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const { start, dialog } = useTakeover(chat)
  if (!info || info.mode === 'off' || !sync || sync.phase !== 'ready') return null
  const host = info.host
  const self = !!host?.self
  // chat só ao vivo (§23): sem troca de host, sem fixar — só o selo e o estado
  if (info.live) return <LiveIndicator chat={chat} className={className} />
  const label =
    info.mode === 'diverged'
      ? 'Divergente'
      : info.mode === 'offline'
        ? self || !host
          ? 'Offline'
          : `${host.name} · offline`
        : info.mode === 'host-offline'
          ? `${host?.name ?? 'Host'} offline`
          : `Executando em ${self ? deviceName() : (host?.name ?? deviceName())}`
  const tone =
    info.mode === 'diverged'
      ? 'text-danger hover:bg-danger/10'
      : info.mode === 'remote'
        ? 'text-accent-strong hover:bg-accent-soft'
        : info.mode === 'host-offline' || info.mode === 'offline'
          ? 'text-faint hover:bg-hover hover:text-subtle'
          : 'text-subtle hover:bg-hover hover:text-fg'
  const Icon =
    info.mode === 'diverged'
      ? GitFork
      : info.mode === 'offline'
        ? CloudOff
        : info.mode === 'remote' || info.mode === 'host-offline'
          ? MonitorSmartphone
          : Laptop
  const handoverToMe = info.handover?.self
  const fullLabel = handoverToMe ? `Aguardando ${host?.name ?? 'host'}` : label
  return (
    <>
      <Tip label={`${fullLabel} · clique para opções`}>
        <button
          ref={anchor}
          type="button"
          data-testid="host-indicator"
          data-mode={info.mode}
          aria-label={fullLabel}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          className={cn(
            'relative flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
            tone,
            open && 'bg-hover',
            className
          )}
        >
          <Icon className={cn('size-4', handoverToMe && 'animate-pulse-soft')} />
          {info.mode === 'remote' && host?.status === 'online' && (
            <span
              data-testid="host-online-dot"
              className="absolute top-1 right-1 size-1.5 animate-pulse-soft rounded-full bg-success ring-2 ring-surface"
            />
          )}
          {info.pinned && (
            <Lock className="absolute right-0.5 bottom-0.5 size-2.5 rounded-sm bg-surface opacity-80" />
          )}
        </button>
      </Tip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={330}>
        <div
          className="space-y-2.5 p-3 text-[12.5px]"
          data-testid="host-popover"
          onClick={(e) => e.stopPropagation()}
        >
          <div>
            <div className="flex items-center gap-2 font-medium text-fg">
              <Icon
                className={cn(
                  'size-3.5 shrink-0',
                  info.mode === 'remote' ? 'text-accent-strong' : 'text-subtle'
                )}
              />
              <span className="min-w-0 truncate" data-testid="host-popover-title">
                {info.mode === 'remote'
                  ? `Controle remoto de ${host?.name}`
                  : info.mode === 'host-offline'
                    ? `O host (${host?.name}) está offline`
                    : info.mode === 'diverged'
                      ? 'Versões divergentes'
                      : info.mode === 'offline'
                        ? 'Sem conexão com o servidor'
                        : `Executando em ${deviceName()}`}
              </span>
              {info.mode === 'remote' && host?.status === 'online' && (
                <span className="ml-auto shrink-0 text-[10.5px] font-normal text-success">
                  online
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-subtle">
              {info.mode === 'remote'
                ? 'As mensagens, ⚡, aprovações e respostas vão cifradas para o host, que executa o chat; as ferramentas agem na máquina dele. Você acompanha ao vivo.'
                : info.mode === 'host-offline'
                  ? 'Comandos remotos só funcionam com o host online. Você pode assumir o chat aqui.'
                  : info.mode === 'diverged'
                    ? 'Nada deste chat sincroniza até você escolher qual versão manter.'
                    : info.mode === 'offline'
                      ? 'Executar aqui funciona; o conteúdo é reconciliado quando a conexão voltar (pode virar uma versão divergente).'
                      : 'Os turnos rodam neste dispositivo; os outros dispositivos online são controles remotos.'}
            </p>
            {info.hostCwd && !self && (
              <p
                className="mt-1 truncate font-mono text-[11px] text-faint"
                title={info.hostCwd.path}
              >
                raiz no host: {info.hostCwd.path}
              </p>
            )}
          </div>
          {handoverToMe && (
            <div className="rounded-lg border border-border bg-bg/40 px-2.5 py-2 text-[12px] text-muted">
              Aguardando o fim do turno em {host?.name}…
              <div className="mt-1.5 flex gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Zap className="size-3" />}
                  onClick={() => start('force')}
                >
                  Forçar agora
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(() => api.sync.cancelHandover(chat.id), 'Falha ao cancelar')
                  }
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}
          {!self && !handoverToMe && (info.mode === 'remote' || info.mode === 'host-offline') && (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="primary"
                data-testid="host-takeover"
                onClick={() => {
                  setOpen(false)
                  start('next_turn')
                }}
              >
                {info.pinned
                  ? 'Executar neste dispositivo mesmo assim…'
                  : 'Executar neste dispositivo'}
              </Button>
              {info.mode === 'remote' && info.running && (
                <Button
                  size="sm"
                  icon={<Zap className="size-3" />}
                  onClick={() => {
                    setOpen(false)
                    start('force')
                  }}
                >
                  Forçar agora
                </Button>
              )}
            </div>
          )}
          {info.mode !== 'offline' && info.mode !== 'diverged' && host && (
            <button
              type="button"
              data-testid="host-pin"
              onClick={() =>
                void run(() => api.sync.setPinned(chat.id, !info.pinned), 'Falha ao fixar')
              }
              className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] text-muted hover:text-fg"
            >
              {info.pinned ? <Unlock className="size-3.5" /> : <Lock className="size-3.5" />}
              {info.pinned ? 'Desafixar host' : `Fixar host (${host.name})`}
              <span className="ml-auto text-[10.5px] text-faint">
                {info.pinned ? 'assumir pede confirmação' : 'evita trocas acidentais'}
              </span>
            </button>
          )}
        </div>
      </Popover>
      {dialog}
    </>
  )
}

/**
 * Indicador de chat só ao vivo (§23): no host, "Só ao vivo" (visível nos outros ou não); no
 * visualizador, "Ao vivo em <host>". Sem ações de host (a única cópia está no host, §23.9).
 */
function LiveIndicator({
  chat,
  className
}: {
  chat: Chat
  className?: string
}): React.JSX.Element | null {
  const info = useHostInfo(chat.id)
  const live = info?.live
  if (!info || !live) return null
  const viewer = live.role === 'viewer'
  const label = viewer
    ? live.status === 'online'
      ? `Ao vivo em ${live.hostName}`
      : `Reconectando a ${live.hostName}…`
    : live.unsupported
      ? 'Só neste dispositivo — o servidor não suporta chats ao vivo'
      : live.announced
        ? 'Só ao vivo: os outros dispositivos o veem enquanto este app estiver aberto'
        : 'Só ao vivo (ainda não visível nos outros dispositivos)'
  return (
    <Tip label={label}>
      <span
        data-testid="live-indicator"
        data-role={live.role}
        aria-label={label}
        className={cn(
          'relative flex size-7 shrink-0 items-center justify-center rounded-lg',
          viewer && live.status !== 'online'
            ? 'text-faint'
            : live.unsupported
              ? 'text-subtle'
              : 'text-accent-strong',
          className
        )}
      >
        <Radio className="size-4" />
        {(viewer ? live.status === 'online' : live.announced) && (
          <span className="absolute top-1 right-1 size-1.5 animate-pulse-soft rounded-full bg-success ring-2 ring-surface" />
        )}
      </span>
    </Tip>
  )
}

// ---------------- composer ----------------

/** Composer com host offline: só "Executar neste dispositivo" (§8.7). */
export function HostOfflineCard({ chat }: { chat: Chat }): React.JSX.Element {
  const info = useHostInfo(chat.id)
  const { start, dialog, busy } = useTakeover(chat)
  // chat só ao vivo de outro dispositivo em tolerância: só "reconectando…" (§8.7, §23.9)
  if (info?.live?.role === 'viewer')
    return (
      <div
        data-testid="live-reconnecting"
        className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)]"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-hover text-subtle">
          <Spinner className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">
            Reconectando a {info.live.hostName}…
          </div>
          <div className="text-[11.5px] text-subtle">
            Este chat é só ao vivo: fica só em {info.live.hostName} e volta quando ele reconectar.
          </div>
        </div>
      </div>
    )
  return (
    <div
      data-testid="host-offline"
      className="flex items-center gap-3 rounded-2xl border border-danger/25 bg-surface px-4 py-3.5 shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)]"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
        <CloudOff className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">
          O host ({info?.host?.name ?? 'outro dispositivo'}) está offline
        </div>
        <div className="text-[11.5px] text-subtle">
          Mensagens e comandos só chegam com ele online. Para continuar, execute o chat aqui.
        </div>
      </div>
      <HostIndicator chat={chat} />
      <Button
        variant="primary"
        loading={busy}
        onClick={() => start('next_turn')}
        data-testid="host-offline-takeover"
      >
        {info?.pinned ? 'Executar neste dispositivo mesmo assim…' : 'Executar neste dispositivo'}
      </Button>
      {dialog}
    </div>
  )
}

/** Linha acima do composer: controle remoto / offline / aviso do host (ex.: "caiu"). */
export function HostComposerLine({
  chat,
  sessionId
}: {
  chat: Chat
  sessionId: string
}): React.JSX.Element | null {
  const info = useHostInfo(chat.id)
  const sending = useStore((s) => s.remoteSending[sessionId])
  const notice = useStore((s) => s.chatNotices[chat.id])
  const dismiss = useStore((s) => s.dismissChatNotice)
  const showNotice = !!notice
  if (!info || info.mode === 'off') return null
  const items: React.JSX.Element[] = []
  if (showNotice)
    items.push(
      <div
        key="notice"
        data-testid="host-notice"
        className={cn(
          'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px]',
          notice.kind === 'error'
            ? 'border-danger/25 bg-danger/[0.07] text-danger'
            : notice.kind === 'success'
              ? 'border-success/25 bg-success/[0.07] text-success'
              : 'border-border bg-elevated/80 text-muted'
        )}
      >
        <CircleAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{notice.text}</span>
        <span className="text-[11px] opacity-70">{relativeTime(notice.at)}</span>
        <button
          type="button"
          onClick={() => dismiss(chat.id)}
          className="opacity-70 hover:opacity-100"
          aria-label="Dispensar"
        >
          <X className="size-3.5" />
        </button>
      </div>
    )
  if (sending)
    items.push(
      <div
        key="sending"
        data-testid="remote-sending"
        className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft/40 px-2.5 py-1.5 text-[12px] text-accent-strong"
      >
        <Spinner className="size-3" />
        <span className="min-w-0 flex-1 truncate">
          enviando para {info.host?.name ?? 'o host'}…{' '}
          <span className="text-muted">“{sending}”</span>
        </span>
      </div>
    )
  if (info.mode === 'offline' && info.live?.role === 'viewer')
    items.push(
      <div
        key="offline"
        className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-2.5 py-1.5 text-[12px] text-warning"
      >
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        Sem conexão com o servidor — este chat ao vivo volta quando reconectar.
      </div>
    )
  else if (info.mode === 'offline' && info.host && !info.host.self)
    items.push(
      <div
        key="offline"
        className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-2.5 py-1.5 text-[12px] text-warning"
      >
        <TriangleAlert className="mt-px size-3.5 shrink-0" />
        Sem conexão: este chat é executado em {info.host.name}. Enviar aqui roda neste dispositivo e
        pode criar uma versão divergente.
      </div>
    )
  if (!items.length) return null
  return (
    <div className="mb-2 space-y-1.5" data-stack-extra>
      {items}
    </div>
  )
}

/**
 * Aviso acima do composer: um dispositivo desta conta que pode ser host ainda está numa versão sem
 * versões de mensagens (< 0.7) — se ele executar um chat com versões, pode embaralhá-las.
 * Dispensável (volta na próxima vez que o app abrir).
 */
export function OutdatedHostsBanner(): React.JSX.Element | null {
  const hosts = useStore((s) => s.sync?.outdatedHosts)
  const dismissed = useStore((s) => s.outdatedHostsDismissed)
  const dismiss = useStore((s) => s.dismissOutdatedHosts)
  if (!hosts?.length || dismissed) return null
  const names = hosts.map((h) => `${h.name} (${h.appVersion})`)
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}` : names[0]
  return (
    <div
      data-testid="outdated-hosts"
      data-stack-extra
      className="mb-2 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-2.5 py-1.5 text-[12px] text-warning"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Atualize {list} para usar versões de mensagens com segurança
      </span>
      <button
        type="button"
        onClick={dismiss}
        className="opacity-70 hover:opacity-100"
        aria-label="Dispensar"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

// ---------------- divergência ----------------

const EMPTY_MSGS: DivergenceVersion['messages'][string] = []

function VersionView({
  ver,
  mainSessionId
}: {
  ver: DivergenceVersion
  mainSessionId: string
}): React.JSX.Element {
  const main =
    ver.sessions.find((s) => s.id === mainSessionId) ?? ver.sessions.find((s) => s.depth === 0)
  const all = main ? (ver.messages[main.id] ?? EMPTY_MSGS) : EMPTY_MSGS
  // versões: começa na seleção da versão; ‹ › troca só nesta tela (nada é gravado)
  const [sel, setSel] = useState<BranchSel | null>(null)
  const { tree, path: msgs, siblings } = useBranchView(main, all, sel)
  const subs = ver.sessions.filter((s) => s.depth > 0).length
  return (
    <div className="space-y-3">
      {msgs.length === 0 && <p className="text-[12.5px] text-subtle">Sem mensagens.</p>}
      {msgs.map((m) => {
        const info = siblings.get(m.id)
        const switcher = info ? (
          <BranchSwitcher
            info={info}
            group={branchGroup(tree, m.id)}
            local
            onSelect={(id) => setSel(selectionToReach(tree, sel ?? main?.branchSel, id))}
            className={m.message.role === 'user' ? 'self-end' : 'self-start'}
          />
        ) : null
        const text = messageText(m.message.content as never)
        const calls = m.message.role === 'assistant' ? (m.message.tool_calls ?? []) : []
        if (m.message.role === 'tool')
          return (
            <div
              key={m.id}
              className="rounded-lg border border-border/70 bg-bg/30 px-2.5 py-1.5 font-mono text-[11px] text-subtle"
            >
              resultado de ferramenta · {text.slice(0, 160)}
              {text.length > 160 ? '…' : ''}
            </div>
          )
        return (
          <div
            key={m.id}
            className={cn('flex flex-col', m.message.role === 'user' ? 'items-end' : 'items-start')}
          >
            <div
              className={cn(
                'max-w-[85%] rounded-2xl px-3.5 py-2 text-[13px]',
                m.message.role === 'user' ? 'bg-elevated text-fg' : 'text-fg/90'
              )}
            >
              {text && <Markdown text={text} />}
              {calls.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {calls.map((c) => (
                    <span
                      key={c.id}
                      className="rounded-md border border-border px-1.5 py-px font-mono text-[11px] text-subtle"
                    >
                      {c.function.name}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-0.5 text-[10.5px] text-faint">
                {new Date(m.createdAt).toLocaleString('pt-BR')}
              </div>
            </div>
            {switcher}
          </div>
        )
      })}
      {subs > 0 && <p className="text-[11px] text-subtle">+ {subs} subsessão(ões)</p>}
    </div>
  )
}

/** Chat divergente: as duas versões navegáveis + escolha (a outra é APAGADA, com aviso). */
export function DivergencePanel({ chat }: { chat: Chat }): React.JSX.Element {
  const info = useHostInfo(chat.id)
  const [det, setDet] = useState<DivergenceDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'online' | 'local'>('local')
  const [confirm, setConfirm] = useState<'online' | 'local' | null>(null)
  const [busy, setBusy] = useState(false)
  const d = info?.diverged
  const self = !!d?.self

  useEffect(() => {
    let alive = true
    api.sync
      .divergence(chat.id)
      .then((r) => alive && setDet(r))
      .catch((e) => alive && setError(errorMessage(e)))
    return () => {
      alive = false
    }
  }, [chat.id, d?.divergenceId])

  const current = self ? tab : 'online'
  const lost = confirm === 'local' ? det?.onlyOnline : det?.onlyLocal
  const lostText = (): string => {
    const n = confirm === 'online' && !self ? null : (lost?.count ?? 0)
    if (n === null)
      return `A versão de ${d?.deviceName ?? 'outro dispositivo'} será apagada. Mensagens que só existem nela serão perdidas e não poderão ser recuperadas.`
    return `A outra versão será apagada. Mensagens que só existem nela (${n} mensage${n === 1 ? 'm' : 'ns'}${
      lost?.since ? ` desde ${new Date(lost.since).toLocaleString('pt-BR')}` : ''
    }) serão perdidas e não poderão ser recuperadas.`
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="divergence-panel">
      <div className="shrink-0 border-b border-danger/20 bg-danger/[0.05] px-8 py-3">
        <div className="mx-auto flex max-w-[960px] items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <GitFork className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13.5px] font-semibold">
              Este chat está divergente
              <span className="rounded-full border border-danger/30 px-1.5 py-px text-[10.5px] font-normal text-danger">
                divergente
              </span>
            </div>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
              {self
                ? 'Duas histórias foram produzidas sem uma ver a outra (ex.: este dispositivo rodou offline). Nada deste chat sincroniza até você escolher qual versão vira a online.'
                : `Divergente — resolva em ${d?.deviceName ?? 'outro dispositivo'}, que tem a outra versão. Ou descarte a versão dele e mantenha a online.`}
            </p>
          </div>
        </div>
        {self && (
          <div className="mx-auto mt-3 flex max-w-[960px] gap-1 border-b border-border">
            {(
              [
                ['online', 'Versão online', det?.onlyOnline.count],
                ['local', 'Versão deste dispositivo', det?.onlyLocal.count]
              ] as const
            ).map(([id, label, n]) => (
              <button
                key={id}
                type="button"
                data-testid={`divergence-tab-${id}`}
                onClick={() => setTab(id)}
                className={cn(
                  '-mb-px border-b-2 px-2.5 pb-2 text-[12.5px] transition-colors',
                  tab === id
                    ? 'border-accent text-fg'
                    : 'border-transparent text-subtle hover:text-fg'
                )}
              >
                {label}
                {n ? (
                  <span className="ml-1.5 rounded-full bg-hover px-1.5 text-[10.5px]">
                    {n} só nela
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-5">
        <div className="mx-auto max-w-[960px]">
          {error ? (
            <p className="text-[12.5px] text-danger">{error}</p>
          ) : !det ? (
            <Spinner className="size-4" />
          ) : current === 'local' && det.local ? (
            <VersionView key="local" ver={det.local} mainSessionId={chat.mainSessionId} />
          ) : (
            <VersionView key="online" ver={det.online} mainSessionId={chat.mainSessionId} />
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-border bg-surface/80 px-8 py-3">
        <div className="mx-auto flex max-w-[960px] items-center gap-2">
          <span className="text-[12px] text-subtle">
            {self
              ? `Vendo: ${current === 'local' ? 'versão deste dispositivo' : 'versão online'}`
              : 'Vendo: versão online'}
          </span>
          {self ? (
            <Button
              variant="primary"
              className="ml-auto"
              data-testid="divergence-keep"
              disabled={!det}
              onClick={() => setConfirm(current)}
            >
              Manter esta como a versão online
            </Button>
          ) : (
            <Button
              variant="danger"
              className="ml-auto"
              data-testid="divergence-discard"
              onClick={() => setConfirm('online')}
            >
              Descartar a versão de {d?.deviceName ?? 'outro dispositivo'}
            </Button>
          )}
        </div>
      </div>
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Apagar a outra versão?"
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={busy}
              data-testid="divergence-confirm"
              onClick={() => {
                if (!confirm) return
                setBusy(true)
                void api.sync
                  .resolveDivergence(chat.id, confirm)
                  .then(() => {
                    setConfirm(null)
                    useStore.getState().toast('Divergência resolvida.', 'success')
                    const v = useStore.getState().view
                    if (v.kind === 'chat') void useStore.getState().loadMessages(v.sessionId, true)
                  })
                  .catch((e) => setError(errorMessage(e)))
                  .finally(() => setBusy(false))
              }}
            >
              Apagar a outra versão e manter esta
            </Button>
          </>
        }
      >
        <p
          className="flex items-start gap-2.5 text-[12.5px] leading-relaxed text-muted"
          data-testid="divergence-warning"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          {lostText()}
        </p>
      </Modal>
    </div>
  )
}

// ---------------- perguntas do sync / indicador ----------------

export function SyncPrompts(): React.JSX.Element | null {
  const prompts = useStore((s) => s.sync?.prompts ?? [])
  const run = useStore((s) => s.run)
  const p = prompts[0]
  if (!p) return null
  const answer = (keep: boolean): void =>
    void run(() => api.sync.answerPrompt(p.chatId, keep), 'Falha ao responder')
  return (
    <Modal
      open
      onClose={() => undefined}
      title="Chat apagado em outro dispositivo"
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(false)}>
            Descartar
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            Manter como novo chat
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-muted">
        “{p.title}” foi apagado em outro dispositivo e você tem mensagens não sincronizadas nele.
      </p>
    </Modal>
  )
}

/** Indicador do sync na barra lateral (abre Configurações → Conta). */
export function SyncIndicator(): React.JSX.Element | null {
  const sync = useStore((s) => s.sync)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  if (!sync || sync.phase === 'signed-out') return null
  const c = connectionLabel(sync)
  const Icon = c.tone === 'off' || c.tone === 'err' ? CloudOff : Cloud
  return (
    <Tip
      side="bottom"
      label={
        <span>
          {c.text}
          {sync.account ? ` · ${sync.account.email}` : ''}
          {sync.lastSyncAt ? ` · ${relativeTime(sync.lastSyncAt)}` : ''}
        </span>
      }
    >
      <button
        type="button"
        data-testid="sync-indicator"
        onClick={() => setSettingsOpen(true, 'account')}
        className={cn(
          'no-drag ml-auto flex size-7 items-center justify-center rounded-lg transition-colors hover:bg-hover',
          c.tone === 'err'
            ? 'text-danger'
            : c.tone === 'busy'
              ? 'text-accent-strong'
              : c.tone === 'ok'
                ? 'text-muted'
                : 'text-faint'
        )}
        aria-label={`Sync: ${c.text}`}
      >
        <Icon className={cn('size-4', c.tone === 'busy' && 'animate-pulse-soft')} />
      </button>
    </Tip>
  )
}
