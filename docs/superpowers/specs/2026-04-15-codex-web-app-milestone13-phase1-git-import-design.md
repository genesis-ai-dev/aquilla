# M13 Phase 1 — Read-only Git Import (Frontier + OPFS)

**Date:** 2026-04-15
**Status:** Approved design

## Goal

Let a user log into Frontier, pick a codex-editor git repo, clone it into the browser's OPFS, parse all `.codex`/`.source`/metadata/comments files, and open it as a locked (read-only) project in our editor. No push, no pull, no merge — those are Phases 2–4.

## Why Phase 1 only

- Interop with codex-editor is the highest-value sync story (user has existing repos and auth infra).
- Clone-and-read is independently testable and shippable.
- Locks out write paths until Phase 3's structure-aware merge is ready, eliminating data-loss risk.

## Architecture

```
┌─────────────┐    POST /auth/token         ┌──────────────────────┐
│   Browser   │ ───────────────────────────▶│ api.frontierrnd.com  │
│   UI        │ ◀── {jwt, gitlab_token, url}│ (Cloudflare Worker)  │
└──────┬──────┘                              └──────────────────────┘
       │ GET /portal/groups (Bearer jwt)
       │ GET gitlab/.../projects (Bearer jwt, proxied)
       │
       │ git clone via isomorphic-git
       ▼
┌─────────────┐   smart-HTTP        ┌──────────────────┐     git     ┌─────────┐
│  git-proxy  │ ──────────────────▶ │ gitlab.frontier  │ ──────────▶ │  repo   │
│  Worker     │    (CORS shim)      │                  │             │         │
└─────────────┘                     └──────────────────┘             └─────────┘
       ▲
       │
┌──────┴──────────────────────────────────────────────┐
│ OPFS: /repos/{projectId}/...                        │
│ IndexedDB: Y.Doc state per file + ProjectRecord     │
└─────────────────────────────────────────────────────┘
```

**Four subsystems:**

1. **Frontier auth client** — password login, token persistence, repo listing.
2. **Git client** — isomorphic-git + OPFS-backed fs adapter, CORS proxy worker, shallow clone.
3. **Codex-editor parser** — reads `.codex`/`.source`/`metadata.json`/`comments.json`, emits our types.
4. **Importer** — orchestrates: auth → pick → clone → parse → materialize Y.Docs → persist ProjectRecord → open.

## Components

### 1. Frontier auth client (`src/lib/frontier/`)

- `auth.ts` — `login(username, password)` → persists `{jwt, gitlabToken, gitlabUrl, username}` in IndexedDB under key `frontier-session`.
- `api.ts` — `listGroups()`, `listProjects(groupId)`, thin typed wrappers around `fetch`. Throws `FrontierAuthError` on 401 so UI can re-prompt.
- Session persists across reloads; logout wipes it.

### 2. Git client (`src/lib/git/`)

- `opfs-fs.ts` — tiny shim exposing the `fs.promises` subset isomorphic-git needs (`readFile`, `writeFile`, `unlink`, `readdir`, `mkdir`, `rmdir`, `stat`, `lstat`, `readlink`, `symlink`), backed by an OPFS root directory handle. No symlinks in OPFS — `readlink`/`symlink` reject.
- `clone.ts` — `cloneRepo({url, auth, targetDir, onProgress})`:
  - Shallow: `depth: 1, singleBranch: true`.
  - Routes through our CORS proxy: `corsProxy: "https://git-proxy.ryderwishart.workers.dev"`.
  - Auth: `onAuth: () => ({ username: "oauth2", password: auth.gitlabToken })`.
  - Streams progress events to the UI.
- `permissions.ts` — `fetchRepoPermissions(projectId)` → queries GitLab for the user's access level on the project. Returns a `ProjectPermissions` object (see "Permission abstraction" below).

### 3. CORS proxy (`cors-proxy/` — new Cloudflare Worker)

- Forwards `GET/POST` to the target GitLab `/info/refs` and `/git-upload-pack` / `/git-receive-pack` endpoints.
- Allow-list: only `gitlab.frontierrnd.com` (exact host) and `frontierrnd.com` subdomains.
- Strips `Cookie`, forwards `Authorization`.
- Deployed alongside the signaling worker.

### 4. Codex-editor parser (`src/lib/codex-editor/`)

- `types.ts` — TypeScript interfaces copied from codex-editor (CustomNotebookCellData, CustomCellMetaData, EditHistory, ValidationEntry, CustomNotebookMetadata, NotebookCommentThread, NotebookComment).
- `parse-codex.ts` — `parseCodexFile(json)` → `{cells: CodexCell[], metadata}`.
- `parse-source.ts` — same for `.source` files.
- `parse-metadata.ts` — reads root `metadata.json`.
- `parse-comments.ts` — `.project/comments.json` → our `CommentThread[]`.
- `pair.ts` — given source and target cells sharing IDs, zip into `TranslatableString[]` (our type).
- `map-history.ts` — `EditHistory[]` → our `CellHistoryEntry[]` with `source: "human" | "llm"`, marking imported entries with `author: "git-import"` when the original author is empty.

### 5. Importer (`src/lib/importer/git-importer.ts`)

- `importRepo({projectId, cloneUrl, gitlabProjectId, auth, onProgress})`:
  1. Clone into `/repos/{projectId}/` (OPFS).
  2. Read `metadata.json` → derive project name/languages.
  3. Enumerate all `files/target/*.codex` → for each, read + parse + find paired source file under `.project/sourceTexts/`.
  4. For each pair, create a Y.Doc: populate cells Y.Array with TranslatableString entries (original from source, translated from target), feed edits into cell history Y.Map, attach video metadata to `meta` map.
  5. Parse `.project/comments.json` → populate each file's comments Y.Map keyed by cell id.
  6. Fetch repo permissions → store on ProjectRecord.
  7. Persist ProjectRecord; do NOT start y-websocket (Phase 4).
- All work inside `doc.transact()` per file; progress = files processed / total.

### 6. UI (`src/components/git-import/`)

- `GitImportDialog.tsx` — entry point from Project menu ("Import from git…").
  - If no session → `FrontierLoginForm`.
  - If session → `RepoPickerList` (groups → projects, with search).
  - On pick → `CloneProgress` (clone % + parse %).
  - On done → navigate into the project.
- `FrontierLoginForm.tsx` — username + password, submit → `login()`.
- `RepoPickerList.tsx` — virtualized list, shows name/last-updated.
- `CloneProgress.tsx` — bar + file-count.

## Data model additions

```ts
// src/lib/parsers/types.ts
interface ProjectRecord {
  // existing fields...
  origin?: ProjectOrigin;
  permissions?: ProjectPermissions;
}

interface ProjectOrigin {
  kind: "git";
  cloneUrl: string;
  gitlabProjectId: number;
  branch: string;
  headSha: string;   // commit we cloned
  importedAt: string;
}

// Permission abstraction — works for Phase 1 locks and later phases.
interface ProjectPermissions {
  source: "gitlab" | "local";
  canEditContent: boolean;     // cell edits
  canEditComments: boolean;    // comment add/reply
  canResolveComments: boolean;
  canPush: boolean;            // Phase 2+
  accessLevel?: number;        // GitLab numeric (10=guest, 20=reporter, 30=developer, 40=maintainer, 50=owner)
}
```

Phase 1 maps: access < 30 (developer) → `{canEditContent: false, canEditComments: true, canResolveComments: false, canPush: false}`; access ≥ 30 → all false (still locked, because push isn't implemented). Later phases flip `canEditContent` and `canPush` on.

All existing UI paths that mutate content (cell editing, history recording, rule edits) must consult `useProjectPermissions()` and disable the UI when `!canEditContent`.

## Storage layout

```
OPFS (per browser origin)
└── repos/
    └── {projectId}/
        ├── .git/
        ├── metadata.json
        ├── files/target/*.codex
        ├── .project/sourceTexts/*.source
        ├── .project/comments.json
        └── ...
```

IndexedDB (unchanged):
- `codex-projects` — ProjectRecord list.
- y-indexeddb DBs per file — Y.Doc state.
- `frontier-session` — auth state (new).

## Cell pairing algorithm

1. Build `Map<cellId, SourceCell>` from all source files.
2. Walk target cells in document order.
3. For each target cell:
   - Find `SourceCell` with same `metadata.id`.
   - `original` = source cell `value` (strip HTML); `originalHtml` = source cell `value` (raw).
   - `translated` = target cell `value`.
   - `context` = if cell has `metadata.data.startTime`/`endTime`, format as VTT range `HH:MM:SS.mmm --> HH:MM:SS.mmm`; else book/chapter/verse; else empty.
   - `group` = source filename (stable).
   - `type` = mapped from `CodexCellTypes` (text→"text", paratext→"paratext", others→"text").
4. Orphan target cells (no source match) → `original: ""`, still imported.
5. Orphan source cells (no target) → imported as untranslated.

## History migration

For each target cell's `edits[]`:
- Filter to `editMap[0] === "value"` entries (ignore metadata-only edits in Phase 1).
- Map:
  - `timestamp` → ISO string
  - `value` → translated value
  - `source: "human"` for `user-edit`, `"llm"` for `llm-edit`/`llm-generation`, else `"human"`
  - `author` → edit.author or `"git-import"`
  - `validated` → `edit.validatedBy?.some(v => !v.isDeleted) ?? false`
- Sorted ascending.

## Video attachment migration

Read `metadata.videoUrl`; if present, set our `meta` map:
- `videoUrl = metadata.videoUrl`
- `videoFileName = metadata.originalName`
- `videoStartOffset` = not in codex-editor schema → leave unset.

## Error handling

- Auth 401 → dialog shows "Session expired, please log in" and swaps to login form.
- Clone network error → retry prompt (no auto-retry).
- Parse error on a single file → skip that file, surface in final summary ("3 of 47 files could not be parsed"), don't abort whole import.
- OPFS quota exceeded → surface clearly with current usage estimate.

## Out of scope (Phase 2+)

- Writing back changes, pushing commits, conflict resolution.
- Pulling updates after initial clone.
- Git hooks, LFS, submodules, branch switching.
- Reading `.vscode/settings.json`, `complete_drafts.txt`, font files.
- Audio attachments.
- `milestone`/`style` cell types (treated as plain text).
- Granular per-cell permissions beyond the project-wide abstraction.

## Testing strategy

- **Unit tests** — parsers (given sample codex-editor JSON fixtures committed to `tests/fixtures/codex-editor/`, assert correct cell/history/comment output). Cell pairing. Permission mapping.
- **Integration test** — stand up a fake GitLab HTTP server in test, clone it via isomorphic-git + node fs, assert project materializes.
- **Manual test** — clone a real codex-editor project from Frontier GitLab, verify cells render, history drawer shows entries, comments appear, video plays if metadata has URL.

## Open risks

- **OPFS quota** — a codex-editor repo with many chapters + git history could exceed quota on mobile. Shallow clone mitigates; we'll surface usage.
- **CORS proxy trust** — we'll be forwarding auth tokens. Mitigate by locking the allow-list to frontierrnd hosts and logging nothing.
- **GitLab rate limits** — listing groups + projects for users with hundreds of repos. Paginate, cache in-memory during the session.
