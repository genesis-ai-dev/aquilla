import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PeerPresence } from "./PeerPresence"
import type { ProjectPresencePeer } from "@/lib/sync/presence-store"

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
    const list = screen.getByText("Online (1)").closest("div")?.parentElement
    expect(list).not.toBeNull()
    const popover = list as HTMLElement

    fireEvent.click(within(popover).getByRole("button", { name: /alice editing/i }))

    expect(onJumpToPeer).toHaveBeenCalledWith(alice)
  })
})
