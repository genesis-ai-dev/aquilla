# 0005 — The partner-integrations seam

*Decided 2026 (AQU-1286); recorded 2026-11-05 (AQU-2387). Convention:
`docs/PARTNER-INTEGRATIONS.md`.*

## Context

Some code in this repo belongs to a publisher: Biblica's importers today,
others later. It cannot be deleted casually, and it cannot be published with
the open-source copy of the app. The usual way that goes wrong is a static
`import "…/biblica/register"` somewhere generic — after which removing the
folder is a typecheck error, and the "optional" partner is load-bearing.

## Decision

Publisher code lives in `src/partner-integrations/`, and any folder named
`partner-integrations` at any depth is partner-owned. Two rules hold:

1. **Nothing outside such a folder imports from inside one.** Generic code
   reaches partner code only through `src/lib/partners/registry.ts`, which
   discovers `register.ts` modules with a Vite `import.meta.glob`. A glob that
   matches nothing is an empty object, not a compile error — which is the whole
   point. It is not to be replaced with a static import list.
2. **Deleting the folders leaves the app compiling, building and running**,
   with that partner's import options simply absent.
   `scripts/make-public-copy.ts` produces the open-source copy by filtering
   them out, and fails if a partner copyright notice survives anywhere else.

The absent case is directly testable: `src/lib/partners/registry.ts::integrationsFrom`
is the derivation split out from the glob, so `integrationsFrom({})` is exactly
what the app sees once the partner folders are stripped — no real glob can be
made to match nothing in a test.

## Consequences

- The glob is eager, because some seams must be synchronous: the IDML
  completion path normalizes HTML inside a sync function and cannot await a
  registry. So `register.ts` stays small — descriptors and sync hooks — and
  everything heavy (parsers, panels) hangs off a thunk on the descriptor and
  stays code-split.
- Generic behaviour has to be correct with an empty registry, not merely
  tolerant of it: `src/lib/partners/registry.ts::normalizeIdmlTargetHtmlWith`
  with no partners is the identity function, which is the right generic answer.
- A module without a default export is skipped rather than throwing, so a
  half-written `register.ts` costs that one integration and not the import
  dialog.
- Partner attribution flows through import profile ids
  (`src/lib/partners/registry.ts::partnerIdForImportProfile`, decision 0001),
  so a partner's files stay recognisable without generic code naming the
  partner.

## Not covered yet

- String-level leakage is only partly guarded; `docs/PARTNER-INTEGRATIONS.md`
  tracks the known gaps, and the copyright scan in
  `scripts/make-public-copy.ts` is the backstop, not a proof.
- Nothing prevents a *new* generic module from importing a partner path; the
  seam is enforced by the public-copy script and review, not by the typechecker.
