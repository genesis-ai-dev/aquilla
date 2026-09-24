// AQU-926 (docs/COMMAND-REGISTRY.md §4) — the harness's registered-command
// tools. Registration + dispatch stay a minimal diff in agent.ts; logic here.
//
//   propose_command (BUDGETED like propose) — pre-validate the commands
//     against the shared catalog at the run's role (friendlier feedback than
//     a 4xx), mint a project-scoped sync token for the run's USER, POST the
//     commands to sync-worker's session prepare route, emit the
//     `changeset.staged` frame, and return a compact verdict.
//   describe_command (free) — one catalog entry's paramsDoc: the L2 lookup
//     behind the one-line command index in the schema card.
//
// The sync-worker session routes are built in parallel against the same
// contract (COMMAND-REGISTRY §3), so responses are parsed defensively: a
// version skew degrades to a readable tool error, never a crashed run.

import type { AuthUser, Env } from "../../types"
import { mintSyncTokenForUser, type SyncTokenMintFailure } from "../../services/sync-token-mint"
import {
  catalogForRole,
  describeCommand,
  type CommandTier,
} from "../../../../db/shared/command-catalog"
import type { ChangesetStagedFrame } from "./frames"

/** The established sentinel fileId for project-scoped, non-file sync tokens
 *  (see src/lib/sync/archive.ts triggerLinkSync) — sync-worker's
 *  verifyTokenForProject checks projectId only, never fileId. */
const PROJECT_SCOPE_FILE_ID = "__project__"

/** Warnings surfaced to the model are capped — the review UI shows them all. */
const VERDICT_WARNINGS_MAX = 10

export interface CommandToolCtx {
  env: Env
  runId: string
  projectId: string
  /** The run's resolved role — the STATIC pre-validation floor. Dynamic
   *  checks (org overrides, per-event floors) stay in sync-worker prepare. */
  roleLevel: number
  /** The run's requesting user. Commands stage AS this user via a freshly
   *  minted sync token — never a shared worker secret. */
  user: AuthUser
  signal: AbortSignal
  send: (frame: ChangesetStagedFrame) => void
}

export interface ProposeCommandArgs {
  commands?: unknown
  changesetId?: unknown
}

export interface DescribeCommandArgs {
  kind?: unknown
}

function kindOf(cmd: unknown): string | null {
  if (typeof cmd !== "object" || cmd === null) return null
  const kind = (cmd as Record<string, unknown>).kind
  return typeof kind === "string" && kind.length > 0 ? kind : null
}

function availableKindsLine(roleLevel: number): string {
  const kinds = catalogForRole(roleLevel).map((c) => c.kind)
  return kinds.length > 0
    ? `Commands available at your role: ${kinds.join(", ")}. Call describe_command({kind}) for exact params.`
    : "No changeset commands are available at your role."
}

// ── describe_command ────────────────────────────────────────────────────────

export function describeCommandTool(
  args: DescribeCommandArgs,
  ctx: Pick<CommandToolCtx, "roleLevel">,
): string {
  const kind = typeof args.kind === "string" ? args.kind.trim() : ""
  if (!kind) {
    return `error: describe_command needs {kind: string}. ${availableKindsLine(ctx.roleLevel)}`
  }
  const entry = describeCommand(kind)
  // agentReachable=false kinds are governance-only — indistinguishable from
  // unknown on every agent surface by design (audit §6.7).
  if (!entry || !entry.agentReachable) {
    return `error: unknown command "${kind}". ${availableKindsLine(ctx.roleLevel)}`
  }
  const floorNote =
    entry.minRoleLevel > ctx.roleLevel
      ? `note: ${entry.kind} needs role ${entry.minRoleLevel}+ — you act at ${ctx.roleLevel}, so you cannot stage it; use this doc only to explain the command to the user.\n\n`
      : ""
  return `${floorNote}${entry.paramsDoc}`
}

// ── propose_command ─────────────────────────────────────────────────────────

const TIER_RANK: Record<CommandTier, number> = {
  prepared: 0,
  structural: 1,
  testimony: 2,
  governance: 3,
}

/** Max risk tier across the staged kinds (all pre-validated → catalog hits). */
function maxTier(kinds: string[]): CommandTier | undefined {
  let top: CommandTier | undefined
  for (const kind of kinds) {
    const tier = describeCommand(kind)?.tier
    if (tier && (top === undefined || TIER_RANK[tier] > TIER_RANK[top])) top = tier
  }
  return top
}

function num(obj: Record<string, unknown>, key: string): number {
  const v = obj[key]
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
}

/** Render the server's effect summary (COMMAND-REGISTRY §2 ChangesetSummary)
 *  as one human line + a cell count for the frame. Field-tolerant: unknown
 *  summaries fall back to the command count. */
function summarize(
  summary: Record<string, unknown>,
  commandCount: number,
): { line: string; cellCount: number; warnings: string[] } {
  const parts: string[] = []
  let cellCount = 0
  const push = (n: number, label: string) => {
    if (n > 0) {
      parts.push(`${n} ${label}`)
      cellCount += n
    }
  }
  push(num(summary, "translationsAdded"), "translation(s) added")
  push(num(summary, "translationsModified"), "translation(s) modified")
  push(num(summary, "sourceCellsAdded"), "source cell(s)")
  push(num(summary, "targetVariantsAdded"), "target variant(s)")
  push(num(summary, "mediaLinked"), "cell(s) media-linked")
  if (num(summary, "filesCreated") > 0) parts.push(`${num(summary, "filesCreated")} file(s) created`)
  // EmitEvents summaries carry events: { kind, count, testimony, label }[].
  // AQU-1179: prefer the server's plain-language `label` — this line is read by
  // the person deciding whether to apply the plan, and "3 cell.backtranslation.set"
  // is not something anyone can consent to. Older summaries have no label; they
  // keep the raw-kind rendering.
  const events = Array.isArray(summary.events) ? summary.events : []
  for (const ev of events) {
    const e = asRecord(ev)
    const kind = typeof e.kind === "string" ? e.kind : "event"
    const label = typeof e.label === "string" && e.label.length > 0 ? e.label : null
    const count = num(e, "count")
    if (count > 0) {
      const text = label ?? `${count} ${kind}`
      parts.push(`${text}${e.testimony === true ? " (testimony)" : ""}`)
      cellCount += count
    }
  }
  const settings = asRecord(summary.settingsChanges)
  const settingsKeys = Object.keys(settings)
  if (settingsKeys.length > 0) parts.push(`settings: ${settingsKeys.join(", ")}`)
  if (typeof summary.projectName === "string") parts.push(`project "${summary.projectName}"`)

  const warnings: string[] = []
  const rawWarnings = Array.isArray(summary.warnings) ? summary.warnings : []
  for (const w of rawWarnings.slice(0, VERDICT_WARNINGS_MAX)) {
    const r = asRecord(w)
    const code = typeof r.code === "string" ? r.code : "warning"
    const message = typeof r.message === "string" ? r.message : JSON.stringify(w)
    warnings.push(`${code}: ${message}`)
  }
  if (rawWarnings.length > VERDICT_WARNINGS_MAX) {
    warnings.push(`…and ${rawWarnings.length - VERDICT_WARNINGS_MAX} more warning(s)`)
  }

  return {
    line: parts.length > 0 ? parts.join(", ") : `${commandCount} command(s) staged`,
    cellCount,
    warnings,
  }
}

function mintFailureText(reason: SyncTokenMintFailure): string {
  switch (reason) {
    case "not_configured":
      return "sync-token signing is not configured on this deployment"
    case "project_not_found":
      return "the project no longer exists"
    case "project_archived":
      return "the project is archived — nothing can be staged into it"
    case "project_frozen":
      return "the project is frozen — writes are paused"
    case "no_access":
      return "the user's project access could not be resolved"
    case "role_lookup_failed":
    case "lane_grant_lookup_failed":
      return "the user's project access could not be verified right now (temporary server issue) — retry shortly"
    case "unsafe_id":
      return "the project id contains characters that cannot be minted into a sync token"
  }
}

/** Map the external error contract ({ error: { code, message } }, codes from
 *  sync-worker/src/external/errors.ts) to text the model can act on. */
function externalErrorText(status: number, body: unknown): string {
  const err = asRecord(asRecord(body).error)
  const code = typeof err.code === "string" ? err.code : ""
  const message = typeof err.message === "string" ? err.message : `sync-worker returned HTTP ${status}`
  switch (code) {
    case "validation_failed":
      return `validation_failed: ${message} — fix the command params (describe_command({kind}) has the exact shapes) and stage again.`
    case "permission_denied":
    case "scope_denied":
      return `${code}: ${message} — the user's live project role does not allow this; report it to the user instead of retrying.`
    case "plan_stale":
      return `plan_stale: ${message} — project state moved under the plan; re-read the current values and stage a fresh changeset.`
    case "confirmation_required":
      return `confirmation_required: ${message} — a human approval must land first; the user handles that in-app.`
    case "conflict":
      return `conflict: ${message} — that changesetId belongs to a different plan; stage again with a new changesetId.`
    case "rate_limited":
      return `rate_limited: ${message} — stop staging and tell the user to retry later.`
    case "not_found":
      return `not_found: ${message}`
    default:
      return `error: staging failed (HTTP ${status}): ${message}`
  }
}

export async function proposeCommandTool(
  args: ProposeCommandArgs,
  ctx: CommandToolCtx,
): Promise<string> {
  const commands = Array.isArray(args.commands) ? args.commands : null
  if (!commands || commands.length === 0) {
    return `error: propose_command needs {commands: [{kind, …}, …]}. ${availableKindsLine(ctx.roleLevel)}`
  }
  const changesetId = typeof args.changesetId === "string" && args.changesetId.length > 0
    ? args.changesetId
    : undefined

  // Static pre-validation against the shared catalog — unknown kinds,
  // governance-only kinds, and floors above the run's role never reach
  // sync-worker; the model gets what IS available instead of a bare 4xx.
  const problems: string[] = []
  const kinds: string[] = []
  commands.forEach((cmd, i) => {
    const kind = kindOf(cmd)
    if (!kind) {
      problems.push(`command ${i + 1} has no string "kind"`)
      return
    }
    if (!kinds.includes(kind)) kinds.push(kind)
    const entry = describeCommand(kind)
    if (!entry || !entry.agentReachable) {
      problems.push(`command ${i + 1}: unknown kind "${kind}"`)
      return
    }
    if (entry.minRoleLevel > ctx.roleLevel) {
      problems.push(
        `command ${i + 1}: ${kind} needs role ${entry.minRoleLevel}+ — this run acts at ${ctx.roleLevel}`,
      )
    }
  })
  if (problems.length > 0) {
    return `error: ${problems.join("; ")}. ${availableKindsLine(ctx.roleLevel)}`
  }

  const base = (ctx.env.SYNC_WORKER_URL ?? "").replace(/\/$/, "")
  if (!base) {
    return "error: changeset staging is unavailable (SYNC_WORKER_URL is not configured on this deployment)."
  }

  // Stage AS the run's user: a fresh project-scoped write-capable sync token
  // re-resolves their live role and carries their lane/file scopes.
  const mint = await mintSyncTokenForUser(ctx.env, ctx.user, ctx.projectId, PROJECT_SCOPE_FILE_ID)
  if (!mint.ok) {
    return `error: could not authorize staging — ${mintFailureText(mint.reason)}.`
  }

  let res: Response
  try {
    res = await fetch(`${base}/api/v1/changesets/${encodeURIComponent(ctx.projectId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mint.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ commands, ...(changesetId ? { id: changesetId } : {}) }),
      signal: ctx.signal,
    })
  } catch (err) {
    return `error: sync-worker unreachable — ${err instanceof Error ? err.message : String(err)}`
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    /* handled below per status */
  }

  if (!res.ok) return externalErrorText(res.status, body)

  const data = asRecord(body)
  const changeset = asRecord(data.changeset)
  const stagedId = typeof changeset.id === "string" ? changeset.id : changesetId
  if (!stagedId) {
    return "error: sync-worker returned an unreadable staging response (no changeset id)."
  }
  const status = typeof changeset.status === "string" ? changeset.status : "staged"
  const digest =
    typeof data.digest === "string"
      ? data.digest
      : typeof changeset.digest === "string"
        ? changeset.digest
        : ""
  const approvalUrl = typeof data.approvalUrl === "string" ? data.approvalUrl : ""
  const summaryObj = asRecord(
    typeof data.summary === "object" && data.summary !== null ? data.summary : changeset.summary,
  )
  const { line, cellCount, warnings } = summarize(summaryObj, commands.length)
  const tier = maxTier(kinds)

  ctx.send({
    type: "changeset.staged",
    runId: ctx.runId,
    changesetId: stagedId,
    approvalUrl,
    summary: line,
    cellCount,
    digest,
    ...(tier ? { tier } : {}),
    kinds,
  })

  const verdict = {
    changesetId: stagedId,
    status,
    digest,
    summary: line,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
  return `${JSON.stringify(verdict)}\nStaged for human review — the user reviews and applies this changeset in-app; do not poll or wait on it.`
}
