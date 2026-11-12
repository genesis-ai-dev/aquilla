import path from "node:path"
import { ESLint } from "eslint"
import { describe, expect, it } from "vitest"

describe("lint artifact perimeter (AQU-1814)", () => {
  it("ignores transient builds while retaining source and smoke helpers", async () => {
    const lint = new ESLint({ cwd: path.resolve(import.meta.dirname, "..") })
    for (const artifact of [
      "sync-worker/.wrangler/tmp/bundle-any/middleware-insertion-facade.js",
      "dist-e2e-s0/assets/index.js",
      ".worktrees/aqu-example/src/main.tsx",
    ]) {
      expect(await lint.isPathIgnored(artifact), artifact).toBe(true)
    }
    for (const source of [
      "sync-worker/src/events/content-disposition.ts",
      "e2e/helpers/page-objects/Workspace.ts",
    ]) {
      expect(await lint.isPathIgnored(source), source).toBe(false)
    }
  })
})
