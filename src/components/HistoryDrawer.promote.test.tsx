// "Never lose user data" (AQU-1154): an edit that lost the server's head
// compare-and-swap is still real work. The drawer must (a) show it as a
// bumped entry rather than hiding or striking it, and (b) offer "Promote to
// current", handing the *stale entry itself* (its value) to `onPromote` so
// the workspace can re-emit it chained on the current head.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { HistoryDrawer } from "./HistoryDrawer"
import type { CellData } from "@/hooks/useCells"
import type { CellHistoryEntry } from "@/lib/parsers/types"

vi.mock("@/hooks/useCellEditHistory", () => ({
  useCellEditHistory: vi.fn(),
}))

import { useCellEditHistory } from "@/hooks/useCellEditHistory"

const mockHook = vi.mocked(useCellEditHistory)

// Same entries the hook produces for the AQU-1154 scenario (see
// useCellEditHistory.test.tsx): A2 is the head, B2 lost the CAS.
const A2: CellHistoryEntry = {
  timestamp: "2026-07-01T10:00:05.000Z",
  value: "A2",
  source: "human",
  author: "alice",
  validated: false,
  eventId: "evt-A2",
  isStale: false,
}
const B2: CellHistoryEntry = {
  timestamp: "2026-07-01T10:00:04.000Z",
  value: "B2",
  source: "human",
  author: "bob",
  validated: false,
  eventId: "evt-B2",
  isStale: true,
}

// An older on-chain (non-stale) version of the same cell. Distinct enough
// from A2 (different author, >2 min earlier) that grouping keeps it separate.
const A1: CellHistoryEntry = {
  timestamp: "2026-07-01T09:50:00.000Z",
  value: "A1",
  source: "human",
  author: "carol",
  validated: false,
  eventId: "evt-A1",
  isStale: false,
}

const CELL = {
  id: "c1",
  fileId: "f1",
  original: "source text",
  translated: "A2",
  targetEventId: "evt-A2",
  history: [],
} as unknown as CellData

beforeEach(() => {
  vi.clearAllMocks()
  mockHook.mockReturnValue({ history: [A2, B2], isLoading: false, isError: false, revalidate: vi.fn() })
})

describe("HistoryDrawer bumped (stale-branch) entry", () => {
  it("shows the bumped marker on the stale entry and promotes that entry", () => {
    const onPromote = vi.fn()
    render(
      <HistoryDrawer
        cell={CELL}
        onClose={vi.fn()}
        projectId="p1"
        fileId="f1"
        getTokenForFile={async () => "token"}
        isSynced
        onPromote={onPromote}
      />,
    )

    // The bumped value is still on screen — not dropped, not struck out.
    const bumpedValue = screen.getByText("B2")
    const bumpedItem = bumpedValue.closest("li")!
    expect(bumpedItem).toHaveTextContent("· bumped by a concurrent edit")
    expect(bumpedItem).toHaveTextContent("stale branch")
    // The head is the current entry, and carries no promote affordance.
    const headItem = screen.getByText("A2").closest("li")!
    expect(headItem).toHaveTextContent("· current")
    expect(headItem).not.toHaveTextContent("Promote to current")

    // Promote is a two-step confirm; it hands back the stale entry.
    fireEvent.click(screen.getByRole("button", { name: "Promote to current" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
    expect(onPromote).toHaveBeenCalledTimes(1)
    expect(onPromote).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt-B2", value: "B2", isStale: true }))
  })

  it("offers no promote action without an onPromote handler", () => {
    render(
      <HistoryDrawer
        cell={CELL}
        onClose={vi.fn()}
        projectId="p1"
        fileId="f1"
        getTokenForFile={async () => "token"}
        isSynced
      />,
    )
    expect(screen.getByText("B2").closest("li")).toHaveTextContent("· bumped by a concurrent edit")
    expect(screen.queryByRole("button", { name: "Promote to current" })).toBeNull()
  })
})

// AQU-1159: restoring is not only for bumped edits. Any older version a user
// can see in the drawer is a value they may want back, and getting it back
// must not require retyping it.
describe("HistoryDrawer older on-chain entry", () => {
  it("offers Restore on an older version, not on the current one, and hands back that entry", () => {
    mockHook.mockReturnValue({ history: [A1, A2], isLoading: false, isError: false, revalidate: vi.fn() })
    const onPromote = vi.fn()
    render(
      <HistoryDrawer
        cell={CELL}
        onClose={vi.fn()}
        projectId="p1"
        fileId="f1"
        getTokenForFile={async () => "token"}
        isSynced
        onPromote={onPromote}
      />,
    )

    const olderItem = screen.getByText("A1").closest("li")!
    // An ordinary older version is not a warning: no stale wording.
    expect(olderItem).not.toHaveTextContent("bumped by a concurrent edit")
    expect(olderItem).not.toHaveTextContent("Promote to current")
    expect(olderItem).toHaveTextContent("Restore this version")

    const headItem = screen.getByText("A2").closest("li")!
    expect(headItem).toHaveTextContent("· current")
    expect(headItem).not.toHaveTextContent("Restore this version")
    expect(headItem).not.toHaveTextContent("Promote to current")

    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }))
    expect(olderItem).toHaveTextContent("Replace the current text with this version?")
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
    expect(onPromote).toHaveBeenCalledTimes(1)
    expect(onPromote).toHaveBeenCalledWith(expect.objectContaining({ eventId: "evt-A1", value: "A1" }))
  })

  it("offers no restore on an unsynced (pending) older entry", () => {
    mockHook.mockReturnValue({
      history: [{ ...A1, syncState: "pending" }, A2],
      isLoading: false,
      isError: false,
      revalidate: vi.fn(),
    })
    render(
      <HistoryDrawer
        cell={CELL}
        onClose={vi.fn()}
        projectId="p1"
        fileId="f1"
        getTokenForFile={async () => "token"}
        isSynced
        onPromote={vi.fn()}
      />,
    )
    expect(screen.getByText("A1").closest("li")).not.toHaveTextContent("Restore this version")
  })
})
