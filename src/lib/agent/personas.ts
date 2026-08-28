/**
 * personas.ts — the client-side team that fronts the agent machinery
 * (2026-08-28 social-workspace design).
 *
 * Nothing on the wire carries an agent identity: autopilot activity has only
 * a phase region and chat tool calls only a ToolKind. This module is the ONE
 * place that decides which teammate "speaks" for a given piece of activity,
 * so every surface (team threads, chat timeline, empty states) attributes
 * work identically. Every region and every tool kind must map — an anonymous
 * actor breaks the social framing.
 */

import { ClipboardList, PenLine, ShieldCheck, type LucideIcon } from "lucide-react"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ProcessRegion } from "@/lib/contextual/process-graph"
import type { ToolKind } from "./protocol"

export type AgentPersonaId = "drafter" | "reviewer" | "coordinator"

export interface AgentPersona {
  id: AgentPersonaId
  nameKey: MessageKey
  taglineKey: MessageKey
  icon: LucideIcon
  /** Foreground tint for the avatar icon and name. */
  textClass: string
  /** Avatar disc background. */
  bgClass: string
}

export const AGENT_PERSONA_IDS = ["drafter", "reviewer", "coordinator"] as const

export const AGENT_PERSONAS: Record<AgentPersonaId, AgentPersona> = {
  drafter: {
    id: "drafter",
    nameKey: "agent.persona.drafter.name",
    taglineKey: "agent.persona.drafter.tagline",
    icon: PenLine,
    textClass: "text-sky-700 dark:text-sky-400",
    bgClass: "bg-sky-100 dark:bg-sky-500/15",
  },
  reviewer: {
    id: "reviewer",
    nameKey: "agent.persona.reviewer.name",
    taglineKey: "agent.persona.reviewer.tagline",
    icon: ShieldCheck,
    textClass: "text-amber-700 dark:text-amber-400",
    bgClass: "bg-amber-100 dark:bg-amber-500/15",
  },
  coordinator: {
    id: "coordinator",
    nameKey: "agent.persona.coordinator.name",
    taglineKey: "agent.persona.coordinator.tagline",
    icon: ClipboardList,
    textClass: "text-emerald-700 dark:text-emerald-400",
    bgClass: "bg-emerald-100 dark:bg-emerald-500/15",
  },
}

/** Autopilot pipeline regions → the teammate doing that stretch of work. */
export function personaForRegion(region: ProcessRegion): AgentPersonaId {
  switch (region) {
    case "reading":
    case "drafting":
      return "drafter"
    case "checking":
      return "reviewer"
    case "staging":
      return "coordinator"
  }
}

/** Chat-run tool calls → the teammate the activity line is attributed to.
 *  Research and drafting read as the Drafter working; project-record lookups
 *  and staging read as the Coordinator managing the work. */
export function personaForToolKind(tool: ToolKind): AgentPersonaId {
  switch (tool) {
    case "sql":
    case "emit":
      return "coordinator"
    case "read":
    case "examples":
    case "search":
    case "draft":
    case "docs":
    case "aquifer":
      return "drafter"
  }
}
