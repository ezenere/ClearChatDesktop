// Idiomas comuns da transcrição (ditado deste dispositivo — Configurações → Áudio — e o idioma da
// transcrição de uma persona/chat). O campo aceita código livre ("Outro…" em Configurações).

export const DICTATION_LANGUAGES: { value: string; label: string }[] = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'pt-PT', label: 'Português (Portugal)' },
  { value: 'en-US', label: 'Inglês (EUA)' },
  { value: 'en-GB', label: 'Inglês (Reino Unido)' },
  { value: 'es-ES', label: 'Espanhol' },
  { value: 'fr-FR', label: 'Francês' },
  { value: 'de-DE', label: 'Alemão' },
  { value: 'it-IT', label: 'Italiano' },
  { value: 'ja-JP', label: 'Japonês' },
  { value: 'zh-CN', label: 'Chinês (simplificado)' },
  { value: 'ko-KR', label: 'Coreano' },
  { value: 'ru-RU', label: 'Russo' }
]

/** Nome legível de um código de idioma (código livre → o próprio código). */
export function languageLabel(code: string): string {
  return DICTATION_LANGUAGES.find((l) => l.value === code)?.label ?? code
}
