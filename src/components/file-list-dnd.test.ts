// AQU-1647 — the drop decision for the file sidebar, apart from the pointer
// sensor. The component test drives a real drag through these same functions.

import { describe, expect, it } from "vitest"
import type { Active, ClientRect, DroppableContainer, Over } from "@dnd-kit/core"
import { resolveSidebarFileDrop, sidebarFileCollision } from "./file-list-dnd-model"

function active(id: string, group: string, index = 0): Active {
  return {
    id,
    data: {
      current: {
        group,
        sortable: { containerId: group, index, items: [id] },
      },
    },
    rect: { current: { initial: null, translated: null } },
  }
}

function fileOver(id: string, group: string, index: number): Over {
  return {
    id,
    disabled: false,
    rect: box(0, 10),
    data: {
      current: {
        group,
        sortable: { containerId: group, index, items: [id] },
      },
    },
  }
}

function groupOver(group: string): Over {
  return {
    id: `sidebar-drop:${group}`,
    disabled: false,
    rect: box(0, 10),
    data: { current: { group } },
  }
}

function box(top: number, height: number, left = 0, width = 120): ClientRect {
  return { top, left, width, height, right: left + width, bottom: top + height }
}

function droppable(id: string, data: object, rect: ClientRect): DroppableContainer {
  return {
    id,
    key: id,
    disabled: false,
    data: { current: data },
    node: { current: null },
    rect: { current: rect },
  }
}

describe("resolveSidebarFileDrop", () => {
  it("takes the hovered row's slot inside the same group", () => {
    expect(resolveSidebarFileDrop(active("episode-10", "Season 1", 3), fileOver("episode-2", "Season 1", 1)))
      .toEqual({ kind: "move", fileId: "episode-10", group: "Season 1", toPosition: 1 })
  })

  it("cancels a drop back onto the dragged row", () => {
    expect(resolveSidebarFileDrop(active("episode-2", "Season 1", 1), fileOver("episode-2", "Season 1", 1)))
      .toEqual({ kind: "cancel" })
  })

  it("refuses a row in another group", () => {
    expect(resolveSidebarFileDrop(active("episode-2", "Season 1", 1), fileOver("pilot", "Season 2", 0)))
      .toEqual({ kind: "refuse", group: "Season 2" })
  })

  it("refuses the other group's header, where there is no row", () => {
    expect(resolveSidebarFileDrop(active("episode-2", "Season 1", 1), groupOver("Season 2")))
      .toEqual({ kind: "refuse", group: "Season 2" })
  })

  it("cancels a drop on the dragged file's own group header", () => {
    expect(resolveSidebarFileDrop(active("episode-2", "Season 1", 1), groupOver("Season 1")))
      .toEqual({ kind: "cancel" })
  })
})

describe("sidebarFileCollision", () => {
  const season = droppable("sidebar-drop:Season 1", { group: "Season 1" }, box(0, 120))
  const episode = droppable(
    "episode-2",
    { group: "Season 1", sortable: { containerId: "Season 1", index: 1, items: ["episode-1", "episode-2"] } },
    box(40, 40),
  )

  it("prefers the file row when the pointer is also inside the group", () => {
    const hits = sidebarFileCollision({
      active: active("episode-1", "Season 1"),
      collisionRect: box(40, 40),
      droppableRects: new Map([[season.id, box(0, 120)], [episode.id, box(40, 40)]]),
      droppableContainers: [season, episode],
      pointerCoordinates: { x: 20, y: 55 },
    })
    expect(hits.map((hit) => hit.id)).toEqual(["episode-2"])
  })

  it("keeps the group when the pointer is in the header, not on a row", () => {
    const hits = sidebarFileCollision({
      active: active("episode-1", "Season 1"),
      collisionRect: box(0, 20),
      droppableRects: new Map([[season.id, box(0, 120)], [episode.id, box(40, 40)]]),
      droppableContainers: [season, episode],
      pointerCoordinates: { x: 20, y: 10 },
    })
    expect(hits.map((hit) => hit.id)).toEqual(["sidebar-drop:Season 1"])
  })

  it("keeps sorting when the pointer is in the gap between two rows", () => {
    const later = droppable(
      "episode-3",
      { group: "Season 1", sortable: { containerId: "Season 1", index: 2, items: ["episode-1", "episode-2", "episode-3"] } },
      box(84, 40),
    )
    const hits = sidebarFileCollision({
      active: active("episode-1", "Season 1"),
      collisionRect: box(78, 12),
      droppableRects: new Map([
        [season.id, box(0, 140)],
        [episode.id, box(40, 40)],
        [later.id, box(84, 40)],
      ]),
      droppableContainers: [season, episode, later],
      pointerCoordinates: { x: 20, y: 82 },
    })
    expect(hits.map((hit) => hit.id)).toEqual(["episode-3"])
  })

  it("follows the row when the pointer has drifted off the sidebar", () => {
    const hits = sidebarFileCollision({
      active: active("episode-1", "Season 1"),
      collisionRect: box(40, 40),
      droppableRects: new Map([[season.id, box(0, 120)], [episode.id, box(40, 40)]]),
      droppableContainers: [season, episode],
      pointerCoordinates: { x: -30, y: 55 },
    })
    expect(hits.map((hit) => hit.id)).toEqual(["episode-2"])
  })

  it("refuses from the other group's header instead of snapping back", () => {
    const other = droppable("sidebar-drop:Season 2", { group: "Season 2" }, box(200, 80))
    const hits = sidebarFileCollision({
      active: active("episode-1", "Season 1"),
      collisionRect: box(200, 20),
      droppableRects: new Map([
        [season.id, box(0, 120)],
        [episode.id, box(40, 40)],
        [other.id, box(200, 80)],
      ]),
      droppableContainers: [season, episode, other],
      pointerCoordinates: { x: 20, y: 210 },
    })
    expect(hits.map((hit) => hit.id)).toEqual(["sidebar-drop:Season 2"])
  })
})
