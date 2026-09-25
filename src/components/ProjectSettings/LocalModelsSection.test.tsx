import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"

vi.mock("@/lib/audio/prefetch", () => ({
  useModelStatus: () => ({ kind: "idle" }),
  hydratePrefetchStatus: vi.fn(),
  prefetchAiModels: vi.fn(),
  clearPrefetchStatus: vi.fn(),
}))

import { LocalModelsSection } from "./LocalModelsSection"

describe("LocalModelsSection", () => {
  it("describes Whisper with the shared consent copy", () => {
    render(
      <I18nProvider>
        <LocalModelsSection />
      </I18nProvider>,
    )
    expect(screen.getByText(/after you save a recording/i)).toBeInTheDocument()
    expect(screen.queryByText(/karaoke/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/word-level timing/i)).not.toBeInTheDocument()
  })
})
