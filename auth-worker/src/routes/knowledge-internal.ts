// Server-to-server knowledge-base upload + list for the external Agent API
// (AQU-1762).
//
//   POST /api/v2/internal/projects/:projectId/knowledge  → { doc }
//   GET  /api/v2/internal/projects/:projectId/knowledge  → { docs }
//
// Why the Agent API's knowledge routes land here rather than being reimplemented
// in sync-worker: the knowledge base is auth-worker's end to end — the extension
// allowlist and the docx/pdf text extraction (routes/parse-document.ts), the
// PageIndex indexing job that holds the OpenRouter key (lib/knowledge/
// index-doc.ts), and the `kb/…` R2 layout. A second uploader in sync-worker
// would fork extraction and leave every agent-uploaded doc at index_status
// 'pending' forever, which index-doc.ts explicitly rules out ("every exit has to
// be terminal"). So sync-worker's /api/v1/external/projects/:projectId/knowledge
// authenticates the `aqk_` credential and bridges the bytes here, the same
// shared-secret pattern as ai-draft-internal.ts and ai-brief-internal.ts.
//
// Authorization: the SYNC_SECRET_KEY bearer proves the caller is sync-worker, and
// `x-acting-user-id` names WHO the upload acts as — it never asserts what they
// may do. The role is re-resolved live, at the same floors the in-app routes use
// (PROJECT_LEAD to upload, VIEWER to list), so a credential whose owner lost
// access, or whose project was archived, is refused here too.

import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { secureCompare } from "../utils/secure-compare"
import { handleUpload } from "./knowledge"
import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import { listProjectDocsWithNodeCounts } from "../../../db/shared/knowledge"

const knowledgeInternal = new Hono<AuthHonoEnv>()

type ErrorCode = "not_found" | "permission_denied" | "validation_failed" | "job_failed"

/** Same envelope the session-authed knowledge routes use, so the sync-worker
 *  bridge reads one shape whichever half answered. */
function errorJson(c: Context<AuthHonoEnv>, code: ErrorCode, message: string, status: ContentfulStatusCode) {
  return c.json({ error: { code, message } }, status)
}

interface Gated {
  ok: true
  projectId: string
  /** Stored as knowledge_docs.created_by, matching the in-app upload's value. */
  createdBy: string
}

async function gate(
  c: Context<AuthHonoEnv>,
  floor: number,
): Promise<Gated | { ok: false; res: Response }> {
  const authHeader = c.req.header("Authorization")
  if (!c.env.SYNC_SECRET_KEY || !secureCompare(authHeader ?? "", `Bearer ${c.env.SYNC_SECRET_KEY}`)) {
    return { ok: false, res: errorJson(c, "permission_denied", "unauthorized", 401) }
  }

  const projectId = c.req.param("projectId") ?? ""
  if (!projectId) {
    return { ok: false, res: errorJson(c, "validation_failed", "projectId is required", 400) }
  }

  const actingUserId = c.req.header("x-acting-user-id")?.trim()
  if (!actingUserId) {
    return {
      ok: false,
      res: errorJson(c, "validation_failed", "x-acting-user-id header is required", 400),
    }
  }

  const db = c.env.AQUILLA_PG
  if (!db) return { ok: false, res: errorJson(c, "job_failed", "AQUILLA_PG not configured", 500) }

  // Live role, archived projects excluded (resolveProjectRoleShared returns null
  // for them) — the caller's credential scope is sync-worker's business; whether
  // the person behind it still has the role is ours.
  const role = await resolveProjectRoleShared(db, { id: actingUserId }, projectId)
  if (!role || role.level < floor) {
    return {
      ok: false,
      res: errorJson(c, "permission_denied", "you do not have sufficient access on this project", 403),
    }
  }

  const user = await db
    .prepare("SELECT username FROM users WHERE id = ?")
    .bind(actingUserId)
    .first<{ username: string | null }>()

  return { ok: true, projectId, createdBy: user?.username ?? actingUserId }
}

knowledgeInternal.post("/projects/:projectId/knowledge", async (c) => {
  const gated = await gate(c, ROLE.PROJECT_LEAD)
  if (!gated.ok) return gated.res
  return handleUpload(c, { projectId: gated.projectId }, gated.createdBy)
})

knowledgeInternal.get("/projects/:projectId/knowledge", async (c) => {
  const gated = await gate(c, ROLE.VIEWER)
  if (!gated.ok) return gated.res
  // nodeCount comes along so a caller can tell "uploaded" from "indexed"
  // without fetching each doc's tree (AQU-1762).
  return c.json({ docs: await listProjectDocsWithNodeCounts(c.env.AQUILLA_PG, gated.projectId) })
})

export default knowledgeInternal
