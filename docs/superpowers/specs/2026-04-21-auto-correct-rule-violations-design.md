# Auto-correct rule violations

**Date:** 2026-04-21
**Status:** Draft spec — awaiting review

## Problem

The project already has an LLM that analyzes validated edits and proposes translation rules (`rule-suggester.ts`). Once rules exist, `rule-engine.ts` flags cells that break them, and `RuleDrawer` shows the user every cell breaking a given rule alongside cells that follow it.

The gap: the user has no way to act on those violations in bulk. They must navigate to each cell and edit it by hand, or ignore the rule. This feature closes that gap by letting the user (1) invoke an LLM-backed "try to fix all" at the rule level, (2) review proposed changes per cell, and (3) apply them with multi-select. Surgical single-cell fixes are available via a per-row sparkle button. The rule can also be amended if inspection reveals false positives.

## Goals

- User can click one button to attempt an LLM-generated fix for every current violation of a rule.
- LLM prefers a single programmatic (regex) fix applicable to all violating cells; falls back to per-cell semantic rewrites only when a regex fix isn't possible and there are ≤10 violations.
- Every fix is previewed per cell before any commit. User multi-selects and applies; nothing is ever auto-applied.
- Successful regex fixes are saved to the rule so future violations can be resolved without another LLM call.
- Individual violations can also be fixed surgically via a sparkle icon on each row.
- All LLM calls and applied fixes are counted on the project for future cost/throttling work. No hard budget in v1.
- Users can amend a rule's check or saved autofix from the same UI surface — useful when they realize a flagged cell is actually a false positive.

## Non-goals

- Automatic application of fixes (no "auto-correct on save" behavior).
- Cross-project or organizational fix libraries.
- Server-side budget enforcement. Counters live on the project, synced via the existing pipeline.
- Per-rule counters in v1 (they can be derived from cell history via author tags).
- Changing how rules themselves are suggested or defined. This feature consumes existing rule types.

## Architecture

### Module layout

New module at `src/lib/rules/autofix.ts`, siblings to the existing `rule-engine.ts` and `rule-suggester.ts`:

- `requestBatchFix(rule, violations, settings, session) => Promise<FixProposal>` — cascades programmatic → semantic.
- `requestSurgicalFix(rule, cell, settings, session) => Promise<FixProposal>` — single-cell rewrite.
- `applyRegexFix(autofix, translated) => string` — pure function, applies a saved regex to one cell's translated text.
- `applyLiteralFix(find, replace, translated) => string` — pure function for literal substring replacement (replace-all).

New usage helper at `src/lib/usage/record-usage.ts`:

- `recordLlmCall(project, { kind, model, provider })` — mutates `project.usage.llmCalls` and persists.
- `recordFixApplied(project)` — increments `project.usage.fixesApplied`.

New hook at `src/hooks/useAutofix.ts` — orchestrates request → preview → apply, handles cached-regex short-circuit, and wires in usage counters.

New UI component at `src/components/FixReviewPanel.tsx` — sheet-over-editor presentation of previews with multi-select apply.

### Types (in `src/lib/parsers/types.ts`)

```ts
export type RuleAutofix =
  | { kind: "regex-replace"; pattern: string; replacement: string; flags: string }

export interface TranslationRule {
  // existing fields unchanged
  autofix?: RuleAutofix
  autofixAttemptedAt?: string  // ISO timestamp; null / absent means never tried
}

export interface ProjectUsage {
  llmCalls: Record<string, {
    total: number
    byModel: Record<string, number>
    byProvider: Record<string, number>
  }>
  fixesApplied: number
}

export interface ProjectRecord {
  // existing fields unchanged
  usage?: ProjectUsage
}
```

### Runtime types (not persisted)

```ts
type FixProposal =
  | { kind: "regex-replace"; pattern: string; replacement: string; flags: string; previews: FixPreview[] }
  | { kind: "per-cell"; previews: FixPreview[] }
  | { kind: "none"; reason: string }

interface FixPreview {
  cellId: string
  fileId: string
  before: string
  after: string
  find?: string      // only for per-cell; literal substring being replaced
  replace?: string
  source: "llm" | "cached-regex"
}
```

### LLM contract

**Attempt 1 — programmatic (always runs first):**

System prompt tells the LLM to return one of:

```json
{ "kind": "regex-replace", "pattern": "…", "replacement": "…", "flags": "gi", "rationale": "…" }
```

or:

```json
{ "kind": "none", "reason": "…" }
```

User message includes: rule name/description/severity/check, up to 5 following examples sampled from passing cells, and up to 10 breaking examples sampled from current violations.

Server-side validation: regex must compile, and applying it to at least one breaking example must change the text. Otherwise coerce to `{kind: "none"}`.

**Attempt 2 — per-cell semantic (only if attempt 1 returned `kind: "none"` AND `violations.length ≤ 10`):**

System prompt asks for:

```json
{
  "kind": "per-cell",
  "fixes": [
    { "cellId": "…", "find": "exact substring in translated", "replace": "…", "rationale": "…" }
  ]
}
```

User message: rule details + every violating cell with `{cellId, source, translated}`.

Hallucination guard: each fix is validated by checking `find` is a verbatim substring of that cell's current `translated`. Fixes that fail validation are discarded silently (not surfaced to the user).

**Surgical path (sparkle button):** identical to attempt 2 but always called with exactly one cell. No programmatic attempt.

**Parameters:** reuses `CompletionSettings` (same plumbing as `rule-suggester.ts`). `maxTokens` clamped to 2048 for attempt 1 and 4096 for attempt 2. `temperature` 0.2. `systemPrompt` is overridden per call; rest flows from project settings.

**Errors:** network, timeout, parse failure all become `{kind: "none", reason: "Could not apply fixes"}`. No "AI" language in user-facing copy.

### Cached path

When `rule.autofix` exists, `useAutofix` first tries the cached path: run `applyRegexFix` over current violations. If at least one cell changes, produce a `FixProposal.kind = "regex-replace"` with those previews marked `source: "cached-regex"`. Preview-before-apply still runs — a stale saved regex cannot silently corrupt new cells; user sees the result first.

If the cached regex produces zero changed cells (the saved fix no longer matches any current violation), `useAutofix` falls back to the full LLM cascade. The saved autofix is left intact — it may still be useful for cells that haven't appeared yet — but the UI surfaces a hint "Saved autofix didn't match current violations; trying a fresh analysis." in the panel header.

### Apply semantics

"Apply N selected" iterates through checked previews and commits each via `commit-cell-edit` (existing pipeline — same as human edits). Commit author tag is `autofix:rule-<ruleId>` so cell history can distinguish autofix edits from human or regular-LLM edits.

Between preview generation and commit, each cell is re-read and the fix re-applied against current `translated`. If the fix no longer applies cleanly, that cell is skipped and a summary toast reports it (`"Applied 11 of 12 — 1 skipped because the cell changed"`).

`rule.autofixAttemptedAt` is set whenever a batch attempt completes (regardless of outcome) so the drawer can show "Last tried: …". `rule.autofix` is persisted only after at least one preview from a newly-returned regex fix has been successfully committed — "saved autofix" therefore means "user has validated this fix worked for at least one real violation." Subsequent invocations on this rule take the cached path.

### Counters

`autofix.ts` calls `recordLlmCall(project, { kind, model, provider })` immediately after every LLM response — success, parse failure, or hallucination guard reject all count, because the call was made and billed regardless.

`useAutofix` calls `recordFixApplied(project)` once per successful batch-apply invocation (not per cell) and once per successful surgical-apply. Batch apply counts as a single fix regardless of how many cells were touched. If every cell in a batch errors, no increment.

`rule-suggester.ts` gets a one-line retrofit to call `recordLlmCall(project, { kind: "rule-suggestion", ... })` so existing rule-suggestion calls are counted under the same system.

Kind keys in v1: `"autofix-batch-regex"`, `"autofix-batch-semantic"`, `"autofix-surgical"`, `"rule-suggestion"`. Unknown keys are tolerated on read; counters initialize lazily.

## UX

### Rule drawer

Header gains two actions next to the existing severity icon and close button:

- **Try to fix all** — primary button. Disabled while a fix session is pending. Text changes to spinner + "Analyzing…" (LLM path) or "Applying cached fix…" (cached regex).
- **Amend rule** — ghost button. Links to `/project/:id/rules?ruleId=<id>&focus=autofix`.

Below the action row, a subtle label shows `Saved autofix: regex /foo/gi → bar` (if `rule.autofix` exists) or `No saved fix yet`.

Each "Breaking this rule" row gains a sparkle icon-button on the right. Click opens an inline `before → after` preview in the row with Apply / Cancel.

### Fix review panel

Opens as a sheet over the editor (reuses `src/components/ui/sheet.tsx`) when "Try to fix all" produces previews.

- Header: rule name, severity icon, count (`"12 violations, 12 previews ready"`), and a mode badge (`Batch regex`, `Per-cell rewrite`, or `Cached regex`).
- Body: scrollable list. Each row has a checkbox (all pre-checked), cell location (`"File X, Row 42"`), `before` text (red-tinted strikethrough), `after` text (green tint), and a rationale tooltip if one was provided.
- Footer: "Apply N selected" primary button (N updates as user toggles checkboxes), "Select all" / "Select none" toggles, Cancel.
- Failure state (`{kind: "none"}`): panel opens with an empty state, the LLM's `reason` text, an `Amend rule` button, and a hint arrow back to the drawer's sparkle icons for surgical.

After apply: panel closes, toast confirms `"Applied N fixes"`, drawer refreshes and fixed cells move from "Breaking" to "Following" as `rule-engine` re-runs on updated cells.

### Rules page

Each rule row gains:

- **Try to fix all** button, visible only when current violations exist (cheap check via the existing `infractions` map).
- **Amend** chevron that expands an inline editor for the rule's check and saved autofix.

Mount-time: if the URL contains `?ruleId=X&focus=autofix`, the matching rule is scrolled into view, expanded, and the autofix field receives focus.

Header line underneath the page title shows a subtle summary: `"123 fixes applied · 45 LLM calls this project"`. Hover tooltip breaks out the `byModel` / `byProvider` split.

## Data flow

**New rule, first invocation:**

1. User clicks "Try to fix all" in `RuleDrawer`.
2. `useAutofix` gathers current violations via `rule-engine`.
3. `requestBatchFix` makes LLM call with keep/break examples + violation samples.
4. On success: `FixProposal.kind = "regex-replace"`, previews computed locally.
5. `FixReviewPanel` renders. User toggles selections.
6. Apply: commits flow through `commit-cell-edit`. On first successful commit, `rule.autofix` is saved.
7. Usage counters increment.

**Existing autofix, recurring violations:**

1. User clicks "Try to fix all".
2. `useAutofix` detects `rule.autofix`. Computes previews locally via `applyRegexFix`. No LLM call. No counter increment for LLM.
3. Rest is identical. `recordFixApplied` still increments on successful apply.

**Semantic fallback:**

1. Same as new-rule path, but attempt 1 returns `{kind: "none"}`.
2. Violations count ≤ 10 → attempt 2 runs with per-cell prompt.
3. Hallucination guard filters bad `find` strings.
4. `FixProposal.kind = "per-cell"`. Review panel badge shows "Per-cell rewrite."
5. Apply uses `applyLiteralFix` per cell. `rule.autofix` is NOT saved (per-cell fixes are not reusable).

## Edge cases

- **Content safety:** fixes operate only on `cell.translated`. Never reads or writes `cell.original`, filename, or other fields. Applied through `commit-cell-edit` so Yjs sync, cell history, and health engine all fire normally.
- **Regex errors at apply time:** wrapped in `try/catch`. That cell is skipped and its row shows an error badge, unchecked by default.
- **Multi-occurrence:** per-cell uses replace-all (`split(find).join(replace)`); regex uses LLM-supplied flags (prompt nudges toward `gi`).
- **Staleness between preview and apply:** re-compute against current `translated`. If fix no longer applies cleanly, skip and include in the summary toast.
- **Concurrency:** one in-flight fix session per rule (button disabled until panel closes). Sparkle buttons disable per row.
- **Two-tab race on `rule.autofix`:** last-write-wins via Yjs. Acceptable — both tabs would be producing structurally similar fixes.
- **Surgical runaway:** soft throttle in `useAutofix` rejects a surgical request when 3 are already in flight for the same rule.

## Testing

- `autofix.test.ts` — pure logic: `applyRegexFix` / `applyLiteralFix` correctness, hallucination guard, cascade decision tree with a mocked `complete()` (same pattern as `rule-suggester.test.ts`).
- Parse tests for each LLM output shape plus malformed responses.
- `useAutofix.test.ts` — preview generation, multi-select apply, counter increments, cached-regex path skips LLM.
- `FixReviewPanel.test.tsx` — checkbox state, apply-count wording, empty state with `reason`, sparkle inline preview.
- `RuleDrawer.test.tsx` — new buttons, sparkle rows, disabled states.
- `RulesPage.test.tsx` — `?ruleId=X&focus=autofix` query-param handling, inline autofix editor.
- Manual gate before completion: open a real project, create a regex-amenable rule with current violations, run batch fix end-to-end, verify cell history shows `autofix:rule-<id>` author tag, verify counters increment, repeat with a semantic rule (≤10 violations) to confirm fallback.

## Out of scope / future work

- Per-rule stats on the rules page. Can be derived later by filtering cell history on the `autofix:rule-<id>` author tag.
- Hard budget enforcement with server-side counters (would require Frontier D1 changes).
- Auto-application of fixes on save. Intentionally avoided — all fixes are user-initiated.
- Organization-level shared autofix library.
