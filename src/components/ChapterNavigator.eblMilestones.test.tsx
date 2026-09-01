/**
 * AQU-1008 — an imported EBL guide reaches the navigator as its own sections.
 *
 * WHY: the EBL selector's divisions and the navigator that renders them are
 * tested apart (`src/lib/biblica/ebl/notes.test.ts`, `ChapterNavigator.test.tsx`),
 * and the commit path is tested with hand-read metadata (`import.ebl.test.ts`).
 * None of those runs a real guide's headings all the way to the control a
 * translator actually clicks, so a division whose label, kind or order the
 * navigator cannot use would leave every one of them green.
 *
 * This composes the real parser output with `deriveMilestoneNavigation` and the
 * navigator, mirroring how EditorTable builds its items.
 */

import React, { useState } from "react"
import { describe, it, expect, beforeAll, afterEach } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MilestoneNavigator, type MilestoneNavigationItem } from "./ChapterNavigator"
import { deriveMilestoneNavigation } from "@/lib/milestone-navigation"
import { extractEblStrings } from "@/lib/parsers/biblica-ebl"
import { makeEblIdml, SAMPLE_EBL } from "@/lib/biblica/ebl/__fixtures__/ebl-idml"
import { MILESTONE_SUBSECTION_SIZE } from "@/hooks/useActiveCellStore"
import { parseIdml } from "@aquilla/idml-roundtrip"

afterEach(cleanup)

let items: MilestoneNavigationItem[] = []

/**
 * The same shape EditorTable derives: cells carry the planner's milestone
 * envelope, `deriveMilestoneNavigation` groups them, and each group becomes one
 * navigator item — with the per-50-cell ranges an IDML file always gets.
 */
beforeAll(async () => {
  // Parse in-process: the app's IDML worker has no Web Worker to run in here.
  const { strings } = await extractEblStrings(await makeEblIdml(), parseIdml)
  const navigation = deriveMilestoneNavigation(strings.map((string, index) => ({
    id: `cell-${index}`,
    original: string.value,
    metadata: { aquillaImport: { milestone: string.milestone } },
  })))

  items = navigation.orderedMilestones.map(({ milestone, cellIds }) => ({
    key: milestone.key,
    kind: milestone.kind,
    label: milestone.label,
    shortLabel: milestone.shortLabel,
    description: `${cellIds.length} cell${cellIds.length === 1 ? "" : "s"}`,
    translated: 0,
    validated: 0,
    total: cellIds.length,
    subsections: Array.from(
      { length: Math.ceil(cellIds.length / MILESTONE_SUBSECTION_SIZE) },
      (_unused, chunk) => {
        const offset = chunk * MILESTONE_SUBSECTION_SIZE
        const range = cellIds.slice(offset, offset + MILESTONE_SUBSECTION_SIZE)
        return {
          key: `${milestone.key}:range:${range[0]!}`,
          label: `${offset + 1}–${offset + range.length}`,
          firstCellId: range[0]!,
          translated: 0,
          validated: 0,
          total: range.length,
        }
      },
    ),
  }))
})

/** The navigator is controlled, so stepping needs the caller's state. */
function Navigator() {
  const [activeKey, setActiveKey] = useState(items[0]!.key)
  return (
    <MilestoneNavigator
      items={items}
      activeKey={activeKey}
      onSelect={(key) => setActiveKey(key)}
    />
  )
}

/**
 * The division the trigger currently names. An IDML file always carries cell
 * ranges, so the trigger reads "…, cells 1–7"; the range is not what this suite
 * is about.
 */
function currentLabel(): string {
  const trigger = screen.getByRole("combobox", { name: /^Current section: / })
  return trigger.getAttribute("aria-label")!
    .replace(/^Current section: /, "")
    .replace(/, cells [\d–]+\. Choose section$/, "")
}

describe("AQU-1008 — EBL divisions in the milestone navigator", () => {
  it("labels every division the way the guide's own headings read", () => {
    expect(items.map((item) => item.label)).toEqual([
      "Boxes and tables",
      SAMPLE_EBL.titleLines.join(" "),
      SAMPLE_EBL.introHead,
      SAMPLE_EBL.contentsHead,
      SAMPLE_EBL.moduleLines.join(" "),
      `Topic 1.1: ${SAMPLE_EBL.topicTitle}`,
      `Lesson 1: ${SAMPLE_EBL.lessonOneTitle}`,
      `Lesson 2: ${SAMPLE_EBL.lessonTwoTitle}`,
      SAMPLE_EBL.glossaryHead,
    ])
  })

  it("speaks of them as sections, since a guide has no chapters or verses", () => {
    render(<Navigator />)

    expect(screen.getByRole("button", { name: "Next section" })).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Move between sections" })).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Next (?:chapter|slide|story|part)/ }),
    ).toBeNull()
  })

  it("steps a topic or a lesson at a time, in the guide's reading order", () => {
    render(<Navigator />)

    const visited = [currentLabel()]
    const next = screen.getByRole("button", { name: "Next section" })
    while (!(next as HTMLButtonElement).disabled) {
      fireEvent.click(next)
      visited.push(currentLabel())
    }

    expect(visited).toEqual(items.map((item) => item.label))
  })

  it("numbers a lesson under its topic, so two Lesson 1s stay apart", () => {
    const lessons = items.filter((item) => item.label.startsWith("Lesson "))
    expect(lessons.map((item) => item.shortLabel)).toEqual(["1.1.1", "1.1.2"])
    expect(new Set(lessons.map((item) => item.key)).size).toBe(lessons.length)
  })

  it("does not turn a pull-out box's heading into a section of its own", () => {
    render(<Navigator />)

    // Set in the same level-1 style a lesson tag uses, but a detached frame —
    // and listed ahead of the body, so it would otherwise open the file.
    expect(items.map((item) => item.label)).not.toContain(SAMPLE_EBL.timingBadge)
    expect(items.map((item) => item.label)).not.toContain(SAMPLE_EBL.summaryBanner)
    expect(currentLabel()).toBe("Boxes and tables")
  })

  it("gives every division one unbroken run, so a page is never disjoint", () => {
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length)
    for (const item of items) {
      expect(item.total).toBeGreaterThan(0)
      expect(item.subsections).toHaveLength(1)
    }
  })
})
