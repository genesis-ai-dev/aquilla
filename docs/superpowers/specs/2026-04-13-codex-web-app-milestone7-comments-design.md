# Codex Web App — Milestone 7: Comments & Review

## Overview

Per-cell comment threads for review workflows: translators flag ambiguity, reviewers suggest changes, threads can be resolved. All Yjs-native so comments sync in real time when P2P arrives. Dedicated comments page for reviewer catch-up + inline drawer for in-context interaction.

## Data Model

Each cell gains a `Y.Array<Y.Map>` of comment threads:

```typescript
interface CommentThread {
  id: string
  status: "open" | "resolved"
  createdAt: string
  resolvedAt?: string
  resolvedBy?: string
  // Snapshot of cell.translated at thread creation time.
  // If cell.translated diverges, thread is considered stale.
  createdForTranslated: string
  messages: CommentMessage[]
}

interface CommentMessage {
  id: string
  author: string              // username from project settings; "anonymous" if not configured
  authorType: "user" | "anonymous"
  text: string                // markdown
  timestamp: string
  mentions?: string[]         // @username references extracted during creation
}
```

### Y.Doc Storage

On each cell `Y.Map`:
- `threads: Y.Array<Y.Map>` — one Y.Map per thread
- Each thread Y.Map holds primitive fields + `messages: Y.Array<CommentMessage>` where each message is a plain JS object (no inner Y.Map needed — messages are append-only)

### Staleness

Computed from `thread.createdForTranslated !== cell.translated`. Similar to stale backtranslation pattern. Shown with amber indicator in UI. User can dismiss (resolve) or address.

## Operations

`src/hooks/useComments.ts` exposes:

```typescript
function useComments(doc: Y.Doc | null, username: string) {
  return {
    addThread(cellId: string, firstMessage: string): void
    addMessage(cellId: string, threadId: string, text: string): void
    resolveThread(cellId: string, threadId: string, closingMessage?: string): void
    reopenThread(cellId: string, threadId: string): void
  }
}
```

All operations wrap `doc.transact()` for atomic Yjs updates. `addThread` captures `cell.translated` as `createdForTranslated`.

## Mentions

Extract `@\w+` patterns from message text at creation time. Store as `mentions` array on the message. No validation or lookup — this is just metadata for future auth milestone.

**Note for Auth milestone:** Once user accounts exist, resolve `@username` against the project's members list and:
- Show mention autocomplete during typing
- Render resolved mentions as styled chips
- Send notifications to mentioned users
- Allow clicking mentions to filter comments by participant

For now, mentions render as styled but non-interactive (`<span class="mention">@alice</span>`).

## UI

### 1. Cell-level indicator (EditorTable)

New icon in the validation column (between infractions and backtranslation button):

- `MessageCircle` icon from lucide-react
- Muted when 0 threads, primary color when threads exist
- Badge with count of **open** threads (resolved threads don't count, but are still visible when drawer opens)
- Click opens the CommentsDrawer for that cell

Cells with open comments also get a subtle left border accent (1.5px blue border-left on the row) for scannability.

### 2. CommentsDrawer (inline)

Similar pattern to RuleDrawer. Slides in from right when a cell's comment icon is clicked. Shows:

- Cell context (source + target snippet)
- List of threads for that cell
- Each thread:
  - Stale indicator if `createdForTranslated !== current translated`
  - Status badge (open/resolved)
  - Messages with author, timestamp, markdown-rendered text
  - Reply input (for open threads) — two buttons: "Reply" and "Close with reply"
  - For open threads: "Resolve" button (resolve without reply)
  - For resolved threads: "Reopen" button
- "New thread" input at bottom

Rendering markdown: use a minimal subset — bold (`**`), italic (`*`), inline code (`` ` ``), links. Same DOMPurify + simple regex approach used by the markdown parser. Mentions rendered as styled spans.

### 3. Comments page (`/project/:id/comments`)

Dedicated route for catch-up/review. Shows all threads across all files in the project.

Layout:
- Header with back button
- Filter bar: "Open" / "Resolved" / "All"; search input; file dropdown
- Grouped by file (collapsible sections)
- Each thread card:
  - File name + cell context
  - Source/target snippet (clickable to jump to the cell)
  - Message count, last-activity time, status badge
  - Click expands thread to show messages with same controls as the drawer

### 4. Toolbar button

Add a `MessagesSquare` icon button to the toolbar, next to the existing buttons, linking to the comments page.

## Project-Wide Stats

Update `useHealth` output to include an `openCommentCount` field (per-file + project total), derived from thread scans. Sidebar can surface a comment count per file (small badge next to the filename).

**Does NOT affect health score.** Comments are communication, not quality metrics. (Could be made configurable later but out of scope for M7.)

## File Structure

```
src/
├── lib/
│   ├── comments/
│   │   ├── comment-helpers.ts          # NEW: markdown renderer, mention extractor
│   │   └── comment-helpers.test.ts     # NEW: TDD
│   └── store/
│       └── file-doc.ts                 # MODIFY: persist threads on cell creation (empty Y.Array)
├── hooks/
│   ├── useCells.ts                     # MODIFY: expose threads on CellData
│   ├── useComments.ts                  # NEW: thread CRUD operations
│   └── useHealth.ts                    # MODIFY: count open comments per file/project
├── components/
│   ├── CommentsDrawer.tsx              # NEW: inline cell-level drawer
│   ├── CommentsPage.tsx                # NEW: /project/:id/comments route
│   ├── CommentThread.tsx               # NEW: shared thread component
│   ├── EditorTable.tsx                 # MODIFY: comment icon + left border
│   ├── ProjectWorkspace.tsx            # MODIFY: wire comments + drawer state
│   ├── ProjectSidebar.tsx              # MODIFY: comment count badges
│   ├── Toolbar.tsx                     # MODIFY: comments button
│   └── App.tsx                         # MODIFY: add /comments route
└── lib/parsers/
    └── types.ts                        # MODIFY: add CommentThread + CommentMessage
```

## Not In Scope (noted for Auth milestone)

- Real mention resolution against member list
- Mention autocomplete and notifications
- Comment reactions (👍)
- Permissions on resolving others' threads
- Email notifications or external integrations
- Comment categories (question/suggestion/note) — revisit with real usage
