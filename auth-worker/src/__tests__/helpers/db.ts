import { env } from "cloudflare:test"
import { sign } from "hono/jwt"

export async function seedUser(id: number, username: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO users (id, username, email, password_hash, preferences, created_at) VALUES (?, ?, ?, ?, '{}', '2020-01-01T00:00:00Z')",
  )
    .bind(id, username, `${username}@example.com`, "scrypt:fake$salt$hash")
    .run()
}

export async function jwtFor(username: string, iatOverride?: number): Promise<string> {
  const now = iatOverride ?? Math.floor(Date.now() / 1000)
  const user = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE LOWER(username)=LOWER(?)").bind(username).first<{id:number}>()
  return sign({ sub: username, ...(user ? {uid: String(user.id)} : {}), iat: now, exp: now + 3600 }, env.SECRET_KEY, "HS256")
}

export function authHeader(jwt: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }
}
