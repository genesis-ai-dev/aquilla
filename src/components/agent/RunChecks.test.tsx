// RunChecks — the run's Checks tab (PR threads spec §4). A reviewer opens it
// to find what needs them: those findings come first, most severe first, and
// every row goes straight to that cell in Files changed.

import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { RunChecks } from "./RunChecks"
import { runReviewOf } from "@/hooks/useRunReview"
import type { ContextualDraftRecord, ContextualRunRecord } from "@/lib/contextual/transport"
import { findingsFromVerdicts } from "@/lib/agent/draft-findings"
import { encodeBibleParams } from "../../../db/shared/bible-checks/params"

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

  // AQU-1690: a Bible data finding names its check and says what is wrong and
  // where the fact comes from, from the params the server stored on the draft.
  it("shows a Bible data finding with its explanation and pack evidence", () => {
    const verdicts = {
      "bkp:V2": encodeBibleParams({
        kind: "close-after-aside", level: "1", evidence: "speech",
        startRef: "JHN 4:9", startWord: "8", endRef: "JHN 4:9", endWord: "18",
        speakerSources: "fcbh,macula", speakerConf: "0.97",
      }),
      _triage: "human",
      _severity: "3",
    }
    view([{ draftId: "d-9", runId: "run-1", cellId: "c9", text: "text c9", spanLabel: "JHN 4:9", review: findingsFromVerdicts(verdicts) }])
    const needs = screen.getByTestId("checks-needs-you")
    expect(within(needs).getByText("Bible data: Quotation closes")).toBeInTheDocument()
    expect(within(needs).getByText(/closes after the narration that follows it/)).toBeInTheDocument()
    expect(within(needs).getByText(/OpenText speech JHN 4:9 words 8.18; speaker from Clear speaker-quotations, Macula/)).toBeInTheDocument()
  })

  // AQU-1701: a Translation Question the draft may not answer is advisory
  // (info): the reviewer sees the answer it may not give and the question.
  it("shows a comprehension (C1) finding as advisory, with the answer and the question", () => {
    const verdicts = {
      "bkp:C1": encodeBibleParams({
        kind: "answer-missing", evidence: "translation-question", tq: "tq:172802", refs: "JHN 4:9",
        question: "Why was the Samaritan woman suprised that Jesus would talk to her?",
        answer: "She was surprised because Jews had no dealings with the Samaritans.",
      }),
      _triage: "advisory",
      _severity: "2",
    }
    view([{ draftId: "d-9", runId: "run-1", cellId: "c9", text: "text c9", spanLabel: "JHN 4:9", review: findingsFromVerdicts(verdicts) }])
    const advisory = screen.getByTestId("checks-advisory")
    expect(within(advisory).getByText("Bible data: Comprehension")).toBeInTheDocument()
    expect(
      within(advisory).getByText("Comprehension: the translation may not say that “She was surprised because Jews had no dealings with the Samaritans.”"),
    ).toBeInTheDocument()
    expect(
      within(advisory).getByText("Translation Question (JHN 4:9): Why was the Samaritan woman suprised that Jesus would talk to her?"),
    ).toBeInTheDocument()
  })

  it("says so plainly when every pending draft passed cleanly", () => {
    view([draft("c", null)])
    expect(screen.getByText("No findings. Every pending draft passed its checks cleanly.")).toBeInTheDocument()
  })
})
