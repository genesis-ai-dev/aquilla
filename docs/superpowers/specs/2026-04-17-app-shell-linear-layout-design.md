# App Shell Redesign — Linear-Inspired Layout

**Status:** Design
**Date:** 2026-04-17
**Scope:** Rework the project workspace chrome (sidebar + header) into a Linear-style shell. Adds user identity everywhere, collapses the crammed top toolbar, introduces a contextual primary-action slot, and adds file renaming + magical auto-labeling with a transparent original-name tooltip.

---

## Motivation

Today's workspace toolbar (`src/components/Toolbar.tsx`) crams ~12 icon buttons into one row: Back, project name, language pair, peers, sync, view settings, search, share, video, comments, snapshots, import, export, rules, settings. There is no visual hierarchy, no indication of the logged-in user (so no way to log out or switch accounts mid-session), and the primary action is fixed as "Import" regardless of context.

Linear's single-sidebar + thin-header pattern — with sectioned nav, a top-left account switcher, a bottom `⌘K` hint, and contextual primary actions — fits this app's mental model: a project is a long-lived context, the user moves between files within it, and there are a handful of cross-cutting views (Rules, Comments, Snapshots) plus admin entries (Share, Settings).

## Goals

1. Shrink the top header to **breadcrumb + contextual primary action**; everything else moves.
2. Consolidate cross-cutting nav and admin entries into the **sidebar**, segregated from the primary Files content.
3. Surface **user identity** prominently (Linear-style account switcher top-left of sidebar) with log-out and multi-account switching.
4. Make the primary action **contextual and extensible**: a split button whose default label changes with workspace state, plus a dropdown menu of all batch operations.
5. Expand Files rows to show **per-section progress** (chapters for USFM, etc.).
6. Add **rename + corpus-recategorize** to files/corpora with Linear's hover-reveals-menu pattern.
7. Add **magical auto-labeling** for recognized file conventions (Bible book codes, S/E numbering), always user-confirmed, with original filenames preserved and visible on hover.

## Non-Goals

- Keyboard-shortcut overhaul beyond the handful introduced here (`R` for rename, `⌘K` unchanged).
- Redesigning the Dashboard header (it's already clean).
- New filterable tag/label system — renaming + corpus is sufficient; multi-tag labels are deferred.
- Token-refresh improvements for multi-account; we only need to cache N sessions and swap the active pointer.
- Changes to the editor pane itself.

---

## Architecture Overview

```
┌─ AppShell (new wrapper component for ProjectWorkspace) ─────────────────────┐
│                                                                             │
│ ┌─ Sidebar ────────────────────┐ ┌─ Main ───────────────────────────────┐  │
│ │ AccountSwitcher              │ │ WorkspaceHeader                       │  │
│ │   (user avatar + menu)       │ │   Breadcrumb · PrimaryActionButton   │  │
│ │ ───────────────────────────  │ │ ───────────────────────────────────  │  │
│ │ FilesSection                 │ │                                      │  │
│ │   SuggestionBanner (✨)       │ │          Editor (unchanged)           │  │
│ │   ExpandableFileList         │ │                                      │  │
│ │     └─ SectionProgressRows   │ │                                      │  │
│ │ ───────────────────────────  │ │                                      │  │
│ │ ProjectSection               │ │                                      │  │
│ │   Rules, Comments,           │ │                                      │  │
│ │   Snapshots, Share, Settings │ │                                      │  │
│ │ ───────────────────────────  │ │                                      │  │
│ │ CommandPaletteHint (⌘K)      │ │                                      │  │
│ └──────────────────────────────┘ │ ───────────────────────────────────  │  │
│                                  │ StatusBar                             │  │
│                                  │   PeerPresence · SyncButton           │  │
│                                  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. `AppShell` (new, `src/components/AppShell.tsx`)

Layout wrapper replacing the current top-level JSX in `ProjectWorkspace`. Owns three regions: sidebar (left, fixed width ~224px), main (flex), status bar (bottom of main). Props pass through for file list, sync state, peers, project, etc. Keeps presentational layout separate from workspace logic.

### 2. `AccountSwitcher` (new, replaces `HeaderAuth`'s workspace presence)

Position: **top of sidebar**. Shows avatar (initials in a colored disc) + username + chevron. Click opens a menu:

- **Current account** — username + Frontier URL, a check mark
- **Switch account** — lists other cached sessions with username + URL; click swaps the active session pointer
- **Add another account…** — opens the existing `FrontierLoginForm` dialog; on success the new session is appended and becomes active
- **Account settings** — opens a small dialog: username (read-only), Frontier URL, last-login timestamp, "Log out of this account" button
- **Log out** — clears the active session; falls back to next cached session if any, else returns to logged-out state

Dashboard continues to use `HeaderAuth` (already adequate there); the `AccountSwitcher` is specifically for the sidebar context. Both share a new `useAccounts()` hook (see Data section).

### 3. `WorkspaceHeader` (new, replaces `Toolbar.tsx`)

Thin top strip above the editor. Contains only:

- **Left:** breadcrumb `‹Project Name› · ‹src› → ‹tgt›`. Clicking the project name returns to the dashboard. Language pair is plain text, not a button.
- **Right:** `PrimaryActionButton` (see below).

Everything that was in the old toolbar is relocated:

- Rules, Comments, Snapshots, Share, Settings → sidebar `ProjectSection`
- Search (⌘K) → sidebar `CommandPaletteHint`
- Import, Export, batch operations → `PrimaryActionButton` dropdown
- View settings and Video attachment → stay in the header as two small icon buttons to the **left of `PrimaryActionButton`**. They are file-scoped and disabled when no file is open. Moving them into an editor-scoped toolbar is a deliberate follow-up; keeping them in the header during this rework prevents a feature regression.
- Back → the project-name portion of the breadcrumb is the click target
- Language pair → plain text in the breadcrumb

### 4. `PrimaryActionButton` (new)

Split button. Renders `[Default Action Label] [▾]`. Dropdown menu lists every registered `WorkspaceAction`. The default label is the one action flagged as `isDefault` for the current context.

**Registry:** `src/lib/workspace-actions/registry.ts` exports an ordered array of `WorkspaceAction` entries:

```ts
interface WorkspaceActionContext {
  project: ProjectRecord
  activeFileId: string | null
  fileProgress: Map<string, { translated: number; validated: number; total: number }>
}

interface WorkspaceAction {
  id: string
  label: string
  icon: LucideIcon
  group: "primary" | "secondary"       // primary shown directly; secondary in divider below
  isAvailable: (ctx: WorkspaceActionContext) => boolean
  isDefault?: (ctx: WorkspaceActionContext) => boolean   // at most one true per render
  requiresConfirmation?: {
    title: string
    description: (ctx: WorkspaceActionContext) => string  // e.g. "Marks 342 cells as validated under your name."
    confirmLabel: string
  }
  run: (ctx: WorkspaceActionContext, router: NavigateFn) => Promise<void> | void
}
```

**Initial registrations (in order):**

| id | label | group | default when | availability | confirmation |
|---|---|---|---|---|---|
| `import-new` | `+ Import` | primary | no file open | always | — |
| `run-completions` | Run completions | primary | file open, translated < 100% | file open | — |
| `batch-validate` | Batch validate… | primary | file open, translated=100%, unvalidated>0 | file open | yes (see below) |
| `export` | Export | primary | file open, validated=100% | file open with exportable cells | — |
| `agent-input` | Agent input | primary | — | always | — |
| `import-wip` | Import work in progress | secondary | — | always | — |

At most one `isDefault` predicate matches per context; if multiple match, the first in registry order wins (documented). If none match (e.g., project is empty), the button falls back to `import-new`.

**Confirmation dialog** for `batch-validate`: modal with description text plus an `[x] I understand this marks N cells as validated under my name (@username).` checkbox. The `Confirm` button is disabled until the box is checked. Reusable `<ConfirmActionDialog>` powered by the action's `requiresConfirmation` config so future destructive batch actions can opt in identically.

### 5. `SidebarSection` and `ExpandableFileList` (rework of `ProjectSidebar`)

The existing `ProjectSidebar` is split:

- `FilesSection` — scrollable region containing `SuggestionBanner` + `ExpandableFileList`. Takes up the majority of sidebar height.
- `ProjectSection` — collapsible group under Files, containing nav entries. Each nav entry is a small row with icon + label; optional badge (e.g., open comments count).
- Bottom-pinned `CommandPaletteHint` — a row that shows `⌘K Search`, clicking opens the existing `SearchDialog`.

Each file row in `ExpandableFileList`:

- Chevron on the left (toggles expanded state). Chevron click does not open the file.
- File name, then inline progress indicator (the existing `HealthRing` / double-ring component).
- On hover: row shows a small `⋯` button on the far right; also reveals the original filename as muted 10px text beneath the display name if `originalName` is set.
- Clicking the row (not the chevron, not `⋯`) opens the file — same behavior as today.
- When expanded: child rows for each `group` aggregated from the file's cells, with per-section translated/validated ratio shown as a thin double-bar. Clicking a section opens the file and emits a scroll-to event for that group id (see Data Flow).

Expansion state is persisted per-project in `localStorage` under key `sidebar:expanded:{projectId}` as a string array of fileIds.

### 6. `FileActionMenu` (new, triggered by `⋯` or right-click or `R`)

Popover menu with:

- Rename — replaces the row name with an inline text input; Enter saves, Esc cancels
- Move to corpus… — submenu listing existing corpus markers + "New corpus…" input
- Delete — confirmation dialog; removes file from project

Same menu on corpus section headers, minus Move (doesn't make sense for a group); Rename there rewrites `corpusMarker` on every member of the group in a single transaction.

Keyboard: when the sidebar has focus and a row is selected (arrow keys navigate rows), `R` triggers rename; `Enter` opens the file; `Esc` cancels an active rename.

### 7. `SuggestionBanner` and the detector

Top of `FilesSection` when pending suggestions exist for the current project:

```
✨ 24 files look like Bible books. Apply friendly names?   [Review]  [Apply all]  [×]
```

- `Apply all` commits every suggestion; toast with `Undo` visible 10s (Undo restores prior `name` + `corpusMarker` + clears `originalName`).
- `Review` opens `<RenameSuggestionsDialog>`: a scrollable checklist of `originalName → suggestedName` (`suggestedCorpus` shown as a chip). Each row pre-checked. `Apply selected` commits only the checked rows.
- `×` dismisses the banner for the project; dismissal stored in the project record (`suggestionsDismissedAt?: string`) so it doesn't reappear on next load.

Detector lives in `src/lib/file-labeling/detect.ts` as pure functions:

```ts
interface RenameSuggestion {
  fileId: string
  currentName: string
  suggestedName: string
  currentCorpus?: string
  suggestedCorpus?: string
  source: "bible-book" | "season-episode" | "numbered-family"
}

function detectSuggestions(project: ProjectRecord): RenameSuggestion[]
```

**Detectors (first-match wins per file):**

1. **`bible-book`** — file is `usfm` or `ebible` type; look up book code via USFM `\id` tag (when parseable) or filename stem against the 66-book canonical table. Suggested name = canonical English book name. Suggested corpus = `OT` or `NT` per standard split.
2. **`season-episode`** — file is `vtt` or `srt` type; regex alternatives in order:
   - `S(\d{1,2})E(\d{1,3})` → `Season N · Episode M`, corpus `Season N`
   - `(\d)(\d{2})(?!\d)` at name start (e.g., `101`) → treat as `S1E01` if the number is 3 digits
   - `(\d{2})(\d{2})(?!\d)` at name start (e.g., `1004`) → treat as `S10E04` if the number is 4 digits
3. **`numbered-family`** — group files sharing a common non-numeric stem and differing only by a trailing number (≥2 files in the family). Corpus = stem, name = numeric part with leading zeros normalized to width-of-largest.

Detector never applies suggestions; it only returns them. Application mutates `FileReference.name` (and sets `originalName` if unset) or `corpusMarker`.

---

## Data Model Changes

### `FileReference` (`src/lib/parsers/types.ts`)

Adds one optional field:

```ts
interface FileReference {
  // ... existing
  originalName?: string  // Populated when name is auto-rewritten or user-renamed. Enables "hover to see original" transparency and undo.
}
```

`originalName` is set the **first time** `name` changes (manual or suggestion); subsequent renames do not overwrite it. If the user wants to fully forget the original they can clear it from the File Action Menu's "Reset name" entry — but this is a follow-up, not in scope.

### `ProjectRecord` (`src/lib/parsers/types.ts`)

Adds:

```ts
interface ProjectRecord {
  // ... existing
  suggestionsDismissedAt?: string  // ISO timestamp; banner hidden after this
}
```

### Session store (`src/lib/frontier/session-store.ts`)

Current schema stores a single session under key `current`. New schema stores:

```ts
interface SessionsEnvelope {
  active: string       // key into sessions
  sessions: Record<string, FrontierSession>  // keyed by `${frontierUrl}::${username}` to dedupe
}
```

Stored under key `envelope`. Migration: on first load, if `current` exists and `envelope` does not, build envelope with one entry and set it active; delete `current`.

New API:

```ts
function listSessions(): Promise<SessionSummary[]>
function addSession(s: FrontierSession): Promise<void>
function activateSession(key: string): Promise<void>
function removeSession(key: string): Promise<void>
function loadActiveSession(): Promise<FrontierSession | null>  // replaces loadSession
```

`loadSession` retained as a thin alias for backward compatibility until call sites are migrated.

### `useAccounts()` hook (new, `src/hooks/useAccounts.ts`)

Exposes `{ active, sessions, activate, add, remove }`. Supersedes `useFrontierSession` for components that need multi-account awareness. `useFrontierSession` kept as a thin wrapper that returns only `active` for backward compat.

### `sidebar:expanded:{projectId}` localStorage key

Array of fileIds for currently-expanded rows. Read on mount, written on toggle.

---

## Data Flow

### Opening a file from an expanded section row

1. User clicks a section row under `Genesis` (e.g., "3 Fall").
2. `ExpandableFileList` calls the existing `onSelectFile(fileId)` and additionally emits a one-shot `scrollToGroup` event via a new `useEditorScroll` context.
3. The editor, already mounted or mounting, subscribes to the context and scrolls the matching group into view once render completes.

New: `src/context/EditorScrollContext.tsx` exposing `requestScrollToGroup(groupId: string)` and `useEditorScrollTarget()` (consumed inside the editor).

### Rename flow (file)

1. User presses `R` (or clicks Rename in the menu).
2. Row enters `editing` local state; input is focused with current name selected.
3. On Enter: call `renameFile(projectId, fileId, newName)` which mutates the `ProjectRecord` via `project-store`, sets `originalName` if not already set, and returns the updated project.
4. On Esc: discard.
5. On blur: treat like Enter (save).

### Apply suggestions

1. User clicks Apply all (or Apply selected in dialog).
2. `applySuggestions(projectId, suggestions)` runs in one project-store transaction:
   - For each: set `name = suggested`, set `originalName = current` if unset, set `corpusMarker = suggestedCorpus` if provided.
3. Emit toast with Undo; `Undo` runs the inverse transaction using the stored originals.
4. No `suggestionsDismissedAt` write here — the banner disappears because there are no more pending suggestions, not because it was explicitly dismissed.

### Account switch

1. User picks an entry in the account switcher.
2. `activateSession(key)` updates the envelope's `active` pointer, persists, and notifies `subscribeSession` listeners (renamed to `subscribeAccounts`).
3. React re-renders with the new active session; Frontier API calls (peers, sync, remote projects) use the new token. No page reload required.

### Add account

1. User picks "Add another account…".
2. `FrontierLoginForm` opens — same component as today, but on success it calls `addSession()` and then `activateSession()`.

---

## Error Handling

- **Detector exceptions** — the detector runs in a `try/catch` per file; a single malformed filename cannot poison the whole banner. Failures are logged once per session.
- **Rename collision** — if renaming a file would produce a duplicate name within the project, the inline input shows an inline red hint and Save is blocked until resolved. Auto-suggest never produces collisions by construction (book names are unique; S/E combinations are unique per file).
- **Batch validate race** — the confirmation dialog is blocking; the run function takes a snapshot of unvalidated cell IDs at click time and validates only those, so a concurrent edit by another user doesn't get silently steamrolled.
- **Session removal while active** — removing the active session auto-activates the most-recently-added remaining session; if none remain, the user is logged out and the sidebar reverts to the "no account" state with a Log-in button.
- **Migration** — single-session → envelope migration wraps in try/catch; on failure, leaves the old key intact and logs a warning so the user can still authenticate, at the cost of losing multi-account for this version.

---

## Testing

Unit (vitest):

- `detect.ts` — per-detector tests across positive, negative, ambiguous inputs. Canonical USFM book list coverage. S/E regex boundaries (`100` should NOT match, `1004` should as S10E04).
- `workspace-actions/registry.ts` — `getDefaultAction(ctx)` returns the expected entry for each documented context.
- `session-store` migration — old `current` key migrates to envelope; behaves when `current` missing; behaves when both exist.
- `renameFile`, `applySuggestions`, and their `Undo` variants — idempotency, `originalName` set-once behavior.

Integration / RTL:

- Sidebar expand/collapse persists across remount.
- Split button default label updates with file selection and progress changes.
- Confirm dialog blocks `batch-validate` until checkbox is ticked.
- `R` on a focused row enters edit mode; Esc cancels; Enter saves.
- Account switcher lists multiple sessions and activation swaps the rendered username.
- Suggestion banner disappears after Apply all and reappears only if new suggestions are detected later.

No E2E tests in this milestone — the app-shell changes are covered at the component level.

---

## Rollout

Single PR. Behind no feature flag — this is a UX change for every user, and a half-cutover (old toolbar + new sidebar) is worse than either extreme. The old `Toolbar.tsx` is deleted once `WorkspaceHeader` + sidebar nav carry all its responsibilities.

## Out of Scope (Explicit)

- Editor-scoped file toolbar (moving View settings / Video attachment out of the header into the editor pane itself). Follow-up; they stay in the header for now as described in `WorkspaceHeader`.
- Multi-tag labels ("Labels" option B from brainstorming).
- Token refresh, SSO, org-level account management for the multi-account feature.
- Reset name / forget originalName.
- Sidebar width drag-to-resize.
