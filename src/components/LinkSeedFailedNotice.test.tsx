// AQU-1544 — the banner a project page shows when its source link was saved
// but the first mirror sync failed.
//
// Why these tests exist: the failure is learned in one place and has to be
// shown in another. The create dialog closes and navigates to the project it
// made; the Import dialog can be dismissed back to the workspace; the
// workspace's own zero-file self-heal fails with nobody watching. Each parks
// the failure in `link-seed-status`, and this banner is what the user then
// sees. Before this slice all three ended in an unexplained empty file list.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import {
  clearLinkSeedFailed,
  isLinkSeedFailed,
  markLinkSeedFailed,
  resetLinkSeedStatusForTests,
} from "@/lib/sync/link-seed-status"
import { LinkSeedFailedBanner } from "./LinkSeedFailedNotice"

const triggerLinkSync = vi.fn()

vi.mock("@/lib/sync/archive", () => ({
  triggerLinkSync: (...args: unknown[]) => triggerLinkSync(...args),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "lead" }, loading: false }),
}))

const PROJECT_ID = "proj-linked"
const SEED_FAILED =
  "The link to the source project was saved, but its files have not arrived here yet. " +
  "Try again to bring them in."

function renderBanner(projectId = PROJECT_ID) {
  const onSynced = vi.fn()
  render(
    <I18nProvider>
      <LinkSeedFailedBanner projectId={projectId} onSynced={onSynced} />
    </I18nProvider>,
  )
  return { onSynced }
}

beforeEach(() => {
  triggerLinkSync.mockReset()
  resetLinkSeedStatusForTests()
})

describe("LinkSeedFailedBanner (AQU-1544)", () => {
  // WHY: the regression guard. Every project page mounts this; a healthy
  // project, and a linked one whose sync worked, must show nothing.
  it("renders nothing for a project with no failed first sync", () => {
    renderBanner()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("is scoped to the project the failure belongs to", () => {
    markLinkSeedFailed("some-other-project")
    renderBanner()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  // WHY: the failure can be parked after the page is already on screen — the
  // workspace's self-heal resolves a moment after mount, and the Import dialog
  // fails while the workspace sits behind it.
  it("appears when the failure is parked after mount, with the retry", async () => {
    renderBanner()
    expect(screen.queryByRole("alert")).toBeNull()

    act(() => markLinkSeedFailed(PROJECT_ID))

    expect((await screen.findByRole("alert")).textContent).toContain(SEED_FAILED)
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
  })

  // WHY: "when it succeeds the files appear without a page reload and the
  // message goes away" — `onSynced` is the page's refresh.
  it("refreshes the page and goes away when trying again works", async () => {
    const user = userEvent.setup()
    markLinkSeedFailed(PROJECT_ID)
    triggerLinkSync.mockResolvedValue(true)
    const { onSynced } = renderBanner()

    await user.click(screen.getByRole("button", { name: "Try again" }))

    await waitFor(() => expect(onSynced).toHaveBeenCalledTimes(1))
    expect(triggerLinkSync).toHaveBeenCalledWith("tok", PROJECT_ID)
    expect(screen.queryByRole("alert")).toBeNull()
    expect(isLinkSeedFailed(PROJECT_ID)).toBe(false)
  })

  // WHY: a second failure changes nothing about the project — the link stays,
  // the message stays, the retry stays — but it must be acknowledged.
  it("stays, says so, and keeps the retry when trying again fails", async () => {
    const user = userEvent.setup()
    markLinkSeedFailed(PROJECT_ID)
    triggerLinkSync.mockResolvedValue(false)
    const { onSynced } = renderBanner()

    await user.click(screen.getByRole("button", { name: "Try again" }))

    await screen.findByText(/That attempt did not bring them in either/)
    expect(screen.getByText(SEED_FAILED)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Try again" }).hasAttribute("disabled")).toBe(false)
    expect(onSynced).not.toHaveBeenCalled()
    expect(isLinkSeedFailed(PROJECT_ID)).toBe(true)
  })

  // WHY: the sync can be fixed from somewhere else — "Sync now" in Project
  // Settings clears the same mark — and the banner must not outlive it.
  it("goes away when the failure is cleared elsewhere", async () => {
    markLinkSeedFailed(PROJECT_ID)
    renderBanner()
    await screen.findByRole("alert")

    act(() => clearLinkSeedFailed(PROJECT_ID))

    expect(screen.queryByRole("alert")).toBeNull()
  })
})
