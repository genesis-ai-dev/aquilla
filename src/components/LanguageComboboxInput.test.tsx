import { useState } from "react"
import { describe, expect, it } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { LanguageComboboxInput } from "./LanguageComboboxInput"

/**
 * AQU-988 regression guards. The behaviour these lock down is the reason this
 * field is not a Base-UI Combobox: the previous version cleared free-typed
 * text on Enter. The real-browser proof lives in
 * `e2e/specs/projects/language-combobox.spec.ts` — these cover the wiring.
 */
function Harness({ initial = "", exclude }: { initial?: string; exclude?: string[] }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <LanguageComboboxInput
        id="lang"
        aria-label="Language"
        value={value}
        onValueChange={setValue}
        exclude={exclude}
      />
      <output data-testid="committed">{value}</output>
    </>
  )
}

/**
 * Type as a user does: focus, a real keydown, then the resulting change. The
 * keydown matters — the list only opens for keyboard-driven edits.
 */
function typeInto(input: HTMLElement, value: string) {
  ;(input as HTMLInputElement).focus()
  fireEvent.keyDown(input, { key: value.slice(-1) || "a" })
  fireEvent.change(input, { target: { value } })
}

describe("LanguageComboboxInput", () => {
  it("suggests languages matching what was typed", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "fre")

    const listbox = await screen.findByRole("listbox")
    expect(
      screen.getByRole("option", { name: /French/ }),
    ).toBeTruthy()
    expect(listbox.textContent).toContain("fr")
  })

  it("stores the display name — not the code — when a suggestion is picked", async () => {
    render(<Harness />)
    typeInto(screen.getByLabelText("Language"), "fre")

    fireEvent.click(await screen.findByRole("option", { name: /French/ }))

    expect(screen.getByTestId("committed").textContent).toBe("French")
    expect((screen.getByLabelText("Language") as HTMLInputElement).value).toBe("French")
  })

  it("keeps free-typed text and does NOT hijack Enter", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "Grade 7 English")
    fireEvent.keyDown(input, { key: "Enter" })

    expect((input as HTMLInputElement).value).toBe("Grade 7 English")
    expect(screen.getByTestId("committed").textContent).toBe("Grade 7 English")
  })

  it("leaves Enter alone even when suggestions are showing, until one is highlighted", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    // "English" matches the catalog, but nothing is highlighted yet — so
    // Enter must not overwrite what the user actually typed.
    typeInto(input, "Englis")
    await screen.findByRole("listbox")
    fireEvent.keyDown(input, { key: "Enter" })

    expect(screen.getByTestId("committed").textContent).toBe("Englis")
  })

  it("commits the highlighted suggestion once the user arrows to it", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "fr")
    await screen.findByRole("listbox")

    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(screen.getByTestId("committed").textContent).toBe("French")
  })

  it("never opens on a programmatic value change (no focus)", async () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "fre" } })
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull()
    })
  })

  it("never opens for a value set without a keystroke, even when focused", async () => {
    // Playwright's fill() and browser autofill look like this: focused field,
    // whole value in one change, no key events. An overlay here would sit on
    // top of whatever control the caller clicks next.
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    ;(input as HTMLInputElement).focus()
    fireEvent.change(input, { target: { value: "fre" } })
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull()
    })
  })

  it("hides the list once the text is already the only match", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "Frenc")
    await screen.findByRole("listbox")

    // Completing the word leaves nothing to suggest but the word itself.
    typeInto(input, "French")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
  })

  it("closes on Escape without letting it bubble to an enclosing dialog", async () => {
    const seen: string[] = []
    render(
      <div onKeyDown={(event) => seen.push(event.key)}>
        <Harness />
      </div>,
    )
    const input = screen.getByLabelText("Language")
    typeInto(input, "fre")
    await screen.findByRole("listbox")

    fireEvent.keyDown(input, { key: "Escape" })

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    expect(seen).not.toContain("Escape")
  })

  it("closes on blur", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "fre")
    await screen.findByRole("listbox")

    fireEvent.blur(input)

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
  })

  it("omits already-chosen languages from the list", async () => {
    render(<Harness exclude={["French"]} />)
    typeInto(screen.getByLabelText("Language"), "fren")

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull()
    })
  })
})
