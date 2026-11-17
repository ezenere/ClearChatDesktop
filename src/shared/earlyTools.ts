// Execução antecipada de ferramentas (2026-11-17) — política PURA (runner do desktop e do celular).
// Antes, nenhuma tool rodava até o modelo terminar a resposta INTEIRA: duas "Abrir URL" já completas
// esperavam o `write_file` seguinte acabar de ser gerado (minutos). Agora uma chamada que FECHOU no
// stream (argumentos completos) começa na hora, enquanto o modelo continua — desde que:
//   - seja só de LEITURA (`EARLY_TOOLS`: nada muda fora do app — ler, buscar, abrir página…). O motivo
//     de parada (corte por max_tokens, recusa do classificador de segurança) só chega no FIM da
//     resposta: uma recusa pode vir depois de um shell/write_file já completo, e uma ação feita não
//     se desfaz. Leitura não tem o que desfazer — na recusa o resultado só é descartado;
//   - rode sem perguntar (a mesma rota de aprovação da execução: só `run` — nem o juiz do
//     Smart-Approve nem o card do usuário durante o stream); conector (MCP) nunca;
//   - a ORDEM não mude: dispara o prefixo de chamadas completas e elegíveis; a 1ª que não for
//     (efeito, aprovação, argumentos inválidos) fecha a fila — dali em diante tudo roda no fim, em
//     ordem (um `read_file` depois de um `write_file` lê o arquivo novo).
// As antecipadas rodam uma de cada vez (como no fim); os resultados entram no histórico na ordem,
// depois da mensagem do assistente. Ver SPEC.md → "Execução antecipada de ferramentas".

/** Tools só de leitura que podem rodar durante o stream (sem efeito fora do app). */
export const EARLY_TOOLS: ReadonlySet<string> = new Set([
  'list_dir',
  'read_file',
  'search_files',
  'find_files',
  'web_search',
  'browse_url',
  'list_models',
  'get_chat_info',
  'list_chats',
  'read_history',
  'check_subagents',
  'process_list',
  'process_logs',
  'datetime',
  'weather',
  'memory_search',
  'memory_read',
  'list_skills',
  'skill_read',
  'schedule_list'
])

/** Uma tool call do stream (a do acumulador): `complete` = os argumentos fecharam. */
export interface EarlyCall {
  id: string
  name: string
  arguments: string
  complete?: boolean
}

/** Argumentos que viram um objeto JSON (o que a execução aceitaria). */
export function earlyArgsOk(raw: string): boolean {
  if (!raw.trim()) return true
  try {
    const v: unknown = JSON.parse(raw)
    return !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

/**
 * A fila da execução antecipada de UMA resposta do modelo. `offer(acc.toolCalls)` a cada atualização
 * do stream dispara, em ordem e uma de cada vez, as chamadas completas e elegíveis do começo da
 * lista; `take(id)` devolve a execução dela (null = não começou — roda no fim, como antes);
 * `discard()` quando a resposta é descartada (stream refeito/cancelado): nada novo começa e o que
 * estava em voo é ignorado.
 */
export class EarlyToolQueue<R> {
  readonly #eligible: (c: EarlyCall) => boolean
  readonly #run: (c: EarlyCall) => Promise<R>
  readonly #started = new Map<string, Promise<R>>()
  readonly #order: string[] = []
  #closed = false
  #discarded = false
  #chain: Promise<unknown> = Promise.resolve()

  constructor(opts: { eligible: (c: EarlyCall) => boolean; run: (c: EarlyCall) => Promise<R> }) {
    this.#eligible = opts.eligible
    this.#run = opts.run
  }

  /** Ids que começaram antes do fim, na ordem. */
  get startedIds(): readonly string[] {
    return this.#order
  }

  get discarded(): boolean {
    return this.#discarded
  }

  offer(calls: readonly (EarlyCall | undefined | null)[]): void {
    if (this.#closed || this.#discarded) return
    for (const c of calls) {
      // buraco (índice sem nada ainda) ou a próxima ainda sendo gerada: espera
      if (!c || !c.complete) return
      if (c.id && this.#started.has(c.id)) continue
      if (!c.id || !c.name || !earlyArgsOk(c.arguments) || !this.#eligible(c)) {
        // a ordem não muda: daqui em diante tudo roda no fim
        this.#closed = true
        return
      }
      const p = this.#chain.then(() => this.#run(c))
      this.#chain = p.catch(() => undefined)
      this.#started.set(c.id, p)
      this.#order.push(c.id)
    }
  }

  take(id: string): Promise<R> | null {
    if (this.#discarded) return null
    return this.#started.get(id) ?? null
  }

  discard(): void {
    this.#discarded = true
    this.#closed = true
  }

  /** Espera as antecipadas em voo terminarem (sem lançar). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#started.values()])
  }
}
