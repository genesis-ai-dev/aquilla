// Agent memory + project brief HTTP surface (AQU-AGENT contracts §3, owner
// W1C). Mounted at /api/v2/projects in src/index.ts (sibling to the other
// per-project routers). All endpoints sit behind authMiddleware (browser
// session JWT); project-role floors are resolved live via resolveProjectRole.
//
// Agent channel: a request carrying header `x-aquilla-agent-run: <runId>` is
// agent-originated. On such requests (contracts §3 "Agent-channel enforcement"):
//   - PATCH to a `human_edited=true` row → 403 human_edit_protected.
//   - memory review → allowed ONLY when the project setting
//     agentMemoryAutonomy === 'agent-low-risk' AND the path starts with
//     `observations/`; else 403.
//   - brief PUT → 403 brief_human_only.
//   - brief-proposal review → 403 (NEVER agent channel).
//
// Error envelope mirrors changeset-approvals / sync-worker external:
// `{ error: { code, message, details? } }`.

import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { loadProjectSettings } from "../../../db/shared/projects"
import {
  createProposal,
  listMemories,
  getMemory,
  reviewMemory,
  humanEdit,
  getBrief,
  putBrief,
  createBriefProposal,
  listBriefProposals,
  reviewBriefProposal,
  readAgentMemoryAutonomy,
  agentReviewAllowed,
  type MemoryStatus,
} from "../../../db/shared/agent-memory"

const agentMemory = new Hono<AuthHonoEnv>()

const AGENT_RUN_HEADER = "x-aquilla-agent-run"

type ErrorCode =
  | "not_found"
  | "permission_denied"
  | "validation_failed"
  | "human_edit_protected"
  | "agent_edit_forbidden"
  | "brief_human_only"
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

// ──────────────────────────────────────────────────────────────────────────
// Memory
// ──────────────────────────────────────────────────────────────────────────

const STATUSES: MemoryStatus[] = ["proposed", "approved", "rejected", "archived"]

// GET /:projectId/agent-memory?status= — list memories (VIEWER+).
agentMemory.get("/:projectId/agent-memory", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const statusParam = c.req.query("status")
  if (statusParam && !STATUSES.includes(statusParam as MemoryStatus)) {
    const { body, status } = errorJson("validation_failed", `unknown status "${statusParam}"`, 400)
    return c.json(body, status)
  }
  const memories = await listMemories(
    c.env.AQUILLA_PG,
    projectId,
    statusParam as MemoryStatus | undefined,
  )
  return c.json({ memories })
})

const createMemorySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  rationale: z.string().optional(),
  provenance: z
    .object({
      runId: z.string().optional(),
      sessionId: z.string().optional(),
      credentialId: z.string().optional(),
    })
    .optional(),
})

// POST /:projectId/agent-memory — propose a memory (CONTRIBUTOR+). Path/size/
// secret validation happens in the shared primitive.
agentMemory.post(
  "/:projectId/agent-memory",
  authMiddleware,
  zValidator("json", createMemorySchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res

    const user = c.get("user")
    const { path, content, rationale, provenance } = c.req.valid("json")
    const runId = c.req.header(AGENT_RUN_HEADER)
    const result = await createProposal(c.env.AQUILLA_PG, {
      projectId,
      path,
      content,
      rationale,
      // Agent runs stamp their runId onto provenance so a human reviewer can
      // trace where a proposal came from.
      provenance: runId ? { ...provenance, runId } : provenance,
      createdBy: user.username,
    })
    if (result.status === "validation_failed") {
      const { body, status } = errorJson("validation_failed", result.message, 400)
      return c.json(body, status)
    }
    return c.json({ memoryId: result.memory.id, status: result.memory.status, memory: result.memory }, 201)
  },
)

const reviewSchema = z.object({ action: z.enum(["approve", "reject"]) })

// POST /:projectId/agent-memory/:id/review — approve/reject (PROJECT_LEAD+, or
// agent channel under agent-low-risk autonomy for observations/ paths).
agentMemory.post(
  "/:projectId/agent-memory/:id/review",
  authMiddleware,
  zValidator("json", reviewSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const id = c.req.param("id") ?? ""
    const { action } = c.req.valid("json")
    const db = c.env.AQUILLA_PG

    const memory = await getMemory(db, id)
    if (!memory || memory.projectId !== projectId) {
      const { body, status } = errorJson("not_found", `memory ${id} not found`, 404)
      return c.json(body, status)
    }

    const isAgent = !!c.req.header(AGENT_RUN_HEADER)
    if (isAgent) {
      // Agent review is gated by project autonomy + observations/ path only.
      const { settings } = await loadProjectSettings(db, projectId)
      const autonomy = readAgentMemoryAutonomy(settings)
      if (!agentReviewAllowed(autonomy, memory.path)) {
        const { body, status } = errorJson(
          "agent_review_denied",
          "agent-channel review requires agent-low-risk autonomy and an observations/ path",
          403,
        )
        return c.json(body, status)
      }
    } else {
      const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
      if (!gate.ok) return gate.res
    }

    const user = c.get("user")
    const result = await reviewMemory(db, { id, action, reviewedBy: user.username })
    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `memory ${id} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "invalid_state") {
      const { body, status } = errorJson("validation_failed", result.message, 409)
      return c.json(body, status)
    }
    return c.json({ memory: result.memory })
  },
)

const patchSchema = z.object({ content: z.string() })

// PATCH /:projectId/agent-memory/:id — human edit (PROJECT_LEAD+, or CONTRIBUTOR
// on own proposal). Agent channel is blocked on human_edited rows.
agentMemory.patch(
  "/:projectId/agent-memory/:id",
  authMiddleware,
  zValidator("json", patchSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const id = c.req.param("id") ?? ""
    const { content } = c.req.valid("json")
    const db = c.env.AQUILLA_PG
    const user = c.get("user")

    const memory = await getMemory(db, id)
    if (!memory || memory.projectId !== projectId) {
      const { body, status } = errorJson("not_found", `memory ${id} not found`, 404)
      return c.json(body, status)
    }

    // The agent channel can never PATCH at all: humanEdit() marks the row
    // human_edited, so an agent PATCH would launder agent output into the
    // protected human-authored state. Agents propose (POST) or ask; only
    // humans edit in place.
    if (c.req.header(AGENT_RUN_HEADER)) {
      const { body, status } = errorJson(
        memory.humanEdited ? "human_edit_protected" : "agent_edit_forbidden",
        memory.humanEdited
          ? "this memory was edited by a human and cannot be modified by the agent"
          : "agents cannot edit memories in place — submit a new proposal instead",
        403,
      )
      return c.json(body, status)
    }

    const role = await resolveProjectRole(c.env, user, projectId)
    const isLead = !!role && role.level >= ROLE.PROJECT_LEAD
    const isOwnProposal =
      !!role &&
      role.level >= ROLE.CONTRIBUTOR &&
      memory.createdBy === user.username &&
      memory.status === "proposed"
    if (!isLead && !isOwnProposal) {
      const { body, status } = errorJson(
        "permission_denied",
        "editing a memory requires project-lead access, or contributor on your own proposal",
        403,
      )
      return c.json(body, status)
    }

    const result = await humanEdit(db, { id, content, editedBy: user.username })
    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `memory ${id} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "validation_failed") {
      const { body, status } = errorJson("validation_failed", result.message, 400)
      return c.json(body, status)
    }
    return c.json({ memory: result.memory })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// Brief
// ──────────────────────────────────────────────────────────────────────────

// GET /:projectId/brief — read the brief (VIEWER+).
agentMemory.get("/:projectId/brief", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  const brief = await getBrief(c.env.AQUILLA_PG, projectId)
  return c.json({ brief })
})

const putBriefSchema = z.object({
  content: z.string(),
  ifMatchVersion: z.number().int().nonnegative(),
})

// PUT /:projectId/brief — edit the brief (PROJECT_LEAD+, humans only).
agentMemory.put(
  "/:projectId/brief",
  authMiddleware,
  zValidator("json", putBriefSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    if (c.req.header(AGENT_RUN_HEADER)) {
      const { body, status } = errorJson(
        "brief_human_only",
        "the project brief is human-authored — the agent may only propose changes",
        403,
      )
      return c.json(body, status)
    }
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res

    const user = c.get("user")
    const { content, ifMatchVersion } = c.req.valid("json")
    const result = await putBrief(c.env.AQUILLA_PG, {
      projectId,
      content,
      ifMatchVersion,
      updatedBy: user.username,
    })
    if (result.status === "conflict") {
      const { body, status } = errorJson(
        "conflict",
        "brief version conflict — reload and retry",
        409,
        { currentVersion: result.current.version },
      )
      return c.json(body, status)
    }
    return c.json({ brief: result.brief })
  },
)

const briefProposalSchema = z.object({
  content: z.string(),
  rationale: z.string().optional(),
})

// POST /:projectId/brief/proposals — propose a brief edit (CONTRIBUTOR+, agent
// or human).
agentMemory.post(
  "/:projectId/brief/proposals",
  authMiddleware,
  zValidator("json", briefProposalSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const gate = await requireRole(c, projectId, ROLE.CONTRIBUTOR)
    if (!gate.ok) return gate.res
    const user = c.get("user")
    const { content, rationale } = c.req.valid("json")
    const proposal = await createBriefProposal(c.env.AQUILLA_PG, {
      projectId,
      content,
      rationale,
      createdBy: user.username,
    })
    return c.json({ proposalId: proposal.id, proposal }, 201)
  },
)

// GET /:projectId/brief/proposals?status= — list brief proposals (VIEWER+).
agentMemory.get("/:projectId/brief/proposals", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  const statusParam = c.req.query("status")
  const valid = ["proposed", "approved", "rejected"]
  if (statusParam && !valid.includes(statusParam)) {
    const { body, status } = errorJson("validation_failed", `unknown status "${statusParam}"`, 400)
    return c.json(body, status)
  }
  const proposals = await listBriefProposals(
    c.env.AQUILLA_PG,
    projectId,
    statusParam as "proposed" | "approved" | "rejected" | undefined,
  )
  return c.json({ proposals })
})

// POST /:projectId/brief/proposals/:id/review — approve/reject (PROJECT_LEAD+,
// NEVER agent channel).
agentMemory.post(
  "/:projectId/brief/proposals/:id/review",
  authMiddleware,
  zValidator("json", reviewSchema),
  async (c) => {
    const projectId = c.req.param("projectId") ?? ""
    const id = c.req.param("id") ?? ""
    const { action } = c.req.valid("json")
    const db = c.env.AQUILLA_PG

    if (c.req.header(AGENT_RUN_HEADER)) {
      const { body, status } = errorJson(
        "brief_human_only",
        "brief-proposal review is human-only",
        403,
      )
      return c.json(body, status)
    }
    const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
    if (!gate.ok) return gate.res

    const existing = await db
      .prepare(`SELECT project_id FROM project_brief_proposals WHERE id = ?`)
      .bind(id)
      .first<{ project_id: string }>()
    if (!existing || existing.project_id !== projectId) {
      const { body, status } = errorJson("not_found", `brief proposal ${id} not found`, 404)
      return c.json(body, status)
    }

    const user = c.get("user")
    const result = await reviewBriefProposal(db, { id, action, reviewedBy: user.username })
    if (result.status === "not_found") {
      const { body, status } = errorJson("not_found", `brief proposal ${id} not found`, 404)
      return c.json(body, status)
    }
    if (result.status === "invalid_state") {
      const { body, status } = errorJson("validation_failed", result.message, 409)
      return c.json(body, status)
    }
    return c.json({ proposal: result.proposal, brief: result.brief })
  },
)

export default agentMemory
