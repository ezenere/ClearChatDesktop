// Configurações → Pesquisa na web: buscadores do web_search (ordem = prioridade, arrastar ou ↑/↓,
// liga/desliga, chave de API mascarada, opções, "Testar") e o intervalo mínimo GLOBAL entre
// pesquisas (setting `webSearchMinIntervalSec`, lido pelo main a cada pesquisa).
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  Clock,
  ExternalLink,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WebSearchEngineState, WebSearchTestResult } from '@shared/ipc'
import {
  describeEngineRequest,
  ENGINE_DEFAULT_BASE,
  ENGINE_META,
  isApiEngine,
  moveEngine,
  normalizeSearchInterval,
  SEARCH_INTERVAL_DEFAULT_S,
  SEARCH_INTERVAL_MAX_S,
  SEARCH_INTERVAL_SETTING,
  SEARCH_RESULTS_MAX,
  SEARCH_RESULTS_MIN,
  type EngineConfig,
  type EngineOptions,
  type SearchEngineId,
  type TavilyDepth
} from '@shared/webSearchSettings'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Button, IconButton, Label, Switch } from '../ui/controls'
import { Select } from '../ui/Select'
import { ApiInfo, C, HelpTip, Tip } from '../ui/Tooltip'

const NEED_KEY_HINT = 'Informe a chave de API para habilitar'

const toConfig = (e: WebSearchEngineState): EngineConfig => ({
  id: e.id,
  enabled: e.enabled,
  options: e.options
})

export function WebSearchSettings(): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [engines, setEngines] = useState<WebSearchEngineState[] | null>(null)
  const [dragId, setDragId] = useState<SearchEngineId | null>(null)
  const [overId, setOverId] = useState<SearchEngineId | null>(null)

  useEffect(() => {
    let alive = true
    void api.webSearch.getSettings().then((s) => alive && setEngines(s.engines))
    return () => {
      alive = false
    }
  }, [])

  /** Salva a lista inteira (otimista; em erro volta ao estado do main). */
  const save = async (next: WebSearchEngineState[]): Promise<void> => {
    const prev = engines
    setEngines(next)
    const r = await run(() => api.webSearch.updateEngines(next.map(toConfig)))
    if (r) setEngines(r.engines)
    else if (prev) setEngines(prev)
  }
  const patch = (id: SearchEngineId, p: Partial<EngineConfig>): void => {
    if (!engines) return
    void save(engines.map((e) => (e.id === id ? { ...e, ...p } : e)))
  }
  const move = (from: number, to: number): void => {
    if (engines) void save(moveEngine(engines, from, to))
  }

  const enabledCount = engines?.filter((e) => e.enabled).length ?? 0
  const firstEnabled = engines?.find((e) => e.enabled)?.id

  return (
    <div className="space-y-6" data-testid="web-search-settings">
      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">Buscadores</span>
          <HelpTip label="Buscadores" className="self-center">
            Cada pesquisa usa <strong className="text-fg/80">um buscador só</strong>: o primeiro
            habilitado da lista. Se ele falhar (sem chave ou chave inválida, limite de uso/cota,
            captcha/bloqueio, erro de rede ou resposta vazia), a mesma pesquisa passa para o próximo
            habilitado — os resultados nunca são misturados, e a 1ª linha do resultado diz qual
            buscador respondeu e qual falhou antes. Arraste pela alça ou use ↑/↓ para mudar a ordem.
          </HelpTip>
          <span className="text-[11px] text-subtle">
            {engines ? `${enabledCount} habilitado${enabledCount === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        {!engines ? (
          <div className="h-40 animate-pulse rounded-xl border border-border bg-elevated/30" />
        ) : (
          <ol className="space-y-2" data-testid="web-engines">
            {engines.map((e, i) => (
              <EngineRow
                key={e.id}
                engine={e}
                index={i}
                count={engines.length}
                primary={e.id === firstEnabled}
                dragging={dragId === e.id}
                dropTarget={overId === e.id && dragId !== null && dragId !== e.id}
                onToggle={(v) => patch(e.id, { enabled: v })}
                onOptions={(o) => patch(e.id, { options: { ...e.options, ...o } })}
                onMove={(d) => move(i, i + d)}
                onState={(s) => setEngines(s)}
                onDragStart={() => setDragId(e.id)}
                onDragEnd={() => {
                  setDragId(null)
                  setOverId(null)
                }}
                onDragOver={() => setOverId(e.id)}
                onDrop={() => {
                  if (dragId)
                    move(
                      engines.findIndex((x) => x.id === dragId),
                      i
                    )
                  setDragId(null)
                  setOverId(null)
                }}
              />
            ))}
          </ol>
        )}
        {engines && enabledCount === 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
            <CircleAlert className="size-3.5" /> Nenhum buscador habilitado: o web_search vai
            retornar erro.
          </p>
        )}
      </section>

      <IntervalField />
    </div>
  )
}

function EngineRow({
  engine: e,
  index,
  count,
  primary,
  dragging,
  dropTarget,
  onToggle,
  onOptions,
  onMove,
  onState,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop
}: {
  engine: WebSearchEngineState
  index: number
  count: number
  primary: boolean
  dragging: boolean
  dropTarget: boolean
  onToggle: (v: boolean) => void
  onOptions: (o: EngineOptions) => void
  onMove: (delta: -1 | 1) => void
  onState: (engines: WebSearchEngineState[]) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: () => void
  onDrop: () => void
}): React.JSX.Element {
  const meta = ENGINE_META[e.id]
  const needsKey = meta.needsKey
  const canEnable = !needsKey || e.hasKey
  const [armed, setArmed] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<WebSearchTestResult | null>(null)
  const run = useStore((s) => s.run)

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTest(null)
    const r = await run(() => api.webSearch.test(e.id))
    setTesting(false)
    if (r) setTest(r)
  }

  return (
    <li
      data-testid={`engine-${e.id}`}
      data-enabled={e.enabled ? 'true' : 'false'}
      draggable={armed}
      onDragStart={(ev) => {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData('text/plain', e.id)
        onDragStart()
      }}
      onDragEnd={() => {
        setArmed(false)
        onDragEnd()
      }}
      onDragOver={(ev) => {
        ev.preventDefault()
        ev.dataTransfer.dropEffect = 'move'
        onDragOver()
      }}
      onDrop={(ev) => {
        ev.preventDefault()
        setArmed(false)
        onDrop()
      }}
      className={cn(
        'rounded-xl border bg-elevated/40 transition-[border-color,opacity,box-shadow] duration-100',
        e.enabled ? 'border-border' : 'border-border/60',
        dragging && 'opacity-40',
        dropTarget && 'border-accent shadow-[0_0_0_1px_var(--color-accent)]'
      )}
    >
      <div className="flex items-center gap-2 py-2.5 pr-3 pl-1.5">
        <span
          aria-hidden
          title="Arraste para reordenar"
          onPointerDown={() => setArmed(true)}
          onPointerUp={() => setArmed(false)}
          className="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center rounded text-faint hover:text-muted active:cursor-grabbing"
          data-testid={`engine-handle-${e.id}`}
        >
          <GripVertical className="size-4" />
        </span>
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-md font-mono text-[11px] tabular-nums',
            primary ? 'bg-accent/20 text-accent-strong' : 'bg-white/[0.05] text-subtle'
          )}
        >
          {index + 1}
        </span>
        <div className={cn('min-w-0 flex-1', !e.enabled && 'opacity-70')}>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="text-[13px] font-medium text-fg/90">{meta.label}</span>
            <EngineInfo engine={e} />
            <Tip label={`Abrir ${meta.docs ? 'a documentação' : 'o site'}`}>
              <a
                href={meta.docs ?? meta.site}
                target="_blank"
                rel="noreferrer"
                aria-label={`Site do ${meta.label}`}
                className="inline-flex size-4 items-center justify-center rounded text-faint hover:text-accent-strong"
              >
                <ExternalLink className="size-3" />
              </a>
            </Tip>
            <span
              className={cn(
                'rounded-full border px-1.5 py-px text-[10px] leading-4',
                !needsKey
                  ? 'border-border text-subtle'
                  : e.hasKey
                    ? 'border-success/30 text-success'
                    : 'border-warning/30 text-warning'
              )}
            >
              {!needsKey ? 'sem chave' : e.hasKey ? 'chave salva' : 'requer chave'}
            </span>
            {primary && (
              <span className="text-[10.5px] font-medium text-accent-strong">principal</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-subtle" title={meta.description}>
            {meta.description}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton
            size="sm"
            label="Subir"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label={`Subir ${meta.label}`}
          >
            <ArrowUp />
          </IconButton>
          <IconButton
            size="sm"
            label="Descer"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            aria-label={`Descer ${meta.label}`}
          >
            <ArrowDown />
          </IconButton>
        </div>
        <Button
          size="sm"
          variant="secondary"
          loading={testing}
          disabled={!canEnable}
          onClick={() => void runTest()}
          aria-label={`Testar ${meta.label}`}
        >
          Testar
        </Button>
        <Tip label={canEnable ? (e.enabled ? 'Desabilitar' : 'Habilitar') : NEED_KEY_HINT}>
          <span className="inline-flex">
            <Switch
              checked={e.enabled}
              disabled={!canEnable}
              onChange={onToggle}
              label={`Habilitar ${meta.label}`}
            />
          </span>
        </Tip>
      </div>

      {test && (
        <div
          data-testid={`engine-test-${e.id}`}
          className={cn(
            'mx-3 mb-2.5 flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px]',
            test.ok
              ? 'border-success/20 bg-success/[0.06] text-success'
              : test.throttled
                ? 'border-border bg-white/[0.03] text-muted'
                : 'border-danger/25 bg-danger/[0.06] text-danger'
          )}
        >
          {test.ok ? (
            <CircleCheck className="mt-px size-3.5 shrink-0" />
          ) : test.throttled ? (
            <Clock className="mt-px size-3.5 shrink-0" />
          ) : (
            <CircleAlert className="mt-px size-3.5 shrink-0" />
          )}
          <span className="min-w-0 break-words">
            {test.ok
              ? `Funcionou: ${test.message}`
              : test.throttled
                ? test.message
                : `Erro: ${test.message}`}
          </span>
        </div>
      )}

      {needsKey && (
        <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2 border-t border-border/50 px-3 py-2.5 pl-[37px]">
          <div className="min-w-0">
            <Label>Chave de API</Label>
            <KeyField engine={e} onState={onState} />
            {!e.hasKey && (
              <p className="mt-1.5 flex items-center gap-1 text-[11px] text-warning">
                <KeyRound className="size-3" /> {NEED_KEY_HINT}.
              </p>
            )}
          </div>
          <div className="flex items-start gap-3">
            <div>
              <Label>Resultados</Label>
              <NumberField
                value={e.options.maxResults ?? 8}
                min={SEARCH_RESULTS_MIN}
                max={SEARCH_RESULTS_MAX}
                label={`Resultados (${meta.label})`}
                onCommit={(n) => onOptions({ maxResults: n })}
              />
            </div>
            {e.id === 'tavily' && (
              <div>
                <Label>Profundidade</Label>
                <Select<TavilyDepth>
                  value={e.options.depth ?? 'advanced'}
                  label="Profundidade (Tavily)"
                  className="h-8 w-[118px]"
                  menuMinWidth={260}
                  onChange={(depth) => onOptions({ depth })}
                  options={[
                    {
                      value: 'advanced',
                      label: 'advanced',
                      description: 'Trechos mais relevantes (2 créditos)'
                    },
                    { value: 'basic', label: 'basic', description: 'Mais rápido (1 crédito)' }
                  ]}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

/** (i): exatamente o que vai para o buscador (sem o valor da chave). */
function EngineInfo({ engine: e }: { engine: WebSearchEngineState }): React.JSX.Element {
  const meta = ENGINE_META[e.id]
  if (isApiEngine(e.id))
    return (
      <ApiInfo
        title={`${meta.label}: request de cada pesquisa`}
        code={describeEngineRequest(e.id, e.options)}
        codeLabel="Request (a chave salva entra no lugar de {sua chave}; {consulta} = query do web_search)"
      >
        <p>
          Só a consulta do <C>web_search</C> e as opções abaixo saem do app. A chave fica no banco
          local e vai apenas no header mostrado — a tela recebe só a máscara.
        </p>
        <p>A resposta é resumida em título, URL, data e trecho de cada resultado.</p>
      </ApiInfo>
    )
  if (e.id === 'ddg')
    return (
      <ApiInfo title="DuckDuckGo (sem chave)">
        <p>
          <C>POST {ENGINE_DEFAULT_BASE.ddg}</C> com o formulário <C>q={'{consulta}'}</C>, headers{' '}
          <C>User-Agent</C> (Firefox), <C>Referer</C> e <C>Accept-Language: pt-BR</C>. Se não vier
          resultado, repete com <C>GET …/html/?q={'{consulta}'}</C>.
        </p>
        <p>O HTML devolvido é lido localmente (título, URL e trecho; anúncios ficam de fora).</p>
      </ApiInfo>
    )
  return (
    <ApiInfo title="Brave (site) — sem chave">
      <p>
        Abre{' '}
        <C>
          GET {ENGINE_DEFAULT_BASE['brave-site']}?q={'{consulta}'}
        </C>{' '}
        numa janela oculta (sessão em memória, sem imagens, User-Agent do Chromium sem “Electron”,
        timeout 20 s) — a página bloqueia requisições diretas.
      </p>
      <p>O HTML renderizado é lido localmente (só os resultados orgânicos).</p>
    </ApiInfo>
  )
}

/** Campo da chave: mostra a máscara; digitar troca, olho revela (busca no main), X remove. */
function KeyField({
  engine: e,
  onState
}: {
  engine: WebSearchEngineState
  onState: (engines: WebSearchEngineState[]) => void
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const meta = ENGINE_META[e.id]
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const dirty = value.trim() !== '' && value.trim() !== revealed

  const saveKey = async (key: string | null): Promise<void> => {
    const r = await run(() => api.webSearch.setKey(e.id, key))
    if (!r) return
    onState(r.engines)
    setValue('')
    setRevealed(null)
    setShow(false)
  }
  const toggleShow = async (): Promise<void> => {
    if (show) {
      setShow(false)
      if (value === revealed) {
        setValue('')
        setRevealed(null)
      }
      return
    }
    if (!value && e.hasKey) {
      const k = await run(() => api.webSearch.revealKey(e.id))
      if (k) {
        setValue(k)
        setRevealed(k)
      }
    }
    setShow(true)
  }

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={`Chave de API (${meta.label})`}
          placeholder={
            e.hasKey ? `${e.keyMask} — digite para trocar` : `Cole a chave (${meta.keyHint})`
          }
          onChange={(ev) => setValue(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && dirty) void saveKey(value)
            if (ev.key === 'Escape' && value) {
              ev.stopPropagation()
              setValue('')
              setRevealed(null)
              setShow(false)
            }
          }}
          className="field h-8 py-0 pr-9 font-mono text-[12px] placeholder:font-mono"
        />
        <button
          type="button"
          onClick={() => void toggleShow()}
          disabled={!e.hasKey && !value}
          aria-label={show ? 'Ocultar chave' : 'Mostrar chave'}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-subtle hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>
      {dirty && (
        <Button size="sm" variant="primary" onClick={() => void saveKey(value)}>
          Salvar
        </Button>
      )}
      {e.hasKey && !dirty && (
        <IconButton
          size="sm"
          label="Remover chave"
          aria-label={`Remover chave (${meta.label})`}
          onClick={() => void saveKey(null)}
        >
          <X />
        </IconButton>
      )}
    </div>
  )
}

function NumberField({
  value,
  min,
  max,
  label,
  onCommit
}: {
  value: number
  min: number
  max: number
  label: string
  onCommit: (n: number) => void
}): React.JSX.Element {
  // rascunho só enquanto edita; fora disso mostra o valor salvo
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? String(value)
  const commit = (): void => {
    const n = Math.round(Number(text))
    const v = Number.isFinite(n) && text.trim() ? Math.min(max, Math.max(min, n)) : value
    setDraft(null)
    if (v !== value) onCommit(v)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      value={text}
      aria-label={label}
      onChange={(ev) => setDraft(ev.target.value)}
      onBlur={commit}
      onKeyDown={(ev) => ev.key === 'Enter' && commit()}
      className="field h-8 w-[64px] px-2 py-0 text-right font-mono text-[12.5px] tabular-nums"
    />
  )
}

function IntervalField(): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    void api.settings
      .get(SEARCH_INTERVAL_SETTING)
      .then((v) => alive && setText(String(normalizeSearchInterval(v))))
    return () => {
      alive = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const save = (raw: string, now = false): void => {
    if (timer.current) clearTimeout(timer.current)
    if (!raw.trim()) return
    const go = (): void =>
      void run(() => api.settings.set(SEARCH_INTERVAL_SETTING, normalizeSearchInterval(raw)))
    if (now) go()
    else timer.current = setTimeout(go, 400)
  }

  return (
    <section className="settings-section settings-divided">
      <Label
        help={
          <>
            Vale para todas as chamadas de <span className="font-mono">web_search</span> de qualquer
            chat, sessão ou subagente, qualquer que seja o buscador: uma pesquisa que chega antes do
            intervalo espera o restante, e pesquisas simultâneas saem uma de cada vez. Cada pesquisa
            conta uma vez só — se o primeiro buscador falhar, o próximo é tentado na hora, sem
            esperar de novo. O botão Testar não entra no intervalo. Espaçar as buscas evita o
            bloqueio anti-robô do DuckDuckGo e do Brave (site).
            <br />0 = desligado · máx. {SEARCH_INTERVAL_MAX_S} s · padrão{' '}
            {SEARCH_INTERVAL_DEFAULT_S} s.
          </>
        }
      >
        Intervalo mínimo entre pesquisas (s)
      </Label>
      <input
        type="number"
        min={0}
        max={SEARCH_INTERVAL_MAX_S}
        step={1}
        value={text}
        aria-label="Intervalo mínimo entre pesquisas (s)"
        onChange={(e) => {
          setText(e.target.value)
          save(e.target.value)
        }}
        onBlur={() => {
          const v = text.trim() ? normalizeSearchInterval(text) : SEARCH_INTERVAL_DEFAULT_S
          setText(String(v))
          save(String(v), true)
        }}
        className="field h-8 w-[110px] px-2 py-0 text-right font-mono text-[12.5px] tabular-nums"
      />
    </section>
  )
}
