import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { BuiltinChecksList } from "./BuiltinChecksList"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"

describe("BuiltinChecksList", () => {
  const builtinRules = resolveBuiltinRules(undefined)

  it("renders all built-in checks", () => {
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={new Map()}
        onSetOverride={() => {}}
      />,
    )
    expect(screen.getByText("Empty translation")).toBeInTheDocument()
    expect(screen.getByText("Identical to source")).toBeInTheDocument()
    expect(screen.getByText("Placeholder integrity")).toBeInTheDocument()
  })

  it("calls onSetOverride when toggle clicked", () => {
    const spy = vi.fn()
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={new Map()}
        onSetOverride={spy}
      />,
    )
    // The "Abbreviation pass-through" row's toggle starts disabled (default).
    const row = screen.getByText("Abbreviation pass-through").closest("[data-testid='builtin-row']")!
    const toggle = within(row as HTMLElement).getByRole("switch")
    fireEvent.click(toggle)
    expect(spy).toHaveBeenCalledWith(
      "abbreviation-mismatch",
      expect.objectContaining({ enabled: true }),
    )
  })

  it("displays infraction counts per check", () => {
    const infractions = new Map([
      ["c1", [{ ruleId: "builtin:empty-target", cellId: "c1", fileId: "f1", reason: "builtin:empty-target" as const, spans: [] }]],
      ["c2", [{ ruleId: "builtin:empty-target", cellId: "c2", fileId: "f1", reason: "builtin:empty-target" as const, spans: [] }]],
    ])
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={infractions}
        onSetOverride={() => {}}
      />,
    )
    const row = screen.getByText("Empty translation").closest("[data-testid='builtin-row']")!
    expect(row.textContent).toMatch(/2/)
  })
})

// AQU-1688: Bible data checks sit in their own group, and a dormant one says
// which Language-profile slot it waits for (the spec: never dormant silently).
describe("BuiltinChecksList — Bible data checks", () => {
  const textOnly = resolveBuiltinRules(undefined)
  const withBible = resolveBuiltinRules(undefined, { bibleChecks: true })
  const quoteMarks = { levels: [{ open: "“", close: "”" }], continuation: "none" as const }

  it("groups the Bible data checks under their own heading, only when they exist", () => {
    const { unmount } = render(<BuiltinChecksList builtinRules={textOnly} infractions={new Map()} onSetOverride={() => {}} />)
    expect(screen.queryByTestId("builtin-bible-checks")).toBeNull()
    unmount()
    render(<BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={() => {}} />)
    const group = screen.getByTestId("builtin-bible-checks")
    expect(within(group).getByText("Bible data checks")).toBeInTheDocument()
    // AQU-1688 quotations and question (8), AQU-1697 pack A (8), AQU-1699 pack B (13).
    expect(within(group).getAllByTestId("builtin-row")).toHaveLength(29)
    expect(within(group).getByText("Question kept")).toBeInTheDocument()
    expect(within(group).getByText("Negation kept")).toBeInTheDocument()
  })

  const needsOf = (name: string) => {
    const row = screen.getByText(name).closest("[data-testid='builtin-row']") as HTMLElement
    return within(row).queryAllByTestId("builtin-row-needs").map((line) => line.textContent)
  }

  it("says which slot each check waits for while the Language profile is empty", () => {
    render(<BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={() => {}} languageProfile={{}} />)
    const needs = within(screen.getByTestId("builtin-bible-checks")).getAllByTestId("builtin-row-needs")
    // Every check but S8 and X3 (verse numbering and repeated quotations need
    // nothing from the profile); P15 and X4 wait for two things each.
    expect(needs).toHaveLength(29)
    expect(needsOf("Quotation closes")).toEqual(["Needs: quotation marks in Language profile"])
    // AQU-1691: M1 has its own slot. Naming quotation marks here would send the
    // maintainer to fill in the wrong part of the profile.
    expect(needsOf("Question kept")).toEqual(["Needs: question markers in Language profile"])
    // AQU-1697: each pack-A check names the one slot that switches it on.
    expect(needsOf("Number kept")).toEqual(["Needs: number words in Language profile"])
    expect(needsOf("Ordinal number kept")).toEqual(["Needs: number words in Language profile"])
    expect(needsOf("Negation kept")).toEqual(["Needs: negative words in Language profile"])
    expect(needsOf("Heading for each passage")).toEqual(["Needs: section headings in Language profile"])
    expect(needsOf("Sentence runs on")).toEqual(["Needs: question markers in Language profile"])
    expect(needsOf("Verses the oldest manuscripts lack")).toEqual(["Needs: textual variants in Language profile"])
    expect(needsOf("Disputed passages")).toEqual(["Needs: textual variants in Language profile"])
    expect(needsOf("Verse numbering")).toEqual([])
  })

  it("keeps the question check dormant until question markers are saved, even with quotation marks set", () => {
    const { unmount } = render(
      <BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={() => {}} languageProfile={{ quoteMarks }} />,
    )
    expect(needsOf("Question kept")).toEqual(["Needs: question markers in Language profile"])
    expect(needsOf("Quotation closes")).toEqual([])
    unmount()
    // An empty slot is a real answer: questions are marked with "?" only.
    render(
      <BuiltinChecksList
        builtinRules={withBible}
        infractions={new Map()}
        onSetOverride={() => {}}
        languageProfile={{ quoteMarks, questionMarkers: {} }}
      />,
    )
    expect(needsOf("Question kept")).toEqual([])
    // AQU-1697: S3 waits for the same slot.
    expect(needsOf("Sentence runs on")).toEqual([])
  })

  // AQU-1699: check pack B waits for more than a filled slot: the project's
  // decisions or terminology, a slot's forms, or a word alignment. WHY: a
  // maintainer must see what switches each one on, and a check that does not
  // apply at all ("you" has no number in this language) is not a missing answer.
  it("says what each check-pack-B check waits for, and drops it once decided", () => {
    const empty = { agreedNames: false, nameForms: false, divineNameFacts: false, clusivityFacts: false, pronounSpans: false }
    const { unmount } = render(
      <BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={() => {}} languageProfile={{}} bibleReadiness={empty} />,
    )
    expect(needsOf("Names kept")).toEqual(["Needs: agreed names, from decisions (render.…) or terminology entries"])
    expect(needsOf("No names the source lacks")).toEqual(["Needs: agreed names, from decisions (render.…) or terminology entries"])
    expect(needsOf("Name form kept")).toEqual(["Needs: a decision for two forms of one name (render.….form.…)"])
    expect(needsOf("Singular or plural “you”")).toEqual(["Needs: singular and plural “you” forms in Language profile"])
    expect(needsOf("Capitals for God")).toEqual([
      "Needs: the capitals rule for God in Language profile (Divine names)",
      "Needs: word alignment between the Greek and the translation, which this project does not have",
    ])
    expect(needsOf("Decisions kept")).toEqual([
      "Needs: a decision about “we” in a passage (clusivity.…)",
      "Needs: inclusive and exclusive “we” forms in Language profile",
    ])
    expect(needsOf("Repeated quotations alike")).toEqual([])
    unmount()
    // English: one "you", one "we", and a decided name. The forms checks do not apply; the name checks run.
    const english = {
      pronouns: { secondPerson: { numberDistinction: false }, firstPersonPlural: { clusivity: false } },
    }
    render(
      <BuiltinChecksList
        builtinRules={withBible}
        infractions={new Map()}
        onSetOverride={() => {}}
        languageProfile={english}
        bibleReadiness={{ ...empty, agreedNames: true }}
      />,
    )
    expect(needsOf("Names kept")).toEqual([])
    expect(needsOf("Singular or plural “you”")).toEqual([
      "Not used: in Language profile, “you” is the same for one person and for several",
    ])
    expect(needsOf("Inclusive or exclusive “we”")).toEqual([
      "Not used: in Language profile, “we” is the same with or without the listener",
    ])
  })

  it("drops the reason once the marks are set, and keeps the switch and severity", () => {
    const spy = vi.fn()
    render(
      <BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={spy} languageProfile={{ quoteMarks }} />,
    )
    expect(needsOf("Quotation closes")).toEqual([])
    const row = screen.getByText("Quotation closes").closest("[data-testid='builtin-row']") as HTMLElement
    fireEvent.click(within(row).getByRole("switch"))
    expect(spy).toHaveBeenCalledWith("bkp:V2", expect.objectContaining({ enabled: false }))
  })
})
