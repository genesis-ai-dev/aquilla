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
): TeamFeedMessage | null {
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

export function buildRunFeed(
  activity: Pick<ContextualRunActivity, "events" | "sceneBriefs">,
): TeamFeedMessage[] {
  const ordered = [...activity.events].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  )
  const feed: TeamFeedMessage[] = []
  // Collapse consecutive same-region phase updates per span.
  const lastPhaseRegion = new Map<string, ProcessRegion>()
  for (const event of ordered) {
    const message = messageFor(event, activity.sceneBriefs)
    if (!message) continue
    const spanKey = event.spanId ?? "run"
    if (message.body.kind === "phase") {
      if (lastPhaseRegion.get(spanKey) === message.body.region) continue
      lastPhaseRegion.set(spanKey, message.body.region)
    } else {
      lastPhaseRegion.delete(spanKey)
    }
    feed.push(message)
  }
  return feed
}
