import { afterEach, describe, expect, it } from "vitest"
import {
  AiModelConsentDeniedError,
  KOKORO_MODEL,
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
    const promise = requestAiModelConsent(KOKORO_MODEL)
    await act(async () => {})
    expect(result.current?.model.id).toBe("kokoro")
    act(() => { result.current!.resolve(false) })
    await expect(promise).resolves.toBe(false)

    // Cancellation does NOT persist consent — next request shows the dialog again.
    const r2 = renderHook(() => usePendingAiConsent())
    const p2 = requestAiModelConsent(KOKORO_MODEL)
    await act(async () => {})
    expect(r2.result.current?.model.id).toBe("kokoro")
    act(() => { r2.result.current!.resolve(false) })
    await expect(p2).resolves.toBe(false)
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

  it("AiModelConsentDeniedError carries the model id", () => {
    const e = new AiModelConsentDeniedError("whisper")
    expect(e.modelId).toBe("whisper")
    expect(e.name).toBe("AiModelConsentDeniedError")
  })
})
