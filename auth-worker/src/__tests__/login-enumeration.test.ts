// [Pen test] Auth & session mgmt (2026-08-24), OPS-18 — regression guard for
// the login timing oracle.
//
// POST /api/v2/auth/token used to return from the "no account with that
// identifier" branch after a single indexed SELECT, while the
// "account exists, wrong password" branch additionally paid a full werkzeug
// scrypt derivation (N=32768, deliberately expensive). The gap was large
// enough to read off the wire, which made an unauthenticated caller able to
// enumerate registered usernames and email addresses without ever guessing a
// password — and the existing throttles don't blunt it, because each probe
// uses a fresh identifier so only the per-IP counter moves.
//
// The fix (utils/password.ts absorbPasswordVerificationCost) spends the same
// scrypt work on the no-such-user branch and discards the result.
//
// NOTE ON THE ASSERTION: this is a timing test, so the bound is deliberately
// loose — before the fix the ratio was on the order of a few percent; after
// it, the two branches differ only by one DB write. A threshold of 0.35 is
// far below any plausible post-fix value and far above any plausible
// pre-fix one. Medians of three samples, to survive a noisy CI box.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import {
  absorbPasswordVerificationCost,
  hashPasswordWerkzeugScrypt,
  verifyPassword,
} from "../utils/password"

async function login(username: string, password: string): Promise<Response> {
  return app.request(
    "/api/v2/auth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    env,
  )
}

async function timeMs(fn: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await fn()
  return performance.now() - started
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

describe("login enumeration (OPS-18)", () => {
  it("does not leak account existence through response time", async () => {
    await app.request(
      "/api/v2/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "timing-real",
          email: "timing-real@example.com",
          password: "the-real-password-1",
        }),
      },
      env,
    )

    const known: number[] = []
    const unknown: number[] = []
    for (let i = 0; i < 3; i++) {
      // Interleaved so a warming JIT or a busy moment hits both arms alike.
      known.push(await timeMs(() => login("timing-real", "wrong-password-x")))
      unknown.push(
        await timeMs(() => login(`timing-ghost-${i}@example.com`, "wrong-password-x")),
      )
    }

    // Both must be plain 401s — this is about how long they take, not what
    // they say (the bodies were already identical).
    const [a, b] = await Promise.all([
      login("timing-real", "wrong-password-x"),
      login("timing-ghost-final@example.com", "wrong-password-x"),
    ])
    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(await a.json()).toEqual(await b.json())

    const ratio = median(unknown) / median(known)
    expect(
      ratio,
      `no-such-user branch took ${median(unknown).toFixed(0)}ms vs ${median(known).toFixed(0)}ms ` +
        `for a real account (ratio ${ratio.toFixed(2)}) — the scrypt cost is not being absorbed`,
    ).toBeGreaterThan(0.35)
  })

  it("absorbPasswordVerificationCost costs about what a real verification costs", async () => {
    const stored = await hashPasswordWerkzeugScrypt("some-password")
    const real = await timeMs(() => verifyPassword("wrong-password", stored))
    const dummy = await timeMs(() => absorbPasswordVerificationCost("wrong-password"))
    expect(dummy / real).toBeGreaterThan(0.35)
  })

  it("never throws, whatever it is handed", async () => {
    await expect(absorbPasswordVerificationCost("")).resolves.toBeUndefined()
    await expect(absorbPasswordVerificationCost("🔒 unicode")).resolves.toBeUndefined()
    await expect(absorbPasswordVerificationCost("x".repeat(4096))).resolves.toBeUndefined()
  })
})
