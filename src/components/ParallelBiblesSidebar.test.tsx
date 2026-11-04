import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
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

/** AQU-2260 (Sam, Oct 29): a control that carries its own words has no hover. */
async function expectNoHoverTip(el: Element) {
  await userEvent.setup().hover(el)
  await act(() => new Promise((r) => setTimeout(r, 30)))
  expect(screen.queryByRole("tooltip")).toBeNull()
}

describe("ParallelBiblesSidebar — the closed edge tab", () => {
  it("carries its own word, so it has no hover", async () => {
    render(<TooltipProvider delay={0}><ParallelBiblesSidebar trackedRef="GEN 1:1" open={false} onToggle={() => {}} /></TooltipProvider>)
    await expectNoHoverTip(screen.getByRole("button", { name: "Show parallel bibles" }))
  })
})

function translation(id: string, over: Partial<Awaited<ReturnType<typeof fetchHelloaoTranslations>>[number]>) {
  return {
    id, name: id, englishName: id, shortName: id, language: "eng", languageName: "English",
    languageEnglishName: "English", textDirection: "ltr", licenseUrl: "", website: "",
    numberOfBooks: 66, totalNumberOfChapters: 1189, totalNumberOfVerses: 31102, ...over,
  }
}

const CATALOGUE = [
  translation("BSB", { shortName: "BSB", englishName: "Berean Standard Bible", licenseUrl: "https://berean.bible/", website: "https://berean.bible/" }),
  translation("hbo_wlc", {
    shortName: "WLC", englishName: "Westminster Leningrad Codex Hebrew OT", language: "hbo", textDirection: "rtl",
    licenseUrl: "https://ebible.org/Scriptures/details.php?id=hboWLC", website: "https://ebible.org/Scriptures/details.php?id=hboWLC",
  }),
]

function verses(from: number, to: number, label: string) {
  return Array.from({ length: to - from + 1 }, (_, i) => ({
    type: "verse" as const, number: from + i, content: [`${label} ${from + i}`],
  }))
}

describe("ParallelBiblesSidebar — whole chapters side by side", () => {
  it("searches a catalogue whose entries leave out the language name", async () => {
    const { languageName: _a, languageEnglishName: _b, ...bare } = translation("XYZ", { englishName: "Bare entry" })
    fetchTranslations.mockReset().mockResolvedValue([bare, ...CATALOGUE])
    render(<ParallelBiblesSidebar trackedRef="GEN 1:1" open onToggle={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Add version" }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Search Bible versions" }), { target: { value: "hbo" } })
    expect(await screen.findByText("Westminster Leningrad Codex Hebrew OT")).toBeInTheDocument()
  })


  beforeEach(async () => {
    localStorage.clear()
    const { flattenHelloaoContent } = await import("@/lib/parsers/helloao")
    vi.mocked(flattenHelloaoContent).mockImplementation((content) => content.filter((c) => typeof c === "string").join(" "))
    fetchTranslations.mockReset().mockResolvedValue(CATALOGUE)
    fetchChapter.mockReset().mockImplementation(async (id, _book, chapter) =>
      id === "BSB" ? chapterResponse(...verses(1, 6, `BSB ${chapter}`)) : chapterResponse(...verses(1, 24, `WLC ${chapter}`)),
    )
  })

  it("lines English MAL 4:1 up with Hebrew MAL 3:19, right to left, with a credit under each column", async () => {
    localStorage.setItem("aquilla:parallel-bibles:view", "passage")
    render(<ParallelBiblesSidebar projectId="p1" projectDefaults={["BSB", "hbo_wlc"]} trackedRef="MAL 4:1" open onToggle={() => {}} />)

    const hebrew = await screen.findByTestId("passage-column-hbo_wlc")
    await waitFor(() => expect(hebrew.querySelector('[aria-current="true"]')?.textContent).toContain("WLC 3 19"))
    expect(fetchChapter).toHaveBeenCalledWith("hbo_wlc", "MAL", 3)
    expect(hebrew.querySelector('[dir="rtl"][lang="hbo"]')).not.toBeNull()
    expect(hebrew.textContent).toContain("Numbered MAL 3:19 in this version (MAL 4:1 in English).")
    const credit = hebrew.querySelector('[data-testid="version-credit"]')
    expect(credit?.textContent).toBe("Westminster Leningrad Codex Hebrew OT · License")
    expect(credit?.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer")

    const english = screen.getByTestId("passage-column-BSB")
    expect(english.querySelector('[aria-current="true"]')?.textContent).toContain("BSB 4 1")
    expect(english.querySelector('[data-testid="versification-mark"]')).toBeNull()
    expect(screen.getByText("Showing this project's default versions.")).toBeInTheDocument()
  })

  it("offsets a Hebrew psalm by its numbered title, read against the first version that has the psalm", async () => {
    localStorage.setItem("aquilla:parallel-bibles:view", "passage")
    fetchTranslations.mockReset().mockResolvedValue([translation("grc_sbl", { language: "grc" }), ...CATALOGUE])
    fetchChapter.mockReset().mockImplementation(async (id) => {
      if (id === "grc_sbl") throw new HelloaoChapterNotFoundError("grc_sbl/PSA/3")
      return id === "BSB"
        ? chapterResponse({ type: "hebrew_subtitle", content: ["A Psalm of David"] }, ...verses(1, 8, "BSB"))
        : chapterResponse(...verses(1, 9, "WLC"))
    })
    render(<ParallelBiblesSidebar projectDefaults={["grc_sbl", "BSB", "hbo_wlc"]} trackedRef="PSA 3:4" open onToggle={() => {}} />)

    const hebrew = await screen.findByTestId("passage-column-hbo_wlc")
    await waitFor(() => expect(hebrew.querySelector('[aria-current="true"]')?.textContent).toContain("WLC 5"))
    expect(hebrew.textContent).toContain("This version counts the psalm title as a verse, so its numbers run 1 ahead.")
  })

  it("lets a lead save their own pins as the project defaults, and hides that from everyone else", async () => {
    localStorage.setItem("aquilla:parallel-bibles:p1:versions", JSON.stringify(["hbo_wlc", "BSB"]))
    const onSet = vi.fn().mockResolvedValue(true)
    const { rerender } = render(
      <ParallelBiblesSidebar projectId="p1" projectDefaults={["BSB"]} trackedRef="GEN 1:1" open onToggle={() => {}} onSetProjectDefaults={onSet} />,
    )
    expect(screen.queryByRole("button", { name: "Make these the project defaults" })).toBeNull()
    expect(screen.getByRole("button", { name: "Use the project defaults" })).toBeInTheDocument()

    rerender(
      <ParallelBiblesSidebar projectId="p1" projectDefaults={["BSB"]} trackedRef="GEN 1:1" open onToggle={() => {}} onSetProjectDefaults={onSet} canSetProjectDefaults />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Make these the project defaults" }))
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(["hbo_wlc", "BSB"]))
    // Saved: the lead now follows the defaults like everyone else.
    await waitFor(() => expect(localStorage.getItem("aquilla:parallel-bibles:p1:versions")).toBeNull())
  })
})
