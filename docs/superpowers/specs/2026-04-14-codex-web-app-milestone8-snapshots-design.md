# Codex Web App — Milestone 8: Snapshots

## Overview

Named point-in-time snapshots of entire projects. Stored locally in IndexedDB as primary backup. Exportable to / importable from files as escape hatch for cross-device backup before P2P sync arrives. Restorable with auto-snapshot safety net so restore is never destructive.

## Data Model

```typescript
interface ProjectSnapshot {
  id: string                 // uuid
  projectId: string
  name: string               // user-provided
  description?: string
  createdAt: string          // ISO
  createdBy: string          // username
  automatic: boolean         // true for auto-snapshots created before restore
  files: SnapshotFile[]      // per-file Yjs state bundle
  projectRecord: ProjectRecord  // snapshot of project config at this moment
}

interface SnapshotFile {
  fileId: string
  fileName: string
  fileType: FileType
  ydocState: string          // base64-encoded Yjs update from Y.encodeStateAsUpdate
}
```

## Storage

Extend `src/lib/store/project-index.ts` IndexedDB schema to add a `snapshots` store keyed by snapshot ID, with an index on `projectId` for efficient per-project lookup.

Existing stores: `projects`, `originals`. New store: `snapshots`. DB schema version bumps to 2. Migration keeps existing data intact.

## Operations

`src/lib/store/snapshots.ts`:

```typescript
export async function createSnapshot(
  projectId: string,
  name: string,
  description?: string,
  automatic?: boolean
): Promise<ProjectSnapshot>

export async function listSnapshots(projectId: string): Promise<ProjectSnapshot[]>

export async function getSnapshot(snapshotId: string): Promise<ProjectSnapshot | undefined>

export async function deleteSnapshot(snapshotId: string): Promise<void>

// Restore: auto-snapshot first, then wipe each file's Y.Doc state and apply snapshot state
export async function restoreSnapshot(snapshotId: string, username: string): Promise<void>

// Export a snapshot to a downloadable JSON Blob
export function exportSnapshotToBlob(snapshot: ProjectSnapshot): Blob

// Import a snapshot from a user-uploaded File. Validates structure, assigns new ID,
// allows importing into the same project or any project (projectId override optional).
export async function importSnapshotFromFile(
  file: File,
  overrideProjectId?: string
): Promise<ProjectSnapshot>
```

### Create algorithm

For each file in the project:
1. Load the Y.Doc via existing `loadFileDoc`
2. Await IndexedDB sync
3. Call `Y.encodeStateAsUpdate(doc)` → Uint8Array
4. Convert to base64 string (portable across JSON boundary)
5. Destroy the doc handle
6. Capture file metadata (name, type) from ProjectRecord

Bundle everything into a ProjectSnapshot record and `put` into the snapshots store.

### Restore algorithm

1. Load the snapshot from IndexedDB
2. Create an **automatic snapshot** of current state first (with name `"Before restoring: {snapshot.name}"`, `automatic: true`, so user always has undo path)
3. For each file in the snapshot:
   - Destroy any existing persistence via `indexedDB.deleteDatabase("codex:file:{fileId}")` OR by loading the doc, clearing it, and applying the snapshot update
   - Approach: load the doc fresh, destroy the existing content inside a transaction (delete all maps/arrays), then apply the snapshot update
   - Cleaner approach: use `IndexeddbPersistence.clearData()` to wipe persisted state, then apply the update to a fresh Doc
4. Overwrite the ProjectRecord with the snapshot's projectRecord (preserving project ID and existing file list structure; the snapshot only owns translation state + settings)

The implementation uses `IndexeddbPersistence.clearData()` then applies `Y.applyUpdate(newDoc, decodedState)` inside the same persistence lifecycle to write the restored state.

### Export/Import

Export: serialize the `ProjectSnapshot` to JSON, wrap in Blob, user downloads `.codex-snapshot` file.

Import: parse JSON, validate shape, assign new `id` so re-importing doesn't collide, insert into snapshots store. User can then use Restore like any other snapshot.

## UI

### Snapshots Page (`/project/:id/snapshots`)

Route: `/project/:id/snapshots` and `/project/:id/snapshots/debug`.

Layout:
- Header with back arrow, "Project Snapshots" title
- "+ Create snapshot" button → dialog with name (required) + description (optional)
- "Import snapshot..." button → file picker
- List of snapshots (sorted by createdAt desc), each row showing:
  - Name (bold), description (if any)
  - Automatic badge (muted) for auto-snapshots
  - Created by, timestamp
  - File count
  - Actions: Restore, Export, Delete
- Empty state: "No snapshots yet. Create one to capture this moment in time."

### Toolbar Button

Add `Camera` icon (lucide-react) between the comments button and rules button. Opens `/project/:id/snapshots`.

### Confirmation Dialogs

- Restore: "This will replace current project state with the snapshot. A safety snapshot of the current state will be created first so you can undo. Continue?"
- Delete: "Delete snapshot '{name}'? This cannot be undone."

## File Structure

```
src/
├── lib/
│   └── store/
│       ├── project-index.ts           # MODIFY: bump DB version, add snapshots store
│       ├── snapshots.ts               # NEW
│       └── snapshots.test.ts          # NEW: TDD
├── components/
│   ├── SnapshotsPage.tsx              # NEW
│   ├── SnapshotCreateDialog.tsx       # NEW
│   ├── Toolbar.tsx                    # MODIFY: Camera button
│   ├── ProjectWorkspace.tsx           # MODIFY: onSnapshots prop
│   └── App.tsx                        # MODIFY: /snapshots routes
```

## Testing

Unit tests for the snapshots module (using fake-indexeddb + real Y.Doc roundtrips):
- Create snapshot captures file state
- Restore snapshot reproduces file state exactly
- Restore creates automatic pre-restore snapshot first
- List returns project-scoped snapshots
- Delete removes snapshot but doesn't affect other data
- Export/import roundtrip preserves data

## Not In Scope

- Server-side snapshot backup (noted for post-auth milestone)
- Snapshot diff viewer ("what changed between these two snapshots")
- Scheduled automatic snapshots (beyond the pre-restore safety snapshot)
- Partial/selective restore (only restore specific files)
- Snapshot compression (can add later if size becomes an issue)
