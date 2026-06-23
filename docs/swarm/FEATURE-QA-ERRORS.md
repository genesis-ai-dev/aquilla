# Feature QA — Error Log (Phase 2)

> Populated during Phase 2 (testing every user story in the running app). One entry per defect.
> Status legend: `OPEN` → found, not yet fixed · `FIXED` → patched on integration branch · `VERIFIED` → re-tested green (Phase 4).

## Automated-suite run (Phase 2 backbone)
- `npm run build` (tsc -b + vite build): **PASS** — 3165 modules, clean.
- `npm run test` (vitest): **35 failed / 3041 passed** across 10 files. Triage below.
- `npm run test:e2e:smoke`: import-flow specs failing at `Workspace.openImportDialog` (page-object) — see E-IMPORT.

## Triage: vitest failures (mostly STALE TESTS lagging refactors, pending real-UI confirmation)

| ID | File | # | Root cause (from current code) | Classification |
| -- | ---- | -: | ------------------------------ | -------------- |
| T-ORGCTX | src/context/OrgContext.test.tsx | 5 | `OrgContext.tsx:2,29` legitimately calls `useLocation()`; test renders `OrgProvider` with no `<Router>` wrapper → `useLocation() may be used only in the context of a <Router>`. Product is correct (App mounts it inside Router). | STALE TEST (test debt / logistical) |
| T-ORGSW | src/components/org/OrgSwitcher.test.tsx | 3 | Same family — renders without required Router/context. | STALE TEST (probable) — confirm |
| T-LOGIN | src/pages/Login.test.tsx | 7 | Test queries `/aquilla username or email/i`; `/login` page (`Login.tsx:67-69`) intentionally renders label **"Username or email"** (the "Aquilla" prefix is kept only on the dialog form `FrontierLoginForm.tsx:63`). | STALE TEST |
| T-IMPCOL | src/components/ImportDialog.collision.test.tsx | 6 | Dialog now opens on `screen="landing"` (`ImportDialog.tsx:134,173`), a type-selection screen, before `"upload"`. Tests immediately query "Upload Files" without first choosing the Upload type. | STALE TEST — confirm import works in UI |
| T-IMPPART | src/components/ImportDialog.partial-import.test.tsx | 5 | Same landing-screen change. | STALE TEST — confirm in UI |
| T-MEMB | src/components/ProjectMembersPage.test.tsx | 4 | `title="Revoke all access to this project"` exists (`ProjectMembersPage.tsx:310`) but is gated on session + maintainer+ role; test setup likely doesn't satisfy the gate. | NEEDS CHECK (test setup vs real gating regression) |
| T-INTER | src/components/InterlinearAlignmentPanel.test.tsx | 1 | Tooltip title copy drift (`/confirm.*reject|reject.*confirm/i`). | STALE TEST (probable) |
| T-CRED | src/components/org/CreditsPanel.test.tsx | 1 | `enforce=false` notice assertion. | NEEDS CHECK |
| T-ORGHOME | src/components/org/OrgHome.test.tsx | 2 | Pending-invite card + attention-rank ordering assertions. | NEEDS CHECK |
| T-AUTH | src/lib/frontier/auth.test.ts | 1 | `posts credentials and persists session` hits `127.0.0.1:8787` (ECONNREFUSED) — test expects a backend/mock not present in unit run. | STALE/MISCONFIGURED TEST |

> **Note:** "stale test" failures are a real **logistical defect in the test suite** (red `npm run test`) and are in-scope for Phase 3 — but they are NOT user-facing UX bugs. User-facing impact for each ambiguous row is being confirmed by the real-UI walkthrough.

## User-facing defects (from real-UI walkthrough — Phase 2)

| ID | Story / Feature | Severity | Type | Repro steps | Observed | Expected | Screenshot | Status |
| -- | --------------- | -------- | ---- | ----------- | -------- | -------- | ---------- | ------ |
| E-IMPORT | Import a file (open import dialog) | TBD | TBD | e2e `Workspace.openImportDialog` times out; landing-screen refactor suspected. Verify by driving real UI: open project → Import. | _pending UI walkthrough_ | Import dialog opens, file uploads, appears in sidebar | _pending_ | INVESTIGATING |
