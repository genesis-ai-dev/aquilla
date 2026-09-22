/**
 * PersonaAvatar.tsx — the small tinted avatar disc that gives each agent
 * persona (Drafter / Reviewer / Coordinator) a face across the team threads
 * view, the chat timeline, and the empty state.
 */

import { cn } from "@/lib/utils"
import { AGENT_PERSONAS, type AgentPersonaId } from "@/lib/agent/personas"

export interface PersonaAvatarProps {
  personaId: AgentPersonaId
  size?: "sm" | "md"
  className?: string
}

export function PersonaAvatar({ personaId, size = "md", className }: PersonaAvatarProps) {
  const persona = AGENT_PERSONAS[personaId]
  const Icon = persona.icon
  return (
    <span
      data-persona={persona.id}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full",
        persona.bgClass,
        size === "sm" ? "h-5 w-5" : "h-7 w-7",
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(persona.textClass, size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")}
      />
    </span>
  )
}
