/**
 * Just Whisper must start that model's download. Enable all was the only
 * path that prefetched, so a dialog-close race left "Just Whisper" as a
 * silent no-op until the user enabled everything (and often reloaded).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  clearStoredConsent,
  MMS_MODEL,
  WHISPER_MODEL,
  requestAiModelConsent,
} from "@/lib/audio/ai-consent"
import type { PrefetchOptions } from "@/lib/audio/prefetch"

const prefetchAiModels = vi.fn(async (_opts?: PrefetchOptions) => undefined)
const isApplePlatform = vi.fn(() => false)
const altClickModifierLabel = vi.fn((): "Option" | "Alt" => "Alt")

vi.mock("@/lib/audio/prefetch", () => ({
  prefetchAiModels: (opts?: PrefetchOptions) => prefetchAiModels(opts),
}))

vi.mock("@/lib/platform", () => ({
  isApplePlatform: () => isApplePlatform(),
  altClickModifierLabel: () => altClickModifierLabel(),
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
  isApplePlatform.mockReturnValue(false)
  altClickModifierLabel.mockReturnValue("Alt")
})

afterEach(() => {
  clearStoredConsent()
  localStorage.removeItem(LOCALE_STORAGE_KEY)
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
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })

    // The next save in this browser must not open the prompt again.
    await expect(requestAiModelConsent(WHISPER_MODEL)).resolves.toBe(false)
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("Cancel on pointer-down dismisses before a focus-out can keep the prompt up", async () => {
    renderDialog()
    const granted = requestAiModelConsent(WHISPER_MODEL)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy()
    })

    fireEvent.pointerDown(screen.getByRole("button", { name: /cancel/i }))

    await expect(granted).resolves.toBe(false)
    expect(prefetchAiModels).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull()
    })
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

  it("compact Whisper prompt uses plain words for what, when, and size", async () => {
    renderDialog()
    void requestAiModelConsent(WHISPER_MODEL)
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toMatch(/after you save a recording/i)
    expect(dialog.textContent).toMatch(/transcribes it automatically/i)
    expect(dialog.textContent).toMatch(/light up in the cell/i)
    expect(dialog.textContent).toMatch(/about 140 MB/i)
    expect(dialog.textContent).not.toMatch(/karaoke/i)
    expect(dialog.textContent).not.toMatch(/word-level timing/i)
    expect(dialog.textContent).not.toMatch(/\bscrub\b/i)
    expect(screen.getByRole("button", { name: "Just Whisper" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy()
    expect(screen.getByRole("button", { name: /enable all local models/i })).toBeTruthy()
  })

  it("Learn more expands inline and collapses, without a second dialog", async () => {
    const user = userEvent.setup()
    renderDialog()
    void requestAiModelConsent(WHISPER_MODEL)
    const learnMore = await screen.findByRole("button", { name: /learn more/i })
    expect(learnMore).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(/transcript preview under the cell/i)).toBeNull()

    await user.click(learnMore)
    expect(learnMore).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByText(/transcript preview under the cell/i)).toBeTruthy()
    expect(screen.getByText(/click a word in the cell itself/i)).toBeTruthy()
    expect(screen.getByText(/not the transcript preview/i)).toBeTruthy()
    expect(screen.getByLabelText("Alt")).toHaveTextContent("Alt")
    expect(screen.getByText(/Preferences → Local models/i)).toBeTruthy()
    expect(screen.getAllByRole("dialog")).toHaveLength(1)

    await user.click(learnMore)
    expect(learnMore).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(/transcript preview under the cell/i)).toBeNull()
  })

  it("the first Tab highlights Learn more; Enter and Space toggle it; Escape still cancels", async () => {
    const user = userEvent.setup()
    renderDialog()
    const granted = requestAiModelConsent(WHISPER_MODEL)
    const dialog = await screen.findByRole("dialog")
    const learnMore = screen.getByRole("button", { name: /learn more/i })

    await waitFor(() => {
      expect(dialog).toHaveFocus()
    })
    await user.tab()
    expect(learnMore).toHaveFocus()
    expect(learnMore).toHaveAttribute("aria-expanded", "false")

    await user.keyboard("{Enter}")
    expect(learnMore).toHaveAttribute("aria-expanded", "true")
    await user.keyboard(" ")
    expect(learnMore).toHaveAttribute("aria-expanded", "false")

    await user.keyboard("{Escape}")
    await expect(granted).resolves.toBe(false)
    expect(prefetchAiModels).not.toHaveBeenCalled()
  })

  it("MMS prompt uses its own keyed explanation and the same Learn more control", async () => {
    const user = userEvent.setup()
    renderDialog()
    void requestAiModelConsent(MMS_MODEL)
    const dialog = await screen.findByRole("dialog")
    expect(dialog.textContent).toMatch(/reads the cell's text aloud/i)
    expect(screen.getByRole("button", { name: "Just MMS" })).toBeTruthy()

    const learnMore = screen.getByRole("button", { name: /learn more/i })
    await user.click(learnMore)
    expect(screen.getByText(/each language is downloaded the first time you use it/i)).toBeTruthy()
    expect(screen.getByText(/Preferences → Local models/i)).toBeTruthy()
  })

  it("a catalog locale translates the explanation and Just Whisper", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh-Hans")
    renderDialog()
    void requestAiModelConsent(WHISPER_MODEL)
    const dialog = await screen.findByRole("dialog")

    expect(screen.getByRole("button", { name: "仅 Whisper" })).toBeTruthy()
    expect(dialog.textContent).toMatch(/保存录音后/)
    expect(dialog.textContent).toMatch(/一次性下载约 140 MB/)
    expect(screen.getByRole("button", { name: "了解更多" })).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/after you save a recording/i)
    expect(screen.queryByRole("button", { name: "Just Whisper" })).toBeNull()
  })

  it("shows the Option key glyph on Apple platforms", async () => {
    isApplePlatform.mockReturnValue(true)
    altClickModifierLabel.mockReturnValue("Option")
    const user = userEvent.setup()
    renderDialog()
    void requestAiModelConsent(WHISPER_MODEL)
    await user.click(await screen.findByRole("button", { name: /learn more/i }))
    expect(screen.getByLabelText("Option")).toHaveTextContent("⌥")
    expect(screen.queryByLabelText("Alt")).toBeNull()
  })
})
