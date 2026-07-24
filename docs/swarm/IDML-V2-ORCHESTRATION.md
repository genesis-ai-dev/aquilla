# SWARM ORCHESTRATION — Production IDML Round-Trip v2

**Goal:** Ship one strict IDML v2 contract across Aquilla and Codex Editor without silent skips, anchor loss, or formatting-run corruption.

## §0 STOP checklist

- [ ] Shared package browser and Node conformance tests are green.
- [ ] Aquilla `npm run build` is green.
- [ ] Codex compile and webview builds are green.
- [ ] Affected worker tests are green.
- [ ] Direct-web and Codex-migration producer/consumer tests are green.
- [ ] Targeted real-fixture IDML smoke test is green.
- [ ] Complete Aquilla smoke suite is green before push.
- [ ] Adobe open/preflight/save/reopen/PDF corpus gate is green before `native` is enabled.
- [ ] Experimental/content-only copy remains truthful until the Adobe gate passes.

## §1 Operating model

- The stale `kieran/idml-import` checkout is read-only reference material.
- Aquilla implementation branches start at live `origin/dev`.
- The dirty Codex HTML-repair checkout is forbidden; Codex IDML work uses a clean worktree after that prerequisite lands.
- AQU-704 is the current accumulation branch: `codex/aqu-704-idml-v2-engine`.
- Temporary worker branches use the same AQU ticket, never push, and merge only after their focused tests pass.
- The orchestrator owns integration, full verification, Linear transitions, and any push/deploy.

## §2 Wave history and control plane

- 2026-07-24: Created AQU-704 through AQU-709 under AQU-551; dispatched AQU-704.
- 2026-07-24: Created clean Aquilla worktree from `origin/dev` at `22796d3c`; baseline `npm run build` passed.
- 2026-07-24: Began shared package v2 contract and first implementation wave.

## §3 Workstream registry

| ID | Title | Status | Owns | Notes |
| --- | --- | --- | --- | --- |
| AQU-704-A | Protected HTML and legacy upgrade | Ready | `html.ts`, `legacy.ts`, focused tests | Exact anchor identity/order |
| AQU-704-B | Defensive UCF/ZIP inspection | Ready | `archive.ts`, focused tests | Central-directory safety + UCF |
| AQU-704-C | XML parse and surgical export | Ready | `xml.ts`, `engine.ts`, focused tests | Stable paths + verbatim replacement |
| AQU-704-I | Integration fixtures and gates | Active | package config, shared fixtures, orchestration | Root orchestrator |

## §4 Merge log

Append each verified worker merge with date, branch, SHA, build/test result, and remaining traces.
