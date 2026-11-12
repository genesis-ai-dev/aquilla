/**
 * AQU-2432 (browser pass, Nov 11): a viewer on a file showing "Viewing as
 * viewer — read only" dragged a take against the empty line before it. The
 * take moved on her screen and stayed there until a reload, nothing was saved,
 * and the page threw an uncaught "InsufficientRoleError: role 100 below
 * required 400 for cell.lane.retime" (a plain move threw it for
 * `cell.audio.place`).
 *
 * The timeline's `editable` is the project's and the lane's (git/local
 * permissions, an archived lane), never the person's role, so a drag started
 * for everyone. The workspace now hands the timeline its move, room and trim
 * callbacks through `timelineTakeDrags`, which passes each only to someone who
 * can save it (`canPerform`). These render a takes row with exactly what that
 * gate hands it, for each role, and pin that the workspace uses it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
vi.mock("@/lib/audio/transport-pause", () => ({ pauseAllTransports: vi.fn() }))

import { timelineTakeDrags } from "./project-workspace-helpers"
import { TargetAudioLane, type TargetAudioItem } from "./timeline/TargetAudioLane"
import { buildTimelineLayout } from "@/lib/timeline/layout"
import { ROLE } from "@/lib/sync/role-policy"
import type { CellData } from "@/hooks/useCells"

const PX = 40
const takeId = (id: string) => `audio-${id}-1700000000-take.wav`
function bookLine(id: string, takeMs?: number): CellData {
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(takeMs != null ? { selectedAudioId: takeId(id) } : {}),
    attachments: takeMs != null ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: takeMs } } : {},
  } as unknown as CellData
}
/** a: a 5 s take · b: nobody has recorded it · c: a 6 s take. */
const cells = [bookLine("a", 5_000), bookLine("b"), bookLine("c", 6_000)]

/** The takes row as the workspace sets it up for someone at `level`. */
function rowFor(level: number) {
  const drags = { onRetimeTarget: vi.fn(), onMoveTakeRooms: vi.fn(), onTrimTarget: vi.fn() }
  const layout = buildTimelineLayout("audioFirst", cells, cells, null, { standInLenSec: () => 4 })
  const items: TargetAudioItem[] = cells.filter((c) => c.selectedAudioId).map((cell) => ({ cell, kind: "take" as const, audioId: takeId(cell.id) }))
  render(
    <TargetAudioLane
      validationRequirementAudio={1} pxPerSec={PX} viewStartSec={0} viewEndSec={100} selectedId={null}
      editable snapEnabled={false} onSelect={() => {}} layout={layout} items={items}
      emptyCells={cells.filter((c) => !c.selectedAudioId)}
      {...timelineTakeDrags(level, drags)}
    />,
  )
  return drags
}
function dragC(sec: number) {
  const c = screen.getByTestId("tl-target-c")
  const before = c.getAttribute("data-span-start")
  fireEvent.pointerDown(c, { clientX: 400, pointerId: 1 })
  fireEvent.pointerMove(window, { clientX: 400 + sec * PX })
  const during = c.getAttribute("data-span-start")
  fireEvent.pointerUp(window, { clientX: 400 + sec * PX })
  return { before, during }
}

describe("a take is dragged only by someone who can save the drag (AQU-2432)", () => {
  for (const [who, level] of [["a viewer", ROLE.VIEWER], ["a commenter", ROLE.COMMENTER], ["a reviewer", ROLE.REVIEWER]] as const) {
    it(`${who}: the take does not follow the pointer, nothing is handed up, and there are no trim handles`, () => {
      const drags = rowFor(level)
      const { before, during } = dragC(-2)
      expect(during).toBe(before)
      expect(drags.onMoveTakeRooms).not.toHaveBeenCalled()
      expect(drags.onRetimeTarget).not.toHaveBeenCalled()
      expect(screen.queryByTestId("tl-target-c-handle-l")).toBeNull()
    })
  }

  it("a contributor still drags it (against the empty line, its room)", () => {
    const drags = rowFor(ROLE.CONTRIBUTOR)
    const { before, during } = dragC(-2)
    expect(during).not.toBe(before)
    expect(drags.onMoveTakeRooms).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("tl-target-c-handle-l")).not.toBeNull()
  })

  it("the workspace hands the timeline its drag callbacks through that gate, and never bare", () => {
    const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
    const start = source.indexOf("<TimelineEditor")
    const props = source.slice(start, source.indexOf("/>", start))
    expect(props).toMatch(/\{\.\.\.timelineTakeDrags\(project\?\.syncRole\?\.level \?\? null, \{\s*onRetimeTarget: handleRetimeTarget,\s*onMoveTakeRooms: handleMoveTakeRooms,\s*onTrimTarget: handleTrimTarget,\s*\}\)\}/)
    for (const prop of ["onRetimeTarget", "onMoveTakeRooms", "onTrimTarget"]) expect(props).not.toMatch(new RegExp(`\\b${prop}=\\{`))
  })
})
