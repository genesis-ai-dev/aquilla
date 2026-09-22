import { describe, expect, it } from "vitest"
import type { PlanSection } from "@/hooks/usePlanUnitSections"
import type { PlanUnit } from "@/lib/plan/plan-status"
import type { UnitAssignment } from "@/lib/sync/assignments"
import {
  assignmentsShowAudio, shortChaptersByUnit, unassignedChapterCount, unitSectionKeys,
} from "./plan-derive"

const unit = (over: Partial<PlanUnit> = {}): PlanUnit => ({
  fileId: "bible", fileName: "bible", sectionKey: "GEN",
  totalCount: 100, filledCount: 100, validatedCount: 95,
  audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
  targetDate: null, doneAt: null, doneBy: null,
  ...over,
}) as PlanUnit

const section = (key: string, over: Partial<PlanSection> = {}): PlanSection => ({
  key, label: key.split(" ")[1] ?? key,
  totalCount: 20, filledCount: 20, validatedCount: 20,
  audioCount: 0, audioValidatedCount: 0,
  ...over,
})

const assignment = (over: Partial<UnitAssignment> = {}): UnitAssignment => ({
  assignmentId: "a1", assigneeUserId: 2, username: "anna", scopeLabel: "GEN",
  targetLang: "", deadline: null, cellsTotal: 40,
  translated: 40, validated: 40, recorded: 0, audioValidated: 0,
  ...over,
})

describe("shortChaptersByUnit", () => {
  const SECTIONS = new Map<string, PlanSection[]>([["bible", [
    section("GEN"),                                   // front matter, complete
    section("GEN 1"),
    section("GEN 2", { validatedCount: 18 }),         // short
    section("EXO 1", { filledCount: 15, validatedCount: 15 }), // short, another book
  ]]])

  it("names each unit's own short chapters, scoped to its book", () => {
    const map = shortChaptersByUnit(
      [unit(), unit({ sectionKey: "EXO" })], SECTIONS, new Set(),
    )
    expect(map.get("bible:GEN")).toEqual(["2"])
    expect(map.get("bible:EXO")).toEqual(["1"])
  })

  it("leaves front matter off the chapter list even when it is short", () => {
    // The row says "chapters 12 and 40"; a book title is not a chapter, and
    // naming it would send a reader looking for a numbered tile that does
    // not exist. The grid still shows it, labelled as what it is.
    const map = shortChaptersByUnit([unit()], new Map([["bible", [
      section("GEN", { validatedCount: 10 }),
      section("GEN 1"),
    ]]]), new Set())
    expect(map.has("bible:GEN")).toBe(false)
  })

  it("says nothing for a unit whose file has not arrived", () => {
    expect(shortChaptersByUnit([unit({ fileId: "elsewhere" })], SECTIONS, new Set()).size).toBe(0)
  })

  it("judges a chapter's audio only where the FILE carries recordings", () => {
    const sections = new Map([["bible", [section("GEN 3", { audioCount: 5 })]]])
    // Text complete, 15 takes missing: short only if the file expects audio.
    expect(shortChaptersByUnit([unit()], sections, new Set(["bible"])).get("bible:GEN")).toEqual(["3"])
    expect(shortChaptersByUnit([unit()], sections, new Set()).has("bible:GEN")).toBe(false)
  })
})

describe("unassignedChapterCount", () => {
  const SECTIONS = [section("GEN"), section("GEN 1"), section("GEN 2"), section("GEN 3")]

  it("is silent until the assignment read has actually answered", () => {
    // undefined rows = in flight, failed, or refused by the org's floor.
    // "Every chapter is unassigned" is the most alarming thing the line can
    // say, so it must never be what a failed request says.
    expect(unassignedChapterCount(unit(), SECTIONS, undefined)).toBeUndefined()
  })

  it("counts every real chapter when the answer is genuinely nobody", () => {
    // Three chapters — the front-matter key is not one of them.
    expect(unassignedChapterCount(unit(), SECTIONS, [])).toBe(3)
  })

  it("subtracts what the assignments cover", () => {
    const rows = [assignment({ chapters: [{ key: "GEN 1" }, { key: "GEN 3" }] } as never)]
    expect(unassignedChapterCount(unit(), SECTIONS, rows)).toBe(1)
  })

  it("says nothing when an older worker sent no chapter coverage", () => {
    expect(unassignedChapterCount(unit(), SECTIONS, [assignment()])).toBeUndefined()
  })

  it("treats a lone bare book code as the one-chapter book it is", () => {
    // "GEN" with no numbered siblings IS chapter 1 — a one-chapter book with
    // nobody assigned has exactly one open chapter, not none.
    expect(unassignedChapterCount(unit(), [section("GEN")], [])).toBe(1)
  })

  it("says nothing for a unit with no real chapters at all", () => {
    // A media file's sections are time buckets nobody plans by. Zero would
    // render "Every chapter is assigned." — the opposite of what an
    // unassigned unit means.
    const media = unit({ fileId: "ep", sectionKey: "" })
    expect(unassignedChapterCount(media, [section("t:000000000000")], [])).toBeUndefined()
    expect(unassignedChapterCount(media, undefined, [])).toBeUndefined()
  })
})

describe("unitSectionKeys", () => {
  it("keeps the unit's own keys, front matter included, and nothing else", () => {
    const keys = unitSectionKeys(unit(), [
      section("GEN"), section("GEN 1"), section("EXO 1"),
    ])
    expect(keys).toEqual(["GEN", "GEN 1"])
  })
  it("is undefined while the sections are", () => {
    expect(unitSectionKeys(unit(), undefined)).toBeUndefined()
  })
})

describe("assignmentsShowAudio", () => {
  it("draws audio bars only for a recording file that is NOT cue-linked", () => {
    expect(assignmentsShowAudio(unit({ audioTotalCount: null }), new Set(["bible"]))).toBe(true)
  })
  it("hides them on a dubbing unit, whose takes live on the cue sheet", () => {
    // An assignment holds subtitle cells; the takes hang off a different
    // file's cells, so an assignee's recorded count here is structurally
    // zero however much of the episode they have dubbed. Sam ruled it a
    // later ticket — text-only until then.
    expect(assignmentsShowAudio(unit({ audioTotalCount: 548 }), new Set(["bible"]))).toBe(false)
  })
  it("hides them on a file with no recordings at all", () => {
    expect(assignmentsShowAudio(unit({ audioTotalCount: null }), new Set())).toBe(false)
  })
})
