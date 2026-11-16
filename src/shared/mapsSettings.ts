// Configuração GLOBAL de "Tempo e mapas" (protocolo 1.16.0/1.17.0, SYNC_PROTOCOL.md §4.3.2/§4.3.6): o
// provedor da previsão do tempo (tool `weather`), o dos lugares próximos (`nearby_places`, desde 1.17.0)
// e a chave do Google Maps Platform (Maps Experience agent tools — a mesma para os dois). Settings sincronizados como os da busca: a chave NUNCA sai do
// main/serviço pelo settings:get genérico — a UI recebe a máscara. Puro (main, renderer, mobile).
import { maskKey } from './webSearchSettings'

export type WeatherProviderId = 'open-meteo' | 'google'

/** Setting com o provedor da previsão (ausente/inválido → Open-Meteo). */
export const WEATHER_PROVIDER_SETTING = 'weatherProvider'
/** Setting com a chave do Google Maps Platform (string) — protegido. */
export const GOOGLE_MAPS_KEY_SETTING = 'googleMapsApiKey'

export const WEATHER_PROVIDER_DEFAULT: WeatherProviderId = 'open-meteo'
export const WEATHER_PROVIDER_IDS: readonly WeatherProviderId[] = ['open-meteo', 'google']

export interface WeatherProviderMeta {
  id: WeatherProviderId
  label: string
  needsKey: boolean
  /** Uma linha (UI). */
  description: string
  site: string
}

export const WEATHER_PROVIDER_META: Record<WeatherProviderId, WeatherProviderMeta> = {
  'open-meteo': {
    id: 'open-meteo',
    label: 'Open-Meteo',
    needsKey: false,
    description: 'Gratuito, sem chave: modelos dos serviços meteorológicos nacionais.',
    site: 'https://open-meteo.com/'
  },
  google: {
    id: 'google',
    label: 'Google',
    needsKey: true,
    description:
      'Previsão do Google (Maps Experience agent tools). Uma chamada por momento: agora, cada dia, cada hora.',
    site: 'https://developers.google.com/maps/ai/grounding-lite'
  }
}

/** Provedor salvo → válido; Google sem chave salva vale Open-Meteo (como buscador sem chave). */
export function normalizeWeatherProvider(v: unknown, hasGoogleKey: boolean): WeatherProviderId {
  if (v === 'google') return hasGoogleKey ? 'google' : WEATHER_PROVIDER_DEFAULT
  return WEATHER_PROVIDER_DEFAULT
}

/** Chave salva (string não vazia, sem espaços nas pontas) ou null. */
export function normalizeMapsKey(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Valida a chave digitada: '' = remover; erro legível ou a chave limpa. */
export function checkMapsKey(
  v: unknown
): { ok: true; key: string | null } | { ok: false; error: string } {
  const k = typeof v === 'string' ? v.trim() : ''
  if (/\s/.test(k)) return { ok: false, error: 'A chave não pode conter espaços.' }
  return { ok: true, key: k || null }
}

/** Estado para as telas (a chave só mascarada). */
export interface MapsSettingsState {
  weatherProvider: WeatherProviderId
  placesProvider: PlacesProviderId
  google: { hasKey: boolean; keyMask: string | null }
}

export function mapsSettingsState(
  providerRaw: unknown,
  keyRaw: unknown,
  placesRaw?: unknown
): MapsSettingsState {
  const key = normalizeMapsKey(keyRaw)
  return {
    weatherProvider: normalizeWeatherProvider(providerRaw, !!key),
    placesProvider: normalizePlacesProvider(placesRaw, !!key),
    google: { hasKey: !!key, keyMask: maskKey(key) }
  }
}

// ---------------- lugares próximos (1.17.0) ----------------

export type PlacesProviderId = 'osm' | 'google'

/** Setting com o provedor do `nearby_places` (ausente/inválido → OpenStreetMap). */
export const PLACES_PROVIDER_SETTING = 'placesProvider'
export const PLACES_PROVIDER_DEFAULT: PlacesProviderId = 'osm'
export const PLACES_PROVIDER_IDS: readonly PlacesProviderId[] = ['osm', 'google']

export const PLACES_PROVIDER_META: Record<
  PlacesProviderId,
  { id: PlacesProviderId; label: string; needsKey: boolean; description: string }
> = {
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    needsKey: false,
    description: 'Gratuito, sem chave: dados colaborativos (sem notas nem avaliações).'
  },
  google: {
    id: 'google',
    label: 'Google Maps',
    needsKey: true,
    description:
      'Lugares do Google com nota, avaliações e um resumo. Uma chamada por busca (até 5 lugares no básico).'
  }
}

/** Google sem chave salva vale OpenStreetMap. */
export function normalizePlacesProvider(v: unknown, hasGoogleKey: boolean): PlacesProviderId {
  return v === 'google' && hasGoogleKey ? 'google' : PLACES_PROVIDER_DEFAULT
}

/** Settings que o settings:get/set genérico não lê nem grava (a chave real só pelo domínio próprio). */
export const MAPS_PROTECTED_SETTINGS: readonly string[] = [GOOGLE_MAPS_KEY_SETTING]
