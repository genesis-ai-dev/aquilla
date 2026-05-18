// Minimal in-memory D1 fake for frontier-server route tests.
//
// Supports the statement shapes frontier-server actually issues against the
// single codex D1: users, organizations, org_members, projects,
// project_members, project_invites, password_reset_tokens. Pattern-matches
// on the normalized SQL string + bind args.

export interface UserRow {
  id: number
  username: string
  email: string
  password_hash: string
  preferences: string | null
  created_at: string
  updated_at: string
}

export interface ProjectRow {
  id: string
  name: string
  org_id: number | null
  created_by: number
  archived_at: string | null
  /**
   * AD-9 source-project link. Column is created by Phase 1A's
   * 0004_projects_source_link.sql; Phase 1C tests opt into it via this
   * field. Defaults to null for older seeded rows.
   */
  source_project_id?: string | null
}

export interface ProjectMemberRow {
  project_id: string
  user_id: number
  role_level: number
  granted_by: number | null
  granted_at: string
}

export interface ProjectInviteRow {
  token: string
  project_id: string
  role_level: number
  created_by: number
  created_at: string
  expires_at: string | null
  used_by: number | null
  used_at: string | null
}

export interface ResetTokenRow {
  user_id: number
  token: string
  expires_at: string
}

export interface OrganizationRow {
  id: number
  name: string | null
  owner_user_id: number
}

export interface OrgMemberRow {
  org_id: number
  user_id: number
  role_level: number
  granted_by: number | null
  granted_at: string
  last_active_at: string | null
}

/** AD-12 groups (migration 0007). */
export interface GroupRow {
  id: number
  org_id: number
  name: string
  description: string | null
  created_by: number
  created_at: string
  updated_at: string
}

export interface GroupMemberRow {
  group_id: number
  user_id: number
  added_by: number | null
  added_at: string
}

export interface GroupProjectGrantRow {
  group_id: number
  project_id: string
  role_level: number
  granted_by: number | null
  granted_at: string
}

/** Project-settings row (Phase 1C migration 0005). */
export interface ProjectSettingsRow {
  project_id: string
  settings: string
  version: number
  updated_at: string | null
  updated_by: number | null
}

/** Generic event log row used by Phase 1C source-linking event emission. */
export interface EventRow {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  kind: string
  author: string
  payload: string
  client_ts: number
  server_ts: number
}

/**
 * AD-9 cells projection (per spec §"Indicative schemas"). Phase 1C
 * snapshot-source-cells reads this shape.
 */
export interface CellProjectionRow {
  project_id: string
  file_id: string
  cell_id: string
  side: "source" | "target"
  value: string
  value_html: string | null
}

export interface FakeTables {
  users: UserRow[]
  projects: ProjectRow[]
  project_members: ProjectMemberRow[]
  project_invites: ProjectInviteRow[]
  password_reset_tokens: ResetTokenRow[]
  organizations: OrganizationRow[]
  org_members: OrgMemberRow[]
  /** Phase 1C: project_settings (migration 0005). */
  project_settings: ProjectSettingsRow[]
  /** Phase 1C: event log writes (link-source / source.cell.commit bursts). */
  events: EventRow[]
  /** Phase 1A's AD-9 cells projection. Phase 1C reads it for source snapshots. */
  cells: CellProjectionRow[]
  /** AD-12: org-scoped permission bundles (migration 0007). */
  groups: GroupRow[]
  group_members: GroupMemberRow[]
  group_project_grants: GroupProjectGrantRow[]
}

export type FakeD1 = D1Database & {
  _tables(): FakeTables
  _issued(): Array<{ sql: string; args: unknown[] }>
}

export function makeFakeD1(initial: Partial<FakeTables> = {}): FakeD1 {
  const tables: FakeTables = {
    users: initial.users ?? [],
    projects: (initial.projects ?? []).map((p) => ({
      ...p,
      source_project_id: p.source_project_id ?? null,
    })),
    project_members: initial.project_members ?? [],
    project_invites: initial.project_invites ?? [],
    password_reset_tokens: initial.password_reset_tokens ?? [],
    organizations: initial.organizations ?? [],
    org_members: initial.org_members ?? [],
    project_settings: initial.project_settings ?? [],
    events: initial.events ?? [],
    cells: initial.cells ?? [],
    groups: initial.groups ?? [],
    group_members: initial.group_members ?? [],
    group_project_grants: initial.group_project_grants ?? [],
  }
  const issued: Array<{ sql: string; args: unknown[] }> = []

  function norm(sql: string): string {
    return sql.replace(/\s+/g, " ").trim()
  }

  function exec(
    sql: string,
    args: unknown[],
  ): { first: unknown; results: unknown[]; changes?: number } {
    const n = norm(sql)
    issued.push({ sql: n, args })

    // ─── SELECT users ──────────────────────────────────────────────────
    if (n.startsWith("SELECT * FROM users WHERE username = ?")) {
      const u = tables.users.find((x) => x.username === args[0])
      return { first: u ?? null, results: u ? [u] : [] }
    }
    if (n.startsWith("SELECT * FROM users WHERE email = ?")) {
      const u = tables.users.find((x) => x.email === args[0])
      return { first: u ?? null, results: u ? [u] : [] }
    }
    if (n.startsWith("SELECT id FROM users WHERE username = ? OR email = ?")) {
      const u = tables.users.find(
        (x) => x.username === args[0] || x.email === args[1],
      )
      return { first: u ? { id: u.id } : null, results: u ? [{ id: u.id }] : [] }
    }
    if (n.startsWith("SELECT id, username FROM users WHERE email = ?")) {
      const u = tables.users.find((x) => x.email === args[0])
      return {
        first: u ? { id: u.id, username: u.username } : null,
        results: u ? [{ id: u.id, username: u.username }] : [],
      }
    }
    if (n.startsWith("SELECT id FROM users WHERE username = ?")) {
      const u = tables.users.find((x) => x.username === args[0])
      return { first: u ? { id: u.id } : null, results: u ? [{ id: u.id }] : [] }
    }

    // ─── SELECT projects ──────────────────────────────────────────────
    // Several handlers SELECT different column subsets; we match on the
    // `FROM projects WHERE id = ?` tail and return the full row so the
    // caller's typed cast picks whatever columns it needs.
    if (
      n.includes("FROM projects WHERE id = ?") &&
      n.startsWith("SELECT")
    ) {
      const p = tables.projects.find((x) => x.id === args[0])
      return { first: p ?? null, results: p ? [p] : [] }
    }

    // ─── SELECT org_members ──────────────────────────────────────────
    if (n.startsWith("SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?")) {
      const m = tables.org_members.find(
        (x) => x.org_id === args[0] && x.user_id === args[1],
      )
      return {
        first: m ? { role_level: m.role_level } : null,
        results: m ? [{ role_level: m.role_level }] : [],
      }
    }

    // ─── SELECT project_members ──────────────────────────────────────
    if (n.startsWith("SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?")) {
      const m = tables.project_members.find(
        (x) => x.project_id === args[0] && x.user_id === args[1],
      )
      return {
        first: m ? { role_level: m.role_level } : null,
        results: m ? [{ role_level: m.role_level }] : [],
      }
    }

    // ─── SELECT MAX(role_level) FROM group_project_grants JOIN group_members
    // AD-12 max-wins resolver query. Returns the highest role_level for any
    // group the user belongs to that is attached to this project. Aggregate
    // queries always return a row in SQLite — when no rows match, role_level
    // is NULL; mirror that.
    if (
      n.startsWith(
        "SELECT MAX(gpg.role_level) AS role_level FROM group_project_grants gpg JOIN group_members gm ON gm.group_id = gpg.group_id WHERE gpg.project_id = ? AND gm.user_id = ?",
      )
    ) {
      const projectId = args[0] as string
      const userId = args[1] as number
      const grants = tables.group_project_grants.filter(
        (g) => g.project_id === projectId,
      )
      let maxLevel: number | null = null
      for (const grant of grants) {
        const isMember = tables.group_members.some(
          (gm) => gm.group_id === grant.group_id && gm.user_id === userId,
        )
        if (isMember && (maxLevel == null || grant.role_level > maxLevel)) {
          maxLevel = grant.role_level
        }
      }
      const row = { role_level: maxLevel }
      return { first: row, results: [row] }
    }

    // ─── SELECT … FROM group_project_grants JOIN group_members JOIN users …
    // GROUP BY user (effective-members enumeration for a project). Returns
    // one row per user reached via any group attached to this project, with
    // their MAX group role_level.
    if (
      n.startsWith(
        "SELECT gm.user_id AS user_id, u.username AS username, MAX(gpg.role_level) AS role_level FROM group_project_grants gpg JOIN group_members gm ON gm.group_id = gpg.group_id JOIN users u ON u.id = gm.user_id WHERE gpg.project_id = ?",
      )
    ) {
      const projectId = args[0] as string
      const perUserMax = new Map<number, { username: string; level: number }>()
      const grants = tables.group_project_grants.filter(
        (g) => g.project_id === projectId,
      )
      for (const grant of grants) {
        const members = tables.group_members.filter(
          (gm) => gm.group_id === grant.group_id,
        )
        for (const gm of members) {
          const u = tables.users.find((x) => x.id === gm.user_id)
          if (!u) continue
          const prev = perUserMax.get(gm.user_id)
          if (!prev || grant.role_level > prev.level) {
            perUserMax.set(gm.user_id, {
              username: u.username,
              level: grant.role_level,
            })
          }
        }
      }
      const results = Array.from(perUserMax.entries()).map(([userId, v]) => ({
        user_id: userId,
        username: v.username,
        role_level: v.level,
      }))
      return { first: results[0] ?? null, results }
    }

    // ─── SELECT project_invites ──────────────────────────────────────
    // Returns ALL rows sharing the token so the multi-project-invite
    // surface (Phase 1C) works. `first` is rows[0] which is the correct
    // value for the single-project legacy callers that .first()-ed.
    if (n.startsWith("SELECT token, project_id, role_level, created_by, created_at, expires_at, used_by, used_at FROM project_invites WHERE token = ?")) {
      const rows = tables.project_invites.filter((x) => x.token === args[0])
      return { first: rows[0] ?? null, results: rows }
    }

    // ─── SELECT password_reset_tokens ─────────────────────────────────
    if (n.startsWith("SELECT expires_at FROM password_reset_tokens WHERE user_id = ? AND token = ?")) {
      const t = tables.password_reset_tokens.find(
        (x) => x.user_id === args[0] && x.token === args[1],
      )
      return {
        first: t ? { expires_at: t.expires_at } : null,
        results: t ? [{ expires_at: t.expires_at }] : [],
      }
    }

    // ─── INSERTs ──────────────────────────────────────────────────────
    if (n.startsWith("INSERT INTO projects")) {
      // sync-token.ts:    INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)
      // projects.ts POST: INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, ?, ?)
      const id = args[0] as string
      const name = args[1] as string
      let org_id: number | null = null
      let created_by: number
      if (args.length === 4) {
        org_id = (args[2] as number | null) ?? null
        created_by = args[3] as number
      } else {
        created_by = args[2] as number
      }
      tables.projects.push({
        id,
        name,
        org_id,
        created_by,
        archived_at: null,
        source_project_id: null,
      })
      return { first: null, results: [] }
    }
    if (n.startsWith("INSERT INTO project_invites")) {
      const [token, project_id, role_level, created_by, expires_at] = args as [
        string,
        string,
        number,
        number,
        string,
      ]
      tables.project_invites.push({
        token,
        project_id,
        role_level,
        created_by,
        created_at: new Date().toISOString(),
        expires_at,
        used_by: null,
        used_at: null,
      })
      return { first: null, results: [] }
    }
    if (n.startsWith("INSERT INTO project_members")) {
      const [project_id, user_id, role_level, granted_by] = args as [
        string,
        number,
        number,
        number,
      ]
      tables.project_members.push({
        project_id,
        user_id,
        role_level,
        granted_by,
        granted_at: new Date().toISOString(),
      })
      return { first: null, results: [] }
    }
    if (n.startsWith("INSERT INTO users")) {
      const [username, email, password_hash] = args as [string, string, string]
      const id = tables.users.length + 1
      tables.users.push({
        id,
        username,
        email,
        password_hash,
        preferences: "{}",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      return { first: null, results: [] }
    }
    if (n.startsWith("INSERT OR REPLACE INTO password_reset_tokens")) {
      const [user_id, token, expires_at] = args as [number, string, string]
      const idx = tables.password_reset_tokens.findIndex(
        (x) => x.user_id === user_id,
      )
      const row = { user_id, token, expires_at }
      if (idx >= 0) tables.password_reset_tokens[idx] = row
      else tables.password_reset_tokens.push(row)
      return { first: null, results: [] }
    }

    // ─── UPDATEs ─────────────────────────────────────────────────────
    if (n.startsWith("UPDATE project_members SET role_level = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP WHERE project_id = ? AND user_id = ?")) {
      const [role_level, granted_by, project_id, user_id] = args as [
        number,
        number,
        string,
        number,
      ]
      const m = tables.project_members.find(
        (x) => x.project_id === project_id && x.user_id === user_id,
      )
      if (m) {
        m.role_level = role_level
        m.granted_by = granted_by
        m.granted_at = new Date().toISOString()
      }
      return { first: null, results: [] }
    }
    if (
      n.startsWith("UPDATE project_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE token = ?") &&
      // Reject the longer multi-invite form — that's handled by the
      // Phase 1C branch below to stamp a specific (token, project_id) row.
      !n.includes("AND project_id = ?")
    ) {
      const [used_by, token] = args as [number, string]
      const inv = tables.project_invites.find((x) => x.token === token)
      if (inv) {
        inv.used_by = used_by
        inv.used_at = new Date().toISOString()
      }
      return { first: null, results: [] }
    }
    if (n.startsWith("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")) {
      const [hash, id] = args as [string, number]
      const u = tables.users.find((x) => x.id === id)
      if (u) {
        u.password_hash = hash
        u.updated_at = new Date().toISOString()
      }
      return { first: null, results: [] }
    }
    // ─── DELETEs ─────────────────────────────────────────────────────
    if (n.startsWith("DELETE FROM password_reset_tokens WHERE user_id = ?")) {
      tables.password_reset_tokens = tables.password_reset_tokens.filter(
        (x) => x.user_id !== args[0],
      )
      return { first: null, results: [] }
    }

    // ───────────────────────────────────────────────────────────────────
    // Phase 1C: project_settings (migration 0005)
    // ───────────────────────────────────────────────────────────────────
    if (
      n.startsWith(
        "SELECT project_id, settings, version, updated_at, updated_by FROM project_settings WHERE project_id = ?",
      )
    ) {
      const row = tables.project_settings.find((x) => x.project_id === args[0])
      return { first: row ?? null, results: row ? [row] : [] }
    }
    if (
      n.startsWith(
        "INSERT INTO project_settings (project_id, settings, version, updated_by)",
      )
    ) {
      const [project_id, settings, version, updated_by] = args as [
        string,
        string,
        number,
        number,
      ]
      const existing = tables.project_settings.find(
        (x) => x.project_id === project_id,
      )
      if (existing) {
        throw new Error("UNIQUE constraint failed: project_settings.project_id")
      }
      tables.project_settings.push({
        project_id,
        settings,
        version,
        updated_at: new Date().toISOString(),
        updated_by,
      })
      return { first: null, results: [] }
    }
    if (
      n.startsWith(
        "UPDATE project_settings SET settings = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE project_id = ? AND version = ?",
      )
    ) {
      const [settings, updated_by, project_id, ifVersion] = args as [
        string,
        number,
        string,
        number,
      ]
      const row = tables.project_settings.find(
        (x) => x.project_id === project_id && x.version === ifVersion,
      )
      if (!row) {
        return { first: null, results: [], changes: 0 }
      }
      row.settings = settings
      row.version += 1
      row.updated_at = new Date().toISOString()
      row.updated_by = updated_by
      return { first: null, results: [], changes: 1 }
    }

    // ───────────────────────────────────────────────────────────────────
    // Phase 1C: source-linking (depends on Phase 1A's source_project_id
    // column on projects + 1A's events / cells projection schema).
    // ───────────────────────────────────────────────────────────────────
    if (
      n.startsWith(
        "SELECT id, name, source_project_id, archived_at FROM projects WHERE id = ?",
      )
    ) {
      const p = tables.projects.find((x) => x.id === args[0])
      if (!p) return { first: null, results: [] }
      const out = {
        id: p.id,
        name: p.name,
        source_project_id: p.source_project_id ?? null,
        archived_at: p.archived_at,
      }
      return { first: out, results: [out] }
    }
    if (
      n.startsWith("SELECT source_project_id FROM projects WHERE id = ?")
    ) {
      const p = tables.projects.find((x) => x.id === args[0])
      if (!p) return { first: null, results: [] }
      const out = { source_project_id: p.source_project_id ?? null }
      return { first: out, results: [out] }
    }
    if (
      n.startsWith("SELECT id FROM projects WHERE source_project_id = ?")
    ) {
      const rows = tables.projects
        .filter((x) => x.source_project_id === args[0])
        .map((x) => ({ id: x.id }))
      return { first: rows[0] ?? null, results: rows }
    }
    if (
      n.startsWith(
        "UPDATE projects SET source_project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
    ) {
      const [sourceProjectId, id] = args as [string | null, string]
      const p = tables.projects.find((x) => x.id === id)
      if (p) p.source_project_id = sourceProjectId
      return { first: null, results: [] }
    }
    if (
      n.startsWith(
        "UPDATE projects SET source_project_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
    ) {
      const [id] = args as [string]
      const p = tables.projects.find((x) => x.id === id)
      if (p) p.source_project_id = null
      return { first: null, results: [] }
    }
    if (n.startsWith("DELETE FROM projects WHERE id = ?")) {
      tables.projects = tables.projects.filter((x) => x.id !== args[0])
      return { first: null, results: [] }
    }

    // ───────────────────────────────────────────────────────────────────
    // Phase 1C: events writes (link-source + source.cell.commit burst).
    // 1A owns the events table; the FakeD1 stores them here so tests can
    // assert the durable record exists.
    // ───────────────────────────────────────────────────────────────────
    if (n.startsWith("INSERT INTO events")) {
      const [id, project_id, ...rest] = args as unknown[]
      // Match the two shapes used by source-linking.ts:
      //   project-scope:  (id, project_id, author, payload, client_ts, server_ts)
      //   cell-scope:     (id, project_id, file_id, cell_id, author, payload, client_ts, server_ts)
      if (rest.length === 4) {
        const [author, payload, client_ts, server_ts] = rest as [
          string,
          string,
          number,
          number,
        ]
        const kindMatch = n.match(/'([^']+)'/)
        tables.events.push({
          id: id as string,
          schema_version: 1,
          project_id: project_id as string,
          file_id: null,
          cell_id: null,
          kind: kindMatch ? kindMatch[1] : "unknown",
          author,
          payload,
          client_ts,
          server_ts,
        })
      } else {
        const [file_id, cell_id, author, payload, client_ts, server_ts] = rest as [
          string,
          string,
          string,
          string,
          number,
          number,
        ]
        const kindMatch = n.match(/'([^']+)'/)
        tables.events.push({
          id: id as string,
          schema_version: 1,
          project_id: project_id as string,
          file_id,
          cell_id,
          kind: kindMatch ? kindMatch[1] : "unknown",
          author,
          payload,
          client_ts,
          server_ts,
        })
      }
      return { first: null, results: [] }
    }

    // ───────────────────────────────────────────────────────────────────
    // Phase 1C: cells read for source-snapshot burst.
    // ───────────────────────────────────────────────────────────────────
    if (
      n.startsWith(
        "SELECT file_id, cell_id, value, value_html FROM cells WHERE project_id = ? AND side = 'source'",
      )
    ) {
      const rows = tables.cells
        .filter((x) => x.project_id === args[0] && x.side === "source")
        .map((x) => ({
          file_id: x.file_id,
          cell_id: x.cell_id,
          value: x.value,
          value_html: x.value_html,
        }))
      return { first: rows[0] ?? null, results: rows }
    }

    // ───────────────────────────────────────────────────────────────────
    // Phase 1C: multi-invite token reads + updates. The
    // SELECT-by-token-returning-all-rows behavior is implemented in the
    // earlier project_invites branch (returns the full filtered list so
    // both .first() and .all() callers work).
    // ───────────────────────────────────────────────────────────────────
    if (
      n.startsWith(
        "SELECT id, name, org_id, created_by, archived_at FROM projects WHERE id IN (",
      )
    ) {
      const ids = args as string[]
      const rows = tables.projects.filter((p) => ids.includes(p.id))
      return { first: rows[0] ?? null, results: rows }
    }
    if (
      n.startsWith(
        "UPDATE project_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE token = ? AND project_id = ?",
      )
    ) {
      const [used_by, token, project_id] = args as [number, string, string]
      const inv = tables.project_invites.find(
        (x) => x.token === token && x.project_id === project_id,
      )
      if (inv) {
        inv.used_by = used_by
        inv.used_at = new Date().toISOString()
      }
      return { first: null, results: [] }
    }

    throw new Error(`FakeD1: unsupported SQL: ${n}`)
  }

  function makeStatement(sql: string, args: unknown[] = []): D1PreparedStatement {
    return {
      bind: (...newArgs: unknown[]) => makeStatement(sql, newArgs),
      first: async <T = unknown>() => {
        const { first } = exec(sql, args)
        return first as T | null
      },
      all: async <T = unknown>() => {
        const { results } = exec(sql, args)
        return {
          success: true,
          results: results as T[],
          meta: {} as Record<string, unknown>,
        } as unknown as D1Result<T>
      },
      run: async () => {
        const r = exec(sql, args)
        const meta: Record<string, unknown> = {}
        if (typeof r.changes === "number") meta.changes = r.changes
        return {
          success: true,
          meta,
          results: [] as unknown[],
        } as unknown as D1Result
      },
      raw: async () => {
        const { results } = exec(sql, args)
        return results as unknown as []
      },
    } as unknown as D1PreparedStatement
  }

  const db = {
    prepare(sql: string): D1PreparedStatement {
      return makeStatement(sql)
    },
    batch: async (statements: D1PreparedStatement[]) => {
      const out: D1Result[] = []
      for (const s of statements) {
        out.push(await s.run())
      }
      return out
    },
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }) as unknown as D1ExecResult,
    withSession: () => {
      throw new Error("FakeD1.withSession not supported")
    },
    _tables: () => tables,
    _issued: () => issued,
  } as unknown as FakeD1

  return db
}
