// OPS-3 — session replay must not carry unpublished translation content.
//
// PostHog masks inputs, but the surfaces that hold draft translations are a
// contenteditable (TipTap) and rendered page text, neither of which
// `maskAllInputs` reaches. They opt in via `data-ph-mask`, which is the
// configured `maskTextSelector`.
//
// This is a source-level parity guard, deliberately, and for the same reason
// `worker/security-headers.test.ts` parses `public/_headers`: a DOM test of one
// component would pass while the selector it depends on was renamed in
// posthog.ts, and the two would drift apart silently. Asserting on the presence
// of the attribute (not on formatting) keeps it robust to reflows.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8")

const MASK_ATTRIBUTE = "data-ph-mask"

/**
 * Every surface that renders source or target cell text — plus comment
 * bodies, which quote draft text and name collaborators (the same exposure
 * from a different door).
 */
const MASKED_SURFACES = [
  "src/components/TranslatedEditor.tsx",
  "src/components/EditorTable.tsx",
  "src/components/CommentThread.tsx",
  "src/components/CommentsPage.tsx",
]

describe("OPS-3 session-replay masking", () => {
  it("configures maskTextSelector to the attribute the surfaces actually use", () => {
    const config = read("src/lib/posthog.ts")
    expect(config).toContain(`maskTextSelector: "[${MASK_ATTRIBUTE}]"`)
    // Inputs stay masked regardless — this guard is about the non-input text.
    expect(config).toContain("maskAllInputs: true")
  })

  it("keeps replay opt-in, so masking is defence in depth rather than the only control", () => {
    const config = read("src/lib/posthog.ts")
    expect(config).toContain("opt_out_capturing_by_default")
    expect(config).toContain("disable_session_recording")
  })

  for (const surface of MASKED_SURFACES) {
    it(`marks the cell-text surface in ${surface}`, () => {
      expect(read(surface)).toContain(MASK_ATTRIBUTE)
    })
  }
})
