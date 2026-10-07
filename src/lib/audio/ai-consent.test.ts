import { afterEach, describe, expect, it } from "vitest"
import {
  AiModelConsentDeniedError,
  MMS_MODEL,
  WHISPER_MODEL,
  clearStoredConsent,
  requestAiModelConsent,
  usePendingAiConsent,
} from "./ai-consent"
import { renderHook, act } from "@testing-library/react"

afterEach(() => { clearStoredConsent() })

describe("requestAiModelConsent", () => {
  it("resolves immediately if the user has previously consented", async () => {
    const { result } = renderHook(() => usePendingAiConsent())
    const promise = requestAiModelConsent(WHISPER_MODEL)
    await act(async () => {})
    expect(result.current?.model.id).toBe("whisper")
    act(() => { result.current!.resolve(true) })
    await expect(promise).resolves.toBe(true)

    // Second request for the same model must resolve without a new dialog.
    const r2 = renderHook(() => usePendingAiConsent())
    const p2 = requestAiModelConsent(WHISPER_MODEL)
    await expect(p2).resolves.toBe(true)
    expect(r2.result.current).toBeNull()
  })

  it("returns false when the user cancels", async () => {
    const { result } = renderHook(() => usePendingAiConsent())
    const promise = requestAiModelConsent(MMS_MODEL)
    await act(async () => {})
    expect(result.current?.model.id).toBe("mms")
    act(() => { result.current!.resolve(false) })
    await expect(promise).resolves.toBe(false)

    // Cancel is once per browser — the next save must not open the prompt.
    const r2 = renderHook(() => usePendingAiConsent())
    await expect(requestAiModelConsent(MMS_MODEL)).resolves.toBe(false)
    expect(r2.result.current).toBeNull()

    // The Transcribe button asks again.
    const r3 = renderHook(() => usePendingAiConsent())
    const again = requestAiModelConsent(MMS_MODEL, { askAgain: true })
    await act(async () => {})
    expect(r3.result.current?.model.id).toBe("mms")
    act(() => { r3.result.current!.resolve(false) })
    await expect(again).resolves.toBe(false)
  })

  it("coalesces concurrent requests for the same model into one dialog", async () => {
    const { result } = renderHook(() => usePendingAiConsent())
    const a = requestAiModelConsent(WHISPER_MODEL)
    const b = requestAiModelConsent(WHISPER_MODEL)
    await act(async () => {})
    expect(result.current?.model.id).toBe("whisper")
    act(() => { result.current!.resolve(true) })
    expect(await a).toBe(true)
    expect(await b).toBe(true)
  })

  it("a later dialog close cannot undo accept for coalesced waiters", async () => {
    const { result } = renderHook(() => usePendingAiConsent())
    const a = requestAiModelConsent(MMS_MODEL)
    const b = requestAiModelConsent(MMS_MODEL)
    await act(async () => {})
    const req = result.current!
    act(() => { req.resolve(true) })
    act(() => { req.resolve(false) })
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    await expect(requestAiModelConsent(MMS_MODEL)).resolves.toBe(true)
  })

  it("AiModelConsentDeniedError carries the model id", () => {
    const e = new AiModelConsentDeniedError("whisper")
    expect(e.modelId).toBe("whisper")
    expect(e.name).toBe("AiModelConsentDeniedError")
  })
})
