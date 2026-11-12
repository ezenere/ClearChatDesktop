// Settings de áudio (`src/main/voice.ts`) no repositório REAL (db.ts/repo.ts com o módulo
// `electron` substituído por stub — padrão de e2e/branches.test.ts): round-trip normalizado dos 4
// grupos; stt/tts guardam só provedor/modelo/voz/opções (`baseUrl`/`apiKey` nunca são gravados) e
// os serviços do main recebem endereço e chave do provedor cadastrado — a visão do renderer nunca
// os leva. Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTECTED_SETTINGS } from '../src/shared/webSearchSettings.ts'
import {
  DEFAULT_AUDIO_INPUT,
  DEFAULT_STT_SETTINGS,
  DEFAULT_TTS_SETTINGS,
  DEFAULT_VOICE_CALL_DEFAULTS
} from '../src/shared/voice.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-voice-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

process.env.CLEARCHAT_TEST_USERDATA = TMP
const ELECTRON_STUB =
  'data:text/javascript,' +
  encodeURIComponent(`
export const app = { getPath: () => process.env.CLEARCHAT_TEST_USERDATA, getVersion: () => '0.0.0', isPackaged: false }
export default { app }
`)
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    return next(spec, ctx)
  }
})

type VoiceMod = typeof import('../src/main/voice.ts')
type RepoMod = typeof import('../src/main/repo.ts')
let voiceMod: VoiceMod | null = null
let repoMod: RepoMod | null = null
async function voice(): Promise<VoiceMod> {
  voiceMod ??= await import('../src/main/voice.ts')
  return voiceMod
}
async function repo(): Promise<RepoMod> {
  repoMod ??= await import('../src/main/repo.ts')
  return repoMod
}
after(async () => {
  if (repoMod) (await import('../src/main/db.ts')).closeDb()
})

/** O JSON gravado no banco (sem normalizar) de uma setting. */
const rawSetting = async (key: string): Promise<string> =>
  JSON.stringify((await repo()).settingsRepo.get(key) ?? null)

// ---------------- proteção ----------------

test('PROTECTED_SETTINGS: só as chaves dos buscadores (stt/tts não guardam chave)', () => {
  assert.ok(PROTECTED_SETTINGS.includes('webSearchApiKeys'))
  for (const k of ['sttSettings', 'ttsSettings', 'audioInput', 'voiceCallDefaults'])
    assert.ok(!PROTECTED_SETTINGS.includes(k), k)
})

// ---------------- round-trip normalizado ----------------

test('audioInput: set normaliza e grava; get devolve o mesmo (silenceStopMs 0 preservado)', async () => {
  const v = await voice()
  const saved = v.setVoiceSetting('audioInput', {
    deviceId: '  mic-1  ',
    pttKey: 'Ctrl+K',
    silenceStopMs: 0,
    language: ''
  })
  assert.deepEqual(saved, {
    deviceId: 'mic-1',
    activationDb: -45,
    pttEnabled: true,
    pttKey: 'Ctrl+K',
    silenceStopEnabled: true,
    silenceStopMs: 0,
    language: 'pt-BR'
  })
  assert.deepEqual(v.getVoiceSettingsView().audioInput, saved)
  // lixo volta aos padrões
  assert.deepEqual(v.setVoiceSetting('audioInput', 42), DEFAULT_AUDIO_INPUT)
  assert.deepEqual(v.getVoiceSettingsView().audioInput, DEFAULT_AUDIO_INPUT)
})

test('voiceCallDefaults: parcial completa com os padrões; get devolve o gravado', async () => {
  const v = await voice()
  const saved = v.setVoiceSetting('voiceCallDefaults', {
    enabled: false,
    // legado (protocolo §4.3.6): aceito na entrada e descartado — nunca gravado
    interjections: { cooldownMs: 1000 },
    fillers: {}
  })
  assert.equal(saved.enabled, false)
  assert.ok(!('interjections' in saved), 'campo legado descartado')
  assert.deepEqual(saved.fillers, DEFAULT_VOICE_CALL_DEFAULTS.fillers)
  assert.deepEqual(v.getVoiceSettingsView().voiceCallDefaults, saved)
})

// ---------------- stt/tts: só provedor + modelo/voz/opções ----------------

test('sttSettings/ttsSettings: baseUrl/apiKey vindos no set não são gravados nem devolvidos', async () => {
  const v = await voice()
  const stt = v.setVoiceSetting('sttSettings', {
    api: { providerId: 'p-x', baseUrl: 'https://a/v1', apiKey: 'gsk-SECRET-1', model: 'm1' }
  })
  assert.deepEqual(stt.api, { providerId: 'p-x', model: 'm1' })
  const tts = v.setVoiceSetting('ttsSettings', {
    backend: 'api',
    api: {
      providerId: 'p-y',
      baseUrl: 'https://b/v1',
      apiKey: 'sk-SECRET-2',
      providerKind: 'elevenlabs',
      model: 't1',
      voice: 'v1',
      elevenLabsWs: false
    },
    local: null
  })
  assert.deepEqual(tts.api, { providerId: 'p-y', model: 't1', voice: 'v1', elevenLabsWs: false })
  assert.equal(tts.local, null, 'local: null = limpeza explícita preservada')
  for (const raw of [await rawSetting('sttSettings'), await rawSetting('ttsSettings')]) {
    assert.ok(!/SECRET|baseUrl|apiKey|providerKind/.test(raw), raw)
  }
  assert.ok(!/SECRET|baseUrl|apiKey/.test(JSON.stringify(v.getVoiceSettingsView())))
  // lixo → padrões
  assert.deepEqual(v.setVoiceSetting('ttsSettings', 42), DEFAULT_TTS_SETTINGS)
  assert.deepEqual(v.setVoiceSetting('sttSettings', 42), DEFAULT_STT_SETTINGS)
})

test('baseUrl/apiKey gravados por build de desenvolvimento: descartados na leitura (sem provedor = sem endpoint)', async () => {
  const v = await voice()
  const r = await repo()
  r.settingsRepo.set('sttSettings', {
    mode: 'api',
    api: {
      providerId: null,
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk-OLD',
      model: 'm'
    }
  })
  r.settingsRepo.set('ttsSettings', {
    backend: 'api',
    api: { providerId: null, baseUrl: 'http://localhost:8880/v1', apiKey: 'OLD', model: 't' }
  })
  const view = v.getVoiceSettingsView()
  assert.deepEqual(view.sttSettings.api, { providerId: null, model: 'm' })
  assert.deepEqual(view.ttsSettings.api, { providerId: null, model: 't', voice: null })
  // os serviços também não recebem esse endereço: sem provedor, sem endereço/chave
  const eff = v.getVoiceSettings()
  assert.equal(eff.stt.api.baseUrl, undefined)
  assert.equal(eff.stt.api.apiKey, undefined)
  assert.equal(eff.tts.api.baseUrl, undefined)
  // a próxima escrita regrava sem os campos antigos
  v.setVoiceSetting('sttSettings', view.sttSettings)
  assert.ok(!/OLD|baseUrl/.test(await rawSetting('sttSettings')))
  v.setVoiceSetting('ttsSettings', { backend: 'local' })
  v.setVoiceSetting('sttSettings', {})
})

test('setVoiceSetting: grupo desconhecido é erro legível', async () => {
  const v = await voice()
  assert.throws(() => v.setVoiceSetting('nope' as never, {}), /desconhecido/)
})

// ---------------- providerId (endpoint/chave de um provedor salvo) ----------------

test('providerId: serviços usam baseUrl/chave do provedor salvo; a visão nunca leva a chave dele', async () => {
  const v = await voice()
  const r = await repo()
  const providerKey = 'sk-or-v1-PROVIDERSECRET0123456789'
  const p = r.providersRepo.create({
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/',
    apiKey: providerKey
  })
  v.setVoiceSetting('ttsSettings', {
    backend: 'api',
    api: { providerId: p.id, model: 'elevenlabs/eleven-flash-v2.5', voice: 'sarah' }
  })
  v.setVoiceSetting('sttSettings', {
    mode: 'hybrid',
    api: { providerId: p.id, model: 'openai/whisper-large-v3-turbo' }
  })
  // a setting guarda só o id — nunca a chave do provedor (nem mascarada)
  const json = JSON.stringify(v.getVoiceSettingsView())
  assert.equal(json.includes('PROVIDERSECRET'), false)
  assert.equal(json.includes(providerKey.slice(-4)), false, 'nem a máscara da chave do provedor')
  assert.equal((await rawSetting('ttsSettings')).includes('PROVIDERSECRET'), false)
  // os serviços do main recebem o endpoint efetivo
  const eff = v.getVoiceSettings()
  assert.equal(eff.tts.api.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(eff.tts.api.apiKey, providerKey)
  assert.equal(eff.tts.api.model, 'elevenlabs/eleven-flash-v2.5')
  assert.equal(eff.stt.api.baseUrl, 'https://openrouter.ai/api/v1')
  assert.equal(eff.stt.api.apiKey, providerKey)
  // provedor apagado → sem endpoint (o cliente recusa com "escolha um provedor")
  r.providersRepo.delete(p.id)
  const after = v.getVoiceSettings()
  assert.equal(after.tts.api.baseUrl, undefined)
  assert.equal(after.stt.api.apiKey, undefined)
  // limpa para os demais testes
  v.setVoiceSetting('ttsSettings', { backend: 'local' })
  v.setVoiceSetting('sttSettings', {})
})

test('provedor local sem chave (localhost, OpenAI-compatível): endereço resolvido, chave vazia', async () => {
  const v = await voice()
  const r = await repo()
  const p = r.providersRepo.create({
    name: 'Servidor local',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:8765/v1',
    apiKey: ''
  })
  v.setVoiceSetting('sttSettings', { api: { providerId: p.id, model: 'whisper-1' } })
  const eff = v.getVoiceSettings().stt.api
  assert.equal(eff.baseUrl, 'http://127.0.0.1:8765/v1')
  assert.equal(eff.apiKey, '')
  r.providersRepo.delete(p.id)
  v.setVoiceSetting('sttSettings', {})
})

test('resolveVoiceEndpoint: puro — só o provedor dá endereço/chave; sem ele, nada (nem campos antigos)', async () => {
  const { resolveVoiceEndpoint } = await voice()
  const stale = { providerId: null, baseUrl: 'https://a/v1', apiKey: 'k', model: 'm' }
  assert.deepEqual(
    resolveVoiceEndpoint(stale, () => ({ baseUrl: 'x', apiKey: 'y' })),
    { providerId: null, model: 'm' }
  )
  const withId = { providerId: 'p1', model: 'm' }
  assert.deepEqual(
    resolveVoiceEndpoint(withId, () => null),
    withId
  )
  assert.deepEqual(
    resolveVoiceEndpoint(withId, () => ({ baseUrl: ' ', apiKey: 'y' })),
    withId
  )
  assert.deepEqual(
    resolveVoiceEndpoint(withId, () => ({ baseUrl: 'https://p/v1', apiKey: ' s ' })),
    { ...withId, baseUrl: 'https://p/v1', apiKey: 's' }
  )
})

// ---------------- voz da persona/chat (protocolo 1.9.0) ----------------

test('voz da persona/chat: camadas do repositório, resolução aqui e o endpoint do provedor DELA (chamada/ditado)', async () => {
  const v = await voice()
  const r = await repo()
  const xi = r.providersRepo.create({
    name: 'ElevenLabs',
    kind: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io',
    apiKey: 'xi-PERSONASECRET'
  })
  const groq = r.providersRepo.create({
    name: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'gsk-DEVICESECRET'
  })
  // este dispositivo: Kokoro + Groq em pt-BR
  v.setVoiceSetting('ttsSettings', {
    backend: 'local',
    local: { engine: 'kokoro', voice: 'pf_dora' }
  })
  v.setVoiceSetting('sttSettings', {
    mode: 'api',
    api: { providerId: groq.id, model: 'whisper-large-v3-turbo' }
  })
  v.setVoiceSetting('audioInput', { language: 'pt-BR' })
  const persona = r.presetsRepo.create({
    name: 'Narradora',
    config: {
      voice: {
        enabled: null,
        model: null,
        tools: null,
        voicePrompt: null,
        fillers: null,
        tts: { backend: 'api', api: { providerId: xi.id, model: 'eleven_v3', voice: 'rachel' } },
        stt: {
          mode: 'api',
          api: { providerId: groq.id, model: 'whisper-large-v3' },
          language: 'en-US'
        }
      }
    }
  })
  const { chat } = r.chatsRepo.create({ title: 'Voz', config: { presetId: persona.id } })
  const layers = v.chatVoiceLayers(chat.id)
  assert.equal(layers.chat?.tts, undefined, 'o chat não guarda a voz da persona')
  const personaTts = layers.persona?.tts
  assert.equal(personaTts?.backend === 'api' ? personaTts.api.providerId : null, xi.id)
  // caps fake: tudo da API existe aqui
  const caps = { provider: () => ({ ok: true }) }
  const res = v.resolveVoice(layers, caps)
  assert.equal(res.tts.source, 'persona')
  assert.equal(res.stt.source, 'persona')
  assert.equal(res.stt.language, 'en-US')
  assert.ok(!JSON.stringify(res).includes('SECRET'), 'a visão da resolução nunca leva chave')
  const use = v.voiceUse(res)
  assert.equal(use.language, 'en-US')
  // os serviços do main (chamada, ditado, prévias, clipes) usam o endpoint do provedor DA PERSONA
  const eff = v.getVoiceSettingsWith(use)
  assert.equal(eff.tts.backend, 'api')
  assert.equal(eff.tts.api.baseUrl, 'https://api.elevenlabs.io')
  assert.equal(eff.tts.api.apiKey, 'xi-PERSONASECRET')
  assert.equal(eff.tts.api.providerKind, 'elevenlabs')
  assert.equal(eff.stt.api.model, 'whisper-large-v3')
  assert.equal(eff.stt.api.apiKey, 'gsk-DEVICESECRET')
  // as settings DESTE dispositivo não mudaram
  assert.equal(v.getVoiceSettings().tts.backend, 'local')
  assert.equal(v.getVoiceSettingsView().ttsSettings.backend, 'local')
  // provedor da persona ausente neste dispositivo → fallback no padrão daqui (com o motivo)
  const missing = v.resolveVoice(layers, {
    provider: (id: string) =>
      id === xi.id
        ? { ok: false, reason: 'o provedor escolhido não existe neste dispositivo' }
        : { ok: true },
    ttsLocal: () => ({ ok: true })
  })
  assert.equal(missing.tts.source, 'device')
  assert.equal(missing.tts.fallback?.reason, 'o provedor escolhido não existe neste dispositivo')
  assert.equal(v.voiceUse(missing).tts, null, 'a chamada usa a voz daqui')
  assert.equal(v.getVoiceSettingsWith(v.voiceUse(missing)).tts.backend, 'local')
  // a chamada/o ditado só sondam motores locais/GPU quando alguma camada ou setting os usa
  assert.deepEqual(
    v.voiceCapsNeed(layers),
    { local: true, gpu: false },
    'o Kokoro do dispositivo conta'
  )
  v.setVoiceSetting('ttsSettings', {
    backend: 'api',
    api: { providerId: xi.id, model: 'eleven_v3' }
  })
  assert.deepEqual(v.voiceCapsNeed(layers), { local: false, gpu: false })
  assert.deepEqual(
    v.voiceCapsNeed({
      chat: {
        enabled: null,
        model: null,
        tools: null,
        voicePrompt: null,
        fillers: null,
        tts: { backend: 'gpu', gpu: { engine: 'xtts-v2', voice: null } }
      }
    }),
    { local: false, gpu: true }
  )
  // camadas cruas do renderer: normalizadas (lixo = sem a camada)
  assert.deepEqual(
    v.voiceLayersFrom({
      chat: 42,
      persona: { tts: { backend: 'api', api: { providerId: 'p', model: 'm', apiKey: 'sk' } } }
    }),
    {
      chat: null,
      persona: {
        enabled: null,
        model: null,
        tools: null,
        voicePrompt: null,
        fillers: null,
        tts: { backend: 'api', api: { providerId: 'p', model: 'm', voice: null } }
      }
    }
  )
  assert.deepEqual(v.voiceLayersFrom(null), { chat: null, persona: null })
  // limpa
  r.chatsRepo.delete(chat.id)
  r.presetsRepo.delete(persona.id)
  r.providersRepo.delete(xi.id)
  r.providersRepo.delete(groq.id)
  v.setVoiceSetting('ttsSettings', { backend: 'local' })
  v.setVoiceSetting('sttSettings', {})
  v.setVoiceSetting('audioInput', {})
})
