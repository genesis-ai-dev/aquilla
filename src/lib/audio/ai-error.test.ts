// WHY (AQU-891): clicking "Draft paragraph" surfaced the chat proxy's raw
// response on every cell — an OpenRouter 413 JSON payload rendered in red.
// categorizeAiError is the single place that decides what a user reads, so
// these tests pin the contract: a machine payload never becomes the primary
// message, and a message we authored ourselves is not thrown away.

import { describe, it, expect } from "vitest"
import { categorizeAiError } from "./ai-error"
import { errorFromHostedTts, errorFromVoiceConvert } from "./tts-engine-error"
import { AiRefusalError } from "@/lib/billing/ai-refusal"

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

  // AQU-1869: the platform spend ceiling. Its server message also says "resets
  // at midnight UTC", so without its own earlier branch it would wear the
  // personal-quota copy and tell the user they had used up their own limit.
  it("separates the platform spend ceiling from the user's own daily quota", () => {
    // The real producer's output, not a hand-written string: the ceiling's 503
    // body reaches the user only through these formatters, and a fixture that
    // skipped them would not prove the composition.
    const ceilingBody = JSON.stringify({
      error: "ai_spend_ceiling_reached",
      message:
        "AI is temporarily unavailable: the platform's daily AI spend ceiling has been reached. It resets at midnight UTC.",
    })
    for (const err of [errorFromHostedTts(503, ceilingBody), errorFromVoiceConvert(503, ceilingBody)]) {
      const result = categorizeAiError(err.message)
      expect(result.category).toBe("ai-spend-ceiling")
      expect(result.title).toMatch(/unavailable/i)
      // It must not read as the user's own allowance, it must not be mistaken
      // for an unconfigured voice engine, and it must not dump the machine
      // payload the way `unknown` would.
      expect(result.body).not.toMatch(/daily AI limit reached/i)
      expect(result.body).not.toMatch(/isn't configured|not set up/i)
      expect(result.body).not.toContain("{")
      expect(result.body).toMatch(/midnight UTC/)
    }
  })
})

// AQU-646 stage 4c: the audio failures. Every one of these reached a user as a
// raw server fragment before this round — not because the branches below were
// missing, but because `extractStatus` could not read the format this app
// writes, so all of them fell through to `unknown`.
describe("categorizeAiError — a protected-IDML refusal (AQU-1964)", () => {
  // The message the drafting pipeline throws for the reported cell. An IDML
  // cell id IS its anchor locator, which is why this sentence carries square
  // brackets and runs long — the two things `looksLikeMachineDump` rejects.
  const PROTECTED_ANCHOR_REFUSAL =
    "The AI draft changed a protected IDML anchor in cell "
    + "Stories/Story_u363.xml#/idPkg:Story[1]/Story[1]/ParagraphStyleRange[11]:part-1; "
    + "a repair pass also failed. Nothing was saved. "
    + "IDML anchor sequence does not match its metadata hash"

  it("explains the refusal instead of falling through to the generic line", () => {
    const result = categorizeAiError(PROTECTED_ANCHOR_REFUSAL)

    expect(result.category).toBe("protected-format")
    expect(result.title).toBe("Protected formatting stopped this draft")
    // The reader is told the draft was discarded AND what to do next — the
    // "nothing happened" report is exactly the absence of this sentence.
    expect(result.body).toMatch(/discarded/i)
    expect(result.body).toMatch(/draft the cell again|type the translation/i)
    expect(result.body).not.toBe(
      categorizeAiError("some wholly unrecognized {payload}").body,
    )
    // The locator still reaches support through the technical detail.
    expect(result.raw).toBe(PROTECTED_ANCHOR_REFUSAL)
  })

  it("would have been swallowed as a machine dump without its own branch", () => {
    // Pins the root cause so a future shortening of the message does not make
    // this test pass for the wrong reason.
    expect(PROTECTED_ANCHOR_REFUSAL.length).toBeGreaterThan(180)
    expect(PROTECTED_ANCHOR_REFUSAL).toMatch(/[[\]]/)
  })

  it("covers the refusals thrown before any repair pass runs", () => {
    for (const raw of [
      "The AI draft changed a protected IDML anchor in cell c1; nothing was saved.",
      "The AI returned no text inside the editable IDML slots for cell c1; nothing was saved.",
      "Cell c1 is missing protected IDML slot 3.",
      "Cell c1 does not contain one canonical IDML paragraph.",
    ]) {
      expect(categorizeAiError(raw).category).toBe("protected-format")
    }
  })
})

describe("categorizeAiError — the audio failures (AQU-646 stage 4c)", () => {
  it("reads a status written in brackets, which is how every audio error writes it", () => {
    // The literal shape from upload.ts — the one audio error that still rides
    // the generic status branches. tts.ts and voice-clone.ts strings are
    // claimed by the engine-named branches (AQU-1001) tested below.
    expect(categorizeAiError("audio upload failed (500): internal error").category).toBe(
      "provider-unavailable",
    )
    expect(categorizeAiError("audio upload failed (403): insufficient role").category).toBe(
      "provider-rejected",
    )
  })

  // THE ORDERING TEST. Inworld is the default engine and answers 503 for
  // this, so the moment brackets parse, the generic 5xx branch would claim it
  // and tell the user to try again in a moment — advice that can never come
  // true, on the most likely voice failure there is.
  it("calls an unconfigured voice service what it is, not a temporary outage", () => {
    const result = categorizeAiError("voice/tts failed (503): TTS not configured")
    expect(result.category).toBe("hosted-tts-not-configured")
    expect(result.category).not.toBe("provider-unavailable")
    expect(result.body).not.toMatch(/temporary|try again in a moment/i)
  })

  it("recognizes the TTS daily budget, which arrives as a JSON machine code", () => {
    const raw = 'voice/tts failed (429): {"error":"tts_daily_limit_exceeded"}'
    const result = categorizeAiError(raw)
    expect(result.category).toBe("daily-quota-exceeded")
    // It used to land in `unknown`, where the braces tripped
    // `looksLikeMachineDump` and replaced it with "the AI request didn't
    // finish" — the least useful sentence available for the one failure the
    // user can actually wait out.
    expect(result.body).not.toContain("{")
    expect(result.body).toMatch(/daily/i)
  })

  // The guard the widened regex must not break: a bracketed number with no
  // failure lead-in is still not a status.
  it("still refuses a bare parenthesised number that is not a status", () => {
    expect(categorizeAiError("The take (500) was the longest one").category).not.toBe(
      "provider-unavailable",
    )
  })
})

describe("categorizeAiError — names the TTS engine that failed", () => {
  it("does not treat a local Inworld 503 as a missing Gemini key", () => {
    const result = categorizeAiError("voice/tts failed (503): TTS not configured")
    expect(result.category).toBe("hosted-tts-not-configured")
    expect(result.title).toBe("Inworld TTS isn't configured")
    expect(result.body).toMatch(/inworld/i)
    expect(result.body).toMatch(/not gemini/i)
    expect(result.body).toMatch(/will not fix/i)
  })

  it("recognizes the authored Inworld-not-configured body", () => {
    const raw =
      "This line uses Inworld TTS, not Gemini. Hosted TTS isn't wired on this server, so a Gemini API key will not fix it."
    const result = categorizeAiError(raw)
    expect(result.category).toBe("hosted-tts-not-configured")
    expect(result.title).toBe("Inworld TTS isn't configured")
  })

  // AQU-1872/AQU-2068: a workspace out of allowance is refused before the
  // vendor is ever called. Titling that "Inworld TTS failed" sends the user to
  // debug an engine that is working.
  it("calls an exhausted allowance what it is, not an engine failure", () => {
    const result = categorizeAiError(
      'Inworld TTS failed (429): {"error":"credit_cap_exceeded","reason":"daily"}',
    )
    expect(result.category).toBe("ai-allowance-exhausted")
    expect(result.title).toBe("This week's AI is used up")
    expect(result.body).toMatch(/used this week's AI/i)
    // Never a machine dump, never advice to retry, never credits or amounts.
    expect(result.body).not.toMatch(/credit_cap_exceeded|credit|\$/i)
    expect(result.body).not.toMatch(/try again in a moment/i)
    expect(result.body).not.toMatch(/gemini/i)
  })

  it("places the refusal helper's own message after it was rethrown", () => {
    // WHY: call sites throw AiRefusalError; surfaces categorize err.message.
    const message = new AiRefusalError({ reason: "ai_allowance_exhausted", resetsAt: "2026-10-26T00:00:00Z", canUpgrade: true, canByok: true }).message
    const result = categorizeAiError(message)
    expect(result.category).toBe("ai-allowance-exhausted")
    expect(result.body).toBe(message)
  })

  it("keeps the per-user TTS budget 429 on its own daily-quota branch", () => {
    // WHY: two different 429s. The credit branch must not annex the seconds cap.
    const result = categorizeAiError(
      'voice/tts failed (429): {"error":"tts_daily_limit_exceeded"}',
    )
    expect(result.category).toBe("daily-quota-exceeded")
  })

  it("names Inworld on a later upstream failure", () => {
    const result = categorizeAiError("Inworld TTS failed (502): upstream timeout")
    expect(result.category).toBe("hosted-tts-failed")
    expect(result.title).toBe("Inworld TTS failed")
    expect(result.body).toMatch(/not a gemini key/i)
  })

  it("names Seed-VC when clone conversion isn't wired", () => {
    const result = categorizeAiError("voice convert failed (503): voice conversion not configured")
    expect(result.category).toBe("seed-vc-not-configured")
    expect(result.title).toBe("Voice cloning isn't configured")
    expect(result.body).toMatch(/seed-vc/i)
  })

  it("reports a conversion failure without naming one engine (AQU-2212)", () => {
    // Change voice runs on Seed-VC or the voice forge; the copy must fit both.
    for (const raw of [
      "Voice conversion failed (500): gpu OOM",
      "Voice cloning (Seed-VC) failed (500): gpu OOM",
    ]) {
      const result = categorizeAiError(raw)
      expect(result.category).toBe("seed-vc-failed")
      expect(result.title).toBe("Voice conversion failed")
      expect(result.body).not.toMatch(/seed-vc/i)
    }
  })

  it("explains a convert timeout as a cold start, and says to retry", () => {
    const result = categorizeAiError(errorFromVoiceConvert(504, "voice conversion upstream did not respond within 240s").message)
    expect(result.title).toBe("The voice service was starting up")
    expect(result.body).toMatch(/try again/i)
  })

  it("keeps a missing Gemini key as Gemini, and offers Inworld as the alternative", () => {
    const result = categorizeAiError(
      "Add a Gemini API key in Project Settings before using Gemini voice generation.",
    )
    expect(result.category).toBe("missing-gemini-key")
    expect(result.title).toBe("Gemini API key required")
    expect(result.body).toMatch(/inworld/i)
  })

  it("names Gemini when TTS ran but returned no audio", () => {
    const result = categorizeAiError("Gemini TTS response did not include audio data.")
    expect(result.category).toBe("gemini-failed")
    expect(result.title).toBe("Gemini TTS failed")
  })
})

describe("categorizeAiError — OpenRouter key vs Gemini (AQU-1158)", () => {
  const OPENROUTER_NOT_CONFIGURED =
    'Completion failed: 500 {"error":"OPENROUTER_API_KEY is not configured"}'

  it("titles a hosted OpenRouter miss as OpenRouter, never Gemini", () => {
    const result = categorizeAiError(OPENROUTER_NOT_CONFIGURED)
    expect(result.category).toBe("missing-openrouter-key")
    expect(result.title).toBe("OpenRouter API key required")
    expect(result.body).toMatch(/openrouter/i)
    expect(result.body).toMatch(/custom/i)
    expect(result.body).not.toMatch(/gemini/i)
    expect(result.body).not.toMatch(/voice/i)
    expect(result.raw).toBe(OPENROUTER_NOT_CONFIGURED)
  })

  it("does not treat a generic api_key substring in a completion failure as Gemini", () => {
    const result = categorizeAiError(
      'Completion failed: 401 {"error":{"message":"invalid api key","code":401}}',
    )
    expect(result.category).not.toBe("missing-gemini-key")
    expect(result.title).not.toMatch(/gemini/i)
  })
})

describe("hosted transcription model failures", () => {
  // The copy must name what the user can do: retry, another model, or
  // on-device transcription. A generic "provider unavailable" left them stuck.
  it("points to the model picker instead of only saying try again", () => {
    const e = categorizeAiError("Hosted transcription model unavailable (502).")
    expect(e.category).toBe("transcription-model-unavailable")
    expect(e.body).toMatch(/Preferences/)
    expect(e.body).toMatch(/on this device/)
  })
})
