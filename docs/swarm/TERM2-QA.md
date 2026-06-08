# TERM2 — Terminology Wave-1 Verification Gate (Slice 1)

Spec: `docs/superpowers/specs/2026-06-08-terminology-harden-and-discover-design.md` (Wave 1, Slice 1).
Driven live against the running `:5173` + `:8788`/`:8789` dev stack as seeded `dev` user, build `fe48dd2`.

## Pass 1 — capability table

| # | Capability | Verdict | Evidence |
|---|---|---|---|
| 1a | Terminology view: stats render | **WORKS** | `/project/dev-project/terminology` — Library Overview: Active concepts 1, Enforced 0%, Infringed 0%, **Cells analyzed 3701**. Console clean (0 errors on this route). |
| 1b | Terminology CRUD | **WORKS** | Add-concept dialog renders fully (source term, renderings w/ status select, notes, status). Created "Anutu"→Dio (draft) and "Dio"→God (active) live; both appeared in the Concepts list. Edit/Delete buttons present per row. |
| 1c | CSV / TBX export | **WORKS** (buttons present) | "Export CSV" + "Export TBX" buttons in the header. (Buttons confirmed; file download not opened in headless.) Import button present. |
| 1d | Per-term drill-down + occurrences | **WORKS** | "Anutu" drill-down → **"646 occurrences"** with highlighted source paragraphs. (The seeded "grace" concept shows "0 occurrences" only because its source term is English while the dev file source is Adzera — see Data note.) |
| 2a | Managed-term CHIPS render in editor | **WORKS** | After creating an **active** ("approved") concept "Dio", the editor shows **3 `.term-chip.term-chip-preferred` spans**, each `data-source-term="Dio"`, `aria-label="Managed term: Dio"`, decorating the matching tokens in the **target (Italian)** editor text. |
| 2b | Clicking a chip opens TermLookupPopover | **WORKS** | Dispatching a click on a chip opens `role=dialog` / `role=tooltip` with `aria-label='Terminology lookup for "Dio"'`. Handler is delegated via `target.closest(".term-chip[data-source-term]")` in `TranslatedEditor.tsx`; `handleTermChipClick` in `EditorTable.tsx` sets controlled popover state anchored to the chip. |
| 2c | "Apply" replaces target selection | **PARTIAL** | Apply affordance exists and is gated on a non-empty target selection (`targetHasSelectionRef`), but `handleTermApply` **APPENDS** the rendering to existing text (`existing ? existing + " " + rendering : rendering`) — it does NOT replace the selected range. Spec wording "Apply replaces target selection" is not met literally. |
| 3a | BT auto-generates (statistical glosser) | **WORKS** | Cell-details BT panel shows generated statistical BT text. Polish toggle aria-label = "Polish off: statistical-only BT" → confirms the displayed BT is the Markov glosser output, polish off by default. |
| 3b | BT persists / survives reload | **WORKS** | `GET .../files/<id>/backtranslations => 200` fires on every load; BT panel re-renders correctly after a full page reload. |
| 3c | Polish toggle + stale marker | **WORKS** | "Polish" toggle present; **"Stale — translation has changed"** marker + "Translation changed — click to regenerate BT" Regenerate control visible in the BT area. |
| 4a | Interlinear / alignment panel in BT area | **WORKS** | InterlinearAlignmentPanel renders an **ALIGNMENT** section: source→target token pairs with confidence % (e.g. `miamun → sua 70%`, `bingan → gracia 100%`, `gubuꞌ → perché 78%`). |
| 4b | Confirm / invalidate controls exist | **WORKS** | Per-pair buttons: `aria-label="Confirm miamun → sua"` / `"Invalidate miamun → sua"` for every pair. |
| 4c | Confirm / invalidate persists | **WORKS** | Clicking Confirm fires `PATCH /api/v2/projects/dev-project/settings => 200` (the `ProjectWideSettings.alignmentSeeds` path per spec). Panel re-renders intact after reload. |
| 5a | Terminology violation in cell infraction list | **PARTIAL (mechanism present, not driven live)** | Verified by code: `src/lib/terminology/compile.ts` compiles active concepts → `source-requires-target` / `target-forbids` TranslationRules, wired through `src/hooks/useRules.ts`, surfacing via the existing rule/infraction path (ViolationPopover, Issues tab). Could NOT fire a live violation: no managed source term exists in the Adzera source corpus (seed mismatch), so the Issues tab showed no terminology infraction. |
| 5b | Violations inbox grouped by concept | **NOT-PRESENT** | No terminology-specific inbox component exists (only generic `ViolationPopover` / `RulesSurface` and org-level `AssignedToMe`). Terminology verdicts ride the generic rule infrastructure; there is no by-concept grouping distinct from rule names. Matches Slice 5's own gap note. |

## Environment / data notes (NOT bugs)

- **Console 500 on `GET /api/v2/orgs/22/settings`** repeats on editor load. Unrelated to terminology — org-settings endpoint (likely D1→Neon drift). Project-scoped settings (`/projects/dev-project/settings`) return 200. Flag separately; does not block terminology.
- **Seed language mismatch.** Dev file declares Source=English / Target=Italian, but the actual source cells are **Adzera** (adz) and targets are Italian. The seeded concept `grace→gracia` is English/Italian, so its English source term never matches the Adzera source → "0 occurrences", no chips, no violations from that seed. This is why live verification required creating new concepts ("Anutu" matched 646 source occurrences; "Dio" matched target text for chips). Not a code defect, but it makes the default seed a poor terminology demo.
- Alignment pairs are noisy at cold start (`bingan → gracia 100%`, `anutu → la 83%`) — expected Dice cold-start quality before IBM Model 1 EM warms; presented as probabilistic, not a bug.

## Verdict — already-done (→ regression test only) vs genuinely-missing

**Already works end-to-end (build agents must NOT rebuild — add regression tests, then extend):**
- Terminology view: stats, CRUD, CSV/TBX export buttons, per-term drill-down + occurrences (1a–1d).
- Editor managed-term chips + TermLookupPopover open (2a, 2b).
- Statistical BT auto-gen, persistence/reload, Polish toggle, stale marker (3a–3c).
- Interlinear alignment panel with per-pair confirm/invalidate persisting to ProjectWideSettings (4a–4c).
- Terminology enforcement *mechanism* (compile-to-rules → derived-on-read infractions) (5a, code-verified).

**Genuinely missing / divergent (real build targets):**
- **Apply = append, not replace** (2c). Decide intended semantics; if "replace selection" is the contract, fix `handleTermApply`. Otherwise correct the spec wording. Low effort.
- **By-concept violations inbox** (5b) — does not exist. Slice 5 build target. Verdicts currently indistinguishable from generic rule names.
- **Live terminology-violation demo** (5a) is unverified end-to-end purely due to seed mismatch. Recommend a regression test using a concept whose source term is present in source cells (e.g. seed an Adzera concept, or fix the dev seed's source language). Cheap to make demo-true.

**Wave-1 NEW slices (unbuilt, expected):** Slice 2 candidate discovery (`src/lib/terminology/candidates.ts` — absent), Slice 3 χ²/equivalent prediction surface, Slice 4 pre-acceptance warning band, Slice 5 LLM-BT terminology seeding. These are net-new and correctly not yet present.
