import { describe, it, expect } from "vitest"
import { deriveCellAreaState } from "./cell-area-state"

describe("deriveCellAreaState", () => {
  // Base input for the common "file is open" case — individual tests override.
  const open = {
    activeFileId: "file-1" as string | null,
    cellCount: 1,
    syncStatus: "live" as "live" | "connecting" | "offline" | "idle" | "disabled",
  }

  it("returns no-file when nothing is selected", () => {
    expect(deriveCellAreaState({ ...open, activeFileId: null }).kind).toBe("no-file")
  })

  it("returns syncing-empty when the file is open and cloud sync is still in progress", () => {
    // User just opened a file fresh — WS is negotiating, no cells yet.
    // Showing 'ready-empty' here would flash 'No cells' and then flip to populated,
    // which is worse than keeping a skeleton visible.
    expect(
      deriveCellAreaState({ ...open, cellCount: 0, syncStatus: "connecting" }).kind
    ).toBe("syncing-empty")
  })

  it("returns ready-empty when sync is live and there are genuinely no cells", () => {
    expect(
      deriveCellAreaState({ ...open, cellCount: 0, syncStatus: "live" }).kind
    ).toBe("ready-empty")
  })

  it("returns ready-empty for offline / idle / disabled when cells are empty (no cloud to wait on)", () => {
    for (const syncStatus of ["offline", "idle", "disabled"] as const) {
      expect(
        deriveCellAreaState({ ...open, cellCount: 0, syncStatus }).kind,
        `expected ready-empty for ${syncStatus}`
      ).toBe("ready-empty")
    }
  })

  it("returns ready as soon as any cell is present, regardless of sync state", () => {
    for (const syncStatus of ["connecting", "live", "offline", "idle", "disabled"] as const) {
      expect(
        deriveCellAreaState({ ...open, cellCount: 1, syncStatus }).kind,
        `expected ready for ${syncStatus}`
      ).toBe("ready")
    }
  })
})
