// Áudio/voz: contratos de configuração — defaults quando null/ausente, campos com significado
// próprio preservados (silenceStopMs: 0, enabled: null ≠ false), normalização tolerante a valores
// inválidos, o campo legado `interjections` descartado (protocolo §4.3.6) e ligação com personas
// (PRESET_FIELDS + sanitizePresetConfig).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyVoiceCallChat,
  resolveVoiceCallConfig,
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_LOCAL,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_CONFIG,
  DEFAULT_VOICE_CALL_DEFAULTS,
  DEFAULT_FILLER_POOL,
  DEFAULT_TURN_TIMING,
  DEFAULT_VOICE_BASE_PROMPT,
  FILLER_POOL_MAX,
  normalizeFillerPool,
  resolveFillerPool,
  resolveTurnTiming,
  normalizeAudioInput,
  normalizeSttSettings,
  normalizeTtsSettings,
  normalizeVoiceCallConfig,
  normalizeVoiceCallDefaults
} from '../src/shared/voice.ts'
import { PRESET_FIELDS, sanitizePresetConfig } from '../src/shared/presets.ts'

// ---------------- defaults quando null/ausente/inválido ----------------

test('defaults aplicados quando null/ausente', () => {
  for (const v of [null, undefined, 'x', 42, [], true]) {
    assert.deepEqual(normalizeAudioInput(v), DEFAULT_AUDIO_INPUT)
    assert.deepEqual(normalizeSttSettings(v), DEFAULT_STT_SETTINGS)
    assert.deepEqual(normalizeTtsSettings(v), DEFAULT_TTS_SETTINGS)
    assert.deepEqual(normalizeVoiceCallDefaults(v), DEFAULT_VOICE_CALL_DEFAULTS)
    assert.deepEqual(normalizeVoiceCallConfig(v), DEFAULT_VOICE_CALL_CONFIG)
  }
  // objeto vazio também cai nos padrões (campos não são opcionais nos valores normalizados)
  assert.deepEqual(normalizeAudioInput({}), DEFAULT_AUDIO_INPUT)
  assert.deepEqual(normalizeSttSettings({}), DEFAULT_STT_SETTINGS)
  assert.deepEqual(normalizeTtsSettings({}), DEFAULT_TTS_SETTINGS)
  assert.deepEqual(normalizeVoiceCallDefaults({}), DEFAULT_VOICE_CALL_DEFAULTS)
  assert.deepEqual(normalizeVoiceCallConfig({}), DEFAULT_VOICE_CALL_CONFIG)
})

test('os DEFAULT_* são JSON-serializáveis (round-trip igual)', () => {
  for (const d of [
    DEFAULT_AUDIO_INPUT,
    DEFAULT_STT_SETTINGS,
    DEFAULT_TTS_SETTINGS,
    DEFAULT_VOICE_CALL_DEFAULTS,
    DEFAULT_VOICE_CALL_CONFIG,
    normalizeVoiceCallConfig({ enabled: true, voicePrompt: 'fale curto' })
  ])
    assert.deepEqual(JSON.parse(JSON.stringify(d)), d)
})

test('defaults de produto: chamada de voz e preâmbulos ligados (sem interjeições); TTS local aponta o Kokoro', () => {
  assert.equal(DEFAULT_VOICE_CALL_DEFAULTS.enabled, true)
  assert.ok(!('interjections' in DEFAULT_VOICE_CALL_DEFAULTS))
  assert.ok(!('interjections' in DEFAULT_VOICE_CALL_CONFIG))
  assert.equal(DEFAULT_VOICE_CALL_DEFAULTS.fillers.enabled, true)
  assert.deepEqual(DEFAULT_TTS_SETTINGS.local, DEFAULT_TTS_LOCAL)
  assert.deepEqual(DEFAULT_TTS_LOCAL, { engine: 'kokoro', voice: 'pf_dora', installed: false })
})

// ---------------- entrada de áudio ----------------

test('silenceStopMs: 0 é válido e preservado (não vira default)', () => {
  assert.equal(normalizeAudioInput({ silenceStopMs: 0 }).silenceStopMs, 0)
  // inválido/negativo → padrão; arredondado para inteiro
  assert.equal(normalizeAudioInput({ silenceStopMs: -1 }).silenceStopMs, 5000)
  assert.equal(normalizeAudioInput({ silenceStopMs: '5000' }).silenceStopMs, 5000)
  assert.equal(normalizeAudioInput({ silenceStopMs: 4999.6 }).silenceStopMs, 5000)
})

test('audioInput: booleanos explícitos valem, strings aparadas, null = padrão do sistema', () => {
  const s = normalizeAudioInput({
    deviceId: '  mic-2  ',
    pttEnabled: false,
    pttKey: ' Ctrl+Shift+Space ',
    silenceStopEnabled: false,
    language: ' en-US '
  })
  assert.deepEqual(s, {
    deviceId: 'mic-2',
    activationDb: -45,
    pttEnabled: false,
    pttKey: 'Ctrl+Shift+Space',
    silenceStopEnabled: false,
    silenceStopMs: 5000,
    language: 'en-US'
  })
  // false não vira default; vazio/não-string volta ao padrão
  assert.equal(normalizeAudioInput({ pttEnabled: false }).pttEnabled, false)
  assert.equal(normalizeAudioInput({ silenceStopEnabled: false }).silenceStopEnabled, false)
  assert.equal(normalizeAudioInput({ deviceId: '   ' }).deviceId, null)
  assert.equal(normalizeAudioInput({ language: '' }).language, 'pt-BR')
  assert.equal(normalizeAudioInput({ pttKey: 7 }).pttKey, null)
  // nível de ativação (local do dispositivo): lixo → −45; preso em −70…−20; inteiro
  assert.equal(normalizeAudioInput({ activationDb: 'x' }).activationDb, -45)
  assert.equal(normalizeAudioInput({ activationDb: -90 }).activationDb, -70)
  assert.equal(normalizeAudioInput({ activationDb: -5 }).activationDb, -20)
  assert.equal(normalizeAudioInput({ activationDb: -51.6 }).activationDb, -52)
})

// ---------------- transcrição (STT) ----------------

test('sttSettings: modo validado, sem provedor por padrão, local null = nenhum instalado', () => {
  const s = normalizeSttSettings({ mode: 'hybrid', livePartials: false })
  assert.equal(s.mode, 'hybrid')
  assert.equal(s.livePartials, false)
  assert.deepEqual(s.api, DEFAULT_STT_SETTINGS.api)
  assert.equal(s.local, null)
  assert.equal(s.api.providerId, null, 'sem provedor escolhido por padrão')
  // modo desconhecido → padrão; só provedor + modelo (baseUrl/apiKey antigos são descartados)
  const t = normalizeSttSettings({
    mode: 'wat',
    api: { providerId: '  ', baseUrl: ' https://exemplo.test/v1 ', apiKey: ' sk-x ', model: 'w' },
    local: { engine: 'vosk', model: ' pt ', installed: true }
  })
  assert.equal(t.mode, 'api')
  assert.deepEqual(t.api, { providerId: null, model: 'w' })
  assert.deepEqual(t.local, { engine: 'vosk', model: 'pt', installed: true })
})

test('sttSettings.local: engine inválido → whisper.cpp; installed false preservado; lixo → null', () => {
  const s = normalizeSttSettings({ local: { engine: 'wat', installed: false } })
  assert.deepEqual(s.local, { engine: 'whisper.cpp', model: '', installed: false })
  assert.equal(normalizeSttSettings({ local: 'kokoro' }).local, null)
  assert.equal(normalizeSttSettings({ local: null }).local, null)
})

// ---------------- fala (TTS) ----------------

test('ttsSettings: backend padrão local; local padrão = Kokoro não instalado; null explícito = limpo', () => {
  assert.equal(DEFAULT_TTS_SETTINGS.backend, 'local')
  assert.deepEqual(DEFAULT_TTS_SETTINGS.local, {
    engine: 'kokoro',
    voice: 'pf_dora',
    installed: false
  })
  // local ausente/lixo → o padrão (Kokoro); local: null salvo é preservado (usuário limpou)
  assert.deepEqual(normalizeTtsSettings({ backend: 'api' }).local, DEFAULT_TTS_SETTINGS.local)
  assert.deepEqual(normalizeTtsSettings({ local: 'kokoro' }).local, DEFAULT_TTS_SETTINGS.local)
  assert.equal(normalizeTtsSettings({ local: null }).local, null)
  const s = normalizeTtsSettings({ backend: 'api', api: { voice: ' shimmer ' } })
  assert.equal(s.backend, 'api')
  assert.equal(s.api.voice, 'shimmer')
  assert.equal('baseUrl' in s.api || 'apiKey' in s.api, false, 'endereço/chave nunca gravados')
  const l = normalizeTtsSettings({ local: { voice: ' bf_emma ' } })
  assert.deepEqual(l.local, { engine: 'kokoro', voice: 'bf_emma', installed: false })
  // voz vazia → a voz padrão; engine desconhecida → kokoro; backend desconhecido → padrão
  assert.equal(normalizeTtsSettings({ local: { voice: '' } }).local?.voice, 'pf_dora')
  assert.equal(normalizeTtsSettings({ local: { engine: 'wat' } }).local?.engine, 'kokoro')
  assert.equal(normalizeTtsSettings({ backend: 'wat' }).backend, 'local')
  assert.equal(normalizeTtsSettings({ api: { voice: 7 } }).api.voice, null)
})

// ---------------- chamada de voz (ChatConfig.voice) ----------------

test('enabled: null ≠ false (null herda o padrão global)', () => {
  assert.equal(normalizeVoiceCallConfig({ enabled: null }).enabled, null)
  assert.equal(normalizeVoiceCallConfig({}).enabled, null)
  assert.equal(normalizeVoiceCallConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeVoiceCallConfig({ enabled: true }).enabled, true)
  assert.equal(normalizeVoiceCallConfig({ enabled: 'yes' }).enabled, null)
  // null ≠ objeto: fillers/model/tools null herdam; objeto vira config normalizada
  assert.equal(normalizeVoiceCallConfig({ fillers: null }).fillers, null)
  // objeto presente = override; enabled ausente completa com o padrão (ligado); false explícito vale
  assert.deepEqual(normalizeVoiceCallConfig({ fillers: {} }).fillers, {
    enabled: true,
    prompt: null
  })
  assert.equal(normalizeVoiceCallConfig({ fillers: { enabled: false } }).fillers?.enabled, false)
})

test('interjections é legado (protocolo §4.3.6): registros antigos com o campo são lidos e ele some', () => {
  const legacy = {
    enabled: true,
    model: { providerId: 'p1', model: 'call/m', params: {} },
    tools: null,
    voicePrompt: 'curto',
    fillers: { enabled: false, prompt: null },
    interjections: { enabled: true, shadow: true, cooldownMs: 5000, classes: ['ACK'] },
    endCall: false
  }
  const cfg = normalizeVoiceCallConfig(legacy)
  assert.ok(!('interjections' in cfg), 'chat/persona: o campo não é copiado')
  assert.deepEqual(cfg, {
    enabled: true,
    model: { providerId: 'p1', model: 'call/m', params: {} },
    tools: null,
    voicePrompt: 'curto',
    fillers: { enabled: false, prompt: null },
    endCall: false
  })
  // null também (o padrão antigo `DEFAULT_VOICE_CALL_CONFIG` gravava `interjections: null`)
  assert.deepEqual(normalizeVoiceCallConfig({ interjections: null }), DEFAULT_VOICE_CALL_CONFIG)
  assert.ok(!JSON.stringify(normalizeVoiceCallConfig(legacy)).includes('interjections'))
  // global: some igual; o resto do registro antigo continua valendo
  const d = normalizeVoiceCallDefaults({
    enabled: false,
    interjections: { enabled: true, shadow: true },
    fillers: { enabled: false }
  })
  assert.ok(!('interjections' in d))
  assert.equal(d.enabled, false)
  assert.equal(d.fillers.enabled, false)
  // a resolução (persona → chat → global) nunca devolve o campo
  const r = resolveVoiceCallConfig(legacy, { interjections: { enabled: true } } as never, legacy)
  assert.ok(!('interjections' in r))
  assert.equal(r.fillers.enabled, false)
})

test('voiceCallConfig: campos desconhecidos descartados; params preservam as chaves que não conhecem', () => {
  const s = normalizeVoiceCallConfig({
    enabled: true,
    futuro: 'descartado',
    voicePrompt: 'responda em voz alta\r\nem 2 frases',
    model: {
      providerId: 'p1',
      model: 'm1',
      params: { temperature: 0.5, custom_key: 1, bad: undefined, nulo: null, nan: NaN },
      desconhecido: true
    },
    tools: { enabledTools: ['bash', 'shell', 'shell', 'read_file'], maxToolOutputChars: 12000 }
  })
  assert.ok(!('futuro' in s))
  assert.equal(s.enabled, true)
  assert.equal(s.voicePrompt, 'responda em voz alta\nem 2 frases')
  assert.deepEqual(s.model, {
    providerId: 'p1',
    model: 'm1',
    params: { temperature: 0.5, custom_key: 1 }
  })
  // alias antigo mapeado e sem duplicatas (mesma semântica de normalizeToolList)
  assert.deepEqual(s.tools, { enabledTools: ['shell', 'read_file'], maxToolOutputChars: 12000 })
  assert.deepEqual(normalizeVoiceCallConfig({ tools: { enabledTools: null } }).tools, {
    enabledTools: null,
    maxToolOutputChars: null
  })
  // model parcial (sem modelo) não vale → herda o do chat
  assert.equal(normalizeVoiceCallConfig({ model: { providerId: 'p1' } }).model, null)
  // maxToolOutputChars: 0 válido; inválido → null (igual ao chat)
  assert.equal(
    normalizeVoiceCallConfig({ tools: { maxToolOutputChars: 0 } }).tools?.maxToolOutputChars,
    0
  )
  assert.equal(
    normalizeVoiceCallConfig({ tools: { maxToolOutputChars: 'x' } }).tools?.maxToolOutputChars,
    null
  )
})

test('voiceCallDefaults: parcial completa com os padrões; nested normalizado', () => {
  const d = normalizeVoiceCallDefaults({
    enabled: true,
    fillers: { prompt: 'fale "ãh"\r' }
  })
  assert.deepEqual(d, {
    enabled: true,
    fillers: { enabled: true, prompt: 'fale "ãh"', delayMs: 250, pool: null },
    turn: {
      silenceStopMs: null,
      adaptive: true,
      speculativeAtMs: 250,
      completeSilenceMs: 600,
      statementSilenceMs: 1200,
      unfinishedSilenceMs: 1500,
      speculativeApi: false,
      duckGain: 0.3,
      bargeInVoicedMs: 700,
      bargeInWords: 3,
      duckRestoreMs: 450
    },
    model: null,
    basePromptEnabled: true,
    basePrompt: null,
    endCall: true,
    // frases de demora (aditivo): ausente = os padrões
    delayPhrases: {
      enabled: true,
      keepAliveAfterMs: 8000,
      apologyAfterMs: 15_000,
      keepAlivePool: null,
      apologyPool: null
    },
    // tags de voz (aditivo; opt-in): desligadas, instrução padrão do app
    audioTags: false,
    audioTagsPrompt: null,
    // frases de ferramenta (aditivo): ligadas, pool padrão
    toolPhrases: { enabled: true, pool: null }
  })
  assert.deepEqual(normalizeVoiceCallDefaults({ fillers: null }), DEFAULT_VOICE_CALL_DEFAULTS)
  // "O agente pode encerrar a chamada": false explícito vale; lixo → padrão (ligado)
  assert.equal(normalizeVoiceCallDefaults({ endCall: false }).endCall, false)
  assert.equal(normalizeVoiceCallDefaults({ endCall: 'x' }).endCall, true)
  // false explícito no fillers global vale (não vira o padrão ligado)
  assert.equal(normalizeVoiceCallDefaults({ fillers: { enabled: false } }).fillers.enabled, false)
})

// ---------------- personas ----------------

test('PRESET_FIELDS contém voice e sanitizePresetConfig copia voice normalizado', () => {
  assert.ok((PRESET_FIELDS as readonly string[]).includes('voice'))
  const out = sanitizePresetConfig({
    model: 'm',
    // `interjections` legado (persona antiga): descartado na normalização
    voice: { enabled: true, interjections: { enabled: true, classes: [] } },
    desconhecido: 'sai'
  })
  assert.equal(out.model, 'm')
  assert.ok(!('desconhecido' in out))
  assert.deepEqual(out.voice, {
    enabled: true,
    model: null,
    tools: null,
    voicePrompt: null,
    fillers: null
  })
  // voice lixo → config vazia (tudo herda); voice ausente não entra
  assert.deepEqual(sanitizePresetConfig({ voice: 'x' }).voice, DEFAULT_VOICE_CALL_CONFIG)
  assert.ok(!('voice' in sanitizePresetConfig({ model: 'm' })))
  // memória/skills seguem iguais (nada de comportamento novo nelas)
  assert.deepEqual(sanitizePresetConfig({ memory: { enabled: true } }).memory, {
    enabled: true,
    collections: [],
    writeTo: {},
    categories: ['profile', 'topics', 'areas', 'people', 'preferences'],
    helpPrompt: { enabled: false, text: null },
    extraction: { auto: false, prompt: null, providerId: null, model: null },
    subagents: false
  })
})

// ---------------- fim de turno adaptativo / preâmbulos / prompt-base ----------------

test('resolveTurnTiming: padrões e coerência (completa ≤ afirmação ≤ inacabada; fallback no meio)', () => {
  assert.deepEqual(DEFAULT_TURN_TIMING, {
    adaptive: true,
    speculativeAtMs: 250,
    completeMs: 600,
    statementMs: 1200,
    unfinishedMs: 1500,
    fallbackMs: 1000,
    bargeIn: { duckGain: 0.3, voicedMs: 700, words: 3, restoreMs: 450 }
  })
  // silenceStopMs alto (2 s) puxa o teto; completo nunca passa do fallback
  const t = resolveTurnTiming({
    ...DEFAULT_VOICE_CALL_DEFAULTS.turn,
    silenceStopMs: 2000,
    completeSilenceMs: 3000
  })
  assert.equal(t.fallbackMs, 2000)
  assert.equal(t.unfinishedMs, 2000)
  assert.ok(t.completeMs <= t.statementMs && t.statementMs <= t.unfinishedMs)
  assert.ok(t.speculativeAtMs < t.completeMs)
  // lixo → padrões
  assert.deepEqual(resolveTurnTiming(null), DEFAULT_TURN_TIMING)
  assert.equal(
    normalizeVoiceCallDefaults({ turn: { completeSilenceMs: -1, adaptive: 'x' } }).turn
      .completeSilenceMs,
    600
  )
  assert.equal(normalizeVoiceCallDefaults({ turn: { adaptive: false } }).turn.adaptive, false)
})

test('pool de preâmbulos: normalização (texto aparado, contextos filtrados, teto), null = padrão', () => {
  assert.equal(normalizeFillerPool(null), null)
  assert.equal(normalizeFillerPool([]), null)
  assert.equal(normalizeFillerPool([{ text: '  ' }]), null)
  assert.deepEqual(
    normalizeFillerPool([{ text: ' Hum,  deixa eu ver. ', contexts: ['question', 'wat'] }, 7]),
    [{ text: 'Hum, deixa eu ver.', contexts: ['question'] }]
  )
  const many = Array.from({ length: 40 }, (_, i) => ({ text: `Frase ${i}.`, contexts: [] }))
  assert.equal(normalizeFillerPool(many)?.length, FILLER_POOL_MAX)
  assert.deepEqual(
    resolveFillerPool(null).map((f) => f.text),
    DEFAULT_FILLER_POOL.map((f) => f.text)
  )
  // padrão: frases por extenso (nada de "Hmm"/"Hum..." soltos), todos os contextos cobertos
  for (const f of DEFAULT_FILLER_POOL) {
    assert.ok(!/\bhmm\b/i.test(f.text) && !/\.\.\.|…/.test(f.text), f.text)
    assert.ok(f.text.split(/\s+/).length <= 6, `curta: ${f.text}`)
  }
  for (const c of ['question', 'command', 'correction', 'complex', 'generic'])
    assert.ok(
      DEFAULT_FILLER_POOL.some((f) => f.contexts.includes(c as never)),
      c
    )
  // pool global normalizado nos padrões; 0 de espera é válido
  const d = normalizeVoiceCallDefaults({ fillers: { delayMs: 0, pool: [{ text: 'Tá.' }] } })
  assert.equal(d.fillers.delayMs, 0)
  assert.deepEqual(d.fillers.pool, [{ text: 'Tá.', contexts: [] }])
})

test('applyVoiceCallChat: prompt-base do modo voz + voicePrompt; a chamada não impõe max_tokens', () => {
  const chat = {
    id: 'c1',
    config: { systemPrompt: 'Você é útil.', params: {} }
  } as unknown as Parameters<typeof applyVoiceCallChat>[0]
  const base = resolveVoiceCallConfig({ voicePrompt: 'Fale como pirata.' } as never, null)
  const out = applyVoiceCallChat(chat, base)
  assert.equal(
    out.config.systemPrompt,
    `Você é útil.\n\n${DEFAULT_VOICE_BASE_PROMPT}\n\nFale como pirata.`
  )
  assert.match(DEFAULT_VOICE_BASE_PROMPT, /SRC/)
  // sem teto próprio: max_tokens só vem dos params (do modelo da chamada / do chat)
  assert.equal(out.config.params?.max_tokens, undefined)
  const own = applyVoiceCallChat(
    { ...chat, config: { ...chat.config, params: { max_tokens: 500 } } } as never,
    base
  )
  assert.equal(own.config.params?.max_tokens, 500)
  // `maxTokens` antigo gravado nos padrões é descartado pela normalização
  assert.equal(
    'maxTokens' in normalizeVoiceCallDefaults({ maxTokens: 120 } as never),
    false,
    'maxTokens saiu dos padrões da chamada'
  )
  // prompt-base desligado → só o voicePrompt
  const off = resolveVoiceCallConfig({ voicePrompt: 'X.' } as never, {
    ...DEFAULT_VOICE_CALL_DEFAULTS,
    basePromptEnabled: false
  })
  const o2 = applyVoiceCallChat(chat, off)
  assert.equal(o2.config.systemPrompt, 'Você é útil.\n\nX.')
  assert.equal(o2.config.params?.max_tokens, undefined)
})
