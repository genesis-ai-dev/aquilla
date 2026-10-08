// Aquilla Tools API (prototype). Mounted under /api/v2/projects.
//
//   GET    /:projectId/tools                       list (+ caller's standing grant)
//   POST   /:projectId/tools                       create  { source, manifest, origin, buildMeta?, grant? }
//   GET    /:projectId/tools/:toolId               current version incl. source
//   GET    /:projectId/tools/:toolId/versions      version history
//   POST   /:projectId/tools/:toolId/versions      new version { source, manifest, origin, buildMeta? }
//   PUT    /:projectId/tools/:toolId/grant         { scopes } — the caller's standing grant
//   DELETE /:projectId/tools/:toolId               archive
//   GET    /:projectId/tools/:toolId/activity?since=<ms>   attributed writes + revert inputs
//   POST   /:projectId/tools/:toolId/copy      share as an OWNED copy into { targetProjectId }
//   GET    /:projectId/tools/:toolId/source?version=N   one version's source (code review)
//   POST   /:projectId/tools/build                 one builder attempt (routes/tools-build.ts)
//
// Authorization: any member can list/run tools (a tool can do nothing its
// user cannot — every write is an ordinary event the sync-worker authorizes).
// Creating or changing a tool needs CONTRIBUTOR. A grant may only name scopes
// the tool's manifest declares; the role ceiling is enforced client-side when
// prompting and server-side on every event.

import { Hono } from "hono"
import type { Context } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"
import { isToolScope, type ToolScope } from "../../../shared/tools/manifest"
import {
  addVersion,
  archiveTool,
  checkVersion,
  createTool,
  getTool,
  listTools,
  listVersions,
  setGrant,
  type SaveVersionInput,
  type ToolVersionOrigin,
} from "../lib/tools/store"
import { readToolActivity } from "../lib/tools/activity"
import { buildToolRoute } from "./tools-build"

const tools = new Hono<AuthHonoEnv>()

type Ctx = Context<AuthHonoEnv>

const pid = (c: Ctx): string => c.req.param("projectId") ?? ""
const tid = (c: Ctx): string => c.req.param("toolId") ?? ""

function err(c: Ctx, status: 400 | 403 | 404 | 409 | 500 | 502 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

async function roleFor(c: Ctx): Promise<number | null> {
  const projectId = pid(c)
  const role = await resolveProjectRole(c.env, c.get("user"), projectId)
  return role ? role.level : null
}

const ORIGINS: readonly ToolVersionOrigin[] = ["starter", "builder", "edit", "copy"]

async function readSaveInput(c: Ctx): Promise<(SaveVersionInput & { grant: unknown }) | string> {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return "body must be JSON"
  if (typeof body.source !== "string") return "source is required"
  const origin = ORIGINS.find((o) => o === body.origin)
  if (!origin) return "origin must be one of starter|builder|edit|copy"
  const meta = body.buildMeta
  return {
    source: body.source,
    manifest: body.manifest,
    origin,
    buildMeta: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null,
    upstreamToolId: typeof body.upstreamToolId === "string" ? body.upstreamToolId : null,
    grant: body.grant,
  }
}

tools.get("/:projectId/tools", authMiddleware, async (c) => {
  if ((await roleFor(c)) == null) return err(c, 404, "not_found", "project not found")
  const list = await listTools(c.env.AQUILLA_PG, pid(c), c.get("user").id)
  return c.json({ tools: list })
})

tools.post("/:projectId/tools/build", authMiddleware, buildToolRoute)

tools.post("/:projectId/tools", authMiddleware, async (c) => {
  const level = await roleFor(c)
  if (level == null) return err(c, 404, "not_found", "project not found")
  if (level < ROLE.CONTRIBUTOR) return err(c, 403, "permission_denied", "installing a tool requires contributor access")
  const input = await readSaveInput(c)
  if (typeof input === "string") return err(c, 400, "validation_failed", input)
  const checked = await checkVersion(input)
  if (!checked.ok) return c.json({ error: { code: "validation_failed", message: "tool failed the save gates", errors: checked.errors, lint: checked.lint } }, 400)

  const projectId = pid(c)
  const userId = c.get("user").id
  const toolId = await createTool(c.env.AQUILLA_PG, projectId, userId, input, checked)

  // Install = the standing grant, approved in the same gesture. Only scopes
  // the manifest declares can be granted.
  const grant = Array.isArray(input.grant) ? input.grant.filter(isToolScope).filter((s) => checked.manifest.scopes.includes(s)) : []
  if (grant.length > 0) await setGrant(c.env.AQUILLA_PG, projectId, toolId, userId, grant)

  const tool = await getTool(c.env.AQUILLA_PG, projectId, toolId, userId)
  return c.json({ tool }, 201)
})

tools.get("/:projectId/tools/:toolId", authMiddleware, async (c) => {
  if ((await roleFor(c)) == null) return err(c, 404, "not_found", "project not found")
  const tool = await getTool(c.env.AQUILLA_PG, pid(c), tid(c), c.get("user").id)
  if (!tool) return err(c, 404, "not_found", "tool not found")
  return c.json({ tool })
})

tools.get("/:projectId/tools/:toolId/versions", authMiddleware, async (c) => {
  if ((await roleFor(c)) == null) return err(c, 404, "not_found", "project not found")
  const tool = await getTool(c.env.AQUILLA_PG, pid(c), tid(c), c.get("user").id)
  if (!tool) return err(c, 404, "not_found", "tool not found")
  return c.json({ versions: await listVersions(c.env.AQUILLA_PG, tool.id) })
})

tools.post("/:projectId/tools/:toolId/versions", authMiddleware, async (c) => {
  const level = await roleFor(c)
  if (level == null) return err(c, 404, "not_found", "project not found")
  if (level < ROLE.CONTRIBUTOR) return err(c, 403, "permission_denied", "changing a tool requires contributor access")
  const projectId = pid(c)
  const toolId = tid(c)
  const userId = c.get("user").id
  const existing = await getTool(c.env.AQUILLA_PG, projectId, toolId, userId)
  if (!existing) return err(c, 404, "not_found", "tool not found")
  const input = await readSaveInput(c)
  if (typeof input === "string") return err(c, 400, "validation_failed", input)
  const checked = await checkVersion(input)
  if (!checked.ok) return c.json({ error: { code: "validation_failed", message: "tool failed the save gates", errors: checked.errors, lint: checked.lint } }, 400)
  const version = await addVersion(c.env.AQUILLA_PG, projectId, toolId, userId, input, checked)
  // A new version may declare fewer scopes: never leave a grant wider than
  // what the current manifest declares.
  const kept = existing.grantedScopes.filter((s) => checked.manifest.scopes.includes(s))
  if (kept.length !== existing.grantedScopes.length) await setGrant(c.env.AQUILLA_PG, projectId, toolId, userId, kept)
  return c.json({ tool: await getTool(c.env.AQUILLA_PG, projectId, toolId, userId), version }, 201)
})

tools.put("/:projectId/tools/:toolId/grant", authMiddleware, async (c) => {
  if ((await roleFor(c)) == null) return err(c, 404, "not_found", "project not found")
  const projectId = pid(c)
  const toolId = tid(c)
  const userId = c.get("user").id
  const tool = await getTool(c.env.AQUILLA_PG, projectId, toolId, userId)
  if (!tool) return err(c, 404, "not_found", "tool not found")
  const body = (await c.req.json().catch(() => null)) as { scopes?: unknown } | null
  if (!body || !Array.isArray(body.scopes)) return err(c, 400, "validation_failed", "scopes must be an array")
  const scopes: ToolScope[] = []
  for (const s of body.scopes) {
    if (!isToolScope(s)) return err(c, 400, "validation_failed", `unknown scope ${String(s)}`)
    if (!tool.manifest.scopes.includes(s)) return err(c, 400, "validation_failed", `the tool does not declare ${s}`)
    if (!scopes.includes(s)) scopes.push(s)
  }
  await setGrant(c.env.AQUILLA_PG, projectId, toolId, userId, scopes)
  return c.json({ scopes })
})

tools.delete("/:projectId/tools/:toolId", authMiddleware, async (c) => {
  const level = await roleFor(c)
  if (level == null) return err(c, 404, "not_found", "project not found")
  if (level < ROLE.CONTRIBUTOR) return err(c, 403, "permission_denied", "removing a tool requires contributor access")
  const ok = await archiveTool(c.env.AQUILLA_PG, pid(c), tid(c))
  return ok ? c.json({ ok: true }) : err(c, 404, "not_found", "tool not found")
})

tools.get("/:projectId/tools/:toolId/activity", authMiddleware, async (c) => {
  if ((await roleFor(c)) == null) return err(c, 404, "not_found", "project not found")
  const since = Number(c.req.query("since") ?? "0")
  if (!Number.isFinite(since) || since < 0) return err(c, 400, "validation_failed", "since must be epoch ms")
  const activity = await readToolActivity(c.env.AQUILLA_PG, pid(c), tid(c), since)
  return c.json(activity)
})

// Sharing = an owned copy, never a live link: the target project gets its own
// tool (origin 'copy', upstream_tool_id -> the original) with the exact code
// and hash, and NO grants — its members review the code and approve scopes
// themselves. Later upstream versions are not pulled automatically.
tools.post("/:projectId/tools/:toolId/copy", authMiddleware, async (c) => {
  if ((await roleFor(c)) == null) return err(c, 404, "not_found", "project not found")
  const user = c.get("user")
  const tool = await getTool(c.env.AQUILLA_PG, pid(c), tid(c), user.id)
  if (!tool) return err(c, 404, "not_found", "extension not found")
  const body = (await c.req.json().catch(() => null)) as { targetProjectId?: unknown } | null
  const targetProjectId = typeof body?.targetProjectId === "string" ? body.targetProjectId : ""
  if (!targetProjectId || targetProjectId === pid(c)) return err(c, 400, "validation_failed", "targetProjectId must be another project")
  const targetRole = await resolveProjectRole(c.env, user, targetProjectId)
  if (!targetRole || targetRole.level < ROLE.CONTRIBUTOR) {
    return err(c, 403, "permission_denied", "copying an extension needs contributor access on the target project")
  }
  const input: SaveVersionInput = {
    source: tool.source,
    manifest: tool.manifest,
    origin: "copy",
    upstreamToolId: tool.id,
    buildMeta: { copiedFrom: { projectId: pid(c), toolId: tool.id, version: tool.currentVersion, codeHash: tool.codeHash } },
  }
  const checked = await checkVersion(input)
  if (!checked.ok) return c.json({ error: { code: "validation_failed", message: "extension failed the save gates", errors: checked.errors, lint: checked.lint } }, 400)
  const newId = await createTool(c.env.AQUILLA_PG, targetProjectId, user.id, input, checked)
  return c.json({ tool: await getTool(c.env.AQUILLA_PG, targetProjectId, newId, user.id) }, 201)
})

tools.get("/:projectId/tools/:toolId/source", authMiddleware, async (c) => {
  if ((await roleFor(c)) == null) return err(c, 404, "not_found", "project not found")
  const version = Number(c.req.query("version") ?? "0")
  const row = await c.env.AQUILLA_PG.prepare(
    `SELECT v.version, v.source, v.code_hash, v.build_meta, t.upstream_tool_id
       FROM project_tool_versions v JOIN project_tools t ON t.id = v.tool_id
      WHERE v.tool_id = ? AND v.project_id = ? AND (? = 0 OR v.version = ?)
      ORDER BY v.version DESC LIMIT 1`,
  )
    .bind(tid(c), pid(c), version, version)
    .first<{ version: number; source: string; code_hash: string; build_meta: unknown; upstream_tool_id: string | null }>()
  if (!row) return err(c, 404, "not_found", "extension not found")
  return c.json({
    version: Number(row.version),
    source: row.source,
    codeHash: row.code_hash,
    upstreamToolId: row.upstream_tool_id,
    buildMeta: typeof row.build_meta === "string" ? JSON.parse(row.build_meta) : row.build_meta,
  })
})

export default tools
