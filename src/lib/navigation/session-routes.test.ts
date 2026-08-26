import { describe, expect, it } from "vitest"
import { isSessionHydrationRequiredPath } from "./session-routes"

describe("isSessionHydrationRequiredPath", () => {
  it("gates server-backed workspace routes", () => {
    for (const path of [
      "/",
      "/app",
      "/orgs/all",
      "/orgs/7/members",
      "/projects",
      "/projects/p1",
      "/shared",
      "/preferences",
      "/admin",
    ]) {
      expect(isSessionHydrationRequiredPath(path)).toBe(true)
    }
  })

  it("leaves public and offline-capable routes reachable", () => {
    for (const path of [
      "/login",
      "/reset-password",
      "/verify-email",
      "/privacy-policy",
      "/onboarding",
      "/join/token",
      "/join-org/token",
      "/link/token",
      "/approve/change",
      "/__dev/login",
      "/__marketing/login",
      "/project/p1",
      "/project/p1/editor",
      "/project/p1/settings",
    ]) {
      expect(isSessionHydrationRequiredPath(path)).toBe(false)
    }
  })
})
