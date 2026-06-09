# E2E User-Journey Map

> The canonical mapping of user journeys to spec files. AI coders: when adding a feature, grep this file by keyword. If your feature touches a journey here, **extend that spec**. If it's new, **add a row + new spec**.

| Area        | Journey                                              | Spec                                                          | Smoke? |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------- | :----: |
| Auth        | API-level login (covered implicitly by every multi-user spec via `ensureAuthState`) | `e2e/helpers/auth.ts` |  n/a   |
| Auth        | UI sign-up / login flow                              | _gap — Plan 2 (no `/login` route; login lives in onboarding)_ |        |
| Auth        | Password reset request                               | _gap — Plan 2_                                                |        |
| Auth        | Switch between two signed-in accounts                | _gap — Plan 2_                                                |        |
| Onboarding  | First-run flow to dashboard                          | _gap — Plan 2_                                                |        |
| Projects    | Create project, appears on dashboard                 | `e2e/specs/projects/create.smoke.spec.ts`                     |   ✅   |
| Projects    | Open / delete / restore from trash                   | _gap — Plan 2_                                                |        |
| Orgs        | Create org                                           | _gap — Plan 2_                                                |        |
| Orgs        | Add member to org, member sees it                    | `e2e/specs/orgs/members.smoke.spec.ts` (API setup + UI verify) |   ✅   |
| Orgs        | Invite member → member sees all org projects         | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 1)        |        |
| Orgs        | Create team → attach project/user → group path fires | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 2)        |        |
| Orgs        | Revoke org membership → project disappears           | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 3)        |        |
| Orgs        | Full revoke (all paths) → 403 on project endpoint    | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 4)        |        |
| Orgs        | Detach group project → role falls back to org baseline | `e2e/specs/orgs/org-access-lifecycle.spec.ts` (test 5)      |        |
| Orgs        | Remove member, change role                           | _gap — Plan 2_                                                |        |
| Orgs        | Send & accept invite                                 | _gap — Plan 2_                                                |        |
| Editor      | Import markdown, edit cell, persists across reload   | `e2e/specs/editor/import-and-edit.smoke.spec.ts`              |   ✅   |
| Editor      | Cmd+K search                                         | _gap — Plan 2_                                                |        |
| Editor      | Virtualization scroll integrity                      | _gap — Plan 2_                                                |        |
| Rules       | Enable built-in rule, see violation in editor        | `e2e/specs/rules/violation.smoke.spec.ts`                     |   ✅   |
| Rules       | Define custom rule                                   | _gap — Plan 2_                                                |        |
| Rules       | Auto-correct a violation                             | _gap — Plan 2_                                                |        |
| Validation  | Validate a cell, indicator turns emerald             | `e2e/specs/validation/validate.smoke.spec.ts`                 |   ✅   |
| Validation  | History persists across navigation                   | `e2e/specs/validation/validation-persists-navigation.smoke.spec.ts` | ✅ |
| AI          | Sparkle button fills cell from mock LLM              | `e2e/specs/ai/completion.smoke.spec.ts` (IDB-injected settings)            | ✅ |
| Collab      | File propagates from alice to bob                    | `e2e/specs/collab/file-propagation.smoke.spec.ts` (API project bootstrap)  | ✅ |
| Collab      | Concurrent cell edit propagates alice → bob          | `e2e/specs/collab/concurrent-edit.smoke.spec.ts` (API project bootstrap)   | ✅ |
| Collab      | Conflict resolution on same cell                     | _gap — Plan 2_                                                |        |
| Collab      | Member presence indicators                           | _gap — Plan 2_                                                |        |
| Comments    | Add / edit / resolve comment                         | _gap — Plan 2_                                                |        |
| Sharing     | Generate invite link / join project via link         | _gap — Plan 2_                                                |        |
| Audio/Video | Import audio file                                    | _gap — Plan 2_                                                |        |
| Audio/Video | Subtitles flow                                       | _gap — Plan 2_                                                |        |
| Settings    | Settings sync between two browsers                   | _gap — Plan 2_                                                |        |
| Settings    | Settings persist across reload                       | `e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts`    |   ✅   |
| Export      | Export to each supported format                      | _gap — Plan 2_                                                |        |
| Tauri       | Native dialogs / deeplink / updater / fs / keychain  | _gap — Plan 3_                                                |        |

## How to add a journey

1. Pick the right `<area>` directory under `e2e/specs/`. If your journey doesn't fit any existing area, create a new folder.
2. Filename convention: `<journey>.spec.ts` for full-suite, `<journey>.smoke.spec.ts` for the pre-push gate.
3. Use `import { test, expect } from "../../helpers/multi-user"` if your test needs `alice`/`bob`/`carol`. Use `import { test, expect } from "@playwright/test"` for single-user, plus `await resetBackend()` in your own `beforeEach`.
4. Reuse page objects under `e2e/helpers/page-objects/`. Add a new one if no existing class fits.
5. Add a row to this table.
6. Run `npm run test:e2e:smoke` (or full `npm run test:e2e`) to verify.

## Manual checklists

Human-clickable walkthroughs for journeys where automation misses visual or UX edge cases:

| Area | Checklist |
|------|-----------|
| Orgs — access lifecycle (FRO-144) | `e2e/manual-checklists/org-access-walkthrough.md` |
