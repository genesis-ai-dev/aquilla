import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { makeInMemoryAdapter } from "@livestore/adapter-web"
import { OfflineStoreProvider, useOfflineStore } from "./OfflineStoreContext"
import { __resetOfflineStoreForTests, getOfflineStore } from "@/lib/offline/store"

const withTauriGlobal = () => {
  ;(window as unknown as { __TAURI__?: object }).__TAURI__ = {}
}

const withoutTauriGlobal = () => {
  delete (window as unknown as { __TAURI__?: object }).__TAURI__
}

function Probe() {
  const { store, loading, error } = useOfflineStore()
  return (
    <span>{JSON.stringify({ hasStore: store !== null, loading, error: error?.message ?? null })}</span>
  )
}

beforeEach(() => {
  __resetOfflineStoreForTests()
})

afterEach(() => {
  withoutTauriGlobal()
})

describe("OfflineStoreProvider", () => {
  it("stays a no-op outside the Tauri runtime", () => {
    withoutTauriGlobal()
    render(
      <OfflineStoreProvider>
        <Probe />
      </OfflineStoreProvider>,
    )
    expect(screen.getByText(JSON.stringify({ hasStore: false, loading: false, error: null }))).toBeInTheDocument()
  })

  it("boots the offline store and exposes it once ready inside Tauri", async () => {
    withTauriGlobal()
    // Pre-warm the memoized store with an in-memory adapter (the real adapter needs
    // OPFS/SharedWorker, unavailable in happy-dom) so the provider's effect resolves it.
    await getOfflineStore(() => makeInMemoryAdapter())

    render(
      <OfflineStoreProvider>
        <Probe />
      </OfflineStoreProvider>,
    )

    await waitFor(() =>
      expect(
        screen.getByText(JSON.stringify({ hasStore: true, loading: false, error: null })),
      ).toBeInTheDocument(),
    )
  })

  it("surfaces a boot error instead of throwing", async () => {
    withTauriGlobal()
    // No pre-warm here: the provider calls getOfflineStore() with the real
    // default adapter, which needs OPFS/SharedWorker/Vite worker-suffix
    // imports that happy-dom can't provide — it rejects, and that rejection
    // should land in `error`, not as an unhandled promise / thrown render.
    render(
      <OfflineStoreProvider>
        <Probe />
      </OfflineStoreProvider>,
    )

    await waitFor(() => {
      const text = screen.getByText(/hasStore/).textContent ?? ""
      const parsed = JSON.parse(text) as { hasStore: boolean; loading: boolean; error: string | null }
      expect(parsed.loading).toBe(false)
      expect(parsed.hasStore).toBe(false)
      expect(parsed.error).not.toBeNull()
    })
  })
})
