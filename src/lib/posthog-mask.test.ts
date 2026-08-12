import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
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

/**
 * Walk `src` for source files carrying the attribute.
 *
 * Deliberately does NOT shell out to `git grep`: that would report "no files
 * use the mask" whenever git is missing or the checkout is not a repository,
 * turning a broken tool into a false claim that the control is gone. Reporting
 * a control as absent because the check could not run is the same defect this
 * test exists to catch.
 */
function filesUsing(attribute: string, dir = "src"): string[] {
  const found: string[] = []
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) {
      found.push(...filesUsing(attribute, path))
      continue
    }
    if (!/\.(?:ts|tsx)$/.test(item.name)) continue
    if (path === CONFIG || /\.test\.tsx?$/.test(item.name)) continue
    if (readFileSync(path, "utf8").includes(attribute)) found.push(path)
  }
  return found
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
