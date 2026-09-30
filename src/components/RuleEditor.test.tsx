import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { RuleEditor } from "./RuleEditor"

function renderEditor() {
  return render(
    <RuleEditor
      cells={[]}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
}

describe("RuleEditor toggles", () => {
  it("toggles the Enabled switch aria-checked", async () => {
    const user = userEvent.setup()
    renderEditor()

    // Label wraps Switch + "Enabled" text (same locator pattern as the smoke).
    const enabledSwitch = screen
      .getByText("Enabled", { exact: true })
      .closest("label")!
      .querySelector('[role="switch"]') as HTMLElement
    expect(enabledSwitch).toBeTruthy()
    expect(enabledSwitch).toHaveAttribute("aria-checked", "true")

    await user.click(enabledSwitch)
    expect(enabledSwitch).toHaveAttribute("aria-checked", "false")

    await user.click(enabledSwitch)
    expect(enabledSwitch).toHaveAttribute("aria-checked", "true")
  })

  it("toggles severity between Minor and Major", () => {
    renderEditor()

    const minorBtn = screen.getByRole("button", { name: /^Minor$/i })
    const majorBtn = screen.getByRole("button", { name: /^Major$/i })

    expect(minorBtn).toHaveClass(/bg-amber-500/)

    fireEvent.click(majorBtn)
    expect(majorBtn).toHaveClass(/bg-red-500/)
    expect(minorBtn).not.toHaveClass(/bg-amber-500/)

    fireEvent.click(minorBtn)
    expect(minorBtn).toHaveClass(/bg-amber-500/)
    expect(majorBtn).not.toHaveClass(/bg-red-500/)
  })

  it("toggles mode Forbidden / Required / Must match and source-pattern visibility", () => {
    renderEditor()

    expect(document.getElementById("re-src-pat")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /^Required$/i }))
    expect(document.getElementById("re-src-pat")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /^Must match$/i }))
    expect(document.getElementById("re-src-pat")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /^Forbidden$/i }))
    expect(document.getElementById("re-src-pat")).toBeNull()
  })

  it("toggles regex vs literal pattern mode", () => {
    renderEditor()

    expect(screen.getByText(/Switch to literal text/i)).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Switch to literal text/i))
    expect(screen.getByText(/Switch to regex/i)).toBeInTheDocument()
    expect(screen.queryByText(/Switch to literal text/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/Switch to regex/i))
    expect(screen.getByText(/Switch to literal text/i)).toBeInTheDocument()
  })

  it("shows and hides the autofix section", () => {
    renderEditor()

    expect(screen.getByText(/Add autofix \(optional\)/i)).toBeInTheDocument()
    expect(screen.queryByText(/Autofix — regex replace/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText(/Add autofix \(optional\)/i))
    expect(screen.getByText(/Autofix — regex replace/i)).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Hide autofix/i))
    expect(screen.queryByText(/Autofix — regex replace/i)).not.toBeInTheDocument()
  })
})

// AQU-195: the editor must never present a rule it cannot save. Both cases
// below used to look authorable — the sentence read fine, the fields accepted
// input — and then failed (or silently persisted junk) on Save.
describe("RuleEditor unsaveable-draft guards (AQU-195)", () => {
  function fillNameAndPattern(pattern = "bad") {
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "R" } })
    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: pattern } })
  }

  it("disables the source side for Forbidden and Required, and explains why", () => {
    renderEditor()

    const sourceBtn = screen.getByRole("button", { name: /^Source$/i })
    expect(sourceBtn).toBeDisabled()
    expect(screen.getByRole("button", { name: /^Target$/i })).toBeEnabled()
    expect(screen.getByText(/constrain the target/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /^Required$/i }))
    expect(screen.getByRole("button", { name: /^Source$/i })).toBeDisabled()
  })

  it("snaps a source-side draft back to the target when the mode stops supporting it", () => {
    const onSave = vi.fn()
    // A `source-target-match` rule decodes to side "source" — the one way the
    // editor legitimately starts there. Switching it to Forbidden used to strand
    // the draft on an inexpressible source/mode pair.
    const matchRule = {
      id: "r1", name: "R", description: "", severity: "minor" as const,
      source: "user" as const, scope: "project" as const,
      check: { type: "source-target-match" as const, pattern: "bad" },
      enabled: true, createdAt: "2026-01-01T00:00:00.000Z",
    }
    render(<RuleEditor initialRule={matchRule} cells={[]} onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: /^Forbidden$/i }))
    expect(screen.getByRole("button", { name: /^Target$/i })).toHaveClass(/bg-primary/)

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ check: { type: "target-forbids", targetPattern: "bad" } }),
    )
  })

  it("blocks save on an invalid autofix pattern and says so before a sample is typed", () => {
    const onSave = vi.fn()
    render(<RuleEditor cells={[]} onSave={onSave} onCancel={vi.fn()} />)

    fillNameAndPattern()
    fireEvent.click(screen.getByText(/Add autofix \(optional\)/i))
    fireEvent.change(screen.getByLabelText("Find pattern"), { target: { value: "(unclosed" } })

    expect(screen.getByText(/Invalid autofix pattern/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("blocks save on invalid autofix flags", () => {
    const onSave = vi.fn()
    render(<RuleEditor cells={[]} onSave={onSave} onCancel={vi.fn()} />)

    fillNameAndPattern()
    fireEvent.click(screen.getByText(/Add autofix \(optional\)/i))
    fireEvent.change(screen.getByLabelText("Find pattern"), { target: { value: "a" } })
    fireEvent.change(screen.getByLabelText("Flags"), { target: { value: "gg" } })

    fireEvent.click(screen.getByRole("button", { name: "Create rule" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("still saves a valid autofix", () => {
    const onSave = vi.fn()
    render(<RuleEditor cells={[]} onSave={onSave} onCancel={vi.fn()} />)

    fillNameAndPattern()
    fireEvent.click(screen.getByText(/Add autofix \(optional\)/i))
    fireEvent.change(screen.getByLabelText("Find pattern"), { target: { value: "bad" } })
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "good" } })

    fireEvent.click(screen.getByRole("button", { name: "Create rule" }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        autofix: { kind: "regex-replace", pattern: "bad", replacement: "good", flags: "gi" },
      }),
    )
  })
})

// AQU-609: lane scoping in the editor. WHY: the saved `scope`/`lane` decide
// which lanes a rule constrains — a wrong payload here means a French-only
// rule silently lints every lane (or an org rule degrades to project scope on
// its next edit, which was a real latent bug this change fixed). The picker
// is a dropdown, not buttons: projects can carry 150+ lanes.
describe("RuleEditor lane scope (AQU-609)", () => {
  function fillRequired() {
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "R" } })
    fireEvent.change(screen.getByLabelText("Pattern"), { target: { value: "bad" } })
  }

  it("hides the lane picker without lanes and saves project scope", () => {
    const onSave = vi.fn()
    render(<RuleEditor cells={[]} onSave={onSave} onCancel={vi.fn()} />)
    expect(screen.queryByText("Applies to")).not.toBeInTheDocument()
    fillRequired()
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ scope: "project" }))
  })

  it("saves scope lane + the picked lane when a lane is chosen from the dropdown", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <RuleEditor
        cells={[]}
        onSave={onSave}
        onCancel={vi.fn()}
        lanes={["fr", "es"]}
        defaultLaneLabel="Spanish (base)"
      />,
    )
    const trigger = screen.getByRole("combobox", { name: "Applies to" })
    await user.click(trigger)
    // All scopes are offered: every lane, the labeled default lane, both tags.
    expect(await screen.findByRole("option", { name: "All lanes" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Spanish (base)" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "es" })).toBeInTheDocument()
    fillRequired()
    await user.click(screen.getByRole("option", { name: "fr" }))
    fireEvent.click(screen.getByRole("button", { name: "Create rule" }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "lane", lane: "fr" }),
    )
  })

  it("clears the lane pin when switching a lane rule back to All lanes", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const initialRule = {
      id: "r1", name: "R", description: "", severity: "minor" as const,
      source: "user" as const, scope: "lane" as const, lane: "fr",
      check: { type: "target-forbids" as const, targetPattern: "bad" },
      enabled: true, createdAt: "2026-01-01T00:00:00.000Z",
    }
    render(
      <RuleEditor
        initialRule={initialRule}
        cells={[]}
        onSave={onSave}
        onCancel={vi.fn()}
        lanes={["fr", "es"]}
      />,
    )
    await user.click(screen.getByRole("combobox", { name: "Applies to" }))
    await user.click(await screen.findByRole("option", { name: "All lanes" }))
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "project", lane: undefined }),
    )
  })

  it("preserves org scope when editing without a lane picker (no silent downgrade)", () => {
    const onSave = vi.fn()
    const orgRule = {
      id: "r1", name: "Org rule", description: "", severity: "minor" as const,
      source: "user" as const, scope: "org" as const,
      check: { type: "target-forbids" as const, targetPattern: "bad" },
      enabled: true, createdAt: "2026-01-01T00:00:00.000Z",
    }
    render(<RuleEditor initialRule={orgRule} cells={[]} onSave={onSave} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ scope: "org" }))
  })
})
