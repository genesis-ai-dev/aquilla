import { defineConfig } from "vitest/config"

/**
 * Standalone Vitest project that runs the QA runner's Python suite (AQU-2365).
 *
 * The runner itself is Python (the issue's design decision: an operator runs it
 * with a bare `python3`, no install step). Its tests are stdlib `unittest` for
 * the same reason. But a test suite the repo's own gate never runs is a suite
 * that rots, so this project shells out to it and `pnpm test` covers it like
 * everything else.
 *
 * It lives in its own config file rather than as an inline project in the root
 * `vite.config.ts`, for the same reason `scripts/vitest.config.mts` does: an
 * inline project shares the root config's RESOLVED `resolve.alias`, where
 * `vite-plugin-node-polyfills` has installed browser shims — so `node:child_process`
 * would not be the real one (AQU-1431). A separate config file gets its own
 * resolution and therefore the real built-ins.
 */
export default defineConfig({
  test: {
    name: "qa-biblica-python",
    environment: "node",
    include: ["python-suite.test.mts"],
    passWithNoTests: false,
    testTimeout: 120_000,
  },
})
