// egress-prefs — per-org persistence of Data-egress options. The business
// rules pinned here: options are scoped per org (switching orgs must not leak
// one org's export configuration into another), a fresh org reads null so the
// page can apply DEFAULT_EGRESS_OPTIONS, and writes survive a page reload
// (localStorage round-trip through the module cache).

import { describe, it, expect, beforeEach } from "vitest"
import type { EgressOptions } from "@/lib/egress/types"
import {
  DEFAULT_EGRESS_OPTIONS,
  getEgressPrefs,
  setEgressPrefs,
  _resetEgressPrefsForTests,
} from "./egress-prefs"

const audioOptions: EgressOptions = {
  textMode: "convert",
  convertFormat: "tsv",
  lanes: ["", "es"],
  includeSourceDocs: true,
  audioMode: "voice-timeline",
  useCache: false,
}

beforeEach(() => {
  localStorage.clear()
  _resetEgressPrefsForTests()
})

describe("egress-prefs", () => {
  it("returns null for an org that never saved options, so callers fall back to the defaults", () => {
    expect(getEgressPrefs(1)).toBeNull()
    // The defaults themselves keep the safe/cheap shape: no audio, cache on.
    expect(DEFAULT_EGRESS_OPTIONS.audioMode).toBe("none")
    expect(DEFAULT_EGRESS_OPTIONS.useCache).toBe(true)
    expect(DEFAULT_EGRESS_OPTIONS.lanes).toEqual([""])
  })

  it("round-trips options per org without leaking across orgs", () => {
    setEgressPrefs(1, audioOptions)
    expect(getEgressPrefs(1)).toEqual(audioOptions)
    // Org 2 never saved — it must NOT inherit org 1's audio configuration.
    expect(getEgressPrefs(2)).toBeNull()
  })

  it("persists to localStorage so a reload (fresh module cache) keeps the options", () => {
    setEgressPrefs(7, audioOptions)
    // Simulate a reload: drop the in-memory snapshot cache, keep localStorage.
    _resetEgressPrefsForTests()
    expect(getEgressPrefs(7)).toEqual(audioOptions)
  })

  it("later writes replace the org's options wholesale (no stale key merge)", () => {
    setEgressPrefs(1, audioOptions)
    const next: EgressOptions = { ...DEFAULT_EGRESS_OPTIONS, lanes: ["fr"] }
    setEgressPrefs(1, next)
    expect(getEgressPrefs(1)).toEqual(next)
  })

  it("tolerates corrupted storage by reading as unset instead of throwing", () => {
    localStorage.setItem("aq.egress-prefs.v1", "{not json")
    expect(getEgressPrefs(1)).toBeNull()
  })
})
