/**
 * VoicePlaybackBar.test.tsx — the global Audio-lens playback bar.
 *
 * Confirms the transport renders (play-all / prev / next / speed / time /
 * volume) and that play-all is disabled when no line has voiced audio.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"

// No session → useFileAudioAttachments bails before any network read and
// returns an empty map, so the player hydrates purely from the `cells` prop.
// This isolates the transport/canPlay assertions from the audio-read hook
// (which otherwise pulls in useFrontierSession → react-query).
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: null, loading: false }),
}))

// Spy on startQueue while keeping the rest of the queue real (canPlay/state
// selectors). We only assert which index Play hands the queue (AQU-666).
vi.mock("@/lib/audio/play-queue", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/audio/play-queue")>()
  return { ...actual, startQueue: vi.fn(), setQueueRate: vi.fn() }
})

// A film owns the clock. `useVideoController` is how the bar reaches it, and
// `useTransportForFile` is what reports WHO is driving — both stubbed so the
// speed test can put the bar in the film-driven state without a video element.
const videoController = vi.hoisted(() => ({ setRate: vi.fn(), setVolume: vi.fn() }))
const transportSource = vi.hoisted(() => ({ value: "queue" as "queue" | "video" }))
vi.mock("@/lib/timeline/video-controller", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/timeline/video-controller")>()
  return { ...actual, useVideoController: () => videoController }
})
vi.mock("@/hooks/useTransportForFile", async (importActual) => {
  const actual = await importActual<typeof import("@/hooks/useTransportForFile")>()
  return {
    ...actual,
    useTransportForFile: (args: Parameters<typeof actual.useTransportForFile>[0]) => ({
      ...actual.useTransportForFile(args),
      source: transportSource.value,
    }),
  }
})

import { VoicePlaybackBar } from "./VoicePlaybackBar"
import { startQueue, setQueueRate } from "@/lib/audio/play-queue"
import { pushAudioShortcutOverride } from "@/lib/audio/audio-coordinator"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

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
  it("renders the transport and disables play-all with no audio", async () => {
    renderWithTooltips(
      <VoicePlaybackBar cells={[cell()]} projectId="dev-project" session={null} settings={undefined} />,
    )
    const play = screen.getByLabelText("Play all") as HTMLButtonElement
    expect(play).toBeTruthy()
    expect(play.disabled).toBe(true)
    expect(screen.getByLabelText("Previous line")).toBeTruthy()
    expect(screen.getByLabelText("Next line")).toBeTruthy()
    // The speed control reads "1x"; its purpose is carried by the tooltip.
    await expectTooltip(screen.getByText("1x"), "Playback speed")
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

  it("renders nested below content under now-playing", () => {
    render(
      <VoicePlaybackBar
        cells={[cell()]}
        projectId="dev-project"
        session={null}
        settings={undefined}
        below={<span>Synced</span>}
      />,
    )
    expect(screen.getByText("Synced")).toBeTruthy()
    expect(screen.getByText("Nothing playing")).toBeTruthy()
  })

  describe("start section (AQU-666)", () => {
    const session = { jwt: "t" } as unknown as FrontierSession
    const voiced = (id: string): CellData =>
      cell({ id, selectedAudioId: `${id}-a`, attachments: { [`${id}-a`]: { url: `blob:${id}`, type: "audio/mpeg" } } })
    const sections = [voiced("s0"), voiced("s1"), voiced("s2")]

    beforeEach(() => { vi.mocked(startQueue).mockClear() })

    it("starts from the highlighted section, not the file start", () => {
      render(
        <VoicePlaybackBar cells={sections} projectId="p" session={session} settings={undefined} startCellId="s1" />,
      )
      fireEvent.click(screen.getByLabelText("Play all"))
      expect(startQueue).toHaveBeenCalledTimes(1)
      expect(vi.mocked(startQueue).mock.calls[0][1]).toBe(1)
    })

    it("starts from the top of the file when the first section is highlighted", () => {
      render(
        <VoicePlaybackBar cells={sections} projectId="p" session={session} settings={undefined} startCellId="s0" />,
      )
      fireEvent.click(screen.getByLabelText("Play all"))
      expect(vi.mocked(startQueue).mock.calls[0][1]).toBe(0)
    })

    it("falls back to the file start when nothing is highlighted", () => {
      render(
        <VoicePlaybackBar cells={sections} projectId="p" session={session} settings={undefined} startCellId={null} />,
      )
      fireEvent.click(screen.getByLabelText("Play all"))
      expect(vi.mocked(startQueue).mock.calls[0][1]).toBe(0)
    })

    // MERGE 2026-07-27 (AQU-660 × SUB-44/SUB-52). The media timeline and the
    // recording modal each claim Space for their own transport while on
    // screen. This bar binds Space on `window`, so without a guard it fired
    // as well: Space in the media lens toggled twice (net: nothing), and
    // Space in the recorder started playback underneath it — the very bug
    // SUB-52 fixed, re-entering from a new place.
    describe("spacebar yields to whoever claimed the audio shortcut", () => {
      const press = () =>
        fireEvent.keyDown(document.body, { key: " ", code: "Space" })

      it("toggles play/pause when nothing else has claimed it", () => {
        render(
          <VoicePlaybackBar cells={sections} projectId="p" session={session} settings={undefined} startCellId="s1" />,
        )
        press()
        expect(startQueue).toHaveBeenCalledTimes(1)
      })

      it("stands down while the timeline or the recorder holds the claim", () => {
        render(
          <VoicePlaybackBar cells={sections} projectId="p" session={session} settings={undefined} startCellId="s1" />,
        )
        const release = pushAudioShortcutOverride()
        press()
        expect(startQueue).not.toHaveBeenCalled()
        // …and takes it back the moment that claim is dropped.
        release()
        press()
        expect(startQueue).toHaveBeenCalledTimes(1)
      })
    })
  })
})

// ── Speed reaches the takes, not just whoever owns the clock ────────────────
//
// The dubs always fire through the queue's overlay pool no matter which engine
// owns the clock, and that pool takes its speed from the QUEUE's rate. The bar
// used to hand the rate to one engine or the other — `drivesVideo ?
// videoController.setRate : setQueueRate` — so on a film the picture sped up
// and every take went on playing at 1x internally: it fired on cue (firing
// reads the clock) and then drifted within itself. Sam verified it live on a
// real film before this was fixed.
describe("VoicePlaybackBar — playback speed", () => {
  const pickSpeed = (label: string) => {
    fireEvent.click(screen.getByText("1x"))
    fireEvent.click(screen.getByText(label))
  }

  beforeEach(() => {
    transportSource.value = "queue"
    videoController.setRate.mockClear()
    vi.mocked(setQueueRate).mockClear()
  })

  it("tells the queue, so the dub overlays actually change speed", () => {
    render(<VoicePlaybackBar cells={[cell()]} projectId="p1" session={null} settings={undefined} />)
    pickSpeed("1.5x")
    expect(setQueueRate).toHaveBeenCalledWith(1.5)
  })

  it("tells BOTH the film and the queue when the film owns the clock", () => {
    transportSource.value = "video"
    render(<VoicePlaybackBar cells={[cell()]} projectId="p1" session={null} settings={undefined} />)
    pickSpeed("1.5x")
    // The picture…
    expect(videoController.setRate).toHaveBeenCalledWith(1.5)
    // …and the takes playing over it. This is the assertion the old
    // `? :` failed: it reached exactly one of these two.
    expect(setQueueRate).toHaveBeenCalledWith(1.5)
  })

  it("leaves the film alone when the queue owns the clock", () => {
    render(<VoicePlaybackBar cells={[cell()]} projectId="p1" session={null} settings={undefined} />)
    pickSpeed("0.75x")
    expect(setQueueRate).toHaveBeenCalledWith(0.75)
    expect(videoController.setRate).not.toHaveBeenCalled()
  })
})
