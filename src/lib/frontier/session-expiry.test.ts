// AQU-884 follow-up: notifySessionExpiredIfCurrent must only latch the banner
// when the failing JWT is still the active session's credential. The regression
// it guards: after a successful re-login, components with not-yet-rehydrated
// React state fired requests with the previous JWT; those 401s landed after
// finalizeSession() lowered the banner and re-latched it over a healthy
// dashboard.

import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import { notifySessionExpiredIfCurrent } from "./session-expiry"
import { clearSession, patchSessionEmails, saveSession, sessionKey } from "./session-store"
import {
  clearSessionExpired,
  isSessionExpired,
} from "@/lib/errors/session-expired-signal"

beforeEach(async () => {
  await clearSession()
  clearSessionExpired()
})

describe("notifySessionExpiredIfCurrent", () => {
  it("latches when the failing JWT is the active session's (genuine expiry)", async () => {
    await saveSession({ jwt: "jwt-dead", username: "anna", createdAt: "2026-01-01" })
    await notifySessionExpiredIfCurrent("jwt-dead")
    expect(isSessionExpired()).toBe(true)
  })

  it("ignores a straggler 401 from a JWT that re-login has replaced", async () => {
    await saveSession({ jwt: "jwt-fresh", username: "anna", createdAt: "2026-01-01" })
    await notifySessionExpiredIfCurrent("jwt-dead")
    expect(isSessionExpired()).toBe(false)
  })

  it("ignores a straggler 401 when no session is stored (post-logout)", async () => {
    await notifySessionExpiredIfCurrent("jwt-dead")
    expect(isSessionExpired()).toBe(false)
  })

  it("does not relatch when login commits after the authority read starts", async () => {
    const stale = { jwt: "jwt-dead", username: "anna", createdAt: "2026-01-01" }
    await saveSession(stale)
    let resolveRead!: (session: typeof stale) => void
    const delayedRead = new Promise<typeof stale>((resolve) => { resolveRead = resolve })

    const fresh = { ...stale, jwt: "jwt-fresh" }
    let reads = 0
    const notifying = notifySessionExpiredIfCurrent("jwt-dead", () => {
      reads += 1
      return reads === 1 ? delayedRead : Promise.resolve(fresh)
    })
    await saveSession(fresh)
    resolveRead(stale)
    await notifying

    expect(isSessionExpired()).toBe(false)
  })

  it("rechecks after an email backfill and still signals the unchanged dead credential", async () => {
    const stale = { jwt: "jwt-dead", username: "anna", createdAt: "2026-01-01" }
    await saveSession(stale)
    let resolveRead!: (session: typeof stale) => void
    const delayedRead = new Promise<typeof stale>((resolve) => { resolveRead = resolve })
    let reads = 0

    const notifying = notifySessionExpiredIfCurrent("jwt-dead", () => {
      reads += 1
      return reads === 1 ? delayedRead : Promise.resolve({ ...stale, email: "anna@example.com" })
    })
    await patchSessionEmails({ [sessionKey(stale)]: "anna@example.com" })
    resolveRead(stale)
    await notifying

    expect(reads).toBe(2)
    expect(isSessionExpired()).toBe(true)
  })
})
