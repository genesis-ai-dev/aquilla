import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PeerPresence } from "./PeerPresence"
import { act } from "react"
import { createProjectPresenceStore, type ProjectPresencePeer } from "@/lib/sync/presence-store"

const alice: ProjectPresencePeer = {
  peerId: "alice",
  username: "alice",
  color: "#3b82f6",
  currentFileId: "file-1",
  focusedCell: "cell-1",
  isEditing: true,
  lastSeenAt: 1,
}

describe("PeerPresence", () => {
  it("renders project peers and jumps to a located peer", () => {
    const onJumpToPeer = vi.fn()
    render(<PeerPresence peers={[alice]} onJumpToPeer={onJumpToPeer} />)

    fireEvent.click(screen.getByRole("button", { name: /alice/i }))
    const popover = screen.getByLabelText("1 online")

    fireEvent.click(within(popover).getByRole("button", { name: /alice editing/i }))

    expect(onJumpToPeer).toHaveBeenCalledWith(alice)
  })

  it("portals the collaborator list outside clipped workspace chrome", () => {
    render(
      <div data-testid="clipped-shell" style={{ overflow: "hidden" }}>
        <PeerPresence peers={[alice]} />
      </div>,
    )

    fireEvent.click(screen.getByRole("button", { name: /alice/i }))

    const shell = screen.getByTestId("clipped-shell")
    const popover = screen.getByLabelText("1 online")
    expect(shell).not.toContainElement(popover)
    expect(document.body).toContainElement(popover)
  })

  // WS-D: the component subscribes to the roster itself so the workspace root
  // no longer re-renders on every presence frame. Store path must render the
  // same chrome as the prop path and track roster changes live.
  it("renders the same roster from a store and follows presence diffs", () => {
    const store = createProjectPresenceStore("me")
    const onJumpToPeer = vi.fn()
    const { container } = render(<PeerPresence store={store} onJumpToPeer={onJumpToPeer} />)
    expect(container).toBeEmptyDOMElement()

    act(() => {
      store.applyPresenceDiff({
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        ts: 1,
      })
    })

    fireEvent.click(screen.getByRole("button", { name: /alice/i }))
    const popover = screen.getByLabelText("1 online")
    fireEvent.click(within(popover).getByRole("button", { name: /alice editing/i }))
    expect(onJumpToPeer).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: "alice", focusedCell: "cell-1" }),
    )

    act(() => {
      store.applyPresenceLeft("alice")
    })
    expect(screen.queryByRole("button", { name: /alice/i })).toBeNull()
  })

  // AQU-1791: the field reports were one colleague appearing 2–3× as
  // "viewing" from a single tab. The roster is per person: extra connections
  // read as a count on the one row, never as extra rows.
  it("renders one row per user with a connection count, not a row per connection", () => {
    const store = createProjectPresenceStore("me")
    store.setSelfConnId("my-tab")
    render(<PeerPresence store={store} />)

    act(() => {
      store.applyPresenceFrame([
        { connId: "ghost-1", userId: "pmbah", currentFileId: "file-1", viewingCell: "cell-1", ts: 1 },
        { connId: "ghost-2", userId: "pmbah", currentFileId: "file-1", viewingCell: "cell-1", ts: 2 },
        { connId: "live-3", userId: "pmbah", currentFileId: "file-1", focusedCell: "cell-4", ts: 3 },
      ])
    })

    // One person online, not three.
    fireEvent.click(screen.getByRole("button", { name: /pmbah/i }))
    const popover = screen.getByLabelText("1 online")
    const rows = within(popover).getAllByRole("button")
    expect(rows).toHaveLength(1)
    // Strongest state wins, and the other two connections show as a count.
    expect(rows[0]).toHaveAccessibleName(/pmbah/i)
    expect(rows[0]).toHaveAccessibleName(/×3/)
    expect(rows[0]).toHaveAccessibleName(/editing/i)
  })
})
