/* eslint-disable @typescript-eslint/no-explicit-any */
// Skills (SPEC → Skills): parse do SKILL.md, descoberta (precedência/conflitos/projeto), confinação
// do skill_read, tools (saídas e limites), config/herança, request (prompt de apoio + tools só com as
// skills ligadas; subagentes) e a invocação manual (part <skill> com `_skill` removido na request).
// Tudo sobre pastas temporárias — nunca lê o ~/.claude/skills real (home injetada).
// Rodar: npm run test:unit
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillMd, parseYaml } from '../src/main/skills/parse.ts'
import {
  clearSkillsCache,
  discoverSkills,
  expandHome,
  findSkill,
  listSkillFiles
} from '../src/main/skills/discovery.ts'
import {
  activeFromDiscovery,
  manualSkillPart,
  resolveManualSkills
} from '../src/main/skills/config.ts'
import { listSkillsTool, skillLoadTool, skillReadTool } from '../src/main/tools/skills.ts'
import { runToolImpl } from '../src/main/tools/util.ts'
import { shellArgv } from '../src/main/tools/bash.ts'
import { buildRequest, availableTools, skillsSupportPrompt } from '../src/main/agent/request.ts'
import { buildCompactionRequest } from '../src/main/agent/compaction.ts'
import { buildUserContent } from '../src/main/attachments.ts'
import { DEFAULT_CHAT_CONFIG, DEFAULT_SKILLS_SUPPORT_PROMPT } from '../src/shared/defaults.ts'
import {
  defaultSkillsConfig,
  defaultSkillsSettings,
  normalizeSkillsConfig,
  normalizeSkillsSettings,
  skillBlock,
  skillBlockBody
} from '../src/shared/skills.ts'
import { applyPreset, PRESET_FIELDS, sanitizePresetConfig } from '../src/shared/presets.ts'
import { contentText, messageSkills } from '../src/shared/attachments.ts'
import { SKILL_TOOL_NAMES, TOOL_DEFINITIONS, TOOL_LABELS, TOOL_NAMES } from '../src/shared/tools.ts'
import { withText } from '../src/renderer/src/lib/format.ts'
import {
  activeSkills,
  filterSkills,
  listedSkillNames,
  skillToolSummary,
  toggleSkill
} from '../src/renderer/src/lib/skills.ts'

const TMP = mkdtempSync(join(process.env.CLEARCHAT_TEST_TMP || tmpdir(), 'clearchat-skills-'))
after(() => rmSync(TMP, { recursive: true, force: true }))

const HOME = join(TMP, 'home')
const ROOT = join(TMP, 'root') // diretório raiz de um chat
mkdirSync(HOME, { recursive: true })
mkdirSync(ROOT, { recursive: true })

function skill(
  base: string,
  dir: string,
  fm: string,
  body = '# Instruções\n\nFaça X.\n',
  files: Record<string, string> = {}
): string {
  const d = join(base, dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), `---\n${fm}\n---\n\n${body}`)
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(d, p, '..'), { recursive: true })
    writeFileSync(join(d, p), c)
  }
  return d
}

const IMPLS: Record<string, any> = {
  list_skills: listSkillsTool,
  skill_load: skillLoadTool,
  skill_read: skillReadTool
}
/** Mesmo caminho do runLocalTool (tools/index.ts importa o Electron via web.ts). */
const runLocalTool = (name: string, args: any, c: any): Promise<any> =>
  runToolImpl(IMPLS[name], args, c)

const env = { os: 'L', shell: 'bash' }
const provider: any = {
  id: 'p',
  name: 'P',
  baseUrl: 'http://127.0.0.1:9/v1',
  apiKey: 'k',
  headers: {},
  kind: 'openai',
  createdAt: 0
}
const textOf = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? '').join('') : ''
const chatWith = (skills?: any, extra: any = {}): any => ({
  id: 'c1',
  title: 't',
  mainSessionId: 's1',
  createdAt: 0,
  updatedAt: 0,
  config: {
    ...DEFAULT_CHAT_CONFIG(ROOT),
    providerId: 'p',
    model: 'm',
    enabledTools: ['read_file', 'shell'],
    skills,
    // definições completas (a compactação, 1.11.0, tem testes próprios em compactTools.test.ts)
    toolsCompact: false,
    ...extra
  }
})
const on = (over: any = {}): any => ({ ...defaultSkillsConfig(), enabled: true, ...over })
const ctx = (skills: any[], over: any = {}): any => ({
  cwd: ROOT,
  confine: true,
  maxOutput: 30_000,
  signal: new AbortController().signal,
  skills,
  ...over
})

// ---------------- parse ----------------

test('SKILL.md válido: frontmatter + corpo; campos extras viram meta/other', () => {
  const r = parseSkillMd(
    [
      '---',
      'name: pdf-tools',
      'description: Extrai texto de PDFs. Use com PDFs.',
      'license: Apache-2.0',
      'compatibility: "Requer python3"',
      'allowed-tools: Bash(git:*) Read',
      'metadata:',
      '  author: exemplo',
      '  version: "1.0"',
      'when_to_use: quando houver PDF',
      'tags: [a, "b c"]',
      '---',
      '',
      '# PDF',
      'Passo 1.'
    ].join('\n'),
    'pdf-tools'
  )
  assert.equal(r.error, undefined)
  assert.deepEqual(r.warnings, [])
  assert.equal(r.meta!.name, 'pdf-tools')
  assert.equal(r.meta!.description, 'Extrai texto de PDFs. Use com PDFs.')
  assert.equal(r.meta!.license, 'Apache-2.0')
  assert.equal(r.meta!.compatibility, 'Requer python3')
  assert.equal(r.meta!.allowedTools, 'Bash(git:*) Read')
  assert.deepEqual(r.meta!.metadata, { author: 'exemplo', version: '1.0' })
  assert.deepEqual(r.meta!.other, { when_to_use: 'quando houver PDF', tags: 'a, b c' })
  assert.equal(r.body, '# PDF\nPasso 1.')
})

test('parse: CRLF e BOM normalizados; descrição em bloco > e |; allowed-tools em lista', () => {
  const crlf =
    '﻿---\r\nname: x\r\ndescription: >\r\n  linha um\r\n  linha dois\r\nallowed-tools:\r\n  - Read\r\n  - Bash\r\n---\r\ncorpo\r\n'
  const r = parseSkillMd(crlf, 'x')
  assert.equal(r.error, undefined)
  assert.equal(r.meta!.description, 'linha um linha dois')
  assert.equal(r.meta!.allowedTools, 'Read Bash')
  assert.ok(!r.content.includes('\r') && !r.content.startsWith('﻿'))
  const lit = parseYaml('description: |\n  a\n  b\nname: y')
  assert.equal(lit.description, 'a\nb')
  assert.equal(lit.name, 'y')
  assert.equal(parseYaml("k: 'it''s' # c").k, "it's")
  assert.equal(parseYaml('k: valor # comentário').k, 'valor')
})

test('parse: sem frontmatter / não fechado / YAML ruim → inválida', () => {
  assert.match(parseSkillMd('# só markdown', 'a').error!, /sem frontmatter/)
  assert.match(parseSkillMd('---\nname: a\ndescription: b\n', 'a').error!, /não fechado/)
  assert.match(parseSkillMd('---\nname: a\n  solto: x\n---\n', 'a').error!, /YAML inválido/)
  assert.match(parseSkillMd('---\nname: "a\ndescription: b\n---\n', 'a').error!, /YAML inválido/)
})

test('parse: sem description → inválida; sem name → nome da pasta (aviso); nome fora do padrão/≠ pasta → aviso', () => {
  assert.match(parseSkillMd('---\nname: a\n---\nx', 'a').error!, /sem "description"/)
  assert.match(
    parseSkillMd('---\nname: a\ndescription: ""\n---\nx', 'a').error!,
    /sem "description"/
  )
  const noName = parseSkillMd('---\ndescription: faz algo\n---\nx', 'minha-skill')
  assert.equal(noName.error, undefined)
  assert.equal(noName.meta!.name, 'minha-skill')
  assert.match(noName.warnings[0], /sem "name"/)
  const bad = parseSkillMd('---\nname: Minha_Skill\ndescription: d\n---\n', 'outra')
  assert.equal(bad.error, undefined)
  assert.ok(bad.warnings.some((w) => /diferente do nome da pasta/.test(w)))
  assert.ok(bad.warnings.some((w) => /fora do padrão/.test(w)))
  assert.match(
    parseSkillMd('---\nname: [a, b]\ndescription: d\n---\n', 'a').error!,
    /precisa ser texto/
  )
  const long = parseSkillMd(`---\nname: a\ndescription: ${'x'.repeat(1100)}\n---\n`, 'a')
  assert.ok(long.warnings.some((w) => /1100 caracteres/.test(w)))
})

// ---------------- descoberta ----------------

const A = join(HOME, '.claude', 'skills')
const B = join(TMP, 'extra-skills')
const OUTSIDE = join(TMP, 'outside')
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(OUTSIDE, 'segredo.txt'), 'SEGREDO')
skill(
  A,
  'pdf',
  'name: pdf\ndescription: PDFs: extrair texto e tabelas',
  '# PDF\n\nUse scripts/extract.py\n',
  {
    'scripts/extract.py': 'print("oi")\n',
    'references/guia.md': Array.from({ length: 50 }, (_, i) => `linha ${i + 1}`).join('\n') + '\n'
  }
)
skill(A, 'quebrada', 'name: quebrada')
skill(A, 'comum', 'name: comum\ndescription: versão do local A')
skill(B, 'comum', 'name: comum\ndescription: versão do local B')
skill(B, 'planilhas', 'name: planilhas\ndescription: Planilhas xlsx e csv')
skill(
  join(ROOT, '.claude', 'skills'),
  'projeto-x',
  'name: projeto-x\ndescription: Convenções do projeto X'
)
skill(
  join(ROOT, '.claude', 'skills'),
  'pdf',
  'name: pdf\ndescription: pdf do projeto (perde para o pessoal)'
)
// skill linkada (pasta-link dentro do local)
const linkedTarget = skill(
  join(TMP, 'linked-src'),
  'linkada',
  'name: linkada\ndescription: via symlink'
)
symlinkSync(linkedTarget, join(B, 'linkada'))
// link de fuga dentro da skill pdf
symlinkSync(OUTSIDE, join(A, 'pdf', 'fuga'))

const settings = (over: any = {}): any => ({
  locations: [
    { id: 'default', path: '~/.claude/skills', enabled: true },
    { id: 'b', path: B, enabled: true },
    { id: 'nao', path: join(TMP, 'nao-existe'), enabled: true }
  ],
  projectSkills: true,
  ...over
})

test('descoberta: precedência pela ordem, conflitos (sobrescrita), inválidas, projeto por último, link de pasta', async () => {
  const d = await discoverSkills({ settings: settings(), cwd: ROOT, home: HOME, counts: true })
  const [a, b, nao, proj] = d.locations
  assert.equal(a.resolved, A)
  assert.equal(a.label, '~/.claude/skills')
  assert.equal(nao.exists, false)
  assert.equal(proj.kind, 'project')
  assert.equal(proj.label, 'projeto · .claude/skills')
  assert.deepEqual(
    d.skills.map((s) => `${s.name}@${s.locationId}`),
    ['comum@default', 'pdf@default', 'linkada@b', 'planilhas@b', 'projeto-x@project']
  )
  const quebrada = a.skills.find((s) => s.name === 'quebrada')!
  assert.match(quebrada.error!, /description/)
  assert.equal(b.skills.find((s) => s.name === 'comum')!.shadowedBy, '~/.claude/skills')
  assert.equal(proj.skills.find((s) => s.name === 'pdf')!.shadowedBy, '~/.claude/skills')
  assert.equal(a.skills.find((s) => s.name === 'pdf')!.files, 3) // SKILL.md + script + guia (o link de pasta não é seguido)
})

test('descoberta: local desligado fica na lista mas sai das efetivas; projeto desligado; local que é a própria skill', async () => {
  const d = await discoverSkills({
    settings: settings({
      locations: [
        { id: 'default', path: '~/.claude/skills', enabled: false },
        { id: 'b', path: B, enabled: true },
        { id: 'one', path: join(A, 'pdf'), enabled: true }
      ],
      projectSkills: false
    }),
    cwd: ROOT,
    home: HOME
  })
  assert.equal(d.locations.length, 3)
  assert.ok(d.locations[0].skills.length > 0, 'desligado ainda é escaneado (UI)')
  assert.deepEqual(
    d.skills.map((s) => s.name),
    ['comum', 'linkada', 'planilhas', 'pdf']
  )
  assert.equal(d.skills.find((s) => s.name === 'comum')!.description, 'versão do local B')
  assert.equal(d.skills.find((s) => s.name === 'pdf')!.locationId, 'one')
})

test('descoberta: cache por mtime (mudança no SKILL.md aparece); home expandida; findSkill', async () => {
  const dir = skill(B, 'mutavel', 'name: mutavel\ndescription: v1')
  let d = await discoverSkills({ settings: settings(), home: HOME })
  assert.equal(findSkill(d.skills, 'mutavel')!.description, 'v1')
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: mutavel\ndescription: versão 2 mais longa\n---\n'
  )
  d = await discoverSkills({ settings: settings(), home: HOME })
  assert.equal(findSkill(d.skills, 'mutavel')!.description, 'versão 2 mais longa')
  assert.equal(findSkill(d.skills, 'MUTAVEL')!.name, 'mutavel')
  assert.equal(expandHome('~/x', '/h'), '/h/x')
  rmSync(dir, { recursive: true })
  clearSkillsCache()
})

test('settings e config: normalização, padrões', () => {
  assert.deepEqual(normalizeSkillsSettings(null), defaultSkillsSettings())
  assert.deepEqual(defaultSkillsSettings().locations[0].path, '~/.claude/skills')
  const n = normalizeSkillsSettings({
    locations: [
      { path: ' /a ' },
      { path: '/a' },
      { id: 'project', path: '/b', enabled: false },
      { path: '' }
    ],
    projectSkills: false
  })
  assert.deepEqual(
    n.locations.map((l) => [l.path, l.enabled]),
    [
      ['/a', true],
      ['/b', false]
    ]
  )
  assert.notEqual(n.locations[1].id, 'project')
  assert.equal(n.projectSkills, false)
  const c = normalizeSkillsConfig({
    enabled: true,
    disabled: ['a', 'a', 3],
    supportPrompt: { text: '  ' },
    x: 1
  })
  assert.deepEqual(c, {
    enabled: true,
    disabled: ['a'],
    supportPrompt: { enabled: true, text: null },
    subagents: false
  })
  assert.equal(normalizeSkillsConfig(undefined).enabled, false)
})

test('herança de persona: skills em PRESET_FIELDS, normalizada; chat herda (snapshot)', () => {
  assert.ok((PRESET_FIELDS as readonly string[]).includes('skills'))
  const p = sanitizePresetConfig({
    skills: { enabled: true, disabled: ['pdf'], subagents: true, lixo: 1 }
  })
  assert.deepEqual(p.skills, {
    enabled: true,
    disabled: ['pdf'],
    supportPrompt: { enabled: true, text: null },
    subagents: true
  })
  const cfg = applyPreset(DEFAULT_CHAT_CONFIG(ROOT), p)
  assert.equal(cfg.skills!.enabled, true)
  assert.deepEqual(cfg.skills!.disabled, ['pdf'])
})

test('skills ativas: desligado → nenhuma; subconjunto (disabled)', async () => {
  const d = await discoverSkills({ settings: settings(), cwd: ROOT, home: HOME })
  assert.deepEqual(activeFromDiscovery(d, { skills: undefined }), [])
  assert.deepEqual(activeFromDiscovery(d, { skills: on({ enabled: false }) }), [])
  assert.deepEqual(
    activeFromDiscovery(d, { skills: on({ disabled: ['pdf', 'linkada'] }) }).map((s) => s.name),
    ['comum', 'planilhas', 'projeto-x']
  )
  // helpers do renderer
  const sc = toggleSkill(on(), 'pdf', false)
  assert.deepEqual(sc.disabled, ['pdf'])
  assert.deepEqual(toggleSkill(sc, 'pdf', true).disabled, [])
  assert.equal(
    activeSkills(d, sc).some((s) => s.name === 'pdf'),
    false
  )
  assert.deepEqual(
    filterSkills(d.skills, 'planilha csv').map((s) => s.name),
    ['planilhas']
  )
})

// ---------------- tools ----------------

test('list_skills: lista, query, vazio, limite de saída', async () => {
  const d = await discoverSkills({ settings: settings(), cwd: ROOT, home: HOME })
  const all = await runLocalTool('list_skills', {}, ctx(d.skills))
  assert.equal(all.status, 'ok')
  assert.match(all.content, /^\[5 skills disponíveis neste chat\]/)
  assert.match(all.content, /^- pdf — PDFs: extrair texto e tabelas \(~\/\.claude\/skills\)$/m)
  assert.match(all.content, /^- projeto-x — .* \(projeto · \.claude\/skills\)$/m)
  assert.deepEqual(listedSkillNames(all.content), [
    'comum',
    'pdf',
    'linkada',
    'planilhas',
    'projeto-x'
  ])
  const q = await runLocalTool('list_skills', { query: 'PLANILHA' }, ctx(d.skills))
  assert.match(q.content, /^\[1 de 5 skills para "PLANILHA"\]/)
  const none = await runLocalTool('list_skills', { query: 'zzz' }, ctx(d.skills))
  assert.match(none.content, /Nenhuma skill para "zzz"/)
  const empty = await runLocalTool('list_skills', {}, ctx([]))
  assert.match(empty.content, /Nenhuma skill disponível/)
  const many = Array.from({ length: 200 }, (_, i) => ({
    ...d.skills[0],
    name: `s${i}`,
    description: 'd'.repeat(100)
  }))
  const cut = await runLocalTool('list_skills', {}, ctx(many, { maxOutput: 2000 }))
  assert.ok(cut.content.length <= 2000, `${cut.content.length}`)
  assert.match(cut.content, /\[… mais \d+ skills — refine com query\]/)
})

test('skill_load: SKILL.md completo + arquivos + pasta absoluta; não encontrada; corte', async () => {
  const d = await discoverSkills({ settings: settings(), cwd: ROOT, home: HOME })
  const r = await runLocalTool('skill_load', { name: 'pdf' }, ctx(d.skills))
  assert.equal(r.status, 'ok')
  const dir = join(A, 'pdf')
  assert.ok(r.content.startsWith(`<skill name="pdf" path="${dir}">\n---\nname: pdf\n`))
  assert.match(r.content, /# PDF\n\nUse scripts\/extract\.py\n<\/skill>/)
  assert.match(r.content, new RegExp(`Pasta da skill: ${dir}\\n`))
  assert.match(
    r.content,
    /Arquivos \(3\):\nSKILL\.md \(\d+ B\)\nreferences\/guia\.md \([\d,]+ B\)\nscripts\/extract\.py \(12 B\)/
  )
  assert.match(r.content, /skill_read \{"name": "pdf"/)
  const nf = await runLocalTool('skill_load', { name: 'nada' }, ctx(d.skills))
  assert.equal(nf.status, 'error')
  assert.match(nf.content, /skill "nada" não encontrada\. Disponíveis: comum, pdf/)
  // skill desligada no chat = não está em ctx.skills
  const off = await runLocalTool(
    'skill_load',
    { name: 'pdf' },
    ctx(d.skills.filter((s) => s.name !== 'pdf'))
  )
  assert.equal(off.status, 'error')
  const big = skill(
    B,
    'grande',
    'name: grande\ndescription: grande',
    Array.from({ length: 3000 }, (_, i) => `linha ${i}`).join('\n')
  )
  const d2 = await discoverSkills({ settings: settings(), home: HOME })
  const g = await runLocalTool(
    'skill_load',
    { name: 'grande' },
    ctx(d2.skills, { maxOutput: 5000 })
  )
  assert.ok(g.content.length <= 5000, `${g.content.length}`)
  assert.match(g.content, /SKILL\.md cortado: .* "offset": \d+\}\]/)
  assert.match(g.content, /Pasta da skill:/)
  rmSync(big, { recursive: true })
})

test('skill_read: lê dentro da skill (formato read_file), confinado mesmo com o chat confinado; .., absoluto e symlink barrados', async () => {
  const d = await discoverSkills({ settings: settings(), cwd: ROOT, home: HOME })
  const r = await runLocalTool(
    'skill_read',
    { name: 'pdf', path: 'references/guia.md', offset: 10, limit: 3 },
    ctx(d.skills)
  )
  assert.equal(r.status, 'ok')
  assert.match(
    r.content,
    /^\[arquivo com 50 linhas .* mostrando linhas 10–12\. Continue com offset=13\.\]\n10\tlinha 10\n11\tlinha 11\n12\tlinha 12$/
  )
  const whole = await runLocalTool(
    'skill_read',
    { name: 'pdf', path: 'scripts/extract.py' },
    ctx(d.skills)
  )
  assert.equal(whole.content, '1\tprint("oi")\n[fim do arquivo · 1 linhas]')
  const abs = await runLocalTool(
    'skill_read',
    { name: 'pdf', path: join(A, 'pdf', 'SKILL.md') },
    ctx(d.skills)
  )
  assert.equal(abs.status, 'ok')
  for (const p of [
    '../comum/SKILL.md',
    '../../../outside/segredo.txt',
    join(OUTSIDE, 'segredo.txt'),
    'fuga/segredo.txt'
  ]) {
    const x = await runLocalTool('skill_read', { name: 'pdf', path: p }, ctx(d.skills))
    assert.equal(x.status, 'error', p)
    assert.match(x.content, /acesso negado — .* fora da pasta da skill "pdf"/, p)
    assert.ok(!x.content.includes('SEGREDO'))
  }
  const missing = await runLocalTool('skill_read', { name: 'pdf', path: 'nao.md' }, ctx(d.skills))
  assert.match(missing.content, /^Erro: caminho não encontrado/)
  const dirErr = await runLocalTool('skill_read', { name: 'pdf', path: 'scripts' }, ctx(d.skills))
  assert.match(dirErr.content, /é um diretório/)
  const nf = await runLocalTool('skill_read', { name: 'x', path: 'a' }, ctx(d.skills))
  assert.match(nf.content, /não encontrada/)
})

test('listSkillFiles: SKILL.md primeiro, ocultas/.git ignoradas', async () => {
  const dir = skill(TMP, 'lf', 'name: lf\ndescription: d', 'x', {
    'a.txt': '1',
    '.git/HEAD': 'x',
    '.oculto/x': 'y',
    'node_modules/m.js': 'z'
  })
  const r = await listSkillFiles(dir)
  assert.deepEqual(
    r.files.map((f) => f.path),
    ['SKILL.md', 'a.txt']
  )
})

test('sandbox: pastas das skills montadas só leitura depois do /tmp privado; dentro da raiz não', () => {
  const [cmd, argv] = shellArgv('/bin/bash', '-c', 'ls', true, '/r', [
    '/tmp/skills/pdf',
    '/r/.claude/skills/x'
  ])
  assert.equal(cmd, 'bwrap')
  const s = argv.join(' ')
  assert.match(s, /--tmpfs \/tmp --ro-bind \/tmp\/skills\/pdf \/tmp\/skills\/pdf --bind \/r \/r/)
  assert.ok(!s.includes('/r/.claude'))
  assert.deepEqual(shellArgv('/bin/bash', '-c', 'ls', false, '/r', ['/x']), [
    '/bin/bash',
    ['-c', 'ls']
  ])
})

// ---------------- request ----------------

test('definições: 3 tools fixas, fora de TOOL_NAMES, sem nomes de skills', () => {
  assert.deepEqual(SKILL_TOOL_NAMES, ['list_skills', 'skill_load', 'skill_read'])
  for (const n of SKILL_TOOL_NAMES) {
    assert.ok(!TOOL_NAMES.includes(n))
    assert.ok(TOOL_LABELS[n])
    assert.equal(TOOL_DEFINITIONS[n].function.name, n)
  }
  assert.ok(!JSON.stringify(SKILL_TOOL_NAMES.map((n) => TOOL_DEFINITIONS[n])).includes('pdf-tools'))
})

test('request: tools só do celular (§4.3.6) ficam na lista do chat mas nunca vão do computador', () => {
  const s0 = { depth: 0, model: 'm' } as any
  const tools = ['read_file', 'get_location', 'web_search', 'nearby_places', 'mcp_futura']
  // nativas + texto das tools no system prompt (gerado das disponíveis)
  const chat = chatWith(undefined, { enabledTools: tools, toolsInPrompt: true })
  assert.deepEqual(availableTools(chat, s0), ['read_file', 'web_search'])
  const body = buildRequest(chat, s0, [], provider, env).body as any
  assert.deepEqual(
    body.tools.map((t: any) => t.function.name),
    ['read_file', 'web_search']
  )
  const sys = textOf(body.messages[0].content)
  assert.ok(sys.includes('web_search') && !/get_location|nearby_places|mcp_futura/.test(sys))
  // modo texto (sem campo tools): idem
  const txt = buildRequest(
    chatWith(undefined, { enabledTools: tools, toolsInPrompt: true, nativeTools: false }),
    s0,
    [],
    provider,
    env
  ).body as any
  assert.equal(txt.tools, undefined)
  assert.ok(!/get_location|nearby_places/.test(textOf(txt.messages[0].content)))
  // padrão do app (todas, inclusive as do celular): o computador manda só as dele
  const def = chatWith(undefined, { enabledTools: DEFAULT_CHAT_CONFIG('/w').enabledTools })
  const names = (buildRequest(def, s0, [], provider, env).body as any).tools.map(
    (t: any) => t.function.name
  )
  assert.ok(names.includes('shell') && !names.includes('get_location'))
})

test('request: skills desligadas → nada (sem prompt, sem tools); ligadas → prompt de apoio + tools no fim', () => {
  const s0 = { depth: 0, model: 'm' } as any
  const off = buildRequest(chatWith(undefined), s0, [], provider, env).body as any
  assert.ok(!(off.tools ?? []).some((t: any) => SKILL_TOOL_NAMES.includes(t.function.name)))
  assert.ok(!textOf(off.messages[0].content).includes('list_skills'))
  const offExplicit = buildRequest(
    chatWith(on({ enabled: false, subagents: true })),
    s0,
    [],
    provider,
    env
  ).body as any
  assert.deepEqual(
    offExplicit.tools.map((t: any) => t.function.name),
    ['read_file', 'shell']
  )

  const body = buildRequest(chatWith(on()), s0, [], provider, env).body as any
  assert.deepEqual(
    body.tools.map((t: any) => t.function.name),
    ['read_file', 'shell', 'list_skills', 'skill_load', 'skill_read']
  )
  const sys = textOf(body.messages[0].content)
  assert.ok(sys.endsWith(`\n\n${DEFAULT_SKILLS_SUPPORT_PROMPT}`))
  // sem prompt de apoio: só as tools
  const noSupport = buildRequest(
    chatWith(on({ supportPrompt: { enabled: false, text: null } })),
    s0,
    [],
    provider,
    env
  ).body as any
  assert.ok(!textOf(noSupport.messages[0].content).includes('list_skills'))
  assert.equal(noSupport.tools.length, 5)
  // texto personalizado
  assert.equal(
    skillsSupportPrompt(chatWith(on({ supportPrompt: { enabled: true, text: 'USE SKILLS' } })), s0),
    'USE SKILLS'
  )
})

test('request: subagentes só com skills.subagents (mesmas tools + prompt)', () => {
  const s1 = { depth: 1, model: 'm' } as any
  const no = buildRequest(chatWith(on()), s1, [], provider, env).body as any
  assert.ok(!(no.tools ?? []).some((t: any) => t.function.name === 'list_skills'))
  assert.ok(!textOf(no.messages[0]?.content).includes('list_skills'))
  const yes = buildRequest(chatWith(on({ subagents: true })), s1, [], provider, env).body as any
  assert.ok(yes.tools.some((t: any) => t.function.name === 'skill_read'))
  assert.ok(textOf(yes.messages[0].content).includes(DEFAULT_SKILLS_SUPPORT_PROMPT))
  assert.deepEqual(
    availableTools(chatWith(on({ subagents: true })), { depth: 2 }).slice(-3),
    SKILL_TOOL_NAMES
  )
})

test('request: modo texto (sem tools nativas) inclui as tools de skills no texto das tools', () => {
  const chat = chatWith(on(), { nativeTools: false, toolsInPrompt: true })
  const body = buildRequest(chat, { depth: 0, model: 'm' } as any, [], provider, env).body as any
  assert.equal(body.tools, undefined)
  assert.ok(textOf(body.messages[0].content).includes('skill_load'))
})

// ---------------- invocação manual ----------------

test('invocação manual: part <skill> exato, `_skill` privado removido na request (openai e anthropic)', async () => {
  const d = await discoverSkills({ settings: settings(), cwd: ROOT, home: HOME })
  const pdf = findSkill(d.skills, 'pdf')!
  const raw = '---\r\nname: pdf\r\ndescription: x\r\n---\r\n# PDF\r\n\r\n'
  const part = manualSkillPart(pdf, raw) as any
  const expected = `<skill name="pdf" path="${pdf.dir}">\n---\nname: pdf\ndescription: x\n---\n# PDF\n</skill>`
  assert.equal(part.text, expected)
  assert.deepEqual(part._skill, { name: 'pdf', path: pdf.dir })
  assert.equal(skillBlockBody(part.text), '---\nname: pdf\ndescription: x\n---\n# PDF')
  assert.equal(skillBlock('a"b', '/p<', 'c'), '<skill name="a&quot;b" path="/p&lt;">\nc\n</skill>')

  const content = buildUserContent('use a skill', [], [part]) as any[]
  assert.equal(content.length, 2)
  assert.equal(content[0], part)
  assert.deepEqual(content[1], { type: 'text', text: 'use a skill' })
  const msg: any = {
    id: 'u1',
    sessionId: 's1',
    seq: 1,
    message: { role: 'user', content },
    meta: {},
    createdAt: 0
  }
  assert.equal(contentText(content), 'use a skill')
  assert.deepEqual(messageSkills(msg.message), [{ name: 'pdf', path: pdf.dir }])
  // edição: o part da skill fica intacto
  const edited: any = withText(msg.message, 'novo texto')
  assert.equal(edited.content[0], part)
  assert.equal(edited.content[1].text, 'novo texto')

  const chat = chatWith(on(), { cacheEnabled: true })
  const body = buildRequest(chat, { depth: 0, model: 'm' } as any, [msg], provider, env).body as any
  const sent = body.messages[1].content
  assert.equal(JSON.stringify(body).includes('"_skill"'), false)
  assert.deepEqual(sent[0], { type: 'text', text: expected })
  assert.deepEqual(sent[1], {
    type: 'text',
    text: 'use a skill',
    cache_control: { type: 'ephemeral' }
  })
  // o banco não muda
  assert.ok(msg.message.content[0]._skill)
  const anth = buildRequest(
    chat,
    { depth: 0, model: 'claude-haiku-4-5' } as any,
    [msg],
    { ...provider, kind: 'anthropic' },
    env
  ).body as any
  assert.equal(JSON.stringify(anth).includes('"_skill"'), false)
  assert.ok(JSON.stringify(anth.messages).includes(JSON.stringify(expected).slice(1, 40)))
  // só a skill (sem texto): o breakpoint cai no part da skill
  const only: any = { ...msg, message: { role: 'user', content: buildUserContent('', [], [part]) } }
  const b2 = buildRequest(chat, { depth: 0, model: 'm' } as any, [only], provider, env).body as any
  assert.deepEqual(b2.messages[1].content, [
    { type: 'text', text: expected, cache_control: { type: 'ephemeral' } }
  ])
  // compactação encurtada: só o nome
  const asst: any = {
    id: 'a1',
    sessionId: 's1',
    seq: 2,
    message: { role: 'assistant', content: 'ok' },
    meta: {},
    createdAt: 0
  }
  const comp = buildCompactionRequest(
    chat,
    { id: 's1', depth: 0, model: 'm' } as any,
    [msg, asst],
    provider,
    'RESUMA',
    { mode: 'trimmed', window: null },
    env
  )
  assert.ok(JSON.stringify(comp.body).includes('[skill carregada: pdf]'))
  assert.ok(!JSON.stringify(comp.body).includes('"_skill"'))
})

test('invocação manual: corte no limite; erros legíveis (desligadas, inexistente, leitura)', async () => {
  const d = await discoverSkills({ settings: settings(), cwd: ROOT, home: HOME })
  const pdf = findSkill(d.skills, 'pdf')!
  const huge = manualSkillPart(pdf, 'x'.repeat(250_000)) as any
  assert.equal(huge._skill.truncated, true)
  assert.match(huge.text, /SKILL\.md cortado: mostrando 200\.000 de 250\.000/)
  const read = async (f: string): Promise<string> => `conteúdo de ${f}`
  const parts = (await resolveManualSkills(
    ['pdf', 'pdf'],
    { skills: on() },
    d.skills,
    read
  )) as any[]
  assert.equal(parts.length, 1)
  assert.ok(parts[0].text.includes(`conteúdo de ${pdf.file}`))
  assert.deepEqual(await resolveManualSkills([], { skills: on() }, d.skills, read), [])
  await assert.rejects(
    resolveManualSkills(['pdf'], { skills: undefined }, d.skills, read),
    /desligadas neste chat/
  )
  await assert.rejects(
    resolveManualSkills(['nada'], { skills: on() }, d.skills, read),
    /Skill "nada" não está disponível/
  )
  await assert.rejects(
    resolveManualSkills(['pdf'], { skills: on() }, d.skills, async () => {
      throw Object.assign(new Error('x'), { code: 'EACCES' })
    }),
    /Não foi possível ler a skill "pdf" .*EACCES.*não foi enviada/
  )
  await assert.rejects(resolveManualSkills('pdf', { skills: on() }, d.skills, read), /inválida/)
})

test('cards: resumo das tools de skills', () => {
  assert.equal(skillToolSummary('list_skills', { query: 'pdf' }), '"pdf"')
  assert.equal(skillToolSummary('skill_load', { name: 'pdf' }), 'pdf')
  assert.equal(
    skillToolSummary('skill_read', { name: 'pdf', path: 'a.md', offset: 5, limit: 10 }),
    'pdf/a.md · linhas 5+10'
  )
})
