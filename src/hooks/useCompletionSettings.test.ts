import { describe, expect, it } from "vitest"
import { buildCompletionSettings } from "@/hooks/useCompletionSettings"
import type { CompletionSettings } from "@/lib/parsers/types"

// AQU-408: the AI Settings panel's Save Changes handler funnels every
// completion-settings edit through `buildCompletionSettings` (see
// ProjectSettings.tsx handleSave -> buildCompletionSettings(latest.completionSettings,
// completionUpdates)). Before this fix, the function's return object omitted
// the v1 retrieval-tuning keys entirely, so they were silently dropped on
// every save regardless of what `base` or `overrides` contained — only the
// fields it explicitly listed (systemPrompt, provider, endpoint, ...)
// persisted. This test encodes that every field on the settings panel must
// round-trip through the merge, not just systemPrompt.
describe("buildCompletionSettings — AQU-408 retrieval-tuning keys", () => {
  const base: CompletionSettings = {
    provider: "frontier",
    endpoint: "",
    model: "",
    maxTokens: 512,
    temperature: 0.3,
    systemPrompt: "existing instructions",
    llmHealthPenalty: 0.1,
    top_k: 15,
    contextSize: "medium",
    useOnlyValidatedExamples: false,
    main_chat_language: "",
    fewShotExampleFormat: "source-and-target",
  }

  it("carries forward retrieval-tuning fields from base when not overridden", () => {
    // Simulates handleSave calling buildCompletionSettings with an unrelated
    // override (e.g. only systemPrompt changed) — the other fields must
    // survive the merge, not silently reset to their factory defaults.
    const merged = buildCompletionSettings(base, { systemPrompt: "new instructions" })
    expect(merged.top_k).toBe(15)
    expect(merged.contextSize).toBe("medium")
    expect(merged.useOnlyValidatedExamples).toBe(true)
    expect(merged.main_chat_language).toBe("")
    expect(merged.fewShotExampleFormat).toBe("source-and-target")
    expect(merged.systemPrompt).toBe("new instructions")
  })

  it("applies explicit overrides for every retrieval-tuning field", () => {
    // Simulates the user changing Top K 15->17, context medium->large,
    // enabling validated-only, setting an assistant language, and switching
    // example format, then clicking Save Changes.
    const merged = buildCompletionSettings(base, {
      top_k: 17,
      contextSize: "large",
      useOnlyValidatedExamples: true,
      main_chat_language: "es",
      fewShotExampleFormat: "target-only",
    })
    expect(merged.top_k).toBe(17)
    expect(merged.contextSize).toBe("large")
    expect(merged.useOnlyValidatedExamples).toBe(true)
    expect(merged.main_chat_language).toBe("es")
    expect(merged.fewShotExampleFormat).toBe("target-only")
  })

  it("falls back to spec defaults when neither base nor overrides set a field", () => {
    const merged = buildCompletionSettings(undefined, {})
    expect(merged.top_k).toBe(15)
    expect(merged.contextSize).toBe("medium")
    expect(merged.useOnlyValidatedExamples).toBe(true)
    expect(merged.main_chat_language).toBe("")
    expect(merged.fewShotExampleFormat).toBe("source-and-target")
  })

  it("ignores legacy attempts to opt drafting into unreviewed examples", () => {
    const validatedOnlyBase: CompletionSettings = { ...base, useOnlyValidatedExamples: true }
    const merged = buildCompletionSettings(validatedOnlyBase, { useOnlyValidatedExamples: false })
    expect(merged.useOnlyValidatedExamples).toBe(true)
  })
})
