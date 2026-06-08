# SWARM ORCHESTRATION — Terminology: Harden + Candidate Discovery (2026-06-08)

**Goal:** Implement wave 1 of `docs/superpowers/specs/2026-06-08-terminology-harden-and-discover-design.md` — candidate-term discovery (c-value/nc-value/G²), interlinear-equivalent prediction (χ² + EM cross-check, managed-vs-AI-assumed), pre-acceptance warning band, LLM-BT terminology seeding — as standalone libs + components that a later glue wave mounts. Wave 2 (org publish/subscribe + add-from-selection) holds until wave 1 is green.

## §0 STOP checklist
- [ ] `npx tsc -b --noEmit` clean on integration
- [ ] `npx vitest run` green incl. new candidate/equivalent/χ²/G² tests
- [ ] `npm run build` passes
- [ ] Candidate discovery: c-value/nc-value ranks multi-word terms; G² keyness flags specialized terms; managed terms excluded; promote-to-Concept works
- [ ] Equivalents: χ² + EM cross-check; managed vs AI-assumed visually distinct; few-shot examples + confidence band shown
- [ ] Pre-acceptance warning band: advisory string-match, never blocks commit (standalone, SWARM-TODO for mount)
- [ ] LLM-BT seeded with preferred renderings
- [ ] every gap has a SWARM-TODO in TRACES.md

## §1 Operating model
- main = sacred; dirty with another actor's in-flight work. NEVER touch it.
- Integration branch: `swarm/integration-term` off clean `31f63f5` (node_modules symlinked).
- Each agent → its own worktree off integration tip. NEW files preferred.
- **FORBIDDEN paths (actor's uncommitted files — agents must NOT create/edit):**
  `src/components/EditorTable.tsx`, `src/components/ProjectWorkspace.tsx`,
  `src/components/onboarding/OnboardingWizard.tsx`, `src/components/onboarding/steps/PrivacyStep.tsx`,
  `src/components/HealthRing.tsx`, `src/pages/Homepage/Homepage.tsx`,
  `src/hooks/useProjectsMembersMatrix.ts`, `src/lib/frontier/members.ts`, `src/lib/frontier/members.test.ts`,
  `src/lib/analytics-consent.ts`, `auth-worker/src/routes/dev-seed.ts`, `auth-worker/src/routes/orgs.ts`,
  `auth-worker/src/services/org-permissions.ts`
- Anything needing a FORBIDDEN file → build standalone + leave a SWARM-TODO for the glue wave.

## §2 Wave history
- Wave 1 dispatched 2026-06-08: WS-CANDIDATES, WS-EQUIV, WS-WARN, WS-BTSEED, WS-QA.

## §3 Workstream registry
| ID | Title | Status | Owns (files) | Notes |
|---|---|---|---|---|
| WS-CANDIDATES | Candidate-term discovery (c-value/nc-value/G²) | dispatched | `src/lib/terminology/candidates.ts` (+test), `src/components/CandidateTermsPanel.tsx` | standalone |
| WS-EQUIV | Interlinear-equivalent prediction (χ²+EM) | dispatched | `src/lib/completion/chi-square-align.ts` (+test), `src/lib/terminology/equivalents.ts` (+test), `src/components/EquivalentsPanel.tsx` | reads interlinear.ts read-only |
| WS-WARN | Pre-acceptance terminology warning band | dispatched | `src/lib/terminology/preacceptance.ts` (+test), `src/components/PreAcceptanceWarningBand.tsx` | SWARM-TODO to mount |
| WS-BTSEED | LLM-BT terminology seeding | dispatched | `src/lib/completion/backtranslation-service.ts` | not forbidden |
| WS-QA | Verification gate + regression tests | dispatched | `docs/swarm/TERM2-QA.md`, new *.test.ts only | drives existing :5173 |

## §4 Merge log
<!-- date · WS · branch · sha · tsc · vitest · notes -->
- 2026-06-08 · WS-WARN · swarm/ws-warn · e0ca7c0 · tsc OK · vitest 8/8 · standalone preacceptance lib+band; SWARM-TODO to mount
