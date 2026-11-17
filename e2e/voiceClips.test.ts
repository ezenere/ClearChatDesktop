// Clipes dos preâmbulos, das frases de ferramenta e do "obrigado por aguardar"
// (`src/main/voice/clips.ts`): nomes de arquivo pela whitelist de classes (`FILLER`, `TOOL`,
// `THANKS`), manifest por CONFIGURAÇÃO de voz (`<voz>/<variante>` — id da voz, variante, engine,
// modelo, hash da definição + hash por classe), cache reutilizado quando a definição não muda (por
// classe: só a classe que mudou é sintetizada), a voz padrão e a de uma persona com o MESMO id de
// voz mas outro modelo/instruções convivendo (bug: uma sobrescrevia a outra), o layout antigo
// (manifest direto na pasta da voz) adotado pela configuração que ele casa, cache só de preâmbulos
// (de antes das frases de ferramenta) e cache de antes do agradecimento continuando a tocar,
// regeneração quando a voz muda (diretório novo), cache de versões antigas (com outras classes de
// clipe) regerado sem erro e limpo, a limpeza das variantes sem uso, `resolveClip` para a Feature B
// e defesa contra ids de voz/nomes inseguros. A síntese usa um motor local FAKE ou um `fetch` FAKE
// (nada de ONNX nem rede — o pipeline real está reportado na SPEC).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLIP_CLASSES,
  CLIP_MAX_VARIANTS,
  clipClassHash,
  clipFileName,
  clipPhraseSet,
  clipStaleClasses,
  clipConfigKey,
  clipsLocation,
  CLIP_UNUSED_MAX_AGE_MS,
  loadCurrentClipAudio,
  loadCurrentClips,
  loadVoiceClips,
  ownPoolsKey,
  pruneClips,
  trimWavSilence,
  clipVoiceId,
  clipsDir,
  clipsHash,
  generateClips,
  loadClips,
  removeClips,
  resolveClip,
  type ClipsManifest
} from '../src/main/voice/clips.ts'
import type { TtsLocalBackend, TtsLocalInput, TtsLocalResult } from '../src/main/voice/tts.ts'
import {
  applyTtsChoice,
  DEFAULT_FILLER_POOL,
  DEFAULT_THANKS_POOL,
  DEFAULT_TOOL_PHRASE_POOL,
  normalizeTtsSettings,
  ttsChoiceFromSettings,
  type TtsSettings
} from '../src/shared/voice.ts'
import { encodeWav } from '../src/main/voice/session.ts'

// ---------------- helpers ----------------

const newBase = (): string => mkdtempSync(join(tmpdir(), 'clearchat-clips-'))

const localSettings = (voice = 'pf_dora'): TtsSettings =>
  normalizeTtsSettings({
    backend: 'local',
    local: { engine: 'kokoro', voice, installed: true }
  })

/** Settings de fala por API com o endpoint já RESOLVIDO pelo main (provedor → endereço + chave). */
const apiSettings = (over: Partial<TtsSettings['api']> = {}): TtsSettings => {
  const api = {
    providerId: 'p-tts',
    baseUrl: 'https://tts.example/v1',
    apiKey: 'sk-test',
    model: 'tts-model',
    voice: 'alloy',
    ...over
  }
  const stored = normalizeTtsSettings({ backend: 'api', api })
  return { ...stored, api: { ...stored.api, baseUrl: api.baseUrl, apiKey: api.apiKey } }
}

/** Motor local fake: cada chamada vira um "wav" com o tamanho pedido, e conta chamadas. */
function fakeEngine(): { backend: TtsLocalBackend; calls: TtsLocalInput[] } {
  const calls: TtsLocalInput[] = []
  return {
    calls,
    backend: {
      engine: 'kokoro',
      async synthesize(input: TtsLocalInput): Promise<TtsLocalResult> {
        calls.push(input)
        return {
          audio: new Uint8Array([82, 73, 70, 70, calls.length]),
          mime: 'audio/wav',
          model: 'kokoro-onnx',
          ms: 1
        }
      }
    }
  }
}

const PHRASES = clipPhraseSet()
const totalClips = CLIP_CLASSES.reduce((a, c) => a + PHRASES[c].length, 0)

/**
 * Move um cache gerado para o LAYOUT ANTIGO (manifest direto na pasta da voz, sem variante — como
 * as versões de antes deixavam), opcionalmente com outros clipes/hash/classHashes no manifest.
 */
function toLegacyLayout(
  base: string,
  m: ClipsManifest,
  over: { clips?: ClipsManifest['clips']; hash?: string; classHashes?: unknown } = {}
): string {
  const voiceDir = clipsDir(base, m.voiceId)!
  const variantDir = clipsDir(base, m.voiceId, m.variant)!
  const clips = over.clips ?? m.clips
  for (const c of clips) copyFileSync(join(variantDir, c.file), join(voiceDir, c.file))
  const { variant: _v, configKey: _k, classHashes, ...rest } = m
  void _v
  void _k
  const legacy: Record<string, unknown> = { ...rest, clips, hash: over.hash ?? m.hash }
  if (over.classHashes !== null) legacy.classHashes = over.classHashes ?? classHashes
  writeFileSync(join(voiceDir, 'manifest.json'), JSON.stringify(legacy))
  rmSync(variantDir, { recursive: true, force: true })
  return voiceDir
}

/**
 * `fetch` FAKE do `/audio/speech`: o "áudio" devolvido é o corpo JSON da request (dá para conferir
 * qual configuração gerou cada clipe); conta as chamadas.
 */
function fakeSpeechFetch(): { calls: string[]; restore: () => void } {
  const calls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? '')
    calls.push(body)
    return new Response(new TextEncoder().encode(body), {
      status: 200,
      headers: { 'content-type': 'audio/wav' }
    })
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = orig) }
}

/** O mesmo id de voz da Fish Audio (pelo OpenRouter) com modelo/instruções próprios (bug real). */
const FISH_VOICE = '6a93f84bfc184edaab0e36b9f7110759'
const fishSettings = (model: string, params: Record<string, unknown>): TtsSettings => {
  const s = normalizeTtsSettings({
    backend: 'api',
    api: { providerId: 'p-or', model, voice: FISH_VOICE, params: { openrouter: params } }
  })
  return {
    ...s,
    api: {
      ...s.api,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-fake',
      providerKind: 'openrouter'
    }
  }
}
const text = (a: { audio: Uint8Array } | null): string =>
  a ? new TextDecoder().decode(a.audio) : ''

// ---------------- nomes e ids (whitelist/segurança) ----------------

test('clipFileName: whitelist de classes e variantes 1..CLIP_MAX_VARIANTS (40); fora disso → erro legível', () => {
  assert.equal(CLIP_MAX_VARIANTS, 40, 'o maior pool (frases de ferramenta, até 40)')
  for (const cls of CLIP_CLASSES) {
    for (let n = 1; n <= CLIP_MAX_VARIANTS; n++) {
      assert.equal(clipFileName(cls, n), `${cls}_${n}.wav`)
    }
  }
  assert.throws(() => clipFileName('EXEC', 1), /classe de clipe desconhecida/)
  assert.throws(() => clipFileName('../../evil', 1), /classe de clipe desconhecida/)
  // classes de versões antigas (interjeições) saíram da whitelist
  assert.throws(() => clipFileName('ACK', 1), /classe de clipe desconhecida/)
  assert.throws(() => clipFileName('FILLER', 0), /variante de clipe inválida/)
  assert.throws(() => clipFileName('FILLER', CLIP_MAX_VARIANTS + 1), /variante de clipe inválida/)
  assert.throws(() => clipFileName('FILLER', 1.5), /variante de clipe inválida/)
})

test('clipVoiceId: engine+voz por trás de um segmento seguro (sem separadores de caminho)', () => {
  assert.equal(clipVoiceId(localSettings('pf_dora')), 'local-kokoro-pf_dora')
  assert.equal(clipVoiceId(apiSettings({ voice: 'alloy' })), 'api-alloy')
  assert.equal(clipVoiceId(apiSettings({ voice: null })), 'api-padrao')
  // voz maliciosa/livre nunca vira caminho
  for (const evil of ['../../etc/passwd', 'a/b', '..', 'x'.repeat(200)]) {
    const id = clipVoiceId(apiSettings({ voice: evil }))
    assert.ok(!id.includes('/') && !id.includes('..'), `id seguro: ${id}`)
    assert.ok(clipsDir('/tmp/x', id), `clipsDir aceita o id derivado: ${id}`)
  }
  // id cru inseguro é recusado pelo clipsDir (defesa de load/resolve)
  assert.equal(clipsDir('/tmp/x', '../../evil'), null)
  assert.equal(clipsDir('/tmp/x', 'a/b'), null)
})

// ---------------- geração + manifest ----------------

test('generateClips: pool de preâmbulos na whitelist, manifest com voz/engine/hash e progresso', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const progress: { id: string; done: number; total: number }[] = []
  const manifest = await generateClips({
    baseDir: base,
    settings: localSettings('pf_dora'),
    local: backend,
    onProgress: (e) => progress.push(e)
  })
  assert.equal(calls.length, totalClips)
  assert.equal(manifest.voiceId, 'local-kokoro-pf_dora')
  assert.equal(manifest.backend, 'local')
  assert.equal(manifest.engine, 'kokoro')
  assert.equal(manifest.model, 'pf_dora')
  assert.match(manifest.hash, /^[0-9a-f]{64}$/)
  assert.match(manifest.generatedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(manifest.clips.length, totalClips)
  // cada clipe: id/file/texto coerentes com o catálogo de frases
  for (const c of manifest.clips) {
    assert.equal(c.id, `${c.class}_${c.n}`)
    assert.equal(c.file, clipFileName(c.class, c.n))
    assert.equal(c.text, PHRASES[c.class][c.n - 1])
  }
  // FILLER = o pool padrão de preâmbulos, na ordem
  assert.deepEqual(
    manifest.clips.filter((c) => c.class === 'FILLER').map((c) => c.text),
    DEFAULT_FILLER_POOL.map((f) => f.text)
  )
  // progresso 1..N com o id do clipe
  assert.equal(progress.length, totalClips)
  assert.deepEqual(
    progress.map((p) => p.done),
    Array.from({ length: totalClips }, (_, i) => i + 1)
  )
  assert.ok(progress.every((p) => p.total === totalClips))
  assert.equal(progress[0].id, 'FILLER_1')
  // TOOL = o pool padrão das frases de ferramenta, na ordem (depois dos preâmbulos)
  assert.deepEqual(
    manifest.clips.filter((c) => c.class === 'TOOL').map((c) => c.text),
    DEFAULT_TOOL_PHRASE_POOL.map((f) => f.text)
  )
  // THANKS = o pool padrão do "obrigado por aguardar", na ordem (por último)
  assert.deepEqual(
    manifest.clips.filter((c) => c.class === 'THANKS').map((c) => c.text),
    [...DEFAULT_THANKS_POOL]
  )
  assert.ok(manifest.clips.every((c) => (CLIP_CLASSES as string[]).includes(c.class)))
  // hash por classe no manifest
  for (const cls of CLIP_CLASSES)
    assert.equal(manifest.classHashes[cls], await clipClassHash(localSettings('pf_dora'), cls))
  // arquivos em <base>/voice-clips/<voiceId>/<variante>/<CLASSE>_<n>.wav + manifest.json (sem
  // .part sobrando); a variante = os 16 primeiros hex da chave da configuração de voz
  assert.match(manifest.variant ?? '', /^[0-9a-f]{16}$/)
  assert.equal(manifest.configKey, await clipConfigKey(localSettings('pf_dora')))
  assert.ok(manifest.configKey!.startsWith(manifest.variant!))
  const dir = clipsDir(base, manifest.voiceId, manifest.variant)!
  assert.equal(dir, join(base, 'voice-clips', 'local-kokoro-pf_dora', manifest.variant!))
  const files = readdirSync(dir).sort()
  assert.equal(files.filter((f) => f.endsWith('.part')).length, 0)
  assert.ok(files.includes('manifest.json'))
  assert.ok(files.includes('used.json'), 'marca de uso (limpeza)')
  for (const c of manifest.clips) assert.ok(existsSync(join(dir, c.file)), c.file)
  // manifest em disco = o devolvido (e o texto das frases está lá)
  const onDisk = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  assert.deepEqual(onDisk, manifest)
  rmSync(base, { recursive: true, force: true })
})

test('generateClips: cache reutilizado quando a definição não muda (não ressintetiza)', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const first = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  const second = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  assert.equal(calls.length, totalClips, 'segunda chamada não ressintetiza')
  assert.deepEqual(second, first)
  rmSync(base, { recursive: true, force: true })
})

test('generateClips: regenera quando a VOZ muda (diretório novo por voz) e quando o hash muda', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const a = await generateClips({
    baseDir: base,
    settings: localSettings('pf_dora'),
    local: backend
  })
  const b = await generateClips({
    baseDir: base,
    settings: localSettings('pm_alex'),
    local: backend
  })
  assert.equal(a.voiceId, 'local-kokoro-pf_dora')
  assert.equal(b.voiceId, 'local-kokoro-pm_alex')
  assert.equal(calls.length, totalClips * 2, 'voz nova ressintetiza tudo')
  // os dois caches convivem (a voz antiga continua resolvível)
  assert.ok(await loadClips(base, a.voiceId, a.variant))
  assert.ok(await loadClips(base, b.voiceId, b.variant))
  assert.ok(await resolveClip(base, a.voiceId, 'FILLER', 1, a.variant))
  assert.ok(await resolveClip(base, b.voiceId, 'FILLER', 1, b.variant))
  // hash muda com a voz (mesmo texto/backend)
  assert.notEqual(a.hash, b.hash)
  rmSync(base, { recursive: true, force: true })
})

test('generateClips: hash da definição muda → regerar (cache invalidado)', async () => {
  const base = newBase()
  const calls: unknown[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async () => {
    calls.push(1)
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/wav' }
    })
  }) as typeof fetch
  try {
    const settings = apiSettings({ model: 'tts-model' })
    const first = await generateClips({ baseDir: base, settings })
    assert.equal(calls.length, totalClips)
    // mesmo voiceId (mesma voz), modelo diferente → hash diferente → ressintetiza
    const changed = apiSettings({ model: 'outro-modelo' })
    assert.equal(clipVoiceId(changed), clipVoiceId(settings))
    assert.notEqual(await clipsHash(changed), first.hash)
    const second = await generateClips({ baseDir: base, settings: changed })
    assert.equal(calls.length, totalClips * 2)
    assert.notEqual(second.model, first.model)
    // mesma voz, outra configuração: pasta própria — a primeira continua em dia
    assert.notEqual(second.variant, first.variant)
    assert.ok(await loadCurrentClips(base, settings), 'o modelo antigo segue em dia')
    assert.ok(await loadCurrentClips(base, changed))
  } finally {
    globalThis.fetch = orig
    rmSync(base, { recursive: true, force: true })
  }
})

// ---------------- load/resolve ----------------

test('loadClips: manifest inválido/incompleto → null (o chamador regenera)', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const m = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  const dir = clipsDir(base, m.voiceId, m.variant)!
  const load = (): Promise<ClipsManifest | null> => loadClips(base, m.voiceId, m.variant)
  assert.ok(await load())
  // sem manifest → null
  rmSync(join(dir, 'manifest.json'))
  assert.equal(await load(), null)
  // JSON inválido (ou `null`) → null
  writeFileSync(join(dir, 'manifest.json'), '{ não é json')
  assert.equal(await load(), null)
  writeFileSync(join(dir, 'manifest.json'), 'null')
  assert.equal(await load(), null)
  // vozId trocado no manifest → null
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, voiceId: 'outra-voz' }))
  assert.equal(await load(), null)
  // variante/chave de outra configuração → null (a pasta é o prefixo da chave)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, variant: 'f'.repeat(16) }))
  assert.equal(await load(), null)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, configKey: 'f'.repeat(64) }))
  assert.equal(await load(), null)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, configKey: undefined }))
  assert.equal(await load(), null)
  // variante fora do formato nunca vira caminho
  assert.equal(clipsDir(base, m.voiceId, '../x'), null)
  assert.equal(await loadClips(base, m.voiceId, '../../evil'), null)
  // clipe fora da whitelist → null
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      ...m,
      clips: [{ id: 'EXEC_1', file: 'EXEC_1.wav', class: 'EXEC', n: 1, text: 'x' }]
    })
  )
  assert.equal(await load(), null)
  // arquivo faltando → null (cache incompleto)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m))
  assert.ok(await load())
  rmSync(join(dir, 'FILLER_1.wav'))
  assert.equal(await load(), null)
  // id de voz inseguro → null (sem traversal)
  assert.equal(await loadClips(base, '../../evil'), null)
  rmSync(base, { recursive: true, force: true })
})

test('resolveClip: caminho do wav por classe/variante; inválidos/ausentes → null', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const m = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  const dir = clipsDir(base, m.voiceId, m.variant)!
  const v = m.variant
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', 3, v), join(dir, 'FILLER_3.wav'))
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', 3), null, 'pasta da voz: layout antigo')
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', CLIP_MAX_VARIANTS, v), null)
  assert.equal(await resolveClip(base, m.voiceId, 'ACK', 1, v), null, 'classe que saiu')
  assert.equal(await resolveClip(base, m.voiceId, 'EXEC', 1, v), null)
  assert.equal(await resolveClip(base, '../../evil', 'FILLER', 1, v), null)
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', 1, '../..'), null)
  // classe conhecida mas nunca gerada (cache parcial) → null
  rmSync(join(dir, 'FILLER_2.wav'))
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', 2, v), null)
  rmSync(base, { recursive: true, force: true })
})

test('removeClips: apaga o cache da voz (idempotente) e ids inseguros ficam de fora', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const m = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  await removeClips(base, m.voiceId)
  assert.equal(await loadClips(base, m.voiceId, m.variant), null)
  assert.equal(await loadVoiceClips(base, localSettings()), null)
  await removeClips(base, m.voiceId) // idempotente
  await removeClips(base, '../../evil') // sem efeito (não apaga nada fora)
  assert.ok(existsSync(join(base, 'voice-clips')))
  rmSync(base, { recursive: true, force: true })
})

test('generateClips: abort no meio → rejeita e não deixa manifest', async () => {
  const base = newBase()
  const controller = new AbortController()
  const { backend, calls } = fakeEngine()
  const p = generateClips({
    baseDir: base,
    settings: localSettings(),
    local: backend,
    signal: controller.signal,
    onProgress: (e) => {
      if (e.done === 2) controller.abort()
    }
  })
  await assert.rejects(p, /cancelada/)
  assert.ok(calls.length < totalClips)
  const { dir } = await clipsLocation(base, localSettings())
  assert.ok(!existsSync(join(dir, 'manifest.json')), 'sem manifest após abort')
  assert.equal(await loadVoiceClips(base, localSettings()), null)
  rmSync(base, { recursive: true, force: true })
})

test('clipsHash: estável para a mesma definição e sensível a frases/voz/modelo', async () => {
  const h1 = await clipsHash(localSettings('pf_dora'))
  const h2 = await clipsHash(localSettings('pf_dora'))
  assert.equal(h1, h2)
  assert.notEqual(h1, await clipsHash(localSettings('pm_alex')))
  assert.notEqual(h1, await clipsHash(apiSettings()))
  assert.match(h1, /^[0-9a-f]{64}$/)
})

// catálogo de frases: o pool de preâmbulos, não vazio (o manifest depende disso)
test('clipPhraseSet: FILLER (preâmbulos), TOOL (frases de ferramenta) e THANKS ("obrigado por aguardar"), frases por extenso que os dois motores pronunciam', () => {
  assert.deepEqual(CLIP_CLASSES, ['FILLER', 'TOOL', 'THANKS'])
  assert.deepEqual(Object.keys(PHRASES), ['FILLER', 'TOOL', 'THANKS'])
  for (const cls of CLIP_CLASSES) {
    const phrases = PHRASES[cls]
    assert.ok(phrases.length >= 2 && phrases.length <= CLIP_MAX_VARIANTS, cls)
    for (const p of phrases) {
      assert.ok(p.trim().length > 0, `${cls}: ${p}`)
      // "Hmm"/"Hum..." soltos: soletrados (Kokoro) / anglicanizados (ElevenLabs) — proibidos
      assert.ok(!/\bhmm\b/i.test(p) && !/^hum\.*$/i.test(p) && !/\.\.\./.test(p), p)
    }
  }
  assert.deepEqual(
    PHRASES.FILLER,
    DEFAULT_FILLER_POOL.map((f) => f.text)
  )
  assert.deepEqual(
    PHRASES.TOOL,
    DEFAULT_TOOL_PHRASE_POOL.map((f) => f.text)
  )
  assert.deepEqual(PHRASES.THANKS, [...DEFAULT_THANKS_POOL])
  // pool próprio do obrigado (o de `voiceCallDefaults.delayPhrases.thanksPool`)
  assert.deepEqual(clipPhraseSet(null, null, ['Valeu!']).THANKS, ['Valeu!'])
  // o longo "Só um minutinho que eu tô vendo isso." saiu
  assert.ok(!PHRASES.FILLER.some((p) => p.includes('tô vendo isso')))
  // sanity: nenhum arquivo temporário criado na raiz do tmp por engano
  assert.ok(existsSync(tmpdir()))
})

test('clipsHash: o pool de preâmbulos entra no hash (mudou → cache velho → regerar)', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const settings = localSettings()
  const pool = [
    { text: 'Tá, já vejo.', contexts: [] },
    { text: 'Hum, deixa eu ver.', contexts: [] }
  ]
  assert.notEqual(await clipsHash(settings), await clipsHash(settings, pool))
  await generateClips({ baseDir: base, settings, local: backend })
  assert.ok(await loadCurrentClips(base, settings))
  // pool mudou: o cache da voz é velho → nada toca (null) até regerar
  assert.equal(await loadCurrentClips(base, settings, pool), null)
  assert.equal(await loadCurrentClipAudio(base, settings, pool, 'FILLER', 1), null)
  const before = calls.length
  const m = await generateClips({ baseDir: base, settings, local: backend, fillerPool: pool })
  // só a classe que mudou é sintetizada: os TOOL continuam em dia e são reaproveitados
  assert.equal(calls.length - before, pool.length)
  assert.deepEqual(
    m.clips.filter((c) => c.class === 'FILLER').map((c) => c.text),
    pool.map((p) => p.text)
  )
  // clipes de variantes que não existem mais (pool menor) saem do disco
  const dir = clipsDir(base, m.voiceId, m.variant)!
  assert.ok(!existsSync(join(dir, 'FILLER_3.wav')))
  assert.ok(await loadCurrentClipAudio(base, settings, pool, 'FILLER', 2))
  rmSync(base, { recursive: true, force: true })
})

test('cache de versão antiga (com clipes de interjeição): lido como ausente, sem erro; gerar de novo limpa os arquivos', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const settings = localSettings()
  const voiceId = clipVoiceId(settings)
  const dir = clipsDir(base, voiceId)!
  // como uma versão antiga deixava (layout antigo, direto na pasta da voz): ACK/THINKING + FILLER
  // no mesmo manifest
  mkdirSync(dir, { recursive: true })
  const old = [
    { id: 'ACK_1', file: 'ACK_1.wav', class: 'ACK', n: 1, text: 'Uhum.' },
    { id: 'THINKING_3', file: 'THINKING_3.wav', class: 'THINKING', n: 3, text: 'Um instante.' },
    { id: 'FILLER_1', file: 'FILLER_1.wav', class: 'FILLER', n: 1, text: 'Hum, deixa eu ver aqui.' }
  ]
  for (const c of old) writeFileSync(join(dir, c.file), 'RIFF')
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      voiceId,
      backend: 'local',
      engine: 'kokoro',
      model: 'pf_dora',
      hash: 'a'.repeat(64),
      generatedAt: new Date().toISOString(),
      clips: old
    })
  )
  // leitura: cache velho = ausente (nada toca; nenhum erro; nada é adotado)
  assert.equal(await loadClips(base, voiceId), null)
  assert.equal(await loadVoiceClips(base, settings), null)
  assert.equal(await loadCurrentClips(base, settings), null)
  assert.equal(await loadCurrentClipAudio(base, settings, null, 'FILLER', 1), null)
  assert.equal(await loadCurrentClipAudio(base, settings, null, 'ACK', 1), null)
  // gerar de novo: o conjunto atual na variante; o antigo inválido (não vale para ninguém) sai
  const m = await generateClips({ baseDir: base, settings, local: backend })
  assert.equal(calls.length, totalClips)
  assert.ok(m.clips.every((c) => (CLIP_CLASSES as string[]).includes(c.class)))
  const files = readdirSync(dir)
  assert.ok(!files.includes('ACK_1.wav') && !files.includes('THINKING_3.wav'), files.join(','))
  assert.ok(!files.includes('manifest.json') && !files.includes('FILLER_1.wav'), files.join(','))
  assert.deepEqual(files, [m.variant])
  assert.ok(readdirSync(clipsDir(base, voiceId, m.variant)!).includes('FILLER_1.wav'))
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'FILLER', 1))
  rmSync(base, { recursive: true, force: true })
})

test('cache só de preâmbulos (de antes das frases de ferramenta): os FILLER seguem tocando; gerar sintetiza só os TOOL', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const settings = localSettings()
  // o hash antigo (payload `{ phrases: { FILLER } }`) é exatamente o hash da classe FILLER
  const legacy = createHash('sha256')
    .update(
      JSON.stringify({
        phrases: { FILLER: DEFAULT_FILLER_POOL.map((f) => f.text) },
        post: 'trim-v1',
        backend: 'local',
        engine: 'kokoro',
        voice: 'pf_dora',
        model: null
      })
    )
    .digest('hex')
  assert.equal(await clipClassHash(settings, 'FILLER'), legacy)
  // como a versão anterior deixava o cache (layout antigo, na pasta da voz): só FILLER, sem
  // `classHashes`
  const full = await generateClips({ baseDir: base, settings, local: backend })
  const fillers = full.clips.filter((c) => c.class === 'FILLER')
  toLegacyLayout(base, full, { clips: fillers, hash: legacy, classHashes: null })
  const dir = clipsDir(base, full.voiceId, full.variant)!
  const legacyOld = await loadClips(base, full.voiceId)
  assert.ok(legacyOld, 'manifest antigo continua válido')
  assert.deepEqual(legacyOld!.classHashes, { FILLER: legacy })
  // a configuração que ele casa (o hash do FILLER) o adota na 1ª leitura, sem sintetizar
  const old = await loadVoiceClips(base, settings)
  assert.ok(old, 'adotado')
  assert.equal(old!.variant, full.variant)
  assert.deepEqual(old!.classHashes, { FILLER: legacy })
  assert.equal(await loadClips(base, full.voiceId), null, 'o antigo saiu da pasta da voz')
  assert.deepEqual(await clipStaleClasses(old, settings), ['TOOL', 'THANKS'])
  assert.equal(
    await loadCurrentClips(base, settings),
    null,
    'conjunto completo: velho (a UI avisa)'
  )
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'FILLER', 1), 'preâmbulo ainda toca')
  assert.equal(
    await loadCurrentClipAudio(base, settings, null, 'TOOL', 1),
    null,
    'sem clipe TOOL → síntese ao vivo'
  )
  // "Gerar clipes": só as frases de ferramenta (e o agradecimento, que veio depois) são sintetizados
  const before = calls.length
  const m = await generateClips({ baseDir: base, settings, local: backend })
  assert.equal(calls.length - before, DEFAULT_TOOL_PHRASE_POOL.length + DEFAULT_THANKS_POOL.length)
  assert.deepEqual(await clipStaleClasses(m, settings), [])
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'TOOL', 1))
  assert.ok(await loadCurrentClips(base, settings))
  // pool de frases de ferramenta mudou: só os TOOL ficam velhos (e só eles são refeitos)
  const toolPool = [{ text: 'Vou pesquisar agora.', categories: ['web' as const] }]
  assert.deepEqual(await clipStaleClasses(m, settings, null, toolPool), ['TOOL'])
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'FILLER', 2, toolPool))
  assert.equal(await loadCurrentClipAudio(base, settings, null, 'TOOL', 1, toolPool), null)
  const b2 = calls.length
  const m2 = await generateClips({ baseDir: base, settings, local: backend, toolPool })
  assert.equal(calls.length - b2, 1)
  assert.deepEqual(
    m2.clips.filter((c) => c.class === 'TOOL').map((c) => c.text),
    ['Vou pesquisar agora.']
  )
  assert.ok(!existsSync(join(dir, 'TOOL_2.wav')), 'variantes que saíram são apagadas')
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'TOOL', 1, toolPool))
  rmSync(base, { recursive: true, force: true })
})

test('cache de antes do "obrigado por aguardar" (FILLER + TOOL): eles seguem tocando; gerar sintetiza só os THANKS; pool do obrigado mudou → só eles', async () => {
  const base = newBase()
  const { backend, calls } = fakeEngine()
  const settings = localSettings()
  const full = await generateClips({ baseDir: base, settings, local: backend })
  const dir = clipsDir(base, full.voiceId, full.variant)!
  // como a versão anterior deixava (layout antigo): FILLER + TOOL com `classHashes` (sem THANKS)
  const { THANKS: _t, ...classHashes } = full.classHashes
  void _t
  toLegacyLayout(base, full, {
    clips: full.clips.filter((c) => c.class !== 'THANKS'),
    hash: 'b'.repeat(64), // o hash do conjunto antigo (sem THANKS) era outro
    classHashes
  })
  // a chamada lê primeiro (sem a lista): adota ali mesmo e o preâmbulo toca
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'FILLER', 2), 'adotado pela chamada')
  const old = await loadVoiceClips(base, settings)
  assert.ok(old)
  assert.equal(old!.variant, full.variant)
  assert.deepEqual(await clipStaleClasses(old, settings), ['THANKS'])
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'FILLER', 1), 'preâmbulo toca')
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'TOOL', 1), 'frase de ferramenta toca')
  assert.equal(
    await loadCurrentClipAudio(base, settings, null, 'THANKS', 1),
    null,
    'sem clipe THANKS → síntese ao vivo em paralelo'
  )
  const before = calls.length
  const m = await generateClips({ baseDir: base, settings, local: backend })
  assert.equal(calls.length - before, DEFAULT_THANKS_POOL.length, 'só os THANKS')
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'THANKS', 1))
  // pool do obrigado mudou: só os THANKS ficam velhos (e só eles são refeitos)
  const thanksPool = ['Valeu pela paciência.', 'Pronto, chegou.']
  assert.deepEqual(await clipStaleClasses(m, settings, null, null, thanksPool), ['THANKS'])
  assert.equal(
    await loadCurrentClipAudio(base, settings, null, 'THANKS', 1, null, thanksPool),
    null
  )
  const b2 = calls.length
  const m2 = await generateClips({ baseDir: base, settings, local: backend, thanksPool })
  assert.equal(calls.length - b2, thanksPool.length)
  assert.deepEqual(
    m2.clips.filter((c) => c.class === 'THANKS').map((c) => c.text),
    thanksPool
  )
  assert.ok(!existsSync(join(dir, 'THANKS_3.wav')), 'variantes que saíram são apagadas')
  assert.ok(await loadCurrentClipAudio(base, settings, null, 'THANKS', 2, null, thanksPool))
  assert.ok(await loadCurrentClips(base, settings, null, null, thanksPool))
  rmSync(base, { recursive: true, force: true })
})

test('trimWavSilence: apara o silêncio das pontas (pad curto + rampa); não-WAV/silêncio intactos', () => {
  const rate = 24000
  const lead = Math.round(0.18 * rate) // os ~180 ms do Kokoro
  const body = Math.round(0.3 * rate)
  const tail = Math.round(0.25 * rate)
  const pcm = new Int16Array(lead + body + tail)
  for (let i = 0; i < body; i++) pcm[lead + i] = Math.round(8000 * Math.sin(i / 5))
  const wav = encodeWav(new Uint8Array(pcm.buffer), rate)
  const out = trimWavSilence(wav)
  const samples = (out.length - 44) / 2
  const pad = Math.round(0.015 * rate)
  assert.ok(Math.abs(samples - (body + 2 * pad)) <= 4, `amostras: ${samples}`)
  assert.equal(new DataView(out.buffer, out.byteOffset).getUint32(24, true), rate)
  // rampa: 1ª amostra zerada (sem clique)
  assert.equal(new DataView(out.buffer, out.byteOffset).getInt16(44, true), 0)
  // não-WAV e tudo-silêncio voltam iguais
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3])
  assert.equal(trimWavSilence(mp3), mp3)
  const silent = encodeWav(new Uint8Array(4000), rate)
  assert.equal(trimWavSilence(silent), silent)
})

// ---------------- configurações de voz convivendo (variantes) ----------------

test('bug: voz padrão e voz da persona com o MESMO id de voz e outro modelo/instruções convivem — cada uma em dia, tocando o próprio áudio', async () => {
  // uso real (2026-11-14): "Se eu gero pro global, ele fala que os da persona estão
  // desatualizados. Se eu gero pra persona, o global fala que tá desatualizado." — a mesma voz da
  // Fish Audio (`6a93…`) no padrão deste dispositivo e numa persona, com modelo/instruções
  // diferentes: a pasta era só por voz (`api-<voz>`), gerar uma sobrescrevia o manifest da outra
  const base = newBase()
  const f = fakeSpeechFetch()
  try {
    const device = fishSettings('fish-audio/s1', { instructions: 'fala calma' })
    const persona = fishSettings('fish-audio/drama-3', { instructions: 'fala animada' })
    assert.equal(clipVoiceId(device), clipVoiceId(persona), 'mesmo id de voz')
    const a = await generateClips({ baseDir: base, settings: device })
    const b = await generateClips({ baseDir: base, settings: persona })
    assert.equal(f.calls.length, totalClips * 2)
    assert.notEqual(a.variant, b.variant, 'uma pasta por configuração')
    for (const [s, model, instr] of [
      [device, 'fish-audio/s1', 'fala calma'],
      [persona, 'fish-audio/drama-3', 'fala animada']
    ] as const) {
      // status (o que Configurações → Áudio, a aba Voz e o dock leem): em dia, nada velho
      const m = await loadVoiceClips(base, s)
      assert.ok(m, model)
      assert.deepEqual(await clipStaleClasses(m, s), [], `${model}: em dia`)
      assert.ok(await loadCurrentClips(base, s), `${model}: conjunto completo em dia`)
      // reprodução: o áudio DESTA configuração
      for (const [cls, n] of [
        ['FILLER', 1],
        ['TOOL', 2],
        ['THANKS', 1]
      ] as const) {
        const body = text(await loadCurrentClipAudio(base, s, null, cls, n))
        assert.ok(body.includes(`"model":"${model}"`), `${model} ${cls}_${n}: ${body.slice(0, 80)}`)
        assert.ok(body.includes(instr), `${model} ${cls}_${n}: instruções próprias`)
        assert.ok(body.includes(JSON.stringify(PHRASES[cls][n - 1])), 'a frase certa')
      }
    }
    // regerar a do dispositivo (instruções mudaram e depois voltaram; e de novo o mesmo) → a da
    // persona continua em dia e intocada
    const device2 = fishSettings('fish-audio/s1', { instructions: 'fala bem devagar' })
    await generateClips({ baseDir: base, settings: device2 })
    await generateClips({ baseDir: base, settings: device })
    assert.equal(f.calls.length, totalClips * 3, 'a de volta reaproveita a pasta dela')
    const mb = await loadVoiceClips(base, persona)
    assert.deepEqual(await clipStaleClasses(mb, persona), [], 'persona em dia')
    assert.ok(
      text(await loadCurrentClipAudio(base, persona, null, 'FILLER', 1)).includes('drama-3')
    )
    assert.ok(await loadCurrentClips(base, device2))
    assert.ok(
      text(await loadCurrentClipAudio(base, device2, null, 'FILLER', 1)).includes('devagar')
    )
    // gerar de novo a da persona: idempotente (nada sintetizado), a do dispositivo segue em dia
    await generateClips({ baseDir: base, settings: persona })
    assert.equal(f.calls.length, totalClips * 3)
    assert.ok(await loadCurrentClips(base, device))
    const voiceDir = clipsDir(base, clipVoiceId(device))!
    assert.equal(readdirSync(voiceDir).length, 3, 'três configurações da mesma voz')
  } finally {
    f.restore()
    rmSync(base, { recursive: true, force: true })
  }
})

test('chave da configuração de voz: a mesma voz efetiva resolve a mesma pasta em todo caminho; o que muda o som muda a chave', async () => {
  const dev = fishSettings('fish-audio/s1', { instructions: 'calma', speed: 1.2 })
  const k = await clipConfigKey(dev)
  assert.match(k, /^[0-9a-f]{64}$/)
  // o que NÃO muda o som: chave/endereço/assinatura de app/transporte, a ordem dos parâmetros
  const same: TtsSettings[] = [
    { ...dev, api: { ...dev.api, apiKey: 'outra', baseUrl: 'https://x.example/v1' } },
    { ...dev, api: { ...dev.api, appHeaders: { 'X-Title': 'Persona' }, extraBody: { a: 1 } } },
    { ...dev, api: { ...dev.api, elevenLabsWs: false } },
    { ...dev, api: { ...dev.api, params: { openrouter: { speed: 1.2, instructions: 'calma' } } } },
    { ...dev, api: { ...dev.api, model: ' fish-audio/s1 ' } },
    { ...dev, local: { engine: 'kokoro', voice: 'pm_alex', installed: false } },
    // a persona com exatamente a voz do dispositivo: escolha → settings e o provedor resolvido de
    // novo, como o main faz (`getVoiceSettingsWith` → `withTtsProviderKind`)
    (() => {
      const s = applyTtsChoice(dev, ttsChoiceFromSettings(dev))
      return { ...s, api: { ...s.api, providerKind: 'openrouter' } }
    })()
  ]
  for (const s of same) assert.equal(await clipConfigKey(s), k, JSON.stringify(s.api))
  // o que muda o som
  const differ: TtsSettings[] = [
    fishSettings('fish-audio/drama-3', { instructions: 'calma', speed: 1.2 }),
    fishSettings('fish-audio/s1', { instructions: 'animada', speed: 1.2 }),
    fishSettings('fish-audio/s1', { instructions: 'calma' }),
    { ...dev, api: { ...dev.api, voice: 'outra-voz' } },
    { ...dev, api: { ...dev.api, providerId: 'p-fish-direto' } },
    { ...dev, api: { ...dev.api, providerKind: 'openai' } },
    { ...dev, backend: 'local', local: { engine: 'kokoro', voice: 'pf_dora', installed: true } }
  ]
  const keys = new Set([k])
  for (const s of differ) keys.add(await clipConfigKey(s))
  assert.equal(keys.size, differ.length + 1, 'cada uma com a sua chave')
  // ElevenLabs: o `auto_mode` só muda a chamada (mesma chave); formato/voice_settings mudam
  const el = (p: Record<string, unknown>): TtsSettings =>
    normalizeTtsSettings({
      backend: 'api',
      api: { providerId: 'xi', model: 'eleven_v3', voice: 'v', params: { elevenlabs: p } }
    })
  assert.equal(await clipConfigKey(el({ auto_mode: true })), await clipConfigKey(el({})))
  assert.notEqual(await clipConfigKey(el({ stability: 0.2 })), await clipConfigKey(el({})))
  // local/GPU: motor, voz, passos e parâmetros do motor
  assert.notEqual(
    await clipConfigKey(localSettings('pf_dora')),
    await clipConfigKey(localSettings('pm_alex'))
  )
  const gpu = (over: Partial<NonNullable<TtsSettings['gpu']>>): TtsSettings => ({
    ...localSettings(),
    backend: 'gpu',
    gpu: { engine: 'omnivoice', voice: 'v1', ...over }
  })
  assert.equal(await clipConfigKey(gpu({})), await clipConfigKey(gpu({})))
  assert.notEqual(await clipConfigKey(gpu({})), await clipConfigKey(gpu({ steps: 16 })))
  assert.notEqual(await clipConfigKey(gpu({})), await clipConfigKey(gpu({ voice: 'v2' })))
})

test('layout antigo: adotado SÓ pela configuração que ele casa (sem sintetizar); a outra da mesma voz não o toca nem o apaga', async () => {
  const base = newBase()
  const f = fakeSpeechFetch()
  try {
    const device = fishSettings('fish-audio/s1', { instructions: 'fala calma' })
    const persona = fishSettings('fish-audio/drama-3', { instructions: 'fala animada' })
    // a versão anterior deixou na pasta da voz os clipes da PERSONA (a última gerada)
    const gen = await generateClips({ baseDir: base, settings: persona })
    const voiceDir = toLegacyLayout(base, gen)
    const calls = f.calls.length
    // a do dispositivo (mesma voz, outra configuração): não casa — sem clipes, e o antigo fica
    assert.equal(await loadVoiceClips(base, device), null)
    assert.equal(await loadCurrentClipAudio(base, device, null, 'FILLER', 1), null)
    assert.ok(await loadClips(base, gen.voiceId), 'o antigo continua lá, para a persona')
    // a da persona: adotado na 1ª leitura (a chamada, antes de qualquer lista) e em dia
    const body = text(await loadCurrentClipAudio(base, persona, null, 'TOOL', 3))
    assert.ok(body.includes('drama-3') && body.includes(JSON.stringify(PHRASES.TOOL[2])))
    const m = await loadVoiceClips(base, persona)
    assert.ok(m)
    assert.equal(m!.variant, gen.variant)
    assert.deepEqual(await clipStaleClasses(m, persona), [])
    assert.equal(f.calls.length, calls, 'nada sintetizado')
    // a pasta da voz ficou só com as variantes (o antigo saiu)
    assert.deepEqual(readdirSync(voiceDir), [gen.variant])
    // agora a do dispositivo gera a dela, e as duas convivem
    await generateClips({ baseDir: base, settings: device })
    assert.ok(await loadCurrentClips(base, device))
    assert.ok(await loadCurrentClips(base, persona))
    // gerar a persona de novo: idempotente (a adoção conta como em dia)
    await generateClips({ baseDir: base, settings: persona })
    assert.equal(f.calls.length, calls + totalClips)
  } finally {
    f.restore()
    rmSync(base, { recursive: true, force: true })
  }
})

test('limpeza: variantes das vozes em uso ficam sempre; as sem uso há 30 dias saem; usadas há pouco ficam; antigo sem dono velho sai', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const day = 24 * 60 * 60 * 1000
  const a = localSettings('pf_dora')
  const b = localSettings('pm_alex')
  const c = {
    ...localSettings('pf_dora'),
    local: { engine: 'kokoro' as const, voice: 'pm_santa', installed: true }
  }
  const ma = await generateClips({ baseDir: base, settings: a, local: backend })
  const mb = await generateClips({ baseDir: base, settings: b, local: backend })
  const mc = await generateClips({ baseDir: base, settings: c, local: backend })
  // nada velho ainda: nada sai
  assert.deepEqual((await pruneClips({ baseDir: base, keep: [a] })).removed, [])
  assert.deepEqual(
    (await pruneClips({ baseDir: base, keep: [a], now: Date.now() + 10 * day })).removed,
    [],
    'usadas há 10 dias'
  )
  // 31 dias depois: em uso (a, b) ficam mesmo sem uso; c sai (com a pasta da voz, que esvaziou)
  const later = Date.now() + CLIP_UNUSED_MAX_AGE_MS + day
  const r = await pruneClips({ baseDir: base, keep: [a, b], now: later })
  assert.deepEqual(r.removed, [`${mc.voiceId}/${mc.variant}`])
  assert.ok(await loadCurrentClips(base, a))
  assert.ok(await loadCurrentClips(base, b))
  assert.equal(await loadVoiceClips(base, c), null)
  assert.ok(!existsSync(clipsDir(base, mc.voiceId)!), 'pasta da voz vazia sai')
  // layout antigo: o que casa com uma voz em uso é adotado (nunca apagado); o sem dono e velho sai
  const legacyA = toLegacyLayout(base, ma)
  const legacyB = toLegacyLayout(base, mb)
  const r2 = await pruneClips({ baseDir: base, keep: [a], now: later })
  assert.ok(await loadClips(base, ma.voiceId, ma.variant), 'a adotou o antigo dela')
  assert.ok(!existsSync(join(legacyA, 'manifest.json')))
  assert.deepEqual(r2.removed, [`${mb.voiceId}/(antigo)`])
  assert.ok(!existsSync(legacyB), 'o antigo sem dono saiu (e a pasta vazia)')
  assert.ok(await loadCurrentClips(base, a))
  // antigo sem dono mas recente: fica (pode ser de uma voz ainda não vista)
  const mb2 = await generateClips({ baseDir: base, settings: b, local: backend })
  toLegacyLayout(base, mb2)
  assert.deepEqual((await pruneClips({ baseDir: base, keep: [a] })).removed, [])
  assert.ok(await loadClips(base, mb2.voiceId))
  // arquivos/pastas desconhecidos na raiz/na voz nunca são tocados
  writeFileSync(join(base, 'voice-clips', 'LEIA-ME.txt'), 'x')
  mkdirSync(join(clipsDir(base, ma.voiceId)!, 'minha-pasta'))
  await pruneClips({ baseDir: base, keep: [a], now: later })
  assert.ok(existsSync(join(base, 'voice-clips', 'LEIA-ME.txt')))
  assert.ok(existsSync(join(clipsDir(base, ma.voiceId)!, 'minha-pasta')))
  rmSync(base, { recursive: true, force: true })
})

test('1.18.0: frases PRÓPRIAS da persona/chat — pasta própria (variante + hash do pool); a do dispositivo segue a mesma; limpeza mantém as duas', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const s = localSettings('pf_dora')
  const toolPool = [{ text: 'Frase da persona.', categories: ['web' as const] }]
  const device = await generateClips({ baseDir: base, settings: s, local: backend })
  const own = await generateClips({
    baseDir: base,
    settings: s,
    local: backend,
    toolPool,
    own: { filler: false, tool: true }
  })
  assert.equal(own.voiceId, device.voiceId, 'mesma voz')
  assert.equal(device.variant, (await clipsLocation(base, s)).variant, 'a do dispositivo não mudou')
  assert.match(own.variant, /^[0-9a-f]{16}-[0-9a-f]{8}$/)
  assert.ok(own.variant.startsWith(device.variant), 'mesma configuração de voz + o hash do pool')
  assert.equal(await ownPoolsKey(null, null, toolPool), null)
  assert.equal(await ownPoolsKey({ filler: false, tool: false }, null, toolPool), null)
  // cada lado acha os clipes dele (nenhum sobrescreveu o outro)
  const ownTool = await loadCurrentClipAudio(base, s, null, 'TOOL', 1, toolPool, null, {
    filler: false,
    tool: true
  })
  const devTool = await loadCurrentClipAudio(base, s, null, 'TOOL', 1)
  assert.ok(ownTool && devTool)
  assert.notDeepEqual(Buffer.from(ownTool.audio), Buffer.from(devTool.audio))
  // pool próprio diferente → outra pasta
  const other = await ownPoolsKey({ filler: false, tool: true }, null, [
    { text: 'Outra frase.', categories: ['web'] }
  ])
  assert.notEqual(other, own.variant.slice(17))
  // limpeza bem depois: as duas em uso ficam
  const later = Date.now() + CLIP_UNUSED_MAX_AGE_MS + 24 * 60 * 60 * 1000
  const r = await pruneClips({
    baseDir: base,
    keep: [s],
    keepOwn: [{ settings: s, fillerPool: null, toolPool, own: { filler: false, tool: true } }],
    now: later
  })
  assert.deepEqual(r.removed, [])
  // sem a persona em uso: a pasta própria sai, a do dispositivo fica
  const r2 = await pruneClips({ baseDir: base, keep: [s], now: later })
  assert.deepEqual(r2.removed, [`${own.voiceId}/${own.variant}`])
  assert.ok(await loadCurrentClips(base, s))
  rmSync(base, { recursive: true, force: true })
})
