import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
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
      <AiModelDownloadChip />
    </I18nProvider>,
  )
}

describe("AiModelDownloadChip", () => {
  beforeEach(async () => {
    await clearPrefetchStatus()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await clearPrefetchStatus()
  })

  it("renders nothing when idle", () => {
    const { container } = renderChip()
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a green bar and percentage while a model is downloading", () => {
    __testOnlySetStatus("whisper", downloading(58, 100))
    renderChip()

    expect(screen.getByText("Downloading AI models")).toBeTruthy()
    expect(screen.getByText("Whisper")).toBeTruthy()
    expect(screen.getByText("58%")).toBeTruthy()
    expect(document.querySelector(".bg-emerald-500")).toBeTruthy()
  })

  it("keeps a finished model in the same row with a right-side check until the batch is done", () => {
    __testOnlySetStatus("whisper", downloading(58, 100))
    __testOnlySetStatus("mms", downloading(87, 100))
    renderChip()

    act(() => {
      __testOnlySetStatus("whisper", { kind: "ready" })
    })

    expect(screen.getByText("Downloading AI models")).toBeInTheDocument()
    expect(screen.getByText("87%")).toBeInTheDocument()
    expect(screen.queryByText("100%")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Whisper ready to use")).toBeInTheDocument()
    expect(screen.queryByText("ready to use")).not.toBeInTheDocument()

    const whisper = screen.getByText("Whisper")
    const mms = screen.getByText("MMS")
    expect(whisper.compareDocumentPosition(mms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("does not hide a finished row after 4s while others are still downloading", () => {
    vi.useFakeTimers()
    __testOnlySetStatus("whisper", downloading(10, 100))
    __testOnlySetStatus("mms", downloading(100, 100))
    renderChip()

    act(() => {
      __testOnlySetStatus("mms", { kind: "ready" })
    })
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(screen.getByText("MMS")).toBeTruthy()
    expect(screen.getByLabelText("MMS ready to use")).toBeTruthy()
    expect(screen.getByText("Downloading AI models")).toBeTruthy()
  })

  it("switches the heading once every model in the batch is ready", () => {
    __testOnlySetStatus("whisper", downloading(10, 100))
    __testOnlySetStatus("mms", downloading(10, 100))
    renderChip()

    act(() => {
      __testOnlySetStatus("whisper", { kind: "ready" })
      __testOnlySetStatus("mms", { kind: "ready" })
    })

    expect(screen.getByText("AI models ready")).toBeTruthy()
    expect(screen.getByLabelText("Whisper ready to use")).toBeTruthy()
    expect(screen.getByLabelText("MMS ready to use")).toBeTruthy()
    expect(screen.queryByText("ready to use")).toBeNull()
  })
})
