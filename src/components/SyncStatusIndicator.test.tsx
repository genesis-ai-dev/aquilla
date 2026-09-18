/**
 * AQU-1155: the pill's label/tooltip must distinguish "all saved" from
 * "still sending", "send failed, retrying", and "live connection down" —
 * before this every online state read "Live".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { observedSyncFetch, readSyncJson, recordSyncBytes } from "@/lib/sync/connection-activity"
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
  let now = 0
  beforeEach(() => {
    now += 600_000
    vi.spyOn(performance, "now").mockReturnValue(now)
  })
  afterEach(() => vi.restoreAllMocks())

  it("opens from the keyboard, shows observed traffic and closes with Escape", async () => {
    const user = userEvent.setup()
    recordSyncBytes("upload", "x".repeat(5_000))
    renderPill("live")
    const trigger = screen.getByRole("button", { name: /all changes are saved/i })
    trigger.focus()
    await user.keyboard("{Enter}")
    const dialog = await screen.findByRole("dialog", { name: "Connection" })
    expect(within(dialog).getAllByText("Upload")).toHaveLength(2)
    expect(within(dialog).getAllByText("Download")).toHaveLength(2)
    expect(within(dialog).getAllByText("Server reply")).toHaveLength(2)
    expect(within(dialog).getByText("1 kB/s", { selector: "dd" })).toBeTruthy()
    expect(within(dialog).getByText("5 kB total")).toBeTruthy()
    expect(within(dialog).getAllByText("Waiting for activity")).toHaveLength(2)
    expect(within(dialog).getByRole("img", { name: "Upload and download activity over the past five minutes" })).toBeTruthy()
    expect(within(dialog).getByRole("img", { name: "Observed server replies over the past five minutes" })).toBeTruthy()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it("does not present stored readings as current while offline", async () => {
    const user = userEvent.setup()
    recordSyncBytes("upload", "x".repeat(5_000))
    renderPill("offline")
    await user.click(screen.getByRole("button", { name: /saved locally/i }))
    const dialog = await screen.findByRole("dialog", { name: "Connection" })
    expect(within(dialog).getAllByText("—", { selector: "dd" })).toHaveLength(4)
    expect(within(dialog).getByText("5 kB total")).toBeTruthy()
    expect(within(dialog).queryByText("1 kB/s", { selector: "dd" })).toBeNull()
  })

  it("keeps useful history and freshness after the immediate sample expires, without probes", async () => {
    const user = userEvent.setup()
    const response = await observedSyncFetch("/events", { method: "POST", body: "saved" }, vi.fn(async () => {
      vi.mocked(performance.now).mockReturnValue(now + 100)
      return new Response('{"ok":true}')
    }))
    await readSyncJson(response)
    vi.mocked(performance.now).mockReturnValue(now + 35_100)
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    renderPill("live")
    await user.click(screen.getByRole("button", { name: /all changes are saved/i }))
    const dialog = await screen.findByRole("dialog", { name: "Connection" })
    expect(within(dialog).getAllByText("Idle")).toHaveLength(2)
    expect(within(dialog).getByText("100 ms avg")).toBeTruthy()
    expect(within(dialog).getByText("Slowest reply: 100 ms")).toBeTruthy()
    expect(within(dialog).getByText("Last reply 35s ago")).toBeTruthy()
    expect(within(dialog).getByText("5 B total")).toBeTruthy()
    expect(within(dialog).getByText("11 B total")).toBeTruthy()
    expect(fetchSpy).not.toHaveBeenCalled()
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
