// POST /api/v1/ai/agent/internal/draft-cells — server-to-server drafting
// (AQU-1186, Agent API parity epic AQU-1181 item 7).
//
// The external Agent API's `DraftCells` command lets an agent ask the app to
// draft instead of writing its own text. The drafting pipeline lives HERE (it
// owns the OpenRouter key, the model allowlist, the AI budget guard, and the
// credit ledger), while the changeset engine that stages the result lives in
// sync-worker. So sync-worker calls this endpoint with the SAME shared-secret
// pattern it uses for /api/v2/monday/internal/push, and stages what comes back.
//
// This endpoint NEVER writes: it returns compiled target.cell.commit payloads
// (value + ai_draft provenance) and nothing else. Staging, the approval gate,
// and the commit are the caller's — that is what keeps "no auto-commit" true.
//
// Cost rails:
//   - the model allowlist + per-user/global AI budget (runAiGuard), same as
//     every other paid surface;
//   - creditGuard on the `agent` rail BEFORE any paid call, so an exhausted org
//     fails cleanly and nothing is generated (and therefore nothing is staged);
//   - recordCredit on the same rail after the call, so spend is metered
//     identically to an in-app agent draft.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { secureCompare } from "../utils/secure-compare"
import { runAiGuard } from "../lib/ai-budget"
import { getPlatformSettingsCached } from "../lib/platform-settings"
import { creditGuard, recordCredit } from "../lib/credits"
import { AliasMap } from "../lib/agent/compress"
import { generateDrafts } from "../lib/agent/tools/draft"
import { DEFAULT_LLM_MODEL_ID } from "../lib/model-defaults"
import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import {
  MAX_COMPLETION_BATCH_SIZE,
  completionBatchSizeFromSettings,
} from "../../../db/shared/completion-batch"

const aiDraftInternal = new Hono<{ Bindings: Env; Variables: Variables }>()

/** target.cell.commit's role floor — drafting writes target cells. */
const REQUIRED_ROLE_COMMIT = 400

const bodySchema = z.object({
  projectId: z.string().min(1),
  /** The user the draft acts as — role is resolved live, never trusted. */
  userId: z.union([z.string().min(1), z.number()]),
  fileId: z.string().min(1),
  /** Explicit cells only — the caller has already rejected wildcards. */
  cellIds: z.array(z.string().min(1)).min(1).max(MAX_COMPLETION_BATCH_SIZE),
  instructions: z.string().max(2000).optional(),
})

function resolveOpenRouterUrl(env: Env): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"
}

aiDraftInternal.post("/internal/draft-cells", zValidator("json", bodySchema), async (c) => {
  // Same shared-secret pattern as monday/internal/push and sync-worker's
  // __broadcast. This endpoint is server-to-server only — it is never reachable
  // with a user session or a PAT.
  const authHeader = c.req.header("Authorization")
  if (!c.env.SYNC_SECRET_KEY || !secureCompare(authHeader ?? "", `Bearer ${c.env.SYNC_SECRET_KEY}`)) {
    return c.json({ error: "unauthorized" }, 401)
  }

  const body = c.req.valid("json")
  const db = c.env.AQUILLA_PG
  if (!db) return c.json({ error: "job_failed", message: "AQUILLA_PG not configured" }, 500)

  // Live role resolution — defence in depth. sync-worker gates on the same
  // floor at prepare; a drafting call that could never be committed must not
  // spend a cent here either.
  const role = await resolveProjectRoleShared(db, { id: String(body.userId) }, body.projectId)
  if (!role || role.level < REQUIRED_ROLE_COMMIT) {
    return c.json({ error: "permission_denied", message: "drafting needs the contributor role" }, 403)
  }

  const platformSettings = await getPlatformSettingsCached(c.env)
  const model =
    platformSettings.agentDraftModel ||
    c.env.AGENT_DRAFT_MODEL_DEFAULT ||
    platformSettings.agentModel ||
    c.env.AGENT_MODEL_DEFAULT ||
    DEFAULT_LLM_MODEL_ID

  const guard = await runAiGuard(model, Number(body.userId), db, c.env)
  if (!guard.ok) return c.json(guard.body, guard.status)

  // Org for the credit rails: the project's org (0 = personal/org-less).
  let orgId = 0
  try {
    const projectRow = await db
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(body.projectId)
      .first<{ org_id: number | null }>()
    orgId = projectRow?.org_id ?? 0
  } catch {
    /* best-effort — degrade to org 0 so spend is still recorded */
  }

  // Pre-flight the expensive rail BEFORE generating: an exhausted org gets a
  // clean named error and nothing is drafted, so nothing can be staged.
  const creditCheck = await creditGuard(db, c.env, orgId, "agent")
  if (!creditCheck.ok) {
    return c.json(
      {
        error: "credit_cap_exceeded",
        reason: creditCheck.reason,
        message: "Agent credit cap reached. Contact your org admin.",
      },
      429,
    )
  }

  // Prompt grounding — best-effort, identical to the agent run's.
  let sourceLanguage: string | undefined
  let targetLanguage: string | undefined
  let briefSummary: string | undefined
  let batchCap = completionBatchSizeFromSettings(null)
  try {
    const settings = await db
      .prepare(
        `SELECT settings::jsonb ->> 'sourceLanguage' AS source_language,
                settings::jsonb ->> 'targetLanguage' AS target_language,
                settings::jsonb -> 'translationBrief' ->> 'l1Summary' AS brief_summary,
                settings AS raw
           FROM project_settings WHERE project_id = ?`,
      )
      .bind(body.projectId)
      .first<{
        source_language: string | null
        target_language: string | null
        brief_summary: string | null
        raw: unknown
      }>()
    if (settings) {
      sourceLanguage = settings.source_language ?? undefined
      targetLanguage = settings.target_language ?? undefined
      briefSummary = settings.brief_summary ?? undefined
      const raw = typeof settings.raw === "string" ? JSON.parse(settings.raw) : settings.raw
      batchCap = completionBatchSizeFromSettings(
        raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null,
      )
    }
  } catch {
    /* grounding is best-effort — drafting proceeds with the defaults */
  }

  // The caller enforces the same cap at prepare; re-derive it here so this
  // endpoint can never be pushed past the project's configured package size.
  if (body.cellIds.length > batchCap) {
    return c.json(
      { error: "validation_failed", message: `cellIds exceeds the project's completion batch size`, cap: batchCap },
      400,
    )
  }

  let costCents = 0
  const gen = await generateDrafts(
    db,
    { fileId: body.fileId, cellIds: body.cellIds, limit: body.cellIds.length, instructions: body.instructions },
    {
      projectId: body.projectId,
      focusedFileId: body.fileId,
      aliases: new AliasMap(),
      sourceLanguage,
      targetLanguage,
      briefSummary,
      signal: c.req.raw.signal,
      sendProgress: () => {},
      addUsage: (u) => {
        costCents += (u.cost ?? 0) * 100
      },
      maxCells: batchCap,
    },
    { model, apiKey: c.env.OPENROUTER_API_KEY ?? "", url: resolveOpenRouterUrl(c.env) },
  )

  // Meter whatever was actually spent, success or failure — the research pass
  // costs money even when generation then fails. Never throws.
  if (costCents > 0) await recordCredit(db, orgId, Number(body.userId), "agent", costCents, 1)

  if (!gen.ok) return c.json({ error: "job_failed", message: gen.error }, 502)

  return c.json({
    fileId: gen.fileId,
    model,
    drafts: gen.emits.map((e) => ({
      cellId: e.cellId,
      value: e.payload.value as string,
      aiDraft: e.payload.ai_draft,
    })),
    missed: gen.missed,
    remaining: gen.remaining,
  })
})

export default aiDraftInternal
