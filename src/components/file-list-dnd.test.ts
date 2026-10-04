// AQU-1647 — the drop decision for the file sidebar, apart from the pointer
// sensor. The component test drives a real drag through these same functions.

import { describe, expect, it } from "vitest"
import type { Active, ClientRect, DroppableContainer, Over } from "@dnd-kit/core"
import {
  corpusPreviewAction,
  previewSidebarGroups,
  resolveSidebarFileDrop,
  sidebarFileCollision,
} from "./file-list-dnd-model"

function active(id: string, group: string, index = 0, acceptsFileTransfer = false): Active {
  return {
    id,
    data: {
      current: {
        group,
        acceptsFileTransfer,
        sortable: { containerId: group, index, items: [id] },
      },
    },
    rect: { current: { initial: null, translated: null } },
  }
}

function fileOver(id: string, group: string, index: number, acceptsFileTransfer = false): Over {
  return {
    id,
    disabled: false,
    rect: box(0, 20),
    data: {
      current: {
        group,
        acceptsFileTransfer,
        sortable: { containerId: group, index, items: [id] },
      },
    },
  }
}

function groupOver(group: string, acceptsFileTransfer = false): Over {
  return {
    id: `sidebar-drop:${group}`,
    disabled: false,
    rect: box(0, 10),
    data: { current: { group, acceptsFileTransfer } },
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

  it("refuses a testament folder", () => {
    expect(resolveSidebarFileDrop(active("episode-2", "Season 1", 1, true), fileOver("genesis", "OT", 0)))
      .toEqual({ kind: "refuse", group: "OT" })
  })

  it("refuses a file dragged out of a testament folder into a custom corpus", () => {
    expect(resolveSidebarFileDrop(active("genesis", "OT", 0), fileOver("pilot", "Season 1", 0, true)))
      .toEqual({ kind: "refuse", group: "Season 1" })
  })

  it("moves a file into another custom corpus at the hovered row", () => {
    expect(resolveSidebarFileDrop(
      active("episode-2", "Season 1", 1, true),
      fileOver("pilot", "Season 2", 0, true),
    )).toEqual({
      kind: "transfer",
      fileId: "episode-2",
      fromGroup: "Season 1",
      toGroup: "Season 2",
      toPosition: 0,
    })
  })

  it("lands after the hovered row when the pointer is in its bottom half", () => {
    const source = active("episode-2", "Season 1", 1, true)
    source.rect.current.translated = box(16, 20)
    const over = fileOver("pilot", "Season 2", 0, true)
    expect(resolveSidebarFileDrop(source, over)).toMatchObject({ kind: "transfer", toPosition: 1 })
  })

  it("joins a custom corpus at the top when the drop is on its header", () => {
    expect(resolveSidebarFileDrop(
      active("episode-2", "Season 1", 1, true),
      groupOver("Season 2", true),
    )).toEqual({
      kind: "transfer",
      fileId: "episode-2",
      fromGroup: "Season 1",
      toGroup: "Season 2",
      toPosition: 0,
    })
  })

  it("refuses a group that does not accept a transfer", () => {
    expect(resolveSidebarFileDrop(active("episode-2", "Season 1", 1), fileOver("pilot", "Season 2", 0)))
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

  it("targets a row in another custom corpus when the pointer is in that group's gap", () => {
    const other = droppable(
      "sidebar-drop:Season 2",
      { group: "Season 2", acceptsFileTransfer: true },
      box(200, 120),
    )
    const pilot = droppable(
      "pilot",
      { group: "Season 2", acceptsFileTransfer: true, sortable: { containerId: "Season 2", index: 0, items: ["pilot", "finale"] } },
      box(228, 40),
    )
    const finale = droppable(
      "finale",
      { group: "Season 2", acceptsFileTransfer: true, sortable: { containerId: "Season 2", index: 1, items: ["pilot", "finale"] } },
      box(280, 40),
    )
    const hits = sidebarFileCollision({
      active: active("episode-1", "Season 1", 0, true),
      collisionRect: box(274, 8),
      droppableRects: new Map([
        [season.id, box(0, 120)],
        [episode.id, box(40, 40)],
        [other.id, box(200, 120)],
        [pilot.id, box(228, 40)],
        [finale.id, box(280, 40)],
      ]),
      droppableContainers: [season, episode, other, pilot, finale],
      pointerCoordinates: { x: 20, y: 276 },
    })
    expect(hits.map((hit) => hit.id)).toEqual(["finale"])
  })

  it("keeps a custom corpus header as the group, above its first row", () => {
    const other = droppable(
      "sidebar-drop:Season 2",
      { group: "Season 2", acceptsFileTransfer: true },
      box(200, 120),
    )
    const pilot = droppable(
      "pilot",
      { group: "Season 2", acceptsFileTransfer: true, sortable: { containerId: "Season 2", index: 0, items: ["pilot"] } },
      box(228, 40),
    )
    const hits = sidebarFileCollision({
      active: active("episode-1", "Season 1", 0, true),
      collisionRect: box(200, 20),
      droppableRects: new Map([
        [season.id, box(0, 120)],
        [episode.id, box(40, 40)],
        [other.id, box(200, 120)],
        [pilot.id, box(228, 40)],
      ]),
      droppableContainers: [season, episode, other, pilot],
      pointerCoordinates: { x: 20, y: 210 },
    })
    expect(hits.map((hit) => hit.id)).toEqual(["sidebar-drop:Season 2"])
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

describe("previewSidebarGroups", () => {
  const files = [
    { id: "a", name: "a", corpusMarker: "Season 1", sortIndex: 0 },
    { id: "b", name: "b", corpusMarker: "Season 1", sortIndex: 1024 },
    { id: "c", name: "c", corpusMarker: "Season 2", sortIndex: 0 },
    { id: "d", name: "d", corpusMarker: "Season 2", sortIndex: 1024 },
  ]

  it("shows the file in the other corpus at the slot the pointer is over", () => {
    const groups = previewSidebarGroups(
      files,
      { fileId: "a", toGroup: "Season 2", toPosition: 1 },
      "Season 1",
    )
    expect(groups.map((group) => [group.label, group.files.map((file) => file.id)])).toEqual([
      ["Season 1", ["b"]],
      ["Season 2", ["c", "a", "d"]],
    ])
  })

  it("keeps an emptied corpus on screen so the file can come back", () => {
    const groups = previewSidebarGroups(
      [
        { id: "only", name: "only", corpusMarker: "Season 1", sortIndex: 0 },
        { id: "pilot", name: "pilot", corpusMarker: "Season 2", sortIndex: 0 },
      ],
      { fileId: "only", toGroup: "Season 2", toPosition: 0 },
      "Season 1",
    )
    expect(groups.map((group) => [group.label, group.files.map((file) => file.id)])).toEqual([
      ["Season 1", []],
      ["Season 2", ["only", "pilot"]],
    ])
  })
})

describe("corpusPreviewAction", () => {
  const frame = { top: 200, bottom: 360 }
  const row = { top: 240, bottom: 280 }

  it("follows the pointer once it is inside the corpus being joined", () => {
    expect(corpusPreviewAction("transfer", 250, frame, row)).toBe("set")
  })

  it("holds the gap while the pointer is between corpuses", () => {
    expect(corpusPreviewAction("transfer", 180, frame, row)).toBe("keep")
    expect(corpusPreviewAction("move", 180, frame, row)).toBe("keep")
  })

  it("puts the file back once the pointer is inside its own corpus", () => {
    expect(corpusPreviewAction("move", 250, frame, row)).toBe("clear")
    expect(corpusPreviewAction("cancel", 250, frame, null)).toBe("clear")
  })

  it("keeps the gap when the pointer is on the gap the preview opened", () => {
    expect(corpusPreviewAction("cancel", 250, { top: 0, bottom: 40 }, null)).toBe("keep")
  })

  it("drops the gap when the corpus will not take the file", () => {
    expect(corpusPreviewAction("refuse", 250, frame, row)).toBe("clear")
  })
})
