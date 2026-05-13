// Minimal in-memory D1 fake for auth-worker route tests.
//
// Supports only the statement shapes the auth-worker actually issues:
//   - SELECT * FROM users WHERE username = ? (first)
//   - SELECT * FROM users WHERE email = ? (first)
//   - SELECT id FROM users WHERE username = ? OR email = ? (first)
//   - SELECT id, username FROM users WHERE email = ? (first)
//   - SELECT id, gitlab_user_id FROM users WHERE username = ? (first)
//   - SELECT * FROM projects WHERE id = ? (first)
//   - SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ? (first)
//   - SELECT * FROM project_invites WHERE token = ? (first)
//   - INSERT INTO projects / project_invites / project_members / users / password_reset_tokens
//   - UPDATE project_members / project_invites / users / password_reset_tokens
//   - DELETE FROM password_reset_tokens WHERE user_id = ?
//
// We pattern-match on the normalized SQL string + bind args; not pretty but
// sufficient for the happy-path coverage.

export interface UserRow {
  id: number
  username: string
  email: string
  password_hash: string
  gitlab_user_id: number | null
  gitlab_username: string | null
  gitlab_token: string | null
  stripe_customer_id: string | null
  subscription_tier: string | null
  preferences: string | null
  created_at: string
  updated_at: string
}

export interface ProjectRow {
  id: string
  name: string
  gitlab_project_id: number | null
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

export interface FakeTables {
  users: UserRow[]
  projects: ProjectRow[]
  project_members: ProjectMemberRow[]
  project_invites: ProjectInviteRow[]
  password_reset_tokens: ResetTokenRow[]
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
    if (n.startsWith("SELECT id, gitlab_user_id FROM users WHERE username = ?")) {
      const u = tables.users.find((x) => x.username === args[0])
      return {
        first: u
          ? { id: u.id, gitlab_user_id: u.gitlab_user_id }
          : null,
        results: u ? [{ id: u.id, gitlab_user_id: u.gitlab_user_id }] : [],
      }
    }
    if (n.startsWith("SELECT id FROM users WHERE username = ?")) {
      const u = tables.users.find((x) => x.username === args[0])
      return { first: u ? { id: u.id } : null, results: u ? [{ id: u.id }] : [] }
    }

    // ─── SELECT projects ──────────────────────────────────────────────
    if (n.startsWith("SELECT id, name, gitlab_project_id, org_id, created_by, archived_at FROM projects WHERE id = ?")) {
      const p = tables.projects.find((x) => x.id === args[0])
      return { first: p ?? null, results: p ? [p] : [] }
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
      const [id, name, gitlab_project_id, created_by] = args as [
        string,
        string,
        number | null,
        number,
      ]
      tables.projects.push({
        id,
        name,
        gitlab_project_id: gitlab_project_id ?? null,
        org_id: null,
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
        gitlab_user_id: null,
        gitlab_username: null,
        gitlab_token: null,
        stripe_customer_id: null,
        subscription_tier: "free",
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
    if (n.startsWith("UPDATE users SET gitlab_token = ? WHERE id = ?")) {
      const [token, id] = args as [string, number]
      const u = tables.users.find((x) => x.id === id)
      if (u) u.gitlab_token = token
      return { first: null, results: [] }
    }
    if (n.startsWith("UPDATE users SET gitlab_token = ? WHERE username = ?")) {
      const [token, uname] = args as [string, string]
      const u = tables.users.find((x) => x.username === uname)
      if (u) u.gitlab_token = token
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
