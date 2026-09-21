// AQU-490: the recorder's take list is where a reviewer actually signs a take
// off, so the control has to be reachable there — and on the RIGHT take.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

const emitValidate = vi.fn().mockResolvedValue("evt")
const emitUnvalidate = vi.fn().mockResolvedValue("evt")
vi.mock("@/lib/sync/events-emit", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitCellAudioValidate: (...a: unknown[]) => emitValidate(...a),
  emitCellAudioUnvalidate: (...a: unknown[]) => emitUnvalidate(...a),
  emitCellAudioSelect: vi.fn().mockResolvedValue("evt"),
  emitCellAudioRemove: vi.fn().mockResolvedValue("evt"),
}))

const { TakesStrip } = await import("./TakesStrip")

const project = { id: "p1", name: "P", syncRole: { level: 600 } } as unknown as ProjectRecord

const take = (over: Partial<AudioAttachmentOut> & { audioId: string }): AudioAttachmentOut => ({
  url: `frontier-audio://${over.audioId}`,
  slot: "recording",
  mimeType: "audio/webm",
  voiceId: null,
  referenceAudioId: null,
  durationMs: 1000,
  label: null,
  trimStartMs: null,
  trimEndMs: null,
  ...over,
})

function draw(takes: AudioAttachmentOut[], selectedAudioId: string | null) {
  render(
    <I18nProvider>
      <TakesStrip
        projectId="p1"
        project={project}
        fileId="f1"
        cellId="c1"
        takes={takes}
        selectedAudioId={selectedAudioId}
        author="ana"
        session={null}
      />
    </I18nProvider>,
  )
}

beforeEach(() => { emitValidate.mockClear(); emitUnvalidate.mockClear() })

describe("TakesStrip — audio validation", () => {
  // The vote belongs to the take that will be HEARD. Offering it on a take
  // nobody has chosen would collect sign-off on audio that never plays.
  it("offers the control on the circled take only", () => {
    draw([
      take({ audioId: "a", validatorCount: 0, validators: [] }),
      take({ audioId: "b", validatorCount: 0, validators: [] }),
    ], "b")
    expect(screen.getAllByTestId("audio-validation-button")).toHaveLength(1)
  })

  it("emits a vote naming that take", async () => {
    draw([take({ audioId: "b", validatorCount: 0, validators: [] })], "b")
    await userEvent.click(screen.getByTestId("audio-validation-button"))
    expect(emitValidate).toHaveBeenCalledTimes(1)
    expect(emitValidate.mock.calls[0][0]).toMatchObject({
      projectId: "p1", fileId: "f1", cellId: "c1", audioId: "b", author: "ana",
    })
  })

  // The imported programme audio is selected in the recording slot on every
  // cell of a media file. Nobody validates the film's own soundtrack.
  it("never offers a vote on the imported source clip", () => {
    draw([take({ audioId: "src", role: "source", validatorCount: 0, validators: [] })], "src")
    expect(screen.queryByTestId("audio-validation-button")).toBeNull()
  })

  it("withdraws a vote already cast", async () => {
    draw([take({ audioId: "b", validatorCount: 1, validators: ["ana"] })], "b")
    await userEvent.click(screen.getByTestId("audio-validation-button"))
    // Scoped to the popover: AppTooltip mirrors the label into a portal.
    const list = await screen.findByRole("dialog")
    await userEvent.click(within(list).getByRole("button", { name: /remove your validation/i }))
    expect(emitUnvalidate).toHaveBeenCalledTimes(1)
    expect(emitUnvalidate.mock.calls[0][0]).toMatchObject({ audioId: "b" })
  })

  // The role guard is defensive rather than decorative: a keyboard or
  // programmatic trigger reaches the emit too, and a guaranteed 403 must not
  // enter the outbox.
  it("does not emit for a role below the reviewer floor", async () => {
    render(
      <I18nProvider>
        <TakesStrip
          projectId="p1"
          project={{ id: "p1", name: "P", syncRole: { level: 200 } } as unknown as ProjectRecord}
          fileId="f1" cellId="c1"
          takes={[take({ audioId: "b", validatorCount: 0, validators: [] })]}
          selectedAudioId="b" author="ana" session={null}
        />
      </I18nProvider>,
    )
    await userEvent.click(screen.getByTestId("audio-validation-button"))
    expect(emitValidate).not.toHaveBeenCalled()
  })
})
