import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"

/**
 * AQU-1022 — the non-production warning beside the build string. The backend is
 * resolved once at module load from build-time vars, so each case stubs the env
 * and re-imports the module.
 */
async function renderVersionTag(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  const { VersionTag } = await import("./VersionBadge")
  return render(
    <I18nProvider>
      <VersionTag />
    </I18nProvider>,
  )
}

const PRODUCTION = {
  VITE_AUTH_BASE: "https://api.aquilla.app/identity",
  VITE_SYNC_WORKER_HOST: "api.aquilla.app/sync",
}

describe("VersionTag environment warning", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("stays silent on production", async () => {
    await renderVersionTag(PRODUCTION)
    expect(screen.queryByText("Dev data")).toBeNull()
    expect(screen.queryByText("Local data")).toBeNull()
    expect(screen.queryByText("Unknown backend")).toBeNull()
  })

  it("warns, and names the host, when pointed at the dev backend", async () => {
    await renderVersionTag({
      VITE_AUTH_BASE: "https://api.dev.aquilla.app/identity",
      VITE_SYNC_WORKER_HOST: "api.dev.aquilla.app/sync",
    })

    const tag = screen.getByText("Dev data")
    expect(tag).toBeTruthy()
    // The accessible name spells it out for screen readers and hover alike.
    expect(screen.getByLabelText(/api\.dev\.aquilla\.app/)).toBeTruthy()
  })

  it("warns when only one half of the build points away from production", async () => {
    await renderVersionTag({
      ...PRODUCTION,
      VITE_SYNC_WORKER_HOST: "api.dev.aquilla.app/sync",
    })

    expect(screen.getByText("Dev data")).toBeTruthy()
  })

  it("warns on an unrecognized backend rather than assuming production", async () => {
    await renderVersionTag({
      VITE_AUTH_BASE: "https://api.somewhere-else.test/identity",
      VITE_SYNC_WORKER_HOST: "api.somewhere-else.test/sync",
    })

    expect(screen.getByText("Unknown backend")).toBeTruthy()
  })
})
