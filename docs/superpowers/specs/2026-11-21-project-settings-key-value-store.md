# Project settings as records: step 2, the key/value store

Spec for AQU-2719 step 2. Written 2026-11-21 alongside step 1, which moved the
first large collection to rows (decision record
`docs/decisions/0019-settings-collections-move-to-rows.md`). **Nothing here is
built.** Step 2 gets its own ticket; this is the written design that ticket
starts from, so the decisions it has to make are visible before anyone writes
a migration.

## What step 1 does not fix

Step 1 shrinks the blob. It does not change its shape. After every collection
has moved, `project_settings.settings` is still one JSON document holding
~60 small scalar keys, still written as a whole document under one version
number, and a server path that needs a key with no generated column still
parses all of it. So the three costs that outlive step 1 are:

- **A new server-read setting still needs a table-rewriting migration** to get
  its own generated column. There are 28 of them, each added reactively.
- **Two people who change unrelated settings still conflict**, because
  `version` is per project, not per key.
- **The write is still read-modify-write**, so a caller that sends one key
  deletes every other one (AQU-1730) and every caller must echo the blob back.

## The shape

One row per project and key:

```sql
CREATE TABLE project_setting_values (
    project_id TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      JSONB NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,  -- per KEY, not per project
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by BIGINT,
    PRIMARY KEY (project_id, key)
);
```

A server path that wants one setting reads one row by primary key. That is
what retires the generated columns, and what the smart-edits route wanted when
it could not check `smartEditsEnabled` per request (decision record 0016).

The key set is not free-form: `db/shared/project-settings-keys.ts` is already
the authoritative registry of writable keys and their types, and it stays the
gate. A row whose key is not in the registry is not readable as a setting.

## The five decisions this needs

1. **Does `version` stay per project, per key, or both?** Per key is the point
   — it is what lets two people save unrelated settings — but the settings
   `PATCH` contract is `If-Match-Version` on one project-wide number, and
   every SPA caller and the Agent API's `patch_settings` sends it. Proposed:
   keep the project-wide `project_settings.version` as the **transport**
   version, bumped by any key write, and add the per-key version for conflict
   *detection*, so a save that touches only keys nobody else moved succeeds on
   a stale project version. That makes the existing 409 strictly rarer and
   never more common, which is the only direction that is safe to ship without
   a client change.
2. **What does a whole-document `PUT` mean?** Today it replaces the document,
   so omitted keys are deleted (AQU-1730, pinned by
   `auth-worker/src/__tests__/project-settings-partial-body-wipe.test.ts`).
   Over rows, "replace the document" is "delete every row this body omits".
   Proposed: keep exactly that, because changing it would silently turn a
   caller's wipe into a merge, and the echo-the-blob convention that every
   caller follows depends on the current meaning. A real per-key API is the
   `PATCH` ops path, which already exists
   (`db/shared/projects.ts::patchProjectSettingsShared`).
3. **Where do the per-key role floors live?** `auth-worker/src/routes/project-settings.ts`
   decides access by diffing the incoming document against the stored one and
   looking at which keys actually *changed*
   (`changedSettingsKeys`) — the carve-outs for `autopilotEnabled`,
   `alignmentSeeds`, `ttsSettings` and `parallelBibleVersions`, and the refusal
   of the retired `terminology` key, all read that diff. Over rows the diff is
   cheaper and exact rather than JSON-serialization-compared, but the
   carve-outs must keep being scoped to "this write changes nothing else", or
   one of them widens into a general grant. Proposed: the diff moves into the
   store and the route keeps the same carve-out table, unchanged.
4. **How does inheritance from a linked project work per key?**
   `db/shared/inherited-settings.ts` prepares a write by detaching a field the
   maintainer just edited and pulling a field they just turned on, then
   cascades to downstreams. It reads whole settings objects on both sides.
   Over rows it should read and write the keys it actually governs, which is a
   strict improvement — but the invariant to prove is the one step 1 already
   had to: a linked project gives the same answer before and after the move.
5. **What is the read API inside the workers?** Today `loadProjectSettings`
   hands back one object and callers index into it, which is why every caller
   accidentally depends on the whole document being loaded. Proposed: keep
   that function (it is what the settings `GET` returns) and add a
   `readSetting(db, projectId, key)` for server paths, so a new server-read
   setting needs no migration and no generated column — the stated goal of
   AQU-2719's "done looks like".

## Migrating existing projects

The same rules step 1 proved, so there is one pattern and not two
(decision record 0019):

- **The rows are a union with the blob, never a cutover.** A key with no row
  falls back to the document. No reader may assume the row exists.
- **A project's keys move on its next save**, and an operator script backfills
  the projects nobody saves. A read never migrates.
- **A key is removed from the document only after its row is in**, with jsonb
  `-`, and without bumping `version`.
- **Older clients keep working**: a client that sends or expects a key in the
  whole-document `PATCH` or `GET` gets a correct answer, and the worker and the
  SPA may deploy in either order.
- **A test migrates a real document shape** — a key of each registry type, a
  malformed value, and a linked project — and compares what a client reads
  before and after.

## Done looks like

- A server path reads one setting with one primary-key lookup.
- A new server-read setting needs no migration.
- The 28 generated columns are gone, or each has a stated reason to stay.
- Two people saving unrelated settings do not conflict.
