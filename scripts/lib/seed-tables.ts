// Shared table metadata for the dev-DB seed (scripts/seed-extract.ts + seed-load.ts).
// See docs/superpowers/specs/2026-06-06-dev-db-seed-design.md.
//
// Each table is scoped to the seeded projects by one id-set, in load order
// (identity → project → content). No FK constraints are enforced in the schema,
// so order is for readability/idempotent deletes, not correctness.

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
  // ── content (project-scoped) ──
  // events PK is `id` (not project-led); page by the unique (project_id, server_seq) index instead.
  { name: "events", by: { col: "project_id", set: "project" }, pk: ["id"], pageKey: ["project_id", "server_seq"], authorCols: ["author"] },
  { name: "files", by: { col: "project_id", set: "project" }, pk: ["id"] },
  { name: "cells", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "side"], authorCols: ["last_editor"] },
  { name: "cell_validators", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "username"], authorCols: ["username"] },
  { name: "cell_waivers", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "rule_id"], authorCols: ["waived_by"] },
  { name: "cell_audio", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "audio_id"] },
  { name: "cell_backtranslations", by: { col: "project_id", set: "project" }, pk: ["project_id", "file_id", "cell_id", "target_event_id"], authorCols: ["author"] },
  { name: "comments", by: { col: "project_id", set: "project" }, pk: ["comment_id"], authorCols: ["author_id", "author_label"] },
  { name: "assignments", by: { col: "project_id", set: "project" }, pk: ["assignment_id"] },
  { name: "assignment_cells", by: { col: "assignment_id", set: "assignment" }, pk: ["assignment_id", "file_id", "cell_id"] },
  { name: "diarization_jobs", by: { col: "project_id", set: "project" }, pk: ["id"] },
  { name: "file_source_blobs", by: { col: "project_id", set: "project" }, pk: ["file_id"] },
  { name: "checkpoints", by: { col: "project_id", set: "project" }, pk: ["id"] },
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
