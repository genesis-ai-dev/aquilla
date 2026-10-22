import { render, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  tauri: true,
  online: false as boolean | null,
  ready: true,
  listeners: new Set<(online: boolean | null) => void>(),
}))

vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => h.tauri }))
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ active: { username: "anna" } }) }))
vi.mock("@/lib/offline/connectivity", () => ({
  desktopConnectivity: {
    current: () => h.online,
    subscribe: (listener: (online: boolean | null) => void) => {
      h.listeners.add(listener)
      return () => h.listeners.delete(listener)
    },
  },
}))
vi.mock("@/lib/offline/store", () => ({ getOfflineStore: async () => ({}) }))
vi.mock("@/lib/offline/offline-reads", () => ({ isProjectOfflineReady: () => h.ready }))

const LAST = "/project/p1/editor/file/f1"

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>
}

async function launchAt(path: string) {
  vi.resetModules()
  const { OfflineLaunchResume } = await import("./OfflineLaunchResume")
  window.history.replaceState({}, "", path)
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OfflineLaunchResume />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  h.tauri = true
  h.online = false
  h.ready = true
  h.listeners.clear()
  localStorage.clear()
  localStorage.setItem("aquilla.offline.lastWorkspace.anna", JSON.stringify({ projectId: "p1", path: LAST }))
})

describe("OfflineLaunchResume", () => {
  it("reopens the last project on an offline launch", async () => {
    const { getByTestId } = await launchAt("/orgs/all")
    await waitFor(() => expect(getByTestId("where").textContent).toBe(LAST))
  })

  it("waits for the first connectivity reading", async () => {
    h.online = null
    const { getByTestId } = await launchAt("/orgs/all")
    await waitFor(() => expect(h.listeners.size).toBe(1))
    for (const listener of h.listeners) listener(false)
    await waitFor(() => expect(getByTestId("where").textContent).toBe(LAST))
  })

  it.each([
    ["online", () => { h.online = true }],
    ["the download isn't ready", () => { h.ready = false }],
    ["not the desktop app", () => { h.tauri = false }],
  ])("stays put when %s", async (_label, arrange) => {
    arrange()
    const { getByTestId } = await launchAt("/orgs/all")
    await new Promise((r) => setTimeout(r, 20))
    expect(getByTestId("where").textContent).toBe("/orgs/all")
  })

  it("leaves a launch that didn't land on the org page alone", async () => {
    const { getByTestId } = await launchAt("/project/p2/editor")
    await new Promise((r) => setTimeout(r, 20))
    expect(getByTestId("where").textContent).toBe("/project/p2/editor")
  })
})
