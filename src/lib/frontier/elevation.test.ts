import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { notifyElevationRequiredIfCurrent, throwIfElevationRequired } from "./elevation"
import type { FrontierSession } from "./types"
import { addTeamMember } from "./teams"
import { addProjectMember } from "./members"
import { UserError } from "@/lib/errors/user-error"
import { t } from "@/lib/i18n/standalone"
import {
  clearElevationRequired,
  getElevationWaitingOn,
  isElevationRequired,
  type ElevationReason,
} from "@/lib/errors/elevation-required-signal"

const ELEVATION_BODY = JSON.stringify({
  error: "elevation required to manage teams with platform-admin access",
})

function json(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => clearElevationRequired())
afterEach(() => {
  vi.unstubAllGlobals()
  clearElevationRequired()
})

describe("throwIfElevationRequired", () => {
  it("raises the signal and throws a UserError on a 403 elevation body", async () => {
    const err = await throwIfElevationRequired(json(ELEVATION_BODY, 403), "team").catch((e) => e)
    expect(err).toBeInstanceOf(UserError)
    expect(err.status).toBe(403)
    expect(err.category).toBe("forbidden")
    expect(err.message).toBe(t("error.network.elevationRequired"))
    expect(err.raw).toBe(ELEVATION_BODY)
    expect(isElevationRequired()).toBe(true)
    // Nothing replays a refused membership change: the prompt says to redo it.
    expect(getElevationWaitingOn()).toBe("action")
  })

  it("leaves other 403s alone and the body readable", async () => {
    const res = json(JSON.stringify({ error: "no access to project" }), 403)
    await expect(throwIfElevationRequired(res)).resolves.toBeUndefined()
    expect(isElevationRequired()).toBe(false)
    expect(await res.text()).toContain("no access to project")
  })

  it("tolerates a non-JSON 403 body", async () => {
    const res = new Response("<html>Forbidden</html>", { status: 403 })
    await expect(throwIfElevationRequired(res)).resolves.toBeUndefined()
    expect(isElevationRequired()).toBe(false)
    expect(await res.text()).toContain("Forbidden")
  })

  it("does nothing on a 200", async () => {
    await expect(throwIfElevationRequired(json("{}", 200))).resolves.toBeUndefined()
    expect(isElevationRequired()).toBe(false)
  })
})

describe("notifyElevationRequiredIfCurrent (OPS-44)", () => {
  const active = (jwt: string) => async () => ({ jwt }) as FrontierSession
  const syncToken: ElevationReason = { kind: "sync-token", projectId: "p1" }

  it("raises the signal, with its reason, when the refused JWT is the active session's", async () => {
    await notifyElevationRequiredIfCurrent("jwt-admin", syncToken, active("jwt-admin"))
    expect(isElevationRequired()).toBe(true)
    expect(getElevationWaitingOn()).toBe("sync-token")
  })

  it("stays quiet for another stored account: verifying would elevate the wrong session", async () => {
    await notifyElevationRequiredIfCurrent("jwt-background", syncToken, active("jwt-admin"))
    expect(isElevationRequired()).toBe(false)
  })

  it("stays quiet when nobody is signed in", async () => {
    await notifyElevationRequiredIfCurrent("jwt-admin", syncToken, async () => null)
    expect(isElevationRequired()).toBe(false)
  })

  it("raises the signal when the session store cannot be read", async () => {
    await notifyElevationRequiredIfCurrent("jwt-admin", syncToken, async () => {
      throw new Error("idb closed")
    })
    expect(isElevationRequired()).toBe(true)
  })
})

describe("client functions", () => {
  it("addTeamMember raises the step-up signal on an elevation 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(ELEVATION_BODY, 403)))
    await expect(addTeamMember("jwt", 1, 2, "kay")).rejects.toMatchObject({
      status: 403,
      message: t("error.network.elevationRequired"),
    })
    expect(isElevationRequired()).toBe(true)
  })

  it("addProjectMember raises the step-up signal on an elevation 403", async () => {
    const body = JSON.stringify({
      error: "elevation required to manage project membership with platform-admin access",
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body, 403)))
    await expect(addProjectMember("jwt", "p1", "kay", 400)).rejects.toMatchObject({
      status: 403,
      raw: body,
    })
    expect(isElevationRequired()).toBe(true)
  })

  it("addProjectMember keeps the generic 403 for other denials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(JSON.stringify({ error: "no access to project" }), 403)))
    await expect(addProjectMember("jwt", "p1", "kay", 400)).rejects.toMatchObject({ status: 403 })
    expect(isElevationRequired()).toBe(false)
  })
})
