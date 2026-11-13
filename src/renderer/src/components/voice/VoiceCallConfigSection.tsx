// Chamada de voz por persona/chat (`ChatConfig.voice`, SPEC → "Chamada de voz — configuração por
// persona/chat"): liga/desliga (★ = herda — no chat, da persona de origem; na persona, do padrão
// global), modelo da chamada + parâmetros (`VoiceCallModelEditor`), tools próprias, o modo do
// prompt (complementar/substituto/nenhum) e o prompt do modo voz. Usada no painel do chat (aba
// Chat) e no editor de personas (aba Chat); precedência chat > persona > global (campos null do
// chat seguem a persona ao vivo). Os preâmbulos (fillers) ficam no painel da chamada.
// Transparência (2026-11-12 — "o ClearChat não pode colocar prompts de sistema ou configurações
// ocultas"): o ÚNICO texto que a chamada muda é o "Prompt do modo voz" + a instrução das tags (só
// com o opt-in) — e os dois campos ("Prompt do modo voz", depois "Tags de voz" com a instrução) são
// o próprio texto que entra na request, nessa ordem.
import { useState } from 'react'
import { TOOL_DEFINITIONS, TOOL_LABELS, TOOL_NAMES } from '@shared/tools'
import { withTool } from '@shared/deviceTools'
import type { ChatConfig, ToolName } from '@shared/types'
import { compactToolsOn } from '@shared/compactTools'
import {
  DEFAULT_VOICE_CALL_CONFIG,
  VOICE_CALL_PROMPT_MODES,
  normalizeVoiceCallConfig,
  resolveVoiceCallConfig,
  resolveVoiceCallEnabled,
  SUGGESTED_VOICE_PROMPT,
  type VoiceCallConfig,
  type VoiceCallPromptMode
} from '@shared/voice'
import { cn } from '../../lib/format'
import { useVoiceSettings } from '../../lib/voice/voiceSettings'
import { useStore } from '../../store'
import { CollapsibleSection, ToggleRow } from '../panel/fields'
import { PhoneToolsGroup } from '../panel/PhoneToolsGroup'
import { AutoTextarea, Button, Switch } from '../ui/controls'
import { InheritChoice } from '../ui/InheritChoice'
import { AudioTagsField } from './AudioTagsField'
import { DEFAULT_AUDIO_TAGS_PROMPT } from '@shared/audioTags'
import { ApiInfo, C } from '../ui/Tooltip'
import { ToolDefInfo } from '../apiDocs'
import { VoiceCallModelEditor } from './VoiceCallModelEditor'

export function VoiceCallConfigSection({
  cfg,
  patch,
  scope = 'chat',
  defaultOpen = false
}: {
  cfg: ChatConfig
  patch: (p: Partial<ChatConfig>) => void
  /** Texto dos rótulos ("neste chat" × "nesta persona"). */
  scope?: 'chat' | 'persona'
  /** Aberta por padrão (na aba própria "Voz"). */
  defaultOpen?: boolean
}): React.JSX.Element {
  const defaults = useVoiceSettings((s) => s.view.voiceCallDefaults)
  const globalEnabled = defaults.enabled
  // chat: a persona de origem é a camada do meio (chat > persona > global), lida ao vivo
  const presetId = scope === 'chat' ? (cfg.presetId ?? null) : null
  const persona = useStore((s) =>
    presetId ? (s.presets.find((p) => p.id === presetId) ?? null) : null
  )
  const personaVoice = persona?.config.voice ?? null
  // normalizado: campos legados de registros antigos (`interjections`) nunca são regravados
  const voice: VoiceCallConfig = cfg.voice
    ? normalizeVoiceCallConfig(cfg.voice)
    : DEFAULT_VOICE_CALL_CONFIG
  const set = (p: Partial<VoiceCallConfig>): void => patch({ voice: { ...voice, ...p } })
  const where = scope === 'chat' ? 'neste chat' : 'nesta persona'
  const { enabled, source } = resolveVoiceCallEnabled(voice, personaVoice, defaults)
  const resolved = resolveVoiceCallConfig(voice, defaults, personaVoice)
  // o que o "★" herda neste nível (persona no chat; global na persona)
  const inheritedEnabled = personaVoice?.enabled != null ? personaVoice.enabled : globalEnabled
  const inheritedFrom =
    personaVoice?.enabled != null ? `persona ${persona?.name ?? ''}`.trim() : 'global'
  const changed =
    voice.enabled !== null ||
    !!voice.model ||
    !!voice.tools ||
    !!voice.voicePrompt?.trim() ||
    !!voice.promptMode ||
    voice.endCall != null ||
    voice.audioTags != null ||
    !!voice.audioTagsPrompt ||
    voice.toolPhrases != null
  const summary = !enabled
    ? source === 'persona' && scope === 'chat'
      ? 'desligada pela persona'
      : 'desligada'
    : [
        resolved.model && 'modelo próprio',
        voice.tools && 'tools próprias',
        resolved.promptMode !== 'append'
          ? resolved.promptMode === 'replace'
            ? 'prompt substituto'
            : 'sem prompt de voz'
          : resolved.voicePrompt && 'prompt'
      ]
        .filter(Boolean)
        .join(' · ') || (voice.enabled === null ? 'padrão' : 'ligada')
  // modelo herdado quando vazio neste nível (mensagem do editor)
  const inheritedModel =
    scope === 'chat' && personaVoice?.model
      ? `o da persona (${personaVoice.model.model})`
      : defaults.model
        ? `o padrão global (${defaults.model.model})`
        : scope === 'chat'
          ? `o modelo do chat (${cfg.model || '—'})`
          : 'o modelo do chat'
  return (
    <CollapsibleSection
      id={`voice-call-${scope}`}
      title="Chamada de voz"
      section="voice-call"
      defaultOpen={defaultOpen}
      summary={{ text: summary, changed }}
      warning={!enabled ? `Chamada de voz desligada ${where}` : undefined}
      help={
        'Conversa falada com o agente (telefone no composer). Aqui: se a chamada fica disponível ' +
        `${where} e o que muda só nos turnos de voz — modelo e parâmetros, tools e o prompt do modo voz. ` +
        'Sem override, a chamada usa o modelo e as tools do próprio chat (com o raciocínio desligado).\nNo histórico, as falas da chamada aparecem em itálico (com o mic/alto-falante) entre os marcadores de início e fim da chamada; a config salva do chat nunca muda.'
      }
    >
      <div data-testid="voice-call-config" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-fg/90">Disponível {where}</span>
          <InheritChoice
            label={`Chamada de voz ${where}`}
            testId="voice-call-enabled"
            options={[
              { value: true, label: 'Ligada' },
              { value: false, label: 'Desligada' }
            ]}
            value={voice.enabled}
            inherited={inheritedEnabled}
            inheritedFrom={
              inheritedFrom === 'global'
                ? 'Padrão global (Configurações → Áudio → Chamada de voz)'
                : `Padrão da ${inheritedFrom}`
            }
            onChange={(v) => set({ enabled: v })}
          />
        </div>
        {!enabled && (
          <p data-testid="voice-call-disabled-note" className="text-[11.5px] text-warning">
            {source === 'persona' && scope === 'chat'
              ? `A persona “${persona?.name ?? ''}” desliga a chamada: o telefone fica desabilitado neste chat. Escolha “Ligada” para usar mesmo assim.`
              : source === 'global'
                ? 'Desligada em Configurações → Áudio: o telefone some dos chats sem override.'
                : `O telefone fica desabilitado ${scope === 'chat' ? 'neste chat' : 'nos chats desta persona (um chat pode religar)'}.`}
          </p>
        )}
        {enabled && (
          <>
            <VoiceCallModelEditor
              value={voice.model}
              onChange={(model) => set({ model })}
              scope={scope}
              inherited={inheritedModel}
            />
            <ToggleRow
              label="Tools próprias na chamada"
              help="Desligado: as mesmas tools do chat. Ligado: só as tools marcadas abaixo valem nos turnos de voz (nenhuma marcada = a chamada não usa tools)."
              checked={!!voice.tools?.enabledTools}
              onChange={(on) =>
                set({
                  tools: on
                    ? {
                        enabledTools: [...cfg.enabledTools],
                        maxToolOutputChars: voice.tools?.maxToolOutputChars ?? null
                      }
                    : null
                })
              }
            />
            {voice.tools?.enabledTools && (
              <VoiceToolsList
                cfg={cfg}
                tools={voice.tools.enabledTools}
                onChange={(enabledTools) =>
                  set({
                    tools: {
                      enabledTools,
                      maxToolOutputChars: voice.tools?.maxToolOutputChars ?? null
                    }
                  })
                }
              />
            )}
            <EndCallField
              value={voice.endCall ?? null}
              inherited={
                scope === 'chat' && personaVoice?.endCall != null
                  ? personaVoice.endCall
                  : defaults.endCall
              }
              inheritedFrom={
                scope === 'chat' && personaVoice?.endCall != null
                  ? 'Padrão da persona'
                  : 'Padrão global'
              }
              onChange={(endCall) => set({ endCall })}
            />
            <ToolPhrasesField
              value={voice.toolPhrases ?? null}
              inherited={
                scope === 'chat' && personaVoice?.toolPhrases != null
                  ? personaVoice.toolPhrases
                  : defaults.toolPhrases.enabled
              }
              inheritedFrom={
                scope === 'chat' && personaVoice?.toolPhrases != null
                  ? 'Padrão da persona'
                  : 'Padrão global'
              }
              onChange={(toolPhrases) => set({ toolPhrases })}
            />
            <VoicePromptModeField
              value={voice.promptMode ?? null}
              inherited={
                scope === 'chat' && personaVoice?.promptMode ? personaVoice.promptMode : 'append'
              }
              inheritedFrom={
                scope === 'chat' && personaVoice?.promptMode ? 'Padrão da persona' : 'Padrão global'
              }
              onChange={(promptMode) => set({ promptMode })}
            />
            {resolved.promptMode !== 'none' && (
              <VoicePromptField
                value={voice.voicePrompt ?? ''}
                inheritedText={
                  scope === 'chat' && !voice.voicePrompt
                    ? (personaVoice?.voicePrompt ?? null)
                    : null
                }
                mode={resolved.promptMode}
                onCommit={(text) => set({ voicePrompt: text.trim() ? text : null })}
              />
            )}
            <AudioTagsField
              value={voice.audioTags ?? null}
              inherited={
                scope === 'chat' && personaVoice?.audioTags != null
                  ? personaVoice.audioTags
                  : defaults.audioTags
              }
              inheritedFrom={
                scope === 'chat' && personaVoice?.audioTags != null
                  ? 'Padrão da persona'
                  : 'Padrão global'
              }
              prompt={voice.audioTagsPrompt ?? null}
              inheritedPrompt={
                (scope === 'chat' ? personaVoice?.audioTagsPrompt : null) ??
                defaults.audioTagsPrompt ??
                DEFAULT_AUDIO_TAGS_PROMPT
              }
              onChange={(audioTags) => set({ audioTags })}
              onPromptChange={(audioTagsPrompt) => set({ audioTagsPrompt })}
            />
          </>
        )}
      </div>
    </CollapsibleSection>
  )
}

/**
 * "O agente pode encerrar a chamada" (tool `end_call` nos turnos de voz): Sim / Não com ★ no valor
 * herdado (persona no chat; Configurações → Áudio na persona) — escolher o ★ volta a herdar.
 */
function EndCallField({
  value,
  inherited,
  inheritedFrom,
  onChange
}: {
  value: boolean | null
  inherited: boolean
  inheritedFrom: string
  onChange: (v: boolean | null) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1 text-[13px] text-fg/90">
        O agente pode encerrar a chamada
        <ApiInfo title="Tool end_call (só nos turnos da chamada, sem aprovação)">
          <p>
            Quando você se despede ou pede para desligar, o agente diz uma despedida curta e
            encerra: a chamada cai depois de a despedida tocar. Se você voltar a falar antes, ela
            continua.
          </p>
          <p>
            Ligado, a tool vai na lista de tools dos turnos de voz com esta descrição (nenhuma
            instrução extra no prompt) — sempre completa, mesmo com as tools compactadas:
          </p>
          <p
            className="font-mono text-[11px] whitespace-pre-wrap"
            data-testid="end-call-description"
          >
            {TOOL_DEFINITIONS.end_call.function.description}
          </p>
        </ApiInfo>
      </span>
      <InheritChoice
        label="O agente pode encerrar a chamada"
        testId="voice-call-end-call"
        options={[
          { value: true, label: 'Sim' },
          { value: false, label: 'Não' }
        ]}
        value={value}
        inherited={inherited}
        inheritedFrom={inheritedFrom}
        onChange={onChange}
      />
    </div>
  )
}

/**
 * "Frases de ferramenta" (1ª tool do turno fala "Vou pesquisar isso." — SPEC → "Frases de
 * ferramenta"): Ligadas / Desligadas com ★ no valor herdado; as frases em si são globais.
 */
function ToolPhrasesField({
  value,
  inherited,
  inheritedFrom,
  onChange
}: {
  value: boolean | null
  inherited: boolean
  inheritedFrom: string
  onChange: (v: boolean | null) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1 text-[13px] text-fg/90">
        Frases de ferramenta
        <ApiInfo title="Frase curta na 1ª tool do turno">
          <p>
            Quando o agente usa uma ferramenta na chamada, fala uma frase curta sobre ela (&quot;Vou
            pesquisar isso.&quot;, &quot;Vou rodar isso aqui.&quot;) — no máximo uma por turno, e
            nunca se ele já falou algo antes da tool. As frases ficam em Configurações → Áudio →
            Chamada de voz.
          </p>
        </ApiInfo>
      </span>
      <InheritChoice
        label="Frases de ferramenta"
        testId="voice-call-tool-phrases-toggle"
        options={[
          { value: true, label: 'Ligadas' },
          { value: false, label: 'Desligadas' }
        ]}
        value={value}
        inherited={inherited}
        inheritedFrom={inheritedFrom}
        onChange={onChange}
      />
    </div>
  )
}

const PROMPT_MODE_LABEL: Record<VoiceCallPromptMode, string> = {
  append: 'Complementar',
  replace: 'Substituto',
  none: 'Nenhum'
}
const PROMPT_MODE_HELP: Record<VoiceCallPromptMode, string> = {
  append: 'System prompt normal + o prompt do modo voz no fim (padrão).',
  replace: 'Na chamada, o prompt do modo voz SUBSTITUI o system prompt normal.',
  none: 'Sem prompt de voz: só o system prompt normal.'
}

/** Como o prompt do modo voz compõe com o system prompt (★ no modo herdado da persona/padrão). */
function VoicePromptModeField({
  value,
  inherited,
  inheritedFrom,
  onChange
}: {
  value: VoiceCallPromptMode | null
  inherited: VoiceCallPromptMode
  inheritedFrom: string
  onChange: (mode: VoiceCallPromptMode | null) => void
}): React.JSX.Element {
  const effective = value ?? inherited
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted">Prompt na chamada</span>
        <ApiInfo title="Como o prompt do modo voz entra nas requests da chamada">
          <p>
            <b>Complementar</b>: system prompt normal + prompt do modo voz no fim.
          </p>
          <p>
            <b>Substituto</b>: o prompt do modo voz NO LUGAR do system prompt normal (prompt do modo
            voz vazio = nada a pôr no lugar → como complementar).
          </p>
          <p>
            <b>Nenhum</b>: só o system prompt normal.
          </p>
          <p>
            O app não acrescenta prompt próprio: além do prompt do modo voz, só a instrução das tags
            de voz, quando você as liga.
          </p>
        </ApiInfo>
      </div>
      <InheritChoice
        label="Prompt na chamada"
        testId="voice-call-prompt-mode"
        stretch
        options={VOICE_CALL_PROMPT_MODES.map((m) => ({
          value: m,
          label: PROMPT_MODE_LABEL[m],
          title: PROMPT_MODE_HELP[m]
        }))}
        value={value}
        inherited={inherited}
        inheritedFrom={inheritedFrom}
        onChange={onChange}
      />
      <p className="mt-1 text-[11px] text-subtle">{PROMPT_MODE_HELP[effective]}</p>
    </div>
  )
}

function VoiceToolsList({
  cfg,
  tools,
  onChange
}: {
  /** Config do chat/persona: a compactação da chamada é a dela (aba Tools). */
  cfg: ChatConfig
  tools: ToolName[]
  onChange: (tools: ToolName[]) => void
}): React.JSX.Element {
  return (
    <div
      data-testid="voice-call-tools"
      className="-mx-1.5 max-h-[220px] space-y-px overflow-y-auto rounded-lg border border-border/60 py-1"
    >
      <p className="px-2.5 pb-1 text-[11px] leading-snug text-faint">
        {compactToolsOn(cfg)
          ? 'Vão compactas como no chat (aba Tools → “Enviar tools compactadas”); o </> mostra o que vai.'
          : 'Vão completas como no chat (aba Tools → “Enviar tools compactadas” desligado).'}
      </p>
      {TOOL_NAMES.map((t) => {
        const on = tools.includes(t)
        return (
          <div
            key={t}
            data-tool={t}
            className="flex h-7 items-center gap-2.5 rounded-lg px-2.5 hover:bg-hover/50"
          >
            <Switch
              size="sm"
              checked={on}
              label={TOOL_LABELS[t]}
              onChange={(v) => onChange(withTool(tools, t, v))}
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[12px]',
                on ? 'text-fg/90' : 'text-subtle'
              )}
            >
              {TOOL_LABELS[t]}
            </span>
            <span className="truncate font-mono text-[10.5px] text-faint">{t}</span>
            <ToolDefInfo name={t} nativeTools={cfg.nativeTools} cfg={cfg} />
          </div>
        )
      })}
      {/* só no celular (§4.3.6): na lista, alternáveis, mas nunca enviadas daqui */}
      <div className="px-1">
        <PhoneToolsGroup
          tools={tools}
          marks={false}
          onToggle={(t, v) => onChange(withTool(tools, t, v))}
        />
      </div>
    </div>
  )
}

/** Acréscimo ao system prompt no modo voz (rascunho local; grava no blur). */
function VoicePromptField({
  value,
  inheritedText,
  mode,
  onCommit
}: {
  value: string
  /** Prompt herdado da persona (chat sem prompt próprio) — mostrado como placeholder. */
  inheritedText: string | null
  mode: VoiceCallPromptMode
  onCommit: (text: string) => void
}): React.JSX.Element {
  // rascunho só enquanto edita; fora disso mostra o valor salvo
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted">Prompt do modo voz</span>
        <ApiInfo
          title={
            mode === 'replace'
              ? 'Substitui o system prompt nos turnos de voz'
              : 'Somado ao system prompt nos turnos de voz'
          }
        >
          <p>
            {mode === 'replace'
              ? 'Vai NO LUGAR do system prompt do chat'
              : 'Vai no fim do system prompt do chat, separado por uma linha em branco,'}{' '}
            em TODAS as requests feitas durante a chamada (inclusive respostas a mensagens digitadas
            enquanto a chamada está ativa). Fora da chamada nada muda.
          </p>
          <p>
            Ex.: <C>Responda em frases curtas e naturais, sem markdown nem listas.</C>
          </p>
          <p>
            Vazio (padrão) = a chamada manda exatamente o system prompt normal. “Usar sugestão”
            insere um texto sugerido NESTE campo, onde você o vê e edita — só ele vai à request.
          </p>
        </ApiInfo>
        {!(draft ?? value).trim() && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 px-2 text-[11px]"
            data-testid="voice-call-prompt-suggest"
            onClick={() => {
              setDraft(null)
              onCommit(SUGGESTED_VOICE_PROMPT)
            }}
          >
            Usar sugestão
          </Button>
        )}
      </div>
      <AutoTextarea
        value={draft ?? value}
        minRows={2}
        maxRows={8}
        aria-label="Prompt do modo voz"
        data-testid="voice-call-prompt"
        placeholder={
          inheritedText
            ? `da persona: ${inheritedText}`
            : 'ex.: responda em frases curtas e naturais, sem markdown'
        }
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft)
          setDraft(null)
        }}
        className="field w-full px-2.5 py-1.5 text-[12.5px] leading-5"
      />
    </div>
  )
}
