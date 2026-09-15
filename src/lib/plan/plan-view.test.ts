// AQU-1096: the two view preferences, and the reasons they are scoped apart.
import { describe, it, expect, beforeEach } from "vitest"
import {
  DEFAULT_PLAN_VIEW,
  loadPlanView,
  savePlanView,
  loadCollapsedGroups,
  saveCollapsedGroups,
  toggleCollapsedGroup,
} from "./plan-view"

beforeEach(() => localStorage.clear())

describe("view mode", () => {
  it("defaults to the status grouping", () => {
    expect(loadPlanView()).toBe(DEFAULT_PLAN_VIEW)
    expect(DEFAULT_PLAN_VIEW).toBe("status")
  })

  it("round-trips a choice", () => {
    savePlanView("order")
    expect(loadPlanView()).toBe("order")
  })

  it("is global, so it carries between projects", () => {
    // The whole reason it is not project-scoped: reading in order is a working
    // style, and it should not reset when the reader opens another project.
    savePlanView("order")
    expect(loadPlanView()).toBe("order")
  })

  it("falls back to the default on a value it does not recognise", () => {
    localStorage.setItem("aquilla:planView", "sideways")
    expect(loadPlanView()).toBe("status")
  })
})

describe("collapsed groups", () => {
  it("starts with everything expanded", () => {
    expect(loadCollapsedGroups("p1").size).toBe(0)
  })

  it("round-trips a fold", () => {
    saveCollapsedGroups("p1", new Set(["done"]))
    expect([...loadCollapsedGroups("p1")]).toEqual(["done"])
  })

  it("is scoped per project, so one project's folds never hide another's rows", () => {
    saveCollapsedGroups("p1", new Set(["done", "not_started"]))
    expect(loadCollapsedGroups("p2").size).toBe(0)
  })

  it("persists in canonical group order regardless of insertion order", () => {
    saveCollapsedGroups("p1", new Set(["done", "overdue"]))
    expect([...loadCollapsedGroups("p1")]).toEqual(["overdue", "done"])
  })

  it("drops a status it does not recognise rather than throwing", () => {
    // A status retired in a later release must not blank the board for
    // someone who happened to have folded it.
    localStorage.setItem("aquilla:planGroups:p1", JSON.stringify(["done", "retired"]))
    expect([...loadCollapsedGroups("p1")]).toEqual(["done"])
  })

  it("survives a corrupt stored value", () => {
    localStorage.setItem("aquilla:planGroups:p1", "{not json")
    expect(loadCollapsedGroups("p1").size).toBe(0)
  })

  it("reads and writes nothing without a project id", () => {
    saveCollapsedGroups(null, new Set(["done"]))
    expect(loadCollapsedGroups(null).size).toBe(0)
  })

  it("toggles without mutating the set it was given", () => {
    const before = new Set(["done"] as const)
    const after = toggleCollapsedGroup(before, "overdue")
    expect([...before]).toEqual(["done"])
    expect(after.has("overdue")).toBe(true)
    expect(toggleCollapsedGroup(after, "done").has("done")).toBe(false)
  })
})
