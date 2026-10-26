// The Languages table on the project overview: its People column (AQU-2027) and
// its two validation columns (AQU-2178).
//
// AQU-2027 — the People column. It lists the members who are
// limited to each lane. Since AQU-1813 a project lead (500) can be limited to
// lanes too, but the column only read the scopes of members below project
// lead, so a lane-limited lead never appeared ("—") however they were staffed.
// Maintainers (600+) see every lane and are never lane-scoped, so they are
// still not read.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OverviewLaneTable } from "./OverviewLaneTable"
import type { PortfolioLane } from "@/lib/frontier/portfolio"

type Scope = { kind: "lane" | "file"; value: string }

const { mockFetchMemberScopes } = vi.hoisted(() => ({
  mockFetchMemberScopes: vi.fn(
    async (_jwt: string, _projectId: string, _userId: number) => [] as Scope[] | null,
  ),
}))

vi.mock("@/lib/sync/member-scopes", () => ({
  fetchMemberScopes: mockFetchMemberScopes,
}))

const role = (level: number, name: string) => ({ level, name, source: "override" as const })

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: vi.fn(() => ({
    members: [
      { userId: 10, username: "maria", role: role(400, "contributor"), secondarySources: [] },
      { userId: 12, username: "wendi", role: role(500, "project_lead"), secondarySources: [] },
      { userId: 13, username: "jade", role: role(600, "maintainer"), secondarySources: [] },
    ],
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: vi.fn(async () => {}),
  })),
}))

// The row's popovers and dialogs have their own suites; the column is the unit here.
vi.mock("@/components/StaffLanePopover", () => ({ StaffLanePopover: () => null }))
vi.mock("@/components/AssignModal", () => ({ AssignModal: () => null }))

function lane(tag: string, laneId: string): PortfolioLane {
  return {
    lane: tag,
    laneId,
    name: null,
    role: "target",
    totalCells: 10,
    filledCells: 0,
    validatedCells: 0,
    lastEditAt: null,
  }
}

function renderTable() {
  return render(
    <MemoryRouter>
      <OverviewLaneTable
        projectId="proj-1"
        projectName="Only one file"
        orgId={1}
        jwt="jwt-owner"
        lanes={[lane("French", "ln-fr"), lane("Swedish", "ln-sv")]}
        defaultLanguageLabel="English"
        extraLanes={[]}
        files={[]}
        roleLevel={700}
        author="owner"
        canManageLanes
        canAddLanguage
      />
    </MemoryRouter>,
  )
}

/** The user ids drawn in one lane's People cell. */
function peopleIn(tag: string): string[] {
  const cell = screen.getByTestId(`overview-lane-people-${tag}`)
  return [...cell.querySelectorAll("[data-user-id]")].map((el) => el.getAttribute("data-user-id") ?? "")
}

beforeEach(() => {
  mockFetchMemberScopes.mockReset()
  // Stored as lane ids, the way the Staff popover writes them (AQU-1607).
  mockFetchMemberScopes.mockImplementation(async (_jwt, _projectId, userId) => {
    if (userId === 10) return [{ kind: "lane", value: "ln-sv" }]
    if (userId === 12) return [{ kind: "lane", value: "ln-fr" }]
    return []
  })
})

describe("OverviewLaneTable People column", () => {
  it("lists a project lead limited to a lane in that lane's row", async () => {
    renderTable()

    await waitFor(() => expect(peopleIn("French")).toEqual(["12"]))
    expect(peopleIn("Swedish")).toEqual(["10"])
  })

  it("never reads a maintainer's scopes — they see every lane", async () => {
    renderTable()

    await waitFor(() => expect(mockFetchMemberScopes).toHaveBeenCalledWith("jwt-owner", "proj-1", 12))
    expect(mockFetchMemberScopes).toHaveBeenCalledWith("jwt-owner", "proj-1", 10)
    expect(mockFetchMemberScopes).not.toHaveBeenCalledWith("jwt-owner", "proj-1", 13)
  })
})

// ── AQU-2178: Text Validated / Audio Validated ───────────────────────────────
// The one "Validated" column used to print each language's DONE share, which
// since AQU-2167 means a different thing per language under a header that never
// said which. These are the two columns that replaced it.

/** A target language with the counts the two validation columns read. */
function metricLane(
  tag: string,
  counts: Partial<PortfolioLane> & Pick<PortfolioLane, "totalCells">,
): PortfolioLane {
  return {
    lane: tag,
    laneId: `ln-${tag}`,
    name: null,
    role: "target",
    filledCells: 0,
    validatedCells: 0,
    lastEditAt: null,
    ...counts,
  }
}

function renderLanes(lanes: PortfolioLane[], archivedLanes: PortfolioLane[] = []) {
  return render(
    <MemoryRouter>
      <OverviewLaneTable
        projectId="proj-1"
        orgId={1}
        jwt="jwt-owner"
        lanes={lanes}
        archivedLanes={archivedLanes}
        defaultLanguageLabel="English"
        extraLanes={[]}
        files={[]}
        roleLevel={700}
        author="owner"
        canManageLanes
        canAddLanguage
      />
    </MemoryRouter>,
  )
}

const figure = (kind: "text" | "audio", tag: string): string =>
  screen.getByTestId(`overview-lane-${kind}-validated-${tag}`).textContent ?? ""

describe("OverviewLaneTable validation columns (AQU-2178)", () => {
  it("prints a language's validated text and its approved recordings under separate headers", () => {
    renderLanes([
      // Text and audio: 3 of 10 lines have validated text, 1 of 10 an approved
      // recording, and only that 1 is done on both halves. The old single
      // column showed the 10% both-approved figure under "Validated"; the text
      // half now reads 30% in its own column and does not move the audio one.
      metricLane("fr", {
        delivers: "text_and_audio",
        totalCells: 10,
        filledCells: 6,
        validatedCells: 3,
        audioTotalCells: 10,
        audioCells: 4,
        validatedAudioCells: 1,
        bothValidatedCells: 1,
      }),
    ])

    expect(screen.getByText("Text Validated")).toBeInTheDocument()
    expect(screen.getByText("Audio Validated")).toBeInTheDocument()
    expect(figure("text", "fr")).toBe("30%")
    expect(figure("audio", "fr")).toBe("10%")
  })

  it("dashes the half a language does not owe instead of printing 0%", () => {
    renderLanes([
      // Audio: no text to validate.
      metricLane("sw", {
        delivers: "audio",
        totalCells: 10,
        audioTotalCells: 10,
        audioCells: 5,
        validatedAudioCells: 4,
      }),
      // Text, nothing recorded: AQU-1954 gives it an audio total of 0, so it
      // owes no audio. "0%" would read as audio work outstanding.
      metricLane("de", {
        delivers: "text",
        totalCells: 10,
        filledCells: 8,
        validatedCells: 2,
        audioTotalCells: 0,
        audioCells: 0,
        validatedAudioCells: 0,
      }),
    ])

    expect(figure("text", "sw")).toBe("\u2014")
    expect(figure("audio", "sw")).toBe("40%")
    expect(figure("text", "de")).toBe("20%")
    expect(figure("audio", "de")).toBe("\u2014")
  })

  it("keeps a Text language's figure identical to the old Validated column, and drops the audio column entirely", () => {
    renderLanes([
      metricLane("de", {
        delivers: "text",
        totalCells: 100,
        filledCells: 80,
        validatedCells: 50,
        audioTotalCells: 0,
        audioCells: 0,
        validatedAudioCells: 0,
      }),
    ])

    // The project owes no audio anywhere, so its only visible change is the
    // heading: no Audio Validated column, and no dash cell under one.
    expect(screen.queryByText("Audio Validated")).not.toBeInTheDocument()
    expect(screen.queryByTestId("overview-lane-audio-validated-de")).not.toBeInTheDocument()
    expect(figure("text", "de")).toBe("50%")
  })

  it("treats a server too old to send a language's audio as owing none", () => {
    // Pre-AQU-1951: no audioCells at all. Measuring against the project's
    // denominator is the one way this column could disagree with the Progress
    // card's tile for the same language, so it shows nothing instead.
    renderLanes([metricLane("de", { delivers: "text", totalCells: 10, validatedCells: 5 })])

    expect(screen.queryByText("Audio Validated")).not.toBeInTheDocument()
    expect(figure("text", "de")).toBe("50%")
  })

  it("sorts by the audio figure, with the languages that owe no audio last", () => {
    renderLanes([
      metricLane("aa", { delivers: "text", totalCells: 10, validatedCells: 9, audioTotalCells: 0, audioCells: 0 }),
      metricLane("bb", { delivers: "audio", totalCells: 10, audioTotalCells: 10, audioCells: 9, validatedAudioCells: 2 }),
      metricLane("cc", { delivers: "audio", totalCells: 10, audioTotalCells: 10, audioCells: 9, validatedAudioCells: 7 }),
    ])

    fireEvent.click(screen.getByRole("button", { name: /Audio Validated/ }))
    const order = () =>
      [...document.querySelectorAll<HTMLElement>("[data-testid^='overview-lane-row-']")]
        .map((row) => row.dataset.testid?.replace("overview-lane-row-", "") ?? "")

    // The header sorts highest-first on the first click; either way the two
    // ends are the real figures and "\u2014" sits at the far end of both.
    expect(order()).toEqual(["cc", "bb", "aa"])
    fireEvent.click(screen.getByRole("button", { name: /Audio Validated/ }))
    expect(order()).toEqual(["aa", "bb", "cc"])
  })

  it("labels an archived language's figures, one per half it owes", () => {
    renderLanes(
      [metricLane("de", { delivers: "text", totalCells: 10, validatedCells: 1, audioTotalCells: 0, audioCells: 0 })],
      [
        metricLane("fr", {
          archived: true,
          delivers: "text_and_audio",
          totalCells: 10,
          validatedCells: 3,
          audioTotalCells: 10,
          audioCells: 4,
          validatedAudioCells: 1,
          bothValidatedCells: 1,
        }),
      ],
    )

    fireEvent.click(screen.getByTestId("overview-lane-archived-toggle"))
    const row = screen.getByTestId("overview-lane-archived-row-fr")
    // No column headings there, so each figure says which half it is.
    expect(within(row).getByTestId("overview-lane-archived-text-validated-fr")).toHaveTextContent(
      "30% text validated",
    )
    expect(within(row).getByTestId("overview-lane-archived-audio-validated-fr")).toHaveTextContent(
      "10% audio validated",
    )
  })
})
