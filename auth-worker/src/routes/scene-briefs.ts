// Scene-brief HTTP surface (contextual translation pipeline design §9).
// Mounted at /api/v2/projects in src/index.ts beside routes/agent-memory.ts.
// All endpoints sit behind authMiddleware (browser session JWT); project-role
// floors are resolved live via resolveProjectRole.
//
// Floors (§9): list = VIEWER, propose = CONTRIBUTOR (scene briefs are
// translation work product — translators can read/refine the analyzer's
// construals), review = PROJECT_LEAD.
//
// Agent channel: a request carrying header `x-aquilla-agent-run: <runId>` is
// agent-originated. Mirrors agent-memory's rules:
//   - PATCH → 403 always (human_edit_protected on a human-edited row,
//     agent_edit_forbidden otherwise) — agents propose, never edit in place.
//   - review → 403 agent_review_denied (no autonomy carve-out for briefs).
//
// Error envelope mirrors changeset-approvals / agent-memory:
// `{ error: { code, message, details? } }`.

import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import {
  proposeSceneBrief,
  listSceneBriefs,
  getSceneBrief,
  reviewSceneBrief,
  updateSceneBrief,
  type SceneBriefStatus,
} from "../../../db/shared/scene-briefs"

const sceneBriefs = new Hono<AuthHonoEnv>()

const AGENT_RUN_HEADER = "x-aquilla-agent-run"

type ErrorCode =
  | "not_found"
  | "permission_denied"
  | "validation_failed"
  | "human_edit_protected"
  | "agent_edit_forbidden"
  | "agent_review_denied"
  | "conflict"

function errorJson(
  code: ErrorCode,
  message: string,
  status: ContentfulStatusCode,
  details?: unknown,
) {
  return {
    body: { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    status,
  } as const
}

/** Resolve the caller's live role floor on a project; null → no access. */
async function requireRole(
  c: Context<AuthHonoEnv>,
  projectId: string,
  floor: number,
): Promise<{ ok: true } | { ok: false; res: Response }> {
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < floor) {
    const { body, status } = errorJson(
      "permission_denied",
      "you do not have sufficient access on this project",
      403,
    )
    return { ok: false, res: c.json(body, status) }
  }
  return { ok: true }
}

const STATUSES: SceneBriefStatus[] = ["proposed", "approved", "rejected", "archived"]

// GET /:projectId/scene-briefs?fileId=&status= — list briefs (VIEWER+).
sceneBriefs.get("/:projectId/scene-briefs", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const statusParam = c.req.query("status")
  if (statusParam && !STATUSES.includes(statusParam as SceneBriefStatus)) {
    const { body, status } = errorJson("validation_failed", `unknown status "${statusParam}"`, 400)
    return c.json(body, status)
  }
  const briefs = await listSceneBriefs(c.env.AQUILLA_PG, projectId, {
    fileId: c.req.query("fileId"),
    status: statusParam as SceneBriefStatus | undefined,
  })
  return c.json({ sceneBriefs: briefs })
})

const ambiguityEntrySchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  evidenceCellIds: z.array(z.string()).optional(),
  note: z.string().optional(),
})

const provenanceSchema = z.object({
  runId: z.string().optional(),
  spanSeedSource: z.string().optional(),
  closureRounds: z.number().int().nonnegative().optional(),
  windowCellIds: z.array(z.string()).optional(),
})

const proposeSchema = z.object({
  fileId: z.string().min(1),
  startCellId: z.string().min(1),
  endCellId: z.string().min(1),
  targetLang: z.string().optional(),
  construal: z.string().min(1),
  ambiguityRegister: z.array(ambiguityEntrySchema).optional(),
  l1Summary: z.string().optional(),
  l1ModelId: z.string().optional(),
  provenance: provenanceSchema.optional(),
})

// POST /:projectId/scene-briefs — propose a brief (CONTRIBUTOR+). Size/secret
// validation happens in the shared primitive.
sceneBriefs.post(
  "/:projectId/scene-briefs",
  authMiddleware,
  zValidator("json", proposeSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res

    const user = c.get("user")
    const body = c.req.valid("json")
    const runId = c.req.header(AGENT_RUN_HEADER)
    const result = await proposeSceneBrief(c.env.AQUILLA_PG, {
      projectId,
      fileId: body.fileId,
      startCellId: body.startCellId,
      endCellId: body.endCellId,
      targetLang: body.targetLang,
      construal: body.construal,
      ambiguityRegister: body.ambiguityRegister,
      l1Summary: body.l1Summary,
      l1ModelId: body.l1ModelId,
      // Agent runs stamp their runId onto provenance so a human reviewer can
      // trace where a proposal came from.
      provenance: runId ? { ...body.provenance, runId } : body.provenance,
      createdBy: user.username,
    })
    if (result.status === "validation_failed") {
      const { body: err, status } = errorJson("validation_failed", result.message, 400)
      return c.json(err, status)
    }
    return c.json({ sceneBriefId: result.brief.id, status: result.brief.status, sceneBrief: result.brief }, 201)
  },
)

const reviewSchema = z.object({ action: z.enum(["approve", "reject"]) })

// POST /:projectId/scene-briefs/:sbId/review — approve/reject (PROJECT_LEAD+,
// humans only — no autonomy carve-out for scene briefs).
sceneBriefs.post(
  "/:projectId/scene-briefs/:sbId/review",
  authMiddleware,
  zValidator("json", reviewSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const id = c.req.param("sbId") ?? ""
    const { action } = c.req.valid("json")
    const db = c.env.AQUILLA_PG

    const brief = await getSceneBrief(db, id)
    if (!brief || brief.projectId !== projectId) {
      const { body, status } = errorJson("not_found", `scene brief ${id} not found`, 404)
      return c.json(body, status)
    }

    if (c.req.header(AGENT_RUN_HEADER)) {
      const { body, status } = errorJson(
        "agent_review_denied",
        "scene-brief review is human-only — a project lead must approve or reject",
        403,
      )
      return c.json(body, status)
    }
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res

    const user = c.get("user")
    const result = await reviewSceneBrief(db, { id, action, reviewedBy: user.username })
    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `scene brief ${id} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "invalid_state") {
      const { body, status } = errorJson("validation_failed", result.message, 409)
      return c.json(body, status)
    }
    return c.json({ sceneBrief: result.brief })
  },
)

const patchSchema = z.object({
  ifMatchVersion: z.number().int().positive(),
  construal: z.string().min(1).optional(),
  ambiguityRegister: z.array(ambiguityEntrySchema).optional(),
  l1Summary: z.string().nullable().optional(),
  l1ModelId: z.string().nullable().optional(),
})

// PATCH /:projectId/scene-briefs/:sbId — human edit (PROJECT_LEAD+, or
// CONTRIBUTOR on own proposal). Agent channel is blocked entirely.
sceneBriefs.patch(
  "/:projectId/scene-briefs/:sbId",
  authMiddleware,
  zValidator("json", patchSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const id = c.req.param("sbId") ?? ""
    const body = c.req.valid("json")
    const db = c.env.AQUILLA_PG
    const user = c.get("user")

    const brief = await getSceneBrief(db, id)
    if (!brief || brief.projectId !== projectId) {
      const { body: err, status } = errorJson("not_found", `scene brief ${id} not found`, 404)
      return c.json(err, status)
    }

    // The agent channel can never PATCH at all: updateSceneBrief() marks the
    // row human_edited, so an agent PATCH would launder agent output into the
    // protected human-authored state. Agents propose (POST) or ask; only
    // humans edit in place.
    if (c.req.header(AGENT_RUN_HEADER)) {
      const { body: err, status } = errorJson(
        brief.humanEdited ? "human_edit_protected" : "agent_edit_forbidden",
        brief.humanEdited
          ? "this scene brief was edited by a human and cannot be modified by the agent"
          : "agents cannot edit scene briefs in place — submit a new proposal instead",
        403,
      )
      return c.json(err, status)
    }

    const role = await resolveProjectRole(c.env, user, projectId)
    const isLead = !!role && role.level >= ROLE.PROJECT_LEAD
    const isOwnProposal =
      !!role &&
      role.level >= ROLE.CONTRIBUTOR &&
      brief.createdBy === user.username &&
      brief.status === "proposed"
    if (!isLead && !isOwnProposal) {
      const { body: err, status } = errorJson(
        "permission_denied",
        "editing a scene brief requires project-lead access, or contributor on your own proposal",
        403,
      )
      return c.json(err, status)
    }

    const result = await updateSceneBrief(db, {
      id,
      ifMatchVersion: body.ifMatchVersion,
      construal: body.construal,
      ambiguityRegister: body.ambiguityRegister,
      l1Summary: body.l1Summary,
      l1ModelId: body.l1ModelId,
      editedBy: user.username,
    })
    if (result.status === "not_found") {
      const { body: err, status } = errorJson("not_found", `scene brief ${id} not found`, 404)
      return c.json(err, status)
    }
    if (result.status === "validation_failed") {
      const { body: err, status } = errorJson("validation_failed", result.message, 400)
      return c.json(err, status)
    }
    if (result.status === "conflict") {
      const { body: err, status } = errorJson(
        "conflict",
        "scene brief version conflict — reload and retry",
        409,
        { currentVersion: result.currentVersion },
      )
      return c.json(err, status)
    }
    return c.json({ sceneBrief: result.brief })
  },
)

export default sceneBriefs
