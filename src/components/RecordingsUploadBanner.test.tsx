// The bulk upload's banner, read from the engine's store.
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import type { BulkUploadState } from "@/lib/audio/bulk-upload/engine"

let state: BulkUploadState | null = null
vi.mock("@/lib/audio/bulk-upload/engine", () => ({
  useBulkUploadState: () => state,
  cancelBulkUpload: vi.fn(),
  dismissBulkUpload: vi.fn(),
  retryFailedBulkUploads: vi.fn(),
}))

import { RecordingsUploadBanner } from "./RecordingsUploadBanner"

const finished = (extra: Partial<BulkUploadState>): BulkUploadState => ({
  total: 3, done: 3, failed: [], notStarted: 0, cancelled: false, waitingForConnection: false,
  finished: true, startedAt: 0, finishedAt: 1, takes: [], ...extra,
})

// Sam, Oct 29 (question 5): two files for one line upload as takes, and the
// summary says so, e.g. "2 takes on Genesis 1:1".
describe("RecordingsUploadBanner: lines given several takes", () => {
  it("names the line and how many takes it got", () => {
    state = finished({ takes: [{ target: "Genesis 1:1", count: 2 }] })
    render(<RecordingsUploadBanner />)
    expect(screen.getByTestId("recordings-banner-text").textContent).toBe("3 recordings uploaded. 2 takes on Genesis 1:1.")
  })

  it("lists a few lines, then how many more", () => {
    state = finished({
      total: 10, done: 10,
      takes: ["1:1", "1:2", "1:3", "1:4", "1:5"].map((v) => ({ target: `Genesis ${v}`, count: 2 })),
    })
    render(<RecordingsUploadBanner />)
    expect(screen.getByTestId("recordings-banner-text").textContent).toBe(
      "10 recordings uploaded. 2 takes on Genesis 1:1, 2 takes on Genesis 1:2, 2 takes on Genesis 1:3, and 2 more lines.",
    )
  })

  it("says nothing more when every line got one take", () => {
    state = finished({})
    render(<RecordingsUploadBanner />)
    expect(screen.getByTestId("recordings-banner-text").textContent).toBe("3 recordings uploaded.")
  })
})
