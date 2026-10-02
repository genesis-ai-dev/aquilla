// AQU-1566: the org data-export table lists a project's DOCUMENTS. A dubbing
// import's cue sheet and a caption track's content file are timeline data the
// editor never lists, and the files read the export checks a selection against
// no longer returns them, so offering one would only report it as missing.
import { describe, it, expect, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

const fetchAccessibleProjectsResult = vi.fn()
const getPortfolio = vi.fn()

vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjectsResult: (...a: unknown[]) => fetchAccessibleProjectsResult(...a),
}))
vi.mock("@/lib/frontier/portfolio", () => ({
  getPortfolio: (...a: unknown[]) => getPortfolio(...a),
}))
vi.mock("@/lib/frontier/session-expiry", () => ({ notifySessionExpiredIfCurrent: vi.fn() }))

import { useOrgEgressData } from "./useOrgEgressData"

describe("useOrgEgressData", () => {
  it("AQU-1566: leaves cue sheets and caption tracks out of the export rows", async () => {
    fetchAccessibleProjectsResult.mockResolvedValue({
      ok: true,
      projects: [{
        id: "p1",
        name: "Linked video",
        files: [
          { id: "f-video", name: "Episode", type: "video", cellCount: 0 },
          { id: "f-track", name: "Episode captions", type: "vtt", role: "timeline-content", anchorFileId: "f-video", cellCount: 500 },
          { id: "f-cues", name: "Episode audio cues", type: "vtt", role: "audio-cues", anchorFileId: "f-video", cellCount: 40 },
          { id: "f-doc", name: "Script", type: "docx", role: null, cellCount: 12 },
        ],
      }],
    })
    getPortfolio.mockRejectedValue(new Error("offline"))

    const { result } = renderHook(() => useOrgEgressData("jwt", 1))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.rows.map((row) => row.fileId)).toEqual(["f-video", "f-doc"])
  })
})
