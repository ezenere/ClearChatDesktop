// Seção "Skills" da aba Tools (painel do chat e editor de personas): liga/desliga as skills,
// restringe a um subconjunto (checklist), prompt de apoio e skills nos subagentes. Os LOCAIS
// (pastas) são globais — Configurações → Skills.
import { ArrowUpRight, Lightbulb, TriangleAlert } from 'lucide-react'
import type { SkillsConfig } from '@shared/skills'
import type { ChatConfig } from '@shared/types'
import { cn } from '../../lib/format'
import {
  DEFAULT_SKILLS_SUPPORT_PROMPT,
  shortLocation,
  skillsConfigOf,
  supportPromptText,
  toggleSkill
} from '../../lib/skills'
import { skillsDetailsSummary } from '../../lib/configSummary'
import { useStore } from '../../store'
import { SkillsSendInfo, SkillsSubagentsInfo, SkillsSupportInfo } from '../apiDocs'
import { AutoTextarea, Switch } from '../ui/controls'
import { Tip } from '../ui/Tooltip'
import type { CfgProps } from '../panel/editors'
import { CollapsibleSection, RestoreButton, Section, ToggleRow } from '../panel/fields'
import { useSkillsDiscovery } from './hooks'

export function SkillsSection({
  cfg,
  patch,
  chatScope
}: CfgProps & { chatScope?: boolean }): React.JSX.Element {
  const sc = skillsConfigOf(cfg)
  const set = (next: SkillsConfig): void => patch({ skills: next } as Partial<ChatConfig>)
  const openSkills = useStore((s) => s.openSkills)
  const { disc, error } = useSkillsDiscovery(cfg.cwd || null)
  const all = disc?.skills ?? []
  const off = new Set(sc.disabled)
  const activeCount = all.filter((s) => !off.has(s.name)).length
  const support = supportPromptText(sc)
  const supportText = sc.supportPrompt.text ?? DEFAULT_SKILLS_SUPPORT_PROMPT
  const where = chatScope ? 'neste chat' : 'nesta persona'

  return (
    <Section
      title="Skills"
      id="skills"
      inherit={['skills']}
      aside={
        <SkillsSendInfo
          enabled={sc.enabled}
          support={support}
          nativeTools={cfg.nativeTools}
          cfg={cfg}
        />
      }
    >
      <div data-testid={chatScope ? 'skills-panel' : 'preset-skills'} className="space-y-3">
        <ToggleRow
          label={chatScope ? 'Skills neste chat' : 'Skills nesta persona'}
          help="Prompt de apoio e as tools list_skills, skill_load e skill_read"
          checked={sc.enabled}
          onChange={(enabled) => set({ ...sc, enabled })}
        />

        <div className={cn('space-y-1.5', !sc.enabled && 'opacity-55')}>
          <div className="flex items-center gap-2 text-[11.5px] text-subtle">
            <span>
              {all.length ? (
                <>
                  <span className="text-fg/85 tabular-nums">
                    {activeCount}/{all.length}
                  </span>{' '}
                  skills ativas {where}
                </>
              ) : (
                'Nenhuma skill encontrada nos locais habilitados'
              )}
            </span>
            <button
              type="button"
              onClick={() => openSkills()}
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-accent-strong hover:underline"
            >
              Locais <ArrowUpRight className="size-3" />
            </button>
          </div>
          {error && <p className="text-[11.5px] text-danger">{error}</p>}
        </div>

        <CollapsibleSection
          id="skills-details"
          level="sub"
          title="Ajustes das skills"
          summary={skillsDetailsSummary(sc)}
          focusIds={['skills-subagentes']}
        >
          {all.length > 0 && (
            <div
              data-testid="skills-checklist"
              className={cn(
                '-mx-1.5 max-h-[260px] space-y-px overflow-x-hidden overflow-y-auto',
                !sc.enabled && 'opacity-55'
              )}
            >
              {all.map((s) => {
                const on = !off.has(s.name)
                return (
                  <div
                    key={`${s.locationId}:${s.name}`}
                    data-skill={s.name}
                    className="flex items-start gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-hover/50"
                  >
                    <div className="pt-0.5">
                      <Switch
                        size="sm"
                        checked={on}
                        label={`Skill ${s.name}`}
                        onChange={(v) => set(toggleSkill(sc, s.name, v))}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'truncate font-mono text-[12px]',
                            on ? 'text-fg/90' : 'text-subtle'
                          )}
                        >
                          {s.name}
                        </span>
                        {s.warnings.length > 0 && (
                          <Tip label={s.warnings.join(' · ')}>
                            <TriangleAlert className="size-3 shrink-0 text-warning/70" />
                          </Tip>
                        )}
                        <span
                          className="ml-auto max-w-[45%] shrink-0 truncate text-[10.5px] text-faint"
                          title={s.dir}
                        >
                          {shortLocation(s.locationLabel)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-[11.5px] leading-snug text-subtle">
                        {s.description}
                      </p>
                    </div>
                    <Tip label="Ver SKILL.md em Configurações → Skills">
                      <button
                        type="button"
                        onClick={() => openSkills(s.name)}
                        className="mt-0.5 shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-fg"
                        aria-label={`Ver a skill ${s.name}`}
                      >
                        <ArrowUpRight className="size-3.5" />
                      </button>
                    </Tip>
                  </div>
                )
              })}
            </div>
          )}

          <div className={cn('space-y-2', !sc.enabled && 'opacity-55')}>
            <ToggleRow
              label="Prompt de apoio"
              help="Anexado ao system prompt: diz que há skills e para usar list_skills"
              checked={sc.supportPrompt.enabled}
              onChange={(enabled) =>
                set({ ...sc, supportPrompt: { ...sc.supportPrompt, enabled } })
              }
              info={<SkillsSupportInfo text={supportText} />}
            />
            {sc.supportPrompt.enabled && (
              <div className="animate-fade-in">
                <div className="mb-1 flex items-center text-[11px] text-subtle">
                  {sc.supportPrompt.text == null ? 'Texto padrão' : 'Texto personalizado'}
                  {sc.supportPrompt.text != null && (
                    <span className="ml-auto">
                      <RestoreButton
                        onClick={() =>
                          set({ ...sc, supportPrompt: { ...sc.supportPrompt, text: null } })
                        }
                      />
                    </span>
                  )}
                </div>
                <AutoTextarea
                  value={supportText}
                  aria-label="Prompt de apoio das skills"
                  onChange={(e) =>
                    set({
                      ...sc,
                      supportPrompt: {
                        ...sc.supportPrompt,
                        text:
                          e.target.value === DEFAULT_SKILLS_SUPPORT_PROMPT ? null : e.target.value
                      }
                    })
                  }
                  minRows={3}
                  maxRows={8}
                  className="field text-[12px] leading-relaxed"
                />
              </div>
            )}
          </div>

          <div data-section="skills-subagentes" className={cn(!sc.enabled && 'opacity-55')}>
            <ToggleRow
              label="Skills nos subagentes"
              help="Mesmas tools e prompt de apoio, limitados às skills ativas"
              checked={sc.subagents}
              onChange={(subagents) => set({ ...sc, subagents })}
              info={<SkillsSubagentsInfo />}
            />
          </div>
        </CollapsibleSection>
      </div>
    </Section>
  )
}

/** Aba Tools → Subagentes: skills liberadas para subagentes? (link para a seção de skills). */
export function SubagentSkillsLine({
  cfg,
  chatScope
}: {
  cfg: ChatConfig
  chatScope?: boolean
}): React.JSX.Element {
  const focusConfig = useStore((s) => s.focusConfig)
  const sc = skillsConfigOf(cfg)
  const on = sc.enabled && sc.subagents
  return (
    <div
      data-testid="subagent-skills"
      data-on={on || undefined}
      className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 px-2.5 py-1.5 text-[12px]"
    >
      <Lightbulb className={cn('size-3.5 shrink-0', on ? 'text-accent-strong' : 'text-faint')} />
      <span className="min-w-0 flex-1 text-muted">
        Skills para subagentes:{' '}
        <span className={on ? 'text-fg/90' : 'text-subtle'}>
          {sc.subagents ? 'ligadas' : 'desligadas'}
        </span>
        {sc.subagents && !sc.enabled && (
          <span className="text-warning/85">
            {' '}
            · skills desligadas {chatScope ? 'neste chat' : 'nesta persona'}
          </span>
        )}
      </span>
      {chatScope && (
        <button
          type="button"
          onClick={() => focusConfig('skills-subagentes')}
          className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-accent-strong hover:underline"
        >
          Skills <ArrowUpRight className="size-3" />
        </button>
      )}
    </div>
  )
}
