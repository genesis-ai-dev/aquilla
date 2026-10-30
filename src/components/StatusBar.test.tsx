import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CellSummary } from "@/hooks/useActiveCellStore"
import { StatusBar as StatusBarView } from "./StatusBar"
import { useHealth } from "@/hooks/useHealth"
import { applyStructuralPolicy } from "@/lib/cells/structural"
import { PROGRESS_BG } from "@/lib/progress/progress-palette"
import { useCallback, type ComponentProps } from "react"

function StatusBar({ cells, healthMap, countStructural = true, ...props }: {
  cells: readonly CellSummary[]; healthMap: Map<string, number>; countStructural?: boolean
} & Omit<ComponentProps<typeof StatusBarView>, "progress" | "getHealthByCell">) {
  // Use the same live counter source as the workspace, including when health
  // scoring is off. The footer must not regress to server snapshot counters.
  // AQU-1083: and the same policy step the workspace applies on top of it.
  const { fileProgress } = useHealth(new Map([["active", cells]]), [], { enabled: false })
  const progress = applyStructuralPolicy(fileProgress.get("active")!, cells, countStructural)
  const getHealthByCell = useCallback(() => cells.map(cell => ({
    cellId: cell.id, label: cell.cellLabel || cell.id, health: healthMap.get(cell.id) ?? 0,
  })), [cells, healthMap])
  return <StatusBarView progress={progress} getHealthByCell={getHealthByCell} {...props} />
}

const cells = [
  { id: "a", cellLabel: "Genesis 1:1", status: "empty" },
  { id: "b", cellLabel: "Genesis 1:2", status: "validated" },
] as CellSummary[]

function trigger(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-slot="popover-trigger"]')!
}

describe("StatusBar health breakdown", () => {
  it("does no per-cell health reads while closed, then shows current data and jump actions", async () => {
    const healthMap = new Map([["a", 10], ["b", 100]])
    const get = vi.spyOn(healthMap, "get")
    const onJumpToCell = vi.fn()
    const { container, rerender } = render(<StatusBar cells={cells} healthMap={healthMap} projectHealth={55} onJumpToCell={onJumpToCell} />)
    expect(get).not.toHaveBeenCalled()
    fireEvent.click(trigger(container))
    const first = await screen.findByRole("button", { name: /Genesis 1:1.*10%/ })
    fireEvent.click(first)
    expect(onJumpToCell).toHaveBeenCalledWith("a")

    // Live score changes while open must update both the score and ranking.
    const updated = new Map([["a", 100], ["b", 15]])
    rerender(<StatusBar cells={cells} healthMap={updated} projectHealth={58} onJumpToCell={onJumpToCell} />)
    expect(await screen.findByRole("button", { name: /Genesis 1:2.*15%/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Genesis 1:1/ })).toBeNull()
    fireEvent.click(trigger(container))
    await waitFor(() => expect(screen.queryByRole("button", { name: /Genesis 1:2/ })).toBeNull())

    const next = new Map([["c", 5]])
    const nextGet = vi.spyOn(next, "get")
    const nextCells = [{ id: "c", cellLabel: "New lane", status: "unvalidated" }] as CellSummary[]
    rerender(<StatusBar cells={nextCells} healthMap={next} projectHealth={5} />)
    expect(nextGet).not.toHaveBeenCalled()
    fireEvent.click(trigger(container))
    expect(await screen.findByRole("button", { name: /New lane.*5%/ })).toBeDisabled()
  })

  // AQU-2260 (Oct 29, fourth pass): a click opens it, never hover.
  it("opens on a click, not on hover, and handles an empty scope", async () => {
    const { container } = render(<StatusBar cells={[]} healthMap={new Map()} projectHealth={100} />)
    fireEvent.pointerEnter(trigger(container), { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger(container))
    fireEvent.mouseMove(trigger(container))
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(screen.queryByText("project health")).toBeNull()
    expect(screen.getByRole("button", { name: "Project health: 100%" })).toBe(trigger(container))
    fireEvent.click(trigger(container))
    expect(await screen.findByText("project health")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Genesis/ })).toBeNull()
  })

  it("does not build breakdown data for a closed large file", () => {
    const healthMap = new Map<string, number>()
    const get = vi.spyOn(healthMap, "get")
    const many = Array.from({ length: 31_215 }, (_, i) => ({ ...cells[0], id: String(i) }))
    const { rerender } = render(<StatusBar cells={many} healthMap={healthMap} projectHealth={0} />)
    rerender(<StatusBar cells={[...many]} healthMap={healthMap} projectHealth={1} />)
    expect(get).not.toHaveBeenCalled()
  })
})

it("updates footer counts across empty, drafted, validated and removed cells", () => {
  const healthMap = new Map<string, number>()
  const { container, rerender } = render(<StatusBar cells={cells} healthMap={healthMap} projectHealth={0} />)
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("2 cells")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("1 translated")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("1 validated")
  const drafted = [{ ...cells[0], status: "unvalidated" as const }, cells[1]]
  rerender(<StatusBar cells={drafted} healthMap={healthMap} projectHealth={0} />)
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("2 translated")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("1 unvalidated")
  rerender(<StatusBar cells={[]} healthMap={healthMap} projectHealth={0} />)
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("0 cells")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).toContain("0 translated")
  expect(container.textContent?.replace(/[\u2066-\u2069]/g, "")).not.toContain("unvalidated")
})

// AQU-1764: the two counts lose their amber and green. They are in the text
// colour, each after a swatch in the tone the sidebar's file bar uses for it.
it("marks the unvalidated and validated counts with progress-palette swatches", () => {
  const drafted = [{ ...cells[0], status: "unvalidated" as const }, cells[1]]
  render(<StatusBar cells={drafted} healthMap={new Map()} projectHealth={0} />)
  for (const [id, fill] of [
    ["status-bar-unvalidated", PROGRESS_BG.textTranslated],
    ["status-bar-validated", PROGRESS_BG.textValidated],
  ]) {
    const badge = screen.getByTestId(id)
    expect(badge.className, id).toContain("text-foreground")
    expect(badge.className, id).not.toMatch(/amber|green/)
    expect(badge.querySelector("[aria-hidden]")!.className, id).toContain(fill)
  }
})

// AQU-1083. The editor footer is the ONE progress surface whose number is
// counted on the client (useHealth over the open file's cells) rather than
// read from the server, so it is the one place the policy can silently
// disagree with the rest of the app for the same file.
describe("StatusBar and the structural-cell policy", () => {
  const cell = (id: string, type: string, status: CellSummary["status"]): CellSummary =>
    ({ id, cellLabel: id, type, status } as CellSummary)

  /** Two verses (one translated) and two headings (both translated). */
  const CELLS: CellSummary[] = [
    cell("v1", "verse", "unvalidated"),
    cell("v2", "verse", "empty"),
    cell("h1", "heading", "validated"),
    cell("h2", "paratext", "unvalidated"),
  ]

  /** Bidi isolates wrap every formatted number (an Arabic reordering fix), so
   *  strip them before matching or every assertion here is unreadable. */
  const plain = (el: HTMLElement) => (el.textContent ?? "").replace(/[\u2066-\u2069]/g, "")

  it("counts headings by default", () => {
    // Absent policy must behave exactly as the footer did before the setting
    // existed: four cells, three of them with content.
    const { container } = render(<StatusBar cells={CELLS} healthMap={new Map()} projectHealth={100} />)
    expect(plain(container)).toContain("4 cells")
    expect(plain(container)).toContain("3")
  })

  it("drops headings from both halves of the ratio when excluded", () => {
    // Not just the denominator: a translated chapter title must leave the
    // numerator too, or the percentage climbs for work nobody did. Two verses
    // remain, one of them translated — 50%, not 75%.
    const { container } = render(
      <StatusBar cells={CELLS} healthMap={new Map()} projectHealth={100} countStructural={false} />,
    )
    expect(plain(container)).toContain("2 cells")
    expect(plain(container)).toContain("50")
    expect(plain(container)).not.toContain("4 cells")
  })
})

// AQU-1493: plain rounding put 251 of 252 at "100%" beside a blank line, the
// one progress figure the shared rule had missed.
it("never reads 100% while a cell is untranslated", () => {
  const many = Array.from({ length: 252 }, (_, i) =>
    ({ id: String(i), cellLabel: String(i), status: i === 0 ? "empty" : "validated" }) as CellSummary)
  const { container, rerender } = render(<StatusBar cells={many} healthMap={new Map()} projectHealth={0} />)
  const plain = () => (container.textContent ?? "").replace(/[\u2066-\u2069]/g, "")
  expect(plain()).toContain("251 translated (99%)")
  const done = many.map((c) => ({ ...c, status: "validated" as const }))
  rerender(<StatusBar cells={done} healthMap={new Map()} projectHealth={0} />)
  expect(plain()).toContain("252 translated (100%)")
})

// AQU-2111: the footer counts the open file itself, so it is the other half of
// the "an audio-only file reads 0%" bug. The audio figures ride in on the same
// progress prop; `StatusBarView` is rendered directly here because the pair is
// counted from the attachment map, not from cells.
describe("StatusBar and audio figures", () => {
  const plain = (el: HTMLElement) => (el.textContent ?? "").replace(/[\u2066-\u2069]/g, "")
  const view = (progress: ComponentProps<typeof StatusBarView>["progress"]) =>
    render(<StatusBarView progress={progress} getHealthByCell={() => []} projectHealth={0} />)

  it("reports the recorded figure, and no text figures, on an audio-only file", () => {
    const { container } = view({ total: 10, translated: 0, validated: 0, recorded: 5, audioValidated: 5 })
    expect(plain(container)).toContain("10 lines")
    expect(plain(container)).toContain("5 recorded (50%)")
    expect(plain(container)).not.toContain("translated")
    expect(screen.queryByTestId("status-bar-unvalidated")).toBeNull()
    expect(screen.queryByTestId("status-bar-validated")).toBeNull()
    const badge = screen.getByTestId("status-bar-validated-audio")
    expect(plain(badge)).toContain("5 audio validated")
    expect(badge.querySelector("[aria-hidden]")!.className).toContain(PROGRESS_BG.audioValidated)
  })

  it("splits recorded-but-unvalidated from audio-validated, in the audio tones", () => {
    const { container } = view({ total: 10, translated: 0, validated: 0, recorded: 6, audioValidated: 2 })
    expect(plain(container)).toContain("6 recorded (60%)")
    const pending = screen.getByTestId("status-bar-unvalidated-audio")
    expect(plain(pending)).toContain("4 recorded, not validated")
    expect(pending.querySelector("[aria-hidden]")!.className).toContain(PROGRESS_BG.audioRecorded)
  })

  it("keeps the text summary and adds the audio badges on a file with both", () => {
    const { container } = view({ total: 10, translated: 8, validated: 5, recorded: 4, audioValidated: 1 })
    expect(plain(container)).toContain("8 translated (80%)")
    expect(plain(container)).toContain("3 unvalidated")
    expect(plain(container)).toContain("5 validated")
    expect(plain(container)).toContain("3 recorded, not validated")
    expect(plain(container)).toContain("1 audio validated")
  })

  // WHY: an absent pair is "not known here" (an older sync-worker, or the
  // attachment map before it loads) and a zero is "none" — neither may put a
  // "0 recorded" badge in a text project's footer.
  it("draws nothing for audio when there is none, absent or zero", () => {
    for (const progress of [
      { total: 10, translated: 8, validated: 5 },
      { total: 10, translated: 8, validated: 5, recorded: 0, audioValidated: 0 },
    ]) {
      const { container, unmount } = view(progress)
      expect(plain(container)).toContain("8 translated (80%)")
      expect(plain(container)).not.toContain("recorded")
      expect(plain(container)).not.toContain("audio validated")
      unmount()
    }
  })
})

it("groups the badge counts the way the counts beside them are grouped", () => {
  // The footer read "1,208 cells · 1,207 translated" and then "1207 validated".
  const many = Array.from({ length: 2500 }, (_, i) =>
    ({ id: String(i), cellLabel: String(i), status: i < 1207 ? "validated" : "unvalidated" }) as CellSummary)
  const { container } = render(<StatusBar cells={many} healthMap={new Map()} projectHealth={0} />)
  const plain = (container.textContent ?? "").replace(/[\u2066-\u2069]/g, "")
  expect(plain).toContain("1,207 validated")
  expect(plain).toContain("1,293 unvalidated")
})

// Media redesign slice 2: the footer counts a language that delivers audio by
// its audio, through the same live counter (the store's `laneStatus`).
/** Without the bidi isolates the footer wraps every number in. */
const plain = (text: string | null) => (text ?? "").replace(/[\u2066-\u2069]/g, "")

describe("StatusBar in a language that counts its recordings", () => {
  const audioCells = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, status: "empty", laneStatus: "validated" })),
    ...Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, status: "empty", laneStatus: "unvalidated" })),
    ...Array.from({ length: 35 }, (_, i) => ({ id: `e${i}`, status: "empty", laneStatus: "empty" })),
  ] as CellSummary[]

  function AudioFooter({ cells: rows, delivers, extra }: {
    cells: readonly CellSummary[]
    delivers: "audio" | "text_and_audio"
    extra?: { needsText: number; needsAudio: number; textTranslated?: number; textValidated?: number; recorded?: number; audioValidated?: number }
  }) {
    const { fileProgress } = useHealth(new Map([["active", rows]]), [], { enabled: false })
    const progress = { ...fileProgress.get("active")!, delivers, ...extra }
    return <StatusBarView progress={progress} getHealthByCell={() => []} projectHealth={50} />
  }

  it("Audio: 45 lines with 10 recorded and 6 approved, and no text badges (P2.1)", () => {
    render(<AudioFooter cells={audioCells} delivers="audio" />)
    expect(plain(screen.getByTestId("status-bar-summary").textContent)).toBe("45 lines · 10 recorded (22%)")
    expect(screen.getByTestId("status-bar-unvalidated-audio").textContent).toMatch(/4.* recorded, not validated/)
    expect(screen.getByTestId("status-bar-validated-audio").textContent).toMatch(/6.* audio validated/)
    expect(screen.queryByTestId("status-bar-unvalidated")).toBeNull()
    expect(screen.queryByText(/translated/)).toBeNull()
  })

  it("Text: a language that delivers text draws no audio, however much is recorded", () => {
    render(
      <StatusBarView
        progress={{ total: 10, translated: 5, validated: 2, recorded: 8, audioValidated: 3, delivers: "text" }}
        getHealthByCell={() => []}
        projectHealth={50}
      />,
    )
    expect(plain(screen.getByTestId("status-bar-summary").textContent)).toBe("10 cells · 5 translated (50%)")
    expect(screen.queryByTestId("status-bar-unvalidated-audio")).toBeNull()
    expect(screen.queryByTestId("status-bar-validated-audio")).toBeNull()
  })

  it("nobody chose: a file with recordings and no text reads its audio (AQU-2110's evidence)", () => {
    render(
      <StatusBarView
        progress={{ total: 10, translated: 0, validated: 0, recorded: 8, audioValidated: 3 }}
        getHealthByCell={() => []}
        projectHealth={50}
      />,
    )
    expect(plain(screen.getByTestId("status-bar-summary").textContent)).toBe("10 lines · 8 recorded (80%)")
  })

  it("Text and audio: lines done on both halves, and how much of each half is left (P2.6)", () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, status: "validated", laneStatus: "validated" })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, status: "validated", laneStatus: "unvalidated" })),
      { id: "x", status: "empty", laneStatus: "empty" },
    ] as CellSummary[]
    render(<AudioFooter cells={rows} delivers="text_and_audio" extra={{ needsText: 3, needsAudio: 4 }} />)
    expect(plain(screen.getByTestId("status-bar-summary").textContent)).toBe("10 lines · 4 done (40%)")
    expect(screen.getByTestId("status-bar-text-left").textContent).toMatch(/Text left: .*3/)
    expect(screen.getByTestId("status-bar-audio-left").textContent).toMatch(/Audio left: .*4/)
  })

  it("Text and audio: the file row's two halves leave the footer's done figure alone (Sam, Oct 24)", () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, status: "validated", laneStatus: "validated" })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, status: "validated", laneStatus: "unvalidated" })),
      { id: "x", status: "empty", laneStatus: "empty" },
    ] as CellSummary[]
    render(
      <AudioFooter
        cells={rows}
        delivers="text_and_audio"
        extra={{ needsText: 3, needsAudio: 4, textTranslated: 9, textValidated: 9, recorded: 6, audioValidated: 6 }}
      />,
    )
    expect(plain(screen.getByTestId("status-bar-summary").textContent)).toBe("10 lines · 4 done (40%)")
    expect(screen.queryByTestId("status-bar-unvalidated")).toBeNull()
    expect(screen.queryByTestId("status-bar-validated")).toBeNull()
    expect(screen.queryByTestId("status-bar-unvalidated-audio")).toBeNull()
    expect(screen.queryByTestId("status-bar-validated-audio")).toBeNull()
  })
})
