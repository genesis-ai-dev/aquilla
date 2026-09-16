// Command catalog (AQU-CMDREG, docs/COMMAND-REGISTRY.md §1) — dependency-free
// metadata about every changeset command, importable by BOTH workers:
// sync-worker enforces floors/tiers at prepare/commit; auth-worker renders the
// role-filtered command index into the agent prompt and serves describe_command.
//
// This file is METADATA ONLY. Validation and execution live in
// sync-worker/src/external/*; floors here are the STATIC index-filtering values
// (dynamic checks — org overrides, per-event floors — happen at prepare).

import { settingsKeyDocLines } from './project-settings-keys'
import { POLICY_DIRECTION_TABLE } from './policy-direction'

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

/** AQU-1282: the per-key restrictive direction, rendered from the same table the
 *  enforcing helper uses (db/shared/policy-direction.ts) so the doc an agent
 *  reads and the rule it hits cannot drift. */
const POLICY_DIRECTION_DOC = POLICY_DIRECTION_TABLE.map(
  (row) => `  - \`${row.key}\`: ${row.restrictiveDirection}`,
).join('\n')

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
Policy keys — agentMemoryAutonomy, validationRoleFloor, validationNamedUsers, validationCount, validationCountAudio, allowSelfValidation, harmonize_min_role, contributeToGlobalTm, cellEditingFloor, agentAuthorship — govern the oversight of your own work, and are writable in the RESTRICTIVE DIRECTION ONLY (AQU-1282). Tightening stages like any other write; loosening is \`permission_denied\` with \`details.loosening: [{ key, current, proposed, reason }]\`. The direction is computed against the LIVE blob at prepare AND again at commit, so a human loosening a key mid-flight cannot let your staged plan land as a loosening write. Restrictive direction per key:
${POLICY_DIRECTION_DOC}
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
- The copilot reads only the brief's rendered L1 summary (\`translationBrief.l1Summary\`), so on commit the summary is regenerated automatically when the drafting backend is reachable — the receipt's \`briefSummary\` says whether it rendered (and bumps the settings version once more). If it did not, the sections are still committed; run \`RegenerateBriefSummary\` to re-render.
Example: \`{ "kind": "SetBrief", "projectId": "p1", "parameters": { "audience": "Rural youth, 15–25" }, "ifMatchVersion": 7 }\``,
  },
  {
    kind: 'RegenerateBriefSummary',
    title: 'Regenerate brief summary',
    oneLiner: 'Re-render the brief’s L1 summary so the copilot sees the current sections.',
    minRoleLevel: MAINTAINER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### RegenerateBriefSummary
Params: \`{ projectId, ifMatchVersion }\` — sole command; REST changesets only (like SetBrief, not offered through the MCP prepare tools).
Renders \`translationBrief.l1Summary\` from the brief's CURRENT sections + notes with the same prompt and 1600-char cap the in-app "Regenerate summary" button uses, and writes \`l1Summary\` / \`l1GeneratedAt\` / \`l1ModelId\` back through the version-guarded settings write. The L1 is the ONLY part of the brief the copilot's prompt injects (see \`parts.brief\` in the prompt-preview read), so this is how a brief written by SetBrief — or edited in-app without regenerating — reaches the AI.
Gotchas:
- Needs at least one filled section or \`freeformNotes\`; otherwise \`validation_failed\` "nothing to summarize" (nothing staged).
- \`ifMatchVersion\` is the SETTINGS version and must match at prepare AND commit (plan_stale on drift). A successful commit bumps it by one.
- The render runs BEFORE the approval is consumed: a failed model call answers \`job_failed\` / \`rate_limited\` (credit cap) and leaves the approved changeset committable for a retry.
- Receipt carries \`briefSummaryChars\` and \`l1ModelId\`.
Example: \`{ "kind": "RegenerateBriefSummary", "projectId": "p1", "ifMatchVersion": 8 }\``,
  },
  {
    kind: 'ProjectSetup',
    title: 'Project setup (composite)',
    oneLiner: 'Settings, brief, members and imports for one project in ONE approval.',
    minRoleLevel: MAINTAINER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### ProjectSetup
Params: \`{ projectId, settings?, brief?, members?, imports? }\` — sole command; at least one block. REST changesets only (like SetBrief, not offered through the MCP prepare tools). ALWAYS ask-mode: one changeset, one approval URL, one commit.
The server expands it into a fixed step order and chains the version guards ITSELF, which is why \`plan_stale\` cannot occur inside a plan:
1. \`settings\` — non-policy keys, one write.
2. \`settings\` — policy keys, restrictive direction only, re-checked against the LIVE blob at commit.
3. \`brief\` — \`{ parameters?, freeformNotes? }\`, merged into the live brief exactly as SetBrief does, then the L1 summary is re-rendered so it reaches the copilot.
4. \`members\` — \`[{ username, role }]\`, upsert (invite a new person, re-role a member) through the Membership gate.
5. \`imports\` — \`[{ artifactId, fileName, fileType?, resultIndex?, sourceLanguage?, targetLanguage? }]\`, in array order: each artifact is parsed server-side and applied as a PlanImport.
6. The verification receipt (below).
Gotchas:
- The project must already EXIST. The spec's \`project\` create-in-plan block is NOT supported — artifacts are project-scoped, so a plan carrying imports cannot target a project that does not exist yet. Passing \`project\` is \`validation_failed\` with \`details.field: "project"\`: create it with CreateProject (its own approval) first.
- Never guess these four — they come from the partner, not from you: \`settings.sourceLanguage\`, \`settings.targetLanguage\`, \`brief.parameters.sourceTexts\`, \`brief.parameters.keyTerms\`. See the \`project-setup\` skill.
- Every prepare rejection NAMES the offending field in \`details.field\`: unknown/mistyped settings key, a policy write that would loosen, an unknown brief section, a duplicate \`fileName\` inside the plan or against an existing active file.
- Limits: \`imports\` ≤ 10 (each ≤ the PlanImport cell cap), \`members\` ≤ 25.
- Floor is the MAX of the constituent floors (MAINTAINER, plus the org's termbase/language floors when those keys are named).
- Failure semantics: the commit stops at the first failing step and returns \`job_failed\` with \`details.receipt\` (\`completedSteps\`, \`failedStep\`). Applied steps STAY applied; committing the same changeset again resumes at the failed step and skips the rest. Steps whose end-state already existed at prepare are marked \`superseded\` and reported as \`superseded_step\` warnings.
- Policy keys a human loosened between prepare and commit are DROPPED (the rest of the plan still applies) and listed in \`verification.policyKeysNotApplied\`.
- Receipt carries \`verification: { settingsVersion, members[{username,role}], files[{fileId,name,cellCount,cellsWithMarkup}], briefReachesCopilot, policyKeysNotApplied }\`. \`briefReachesCopilot\` is the real prompt-preview run on the first source cell of the first created file — if it is false, the brief is NOT reaching the AI.
Example: \`{ "kind": "ProjectSetup", "projectId": "p1", "settings": { "sourceLanguage": "ru", "targetLanguage": "sty", "contributeToGlobalTm": false }, "brief": { "parameters": { "audience": "Rural youth" } }, "members": [{ "username": "gulsifa", "role": 600 }], "imports": [{ "artifactId": "01a0…", "fileName": "Acts", "fileType": "usfm" }] }\``,
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
    oneLiner: 'Stage any allowed project events: comments, waives, validations, files, assignments, terms.',
    minRoleLevel: COMMENTER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### EmitEvents
Params: \`{ events: [{ kind, fileId?, cellId?, laneId?, payload? }] }\` — sole command; max 200 events per changeset.
The generalized escape hatch: stages role-allowed event kinds through the same precondition doctrine as SetTranslation. The changeset floor is the max floor across events (per-kind floors come from role-policy).

**The allowlist IS the permission surface.** A kind not on this list is rejected at prepare with \`validation_failed\` naming the kind — there is no bypass, and adding a kind is a deliberate human change to this file.

Allowed kinds:
- Comments (200+): \`comment.create\` \`{ body, parentCommentId?, createdForTranslated? }\` (scope from the envelope: cell / file / project) · \`comment.edit\` \`{ commentId, body }\` · \`comment.delete\` \`{ commentId }\` · \`comment.resolve\` \`{ commentId, resolved }\`.
- Quality waivers (400+): \`cell.waive\` \`{ ruleId, reason? }\` · \`cell.unwaive\` \`{ ruleId }\` — need fileId + cellId.
- Validation † (400+, testimony — reviewed per item, never bulk): \`cell.validate\` \`{}\` · \`cell.unvalidate\` \`{ targetUsername? }\` — need fileId + cellId; removing someone else's validation needs maintainer (600).
- Back-translation (400+): \`cell.backtranslation.set\` \`{ btText, btHtml?, polished? }\` — needs fileId + cellId.
- Staleness (400+): \`target.cell.repin\` \`{}\` — needs fileId + cellId.
- File lifecycle (500+): \`file.rename\` \`{ name }\` · \`file.delete\` \`{}\` · \`file.restore\` \`{}\` — need fileId.
- Assignments (500+): \`assignment.create\` \`{ scopeKind: 'books'|'chapters', scope: [{ fileId, chapter? }], scopeLabel, assigneeUserId, deadline?, note?, assignmentId? }\` · \`assignment.reassign\` \`{ assignmentId, assigneeUserId }\` · \`assignment.unassign\` \`{ assignmentId }\`.
- Terminology (400+ to suggest; the org's termbase floor — default 500 — to bind): \`term.create\` \`{ sourceTerm, renderings: [{ rendering, status: 'preferred'|'admitted'|'forbidden' }], status: 'draft'|'active', notes?, caseSensitive?, conceptId? }\` · \`term.update\` \`{ conceptId, sourceTerm?, renderings?, notes?, caseSensitive? }\` · \`term.delete\` \`{ conceptId }\` · \`term.approve\` \`{ conceptId }\` · \`term.reject\` \`{ conceptId, mode: 'delete'|'deprecate' }\` — project-level, so omit fileId/cellId.

Not here: target text (use SetTranslation), source edits, cell structure (split/merge/insert/delete), audio (use LinkMedia), imports (use PlanImport), reorders/retimes, membership, and project lifecycle. Rules and Living Memory are not event-sourced at all — rules go through PatchSettings, memory through the agent-memory API — so they cannot be emitted here.
Gotchas:
- Head pins (editEventId / targetEventId / sourceEventId / expectedTargetEventId) are SERVER-RESOLVED from the live projection at prepare — omit them; a supplied value is rejected. Commit re-checks the pins (plan_stale on drift).
- Every referenced cell/comment/file/assignment/concept must exist at prepare — one bad reference rejects the whole plan (no silent skips).
- Terminology: \`status: 'active'\` on create, and every update/delete/approve/reject, are BINDING writes gated by the org's termbase floor; \`status: 'draft'\` is a suggestion any contributor may stage. \`term.create\` naming an existing concept is rejected (use \`term.update\`) — omit \`conceptId\` and the server mints one. Status is not patchable via \`term.update\`; approve/reject are their own kinds so the audit trail keeps them apart.
- payload shapes match the app's event vocabulary — call describe_command or docs before hand-building unfamiliar payloads.

Validation guardrails (\`cell.validate\` / \`cell.unvalidate\`; AQU-1184) — these are policy, not preferences, and no parameter turns any of them off:
- **AI-drafted text cannot be validated through this API.** A \`cell.validate\` whose cell is still an unreviewed machine draft (\`ai_drafted\`) is rejected at prepare with \`validation_failed\` naming that cell, and it rejects the WHOLE plan. This mirrors the in-app rule that AI output is reviewed one cell at a time. To validate such a cell, a human edits or validates it in the app first (either clears the marker); an agent cannot clear it on its own behalf.
- **Explicit cells only.** Every event names one \`(fileId, cellId)\`. There is no wildcard, glob, range, \`"*"\`, or "validate all" form — such a value is simply a cell id that does not exist, and prepare rejects the plan.
- **Every staged validation is itemized for the approver.** The effect summary lists each cell id with the text as the server reads it, so approval endorses specific sentences, not a count. Validations are testimony tier: review UIs confirm them per item and never bulk-apply them.
- **Project validation policy still governs the commit.** The compiled events go through the /events perimeter as the credential's own user, so the validation role floor, the validator allowlist, and \`allowSelfValidation\` apply exactly as they do in the app — a credential cannot validate what its owner could not.
Example: \`{ "kind": "EmitEvents", "events": [{ "kind": "term.create", "payload": { "sourceTerm": "covenant", "renderings": [{ "rendering": "заповіт", "status": "preferred" }], "status": "draft" } }] }\``,
  },
  {
    kind: 'RenameFile',
    title: 'Rename file',
    oneLiner: 'Change a file’s display label in the project sidebar.',
    minRoleLevel: CONTRIBUTOR,
    tier: 'prepared',
    agentReachable: true,
    paramsDoc: `### RenameFile
Params: \`{ fileId, name }\` — batch several per changeset; cannot mix with other command kinds.
\`name\` is trimmed; 1–256 chars, matching the UI's rename field. Compiles to \`file.rename\` through the /events perimeter, at the same CONTRIBUTOR floor the UI rename uses.
Gotchas:
- Sugar over EmitEvents: the staged plan you read back holds the equivalent \`file.rename\` events, not a \`RenameFile\` entry. Behavior is identical either way.
- The file must exist and not be deleted at prepare, and is re-checked at commit (plan_stale on drift).
- File DELETE is deliberately not offered as its own command — soft-delete/trash semantics are still in flux (AQU-272).
Example: \`{ "kind": "RenameFile", "fileId": "f1", "name": "Mark (draft 2)" }\``,
  },
  {
    kind: 'RenameProject',
    title: 'Rename project',
    oneLiner: 'Change a project’s name (maintainer+).',
    minRoleLevel: MAINTAINER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### RenameProject
Params: \`{ projectId, name }\` — sole command in its changeset; \`projectId\` must equal the changeset's project.
Receipt-only (a plain \`projects\` row write, not an event), gated at MAINTAINER 600 — the same floor as the UI's rename. Always staged in ask-mode regardless of credential mode, so it always needs human approval at the approvalUrl before commit.
\`name\` is trimmed; 1–256 chars. Renaming to the name the project already has is rejected at prepare (nothing to do), and, if a human gets there first, lands as \`superseded\` at commit.`,
  },
  {
    kind: 'ArchiveProject',
    title: 'Archive project',
    oneLiner: 'Move a project to Trash — recoverable (owner only).',
    minRoleLevel: OWNER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### ArchiveProject
Params: \`{ projectId }\` — sole command in its changeset; \`projectId\` must equal the changeset's project.
Receipt-only (stamps \`projects.archived_at\`), OWNER 700 only — the same floor as the UI's archive. Always staged in ask-mode regardless of credential mode: no agent archives a project unattended. Reversible with UnarchiveProject; project DELETE is never exposed to any agent surface.
Gotchas:
- Archiving an already-archived project is rejected at prepare, and lands as \`superseded\` at commit if a human archived it first.
- Once archived, ordinary project reads and writes stop resolving for everyone; only the lifecycle commands still reach the project.`,
  },
  {
    kind: 'UnarchiveProject',
    title: 'Restore project',
    oneLiner: 'Restore a project from Trash (owner only).',
    minRoleLevel: OWNER,
    tier: 'structural',
    agentReachable: true,
    paramsDoc: `### UnarchiveProject
Params: \`{ projectId }\` — sole command in its changeset; \`projectId\` must equal the changeset's project.
Receipt-only (clears \`projects.archived_at\`), OWNER 700 only — the same floor as the UI's restore. Always staged in ask-mode, like ArchiveProject. Unarchiving a project that is not archived is rejected at prepare, and lands as \`superseded\` at commit if a human restored it first.`,
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
  {
    kind: 'DraftCells',
    title: 'Draft cells',
    oneLiner: 'Have the project’s own copilot draft named cells; stages as AI drafts.',
    minRoleLevel: CONTRIBUTOR,
    tier: 'prepared',
    agentReachable: true,
    paramsDoc: `### DraftCells
Params: \`{ fileId, cellIds: [...], laneId?, instructions? }\` — sole command in its changeset.
Asks the APP to draft instead of writing the text yourself, so the output carries this project's terminology, few-shot pairs and translation brief. Drafting runs once, at prepare; the generated text is materialized into \`target.cell.commit\` events marked \`ai_drafted\`, exactly like an in-app draft — so a human reviews it as AI work, and \`aiDraft\` is visible in cell reads until they edit or validate it.
Gotchas:
- \`cellIds\` is EXPLICIT and non-empty. Wildcards ("*", "all") are rejected — there is no "draft everything".
- Cap per changeset = the project's configured completion batch size (default 10, max 50). Over-cap requests are rejected naming the cap; split the work across changesets.
- Spend meters through the org's credit ledger on the agent rail. An exhausted org fails with \`rate_limited\` and NOTHING is staged.
- No auto-commit: the result is a staged changeset like any other, subject to the same approval gate and one-hour expiry.
- \`laneId\` must already be registered in the project's targetLanes; omit for the default lane.
Example: \`{ "kind": "DraftCells", "fileId": "f1", "cellIds": ["c3", "c4", "c5"] }\``,
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
