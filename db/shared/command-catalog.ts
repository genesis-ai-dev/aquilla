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
    kind: 'SetSource',
    title: 'Set source text',
    oneLiner: 'Correct a cell\u2019s SOURCE text (marks dependent targets stale).',
    minRoleLevel: PROJECT_LEAD,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### SetSource
Params: \`{ fileId, cellId, value, valueHtml? }\` \u2014 batchable with the other cell-field commands.
Compiles to \`source.cell.commit\` through the /events perimeter. Floor is PROJECT_LEAD (500), a rung ABOVE SetTranslation \u2014 a source edit changes the text every translator works from.
Gotchas:
- The commit advances the source chain head, so every target pinned to the old head goes STALE (AD-9), exactly as a UI source edit does. That is the intended effect, not a side effect \u2014 review it before approving a batch.
- The plan pins the cell's live source head at prepare; a source edit by anyone else in between makes the commit \`plan_stale\`.
- SetSource and SetTranscription on the SAME cell merge into one event (they are one \`source.cell.commit\`); two SetSource writes to one cell are last-wins with a warning.
Example: \`{ "kind": "SetSource", "fileId": "f1", "cellId": "c3", "value": "In the beginning\u2026" }\``,
  },
  {
    kind: 'SetTranscription',
    title: 'Set transcription',
    oneLiner: 'Write a media cell\u2019s corrected transcript (leaves the filename intact).',
    minRoleLevel: PROJECT_LEAD,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### SetTranscription
Params: \`{ fileId, cellId, transcription }\`.
Compiles to a transcript-only \`source.cell.commit\`. An imported media cell's \`value\` is the import FILENAME and stays put as provenance; the transcript is what export and AI actually read (AQU-847).
Same PROJECT_LEAD (500) floor as SetSource \u2014 it is the same event kind, and it advances the source chain head, so dependent targets go stale.
Example: \`{ "kind": "SetTranscription", "fileId": "f1", "cellId": "c3", "transcription": "and then he said\u2026" }\``,
  },
  {
    kind: 'SetTiming',
    title: 'Set timing',
    oneLiner: 'Retime a cell\u2019s span and/or set a file\u2019s audio timing mode.',
    minRoleLevel: CONTRIBUTOR,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### SetTiming
Params: \`{ fileId, cellId?, startMs?, endMs?, timingMode? }\` \u2014 at least one of (startMs+endMs) or timingMode.
\`startMs\`/\`endMs\` (both together, cellId required) compile to \`cell.retime\` (CONTRIBUTOR 400); \`timingMode\` ("dubbing" | "audioFirst" | null) compiles to \`file.timing.set\` for the whole FILE (MAINTAINER 600). A command carrying both needs the higher floor.
Gotchas:
- MILLISECONDS MUST BE INTEGERS. A fractional value is rejected at prepare with the offending number in the message (AQU-927: ms columns are BIGINT and one float used to fail every event in its flush). Round before sending; this surface will not round for you.
- Projects default to TIMING LOCKED: while \`timingLocked\` is not exactly false, a retime needs MAINTAINER (600) unless the cell is a line someone added by hand. Prepare refuses rather than staging a plan you could not commit.
- endMs must be >= startMs.
Example: \`{ "kind": "SetTiming", "fileId": "f1", "cellId": "c3", "startMs": 2403, "endMs": 5120 }\``,
  },
  {
    kind: 'SetTrackOverride',
    title: 'Set track override',
    oneLiner: 'Rename, reorder, group, recolour, add or delete a timeline track.',
    minRoleLevel: MAINTAINER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### SetTrackOverride
Params: \`{ fileId, trackId, patch }\` \u2014 \`patch\` is \`{ kind?, name?, order?, groupId?, color?, sourceTrackId? }\` or \`null\` to DELETE the override entry. Inside a patch, null clears that one field; an absent key leaves it alone.
Compiles to \`file.track.set\`, merged into \`files.meta.trackOverrides[trackId]\`. Track structure is file structure \u2014 MAINTAINER (600).
Gotchas:
- TWO GATES. Restructuring patches (anything beyond \`name\`/\`order\`, and every \`patch: null\` delete) additionally require the project's \`allowTrackEditing\` \u2014 with it off, even an OWNER is refused. Renames and reorders stay ungated. Turn it on with PatchSettings first.
- \`trackId\` must match /^[A-Za-z0-9_-]{1,64}$/; the four derived ids (source-subtitles, source-audio, target-subtitles, target-audio) are reserved and cannot be given a \`kind\`.
Example: \`{ "kind": "SetTrackOverride", "fileId": "f1", "trackId": "target-audio", "patch": { "name": "Dub \u2014 ES" } }\``,
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
