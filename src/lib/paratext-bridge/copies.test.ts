import { describe, it, expect } from "vitest"
import { copyApp, groupCopies, liveCopy, otherCopies } from "./copies"
import { bridgeStateId } from "./project"
import type { BridgeProject } from "./use-paratext-discovery"

const GUID = "6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d"
const OTHER = "0123456789abcdef0123456789abcdef01234567"

function project(guid: string, path: string): BridgeProject {
  return {
    path, folderName: path.split("/").pop()!, guid, stateId: bridgeStateId(guid, path),
    settings: { guid } as BridgeProject["settings"], utf8: true, access: null, books: [],
  }
}

const P9 = project(GUID, "/Users/me/Paratext9Projects/TPP1")
const P10 = project(GUID, "/Users/me/.paratext-10-studio/projects/Paratext 9 Projects/TPP1")
const ELSE = project(OTHER, "/Users/me/Paratext9Projects/XYZ")

describe("copyApp", () => {
  // The label is what tells the user which app's Send/Receive updates a copy.
  it("names the app from the folder Paratext keeps the copy in", () => {
    expect(copyApp(P9.path)).toBe("paratext")
    expect(copyApp("C:\\My Paratext 9 Projects\\TPP1")).toBe("paratext")
    expect(copyApp(P10.path)).toBe("paratext10")
    expect(copyApp("/Users/me/.platform.bible/projects/Paratext 9 Projects/TPP1")).toBe("paratext10")
    expect(copyApp("/Users/me/Library/Application Support/paratextlite/Paratext8Projects/TPP1")).toBe("lite")
    expect(copyApp("C:\\Users\\me\\AppData\\Roaming\\paratextlite\\Paratext8Projects\\TPP1")).toBe("lite")
    expect(copyApp("/Users/me/.wine-paratext/drive_c/My Paratext 9 Projects/TPP1")).toBe("wine")
  })
})

describe("groupCopies", () => {
  // Two folders with one GUID are one project: listing them twice is the bug.
  it("puts folders with the same GUID in one group, in discovery order", () => {
    const groups = groupCopies([P9, ELSE, P10])
    expect(groups.map((g) => g.copies.map((c) => c.path))).toEqual([[P9.path, P10.path], [ELSE.path]])
  })

  it("matches GUIDs regardless of case", () => {
    const upper = project(GUID.toUpperCase(), "/x/TPP1")
    expect(groupCopies([P9, upper])).toHaveLength(1)
  })

  it("lists the other copies of a project, never the project itself", () => {
    expect(otherCopies(P9, [P9, P10, ELSE]).map((p) => p.path)).toEqual([P10.path])
    expect(otherCopies(ELSE, [P9, P10, ELSE])).toEqual([])
  })
})

describe("liveCopy", () => {
  it("is the linked copy, and none before the project is opened in Aquilla", () => {
    expect(liveCopy([P9, P10], new Set())).toBeNull()
    expect(liveCopy([P9, P10], new Set([P10.stateId]))).toBe(P10)
  })

  // An older version could link both copies; the answer must not flip between renders.
  it("picks the first linked copy when more than one is linked", () => {
    expect(liveCopy([P9, P10], new Set([P10.stateId, P9.stateId]))).toBe(P9)
  })
})
