import {
  ArrowUp,
  Check,
  Info,
  Lightbulb,
  Mic,
  Paperclip,
  Square,
  TriangleAlert,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { modalityWarning } from '@shared/attachments'
import type { Chat, QueuedMessage, Session } from '@shared/types'
import { api } from '../../lib/api'
import { cn } from '../../lib/format'
import { splitInterChatText } from '@shared/interChat'
import { splitSiblingText } from '@shared/siblings'
import {
  isBusy,
  selectPendingAttachments,
  selectPendingSkills,
  selectQueue,
  useStore
} from '../../store'
import { ComposerInfo, QueueInfo } from '../apiDocs'
import { Tip } from '../ui/Tooltip'
import { AutoTextarea, Spinner } from '../ui/controls'
import { ComposerAttachmentChip } from './Attachments'
import { useAttachmentSupport } from './attachmentSupport'
import { useHistoryIncompatibility } from '../../lib/chatCompat'
import { CompactBanner, ContextMeter } from './ContextMeter'
import { QuestionForm } from './AskUser'
import { RetryForm } from './RetryCard'
import { PendingBar } from './PendingBar'
import { SkillChip, SkillPickerButton } from '../skills/SkillPicker'
import { skillsConfigOf } from '../../lib/skills'
import {
  HostComposerLine,
  HostIndicator,
  HostOfflineCard,
  OutdatedHostsBanner
} from '../sync/ChatHost'
import { useHostInfo } from '../sync/hooks'
import { sessionProviderId } from '@shared/models'
import { ModelPill } from './ModelPill'
import { SpendButton } from './SpendButton'
import { BarLevelsContext, barAttrs, useBarCollapse, useBarLevel } from '../../lib/useBarCollapse'
import { useDictation } from '../../lib/voice/useDictation'
import { useChatVoiceLayers, useVoiceResolution } from '../../lib/voice/voiceResolution'
import { dictationUnavailableText, voiceFallbackNote } from '../../lib/voice/voiceChoice'
import { useDictationGpuPreparing } from '../../lib/voice/gpu/gpuPrepare'
import {
  insertDictationText,
  planDictationCommit,
  rebaseDictationAnchor,
  SEND_FINAL_SLOW_NOTE,
  SEND_FINAL_TIMEOUT_MS,
  type DictationAnchor,
  type DictationSettle
} from '../../lib/voice/dictation'
import { DictationDraft } from '../voice/DictationDraft'
import { VoiceGroup } from '../voice/MicControls'
import { VoiceCallDock, VoiceCallElsewhere } from '../voice/VoiceCallDock'
import { Waveform } from '../voice/Waveform'

/** Estado do agente na barra do composer; recolhido, só o ponto (o texto vai no tooltip). */
function ComposerStatus({ text }: { text: string }): React.JSX.Element {
  const level = useBarLevel('composer-status')
  const dot = (
    <span className="size-1.5 shrink-0 animate-pulse-soft rounded-full bg-accent-strong" />
  )
  if (level > 0)
    return (
      <Tip label={text}>
        <span
          {...barAttrs('composer-status', level)}
          data-testid="composer-status"
          aria-label={text}
          className="flex h-4 items-center px-1"
        >
          {dot}
        </span>
      </Tip>
    )
  return (
    <span
      {...barAttrs('composer-status', level)}
      data-testid="composer-status"
      className="flex items-center gap-1.5 text-subtle"
    >
      {dot}
      {text}
    </span>
  )
}

/** Ícone do host (local/remoto, só com sync) — recolhível: some antes do grupo de voz. */
function ComposerHost({ chat }: { chat: Chat }): React.JSX.Element {
  const level = useBarLevel('composer-host')
  return (
    <span {...barAttrs('composer-host', level)} className="flex shrink-0 empty:hidden">
      {level < 2 && <HostIndicator chat={chat} />}
    </span>
  )
}

/** `</>` "Sua mensagem" (o que vai para a API) — recolhível: some antes do grupo de voz. */
function ComposerApiInfo({ running }: { running: boolean }): React.JSX.Element {
  const level = useBarLevel('composer-info')
  return (
    <span {...barAttrs('composer-info', level)} className="flex shrink-0 empty:hidden">
      {level < 2 && <ComposerInfo running={running} />}
    </span>
  )
}

/** "Enter envia · Shift+Enter quebra linha" — o primeiro a sair quando falta espaço. */
function ComposerHint(): React.JSX.Element {
  const level = useBarLevel('composer-hint')
  return (
    <span {...barAttrs('composer-hint', level)} data-testid="composer-hint">
      {level === 0 && (
        <>
          <span className="text-subtle">Enter</span> envia ·{' '}
          <span className="text-subtle">Shift+Enter</span> quebra linha
        </>
      )}
    </span>
  )
}

/**
 * Rascunhos dos composers escondidos pela chamada de voz quando o usuário troca de chat no meio
 * dela (o composer desmonta): voltam intactos ao reabrir o chat.
 */
const callDrafts = new Map<string, string>()
function takeCallDraft(sessionId: string): string {
  const t = callDrafts.get(sessionId) ?? ''
  callDrafts.delete(sessionId)
  return t
}

/** Nome para imagens coladas da área de transferência (o navegador entrega sempre "image.png"). */
function pastedName(file: File, i: number): File {
  if (file.name && file.name !== 'image.png') return file
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
  const name = `colado-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${i ? `-${i + 1}` : ''}.${ext}`
  return new File([file], name, { type: file.type })
}

/** Origem de um item da fila que não foi digitado pelo usuário (outro chat, pai, subagente). */
function queueOrigin(item: QueuedMessage): { label: string; text: string } | null {
  const kind = item.meta?.kind
  if (kind === 'inter-chat')
    return {
      label: `De: ${item.meta?.fromChatTitle || 'outro chat'}`,
      text: splitInterChatText(item.text).body
    }
  if (kind === 'parent-message')
    return { label: 'Agente pai', text: item.text.replace(/^\[Mensagem do agente pai\]\n/, '') }
  if (kind === 'sibling-message' || kind === 'sibling-broadcast') {
    const { title, body } = splitSiblingText(item.text)
    const who = title || 'Subagente'
    return {
      label:
        kind === 'sibling-broadcast' ? `Broadcast do irmão ${who}` : `Mensagem do irmão ${who}`,
      text: body
    }
  }
  if (kind === 'subagent-callback')
    return { label: 'Resultado de subagente', text: item.text.split('\n')[0] }
  return null
}

function QueueChip({ item }: { item: QueuedMessage }): React.JSX.Element {
  const run = useStore((s) => s.run)
  const origin = queueOrigin(item)
  return (
    <div className="group relative max-w-[280px] min-w-[140px] animate-pop-in rounded-xl border border-border bg-elevated/90 py-2 pr-12 pl-3 shadow-[0_4px_16px_-8px_rgb(0_0_0/0.6)]">
      {origin && (
        <p className="mb-0.5 truncate text-[10.5px] font-medium text-accent-strong/90">
          {origin.label}
        </p>
      )}
      <p className="line-clamp-2 text-[12.5px] leading-snug text-fg/85">
        {origin ? origin.text : item.text}
      </p>
      {item.skillParts?.length ? (
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-subtle">
          <Lightbulb className="size-3 shrink-0" />
          {item.skillParts
            .flatMap((p) => (p.type === 'text' && p._skill ? [p._skill.name] : []))
            .join(', ')}
        </p>
      ) : null}
      {item.attachments?.length ? (
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-subtle">
          <Paperclip className="size-3 shrink-0" />
          {item.attachments.map((a) => a.name).join(', ')}
        </p>
      ) : null}
      <div className="absolute top-1 right-1 flex items-center">
        <Tip label="Enviar agora (interrompe o agente)">
          <button
            type="button"
            onClick={() => void run(() => api.agent.forceSend(item.id), 'Falha ao forçar envio')}
            className="rounded-md p-1 text-warning/80 transition-colors hover:bg-warning/10 hover:text-warning"
            aria-label="Enviar agora"
          >
            <Zap className="size-3.5" fill="currentColor" fillOpacity={0.25} />
          </button>
        </Tip>
        <Tip label="Remover da fila">
          <button
            type="button"
            onClick={() => void run(() => api.agent.removeQueued(item.id), 'Falha ao remover')}
            className="rounded-md p-1 text-subtle transition-colors hover:bg-hover hover:text-fg"
            aria-label="Remover da fila"
          >
            <X className="size-3.5" />
          </button>
        </Tip>
      </div>
    </div>
  )
}

export function Composer({
  session,
  autoFocus
}: {
  session: Session
  autoFocus?: boolean
}): React.JSX.Element {
  const queue = useStore(selectQueue(session.id))
  const chat = useStore((s) => s.chats.find((c) => c.id === session.chatId))
  const compaction = useStore((s) => s.compactions[session.id])
  const send = useStore((s) => s.send)
  const run = useStore((s) => s.run)
  const busy = isBusy(session.status)
  /** Questionário (ask_user) pendente nesta sessão: substitui o campo de texto. */
  const question = useStore((s) => s.questions.find((q) => q.sessionId === session.id))
  /** Falha de conexão aguardando decisão nesta sessão: card no lugar do campo de texto. */
  const retry = useStore((s) => s.retries.find((r) => r.sessionId === session.id))
  const blocked = !!question || !!retry
  const host = useHostInfo(session.chatId)
  const hostOffline = host?.mode === 'host-offline'
  // rascunho guardado enquanto a chamada escondia o composer (trocar de chat no meio da chamada)
  const [text, setText] = useState(() => takeCallDraft(session.id))
  const ref = useRef<HTMLTextAreaElement>(null)
  const [barRef, barLevels] = useBarCollapse<HTMLDivElement>()
  const pending = useStore(selectPendingAttachments(session.id))
  const addFiles = useStore((s) => s.addFiles)
  const pickFiles = useStore((s) => s.pickFiles)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const pendingSkillsRaw = useStore(selectPendingSkills(session.id))
  const setPendingSkills = useStore((s) => s.setPendingSkills)
  // skills desligadas no chat → os chips somem (e nada é enviado)
  const skillsOn = !!chat && skillsConfigOf(chat.config).enabled
  const pendingSkills = skillsOn ? pendingSkillsRaw : []
  const ready = pending.filter((a) => a.status === 'ready' && a.info)
  const loading = pending.some((a) => a.status === 'loading')
  const { supportOf, tooltip: attachTip } = useAttachmentSupport(session)
  /** O histórico tem mídia/tools que o modelo atual não aceita (trocado fora do seletor). */
  const historyWarning = useHistoryIncompatibility(session)
  /** Pediu para enviar com anexo que o modelo (talvez) não aceita: destaca a confirmação (por conjunto de avisos). */
  const [confirmKey, setConfirmKey] = useState<string | null>(null)

  /** Chamada de voz ativa (em qualquer chat): o microfone do ditado some (um de cada vez). */
  const callActive = useStore((s) => s.voiceCall.active)
  /** A chamada é DESTA sessão: a barra da chamada substitui o composer (texto desabilitado). */
  const callHere = useStore((s) => s.voiceCall.active && s.voiceCall.sessionId === session.id)
  // fim da chamada: o composer volta (rascunho intacto — o estado vive aqui) com o foco no texto
  const wasCallHere = useRef(callHere)
  useEffect(() => {
    if (wasCallHere.current && !callHere) ref.current?.focus()
    wasCallHere.current = callHere
  }, [callHere])
  const settingsOpen = useStore((s) => s.settingsOpen)
  /** Texto mais recente (a inserção do final acontece fora do ciclo de render). */
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  })
  // composer desmontado com a chamada ativa (troca de chat): o rascunho espera a chamada acabar
  const callHereRef = useRef(callHere)
  useEffect(() => {
    callHereRef.current = callHere
  }, [callHere])
  useEffect(
    () => () => {
      if (callHereRef.current && textRef.current) callDrafts.set(session.id, textRef.current)
    },
    [session.id]
  )
  /** Cursor/seleção quando o ditado começou: o texto final entra AÍ. */
  const anchorRef = useRef<DictationAnchor | null>(null)
  /** Card do composer (foco "dentro do composer" ao começar/terminar o ditado). */
  const cardRef = useRef<HTMLDivElement>(null)
  /** Espelho do campo durante o ditado (focável: Esc cancela, Enter conclui e envia). */
  const draftRef = useRef<HTMLDivElement>(null)
  /** Desfecho do ditado esperando a textarea voltar (o final é inserido no layout effect). */
  const pendingFinalRef = useRef<string | null>(null)
  const settleRef = useRef<DictationSettle | null>(null)
  const [commitTick, setCommitTick] = useState(0)
  /** "Enviar" durante a gravação: conclui e envia quando a final chegar (dentro do prazo). */
  const sendAfterRef = useRef(false)
  const [sendWaiting, setSendWaiting] = useState(false)
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * O campo tem texto ditado (o desfecho do ditado inseriu algo): a mensagem enviada leva
   * `meta.voice = { source: 'dictation' }` (mic discreto no balão). Zera quando o campo esvazia.
   */
  const dictatedRef = useRef(false)
  useEffect(() => {
    if (!text.trim()) dictatedRef.current = false
  }, [text])
  /** Aviso do desfecho (final falhou/demorou depois do "Enviar"). */
  const [voiceNote, setVoiceNote] = useState<string | null>(null)
  /** Região viva (leitor de tela) depois do ditado: "Transcrição pronta" / "Ditado cancelado". */
  const [announce, setAnnounce] = useState('')
  /** Ponto de inserção do ditado em curso (o espelho mostra o ditado AÍ). */
  const [draftAnchor, setDraftAnchor] = useState<DictationAnchor | null>(null)
  const clearSendWait = (): void => {
    sendAfterRef.current = false
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current)
    sendTimerRef.current = null
    setSendWaiting(false)
  }
  useEffect(
    () => () => {
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current)
    },
    []
  )
  /**
   * Ditado por voz: durante a gravação o campo vira um espelho (digitado + ditado translúcido) e a
   * textarea não muda; o desfecho (✓/×/Enviar) chega por `onFinal`/`onSettled` e é aplicado no
   * layout effect abaixo, com a textarea de volta.
   */
  // transcrição do ditado = a da persona/chat neste dispositivo (protocolo 1.9.0): indisponível aqui
  // → a padrão daqui (aviso discreto no tooltip); nenhuma funciona → mic esmaecido com o motivo
  const voiceLayers = useChatVoiceLayers(session.chatId)
  const voiceRes = useVoiceResolution(api.voice ? voiceLayers : null)
  const dictationUnavailable = dictationUnavailableText(voiceRes?.stt)
  const dictation = useDictation({
    voice: voiceLayers,
    sttSettings: voiceRes?.stt.settings ?? null,
    unavailable: dictationUnavailable,
    onFinal: (spoken) => {
      pendingFinalRef.current = spoken
      setCommitTick((n) => n + 1)
    },
    onSettled: (settle) => {
      settleRef.current = settle
      setCommitTick((n) => n + 1)
    },
    // UI do ditado escondida/bloqueada → tecla do PTT desligada e gravação em curso cancelada
    suspended: callActive || blocked || hostOffline || settingsOpen
  })
  /** Auto-start da GPU (transcrição `gpu`): o mic já grava enquanto o servidor sobe. */
  const gpuPrep = useDictationGpuPreparing()
  const preparingGpu = !!dictation.preparingGpu || !!gpuPrep
  const gpuText = preparingGpu ? gpuPrep?.text || 'Preparando a GPU…' : null
  const dictating = dictation.state !== 'idle'
  /** Ditado em andamento (inclui o "Preparando a GPU…" do auto-start): campo espelho + barra da gravação. */
  const voiceActive = (dictating || preparingGpu) && !blocked
  const hasSpoken = !!dictation.partial.trim()
  const focusInComposer = (): boolean => {
    const a = document.activeElement
    return !a || a === document.body || !!cardRef.current?.contains(a)
  }
  // início do ditado: guarda o ponto de inserção e põe o foco no espelho (Esc/Enter funcionam)
  const wasVoiceActive = useRef(false)
  useLayoutEffect(() => {
    if (voiceActive && !wasVoiceActive.current) {
      const ta = ref.current
      const t = textRef.current
      anchorRef.current = ta
        ? { text: t, start: ta.selectionStart ?? t.length, end: ta.selectionEnd ?? t.length }
        : { text: t, start: t.length, end: t.length }
      setDraftAnchor(anchorRef.current)
      setVoiceNote(null)
      if (focusInComposer()) draftRef.current?.focus({ preventScroll: true })
    }
    wasVoiceActive.current = voiceActive
  }, [voiceActive])

  /**
   * Insere o texto no ponto de inserção (seleção do início do ditado) via
   * `execCommand('insertText')` — fica no histórico de desfazer da textarea (Ctrl+Z); sem a
   * textarea (ou se o comando falhar), grava direto no estado. Devolve o valor novo.
   */
  const insertAtAnchor = (spoken: string): string => {
    const current = textRef.current
    const at = rebaseDictationAnchor(anchorRef.current, current)
    anchorRef.current = null
    const r = insertDictationText(current, at.start, at.end, spoken)
    if (!r.insert) return current
    const ta = ref.current
    textRef.current = r.value
    if (ta && ta.value === current) {
      ta.focus()
      ta.setSelectionRange(r.start, r.end)
      if (document.execCommand('insertText', false, r.insert)) {
        ta.setSelectionRange(r.caret, r.caret)
        return r.value
      }
    }
    setText(r.value)
    return r.value
  }
  /** × / Esc: descarta o ditado (o campo volta como estava, com o foco e a seleção do início). */
  const cancelDictation = (): void => {
    clearSendWait()
    void dictation.cancel()
  }
  /** ✓: para a gravação; o texto final entra no campo como texto normal. */
  const finishDictation = (): void => {
    if (dictation.state === 'recording') void dictation.stop()
  }
  /** Enviar durante a gravação: conclui (espera a final, com prazo) e envia o campo inteiro. */
  const finishAndSend = (): void => {
    if (sendAfterRef.current) return
    if (dictation.state !== 'recording' && dictation.state !== 'stopping') return
    sendAfterRef.current = true
    setSendWaiting(true)
    sendTimerRef.current = setTimeout(() => {
      sendTimerRef.current = null
      if (!sendAfterRef.current) return
      // a final demorou: entra no campo quando chegar, sem enviar sozinha
      clearSendWait()
      setVoiceNote(SEND_FINAL_SLOW_NOTE)
    }, SEND_FINAL_TIMEOUT_MS)
    if (dictation.state === 'recording') void dictation.stop()
  }
  const submitRef = useRef<(force?: boolean, override?: string) => Promise<void>>(async () => {})
  // desfecho do ditado, com a textarea de volta (o espelho já saiu neste commit)
  useLayoutEffect(() => {
    if (voiceActive) return
    const settle = settleRef.current
    const final = pendingFinalRef.current
    if (settle === null && final === null) return
    settleRef.current = null
    pendingFinalRef.current = null
    const sendRequested = sendAfterRef.current
    clearSendWait()
    const plan = planDictationCommit({
      // final sem desfecho = "Inserir o texto parcial" do card de erro
      settle: final !== null ? 'final' : (settle ?? 'empty'),
      final: final ?? '',
      partial: dictation.partial,
      sendRequested,
      hasOther: !!textRef.current.trim() || ready.length > 0 || pendingSkills.length > 0
    })
    // fora da fase de commit: o `input` do execCommand precisa do flushSync do React (dentro do
    // layout effect o React "restaura" o valor antigo e o Chromium perde o desfazer da textarea)
    queueMicrotask(() => {
      let value = textRef.current
      if (plan.insert) {
        value = insertAtAnchor(plan.insert)
        if (value.trim()) dictatedRef.current = true
        setAnnounce('Transcrição pronta')
        // a parcial entrou no campo: o card de erro (com "Inserir o texto parcial") sai
        if (settle === 'failed') dictation.clearError()
      } else if (settle === 'cancelled' || settle === 'empty') {
        if (settle === 'cancelled') setAnnounce('Ditado cancelado')
        // o campo volta como estava, com o foco e a seleção do início
        const ta = ref.current
        const a = anchorRef.current
        anchorRef.current = null
        if (ta && focusInComposer()) {
          ta.focus()
          if (a && ta.value === a.text) ta.setSelectionRange(a.start, a.end)
        }
      } else if (settle === 'failed' && focusInComposer()) {
        // a âncora fica para o "Inserir o texto parcial" do card de erro
        ref.current?.focus()
      }
      if (plan.note) setVoiceNote(plan.note)
      if (plan.send) void submitRef.current(false, value)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs/estado lidos no desfecho
  }, [commitTick, voiceActive])

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus, session.id])

  const warnings = useMemo(() => {
    const out = new Set<string>()
    if (historyWarning) out.add(historyWarning)
    for (const a of ready) {
      const w = modalityWarning(a.info!.kind, supportOf(a.info!))
      if (w) out.add(w)
    }
    return [...out]
  }, [ready, supportOf, historyWarning])
  const warnKey = warnings.join('|')
  const confirming = !!warnKey && confirmKey === warnKey
  const canSend =
    !dictating && !loading && (!!text.trim() || ready.length > 0 || pendingSkills.length > 0)
  /** Enviar durante o ditado = concluir + enviar (só com a gravação de pé ou finalizando). */
  const canSendVoice =
    !loading && !sendWaiting && (dictation.state === 'recording' || dictation.state === 'stopping')

  /** Envia o campo (`override`: o valor recém-inserido pelo desfecho do ditado). */
  const submit = async (force = false, override?: string): Promise<void> => {
    const t = (override ?? text).trim()
    // durante o ditado, "Enviar" conclui a transcrição e envia o campo inteiro depois
    if (override === undefined && dictating) {
      finishAndSend()
      return
    }
    const can = !loading && (!!t || ready.length > 0 || pendingSkills.length > 0)
    // composer escondido pela chamada de voz deste chat: nada é enviado por atalho
    if (!can || callHere) return
    if (warnings.length && !force) {
      setConfirmKey(warnKey)
      return
    }
    const atts = ready.map((a) => a.info!)
    const skills = [...pendingSkills]
    const dictated = dictatedRef.current && !!t
    dictatedRef.current = false
    setText('')
    setConfirmKey(null)
    if (atts.length) clearAttachments(session.id)
    if (skills.length) setPendingSkills(session.id, [])
    const ok = await send(
      session.id,
      t,
      atts,
      skills,
      dictated ? { voice: { source: 'dictation' } } : undefined
    )
    if (!ok) {
      setText(t)
      dictatedRef.current = dictated
      if (skills.length) setPendingSkills(session.id, skills)
      if (atts.length) {
        // devolve os anexos ao composer
        useStore.setState((s) => ({
          pendingAttachments: {
            ...s.pendingAttachments,
            [session.id]: [
              ...atts.map((info, i) => ({
                id: `retry-${Date.now()}-${i}`,
                name: info.name,
                size: info.size,
                status: 'ready' as const,
                info
              })),
              ...(s.pendingAttachments[session.id] ?? [])
            ]
          }
        }))
      }
    }
  }
  useEffect(() => {
    submitRef.current = submit
  })

  return (
    <div className="relative px-8 pb-5">
      {/* 90% da coluna de conteúdo (a mesma da lista: até 1920px); fora dele, cliques/rolagem passam para a lista */}
      <div className="mx-auto w-full max-w-[1920px]">
        <div data-testid="composer-column" className="pointer-events-auto mx-auto w-[90%]">
          {chat && <CompactBanner chat={chat} session={session} />}
          {queue.length > 0 && (
            <div className="mb-2" data-stack-extra>
              <div className="mb-1.5 flex items-center gap-1.5 pl-1 text-[11px] text-subtle">
                Na fila · enviadas no próximo passo do agente <QueueInfo />
              </div>
              <div className="flex flex-wrap gap-2">
                {queue.map((q) => (
                  <QueueChip key={q.id} item={q} />
                ))}
              </div>
            </div>
          )}
          {chat && <HostComposerLine chat={chat} sessionId={session.id} />}
          {chat && session.depth === 0 && <OutdatedHostsBanner />}
          <PendingBar session={session} blocked={blocked} />
          {/* chamada ativa em OUTRO chat: o composer daqui funciona; pílula leva de volta */}
          {callActive && !callHere && <VoiceCallElsewhere />}
          {hostOffline && chat ? (
            <HostOfflineCard chat={chat} />
          ) : callHere ? (
            // chamada de voz NESTE chat: a barra da chamada ocupa o lugar do composer (sem digitar
            // no rascunho por engano); fila e aprovações seguem acima, pergunta/retry num card
            <>
              {(question || retry) && (
                <div
                  data-testid="voice-call-blocking-card"
                  className="mb-2 rounded-2xl border border-border bg-surface shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)]"
                >
                  {question && <QuestionForm key={question.id} request={question} />}
                  {!question && retry && <RetryForm key={retry.id} request={retry} />}
                </div>
              )}
              <VoiceCallDock />
            </>
          ) : (
            <div
              ref={cardRef}
              data-testid="composer-card"
              data-voice={voiceActive ? dictation.state : undefined}
              className={cn(
                'group relative rounded-2xl border border-border bg-surface shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7)] transition-[border-color,box-shadow] duration-150',
                'focus-within:border-border-strong focus-within:shadow-[0_8px_30px_-12px_rgb(0_0_0/0.7),0_0_0_3px_rgb(139_92_246/0.08)]'
              )}
              onClick={() => (voiceActive ? draftRef.current : ref.current)?.focus()}
              onKeyDown={(e) => {
                // Esc com o foco no composer cancela o ditado em andamento (descarta)
                if (voiceActive && e.key === 'Escape') {
                  e.preventDefault()
                  cancelDictation()
                }
              }}
            >
              {/* leitor de tela: "Ouvindo" / "Transcrição pronta" / "Ditado cancelado" */}
              <span role="status" aria-live="polite" data-testid="voice-live" className="sr-only">
                {voiceActive
                  ? gpuText
                    ? gpuText
                    : dictation.state === 'recording'
                      ? 'Ouvindo'
                      : dictation.state === 'stopping'
                        ? 'Finalizando a transcrição'
                        : ''
                  : announce}
              </span>
              {question && <QuestionForm key={question.id} request={question} />}
              {!question && retry && <RetryForm key={retry.id} request={retry} />}
              {!blocked && (pending.length > 0 || pendingSkills.length > 0) && (
                <div
                  className="flex flex-wrap gap-2 px-3 pt-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  {pendingSkills.map((n) => (
                    <SkillChip
                      key={`skill:${n}`}
                      name={n}
                      onRemove={() =>
                        setPendingSkills(
                          session.id,
                          pendingSkills.filter((x) => x !== n)
                        )
                      }
                    />
                  ))}
                  {pending.map((a) => (
                    <ComposerAttachmentChip
                      key={a.id}
                      item={a}
                      support={a.info ? supportOf(a.info) : undefined}
                      onRemove={() => removeAttachment(session.id, a.id)}
                    />
                  ))}
                </div>
              )}
              {!blocked && warnings.length > 0 && (
                <div
                  role="alert"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'mx-3 mt-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors',
                    confirming
                      ? 'border-warning/45 bg-warning/[0.1] text-warning'
                      : 'border-warning/20 bg-warning/[0.05] text-warning/85'
                  )}
                >
                  <TriangleAlert className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {warnings.join(' · ')}.{' '}
                    <span className="text-subtle">
                      {confirming
                        ? 'Confirme para enviar assim mesmo.'
                        : 'A request pode falhar ou o anexo ser ignorado.'}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void submit(true)}
                    disabled={!canSend}
                    className="shrink-0 rounded-md border border-warning/30 px-2 py-0.5 text-[11.5px] font-medium text-warning transition-colors hover:bg-warning/15 disabled:opacity-50"
                  >
                    Enviar mesmo assim
                  </button>
                </div>
              )}
              {!blocked && dictation.notice && !dictation.error && (
                <div
                  role="status"
                  data-testid="voice-notice"
                  onClick={(e) => e.stopPropagation()}
                  className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-2.5 py-1.5 text-[12px] text-warning"
                >
                  <Info className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{dictation.notice}</span>
                  <button
                    type="button"
                    aria-label="Dispensar aviso de voz"
                    onClick={dictation.clearNotice}
                    className="shrink-0 rounded-md p-1 transition-colors hover:bg-warning/15"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              {!blocked && dictation.error && (
                <div
                  role="alert"
                  data-testid="voice-error"
                  onClick={(e) => e.stopPropagation()}
                  className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/[0.06] px-2.5 py-1.5 text-[12px] text-danger"
                >
                  <TriangleAlert className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {dictation.error}
                    {dictation.partialRecoverable && dictation.partial && (
                      <span
                        data-testid="voice-recoverable-partial"
                        className="mt-0.5 block truncate text-subtle italic"
                      >
                        “{dictation.partial}”
                      </span>
                    )}
                  </span>
                  {dictation.partialRecoverable && (
                    <button
                      type="button"
                      data-testid="voice-insert-partial"
                      onClick={dictation.insertPartial}
                      className="shrink-0 rounded-md border border-danger/30 px-2 py-0.5 text-[11.5px] font-medium transition-colors hover:bg-danger/15"
                    >
                      Inserir o texto parcial
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Dispensar erro de voz"
                    onClick={dictation.clearError}
                    className="shrink-0 rounded-md p-1 transition-colors hover:bg-danger/15"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              {!blocked && voiceNote && (
                <div
                  role="status"
                  data-testid="voice-send-note"
                  onClick={(e) => e.stopPropagation()}
                  className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-2.5 py-1.5 text-[12px] text-warning"
                >
                  <Info className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">{voiceNote}</span>
                  <button
                    type="button"
                    aria-label="Dispensar aviso do ditado"
                    onClick={() => setVoiceNote(null)}
                    className="shrink-0 rounded-md p-1 transition-colors hover:bg-warning/15"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
              {voiceActive && (
                // durante o ditado: digitado + ditado (translúcido) no mesmo campo, somente leitura
                <DictationDraft
                  ref={draftRef}
                  text={text}
                  anchor={draftAnchor}
                  partial={dictation.partial}
                  state={dictation.state}
                  // sem parcial ainda: "Preparando a GPU…" antes do "Ouvindo…"
                  gpuText={dictation.state === 'stopping' ? null : gpuText}
                  onKeyDown={(e) => {
                    // Enter conclui e envia (como o botão de enviar); Shift+Enter não faz nada
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      if (canSendVoice) finishAndSend()
                    }
                  }}
                />
              )}
              {!blocked && (
                <AutoTextarea
                  ref={ref}
                  value={text}
                  minRows={1}
                  maxRows={14}
                  placeholder={
                    busy
                      ? 'Enviar para a fila…'
                      : session.depth > 0
                        ? 'Mensagem ao subagente…'
                        : 'Mensagem…'
                  }
                  onChange={(e) => setText(e.target.value)}
                  onPaste={(e) => {
                    const files = [...e.clipboardData.files]
                    if (!files.length) return
                    e.preventDefault()
                    void addFiles(session.id, files.map(pastedName))
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      void submit()
                    }
                  }}
                  // durante o ditado o espelho toma o lugar (o valor fica intocado até o desfecho)
                  readOnly={voiceActive}
                  aria-hidden={voiceActive || undefined}
                  className={cn(
                    'block w-full bg-transparent px-4 pt-3.5 pb-1 text-[14px] leading-6 outline-none',
                    voiceActive && 'hidden'
                  )}
                />
              )}
              <BarLevelsContext.Provider value={barLevels}>
                <div
                  ref={barRef}
                  data-testid="composer-toolbar"
                  data-mode={voiceActive ? 'dictation' : 'normal'}
                  data-bar-clip
                  className="flex items-center gap-2 overflow-x-clip px-2.5 pb-2.5"
                >
                  {voiceActive ? (
                    // ditado: [ mic | waveform | … | (parar agente) | [ × | ✓ ] | enviar ]
                    <>
                      <span
                        role="img"
                        data-testid="voice-recording"
                        data-state={dictation.state}
                        data-has-text={hasSpoken ? 'true' : 'false'}
                        aria-label={
                          gpuText
                            ? 'Preparando a GPU para o ditado'
                            : hasSpoken
                              ? 'Ditando — transcrevendo'
                              : 'Ditando — ouvindo'
                        }
                        className={cn(
                          'flex size-7 shrink-0 items-center justify-center',
                          hasSpoken ? 'text-accent-strong' : 'text-subtle'
                        )}
                      >
                        {gpuText && !hasSpoken ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          <Mic
                            className={cn(
                              'size-4',
                              dictation.state === 'recording' && 'animate-pulse-soft'
                            )}
                          />
                        )}
                      </span>
                      <Waveform
                        level={dictation.level}
                        recording={dictation.state === 'recording'}
                        simulate={import.meta.env.VITE_CLEAR_MOCK === '1'}
                        className="h-5 w-20 min-w-6 shrink"
                      />
                      <div data-bar-spacer className="min-w-0 flex-1" />
                      <div className="flex shrink-0 items-center gap-1">
                        {busy && (
                          <Tip label="Parar o agente">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void run(() => api.agent.stop(session.id), 'Falha ao parar')
                              }}
                              className="mr-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-border-strong bg-elevated text-fg transition-colors hover:bg-hover"
                              aria-label="Parar o agente"
                              data-testid="agent-stop-button"
                            >
                              <Square className="size-3" fill="currentColor" />
                            </button>
                          </Tip>
                        )}
                        <div
                          role="group"
                          aria-label="Ditado"
                          data-testid="voice-dictation-actions"
                          className="flex h-8 shrink-0 items-stretch divide-x divide-border overflow-hidden rounded-xl border border-border bg-elevated/40"
                        >
                          <Tip label="Cancelar — descarta o que foi ditado" shortcut="Esc">
                            <button
                              type="button"
                              data-testid="voice-cancel-button"
                              aria-label="Cancelar ditado"
                              onClick={(e) => {
                                e.stopPropagation()
                                cancelDictation()
                              }}
                              className="flex w-8 items-center justify-center text-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:outline-none"
                            >
                              <X className="size-4" />
                            </button>
                          </Tip>
                          <Tip
                            label={
                              dictation.state === 'stopping'
                                ? 'Finalizando a transcrição…'
                                : 'Concluir — o texto ditado entra no campo'
                            }
                          >
                            <button
                              type="button"
                              data-testid="voice-finish-button"
                              data-state={dictation.state}
                              aria-label={
                                dictation.state === 'stopping'
                                  ? 'Finalizando a transcrição'
                                  : 'Concluir transcrição'
                              }
                              disabled={dictation.state !== 'recording'}
                              onClick={(e) => {
                                e.stopPropagation()
                                finishDictation()
                              }}
                              className="flex w-8 items-center justify-center text-accent-strong transition-colors hover:bg-accent/15 focus-visible:bg-accent/15 focus-visible:outline-none disabled:text-faint disabled:hover:bg-transparent"
                            >
                              {dictation.state === 'stopping' ? (
                                <Spinner className="size-3.5" />
                              ) : (
                                <Check className="size-4" strokeWidth={2.25} />
                              )}
                            </button>
                          </Tip>
                        </div>
                        <Tip
                          label={
                            sendWaiting
                              ? 'Concluindo a transcrição para enviar…'
                              : busy
                                ? 'Concluir a transcrição e adicionar à fila'
                                : 'Concluir a transcrição e enviar'
                          }
                          shortcut="Enter"
                        >
                          <button
                            type="button"
                            data-testid="composer-send"
                            data-waiting={sendWaiting ? 'true' : undefined}
                            disabled={!canSendVoice}
                            onClick={(e) => {
                              e.stopPropagation()
                              finishAndSend()
                            }}
                            className="ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] transition-[background-color,opacity] hover:bg-[#9a70f8] disabled:bg-active disabled:text-faint disabled:shadow-none"
                            aria-label={busy ? 'Concluir e adicionar à fila' : 'Concluir e enviar'}
                          >
                            {sendWaiting ? (
                              <Spinner className="size-3.5" />
                            ) : (
                              <ArrowUp className="size-4" strokeWidth={2.25} />
                            )}
                          </button>
                        </Tip>
                      </div>
                    </>
                  ) : (
                    // normal: [ clip | skills | host | </> · estado | … | modelo | contexto | gasto |
                    //           [ telefone | mic | ˅ ] | (parar) | enviar ]
                    <>
                      {!blocked && (
                        <Tip label={attachTip}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void pickFiles(session.id)
                            }}
                            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-subtle transition-colors hover:bg-hover hover:text-fg"
                            aria-label="Anexar arquivos"
                          >
                            <Paperclip className="size-4" />
                          </button>
                        </Tip>
                      )}
                      {!blocked && chat && <SkillPickerButton chat={chat} sessionId={session.id} />}
                      {chat && <ComposerHost chat={chat} />}
                      <span className="flex shrink-0 items-center gap-1.5 text-[11px] whitespace-nowrap text-faint">
                        <ComposerApiInfo running={busy} />
                        {busy ? (
                          <ComposerStatus
                            text={
                              question || session.status === 'awaiting_input'
                                ? 'Aguardando sua resposta'
                                : retry || session.status === 'awaiting_retry'
                                  ? 'Aguardando sua decisão (falha de conexão)'
                                  : session.status === 'awaiting_approval'
                                    ? 'Aguardando aprovação'
                                    : session.status === 'waiting'
                                      ? 'Aguardando subagentes'
                                      : compaction?.state === 'running'
                                        ? 'Compactando conversa…'
                                        : 'Trabalhando…'
                            }
                          />
                        ) : (
                          <ComposerHint />
                        )}
                      </span>
                      <div data-bar-spacer className="min-w-0 flex-1" />
                      <div className="flex shrink-0 items-center gap-1">
                        {chat && (
                          <ModelPill
                            providerId={sessionProviderId(
                              chat.config,
                              session.depth > 0 ? session : null
                            )}
                            model={session.depth > 0 ? session.model : chat.config.model}
                          />
                        )}
                        {chat && <ContextMeter chat={chat} session={session} />}
                        {chat && <SpendButton chat={chat} />}
                        {!blocked && (
                          <span className="ml-1 flex shrink-0 empty:hidden">
                            <VoiceGroup
                              dictation={dictation}
                              session={session}
                              dictationOff={
                                callActive
                                  ? 'Ditado indisponível durante a chamada de voz'
                                  : dictationUnavailable
                              }
                              dictationNote={voiceFallbackNote('stt', voiceRes?.stt)}
                              voiceState={
                                voiceRes?.stt
                                  ? voiceRes.stt.available
                                    ? voiceRes.stt.fallback
                                      ? 'fallback'
                                      : null
                                    : voiceRes.stt.unconfigured
                                      ? 'unconfigured'
                                      : 'unavailable'
                                  : null
                              }
                            />
                          </span>
                        )}
                        {busy && (
                          <Tip label="Parar">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void run(() => api.agent.stop(session.id), 'Falha ao parar')
                              }}
                              className="ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-border-strong bg-elevated text-fg transition-colors hover:bg-hover"
                              aria-label="Parar"
                              data-testid="agent-stop-button"
                            >
                              <Square className="size-3" fill="currentColor" />
                            </button>
                          </Tip>
                        )}
                        {!blocked && (
                          <Tip label={busy ? 'Adicionar à fila' : 'Enviar'} shortcut="Enter">
                            <button
                              type="button"
                              data-testid="composer-send"
                              disabled={!canSend}
                              onClick={(e) => {
                                e.stopPropagation()
                                void submit()
                              }}
                              className="ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] transition-[background-color,opacity] hover:bg-[#9a70f8] disabled:bg-active disabled:text-faint disabled:shadow-none"
                              aria-label="Enviar"
                            >
                              <ArrowUp className="size-4" strokeWidth={2.25} />
                            </button>
                          </Tip>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </BarLevelsContext.Provider>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
