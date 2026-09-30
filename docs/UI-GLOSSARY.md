# UI Glossary — Codex Web App

Canonical names for concepts that appear in the UI, plus the approved verb table
for user-facing approval/status actions. Introduced by AQU-290.

**Rule:** if a term or verb is on this list, use it everywhere in user-facing
strings (labels, tooltips, aria-labels, descriptions, dialog text). Never use
the "Banned" alternatives or internal spec IDs in the UI.

---

## Concept names

| Concept | Canonical UI name | Banned / replaced |
|---|---|---|
| Batch AI translation | **Translate all** | ~~Complete all~~, ~~Run AI completions~~, ~~Draft AI translations~~ |
| Single-cell AI translation | **Translate with AI** | ~~Generate translation~~, ~~Run AI completion~~ |
| Stop batch AI translation | **Stop translating** | ~~Stop AI completions~~ |
| In-progress batch progress banner | **Translating…** (with progress bar) | ~~AI completions running~~ |
| Pending server sync queue | **Pending changes** | ~~Outbox inspector~~, ~~audit events queue~~ |
| Sync status chip tooltip (synced) | **All changes synced** | ~~All audit events synced~~ |
| Sync status chip tooltip (failed) | **Could not sync changes to the server** | ~~Could not sync audit events~~ |
| Project glossary / terminology store | **term base** (two words) | ~~termbase~~ (one word) |
| Term base sharing section | **Term Base Sharing** | ~~Termbase Sharing~~ |
| AI reference examples (for translation) | **reference examples** | ~~few-shot examples~~ |
| Word-level audio timing data | **word timings** | ~~karaoke timings~~ |
| Original file stored on server for round-trip export | **original file data** | ~~side-car bytes~~ |
| Nearby cells used for confidence scoring | **nearby context** | ~~retrieval neighborhood~~ |
| Cell confidence / health indicator text | **Needs attention — nearby context cells haven't been validated yet** | ~~retrieval neighborhood hasn't been validated yet (AD-14)~~ |
| Decay-derived confidence signal (cell expansion tab + project settings panel) | **Health** | ~~Retrieval support~~, ~~support score~~ |

---

## Approval / status verbs per object type

These verbs are **deliberately different** per object — do not unify them.

| Object | Positive action | Positive state | Negative action | Negative state |
|---|---|---|---|---|
| **Translation cell** | validate | validated | (none — replace/edit) | unvalidated |
| **Terminology concept** | approve | approved | deprecate | deprecated / old |
| **Terminology rendering** | — | approved / admitted | — | rejected |
| **Word alignment (interlinear)** | confirm | confirmed | reject / invalidate | rejected / invalidated |

**Notes:**
- "Validated" is reserved for translation cells only. Do not use it for terminology entries.
- "Approved" is reserved for terminology concepts/renderings. Do not use it for cells.
- "Confirmed" and "rejected/invalidated" are reserved for word-level alignment pairs.
- These distinctions let power users talk precisely about which layer they are acting on.

---

## Terminology enforcement — flag, never auto-replace

Settled by AQU-764. The team could not point at a written answer to "does a
non-approved rendering get flagged or silently replaced?", so this is it.

**Terminology flags. It never rewrites a translator's text.** Concepts compile
to ordinary translation rules (`src/lib/terminology/compile.ts` →
`src/lib/rules/rule-engine.ts`) which are evaluated *on read* — no verdict is
materialized and no target text is mutated. Compiled terminology rules carry no
`autofix`, so the autofix path in `src/lib/rules/autofix.ts` never touches them.
This is deliberate: an approved rendering is not safe to substitute
context-blind (the "general *lord* vs *Adonai* vs *Yahweh*" case).

| Situation | Check emitted | Severity |
|---|---|---|
| Source bears the concept, target has none of its approved renderings | `source-requires-target` | `minor` |
| Target contains a forbidden rendering | `target-forbids` | `major` |

**Both severities are soft. Nothing terminology-related hard-blocks.** Severity
drives presentation and triage only — icon and colour in the rule drawer and the
cell issues tab, and the `violation-major` / `violation-minor` ribbon marks. A
translator can commit, validate, and export a cell that carries either, and any
infraction can be waived. Rule and check violations are also a *sibling* surface
to health: per AD-14 they are never folded into the health score.

Draft and deprecated concepts compile to nothing at all.

---

## Banned internal spec IDs in UI strings

The following patterns must never appear in user-facing string literals:

- `AD-\d+` (architecture decision IDs, e.g. `AD-14`)
- `CP-\d+` (cross-platform spec IDs)

These are internal references. Use plain English in tooltips, descriptions, and labels.
The lint guard test `src/components/ui-jargon-guard.test.ts` enforces this.

---

## Change log

| Date | Change | Issue |
|---|---|---|
| 2026-06-10 | Initial glossary; applied copy pass across src/components + src/pages | AQU-290 |
| 2026-09-27 | "Retrieval support" renamed back to **Health** on the cell expansion tab and the project-settings decay panel; terminology enforcement documented as flag-only, soft-warn | AQU-764 |
