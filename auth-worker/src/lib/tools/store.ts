// Aquilla Tools — persistence (project_tools / project_tool_versions /
// project_tool_grants). Pure SQL over the shared Postgres; the routes in
// routes/tools.ts own authorization.

import {
  TOOLS_API_REV,
  isToolScope,
  toolCodeHash,
  validateManifest,
  type ToolManifest,
  type ToolScope,
} from "../../../../shared/tools/manifest"
import { lintToolSource, type LintIssue } from "../../../../shared/tools/lint"

export type ToolVersionOrigin = "starter" | "builder" | "edit" | "copy"

export interface ToolSummary {
  id: string
  projectId: string
  name: string
  description: string
  currentVersion: number
  upstreamToolId: string | null
  createdBy: number
  createdAt: string
  updatedAt: string
  codeHash: string
  apiRev: number
  manifest: ToolManifest
  origin: ToolVersionOrigin
  /** The caller's standing grant. */
  grantedScopes: ToolScope[]
  /** Set on a first-party extension Aquilla ships (e.g. "default-editor")
   *  while its current version is the shipped code (apiRev 2). */
  firstParty: string | null
}

export interface ToolVersionRow {
  version: number
  codeHash: string
  apiRev: number
  origin: ToolVersionOrigin
  manifest: ToolManifest
  buildMeta: Record<string, unknown> | null
  createdBy: number
  createdAt: string
}

interface ToolJoinRow {
  id: string
  project_id: string
  name: string
  description: string
  current_version: number
  upstream_tool_id: string | null
  created_by_user_id: number | string
  created_at: string | Date
  updated_at: string | Date
  code_hash: string
  api_rev: number
  manifest: unknown
  origin: ToolVersionOrigin
  scopes: unknown
  first_party: string | null
}

function iso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString()
}

function parseJson(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v)
    } catch {
      return null
    }
  }
  return v
}

function toManifest(v: unknown): ToolManifest {
  const checked = validateManifest(parseJson(v))
  return checked.manifest ?? { name: "Untitled tool", description: "", scopes: [], mounts: ["page"], apiRev: 0 }
}

function toScopes(v: unknown): ToolScope[] {
  const parsed = parseJson(v)
  return Array.isArray(parsed) ? parsed.filter(isToolScope) : []
}

function toSummary(r: ToolJoinRow): ToolSummary {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    description: r.description,
    currentVersion: Number(r.current_version),
    upstreamToolId: r.upstream_tool_id,
    createdBy: Number(r.created_by_user_id),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    codeHash: r.code_hash,
    apiRev: Number(r.api_rev),
    manifest: toManifest(r.manifest),
    origin: r.origin,
    grantedScopes: toScopes(r.scopes),
    firstParty: r.first_party ?? null,
  }
}

const SUMMARY_SELECT = `
  SELECT t.id, t.project_id, t.name, t.description, t.current_version, t.upstream_tool_id,
         t.created_by_user_id, t.created_at, t.updated_at,
         v.code_hash, v.api_rev, v.manifest, v.origin,
         v.build_meta->>'firstParty' AS first_party,
         COALESCE(g.scopes, '[]'::jsonb) AS scopes
    FROM project_tools t
    JOIN project_tool_versions v ON v.tool_id = t.id AND v.version = t.current_version
    LEFT JOIN project_tool_grants g ON g.tool_id = t.id AND g.user_id = ?`

export async function listTools(db: AquillaDb, projectId: string, userId: number): Promise<ToolSummary[]> {
  const { results } = await db
    .prepare(`${SUMMARY_SELECT} WHERE t.project_id = ? AND t.archived_at IS NULL ORDER BY t.updated_at DESC`)
    .bind(userId, projectId)
    .all<ToolJoinRow>()
  return results.map(toSummary)
}

export async function getTool(
  db: AquillaDb,
  projectId: string,
  toolId: string,
  userId: number,
): Promise<(ToolSummary & { source: string }) | null> {
  const row = await db
    .prepare(
      `SELECT s.*, v2.source FROM (${SUMMARY_SELECT} WHERE t.project_id = ? AND t.id = ? AND t.archived_at IS NULL) s
         JOIN project_tool_versions v2 ON v2.tool_id = s.id AND v2.version = s.current_version`,
    )
    .bind(userId, projectId, toolId)
    .first<ToolJoinRow & { source: string }>()
  return row ? { ...toSummary(row), source: row.source } : null
}

export async function listVersions(db: AquillaDb, toolId: string): Promise<ToolVersionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT version, code_hash, api_rev, origin, manifest, build_meta, created_by_user_id, created_at
         FROM project_tool_versions WHERE tool_id = ? ORDER BY version DESC`,
    )
    .bind(toolId)
    .all<{
      version: number
      code_hash: string
      api_rev: number
      origin: ToolVersionOrigin
      manifest: unknown
      build_meta: unknown
      created_by_user_id: number | string
      created_at: string | Date
    }>()
  return results.map((r) => {
    const meta = parseJson(r.build_meta)
    return {
      version: Number(r.version),
      codeHash: r.code_hash,
      apiRev: Number(r.api_rev),
      origin: r.origin,
      manifest: toManifest(r.manifest),
      buildMeta: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null,
      createdBy: Number(r.created_by_user_id),
      createdAt: iso(r.created_at),
    }
  })
}

export interface SaveVersionInput {
  source: string
  manifest: unknown
  origin: ToolVersionOrigin
  buildMeta?: Record<string, unknown> | null
  upstreamToolId?: string | null
}

export type SaveCheck =
  | { ok: true; manifest: ToolManifest; codeHash: string }
  | { ok: false; errors: string[]; lint: LintIssue[] }

/** Server-side save gate: manifest validation + the same lint the builder
 *  runs. A client can POST anything, so the check is repeated here. */
export async function checkVersion(input: SaveVersionInput): Promise<SaveCheck> {
  const m = validateManifest(input.manifest)
  const lint = lintToolSource(input.source)
  if (!m.ok || !m.manifest || !lint.ok) {
    return { ok: false, errors: m.errors, lint: lint.issues }
  }
  const manifest = { ...m.manifest, apiRev: TOOLS_API_REV }
  return { ok: true, manifest, codeHash: await toolCodeHash(input.source, manifest) }
}

export async function createTool(
  db: AquillaDb,
  projectId: string,
  userId: number,
  input: SaveVersionInput,
  checked: { manifest: ToolManifest; codeHash: string },
  /** A fixed id (first-party installs); default a fresh UUID. */
  fixedId?: string,
): Promise<string> {
  const id = fixedId ?? crypto.randomUUID()
  await db.batch([
    db
      .prepare(
        `INSERT INTO project_tools (id, project_id, name, description, current_version, upstream_tool_id, created_by_user_id)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(id, projectId, checked.manifest.name, checked.manifest.description, input.upstreamToolId ?? null, userId),
    versionInsert(db, id, projectId, 1, userId, input, checked),
  ])
  return id
}

function versionInsert(
  db: AquillaDb,
  toolId: string,
  projectId: string,
  version: number,
  userId: number,
  input: SaveVersionInput,
  checked: { manifest: ToolManifest; codeHash: string },
): AquillaStatement {
  return db
    .prepare(
      `INSERT INTO project_tool_versions
         (tool_id, project_id, version, source, manifest, code_hash, api_rev, origin, build_meta, created_by_user_id)
       VALUES (?, ?, ?, ?, ?::text::jsonb, ?, ?, ?, ?::text::jsonb, ?)`,
    )
    .bind(
      toolId,
      projectId,
      version,
      input.source,
      JSON.stringify(checked.manifest),
      checked.codeHash,
      checked.manifest.apiRev,
      input.origin,
      input.buildMeta ? JSON.stringify(input.buildMeta) : null,
      userId,
    )
}

export async function addVersion(
  db: AquillaDb,
  projectId: string,
  toolId: string,
  userId: number,
  input: SaveVersionInput,
  checked: { manifest: ToolManifest; codeHash: string },
): Promise<number> {
  const row = await db
    .prepare(`SELECT current_version FROM project_tools WHERE id = ? AND project_id = ?`)
    .bind(toolId, projectId)
    .first<{ current_version: number }>()
  if (!row) throw new Error("tool_not_found")
  const next = Number(row.current_version) + 1
  await db.batch([
    versionInsert(db, toolId, projectId, next, userId, input, checked),
    db
      .prepare(
        `UPDATE project_tools SET current_version = ?, name = ?, description = ?, updated_at = now()
          WHERE id = ? AND project_id = ? AND current_version = ?`,
      )
      .bind(next, checked.manifest.name, checked.manifest.description, toolId, projectId, row.current_version),
  ])
  return next
}

export async function setGrant(
  db: AquillaDb,
  projectId: string,
  toolId: string,
  userId: number,
  scopes: ToolScope[],
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_tool_grants (tool_id, project_id, user_id, scopes, updated_at)
       VALUES (?, ?, ?, ?::text::jsonb, now())
       ON CONFLICT (tool_id, user_id) DO UPDATE SET scopes = EXCLUDED.scopes, updated_at = now()`,
    )
    .bind(toolId, projectId, userId, JSON.stringify(scopes))
    .run()
}

export async function archiveTool(db: AquillaDb, projectId: string, toolId: string): Promise<boolean> {
  const { results } = await db
    .prepare(`UPDATE project_tools SET archived_at = now() WHERE id = ? AND project_id = ? AND archived_at IS NULL RETURNING id`)
    .bind(toolId, projectId)
    .all<{ id: string }>()
  return results.length > 0
}

/** Whether `userId` has ever had a standing grant row for this tool (an
 *  empty row = they revoked everything, which first-party installs respect). */
export async function hasGrantRow(db: AquillaDb, toolId: string, userId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS one FROM project_tool_grants WHERE tool_id = ? AND user_id = ?`)
    .bind(toolId, userId)
    .first<{ one: number }>()
  return row != null
}

/** The bare row of a tool by id, archived or not (first-party lookups). */
export async function toolRow(
  db: AquillaDb,
  projectId: string,
  toolId: string,
): Promise<{ archived: boolean; codeHash: string; firstParty: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT t.archived_at, v.code_hash, v.build_meta->>'firstParty' AS first_party
         FROM project_tools t JOIN project_tool_versions v ON v.tool_id = t.id AND v.version = t.current_version
        WHERE t.id = ? AND t.project_id = ?`,
    )
    .bind(toolId, projectId)
    .first<{ archived_at: string | Date | null; code_hash: string; first_party: string | null }>()
  return row ? { archived: row.archived_at != null, codeHash: row.code_hash, firstParty: row.first_party ?? null } : null
}
