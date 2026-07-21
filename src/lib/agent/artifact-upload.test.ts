/**
 * artifact-upload.test.ts — the composer attach-file client (AQU-AGENT Wave-2).
 * WHY: the run request only helps the agent if the upload actually lands an
 * artifact and returns its id. These tests pin the request shape (raw bytes,
 * encoded name header, Bearer JWT), the client-side size gate (no wasted
 * round-trip on an oversize file), and that a server error surfaces as a typed
 * ArtifactUploadError rather than a silent success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ArtifactUploadError, MAX_AGENT_ARTIFACT_BYTES, uploadAgentArtifact } from "./artifact-upload"

const JWT = "jwt-token"
const PROJECT_ID = "proj-1"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("uploadAgentArtifact", () => {
  it("POSTs raw bytes with the encoded name + Bearer JWT and returns the artifact", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ artifactId: "art-1", fileName: "ignored", sizeBytes: 5, sha256: "abc" }, 201),
    )
    const file = new File(["hello"], "my file, v2.csv", { type: "text/csv" })

    const out = await uploadAgentArtifact(JWT, PROJECT_ID, file)

    expect(out.artifactId).toBe("art-1")
    // The File's own name wins for display (not the server echo).
    expect(out.fileName).toBe("my file, v2.csv")

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain(`/api/v2/projects/${PROJECT_ID}/agent-artifacts`)
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${JWT}`)
    // Name is percent-encoded so the comma/space stay a valid header token.
    expect(headers["x-artifact-name"]).toBe(encodeURIComponent("my file, v2.csv"))
    expect(headers["Content-Type"]).toBe("text/csv")
    expect(init.body).toBe(file)
  })

  it("rejects an empty file before any request", async () => {
    const file = new File([], "empty.txt")
    await expect(uploadAgentArtifact(JWT, PROJECT_ID, file)).rejects.toBeInstanceOf(ArtifactUploadError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects an oversize file client-side (no round-trip)", async () => {
    const file = new File(["x"], "big.bin")
    Object.defineProperty(file, "size", { value: MAX_AGENT_ARTIFACT_BYTES + 1 })
    await expect(uploadAgentArtifact(JWT, PROJECT_ID, file)).rejects.toBeInstanceOf(ArtifactUploadError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("surfaces a server error message as a typed ArtifactUploadError", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: "permission_denied", message: "need contributor" } }, 403),
    )
    const file = new File(["data"], "f.txt")
    await expect(uploadAgentArtifact(JWT, PROJECT_ID, file)).rejects.toMatchObject({
      name: "ArtifactUploadError",
      status: 403,
      message: "need contributor",
    })
  })
})
