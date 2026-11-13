import { describe, expect, it, vi } from "vitest"
import { playTrackMove, snapshotTrackMove, trackMoveLanded } from "./track-move-flip"

function row(root: HTMLElement, id: string, top: number, attr = "data-tl-track-id") {
  const node = document.createElement("div")
  node.setAttribute(attr, id)
  let at = top
  vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => ({ top: at } as DOMRect))
  const animate = vi.fn(() => {
    const animation = Object.assign(new EventTarget(), { currentTime: 0 })
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

  it("slides a lane that lands frames after its name, lifted and level with it", () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb))
    const root = document.createElement("div")
    const name = row(root, "a", 100)
    const lane = row(root, "a", 100, "data-tl-track-lane")
    const snapshot = snapshotTrackMove(root, [{ id: "a", groupId: null }])

    name.moveTo(40)
    playTrackMove(root, snapshot)
    expect(name.animate).toHaveBeenCalledTimes(1)
    expect(lane.animate).not.toHaveBeenCalled()

    lane.moveTo(40)
    frames.shift()?.(0)
    expect(lane.animate).toHaveBeenCalledTimes(1)
    const [slide] = lane.animate.mock.calls[0] as unknown as [Keyframe[]]
    expect(slide[0].transform).toBe("translateY(60px)")
    expect(lane.node.hasAttribute("data-tl-lifted")).toBe(true)
    frames.shift()?.(0)
    expect(lane.animate).toHaveBeenCalledTimes(1)
    raf.mockRestore()
  })
})
