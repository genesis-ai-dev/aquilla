import { describe, expect, it } from "vitest"
import { filterSettingsToVisibleLanes, restoreHiddenLaneSettings } from "./read-wall"
import {
  filterLaneChecksToVisibleLanes,
  filterRulesToVisibleLanes,
  laneTagVisible,
  restoreHiddenLaneChecks,
  restoreHiddenLaneRules,
  ruleLaneHidden,
} from "./checks-wall"

// Spanish is granted; the default lane, German and Italian are not. "pt" names
// no lane at all.
const lanes = [
  { id: "ln-main", name: "French", legacyTag: "" },
  { id: "ln-de", name: "German", legacyTag: "de" },
  { id: "ln-es", name: "Spanish", legacyTag: "es" },
  { id: "ln-it", name: "Italian", legacyTag: "it" },
]
const visible = new Set(["ln-es"])

function laneRule(id: string, lane: string) {
  return {
    id,
    name: `rule ${id}`,
    description: "",
    severity: "minor" as const,
    source: "user" as const,
    scope: "lane" as const,
    lane,
    check: { type: "target-forbids", targetPattern: lane },
    enabled: true,
    createdAt: "2026-10-01T00:00:00.000Z",
  }
}

const projectRule = {
  id: "r-project",
  name: "project rule",
  description: "",
  severity: "major" as const,
  source: "user" as const,
  scope: "project" as const,
  check: { type: "target-forbids", targetPattern: "x" },
  enabled: true,
  createdAt: "2026-10-01T00:00:00.000Z",
}

const orgRule = { ...projectRule, id: "r-org", scope: "org" as const }

describe("laneTagVisible (AQU-2205)", () => {
  it("shows a tag only when a granted target lane carries it", () => {
    expect(laneTagVisible("es", visible, lanes)).toBe(true)
    expect(laneTagVisible("de", visible, lanes)).toBe(false)
    expect(laneTagVisible("", visible, lanes)).toBe(false)
    // A tag no current lane carries is a stale language name, so it is hidden.
    expect(laneTagVisible("pt", visible, lanes)).toBe(false)
  })

  it("shows every tag when the caller is unrestricted", () => {
    expect(laneTagVisible("de", null, lanes)).toBe(true)
    expect(laneTagVisible("pt", null, [])).toBe(true)
  })
})

describe("ruleLaneHidden (AQU-2205)", () => {
  it("hides only a lane-scoped rule on a lane the caller cannot see", () => {
    expect(ruleLaneHidden(laneRule("r-de", "de"), visible, lanes)).toBe(true)
    expect(ruleLaneHidden(laneRule("r-es", "es"), visible, lanes)).toBe(false)
    expect(ruleLaneHidden(projectRule, visible, lanes)).toBe(false)
    expect(ruleLaneHidden(orgRule, visible, lanes)).toBe(false)
  })

  it("treats a lane-scoped rule with no lane as the default lane", () => {
    const { lane: _dropped, ...noLane } = laneRule("r-default", "")
    expect(ruleLaneHidden(noLane, visible, lanes)).toBe(true)
    expect(ruleLaneHidden(noLane, new Set(["ln-main"]), lanes)).toBe(false)
  })

  it("leaves a non-object entry alone", () => {
    expect(ruleLaneHidden("junk", visible, lanes)).toBe(false)
    expect(ruleLaneHidden(null, visible, lanes)).toBe(false)
  })
})

describe("filtering the lane-tagged settings keys (AQU-2205)", () => {
  it("drops the hidden lanes' check overrides, keeping the granted one", () => {
    const byLane = {
      "": { "usfm-structure": { enabled: false } },
      de: { "usfm-structure": { enabled: false } },
      es: { "usfm-structure": { enabled: true } },
    }
    expect(filterLaneChecksToVisibleLanes(byLane, visible, lanes)).toEqual({
      es: { "usfm-structure": { enabled: true } },
    })
    expect(filterLaneChecksToVisibleLanes(byLane, null, lanes)).toBe(byLane)
  })

  it("drops lane-scoped rules on hidden lanes and keeps project and org rules", () => {
    const rules = [projectRule, laneRule("r-de", "de"), laneRule("r-es", "es"), orgRule]
    expect(filterRulesToVisibleLanes(rules, visible, lanes)).toEqual([
      projectRule,
      laneRule("r-es", "es"),
      orgRule,
    ])
  })

  it("leaks no hidden lane tag through either key of the whole blob", () => {
    const stored = {
      targetLanguage: "French",
      targetLanes: ["de", "es", "it"],
      algorithmicChecksByLane: {
        de: { "usfm-structure": { enabled: false } },
        es: { "usfm-structure": { enabled: true } },
      },
      rules: [projectRule, laneRule("r-de", "de"), laneRule("r-es", "es")],
    }
    const filtered = filterSettingsToVisibleLanes({ settings: stored }, visible, lanes).settings
    expect(filtered.algorithmicChecksByLane).toEqual({ es: { "usfm-structure": { enabled: true } } })
    expect(filtered.rules).toEqual([projectRule, laneRule("r-es", "es")])
    const json = JSON.stringify(filtered)
    expect(json).not.toContain("\"de\"")
    expect(json).not.toContain("r-de")
    // The stored blob is not mutated.
    expect(Object.keys(stored.algorithmicChecksByLane)).toEqual(["de", "es"])
    expect(stored.rules).toHaveLength(3)
  })

  it("leaves both keys whole for a caller the wall does not restrict", () => {
    const stored = {
      algorithmicChecksByLane: { de: { "usfm-structure": { enabled: false } } },
      rules: [laneRule("r-de", "de")],
    }
    expect(filterSettingsToVisibleLanes({ settings: stored }, null, lanes).settings).toBe(stored)
  })
})

describe("restoring the lane-tagged settings keys on write (AQU-2205)", () => {
  const stored = {
    targetLanguage: "French",
    targetLanes: ["de", "es", "it"],
    algorithmicChecksByLane: {
      de: { "usfm-structure": { enabled: false } },
      es: { "usfm-structure": { enabled: true } },
    },
    rules: [projectRule, laneRule("r-de", "de"), laneRule("r-es", "es")],
    systemPrompt: "Formal.",
  }

  it("turns an echo of the filtered read back into the stored blob exactly", () => {
    // This is the gate the route's diff depends on: a read-modify-write that
    // changed nothing must come back byte-identical, or a project lead's
    // one-key carve-out save is refused as a rules write it never made.
    const echo = filterSettingsToVisibleLanes({ settings: stored }, visible, lanes).settings
    expect(restoreHiddenLaneSettings(stored, echo, visible, lanes)).toEqual({ ok: true, settings: stored })
  })

  it("keeps a hidden lane's overrides when the caller edits its own lane", () => {
    const edited = restoreHiddenLaneChecks(
      stored.algorithmicChecksByLane,
      { es: { "usfm-structure": { enabled: false } } },
      visible,
      lanes,
    )
    expect(edited).toEqual({
      de: { "usfm-structure": { enabled: false } },
      es: { "usfm-structure": { enabled: false } },
    })
  })

  it("lets the caller delete its own lane's overrides but not a hidden lane's", () => {
    expect(restoreHiddenLaneChecks(stored.algorithmicChecksByLane, {}, visible, lanes)).toEqual({
      de: { "usfm-structure": { enabled: false } },
    })
  })

  it("ignores an entry the body pins to a lane it cannot see", () => {
    const sneaked = restoreHiddenLaneChecks(
      stored.algorithmicChecksByLane,
      { es: { "usfm-structure": { enabled: true } }, it: { "usfm-structure": { enabled: false } } },
      visible,
      lanes,
    )
    expect(sneaked).toEqual({
      de: { "usfm-structure": { enabled: false } },
      es: { "usfm-structure": { enabled: true } },
    })
  })

  it("keeps hidden rules in place while the caller adds, edits and deletes its own", () => {
    const added = laneRule("r-new", "es")
    const editedEs = { ...laneRule("r-es", "es"), enabled: false }
    const restored = restoreHiddenLaneRules(stored.rules, [projectRule, editedEs, added], visible, lanes)
    expect(restored).toEqual([projectRule, laneRule("r-de", "de"), editedEs, added])

    // A visible rule the body drops is deleted; the hidden one stays.
    expect(restoreHiddenLaneRules(stored.rules, [], visible, lanes)).toEqual([laneRule("r-de", "de")])
  })

  it("ignores a rule the body pins to a lane it cannot see, or that reuses a hidden rule's id", () => {
    const sneaked = laneRule("r-it", "it")
    expect(restoreHiddenLaneRules(stored.rules, [projectRule, sneaked], visible, lanes)).toEqual([
      projectRule,
      laneRule("r-de", "de"),
    ])
    // Reusing the hidden rule's id does not overwrite it.
    const hijack = { ...laneRule("r-de", "es"), name: "mine" }
    expect(restoreHiddenLaneRules(stored.rules, [hijack], visible, lanes)).toEqual([laneRule("r-de", "de")])
  })

  it("leaves the body alone when the stored row hides nothing", () => {
    const open = {
      algorithmicChecksByLane: { es: { "usfm-structure": { enabled: true } } },
      rules: [projectRule, laneRule("r-es", "es")],
    }
    expect(restoreHiddenLaneChecks(open.algorithmicChecksByLane, {}, visible, lanes)).toBeNull()
    expect(restoreHiddenLaneRules(open.rules, [], visible, lanes)).toBeNull()
    // So a no-op save on such a project passes through untouched, and no key
    // is added where the stored row has none.
    const body = { systemPrompt: "Plain." }
    expect(restoreHiddenLaneSettings(open, body, visible, lanes)).toEqual({ ok: true, settings: body })
  })

  it("restores nothing for a caller the wall does not restrict", () => {
    expect(restoreHiddenLaneChecks(stored.algorithmicChecksByLane, {}, null, lanes)).toBeNull()
    expect(restoreHiddenLaneRules(stored.rules, [], null, lanes)).toBeNull()
  })

  it("keeps the live settings version so ifMatchVersion still matches", () => {
    const response = { settings: stored, version: 7 }
    const filtered = filterSettingsToVisibleLanes(response, visible, lanes)
    expect(filtered.version).toBe(7)
  })
})
