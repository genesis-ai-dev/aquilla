// AQU-2342 × AQU-2262: the Language profile and decision-log cards moved from
// Project settings into Living Memory → Checks. They must still save the way
// settings do: the write is refused over a teammate's newer change to the same
// setting (the patch is told what the person saw), "Saved" shows beside the
// card, and the change is one step in the project's Undo / History.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { historyView, resetHistoryForTests, setHistoryScope } from "@/lib/history/history"
import { clearHistoryStoreForTests } from "@/lib/history/history-store"
import type { PatchOptions, PatchOutcome } from "@/hooks/useProjectSettings"
import type { ProjectWideSettings } from "@/lib/sync/project-settings"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { ProjectFact } from "../../../db/shared/project-facts"
import { CheckDataCards } from "./CheckDataCards"

const PROJECT_ID = "proj-check-data"
const fact: ProjectFact = {
  id: "f-we",
  key: "clusivity.ACT.16.10-17",
  value: "exclusive",
  scope: { passage: { from: "ACT 16:10", to: "ACT 16:17" } },
  author: "ben",
  at: "2026-10-03T10:00:00.000Z",
}
const project = {
  id: PROJECT_ID,
  name: "Acts",
  files: [],
  targetLanguage: "French",
  syncRole: { level: 600, source: "member" },
} as unknown as ProjectRecord

beforeEach(async () => {
  resetHistoryForTests()
  await clearHistoryStoreForTests()
  // The workspace behind Living Memory holds the project's history scope.
  setHistoryScope(PROJECT_ID, "tester")
})
afterEach(() => setHistoryScope(null, null))

function renderCards() {
  const patch = vi.fn(async (_partial: ProjectWideSettings, _opts?: PatchOptions): Promise<PatchOutcome> => ({ kind: "ok" }))
  renderWithTooltips(
    <CheckDataCards
      project={project}
      settings={{ projectFacts: [fact] }}
      canEdit
      sessionUsername="tester"
      sessionJwt="tok"
      patch={patch}
    />,
  )
  return patch
}

describe("CheckDataCards — the Checks pane's data cards save like settings", () => {
  it("removing a decision is guarded, says Saved, and is one Undo step", async () => {
    const patch = renderCards()
    fireEvent.click(screen.getByRole("button", { name: "Remove clusivity.ACT.16.10-17" }))
    const row = screen.getByTestId("project-decision")
    fireEvent.click(within(row).getAllByRole("button", { name: "Remove" }).at(-1)!)
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith(
      { projectFacts: [] },
      expect.objectContaining({ expect: [{ key: "projectFacts", value: [fact] }] }),
    )
    expect(await screen.findByTestId("save-status-projectFacts")).toHaveTextContent("Saved")
    await waitFor(() => expect(historyView().nextUndo?.labelParams).toMatchObject({ setting: "Project decisions" }))
  })

  it("saving the quotation marks says Saved beside the Language profile, as one Undo step", async () => {
    const patch = renderCards()
    fireEvent.click(screen.getByRole("button", { name: /Use defaults for/ }))
    fireEvent.click(screen.getByRole("button", { name: "Save quotation marks" }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(Object.keys(vi.mocked(patch).mock.calls[0][0])).toEqual(["languageProfile"])
    expect(await screen.findByTestId("save-status-languageProfile")).toHaveTextContent("Saved")
    await waitFor(() => expect(historyView().nextUndo?.labelParams).toMatchObject({ setting: "Language profile for checks" }))
  })
})
