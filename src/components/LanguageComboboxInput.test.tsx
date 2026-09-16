import { useState } from "react"
import { describe, expect, it } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { LanguageComboboxInput } from "./LanguageComboboxInput"

/**
 * AQU-988 regression guards. The behaviour these lock down is the reason this
 * field is not a Base-UI Combobox: the previous version cleared free-typed
 * text on Enter. The real-browser proof lives in
 * `e2e/specs/projects/language-combobox.spec.ts` — these cover the wiring.
 *
 * AQU-1116 pre-highlights the top-ranked match so type-then-Enter selects it.
 * That narrows, but does not lift, the AQU-988 guarantee: Enter is claimed
 * only while the list has matches, so free text ("Grade 7 English") and a
 * settled exact name ("French") both still fall through untouched.
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

  /**
   * AQU-1116 — the top match is pre-highlighted so type-then-Enter selects it.
   * This is the one AQU-988 rule that was deliberately relaxed; the guard that
   * replaces it is "a highlight exists only while there are matches", covered
   * by the free-text cases above and below.
   */
  it("pre-highlights the top match as soon as the list has one", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "Eng")
    await screen.findByRole("listbox")

    const options = screen.getAllByRole("option")
    expect(options[0]!.textContent).toContain("English")
    expect(options[0]!.getAttribute("aria-selected")).toBe("true")
    // Only the top row — the rest stay unhighlighted.
    expect(options.slice(1).every((o) => o.getAttribute("aria-selected") === "false")).toBe(true)
  })

  it("selects the pre-highlighted top match on Enter, without arrowing first", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "Englis")
    await screen.findByRole("listbox")
    fireEvent.keyDown(input, { key: "Enter" })

    expect(screen.getByTestId("committed").textContent).toBe("English")
    expect((input as HTMLInputElement).value).toBe("English")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
  })

  it("ranks a code match first, so typing a code then Enter picks that language", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "fr")
    await screen.findByRole("listbox")
    fireEvent.keyDown(input, { key: "Enter" })

    expect(screen.getByTestId("committed").textContent).toBe("French")
  })

  it("moves the highlight off the top row with ArrowDown", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "fr")
    await screen.findByRole("listbox")
    // Second row before arrowing — Enter after one ArrowDown must land here,
    // i.e. the arrow steps *from* the pre-highlight rather than re-seeding it.
    const second = screen.getAllByRole("option")[1]!.textContent

    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })

    const committed = screen.getByTestId("committed").textContent!
    expect(committed).not.toBe("French")
    expect(second).toContain(committed)
  })

  it("re-seeds the highlight to the new best match as the query changes", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "g")
    await screen.findByRole("listbox")
    typeInto(input, "ger")

    const options = screen.getAllByRole("option")
    expect(options[0]!.getAttribute("aria-selected")).toBe("true")
    expect(options[0]!.textContent).toContain("German")

    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("committed").textContent).toBe("German")
  })

  it("drops the highlight when an edit leaves no matches, so Enter stays free text", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "Eng")
    await screen.findByRole("listbox")
    // Extending a matching prefix into free text must release Enter again.
    typeInto(input, "Grade 7 English")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())

    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("committed").textContent).toBe("Grade 7 English")
    expect((input as HTMLInputElement).value).toBe("Grade 7 English")
  })

  it("leaves Enter alone once the text is exactly a catalog name", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "Frenc")
    await screen.findByRole("listbox")
    // The list hides itself here (isSettledLanguage), so Enter must not fire a
    // second, duplicate selection.
    typeInto(input, "French")
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())

    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("committed").textContent).toBe("French")
  })

  it("keeps the typed text when Escape dismisses a pre-highlighted list", async () => {
    render(<Harness />)
    const input = screen.getByLabelText("Language")
    typeInto(input, "Eng")
    await screen.findByRole("listbox")

    fireEvent.keyDown(input, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())

    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("committed").textContent).toBe("Eng")
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

  /**
   * AQU-1116 — `onEnterSelect` is how a field that commits on Enter (the
   * add-lane input) commits the *match* instead of the typed prefix: Enter has
   * already been claimed by the highlighted row, so the field's own onKeyDown
   * never runs and it cannot read the resolved name any other way.
   */
  describe("onEnterSelect", () => {
    function CommitHarness({ commits }: { commits: string[] }) {
      const [value, setValue] = useState("")
      return (
        <LanguageComboboxInput
          aria-label="Language"
          value={value}
          onValueChange={setValue}
          onEnterSelect={(name) => {
            setValue(name)
            commits.push(name)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") commits.push(`typed:${value}`)
          }}
        />
      )
    }

    it("hands Enter the matched name, not the typed prefix", async () => {
      const commits: string[] = []
      render(<CommitHarness commits={commits} />)
      const input = screen.getByLabelText("Language")
      typeInto(input, "Spa")
      await screen.findByRole("listbox")

      fireEvent.keyDown(input, { key: "Enter" })

      expect(commits).toEqual(["Spanish"])
    })

    it("still falls through to the field's own Enter for free text", async () => {
      const commits: string[] = []
      render(<CommitHarness commits={commits} />)
      const input = screen.getByLabelText("Language")
      typeInto(input, "Grade 7 English")

      fireEvent.keyDown(input, { key: "Enter" })

      expect(commits).toEqual(["typed:Grade 7 English"])
    })

    it("is not used for a mouse click, which only fills the field", async () => {
      const commits: string[] = []
      render(<CommitHarness commits={commits} />)
      typeInto(screen.getByLabelText("Language"), "Spa")

      fireEvent.click(await screen.findByRole("option", { name: /Spanish/ }))

      expect(commits).toEqual([])
      expect((screen.getByLabelText("Language") as HTMLInputElement).value).toBe("Spanish")
    })
  })
})
