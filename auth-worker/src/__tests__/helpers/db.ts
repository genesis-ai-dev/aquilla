import { env } from "cloudflare:test"
import { sign } from "hono/jwt"

export async function seedUser(id: number, username: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (?, ?, ?, ?, '{}')",
  )
    .bind(id, username, `${username}@example.com`, "scrypt:fake$salt$hash")
    .run()
}

export async function jwtFor(username: string, iatOverride?: number): Promise<string> {
  const now = iatOverride ?? Math.floor(Date.now() / 1000)
  return sign({ sub: username, iat: now, exp: now + 3600 }, env.SECRET_KEY, "HS256")
}

export function authHeader(jwt: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}
