// AQU-510 regression guard — runtime error text a translator reads must be
// localized.
//
// The i18n framework (AQU-511) localizes these surfaces' chrome, and two
// mappers already turn a raw throw into a localized sentence:
//
//   • `toUserFacingError` (AQU-281) — the network layer: HTTP statuses and
//     offline failures map to `error.network.*`.
//   • `categorizeAiError` (AQU-891) — AI features: TTS, denoise, drafting and
//     agent runs map to a localized title + actionable body.
//
// What AQU-510 fixed is surfaces that had neither: they rendered the raw throw,
// so a Burmese or Malay translator got an English sentence — or a provider's
// JSON payload — in the one place that was supposed to tell them what to do.
// The reported failure mode is exactly that: "something's on my screen and I
// don't know how to get rid of it."
//
// The rule this guard enforces is narrow and mechanical: in the files below,
// `x instanceof Error ? x.message : String(x)` may only appear as an ARGUMENT
// to one of the two mappers. Feeding it straight to a state setter, a toast or
// a tooltip is what regressed before, and it is what fails here.
//
// Extending the list as more surfaces are converted tightens the guard; that is
// the intended direction. Do not add a file to buy silence for a new raw leak.

import { describe, it, expect } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// Resolved from this file, not `process.cwd()` — the vitest project's cwd is
// not guaranteed to be the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

/** Surfaces converted by AQU-510. Append when a surface is converted. */
const GUARDED_FILES = [
  "src/components/CellTtsButton.tsx",
  "src/components/CellAudioUploadButton.tsx",
  "src/components/CellAttachmentButton.tsx",
  "src/components/audio/DenoiseButton.tsx",
  "src/components/SearchDockPanel.tsx",
  "src/components/FileSegmentationDialog.tsx",
]

/** The localizing mappers a raw message is allowed to flow into. */
const MAPPERS = ["toUserFacingError", "categorizeAiError"]

/**
 * Every `… instanceof Error ? ….message : String(…)` in `source`, with the
 * ~40 characters in front of it — enough to see which call it sits inside.
 */
const RAW_THROW = /[\w.]+\s+instanceof\s+Error\s*\?\s*[\w.]+\.message\s*:\s*String\([\w.]+\)/g

function unmappedRawThrows(source: string): string[] {
  const offenders: string[] = []
  for (const match of source.matchAll(RAW_THROW)) {
    const start = match.index ?? 0
    const prefix = source.slice(Math.max(0, start - 40), start)
    // The mapper call has to be the thing it is nested in, and nothing may have
    // closed in between — `categorizeAiError(x).body` leaves "categorizeAiError("
    // directly before the expression, while `setError(` does not.
    if (MAPPERS.some((fn) => prefix.includes(`${fn}(`))) continue
    const line = source.slice(0, start).split("\n").length
    offenders.push(`line ${line}: ${match[0]}`)
  }
  return offenders
}

describe("AQU-510: localized runtime error text", () => {
  it.each(GUARDED_FILES)("%s routes every raw throw through a localizing mapper", (file) => {
    const full = path.join(REPO_ROOT, file)
    // A rename that silently drops a file from the guard is itself a regression.
    expect(fs.existsSync(full), `${file} is listed in the guard but does not exist`).toBe(true)
    expect(unmappedRawThrows(fs.readFileSync(full, "utf8"))).toEqual([])
  })

  it("flags a raw throw handed straight to a state setter", () => {
    expect(
      unmappedRawThrows('setError(e instanceof Error ? e.message : String(e))'),
    ).toEqual(["line 1: e instanceof Error ? e.message : String(e)"])
  })

  it("accepts a raw throw passed into either mapper", () => {
    expect(
      unmappedRawThrows('setError(toUserFacingError(e instanceof Error ? e.message : String(e)).message)'),
    ).toEqual([])
    expect(
      unmappedRawThrows('setError(categorizeAiError(e instanceof Error ? e.message : String(e)).body)'),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AQU-510 / AC#3 — the AI classifier's BODY, not just its title.
//
// `categorizeAiError` localized `title` from AQU-891 but kept every `body` as
// an English literal, so the half of the block that tells the user what to DO
// stayed untranslated. These assert the bodies now resolve through the
// catalogue, and record precisely which parts of the classifier are still
// English on purpose so the exclusion cannot quietly widen.
// ---------------------------------------------------------------------------
describe("AQU-510: categorizeAiError bodies are localized", () => {
  const AI_ERROR = path.join(REPO_ROOT, "src/lib/audio/ai-error.ts")

  it("has no English body literal left in the classifier", () => {
    // Anything matching `body: "…"` is a string the catalogue never sees.
    expect(fs.readFileSync(AI_ERROR, "utf8")).not.toMatch(/body:\s*"/)
  })

  it("documents the two deliberate exclusions, so neither grows silently", () => {
    const source = fs.readFileSync(AI_ERROR, "utf8")

    // (1) `body: raw` — the raw text is a message WE wrote and threw elsewhere
    // in the app, already plain language. Localizing it means localizing each
    // throw site, which is not this ticket. Count it so a new one is noticed.
    const rawPassthroughs = source.match(/body:\s*raw\b/g) ?? []
    expect(rawPassthroughs).toHaveLength(7)

    // (2) The four engine-body constants are LOAD-BEARING MATCH KEYS:
    // tts-engine-error.ts throws them, and the classifier branches on English
    // substrings of them ("this line uses inworld", "this clone voice needs
    // seed-vc"). Running them through `t()` would break the matching that
    // selects their own branch, so they stay English until the throw sites and
    // the matcher are changed together.
    for (const konst of [
      "HOSTED_TTS_NOT_CONFIGURED_BODY",
      "HOSTED_TTS_FAILED_BODY",
      "SEED_VC_NOT_CONFIGURED_BODY",
      "SEED_VC_FAILED_BODY",
    ]) {
      expect(source).toContain(`body: ${konst}`)
    }
  })

  it("resolves a body from the active locale catalogue, English when it has none", async () => {
    const { CATALOGS } = await import("@/lib/i18n/messages")
    const { translate } = await import("@/lib/i18n/translate")
    const { LOCALE_STORAGE_KEY } = await import("@/lib/i18n/store")
    const { categorizeAiError } = await import("@/lib/audio/ai-error")

    // A 429 the platform budget owns — one of the converted branches.
    const RAW = 'voice/tts failed (429): {"error":"tts_daily_limit_exceeded"}'

    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en")
    expect(categorizeAiError(RAW).body).toBe(
      translate(CATALOGS.en, "audio.aiError.dailyLimitBody", undefined, "en"),
    )

    // The locale is read per call (standalone `t()` reads storage each time),
    // so the body follows the active locale rather than being frozen at import.
    //
    // Note what this does and does not prove. The thirteen keys are NEW, so no
    // catalogue carries a translation yet and `my` resolves them to English via
    // the AQU-511 fallback — which is AQU-510's AC#4, not a gap. Supplying the
    // Burmese and Malay copy is a locale-catalogue change authored by speakers
    // of those languages; `locales.ts` is explicit (AQU-1306) that a
    // machine-derived catalogue is worse than none. What is asserted here is the
    // plumbing: the body comes from the catalogue for the active locale, so the
    // moment a translation lands it appears with no code change. The end-to-end
    // non-English assertion lives in CellAudioUploadButton.test.tsx, on the
    // network path, whose keys ARE already translated.
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "my")
    const localized = categorizeAiError(RAW).body
    expect(localized).toBe(
      translate(CATALOGS.my, "audio.aiError.dailyLimitBody", undefined, "my"),
    )
    expect(localized).not.toContain("tts_daily_limit_exceeded")
    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
  })
})
