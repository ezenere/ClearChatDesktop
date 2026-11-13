// Falhas lembradas da busca nativa de tools (protocolo 1.12.0, §4.4 — setting LOCAL
// `toolSearchCaps`, NUNCA sincronizado: fora de SETTING_IDS do sync). Uma recusa do modo nativo só
// é lembrada (24 h, por provedor+modelo) quando a repetição na versão local deu certo (runner).
import {
  TOOL_SEARCH_CAPS_SETTING,
  normalizeToolSearchCaps,
  withFailure,
  type NativeToolSearchMode,
  type ToolSearchCaps
} from '@shared/toolSearch'
import { settingsRepo } from './repo'

export function getToolSearchCaps(): ToolSearchCaps {
  try {
    return normalizeToolSearchCaps(settingsRepo.get(TOOL_SEARCH_CAPS_SETTING))
  } catch {
    return {}
  }
}

export function markToolSearchFailure(
  providerId: string,
  model: string,
  mode: NativeToolSearchMode,
  error: string,
  now = Date.now()
): ToolSearchCaps {
  const next = withFailure(
    getToolSearchCaps(),
    providerId,
    model,
    { mode, failedAt: now, error },
    now
  )
  settingsRepo.set(TOOL_SEARCH_CAPS_SETTING, next)
  return next
}
