// ProjectSetup commit (AQU-1294 §2.1 / §2.4) — walk the prepare-time step
// ledger in order, persist each step's status as it lands, and finish with the
// server-computed verification receipt.
//
// Two invariants make this safe to resume:
//
//   1. THE SERVER OWNS THE VERSIONS. Every settings-blob write (settings,
//      policy, brief) reads the LIVE version immediately before it writes and
//      passes it as `ifMatchVersion`. The plan carries no version pin to go
//      stale, which is why `plan_stale` cannot surface from inside a plan —
//      the whole point of the composite command.
//   2. THE LEDGER IS PERSISTED AFTER EVERY STEP. A step that lands is written
//      back as `applied` (with its file id, for an import) before the next one
//      starts, so a `job_failed` mid-plan leaves the changeset in `committing`
//      with an honest receipt, and a retry commit skips what already landed and
//      resumes at the failed step. Nothing is rolled back: unwinding a created
//      file or an added member is more dangerous than leaving it (spec §2.1).
//
// Policy keys are re-evaluated against the LIVE blob here, not trusted from
// prepare: a human who loosened a key in between must not have a stale tighten
// applied as a loosen. Ops that would now loosen are DROPPED (the rest of the
// plan still applies) and reported in `verification.policyKeysNotApplied`.

import { errorResponse, toErrorResponse } from './errors'
import { receiptOnlyGates, writeCommittedReceipt } from './commit-gates'
import { assertCredentialScope } from './token-bridge'
import { applyPlanImport } from './commit'
import { renderBriefSummary } from './brief-summary-bridge'
import { buildPromptPreview } from './prompt-preview'
import { parseArtifactToCells } from './import-parse-core'
import {
  applyMembershipRows,
  callerLevelOrDenial,
  gateOne,
  type CommitTarget,
  type MembershipCommand,
} from './commands-membership'
import { briefPatchOfSetup, splitSettingsOps, type ProjectSetupCommand } from './commands-project-setup'
import { projectSetupFloor } from './prepare-project-setup'
import type { PatchSettingsOp } from './commands-patch-settings'
import type { PlanImportCommand } from './commands'
import type {
  ExternalEnv,
  PlannedEventIds,
  ProjectSetupBriefDetails,
  ProjectSetupPlan,
  ProjectSetupReceipt,
  ProjectSetupStep,
  ProjectSetupVerification,
  ProvenanceChannel,
  StoredChangeset,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { loadProjectSettings, patchProjectSettingsShared } from '../../../db/shared/projects'
import { loosensPolicy } from '../../../db/shared/policy-direction'
import {
  applyBriefL1Summary,
  applyBriefPatch,
  assembleBriefL2Markdown,
  BRIEF_SETTINGS_KEY,
  emptyBriefRecord,
  isBriefL1Stale,
  readBriefFromSettings,
} from '../../../db/shared/brief'

/** A step either applies (optionally reporting facts) or fails with a reason. */
type StepOutcome = { ok: true; fileId?: string } | { ok: false; error: string }

/**
 * What the brief step's best-effort L1 render actually did (AQU-1323). A failed
 * render still lets the step apply — the sections landed — but it must never
 * again be *silent*: `briefReachesCopilot` is computed from this, not from the
 * mere presence of some (possibly days-old) summary.
 *
 * `sectionsWrittenAt` is the merge timestamp stamped into the brief record, so
 * the freshness test is a comparison against the write this very commit made.
 */
type BriefRenderOutcome =
  | { ok: true; sectionsWrittenAt: string; renderedAt: string; chars: number; truncated: boolean }
  | { ok: false; sectionsWrittenAt: string; reason: string }

interface StepContext {
  request: Request
  env: ExternalEnv
  db: AquillaDb
  cred: ApiCredentialContext
  cs: StoredChangeset
  cmd: ProjectSetupCommand
  channel: ProvenanceChannel
  confirmationId: string | null
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined
  /** Accumulated across steps and reported on the verification receipt. */
  policyKeysNotApplied: string[]
  /** Set by the brief step; null when this plan carried no brief block, or when
   *  a resumed commit skipped an already-applied brief step. */
  briefRender: BriefRenderOutcome | null
}

/**
 * Commit a ProjectSetup changeset. Re-runs the prepare-time authorization live
 * (scope + the plan's effective floor), consumes the ask-mode approval through
 * the shared gates, then walks the step ledger.
 */
export async function commitProjectSetup(
  request: Request,
  env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: ProjectSetupCommand,
  channel: ProvenanceChannel,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const projectId = cs.projectId

  // Receipt-shaped path: it mints no internal token of its own for the settings
  // and membership writes, so re-assert the credential's scope ceiling here.
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const ops = splitSettingsOps(cmd.settings)
  const requiredRole = await projectSetupFloor(db, projectId, cmd, ops)
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < requiredRole) {
    return errorResponse('permission_denied', 'insufficient project role to commit this project setup', {
      requiredRole,
    })
  }

  const plan = cs.plannedIds?.projectSetup
  if (!plan) {
    return errorResponse('job_failed', 'ProjectSetup changeset is missing its step ledger')
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate

  const step: StepContext = {
    request, env, db, cred, cs, cmd, channel,
    confirmationId: gate.confirmationId,
    ctx,
    policyKeysNotApplied: [],
    briefRender: null,
  }

  for (const current of plan.steps) {
    // `applied` / `superseded` are terminal: a retry commit skips them, which
    // is what makes "fix the input and re-run" the recovery path.
    if (current.status === 'applied' || current.status === 'superseded') continue

    const outcome = await applyStep(step, current)
    if (!outcome.ok) {
      current.status = 'failed'
      const receipt = buildReceipt(step, plan, { index: current.index, kind: current.kind, error: outcome.error })
      await persistProgress(db, cs, plan, receipt)
      return errorResponse(
        'job_failed',
        `project setup stopped at step ${current.index} (${current.kind}) — fix the cause and commit again to resume`,
        { receipt },
      )
    }
    current.status = 'applied'
    if (current.kind === 'import' && outcome.fileId) current.fileId = outcome.fileId
    await persistProgress(db, cs, plan, buildReceipt(step, plan, null))
  }

  const verification = await buildVerification(step, plan)
  const receipt: ProjectSetupReceipt = { ...buildReceipt(step, plan, null), verification }
  // Keep the (now all-applied) ledger on the row alongside the terminal receipt.
  await persistProgress(db, cs, plan, receipt)
  await writeCommittedReceipt(db, cs.id, receipt, step.confirmationId)
  return Response.json({ receipt })
}

// ── step dispatch ────────────────────────────────────────────────────────────

async function applyStep(step: StepContext, current: ProjectSetupStep): Promise<StepOutcome> {
  switch (current.kind) {
    case 'settings':
      return applySettingsStep(step, current.ops)
    case 'policy':
      return applyPolicyStep(step, current.ops)
    case 'brief':
      return applyBriefStep(step)
    case 'members':
      return applyMembersStep(step, current.pinned)
    case 'import':
      return applyImportStep(step, current)
  }
}

/**
 * One version-guarded settings write against the LIVE version. A conflict is
 * another writer landing between the read and the write; retried ONCE with a
 * fresh read, then failed — never surfaced as `plan_stale`, because inside a
 * plan there is no caller-supplied pin that could be stale.
 */
async function writeSettingsOps(
  db: AquillaDb,
  projectId: string,
  ops: readonly PatchSettingsOp[],
  updatedBy: string | number,
): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const live = await loadProjectSettings(db, projectId)
    const result = await patchProjectSettingsShared(db, {
      projectId,
      ops: [...ops],
      ifMatchVersion: live.version,
      updatedBy,
    })
    if (result.status === 'ok') return { ok: true, version: result.settings.version }
    if (result.status === 'error') return { ok: false, error: result.message }
  }
  return { ok: false, error: 'the project settings were being written concurrently — retry the commit' }
}

async function applySettingsStep(step: StepContext, ops: PatchSettingsOp[]): Promise<StepOutcome> {
  const written = await writeSettingsOps(step.db, step.cs.projectId, ops, step.cred.userId)
  return written.ok ? { ok: true } : { ok: false, error: written.error }
}

/**
 * The policy step, re-evaluated against the LIVE blob. Ops that would now
 * loosen are dropped (and named on the receipt) rather than failing the plan:
 * the human approved a tightening, and a human tightening further in the
 * meantime is not a reason to abandon the rest of the setup.
 */
async function applyPolicyStep(step: StepContext, ops: PatchSettingsOp[]): Promise<StepOutcome> {
  const live = await loadProjectSettings(step.db, step.cs.projectId)
  const refused = new Set(loosensPolicy(ops, live.settings).map((verdict) => verdict.key))
  const admissible = ops.filter((op) => !refused.has(op.key))
  for (const key of refused) {
    if (!step.policyKeysNotApplied.includes(key)) step.policyKeysNotApplied.push(key)
  }
  if (admissible.length === 0) return { ok: true }
  const written = await writeSettingsOps(step.db, step.cs.projectId, admissible, step.cred.userId)
  return written.ok ? { ok: true } : { ok: false, error: written.error }
}

/**
 * Merge the brief patch into the LIVE brief record and write it back, then
 * render the L1 so the brief actually reaches the copilot (the L1 is the only
 * part prompt-preview injects). A failed render is NOT a step failure — the
 * sections landed, and unwinding them would be worse — but it is RECORDED:
 * `briefReachesCopilot` is computed from `step.briefRender`, so the composite
 * command's central promise ("the brief reaches the AI without a human clicking
 * regenerate") is asserted on the receipt rather than assumed (AQU-1323).
 */
async function applyBriefStep(step: StepContext): Promise<StepOutcome> {
  const projectId = step.cs.projectId
  const now = new Date().toISOString()
  const author = step.cred.username || String(step.cred.userId)

  const live = await loadProjectSettings(step.db, projectId)
  const record = readBriefFromSettings(live.settings) ?? emptyBriefRecord(author, now)
  const next = applyBriefPatch(record, briefPatchOfSetup(step.cmd), author, now)

  const written = await writeSettingsOps(
    step.db, projectId, [{ key: BRIEF_SETTINGS_KEY, value: next }], step.cred.userId,
  )
  if (!written.ok) return { ok: false, error: written.error }

  // A hand-edited record can carry sections with no assembled L2; summarize the
  // assembly rather than sending the renderer an empty document (the same
  // fallback RegenerateBriefSummary applies).
  const rendered = await renderBriefSummary(step.env, {
    projectId,
    userId: step.cred.userId,
    l2Markdown: next.l2Markdown.trim() || assembleBriefL2Markdown(next),
  })
  if (!rendered.ok) {
    step.briefRender = {
      ok: false,
      sectionsWrittenAt: now,
      reason:
        `the L1 summary was not re-rendered (${rendered.code}: ${rendered.message}) — ` +
        'the brief sections are committed but the copilot still reads the previous summary; ' +
        'run RegenerateBriefSummary',
    }
    return { ok: true }
  }

  const renderedAt = new Date().toISOString()
  const withL1 = applyBriefL1Summary(next, rendered.summary, rendered.model, renderedAt)
  const stored = await writeSettingsOps(
    step.db, projectId, [{ key: BRIEF_SETTINGS_KEY, value: withL1 }], step.cred.userId,
  )
  if (!stored.ok) {
    step.briefRender = {
      ok: false,
      sectionsWrittenAt: now,
      reason:
        `the L1 summary rendered but could not be stored (${stored.error}) — ` +
        'the copilot still reads the previous summary; run RegenerateBriefSummary',
    }
    return { ok: true }
  }

  step.briefRender = {
    ok: true,
    sectionsWrittenAt: now,
    renderedAt,
    chars: rendered.summary.length,
    truncated: rendered.truncated,
  }
  return { ok: true }
}

/**
 * The members step. Every pinned target is re-gated against the caller's LIVE
 * role — the same gate a Membership changeset runs — and the pinned user id
 * wins over a fresh username lookup: the human approved a PERSON.
 */
async function applyMembersStep(
  step: StepContext,
  pinned: readonly { username: string; userId: string; role: number }[],
): Promise<StepOutcome> {
  const projectId = step.cs.projectId
  const callerLevel = await callerLevelOrDenial(step.db, step.cred, projectId)
  if (callerLevel instanceof Response) {
    return { ok: false, error: 'the committing credential no longer holds the role needed to manage membership' }
  }

  const targets: CommitTarget[] = []
  for (const entry of pinned) {
    const gateCmd: MembershipCommand = {
      kind: 'SetRole',
      projectId,
      username: entry.username,
      role: entry.role,
    }
    const gate = await gateOne(step.db, step.cred, callerLevel, gateCmd)
    if (!gate.ok) return { ok: false, error: `membership gate refused ${entry.username}` }
    if (String(gate.target.id) !== String(entry.userId)) {
      return { ok: false, error: `${entry.username} no longer resolves to the account this plan was approved for` }
    }
    // Already at the approved role — a human got there first. Skip the row.
    if (gate.directLevel === entry.role) continue
    targets.push({
      cmd: { ...gateCmd, kind: gate.directLevel === null ? 'InviteMember' : 'SetRole' },
      userId: gate.target.id,
      username: gate.target.username,
      directLevel: gate.directLevel,
    })
  }
  await applyMembershipRows(step.db, step.env, step.cred, projectId, targets, step.ctx)
  return { ok: true }
}

/**
 * One import step: re-parse the (immutable) artifact and apply it through the
 * SAME `applyPlanImport` a sole-command PlanImport uses.
 *
 * The re-parse must reproduce the prepare-time cell count exactly. It cannot
 * drift on its own — artifact bytes never change — so a mismatch means the
 * parser or the project's import settings moved under the plan, and the human
 * approved a file of the other size. That fails the step.
 */
async function applyImportStep(
  step: StepContext,
  current: Extract<ProjectSetupStep, { kind: 'import' }>,
): Promise<StepOutcome> {
  const projectId = step.cs.projectId
  const parsed = await parseArtifactToCells(step.env, projectId, current.artifactId, {
    fileType: current.fileType,
    ...(current.resultIndex !== undefined ? { resultIndex: current.resultIndex } : {}),
    requireSingleResult: true,
  })
  if (!parsed.ok) {
    return { ok: false, error: `artifact ${current.artifactId} could not be re-parsed at commit` }
  }
  if (parsed.parsed.cells.length !== current.cellCount) {
    return {
      ok: false,
      error:
        `artifact ${current.artifactId} now parses to ${parsed.parsed.cells.length} cells, ` +
        `not the ${current.cellCount} that were approved`,
    }
  }

  const planImport: PlanImportCommand = {
    kind: 'PlanImport',
    fileName: current.fileName,
    fileType: current.fileType,
    ...(current.sourceLanguage !== undefined ? { sourceLanguage: current.sourceLanguage } : {}),
    ...(current.targetLanguage !== undefined ? { targetLanguage: current.targetLanguage } : {}),
    artifactId: current.artifactId,
    cells: parsed.parsed.cells,
  }
  const outcome = await applyPlanImport(
    step.request,
    step.env,
    step.db,
    step.cred,
    step.cs,
    planImport,
    { planned: current.planned, baseWarnings: [] },
    step.confirmationId,
    step.channel,
    step.ctx,
  )
  if (outcome.error) return { ok: false, error: `import "${current.fileName}" could not be applied` }
  if (!outcome.ok) {
    return {
      ok: false,
      error: `import "${current.fileName}" partially applied (${outcome.rejected.length} event(s) rejected)`,
    }
  }
  return { ok: true, fileId: outcome.fileId }
}

// ── receipt + verification ───────────────────────────────────────────────────

function buildReceipt(
  step: StepContext,
  plan: ProjectSetupPlan,
  failedStep: ProjectSetupReceipt['failedStep'],
): ProjectSetupReceipt {
  return {
    credentialId: step.cred.credentialId,
    channel: step.channel,
    changesetId: step.cs.id,
    command: 'ProjectSetup',
    appliedAt: new Date().toISOString(),
    projectId: step.cs.projectId,
    completedSteps: plan.steps.map((s) => ({ index: s.index, kind: s.kind, status: s.status })),
    failedStep,
  }
}

/** Persist the ledger + the in-progress receipt without closing the changeset.
 *  The ledger rides in the `summary` JSONB column (see store.ts::rowToStored),
 *  so the whole object is rewritten rather than patched in place. */
async function persistProgress(
  db: AquillaDb,
  cs: StoredChangeset,
  plan: ProjectSetupPlan,
  receipt: ProjectSetupReceipt,
): Promise<void> {
  const plannedIds: PlannedEventIds = { ...(cs.plannedIds ?? {}), projectSetup: plan }
  await db
    .prepare(
      `UPDATE changesets SET summary = ?::text::jsonb, receipt = ?::text::jsonb
        WHERE id = ? AND status IN ('staged','committing')`,
    )
    .bind(JSON.stringify({ ...cs.summary, plannedIds }), JSON.stringify(receipt), cs.id)
    .run()
}

/**
 * Spec §2.4: the facts an operator would otherwise have to re-query five
 * endpoints for, computed server-side from the LIVE projection.
 */
async function buildVerification(
  step: StepContext,
  plan: ProjectSetupPlan,
): Promise<ProjectSetupVerification> {
  const { db, cs } = step
  const projectId = cs.projectId
  const live = await loadProjectSettings(db, projectId)

  const memberStep = plan.steps.find((s): s is Extract<ProjectSetupStep, { kind: 'members' }> => s.kind === 'members')
  const members: { username: string; role: number }[] = []
  for (const entry of memberStep?.pinned ?? []) {
    const resolved = await resolveProjectRoleShared(db, { id: entry.userId }, projectId)
    members.push({ username: entry.username, role: resolved?.level ?? 0 })
  }

  const files: ProjectSetupVerification['files'] = []
  for (const s of plan.steps) {
    if (s.kind !== 'import' || !s.fileId) continue
    // `cellsWithMarkup` is the AQU-1283 guard, asserted rather than assumed: a
    // USFM marker surviving into a committed source cell is a parser problem
    // and the operator must be told about it in the same breath as the import.
    const counts = await db
      .prepare(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE strpos(value, ?) > 0) AS with_markup
           FROM cells WHERE project_id = ? AND file_id = ? AND side = 'source'`,
      )
      .bind('\\', projectId, s.fileId)
      .first<{ total: number | string; with_markup: number | string }>()
    files.push({
      fileId: s.fileId,
      name: s.fileName,
      cellCount: Number(counts?.total ?? 0),
      cellsWithMarkup: Number(counts?.with_markup ?? 0),
    })
  }

  const brief = await verifyBriefReachesCopilot(step, plan, files, live.settings)

  return {
    settingsVersion: live.version,
    members,
    files,
    briefReachesCopilot: brief.reaches,
    ...(brief.details ? { briefDetails: brief.details } : {}),
    policyKeysNotApplied: [...step.policyKeysNotApplied],
  }
}

/**
 * Does the brief actually reach the copilot?
 *
 * Two questions, and AQU-1323 is what happens when you only ask the second:
 *
 *   1. Is the summary the copilot reads the one THIS PLAN wrote? A plan that
 *      commits sections and then fails to re-render the L1 leaves the copilot
 *      reading whatever was there before — so the freshness check comes first,
 *      and it is answered from the step's own render outcome, never from the
 *      stored summary being non-empty. Reporting `true` there is worse than
 *      reporting nothing: an agent reading the receipt stops checking.
 *   2. Is it actually injected? Answered the only honest way — run the real
 *      prompt-preview builder on the first source cell of the first file this
 *      plan created and look at `parts.brief`. With no file to stand on, fall
 *      back to what prompt-preview reads: a non-empty L1 summary.
 */
async function verifyBriefReachesCopilot(
  step: StepContext,
  plan: ProjectSetupPlan,
  files: ProjectSetupVerification['files'],
  settings: Record<string, unknown>,
): Promise<{ reaches: boolean; details?: ProjectSetupBriefDetails }> {
  const brief = readBriefFromSettings(settings)
  const l1GeneratedAt = brief?.l1GeneratedAt ?? null
  const briefStep = plan.steps.find((s) => s.kind === 'brief')

  // ── 1. freshness ─────────────────────────────────────────────────────────
  if (briefStep && briefStep.status === 'applied') {
    const render = step.briefRender
    if (!render) {
      // A resumed commit skipped an already-applied brief step, so this run has
      // no render outcome of its own. Fall back to the stored record's own
      // staleness marker rather than claiming a freshness we cannot attest.
      if (brief && isBriefL1Stale(brief)) {
        return {
          reaches: false,
          details: {
            reason:
              'the L1 summary predates the brief sections — it was not re-rendered when they landed; ' +
              'run RegenerateBriefSummary',
            l1GeneratedAt,
          },
        }
      }
    } else if (!render.ok) {
      return { reaches: false, details: { reason: render.reason, l1GeneratedAt } }
    } else if (l1GeneratedAt === null || l1GeneratedAt < render.sectionsWrittenAt) {
      // The render reported success but the stored summary does not carry it —
      // another writer landed on the brief key after this step.
      return {
        reaches: false,
        details: {
          reason:
            'the L1 summary this plan rendered is not the one now stored — the brief was ' +
            'rewritten after this step; run RegenerateBriefSummary',
          l1GeneratedAt,
        },
      }
    }
  }

  const truncated = step.briefRender?.ok === true && step.briefRender.truncated
  const caveat: ProjectSetupBriefDetails = {
    ...(truncated
      ? {
          truncated: true,
          reason:
            'the rendered summary hit the 1600-character cap and was clipped — some committed ' +
            'brief sections are not in what the copilot reads',
        }
      : {}),
    l1GeneratedAt,
  }

  // ── 2. injection ─────────────────────────────────────────────────────────
  const l1 = (brief?.l1Summary ?? '').trim()
  const notInjected = (reason: string): { reaches: boolean; details: ProjectSetupBriefDetails } => ({
    reaches: false,
    details: { ...caveat, reason },
  })

  const first = files[0]
  if (!first || l1 === '') {
    return l1 !== ''
      ? { reaches: true, details: caveat }
      : notInjected('the brief has no L1 summary, so prompt-preview injects no brief block')
  }

  const cell = await step.db
    .prepare(
      `SELECT cell_id FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source'
        ORDER BY sequence_index ASC, cell_id ASC LIMIT 1`,
    )
    .bind(step.cs.projectId, first.fileId)
    .first<{ cell_id: string }>()
  if (!cell) return { reaches: true, details: caveat }

  const preview = await buildPromptPreview(step.db, {
    projectId: step.cs.projectId,
    cellId: cell.cell_id,
    targetLang: typeof settings.targetLanguage === 'string' ? settings.targetLanguage : '',
    fileId: first.fileId,
  })
  if (!preview.ok) return { reaches: true, details: caveat }
  return preview.body.parts.brief.trim() !== ''
    ? { reaches: true, details: caveat }
    : notInjected('prompt-preview renders no brief block on the first imported cell')
}
