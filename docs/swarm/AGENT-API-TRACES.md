# AGENT-API swarm — open traces / TODOs

Agents: append TODOs you could not finish, with file:line and enough context for a
fresh agent to pick up. Orchestrator: drain into wave briefs or sub-issues.

## Open

- W2-C (approval page, this wave): `ChangesetSummary` (sync-worker/src/external/types.ts)
  currently only carries `translationsAdded`, `translationsModified`, `warnings` — no
  `filesCreated` field yet, even though docs/AGENT-API.md §3 sketches "creates 1 file
  (Genesis.usfm)…" as part of the effect summary. `ApproveChangeset.tsx`
  (src/pages/ApproveChangeset/ApproveChangeset.tsx) already iterates summary keys
  generically (skips `warnings`, renders any other number/string key), so it'll pick up
  `filesCreated` for free once `PlanImport`/`prepare.ts` starts populating it — no
  follow-up needed there, just noting the summary shape is still import-command-shaped
  (translations only) as of this wave.
- W2-C: the approval page's error-message extraction (`parseErrorMessage` in
  ApproveChangeset.tsx) reads `error.message` off the sync-worker/auth-worker envelope
  but doesn't special-case `error.details.code === 'digest_mismatch'` with a friendlier
  copy — it just shows the server's message string ("digest mismatch — the plan you're
  approving doesn't match the staged changeset"), which is already human-readable, so this
  is a nice-to-have, not a bug.
- W2-C: auth-worker/src/routes/changeset-approvals.ts's authZ is intentionally v1-narrow
  (session user id === changesets.created_by_user_id, per the task spec — "only the
  credential's owning human approves their agent's work"). If a future wave wants
  org/project maintainers to be able to approve on behalf of another member's credential,
  that's a deliberate scope change, not an oversight here.

## Resolved

- W2-C: one-time human approval assertion (GET/approve/reject) +
  `/approve/:changesetId` SPA page shipped — see commit on
  `swarm/agent-api-w2c-approval` for file list.
