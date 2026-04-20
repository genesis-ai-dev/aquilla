# Validation history on Yjs-native edits — design

**Date:** 2026-04-20
**Status:** design approved, ready for plan
**Worktree:** TBD at plan time

## Problem

Validations today appear to be a binary per-cell state. They're not: the data
model already attaches `validatedBy: ValidationEntry[]` to individual edit
entries, so a validation is a sign-off on a *specific state* of the cell. The
bug is that the UI never reflects this correctly.

Concretely: `useCells.deriveValidationStatus` reads from
`__source.metadata.edits` (a frozen import snapshot, mutated ad-hoc at runtime),
while content edits flow through `recordHistoryEntry` into the live
`cell.history` Y.Array and are only folded into `__source` during serialize →
sync → rehydrate. Until that round-trip completes, `__source.metadata.edits`
holds a stale "latest" value-edit, and the UI can show "validated by user 1"
even after user 2 has changed the text.

The user's ask is stronger than a point fix: make the Yjs doc the sole source
of truth for content, edits, and validations. Let `__source` become a
write-only back-compat artifact emitted lazily for the GitLab round-trip.

## Goals

- Validation state derives directly from a live, Yjs-native structure. Edits
  by one user immediately and correctly reset another user's validation in the
  UI.
- Each edit session has clear authorship. Deliberate commits build the author
  list; typing without committing does not.
- Per-edit validation history is captured and surfaced in the UI. Users can
  see who validated which prior state of the cell.
- GitLab round-trip remains byte-compatible with the desktop app's
  `.codex`/`FileEditHistory`/`ProjectEditHistory` shapes.
- Icons match the desktop app's `AudioValidationStatusIcon` semantics
  (`circle-outline`, `circle-filled`, `check`, `check-all`). Health continues
  to render as a progress ring around the validation symbol.

## Non-goals

- Validating file-level metadata edits. Desktop's `FileEditHistory` and
  `ProjectEditHistory` have no `validatedBy`; we mirror that.
- Project-level (`metadata.json`) edit tracking. The web app doesn't own
  project metadata today — scope is per-notebook.
- Retroactive editing or deletion of past validations. History is
  append/soft-delete only.
- Surfacing metadata-edit history (e.g. cellLabel changes) in the validation
  popover. Those are audit-only for v1.
- Cross-user locking or "active session" UX. Two users typing into one cell
  continue to interleave via the shared `Y.XmlFragment` exactly as today.

## Architecture

### Data model — new

Add per-cell Yjs structure `cell.edits: Y.Array<Y.Map>`. Each entry is an
edit-session Y.Map shaped:

- `authors: Y.Array<string>` — deliberate committers during this session
  (min 1). Plural is canonical.
- `timestamp: number` — last commit time within the session (epoch ms).
- `type: EditTypeValue` — `"user-edit" | "llm-edit" | "initial-import" | ...`
  (matches existing `EditTypeValue` in `src/lib/codex-editor/types.ts`).
- `editMap: string[]` — field path. `["value"]` for cell text; `["metadata",
  "cellLabel"]`, `["metadata", "data", ...]` for cell metadata. Same shapes
  desktop already emits.
- `value: unknown` — text for `["value"]`; typed per `editMap` for others.
- `validatedBy: Y.Map<string, Y.Map>` — outer key = username, inner Y.Map =
  `{creationTimestamp: number, updatedTimestamp: number, isDeleted: boolean}`.
  Only present on value-editMap entries (matches desktop's cell-level
  `EditHistory.validatedBy`). Absent on metadata entries.

Mirror on the notebook-level meta Y.Map: `meta.edits: Y.Array<Y.Map>` with the
same entry shape but **no `validatedBy`** (matches
`CustomNotebookMetadata.edits: FileEditHistory[]`).

### Why `Y.Map<username, Y.Map>` for `validatedBy`

Outer-keyed-by-username gives CRDT-natural dedup: two devices toggling
validation for the same user converge via last-write-wins on
`updatedTimestamp` and `isDeleted`. Two different users validating
concurrently become two different keys — both survive. We never need the
runtime equivalent of `mergeValidatedByLists` (desktop
`resolvers.ts:71`) because the structure itself enforces uniqueness.

### Data model — demoted

`cell.history: Y.Array<CellHistoryEntry>` stays as the keystroke-level log
that feeds the XmlFragment via the TipTap binding. It no longer drives
validation reads or serialize output.

`__source` on each cell Y.Map and on the `meta` Y.Map becomes import-time
reference data. Runtime code **does not** mutate `__source.metadata.edits`
or `__source.metadata.validatedBy`. It still backs static round-trip
fields (attachments, cellLabel, data, etc.) so unknown keys survive re-export.

### Session rule

A commit by user X triggers:

1. Peek the last entry in `cell.edits`.
2. If `(now - last.timestamp) < 5 min` AND `last.type` matches the current
   type AND `last.editMap` equals the current editMap:
   - Set `last.value = newValue`, `last.timestamp = now`.
   - If X ∉ `last.authors` → append X to `authors`.
   - For user-edit + `editMap[0] === "value"`: upsert X in `last.validatedBy`
     (auto-validate).
3. Else → append a new Y.Map entry: `authors: [X]`, fresh `timestamp`, `type`,
   `editMap`, `value`. For user-edit + value-editMap, seed `validatedBy` with
   X. LLM entries omit `validatedBy` entirely.

The 5-minute window and same-author/type/editMap grouping matches the existing
`collapseToEditSessions` semantics (`src/lib/codex-editor/serialize/edit-sessions.ts:22`),
just applied live at write time instead of at serialize time.

Attribution follows **deliberate commits** (blur, Enter, debounced keystroke)
— never raw Yjs fragment keystrokes. Two users typing into the same fragment
without either committing produces zero `cell.edits` entries. Whoever commits
first takes sole attribution of the state at that moment. If the other user
commits later within 5 min, they're added to `authors` of the same session.

## Components

### Write path (replaces today's scattered writes)

New module `src/lib/codex-editor/edits/`:

- `commitCellEdit(doc, cellId, username, editMap, value, source: "human" | "llm")`
  — the session-rule implementation above. Called from `EditorTable.tsx` on
  blur/Enter/debounce commit, alongside (not replacing) the existing
  `recordHistoryEntry` call at line 298. Both fire per commit: `commitCellEdit`
  writes to `cell.edits` (validation-bearing session log), `recordHistoryEntry`
  continues to append to `cell.history` (keystroke log for TipTap).
- `toggleCellValidation(doc, cellId, username, validate: boolean)` — rewritten
  to target `cell.edits` instead of `__source`. Finds the latest entry with
  `editMap[0] === "value"`, upserts/soft-deletes the `validatedBy[username]`
  inner Y.Map. No-ops on cells with no value-edit yet (can't validate empty).
- `commitMetaEdit(doc, editMap, value, username, source)` — session-grouping
  commit for notebook-level metadata edits. No validation.

`cell.history` Y.Array continues to receive entries via `appendCellHistory` /
`recordHistoryEntry` so the TipTap binding and local keystroke replay still
work. `commitCellEdit` takes over everything that previously flowed into
`__source`.

`updateSourceValidation` in `useCellHistory.ts:91` is removed.

### Read path

`src/hooks/useCells.ts` rewritten:

- `deriveValidationStatus` walks `cell.edits` backwards for the latest
  `editMap[0] === "value"` entry, enumerates its `validatedBy` Y.Map, filters
  `isDeleted`, returns `{validationStatus, activeValidators}` exactly as today.
- New field `CellData.validationHistory: EditValidationSummary[]` — shallow
  projection of `cell.edits` built once per `computeOrdered` pass. Each entry:
  `{authors, timestamp, type, editMap, value, validatorsActive: string[],
  validatorsHistory: Array<{username, updatedTimestamp, isDeleted}>}`. Used
  by the popover timeline.

Observer wiring: `cellsMap.observeDeep` already covers nested mutations, so
no new hooks.

### Migration (one-time per cell, on rehydrate)

Runs inside `src/lib/store/file-doc.ts` during the rehydrate/merge transaction.
Idempotent, guarded by a marker:

```
if (!cell.get("__editsSeeded") && source.metadata.edits?.length) {
  // For each EditHistory in __source.metadata.edits:
  //   - Create Y.Map with authors: [entry.author], timestamp, type, editMap, value
  //   - If entry.validatedBy: for each valid ValidationEntry,
  //     set validatedBy[username] = Y.Map({creationTimestamp, updatedTimestamp, isDeleted})
  //   - Drop legacy string-only entries (use isValidValidationEntry check from
  //     src/lib/codex-editor/merge/validators.ts:6)
  // Push all entries into cell.edits in original order.
  cell.set("__editsSeeded", true)
}
```

Mirror on `meta` Y.Map for `meta.edits` (seeded from `__source.edits`, no
`validatedBy`).

The marker syncs through Yjs to all peers on first connect, so the seed
happens once per project-opener and never re-applies. If a new peer joins
after seeding, they observe the populated `cell.edits` directly and the
marker tells `rehydrate` to skip re-seeding.

### Serialize-out (GitLab back-compat, lazy)

Rewrite `src/lib/codex-editor/serialize/cell.ts`:

1. Start from `__source` (JSON clone) for static fields.
2. Build `metadata.edits` entirely from `cell.edits`:
   - For each Y.Map, emit an `EditHistory`:
     - `author = authors.length > 1 ? authors.join("/") : authors[0]`
     - Inline code note: `// TODO: drop concat once EditHistory.author
       upstream supports string[]`
     - `editMap`, `value`, `timestamp`, `type` passthrough
     - `validatedBy`: if the Y.Map has entries, enumerate into
       `ValidationEntry[]` sorted by username for stable diffs. Omit field
       entirely if empty (matches desktop).
3. `value` re-emitted from current `translatedXml` fragment if the fragment
   differs from `__source.value`.
4. `cell.history` is advisory only — no longer feeds `metadata.edits`.
   `collapseToEditSessions` usage in the serialize path is removed.

`serializeFile` similarly reads `meta.edits` for notebook-level metadata.

**Round-trip verified conceptually:**

- Web → GitLab → Desktop: our output matches the existing `.codex` JSON shape
  desktop reads. Multi-author `"alice/bob"` is opaque to desktop (string field),
  but `validatedBy` usernames are independent, so validation attribution is
  never ambiguous.
- Desktop → GitLab → Web: re-import seeds `cell.edits` from
  `__source.metadata.edits` (one entry per desktop edit, `authors: [author]`).
- Desktop's git-merge resolver (`src/projectManager/utils/merge/resolvers.ts`)
  handles our `validatedBy: ValidationEntry[]` arrays via
  `mergeValidatedByLists` (dedup by username, latest `updatedTimestamp` wins)
  — the exact merge our Yjs `Y.Map<username, Y.Map>` already enforces at
  write time.

### UI

Icon mapping in `src/components/EditorTable.tsx:380` — one swap, others
unchanged:

| State | Current | New |
|---|---|---|
| `"empty"` | (hidden) | (hidden) |
| `"none"` | `Circle` | `Circle` |
| `"others"` | `CircleDot` | `Circle` with `fill="currentColor"` |
| `"self"` (not full) | `Check` | `Check` |
| `"full"` | `CheckCheck` | `CheckCheck` |

Color rules unchanged. `HealthRing` wrapper (`EditorTable.tsx:409`) preserved.

Validation popover (`EditorTable.tsx:413-449`) grows `w-48` → `w-72` to fit
the timeline. Structure:

- **Validated by** section (current validators) — identical to today. Each
  row shows username; trash icon on your own row to revoke.
- **History** section — collapsible, lists prior value-edits newest-first.
  Each row: relative date, author list, 40-char value snippet. Clicking a
  row expands to show validators for that state with their timestamps;
  soft-deleted (`isDeleted`) entries shown dimmed with strikethrough.
- Read-only — no way to edit past validations. Only current-state validation
  is togglable.

Source for the history list: `cell.validationHistory` filtered to
`editMap[0] === "value"`.

## Dataflow

```
User types in TipTap
  → Y.XmlFragment live-mutates (syncs to peers)
  → (no cell.edits touch yet)

User blurs / Enters / debounce fires
  → EditorTable.tsx commit handler
  → commitCellEdit(doc, cellId, username, ["value"], text, "human")
     ├─ peek cell.edits last entry
     ├─ session-grouping decision (update in place vs append)
     ├─ upsert username in last.authors (if new)
     └─ upsert validatedBy[username] Y.Map (auto-validate)
  → recordHistoryEntry appends to cell.history (TipTap log — unchanged)

Another user clicks validation icon
  → toggleCellValidation(doc, cellId, username, true)
     └─ find latest cell.edits entry with editMap[0]==="value"
        └─ upsert validatedBy[username] Y.Map

useCells re-runs computeOrdered (observeDeep fires)
  → deriveValidationStatus reads cell.edits (not __source)
  → CellData.validationStatus / activeValidators / validationHistory updated
  → EditorTable re-renders icon and popover

Periodic / on-demand GitLab push
  → serializeCell reads cell.edits → emits __source.metadata.edits shape
  → writes .codex JSON → pushes to GitLab
```

## Error handling

- **Empty-cell validation toggle:** no-op. `toggleCellValidation` returns
  early if no value-edit exists yet.
- **Legacy string entries** in `__source.metadata.edits[i].validatedBy`
  (pre-migration data from old versions): migration filters via
  `isValidValidationEntry` and drops strings. They're also dropped by the
  current web parser already.
- **Concurrent session creation:** CRDT-natural. Two users committing at
  exactly the same millisecond produce two sibling entries in `cell.edits`.
  Both survive, ordered by Yjs insertion. Fine — each gets its own authors
  and validatedBy.
- **Missing `__source`:** already fatal in `serializeCell`. Unchanged.
- **Rehydrate race:** the `__editsSeeded` marker is set inside the same
  `doc.transact` as the seeding, so a peer can't observe half-populated
  `cell.edits`.

## Testing strategy

### Unit tests

`src/lib/codex-editor/edits/commit-cell-edit.test.ts`:
- Same-author commits within 5 min → one entry, updated in place.
- Same-author commit outside 5 min → two entries.
- Two distinct users committing within 5 min → one entry with 2 authors and
  2 validators.
- LLM commit → new entry with no `validatedBy`.
- User commit after LLM entry → new entry (type differs), auto-validated.
- Metadata editMap + value editMap by same author back-to-back → two entries
  (editMap differs).

`src/lib/codex-editor/edits/toggle-cell-validation.test.ts`:
- Validate then un-validate same user → soft-delete; `isDeleted: true` and
  `updatedTimestamp` advances; entry never removed.
- Validate by user B after user A's edit → `validatedBy` has 2 keys.
- Empty cell (no value-edit yet) → no-op.

`src/lib/store/file-doc.seed-edits.test.ts`:
- Rehydrate with `__source.metadata.edits` populated → `cell.edits` seeded;
  `__editsSeeded` marker set.
- Second rehydrate with marker set → no-op.
- Seeding drops legacy string `validatedBy` entries.
- `meta.edits` seeded from `__source.edits` independently.

`src/lib/codex-editor/serialize/cell.test.ts` (rewrites existing):
- Empty `cell.edits` → emits cell with empty `metadata.edits`.
- Multi-author session → `author: "alice/bob"`.
- Single-author session with one validator → `validatedBy: [{...}]`.
- Soft-deleted validators emitted with `isDeleted: true`.

### Integration tests

`src/hooks/useCells.validation.test.ts`:
- User 1 edits and auto-validates → `validationStatus: "self"`.
- User 2 edits after → `validationStatus: "self"` for user 2 (user 1's
  validation is on the prior entry; UI reads only the latest value-edit).
- User 1 manually validates user 2's edit → `validationStatus: "full"`
  with `requiredValidations: 2`.
- `validationHistory` contains both edits with their respective validators.

### Manual verification

- Round-trip via existing `src/lib/sync/y-partyserver-spike.test.ts` pattern:
  web commit → party-server persist → re-hydrate in a second doc → same
  `cell.edits` observed.
- Export via GitLab import tests in `src/lib/importer/` — compare serialized
  JSON to golden fixture captured from today's output before migration.

## Open questions (tracked, not blocking)

- Should `cell.edits` be pruned when the history grows to thousands of
  entries? Likely yes, but not in v1. Add `__editsTruncatedBefore` marker
  later if needed.
- Project-level metadata edit tracking (`ProjectEditHistory`) — worth a
  follow-up spec once we know what state project-level `metadata.json` has
  on web.
- When upstream `EditHistory.author` supports `string[]`, drop the
  concatenation at the one call site in `serializeCell`.

## File change summary

**New:**
- `src/lib/codex-editor/edits/commit-cell-edit.ts`
- `src/lib/codex-editor/edits/toggle-cell-validation.ts`
- `src/lib/codex-editor/edits/commit-meta-edit.ts`
- `src/lib/codex-editor/edits/seed-from-source.ts` (migration)
- `src/lib/codex-editor/edits/types.ts` (`EditValidationSummary` etc.)
- Test files for each above.

**Modified:**
- `src/hooks/useCells.ts` — read `cell.edits`; new `validationHistory` field.
- `src/hooks/useCellHistory.ts` — route through new commit/toggle; remove
  `updateSourceValidation`.
- `src/lib/store/file-doc.ts` — call seeding during rehydrate/merge.
- `src/lib/codex-editor/serialize/cell.ts` — read `cell.edits` instead of
  collapsing `cell.history`.
- `src/lib/codex-editor/serialize/file.ts` — read `meta.edits`.
- `src/components/EditorTable.tsx` — icon swap for `"others"`; popover
  timeline.

**Removed usage:**
- `src/lib/codex-editor/serialize/edit-sessions.ts` — no remaining consumers
  after the serialize rewrite. Migration seeds directly from
  `__source.metadata.edits` (already session-collapsed on disk). Delete the
  module and its tests, or leave it in place as unused code; plan phase will
  pick one. Flagging so reviewers notice the dead code.
