// AQU-2263: "Count headings" and "Auto-propagate repetitions" use the same
// "Organization default (on) / Set for this project" menu as every other
// organization default on Project settings, beside a switch that shows the
// value in force and can be flipped straight away.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { renderWithTooltips } from "@/test-utils/tooltip"
import { StructuralCellsProjectSection } from "./StructuralCellsProjectSection"
import { RepetitionPropagationProjectSection } from "./RepetitionPropagationProjectSection"

const LOCK = "Only Project leads can modify"
const isOn = (el: HTMLElement) => el.getAttribute("aria-checked") === "true" || el.hasAttribute("data-checked")
const isDisabled = (el: HTMLElement) =>
  el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled")

describe("StructuralCellsProjectSection", () => {
  const headingsSwitch = () => screen.getByRole("switch", { name: "Count headings as translatable content" })
  const headingsSource = () => screen.getByTestId("count-structural-cells-source")

  it("while it follows the organization, the menu says so and the switch shows the organization's answer", () => {
    const onPatch = vi.fn(async () => ({ kind: "ok" }))
    renderWithTooltips(<StructuralCellsProjectSection value={undefined} orgDefault={false} onPatch={onPatch} />)
    expect(headingsSource()).toHaveTextContent("Organization default (off)")
    expect(isOn(headingsSwitch())).toBe(false)
    expect(isDisabled(headingsSwitch())).toBe(false)
  })

  it("flipping the switch while it follows the organization sets it for this project in one step", async () => {
    const onPatch = vi.fn(async () => ({ kind: "ok" }))
    renderWithTooltips(<StructuralCellsProjectSection value={undefined} orgDefault onPatch={onPatch} />)
    await userEvent.click(headingsSwitch())
    expect(onPatch).toHaveBeenCalledExactlyOnceWith({ countStructuralCells: false })
  })

  it("a project's own answer shows 'Set for this project', and the organization default removes it", async () => {
    const onPatch = vi.fn(async () => ({ kind: "ok" }))
    renderWithTooltips(<StructuralCellsProjectSection value={false} orgDefault onPatch={onPatch} />)
    expect(headingsSource()).toHaveTextContent("Set for this project")
    expect(isOn(headingsSwitch())).toBe(false)
    await userEvent.click(headingsSource())
    await userEvent.click(await screen.findByRole("option", { name: "Organization default (on)" }))
    expect(onPatch).toHaveBeenCalledExactlyOnceWith({ countStructuralCells: undefined })
  })

  it("'Set for this project' starts from the organization's answer", async () => {
    const onPatch = vi.fn(async () => ({ kind: "ok" }))
    renderWithTooltips(<StructuralCellsProjectSection value={undefined} orgDefault onPatch={onPatch} />)
    await userEvent.click(headingsSource())
    await userEvent.click(await screen.findByRole("option", { name: "Set for this project" }))
    expect(onPatch).toHaveBeenCalledExactlyOnceWith({ countStructuralCells: true })
  })

  it("locked: neither the menu nor the switch can be changed", () => {
    const onPatch = vi.fn(async () => ({ kind: "ok" }))
    renderWithTooltips(
      <StructuralCellsProjectSection value={undefined} orgDefault disabled disabledTooltip={LOCK} onPatch={onPatch} />,
    )
    expect(isDisabled(headingsSwitch())).toBe(true)
    expect(isDisabled(headingsSource())).toBe(true)
  })

  it("says why when the save is refused", async () => {
    const onPatch = vi.fn(async () => ({ kind: "blocked", message: "Only Project leads can change this." }))
    renderWithTooltips(<StructuralCellsProjectSection value={undefined} orgDefault onPatch={onPatch} />)
    await userEvent.click(headingsSwitch())
    expect(await screen.findByText("Only Project leads can change this.")).toBeInTheDocument()
  })
})

describe("RepetitionPropagationProjectSection", () => {
  const repeatSwitch = () => screen.getByRole("switch", { name: "Auto-propagate repetitions" })
  const repeatSource = () => screen.getByTestId("auto-propagate-repetitions-source")

  it("follows the organization with the same menu, and flipping it sets it for this project", async () => {
    const onPatch = vi.fn(async () => ({ kind: "ok" }))
    renderWithTooltips(<RepetitionPropagationProjectSection value={undefined} orgDefault onPatch={onPatch} />)
    expect(repeatSource()).toHaveTextContent("Organization default (on)")
    expect(isOn(repeatSwitch())).toBe(true)
    await userEvent.click(repeatSwitch())
    expect(onPatch).toHaveBeenCalledExactlyOnceWith({ autoPropagateRepetitions: false })
  })

  it("the organization default removes the project's own answer", async () => {
    const onPatch = vi.fn(async () => ({ kind: "ok" }))
    renderWithTooltips(<RepetitionPropagationProjectSection value orgDefault={false} onPatch={onPatch} />)
    expect(repeatSource()).toHaveTextContent("Set for this project")
    await userEvent.click(repeatSource())
    await userEvent.click(await screen.findByRole("option", { name: "Organization default (off)" }))
    expect(onPatch).toHaveBeenCalledExactlyOnceWith({ autoPropagateRepetitions: undefined })
  })

  it("locked: the switch cannot be flipped", () => {
    const onPatch = vi.fn(async () => ({ kind: "ok" }))
    renderWithTooltips(
      <RepetitionPropagationProjectSection value={undefined} orgDefault={false} disabled disabledTooltip={LOCK} onPatch={onPatch} />,
    )
    expect(isDisabled(repeatSwitch())).toBe(true)
  })
})
