// Herança ao vivo da persona no main (protocolo 1.10.0, §4.3.6): o banco guarda o REGISTRO do chat
// (valores próprios + cópia informativa das herdadas + `overrides`); tudo que roda ou exibe um chat
// usa a config EFETIVA, calculada na leitura com a persona e os padrões de "Novos chats" daqui
// (@shared/chatInherit). Recebe a conexão (o app passa getDb(); o sync, a dele; testes, temporária).
import type Database from 'better-sqlite3'
import { homedir } from 'os'
import { normalizeAppSignatureId } from '@shared/appSignatures'
import { APPROVAL_MODES_SETTING, migrateLegacyApprovals } from '@shared/approvalPolicy'
import {
  effectiveChatConfig,
  freezeChat,
  hasOverrides,
  migrateChatOverrides,
  type InheritConfig,
  type InheritEnv
} from '@shared/chatInherit'
import { DEFAULT_CHAT_CONFIG } from '@shared/defaults'
import { sanitizePresetConfig, type PresetConfig } from '@shared/presets'
import { isChatProvider } from '@shared/providerKinds'
import { migrateConfigTools } from '@shared/toolRename'
import type { ApprovalItem, ApprovalMode, ChatConfig } from '@shared/types'
import { normalizeVoiceCallConfig } from '@shared/voice'

type Conn = Database.Database

function parse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

const settingValue = (conn: Conn, key: string): unknown => {
  const r = conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string | null } | undefined
  return r?.value == null ? null : parse<unknown>(r.value, null)
}

const settingStr = (conn: Conn, key: string): string | null => {
  const v = settingValue(conn, key)
  return typeof v === 'string' ? v : null
}

/** Padrões de "Novos chats" + provedores de chat deste dispositivo (o que a herança lê ao vivo). */
export function inheritEnvOf(conn: Conn): InheritEnv {
  const rows = conn.prepare('SELECT id, base_url, kind FROM providers').all() as {
    id: string
    base_url: string
    kind: string | null
  }[]
  return {
    defaults: {
      defaultProviderId: settingStr(conn, 'defaultProviderId'),
      defaultModel: settingStr(conn, 'defaultModel'),
      defaultSystemPrompt: settingStr(conn, 'defaultSystemPrompt')
    },
    providers: rows
      .map((r) => ({ id: r.id, baseUrl: r.base_url, kind: (r.kind ?? undefined) as never }))
      .filter(isChatProvider)
  }
}

/** Config (sanitizada) da persona com esse id aqui; null = não existe neste dispositivo. */
export function presetConfigOf(conn: Conn, id: string | null | undefined): PresetConfig | null {
  if (!id) return null
  const r = conn.prepare('SELECT config_json FROM presets WHERE id = ?').get(id) as
    { config_json: string } | undefined
  return r ? sanitizePresetConfig(parse<unknown>(r.config_json, {})) : null
}

/**
 * Registro do chat como o app o lê (aliases de leitura de configs antigas: tools renomeadas,
 * aprovações ≤ 0.4.0, id antigo da assinatura, voz normalizada) e completo sobre os padrões do app.
 */
export function chatRecordFrom(conn: Conn, configJson: string): InheritConfig {
  const fallback = DEFAULT_CHAT_CONFIG(homedir())
  const cfg = migrateLegacyApprovals(
    migrateConfigTools(parse<Partial<ChatConfig>>(configJson, {})),
    {
      globalModes: () =>
        (settingValue(conn, APPROVAL_MODES_SETTING) as Partial<
          Record<ApprovalItem, ApprovalMode>
        > | null) ?? null
    }
  )
  return {
    ...fallback,
    ...cfg,
    appSignature: normalizeAppSignatureId(cfg.appSignature),
    params: { ...(cfg.params ?? {}) },
    // campos legados de registros antigos (`interjections` — §4.3.6) somem aqui
    ...(cfg.voice && typeof cfg.voice === 'object'
      ? { voice: normalizeVoiceCallConfig(cfg.voice) }
      : {})
  }
}

/** Config efetiva de um registro (persona e padrões lidos agora). */
export function effectiveOf(
  conn: Conn,
  record: InheritConfig,
  env: InheritEnv = inheritEnvOf(conn)
): InheritConfig {
  if (!record.presetId || !hasOverrides(record)) return record
  return effectiveChatConfig(record, presetConfigOf(conn, record.presetId), env)
}

/** Config efetiva do chat direto do `config_json` (host ao vivo, estado do host — `usesLocalTools`). */
export function effectiveFromJson(conn: Conn, configJson: string): InheritConfig {
  return effectiveOf(conn, chatRecordFrom(conn, configJson))
}

const writeConfig = (conn: Conn, id: string, cfg: InheritConfig): void => {
  conn.prepare('UPDATE chats SET config_json = ? WHERE id = ?').run(JSON.stringify(cfg), id)
}

/**
 * Migração única dos chats antigos (com `presetId` e sem `overrides`) contra a persona e os padrões
 * DAQUI — chamar depois de um pull completo (logado) ou na inicialização (sem login; chats só ao
 * vivo também). Grava o registro (o trigger do sync o marca para envio). Retorna os ids migrados.
 */
export function migrateChatInheritance(conn: Conn): string[] {
  const rows = conn
    .prepare(
      `SELECT id, config_json FROM chats
       WHERE json_valid(config_json) AND json_extract(config_json, '$.presetId') IS NOT NULL
         AND coalesce(json_type(config_json, '$.overrides'), '') <> 'object'`
    )
    .all() as { id: string; config_json: string }[]
  if (!rows.length) return []
  const env = inheritEnvOf(conn)
  const out: string[] = []
  conn.transaction(() => {
    for (const r of rows) {
      const rec = chatRecordFrom(conn, r.config_json)
      const next = migrateChatOverrides(rec, presetConfigOf(conn, rec.presetId), env)
      if (!next) continue
      writeConfig(conn, r.id, next)
      out.push(r.id)
    }
  })()
  return out
}

/**
 * Persona apagada (local ou tombstone remoto, §7.7): congela cada chat local com aquele `presetId`
 * ANTES de apagar a persona — valores efetivos gravados, voz preenchida, `presetId` removido,
 * `overrides` mantido. Retorna os ids congelados.
 */
export function freezeChatsOfPreset(conn: Conn, presetId: string): string[] {
  const rows = conn
    .prepare(
      `SELECT id, config_json FROM chats
       WHERE json_valid(config_json) AND json_extract(config_json, '$.presetId') = ?`
    )
    .all(presetId) as { id: string; config_json: string }[]
  if (!rows.length) return []
  const env = inheritEnvOf(conn)
  const persona = presetConfigOf(conn, presetId)
  conn.transaction(() => {
    for (const r of rows)
      writeConfig(conn, r.id, freezeChat(chatRecordFrom(conn, r.config_json), persona, env))
  })()
  return rows.map((r) => r.id)
}
