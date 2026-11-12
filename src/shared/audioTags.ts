// Tags de voz ("audio tags") na fala da chamada — PURO (main, renderer e o mobile). Modelos que as
// interpretam (ElevenLabs Eleven v3/v4; Fish Audio Drama 3/S2 Pro/S2.1 Pro — `supportsAudioTags` em
// `voiceCatalog.ts`) recebem o texto com elas ("[laughs] Que ideia boa!", "[nervous, whispering]
// Ninguém respondeu."); os demais as LERIAM em voz alta, então elas saem antes da síntese
// (`stripAudioTags`). O corte de sentenças nunca parte uma tag e uma tag sozinha nunca vira uma
// utterance (`sentences.ts`). No chat a tag fica no texto da mensagem e aparece esmaecida.
// Ver SPEC.md → "Chamada de voz → Tags de voz".

/**
 * Uma tag de voz: colchetes com 2–40 caracteres que começam por letra (palavras, espaços, vírgula,
 * ponto, "!", "?", hífen, apóstrofo) e NÃO seguidos de "(" — `[laughs]`, `[short pause]`,
 * `[nervous, whispering]`; nunca link Markdown (`[texto](url)`), nota (`[1]`), checkbox (`[ ]`/
 * `[x]`) nem `[^1]`.
 */
export const AUDIO_TAG_SOURCE = "\\[(?:\\p{L}[\\p{L} ,.!?'’-]{1,39})\\](?!\\()"

/** Regex global das tags de voz (nova a cada chamada — `lastIndex` nunca vaza entre usos). */
export function audioTagRe(): RegExp {
  return new RegExp(AUDIO_TAG_SOURCE, 'gu')
}

/** O texto tem alguma tag de voz? */
export function hasAudioTags(text: string): boolean {
  return audioTagRe().test(String(text ?? ''))
}

/** O texto é SÓ tags de voz (e espaço/pontuação) — sem nada para falar? */
export function isOnlyAudioTags(text: string): boolean {
  const t = String(text ?? '')
  if (!hasAudioTags(t)) return false
  return !/[\p{L}\p{N}]/u.test(t.replace(audioTagRe(), ''))
}

/**
 * Tira as tags de voz (o TTS sem suporte as leria em voz alta): "Claro! [laughs] Isso é ótimo." →
 * "Claro! Isso é ótimo." — espaços duplos colapsados e nenhum espaço antes de pontuação.
 */
export function stripAudioTags(text: string): string {
  const t = String(text ?? '')
  if (!hasAudioTags(t)) return t
  return t
    .replace(audioTagRe(), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?…;:])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .trim()
}

/**
 * Instrução padrão das tags de voz (somada ao prompt da chamada quando o usuário liga as tags E a
 * voz da chamada as interpreta). Genérica o bastante para as tags da ElevenLabs (`[laughs]`) e as
 * direções livres do Fish Audio (`[warm, softly]`). Editável por persona/chat/global
 * (`audioTagsPrompt`).
 */
export const DEFAULT_AUDIO_TAGS_PROMPT = [
  'Sua voz interpreta tags de voz: você pode usar, com moderação, tags curtas em inglês entre colchetes no meio da fala para dar emoção e ritmo — por exemplo [laughs], [sighs], [whispers], [excited], [curious], [short pause] ou uma direção curta como [warm, softly].',
  'Ponha a tag logo antes do trecho que ela afeta, no máximo uma ou duas por resposta, nunca dentro de código ou markdown, e nunca explique nem mencione as tags.'
].join(' ')

/** Teto do texto da instrução das tags (chars) — o normalizador apara. */
export const AUDIO_TAGS_PROMPT_MAX = 2000
