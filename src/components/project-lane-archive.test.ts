// AQU-601: pure helpers for the language-lane active/archived split.

import { describe, it, expect } from "vitest"
import {
  isLaneArchived,
  activeLanes,
  archivedRegisteredLanes,
} from "./project-lane-archive"

describe("project-lane-archive", () => {
  describe("isLaneArchived", () => {
    it("is false for the default lane and when nothing is archived", () => {
      expect(isLaneArchived("", ["fr-CA"])).toBe(false)
      expect(isLaneArchived("fr-CA", undefined)).toBe(false)
      expect(isLaneArchived("fr-CA", [])).toBe(false)
    })

    it("matches archived tags case-insensitively", () => {
      expect(isLaneArchived("fr-CA", ["fr-ca"])).toBe(true)
      expect(isLaneArchived("FR-CA", ["fr-CA"])).toBe(true)
      expect(isLaneArchived("fr-BE", ["fr-CA"])).toBe(false)
    })
  })

  describe("activeLanes", () => {
    it("returns all registered lanes when none are archived", () => {
      expect(activeLanes(["fr-CA", "fr-BE"], [])).toEqual(["fr-CA", "fr-BE"])
      expect(activeLanes(["fr-CA", "fr-BE"], undefined)).toEqual(["fr-CA", "fr-BE"])
    })

    it("drops archived lanes but preserves registry order", () => {
      expect(activeLanes(["fr-CA", "fr-BE", "es"], ["fr-BE"])).toEqual(["fr-CA", "es"])
    })
  })

  describe("archivedRegisteredLanes", () => {
    it("returns the archived registered lanes in registry order", () => {
      expect(archivedRegisteredLanes(["fr-CA", "fr-BE", "es"], ["es", "fr-CA"]))
        .toEqual(["fr-CA", "es"])
    })

    it("ignores archived tags that are no longer registered", () => {
      expect(archivedRegisteredLanes(["fr-CA"], ["fr-CA", "gone"])).toEqual(["fr-CA"])
    })

    it("is empty when nothing is archived", () => {
      expect(archivedRegisteredLanes(["fr-CA"], [])).toEqual([])
    })
  })
})
