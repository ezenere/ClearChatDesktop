// Chats só ao vivo de OUTRO dispositivo — lado do VISUALIZADOR (docs/SYNC_PROTOCOL.md §23.4–§23.7):
// lista decifrada (live.list / live.update / live.removed / live.host), histórico sob demanda pelos
// comandos history.* (junção por `lseq`), atualizações `rec` do stream e anexos por attach.get /
// attach.put. TUDO só em memória: nada vai ao banco, a arquivos, a caches ou a logs (§23.5).
// Sem Electron.
import { createHash, randomUUID } from 'node:crypto'
import type { AttachmentInfo, Chat, ChatConfig, Session, StoredMessage } from '@shared/types'
import type { LiveChatView } from '@shared/sync'
import {
  LIVE_ATTACH_FILE_RE,
  LIVE_LIMITS,
  liveItemWins,
  liveKey,
  parseLiveInfo,
  type LiveChatInfo,
  type LiveItem,
  type LiveItemType
} from '@shared/live'
import { aadLiveAnnounce, openJson, type Envelope } from './crypto'
import { messageFromPlain, sessionFromPlain, type Plain } from './records'
import { WsRequestError } from './ws'
import type { SyncEngine } from './engine'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface Entry {
  chatId: string
  epoch: number
  arev: number
  running: boolean
  host: { deviceId: string; name: string; platform: string; status: 'online' | 'grace' }
  info: LiveChatInfo
  /** Sumiu da lista numa reconexão; some de vez quando passar (§23.4, `settling_s`). */
  settlingUntil: number | null
}

interface ViewMirror {
  chatId: string
  epoch: number
  hostDeviceId: string
  items: Map<string, LiveItem>
  known: number
  ready: boolean
  loading: Promise<void> | null
  buffered: { lseq: number; items: LiveItem[] }[]
  loadedSessions: Set<string>
  catching: Promise<void> | null
  /** Geração (recarregar descarta o que estava em voo). */
  gen: number
}

/** Erro de um comando ao vivo (recusa do host ou falha de entrega), com texto pt-BR. */
export class LiveViewError extends Error {
  code: string | null
  /** Resultado inteiro da recusa (ex.: `received` de um attach.put fora de ordem). */
  result: Record<string, unknown>
  constructor(message: string, code: string | null = null, result: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.result = result
  }
}

const ATT_CACHE_MAX = 64 * 1024 * 1024

export class LiveViewer {
  private readonly engine: SyncEngine
  private list = new Map<string, Entry>()
  private listReady = false
  private mirrors = new Map<string, ViewMirror>()
  private att = new Map<string, Buffer>()
  private attBytes = 0
  private attLoading = new Map<string, Promise<Buffer | null>>()
  private active = 0
  private waiters: (() => void)[] = []
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private caps = false

  constructor(engine: SyncEngine) {
    this.engine = engine
  }

  // ---------------- lista (§23.4) ----------------

  has(chatId: string): boolean {
    return this.list.has(chatId) || this.mirrors.has(chatId)
  }

  entry(chatId: string): Entry | null {
    return this.list.get(chatId) ?? null
  }

  hostName(chatId: string): string {
    return (
      this.list.get(chatId)?.host.name ??
      this.mirrors.get(chatId)?.hostDeviceId ??
      'outro dispositivo'
    )
  }

  /** O host está online (comandos vão); grace / reconectando → não. */
  hostOnline(chatId: string): boolean {
    const e = this.list.get(chatId)
    return !!e && e.host.status === 'online' && e.settlingUntil == null
  }

  views(): LiveChatView[] {
    const out: LiveChatView[] = []
    for (const e of this.list.values())
      out.push({
        chatId: e.chatId,
        epoch: e.epoch,
        title: e.info.title,
        persona: e.info.persona,
        model: e.info.model,
        status: e.info.status,
        pending: e.info.pending,
        usesLocalTools: e.info.usesLocalTools,
        hostCwd: e.info.hostCwd,
        createdAt: e.info.createdAt,
        updatedAt: e.info.updatedAt,
        messageCount: e.info.messageCount ?? null,
        running: e.running,
        host: { ...e.host },
        settling: e.settlingUntil != null
      })
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private emitList(): void {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.engine.emit({ type: 'sync-live-chats', chats: this.views() })
    }, 30)
    this.emitTimer.unref?.()
  }

  private decrypt(c: Record<string, unknown>): Entry | null {
    const sk = this.engine.sk
    if (!sk) return null
    const chatId = typeof c.chat_id === 'string' ? c.chat_id : ''
    const epoch = Number(c.epoch)
    const arev = Number(c.arev)
    const host = (c.host ?? {}) as Record<string, unknown>
    const hostId = typeof host.device_id === 'string' ? host.device_id : ''
    if (!chatId || !hostId || !Number.isSafeInteger(epoch) || !Number.isSafeInteger(arev))
      return null
    if (hostId === this.engine.deviceId) return null
    let info: LiveChatInfo | null
    try {
      const p = openJson(
        sk.stream,
        aadLiveAnnounce(this.engine.userId, hostId, chatId, epoch, arev),
        c.env as Envelope
      )
      info = parseLiveInfo(p, chatId)
    } catch {
      info = null
    }
    if (!info) {
      // não decifrou (ou chatId de dentro diferente): ignora o item e pede reanúncio (§23.4)
      this.requestRefresh(hostId)
      return null
    }
    return {
      chatId,
      epoch,
      arev,
      running: c.running === true,
      host: {
        deviceId: hostId,
        name: typeof host.name === 'string' && host.name ? host.name : 'outro dispositivo',
        platform: typeof host.platform === 'string' ? host.platform : '',
        status: host.status === 'grace' ? 'grace' : 'online'
      },
      info,
      settlingUntil: null
    }
  }

  private refreshAt = new Map<string, number>()
  /** `live.refresh` ao host (no máximo 1 por minuto por host; o servidor limita 6/min). */
  private requestRefresh(hostId: string): void {
    const now = Date.now()
    if (now - (this.refreshAt.get(hostId) ?? 0) < 60_000) return
    this.refreshAt.set(hostId, now)
    void this.engine.ws.request('live.refresh', { host_device_id: hostId }).catch(() => undefined)
  }

  onWelcome(w: Record<string, unknown>): void {
    this.caps = Array.isArray(w.caps) && (w.caps as unknown[]).includes('live_chats')
    this.listReady = false
    if (!this.caps) {
      for (const id of [...this.list.keys()]) this.removeEntry(id, null)
      this.emitList()
      return
    }
    void this.engine.ws
      .request('live.list', {})
      .then((ack) => this.applyList(ack))
      .catch((e) => this.engine.log('live.list', errMsg(e)))
  }

  private applyList(ack: Record<string, unknown>): void {
    const settling = Math.max(0, Number(ack.settling_s ?? 0) || 0)
    const fresh = new Map<string, Entry>()
    for (const c of (ack.chats as Record<string, unknown>[]) ?? []) {
      const e = this.decrypt(c)
      if (e) fresh.set(e.chatId, e)
    }
    const now = Date.now()
    for (const [id, old] of this.list) {
      if (fresh.has(id)) continue
      if (settling > 0) {
        fresh.set(id, { ...old, settlingUntil: now + settling * 1000 })
      } else this.removeEntry(id, null, false)
    }
    const prev = this.list
    this.list = fresh
    this.listReady = true
    for (const e of fresh.values()) this.afterUpdate(prev.get(e.chatId) ?? null, e)
    this.armSettle()
    this.emitList()
  }

  private armSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    let next = Infinity
    for (const e of this.list.values())
      if (e.settlingUntil != null) next = Math.min(next, e.settlingUntil)
    if (next === Infinity) return
    this.settleTimer = setTimeout(
      () => {
        this.settleTimer = null
        const now = Date.now()
        for (const e of [...this.list.values()])
          if (e.settlingUntil != null && e.settlingUntil <= now)
            this.removeEntry(e.chatId, 'host_dropped')
        this.armSettle()
        this.emitList()
      },
      Math.max(0, next - Date.now()) + 20
    )
    this.settleTimer.unref?.()
  }

  /** Eventos `live.*` do servidor (§23.4). */
  onEvent(f: Record<string, unknown>): void {
    if (!this.listReady) return // antes do ack do live.list: já estão nele
    switch (f.t) {
      case 'live.update':
        for (const c of (f.chats as Record<string, unknown>[]) ?? []) {
          const e = this.decrypt(c)
          if (!e) continue
          const cur = this.list.get(e.chatId)
          // anti-replay: dentro do mesmo epoch, arev menor ou igual à conhecida é ignorada
          if (cur && cur.epoch === e.epoch && e.arev <= cur.arev && cur.settlingUntil == null)
            continue
          this.list.set(e.chatId, e)
          this.afterUpdate(cur ?? null, e)
        }
        this.armSettle()
        this.emitList()
        return
      case 'live.removed': {
        const reason = typeof f.reason === 'string' ? f.reason : 'withdrawn'
        for (const id of (f.chat_ids as unknown[]) ?? [])
          if (typeof id === 'string' && this.list.get(id)?.host.deviceId === f.host_device_id)
            this.removeEntry(id, reason)
        this.emitList()
        return
      }
      case 'live.host': {
        const status = f.status === 'grace' ? 'grace' : 'online'
        for (const e of this.list.values())
          if (e.host.deviceId === f.host_device_id) {
            e.host = { ...e.host, status }
            this.engine.host.emitInfoOf(e.chatId)
          }
        this.emitList()
        return
      }
    }
  }

  /** Item novo/atualizado na lista: mirror aberto com o mesmo epoch → resync; epoch novo → recarrega. */
  private afterUpdate(prev: Entry | null, e: Entry): void {
    this.engine.host.emitInfoOf(e.chatId)
    const m = this.mirrors.get(e.chatId)
    if (!m) return
    if (m.epoch !== e.epoch) {
      void this.reload(m, e.epoch)
      return
    }
    if (m.ready && (!prev || prev.settlingUntil != null || prev.host.status !== 'online')) {
      // reconexão (§23.5 passo 6): a inscrição volta pelo hello; snapshot + o que perdeu
      void this.engine.ws.request('stream.resync', { chat_id: e.chatId }).catch(() => undefined)
      void this.catchUp(m)
    }
    if (m.ready) {
      const chat = this.chat(e.chatId)
      if (chat) this.engine.emit({ type: 'chat-updated', chat })
    }
  }

  private removeEntry(chatId: string, reason: string | null, emit = true): void {
    const had = this.list.delete(chatId)
    const m = this.mirrors.get(chatId)
    if (m) this.dropMirror(chatId)
    if (!had && !m) return
    if (emit) this.engine.host.emitInfoOf(chatId)
    if (m) {
      this.engine.host.clearMirror(chatId)
      this.engine.emit({ type: 'chat-deleted', chatId })
      const text =
        reason === 'saved_online'
          ? 'O chat ao vivo foi salvo online pelo host — ele aparece na lista quando terminar de chegar.'
          : reason === 'deleted'
            ? 'O chat ao vivo foi apagado no host.'
            : reason === 'host_quit'
              ? 'O host fechou o app — o chat ao vivo saiu da lista.'
              : reason === 'host_dropped'
                ? 'O host perdeu a conexão — o chat ao vivo saiu da lista.'
                : 'O chat ao vivo saiu da lista.'
      this.engine.emit({ type: 'sync-notice', kind: 'info', text })
    }
  }

  /** Conta bloqueou / saiu / desconectou de vez: esquece tudo (só memória). */
  reset(): void {
    for (const id of [...this.mirrors.keys()]) {
      this.dropMirror(id)
      this.engine.emit({ type: 'chat-deleted', chatId: id })
    }
    this.list.clear()
    this.listReady = false
    this.att.clear()
    this.attBytes = 0
    this.emitList()
  }

  private dropMirror(chatId: string): void {
    const m = this.mirrors.get(chatId)
    if (!m) return
    m.gen++
    this.mirrors.delete(chatId)
    // anexos em memória deste chat saem também
    const files = new Set<string>()
    for (const it of m.items.values()) if (it.data) for (const f of filesOf(it.data)) files.add(f)
    for (const f of files) this.dropAtt(f)
  }

  // ---------------- comandos (limite de 3 em voo, §23.5) ----------------

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= LIVE_LIMITS.viewerConcurrency)
      await new Promise<void>((r) => this.waiters.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiters.shift()?.()
    }
  }

  private async cmd(
    chatId: string,
    kind: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const name = this.hostName(chatId)
    return this.slot(async () => {
      let r: Record<string, unknown>
      try {
        r = await this.engine.host.rawCommand(
          chatId,
          kind,
          { chatId, ...payload },
          LIVE_LIMITS.commandTimeoutMs,
          `O host (${name}) não respondeu a tempo.`
        )
      } catch (e) {
        if (e instanceof WsRequestError) {
          if (e.code === 'host_offline')
            throw new LiveViewError(`Reconectando a ${name}…`, 'host_offline')
          if (e.code === 'no_host')
            throw new LiveViewError(`${name} não está conectado.`, 'no_host')
          if (e.code === 'disconnected' || e.code === 'timeout')
            throw new LiveViewError('Sem conexão com o servidor.', 'disconnected')
        }
        throw new LiveViewError(errMsg(e))
      }
      if (r.status !== 'accepted') {
        const code = typeof r.code === 'string' ? r.code : null
        throw new LiveViewError(
          typeof r.error === 'string' && r.error ? r.error : `O host (${name}) recusou o pedido.`,
          code,
          r
        )
      }
      return r
    })
  }

  // ---------------- abrir (§23.5) ----------------

  /** Abre o chat ao vivo (carrega o histórico do host). Devolve o Chat montado. */
  async open(chatId: string): Promise<Chat> {
    const e = this.list.get(chatId)
    if (!e) throw new LiveViewError('Este chat ao vivo não está disponível agora.')
    let m = this.mirrors.get(chatId)
    if (m && m.epoch !== e.epoch) {
      await this.reload(m, e.epoch)
      m = this.mirrors.get(chatId)
    }
    if (!m) {
      m = this.newMirror(chatId, e.epoch, e.host.deviceId)
      this.mirrors.set(chatId, m)
      m.loading = this.load(m)
    }
    try {
      if (m.loading) await m.loading
      // reaberto (sem inscrição enquanto estava fora da tela): busca o que mudou
      else if (m.ready) await this.catchUp(m)
    } catch (err) {
      if (this.mirrors.get(chatId) === m) this.dropMirror(chatId)
      throw err
    }
    const chat = this.chat(chatId)
    if (!chat) throw new LiveViewError('O host não devolveu o chat.')
    return chat
  }

  private newMirror(chatId: string, epoch: number, hostDeviceId: string): ViewMirror {
    return {
      chatId,
      epoch,
      hostDeviceId,
      items: new Map(),
      known: 0,
      ready: false,
      loading: null,
      buffered: [],
      loadedSessions: new Set(),
      catching: null,
      gen: 0
    }
  }

  private async reload(m: ViewMirror, epoch: number): Promise<void> {
    if (this.mirrors.get(m.chatId) !== m) return
    m.gen++
    m.items.clear()
    m.known = 0
    m.ready = false
    m.buffered = []
    m.loadedSessions.clear()
    m.epoch = epoch
    m.loading = this.load(m)
    try {
      await m.loading
    } catch (e) {
      this.engine.log('chat ao vivo: recarregar', errMsg(e))
    }
  }

  private checkEpoch(m: ViewMirror, gen: number, r: Record<string, unknown>): void {
    if (gen !== m.gen) throw new LiveViewError('recarregando')
    const ep = Number(r.epoch)
    if (Number.isSafeInteger(ep) && ep !== m.epoch) {
      // epoch novo (host reiniciou): descarta e recomeça (§23.5 passo 5)
      m.epoch = ep
      throw new LiveViewError('epoch')
    }
    const l = Number(r.lseq)
    if (Number.isFinite(l)) m.known = Math.max(m.known, l)
  }

  private async load(m: ViewMirror): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const gen = m.gen
      try {
        await this.engine.ws
          .request('stream.subscribe', { chat_ids: [m.chatId] })
          .catch(() => undefined)
        const got: LiveItem[] = []
        const r1 = await this.cmd(m.chatId, 'history.list', { type: 'chat', after: null })
        this.checkEpoch(m, gen, r1)
        got.push(...((r1.items as LiveItem[]) ?? []))
        got.push(...(await this.listAll(m, gen, 'session')))
        const chatItem = got.find((x) => x.type === 'chat')
        const mainId = String((chatItem?.data as Plain | undefined)?.mainSessionId ?? '')
        if (mainId) {
          got.push(...(await this.listAll(m, gen, 'message', mainId)))
          m.loadedSessions.add(mainId)
        }
        await this.fillItems(m, gen, got)
        for (const it of got) this.mergeItem(m, it, false)
        m.ready = true
        const buf = m.buffered
        m.buffered = []
        for (const rec of buf) this.applyRec(m, rec, false)
        m.loading = null
        // mensagens/sessões chegaram: a tela recarrega pelo `chat-updated` + open
        return
      } catch (e) {
        if (e instanceof LiveViewError && (e.message === 'epoch' || e.message === 'recarregando')) {
          if (this.mirrors.get(m.chatId) !== m) throw e
          m.items.clear()
          m.known = 0
          m.loadedSessions.clear()
          continue
        }
        m.loading = null
        throw e
      }
    }
    m.loading = null
    throw new LiveViewError('O chat ao vivo mudou durante o carregamento — tente de novo.')
  }

  private async listAll(
    m: ViewMirror,
    gen: number,
    type: 'session' | 'message',
    sessionId?: string
  ): Promise<LiveItem[]> {
    const out: LiveItem[] = []
    let after: string | null = null
    for (let i = 0; i < 100_000; i++) {
      const r = await this.cmd(m.chatId, 'history.list', {
        type,
        ...(sessionId ? { sessionId } : {}),
        after,
        limit: LIVE_LIMITS.historyPageMaxItems
      })
      this.checkEpoch(m, gen, r)
      out.push(...((r.items as LiveItem[]) ?? []))
      after = typeof r.next === 'string' && r.next ? r.next : null
      if (!after) break
    }
    return out
  }

  /** Completa itens `large` (pedaços) e `omitted` (history.item). */
  private async fillItems(m: ViewMirror, gen: number, items: LiveItem[]): Promise<void> {
    const omitted = items.filter((x) => x.omitted && !x.data && !x.deleted)
    for (let i = 0; i < omitted.length; i += 200) {
      const part = omitted.slice(i, i + 200)
      let want = part.map((x) => ({ type: x.type, id: x.id }))
      for (let round = 0; round < 50 && want.length; round++) {
        const r = await this.cmd(m.chatId, 'history.item', { items: want })
        this.checkEpoch(m, gen, r)
        const next: { type: LiveItemType; id: string }[] = []
        for (const it of (r.items as LiveItem[]) ?? []) {
          const target = part.find((x) => x.type === it.type && x.id === it.id)
          if (!target) continue
          if (it.omitted) next.push({ type: it.type, id: it.id })
          else Object.assign(target, it, { omitted: undefined })
          if (it.large && !it.data) target.large = it.large
        }
        want = next
      }
    }
    for (const it of items) {
      if (!it.large || it.data || it.deleted) continue
      const data = await this.fetchLarge(m, gen, it.type, it.id)
      if (data) {
        it.data = data.data
        it.lseq = Math.max(it.lseq, data.lseq)
        delete it.large
        delete it.omitted
      }
    }
  }

  private async fetchLarge(
    m: ViewMirror,
    gen: number,
    type: LiveItemType,
    id: string
  ): Promise<{ data: Plain; lseq: number } | null> {
    for (let restart = 0; restart < 3; restart++) {
      const parts: Buffer[] = []
      let offset = 0
      let total: number
      let lseq: number | null = null
      for (;;) {
        const r = await this.cmd(m.chatId, 'history.item', { piece: { type, id, offset } })
        this.checkEpoch(m, gen, r)
        const pc = (r.piece ?? {}) as Record<string, unknown>
        if (lseq !== null && pc.lseq !== lseq) break // mudou entre pedaços → recomeça
        lseq = Number(pc.lseq ?? 0)
        total = Number(pc.total ?? 0)
        const chunk = Buffer.from(String(pc.data ?? ''), 'base64')
        if (!chunk.length && offset < total) return null
        parts.push(chunk)
        offset += chunk.length
        if (offset >= total) {
          try {
            return { data: JSON.parse(Buffer.concat(parts).toString('utf8')) as Plain, lseq }
          } catch {
            return null
          }
        }
      }
    }
    return null
  }

  // ---------------- junção e eventos ----------------

  /** Junta um item (maior lseq vence) e emite o evento para a tela. */
  private mergeItem(m: ViewMirror, it: LiveItem, emit = true): void {
    const k = liveKey(it.type, it.id)
    const cur = m.items.get(k)
    m.known = Math.max(m.known, it.lseq)
    if (!liveItemWins(cur, it)) return
    if (!it.deleted && it.data === undefined) {
      // referência sem dado (omitted/large): guarda o lseq e busca depois
      if (cur && cur.lseq >= it.lseq) return
      m.items.set(k, {
        ...(cur ?? {}),
        type: it.type,
        id: it.id,
        lseq: it.lseq,
        omitted: true
      } as LiveItem)
      void this.fetchMissing(m, [it])
      return
    }
    m.items.set(k, it)
    if (!emit || !m.ready) return
    this.emitItem(m, it, cur)
  }

  private emitItem(m: ViewMirror, it: LiveItem, cur: LiveItem | undefined): void {
    const had = !!cur && !cur.deleted && cur.data !== undefined
    if (it.type === 'chat') {
      const chat = this.chat(m.chatId)
      if (chat) this.engine.emit({ type: 'chat-updated', chat })
      return
    }
    if (it.type === 'session') {
      if (it.deleted) {
        if (had) this.engine.emit({ type: 'session-deleted', sessionId: it.id, chatId: m.chatId })
        return
      }
      const s = this.engine.host.displaySession(sessionFromPlain(it.id, it.data!, m.chatId))
      this.engine.emit({ type: had ? 'session-updated' : 'session-created', session: s })
      return
    }
    // message
    if (it.deleted) {
      const sid = String((cur?.data as Plain | undefined)?.sessionId ?? '')
      if (had && sid)
        this.engine.emit({ type: 'message-deleted', sessionId: sid, messageId: it.id })
      return
    }
    const msg = messageFromPlain(it.id, it.data!)
    this.engine.emit({ type: had ? 'message-updated' : 'message-added', message: msg })
    if (!had && msg.message.role === 'assistant') this.engine.host.onPersistedAssistant(msg)
  }

  private async fetchMissing(
    m: ViewMirror,
    refs: { type: LiveItemType; id: string }[]
  ): Promise<void> {
    const gen = m.gen
    try {
      const items = refs.map(
        (x) => ({ type: x.type, id: x.id, lseq: 0, omitted: true }) as LiveItem
      )
      await this.fillItems(m, gen, items)
      if (gen !== m.gen) return
      for (const it of items)
        if (it.data || it.deleted) this.mergeItem(m, { ...it, omitted: undefined } as LiveItem)
    } catch (e) {
      this.engine.log('chat ao vivo: item', errMsg(e))
    }
  }

  /** Evento `rec` do stream (§23.6). */
  onRec(chatId: string, epoch: number, p: Record<string, unknown>): void {
    const m = this.mirrors.get(chatId)
    if (!m) return
    if (epoch !== m.epoch) {
      void this.reload(m, epoch)
      return
    }
    const rec = {
      lseq: Number(p.lseq ?? 0),
      items: (Array.isArray(p.items) ? p.items : []) as LiveItem[]
    }
    if (!m.ready) {
      m.buffered.push(rec)
      return
    }
    this.applyRec(m, rec, true)
  }

  private applyRec(m: ViewMirror, rec: { lseq: number; items: LiveItem[] }, live: boolean): void {
    const gap = rec.lseq > m.known + 1
    for (const it of rec.items) {
      if (!it || typeof it.id !== 'string') continue
      this.mergeItem(m, { ...it, lseq: rec.lseq })
    }
    if (gap && live) void this.catchUp(m)
    m.known = Math.max(m.known, rec.lseq)
  }

  /** `snapshot` com `live.lseq` (§23.6): mudanças perdidas → busca. */
  onSnapshot(chatId: string, epoch: number, lseq: number): void {
    const m = this.mirrors.get(chatId)
    if (!m || !m.ready) return
    if (epoch !== m.epoch) {
      void this.reload(m, epoch)
      return
    }
    if (lseq > m.known) void this.catchUp(m)
  }

  /** `history.changes { since: conhecido }` + `history.item` do que veio (§23.5 passo 4). */
  private catchUp(m: ViewMirror): Promise<void> {
    if (m.catching) return m.catching
    const gen = m.gen
    m.catching = (async () => {
      try {
        const since = m.known
        const r = await this.cmd(m.chatId, 'history.changes', { since })
        if (gen !== m.gen) return
        if (Number(r.epoch) !== m.epoch) {
          await this.reload(m, Number(r.epoch))
          return
        }
        if (r.reset) {
          await this.reload(m, m.epoch)
          return
        }
        const refs: { type: LiveItemType; id: string }[] = []
        for (const c of (r.changes as LiveItem[]) ?? []) {
          const k = liveKey(c.type, c.id)
          const cur = m.items.get(k)
          if (cur && cur.lseq >= c.lseq) continue
          if (c.deleted) this.mergeItem(m, { type: c.type, id: c.id, lseq: c.lseq, deleted: true })
          else if (c.type !== 'message' || this.sessionLoaded(m, c.id, cur)) refs.push(c)
        }
        const lseq = Number(r.lseq ?? 0)
        if (refs.length) await this.fetchMissing(m, refs)
        m.known = Math.max(m.known, lseq)
      } catch (e) {
        this.engine.log('chat ao vivo: atualizar', errMsg(e))
      } finally {
        m.catching = null
      }
    })()
    return m.catching
  }

  /** Mensagem conhecida, ou de sessão já carregada (as outras vêm quando a sessão for aberta). */
  private sessionLoaded(m: ViewMirror, _id: string, cur: LiveItem | undefined): boolean {
    if (cur) return true
    return m.loadedSessions.size > 0
  }

  // ---------------- leitura (IPC) ----------------

  isViewer(chatId: string): boolean {
    return this.mirrors.has(chatId) || this.list.has(chatId)
  }

  chat(chatId: string): Chat | null {
    const m = this.mirrors.get(chatId)
    const it = m?.items.get(liveKey('chat', chatId))
    if (!m || !it?.data) return null
    const d = it.data
    const e = this.list.get(chatId)
    const cfg = { ...((d.config ?? {}) as Partial<ChatConfig>) } as ChatConfig
    cfg.cwd = e?.info.hostCwd ?? ''
    return {
      id: chatId,
      title: String(d.title ?? e?.info.title ?? ''),
      config: cfg,
      mainSessionId: String(d.mainSessionId ?? ''),
      createdAt: Number(d.createdAt ?? 0),
      updatedAt: Math.max(Number(d.updatedAt ?? 0), e?.info.updatedAt ?? 0),
      liveViewer: { hostDeviceId: m.hostDeviceId, hostName: e?.host.name ?? 'outro dispositivo' }
    }
  }

  /** Chats abertos como visualizador (entram na lista de chats do renderer). */
  openChats(): Chat[] {
    const out: Chat[] = []
    for (const id of this.mirrors.keys()) {
      const c = this.mirrors.get(id)?.ready ? this.chat(id) : null
      if (c) out.push(c)
    }
    return out
  }

  sessions(chatId: string): Session[] {
    const m = this.mirrors.get(chatId)
    if (!m) return []
    const out: Session[] = []
    for (const it of m.items.values())
      if (it.type === 'session' && it.data && !it.deleted)
        out.push(sessionFromPlain(it.id, it.data, chatId))
    return out.sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt)
  }

  chatOfSession(sessionId: string): string | null {
    for (const m of this.mirrors.values()) {
      const it = m.items.get(liveKey('session', sessionId))
      if (it?.data && !it.deleted) return m.chatId
    }
    return null
  }

  message(id: string): StoredMessage | null {
    for (const m of this.mirrors.values()) {
      const it = m.items.get(liveKey('message', id))
      if (it?.data && !it.deleted) return messageFromPlain(id, it.data)
    }
    return null
  }

  chatOfMessage(id: string): string | null {
    const msg = this.message(id)
    return msg ? this.chatOfSession(msg.sessionId) : null
  }

  private loadedMessages(m: ViewMirror, sessionId: string): StoredMessage[] {
    const out: StoredMessage[] = []
    for (const it of m.items.values())
      if (it.type === 'message' && it.data && !it.deleted && it.data.sessionId === sessionId)
        out.push(messageFromPlain(it.id, it.data))
    return out.sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1))
  }

  /** Mensagens já carregadas de uma sessão (síncrono). */
  sessionMessages(sessionId: string): StoredMessage[] {
    const chatId = this.chatOfSession(sessionId)
    const m = chatId ? this.mirrors.get(chatId) : null
    return m ? this.loadedMessages(m, sessionId) : []
  }

  /** Mensagens de uma sessão (subsessões: busca no host na primeira vez). */
  async messages(sessionId: string): Promise<StoredMessage[]> {
    const chatId = this.chatOfSession(sessionId)
    const m = chatId ? this.mirrors.get(chatId) : null
    if (!m) return []
    if (!m.loadedSessions.has(sessionId)) {
      const gen = m.gen
      const items = await this.listAll(m, gen, 'message', sessionId)
      await this.fillItems(m, gen, items)
      if (gen !== m.gen) return []
      for (const it of items) this.mergeItem(m, it, false)
      m.loadedSessions.add(sessionId)
    }
    return this.loadedMessages(m, sessionId)
  }

  /** Arquivos de anexo citados no histórico carregado do chat. */
  private chatOfFile(file: string): string | null {
    for (const m of this.mirrors.values())
      for (const it of m.items.values()) if (it.data && filesOf(it.data).has(file)) return m.chatId
    return null
  }

  // ---------------- anexos (§23.7) ----------------

  private putAtt(file: string, buf: Buffer): void {
    this.dropAtt(file)
    this.att.set(file, buf)
    this.attBytes += buf.length
    for (const [k, v] of this.att) {
      if (this.attBytes <= ATT_CACHE_MAX) break
      this.att.delete(k)
      this.attBytes -= v.length
    }
  }

  private dropAtt(file: string): void {
    const b = this.att.get(file)
    if (b) {
      this.att.delete(file)
      this.attBytes -= b.length
    }
  }

  /**
   * Bytes de um anexo do histórico de um chat ao vivo aberto, baixados do host (attach.get) e
   * conferidos pelo SHA-256 do nome — só em memória. null = não é de chat ao vivo / falhou.
   */
  attachment(file: string): Promise<Buffer | null> {
    if (!LIVE_ATTACH_FILE_RE.test(file)) return Promise.resolve(null)
    const hit = this.att.get(file)
    if (hit) {
      this.att.delete(file)
      this.att.set(file, hit)
      return Promise.resolve(hit)
    }
    const chatId = this.chatOfFile(file)
    if (!chatId || !this.hostOnline(chatId)) return Promise.resolve(null)
    const cur = this.attLoading.get(file)
    if (cur) return cur
    const p = (async (): Promise<Buffer | null> => {
      try {
        const first = await this.cmd(chatId, 'attach.get', {
          file,
          offset: 0,
          length: LIVE_LIMITS.attachChunkBytes
        })
        const size = Number(first.size ?? 0)
        const parts: Buffer[] = [Buffer.from(String(first.data ?? ''), 'base64')]
        let offset = parts[0].length
        const offsets: number[] = []
        for (let o = offset; o < size; o += LIVE_LIMITS.attachChunkBytes) offsets.push(o)
        const chunks = await Promise.all(
          offsets.map((o) =>
            this.cmd(chatId, 'attach.get', {
              file,
              offset: o,
              length: LIVE_LIMITS.attachChunkBytes
            }).then((r) => Buffer.from(String(r.data ?? ''), 'base64'))
          )
        )
        parts.push(...chunks)
        const buf = Buffer.concat(parts)
        offset = buf.length
        if (offset !== size) throw new Error('tamanho diferente')
        const sha = createHash('sha256').update(buf).digest('hex')
        if (sha !== file.slice(0, 64)) throw new Error('SHA-256 diferente')
        this.putAtt(file, buf)
        return buf
      } catch (e) {
        this.engine.log('chat ao vivo: anexo', errMsg(e))
        return null
      } finally {
        this.attLoading.delete(file)
      }
    })()
    this.attLoading.set(file, p)
    return p
  }

  /**
   * Envia um arquivo do composer ao host (attach.put em pedaços contíguos, §23.7) e devolve o
   * `AttachmentInfo` salvo no host. Os bytes ficam só em memória aqui (miniatura do composer).
   */
  async upload(
    chatId: string,
    input: { name: string; mime?: string; data: Uint8Array },
    onProgress?: (received: number, size: number) => void
  ): Promise<AttachmentInfo> {
    const data = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength)
    const size = data.length
    if (!size) throw new LiveViewError(`"${input.name}" está vazio.`)
    if (size > LIVE_LIMITS.attachMaxFileBytes)
      throw new LiveViewError(
        `"${input.name}" passa do limite de ${LIVE_LIMITS.attachMaxFileBytes / 1024 / 1024} MB por arquivo.`
      )
    const sha256 = createHash('sha256').update(data).digest('hex')
    const base = {
      uploadId: randomUUID(),
      name: input.name,
      ...(input.mime ? { mime: input.mime } : {}),
      size,
      sha256
    }
    let offset = 0
    let restarts = 0
    for (let guard = 0; guard < 10_000; guard++) {
      const chunk = data.subarray(offset, offset + LIVE_LIMITS.attachChunkBytes)
      let r: Record<string, unknown>
      try {
        r = await this.cmd(chatId, 'attach.put', {
          ...base,
          offset,
          data: chunk.toString('base64')
        })
      } catch (e) {
        if (e instanceof LiveViewError && e.code === 'offset' && restarts++ < 5) {
          // o host diz de onde continuar
          const got = Number(e.result.received)
          if (Number.isSafeInteger(got) && got >= 0 && got <= size) {
            offset = got
            continue
          }
          throw e
        }
        if (e instanceof LiveViewError && e.code === 'expired' && restarts++ < 2) {
          offset = 0
          base.uploadId = randomUUID()
          continue
        }
        throw e
      }
      const received = Number(r.received ?? 0)
      onProgress?.(received, size)
      if (r.done === true) {
        const info = r.attachment as AttachmentInfo
        if (!info || typeof info.file !== 'string' || !LIVE_ATTACH_FILE_RE.test(info.file))
          throw new LiveViewError('Resposta inválida do host.')
        this.putAtt(info.file, Buffer.from(data))
        return info
      }
      offset = received
    }
    throw new LiveViewError('Envio interrompido.')
  }

  /** Bytes de um anexo que este dispositivo acabou de enviar (miniatura do composer). */
  cachedAttachment(file: string): Buffer | null {
    return this.att.get(file) ?? null
  }

  /** Para a lista do protocolo de anexos: o arquivo é de um chat ao vivo aberto aqui? */
  ownsFile(file: string): boolean {
    return this.att.has(file) || !!this.chatOfFile(file)
  }

  /** Para comandos com `attachments`: o envio é referência ao store do host (nada de blob). */
  hostRefs(list: AttachmentInfo[]): AttachmentInfo[] {
    return list.map((a) => ({ ...a }))
  }

  /** Recusa da tela de configuração (o host aplica e devolve). */
  async updateChat(
    chatId: string,
    patch: { title?: string; config?: Partial<ChatConfig> }
  ): Promise<void> {
    const config = patch.config ? { ...patch.config } : undefined
    if (config) delete (config as Partial<ChatConfig> & { cwd?: string }).cwd
    await this.cmd(chatId, 'chat.update', {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(config && Object.keys(config).length ? { config } : {})
    })
  }
}

/** Arquivos do store citados num plaintext (`clearchat-attachment://<file>`). */
function filesOf(data: Plain): Set<string> {
  const out = new Set<string>()
  const s = JSON.stringify(data)
  for (const m of s.matchAll(/clearchat-attachment:\/\/([0-9a-f]{64}\.[a-z0-9]{1,10})/g))
    out.add(m[1])
  return out
}
