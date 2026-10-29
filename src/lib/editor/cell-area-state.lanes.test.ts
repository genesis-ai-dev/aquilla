// AQU-1901: after editor → project page → "Open project", a first-time reader's
// editor showed every translated row as "— empty" until the project's lane
// rows loaded. This walks the same pieces ProjectWorkspace wires together —
// the open lane (useActiveLane), whether it can be named (activeTargetLaneFor),
// the lane-filtered cell store, and the cell-area decision — on a project like
// the adversarial fixture: one target lane tagged "Swahili", no `''` lane.
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { CellStore } from "@/hooks/useActiveCellStore"
import { useActiveLane } from "@/hooks/useActiveLane"
import { activeTargetLaneFor } from "@/hooks/useActiveTargetLane"
import { readPersistedLaneChoice, writePersistedActiveLane, type LaneChoiceRow } from "@/lib/lanes/active-lane-choice"
import { switcherLaneTags } from "@/lib/lanes/switcher-lanes"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { deriveCellAreaState } from "./cell-area-state"

const SWAHILI: LaneChoiceRow = { id: "lane-sw", legacyTag: "Swahili", position: 1, archivedAt: null }
const LEGACY_DEFAULT: LaneChoiceRow = { id: "lane-default", legacyTag: "", position: 1, archivedAt: null }

function row(cellId: string, side: "source" | "target", value: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${cellId}-${over.targetLang ?? ""}`,
    sourceEventId: null,
    lastEditor: "adv-bot-1",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    ...over,
  }
}

/** The first row of the file, as the editor's store shows it on `lane`. */
function firstRowStatus(lane: string, targetLang: string): string | undefined {
  const store = new CellStore()
  store.setRuntime({ projectId: "p1", fileId: "f1", username: "adv-bot-1", requiredValidations: 1, auditStats: new Map(), lane })
  store.replaceRows([
    row("GEN 1:1", "source", "In the beginning"),
    row("GEN 1:1", "target", "Hapo mwanzo", { targetLang }),
  ])
  return store.getCellView("GEN 1:1")?.status
}

/** The editor at the moment the file's rows are on hand: what lane it is
 *  open on, and what the cell area renders. */
function editorAt(laneRows: readonly LaneChoiceRow[] | null, settingsFetched: boolean) {
  const { result } = renderHook(() =>
    useActiveLane({ projectId: "p1", laneRows, availableLanes: switcherLaneTags(laneRows ?? [], [""]) }),
  )
  const activeLane = result.current.activeLane
  const target = activeTargetLaneFor({
    laneRows,
    settingsFetched,
    activeLane,
    stored: readPersistedLaneChoice("p1"),
  })
  const area = deriveCellAreaState({
    activeFileId: "f1",
    cellCount: 1,
    syncStatus: "live",
    cellsLoading: false,
    cellsError: false,
    lanesLoading: target === null,
  })
  return { activeLane, lanesPending: target === null, area }
}

beforeEach(() => {
  localStorage.clear()
})

describe("cell area while the project's lanes load (AQU-1901)", () => {
  it("reproduces the bug: before the lane rows arrive, a first-time reader's rows pair with '' and read empty", () => {
    const editor = editorAt(null, false)
    // The fallback is the legacy default lane, which this project does not have…
    expect(editor.activeLane).toBe("")
    expect(editor.lanesPending).toBe(true)
    // …so the seeded translation is invisible: the row reads "— empty".
    expect(firstRowStatus(editor.activeLane, "Swahili")).toBe("empty")
  })

  it("renders no rows in that window, so nothing reads empty", () => {
    expect(editorAt(null, false).area).toEqual({ kind: "lanes-loading" })
  })

  it("renders the rows once the lanes load, paired with the real lane", () => {
    const editor = editorAt([SWAHILI], true)
    expect(editor.activeLane).toBe("Swahili")
    expect(editor.lanesPending).toBe(false)
    expect(editor.area).toEqual({ kind: "ready" })
    expect(firstRowStatus(editor.activeLane, "Swahili")).toBe("unvalidated")
  })

  it("renders a returning reader's rows at once, from the lane id they last had open", () => {
    writePersistedActiveLane("p1", SWAHILI.id, "Swahili")
    const editor = editorAt(null, false)
    expect(editor.activeLane).toBe("Swahili")
    expect(editor.area).toEqual({ kind: "ready" })
    expect(firstRowStatus(editor.activeLane, "Swahili")).toBe("unvalidated")
  })

  it("keeps a legacy project whose lane really is '' working", () => {
    const editor = editorAt([LEGACY_DEFAULT], true)
    expect(editor.activeLane).toBe("")
    expect(editor.area).toEqual({ kind: "ready" })
    expect(firstRowStatus(editor.activeLane, "")).toBe("unvalidated")
  })

  it("keeps a server that answers without lane rows (pre-AQU-1418) on its tag", () => {
    const editor = editorAt(null, true)
    expect(editor.area).toEqual({ kind: "ready" })
  })
})
