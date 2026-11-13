import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"

/**
 * The footer's "v…" is the one version number a user is asked for. On desktop
 * it must be the installed shell's (what the About window and the download
 * say), not the number baked into whichever web bundle the shell is serving —
 * the two drift as soon as a hot bundle or a shell update lands on its own.
 */
const getDesktopVersions = vi.fn()
vi.mock("@/lib/offline/bundle-update", () => ({ getDesktopVersions }))

declare const __APP_VERSION__: string

async function renderVersionTag() {
  const { VersionTag } = await import("./VersionBadge")
  return render(
    <I18nProvider>
      <VersionTag />
    </I18nProvider>,
  )
}

describe("VersionTag version source", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("shows the installed shell's version inside the desktop app", async () => {
    getDesktopVersions.mockResolvedValue({ shell: "9.8.7", bundle: "2026.11.03.01" })
    await renderVersionTag()
    expect(await screen.findByText(/^v9\.8\.7 · /)).toBeTruthy()
    expect(screen.queryByText(new RegExp(`^v${__APP_VERSION__.replaceAll(".", "\\.")} · `))).toBeNull()
  })

  it("shows the baked version on the web", async () => {
    getDesktopVersions.mockResolvedValue(null)
    await renderVersionTag()
    expect(await screen.findByText(new RegExp(`^v${__APP_VERSION__.replaceAll(".", "\\.")} · `))).toBeTruthy()
  })
})
