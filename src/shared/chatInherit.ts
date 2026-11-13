// Herança AO VIVO da persona pelos chats (protocolo 1.10.0, SYNC_PROTOCOL.md §4.3.6 — "Herança ao
// vivo da persona"): cada unidade de config que o chat não sobrescreveu segue a persona de origem
// (`presetId`) — e, nos campos que a persona não define, os padrões de "Novos chats" —, na hora em
// que a config é lida. `ChatConfig.overrides` = as unidades próprias do chat. O registro do chat
// continua com a `config` COMPLETA (cópia informativa das herdadas, gravada só ao criar, migrar,
// voltar a herdar, trocar de persona e congelar — nunca a cada edição da persona).
//
// Funções puras (sem Node/Electron/DOM): o main (repo, sync, host ao vivo), o renderer (marcas de
// herdado/próprio, "voltar a herdar") e o mobile (vendora este arquivo) calculam igual.
import { APPROVAL_ITEMS } from './approvalPolicy'
import { COMPACTABLE_TOOL_NAMES } from './compactTools'
import { supportsCacheControl } from './defaults'
import { APP_TOOL_NAMES, orderedTools, toolDevice, type ChatRanOn } from './deviceTools'
import { normalizeMemoryConfig } from './memory'
import {
  PRESET_FIELDS,
  newChatBase,
  resolvePreset,
  type NewChatDefaults,
  type PresetConfig,
  type PresetProvider
} from './presets'
import { providerKind } from './providerKinds'
import { normalizeSkillsConfig } from './skills'
import { TOOL_ALIASES, type ChatConfig, type ChatParams, type ToolName } from './types'
import { normalizeVoiceCallConfig, type VoiceCallConfig } from './voice'

/** `ChatConfig.overrides`: unidades próprias do chat (as outras herdam a persona). */
export type ChatOverrides = Record<string, true>

/** Config de chat com o mapa de unidades próprias (`ChatConfig.overrides`, §4.3.6). */
export type InheritConfig = ChatConfig

/**
 * O que o valor efetivo da persona precisa além dela: os padrões de "Novos chats" (sincronizados) e
 * os provedores de chat deste dispositivo (par do modelo; tipo → padrão do cache).
 */
export interface InheritEnv {
  defaults: NewChatDefaults
  providers: readonly PresetProvider[]
}

type Plain = Record<string, unknown>
const isObj = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

/** JSON com as chaves ordenadas (comparação estável de valores). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (isObj(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

// ---------------- unidades ----------------

/** Chaves de `config` que entram na herança: as de `PresetConfig` menos `voice` (regra própria). */
export const INHERIT_KEYS: readonly string[] = PRESET_FIELDS.filter((k) => k !== 'voice')

/** Chaves com várias unidades (cada subchave/tool é uma unidade; LWW pela chave inteira, §7.5). */
export const SHARED_INHERIT_KEYS = ['params', 'enabledTools', 'toolsFull', 'approvalModes'] as const
/** Chaves-lista de tools (cada tool é uma unidade booleana "está na lista"). */
const TOOL_LIST_KEYS = ['enabledTools', 'toolsFull'] as const
type ToolListKey = (typeof TOOL_LIST_KEYS)[number]
const isToolListKey = (k: string): k is ToolListKey =>
  (TOOL_LIST_KEYS as readonly string[]).includes(k)
/** Ordem do app de cada lista (as desconhecidas vão no fim, preservadas — §4.3.6). */
const TOOL_LIST_ORDER: Record<ToolListKey, readonly string[]> = {
  enabledTools: APP_TOOL_NAMES,
  toolsFull: COMPACTABLE_TOOL_NAMES
}
type SharedKey = (typeof SHARED_INHERIT_KEYS)[number]
const isSharedKey = (k: string): k is SharedKey =>
  (SHARED_INHERIT_KEYS as readonly string[]).includes(k)

/** Unidade de uma chave de uma unidade só (`providerId`/`model` → `model`…); null = compartilhada/fora. */
export function unitOfKey(key: string): string | null {
  if (key === 'providerId' || key === 'model') return 'model'
  if (key === 'appSignature' || key === 'appSignatureCustom') return 'appSignature'
  if (isSharedKey(key) || !INHERIT_KEYS.includes(key)) return null
  return key
}

/** Chave de `config` de uma unidade (`params.temperature` → `params`). */
export function keyOfUnit(unit: string): string {
  const dot = unit.indexOf('.')
  return dot === -1 ? unit : unit.slice(0, dot)
}

/** Chaves de `config` que uma unidade cobre (`model` → providerId + model). */
export function keysOfUnit(unit: string): string[] {
  if (unit === 'model') return ['providerId', 'model']
  if (unit === 'appSignature') return ['appSignature', 'appSignatureCustom']
  return [keyOfUnit(unit)]
}

/** Nome conhecido de unidade (os desconhecidos são preservados no registro, sem efeito). */
export function isKnownUnit(unit: string): boolean {
  const key = keyOfUnit(unit)
  if (unit === 'model' || unit === 'appSignature') return true
  if (isSharedKey(key)) return unit.length > key.length + 1
  return unit === key && unitOfKey(key) === key
}

function toolsOf(
  cfg: Partial<ChatConfig> | null | undefined,
  key: ToolListKey = 'enabledTools'
): string[] {
  const list = cfg?.[key]
  return Array.isArray(list) ? list.filter((t): t is ToolName => typeof t === 'string') : []
}

/** Unidades de uma chave compartilhada presentes em qualquer das configs (+ as conhecidas do app). */
export function unitsOfKey(
  key: string,
  ...cfgs: (Partial<ChatConfig> | null | undefined)[]
): string[] {
  const one = unitOfKey(key)
  if (one) return [one]
  const names = new Set<string>()
  if (key === 'params')
    for (const c of cfgs)
      for (const k of Object.keys(isObj(c?.params) ? c.params : {})) names.add(k)
  else if (isToolListKey(key)) {
    // todas as do app (as do celular inclusive, §4.3.6; em toolsFull também memória e skills) + as
    // desconhecidas que vierem nas listas
    for (const t of TOOL_LIST_ORDER[key]) names.add(t)
    for (const c of cfgs) for (const t of toolsOf(c, key)) names.add(t)
  } else if (key === 'approvalModes') {
    for (const i of APPROVAL_ITEMS) names.add(i)
    for (const c of cfgs)
      for (const k of Object.keys(isObj(c?.approvalModes) ? c.approvalModes : {})) names.add(k)
  } else return []
  return [...names].map((n) => `${key}.${n}`)
}

/** Todas as unidades das configs (ordem estável: a de `PRESET_FIELDS`). */
export function allUnits(...cfgs: (Partial<ChatConfig> | null | undefined)[]): string[] {
  const out: string[] = []
  for (const k of INHERIT_KEYS)
    for (const u of unitsOfKey(k, ...cfgs)) if (!out.includes(u)) out.push(u)
  return out
}

/**
 * Valor de uma unidade numa config (`model` = o par; `enabledTools.<t>`/`toolsFull.<t>` = está na
 * lista; lista ausente = undefined).
 */
export function readUnit(cfg: Partial<ChatConfig> | null | undefined, unit: string): unknown {
  if (!cfg) return undefined
  if (unit === 'model') return { providerId: cfg.providerId ?? '', model: cfg.model ?? '' }
  if (unit === 'appSignature')
    return {
      appSignature: cfg.appSignature ?? null,
      appSignatureCustom: cfg.appSignatureCustom ?? null
    }
  const key = keyOfUnit(unit)
  const sub = unit.slice(key.length + 1)
  if (key === 'params') return isObj(cfg.params) ? (cfg.params as Plain)[sub] : undefined
  if (isToolListKey(key))
    return Array.isArray(cfg[key]) ? toolsOf(cfg, key).includes(sub) : undefined
  if (key === 'approvalModes')
    return isObj(cfg.approvalModes) ? (cfg.approvalModes as Plain)[sub] : undefined
  return (cfg as Plain)[key]
}

/** Grava o valor de uma unidade (muta `cfg`). `undefined`/null numa subchave = remove. */
export function writeUnit(cfg: Partial<ChatConfig>, unit: string, value: unknown): void {
  const c = cfg as Plain
  if (unit === 'model') {
    const v = (isObj(value) ? value : {}) as { providerId?: unknown; model?: unknown }
    c.providerId = typeof v.providerId === 'string' ? v.providerId : ''
    c.model = typeof v.model === 'string' ? v.model : ''
    return
  }
  if (unit === 'appSignature') {
    const v = (isObj(value) ? value : {}) as {
      appSignature?: unknown
      appSignatureCustom?: unknown
    }
    if (v.appSignature == null) delete c.appSignature
    else c.appSignature = v.appSignature
    if (v.appSignatureCustom == null) delete c.appSignatureCustom
    else c.appSignatureCustom = clone(v.appSignatureCustom)
    return
  }
  const key = keyOfUnit(unit)
  const sub = unit.slice(key.length + 1)
  if (key === 'params') {
    const next: Plain = { ...(isObj(c.params) ? c.params : {}) }
    if (value == null) delete next[sub]
    else next[sub] = clone(value)
    c.params = next
    return
  }
  if (isToolListKey(key)) {
    const cur = toolsOf(cfg, key)
    const on = value === true
    if (on === cur.includes(sub)) {
      if (!Array.isArray(c[key])) c[key] = cur
      return
    }
    const set = new Set(on ? [...cur, sub] : cur.filter((t) => t !== sub))
    // ordem do app; tools que o app não conhece (de outra versão/aparelho) ficam no fim, na ordem
    // em que vieram — preservadas (§4.3.6)
    c[key] = orderedTools(set, [...cur, sub], TOOL_LIST_ORDER[key])
    return
  }
  if (key === 'approvalModes') {
    const next: Plain = { ...(isObj(c.approvalModes) ? c.approvalModes : {}) }
    if (value == null) delete next[sub]
    else next[sub] = value
    if (Object.keys(next).length) c.approvalModes = next
    else delete c.approvalModes
    return
  }
  if (value === undefined) delete c[key]
  else c[key] = clone(value)
}

/**
 * Igualdade de valores de uma unidade (memória/skills normalizadas; tools como booleano;
 * `toolsCompact` ausente = true; ausente = null).
 */
export function sameUnit(unit: string, a: unknown, b: unknown): boolean {
  if (unit === 'memory') return canon(normalizeMemoryConfig(a)) === canon(normalizeMemoryConfig(b))
  if (unit === 'skills') return canon(normalizeSkillsConfig(a)) === canon(normalizeSkillsConfig(b))
  if (unit === 'toolsCompact') return (a !== false) === (b !== false)
  if (unit.startsWith('enabledTools.') || unit.startsWith('toolsFull.')) return !!a === !!b
  return canon(a ?? null) === canon(b ?? null)
}

// ---------------- overrides ----------------

/**
 * `overrides` lido de qualquer valor: só as entradas `true` (leitores ignoram valores ≠ true); nomes
 * antigos de tool mapeados (`enabledTools.bash` → `enabledTools.shell`). Não-objeto → undefined
 * (chat sem herança: anterior à 1.10.0 ou nunca teve persona).
 */
export function normalizeOverrides(v: unknown): ChatOverrides | undefined {
  if (!isObj(v)) return undefined
  const out: ChatOverrides = {}
  for (const [k, val] of Object.entries(v)) {
    if (val !== true || !k) continue
    const key = keyOfUnit(k)
    const name = isToolListKey(key) ? k.slice(key.length + 1) : null
    out[name ? `${key}.${TOOL_ALIASES[name] ?? name}` : k] = true
  }
  return out
}

/** O chat já está na forma ≥ 1.10.0 (tem o mapa `overrides`, mesmo vazio)? */
export const hasOverrides = (cfg: Partial<InheritConfig> | null | undefined): boolean =>
  isObj(cfg?.overrides)

/** A unidade é própria do chat? */
export const isOwn = (cfg: Partial<InheritConfig> | null | undefined, unit: string): boolean =>
  !!normalizeOverrides(cfg?.overrides)?.[unit]

/** Unidades próprias conhecidas do chat (na ordem de `allUnits`). */
export function ownUnits(cfg: Partial<InheritConfig> | null | undefined): string[] {
  const ov = normalizeOverrides(cfg?.overrides) ?? {}
  return Object.keys(ov).filter(isKnownUnit)
}

/** O mapa sem as unidades. */
export function withoutUnits(ov: unknown, units: readonly string[]): ChatOverrides {
  const out = { ...(normalizeOverrides(ov) ?? {}) }
  for (const u of units) delete out[u]
  return out
}

/** A herança vale para este chat aqui: tem persona existente neste dispositivo e `overrides`. */
export function inheritanceActive(
  cfg: Partial<InheritConfig> | null | undefined,
  persona: PresetConfig | null | undefined
): boolean {
  return !!cfg?.presetId && !!persona && hasOverrides(cfg)
}

/** A persona define a unidade (a chave; em params/approvalModes a subchave; em tools, a lista)? */
export function personaDefines(persona: PresetConfig | null | undefined, unit: string): boolean {
  if (!persona) return false
  if (unit === 'model') return !!persona.model?.trim()
  if (unit === 'appSignature') return persona.appSignature !== undefined
  const key = keyOfUnit(unit)
  if (isToolListKey(key)) return Array.isArray(persona[key])
  if (key === 'params' || key === 'approvalModes') return readUnit(persona, unit) !== undefined
  return (persona as Plain)[key] !== undefined
}

// ---------------- valores efetivos ----------------

/**
 * Valor efetivo da persona em todas as unidades: o dela, se define; senão o padrão de "Novos chats"
 * (`defaultModel`; `defaultSystemPrompt` → texto do app; tools padrão; o resto, os padrões do app).
 * `cacheEnabled` sem valor na persona segue o provedor do modelo DELA aqui — `effectiveChatConfig`
 * corrige para o provedor efetivo do chat.
 */
export function personaEffectiveConfig(
  persona: PresetConfig | null | undefined,
  env: InheritEnv,
  cwd = ''
): ChatConfig {
  return resolvePreset(
    newChatBase(env.defaults, env.providers, cwd),
    { config: persona ?? {} },
    env.providers
  )
}

/** `cacheEnabled` herdado sem valor na persona: segue o provedor efetivo do chat (se existe aqui). */
function inheritedCache(
  cfg: Partial<ChatConfig>,
  persona: PresetConfig,
  env: InheritEnv,
  fallback: boolean | undefined
): boolean | undefined {
  if (persona.cacheEnabled !== undefined) return persona.cacheEnabled
  const prov = env.providers.find((p) => p.id === cfg.providerId)
  return prov ? supportsCacheControl(providerKind(prov)) : fallback
}

/** `record` com cada unidade herdada (fora de `ov`) no valor de `source`. Cópia. */
function composeInherited(
  record: InheritConfig,
  source: ChatConfig,
  ov: ChatOverrides
): InheritConfig {
  const out = clone(record)
  for (const u of allUnits(record, source)) if (!ov[u]) writeUnit(out, u, readUnit(source, u))
  return out
}

/**
 * Config EFETIVA do chat — a que o host usa para rodar e todos usam para exibir: com `presetId` de
 * uma persona que existe aqui (`persona`) e `overrides`, cada unidade própria fica com o valor do
 * chat (ausente inclusive) e cada herdada com o valor efetivo da persona; `voice` como está (os
 * campos null já herdam a persona ao vivo, `layerVoiceCallConfig`). Sem persona/`overrides` → a
 * config como está. Mantém `presetId`, `overrides`, `cwd` e `capturedContext`. Também é a cópia
 * informativa que o escritor grava (criar, migrar, voltar a herdar, trocar de persona).
 */
export function effectiveChatConfig(
  record: InheritConfig,
  persona: PresetConfig | null | undefined,
  env: InheritEnv
): InheritConfig {
  if (!inheritanceActive(record, persona)) return record
  const ov = normalizeOverrides(record.overrides)!
  const pe = personaEffectiveConfig(persona, env, record.cwd)
  const out = composeInherited(record, pe, ov)
  out.overrides = ov
  if (!ov.cacheEnabled) {
    const c = inheritedCache(out, persona!, env, pe.cacheEnabled)
    if (c !== undefined) out.cacheEnabled = c
  }
  return out
}

/** Valor que a unidade teria se o chat voltasse a herdá-la (tooltip do "voltar a herdar"). */
export function inheritedUnitValue(
  cfg: InheritConfig,
  unit: string,
  persona: PresetConfig | null | undefined,
  env: InheritEnv
): unknown {
  if (!persona || !cfg.presetId) return undefined
  const probe = { ...cfg, overrides: withoutUnits(cfg.overrides, [unit]) }
  return readUnit(effectiveChatConfig(probe, persona, env), unit)
}

// ---------------- edição ----------------

/** Merge de params: chaves com undefined/null/NaN no patch são removidas. */
function mergeParams(base: ChatParams | undefined, patch: unknown): ChatParams {
  const out: Plain = { ...(isObj(base) ? base : {}) }
  for (const [k, v] of Object.entries(isObj(patch) ? patch : {})) {
    if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) delete out[k]
    else out[k] = v
  }
  return out as ChatParams
}

/** Patch de config com a semântica do app: chave a chave; `params` mesclado (null remove). */
export function applyConfigPatch<T extends Partial<ChatConfig>>(
  cfg: T,
  patch: Partial<ChatConfig>
): T {
  const out: Plain = { ...cfg }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = k === 'params' ? mergeParams(cfg.params, v) : v
  }
  return out as T
}

/**
 * Unidades que um patch de edição toca: toda chave de uma unidade só enviada; nas compartilhadas
 * (params/enabledTools/approvalModes), só as subunidades cujo valor muda.
 */
export function touchedUnits(eff: Partial<ChatConfig>, patch: Partial<ChatConfig>): string[] {
  const next = applyConfigPatch(eff, patch)
  const out: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (isSharedKey(k)) {
      for (const u of unitsOfKey(k, eff, next))
        if (!sameUnit(u, readUnit(eff, u), readUnit(next, u)) && !out.includes(u)) out.push(u)
      continue
    }
    const u = unitOfKey(k)
    if (u && !out.includes(u)) out.push(u)
  }
  return out
}

/**
 * Edição local de campos do chat (tela de configuração; `chat.update` sem `overrides`): o patch vale
 * sobre a config efetiva e cada unidade tocada vira PRÓPRIA (entra em `overrides` com o valor novo);
 * as outras herdadas continuam (a cópia delas não é regravada). Chat sem `overrides` (anterior à
 * 1.10.0, ainda não migrado, ou sem persona) → patch comum.
 */
export function applyChatEdit(
  record: InheritConfig,
  patch: Partial<ChatConfig>,
  persona: PresetConfig | null | undefined,
  env: InheritEnv
): InheritConfig {
  if (!hasOverrides(record)) return applyConfigPatch(record, patch)
  const eff = effectiveChatConfig(record, persona, env)
  const next = applyConfigPatch(eff, patch)
  const out = clone(record)
  for (const [k, v] of Object.entries(patch))
    if (v !== undefined && !INHERIT_KEYS.includes(k))
      (out as unknown as Plain)[k] = clone((next as unknown as Plain)[k])
  const ov = { ...normalizeOverrides(record.overrides) }
  for (const u of touchedUnits(eff, patch)) {
    writeUnit(out, u, readUnit(next, u))
    ov[u] = true
  }
  out.overrides = ov
  return out
}

/** "Voltar a herdar": as unidades saem de `overrides` e a cópia recebe o valor efetivo da persona. */
export function revertToInherit(
  record: InheritConfig,
  units: readonly string[],
  persona: PresetConfig | null | undefined,
  env: InheritEnv
): InheritConfig {
  const out = { ...clone(record), overrides: withoutUnits(record.overrides, units) }
  return effectiveChatConfig(out, persona, env)
}

// ---------------- voz (fora de overrides: null = herda) ----------------

const VOICE_FIELDS = [
  'enabled',
  'model',
  'tools',
  'voicePrompt',
  'promptMode',
  'fillers',
  'endCall',
  'audioTags',
  'toolPhrases',
  'audioTagsPrompt',
  'tts',
  'stt'
] as const

/** Migração: campos da voz do chat iguais ao campo NÃO nulo da persona → null (passam a herdar). */
export function voiceInheritingPersona(
  chat: VoiceCallConfig | null | undefined,
  persona: VoiceCallConfig | null | undefined
): VoiceCallConfig {
  const c = normalizeVoiceCallConfig(chat ?? null) as unknown as Plain
  if (!persona) return c as unknown as VoiceCallConfig
  const p = normalizeVoiceCallConfig(persona) as unknown as Plain
  for (const f of VOICE_FIELDS)
    if (c[f] != null && p[f] != null && canon(c[f]) === canon(p[f])) c[f] = null
  return normalizeVoiceCallConfig(c)
}

/** Congelamento: campos null da voz do chat recebem o valor não nulo da persona. */
export function voiceFilledFromPersona(
  chat: VoiceCallConfig | null | undefined,
  persona: VoiceCallConfig | null | undefined
): VoiceCallConfig {
  const c = normalizeVoiceCallConfig(chat ?? null) as unknown as Plain
  if (!persona) return c as unknown as VoiceCallConfig
  const p = normalizeVoiceCallConfig(persona) as unknown as Plain
  for (const f of VOICE_FIELDS) if (c[f] == null && p[f] != null) c[f] = clone(p[f])
  return normalizeVoiceCallConfig(c)
}

// ---------------- ciclo de vida ----------------

/**
 * Unidade que não pode ser própria "por causa do aparelho": `enabledTools.<t>` de uma tool de um tipo
 * de aparelho em que o chat nunca rodou (§4.3.6). A migração não a marca (ex.: chat criado no celular,
 * sem as tools do computador, passa a herdá-las; chat antigo do desktop, sem as do celular, idem) e a
 * limpeza única a tira de `overrides`.
 */
function deviceDifference(unit: string, ranOn: ChatRanOn): boolean {
  if (!unit.startsWith('enabledTools.')) return false
  const d = toolDevice(unit.slice(13))
  return d !== null && !ranOn[d]
}

/**
 * Tools que nenhum app < 1.10.0 conhecia (as únicas versões que escrevem chats sem `overrides`): num
 * chat antigo, a ausência delas na lista não é escolha do usuário — a migração não as marca (herdam).
 */
export const TOOLS_NEWER_THAN_LEGACY_CHATS: readonly ToolName[] = ['datetime']

function newerToolMissing(unit: string, record: InheritConfig): boolean {
  if (!unit.startsWith('enabledTools.')) return false
  const t = unit.slice(13) as ToolName
  return (
    TOOLS_NEWER_THAN_LEGACY_CHATS.includes(t) &&
    !(Array.isArray(record.enabledTools) && record.enabledTools.includes(t))
  )
}

/**
 * Migração única de um chat antigo (com `presetId` e SEM `overrides` — apps < 1.10.0), depois de um
 * pull completo: `overrides` = as unidades cujo valor no chat difere (JSON) do valor efetivo da
 * persona; as iguais passam a herdar. Uma diferença numa tool de um tipo de aparelho só vira própria
 * se o chat já rodou naquele tipo (`ranOn` — `chatRanOn` em ./deviceTools: `hostCwd` do registro /
 * chat local deste computador). Tools que apps < 1.10.0 não conheciam (`datetime`) ausentes da
 * lista herdam. Na `voice`, campos iguais ao campo não nulo da persona → null. Determinística (só depende do que sincroniza). null = nada a migrar (sem persona, persona que não
 * existe aqui, ou já migrado).
 */
export function migrateChatOverrides(
  record: InheritConfig,
  persona: PresetConfig | null | undefined,
  env: InheritEnv,
  ranOn: ChatRanOn
): InheritConfig | null {
  if (!record.presetId || !persona || hasOverrides(record)) return null
  const pe = personaEffectiveConfig(persona, env, record.cwd)
  const ov: ChatOverrides = {}
  for (const u of allUnits(record, pe))
    if (
      u !== 'cacheEnabled' &&
      !sameUnit(u, readUnit(record, u), readUnit(pe, u)) &&
      !deviceDifference(u, ranOn) &&
      !newerToolMissing(u, record)
    )
      ov[u] = true
  // o cache herdado depende do provedor efetivo do chat (o par já decidido acima)
  const probe = composeInherited(record, pe, ov)
  if (
    !sameUnit(
      'cacheEnabled',
      record.cacheEnabled,
      inheritedCache(probe, persona, env, pe.cacheEnabled)
    )
  )
    ov.cacheEnabled = true
  const out: InheritConfig = { ...clone(record), overrides: ov }
  if (record.voice) out.voice = voiceInheritingPersona(record.voice, persona.voice)
  return out
}

/**
 * Limpeza única (§4.3.6, uma vez por dispositivo depois de um pull completo): builds de teste de
 * 1.10.0 marcaram tools como próprias por causa do aparelho — as unidades `enabledTools.<t>` de tools
 * de um tipo de aparelho em que o chat nunca rodou (mesmo critério da migração, `ranOn`) saem de
 * `overrides`, como num "voltar a herdar" (a cópia recebe o valor efetivo da persona). Sem a herança
 * ativa aqui (sem persona/persona ausente), só as marcas saem. null = nada a limpar.
 */
export function cleanDeviceOverrides(
  record: InheritConfig,
  persona: PresetConfig | null | undefined,
  env: InheritEnv,
  ranOn: ChatRanOn
): InheritConfig | null {
  const ov = normalizeOverrides(record.overrides)
  if (!ov) return null
  const units = Object.keys(ov).filter((u) => deviceDifference(u, ranOn))
  if (!units.length) return null
  if (inheritanceActive(record, persona)) return revertToInherit(record, units, persona, env)
  return { ...clone(record), overrides: withoutUnits(record.overrides, units) }
}

/**
 * Congela o chat (persona apagada ou "Nenhuma persona"): grava o valor efetivo atual de todas as
 * unidades herdadas, preenche os campos null da `voice` com os não nulos da persona, REMOVE
 * `presetId` e mantém `overrides` (sem efeito até outra persona ser escolhida).
 */
export function freezeChat(
  record: InheritConfig,
  persona: PresetConfig | null | undefined,
  env: InheritEnv
): InheritConfig {
  const out = clone(effectiveChatConfig(record, persona, env))
  if (persona?.voice) out.voice = voiceFilledFromPersona(out.voice, persona.voice)
  delete out.presetId
  return out
}

/**
 * Troca a persona do chat: `presetId` novo, `overrides` mantido (sem mapa → `{}`: tudo herda), as
 * herdadas passam a seguir a persona nova (cópia atualizada). `persona` null = a persona nova não
 * existe aqui (a cópia fica como está até ela chegar).
 */
export function switchPersona(
  record: InheritConfig,
  presetId: string,
  persona: PresetConfig | null | undefined,
  env: InheritEnv
): InheritConfig {
  const out: InheritConfig = {
    ...clone(record),
    presetId,
    overrides: normalizeOverrides(record.overrides) ?? {}
  }
  return effectiveChatConfig(out, persona, env)
}

/**
 * Config de um chat NOVO com persona (existente aqui): `overrides` = os enviados (o formulário do
 * Novo chat sabe o que o usuário mudou) ou, sem eles, as unidades em que `input` difere do valor
 * efetivo da persona; a `config` sai completa (cópia das herdadas). Chaves fora da herança (`cwd`,
 * `voice`, `capturedContext`…) vêm de `input`.
 */
export function newInheritingChatConfig(
  input: Partial<InheritConfig> & { presetId: string },
  persona: PresetConfig,
  env: InheritEnv
): InheritConfig {
  const pe = personaEffectiveConfig(persona, env, input.cwd ?? '')
  const given = normalizeOverrides(input.overrides)
  let out: InheritConfig
  let ov: ChatOverrides
  if (given) {
    out = clone(pe)
    ov = {}
    for (const u of Object.keys(given)) {
      if (!isKnownUnit(u)) {
        ov[u] = true
        continue
      }
      // unidade própria sem o valor no input: não dá para ser própria (herda)
      if (!keysOfUnit(u).some((k) => (input as Plain)[k] !== undefined)) continue
      writeUnit(out, u, readUnit(input, u))
      ov[u] = true
    }
  } else {
    const rest: Plain = { ...input }
    delete rest.overrides
    delete rest.presetId
    out = applyConfigPatch(clone(pe), rest as Partial<ChatConfig>)
    ov = {}
    for (const u of allUnits(out, pe))
      if (u !== 'cacheEnabled' && !sameUnit(u, readUnit(out, u), readUnit(pe, u))) ov[u] = true
    if (
      input.cacheEnabled !== undefined &&
      !sameUnit(
        'cacheEnabled',
        out.cacheEnabled,
        inheritedCache(composeInherited(out, pe, ov), persona, env, pe.cacheEnabled)
      )
    )
      ov.cacheEnabled = true
  }
  for (const [k, v] of Object.entries(input))
    if (v !== undefined && !INHERIT_KEYS.includes(k) && k !== 'overrides')
      (out as unknown as Plain)[k] = clone(v)
  // a voz não é copiada da persona: os campos ausentes/null herdam dela ao vivo (1.9.0)
  if (input.voice === undefined) delete out.voice
  out.presetId = input.presetId
  out.overrides = ov
  return effectiveChatConfig(out, persona, env)
}

// ---------------- patch de config (tela local e `chat.update` remoto, §23.7) ----------------

export interface ChatPatchContext {
  env: InheritEnv
  /** Config (sanitizada) da persona com esse id NESTE dispositivo; null = não existe aqui. */
  persona: (id: string) => PresetConfig | null
  /**
   * Em que tipos de aparelho o chat já rodou (`chatRanOn`) — só usado se o patch troca a persona de
   * um chat ainda não migrado (a migração contra a antiga vem antes).
   */
  ranOn: ChatRanOn
}

/**
 * Interpreta um patch de `config` de chat (edição na tela ou `chat.update` de um chat ao vivo):
 * - `presetId: null` (ou '') = escolher NENHUMA persona = congelar; outro id = trocar de persona
 *   (mantém `overrides`; chat ainda não migrado é migrado contra a persona antiga antes);
 * - com `overrides` (o mapa completo novo) = vale como enviado — é assim que se "volta a herdar":
 *   as outras chaves do patch são gravadas, uma unidade que passa a ser própria sem vir no patch
 *   guarda o valor efetivo que tinha, e a cópia das herdadas é recalculada;
 * - sem `overrides` = edição: as unidades tocadas viram próprias (`applyChatEdit`).
 * Retorna o registro novo (a config completa, com a cópia).
 */
export function applyChatConfigPatch(
  record: InheritConfig,
  patch: Partial<InheritConfig> & { presetId?: string | null },
  ctx: ChatPatchContext
): InheritConfig {
  let rec: InheritConfig = record
  let persona = rec.presetId ? ctx.persona(rec.presetId) : null
  const rest: Plain = { ...patch }
  delete rest.presetId
  delete rest.overrides
  if ('presetId' in patch && patch.presetId !== undefined) {
    const next = typeof patch.presetId === 'string' ? patch.presetId : ''
    if (!next) {
      rec = freezeChat(rec, persona, ctx.env)
      persona = null
    } else if (next !== rec.presetId) {
      if (rec.presetId && persona && !hasOverrides(rec))
        rec = migrateChatOverrides(rec, persona, ctx.env, ctx.ranOn) ?? rec
      // a voz herdada da persona antiga não vai junto: os campos null passam a seguir a nova
      const np = ctx.persona(next)
      rec = switchPersona(rec, next, np, ctx.env)
      persona = np
    }
  }
  if (isObj(patch.overrides)) {
    const before = effectiveChatConfig(rec, persona, ctx.env)
    const oldOv = normalizeOverrides(rec.overrides) ?? {}
    const newOv = normalizeOverrides(patch.overrides) ?? {}
    const out = applyConfigPatch(clone(rec), rest as Partial<ChatConfig>)
    for (const u of Object.keys(newOv))
      if (!oldOv[u] && isKnownUnit(u) && !keysOfUnit(u).some((k) => rest[k] !== undefined))
        writeUnit(out, u, readUnit(before, u))
    out.overrides = newOv
    return effectiveChatConfig(out, persona, ctx.env)
  }
  if (!Object.keys(rest).some((k) => rest[k] !== undefined)) return rec
  return applyChatEdit(rec, rest as Partial<ChatConfig>, persona, ctx.env)
}

// ---------------- merge (rev_mismatch / pull com edição local, §7.5) ----------------

/**
 * Merge 3-way da `config` de chat/persona: sobre a do servidor, as chaves que mudaram localmente
 * desde `base` (LWW por chave, como antes). Desde 1.10.0: `overrides` mesclado POR UNIDADE (cada
 * marca suja sozinha) e a cópia informativa de uma unidade que o local tem como herdada não
 * sobrescreve o valor de uma unidade que, no resultado, é própria (marcada no servidor e não
 * mexida aqui) — nas chaves compartilhadas, a subunidade protegida fica com o valor do servidor.
 */
export function mergeChatConfig3(server: Plain, base: Plain, local: Plain): Plain {
  const out: Plain = { ...server }
  const lo = normalizeOverrides(local.overrides)
  const bo = normalizeOverrides(base.overrides)
  const so = normalizeOverrides(server.overrides)
  let merged = so
  if (lo || bo) {
    merged = { ...(so ?? {}) }
    // nomes desconhecidos/valores ≠ true do servidor são preservados (só as marcas mexidas mudam)
    if (isObj(server.overrides)) Object.assign(merged, server.overrides)
    for (const u of new Set([...Object.keys(lo ?? {}), ...Object.keys(bo ?? {})])) {
      if (!!lo?.[u] === !!bo?.[u]) continue
      if (lo?.[u]) merged[u] = true
      else delete merged[u]
    }
    if (lo || isObj(server.overrides)) out.overrides = merged
  }
  const protectedUnit = (u: string): boolean => !!lo && !lo[u] && !!merged?.[u]
  for (const ck of new Set([...Object.keys(local), ...Object.keys(base)])) {
    if (ck === 'overrides' || canon(local[ck]) === canon(base[ck])) continue
    const one = unitOfKey(ck)
    if (one && protectedUnit(one)) continue
    if (isSharedKey(ck) && lo) {
      const v: Plain = local[ck] === undefined ? {} : { [ck]: clone(local[ck]) }
      for (const u of unitsOfKey(ck, local, server))
        if (protectedUnit(u)) writeUnit(v, u, readUnit(server as Partial<ChatConfig>, u))
      if (v[ck] === undefined) delete out[ck]
      else out[ck] = v[ck]
      continue
    }
    if (local[ck] === undefined) delete out[ck]
    else out[ck] = local[ck]
  }
  return out
}
