// Grupo de voz do composer — UM controle `[ telefone | mic | ˅ ]` (`voice-group`, borda única com
// três segmentos): o telefone entra/sai da chamada (`VoiceCallButton`, com as regras dele), o mic
// inicia o ditado e a seta abre o menu do MICROFONE — o mesmo da chamada e do ditado, por isso fica
// depois dos dois (`role="menu"` com itens `menuitemradio` — "Padrão do sistema" + dispositivos
// reais; as entradas sintéticas do Chromium "Default"/"Communications" ficam de fora e o nome do
// padrão atual vai no rótulo do "Padrão do sistema"; microfone salvo que sumiu aparece marcado como
// desconectado), atualiza em hotplug, grava `audioInput.deviceId` e tem o atalho para
// Configurações → Áudio. O foco entra no item marcado ao abrir; ↑/↓ navegam, Esc fecha. Barra
// apertada (`BAR_ITEMS['voice-controls']` nível 1): a seta some e o menu continua no botão direito
// do mic (ou na tecla de menu de contexto/Shift+F10 com o mic focado). Durante o ditado o grupo
// inteiro dá lugar à barra da gravação (Composer).
import { Check, ChevronDown, Mic, Settings2, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/types'
import type { DictationControls } from '../../lib/voice/useDictation'
import { useInputDeviceList } from '../../lib/voice/useInputDevices'
import { formatHotkeyLabel } from '../../lib/voice/hotkeyLabel'
import { menuInputDevices } from '../../lib/audio/devices'
import { barAttrs, useBarLevel } from '../../lib/useBarCollapse'
import { cn } from '../../lib/format'
import { useStore } from '../../store'
import { Popover } from '../ui/layers'
import { Tip } from '../ui/Tooltip'
import { VoiceCallButton } from './VoiceCallButton'

/** Rótulo do menu/seta: o microfone vale para o ditado E para a chamada. */
export const MIC_MENU_LABEL = 'Microfone (ditado e chamada)'

/** Segmento do grupo (altura cheia, sem cantos próprios — o grupo arredonda e recorta). */
const SEGMENT =
  'flex h-full shrink-0 items-center justify-center text-subtle transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:text-fg focus-visible:outline-none'

/**
 * `[ telefone | mic | ˅ ]` na barra do composer (some sem `window.api.voice`). `dictationOff`:
 * motivo para o ditado não estar disponível agora (ex.: chamada ativa em outro chat; a transcrição
 * não configurada/não funciona neste dispositivo — protocolo 1.9.0) — o mic fica visível porém
 * inerte e esmaecido, com o motivo no tooltip; o telefone segue as regras dele. `dictationNote`:
 * aviso discreto no tooltip (a transcrição da persona não está disponível aqui e a padrão deste
 * dispositivo entra no lugar). `voiceState` vai em `data-voice` do mic (testes).
 */
export function VoiceGroup({
  dictation,
  session,
  dictationOff,
  dictationNote,
  voiceState
}: {
  dictation: DictationControls
  session: Session
  dictationOff?: string | null
  dictationNote?: string | null
  voiceState?: 'fallback' | 'unconfigured' | 'unavailable' | null
}): React.JSX.Element | null {
  const level = useBarLevel('voice-controls')
  const [open, setOpen] = useState(false)
  const group = useRef<HTMLDivElement>(null)
  const micRef = useRef<HTMLButtonElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  if (!dictation.available) return null
  const compact = level > 0
  const close = (): void => {
    setOpen(false)
    ;(menuButton.current ?? micRef.current)?.focus()
  }
  const ptt =
    dictation.settings.pttEnabled && dictation.settings.pttKey
      ? formatHotkeyLabel(dictation.settings.pttKey)
      : ''
  const micLabel = dictationOff
    ? dictationOff
    : (compact ? 'Ditar por voz · botão direito: microfone (ditado e chamada)' : 'Ditar por voz') +
      (dictationNote ? ` — ${dictationNote}` : '')
  return (
    <div
      {...barAttrs('voice-controls', level)}
      ref={group}
      role="group"
      aria-label="Voz: chamada, ditado e microfone"
      data-testid="voice-group"
      className="flex h-[30px] shrink-0 items-stretch divide-x divide-border overflow-hidden rounded-lg border border-border bg-elevated/40"
    >
      <VoiceCallButton session={session} className="rounded-none!" />
      <Tip
        label={
          <span className="block max-w-[28rem] leading-snug whitespace-normal">{micLabel}</span>
        }
        shortcut={!dictationOff && ptt ? `segure ${ptt}` : undefined}
      >
        <button
          type="button"
          ref={micRef}
          data-testid="voice-mic-button"
          data-voice={voiceState ?? undefined}
          aria-label="Ditar por voz"
          aria-disabled={dictationOff ? true : undefined}
          onClick={(e) => {
            e.stopPropagation()
            if (!dictationOff) void dictation.start()
          }}
          onContextMenu={(e) => {
            // o menu do microfone também no botão direito (a seta some na barra apertada)
            e.preventDefault()
            e.stopPropagation()
            setOpen(true)
          }}
          className={cn(
            SEGMENT,
            'w-7',
            dictationOff && 'cursor-default opacity-40 hover:bg-transparent'
          )}
        >
          <Mic className="size-4" />
        </button>
      </Tip>
      {!compact && (
        <Tip label={MIC_MENU_LABEL}>
          <button
            type="button"
            ref={menuButton}
            data-testid="voice-mic-menu-button"
            onClick={(e) => {
              e.stopPropagation()
              setOpen((o) => !o)
            }}
            aria-label={MIC_MENU_LABEL}
            aria-haspopup="menu"
            aria-expanded={open}
            className={cn(SEGMENT, 'w-5 text-faint', open && 'bg-hover text-fg')}
          >
            <ChevronDown className="size-3.5" />
          </button>
        </Tip>
      )}
      {open && (
        <Popover open={open} onClose={close} anchor={group} width={300} maxHeight={360} align="end">
          <MicMenu dictation={dictation} onClose={close} />
        </Popover>
      )}
    </div>
  )
}

function MicMenu({
  dictation,
  onClose
}: {
  dictation: DictationControls
  onClose: () => void
}): React.JSX.Element {
  const { devices: all, loaded } = useInputDeviceList()
  const { systemLabel, devices } = menuInputDevices(all)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const current = dictation.settings.deviceId
  // microfone salvo que não está na lista (desconectado): fica visível, marcado, com aviso
  // (lista sem permissão vem com deviceIds vazios — aí não dá para saber, não marca)
  const missing =
    loaded &&
    current !== null &&
    all.every((d) => !!d.deviceId) &&
    !all.some((d) => d.deviceId === current)
  const menuRef = useRef<HTMLDivElement>(null)
  const pick = (deviceId: string | null): void => {
    void dictation.updateSettings({ deviceId })
    onClose()
  }
  // foco no item marcado ao abrir (ou no primeiro)
  useEffect(() => {
    const root = menuRef.current
    if (!root) return
    const target =
      root.querySelector<HTMLElement>('[role=menuitemradio][aria-checked=true]') ??
      root.querySelector<HTMLElement>('[role=menuitemradio]')
    target?.focus()
  }, [all.length])
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role^=menuitem]') ?? [])
    ].filter((el) => !(el as HTMLButtonElement).disabled)
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i - 1 + items.length) % items.length
    items[next]?.focus()
  }
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={MIC_MENU_LABEL}
      data-testid="voice-mic-menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <p className="border-b border-border px-3 py-2 text-[11px] text-subtle">
        Microfone do ditado e da chamada (o mesmo de Configurações → Áudio)
      </p>
      <div className="max-h-[260px] overflow-y-auto p-1">
        <MenuItem
          testId="voice-mic-option-system"
          label={systemLabel ? `Padrão do sistema (${systemLabel})` : 'Padrão do sistema'}
          checked={current === null}
          onClick={() => pick(null)}
        />
        {missing && (
          <MenuItem
            testId="voice-mic-option-missing"
            label="Microfone salvo (desconectado)"
            hint="Não encontrado — a gravação usa o padrão do sistema"
            checked
            warning
            onClick={() => pick(null)}
          />
        )}
        {devices.map((d, i) => (
          <MenuItem
            key={d.deviceId}
            testId="voice-mic-option-device"
            label={d.label || `Microfone ${i + 1}`}
            checked={current === d.deviceId}
            onClick={() => pick(d.deviceId)}
          />
        ))}
        {devices.length === 0 && (
          <p className="px-2.5 py-2 text-[11.5px] text-subtle">
            Nenhum microfone encontrado (ou permissão ainda não concedida).
          </p>
        )}
      </div>
      <button
        type="button"
        role="menuitem"
        data-testid="voice-settings-link"
        onClick={() => {
          onClose()
          setSettingsOpen(true, 'audio')
        }}
        className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:bg-hover focus-visible:outline-none"
      >
        <Settings2 className="size-3.5" />
        Configurações → Áudio…
      </button>
    </div>
  )
}

function MenuItem({
  label,
  hint,
  checked,
  warning,
  onClick,
  testId
}: {
  label: string
  hint?: string
  checked: boolean
  warning?: boolean
  onClick: () => void
  testId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-testid={testId}
      data-checked={checked ? 'true' : 'false'}
      title={hint}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none',
        checked ? 'text-fg' : 'text-muted',
        warning && 'text-warning'
      )}
    >
      {warning && <TriangleAlert className="size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block truncate text-[10.5px] text-subtle">{hint}</span>}
      </span>
      {checked && !warning && <Check className="size-3.5 shrink-0 text-accent-strong" />}
    </button>
  )
}
