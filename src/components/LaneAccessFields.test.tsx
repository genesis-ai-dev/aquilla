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
})
