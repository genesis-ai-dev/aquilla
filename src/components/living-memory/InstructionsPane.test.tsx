// src/components/living-memory/InstructionsPane.test.tsx
//
// AQU-2342: "Help me write this" runs the brief interview, and its generated
// summary lands IN the instructions text (appended, never duplicated) and is
// saved under `translationInstructions` — not kept as a separate brief.
//
// AQU-1671 (carried over from the retired BriefPane): generation is gated on
// "does a provider resolve", not on the project having customized AI — a
// project on the Aquilla default must generate.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { InstructionsPane } from "./InstructionsPane"
import { mergeIntoInstructions } from "./instructions-merge"
import type { CompletionSettings } from "@/lib/parsers/types"

const generateL1Summary = vi.hoisted(() => vi.fn())
const toastAdd = vi.hoisted(() => vi.fn())

vi.mock("@/lib/brief/brief-generator", () => ({
  generateL1Summary,
  extractBriefFromDocument: vi.fn(),
  draftField: vi.fn(),
}))

vi.mock("@/components/ui/toast", () => ({
  toast: { add: toastAdd },
}))

function renderPane({
  resolved = "",
  completionSettings,
}: { resolved?: string; completionSettings?: CompletionSettings } = {}) {
  const patch = vi.fn().mockResolvedValue({ kind: "ok" })
  render(
    <InstructionsPane
      resolved={resolved}
      canEdit
      reasonCannotEdit={null}
      patch={patch}
      brief={undefined}
      author="tester"
      completionSettings={completionSettings}
      session={{ username: "tester", jwt: "jwt-token" } as never}
    />,
  )
  return { patch }
}

/** Open the interview, answer the first question, and finish it. */
async function runInterview() {
  fireEvent.click(screen.getByRole("button", { name: "Help me write this" }))
  const dialog = screen.getByRole("dialog", { name: "Help writing the instructions" })
  // The first question's answer box (not the optional paste-to-prefill box).
  const answer = Array.from(dialog.querySelectorAll("textarea")).find(
    (el) => !el.placeholder,
  ) as HTMLTextAreaElement
  fireEvent.change(answer, { target: { value: "Evangelistic for youth" } })
  let next = screen.queryByRole("button", { name: /^next$/i })
  while (next) {
    fireEvent.click(next)
    next = screen.queryByRole("button", { name: /^next$/i })
  }
  fireEvent.click(screen.getByRole("button", { name: "Add to instructions" }))
}

describe("mergeIntoInstructions", () => {
  it("uses the summary alone when there is no text yet", () => {
    expect(mergeIntoInstructions("", "  For youth. ")).toBe("For youth.")
  })

  it("appends after a blank line", () => {
    expect(mergeIntoInstructions("Plain register.\n", "For youth.")).toBe("Plain register.\n\nFor youth.")
  })

  it("leaves the text alone when the summary is already in it", () => {
    const text = "Plain register.\n\nFor   youth."
    expect(mergeIntoInstructions(text, "for youth.")).toBe(text)
  })

  it("never exceeds the stored maximum", () => {
    expect(mergeIntoInstructions("a".repeat(7990), "b".repeat(50))).toHaveLength(8000)
  })
})

describe("InstructionsPane — interview writes into the instructions (AQU-2342)", () => {
  beforeEach(() => {
    generateL1Summary.mockReset().mockResolvedValue("Draft for young readers.")
    toastAdd.mockReset()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it("appends the generated summary to the existing text and saves the instructions", async () => {
    const { patch } = renderPane({ resolved: "Keep names as in the 1999 Bible." })
    await runInterview()

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({
        translationInstructions: "Keep names as in the 1999 Bible.\n\nDraft for young readers.",
      }),
    )
    // The interview answers are still kept as brief data.
    expect(patch).toHaveBeenCalledWith(
      expect.objectContaining({
        translationBrief: expect.objectContaining({
          parameters: expect.objectContaining({ purpose: "Evangelistic for youth" }),
        }),
      }),
    )
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "Keep names as in the 1999 Bible.\n\nDraft for young readers.",
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("does not duplicate a summary the instructions already contain", async () => {
    const { patch } = renderPane({ resolved: "Draft for young readers." })
    await runInterview()

    await waitFor(() => expect(generateL1Summary).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue("Draft for young readers.")
    const writes = patch.mock.calls.map(([partial]) => partial as Record<string, unknown>)
    expect(writes.some((w) => "translationInstructions" in w)).toBe(false)
  })
})

describe("InstructionsPane — AI provider gate (AQU-1671)", () => {
  beforeEach(() => {
    generateL1Summary.mockReset().mockResolvedValue("A generated summary.")
    toastAdd.mockReset()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it("generates on the Aquilla default when the project never customized AI", async () => {
    renderPane()
    await runInterview()
    await waitFor(() => expect(generateL1Summary).toHaveBeenCalledTimes(1))
    expect(generateL1Summary.mock.calls[0][1]).toMatchObject({ provider: "frontier" })
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("keeps the answers and names the fix location when a custom provider has no endpoint", async () => {
    const { patch } = renderPane({
      completionSettings: { provider: "custom", endpoint: "", model: "" } as CompletionSettings,
    })
    await runInterview()
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1))
    expect(generateL1Summary).not.toHaveBeenCalled()
    expect(toastAdd.mock.calls[0][0].description).toMatch(/Project settings → AI → AI model \(advanced\)/i)
    // The answers saved; the instructions did not change; the dialog stays open.
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ translationBrief: expect.anything() }))
    expect(patch).not.toHaveBeenCalledWith(expect.objectContaining({ translationInstructions: expect.anything() }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("points at user Settings when a personal device override is the broken provider", async () => {
    localStorage.setItem(
      "aquilla:userProviderOverride",
      JSON.stringify({ endpoint: "https://openrouter.ai/api/v1" }),
    )
    renderPane()
    await runInterview()
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1))
    expect(generateL1Summary).not.toHaveBeenCalled()
    expect(toastAdd.mock.calls[0][0].description).toMatch(/Personal AI provider/i)
  })
})
