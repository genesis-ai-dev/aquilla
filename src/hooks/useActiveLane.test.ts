// The editor's open lane (AQU-1613) and the "Loading languages…" lock it feeds
// (AQU-1902). The editor may stay read-only only while no lane can be named:
// once the project's lane rows are known, the open lane must be one of them.
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { activeTargetLaneFor } from "./useActiveTargetLane"
import { useActiveLane, type UseActiveLaneInput } from "./useActiveLane"
import {
  activeLaneStorageKey,
  readPersistedLaneChoice,
  type LaneChoiceRow,
} from "@/lib/lanes/active-lane-choice"
import { switcherLaneTags } from "@/lib/lanes/switcher-lanes"

const FR: LaneChoiceRow = { id: "lane-fr", legacyTag: "fr", position: 1, archivedAt: null }
const ES: LaneChoiceRow = { id: "lane-es", legacyTag: "es", position: 2, archivedAt: null }

/** What ProjectWorkspace passes: rows null until the record carries them, and
 *  the switcher's tags (the pre-row list is `['']` with no registry yet). */
function input(laneRows: readonly LaneChoiceRow[] | null, projectId = "p1"): UseActiveLaneInput {
  return { projectId, laneRows, availableLanes: switcherLaneTags(laneRows ?? [], [""]) }
}

function mount(laneRows: readonly LaneChoiceRow[] | null) {
  return renderHook((props: UseActiveLaneInput) => useActiveLane(props), { initialProps: input(laneRows) })
}

/** The editor's write lock for this lane, as ProjectWorkspace derives it. */
function writable(laneRows: readonly LaneChoiceRow[], activeLane: string): boolean {
  return activeTargetLaneFor({ laneRows, settingsFetched: true, activeLane, stored: null }) !== null
}

beforeEach(() => {
  localStorage.clear()
})

describe("useActiveLane: once lane rows are known, a real lane is open", () => {
  it("lands back on the project's lane when its rows drop out and return after the migration", () => {
    // The reimport-preserves-target flake: a reader who never switched lanes,
    // on a project whose only target lane is tagged "fr" (no '' lane).
    const { result, rerender } = mount(null)
    expect(result.current.activeLane).toBe("")

    rerender(input([FR]))
    expect(result.current.activeLane).toBe("fr")

    // The record loses its lane rows for a render (a re-resolve that came back
    // without the project): nothing on screen says the reader's lane is gone.
    rerender(input(null))
    expect(result.current.activeLane).toBe("fr")

    rerender(input([FR]))
    expect(result.current.activeLane).toBe("fr")
    expect(writable([FR], result.current.activeLane)).toBe(true)
  })

  it("leaves '' for a real lane when '' is chosen after the migration ran", () => {
    // jumpToAssignment, or any caller handing over an empty tag.
    const { result, rerender } = mount(null)
    rerender(input([FR]))

    act(() => result.current.setActiveLane(""))
    expect(result.current.activeLane).toBe("fr")
    expect(writable([FR], result.current.activeLane)).toBe(true)
  })

  it("keeps a returning reader's stored lane while the rows load, so writes to it start at once", () => {
    localStorage.setItem(activeLaneStorageKey("p1"), JSON.stringify({ laneId: ES.id, tag: "es" }))
    const { result, rerender } = mount(null)
    expect(result.current.activeLane).toBe("es")
    expect(
      activeTargetLaneFor({
        laneRows: null,
        settingsFetched: false,
        activeLane: result.current.activeLane,
        stored: readPersistedLaneChoice("p1"),
      }),
    ).toEqual({ targetLang: "es", laneId: ES.id })

    rerender(input([FR, ES]))
    expect(result.current.activeLane).toBe("es")
  })

  it("opens a first-time reader on the lane in first position", () => {
    const { result, rerender } = mount(null)
    rerender(input([ES, FR]))
    expect(result.current.activeLane).toBe("fr")
    // The slot stays empty: today's first lane is not pinned behind their back.
    expect(localStorage.getItem(activeLaneStorageKey("p1"))).toBeNull()
  })

  it("keeps a lane the reader switched to across later row updates", () => {
    const { result, rerender } = mount(null)
    rerender(input([FR, ES]))
    act(() => result.current.setActiveLane("es"))
    rerender(input([{ ...FR }, { ...ES }]))
    expect(result.current.activeLane).toBe("es")
    expect(readPersistedLaneChoice("p1").laneId).toBe(ES.id)
  })

  it("falls back to first position when the open lane is removed", () => {
    const { result, rerender } = mount(null)
    rerender(input([FR, ES]))
    act(() => result.current.setActiveLane("es"))

    rerender(input([FR]))
    expect(result.current.activeLane).toBe("fr")
  })

  it("stays on '' where a row really carries that tag, and with no target lane at all", () => {
    const legacyDefault: LaneChoiceRow = { id: "lane-default", legacyTag: "", position: 0, archivedAt: null }
    const withDefault = mount(null)
    withDefault.rerender(input([legacyDefault, FR]))
    expect(withDefault.result.current.activeLane).toBe("")
    expect(writable([legacyDefault, FR], "")).toBe(true)

    const noLanes = mount(null)
    noLanes.rerender(input([]))
    expect(noLanes.result.current.activeLane).toBe("")
    expect(writable([], "")).toBe(true)
  })

  it("lets a deep-linked lane win over the stored choice", () => {
    localStorage.setItem(activeLaneStorageKey("p1"), JSON.stringify({ laneId: FR.id, tag: "fr" }))
    const { result, rerender } = mount(null)
    act(() => {
      result.current.setActiveLane("es")
      result.current.claimLaneChoice()
    })
    rerender(input([FR, ES]))
    expect(result.current.activeLane).toBe("es")
  })

  it("re-reads the stored lane when the project changes", () => {
    localStorage.setItem(activeLaneStorageKey("p2"), JSON.stringify({ laneId: ES.id, tag: "es" }))
    const { result, rerender } = mount(null)
    rerender(input([FR]))
    expect(result.current.activeLane).toBe("fr")

    rerender(input(null, "p2"))
    expect(result.current.activeLane).toBe("es")
    rerender(input([FR, ES], "p2"))
    expect(result.current.activeLane).toBe("es")
  })
})
