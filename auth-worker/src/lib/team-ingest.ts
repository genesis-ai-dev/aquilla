/**
 * team-ingest.ts — write-through from durable autopilot activity into the
 * shared team channel (2026-08-28 social-workspace design §v2, sequencing
 * step 2: "Autopilot events get written into durable threads server-side,
 * replacing v1's client-side derivation").
 *
 * `src/lib/agent/social-feed.ts` does this same transform in the browser over
 * one run's activity. That derivation is per-user and disappears on reload;
 * this one is the multiplayer history everyone sees. The two MUST agree on
 * who speaks for a piece of activity, so the persona routing, the skipped
 * kinds, and the consecutive-phase collapse are mirrored here deliberately —
 * see `mapRunEvent` for the point-by-point correspondence.
 *
 * Every entry point here is best-effort: the translation pipeline's
 * correctness does not depend on the channel, so a failure is logged and
 * swallowed rather than allowed to fail a run.
 */

import type { AquillaDb } from "../../../db/shim/postgres"
import type { ContextualRunEvent } from "../../../db/shared/contextual-runs"
import { humanPassageLabel } from "../../../shared/span-label"
import type { TeamActivityBody, TeamPersonaId } from "../../../shared/team-channel"
import {
  appendMessage,
  ensureThread,
  latestSpanActivity,
  touchThread,
} from "./team-channel"

/** How the Coordinator opens a thread in the main channel. Kept short and
 *  intent-level: the play-by-play belongs in the thread, not here. */
function dispatchText(title: string): string {
  return `Working on ${title}`
}

interface MappedActivity {
  persona: TeamPersonaId
  body: TeamActivityBody
}

function detailNumber(details: Record<string, unknown>, key: string): number | null {
  const value = details[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function detailStrings(details: Record<string, unknown>, key: string): string[] {
  const value = details[key]
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  )
}

/**
 * One durable run event → one channel message, or null to skip.
 *
 * Mirrors `messageFor` in src/lib/agent/social-feed.ts:
 *   • span_started / drafts_staged / span_outcome → coordinator
 *   • phase reading|drafting → drafter; phase checking → reviewer
 *   • scene_ready → drafter
 *   • run_created / run_state / steering_queued / draft_reviewed → skipped
 *     (plumbing, not narrative — rendering them would be jargon)
 *   • phase 'staging' → skipped; the richer drafts_staged / span_outcome
 *     messages already narrate that region, so it would double up.
 *
 * The client normalizes a free-form phase string through `normalizePhase`.
 * Server-side that is unnecessary: `contextual_run_events.phase` is already
 * constrained to exactly the four region names.
 */
export function mapRunEvent(event: ContextualRunEvent): MappedActivity | null {
  const spanId = event.spanId
  const spanLabel = humanPassageLabel(event.spanLabel)
  const details = event.details as Record<string, unknown>
  switch (event.kind) {
    case "span_started":
      return { persona: "coordinator", body: { kind: "started", spanId, spanLabel } }
    case "phase": {
      if (event.phase === null || event.phase === "staging") return null
      const persona: TeamPersonaId = event.phase === "checking" ? "reviewer" : "drafter"
      return { persona, body: { kind: "phase", spanId, spanLabel, region: event.phase } }
    }
    case "scene_ready":
      return {
        persona: "drafter",
        body: {
          kind: "sceneReady",
          spanId,
          spanLabel,
          ambiguityCount: detailNumber(details, "ambiguityCount"),
        },
      }
    case "drafts_staged":
      return {
        persona: "coordinator",
        body: {
          kind: "draftsStaged",
          spanId,
          spanLabel,
          count: detailNumber(details, "count") ?? detailNumber(details, "staged"),
        },
      }
    case "span_outcome": {
      const skipped = detailNumber(details, "skipped")
      const status =
        event.status === "failed" ? "failed" : skipped && skipped > 0 ? "partial" : "done"
      return {
        persona: "coordinator",
        body: {
          kind: "outcome",
          spanId,
          spanLabel,
          status,
          reasons: detailStrings(details, "reasons"),
        },
      }
    }
    default:
      return null
  }
}

/** Label the run's thread by the file it is translating, falling back to the
 *  span label and finally the raw id — a thread title is never blank. */
async function resolveThreadTitle(
  db: AquillaDb,
  event: ContextualRunEvent,
): Promise<string> {
  const file = await db
    .prepare("SELECT name FROM files WHERE id = ? AND project_id = ?")
    .bind(event.fileId, event.projectId)
    .first<{ name: string }>()
  const title = file?.name ?? humanPassageLabel(event.spanLabel) ?? event.fileId
  return title.slice(0, 160)
}

/**
 * Append one activity fact to the run's thread, opening the thread (and its
 * main-channel dispatch message) the first time the run says anything.
 *
 * Never throws. The caller is the pipeline's durable-telemetry path; a
 * channel outage must not stop translation work.
 */
export async function ingestRunActivity(
  db: AquillaDb,
  event: ContextualRunEvent,
): Promise<void> {
  try {
    const mapped = mapRunEvent(event)
    if (!mapped) return

    const { thread, created } = await ensureThread(db, {
      projectId: event.projectId,
      sourceKind: "run",
      sourceRef: event.runId,
      title: await resolveThreadTitle(db, event),
    })

    // Exactly one writer wins the thread INSERT, so the dispatch message that
    // owns this thread lands in the main channel exactly once.
    if (created) {
      await appendMessage(db, {
        projectId: event.projectId,
        threadId: null,
        author: { kind: "persona", id: "coordinator" },
        bodyKind: "text",
        body: { text: dispatchText(thread.title), threadId: thread.id },
      })
    }

    // Collapse consecutive same-region phase updates for the same span, the
    // way the client feed does — a long run should read as a conversation,
    // not as the same line repeated once per wave.
    if (mapped.body.kind === "phase") {
      const previous = await latestSpanActivity(
        db,
        event.projectId,
        thread.id,
        event.spanId,
      )
      const body = previous?.body as { kind?: string; region?: string } | undefined
      if (body?.kind === "phase" && body.region === mapped.body.region) return
    }

    await appendMessage(db, {
      projectId: event.projectId,
      threadId: thread.id,
      author: { kind: "persona", id: mapped.persona },
      bodyKind: "activity",
      body: mapped.body as unknown as Record<string, unknown>,
    })
    await touchThread(db, thread.id)
  } catch (error) {
    console.error("[team-ingest] write-through failed", {
      runId: event.runId,
      kind: event.kind,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}
