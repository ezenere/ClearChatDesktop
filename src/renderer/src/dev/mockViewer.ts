// Mock do visualizador de arquivos (VITE_CLEAR_MOCK): chat "Relatório trimestral de vendas" em que
// o assistente apresentou arquivos com present_file (md com título+descrição, png só com descrição,
// zip só com título — tipo sem prévia — e, numa 2ª chamada, txt sem nenhum dos dois) + a API
// `viewer` (bytes falsos: data URL para a imagem, textos fixos). Usado por e2e/file-viewer-ui.spec.ts.
import type {
  ChatConfig,
  Chat,
  PresentedFile,
  Session,
  StoredMessage,
  ViewerKind
} from '@shared/types'
import type { ClearApi, ViewerFile } from '@shared/ipc'
import { classifyFileAction } from '@shared/fileActions'
import { mockBrokenVideoUrl, mockVideoUrl } from './mockVideo'
import {
  codeLanguage,
  detectViewerKind,
  fileNameOf,
  viewerMime,
  viewerTypeLabel
} from '@shared/fileViewer'

export const VIEWER_CHAT_ID = 'cpf'
export const VIEWER_SESSION_ID = 'spf'

const CHART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#14141a"/><g fill="#8b5cf6"><rect x="60" y="200" width="70" height="120"/><rect x="170" y="150" width="70" height="170"/><rect x="280" y="110" width="70" height="210"/><rect x="390" y="70" width="70" height="250"/></g><text x="60" y="50" fill="#e6e6ea" font-family="sans-serif" font-size="24">Vendas por trimestre</text></svg>`
const CHART_URL = `data:image/svg+xml;base64,${btoa(CHART_SVG)}`

const REPORT_MD = `# Relatório trimestral de vendas

As vendas cresceram **18%** no trimestre, puxadas pela região Sul.

| Região | T1 | T2 | Variação |
|---|---:|---:|---:|
| Sul | 1.240 | 1.610 | +30% |
| Sudeste | 3.900 | 4.300 | +10% |
| Nordeste | 870 | 950 | +9% |

## Próximos passos

- Revisar a meta do Sudeste
- Repetir a campanha do Sul no Nordeste

\`\`\`ts
const crescimento = (t2 - t1) / t1
\`\`\`
`

const DEPLOY_SH =
  '#!/usr/bin/env bash\nset -euo pipefail\n\nnpm run build\nrsync -a dist/ servidor:/srv/vendas/\necho "publicado"\n'

/** Sistema simulado (`?platform=win32|darwin|linux`; padrão linux) — capabilities e ações por tipo. */
export function mockPlatform(): string {
  try {
    return new URLSearchParams(location.search).get('platform') || 'linux'
  } catch {
    return 'linux'
  }
}

const NOTES_TXT =
  'Notas da reunião\n\n- dados extraídos do ERP em 30/09\n- valores em milhares de reais\n'

const SIZES: Record<string, number> = {
  'relatorio.md': REPORT_MD.length,
  'grafico-vendas.png': 48_213,
  'dados-brutos.zip': 2_481_920,
  'notas.txt': NOTES_TXT.length,
  'deploy.sh': DEPLOY_SH.length,
  'demo.webm': 3563,
  'gravacao.mkv': 64
}

const kindOf = (name: string): ViewerKind =>
  name.endsWith('.png') ? 'image' : detectViewerKind(name, new TextEncoder().encode('texto'))

/** URL do arquivo no mock: imagem → SVG; vídeo → blob (demo.webm toca; gravacao.mkv não). */
const mockUrl = (kind: ViewerKind, name: string, token: string): string =>
  kind === 'image'
    ? CHART_URL
    : kind === 'video'
      ? name === 'demo.webm'
        ? mockVideoUrl()
        : mockBrokenVideoUrl()
      : `clearchat-file://${token}/${encodeURIComponent(name)}`

/** Seeds do chat com present_file (chamado pelo mockApi). */
export function seedViewerScenario(o: {
  home: string
  cfg: ChatConfig
  chats: Chat[]
  sessions: Session[]
  messages: StoredMessage[]
  files: Record<string, { name: string; isDir: boolean; size: number }[]>
  msg: (
    sessionId: string,
    message: StoredMessage['message'],
    meta?: StoredMessage['meta'],
    createdAt?: number
  ) => StoredMessage
}): void {
  const root = `${o.home}/projetos/vendas`
  const now = Date.now()
  o.chats.push({
    id: VIEWER_CHAT_ID,
    title: 'Relatório trimestral de vendas',
    config: { ...o.cfg, cwd: root },
    mainSessionId: VIEWER_SESSION_ID,
    createdAt: now - 600_000,
    updatedAt: now - 30_000
  })
  o.sessions.push({
    id: VIEWER_SESSION_ID,
    chatId: VIEWER_CHAT_ID,
    parentSessionId: null,
    parentToolCallId: null,
    depth: 0,
    model: o.cfg.model,
    title: 'Principal',
    task: null,
    status: 'idle',
    createdAt: now - 600_000
  })
  o.files[root] = [
    { name: 'relatorio.md', isDir: false, size: SIZES['relatorio.md'] },
    { name: 'grafico-vendas.png', isDir: false, size: SIZES['grafico-vendas.png'] },
    { name: 'dados-brutos.zip', isDir: false, size: SIZES['dados-brutos.zip'] },
    { name: 'notas.txt', isDir: false, size: SIZES['notas.txt'] },
    { name: 'demo.webm', isDir: false, size: SIZES['demo.webm'] },
    { name: 'gravacao.mkv', isDir: false, size: SIZES['gravacao.mkv'] }
  ]
  const file = (name: string, extra: Partial<PresentedFile> = {}): PresentedFile => ({
    path: `${root}/${name}`,
    name,
    size: SIZES[name],
    kind: kindOf(name),
    ...extra
  })
  const first: PresentedFile[] = [
    file('relatorio.md', {
      title: 'Relatório do trimestre',
      description: 'Resumo das vendas por região, com a variação T1 → T2.'
    }),
    file('grafico-vendas.png', { description: 'Gráfico de barras das vendas por trimestre.' }),
    file('dados-brutos.zip', { title: 'Dados brutos (ERP)' })
  ]
  const args1 = {
    files: first.map((f) => ({
      path: f.name,
      ...(f.title ? { title: f.title } : {}),
      ...(f.description ? { description: f.description } : {})
    }))
  }
  o.messages.push(
    o.msg(
      VIEWER_SESSION_ID,
      { role: 'user', content: 'Gere o relatório trimestral de vendas com um gráfico.' },
      {},
      now - 120_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      {
        role: 'assistant',
        content: 'Pronto — gerei o relatório, o gráfico e o pacote com os dados brutos:',
        tool_calls: [
          {
            id: 'tpf1',
            type: 'function',
            function: { name: 'present_file', arguments: JSON.stringify(args1) }
          }
        ]
      },
      { model: o.cfg.model, usage: { promptTokens: 5200, completionTokens: 140 } },
      now - 100_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      {
        role: 'tool',
        tool_call_id: 'tpf1',
        content: 'Apresentado ao usuário: relatorio.md, grafico-vendas.png, dados-brutos.zip'
      },
      { toolStatus: 'ok', presentFiles: { files: first } },
      now - 99_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      {
        role: 'assistant',
        content: 'E as notas da reunião que usei como fonte:',
        tool_calls: [
          {
            id: 'tpf2',
            type: 'function',
            function: {
              name: 'present_file',
              arguments: JSON.stringify({ files: [{ path: 'notas.txt' }] })
            }
          }
        ]
      },
      { model: o.cfg.model, usage: { promptTokens: 5400, completionTokens: 40 } },
      now - 60_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      { role: 'tool', tool_call_id: 'tpf2', content: 'Apresentado ao usuário: notas.txt' },
      { toolStatus: 'ok', presentFiles: { files: [file('notas.txt')] } },
      now - 59_000
    ),
    o.msg(
      VIEWER_SESSION_ID,
      { role: 'assistant', content: 'Quer que eu envie o resumo por e-mail também?' },
      { model: o.cfg.model, usage: { promptTokens: 5500, completionTokens: 20 } },
      now - 58_000
    )
  )
}

/** API `viewer` do mock: concessões em memória; chamadas de SO ficam em window.__mockViewerCalls. */
export function createMockViewer(o: {
  messages: () => StoredMessage[]
  delay: <T>(v: T, ms?: number) => Promise<T>
}): Omit<ClearApi['viewer'], 'saveBytes' | 'openBytes' | 'runBytes'> {
  // mensagens do mock + as que os E2E injetam por evento (só existem no store)
  const all = (): StoredMessage[] => {
    const st = (
      window as unknown as {
        __clearStore?: { getState(): { messages: Record<string, StoredMessage[]> } }
      }
    ).__clearStore?.getState()
    return [...o.messages(), ...Object.values(st?.messages ?? {}).flat()]
  }
  const tokens = new Map<string, string>()
  const calls: string[] = []
  ;(window as unknown as { __mockViewerCalls?: string[] }).__mockViewerCalls = calls
  const grant = (path: string): ViewerFile => {
    const name = fileNameOf(path)
    const token = [...path]
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
      .toString(16)
      .padStart(32, '0')
    tokens.set(token, path)
    const kind = kindOf(name)
    const language = kind === 'code' ? codeLanguage(name) : undefined
    return {
      token,
      url: mockUrl(kind, name, token),
      path,
      name,
      size: SIZES[name] ?? 1834,
      mtime: Date.now(),
      kind,
      mime: viewerMime(kind, name),
      ...(language ? { language } : {}),
      typeLabel:
        kind === 'binary' && name.endsWith('.zip')
          ? 'Arquivo ZIP (ou docx/xlsx/jar)'
          : viewerTypeLabel(kind, name),
      action: classifyFileAction(name, mockPlatform())
    }
  }
  return {
    open: (target) => {
      if (target.source === 'browse')
        return o.delay({ ok: true as const, file: grant(target.path) })
      const f = all().find((m) => m.id === target.messageId)?.meta.presentFiles?.files[target.index]
      if (!f || f.error)
        return o.delay({
          ok: false as const,
          reason: 'invalid' as const,
          message: 'Arquivo não encontrado nesta conversa.'
        })
      return o.delay({ ok: true as const, file: grant(f.path) })
    },
    check: (_chatId, messageId) =>
      o.delay(
        (all().find((m) => m.id === messageId)?.meta.presentFiles?.files ?? []).map(() => ({
          ok: true as const
        }))
      ),
    readText: (token) => {
      const name = fileNameOf(tokens.get(token) ?? '')
      const content =
        name === 'relatorio.md'
          ? REPORT_MD
          : name === 'notas.txt'
            ? NOTES_TXT
            : name === 'deploy.sh'
              ? DEPLOY_SH
              : `// ${name}\nexport const exemplo = 42\n`
      return o.delay({ content, truncated: false, size: content.length })
    },
    openExternal: async (token) => {
      calls.push(`open:${tokens.get(token)}`)
    },
    showInFolder: async (token) => {
      calls.push(`reveal:${tokens.get(token)}`)
    },
    // "Executar…": nada roda no mock — só registra (o main real confirma num diálogo nativo)
    run: async (token) => {
      calls.push(`run:${tokens.get(token)}`)
      return true
    }
  }
}

// ---------------- controle remoto: arquivos do host (sync.remoteListDir / remoteReadFile) ----------------

/** Raiz do chat no host simulado ("PC do escritório"). */
export const MOCK_HOST_ROOT = '/srv/escritorio/vendas'

/** PDF mínimo válido (1 página, texto) com a tabela xref correta. */
function tinyPdf(text: string): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const stream = `BT /F1 22 Tf 30 110 Td (${text}) Tj ET`
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

function pseudoRandom(n: number, header: number[] = []): Uint8Array {
  const b = new Uint8Array(n)
  let x = 0x9e3779b9
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    b[i] = x & 0xff
  }
  b.set(header)
  return b
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * Sistema de arquivos do host simulado + as chamadas do controle remoto (main → sync). Respeita a
 * raiz/confinamento como o host real (fora → negado), devolve em pedaços de até 512 KiB com atraso
 * (o painel mostra o progresso) e "Host offline" quando o store diz que o host caiu. Chamadas em
 * window.__mockRemoteCalls (read:<nome>:<offset>:<length>, list:<pasta>) e as de SO em
 * window.__mockViewerCalls (save:<nome>:<bytes>, open-temp:<nome>:<bytes>,
 * run-temp:<nome>:<bytes> — nada roda de verdade).
 */
export function createMockRemoteFs(o: { delay: <T>(v: T, ms?: number) => Promise<T> }): {
  remoteListDir: ClearApi['sync']['remoteListDir']
  remoteReadFile: ClearApi['sync']['remoteReadFile']
  saveBytes: ClearApi['viewer']['saveBytes']
  openBytes: ClearApi['viewer']['openBytes']
  runBytes: ClearApi['viewer']['runBytes']
} {
  const R = MOCK_HOST_ROOT
  const mtime = Date.now() - 3_600_000
  const PNG = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    ),
    (c) => c.charCodeAt(0)
  )
  const longLog = Array.from(
    { length: 52_000 },
    (_, i) => `${String(i + 1).padStart(6, '0')} INFO pedido processado em ${(i * 7) % 300} ms`
  ).join('\n')
  const files = new Map<string, Uint8Array>([
    [`${R}/relatorio-final.pdf`, tinyPdf('Relatorio final - PC do escritorio')],
    [`${R}/grafico.png`, PNG],
    [
      `${R}/pagina.html`,
      enc(
        '<!doctype html><html><head><title>Original</title></head><body><h1>Painel do escritório</h1>' +
          '<img src="https://example.com/rastreio.png" alt="externo">' +
          '<script>document.title = "script rodou"</script></body></html>'
      )
    ],
    [`${R}/backup.zip`, pseudoRandom(3 * 1024 * 1024 + 4321, [0x50, 0x4b, 0x03, 0x04])],
    [`${R}/log-grande.txt`, enc(longLog)],
    [`${R}/dados/notas.md`, enc('# Notas do escritório\n\nTudo certo com os dados.\n')],
    // executável de Windows (cabeçalho MZ): no Linux só "Salvar como…" + nota
    [`${R}/instalar.exe`, pseudoRandom(96 * 1024, [0x4d, 0x5a, 0x90, 0x00])],
    [`${R}/atualizar.sh`, enc('#!/bin/sh\necho "atualizando o escritório"\n')],
    ['/srv/escritorio/segredo.txt', enc('fora da raiz')]
  ])
  const dirs = new Set([R, `${R}/dados`])
  const calls: string[] = []
  ;(window as unknown as { __mockRemoteCalls?: string[] }).__mockRemoteCalls = calls
  const osCalls = (): string[] => {
    const w = window as unknown as { __mockViewerCalls?: string[] }
    return (w.__mockViewerCalls ??= [])
  }
  const hostOffline = (chatId: string): boolean => {
    const st = (
      window as unknown as {
        __clearStore?: { getState(): { chatHosts: Record<string, { mode?: string }> } }
      }
    ).__clearStore?.getState()
    return st?.chatHosts[chatId]?.mode === 'host-offline'
  }
  const offline = {
    ok: false as const,
    reason: 'host-offline' as const,
    message: 'O host (PC do escritório) está offline.',
    deviceName: 'PC do escritório'
  }
  const inside = (p: string): boolean => p === R || p.startsWith(`${R}/`)
  return {
    remoteListDir: (chatId, path) => {
      const dir = path ? path.replace(/\/+$/, '') : R
      calls.push(`list:${dir}`)
      if (hostOffline(chatId)) return o.delay(offline)
      if (!inside(dir))
        return o.delay({
          ok: false as const,
          reason: 'denied' as const,
          message: 'Acesso negado: a pasta fica fora do diretório raiz do chat.'
        })
      if (!dirs.has(dir))
        return o.delay({
          ok: false as const,
          reason: 'missing' as const,
          message: 'Pasta não encontrada.'
        })
      const entries = [
        ...[...dirs]
          .filter((d) => d !== dir && d.slice(0, d.lastIndexOf('/')) === dir)
          .map((d) => ({ name: d.slice(d.lastIndexOf('/') + 1), kind: 'dir' as const, mtime })),
        ...[...files.entries()]
          .filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir)
          .map(([p, b]) => ({
            name: p.slice(p.lastIndexOf('/') + 1),
            kind: 'file' as const,
            size: b.length,
            mtime
          }))
      ]
      return o.delay({ ok: true as const, dir, root: R, confine: true, truncated: false, entries })
    },
    remoteReadFile: (chatId, path, offset, length) => {
      calls.push(`read:${fileNameOf(path)}:${offset}:${length}`)
      if (hostOffline(chatId)) return o.delay(offline)
      if (!inside(path))
        return o.delay({
          ok: false as const,
          reason: 'denied' as const,
          message: 'Acesso negado: o arquivo fica fora do diretório raiz do chat.'
        })
      const b = files.get(path)
      if (!b)
        return o.delay({
          ok: false as const,
          reason: 'missing' as const,
          message: 'Arquivo não encontrado.'
        })
      const data = b.slice(offset, offset + Math.min(length, 512 * 1024))
      return o.delay({ ok: true as const, size: b.length, mtime, offset, data }, 140)
    },
    saveBytes: async (name, bytes) => {
      osCalls().push(`save:${name}:${bytes.length}`)
      return true
    },
    openBytes: async (name, bytes) => {
      osCalls().push(`open-temp:${name}:${bytes.length}`)
    },
    runBytes: async (_chatId, name, bytes) => {
      osCalls().push(`run-temp:${name}:${bytes.length}`)
      return true
    }
  }
}
