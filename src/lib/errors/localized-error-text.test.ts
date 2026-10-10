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
