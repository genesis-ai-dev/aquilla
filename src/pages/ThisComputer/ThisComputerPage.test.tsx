/**
 * The workspace's first visit must explain what Aquilla is about to read
 * before it reads it (an OS file-access prompt should never be a surprise),
 * and must not show that step again once a scan has succeeded. Linked
 * folders list from Aquilla's own roots file before any scan.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ReactNode } from "react"
import { resetParatextScanPrefForTests, setParatextScanReady, getParatextScanReady } from "@/lib/store/paratext-scan-pref"

const discover = vi.fn()
const userRoots = vi.fn()
vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => true }))
vi.mock("@/lib/paratext-bridge/tauri", () => ({
  paratextTauri: {
    discover: () => discover(),
    userRoots: () => userRoots(),
    addRoot: vi.fn(),
    removeRoot: vi.fn(),
  },
}))
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ main, header }: { main: ReactNode; header: ReactNode }) => <div>{header}{main}</div>,
}))
vi.mock("@/components/this-computer/ThisComputerSidebar", () => ({ ThisComputerSidebar: () => null }))

import { ThisComputerPage } from "./ThisComputerPage"

const SETTINGS = `<ScriptureText><Guid>abc</Guid><Name>TPP1</Name><FullName>Test Project</FullName><Encoding>65001</Encoding><FileNamePrePart></FileNamePrePart><FileNamePostPart>TPP1.SFM</FileNamePostPart><FileNameBookNameForm>41MAT</FileNameBookNameForm></ScriptureText>`
const FOUND = {
  roots: [
    { path: "/Users/u/.wine-paratext/drive_c/My Paratext 9 Projects", source: "wine" },
    { path: "/Users/u/Linked", source: "user" },
  ],
  projects: [{ path: "/Users/u/.wine-paratext/drive_c/My Paratext 9 Projects/TPP1", folderName: "TPP1", settingsXml: SETTINGS, userAccessXml: null, bookFiles: ["41MATTPP1.SFM"] }],
  registeredUser: { name: "Ryder", email: "r@x" },
  paratextRunning: false,
}

beforeEach(() => {
  localStorage.clear()
  resetParatextScanPrefForTests()
  discover.mockReset()
  userRoots.mockReset()
  discover.mockResolvedValue(FOUND)
  userRoots.mockResolvedValue(["/Users/u/Linked"])
})

const renderPage = () => render(<MemoryRouter initialEntries={["/this-computer"]}><ThisComputerPage /></MemoryRouter>)

describe("ThisComputerPage", () => {
  it("lists linked folders without scanning, and scans only after the prep step is accepted", async () => {
    renderPage()
    expect(await screen.findByTestId("paratext-scan-prep")).toBeInTheDocument()
    // Linked folders come from the roots file; no Paratext folder was read.
    expect(await screen.findByText("/Users/u/Linked")).toBeInTheDocument()
    expect(discover).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /find paratext projects on this computer/i })) })
    await waitFor(() => expect(screen.getByTestId("paratext-scan-results")).toBeInTheDocument())
    expect(discover).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Test Project")).toBeInTheDocument()
    expect(screen.getByText("1 Paratext project found")).toBeInTheDocument()
    // A completed scan is remembered so the prep step is not shown twice.
    expect(getParatextScanReady()).toBe(true)
  })

  it("scans straight away when a scan has already succeeded on this device", async () => {
    setParatextScanReady(true)
    renderPage()
    await waitFor(() => expect(screen.getByTestId("paratext-scan-results")).toBeInTheDocument())
    expect(discover).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("paratext-scan-prep")).not.toBeInTheDocument()
  })

  it("keeps the prep step and shows the error when the first scan fails", async () => {
    discover.mockRejectedValue(new Error("EACCES: denied"))
    renderPage()
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /find paratext projects on this computer/i })) })
    await waitFor(() => expect(screen.getByText(/EACCES: denied/)).toBeInTheDocument())
    expect(screen.getByTestId("paratext-scan-prep")).toBeInTheDocument()
    expect(getParatextScanReady()).toBe(false)
  })
})
