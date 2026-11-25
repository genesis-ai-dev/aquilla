/**
 * AQU-2476: Download original stays in the file menu below the export floor
 * and does nothing on click. The reason is the shared denial line, behind
 * the row's (i), shut until asked.
 *
 * The bug's shape is a Contributor in an org that never set the floor:
 * the server reads that as Maintainer, and the row has to say so.
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, it, expect, vi } from "vitest"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { denialMessage, type DenialT } from "@/lib/permissions/denial"
import { translate } from "@/lib/i18n/translate"
import { ROLE, resolveExportFloor } from "@/lib/sync/role-policy"
import { FileActionMenu } from "./FileActionMenu"

const t: DenialT = (key, vars) => translate(undefined, key, vars)

function renderMenu(overrides: Partial<Parameters<typeof FileActionMenu>[0]> = {}) {
  return render(
    <I18nProvider>
      <ContextMenu open>
        <ContextMenuTrigger>trigger</ContextMenuTrigger>
        <ContextMenuContent>
          <FileActionMenu
            onRename={vi.fn()}
            onMove={vi.fn()}
            {...overrides}
          />
        </ContextMenuContent>
      </ContextMenu>
    </I18nProvider>,
  )
}

describe("FileActionMenu — download original export floor (AQU-2476)", () => {
  const contributorUnset = denialMessage(t, resolveExportFloor(null), ROLE.CONTRIBUTOR)

  it("disables Download original below an unset floor and sends nothing", async () => {
    const onDownloadOriginal = vi.fn()
    const user = userEvent.setup()
    renderMenu({
      onExport: vi.fn(),
      onDownloadOriginal,
      downloadOriginalDisabledReason: contributorUnset,
    })

    const item = screen.getByRole("menuitem", { name: "Download original" })
    expect(item).toHaveAttribute("aria-disabled", "true")
    expect(contributorUnset).toContain("at least Maintainer access")
    // Shut until asked, and already the row's accessible description.
    const info = screen.getByRole("button", { name: "About Download original" })
    const text = document.getElementById(info.getAttribute("aria-controls")!)!
    expect(text).toHaveAttribute("data-open", "false")
    expect(item).toHaveAccessibleDescription(contributorUnset)
    await user.hover(item)
    expect(screen.queryByRole("tooltip")).toBeNull()

    await user.click(info)
    expect(text).toHaveAttribute("data-open", "true")
    expect(text).toHaveTextContent(contributorUnset)
    expect(onDownloadOriginal).not.toHaveBeenCalled()
    await user.click(info)
    expect(text).toHaveAttribute("data-open", "false")

    fireEvent.click(item)
    expect(onDownloadOriginal).not.toHaveBeenCalled()

    // Export stays available: its client-side formats work below the floor.
    const exportItem = screen.getByRole("menuitem", { name: "Export" })
    expect(exportItem).not.toHaveAttribute("aria-disabled", "true")
  })

  it("names the role the actual floor requires", async () => {
    const raised = denialMessage(t, resolveExportFloor(ROLE.OWNER), ROLE.MAINTAINER)
    const user = userEvent.setup()
    renderMenu({ downloadOriginalDisabledReason: raised })
    const info = screen.getByRole("button", { name: "About Download original" })
    await user.click(info)
    expect(document.getElementById(info.getAttribute("aria-controls")!)).toHaveTextContent("at least Owner access")
  })

  it("downloads when the caller is at or above the floor", () => {
    const onDownloadOriginal = vi.fn()
    renderMenu({ onDownloadOriginal })
    fireEvent.click(screen.getByRole("menuitem", { name: "Download original" }))
    expect(onDownloadOriginal).toHaveBeenCalledOnce()
    expect(screen.queryByRole("button", { name: "About Download original" })).toBeNull()
  })

  it("stays absent when the file has no original", () => {
    renderMenu({ onExport: vi.fn() })
    expect(screen.queryByRole("menuitem", { name: "Download original" })).toBeNull()
  })
})
