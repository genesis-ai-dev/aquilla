// AQU-360 — the per-cell "Generate audio" hover must name the ENGINE that
// generation will actually use (the resolved voice's provider, falling back
// to the project's configured provider) — not a stale/hardcoded engine name
// like "Omni voice" that was never configured.

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { CellTtsButton } from "./CellTtsButton"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: null, loading: false }),
}))

vi.mock("@/lib/audio/prefetch", () => ({
  useModelStatus: () => ({ kind: "idle" }),
}))

function renderButton(projectTtsSettings: ProjectTtsSettings) {
  render(
    <CellTtsButton
      cellId="c1"
      text="Hello there"
      projectTtsSettings={projectTtsSettings}
      playOnly
    />,
  )
}

describe("CellTtsButton hover label (AQU-360)", () => {
  it("names MMS when that's the project's configured provider and the voice has none of its own", () => {
    renderButton({ provider: "mms", voices: [{ id: "v1", name: "Narrator", color: "#000" }], defaultVoiceId: "v1" })
    const btn = screen.getByRole("button")
    expect(btn.getAttribute("aria-label")).toContain("MMS")
    expect(btn.getAttribute("aria-label")).not.toContain("Omni")
    expect(btn.getAttribute("aria-label")).not.toContain("Gemini")
  })

  it("names Kokoro when that's the project's configured provider", () => {
    renderButton({ provider: "kokoro", voices: [{ id: "v1", name: "Narrator", color: "#000" }], defaultVoiceId: "v1" })
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Kokoro")
  })

  it("honors a voice's own provider over the project default", () => {
    renderButton({
      provider: "omnivoice",
      voices: [{ id: "v1", name: "Kid", color: "#000", provider: "kokoro", voiceName: "af_heart" }],
      defaultVoiceId: "v1",
    })
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Kokoro")
  })
})

describe("CellTtsButton — round 5 (AQU-646)", () => {
  it("an untranslated cell renders the button DISABLED with the reason, not hidden", () => {
    render(<CellTtsButton cellId="c1" text="" projectTtsSettings={{}} />)
    const btn = screen.getByRole("button")
    expect(btn).toBeDisabled()
    expect(btn.getAttribute("aria-label")).toBe("Translate this line first to generate voice")
  })

  it("SUB-35: the READY state is visibly tinted; the disabled state is washed out", () => {
    const { unmount } = render(<CellTtsButton cellId="c1" text="Hello there" projectTtsSettings={{}} />)
    expect(screen.getByRole("button").className).toContain("text-sky-600")
    unmount()
    render(<CellTtsButton cellId="c1" text="" projectTtsSettings={{}} />)
    expect(screen.getByRole("button").className).toContain("text-muted-foreground/40")
  })

  it("the built-in Narrator follows the PROJECT engine — OmniVoice default, no pinned Gemini", () => {
    // Fresh project: no custom voices, no provider set → resolved engine must
    // be the OmniVoice default (previously the Narrator preset forced Gemini
    // and demanded a Gemini key on every fresh project).
    render(<CellTtsButton cellId="c1" text="Hello there" projectTtsSettings={{}} />)
    const label = screen.getByRole("button").getAttribute("aria-label")
    expect(label).toContain("Narrator")
    expect(label).not.toContain("Gemini")
  })

  it("the Narrator speaks Gemini when the project engine IS Gemini", () => {
    render(<CellTtsButton cellId="c1" text="Hello there" projectTtsSettings={{ provider: "gemini" }} />)
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Gemini")
  })
})
