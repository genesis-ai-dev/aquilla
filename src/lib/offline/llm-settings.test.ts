import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  DEFAULT_LOCAL_LLM_SETTINGS,
  getLocalLlmSettings,
  resetLocalLlmSettingsCacheForTests,
  setLocalLlmSettings,
  useLocalLlmSettings,
} from "./llm-settings"

const KEY = "aq.offline-llm.v1"

describe("llm-settings", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
    resetLocalLlmSettingsCacheForTests()
  })

  it("defaults to Ollama's own defaults when nothing is stored", () => {
    expect(getLocalLlmSettings()).toEqual(DEFAULT_LOCAL_LLM_SETTINGS)
  })

  it("persists a saved endpoint/model and reads it back", () => {
    setLocalLlmSettings({ endpoint: "http://localhost:8000", model: "mistral" })
    expect(getLocalLlmSettings()).toEqual({ endpoint: "http://localhost:8000", model: "mistral" })
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({
      endpoint: "http://localhost:8000",
      model: "mistral",
    })
  })

  it("reads a stored value after a cache reset (fresh session)", () => {
    localStorage.setItem(KEY, JSON.stringify({ endpoint: "http://localhost:9000", model: "phi3" }))
    resetLocalLlmSettingsCacheForTests()
    expect(getLocalLlmSettings()).toEqual({ endpoint: "http://localhost:9000", model: "phi3" })
  })

  it("falls back to defaults for blank fields instead of storing empty strings", () => {
    setLocalLlmSettings({ endpoint: "  ", model: "  " })
    expect(getLocalLlmSettings()).toEqual(DEFAULT_LOCAL_LLM_SETTINGS)
  })

  it("treats malformed stored JSON as unset", () => {
    localStorage.setItem(KEY, "{not json")
    resetLocalLlmSettingsCacheForTests()
    expect(getLocalLlmSettings()).toEqual(DEFAULT_LOCAL_LLM_SETTINGS)
  })

  it("notifies useLocalLlmSettings subscribers on save", () => {
    const { result } = renderHook(() => useLocalLlmSettings())
    expect(result.current).toEqual(DEFAULT_LOCAL_LLM_SETTINGS)

    act(() => {
      setLocalLlmSettings({ endpoint: "http://localhost:1234", model: "qwen" })
    })
    expect(result.current).toEqual({ endpoint: "http://localhost:1234", model: "qwen" })
  })
})
