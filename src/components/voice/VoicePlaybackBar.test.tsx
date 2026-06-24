/**
 * VoicePlaybackBar.test.tsx — the global Audio-lens playback bar.
 *
 * Confirms the transport renders (play-all / prev / next / speed / time /
 * volume) and that play-all is disabled when no line has voiced audio.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"

// No session → useFileAudioAttachments bails before any network read and
// returns an empty map, so the player hydrates purely from the `cells` prop.
// This isolates the transport/canPlay assertions from the audio-read hook
// (which otherwise pulls in useFrontierSession → react-query).
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: null, loading: false }),
}))

import { VoicePlaybackBar } from "./VoicePlaybackBar"
import type { CellData } from "@/hooks/useCells"

function cell(over: Partial<CellData> = {}): CellData {
  return {
    id: "c1", fileId: "f1", cellLabel: "GEN 1:1", original: "", translated: "hello",
    context: "", group: "", type: "text", status: "empty",
    validationStatus: "none", activeValidators: [], validationHistory: [],
    history: [], threads: [],
    ...over,
  } as CellData
}

describe("VoicePlaybackBar", () => {
  it("renders the transport and disables play-all with no audio", () => {
    render(
      <VoicePlaybackBar cells={[cell()]} projectId="dev-project" session={null} settings={undefined} />,
    )
    const play = screen.getByLabelText("Play all") as HTMLButtonElement
    expect(play).toBeTruthy()
    expect(play.disabled).toBe(true)
    expect(screen.getByLabelText("Previous line")).toBeTruthy()
    expect(screen.getByLabelText("Next line")).toBeTruthy()
    expect(screen.getByTitle("Playback speed")).toBeTruthy()
    expect(screen.getByText("1x")).toBeTruthy()
    expect(screen.getByText("0:00 / 0:00")).toBeTruthy()
    expect(screen.getByText("No voiced lines yet")).toBeTruthy()
  })

  it("enables play-all when a line has playable audio", () => {
    const voiced = cell({
      selectedGeneratedVoiceAudioId: "a1",
      attachments: { a1: { url: "blob:x", type: "audio/wav" } },
    })
    render(
      <VoicePlaybackBar cells={[voiced]} projectId="dev-project" session={null} settings={undefined} />,
    )
    const play = screen.getByLabelText("Play all") as HTMLButtonElement
    expect(play.disabled).toBe(false)
    expect(screen.getByText("Press play to listen")).toBeTruthy()
  })
})
