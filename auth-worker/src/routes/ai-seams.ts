// POST /api/v1/ai/seams/classify — seam classification for meaning-unit
// drafting (AQU-1386).
//
// A SEAM is the boundary between two adjacent source cells. The client sends a
// window of cells; this route asks Jev (TypeSafe's decision model) a handful of
// narrow questions per seam in ONE batched call, combines the answers with the
// SAME rule the client uses, and returns a decision per seam.
//
// Why the call lives here and not in the browser: the key stays server-side,
// exactly like /api/v1/chat. The client never sees a Jev credential.
//
// Why this route does NOT run runAiGuard:
//   runAiGuard enforces the LLM model allowlist — the set of drafting models a
//   user may pick. `typesafe/jev-1.13` is not one of those: it is pinned in
//   code, never user-supplied, returns probabilities rather than text, and
//   costs about $0.00003 per call. Adding it to the drafting allowlist to
//   satisfy a guard would make it selectable as a translation model, which it
//   is not. What this route actually needs is volumetric control, so it takes
//   the same per-user sliding-window cap the chat proxy uses as its floor.
//
// Failure is never fatal. Upstream down, unauthenticated, malformed, or merely
// unconfident → the route answers 200 with heuristic decisions and says so in
// `decidedBy`. Classification is an optimisation; drafting must keep working
// without it, which is also what makes it safe to compute in the background.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { ROLE } from "../types"
import { authMiddleware } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../../db/shared/rate-limit"
import {
  combineSeam,
  DEFAULT_SEAM_THRESHOLDS,
  type SeamDecision,
} from "../../../src/lib/completion/seams"
import {
  buildSeamRequest,
  parseSeamAnswers,
  JEV_DECISIONS_URL,
  JEV_MODEL,
  MAX_SEAMS_PER_REQUEST,
  type SeamWindowCell,
} from "../../../src/lib/completion/seam-request"

const aiSeams = new Hono<{ Bindings: Env; Variables: Variables }>()

/** Classification reads source text the caller can already read. Anyone who can
 *  see the project's cells may have their seams classified — draft-as-you-read
 *  is used by reviewers, not only contributors. */
const MIN_SEAM_ROLE = ROLE.VIEWER

/**
 * Per-user sliding-window cap, same primitive and window as the chat proxy's.
 * Sized for the real workload: seams are computed once per file and cached, so
 * a translator opening a dozen large files in a sitting stays far under it,
 * while a scripted loop against the shared key does not.
 */
const SEAMS_MAX_PER_USER_PER_WINDOW = 400

/** Upstream latency budget. A seam call is 150–500ms in the normal case; past
 *  this the heuristic is simply a better deal than waiting. */
const SEAM_TIMEOUT_MS = 10_000

const MAX_CELL_CHARS = 4_000

const cellSchema = z.object({
  id: z.string().trim().min(1).max(255),
  text: z.string().max(MAX_CELL_CHARS),
  ref: z.string().trim().max(255).nullish(),
  style: z.string().trim().max(255).nullish(),
})

const bodySchema = z.object({
  projectId: z.string().trim().min(1).max(255),
  /** One window, in document order, all from the SAME file. A seam never spans
   *  files, so the client windows per file before calling. */
  cells: z.array(cellSchema).min(2).max(MAX_SEAMS_PER_REQUEST + 1),
})

export interface SeamResult extends SeamDecision {
  /** Cell ids either side of the seam — so the caller can key the cache
   *  without relying on array position surviving a round trip. */
  prevCellId: string
  nextCellId: string
}

/**
 * Resolve the decisions endpoint.
 *
 * OpenRouter fronts TypeSafe's evaluation API at `/api/alpha/decisions`, a
 * sibling of `/api/v1` rather than a path under it — so deriving it from
 * OPENROUTER_BASE_URL means replacing the version segment, not appending. The
 * dev stack's scripted mock (OPENROUTER_BASE_URL=http://127.0.0.1:9999/v1)
 * lands on /alpha/decisions the same way production does.
 */
export function resolveSeamUrl(env: Pick<Env, "OPENROUTER_BASE_URL">): string {
  const base = env.OPENROUTER_BASE_URL?.trim()
  if (!base) return JEV_DECISIONS_URL
  const trimmed = base.replace(/\/+$/, "")
  const withoutVersion = trimmed.replace(/\/v\d+$/, "")
  return `${withoutVersion}/alpha/decisions`
}

/** Heuristic-only answer for the whole window — the shape every failure path
 *  returns, so a caller cannot tell an outage from a low-confidence file apart
 *  from `decidedBy`, and does not need to. */
function heuristicWindow(cells: SeamWindowCell[]): SeamResult[] {
  return cells.slice(0, -1).map((prev, i) => ({
    ...combineSeam(null, prev.text),
    prevCellId: prev.id,
    nextCellId: cells[i + 1].id,
  }))
}

aiSeams.post(
  "/classify",
  authMiddleware,
  zValidator("json", bodySchema),
  async (c) => {
    const input = c.req.valid("json")
    const user = c.get("user")

    const role = await resolveProjectRole(c.env, user, input.projectId)
    if (!role || role.level < MIN_SEAM_ROLE) {
      return c.json(
        { error: "permission_denied", message: "Project access is required." },
        403,
      )
    }

    const cells: SeamWindowCell[] = input.cells.map((cell) => ({
      id: cell.id,
      text: cell.text,
      ref: cell.ref ?? null,
      style: cell.style ?? null,
    }))

    const identifier = `user:${user.id}`
    const recent = await countRecentRateLimitEvents(c.env.AQUILLA_PG, "ai_seams", identifier)
    if (recent >= SEAMS_MAX_PER_USER_PER_WINDOW) {
      // Rate-limited is still a 200 of heuristic seams rather than a 429: the
      // caller is a background job whose only sensible response to an error is
      // to use the heuristic anyway. Failing it loudly would turn a cost
      // control into an outage of a feature that has a working fallback.
      return c.json({ seams: heuristicWindow(cells), model: null, rateLimited: true })
    }
    await recordRateLimitEvent(c.env.AQUILLA_PG, "ai_seams", identifier)

    if (!c.env.OPENROUTER_API_KEY) {
      return c.json({ seams: heuristicWindow(cells), model: null })
    }

    let answers: ReturnType<typeof parseSeamAnswers> | null = null
    try {
      const res = await fetch(resolveSeamUrl(c.env), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildSeamRequest(cells)),
        signal: AbortSignal.timeout(SEAM_TIMEOUT_MS),
      })
      if (res.ok) {
        answers = parseSeamAnswers(await res.json(), cells.length - 1)
      } else {
        console.warn(`[ai-seams] upstream ${res.status}; using heuristic seams`)
      }
    } catch (err) {
      console.warn("[ai-seams] classification failed; using heuristic seams:", err)
    }

    if (!answers) return c.json({ seams: heuristicWindow(cells), model: null })

    // The combine rule runs HERE, not in the client, and the client re-runs the
    // identical function over cached answers. One implementation, in
    // src/lib/completion/seams.ts, imported by both.
    const seams: SeamResult[] = cells.slice(0, -1).map((prev, i) => ({
      ...combineSeam(answers[i], prev.text, DEFAULT_SEAM_THRESHOLDS),
      prevCellId: prev.id,
      nextCellId: cells[i + 1].id,
    }))

    return c.json({ seams, model: JEV_MODEL })
  },
)

export default aiSeams
