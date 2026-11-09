import { describe, expect, it } from "vitest"
import { assessHooks, PROBED_HOOK, type HooksProbe } from "./hooks-armed"

const DIR = "/repo"

function probe(overrides: Partial<HooksProbe> = {}): HooksProbe {
  return {
    hooksPath: ".husky/_",
    huskyHookPresent: true,
    resolvedHookPresent: true,
    resolvedHookPath: `/repo/.husky/_/${PROBED_HOOK}`,
    ...overrides,
  }
}

describe("assessHooks", () => {
  it("is armed when husky's dir, core.hooksPath and the resolved hook all line up", () => {
    const verdict = assessHooks(probe(), DIR)
    expect(verdict.armed).toBe(true)
    expect(verdict).toMatchObject({ hooksPath: ".husky/_" })
  })

  it("is not armed when core.hooksPath is unset — the --ignore-scripts install (AQU-2161)", () => {
    // husky never ran, so neither the generated dir nor the config exists.
    const verdict = assessHooks(
      probe({ hooksPath: "", huskyHookPresent: false, resolvedHookPresent: false, resolvedHookPath: "" }),
      DIR,
    )
    expect(verdict.armed).toBe(false)
    if (verdict.armed) return
    expect(verdict.lines[0]).toContain("NOT armed")
    expect(verdict.lines.join("\n")).toContain("core.hooksPath: UNSET")
    // No resolved-hook line when there is no path to resolve.
    expect(verdict.lines.join("\n")).not.toContain(`resolved ${PROBED_HOOK}:`)
    // The message has to name the fix, not just the symptom.
    expect(verdict.lines.join("\n")).toContain("pnpm run prepare")
  })

  it("is not armed when core.hooksPath is set but the hook it points at is gone", () => {
    // The bare `git worktree add` case (AQU-1623): config inherited, dir absent.
    const verdict = assessHooks(
      probe({ huskyHookPresent: false, resolvedHookPresent: false }),
      DIR,
    )
    expect(verdict.armed).toBe(false)
    if (verdict.armed) return
    expect(verdict.lines.join("\n")).toContain(`resolved ${PROBED_HOOK}:`)
    expect(verdict.lines.join("\n")).toContain("MISSING")
  })

  it("is not armed when husky generated its dir but core.hooksPath was never pointed at it", () => {
    const verdict = assessHooks(
      probe({ hooksPath: "", resolvedHookPresent: false, resolvedHookPath: "" }),
      DIR,
    )
    expect(verdict.armed).toBe(false)
  })

  it("names the checkout it judged, so the message is actionable in a worktree", () => {
    const verdict = assessHooks(probe({ hooksPath: "" }), "/repo/.worktrees/aqu-1")
    expect(verdict.armed).toBe(false)
    if (verdict.armed) return
    expect(verdict.lines[0]).toContain("/repo/.worktrees/aqu-1")
  })
})
