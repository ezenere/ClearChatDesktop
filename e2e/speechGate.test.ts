/* eslint-disable @typescript-eslint/no-explicit-any */
// Portão de ativação de fala (`@shared/speechGate`) na frente da transcrição: silêncio/ruído nunca
// chegam ao STT (mock — nada de rede real), o que vai é aparado, o pós-filtro tira as alucinações de
// silêncio do whisper ("Tchau.", "Obrigado.", "Legendas pela comunidade Amara.org") sem tocar no texto
// real, e o nível de ativação é LOCAL do dispositivo (normalizador + sync).
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/speechGate.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  ACTIVATION_DB_RANGE,
  DEFAULT_ACTIVATION_DB,
  MIN_VOICED_MS,
  SILENCE_HALLUCINATIONS,
  SpeechGate,
  dbToRms,
  filterSilenceHallucination,
  isSilenceHallucination,
  normalizeActivationDb,
  rmsToDb
} from '../src/shared/speechGate.ts'
import { startTranscribeSession, VOICE_SAMPLE_RATE } from '../src/main/voice/session.ts'
import { DEFAULT_STT_SETTINGS, normalizeAudioInput, type SttSettings } from '../src/shared/voice.ts'
import { SCHEMA } from '../src/main/dbSchema'
import { ensureMemorySchema } from '../src/main/memory/schema'
import { ensureSearchIndex } from '../src/main/searchIndex'
import { ensureSyncSchema } from '../src/main/sync/schema'
import { applyRemote, buildLocal } from '../src/main/sync/records'

// ---------------- sinais sintéticos (PCM16 mono 16 kHz) ----------------

const SR = VOICE_SAMPLE_RATE

/** Trecho de `ms` com nível `db` (dBFS de RMS): seno de 220 Hz (−∞ = silêncio digital). */
function tone(ms: number, db: number | null, seed = 1): Int16Array {
  const n = Math.round((SR * ms) / 1000)
  const out = new Int16Array(n)
  if (db == null) return out
  const amp = dbToRms(db) * Math.SQRT2 * 32767
  for (let i = 0; i < n; i++)
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * (i + seed)) / SR))
  return out
}

/** Ruído branco determinístico com RMS `db`. */
function noise(ms: number, db: number): Int16Array {
  const n = Math.round((SR * ms) / 1000)
  const out = new Int16Array(n)
  let x = 12345
  const amp = dbToRms(db) * Math.sqrt(3) * 32767
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out[i] = Math.round(amp * (2 * (x / 0x7fffffff) - 1))
  }
  return out
}

const join = (...parts: Int16Array[]): Uint8Array => {
  const total = parts.reduce((a, p) => a + p.length, 0)
  const out = new Int16Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return new Uint8Array(out.buffer)
}

/** "Fala" sintética: sílabas de 180 ms (−24 dB) com pausas de 60 ms — `ms` no total. */
function speech(ms: number): Int16Array {
  const parts: Int16Array[] = []
  for (let t = 0; t < ms; t += 240) parts.push(tone(180, -24, t), tone(60, -60))
  const all = join(...parts)
  return new Int16Array(all.buffer).slice(0, Math.round((SR * ms) / 1000))
}

// ---------------- puros ----------------

test('nível de ativação: padrão −45 dB, preso em −70…−20, lixo → padrão; dB ↔ RMS', () => {
  assert.equal(DEFAULT_ACTIVATION_DB, -45)
  assert.equal(normalizeActivationDb(undefined), -45)
  assert.equal(normalizeActivationDb('x'), -45)
  assert.equal(normalizeActivationDb(-200), ACTIVATION_DB_RANGE.min)
  assert.equal(normalizeActivationDb(0), ACTIVATION_DB_RANGE.max)
  assert.equal(normalizeActivationDb(-33.4), -33)
  assert.ok(Math.abs(rmsToDb(dbToRms(-37)) + 37) < 1e-9)
  assert.equal(rmsToDb(0), -120)
})

test('SpeechGate: silêncio e ruído abaixo da ativação → nada vai ao STT', () => {
  const g = new SpeechGate()
  const pcm = join(tone(1500, null), noise(1500, -55))
  g.push(pcm)
  const a = g.analyze(0, pcm.length)
  assert.equal(a.voicedMs, 0)
  assert.equal(a.send, null)
  assert.equal(a.finalIsland, false)
})

test('SpeechGate: fala curta demais (< 280 ms de voz) não vai; fala real vai aparada com folga', () => {
  const short = new SpeechGate()
  const s = join(tone(500, null), tone(200, -24), tone(800, null))
  short.push(s)
  const a = short.analyze(0, s.length)
  assert.ok(a.voicedMs < MIN_VOICED_MS)
  assert.equal(a.send, null, 'um estalo/tosse curta não chama o STT')

  const g = new SpeechGate()
  const lead = tone(1000, null)
  const body = speech(1200)
  const tail = tone(1500, null)
  const pcm = join(lead, body, tail)
  g.push(pcm)
  const r = g.analyze(0, pcm.length)
  assert.ok(r.voicedMs >= 800, `voz: ${r.voicedMs}`)
  assert.ok(r.send, 'fala real passa')
  const leadBytes = lead.length * 2
  const bodyEnd = leadBytes + body.length * 2
  const bytesPerMs = (SR * 2) / 1000
  // começa ~200 ms antes da 1ª voz e termina ~300 ms depois da última (nunca corta a fala)
  assert.ok(r.send!.start <= leadBytes && r.send!.start >= leadBytes - 220 * bytesPerMs)
  assert.ok(r.send!.end >= bodyEnd - 70 * bytesPerMs && r.send!.end <= bodyEnd + 320 * bytesPerMs)
  assert.ok(r.tailQuietMs >= 1400, `silêncio no fim: ${r.tailQuietMs}`)
})

test('SpeechGate: piso de ruído adaptativo — sala com ruído exige 10 dB acima dele', () => {
  // ruído constante a −50 dB (abaixo da ativação padrão) por 3 s: o piso sobe até perto de −50
  const g = new SpeechGate()
  g.push(join(noise(3000, -50)))
  assert.ok(g.noiseFloorDb > -55, `piso: ${g.noiseFloorDb}`)
  assert.ok(g.thresholdDb > -45, `limiar: ${g.thresholdDb}`)
  // uma voz a −43 dB (que passaria numa sala silenciosa) agora não conta como fala
  const before = g.frames
  g.push(join(tone(600, -43)))
  let voiced = 0
  for (let i = before; i < g.frames; i++) if (g.voiced(i)) voiced++
  assert.equal(voiced, 0)
  // e o piso atravessa sessões (o chamador passa o aprendido)
  const next = new SpeechGate({ noiseFloorDb: g.noiseFloorDb })
  assert.ok(next.thresholdDb > -45)
  // fala normal (−24 dB) continua passando com folga
  const pcm = join(speech(1000))
  next.push(pcm)
  assert.ok(next.analyze(0, pcm.length).send)
})

test('pós-filtro: alucinação de silêncio com pouca voz some; a mesma frase dita de verdade fica', () => {
  assert.ok(SILENCE_HALLUCINATIONS.includes('tchau'))
  assert.ok(isSilenceHallucination('Tchau.'))
  assert.ok(isSilenceHallucination('…'))
  assert.ok(isSilenceHallucination('Legendas pela comunidade Amara.org'))
  assert.ok(!isSilenceHallucination('Tchau, até amanhã às nove'))
  const short = { voicedMs: 300, finalIsland: false }
  assert.equal(filterSilenceHallucination('Tchau.', short), '')
  assert.equal(filterSilenceHallucination('Obrigado.', short), '')
  assert.equal(filterSilenceHallucination('...', short), '')
  // dita de verdade (voz suficiente): fica
  assert.equal(
    filterSilenceHallucination('Tchau.', { voicedMs: 600, finalIsland: false }),
    'Tchau.'
  )
  // texto demais para a voz que houve (5 palavras em 0,5 s de voz)
  assert.equal(
    filterSilenceHallucination('Legendas pela comunidade Amara.org', {
      voicedMs: 500,
      finalIsland: false
    }),
    ''
  )
  // frase grudada no fim de uma transcrição maior, sem ilha de voz própria no fim → sai
  assert.equal(
    filterSilenceHallucination('Abre o arquivo de configuração. Obrigado.', {
      voicedMs: 1800,
      finalIsland: false
    }),
    'Abre o arquivo de configuração.'
  )
  assert.equal(
    filterSilenceHallucination('Pode desligar. Tchau.', { voicedMs: 1800, finalIsland: false }),
    'Pode desligar.'
  )
  // com uma ilha de voz própria no fim (pausa + fala), a despedida foi dita → fica
  assert.equal(
    filterSilenceHallucination('Pode desligar. Tchau.', { voicedMs: 1800, finalIsland: true }),
    'Pode desligar. Tchau.'
  )
  // texto real passa intacto
  for (const t of ['Obrigado pela ajuda com o arquivo.', 'Lista os arquivos da pasta src.'])
    assert.equal(filterSilenceHallucination(t, { voicedMs: 900, finalIsland: false }), t)
})

test('SpeechGate: ilha de voz final (pausa ≥ 250 ms + ≥ 250 ms de voz) detectada', () => {
  const g = new SpeechGate()
  const pcm = join(speech(1200), tone(500, null), speech(500), tone(800, null))
  g.push(pcm)
  assert.equal(g.analyze(0, pcm.length).finalIsland, true)
  const h = new SpeechGate()
  const cont = join(speech(1700), tone(800, null))
  h.push(cont)
  assert.equal(h.analyze(0, cont.length).finalIsland, false, 'fala contínua até o fim')
})

// ---------------- na sessão de transcrição (todas as vias) ----------------

const sttSettings = (over: Partial<SttSettings> = {}): SttSettings => ({
  ...DEFAULT_STT_SETTINGS,
  ...over,
  api: {
    ...DEFAULT_STT_SETTINGS.api,
    providerId: 'p-groq',
    baseUrl: 'https://stt.example/v1',
    apiKey: 'sk-test',
    ...(over.api ?? {})
  }
})

function mockFetch(text: string | ((n: number) => string)): {
  calls: Uint8Array[]
  restore: () => void
} {
  const calls: Uint8Array[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const file = (init?.body as FormData).get('file') as Blob
    calls.push(new Uint8Array(await file.arrayBuffer()))
    const t = typeof text === 'function' ? text(calls.length) : text
    return new Response(JSON.stringify({ text: t }), { status: 200 })
  }) as typeof fetch
  return { calls, restore: () => (globalThis.fetch = orig) }
}

test('sessão: silêncio/ruído nunca chegam ao STT — final, especulação, parciais e segmentos', async (t) => {
  const m = mockFetch('Tchau.')
  t.after(m.restore)
  let now = 1_000_000
  const s = startTranscribeSession(
    { settings: sttSettings({ livePartials: true, mode: 'api' }) },
    { now: () => now, segmented: true }
  )
  // 12 s de silêncio + ruído baixo (abaixo da ativação), em pedaços de 100 ms, com o relógio
  // andando (as parciais teriam disparado várias vezes)
  for (let i = 0; i < 120; i++) {
    s.push(join(i % 2 ? noise(100, -58) : tone(100, null)), SR)
    now += 100
  }
  const spec = await s.speculate({ allowApi: true })
  assert.equal(spec?.text, '', 'especulação sem voz = vazio, sem request')
  const r = await s.stop()
  assert.equal(r.text, '')
  assert.equal(m.calls.length, 0, 'nenhuma request de STT')
})

test('sessão: fala real vai ao STT aparada; "Tchau." inventado sobre um estalo curto vira vazio', async (t) => {
  const m = mockFetch('Lista os arquivos da pasta src.')
  t.after(m.restore)
  const s = startTranscribeSession({ settings: sttSettings({ livePartials: false }) })
  const lead = tone(1500, null)
  const body = speech(1500)
  const pcm = join(lead, body, tone(2000, null))
  s.push(pcm, SR)
  const r = await s.stop()
  assert.equal(r.text, 'Lista os arquivos da pasta src.')
  assert.equal(m.calls.length, 1)
  // o wav enviado é bem menor que o buffer (sem o 1,5 s de silêncio antes e os 2 s depois)
  const sentPcm = m.calls[0].length - 44
  assert.ok(sentPcm < pcm.length * 0.6, `enviado ${sentPcm} de ${pcm.length} bytes`)
  assert.ok(sentPcm >= body.length * 2, 'a fala inteira foi')

  // um estalo de ~300 ms de voz e o STT devolve "Tchau." (alucinação): descartado
  const m2 = mockFetch('Tchau.')
  t.after(m2.restore)
  const s2 = startTranscribeSession({ settings: sttSettings({ livePartials: false }) })
  s2.push(join(tone(800, null), tone(320, -24), tone(1500, null)), SR)
  const r2 = await s2.stop()
  assert.equal(m2.calls.length, 1, 'passou do portão (voz ≥ 280 ms)…')
  assert.equal(r2.text, '', '…mas o pós-filtro descarta o "Tchau." sem voz suficiente')
})

// ---------------- nível de ativação: local do dispositivo ----------------

function newDb(): Database.Database {
  const conn = new Database(':memory:')
  conn.exec(SCHEMA)
  conn.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT')
  conn.exec("ALTER TABLE providers ADD COLUMN kind TEXT NOT NULL DEFAULT ''")
  ensureMemorySchema(conn)
  ensureSearchIndex(conn)
  ensureSyncSchema(conn)
  return conn
}
const putSetting = (conn: Database.Database, key: string, value: unknown): void =>
  void conn
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, JSON.stringify(value))
const getSetting = (conn: Database.Database, key: string): any => {
  const r = conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return r ? JSON.parse(r.value) : undefined
}

test('audioInput.activationDb: normalizado e local do dispositivo (audioInput inteiro não sincroniza desde 1.9.0)', () => {
  assert.equal(normalizeAudioInput({}).activationDb, -45)
  assert.equal(normalizeAudioInput({ activationDb: -38 }).activationDb, -38)
  const a = newDb()
  const b = newDb()
  putSetting(a, 'audioInput', normalizeAudioInput({ deviceId: 'mic-a', activationDb: -30 }))
  putSetting(b, 'audioInput', normalizeAudioInput({ deviceId: 'mic-b', activationDb: -52 }))
  // protocolo 1.9.0: `audioInput` é local do dispositivo — nunca vira registro
  assert.equal(buildLocal(a, 'setting', 'audioInput'), null, 'o audioInput de A não sai')
  // registro de um app ≤ 1.8.x (com ou sem o nível): ignorado — B fica com o dele
  applyRemote(b, 'setting', 'audioInput', {
    sv: 1,
    value: { pttEnabled: false, language: 'en-US', activationDb: -20 }
  })
  assert.equal(getSetting(b, 'audioInput').activationDb, -52, 'B mantém o próprio nível')
  assert.equal(getSetting(b, 'audioInput').deviceId, 'mic-b')
  assert.equal(getSetting(b, 'audioInput').language, 'pt-BR')
  applyRemote(b, 'setting', 'audioInput', { sv: 1, value: null })
  assert.equal(getSetting(b, 'audioInput').activationDb, -52, 'null recebido não apaga nada')
})

// ---------------- a detecção de fala da chamada (renderer) usa a MESMA regra ----------------

test('chamada: ruído de sala abaixo da ativação nunca abre turno nem abaixa a resposta; fala ainda passa', async () => {
  const { LevelGate } = await import('../src/shared/speechGate.ts')
  const { AdaptiveTurnGate } = await import('../src/shared/voiceTurn.ts')
  const { DEFAULT_TURN_TIMING, DEFAULT_BARGE_IN } = await import('../src/shared/voice.ts')
  const { PlaybackDuck } = await import('../src/shared/voicePolicy.ts')
  const FRAME = 33 // quadros de nível da captura (~30 Hz), como o `useVoiceCall`
  const level = new LevelGate({ activationDb: DEFAULT_ACTIVATION_DB })
  const turn = new AdaptiveTurnGate(DEFAULT_TURN_TIMING, 0.5)
  const duck = new PlaybackDuck(DEFAULT_BARGE_IN)
  const events: string[] = []
  // como o renderer: quadro → 1 (fala) / 0 → gate de turno; fala com a resposta tocando → ducking
  const frame = (db: number): void => {
    const v = level.pushRms(dbToRms(db), FRAME) ? 1 : 0
    const ev = turn.push(v, FRAME)
    if (ev) events.push(ev)
    if (ev === 'start' && !duck.open) {
      duck.start(v, FRAME, 0.5)
      events.push('duck')
    }
  }
  // 20 s de ruído constante (ventilador/ar) com leve variação, sempre abaixo da ativação (−45)
  let x = 7
  for (let i = 0; i < 600; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    frame(-52 + ((x % 1000) / 1000) * 5) // −52…−47 dB
  }
  assert.deepEqual(events, [], 'nenhum quadro de ruído virou fala: sem turno, sem ducking')
  assert.ok(level.noiseFloorDb > -55, `o piso aprendeu o ruído: ${level.noiseFloorDb}`)
  // a fala de verdade (−24 dB) por cima do ruído continua abrindo o turno
  for (let i = 0; i < 15; i++) frame(-24)
  assert.ok(events.includes('start'), `fala detectada: ${events.join(',')}`)
  // e o nível de ativação ajustado para cima silencia um ruído mais alto (−40 dB)
  const loud = new LevelGate({ activationDb: -35 })
  let voiced = 0
  for (let i = 0; i < 300; i++) if (loud.pushRms(dbToRms(-40), FRAME)) voiced++
  assert.equal(voiced, 0)
})
