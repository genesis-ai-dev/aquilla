// POST /api/v1/ai/harmonize/passage — cross-cell suggestions for one passage
// (AQU-1657).
//
// The harmonizer's checks (src/lib/harmonizer/) plan deterministically, ask
// Jev about the SOURCE in one batched call, and turn the answers into
// exact-span suggestions. Like the seam and smart-edit routes this never fails
// its caller: a kill switch, no key, a timeout, an upstream error or the rate
// window all answer 200 with no suggestions, and `jev` says which. Jev stays
// outside the credit guard for the same reason as ai-seams.ts — pinned, never
// user-selectable, fractions of a cent — and volume is bounded per user.
//
// Suggestions only: nothing here writes to a cell. Kill switch: HARMONIZER=off.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { ROLE } from "../types"
import { authMiddleware } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../../db/shared/rate-limit"
import { callJev } from "../lib/jev/client"
import { JEV_MODEL } from "../../../src/lib/completion/seam-request"
import { harmonizerFindings, planHarmonizer } from "../../../src/lib/harmonizer/runner"
import type { HarmonizerFinding } from "../../../src/lib/harmonizer/types"

type AppEnv = { Bindings: Env; Variables: Variables }
const aiHarmonize = new Hono<AppEnv>()

const MAX_CELLS = 60
const MAX_CELL_CHARS = 4_000
const MAX_PER_USER_PER_WINDOW = 400
const JEV_TIMEOUT_MS = 8_000

const passageSchema = z.object({
  projectId: z.string().trim().min(1).max(255),
  lane: z.string().max(64).default(""),
  cells: z
    .array(
      z.object({
        fileId: z.string().trim().min(1).max(255),
        cellId: z.string().trim().min(1).max(255),
        ref: z.string().max(64).optional(),
        source: z.string().max(MAX_CELL_CHARS),
        target: z.string().max(MAX_CELL_CHARS),
        validated: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(MAX_CELLS),
})

export type HarmonizerSuggestion = HarmonizerFinding & { fileId: string }

type JevOutcome = "skipped" | "model" | "no_key" | "timeout" | "upstream"

aiHarmonize.post("/passage", authMiddleware, zValidator("json", passageSchema), async (c) => {
  const input = c.req.valid("json")
  const user = c.get("user")
  if (c.env.HARMONIZER?.trim().toLowerCase() === "off") {
    return c.json({ suggestions: [], jev: "skipped" as JevOutcome, disabled: true })
  }

  const role = await resolveProjectRole(c.env, user, input.projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return c.json({ error: "permission_denied", message: "Project access is required." }, 403)
  }

  const cells = input.cells.map((cell) => ({
    id: cell.cellId,
    source: cell.source,
    target: cell.target,
    ...(cell.ref ? { ref: cell.ref } : {}),
    ...(cell.validated ? { validated: true } : {}),
  }))
  // Plan before spending the rate window: most passages have nothing to ask.
  const run = planHarmonizer(cells, JEV_MODEL)
  if (!run.request) return c.json({ suggestions: [], jev: "skipped" as JevOutcome })

  const db = c.env.AQUILLA_PG
  const identifier = `user:${user.id}`
  if ((await countRecentRateLimitEvents(db, "ai_harmonize", identifier)) >= MAX_PER_USER_PER_WINDOW) {
    return c.json({ suggestions: [], jev: "skipped" as JevOutcome, rateLimited: true })
  }
  await recordRateLimitEvent(db, "ai_harmonize", identifier)

  const called = await callJev(c.env, run.request, JEV_TIMEOUT_MS)
  if (!called.ok) return c.json({ suggestions: [], jev: called.reason as JevOutcome })

  const fileOf = new Map(input.cells.map((cell) => [cell.cellId, cell.fileId]))
  const suggestions: HarmonizerSuggestion[] = harmonizerFindings(run, cells, called.body).map((f) => ({
    ...f,
    fileId: fileOf.get(f.cellId) ?? "",
  }))
  return c.json({ suggestions, jev: "model" as JevOutcome })
})

export default aiHarmonize
