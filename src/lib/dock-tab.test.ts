import { describe, it, expect, beforeEach } from "vitest"
import { readLastDockTab, writeLastDockTab } from "./dock-tab"

const PROJECT_ID = "project-1"
const STORAGE_KEY = `aquilla:dockTab:${PROJECT_ID}`

beforeEach(() => {
  localStorage.clear()
})

describe("dock-tab", () => {
  it("defaults to files when unset", () => {
    expect(readLastDockTab(PROJECT_ID)).toBe("files")
  })

  it("defaults to files for an empty project id", () => {
    expect(readLastDockTab("")).toBe("files")
  })

  it("persists and restores a tab", () => {
    writeLastDockTab(PROJECT_ID, "voices")
    expect(readLastDockTab(PROJECT_ID)).toBe("voices")
    expect(localStorage.getItem(STORAGE_KEY)).toBe("voices")
  })

  it("ignores unknown stored values", () => {
    localStorage.setItem(STORAGE_KEY, "nope")
    expect(readLastDockTab(PROJECT_ID)).toBe("files")
  })

  it("keeps projects isolated", () => {
    writeLastDockTab("a", "search")
    writeLastDockTab("b", "agent")
    expect(readLastDockTab("a")).toBe("search")
    expect(readLastDockTab("b")).toBe("agent")
  })
})
