// Navegação lateral de Configurações (lógica PURA — sem React/DOM; testada em e2e/settingsNav.test.ts):
// grupos e ordem das abas, índice de palavras-chave por aba e a busca "Procurar".
import type { SettingsTab, SettingsTarget } from '../store'

/** Sub-tela de uma aba que a busca acha (ex.: Áudio → "Modelos locais"). */
export interface SettingsNavSub {
  /** Destino de `setSettingsOpen` (ex.: 'audio:local'). */
  target: Exclude<SettingsTarget, SettingsTab>
  label: string
  keywords: string[]
}

export interface SettingsNavItem {
  id: SettingsTab
  /** Rótulo (e nome acessível do botão — os testes e2e clicam por ele, `exact: true`). */
  label: string
  /** Termos das configurações dentro da aba (minúsculas; acentos são ignorados na busca). */
  keywords: string[]
  /** Sub-telas da aba com termos próprios (casar um deles abre a sub-tela). */
  subs?: SettingsNavSub[]
}

export interface SettingsNavGroup {
  id: 'general' | 'agent' | 'connections'
  label: string
  items: SettingsNavItem[]
}

// Geral: o que vale para o uso do dia a dia (padrões do Novo chat, personas escolhidas nele, voz).
// Agente: o que o agente pode fazer e saber (aprovações das tools, memória, skills, web).
// Conexões: com quem o app fala (endpoints de modelo/voz e a conta de sync).
export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    id: 'general',
    label: 'Geral',
    items: [
      {
        id: 'defaults',
        label: 'Novos chats',
        keywords: [
          'persona padrão',
          'modelo padrão',
          'system prompt',
          'prompt do sistema',
          'pasta de trabalho',
          'diretório',
          'título automático',
          'modelo para o título',
          'prompt de geração',
          'limite de tokens',
          'padrões'
        ]
      },
      {
        id: 'presets',
        label: 'Personas',
        keywords: [
          'preset',
          'perfil',
          'nova persona',
          'duplicar',
          'ícone',
          'modelo',
          'raciocínio',
          'parâmetros',
          'system prompt',
          'tools',
          'ferramentas',
          'diretório raiz',
          'sandbox',
          'assinatura',
          'compactação',
          'janela de contexto',
          'voz da persona'
        ]
      },
      {
        id: 'audio',
        label: 'Áudio',
        keywords: [
          'microfone',
          'ditado',
          'transcrição',
          'voz',
          'fala',
          'tts',
          'stt',
          'chamada de voz',
          'push-to-talk',
          'ptt',
          'silêncio',
          'idioma',
          'preâmbulos',
          'fillers',
          'frases de demora',
          'elevenlabs',
          'openrouter',
          'parâmetros',
          'formato de saída',
          'estabilidade',
          'velocidade da voz'
        ],
        subs: [
          {
            target: 'audio:local',
            label: 'Modelos locais',
            keywords: [
              'modelos locais',
              'offline',
              'gpu',
              'modo avançado',
              'kokoro',
              'whisper',
              'whisper.cpp',
              'vosk',
              'nemotron',
              'xtts',
              'omnivoice',
              'vibevoice',
              'qwen3-tts',
              'runtime',
              'minhas vozes',
              'baixar modelo'
            ]
          }
        ]
      }
    ]
  },
  {
    id: 'agent',
    label: 'Agente',
    items: [
      {
        id: 'approvals',
        label: 'Aprovações',
        keywords: [
          'whitelist',
          'blacklist',
          'listas',
          'smart-approve',
          'juiz',
          'sempre permitir',
          'perguntar',
          'comandos',
          'processos',
          'terminal',
          'shell',
          'páginas',
          'busca web',
          'escrever arquivo',
          'editar arquivo',
          'enviar para chat',
          'subagente',
          'delegar',
          'gravar memória',
          'descrição do ambiente',
          'resumidor',
          'segurança',
          'permissões'
        ]
      },
      {
        id: 'memory',
        label: 'Memórias',
        keywords: [
          'memória',
          'coleções',
          'categorias',
          'detalhes',
          'resumo',
          'tópicos',
          'fixar',
          'sempre carregar',
          'lembrar'
        ]
      },
      {
        id: 'skills',
        label: 'Skills',
        keywords: [
          'habilidades',
          'skill.md',
          'pastas de skills',
          'adicionar pasta',
          'reescanear',
          'precedência',
          'abrir pasta'
        ]
      },
      {
        id: 'web',
        label: 'Pesquisa na web',
        keywords: [
          'buscadores',
          'busca',
          'search',
          'internet',
          'tavily',
          'brave',
          'duckduckgo',
          'chave de api',
          'resultados',
          'profundidade',
          'intervalo entre pesquisas',
          'user-agent'
        ]
      }
    ]
  },
  {
    id: 'connections',
    label: 'Conexões',
    items: [
      {
        id: 'providers',
        label: 'Provedores',
        keywords: [
          'api key',
          'chave de api',
          'base url',
          'endpoint',
          'openrouter',
          'openai',
          'anthropic',
          'elevenlabs',
          'headers',
          'testar conexão',
          'adicionar provedor',
          'servidor local'
        ]
      },
      {
        id: 'account',
        label: 'Conta',
        keywords: [
          'sync',
          'sincronização',
          'sincronizar',
          'nuvem',
          'login',
          'entrar',
          'criar conta',
          'servidor',
          'dispositivos',
          'host',
          'senha',
          'chave de recuperação',
          'desbloquear',
          'bloquear',
          'sair'
        ]
      }
    ]
  }
]

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = SETTINGS_NAV.flatMap((g) => g.items)

export function settingsNavItem(id: SettingsTab): SettingsNavItem {
  return SETTINGS_NAV_ITEMS.find((i) => i.id === id) ?? SETTINGS_NAV_ITEMS[0]
}

/** Minúsculas, sem acentos, espaços colapsados. */
export function normalizeSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export interface SettingsNavMatch {
  item: SettingsNavItem
  /** 5 = rótulo começa com a busca, 4 = rótulo contém; 3/2/1 = palavra-chave igual/prefixo/contém. */
  score: number
  /** Palavra-chave que casou quando o rótulo não casou (mostrada sob o item). */
  keyword?: string
  /** A palavra-chave é de uma sub-tela: clicar abre ela (ex.: 'audio:local'). */
  sub?: SettingsNavSub
}

export interface SettingsNavFilter {
  /** Grupos na ordem original, só com os itens que casam (grupos vazios somem). */
  groups: { group: SettingsNavGroup; matches: SettingsNavMatch[] }[]
  /** Melhor resultado (o que o Enter abre): maior `score`; empate → ordem da barra. */
  best: SettingsNavItem | null
  /** Sub-tela do melhor resultado (quando a palavra-chave que casou é dela). */
  bestSub: SettingsNavSub | null
  total: number
}

function matchItem(item: SettingsNavItem, terms: string[]): SettingsNavMatch | null {
  const label = normalizeSearch(item.label)
  // palavras-chave da aba e das sub-telas (o rótulo da sub-tela também vale como palavra-chave)
  const entries: { raw: string; sub?: SettingsNavSub }[] = [
    ...item.keywords.map((raw) => ({ raw })),
    ...(item.subs ?? []).flatMap((sub) => [sub.label, ...sub.keywords].map((raw) => ({ raw, sub })))
  ]
  const keys = entries.map((e) => normalizeSearch(e.raw))
  const hay = [label, ...keys]
  // cada termo precisa aparecer no rótulo ou em alguma palavra-chave (termos em qualquer ordem)
  if (!terms.every((t) => hay.some((h) => h.includes(t)))) return null
  const whole = terms.join(' ')
  if (label.startsWith(whole)) return { item, score: 5 }
  if (terms.every((t) => label.includes(t))) return { item, score: 4 }
  // palavra-chave: igual à busca > começa com ela > contém algum termo
  let best = { score: 0, i: -1 }
  keys.forEach((k, i) => {
    const score =
      k === whole ? 3 : k.startsWith(whole) ? 2 : terms.some((t) => k.includes(t)) ? 1 : 0
    if (score > best.score) best = { score, i }
  })
  const hit = entries[best.i]
  return {
    item,
    score: Math.max(best.score, 1),
    keyword: hit
      ? hit.sub && hit.raw !== hit.sub.label
        ? `${hit.sub.label} · ${hit.raw}`
        : hit.raw
      : undefined,
    ...(hit?.sub ? { sub: hit.sub } : {})
  }
}

/** Filtra a barra lateral pela busca "Procurar" (rótulo + palavras-chave, sem acento/caixa). */
export function filterSettingsNav(query: string): SettingsNavFilter {
  const terms = normalizeSearch(query).split(' ').filter(Boolean)
  const groups = SETTINGS_NAV.map((group) => ({
    group,
    matches: terms.length
      ? group.items.flatMap((it) => matchItem(it, terms) ?? [])
      : group.items.map((item) => ({ item, score: 0 }))
  })).filter((g) => g.matches.length)
  let best: SettingsNavMatch | null = null
  for (const g of groups) for (const m of g.matches) if (!best || m.score > best.score) best = m
  return {
    groups,
    best: terms.length ? (best?.item ?? null) : null,
    bestSub: terms.length ? (best?.sub ?? null) : null,
    total: groups.reduce((n, g) => n + g.matches.length, 0)
  }
}
