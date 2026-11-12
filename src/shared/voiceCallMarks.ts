// Chamada de voz no histórico: marca das mensagens faladas/ditadas (`MessageMeta.voice`) e os
// marcadores de início/fim da chamada (`MessageMeta.voiceCall`, mensagens só de exibição — kind
// 'voice-call', NUNCA enviadas à API) com a duração e os custos/tempos da chamada. Funções puras
// (main monta, renderer mostra). Ver SPEC.md → "Áudio → Chamada de voz → Histórico e custos".

/** Mensagem que veio de voz: fala da chamada (usuário/assistente) ou texto ditado no composer. */
export interface VoiceMessageMeta {
  /** 'call' = turno da chamada de voz; 'dictation' = texto ditado no composer (editável). */
  source: 'call' | 'dictation'
  /** Chamada a que pertence (source 'call'). */
  callId?: string
  /** Usuário: áudio da fala enviada à transcrição (ms). */
  durationMs?: number
  /** Usuário: modelo/motor da transcrição final. */
  sttModel?: string
  /**
   * Assistente: a resposta foi falada inteira (true) ou só em parte ('partial' — barge-in/fim da
   * chamada). Ausente = só tool calls (nada a falar).
   */
  spoken?: true | 'partial'
  /** Assistente: modelo/motor da voz. */
  ttsModel?: string
  /**
   * Assistente interrompido no meio (barge-in): o resto da resposta que o usuário NÃO ouviu — só
   * para exibição (esmaecido depois do marcador "interrompido"); nunca vai ao modelo (o conteúdo da
   * mensagem termina no que foi ouvido + "…").
   */
  unheard?: string
}

/** Quem encerrou a chamada. */
export type VoiceCallEndedBy = 'user' | 'agent' | 'error'

/** Custos/tempos de uma chamada (marcador de fim). Custos em US$, só os informados/estimados. */
export interface VoiceCallUsage {
  /** Turnos de voz do usuário enviados. */
  turns: number
  /** Fala do usuário transcrita nas finais (ms de áudio). */
  userSpeechMs: number
  stt: {
    /** Modo de transcrição na chamada (`sttSettings.mode`). */
    mode: 'api' | 'local' | 'hybrid' | 'gpu'
    model?: string
    /** Requests pela API (parciais, especulação, segmentos e finais). */
    apiRequests: number
    /** Áudio enviado à API (ms; parciais se sobrepõem — é o que o provedor recebeu). */
    apiAudioMs: number
    /** Transcrições locais/GPU (grátis). */
    localRequests: number
    /** Soma do `usage.cost` devolvido pela API (ausente = nenhuma request informou custo). */
    cost?: number
    /** Requests com custo informado. */
    costedRequests: number
  }
  tts: {
    /** 'api' (OpenAI-compatível/OpenRouter), 'elevenlabs' (direta), 'local' ou 'gpu'. */
    backend: 'api' | 'elevenlabs' | 'local' | 'gpu'
    model?: string
    /**
     * Caracteres enviados à síntese (frases da resposta e frases de demora sintetizadas ao vivo;
     * clipes pré-gerados não contam).
     */
    chars: number
    /** Áudio gerado na chamada (frases da resposta e de demora; ms — PCM/WAV medidos; mp3 não conta). */
    audioMs: number
    /** Custo (estimado pelo preço de lista por caractere quando `estimated`). */
    cost?: number
    estimated?: boolean
  }
  llm: {
    /** Respostas do modelo nos turnos da chamada. */
    calls: number
    cost: number
    /** Respostas com custo informado. */
    costed: number
  }
}

/** Marcador de início/fim de chamada (mensagem só de exibição, `meta.kind: 'voice-call'`). */
export interface VoiceCallMark {
  callId: string
  phase: 'start' | 'end'
  /** Início da chamada (epoch ms). */
  startedAt: number
  /** Fim (marcador de fim). */
  endedAt?: number
  durationMs?: number
  endedBy?: VoiceCallEndedBy
  /** Motivo: erro legível (`error`) ou o motivo do agente (`end_call`). */
  reason?: string
  usage?: VoiceCallUsage
}

/** Resultado da tool `end_call` no histórico (curto — o modelo não precisa de mais). */
export const END_CALL_RESULT = 'Chamada encerrada pelo agente.'
/** Texto (exibição) do marcador de início. */
export const CALL_START_TEXT = 'Chamada de voz iniciada'

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** "4 min 12 s", "38 s", "1 h 02 min" (pt-BR, arredondado ao segundo). */
export function formatCallDuration(ms: number): string {
  const s = Math.max(0, Math.round(n(ms) / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`
  const h = Math.floor(m / 60)
  return `${h} h ${String(m % 60).padStart(2, '0')} min`
}

/** Relógio da barra da chamada: "02:13" / "1:02:13". */
export function formatCallClock(ms: number): string {
  const s = Math.max(0, Math.floor(n(ms) / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Segundos com 1 casa (pt-BR): "3,2 s". */
export function formatSeconds(ms: number): string {
  return `${(Math.max(0, n(ms)) / 1000).toFixed(1).replace('.', ',')} s`
}

/** "por você" / "pelo agente" / "por erro: <motivo>". */
export function endedByText(mark: Pick<VoiceCallMark, 'endedBy' | 'reason'>): string {
  if (mark.endedBy === 'agent') return 'pelo agente'
  if (mark.endedBy === 'error') return mark.reason ? `erro: ${mark.reason}` : 'erro'
  return 'por você'
}

/** Custo informado (STT) + LLM; a TTS só entra quando NÃO é estimativa. */
export function callReportedCost(u: VoiceCallUsage | undefined): number {
  if (!u) return 0
  return n(u.stt.cost) + n(u.llm.cost) + (u.tts.estimated ? 0 : n(u.tts.cost))
}

/** Texto do marcador de fim (exibição; também o `content` da mensagem). */
export function callEndText(mark: VoiceCallMark): string {
  return `Chamada encerrada · ${formatCallDuration(n(mark.durationMs))} · ${endedByText(mark)}`
}

/** Mensagem (assistente/usuário) falada na chamada? */
export const isCallVoice = (v: VoiceMessageMeta | undefined | null): boolean =>
  !!v && v.source === 'call'

/** Normaliza o `meta.voice` que o renderer manda no envio (só ditado é aceito de fora). */
export function sanitizeDictationMeta(v: unknown): VoiceMessageMeta | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.source !== 'dictation') return null
  const out: VoiceMessageMeta = { source: 'dictation' }
  if (typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) && o.durationMs > 0)
    out.durationMs = Math.round(o.durationMs)
  if (typeof o.sttModel === 'string' && o.sttModel.trim())
    out.sttModel = o.sttModel.trim().slice(0, 120)
  return out
}

/** Duração (ms) de áudio PCM16 mono/WAV: `audio/pcm;rate=N` ou WAV PCM; outros formatos → null. */
export function audioDurationMs(audio: Uint8Array, mime: string): number | null {
  if (!audio?.length) return 0
  const rate = /rate=(\d+)/i.exec(mime ?? '')
  if (/^audio\/pcm/i.test(mime ?? '')) {
    const r = rate ? Number(rate[1]) : 24_000
    return r > 0 ? Math.round((audio.length / 2 / r) * 1000) : null
  }
  if (/wav/i.test(mime ?? '') && audio.length >= 44) {
    const dv = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
    if (dv.getUint32(0, false) !== 0x52494646) return null // "RIFF"
    const byteRate = dv.getUint32(28, true)
    return byteRate > 0 ? Math.round(((audio.length - 44) / byteRate) * 1000) : null
  }
  return null
}

/** US$ no formato pt-BR (como `formatUsd` do renderer): $0,00 · <$0,0001 · $0,0042 · $1,23. */
export function formatCallUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0,00'
  if (cost < 0.0001) return '<$0,0001'
  if (cost < 0.01) return `$${cost.toFixed(4).replace('.', ',')}`
  const [int, dec] = cost.toFixed(2).split('.')
  return `$${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}

const intPt = (v: number): string => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/**
 * Custo resumido do marcador de fim: "$0,0123" (informado), "≈ $0,05" (com a estimativa da voz),
 * null quando nada tem custo conhecido (tudo local ou não informado).
 */
export function callCostSummary(u: VoiceCallUsage | undefined): string | null {
  if (!u) return null
  const reported = callReportedCost(u)
  const est = u.tts.estimated ? n(u.tts.cost) : 0
  const known = u.llm.costed > 0 || u.stt.costedRequests > 0 || (u.tts.cost != null && !est)
  if (!known && !est) return null
  return est ? `≈ ${formatCallUsd(reported + est)}` : formatCallUsd(reported)
}

/** Detalhamento (tooltip do marcador de fim e popover de gasto): [rótulo, valor]. */
export function callUsageLines(mark: VoiceCallMark): [string, string][] {
  const u = mark.usage
  const out: [string, string][] = [['Duração', formatCallDuration(n(mark.durationMs))]]
  out.push(['Encerrada', endedByText(mark)])
  if (!u) return out
  out.push(['Fala (você)', `${formatCallDuration(u.userSpeechMs)} · ${intPt(u.turns)} turnos`])
  // transcrição
  const sttLocal = u.stt.mode === 'local' || u.stt.mode === 'gpu'
  let stt: string
  if (sttLocal || (!u.stt.apiRequests && u.stt.localRequests)) stt = 'local (grátis)'
  else {
    const parts = [`${intPt(u.stt.apiRequests)} requests`, formatCallDuration(u.stt.apiAudioMs)]
    parts.push(
      u.stt.costedRequests > 0
        ? formatCallUsd(n(u.stt.cost)) +
            (u.stt.costedRequests < u.stt.apiRequests ? ' + custo não informado' : '')
        : 'custo não informado'
    )
    stt = parts.join(' · ')
  }
  out.push([`Transcrição${u.stt.model ? ` (${u.stt.model})` : ''}`, stt])
  // voz
  let tts: string
  if (u.tts.backend === 'local' || u.tts.backend === 'gpu') tts = 'local (grátis)'
  else if (u.tts.backend === 'elevenlabs')
    tts = `${intPt(u.tts.chars)} caracteres (créditos ElevenLabs)`
  else
    tts = `${intPt(u.tts.chars)} caracteres · ${
      u.tts.cost != null
        ? `${u.tts.estimated ? '≈ ' : ''}${formatCallUsd(u.tts.cost)}${u.tts.estimated ? ' (preço de lista)' : ''}`
        : 'custo não informado'
    }`
  out.push([`Voz${u.tts.model ? ` (${u.tts.model})` : ''}`, tts])
  if (u.tts.audioMs > 0) out.push(['Áudio gerado', formatCallDuration(u.tts.audioMs)])
  out.push([
    'Modelo (respostas)',
    `${intPt(u.llm.calls)} · ${
      u.llm.costed
        ? formatCallUsd(u.llm.cost) + (u.llm.costed < u.llm.calls ? ' + ?' : '')
        : u.llm.calls
          ? 'custo não informado'
          : formatCallUsd(0)
    }`
  ])
  out.push(['Preâmbulos', 'grátis (clipes pré-gerados)'])
  return out
}

/** Texto do tooltip do ícone de voz de uma mensagem. */
export function voiceBadgeText(v: VoiceMessageMeta, role: 'user' | 'assistant'): string {
  if (v.source === 'dictation') return 'Ditado por voz (texto editável antes do envio)'
  if (role === 'user') {
    const parts = ['Falado na chamada de voz']
    if (v.durationMs) parts.push(formatSeconds(v.durationMs))
    if (v.sttModel) parts.push(`transcrição: ${v.sttModel}`)
    return parts.join(' · ')
  }
  const parts = [
    v.spoken === 'partial'
      ? 'Falado em parte na chamada (interrompido)'
      : v.spoken
        ? 'Falado na chamada de voz'
        : 'Turno da chamada de voz'
  ]
  if (v.ttsModel) parts.push(`voz: ${v.ttsModel}`)
  return parts.join(' · ')
}
