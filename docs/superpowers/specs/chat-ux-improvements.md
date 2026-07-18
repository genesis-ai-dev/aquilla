# Chat UX Improvements — immediate polish for the existing panel

Status: SPEC v1 (2026-06-11)
Scope: frontend only. No backend changes, no grounding/context changes, no
tool calling — those belong to the agentic-harness strategy phases. This
spec makes the *current* chat not ham-fisted.

Files in play: `src/components/ChatPanel.tsx`, `src/components/ChatDockPanel.tsx`
(near-duplicates today), `src/hooks/useChat.ts`, `src/lib/completion/chat-service.ts`
(read-only reference).

## Goals

A translator asking a question gets a response that reads like a
modern chat: formatted, copyable, recoverable on failure, and usable —
the answer can go into the cell they're working on without manual
select-copy-paste.

## Out of scope (do not touch)

- The frontier-provider streaming workaround in completion-service.ts.
- System prompt / context construction (chat-service.ts) — Phase 1 work.
- Multi-conversation support, server-side history, model pickers.
- Rate limiting / budgets.

## Work items

### 1. Shared chat components (enables everything else)

ChatPanel (sheet) and ChatDockPanel (dock) duplicate the message list,
composer, context-pin, and empty/error states with small drift (40 vs 30
char truncation, etc.). Extract shared pieces — suggested:
`src/components/chat/ChatMessageList.tsx`, `ChatComposer.tsx`,
`ChatMessageBubble.tsx` — and have both panels compose them. Do NOT
unify the panel shells themselves (sheet vs dock layout stays distinct).
Every item below is implemented once, in the shared components.

### 2. Markdown rendering for assistant messages

- Add `react-markdown` + `remark-gfm` (renders to React elements — no
  dangerouslySetInnerHTML, no dompurify needed for this path).
- **Convention note (deliberate divergence):** TranslationNotesSidebar.tsx:285
  deliberately avoids a markdown lib for TN rows. Chat is different: LLM
  output *is* markdown. Keep the dependency scoped to chat components;
  do not retrofit other surfaces in this PR.
- Style minimally to match the app (Tailwind classes on components map:
  paragraphs, lists, `code`/`pre` with the app's mono font + muted bg,
  tables, blockquotes, links opening `target="_blank" rel="noopener"`).
  No @tailwindcss/typography unless it's already installed (it isn't —
  don't add it).
- Code blocks get a small copy button (top-right, appears on hover).
- User messages stay plain text (whitespace-preserving).
- Streaming: render the in-flight `streamingText` through the same
  markdown component; accept minor flicker on incomplete syntax (v1).

### 3. Message actions (assistant messages, hover/focus toolbar)

- **Copy** — copies the raw markdown source to clipboard, brief check
  affordance on success.
- **Insert into cell** — visible only when a cell is focused
  (`currentCell` prop already flows into both panels). Inserts the
  message's plain text (markdown stripped) into the focused cell via the
  same commit path single-cell AI completion uses (see
  `useCompletion`/EditorTable commit flow) so AQU-247 write-clock
  semantics hold. If the cell already has text, confirm
  ("Replace current translation?") before committing. Keep the action's
  label consistent with UI-GLOSSARY conventions.
- **Regenerate** — last assistant message only: removes it and re-sends
  the preceding user message.

### 4. Error recovery

Today a failed send rolls back the optimistic user message and shows raw
server text in a red banner (useChat.ts:152-170) — the user's typed
message is just gone.

- On failure, keep the user message visible in the list, marked failed
  (muted + small error line under it), with **Retry** (re-send) and
  **Dismiss** (remove it) actions.
- Map known errors to human copy: 401 → "Sign in to use AI chat.";
  402/429 → "AI limit reached — try again later."; network/abort →
  "Connection lost — retry?"; everything else → "Something went wrong."
  with the raw detail behind a collapsed "details" disclosure.
- This changes `useChat`'s rollback behavior — update its tests
  (`useChat` has hook-level behavior worth pinning: failed-send keeps
  message with error state; retry re-sends without duplicating).

### 5. Composer ergonomics

- **Enter sends; Shift+Enter inserts newline.** Keep ⌘/Ctrl+Enter
  working. Update the placeholder/hint accordingly.
- Auto-growing textarea (1 → ~8 rows, then internal scroll).
- When `isStreaming`, composer stays enabled for typing but submit is
  replaced by Stop (current Stop behavior retained).
- Disabled state (not configured) keeps the existing guidance copy.

### 6. Scroll behavior

- Stick-to-bottom only while the user is at (or near) the bottom; if
  they scroll up during streaming, do not yank them down.
- Floating "↓ Jump to latest" pill appears when not at bottom and new
  content arrives.

### 7. Small fixes

- Persist `includeCellContext` per project (localStorage key alongside
  `chat-history:{projectId}`); stop resetting to true on every mount
  (useChat.ts:90).
- "Clear conversation" gets a confirm (the app's existing
  dialog/confirm pattern — match whatever EditorTable/Preferences use).
- Relative timestamps on messages (e.g. "2m ago"), stored `ts` added to
  new ChatMessage entries; tolerate legacy persisted messages without
  `ts` (no migration — render nothing for them).

## Acceptance criteria

1. Assistant replies render markdown (headings, lists, tables, code
   blocks with copy) in both the sheet and dock panels.
2. With a focused cell, "Insert into cell" puts the reply text in the
   cell through the standard edit path; confirm shown when overwriting.
3. A failed send leaves the user's message visible with working Retry.
4. Enter sends; Shift+Enter newlines; textarea grows.
5. Scrolling up during a streaming reply does not get hijacked; the
   jump-to-latest pill works.
6. Cell-context pin survives panel close/reopen within a project.
7. `pnpm tsc --noEmit` (or repo's typecheck script) and the test suite
   pass; new/changed useChat behavior has test coverage; existing
   ChatPanel-related tests updated, not deleted.
8. Browser-verified walkthrough of 1–6 against the local dev stack as
   the seeded dev user (not just unit tests).

## Non-goals quality bar

Match existing component style (shadcn-ish primitives, lucide icons,
Tailwind). No new global state. No new routes. Keep the dependency
additions to `react-markdown` + `remark-gfm` only.
