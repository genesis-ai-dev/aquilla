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
- payload shapes match the app's event vocabulary — call describe_command or docs before hand-building unfamiliar payloads.

Validation guardrails (\`cell.validate\` / \`cell.unvalidate\`; AQU-1184) — these are policy, not preferences, and no parameter turns any of them off:
- **AI-drafted text cannot be validated through this API.** A \`cell.validate\` whose cell is still an unreviewed machine draft (\`ai_drafted\`) is rejected at prepare with \`validation_failed\` naming that cell, and it rejects the WHOLE plan. This mirrors the in-app rule that AI output is reviewed one cell at a time. To validate such a cell, a human edits or validates it in the app first (either clears the marker); an agent cannot clear it on its own behalf.
- **Explicit cells only.** Every event names one \`(fileId, cellId)\`. There is no wildcard, glob, range, \`"*"\`, or "validate all" form — such a value is simply a cell id that does not exist, and prepare rejects the plan.
- **Every staged validation is itemized for the approver.** The effect summary lists each cell id with the text as the server reads it, so approval endorses specific sentences, not a count. Validations are testimony tier: review UIs confirm them per item and never bulk-apply them.
- **Project validation policy still governs the commit.** The compiled events go through the /events perimeter as the credential's own user, so the validation role floor, the validator allowlist, and \`allowSelfValidation\` apply exactly as they do in the app — a credential cannot validate what its owner could not.`,
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
