import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, act } from "@testing-library/react"
import { LocalLlmConfigMount } from "./LocalLlmConfigMount"

let tauriRuntime = false
vi.mock("@/lib/offline/is-tauri", () => ({
  isTauriRuntime: () => tauriRuntime,
}))

let settings = { endpoint: "http://localhost:11434", model: "llama3" }
vi.mock("@/lib/offline/llm-settings", () => ({
  useLocalLlmSettings: () => settings,
}))

const invoke = vi.fn(async (_cmd: string, _args: unknown) => undefined)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invoke(cmd, args),
}))

beforeEach(() => {
  tauriRuntime = false
  settings = { endpoint: "http://localhost:11434", model: "llama3" }
  invoke.mockClear()
})

describe("LocalLlmConfigMount", () => {
  it("does nothing outside Tauri", async () => {
    render(<LocalLlmConfigMount />)
    await act(async () => {})
    expect(invoke).not.toHaveBeenCalled()
  })

  it("pushes the current settings into Rust on mount inside Tauri", async () => {
    tauriRuntime = true
    render(<LocalLlmConfigMount />)
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith("set_llm_config", {
      endpoint: "http://localhost:11434",
      model: "llama3",
    })
  })

  it("re-pushes when the settings change", async () => {
    tauriRuntime = true
    const { rerender } = render(<LocalLlmConfigMount />)
    await act(async () => {})
    invoke.mockClear()

    settings = { endpoint: "http://localhost:9999", model: "mistral" }
    rerender(<LocalLlmConfigMount />)
    await act(async () => {})
    expect(invoke).toHaveBeenCalledWith("set_llm_config", {
      endpoint: "http://localhost:9999",
      model: "mistral",
    })
  })
})
