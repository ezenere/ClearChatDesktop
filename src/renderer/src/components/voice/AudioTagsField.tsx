// "Tags de voz (ElevenLabs v3/v4 e Fish Audio Drama 3/S2)" — opt-in por persona/chat (★ herda) e no
// padrão global: liga a instrução que deixa a IA escrever tags como [laughs]/[whispers] (ou direções
// livres do Fish — "[warm, softly]") que mudam o jeito da voz falar, e o texto EXATO dessa instrução
// (editável; "Usar o padrão" volta ao do app). A instrução só entra no prompt da chamada com a voz da
// chamada interpretando tags (`supportsAudioTags`); sem suporte as tags são tiradas da fala (nunca
// lidas em voz alta). Ver SPEC.md → "Chamada de voz → Tags de voz".
import { useState } from 'react'
import { DEFAULT_AUDIO_TAGS_PROMPT, AUDIO_TAGS_PROMPT_MAX } from '@shared/audioTags'
import { useCallTtsTagsSupport } from '../../lib/voice/audioTagsSupport'
import { InheritChoice } from '../ui/InheritChoice'
import { Button, Switch } from '../ui/controls'
import { HelpTip } from '../ui/Tooltip'

/** Texto curto do que as tags fazem (o (?) dos editores). */
const HELP =
  'Com as tags de voz ligadas, a IA pode escrever marcas como [risos], [sussurra], [suspira] ou [animado] no meio da fala — elas mudam o jeito da voz falar (riso, sussurro, pausa, emoção). Só os modelos de voz ElevenLabs Eleven v3/v4 e Fish Audio Drama 3/S2 Pro/S2.1 Pro interpretam; nos demais as tags são tiradas antes da síntese (nunca lidas em voz alta). No chat elas aparecem esmaecidas no texto da resposta.'

export function AudioTagsField({
  value,
  inherited,
  inheritedFrom,
  prompt,
  inheritedPrompt,
  onChange,
  onPromptChange,
  global = false
}: {
  /** Override deste nível (null = herda); no global, o valor gravado. */
  value: boolean | null
  /** Valor herdado (persona/global) — ★; no global, ignorado. */
  inherited: boolean
  inheritedFrom: string
  /** Texto deste nível (null = herda/padrão). */
  prompt: string | null
  /** Texto herdado (persona/global/padrão do app) — o que vale quando `prompt` é null. */
  inheritedPrompt: string
  onChange: (v: boolean | null) => void
  onPromptChange: (text: string | null) => void
  /** Editor do padrão global (switch em vez do ★). */
  global?: boolean
}): React.JSX.Element {
  const { supported, model } = useCallTtsTagsSupport()
  const on = value ?? inherited
  const effectivePrompt = prompt ?? inheritedPrompt
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft == null) return
    const t = draft.replace(/\r/g, '').trim()
    setDraft(null)
    // igual ao herdado (ou vazio) = volta a herdar
    onPromptChange(!t || t === inheritedPrompt.trim() ? null : t.slice(0, AUDIO_TAGS_PROMPT_MAX))
  }
  return (
    <div className="space-y-1.5" data-testid="voice-call-audio-tags">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-[13px] text-fg/90">
          Tags de voz (ElevenLabs v3/v4 e Fish Audio Drama 3/S2)
          <HelpTip label="Tags de voz">
            <p>{HELP}</p>
            <p className="mt-1.5">Instrução somada ao prompt da chamada quando ligadas:</p>
            <p className="mt-1 font-mono text-[11px] whitespace-pre-wrap">{effectivePrompt}</p>
          </HelpTip>
        </span>
        {global ? (
          <Switch size="sm" checked={on} label="Tags de voz" onChange={(v) => onChange(v)} />
        ) : (
          <InheritChoice
            label="Tags de voz"
            testId="voice-call-audio-tags-choice"
            options={[
              { value: true, label: 'Ligadas' },
              { value: false, label: 'Desligadas' }
            ]}
            value={value}
            inherited={inherited}
            inheritedFrom={inheritedFrom}
            onChange={onChange}
          />
        )}
      </div>
      {on && !supported && (
        <p data-testid="voice-call-audio-tags-unsupported" className="text-[11.5px] text-warning">
          O modelo de voz atual{model ? ` (${model})` : ''} não interpreta tags — elas serão
          removidas da fala.
        </p>
      )}
      <div className={on ? '' : 'opacity-60'}>
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-medium text-muted">Instrução das tags</span>
          {prompt != null && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px]"
              data-testid="voice-call-audio-tags-reset"
              disabled={!on}
              onClick={() => {
                setDraft(null)
                onPromptChange(null)
              }}
            >
              Usar o padrão
            </Button>
          )}
        </div>
        <textarea
          value={draft ?? effectivePrompt}
          disabled={!on}
          spellCheck={false}
          aria-label="Instrução das tags de voz"
          data-testid="voice-call-audio-tags-prompt"
          rows={4}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          className="field min-h-[72px] resize-y text-[12px] leading-relaxed"
        />
        {prompt == null && (
          <p className="mt-0.5 text-[11px] text-subtle">
            {inheritedPrompt === DEFAULT_AUDIO_TAGS_PROMPT
              ? 'Texto padrão do app.'
              : `Herdado (${inheritedFrom.toLowerCase()}).`}
          </p>
        )}
      </div>
    </div>
  )
}
