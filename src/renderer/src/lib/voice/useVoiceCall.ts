// Chamada de voz (renderer): o "sensor" do turno — captura contínua (`AudioCapture`, constraints
// com `echoCancellation: true`), fala do usuário com FIM DE TURNO ADAPTATIVO (`AdaptiveTurnGate`:
// aos ~250 ms de pausa pede a transcrição especulativa — `voice:transcribe:speculate` — e o
// veredito de `classifyUtteranceEnd` define o silêncio que fecha a vez: pergunta/comando ~600 ms,
// afirmação ~1200 ms, frase inacabada ~1500 ms; sem especulação, o silêncio fixo), uma sessão de
// transcrição por fala (`voice:transcribe:*`, serializadas numa cadeia; a especulativa vira a
// final quando o usuário não voltou a falar) e a reprodução da resposta (`UtteranceQueue`).
//
// Os eventos de fronteira vão ao main pelos canais `voice:call:*` (o main é o dono do turno e do
// envio): `speech-begin`/`speech-end` → `turn(text)` com a transcrição final. Fala do usuário
// enquanto uma FRASE da resposta toca: com histerese (`PlaybackDuck`) — o áudio do assistente
// ABAIXA (ducking) e continua; quem insiste (voz/palavras/"para") vira barge-in (cancela a fala com
// fade e manda as frases ouvidas — o main trunca o histórico); o que para antes (tosse, "uhum")
// devolve o volume e é descartado.
// Fala com só clipes tocando (preâmbulo/frase de demora) ou nada ouvido ainda: os clipes saem na
// hora (fade curto, sem sobrepor o usuário) e o main decide o turno continuado. Meia-duplex: nada
// do assistente toca durante a fala do usuário.
// Fase "Preparando a GPU…" (`voiceCall.preparing`, fala/transcrição na GPU local): a captura só
// começa quando o main avisa que o servidor subiu e aqueceu.
// Mudo = captura pausada (microfone liberado). Build de dev com `VITE_CLEAR_MOCK=1`: sem captura
// (o mock `voice` emite os estados/utterances e o `Waveform` simula os níveis; `__clearMockMic`
// simula falhas do microfone).
//
// O estado de runtime (nível, erro, volume, clipes) é publicado em `useVoiceCallRuntime` — o dock
// vive na coluna do composer e só lê de lá. Falha ao abrir o microfone ENCERRA a chamada; como o
// dock some junto, o motivo vai para um toast (visível em qualquer tela).
import { useCallback, useEffect, useRef } from 'react'
import type { VoiceCallTimelineEvent } from '@shared/ipc'
import { DEFAULT_BARGE_IN, DEFAULT_TURN_TIMING, type TurnTiming } from '@shared/voice'
import { DUCK_FADE_MS, PlaybackDuck, VoicedSpan, type BargeInReason } from '@shared/voicePolicy'
import { AdaptiveTurnGate, classifyUtteranceEnd, type UtteranceEnd } from '@shared/voiceTurn'
import { LevelGate } from '@shared/speechGate'
import { AudioCapture } from '../audio/capture'
import { api, errorMessage } from '../api'
import { useStore } from '../../store'
import { captureErrorText, MIC_FALLBACK_NOTICE } from './dictation'
import { UtteranceQueue } from './utteranceQueue'
import { useVoiceCallRuntime, type VoiceCallRuntime } from './voiceCallRuntime'
import { resetVoiceFollow, useVoiceFollow } from './voiceFollow'
import { heardChars } from '@shared/heardText'
import { loadVoiceSettings } from './voiceSettings'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'
/** Duração do quadro de nível RMS (ms) — `AudioCapture` emite ~30 Hz (`DEFAULT_LEVEL_MS`). */
const FRAME_MS = 33
/** Pre-roll da fala (chunks PCM mantidos antes do início) — não corta o onset (~300 ms). */
const PREROLL_MAX = 3
/** Fade (ms) do preâmbulo/frase cortados pelo usuário. */
const FADE_MS = 80

const setLevel = (level: number): void => useVoiceCallRuntime.setState({ level })
const setError = (error: string | null): void => useVoiceCallRuntime.setState({ error })
const setLive = (text: string, state: VoiceCallRuntime['live']['state']): void =>
  useVoiceCallRuntime.setState({ live: { text: text.trim(), state: text.trim() ? state : null } })

/** Mock de UI: falha simulada do microfone (`window.__clearMockMic`, definido pelo cenário). */
function mockMicMode(): string {
  return (window as unknown as { __clearMockMic?: string }).__clearMockMic ?? 'ok'
}

/** Recarrega o estado dos clipes dos preâmbulos da voz atual. */
async function refreshClips(): Promise<void> {
  const v = api.voice
  if (!v) return
  try {
    const m = await v.tts.clips.list()
    // cache de definição antiga (frases/pool mudaram) conta como ausente: "Gerar clipes" de novo
    useVoiceCallRuntime.setState({ clips: m && m.clips.length > 0 && !m.stale ? 'ok' : 'missing' })
  } catch {
    useVoiceCallRuntime.setState({ clips: 'unknown' })
  }
}

/**
 * Controller da chamada (montado UMA vez — `VoiceCallController` em `App`): captura, porta de fala,
 * transcrição e reprodução. Publica nível/erro/volume/clipes e as ações em `useVoiceCallRuntime`.
 */
export function useVoiceCall(): void {
  const active = useStore((s) => s.voiceCall.active)
  // chave estável (o objeto do estado muda a cada evento — a captura não pode reiniciar à toa)
  const timingKey = useStore((s) => JSON.stringify(s.voiceCall.turnTiming ?? DEFAULT_TURN_TIMING))
  const muted = useStore((s) => s.voiceCall.muted)
  // "Preparando a GPU…" (Modo avançado): o microfone só abre com o servidor local pronto e aquecido
  const preparing = useStore((s) => !!s.voiceCall.preparing)
  const volume = useVoiceCallRuntime((s) => s.volume)

  const queueRef = useRef<UtteranceQueue | null>(null)
  const gateRef = useRef<AdaptiveTurnGate | null>(null)
  const captureRef = useRef<AudioCapture | null>(null)
  const sessionRef = useRef<string | null>(null)
  const sessionPendingRef = useRef<Promise<string | null> | null>(null)
  /** Toda a lógica de sessão (push/stop/turn) serializada — sessões nunca se cruzam. */
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  /** Fala em curso (utterance aberto): chunks vão para a sessão; senão ficam no pre-roll. */
  const speakingRef = useRef(false)
  const prerollRef = useRef<Uint8Array[]>([])
  /**
   * Tempo com VOZ da fala atual (1º → último quadro acima do limiar): vai com o turno e é o que o
   * preâmbulo compara com a fala mínima — o silêncio que fecha o turno e a espera não contam.
   */
  const voicedRef = useRef(new VoicedSpan())
  /** Fala do usuário durante a reprodução: ducking → descartada (curta) × barge-in (insistiu). */
  const holdRef = useRef<PlaybackDuck | null>(null)
  /** Frases da resposta atual que começaram a tocar (barge-in: o histórico fica só com elas). */
  const startedRef = useRef<Set<string>>(new Set())
  /** Texto da fala atual chegando durante o ducking (parcial ao vivo) — o efeito da captura assina. */
  const onDuckTextRef = useRef<((text: string) => void) | null>(null)

  const voice = api.voice

  // ---- sessão de transcrição da fala atual (uma por utterance) ----
  const ensureSession = useCallback((): Promise<string | null> => {
    sessionPendingRef.current ??= (async () => {
      const v = api.voice
      if (!v) return null
      try {
        const id = await v.transcribe.start()
        sessionRef.current = id
        return id
      } catch (err) {
        setError(errorMessage(err))
        return null
      }
    })()
    return sessionPendingRef.current
  }, [])

  const pushChunk = useCallback(
    (bytes: Uint8Array): void => {
      chainRef.current = chainRef.current
        .then(async () => {
          const v = api.voice
          if (!v || !speakingRef.current) return
          const id = await ensureSession()
          if (!v || !id) return
          await v.transcribe.push(id, bytes)
        })
        .catch(() => {
          // falha de push: a finalização da fala reporta o erro (evita unhandled rejection)
        })
    },
    [ensureSession]
  )

  /**
   * Fim da fala: `speech-end` + transcrição final → `voice:call:turn` (texto pode ser vazio).
   * `reuseSpeculative`: o usuário não falou depois da última especulação — ela vira a final.
   */
  const endUtterance = useCallback((reuseSpeculative = false, speechMs?: number): void => {
    void api.voice?.call.speechEnd().catch(() => {})
    chainRef.current = chainRef.current
      .then(async () => {
        const v = api.voice
        if (!v) return
        const pending = sessionPendingRef.current
        sessionPendingRef.current = null
        const id = pending ? await pending : sessionRef.current
        sessionRef.current = null
        if (!id) {
          await v.call.turn({ text: '' }).catch(() => {})
          return
        }
        try {
          // a parcial que já cobre a fala inteira vira a final (latência: sem request)
          const result = await v.transcribe.stop(id, { reuseSpeculative, reusePartial: true })
          // a barra mostra o texto que foi enviado (até a próxima fala)
          setLive(result.text, 'final')
          await v.call.turn({
            text: result.text,
            ...(typeof speechMs === 'number' ? { speechMs: Math.round(speechMs) } : {})
          })
        } catch (err) {
          setError(errorMessage(err))
          await v.call.turn({ text: '' }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  const dropSession = useCallback((): void => {
    chainRef.current = chainRef.current
      .then(async () => {
        const v = api.voice
        const pending = sessionPendingRef.current
        sessionPendingRef.current = null
        const id = pending ? await pending : sessionRef.current
        sessionRef.current = null
        if (v && id) await v.transcribe.cancel(id).catch(() => {})
      })
      .catch(() => {})
  }, [])

  // ---- chamada nova: limpa o erro anterior e confere os clipes (CTA "Gerar clipes" no dock) ----
  useEffect(() => {
    // fim da chamada: o plano da GPU (aviso/VRAM) da pré-checagem não vale mais
    if (!active) {
      useVoiceCallRuntime.setState({ gpuCall: null })
      return
    }
    setError(null)
    void refreshClips()
  }, [active])

  // ---- reprodução das utterances (na ordem; `idle` → playback-idle ao main) ----
  const volumeRef = useRef(volume)
  useEffect(() => {
    volumeRef.current = volume
  }, [volume])
  // parciais ao vivo: a barra mostra o que o usuário está dizendo
  useEffect(() => {
    const off = api.onVoicePartial?.((e) => {
      // só a sessão da fala ATUAL (o ditado e falas anteriores têm outras sessões)
      if (!e.sessionId || e.sessionId !== sessionRef.current) return
      if (e.error && !e.text) return
      const text = typeof e.text === 'string' ? e.text : ''
      if (useStore.getState().voiceCall.active && speakingRef.current) setLive(text, 'partial')
      // fala por cima da resposta (ducking): palavras reais ou "para" confirmam o barge-in já
      onDuckTextRef.current?.(text)
    })
    return () => off?.()
  }, [])
  useEffect(() => {
    if (!active || !voice) return
    const queue = new UtteranceQueue({
      onState: (state) => {
        if (state === 'idle') void api.voice?.call.playbackIdle().catch(() => {})
      },
      // início/fim de cada reprodução entra na timeline da chamada (métricas decisão→áudio)
      onItem: ({ item, phase }) => {
        if (phase === 'start' && (item.kind ?? 'sentence') === 'sentence')
          startedRef.current.add(item.id)
        // leitura ao vivo: a frase tocando (o chat esmaece o que ainda não foi ouvido)
        if ((item.kind ?? 'sentence') === 'sentence' && item.text) {
          if (phase === 'start')
            useVoiceFollow.setState({ current: { id: item.id, text: item.text, chars: 0 } })
          else
            useVoiceFollow.setState((s) => ({
              heard: [...s.heard, item.text!],
              current: s.current?.id === item.id ? null : s.current
            }))
        }
        const kind: VoiceCallTimelineEvent['kind'] =
          item.kind === 'sentence'
            ? phase === 'start'
              ? 'sentence-start'
              : 'sentence-end'
            : phase === 'start'
              ? 'clip-start'
              : 'clip-end'
        useStore.getState().pushVoiceCallTimeline({ ts: Date.now(), kind, id: item.id })
      },
      // utterance que não tocou (CSP/codec/autoplay): na timeline e no erro da barra — nunca calada
      onError: ({ item, reason }) => {
        useStore.getState().pushVoiceCallTimeline({
          ts: Date.now(),
          kind: 'playback-error',
          id: item.id,
          class: item.kind ?? 'sentence',
          reason
        })
        const what =
          item.kind === 'filler'
            ? 'o preâmbulo'
            : item.kind === 'delay'
              ? 'a frase de demora'
              : 'uma frase da resposta'
        // clipe (preâmbulo/frase de demora) não é essencial: pula com o registro no painel; frase
        // da resposta que não toca encerra a chamada (nunca uma resposta muda)
        if (item.kind === 'filler' || item.kind === 'delay') {
          setError(`Não foi possível tocar ${what}: ${reason}`)
          return
        }
        useStore
          .getState()
          .toast(`Chamada encerrada: não foi possível tocar ${what} (${reason})`, 'error')
        void useStore.getState().stopVoiceCall()
      }
    })
    queueRef.current = queue
    queue.setVolume(volumeRef.current)
    const off = api.onVoiceCallUtterance?.((e) => queue.enqueue(e))
    // filler interrompido pela 1ª sentença (ou reset/stop): cancela SÓ essa utterance
    // clipe interrompido (o usuário voltou a falar, turno novo, stop): sai com fade curto
    const offCancel = api.onVoiceCallUtteranceCancel?.((e) => queue.drop(e.id, FADE_MS))
    // resposta nova (fase "Pensando…"/"Transcrevendo…"): as frases ouvidas recomeçam do zero
    let lastPhase = useStore.getState().voiceCall.phase
    const offPhase = useStore.subscribe((st) => {
      const ph = st.voiceCall.phase
      if (ph === lastPhase) return
      lastPhase = ph
      if (ph === 'thinking' || ph === 'transcribing') {
        startedRef.current = new Set()
        resetVoiceFollow()
      }
    })
    // leitura ao vivo: quanto da frase atual já tocou (palavra por palavra, ~10×/s)
    const follow = setInterval(() => {
      const cur = useVoiceFollow.getState().current
      const pos = queue.currentPosition()
      if (!cur || !pos || pos.id !== cur.id) return
      const { chars } = heardChars(cur.text, pos.playedMs, { durationMs: pos.durationMs })
      if (chars !== cur.chars) useVoiceFollow.setState({ current: { ...cur, chars } })
    }, 100)
    // TTS em streaming (PCM progressivo): os pedaços seguintes de cada sentença
    const offChunk = api.onVoiceCallUtteranceChunk?.((e) => queue.pushChunk(e))
    return () => {
      off?.()
      offCancel?.()
      offPhase()
      offChunk?.()
      clearInterval(follow)
      resetVoiceFollow()
      queue.cancel()
      queueRef.current = null
    }
  }, [active, voice])

  // ---- captura contínua + porta de fala (fim de turno adaptativo) ----
  useEffect(() => {
    // GPU ainda preparando: nada de captura (a 1ª fala não pode esperar a carga dos modelos)
    if (!active || !voice || preparing) return
    const timing: TurnTiming = (() => {
      try {
        return { ...DEFAULT_TURN_TIMING, ...(JSON.parse(timingKey) as Partial<TurnTiming>) }
      } catch {
        return DEFAULT_TURN_TIMING
      }
    })()
    // fala detectada pela MESMA regra do portão do STT (`LevelGate`: nível de ativação do
    // microfone + piso de ruído adaptativo): os quadros viram 1 (fala) / 0 (não) antes do gate de
    // turno, do tempo com voz e do ducking — ruído de sala abaixo da ativação nunca abaixa a resposta
    // nem abre um turno. O nível chega com as settings (antes de a captura abrir).
    let level = new LevelGate()
    const VOICED = 1
    const SPEECH = 0.5
    const gate = new AdaptiveTurnGate(timing, SPEECH)
    gateRef.current = gate

    // fala do usuário durante a reprodução: ducking com histerese (`PlaybackDuck` puro) — os
    // limiares vêm de `voiceCallDefaults.turn` (resolvidos no início da chamada)
    const hold = new PlaybackDuck(timing.bargeIn ?? DEFAULT_BARGE_IN)
    holdRef.current = hold
    let disposed = false
    const timeline = (e: Omit<VoiceCallTimelineEvent, 'ts'>): void =>
      useStore.getState().pushVoiceCallTimeline({ ts: Date.now(), ...e })

    /** Barge-in confirmado: para a fala do assistente; a fala do usuário segue como turno. */
    const commitBargeIn = (reason: BargeInReason): void => {
      // barge-in real: cancela a fala do assistente com fade; o main para o turno e deixa no
      // histórico só as frases que começaram a tocar
      const q = queueRef.current
      // ANTES de cancelar: quanto da frase atual tocou (o histórico fica só com as palavras ouvidas)
      const current = q?.currentPosition() ?? null
      q?.cancel(FADE_MS)
      q?.setDuck(1) // o que vier depois (o próximo turno) toca no volume normal
      useVoiceFollow.setState({ current: null }) // o resto não ouvido vai para o marcador
      const playedIds = [...startedRef.current]
      void api.voice?.call
        .bargeIn({
          playedIds,
          reason,
          speechMs: Math.round(hold.voicedMs),
          ...(current ? { current } : {})
        })
        .catch(() => {})
      // daqui em diante é uma fala normal do usuário: fim de turno adaptativo (especulação) volta a
      // valer (antes a fala inteira seguia "retida" — silêncio fixo até o fim dela)
      hold.reset()
    }

    /**
     * O usuário parou antes de confirmar (tosse, "uhum", ruído): o volume volta e o som curto é
     * descartado (nenhum turno; só o registro na timeline).
     */
    const restoreDuck = (): void => {
      const ms = Math.round(hold.voicedMs)
      hold.reset()
      queueRef.current?.setDuck(1, DUCK_FADE_MS)
      speakingRef.current = false
      prerollRef.current = []
      gate.reset()
      dropSession()
      voicedRef.current.reset()
      setLive('', null)
      timeline({ kind: 'duck-restore', speechMs: ms })
      void api.voice?.call.backchannel({ ms }).catch(() => {})
    }
    onDuckTextRef.current = (text: string): void => {
      if (disposed || !hold.open) return
      const ev = hold.transcript(text)
      if (ev === 'barge-in') commitBargeIn(hold.reason ?? 'words')
    }

    /** Geração da especulação pedida na pausa atual (-1 = nenhuma válida — a fala voltou). */
    let askedSeq = -1

    /** Fecha a fala (silêncio cumprido): fala por cima descartada, ou transcrição final → turno. */
    const closeUtterance = (): void => {
      if (hold.open) {
        // a fala por cima acabou sem confirmar o barge-in: volume de volta, som descartado
        restoreDuck()
        return
      }
      speakingRef.current = false
      prerollRef.current = []
      // a especulação pedida nesta pausa cobre toda a fala (o usuário não voltou a falar): ela vira
      // a final — MESMO ainda em voo (especulação pela API é lenta: o turno fecha no silêncio fixo
      // e a final espera a especulação em vez de subir o áudio de novo)
      endUtterance(askedSeq === gate.specSeq && askedSeq > 0, voicedRef.current.spanMs)
      voicedRef.current.reset()
    }

    /** Pausa cruzou ~250 ms: transcrição especulativa (na ordem dos pushes) → veredito. */
    const speculate = (seq: number): void => {
      askedSeq = seq
      chainRef.current = chainRef.current
        .then(async () => {
          const v = api.voice
          const pending = sessionPendingRef.current
          const id = pending ? await pending : sessionRef.current
          if (!v || !id) {
            onVerdict(seq, null)
            return
          }
          // não espera aqui: os pushes seguintes (e o stop) continuam na ordem
          void v.transcribe
            .speculate(id)
            .then((r) => onVerdict(seq, r ? r.text : null))
            .catch(() => onVerdict(seq, null))
        })
        .catch(() => {})
    }

    const onVerdict = (seq: number, text: string | null): void => {
      if (disposed || gateRef.current !== gate || seq !== gate.specSeq || !gate.speaking) return
      const end: UtteranceEnd = text == null ? 'unknown' : classifyUtteranceEnd(text)
      if (text != null) setLive(text, 'speculative')
      useStore.getState().pushVoiceCallTimeline({
        ts: Date.now(),
        kind: 'turn-verdict',
        pauseMs: gate.pauseMs,
        text: (text ?? '').slice(-80),
        reason: end
      })
      if (gate.setVerdict(seq, end) === 'end') closeUtterance()
    }

    const onLevel = (raw: number): void => {
      setLevel(raw)
      const rms = level.pushRms(raw, FRAME_MS) ? VOICED : 0
      const ev = gate.push(rms, FRAME_MS)
      // tempo com voz da fala: zera no início dela e mede só enquanto ela está aberta (o silêncio
      // do fim fica de fora — o span termina no último quadro com voz)
      if (ev === 'start') voicedRef.current.reset()
      if (ev === 'start' || speakingRef.current) voicedRef.current.push(rms, FRAME_MS, SPEECH)
      if (ev === 'resume') askedSeq = -1 // a especulação ficou velha (a fala continuou)
      if (ev === 'start') {
        const queue = queueRef.current
        const cur = queue?.current ?? null
        const sentencePlaying = !!cur && (cur.kind ?? 'sentence') === 'sentence'
        const mainSpeaking = useStore.getState().voiceCall.phase === 'speaking'
        const heard = startedRef.current.size > 0
        if (queue && (sentencePlaying || (heard && mainSpeaking))) {
          // fala do usuário durante a resposta já ouvida: o áudio do assistente ABAIXA e continua
          // (nada é cancelado até o usuário insistir — voz/palavras/"para")
          hold.start(rms, FRAME_MS, SPEECH)
          queue.setDuck(hold.cfg.duckGain, DUCK_FADE_MS)
          timeline({ kind: 'duck', speechMs: Math.round(hold.voicedMs) })
        } else {
          // nada da resposta foi ouvido (só preâmbulo/frase de demora, ou frases ainda na fila):
          // tudo sai com fade e o main decide o turno continuado
          const dropped = queue ? [...(cur ? [cur.id] : []), ...queue.queuedIds] : []
          if (dropped.length) queue?.cancel(FADE_MS)
          void api.voice?.call.speechBegin({ dropped }).catch(() => {})
        }
        // fala nova: a parcial/especulação da fala anterior não vale mais
        askedSeq = -1
        setLive('', null)
        speakingRef.current = true
        for (const bytes of prerollRef.current.splice(0)) pushChunk(bytes)
        return
      }
      if (ev === 'speculate') {
        // fala retida durante a reprodução (backchannel × barge-in): sem especulação — silêncio fixo
        if (hold.open) {
          if (gate.setVerdict(gate.specSeq, 'unknown') === 'end') closeUtterance()
        } else speculate(gate.specSeq)
        return
      }
      if (ev === 'end') {
        closeUtterance()
        return
      }
      if (hold.open) {
        const ev = hold.frame(rms, FRAME_MS, SPEECH)
        if (ev === 'barge-in') commitBargeIn(hold.reason ?? 'voiced')
        else if (ev === 'restore') restoreDuck()
      }
    }
    const onPcm = (chunk: Int16Array): void => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      if (speakingRef.current) {
        pushChunk(bytes)
        return
      }
      const preroll = prerollRef.current
      preroll.push(bytes)
      if (preroll.length > PREROLL_MAX) preroll.shift()
    }

    /** A chamada acabou porque o microfone falhou: o dock some junto, então o motivo vira toast. */
    const failCall = (message: string): void => {
      setError(message)
      useStore.getState().toast(`Chamada de voz encerrada: ${message}`, 'error')
      void useStore.getState().stopVoiceCall()
    }

    if (MOCK) {
      // sem microfone no mock: os estados/utterances vêm do binding `voice` simulado
      const mode = mockMicMode()
      if (!muted && (mode === 'denied' || mode === 'none' || mode === 'busy')) {
        const name =
          mode === 'denied'
            ? 'NotAllowedError'
            : mode === 'none'
              ? 'NotFoundError'
              : 'NotReadableError'
        failCall(captureErrorText({ name, message: '' }))
      }
      return () => {
        disposed = true
        gateRef.current = null
      }
    }

    const startCapture = async (): Promise<void> => {
      // settings frescas (microfone) ANTES de abrir — a limpeza do efeito pode chegar no meio
      const all = await loadVoiceSettings()
      if (disposed) return
      level = new LevelGate({ activationDb: all.audioInput.activationDb })
      const capture = new AudioCapture({ silence: false })
      captureRef.current = capture
      capture.on('level', onLevel)
      capture.on('pcm', onPcm)
      capture.on('error', (e) => setError(captureErrorText(e)))
      capture.on('ended', () => {
        // microfone desconectado: encerra a chamada (o main volta ao repouso) e avisa
        if (captureRef.current !== capture) return
        captureRef.current = null
        failCall('o microfone foi desconectado.')
      })
      try {
        await capture.start(all.audioInput.deviceId)
        if (disposed) {
          void capture.stop().catch(() => {})
          return
        }
        if (capture.fellBack) useStore.getState().toast(MIC_FALLBACK_NOTICE, 'info')
      } catch (cause) {
        if (captureRef.current === capture) captureRef.current = null
        // limpeza do efeito (mudo, troca de silêncio, fim da chamada) interrompeu o start: normal
        if (disposed) return
        failCall(captureErrorText(cause as Error))
      }
    }
    if (!muted) void startCapture()

    return () => {
      disposed = true
      gateRef.current = null
      speakingRef.current = false
      prerollRef.current = []
      gate.reset()
      hold.reset()
      queueRef.current?.setDuck(1)
      holdRef.current = null
      onDuckTextRef.current = null
      dropSession()
      const capture = captureRef.current
      captureRef.current = null
      if (capture) void capture.stop().catch(() => {})
    }
  }, [active, voice, timingKey, muted, preparing, pushChunk, endUtterance, dropSession])

  const toggleMute = useCallback(async (): Promise<void> => {
    const next = !useStore.getState().voiceCall.muted
    if (next) {
      // captura pausada: microfone liberado; a fala em curso é descartada
      speakingRef.current = false
      prerollRef.current = []
      gateRef.current?.reset()
      holdRef.current?.reset()
      dropSession()
      const capture = captureRef.current
      captureRef.current = null
      if (capture) await capture.stop().catch(() => {})
    }
    // (des)mudo: a captura liga/desliga pelo efeito acima, que reage a `voiceCall.muted`
    await useStore.getState().setVoiceCallMuted(next)
    setLevel(0)
  }, [dropSession])

  const setVolume = useCallback((v: number): void => {
    const value = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
    useVoiceCallRuntime.setState({ volume: value })
    queueRef.current?.setVolume(value)
  }, [])

  const clearError = useCallback((): void => setError(null), [])

  /** "Gerar clipes" do dock: mesmos clipes de Configurações → Áudio (voz atual), com progresso. */
  const generateClips = useCallback(async (): Promise<void> => {
    const v = api.voice
    if (!v) return
    useVoiceCallRuntime.setState({ clips: 'generating', clipsProgress: { done: 0, total: 0 } })
    const off = api.onVoiceTtsClipsProgress?.((e) =>
      useVoiceCallRuntime.setState({ clipsProgress: { done: e.done, total: e.total } })
    )
    try {
      const m = await v.tts.clips.generate()
      useVoiceCallRuntime.setState({ clips: m.clips.length > 0 ? 'ok' : 'missing' })
    } catch (err) {
      useVoiceCallRuntime.setState({ clips: 'missing' })
      setError(`Não foi possível gerar os clipes de voz: ${errorMessage(err)}`)
    } finally {
      off?.()
      useVoiceCallRuntime.setState({ clipsProgress: null })
    }
  }, [])

  useEffect(() => {
    useVoiceCallRuntime.setState({ toggleMute, setVolume, clearError, generateClips })
  }, [toggleMute, setVolume, clearError, generateClips])
}
