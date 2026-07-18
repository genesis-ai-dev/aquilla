# SWARM TRACES — Onboarding/Permission fixes

## BLOCKERS (surface to user)
- [RESOLVED in review] (AQU-427) client revoke gate was PROJECT_LEAD(500) but server requires MAINTAINER(600) → silent 403; fixed to MAINTAINER. — MemberAccessPanel.tsx:49
- [RESOLVED in review] (AQU-430) commit failure during preview was swallowed (UploadPanel unmounted); now surfaced via onCommitError → PreviewPanel error banner. — ImportDialog.tsx / PreviewPanel.tsx

## Deferred (need event-layer / forbidden path / cross-actor)
- [OPEN] (AQU-433) org provider key is a SECRET stored in the org-settings JSON blob; GET /:orgId/settings returns it to ANY org member (incl. viewers). This is REQUIRED for client-side TTS fallback per the approved acceptance criteria ("members read/use"), so it is NOT redacted. Hardening follow-up: route org-key TTS through a server-side proxy, or gate org-key READ to a TTS-capable floor (e.g. contributor 400+). — auth-worker/src/routes/org-settings.ts:114
- [OPEN] (AQU-431) legacy binary OLE2 .doc (pre-Word-2007) still fails at JSZip; only OOXML-format .doc parses. Needs a dedicated binary .doc parser. SWARM-TODO left in src/lib/parsers/types.ts.

## Quality / polish
- [OPEN] (AQU-428) useProjectsForNavigation() hook added but Dashboard/ProjectsList wiring is partial; OrgHome "Shared with you" already covers project-only members. Confirm the in-file breadcrumb back-link renders for project-only invitees during UI walkthrough.

## [DONE] resolved traces
<!-- [DONE] (id) what fixed it — commit sha -->
