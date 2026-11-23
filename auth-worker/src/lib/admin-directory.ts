// Paged admin directory (AQU-2722).
//
// The console used to download every org, team, user, and project, and the
// project route grouped every file in the database before it could return.
// A page of ids is chosen first — search, lens, and sort included — and the
// file rollup runs only for those ids. Sorts and the needs-attention lens
// that can only be decided after the rollup still aggregate, then limit.

import type { AquillaDb } from "../../../db/shim/postgres"
import { countedFileSql, inCountedFileSql } from "../../../db/shared/counted-files"
import { STALE_MS } from "../../../src/lib/frontier/portfolio-metrics"
import { countTargetLanesByOrg } from "./billing/words"
import { lessStructural } from "../services/org-permissions"

export const ADMIN_PAGE_MAX = 100
export const ADMIN_PAGE_DEFAULT = 50

export type AdminLens = "all" | "active" | "archived" | "needs-attention"
export type AdminSortDir = "asc" | "desc"

export interface AdminListParams {
  limit: number | null
  offset: number
  q: string
  sort: string | null
  dir: AdminSortDir
  lens: AdminLens
  /** Projects belonging to this org. Ignored by the other lists. */
  orgId: number | null
  /** One org, for GET /orgs/:orgId. Ignored by the other lists. */
  id: number | null
}

export function readAdminListParams(get: (name: string) => string | undefined): AdminListParams {
  const limitRaw = get("limit")
  let limit: number | null = null
  if (limitRaw != null && limitRaw !== "") {
    const n = Number.parseInt(limitRaw, 10)
    limit = Number.isFinite(n) ? Math.min(ADMIN_PAGE_MAX, Math.max(1, n)) : ADMIN_PAGE_DEFAULT
  }
  const offsetRaw = Number.parseInt(get("offset") ?? "0", 10)
  const offset = Number.isFinite(offsetRaw) ? Math.min(1_000_000, Math.max(0, offsetRaw)) : 0
  const lensRaw = get("lens")
  const lens: AdminLens =
    lensRaw === "active" || lensRaw === "archived" || lensRaw === "needs-attention" ? lensRaw : "all"
  const orgRaw = get("orgId")
  const idRaw = get("id")
  const sort = get("sort")?.trim() || null
  return {
    limit,
    offset,
    q: (get("q") ?? "").trim().slice(0, 200),
    sort: sort ? sort.slice(0, 40) : null,
    dir: get("dir") === "desc" ? "desc" : "asc",
    lens,
    orgId: orgRaw && /^\d+$/.test(orgRaw) ? Number(orgRaw) : null,
    id: idRaw && /^\d+$/.test(idRaw) ? Number(idRaw) : null,
  }
}

type Frag = { sql: string; binds: unknown[] }

function frag(sql: string, ...binds: unknown[]): Frag {
  return { sql, binds }
}

function concat(...parts: Frag[]): Frag {
  return {
    sql: parts.map((part) => part.sql).join(""),
    binds: parts.flatMap((part) => part.binds),
  }
}

function andFrags(parts: Frag[]): Frag {
  const present = parts.filter((part) => part.sql !== "")
  if (present.length === 0) return frag("")
  return {
    sql: present.map((part) => part.sql).join(" AND "),
    binds: present.flatMap((part) => part.binds),
  }
}

/** LIKE pattern for a user substring. `%`, `_`, and `\` are literals. */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

function like(expr: string, q: string): Frag {
  return frag(`${expr} ILIKE ? ESCAPE '\\'`, likeContains(q))
}

function dirSql(dir: AdminSortDir): "ASC" | "DESC" {
  return dir === "desc" ? "DESC" : "ASC"
}

function orderBy(expr: string, dir: AdminSortDir, tie: string): string {
  return `${expr} ${dirSql(dir)} NULLS LAST, ${tie}`
}

async function all<T>(db: AquillaDb, query: Frag): Promise<T[]> {
  const prepared = db.prepare(query.sql)
  const bound = query.binds.length > 0 ? prepared.bind(...query.binds) : prepared
  const { results } = await bound.all<T>()
  return results ?? []
}

async function first<T>(db: AquillaDb, query: Frag): Promise<T | null> {
  const prepared = db.prepare(query.sql)
  const bound = query.binds.length > 0 ? prepared.bind(...query.binds) : prepared
  return (await bound.first<T>()) ?? null
}

function limitFrag(params: AdminListParams): Frag {
  if (params.limit == null) return frag("")
  return frag(" LIMIT ? OFFSET ?", params.limit, params.offset)
}

export interface AdminOrgRecord {
  id: number
  name: string | null
  createdAt: string
  ownerUsername: string | null
  memberCount: number
  projectCount: number
  teamCount: number
  activeLanguageCount: number
}

export async function listAdminOrgs(
  db: AquillaDb,
  params: AdminListParams,
): Promise<{ orgs: AdminOrgRecord[]; total: number }> {
  const where = andFrags([
    params.id != null ? frag("o.id = ?", params.id) : frag(""),
    params.q
      ? frag(
          `(${like("COALESCE(NULLIF(BTRIM(o.name), ''), '#' || o.id::text)", params.q).sql} OR ${like("COALESCE(u.username, '')", params.q).sql})`,
          likeContains(params.q),
          likeContains(params.q),
        )
      : frag(""),
  ])
  const sort = params.sort
  const dir = params.dir
  const legacy = params.limit == null && sort == null
  let orderExpr = "o.created_at DESC, o.id ASC"
  if (!legacy) {
    if (sort === "owner") orderExpr = orderBy("NULLIF(BTRIM(u.username), '')", dir, "o.id ASC")
    else if (sort === "teams") orderExpr = orderBy("COALESCE(gt.team_count, 0)", dir, "o.id ASC")
    else if (sort === "memberCount") orderExpr = orderBy("member_count", dir, "o.id ASC")
    else if (sort === "projectCount") orderExpr = orderBy("project_count", dir, "member_count DESC, o.id ASC")
    else if (sort === "languages") orderExpr = orderBy(`(${LANE_COUNT_SQL})`, dir, "o.id ASC")
    else if (sort === "created") orderExpr = orderBy("o.created_at", dir, "o.id ASC")
    else orderExpr = orderBy("LOWER(COALESCE(NULLIF(BTRIM(o.name), ''), '#' || o.id::text))", dir, "o.id ASC")
  }
  const body = concat(
    frag(
      `SELECT o.id, o.name, o.created_at, u.username AS owner_username,
              (SELECT COUNT(*)::int FROM org_members m WHERE m.org_id = o.id) AS member_count,
              (SELECT COUNT(*)::int FROM projects p WHERE p.org_id = o.id AND p.archived_at IS NULL) AS project_count,
              COALESCE(gt.team_count, 0)::int AS team_count
         FROM organizations o
         LEFT JOIN users u ON u.id = o.owner_user_id
         LEFT JOIN (
           SELECT org_id, COUNT(*)::int AS team_count FROM groups GROUP BY org_id
         ) gt ON gt.org_id = o.id`,
    ),
    where.sql ? frag(` WHERE ${where.sql}`, ...where.binds) : frag(""),
  )
  const [rows, count] = await Promise.all([
    all<OrgSqlRow>(db, concat(body, frag(` ORDER BY ${orderExpr}`), limitFrag(params))),
    first<{ n: number }>(db, concat(frag("SELECT COUNT(*)::int AS n FROM ("), body, frag(") counted"))),
  ])
  const { byOrg } = await countTargetLanesByOrg(db, rows.map((row) => Number(row.id)))
  return {
    total: Number(count?.n ?? 0),
    orgs: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      createdAt: row.created_at,
      ownerUsername: row.owner_username,
      memberCount: Number(row.member_count) || 0,
      projectCount: Number(row.project_count) || 0,
      teamCount: Number(row.team_count) || 0,
      activeLanguageCount: byOrg.get(Number(row.id)) ?? 0,
    })),
  }
}

export async function getAdminOrgRecord(db: AquillaDb, orgId: number): Promise<AdminOrgRecord | null> {
  const { orgs } = await listAdminOrgs(db, {
    limit: 1,
    offset: 0,
    q: "",
    sort: null,
    dir: "asc",
    lens: "all",
    orgId: null,
    id: orgId,
  })
  return orgs[0] ?? null
}

type OrgSqlRow = {
  id: number
  name: string | null
  created_at: string
  owner_username: string | null
  member_count: number
  project_count: number
  team_count: number
}

/** Same rule as countTargetLanesByOrg, as a correlated scalar for ORDER BY. */
const LANE_COUNT_SQL = `SELECT COALESCE(SUM(
           (SELECT COUNT(*)::int FROM lanes l
             WHERE l.project_id = lp.id AND l.role = 'target' AND l.archived_at IS NULL)
         ), 0)
    FROM projects lp
   WHERE lp.org_id = o.id
     AND lp.archived_at IS NULL
     AND COALESCE(lp.is_active, TRUE)`

const TEAM_LOCAL_NAME = `CASE WHEN strpos(g.name, '/') > 0 THEN substr(g.name, strpos(g.name, '/') + 1) ELSE g.name END`
const TEAM_LEAD_SQL = `(SELECT u.username
               FROM group_members gm
               JOIN users u ON u.id = gm.user_id
               JOIN org_members om ON om.org_id = g.org_id AND om.user_id = gm.user_id
              WHERE gm.group_id = g.id AND om.role_level = 500
              ORDER BY LOWER(u.username)
              LIMIT 1)`

export interface AdminTeamRecord {
  id: number
  name: string
  createdAt: string
  orgId: number
  orgName: string | null
  projectLeadUsername: string | null
  ownerUsername: string | null
  memberCount: number
  projectCount: number
}

export async function listAdminTeams(
  db: AquillaDb,
  params: AdminListParams,
): Promise<{ teams: AdminTeamRecord[]; total: number }> {
  const where = params.q
    ? frag(
        `(${like(TEAM_LOCAL_NAME, params.q).sql} OR ${like("COALESCE(o.name, '')", params.q).sql} OR ${like(`COALESCE(${TEAM_LEAD_SQL}, '')`, params.q).sql} OR ${like("COALESCE(ou.username, '')", params.q).sql})`,
        likeContains(params.q),
        likeContains(params.q),
        likeContains(params.q),
        likeContains(params.q),
      )
    : frag("")
  const legacy = params.limit == null && params.sort == null
  let orderExpr = "o.name, g.name, g.id"
  if (!legacy) {
    const dir = params.dir
    if (params.sort === "organization") orderExpr = orderBy("NULLIF(BTRIM(o.name), '')", dir, "g.id ASC")
    else if (params.sort === "projectLead") orderExpr = orderBy(`NULLIF(BTRIM(${TEAM_LEAD_SQL}), '')`, dir, "g.id ASC")
    else if (params.sort === "owner") orderExpr = orderBy("NULLIF(BTRIM(ou.username), '')", dir, "g.id ASC")
    else if (params.sort === "memberCount") orderExpr = orderBy("member_count", dir, "g.id ASC")
    else if (params.sort === "projectCount") orderExpr = orderBy("project_count", dir, "g.id ASC")
    else if (params.sort === "created") orderExpr = orderBy("g.created_at", dir, "g.id ASC")
    else orderExpr = orderBy(`LOWER(${TEAM_LOCAL_NAME})`, dir, "g.id ASC")
  }
  const body = concat(
    frag(
      `SELECT g.id, g.name, g.created_at, g.org_id, o.name AS org_name,
              ${TEAM_LEAD_SQL} AS project_lead_username,
              ou.username AS owner_username,
              (SELECT COUNT(*)::int FROM group_members m WHERE m.group_id = g.id) AS member_count,
              (SELECT COUNT(*)::int FROM group_project_grants gp WHERE gp.group_id = g.id) AS project_count
         FROM groups g
         LEFT JOIN organizations o ON o.id = g.org_id
         LEFT JOIN users ou ON ou.id = o.owner_user_id`,
    ),
    where.sql ? frag(` WHERE ${where.sql}`, ...where.binds) : frag(""),
  )
  const [rows, count] = await Promise.all([
    all<TeamSqlRow>(db, concat(body, frag(` ORDER BY ${orderExpr}`), limitFrag(params))),
    first<{ n: number }>(db, concat(frag("SELECT COUNT(*)::int AS n FROM ("), body, frag(") counted"))),
  ])
  return {
    total: Number(count?.n ?? 0),
    teams: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      createdAt: row.created_at,
      orgId: Number(row.org_id),
      orgName: row.org_name,
      projectLeadUsername: row.project_lead_username,
      ownerUsername: row.owner_username,
      memberCount: Number(row.member_count) || 0,
      projectCount: Number(row.project_count) || 0,
    })),
  }
}

type TeamSqlRow = {
  id: number
  name: string
  created_at: string
  org_id: number
  org_name: string | null
  project_lead_username: string | null
  owner_username: string | null
  member_count: number
  project_count: number
}

export interface AdminUserRecord {
  id: number
  username: string
  email: string
  displayName: string | null
  createdAt: string
  orgCount: number
  lastActiveAt: string | null
}

export async function listAdminUsers(
  db: AquillaDb,
  params: AdminListParams,
  adminEmails: readonly string[],
): Promise<{ users: AdminUserRecord[]; total: number }> {
  const emails = adminEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)
  const rank = emails.length
    ? frag(
        `CASE WHEN LOWER(u.email) IN (${emails.map(() => "?").join(", ")}) THEN 1 ELSE 0 END`,
        ...emails,
      )
    : frag("0")
  const searchParts: Frag[] = []
  if (params.q) {
    // Outer columns: this WHERE sits on the subquery, where `u` is out of scope.
    searchParts.push(like("username", params.q))
    searchParts.push(like("COALESCE(display_name, '')", params.q))
    searchParts.push(like("email", params.q))
    if (emails.length > 0 && "platform admin".includes(params.q.toLowerCase())) {
      searchParts.push(frag(`LOWER(email) IN (${emails.map(() => "?").join(", ")})`, ...emails))
    }
  }
  const where = searchParts.length
    ? frag(
        `(${searchParts.map((part) => part.sql).join(" OR ")})`,
        ...searchParts.flatMap((part) => part.binds),
      )
    : frag("")
  const legacy = params.limit == null && params.sort == null
  let orderExpr = "created_at DESC, id ASC"
  if (!legacy) {
    const dir = params.dir
    if (params.sort === "email") orderExpr = orderBy("LOWER(email)", dir, "id ASC")
    else if (params.sort === "role") orderExpr = orderBy("admin_rank", dir, "id ASC")
    else if (params.sort === "orgCount") orderExpr = orderBy("org_count", dir, "id ASC")
    else if (params.sort === "lastActive") orderExpr = orderBy("last_active_at", dir, "id ASC")
    else if (params.sort === "joined") orderExpr = orderBy("created_at", dir, "id ASC")
    else orderExpr = orderBy("LOWER(username)", dir, "id ASC")
  }
  const body = concat(
    frag(
      `SELECT id, username, email, display_name, created_at, org_count, last_active_at, admin_rank
         FROM (
           SELECT u.id, u.username, u.email, u.display_name, u.created_at,
                  (SELECT COUNT(*)::int FROM org_members m WHERE m.user_id = u.id) AS org_count,
                  (SELECT MAX(last_active_at) FROM org_members m WHERE m.user_id = u.id) AS last_active_at,
                  ${rank.sql} AS admin_rank
             FROM users u
         ) people`,
      ...rank.binds,
    ),
    where.sql ? frag(` WHERE ${where.sql}`, ...where.binds) : frag(""),
  )
  const [rows, count] = await Promise.all([
    all<UserSqlRow>(db, concat(body, frag(` ORDER BY ${orderExpr}`), limitFrag(params))),
    first<{ n: number }>(db, concat(frag("SELECT COUNT(*)::int AS n FROM ("), body, frag(") counted"))),
  ])
  return {
    total: Number(count?.n ?? 0),
    users: rows.map((row) => ({
      id: Number(row.id),
      username: row.username,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      orgCount: Number(row.org_count) || 0,
      lastActiveAt: row.last_active_at,
    })),
  }
}

type UserSqlRow = {
  id: number
  username: string
  email: string
  display_name: string | null
  created_at: string
  org_count: number
  last_active_at: string | null
}

export interface AdminProjectRecord {
  id: string
  name: string
  orgId: number | null
  orgName: string | null
  archived: boolean
  createdAt: string
  deadlineAt: string | null
  creatorUsername: string | null
  totalCells: number
  validatedCells: number
  filledCells: number
  wordCount: number
  lastEditAt: number | null
  lastActivityAt: number | null
  shared: boolean
}

export interface AdminProjectList {
  projects: AdminProjectRecord[]
  total: number
  /** Needs-attention rows whose deadline is already overdue. Null on other lenses. */
  overdue: number | null
}

const SHARED_SQL = `(
  EXISTS (
    SELECT 1 FROM project_members pm
     WHERE pm.project_id = p.id
       AND p.org_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM org_members om
          WHERE om.org_id = p.org_id AND om.user_id = pm.user_id
       )
  ) OR EXISTS (
    SELECT 1
      FROM group_project_grants gpg
      JOIN group_members gm ON gm.group_id = gpg.group_id
     WHERE gpg.project_id = p.id
       AND p.org_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM org_members om
          WHERE om.org_id = p.org_id AND om.user_id = gm.user_id
       )
  )
)`

function deadlineEnd(column: string): string {
  return `CASE WHEN ${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (${column}::timestamp AT TIME ZONE 'UTC') + interval '36 hours' ELSE NULL END`
}

function projectCheapWhere(params: AdminListParams): Frag {
  const parts: Frag[] = []
  if (params.orgId != null) parts.push(frag("p.org_id = ?", params.orgId))
  if (params.lens === "active" || params.lens === "needs-attention") parts.push(frag("p.archived_at IS NULL"))
  if (params.lens === "archived") parts.push(frag("p.archived_at IS NOT NULL"))
  if (params.q) {
    const text = frag(
      `(${like("p.name", params.q).sql} OR ${like("COALESCE(o.name, '')", params.q).sql} OR ${like("COALESCE(u.username, '')", params.q).sql})`,
      likeContains(params.q),
      likeContains(params.q),
      likeContains(params.q),
    )
    parts.push(
      "shared".includes(params.q.toLowerCase())
        ? frag(`(${text.sql} OR ${SHARED_SQL})`, ...text.binds)
        : text,
    )
  }
  return andFrags(parts)
}

function projectRollup(where: Frag): Frag {
  return concat(
    frag(
      `SELECT p.id, p.name, p.org_id, p.archived_at, p.created_at, p.deadline_at,
              o.name AS org_name,
              u.username AS creator_username,
              ${lessStructural("COALESCE(SUM(f.cell_count), 0)", "COALESCE(SUM(f.structural_cell_count), 0)")} AS total_cells,
              ${lessStructural("COALESCE(SUM(f.approved_count), 0)", "COALESCE(SUM(f.structural_approved_count), 0)")} AS validated_cells,
              ${lessStructural("COALESCE(SUM(f.filled_count), 0)", "COALESCE(SUM(f.structural_filled_count), 0)")} AS filled_cells,
              COALESCE(SUM(f.word_count), 0) AS word_count,
              MAX(f.last_edit_at) AS last_edit_at,
              GREATEST(
                MAX(f.last_edit_at),
                (SELECT MAX(fsp.updated_at) FROM file_section_progress fsp
                  WHERE fsp.project_id = p.id AND fsp.scope = 'file'
                    AND ${inCountedFileSql("fsp", "uncounted_activity_file")})
              ) AS last_activity_at,
              ${SHARED_SQL} AS shared
         FROM projects p
         LEFT JOIN organizations o ON o.id = p.org_id
         LEFT JOIN users u ON u.id = p.created_by
         LEFT JOIN files f ON f.project_id = p.id AND ${countedFileSql("f")}
         LEFT JOIN project_settings ps ON ps.project_id = p.id
         LEFT JOIN org_settings os ON os.org_id = p.org_id `,
    ),
    where.sql ? frag(`WHERE ${where.sql} `, ...where.binds) : frag(""),
    frag("GROUP BY p.id, o.name, u.username"),
  )
}

function projectNeedsRollup(params: AdminListParams): boolean {
  return (
    params.lens === "needs-attention" ||
    params.sort === "validated" ||
    params.sort === "wordCount" ||
    params.sort === "edited" ||
    params.sort === "status"
  )
}

function projectCheapOrder(params: AdminListParams): string {
  const dir = params.dir
  if (params.sort === "org") return orderBy("NULLIF(BTRIM(o.name), '')", dir, "p.id ASC")
  if (params.sort === "creator") return orderBy("NULLIF(BTRIM(u.username), '')", dir, "p.id ASC")
  return `LOWER(p.name) ${dirSql(dir)}, p.id ASC`
}

function attentionWhere(now: number): Frag {
  const end = deadlineEnd("f.deadline_at")
  return frag(
    `f.archived_at IS NULL AND ((${end}) IS NOT NULL AND (${end}) <= to_timestamp(? / 1000.0) + interval '7 days' OR (f.filled_cells > 0 AND (f.last_activity_at IS NULL OR f.last_activity_at < ?)))`,
    now,
    now - STALE_MS,
  )
}

function overdueWhere(now: number): Frag {
  const end = deadlineEnd("f.deadline_at")
  return frag(`(${end}) IS NOT NULL AND (${end}) <= to_timestamp(? / 1000.0)`, now)
}

function projectHeavyOrder(params: AdminListParams, now: number): Frag {
  const dir = params.dir
  const end = deadlineEnd("f.deadline_at")
  const fraction = "CASE WHEN f.total_cells > 0 THEN f.validated_cells::float8 / f.total_cells ELSE 0 END"
  if (params.sort === "org") return frag(orderBy("NULLIF(BTRIM(f.org_name), '')", dir, "f.id ASC"))
  if (params.sort === "creator") return frag(orderBy("NULLIF(BTRIM(f.creator_username), '')", dir, "f.id ASC"))
  if (params.sort === "validated") return frag(`${fraction} ${dirSql(dir)}, f.id ASC`)
  if (params.sort === "wordCount") return frag(`f.word_count ${dirSql(dir)}, f.id ASC`)
  if (params.sort === "edited") return frag(orderBy("f.last_edit_at", dir, "f.id ASC"))
  if (params.sort === "status") {
    return frag(
      `CASE WHEN f.archived_at IS NOT NULL THEN -1 ELSE
         (CASE WHEN (${end}) IS NOT NULL AND (${end}) <= to_timestamp(? / 1000.0) THEN 3000 ELSE 0 END)
         + (CASE WHEN (${end}) IS NOT NULL AND (${end}) > to_timestamp(? / 1000.0) AND (${end}) <= to_timestamp(? / 1000.0) + interval '7 days' THEN 1500 ELSE 0 END)
         + (CASE WHEN f.filled_cells > 0 AND (f.last_activity_at IS NULL OR f.last_activity_at < ?) THEN 1000 ELSE 0 END)
         + (1 - (${fraction})) * 100
         + LEAST(f.word_count::float8 / 10000, 1) * 50
       END ${dirSql(dir)}, f.id ASC`,
      now,
      now,
      now,
      now - STALE_MS,
    )
  }
  return frag(`LOWER(f.name) ${dirSql(dir)}, f.id ASC`)
}

type ProjectSqlRow = {
  id: string | null
  name: string
  org_id: number | null
  org_name: string | null
  archived_at: string | null
  created_at: string
  deadline_at: string | null
  creator_username: string | null
  total_cells: number
  validated_cells: number
  filled_cells: number
  word_count: number
  last_edit_at: number | null
  last_activity_at: number | string | null
  shared: boolean | number | null
  total?: number
  overdue?: number
}

function asBool(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1
}

function mapProject(row: ProjectSqlRow): AdminProjectRecord {
  return {
    id: row.id ?? "",
    name: row.name,
    orgId: row.org_id == null ? null : Number(row.org_id),
    orgName: row.org_name,
    archived: row.archived_at != null,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    creatorUsername: row.creator_username,
    totalCells: Number(row.total_cells) || 0,
    validatedCells: Number(row.validated_cells) || 0,
    filledCells: Number(row.filled_cells) || 0,
    wordCount: Number(row.word_count) || 0,
    lastEditAt: row.last_edit_at == null ? null : Number(row.last_edit_at),
    lastActivityAt: row.last_activity_at == null ? null : Number(row.last_activity_at),
    shared: asBool(row.shared),
  }
}

function normalizedProjectSort(params: AdminListParams): AdminListParams {
  if (params.sort) return params
  if (params.limit == null) return params
  if (params.lens === "needs-attention") return { ...params, sort: "status", dir: "desc" }
  return { ...params, sort: "name", dir: "asc" }
}

export async function listAdminProjects(
  db: AquillaDb,
  params: AdminListParams,
  now = Date.now(),
): Promise<AdminProjectList> {
  const query = normalizedProjectSort(params)
  const where = projectCheapWhere(query)
  const legacy = query.limit == null && query.q === "" && query.sort == null && query.lens === "all" && query.orgId == null
  if (legacy || (query.limit == null && !projectNeedsRollup(query))) {
    const rows = await all<ProjectSqlRow>(
      db,
      concat(projectRollup(where), frag(legacy ? " ORDER BY p.created_at DESC" : ` ORDER BY ${projectCheapOrder(query)}`)),
    )
    return { projects: rows.map(mapProject), total: rows.length, overdue: null }
  }
  if (query.limit != null && !projectNeedsRollup(query)) {
    const from = concat(
      frag(
        `SELECT p.id
           FROM projects p
           LEFT JOIN organizations o ON o.id = p.org_id
           LEFT JOIN users u ON u.id = p.created_by`,
      ),
      where.sql ? frag(` WHERE ${where.sql}`, ...where.binds) : frag(""),
    )
    const [ids, count] = await Promise.all([
      all<{ id: string }>(db, concat(from, frag(` ORDER BY ${projectCheapOrder(query)}`), limitFrag(query))),
      first<{ n: number }>(db, concat(frag("SELECT COUNT(*)::int AS n FROM ("), from, frag(") counted"))),
    ])
    if (ids.length === 0) return { projects: [], total: Number(count?.n ?? 0), overdue: null }
    const idList = ids.map((row) => row.id)
    const rolled = await all<ProjectSqlRow>(
      db,
      projectRollup(frag(`p.id IN (${idList.map(() => "?").join(", ")})`, ...idList)),
    )
    const position = new Map(idList.map((id, index) => [id, index]))
    rolled.sort((a, b) => (position.get(a.id ?? "") ?? 0) - (position.get(b.id ?? "") ?? 0))
    return { projects: rolled.map(mapProject), total: Number(count?.n ?? 0), overdue: null }
  }

  const attention = query.lens === "needs-attention" ? attentionWhere(now) : frag("TRUE")
  const overdue = overdueWhere(now)
  const order = projectHeavyOrder(query, now)
  const heavy = concat(
    frag("WITH rolled AS MATERIALIZED ("),
    projectRollup(where),
    frag(") SELECT page.id, page.name, page.org_id, page.org_name, page.archived_at, page.created_at, page.deadline_at, page.creator_username, page.total_cells, page.validated_cells, page.filled_cells, page.word_count, page.last_edit_at, page.last_activity_at, page.shared, counts.total, counts.overdue FROM (SELECT COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE "),
    overdue,
    frag("))::int AS overdue FROM rolled f WHERE "),
    attention,
    frag(") counts LEFT JOIN LATERAL (SELECT * FROM rolled f WHERE "),
    attention,
    frag(" ORDER BY "),
    order,
    query.limit == null ? frag("") : frag(" LIMIT ? OFFSET ?", query.limit, query.offset),
    frag(") page ON TRUE"),
  )
  const rows = await all<ProjectSqlRow>(db, heavy)
  const total = Number(rows[0]?.total ?? 0)
  const overdueCount = Number(rows[0]?.overdue ?? 0)
  return {
    projects: rows.filter((row) => row.id != null).map(mapProject),
    total,
    overdue: query.lens === "needs-attention" ? overdueCount : null,
  }
}
