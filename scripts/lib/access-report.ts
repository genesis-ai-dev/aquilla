// AQU-2355 — the per-org access dry-run report, reusable by every permission
// migration under AQU-2351 (org roles AQU-2352, project/lane roles AQU-2353,
// comments AQU-2633, teams AQU-2354).
//
// A migration hands this two access computations over the same people and
// projects — "before" (what the live resolver gives today) and "after" (what it
// gives once the migration's writes and code are in) — plus the list of rows the
// migration would write. The report is pure: no database, no clock. It says,
// per organization, for each person:
//
//   * their effective project role before and after,
//   * the lanes they can read before and after, with every lane LOST and every
//     lane GAINED called out,
//   * whether lanes created later still reach them ("future lanes"),
//
// and then lists every grant the migration adds. A loss is the thing a reviewer
// must read; `intendedLossKeys` lets a migration mark the ones it means (an
// AQU-2352 demotion, say) so an unintended one still stands out.
//
// The snapshot loader that builds "before" from the database lives in
// access-snapshot.ts; a migration builds its "after" by transforming that
// snapshot's raw tables and recomputing.

/** How lanes created later reach a person on one project. */
export type FutureLanes =
  /** Every lane created later, by role (Maintainer/Owner) or an implicit rule. */
  | "every"
  /** Only the project's first target lane, on a project that has none yet. */
  | "first-only"
  /** None: a later lane must be granted to them. */
  | "none"

/** One person's access to one project. */
export interface ProjectAccess {
  userId: number
  projectId: string
  /** Effective project role level (100–700), null when they cannot open it. */
  role: number | null
  /** Where the role comes from, for the reader ("direct", "team", "org", "creator"). */
  roleSource: string | null
  /** Current (non-archived) target lane ids they can read. */
  lanes: readonly string[]
  futureLanes: FutureLanes
  /** Why future lanes reach them, for the reader (e.g. "Maintainer", "AQU-1781 rule"). */
  futureReason?: string | null
}

export interface OrgInfo {
  id: number | null
  name: string
}

export interface ProjectInfo {
  id: string
  name: string
  orgId: number | null
  /** Current target lanes, in display order. */
  lanes: ReadonlyArray<{ id: string; name: string }>
  /** Archived target lanes, only so a row naming one can print its name. */
  archivedLanes?: ReadonlyArray<{ id: string; name: string }>
}

export interface UserInfo {
  id: number
  username: string
}

/** A row the migration writes. `kind` and `detail` are for people to read. */
export interface GrantAdded {
  orgId: number | null
  projectId: string
  kind: string
  /** Who gets it: a username, or a team's name. */
  subject: string
  /** Lane ids it covers, if any. */
  laneIds: readonly string[]
  roleLevel?: number | null
  detail?: string
}

export interface AccessComputation {
  orgs: ReadonlyArray<OrgInfo>
  projects: ReadonlyArray<ProjectInfo>
  users: ReadonlyArray<UserInfo>
  access: ReadonlyArray<ProjectAccess>
}

export interface AccessReportInput {
  title: string
  /** Free text under the title: what the migration does, where the data came from. */
  intro?: string
  before: AccessComputation
  after: AccessComputation
  grantsAdded: ReadonlyArray<GrantAdded>
  /** `${userId}:${projectId}` pairs whose losses the migration intends. */
  intendedLossKeys?: ReadonlySet<string>
}

export interface PairDiff {
  userId: number
  projectId: string
  roleBefore: number | null
  roleAfter: number | null
  roleSourceBefore: string | null
  roleSourceAfter: string | null
  lanesBefore: string[]
  lanesAfter: string[]
  lost: string[]
  gained: string[]
  futureBefore: FutureLanes
  futureAfter: FutureLanes
  futureReasonBefore: string | null
  intendedLoss: boolean
}

export interface OrgDiff {
  org: OrgInfo
  pairs: PairDiff[]
  people: number
  /** Pairs where a lane or the role was lost and the loss is not intended. */
  unintendedLosses: PairDiff[]
  intendedLosses: PairDiff[]
  gains: PairDiff[]
  roleChanges: PairDiff[]
  /** Pairs whose future-lane reach changed. */
  futureChanges: PairDiff[]
  grantsAdded: GrantAdded[]
}

export interface AccessReport {
  title: string
  orgs: OrgDiff[]
  totals: {
    people: number
    pairs: number
    unintendedLosses: number
    intendedLosses: number
    gains: number
    roleChanges: number
    futureChanges: number
    grantsAdded: number
  }
}

const NO_ACCESS: Omit<ProjectAccess, "userId" | "projectId"> = {
  role: null,
  roleSource: null,
  lanes: [],
  futureLanes: "none",
}

function pairKey(userId: number, projectId: string): string {
  return `${userId}:${projectId}`
}

function indexAccess(rows: ReadonlyArray<ProjectAccess>): Map<string, ProjectAccess> {
  const map = new Map<string, ProjectAccess>()
  for (const row of rows) map.set(pairKey(row.userId, row.projectId), row)
  return map
}

/** A role drop counts as a loss; so does losing the project outright. */
function roleLost(before: number | null, after: number | null): boolean {
  if (before == null) return false
  return after == null || after < before
}

/** Compare two computations. Pure. */
export function diffAccess(input: AccessReportInput): AccessReport {
  const beforeIdx = indexAccess(input.before.access)
  const afterIdx = indexAccess(input.after.access)
  const projects = new Map<string, ProjectInfo>()
  for (const p of [...input.before.projects, ...input.after.projects]) projects.set(p.id, p)
  const orgs = new Map<number | null, OrgInfo>()
  for (const o of [...input.before.orgs, ...input.after.orgs]) orgs.set(o.id, o)
  const intended = input.intendedLossKeys ?? new Set<string>()

  const keys = new Set<string>([...beforeIdx.keys(), ...afterIdx.keys()])
  const byOrg = new Map<number | null, PairDiff[]>()
  for (const key of keys) {
    const b = beforeIdx.get(key)
    const a = afterIdx.get(key)
    const base = (b ?? a)!
    const before = b ?? { ...NO_ACCESS, userId: base.userId, projectId: base.projectId }
    const after = a ?? { ...NO_ACCESS, userId: base.userId, projectId: base.projectId }
    const lanesBefore = new Set(before.lanes)
    const lanesAfter = new Set(after.lanes)
    const diff: PairDiff = {
      userId: base.userId,
      projectId: base.projectId,
      roleBefore: before.role,
      roleAfter: after.role,
      roleSourceBefore: before.roleSource,
      roleSourceAfter: after.roleSource,
      lanesBefore: [...lanesBefore].sort(),
      lanesAfter: [...lanesAfter].sort(),
      lost: [...lanesBefore].filter((id) => !lanesAfter.has(id)).sort(),
      gained: [...lanesAfter].filter((id) => !lanesBefore.has(id)).sort(),
      futureBefore: before.futureLanes,
      futureAfter: after.futureLanes,
      futureReasonBefore: before.futureReason ?? null,
      intendedLoss: intended.has(key),
    }
    const orgId = projects.get(base.projectId)?.orgId ?? null
    const list = byOrg.get(orgId) ?? []
    list.push(diff)
    byOrg.set(orgId, list)
  }

  const grantsByOrg = new Map<number | null, GrantAdded[]>()
  for (const g of input.grantsAdded) {
    const list = grantsByOrg.get(g.orgId) ?? []
    list.push(g)
    grantsByOrg.set(g.orgId, list)
  }
  for (const orgId of grantsByOrg.keys()) if (!byOrg.has(orgId)) byOrg.set(orgId, [])

  const orgDiffs: OrgDiff[] = []
  for (const [orgId, pairs] of byOrg) {
    pairs.sort((x, y) => x.projectId.localeCompare(y.projectId) || x.userId - y.userId)
    const losses = pairs.filter((p) => p.lost.length > 0 || roleLost(p.roleBefore, p.roleAfter))
    orgDiffs.push({
      org: orgs.get(orgId) ?? { id: orgId, name: orgId == null ? "(no organization)" : `org ${orgId}` },
      pairs,
      people: new Set(pairs.map((p) => p.userId)).size,
      unintendedLosses: losses.filter((p) => !p.intendedLoss),
      intendedLosses: losses.filter((p) => p.intendedLoss),
      gains: pairs.filter((p) => p.gained.length > 0 || (p.roleAfter ?? 0) > (p.roleBefore ?? 0)),
      roleChanges: pairs.filter((p) => p.roleBefore !== p.roleAfter),
      futureChanges: pairs.filter((p) => p.futureBefore !== p.futureAfter),
      grantsAdded: grantsByOrg.get(orgId) ?? [],
    })
  }
  orgDiffs.sort((x, y) => {
    const weight = (o: OrgDiff) => o.unintendedLosses.length * 1e6 + o.futureChanges.length + o.grantsAdded.length
    return weight(y) - weight(x) || x.org.name.localeCompare(y.org.name)
  })

  const sum = (f: (o: OrgDiff) => number) => orgDiffs.reduce((n, o) => n + f(o), 0)
  return {
    title: input.title,
    orgs: orgDiffs,
    totals: {
      people: new Set(orgDiffs.flatMap((o) => o.pairs.map((p) => p.userId))).size,
      pairs: sum((o) => o.pairs.length),
      unintendedLosses: sum((o) => o.unintendedLosses.length),
      intendedLosses: sum((o) => o.intendedLosses.length),
      gains: sum((o) => o.gains.length),
      roleChanges: sum((o) => o.roleChanges.length),
      futureChanges: sum((o) => o.futureChanges.length),
      grantsAdded: input.grantsAdded.length,
    },
  }
}

const ROLE_LABELS: Record<number, string> = {
  100: "Viewer",
  200: "Commenter",
  300: "Reviewer",
  400: "Contributor",
  500: "Project Lead",
  600: "Maintainer",
  700: "Owner",
}

export function roleLabel(level: number | null | undefined): string {
  if (level == null) return "none"
  return ROLE_LABELS[level] ?? String(level)
}

const FUTURE_LABELS: Record<FutureLanes, string> = {
  every: "every later lane",
  "first-only": "first lane only",
  none: "none",
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

export interface RenderContext {
  users: ReadonlyMap<number, string>
  projects: ReadonlyMap<string, ProjectInfo>
}

export function renderContext(...computations: AccessComputation[]): RenderContext {
  const users = new Map<number, string>()
  const projects = new Map<string, ProjectInfo>()
  for (const c of computations) {
    for (const u of c.users) users.set(u.id, u.username)
    for (const p of c.projects) projects.set(p.id, p)
  }
  return { users, projects }
}

function laneNames(ctx: RenderContext, projectId: string, ids: readonly string[]): string {
  if (ids.length === 0) return "—"
  const p = ctx.projects.get(projectId)
  const lanes = p?.lanes ?? []
  const archived = p?.archivedLanes ?? []
  return ids
    .map((id) => lanes.find((l) => l.id === id)?.name || (archived.find((l) => l.id === id)?.name ?? id) + (archived.some((l) => l.id === id) ? " (archived)" : ""))
    .join(", ")
}

function lanesCell(ctx: RenderContext, projectId: string, role: number | null, ids: readonly string[]): string {
  if (role != null && role >= 600) return "all (by role)"
  return laneNames(ctx, projectId, ids)
}

function who(ctx: RenderContext, userId: number): string {
  return ctx.users.get(userId) ?? `user ${userId}`
}

function projectName(ctx: RenderContext, projectId: string): string {
  return ctx.projects.get(projectId)?.name ?? projectId
}

function pairTable(ctx: RenderContext, pairs: readonly PairDiff[], columns: "loss" | "gain" | "future"): string[] {
  const lines: string[] = []
  if (columns === "future") {
    lines.push("| Project | Lanes on project | Person | Role (source) | Lanes they keep | Future lanes before → after | Why before |")
    lines.push("|---|---|---|---|---|---|---|")
    for (const p of pairs) {
      const lanes = ctx.projects.get(p.projectId)?.lanes.length ?? 0
      lines.push(
        `| ${cell(projectName(ctx, p.projectId))} | ${lanes} | ${cell(who(ctx, p.userId))} | ${roleLabel(p.roleAfter)} (${p.roleSourceAfter ?? "—"}) | ${cell(lanesCell(ctx, p.projectId, p.roleAfter, p.lanesAfter))} | ${FUTURE_LABELS[p.futureBefore]} → ${FUTURE_LABELS[p.futureAfter]} | ${cell(p.futureReasonBefore ?? "—")} |`,
      )
    }
    return lines
  }
  lines.push("| Project | Person | Role before → after | Lanes before | Lanes after | " + (columns === "loss" ? "Lost" : "Gained") + " |")
  lines.push("|---|---|---|---|---|---|")
  for (const p of pairs) {
    const delta = columns === "loss" ? p.lost : p.gained
    lines.push(
      `| ${cell(projectName(ctx, p.projectId))} | ${cell(who(ctx, p.userId))} | ${roleLabel(p.roleBefore)} → ${roleLabel(p.roleAfter)} | ${cell(lanesCell(ctx, p.projectId, p.roleBefore, p.lanesBefore))} | ${cell(lanesCell(ctx, p.projectId, p.roleAfter, p.lanesAfter))} | ${cell(laneNames(ctx, p.projectId, delta))} |`,
    )
  }
  return lines
}

/** Markdown for people. One section per org, headline numbers first. */
export function renderAccessReportMarkdown(
  report: AccessReport,
  ctx: RenderContext,
  opts: { intro?: string; appendix?: string } = {},
): string {
  const t = report.totals
  const out: string[] = [`# ${report.title}`, ""]
  if (opts.intro) out.push(opts.intro.trim(), "")
  out.push("## Totals", "")
  out.push("| | Count |", "|---|---|")
  out.push(`| People | ${t.people} |`)
  out.push(`| Person–project pairs | ${t.pairs} |`)
  out.push(`| **Unintended losses** (a lane or role lost) | **${t.unintendedLosses}** |`)
  out.push(`| Intended losses | ${t.intendedLosses} |`)
  out.push(`| Gains | ${t.gains} |`)
  out.push(`| Role changes | ${t.roleChanges} |`)
  out.push(`| Future-lane changes | ${t.futureChanges} |`)
  out.push(`| Grants added | ${t.grantsAdded} |`, "")

  out.push("## By organization", "")
  out.push("| Organization | People | Unintended losses | Gains | Future-lane changes | Grants added |", "|---|---|---|---|---|---|")
  for (const o of report.orgs) {
    out.push(
      `| ${cell(o.org.name)} | ${o.people} | ${o.unintendedLosses.length} | ${o.gains.length} | ${o.futureChanges.length} | ${o.grantsAdded.length} |`,
    )
  }
  out.push("")

  for (const o of report.orgs) {
    if (
      o.unintendedLosses.length === 0 &&
      o.intendedLosses.length === 0 &&
      o.gains.length === 0 &&
      o.futureChanges.length === 0 &&
      o.grantsAdded.length === 0
    ) {
      continue
    }
    out.push(`## ${cell(o.org.name)}`, "")
    out.push(
      `${o.people} people on ${new Set(o.pairs.map((p) => p.projectId)).size} live projects. ` +
        `Unintended losses: **${o.unintendedLosses.length}**. Intended losses: ${o.intendedLosses.length}. ` +
        `Gains: ${o.gains.length}. Future-lane changes: ${o.futureChanges.length}. Grants added: ${o.grantsAdded.length}.`,
      "",
    )
    if (o.unintendedLosses.length > 0) {
      out.push("### Who loses (unintended)", "", ...pairTable(ctx, o.unintendedLosses, "loss"), "")
    }
    if (o.intendedLosses.length > 0) {
      out.push("### Who loses (intended)", "", ...pairTable(ctx, o.intendedLosses, "loss"), "")
    }
    if (o.gains.length > 0) out.push("### Who gains", "", ...pairTable(ctx, o.gains, "gain"), "")
    if (o.futureChanges.length > 0) {
      out.push("### Future lanes", "", ...pairTable(ctx, o.futureChanges, "future"), "")
    }
    if (o.grantsAdded.length > 0) {
      out.push("### Grants added", "", "| Project | Kind | Who | Lanes | Role | Note |", "|---|---|---|---|---|---|")
      for (const g of o.grantsAdded) {
        out.push(
          `| ${cell(projectName(ctx, g.projectId))} | ${cell(g.kind)} | ${cell(g.subject)} | ${cell(laneNames(ctx, g.projectId, g.laneIds))} | ${g.roleLevel == null ? "—" : roleLabel(g.roleLevel)} | ${cell(g.detail ?? "")} |`,
        )
      }
      out.push("")
    }
  }
  if (opts.appendix) out.push(opts.appendix.trim(), "")
  return out.join("\n")
}
