// AQU-2110 — the chapter picker shows audio figures where audio is the work.
//
// A target language with no written form is translated by recording, and its
// chapters are signed off by audio validation. The picker counted only text
// validation, so a fully recorded and validated chapter read "100% translated
// / 0% validated" and the team had no figure that could ever reach 100%.
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { MilestoneNavigator, type MilestoneNavigationItem } from "./ChapterNavigator"
import { progressViewFor } from "@/lib/progress/milestone-progress-view"
import { PROGRESS_BG } from "@/lib/progress/progress-palette"

afterEach(cleanup)

function chapter(
  n: number,
  figures: Partial<Pick<MilestoneNavigationItem, "translated" | "validated" | "textTranslated" | "audioRecorded" | "audioValidated">>,
  total = 10,
): MilestoneNavigationItem {
  return {
    key: `scripture:GEN:${n}`,
    kind: "chapter",
    label: `Genesis ${n}`,
    shortLabel: String(n),
    description: `Verses 1–${total}`,
    translated: 0,
    validated: 0,
    total,
    ...figures,
  }
}

const openPicker = () =>
  fireEvent.click(screen.getByRole("combobox", { name: /Current chapter: Genesis 1/ }))

const columns = () => ({
  text: document.querySelectorAll('[data-progress-column="text"]').length,
  audio: document.querySelectorAll('[data-progress-column="audio"]').length,
})

/** The audio-only repro: chapter 1 fully recorded and validated, chapter 2 untouched. */
const audioOnly: MilestoneNavigationItem[] = [
  chapter(1, { translated: 10, textTranslated: 0, audioRecorded: 10, audioValidated: 10 }),
  chapter(2, { translated: 0, textTranslated: 0, audioRecorded: 0, audioValidated: 0 }),
]

describe("progressViewFor (AQU-2110)", () => {
  it("picks the audio figures alone for a file with recordings and no target text", () => {
    expect(progressViewFor(audioOnly)).toBe("audio")
  })

  it("keeps the text figures and adds the audio ones for a file that has both", () => {
    expect(progressViewFor([
      chapter(1, { translated: 10, textTranslated: 6, audioRecorded: 7, audioValidated: 7 }),
      chapter(2, { translated: 2, textTranslated: 2 }),
    ])).toBe("both")
  })

  it("decides per FILE, so one recorded chapter switches every row together", () => {
    expect(progressViewFor([
      chapter(1, { translated: 10, textTranslated: 0, audioRecorded: 10, audioValidated: 4 }),
      chapter(2, { translated: 0, textTranslated: 0 }),
      chapter(3, { translated: 3, textTranslated: 3 }),
    ])).toBe("both")
  })

  it("shows a text-only file, and a caller that knows nothing of audio, exactly as before", () => {
    expect(progressViewFor([chapter(1, { translated: 4, validated: 1 }), chapter(2, {})])).toBe("text")
    expect(progressViewFor([chapter(1, { translated: 4, textTranslated: 4, audioRecorded: 0 })])).toBe("text")
  })
})

describe("MilestoneNavigator audio figures (AQU-2110)", () => {
  it("reads an audio-only chapter as 100% recorded and 100% audio validated, in the audio tones, with no text figures", () => {
    render(<MilestoneNavigator items={audioOnly} activeKey="scripture:GEN:1" onSelect={() => {}} />)
    openPicker()

    // The figure that used to stay at 0% validated.
    expect(screen.getByText("100% audio validated")).toHaveClass("sr-only")
    expect(screen.getByText("100% recorded")).toHaveClass("sr-only")
    expect(screen.getByText("0% audio validated")).toHaveClass("sr-only")
    expect(screen.getByText("0% recorded")).toHaveClass("sr-only")

    // No text pair for a file whose text figures can never move.
    expect(screen.queryByText(/% translated$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^\d+% validated$/)).not.toBeInTheDocument()
    expect(columns()).toEqual({ text: 0, audio: 2 })

    // Light magenta = recorded, dark magenta = audio validated; never the text blues.
    for (const [wording, fill] of [
      ["100% recorded", PROGRESS_BG.audioRecorded],
      ["100% audio validated", PROGRESS_BG.audioValidated],
    ]) {
      const line = screen.getByText(wording).closest("[title]")!
      expect(line.querySelector("[data-progress-swatch]")!.className, wording).toContain(fill)
      expect(line.querySelector("[data-progress-swatch]")!.className, wording).not.toContain("text-")
    }

    // Announced as the row's accessible name, like the text pair always was.
    expect(screen.getByRole("option", { name: /Genesis 1 Verses 1–10 100% recorded 100% audio validated/ })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Genesis 2 Verses 1–10 0% recorded 0% audio validated/ })).toBeInTheDocument()
  })

  it("reads a partly validated chapter as its line count — 3 of 10 is 30%", () => {
    render(
      <MilestoneNavigator
        items={[chapter(1, { translated: 10, textTranslated: 0, audioRecorded: 10, audioValidated: 3 })]}
        activeKey="scripture:GEN:1"
        onSelect={() => {}}
      />,
    )
    openPicker()
    expect(screen.getByText("30% audio validated")).toHaveClass("sr-only")
    expect(screen.getByText("30%")).toBeInTheDocument()
  })

  it("never rounds outstanding audio work up to 100% (AQU-1493)", () => {
    render(
      <MilestoneNavigator
        items={[chapter(1, { translated: 220, textTranslated: 0, audioRecorded: 220, audioValidated: 219 }, 220)]}
        activeKey="scripture:GEN:1"
        onSelect={() => {}}
      />,
    )
    openPicker()
    expect(screen.getByText("99% audio validated")).toHaveClass("sr-only")
    expect(screen.queryByText("100% audio validated")).not.toBeInTheDocument()
  })

  it("keeps the text figures exactly as before and adds the audio column beside them on a file with both", () => {
    render(
      <MilestoneNavigator
        items={[
          chapter(1, { translated: 10, validated: 2, textTranslated: 6, audioRecorded: 7, audioValidated: 7 }),
          chapter(2, { translated: 2, validated: 0, textTranslated: 2 }),
        ]}
        activeKey="scripture:GEN:1"
        onSelect={() => {}}
      />,
    )
    openPicker()

    expect(columns()).toEqual({ text: 2, audio: 2 })
    // The text pair, unchanged: `translated` still counts a take as before.
    expect(screen.getByText("100% translated")).toHaveClass("sr-only")
    expect(screen.getByText("20% validated")).toHaveClass("sr-only")
    expect(screen.getByText("70% recorded")).toHaveClass("sr-only")
    expect(screen.getByText("70% audio validated")).toHaveClass("sr-only")
    expect(screen.getByRole("option", {
      name: /Genesis 1 Verses 1–10 100% translated 20% validated 70% recorded 70% audio validated/,
    })).toBeInTheDocument()
    // The unrecorded chapter of the same file shows the audio column too, at 0.
    expect(screen.getByRole("option", {
      name: /Genesis 2 Verses 1–10 20% translated 0% validated 0% recorded 0% audio validated/,
    })).toBeInTheDocument()
    // The popover grew by the column so titles keep their room (AQU-1485).
    expect(screen.getByRole("listbox").closest("[class*='14rem+2rem+2rem+4rem']")).not.toBeNull()
  })

  it("leaves a text-only project's picker exactly as it was — no audio column, no '0% recorded'", () => {
    render(
      <MilestoneNavigator
        items={[
          chapter(1, { translated: 4, validated: 1, textTranslated: 4, audioRecorded: 0, audioValidated: 0 }),
          chapter(2, { translated: 0, validated: 0, textTranslated: 0, audioRecorded: 0, audioValidated: 0 }),
        ]}
        activeKey="scripture:GEN:1"
        onSelect={() => {}}
      />,
    )
    openPicker()

    expect(columns()).toEqual({ text: 2, audio: 0 })
    expect(screen.queryByText(/recorded/)).not.toBeInTheDocument()
    expect(screen.getByText("40% translated")).toHaveClass("sr-only")
    expect(screen.getByText("10% validated")).toHaveClass("sr-only")
    expect(screen.getByRole("listbox").closest("[class*='14rem+2rem+2rem+4rem']")).toBeNull()
  })

  it("shows the audio column on the cell ranges under a split milestone too", () => {
    const story: MilestoneNavigationItem = {
      key: "story:u1",
      kind: "story",
      label: "Story u1",
      shortLabel: "1",
      description: "60 cells",
      translated: 60,
      validated: 0,
      total: 60,
      textTranslated: 0,
      audioRecorded: 60,
      audioValidated: 30,
      subsections: [
        { key: "story:u1:range:a", label: "1–50", firstCellId: "a", translated: 50, validated: 0, total: 50, textTranslated: 0, audioRecorded: 50, audioValidated: 25 },
        { key: "story:u1:range:b", label: "51–60", firstCellId: "b", translated: 10, validated: 0, total: 10, textTranslated: 0, audioRecorded: 10, audioValidated: 5 },
      ],
    }
    render(<MilestoneNavigator items={[story]} activeKey="story:u1" onSelect={() => {}} />)
    fireEvent.click(screen.getByRole("combobox", { name: /Current story: Story u1/ }))

    expect(screen.getByRole("option", { name: /Cells 1–50 100% recorded 50% audio validated/ })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /Cells 51–60 100% recorded 50% audio validated/ })).toBeInTheDocument()
    expect(columns().text).toBe(0)
  })
})

describe("MilestoneNavigator: what the language delivers wins (media redesign)", () => {
  const both: MilestoneNavigationItem[] = [
    chapter(1, { translated: 10, textTranslated: 6, audioRecorded: 7, audioValidated: 7 }),
    chapter(2, { translated: 2, textTranslated: 2 }),
  ]

  it("Audio draws the audio figures alone, even where some text exists", () => {
    render(<MilestoneNavigator items={both} activeKey="scripture:GEN:1" onSelect={() => {}} delivers="audio" />)
    openPicker()
    expect(columns().text).toBe(0)
    expect(columns().audio).toBeGreaterThan(0)
  })

  it("Text draws the text figures alone, however much is recorded", () => {
    render(<MilestoneNavigator items={audioOnly} activeKey="scripture:GEN:1" onSelect={() => {}} delivers="text" />)
    openPicker()
    expect(columns().audio).toBe(0)
    expect(columns().text).toBeGreaterThan(0)
  })
})
