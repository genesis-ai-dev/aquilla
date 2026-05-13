const AUTH_BASE =
  process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"

export interface SeedUser {
  username: "alice" | "bob" | "carol"
  email: string
  password: string
}

export const SEED_USERS: SeedUser[] = [
  { username: "alice", email: "alice@example.test", password: "alice-test-pw" },
  { username: "bob",   email: "bob@example.test",   password: "bob-test-pw" },
  { username: "carol", email: "carol@example.test", password: "carol-test-pw" },
]

/** Hits the /__test__/reset route on codex-auth-worker to truncate + reseed
 * the local D1. Throws on any non-2xx response. */
export async function resetBackend(): Promise<void> {
  const r = await fetch(`${AUTH_BASE}/__test__/reset`, { method: "POST" })
  if (!r.ok) {
    throw new Error(`backend reset failed: HTTP ${r.status} — ${await r.text()}`)
  }
}

/** Lookup a seed user by username. */
export function seedUser(name: SeedUser["username"]): SeedUser {
  const u = SEED_USERS.find((x) => x.username === name)
  if (!u) throw new Error(`unknown seed user: ${name}`)
  return u
}
