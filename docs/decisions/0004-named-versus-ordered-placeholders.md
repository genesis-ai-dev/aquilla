# 0004 — Named versus ordered placeholders

*Decided 2026 (AQU-2385); recorded 2026-11-05 (AQU-2387).*

## Context

Decision 0003 verifies that a translation carries the same inline tokens as its
source. "Same" has to mean something precise, because word order is exactly
what translation changes. A rule that demanded identical token order would
reject correct translations into languages that put the subject last; a rule
that ignored order would accept `%s` and `%s` swapped — two values printed into
the wrong slots, with no error anywhere.

The distinction is not ours to invent: it is the localization convention these
placeholder grammars already carry.

## Decision

A token's **identity** decides whether a translator — human or model — may
move it. The classification lives in
`db/shared/inline-tags.ts::classifyInlineTag` and is carried on
`db/shared/inline-tags.ts::InlineTagKind`:

- **Named placeholders carry their own identity** — `{name}`, `{0}`, `%1$s`,
  `%(name)s`, `<x id="1"/>`. They may appear in any order in the target.
- **Ordered (unnamed) placeholders are positional** — `%s`, `%@`, `{}`. Their
  relative order *is* their meaning, so a reorder is a defect, not a style
  choice.
- **Point tokens** (`<br/>`, `<img …>`) carry no identity and keep their order.
- **Paired tags** must stay balanced and keep their order.

`db/shared/inline-tags.ts::verifyInlineTags` enforces exactly that: same
multiset, balanced pairs, same order for every order-bearing token, and named
placeholders free to move. The only reordering repair, in
`db/shared/inline-tags.ts::repairInlineTags`, rewrites point-token order and
refuses the moment a paired tag is in the sequence.

## Consequences

- A model that moves `{count}` to the end of a sentence passes; one that swaps
  two `%s` fails and lands in quarantine. That asymmetry is intended and is the
  reason the kinds exist at all.
- Adding a placeholder grammar means deciding which of the four kinds it is
  before adding the pattern — an unnamed grammar classified as named silently
  licenses reordering that corrupts output.
- The rule is one shared module, so the in-app completion path and the Agent
  API draft tool cannot disagree about whether a reorder is a defect.

## Not covered yet

- Nothing checks that a *source* text's placeholder grammar is internally
  consistent; a file mixing `%s` and `%1$s` is accepted as-is.
- There is no per-project override: a project cannot declare "our placeholders
  may always move".
