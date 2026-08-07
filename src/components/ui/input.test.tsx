import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Input } from "./input"
import { Textarea } from "./textarea"

describe("Input autocomplete defaults", () => {
  it("defaults autocomplete to off for app surfaces", () => {
    render(<Input aria-label="username" />)
    expect(screen.getByLabelText("username")).toHaveAttribute("autocomplete", "off")
  })

  it("lets auth forms opt into browser credential fill", () => {
    render(<Input aria-label="login-user" autoComplete="username" />)
    expect(screen.getByLabelText("login-user")).toHaveAttribute(
      "autocomplete",
      "username",
    )
  })
})

describe("Textarea autocomplete defaults", () => {
  it("defaults autocomplete to off", () => {
    render(<Textarea aria-label="notes" />)
    expect(screen.getByLabelText("notes")).toHaveAttribute("autocomplete", "off")
  })

  it("is not resizable and scrolls overflow inside a fixed min height", () => {
    render(<Textarea aria-label="notes" />)
    const el = screen.getByLabelText("notes")
    expect(el).toHaveClass("resize-none")
    expect(el).toHaveClass("overflow-y-auto")
    expect(el).toHaveClass("min-h-24")
    expect(el).not.toHaveClass("field-sizing-content")
  })
})
