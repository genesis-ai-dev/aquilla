// AQU-2549 (evidence pass 4h): restoring a copy that was joined into the
// project's own file brought back a second file that no longer followed the
// source. The server now refuses it; the row says why instead of offering a
// Restore that does nothing.

import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { RecentlyDeletedRow } from "./RecentlyDeletedRow"

function renderRow(file: Parameters<typeof RecentlyDeletedRow>[0]["file"]) {
  const onRestore = vi.fn()
  const onPurge = vi.fn()
  render(
    <I18nProvider>
      <RecentlyDeletedRow file={file} onRestore={onRestore} onPurge={onPurge} />
    </I18nProvider>,
  )
  return { onRestore, onPurge }
}

describe("RecentlyDeletedRow", () => {
  it("a joined copy shows the file it was joined into, and no Restore", async () => {
    const { onPurge } = renderRow({ fileId: "copy", name: "GEN.usfm", joinedInto: { fileId: "own", name: "Genesis.usfm" } })
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
    expect(screen.getByText("Joined into Genesis.usfm, so it can't be restored.")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Delete forever" }))
    expect(onPurge).toHaveBeenCalledOnce()
  })

  it("any other deleted file restores as before", async () => {
    const { onRestore } = renderRow({ fileId: "f", name: "Notes.usfm" })
    expect(screen.queryByText(/Joined into/)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Restore" }))
    expect(onRestore).toHaveBeenCalledOnce()
  })
})
