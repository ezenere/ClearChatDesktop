// Configurações → Novos chats → "Título automático": modelo do título (padrão Nenhum), memórias,
// limite de tokens e prompt editável. Config global em `settings.autoTitle` (sincroniza entre os
// dispositivos desde o protocolo 1.4.0).
// Ver SPEC.md → "Título automático".
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  AUTO_TITLE_DEFAULTS,
  autoTitleEnabled,
  autoTitleUserContent,
  normalizeAutoTitleSettings,
  type AutoTitleSettings
} from '@shared/autoTitle'
import { DEFAULT_AUTO_TITLE_PROMPT } from '@shared/defaults'
import { useStore } from '../store'
import { cn } from '../lib/format'
import { AutoTextarea, Label } from './ui/controls'
import { ModelPicker } from './ui/ModelPicker'
import { ApiInfo, C, HelpTip, Tip } from './ui/Tooltip'
import { ModelInfoLine } from './panel/editors'
import { SideThinkingField } from './panel/SideThinkingField'
import { useSideRequestPreview } from '../lib/sideReasoning'
import { SIDE_THINKING } from '@shared/sideReasoning'
import { NumberInput, RestoreButton, ToggleRow } from './panel/fields'

const D = AUTO_TITLE_DEFAULTS

/** Config atual do store (sem closure velha: o prompt salva com atraso). */
const current = (): AutoTitleSettings =>
  normalizeAutoTitleSettings(useStore.getState().settings.autoTitle)

function AutoTitleInfo({ cfg }: { cfg: AutoTitleSettings }): React.JSX.Element {
  const example = autoTitleUserContent({
    text: 'Como configuro o nginx como proxy reverso para o meu app Node na porta 3000?',
    attachments: ['nginx.conf'],
    memory: cfg.useMemory
      ? '<memory>\nMemórias do usuário (contexto). Formato: id · título — resumo.\n## Áreas …\n- m1a2b3c · Deploy do app — VPS com Ubuntu\n</memory>'
      : null
  })
  // parâmetros exatos (max_tokens, raciocínio) pela mesma política do main
  const preview = useSideRequestPreview({
    providerId: cfg.providerId,
    model: cfg.model,
    messages: [
      { role: 'system', content: cfg.prompt ?? DEFAULT_AUTO_TITLE_PROMPT },
      { role: 'user', content: example }
    ],
    maxTokens: cfg.maxTokens,
    thinkingTokens: cfg.thinkingTokens,
    defaultThinkingTokens: SIDE_THINKING.title
  })
  const params = Object.fromEntries(
    Object.entries(preview.body).filter(([k]) => k !== 'messages' && k !== 'system')
  )
  return (
    <ApiInfo
      title="Chamada do título automático"
      code={example}
      codeLabel="Mensagem user (exemplo):"
    >
      <p>
        Uma request <strong>separada</strong>, ao modelo escolhido, quando um chat novo recebe a
        primeira mensagem digitada — fora do histórico (o agente nunca a vê) e sem atrasar o turno.
      </p>
      <p>
        Body: <C>model</C>, <C>messages</C> = [<C>system</C> = o prompt de geração, <C>user</C> = a
        mensagem abaixo], <C>max_tokens: {cfg.maxTokens}</C> (só se o modelo aceita), raciocínio
        desligado onde o modelo permite (obrigatório → esforço mínimo + os “Tokens de pensamento”
        somados ao <C>max_tokens</C>; níveis desconhecidos → nada), <C>stream: true</C>. Headers: os
        do provedor + a assinatura do app do chat.
      </p>
      <pre
        data-testid="auto-title-request-params"
        className="rounded-lg border border-border bg-bg/80 p-2 font-mono text-[11px] whitespace-pre-wrap text-fg/90"
      >
        {JSON.stringify(params, null, 2)}
      </pre>
      {preview.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-[11px]">
          {preview.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p>
        Vão só o começo da mensagem (até {D.messageChars.toLocaleString('pt-BR')} caracteres) e os{' '}
        <strong>nomes</strong> dos anexos — nunca o conteúdo deles
        {cfg.useMemory
          ? `; com “Usar as memórias”, o índice das memórias ativas no chat (até ${D.memoryChars.toLocaleString('pt-BR')} caracteres)`
          : ''}
        . A resposta é limpa (aspas, markdown, emoji, ponto final) e cortada em {D.maxTitleChars}{' '}
        caracteres; vazia/genérica ou com erro → fica o título provisório.
      </p>
    </ApiInfo>
  )
}

export function AutoTitleSettings(): React.JSX.Element {
  const raw = useStore((s) => s.settings.autoTitle)
  const providers = useStore((s) => s.providers)
  const setSetting = useStore((s) => s.setSetting)
  const cfg = normalizeAutoTitleSettings(raw)
  const hasModel = autoTitleEnabled(cfg)
  const providerOk = !!cfg.providerId && providers.some((p) => p.id === cfg.providerId)
  const [prompt, setPrompt] = useState(cfg.prompt ?? DEFAULT_AUTO_TITLE_PROMPT)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPrompt = useRef<string | null>(null)
  // prompt mudou por fora (sync de outro dispositivo): acompanha, se não houver edição pendente
  const [prevSaved, setPrevSaved] = useState(cfg.prompt)
  if (prevSaved !== cfg.prompt) {
    setPrevSaved(cfg.prompt)
    if (pendingPrompt.current === null) setPrompt(cfg.prompt ?? DEFAULT_AUTO_TITLE_PROMPT)
  }

  const save = (patch: Partial<AutoTitleSettings>): void =>
    void setSetting('autoTitle', { ...current(), ...patch })

  const flushPrompt = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const v = pendingPrompt.current
    pendingPrompt.current = null
    // igual ao padrão (ou vazio) = null → segue o padrão se ele mudar numa versão nova
    if (v !== null) save({ prompt: v.trim() && v !== DEFAULT_AUTO_TITLE_PROMPT ? v : null })
  }

  useEffect(
    () => () => flushPrompt(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const onPrompt = (v: string): void => {
    setPrompt(v)
    pendingPrompt.current = v
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flushPrompt, 500)
  }

  return (
    <section
      data-testid="auto-title-settings"
      className="settings-section settings-divided space-y-3"
    >
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-medium text-fg">Título automático</h3>
        <HelpTip label="Título automático">
          Quando um chat novo recebe a primeira mensagem, um modelo dá nome a ele em segundo plano
          (o agente não espera). Sem modelo, o título é o começo da mensagem. Se você renomear o
          chat antes da resposta, o seu título fica. Também dá para pedir “Gerar título” no
          cabeçalho do chat.
        </HelpTip>
        <AutoTitleInfo cfg={cfg} />
      </div>

      <div>
        <Label>Modelo para o título</Label>
        <div data-testid="auto-title-model" className="flex items-center gap-1.5">
          <ModelPicker
            className="min-w-0 flex-1"
            value={hasModel ? { providerId: cfg.providerId!, model: cfg.model! } : null}
            placeholder="Nenhum — o título é o começo da 1ª mensagem"
            onChange={(ref) => save({ providerId: ref.providerId, model: ref.model })}
          />
          {hasModel && (
            <Tip label="Remover modelo (sem título automático)">
              <button
                type="button"
                aria-label="Remover modelo do título"
                onClick={() => save({ providerId: null, model: null })}
                className="grid size-8 shrink-0 place-items-center rounded-lg text-subtle hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            </Tip>
          )}
        </div>
        {hasModel && !providerOk ? (
          <p className="mt-1.5 text-[11.5px] text-warning/90">
            O provedor deste modelo não existe mais — nenhum título será gerado.
          </p>
        ) : (
          <div className="mt-1.5 space-y-1.5 empty:hidden">
            {hasModel && <ModelInfoLine providerId={cfg.providerId!} model={cfg.model!} />}
            {hasModel && (
              <SideThinkingField
                providerId={cfg.providerId}
                model={cfg.model}
                value={cfg.thinkingTokens}
                onChange={(thinkingTokens) => save({ thinkingTokens })}
                defaultTokens={SIDE_THINKING.title}
                call="do título"
                testId="auto-title-thinking"
              />
            )}
          </div>
        )}
      </div>

      <div className={cn('space-y-3 transition-opacity', !hasModel && 'opacity-60')}>
        <ToggleRow
          label="Usar as memórias do usuário"
          checked={cfg.useMemory}
          onChange={(v) => save({ useMemory: v })}
          help={`Inclui um índice compacto (até ${D.memoryChars.toLocaleString('pt-BR')} caracteres) das memórias ativas no chat, para o título combinar com o que você está fazendo. Nada vai se a memória estiver desligada no chat.`}
        />
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[13px] text-fg/90">
              Limite de tokens de saída
              <HelpTip label="Limite de tokens de saída">
                <C>max_tokens</C> da chamada — só vai onde o modelo/provedor aceita. Em modelos de
                raciocínio ele inclui o raciocínio (pedido no mínimo): se o título vier vazio,
                aumente.
              </HelpTip>
            </div>
          </div>
          <div className="pt-0.5">
            <NumberInput
              value={cfg.maxTokens}
              disabled={false}
              step={8}
              min={D.minMaxTokens}
              max={D.maxMaxTokens}
              int
              label="Limite de tokens de saída"
              onCommit={(n) => {
                if (n >= D.minMaxTokens && n <= D.maxMaxTokens) save({ maxTokens: n })
              }}
            />
          </div>
        </div>
        <div>
          <Label
            hint={
              prompt !== DEFAULT_AUTO_TITLE_PROMPT && (
                <RestoreButton onClick={() => onPrompt(DEFAULT_AUTO_TITLE_PROMPT)} />
              )
            }
          >
            Prompt de geração
          </Label>
          <AutoTextarea
            value={prompt}
            aria-label="Prompt de geração"
            onChange={(e) => onPrompt(e.target.value)}
            onBlur={flushPrompt}
            minRows={5}
            maxRows={14}
            className="field text-[12.5px] leading-relaxed"
          />
        </div>
      </div>
    </section>
  )
}
