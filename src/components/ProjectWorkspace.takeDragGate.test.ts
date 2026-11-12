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
 * for everyone. The gate is the workspace's usual one for the timeline: don't
 * pass the callback to someone who cannot save what it writes, asked with
 * `canPerform` like every other write here. Without the callback the take's
 * chip never becomes draggable (TargetAudioLane `canMove` / `canResize`).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { canPerform, ROLE } from "@/lib/sync/role-policy"

const source = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")

/** The props handed to the timeline, from its opening tag to the first `/>`. */
function timelineProps(): string {
  const start = source.indexOf("<TimelineEditor")
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf("/>", start)
  return source.slice(start, end)
}

const GATED = [
  ["onRetimeTarget", "cell.audio.place", "handleRetimeTarget"],
  ["onMoveTakeRooms", "cell.lane.retime", "handleMoveTakeRooms"],
  ["onTrimTarget", "cell.audio.trim", "handleTrimTarget"],
] as const

describe("a take is dragged only by someone who can save the drag (AQU-2432)", () => {
  it("the timeline gets the move, room and trim callbacks only when the person may write their events", () => {
    const props = timelineProps()
    for (const [prop, kind, handler] of GATED) {
      expect(props, prop).toContain(
        `${prop}={canPerform("${kind}", project?.syncRole?.level ?? null) ? ${handler} : undefined}`,
      )
      expect(props, `${prop} passed without the gate`).not.toContain(`${prop}={${handler}}`)
    }
  })

  it("those writes need Contributor: a viewer, a commenter and a reviewer get no drag", () => {
    for (const [, kind] of GATED) {
      for (const below of [ROLE.VIEWER, ROLE.COMMENTER, ROLE.REVIEWER]) expect(canPerform(kind, below), `${kind} at ${below}`).toBe(false)
      expect(canPerform(kind, ROLE.CONTRIBUTOR), kind).toBe(true)
    }
  })
})
