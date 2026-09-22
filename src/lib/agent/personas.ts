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

import {
  BookCheck,
  BookOpen,
  ClipboardList,
  Database,
  Ear,
  FileText,
  Inbox,
  Library,
  LibraryBig,
  Languages,
  ListChecks,
  PenLine,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Split,
  Target,
  type LucideIcon,
} from "lucide-react"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ProcessNodeId, ProcessRegion } from "@/lib/contextual/process-graph"
import { projectMemoryPath } from "@/lib/navigation/org-paths"
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

// ── Capability metadata (agent cards — v2 transparency layer) ───────────────
//
// The card behind a persona avatar has to answer three questions without a
// console: what this teammate can DO, what standing project state it READS
// before it works, and what it may WRITE. Declaring that here — beside the
// attribution rules, in the one module that already owns "who is speaking" —
// keeps the answer identical on every surface that shows a card, and makes
// the claim auditable: each capability names the real wire `ToolKind` or the
// real pipeline node it stands for, so a tool added to the harness without a
// card entry is visible as a gap rather than silently undisclosed.

/**
 * Where a capability comes from. Chat tools carry the `ToolKind` the harness
 * actually invokes. The autopilot verification passes have no ToolKind of
 * their own — they are nodes inside the drafting pipeline, not callable tools
 * — so they carry their `ProcessNodeId` instead. Typing the union against the
 * two real vocabularies is what stops the card drifting into marketing copy.
 */
export type AgentCapabilitySource =
  | { kind: "tool"; tool: ToolKind }
  | { kind: "autopilot"; node: ProcessNodeId }

export interface AgentToolCapability {
  id: string
  source: AgentCapabilitySource
  labelKey: MessageKey
  /** One line, plain language — what this does, not how it is implemented. */
  descriptionKey: MessageKey
  icon: LucideIcon
}

/**
 * A standing piece of project state a persona reads before it works.
 *
 * `route` builds the in-app path when that state has a surface of its own, so
 * the card can hand the user straight to the thing it just claimed to read.
 * It is nullable, and the card also falls back to plain text when it has no
 * project id in scope (the roster renders outside a project too) — a card
 * must never render a link it cannot resolve.
 */
export interface AgentReadCapability {
  id: string
  labelKey: MessageKey
  descriptionKey: MessageKey
  icon: LucideIcon
  route: ((projectId: string) => string) | null
}

export interface AgentPersonaCapabilities {
  tools: readonly AgentToolCapability[]
  reads: readonly AgentReadCapability[]
  /**
   * One sentence naming what this teammate stages and restating the human
   * approve/reject gate. Wording discipline (see the `agent` i18n namespace):
   * "staged"/"proposed" for the pending state, "approved"/"applied" only once
   * a human has acted. A card that blurs those two hides the gate from the
   * person it exists to protect.
   */
  writeKey: MessageKey
}

/**
 * The standing state surfaces, shared so several personas can cite the same
 * one and the card copy stays in a single place.
 */
export const AGENT_READ_SOURCES = {
  brief: {
    id: "brief",
    labelKey: "agent.card.read.brief.label",
    descriptionKey: "agent.card.read.brief.description",
    icon: Target,
    route: (projectId: string) => projectMemoryPath(projectId, "brief"),
  },
  styleGuide: {
    id: "styleGuide",
    labelKey: "agent.card.read.styleGuide.label",
    descriptionKey: "agent.card.read.styleGuide.description",
    icon: Sparkles,
    route: (projectId: string) => projectMemoryPath(projectId, "instructions"),
  },
  termbase: {
    id: "termbase",
    labelKey: "agent.card.read.termbase.label",
    descriptionKey: "agent.card.read.termbase.description",
    icon: Languages,
    route: (projectId: string) => `/project/${projectId}/terminology`,
  },
  livingMemory: {
    id: "livingMemory",
    labelKey: "agent.card.read.livingMemory.label",
    descriptionKey: "agent.card.read.livingMemory.description",
    icon: LibraryBig,
    route: (projectId: string) => projectMemoryPath(projectId),
  },
  rules: {
    id: "rules",
    labelKey: "agent.card.read.rules.label",
    descriptionKey: "agent.card.read.rules.description",
    icon: ShieldCheck,
    // `/project/:id/rules` redirects here; link the destination directly.
    route: (projectId: string) => projectMemoryPath(projectId, "quality"),
  },
} as const satisfies Record<string, AgentReadCapability>

export const AGENT_PERSONA_CAPABILITIES: Record<AgentPersonaId, AgentPersonaCapabilities> = {
  drafter: {
    tools: [
      {
        id: "read",
        source: { kind: "tool", tool: "read" },
        labelKey: "agent.card.tool.read.label",
        descriptionKey: "agent.card.tool.read.description",
        icon: BookOpen,
      },
      {
        id: "examples",
        source: { kind: "tool", tool: "examples" },
        labelKey: "agent.card.tool.examples.label",
        descriptionKey: "agent.card.tool.examples.description",
        icon: BookCheck,
      },
      {
        id: "search",
        source: { kind: "tool", tool: "search" },
        labelKey: "agent.card.tool.search.label",
        descriptionKey: "agent.card.tool.search.description",
        icon: Search,
      },
      {
        id: "draft",
        source: { kind: "tool", tool: "draft" },
        labelKey: "agent.card.tool.draft.label",
        descriptionKey: "agent.card.tool.draft.description",
        icon: PenLine,
      },
      {
        id: "docs",
        source: { kind: "tool", tool: "docs" },
        labelKey: "agent.card.tool.docs.label",
        descriptionKey: "agent.card.tool.docs.description",
        icon: FileText,
      },
      {
        id: "aquifer",
        source: { kind: "tool", tool: "aquifer" },
        labelKey: "agent.card.tool.aquifer.label",
        descriptionKey: "agent.card.tool.aquifer.description",
        icon: Library,
      },
    ],
    reads: [
      AGENT_READ_SOURCES.brief,
      AGENT_READ_SOURCES.styleGuide,
      AGENT_READ_SOURCES.termbase,
      AGENT_READ_SOURCES.livingMemory,
    ],
    writeKey: "agent.card.writes.drafter",
  },
  reviewer: {
    // No ToolKind here on purpose: the Reviewer is the autopilot's verification
    // stretch, not a chat tool caller. Three independent verifier stances vote,
    // and the deterministic rules lint runs over every draft before staging.
    tools: [
      {
        id: "verify_force",
        source: { kind: "autopilot", node: "verify_force" },
        labelKey: "agent.card.tool.verifyForce.label",
        descriptionKey: "agent.card.tool.verifyForce.description",
        icon: Scale,
      },
      {
        id: "verify_ambiguity",
        source: { kind: "autopilot", node: "verify_ambiguity" },
        labelKey: "agent.card.tool.verifyAmbiguity.label",
        descriptionKey: "agent.card.tool.verifyAmbiguity.description",
        icon: Split,
      },
      {
        id: "verify_naturalness",
        source: { kind: "autopilot", node: "verify_naturalness" },
        labelKey: "agent.card.tool.verifyNaturalness.label",
        descriptionKey: "agent.card.tool.verifyNaturalness.description",
        icon: Ear,
      },
      {
        id: "lint_rules",
        source: { kind: "autopilot", node: "lint_rules" },
        labelKey: "agent.card.tool.lintRules.label",
        descriptionKey: "agent.card.tool.lintRules.description",
        icon: ListChecks,
      },
    ],
    reads: [
      AGENT_READ_SOURCES.rules,
      AGENT_READ_SOURCES.brief,
      AGENT_READ_SOURCES.termbase,
    ],
    writeKey: "agent.card.writes.reviewer",
  },
  coordinator: {
    tools: [
      {
        id: "sql",
        source: { kind: "tool", tool: "sql" },
        labelKey: "agent.card.tool.sql.label",
        descriptionKey: "agent.card.tool.sql.description",
        icon: Database,
      },
      {
        id: "emit",
        source: { kind: "tool", tool: "emit" },
        labelKey: "agent.card.tool.emit.label",
        descriptionKey: "agent.card.tool.emit.description",
        icon: Inbox,
      },
    ],
    reads: [
      AGENT_READ_SOURCES.brief,
      AGENT_READ_SOURCES.livingMemory,
      AGENT_READ_SOURCES.rules,
    ],
    writeKey: "agent.card.writes.coordinator",
  },
}
