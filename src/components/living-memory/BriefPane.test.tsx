// src/components/living-memory/BriefPane.test.tsx
//
// AQU-1671: the pane gated generation on `completionSettings` being *present*,
// so a project on the Frontier platform default (which never writes that
// object) was told "no AI provider configured", and any project failed the
// same way while the project record was still hydrating. These tests pin the
// gate to "does a provider resolve", not "was the project customized".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { BriefPane } from "./BriefPane"
import { emptyBrief } from "@/lib/brief/brief"
import type { TranslationBrief } from "@/lib/brief/types"
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

/** A brief with content, so the pane generates instead of opening the builder. */
function briefWithContent(): TranslationBrief {
  const b = emptyBrief("tester")
  return { ...b, parameters: { purpose: "Evangelistic for youth" } }
}

function renderPane(completionSettings: CompletionSettings | undefined) {
  const patch = vi.fn().mockResolvedValue(undefined)
  render(
    <BriefPane
      brief={briefWithContent()}
      canEdit
      author="tester"
      completionSettings={completionSettings}
      session={{ username: "tester", jwt: "jwt-token" } as never}
      patch={patch}
    />,
  )
  return { patch }
}

function clickGenerate() {
  fireEvent.click(screen.getByRole("button", { name: /generate summary/i }))
}

describe("BriefPane — AI provider gate (AQU-1671)", () => {
  beforeEach(() => {
    generateL1Summary.mockReset().mockResolvedValue("A generated L1 summary.")
    toastAdd.mockReset()
    localStorage.clear()
  })
  afterEach(() => localStorage.clear())

  it("generates on the Frontier platform default when the project never customized AI", async () => {
    // The exact shape a fresh project produces: no completionSettings at all.
    renderPane(undefined)
    clickGenerate()
    await waitFor(() => expect(generateL1Summary).toHaveBeenCalledTimes(1))
    // The default must be handed to the generator, not `undefined`.
    expect(generateL1Summary.mock.calls[0][1]).toMatchObject({ provider: "frontier" })
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("does not report 'no AI provider configured' while the project record is hydrating", async () => {
    // Same undefined settings, clicked before the record resolves — the old
    // gate produced a false negative here, which is the reported flake.
    renderPane(undefined)
    clickGenerate()
    await waitFor(() => expect(generateL1Summary).toHaveBeenCalled())
    const titles = toastAdd.mock.calls.map((c) => String(c[0]?.title ?? ""))
    expect(titles.some((t) => /no ai provider configured/i.test(t))).toBe(false)
  })

  it("generates for a project explicitly on the frontier provider", async () => {
    renderPane({ provider: "frontier", endpoint: "", model: "" } as CompletionSettings)
    clickGenerate()
    await waitFor(() => expect(generateL1Summary).toHaveBeenCalledTimes(1))
    expect(toastAdd).not.toHaveBeenCalled()
  })

  it("still refuses, naming the fix location, when a custom provider has no endpoint", async () => {
    renderPane({ provider: "custom", endpoint: "", model: "" } as CompletionSettings)
    clickGenerate()
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1))
    expect(generateL1Summary).not.toHaveBeenCalled()
    const arg = toastAdd.mock.calls[0][0]
    expect(arg.type).toBe("warning")
    expect(arg.title).toMatch(/no ai provider configured/i)
    // The message must name where to go, per the issue's acceptance criteria.
    expect(arg.description).toMatch(/Project Settings → AI & completion/i)
  })

  it("points at user Settings when a personal device override is the broken provider", async () => {
    localStorage.setItem(
      "aquilla:userProviderOverride",
      JSON.stringify({ endpoint: "https://openrouter.ai/api/v1" }),
    )
    renderPane(undefined)
    clickGenerate()
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1))
    expect(generateL1Summary).not.toHaveBeenCalled()
    // Project Settings does not own the personal override, so naming it would
    // send the user to the wrong screen.
    expect(toastAdd.mock.calls[0][0].description).toMatch(/Personal AI provider/i)
  })

  it("leaves a configured BYO-provider project generating with its own settings", async () => {
    const byo = {
      provider: "custom",
      endpoint: "http://localhost:8000",
      model: "local-model",
    } as CompletionSettings
    renderPane(byo)
    clickGenerate()
    await waitFor(() => expect(generateL1Summary).toHaveBeenCalledTimes(1))
    expect(generateL1Summary.mock.calls[0][1]).toMatchObject({
      endpoint: "http://localhost:8000",
      model: "local-model",
    })
    expect(toastAdd).not.toHaveBeenCalled()
  })
})
