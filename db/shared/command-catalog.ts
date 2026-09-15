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
const OWNER = 700

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
Params: \`{ name, projectId?, orgId?, sourceLanguage?, targetLanguage? }\` — sole command; forced ask-mode regardless of credential mode.
Requires org MAINTAINER (600) on the target org; project-scoped credentials can never create projects.
The field set is CLOSED: any other key is \`validation_failed\` naming it. Nothing is silently ignored.
- \`name\` must be a REAL name, not a placeholder: derive it from what you are importing (the source folder or file name, the publication/curriculum title, the language pair), or ask the human. Content-free names ("default", "untitled", "new project", "unnamed", …) are rejected with \`validation_failed\` — the name is what humans see in the workspace forever after.
- \`sourceLanguage\` / \`targetLanguage\` seed the settings blob at creation (landing at settings version 1, exactly as the UI's create-then-patch does). Send \`targetLanguage: ""\` for a source-only project.
- Every OTHER settings key goes through \`PatchSettings\` after the create — it owns the version guard and the per-key role floors a create cannot honor.
- Membership is not set here: use the \`InviteMember\` / \`SetRole\` family. A \`members\` field is rejected, not swallowed.
- There is no project \`description\` field in the product; sending one is rejected.
Gotcha: when \`projectId\` is omitted the changeset URL's project id becomes the definitive id, pinned at prepare (crash-retry re-applies the same id).`,
  },
  {
    kind: 'AddOrgMember',
    title: 'Add org member',
    oneLiner: 'Add a user to an organization at an org role (owner-only).',
    minRoleLevel: OWNER,
    tier: 'governance',
    agentReachable: true,
    paramsDoc: `### AddOrgMember
Params: \`{ orgId, username, role }\` — sole command; forced ask-mode regardless of credential mode.
Receipt-only (a plain \`org_members\` row write, not an event). Requires org OWNER (700) on the target org; a project-scoped credential can never manage org membership.
Gotchas:
- The target is named by USERNAME and resolved server-side — you never supply a user id.
- Fails if the user is already a member: use SetOrgRole to change an existing member's role.
- \`role\` must be one of 100, 200, 300, 400, 500, 600, 700, and never above your own org role.
- You cannot target yourself.
Example: \`{ "kind": "AddOrgMember", "orgId": 42, "username": "maria", "role": 400 }\``,
  },
  {
    kind: 'SetOrgRole',
    title: 'Set org role',
    oneLiner: 'Change an existing org member’s role (owner-only).',
    minRoleLevel: OWNER,
    tier: 'governance',
    agentReachable: true,
    paramsDoc: `### SetOrgRole
Params: \`{ orgId, username, role }\` — sole command; forced ask-mode. Same owner gate, role cap and self-target rule as AddOrgMember.
Gotchas:
- The member's role at prepare is pinned; if someone else changes it before you commit you get \`plan_stale\` — re-read and re-prepare.
- The last owner of an org cannot be demoted, and neither can the organization's own owner row.`,
  },
  {
    kind: 'RemoveOrgMember',
    title: 'Remove org member',
    oneLiner: 'Remove a user from an organization (owner-only).',
    minRoleLevel: OWNER,
    tier: 'governance',
    agentReachable: true,
    paramsDoc: `### RemoveOrgMember
Params: \`{ orgId, username }\` — sole command; forced ask-mode. Same owner gate and self-target rule as AddOrgMember.
Also removes the user from that org's groups, exactly as the roster UI does, so no group-derived project access survives.
Gotcha: the last owner of an org (and the organization's own owner row) cannot be removed.`,
  },
  {
    kind: 'CreateOrg',
    title: 'Create organization',
    oneLiner: 'Create an organization you will own (always requires human approval).',
    minRoleLevel: MAINTAINER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### CreateOrg
Params: \`{ name }\` — sole command; forced ask-mode regardless of credential mode.
Requires an UNSCOPED credential: an org-scoped or project-scoped credential is confined to the tenant it names and gets \`scope_denied\`.
The credential's minting user becomes the org OWNER (role 700). There is no owner parameter — an agent can never point ownership elsewhere, and never becomes a member itself.
Gotchas:
- \`name\` is the ONLY field. Tier / billing / entitlement fields (\`plan\`, \`tier\`, \`addonPacks\`, …) are rejected with \`validation_failed\` naming the field; a new org always gets the default tier (no billing row = plan \`none\`).
- Rate-limited to 5 staged creations per credential per 15 minutes → \`rate_limited\`.
- The changeset is filed under the URL project id, which is a placeholder here: CreateOrg creates no project, and the receipt carries \`orgId\`, not \`projectId\`. Feed that \`orgId\` to a follow-up CreateProject to populate the new org.
Example: \`{ "kind": "CreateOrg", "name": "Partner Co" }\``,
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
- payload shapes match the app's event vocabulary — call describe_command or docs before hand-building unfamiliar payloads.

Validation guardrails (\`cell.validate\` / \`cell.unvalidate\`; AQU-1184) — these are policy, not preferences, and no parameter turns any of them off:
- **AI-drafted text cannot be validated through this API.** A \`cell.validate\` whose cell is still an unreviewed machine draft (\`ai_drafted\`) is rejected at prepare with \`validation_failed\` naming that cell, and it rejects the WHOLE plan. This mirrors the in-app rule that AI output is reviewed one cell at a time. To validate such a cell, a human edits or validates it in the app first (either clears the marker); an agent cannot clear it on its own behalf.
- **Explicit cells only.** Every event names one \`(fileId, cellId)\`. There is no wildcard, glob, range, \`"*"\`, or "validate all" form — such a value is simply a cell id that does not exist, and prepare rejects the plan.
- **Every staged validation is itemized for the approver.** The effect summary lists each cell id with the text as the server reads it, so approval endorses specific sentences, not a count. Validations are testimony tier: review UIs confirm them per item and never bulk-apply them.
- **Project validation policy still governs the commit.** The compiled events go through the /events perimeter as the credential's own user, so the validation role floor, the validator allowlist, and \`allowSelfValidation\` apply exactly as they do in the app — a credential cannot validate what its owner could not.`,
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
  {
    kind: 'InsertCell',
    title: 'Insert cell',
    oneLiner: 'Add a source cell at a position in a file’s order.',
    minRoleLevel: PROJECT_LEAD,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### InsertCell
Params: \`{ fileId, afterCellId?, cellId?, value, type?, canonicalRef?, startMs?, endMs?, metadata? }\` — sole command in its changeset.
\`afterCellId\` names the cell the new one follows; null/omitted inserts at the head of the file. Compiles to \`source.cell.create\` plus a \`source.cell.reorder\` for whatever was anchored at that position, so chain order (what exporters read) matches the intended document order.
Gotchas:
- Refused on a file imported with preserved export slots (IDML/OOXML locators) — a cell without a locator makes the whole export throw. Restructure before import instead.
- \`canonicalRef\` must be unused in the file: lossless USFM export overlays translations BY ref, so a duplicate would silently drop one of the two.
- \`value\` may be empty — a blank row with timings is a real thing (an added subtitle cue keeps its cue).
- The row is stamped with a server-written origin marker; a caller-supplied \`metadata.aquillaOrigin\` is rejected.
Example: \`{ "kind": "InsertCell", "fileId": "f1", "afterCellId": "c7", "value": "A new sentence." }\``,
  },
  {
    kind: 'DeleteCell',
    title: 'Delete cell',
    oneLiner: 'Remove a source cell and its translations from a file.',
    minRoleLevel: PROJECT_LEAD,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### DeleteCell
Params: \`{ fileId, cellId }\` — sole command in its changeset.
Compiles to a \`source.cell.reorder\` for each following row (so the chain closes over the gap rather than stranding the rest of the file at the tail), a \`target.cell.delete\` per translated lane, then \`source.cell.delete\`.
Gotchas:
- Refused while the cell still owns validators, waivers, comments, back-translations, audio takes, cell links or assignment rows: the delete projection removes ONE row and cleans up nothing else, so those would be orphaned. Clear them first — the error names what is holding it.
- Refused on a file imported with preserved export slots (IDML/OOXML locators): removing one slice of a note block makes the export refuse to assemble it.
- A lane that gains a translation between prepare and commit makes the plan stale rather than silently leaving an orphan.`,
  },
  {
    kind: 'SplitCell',
    title: 'Split cell',
    oneLiner: 'Cut one cell’s source text at an offset into two cells.',
    minRoleLevel: PROJECT_LEAD,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### SplitCell
Params: \`{ fileId, cellId, offset, targets: "blank" | "divide", targetOffsets?, newCellId? }\` — sole command in its changeset.
The original keeps \`value.slice(0, offset)\` (a \`source.cell.commit\`, so its chain head advances); a new cell carrying \`value.slice(offset)\` is created directly after it.
\`targets\` is required and never inferred:
- \`"blank"\` deletes the existing translations outright.
- \`"divide"\` cuts each lane's translation at an explicit offset — \`targetOffsets: [{ laneId?, offset }]\` must name EVERY lane that has a translation, or the plan is rejected. A lane you leave out is never silently blanked.
VALIDATION: both halves come out unvalidated either way — 'blank' removes the target rows that held the validation, and 'divide' re-commits them, which resets validation because the chain head moved.
Gotchas:
- \`offset\` must be inside the text (both halves non-empty), else validation_failed at prepare.
- Refused on cells carrying structured source/target HTML — a plain-text offset cannot cut markup safely; use \`"blank"\` and re-translate.
- Refused on a file with preserved export slots (IDML/OOXML), and on a cell addressed by canonical ref in a file whose original source is kept for lossless export: the second half cannot reuse the ref, so it would vanish from the deliverable.
- The second half inherits the original's \`type\` but NOT its canonical ref.
Example: \`{ "kind": "SplitCell", "fileId": "f1", "cellId": "c3", "offset": 42, "targets": "divide", "targetOffsets": [{ "offset": 51 }] }\``,
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
