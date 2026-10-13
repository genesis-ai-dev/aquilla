import { describe, expect, it } from "vitest"
import { getConfig } from "@testing-library/react"
import { STALL_WATCHDOG_MS } from "./timeouts"

/**
 * Guard for the root suite's stall-watchdog policy (AQU-1749, AGENTS.md rule
 * 15). It fails if `src/test-setup.ts` stops giving Testing Library the shared
 * watchdog, or if the "app" project's per-test ceiling in `vite.config.ts`
 * falls back toward Vitest's 5 s default, where it would cut a slow test off
 * before its own waits could fail with a useful message.
 */
describe("root suite stall watchdogs", () => {
  it("gives every findBy* / waitFor the shared watchdog", () => {
    expect(getConfig().asyncUtilTimeout).toBe(STALL_WATCHDOG_MS)
  })

  it("keeps the per-test ceiling well above a single wait", ({ task }) => {
    // 60 s: room for several slow waits before the test itself times out.
    expect(task.timeout).toBeGreaterThanOrEqual(6 * STALL_WATCHDOG_MS)
  })
})
