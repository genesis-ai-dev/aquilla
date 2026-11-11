import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { LaneAccessFields } from "./LaneAccessFields"
import type { LaneAccessChoice } from "@/lib/lanes/lane-access-choice"

vi.mock("@/lib/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "projectSettings.share.laneChoiceLegend": "Target lanes",
        "projectSettings.share.laneChoiceAll": "Every current target lane",
        "projectSettings.share.laneChoiceSome": "Only selected lanes",
        "projectSettings.share.laneChoiceNoneNote":
          "No language lanes selected — this person will see the project and its source text, and no translation.",
      })[key] ?? key,
    locale: "en",
  }),
}))

const lanes = [
  { id: "ln-es", label: "Spanish" },
  { id: "ln-fr", label: "French" },
]

describe("LaneAccessFields", () => {
  it("starts with neither choice selected", () => {
    render(<LaneAccessFields lanes={lanes} value={null} onChange={() => {}} />)
    expect(screen.getByRole("radio", { name: "Every current target lane" })).not.toBeChecked()
    expect(screen.getByRole("radio", { name: "Only selected lanes" })).not.toBeChecked()
  })

  it("reports every current lane, then one selected lane", () => {
    const seen: LaneAccessChoice[] = []
    const { rerender } = render(
      <LaneAccessFields lanes={lanes} value={null} onChange={(next) => seen.push(next)} />,
    )
    fireEvent.click(screen.getByRole("radio", { name: "Every current target lane" }))
    expect(seen.at(-1)).toEqual({ kind: "all" })

    rerender(
      <LaneAccessFields
        lanes={lanes}
        value={{ kind: "lanes", laneIds: [] }}
        onChange={(next) => seen.push(next)}
      />,
    )
    fireEvent.click(screen.getByRole("radio", { name: "Only selected lanes" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Spanish" }))
    expect(seen.at(-1)).toEqual({ kind: "lanes", laneIds: ["ln-es"] })
  })

  // AQU-2358: an empty selection is a real choice, so it says what it grants
  // instead of looking like an unfinished form.
  it("says what an empty selection grants, and stops saying it once a lane is checked", () => {
    const { rerender } = render(
      <LaneAccessFields lanes={lanes} value={{ kind: "lanes", laneIds: [] }} onChange={() => {}} />,
    )
    expect(screen.getByTestId("lane-access-no-lanes-note")).toHaveTextContent(
      "will see the project and its source text, and no translation",
    )

    rerender(
      <LaneAccessFields
        lanes={lanes}
        value={{ kind: "lanes", laneIds: ["ln-es"] }}
        onChange={() => {}}
      />,
    )
    expect(screen.queryByTestId("lane-access-no-lanes-note")).toBeNull()
  })

  it("shows no such note before any choice is made", () => {
    render(<LaneAccessFields lanes={lanes} value={null} onChange={() => {}} />)
    expect(screen.queryByTestId("lane-access-no-lanes-note")).toBeNull()
  })
})
