// WHY (AQU-891): clicking "Draft paragraph" surfaced the chat proxy's raw
// response on every cell — an OpenRouter 413 JSON payload rendered in red.
// categorizeAiError is the single place that decides what a user reads, so
// these tests pin the contract: a machine payload never becomes the primary
// message, and a message we authored ourselves is not thrown away.

import { describe, it, expect } from "vitest"
import { categorizeAiError } from "./ai-error"

const OPENROUTER_413 =
  'Completion failed: 413 {"error":{"message":"request too large for model `meta-llama/llama-3.3-70b-instruct`, max 131072 tokens","code":413},"user_id":"user_2abc"}'

describe("categorizeAiError — AI request failures (AQU-891)", () => {
  it("categorizes an OpenRouter 413 as a context-size problem, not a raw dump", () => {
    const result = categorizeAiError(OPENROUTER_413)
    expect(result.category).toBe("request-too-large")
    expect(result.title).toBe("Too much text for this model")
    // The body must be actionable prose — never the payload.
    expect(result.body).not.toContain("{")
    expect(result.body).toMatch(/fewer cells|context window/i)
    // …but the verbatim text is still available for support.
    expect(result.raw).toBe(OPENROUTER_413)
  })

  it("keeps the raw payload out of the body for any unrecognized machine dump", () => {
    const raw = 'Completion failed: 418 {"error":{"message":"teapot","code":418}}'
    const result = categorizeAiError(raw)
    expect(result.body).not.toContain("{")
    expect(result.body).not.toBe(raw)
    expect(result.raw).toBe(raw)
  })

  it("maps 5xx to a temporary-outage message and 4xx to a rejected-request one", () => {
    expect(categorizeAiError("Completion failed: 502 Bad Gateway").category).toBe(
      "provider-unavailable",
    )
    expect(categorizeAiError("Completion failed: 403 Forbidden").category).toBe(
      "provider-rejected",
    )
  })

  it("recognizes rate limiting and timeouts", () => {
    expect(categorizeAiError("Completion failed: 429 slow down").category).toBe("rate-limited")
    expect(categorizeAiError("The AI request timed out. Please try again.").category).toBe(
      "timed-out",
    )
  })

  it("does not mistake a three-digit number inside a payload for an HTTP status", () => {
    // No "failed:/error/status/http" lead-in — this must not read as a 500.
    const result = categorizeAiError("The model returned 500 characters of nothing useful")
    expect(result.category).not.toBe("provider-unavailable")
  })

  it("preserves a plain-language message we authored as the body", () => {
    const raw = "No source text yet — transcribe this section first."
    expect(categorizeAiError(raw).body).toBe(raw)
  })

  it("leaves a dead-lettered stale draft's message intact", () => {
    // completion-races.spec.ts asserts "was not saved" is ABSENT on a healthy
    // run, so this sentence has to survive categorization as the body — which
    // is what InlineAiError renders inline when body === raw.
    const raw =
      "The draft was outdated by another change to this cell and was not saved — try again"
    expect(categorizeAiError(raw).body).toBe(raw)
  })

  it("still reports the platform daily-quota case ahead of the generic 429 branch", () => {
    const result = categorizeAiError("Daily AI limit reached — resets at midnight UTC")
    expect(result.category).toBe("daily-quota-exceeded")
  })
})
