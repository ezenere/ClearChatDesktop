// Configurações → Tempo e mapas (protocolo 1.16.0): o provedor da previsão do tempo (setting
// `weatherProvider`) e a chave do Google Maps Platform (setting `googleMapsApiKey`, só no main — o
// renderer recebe a máscara; a chave em claro só sai por `revealGoogleMapsKey`, a pedido).
// Os dois sincronizam (§4.3.2), como os da busca.
import {
  checkMapsKey,
  GOOGLE_MAPS_KEY_SETTING,
  mapsSettingsState,
  normalizeMapsKey,
  normalizeWeatherProvider,
  WEATHER_PROVIDER_META,
  WEATHER_PROVIDER_SETTING,
  type MapsSettingsState,
  type WeatherProviderId
} from '@shared/mapsSettings'
import { googleWeatherProvider, testGoogleWeatherKey } from '@shared/googleWeather'
import type { WeatherProvider } from '@shared/weather'
import { settingsRepo } from './repo'

const key = (): string | null => normalizeMapsKey(settingsRepo.get(GOOGLE_MAPS_KEY_SETTING))

export function getMapsSettings(): MapsSettingsState {
  return mapsSettingsState(settingsRepo.get(WEATHER_PROVIDER_SETTING), key())
}

/** Escolhe o provedor da previsão. Google sem chave salva → erro legível. */
export function setWeatherProvider(id: WeatherProviderId): MapsSettingsState {
  if (!(id in WEATHER_PROVIDER_META)) throw new Error('Provedor desconhecido.')
  if (WEATHER_PROVIDER_META[id].needsKey && !key())
    throw new Error('Informe a chave do Google Maps Platform para usar o Google.')
  settingsRepo.set(WEATHER_PROVIDER_SETTING, id)
  return getMapsSettings()
}

/** Salva (ou, vazia/null, remove) a chave; sem chave a previsão volta ao Open-Meteo. */
export function setGoogleMapsKey(k: string | null): MapsSettingsState {
  const c = checkMapsKey(k)
  if (!c.ok) throw new Error(c.error)
  settingsRepo.set(GOOGLE_MAPS_KEY_SETTING, c.key)
  if (!c.key && settingsRepo.get(WEATHER_PROVIDER_SETTING) === 'google')
    settingsRepo.set(WEATHER_PROVIDER_SETTING, 'open-meteo')
  return getMapsSettings()
}

/** Chave em claro (botão "mostrar"). */
export function revealGoogleMapsKey(): string | null {
  return key()
}

/** Testa a chave salva (ou a digitada) com uma chamada de "agora". */
export async function testGoogleMapsKey(
  typed?: string | null
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const k = normalizeMapsKey(typed) ?? key()
  if (!k) return { ok: false, error: 'Nenhuma chave salva.' }
  return testGoogleWeatherKey(k, {
    fetch: (url, init) => fetch(url, init),
    signal: AbortSignal.timeout(20_000)
  })
}

/** Provedor da tool `weather` agora (null = Open-Meteo). */
export function weatherProviderNow(): WeatherProvider | null {
  const k = key()
  return normalizeWeatherProvider(settingsRepo.get(WEATHER_PROVIDER_SETTING), !!k) === 'google' && k
    ? googleWeatherProvider(k)
    : null
}
