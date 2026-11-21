import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { SOURCE_AUDIO_ACCESS_RETRY_MS, useSourceAudioAccess } from "./useSourceAudioAccess"

// AQU-2682: the app offers "Upload a recording to make lines" and attaching
// media only once the server has said this person's access covers every
// language. Until then (slow network, offline, a failed read) the answer is
// null, and null offers nothing.

const fetchMock = vi.fn()
const getToken = vi.fn(async (_fileId: string) => "tok" as string | null)
const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))

beforeEach(() => {
  fetchMock.mockReset()
  getToken.mockClear()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const render = (enabled = true, projectId = "p1") =>
  renderHook((props: { enabled: boolean; projectId: string }) =>
    useSourceAudioAccess({ projectId: props.projectId, fileId: "f1", getToken, enabled: props.enabled }),
  { initialProps: { enabled, projectId } })

describe("useSourceAudioAccess", () => {
  it("is null until the server answers, then the server's answer", async () => {
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: false }))
    const { result } = render()
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toBe(false))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/v1\/projects\/p1\/source-audio-access$/)
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" })
  })

  it("answers true for someone with every language", async () => {
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    const { result } = render()
    await waitFor(() => expect(result.current).toBe(true))
  })

  it("stays null on a failed read and asks again later", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockReturnValueOnce(Promise.reject(new TypeError("Failed to fetch")))
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    const { result } = render()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })
    expect(result.current).toBeNull()
    await act(async () => { vi.advanceTimersByTime(SOURCE_AUDIO_ACCESS_RETRY_MS[0]!) })
    await waitFor(() => expect(result.current).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("treats a server error or an odd body as no answer, never as a yes", async () => {
    fetchMock.mockReturnValueOnce(reply("nope", 500))
    const first = render()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await act(async () => { await Promise.resolve() })
    expect(first.result.current).toBeNull()
    first.unmount()

    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: "yes" }))
    const second = render()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(second.result.current).toBeNull()
  })

  it("asks again when the network comes back", async () => {
    fetchMock.mockReturnValueOnce(Promise.reject(new TypeError("offline")))
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    const { result } = render()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await act(async () => { window.dispatchEvent(new Event("online")) })
    await waitFor(() => expect(result.current).toBe(true))
  })

  it("does not ask while disabled, and drops another project's answer", async () => {
    const { result, rerender } = render(false)
    expect(result.current).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    rerender({ enabled: true, projectId: "p1" })
    await waitFor(() => expect(result.current).toBe(true))

    fetchMock.mockReturnValueOnce(new Promise(() => {}))
    rerender({ enabled: true, projectId: "p2" })
    expect(result.current).toBeNull()
  })
})
