# Codex Protocol V1

This document is the canonical data-model-and-protocol contract for Codex translation
projects. It is the shared ground truth that both the native VS Code extension
(`codex-editor`) and the web app (`codex-web`) must conform to so that a single
project on disk — in a single git repository — can be opened, edited, and committed
by either client without drift.

Citations of the form `[file:L123]` point at the exact lines in the sources listed
in the "Why this matters" section of the task that generated this doc. The two
canonical sources are:

- **codex-editor repo** — sparse checkout at `/tmp/codex-recon/codex-editor/`
- **NaturalEnglish project** — a real scripture translation project on disk at
  `~/.codex-projects/NaturalEnglish-ulq0tlakw4cbqkf5sceg/`

Sections 1–9 and 11 document what the native client already does; section 10 is
explicitly marked **Design Proposal** — it covers the Yjs ↔ git reconciliation
rules that do not exist anywhere in code yet. Section 12 collects what is
unresolved.

---

## 1. Executive Summary

Codex is a cell-based translation notebook. A project is:

- One git repository.
- A Scripture Burrito–compliant `metadata.json` at the root.
- Per-book (or per-document) **`.codex` notebook files** under `files/target/`,
  each holding an ordered array of **cells** with `{value, metadata}`.
- Parallel **`.source` files** under `.project/sourceTexts/`, read-only.
- A `.project/` directory for derived indexes, comments, fonts, and local
  user-specific state.

Two clients edit the same files:

```
            ┌────────────────────────────────────┐
            │   GitLab (or any git remote)       │
            │     main branch = source of truth  │
            └───────┬────────────────────┬───────┘
                    │ git push/pull      │ git push/pull
                    ▼                    ▼
       ┌────────────────────┐   ┌────────────────────┐
       │ codex-editor       │   │ codex-web (PWA)    │
       │ (VS Code ext)      │   │                    │
       │                    │   │ y-webrtc session   │
       │ CodexCellDocument  │   │ ┌─ peer ─ peer ─┐  │
       │  → file JSON       │   │ │ Y.Doc per file │  │
       │  → metadata.edits  │   │ │ translatedXml  │  │
       │  → SQLite index    │   │ │ (CRDT)         │  │
       └─────────┬──────────┘   │ └────────────────┘ │
                 │              │   flush on save    │
                 └──────┬───────┴──────┬─────────────┘
                        │              │
                        ▼              ▼
                        git commit + push
                        (.codex JSON + metadata.edits)
```

The web app uses **Yjs** for live multi-user collaboration inside a session; the
*serialized* output of that session is a normal `.codex` file that commits to
git, exactly like the native client produces. The edits-log inside each
`.codex` cell is the durable, auditable, portable history; the Y.Doc is an
ephemeral working copy that is discarded on project load and rebuilt from the
latest committed `.codex` content.

---

## 2. Scripture Burrito Compliance

The top-level discriminator for a Codex project is:

```json
"format": "scripture burrito"
```

`[NaturalEnglish/metadata.json:L2]`

Scripture Burrito is a metadata spec for scripture projects maintained at
[docs.burrito.bible](https://docs.burrito.bible). Codex extends the Burrito
schema with Codex-specific fields; everything a Burrito-aware tool expects to
find (`meta`, `idAuthorities`, `identification`, `languages`, `type.flavorType`,
`confidential`, `agencies`, `targetAreas`, `localizedNames`, `ingredients`,
`copyright`) is present in the real project file
`[NaturalEnglish/metadata.json:L1-L133]`.

**Codex-specific extensions** layered on top:

- `projectName`, `projectId` — top-level convenience fields, also mirrored in
  `meta.abbreviation` in some places `[NaturalEnglish/metadata.json:L3-L4]`.
- `meta.generator` — `{ softwareName, softwareVersion, userName, userEmail }`
  identifies the writing client `[NaturalEnglish/metadata.json:L8-L13]`.
- `meta.requiredExtensions` — version gate for VS Code extensions required to
  open the project safely (see §11) `[NaturalEnglish/metadata.json:L18-L21]`.
- `meta.validationCount`, `meta.validationCountAudio` — how many distinct
  validators a cell must accumulate before it counts as fully validated
  `[NaturalEnglish/metadata.json:L22-L23]`.
- `edits[]` — a project-level append-only event log (see §3)
  `[NaturalEnglish/metadata.json:L134-L240]`.
- `spellcheckIsEnabled`, `chatSystemMessage` — project-wide UI settings
  `[NaturalEnglish/metadata.json:L241-L242]`.

**What the web app must preserve to stay compliant:**

- Never drop an unknown Burrito field; round-trip any fields the web app
  does not read.
- Never rewrite `projectId` once assigned.
- Preserve `edits[]` on read; always append, never rewrite history.
- Respect `languages[].projectStatus` — exactly one `"source"` and one
  `"target"` language, per the real project
  `[NaturalEnglish/metadata.json:L28-L45]`.

---

## 3. `metadata.json` Schema

The authoritative TypeScript definition is `ProjectMetadata`
`[codex-editor/types/index.d.ts:L992-L1115]`. Field-by-field, grounded in the
real NaturalEnglish file:

### Top-level fields

| Field | Type | Example | Notes |
|---|---|---|---|
| `format` | string | `"scripture burrito"` | Always this literal. `[types/index.d.ts:L995]` |
| `projectName` | string | `"NaturalEnglish"` | Human-readable. `[metadata.json:L3]` |
| `projectId` | string | `"ulq0tlakw4cbqkf5sceg"` | Immutable. Also encoded in the on-disk folder name. |
| `originalFilesHashes` | object? | omitted in sample | Registry of imported originals by SHA hash. `[types/index.d.ts:L997-L1001]` |
| `edits[]` | array | see §3 | Project-level event log. `[types/index.d.ts:L1002]` |
| `users[]` | array? | omitted | Per-user editor-version tracking. `[types/index.d.ts:L1003-L1004]` |

### `meta` object

Citations: `[types/index.d.ts:L1005-L1034]`, `[metadata.json:L5-L25]`.

```json
"meta": {
    "version": "0.0.0",
    "category": "Translation",
    "generator": {
        "softwareName": "Codex Editor",
        "softwareVersion": "0.18.0",
        "userName": "",
        "userEmail": ""
    },
    "defaultLocale": "en",
    "dateCreated": "Fri Feb 06 2026",
    "normalization": "NFC",
    "comments": [],
    "requiredExtensions": {
        "codexEditor": "0.22.0",
        "frontierAuthentication": "0.4.24"
    },
    "validationCount": 1,
    "validationCountAudio": 1,
    "abbreviation": ""
}
```

- `meta.requiredExtensions` is the compatibility handshake (see §11).
- `meta.validationCount` gates when a cell is considered "validated" for
  export/health — if set to N, each cell needs N distinct `ValidationEntry`
  records in its latest `value` edit before it counts as fully validated.
  `[codex-editor/docs/validation.md:L37, L99-L107]`
- `meta.pinnedExtensions` and `meta.initiateRemoteUpdatingFor` are used to
  force peers onto a specific extension version; the web app should treat
  these as read-only hints today. `[types/index.d.ts:L1024-L1030]`

### `languages[]`

```json
"languages": [
    { "name": { "en": "AncientGreek(to1453)" }, "tag": "grc",
      "refName": "AncientGreek(to1453)", "projectStatus": "source" },
    { "name": { "en": "English" }, "tag": "eng",
      "refName": "English", "projectStatus": "target" }
]
```

`[metadata.json:L28-L45]`. `projectStatus` is exactly one of `"source"` or
`"target"`.

### `type.flavorType.currentScope`

A book-code map that enumerates which Bible books exist in the project.
`[metadata.json:L56-L124]`. Empty array per book because there is no
per-book chapter/verse restriction in this project. Used by the navigation
webview to populate the book list.

### `edits[]` — project event log

Shape: `ProjectEditHistory` `[types/index.d.ts:L694-L700]`:

```typescript
{
    editMap: readonly string[],     // JSON-pointer-style path
    value: <inferred from editMap>, // new value written
    timestamp: number,              // ms since epoch
    type: EditType,                 // see enums.ts
    author: string                  // username
}
```

Real example from `[metadata.json:L135-L144]`:

```json
{
    "editMap": ["meta", "validationCount"],
    "value": 1,
    "timestamp": 1770414090196,
    "type": "user-edit",
    "author": "daniel"
}
```

Semantics:

- **Append-only.** No entry is ever rewritten or deleted.
- Every mutation to `metadata.json` by the native client produces one entry
  per field touched.
- Replaying `edits[]` in order from the initial empty project must yield the
  current `metadata.json` (modulo fields marked non-persisting).
- `EditType` values: `user-edit`, `llm-edit`, `llm-generation`,
  `initial-import`, `merge`, `migration`.
  `[codex-editor/types/enums.ts:L1-L8]`

---

## 4. `.codex` Notebook Schema

A `.codex` file is JSON with the shape:

```typescript
{
    cells: CustomNotebookCellData[],
    metadata: CustomNotebookMetadata
}
```

`[codex-editor/types/index.d.ts:L832-L837]` (`CodexNotebookAsJSONData`).

### File-level `metadata`

From the end of `JHN.codex`
`[NaturalEnglish/files/target/JHN.codex:L375-L390]`:

```json
"metadata": {
    "textDirection": "ltr",
    "videoUrl": "",
    "lineNumbersEnabled": true,
    "lineNumbersEnabledSource": "global",
    "edits": [],
    "id": "Greek 3 John",
    "originalName": "3 John.macula",
    "sourceFsPath": "/…/.project/sourceTexts/JHN.source",
    "codexFsPath": "/…/files/target/JHN.codex",
    "navigation": [],
    "sourceCreatedAt": "2026-02-06T21:43:36.954Z",
    "corpusMarker": "Greek Bible",
    "fileDisplayName": "Greek 3 John",
    "importerType": "macula"
}
```

Full field definition in `CustomNotebookMetadata`
`[codex-editor/types/index.d.ts:L756-L826]`. Notable fields:

- `id` — file-level identifier. Stable across renames.
- `sourceFsPath`, `codexFsPath` — **absolute paths written at import time**.
  These are machine-specific and must be ignored or rewritten by the web app
  on load (see §12 Open Questions).
- `originalName` — the imported artifact's filename (e.g. `3 John.macula`).
- `importerType` — enumerated in
  `[codex-editor/types/index.d.ts:L839-L860]`: `smart-segmenter`, `plaintext`,
  `audio`, `docx`, `markdown`, `subtitles`, `spreadsheet`,
  `spreadsheet-csv`, `spreadsheet-tsv`, `tms`, `pdf`, `indesign`,
  `usfm`, `usfm-experimental`, `paratext`, `ebible`, `ebibleCorpus`,
  `macula`, `biblica`, `reach4life`, `obs`.
- `corpusMarker`, `fileDisplayName` — UI hints.
- `navigation[]` — nested table-of-contents used by the webview navigator.
- `edits[]` — file-level edits log (`FileEditHistory`), same shape as the
  project-level log. `[codex-editor/types/index.d.ts:L685-L691]`
- `structureMetadata` — USFM round-trip: `originalUsfmContent` plus
  line-to-cell mappings so export can reconstruct USFM byte-for-byte.
  `[codex-editor/types/index.d.ts:L813-L816]`

### Cell shape

Type: `CustomNotebookCellData`
`[codex-editor/types/index.d.ts:L752-L754]`, extending `vscode.NotebookCellData`:

```typescript
{
    kind: vscode.NotebookCellKind, // 1 = Markup, 2 = Code
    value: string,                  // HTML content of the target translation
    languageId: string,             // always "html" in practice
    metadata: CustomCellMetaData
}
```

`vscode.NotebookCellKind` is a built-in enum: `1 = Markup`, `2 = Code`. Every
cell in the real file uses `kind: 2`
`[NaturalEnglish/files/target/JHN.codex:L4, L15, L39, …]`. Codex does not meaningfully
use `kind = 1`; the distinction is vestigial from the VS Code notebook API.

### Cell `metadata`

Type: `CustomCellMetaData` `[codex-editor/types/index.d.ts:L733-L750]`,
extending `BaseCustomCellMetaData` `[L717-L727]`:

```typescript
{
    id: string,                  // UUID v4
    type: CodexCellTypes,        // "text" | "paratext" | "style" | "milestone"
    edits: EditHistory[],        // per-cell event log
    parentId?: string,           // UUID of parent cell (cue/paratext)
    isLocked?: boolean,
    sourceSpan?: { start, end }, // Markdown/OBS UTF-16 offsets
    data?: CodexData,            // extensible payload
    attachments?: { [key]: { url, type, createdAt, … } },
    cellLabel?: string,          // display label
    selectedAudioId?: string,    // picks among attachments
    selectionTimestamp?: number
}
```

`CodexCellTypes` enum: `TEXT = "text"`, `PARATEXT = "paratext"`,
`STYLE = "style"`, `MILESTONE = "milestone"`
`[codex-editor/types/enums.ts:L10-L15]`.

Real example of a `type: "milestone"` cell
`[NaturalEnglish/files/target/JHN.codex:L3-L13]`:

```json
{
    "kind": 2,
    "value": "3 John 1",
    "languageId": "html",
    "metadata": {
        "id": "cbb79fae-ed84-4d28-b5fd-49e6b9ac5ae4",
        "type": "milestone",
        "edits": [],
        "data": {}
    }
}
```

Real example of a `type: "text"` cell (verse)
`[NaturalEnglish/files/target/JHN.codex:L14-L37]`:

```json
{
    "kind": 2,
    "value": "",
    "languageId": "html",
    "metadata": {
        "id": "0ce3a317-0d5e-49b3-af3c-9225ac6dadbe",
        "type": "text",
        "edits": [],
        "vref": "3JN 1:1",
        "bookCode": "3JN",
        "chapter": 1,
        "verse": "1",
        "cellLabel": "1",
        "originalText": "Ὁ πρεσβύτερος Γαΐῳ τῷ ἀγαπητῷ, ὃν ἐγὼ ἀγαπῶ ἐν ἀληθείᾳ.",
        "fileName": "3JN.macula",
        "chapterNumber": "1",
        "data": {
            "originalText": "Ὁ πρεσβύτερος Γαΐῳ τῷ ἀγαπητῷ, …",
            "globalReferences": ["3JN 1:1"]
        }
    }
}
```

Fields like `vref`, `bookCode`, `chapter`, `verse`, `cellLabel`,
`originalText`, `fileName`, `chapterNumber` are not explicitly declared in
`BaseCustomCellMetaData` — they appear to be importer-emitted top-level
extensions on the cell metadata object. The canonical location for
extensibility is `metadata.data` (`CodexData`
`[codex-editor/types/index.d.ts:L704-L715]`):

```typescript
type CodexData = Timestamps & {
    footnotes?: Footnote[],
    book?: string,
    chapter?: string,
    verse?: string,
    merged?: boolean,
    deleted?: boolean,
    originalText?: string,
    globalReferences?: string[],
    milestoneIndex?: number | null
}
```

**Unclear — needs confirmation:** the overlap between the cell-level `vref` /
`bookCode` / etc. and the `metadata.data.originalText` /
`globalReferences` mirror is duplication in the current on-disk format. The
web app should treat `metadata.data` as canonical and the top-level
duplicates as legacy read-only.

### Milestones

Cells with `type: "milestone"` delimit sections — typically chapter headings
for scripture. The navigation webview uses them as the primary pagination
unit. `MilestoneInfo` / `MilestoneIndex` live at
`[codex-editor/types/index.d.ts:L902-L931]`. `metadata.data.milestoneIndex`
on a content cell points back to its enclosing milestone for O(1) lookup.

### `.codex` ↔ `.source` pairing

For each `files/target/BOOK.codex` there is a
`.project/sourceTexts/BOOK.source` with the same basename. Both directories
in the real project contain exactly 63 books
`[ls /Users/daniellosey/.codex-projects/…/files/target/]`. Cells are paired
**by cell ID** — a target cell and source cell with the same UUID represent
the same verse. The native client resolves this via `getCorrespondingSourceUri`
(basename pairing).

---

## 5. `.project/` Directory Contents

Observed contents of the real project
`[ls /Users/daniellosey/.codex-projects/NaturalEnglish-.../.project/]`:

```
.project/
├── comments.json                 # threaded comments (git-tracked)
├── complete_drafts.txt           # local-only, auto-generated
├── fonts/                        # git-tracked target-language font files
├── indexes.sqlite                # FTS index (local-only, derived)
├── indexes.sqlite-shm            # SQLite shared-memory (local-only)
├── indexes.sqlite-wal            # SQLite write-ahead log (local-only)
├── localProjectSettings.json     # per-user UI state (local-only)
└── sourceTexts/                  # .source files (git-tracked)
```

`.gitignore` rules
`[NaturalEnglish/.gitignore:L1-L52]`:

```
.project/*.sqlite
.project/*.sqlite-wal
.project/*.sqlite-shm
.project/.temp/**
.project/complete_drafts.txt
.project/localProjectSettings.json
.project/localProjectSwap.json
copilot-messages.log
```

Plus archive/executable/image blobs and `.DS_Store`. Audio, video, and large
images are routed through git-LFS per
`[NaturalEnglish/.gitattributes:L1-L17]`:

```
*.wav filter=lfs diff=lfs merge=lfs -text
*.mp3 filter=lfs diff=lfs merge=lfs -text
*.m4a filter=lfs diff=lfs merge=lfs -text
*.ogg filter=lfs diff=lfs merge=lfs -text
*.webm filter=lfs diff=lfs merge=lfs -text
*.mp4 filter=lfs diff=lfs merge=lfs -text
*.avi filter=lfs diff=lfs merge=lfs -text
*.mov filter=lfs diff=lfs merge=lfs -text
*.mkv filter=lfs diff=lfs merge=lfs -text
*.jpg filter=lfs diff=lfs merge=lfs -text
*.jpeg filter=lfs diff=lfs merge=lfs -text
*.png filter=lfs diff=lfs merge=lfs -text
```

### Canonical vs derived vs local-only

| Path | Status | Rebuild source |
|---|---|---|
| `metadata.json` | canonical, tracked | — |
| `files/target/*.codex` | canonical, tracked | — |
| `.project/sourceTexts/*.source` | canonical, tracked | — |
| `.project/comments.json` | canonical, tracked | — |
| `.project/fonts/**` | canonical, tracked | — |
| `.project/indexes.sqlite*` | derived, local-only | rebuilt from cells on load |
| `.project/localProjectSettings.json` | local-only user state | — |
| `.project/complete_drafts.txt` | derived, local-only | rebuilt from cell state |
| `.project/attachments/originals/` | tracked unless archive format | originals of imported DOCX/PPTX etc. `[docs/structure-preservation.md:L72-L86]` |

### `comments.json` shape

Real sample `[NaturalEnglish/.project/comments.json:L1-L39]`:

```json
[{
    "id": "6fcb8770-d56d-402c-8605-d55ffbc4b4fb",
    "canReply": true,
    "cellId": {
        "cellId": "0e1df0c6-df90-449a-923c-3182c2c8ad72",
        "uri": ".project/sourceTexts/MAT.source",
        "globalReferences": ["MAT 1:1"]
    },
    "collapsibleState": 0,
    "threadTitle": "2/9/2026, 3:39:20 PM",
    "deletionEvent": [],
    "resolvedEvent": [],
    "comments": [
        { "id": "1770673160858-1ga3onsr1",
          "timestamp": 1770673160858,
          "body": "something",
          "mode": 1,
          "author": { "name": "daniel" },
          "deleted": false }
    ]
}]
```

Type: `NotebookCommentThread[]` `[codex-editor/types/index.d.ts:L15-L47]`.

### `localProjectSettings.json` shape

Real sample `[NaturalEnglish/.project/localProjectSettings.json:L1-L10]`:

```json
{
    "currentMediaFilesStrategy": "auto-download",
    "lastMediaFileStrategyRun": "auto-download",
    "mediaFileStrategyApplyState": "applied",
    "mediaFileStrategySwitchStarted": false,
    "autoDownloadAudioOnOpen": false,
    "autoSyncEnabled": true,
    "syncDelayMinutes": 5,
    "displayedProjectName": "NaturalEnglish-ulq0tlakw4cbqkf5sceg"
}
```

This file is git-ignored — the web app must write its own equivalent to
IndexedDB and never commit it.

---

## 6. Git Workflow

### Tracked vs ignored vs LFS

Summarized in §5. Key rules:

- **Everything under `files/target/` is tracked.** These are the
  translations. They are JSON and always merge-conflict-prone.
- **Source texts are tracked** under `.project/sourceTexts/`.
- **Indexes, logs, and per-user settings are ignored.**
- **Media is LFS** (audio, video, images).

### Commit cadence (native)

The native client auto-commits on a configurable interval. From
`[codex-editor/src/projectManager/syncManager.ts:L849-L876]`:

```typescript
const { autoSyncEnabled, syncDelayMinutes } = await getSyncSettings();
// …
const delayMs = syncDelayMinutes * 60 * 1000;
// Schedules pendingSyncTimeout; when it fires:
this.executeSync(commitMessage, true, undefined, false);
```

Default from the real project is `syncDelayMinutes: 5`
`[NaturalEnglish/.project/localProjectSettings.json:L8]`.

The sync operation calls `stageAndCommitAllAndSync` which stages all tracked
changes, commits with a default message of `"Auto-sync changes"`
`[syncManager.ts:L824, L1208]`, then pushes if a remote is configured
`[syncManager.ts:L915-L932]`. A project with no remote skips sync entirely.

If a sync is already in progress, further changes are tracked in
`pendingChanges[]` and coalesced into a single deferred sync, using the
latest commit message or the literal `"changes to N files"`
`[syncManager.ts:L1387-L1433]`.

### Branch strategy

**Unclear — needs confirmation.** No explicit branch management is visible
in `syncManager.ts`; the code works off whatever branch is currently checked
out. Practical assumption for the contract: **main only, push/pull against
origin/main**. Per-translator branches are not a current pattern and would
require extension changes to support.

### Merge strategy

Codex has a documented merge strategy per file category
`[codex-editor/docs/merge-strategy.md:L1-L108]`:

| Path | Strategy |
|---|---|
| `files/target/*.codex` | **Cell-array merge.** Parse both sides as JSON. For each cell at the same index: if content matches, keep one copy; if content differs, *duplicate* the cell and keep both, preserving cell IDs. Merge is presented in the editor for manual resolution. `[merge-strategy.md:L7-L18, L41-L52]` |
| `metadata.json` | **Timestamp override** — keep newest. `[merge-strategy.md:L20-L24]` |
| `.project/comments.json` | **Array union** — dedupe by thread ID and comment content. `[merge-strategy.md:L27-L34]` |
| `.project/sourceTexts/*.source` | **Timestamp override** — conflicts unlikely (read-only). `[merge-strategy.md:L36-L39]` |
| `complete_drafts.txt` | ignored (auto-generated) `[merge-strategy.md:L54]` |

The `MergeConflict` interface is defined at `[merge-strategy.md:L60-L71]`:

```typescript
interface MergeConflict {
    path: string;
    type: "codex" | "override" | "array" | "special" | "source";
    head: string;
    origin: string;
    timestamp: { head: Date; origin: Date };
}
```

**Important:** for `.codex` files the merge driver *duplicates* conflicting
cells instead of losing either side, then shows the user a conflict-view so
they can pick or merge the duplicate. This is non-standard git behavior and
requires the web app to implement the same merge semantics (or call a shared
library) if it is going to participate in pulls.

### Authentication

The native client pushes to GitLab via a Frontier auth extension
(`frontierAuthentication` declared in `meta.requiredExtensions`
`[metadata.json:L20]`). The exact auth mechanism (PAT vs token exchange) is
in the Frontier server code — **unclear from `codex-editor` alone; needs
confirmation**. For the web app, the plan is OAuth against GitLab with a
short-lived token stored in IndexedDB.

---

## 7. Validation / Milestone State Machine

Full spec: `[codex-editor/docs/validation.md:L1-L150]`.

### States

A cell's validation state is *not* a single enum — it is derived from the
`validatedBy: ValidationEntry[]` array on the cell's latest `value` edit.

```typescript
interface ValidationEntry {
    username: string;
    creationTimestamp: number;
    updatedTimestamp: number;
    isDeleted: boolean;
}
```

`[codex-editor/types/index.d.ts:L618-L623]`.

Derived states for the UI:

- **Empty** — `value` is empty.
- **Unvalidated** — has content, `validatedBy` has zero entries with
  `isDeleted=false`.
- **Partially validated** — 1 ≤ non-deleted entries < `meta.validationCount`.
- **Fully validated** — non-deleted entries ≥ `meta.validationCount`.

### Who can validate

Any user with edit access. Validation is a normal change event:

1. User clicks the validate icon in the cell editor
   (`ValidationButton.tsx`).
2. Webview posts `{ command: "validateCell", content: { cellId, validate } }`
   `[validation.md:L28-L30]`.
3. Provider calls `document.validateCellContent(cellId, validate)`
   `[validation.md:L52]`.
4. Document locates the `EditHistory` entry matching the current `value`,
   creates it if missing, and adds/updates a `ValidationEntry` for the
   current user under `latestEdit.validatedBy`
   `[validation.md:L71-L74]`.
5. Document marks itself dirty and emits a change event
   `[validation.md:L74]`.
6. Provider broadcasts `providerUpdatesValidationState`
   `[validation.md:L55-L57]`.

### Validation anchoring

The edit that gets a new `ValidationEntry` is the one whose `value` matches
the current cell value — not the last edit blindly. If no such edit exists,
a `USER_EDIT` entry matching the current value is injected to anchor the
validation `[validation.md:L71-L73]`. This makes it possible to detect and
invalidate validations whose anchor text no longer matches the cell.

### Audio validation

Parallel track: `validateCellAudio` writes a `ValidationEntry` onto the
relevant attachment's `validatedBy` array rather than onto a cell edit
`[validation.md:L76-L79]`. Audio and text are counted separately
(`meta.validationCountAudio` gates audio).

### What fully-validated means

- Export: fully-validated cells are the ones fed into TMX/XLIFF/round-trip
  exporters.
- Health (§ in `codex-web`): validated cells contribute to the "validated
  fraction" of the health ring.
- Analytics: the native client's progress rollup reports
  `percentFullyValidatedTranslations`
  `[codex-editor/types/index.d.ts:L924-L929]`.

---

## 8. Structure Preservation & Export

Full spec: `[codex-editor/docs/structure-preservation.md:L1-L227]`. Key
rules the web app must follow:

### Lossless round-trip

Every importer that operates on a structured source format (DOCX, PPTX,
USFM, OBS Markdown, etc.) writes enough metadata to rebuild the original
byte-for-byte. The canonical location for that metadata:

- `notebookMetadata.structureMetadata` for USFM —
  `{ originalUsfmContent, lineMappings }`
  `[types/index.d.ts:L813-L816]`.
- `notebookMetadata.importContext` with `originalHash`, `fileSize`, and
  `importTimestamp` `[types/index.d.ts:L886-L896]`.
- `.project/attachments/originals/<filename>` holds the raw imported file
  `[structure-preservation.md:L74-L85]`.
- Per-cell `metadata.sourceSpan: { start, end }` for Markdown/OBS round-trip
  `[types/index.d.ts:L722-L726]`, and per-cell `metadata.data.originalText`
  / `originalContent` / `originalOffset`
  `[structure-preservation.md:L44-L59]`.

### USFM book splitting

USFM imports are split into one `.codex` per book, matching the canonical
3-letter book codes in `type.flavorType.currentScope`. The native client
calls `splitSourceFileByBook` from `codexNotebookUtils`
`[codex-editor/src/projectManager/projectInitializers.ts:L8-L11]`.

### What gets dropped vs preserved

Preserved: paragraph structure, inline marks via the ProseMirror subset
(bold/italic/underline/strike/code), hard breaks, footnotes
(`CodexData.footnotes`), non-translatable surrounding prose via
`SourceLocation`.

Dropped: heavy formatting outside the supported inline-marks set, comments
embedded in DOCX, drawing objects. The web app's
M9 design doc is explicit:
"No headings, lists, blockquotes, images, tables, links, or any other node
types" `[codex-web/docs/superpowers/specs/2026-04-14-…milestone9-richtext-design.md:L20]`.

### Web app alignment

The web app's surgical-export pipeline (`src/lib/export/surgical-export.ts`)
follows the same pattern: parsers record `SourceLocation`, rebuilders walk
the cells in order and substitute translations at the recorded positions.
For USFM the web app must emit a `structureMetadata` equivalent or call the
native `.codex` file's `structureMetadata` on round-trip.

---

## 9. Host ↔ Webview Message Protocol

The VS Code extension splits the app across a Node "provider" and a
browser-side React webview, communicating by `postMessage` typed at
`[codex-editor/types/index.d.ts:L361-L611]` (webview→provider) and
`[L1836-L2014]` (provider→webview). The web app will not use the same
transport (there is no VS Code webview), but the *shapes* of these messages
are the closest thing Codex has to an API spec. They should be the reference
for any future client↔server API.

### Webview → Provider (selection from `EditorPostMessages`)

| Command | Content | Purpose | Line |
|---|---|---|---|
| `webviewReady` | — | Webview bootstrapped | L364 |
| `getContent` | — | Ask for initial content dump | L365 |
| `saveHtml` | `{ cellId, cellContent, uri? }` via `EditorCellContent` | Persist edited cell HTML | L422 |
| `llmCompletion` | `{ currentLineId, addContentToValue? }` | Request AI completion | L430 |
| `validateCell` | `{ cellId, validate }` | Toggle text validation | L397 |
| `validateAudioCell` | `{ cellId, validate }` | Toggle audio validation | L398 |
| `queueValidation` | `{ cellId, validate, pending }` | Batch-validate | L400-L402 |
| `updateCellLabel` | `{ cellId, cellLabel }` | Rename a cell | L382 |
| `updateCellIsLocked` | `{ cellId, isLocked }` | Lock/unlock | L383 |
| `updateNotebookMetadata` | `CustomNotebookMetadata` | Write file-level metadata | L385 |
| `makeChildOfCell` | `{ newCellId, referenceCellId, direction, cellType, data }` | Insert a child cell | L412-L421 |
| `deleteCell` | `{ cellId }` | Soft-delete | L390 |
| `generateBacktranslation` | `{ text, cellId }` | LLM back-translate | L440 |
| `requestAutocompleteChapter` | `QuillCellContent[]` | Bulk LLM fill | L431 |

### Provider → Webview (selection from `EditorReceiveMessages`)

| Type | Content | Purpose | Line |
|---|---|---|---|
| `providerSendsInitialContent` | `QuillCellContent[]` + `sourceCellMap` + user info | Bootstrap UI | L1847-L1856 |
| `providerSendsInitialContentPaginated` | Above + `milestoneIndex` + `rev` | Paginated bootstrap | L1858-L1875 |
| `saveHtmlSaved` | `{ requestId, cellId, success, error? }` | Save ack | L1838-L1845 |
| `providerUpdatesValidationState` | `{ cellId, validatedBy }` | Validation changed | per validation.md |
| `cellTranslationCompleted` | `{ cellId, success, cancelled?, error? }` | LLM done | L1947-L1952 |
| `providerSendsLLMCompletionResponse` | `{ completion, cellId }` | LLM result | L1999 |
| `providerSendsSourceText` | string | Source for a cell | L2029 |
| `providerSendsBacktranslation` | `SavedBacktranslation \| null` | Back-translation | L2030-L2033 |

### The save cycle

`saveHtml` is the primary write path. Semantics from
`[codex-editor/src/providers/codexCellEditorProvider/codexCellEditorMessagehandling.ts:L701-L782]`:

1. Webview posts `{ command: "saveHtml", requestId, content: { cellId, cellContent } }`.
2. Provider reads previous cell value via `document.getCellContent(cellId)`.
3. If `oldContent.metadata.isLocked` → reply with `success: false`.
4. Provider calls `document.updateCellContent(cellId, finalContent, EditType.USER_EDIT)`
   which pushes a new entry onto `cell.metadata.edits[]`
   `[codex-editor/src/providers/codexCellEditorProvider/codexDocument.ts:L463-L471]`.
5. Provider calls `saveCustomDocument(document, …)` to flush to disk.
6. Provider posts `{ type: "saveHtmlSaved", content: { requestId, cellId, success: true } }`.

Any client speaking to a future codex server must ack with a `requestId`
match so the UI can clear its per-cell pending indicator — this is the
direct analogue of the web app's M10 flush completion signal.

---

## 10. Yjs ↔ Edits-Log Reconciliation (Design Proposal)

**Status: design. None of this is implemented.**

This section defines how the web app's live Yjs collaboration session
reconciles with the git-committed `.codex` files that the native client
consumes. It is the only novel part of this doc.

### Design constraints

1. The *durable* history is `cell.metadata.edits[]`. It is portable across
   clients, auditable, and already consumed by the native client.
2. The *live* state during a web session is the Y.Doc held in
   `codex:file:<fileId>` IndexedDB and synced peer-to-peer over WebRTC
   `[codex-web/src/lib/store/file-doc.ts:L57]`.
3. A Y.Doc is never committed to git. Git only ever sees serialized
   `.codex` JSON.
4. The native client already knows how to read `.codex` files produced by
   another native client. It must also read `.codex` files produced by a
   *web flush* with zero changes to its own code.

### Flush lifecycle

A **flush** is the event that converts the current Y.Doc state into a
`.codex` file on disk plus appended `edits[]` entries.

```
Yjs live session (Y.Doc per file)
         │
         │ user edits translatedXml (Y.XmlFragment)
         │ → y-prosemirror CRDT ops
         │ → awareness presence
         │
         │  [ FLUSH trigger: periodic timer (30 s),
         │                  explicit save,
         │                  validation action,
         │                  tab/page unload,
         │                  peer handoff ]
         │
         ▼
   serialize each dirty cell:
     value        ← getPlainText(frag)   or getFragmentHtml(frag)
     originalHtml ← unchanged
   for each dirty cell, append one edit:
     { editMap: ["value"], value: <newHtml>,
       timestamp: Date.now(), type: "user-edit" | "llm-edit",
       author: <username>,
       validatedBy: [ … if auto-validate applies … ] }
   write .codex JSON to repository working tree
   git add files/target/<book>.codex metadata.json
   git commit -m "codex-web: <N> cells in <book> by <author>"
   git push (best-effort; retried on reconnect)
```

### Flush commit shape

Proposed conventional commit format:

```
codex-web: <verb> <N> cell(s) in <book>[, …] by <author>

<one line per changed cell>
```

Example:

```
codex-web: update 3 cells in JHN by daniel

- JHN 1:1 (0ce3a317) edited
- JHN 1:2 (5cb7bfbe) edited + validated
- JHN 1:3 (83c70ef2) validated
```

Rationale: grep-friendly, carries enough signal for `git log --grep` to
identify web-originated commits, distinguishable from the native client's
`"Auto-sync changes"` default `[syncManager.ts:L824]`.

### `edits[]` entry emitted by a flush

```json
{
    "editMap": ["value"],
    "value": "<p>In the beginning was the Word…</p>",
    "timestamp": 1770673160858,
    "type": "user-edit",
    "author": "daniel",
    "validatedBy": [
        {
            "username": "daniel",
            "creationTimestamp": 1770673160858,
            "updatedTimestamp": 1770673160858,
            "isDeleted": false
        }
    ]
}
```

One `edits[]` entry per cell per flush. If a cell changed three times
inside a Yjs session before the flush, the flush writes **one** entry
carrying the final value. Intermediate Yjs ops are lost (they were
ephemeral). This matches how the native client's `updateCellContent`
coalesces rapid edits before hitting disk
`[codex-editor/src/providers/codexCellEditorProvider/codexDocument.ts:L463-L471]`.

Non-negotiable: the `type` value must be one of the enum values from
`[codex-editor/types/enums.ts:L1-L8]` — `user-edit`, `llm-edit`,
`llm-generation`, `initial-import`, `merge`, `migration`. No new types.

### Project load bootstrap

On project open:

1. Web app clones (or pulls) the repository into OPFS.
2. For each `files/target/*.codex`, read JSON.
3. Build a fresh Y.Doc for each file (`createFileDoc`
   `[codex-web/src/lib/store/file-doc.ts:L18-L59]`).
4. Seed each cell's `translatedXml` from the `.codex` cell's `value` via
   `setPlainText(frag, value)` or `setFragmentFromHtml(frag, value)`
   `[codex-web/src/lib/richtext/translated-xml.ts:L44-L73, L152-L162]`.
5. **Do not replay `edits[]`.** The log is archival. The latest committed
   `value` is the source of truth.
6. Persist Y.Doc to `codex:file:<fileId>` IndexedDB for the duration of
   the session.

### Concurrent web sessions

Two web clients editing the same file CRDT-merge in real time over
`y-webrtc` — that is already implemented
`[codex-web/src/lib/sync/webrtc-provider.ts]`. Only *one* of them needs to
flush; the others observe via awareness and should suppress their own
flushes to avoid commit storms. Proposed rule: **flush leadership is the
peer that made the most recent edit; others defer their periodic flush
timer by +60 s on every remote update**.

Two flushes from different peers landing on git at the same time produce a
standard git merge conflict on the `.codex` file. The cell-array merge
strategy from `[codex-editor/docs/merge-strategy.md:L41-L52]` resolves it:
same cell ID with differing `value` → duplicate the cell, present both to
the user. This is acceptable but rare (both peers must flush inside the
same git push window).

### Native + web editing the same project

Scenario A: **web flushes while native has clean working tree.** Native's
`syncManager` pulls on its next cycle, applies the change, rebuilds
indexes `[syncManager.ts:L1437-L1450]`. The native document model
re-reads the `.codex` file and picks up the new `edits[]` entries. No
conflict.

Scenario B: **web flushes while native has uncommitted local edits.**
Web push fails fast-forward. The web app must:

1. Pull with the cell-array merge strategy.
2. Re-serialize the Y.Doc atop the pulled tree.
3. Push again.

Proposed rule: **web never force-pushes.** If fast-forward fails twice,
surface a conflict UI and let the user decide. This matches the native
client's behavior — neither side silently overwrites.

Scenario C: **native commits while web session is live.** Web app polls
`git pull --ff-only` on a background timer (proposed: 60 s). On pull, for
every file that changed:

1. If the Y.Doc for that file is loaded, diff the pulled cells against
   the current Y.Doc state.
2. For cells whose Y.Doc value matches the previous committed value
   (i.e. no live edit), overwrite `translatedXml` with the new committed
   value. No CRDT conflict because the fragment had no divergent local
   state.
3. For cells with live local edits, do **not** overwrite; log a warning
   and keep the local state. The next flush will produce a merge.

This means the web app pulls **continuously** (background timer), not
only on session start. One round-trip per minute per active project.

### `requiredExtensions` mismatch

If a project's `meta.requiredExtensions` declares a
`codexEditor >= 0.30.0` but the web app was built against a protocol
equivalent to `codexEditor 0.22.0`, the web app should:

1. On project open, compare `meta.requiredExtensions.codexEditor` against
   a hard-coded minimum in the web build.
2. If the project version is *newer* than the web app supports, show a
   read-only warning banner. Block flushes; allow read and P2P viewing.
3. If the project is *older*, optionally write a migration entry to
   `metadata.edits[]` of type `"migration"` and proceed.

Symmetric for `codexWeb` — see §11.

### Edge cases

- **Flush during peer handoff.** If the flush-leader peer disconnects
  mid-flush, another peer takes leadership after 30 s. The partial
  commit is either rolled back (pre-commit failure) or pushed and
  treated as a normal merge for the next peer.
- **Empty flush.** No dirty cells → no commit.
- **Non-cell metadata changes.** Toolbar/menu actions that touch
  `metadata.json` or file-level `metadata` go through the same flush,
  appending to the project-level or file-level `edits[]`.
- **Schema version drift inside one session.** If a peer running a
  newer web version writes an `edits[]` entry with a field an older peer
  doesn't recognize, the older peer must round-trip-preserve the field
  but never reference it in logic.

---

## 11. `requiredExtensions` Handshake

### Current values in the real project

`[NaturalEnglish/metadata.json:L18-L21]`:

```json
"requiredExtensions": {
    "codexEditor": "0.22.0",
    "frontierAuthentication": "0.4.24"
}
```

### Proposed web-app entry

Add a third key: `codexWeb`. Example post-migration:

```json
"requiredExtensions": {
    "codexEditor": "0.22.0",
    "frontierAuthentication": "0.4.24",
    "codexWeb": "1.0.0"
}
```

Semver semantics follow `[types/index.d.ts:L1019-L1023]` (the type permits
arbitrary string keys; `codexEditor` and `frontierAuthentication` are not
hard-coded as the only valid keys).

### Compatibility rules

- **Same major, client ≥ declared minor:** open read-write.
- **Same major, client < declared minor:** open read-only; warn the user.
- **Different major:** refuse to open; offer to update or open archival
  read-only with a big warning.
- Writing client **always** bumps its own key on first flush, never
  downgrades.

---

## 12. Open Questions / Deferred Decisions

The following are unresolved and need team input before implementation:

1. **Absolute paths in file metadata.** `sourceFsPath` and `codexFsPath`
   `[NaturalEnglish/files/target/JHN.codex:L383-L384]` are absolute paths
   from the machine that created the file. What should the web app do —
   rewrite on import, null them out, or leave as-is? The native client
   presumably tolerates stale paths but this should be confirmed.

2. **Top-level cell metadata vs `metadata.data` duplication.** Fields
   like `vref`, `bookCode`, `chapter`, `verse`, `cellLabel`,
   `originalText`, `fileName`, `chapterNumber`, `globalReferences`
   appear both directly on `cell.metadata` and under `cell.metadata.data`
   in the real file `[JHN.codex:L22-L34]`. Which is canonical? The type
   definitions only declare the nested `data` versions formally.

3. **Real-time presence across native + web.** Yjs awareness is
   web-only. Does the native client need a presence beacon, or is it
   acceptable for natives to be invisible to web peers?

4. **Offline queueing.** If a web app user is offline for a week, do
   they push a single giant commit or one per session? Proposed: one
   per session, squashed locally via `git commit --amend` up to
   session end, then push on reconnect. Needs confirmation.

5. **Project-level permissions.** The native client has no role model
   beyond "has GitLab access." Does the web app introduce roles
   (translator / reviewer / admin) and encode them somewhere?
   `meta.agencies[].roles` exists in Scripture Burrito
   `[types/index.d.ts:L1078-L1089]` but is unused in the real project.

6. **Cross-project search.** The native client's SQLite index is
   per-project. The web app has `useWorkspaceSearch` that is also
   per-project. Cross-project is deferred.

7. **Attachment strategy.** `.project/attachments/originals/` is
   conditionally tracked (archives are ignored). LFS rules apply. The
   web app has no attachment pipeline yet — deferred to a later
   milestone.

8. **Branch strategy.** Assumed `main`-only; not confirmed.

9. **GitLab auth for the web app.** Plan is OAuth; exact token flow and
   storage (IndexedDB vs HTTP-only cookies via a thin proxy Worker)
   undecided.

10. **`importerType` extensibility.** The enum in
    `[types/index.d.ts:L839-L860]` is closed. The web app has its own
    set of importers (`docx`, `pptx`, `markdown`, `subtitle`,
    `plaintext`, `usfm`) — mostly overlapping, but the web app lacks
    `macula`, `biblica`, `reach4life`. Round-tripping a project
    imported via `macula` in the native client through the web app
    must not break. Proposed: treat unknown `importerType` as opaque
    read-only.

11. **Handling of the cell-array merge's "duplicate cells" outcome.**
    The native client relies on a human to resolve duplicates
    interactively. The web app needs equivalent UI, or a deterministic
    automatic resolver (e.g. newer timestamp wins). Neither exists
    today.
