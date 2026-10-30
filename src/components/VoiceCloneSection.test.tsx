/**
 * VoiceCloneSection.test.tsx — empty dropzone vs filled clip; line reuse stays empty.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { VoiceCloneSection } from "./VoiceCloneSection"
import type { Voice } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { uploadVoiceReference } from "@/lib/audio/voice-clone"

vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: { kind: "idle" },
    elapsedMs: 0,
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock("@/lib/audio/voice-clone", () => ({
  buildVoiceReferenceId: (ext: string) => `ref.${ext}`,
  uploadVoiceReference: vi.fn().mockResolvedValue(undefined),
  fetchVoiceReference: vi.fn(),
}))

const session = { jwt: "tok" } as unknown as FrontierSession

function renderSection(voice: Voice, onChange = vi.fn()) {
  render(
    <VoiceCloneSection
      voice={voice}
      projectId="p"
      fileId="f"
      session={session}
      onChange={onChange}
    />,
  )
  return onChange
}

describe("VoiceCloneSection filled state", () => {
  beforeEach(() => {
    vi.mocked(uploadVoiceReference).mockClear()
  })

  it("shows Active/Preview for a recorded or uploaded clip", () => {
    renderSection({ id: "v", name: "N", referenceAudioId: "ref.webm" })
    expect(screen.getByText("Active")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Preview/ })).toBeTruthy()
  })

  it("stays an empty dropzone when the clip was reused from a line", () => {
    renderSection({
      id: "v",
      name: "N",
      referenceAudioId: "ref.webm",
      referenceTakeKey: "cell-1:recorded",
    })
    expect(screen.queryByText("Active")).toBeNull()
    expect(screen.queryByRole("button", { name: /Preview/ })).toBeNull()
    expect(screen.getByRole("group", { name: "Add a reference clip" })).toBeTruthy()
    expect(screen.getByText(/A short clip is enough \(5–15s of one clear speaker\)/)).toBeTruthy()
    expect(screen.getByRole("button", { name: /Record reference/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Upload audio/ })).toBeTruthy()
  })

  it("opens the file picker from Upload audio", () => {
    renderSection({ id: "v", name: "N" })
    const input = screen.getByLabelText("Upload audio", { selector: "input" }) as HTMLInputElement
    expect(input.className).toContain("sr-only")
    expect(input.tabIndex).toBe(-1)
    const click = vi.spyOn(input, "click").mockImplementation(() => {})
    fireEvent.click(screen.getByRole("button", { name: /Upload audio/ }))
    expect(click).toHaveBeenCalledOnce()
  })

  it("uploads a dropped audio file as the reference", async () => {
    const onChange = renderSection({ id: "v", name: "N" })
    const zone = screen.getByRole("group", { name: "Add a reference clip" })
    const file = new File(["clip"], "speaker.wav", { type: "audio/wav" })
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    await waitFor(() => {
      expect(uploadVoiceReference).toHaveBeenCalled()
    })
    expect(onChange).toHaveBeenCalledWith({
      referenceAudioId: "ref.wav",
      referenceTakeKey: undefined,
    })
  })

  it("rejects a dropped non-audio file", async () => {
    renderSection({ id: "v", name: "N" })
    const zone = screen.getByRole("group", { name: "Add a reference clip" })
    const file = new File(["not audio"], "notes.txt", { type: "text/plain" })
    fireEvent.drop(zone, { dataTransfer: { files: [file] } })
    expect(await screen.findByText(/That file isn't audio/)).toBeTruthy()
    expect(uploadVoiceReference).not.toHaveBeenCalled()
  })
})

// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. Preview
// carries its own word.
describe("VoiceCloneSection — Preview has no hover", () => {
  it("shows nothing on hover over Preview", async () => {
    render(
      <TooltipProvider delay={0}>
        <VoiceCloneSection voice={{ id: "v", name: "N", referenceAudioId: "ref.webm" }} projectId="p" fileId="f" session={session} onChange={vi.fn()} />
      </TooltipProvider>,
    )
    await userEvent.setup().hover(screen.getByRole("button", { name: /Preview/ }))
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})
