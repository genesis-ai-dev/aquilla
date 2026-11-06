# 0007 — File revisions and derived source cells

*Decided 2026-11-06. Increment 1 of the spec
`docs/superpowers/specs/2026-11-06-virtual-source-cells-file-revisions.md`.*

## Context

A file's source side has been N `source.cell.create` events with random cell
ids, minted at import. Import time is dominated by inserting them; upstream
changes (re-import, link mirroring, DCS, LangQuest) each re-derive identity
their own way; and a Google Drive folder or a git repo cannot be kept live
because nothing cheap and deterministic says what moved. AQU-2380 showed the
cost: an edited source paragraph became delete + insert and hid its
translation.

## Decision

A file's source side is **derived** from an immutable artifact, a filter stamp
and a chain of revisions. One module decides identity and change for every
path that updates a source: `db/shared/file-revision.ts`.

- **Two-tier identity.** A unit has a cell id (identity across revisions) and
  a content hash (what was translated). Hashes come from
  `db/shared/file-revision.ts::contentHashOf` over the same normalization ICE
  matching uses; ids from `db/shared/file-revision.ts::revisionCellId`, a
  UUIDv5 in the file's namespace, so replaying a revision chain re-derives
  every id.
- **Alignment, not position, assigns ids.**
  `db/shared/file-revision.ts::alignRevision` pairs reference-addressed units
  by key and positional units by LCS over content hashes, then by similarity
  within gaps; the outcomes are `equal`, `changed`, `moved`, `inserted`, and
  `deleted`. An edited paragraph keeps its id and is `changed`; an insertion
  shifts nothing.
- **Stale is a pure rule.** `db/shared/file-revision.ts::classifyTargetStaleness`:
  stale only when the head revision moved past the pin and the content hash
  differs; a reverted source is fresh again. A stale translation is never
  deleted or overwritten by a machine.
- **Stamps keep their 0001 shape.** `db/shared/file-revision.ts::parseFilterStamp`
  reads `<filterId>@<walk>` and treats a bare id as walk 1; parse options hash
  through `db/shared/file-revision.ts::optionsHash`.
- **No dependencies.** The module ships its own SHA-1/UUIDv5
  (`db/shared/file-revision.ts::uuidV5`), pinned against the `uuid` package in
  its test, because the sync-worker has no `uuid` dependency and every runtime
  must derive the same ids.

## Consequences

- Re-import, link sync, DCS delta and future Drive/git connectors converge on
  one loop: fetch bytes, compare sha, parse with the stamp, align, write one
  revision. Changing what "changed" means is one edit with one test file.
- A revision is one event and one manifest, so import stops paying N event
  inserts and N chain claims (increment 2), and can stop paying N cell inserts
  once readers move to the manifest (increment 4).
- Existing files are untouched until adopted; adoption keeps their ids.

## Not covered yet

- The `file_revisions` table, the revisions route, the `file.revision` event
  kind and adoption are increment 2 and are not in this record.
- Export selecting a walk by stamp remains AQU-2382's work.
- Cross-file moves are delete + insert.
