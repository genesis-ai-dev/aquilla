import { renderHook, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { useMicPermission } from "./useMicPermission"

// The browser's two microphone APIs, stubbed: the Permissions API answers
// `state`, and getUserMedia is the call that puts up the pop-up.
const state = { value: "prompt" as PermissionState }
const query = vi.fn(async () => ({ state: state.value }) as PermissionStatus)
const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream)

beforeEach(() => {
  query.mockClear()
  getUserMedia.mockClear()
  vi.stubGlobal("navigator", {
    ...navigator,
    permissions: { query },
    mediaDevices: { getUserMedia },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("useMicPermission", () => {
  it("returns micDenied=false initially and stays false when permission is granted", async () => {
    state.value = "granted"
    const { result } = renderHook(() => useMicPermission())
    expect(result.current.micDenied).toBe(false)
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    expect(result.current.micDenied).toBe(false)
  })

  it("sets micDenied=true when permission is denied", async () => {
    state.value = "denied"
    const { result } = renderHook(() => useMicPermission())
    await waitFor(() => expect(result.current.micDenied).toBe(true))
  })

  // AQU-1758 (Sam): the microphone pop-up only when the recording window opens.
  it("never asks for the microphone when the state is prompt — no pop-up", async () => {
    state.value = "prompt"
    const { result } = renderHook(() => useMicPermission())
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(result.current.micDenied).toBe(false)
  })

  it("never asks either where the Permissions API cannot say", async () => {
    query.mockRejectedValueOnce(new TypeError("microphone is not a known permission"))
    const { result } = renderHook(() => useMicPermission())
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(result.current.micDenied).toBe(false)
  })

  it("does NOT read anything when enabled=false", async () => {
    state.value = "denied"
    const { result } = renderHook(() => useMicPermission(false))
    await new Promise((r) => setTimeout(r, 10))
    expect(query).not.toHaveBeenCalled()
    expect(result.current.micDenied).toBe(false)
  })
})
