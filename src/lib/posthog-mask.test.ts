import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// OPS-3 of docs/OPSEC-REVIEW-2026-08-10.md asked for the editor's text surface
// to be masked in session replay. `posthog.ts` already passed a
// `maskTextSelector`, which made it look done — but the attribute it names
// appeared nowhere in the tree, so the selector matched zero nodes and every
// replay carried draft translation text verbatim to a third-party processor.
//
// A masking config is only a control if something matches it. This test reads
// the selector out of the real config and asserts the tree still satisfies it,
// so deleting the last masked surface fails here instead of silently
// downgrading what replays capture.

const CONFIG = "src/lib/posthog.ts"

function maskSelector(): string {
  const source = readFileSync(CONFIG, "utf8")
  const match = source.match(/maskTextSelector:\s*"([^"]+)"/)
  if (!match) throw new Error(`no maskTextSelector found in ${CONFIG}`)
  return match[1]
}

/** `[data-ph-mask]` → `data-ph-mask`. Only attribute selectors are supported. */
function attributeFromSelector(selector: string): string {
  const match = selector.match(/^\[([a-z-]+)\]$/)
  if (!match) {
    throw new Error(
      `maskTextSelector ${selector} is not a bare attribute selector; ` +
        "update this test to match how it is now written.",
    )
  }
  return match[1]
}

function filesUsing(attribute: string): string[] {
  try {
    return execFileSync("git", ["grep", "-l", "--", attribute, "src"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => f !== CONFIG && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  } catch {
    return [] // git grep exits 1 on no matches
  }
}

describe("session-replay masking", () => {
  it("names an attribute that the tree actually uses", () => {
    const attribute = attributeFromSelector(maskSelector())
    expect(
      filesUsing(attribute),
      `${maskSelector()} matches nothing outside ${CONFIG}, so session replay ` +
        "captures every text surface. Mask the content surfaces or remove the " +
        "config — a selector that matches nothing reads as a control and is not one.",
    ).not.toHaveLength(0)
  })

  it("masks the editor's source and target text surfaces", () => {
    // These two are the reason the control exists: unpublished draft text, and
    // in a restricted-access context the visible identity of who is editing it.
    const editor = readFileSync("src/components/EditorTable.tsx", "utf8")
    for (const surface of ['data-showcase="editor.source"', 'data-showcase="editor.target"']) {
      const at = editor.indexOf(surface)
      expect(at, `${surface} not found — did the editor columns get renamed?`).toBeGreaterThan(-1)
      // The attribute is written on the same element, within a few lines.
      expect(
        editor.slice(at, at + 600),
        `${surface} is no longer masked for session replay`,
      ).toContain("data-ph-mask")
    }
  })

  it("keeps replay opt-out the default", () => {
    // Masking is the second line of defence; consent is the first.
    const source = readFileSync(CONFIG, "utf8")
    expect(source).toContain("opt_out_capturing_by_default")
    expect(source).toContain("disable_session_recording")
  })
})
