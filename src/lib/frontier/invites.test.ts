import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getOrgInvites,
  revokeOrgInvite,
  createAccessLink,
  revokeAccessLink,
  createMultiProjectInvite,
} from "./invites"
import { clearElevationRequired, isElevationRequired } from "@/lib/errors/elevation-required-signal"

const ELEVATION_BODY = JSON.stringify({
  error: "elevation required to manage org membership with platform-admin access",
})

function json(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => clearElevationRequired())
afterEach(() => {
  vi.unstubAllGlobals()
  clearElevationRequired()
})

describe("invites client functions", () => {
  describe("elevation required", () => {
    it("getOrgInvites raises the step-up signal on an elevation 403", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(ELEVATION_BODY, 403)))
      await expect(getOrgInvites("jwt", 1)).rejects.toMatchObject({ status: 403 })
      expect(isElevationRequired()).toBe(true)
    })

    it("revokeOrgInvite raises the step-up signal on an elevation 403", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(ELEVATION_BODY, 403)))
      await expect(revokeOrgInvite("jwt", 1, "token")).rejects.toMatchObject({ status: 403 })
      expect(isElevationRequired()).toBe(true)
    })

    it("createAccessLink raises the step-up signal on an elevation 403", async () => {
      const body = JSON.stringify({
        error: "elevation required to manage project membership with platform-admin access",
      })
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body, 403)))
      await expect(
        createAccessLink("jwt", { projectId: "p1", userId: 1, pin: "123456" }),
      ).rejects.toMatchObject({ status: 403 })
      expect(isElevationRequired()).toBe(true)
    })

    it("revokeAccessLink raises the step-up signal on an elevation 403", async () => {
      const body = JSON.stringify({
        error: "elevation required to manage project membership with platform-admin access",
      })
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body, 403)))
      await expect(revokeAccessLink("jwt", "token")).rejects.toMatchObject({ status: 403 })
      expect(isElevationRequired()).toBe(true)
    })

    it("createMultiProjectInvite raises the step-up signal on an elevation 403", async () => {
      const body = JSON.stringify({
        error: "elevation required to manage project membership with platform-admin access",
      })
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body, 403)))
      await expect(
        createMultiProjectInvite("jwt", { projectIds: ["p1"] }),
      ).rejects.toMatchObject({ status: 403 })
      expect(isElevationRequired()).toBe(true)
    })
  })

  describe("generic errors", () => {
    it("getOrgInvites keeps a generic 403 for other denials", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(JSON.stringify({ error: "no access" }), 403)))
      await expect(getOrgInvites("jwt", 1)).rejects.toMatchObject({ status: 403 })
      expect(isElevationRequired()).toBe(false)
    })

  })

  describe("success cases", () => {
    it("getOrgInvites returns the list of invites", async () => {
      const response = {
        invites: [
          {
            token: "tok1",
            role: { level: 400, name: "Maintainer" },
            createdAt: "2026-01-01T00:00:00Z",
            expiresAt: "2026-02-01T00:00:00Z",
            email: "user@example.com",
          },
        ],
      }
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(JSON.stringify(response), 200)))
      const result = await getOrgInvites("jwt", 1)
      expect(result).toEqual(response.invites)
    })

    it("revokeOrgInvite resolves without returning data", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(JSON.stringify({ ok: true }), 200)))
      await expect(revokeOrgInvite("jwt", 1, "token")).resolves.toBeUndefined()
    })

    it("createAccessLink returns the created link", async () => {
      const response = {
        token: "link1",
        projectId: "p1",
        userId: 123,
        role: 300,
        expiresAt: "2026-02-01T00:00:00Z",
      }
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(JSON.stringify(response), 200)))
      const result = await createAccessLink("jwt", {
        projectId: "p1",
        userId: 123,
        pin: "123456",
      })
      expect(result).toEqual(response)
    })

    it("revokeAccessLink resolves without returning data", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(JSON.stringify({ ok: true }), 200)))
      await expect(revokeAccessLink("jwt", "token")).resolves.toBeUndefined()
    })

    it("createMultiProjectInvite returns the created invite", async () => {
      const response = {
        token: "tok1",
        projectIds: ["p1", "p2"],
        role: 300,
        expiresAt: "2026-02-01T00:00:00Z",
      }
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(JSON.stringify(response), 200)))
      const result = await createMultiProjectInvite("jwt", { projectIds: ["p1", "p2"] })
      expect(result).toEqual(response)
    })
  })
})
