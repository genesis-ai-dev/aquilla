/**
 * Just Whisper must start that model's download. Enable all was the only
 * path that prefetched, so a dialog-close race left "Just Whisper" as a
 * silent no-op until the user enabled everything (and often reloaded).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  clearStoredConsent,
  MMS_MODEL,
  WHISPER_MODEL,
  requestAiModelConsent,
} from "@/lib/audio/ai-consent"
import type { PrefetchOptions } from "@/lib/audio/prefetch"

const prefetchAiModels = vi.fn(async (_opts?: PrefetchOptions) => undefined)

vi.mock("@/lib/audio/prefetch", () => ({
  prefetchAiModels: (opts?: PrefetchOptions) => prefetchAiModels(opts),
}))

import { AiModelConsentDialog } from "./AiModelConsentDialog"

function renderDialog() {
  return render(
    <I18nProvider>
      <TooltipProvider delay={0}>
        <AiModelConsentDialog />
      </TooltipProvider>
    </I18nProvider>,
  )
}

beforeEach(() => {
  clearStoredConsent()
  prefetchAiModels.mockClear()
})

afterEach(() => {
  clearStoredConsent()
})

describe("AiModelConsentDialog", () => {
  it("Just Whisper grants consent and prefetches only Whisper", async () => {
    renderDialog()
    const granted = requestAiModelConsent(WHISPER_MODEL)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /just whisper/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole("button", { name: /just whisper/i }))

    await expect(granted).resolves.toBe(true)
    expect(prefetchAiModels).toHaveBeenCalledWith(
      expect.objectContaining({ models: ["whisper"] }),
    )
    expect(prefetchAiModels.mock.calls.some((c) => {
      const models = c[0]?.models ?? []
      return models.includes("mms")
    })).toBe(false)
  })

  it("Just Whisper on pointer-down grants before a dismiss can race", async () => {
    renderDialog()
    const granted = requestAiModelConsent(WHISPER_MODEL)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /just whisper/i })).toBeTruthy()
    })

    fireEvent.pointerDown(screen.getByRole("button", { name: /just whisper/i }))

    await expect(granted).resolves.toBe(true)
    expect(prefetchAiModels).toHaveBeenCalledWith(
      expect.objectContaining({ models: ["whisper"] }),
    )
  })

  it("Enable all local models grants consent and prefetches the pending model first", async () => {
    renderDialog()
    const granted = requestAiModelConsent(MMS_MODEL)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /enable all local models/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole("button", { name: /enable all local models/i }))

    await expect(granted).resolves.toBe(true)
    await waitFor(() => {
      expect(prefetchAiModels).toHaveBeenCalled()
    })
    expect(prefetchAiModels.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ models: ["mms"] }),
    )
  })

  it("Cancel denies consent and does not prefetch", async () => {
    renderDialog()
    const granted = requestAiModelConsent(WHISPER_MODEL)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))

    await expect(granted).resolves.toBe(false)
    expect(prefetchAiModels).not.toHaveBeenCalled()
  })

  it("a dialog close after Just Whisper cannot un-grant consent", async () => {
    renderDialog()
    const granted = requestAiModelConsent(WHISPER_MODEL)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /just whisper/i })).toBeTruthy()
    })

    fireEvent.click(screen.getByRole("button", { name: /just whisper/i }))
    await expect(granted).resolves.toBe(true)

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" })
    })
    await expect(requestAiModelConsent(WHISPER_MODEL)).resolves.toBe(true)
  })
})
