// Shared table metadata for the dev-DB seed (scripts/seed-extract.ts + seed-load.ts).
// Design: docs/superpowers/specs/2026-06-06-dev-db-seed-design.md.
// Hand-off procedure: docs/runbooks/seed-project-to-local.md.
//
// Each table is scoped to the seeded projects by one id-set, in load order
// (identity → project → content). ORDER IS LOAD-BEARING, not cosmetic: since
// the lane rollout (AQU-1240, migrations 0102/0103) the content tables carry a
// composite foreign key (project_id, lane_id) → lanes (project_id, id), and
// seed-load.ts inserts with constraints on. A table must come after every
// table it references; the loader deletes in reverse order for the same
// reason. scripts/lib/seed-tables.test.ts checks this list against
// db/postgres/schema.sql so the next foreign key cannot land unnoticed
// (AQU-1953: `lanes` was missing and every fresh bundle failed on
// cells_lane_id_fkey).

export type IdSet = "project" | "user" | "org" | "group" | "assignment"

export interface SeedTable {
  name: string
  /** Column + id-set used to both SELECT (extract) and DELETE (load) this table's rows. */
  by: { col: string; set: IdSet }
  /** Primary-key columns, in order — used for idempotent deletes and as the default keyset page key. */
  pk: string[]
  /**
   * Optional override for the keyset pagination order. Use when the PK does not lead with the
   * scoping column, so an index that DOES (e.g. idx_events_project_seq) can serve filter+order
   * together and avoid a per-page Sort. Must be globally unique. Defaults to `pk`.
   */
  pageKey?: string[]
  /** TEXT columns holding usernames/author labels that must be run through the identity remap. */
  authorCols?: string[]
}

export const SEED_TABLES: SeedTable[] = [
  // ── identity closure ──
  { name: "users", by: { col: "id", set: "user" }, pk: ["id"] },
  { name: "organizations", by: { col: "id", set: "org" }, pk: ["id"] },
  { name: "org_members", by: { col: "org_id", set: "org" }, pk: ["org_id", "user_id"] },
  { name: "groups", by: { col: "id", set: "group" }, pk: ["id"] },
  { name: "group_members", by: { col: "group_id", set: "group" }, pk: ["group_id", "user_id"] },
  // ── project ──
  { name: "projects", by: { col: "id", set: "project" }, pk: ["id"] },
  { name: "project_members", by: { col: "project_id", set: "project" }, pk: ["project_id", "user_id"] },
  { name: "group_project_grants", by: { col: "project_id", set: "project" }, pk: ["group_id", "project_id"] },
  { name: "project_settings", by: { col: "project_id", set: "project" }, pk: ["project_id"] },
  // AQU-1953: lanes must exist before any content row that points at one.
  // project_member_lane_roles is the lane read/write wall's grant table
  // (AQU-1389 / AQU-1415): without it a seeded member below Maintainer sees
  // no cells. It references lanes, so it follows them.
  { name: "lanes", by: { col: "project_id", set: "project" }, pk: ["project_id", "id"] },
  { name: "project_member_lane_roles", by: { col: "project_id", set: "project" }, pk: ["project_id", "user_id", "lane"] },
  // ── content (project-scoped) ──
  // events PK is `id` (not project-led); page by the unique (project_id, server_seq) index instead.
  { name: "events", by: { col: "project_id", set: "project" }, pk: ["id"], pageKey: ["project_id", "server_seq"], authorCols: ["author"] },
  { name: "files", by: { col: "project_id", set: "project" }, pk: ["id"] },
  { name: "cells", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "side"], authorCols: ["last_editor"] },
  { name: "cell_validators", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "username"], authorCols: ["username"] },
  { name: "cell_waivers", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "rule_id"], authorCols: ["waived_by"] },
  { name: "cell_audio", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "audio_id"] },
  // AQU-1953: audio votes reference lanes too, and a take without its votes
  // reads as unvalidated.
  { name: "cell_audio_validators", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "audio_id", "username"], authorCols: ["username"] },
  { name: "cell_backtranslations", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "target_event_id"], authorCols: ["author"] },
  // AQU-1953: the dashboard's progress projection. Not re-derived on load, so
  // without these rows a seeded project shows no progress at all.
  { name: "file_section_progress", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "scope", "section_key", "lane_id"] },
  // AQU-1296: comments is keyed on (project_id, comment_id) — comment ids are
  // unique per project only. The keyset pagination above needs the full key or
  // it skips rows whenever two seeded projects share a comment id.
  { name: "comments", by: { col: "project_id", set: "project" }, pk: ["project_id", "comment_id"], authorCols: ["author_id", "author_label"] },
  { name: "assignments", by: { col: "project_id", set: "project" }, pk: ["assignment_id"] },
  { name: "assignment_cells", by: { col: "assignment_id", set: "assignment" }, pk: ["assignment_id", "file_id", "cell_id"] },
  { name: "diarization_jobs", by: { col: "project_id", set: "project" }, pk: ["id"] },
  { name: "file_source_blobs", by: { col: "project_id", set: "project" }, pk: ["file_id"] },
  { name: "checkpoints", by: { col: "project_id", set: "project" }, pk: ["id"] },
]

/**
 * Project-scoped tables the seed never carries, but which hold foreign keys
 * onto seeded tables WITHOUT `ON DELETE CASCADE` (agent artifacts, contextual
 * runs, usage requests). seed-load.ts deletes their rows for the seeded
 * projects before its reverse-order deletes, so re-loading over a project a
 * developer has used locally is not blocked by a dangling reference to
 * `lanes` or `files`. They are never inserted. (AQU-1953)
 */
export const DEPENDENT_TABLES: Array<{ name: string; by: { col: string; set: IdSet } }> = [
  { name: "artifact_bindings", by: { col: "project_id", set: "project" } },
  { name: "scene_briefs", by: { col: "project_id", set: "project" } },
  { name: "contextual_runs", by: { col: "project_id", set: "project" } },
  { name: "contextual_drafts", by: { col: "project_id", set: "project" } },
  { name: "workspace_usage_requests", by: { col: "project_id", set: "project" } },
]

/** Tables intentionally excluded from the seed (PII / noise). */
export const EXCLUDED_TABLES = ["password_reset_tokens", "project_invites", "activity_logs"]

// ── deterministic PII remap ──────────────────────────────────────────────

export interface FakeUser {
  id: string | number
  username: string
  email: string
  display_name: string | null
}

/** Deterministic fake identity keyed on the stable numeric user id. */
export function fakeUser(id: string | number, emailDomain: string, keepDisplayNames: boolean, realDisplay: string | null): FakeUser {
  return {
    id,
    username: `user_${id}`,
    email: `user_${id}@${emailDomain}`,
    display_name: keepDisplayNames ? realDisplay : `User ${id}`,
  }
}

/**
 * Maps real author tokens (username OR numeric-id-as-text) to their fake username.
 * `byUsername` maps real username → fake username; `byId` maps "id" → fake username.
 * Unmapped tokens pass through unchanged and are reported via `onUnmapped`.
 */
export function makeAuthorRemap(
  byUsername: Map<string, string>,
  byId: Map<string, string>,
  onUnmapped: (token: string) => void,
) {
  return (token: unknown): unknown => {
    if (token == null) return token
    const s = String(token)
    const u = byUsername.get(s)
    if (u !== undefined) return u
    const i = byId.get(s)
    if (i !== undefined) return i
    onUnmapped(s)
    return token
  }
}

export const TABLE_HEADER_KEY = "__table__"
