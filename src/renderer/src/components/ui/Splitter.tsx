// Divisor vertical na borda ESQUERDA de um painel encostado à direita (painel de arquivo, painel
// lateral do chat): arrastar, ←/→ (±16 px, Shift ±64), Home = máximo, End = mínimo, duplo clique =
// largura padrão. Durante o arraste `onChange(w, false)` (só atualiza); ao soltar/teclado/duplo
// clique `onChange(w, true)` (quem chama grava a largura — localStorage, local do dispositivo).
import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'

export function Splitter({
  width,
  min,
  max,
  defaultWidth,
  label,
  testId,
  onChange
}: {
  width: number
  min: number
  max: number
  /** Duplo clique volta a esta largura. */
  defaultWidth: number
  /** Nome acessível do separador (ex.: "Redimensionar painel de arquivo"). */
  label: string
  testId?: string
  onChange: (w: number, persist: boolean) => void
}): React.JSX.Element {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const clamp = (w: number): number => Math.round(Math.min(max, Math.max(min, w)))
  const onKey = (e: ReactKeyboardEvent): void => {
    const step = e.shiftKey ? 64 : 16
    let next: number | null = null
    // o painel fica à direita do divisor: ← alarga, → estreita
    if (e.key === 'ArrowLeft') next = width + step
    else if (e.key === 'ArrowRight') next = width - step
    else if (e.key === 'Home') next = max
    else if (e.key === 'End') next = min
    if (next == null) return
    e.preventDefault()
    onChange(clamp(next), true)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={testId}
      onKeyDown={onKey}
      onDoubleClick={() => onChange(clamp(defaultWidth), true)}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: width }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        onChange(clamp(drag.current.w + (drag.current.x - e.clientX)), false)
      }}
      onPointerUp={(e) => {
        if (!drag.current) return
        drag.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        onChange(clamp(width), true)
      }}
      className="group/split absolute inset-y-0 -left-1 z-10 flex w-2 cursor-col-resize justify-center outline-none"
    >
      <span className="h-full w-px bg-transparent transition-colors group-hover/split:bg-accent/50 group-focus-visible/split:bg-accent" />
    </div>
  )
}
