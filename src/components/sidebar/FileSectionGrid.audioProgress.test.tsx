// AQU-2112: a file EXPANDED IN THE SIDEBAR WITHOUT BEING OPENED is drawn from
// the server's per-chapter progress. That response has always carried each
// chapter's recorded and audio-validated counts, and this grid threw them away
// for a hardcoded zero — so an audio-only file read 0% however many of its
// takes were signed off. Producer (the /progress response) through consumer
// (the chapter spine), per AGENTS.md testing rule 12.
//
// UI-only journey: covered here in RTL, no smoke spec (testing rule 4).

import { act, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileSectionGrid } from "./FileSectionGrid"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import {
  resetFileProgressResourceForTests,
  type FileProgressResponse,
  type ProgressCounts,
} from "@/lib/progress/file-progress-resource"

const PROJECT = "p1"

function section(key: string, counts: Partial<ProgressCounts> = {}): { key: string } & ProgressCounts {
  return {
    key,
    totalCount: 2,
    filledCount: 0,
    validatedCount: 0,
    validationLevels: [0],
    audioCount: 0,
    audioValidatedCount: 0,
    ...counts,
  }
}

function response(fileId: string, sections: Array<{ key: string } & ProgressCounts>): FileProgressResponse {
  return {
    fileId,
    revision: 1,
    validationCount: 1,
    file: section("file"),
    sections,
    source: "projection",
  }
}

async function renderGrid(fileId: string, sections: Array<{ key: string } & ProgressCounts>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    Response.json(response(fileId, sections), { headers: { ETag: `"${fileId}"` } }),
  ))
  await act(async () => {
    render(
      <I18nProvider>
        <FileSectionGrid
          projectId={PROJECT}
          fileId={fileId}
          validationCount={1}
          getTokenForFile={async () => "token"}
          onSectionClick={vi.fn()}
        />
      </I18nProvider>,
    )
  })
  await waitFor(() => expect(screen.getAllByTestId("book-health-chapter").length).toBe(sections.length))
  return screen.getAllByTestId("book-health-chapter")
}

const figure = (row: HTMLElement, kind: "text" | "audio") =>
  row.querySelector(`[data-progress-figure="${kind}"]`)?.textContent ?? null

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await resetFileProgressResourceForTests()
})

describe("FileSectionGrid — audio progress from the server (AQU-2112)", () => {
  it("reads an audio-only file's fully validated chapter as complete, without opening it", async () => {
    const rows = await renderGrid("audio-only", [
      section("GEN 1", { audioCount: 2, audioValidatedCount: 2 }),
      section("GEN 2"),
    ])

    // The repro's expectation: chapter 1 complete, chapter 2 at zero, and the
    // figures in AUDIO — the text pair cannot move on a language with no
    // written form, and chapter 1 used to read 0% because of it.
    expect(figure(rows[0], "audio")).toBe("100%")
    expect(figure(rows[0], "text")).toBeNull()
    expect(figure(rows[1], "audio")).toBe("0%")
    expect(within(rows[0]).getByText(/100% recorded/)).toBeTruthy()
  })

  it("shows a recorded-but-unvalidated chapter short of complete", async () => {
    const rows = await renderGrid("partly", [section("GEN 1", { audioCount: 2, audioValidatedCount: 1 })])
    expect(figure(rows[0], "audio")).toBe("50%")
    expect(within(rows[0]).getByText(/100% recorded/)).toBeTruthy()
  })

  it("keeps a mixed file's text figure and adds the audio one beside it", async () => {
    const rows = await renderGrid("mixed", [
      section("GEN 1", { filledCount: 2, validatedCount: 2, audioCount: 2, audioValidatedCount: 1 }),
    ])
    expect(figure(rows[0], "text")).toBe("100%")
    expect(figure(rows[0], "audio")).toBe("50%")
  })

  it("leaves a text-only file's chapter figure exactly as it was", async () => {
    const rows = await renderGrid("text-only", [section("GEN 1", { filledCount: 2, validatedCount: 1 })])
    expect(figure(rows[0], "text")).toBe("50%")
    expect(figure(rows[0], "audio")).toBeNull()
    expect(within(rows[0]).getByText(/100% translated/)).toBeTruthy()
  })

  it("treats a worker that sends no audio counts as a text-only file, never as 0% recorded", async () => {
    const bare = section("GEN 1", { filledCount: 2, validatedCount: 2 })
    delete bare.audioCount
    delete bare.audioValidatedCount
    const rows = await renderGrid("legacy-worker", [bare])
    expect(figure(rows[0], "text")).toBe("100%")
    expect(figure(rows[0], "audio")).toBeNull()
  })
})
