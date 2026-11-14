// Peças compartilhadas das seções de Transcrição (STT) e Fala (TTS) de Configurações → Áudio:
// seletor ÚNICO de MODELO = o mesmo do chat (`ModelPicker`: um grupo por provedor cadastrado que
// serve a capacidade + "Local (CPU)"/"Local (GPU)" quando há modelo local instalado; latência
// medida/pt-BR à direita), seletor de VOZ no mesmo desenho (busca, grupos, ▶ prévia por linha), a
// lista de modelos locais (sub-tela "Modelos locais") e avisos. A chave real nunca vem ao renderer
// (o main lista e sintetiza com ela).
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  Download,
  LoaderCircle,
  Play,
  Search,
  Settings2,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { VoiceModelInfo } from '@shared/ipc'
import type { ModelInfo } from '@shared/types'
import {
  callTtsWarning,
  formatLatency,
  resolveModelAlias,
  type VoiceCapability,
  type VoiceCatalogModel,
  type VoiceCatalogVoice,
  type VoiceProviderSupport
} from '@shared/voiceCatalog'
import type { ModelRef } from '@shared/models'
import { cn } from '../../lib/format'
import type { PickerModels } from '../../lib/modelPicker'
import type { VoiceCatalogs } from '../../lib/voice/useVoiceCatalogs'
import { voiceProvidersFor, type ProviderOption } from '../../lib/voice/voiceSettingsHelpers'
import { isLocalGroup, type LocalModelGroup } from '../../lib/voice/voiceModelOptions'
import {
  formatModelLanguages,
  formatModelSize,
  modelAction,
  type LocalModelAction
} from '../../lib/voice/modelList'
import { useStore } from '../../store'
import { Chip } from '../ui/Chip'
import { Button, IconButton, Label } from '../ui/controls'
import { Popover } from '../ui/layers'
import { ModelPicker, type ModelPickerSource } from '../ui/ModelPicker'
import { WarnNote } from './audioUi'

const FAMILY_LABEL: Record<VoiceProviderSupport, string> = {
  openrouter: 'OpenRouter',
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI-compatível'
}

// ---------------- modelo ----------------

const correctionNote = (from: string, to: string): string =>
  `Modelo corrigido: “${from}” → “${to}” (o id que este provedor usa).`

/** Badge de latência medida ("~0,5 s") / "lento" (meta à direita da linha do modelo). */
function ModelLatencyBadge({ m }: { m: VoiceCatalogModel }): React.JSX.Element | null {
  if (m.latencyMs == null && !m.slow) return null
  return (
    <span
      className={cn(
        'inline-block rounded-full border px-1.5 py-px text-[10px] leading-4 tabular-nums',
        m.slow ? 'border-warning/30 text-warning' : 'border-success/30 text-success'
      )}
      data-testid={`model-latency-${m.id}`}
      title={
        m.slow
          ? 'Lento para a chamada de voz (medido)'
          : 'Tempo medido até o 1º áudio de uma frase curta em pt-BR'
      }
    >
      {m.slow ? 'lento' : ''}
      {m.slow && m.latencyMs != null ? ' · ' : ''}
      {m.latencyMs != null ? formatLatency(m.latencyMs) : ''}
    </span>
  )
}

/**
 * Modelo de STT/TTS no MESMO seletor do chat (`ModelPicker`) — o ÚNICO seletor da seção (sem
 * "Provedor" à parte): um grupo por provedor de voz cadastrado + "Local (CPU)" e "Local (GPU)"
 * (`localGroups` — só existem com modelo local instalado). Escolher uma linha define tudo de uma
 * vez (o chamador grava modo/backend + provedor + motor + modelo). Busca "em todos os provedores ou
 * digitar um ID" (ID livre só nos provedores), latência medida e pt-BR à direita. Lista CURADA
 * (TTS no OpenRouter/ElevenLabs): só os modelos medidos para a chamada; um id livre é aceito com o
 * aviso "não testado para chamada"; um salvo lento mostra a troca de um clique. Id fora da lista
 * com UM equivalente óbvio é corrigido sozinho (nota visível).
 */
export function VoiceModelField({
  capability,
  catalogs,
  providers,
  value,
  onChange,
  testId,
  family = null,
  recommended,
  localGroups = [],
  help,
  chips
}: {
  /** Ajuda estática do campo (o (?) do rótulo "Modelo"; a origem da lista entra junto). */
  help?: ReactNode
  /** Chips com fatos do modelo escolhido (tags, transporte…) à direita do rótulo. */
  chips?: ReactNode
  capability: VoiceCapability
  catalogs: VoiceCatalogs
  /** Provedores cadastrados (filtrados pela capacidade aqui). */
  providers: ProviderOption[]
  /** Seleção atual (providerId = provedor ou grupo local; null = nada escolhido). */
  value: { providerId: string | null; model: string }
  onChange: (ref: ModelRef) => void
  testId: string
  family?: VoiceProviderSupport | null
  recommended?: { label: string; onUse: () => void }
  /** Grupos "Local (CPU)"/"Local (GPU)" (vazios já filtrados — sem instalado, nenhum grupo). */
  localGroups?: LocalModelGroup[]
}): React.JSX.Element {
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const usable = useMemo(() => voiceProvidersFor(providers, capability), [providers, capability])
  const { entries, load } = catalogs
  const local = isLocalGroup(value.providerId)
  const state = catalogs.stateFor(local ? null : value.providerId)
  const catalog = state.catalog
  const what = capability === 'stt' ? 'transcrição' : 'fala'

  // fonte do seletor: um grupo por provedor de voz (listas do catálogo, memoizadas)
  const byKey = useMemo(() => {
    const m = new Map<string, VoiceCatalogModel>()
    for (const [pid, e] of Object.entries(entries))
      for (const x of e?.catalog?.models ?? []) m.set(`${pid}\u0000${x.id}`, x)
    return m
  }, [entries])
  const localByKey = useMemo(() => {
    const m = new Map<string, LocalModelGroup['options'][number]>()
    for (const g of localGroups) for (const o of g.options) m.set(`${g.id}\u0000${o.id}`, o)
    return m
  }, [localGroups])
  const source = useMemo<ModelPickerSource>(() => {
    const models: Record<string, PickerModels | undefined> = {}
    for (const p of usable) {
      const e = entries[p.id]
      if (!e) continue
      const list: ModelInfo[] = (e.catalog?.models ?? []).map((x) => ({ id: x.id, name: x.label }))
      models[p.id] = {
        status:
          e.status === 'loading' && !list.length
            ? 'loading'
            : e.status === 'error'
              ? 'error'
              : 'ok',
        list,
        ...(e.error || e.catalog?.error ? { error: e.error ?? e.catalog?.error ?? undefined } : {})
      }
    }
    for (const g of localGroups)
      models[g.id] = {
        status: 'ok',
        list: g.options.map((o) => ({ id: o.id, name: o.name }))
      }
    // provedor cuja listagem já voltou vazia (ex.: LM Studio/Groq sem modelos de fala) não vira
    // grupo — só polui; o escolhido no momento sempre aparece
    const shown = usable.filter((p) => {
      const m = models[p.id]
      return p.id === value.providerId || !m || m.status !== 'ok' || m.list.length > 0
    })
    return {
      providers: [
        ...shown.map((p) => ({ id: p.id, name: p.name })),
        ...localGroups.map((g) => ({ id: g.id, name: g.name, noFreeId: true }))
      ],
      models,
      // os grupos locais não têm listagem remota
      load: (id: string, force?: boolean) => {
        if (!isLocalGroup(id)) load(id, force)
      }
    }
  }, [usable, entries, load, localGroups, value.providerId])

  const models = useMemo(() => (local ? [] : (catalog?.models ?? [])), [catalog, local])
  const ids = useMemo(() => models.map((m) => m.id), [models])
  const curated = !local && !!catalog?.curated
  const allIds = useMemo(
    () => (local ? [] : [...ids, ...(catalog?.hiddenModels ?? []).map((m) => m.id)]),
    [ids, catalog, local]
  )
  const [note, setNote] = useState<string | null>(null)
  const cur = value.model.trim()
  const inList = ids.includes(cur)
  const fix = cur && allIds.length && !inList ? resolveModelAlias(cur, allIds) : null
  const fixTo = fix?.corrected ? fix.id : null
  const hiddenSaved = curated && !!fix && !fix.corrected
  const slowWarning = hiddenSaved
    ? (callTtsWarning(family, cur) ?? 'Modelo lento para chamada — escolha um da lista.')
    : null
  if (fixTo && note !== correctionNote(cur, fixTo)) setNote(correctionNote(cur, fixTo))
  const pid = value.providerId
  useEffect(() => {
    if (fixTo && pid) onChange({ providerId: pid, model: fixTo })
  }, [fixTo, pid, onChange])
  const unknown = !!cur && ids.length > 0 && !inList && !fix && !curated
  const untested = curated && !!cur && !inList && !fix
  const fail = local ? null : (state.error ?? catalog?.error ?? null)
  const localSel = local ? localByKey.get(`${pid}\u0000${cur}`) : undefined

  // de onde vem a lista (fato estático da fonte) → dentro do (?) do campo, não uma linha à vista
  const listFact =
    !state.loading && catalog && models.length > 0
      ? `${models.length} modelos${
          catalog.source === 'static'
            ? ' (lista embutida)'
            : catalog.source !== 'none'
              ? ` listados pelo ${FAMILY_LABEL[catalog.source]}`
              : ''
        }${curated ? ' · só os testados para a chamada' : ''}.`
      : null
  const listHint = catalog?.hint && !state.loading ? catalog.hint : null
  return (
    <div>
      <Label
        help={
          help || listFact || listHint ? (
            <>
              {help && <p>{help}</p>}
              {listFact && <p data-testid="voice-catalog-count">{listFact}</p>}
              {listHint && <p data-testid="voice-catalog-hint">{listHint}</p>}
              {!usable.length && (
                <p>
                  Provedores que servem {what}: OpenRouter, OpenAI, Groq
                  {capability === 'tts' ? ', ElevenLabs' : ''} ou um servidor local
                  OpenAI-compatível (Configurações → Provedores).
                </p>
              )}
            </>
          ) : undefined
        }
        hint={
          (state.loading || chips) && (
            <span className="flex items-center gap-1" data-testid={`${testId}-chips`}>
              {state.loading && (
                <Chip
                  testId="voice-catalog-loading"
                  icon={<LoaderCircle aria-hidden className="size-3 animate-spin" />}
                  tip="Buscando a lista de modelos no provedor"
                >
                  buscando
                </Chip>
              )}
              {chips}
            </span>
          )
        }
      >
        Modelo
      </Label>
      <ModelPicker
        value={pid && cur ? { providerId: pid, model: cur } : null}
        onChange={(ref) => {
          setNote(null)
          onChange(ref)
        }}
        source={source}
        testId={testId}
        label={`Modelo de ${what}`}
        placeholder="Escolha um modelo…"
        emptyText={`Nenhum provedor cadastrado serve ${what}.`}
        badges={(p, m) => {
          const lo = localByKey.get(`${p}\u0000${m.id}`)
          if (lo)
            return lo.installed ? null : (
              <span className="shrink-0 rounded-full border border-warning/30 px-1.5 py-px text-[10px] leading-4 text-warning">
                não instalado
              </span>
            )
          const x = byKey.get(`${p}\u0000${m.id}`)
          return x?.ptVoices?.length ? (
            <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] leading-4 text-subtle">
              pt-BR
            </span>
          ) : null
        }}
        meta={(p, m) => {
          const lo = localByKey.get(`${p}\u0000${m.id}`)
          if (lo)
            return lo.detail ? <span className="text-[10px] text-faint">{lo.detail}</span> : null
          const x = byKey.get(`${p}\u0000${m.id}`)
          if (!x) return null
          return (
            <span className="flex flex-col items-end gap-0.5">
              <ModelLatencyBadge m={x} />
              {x.priceHint && <span className="text-[10px] text-faint">{x.priceHint}</span>}
            </span>
          )
        }}
      />
      <div className="mt-1.5 space-y-1 empty:hidden">
        {!usable.length && (
          <Button
            size="sm"
            variant="warning"
            data-testid={`${testId}-empty`}
            icon={<Settings2 className="size-3.5" />}
            title={`Cadastre um provedor que sirva ${what} em Configurações → Provedores`}
            onClick={() => setSettingsOpen(true, 'providers')}
          >
            Nenhum provedor serve {what} · Cadastrar
          </Button>
        )}
        {localSel && !localSel.installed && (
          <WarnNote testId={`${testId}-local-missing`}>
            {localSel.name} não está instalado neste computador —{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setSettingsOpen(true, 'audio:local')}
            >
              instale em Modelos locais
            </button>
            .
          </WarnNote>
        )}
        {fail && !state.loading && (
          <WarnNote testId="voice-catalog-error">Não foi possível listar modelos: {fail}</WarnNote>
        )}
        {untested && (
          <WarnNote testId={`${testId}-untested`} role="note">
            Id livre “{cur}”: não testado para chamada (pode demorar a falar ou não falar pt-BR).
          </WarnNote>
        )}
        {slowWarning && (
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1"
            data-testid={`${testId}-slow`}
          >
            <WarnNote>{slowWarning}</WarnNote>
            {recommended && (
              <Button
                size="sm"
                variant="secondary"
                data-testid={`${testId}-use-recommended`}
                onClick={recommended.onUse}
              >
                Usar {recommended.label}
              </Button>
            )}
          </div>
        )}
        {note && (
          <p
            className="text-[11.5px] text-accent-strong"
            role="status"
            data-testid={`${testId}-corrected`}
          >
            {note}
          </p>
        )}
        {unknown && (
          <WarnNote testId={`${testId}-unknown`}>
            O provedor não lista “{cur}” — escolha um modelo da lista (a request pode falhar).
          </WarnNote>
        )}
      </div>
    </div>
  )
}

// ---------------- voz ----------------

const GENDER_LABEL: Record<NonNullable<VoiceCatalogVoice['gender']>, string> = {
  female: 'feminina',
  male: 'masculina',
  neutral: 'neutra'
}

const BADGE = 'shrink-0 whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] leading-4'

/** Badges de uma voz do catálogo (recomendada, idioma, gênero, sotaque). */
export function VoiceBadges({ v }: { v: VoiceCatalogVoice }): React.JSX.Element {
  return (
    <>
      {v.recommended && (
        <span className={cn(BADGE, 'border-success/30 text-success')}>recomendada</span>
      )}
      {v.language && <span className={cn(BADGE, 'border-border text-subtle')}>{v.language}</span>}
      {v.gender && (
        <span className={cn(BADGE, 'border-border text-subtle')}>{GENDER_LABEL[v.gender]}</span>
      )}
      {v.accent && <span className={cn(BADGE, 'border-border text-subtle')}>{v.accent}</span>}
    </>
  )
}

/** Uma voz no seletor. */
export interface VoicePickerItem {
  id: string
  label: string
  badges?: ReactNode
  /** Texto miúdo à direita (ex.: o id técnico). */
  meta?: ReactNode
}

/** Grupo do seletor (por idioma/sotaque nas vozes de API, por origem nas da GPU). */
export interface VoicePickerGroup {
  key: string
  title: string
  voices: VoicePickerItem[]
  /** Linha extra do grupo (ex.: "Baixar", "Gravar ou enviar…", texto de vazio); recebe o "fechar". */
  extra?: ReactNode | ((close: () => void) => ReactNode)
}

/**
 * Seletor de voz no desenho do seletor de modelo: gatilho com a voz atual (+ ▶ dela), lista com
 * busca, grupos com contagem, ▶ prévia por linha e "Usar “id”" (id livre) quando `allowFree`.
 * `defaultLabel` = item "voz padrão" (valor null).
 */
export function VoicePicker({
  groups,
  value,
  onChange,
  onPreview,
  previewing,
  defaultLabel,
  allowFree = true,
  testId = 'tts-voice',
  optionTestId = 'voice-option',
  previewTestId = 'voice-preview',
  label = 'Voz da fala',
  placeholder = 'Escolha uma voz…',
  hint,
  searchPlaceholder
}: {
  /** Dica de como preencher (ex.: modelo sem lista de vozes) — no topo da lista, não abaixo do campo. */
  hint?: string
  /** Placeholder da busca (padrão: buscar por nome/idioma/sotaque). */
  searchPlaceholder?: string
  groups: VoicePickerGroup[]
  value: string | null
  onChange: (voice: string | null) => void
  onPreview: (id: string, label: string) => void
  /** Voz com prévia em andamento (carregando/tocando). */
  previewing: { id: string; state: 'busy' | 'playing' } | null
  defaultLabel?: string
  allowFree?: boolean
  testId?: string
  optionTestId?: string
  previewTestId?: string
  label?: string
  placeholder?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const anchor = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const all = groups.flatMap((g) => g.voices)
  const current = all.find((v) => v.id === value) ?? null
  const q = query.trim().toLowerCase()
  const match = (v: VoicePickerItem, g: VoicePickerGroup): boolean =>
    !q ||
    `${v.id} ${v.label} ${g.title} ${typeof v.meta === 'string' ? v.meta : ''}`
      .toLowerCase()
      .includes(q)
  const shown = groups
    .map((g) => ({ ...g, voices: g.voices.filter((v) => match(v, g)) }))
    .filter((g) => g.voices.length || (!q && g.extra))
  const free = allowFree && q && !all.some((v) => v.id === query.trim()) ? query.trim() : null
  const pick = (id: string | null): void => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }
  const previewBtn = (id: string, name: string, tid: string): React.JSX.Element => {
    const st = previewing?.id === id ? previewing.state : null
    return (
      <IconButton
        size="sm"
        label={st === 'playing' ? `Parar prévia: ${name}` : `Ouvir prévia: ${name}`}
        data-testid={tid}
        data-state={st ?? 'idle'}
        disabled={st === 'busy'}
        onClick={(e) => {
          e.stopPropagation()
          onPreview(id, name)
        }}
      >
        {st === 'busy' ? (
          <LoaderCircle className="animate-spin" />
        ) : st === 'playing' ? (
          <Square fill="currentColor" />
        ) : (
          <Play />
        )}
      </IconButton>
    )
  }
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <div
          ref={anchor}
          role="combobox"
          tabIndex={0}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid={testId}
          data-value={value ?? ''}
          onClick={() => {
            setOpen((o) => !o)
            setQuery('')
            requestAnimationFrame(() => input.current?.focus())
          }}
          onKeyDown={(e) => {
            if (!open && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) {
              e.preventDefault()
              setOpen(true)
              requestAnimationFrame(() => input.current?.focus())
            }
          }}
          className={cn(
            'field no-drag flex min-w-0 flex-1 cursor-default items-center gap-2',
            open && 'border-border-strong'
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
            {current ? (
              <>
                <span className="truncate">{current.label}</span>
                {current.badges}
              </>
            ) : value ? (
              <>
                <span className="truncate font-mono text-[12px]">{value}</span>
                {all.length > 0 && (
                  <Chip
                    testId={`${testId}-custom-note`}
                    tip="Voz por id (fora da lista do provedor)."
                  >
                    id
                  </Chip>
                )}
              </>
            ) : (
              <span className="text-subtle">{defaultLabel ?? placeholder}</span>
            )}
          </span>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-subtle transition-transform',
              open && 'rotate-180'
            )}
          />
        </div>
        {(current || value) &&
          previewBtn(current?.id ?? value!, current?.label ?? value!, `${testId}-preview-current`)}
      </div>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        minWidth={400}
        maxHeight={440}
      >
        <div className="flex max-h-[440px] min-h-0 flex-col" data-testid={`${testId}-menu`}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
            <Search className="size-3.5 shrink-0 text-subtle" />
            <input
              ref={input}
              value={query}
              aria-label="Buscar voz"
              data-testid={`${testId}-search`}
              placeholder={
                searchPlaceholder ??
                (allowFree
                  ? 'Buscar por nome, idioma ou sotaque — ou digitar um ID…'
                  : 'Buscar por nome, idioma ou sotaque…')
              }
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const first = shown.find((g) => g.voices.length)?.voices[0]
                  if (first) pick(first.id)
                  else if (free) pick(free)
                }
              }}
              className="h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
            />
          </div>
          {hint && !q && (
            <p
              data-testid={`${testId}-hint`}
              className="shrink-0 border-b border-border/60 px-3 py-2 text-[11.5px] leading-snug text-subtle"
            >
              {hint}
            </p>
          )}
          <div role="listbox" aria-label="Vozes" className="min-h-0 flex-1 overflow-y-auto pb-1">
            {defaultLabel && !q && (
              <button
                type="button"
                role="option"
                aria-selected={value === null}
                onClick={() => pick(null)}
                className="mx-1 mt-1 flex h-9 w-[calc(100%-8px)] items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-hover"
              >
                <span className="min-w-0 flex-1 text-subtle">{defaultLabel}</span>
                {value === null && <Check className="size-3.5 text-accent-strong" />}
              </button>
            )}
            {shown.map((g, gi) => (
              <div key={g.key} data-testid={`${testId}-group-${g.key}`}>
                <div
                  className={cn(
                    'flex h-8 items-center gap-1.5 bg-elevated px-3',
                    (gi > 0 || defaultLabel) && 'border-t border-border/60'
                  )}
                >
                  <span className="truncate text-[11.5px] font-semibold tracking-[0.02em] text-muted">
                    {g.title}
                  </span>
                  <span className="text-[10.5px] text-faint tabular-nums">{g.voices.length}</span>
                </div>
                {g.voices.map((v) => (
                  <div
                    key={v.id}
                    className="group mx-1 flex h-[40px] w-[calc(100%-8px)] items-center gap-1 rounded-lg pr-2.5 pl-1 hover:bg-hover"
                  >
                    {previewBtn(v.id, v.label, `${previewTestId}-${v.id}`)}
                    <button
                      type="button"
                      role="option"
                      aria-selected={v.id === value}
                      aria-label={`Escolher a voz ${v.label}`}
                      data-testid={`${optionTestId}-${v.id}`}
                      onClick={() => pick(v.id)}
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]"
                    >
                      <span
                        className={cn(
                          'shrink-0',
                          v.id === value ? 'text-accent-strong' : 'text-fg'
                        )}
                      >
                        {v.label}
                      </span>
                      {v.badges}
                      <span className="ml-auto min-w-0 truncate pl-2 font-mono text-[10.5px] text-faint">
                        {v.meta}
                      </span>
                      <span className="flex w-3.5 shrink-0 justify-center">
                        {v.id === value && <Check className="size-3.5 text-accent-strong" />}
                      </span>
                    </button>
                  </div>
                ))}
                {!q && g.extra && (
                  <div className="px-3 py-1.5">
                    {typeof g.extra === 'function' ? g.extra(() => setOpen(false)) : g.extra}
                  </div>
                )}
              </div>
            ))}
            {!shown.length && !free && (
              <div className="px-3 py-3 text-xs text-subtle">
                {all.length ? 'Nenhuma voz com essa busca.' : 'O provedor não listou vozes.'}
              </div>
            )}
            {free && (
              <>
                <div className="flex h-[30px] items-end border-t border-border/60 px-3 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-faint uppercase">
                  ID livre
                </div>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-testid={`${testId}-custom-use`}
                  onClick={() => pick(free)}
                  className="mx-1 flex h-[32px] w-[calc(100%-8px)] items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] hover:bg-hover"
                >
                  <CornerDownLeft className="size-3.5 shrink-0 text-subtle" />
                  <span className="shrink-0 text-muted">Usar</span>
                  <span className="min-w-0 truncate font-mono text-[11.5px] text-fg">
                    &ldquo;{free}&rdquo;
                  </span>
                  <span className="shrink-0 text-muted">como id de voz</span>
                </button>
              </>
            )}
          </div>
        </div>
      </Popover>
    </div>
  )
}

// ---------------- avisos ----------------

/** Aviso de erro dispensável (padrão dos avisos de Configurações → Áudio). */
export function DismissibleError({
  error,
  onDismiss,
  testId,
  dismissLabel
}: {
  error: string | null
  onDismiss: () => void
  testId: string
  dismissLabel: string
}): React.JSX.Element | null {
  if (!error) return null
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[12px] text-danger"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

// ---------------- modelos locais (sub-tela "Modelos locais") ----------------

/** Lista dos modelos locais agrupados por engine (nome, descrição, idiomas, tamanho). */
export function LocalModelList({
  kind,
  models,
  progress,
  onAction
}: {
  kind: VoiceModelInfo['kind']
  models: VoiceModelInfo[]
  progress: Record<string, { bytes: number; total: number }>
  onAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
}): React.JSX.Element | null {
  // Chatterbox ainda não sintetiza: os pesos só aparecem se já estiverem em disco (para remover)
  const items = models.filter(
    (m) => m.kind === kind && (m.engine !== 'chatterbox' || m.state !== 'notInstalled')
  )
  if (!items.length) return null
  const groups: { engine: string; items: VoiceModelInfo[] }[] = []
  for (const m of items) {
    const g = groups.find((x) => x.engine === m.engine)
    if (g) g.items.push(m)
    else groups.push({ engine: m.engine, items: [m] })
  }
  return (
    <div className="mt-2.5 space-y-2.5">
      {groups.map((g) => (
        <div key={g.engine} data-testid={`voice-models-${g.engine}`}>
          <div className="mb-1 font-mono text-[10px] tracking-wide text-faint uppercase">
            {g.engine}
          </div>
          <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
            {g.items.map((m) => (
              <ModelRow key={m.id} model={m} progress={progress[m.id]} onAction={onAction} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Linha de um modelo local: nome/descrição/idiomas/tamanho + estado, ação e progresso. */
function ModelRow({
  model,
  progress,
  onAction
}: {
  model: VoiceModelInfo
  progress?: { bytes: number; total: number }
  onAction: (model: VoiceModelInfo, action: LocalModelAction['action']) => void
}): React.JSX.Element {
  const a = modelAction(model.state, model.hasDownload)
  const total = progress?.total || model.sizeBytes || 1
  const pct = progress ? Math.max(0, Math.min(100, Math.round((progress.bytes / total) * 100))) : 0
  return (
    <div className="bg-bg/20 px-3 py-2" data-testid={`voice-model-${model.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-fg/90">{model.name}</span>
        <span
          className={cn(
            BADGE,
            model.state === 'installed'
              ? 'border-success/30 text-success'
              : model.state === 'corrupt'
                ? 'border-danger/30 text-danger'
                : 'border-border text-subtle'
          )}
        >
          {a.badge}
        </span>
        {model.state === 'installed' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-success">
            <Check className="size-3" />
            {formatModelSize(model.installedBytes ?? model.sizeBytes)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {a.action ? (
            <Button
              size="sm"
              variant={a.action === 'remove' ? 'ghost' : 'secondary'}
              data-testid={`voice-model-action-${model.id}`}
              icon={
                a.action === 'remove' || a.action === 'cancel' ? (
                  <X className="size-3.5" />
                ) : (
                  <Download className="size-3.5" />
                )
              }
              onClick={() => onAction(model, a.action)}
            >
              {a.label}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary" disabled>
                {a.label}
              </Button>
              <span className="text-[10.5px] text-subtle">download indisponível</span>
            </>
          )}
        </span>
      </div>
      <p className="mt-0.5 text-[11.5px] leading-snug text-subtle">{model.description}</p>
      <p className="text-[10.5px] text-faint">
        {formatModelLanguages(model.languages)}
        {model.sizeBytes > 0 ? ` · ${formatModelSize(model.sizeBytes)}` : ' · tamanho desconhecido'}
      </p>
      {model.state === 'downloading' && (
        <div className="mt-1.5">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-elevated"
            role="progressbar"
            aria-label={`Download de ${model.name}`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            data-testid={`voice-model-progress-${model.id}`}
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-0.5 text-[10.5px] text-subtle tabular-nums">
            {formatModelSize(progress?.bytes ?? 0)} / {formatModelSize(total)} ({pct}%)
          </p>
        </div>
      )}
      {a.warning && (
        <div className="mt-1">
          <WarnNote testId={`voice-model-warning-${model.id}`}>{a.warning}</WarnNote>
        </div>
      )}
    </div>
  )
}
