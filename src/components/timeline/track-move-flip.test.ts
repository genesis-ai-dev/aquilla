import { describe, expect, it, vi } from "vitest"
import { playTrackMove, snapshotTrackMove, trackMoveLanded } from "./track-move-flip"

function row(root: HTMLElement, id: string, top: number) {
  const node = document.createElement("div")
  node.setAttribute("data-tl-track-id", id)
  let at = top
  vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => ({ top: at } as DOMRect))
  const animate = vi.fn(() => {
    const animation = new EventTarget()
    return animation as unknown as Animation
  })
  node.animate = animate
  root.appendChild(node)
  return { node, animate, moveTo: (next: number) => { at = next } }
}

describe("track-move-flip", () => {
  it("slides a moved track from where it was, lifted, and fades in a row the move created", () => {
    const root = document.createElement("div")
    const moved = row(root, "a", 100)
    const still = row(root, "b", 10)
    const snapshot = snapshotTrackMove(root, [{ id: "a", groupId: null }])

    expect(trackMoveLanded(snapshot, [{ id: "a", groupId: null }])).toBe(false)
    expect(trackMoveLanded(snapshot, [{ id: "a", groupId: "grp" }])).toBe(true)

    moved.moveTo(40)
    const created = row(root, "grp", 30)
    playTrackMove(root, snapshot)

    expect(moved.animate).toHaveBeenCalledTimes(1)
    const [frames] = moved.animate.mock.calls[0] as unknown as [Keyframe[]]
    expect(frames[0].transform).toBe("translateY(60px)")
    expect(moved.node.style.zIndex).toBe("40")
    expect(still.animate).not.toHaveBeenCalled()
    const [fade] = created.animate.mock.calls[0] as unknown as [Keyframe[]]
    expect(fade[0].opacity).toBe(0)
  })
})
