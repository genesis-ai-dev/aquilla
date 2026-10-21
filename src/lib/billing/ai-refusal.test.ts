// AQU-2068: the one AI refusal reader. Why these tests matter: before this,
// six call sites each guessed at 402/429 bodies, so the same "workspace is
// out of AI" showed as "Frontier AI limit reached", "Out of credits.", a
// vendor failure, or nothing. The helper must key on T4's stable reasons,
// still catch the legacy codes until T5–T8 land, leave rate limits and our own
// ceiling alone, and never put an amount in front of the user (R7).
import { afterEach, describe, expect, it, vi } from "vitest"
import { AiRefusalError, aiRefusalError, isAiAllowanceMessage, onAiRefusal, parseAiRefusal } from "./ai-refusal"

afterEach(() => vi.restoreAllMocks())

describe("parseAiRefusal", () => {
  it("reads T4's 402 body, including what the workspace can do about it", () => {
    expect(parseAiRefusal(402, JSON.stringify({ error: "ai_allowance_exhausted", tier: "free", resetsAt: "2026-10-26T00:00:00Z", canUpgrade: true, canByok: true })))
      .toEqual({ reason: "ai_allowance_exhausted", tier: "free", resetsAt: "2026-10-26T00:00:00Z", canUpgrade: true, canByok: true })
  })

  it("treats any 402 as the allowance, even with an unreadable body", () => {
    // 402 IS the contract (spec §5.3); a proxy that strips the body must not
    // turn it back into a generic failure.
    expect(parseAiRefusal(402, "")?.reason).toBe("ai_allowance_exhausted")
  })

  it.each(["credit_cap_exceeded", "weekly_ai_allowance_exhausted", "word_allowance_exceeded"])(
    "still catches the pre-T5 429 code %s", (code) => {
      expect(parseAiRefusal(429, { error: code })?.reason).toBe("ai_allowance_exhausted")
    })

  it("leaves a plain rate limit alone: 429 is for rate limits only now", () => {
    expect(parseAiRefusal(429, { error: "rate_limited" })).toBeNull()
    expect(parseAiRefusal(503, { error: "provider_unconfigured" })).toBeNull()
  })

  it("names our own spend ceiling separately from the workspace's allowance", () => {
    expect(parseAiRefusal(503, { error: "ai_spend_ceiling_reached" })?.reason).toBe("ai_spend_ceiling_reached")
  })
})

describe("aiRefusalError", () => {
  it("tells every meter, then returns the error to throw", () => {
    const seen = vi.fn()
    const off = onAiRefusal(seen)
    const err = aiRefusalError(402, { error: "ai_allowance_exhausted", resetsAt: "2026-10-26T12:00:00Z" })
    off()
    expect(err).toBeInstanceOf(AiRefusalError)
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ reason: "ai_allowance_exhausted" }))
    expect(err!.message).toMatch(/^This workspace has used this week's AI\. It comes back on \w+\.$/)
  })

  it("does not move the meters for our ceiling, which is not the workspace's limit", () => {
    const seen = vi.fn()
    const off = onAiRefusal(seen)
    expect(aiRefusalError(503, { error: "ai_spend_ceiling_reached" })).toBeNull()
    off()
    expect(seen).not.toHaveBeenCalled()
  })

  it("never shows an amount, even when the server sent one", () => {
    const err = aiRefusalError(429, { error: "credit_cap_exceeded", message: "Used 1,250 credits ($4.00) of 1,000." })
    expect(err!.message).not.toMatch(/\d|credit|\$/i)
  })
})

describe("isAiAllowanceMessage", () => {
  it("recognises the helper's own message and a raw body folded into text", () => {
    expect(isAiAllowanceMessage(new AiRefusalError({ reason: "ai_allowance_exhausted", canUpgrade: false, canByok: false }).message)).toBe(true)
    expect(isAiAllowanceMessage('voice/tts failed (429): {"error":"credit_cap_exceeded"}')).toBe(true)
    expect(isAiAllowanceMessage('voice/tts failed (429): {"error":"tts_daily_limit_exceeded"}')).toBe(false)
  })
})
