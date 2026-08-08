// Knowledge base HTTP surface (spec: docs/superpowers/specs/2026-08-07-knowledge-base-design.md).
// projectKnowledge mounts at /api/v2/projects, orgKnowledge at /api/v2/orgs.
// Originals live in R2 (SNAPSHOTS) under kb/…; extracted text + tree in
// knowledge_docs via db/shared/knowledge.ts. Indexing runs async (waitUntil).
import { Hono, type Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { extractTextFromDocx, extractTextFromPdf } from "./parse-document"
import { indexKnowledgeDoc } from "../lib/knowledge/index-doc"
import {
  createDoc,
  listProjectDocs,
  listOrgDocs,
  getDocMeta,
  getDocTree,
  getDocText,
  deleteDoc,
  searchKnowledge,
  kbExtension,
  kbR2Key,
  MAX_KB_ORIGINAL_BYTES,
  MAX_KB_EXTRACT_INPUT_BYTES,
  MAX_KB_TEXT_CHARS,
  type KnowledgeScopeRef,
  type KnowledgeDocMeta,
} from "../../../db/shared/knowledge"

type ErrorCode =
  | "not_found"
  | "permission_denied"
  | "validation_failed"
  | "storage_unavailable"
  | "job_failed"

function errorJson(code: ErrorCode, message: string, status: ContentfulStatusCode) {
  return { body: { error: { code, message } }, status } as const
}

// ──────────────────────────────────────────────────────────────────────────
// Shared internals
// ──────────────────────────────────────────────────────────────────────────

/** decodeURIComponent that never throws (mirrors agent-artifacts.ts). */
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

type ExtractResult =
  | { ok: true; text: string }
  | { ok: false; code: ErrorCode; message: string; status: ContentfulStatusCode }

function extractText(fileName: string, bytes: Uint8Array): ExtractResult {
  const ext = kbExtension(fileName)
  let text: string
  if (ext === ".md" || ext === ".txt") {
    text = new TextDecoder().decode(bytes)
  } else if (ext === ".docx" || ext === ".pdf") {
    if (bytes.byteLength > MAX_KB_EXTRACT_INPUT_BYTES) {
      return {
        ok: false,
        code: "validation_failed",
        message: `file exceeds the ${MAX_KB_EXTRACT_INPUT_BYTES}-byte extraction limit`,
        status: 400,
      }
    }
    try {
      text = ext === ".docx" ? extractTextFromDocx(bytes) : extractTextFromPdf(bytes)
    } catch {
      return { ok: false, code: "validation_failed", message: "could not extract text", status: 422 }
    }
  } else {
    return { ok: false, code: "validation_failed", message: "unsupported file extension", status: 400 }
  }

  if (!text.trim()) {
    return {
      ok: false,
      code: "validation_failed",
      message: "document contains no extractable text",
      status: 422,
    }
  }
  return { ok: true, text: text.slice(0, MAX_KB_TEXT_CHARS) }
}

/** Fire the indexing job off c.executionCtx.waitUntil when available; in the
 *  test harness there's no real ExecutionContext and the getter throws, so
 *  fall back to letting the promise settle on its own (matches the pattern
 *  used elsewhere in this worker, e.g. routes/project-members.ts). */
function runIndexing(c: Context<AuthHonoEnv>, docId: string): void {
  const task = indexKnowledgeDoc(c.env, c.env.AQUILLA_PG, docId)
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    void task
  }
}

async function handleUpload(
  c: Context<AuthHonoEnv>,
  scope: KnowledgeScopeRef,
  createdBy: string,
): Promise<Response> {
  const bucket = c.env.SNAPSHOTS
  if (!bucket) {
    const { body, status } = errorJson(
      "storage_unavailable",
      "artifact storage (SNAPSHOTS) is not configured on this worker",
      503,
    )
    return c.json(body, status)
  }

  const rawName = c.req.header("x-doc-name")?.trim()
  const fileName = rawName ? safeDecode(rawName) : ""
  if (!fileName) {
    const { body, status } = errorJson("validation_failed", "x-doc-name header is required", 400)
    return c.json(body, status)
  }
  if (kbExtension(fileName) == null) {
    const { body, status } = errorJson("validation_failed", "unsupported file extension", 400)
    return c.json(body, status)
  }

  const contentType = c.req.header("content-type") ?? null
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (bytes.byteLength === 0) {
    const { body, status } = errorJson("validation_failed", "uploaded file is empty", 400)
    return c.json(body, status)
  }
  if (bytes.byteLength > MAX_KB_ORIGINAL_BYTES) {
    const { body, status } = errorJson(
      "validation_failed",
      `file exceeds the ${MAX_KB_ORIGINAL_BYTES}-byte limit`,
      400,
    )
    return c.json(body, status)
  }

  const extracted = extractText(fileName, bytes)
  if (!extracted.ok) {
    const { body, status } = errorJson(extracted.code, extracted.message, extracted.status)
    return c.json(body, status)
  }

  const id = crypto.randomUUID()
  const sha256 = await sha256Hex(bytes)
  const r2Key = kbR2Key(c.env.R2_KEY_PREFIX, scope, id)

  await bucket.put(r2Key, bytes, {
    httpMetadata: contentType ? { contentType } : undefined,
  })

  try {
    await createDoc(c.env.AQUILLA_PG, {
      id,
      scope,
      name: fileName,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256,
      r2Key,
      extractedText: extracted.text,
      createdBy,
    })
  } catch (err) {
    // Roll back the orphaned R2 object so a failed insert leaves no dangling blob.
    await bucket.delete(r2Key).catch(() => {})
    const { body, status } = errorJson("job_failed", `knowledge doc insert failed: ${String(err)}`, 500)
    return c.json(body, status)
  }

  runIndexing(c, id)

  const doc = await getDocMeta(c.env.AQUILLA_PG, id)
  return c.json({ doc }, 201)
}

async function handleDelete(
  c: Context<AuthHonoEnv>,
  docId: string,
  scopeCheck: (meta: KnowledgeDocMeta) => { ok: true } | { ok: false; res: Response },
): Promise<Response> {
  const meta = await getDocMeta(c.env.AQUILLA_PG, docId)
  if (!meta) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }
  const check = scopeCheck(meta)
  if (!check.ok) return check.res

  await deleteDoc(c.env.AQUILLA_PG, docId)
  const bucket = c.env.SNAPSHOTS
  if (bucket) await bucket.delete(meta.r2Key).catch(() => {})
  return c.json({ ok: true })
}

async function handleOriginal(c: Context<AuthHonoEnv>, meta: KnowledgeDocMeta): Promise<Response> {
  const bucket = c.env.SNAPSHOTS
  if (!bucket) {
    const { body, status } = errorJson(
      "storage_unavailable",
      "artifact storage (SNAPSHOTS) is not configured on this worker",
      503,
    )
    return c.json(body, status)
  }
  const obj = await bucket.get(meta.r2Key)
  if (!obj) {
    const { body, status } = errorJson("not_found", "original file not found in storage", 404)
    return c.json(body, status)
  }
  const bytes = await obj.arrayBuffer()
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": meta.contentType ?? "application/octet-stream",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    },
  })
}

// ──────────────────────────────────────────────────────────────────────────
// Project router
// ──────────────────────────────────────────────────────────────────────────

export const projectKnowledge = new Hono<AuthHonoEnv>()

/** Resolve the caller's live role floor on a project; null/below floor → 403. */
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

/** A doc is visible from a project when it belongs to it or to its org. */
async function projectVisibleDoc(
  c: Context<AuthHonoEnv>,
  projectId: string,
  docId: string,
): Promise<KnowledgeDocMeta | null> {
  const meta = await getDocMeta(c.env.AQUILLA_PG, docId)
  if (!meta) return null
  if (meta.projectId === projectId) return meta
  if (meta.orgId != null) {
    const row = await c.env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ org_id: number | null }>()
    if (row?.org_id != null && row.org_id === meta.orgId) return meta
  }
  return null
}

projectKnowledge.get("/:projectId/knowledge", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  return c.json({ docs: await listProjectDocs(c.env.AQUILLA_PG, projectId) })
})

// Registered BEFORE /:docId — otherwise "search" is captured as a docId.
projectKnowledge.get("/:projectId/knowledge/search", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res
  const q = c.req.query("q") ?? ""
  const limit = Math.min(Number.parseInt(c.req.query("limit") ?? "5", 10) || 5, 20)
  return c.json({ snippets: await searchKnowledge(c.env.AQUILLA_PG, projectId, q, limit) })
})

projectKnowledge.get("/:projectId/knowledge/:docId", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const docId = c.req.param("docId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const doc = await projectVisibleDoc(c, projectId, docId)
  if (!doc) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }
  const result = await getDocTree(c.env.AQUILLA_PG, docId)
  return c.json({ doc, tree: result?.tree ?? null })
})

projectKnowledge.get("/:projectId/knowledge/:docId/content", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const docId = c.req.param("docId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const doc = await projectVisibleDoc(c, projectId, docId)
  if (!doc) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }
  const nodeId = c.req.query("nodeId")
  const result = await getDocText(c.env.AQUILLA_PG, docId, nodeId)
  if (!result) {
    const { body, status } = errorJson("not_found", "node not found", 404)
    return c.json(body, status)
  }
  return c.json({ text: result.text })
})

projectKnowledge.get("/:projectId/knowledge/:docId/original", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const docId = c.req.param("docId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.VIEWER)
  if (!gate.ok) return gate.res

  const doc = await projectVisibleDoc(c, projectId, docId)
  if (!doc) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }
  return handleOriginal(c, doc)
})

projectKnowledge.post("/:projectId/knowledge", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
  if (!gate.ok) return gate.res
  const user = c.get("user")
  return handleUpload(c, { projectId }, user.username ?? String(user.id))
})

projectKnowledge.delete("/:projectId/knowledge/:docId", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const docId = c.req.param("docId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
  if (!gate.ok) return gate.res

  return handleDelete(c, docId, (meta) => {
    if (meta.projectId !== projectId) {
      const { body, status } = errorJson(
        "permission_denied",
        "org documents are managed at the org level",
        403,
      )
      return { ok: false, res: c.json(body, status) }
    }
    return { ok: true }
  })
})

projectKnowledge.post("/:projectId/knowledge/:docId/reindex", authMiddleware, async (c) => {
  const projectId = c.req.param("projectId") ?? ""
  const docId = c.req.param("docId") ?? ""
  const gate = await requireRole(c, projectId, ROLE.PROJECT_LEAD)
  if (!gate.ok) return gate.res

  const meta = await getDocMeta(c.env.AQUILLA_PG, docId)
  if (!meta) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }
  if (meta.projectId !== projectId) {
    const { body, status } = errorJson(
      "permission_denied",
      "org documents are managed at the org level",
      403,
    )
    return c.json(body, status)
  }

  await c.env.AQUILLA_PG.prepare(`UPDATE knowledge_docs SET index_status = 'pending' WHERE id = ?`)
    .bind(docId)
    .run()
  runIndexing(c, docId)
  return c.json({ ok: true }, 202)
})

// ──────────────────────────────────────────────────────────────────────────
// Org router
// ──────────────────────────────────────────────────────────────────────────

export const orgKnowledge = new Hono<AuthHonoEnv>()

function parseOrgId(c: Context<AuthHonoEnv>): number | null {
  const raw = c.req.param("orgId") ?? ""
  const orgId = Number.parseInt(raw, 10)
  return Number.isFinite(orgId) ? orgId : null
}

async function requireOrgRole(
  c: Context<AuthHonoEnv>,
  orgId: number,
  floor: number,
): Promise<{ ok: true; role: number } | { ok: false; res: Response }> {
  const user = c.get("user")
  const role = await getEffectiveOrgRole(c.env, orgId, user)
  if (role == null || role < floor) {
    const { body, status } = errorJson(
      "permission_denied",
      "you do not have sufficient access on this organization",
      403,
    )
    return { ok: false, res: c.json(body, status) }
  }
  return { ok: true, role }
}

orgKnowledge.get("/:orgId/knowledge", authMiddleware, async (c) => {
  const orgId = parseOrgId(c)
  if (orgId == null) {
    const { body, status } = errorJson("validation_failed", "invalid org id", 400)
    return c.json(body, status)
  }
  const gate = await requireOrgRole(c, orgId, 0)
  if (!gate.ok) return gate.res
  return c.json({ docs: await listOrgDocs(c.env.AQUILLA_PG, orgId) })
})

orgKnowledge.get("/:orgId/knowledge/:docId", authMiddleware, async (c) => {
  const orgId = parseOrgId(c)
  if (orgId == null) {
    const { body, status } = errorJson("validation_failed", "invalid org id", 400)
    return c.json(body, status)
  }
  const gate = await requireOrgRole(c, orgId, 0)
  if (!gate.ok) return gate.res
  const docId = c.req.param("docId") ?? ""
  const meta = await getDocMeta(c.env.AQUILLA_PG, docId)
  if (!meta || meta.orgId !== orgId) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }
  const result = await getDocTree(c.env.AQUILLA_PG, docId)
  return c.json({ doc: meta, tree: result?.tree ?? null })
})

orgKnowledge.get("/:orgId/knowledge/:docId/content", authMiddleware, async (c) => {
  const orgId = parseOrgId(c)
  if (orgId == null) {
    const { body, status } = errorJson("validation_failed", "invalid org id", 400)
    return c.json(body, status)
  }
  const gate = await requireOrgRole(c, orgId, 0)
  if (!gate.ok) return gate.res
  const docId = c.req.param("docId") ?? ""
  const meta = await getDocMeta(c.env.AQUILLA_PG, docId)
  if (!meta || meta.orgId !== orgId) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }
  const nodeId = c.req.query("nodeId")
  const result = await getDocText(c.env.AQUILLA_PG, docId, nodeId)
  if (!result) {
    const { body, status } = errorJson("not_found", "node not found", 404)
    return c.json(body, status)
  }
  return c.json({ text: result.text })
})

orgKnowledge.get("/:orgId/knowledge/:docId/original", authMiddleware, async (c) => {
  const orgId = parseOrgId(c)
  if (orgId == null) {
    const { body, status } = errorJson("validation_failed", "invalid org id", 400)
    return c.json(body, status)
  }
  const gate = await requireOrgRole(c, orgId, 0)
  if (!gate.ok) return gate.res
  const docId = c.req.param("docId") ?? ""
  const meta = await getDocMeta(c.env.AQUILLA_PG, docId)
  if (!meta || meta.orgId !== orgId) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }
  return handleOriginal(c, meta)
})

orgKnowledge.post("/:orgId/knowledge", authMiddleware, async (c) => {
  const orgId = parseOrgId(c)
  if (orgId == null) {
    const { body, status } = errorJson("validation_failed", "invalid org id", 400)
    return c.json(body, status)
  }
  const gate = await requireOrgRole(c, orgId, ROLE.MAINTAINER)
  if (!gate.ok) return gate.res
  const user = c.get("user")
  return handleUpload(c, { orgId }, user.username ?? String(user.id))
})

orgKnowledge.delete("/:orgId/knowledge/:docId", authMiddleware, async (c) => {
  const orgId = parseOrgId(c)
  if (orgId == null) {
    const { body, status } = errorJson("validation_failed", "invalid org id", 400)
    return c.json(body, status)
  }
  const gate = await requireOrgRole(c, orgId, ROLE.MAINTAINER)
  if (!gate.ok) return gate.res
  const docId = c.req.param("docId") ?? ""

  return handleDelete(c, docId, (meta) => {
    if (meta.orgId !== orgId) {
      const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
      return { ok: false, res: c.json(body, status) }
    }
    return { ok: true }
  })
})

orgKnowledge.post("/:orgId/knowledge/:docId/reindex", authMiddleware, async (c) => {
  const orgId = parseOrgId(c)
  if (orgId == null) {
    const { body, status } = errorJson("validation_failed", "invalid org id", 400)
    return c.json(body, status)
  }
  const gate = await requireOrgRole(c, orgId, ROLE.MAINTAINER)
  if (!gate.ok) return gate.res
  const docId = c.req.param("docId") ?? ""
  const meta = await getDocMeta(c.env.AQUILLA_PG, docId)
  if (!meta || meta.orgId !== orgId) {
    const { body, status } = errorJson("not_found", `knowledge doc ${docId} not found`, 404)
    return c.json(body, status)
  }

  await c.env.AQUILLA_PG.prepare(`UPDATE knowledge_docs SET index_status = 'pending' WHERE id = ?`)
    .bind(docId)
    .run()
  runIndexing(c, docId)
  return c.json({ ok: true }, 202)
})
