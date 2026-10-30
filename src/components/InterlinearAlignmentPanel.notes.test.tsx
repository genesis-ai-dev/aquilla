// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. The
// alignment panel's help, its pills and a reviewer's locked ✓ explain
// themselves on a click. (The main suite mocks AppTooltip; this one does not.)

import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { InterlinearAlignmentPanel } from "./InterlinearAlignmentPanel"
import { buildAlignmentModel, MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT } from "@/lib/completion/interlinear"
import type { MorphWord } from "@/lib/sync/morph-read"
import { expectClickNote, expectDisabledNote, expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

const noop = () => undefined
const n = MIN_PAIRS_FOR_MEANINGFUL_ALIGNMENT + 5
const godModel = () =>
  buildAlignmentModel(Array.from({ length: n }, () => ({ source: "god created", target: "gott schuf" })), [])
const greekModel = () =>
  buildAlignmentModel(Array.from({ length: n }, () => ({ source: "λογος", target: "word" })), [])
const morph = (wordSeq: number, surface: string, extra: Partial<MorphWord> = {}): MorphWord =>
  ({ cellId: "c1", wordSeq, surface, ...extra })

function drawGod(editable = true) {
  return renderWithTooltips(
    <InterlinearAlignmentPanel
      sourceText="god created" targetText="gott schuf" alignmentModel={godModel()}
      confirmedSeeds={[]} onSeedChange={noop} editable={editable}
    />,
  )
}

describe("InterlinearAlignmentPanel — explanations open on click (AQU-2260)", () => {
  it("the Alignment help opens on a click of its (i)", async () => {
    drawGod()
    await expectClickNote(screen.getByRole("button", { name: "About Alignment" }), "Confirm correct pairs to teach the glosser")
  })

  it("the ✓ and ✕ hovers only name them", async () => {
    drawGod()
    const confirm = screen.getAllByRole("button", { name: /confirm alignment/i })[0]
    await expectTooltip(confirm, "Confirm")
    expect(screen.getByRole("tooltip").textContent).not.toMatch(/teach the statistical glosser/)
  })

  it("the ✕ hover only names it", async () => {
    drawGod()
    const reject = screen.getAllByRole("button", { name: /reject alignment/i })[0]
    await expectTooltip(reject, "Reject")
    expect(screen.getByRole("tooltip").textContent).not.toMatch(/penalized/)
  })

  it("a confidence pill says what its number is on a click", async () => {
    drawGod()
    const pill = screen.getAllByText(/^\d+%$/)[0]
    await expectClickNote(pill, "% confidence")
  })

  it("a reviewer's locked ✓ says why on a click", async () => {
    drawGod(false)
    const locked = screen.getAllByRole("button", { name: "Contributor+ required to confirm or reject alignments" })[0]
    await expectDisabledNote(locked, "Contributor+ required to confirm or reject alignments")
  })

  it("the original-language help and the via-lemma mark open on a click", async () => {
    render(
      <InterlinearAlignmentPanel
        sourceText="λογον" targetText="word" alignmentModel={greekModel()}
        confirmedSeeds={[]} onSeedChange={noop}
        originalWords={[morph(1, "λογον", { lemma: "λογος" })]}
      />,
    )
    await expectClickNote(screen.getByText("via lemma"), "Matched through the dictionary form")
  })

  it("the original-language section's help opens on a click of its (i)", async () => {
    render(
      <InterlinearAlignmentPanel
        sourceText="λογος" targetText="word" alignmentModel={greekModel()}
        confirmedSeeds={[]} onSeedChange={noop}
        originalWords={[morph(1, "λογος", { lemma: "λογος" })]}
      />,
    )
    await expectClickNote(screen.getByRole("button", { name: "About Original language" }), "Every word of the original-language source")
  })
})
