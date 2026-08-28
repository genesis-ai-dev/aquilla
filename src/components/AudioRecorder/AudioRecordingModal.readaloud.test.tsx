// AQU-646 stage 4: the line the performer reads is not always the cell being
// recorded.
//
// Once an episode's audio VTT is imported, `cells` are the AUDIO CUES — the
// units the picture wants recorded — and a cue carries only a transcript of the
// English soundtrack, never a translation. The words to perform live on the
// SUBTITLE cells it is linked to. `readAloudFor` is how the modal stops
// assuming those are the same row.
//
// The fallback matters as much as the feature: every arrangement WITHOUT audio
// cues passes no resolver at all and must keep showing the cell's own
// translation, unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ComponentProps } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useOnline", () => ({ useOnline: () => true }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "sam" }, loading: false }),
}))
vi.mock("@/hooks/useAudioRecorder", () => ({
  useAudioRecorder: () => ({
    state: { kind: "idle" },
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    prewarm: vi.fn(),
  }),
}))
vi.mock("./probeMicPermission", () => ({ probeMicPermission: vi.fn(async () => "granted" as const) }))
vi.mock("@/hooks/useFileAudioAttachments", () => ({
  useFileAudioAttachments: () => ({ byCellId: new Map(), isLoading: false, revalidate: vi.fn() }),
  mergeCellsWithAudio: (cells: unknown[]) => cells,
}))
vi.mock("@/lib/audio/voice-generate-helpers", () => ({ generateCellVoice: vi.fn(async () => true) }))
vi.mock("@/lib/import", () => ({ probeDurationMsSafe: vi.fn(async () => 1000) }))
vi.mock("@/lib/audio/audio-attachments-bus", () => ({
  notifyAudioAttachmentsChanged: vi.fn(),
  injectOptimisticAudioAttachment: vi.fn(),
  injectOptimisticAudioRemove: vi.fn(),
}))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellLaneRetime: vi.fn(async () => "evt"),
  emitCellAudioAttach: vi.fn(async () => "evt"),
  emitCellAudioSelect: vi.fn(async () => "evt"),
  emitCellAudioRemove: vi.fn(async () => "evt"),
  emitCellAudioRename: vi.fn(async () => "evt"),
}))
vi.mock("@/lib/audio/sync-token-fetcher", () => ({
  audioSyncTokenFetcherForSession: () => async () => "sync-tok",
}))
vi.mock("@/lib/audio/upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: vi.fn(async () => new ArrayBuffer(8)),
  uploadCellAudio: vi.fn(async () => ({ audioId: "a", ext: "webm", url: "frontier-audio://a.webm" })),
  deleteCellAudio: vi.fn(async () => {}),
}))
vi.mock("@/lib/audio/bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("@/lib/audio/transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
vi.mock("@/lib/audio/transcribe", () => ({ transcribeCell: vi.fn(async () => {}) }))
vi.mock("@/lib/audio/audio-coordinator", () => ({ pushAudioShortcutOverride: () => () => {} }))

import { AudioRecordingModal } from "./AudioRecordingModal"

const project = { id: "p1", name: "P", ttsSettings: {} } as unknown as ProjectRecord

const FILM = "https://cdn.example.com/ep.mp4"
/** The film hangs on the TEXT file. The cue sibling is not in `files` at all —
 *  the workspace filters audio-cue siblings out of every file list. */
const projectWithFilm = {
  id: "p1",
  name: "P",
  ttsSettings: {},
  files: [{ id: "f-text", name: "ep.vtt", coreMediaUrl: FILM }],
} as unknown as ProjectRecord

/** An audio cue: source transcript only, never a translation of its own. */
const cue = {
  id: "cue-1",
  fileId: "f-cues",
  original: "Pay me, pay me",
  translated: "",
  medium: "text",
  startTime: 4,
  endTime: 9,
} as unknown as CellData

type ReadAloudFor = ComponentProps<typeof AudioRecordingModal>["readAloudFor"]

function renderModal(readAloudFor?: ReadAloudFor) {
  renderWithTooltips(
    <AudioRecordingModal
      open
      project={project}
      cells={[cue]}
      activeCellId="cue-1"
      username="sam"
      onActiveCellChange={() => {}}
      readAloudFor={readAloudFor}
      onClose={() => {}}
    />,
  )
}

describe("what the performer reads", () => {
  beforeEach(() => localStorage.clear())

  it("falls back to the cell's own translation when no resolver is given", () => {
    // Every project without an audio VTT. Unchanged behaviour.
    const plain = { ...cue, translated: "Paie-moi" } as CellData
    render(
      <AudioRecordingModal
        open
        project={project}
        cells={[plain]}
        activeCellId="cue-1"
        username="sam"
        onActiveCellChange={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId("rec-read-aloud")).toHaveTextContent("Paie-moi")
    expect(screen.queryByTestId("rec-cue-reference")).not.toBeInTheDocument()
  })

  it("shows the LINKED subtitle's translation, not the cue's empty one", () => {
    renderModal(() => ({ text: "Paie-moi, paie-moi, on y va." }))
    expect(screen.getByTestId("rec-read-aloud")).toHaveTextContent("Paie-moi, paie-moi, on y va.")
  })

  it("adds the cue's own transcript when one subtitle spans several cues", () => {
    // The performer is handed the whole subtitle and has to know which part of
    // it is this take's. The transcript is the only thing that can say so —
    // splitting the translation automatically would be guesswork across
    // languages that do not share word order.
    renderModal(() => ({ text: "Paie-moi, paie-moi, on y va.", reference: "Pay me, pay me" }))
    expect(screen.getByTestId("rec-cue-reference")).toHaveTextContent("Pay me, pay me")
  })

  it("omits the transcript when the cue owns its subtitle outright", () => {
    // Nothing to disambiguate, so the second line would just be clutter.
    renderModal(() => ({ text: "Je le vois.", reference: null }))
    expect(screen.queryByTestId("rec-cue-reference")).not.toBeInTheDocument()
  })

  it("says 'not translated' for an unlinked cue, and still offers the transcript", () => {
    // The ~10 genuinely unsubtitled utterances per episode — "Whoa!", "Nah."
    // There is nothing to read, so the transcript is offered as reference
    // rather than as words to say.
    renderModal(() => ({ text: "", reference: "Whoa!" }))
    expect(screen.getByTestId("rec-read-aloud")).toHaveTextContent("not translated")
    expect(screen.getByTestId("rec-cue-reference")).toHaveTextContent("Whoa!")
  })

  // THE REGRESSION (Sam, 2026-08-14: "video in the recording modal has been
  // lost… no expand video button anymore"). Recording moved onto the audio
  // cues, so `activeCell.fileId` became the hidden cue sibling — which carries
  // no coreMediaUrl AND is filtered out of `project.files` entirely. The film
  // lookup therefore missed twice over and the picture vanished with no error
  // anywhere. The cell being RECORDED and the file that owns the FILM are two
  // different things now, and this is what says so.
  describe("the film survives takes moving to the cue sibling", () => {
    it("finds the picture on the TEXT file while recording a cue", () => {
      render(
        <AudioRecordingModal
          open
          project={projectWithFilm}
          cells={[cue]}
          activeCellId="cue-1"
          username="sam"
          onActiveCellChange={() => {}}
          filmFileId="f-text"
          onClose={() => {}}
        />,
      )
      expect(screen.getByTestId("rec-video")).toBeInTheDocument()
    })

    it("goes dark again when the cue's own file is trusted for it", () => {
      // Without `filmFileId` the lookup falls back to the cue's file (f-cues),
      // which owns no picture — i.e. exactly the broken behaviour. Pinning it
      // keeps the fallback honest rather than accidentally finding some film.
      render(
        <AudioRecordingModal
          open
          project={projectWithFilm}
          cells={[cue]}
          activeCellId="cue-1"
          username="sam"
          onActiveCellChange={() => {}}
          onClose={() => {}}
        />,
      )
      expect(screen.queryByTestId("rec-video")).not.toBeInTheDocument()
    })
  })

  it("still shows the cue's transcript as the Source line", () => {
    // Unchanged: the source pane is the cue's own words either way, which is
    // what makes the read-aloud line's provenance readable at a glance.
    renderModal(() => ({ text: "Paie-moi" }))
    expect(screen.getByText("Pay me, pay me")).toBeInTheDocument()
  })
})

// AQU-646 stage 6. The character spreadsheet imported 637 names and 637 camera
// states correctly and there was nowhere to see them — the recorder had no
// reference to cast anywhere in it. These are the two things a performer
// settles before the first word, so they sit above the line.
describe("who is speaking, and whether the camera is on them", () => {
  beforeEach(() => localStorage.clear())

  it("names the character above the line", () => {
    renderModal(() => ({ text: "Paie-moi", castName: "Mary", cameraState: "on" }))
    expect(screen.getByTestId("rec-read-aloud-cast")).toHaveTextContent("Mary")
  })

  it("says on camera, which is the fact that changes the take", () => {
    // Lip-sync. This is the whole reason the sheet's Camera column was worth
    // importing, so it must not read as a bare "on".
    renderModal(() => ({ text: "Paie-moi", castName: "Mary", cameraState: "on" }))
    expect(screen.getByTestId("rec-read-aloud-camera")).toHaveTextContent("on camera")
  })

  it("says off camera when it is", () => {
    renderModal(() => ({ text: "Paie-moi", castName: "Mary", cameraState: "off" }))
    expect(screen.getByTestId("rec-read-aloud-camera")).toHaveTextContent("off camera")
  })

  it("shows both speakers when one heard line covers two", () => {
    renderModal(() => ({ text: "Paie-moi", castName: "Jesus / Mary", cameraState: "mixed" }))
    expect(screen.getByTestId("rec-read-aloud-cast")).toHaveTextContent("Jesus / Mary")
    expect(screen.getByTestId("rec-read-aloud-camera")).toHaveTextContent("mixed")
  })

  it("shows nothing for an unlinked cue rather than 'unknown'", () => {
    // The ~10 unsubtitled utterances an episode. Same honesty as the
    // read-aloud line itself, which says nothing rather than inventing words.
    renderModal(() => ({ text: "", reference: "Whoa!" }))
    expect(screen.queryByTestId("rec-read-aloud-cast")).not.toBeInTheDocument()
    expect(screen.queryByTestId("rec-read-aloud-camera")).not.toBeInTheDocument()
  })

  it("keeps the camera pill out when the character is unknown", () => {
    // A camera state with nobody to attach it to is a floating fact.
    renderModal(() => ({ text: "Paie-moi", castName: null, cameraState: "on" }))
    expect(screen.queryByTestId("rec-read-aloud-camera")).not.toBeInTheDocument()
  })

  // THE REGRESSION THIS COULD HAVE CAUSED. The read-aloud box is a measured
  // five-line fit whose font size is binary-searched against a pixel budget —
  // put the character line INSIDE it and the performer's type silently shrinks
  // to make room. It shares the label's row instead, outside the box.
  it("does not shrink the line the performer reads", () => {
    const size = () => screen.getByTestId("rec-read-aloud").style.fontSize
    const { unmount } = render(
      <AudioRecordingModal
        open project={project} cells={[cue]} activeCellId="cue-1" username="sam"
        onActiveCellChange={() => {}} onClose={() => {}}
        readAloudFor={() => ({ text: "Paie-moi, paie-moi, on y va." })}
      />,
    )
    const withoutCast = size()
    unmount()
    renderModal(() => ({
      text: "Paie-moi, paie-moi, on y va.",
      castName: "Mary",
      cameraState: "on",
    }))
    expect(size()).toBe(withoutCast)
    // And the header is genuinely outside the measured element, not merely
    // equal-sized by luck in jsdom.
    expect(screen.getByTestId("rec-read-aloud")).not.toContainElement(
      screen.getByTestId("rec-read-aloud-cast"),
    )
  })
})

// AQU-646 stage 3f — TTS SPEAKS WHAT THE PERFORMER READS.
//
// Sam, 2026-08-25: "Generate TTS does not work because audio cells are linked to
// subtitle cells but the audio cell's text is not itself translated and it
// doesn't link through to the subtitle translated text appropriately."
//
// The button read `activeCell.translated` — a cue's own translation, which on
// this file type is empty forever — so it sat disabled saying "translate this
// line first" over a line that WAS translated, ten pixels under a read-aloud
// panel showing those very words. This is the two of them agreeing.
describe("generating a voice for a cue", () => {
  beforeEach(() => localStorage.clear())

  const linked: ReadAloudFor = () => ({
    text: "Assieds-toi.",
    reference: "Sit down, sit down.",
    castName: "ZEE",
    cameraState: null,
    linkedCount: 1,
    voiceCellId: "sub-7",
  })

  it("is offered on a cue whose subtitle is translated, though the cue is not", () => {
    renderModal(linked)
    // The cue's own `translated` is "" — the old gate read exactly this.
    expect(cue.translated).toBe("")
    expect(screen.getByTestId("rec-generate-tts")).toBeEnabled()
  })

  it("speaks the linked words, in the linked line's voice", async () => {
    const { generateCellVoice } = await import("@/lib/audio/voice-generate-helpers")
    vi.mocked(generateCellVoice).mockClear()
    renderModal(linked)
    fireEvent.click(screen.getByTestId("rec-generate-tts"))
    await waitFor(() => expect(generateCellVoice).toHaveBeenCalled())
    const args = vi.mocked(generateCellVoice).mock.calls[0][0]
    expect(args.text).toBe("Assieds-toi.")
    // The cast assignment is keyed by cell id and made on the SUBTITLE, so
    // without this every dub speaks in the project default.
    expect(args.voiceCellId).toBe("sub-7")
    // …and it still attaches to the CUE, which was never the broken half.
    expect(args.cell.id).toBe("cue-1")
  })

  // Two different problems with two different fixes, which used to wear one
  // string. Sam asked for the explanation to be a tooltip.
  it("says the subtitle is untranslated when one is linked but empty", async () => {
    renderModal(() => ({ text: "", reference: "Sit down.", linkedCount: 1, voiceCellId: "sub-7" }))
    const button = screen.getByTestId("rec-generate-tts")
    expect(button).toBeDisabled()
    await expectTooltip(button, /Translate this line first/i)
  })

  it("says nothing is linked when nothing is", async () => {
    renderModal(() => ({ text: "", reference: "Sit down.", linkedCount: 0, voiceCellId: null }))
    const button = screen.getByTestId("rec-generate-tts")
    expect(button).toBeDisabled()
    await expectTooltip(button, /No subtitle is linked to this heard line/i)
  })
})

// AQU-646 stage 3g — saying what a generated voice will actually do.
//
// A subtitle performed by several heard lines gets voiced onto THIS one, saying
// the whole subtitle rather than just this line's share, and the others stay
// silent. Sam asked for it before the press, not after: once the clip exists
// the warning is late. Never dismissible — "lets be super safe for now."
describe("the shared-subtitle notice", () => {
  beforeEach(() => localStorage.clear())

  const shared = () => ({
    text: "Assieds-toi.",
    reference: "Sit down, sit down.",
    linkedCount: 1,
    voiceCellId: "sub-7",
    sharedWith: 2,
  })

  // AFTER THE PRESS, NOT BEFORE (Sam, 2026-08-27) — a reversal of the original
  // call. The first version fired on "this subtitle is shared" rather than on
  // "you are about to generate", so a performer doing mic takes carried a
  // permanent paragraph about text-to-speech for a button they may never press.
  it("stays quiet until a voice has actually been generated", () => {
    renderModal(shared)
    expect(screen.queryByTestId("rec-tts-shared-notice")).toBeNull()
    // …and generating is still the right thing to do, so nothing is gated.
    expect(screen.getByTestId("rec-generate-tts")).toBeEnabled()
  })

  it("names what is still silent once the voice has landed", async () => {
    renderModal(shared)
    fireEvent.click(screen.getByTestId("rec-generate-tts"))
    const notice = await screen.findByTestId("rec-tts-shared-notice")
    expect(notice).toHaveTextContent("2 heard lines")
    expect(notice).toHaveTextContent(/leaves the others silent/i)
  })

  // Nothing was voiced, so "the others are still silent" would be misleading —
  // and it would stack on top of the failure message the button already shows.
  it("says nothing when the generation failed", async () => {
    const { generateCellVoice } = await import("@/lib/audio/voice-generate-helpers")
    vi.mocked(generateCellVoice).mockResolvedValueOnce(false)
    renderModal(shared)
    fireEvent.click(screen.getByTestId("rec-generate-tts"))
    await waitFor(() => expect(vi.mocked(generateCellVoice)).toHaveBeenCalled())
    expect(screen.queryByTestId("rec-tts-shared-notice")).toBeNull()
  })

  // ~92% of lines. A notice on every one of them would be wallpaper, which is
  // the objection I raised and then withdrew once the numbers were measured —
  // 7.9%, not "common".
  it("is absent on a line only one heard line performs", () => {
    renderModal(() => ({
      text: "Assieds-toi.",
      reference: null,
      linkedCount: 1,
      voiceCellId: "sub-7",
      sharedWith: 1,
    }))
    expect(screen.queryByTestId("rec-tts-shared-notice")).toBeNull()
  })

  it("is absent on a file with no cue links at all", () => {
    renderModal()
    expect(screen.queryByTestId("rec-tts-shared-notice")).toBeNull()
  })
})
