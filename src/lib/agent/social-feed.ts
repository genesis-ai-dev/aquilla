/**
 * social-feed.ts — turns one autopilot run's durable activity into a
 * chat-style message feed for the Team threads view (2026-08-28
 * social-workspace design).
 *
 * Pure transform over `ContextualRunActivity`: each event becomes a message
 * attributed to a persona (see personas.ts). Only narrative kinds surface —
 * plumbing kinds (`run_created`, `run_state`, `llm`, `steering_queued`) and
 * unknown future kinds are skipped rather than rendered as jargon, and
 * consecutive same-region phase updates for the same span collapse into one
 * message so a long run reads as a conversation, not a log.
 *
 * Message ids are unique by construction, even when the wire delivers
 * colliding event ids — they key React's list and address the step
 * inspector's selection, so a collision would silently swallow a step.
 */

import {
  normalizePhase,
  type ProcessRegion,
} from "@/lib/contextual/process-graph"
import type {
  ContextualActivityEvent,
  ContextualActivitySceneBrief,
  ContextualRunActivity,
} from "@/lib/contextual/transport"
import { humanPassageLabel } from "../../../shared/span-label"
import { personaForRegion, type AgentPersonaId } from "./personas"

export type TeamFeedBody =
  | { kind: "started"; spanLabel: string | null }
  | { kind: "phase"; region: ProcessRegion; spanLabel: string | null }
  | {
      kind: "sceneReady"
      spanLabel: string | null
      ambiguityCount: number | null
      /** Short excerpt of the scene brief, when one matches the span. */
      excerpt: string | null
    }
  | { kind: "draftsStaged"; spanLabel: string | null; count: number | null }
  | {
      kind: "outcome"
      spanLabel: string | null
      status: "done" | "partial" | "failed"
      reasons: string[]
    }

export interface TeamFeedMessage {
  id: string
  persona: AgentPersonaId
  /** Event `createdAt` — ISO timestamp. */
  at: string
  body: TeamFeedBody
  /** The durable event behind the sentence, for the step inspector — the
   *  plain-language line is the surface, this is the receipt. */
  raw: { kind: string; details: Record<string, unknown> }
}

const EXCERPT_MAX = 240

function detailNumber(details: Record<string, unknown>, key: string): number | null {
  const value = details[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function detailStrings(details: Record<string, unknown>, key: string): string[] {
  const value = details[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function briefExcerpt(
  briefs: ContextualActivitySceneBrief[],
  spanLabel: string | null | undefined,
): string | null {
  if (!spanLabel) return null
  const brief = briefs.find((candidate) => candidate.spanLabel === spanLabel)
  const text = brief?.l1Summary ?? brief?.construal ?? null
  if (typeof text !== "string" || !text.trim()) return null
  const trimmed = text.trim()
  return trimmed.length > EXCERPT_MAX ? `${trimmed.slice(0, EXCERPT_MAX - 1)}…` : trimmed
}

function messageFor(
  event: ContextualActivityEvent,
  briefs: ContextualActivitySceneBrief[],
): Omit<TeamFeedMessage, "raw"> | null {
  const spanLabel = humanPassageLabel(event.spanLabel)
  switch (event.kind) {
    case "span_started":
      return {
        id: event.id,
        persona: "coordinator",
        at: event.createdAt,
        body: { kind: "started", spanLabel },
      }
    case "phase": {
      const region = normalizePhase(event.phase)
      // The staging region is narrated by the richer drafts_staged /
      // span_outcome messages — a bare "staging" phase would double up.
      if (!region || region === "staging") return null
      return {
        id: event.id,
        persona: personaForRegion(region),
        at: event.createdAt,
        body: { kind: "phase", region, spanLabel },
      }
    }
    case "scene_ready":
      return {
        id: event.id,
        persona: "drafter",
        at: event.createdAt,
        body: {
          kind: "sceneReady",
          spanLabel,
          ambiguityCount: detailNumber(event.details, "ambiguityCount"),
          excerpt: briefExcerpt(briefs, event.spanLabel),
        },
      }
    case "drafts_staged":
      return {
        id: event.id,
        persona: "coordinator",
        at: event.createdAt,
        body: {
          kind: "draftsStaged",
          spanLabel,
          count:
            detailNumber(event.details, "count")
            ?? detailNumber(event.details, "staged"),
        },
      }
    case "span_outcome": {
      const skipped = detailNumber(event.details, "skipped")
      const status =
        event.status === "failed" ? "failed" : skipped && skipped > 0 ? "partial" : "done"
      return {
        id: event.id,
        persona: "coordinator",
        at: event.createdAt,
        body: {
          kind: "outcome",
          spanLabel,
          status,
          reasons: detailStrings(event.details, "reasons"),
        },
      }
    }
    default:
      return null
  }
}

/** Separator that cannot occur inside an event id or kind, so the composite
 *  dedupe key can never be forged by an id that merely contains the joiner. */
const DUPE_KEY_SEP = "\u0000"

export function buildRunFeed(
  activity: Pick<ContextualRunActivity, "events" | "sceneBriefs">,
): TeamFeedMessage[] {
  const ordered = [...activity.events].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  )
  const feed: TeamFeedMessage[] = []
  // Collapse consecutive same-region phase updates per span.
  const lastPhaseRegion = new Map<string, ProcessRegion>()
  // Message ids address React keys AND the step inspector's selection, so a
  // colliding wire id silently swallows a step: two events render as one row,
  // and clicking either opens whichever the lookup finds first. The wire is
  // supposed to mint unique ids; this makes the feed correct even when it
  // doesn't. Exact repeats (same id AND same kind — a re-delivered event)
  // collapse to one message; a reused id carrying a DIFFERENT kind is two real
  // steps, so both survive under deterministic `${id}#2`, `${id}#3` ids.
  const emitted = new Set<string>()
  const idUses = new Map<string, number>()
  for (const event of ordered) {
    const message = messageFor(event, activity.sceneBriefs)
    if (!message) continue
    // Checked before the phase bookkeeping below: a re-delivered event must
    // leave no trace, or it would advance `lastPhaseRegion` past a region
    // whose message never reached the feed.
    const dupeKey = `${message.id}${DUPE_KEY_SEP}${event.kind}`
    if (emitted.has(dupeKey)) continue
    const spanKey = event.spanId ?? "run"
    if (message.body.kind === "phase") {
      if (lastPhaseRegion.get(spanKey) === message.body.region) continue
      lastPhaseRegion.set(spanKey, message.body.region)
    } else {
      lastPhaseRegion.delete(spanKey)
    }
    emitted.add(dupeKey)
    const uses = idUses.get(message.id) ?? 0
    idUses.set(message.id, uses + 1)
    feed.push({
      ...message,
      id: uses === 0 ? message.id : `${message.id}#${uses + 1}`,
      raw: { kind: event.kind, details: event.details },
    })
  }
  return feed
}

export type TeamFeedGroupPart =
  | { kind: "message"; message: TeamFeedMessage }
  | { kind: "activity"; id: string; messages: TeamFeedMessage[] }

export interface TeamFeedGroup {
  id: string
  persona: AgentPersonaId
  at: string
  parts: TeamFeedGroupPart[]
}

/** Preserve feed order and receipts; only adjacent phases may share a disclosure. */
export function groupRunFeed(feed: readonly TeamFeedMessage[]): TeamFeedGroup[] {
  const groups: TeamFeedGroup[] = []
  for (const message of feed) {
    let group = groups.at(-1)
    if (!group || group.persona !== message.persona) {
      group = { id: message.id, persona: message.persona, at: message.at, parts: [] }
      groups.push(group)
    }
    if (message.body.kind === "phase") {
      const previous = group.parts.at(-1)
      if (previous?.kind === "activity") previous.messages.push(message)
      else group.parts.push({ kind: "activity", id: message.id, messages: [message] })
    } else {
      group.parts.push({ kind: "message", message })
    }
  }
  return groups
}

export interface TeamFeedPassage {
  id: string
  /** null for run-level messages outside any passage. */
  spanLabel: string | null
  messages: TeamFeedMessage[]
  /** Drafts staged in this passage (sum of draftsStaged counts). */
  drafts: number
  outcome: "done" | "partial" | "failed" | null
  /** Rendered expanded. False only for a finished passage with nothing a
   *  person needs to see (PR threads spec §3). */
  notable: boolean
}

/**
 * Split the run's feed into passages for the PR-style timeline: one section
 * per passage holding ALL its messages, ordered by the passage's first
 * appearance. Waves draft 2–3 passages concurrently, so their events
 * interleave; grouping only adjacent messages would chop them into many tiny
 * alternating sections. Run-level messages (no passage) share one section.
 * `needsHumanSpans` are passages with a draft triaged "needs you".
 */
export function groupFeedByPassage(
  feed: readonly TeamFeedMessage[],
  needsHumanSpans: ReadonlySet<string>,
): TeamFeedPassage[] {
  const byKey = new Map<string, TeamFeedPassage>()
  for (const message of feed) {
    const span = message.body.spanLabel
    const key = span ?? "\u0000run"
    let section = byKey.get(key)
    if (!section) {
      section = { id: message.id, spanLabel: span, messages: [], drafts: 0, outcome: null, notable: true }
      byKey.set(key, section)
    }
    section.messages.push(message)
    if (message.body.kind === "draftsStaged") section.drafts += message.body.count ?? 0
    if (message.body.kind === "outcome") section.outcome = message.body.status
  }
  const sections = [...byKey.values()]
  for (const section of sections) {
    section.notable =
      section.spanLabel === null ||
      section.outcome === null ||
      section.outcome !== "done" ||
      needsHumanSpans.has(section.spanLabel)
  }
  return sections
}
