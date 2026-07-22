// Agent artifact upload (AQU-AGENT Wave-2, integrator W2-INT).
//
//   POST /api/v2/projects/:projectId/agent-artifacts
//     Body  = raw bytes of the attached file.
//     Header  x-artifact-name (required) — the original file name.
//             content-type    (optional) — stored as-is for later inspection.
//     → { artifactId, fileName, sizeBytes, sha256 }
//
// WHY a thin auth-worker route (not the existing sync-worker artifacts route):
// the SPA agent composer holds a browser SESSION JWT, whereas sync-worker's
// `/api/v1/external/.../artifacts` requires an `aqk_` API credential (that flow
// is for external API callers, not the SPA). This route lets a signed-in
// CONTRIBUTOR+ attach a file to their agent run without minting a credential.
//
// It proxies bytes into the SAME place the sync-worker route does — the
// `aquilla-snapshots` R2 bucket under `{prefix}artifacts/{projectId}/{id}`,
// plus a row in the shared `artifacts` table — so the harness's `load_artifact`
// tool (auth-worker/src/lib/agent/harness-tools.ts), which resolves
// `artifacts.r2_key` directly and hands it to the sandbox's fetch-artifact,
// finds the bytes with no changes. Key layout + table columns mirror
// sync-worker/src/external/artifacts-route.ts exactly.
//
// `credential_id` is NOT NULL in the schema but there is no API credential on
// this path, so it stores the sentinel `SESSION_UPLOAD_SENTINEL` ("session") —
// distinguishable from real credential UUIDs — for provenance.

import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"

const agentArtifacts = new Hono<AuthHonoEnv>()

/** Max attached file size — 25 MB, matching sync-worker's MAX_ARTIFACT_BYTES. */
export const MAX_AGENT_ARTIFACT_BYTES = 25 * 1024 * 1024

/** Placeholder for the NOT-NULL `credential_id` column: session-JWT uploads
 *  carry no `aqk_` credential. A fixed sentinel (not a UUID) so provenance
 *  queries can tell session uploads from API-credential uploads. */
export const SESSION_UPLOAD_SENTINEL = "session"

type ErrorCode = "permission_denied" | "validation_failed" | "storage_unavailable" | "job_failed"

function errorJson(code: ErrorCode, message: string, status: ContentfulStatusCode) {
  return { body: { error: { code, message } }, status } as const
}

/** `{prefix}artifacts/{projectId}/{artifactId}` — identical to sync-worker's
 *  artifactR2Key. Prefix is empty in every current env. */
function artifactR2Key(env: AuthHonoEnv["Bindings"], projectId: string, artifactId: string): string {
  const p = env.R2_KEY_PREFIX?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  const prefix = p ? `${p}/` : ""
  return `${prefix}artifacts/${projectId}/${artifactId}`
}

/** decodeURIComponent that never throws (a filename with a literal `%` that
 *  isn't a valid escape falls back to the raw string). */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")
}

agentArtifacts.post("/:projectId/agent-artifacts", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""

  const bucket = c.env.SNAPSHOTS
  if (!bucket) {
    const { body, status } = errorJson(
      "storage_unavailable",
      "artifact storage (SNAPSHOTS) is not configured on this worker",
      503,
    )
    return c.json(body, status)
  }

  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < ROLE.CONTRIBUTOR) {
    const { body, status } = errorJson(
      "permission_denied",
      "attaching a file requires contributor access on this project",
      403,
    )
    return c.json(body, status)
  }

  // The SPA percent-encodes the name so a Unicode / comma / space filename is a
  // valid HTTP header token; decode it back for storage + the model-facing note.
  const rawName = c.req.header("x-artifact-name")?.trim()
  const fileName = rawName ? safeDecode(rawName) : ""
  if (!fileName) {
    const { body, status } = errorJson("validation_failed", "x-artifact-name header is required", 400)
    return c.json(body, status)
  }
  const contentType = c.req.header("content-type") ?? null

  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.byteLength === 0) {
    const { body, status } = errorJson("validation_failed", "attached file is empty", 400)
    return c.json(body, status)
  }
  if (bytes.byteLength > MAX_AGENT_ARTIFACT_BYTES) {
    const { body, status } = errorJson(
      "validation_failed",
      `attached file exceeds the ${MAX_AGENT_ARTIFACT_BYTES}-byte limit`,
      400,
    )
    return c.json(body, status)
  }

  const artifactId = crypto.randomUUID()
  const sha256 = await sha256Hex(bytes)
  const r2Key = artifactR2Key(c.env, projectId, artifactId)

  await bucket.put(r2Key, bytes, {
    httpMetadata: contentType ? { contentType } : undefined,
  })

  try {
    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO artifacts
         (id, project_id, uploaded_by_user_id, credential_id, name, content_type, size_bytes, sha256, r2_key, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'source')`,
    )
      .bind(
        artifactId,
        projectId,
        String(user.id),
        SESSION_UPLOAD_SENTINEL,
        fileName,
        contentType,
        bytes.byteLength,
        sha256,
        r2Key,
      )
      .run()
  } catch (err) {
    // Roll back the orphaned R2 object so a failed insert leaves no dangling blob.
    await bucket.delete(r2Key).catch(() => {})
    const { body, status } = errorJson("job_failed", `artifact insert failed: ${String(err)}`, 500)
    return c.json(body, status)
  }

  return c.json({ artifactId, fileName, sizeBytes: bytes.byteLength, sha256 }, 201)
})

export default agentArtifacts
