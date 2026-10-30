// Slice 13 evidence (Oct 27): a step made in Ruth and undone from another file
// said "Open the file it was made in to undo …", because steps recorded
// outside the workspace carry no file name. The workspace now names them from
// the project's files: the file a person opens, never a hidden companion.
import { describe, it, expect } from "vitest"
import { historyFileName } from "./project-workspace-helpers"
import { AUDIO_CUES_ROLE, TIMELINE_CONTENT_ROLE } from "@/lib/parsers/types"

const files = [
  { id: "ruth", name: "Ruth" },
  { id: "ep", name: "TheChosen_101_en_5&2.vtt" },
  { id: "cues", name: "TheChosen_101_en_5&2.vtt · audio cues", role: AUDIO_CUES_ROLE, anchorFileId: "ep" },
  { id: "track", name: "Captions (fr)", role: TIMELINE_CONTENT_ROLE, anchorFileId: "ep" },
  { id: "orphan", name: "lost cues", role: AUDIO_CUES_ROLE },
]

describe("historyFileName (a history step's file, by name)", () => {
  it("names a file the project lists", () => {
    expect(historyFileName(files, "ruth")).toBe("Ruth")
  })

  it("names a hidden companion by the file it is opened through", () => {
    expect(historyFileName(files, "cues")).toBe("TheChosen_101_en_5&2.vtt")
    expect(historyFileName(files, "track")).toBe("TheChosen_101_en_5&2.vtt")
  })

  it("has no name for a file it cannot place", () => {
    expect(historyFileName(files, "orphan")).toBeNull()
    expect(historyFileName(files, "gone")).toBeNull()
  })
})
