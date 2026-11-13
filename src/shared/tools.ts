// Definições das tools no formato OpenAI (`tools: [{ type: 'function', function }]`).
// Compartilhadas: o main as envia na request; o renderer as mostra no (i) de cada tool.
import type { ToolName } from './types'
import { LIMITS, MEMORY_LIMITS as ML } from './limits'
import { ASK_USER_LIMITS as AL } from './askUser'
import { shellDescriptionPrefix, toolShellInfo, type ShellInfoLite } from './shellInfo'
import { PRESENT_FILE_LIMITS as PL } from './fileViewer'
import { DATETIME_CODES } from './datetime'

const shellDescription = (info: ShellInfoLite | null): string => {
  const p = shellDescriptionPrefix(info)
  return `${p}${/[.!]$/.test(p) ? '' : '.'} ${SHELL_DESC_REST}`
}

/** Resto da descrição da tool `shell` (o início diz qual shell — ver shellInfo.ts). */
const SHELL_DESC_REST =
  'O ambiente do shell de login/interativo do usuário (PATH, nvm etc.) já vem carregado. A primeira chamada começa no diretório raiz; o diretório atual (cd) persiste entre chamadas desta sessão. Retorna stdout+stderr e o código de saída; o comando precisa TERMINAR (há tempo limite). Para algo que deve continuar rodando (servidor, emulador, watcher, logcat), use process_start — nunca `&`/nohup aqui. Saída longa vem resumida (início e fim) e fica INTEIRA num arquivo cujo caminho vem no resultado: leia-o em partes com read_file (offset/limit) ou search_files, sem rodar o comando de novo.'

/** Propriedade de JSON Schema (recursiva: arrays de objetos, ex.: ask_user). */
export interface JsonSchemaProp {
  type: string
  description?: string
  enum?: string[]
  items?: JsonSchemaProp
  properties?: Record<string, JsonSchemaProp>
  required?: string[]
  minItems?: number
  maxItems?: number
  additionalProperties?: boolean
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProp>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  type: 'function'
  function: { name: ToolName; description: string; parameters: JsonSchema }
}

export const TOOL_NAMES: ToolName[] = [
  'list_dir',
  'read_file',
  'search_files',
  'find_files',
  'present_file',
  'write_file',
  'edit_file',
  'shell',
  'process_start',
  'process_logs',
  'process_list',
  'process_stop',
  'web_search',
  'browse_url',
  'list_models',
  'delegate_task',
  'get_chat_info',
  'list_chats',
  'send_to_chat',
  'read_history',
  'check_subagents',
  'wait_subagents',
  'cancel_subagent',
  'message_subagent',
  'ask_user',
  'datetime'
]

/**
 * Tools da memória modular (SPEC → Memória). NÃO entram em TOOL_NAMES/enabledTools: a
 * disponibilidade vem de ChatConfig.memory (ligada + algo ativo; escrita só com destino de escrita;
 * subagentes só search/read com `memory.subagents`). Vão no fim da lista de tools, nesta ordem.
 */
export const MEMORY_TOOL_NAMES: ToolName[] = [
  'memory_search',
  'memory_read',
  'memory_write',
  'memory_rewrite',
  'memory_delete'
]
/**
 * Tools de skills (SPEC → Skills). NÃO entram em TOOL_NAMES/enabledTools: disponíveis quando
 * `ChatConfig.skills.enabled` (subagentes: com `skills.subagents`). Só leitura (sem aprovação).
 * Definições estáticas — a lista de skills NUNCA vai nelas (prefixo de cache estável).
 */
export const SKILL_TOOL_NAMES: ToolName[] = ['list_skills', 'skill_load', 'skill_read']

/** Tools de memória que gravam (passam pelo gate de aprovação; nunca para subagentes). */
export const MEMORY_WRITE_TOOLS: ToolName[] = ['memory_write', 'memory_rewrite', 'memory_delete']

/** Rótulos curtos (pt-BR) para a UI. */
export const TOOL_LABELS: Record<ToolName, string> = {
  list_dir: 'Listar pasta',
  read_file: 'Ler arquivo',
  search_files: 'Buscar no conteúdo',
  find_files: 'Encontrar arquivos',
  present_file: 'Apresentar arquivo',
  write_file: 'Escrever arquivo',
  edit_file: 'Editar arquivo',
  shell: 'Terminal (shell)',
  process_start: 'Iniciar processo',
  process_logs: 'Logs do processo',
  process_list: 'Listar processos',
  process_stop: 'Parar processo',
  web_search: 'Pesquisa na web',
  browse_url: 'Abrir URL',
  list_models: 'Listar modelos',
  delegate_task: 'Delegar a subagente',
  get_chat_info: 'Info do chat',
  list_chats: 'Listar chats',
  send_to_chat: 'Enviar para chat',
  read_history: 'Ler histórico',
  check_subagents: 'Ver subagentes',
  wait_subagents: 'Aguardar subagentes',
  cancel_subagent: 'Cancelar subagente',
  message_subagent: 'Mensagem ao subagente',
  ask_user: 'Perguntar ao usuário',
  datetime: 'Data e hora',
  memory_search: 'Buscar memória',
  memory_read: 'Ler memória',
  memory_write: 'Gravar memória',
  memory_rewrite: 'Reescrever memória',
  memory_delete: 'Apagar memória',
  list_skills: 'Listar skills',
  skill_load: 'Carregar skill',
  skill_read: 'Ler arquivo da skill',
  end_call: 'Encerrar chamada',
  search_tool: 'Ler definição de tool'
}

/**
 * Tool da chamada de voz (SPEC → Chamada de voz → end_call): NÃO entra em TOOL_NAMES/enabledTools —
 * só existe nos turnos da chamada (sessão principal), salvo desligada em "O agente pode encerrar a
 * chamada". Sem aprovação (só encerra a chamada, depois de a resposta terminar de tocar).
 */
export const END_CALL_TOOL: ToolName = 'end_call'

/**
 * Tool automática das tools compactadas (protocolo 1.11.0 — @shared/compactTools): vai sempre
 * completa, só quando alguma tool da request vai compacta. NÃO é escolhível (fora de TOOL_NAMES,
 * `enabledTools` e `toolsFull`; leitores a ignoram nessas listas).
 */
export const SEARCH_TOOL: ToolName = 'search_tool'

const def = (
  name: ToolName,
  description: string,
  properties: JsonSchema['properties'],
  required: string[] = []
): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false }
  }
})

const L = LIMITS
const n = (v: number): string => v.toLocaleString('pt-BR')

const MEMORY_CATEGORY_ENUM = ['profile', 'topics', 'areas', 'people', 'preferences']

/** Taxonomia fixa (descrição de memory_write). */
const MEMORY_TAXONOMY =
  'Categorias: profile = quem é o usuário (identidade, profissão, formação, onde vive); topics = hábitos e interesses recorrentes; areas = frentes ativas (projetos, tarefas em andamento, metas); people = pessoas (e animais) da vida do usuário — uma memória por pessoa; preferences = como o usuário quer que o chat se comporte (tom, formato, idioma, o que evitar).'

const MEMORY_OPS_PROP: JsonSchemaProp = {
  type: 'array',
  description:
    'Alterações nos tópicos (fatos curtos), aplicadas em ordem: add (novo tópico em `fact`), remove (`fact` = texto do tópico ou "#n"), replace (`fact` = tópico atual ou "#n", `with` = texto novo).',
  items: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'remove', 'replace'] },
      fact: {
        type: 'string',
        description: 'Tópico (add) ou o tópico atual / "#n" (remove, replace).'
      },
      with: { type: 'string', description: 'replace: texto novo do tópico.' }
    },
    required: ['op', 'fact'],
    additionalProperties: false
  }
}

export const MEMORY_TOOL_DEFINITIONS = {
  memory_search: def(
    'memory_search',
    `Busca nas memórias ativas deste chat (título, resumo e tópicos; sem acento/caixa). Retorna id, categoria, coleção (escrita/leitura), título, resumo e trecho. Use quando o índice não bastar para responder sobre o usuário, pessoas ou projetos, e antes de criar uma memória. Padrão ${ML.searchDefaultResults} resultados (máx. ${ML.searchMaxResults}).`,
    {
      query: { type: 'string', description: 'Palavras a buscar.' },
      category: {
        type: 'string',
        enum: MEMORY_CATEGORY_ENUM,
        description: 'Só esta categoria.'
      },
      collection: { type: 'string', description: 'Só esta coleção (id ou nome).' },
      limit: { type: 'number', description: `Máximo de resultados (máx. ${ML.searchMaxResults}).` }
    },
    ['query']
  ),
  memory_read: def(
    'memory_read',
    `Lê memórias completas (título, resumo, todos os tópicos, coleção, última atualização) pelos ids do índice/busca (ou slugs de [[slug]]). Até ${ML.readMaxIds} por chamada; só memórias de coleções ativas.`,
    {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ids (ou slugs) das memórias.'
      }
    },
    ['ids']
  ),
  memory_write: def(
    'memory_write',
    `Grava um fato durável sobre o usuário. ${MEMORY_TAXONOMY} Sem id → cria na coleção de escrita da categoria; se já existir memória parecida, nada é criado e as candidatas voltam: repita com o id (ou force_new se for outro assunto). Com id → atualiza (só memórias graváveis; memória de coleção só de leitura → memory_rewrite). Discrepância: se o usuário disser algo que contradiz uma memória, corrija-a (replace/remove) em vez de criar outra. Tópicos curtos e factuais (≤ ${ML.factChars} caracteres, ≤ ${ML.maxFacts} por memória); título ≤ ${ML.titleChars}; resumo ≤ ${ML.summaryChars} (uma frase). Cite outra memória com [[slug]].`,
    {
      category: {
        type: 'string',
        enum: MEMORY_CATEGORY_ENUM,
        description: 'Categoria (obrigatória ao criar; ao atualizar vem da memória).'
      },
      id: { type: 'string', description: 'Memória a atualizar (omita para criar).' },
      title: { type: 'string', description: 'Título curto (assunto da memória).' },
      summary: { type: 'string', description: 'Resumo de uma frase (aparece no índice).' },
      ops: MEMORY_OPS_PROP,
      force_new: {
        type: 'boolean',
        description: 'Criar mesmo havendo candidatas parecidas (só se forem outro assunto).'
      }
    }
  ),
  memory_rewrite: def(
    'memory_rewrite',
    'Corrige uma memória de coleção SÓ DE LEITURA: cria uma versão atualizada na coleção de escrita da categoria que a substitui neste chat; a original fica intacta na coleção dela. Em memória gravável equivale a memory_write com id. Passe facts (lista completa nova) ou ops (alterações sobre os tópicos atuais).',
    {
      id: { type: 'string', description: 'Memória a reescrever.' },
      title: { type: 'string', description: 'Novo título (padrão: o atual).' },
      summary: { type: 'string', description: 'Novo resumo (padrão: o atual).' },
      facts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Lista completa nova de tópicos (substitui os atuais).'
      },
      ops: MEMORY_OPS_PROP
    },
    ['id']
  ),
  memory_delete: def(
    'memory_delete',
    'Apaga uma memória gravável (da coleção de escrita da categoria) que ficou errada ou obsoleta. Para corrigir parte dela, prefira memory_write com ops.',
    { id: { type: 'string', description: 'Memória a apagar.' } },
    ['id']
  )
} satisfies Partial<Record<ToolName, ToolDefinition>>

export const SKILL_TOOL_DEFINITIONS = {
  list_skills: def(
    'list_skills',
    'Lista as skills disponíveis neste chat — pacotes de instruções especializadas (SKILL.md + arquivos de referência e scripts) instalados pelo usuário: nome, descrição (o que faz e quando usar) e local. Chame antes de tarefas especializadas para ver se alguma se aplica; depois carregue a escolhida com skill_load.',
    {
      query: {
        type: 'string',
        description: 'Opcional: filtra por termos no nome ou na descrição.'
      }
    }
  ),
  skill_load: def(
    'skill_load',
    'Carrega uma skill: devolve o SKILL.md completo (instruções a seguir à risca), a lista de arquivos da pasta da skill (caminhos relativos e tamanhos) e o caminho absoluto dessa pasta. Leia os arquivos citados com skill_read; rode os scripts da skill com a tool shell usando o caminho absoluto.',
    { name: { type: 'string', description: 'Nome da skill (como em list_skills).' } },
    ['name']
  ),
  skill_read: def(
    'skill_read',
    `Lê um arquivo de dentro da pasta de uma skill (referências, templates, scripts) — mesmo formato e limites de read_file: linhas numeradas "N\tconteúdo", no máximo ${n(L.readDefaultLines)} linhas sem offset/limit. Só alcança arquivos da própria skill.`,
    {
      name: { type: 'string', description: 'Nome da skill.' },
      path: {
        type: 'string',
        description: 'Caminho do arquivo relativo à pasta da skill (ex.: "references/guia.md").'
      },
      offset: { type: 'number', description: 'Linha inicial (1 = primeira linha).' },
      limit: { type: 'number', description: 'Número máximo de linhas a ler.' }
    },
    ['name', 'path']
  )
} satisfies Partial<Record<ToolName, ToolDefinition>>

export const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  list_dir: def(
    'list_dir',
    `Lista arquivos e pastas de um diretório (pastas primeiro, com o tamanho dos arquivos). Caminhos relativos resolvem a partir do diretório raiz da sessão. Mostra no máximo ${n(L.listMaxEntries)} entradas; para árvores grandes prefira find_files / search_files.`,
    { path: { type: 'string', description: 'Diretório a listar (padrão: diretório raiz).' } }
  ),
  read_file: def(
    'read_file',
    `Lê um arquivo de texto — e, se o modelo desta sessão aceitar, imagens (png/jpg/webp/gif) e PDF, que voltam como imagem/documento para você ver (ideal para conferir screenshots que você gerou; imagens grandes são reduzidas). Texto: retorna as linhas numeradas no formato "N\\tconteúdo" e sempre informa o total de linhas. Sem offset/limit devolve o arquivo inteiro se for pequeno; se for grande (mais de ${n(L.readDefaultLines)} linhas ou ~${n(L.readFullMaxChars)} caracteres, limitado também pelo teto de saída do chat), só o início + o total de linhas e como continuar. Com offset/limit lê a faixa pedida (a saída total é limitada; o cabeçalho diz de onde continuar). Linhas com mais de ${n(L.readMaxLineChars)} caracteres são cortadas. Para arquivos grandes, localize o trecho com search_files e leia só a faixa necessária. Também lê as saídas grandes de ferramentas que foram salvas em arquivo (o caminho vem no resultado da ferramenta) e os logs de process_start.`,
    {
      path: {
        type: 'string',
        description: 'Caminho do arquivo (relativo ao diretório raiz ou absoluto).'
      },
      offset: { type: 'number', description: 'Linha inicial (1 = primeira linha).' },
      limit: { type: 'number', description: 'Número máximo de linhas a ler.' }
    },
    ['path']
  ),
  search_files: def(
    'search_files',
    `Busca uma expressão regular no conteúdo dos arquivos (como grep -rn / ripgrep). Retorna linhas "caminho:linha: texto" (caminhos relativos ao diretório raiz). Ignora .git, node_modules, arquivos binários e o que estiver no .gitignore. Padrão ${L.searchDefaultResults} resultados (máx. ${L.searchMaxResults}). Use para localizar trechos antes de ler arquivos grandes.`,
    {
      pattern: { type: 'string', description: 'Expressão regular a buscar.' },
      path: {
        type: 'string',
        description: 'Pasta ou arquivo onde buscar (padrão: diretório raiz).'
      },
      glob: {
        type: 'string',
        description: 'Filtra arquivos por glob (ex.: "*.ts", "src/**/*.py").'
      },
      max_results: {
        type: 'number',
        description: `Máximo de linhas de resultado (padrão ${L.searchDefaultResults}).`
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Ignorar maiúsculas/minúsculas (padrão false).'
      }
    },
    ['pattern']
  ),
  find_files: def(
    'find_files',
    `Encontra arquivos pelo nome usando um glob (ex.: "*.md", "src/**/*.test.ts"). Retorna caminhos relativos ao diretório raiz, ordenados (máx. ${L.findMaxResults}). Ignora .git, node_modules e o que estiver no .gitignore.`,
    {
      glob: {
        type: 'string',
        description: 'Padrão glob. Sem "/", casa com o nome do arquivo em qualquer pasta.'
      },
      path: { type: 'string', description: 'Pasta base (padrão: diretório raiz).' }
    },
    ['glob']
  ),
  present_file: def(
    'present_file',
    `Mostra arquivos ao usuário num visualizador ao lado do chat (Markdown renderizado, HTML, imagens, PDF, código com destaque e texto) e como cards clicáveis na conversa, na posição desta chamada. O primeiro arquivo abre no visualizador; os outros ficam disponíveis nos cards. Use ao terminar de gerar/editar algo que o usuário deve ver (relatório, documento, imagem, gráfico, página, PDF) ou para apontar arquivos relevantes. Só leitura (não altera nada) e o conteúdo NÃO volta para você — o resultado só confirma o que foi apresentado. A prévia de HTML é estática (scripts não rodam, sem rede): para páginas/apps interativos, diga ao usuário para abrir o arquivo no navegador (botão "Abrir no app"). Caminhos relativos resolvem a partir do diretório raiz (mesmas regras de read_file). Até ${PL.maxFiles} arquivos por chamada.`,
    {
      files: {
        type: 'array',
        description: `Arquivos a apresentar, na ordem (1 a ${PL.maxFiles}).`,
        minItems: 1,
        maxItems: PL.maxFiles,
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Caminho do arquivo (relativo ao diretório raiz ou absoluto).'
            },
            title: {
              type: 'string',
              description: 'Título curto para o card (opcional; sem ele aparece o nome do arquivo).'
            },
            description: {
              type: 'string',
              description: 'Uma frase dizendo o que é o arquivo (opcional).'
            }
          },
          required: ['path'],
          additionalProperties: false
        }
      }
    },
    ['files']
  ),
  write_file: def(
    'write_file',
    'Cria ou sobrescreve um arquivo com o conteúdo informado. Cria as pastas intermediárias se necessário.',
    {
      path: {
        type: 'string',
        description: 'Caminho do arquivo (relativo ao diretório raiz ou absoluto).'
      },
      content: { type: 'string', description: 'Conteúdo completo do arquivo.' }
    },
    ['path', 'content']
  ),
  edit_file: def(
    'edit_file',
    'Substitui um trecho exato de um arquivo. Falha se old_string não for encontrado ou não for único (a menos que replace_all seja true).',
    {
      path: {
        type: 'string',
        description: 'Caminho do arquivo (relativo ao diretório raiz ou absoluto).'
      },
      old_string: { type: 'string', description: 'Texto exato a ser substituído.' },
      new_string: { type: 'string', description: 'Texto novo.' },
      replace_all: {
        type: 'boolean',
        description: 'Substituir todas as ocorrências (padrão false).'
      }
    },
    ['path', 'old_string', 'new_string']
  ),
  shell: def(
    'shell',
    shellDescription(null),
    {
      command: { type: 'string', description: 'Comando a executar.' },
      timeout_ms: { type: 'number', description: 'Tempo limite em ms (padrão 120000).' }
    },
    ['command']
  ),
  process_start: def(
    'process_start',
    `Inicia um processo em SEGUNDO PLANO que continua rodando depois que a ferramenta retorna (dev server, emulador/AVD, \`adb logcat\`, watcher, banco local…). Para comandos que terminam, use shell. Roda no shell do usuário (mesmo ambiente do shell), com stdout+stderr capturados num log. O processo sobrevive entre turnos e é encerrado com process_stop ou quando o ClearChat fecha. Retorna o id (ex.: "p1"), pid e as primeiras linhas de saída. Para esperar ficar pronto, use wait_for (regex casada contra cada linha da saída, ex.: "Listening on|ready in") em vez de sleep/polling: retorna quando casar, quando o processo sair (erro com o código e o fim do log) ou no tempo limite (o processo continua rodando). A saída não é um terminal: se um programa fizer buffer do stdout, force line-buffering (ex.: \`stdbuf -oL cmd\`). Interromper a espera não mata o processo. Depois, use process_logs (pattern / since_line) para inspecionar. Máx. ${L.processMaxPerChat} processos rodando por chat.`,
    {
      command: { type: 'string', description: 'Comando a executar (shell -c).' },
      name: { type: 'string', description: 'Rótulo curto (ex.: "vite", "emulador").' },
      cwd: {
        type: 'string',
        description:
          'Diretório (relativo ao raiz ou absoluto). Padrão: o diretório atual do shell desta sessão.'
      },
      wait_for: {
        type: 'string',
        description:
          'Regex: espera até uma linha da saída casar (ex.: "boot completed|Listening on").'
      },
      timeout_s: {
        type: 'number',
        description: `Espera máxima do wait_for em segundos (padrão ${L.processWaitDefaultS}, máx. ${L.processWaitMaxS}). Sem wait_for, espera só ~1 s para capturar falhas imediatas.`
      }
    },
    ['command']
  ),
  process_logs: def(
    'process_logs',
    `Lê a saída (stdout+stderr) de um processo de process_start, com as linhas numeradas pela posição no log ("N\ttexto"). Padrão: as últimas ${L.processLogsDefaultLines} linhas. Para acompanhar incrementalmente, passe since_line com o número da última linha já vista (só vem o que é novo). pattern filtra por regex. Informa o estado (rodando / encerrado com código), o total de linhas e o caminho do arquivo com o log completo (a memória guarda só as últimas ${n(L.processBufferLines)} linhas; para buscar no log inteiro use search_files/read_file nesse arquivo). Resultado grande é salvo em arquivo (trecho + caminho no resultado).`,
    {
      id: { type: 'string', description: 'Id do processo (ex.: "p1").' },
      pattern: { type: 'string', description: 'Regex para filtrar as linhas.' },
      case_insensitive: {
        type: 'boolean',
        description: 'pattern sem diferenciar maiúsculas (padrão false).'
      },
      tail: {
        type: 'number',
        description: `Últimas N linhas (ou ocorrências, com pattern). Padrão ${L.processLogsDefaultLines}, máx. ${n(L.processLogsMaxLines)}.`
      },
      since_line: {
        type: 'number',
        description:
          'Só linhas com número maior que este (leitura incremental; vem em ordem, a partir da primeira nova).'
      },
      offset: { type: 'number', description: 'Linha inicial (1 = primeira) para ler uma faixa.' },
      limit: {
        type: 'number',
        description: 'Máximo de linhas com since_line/offset (padrão = tail).'
      }
    },
    ['id']
  ),
  process_list: def(
    'process_list',
    'Lista os processos em segundo plano deste chat (iniciados por esta sessão, pela principal ou por subagentes): id, nome, comando, pid, diretório, estado, há quanto tempo roda, nº de linhas de log e a última linha. Inclui os que já encerraram sozinhos (com o código de saída ou o sinal — confira também os de código 0, e veja o motivo com process_logs); só sai da lista o que foi parado/dispensado com process_stop (ou pelo usuário).',
    {}
  ),
  process_stop: def(
    'process_stop',
    'Para um processo de process_start: envia o sinal ao grupo de processos inteiro (filhos inclusos) e, se não sair em ~3 s, SIGKILL; o processo sai da lista. Num processo que já encerrou, só o remove da lista (dispensa). Retorna o código final, o caminho do log (continua no disco; process_logs pelo id ainda lê) e o fim do log.',
    {
      id: { type: 'string', description: 'Id do processo (ex.: "p1").' },
      signal: {
        type: 'string',
        enum: ['SIGTERM', 'SIGINT', 'SIGKILL'],
        description: 'Sinal inicial (padrão SIGTERM).'
      }
    },
    ['id']
  ),
  web_search: def(
    'web_search',
    `Pesquisa na web com UM buscador por vez — o primeiro habilitado na ordem configurada pelo usuário (DuckDuckGo, Brave, Exa, Tavily…); se ele falhar (chave, cota, bloqueio, rede), tenta o próximo automaticamente — e retorna até ${L.webMaxResults} resultados com título, URL e trecho; a 1ª linha diz qual buscador respondeu (e quais falharam antes). Há um intervalo mínimo global entre pesquisas (configurável; padrão 5 s): se preciso, a chamada espera a vez e a 1ª linha informa quanto aguardou.`,
    { query: { type: 'string', description: 'Termos de busca.' } },
    ['query']
  ),
  browse_url: def(
    'browse_url',
    `Abre uma URL em um navegador oculto (executa o JavaScript da página) e devolve o CONTEÚDO PRINCIPAL em Markdown compacto: título, URL, descrição, datas, dados estruturados (preço/produto/artigo, quando houver), títulos, parágrafos, listas, tabelas (com os números), blocos de código, citações e links absolutos [texto](url) — sem menus, cabeçalho, rodapé, barras laterais nem banners de cookies. Se o conteúdo principal não for identificado com segurança, devolve a página inteira sem menus e avisa. Página longa: o resultado traz o início e o caminho de um arquivo com o texto COMPLETO — leia o resto com read_file (offset/limit) ou search_files nesse arquivo, em vez de usar curl/python. mode="full" inclui menus/navegação/rodapé (ex.: para achar links do site); links=true acrescenta a lista "Links da página" (até ${L.browseMaxLinks}). Reler a mesma URL com outro mode/links em até 5 min usa a página já carregada.`,
    {
      url: { type: 'string', description: 'URL completa (http/https).' },
      mode: {
        type: 'string',
        enum: ['main', 'full'],
        description:
          '"main" (padrão): só o conteúdo principal. "full": a página inteira, com menus, navegação e rodapé.'
      },
      links: {
        type: 'boolean',
        description:
          'Acrescenta a seção "Links da página" com os links da página inteira (menus inclusos). Padrão false.'
      }
    },
    ['url']
  ),
  list_models: def(
    'list_models',
    `Lista os modelos de todos os provedores configurados (seções [Provedor]; o desta sessão primeiro), um por linha: id · contexto · preço por 1M tokens (entrada/saída) · grátis · tools. Use para escolher o modelo de um subagente (delegate_task com model e provider; ele precisa de "tools"). Modelos grátis (id ":free" ou preço 0) só para tarefas fáceis e SEM dados pessoais/sensíveis (o provedor pode registrar os prompts); são instáveis (429, erros, respostas vazias, sem tools): se falharem, tente outro grátis ou um pago. Tarefas difíceis ou com dados pessoais: modelo pago. Padrão ${L.modelsDefaultResults} por provedor (máx. ${L.modelsMaxResults}).`,
    {
      query: {
        type: 'string',
        description:
          'Filtra por parte do id ou do nome (sem diferenciar maiúsculas; ex.: "gpt-4.1", "claude").'
      },
      provider: {
        type: 'string',
        description: 'Só este provedor (nome ou id). Padrão: todos.'
      },
      tools_only: { type: 'boolean', description: 'Só modelos com suporte a tools.' },
      free_only: { type: 'boolean', description: 'Só modelos grátis.' },
      limit: {
        type: 'number',
        description: `Máximo de modelos listados por provedor (padrão ${L.modelsDefaultResults}, máx. ${L.modelsMaxResults}).`
      },
      sort: {
        type: 'string',
        enum: ['id', 'price', 'context'],
        description:
          'Ordem: id (padrão), price (mais barato primeiro) ou context (maior janela primeiro).'
      }
    }
  ),
  delegate_task: def(
    'delegate_task',
    'Delega uma tarefa autocontida a um subagente com as mesmas ferramentas e o mesmo diretório raiz. O subagente não vê esta conversa: descreva a tarefa com todo o contexto necessário. Retorna o relatório final do subagente. Com background=true retorna na hora e o resultado chega depois sozinho, como mensagem: se você estiver no meio de um turno, ele entra no próximo passo; se tiver encerrado o turno, você é acordado. Use para tarefas independentes ou longas e para rodar várias em paralelo. Sem mais nada a fazer enquanto eles rodam, ENCERRE O TURNO (pode dizer ao usuário o que está em andamento) — não precisa chamar wait_subagents nem consultar check_subagents; só use wait_subagents se o seu próximo passo, no mesmo turno, depende do resultado. Para outro modelo (ou o mesmo modelo por outro provedor), consulte list_models e passe model/provider; se o modelo falhar, tente outro.',
    {
      task: { type: 'string', description: 'Descrição completa e autocontida da tarefa.' },
      model: {
        type: 'string',
        description: 'Modelo do subagente (padrão: o mesmo desta sessão; veja list_models).'
      },
      provider: {
        type: 'string',
        description:
          'Provedor do subagente (nome, como em list_models, ou id). Padrão: o desta sessão.'
      },
      title: { type: 'string', description: 'Título curto para a subsessão.' },
      background: {
        type: 'boolean',
        description: 'Rodar em segundo plano e receber o resultado depois (padrão false).'
      }
    },
    ['task']
  ),
  get_chat_info: def(
    'get_chat_info',
    'Retorna informações deste chat: id, título, sessão atual (e sessão-pai, se for subagente), modelo, provedor, diretório raiz e data de criação.',
    {}
  ),
  list_chats: def(
    'list_chats',
    `Lista os chats do app (id, título, modelo, estado — ocioso, rodando ou aguardando aprovação — e última atualização), mais recentes primeiro; marca este chat. Com query, filtra pelo título (sem acentos/maiúsculas, mais parecidos primeiro). Para achar um chat pelo que foi DISCUTIDO nele, use read_history com scope "all". Padrão ${L.chatsDefaultResults} (máx. ${L.chatsMaxResults}).`,
    {
      query: {
        type: 'string',
        description: 'Filtra por palavras do título (ou início do id).'
      },
      limit: {
        type: 'number',
        description: `Máximo de chats listados (padrão ${L.chatsDefaultResults}).`
      }
    }
  ),
  send_to_chat: def(
    'send_to_chat',
    `Envia uma mensagem a OUTRO chat (id via list_chats), como se o usuário a digitasse lá: inicia um turno, ou entra na fila se o chat estiver ocupado. O destinatário vê de qual chat ela veio. Com wait_for_reply=true, aguarda o fim do turno e retorna a resposta final dele. Não envia para este próprio chat; cadeias de mensagens entre chats param em ${L.interChatMaxHops} saltos.`,
    {
      chat_id: { type: 'string', description: 'Id do chat de destino.' },
      message: { type: 'string', description: 'Texto a entregar.' },
      wait_for_reply: {
        type: 'boolean',
        description: 'Aguardar e retornar a resposta do chat (padrão false).'
      },
      timeout_s: {
        type: 'number',
        description: `Espera máxima em segundos com wait_for_reply (padrão ${L.interChatDefaultTimeoutS}).`
      }
    },
    ['chat_id', 'message']
  ),
  read_history: def(
    'read_history',
    `Lê o histórico salvo desta sessão, inclusive mensagens anteriores a compactações (que não estão mais no seu contexto). Com query: busca o texto (sem diferenciar maiúsculas) em mensagens, argumentos e resultados de tools e retorna trechos com o número #seq. Sem query: retorna as mensagens de from_seq a to_seq (padrão ${L.historyDefaultMessages}). Mensagens longas são cortadas; para ler uma inteira, use from_seq = to_seq. OUTROS CHATS (só leitura): scope "all" + query busca em todos os chats menos este (por relevância, agrupado por chat, até ${L.historyAllPerChat} trechos cada) — use para achar algo discutido em outro chat ou o chat certo antes de send_to_chat; chat_id (id ou prefixo) busca ou lê a faixa naquele chat.`,
    {
      query: {
        type: 'string',
        description:
          'Texto a buscar (em outros chats: palavras, sem acentos/maiúsculas, prefixos casam).'
      },
      chat_id: {
        type: 'string',
        description:
          'Outro chat (id ou prefixo único, via list_chats ou scope "all"): busca/faixa nele em vez desta sessão.'
      },
      scope: {
        type: 'string',
        enum: ['all'],
        description: '"all": buscar a query em todos os outros chats.'
      },
      session_id: {
        type: 'string',
        description: 'Com chat_id: subsessão (subagente) daquele chat; padrão a principal.'
      },
      from_seq: { type: 'number', description: 'Primeira mensagem (#seq).' },
      to_seq: { type: 'number', description: 'Última mensagem (#seq).' },
      limit: {
        type: 'number',
        description: `Máximo de mensagens (faixa: padrão ${L.historyDefaultMessages}; busca: padrão ${L.historySearchDefault}); com scope "all", de chats (padrão ${L.historyAllChatsDefault}).`
      },
      include_tool_results: {
        type: 'boolean',
        description:
          'Na faixa, inclui o conteúdo dos resultados de tools (padrão false: só o tamanho).'
      }
    }
  ),
  check_subagents: def(
    'check_subagents',
    'Lista os subagentes desta sessão: id, título, modelo, estado, duração, última atividade e se o resultado já foi entregue. Num subagente, lista também os IRMÃOS (criados pelo mesmo agente pai), com quem dá para falar por message_subagent. messages=true lista as mensagens que os seus subagentes trocaram diretamente entre si (hora, de → para, texto cortado; id filtra por um subagente). Não use para esperar: se não há mais nada a fazer, encerre o turno — os resultados chegam sozinhos e te acordam.',
    {
      messages: {
        type: 'boolean',
        description:
          'Listar as mensagens trocadas entre os seus subagentes (irmãos entre si) em vez dos estados (padrão false).'
      },
      id: {
        type: 'string',
        description: 'Com messages=true: só as mensagens enviadas ou recebidas por este subagente.'
      }
    }
  ),
  wait_subagents: def(
    'wait_subagents',
    `Aguarda subagentes em segundo plano terminarem e retorna os resultados (que então não chegam de novo como mensagem). mode "all" (padrão) espera todos; "any", o primeiro. Sem ids: todos os pendentes desta sessão. No tempo limite (padrão ${L.subagentWaitDefaultS}s), retorna os estados. Raramente necessário: os resultados de subagentes em segundo plano já chegam sozinhos como mensagem (e te acordam se o turno tiver encerrado). Use só quando precisa do resultado para continuar NESTE turno; se não há mais nada a fazer, prefira encerrar o turno.`,
    {
      ids: { type: 'array', items: { type: 'string' }, description: 'Ids dos subagentes.' },
      mode: { type: 'string', enum: ['all', 'any'], description: 'all (padrão) ou any.' },
      timeout_s: {
        type: 'number',
        description: `Espera máxima em segundos (padrão ${L.subagentWaitDefaultS}).`
      }
    }
  ),
  cancel_subagent: def(
    'cancel_subagent',
    'Cancela um subagente em execução (e os subagentes dele). O cancelamento é informado na mensagem de resultado.',
    { id: { type: 'string', description: 'Id do subagente.' } },
    ['id']
  ),
  message_subagent: def(
    'message_subagent',
    `Envia uma mensagem a um subagente que VOCÊ criou com delegate_task (direto ou descendente) — ex.: para avisar de mudanças — ou, se você é um subagente, a um subagente IRMÃO (criado pelo mesmo agente pai; ids em check_subagents). Não serve para responder a quem te delegou uma tarefa (para isso, apenas responda). Rodando: entra no próximo passo dele; ocioso ou concluído: ele retoma e a nova resposta final volta como mensagem a quem o criou. Com wait_for_reply=true (só com os seus subagentes), aguarda e retorna essa resposta. Entre irmãos: no máximo ${L.siblingMaxPerWindow} mensagens por minuto por par, sem wait_for_reply (o irmão responde com message_subagent e a resposta chega como mensagem nova); prefira terminar a sua tarefa e deixar o agente pai coordenar. broadcast=true (sem id) envia a todos os irmãos ativos para descobrir quem trata de algo (máx. ${L.siblingBroadcastMaxPerWindow} por minuto): só o irmão a quem interessa responde, direto. Ao receber um broadcast, responda só se for com você — e nunca com outro broadcast.`,
    {
      id: {
        type: 'string',
        description: 'Id do subagente (seu ou irmão). Omita com broadcast=true.'
      },
      message: { type: 'string', description: 'Texto a entregar.' },
      wait_for_reply: {
        type: 'boolean',
        description:
          'Aguardar e retornar a próxima resposta final dele (padrão false; não vale com irmãos nem broadcast).'
      },
      timeout_s: {
        type: 'number',
        description: `Espera máxima em segundos com wait_for_reply (padrão ${L.subagentWaitDefaultS}).`
      },
      broadcast: {
        type: 'boolean',
        description:
          'Enviar a todos os seus irmãos ativos (rodando ou aguardando) em vez de a um id (padrão false).'
      },
      include_finished: {
        type: 'boolean',
        description:
          'Com broadcast: também retoma irmãos ociosos/concluídos (cada um roda de novo e gasta tokens; padrão false).'
      }
    },
    ['message']
  ),
  ask_user: def(
    'ask_user',
    `Faz um questionário de múltipla escolha ao usuário (1 a ${AL.maxQuestions} perguntas, 1 a ${AL.maxOptions} opções cada) — a interface mostra uma pergunta por vez no lugar do campo de mensagem e o resultado chega quando ele envia as respostas (a ferramenta aguarda). Use quando há uma decisão com opções claras (ex.: qual banco de dados, qual abordagem) ou para coletar várias preferências de uma vez antes de começar. NÃO use para uma pergunta aberta simples ou para confirmar algo trivial — nesse caso apenas escreva a pergunta no chat e encerre o turno. O usuário sempre pode escolher "Outro" e escrever a própria resposta (a opção "Outro" é adicionada automaticamente: não a inclua). Ele não pode pular perguntas. Se ele cancelar, o resultado diz que não respondeu e o seu turno termina; não insista com o mesmo questionário. Campos opcionais por opção: icon (nome de ícone lucide em kebab-case como "database", um emoji, ou uma imagem pequena: URL http(s), caminho de arquivo dentro do diretório raiz ou "<svg…>" inline), description, image (imagem grande mostrada ao passar o mouse — URL, caminho ou "<svg…>") e help (texto de ajuda exibido em fonte monoespaçada, preservando espaços/ASCII art, ou uma imagem nas mesmas formas). Use imagens/ajuda só quando realmente ajudam a decidir.`,
    {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: AL.maxQuestions,
        description: `Perguntas (1 a ${AL.maxQuestions}), mostradas na ordem.`,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Pergunta (curta).' },
            description: { type: 'string', description: 'Contexto extra (opcional).' },
            multiple: {
              type: 'boolean',
              description: 'Permite marcar várias opções (padrão false = uma só).'
            },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: AL.maxOptions,
              description: `1 a ${AL.maxOptions} opções (sem "Outro" — é adicionada automaticamente).`,
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Texto da opção.' },
                  icon: {
                    type: 'string',
                    description:
                      'Opcional: ícone lucide (kebab-case, ex. "database"), emoji, ou imagem pequena (URL http(s), caminho no diretório raiz ou "<svg…>").'
                  },
                  description: { type: 'string', description: 'Opcional: detalhe da opção.' },
                  image: {
                    type: 'string',
                    description:
                      'Opcional: imagem grande mostrada ao passar o mouse (URL http(s), caminho no diretório raiz ou "<svg…>").'
                  },
                  help: {
                    type: 'string',
                    description:
                      'Opcional: ajuda no botão "?" — texto (monoespaçado, preserva espaços) ou imagem (mesmas formas de image).'
                  }
                },
                required: ['title'],
                additionalProperties: false
              }
            }
          },
          required: ['title', 'options'],
          additionalProperties: false
        }
      }
    },
    ['questions']
  ),
  datetime: def(
    'datetime',
    `Data e hora atuais do aparelho que roda o chat, no fuso dele. Sem format: ISO 8601 com o deslocamento, o dia da semana e o fuso (IANA e UTC±hh:mm). Com format: códigos de strftime — ${DATETIME_CODES.join(' ')} (nomes de dia e mês em português; %Z = fuso IANA, %z = deslocamento, %s = segundos Unix).`,
    {
      format: {
        type: 'string',
        description: 'Opcional: formato com códigos de strftime (ex.: "%A, %d de %B de %Y, %H:%M").'
      }
    }
  ),
  ...MEMORY_TOOL_DEFINITIONS,
  ...SKILL_TOOL_DEFINITIONS,
  search_tool: def(
    'search_tool',
    'Devolve a definição completa (descrição e parâmetros) de ferramentas enviadas compactadas — só com o nome e uma descrição curta, sem os parâmetros. Leia uma ferramenta compactada com esta antes de usá-la; dá para pedir várias de uma vez.',
    {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Nomes das ferramentas (ex.: ["web_search", "datetime"]).'
      }
    },
    ['names']
  ),
  end_call: def(
    'end_call',
    'Encerra a chamada de voz em andamento (desliga). Use quando o usuário se despedir ("tchau", "até mais", "valeu, era isso") ou pedir para desligar/encerrar a chamada — depois de dizer uma despedida curta NESTE MESMO turno (ela termina de tocar antes de a chamada cair). Não use se ele só fez uma pausa, agradeceu no meio da conversa ou ainda espera algo de você. Depois desta ferramenta o seu turno termina.',
    {
      reason: {
        type: 'string',
        description: 'Opcional: motivo curto (ex.: "usuário se despediu").'
      }
    }
  )
}

/** Definição da tool `shell` com o shell detectado na descrição (null = genérica). */
export function shellToolDefinition(info: ShellInfoLite | null): ToolDefinition {
  const d = TOOL_DEFINITIONS.shell
  if (!info) return d
  return {
    ...d,
    function: { ...d.function, description: shellDescription(info) }
  }
}

/** Definição "como enviada" independente de provedores (shell com o shell detectado). */
export function currentToolDefinition(name: ToolName): ToolDefinition {
  return name === 'shell' ? shellToolDefinition(toolShellInfo()) : TOOL_DEFINITIONS[name]
}

/** Tools com o argumento `provider` (escolha entre os provedores configurados). */
const PROVIDER_ARG_TOOLS: ToolName[] = ['list_models', 'delegate_task']

/**
 * Definição enviada na request, ajustada aos provedores configurados: com um provedor só, o
 * argumento `provider` some (modelos fracos o preenchem com nomes inventados); com vários, ganha
 * `enum` com os nomes (quando únicos). As demais tools ficam iguais (mesmo objeto).
 */
export function toolDefinitionFor(name: ToolName, providerNames: string[]): ToolDefinition {
  const d = TOOL_DEFINITIONS[name]
  if (name === 'shell') return currentToolDefinition(name)
  if (!PROVIDER_ARG_TOOLS.includes(name)) return d
  const { provider, ...rest } = d.function.parameters.properties
  if (!provider) return d
  const names = [...new Set(providerNames)]
  const properties =
    providerNames.length <= 1
      ? rest
      : {
          ...d.function.parameters.properties,
          provider: names.length === providerNames.length ? { ...provider, enum: names } : provider
        }
  return {
    ...d,
    function: { ...d.function, parameters: { ...d.function.parameters, properties } }
  }
}
