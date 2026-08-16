import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { RevealableInput } from "./revealable-input"

describe("RevealableInput", () => {
  it("toggles password visibility via Show/Hide password", () => {
    render(<RevealableInput id="f-pass" defaultValue="secret" />)

    const input = document.getElementById("f-pass") as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input).toHaveAttribute("type", "password")
    expect(input).toHaveValue("secret")

    fireEvent.click(screen.getByRole("button", { name: /Show password/i }))
    expect(input).toHaveAttribute("type", "text")
    expect(screen.getByRole("button", { name: /Hide password/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Hide password/i }))
    expect(input).toHaveAttribute("type", "password")
    expect(screen.getByRole("button", { name: /Show password/i })).toBeInTheDocument()
  })

  it("uses Show/Hide key labels when revealKind is key", () => {
    render(<RevealableInput id="f-key" revealKind="key" defaultValue="api-key" />)

    const input = document.getElementById("f-key") as HTMLInputElement
    expect(input).toHaveAttribute("type", "password")

    fireEvent.click(screen.getByRole("button", { name: /Show key/i }))
    expect(input).toHaveAttribute("type", "text")
    expect(screen.getByRole("button", { name: /Hide key/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Hide key/i }))
    expect(input).toHaveAttribute("type", "password")
  })
})
