# UI Glossary — Codex Web App

Canonical names for concepts that appear in the UI, plus the approved verb table
for user-facing approval/status actions. Introduced by FRO-290.

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
| 2026-06-10 | Initial glossary; applied copy pass across src/components + src/pages | FRO-290 |
