// Minimal in-memory D1 fake for chat-worker route tests.
//
// The chat worker only ever issues `SELECT * FROM users WHERE username = ?`
// (via JWTService.getUserByUsername), so the fake intentionally supports
// that one statement and throws on anything else — accidental new queries
// are surfaced loudly during tests instead of silently no-oping.
//
// Adapted from auth-worker/src/__tests__/helpers/d1-fake.ts.

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

export interface FakeTables {
  users: UserRow[]
}

export type FakeD1 = D1Database & {
  _tables(): FakeTables
  _issued(): Array<{ sql: string; args: unknown[] }>
}

export function makeFakeD1(initial: Partial<FakeTables> = {}): FakeD1 {
  const tables: FakeTables = {
    users: initial.users ?? [],
  }
  const issued: Array<{ sql: string; args: unknown[] }> = []

  function norm(sql: string): string {
    return sql.replace(/\s+/g, " ").trim()
  }

  function exec(sql: string, args: unknown[]): { first: unknown; results: unknown[] } {
    const n = norm(sql)
    issued.push({ sql: n, args })

    if (n.startsWith("SELECT * FROM users WHERE username = ?")) {
      const u = tables.users.find((x) => x.username === args[0])
      return { first: u ?? null, results: u ? [u] : [] }
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

/** Convenience: seed a single user row with sensible defaults. */
export function seedUser(overrides: Partial<UserRow> = {}): UserRow {
  const now = new Date().toISOString()
  return {
    id: 1,
    username: "alice",
    email: "alice@example.com",
    password_hash: "$2a$10$x",
    gitlab_user_id: null,
    gitlab_username: null,
    gitlab_token: null,
    stripe_customer_id: null,
    subscription_tier: "free",
    preferences: "{}",
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}
