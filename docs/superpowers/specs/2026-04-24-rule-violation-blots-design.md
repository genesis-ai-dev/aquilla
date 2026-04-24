# Rule violation blots

**Date:** 2026-04-24
**Status:** Draft spec — awaiting review

## Problem

Today when a cell breaks a rule, the only visible signal is an icon in the editor's right gutter ([EditorTable.tsx:936](src/components/EditorTable.tsx)). The user sees "this cell has an issue" but has to open a separate panel to learn *which rule* and *which text* triggered it. The cell itself gives no pointer — the offending substring is visually identical to clean text.

`RuleInfraction` is cell-level only ([types.ts:65](src/lib/parsers/types.ts)): `{ ruleId, cellId, fileId, message }`. The rule engine runs regex patterns per check but discards match indices, so there is currently no data to drive inline highlighting even if the renderer wanted to show it.

A second problem sits alongside this: when predictions are made, `HighlightedText` paints `<mark>` backgrounds on source tokens that matched the examples used ([HighlightedText.tsx:13](src/components/HighlightedText.tsx)). These "evidence blots" are visually loud and occupy the same column we'd want to use to signal source-side rule triggers. Introducing violation blots without softening evidence would cause the two meanings to collide.

## Goals

- Show the triggering text span for each rule violation inline in the cell, not just in a separate panel.
- Cross-side violations (rule reasons about source *and* target) paint the trigger on whichever side the signal actually lives — often the source for "this source construct should have produced a target match" rules.
- Let the user waive a specific violation on a specific cell with an optional reason, preserving the waiver as an auditable editorial decision (not a hidden UI preference).
- Keep the existing example-evidence highlights available but softened and gated, so they don't compete with violation signals for attention.
- Degrade gracefully when a rule has no concrete span to highlight (e.g., absence rules with no source trigger) — the gutter icon remains as the fallback.

## Non-goals

- No "report false positive" flow — the rule-amendment flow in the rule detail sidebar already covers that.
- No bulk "waive all instances of this rule" action — per-cell only.
- No keyboard navigation between blots in v1.
- No merging of multiple spans for the same rule into a single decoration — N spans render as N blots.
- No change to how rules are suggested, authored, or saved ([RuleSuggestDialog.tsx](src/components/RuleSuggestDialog.tsx) is untouched).

## Architecture

### Data model changes

In [src/lib/parsers/types.ts](src/lib/parsers/types.ts):

```ts
export interface InfractionSpan {
  side: "source" | "target"
  start: number       // character offset into the side's plain text
  end: number         // exclusive
  matchedText: string // captured for debugging and popover context
}

export interface RuleInfraction {
  ruleId: string
  cellId: string
  fileId: string
  message: string
  spans: InfractionSpan[] // empty for absence rules with no identifiable trigger
}

export interface RuleWaiver {
  ruleId: string
  reason?: string
  waivedAt: string     // ISO timestamp
  waivedBy?: string    // user id if available; optional because local-only projects may not have one
}

export interface Cell {
  // existing fields unchanged
  waivers?: RuleWaiver[] // per-cell, per-rule; absent/empty means no waivers
}
```

Waivers live on the cell because they are editorial decisions that (a) must survive reload and re-check, (b) should serialize with the translation into the file format, and (c) must sync through y-partyserver ([project_y_sweet_migration.md](~/.claude/projects/-Users-ryderwishart-prototypes-codex-web-app/memory/project_y_sweet_migration.md) in auto-memory). A side-channel map keyed by `(fileId, cellId, ruleId)` was considered and rejected: cell renames or re-id events would orphan waivers silently.

### Rule engine changes

In [src/lib/rules/rule-engine.ts](src/lib/rules/rule-engine.ts), `checkRulesForCell()` and the per-check-type helpers need to return spans alongside the boolean/message they already produce.

Mapping of check type → which side carries spans:

| Check type | Where spans live | What gets matched |
|---|---|---|
| `target-forbids` | `target` | the forbidden pattern match in target |
| `source-target-match`, target has no matching region while source has the trigger | `source` | the source trigger (absence on target → highlight the source cause) |
| `source-target-match`, target matches but source lacks the expected trigger | `target` | the unexpected target match (absence on source → highlight the target cause) |
| `source-requires-target`, source trigger present and target missing it | `source` | the source trigger token(s) whose presence requires a target match |
| `source-requires-target`, no identifiable source trigger | — | `spans: []`; gutter icon only |

General principle: spans always live on whichever side has a concrete regex match. An absence gets no span; it is explained by the span on the opposite side (the "trigger"). When neither side yields a concrete match, the violation is gutter-only.

Regex match indices come from `RegExp.prototype.exec` / `matchAll` — no new parsing. Every existing check that currently does `pattern.test(text)` is upgraded to iterate matches and record `{ start, end, matchedText }`. All matches in a cell produce blots (not just the first).

### Rendering layers

Two decoration channels in the cell renderer. Both live in the underline layer so they cannot collide with character color/weight, and their shapes distinguish them from each other.

**Evidence layer (soft, gated):**
- Style: 2px gradient underline fading at edges ("horizon underline"). Low saturation.
- Rendered only when the examples panel is expanded for the active cell or column.
- Source of truth: the existing `HighlightedText` pathway, extended with a `variant` prop.

**Violation layer (crisp, always on):**
- Style: wavy squiggle underline (same visual vocabulary as spellcheckers / linters).
- Color: severity-mapped — red for major (AlertTriangle), amber for minor (AlertCircle). Same severity source as the existing gutter icons, so they stay in sync.
- Waived violations render with reduced opacity (e.g., `opacity-40`) so the waiver is still auditable inline — waivers do not hide the decoration, they down-rank it.

Implementation per cell-type:
- **TipTap target cells** (`TranslatedEditor`): ProseMirror `Decoration.inline` set, rebuilt when `infractions` or `waivers` change. Decorations are derived, not content — they never appear in serialized XML / ProseMirror JSON.
- **Plain-textarea fallback target cells**: overlay `<span>` layer absolutely-positioned over the textarea (same technique as the existing search highlight, if any; otherwise a new small component `CellDecorationOverlay`).
- **Source column**: extend the existing `HighlightedText` to accept both `evidence` ranges and `violation` ranges with per-range variants.

### Click / hover interaction

Each rendered violation span is the anchor for an inline popover (shadcn `Popover`, controlled):

- **Rule name** — clickable → dispatches the same action as the gutter icon (`onInfractionClick`), opening the rule in the detail sidebar.
- **Message** — the `RuleInfraction.message` verbatim.
- **Waive button** — opens a small inline form (single-line reason input, optional; Submit / Cancel). On submit, appends a `RuleWaiver` to the cell's `waivers` array.
- **Unwaive button** — shown if the popover's `(cellId, ruleId)` is already waived. Removes the matching waiver.
- **Waived state** — if waived, the popover shows `Waived {relative time} — {reason}` above the Unwaive button.

The gutter icon keeps its existing role as the coarse "this cell has N issues" affordance and remains the primary target for users who prefer not to click the small inline blot. Clicking the gutter icon continues to fire `onInfractionClick`.

### Module layout

New files:
- `src/components/CellDecorationOverlay.tsx` — shared primitive for absolutely-positioned spans over a text surface (used by plain-textarea cells and the source column).
- `src/components/ViolationPopover.tsx` — popover content; takes `{ infraction, cell, onWaive, onUnwaive, onOpenRule }`.
- `src/lib/rules/waivers.ts` — pure helpers: `isWaived(cell, ruleId)`, `waive(cell, ruleId, reason)`, `unwaive(cell, ruleId)`, `filterInfractions(infractions, cell)` (for callers that want to partition active vs waived).

Modified files:
- `src/lib/parsers/types.ts` — new `InfractionSpan`, `RuleWaiver`; extend `RuleInfraction` and `Cell`.
- `src/lib/rules/rule-engine.ts` — capture regex spans per check type.
- `src/components/HighlightedText.tsx` — add `variant: "evidence" | "violation"` prop, drop the always-on `<mark>` background in favor of the underline styles above.
- `src/components/EditorTable.tsx` — thread infractions + waivers into rendered cells; wire up the decoration layers; keep gutter icons as-is.
- `src/components/TranslatedEditor.tsx` — integrate the ProseMirror decoration set.

### Data flow

```
rule-engine.checkRulesForCell(cell, rules)
  → RuleInfraction[] with spans

waivers.filterInfractions(infractions, cell)
  → { active: RuleInfraction[], waived: RuleInfraction[] }

EditorRow renders:
  - active infractions   → crisp squiggle blots
  - waived infractions   → muted squiggle blots
  - evidence (if examples expanded) → horizon underlines
  - gutter icons (counts active only; waived do not contribute to gutter severity)
```

Waived infractions are excluded from the gutter-icon count so the coarse "has issues" signal reflects what still needs attention. Inline blots remain visible (muted) so the waiver is not invisible.

### Persistence and sync

Waivers are ordinary cell fields. They:
- Serialize with the existing cell persistence path. The implementation plan will verify the exact parser/serializer touch-points (`src/lib/parsers/`) and include any round-trip tests needed.
- Sync via the existing y-partyserver pipeline — no new sync surface.
- Are not included in validation-history diffs in v1; waive/unwaive is an editorial action on the cell but not a translation edit. (Can be revisited if users want waivers audited alongside text edits.)

## Testing

- Unit tests for `rule-engine` span extraction per check type (including multi-match cells).
- Unit tests for `waivers.ts` pure helpers.
- Component tests for `ViolationPopover` (waive flow, unwaive flow, reason input).
- Integration test in `EditorTable`: cell with one target-forbids violation renders a squiggle at the right offsets, clicking opens the popover, waiving moves the squiggle to muted state and decrements the gutter count.
- Visual regression / manual check: evidence underline + violation squiggle composed on the same span read as two distinct signals.

## Open questions

None blocking. Items deferred to follow-ups:
- Should waive events appear in validation history? (Non-goal in v1; revisit if requested.)
- Rule-level "mute on this file" — belongs in rule detail sidebar if wanted; not in this spec.
- Keyboard-driven navigation between blots — deferred.
