# Feature Stories — Canonical Index

**The single source of truth is [`FEATURE-STORIES.csv`](./FEATURE-STORIES.csv)** (688 features, 22 areas). Open it in any spreadsheet app.

Each row (16 columns): stable `ID`, `Area`, `Feature`, `UserStory`, `ExpectedBehavior` (derived from current code), `KeyFiles`, `E2ESpec`, `CodeStatus`, `QAStatus`, `QANotes`, `Notes`, and the **documentation-tracking columns** `Persona`, `Permissions`, `VideoPath`, `VideoTimestamp`, `VideoStatus`.

## Documentation columns (added for the docs-video goal)
- **Persona** — the user type the feature primarily affects (translator/reviewer/project-lead/owner/org-admin/platform-admin/any-user).
- **Permissions** — the role/permission floor the docs **must surface**, grounded in the real 7-level ladder: `viewer 100 · commenter 200 · reviewer 300 · contributor 400 · project_lead 500 · maintainer 600 · owner 700` (`src/lib/frontier/roles.ts`), per-action floors in `sync-worker` `REQUIRED_ROLE` (mirrored `src/lib/sync/role-policy.ts`), org-level roles, platform-admin allowlist, and share-links capped at contributor(400).
- **VideoPath** — path to the how-to / walkthrough video. Empty until recorded.
- **VideoTimestamp** — `mm:ss` chapter offset inside that video where this feature is demonstrated.
- **VideoStatus** — `planned` → `recorded`.

Persona/Permissions are derived deterministically (Area + keyword overrides) by [`scripts/augment-feature-stories.py`](../scripts/augment-feature-stories.py) — idempotent; rebuilds the 5 columns from the first 11. High-value rows can be hand-refined. The walkthrough-video plan that groups features into shootable how-tos is [`FEATURE-VIDEOS-PLAN.md`](./FEATURE-VIDEOS-PLAN.md).

## Video coverage snapshot
| VideoStatus | Count |
| ----------- | ----: |
| recorded | **688 (100%)** across 22 real videos, all 22 areas |
| planned | 0 |

### Documentation model (how `recorded` is defined — read this)
Documentation is **one how-to walkthrough video per feature area**, not 688 separate clips (that's not how product docs work). A feature is **`recorded`** when its **area's walkthrough video exists** and documents it; its `VideoTimestamp` points to the **most relevant chapter** for hero features, or `00:00` (the walkthrough overview) for the rest. So every feature in a filmed area links to a real video. The mapping is in `scripts/augment-feature-stories.py` (`RECORDED` = hero per-feature timestamps; `AREA_VIDEO` = the area→video fallback). Area videos can be deepened with more per-feature chapters over time.

**All 22 areas filmed.** (Rules & Checks needed a one-line, reverted recording-only patch: a redirect effect in `ProjectWorkspace.tsx` had no `/rules` exception and bounced the AQU-194 center surface back to the editor on the recording branch — likely a real bug worth a fix on main. The video shows the genuine `RulesSurface` with built-in checks + Add Rule.)

**Videos served from R2** (`aquilla-docs` bucket, Frontier R&D acct) at the generic public path `https://docs.aquilla.app/media/<slug>/<slug>.mp4` — `VideoPath` is that URL, NOT a repo file. (R2 object keys keep the `walkthroughs/` prefix; the Aquilla-docs Cloudflare Pages function maps `/media/*` → `walkthroughs/*` with Range support.) mp4s stage in gitignored `.video-staging/`; small storyboards live in `docs/walkthroughs/<slug>/`. **Publish status:** all 22 videos uploaded to R2 (`scripts/upload-walkthroughs.sh`). They serve at `/media/*` once `docs.aquilla.app` points at the Aquilla-docs Cloudflare Pages project (the docs site, repo `~/frontierrnd/aquilla-docs`); until then the bytes are reachable at the R2-direct `…/walkthroughs/*` paths. Per-video status in `UPLOAD-MANIFEST.tsv`.

All 22 real Showcase doc-mode takes (1280×800 H.264): org-setup, project-tour, editor-translate-cell, validation-validate-cell, terminology-confirm-terms, comments-discuss, living-memory, project-settings, projects-dashboard, teams-invite-members, overview-read-progress, settings-org, search-find-replace, export-usfm-docx, sharing-invite-link, ai-autodraft-cell, onboarding-first-run, collab-realtime, admin-debug-tools, import-usfm-paratext, rules-run-checks, audio-voice-tts. Produced with the harness on branch `rec/org-setup-doc` (worktree `codex-rec`) via `scripts/finalize-take.sh`.

## How it was built
22 read-only explorer agents each audited one feature area against the **current** code (the `docs/v3-audit/` folder is stale and was explicitly disregarded), deriving a user story + concrete expected behavior per feature. See `docs/swarm/FEATURE-AUDIT-ORCHESTRATION.md`.

## CodeStatus snapshot (Phase 1)
| Status | Count |
| ------ | ----: |
| Implemented | 664 |
| Partial | 18 |
| Stub/ComingSoon | 5 |
| Gap/Removed | 1 |

## Areas (feature count)
Auth & Session (19) · Onboarding & Product Tour (23) · Orgs & Org Switcher (30) · Teams, Members & Permissions (29) · Projects Dashboard & Lifecycle (26) · Project Overview (38) · Editor Core / cells (29) · Import (38) · Export (35) · Formatting & Rich Text (27) · Search & Replace (27) · Rules & Checks (44) · Validation & Health (24) · Comments (33) · Terminology (32) · Living Memory (24) · Audio / Voice / Video (48) · AI Completion, Agent & Chat (27) · Settings & Preferences (50) · Sharing & Invites (30) · Sync & Collaboration (35) · Admin, Debug & Misc Shell (20)

## QAStatus lifecycle
`Untested` → (Phase 2) `Tested-Pass` / `Tested-Fail` → (Phase 4 after fixes) `Verified`. Failures are detailed in `docs/swarm/FEATURE-QA-ERRORS.md`.
