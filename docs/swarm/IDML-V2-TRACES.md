# SWARM TRACES — IDML Round-Trip v2

## BLOCKERS

- [OPEN] Adobe automation requires a licensed InDesign or InDesign Server runtime. Keep `native` disabled until AQU-709 records a green corpus run.
- [OPEN] Codex integration must wait for the current HTML-repair work to land; do not touch its dirty checkout.

## Deferred to dependent tickets

- [OPEN] AQU-705 — TipTap protected-anchor extension, direct import/export UI, source artifact path, and smoke journey.
- [OPEN] AQU-706 — Codex shared-package adapter, Quill blots/Delta guards, and Biblica profile convergence.
- [OPEN] AQU-707 — metadata-patch event, local/LFS artifact migration, deterministic backfill, readiness report.
- [OPEN] AQU-708 — complete construct, Unicode, old/current InDesign, and hostile archive corpus.
- [OPEN] AQU-709 — Adobe open/preflight/reopen/PDF validation and rollout controls.

## Quality

- [OPEN] Publish `@aquilla/idml-roundtrip@2.0.0` to private GitHub Packages only after the shared conformance gate is green and both consumers are ready to pin it.

## DONE

- [DONE] Current `origin/dev` baseline build passes.
- [DONE] AQU-704 through AQU-709 created with explicit dependencies and acceptance criteria.
