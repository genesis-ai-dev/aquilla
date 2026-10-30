// AQU-360 — the per-cell "Generate audio" hover must name the ENGINE that
// generation will actually use (the resolved voice's provider, falling back
// to the project's configured provider) — not a stale/hardcoded engine name.

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { CellTtsButton } from "./CellTtsButton"
import { setTtsStatus, ttsStatusKey } from "@/lib/audio/tts"
import { expectClickNote, expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: null, loading: false }),
}))

vi.mock("@/lib/audio/prefetch", () => ({
  useModelStatus: () => ({ kind: "idle" }),
}))

const onlineState = vi.hoisted(() => ({ value: true }))
vi.mock("@/hooks/useOnline", () => ({ useOnline: () => onlineState.value }))

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
    expect(btn.getAttribute("aria-label")).not.toContain("Gemini")
  })

  it("names Inworld when leftover Kokoro is the project's configured provider", () => {
    renderButton({ provider: "kokoro", voices: [{ id: "v1", name: "Narrator", color: "#000" }], defaultVoiceId: "v1" })
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Inworld")
    expect(screen.getByRole("button").getAttribute("aria-label")).not.toContain("Kokoro")
  })

  it("honors a leftover Kokoro voice as Inworld over a Gemini project default", () => {
    renderButton({
      provider: "gemini",
      voices: [{ id: "v1", name: "Kid", color: "#000", provider: "kokoro", voiceName: "af_heart" }],
      defaultVoiceId: "v1",
    })
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Inworld")
    expect(screen.getByRole("button").getAttribute("aria-label")).not.toContain("Kokoro")
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

  it("the built-in Narrator follows the PROJECT engine — Inworld default, no pinned Gemini", () => {
    // Fresh project: no custom voices, no provider set → resolved engine must
    // be the Inworld default (previously the Narrator preset forced Gemini
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

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. A failure
// and the offline preview are explained behind an (i) beside it, on a click.
describe("CellTtsButton — the hover names it; explanations open on click", () => {
  it("after a failure, the hover only names the button", async () => {
    setTtsStatus(ttsStatusKey("c-err"), { kind: "error", message: "Gemini API key required" })
    renderWithTooltips(<CellTtsButton cellId="c-err" text="Hello there" projectTtsSettings={{}} />)
    await expectTooltip(screen.getByRole("button", { name: /^Generate & play/ }), "Generate & play")
    expect(screen.getByRole("tooltip").textContent).not.toContain("Gemini API key required")
    setTtsStatus(ttsStatusKey("c-err"), { kind: "idle" })
  })

  it("after a failure, the reason is behind the (i) beside it", async () => {
    setTtsStatus(ttsStatusKey("c-err2"), { kind: "error", message: "Gemini API key required" })
    renderWithTooltips(<CellTtsButton cellId="c-err2" text="Hello there" projectTtsSettings={{}} />)
    await expectClickNote(screen.getByRole("button", { name: /^About / }), "Couldn't generate a voice — Gemini API key required")
    setTtsStatus(ttsStatusKey("c-err2"), { kind: "idle" })
  })

  it("offline with the on-device voice, the hover only names it", async () => {
    onlineState.value = false
    renderWithTooltips(<CellTtsButton cellId="c-off" text="Hello there" projectTtsSettings={{ provider: "mms" }} />)
    await expectTooltip(screen.getByRole("button", { name: /^Generate & play/ }), "Generate & play")
    expect(screen.getByRole("tooltip").textContent).not.toContain("won't be saved")
    onlineState.value = true
  })

  it("offline with the on-device voice, says the clip won't be saved behind its (i)", async () => {
    onlineState.value = false
    renderWithTooltips(<CellTtsButton cellId="c-off" text="Hello there" projectTtsSettings={{ provider: "mms" }} />)
    await expectClickNote(screen.getByRole("button", { name: /^About / }), "The clip won't be saved")
    onlineState.value = true
  })

  it("has no (i) when there is nothing to explain", () => {
    render(<CellTtsButton cellId="c1" text="Hello there" projectTtsSettings={{}} />)
    expect(screen.queryByRole("button", { name: /^About / })).toBeNull()
  })
})
