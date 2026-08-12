import { existsSync } from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import {
  CATALOG_CONTEXT,
  LEGACY_CONTEXT_GAPS,
  MESSAGE_KEYS,
  catalogContextIssues,
  contextRequirementFor,
  englishFormsFor,
  looksLikeAccessibilityName,
  namespaceOf,
  placeholdersIn,
  requiresOwnContextEntry,
  resolveKeyContext,
  type ContextEntry,
} from "./context"
import { SCREENSHOTS, isScreenshotId, screenshotPath } from "./screenshots"
import { loadScreenshotManifest, screenshotStaleness } from "./screenshot-manifest"
// `../../../scripts/i18n-shots` would resolve to the capture CLI, which runs on
// import; the driver registry is the `index` module inside the directory.
import { SURFACE_DRIVER_IDS } from "../../../scripts/i18n-shots/index"

/**
 * AQU-832 — the context sidecar's coverage check.
 *
 * `catalogContextIssues()` is the lint that makes the standard enforceable, and
 * this suite is where CI runs it: adding a message key without the context its
 * class requires fails `pnpm test`, which is the whole new-key workflow (see
 * `docs/I18N-CONTEXT-CATALOG.md`). Keep the "no issues" assertion first and
 * unconditional — the narrower cases below exist to explain a failure, not to
 * replace it. It stays a hard, unconditional `[]`: `LEGACY_CONTEXT_GAPS`
 * (see `context.ts`) is a production-level, self-verifying carve-out for the
 * one pre-existing key this change can't fix without editing a namespace
 * module it doesn't own — not a test-only exception — so it doesn't need
 * special-casing here.
 */
describe("catalog context coverage (AQU-832)", () => {
  it("reports no coverage or consistency issues for the en catalog", () => {
    expect(catalogContextIssues()).toEqual([])
  })

  it("resolves a non-empty surface and description for every message key", () => {
    const uncovered = MESSAGE_KEYS.filter((key) => {
      const ctx = resolveKeyContext(key)
      return ctx.surface.trim() === "" || ctx.description.trim() === ""
    })
    expect(uncovered).toEqual([])
  })

  it("documents every placeholder the English strings use", () => {
    for (const key of MESSAGE_KEYS) {
      const ctx = resolveKeyContext(key)
      for (const name of englishFormsFor(key).flatMap((form: string) =>
        placeholdersIn(form),
      )) {
        expect(
          ctx.placeholders[name],
          `${key} uses {${name}} but does not document it`,
        ).toBeTruthy()
      }
    }
  })

  it("references only declared screenshot surfaces", () => {
    for (const key of MESSAGE_KEYS) {
      const shot = resolveKeyContext(key).screenshot
      if (shot) expect(isScreenshotId(shot), `${key} → ${shot}`).toBe(true)
    }
  })

  it("covers each major surface — nav, editor, dialogs, settings, errors", () => {
    const linked = new Set(
      MESSAGE_KEYS.map((key) => resolveKeyContext(key).screenshot).filter(Boolean),
    )
    for (const surface of SCREENSHOTS) {
      expect(linked.has(surface.id), `no key links screenshot "${surface.id}"`).toBe(true)
    }
  })
})

describe("context resolution", () => {
  it("layers the per-key entry over the namespace context", () => {
    const ctx = resolveKeyContext("nav.projects")
    expect(ctx.namespace).toBe("nav")
    // Surface note comes from the namespace, the description from the key entry.
    expect(ctx.surface).toBe(CATALOG_CONTEXT.nav._context.description)
    expect(ctx.description).toBe(CATALOG_CONTEXT.nav.keys?.["nav.projects"]?.description)
    // Screenshot and length constraint are inherited.
    expect(ctx.screenshot).toBe("workspace-nav")
    expect(ctx.maxLength).toBe(CATALOG_CONTEXT.nav._context.maxLength)
  })

  it("lets a per-key entry override the namespace screenshot", () => {
    // "Loading…" is shared chrome but is shown in the editor, not a dialog.
    expect(resolveKeyContext("common.loading").screenshot).toBe("cell-editor")
    expect(resolveKeyContext("common.save").screenshot).toBe("confirm-dialog")
  })

  it("falls back to the namespace description when a key has no entry of its own", () => {
    const nsOnly = MESSAGE_KEYS.filter((key) => {
      const block = CATALOG_CONTEXT[namespaceOf(key)]
      return block?.keys?.[key] === undefined
    })
    for (const key of nsOnly) {
      const ctx = resolveKeyContext(key)
      expect(ctx.description).toBe(ctx.surface)
    }
  })

  it("merges placeholder documentation, per-key winning", () => {
    const ctx = resolveKeyContext("language.switchTo")
    expect(Object.keys(ctx.placeholders)).toEqual(["language"])
    expect(ctx.placeholders.language).toMatch(/endonym/i)
  })

  it("does not throw for a key whose namespace has no block", () => {
    // `resolveKeyContext` is used while linting, so it must survive the very
    // state the lint exists to report.
    const ctx = resolveKeyContext("nav.projects")
    expect(() => resolveKeyContext(ctx.key)).not.toThrow()
  })
})

describe("helpers", () => {
  it("namespaceOf takes the segment before the first dot", () => {
    expect(namespaceOf("error.generic.title")).toBe("error")
    expect(namespaceOf("standalone")).toBe("standalone")
  })

  it("placeholdersIn finds each placeholder once", () => {
    expect(placeholdersIn("Switch language to {language}")).toEqual(["language"])
    expect(placeholdersIn("{a} then {b} then {a}")).toEqual(["a", "b"])
    expect(placeholdersIn("no placeholders")).toEqual([])
  })

  it("screenshotPath is stable and derived from the id", () => {
    expect(screenshotPath("workspace-nav")).toBe("src/lib/i18n/screenshots/workspace-nav.png")
  })

  it("every declared surface has its PNG captured and committed", () => {
    // The PNGs are committed artifacts regenerated by `pnpm i18n:shots`
    // (scripts/i18n-shots.ts) against the live dev stack, so existence is
    // environment-independent: a registry entry without its capture — or a
    // deleted capture still referenced by metadata — fails here.
    const repoRoot = path.resolve(__dirname, "..", "..", "..")
    const missing = SCREENSHOTS.filter(
      (s) => !existsSync(path.join(repoRoot, screenshotPath(s.id))),
    ).map((s) => s.id)
    expect(missing).toEqual([])
  })
})

describe("screenshot drivers (AQU-511 fan-out)", () => {
  it("has a capture driver for every declared surface", () => {
    const missing = SCREENSHOTS.map((s) => s.id).filter((id) => !SURFACE_DRIVER_IDS.includes(id))
    // A surface without a driver is never captured, so its context would point
    // translators at a screenshot that does not exist.
    expect(missing).toEqual([])
  })

  it("has no driver for a surface nobody declares", () => {
    const declared = SCREENSHOTS.map((s) => s.id)
    expect(SURFACE_DRIVER_IDS.filter((id) => !declared.includes(id))).toEqual([])
  })
})

/**
 * AQU-832 relaxation — the class test that replaced "every key needs its own
 * entry". Each `it` here picks a REAL key already in the catalog rather than a
 * fabricated fixture, so the assertion is about the actual corpus, not a
 * story about it.
 */
describe("context requirement classes (AQU-832 relaxation)", () => {
  it("classifies a key with a {placeholder} as needing its own entry", () => {
    // "Back to {target}" — the namespace note can't say what {target} is.
    expect(contextRequirementFor("nav.historyControls.backTo").placeholder).toBe(true)
    expect(requiresOwnContextEntry("nav.historyControls.backTo")).toBe(true)
  })

  it("classifies a count-governed key as needing its own entry", () => {
    expect(contextRequirementFor("nav.account.unsavedEditsDescription").plural).toBe(true)
    expect(requiresOwnContextEntry("nav.account.unsavedEditsDescription")).toBe(true)
  })

  it("classifies a key under a maxLength ceiling as needing its own entry", () => {
    // "nav.projects" carries no placeholder, isn't plural, and isn't named
    // like an accessibility string — it only needs an entry because it
    // inherits `nav`'s namespace-wide maxLength: 24.
    const req = contextRequirementFor("nav.projects")
    expect(req).toMatchObject({ placeholder: false, plural: false, accessibilityName: false })
    expect(req.maxLength).toBe(true)
    expect(requiresOwnContextEntry("nav.projects")).toBe(true)
  })

  it("classifies a key named as an accessibility name as needing its own entry", () => {
    expect(looksLikeAccessibilityName("nav.version.copyAriaLabel")).toBe(true)
    expect(contextRequirementFor("nav.version.copyAriaLabel").accessibilityName).toBe(true)
    expect(requiresOwnContextEntry("nav.version.copyAriaLabel")).toBe(true)
  })

  it("does not flag a naming pattern that merely contains 'aria' as a word fragment", () => {
    // Sanity check against over-matching: this is a token match on key
    // segments, not a substring scan that would misfire on a word that
    // merely contains "aria" — "librarian" has no camelCase boundary of its
    // own, so it never splits into a bare "aria" token.
    expect(looksLikeAccessibilityName("nav.librarianTitle")).toBe(false)
    expect(looksLikeAccessibilityName("nav.invariantState")).toBe(false)
  })

  it("does NOT require its own entry for a plain label with only namespace context — the relaxation this test suite exists to prove", () => {
    // "autopilot.status.working" → "Working": no placeholder, not plural, the
    // `autopilot` namespace sets no maxLength, and the name isn't an
    // accessibility one. Under the OLD convention this would still have
    // gotten a hand-authored entry (1,143 of 1,337 keys did); under the class
    // test it correctly has none, and that's a pass, not a gap.
    const key = "autopilot.status.working"
    expect(CATALOG_CONTEXT.autopilot.keys?.[key]).toBeUndefined()
    expect(requiresOwnContextEntry(key)).toBe(false)
    expect(catalogContextIssues().some((issue) => issue.startsWith(`${key}:`))).toBe(false)
  })
})

/**
 * The class test must still fail for the cases it exists to catch — the
 * relaxation is only real if enforcement is. Where the current corpus already
 * satisfies a class (nearly all of it does — see the `contextRequirementFor`
 * doc comment for the corpus-wide count), these tests temporarily delete a
 * real entry and restore it, so the failure is driven by the same production
 * lint over the same production data, not a hand-built fixture.
 */
describe("class test enforcement — still fails when a key genuinely needs prose (AQU-832)", () => {
  function withDeletedEntry(namespace: keyof typeof CATALOG_CONTEXT, key: string, run: () => void) {
    const keys = CATALOG_CONTEXT[namespace].keys as Record<string, ContextEntry> | undefined
    const original = keys?.[key]
    if (!keys || original === undefined) {
      throw new Error(`test setup: ${key} has no existing entry to remove`)
    }
    delete keys[key]
    try {
      run()
    } finally {
      keys[key] = original
    }
  }

  it("fails a placeholder key whose entry is missing", () => {
    withDeletedEntry("nav", "nav.historyControls.backTo", () => {
      const issues = catalogContextIssues()
      expect(
        issues.some(
          (i) => i.startsWith("nav.historyControls.backTo:") && i.includes("{placeholder}"),
        ),
      ).toBe(true)
    })
  })

  it("fails a maxLength-governed key whose entry is missing", () => {
    withDeletedEntry("nav", "nav.projects", () => {
      const issues = catalogContextIssues()
      expect(
        issues.some((i) => i.startsWith("nav.projects:") && i.includes("maxLength ceiling")),
      ).toBe(true)
    })
  })

  it("does not require its own entry for a key outside every class, even with its entry removed", () => {
    // Negative control: deleting an entry that was never required in the
    // first place must not start failing. `nav.settings` → "Settings" has no
    // placeholder, isn't plural, and (unlike nav.projects) — wait, nav's
    // namespace maxLength covers every nav key, so this control instead uses
    // a namespace with no maxLength: `autopilot.status.working`, which
    // already has no entry (see the test above) and stays passing.
    expect(requiresOwnContextEntry("autopilot.status.working")).toBe(false)
  })

  it("every carried-over exemption is a real gap, not a classifier false positive", () => {
    // The carve-out must never hide a phantom: a listed key has to be one the
    // class test genuinely fails on today (needs its own entry, has none).
    // Vacuous while the list is empty — the point is that adding an
    // unjustified exemption starts failing here rather than passing silently.
    for (const key of LEGACY_CONTEXT_GAPS) {
      expect(CATALOG_CONTEXT[namespaceOf(key)]?.keys?.[key]).toBeUndefined()
      expect(requiresOwnContextEntry(key)).toBe(true)
    }
  })

  it("the last carried-over gap is fixed: the Autopilot log aria-label has its own entry", () => {
    // `autopilot.inspector.activity.logAria` is wired to `aria-label` in
    // AutopilotActivityInspector.tsx. It shipped exempt because WS-04 could
    // not edit namespace modules; autopilot.ts now carries the entry, so the
    // exemption is gone and the class test covers it like any other key.
    const key = "autopilot.inspector.activity.logAria"
    expect(LEGACY_CONTEXT_GAPS).not.toContain(key)
    expect(requiresOwnContextEntry(key)).toBe(true)
    expect(CATALOG_CONTEXT.autopilot.keys?.[key]?.description).toBeTruthy()
  })

  it("reports when a legacy-listed key no longer needs its exemption", () => {
    // Proves the carve-out is self-correcting rather than a one-way door:
    // exempting a key that already has its own entry makes this same lint
    // complain that the now-stale LEGACY_CONTEXT_GAPS listing should go.
    const key = "autopilot.inspector.activity.logAria"
    const issues = catalogContextIssues([key])
    expect(issues.some((i) => i.includes(key) && i.includes("no longer needs the exemption"))).toBe(
      true,
    )
  })
})

/**
 * AQU-832 relaxation — a declared screenshot surface having a committed PNG
 * (`existsSync`, above) is necessary but not sufficient. See
 * `screenshot-manifest.ts` for why and `docs/I18N-CONTEXT-CATALOG.md` "why
 * this changed" for the `project-settings` case this exists to catch.
 */
describe("screenshot staleness (AQU-832 relaxation)", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..")
  const manifest = loadScreenshotManifest(repoRoot)

  it("detects a PNG whose bytes don't match its manifest entry", () => {
    const surface = SCREENSHOTS.find((s) => s.id === "workspace-nav")!
    const wrongManifest = {
      [surface.id]: { hash: "0".repeat(64), route: surface.route, capturedAt: "test" },
    }
    expect(screenshotStaleness(repoRoot, surface, wrongManifest)).toBe("hash-mismatch")
  })

  it("detects a surface whose declared route no longer matches its manifest entry", () => {
    const surface = SCREENSHOTS.find((s) => s.id === "workspace-nav")!
    const entry = manifest[surface.id]
    expect(entry).toBeDefined()
    const staleRouteManifest = { [surface.id]: { ...entry, route: "/some/other/route" } }
    expect(screenshotStaleness(repoRoot, surface, staleRouteManifest)).toBe("route-mismatch")
  })

  it("detects a surface with no manifest entry at all", () => {
    const surface = SCREENSHOTS.find((s) => s.id === "workspace-nav")!
    expect(screenshotStaleness(repoRoot, surface, {})).toBe("missing-manifest-entry")
  })

  it("flags project-settings as stale — its driver stops at /settings, an 8-card index, not the deep settings form its notes describe", () => {
    const surface = SCREENSHOTS.find((s) => s.id === "project-settings")!
    expect(screenshotStaleness(repoRoot, surface, manifest)).toBe("missing-manifest-entry")
  })

  it("every OTHER declared surface's committed PNG matches its manifest entry", () => {
    const stale = SCREENSHOTS.filter((s) => s.id !== "project-settings")
      .map((s) => [s.id, screenshotStaleness(repoRoot, s, manifest)] as const)
      .filter(([, reason]) => reason !== undefined)
    expect(stale).toEqual([])
  })
})
