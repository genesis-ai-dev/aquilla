// AQU-1544 — the Source link card tells a never-synced link apart from a
// healthy one.
//
// Why these tests exist: a live link is saved first and filled by a first
// mirror sync. When that sync failed, this card rendered exactly as it does for
// a link that worked — "Live", "cursor: 0" — so once the person who linked the
// project had dismissed the failure message, and for any teammate who opened
// settings later, nothing distinguished "linked and empty because the sync
// failed" from "linked and fine". The card now reads the link's cursor: 0 on a
// live link means nothing has ever come through, and that state carries its own
// "Sync now".

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import {
  isLinkSeedFailed,
  markLinkSeedFailed,
  resetLinkSeedStatusForTests,
} from "@/lib/sync/link-seed-status"
import { SourceLinkSection, type SourceLinkSectionProps } from "./SourceLinkSection"

const runLinkSync = vi.fn()

vi.mock("@/lib/sync/archive", () => ({
  runLinkSync: (...args: unknown[]) => runLinkSync(...args),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "lead" }, loading: false }),
}))

// The Door43 panel self-gates on a cursor this project does not have; it is not
// what these tests are about.
vi.mock("@/components/dcs/DcsUpstreamPanel", () => ({ DcsUpstreamPanel: () => null }))

const PROJECT_ID = "proj-downstream"

function renderSection(props: Partial<SourceLinkSectionProps> = {}) {
  const onSynced = vi.fn()
  render(
    <I18nProvider>
      <SourceLinkSection
        projectId={PROJECT_ID}
        sourceProjectId="proj-upstream"
        sourceLinkMode="live"
        sourceLinkConsumes="source"
        sourceLinkGate="validated"
        sourceLinkCursor={0}
        onDetached={vi.fn()}
        onSynced={onSynced}
        roleLevel={700}
        {...props}
      />
    </I18nProvider>,
  )
  return { onSynced }
}

const syncNowButton = () => screen.getByRole("button", { name: "Sync now" })

beforeEach(() => {
  runLinkSync.mockReset()
  resetLinkSeedStatusForTests()
})

describe("SourceLinkSection — a link that has never synced (AQU-1544)", () => {
  // WHY: the state that used to be invisible. Cursor 0 on a live link means
  // the upstream's files are not here, and the card must say so and offer the
  // sync rather than showing "cursor: 0" beside a "Live" badge.
  it("shows 'Not synced yet' with a Sync now action instead of looking healthy", () => {
    renderSection({ sourceLinkCursor: 0 })

    expect(screen.getByText("Not synced yet")).toBeTruthy()
    expect(
      screen.getByText(/Nothing has come through this link yet/),
    ).toBeTruthy()
    expect(syncNowButton()).toBeTruthy()
    expect(screen.queryByText("cursor: 0")).toBeNull()
  })

  // WHY: a project record from before the cursor was sent carries no cursor at
  // all. On a live link that is the same "nothing has come through" answer.
  it("treats a missing cursor on a live link as never synced", () => {
    renderSection({ sourceLinkCursor: null })
    expect(screen.getByText("Not synced yet")).toBeTruthy()
  })

  // WHY: the regression guard. A link that has synced must look exactly as it
  // did — cursor badge, no warning, no extra button.
  it("leaves a link that has synced exactly as it was", () => {
    renderSection({ sourceLinkCursor: 5543 })

    expect(screen.getByText("cursor: 5543")).toBeTruthy()
    expect(screen.queryByText("Not synced yet")).toBeNull()
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull()
  })

  // WHY: neither of these is mirrored by the sync engine — a clone is a
  // one-time snapshot and a legacy link has no recorded mode — so "Sync now"
  // would promise something it cannot do.
  it("offers no sync on a clone", () => {
    renderSection({ sourceLinkMode: "clone", sourceLinkCursor: 0 })
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull()
    expect(screen.queryByText("Not synced yet")).toBeNull()
  })

  it("offers no sync on a legacy link with no recorded mode", () => {
    renderSection({ sourceLinkMode: null, sourceLinkCursor: 0 })
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull()
    expect(screen.queryByText("Not synced yet")).toBeNull()
  })

  // WHY: the retry for someone who dismissed the original message, or was
  // never shown it. A sync that works tells the parent to refresh — that is
  // what brings the advanced cursor (and the files) in without a reload — and
  // clears the session's failed mark so the workspace banner goes too.
  it("runs the sync and tells the parent to refresh when Sync now works", async () => {
    const user = userEvent.setup()
    runLinkSync.mockResolvedValue({ ok: true, ranSync: true })
    markLinkSeedFailed(PROJECT_ID)
    const { onSynced } = renderSection()

    await user.click(syncNowButton())

    await waitFor(() => expect(onSynced).toHaveBeenCalledTimes(1))
    expect(runLinkSync).toHaveBeenCalledWith("tok", PROJECT_ID)
    expect(isLinkSeedFailed(PROJECT_ID)).toBe(false)
    // Content DID come through, so in the moment before the refreshed record
    // lands the card must not claim the upstream is empty.
    expect(screen.queryByText(/The source project has nothing to bring in yet/)).toBeNull()
  })

  // WHY: a failed sync must not look like a button that did nothing, must not
  // show a status code, and must leave the action available. The link itself
  // is untouched either way — nothing here unlinks.
  it("says the sync failed, in plain words, and keeps Sync now available", async () => {
    const user = userEvent.setup()
    runLinkSync.mockResolvedValue({ ok: false })
    const { onSynced } = renderSection()

    await user.click(syncNowButton())

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Couldn't bring in the source project's files.")
    expect(alert.textContent).not.toMatch(/\b[45]\d\d\b/)
    expect(syncNowButton().hasAttribute("disabled")).toBe(false)
    expect(screen.getByText("Not synced yet")).toBeTruthy()
    expect(onSynced).not.toHaveBeenCalled()
  })

  // WHY: cursor 0 is also the honest state of a healthy link to a project
  // that has nothing in it yet. A sync that worked and had nothing to bring
  // must not go on implying something is wrong.
  it("says there is nothing to bring in when the sync worked on an empty upstream", async () => {
    const user = userEvent.setup()
    runLinkSync.mockResolvedValue({ ok: true, ranSync: false })
    renderSection()

    await user.click(syncNowButton())

    expect(
      await screen.findByText(/The source project has nothing to bring in yet/),
    ).toBeTruthy()
    expect(screen.queryByText(/Nothing has come through this link yet/)).toBeNull()
  })
})
