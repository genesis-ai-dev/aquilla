// The org switch that lets bulk text validation take untouched AI drafts (Sam,
// 2026-10-01). What it must show is the server's answer — off when unset — and
// a flip must write exactly this key, or the one-at-a-time rule silently
// changes for every project in the org.

import { describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BulkValidateAiDraftsSection } from "./BulkValidateAiDraftsSection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

function orgSettings(over: Partial<UseOrgSettings> = {}): UseOrgSettings {
  return {
    allowBulkValidateAiDrafts: false,
    patch: vi.fn(async () => ({ kind: "ok" as const, value: {} as never })),
    ...over,
  } as UseOrgSettings
}

const toggle = () => screen.getByRole("switch", { name: "Allow bulk validation of AI drafts" })

describe("BulkValidateAiDraftsSection", () => {
  it("is off when the org has not opted in", () => {
    render(<BulkValidateAiDraftsSection orgSettings={orgSettings()} canEdit />)
    expect(toggle()).not.toBeChecked()
    expect(screen.getByText(/each untouched AI draft has to be opened and validated on its own/)).toBeInTheDocument()
  })

  it("shows the org's answer when it has", () => {
    render(<BulkValidateAiDraftsSection orgSettings={orgSettings({ allowBulkValidateAiDrafts: true })} canEdit />)
    expect(toggle()).toBeChecked()
  })

  it("writes only its own key when a maintainer turns it on", async () => {
    const settings = orgSettings()
    render(<BulkValidateAiDraftsSection orgSettings={settings} canEdit />)
    await userEvent.click(toggle())
    expect(settings.patch).toHaveBeenCalledWith({ allowBulkValidateAiDrafts: true })
  })

  it("cannot be flipped below the maintainer gate", async () => {
    const settings = orgSettings()
    render(<BulkValidateAiDraftsSection orgSettings={settings} canEdit={false} />)
    // Base UI's switch is a span: it marks itself rather than taking `disabled`.
    expect(toggle()).toHaveAttribute("data-disabled")
    await userEvent.click(toggle())
    expect(settings.patch).not.toHaveBeenCalled()
  })

  it("says so when the save is refused", async () => {
    const settings = orgSettings({ patch: vi.fn(async () => ({ kind: "blocked" as const })) })
    render(<BulkValidateAiDraftsSection orgSettings={settings} canEdit />)
    await userEvent.click(toggle())
    await waitFor(() =>
      expect(screen.getByText("Only org maintainers and owners can change this setting.")).toBeInTheDocument(),
    )
  })
})
