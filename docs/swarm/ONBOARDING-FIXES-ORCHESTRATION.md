# SWARM — Onboarding/Permission fixes (FRO-427..433)

**Goal:** Fix the 7 friction issues from the 2026-06-24 OSI/Dennis onboarding walkthrough.

## §0 STOP checklist
- [ ] tsc clean on integration (`npx tsc -b --noEmit`)
- [ ] vitest green on integration (`npx vitest run`)
- [ ] sync-worker + auth-worker tsc/tests green where touched
- [ ] UI walkthrough (orchestrator-driven) confirms each fix on the golden path
- [ ] every known gap has a SWARM-TODO trace in ONBOARDING-FIXES-TRACES.md
- [ ] promoted to `main`; staging/push decision made with user

## §1 Operating model
- Base: `main` @ a4e53fd71 (synced with origin/main).
- Integration: `swarm/onboarding-fixes` (`.worktrees/swarm-onboarding`, node_modules symlinked).
- Each agent → own worktree off main (Workflow `isolation:'worktree'`). No agent pushes.
- Merge: agent branch → integration → verify → promote to main when green + UI-walked.
- Overlap-risk (accept 3-way merge; do NOT assume sole ownership):
  - import area active in `feat-optimistic-bulk-import-outbox`, `helloao-import` worktrees → WS-D owns it this wave.
  - DOCX round-trip spec owned by another agent — do NOT touch `docs/superpowers/specs/2026-06-23-docx-r2-roundtrip-design.md`.

## §2 Workstream registry
| ID | Issue | Title | Status | Owns (primary) | Forbidden |
|----|-------|-------|--------|----------------|-----------|
| WS-A | FRO-427 | Permission-gated actions fail silently | dispatched | useProjectPermissions.ts; action gating + denial surface | import internals (WS-D), ProjectSettings/Settings (WS-F), Dashboard/ProjectsList (WS-B), auth-worker |
| WS-B | FRO-428 | Project-only invitees can't see/navigate to project | dispatched | Dashboard.tsx, org/ProjectsList.tsx, useAccessibleProjects.ts, project-overview nav/back | invites (WS-C), permission hook edits (WS-A), import (WS-D) |
| WS-C | FRO-429 | Invite links single-use + opaque "expired" | dispatched | SharePanel.tsx, MultiProjectInviteDialog.tsx, auth-worker/src/routes/invites.ts, expired UX | Dashboard/ProjectsList (WS-B), permissions (WS-A) |
| WS-D | FRO-430+431 | Import progress hidden + .doc support | dispatched | ImportDialog.tsx, components/import/*, lib/parsers/docx.ts, lib/import.ts | onboarding ImportFilesStep (WS-E), permission hook (WS-A), DOCX roundtrip spec |
| WS-E | FRO-432 | Onboarding "do this later" skip buried | dispatched | onboarding/OnboardingWizard.tsx, onboarding/steps/ProjectStep.tsx | import internals (WS-D), other onboarding steps unless skip-related |
| WS-F | FRO-433 | Org-level API key management (full impl) | dispatched | pages/Settings.tsx, lib/sync/org-settings.ts, lib/store/user-api-keys.ts, lib/audio/tts.ts, new OrgProviderSection, auth-worker org-settings route | ProjectSettings.tsx structure (read-only), permissions (WS-A) |

## §3 Merge log
<!-- date · WS · branch · sha · tsc · vitest · notes -->
