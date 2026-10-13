// RunChecks — the run's Checks tab (PR threads spec §4). A reviewer opens it
// to find what needs them: those findings come first, most severe first, and
// every row goes straight to that cell in Files changed.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { RunChecks } from "./RunChecks"
import { runReviewOf } from "@/hooks/useRunReview"
import type { ContextualDraftRecord, ContextualRunRecord } from "@/lib/contextual/transport"
import { findingsFromVerdicts } from "@/lib/agent/draft-findings"
import { encodeBibleParams } from "../../../db/shared/bible-checks/params"

/** This device's Bible data experiment (AQU-1685), off unless a test turns it on. */
const experiment = vi.hoisted(() => ({ on: false }))
vi.mock("@/hooks/useBibleDataExperiment", () => ({ useBibleDataExperiment: () => experiment.on }))

beforeEach(() => {
  experiment.on = false
})

const run = { runId: "run-1", fileId: "f1" } as ContextualRunRecord

const draft = (cellId: string, triage: "human" | "advisory" | null, severity = 0): ContextualDraftRecord => ({
  draftId: `d-${cellId}`, runId: "run-1", cellId, text: `text ${cellId}`, spanLabel: "MRK 1:1–1:8",
  review: {
    findings: triage ? [{ code: triage === "human" ? "unsupported" : "lint:term-x", kind: triage === "human" ? "unsupported" : "lint", detail: triage === "human" ? null : "term-x" }] : [],
    triage, severity,
  },
})

function view(drafts: ContextualDraftRecord[]) {
  return render(
    <MemoryRouter>
      <RunChecks projectId="p1" run={run} review={{ ...runReviewOf(drafts), loading: false }} />
    </MemoryRouter>,
  )
}

describe("RunChecks", () => {
  it("lists needs-you findings first, then advisory, and leaves clean drafts out", () => {
    view([draft("a", "advisory", 2), draft("b", "human", 3), draft("c", null)])
    const needs = screen.getByTestId("checks-needs-you")
    const advisory = screen.getByTestId("checks-advisory")
    expect(needs.compareDocumentPosition(advisory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(needs).getByText("Wording not found in the sources")).toBeInTheDocument()
    expect(within(advisory).getByText("Project rule: term-x")).toBeInTheDocument()
    expect(screen.queryByText("text c")).not.toBeInTheDocument()
  })

  it("links each finding to its cell in Files changed", () => {
    view([draft("b", "human", 3)])
    const link = screen.getByRole("link", { name: "Open MRK 1:1–1:8 · b in Files changed" })
    expect(link.getAttribute("href")).toContain("view=review")
    expect(link.getAttribute("href")).toContain("cell=b")
  })

  const bibleDraft = (): ContextualDraftRecord => ({
    draftId: "d-9", runId: "run-1", cellId: "c9", text: "text c9", spanLabel: "JHN 4:9",
    review: findingsFromVerdicts({
      "bkp:V2": encodeBibleParams({
        kind: "close-after-aside", level: "1", evidence: "speech",
        startRef: "JHN 4:9", startWord: "8", endRef: "JHN 4:9", endWord: "18",
        speakerSources: "fcbh,macula", speakerConf: "0.97",
      }),
      _triage: "human",
      _severity: "3",
    }),
  })

  // AQU-1690: a Bible data finding names its check and says what is wrong and
  // where the fact comes from, from the params the server stored on the draft.
  it("shows a Bible data finding with its explanation and pack evidence", () => {
    experiment.on = true
    view([bibleDraft()])
    const needs = screen.getByTestId("checks-needs-you")
    expect(within(needs).getByText("Bible data: Quotation closes")).toBeInTheDocument()
    expect(within(needs).getByText(/closes after the narration that follows it/)).toBeInTheDocument()
    expect(within(needs).getByText(/OpenText speech JHN 4:9 words 8.18; speaker from Clear speaker-quotations, Macula/)).toBeInTheDocument()
  })

  // AQU-1685: Bible data shows only on a device with the experiment on. The
  // draft still needs a reviewer, as the server decided (the counts above the
  // tab say so too), but this device does not name the Bible data reason.
  it("keeps the draft under Needs you, without its Bible data reason, while the experiment is off", () => {
    view([bibleDraft()])
    const needs = screen.getByTestId("checks-needs-you")
    expect(within(needs).getByText("text c9")).toBeInTheDocument()
    expect(within(needs).getByText("Needs you")).toBeInTheDocument()
    expect(within(needs).queryByText("Bible data: Quotation closes")).toBeNull()
    expect(within(needs).queryByText(/closes after the narration that follows it/)).toBeNull()
    expect(within(needs).queryByText(/OpenText speech/)).toBeNull()
  })

  it("says so plainly when every pending draft passed cleanly", () => {
    view([draft("c", null)])
    expect(screen.getByText("No findings. Every pending draft passed its checks cleanly.")).toBeInTheDocument()
  })
})
