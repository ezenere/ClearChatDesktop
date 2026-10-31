// Testes do aviso de versão nova (sem Electron): comparação de versões, parse da release do GitHub,
// "mostrar / dispensado para esta versão" e o checker do main com fetch falso.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/updates.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LATEST_RELEASE_API,
  RELEASES_PAGE,
  compareVersions,
  isNewer,
  isReleaseUrl,
  parseLatestRelease,
  parseVersion,
  shouldShowUpdateNotice,
  type UpdateStatus
} from '../src/shared/updates.ts'
import { createUpdateChecker } from '../src/main/updates.ts'

test('parseVersion: v opcional, partes faltando = 0, pré-release ignorada, lixo = null', () => {
  assert.deepEqual(parseVersion('0.6.1'), [0, 6, 1])
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('V2.0'), [2, 0, 0])
  assert.deepEqual(parseVersion('3'), [3, 0, 0])
  assert.deepEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3])
  assert.deepEqual(parseVersion('1.2.3+build.5'), [1, 2, 3])
  assert.equal(parseVersion('latest'), null)
  assert.equal(parseVersion('1.2.x'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)
  assert.equal(parseVersion(7), null)
})

test('compareVersions: numérico por parte (não lexicográfico)', () => {
  assert.ok(compareVersions('0.7.0', '0.6.1') > 0)
  assert.ok(compareVersions('0.6.1', '0.7.0') < 0)
  assert.equal(compareVersions('v0.6.1', '0.6.1'), 0)
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
  assert.ok(compareVersions('0.6.10', '0.6.9') > 0)
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
  // pré-release conta como a própria versão
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), 0)
})

test('isReleaseUrl: só https://github.com/ezenere/ClearChatDesktop/… ou o nome antigo (caixa livre)', () => {
  assert.ok(isReleaseUrl('https://github.com/ezenere/ClearChatDesktop/releases/tag/v0.7.0'))
  assert.ok(isReleaseUrl('https://github.com/ezenere/ClearChat/releases/tag/v0.7.0'))
  assert.ok(!isReleaseUrl('https://github.com/ezenere/ClearChatWebsite/releases'))
  assert.ok(isReleaseUrl('https://github.com/ezenere/clearchat/releases'))
  assert.ok(isReleaseUrl(RELEASES_PAGE))
  assert.ok(!isReleaseUrl('http://github.com/ezenere/ClearChat/releases'))
  assert.ok(!isReleaseUrl('https://github.com/outro/ClearChat/releases'))
  assert.ok(!isReleaseUrl('https://github.com/ezenere/ClearChatX/releases'))
  assert.ok(!isReleaseUrl('https://github.com.evil.io/ezenere/ClearChat'))
  assert.ok(!isReleaseUrl('https://evil.io/github.com/ezenere/ClearChat'))
  assert.ok(!isReleaseUrl('https://user@github.com/ezenere/ClearChat'))
  assert.ok(!isReleaseUrl('https://github.com:8443/ezenere/ClearChat'))
  assert.ok(!isReleaseUrl('javascript:alert(1)'))
  assert.ok(!isReleaseUrl('não é url'))
  assert.ok(!isReleaseUrl(null))
})

test('parseLatestRelease: tag sem v, html_url validada, rascunho/pré/sem tag → null', () => {
  assert.deepEqual(
    parseLatestRelease({
      tag_name: 'v0.7.0',
      html_url: 'https://github.com/ezenere/ClearChat/releases/tag/v0.7.0',
      name: ' ClearChat 0.7.0 ',
      published_at: '2026-10-18T12:00:00Z'
    }),
    {
      version: '0.7.0',
      url: 'https://github.com/ezenere/ClearChat/releases/tag/v0.7.0',
      name: 'ClearChat 0.7.0',
      publishedAt: '2026-10-18T12:00:00Z'
    }
  )
  // URL fora do repositório → página das releases
  assert.equal(
    parseLatestRelease({ tag_name: '0.7.0', html_url: 'https://evil.io/x' })?.url,
    RELEASES_PAGE
  )
  assert.equal(parseLatestRelease({ tag_name: '0.7.0' })?.url, RELEASES_PAGE)
  assert.equal(parseLatestRelease({ tag_name: 'v0.7.0', draft: true }), null)
  assert.equal(parseLatestRelease({ tag_name: 'v0.7.0', prerelease: true }), null)
  assert.equal(parseLatestRelease({ tag_name: 'nightly' }), null)
  assert.equal(parseLatestRelease({ message: 'Not Found' }), null)
  assert.equal(parseLatestRelease(null), null)
  assert.equal(parseLatestRelease('x'), null)
})

const st = (current: string, latest?: string): UpdateStatus => ({
  current,
  state: latest ? 'available' : 'idle',
  latest: latest ? { version: latest, url: RELEASES_PAGE } : undefined
})

test('shouldShowUpdateNotice: só com versão mais nova não dispensada', () => {
  assert.equal(shouldShowUpdateNotice(null, null), false)
  assert.equal(shouldShowUpdateNotice(st('0.6.1'), null), false)
  // mesma versão / mais antiga que a instalada (build local à frente)
  assert.equal(shouldShowUpdateNotice(st('0.6.1', '0.6.1'), null), false)
  assert.equal(shouldShowUpdateNotice(st('0.7.0', '0.6.1'), null), false)
  // mais nova
  assert.equal(shouldShowUpdateNotice(st('0.6.1', '0.7.0'), null), true)
  assert.equal(shouldShowUpdateNotice(st('0.6.1', '0.7.0'), ''), true)
  // dispensada esta versão → some
  assert.equal(shouldShowUpdateNotice(st('0.6.1', '0.7.0'), '0.7.0'), false)
  assert.equal(shouldShowUpdateNotice(st('0.6.1', 'v0.7.0'), '0.7.0'), false)
  // dispensada uma posterior (cache antigo) → continua calado
  assert.equal(shouldShowUpdateNotice(st('0.6.1', '0.7.0'), '0.8.0'), false)
  // versão ainda mais nova que a dispensada → volta
  assert.equal(shouldShowUpdateNotice(st('0.6.1', '0.7.1'), '0.7.0'), true)
  assert.equal(shouldShowUpdateNotice(st('0.6.1', '0.8.0'), '0.7.0'), true)
  // estado de erro mantém a última release conhecida
  assert.equal(shouldShowUpdateNotice({ ...st('0.6.1', '0.7.0'), state: 'error' }, null), true)
  assert.equal(isNewer(undefined, '0.6.1'), false)
})

// ---- checker do main (fetch falso) ----

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

test('checker: versão nova → available; request sem chave e só com Accept/User-Agent', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const events: UpdateStatus[] = []
  const c = createUpdateChecker({
    currentVersion: '0.6.1',
    onStatus: (s) => events.push(s),
    log: () => undefined,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return jsonResponse({
        tag_name: 'v0.7.0',
        html_url: 'https://github.com/ezenere/ClearChat/releases/tag/v0.7.0'
      })
    }
  })
  assert.equal(c.status().state, 'idle')
  const s = await c.check()
  assert.equal(s.state, 'available')
  assert.equal(s.latest?.version, '0.7.0')
  assert.equal(s.current, '0.6.1')
  assert.ok(s.checkedAt)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, LATEST_RELEASE_API)
  assert.equal(calls[0].url, 'https://api.github.com/repos/ezenere/ClearChatDesktop/releases/latest')
  assert.deepEqual(Object.keys(calls[0].init.headers as Record<string, string>).sort(), [
    'Accept',
    'User-Agent'
  ])
  assert.equal(
    (calls[0].init.headers as Record<string, string>).Accept,
    'application/vnd.github+json'
  )
  assert.deepEqual(
    events.map((e) => e.state),
    ['checking', 'available']
  )
})

test('checker: mesma versão → latest; chamadas simultâneas compartilham a request', async () => {
  let n = 0
  const c = createUpdateChecker({
    currentVersion: '0.7.0',
    log: () => undefined,
    fetch: async () => {
      n++
      await new Promise((r) => setTimeout(r, 10))
      return jsonResponse({ tag_name: '0.7.0' })
    }
  })
  const [a, b] = await Promise.all([c.check(), c.check()])
  assert.equal(n, 1)
  assert.equal(a.state, 'latest')
  assert.equal(b.state, 'latest')
})

test('checker: rede, 403/429, 404, 500 e JSON inválido → error silencioso (só log)', async () => {
  const cases: [string, () => Promise<Response>][] = [
    [
      'rede',
      async () => {
        throw new TypeError('fetch failed')
      }
    ],
    ['403', async () => jsonResponse({ message: 'API rate limit exceeded' }, 403)],
    ['429', async () => jsonResponse({}, 429)],
    ['404', async () => jsonResponse({ message: 'Not Found' }, 404)],
    ['500', async () => jsonResponse({}, 500)],
    ['json', async () => new Response('<html>', { status: 200 })],
    ['sem tag', async () => jsonResponse({ name: 'x' })]
  ]
  for (const [label, impl] of cases) {
    const logs: string[] = []
    const c = createUpdateChecker({
      currentVersion: '0.6.1',
      log: (m) => logs.push(m),
      fetch: impl
    })
    const s = await c.check()
    assert.equal(s.state, 'error', label)
    assert.ok(s.error, label)
    assert.equal(logs.length, 1, label)
    assert.equal(s.latest, undefined, label)
  }
})

test('checker: falha depois de achar versão nova mantém a release conhecida', async () => {
  let fail = false
  const c = createUpdateChecker({
    currentVersion: '0.6.1',
    log: () => undefined,
    fetch: async () => {
      if (fail) throw new Error('offline')
      return jsonResponse({ tag_name: 'v0.7.0' })
    }
  })
  assert.equal((await c.check()).state, 'available')
  fail = true
  const s = await c.check()
  assert.equal(s.state, 'error')
  assert.equal(s.latest?.version, '0.7.0')
  assert.equal(shouldShowUpdateNotice(s, null), true)
})

test('checker: start/stop não seguram o processo nem disparam depois de stop', async () => {
  let n = 0
  const c = createUpdateChecker({
    currentVersion: '0.6.1',
    log: () => undefined,
    fetch: async () => {
      n++
      return jsonResponse({ tag_name: '0.6.1' })
    }
  })
  c.start()
  c.start() // idempotente
  c.stop()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(n, 0)
})
