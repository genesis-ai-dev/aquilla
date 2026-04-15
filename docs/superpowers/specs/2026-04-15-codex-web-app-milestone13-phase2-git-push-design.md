# M13 Phase 2 — Git Push (Snapshot Sync)

**Date:** 2026-04-15
**Status:** Approved design
**Predecessor:** Phase 1 (read-only git import) — `2026-04-15-codex-web-app-milestone13-phase1-git-import-design.md`

## Goal

Let a user editing a git-imported codex-editor project commit their changes back to the cloned OPFS repo and push to GitLab. Lossless on cells we don't touch (byte-identical disk diff). No pull, no merge — Phase 3 owns those.

## Non-goals

- Pulling remote changes after initial clone.
- Conflict resolution / merging (Phase 3).
- Force-push, branch switching, partial pushes.
- Background pushes during browser-close (we use the foreground only).

## Architecture

```
   ┌────────────────┐  cell edit (TipTap) ──▶  Y.Doc transaction
   │   Editor UI    │
   │  + Toolbar    ─┼──── Sync button ─────────┐
   └────────────────┘                          │
            │                                  ▼
            │ poll every N min          ┌──────────────┐
            └─────────────────────────▶ │  syncEngine   │
                                        └──────┬────────┘
                                               │
                                serializeProject() │
                                               │
   ┌──────────────────────────┐  write   ┌─────▼──────────┐
   │ OPFS /repos/{projectId}  │◀─────────│ codex serializer│
   │ files/target/*.codex     │          │ (uses __source) │
   │ .project/comments.json   │          └────────┬────────┘
   │ metadata.json            │                   │
   └──────────────────────────┘                   │
                                                  ▼
                                            isomorphic-git
                                              add → commit → push
                                              (via CORS proxy)
                                                  │
                                                  ▼
                                            GitLab remote
```

Three subsystems:

1. **Lossless serializer** (`src/lib/codex-editor/serialize/`) — Y.Doc → codex JSON, mutating only what changed using `__source` stash.
2. **Sync engine** (`src/lib/sync/git-sync.ts`) — orchestrates serialize → stage → commit → push, surfaces progress + errors.
3. **UI** — Sync button in the project toolbar with state pill (idle/dirty/syncing/error), per-project auto-sync interval setting in `ProjectSettings`.

## Lossless contract

**Hard requirement.** Round-tripping a codex-editor repo through clone → import → no-op → serialize must produce byte-identical files. Tested in CI.

Mechanism:

- On import, every cell's full original parsed JSON is stashed at `cell.set("__source", originalCellJson)`.
- File-level metadata (`metadata.json`) gets stashed at `doc.getMap("meta").set("__source", originalMetadataJson)`.
- Each comment thread stashes its full original at `thread.set("__source", originalThreadJson)`.
- The directory listing of every file we read is stashed in a project-level `originalFileListing` (path → byte-equal contents key) so files we didn't touch (`.vscode/settings.json`, fonts, etc.) are never re-emitted.

Serialization rule: **start from `__source`, override only fields we know are local**, never touch unknown fields.

## Edit-session → EditHistory mapping

The HistoryDrawer already collapses contiguous user edits into "edit sessions" via `isSameEditSession`. We reuse that grouping:

- Each session that hasn't been synced yet becomes ONE codex-editor `EditHistory` entry with:
  - `editMap: ["value"]`
  - `value`: the final HTML string at session end (`getFragmentHtml(translatedXml)`)
  - `timestamp`: session end timestamp
  - `author`: the username from the session's last entry (Frontier session username for live edits, `"git-import"` for legacy entries)
  - `type`: `"user-edit"` for human, `"llm-edit"` / `"llm-generation"` for LLM
  - `validatedBy`: derived from per-cell validation state at session end
- Validation toggles produce `validatedBy` mutations on the most recent matching edit, never their own EditHistory entries.
- Tracking unsynced state: each cell's Y.Map gets `__lastSyncedHistoryAt` (ms timestamp). Sessions whose end timestamp ≤ `__lastSyncedHistoryAt` are already in `__source.edits` and don't get re-emitted.

## Cell change detection

A cell is "dirty" iff:
- Current `getPlainText/getFragmentHtml(translatedXml)` differs from `__source.value`, OR
- Any history session ends after `__lastSyncedHistoryAt`, OR
- Local `validatedBy` differs from `__source.edits[*].validatedBy` for any edit, OR
- A new comment thread/message exists with `timestamp > __lastSyncedHistoryAt`.

Project is "dirty" iff any cell or any file-level metadata is dirty.

The sync engine exposes `isProjectDirty(projectId)` that runs without serializing.

## Vendor codex-editor merge resolvers

Even though Phase 2 doesn't merge, we vendor the pure functions now so:

- The Phase 2 serializer produces output that the vendored resolvers can consume cleanly in Phase 3 (same shape, same dedup keys).
- A round-trip test in Phase 2 exercises `mergeTwoCellsUsingResolverLogic` against locally-emitted JSON to catch shape regressions.

Path: `src/lib/codex-editor/merge/`. Files:
- `validators.ts` — `isValidValidationEntry`, `mergeValidatedByLists`, `mergeValidatedByArrays`
- `cells.ts` — `mergeTwoCellsUsingResolverLogic`, `applyEditToCell`
- `attachments.ts` — `mergeAttachments`, `resolveAudioSelection`
- `metadata.ts` — `mergeProjectSwap`, `mergeSwappedUsers`, `mergeOriginalFilesHashes`
- `migration.ts` — `migrateEditHistoryInContent`, `needsEditHistoryMigration`
- `comments.ts` — `areCommentsDuplicate`, `generateCommentId`, `migrateComment`
- `index.ts` — re-exports

Source mapping documented in each file's header (path + line range to the codex-editor original) so future ports stay easy.

## Sync engine API

```ts
// src/lib/sync/git-sync.ts

interface SyncResult {
  status: "idle" | "synced" | "no-changes" | "remote-moved" | "error";
  commitSha?: string;
  filesWritten?: number;
  message?: string;
}

interface SyncOptions {
  signal?: AbortSignal;
  onPhase?: (phase: SyncPhase, label?: string) => void;
}

type SyncPhase =
  | "idle"
  | "checking-dirty"
  | "serializing"
  | "writing"
  | "committing"
  | "pushing"
  | "done"
  | "error";

export async function syncProject(
  project: ProjectRecord,
  session: FrontierSession,
  opts?: SyncOptions
): Promise<SyncResult>;

export function isProjectDirty(project: ProjectRecord): Promise<boolean>;
```

Behavior:

1. Open OPFS dir for `repoKey`.
2. Check `git fetch origin {branch}` head — if it differs from `origin.headSha`, return `{status: "remote-moved"}` and surface the "Sync requires Phase 3" error. **No push.**
3. Else, for each file Y.Doc, run `serializeFile(doc, sourceRepoTree)` → write back to OPFS at the original path. Skip writes if bytes unchanged (idempotency).
4. `git add -A` → if no staged changes, return `{status: "no-changes"}`.
5. `git commit -m "{summary}\n\n{detail}"` with author `{name: session.username, email: <username>@frontier}`.
6. `git push` (auth via Frontier GitLab token, through CORS proxy).
7. On success, update `project.origin.headSha` to the new commit SHA; update each cell's `__lastSyncedHistoryAt`; return `{status: "synced", commitSha, filesWritten}`.
8. On any failure, return `{status: "error", message}` and **do not** mutate `__lastSyncedHistoryAt` — so the next sync retries.

Commit message format:
```
codex-web: sync N cells across M files

- {filename}: {n} cells changed
- {filename}: {n} cells changed
```

## UI

### Sync button (Toolbar)

A new component `SyncButton` lives in `Toolbar.tsx` between the existing share/snapshot icons and the user menu. States:

- **Idle, clean:** subtle "✓ Synced" gray text, no badge.
- **Idle, dirty:** "↑ Sync N changes" button, primary color.
- **Syncing:** spinner + phase label ("Pushing…").
- **Error:** red "⚠ Sync failed — retry" with tooltip showing the error.
- **Remote moved:** amber "⚠ Remote has new commits — sync paused" with explanatory tooltip.

Keyboard shortcut: `Cmd/Ctrl+S` triggers sync (overrides browser save dialog).

### Auto-sync setting (ProjectSettings)

Add a "Sync" section to `ProjectSettings.tsx`:

```
┌─ Git sync ────────────────────────────────────┐
│  Origin: github.com/group/repo (branch: main) │
│                                                │
│  Auto-sync: [ ] Off                            │
│             [•] Every  [ 5 ] minutes            │
│                                                │
│  Auto-sync only runs if there are unsaved     │
│  changes. Manual sync is always available.    │
└────────────────────────────────────────────────┘
```

Persists on `ProjectRecord.syncSettings = { autoSync: { enabled, intervalMinutes } }`.

### Auto-sync engine

A `useAutoSync(project, session)` hook in `ProjectWorkspace`:
- If `enabled` and `session` present, sets a `setInterval` for `intervalMinutes * 60_000`.
- On tick, calls `isProjectDirty()`; if dirty, calls `syncProject()`.
- Cleans up on unmount.
- Skips ticks while a sync is already in flight.

### Permissions gate

Sync button only renders when `permissions.canPush === true`. For Phase 2 we flip `mapGitlabAccessLevel` to set `canPush: true` for access level ≥ 30 (Developer).

`canEditContent` ALSO flips on for ≥ 30 (was always false in Phase 1).

Read-only banner from Phase 1 stays for users with access < 30.

## Data model additions

```ts
// src/lib/parsers/types.ts
interface ProjectRecord {
  // existing...
  syncSettings?: ProjectSyncSettings;
}

interface ProjectSyncSettings {
  autoSync: { enabled: boolean; intervalMinutes: number };
  // future: pushOnBlur, pushBeforeClose, etc.
}

// __source is internal — not surfaced as a typed field.
```

## Serializer details

Pseudo-code for `serializeFile(doc: Y.Doc, originalNotebook: CodexNotebookFile): CodexNotebookFile`:

```ts
function serializeFile(doc, originalNotebook) {
  const cellsMap = doc.getMap("cells")
  const order = doc.getArray<string>("order").toArray()

  const out = JSON.parse(JSON.stringify(originalNotebook)) // deep clone
  const sourceCells = new Map(out.cells.map(c => [c.metadata.id, c]))

  out.cells = order.map(id => {
    const yCell = cellsMap.get(id)
    const sourceCell = sourceCells.get(id)
    if (!yCell) return sourceCell // unchanged, soft-deleted in Y but kept on disk
    const stash = yCell.get("__source") ?? sourceCell ?? scaffoldNew(yCell)

    // start from the stash
    const merged = JSON.parse(JSON.stringify(stash))

    // fold in unsynced edit sessions
    const sessions = collectUnsyncedSessions(yCell)
    if (sessions.length) {
      merged.metadata.edits = [...(merged.metadata.edits ?? []), ...sessions.map(toEditEntry)]
    }

    // fold in current value (latest text)
    merged.value = getFragmentHtml(yCell.get("translatedXml"))

    // fold in current validation state
    merged.metadata.edits = mergeValidatedBy(merged.metadata.edits, currentValidatedBy(yCell))

    return merged
  })

  // file-level metadata: same approach
  out.metadata = mergeFileMetadata(out.metadata, doc.getMap("meta"))

  return out
}
```

Key invariants:
- Order is taken from `doc.getArray("order")`, not the on-disk order, so reorders propagate.
- Cells in `__source` not in `order` are emitted from stash (covers cells the editor never touched but disk has).
- Cells in `order` but not in `__source` are new (emitted from a `scaffoldNew` template — Phase 2 doesn't add cells, but the path is reserved).

## Comments serialization

`comments.json` is rewritten as a flat object keyed by thread id, each with the full original `__source` overridden by current Y values. New threads get a generated id via `generateCommentId()` (vendored). Resolved/deleted state goes into `resolvedEvent` / `deletionEvent` arrays as the codex-editor expects.

## Identity / commit author

```ts
{
  name: session.username,
  email: `${session.username}@frontier`,  // placeholder, fine for git
}
```

## Push failure handling

`isomorphic-git.push()` throws on non-fast-forward. We:
- Re-fetch the remote head and compare with `origin.headSha`.
- If the remote moved, return `status: "remote-moved"`. UI shows the amber pause banner. **No retry.** No force-push.
- If the network failed, return `status: "error"` with retry available.
- Mutating `__lastSyncedHistoryAt` only happens on confirmed-pushed commit so retries are safe.

## Testing strategy

- **Unit:** serializer invariants — clone fixture → import → noop → serialize must produce byte-identical bytes (excluding any indentation/line-ending quirks; we'll match codex-editor's writer settings).
- **Unit:** dirty detection — every mutation type produces `isProjectDirty: true` and reverting produces `false`.
- **Unit:** vendored merge functions — copy across the codex-editor unit tests if any exist; otherwise write equivalents for `mergeValidatedByLists`, `mergeTwoCellsUsingResolverLogic`, `applyEditToCell` against fixtures.
- **Integration:** in-memory git server (or a tiny test repo over HTTP) → clone → edit → sync → verify upstream commit + bytes.
- **Manual:** clone a real project, edit a few cells, sync, then re-clone in codex-editor desktop and verify edits show up with correct authorship.

## Out of scope (Phase 3+)

- Pull / fetch-then-merge, conflict resolution.
- Cell adds/deletes propagating bidirectionally (we serialize them but don't merge them).
- New file creation push (only existing `.codex`/`.source` can be edited).
- Squashing commits, amending, branch switching.
- Push retries / backoff.
- Sync over background-tab via SharedWorker.

## Open risks

- **HTML round-trip** — codex-editor stores prose as inline HTML with arbitrary tags (`<span>`, `<sup>`, etc.). Our `getFragmentHtml` only emits the subset we render. Plan: stash the original HTML on import (`__source.value` already does this). Cells that the user didn't touch round-trip exactly. Cells that the user edited get our subset HTML — losing things like `<span>` wrappers. **Mitigation:** test against codex-editor's parser to confirm it accepts our subset; if not, extend our HTML emitter.
- **OPFS file watcher absence** — we can't detect external OPFS edits. Not a real risk in practice (no other writers to OPFS), but documented.
- **Clock skew** — if the user's clock is far off, edit timestamps used by the merger could be misordered. Mitigation: trust the user's clock for now, document the assumption.
- **Large repos** — pushing 100MB of changes via HTTPS through our worker is slow and may hit Cloudflare timeouts. Mitigation: keep individual commits small (only changed files); add progress UI; document the 100s timeout.
