# Feature Stories — Canonical Index

**The single source of truth is [`FEATURE-STORIES.csv`](./FEATURE-STORIES.csv)** (688 features, 22 areas). Open it in any spreadsheet app.

Each row: stable `ID`, `Area`, `Feature`, `UserStory`, `ExpectedBehavior` (derived from current code), `KeyFiles`, `E2ESpec`, `CodeStatus`, `QAStatus`, `QANotes`, `Notes`.

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
