import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ParallelBiblesSidebar } from "./ParallelBiblesSidebar"
import {
  fetchHelloaoChapter,
  fetchHelloaoTranslations,
  HelloaoChapterNotFoundError,
} from "@/lib/parsers/helloao"

vi.mock("@/lib/parsers/helloao", async () => {
  // The not-found sentinel is plain data, so the real class is kept — only the
  // network entry points are stubbed.
  const actual = await vi.importActual<typeof import("@/lib/parsers/helloao")>(
    "@/lib/parsers/helloao",
  )
  return {
    HelloaoChapterNotFoundError: actual.HelloaoChapterNotFoundError,
    fetchHelloaoTranslations: vi.fn().mockResolvedValue([]),
    fetchHelloaoChapter: vi.fn().mockResolvedValue({
      chapter: { content: [] },
    }),
    flattenHelloaoContent: vi.fn(),
  }
})

const fetchChapter = vi.mocked(fetchHelloaoChapter)
const fetchTranslations = vi.mocked(fetchHelloaoTranslations)

type ChapterResponse = Awaited<ReturnType<typeof fetchHelloaoChapter>>

/** Minimal chapter payload — the sidebar reads only `chapter.content`. */
function chapterResponse(...nodes: ChapterResponse["chapter"]["content"]): ChapterResponse {
  return {
    translation: { id: "BSB" },
    book: { id: "GEN" },
    chapter: { number: 1, content: nodes },
  } as unknown as ChapterResponse
}

describe("ParallelBiblesSidebar missing references", () => {
  beforeEach(() => localStorage.clear())

  it.each([null, "GEN"])(
    "explains missing references for %s, even with pinned versions",
    (trackedRef) => {
      localStorage.setItem(
        "aquilla:parallel-bibles:versions", JSON.stringify(["BSB"]),
      )
      render(
        <ParallelBiblesSidebar
          trackedRef={trackedRef} open onToggle={() => {}}
        />,
      )
      expect(screen.getByText("No Bible references")).toBeInTheDocument()
      expect(screen.getByText(
        "The current cells have no Bible references with chapter and verse " +
        "numbers. Parallel Bibles needs these references to show matching text.",
      )).toBeInTheDocument()
      expect(screen.queryByText(/Scroll the editor/)).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Add version" }))
      expect(screen.getByRole("textbox", {
        name: "Search Bible versions",
      })).toBeInTheDocument()
    },
  )

  it("replaces the empty state when a Bible reference becomes available", () => {
    const { rerender } = render(
      <ParallelBiblesSidebar trackedRef="GEN" open onToggle={() => {}} />,
    )
    rerender(
      <ParallelBiblesSidebar trackedRef="GEN 1:1" open onToggle={() => {}} />,
    )
    expect(screen.queryByText("No Bible references")).not.toBeInTheDocument()
    expect(screen.getByText("GEN 1:1")).toBeInTheDocument()
    expect(screen.getByText(
      "No versions added yet. Add a bible version to read alongside your text.",
    )).toBeInTheDocument()
  })
})

// AQU-849 — a partner's parallel-resource pane went dead mid-demo and only a
// full page refresh brought it back. Every failure the pane can latch must be
// recoverable from inside the pane.
describe("ParallelBiblesSidebar failure recovery (AQU-849)", () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem("aquilla:parallel-bibles:versions", JSON.stringify(["BSB"]))
    fetchChapter.mockReset()
    fetchTranslations.mockReset().mockResolvedValue([])
  })

  it("retries a failed chapter lookup in place, without a reload", async () => {
    const { flattenHelloaoContent } = await import("@/lib/parsers/helloao")
    vi.mocked(flattenHelloaoContent).mockReturnValue("In the beginning")
    fetchChapter
      .mockRejectedValueOnce(new Error("Failed to fetch BSB/GEN/1 (503)"))
      .mockResolvedValueOnce(chapterResponse({ type: "verse", number: 1, content: [] }))

    render(<ParallelBiblesSidebar trackedRef="GEN 1:1" open onToggle={() => {}} />)

    const retry = await screen.findByRole("button", { name: "Retry BSB" })
    expect(screen.getByText("Failed to fetch BSB/GEN/1 (503)")).toBeInTheDocument()

    fireEvent.click(retry)

    expect(await screen.findByText("In the beginning")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry BSB" })).not.toBeInTheDocument()
    expect(fetchChapter).toHaveBeenCalledTimes(2)
  })

  it("renders a version without that chapter as 'no text', not as an error", async () => {
    fetchChapter.mockRejectedValue(new HelloaoChapterNotFoundError("BSB/GEN/1"))

    render(<ParallelBiblesSidebar trackedRef="GEN 1:1" open onToggle={() => {}} />)

    expect(
      await screen.findByText("No text for GEN 1:1 in this version."),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry BSB" })).not.toBeInTheDocument()
  })

  it("retries the translations list from the picker", async () => {
    fetchChapter.mockResolvedValue(chapterResponse())
    fetchTranslations
      .mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([
        {
          id: "WEB",
          name: "World English Bible",
          englishName: "World English Bible",
          shortName: "WEB",
          language: "eng",
          languageName: "English",
          languageEnglishName: "English",
          textDirection: "ltr",
          licenseUrl: "",
          website: "",
          numberOfBooks: 66,
          totalNumberOfChapters: 1189,
          totalNumberOfVerses: 31102,
        },
      ])

    render(<ParallelBiblesSidebar trackedRef="GEN 1:1" open onToggle={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Add version" }))

    const retry = await screen.findByRole("button", { name: "Retry loading versions" })
    expect(screen.getByText("Failed to load: offline")).toBeInTheDocument()

    fireEvent.click(retry)

    expect(await screen.findByText("World English Bible")).toBeInTheDocument()
  })

  it("keeps a render throw inside the pane and recovers on retry", async () => {
    // A malformed upstream payload is the class of bug that took the whole
    // workspace down: before AQU-849 the nearest boundary was AppShell's.
    fetchChapter.mockImplementation(() => {
      throw new Error("boom")
    })

    render(<ParallelBiblesSidebar trackedRef="GEN 1:1" open onToggle={() => {}} />)

    expect(
      await screen.findByText(
        "This panel stopped responding. Retry to reload it — your work is untouched.",
      ),
    ).toBeInTheDocument()

    fetchChapter.mockReset().mockResolvedValue(chapterResponse())
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(screen.getByText("Parallel Bibles")).toBeInTheDocument())
  })
})
