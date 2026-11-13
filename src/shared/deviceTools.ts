// Tools de um tipo de aparelho (protocolo 1.10.0, SYNC_PROTOCOL.md §4.3.6 — "Tools de um tipo de
// aparelho"): algumas tools só rodam no computador (arquivos, terminal, processos — e as skills, que
// são `config.skills`, fora de `enabledTools`) e outras só no celular (localização). A lista de tools
// do chat (a efetiva, herdada ou própria) é a MESMA em todos os aparelhos; quem roda o turno manda ao
// modelo só as que executa e a UI mostra as outras esmaecidas ("só no computador"/"só no celular"),
// ainda alternáveis — valem quando o chat rodar no outro tipo de aparelho. Nunca viram próprias do
// chat por causa do aparelho; quem não conhece uma tool a preserva nas listas.
//
// Puro (sem Node/Electron/DOM): o desktop e o mobile (vendora este arquivo) usam os mesmos nomes.
import { TOOL_LABELS, TOOL_NAMES } from './tools'
import type { ToolName } from './types'

/** Tipo de aparelho que roda o turno. */
export type DeviceKind = 'computer' | 'phone'

/** Só no computador (§4.3.6): arquivos, terminal e processos (as skills vêm por `config.skills`). */
export const COMPUTER_TOOL_NAMES: readonly ToolName[] = [
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
  'process_stop'
]

/** Só no celular (§4.3.6): localização (o celular as define e executa — `src/location` do mobile). */
export const PHONE_TOOL_NAMES = ['get_location', 'nearby_places'] as const
export type PhoneToolName = (typeof PHONE_TOOL_NAMES)[number]

/**
 * As do celular no tipo das tools do protocolo: o `ToolName` do desktop não as conhece (ele nunca as
 * executa nem tem definição para elas), mas elas vivem nas mesmas listas `enabledTools`.
 */
export const PHONE_TOOLS: readonly ToolName[] = PHONE_TOOL_NAMES as readonly string[] as ToolName[]

export const isPhoneTool = (name: string): name is PhoneToolName =>
  (PHONE_TOOL_NAMES as readonly string[]).includes(name)

/** Rótulos curtos (pt-BR) das tools do celular. */
export const PHONE_TOOL_LABELS: Record<PhoneToolName, string> = {
  get_location: 'Localização',
  nearby_places: 'Lugares próximos'
}

/** Uma linha sobre o que cada tool do celular faz (UI; a definição enviada é do celular). */
export const PHONE_TOOL_HELP: Record<PhoneToolName, string> = {
  get_location: 'Sua posição atual (com a sua aprovação; Configurações → Localização).',
  nearby_places: 'Restaurantes, farmácias, mercados… por perto (OpenStreetMap).'
}

/**
 * Descrição curta de cada tool do celular (tools compactadas, protocolo 1.11.0 — @shared/compactTools):
 * o que vai no lugar da definição quando ela é enviada compacta (1 a 20 palavras, pt-BR).
 */
export const PHONE_TOOL_SHORT: Record<PhoneToolName, string> = {
  get_location:
    'Localização atual do usuário pelo celular: coordenadas, precisão e bairro/cidade (pode pedir aprovação).',
  nearby_places:
    'Busca lugares por perto no OpenStreetMap (restaurantes, farmácias, mercados…), com endereço, horário e distância.'
}

/**
 * Todas as tools de `enabledTools` que o app conhece, na ordem do app (as do celular no fim) — é o
 * padrão de "Novos chats" (§4.3.6: as tools padrão do app são todas, inclusive as de um tipo de
 * aparelho) e a ordem em que as listas são regravadas.
 */
export const APP_TOOL_NAMES: readonly ToolName[] = [...TOOL_NAMES, ...PHONE_TOOLS]

/** Tipo de aparelho de que a tool depende; null = roda em qualquer um. */
export function toolDevice(name: string): DeviceKind | null {
  const n = name === 'bash' ? 'shell' : name
  if ((COMPUTER_TOOL_NAMES as readonly string[]).includes(n)) return 'computer'
  if (isPhoneTool(n)) return 'phone'
  return null
}

/** A tool roda neste tipo de aparelho? (as sem tipo rodam em todos) */
export function runsOn(name: string, device: DeviceKind): boolean {
  const d = toolDevice(name)
  return d === null || d === device
}

/** Selo das esmaecidas. */
export const DEVICE_ONLY_LABEL: Record<DeviceKind, string> = {
  computer: 'só no computador',
  phone: 'só no celular'
}

/** Título do grupo das esmaecidas na lista de tools. */
export const DEVICE_ONLY_TITLE: Record<DeviceKind, string> = {
  computer: 'Só no computador',
  phone: 'Só no celular'
}

/**
 * Nota do grupo esmaecido, vista NO OUTRO tipo de aparelho (`device` = o tipo das tools do grupo):
 * deixa claro que elas não vão ao modelo aqui (nada escondido vai ao modelo).
 */
export const DEVICE_ONLY_NOTE: Record<DeviceKind, string> = {
  computer:
    'Não vão ao modelo quando o chat roda neste celular. Ligadas, valem quando ele rodar num computador.',
  phone:
    'Não vão ao modelo quando o chat roda neste computador. Ligadas, valem quando ele rodar no celular.'
}

/** Rótulo de uma tool (as do celular inclusive); desconhecida → o próprio nome. */
export function toolLabel(name: string): string {
  if (isPhoneTool(name)) return PHONE_TOOL_LABELS[name]
  return (TOOL_LABELS as Record<string, string>)[name] ?? name
}

/**
 * Liga/desliga uma tool numa lista `enabledTools` sem perder nada: a ordem do app
 * (`APP_TOOL_NAMES`) e, no fim, as que o app não conhece (de outra versão/aparelho), na ordem em
 * que vieram — §4.3.6: quem não conhece uma tool a preserva ao regravar.
 */
export function withTool(list: readonly string[], name: string, on: boolean): ToolName[] {
  const cur = list.filter((t): t is string => typeof t === 'string')
  const set = new Set(on ? [...cur, name] : cur.filter((t) => t !== name))
  return orderedTools(set, [...cur, name])
}

/**
 * As tools de `set` na ordem do app (`order`, padrão `APP_TOOL_NAMES`); as desconhecidas no fim, na
 * ordem de `seen`.
 */
export function orderedTools(
  set: ReadonlySet<string>,
  seen: readonly string[],
  order: readonly string[] = APP_TOOL_NAMES
): ToolName[] {
  const known = new Set<string>(order)
  const extras = [...new Set(seen)].filter((t) => set.has(t) && !known.has(t))
  return [...(order.filter((t) => set.has(t)) as ToolName[]), ...(extras as ToolName[])]
}

// ---------------- migração (§4.3.6) ----------------

/** Em que tipos de aparelho o chat já rodou (decide a migração das tools de um tipo de aparelho). */
export interface ChatRanOn {
  computer: boolean
  phone: boolean
}

/**
 * §4.3.6, migração: o chat já rodou num computador se o registro tem `hostCwd` (o host computador o
 * grava ao virar host) ou se ele é local deste computador (sem login, ou só ao vivo hospedado aqui);
 * num celular, se o registro não tem `hostCwd`. Uma diferença numa tool de um tipo de aparelho só
 * vira própria se o chat já rodou naquele tipo — senão a unidade herda.
 */
export function chatRanOn(hostCwd: unknown, localToComputer = false): ChatRanOn {
  if (localToComputer) return { computer: true, phone: false }
  const has = hostCwd != null && hostCwd !== ''
  return { computer: has, phone: !has }
}
