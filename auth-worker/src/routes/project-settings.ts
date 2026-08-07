// Project settings routes — versioned JSON blob with optimistic-concurrency
// control (Aquilla spec 03-data-model.md §"Project Settings"). Mounted at
// /api/v2/projects in src/index.ts; sub-paths:
//
//   GET  /:projectId/settings        any project member
//   PUT  /:projectId/settings        maintainer (600)+ per AD-6, except a
//                                    term-base-only write, which is
//                                    contributor (400)+ (AQU-816)
//   PATCH /:projectId/settings       compatibility alias for older web builds
//
// Writes require `ifMatchVersion` (query string or header). On mismatch the
// response is 409 with the current row attached so the client can show
// "settings changed elsewhere — refresh and reapply." On match we run a
// single atomic UPDATE that re-checks the version inside the WHERE clause —
// meta.changes == 0 means a concurrent writer landed first and we 409 with
// the now-stored row.
//
// Settings keys (all optional per spec): sourceLanguage, targetLanguage,
// systemPrompt, rules, rulePenalties, decaySettings, validationCount,
// validationCountAudio. We don't enforce the key set here — the server is
// a dumb store, the client owns the shape. The spec note about
// `targetLanguage` left unset identifying a source-only project (AD-9) is
// purely a downstream interpretation.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { notifySyncWorkerOfProjectSettingsChange } from "../services/sync-worker-notify"
import {
  loadProjectSettings,
  normalizeSettings,
  updateProjectSettingsShared,
} from "../../../db/shared/projects"

const projectSettings = new Hono<AuthHonoEnv>()

// Minimum role allowed to write settings — `maintainer` per the spec
// (project-configuration stories: name-and-configure-project,
// customize-ai-settings, monitor-project-health, validate-translation).
const SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER

// AQU-816: the term base is the one settings key a *contributor* may curate.
// Translators are the people who know the right rendering for a term, so they
// add and maintain terms themselves; everything else in the blob (system
// prompt / AI instructions, validation policy, languages, rules) stays at
// SETTINGS_WRITE_MIN_ROLE. Because the client PUTs the whole merged blob, the
// gate is enforced by diffing the incoming blob against the stored one and
// requiring that `terminology` is the only key that actually moved.
const TERMINOLOGY_WRITE_MIN_ROLE = ROLE.CONTRIBUTOR
const TERMINOLOGY_KEY = "terminology"

/** Structural equality for settings values (JSON-shaped, key-order agnostic). */
function settingsValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => settingsValueEqual(item, b[i]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (!settingsValueEqual(left[key], right[key])) return false
  }
  return true
}

/** Settings keys whose value differs between the stored row and the write. */
function changedSettingsKeys(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  const changed: string[] = []
  for (const key of keys) {
    if (!settingsValueEqual(current[key], next[key])) changed.push(key)
  }
  return changed
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects/:projectId/settings
// ──────────────────────────────────────────────────────────────────────────

projectSettings.get("/:projectId/settings", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)

  const response = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
  return c.json(response)
})

// ──────────────────────────────────────────────────────────────────────────
// PUT/PATCH /api/v2/projects/:projectId/settings
//
// Body shape:
//   { settings: object, ifMatchVersion?: number }
//
// `ifMatchVersion` may also be supplied via:
//   - query string ?ifMatchVersion=N
//   - header `If-Match-Version: N`
//
// The version-match check is server-authoritative: even if a client sends
// no version, we still require one — there's no "force write" path. The
// 409 response includes the current stored row so the client can rebase.
// ──────────────────────────────────────────────────────────────────────────

const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  ifMatchVersion: z.number().int().nonnegative().optional(),
})

function parseIntOrNull(s: string | undefined): number | null {
  if (s == null) return null
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

projectSettings.on(
  ["PUT", "PATCH"],
  "/:projectId/settings",
  authMiddleware,
  zValidator("json", updateSettingsSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const body = c.req.valid("json")

    const role = await resolveProjectRole(c.env, user, projectId)
    if (!role) return c.json({ error: "no access to project" }, 403)
    if (role.level < SETTINGS_WRITE_MIN_ROLE) {
      // AQU-816: below the general floor, the only admissible write is a
      // term-base-only one by a contributor or above. Diff against the stored
      // row (normalized the same way the write will be) so echoing back
      // untouched keys is not mistaken for editing them. Racing writers are
      // still caught downstream: updateProjectSettingsShared re-reads the row
      // and 409s unless its version is the one we diffed against.
      const stored = await loadProjectSettings(c.env.AQUILLA_PG, projectId)
      const changed = changedSettingsKeys(
        stored.settings as Record<string, unknown>,
        normalizeSettings(body.settings),
      )
      const termbaseOnly = changed.every((key) => key === TERMINOLOGY_KEY)
      if (!termbaseOnly) {
        return c.json(
          { error: `role >= maintainer (${SETTINGS_WRITE_MIN_ROLE}) required` },
          403,
        )
      }
      if (role.level < TERMINOLOGY_WRITE_MIN_ROLE) {
        return c.json(
          {
            error: `role >= contributor (${TERMINOLOGY_WRITE_MIN_ROLE}) required to change the term base`,
          },
          403,
        )
      }
    }

    const queryVersion = parseIntOrNull(c.req.query("ifMatchVersion"))
    const headerVersion = parseIntOrNull(c.req.header("If-Match-Version"))
    const ifMatchVersion =
      body.ifMatchVersion ?? queryVersion ?? headerVersion

    if (ifMatchVersion == null) {
      return c.json(
        {
          error:
            "ifMatchVersion required (body, query, or If-Match-Version header)",
        },
        400,
      )
    }

    // Row-write domain logic (version pre-check, first-write INSERT vs
    // version-guarded UPDATE, validation-threshold reprojection) is shared with
    // sync-worker's receipt-only UpdateProjectSettings command
    // (db/shared/projects.ts). The route keeps only HTTP concerns: role gate,
    // ifMatchVersion extraction, status mapping, and the best-effort notify.
    const result = await updateProjectSettingsShared(c.env.AQUILLA_PG, {
      projectId,
      settings: body.settings,
      ifMatchVersion,
      updatedBy: user.id,
    })

    if (result.status === "conflict") {
      return c.json({ error: "version mismatch", current: result.current }, 409)
    }
    if (result.status === "error") {
      return c.json({ error: `write failed: ${result.message}` }, 500)
    }

    const fresh = result.settings
    // Settings live in identity while connected editor clients listen to the
    // project sync DO. This is a best-effort acceleration: a missed frame is
    // recovered by the existing focus/reconnect settings read.
    const notifyPromise = notifySyncWorkerOfProjectSettingsChange(c.env, projectId, fresh.version)
    try {
      c.executionCtx.waitUntil(notifyPromise)
    } catch {
      // Hono's direct test harness has no ExecutionContext. The notification
      // remains best-effort there just as it is in a deployed Worker.
      void notifyPromise
    }
    return c.json(fresh)
  },
)

export default projectSettings
