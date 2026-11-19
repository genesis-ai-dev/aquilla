// Sam, question 93: the Export dialog's "Mono loudness" option.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MonoLoudnessOption } from "./MonoLoudnessOption"

describe("Mono loudness", () => {
  it("offers As heard and the meter reading, on the value given", () => {
    render(<MonoLoudnessOption value="heard" onChange={() => {}} />)
    expect(screen.getByRole("radiogroup", { name: "Mono loudness" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "As heard" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radio", { name: "As a single-channel meter reads it" })).toHaveAttribute("aria-checked", "false")
  })

  it("says which choice was picked", () => {
    const onChange = vi.fn()
    render(<MonoLoudnessOption value="heard" onChange={onChange} />)
    fireEvent.click(screen.getByRole("radio", { name: "As a single-channel meter reads it" }))
    expect(onChange).toHaveBeenCalledWith("meter")
  })

  it("keeps the explanation behind a click (i), not a hover", () => {
    render(<MonoLoudnessOption value="heard" onChange={() => {}} />)
    const info = screen.getByRole("button", { name: "About mono loudness" })
    const text = screen.getByTestId("export-mono-loudness-info")
    expect(text).toHaveAttribute("data-open", "false")
    fireEvent.mouseEnter(info)
    expect(text).toHaveAttribute("data-open", "false")
    fireEvent.click(info)
    expect(text).toHaveAttribute("data-open", "true")
    expect(text).toHaveTextContent("A mono file plays on both speakers, so it sounds about 3 dB louder than one channel measures. Pick the meter reading if a delivery checks mono files on a loudness meter.")
  })
})
