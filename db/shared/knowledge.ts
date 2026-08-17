// Shared knowledge_docs domain logic. Lives in db/shared/ so auth-worker
// routes, the harness agent tools, and the sync-worker external Agent API
// reads all apply the SAME CRUD + org-inheritance + search logic with no
// forked implementation.
//
// Scope: this module owns the knowledge_docs SQL primitives (create / list /
// get / delete / index-result write), org-inherited project reads, plain
// substring search, and node-addressed tree reads (PageIndex-style — a doc's
// extracted text is split into a tree of char-range nodes so an agent can
// fetch one section instead of the whole document). Identity + authorization
// (session JWT, project-role floors) stay in the caller — this module never
// touches HTTP.
//
// Takes the bare `AquillaDb` handle (db/shim/postgres.ts) so it is callable
// from either a route, the harness, or sync-worker's external reads — the
// same handle each inject as `env.AQUILLA_PG`.

import type { AquillaDb } from "../shim/postgres"

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type KnowledgeIndexStatus = "pending" | "ready" | "failed"

export interface KnowledgeNode {
  id: string // "n1", "n1.2", … stable within a doc
  title: string
  summary?: string
  charStart: number // inclusive index into extracted_text
  charEnd: number // exclusive
  children?: KnowledgeNode[]
}

export interface KnowledgeDocMeta {
  id: string
  orgId: number | null
  projectId: string | null
  scope: "project" | "org"
  name: string
  contentType: string | null
  sizeBytes: number
  sha256: string
  r2Key: string
  docSummary: string | null
  indexStatus: KnowledgeIndexStatus
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeSnippet {
  docId: string
  docName: string
  snippet: string
}

export const MAX_KB_ORIGINAL_BYTES = 25 * 1024 * 1024
export const MAX_KB_EXTRACT_INPUT_BYTES = 2_000_000 // docx/pdf raw-bytes cap
export const MAX_KB_TEXT_CHARS = 2_000_000 // extracted_text truncation
export const KB_EXTENSIONS = [".md", ".txt", ".docx", ".pdf"] as const

export type KnowledgeScopeRef = { projectId: string } | { orgId: number }

// ──────────────────────────────────────────────────────────────────────────
// Row mapping
// ──────────────────────────────────────────────────────────────────────────

const META_COLS = `id, org_id, project_id, name, content_type, size_bytes, sha256,
  r2_key, doc_summary, index_status, created_by, created_at, updated_at`

interface Row {
  id: string
  org_id: number | null
  project_id: string | null
  name: string
  content_type: string | null
  size_bytes: number
  sha256: string
  r2_key: string
  doc_summary: string | null
  index_status: string
  created_by: string
  created_at: string
  updated_at: string
}

function rowToMeta(r: Row): KnowledgeDocMeta {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    scope: r.project_id != null ? "project" : "org",
    name: r.name,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    r2Key: r.r2_key,
    docSummary: r.doc_summary,
    indexStatus: r.index_status as KnowledgeIndexStatus,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

export function kbExtension(name: string): (typeof KB_EXTENSIONS)[number] | null {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return null
  const ext = name.slice(dot).toLowerCase()
  return (KB_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as (typeof KB_EXTENSIONS)[number])
    : null
}

export function kbR2Key(prefix: string | undefined, scope: KnowledgeScopeRef, docId: string): string {
  const p = prefix?.trim().replace(/^\/+|\/+$/g, "") ?? ""
  const pre = p ? `${p}/` : ""
  return "projectId" in scope
    ? `${pre}kb/project/${scope.projectId}/${docId}`
    : `${pre}kb/org/${scope.orgId}/${docId}`
}

export function flattenNodes(tree: KnowledgeNode[] | null): KnowledgeNode[] {
  if (!tree) return []
  const out: KnowledgeNode[] = []
  const walk = (nodes: KnowledgeNode[]) => {
    for (const n of nodes) {
      out.push(n)
      if (n.children) walk(n.children)
    }
  }
  walk(tree)
  return out
}

export function resolveNode(tree: KnowledgeNode[] | null, nodeId: string): KnowledgeNode | null {
  return flattenNodes(tree).find((n) => n.id === nodeId) ?? null
}

/** JSONB comes back as an object from both postgres.js and PGlite; guard the
 *  rare case it arrives as a raw string. */
function parseTree(raw: unknown): KnowledgeNode[] | null {
  if (raw == null) return null
  if (typeof raw === "string") return JSON.parse(raw) as KnowledgeNode[]
  return raw as KnowledgeNode[]
}

// ──────────────────────────────────────────────────────────────────────────
// CRUD primitives
// ──────────────────────────────────────────────────────────────────────────

export interface CreateDocInput {
  id: string
  scope: KnowledgeScopeRef
  name: string
  contentType: string | null
  sizeBytes: number
  sha256: string
  r2Key: string
  extractedText: string
  createdBy: string
}

export async function createDoc(db: AquillaDb, doc: CreateDocInput): Promise<void> {
  const orgId = "orgId" in doc.scope ? doc.scope.orgId : null
  const projectId = "projectId" in doc.scope ? doc.scope.projectId : null
  await db
    .prepare(
      `INSERT INTO knowledge_docs
         (id, org_id, project_id, name, content_type, size_bytes, sha256, r2_key, extracted_text, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      doc.id,
      orgId,
      projectId,
      doc.name,
      doc.contentType,
      doc.sizeBytes,
      doc.sha256,
      doc.r2Key,
      doc.extractedText,
      doc.createdBy,
    )
    .run()
}

/** Project docs AND its org's shared docs, scope-tagged on each row. */
export async function listProjectDocs(db: AquillaDb, projectId: string): Promise<KnowledgeDocMeta[]> {
  const { results } = await db
    .prepare(
      `SELECT ${META_COLS} FROM knowledge_docs
       WHERE project_id = ?
          OR org_id = (SELECT org_id FROM projects WHERE id = ?)
       ORDER BY created_at DESC`,
    )
    .bind(projectId, projectId)
    .all<Row>()
  return results.map(rowToMeta)
}

export async function listOrgDocs(db: AquillaDb, orgId: number): Promise<KnowledgeDocMeta[]> {
  const { results } = await db
    .prepare(`SELECT ${META_COLS} FROM knowledge_docs WHERE org_id = ? ORDER BY created_at DESC`)
    .bind(orgId)
    .all<Row>()
  return results.map(rowToMeta)
}

export async function getDocMeta(db: AquillaDb, docId: string): Promise<KnowledgeDocMeta | null> {
  const row = await db
    .prepare(`SELECT ${META_COLS} FROM knowledge_docs WHERE id = ?`)
    .bind(docId)
    .first<Row>()
  return row ? rowToMeta(row) : null
}

export async function getDocTree(
  db: AquillaDb,
  docId: string,
): Promise<{ meta: KnowledgeDocMeta; tree: KnowledgeNode[] | null } | null> {
  const row = await db
    .prepare(`SELECT ${META_COLS}, index_tree FROM knowledge_docs WHERE id = ?`)
    .bind(docId)
    .first<Row & { index_tree: unknown }>()
  if (!row) return null
  return { meta: rowToMeta(row), tree: parseTree(row.index_tree) }
}

/** No nodeId → full extracted text. nodeId → its char-range substring, or
 *  null when the id doesn't resolve in the doc's tree. */
export async function getDocText(
  db: AquillaDb,
  docId: string,
  nodeId?: string,
): Promise<{ meta: KnowledgeDocMeta; text: string } | null> {
  const row = await db
    .prepare(`SELECT ${META_COLS}, extracted_text, index_tree FROM knowledge_docs WHERE id = ?`)
    .bind(docId)
    .first<Row & { extracted_text: string; index_tree: unknown }>()
  if (!row) return null
  const meta = rowToMeta(row)
  if (nodeId == null) return { meta, text: row.extracted_text }
  const tree = parseTree(row.index_tree)
  const node = resolveNode(tree, nodeId)
  if (!node) return null
  return { meta, text: row.extracted_text.slice(node.charStart, node.charEnd) }
}

/** Deletes the row and returns its r2Key (so the caller can delete the R2
 *  object too), or null if no such doc exists. */
export async function deleteDoc(db: AquillaDb, docId: string): Promise<string | null> {
  const row = await db
    .prepare(`DELETE FROM knowledge_docs WHERE id = ? RETURNING r2_key`)
    .bind(docId)
    .first<{ r2_key: string }>()
  return row ? row.r2_key : null
}

export async function setIndexResult(
  db: AquillaDb,
  docId: string,
  status: KnowledgeIndexStatus,
  tree: KnowledgeNode[] | null,
  docSummary: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE knowledge_docs
          SET index_status = ?, index_tree = ?::jsonb, doc_summary = ?, updated_at = now()
        WHERE id = ?`,
    )
    .bind(status, tree ? JSON.stringify(tree) : null, docSummary, docId)
    .run()
}

/** Plain case-insensitive substring search across a project's own docs plus
 *  its org's shared docs, with a snippet window around the first match.
 *  position() is exact substring search, not LIKE — % and _ in `q` are
 *  ordinary characters, never wildcards. */
export async function searchKnowledge(
  db: AquillaDb,
  projectId: string,
  q: string,
  limit = 5,
): Promise<KnowledgeSnippet[]> {
  const needle = q.trim().toLowerCase()
  if (!needle) return []
  const { results } = await db
    .prepare(
      `SELECT id, name,
              substr(extracted_text,
                     GREATEST(position(? in lower(extracted_text)) - 240, 1),
                     560) AS snippet
       FROM knowledge_docs
       WHERE (project_id = ? OR org_id = (SELECT org_id FROM projects WHERE id = ?))
         AND position(? in lower(extracted_text)) > 0
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .bind(needle, projectId, projectId, needle, limit)
    .all<{ id: string; name: string; snippet: string }>()
  return results.map((r) => ({ docId: r.id, docName: r.name, snippet: r.snippet.trim() }))
}
