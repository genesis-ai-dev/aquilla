/**
 * InworldLanguageField — language picker when the project lane is not a code.
 */

import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { InworldLanguageField } from "./InworldLanguageField"

function Harness({ initial }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return <InworldLanguageField value={value} onChange={setValue} />
}

describe("InworldLanguageField", () => {
  it("offers Other and a typed BCP-47 field", async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole("combobox", { name: "Language" }))
    expect(screen.getByRole("option", { name: "Other" })).toBeTruthy()
    await user.click(screen.getByRole("option", { name: "Other" }))
    const code = screen.getByLabelText("Language code")
    await user.type(code, "sv-SE")
    expect(code).toHaveValue("sv-SE")
  })

  it("hydrates Other when the saved code is not in the shortlist", () => {
    render(<InworldLanguageField value="sv-SE" onChange={vi.fn()} />)
    expect(screen.getByRole("combobox", { name: "Language" })).toHaveTextContent("Other")
    expect(screen.getByLabelText("Language code")).toHaveValue("sv-SE")
  })
})
