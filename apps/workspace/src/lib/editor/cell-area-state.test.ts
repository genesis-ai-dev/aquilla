import { describe, it, expect } from "vitest"
import { deriveCellAreaState } from "./cell-area-state"

describe("deriveCellAreaState", () => {
  // Base input for the common "file is open" case — individual tests override.
  const open = {
    activeFileId: "file-1" as string | null,
    docLoading: false,
    hasDoc: true,
    cellCount: 1,
    syncStatus: "live" as "live" | "connecting" | "offline" | "idle" | "disabled",
  }

  it("returns no-file when nothing is selected", () => {
    expect(deriveCellAreaState({ ...open, activeFileId: null }).kind).toBe("no-file")
  })

  it("returns loading while IDB is still building the Y.Doc", () => {
    expect(deriveCellAreaState({ ...open, docLoading: true, hasDoc: false }).kind).toBe(
      "loading"
    )
  })

  it("returns loading when the doc hasn't been attached yet even if docLoading is false", () => {
    // Edge case: useFileDoc between unmounts sets doc=null and loading=false briefly.
    // Treat that as loading so we don't flash an empty state during a file switch.
    expect(deriveCellAreaState({ ...open, docLoading: false, hasDoc: false }).kind).toBe(
      "loading"
    )
  })

  it("returns syncing-empty when the doc loaded but cloud sync is still in progress", () => {
    // User just opened a file fresh — local IDB had nothing, WS is negotiating.
    // Showing 'ready-empty' here would flash 'No cells' and then flip to populated,
    // which is worse than keeping a skeleton visible.
    expect(
      deriveCellAreaState({ ...open, cellCount: 0, syncStatus: "connecting" }).kind
    ).toBe("syncing-empty")
  })

  it("returns ready-empty when the doc loaded, sync is live, and there are genuinely no cells", () => {
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
    // Once cells exist locally, show them — sync can still be connecting in
    // the background. Status bar surfaces the connection state separately.
    for (const syncStatus of ["connecting", "live", "offline", "idle", "disabled"] as const) {
      expect(
        deriveCellAreaState({ ...open, cellCount: 1, syncStatus }).kind,
        `expected ready for ${syncStatus}`
      ).toBe("ready")
    }
  })
})
