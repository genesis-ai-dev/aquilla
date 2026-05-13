// Minimal in-memory D1 fake for auth-worker route tests.
//
// Supports the statement shapes the auth-worker actually issues against the
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

export interface FakeTables {
  users: UserRow[]
  projects: ProjectRow[]
  project_members: ProjectMemberRow[]
  project_invites: ProjectInviteRow[]
  password_reset_tokens: ResetTokenRow[]
  organizations: OrganizationRow[]
  org_members: OrgMemberRow[]
}

export type FakeD1 = D1Database & {
  _tables(): FakeTables
  _issued(): Array<{ sql: string; args: unknown[] }>
}

export function makeFakeD1(initial: Partial<FakeTables> = {}): FakeD1 {
  const tables: FakeTables = {
    users: initial.users ?? [],
    projects: initial.projects ?? [],
    project_members: initial.project_members ?? [],
    project_invites: initial.project_invites ?? [],
    password_reset_tokens: initial.password_reset_tokens ?? [],
    organizations: initial.organizations ?? [],
    org_members: initial.org_members ?? [],
  }
  const issued: Array<{ sql: string; args: unknown[] }> = []

  function norm(sql: string): string {
    return sql.replace(/\s+/g, " ").trim()
  }

  function exec(sql: string, args: unknown[]): { first: unknown; results: unknown[] } {
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

    // ─── SELECT project_invites ──────────────────────────────────────
    if (n.startsWith("SELECT token, project_id, role_level, created_by, created_at, expires_at, used_by, used_at FROM project_invites WHERE token = ?")) {
      const inv = tables.project_invites.find((x) => x.token === args[0])
      return { first: inv ?? null, results: inv ? [inv] : [] }
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
    if (n.startsWith("UPDATE project_invites SET used_by = ?, used_at = CURRENT_TIMESTAMP WHERE token = ?")) {
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
        exec(sql, args)
        return {
          success: true,
          meta: {} as Record<string, unknown>,
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
