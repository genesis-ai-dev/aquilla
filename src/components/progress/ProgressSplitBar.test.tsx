import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { textProgressSegments } from "@/lib/progress/progress-palette"
import { ProgressSplitBar } from "./ProgressSplitBar"

describe("ProgressSplitBar (AQU-1764)", () => {
  it("draws each part in order at its width, and names itself only when given a sentence", () => {
    const segments = textProgressSegments({ validated: 64, translated: 82, aiDrafted: 9, total: 100 })
    const { container, rerender } = render(<ProgressSplitBar segments={segments} />)
    const bar = container.querySelector<HTMLElement>('[data-slot="progress-split-bar"]')!
    const parts = [...bar.querySelectorAll<HTMLElement>("[data-progress-tone]")]
    expect(parts.map((p) => [p.dataset.progressTone, p.style.width])).toEqual([
      ["textValidated", "64%"],
      ["textTranslated", "9%"],
      ["textAi", "9%"],
    ])
    // Unnamed, it is decoration beside numbers printed elsewhere.
    expect(bar).toHaveAttribute("aria-hidden", "true")

    rerender(<ProgressSplitBar segments={segments} label="82% translated, 64% validated" />)
    expect(screen.getByRole("img", { name: "82% translated, 64% validated" })).toBe(bar)
  })
})
