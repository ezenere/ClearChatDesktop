// Notificações push no celular pelo host (docs/SYNC_PROTOCOL.md §22.5): pendências (aprovação,
// pergunta, retry) e fim de turno (resposta/erro) dos chats que ESTE dispositivo executa, quando o
// turno veio de um celular (`from_device_id` com `push: true`) ou o computador está ausente. O
// conteúdo vai cifrado com K_push; o servidor só repassa ao FCM. Fogo-e-esquece: uma falha aqui
// nunca afeta o chat. Sem Electron (a presença vem de fora, em sync/index.ts).
import { randomBytes } from 'node:crypto'
import type { AgentEvent } from '@shared/types'
import {
  approvalText,
  clip,
  pendingPlan,
  plainExcerpt,
  PUSH_MAX_ENV_BYTES,
  PUSH_PENDING_GRACE_S,
  PUSH_TEXT_MAX_CHARS,
  pushChatTitle,
  questionText,
  retryText,
  turnEndPlan,
  type PushKind,
  type PushPayload,
  type PushPendingKind,
  type PushTo
} from '@shared/push'
import { aadPush, hex, hmacSha256, sealJson, utf8, type Envelope } from './crypto'
import { SyncApiError } from './http'
import type { SyncEngine } from './engine'

/** Fim de um turno do runner (ver RunnerAdapter.onTurnEnd). */
export interface TurnEndInfo {
  sessionId: string
  chatId: string
  depth: number
  outcome: 'final' | 'error' | 'aborted'
  /** Texto final da resposta (outcome 'final'). */
  text: string
  /** Mensagem de erro (outcome 'error'). */
  error?: string
  /** Parado pelo usuário (Parar / cancelar o card de falha de conexão): não avisa. */
  userStopped: boolean
  /** Loop só de compactação (sem resposta nova): não avisa. */
  compactOnly: boolean
}

/** Presença do usuário neste computador (§22.5 "ausente"); 'unknown' conta como presente. */
export type Presence = 'present' | 'away' | 'unknown'

/** Comandos remotos que iniciam (ou entram n)um turno da sessão principal (§22.5). */
export const TURN_COMMANDS = new Set([
  'send',
  'force',
  'branch.edit',
  'branch.regenerate',
  'regenerate'
])

const DEVICES_TTL_MS = 5 * 60_000
/** Cada comando de turno relê a lista (o celular pode ter acabado de registrar o token), no máximo a cada 5 s. */
const DEVICES_REFRESH_MIN_MS = 5_000

interface Pending {
  chatId: string
  kind: PushPendingKind
  tag: string
  /** Destinos do aviso enviado (para o dismiss); null = ainda não enviado. */
  to: PushTo | null
  timer: ReturnType<typeof setTimeout> | null
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class PushNotifier {
  private engine: SyncEngine
  /** chatId → dispositivo que mandou o comando do turno em andamento (from_device_id). */
  private origins = new Map<string, string>()
  /** device_id → tem token de push (GET /devices, em cache). */
  private pushDevices = new Map<string, boolean>()
  private devicesAt = 0
  private devicesLoading: Promise<void> | null = null
  /** requestId → aviso de pendência (agendado ou enviado). */
  private pending = new Map<string, Pending>()
  private graceMs: number
  /** Envios em andamento (testes esperam por eles). */
  private inflight = new Set<Promise<void>>()

  constructor(engine: SyncEngine, opts: { graceMs?: number } = {}) {
    this.engine = engine
    this.graceMs = opts.graceMs ?? PUSH_PENDING_GRACE_S * 1000
  }

  /** Avisar agora? Sync pronto + conectado ao servidor com push + preferência deste aparelho. */
  enabled(): boolean {
    const e = this.engine
    return e.active && !!e.sk && e.pushAvailable() && e.pushNotifyOn()
  }

  private away(): boolean {
    try {
      return this.engine.deps.presence?.() === 'away'
    } catch {
      return false
    }
  }

  /** Limpa tudo (logout, bloqueio, sync parado). Avisos já mostrados ficam no celular. */
  reset(): void {
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer)
    this.pending.clear()
    this.origins.clear()
    this.pushDevices.clear()
    this.devicesAt = 0
  }

  /** Testes: espera os envios em andamento. */
  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight])
  }

  // ---------------- origem do turno ----------------

  /** Comando remoto de turno aceito pelo host: o turno (ou o que está rodando) vem desse dispositivo. */
  noteTurnOrigin(chatId: string, fromDeviceId: string | null | undefined): void {
    if (!fromDeviceId || fromDeviceId === this.engine.deviceId) return
    this.origins.set(chatId, fromDeviceId)
    if (this.enabled()) void this.loadDevices(Date.now() - this.devicesAt >= DEVICES_REFRESH_MIN_MS)
  }

  /** O comando falhou antes de iniciar um turno: esquece a origem (se ainda for a dele). */
  dropTurnOrigin(chatId: string, fromDeviceId: string | null | undefined): void {
    if (fromDeviceId && this.origins.get(chatId) === fromDeviceId) this.origins.delete(chatId)
  }

  private async loadDevices(force: boolean): Promise<void> {
    if (!force && Date.now() - this.devicesAt < DEVICES_TTL_MS) return
    if (this.devicesLoading) return this.devicesLoading
    this.devicesLoading = (async () => {
      try {
        const list = await this.engine.http.req<Record<string, unknown>[]>(
          'GET',
          '/api/v1/devices',
          {
            timeoutMs: 10_000
          }
        )
        this.pushDevices.clear()
        for (const d of Array.isArray(list) ? list : [])
          this.pushDevices.set(String(d.id), d.push === true)
        this.devicesAt = Date.now()
      } catch (e) {
        this.engine.log('push: lista de aparelhos falhou', errMsg(e))
      } finally {
        this.devicesLoading = null
      }
    })()
    return this.devicesLoading
  }

  /** O dispositivo de origem do turno, se for um celular com push; senão null. */
  private async phoneOf(id: string | undefined): Promise<string | null> {
    if (!id) return null
    // releitura em andamento (disparada pelo comando do turno): espera por ela
    if (this.devicesLoading) await this.devicesLoading
    if (!this.pushDevices.has(id) || Date.now() - this.devicesAt > DEVICES_TTL_MS)
      await this.loadDevices(!this.pushDevices.has(id))
    return this.pushDevices.get(id) ? id : null
  }

  // ---------------- eventos do runner ----------------

  /** Eventos do runner local (não os do espelho do controle remoto). */
  onAgentEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'approval-requested':
        return this.track(e.request.id, e.request.chatId, 'approval', () => ({
          sessionId: e.request.sessionId,
          text: approvalText(e.request)
        }))
      case 'question-requested':
        return this.track(e.request.id, e.request.chatId, 'question', () => ({
          sessionId: e.request.sessionId,
          text: questionText(e.request)
        }))
      case 'retry-requested':
        return this.track(e.request.id, e.request.chatId, 'retry', () => ({
          sessionId: e.request.sessionId,
          text: retryText(e.request)
        }))
      case 'approval-resolved':
      case 'question-resolved':
      case 'retry-resolved':
        return this.resolve(e.id)
    }
  }

  private hosts(chatId: string): boolean {
    return this.engine.host.hostsHere(chatId)
  }

  private track(
    requestId: string,
    chatId: string,
    kind: PushPendingKind,
    content: () => { sessionId: string; text: string }
  ): void {
    if (this.pending.has(requestId) || !this.enabled() || !this.hosts(chatId)) return
    const p: Pending = { chatId, kind, tag: randomBytes(16).toString('hex'), to: null, timer: null }
    this.pending.set(requestId, p)
    const away = this.away()
    this.run(async () => {
      const phone = await this.phoneOf(this.origins.get(chatId))
      if (this.pending.get(requestId) !== p) return // resolvido enquanto consultava os aparelhos
      const plan = pendingPlan({ phoneOrigin: phone, away })
      const fire = async (): Promise<void> => {
        p.timer = null
        if (this.pending.get(requestId) !== p || !this.enabled() || !this.hosts(chatId)) return
        const c = content()
        p.to = plan.to
        await this.send(kind, p.tag, plan.to, {
          chatId,
          sessionId: c.sessionId,
          text: c.text,
          requestId
        })
      }
      if (plan.delay === 'now') await fire()
      else p.timer = setTimeout(() => this.run(fire), this.graceMs)
    })
  }

  private resolve(requestId: string): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (p.timer) clearTimeout(p.timer)
    // dismiss vale sempre que o aviso saiu (mesmo com a preferência desligada depois)
    if (p.to && this.engine.active && this.engine.pushAvailable())
      this.run(() => this.send('dismiss', p.tag, p.to!, null))
  }

  /** Fim de um turno do runner local. */
  onTurnEnd(i: TurnEndInfo): void {
    if (i.depth !== 0) return
    const origin = this.origins.get(i.chatId)
    this.origins.delete(i.chatId)
    if (i.outcome === 'aborted' || i.compactOnly || !this.enabled() || !this.hosts(i.chatId)) return
    const away = this.away()
    this.run(async () => {
      const phone = await this.phoneOf(origin)
      const to = turnEndPlan({ phoneOrigin: phone, away, userStopped: i.userStopped })
      if (!to) return
      const kind: PushKind = i.outcome === 'error' ? 'error' : 'reply'
      const text =
        kind === 'error'
          ? clip(String(i.error ?? 'Erro').replace(/\s+/g, ' '), PUSH_TEXT_MAX_CHARS)
          : plainExcerpt(i.text) || 'Resposta pronta.'
      await this.send(kind, this.chatTag(i.chatId), to, {
        chatId: i.chatId,
        sessionId: i.sessionId,
        text
      })
    })
  }

  /** Tag estável por chat para reply/error (§22.5): HMAC(K_push, chatId) — não revela o chat. */
  private chatTag(chatId: string): string {
    const sk = this.engine.sk
    if (!sk) return randomBytes(16).toString('hex')
    return hex(hmacSha256(sk.push, utf8(`turn-tag|${chatId}`))).slice(0, 32)
  }

  // ---------------- envio ----------------

  private run(fn: () => Promise<void>): void {
    const p = fn()
      .catch((e) => this.engine.log('push falhou', errMsg(e)))
      .finally(() => this.inflight.delete(p))
    this.inflight.add(p)
  }

  private chatTitle(chatId: string): string {
    try {
      const row = this.engine.conn.prepare('SELECT title FROM chats WHERE id = ?').get(chatId) as
        { title: string } | undefined
      return pushChatTitle(row?.title)
    } catch {
      return pushChatTitle('')
    }
  }

  private seal(kind: PushKind, tag: string, payload: PushPayload): Envelope {
    const sk = this.engine.sk!
    const aad = aadPush(this.engine.userId, kind, tag)
    let env = sealJson(sk.push, aad, payload)
    // texto com muitos caracteres multibyte pode passar do teto do envelope: encurta
    for (const max of [120, 60, 0]) {
      if (Buffer.byteLength(JSON.stringify(env)) <= PUSH_MAX_ENV_BYTES) break
      env = sealJson(sk.push, aad, { ...payload, text: clip(payload.text, max) })
    }
    return env
  }

  private async send(
    kind: PushKind | 'dismiss',
    tag: string,
    to: PushTo,
    p: { chatId: string; sessionId?: string; text: string; requestId?: string } | null
  ): Promise<void> {
    if (!this.engine.sk || !this.engine.userId) return
    let env: Envelope | null = null
    if (kind !== 'dismiss' && p) {
      const payload: PushPayload = {
        sv: 1,
        kind,
        chatId: p.chatId,
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        chatTitle: this.chatTitle(p.chatId),
        text: p.text,
        ...(p.requestId ? { requestId: p.requestId } : {}),
        hostName: this.engine.deviceName,
        // §22.4 (1.8.0): o celular sabe de que host é o aviso; chat só ao vivo abre o visualizador
        hostDeviceId: this.engine.deviceId,
        ...(this.engine.live.isLive(p.chatId) ? { live: true as const } : {}),
        ts: Date.now()
      }
      env = this.seal(kind, tag, payload)
    }
    try {
      await this.engine.http.req('POST', '/api/v1/push', {
        json: { kind, tag, to, env },
        timeoutMs: 15_000
      })
    } catch (e) {
      if (e instanceof SyncApiError && e.code === 'push_unavailable')
        this.engine.markPushUnavailable()
      // 429: o aviso é descartado, sem fila (§22.3)
      this.engine.log(`push ${kind} não enviado`, errMsg(e))
    }
  }
}
