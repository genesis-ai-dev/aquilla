import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ValidatedBar } from "./ValidatedBar"

/** The bar's parts as "tone width", in drawing order. */
const parts = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-progress-tone]")]
    .map((part) => `${part.dataset.progressTone} ${part.style.width}`)

describe("ValidatedBar (AQU-1493)", () => {
  it("never rounds a project with work left up to 100%", () => {
    const { container } = render(<ValidatedBar fraction={1207 / 1208} />)
    expect(screen.getByText("99%")).toBeInTheDocument()
    // Nor draws the bar full, which is what the eye reads first.
    expect(parts(container)).toEqual(["textValidated 99%"])
  })

  it("reads 100% only when everything is validated", () => {
    const { container } = render(<ValidatedBar fraction={1} />)
    expect(screen.getByText("100%")).toBeInTheDocument()
    expect(parts(container)).toEqual(["textValidated 100%"])
  })
})

// AQU-1764 (Sam, 2026-10-13): no more amber-to-emerald heat map. Validated is
// the shared palette's dark blue at any level, followed by what is translated
// but not validated where the caller knows it (the org overview does; the
// admin tables have no translated count).
describe("ValidatedBar in the shared progress palette (AQU-1764)", () => {
  it.each<[string, { fraction: number; translatedFraction?: number }, string[]]>([
    ["early work is the same blue as nearly done work", { fraction: 0.1 }, ["textValidated 10%"]],
    ["with a translated figure, a second part follows", { fraction: 0.64, translatedFraction: 0.82 }, ["textValidated 64%", "textTranslated 18%"]],
    ["nothing validated yet, only translated", { fraction: 0, translatedFraction: 0.4 }, ["textTranslated 40%"]],
  ])("%s", (_name, props, expected) => {
    const { container } = render(<ValidatedBar {...props} />)
    expect(parts(container)).toEqual(expected)
  })
})
