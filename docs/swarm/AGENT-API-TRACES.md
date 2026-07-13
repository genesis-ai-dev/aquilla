# AGENT-API swarm — open traces / TODOs

Agents: append TODOs you could not finish, with file:line and enough context for a
fresh agent to pick up. Orchestrator: drain into wave briefs or sub-issues.

## Open

### W2-B (artifacts + PlanImport) — Wave-3 deferrals

- **Server-side recipe parsing (Wave-3 TRACE).** PlanImport receives cells
  ALREADY PARSED (client/agent-side), exactly like the SPA `/import` path. The
  server does not parse USFM/JSON/XLIFF into cells. `sync-worker/src/external/artifacts-route.ts`
  `/inspect` only does lightweight format DETECTION (marker sniff over the first
  64KB), not extraction. A future wave should add a `preview_import` /
  recipe-driven parse that turns an artifact into a cell manifest server-side
  (AGENT-API §5). Until then the agent must parse and pass `cells[]`.
- **Manifest-in-R2 for large imports (Wave-3 TRACE).** `PlanImport` caps cells at
  `PLAN_IMPORT_MAX_CELLS = 5000` (`sync-worker/src/external/commands.ts`),
  returning `validation_failed` above it. AGENT-API §3/§5 calls for large plans
  to reference an immutable manifest in R2 by digest rather than inlining
  thousands of operations in the changeset JSON. Biblica-scale (AQU-550) imports
  need this; today they must be split into ≤5000-cell PlanImport changesets.
- **Presigned artifact upload/download (design §4 D10).** Artifact bytes are
  worker-proxied (`POST/GET .../artifacts[/:id/content]` stream through the
  Worker) because this repo has NO presigned-URL pattern. The design targets
  signed HTTP upload/download URLs for binary transfer. A later wave should add
  the signed-URL flow (mirrors the `/audio` proxy → signed-URL migration if/when
  that lands) and publish max sizes in `get_capabilities`.
- **Partial-apply semantics of PlanImport commit.** `commitPlanImport`
  (`sync-worker/src/external/commit.ts`) chunks events to the `/events` perimeter
  at 100/POST. If any chunk has rejects while others land, the changeset is
  marked `committed` (event ids regenerate per attempt, so a retry would create a
  DUPLICATE file — committing makes re-commit idempotent) but the response is
  `job_failed` with the partial receipt. Revisit if a compensating/rollback path
  for half-imported files is wanted (delete the file.create'd file on partial
  failure).
- **Artifact GC.** A failed `artifacts` INSERT rolls back its R2 object, but
  artifacts whose PlanImport changeset is never committed (or is discarded) keep
  their R2 bytes + row indefinitely (`file_id` stays NULL). No TTL/GC job exists.

## Resolved

(none yet)
