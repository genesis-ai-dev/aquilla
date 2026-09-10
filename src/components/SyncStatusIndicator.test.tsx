/**
 * AQU-1155: the pill's label/tooltip must distinguish "all saved" from
 * "still sending", "send failed, retrying", and "live connection down" —
 * before this every online state read "Live".
 */
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
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
