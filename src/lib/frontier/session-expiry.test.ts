// AQU-884 follow-up: notifySessionExpiredIfCurrent must only latch the banner
// when the failing JWT is still the active session's credential. The regression
// it guards: after a successful re-login, components with not-yet-rehydrated
// React state fired requests with the previous JWT; those 401s landed after
// finalizeSession() lowered the banner and re-latched it over a healthy
// dashboard.

import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import { notifySessionExpiredIfCurrent } from "./session-expiry"
import { clearSession, saveSession } from "./session-store"
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
})
