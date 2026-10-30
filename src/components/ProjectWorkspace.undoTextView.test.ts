import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { resolveTakeLine } from "./project-workspace-helpers"

// Media redesign slice 13, P13.8: undoing a take step from the Text view said
// "what it changed no longer exists" for a take on screen, because the take
// lookup merged only the workspace's audio map, which the Text view never
// loads. The lookup must fall back to the lane's always-loaded read.

function line(id: string): CellData {
  return { id, original: "Ruth 1:6", value: "", metadata: {} } as unknown as CellData
}

function entry(audioId: string, label: string): CellAudioEntry {
  return {
    attachments: { [audioId]: { url: `blob:${audioId}`, label } },
    selectedAudioId: audioId,
  } as unknown as CellAudioEntry
}

describe("resolveTakeLine (undo from the Text view)", () => {
  const cells = [line("c-1:5"), line("c-1:6")]

  it("finds the take from the lane's read when the workspace map is empty (the Text view)", () => {
    const owner = resolveTakeLine({
      cellId: "c-1:6",
      fileId: "f-ruth",
      cells,
      workspaceAudio: new Map(),
      laneAudio: new Map([["c-1:6", entry("take-2", "Best")]]),
    })
    expect(owner?.fileId).toBe("f-ruth")
    expect(owner?.cell.attachments?.["take-2"]?.label).toBe("Best")
  })

  it("prefers the workspace map when it has the line (the audio lenses)", () => {
    const owner = resolveTakeLine({
      cellId: "c-1:6",
      fileId: "f-ruth",
      cells,
      workspaceAudio: new Map([["c-1:6", entry("take-2", "Fresh")]]),
      laneAudio: new Map([["c-1:6", entry("take-2", "Stale")]]),
    })
    expect(owner?.cell.attachments?.["take-2"]?.label).toBe("Fresh")
  })

  it("returns nothing with no file open or for a line that isn't in the file", () => {
    const audio = new Map([["c-1:6", entry("take-2", "Best")]])
    expect(resolveTakeLine({ cellId: "c-1:6", fileId: null, cells, workspaceAudio: audio, laneAudio: audio })).toBeNull()
    expect(resolveTakeLine({ cellId: "c-9:9", fileId: "f-ruth", cells, workspaceAudio: audio, laneAudio: audio })).toBeNull()
  })
})
