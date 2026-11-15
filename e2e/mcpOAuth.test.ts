/* eslint-disable @typescript-eslint/no-explicit-any */
// Conectores (MCP): login OAuth por aparelho (src/main/mcp/oauth.ts) contra o servidor MCP FALSO
// com OAuth falso (e2e/fixtures/mcp-fake-server.mjs — metadados, /authorize que aprova na hora,
// /token com PKCE S256 e refresh, /register). O "navegador" é um fetch que segue o redirect até o
// callback local. Registro dinâmico e Client ID Metadata Document, state conferido, tokens
// cifrados, renovação pelo refresh sem navegador, sair. Sem rede externa.
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/mcpOAuth.test.ts
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-mcpauth-'))
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

const { mcpRepo } = await import('../src/main/mcp/store.ts')
const { mcpManager, configureMcpManager } = await import('../src/main/mcp/manager.ts')
const oauth = await import('../src/main/mcp/oauth.ts')
const { startFakeMcpHttp } = await import('./fixtures/mcp-fake-server.mjs')
const { getDb, closeDb } = await import('../src/main/db.ts')

after(async () => {
  await mcpManager.closeAll()
  closeDb()
  rmSync(TMP, { recursive: true, force: true })
})

// "navegador": segue o 302 do /authorize até o callback local; `tamper` mexe na URL de volta
let tamper: ((u: URL) => void) | null = null
const opened: string[] = []
oauth.configureMcpOAuth({
  crypto: {
    encrypt: (p) => Buffer.from(`X${p}`).toString('base64'),
    decrypt: (s) => {
      const t = Buffer.from(s, 'base64').toString()
      return t.startsWith('X') ? t.slice(1) : null
    }
  },
  openUrl: async (url) => {
    opened.push(url)
    const r = await fetch(url, { redirect: 'manual' })
    const back = new URL(r.headers.get('location')!)
    tamper?.(back)
    await fetch(back)
  }
})
configureMcpManager({ authProvider: oauth.mcpAuthProvider })

const rawAuth = (): Record<string, string> =>
  JSON.parse(
    (getDb().prepare("SELECT value FROM settings WHERE key = 'mcpAuth'").get() as any)?.value ??
      '{}'
  )

test('registro dinâmico: login no navegador, PKCE S256, conectado; tokens cifrados', async () => {
  const srv = await startFakeMcpHttp({ era: 'modern', auth: true })
  try {
    const s = mcpRepo.create({
      name: 'dcr',
      transport: { type: 'http', url: srv.url, headers: {} },
      oauth: true
    })
    assert.equal(oauth.mcpHasLogin(s.id), false)
    const r = await oauth.mcpLogin(s.id)
    assert.deepEqual(r, { ok: true })
    assert.equal(mcpManager.status(s.id).state, 'ready')
    // registro: app nativo, redirect no 127.0.0.1, sem segredo
    const reg = srv.seen.registrations[0]
    assert.equal(reg.application_type, 'native')
    assert.equal(reg.token_endpoint_auth_method, 'none')
    assert.match(reg.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // autorização: PKCE S256, state, resource = o servidor MCP
    const a = srv.seen.authorize[0]
    assert.equal(a.code_challenge_method, 'S256')
    assert.ok(a.state && a.code_challenge)
    assert.equal(a.client_id, 'dyn-1')
    assert.equal(a.resource, srv.url)
    assert.equal(opened.length, 1)
    // tokens: cifrados no setting local
    assert.ok(rawAuth()[s.id].startsWith('enc:'))
    assert.ok(!JSON.stringify(rawAuth()).includes('tok-'), 'token nunca em claro')
    assert.equal(oauth.mcpHasLogin(s.id), true)
    const call: any = await mcpManager.callTool(
      s.id,
      'echo',
      { text: 'ok' },
      {
        signal: new AbortController().signal,
        owner: { chatId: 'c', sessionId: 's', toolCallId: 't' }
      }
    )
    assert.equal(call.content[0].text, 'eco: ok')
    // token invalidado no servidor → renova pelo refresh, sem abrir o navegador
    srv.revoke()
    await mcpManager.reconnect(s.id)
    assert.equal(mcpManager.status(s.id).state, 'ready')
    assert.equal(opened.length, 1, 'sem novo login')
    assert.ok(srv.seen.tokens.some((t: any) => t.grant_type === 'refresh_token'))
    // sair: tokens apagados; reconectar pede login
    await oauth.mcpLogout(s.id)
    assert.equal(oauth.mcpHasLogin(s.id), false)
    srv.revoke()
    await mcpManager.reconnect(s.id)
    assert.equal(mcpManager.status(s.id).state, 'needs-auth')
    assert.equal(opened.length, 1, 'em segundo plano nada abre')
  } finally {
    await mcpManager.closeAll()
    await srv.close()
  }
})

test('Client ID Metadata Document: o client_id é a URL do documento (sem registro)', async () => {
  const srv = await startFakeMcpHttp({ era: 'legacy', auth: true, cimd: true })
  try {
    const s = mcpRepo.create({
      name: 'cimd',
      transport: { type: 'http', url: srv.url, headers: {} },
      oauth: true
    })
    assert.deepEqual(await oauth.mcpLogin(s.id), { ok: true })
    assert.equal(srv.seen.registrations.length, 0)
    assert.equal(srv.seen.authorize[0].client_id, oauth.CLIENT_METADATA_URL)
    assert.equal(mcpManager.status(s.id).state, 'ready')
  } finally {
    await mcpManager.closeAll()
    await srv.close()
  }
})

test('state adulterado no retorno: login recusado, nada salvo', async () => {
  const srv = await startFakeMcpHttp({ era: 'modern', auth: true })
  tamper = (u) => u.searchParams.set('state', 'outro')
  try {
    const s = mcpRepo.create({
      name: 'tampered',
      transport: { type: 'http', url: srv.url, headers: {} },
      oauth: true
    })
    const r = await oauth.mcpLogin(s.id)
    assert.equal(r.ok, false)
    assert.match((r as any).error, /state não confere/)
    assert.equal(oauth.mcpHasLogin(s.id), false)
    assert.equal(srv.seen.tokens.length, 0, 'o código nunca foi trocado')
  } finally {
    tamper = null
    await srv.close()
  }
})

test('conector sem OAuth: login recusado com mensagem', async () => {
  const s = mcpRepo.create({
    name: 'plain-http',
    transport: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: {} }
  })
  assert.deepEqual(await oauth.mcpLogin(s.id), {
    ok: false,
    error: 'Este conector não usa login OAuth.'
  })
})
