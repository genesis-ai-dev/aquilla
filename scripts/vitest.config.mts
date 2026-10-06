import { defineConfig } from "vitest/config"

/**
 * Standalone Vitest project for the plain-Node scripts (AQU-1431).
 *
 * `scripts/*.mjs` are Node modules that package.json runs with `node`, never
 * through a bundler — `deploy:workers-build` → `node
 * scripts/cloudflare-stack-preview.mjs`, for instance. They must be tested
 * against the real Node built-ins.
 *
 * This lives in its own file rather than as an inline entry in the root
 * `vite.config.ts` `test.projects` array, which is what AQU-1273 tried. An
 * inline project shares the root config's RESOLVED `resolve.alias` — and
 * `vite-plugin-node-polyfills` installs its browser shims there, so `node:crypto`
 * arrived as `crypto-browserify` (40 exports, no `generateKeyPairSync`) no matter
 * what the inline entry declared. Setting `plugins: []` on the inline entry does
 * not help: the aliases are already in the shared resolved config by then. A
 * separate config file gets its own resolution and therefore the real built-ins.
 */
export default defineConfig({
  test: {
    name: "scripts-node",
    environment: "node",
    include: [
      "**/*.test.mjs",
      // Real Node, not the app project's browser polyfills. See the matching
      // exclude in the root vitest config.
      "lib/e2e-lock.test.ts",
      "lib/worktree-install-guard.test.ts",
      "lib/spawn-command.test.ts",
      "lib/playwright-loader-env.test.ts",
      "lib/listening-pids.test.ts",
    ],
    passWithNoTests: false,
  },
})
