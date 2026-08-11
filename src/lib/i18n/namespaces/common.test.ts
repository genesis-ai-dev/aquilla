import { describe, expect, it } from "vitest"
import { common } from "./common"

/**
 * The list below is the record of a judgement call, so it is written out rather
 * than derived. It comes from a frequency scan of JSX text nodes and label props
 * across `src/**\/*.tsx`, excluding the English-only marketing pages
 * (`src/pages/{Homepage,CaseStudy,Beta}/`, `PrivacyPolicy.tsx`).
 *
 * Inclusion rule: the string appears in **3 or more files** AND is the same act
 * everywhere it appears. Deliberately excluded, with the reason:
 *   - `Source`, `Target` — same English, different meaning (import mode vs.
 *     editor column vs. source language). Two namespaces, two keys.
 *   - `Search`, `Settings`, `Projects` — already owned by `nav.*`; a `common.*`
 *     twin would be the same string keyed twice.
 *   - `Remove` (2 files), `Done` (2), `Copy` (0), `Apply` (1), `Refresh` (2),
 *     `Reset` (2), `Create` (1), `Skip` (1) — below the 3-file bar.
 *   - `Continue` (3 files, all onboarding) — one namespace, not shared.
 *   - `Import`, `Export`, `Replace`, `Restore`, `Reject` — verbs belonging to a
 *     specific domain, whose translation depends on that domain.
 *   - `Sign up free`, `Pricing`, `Talk to us`, `Book a call`, `Open app` —
 *     marketing-only, in files that never mount `I18nProvider`.
 */
const PREALLOCATED = [
  // Already shipped before the fan-out.
  "common.save",
  "common.cancel",
  "common.close",
  "common.delete",
  "common.dismiss",
  "common.retry",
  "common.loading",
  // Added from the scan: file counts in the comments.
  "common.edit", // 5 files
  "common.confirm", // 3 files
  "common.back", // 6 files
  "common.next", // 3 files
  "common.add", // 4 files
  "common.clear", // 6 files
  "common.discard", // 4 files
  "common.saved", // 8 files
  "common.none", // 3 files
  "common.name", // 4 files
  "common.email", // 4 files
]

describe("common namespace (AQU-511)", () => {
  it("preallocates the strings that repeat across surfaces", () => {
    // These are the strings the frequency scan found in 3+ places. They exist
    // here so no namespace agent re-keys them — a duplicate key is a string a
    // human translator is asked to translate twice, in four locales.
    for (const key of PREALLOCATED) {
      expect(Object.keys(common.keys)).toContain(key)
    }
  })

  it("gives every preallocated key a context entry or namespace cover", () => {
    expect(common.context._context.description.length).toBeGreaterThan(12)
  })
})
