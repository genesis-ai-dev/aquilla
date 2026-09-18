/**
 * AQU-1155: the pill's label/tooltip must distinguish "all saved" from
 * "still sending", "send failed, retrying", and "live connection down" —
 * before this every online state read "Live".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { recordSyncBytes } from "@/lib/sync/connection-activity"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SyncStatusIndicator, type SyncStatus } from "./SyncStatusIndicator"

function renderPill(status: SyncStatus) {
  return render(
    <I18nProvider>
      <TooltipProvider delay={0}>
        <SyncStatusIndicator status={status} />
      </TooltipProvider>
    </I18nProvider>,
  )
}

describe("SyncStatusIndicator", () => {
  // Keep the activity window fixed while real user-event interactions complete.
  beforeEach(() => vi.spyOn(performance, "now").mockReturnValue(1000))
  afterEach(() => vi.restoreAllMocks())

  it("opens from the keyboard, shows observed traffic and closes with Escape", async () => {
    const user = userEvent.setup()
    recordSyncBytes("upload", "x".repeat(5_000))
    renderPill("live")
    const trigger = screen.getByRole("button", { name: /all changes are saved/i })
    trigger.focus()
    await user.keyboard("{Enter}")
    const dialog = await screen.findByRole("dialog", { name: "Connection" })
    expect(within(dialog).getByText("Upload")).toBeTruthy()
    expect(within(dialog).getByText("Download")).toBeTruthy()
    expect(within(dialog).getByText("Response time")).toBeTruthy()
    expect(within(dialog).getByText("1 kB/s")).toBeTruthy()
    expect(within(dialog).getByText("Waiting for activity")).toBeTruthy()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it("does not present stored readings as current while offline", async () => {
    const user = userEvent.setup()
    renderPill("offline")
    await user.click(screen.getByRole("button", { name: /saved locally/i }))
    const dialog = await screen.findByRole("dialog", { name: "Connection" })
    expect(within(dialog).getAllByText("—")).toHaveLength(3)
    expect(within(dialog).queryByText("1 kB/s")).toBeNull()
  })

  it.each<[SyncStatus, string, RegExp]>([
    ["live", "Live", /all changes are saved to the server/i],
    ["syncing", "Syncing", /still being sent/i],
    ["retrying", "Retrying", /last attempt .* failed/i],
    ["reconnecting", "Reconnecting", /live connection dropped/i],
    ["offline", "Offline", /saved locally/i],
  ])("%s renders its own label and an honest tooltip", (status, label, tooltip) => {
    renderPill(status)
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByLabelText(tooltip)).toBeTruthy()
  })
})
