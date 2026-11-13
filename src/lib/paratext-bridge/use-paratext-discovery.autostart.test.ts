/**
 * The "This computer" workspace promises not to read any Paratext folder
 * until the user has seen the permission-prep step and asked for the scan.
 * That promise is only as good as the hook: with `autoStart: false` the
 * discover command must not run on mount, and must run on `refresh()`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

const discover = vi.fn()
vi.mock("@/lib/offline/is-tauri", () => ({ isTauriRuntime: () => true }))
vi.mock("./tauri", () => ({ paratextTauri: { discover: () => discover() } }))

import { useParatextDiscovery } from "./use-paratext-discovery"

const EMPTY = { roots: [], projects: [], registeredUser: null, paratextRunning: false }

beforeEach(() => {
  discover.mockReset()
  discover.mockResolvedValue(EMPTY)
})

describe("useParatextDiscovery autoStart", () => {
  it("scans on mount by default", async () => {
    const { result } = renderHook(() => useParatextDiscovery())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.discovery).toEqual(EMPTY))
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it("with autoStart false reads nothing until refresh() is called", async () => {
    const { result } = renderHook(() => useParatextDiscovery({ autoStart: false }))
    expect(result.current.loading).toBe(false)
    expect(discover).not.toHaveBeenCalled()

    await act(async () => { await result.current.refresh() })
    expect(discover).toHaveBeenCalledTimes(1)
    expect(result.current.discovery).toEqual(EMPTY)
  })
})
