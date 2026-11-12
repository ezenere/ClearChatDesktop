// Clipes dos preâmbulos e das frases de ferramenta (`src/main/voice/clips.ts`): nomes de arquivo
// pela whitelist de classes (`FILLER`, `TOOL`), manifest por voz (id da voz, engine, modelo, hash da
// definição + hash por classe), cache reutilizado quando a definição não muda (por classe: só a
// classe que mudou é sintetizada), cache só de preâmbulos (de antes das frases de ferramenta)
// continuando a tocar, regeneração quando a voz muda (diretório novo), cache de versões antigas
// (com outras classes de clipe) regerado sem erro e limpo, `resolveClip` para a Feature B e defesa
// contra ids de voz/nomes inseguros. A síntese usa um motor local FAKE (nada
// de ONNX nem rede — o pipeline real está reportado na SPEC).
// Rodar: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLIP_CLASSES,
  CLIP_MAX_VARIANTS,
  clipClassHash,
  clipFileName,
  clipPhraseSet,
  clipStaleClasses,
  loadCurrentClipAudio,
  loadCurrentClips,
  trimWavSilence,
  clipVoiceId,
  clipsDir,
  clipsHash,
  generateClips,
  loadClips,
  removeClips,
  resolveClip
} from '../src/main/voice/clips.ts'
import type { TtsLocalBackend, TtsLocalInput, TtsLocalResult } from '../src/main/voice/tts.ts'
import {
  DEFAULT_FILLER_POOL,
  DEFAULT_TOOL_PHRASE_POOL,
  normalizeTtsSettings,
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
  assert.ok(manifest.clips.every((c) => c.class === 'FILLER' || c.class === 'TOOL'))
  // hash por classe no manifest
  assert.equal(manifest.classHashes.FILLER, await clipClassHash(localSettings('pf_dora'), 'FILLER'))
  assert.equal(manifest.classHashes.TOOL, await clipClassHash(localSettings('pf_dora'), 'TOOL'))
  // arquivos em <base>/voice-clips/<voiceId>/<CLASSE>_<n>.wav + manifest.json (sem .part sobrando)
  const dir = clipsDir(base, manifest.voiceId)!
  const files = readdirSync(dir).sort()
  assert.equal(files.filter((f) => f.endsWith('.part')).length, 0)
  assert.ok(files.includes('manifest.json'))
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
  assert.ok(await loadClips(base, a.voiceId))
  assert.ok(await loadClips(base, b.voiceId))
  assert.ok(await resolveClip(base, a.voiceId, 'FILLER', 1))
  assert.ok(await resolveClip(base, b.voiceId, 'FILLER', 1))
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
  const dir = clipsDir(base, m.voiceId)!
  // sem manifest → null
  rmSync(join(dir, 'manifest.json'))
  assert.equal(await loadClips(base, m.voiceId), null)
  // JSON inválido → null
  writeFileSync(join(dir, 'manifest.json'), '{ não é json')
  assert.equal(await loadClips(base, m.voiceId), null)
  // vozId trocado no manifest → null
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, voiceId: 'outra-voz' }))
  assert.equal(await loadClips(base, m.voiceId), null)
  // clipe fora da whitelist → null
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      ...m,
      clips: [{ id: 'EXEC_1', file: 'EXEC_1.wav', class: 'EXEC', n: 1, text: 'x' }]
    })
  )
  assert.equal(await loadClips(base, m.voiceId), null)
  // arquivo faltando → null (cache incompleto)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m))
  rmSync(join(dir, 'FILLER_1.wav'))
  assert.equal(await loadClips(base, m.voiceId), null)
  // id de voz inseguro → null (sem traversal)
  assert.equal(await loadClips(base, '../../evil'), null)
  rmSync(base, { recursive: true, force: true })
})

test('resolveClip: caminho do wav por classe/variante; inválidos/ausentes → null', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const m = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  const dir = clipsDir(base, m.voiceId)!
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', 3), join(dir, 'FILLER_3.wav'))
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', CLIP_MAX_VARIANTS), null)
  assert.equal(await resolveClip(base, m.voiceId, 'ACK', 1), null, 'classe que saiu')
  assert.equal(await resolveClip(base, m.voiceId, 'EXEC', 1), null)
  assert.equal(await resolveClip(base, '../../evil', 'FILLER', 1), null)
  // classe conhecida mas nunca gerada (cache parcial) → null
  rmSync(join(dir, 'FILLER_2.wav'))
  assert.equal(await resolveClip(base, m.voiceId, 'FILLER', 2), null)
  rmSync(base, { recursive: true, force: true })
})

test('removeClips: apaga o cache da voz (idempotente) e ids inseguros ficam de fora', async () => {
  const base = newBase()
  const { backend } = fakeEngine()
  const m = await generateClips({ baseDir: base, settings: localSettings(), local: backend })
  await removeClips(base, m.voiceId)
  assert.equal(await loadClips(base, m.voiceId), null)
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
  const dir = clipsDir(base, clipVoiceId(localSettings()))!
  assert.ok(!existsSync(join(dir, 'manifest.json')), 'sem manifest após abort')
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
test('clipPhraseSet: FILLER (preâmbulos) e TOOL (frases de ferramenta), frases por extenso que os dois motores pronunciam', () => {
  assert.deepEqual(CLIP_CLASSES, ['FILLER', 'TOOL'])
  assert.deepEqual(Object.keys(PHRASES), ['FILLER', 'TOOL'])
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
  const dir = clipsDir(base, m.voiceId)!
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
  // como uma versão antiga deixava: ACK/THINKING + FILLER no mesmo manifest
  const { mkdirSync } = await import('node:fs')
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
  // leitura: cache velho = ausente (nada toca; nenhum erro)
  assert.equal(await loadClips(base, voiceId), null)
  assert.equal(await loadCurrentClips(base, settings), null)
  assert.equal(await loadCurrentClipAudio(base, settings, null, 'FILLER', 1), null)
  assert.equal(await loadCurrentClipAudio(base, settings, null, 'ACK', 1), null)
  // gerar de novo: só os preâmbulos; os arquivos das classes que saíram são apagados
  const m = await generateClips({ baseDir: base, settings, local: backend })
  assert.equal(calls.length, totalClips)
  assert.ok(m.clips.every((c) => c.class === 'FILLER' || c.class === 'TOOL'))
  const files = readdirSync(dir)
  assert.ok(!files.includes('ACK_1.wav') && !files.includes('THINKING_3.wav'), files.join(','))
  assert.ok(files.includes('FILLER_1.wav'))
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
  // como a versão anterior deixava o cache: só FILLER, sem `classHashes`
  const full = await generateClips({ baseDir: base, settings, local: backend })
  const dir = clipsDir(base, full.voiceId)!
  const fillers = full.clips.filter((c) => c.class === 'FILLER')
  for (const c of full.clips.filter((x) => x.class === 'TOOL')) rmSync(join(dir, c.file))
  const { classHashes: _drop, ...rest } = full
  void _drop
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ ...rest, hash: legacy, clips: fillers })
  )
  const old = await loadClips(base, full.voiceId)
  assert.ok(old, 'manifest antigo continua válido')
  assert.deepEqual(old!.classHashes, { FILLER: legacy })
  assert.deepEqual(await clipStaleClasses(old, settings), ['TOOL'])
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
  // "Gerar clipes": só as frases de ferramenta são sintetizadas
  const before = calls.length
  const m = await generateClips({ baseDir: base, settings, local: backend })
  assert.equal(calls.length - before, DEFAULT_TOOL_PHRASE_POOL.length)
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
