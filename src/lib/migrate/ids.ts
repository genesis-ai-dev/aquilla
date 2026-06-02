// Deterministic id derivation for legacy-Codex → Aquilla migration.
//
// Every migrated entity (project, file, and each event) gets a UUIDv5 derived
// purely from STABLE legacy inputs — never a clock, never randomness. This is
// the backbone of idempotency: re-running the migration derives the exact same
// ids, so the server's `INSERT OR IGNORE` turns replays into no-ops and the
// projection converges to the same state.
//
// The namespace + seed formulas match the proven Rust migrate tools
// (tools/legacy-user-import, apps/migrate per aquilla-specs/30-aquilla-alpha/
// migrate.md), so ids are cross-compatible with aquilla-alpha. The constant
// MUST NOT CHANGE once any real data has been imported.

import { v5 as uuidv5 } from "uuid"

/** Shared migration namespace. MUST NOT CHANGE. */
export const AQUILLA_MIGRATION_NS = "7f3c8a91-2b4d-4e6f-9a8c-1d3e5f2b4a6c"

const u5 = (seed: string): string => uuidv5(seed, AQUILLA_MIGRATION_NS)

/** Source of the legacy project key: a GitLab numeric project id, or the
 *  `metadata.json.projectId` of a local working copy. They get distinct
 *  prefixes so the two paths can never collide on the same aquilla project. */
export type ProjectSource = "gitlab" | "local"

/** aquilla `projects.id` from the legacy project key. */
export const projectIdFor = (key: string, source: ProjectSource): string =>
  u5(`${source === "gitlab" ? "gitlab-project" : "local-project"}:${key}`)

/** aquilla `organizations.legacy_uuid` for a GitLab top-level group. Keyed on
 *  the STABLE GitLab numeric group id (survives renames/moves), so re-running
 *  the group importer converges on the same org. NOT the primary key — orgs use
 *  an INTEGER AUTOINCREMENT id; this is the dedup key (see migration 0024). */
export const orgLegacyUuidFor = (gitlabTopGroupId: number): string =>
  u5(`gitlab-group:${gitlabTopGroupId}`)

/** aquilla `groups.legacy_uuid` ("team" in the UI) for a GitLab subgroup, keyed
 *  on its stable GitLab numeric id. Subgroups nest arbitrarily in GitLab but
 *  Aquilla groups are flat — every descendant subgroup maps to one team. */
export const teamLegacyUuidFor = (gitlabSubgroupId: number): string =>
  u5(`gitlab-subgroup:${gitlabSubgroupId}`)

/** aquilla `file_id` for a source/target pair, from the legacy project key +
 *  the paired relative path (stem). Source and target cells share this id. */
export const fileIdFor = (projectKey: string, relPath: string): string =>
  u5(`file:${projectKey}:${relPath}`)

/** event id for the genesis `file.create`. */
export const fileCreateEventId = (projectId: string, fileId: string): string =>
  u5(`file-create:${projectId}:${fileId}`)

/** event id for the genesis `source.cell.create`. */
export const sourceCellCreateEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
): string => u5(`cell-create:${projectId}:${fileId}:${cellId}`)

/** event id for the i-th `target.cell.commit` in a cell's edit history.
 *  `editIdx` is the 0-based index into the legacy `metadata.edits[]` (the
 *  source of full-history fidelity); commit_sha is deliberately excluded so a
 *  re-walk after a new upstream commit converges on the same ids. */
export const targetCommitEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  editIdx: number,
): string => u5(`cell-commit:${projectId}:${fileId}:${cellId}:${editIdx}`)

/** event id for a `cell.validate`, keyed by (cell, validator). The validated
 *  edit's event id is deliberately EXCLUDED from the seed so re-syncs converge
 *  on the same id even as the chain head advances (mirrors the proven design's
 *  CP-6 alignment). */
export const validateEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  validator: string,
): string => u5(`cell-validate:${projectId}:${fileId}:${cellId}:${validator}`)

/** event id for a `comment.create`, keyed by the legacy comment id. */
export const commentCreateEventId = (projectId: string, legacyCommentId: string): string =>
  u5(`comment-create:${projectId}:${legacyCommentId}`)

/** event id for a `comment.resolve`, keyed by the legacy thread id. */
export const commentResolveEventId = (projectId: string, threadId: string): string =>
  u5(`comment-resolve:${projectId}:${threadId}`)

/** event id for a `cell.audio.attach`, keyed by (cell, audioId). */
export const audioAttachEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  audioId: string,
): string => u5(`audio-attach:${projectId}:${fileId}:${cellId}:${audioId}`)
