import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { pickSelectOption } from "@/test-utils/select"
import { PersonalProviderSection } from "./PersonalProviderSection"

let stored: { endpoint: string; model?: string; apiKey?: string } | null = null
const setUserProviderOverride = vi.fn(
  (next: { endpoint: string; model?: string; apiKey?: string }) => {
    stored = next
  },
)
vi.mock("@/lib/store/user-provider-override", () => ({
  getUserProviderOverride: () => stored,
  setUserProviderOverride: (next: { endpoint: string; model?: string; apiKey?: string }) =>
    setUserProviderOverride(next),
  clearUserProviderOverride: () => {
    stored = null
  },
}))

beforeEach(() => {
  stored = null
  setUserProviderOverride.mockClear()
})

/** Open the "advanced" disclosure the section is hidden behind. */
function openSection() {
  fireEvent.click(screen.getByRole("button", { name: /advanced|personal|provider/i }))
}

function endpointInput(): HTMLInputElement {
  return screen.getByLabelText(/endpoint/i) as HTMLInputElement
}

describe("PersonalProviderSection — provider presets (AQU-796)", () => {
  it("offers a provider picker alongside the endpoint field", () => {
    render(<PersonalProviderSection />)
    openSection()
    expect(screen.getByRole("combobox", { name: /preset|provider/i })).toBeInTheDocument()
    expect(endpointInput()).toBeInTheDocument()
  })

  it("pre-fills the endpoint when a known provider is chosen", async () => {
    render(<PersonalProviderSection />)
    openSection()

    await pickSelectOption(/preset|provider/i, /^OpenAI$/)

    await waitFor(() => {
      expect(endpointInput().value).toBe("https://api.openai.com/v1")
    })
  })

  it("keeps a hand-entered endpoint when the custom option is chosen", async () => {
    render(<PersonalProviderSection />)
    openSection()

    const input = endpointInput()
    fireEvent.change(input, { target: { value: "https://llm.example.internal/v1" } })

    await pickSelectOption(/preset|provider/i, /other|custom/i)

    await waitFor(() => {
      expect(endpointInput().value).toBe("https://llm.example.internal/v1")
    })
  })

  it("saves the pre-filled endpoint without the user typing a URL", async () => {
    render(<PersonalProviderSection />)
    openSection()

    await pickSelectOption(/preset|provider/i, /^OpenRouter$/)
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-or-test" } })
    fireEvent.click(screen.getByRole("button", { name: /save override|update override/i }))

    await waitFor(() => expect(setUserProviderOverride).toHaveBeenCalled())
    expect(setUserProviderOverride.mock.calls[0][0]).toMatchObject({
      endpoint: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test",
    })
  })

  it("re-derives the picker from an endpoint the user types", async () => {
    render(<PersonalProviderSection />)
    openSection()

    fireEvent.change(endpointInput(), { target: { value: "https://api.groq.com/openai/v1" } })

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: /preset|provider/i }).textContent,
      ).toContain("Groq")
    })
  })

  // AQU-796 item 3 (caret jumps in the endpoint field). A controlled input
  // only moves the caret when React writes a *different* value back into the
  // DOM node — i.e. when onChange normalises what was typed. happy-dom does
  // not reproduce the browser's caret reset on a value assignment, so the
  // guard here is the value passthrough itself, which is the actual cause.
  it("passes the typed endpoint through byte-for-byte, so the caret cannot move", () => {
    render(<PersonalProviderSection />)
    openSection()
    const input = endpointInput()

    // Leading/trailing whitespace and a trailing slash are exactly what a
    // normalising onChange would strip out from under the caret. Trimming
    // happens on save, never on keystroke.
    const typed = " https://api.openai.com/v1/ "
    fireEvent.change(input, { target: { value: typed } })

    expect(input.value).toBe(typed)

    // Mid-string edits survive too: insert a character and the rendered value
    // is still exactly what was typed.
    const mid = "https://api.openXai.com/v1"
    fireEvent.change(input, { target: { value: mid } })
    expect(input.value).toBe(mid)
  })
})
