# Terminology — Harden v1, Candidate Discovery, then Org-Share (2026-06-08)

**Status:** design, pre-swarm.
**Goal:** Close the gap between the shipped terminology/BT v1 and the aquilla spec, in three waves: (1) harden + extend the dedicated view with candidate-term discovery and interlinear-equivalent prediction, then (2) org termbase publish/subscribe + add-from-selection.
**Spec sources:** `~/frontierrnd/aquilla-specs/04-features/terminology.md`; `docs/superpowers/specs/2026-05-31-bt-terminology-design.md`.

## Ground truth (verified live, 2026-06-08, build `fe48dd2`)

Driven against `:5173` dev stack as seeded `dev` user. Confirmed WORKING:
- Terminology view routed at `/project/:id/terminology`; console clean.
- Library Overview stats live (Active concepts, Enforced %, Infringed %, Cells analyzed = 3701 — dev project HAS cells).
- CRUD + CSV/TBX import-export; seeded concept `grace`→`gracia` (required/approved).
- Per-term drill-down ([TerminologyTermDetail](../../../src/components/TerminologyTermDetail.tsx)) with an **occurrences surface** ("N occurrences in loaded cells").

Verified by code inventory as WIRED (not driven live this pass — wave-1 slice 1 confirms):
- Markov glosser ([bt-glosser.ts](../../../src/lib/completion/bt-glosser.ts)) auto-runs on commit, seeded from termbase.
- LLM BT ([backtranslation-service.ts](../../../src/lib/completion/backtranslation-service.ts)) on-demand polish; persists via `cell.backtranslation.set` → D1 `cell_backtranslations` (migration 0021).
- Interlinear alignment ([interlinear.ts](../../../src/lib/completion/interlinear.ts), [InterlinearAlignmentPanel.tsx](../../../src/components/InterlinearAlignmentPanel.tsx)) — Dice cold-start → IBM Model 1 EM; confirm/invalidate; seeds sync via `ProjectWideSettings.alignmentSeeds`.
- Term chips ([terminology-chip-plugin.ts](../../../src/lib/richtext/terminology-chip-plugin.ts)) + popover ([TermLookupPopover.tsx](../../../src/components/TermLookupPopover.tsx)).

## The deterministic/probabilistic contract (governs the whole design)

The prediction engine is **probabilistic** — the interlinear aligner and the gloss few-shot prompts use in-context learning, so equivalents are *suggestions*, not facts. The termbase is **deterministic** — a managed Concept rendering is a decision the user owns. Every surface MUST keep these visually and semantically distinct. The candidate-discovery view is the bridge: it lets the user promote a probabilistic suggestion into a deterministic managed term with one click.

---

## Wave 1 — Harden v1 + Candidate Discovery

Disjoint-ownership slices, each ending in a live-UI walkthrough.

### Slice 1 — Verification gate (runs first, gates the rest)
Drive the live stack: add concept → chips render in editor → popover opens → Apply replaces target selection → BT auto-generates on commit → BT survives reload → interlinear confirm/invalidate persists to D1 → terminology violation appears in cell infraction list + inbox. Output: a checklist of actual vs. implied behavior. Any slice whose target already works becomes a regression test, not a build.

### Slice 2 — Candidate-term discovery (NEW; in the dedicated view)
A "Candidate terms" surface in the terminology view that mines likely key terms the user should manage. Pure business logic in `src/lib/terminology/candidates.ts` (no network, derived-on-read, no materialized table); reuses the loaded-cells corpus the occurrences surface already reads.

Term-extraction stack (replaces the earlier TF-IDF sketch):
- **C-value** — domain-standard multi-word term extraction. Ranks candidate n-grams by frequency *adjusted for nestedness* (a phrase that mostly appears inside longer phrases is downweighted), so genuine multi-word terms surface above incidental collocations.
- **NC-value** — extends C-value with **context weighting**: words that recur adjacent to candidate terms (specific verbs/adjectives) boost the candidate. ~25% more accurate on multi-word extraction; the right default for the ranked list.
- **Log-Likelihood (G²) keyness** — compares the project source against a **general reference corpus** to isolate words/phrases that appear *unexpectedly often*, i.e. specialized terms most worth human glossary review. Used for single-token specialized terms and to flag "review-worthy" candidates.
- Already-managed source terms are excluded (or shown as "managed").
- **One-click promote** candidate → `draft`/`active` Concept.
- `log()`/surface any coverage cap (e.g. "ranked over loaded cells only").

**G² reference corpus:** default to (a) rest-of-corpus / sibling-project frequencies; (b) a bundled general-frequency list per language when available. No Strong's/lemma baseline — keep the metric source-language-agnostic. Surface the chosen baseline in the UI.

### Slice 3 — Interlinear-equivalent prediction (NEW; managed vs AI-assumed)
For each candidate (and in the per-term drill-down), show likely target equivalents.
- Pull equivalents from the in-progress alignment model ([interlinear.ts](../../../src/lib/completion/interlinear.ts)).
- **χ² (chi-square) alignment** as a cheap, deterministic cross-check: measure independence of each (source-token, target-token) pair across the bilingual WIP corpus to predict the most associated target word. Surfaces a candidate equivalent without waiting for IBM Model 1 EM to warm up, and corroborates/contests the EM prediction (agreement → higher confidence). Lives alongside the existing aligner, not replacing it.
- **Hard visual separation:** "managed" (deterministic Concept renderings) vs "AI-assumed" (predicted glosses) — distinct treatment, never blended.
- Predicted glosses show **nearby example wording** (the few-shot context the prediction drew from) to signal probabilistic origin; show confidence band (HIGH/AMBER/LOW from the aligner).
- Apply/promote a predicted gloss → it becomes a managed rendering (crossing the deterministic line is an explicit user act).

### Slice 4 — Pre-acceptance terminology warning band
Advisory string-match band on AI completions: forbidden-present / preferred-absent. No server round-trip; re-renders against post-accept BT verdict. Mount in the copilot completion path ([ProjectWorkspace.tsx](../../../src/components/ProjectWorkspace.tsx)). Advisory only — never blocks commit.

### Slice 5 — LLM-BT terminology seeding + surface confirmations
- Plumb preferred renderings as examples into [backtranslation-service.ts](../../../src/lib/completion/backtranslation-service.ts) (statistical glosser already seeds; LLM doesn't).
- Confirm terminology verdicts land in the cell infraction list AND the violations inbox grouped by concept (distinct from rule names); confirm the stale-BT badge is visible. Fix if not.

---

## Wave 2 — Org termbase publish/subscribe + add-from-selection

Dispatched only after wave 1 merges green. Owns sync-worker + migrations additively.

### Slice 6 — Publish
`org_published_termbase` flag (maintainer+, org-owned project); discoverable by other org projects.

### Slice 7 — Subscribe / unsubscribe / reorder
`project_termbase_subscriptions(project_id, termbase_project_id, priority)` join table. Subscribed concepts stack into enforcement + lookup (union semantics, display-order priority in v1). Q19-style implicit `viewer` grant on upstream. Cache active concept-set per project per request; invalidate on subscription/concept change. Edge: subscription to deleted/archived termbase → concepts stop appearing, row persists, "subscription unavailable" hint.

### Slice 8 — Add-concept-from-selection
Source-token select in the editor → "add to termbase" → lands as `draft` Concept without leaving the editor.

## Deferred (traced, not dropped)
Per-language lemmatizer (v1 = exact/normalized match), dictionary documents (track 2), AI concept suggestions + review queue, merge-duplicate-concepts, server-emitted `cell.terminology.verdict` (v1 derives client-side), localization.

---

## Pre-mortem

| # | Failure | Likelihood | Guard |
|---|---|---|---|
| P1 | Slices rebuild already-working features (docs lagged code) | High | Slice 1 hard gate: verify-before-build; "already works" → regression test |
| P2 | Stale worktree base — late agents recreate merged work | High | Manual worktrees off live HEAD; diff returned branches before merge; no `isolation:worktree` for late dispatch |
| P3 | QA from isolated swarm port fails dev login (auth-worker CORS only trusts standard dev origin) | High | QA agent merges to the branch the running `:5173` stack serves, reloads there |
| P4 | Org publish/subscribe migration never applied to live Neon (D1→Neon drift) | Med | Wave 2 owns migrations additively; diff live Neon schema before blaming code |
| P5 | Terminology verdicts double-surface or block commits | Med | v1 advisory-only contract explicit; inbox grouping by concept kept distinct from rule names |
| P6 | Probabilistic predictions presented as deterministic facts (the core contract) | Med | Hard visual/semantic separation managed vs AI-assumed; few-shot examples + confidence band on every prediction; promotion is explicit |
| P7 | Candidate mining slow, or G² needs a reference corpus that doesn't exist per language | Med | C-value/NC-value need only the project corpus (no reference); G² degrades to rest-of-corpus baseline when no bundled list exists; derived-on-read; split viewport cost from aggregate; surface coverage cap |
| P10 | χ² and IBM Model 1 disagree on equivalents, confusing the user | Low-Med | Treat agreement as confidence boost, disagreement as AMBER; both stay clearly "AI-assumed", never managed |
| P8 | Editor-file ownership collisions (EditorTable/ProjectWorkspace) | Med | Disjoint ownership; warning-band, stats, BT-seed own separate files; glue serialized last |
| P9 | BT/interlinear perf regression on large files | Low-Med | Reuse `shouldAutoRecomputeBt` staleness gate |

## STOP checklist
- [ ] `npx tsc -b --noEmit` clean · `npx vitest run` green (incl. new candidate/equivalent tests)
- [ ] `cd sync-worker && npx tsc --noEmit && npm test` green (wave 2)
- [ ] Candidate discovery demo-true: TF-IDF candidates surface, managed terms excluded, promote works
- [ ] Equivalents demo-true: managed vs AI-assumed visually distinct, few-shot examples + confidence shown, promote crosses the line explicitly
- [ ] Org-share demo-true (wave 2): publish → subscribe → subscribed concepts enforce + lookup; add-from-selection lands draft
- [ ] every remaining gap has a SWARM-TODO trace
