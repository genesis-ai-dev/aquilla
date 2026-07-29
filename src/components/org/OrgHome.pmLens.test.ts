import { describe, it, expect, beforeEach } from "vitest"
import { sortProjectsByLens, readProjectLens, type PortfolioProjectRow } from "./OrgHome"

// AQU-507: the "Project manager" sort lens and the persisted-lens guard.

function row(
  id: string,
  name: string,
  pm?: { id: number; username: string } | null,
): PortfolioProjectRow {
  return {
    id,
    name,
    totalCells: 0,
    validatedCells: 0,
    filledCells: 0,
    aiDraftedCells: 0,
    lastEditAt: null,
    audioCells: 0,
    validatedAudioCells: 0,
    recordedMs: 0,
    deadlineAt: null,
    // `pm` deliberately omitted when the caller passes undefined → mirrors the
    // "older server / not in the accessible feed" case (field absent).
    ...(pm !== undefined ? { pm } : {}),
  }
}

describe("sortProjectsByLens — pm lens (AQU-507)", () => {
  it("orders by PM username, with unassigned projects last", () => {
    const projects = [
      row("1", "Zed", { id: 9, username: "wendi" }),
      row("2", "Alpha", null), // explicitly unassigned
      row("3", "Beta", { id: 8, username: "anna" }),
      row("4", "Gamma"), // field absent (older server)
    ]
    const sorted = sortProjectsByLens(projects, "pm", 0).map((p) => p.name)
    // anna < wendi by username; both unassigned rows (Alpha, Gamma) fall to the
    // end and tiebreak by name.
    expect(sorted).toEqual(["Beta", "Zed", "Alpha", "Gamma"])
  })

  it("tiebreaks projects sharing a PM by name", () => {
    const pm = { id: 8, username: "anna" }
    const projects = [row("1", "Ruth", pm), row("2", "Job", pm), row("3", "Acts", pm)]
    const sorted = sortProjectsByLens(projects, "pm", 0).map((p) => p.name)
    expect(sorted).toEqual(["Acts", "Job", "Ruth"])
  })

  it("treats an absent pm field the same as null (no crash, sorts last)", () => {
    const projects = [row("1", "NoField"), row("2", "Assigned", { id: 1, username: "anna" })]
    const sorted = sortProjectsByLens(projects, "pm", 0).map((p) => p.name)
    expect(sorted).toEqual(["Assigned", "NoField"])
  })
})

describe("readProjectLens (AQU-507)", () => {
  beforeEach(() => localStorage.clear())

  it("accepts the pm lens once persisted", () => {
    localStorage.setItem("org:all-projects:view", "pm")
    expect(readProjectLens()).toBe("pm")
  })

  it("falls back to the default for an unknown persisted lens", () => {
    localStorage.setItem("org:all-projects:view", "not-a-lens")
    expect(readProjectLens()).toBe("recent")
  })
})
