/**
 * Import-failure observability — IMPORT_FAILED instrumentation.
 *
 * WHY: A tester's mp3 imports failed silently — PostHog showed "import started"
 * events with no terminal event at all (no success, no failure, no $exception).
 * Ops could not see the failure class. This test encodes the contract: when the
 * upload commit path (doCommit) throws, the dialog MUST capture IMPORT_FAILED
 * with the error message and non-PII extension metadata (never file names).
 *
 * posthog is mocked with the same pattern as src/lib/event-names.test.ts;
 * heavy import deps are mocked like ImportDialog.confirm-failure.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// ── Mock posthog BEFORE importing the component ──────────────────────────────
const { mockCapture, mockImportFile } = vi.hoisted(() => ({
  mockCapture: vi.fn(),
  mockImportFile: vi.fn(),
}))
vi.mock("@/lib/posthog", () => ({
  default: {
    capture: mockCapture,
    captureException: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}))

// ── heavy deps that ImportDialog imports ─────────────────────────────────────
vi.mock("@/lib/import", () => ({
  importFile: (...args: unknown[]) => mockImportFile(...args),
  importEBible: vi.fn(),
  importParatextProject: vi.fn(),
  importParatextAsTarget: vi.fn(),
  parseFile: vi.fn(async () => []),
}))
vi.mock("@/lib/import/cast-from-speakers", () => ({ buildCastAdditions: vi.fn(() => ({})) }))
vi.mock("@/lib/import/file-entries", () => ({ filesToProjectEntries: vi.fn(async () => []) }))
vi.mock("@/lib/parsers/paratext-project", () => ({
  detectParatextProject: vi.fn(() => null),
}))
vi.mock("@/lib/parsers/ebible", () => ({
  fetchTranslationsList: vi.fn(async () => []),
  fetchTranslationText: vi.fn(async () => ""),
  parseEBibleCorpus: vi.fn(() => []),
}))
vi.mock("uuid", () => ({ v7: () => "mock-uuid" }))

import { ImportDialog } from "./ImportDialog"
import { IMPORT_STARTED, IMPORT_FAILED } from "@/lib/event-names"

function renderDialog() {
  return render(
    <ImportDialog
      open={true}
      onOpenChange={vi.fn()}
      projectId="proj1"
      username="testuser"
      sourceLanguage="en"
      targetLanguage="es"
      getToken={vi.fn(async () => "tok")}
      onImported={vi.fn(async () => undefined)}
    />,
  )
}

/** Navigate landing → upload screen and drop an mp3 into the panel. */
async function dropMp3() {
  fireEvent.click(screen.getByText("Upload files"))
  const file = new File([new Uint8Array([0, 1, 2])], "recording.mp3", { type: "audio/mpeg" })
  // The dropzone is the element with the drag-over handlers; target its input.
  const inputs = document.querySelectorAll('input[type="file"]')
  expect(inputs.length).toBeGreaterThan(0)
  fireEvent.change(inputs[0], { target: { files: [file] } })
}

describe("ImportDialog — IMPORT_FAILED instrumentation (silent-mp3-failure fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("captures IMPORT_FAILED with error + file metadata when the commit path throws", async () => {
    // Simulate the real incident: the media import pipeline rejects.
    mockImportFile.mockRejectedValue(
      new Error("Couldn't decode recording.mp3 — the file may be corrupt or in an unsupported codec."),
    )
    renderDialog()
    await dropMp3()

    await waitFor(() => {
      const failed = mockCapture.mock.calls.filter((c) => c[0] === IMPORT_FAILED)
      expect(failed).toHaveLength(1)
      expect(failed[0][1]).toMatchObject({
        import_stage: "upload",
        project_id: "proj1",
        file_exts: "mp3",
      })
      expect(String(failed[0][1].error_message)).toContain("recording.mp3")
      // No PII: file names must never be a property of their own.
      expect(failed[0][1]).not.toHaveProperty("file_names")
    })
  })

  it("captures the upload start and no IMPORT_FAILED event on success", async () => {
    mockImportFile.mockResolvedValue({ refs: [], speakerPairs: [] })
    renderDialog()
    await dropMp3()

    await waitFor(() => {
      const started = mockCapture.mock.calls.filter((c) => c[0] === IMPORT_STARTED)
      expect(started).toHaveLength(1)
      expect(started[0][1]).toMatchObject({
        import_type: "upload",
        project_id: "proj1",
      })
    })
    expect(mockCapture.mock.calls.filter((c) => c[0] === IMPORT_FAILED)).toHaveLength(0)
  })
})
