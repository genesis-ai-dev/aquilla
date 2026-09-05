// Command catalog (AQU-CMDREG, docs/COMMAND-REGISTRY.md §1) — dependency-free
// metadata about every changeset command, importable by BOTH workers:
// sync-worker enforces floors/tiers at prepare/commit; auth-worker renders the
// role-filtered command index into the agent prompt and serves describe_command.
//
// This file is METADATA ONLY. Validation and execution live in
// sync-worker/src/external/*; floors here are the STATIC index-filtering values
// (dynamic checks — org overrides, per-event floors — happen at prepare).

export type CommandTier = 'prepared' | 'structural' | 'testimony' | 'governance'

export interface CommandCatalogEntry {
  kind: string
  title: string
  /** ≤90 chars — one line in the role-filtered prompt index. */
  oneLiner: string
  /** Static floor for index filtering; dynamic checks stay in prepare. */
  minRoleLevel: number
  tier: CommandTier
  /** false = never offered to any agent surface (governance-only kinds). */
  agentReachable: boolean
  /** L2 body served by describe_command: params, gotchas, one worked example. */
  paramsDoc: string
}

// Role levels mirror role-policy.ts (VIEWER 100 … OWNER 700). Redeclared as
// plain numbers so this module stays importable from both workers without
// crossing package roots.
const COMMENTER = 200
const CONTRIBUTOR = 400
const PROJECT_LEAD = 500
const MAINTAINER = 600

export const COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
  {
    kind: 'SetTranslation',
    title: 'Set translation',
    oneLiner: 'Write a target cell’s text (batchable; lane-aware).',
    minRoleLevel: CONTRIBUTOR,
    tier: 'prepared',
    agentReachable: true,
    paramsDoc: `### SetTranslation
Params: \`{ fileId, cellId, value, valueHtml?, laneId? }\` — batch many per changeset.
Compiles to \`target.cell.commit\` through the /events perimeter.
Gotchas:
- \`laneId\` must already be registered in the project's targetLanes (register via PatchSettings first); omit for the default lane.
- Duplicate (cell, lane) targets in one changeset dedupe with a warning — last wins.
- Committing resets the cell's validation state by design.
Example: \`{ "kind": "SetTranslation", "fileId": "f1", "cellId": "c3", "value": "En el principio…" }\``,
  },
  {
    kind: 'LinkMedia',
    title: 'Link media',
    oneLiner: 'Attach an uploaded audio artifact to a cell.',
    minRoleLevel: CONTRIBUTOR,
    tier: 'prepared',
    agentReachable: true,
    paramsDoc: `### LinkMedia
Params: \`{ fileId, cellId, artifactId }\` — the artifact must be audio-kind, same project.
Compiles to \`cell.audio.attach\` + \`cell.audio.select\`; bytes are copied into the app's native audio layout so playback works everywhere.
Gotcha: upload the artifact first (REST artifact endpoint with \`x-artifact-kind: audio\`); LinkMedia-only changesets cannot mix other commands.`,
  },
  {
    kind: 'PlanImport',
    title: 'Plan import',
    oneLiner: 'Create a file plus its source cells (≤5000) from parsed content.',
    minRoleLevel: PROJECT_LEAD,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### PlanImport
Params: \`{ fileName, fileType, artifactId?, manifest?, cells: [{ content, canonicalRef?, … }] }\`.
Sole command in its changeset; cap 5000 cells. Compiles to \`file.create\` + N \`source.cell.create\`.
Gotchas:
- Prefer parsing an uploaded artifact server-side (artifact parse endpoint / preview_import) and staging from its results, so the original is preserved for round-trip export.
- Cells may carry per-lane \`variants\` for multi-language imports.
- Duplicate file names are a staleness precondition — prepare warns, commit re-checks.`,
  },
  {
    kind: 'CreateProject',
    title: 'Create project',
    oneLiner: 'Create a project (always requires human approval).',
    minRoleLevel: MAINTAINER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### CreateProject
Params: \`{ name, projectId?, orgId? }\` — sole command; forced ask-mode regardless of credential mode.
Requires org MAINTAINER (600) on the target org; project-scoped credentials can never create projects.
Gotcha: when \`projectId\` is omitted the changeset URL's project id becomes the definitive id, pinned at prepare (crash-retry re-applies the same id).`,
  },
  {
    kind: 'PatchSettings',
    title: 'Patch settings',
    oneLiner: 'Change specific project-settings keys (version-guarded).',
    minRoleLevel: PROJECT_LEAD,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### PatchSettings
Params: \`{ projectId, ops: [{ key, value }], ifMatchVersion }\` — sole command; top-level settings keys only; each op replaces that key's value wholesale (one op per key — duplicates are rejected).
Floors: \`terminology\` needs the org's termbase-edit floor (default PROJECT_LEAD 500); every other key needs MAINTAINER 600.
Policy keys are NEVER writable by agents (permission_denied): agentMemoryAutonomy, validationRoleFloor, validationNamedUsers, validationCount, validationCountAudio, allowSelfValidation, harmonize_min_role, contributeToGlobalTm.
Gotchas:
- \`ifMatchVersion\` must equal the live settings version at prepare AND commit (plan_stale on drift) — read it first.
- Prefer this over UpdateProjectSettings (deprecated whole-blob replace).
Example: \`{ "kind": "PatchSettings", "projectId": "p1", "ops": [{ "key": "targetLanes", "value": ["es","pt"] }], "ifMatchVersion": 7 }\``,
  },
  {
    kind: 'UpdateProjectSettings',
    title: 'Update settings (deprecated)',
    oneLiner: 'Whole-blob settings replace — prefer PatchSettings.',
    minRoleLevel: MAINTAINER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### UpdateProjectSettings (deprecated)
Params: \`{ projectId, settings, ifMatchVersion }\` — replaces the ENTIRE settings blob; sole command.
Kept for compatibility. Rejected if any policy key's value would change (see PatchSettings for the list). New integrations should use PatchSettings.`,
  },
  {
    kind: 'EmitEvents',
    title: 'Emit events',
    oneLiner: 'Stage any allowed project events: comments, waives, validations, files, assignments.',
    minRoleLevel: COMMENTER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### EmitEvents
Params: \`{ events: [{ kind, fileId?, cellId?, laneId?, payload? }] }\` — sole command; max 200 events per changeset.
The generalized escape hatch: stages role-allowed event kinds through the same precondition doctrine as SetTranslation. The changeset floor is the max floor across events (per-kind floors come from role-policy).
Allowed kinds v1: comment.create/edit/delete/resolve · cell.waive/unwaive · cell.validate/unvalidate (testimony — reviewed per item, never bulk) · cell.backtranslation.set · target.cell.repin · file.rename/delete/restore · assignment.create/reassign/unassign.
Not here: target text (use SetTranslation), source edits, audio (use LinkMedia), imports (use PlanImport), reorders/retimes.
Gotchas:
- Head pins (editEventId / targetEventId / sourceEventId / expectedTargetEventId) are SERVER-RESOLVED from the live projection at prepare — omit them; a supplied value is rejected. Commit re-checks the pins (plan_stale on drift).
- Every referenced cell/comment/file/assignment must exist at prepare — one bad reference rejects the whole plan (no silent skips).
- payload shapes match the app's event vocabulary — call describe_command or docs before hand-building unfamiliar payloads.`,
  },
  {
    kind: 'InviteMember',
    title: 'Invite member',
    oneLiner: 'Grant a person direct access to the project at a role.',
    minRoleLevel: MAINTAINER,
    tier: 'governance',
    agentReachable: true,
    paramsDoc: `### InviteMember
Params: \`{ projectId, username, role }\` — \`role\` is a canonical level (100 viewer · 200 commenter · 300 reviewer · 400 contributor · 500 project_lead · 600 maintainer · 700 owner).
Requires project MAINTAINER (600). Always ask-mode: every membership change passes a human at /approve/:id regardless of the credential's mode.
Gotchas:
- You cannot grant a role above your own (permission_denied \`role_above_caller\`), act on yourself (\`self_target\`), or touch anyone whose effective role is >= yours unless you are OWNER (\`target_outranks_caller\`).
- Fails with \`conflict\` when the person already holds a direct membership — use SetRole to change it.
- Membership commands batch with each other (max 25, one person each) but never with other command kinds.
Example: \`{ "kind": "InviteMember", "projectId": "p1", "username": "ana", "role": 400 }\``,
  },
  {
    kind: 'SetRole',
    title: 'Set member role',
    oneLiner: 'Change an existing direct member’s project role.',
    minRoleLevel: MAINTAINER,
    tier: 'governance',
    agentReachable: true,
    paramsDoc: `### SetRole
Params: \`{ projectId, username, role }\` — same role ladder, floor and caps as InviteMember, always ask-mode.
Gotcha: fails with \`conflict\` when the person has no direct membership row (their access comes from the org, a group, or being the creator) — grant one with InviteMember instead.`,
  },
  {
    kind: 'RemoveMember',
    title: 'Remove member',
    oneLiner: 'Drop a person’s direct project membership row.',
    minRoleLevel: MAINTAINER,
    tier: 'governance',
    agentReachable: true,
    paramsDoc: `### RemoveMember
Params: \`{ projectId, username }\` — requires project MAINTAINER (600), always ask-mode.
Removes the DIRECT membership row only. Org / group / creator grant paths are additive (AD-12) and still confer access — remove those at the org level.
Gotchas:
- The target cap applies: below OWNER you cannot remove anyone whose effective role is >= yours, and never yourself.
- Fails with \`conflict\` when there is no direct membership row to remove.`,
  },
] as const

export function describeCommand(kind: string): CommandCatalogEntry | null {
  return COMMAND_CATALOG.find((c) => c.kind === kind) ?? null
}

/** Commands an agent surface may offer a user holding `level`. */
export function catalogForRole(level: number): CommandCatalogEntry[] {
  return COMMAND_CATALOG.filter((c) => c.agentReachable && c.minRoleLevel <= level)
}

/** One line per command for the role-filtered prompt index (L2 pointer — the
 *  full paramsDoc stays out of the prompt until describe_command fetches it). */
export function catalogIndexLines(level: number): string[] {
  return catalogForRole(level).map(
    (c) => `- ${c.kind} (${c.minRoleLevel}+, ${c.tier}): ${c.oneLiner}`,
  )
}
