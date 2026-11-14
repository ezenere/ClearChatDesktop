// Largura do painel lateral do chat (abas Modelo · Chat · Tools · Memória · Voz · Arquivos):
// redimensionável pelo divisor da borda esquerda (o mesmo do painel de arquivo — ui/Splitter) e
// lembrada só neste dispositivo (localStorage `clearchat.panel.width`; nunca sincroniza — protocolo
// §4.4). Sem React aqui (testado em e2e/unit.test.ts).

export const PANEL_WIDTH_KEY = 'clearchat.panel.width'
export const PANEL_DEFAULT_WIDTH = 384
export const PANEL_MIN_WIDTH = 320
export const PANEL_MAX_WIDTH = 720
/** Gaveta sobreposta (janela estreita): no máximo esta fração da linha (= o `max-w-[85%]`). */
export const PANEL_OVERLAY_MAX_FRACTION = 0.85

/** Largura salva (texto do localStorage) → px; ausente/inválida/pequena demais → padrão. */
export function parsePanelWidth(raw: string | null | undefined): number {
  if (raw == null || raw === '') return PANEL_DEFAULT_WIDTH
  const v = Number(raw)
  if (!Number.isFinite(v) || v < PANEL_MIN_WIDTH) return PANEL_DEFAULT_WIDTH
  return Math.round(Math.min(PANEL_MAX_WIDTH, v))
}

/**
 * Máximo do painel na linha do chat (`rowWidth`): em coluna, o que sobra depois de `reserved` (o
 * mínimo do chat + o do painel de arquivo, se aberto); na gaveta, 85% da linha. Nunca abaixo do
 * mínimo nem acima do teto. Linha ainda não medida (0) → o teto.
 */
export function panelMaxWidth(
  rowWidth: number,
  opts: { overlay: boolean; reserved: number }
): number {
  if (!(rowWidth > 0)) return PANEL_MAX_WIDTH
  const room = opts.overlay
    ? Math.floor(rowWidth * PANEL_OVERLAY_MAX_FRACTION)
    : rowWidth - opts.reserved
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(room)))
}

/** Largura mostrada: a escolhida, dentro de [mínimo, `max`]. */
export function clampPanelWidth(width: number, max: number): number {
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, width)))
}
