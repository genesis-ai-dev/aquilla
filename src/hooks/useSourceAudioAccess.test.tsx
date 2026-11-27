import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { PROJECT_TOKEN_FILE_ID, SOURCE_AUDIO_ACCESS_RETRY_MS, SOURCE_AUDIO_ACCESS_TOKEN_CHECK_MS, useSourceAudioAccess } from "./useSourceAudioAccess"
import { mediaEmptyGates } from "@/lib/editor/linked-video-empty-state"

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
  getToken.mockReset()
  getToken.mockImplementation(async () => "tok")
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

  it("asks again when the sync token is re-minted, and takes the new answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    const { result } = render()
    await waitFor(() => expect(result.current).toBe(true))

    // Same token: the check costs no read.
    await act(async () => { vi.advanceTimersByTime(SOURCE_AUDIO_ACCESS_TOKEN_CHECK_MS) })
    await act(async () => { await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A new token (the lead lost Spanish meanwhile): the server now says no.
    getToken.mockImplementation(async () => "tok-2")
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: false }))
    await act(async () => { vi.advanceTimersByTime(SOURCE_AUDIO_ACCESS_TOKEN_CHECK_MS) })
    await waitFor(() => expect(result.current).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-2" })
  })

  it("keeps the previous answer while a re-ask fails, then retries", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    const { result } = render()
    await waitFor(() => expect(result.current).toBe(true))

    getToken.mockImplementation(async () => "tok-2")
    fetchMock.mockReturnValueOnce(Promise.reject(new TypeError("Failed to fetch")))
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: false }))
    await act(async () => { vi.advanceTimersByTime(SOURCE_AUDIO_ACCESS_TOKEN_CHECK_MS) })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await act(async () => { await Promise.resolve() })
    expect(result.current).toBe(true)
    await act(async () => { vi.advanceTimersByTime(SOURCE_AUDIO_ACCESS_RETRY_MS[0]!) })
    await waitFor(() => expect(result.current).toBe(false))
  })

  it("asks again at once with the new file's token when the open file changes", async () => {
    getToken.mockImplementation(async (fileId: string) => `tok-${fileId}`)
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: false }))
    const { result, rerender } = renderHook((props: { fileId: string }) =>
      useSourceAudioAccess({ projectId: "p1", fileId: props.fileId, getToken, enabled: true }),
    { initialProps: { fileId: "f1" } })
    await waitFor(() => expect(result.current).toBe(true))
    // A lead limited to f1: on f2 the server says no.
    rerender({ fileId: "f2" })
    expect(result.current).toBe(true)
    await waitFor(() => expect(result.current).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-f2" })
  })

  it("asks for the open file when it changed while a read was out", async () => {
    getToken.mockImplementation(async (fileId: string) => `tok-${fileId}`)
    let release!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { release = r }))
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: false }))
    const { result, rerender } = renderHook((props: { fileId: string }) =>
      useSourceAudioAccess({ projectId: "p1", fileId: props.fileId, getToken, enabled: true }),
    { initialProps: { fileId: "f1" } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    rerender({ fileId: "f2" })
    await act(async () => { release(new Response(JSON.stringify({ coversEveryLanguage: true }), { status: 200 })) })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current).toBe(false))
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-f2" })
  })

  // Review (Nov 21): with no file open the read was never sent, the answer
  // stayed null, and the Upload panel said "checking" for every media file.
  it("answers with no file open, using the project token, so a Maintainer can import media", async () => {
    getToken.mockImplementation(async (fileId: string) => `tok-${fileId}`)
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    const { result, rerender } = renderHook((props: { fileId: string | null }) =>
      useSourceAudioAccess({ projectId: "p1", fileId: props.fileId, getToken, enabled: true }),
    { initialProps: { fileId: null as string | null } })
    await waitFor(() => expect(result.current).toBe(true))
    expect(getToken).toHaveBeenCalledWith(PROJECT_TOKEN_FILE_ID)
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer tok-${PROJECT_TOKEN_FILE_ID}` })
    // What the workspace derives the Upload panel's media gate from.
    const gates = mediaEmptyGates({ roleLevel: 600, captionRowsMode: false, canEditTracks: true, coversEveryLanguage: result.current })
    expect(gates.sourceMediaNote).toBeNull()
    expect(gates.canUploadSourceMedia).toBe(true)
    // Opening a file then asks with that file's token.
    fetchMock.mockReturnValueOnce(reply({ coversEveryLanguage: true }))
    rerender({ fileId: "f1" })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok-f1" })
  })
})
