# A settings collection moves to rows, and the key never leaves the API

Record 0019. Dated 2026-11-21. AQU-2719 step 1.

## Context

`project_settings.settings` is one JSON text column per project, and the schema
comments call it multi-MB. About 74 typed keys live in it
(`src/lib/sync/project-settings.ts`), and the SPA's save is a whole-blob
read-modify-write guarded by one version number.

Every hot read was patched instead of the storage: 28 keys are now copied into
generated columns, one table-rewriting migration at a time
(`db/postgres/schema.sql`). Each was added after a request path was caught
parsing the whole document to read one setting — AQU-1840 is the clearest
case, where every cell autosave loaded the blob to ask "is this lane
archived?". A settings save now parses the blob once per generated column, 28
times; migration 0150 measured one parse at about 7 ms per MB on dev. Two
people who change unrelated settings still contend on one version number.

Terminology left the blob in AQU-1006 and became the `concepts` table. Nothing
else has.

## Decision

A large collection moves out of the blob into **its own table**, keyed on the
collection item's own client-minted id, and **the settings key stays on the
API surface**. `livingMemoryEntries` is the first
(`db/postgres/migrations/0210_project_living_memory_entries.sql`); the rules
below are what the next one follows.

1. **The read is a union, never a cutover**, in SQL as well as in the merge.
   `loadProjectSettings`
   (`db/shared/projects.ts::loadProjectSettings`) puts the key back into the
   settings object it returns: the rows first, then anything still under the
   blob key that the rows do not carry
   (`db/shared/living-memory-entries.ts::mergeLivingMemoryEntries`). No reader
   may assume the rows exist. An un-migrated project, a half-migrated one, and
   an item the move refused to carry all read correctly, which is the same rule
   the `wp_` columns follow in `sync-worker/src/events/request-cache.ts`. The
   read also falls back when the table itself is absent — a worker may be
   deployed before its migration is applied — and that fallback is never
   remembered, because a transient error cached as "no table" would read a
   migrated project's items as absent, which is worse than an error.
2. **The rows ride in the settings write's own batch**, carrying the same "the
   row I just wrote is still stored" guard as the validation projection, so a
   write that loses its version race changes nothing
   (`db/shared/projects.ts::updateProjectSettingsShared`). A save by a project
   that has not moved yet **is** the move.
3. **A read never migrates.** AQU-1006 measured a migrate-on-read of the
   largest dev termbase past the Worker budget and left reads alone
   (`sync-worker/src/events/migrate-concepts.ts::migrateProjectConcepts`); a
   read that writes would also rewrite a multi-MB row under any racing human
   edit, which is why the react cursor was pulled out of the blob in the first
   place. Projects nobody saves are backfilled by an operator script
   (`scripts/migrate-living-memory.ts`) that shares the move's code path
   (`db/shared/living-memory-entries.ts::migrateProjectLivingMemory`).
4. **The blob key is rewritten only after the rows are in**, with jsonb `-` or
   `jsonb_set` rather than a read-modify-write, and **without bumping
   `version`** — a storage migration is not a user edit, and a bump would 409
   an in-flight save. An item that cannot become a row stays under the key.
5. **The key is never silently dropped.** When the last item is deleted the
   blob keeps an explicit `[]`: `src/hooks/project-settings-overlay.ts` ignores
   an absent value, so an absent key would leave the client showing the items
   the user just deleted.
6. **A reader with its own `SELECT settings` must merge the rows in.** Only
   two do, both resolving instructions
   (`db/shared/load-translation-instructions.ts::loadTranslationInstructions`
   and `db/shared/project-facts-write.ts`), and they merge for the resolution
   only — a writer that merged into the object it stores would put the items
   back in the blob
   (`db/shared/living-memory-entries.ts::withLivingMemoryEntries`).

## Consequences

Nothing downstream can tell the storage moved: the settings `GET`, the
whole-blob `PATCH`, inherited settings, the Agent API's `patch_settings` and
the key registry (`db/shared/project-settings-keys.ts`) are untouched, and the
worker and the SPA can deploy in either order. That is also the cost — the
whole-array read-modify-write **shape** survives, so this buys back bytes and
parses, not per-item conflict handling. A collection written per item at high
frequency needs per-item events, as terminology got, not just a table.

The reader costs no extra round-trip: the rows arrive as a correlated
aggregate inside the settings `SELECT`
(`db/shared/living-memory-entries.ts::LIVING_MEMORY_SELECT`), which matters
because the write path loads settings up to three times per save. A save that
changes the collection replaces its rows, which is O(items) statements —
acceptable for authored entries, not for a collection with thousands of items.

The before/after comparison a client reads, over a blob carrying a large
collection and a malformed item, is pinned in
`auth-worker/src/__tests__/project-living-memory-rows.test.ts`.

A new project-scoped table joins the RLS ledger in
`scripts/rls-coverage.test.ts`, which fails until the decision is recorded.
This one is listed uncovered for the reason `concepts` is — terminology's
table, from the equivalent move: a new table is not granted to `app_runtime`,
so a policy written `TO app_runtime` would enforce nothing while reporting the
table as covered.

## Not covered yet

Four collections named in AQU-2719 are still in the blob: `alignmentSeeds`,
`translationBrief`, `rules` and `fileGenres`. `alignmentSeeds` is the one to
look at hardest — it is written per confirmed word pair by any contributor
through a whole-array read-modify-write, so it is both the likeliest bulk and
the one a table alone will not fix. Which collection actually dominates the
blob is unmeasured: AQU-2719 carries the sizing query, and only a person can
run it against production.

Step 2 of AQU-2719 — a key/value table for the small scalar keys, which is
what would stop the generated-column migrations — is specified in
`docs/superpowers/specs/2026-11-21-project-settings-key-value-store.md` and is
not decided here. Nor is the removal of the 28 generated columns: each needs
its reader checked before it goes.

No collection's rows are reachable on their own yet — there is no per-item
route and no per-item event for `livingMemoryEntries`, so a concurrent edit to
two different entries still contends on the settings version.
