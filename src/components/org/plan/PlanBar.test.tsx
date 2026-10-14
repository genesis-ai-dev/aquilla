import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { PlanBar, type PlanBarTone } from "./PlanBar"

/** The bar's parts as "tone width", in the order they are drawn. */
function drawn(tone: PlanBarTone, outer: number, inner: number) {
  const { container } = render(<PlanBar label="TXT" outer={outer} inner={inner} tone={tone} aria="bar" />)
  return [...container.querySelectorAll<HTMLElement>("[data-progress-tone]")]
    .map((part) => `${part.dataset.progressTone} ${part.style.width}`)
}

// AQU-1764 (Sam, 2026-10-13): the plan board's bars draw from the shared
// progress palette — validated first in the strong tone, then what is done but
// not validated in the soft one, as two parts with a gap between them.
describe("PlanBar parts (AQU-1764)", () => {
  it.each<[string, PlanBarTone, number, number, string[]]>([
    ["text: validated, then translated", "text", 82, 64, ["textValidated 64%", "textTranslated 18%"]],
    ["audio: validated, then recorded", "audio", 36, 27, ["audioValidated 27%", "audioRecorded 9%"]],
    ["a finished medium is one part", "text", 100, 100, ["textValidated 100%"]],
    ["nothing validated yet is one part", "audio", 40, 0, ["audioRecorded 40%"]],
    ["validated never draws wider than the measure it sits inside", "text", 40, 60, ["textValidated 40%"]],
    ["nothing done draws only the track", "text", 0, 0, []],
  ])("%s", (_name, tone, outer, inner, expected) => {
    expect(drawn(tone, outer, inner)).toEqual(expected)
  })

  it("keeps the readout's two percentages beside the bar", () => {
    const { container } = render(<PlanBar label="AUD" outer={36} inner={27} tone="audio" aria="Recorded 36%, validated 27%" />)
    expect(container.firstElementChild).toHaveAttribute("aria-label", "Recorded 36%, validated 27%")
    expect(container).toHaveTextContent(/^AUD36% \| 27%$/)
  })
})
