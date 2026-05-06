# Legacy GitLab → CQRS event import

How to import an existing GitLab project (or any external source) into codex
as a single durable POST: events flow into D1, the editor reconstructs the
Y.Doc on first open via Phase 4d hydration. No client-side Y.Doc construction
required.

## TL;DR

```
for each cell in the gitlab project:
  POST /events {
    id: <UUIDv7 derived from gitlabCommitSha + cellId>,
    schemaVersion: 1,
    kind: "cell.commit",
    projectId, fileId, cellId,
    author: <frontier username>,
    payload: {
      value: "<plain text>",
      valueHtml: "<p>html</p>",
      meta: { original, originalHtml, context, group, type,
              sourceLocation, globalReferences, cellLabel }
    },
    clientTs: Date.now()
  }
```

The server projects each event into `cells`. When a user opens the project,
the `FileSync` Durable Object boots, finds no R2 snapshot, replays events
chronologically, builds a Y.Doc, and persists the result back to R2 as the
initial snapshot. Subsequent loads use R2 directly.

Re-running the import is a no-op — `events.id` is the idempotency key
(server uses `INSERT OR IGNORE`).

## Idempotency

Pick a deterministic `id` scheme keyed on the upstream source:

```ts
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'node:crypto'

function importEventId(gitlabCommitSha: string, cellId: string): string {
  // Hash → 16 bytes → format as UUIDv7. Stable across re-runs of the
  // same gitlab snapshot, so retrying the import doesn't duplicate.
  const hash = createHash('sha256').update(`${gitlabCommitSha}|${cellId}`).digest()
  // (use your preferred deterministic-UUID helper; the key property is
  // that the same input produces the same id every time)
  ...
}
```

Server-side, `events.id` is the primary key with `INSERT OR IGNORE`.
Re-posting the same event is silent and free.

## Seed metadata

`cell.commit.payload.meta` is read **only on the first commit for a cell**
during hydration; subsequent commits don't re-stamp these fields. This means:

- Future edits to the same cell don't need `meta` — they just carry `value`
  and `valueHtml`.
- If you re-import with different metadata for the same cell (different
  `original`, etc.), hydration ignores the changes (first-write wins). To
  update metadata after first import, use a future `cell.metadata.set` event.
- Metadata fields are optional. Cells without `meta` hydrate with default
  values (empty `original`, `context`, `group`, `type`).

## Hydration semantics

`FileSync.onLoad` triggers hydration when:

1. The R2 snapshot is empty AND no tail updates exist, AND
2. After the (empty) snapshot replay, `doc.getMap("cells")` is empty, AND
3. `CODEX_DB` is bound (production; spike/dev without D1 skip silently)

Hydration is **cold-start only**. After the first user opens the project,
the hydrated Y.Doc is persisted to R2; subsequent loads use R2 and skip
hydration entirely. Adding new events to D1 *after* the project has been
opened won't surface them — they need to flow through the live event path
(client → outbox → POST /events → server broadcast → DO realtime).

For "add cells to an already-opened project" use cases, prefer:

- The client-side outbox (normal user edits)
- A future admin endpoint to force-rehydrate (not yet implemented)

## What hydration does NOT do

- **Validation events** (`cell.validate`, `cell.unvalidate`) are skipped.
  Validators live in `cell_validators` and are read by
  `useCellsAuditStatsWithOverlay`, not from the Y.Doc.
- **Thread events** are skipped (Phase 4 hasn't moved threads out of Y.Doc
  yet; once it does, hydration will handle them).
- **Rich text reconstruction**: the current implementation seeds
  `translatedXml` as a single Y.XmlText with the plain `value`. The
  `valueHtml` field is stored on the event but not parsed back into a
  Y.XmlFragment with formatting. Users will see the text on first open
  but lose inline formatting until they re-edit the cell. (Follow-up:
  parse `valueHtml` → fragment in hydration.)

## Required role

`POST /events` requires the JWT's role level to meet `requiredRoleFor`
(`role-policy.ts`). For `cell.commit`, that's `CONTRIBUTOR` (400). For an
admin import script, mint a sync-token with sufficient role and use it for
the bulk import.

## File rows

Hydration only restores `cells` → Y.Doc. The `files` table row is created
the first time the DO calls `writeProjection` (on `onSave`). For the
project listing UI to show the imported files immediately, also INSERT
`files` rows during import — either via a separate admin endpoint or
directly against D1.

(Future work: add a `file.create` event kind so files are also event-sourced.)

## Verifying an import

```bash
# 1. POST events for each cell.
curl -X POST https://sync-worker/events \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"events":[ ...batch... ]}'

# 2. Verify the projection.
curl https://sync-worker/cells/audit-stats?fileId=$FILE_ID \
  -H "Authorization: Bearer $SYNC_TOKEN"
# → { cells: [{ cellId, editCount: 1, ... }, ...] }

# 3. Open the project in the web app. The editor should show every cell
#    on first load. After that, the doc is in R2 and subsequent loads
#    bypass hydration.
```

Look for `[FileSync.onLoad] hydrated <docId>: N cells from M commits` in
the worker logs to confirm hydration fired.
