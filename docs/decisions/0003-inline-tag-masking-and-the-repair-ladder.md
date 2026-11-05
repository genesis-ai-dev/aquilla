# 0003 — Inline-tag masking and the repair ladder

*Decided 2026 (AQU-2385); recorded 2026-11-05 (AQU-2387).*

## Context

Cells carry inline formatting tokens — paired markup, point tokens like
`<br/>`, placeholders. A model asked to translate that text will cheerfully
translate a tag name, reflow a pair, drop a placeholder or "tidy" the markup,
and the damage lands in a draft that otherwise looks finished.

Telling the model not to is not a mechanism. Checking afterwards and throwing
the draft away is a mechanism, but an expensive one: most damage is one surplus
duplicate or one moved point token.

## Decision

Four rungs, in order, around **every** model call that drafts translated text.
The rules are pure functions in `db/shared/inline-tags.ts`, shared by the
in-app completion path (`src/lib/completion/tag-protection.ts`) and the
server-side agent draft tool (`auth-worker/src/lib/agent/tools/draft.ts`), so
one model call cannot be protected differently from another.

1. **Prevent** — `db/shared/inline-tags.ts::maskInlineTags` replaces every
   inline tag with an opaque sentinel carrying a per-call nonce, so the model
   never sees markup it could translate. One batch prompt shares a single nonce
   and ordinal sequence, so no two cells can mint the same sentinel.
2. **Detect** — `db/shared/inline-tags.ts::verifyInlineTags` compares the
   restored target against the source: same tag multiset, balanced pairs, the
   same order for every order-bearing token, and no sentinel residue
   (`db/shared/inline-tags.ts::leakedSentinels`).
3. **Repair** — `db/shared/inline-tags.ts::repairInlineTags` fixes exactly two
   cheap deterministic shapes, surplus duplicates and point-token order, and
   returns a candidate *only* when that candidate re-verifies. Paired tags are
   never reordered; a damaged pair is refused outright.
4. **Quarantine** — anything still unverified keeps its fidelity warning and
   lands as an unvalidated draft for a human. `db/shared/inline-tags.ts::settleTagLadder`
   is the whole ladder as one call, and its verdict is `clean`, `repaired` or
   `unverified`.

A repair may promote a quarantine to a clean commit. **It may never lower the
guarantee.** There is no LLM-repair rung: a second model call to fix the first
one's markup was considered and left out.

## Consequences

- Masking is the only rung with an escape hatch — a per-browser switch,
  `src/lib/completion/tag-protection.ts::INLINE_TAG_MASKING_STORAGE_KEY`, for a
  model that handles the sentinel grammar badly. Detection, repair and
  quarantine never switch off, so turning masking off degrades draft quality,
  never fidelity.
- A cell that is nothing but tags is not sent to a model at all
  (`db/shared/inline-tags.ts::isTagsOnlyText`): the source is copied across.
- Repair is deliberately narrow. Adding a shape means proving it re-verifies,
  not loosening `verifyInlineTags`.

## Not covered yet

- `originalHtml`, `translatedHtml` and the IDML style catalog are out of scope:
  masking sits only around the model call.
- The IDML/Biblica protected-markup path opts out entirely and keeps its own
  anchor contract rather than having two protection schemes fight.
