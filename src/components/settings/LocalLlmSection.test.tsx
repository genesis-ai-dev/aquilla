import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { LocalLlmSection } from "./LocalLlmSection"

let tauriRuntime = false
vi.mock("@/lib/offline/is-tauri", () => ({
  isTauriRuntime: () => tauriRuntime,
}))

let currentSettings = { endpoint: "http://localhost:11434", model: "llama3" }
const setLocalLlmSettings = vi.fn((next: { endpoint: string; model: string }) => {
  currentSettings = next
})
vi.mock("@/lib/offline/llm-settings", () => ({
  DEFAULT_LOCAL_LLM_SETTINGS: { endpoint: "http://localhost:11434", model: "llama3" },
  useLocalLlmSettings: () => currentSettings,
  setLocalLlmSettings: (next: { endpoint: string; model: string }) => setLocalLlmSettings(next),
}))

const testLocalLlmConnection = vi.fn()
const listLocalLlmModels = vi.fn()
vi.mock("@/lib/offline/local-llm-client", () => ({
  testLocalLlmConnection: (settings: unknown) => testLocalLlmConnection(settings),
  listLocalLlmModels: (endpoint: string) => listLocalLlmModels(endpoint),
}))

beforeEach(() => {
  tauriRuntime = true
  currentSettings = { endpoint: "http://localhost:11434", model: "llama3" }
  setLocalLlmSettings.mockClear()
  testLocalLlmConnection.mockReset()
  listLocalLlmModels.mockReset()
})

describe("LocalLlmSection", () => {
  it("renders nothing outside Tauri", () => {
    tauriRuntime = false
    const { container } = render(<LocalLlmSection />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders the current endpoint and model", () => {
    currentSettings = { endpoint: "http://localhost:9000", model: "phi3" }
    render(<LocalLlmSection />)
    expect(screen.getByDisplayValue("http://localhost:9000")).toBeInTheDocument()
    expect(screen.getByDisplayValue("phi3")).toBeInTheDocument()
  })

  // AQU-2262: settings save as you change them; there is no Save button.
  it("saves the endpoint when you leave the field, with no Save button", async () => {
    render(<LocalLlmSection />)
    expect(screen.queryByRole("button", { name: /^save$/i })).toBeNull()
    const endpointInput = screen.getByDisplayValue("http://localhost:11434")
    fireEvent.change(endpointInput, { target: { value: "http://localhost:8000" } })
    expect(setLocalLlmSettings).not.toHaveBeenCalled()
    fireEvent.blur(endpointInput)

    await waitFor(() => expect(setLocalLlmSettings).toHaveBeenCalledWith({
      endpoint: "http://localhost:8000",
      model: "llama3",
    }))
  })

  it("shows a success result from the test-connection button", async () => {
    testLocalLlmConnection.mockResolvedValue({ ok: true, message: "Connected — replied \"pong\"" })
    render(<LocalLlmSection />)
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => expect(screen.getByText(/Connected/)).toBeInTheDocument())
    expect(testLocalLlmConnection).toHaveBeenCalledWith({
      endpoint: "http://localhost:11434",
      model: "llama3",
    })
  })

  it("shows a failure result from the test-connection button", async () => {
    testLocalLlmConnection.mockResolvedValue({ ok: false, message: "ECONNREFUSED" })
    render(<LocalLlmSection />)
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }))

    await waitFor(() => expect(screen.getByText("ECONNREFUSED")).toBeInTheDocument())
  })

  describe("detect models", () => {
    it("auto-fills the model field when exactly one model is found", async () => {
      listLocalLlmModels.mockResolvedValue(["qwen/qwen2.5-coder-14b"])
      render(<LocalLlmSection />)
      fireEvent.click(screen.getByRole("button", { name: /detect models/i }))

      await waitFor(() =>
        expect(screen.getByDisplayValue("qwen/qwen2.5-coder-14b")).toBeInTheDocument(),
      )
      expect(listLocalLlmModels).toHaveBeenCalledWith("http://localhost:11434")
      expect(screen.getByText(/Detected and filled in/)).toBeInTheDocument()
      // Filled in is saved (AQU-2262).
      expect(setLocalLlmSettings).toHaveBeenCalledWith({
        endpoint: "http://localhost:11434",
        model: "qwen/qwen2.5-coder-14b",
      })
    })

    it("offers a pick list when multiple models are found, and fills the field on click", async () => {
      listLocalLlmModels.mockResolvedValue(["llama3", "mistral", "qwen2.5"])
      render(<LocalLlmSection />)
      fireEvent.click(screen.getByRole("button", { name: /detect models/i }))

      await waitFor(() => expect(screen.getByText(/Found multiple models/)).toBeInTheDocument())
      fireEvent.click(screen.getByRole("button", { name: "mistral" }))

      expect(screen.getByDisplayValue("mistral")).toBeInTheDocument()
      expect(setLocalLlmSettings).toHaveBeenCalledWith({ endpoint: "http://localhost:11434", model: "mistral" })
    })

    it("reports when no models are found", async () => {
      listLocalLlmModels.mockResolvedValue([])
      render(<LocalLlmSection />)
      fireEvent.click(screen.getByRole("button", { name: /detect models/i }))

      await waitFor(() => expect(screen.getByText(/No models found/)).toBeInTheDocument())
    })

    it("reports an error when detection fails", async () => {
      listLocalLlmModels.mockRejectedValue(new Error("ECONNREFUSED"))
      render(<LocalLlmSection />)
      fireEvent.click(screen.getByRole("button", { name: /detect models/i }))

      await waitFor(() => expect(screen.getByText("ECONNREFUSED")).toBeInTheDocument())
    })

    it("clears the detect result once the model field is edited by hand", async () => {
      listLocalLlmModels.mockResolvedValue([])
      render(<LocalLlmSection />)
      fireEvent.click(screen.getByRole("button", { name: /detect models/i }))
      await waitFor(() => expect(screen.getByText(/No models found/)).toBeInTheDocument())

      fireEvent.input(screen.getByDisplayValue("llama3"), { target: { value: "custom-model" } })
      expect(screen.queryByText(/No models found/)).not.toBeInTheDocument()
    })
  })
})
