# Source-selection → AI chat context chips

- **Date:** 2026-06-26
- **Status:** Approved design, pre-implementation
- **Scope:** Add a way to send a highlighted **source** selection into the AI agent chat as an inline, atomic **context chip**, so a translator can reference one or more cells (across files) in a single agent message. Replace the ad-hoc source-selection toolbar with a shadcn component matching the editor hover-rail aesthetic, and add an "Ask AI" action beside the existing "Add to terms".

## 1. Motivation

Today, selecting source text shows a small floating bar (`SelectionTermActions`) with "Add to term base" / "View term". There is no way to pull that selection into the AI agent. Translators frequently want to ask the agent about a specific phrase and relate it to a phrase in another cell/file ("I don't understand this part `[GEN 1:1]` and it seems related to this part `[JHN 1:1]`").

We want this to (a) feel native to the editor, (b) follow how leading tools inject referenced content into chat, and (c) respect the project's vertical-agent cache hierarchy — keep the always-resident system prompt (L1) untouched, and let the agent fetch full content only when it needs it.

## 2. Prior art (informs the wire format)

Surveyed Cursor, GitHub Copilot, Claude Code, ChatGPT, Continue.dev, Zed, JetBrains AI, Aider. Consensus:

- The chip/pill is **cosmetic UI**; what reaches the model is **materialized text**, resolved before the request.
- Eager full-text inline is the norm for file/selection references; lazy "fetch on demand" appears only via retrieval tools for large corpora.
- Budget-bounded exemplars: **Aider** (full text for attached items, compressed map for the rest) and **Anthropic citations** (cited text is token-free).

We adopt a **hybrid**: short selections (verse-sized) inline fully (cheap, zero tool calls); long selections send a truncated preview plus coordinates the agent can expand via its existing SQL tool.

## 3. User flow

1. User highlights text in a cell's **source** column.
2. A floating action cluster appears above the selection with two icon+label buttons: **Ask AI** (`Sparkles`) and **Add to terms** (`BookOpen`). A "View term" lookup still appears when the selection matches an active concept (unchanged).
3. Tapping **Add to terms** → today's behavior (opens `AddConceptDialog`).
4. Tapping **Ask AI** → opens the Agent dock if closed, and inserts an atomic **context chip** into the composer at the caret, carrying the selection + its `fileId`/`cellId`/`canonicalRef`.
5. User types prose around one or more chips and sends. The agent receives the prose with inline reference tokens plus a context legend; it answers from the inline preview, or expands a chip to full text via one SQL query when needed.

## 4. Data model

`ContextChip` is **client-only** — no server type, no protocol change. New file `src/lib/agent/context-chip.ts`:

```ts
export interface ContextChip {
  chipId: string       // local nanoid; UI identity only
  fileId: string
  cellId: string
  canonicalRef?: string // e.g. "GEN 1:1" (from cell.context / cell.group)
  side: 'source'        // v1 is source-only
  selection: string     // exact highlighted substring (full; used for tooltip + hybrid)
  preview: string       // selection capped via truncateCellText (UI + legend)
  fileName?: string
}
```

All fields are captured synchronously at the toolbar call site from data already in scope: `cell.fileId`, `cell.id`, `cell.context`/`cell.group`, and `window.getSelection().toString()` (already captured into `capturedSelectionRef`/`sourceSelection` in `EditorTable.tsx` ~2428–2436). De-dupe on (`fileId`, `cellId`, `selection`).

## 5. Selection toolbar (shadcn, rail aesthetic)

Replace the inline markup of `SelectionTermActions` (`src/components/EditorTable.tsx:1607`) with a new component `src/components/SourceSelectionToolbar.tsx` that echoes `CellActionRail`/`RailButton` (`src/components/CellActionRail.tsx`): a `bg-card shadow-neu-sm` rounded cluster of ghost `Button`s, each a lucide icon + minimal label, wrapped in `AppTooltip`, with `active:scale-[0.88]` press feedback and muted-to-foreground hover tone.

- Preserve the AQU-260 selection guard: `onMouseDown` calls `e.preventDefault()` + `onToolbarMouseDown`; `onMouseUp`/`onMouseLeave` call `onToolbarMouseUp`.
- Props gain `onAskAi: () => void` alongside the existing `onAddToTermbase` / `onTermApply`.
- "View term" lookup behavior is unchanged (still conditional on a concept match).

`EditorTable` gains an `onAskAiFromSelection?(chip: ContextChip)` callback, threaded the same way `onAddConceptFromSelection` is, building the `ContextChip` from `capturedSelectionRef` + the row's `cell`.

## 6. Composer = TipTap atomic chip node

Rebuild `src/components/chat/ChatComposer.tsx` as a minimal single-paragraph TipTap editor (TipTap 3 is already a dependency; see `src/components/TranslatedEditor.tsx`, `src/lib/richtext/footnote-node.ts`, `src/lib/richtext/terminology-chip-plugin.ts`).

- Extensions: `Document`, `Paragraph`, `Text`, `Placeholder`, the new `contextChip` node, and a keymap: **Enter** sends, **Shift+Enter** newline, **⌘/Ctrl+Enter** sends. Auto-focus on mount.
- New atom node `src/lib/richtext/context-chip-node.tsx`: an **inline atom** (`inline: true`, `atom: true`, `selectable: true`) with attrs mirroring `ContextChip`. Rendered via `ReactNodeViewRenderer` as a compact `Badge` (`variant="secondary"`) showing **only `canonicalRef`** (fallback "source"), wrapped in `AppTooltip` whose content is the **full `selection`**, plus an `×` delete control. Atomic: deleted as a whole unit; never edited inline.
- Public props unchanged (`isStreaming`, `isConfigured`, `onSend`, `onStop`, `compact`, `suggestedActions`), except `onSend` now delivers `{ text, chips }` (see §7). Suggested-action chips and the InputGroup-style send/stop affordances are preserved visually.
- An imperative `insertChip(chip)` (exposed via `ref` or a small controller) lets `AgentDockView` insert a chip at the caret when "Ask AI" fires.

## 7. Wire injection (hybrid) — `serializeWithChips`

`AgentDockView.sendPrompt` builds **one** `messages[].content` string; `protocol.ts` and the server are untouched. Pure function in `src/lib/agent/context-chip.ts`:

```ts
serializeWithChips(text: string, chips: ContextChip[]): { wire: string; display: string }
```

- **Inline tokens:** each chip's position is marked `⟦ctx:N⟧` (1-based, insertion order). Rare unicode brackets so it cannot collide with translation text or a cell alias.
- **Legend** (appended after a blank line; self-describing so no L1 change):

```
## Context (attached cells — previews truncated; read full text with one SQL query on file_id+cell_id if needed)
⟦ctx:1⟧ GEN 1:1 · file_id=<uuid> cell_id=<uuid> · source
   "In the beginning God created the heav…"
⟦ctx:2⟧ JHN 1:1 · file_id=<uuid> cell_id=<uuid> · source
   "In the beginning was the Word…"
```

- **Hybrid threshold:** if `selection.length <= 280`, the legend quotes the **full** selection (the common verse case → zero tool calls); otherwise it quotes a `~200`-char truncated preview and relies on the expand hint.
- **`display`** is the prose with each `⟦ctx:N⟧` replaced by `[canonicalRef]`, stored as the run's `prompt` for the user bubble in `AgentRunView`.
- The legend carries raw `file_id`/`cell_id` literals (the project's own coordinates), accepted by the SQL guard which masks string literals before keyword checks.

## 8. Agent expansion — no new tool

When the truncated preview is insufficient, the agent issues one existing `execute({ sql })`:

```sql
SELECT cell_id, canonical_ref, value
FROM cells
WHERE project_id = :project
  AND file_id = '<uuid>' AND cell_id = '<uuid>' AND side = 'source'
```

`:project` is required by the SQL guard; `file_id`/`cell_id` are quoted literals. Multiple chips can be batched in one call via `WHERE (file_id, cell_id) IN (...)`. Results return as the standard compressed pipe-table with UUID aliasing, so the agent can then walk neighbours/anchors through the same SELECT path. No new tool, no schema-card change.

## 9. Vertical-agent placement

- **L1 (always resident):** `buildSystemPrompt` is byte-for-byte unchanged. The legend is self-describing; the schema card already documents the `cells` table keyed by `(project_id, file_id, cell_id, side)`.
- **L2 (on demand):** the user turn's `⟦ctx:N⟧` tokens + truncated-preview legend — present only when chips exist, evicted naturally by the existing ≤10-turn slice (`MAX_WIRE_TURNS`).
- **L3 (escape hatch):** full cell bodies + neighbours, materialised on demand via the one existing SQL SELECT; never resident.

Explicitly **do not** widen `AgentRunRequest.context` to an array or add a `chips` field — that would push chip data into a privileged, always-parsed position and tempt a server-side eager-resolution step that bloats every run.

## 10. Defaults & limits

- Pill label = `canonicalRef`, fallback "source".
- Max **8** chips per message; soft warning past 5.
- Legend capped ~1,500 chars; overflow elided with `…+N more`.
- Per-chip preview cap ~200 chars (full quoted when `selection.length <= 280`).
- Chips are **independent of the context pin** — the pin still binds the focused `:file`/`:cell` separately.

## 11. Files

**New**
- `src/lib/agent/context-chip.ts` — `ContextChip` type, `serializeWithChips`, de-dupe + cap helpers.
- `src/lib/richtext/context-chip-node.tsx` — TipTap inline atom node + React NodeView.
- `src/components/SourceSelectionToolbar.tsx` — shadcn rail-aesthetic selection toolbar.

**Edited**
- `src/components/EditorTable.tsx` — swap in `SourceSelectionToolbar`; build `ContextChip` and call `onAskAiFromSelection`.
- `src/components/chat/ChatComposer.tsx` — TipTap editor + chip node + `{text, chips}` send payload + `insertChip`.
- `src/components/agent/AgentDockView.tsx` — chip state, a `pendingChip`/`onPendingChipConsumed` inbound prop (mirroring the existing `pendingPrompt` pattern) that inserts the chip via the composer's `insertChip` once the dock is mounted, `serializeWithChips` in `sendPrompt`.
- `src/components/ProjectWorkspace.tsx` — hold `pendingChip` state set by `EditorTable`'s `onAskAiFromSelection`, switch the dock to the Agent tab (`setDockTab('agent')`, the externally-controlled tab `LeftDock` already supports), and pass `pendingChip` down to `AgentDockView` (same wiring as the existing suggested-action `pendingPrompt`).
- `src/components/agent/AgentRunView.tsx` — render the `display` prose (with `[ref]`) for the user bubble.

**Unchanged:** `protocol.ts`, `auth-worker/src/routes/agent.ts`, `sql-guard.ts`, `schema-card.ts`, terminology flow.

## 12. Testing

- **Unit (`context-chip.ts`):** `serializeWithChips` token numbering + legend format; hybrid threshold (full vs truncated); chip count / legend caps + `…+N more`; de-dupe on (fileId, cellId, selection).
- **Component:** `SourceSelectionToolbar` renders both buttons and fires `onAskAi` / `onAddToTermbase`; chip node renders `canonicalRef` label, tooltip with full selection, and delete removes the atom; composer send delivers `{text, chips}` and Enter/Shift+Enter behavior.
- **Live (verify-dev-change):** select source → Ask AI → pill appears in composer with tooltip → send → user bubble shows `[ref]`; inspect the outgoing message contains the `⟦ctx:N⟧` tokens + legend.

## 13. Out of scope (v1)

- Target-side chips (data model supports `side: 'target'` trivially; deferred).
- `@`-mention autocomplete in the composer.
- Persisting chips across reloads.
- Server-side chip pre-resolution.

## 14. Risks

- **TipTap composer regressions** vs the current textarea (focus, mobile, paste). Mitigated by keeping the public props stable and covering send/keyboard behavior with tests + live check.
- **Selection-guard timing** (AQU-260/AQU-248) when adding a second toolbar button — preserve the exact `onMouseDown`/`preventDefault` pattern.
- **Legend literals + SQL guard** — confirm quoted `file_id`/`cell_id` literals pass `sql-guard` with `:project` present (covered by an expansion smoke test against the guard).
