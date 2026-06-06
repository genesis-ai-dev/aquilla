import { renderHook, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// We mock probeMicPermission so the hook doesn't touch the browser Permissions API in jsdom.
vi.mock("@/components/AudioRecorder/probeMicPermission", () => ({
  probeMicPermission: vi.fn(),
}))

import { useMicPermission } from "./useMicPermission"
import { probeMicPermission } from "@/components/AudioRecorder/probeMicPermission"

const mockProbe = probeMicPermission as ReturnType<typeof vi.fn>

describe("useMicPermission", () => {
  beforeEach(() => {
    mockProbe.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns micDenied=false initially and stays false when permission is granted", async () => {
    mockProbe.mockResolvedValue("granted")
    const { result } = renderHook(() => useMicPermission())
    expect(result.current.micDenied).toBe(false)
    await waitFor(() => expect(mockProbe).toHaveBeenCalledTimes(1))
    expect(result.current.micDenied).toBe(false)
  })

  it("sets micDenied=true when permission is denied", async () => {
    mockProbe.mockResolvedValue("denied")
    const { result } = renderHook(() => useMicPermission())
    await waitFor(() => expect(result.current.micDenied).toBe(true))
  })

  it("keeps micDenied=false when permission state is prompt", async () => {
    mockProbe.mockResolvedValue("prompt")
    const { result } = renderHook(() => useMicPermission())
    await waitFor(() => expect(mockProbe).toHaveBeenCalledTimes(1))
    expect(result.current.micDenied).toBe(false)
  })

  it("does NOT probe when enabled=false", async () => {
    mockProbe.mockResolvedValue("denied")
    const { result } = renderHook(() => useMicPermission(false))
    // Give effect a tick to (not) run
    await new Promise((r) => setTimeout(r, 10))
    expect(mockProbe).not.toHaveBeenCalled()
    expect(result.current.micDenied).toBe(false)
  })
})
