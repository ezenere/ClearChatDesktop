// Ditado por voz (renderer): orquestra a sessão de transcrição (`window.api.voice`) sobre a captura
// (`usePushToTalk` → `AudioCapture`) e as parciais ao vivo (`onVoicePartial`). Um fluxo por vez:
// clique/tecla do PTT inicia, `stop()` (ou soltar a tecla/silêncio) transcreve e devolve o texto
// final via `onFinal` (o envio é sempre manual — este hook nunca envia mensagem).
//
// A sessão de transcrição é criada de forma preguiçosa no PRIMEIRO CHUNK de áudio (clique e tecla
// do PTT seguem o mesmo caminho): uma captura que falha ao abrir (permissão, microfone ausente)
// nunca deixa sessão órfã no main. Os chunks esperam a sessão numa cadeia de promises (push em
// ordem) e o `stop` espera a cadeia antes de transcrever. A finalização tem um TOKEN: "Cancelar"
// (ou desmontar o composer, ou a UI do ditado ficar bloqueada) durante o "Transcrevendo…" cancela
// a sessão no main e o texto NÃO entra no rascunho.
//
// Build de desenvolvimento com `VITE_CLEAR_MOCK=1`: sem captura (não há microfone no mock) — o
// binding `voice` do mock emite as parciais e devolve o texto fixo; o `Waveform` simula os níveis
// e `window.__clearMockMic` (definido pelo cenário do mock) simula falhas do microfone.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AudioInputSettings, SttSettings } from '@shared/voice'
import type { VoiceApi, VoiceLayersInput } from '@shared/ipc'
import { api, errorMessage } from '../api'
import { useStore } from '../../store'
import { usePushToTalk, type StopReason } from '../audio/usePushToTalk'
import {
  captureErrorText,
  MIC_FALLBACK_NOTICE,
  MIC_LOST_TEXT,
  type DictationSettle
} from './dictation'
import { loadVoiceSettings, saveVoiceSetting, useVoiceSettings } from './voiceSettings'
import { prepareGpuForDictation, useDictationGpuPreparing } from './gpu/gpuPrepare'

export type { StopReason } from '../audio/usePushToTalk'
export type { DictationSettle } from './dictation'

/** Estado do ditado na UI (um por vez). */
export type DictationState = 'idle' | 'starting' | 'recording' | 'stopping'

const MOCK = import.meta.env.VITE_CLEAR_MOCK === '1'

export interface UseDictationOptions {
  /** Texto final transcrito (rascunho normal editável). Nunca é enviado automaticamente. */
  onFinal: (text: string) => void
  /**
   * Fim de cada fluxo (depois do `onFinal`, quando houver): `final` | `empty` | `failed` |
   * `cancelled` — o Composer decide aí o desfecho do "Enviar" durante a gravação.
   */
  onSettled?: (settle: DictationSettle) => void
  /**
   * UI do ditado escondida/bloqueada (chamada de voz, pergunta/retry pendente, host offline,
   * Configurações abertas): a tecla do PTT fica desligada e uma gravação em curso é CANCELADA.
   */
  suspended?: boolean
  /**
   * Camadas de voz do chat (protocolo 1.9.0): a transcrição do ditado é a da persona/chat neste
   * dispositivo (o main resolve — indisponível aqui → a deste dispositivo).
   */
  voice?: VoiceLayersInput | null
  /** Transcrição EFETIVA do chat (da resolução) — decide o auto-start da GPU. Ausente = a daqui. */
  sttSettings?: SttSettings | null
  /**
   * Motivo de o ditado não funcionar neste dispositivo (nem a transcrição da persona/chat nem a
   * daqui): iniciar (clique/tecla do PTT) mostra o motivo em vez de gravar. null = disponível.
   */
  unavailable?: string | null
}

export interface DictationControls {
  state: DictationState
  /** Nível RMS ao vivo (0..1) para o `Waveform`. */
  level: number
  /**
   * Parcial ao vivo acumulada (melhor-esforço); '' = nenhuma. Nunca entra no texto editável. Fica
   * visível durante o "finalizando…" (o texto nunca some ao parar) até a final substituí-la.
   */
  partial: string
  /**
   * A final falhou mas há texto parcial: o Composer oferece inseri-lo (`insertPartial`) em vez de
   * perder o que já tinha sido transcrito.
   */
  partialRecoverable: boolean
  /** Insere o texto parcial (final falhou) no rascunho. */
  insertPartial: () => void
  /** Erro legível (permissão negada, mic indisponível, STT fora do ar); null = sem erro. */
  error: string | null
  /** Dispensa o erro (inclui o da captura) e o aviso. */
  clearError: () => void
  /** Aviso não bloqueante (microfone salvo ausente → padrão; mic perdido; parciais desligadas). */
  notice: string | null
  clearNotice: () => void
  /** Settings de entrada de áudio usadas na próxima gravação (padrões enquanto carrega). */
  settings: AudioInputSettings
  /** Grava um patch de `audioInput` (ex.: microfone do menu) e atualiza o estado local. */
  updateSettings: (patch: Partial<AudioInputSettings>) => Promise<void>
  /** Recarrega `audioInput` do main (chamado quando as Configurações fecham). */
  reload: () => void
  /** `window.api.voice` existe (sem ele o botão de microfone não aparece). */
  available: boolean
  /**
   * Ditado na GPU local esperando o servidor subir (auto-start da GPU): o campo mostra
   * "Preparando a GPU…" antes do "Ouvindo…". Opcional — preenchido pelo auto-start da GPU.
   */
  preparingGpu?: boolean
  start: () => Promise<void>
  /** Para e transcreve (texto final → `onFinal`). */
  stop: () => Promise<void>
  /** Cancela e descarta (nada vai para o rascunho) — inclusive durante o "Transcrevendo…". */
  cancel: () => Promise<void>
}

/** Mock de UI: falhas simuladas do microfone (`window.__clearMockMic`, definido pelo cenário). */
function mockMicOpen(deviceId: string | null): boolean {
  const mode = (window as unknown as { __clearMockMic?: string }).__clearMockMic ?? 'ok'
  const fail = (name: string, message: string): Error => Object.assign(new Error(message), { name })
  if (mode === 'denied') throw fail('NotAllowedError', 'Permission denied')
  if (mode === 'none') throw fail('NotFoundError', 'Requested device not found')
  if (mode === 'busy') throw fail('NotReadableError', 'Could not start audio source')
  // microfone salvo que sumiu: a captura real cai no padrão (OverconstrainedError → padrão)
  return mode === 'missing' && !!deviceId
}

export function useDictation(options: UseDictationOptions): DictationControls {
  const voice: VoiceApi | undefined = api.voice
  const settings = useVoiceSettings((s) => s.view.audioInput)
  const [partial, setPartial] = useState('')
  const partialRef = useRef('')
  const [partialRecoverable, setPartialRecoverable] = useState(false)
  const recoverableRef = useRef(false)
  useEffect(() => {
    partialRef.current = partial
    recoverableRef.current = partialRecoverable
  }, [partial, partialRecoverable])
  const [errorState, setErrorState] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [mockRecording, setMockRecording] = useState(false)
  const suspended = !!options.suspended

  const optionsRef = useRef(options)
  const settingsRef = useRef(settings)
  const voiceRef = useRef(voice)
  /** A UI ficou bloqueada: soltar a tecla (efeito do PTT) também descarta, não transcreve. */
  const suspendedRef = useRef(suspended)
  // layout effect: atualiza antes da limpeza (passiva) do efeito da tecla do PTT no mesmo commit
  useLayoutEffect(() => {
    suspendedRef.current = suspended
  }, [suspended])
  useEffect(() => {
    optionsRef.current = options
    settingsRef.current = settings
    voiceRef.current = voice
  })
  /** Sessão atual (promise de criação + id resolvido) — uma por vez. */
  const sessionPromiseRef = useRef<Promise<string | null> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const pushChainRef = useRef<Promise<void>>(Promise.resolve())
  const cancelRef = useRef(false)
  /** Finalização em voo ("Transcrevendo…"): `cancelled` = o texto final é descartado. */
  const finalizeRef = useRef<{ id: string; cancelled: boolean } | null>(null)
  /** Geração do fluxo atual: `stop`/`cancel` invalidam um `start` em voo. */
  const genRef = useRef(0)
  const mountedRef = useRef(true)
  const mockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** A sessão de transcrição falhou ao nascer neste fluxo (fim sem sessão = falha, não silêncio). */
  const sessionFailedRef = useRef(false)
  const settle = useCallback((s: DictationSettle): void => {
    if (mountedRef.current) optionsRef.current.onSettled?.(s)
  }, [])

  // ---- settings de entrada (recarrega ao fechar as Configurações — a tela Áudio grava por lá) ----
  const settingsOpen = useStore((s) => s.settingsOpen)
  const reload = useCallback((): void => {
    void loadVoiceSettings()
  }, [])
  useEffect(() => {
    if (!settingsOpen) reload()
  }, [settingsOpen, reload])

  const updateSettings = useCallback(async (patch: Partial<AudioInputSettings>) => {
    try {
      await saveVoiceSetting('audioInput', { ...settingsRef.current, ...patch })
    } catch (err) {
      setErrorState(`Não foi possível salvar o microfone: ${errorMessage(err)}`)
    }
  }, [])

  // ---- sessão de transcrição (criação preguiçosa no 1º chunk; uma por vez) ----
  const ensureSession = useCallback((): Promise<string | null> => {
    sessionPromiseRef.current ??= (async () => {
      const v = voiceRef.current
      if (!v) return null
      try {
        const layers = optionsRef.current.voice
        const id = await v.transcribe.start(
          settingsRef.current.language,
          layers ? { voice: layers } : undefined
        )
        sessionIdRef.current = id
        return id
      } catch (err) {
        sessionFailedRef.current = true
        setErrorState(errorMessage(err))
        return null
      }
    })()
    return sessionPromiseRef.current
  }, [])

  const dropSession = useCallback(async (): Promise<void> => {
    const pending = sessionPromiseRef.current
    sessionPromiseRef.current = null
    const id = pending ? await pending : sessionIdRef.current
    sessionIdRef.current = null
    if (id) await voiceRef.current?.transcribe.cancel(id).catch(() => {})
  }, [])

  /** Descarta a finalização em voo (texto final não entra no rascunho) e cancela a sessão no main. */
  const abortFinalize = useCallback((): boolean => {
    const fin = finalizeRef.current
    if (!fin || fin.cancelled) return false
    fin.cancelled = true
    void voiceRef.current?.transcribe.cancel(fin.id).catch(() => {})
    if (mountedRef.current) setFinalizing(false)
    return true
  }, [])

  // ---- parciais ao vivo (só da sessão atual) + aviso de parciais desligadas ----
  useEffect(() => {
    const off = api.onVoicePartial
    if (!off) return
    return off((e) => {
      if (!e.sessionId || e.sessionId !== sessionIdRef.current || e.isFinal) return
      if (e.error) setNotice(e.error)
      if (e.text) setPartial(e.text)
    })
  }, [])

  // ---- fim da captura (qualquer motivo): transcreve o final ou descarta (cancel) ----
  const handleStopped = useCallback(
    async (reason: StopReason): Promise<void> => {
      // o flag de cancelamento é consumido aqui (um cancel tardio não pode poluir o fluxo seguinte)
      const doCancel =
        cancelRef.current ||
        reason === 'unmount' ||
        (reason === 'ptt-release' && suspendedRef.current) ||
        !mountedRef.current
      cancelRef.current = false
      if (mockTimerRef.current) clearTimeout(mockTimerRef.current)
      mockTimerRef.current = null
      const pending = sessionPromiseRef.current
      sessionPromiseRef.current = null
      const id = pending ? await pending : sessionIdRef.current
      // a parcial CONTINUA visível ("finalizando…") até a final chegar — nunca some ao parar
      if (reason === 'device-lost' && mountedRef.current) setNotice(MIC_LOST_TEXT)
      const v = voiceRef.current
      if (!id || !v) {
        sessionIdRef.current = null
        if (mountedRef.current) setPartial('')
        settle(doCancel ? 'cancelled' : sessionFailedRef.current ? 'failed' : 'empty')
        return
      }
      if (doCancel) {
        sessionIdRef.current = null
        if (mountedRef.current) setPartial('')
        settle('cancelled')
        await v.transcribe.cancel(id).catch(() => {})
        return
      }
      const token = { id, cancelled: false }
      finalizeRef.current = token
      setFinalizing(true)
      try {
        await pushChainRef.current
        if (token.cancelled) return
        // segmentos já transcritos em segundo plano: a final é só o trecho depois da última pausa
        // (ou nenhuma request, quando a parcial já cobre a fala inteira — `reusePartialFinal`)
        const result = await v.transcribe.stop(id)
        sessionIdRef.current = null
        // "Cancelar" (ou desmontagem/bloqueio) durante o "Transcrevendo…": descarta o texto
        if (token.cancelled || !mountedRef.current) return
        // a final substitui a parcial no mesmo lugar (sem piscar vazio)
        if (result.text) optionsRef.current.onFinal(result.text)
        setPartial('')
        settle(result.text?.trim() ? 'final' : 'empty')
      } catch (err) {
        sessionIdRef.current = null
        if (!token.cancelled && mountedRef.current) {
          setErrorState(errorMessage(err))
          // o texto parcial fica guardado e pode ser inserido (nada do que foi dito se perde)
          if (partialRef.current.trim()) setPartialRecoverable(true)
          else setPartial('')
          settle('failed')
        }
      } finally {
        if (finalizeRef.current === token) finalizeRef.current = null
        if (!token.cancelled && mountedRef.current) setFinalizing(false)
      }
    },
    [settle]
  )

  // ---- captura (real): chunks PCM16 → push em ordem na sessão ----
  const onPcmChunk = useCallback(
    (chunk: Int16Array): void => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      pushChainRef.current = pushChainRef.current
        .then(async () => {
          const v = voiceRef.current
          const id = await ensureSession()
          if (!v || !id) return
          await v.transcribe.push(id, bytes)
        })
        .catch(() => {
          // falha de push: a sessão/finalização reporta o erro; evita unhandled rejection
        })
    },
    [ensureSession]
  )

  const ptt = usePushToTalk(MOCK ? { ...settings, pttEnabled: false } : settings, {
    onPcmChunk,
    onStopped: (reason) => void handleStopped(reason),
    onFallback: () => setNotice(MIC_FALLBACK_NOTICE),
    // transcrição indisponível neste dispositivo: a tecla do PTT não grava (o mic mostra o motivo)
    suspended: suspended || !!options.unavailable
  })

  const pttStop = ptt.stop
  const pttStart = ptt.start
  const pttState = ptt.state
  const pttClearError = ptt.clearError

  const error = errorState ?? ptt.error

  const captureActive = MOCK ? mockRecording : pttState === 'recording'
  const captureStopping = MOCK ? false : pttState === 'stopping'
  const state: DictationState =
    captureStopping || finalizing
      ? 'stopping'
      : captureActive
        ? 'recording'
        : starting
          ? 'starting'
          : 'idle'

  const start = useCallback(async (): Promise<void> => {
    if (state !== 'idle' || suspendedRef.current) return
    const gen = ++genRef.current
    setErrorState(null)
    pttClearError()
    setNotice(null)
    setPartial('')
    setPartialRecoverable(false)
    cancelRef.current = false
    sessionFailedRef.current = false
    const v = voiceRef.current
    if (!v) {
      setErrorState('API de voz indisponível neste build.')
      return
    }
    // nem a transcrição da persona/chat nem a deste dispositivo funcionam aqui: o motivo, sem gravar
    const unavailable = optionsRef.current.unavailable
    if (unavailable) {
      setErrorState(unavailable)
      settle('failed')
      return
    }
    setStarting(true)
    try {
      // settings FRESH nesta gravação (a tela Configurações → Áudio pode ter mudado tudo)
      const all = await loadVoiceSettings()
      settingsRef.current = all.audioInput
      // transcrição na GPU local: o servidor liga sozinho (whisper aquecido) em paralelo à
      // gravação — o áudio espera na sessão; falha ao subir vira o erro do ditado
      void prepareGpuForDictation(optionsRef.current.sttSettings ?? all.sttSettings).catch(
        (err: unknown) => {
          if (gen === genRef.current && mountedRef.current)
            setErrorState(`Transcrição (GPU local): ${errorMessage(err)}`)
        }
      )
      if (gen !== genRef.current) return // stop/cancel enquanto carregava
      if (MOCK) {
        if (mockMicOpen(settingsRef.current.deviceId)) setNotice(MIC_FALLBACK_NOTICE)
        setMockRecording(true)
        // sem chunks no mock: a sessão nasce já (equivale ao 1º chunk da captura real)
        void ensureSession()
        if ((window as unknown as { __clearMockMic?: string }).__clearMockMic === 'lost') {
          mockTimerRef.current = setTimeout(() => {
            setMockRecording(false)
            void handleStopped('device-lost')
          }, 1500)
        }
      } else {
        // a sessão de transcrição só nasce no 1º chunk (falha ao abrir o mic = nada no main)
        await pttStart(settingsRef.current)
      }
    } catch (err) {
      await dropSession()
      setErrorState(captureErrorText(err as Error))
      settle('failed')
    } finally {
      setStarting(false)
    }
  }, [state, ensureSession, dropSession, pttStart, pttClearError, handleStopped, settle])

  const stop = useCallback(async (): Promise<void> => {
    genRef.current++
    if (MOCK) {
      if (!mockRecording) return
      setMockRecording(false)
      await handleStopped('manual')
      return
    }
    await pttStop()
    // a captura ainda não existia (onStopped não rodou): encerra a sessão aqui
    if (sessionPromiseRef.current && pttState === 'idle') await handleStopped('manual')
  }, [mockRecording, handleStopped, pttStop, pttState])

  const cancel = useCallback(async (): Promise<void> => {
    genRef.current++
    setPartial('')
    setPartialRecoverable(false)
    // "Transcrevendo…": o token descarta o texto e a sessão é cancelada no main
    if (abortFinalize()) {
      settle('cancelled')
      return
    }
    if (MOCK) {
      if (!mockRecording) {
        await dropSession()
        settle('cancelled')
        return
      }
      cancelRef.current = true
      setMockRecording(false)
      await handleStopped('manual')
      return
    }
    if (pttState === 'idle' && !starting) {
      await dropSession()
      settle('cancelled')
      return
    }
    cancelRef.current = true
    await pttStop()
    // onStopped não chegou a rodar (a captura ainda não existia): descarta aqui
    if (sessionPromiseRef.current) {
      cancelRef.current = false
      await dropSession()
      settle('cancelled')
    }
  }, [
    mockRecording,
    handleStopped,
    dropSession,
    pttStop,
    pttState,
    starting,
    abortFinalize,
    settle
  ])

  // UI bloqueada no meio da gravação (pergunta/retry, chamada, host offline): descarta
  const cancelLatest = useRef(cancel)
  useEffect(() => {
    cancelLatest.current = cancel
  }, [cancel])
  useEffect(() => {
    if (suspended && state !== 'idle') void cancelLatest.current()
  }, [suspended, state])

  // Desmontagem (troca de chat no meio da gravação/transcrição): descarta tudo — nunca paga uma
  // transcrição que não teria onde entrar. A captura é liberada pelo próprio `usePushToTalk`
  // (motivo 'unmount' → `handleStopped` cancela a sessão).
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (mockTimerRef.current) clearTimeout(mockTimerRef.current)
      const fin = finalizeRef.current
      if (fin && !fin.cancelled) {
        fin.cancelled = true
        void voiceRef.current?.transcribe.cancel(fin.id).catch(() => {})
      }
      void dropSession()
    }
  }, [dropSession])

  const clearError = useCallback(() => {
    setErrorState(null)
    pttClearError()
    setNotice(null)
    // dispensar o erro da final descarta também o texto parcial guardado (só ele — a parcial de
    // uma gravação em curso continua)
    if (recoverableRef.current) setPartial('')
    setPartialRecoverable(false)
  }, [pttClearError])
  const insertPartial = useCallback(() => {
    const text = partialRef.current.trim()
    if (text) optionsRef.current.onFinal(text)
    setPartial('')
    setPartialRecoverable(false)
    setErrorState(null)
  }, [])
  const clearNotice = useCallback(() => setNotice(null), [])

  // auto-start da GPU (transcrição `gpu`): "preparando a GPU…" — texto em `useDictationGpuPreparing()`
  const gpuPreparing = useDictationGpuPreparing()
  return useMemo(
    () => ({
      state,
      level: ptt.level,
      partial,
      partialRecoverable,
      insertPartial,
      error,
      clearError,
      notice,
      clearNotice,
      settings,
      updateSettings,
      reload,
      available: !!voice,
      preparingGpu: !!gpuPreparing,
      start,
      stop,
      cancel
    }),
    [
      state,
      ptt.level,
      partial,
      partialRecoverable,
      insertPartial,
      error,
      clearError,
      notice,
      clearNotice,
      settings,
      updateSettings,
      reload,
      voice,
      gpuPreparing,
      start,
      stop,
      cancel
    ]
  )
}
