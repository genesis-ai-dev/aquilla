# SWARM ORCHESTRATION — Production IDML Round-Trip v2

**Goal:** Ship one strict IDML v2 contract across Aquilla and Codex Editor without silent skips, anchor loss, or formatting-run corruption.

## §0 STOP checklist

- [x] Shared package browser and Node conformance tests are green for the AQU-704 tracer corpus.
- [x] Aquilla `npm run build` is green on the AQU-704 integration branch.
- [ ] Codex compile and webview builds are green.
- [x] AQU-704 transferable IDML worker protocol tests are green.
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
| AQU-704-A | Protected HTML and legacy upgrade | Merged | `html.ts`, `legacy.ts`, focused tests | 40 focused tests; exact identity/order |
| AQU-704-B | Defensive UCF/ZIP inspection | Merged | `archive.ts`, focused tests | 22 tests; central/local safety + UCF |
| AQU-704-C | XML parse and surgical export | Merged | `xml.ts`, `engine.ts`, focused tests | Stable paths + verbatim replacement |
| AQU-704-H | Runtime/structural hardening | Merged | engine, archive, worker protocol, conformance tests | Tabs, cancellation, fingerprints, directories |
| AQU-704-I | Integration fixtures and gates | Active | package config, shared fixtures, orchestration | Multipart legacy proof + root build |

## §4 Merge log

- 2026-07-24 · AQU-704-B · `codex/aqu-704-archive` · `5c4e72eb` · package build ✅ · archive tests 22/22 ✅ · no open trace.
- 2026-07-24 · AQU-704-A · `codex/aqu-704-html` · `6afcab61` · package build ✅ · HTML/legacy tests 40/40 ✅; combined package 62/62 ✅ · no open trace.
- 2026-07-24 · AQU-704-C · `codex/aqu-704-engine` · `3caaf1f0` · structural parser and strict surgical export merged.
- 2026-07-24 · AQU-704-H · `codex/aqu-704-engine` · `e9d558bc` (integrated as `bff6bd76`) · browser worker, tabs, structural fingerprints, explicit directories, progress/cancellation, and lossless Biblica semantics; package tests/build ✅.
- 2026-07-24 · AQU-704-I · integration branch · legacy Codex parts now resolve only to exact, non-overlapping source slots and aggregate into one paragraph replacement; structural apostrophe and `<Br/>` bytes remain untouched; combined package tests 137/137 ✅ and package build ✅.
