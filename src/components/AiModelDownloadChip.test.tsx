import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { Toaster, toast } from "@/components/ui/toast"
import {
  __testOnlySetStatus,
  clearPrefetchStatus,
} from "@/lib/audio/prefetch"
import { AiModelDownloadChip } from "./AiModelDownloadChip"

function downloading(loaded: number, total: number) {
  return { kind: "downloading" as const, loaded, total, file: "model.onnx" }
}

function renderChip() {
  return render(
    <I18nProvider>
      <Toaster />
      <AiModelDownloadChip />
    </I18nProvider>,
  )
}

async function expectGone(text: string) {
  await waitFor(() => expect(screen.queryByText(text)).toBeNull())
}

describe("AiModelDownloadChip", () => {
  beforeEach(async () => {
    await clearPrefetchStatus()
    toast.close()
  })

  afterEach(async () => {
    toast.close()
    await clearPrefetchStatus()
  })

  it("renders nothing when idle", () => {
    renderChip()
    expect(screen.queryByText("Downloading AI models")).toBeNull()
    expect(screen.queryByText("Loading AI model")).toBeNull()
  })

  it("shows a download toast with a bar and percentage for the model", () => {
    __testOnlySetStatus("whisper", downloading(58, 100))
    renderChip()

    expect(screen.getByText("Downloading AI models")).toBeTruthy()
    const bar = screen.getByRole("progressbar", { name: "Whisper" })
    expect(bar).toHaveAttribute("aria-valuenow", "58")
    expect(bar.querySelector(".bg-emerald-500")).toBeNull()
    expect(bar.querySelector(".bg-primary")).toBeTruthy()
    expect(screen.getByText("58%")).toBeTruthy()
    expect(screen.queryByText(/Runs in the background/)).toBeNull()
    expect(document.querySelector("[data-slot=spinner]")).toBeTruthy()
    expect(screen.queryByText("Loading AI model")).toBeNull()

    act(() => {
      __testOnlySetStatus("whisper", downloading(70, 100))
    })
    expect(screen.getByRole("progressbar", { name: "Whisper" })).toHaveAttribute("aria-valuenow", "70")
  })

  it("keeps one bar per model and swaps a finished download onto the loading toast", async () => {
    __testOnlySetStatus("whisper", downloading(58, 100))
    __testOnlySetStatus("mms", downloading(87, 100))
    renderChip()

    act(() => {
      __testOnlySetStatus("whisper", { kind: "loading", file: "model.onnx" })
    })

    expect(screen.getByText("Downloading AI models")).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "MMS" })).toHaveAttribute("aria-valuenow", "87")
    expect(screen.queryByRole("progressbar", { name: "Whisper" })).toBeNull()
    expect(screen.getByText("Loading Whisper model")).toBeInTheDocument()
    expect(screen.queryByText("Loading AI model")).toBeNull()

    act(() => {
      __testOnlySetStatus("mms", { kind: "loading", file: "model.onnx" })
    })

    await expectGone("Downloading AI models")
    expect(screen.getByText("Loading AI models")).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Whisper" })).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "MMS" })).toBeInTheDocument()

    act(() => {
      __testOnlySetStatus("whisper", { kind: "ready" })
      __testOnlySetStatus("mms", { kind: "ready" })
    })

    await expectGone("Loading AI models")
  })

  it("shows a retryable error toast when a download fails", () => {
    __testOnlySetStatus("whisper", { kind: "error", message: "Network blocked the download." })
    renderChip()

    expect(screen.getByText("Whisper download failed")).toBeTruthy()
    expect(screen.getByText("Network blocked the download.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
  })
})
