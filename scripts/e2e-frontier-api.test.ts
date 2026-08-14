import { afterEach, describe, expect, it, vi } from "vitest"
import { createProjectServerSide } from "../e2e/helpers/frontier-api"

describe("E2E frontier API fixture writes", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("replays project creation after a transient worker-restart response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        "Your worker restarted mid-request. Please try sending the request again.",
        { status: 503 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "project-1",
        name: "Stable fixture",
        orgId: 1,
        role: { level: 700, name: "owner" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(createProjectServerSide("jwt", {
      id: "project-1",
      name: "Stable fixture",
    })).resolves.toMatchObject({ id: "project-1" })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body)
  })
})
