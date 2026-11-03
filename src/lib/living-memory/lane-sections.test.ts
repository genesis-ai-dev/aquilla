// Per-lane Living Memory — the page's view logic (AQU-2348).
//
// These pin the rules the Living Memory page's Customize / Revert controls
// stand on. Two of them are rules an earlier slice got wrong once and flagged
// forward, so they are asserted rather than assumed:
//
//   * "customized" asks whether the lane OWNS the value, never whether it
//     READS one. A lane inheriting the project's brief reads a brief; if that
//     counted as customized, Revert would appear on a lane with nothing to
//     revert and Customize would never appear at all.
//   * An edit made while a lane owns a section must land in that lane's copy.
//     If it fell through to the project's value, editing one lane's brief
//     would rewrite every other lane's — the exact leak criterion #3 forbids.

import { describe, it, expect } from "vitest"
import {
  customizeSectionPatch,
  laneOwnsSection,
  laneSectionValue,
  laneSectionWritePatch,
  revertSectionPatch,
  stampLaneOnNewRow,
} from "./lane-sections"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import type { TranslationBrief } from "@/lib/brief/types"

const LANE_A = "a1b2c3d4"
const LANE_B = "99887766"

function brief(variety: string): TranslationBrief {
  return { targetVariety: variety } as unknown as TranslationBrief
}

describe("laneOwnsSection", () => {
  it("is false for a lane that only READS the project's value", () => {
    const settings: ProjectWideSettings = { translationBrief: brief("project") }
    expect(laneSectionValue(settings, LANE_A, "brief")).toEqual(brief("project"))
    // Reading is not owning — this is the distinction the whole control rests on.
    expect(laneOwnsSection(settings, LANE_A, "brief")).toBe(false)
  })

  it("is true for a lane with its own copy, and false for its neighbour", () => {
    const settings: ProjectWideSettings = {
      translationBrief: brief("project"),
      translationBriefByLane: { [LANE_A]: brief("lane A") },
    }
    expect(laneOwnsSection(settings, LANE_A, "brief")).toBe(true)
    expect(laneOwnsSection(settings, LANE_B, "brief")).toBe(false)
  })

  it("is true for a lane whose stored value is EMPTY — a deliberate none is a customization", () => {
    // Truthiness would read this as "not customized" and strand the lane: the
    // Revert control would vanish on the one lane that needs it.
    const settings: ProjectWideSettings = {
      systemPrompt: "project prompt",
      systemPromptByLane: { [LANE_A]: "" },
    }
    expect(laneOwnsSection(settings, LANE_A, "systemPrompt")).toBe(true)
    expect(laneSectionValue(settings, LANE_A, "systemPrompt")).toBe("")
  })

  it("owns nothing in the project-wide view, even when lanes have copies", () => {
    const settings: ProjectWideSettings = {
      translationBriefByLane: { [LANE_A]: brief("lane A") },
    }
    expect(laneOwnsSection(settings, undefined, "brief")).toBe(false)
    expect(laneSectionValue(settings, undefined, "brief")).toBeUndefined()
  })
})

describe("customizeSectionPatch", () => {
  it("COPIES what the lane currently resolves to, so customizing is not a blanking", () => {
    const settings: ProjectWideSettings = { translationBrief: brief("project") }
    const patch = customizeSectionPatch(settings, LANE_A, "brief")
    expect(patch.translationBriefByLane).toEqual({ [LANE_A]: brief("project") })
    // The project's own brief is untouched by the patch.
    expect(patch.translationBrief).toBeUndefined()
  })

  it("records ownership even when the project has no value to copy", () => {
    // Otherwise "Customize for this lane" on an empty project brief would look
    // like it did nothing, and Revert would have nothing to remove.
    const patch = customizeSectionPatch({}, LANE_A, "systemPrompt")
    expect(patch.systemPromptByLane).toBeDefined()
    expect(Object.prototype.hasOwnProperty.call(patch.systemPromptByLane!, LANE_A)).toBe(true)
  })

  it("leaves another lane's copy alone", () => {
    const settings: ProjectWideSettings = {
      translationBrief: brief("project"),
      translationBriefByLane: { [LANE_B]: brief("lane B") },
    }
    const patch = customizeSectionPatch(settings, LANE_A, "brief")
    expect(patch.translationBriefByLane).toEqual({
      [LANE_B]: brief("lane B"),
      [LANE_A]: brief("project"),
    })
  })
})

describe("revertSectionPatch", () => {
  it("removes this lane's copy and keeps every other lane's", () => {
    const settings: ProjectWideSettings = {
      translationBrief: brief("project"),
      translationBriefByLane: { [LANE_A]: brief("lane A"), [LANE_B]: brief("lane B") },
    }
    const patch = revertSectionPatch(settings, LANE_A, "brief")
    expect(patch.translationBriefByLane).toEqual({ [LANE_B]: brief("lane B") })
  })

  it("clears the key entirely when the last copy goes, rather than storing {}", () => {
    const settings: ProjectWideSettings = {
      systemPrompt: "project prompt",
      systemPromptByLane: { [LANE_A]: "lane A prompt" },
    }
    const patch = revertSectionPatch(settings, LANE_A, "systemPrompt")
    expect(patch.systemPromptByLane).toBeUndefined()
  })

  it("makes the lane read the project value again", () => {
    const settings: ProjectWideSettings = {
      systemPrompt: "project prompt",
      systemPromptByLane: { [LANE_A]: "lane A prompt" },
    }
    const reverted: ProjectWideSettings = { ...settings, ...revertSectionPatch(settings, LANE_A, "systemPrompt") }
    expect(laneSectionValue(reverted, LANE_A, "systemPrompt")).toBe("project prompt")
    expect(laneOwnsSection(reverted, LANE_A, "systemPrompt")).toBe(false)
  })
})

describe("laneSectionWritePatch", () => {
  it("writes the PROJECT value when no lane is in view", () => {
    const patch = laneSectionWritePatch({}, undefined, "brief", brief("edited"))
    expect(patch.translationBrief).toEqual(brief("edited"))
    expect(patch.translationBriefByLane).toBeUndefined()
  })

  it("writes the PROJECT value when the viewed lane only inherits", () => {
    // The lane is showing the project's value, so the user is editing exactly
    // what they can see. Silently forking it into a lane copy would make the
    // project's brief un-editable from a lane view.
    const settings: ProjectWideSettings = { translationBrief: brief("project") }
    const patch = laneSectionWritePatch(settings, LANE_A, "brief", brief("edited"))
    expect(patch.translationBrief).toEqual(brief("edited"))
    expect(patch.translationBriefByLane).toBeUndefined()
  })

  it("writes the LANE's copy once the lane owns the section, never the project's", () => {
    const settings: ProjectWideSettings = {
      translationBrief: brief("project"),
      translationBriefByLane: { [LANE_A]: brief("lane A"), [LANE_B]: brief("lane B") },
    }
    const patch = laneSectionWritePatch(settings, LANE_A, "brief", brief("lane A edited"))
    expect(patch.translationBrief).toBeUndefined()
    expect(patch.translationBriefByLane).toEqual({
      [LANE_A]: brief("lane A edited"),
      [LANE_B]: brief("lane B"),
    })
  })

  it("round-trips: customize, edit, and the other lane plus the project are untouched", () => {
    // Criterion #3 end to end, in one assertion chain.
    let settings: ProjectWideSettings = {
      translationBrief: brief("project"),
      translationBriefByLane: { [LANE_B]: brief("lane B") },
    }
    settings = { ...settings, ...customizeSectionPatch(settings, LANE_A, "brief") }
    settings = { ...settings, ...laneSectionWritePatch(settings, LANE_A, "brief", brief("lane A only")) }

    expect(laneSectionValue(settings, LANE_A, "brief")).toEqual(brief("lane A only"))
    expect(laneSectionValue(settings, LANE_B, "brief")).toEqual(brief("lane B"))
    expect(settings.translationBrief).toEqual(brief("project"))

    settings = { ...settings, ...revertSectionPatch(settings, LANE_A, "brief") }
    expect(laneSectionValue(settings, LANE_A, "brief")).toEqual(brief("project"))
    expect(laneSectionValue(settings, LANE_B, "brief")).toEqual(brief("lane B"))
  })
})

describe("stampLaneOnNewRow", () => {
  it("stamps the viewed lane on a new row", () => {
    // Criterion #6: a style rule created in a lane view is compiled for that
    // lane only.
    expect(stampLaneOnNewRow({ instruction: "Formal register" }, LANE_A)).toEqual({
      instruction: "Formal register",
      laneId: LANE_A,
    })
  })

  it("leaves the input untouched in the project-wide view", () => {
    // Byte-identical to the request before a lane could own a row, so the row
    // lands project-wide and in force in every lane.
    const input = { instruction: "Formal register" }
    expect(stampLaneOnNewRow(input, undefined)).toBe(input)
  })

  it("lets an explicit lane on the input win", () => {
    // So a per-row lane chooser can be added later without revisiting the
    // call sites — including an explicit null, which means "project-wide".
    expect(stampLaneOnNewRow({ instruction: "x", laneId: LANE_B }, LANE_A).laneId).toBe(LANE_B)
    expect(stampLaneOnNewRow({ instruction: "x", laneId: null }, LANE_A).laneId).toBeNull()
  })
})
