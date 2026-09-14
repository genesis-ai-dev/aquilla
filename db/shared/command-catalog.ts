// Command catalog (AQU-CMDREG, docs/COMMAND-REGISTRY.md §1) — dependency-free
// metadata about every changeset command, importable by BOTH workers:
// sync-worker enforces floors/tiers at prepare/commit; auth-worker renders the
// role-filtered command index into the agent prompt and serves describe_command.
//
// This file is METADATA ONLY. Validation and execution live in
// sync-worker/src/external/*; floors here are the STATIC index-filtering values
// (dynamic checks — org overrides, per-event floors — happen at prepare).

import { settingsKeyDocLines } from './project-settings-keys'

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
/** AQU-1224: the settings schema, rendered for describe_command("PatchSettings")
 *  so an agent DISCOVERS the legal keys instead of probing for them (unknown
 *  keys are rejected at prepare, so probing no longer teaches anything). */
const PATCH_SETTINGS_KEY_DOC = settingsKeyDocLines()
  .map((line) => `\`${line}\``)
  .join(', ')

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
Valid keys, with the value type each holds: ${PATCH_SETTINGS_KEY_DOC}. \`null\` clears any key (JSON cannot carry undefined, so there is no "delete").
Gotchas:
- A key not on that list is a typo, not a new setting: prepare rejects it with \`validation_failed\` naming the key, and a wrong value type is rejected the same way naming the expected type. Nothing reaches the approval queue either way.
- \`ifMatchVersion\` must equal the live settings version at prepare AND commit (plan_stale on drift) — read it first.
- Prefer this over UpdateProjectSettings (deprecated whole-blob replace).
Example: \`{ "kind": "PatchSettings", "projectId": "p1", "ops": [{ "key": "targetLanes", "value": ["es","pt"] }], "ifMatchVersion": 7 }\``,
  },
  {
    kind: 'SetBrief',
    title: 'Set translation brief',
    oneLiner: 'Write the project’s translation brief, section by section.',
    minRoleLevel: MAINTAINER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### SetBrief
Params: \`{ projectId, parameters?, freeformNotes?, ifMatchVersion }\` — sole command; at least one of \`parameters\`/\`freeformNotes\`.
\`parameters\` is a PARTIAL map of brief section id → answer text: named sections are replaced, every unnamed section keeps its live value. Section ids (interview order):
- Purpose & audience: \`purpose\`, \`audience\`, \`useAndMedium\`, \`motiveSponsor\`
- Standards: \`sourceTexts\`, \`targetVariety\`, \`registerNaturalness\`, \`literalness\`, \`keyTerms\`, \`constraints\`, \`qualityBar\`
Writes the \`translationBrief\` key of the project settings blob — the same record the in-app brief builder reads, so an API-set brief satisfies the autopilot brief gate exactly like a hand-typed one.
Gotchas:
- An unknown section id is \`validation_failed\` (nothing is staged) — it is never silently dropped.
- Section text caps at 4000 chars; \`freeformNotes\` at 8000.
- \`ifMatchVersion\` is the SETTINGS version (not the brief's own \`version\`) and must match at prepare AND commit (plan_stale on drift) — read it first.
- The L1 summary is carried over, not cleared, so it shows as stale in-app until regenerated — same as an in-app section edit.
Example: \`{ "kind": "SetBrief", "projectId": "p1", "parameters": { "audience": "Rural youth, 15–25" }, "ifMatchVersion": 7 }\``,
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
    kind: 'AddExample',
    title: 'Add example',
    oneLiner: 'Record a source-to-target example pair the copilot reuses on similar lines.',
    minRoleLevel: CONTRIBUTOR,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### AddExample
Params: \`{ slug, source, target, note?, rationale? }\` — sole command. Writes the Living Memory entry \`examples/<slug>.md\`.
\`slug\` is a lowercase dash-separated slug (max 64 chars); re-using a slug SUPERSEDES that entry (the previous version is archived, never erased).
Gotchas:
- Landing state depends on who approved the changeset: an ask-mode approval by a PROJECT_LEAD(500)+ lands it \`approved\` (live in the copilot's next prompt); anything else lands it \`proposed\` and a lead must approve it in the in-app Memory surface first. The receipt's \`memoryStatus\` says which — don't assume.
- A path already held by a HUMAN-EDITED memory is refused (permission_denied) — a human owns that entry; edit it in-app.
- source/target/note/rationale cap at 2000 chars; content matching a secret pattern is rejected.
Example: \`{ "kind": "AddExample", "slug": "lord-as-hospod", "source": "the LORD", "target": "Господь" }\``,
  },
  {
    kind: 'AddDecision',
    title: 'Add decision',
    oneLiner: 'Record a standing rendering decision that binds future copilot drafts.',
    minRoleLevel: CONTRIBUTOR,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### AddDecision
Params: \`{ slug, decision, rationale? }\` — sole command. Writes the Living Memory entry \`decisions/<slug>.md\`.
State a decision as a standing instruction ("render X as Y, never Z"), not as a report of one edit — it is injected into every subsequent copilot prompt.
Gotchas:
- Same approval rule as AddExample: \`approved\` only on an ask-mode approval by PROJECT_LEAD(500)+, else \`proposed\`. Read \`memoryStatus\` on the receipt.
- Re-using a slug supersedes the prior decision (archived, not erased). A human-edited holder is refused.
Example: \`{ "kind": "AddDecision", "slug": "divine-name", "decision": "Render Lord as Господь, never Пан." }\``,
  },
  {
    kind: 'AddNote',
    title: 'Add note',
    oneLiner: 'Attach cell-level rationale — why this cell was rendered the way it was.',
    minRoleLevel: CONTRIBUTOR,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### AddNote
Params: \`{ fileId, cellId, note, rationale? }\` — sole command. Writes the Living Memory entry \`notes/<file>/<cell>-<digest>.md\`.
For the WHY behind a rendering. History records what changed; this records the reasoning, so a later reviewer (human or agent) can see it.
Gotchas:
- The cell must exist in this project at prepare, or the plan is rejected (\`not_found\`) — a note is anchored, never free-floating.
- One standing note per cell: re-noting the same cell supersedes it (prior version archived).
- Same approval rule as AddExample/AddDecision — check \`memoryStatus\` on the receipt.
Example: \`{ "kind": "AddNote", "fileId": "f1", "cellId": "GEN 1:1", "note": "Kept the plural to match the style guide." }\``,
  },
  {
    kind: 'RetireExample',
    title: 'Retire example',
    oneLiner: 'Drop an example from copilot retrieval without erasing its history.',
    minRoleLevel: PROJECT_LEAD,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### RetireExample
Params: \`{ slug, rationale? }\` — sole command. Archives the APPROVED memory at \`examples/<slug>.md\`.
Retirement is a retrieval change, not a delete: the row keeps its content and history, and the copilot simply stops receiving it. The in-app Memory surface shows it as archived.
Gotchas:
- PROJECT_LEAD(500)+ — un-publishing memory the whole project's copilot reads is a review-tier act, unlike adding.
- Rejected with \`not_found\` when nothing is currently APPROVED at that slug (a \`proposed\` entry is rejected in-app instead, not retired here).
- A human-edited entry is refused (permission_denied) — retire it from the in-app Memory surface.
Example: \`{ "kind": "RetireExample", "slug": "lord-as-hospod", "rationale": "Superseded by the divine-name decision." }\``,
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
