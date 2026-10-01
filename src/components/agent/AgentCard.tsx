/**
 * AgentCard.tsx — the transparency layer behind a persona avatar
 * (2026-08-28 social-workspace design, "v2 — the one-channel model").
 *
 * The social framing hides a lot of machinery on purpose: the team view shows
 * plain-language messages, not a console. This card is where that machinery
 * stays honest and one click away — for a given teammate it names the tools it
 * may actually use, the standing project state it reads (linking straight into
 * those surfaces, so the claim is checkable rather than asserted), and what it
 * may write. The last part is the load-bearing one: agent writes are staged
 * proposals behind a human approve/reject gate, and the card says so in the
 * persona's own terms rather than leaving the user to infer it.
 *
 * All of it is declared data (`AGENT_PERSONA_CAPABILITIES` in
 * `lib/agent/personas.ts`) — this file only renders it, so a capability added
 * to the harness shows up here without a second copy of the truth.
 */

import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { AGENT_PERSONA_CAPABILITIES, AGENT_PERSONAS, type AgentPersonaId } from "@/lib/agent/personas"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import { PersonaAvatar } from "./PersonaAvatar"

export interface AgentCardProps {
  personaId: AgentPersonaId
  /**
   * Project in scope, used to resolve the "reads" links. The roster also
   * renders outside a project (the first-run guide), so this is optional and
   * every read degrades to plain text without it — a card never shows a link
   * it cannot resolve.
   */
  projectId?: string
  className?: string
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-medium text-foreground">{children}</p>
}

export function AgentCard({ personaId, projectId, className }: AgentCardProps) {
  const t = useT()
  const persona = AGENT_PERSONAS[personaId]
  const capabilities = AGENT_PERSONA_CAPABILITIES[personaId]

  return (
    <div
      data-persona-card={personaId}
      className={cn("flex flex-col gap-3 text-muted-foreground", className)}
    >
      <div className="flex items-start gap-2">
        <PersonaAvatar personaId={personaId} size="md" />
        <div className="flex min-w-0 flex-col">
          <p className={cn("text-xs font-medium", persona.textClass)}>{t(persona.nameKey)}</p>
          <p className="text-[11px] leading-relaxed">{t(persona.taglineKey)}</p>
        </div>
      </div>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>{t("agent.card.toolsTitle")}</SectionTitle>
        <ul className="flex flex-col gap-1.5">
          {capabilities.tools.map((tool) => {
            const Icon = tool.icon
            return (
              <li key={tool.id} className="flex items-start gap-1.5">
                <Icon aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                <p className="text-[11px] leading-relaxed">
                  <span className="font-medium text-foreground">{t(tool.labelKey)}</span>
                  {" — "}
                  {t(tool.descriptionKey)}
                </p>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-1.5">
        <SectionTitle>{t("agent.card.readsTitle")}</SectionTitle>
        <ul className="flex flex-col gap-1.5">
          {capabilities.reads.map((read) => {
            const Icon = read.icon
            const href = projectId && read.route ? read.route(projectId) : null
            const label = t(read.labelKey)
            return (
              <li key={read.id} className="flex items-start gap-1.5">
                <Icon aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                <p className="text-[11px] leading-relaxed">
                  {href ? (
                    <Link
                      to={href}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      {label}
                    </Link>
                  ) : (
                    <span className="font-medium text-foreground">{label}</span>
                  )}
                  {" — "}
                  {t(read.descriptionKey)}
                </p>
              </li>
            )
          })}
        </ul>
      </section>

      {/* The approval gate. Bordered on the inline-start edge so it reads as an
          aside in both writing directions. */}
      <section className="flex flex-col gap-1 border-s-2 border-border ps-2">
        <SectionTitle>{t("agent.card.writesTitle")}</SectionTitle>
        <p className="text-[11px] leading-relaxed">{t(capabilities.writeKey)}</p>
      </section>
    </div>
  )
}

export interface AgentCardTriggerProps {
  personaId: AgentPersonaId
  /** Passed through to the card so its "reads" links resolve. */
  projectId?: string
  size?: "sm" | "md"
  className?: string
}

/**
 * The avatar as an affordance: same disc the roster already shows, wrapped in
 * a real button so the card is reachable by keyboard and announced by name.
 */
export function AgentCardTrigger({
  personaId,
  projectId,
  size = "sm",
  className,
}: AgentCardTriggerProps) {
  const t = useT()
  const persona = AGENT_PERSONAS[personaId]

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("agent.card.triggerAriaLabel", { name: t(persona.nameKey) })}
            className={cn(
              "rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
          />
        }
      >
        <PersonaAvatar personaId={personaId} size={size} />
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-72">
        <AgentCard personaId={personaId} projectId={projectId} />
      </PopoverContent>
    </Popover>
  )
}
