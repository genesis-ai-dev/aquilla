// [Pen test] Auth & session mgmt (2026-08-31, OPS-25).
//
// The three public invite-preview routes are anonymous-reachable by design,
// but they DO read a caller identity when one is offered: AQU-347's
// "you already redeemed this and you're still a member" branch turns an
// otherwise-terminal 410 into a 200 that discloses project name, org name,
// inviter display name, role, expiry and lane scopes.
//
// Each route used to resolve that identity through its own hand-written
// `optionalCaller`, which verified only the JWT signature and `exp`. It
// skipped BOTH of this codebase's revocation controls — the `jti` denylist
// (logout, 2026-08-03) and the `password_changed_at` cutoff (password reset,
// 2026-07-20) — so a token the user had explicitly logged out, or invalidated
// by resetting a compromised password, still resolved to that user here.
//
// These tests pin the fix: all three routes now resolve identity through
// `resolveSession` in middleware/auth.ts, the same function authMiddleware
// uses, so a revoked or reset-invalidated token reads as anonymous. Each
// `rejects` case below fails (200 instead of 410) against the pre-fix code.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import app from "../index"
import { authHeader } from "./helpers/db"

const ROUTES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../routes",
)

async function reqJson(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  )
}

/** Registers through the real endpoint so the returned token carries a `jti`
 *  (seedUser's fake password hash can't log in, and jwtFor mints no jti). */
async function register(username: string): Promise<{ id: number; token: string }> {
  const res = await reqJson("/api/v2/auth/register", {
    username,
    email: `${username}@example.com`,
    password: "a-real-password-1",
  })
  expect(res.status).toBe(200)
  const { access_token: token } = (await res.json()) as { access_token: string }
  const row = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: number }>()
  return { id: row!.id, token }
}

let wendi: { id: number; token: string }
let bob: { id: number; token: string }

async function seedWorld(): Promise<void> {
  wendi = await register("wendi")
  bob = await register("bob")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', ?)",
  )
    .bind(wendi.id)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, ?, 700, ?)",
  )
    .bind(wendi.id, wendi.id)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Kilisusu NT', 1, ?)",
  )
    .bind(wendi.id)
    .run()
}

/** Logs the token out, denylisting its `jti` (utils/token-revocation.ts). */
async function logout(token: string): Promise<void> {
  const res = await app.request(
    "/api/v2/auth/logout",
    { method: "POST", headers: authHeader(token) },
    env,
  )
  expect(res.status).toBe(200)
}

/** Stamps a password reset strictly after the token's `iat`, the way
 *  POST /auth/password-reset/reset does. */
async function resetPasswordAfterIssue(username: string): Promise<void> {
  await env.AQUILLA_PG.prepare("UPDATE users SET password_changed_at = ? WHERE username = ?")
    .bind(new Date(Date.now() + 60_000).toISOString(), username)
    .run()
}

// ─── The three previews, each set up as a used-but-still-a-member invite ─────
// (the only state in which caller identity changes the response at all).

/** Single-project invite: POST /projects/pa/invites → accept-invite. */
async function usedSingleProjectInvite(): Promise<string> {
  const created = await app.request(
    "/api/v2/projects/pa/invites",
    { method: "POST", headers: authHeader(wendi.token), body: JSON.stringify({}) },
    env,
  )
  expect(created.status).toBe(200)
  const { token } = (await created.json()) as { token: string }
  const accepted = await app.request(
    "/api/v2/projects/accept-invite",
    { method: "POST", headers: authHeader(bob.token), body: JSON.stringify({ token }) },
    env,
  )
  expect(accepted.status).toBe(200)
  return token
}

/** Multi-project invite: POST /invites/multi → POST /invites/:token/accept. */
async function usedMultiProjectInvite(): Promise<string> {
  const created = await app.request(
    "/api/v2/invites/multi",
    {
      method: "POST",
      headers: authHeader(wendi.token),
      body: JSON.stringify({ projectIds: ["pa"] }),
    },
    env,
  )
  expect(created.status).toBe(200)
  const { token } = (await created.json()) as { token: string }
  const accepted = await app.request(
    `/api/v2/invites/${token}/accept`,
    { method: "POST", headers: authHeader(bob.token), body: JSON.stringify({}) },
    env,
  )
  expect(accepted.status).toBe(200)
  return token
}

/** Org invite: POST /orgs/1/invites → POST /orgs/accept-invite. */
async function usedOrgInvite(): Promise<string> {
  const created = await app.request(
    "/api/v2/orgs/1/invites",
    { method: "POST", headers: authHeader(wendi.token), body: JSON.stringify({ role: 400 }) },
    env,
  )
  expect(created.status).toBe(200)
  const { token } = (await created.json()) as { token: string }
  const accepted = await reqJsonAuthed("/api/v2/orgs/accept-invite", bob.token, { token })
  expect(accepted.status).toBe(200)
  return token
}

async function reqJsonAuthed(
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: authHeader(token), body: JSON.stringify(body) },
    env,
  )
}

async function preview(url: string, token?: string): Promise<Response> {
  return app.request(url, token ? { headers: authHeader(token) } : {}, env)
}

const SURFACES = [
  {
    name: "single-project invite preview",
    setup: () => usedSingleProjectInvite(),
    url: (t: string) => `/api/v2/projects/invite-preview/${t}`,
  },
  {
    name: "multi-project invite preview",
    setup: () => usedMultiProjectInvite(),
    url: (t: string) => `/api/v2/invites/${t}/preview`,
  },
  {
    name: "org invite preview",
    setup: () => usedOrgInvite(),
    url: (t: string) => `/api/v2/orgs/invite-preview/${t}`,
  },
] as const

describe.each(SURFACES)("$name — revocation is enforced on the optional caller", (surface) => {
  beforeEach(seedWorld)

  // Baseline: the AQU-347 branch this finding is about still works. Without
  // this, the two rejection tests below could pass for the wrong reason.
  it("still returns 200 for the redeemer holding a live token", async () => {
    const token = await surface.setup()
    const res = await preview(surface.url(token), bob.token)
    expect(res.status).toBe(200)
  })

  it("treats an anonymous caller as anonymous (410 used)", async () => {
    const token = await surface.setup()
    const res = await preview(surface.url(token))
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ code: "used" })
  })

  it("rejects a logged-out (jti-denylisted) token — OPS-25", async () => {
    const token = await surface.setup()
    await logout(bob.token)
    const res = await preview(surface.url(token), bob.token)
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ code: "used" })
  })

  it("rejects a token invalidated by a password reset — OPS-25", async () => {
    const token = await surface.setup()
    await resetPasswordAfterIssue("bob")
    const res = await preview(surface.url(token), bob.token)
    expect(res.status).toBe(410)
    expect(await res.json()).toMatchObject({ code: "used" })
  })
})

// ─── Drift guard ────────────────────────────────────────────────────────────
// OPS-25's root cause was three copies of the same helper, each of which had
// to remember every session check independently — the same shape OPS-11 found
// in the service-bearer compare. One helper is only a fix for as long as it
// stays the only one, so scan for a route re-growing its own.

/**
 * `routes/auth.ts` is the one legitimate caller: its login handler resolves a
 * user from the *username in the request body* to verify a password against
 * (auth.ts:417), and its refresh handler echoes back the caller's raw token
 * string on a below-half-life request (auth.ts:594) — already behind
 * authMiddleware. Neither derives a caller identity from a token, which is the
 * thing this guard is about. Adding to this list should require the same
 * argument.
 */
const SESSION_LOOKUP_ALLOWLIST = new Set(["auth.ts"])

describe("no route file hand-rolls its own session resolution (OPS-25 drift guard)", () => {
  it("resolves caller identity only through middleware/auth", () => {
    const offenders: string[] = []
    for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
      if (SESSION_LOOKUP_ALLOWLIST.has(file)) continue
      const source = readFileSync(path.join(ROUTES_DIR, file), "utf8")
      // The tell: a route deriving a user from a raw token itself. Every
      // legitimate path goes through authMiddleware / optionalCaller, neither
      // of which names getUserByUsername at the call site.
      if (/getUserByUsername\s*\(/.test(source)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
