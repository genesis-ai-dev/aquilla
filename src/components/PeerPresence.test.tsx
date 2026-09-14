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
})
