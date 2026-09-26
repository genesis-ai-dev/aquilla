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

/** Durable v2 metadata backfill for one already-migrated source cell. */
export const sourceCellMetadataPatchEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
): string => u5(`source-cell-metadata-patch:v2:${projectId}:${fileId}:${cellId}`)

/** Immutable original artifact id. Same seed is enforced by the worker copy route. */
export const sourceArtifactIdFor = (
  projectId: string,
  fileId: string,
  sourceSha256: string,
): string => u5(`source-artifact:${projectId}:${fileId}:${sourceSha256.toLowerCase()}`)

/** Stable source binding id for trusted migration retries. */
export const sourceArtifactBindingIdFor = (
  projectId: string,
  fileId: string,
  sourceSha256: string,
): string => u5(`source-artifact-binding:${projectId}:${fileId}:${sourceSha256.toLowerCase()}`)

/** event id for the `source.cell.delete` that retracts a cell deleted in Codex.
 *  Keyed only by (project, file, cell) so a re-migration derives the same id and
 *  the delete stays idempotent (INSERT OR IGNORE), which is what lets a re-run
 *  purge a cell an earlier (pre-AQU-673) migration already created (AQU-747).
 *
 *  `generation` (AQU-933): a tombstone can be UNDONE — a projection
 *  rebuild/replay under the pre-AQU-931 arbitration rule dropped parent-null
 *  deletes and resurrected the rows, and the logged gen-1 id then delta-filters
 *  every re-emission forever. Generation N ≥ 2 mints a fresh deterministic id
 *  so the reconciliation pass can re-kill the zombie; generation 1 is the
 *  exact legacy seed (byte-identical ids for fresh migrations). */
export const sourceCellDeleteEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  generation = 1,
): string =>
  u5(
    generation <= 1
      ? `cell-delete-source:${projectId}:${fileId}:${cellId}`
      : `cell-delete-source:${projectId}:${fileId}:${cellId}:gen${generation}`,
  )

/** event id for the `target.cell.delete` companion of a Codex-deleted cell —
 *  removes the target-lane row a prior migration's `target.cell.commit`
 *  materialized. Distinct seed prefix from the source delete (AQU-747);
 *  same generation escalation as the source delete (AQU-933). */
export const targetCellDeleteEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  generation = 1,
): string =>
  u5(
    generation <= 1
      ? `cell-delete-target:${projectId}:${fileId}:${cellId}`
      : `cell-delete-target:${projectId}:${fileId}:${cellId}:gen${generation}`,
  )

/** Escalated re-emission of an already-logged deterministic event — AQU-933's
 *  delete-generation pattern generalized to ANY migration event id. Generation
 *  1 IS the original id (byte-identical, so fresh migrations are unchanged);
 *  generation N ≥ 2 derives a fresh deterministic id FROM the original, so a
 *  repair whose earlier emission was undone (a poisoned stale-checkout run, a
 *  legacy rebuild) can be re-emitted past the delta filter — while a re-run of
 *  the same escalation still converges on the same id. Deriving from the
 *  original id keeps the seed a pure function of stable legacy inputs. */
export const escalatedEventId = (originalId: string, generation: number): string =>
  generation <= 1 ? originalId : u5(`escalate:${originalId}:gen${generation}`)

/** event id for a `source.cell.reanchor` repair (AQU-931), keyed by the
 *  INTENDED anchor: a re-run that derives the same chain dedupes (INSERT OR
 *  IGNORE), while a later chain change mints a fresh event — replay applies
 *  them in server_seq order, so the newest repair wins on rebuild too. */
export const sourceCellReanchorEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  anchorCellId: string | null,
): string => u5(`cell-reanchor:${projectId}:${fileId}:${cellId}:${anchorCellId ?? "∅"}`)

/** event id for the `source.cell.visibility.set` that parks (or un-parks) a
 *  cell Codex users hid with the eye icon (AQU-1425).
 *
 *  Keyed on the DECISION (`hidden`) and on the legacy timestamp of the edit
 *  that made it — not on (project, file, cell) alone. A visibility flag is the
 *  one migrated fact that legitimately flips back and forth: seeding only the
 *  cell would make a later unhide in Codex derive the id the hide already used,
 *  so the delta filter (and `INSERT OR IGNORE`) would swallow the show event and
 *  strand the cell hidden forever. Including both makes a re-run of the SAME
 *  working copy converge on the same id (a no-op) while every genuine flip
 *  mints a fresh one — and because the projection replays in `server_seq`
 *  order, the newest decision wins on rebuild too.
 *
 *  `ts` is absent only when Codex recorded no edit ledger for the flag (the
 *  materialized-flag fallback); the decision itself still separates the two
 *  ids. */
export const sourceCellVisibilityEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  hidden: boolean,
  ts: number | undefined,
): string =>
  u5(
    `cell-visibility:${projectId}:${fileId}:${cellId}:${hidden ? "hide" : "show"}:${ts ?? "∅"}`,
  )

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

/** AQU-490: event id for a `cell.audio.validate`, keyed by (cell, take,
 *  validator). Keyed on the VALIDATOR and not on the attach event, for the
 *  reason validateEventId gives above: a re-sync must converge on the same id
 *  even though the take's attach event id moves. */
export const audioValidateEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  audioId: string,
  validator: string,
): string => u5(`audio-validate:${projectId}:${fileId}:${cellId}:${audioId}:${validator}`)

/** event id for a `cell.audio.select`, keyed by (cell, audioId). The all-takes
 *  import emits one of these to pin the legacy active take after attaching every
 *  take in the cell (each attach auto-selects, so an explicit final select wins).
 *  Distinct seed prefix from audio-attach so the two never collide. */
export const audioSelectEventId = (
  projectId: string,
  fileId: string,
  cellId: string,
  audioId: string,
): string => u5(`audio-select:${projectId}:${fileId}:${cellId}:${audioId}`)
