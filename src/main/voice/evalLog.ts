// Log de diagnóstico dos preâmbulos da chamada de voz (SPEC → "Timeline e log de diagnóstico"): um
// JSONL por dia em `<userData>/voice-eval/<YYYY-MM-DD>.jsonl`, UMA LINHA POR DECISÃO de preâmbulo
// (tocado ou não, com o motivo) com ts, variante (frase do pool), latência decisão→emissão e o
// motivo. Serve à calibração futura das regras (v1 é por regra, sem classificador). Sem Electron —
// `baseDir` injetado; escrita tolerante (falha de disco nunca derruba a chamada). Nada de dado além
// disso é gravado (nenhum texto da fala do usuário).
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FILLER_POOL_MAX } from '@shared/voice'

/** Uma decisão de preâmbulo registrada no log (uma linha JSON por decisão). */
export interface VoiceEvalEvent {
  /** Momento da decisão (ms desde epoch). */
  ts: number
  /** Origem da decisão (só o preâmbulo pós-turno). */
  kind: 'filler'
  /** Frase decidida: posição 1-based no pool de preâmbulos (`FILLER_<n>`). */
  variant: number
  /** Tocou de fato (false = descartada — clipe ausente, a resposta chegou antes…). */
  played: boolean
  /** Latência decisão→emissão (ms — carga do clipe incluída). */
  latencyMs: number
  /** Motivo/regra (ex.: 'delay/question', 'tools/command', 'delay/no-clip', 'delay/spoken'). */
  reason: string
}

const int = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN
  return Number.isNaN(n) ? null : Math.max(0, n)
}

/**
 * Normaliza/valida uma linha do log (schema do `VoiceEvalEvent`): lixo → null; números arredondados
 * ≥ 0 e variante fora de 1..`FILLER_POOL_MAX` → null. Testado em `e2e/voiceCallEval.test.ts`.
 */
export function normalizeEvalEvent(v: unknown): VoiceEvalEvent | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  const variant = int(e.variant)
  const ts = int(e.ts)
  if (e.kind !== 'filler' || variant == null || variant < 1 || variant > FILLER_POOL_MAX)
    return null
  if (ts == null) return null
  return {
    ts,
    kind: 'filler',
    variant,
    played: e.played === true,
    latencyMs: int(e.latencyMs) ?? 0,
    reason: typeof e.reason === 'string' && e.reason ? e.reason.slice(0, 64) : ''
  }
}

/** Caminho do log do dia (`<baseDir>/voice-eval/<YYYY-MM-DD>.jsonl`, UTC). */
export function evalLogFile(baseDir: string, at: Date = new Date()): string {
  const day = Number.isNaN(at.getTime()) ? new Date() : at
  return join(baseDir, 'voice-eval', `${day.toISOString().slice(0, 10)}.jsonl`)
}

export interface EvalLogger {
  /** Registra uma decisão (serializado; falha de disco é engolida — nunca derruba a chamada). */
  log(event: VoiceEvalEvent): void
  /** Caminho do arquivo de uma data (padrão: hoje) — UI/testes. */
  file(at?: Date): string
}

/**
 * Logger do log de diagnóstico (escritas append serializadas; o arquivo do dia é criado sob
 * demanda). `onError` (opcional) recebe falhas de escrita para log local.
 */
export function createEvalLogger(baseDir: string, onError?: (e: unknown) => void): EvalLogger {
  let chain: Promise<void> = Promise.resolve()
  return {
    log(event) {
      const normalized = normalizeEvalEvent(event)
      if (!normalized) return
      const line = `${JSON.stringify(normalized)}\n`
      const file = evalLogFile(baseDir, new Date(normalized.ts))
      chain = chain.then(async () => {
        try {
          await mkdir(join(baseDir, 'voice-eval'), { recursive: true })
          await appendFile(file, line, 'utf8')
        } catch (e) {
          onError?.(e)
        }
      })
    },
    file(at) {
      return evalLogFile(baseDir, at)
    }
  }
}
