import { describe, expect, it, vi } from "vitest"
import { postIdempotentJson } from "../e2e/helpers/idempotent-request"

const request = (fetchImpl: typeof fetch) => postIdempotentJson({
  url: "http://127.0.0.1:8788/import",
  headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
  body: { projectId: "p1", eventId: "stable-event" },
  operation: "bulk import",
  fetchImpl,
  retryDelaysMs: [0, 0],
})

describe("postIdempotentJson", () => {
  it("retries a transient worker restart with the identical request body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("worker restarted", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    await expect(request(fetchMock as typeof fetch)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body)
  })

  it("does not retry a terminal client rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("invalid fixture", { status: 400 }),
    )

    await expect(request(fetchMock as typeof fetch)).rejects.toThrow(
      "bulk import failed: HTTP 400 — invalid fixture",
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("fails with the final response after the bounded retry budget", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("worker unavailable", { status: 503 }))

    await expect(request(fetchMock as typeof fetch)).rejects.toThrow(
      "bulk import failed: HTTP 503 — worker unavailable after 3 attempts",
    )
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
