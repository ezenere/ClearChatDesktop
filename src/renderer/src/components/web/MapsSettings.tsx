// Configurações → Tempo e mapas (protocolo 1.16.0/1.17.0): o provedor da previsão do tempo (tool
// `weather`: Open-Meteo, o padrão sem chave, ou o Google), o dos lugares próximos (`nearby_places`, no
// celular: OpenStreetMap, o padrão, ou o Google Maps) e a chave do Google Maps Platform (mascarada;
// mostrar a pedido; "Testar" faz UMA chamada). Settings `weatherProvider`, `placesProvider` e
// `googleMapsApiKey` (sincronizados).
import { CircleAlert, CircleCheck, ExternalLink, Eye, EyeOff, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  PLACES_PROVIDER_DEFAULT,
  PLACES_PROVIDER_IDS,
  PLACES_PROVIDER_META,
  WEATHER_PROVIDER_DEFAULT,
  WEATHER_PROVIDER_IDS,
  WEATHER_PROVIDER_META,
  type MapsSettingsState,
  type PlacesProviderId,
  type WeatherProviderId
} from '@shared/mapsSettings'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Button, IconButton } from '../ui/controls'
import { HelpTip, Tip } from '../ui/Tooltip'

interface ProviderOption<T extends string> {
  id: T
  label: string
  needsKey: boolean
  description: string
}

/** Lista de provedores (radio): padrão marcado, selo de chave, Google desabilitado sem chave. */
function ProviderChoice<T extends string>({
  ariaLabel,
  testId,
  options,
  value,
  defaultId,
  hasKey,
  onChoose
}: {
  ariaLabel: string
  testId: string
  options: ProviderOption<T>[]
  value: T
  defaultId: T
  hasKey: boolean
  onChoose: (id: T) => void
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="space-y-2">
      {options.map((meta) => {
        const id = meta.id
        const on = value === id
        const can = !meta.needsKey || hasKey
        return (
          <Tip key={id} label={can ? '' : 'Salve a chave do Google Maps Platform abaixo'}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!can}
              data-testid={`${testId}-${id}`}
              onClick={() => onChoose(id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border bg-elevated/40 px-3 py-2.5 text-left transition-colors',
                on
                  ? 'border-accent/60 bg-accent/[0.06]'
                  : 'border-border hover:border-border-strong',
                !can && 'cursor-not-allowed opacity-60'
              )}
            >
              <span
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border',
                  on ? 'border-accent' : 'border-border-strong'
                )}
              >
                {on && <span className="size-2 rounded-full bg-accent" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-1.5">
                  <span className="text-[13px] font-medium text-fg/90">{meta.label}</span>
                  {id === defaultId && (
                    <span className="text-[10.5px] font-medium text-subtle">padrão</span>
                  )}
                  <span
                    className={cn(
                      'rounded-full border px-1.5 py-px text-[10px] leading-4',
                      !meta.needsKey
                        ? 'border-border text-subtle'
                        : hasKey
                          ? 'border-success/30 text-success'
                          : 'border-warning/30 text-warning'
                    )}
                  >
                    {!meta.needsKey ? 'sem chave' : hasKey ? 'chave salva' : 'requer chave'}
                  </span>
                </span>
                <span
                  className="mt-0.5 block truncate text-[11.5px] text-subtle"
                  title={meta.description}
                >
                  {meta.description}
                </span>
              </span>
            </button>
          </Tip>
        )
      })}
    </div>
  )
}

export function MapsSettings(): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [st, setSt] = useState<MapsSettingsState | null>(null)

  useEffect(() => {
    let alive = true
    void api.maps.getSettings().then((s) => alive && setSt(s))
    return () => {
      alive = false
    }
  }, [])

  const chooseWeather = async (id: WeatherProviderId): Promise<void> => {
    if (!st || st.weatherProvider === id) return
    const prev = st
    setSt({ ...st, weatherProvider: id })
    const r = await run(() => api.maps.setWeatherProvider(id))
    setSt(r ?? prev)
  }
  const choosePlaces = async (id: PlacesProviderId): Promise<void> => {
    if (!st || st.placesProvider === id) return
    const prev = st
    setSt({ ...st, placesProvider: id })
    const r = await run(() => api.maps.setPlacesProvider(id))
    setSt(r ?? prev)
  }

  return (
    <div className="space-y-6" data-testid="maps-settings">
      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">Previsão do tempo</span>
          <HelpTip label="Previsão do tempo" className="self-center">
            Fonte da tool <strong className="text-fg/80">weather</strong>. O Google responde agora,
            até 10 dias e até 24 horas por vez; o que ele não cobre (dias anteriores, mais de 10
            dias) e qualquer falha dele (chave, cota, rede) vão ao Open-Meteo naquela chamada, com o
            motivo no resultado.
          </HelpTip>
        </div>
        {!st ? (
          <div className="h-28 animate-pulse rounded-xl border border-border bg-elevated/30" />
        ) : (
          <ProviderChoice
            ariaLabel="Provedor da previsão do tempo"
            testId="weather-provider"
            options={WEATHER_PROVIDER_IDS.map((id) => WEATHER_PROVIDER_META[id])}
            value={st.weatherProvider}
            defaultId={WEATHER_PROVIDER_DEFAULT}
            hasKey={st.google.hasKey}
            onChoose={(id) => void chooseWeather(id)}
          />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">Lugares próximos</span>
          <HelpTip label="Lugares próximos" className="self-center">
            Fonte da tool <strong className="text-fg/80">nearby_places</strong> (roda no celular). O
            Google Maps traz nota, avaliações e um resumo de cada lugar, com o link do Maps para o
            agente citar; o OpenStreetMap traz endereço, horário e telefone, sem notas. Se o Google
            falhar (chave, cota, rede), a busca vai ao OpenStreetMap, com o motivo no resultado.
          </HelpTip>
        </div>
        {st && (
          <ProviderChoice
            ariaLabel="Provedor dos lugares próximos"
            testId="places-provider"
            options={PLACES_PROVIDER_IDS.map((id) => PLACES_PROVIDER_META[id])}
            value={st.placesProvider}
            defaultId={PLACES_PROVIDER_DEFAULT}
            hasKey={st.google.hasKey}
            onChoose={(id) => void choosePlaces(id)}
          />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg/90">Google Maps Platform</span>
          <HelpTip label="Google Maps Platform" className="self-center">
            Uma chave do Google Cloud com o{' '}
            <strong className="text-fg/80">Maps Experience agent tools</strong>{' '}
            (mapstools.googleapis.com) ativado no projeto e na chave. Cobrança por chamada: 10 mil
            grátis por mês no básico; a previsão usa uma chamada por momento (agora + 1 por dia + 1
            por hora) e cada busca de lugares, uma (até 5 lugares; de 6 a 10 é a faixa Pro). Os
            termos do Google pedem citar a fonte (o resultado traz o link) e um modelo que não
            treine com os dados enviados. A chave sincroniza criptografada com seus aparelhos.
          </HelpTip>
          <Tip label="Abrir a documentação">
            <a
              href={WEATHER_PROVIDER_META.google.site}
              target="_blank"
              rel="noreferrer"
              aria-label="Documentação do Maps Experience agent tools"
              className="inline-flex size-4 items-center justify-center self-center rounded text-faint hover:text-accent-strong"
            >
              <ExternalLink className="size-3" />
            </a>
          </Tip>
        </div>
        {st && <GoogleKeyField state={st} onState={setSt} />}
      </section>
    </div>
  )
}

function GoogleKeyField({
  state,
  onState
}: {
  state: MapsSettingsState
  onState: (s: MapsSettingsState) => void
}): React.JSX.Element {
  const run = useStore((s) => s.run)
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const dirty = value.trim() !== '' && value.trim() !== revealed
  const hasKey = state.google.hasKey

  const saveKey = async (key: string | null): Promise<void> => {
    const r = await run(() => api.maps.setGoogleKey(key))
    if (!r) return
    onState(r)
    setValue('')
    setRevealed(null)
    setShow(false)
    setTest(null)
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
    if (!value && hasKey) {
      const k = await run(() => api.maps.revealGoogleKey())
      if (k) {
        setValue(k)
        setRevealed(k)
      }
    }
    setShow(true)
  }
  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTest(null)
    const r = await run(() => api.maps.testGoogleKey(dirty ? value : null))
    setTesting(false)
    if (r) setTest(r.ok ? { ok: true, text: r.text } : { ok: false, text: r.error })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            spellCheck={false}
            autoComplete="off"
            aria-label="Chave do Google Maps Platform"
            data-testid="google-maps-key"
            placeholder={
              hasKey ? `${state.google.keyMask} — digite para trocar` : 'Cole a chave (AIza…)'
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
            disabled={!hasKey && !value}
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
        <Button
          size="sm"
          variant="secondary"
          loading={testing}
          disabled={!hasKey && !dirty}
          onClick={() => void runTest()}
          aria-label="Testar a chave do Google Maps"
        >
          Testar
        </Button>
        {hasKey && !dirty && (
          <IconButton
            size="sm"
            label="Remover chave"
            aria-label="Remover a chave do Google Maps"
            onClick={() => void saveKey(null)}
          >
            <X />
          </IconButton>
        )}
      </div>
      {test && (
        <p
          data-testid="google-maps-test"
          className={cn(
            'flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px]',
            test.ok
              ? 'border-success/20 bg-success/[0.06] text-success'
              : 'border-danger/25 bg-danger/[0.06] text-danger'
          )}
        >
          {test.ok ? (
            <CircleCheck className="mt-px size-3.5 shrink-0" />
          ) : (
            <CircleAlert className="mt-px size-3.5 shrink-0" />
          )}
          <span>{test.text}</span>
        </p>
      )}
    </div>
  )
}
