// The bulk upload's banner, read from the engine's store.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { BulkUploadState } from "@/lib/audio/bulk-upload/engine"

let state: BulkUploadState | null = null
vi.mock("@/lib/audio/bulk-upload/engine", () => ({
  useBulkUploadState: () => state,
  cancelBulkUpload: vi.fn(),
  dismissBulkUpload: vi.fn(),
  retryFailedBulkUploads: vi.fn(),
}))

import { RecordingsUploadBanner } from "./RecordingsUploadBanner"
import { Toaster } from "@/components/ui/toast"

function renderBanner(props: { evenOutTrack?: () => void } = {}) {
  return render(
    <>
      <Toaster />
      <RecordingsUploadBanner {...props} />
    </>,
  )
}

const finished = (extra: Partial<BulkUploadState>): BulkUploadState => ({
  total: 3, done: 3, failed: [], notStarted: 0, cancelled: false, waitingForConnection: false,
  finished: true, startedAt: 0, finishedAt: 1, takes: [], ...extra,
})

// Sam, Oct 29 (question 5): two files for one line upload as takes, and the
// summary says so, e.g. "2 takes on Genesis 1:1".
describe("RecordingsUploadBanner: lines given several takes", () => {
  it("names the line and how many takes it got", () => {
    state = finished({ takes: [{ target: "Genesis 1:1", count: 2 }] })
    renderBanner()
    expect(screen.getByTestId("recordings-banner-text").textContent).toBe("3 recordings uploaded. 2 takes on Genesis 1:1.")
  })

  it("lists a few lines, then how many more", () => {
    state = finished({
      total: 10, done: 10,
      takes: ["1:1", "1:2", "1:3", "1:4", "1:5"].map((v) => ({ target: `Genesis ${v}`, count: 2 })),
    })
    renderBanner()
    expect(screen.getByTestId("recordings-banner-text").textContent).toBe(
      "10 recordings uploaded. 2 takes on Genesis 1:1, 2 takes on Genesis 1:2, 2 takes on Genesis 1:3, and 2 more lines.",
    )
  })

  it("says nothing more when every line got one take", () => {
    state = finished({})
    renderBanner()
    expect(screen.getByTestId("recordings-banner-text").textContent).toBe("3 recordings uploaded.")
  })
})

// The Oct 29 review: a verse in three parts that fails is one failure but
// three files, and the counts are files.
describe("RecordingsUploadBanner: counts files, not failures", () => {
  const failure = (files: number) => ({ index: 0, name: "a.wav", target: "Genesis 1:1", code: "refused" as const, message: "no", files })

  it("a failed verse in three parts counts three files in the summary", () => {
    state = finished({ total: 10, done: 7, failed: [failure(3)] })
    renderBanner()
    expect(screen.getByTestId("recordings-banner-text").textContent).toContain("3 of 10")
  })

  it("the bar reaches its end when every file has landed or failed", () => {
    state = { ...finished({ total: 10, done: 7, failed: [failure(3)] }), finished: false }
    renderBanner()
    expect(screen.getByTestId("recordings-banner-count").textContent).toBe("10/10")
  })
})

// Re-check S2: a bulk upload doesn't even its takes by itself. When the track
// it landed on is evened, its finish says how to bring them in line.
describe("RecordingsUploadBanner: an evened track", () => {
  it("offers to even out the track to match, and opens it", () => {
    state = finished({})
    const evenOutTrack = vi.fn()
    renderBanner({ evenOutTrack })
    fireEvent.click(screen.getByRole("button", { name: "Even out the track to match" }))
    expect(evenOutTrack).toHaveBeenCalledOnce()
  })

  it("offers nothing when nothing landed, or the track isn't evened", () => {
    state = finished({ done: 0 })
    const { unmount } = renderBanner({ evenOutTrack: () => {} })
    expect(screen.queryByRole("button", { name: "Even out the track to match" })).toBeNull()
    unmount()
    state = finished({})
    renderBanner()
    expect(screen.queryByRole("button", { name: "Even out the track to match" })).toBeNull()
  })
})
