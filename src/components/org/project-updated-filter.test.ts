// AQU-1043 — pure last-edit recency filter: fixed windows, never-edited rows
// excluded from every window, and the "any time" default passing everything.

import { describe, it, expect } from "vitest"
import {
  UPDATED_FILTER_ANY,
  UPDATED_FILTER_WINDOW_DAYS,
  filterByUpdated,
  resolveUpdatedFilter,
  updatedFilterFor,
  type UpdatedFilter,
} from "./project-updated-filter"

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 7, 31, 12, 0, 0)

function row(id: string, lastEditAt: number | null) {
  return { id, lastEditAt }
}

const fresh = row("fresh", now - DAY)
const twoWeeks = row("two-weeks", now - 14 * DAY)
const twoMonths = row("two-months", now - 60 * DAY)
const ancient = row("ancient", now - 400 * DAY)
const never = row("never", null)
const all = [fresh, twoWeeks, twoMonths, ancient, never]

function idsIn(filter: UpdatedFilter) {
  return filterByUpdated(all, filter, now).map((p) => p.id)
}

describe("updatedFilterFor / window options", () => {
  it("offers fixed windows, shortest first", () => {
    expect(UPDATED_FILTER_WINDOW_DAYS).toEqual([7, 30, 90])
  })

  it("prefixes the value so a window can never collide with the 'any' sentinel", () => {
    expect(updatedFilterFor(7)).toBe("days:7")
    expect(updatedFilterFor(30)).not.toBe(UPDATED_FILTER_ANY)
  })
})

describe("filterByUpdated", () => {
  it("passes every row — never-edited included — under the 'any time' default", () => {
    expect(idsIn(UPDATED_FILTER_ANY)).toEqual([
      "fresh",
      "two-weeks",
      "two-months",
      "ancient",
      "never",
    ])
  })

  it("keeps only rows edited inside the selected window", () => {
    expect(idsIn(updatedFilterFor(7))).toEqual(["fresh"])
    expect(idsIn(updatedFilterFor(30))).toEqual(["fresh", "two-weeks"])
    expect(idsIn(updatedFilterFor(90))).toEqual(["fresh", "two-weeks", "two-months"])
  })

  it("excludes never-edited rows ('—') from every window", () => {
    for (const days of UPDATED_FILTER_WINDOW_DAYS) {
      expect(idsIn(updatedFilterFor(days))).not.toContain("never")
    }
  })

  it("treats the window edge as inclusive, and one tick past it as outside", () => {
    const onEdge = row("on-edge", now - 7 * DAY)
    const justPast = row("just-past", now - 7 * DAY - 1)
    const rows = [onEdge, justPast]
    expect(filterByUpdated(rows, updatedFilterFor(7), now).map((p) => p.id)).toEqual(["on-edge"])
  })

  it("counts a future stamp (clock skew) as recent, matching what the column shows", () => {
    const skewed = [row("skewed", now + DAY)]
    expect(filterByUpdated(skewed, updatedFilterFor(7), now).map((p) => p.id)).toEqual(["skewed"])
  })

  it("returns a copy rather than the caller's array", () => {
    expect(filterByUpdated(all, UPDATED_FILTER_ANY, now)).not.toBe(all)
  })
})

describe("resolveUpdatedFilter", () => {
  it("keeps the 'any time' sentinel and every offered window", () => {
    expect(resolveUpdatedFilter(UPDATED_FILTER_ANY)).toBe(UPDATED_FILTER_ANY)
    for (const days of UPDATED_FILTER_WINDOW_DAYS) {
      expect(resolveUpdatedFilter(updatedFilterFor(days))).toBe(`days:${days}`)
    }
  })

  it("falls back to 'any time' for a window the control does not offer", () => {
    // A stale or hand-crafted value must not strand the table on an option the
    // Select cannot show — same guard the PM and Role filters carry.
    expect(resolveUpdatedFilter("days:5" as UpdatedFilter)).toBe(UPDATED_FILTER_ANY)
    expect(resolveUpdatedFilter("days:" as UpdatedFilter)).toBe(UPDATED_FILTER_ANY)
    expect(resolveUpdatedFilter("days:nonsense" as UpdatedFilter)).toBe(UPDATED_FILTER_ANY)
  })
})
